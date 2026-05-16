import { sql } from 'drizzle-orm';
// `customType` lives in the same `drizzle-orm/pg-core` namespace as the
// rest of the column builders; merging the imports keeps the no-duplicates
// rule happy. The custom pgvector type sits below because drizzle has no
// built-in vector column — we encode it via a sql template.
import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
  customType,
} from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return 'vector(384)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: unknown): number[] {
    const str = String(value);
    return str.slice(1, -1).split(',').map(Number);
  },
});

// ============================================================
// entry — Core data table (partitioned by created_at)
// ============================================================
// NOTE: Partitioning (PARTITION BY RANGE) is not supported by drizzle-orm schema.
// We define the logical schema here; partitioning + partition tables are created
// via raw SQL in the migration script (src/db/migrate.ts).
export const entry = pgTable(
  'entry',
  {
    id: text('id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    language: text('language').notNull().default('en'),
    metadata: jsonb('metadata'),
    authority: doublePrecision('authority').notNull().default(0.0),
    decayRate: doublePrecision('decay_rate').notNull().default(0.01),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    embedding: vector('embedding').notNull(),
  },
  t => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    check('entry_title_len', sql`length(${t.title}) <= 500`),
    check('entry_content_len', sql`length(${t.content}) <= 50000`),
    check('entry_authority_range', sql`${t.authority} >= 0 AND ${t.authority} <= 1`),
    check('entry_decay_rate_range', sql`${t.decayRate} >= 0 AND ${t.decayRate} <= 1`),
    check('entry_status_values', sql`${t.status} IN ('draft', 'active')`),
    check('entry_metadata_size', sql`pg_column_size(${t.metadata}) <= 1048576`),
    // pgroonga FTS index + HNSW embedding index — created via raw SQL in
    // migration (drizzle doesn't support pgroonga / hnsw opclasses).
    index('idx_entry_status').on(t.status),
    index('idx_entry_authority').on(t.authority.desc()),
    index('idx_entry_language').on(t.language),
    index('idx_entry_created_at').on(t.createdAt.desc()),
  ],
);

// ============================================================
// entry_domain — M:N domain tags
// ============================================================
export const entryDomain = pgTable(
  'entry_domain',
  {
    entryId: text('entry_id').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }).notNull(),
    domain: text('domain').notNull(),
  },
  t => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.domain] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete('cascade'),
    check('entry_domain_len', sql`length(${t.domain}) <= 50`),
    index('idx_entry_domain_domain').on(t.domain),
  ],
);

// ============================================================
// entry_tag — M:N tags
// ============================================================
export const entryTag = pgTable(
  'entry_tag',
  {
    entryId: text('entry_id').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }).notNull(),
    tag: text('tag').notNull(),
  },
  t => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.tag] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete('cascade'),
    check('entry_tag_len', sql`length(${t.tag}) <= 50`),
    index('idx_entry_tag_tag').on(t.tag),
  ],
);

// ============================================================
// entry_source — M:N sources (normalized, not JSONB)
// ============================================================
export const entrySource = pgTable(
  'entry_source',
  {
    entryId: text('entry_id').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }).notNull(),
    url: text('url').notNull(),
    sourceType: text('source_type').notNull(),
    trust: doublePrecision('trust').notNull().default(0.0),
  },
  t => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.url] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete('cascade'),
    check('entry_source_trust_range', sql`${t.trust} >= 0 AND ${t.trust} <= 1`),
    check(
      'entry_source_source_type_values',
      sql`${t.sourceType} IN ('official-docs','github-release','cve-db','official-blog','research-paper','established-blog','community-forum','personal-blog','ai-generated','reference-wiki','unknown')`,
    ),
    index('idx_entry_source_type').on(t.sourceType),
  ],
);

// ============================================================
// ingest_log — Ingestion audit trail + URL dedup
// ============================================================
export const ingestLog = pgTable(
  'ingest_log',
  {
    id: text('id').primaryKey(),
    urlHash: text('url_hash'),
    entryId: text('entry_id'),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }),
    action: text('action').notNull(),
    reason: text('reason'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check('ingest_log_action_values', sql`${t.action} IN ('stored', 'duplicate', 'rejected')`),
    uniqueIndex('idx_ingest_log_url_hash')
      .on(t.urlHash)
      .where(sql`${t.urlHash} IS NOT NULL`),
    index('idx_ingest_log_ingested_at').on(t.ingestedAt.desc()),
  ],
);

