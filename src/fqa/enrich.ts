// FQA enrichment — run the full enrichment loop on one feedback row.
//
// Background-only. No A2A skill exposes this; the workers under
// `workers.ts` call it on a schedule. Reporter-driven completion is
// handled by `claim_feedback` (update mode) on the main A2A.
//
// Steps:
//   1. Load the row + the referenced claim's statement.
//   2. If audit_note is present, ask the local LLM to infer
//      failure_dimension / partial_truth / counter_source_url.
//   3. Write inferred values into *_inferred columns (never the
//      direct columns — those belong to the reporter).
//   4. Recompute evidence_strength using the new merged view.
//   5. Transition enrichment_status:
//        - if direct+inferred now strong enough → finalized_inferred
//        - else if claim is high-authority → awaiting_pull
//        - else → finalized_inferred (not worth chasing)
//   6. Idempotent: re-running on an already-enriched row only
//      re-evaluates the status transition.
//
// No push channel. Real-world reporter agents are almost always
// transient (LLM tool-call style) with no persistent HTTP server,
// so the previous push attempt was dead code for the dominant
// use case. Reporters that want to add detail to their feedback
// re-call `claim_feedback` in update mode.

import { eq, sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { claim, claimFeedback } from '../db/schema';
import { logger } from '../observability/logger';
import { EnrichmentStatus, Outcome } from '../score/enums';
import { inferFromAuditNote, recomputeEvidenceStrength } from './enrichment-llm';

interface EnrichmentReport {
  feedbackId: string;
  enriched: boolean;
  fieldsInferred: string[];
  finalEnrichmentStatus: EnrichmentStatus;
  newEvidenceStrength: number;
}

const STRONG_ENOUGH = 0.8;
const PULL_AUTHORITY_FLOOR = 0.5;

async function runEnrichment(feedbackId: string): Promise<EnrichmentReport | null> {
  const [row] = await getDb()
    .select({
      id: claimFeedback.id,
      claimId: claimFeedback.claimId,
      reporterAgentId: claimFeedback.reporterAgentId,
      auditNote: claimFeedback.auditNote,
      outcome: claimFeedback.outcome,
      enrichmentStatus: claimFeedback.enrichmentStatus,
      failureDimension: claimFeedback.failureDimension,
      failureDimensionInferred: claimFeedback.failureDimensionInferred,
      partialTruth: claimFeedback.partialTruth,
      partialTruthInferred: claimFeedback.partialTruthInferred,
      counterSourceUrl: claimFeedback.counterSourceUrl,
      counterSourceUrlInferred: claimFeedback.counterSourceUrlInferred,
      counterClaimText: claimFeedback.counterClaimText,
      counterNliScore: claimFeedback.counterNliScore,
      contextDomain: claimFeedback.contextDomain,
      contextScope: claimFeedback.contextScope,
    })
    .from(claimFeedback)
    .where(eq(claimFeedback.id, feedbackId))
    .limit(1);

  if (!row) {
    return null;
  }

  // Held outcomes are not enrichment targets — nothing to investigate.
  if (row.outcome === Outcome.Held) {
    return {
      feedbackId: row.id,
      enriched: false,
      fieldsInferred: [],
      finalEnrichmentStatus: EnrichmentStatus.NotNeeded,
      newEvidenceStrength: 0,
    };
  }

  const [claimRow] = await getDb()
    .select({ statement: claim.statement, authority: claim.authority })
    .from(claim)
    .where(eq(claim.id, row.claimId))
    .limit(1);

  const claimStatement = claimRow?.statement ?? '';
  const claimAuthority = claimRow?.authority ?? 0;

  // Only run LLM if there's audit text AND at least one inferred
  // slot is empty. Avoids re-burning tokens on already-enriched
  // rows that the caller may invoke again.
  const inferredSlotsEmpty = !row.failureDimensionInferred || !row.counterSourceUrlInferred || row.partialTruthInferred === null;
  const fieldsInferred: string[] = [];
  let inferredFailureDim = row.failureDimensionInferred;
  let inferredPartial = row.partialTruthInferred;
  let inferredUrl = row.counterSourceUrlInferred;
  let llmVersion: string | null = null;
  let now: Date | null = null;

  if (row.auditNote && inferredSlotsEmpty && claimStatement) {
    const inferred = await inferFromAuditNote(claimStatement, row.auditNote);
    if (inferred) {
      llmVersion = inferred.llmVersion;
      now = new Date();
      if (!inferredFailureDim && inferred.failureDimension) {
        inferredFailureDim = inferred.failureDimension;
        fieldsInferred.push('failureDimension');
      }
      if (inferredPartial === null && inferred.partialTruth !== null) {
        inferredPartial = inferred.partialTruth;
        fieldsInferred.push('partialTruth');
      }
      if (!inferredUrl && inferred.counterSourceUrl) {
        inferredUrl = inferred.counterSourceUrl;
        fieldsInferred.push('counterSourceUrl');
      }
    }
  }

  // Recompute strength using direct + inferred (merged).
  const newStrength = recomputeEvidenceStrength({
    counterSourceUrl: row.counterSourceUrl,
    counterSourceUrlInferred: inferredUrl,
    counterNliScore: row.counterNliScore,
    failureDimension: row.failureDimension,
    failureDimensionInferred: inferredFailureDim,
    contextDomain: row.contextDomain,
    contextScope: row.contextScope && typeof row.contextScope === 'object' ? (row.contextScope as Record<string, unknown>) : null,
    partialTruth: row.partialTruth,
    partialTruthInferred: inferredPartial,
  });

  // Status transition. No push channel — outcome is either
  // finalized_inferred (LLM inference was enough or the claim isn't
  // worth chasing) or awaiting_pull (claim is worth chasing and
  // we'll wait for the reporter to re-submit via `claim_feedback`
  // update mode). The actual transition out of `awaiting_pull`
  // happens when the reporter calls back, not from here.
  let finalStatus: EnrichmentStatus;
  if (newStrength >= STRONG_ENOUGH) {
    finalStatus = EnrichmentStatus.FinalizedInferred;
  } else if (claimAuthority >= PULL_AUTHORITY_FLOOR && (row.outcome === Outcome.Failed || row.outcome === Outcome.Partial)) {
    finalStatus = EnrichmentStatus.AwaitingPull;
  } else {
    finalStatus = EnrichmentStatus.FinalizedInferred;
  }

  await getDb()
    .update(claimFeedback)
    .set({
      failureDimensionInferred: inferredFailureDim,
      partialTruthInferred: inferredPartial,
      counterSourceUrlInferred: inferredUrl,
      ...(llmVersion && now
        ? {
            enrichedAt: now,
            enrichedBy: 'knoldr-fqa',
            enrichmentLlmVersion: llmVersion,
          }
        : {}),
      evidenceStrength: newStrength,
      enrichmentStatus: finalStatus,
    })
    .where(eq(claimFeedback.id, row.id));

  logger.info(
    {
      feedbackId: row.id,
      claimId: row.claimId,
      fieldsInferred,
      newStrength,
      finalStatus,
      llmVersion,
    },
    'fqa enrichment complete',
  );

  return {
    feedbackId: row.id,
    enriched: fieldsInferred.length > 0,
    fieldsInferred,
    finalEnrichmentStatus: finalStatus,
    newEvidenceStrength: newStrength,
  };
}

/**
 * TTL sweep: transition stale awaiting_pull rows to
 * `expired_reporter_unavailable`. Reporters that never came back to
 * answer their enrichment task get their tasks cleanly finalized so
 * (a) audit metrics don't accumulate stale work and (b) the
 * reporter's `feedback_authority` doesn't unfairly stay frozen
 * waiting for them to respond.
 *
 * TTL is the same window `pending` enforces, so any task pull would
 * already have failed the deadline check.
 */
async function expireStalePullTasks(ttlHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000);
  const result = await getDb()
    .update(claimFeedback)
    .set({ enrichmentStatus: EnrichmentStatus.ExpiredReporterUnavailable })
    .where(
      sql`${claimFeedback.enrichmentStatus} = ${EnrichmentStatus.AwaitingPull}
          AND ${claimFeedback.createdAt} < ${cutoff}`,
    )
    .returning({ id: claimFeedback.id });
  if (result.length > 0) {
    logger.info({ expired: result.length, ttlHours }, 'fqa expired stale awaiting_pull tasks');
  }
  return result.length;
}

