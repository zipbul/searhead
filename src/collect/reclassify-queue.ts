import { sql, eq, and, inArray } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { entry, entryDomain, entryTag } from '../db/schema';
import { logger } from '../observability/logger';
import { classifyBatch } from './classify-batch';

/**
 * Reclassify entries that were stored with default/fallback metadata.
 *
 * Detection heuristic: entries with 0 tags AND domain slug matching
 * a generic pattern (single-word slugs like "web", "topic", etc.)
 * are considered "unclassified" and eligible for reclassification.
 *
 * Runs as a background worker — same pattern as claim extraction.
 */
export async function processReclassifyQueue(batchSize = 3): Promise<number> {
  // Find entries with 0 tags (strong signal of default metadata)
  const rows = await getDb().execute(sql`
    SELECT e.id, e.title, e.content, e.created_at
    FROM entry e
    WHERE e.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM entry_tag et
        WHERE et.entry_id = e.id AND et.entry_created_at = e.created_at
      )
    ORDER BY e.created_at DESC
    LIMIT ${batchSize}
  `);

  const batch = rows as unknown as Array<{
    id: string;
    title: string;
    content: string;
    created_at: Date | string;
  }>;

  if (batch.length === 0) {
    return 0;
  }

  // Derive topic from the existing domains on each entry. Without
  // this, the previous hardcoded `topic = "general"` starved the
  // classifier of any contextual signal and it fell back to
  // undifferentiated default tags, entrenching the very "0 tags"
  // state this worker was supposed to fix.
  const ids = batch.map(r => r.id);
  const domains =
    ids.length > 0
      ? await getDb()
          .select({ entryId: entryDomain.entryId, domain: entryDomain.domain })
          .from(entryDomain)
          .where(inArray(entryDomain.entryId, ids))
      : [];
  const domainsByEntry = new Map<string, string[]>();
  for (const d of domains) {
    const arr = domainsByEntry.get(d.entryId) ?? [];
    arr.push(d.domain);
    domainsByEntry.set(d.entryId, arr);
  }
  const topicForEntry = (entryId: string): string => {
    const ds = domainsByEntry.get(entryId);
    if (!ds || ds.length === 0) {
      return 'general';
    }
    return ds.slice(0, 3).join(', ');
  };

  // classifyBatch takes a single `topic` per call; batch per-entry
  // classification with individual context would require a per-entry
  // loop. We pass the most common domain across the batch as topic
  // context — already a large improvement over "general" while
  // preserving batch throughput.
  const allDomains = [...domainsByEntry.values()].flat();
  const topicCounts = new Map<string, number>();
  for (const d of allDomains) {
    topicCounts.set(d, (topicCounts.get(d) ?? 0) + 1);
  }
  const dominant = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
    .slice(0, 3)
    .join(', ');
  const topic = dominant || batch.map(r => topicForEntry(r.id)).find(Boolean) || 'general';

  const metas = await classifyBatch(
    batch.map(r => ({ title: r.title, text: r.content.slice(0, 800) })),
    topic,
  );

  let processed = 0;
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i]!;
    const meta = metas[i]!;
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);

    // Skip if classify returned defaults (tags still empty = LLM failed)
    if (meta.tags.length === 0 && meta.domain.length <= 1) {
      continue;
    }

    try {
      await getDb().transaction(async tx => {
        // Update decay rate
        await tx
          .update(entry)
          .set({ decayRate: meta.decayRate })
          .where(and(eq(entry.id, row.id), eq(entry.createdAt, createdAt)));

        // Replace domains
        await tx.delete(entryDomain).where(and(eq(entryDomain.entryId, row.id), eq(entryDomain.entryCreatedAt, createdAt)));
        if (meta.domain.length > 0) {
          await tx
            .insert(entryDomain)
            .values(
              meta.domain.map(d => ({
                entryId: row.id,
                entryCreatedAt: createdAt,
                domain: d,
              })),
            )
            .onConflictDoNothing();
        }

        // Add tags. Reclassify can re-visit the same entry and
        // propose tags that already exist from a prior pass — let
        // the UNIQUE constraint absorb duplicates instead of
        // failing the whole transaction.
        if (meta.tags.length > 0) {
          await tx
            .insert(entryTag)
            .values(
              meta.tags.map(t => ({
                entryId: row.id,
                entryCreatedAt: createdAt,
                tag: t,
              })),
            )
            .onConflictDoNothing();
        }
      });
      processed++;
    } catch (err) {
      logger.warn({ entryId: row.id, error: (err as Error).message }, 'reclassify failed');
    }
  }

  if (processed > 0) {
    logger.info({ processed, batchSize }, 'reclassify batch processed');
  }
  return processed;
}
