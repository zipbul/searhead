import type { NliScores } from '../llm/nli';

import { Verdict } from '../score/enums';

// Bayesian belief aggregation over multiple sources.
//
// The previous max() rule treated source N's strong agreement the
// same as the lone first source's strong agreement — five
// independent expert pages saying the claim is true should be
// substantially more confident than a single one. Conversely, one
// noisy contradicting source should not flip a verdict that ten
// stronger sources support.
//
// Treat each (source NLI, source authority) as evidence updating a
// log-odds prior. Authority controls evidence weight; the NLI score
// determines direction. Independent groups (after dedup) carry full
// weight, redundant sources within a group are damped.

interface SourceEvidence {
  scores: NliScores;
  authority: number;
  /** Index of the independence group this source belongs to. */
  group: number;
}

interface AggregateResult {
  verdict: Verdict.Verified | Verdict.Disputed | Verdict.Unverified;
  certainty: number;
  /** Posterior probability that the claim is true. */
  posterior: number;
}

const PRIOR = 0.5;
const VERIFIED_THRESHOLD = 0.7;
const DISPUTED_THRESHOLD = 0.3;
// Damping for redundant sources inside the same independence group.
// First source in a group counts at full weight; each additional one
// counts at GROUP_DAMPING^k for k = 1, 2, ...
const GROUP_DAMPING = 0.4;

function logit(p: number): number {
  const eps = 1e-6;
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Aggregate per-source NLI scores into a single posterior +
 * verdict. Each source contributes a log-odds shift proportional
 * to (entailment - contradiction) × authority, damped by within-
 * group redundancy.
 *
 * Order-independent: within each independence group we sort by
 * authority descending so the highest-authority source gets full
 * weight and subsequent redundant sources decay from there. Without
 * this, caller iteration order determined which member of a group
 * carried the full-weight slot — [high, low] and [low, high] inputs
 * produced different posteriors on the same evidence (reproduced as
 * 0.97 vs 0.88 in testing).
 */
function aggregate(sources: SourceEvidence[]): AggregateResult {
  if (sources.length === 0) {
    return { verdict: Verdict.Unverified, certainty: 0, posterior: PRIOR };
  }

  // Bucket by group first, then within each bucket sort by authority
  // descending. This makes the full-weight slot deterministic.
  const buckets = new Map<number, SourceEvidence[]>();
  for (const s of sources) {
    const arr = buckets.get(s.group) ?? [];
    arr.push(s);
    buckets.set(s.group, arr);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => b.authority - a.authority);
  }

  let logOdds = logit(PRIOR);
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]!;
      const damping = Math.pow(GROUP_DAMPING, i);
      const net = s.scores.entailment - s.scores.contradiction;
      // 4× factor calibrates a single net=1, authority=1 source to
      // raise posterior from 0.5 → ~0.98, matching FEVER conventions.
      logOdds += net * s.authority * damping * 4;
    }
  }

  const posterior = sigmoid(logOdds);
  let verdict: AggregateResult['verdict'];
  let certainty: number;
  if (posterior >= VERIFIED_THRESHOLD) {
    verdict = Verdict.Verified;
    certainty = posterior;
  } else if (posterior <= DISPUTED_THRESHOLD) {
    verdict = Verdict.Disputed;
    certainty = 1 - posterior;
  } else {
    verdict = Verdict.Unverified;
    certainty = Math.max(posterior, 1 - posterior);
  }
  return { verdict, certainty, posterior };
}

export { aggregate };
export type { SourceEvidence };