/**
 * Background sweep — selects rows worth enriching and runs
 * `runEnrichment` on each. Bounded by maxItems. Called by the
 * scheduled worker in `workers.ts`.
 */
async function auditAndEnrich(opts: { timeWindowHours: number; maxItems: number }): Promise<{
  scanned: number;
  enriched: number;
  skipped: Array<{ reason: string; count: number }>;
}> {
  const cutoff = new Date(Date.now() - opts.timeWindowHours * 3600 * 1000);

  // Candidate rows: pending or awaiting_pull, evidence still under
  // the strong-enough threshold (0.8) that the initial status set
  // by claim_feedback, in the outcome group where enrichment is
  // meaningful. Previously hardcoded < 0.5 here orphaned every
  // [0.5, 0.8) pending row forever.
  const rows = await getDb()
    .select({
      id: claimFeedback.id,
      evidenceStrength: claimFeedback.evidenceStrength,
      enrichmentStatus: claimFeedback.enrichmentStatus,
    })
    .from(claimFeedback)
    .where(
      sql`${claimFeedback.createdAt} >= ${cutoff}
        AND ${claimFeedback.evidenceStrength} < 0.8
        AND ${claimFeedback.outcome} IN (${Outcome.Failed}, ${Outcome.Partial})
        AND ${claimFeedback.enrichmentStatus} IN (${EnrichmentStatus.Pending}, ${EnrichmentStatus.AwaitingPull})`,
    )
    .orderBy(sql`${claimFeedback.evidenceStrength} ASC`)
    .limit(opts.maxItems);

  let enriched = 0;
  const skipped = new Map<string, number>();

  for (const r of rows) {
    const result = await runEnrichment(r.id);
    if (!result) {
      skipped.set('not_found', (skipped.get('not_found') ?? 0) + 1);
      continue;
    }
    if (result.enriched) {
      enriched++;
    } else {
      const key = result.finalEnrichmentStatus;
      skipped.set(key, (skipped.get(key) ?? 0) + 1);
    }
  }

  return {
    scanned: rows.length,
    enriched,
    skipped: Array.from(skipped, ([reason, count]) => ({ reason, count })),
  };
}

export { runEnrichment, expireStalePullTasks, auditAndEnrich };
