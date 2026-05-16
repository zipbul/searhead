// Single source of truth for the claim_feedback evidence strength
// heuristic. Both the A2A `claim_feedback` handler (insert + update
// paths) and the FQA background enrichment call this — the previous
// duplicated copies could drift if either side was tweaked alone.
//
// Direct (reporter-supplied) fields weigh more than inferred (FQA
// LLM-derived) fields. Empty input lands at 0.1 base; fully-
// substantiated input lands near 1.0. Calibration can move the
// weights later once a labelled corpus exists.

interface StrengthInputs {
  counterSourceUrl?: string | null;
  counterSourceUrlInferred?: string | null;
  counterNliScore?: number | null;
  failureDimension?: string | null;
  failureDimensionInferred?: string | null;
  contextDomain?: string | null;
  contextScope?: Record<string, unknown> | null;
  partialTruth?: number | null;
  partialTruthInferred?: number | null;
}

/**
 * Score in [0,1]. Direct values *mask* inferred values for the same
 * field — a row that has a reporter-supplied counterSourceUrl
 * gets the 0.3 weight; one that only has the LLM-inferred URL gets
 * 0.15; one with both still gets only 0.3 (no double-credit).
 */
export function computeFeedbackEvidenceStrength(row: StrengthInputs): number {
  let s = 0.1;

  if (row.counterSourceUrl) {
    s += 0.3;
  } else if (row.counterSourceUrlInferred) {
    s += 0.15;
  }

  if (row.counterNliScore !== undefined && row.counterNliScore !== null && row.counterNliScore >= 0.7) {
    s += 0.2;
  }

  if (row.failureDimension) {
    s += 0.2;
  } else if (row.failureDimensionInferred) {
    s += 0.1;
  }

  if (row.contextDomain || row.contextScope) {
    s += 0.1;
  }

  const hasDirectPt = row.partialTruth !== undefined && row.partialTruth !== null;
  const hasInferredPt = row.partialTruthInferred !== undefined && row.partialTruthInferred !== null;
  if (hasDirectPt) {
    s += 0.1;
  } else if (hasInferredPt) {
    s += 0.05;
  }

  if (s > 1) {
    s = 1;
  }
  return Number(s.toFixed(3));
}
