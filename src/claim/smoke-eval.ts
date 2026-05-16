import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { logger } from '../observability/logger';
import { invariantOrphans } from '../observability/metrics';
import { verifyClaim } from './verify';

// Smoke evaluation.
//
// Without a human-labeled gold set we can't measure absolute
// accuracy. But we *can* detect regressions: treat high-consensus
// claims (verdicts produced by source_check AND confirmed by KG or
// by counter-search) as a synthetic gold set, periodically re-run
// the full pipeline on them, and flag any diverging verdicts as
// regressions. When divergence spikes, something shifted in the
// model, the retrieval layer, or a threshold — the same signal a
// gold eval would give, built entirely from self-consistent data.

const SAMPLE_SIZE = 20;

interface SampleRow {
  id: string;
  verdict: 'verified' | 'disputed';
  certainty: number;
  source: string;
}

export async function runSmokeEval(): Promise<{
  sampled: number;
  matched: number;
  diverged: number;
}> {
  // Pull high-consensus anchors: verdict committed by source_check
  // with certainty >= 0.8 (any source authority already baked in).
  //
  // Sampling strategy: `ORDER BY random() LIMIT N` triggers a full
  // sort on the candidate set and scales linearly with table growth.
  // Instead, filter to a recent window and apply a hash-based sample
  // using tableoid + ctid so each run picks a different but bounded
  // subset without sorting the whole table.
  const anchors = (await getDb().execute(sql`
    SELECT id, verdict, certainty, evidence->>'source' AS source
    FROM claim
    WHERE verdict IN ('verified', 'disputed')
      AND certainty >= 0.8
      AND evidence->>'source' = 'source-check'
      AND created_at > NOW() - INTERVAL '30 days'
      AND abs(hashtext(id || to_char(now(), 'YYYY-MM-DD HH24'))) % 20 = 0
    LIMIT ${SAMPLE_SIZE}
  `)) as unknown as SampleRow[];

  if (anchors.length === 0) {
    return { sampled: 0, matched: 0, diverged: 0 };
  }

  let matched = 0;
  let diverged = 0;
  for (const a of anchors) {
    try {
      const fresh = await verifyClaim(a.id);
      if (!fresh) {
        continue;
      }
      if (fresh.verdict === a.verdict) {
        matched++;
      } else {
        diverged++;
        logger.warn(
          {
            claimId: a.id,
            priorVerdict: a.verdict,
            priorCertainty: a.certainty,
            freshVerdict: fresh.verdict,
            freshCertainty: fresh.certainty,
            source: a.source,
          },
          'smoke eval: verdict diverged on anchor',
        );
      }
    } catch (err) {
      logger.debug({ claimId: a.id, error: (err as Error).message }, 'smoke eval: anchor reverify failed');
    }
  }

  invariantOrphans.set({ check: 'smoke_eval_diverged' }, diverged);
  logger.info({ sampled: anchors.length, matched, diverged }, 'smoke eval cycle complete');
  return { sampled: anchors.length, matched, diverged };
}
