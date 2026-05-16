import { sql, eq, and, lt, or } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { claim } from '../db/schema';
import { logger } from '../observability/logger';
import { Verdict } from '../score/enums';
import { recordVerdictTransitionSafe } from './authority-learn';
import { verifyClaim } from './verify';

// Drift detector. A claim verified with confidence today can become
// disputed tomorrow if the underlying source changes (page edited,
// stronger NLI model loaded, KG accumulated a contradicting triple).
// Without periodic re-verification a stale `verified` lingers
// forever and the trust score `factuality` overstates reality.
//
// Strategy: walk verified/disputed claims whose last_drift_check_at is
// oldest (NULLS FIRST so newly-verified claims are checked once). We
// advance the timestamp at the END of each processed claim, so a
// repeatedly-failing claim no longer monopolizes the next cycle — it
// moves to the back of the queue and something else gets a turn.
//
// When the new verdict diverges:
//  - was verified, now disputed → demote to `disputed`
//  - was verified, now unverified → demote to `unverified`, halve old certainty
//  - was disputed, now verified → promote

const DRIFT_AGE_DAYS = 14;
const REVERIFY_BATCH = 5;

export async function detectDrift(batchSize = REVERIFY_BATCH): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_DAYS * 24 * 3600 * 1000);
  const now = new Date();

  // Selection priority (ORDER BY first key wins):
  //   1. claim.valid_until has elapsed — the extractor declared this
  //      claim has a known expiry, and we're past it. Highest-leverage
  //      reverify target: the world definitely entered a new state
  //      relative to when this claim was true.
  //   2. lastDriftCheckAt — oldest first, NULL first for claims never
  //      checked. Existing cycling behavior.
  //
  // Verified + disputed claims older than DRIFT_AGE_DAYS qualify
  // regardless of which priority axis picks them; the valid_until
  // gate also relaxes the age cutoff (an expired claim is worth
  // reverifying even if it was just stored — the extractor's
  // valid_until is a strong signal about the world's timeline,
  // not about how long Knoldr has held the row).
  const due = await getDb()
    .select({
      id: claim.id,
      verdict: claim.verdict,
      certainty: claim.certainty,
      statement: claim.statement,
      validUntil: claim.validUntil,
    })
    .from(claim)
    .where(
      and(
        sql`${claim.verdict} IN ('verified', 'disputed')`,
        // Either the claim is stale enough OR its declared validity
        // window has elapsed. The OR widens the candidate pool to
        // expired-validity claims that wouldn't have aged in yet.
        or(lt(claim.createdAt, cutoff), and(sql`${claim.validUntil} IS NOT NULL`, lt(claim.validUntil, now))!),
      ),
    )
    .orderBy(
      // Expired valid_until rows first (validity_expired bit = 1
      // outranks 0). Ties broken by oldest drift-check timestamp,
      // NULL first for never-checked rows.
      sql`CASE
            WHEN ${claim.validUntil} IS NOT NULL AND ${claim.validUntil} < NOW()
            THEN 0
            ELSE 1
          END`,
      sql`${claim.lastDriftCheckAt} NULLS FIRST`,
      claim.createdAt,
    )
    .limit(batchSize);

  let drifted = 0;
  for (const c of due) {
    try {
      const fresh = await verifyClaim(c.id);

      // ALWAYS stamp last_drift_check_at, even when fresh === null or
      // the verdict didn't change. This is the fix for "same 5 claims
      // forever": the timestamp moves every claim out of the front of
      // the queue regardless of outcome, and the NULLS-FIRST order
      // cycles through the rest of the verified pool.
      const nowTs = new Date();
      if (!fresh) {
        await getDb().update(claim).set({ lastDriftCheckAt: nowTs }).where(eq(claim.id, c.id));
        continue;
      }
      if (fresh.verdict === c.verdict) {
        await getDb().update(claim).set({ lastDriftCheckAt: nowTs }).where(eq(claim.id, c.id));
        continue;
      }

      const newCertainty = fresh.verdict === Verdict.Unverified ? c.certainty * 0.5 : fresh.certainty;
      // Drift moves the verdict; authority must follow so a claim
      // that just lost its 'verified' status doesn't keep ranking
      // as a high-authority retrieval candidate. We resync to the
      // fresh certainty floor — feedback-driven authority moves
      // re-accumulate from the new floor as before.
      await getDb()
        .update(claim)
        .set({
          verdict: fresh.verdict,
          certainty: newCertainty,
          authority: newCertainty,
          evidence: { ...fresh.evidence, drifted_from: c.verdict },
          lastDriftCheckAt: nowTs,
        })
        .where(eq(claim.id, c.id));
      drifted++;
      // Drift is the highest-signal verdict transition for feedback
      // learning — by definition the world (or the model) moved
      // since the original verdict. Fire the same authority hook
      // the live verify pipeline uses so reporters who anticipated
      // this drift get credit and those who got it wrong lose it.
      recordVerdictTransitionSafe(c.id, c.verdict as Verdict, fresh.verdict);
      logger.info(
        {
          claimId: c.id,
          old: c.verdict,
          new: fresh.verdict,
          newCertainty,
          statement: c.statement.slice(0, 80),
        },
        'claim drift detected',
      );
    } catch (err) {
      logger.warn({ claimId: c.id, error: (err as Error).message }, 'drift reverify failed');
      // Still stamp the timestamp so a permanently-failing claim stops
      // monopolizing the batch. Retry will cycle back around naturally.
      try {
        await getDb().update(claim).set({ lastDriftCheckAt: new Date() }).where(eq(claim.id, c.id));
      } catch {
        /* best-effort */
      }
    }
  }

  if (drifted > 0) {
    logger.info({ drifted, batchSize }, 'drift batch processed');
  }
  return drifted;
}
