// claim_feedback A2A skill — claim-level structured feedback (v0.4).
//
// Distinct from the entry-level `feedback` skill. This one targets a
// specific claim (by ULID) and accepts the v0.4 structured shape:
// application_method × outcome × failure_dimension × counter-evidence.
// The reporter must declare HOW they applied the claim and what the
// outcome was; failure_dimension narrows partial truths to one of the
// five distortion categories established in the design.
//
// This pass records only. Authority / verdict state changes flow
// through the FQA enrichment pipeline (next milestone), at which
// point evidence_strength × agent_feedback_authority will weight
// claim certainty adjustments.

import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';

import { getDb } from '../../db/connection';
import { claim, claimFeedback, agentFeedbackAuthority } from '../../db/schema';
import { enqueueEnrichment } from '../../fqa/queue';
import { logger } from '../../observability/logger';
import { ApplicationMethod, EnrichmentStatus, FailureDimension, Outcome } from '../../score/enums';
import { computeFeedbackEvidenceStrength } from '../../score/feedback-strength';

const claimFeedbackInputSchema = z
  .object({
    // When set, the call updates an existing row instead of inserting
    // a new one. Used by reporters that learned more after their
    // initial submission. The row's reporter_agent_id must match.
    feedbackId: z.string().min(1).max(200).optional(),

    claimId: z.string().min(1).max(200),
    reporterAgentId: z.string().min(1).max(200),
    applicationMethod: z.enum(ApplicationMethod),
    outcome: z.enum(Outcome),

    failureDimension: z.enum(FailureDimension).optional(),
    partialTruth: z.number().min(0).max(1).optional(),
    contextDomain: z.string().max(100).optional(),
    contextTimeFrom: z.iso.datetime().optional(),
    contextTimeUntil: z.iso.datetime().optional(),
    contextScope: z.record(z.string(), z.unknown()).optional(),
    counterSourceUrl: z.url().max(2000).optional(),
    counterClaimText: z.string().max(2000).optional(),
    counterNliScore: z.number().min(0).max(1).optional(),
    auditNote: z.string().max(4000).optional(),
  })
  // Held outcomes can't carry a failure dimension — the claim worked
  // as advertised. Failed/partial may but aren't required to.
  .refine(v => !(v.outcome === Outcome.Held && v.failureDimension !== undefined), {
    message: `failureDimension must not be set when outcome='${Outcome.Held}'`,
    path: ['failureDimension'],
  });

type ClaimFeedbackInput = z.infer<typeof claimFeedbackInputSchema>;

type ClaimFeedbackResult =
  | {
      ok: true;
      feedbackId: string;
      claimId: string;
      evidenceStrength: number;
      reporterFeedbackAuthority: number;
      enrichmentStatus: string;
      updated: boolean;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'claim_not_found' | 'feedback_not_found' | 'reporter_mismatch';
      message: string;
      missingRequired?: string[];
    };

/**
 * Insert-path strength: delegates to the shared scorer with only
 * direct fields populated (inferred slots are always empty at the
 * point a brand-new feedback row is being inserted).
 */
function computeEvidenceStrength(input: ClaimFeedbackInput): number {
  return computeFeedbackEvidenceStrength({
    counterSourceUrl: input.counterSourceUrl ?? null,
    counterNliScore: input.counterNliScore ?? null,
    failureDimension: input.failureDimension ?? null,
    contextDomain: input.contextDomain ?? null,
    contextScope: input.contextScope ?? null,
    partialTruth: input.partialTruth ?? null,
  });
}

/**
 * Initial enrichment_status decision. The FQA worker will transition
 * pending → enriched / awaiting_pull / etc. asynchronously. We set
 * the *initial* state here so the queue knows what work to pick up.
 */
function initialEnrichmentStatus(input: ClaimFeedbackInput, strength: number): EnrichmentStatus {
  // Held outcomes carry no enrichment value — no failure to investigate.
  if (input.outcome === Outcome.Held) {
    return EnrichmentStatus.NotNeeded;
  }
  // Already strong enough that FQA wouldn't ask for more.
  if (strength >= 0.8) {
    return EnrichmentStatus.NotNeeded;
  }
  return EnrichmentStatus.Pending;
}

