import postgres from "postgres";
import { logger } from "../observability/logger";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const sql = postgres(connectionString, { max: 1 });

async function migrate() {
  logger.info("running migrations");

  // Extensions
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE EXTENSION IF NOT EXISTS pgroonga`;

  // ============================================================
  // entry (partitioned by created_at)
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry (
      id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) <= 500),
      content TEXT NOT NULL CHECK (length(content) <= 50000),
      language TEXT NOT NULL DEFAULT 'en',
      metadata JSONB CHECK (pg_column_size(metadata) <= 1048576),
      authority DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (authority >= 0 AND authority <= 1),
      decay_rate DOUBLE PRECISION NOT NULL DEFAULT 0.01 CHECK (decay_rate >= 0 AND decay_rate <= 1),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
      created_at TIMESTAMPTZ NOT NULL,
      embedding vector(384) NOT NULL,
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `;

  // Partitions
  const currentYear = new Date().getFullYear();
  for (let year = 2025; year <= currentYear + 1; year++) {
    const partName = `entry_${year}`;
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF entry
        FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
    `);
  }

  // entry indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_fulltext ON entry USING pgroonga(title, content)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_status ON entry(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_authority ON entry(authority DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_language ON entry(language)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_created_at ON entry(created_at DESC)`;
  // HNSW on embedding — without this, dedup and cross-ref run Seq Scan on
  // every ingest and every smoke-eval cycle. Required for O(log N)
  // approximate-nearest-neighbor search.
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_embedding ON entry USING hnsw(embedding vector_cosine_ops)`;

  // ============================================================
  // entry_domain
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_domain (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      domain TEXT NOT NULL CHECK (length(domain) <= 50),
      PRIMARY KEY (entry_id, entry_created_at, domain),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_domain_domain ON entry_domain(domain)`;

  // ============================================================
  // entry_tag
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_tag (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      tag TEXT NOT NULL CHECK (length(tag) <= 50),
      PRIMARY KEY (entry_id, entry_created_at, tag),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_tag_tag ON entry_tag(tag)`;

  // ============================================================
  // entry_source
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_source (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      url TEXT NOT NULL,
      source_type TEXT NOT NULL,
      trust DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (trust >= 0 AND trust <= 1),
      PRIMARY KEY (entry_id, entry_created_at, url),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_source_type ON entry_source(source_type)`;

  // ============================================================
  // ingest_log
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS ingest_log (
      id TEXT PRIMARY KEY,
      url_hash TEXT,
      entry_id TEXT,
      entry_created_at TIMESTAMPTZ,
      action TEXT NOT NULL CHECK (action IN ('stored', 'duplicate', 'rejected')),
      reason TEXT,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_log_url_hash ON ingest_log(url_hash) WHERE url_hash IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ingest_log_ingested_at ON ingest_log(ingested_at DESC)`;

  // ============================================================
  // feedback_log
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS feedback_log (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN ('positive', 'negative')),
      reason TEXT,
      agent_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_log_entry ON feedback_log(entry_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_log_agent_entry ON feedback_log(agent_id, entry_id, created_at DESC)`;

  // ============================================================
  // retry_queue
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS retry_queue (
      id TEXT PRIMARY KEY,
      raw_content TEXT NOT NULL,
      source_url TEXT,
      error_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_retry_queue_next ON retry_queue(next_retry_at) WHERE attempts < 3`;

  // Drop obsolete table from prior crawler architecture
  await sql`DROP TABLE IF EXISTS crawl_domain`;

  // ============================================================
  // claim (v0.3) — atomic assertions extracted from entries
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS claim (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      statement TEXT NOT NULL CHECK (length(statement) <= 2000),
      type TEXT NOT NULL CHECK (type IN ('factual', 'subjective', 'predictive', 'normative')),
      verdict TEXT NOT NULL DEFAULT 'unverified'
        CHECK (verdict IN ('verified', 'disputed', 'unverified', 'not_applicable')),
      certainty DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (certainty >= 0 AND certainty <= 1),
      evidence JSONB,
      embedding vector(384) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (entry_id, entry_created_at)
        REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_entry ON claim(entry_id, entry_created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_type_verdict ON claim(type, verdict)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_embedding ON claim USING hnsw(embedding vector_cosine_ops)`;
  // Drift checker uses this to avoid re-picking the same 5 oldest
  // claims every cycle when they consistently fail to re-verify.
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS last_drift_check_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_drift ON claim(last_drift_check_at NULLS FIRST) WHERE verdict IN ('verified', 'disputed')`;

  // ============================================================
  // verdict_log — append-only history of every verdict change
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS verdict_log (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('verified', 'disputed', 'unverified', 'not_applicable')),
      certainty DOUBLE PRECISION NOT NULL CHECK (certainty >= 0 AND certainty <= 1),
      evidence_source TEXT,
      grounder_model TEXT,
      trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'feedback', 'drift', 'reverify', 'cove', 'manual')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_verdict_log_claim ON verdict_log(claim_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_verdict_log_created ON verdict_log(created_at DESC)`;

  // ============================================================
  // verify_queue (v0.3)
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS verify_queue (
      claim_id TEXT PRIMARY KEY REFERENCES claim(id) ON DELETE CASCADE,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // CHECK clamps attempts at 3 so bumpAttempt can't runaway past the
  // WHERE-filter cutoff. Any pre-existing rows beyond 3 get the verdict
  // committed + dequeued by the sweep below.
  await sql`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'verify_queue_attempts_check'
    ) THEN
      BEGIN
        ALTER TABLE verify_queue ADD CONSTRAINT verify_queue_attempts_check
          CHECK (attempts >= 0 AND attempts <= 3);
      EXCEPTION WHEN check_violation THEN
        -- Pre-existing data violates; caller should run the sweep then retry.
        NULL;
      END;
    END IF;
  END $$`;
  // One-time sweep: anything past attempts=3 is committed as unverified
  // + dropped from the queue so legacy poison rows don't linger.
  await sql`
    WITH stuck AS (
      SELECT claim_id FROM verify_queue WHERE attempts > 3
    )
    UPDATE claim SET verdict = 'unverified', certainty = 0,
      evidence = COALESCE(evidence, '{}'::jsonb)
        || jsonb_build_object('source', 'llm_jury', 'rationale', 'legacy stuck row swept')
    WHERE id IN (SELECT claim_id FROM stuck)
      AND verdict = 'unverified'
  `;
  await sql`DELETE FROM verify_queue WHERE attempts > 3`;
  await sql`CREATE INDEX IF NOT EXISTS idx_verify_queue_next ON verify_queue(priority DESC, next_attempt_at) WHERE attempts < 3`;

  // ============================================================
  // entry_score (v0.3) — per-entry derived dimensions
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_score (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      dimension TEXT NOT NULL CHECK (dimension IN ('factuality', 'novelty', 'actionability', 'signal')),
      value DOUBLE PRECISION NOT NULL CHECK (value >= 0 AND value <= 1),
      scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      scored_by TEXT NOT NULL DEFAULT 'system',
      PRIMARY KEY (entry_id, entry_created_at, dimension),
      FOREIGN KEY (entry_id, entry_created_at)
        REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_score_dimension ON entry_score(dimension, value)`;

  // ============================================================
  // entity (v0.4) — Knowledge Graph nodes
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entity (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) <= 200),
      type TEXT NOT NULL CHECK (length(type) <= 50),
      aliases TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB,
      embedding vector(384) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entity_name ON entity(name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entity_type ON entity(type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entity_embedding ON entity USING hnsw(embedding vector_cosine_ops)`;
  // Case-insensitive UNIQUE on (type, lower(name)) — DB-level guard
  // against race-condition duplicates from upsertEntity.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_entity_type_name_ci ON entity(type, lower(name))`;
  // Expression index used by isFunctionalPredicate / findConflictingObjects.
  await sql`CREATE INDEX IF NOT EXISTS idx_entity_name_lower ON entity(lower(name))`;

  // ============================================================
  // kg_relation (v0.4) — Knowledge Graph edges
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS kg_relation (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      claim_id TEXT REFERENCES claim(id) ON DELETE SET NULL,
      weight DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (source_entity_id <> target_entity_id),
      UNIQUE (source_entity_id, target_entity_id, relation_type, claim_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_kg_relation_source ON kg_relation(source_entity_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kg_relation_target ON kg_relation(target_entity_id)`;
  // Used by isFunctionalPredicate / findConflictingObjects — without it
  // every contradiction check Seq Scans the full edge table.
  await sql`CREATE INDEX IF NOT EXISTS idx_kg_relation_type ON kg_relation(relation_type)`;

  // ============================================================
  // claim_relation (v0.4) — typed edges between claims.
  // Substrate for contradiction surfacing, supports walks,
  // derives-from provenance, superseded-by (world changed),
  // and refines (partial-truth correction).
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS claim_relation (
      id TEXT PRIMARY KEY,
      source_claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
      target_claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL
        CHECK (relation_type IN ('supports','contradicts','derives_from','superseded_by','refines')),
      weight DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
      created_by TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (source_claim_id <> target_claim_id),
      UNIQUE (source_claim_id, target_claim_id, relation_type)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_relation_source ON claim_relation(source_claim_id, relation_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_relation_target ON claim_relation(target_claim_id, relation_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_relation_type ON claim_relation(relation_type)`;

  // No human-review queue. The verifier auto-escalates uncertain
  // cases through CoVe + web_search + specialized retrieval and
  // commits whatever the strongest available signal indicates,
  // preferring low-certainty over a deferred decision.

  // ============================================================
  // calibration_state (v0.5) — auto-calibrated thresholds. A
  // single-row table updated by the calibration worker; verify
  // pipeline reads on each batch.
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS calibration_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      nli_support_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.7,
      nli_refute_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.7,
      sample_size INTEGER NOT NULL DEFAULT 0,
      best_f1 DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`INSERT INTO calibration_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

  // ============================================================
  // claim — verifiability columns (v0.4 prep). Nullable so existing
  // rows survive; new extraction code will populate them and a later
  // migration flips NOT NULL once backfill completes.
  // ============================================================
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS source_span TEXT`;
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS source_url TEXT`;
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS modality TEXT`;
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS polarity INTEGER`;
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS quantifier TEXT`;
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`;
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ`;

  // claim.authority — mutable trust score, separate from certainty.
  // Initialized from certainty for existing rows; new rows insert
  // with default 0 (storeClaims overrides to certainty value).
  await sql`ALTER TABLE claim ADD COLUMN IF NOT EXISTS authority DOUBLE PRECISION NOT NULL DEFAULT 0`;
  await sql`UPDATE claim SET authority = certainty WHERE authority = 0 AND certainty > 0`;
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_authority_range') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_authority_range
        CHECK (authority >= 0 AND authority <= 1);
    END IF;
  END $$`;

  // CHECK constraints — applied conditionally so re-runs don't fail
  // and existing NULL rows pass. We use a guarded DO block per
  // constraint to stay idempotent.
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_source_span_len') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_source_span_len
        CHECK (source_span IS NULL OR length(source_span) <= 4000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_source_url_len') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_source_url_len
        CHECK (source_url IS NULL OR length(source_url) <= 2000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_modality_values') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_modality_values
        CHECK (modality IS NULL OR modality IN ('asserted','hedged','possible','conditional','quoted'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_polarity_values') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_polarity_values
        CHECK (polarity IS NULL OR polarity IN (0, 1));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_quantifier_values') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_quantifier_values
        CHECK (quantifier IS NULL OR quantifier IN ('universal','existential','majority','minority','specific','none'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_valid_range') THEN
      ALTER TABLE claim ADD CONSTRAINT claim_valid_range
        CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until);
    END IF;
  END $$`;

  // ============================================================
  // golden_set_claim — human-labelled regression corpus.
  // Without this, every pipeline change ships blind. Empty until
  // labels are added; the eval harness is a no-op on empty corpus.
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS golden_set_claim (
      id TEXT PRIMARY KEY,
      statement TEXT NOT NULL CHECK (length(statement) <= 2000),
      claim_type TEXT NOT NULL
        CHECK (claim_type IN ('factual', 'subjective', 'predictive', 'normative')),
      expected_verdict TEXT NOT NULL
        CHECK (expected_verdict IN ('verified', 'disputed', 'unverified', 'not_applicable')),
      domain TEXT,
      source_hint TEXT,
      labeled_by TEXT NOT NULL,
      labeled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_golden_set_domain ON golden_set_claim(domain)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_golden_set_active ON golden_set_claim(active)`;
  // Source URLs for eval harness to inject into temp entry_source.
  await sql`ALTER TABLE golden_set_claim ADD COLUMN IF NOT EXISTS source_urls JSONB`;

  // ============================================================
  // golden_set_run — one row per evaluation pass.
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS golden_set_run (
      id TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      commit_sha TEXT,
      model_versions JSONB,
      total INTEGER NOT NULL CHECK (total >= 0),
      correct INTEGER NOT NULL,
      precision_overall DOUBLE PRECISION NOT NULL CHECK (precision_overall >= 0 AND precision_overall <= 1),
      recall_overall DOUBLE PRECISION NOT NULL CHECK (recall_overall >= 0 AND recall_overall <= 1),
      f1_overall DOUBLE PRECISION NOT NULL CHECK (f1_overall >= 0 AND f1_overall <= 1),
      metrics JSONB NOT NULL,
      baseline_run_id TEXT,
      regressed INTEGER CHECK (regressed IS NULL OR regressed IN (0, 1)),
      CHECK (correct >= 0 AND correct <= total)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_golden_set_run_ran_at ON golden_set_run(ran_at DESC)`;

  // ============================================================
  // claim_feedback — claim-level structured feedback.
  // Append-only. Drives claim authority updates via evidence_strength
  // × agent_feedback_authority. The entry-level feedback_log table is
  // a separate signal channel and remains untouched.
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS claim_feedback (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
      reporter_agent_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      application_method TEXT NOT NULL
        CHECK (application_method IN ('verified','applied','cited','reasoned_over')),
      outcome TEXT NOT NULL
        CHECK (outcome IN ('held','failed','partial')),

      failure_dimension TEXT
        CHECK (failure_dimension IS NULL OR failure_dimension IN
          ('fully_false','scope_too_broad','time_expired','modality_too_strong','context_mismatch','partially_correct')),
      partial_truth DOUBLE PRECISION
        CHECK (partial_truth IS NULL OR (partial_truth >= 0 AND partial_truth <= 1)),
      context_domain TEXT,
      context_time_from TIMESTAMPTZ,
      context_time_until TIMESTAMPTZ,
      context_scope JSONB,
      counter_source_url TEXT
        CHECK (counter_source_url IS NULL OR length(counter_source_url) <= 2000),
      counter_claim_text TEXT,
      counter_nli_score DOUBLE PRECISION
        CHECK (counter_nli_score IS NULL OR (counter_nli_score >= 0 AND counter_nli_score <= 1)),
      audit_note TEXT
        CHECK (audit_note IS NULL OR length(audit_note) <= 4000),

      failure_dimension_inferred TEXT
        CHECK (failure_dimension_inferred IS NULL OR failure_dimension_inferred IN
          ('fully_false','scope_too_broad','time_expired','modality_too_strong','context_mismatch','partially_correct')),
      partial_truth_inferred DOUBLE PRECISION
        CHECK (partial_truth_inferred IS NULL OR (partial_truth_inferred >= 0 AND partial_truth_inferred <= 1)),
      counter_source_url_inferred TEXT,
      enriched_at TIMESTAMPTZ,
      enriched_by TEXT,
      enrichment_llm_version TEXT,
      reporter_responded INTEGER
        CHECK (reporter_responded IS NULL OR reporter_responded IN (0, 1)),
      enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN
          ('pending','finalized_inferred','awaiting_pull',
           'enriched','expired_reporter_unavailable','skipped_backpressure','not_needed')),

      evidence_strength DOUBLE PRECISION NOT NULL DEFAULT 0.0
        CHECK (evidence_strength >= 0 AND evidence_strength <= 1),

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (context_time_from IS NULL OR context_time_until IS NULL OR context_time_from <= context_time_until)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_feedback_claim ON claim_feedback(claim_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_feedback_reporter ON claim_feedback(reporter_agent_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_feedback_enrichment_status ON claim_feedback(enrichment_status)`;

  // Push-channel cleanup. Earlier v0.4 versions added these columns
  // for a planned reporter callback path; real-world reporter agents
  // are almost always transient (no inbound HTTP server) so the push
  // channel never carried weight. We drop the columns + their
  // constraints so the schema reflects the final design.
  await sql`ALTER TABLE claim_feedback DROP CONSTRAINT IF EXISTS claim_feedback_callback_capability_values`;
  await sql`ALTER TABLE claim_feedback DROP CONSTRAINT IF EXISTS claim_feedback_callback_url_len`;
  await sql`ALTER TABLE claim_feedback DROP CONSTRAINT IF EXISTS claim_feedback_push_outcome_values`;
  await sql`ALTER TABLE claim_feedback DROP COLUMN IF EXISTS enrichment_callback_url`;
  await sql`ALTER TABLE claim_feedback DROP COLUMN IF EXISTS callback_capability`;
  await sql`ALTER TABLE claim_feedback DROP COLUMN IF EXISTS push_attempted_at`;
  await sql`ALTER TABLE claim_feedback DROP COLUMN IF EXISTS push_outcome`;
  // Replace the older enrichment_status CHECK (which allowed
  // 'awaiting_reporter_push') with the post-push value set.
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_enrichment_status_values') THEN
      ALTER TABLE claim_feedback DROP CONSTRAINT claim_feedback_enrichment_status_values;
    END IF;
    ALTER TABLE claim_feedback ADD CONSTRAINT claim_feedback_enrichment_status_values
      CHECK (enrichment_status IN (
        'pending','finalized_inferred','awaiting_pull','enriched',
        'expired_reporter_unavailable','skipped_backpressure','not_needed'
      ));
  END $$`;

  // ============================================================
  // agent_feedback_authority — per-reporter trust score.
  // Multiplied with claim_feedback.evidence_strength to weight how
  // much a feedback moves the referenced claim's authority.
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS agent_feedback_authority (
      agent_id TEXT PRIMARY KEY,
      feedback_authority DOUBLE PRECISION NOT NULL DEFAULT 0.5
        CHECK (feedback_authority >= 0 AND feedback_authority <= 1),
      total_feedbacks INTEGER NOT NULL DEFAULT 0 CHECK (total_feedbacks >= 0),
      correct_feedbacks INTEGER NOT NULL DEFAULT 0 CHECK (correct_feedbacks >= 0),
      incorrect_feedbacks INTEGER NOT NULL DEFAULT 0 CHECK (incorrect_feedbacks >= 0),
      last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (correct_feedbacks + incorrect_feedbacks <= total_feedbacks)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_feedback_authority ON agent_feedback_authority(feedback_authority DESC)`;

  logger.info("migrations complete");
  await sql.end();
}

migrate().catch((err) => {
  logger.error(err, "migration failed");
  process.exit(1);
});