// ============================================================
// feedback_log — Feedback audit trail
// ============================================================
export const feedbackLog = pgTable(
  'feedback_log',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }).notNull(),
    signal: text('signal').notNull(),
    reason: text('reason'),
    agentId: text('agent_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete('cascade'),
    check('feedback_log_signal_values', sql`${t.signal} IN ('positive', 'negative')`),
    index('idx_feedback_log_entry').on(t.entryId, t.createdAt.desc()),
    index('idx_feedback_log_agent_entry').on(t.agentId, t.entryId, t.createdAt.desc()),
  ],
);

// ============================================================
// retry_queue — Failed ingestion retry
// ============================================================
export const retryQueue = pgTable(
  'retry_queue',
  {
    id: text('id').primaryKey(),
    rawContent: text('raw_content').notNull(),
    sourceUrl: text('source_url'),
    errorReason: text('error_reason'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('idx_retry_queue_next')
      .on(t.nextRetryAt)
      .where(sql`${t.attempts} < 3`),
  ],
);

// ============================================================
// claim — Atomic assertions extracted from entries (v0.3)
// ============================================================
// Each Entry may produce N claims; each claim is a single-fact proposition
// classified by epistemic type (factual/subjective/predictive/normative) and,
// for factual claims, verified by Pyreez deliberation into a verdict +
// certainty. Claim embeddings enable claim-level semantic retrieval and the
// db_cross_ref verification step.
//
// Verifiability columns (source_span..valid_until) are nullable on existing
// rows for backwards compatibility; new extraction code is expected to fill
// them. Enforcement (NOT NULL) flips on after extraction is updated and a
// backfill pass completes.
export const claim = pgTable(
  'claim',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }).notNull(),
    statement: text('statement').notNull(),
    type: text('type').notNull(),
    verdict: text('verdict').notNull().default('unverified'),
    // Verifier's calibrated confidence in the verdict. Set by the
    // verify pipeline; never moved by feedback.
    certainty: doublePrecision('certainty').notNull().default(0.0),
    // Mutable trust score. Initialized to `certainty` on insert,
    // then adjusted by claim_feedback (weighted by reporter
    // authority × evidence_strength). Search ranking and FQA
    // priority gates read this — never `certainty`.
    authority: doublePrecision('authority').notNull().default(0.0),
    evidence: jsonb('evidence'),
    embedding: vector('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastDriftCheckAt: timestamp('last_drift_check_at', { withTimezone: true }),
    // Verbatim source span the claim was extracted from. Source-entailment
    // NLI gate (next phase) checks that NLI(source_span, statement) is
    // entailment before persistence.
    sourceSpan: text('source_span'),
    sourceUrl: text('source_url'),
    // Distortion-prevention fields preserved at decomposition time.
    modality: text('modality'),
    polarity: integer('polarity'),
    quantifier: text('quantifier'),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
  },
  t => [
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete('cascade'),
    check('claim_type_values', sql`${t.type} IN ('factual', 'subjective', 'predictive', 'normative')`),
    check('claim_verdict_values', sql`${t.verdict} IN ('verified', 'disputed', 'unverified', 'not-applicable')`),
    check('claim_certainty_range', sql`${t.certainty} >= 0 AND ${t.certainty} <= 1`),
    check('claim_authority_range', sql`${t.authority} >= 0 AND ${t.authority} <= 1`),
    check('claim_statement_len', sql`length(${t.statement}) <= 2000`),
    check('claim_source_span_len', sql`${t.sourceSpan} IS NULL OR length(${t.sourceSpan}) <= 4000`),
    check('claim_source_url_len', sql`${t.sourceUrl} IS NULL OR length(${t.sourceUrl}) <= 2000`),
    check(
      'claim_modality_values',
      sql`${t.modality} IS NULL OR ${t.modality} IN ('asserted','hedged','possible','conditional','quoted')`,
    ),
    check('claim_polarity_values', sql`${t.polarity} IS NULL OR ${t.polarity} IN (0, 1)`),
    check(
      'claim_quantifier_values',
      sql`${t.quantifier} IS NULL OR ${t.quantifier} IN ('universal','existential','majority','minority','specific','none')`,
    ),
    check('claim_valid_range', sql`${t.validFrom} IS NULL OR ${t.validUntil} IS NULL OR ${t.validFrom} <= ${t.validUntil}`),
    index('idx_claim_entry').on(t.entryId, t.entryCreatedAt),
    index('idx_claim_type_verdict').on(t.type, t.verdict),
    // pgvector hnsw index created via raw SQL in migration.
  ],
);