async function handleClaimFeedback(input: Record<string, unknown>): Promise<ClaimFeedbackResult> {
  let validated: ClaimFeedbackInput;
  try {
    validated = claimFeedbackInputSchema.parse(input);
  } catch (err) {
    const zerr = err as z.ZodError;
    // zod v4 emits "Invalid input: expected ..., received undefined"
    // for missing fields. v4 ZodIssue doesn't expose a `received`
    // property (only `expected`/`message`/`code`/`path`), so message-
    // text matching is the only reliable signal. The earlier filter
    // checked an `i.received` that doesn't exist, which caused every
    // invalid_type — including wrong-shape inputs — to be classified
    // as missing. Now we restrict to issues whose message clearly
    // names "undefined" as the received value.
    const missing = zerr.issues
      ?.filter(i => {
        if (i.code !== 'invalid_type') {
          return false;
        }
        return typeof i.message === 'string' && /received\s+undefined/i.test(i.message);
      })
      .map(i => i.path.join('.'));
    return {
      ok: false,
      error: 'invalid_input',
      message: zerr.message,
      missingRequired: missing && missing.length > 0 ? missing : undefined,
    };
  }

  // Confirm the claim exists. FK would catch this at INSERT but
  // doing it up-front lets us return a clean error code rather
  // than a generic 500 from a constraint violation.
  const [claimRow] = await getDb().select({ id: claim.id }).from(claim).where(eq(claim.id, validated.claimId)).limit(1);

  if (!claimRow) {
    return {
      ok: false,
      error: 'claim_not_found',
      message: `claim ${validated.claimId} does not exist`,
    };
  }

  // Update mode: an existing row owned by this reporter gets its
  // NULL direct fields filled. Set fields are preserved — a reporter
  // cannot overwrite their own past direct answers. Strength + status
  // are recomputed off the merged view.
  if (validated.feedbackId) {
    return await updateExistingFeedback(validated);
  }

  const evidenceStrength = computeEvidenceStrength(validated);
  const enrichmentStatus = initialEnrichmentStatus(validated, evidenceStrength);

  const feedbackId = ulid();

  // All three mutations (feedback row, reporter counter, claim
  // authority) happen inside one transaction. Without this, an
  // insert failure after the upsert leaves totalFeedbacks bumped
  // for a row that never existed, slowly corrupting the counter.
  await getDb().transaction(async tx => {
    // Reporter's authority row — first-contact gets default 0.5;
    // existing rows have totalFeedbacks bumped. correct/incorrect
    // move only when later re-verification confirms or refutes.
    await tx
      .insert(agentFeedbackAuthority)
      .values({
        agentId: validated.reporterAgentId,
        feedbackAuthority: 0.5,
        totalFeedbacks: 1,
      })
      .onConflictDoUpdate({
        target: agentFeedbackAuthority.agentId,
        set: {
          totalFeedbacks: sql`${agentFeedbackAuthority.totalFeedbacks} + 1`,
          lastUpdatedAt: new Date(),
        },
      });

    // Insert the feedback row BEFORE adjusting claim.authority so a
    // FK or CHECK failure doesn't move authority for a row that
    // never persisted.
    await tx.insert(claimFeedback).values({
      id: feedbackId,
      claimId: validated.claimId,
      reporterAgentId: validated.reporterAgentId,
      applicationMethod: validated.applicationMethod,
      outcome: validated.outcome,
      failureDimension: validated.failureDimension ?? null,
      partialTruth: validated.partialTruth ?? null,
      contextDomain: validated.contextDomain ?? null,
      contextTimeFrom: validated.contextTimeFrom ? new Date(validated.contextTimeFrom) : null,
      contextTimeUntil: validated.contextTimeUntil ? new Date(validated.contextTimeUntil) : null,
      contextScope: validated.contextScope ?? null,
      counterSourceUrl: validated.counterSourceUrl ?? null,
      counterClaimText: validated.counterClaimText ?? null,
      counterNliScore: validated.counterNliScore ?? null,
      auditNote: validated.auditNote ?? null,
      enrichmentStatus,
      evidenceStrength,
    });

    await adjustClaimAuthorityTx(tx, validated.claimId, validated.reporterAgentId, evidenceStrength, validated.outcome);
  });

  // Fire-and-forget immediate enrichment: only when the row actually
  // entered 'pending' state (i.e., it's not 'not_needed' from held
  // outcome or already-strong evidence). The handler's response
  // doesn't wait — the agent gets its 100ms ack immediately and the
  // in-process worker drains enrichment in the background.
  if (enrichmentStatus === EnrichmentStatus.Pending) {
    enqueueEnrichment(feedbackId);
  }

  // Fetch the reporter's current authority for the response so the
  // caller can see how their feedback will be weighted.
  const [authorityRow] = await getDb()
    .select({ fa: agentFeedbackAuthority.feedbackAuthority })
    .from(agentFeedbackAuthority)
    .where(eq(agentFeedbackAuthority.agentId, validated.reporterAgentId))
    .limit(1);

  logger.info(
    {
      feedbackId,
      claimId: validated.claimId,
      reporter: validated.reporterAgentId,
      outcome: validated.outcome,
      evidenceStrength,
      enrichmentStatus,
    },
    'claim_feedback recorded',
  );

  return {
    ok: true,
    feedbackId,
    claimId: validated.claimId,
    evidenceStrength,
    reporterFeedbackAuthority: authorityRow?.fa ?? 0.5,
    enrichmentStatus,
    updated: false,
  };
}

