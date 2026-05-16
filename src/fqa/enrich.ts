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
//   4. Optionally push to the reporter's callback URL.
//   5. Recompute evidence_strength using the new merged view.
//   6. Transition enrichment_status:
//        - if direct+inferred now strong enough → finalized_inferred
//        - else if claim is high-authority → awaiting_pull
//        - else → finalized_inferred (not worth chasing)
//   7. Idempotent: re-running on an already-enriched row only
//      re-evaluates the status transition.

import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection";
import { claim, claimFeedback } from "../db/schema";
import {
  inferFromAuditNote,
  recomputeEvidenceStrength,
} from "./enrichment-llm";
import { pushEnrichmentRequest } from "./push";
import { logger } from "../observability/logger";

export interface EnrichmentReport {
  feedbackId: string;
  enriched: boolean;
  fieldsInferred: string[];
  finalEnrichmentStatus: string;
  newEvidenceStrength: number;
  pushOutcome: string | null;
}

const STRONG_ENOUGH = 0.8;
const PULL_AUTHORITY_FLOOR = 0.5;

export async function runEnrichment(
  feedbackId: string,
): Promise<EnrichmentReport | null> {
  const [row] = await db
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
      enrichmentCallbackUrl: claimFeedback.enrichmentCallbackUrl,
      callbackCapability: claimFeedback.callbackCapability,
      pushAttemptedAt: claimFeedback.pushAttemptedAt,
    })
    .from(claimFeedback)
    .where(eq(claimFeedback.id, feedbackId))
    .limit(1);

  if (!row) return null;

  // Held outcomes are not enrichment targets — nothing to investigate.
  if (row.outcome === "held") {
    return {
      feedbackId: row.id,
      enriched: false,
      fieldsInferred: [],
      finalEnrichmentStatus: "not_needed",
      newEvidenceStrength: 0,
      pushOutcome: null,
    };
  }

  const [claimRow] = await db
    .select({ statement: claim.statement, authority: claim.authority })
    .from(claim)
    .where(eq(claim.id, row.claimId))
    .limit(1);

  const claimStatement = claimRow?.statement ?? "";
  const claimAuthority = claimRow?.authority ?? 0;

  // Only run LLM if there's audit text AND at least one inferred
  // slot is empty. Avoids re-burning tokens on already-enriched
  // rows that the caller may invoke again.
  const inferredSlotsEmpty =
    !row.failureDimensionInferred || !row.counterSourceUrlInferred || row.partialTruthInferred === null;
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
        fieldsInferred.push("failureDimension");
      }
      if (inferredPartial === null && inferred.partialTruth !== null) {
        inferredPartial = inferred.partialTruth;
        fieldsInferred.push("partialTruth");
      }
      if (!inferredUrl && inferred.counterSourceUrl) {
        inferredUrl = inferred.counterSourceUrl;
        fieldsInferred.push("counterSourceUrl");
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
    contextScope:
      row.contextScope && typeof row.contextScope === "object"
        ? (row.contextScope as Record<string, unknown>)
        : null,
    partialTruth: row.partialTruth,
    partialTruthInferred: inferredPartial,
  });

  // Status transition. First decision: would this otherwise route
  // to awaiting_pull? If yes AND the reporter advertised a callback,
  // attempt push first — that may close the loop without waiting
  // for the reporter to poll on its own cadence.
  let finalStatus: string;
  let pushDirectFields:
    | {
        failureDimension?: string;
        partialTruth?: number;
        counterSourceUrl?: string;
        counterClaimText?: string;
        counterNliScore?: number;
      }
    | null = null;
  let pushOutcomeRecord: string | null = null;
  let pushTimestamp: Date | null = null;

  const wouldRouteToPull =
    newStrength < STRONG_ENOUGH &&
    claimAuthority >= PULL_AUTHORITY_FLOOR &&
    (row.outcome === "failed" || row.outcome === "partial");

  const canPush =
    wouldRouteToPull &&
    !row.pushAttemptedAt && // never push twice on the same row
    row.enrichmentCallbackUrl &&
    row.callbackCapability &&
    row.callbackCapability !== "none";

  if (canPush) {
    pushTimestamp = new Date();
    const deadline = new Date(
      pushTimestamp.getTime() +
        Number(process.env.KNOLDR_FQA_PUSH_DEADLINE_MS ?? 60_000),
    );
    const questions: Array<{
      field: string;
      prompt: string;
      enum?: readonly string[];
      optional?: boolean;
    }> = [];
    if (!row.failureDimension && !inferredFailureDim) {
      questions.push({
        field: "failureDimension",
        prompt: "Which dimension of the claim failed?",
        enum: [
          "fully_false",
          "scope_too_broad",
          "time_expired",
          "modality_too_strong",
          "context_mismatch",
          "partially_correct",
        ],
      });
    }
    if (!row.counterSourceUrl && !inferredUrl) {
      questions.push({
        field: "counterSourceUrl",
        prompt: "URL or document showing the contradicting evidence?",
        optional: true,
      });
    }
    const push = await pushEnrichmentRequest(row.enrichmentCallbackUrl!, {
      enrichmentTaskId: row.id,
      feedbackId: row.id,
      claimId: row.claimId,
      claimText: claimStatement,
      questions: questions.slice(0, 2),
      deadline: deadline.toISOString(),
    });
    pushOutcomeRecord = push.outcome;
    if (push.outcome === "success" && push.fields) {
      pushDirectFields = push.fields;
    }
  }

  // Merge direct fields the reporter answered via push (these take
  // precedence over inferred and respect "original direct wins" —
  // existing row.* values are preserved if set).
  const directFailureDim = row.failureDimension ?? pushDirectFields?.failureDimension ?? null;
  const directPartial = row.partialTruth ?? pushDirectFields?.partialTruth ?? null;
  const directUrl = row.counterSourceUrl ?? pushDirectFields?.counterSourceUrl ?? null;
  const directClaimText = row.counterClaimText ?? pushDirectFields?.counterClaimText ?? null;
  const directNliScore = row.counterNliScore ?? pushDirectFields?.counterNliScore ?? null;

  // Recompute strength again now that push may have filled direct
  // slots.
  const finalStrength = pushDirectFields
    ? recomputeEvidenceStrength({
        counterSourceUrl: directUrl,
        counterSourceUrlInferred: inferredUrl,
        counterNliScore: directNliScore,
        failureDimension: directFailureDim,
        failureDimensionInferred: inferredFailureDim,
        contextDomain: row.contextDomain,
        contextScope:
          row.contextScope && typeof row.contextScope === "object"
            ? (row.contextScope as Record<string, unknown>)
            : null,
        partialTruth: directPartial,
        partialTruthInferred: inferredPartial,
      })
    : newStrength;

  if (finalStrength >= STRONG_ENOUGH) {
    finalStatus = pushDirectFields ? "enriched" : "finalized_inferred";
  } else if (
    claimAuthority >= PULL_AUTHORITY_FLOOR &&
    (row.outcome === "failed" || row.outcome === "partial")
  ) {
    finalStatus = "awaiting_pull";
  } else {
    finalStatus = "finalized_inferred";
  }

  await db
    .update(claimFeedback)
    .set({
      failureDimension: directFailureDim,
      partialTruth: directPartial,
      counterSourceUrl: directUrl,
      counterClaimText: directClaimText,
      counterNliScore: directNliScore,
      failureDimensionInferred: inferredFailureDim,
      partialTruthInferred: inferredPartial,
      counterSourceUrlInferred: inferredUrl,
      ...(llmVersion && now
        ? {
            enrichedAt: now,
            enrichedBy: "knoldr-fqa",
            enrichmentLlmVersion: llmVersion,
          }
        : {}),
      ...(pushOutcomeRecord
        ? {
            pushOutcome: pushOutcomeRecord,
            pushAttemptedAt: pushTimestamp,
            reporterResponded: pushDirectFields ? 1 : 0,
          }
        : {}),
      evidenceStrength: finalStrength,
      enrichmentStatus: finalStatus,
    })
    .where(eq(claimFeedback.id, row.id));

  logger.info(
    {
      feedbackId: row.id,
      claimId: row.claimId,
      fieldsInferred,
      newStrength,
      finalStrength,
      pushOutcome: pushOutcomeRecord,
      finalStatus,
      llmVersion,
    },
    "fqa enrichment complete",
  );

  return {
    feedbackId: row.id,
    enriched: fieldsInferred.length > 0 || pushDirectFields !== null,
    fieldsInferred,
    finalEnrichmentStatus: finalStatus,
    newEvidenceStrength: finalStrength,
    pushOutcome: pushOutcomeRecord,
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
export async function expireStalePullTasks(ttlHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000);
  const result = await db
    .update(claimFeedback)
    .set({ enrichmentStatus: "expired_reporter_unavailable" })
    .where(
      sql`${claimFeedback.enrichmentStatus} = 'awaiting_pull'
          AND ${claimFeedback.createdAt} < ${cutoff}`,
    )
    .returning({ id: claimFeedback.id });
  if (result.length > 0) {
    logger.info(
      { expired: result.length, ttlHours },
      "fqa expired stale awaiting_pull tasks",
    );
  }
  return result.length;
}

/**
 * Background sweep — selects rows worth enriching and runs
 * `runEnrichment` on each. Bounded by maxItems. Called by the
 * scheduled worker in `workers.ts`.
 */
export async function auditAndEnrich(opts: {
  timeWindowHours: number;
  maxItems: number;
}): Promise<{
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
  const rows = await db
    .select({
      id: claimFeedback.id,
      evidenceStrength: claimFeedback.evidenceStrength,
      enrichmentStatus: claimFeedback.enrichmentStatus,
    })
    .from(claimFeedback)
    .where(
      sql`${claimFeedback.createdAt} >= ${cutoff}
        AND ${claimFeedback.evidenceStrength} < 0.8
        AND ${claimFeedback.outcome} IN ('failed','partial')
        AND ${claimFeedback.enrichmentStatus} IN ('pending','awaiting_pull')`,
    )
    .orderBy(sql`${claimFeedback.evidenceStrength} ASC`)
    .limit(opts.maxItems);

  let enriched = 0;
  const skipped = new Map<string, number>();

  for (const r of rows) {
    const result = await runEnrichment(r.id);
    if (!result) {
      skipped.set("not_found", (skipped.get("not_found") ?? 0) + 1);
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
