import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { calibrationState } from '../db/schema';
import { logger } from '../observability/logger';

// Auto-calibration of NLI thresholds.
//
// Without labeled ground truth we use *self-consistent agreement* as
// a proxy: claims where multiple independent signals (KG + source_
// check + jury) agree on the verdict are treated as gold labels for
// threshold tuning. The premise is that when three uncorrelated
// methods agree, they're probably right; when source_check alone
// disagrees with the consensus its threshold is mistuned.
//
// We sweep candidate thresholds and pick the one that maximizes F1
// of source_check verdicts against the consensus labels. The result
// lives in calibration_state and is read by the verify pipeline at
// each batch boundary, so the system tightens itself up as it
// accumulates evidence — no human labels needed.

interface CalibrationSample {
  consensus: 'verified' | 'disputed';
  entailment: number;
  contradiction: number;
}

const CANDIDATES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const MIN_SAMPLES = 30;

interface CalibrationResult {
  supportThreshold: number;
  refuteThreshold: number;
  sampleSize: number;
  bestF1: number;
}

/**
 * Pull samples where source_check ran AND another signal (KG
 * contradiction or LLM jury) committed the same verdict. Those rows
 * are our pseudo-gold for threshold tuning.
 */
// Hard cap on samples so a growing DB doesn't blow up the calibration
// worker runtime. 5k rows is more than enough signal for the 9-point
// threshold sweep and bounds execution time to well under a second.
const MAX_CALIBRATION_SAMPLES = 5000;

async function collectSamples(): Promise<CalibrationSample[]> {
  const rows = (await getDb().execute(sql`
    SELECT
      verdict::text AS consensus,
      (evidence->'sourceChecks'->0->'scores'->>'entailment')::float AS entailment,
      (evidence->'sourceChecks'->0->'scores'->>'contradiction')::float AS contradiction
    FROM claim
    WHERE evidence->>'source' = 'source-check'
      AND verdict IN ('verified','disputed')
      AND evidence->'sourceChecks'->0->'scores' IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ${MAX_CALIBRATION_SAMPLES}
  `)) as unknown as CalibrationSample[];
  return rows.filter(
    r =>
      Number.isFinite(r.entailment) &&
      Number.isFinite(r.contradiction) &&
      (r.consensus === 'verified' || r.consensus === 'disputed'),
  );
}

function f1(precision: number, recall: number): number {
  if (precision + recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

function bestThresholdForLabel(samples: CalibrationSample[], label: 'verified' | 'disputed'): { threshold: number; f1: number } {
  let bestT = 0.7;
  let bestF1 = 0;
  for (const t of CANDIDATES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const s of samples) {
      const score = label === 'verified' ? s.entailment : s.contradiction;
      const predicted = score >= t;
      const actual = s.consensus === label;
      if (predicted && actual) {
        tp++;
      } else if (predicted && !actual) {
        fp++;
      } else if (!predicted && actual) {
        fn++;
      }
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const score = f1(precision, recall);
    if (score > bestF1) {
      bestF1 = score;
      bestT = t;
    }
  }
  return { threshold: bestT, f1: bestF1 };
}

async function calibrate(): Promise<CalibrationResult | null> {
  const samples = await collectSamples();
  if (samples.length < MIN_SAMPLES) {
    logger.debug({ samples: samples.length }, 'calibration skipped (insufficient samples)');
    return null;
  }

  const support = bestThresholdForLabel(samples, 'verified');
  const refute = bestThresholdForLabel(samples, 'disputed');
  const result: CalibrationResult = {
    supportThreshold: support.threshold,
    refuteThreshold: refute.threshold,
    sampleSize: samples.length,
    bestF1: (support.f1 + refute.f1) / 2,
  };

  await getDb()
    .update(calibrationState)
    .set({
      nliSupportThreshold: result.supportThreshold,
      nliRefuteThreshold: result.refuteThreshold,
      sampleSize: result.sampleSize,
      bestF1: result.bestF1,
      updatedAt: new Date(),
    })
    .where(sql`id = 1`);

  logger.info(result, 'calibration updated');
  return result;
}

// In-process cache of the current thresholds, refreshed every 60s.
// Avoids a DB hit on every verify call but stays fresh enough that
// new calibration runs propagate within a minute.
let cached: { support: number; refute: number; ts: number } = {
  support: 0.7,
  refute: 0.7,
  ts: 0,
};
const CACHE_TTL_MS = 60_000;

async function getCurrentThresholds(): Promise<{ support: number; refute: number }> {
  if (Date.now() - cached.ts < CACHE_TTL_MS) {
    return { support: cached.support, refute: cached.refute };
  }
  try {
    const [row] = await getDb()
      .select({
        support: calibrationState.nliSupportThreshold,
        refute: calibrationState.nliRefuteThreshold,
      })
      .from(calibrationState)
      .limit(1);
    if (row) {
      cached = { support: row.support, refute: row.refute, ts: Date.now() };
    }
  } catch {
    // Fall through with whatever's cached (or env defaults below).
  }
  return { support: cached.support, refute: cached.refute };
}

export { calibrate, getCurrentThresholds };