async function updateExistingFeedback(input: ClaimFeedbackInput): Promise<ClaimFeedbackResult> {
  const [row] = await getDb()
    .select({
      id: claimFeedback.id,
      claimId: claimFeedback.claimId,
      reporterAgentId: claimFeedback.reporterAgentId,
      outcome: claimFeedback.outcome,
      evidenceStrength: claimFeedback.evidenceStrength,
      failureDimension: claimFeedback.failureDimension,
      partialTruth: claimFeedback.partialTruth,
      counterSourceUrl: claimFeedback.counterSourceUrl,
      counterClaimText: claimFeedback.counterClaimText,
      counterNliScore: claimFeedback.counterNliScore,
      counterSourceUrlInferred: claimFeedback.counterSourceUrlInferred,
      failureDimensionInferred: claimFeedback.failureDimensionInferred,
      partialTruthInferred: claimFeedback.partialTruthInferred,
      contextDomain: claimFeedback.contextDomain,
      contextScope: claimFeedback.contextScope,
    })
    .from(claimFeedback)
    .where(eq(claimFeedback.id, input.feedbackId!))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      error: 'feedback_not_found',
      message: `feedback ${input.feedbackId} does not exist`,
    };
  }
  if (row.reporterAgentId !== input.reporterAgentId) {
    return {
      ok: false,
      error: 'reporter_mismatch',
      message: 'feedbackId belongs to a different reporter',
    };
  }
  // Defense against a reporter sending feedbackId for claim A with
  // claimId for claim B — without this check the row updates with
  // claim A's data but the authority delta lands on claim B.
  if (row.claimId !== input.claimId) {
    return {
      ok: false,
      error: 'reporter_mismatch',
      message: "claimId does not match the feedback row's recorded claim",
    };
  }
  // The stored outcome is immutable for authority direction; allowing
  // a reporter to switch outcome on update would let them flip the
  // sign of the EMA adjustment retroactively. We use row.outcome (the
  // truth at submit time) regardless of what input.outcome says.
  const effectiveOutcome = row.outcome as Outcome;

  // Fill NULL direct fields only; preserve set values so a reporter
  // can't rewrite their own history.
  const merged = {
    failureDimension: row.failureDimension ?? input.failureDimension ?? null,
    partialTruth: row.partialTruth ?? input.partialTruth ?? null,
    counterSourceUrl: row.counterSourceUrl ?? input.counterSourceUrl ?? null,
    counterClaimText: row.counterClaimText ?? input.counterClaimText ?? null,
    counterNliScore: row.counterNliScore ?? input.counterNliScore ?? null,
  };

  // Recompute strength using direct (merged) + inferred (already on row).
  const newStrength = computeFeedbackEvidenceStrength({
    counterSourceUrl: merged.counterSourceUrl,
    counterSourceUrlInferred: row.counterSourceUrlInferred,
    counterNliScore: merged.counterNliScore,
    failureDimension: merged.failureDimension,
    failureDimensionInferred: row.failureDimensionInferred,
    contextDomain: row.contextDomain,
    contextScope: row.contextScope && typeof row.contextScope === 'object' ? (row.contextScope as Record<string, unknown>) : null,
    partialTruth: merged.partialTruth,
    partialTruthInferred: row.partialTruthInferred,
  });

  // Status transition: held-equivalent or strong enough → final;
  // otherwise stay pending for the background worker to revisit.
  // Uses the stored outcome, not the input — see effectiveOutcome.
  const newStatus =
    effectiveOutcome === Outcome.Held
      ? EnrichmentStatus.NotNeeded
      : newStrength >= 0.8
        ? EnrichmentStatus.Enriched
        : EnrichmentStatus.Pending;

  // Both writes inside one transaction: feedback row update and
  // claim authority adjustment commit together or not at all.
  // Without this a successful row update followed by a failed
  // authority adjust leaves the row's evidenceStrength advanced
  // but no matching authority movement — silent drift over time.
  const strengthDelta = newStrength - row.evidenceStrength;
  await getDb().transaction(async tx => {
    await tx
      .update(claimFeedback)
      .set({
        failureDimension: merged.failureDimension,
        partialTruth: merged.partialTruth,
        counterSourceUrl: merged.counterSourceUrl,
        counterClaimText: merged.counterClaimText,
        counterNliScore: merged.counterNliScore,
        reporterResponded: 1,
        evidenceStrength: newStrength,
        enrichmentStatus: newStatus,
      })
      .where(eq(claimFeedback.id, row.id));

    if (strengthDelta !== 0) {
      await adjustClaimAuthorityTx(tx, row.claimId, input.reporterAgentId, strengthDelta, effectiveOutcome);
    }
  });

  const [authorityRow] = await getDb()
    .select({ fa: agentFeedbackAuthority.feedbackAuthority })
    .from(agentFeedbackAuthority)
    .where(eq(agentFeedbackAuthority.agentId, input.reporterAgentId))
    .limit(1);

  logger.info(
    {
      feedbackId: row.id,
      claimId: input.claimId,
      reporter: input.reporterAgentId,
      newStrength,
      newStatus,
    },
    'claim_feedback updated by reporter',
  );

  return {
    ok: true,
    feedbackId: row.id,
    claimId: input.claimId,
    evidenceStrength: newStrength,
    reporterFeedbackAuthority: authorityRow?.fa ?? 0.5,
    enrichmentStatus: newStatus,
    updated: true,
  };
}

