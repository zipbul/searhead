// Single source of truth for every domain enum in Knoldr.
//
// Convention: PascalCase member names, kebab-case string values.
// Reasons:
//   - PascalCase keys make enum access readable in TS
//     (Verdict.NotApplicable vs "not_applicable")
//   - kebab-case values are URL-/CLI-/JSON-friendly and play nicely
//     across language boundaries (Python finetune, A2A JSON-RPC)
//   - One file = one place to verify when a new value is added
//     anywhere in the system (DB CHECK, prompt, API doc, etc.)
//
// Every CHECK constraint in src/db/schema.ts and src/db/migrate.ts
// uses these *string values* verbatim. A migration in migrate.ts
// also UPDATEs any existing rows that still carry the previous
// snake_case values so the kebab transition is one-shot.

// ============================================================
// claim
// ============================================================

export enum Verdict {
  Verified = 'verified',
  Disputed = 'disputed',
  Unverified = 'unverified',
  NotApplicable = 'not-applicable',
}

export enum ClaimType {
  Factual = 'factual',
  Subjective = 'subjective',
  Predictive = 'predictive',
  Normative = 'normative',
}

export enum Modality {
  Asserted = 'asserted',
  Hedged = 'hedged',
  Possible = 'possible',
  Conditional = 'conditional',
  Quoted = 'quoted',
}

export enum Quantifier {
  Universal = 'universal',
  Existential = 'existential',
  Majority = 'majority',
  Minority = 'minority',
  Specific = 'specific',
  None = 'none',
}

// ============================================================
// claim_relation
// ============================================================

export enum RelationType {
  Supports = 'supports',
  Contradicts = 'contradicts',
  DerivesFrom = 'derives-from',
  SupersededBy = 'superseded-by',
  Refines = 'refines',
}

// ============================================================
// verdict_log
// ============================================================

export enum VerdictTrigger {
  Auto = 'auto',
  Feedback = 'feedback',
  Drift = 'drift',
  Reverify = 'reverify',
  Cove = 'cove',
  Manual = 'manual',
}

// ============================================================
// verify pipeline — evidence.source on VerifyResult.evidence
// ============================================================

export enum EvidenceSource {
  DbCrossRef = 'db-cross-ref',
  KgContradiction = 'kg-contradiction',
  SourceCheck = 'source-check',
  Cove = 'cove',
  ExhaustedPipeline = 'exhausted-pipeline',
  ExceptionFinalize = 'exception-finalize',
}

// ============================================================
// claim_feedback
// ============================================================

export enum ApplicationMethod {
  Verified = 'verified',
  Applied = 'applied',
  Cited = 'cited',
  ReasonedOver = 'reasoned-over',
}

export enum Outcome {
  Held = 'held',
  Failed = 'failed',
  Partial = 'partial',
}

export enum FailureDimension {
  FullyFalse = 'fully-false',
  ScopeTooBroad = 'scope-too-broad',
  TimeExpired = 'time-expired',
  ModalityTooStrong = 'modality-too-strong',
  ContextMismatch = 'context-mismatch',
  PartiallyCorrect = 'partially-correct',
}

export enum EnrichmentStatus {
  Pending = 'pending',
  FinalizedInferred = 'finalized-inferred',
  AwaitingPull = 'awaiting-pull',
  Enriched = 'enriched',
  ExpiredReporterUnavailable = 'expired-reporter-unavailable',
  SkippedBackpressure = 'skipped-backpressure',
  NotNeeded = 'not-needed',
}

// ============================================================
// entry-level feedback (legacy v0.3)
// ============================================================

export enum Signal {
  Positive = 'positive',
  Negative = 'negative',
}

export enum FeedbackReason {
  Used = 'used',
  Helpful = 'helpful',
  Wrong = 'wrong',
  Outdated = 'outdated',
  Missing = 'missing',
  Irrelevant = 'irrelevant',
  Other = 'other',
}

// ============================================================
// entry
// ============================================================

export enum EntryStatus {
  Draft = 'draft',
  Active = 'active',
}

export enum SourceType {
  OfficialDocs = 'official-docs',
  GithubRelease = 'github-release',
  CveDb = 'cve-db',
  OfficialBlog = 'official-blog',
  ResearchPaper = 'research-paper',
  EstablishedBlog = 'established-blog',
  CommunityForum = 'community-forum',
  PersonalBlog = 'personal-blog',
  AiGenerated = 'ai-generated',
  ReferenceWiki = 'reference-wiki',
  Unknown = 'unknown',
}

// ============================================================
// ingest_log
// ============================================================

export enum IngestAction {
  Stored = 'stored',
  Duplicate = 'duplicate',
  Rejected = 'rejected',
}

// ============================================================
// entry_score.dimension
// ============================================================

export enum EntryScoreDimension {
  Factuality = 'factuality',
  Novelty = 'novelty',
  Actionability = 'actionability',
  Signal = 'signal',
}

// ============================================================
// search/explore
// ============================================================

export enum TrustLevel {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export enum SortBy {
  Authority = 'authority',
  CreatedAt = 'created-at',
}

// ============================================================
// Utilities
// ============================================================

/**
 * Get a tuple of string values from a TS string-valued enum.
 * Useful for `z.enum(values(MyEnum) as [...])` patterns and for
 * checking "is this string a valid enum value" without iterating
 * the enum object directly.
 */
export function enumValues<T extends Record<string, string>>(e: T): readonly T[keyof T][] {
  return Object.values(e) as T[keyof T][];
}