// ============================================================
// verdict_log — Append-only audit of every verdict assignment.
// claim.verdict / claim.certainty hold the latest value for fast
// querying; verdict_log preserves the full history with the model
// version that produced each verdict and the trigger ('auto' from a
// scheduled verify, 'feedback' from agent re-verify, 'drift' from
// the periodic re-check). History never overwrites — it only inserts.
// ============================================================
export const verdictLog = pgTable(
  'verdict_log',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    verdict: text('verdict').notNull(),
    certainty: doublePrecision('certainty').notNull(),
    evidenceSource: text('evidence_source'),
    grounderModel: text('grounder_model'),
    trigger: text('trigger').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    foreignKey({
      columns: [t.claimId],
      foreignColumns: [claim.id],
    }).onDelete('cascade'),
    check('verdict_log_verdict_values', sql`${t.verdict} IN ('verified', 'disputed', 'unverified', 'not-applicable')`),
    check('verdict_log_certainty_range', sql`${t.certainty} >= 0 AND ${t.certainty} <= 1`),
    check('verdict_log_trigger_values', sql`${t.trigger} IN ('auto', 'feedback', 'drift', 'reverify', 'cove', 'manual')`),
    index('idx_verdict_log_claim').on(t.claimId, t.createdAt.desc()),
    index('idx_verdict_log_created').on(t.createdAt.desc()),
  ],
);