/**
 * Move `claim.authority` based on a fresh feedback row. Held →
 * gentle bump up; failed/partial → gentle bump down. Magnitude
 * is bounded by evidence_strength × reporter feedback_authority
 * × LEARNING_RATE so a single noisy signal can't whiplash the
 * score. Clamped to [0,1] at the SQL level so concurrent updates
 * stay safe.
 */
const FEEDBACK_LEARNING_RATE = 0.05;

// `executor` covers both the top-level db and a drizzle transaction
// handle. We type loosely so callers from a `getDb().transaction(tx => ...)`
// callback can pass `tx` directly without TS complaining about the
// `$client` property that lives only on the top-level instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthorityExecutor = any;

async function adjustClaimAuthorityTx(
  executor: AuthorityExecutor,
  claimId: string,
  reporterAgentId: string,
  strengthDelta: number,
  outcome: Outcome,
): Promise<void> {
  if (strengthDelta === 0) {
    return;
  }

  const [authRow] = await executor
    .select({ fa: agentFeedbackAuthority.feedbackAuthority })
    .from(agentFeedbackAuthority)
    .where(eq(agentFeedbackAuthority.agentId, reporterAgentId))
    .limit(1);
  const reporterAuthority = authRow?.fa ?? 0.5;

  const sign = outcome === Outcome.Held ? 1 : -1;
  const delta = sign * strengthDelta * reporterAuthority * FEEDBACK_LEARNING_RATE;
  if (delta === 0) {
    return;
  }

  await executor.execute(sql`
    UPDATE claim
    SET authority = GREATEST(0::double precision,
                             LEAST(1::double precision, authority + ${delta}))
    WHERE id = ${claimId}
  `);
}

export { handleClaimFeedback };
