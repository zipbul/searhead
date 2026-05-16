import { ulid } from 'ulid';

import { enqueueRetry } from '../collect/retry';
import { getDb } from '../db/connection';
import { entry, entryDomain, entryTag, entrySource, ingestLog } from '../db/schema';
import { decodeUlidTimestamp } from '../lib/ulid-utils';
import { logger } from '../observability/logger';
import { ingestionTotal, ingestionLatency } from '../observability/metrics';
import { calculateAuthority, getSourceTrust } from '../score/authority';
import { IngestAction } from '../score/enums';
import { decompose, detectLanguage } from './decompose';
import { isDuplicate } from './dedup';
import { buildEmbeddingInput, generateEmbedding } from './embed';
import { type StoreInput, type Source, type StructuredEntry, isRawInput, stripHtml } from './validate';

/**
 * Result of one ingest attempt. `entryId` is null for rejected rows
 * (previous code used an empty string `""` which then blew up
 * downstream: `decodeUlidTimestamp("")` throws, feedback handler
 * 500s, metrics labels get polluted). Callers iterating results must
 * check `action` before using `entryId`.
 */
interface IngestResult {
  entryId: string | null;
  authority: number;
  decayRate: number;
  action: IngestAction;
  reason?: string;
}

/**
 * Main ingestion engine. Accepts both raw (Mode 1) and structured (Mode 2) inputs.
 *
 * `fromRetry` should be true when the call originates from
 * `processRetryQueue` so a second decompose failure doesn't enqueue
 * a fresh retry entry — the retry loop already manages its own
 * attempt counter and backoff. Without this guard, every failed
 * retry creates a new queue entry, and the loop spins forever
 * (the original entry gets removed for "succeeding" since ingest
 * doesn't throw; the new entry takes its place; repeat).
 */
async function ingest(input: StoreInput, opts: { fromRetry?: boolean } = {}): Promise<IngestResult[]> {
  const timer = ingestionLatency.startTimer();
  try {
    return await ingestInner(input, opts);
  } finally {
    // Guarantee the histogram records every code path (including early
    // rejects and thrown errors) so ingestion latency is never silently
    // missing for failure modes.
    timer();
  }
}

async function ingestInner(input: StoreInput, opts: { fromRetry?: boolean }): Promise<IngestResult[]> {
  const sources: Source[] = input.sources ?? [];
  const results: IngestResult[] = [];

  let decomposedEntries: StructuredEntry[];

  if (isRawInput(input)) {
    // Mode 1: raw → LLM decompose
    logger.info('ingesting raw input, calling LLM decompose');
    try {
      const response = await decompose(stripHtml(input.raw));
      decomposedEntries = response.entries;
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ error: errorMsg, fromRetry: !!opts.fromRetry }, 'decompose failed');

      // Single ingest_log row per terminal decompose failure, regardless
      // of how many times retry re-enters. The retry loop itself tracks
      // attempts in retry_queue; doubling the audit trail here just
      // inflates ingest_log with identical reason strings (saw the same
      // decompose_failed row 2375× in production logs).
      if (!opts.fromRetry) {
        await getDb()
          .insert(ingestLog)
          .values({
            id: ulid(),
            action: IngestAction.Rejected,
            reason: `decompose_failed: ${errorMsg}`,
          });
      }

      // Re-throw when called from retry loop so the caller bumps
      // attempts on the existing queue entry rather than spawning a
      // new one. Fresh ingest paths still enqueue once for later retry.
      if (opts.fromRetry) {
        throw err;
      }
      await enqueueRetry(input.raw, sources[0]?.url, `decompose_parse_error: ${errorMsg}`);

      ingestionTotal.inc({ action: IngestAction.Rejected });
      // Keep the rejected record visible to callers (research.ts
      // counts it, CLI prints it) — but with `entryId: null` so no
      // downstream code can mistake it for a real partition-routable
      // ULID.
      return [
        {
          entryId: null,
          authority: 0,
          decayRate: 0,
          action: IngestAction.Rejected,
          reason: errorMsg,
        },
      ];
    }

    // Handle empty entries (LLM returned nothing useful)
    if (decomposedEntries.length === 0) {
      await getDb().insert(ingestLog).values({
        id: ulid(),
        action: IngestAction.Rejected,
        reason: 'no_entries_extracted',
      });
      ingestionTotal.inc({ action: IngestAction.Rejected });
      return [
        {
          entryId: null,
          authority: 0,
          decayRate: 0,
          action: IngestAction.Rejected,
          reason: 'no_entries_extracted',
        },
      ];
    }
  } else {
    // Mode 2: structured → skip decompose
    logger.info({ count: input.entries.length }, 'ingesting structured input');
    decomposedEntries = input.entries;
  }

  // Process each entry through the pipeline
  for (const decomposed of decomposedEntries) {
    try {
      const result = await processEntry(decomposed, sources);
      results.push(result);
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ error: errorMsg, title: decomposed.title }, 'entry processing failed');
      try {
        await getDb()
          .insert(ingestLog)
          .values({
            id: ulid(),
            action: IngestAction.Rejected,
            reason: `process_entry_failed: ${errorMsg.slice(0, 500)}`,
          });
      } catch (logErr) {
        logger.warn({ error: (logErr as Error).message }, 'failed to record ingest_log');
      }
      // Push a rejected result with entryId=null so the caller's count
      // stays accurate but no downstream code treats the null id as a
      // valid entry.
      results.push({
        entryId: null,
        authority: 0,
        decayRate: 0,
        action: IngestAction.Rejected,
        reason: errorMsg,
      });
      ingestionTotal.inc({ action: IngestAction.Rejected });
    }
  }

  // Record metrics for the per-entry successes
  for (const r of results) {
    ingestionTotal.inc({ action: r.action });
  }

  return results;
}

