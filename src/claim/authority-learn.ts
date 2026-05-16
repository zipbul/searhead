// agent_feedback_authority learning.
//
// When a claim's verdict transitions, every recent claim_feedback row
// on that claim becomes evaluable: did the reporter's outcome prediction
// agree with what the system later decided? We update the reporter's
// correct/incorrect counters and recompute feedback_authority via EMA.
//
// "Recent" is bounded so this can't accidentally rescore feedback from
// years ago when an old claim suddenly drifts.

import { and, eq, gte, sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { agentFeedbackAuthority, claimFeedback } from '../db/schema';
import { logger } from '../observability/logger';
import { Outcome, Verdict } from '../score/enums';

const FEEDBACK_LOOKBACK_DAYS = 30;
const EMA_ALPHA = 0.1; // slow learning — one event can't whiplash authority

/**
 * Classify the verdict transition into one of three outcomes:
 *  - "moved_away_from_verified": failed/partial feedback was correct,
 *    held feedback was incorrect
 *  - "moved_to_verified": failed/partial feedback was incorrect,
 *    held feedback was correct
 *  - "no_signal": no movement worth learning from
 */
function classify(oldVerdict: Verdict, newVerdict: Verdict): 'moved_away_from_verified' | 'moved_to_verified' | 'no_signal' {
  if (oldVerdict === newVerdict) {
    return 'no_signal';
  }
  // not_applicable rows are non-factual and excluded from feedback learning.
  if (oldVerdict === Verdict.NotApplicable || newVerdict === Verdict.NotApplicable) {
    return 'no_signal';
  }
  if (oldVerdict === Verdict.Verified && newVerdict !== Verdict.Verified) {
    return 'moved_away_from_verified';
  }
  if (oldVerdict !== Verdict.Verified && newVerdict === Verdict.Verified) {
    return 'moved_to_verified';
  }
  // unverified ↔ disputed shifts carry weak signal — skip.
  return 'no_signal';
}

/**
 * Whether a reporter's outcome was correct given a verdict transition.
 *
 *  outcome=failed|partial + moved_away → correct
 *  outcome=failed|partial + moved_to_verified → incorrect
 *  outcome=held + moved_to_verified → correct
 *  outcome=held + moved_away → incorrect
 */
function judge(outcome: string, transition: 'moved_away_from_verified' | 'moved_to_verified'): 'correct' | 'incorrect' {
  const reporterPredictedFailure = outcome === Outcome.Failed || outcome === Outcome.Partial;
  if (transition === 'moved_away_from_verified') {
    return reporterPredictedFailure ? 'correct' : 'incorrect';
  }
  return reporterPredictedFailure ? 'incorrect' : 'correct';
}

/**
 * Adjust agent_feedback_authority for every reporter who submitted
 * feedback on this claim within the lookback window.
 *
 * Returns a small summary for logging. Safe to fire-and-forget — any
 * exception is swallowed and logged so it can never break the verify
 * pipeline.
 */
export async function recordVerdictTransition(
  claimId: string,
  oldVerdict: Verdict,
  newVerdict: Verdict,
): Promise<{ updated: number; correct: number; incorrect: number }> {
  const transition = classify(oldVerdict, newVerdict);
  if (transition === 'no_signal') {
    return { updated: 0, correct: 0, incorrect: 0 };
  }

  const cutoff = new Date(Date.now() - FEEDBACK_LOOKBACK_DAYS * 24 * 3600 * 1000);

  const recent = await getDb()
    .select({
      reporterAgentId: claimFeedback.reporterAgentId,
      outcome: claimFeedback.outcome,
    })
    .from(claimFeedback)
    .where(and(eq(claimFeedback.claimId, claimId), gte(claimFeedback.createdAt, cutoff)));

  if (recent.length === 0) {
    return { updated: 0, correct: 0, incorrect: 0 };
  }

  let correctCount = 0;
  let incorrectCount = 0;

  // Aggregate per-reporter judgments so a reporter who submitted N
  // feedbacks on the same claim doesn't see their authority moved N
  // times in one transition.
  const perReporter = new Map<string, 'correct' | 'incorrect'>();
  for (const r of recent) {
    const verdict = judge(r.outcome, transition);
    const existing = perReporter.get(r.reporterAgentId);
    // If a reporter has mixed outcomes on the same claim, prefer
    // their LATEST predominant signal — but since outcomes don't
    // get a timestamp here, we conservatively skip mixed-signal
    // reporters (count them once, but as their first judgment).
    if (!existing) {
      perReporter.set(r.reporterAgentId, verdict);
    }
  }

  for (const [agentId, verdict] of perReporter.entries()) {
    if (verdict === 'correct') {
      correctCount++;
    } else {
      incorrectCount++;
    }
    // EMA update: new = alpha * sample + (1-alpha) * current.
    // Sample is 1 for correct, 0 for incorrect.
    const sample = verdict === 'correct' ? 1 : 0;
    const incCorrect = verdict === 'correct' ? 1 : 0;
    const incIncorrect = verdict === 'correct' ? 0 : 1;
    // totalFeedbacks must also grow on each judgment, otherwise the
    // CHECK (correct + incorrect <= total) constraint trips when a
    // single claim flips verdict twice and the same feedback gets
    // judged correct + incorrect for total = 1.
    await getDb()
      .insert(agentFeedbackAuthority)
      .values({
        agentId,
        feedbackAuthority: sample,
        totalFeedbacks: 1,
        correctFeedbacks: incCorrect,
        incorrectFeedbacks: incIncorrect,
      })
      .onConflictDoUpdate({
        target: agentFeedbackAuthority.agentId,
        set: {
          // Explicit ::double precision casts — postgres-js sends every
          // bound literal as `unknown` and `unknown * unknown` has no
          // unique operator candidate, so the EMA formula fails to
          // resolve without the cast.
          feedbackAuthority: sql`${EMA_ALPHA}::double precision * ${sample}::double precision + ${1 - EMA_ALPHA}::double precision * ${agentFeedbackAuthority.feedbackAuthority}`,
          totalFeedbacks: sql`${agentFeedbackAuthority.totalFeedbacks} + 1`,
          correctFeedbacks: sql`${agentFeedbackAuthority.correctFeedbacks} + ${incCorrect}::integer`,
          incorrectFeedbacks: sql`${agentFeedbackAuthority.incorrectFeedbacks} + ${incIncorrect}::integer`,
          lastUpdatedAt: new Date(),
        },
      });
  }

  logger.info(
    {
      claimId,
      oldVerdict,
      newVerdict,
      transition,
      reporters: perReporter.size,
      correct: correctCount,
      incorrect: incorrectCount,
    },
    'agent feedback authority adjusted on verdict transition',
  );

  return {
    updated: perReporter.size,
    correct: correctCount,
    incorrect: incorrectCount,
  };
}

/**
 * Safe wrapper for fire-and-forget use from the verify pipeline.
 * Catches every error and logs at warn so a learning hiccup never
 * blocks verdict commits.
 */
export function recordVerdictTransitionSafe(claimId: string, oldVerdict: Verdict, newVerdict: Verdict): void {
  void (async () => {
    try {
      await recordVerdictTransition(claimId, oldVerdict, newVerdict);
    } catch (err) {
      logger.warn(
        {
          claimId,
          oldVerdict,
          newVerdict,
          error: (err as Error).message,
        },
        'feedback authority learning failed',
      );
    }
  })();
}