// ============================================================
// verify_queue — Factual claims awaiting Pyreez verification
// ============================================================
export const verifyQueue = pgTable(
  'verify_queue',
  {
    claimId: text('claim_id').primaryKey(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    foreignKey({
      columns: [t.claimId],
      foreignColumns: [claim.id],
    }).onDelete('cascade'),
    index('idx_verify_queue_next')
      .on(t.priority.desc(), t.nextAttemptAt)
      .where(sql`${t.attempts} < 3`),
  ],
);

// ============================================================
// entity — Knowledge Graph nodes (v0.4)
// ============================================================
export const entity = pgTable(
  'entity',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    metadata: jsonb('metadata'),
    embedding: vector('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check('entity_name_len', sql`length(${t.name}) <= 200`),
    check('entity_type_len', sql`length(${t.type}) <= 50`),
    index('idx_entity_name').on(t.name),
    index('idx_entity_type').on(t.type),
    // Case-insensitive UNIQUE on (type, name) — prevents race-condition
    // duplicates when two workers upsert the same entity concurrently.
    // Functional index on lower(name); created via raw SQL in migration
    // because drizzle doesn't support expression indexes here.
  ],
);

// ============================================================
// kg_relation — Knowledge Graph edges (v0.4)
// ============================================================
export const kgRelation = pgTable(
  'kg_relation',
  {
    id: text('id').primaryKey(),
    sourceEntityId: text('source_entity_id').notNull(),
    targetEntityId: text('target_entity_id').notNull(),
    relationType: text('relation_type').notNull(),
    claimId: text('claim_id'),
    weight: doublePrecision('weight').notNull().default(1.0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    foreignKey({
      columns: [t.sourceEntityId],
      foreignColumns: [entity.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.targetEntityId],
      foreignColumns: [entity.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.claimId],
      foreignColumns: [claim.id],
    }).onDelete('set null'),
    check('kg_relation_weight_range', sql`${t.weight} >= 0 AND ${t.weight} <= 1`),
    check('kg_relation_no_self_loop', sql`${t.sourceEntityId} <> ${t.targetEntityId}`),
    uniqueIndex('uniq_kg_relation_edge').on(t.sourceEntityId, t.targetEntityId, t.relationType, t.claimId),
    index('idx_kg_relation_source').on(t.sourceEntityId),
    index('idx_kg_relation_target').on(t.targetEntityId),
  ],
);

// ============================================================
// claim_relation — Typed edges between claims (v0.4).
// Distinct from kg_relation (entity↔entity). This is the substrate
// for: contradiction surfacing, supporting-evidence walks, derives-from
// provenance, superseded-by (world changed), and refines (partial-truth
// correction yields a scoped replacement). Append-only — corrections
// to facts always create a new claim + a new edge, never mutate.
//
// metadata is free-form JSONB for relation-specific provenance:
//   { nli_score, feedback_id, verifier_version, ... }
// ============================================================
export const claimRelation = pgTable(
  'claim_relation',
  {
    id: text('id').primaryKey(),
    sourceClaimId: text('source_claim_id').notNull(),
    targetClaimId: text('target_claim_id').notNull(),
    relationType: text('relation_type').notNull(),
    weight: doublePrecision('weight').notNull().default(1.0),
    createdBy: text('created_by').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    foreignKey({
      columns: [t.sourceClaimId],
      foreignColumns: [claim.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.targetClaimId],
      foreignColumns: [claim.id],
    }).onDelete('cascade'),
    check(
      'claim_relation_type_values',
      sql`${t.relationType} IN ('supports','contradicts','derives-from','superseded-by','refines')`,
    ),
    check('claim_relation_weight_range', sql`${t.weight} >= 0 AND ${t.weight} <= 1`),
    check('claim_relation_no_self_loop', sql`${t.sourceClaimId} <> ${t.targetClaimId}`),
    uniqueIndex('uniq_claim_relation_edge').on(t.sourceClaimId, t.targetClaimId, t.relationType),
    index('idx_claim_relation_source').on(t.sourceClaimId, t.relationType),
    index('idx_claim_relation_target').on(t.targetClaimId, t.relationType),
    index('idx_claim_relation_type').on(t.relationType),
  ],
);

// ============================================================
// entry_score — Derived dimensions per entry (v0.3)
// ============================================================
// Composite PK (entry_id, entry_created_at, dimension). Partition-aware FK
// to entry.  `dimension` is an enumerable string for forward compatibility
// (v0.4 adds novelty/actionability/signal).
export const entryScore = pgTable(
  'entry_score',
  {
    entryId: text('entry_id').notNull(),
    entryCreatedAt: timestamp('entry_created_at', { withTimezone: true }).notNull(),
    dimension: text('dimension').notNull(),
    value: doublePrecision('value').notNull(),
    scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
    scoredBy: text('scored_by').notNull().default('system'),
  },
  t => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.dimension] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete('cascade'),
    check('entry_score_dimension_values', sql`${t.dimension} IN ('factuality', 'novelty', 'actionability', 'signal')`),
    check('entry_score_value_range', sql`${t.value} >= 0 AND ${t.value} <= 1`),
    index('idx_entry_score_dimension').on(t.dimension, t.value),
  ],
);