async function processEntry(decomposed: StructuredEntry, sources: Source[]): Promise<IngestResult> {
  const id = ulid();
  const createdAt = new Date(decodeUlidTimestamp(id));
  const title = stripHtml(decomposed.title);
  const content = stripHtml(decomposed.content);
  const domains = decomposed.domain;
  const tags = decomposed.tags ?? [];
  const language = decomposed.language ?? (await detectLanguage(content));
  const decayRate = decomposed.decayRate ?? 0.01;
  const mergedMetadata = normalizeMetadata(decomposed.metadata);

  // Step 3: Generate embedding
  const embeddingText = buildEmbeddingInput(title, content);
  const embedding = await generateEmbedding(embeddingText);

  // Step 4: Semantic dedup
  const duplicate = await isDuplicate(embedding);
  if (duplicate) {
    await getDb().insert(ingestLog).values({
      id: ulid(),
      entryId: id,
      entryCreatedAt: createdAt,
      action: IngestAction.Duplicate,
      reason: 'semantic similarity > 0.95',
    });
    return { entryId: id, authority: 0, decayRate, action: IngestAction.Duplicate };
  }

  // Step 5: Authority score (rule-based)
  const authority = calculateAuthority(sources);

  // Step 6: DB transaction
  await getDb().transaction(async tx => {
    await tx.insert(entry).values({
      id,
      title,
      content,
      language,
      metadata: mergedMetadata,
      authority,
      decayRate,
      status: 'active',
      createdAt,
      embedding,
    });

    if (domains.length > 0) {
      await tx.insert(entryDomain).values(
        domains.map(d => ({
          entryId: id,
          entryCreatedAt: createdAt,
          domain: d,
        })),
      );
    }

    if (tags.length > 0) {
      await tx.insert(entryTag).values(
        tags.map(t => ({
          entryId: id,
          entryCreatedAt: createdAt,
          tag: t,
        })),
      );
    }

    if (sources.length > 0) {
      await tx.insert(entrySource).values(
        sources.map(s => ({
          entryId: id,
          entryCreatedAt: createdAt,
          url: s.url,
          sourceType: s.sourceType,
          trust: getSourceTrust(s.sourceType),
        })),
      );
    }

    await tx.insert(ingestLog).values({
      id: ulid(),
      entryId: id,
      entryCreatedAt: createdAt,
      action: IngestAction.Stored,
    });
  });

  logger.info({ entryId: id, authority, decayRate, domains }, 'entry stored');

  // v0.3 claim extraction runs in a separate background task (see
  // processClaimExtractionQueue) so ingest latency doesn't pay for a
  // second LLM pass and concurrent ingests don't saturate the CLI.

  return { entryId: id, authority, decayRate, action: IngestAction.Stored };
}

function normalizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export { ingest };
export type { IngestResult };
