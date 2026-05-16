// Shared enum constants for claim_feedback. Lives in its own module
// to break the import cycle:
//   src/a2a/handlers/claim-feedback.ts → src/fqa/queue.ts →
//   src/fqa/enrich.ts → src/fqa/enrichment-llm.ts →
//   (used to import FAILURE_DIMENSIONS from claim-feedback) → cycle.
// All four enums match the CHECK constraints on the claim_feedback
// table — keep them in lockstep when schema changes.

export const APPLICATION_METHODS = [
  "verified",
  "applied",
  "cited",
  "reasoned_over",
] as const;
export type ApplicationMethod = (typeof APPLICATION_METHODS)[number];

export const OUTCOMES = ["held", "failed", "partial"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const FAILURE_DIMENSIONS = [
  "fully_false",
  "scope_too_broad",
  "time_expired",
  "modality_too_strong",
  "context_mismatch",
  "partially_correct",
] as const;
export type FailureDimension = (typeof FAILURE_DIMENSIONS)[number];