// ============================================================
// calibration_state — Auto-tuned NLI thresholds (v0.5)
// Single-row table. Verify pipeline reads on each batch start.
// ============================================================
export const calibrationState = pgTable('calibration_state', {
  id: integer('id').primaryKey().default(1),
  nliSupportThreshold: doublePrecision('nli_support_threshold').notNull().default(0.7),
  nliRefuteThreshold: doublePrecision('nli_refute_threshold').notNull().default(0.7),
  sampleSize: integer('sample_size').notNull().default(0),
  bestF1: doublePrecision('best_f1').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// golden_set_claim — Human-labelled claims for verdict regression measurement.
// Each row is a known-answer probe sent through the verify pipeline by
// runGoldenEval; the pipeline's verdict is compared against expected_verdict
// to compute precision / recall / F1. Without this corpus all downstream
// pipeline changes ship blind.
// ============================================================
export const goldenSetClaim = pgTable(
  'golden_set_claim',
  {
    id: text('id').primaryKey(),
    statement: text('statement').notNull(),
    claimType: text('claim_type').notNull(),
    expectedVerdict: text('expected_verdict').notNull(),
    domain: text('domain'),
    sourceHint: text('source_hint'),
    // Source URLs the eval harness injects into the temp entry's
    // entry_source rows so the verifier's source_check branch fires
    // exactly as it would in production. Without this the harness
    // exercises only the LLM-jury / KG / CoVe paths and the dominant
    // production path is untested.
    sourceUrls: jsonb('source_urls'),
    labeledBy: text('labeled_by').notNull(),
    labeledAt: timestamp('labeled_at', { withTimezone: true }).notNull().defaultNow(),
    notes: text('notes'),
    active: integer('active').notNull().default(1),
  },
  t => [
    check('golden_set_statement_len', sql`length(${t.statement}) <= 2000`),
    check('golden_set_claim_type_values', sql`${t.claimType} IN ('factual', 'subjective', 'predictive', 'normative')`),
    check(
      'golden_set_expected_verdict_values',
      sql`${t.expectedVerdict} IN ('verified', 'disputed', 'unverified', 'not-applicable')`,
    ),
    check('golden_set_active_values', sql`${t.active} IN (0, 1)`),
    index('idx_golden_set_domain').on(t.domain),
    index('idx_golden_set_active').on(t.active),
  ],
);

// ============================================================
// golden_set_run — One row per evaluation pass. Stores overall scalars
// plus per-verdict / per-type breakdown as JSONB so the harness can
// surface regressions without re-parsing raw outcomes.
// ============================================================
export const goldenSetRun = pgTable(
  'golden_set_run',
  {
    id: text('id').primaryKey(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    commitSha: text('commit_sha'),
    modelVersions: jsonb('model_versions'),
    total: integer('total').notNull(),
    correct: integer('correct').notNull(),
    precisionOverall: doublePrecision('precision_overall').notNull(),
    recallOverall: doublePrecision('recall_overall').notNull(),
    f1Overall: doublePrecision('f1_overall').notNull(),
    metrics: jsonb('metrics').notNull(),
    baselineRunId: text('baseline_run_id'),
    regressed: integer('regressed'),
  },
  t => [
    check('golden_set_run_total_nonneg', sql`${t.total} >= 0`),
    check('golden_set_run_correct_range', sql`${t.correct} >= 0 AND ${t.correct} <= ${t.total}`),
    check('golden_set_run_precision_range', sql`${t.precisionOverall} >= 0 AND ${t.precisionOverall} <= 1`),
    check('golden_set_run_recall_range', sql`${t.recallOverall} >= 0 AND ${t.recallOverall} <= 1`),
    check('golden_set_run_f1_range', sql`${t.f1Overall} >= 0 AND ${t.f1Overall} <= 1`),
    check('golden_set_run_regressed_values', sql`${t.regressed} IS NULL OR ${t.regressed} IN (0, 1)`),
    index('idx_golden_set_run_ran_at').on(t.ranAt.desc()),
  ],
);

// ============================================================
// claim_feedback — Claim-level structured feedback (v0.4 design).
// Distinct from the entry-level feedback_log which stays for
// authority signals on Entry objects. claim_feedback drives
// claim authority + verdict transitions via the (eventual) FQA
// enrichment pipeline. Append-only; the claim itself is never
// mutated by feedback.
// ============================================================
export const claimFeedback = pgTable(
  'claim_feedback',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    reporterAgentId: text('reporter_agent_id').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),

    applicationMethod: text('application_method').notNull(),
    outcome: text('outcome').notNull(),

    // Direct fields — provided by the reporting agent at submit time.
    failureDimension: text('failure_dimension'),
    partialTruth: doublePrecision('partial_truth'),
    contextDomain: text('context_domain'),
    contextTimeFrom: timestamp('context_time_from', { withTimezone: true }),
    contextTimeUntil: timestamp('context_time_until', { withTimezone: true }),
    contextScope: jsonb('context_scope'),
    counterSourceUrl: text('counter_source_url'),
    counterClaimText: text('counter_claim_text'),
    counterNliScore: doublePrecision('counter_nli_score'),
    auditNote: text('audit_note'),

    // FQA-inferred fields — populated by the feedback quality agent from
    // audit_note free text. Kept separate from direct fields; weighted
    // lower in evidence_strength calculation.
    failureDimensionInferred: text('failure_dimension_inferred'),
    partialTruthInferred: doublePrecision('partial_truth_inferred'),
    counterSourceUrlInferred: text('counter_source_url_inferred'),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    enrichedBy: text('enriched_by'),
    enrichmentLlmVersion: text('enrichment_llm_version'),
    reporterResponded: integer('reporter_responded'),
    enrichmentStatus: text('enrichment_status').notNull().default('pending'),

    // Computed and maintained by the feedback pipeline; combined with
    // agent_feedback_authority.feedback_authority to weight authority
    // updates on the referenced claim.
    evidenceStrength: doublePrecision('evidence_strength').notNull().default(0.0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    foreignKey({
      columns: [t.claimId],
      foreignColumns: [claim.id],
    }).onDelete('cascade'),
    check(
      'claim_feedback_application_method_values',
      sql`${t.applicationMethod} IN ('verified','applied','cited','reasoned-over')`,
    ),
    check('claim_feedback_outcome_values', sql`${t.outcome} IN ('held','failed','partial')`),
    check(
      'claim_feedback_failure_dimension_values',
      sql`${t.failureDimension} IS NULL OR ${t.failureDimension} IN ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct')`,
    ),
    check(
      'claim_feedback_failure_dimension_inferred_values',
      sql`${t.failureDimensionInferred} IS NULL OR ${t.failureDimensionInferred} IN ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct')`,
    ),
    check(
      'claim_feedback_partial_truth_range',
      sql`${t.partialTruth} IS NULL OR (${t.partialTruth} >= 0 AND ${t.partialTruth} <= 1)`,
    ),
    check(
      'claim_feedback_partial_truth_inferred_range',
      sql`${t.partialTruthInferred} IS NULL OR (${t.partialTruthInferred} >= 0 AND ${t.partialTruthInferred} <= 1)`,
    ),
    check(
      'claim_feedback_counter_nli_score_range',
      sql`${t.counterNliScore} IS NULL OR (${t.counterNliScore} >= 0 AND ${t.counterNliScore} <= 1)`,
    ),
    check('claim_feedback_evidence_strength_range', sql`${t.evidenceStrength} >= 0 AND ${t.evidenceStrength} <= 1`),
    check(
      'claim_feedback_enrichment_status_values',
      sql`${t.enrichmentStatus} IN ('pending','finalized-inferred','awaiting-pull','enriched','expired-reporter-unavailable','skipped-backpressure','not-needed')`,
    ),
    check('claim_feedback_reporter_responded_values', sql`${t.reporterResponded} IS NULL OR ${t.reporterResponded} IN (0, 1)`),
    check('claim_feedback_audit_note_len', sql`${t.auditNote} IS NULL OR length(${t.auditNote}) <= 4000`),
    check('claim_feedback_counter_source_url_len', sql`${t.counterSourceUrl} IS NULL OR length(${t.counterSourceUrl}) <= 2000`),
    check(
      'claim_feedback_context_time_range',
      sql`${t.contextTimeFrom} IS NULL OR ${t.contextTimeUntil} IS NULL OR ${t.contextTimeFrom} <= ${t.contextTimeUntil}`,
    ),
    index('idx_claim_feedback_claim').on(t.claimId, t.createdAt.desc()),
    index('idx_claim_feedback_reporter').on(t.reporterAgentId, t.createdAt.desc()),
    index('idx_claim_feedback_enrichment_status').on(t.enrichmentStatus),
  ],
);

// ============================================================
// agent_feedback_authority — Per-agent trust score for the
// claim_feedback signal. Learned: agents whose feedback is
// confirmed by later re-verification earn weight; agents whose
// feedback is contradicted lose it. Multiplied with evidence_strength
// to determine how much a feedback can move claim.authority.
// ============================================================
export const agentFeedbackAuthority = pgTable(
  'agent_feedback_authority',
  {
    agentId: text('agent_id').primaryKey(),
    feedbackAuthority: doublePrecision('feedback_authority').notNull().default(0.5),
    totalFeedbacks: integer('total_feedbacks').notNull().default(0),
    correctFeedbacks: integer('correct_feedbacks').notNull().default(0),
    incorrectFeedbacks: integer('incorrect_feedbacks').notNull().default(0),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check('agent_feedback_authority_range', sql`${t.feedbackAuthority} >= 0 AND ${t.feedbackAuthority} <= 1`),
    check('agent_feedback_total_nonneg', sql`${t.totalFeedbacks} >= 0`),
    check('agent_feedback_correct_nonneg', sql`${t.correctFeedbacks} >= 0`),
    check('agent_feedback_incorrect_nonneg', sql`${t.incorrectFeedbacks} >= 0`),
    check('agent_feedback_consistency', sql`${t.correctFeedbacks} + ${t.incorrectFeedbacks} <= ${t.totalFeedbacks}`),
    index('idx_agent_feedback_authority').on(t.feedbackAuthority.desc()),
  ],
);
