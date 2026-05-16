-- Baseline migration: complete schema setup.
--
-- Hand-maintained (not `drizzle-kit generate` output) because the
-- project depends on Postgres features the auto-generator does not
-- emit: extensions, partitioning, HNSW / pgroonga index types, and
-- a handful of named CHECK constraints we want stable across
-- migrations. `schema.ts` and this file are kept in lockstep by
-- review; `drizzle-kit generate` is still useful as a reference for
-- pure-table diffs.
--
-- Every CREATE / ADD uses IF NOT EXISTS / a guarded DO block so this
-- file is safe to apply against a pre-existing v0.4 deployment — on
-- such a deployment the drizzle migrator's first invocation simply
-- discovers everything already present and moves on.

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgroonga;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entry" (
  "id" text NOT NULL,
  "title" text NOT NULL CHECK (length("title") <= 500),
  "content" text NOT NULL CHECK (length("content") <= 50000),
  "language" text NOT NULL DEFAULT 'en',
  "metadata" jsonb CHECK (pg_column_size("metadata") <= 1048576),
  "authority" double precision NOT NULL DEFAULT 0.0 CHECK ("authority" >= 0 AND "authority" <= 1),
  "decay_rate" double precision NOT NULL DEFAULT 0.01 CHECK ("decay_rate" >= 0 AND "decay_rate" <= 1),
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'active')),
  "created_at" timestamp with time zone NOT NULL,
  "embedding" vector(384) NOT NULL,
  PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_fulltext" ON "entry" USING pgroonga ("title", "content");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_status" ON "entry" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_authority" ON "entry" ("authority" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_language" ON "entry" ("language");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_created_at" ON "entry" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_embedding" ON "entry" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entry_domain" (
  "entry_id" text NOT NULL,
  "entry_created_at" timestamp with time zone NOT NULL,
  "domain" text NOT NULL CHECK (length("domain") <= 50),
  PRIMARY KEY ("entry_id", "entry_created_at", "domain"),
  FOREIGN KEY ("entry_id", "entry_created_at") REFERENCES "entry"("id", "created_at") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_domain_domain" ON "entry_domain" ("domain");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entry_tag" (
  "entry_id" text NOT NULL,
  "entry_created_at" timestamp with time zone NOT NULL,
  "tag" text NOT NULL CHECK (length("tag") <= 50),
  PRIMARY KEY ("entry_id", "entry_created_at", "tag"),
  FOREIGN KEY ("entry_id", "entry_created_at") REFERENCES "entry"("id", "created_at") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_tag_tag" ON "entry_tag" ("tag");
--> statement-breakpoint

-- entry_source. source_type CHECK is attached in 0001 so legacy
-- snake values can migrate before the whitelist binds.
CREATE TABLE IF NOT EXISTS "entry_source" (
  "entry_id" text NOT NULL,
  "entry_created_at" timestamp with time zone NOT NULL,
  "url" text NOT NULL,
  "source_type" text NOT NULL,
  "trust" double precision NOT NULL DEFAULT 0.0 CHECK ("trust" >= 0 AND "trust" <= 1),
  PRIMARY KEY ("entry_id", "entry_created_at", "url"),
  FOREIGN KEY ("entry_id", "entry_created_at") REFERENCES "entry"("id", "created_at") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_source_type" ON "entry_source" ("source_type");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ingest_log" (
  "id" text PRIMARY KEY,
  "url_hash" text,
  "entry_id" text,
  "entry_created_at" timestamp with time zone,
  "action" text NOT NULL CHECK ("action" IN ('stored', 'duplicate', 'rejected')),
  "reason" text,
  "ingested_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ingest_log_url_hash" ON "ingest_log" ("url_hash") WHERE "url_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingest_log_ingested_at" ON "ingest_log" ("ingested_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "feedback_log" (
  "id" text PRIMARY KEY,
  "entry_id" text NOT NULL,
  "entry_created_at" timestamp with time zone NOT NULL,
  "signal" text NOT NULL CHECK ("signal" IN ('positive', 'negative')),
  "reason" text,
  "agent_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  FOREIGN KEY ("entry_id", "entry_created_at") REFERENCES "entry"("id", "created_at") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_log_entry" ON "feedback_log" ("entry_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_log_agent_entry" ON "feedback_log" ("agent_id", "entry_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "retry_queue" (
  "id" text PRIMARY KEY,
  "raw_content" text NOT NULL,
  "source_url" text,
  "error_reason" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "next_retry_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_retry_queue_next" ON "retry_queue" ("next_retry_at") WHERE "attempts" < 3;
--> statement-breakpoint

-- Drop obsolete table from prior crawler architecture.
DROP TABLE IF EXISTS "crawl_domain";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "claim" (
  "id" text PRIMARY KEY,
  "entry_id" text NOT NULL,
  "entry_created_at" timestamp with time zone NOT NULL,
  "statement" text NOT NULL CHECK (length("statement") <= 2000),
  "type" text NOT NULL CHECK ("type" IN ('factual', 'subjective', 'predictive', 'normative')),
  "verdict" text NOT NULL DEFAULT 'unverified',
  "certainty" double precision NOT NULL DEFAULT 0.0 CHECK ("certainty" >= 0 AND "certainty" <= 1),
  "evidence" jsonb,
  "embedding" vector(384) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  FOREIGN KEY ("entry_id", "entry_created_at") REFERENCES "entry"("id", "created_at") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_entry" ON "claim" ("entry_id", "entry_created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_type_verdict" ON "claim" ("type", "verdict");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_embedding" ON "claim" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "last_drift_check_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_drift" ON "claim" ("last_drift_check_at" NULLS FIRST)
  WHERE "verdict" IN ('verified', 'disputed');
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "source_span" text;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "source_url" text;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "modality" text;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "polarity" integer;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "quantifier" text;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "valid_from" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "authority" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_authority_range') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_authority_range"
      CHECK ("authority" >= 0 AND "authority" <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_source_span_len') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_source_span_len"
      CHECK ("source_span" IS NULL OR length("source_span") <= 4000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_source_url_len') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_source_url_len"
      CHECK ("source_url" IS NULL OR length("source_url") <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_modality_values') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_modality_values"
      CHECK ("modality" IS NULL OR "modality" IN ('asserted','hedged','possible','conditional','quoted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_polarity_values') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_polarity_values"
      CHECK ("polarity" IS NULL OR "polarity" IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_quantifier_values') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_quantifier_values"
      CHECK ("quantifier" IS NULL OR "quantifier" IN ('universal','existential','majority','minority','specific','none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_valid_range') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_valid_range"
      CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_from" <= "valid_until");
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verdict_log" (
  "id" text PRIMARY KEY,
  "claim_id" text NOT NULL REFERENCES "claim"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL,
  "certainty" double precision NOT NULL CHECK ("certainty" >= 0 AND "certainty" <= 1),
  "evidence_source" text,
  "grounder_model" text,
  "trigger" text NOT NULL CHECK ("trigger" IN ('auto', 'feedback', 'drift', 'reverify', 'cove', 'manual')),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verdict_log_claim" ON "verdict_log" ("claim_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verdict_log_created" ON "verdict_log" ("created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verify_queue" (
  "claim_id" text PRIMARY KEY REFERENCES "claim"("id") ON DELETE CASCADE,
  "queued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "priority" integer NOT NULL DEFAULT 0,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verify_queue_attempts_check') THEN
    BEGIN
      ALTER TABLE "verify_queue" ADD CONSTRAINT "verify_queue_attempts_check"
        CHECK ("attempts" >= 0 AND "attempts" <= 3);
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END IF;
END $$;
--> statement-breakpoint
-- One-time sweep: anything past attempts=3 on legacy deployments is
-- committed as unverified + dropped from the queue.
WITH stuck AS (SELECT "claim_id" FROM "verify_queue" WHERE "attempts" > 3)
UPDATE "claim"
SET "verdict" = 'unverified',
    "certainty" = 0,
    "evidence" = COALESCE("evidence", '{}'::jsonb)
      || jsonb_build_object('source', 'llm_jury', 'rationale', 'legacy stuck row swept')
WHERE "id" IN (SELECT "claim_id" FROM stuck)
  AND "verdict" = 'unverified';
--> statement-breakpoint
DELETE FROM "verify_queue" WHERE "attempts" > 3;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verify_queue_next" ON "verify_queue" ("priority" DESC, "next_attempt_at") WHERE "attempts" < 3;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entry_score" (
  "entry_id" text NOT NULL,
  "entry_created_at" timestamp with time zone NOT NULL,
  "dimension" text NOT NULL CHECK ("dimension" IN ('factuality', 'novelty', 'actionability', 'signal')),
  "value" double precision NOT NULL CHECK ("value" >= 0 AND "value" <= 1),
  "scored_at" timestamp with time zone NOT NULL DEFAULT now(),
  "scored_by" text NOT NULL DEFAULT 'system',
  PRIMARY KEY ("entry_id", "entry_created_at", "dimension"),
  FOREIGN KEY ("entry_id", "entry_created_at") REFERENCES "entry"("id", "created_at") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_score_dimension" ON "entry_score" ("dimension", "value");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entity" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL CHECK (length("name") <= 200),
  "type" text NOT NULL CHECK (length("type") <= 50),
  "aliases" text[] NOT NULL DEFAULT '{}',
  "metadata" jsonb,
  "embedding" vector(384) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_name" ON "entity" ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_type" ON "entity" ("type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_embedding" ON "entity" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_entity_type_name_ci" ON "entity" ("type", lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_name_lower" ON "entity" (lower("name"));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kg_relation" (
  "id" text PRIMARY KEY,
  "source_entity_id" text NOT NULL REFERENCES "entity"("id") ON DELETE CASCADE,
  "target_entity_id" text NOT NULL REFERENCES "entity"("id") ON DELETE CASCADE,
  "relation_type" text NOT NULL,
  "claim_id" text REFERENCES "claim"("id") ON DELETE SET NULL,
  "weight" double precision NOT NULL DEFAULT 1.0 CHECK ("weight" >= 0 AND "weight" <= 1),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("source_entity_id" <> "target_entity_id"),
  UNIQUE ("source_entity_id", "target_entity_id", "relation_type", "claim_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kg_relation_source" ON "kg_relation" ("source_entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kg_relation_target" ON "kg_relation" ("target_entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kg_relation_type" ON "kg_relation" ("relation_type");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "claim_relation" (
  "id" text PRIMARY KEY,
  "source_claim_id" text NOT NULL REFERENCES "claim"("id") ON DELETE CASCADE,
  "target_claim_id" text NOT NULL REFERENCES "claim"("id") ON DELETE CASCADE,
  "relation_type" text NOT NULL,
  "weight" double precision NOT NULL DEFAULT 1.0 CHECK ("weight" >= 0 AND "weight" <= 1),
  "created_by" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("source_claim_id" <> "target_claim_id"),
  UNIQUE ("source_claim_id", "target_claim_id", "relation_type")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_relation_source" ON "claim_relation" ("source_claim_id", "relation_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_relation_target" ON "claim_relation" ("target_claim_id", "relation_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_relation_type" ON "claim_relation" ("relation_type");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "calibration_state" (
  "id" integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "nli_support_threshold" double precision NOT NULL DEFAULT 0.7,
  "nli_refute_threshold" double precision NOT NULL DEFAULT 0.7,
  "sample_size" integer NOT NULL DEFAULT 0,
  "best_f1" double precision NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "calibration_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "golden_set_claim" (
  "id" text PRIMARY KEY,
  "statement" text NOT NULL CHECK (length("statement") <= 2000),
  "claim_type" text NOT NULL CHECK ("claim_type" IN ('factual', 'subjective', 'predictive', 'normative')),
  "expected_verdict" text NOT NULL,
  "domain" text,
  "source_hint" text,
  "labeled_by" text NOT NULL,
  "labeled_at" timestamp with time zone NOT NULL DEFAULT now(),
  "notes" text,
  "active" integer NOT NULL DEFAULT 1 CHECK ("active" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_golden_set_domain" ON "golden_set_claim" ("domain");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_golden_set_active" ON "golden_set_claim" ("active");
--> statement-breakpoint
ALTER TABLE "golden_set_claim" ADD COLUMN IF NOT EXISTS "source_urls" jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "golden_set_run" (
  "id" text PRIMARY KEY,
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "commit_sha" text,
  "model_versions" jsonb,
  "total" integer NOT NULL CHECK ("total" >= 0),
  "correct" integer NOT NULL,
  "precision_overall" double precision NOT NULL CHECK ("precision_overall" >= 0 AND "precision_overall" <= 1),
  "recall_overall" double precision NOT NULL CHECK ("recall_overall" >= 0 AND "recall_overall" <= 1),
  "f1_overall" double precision NOT NULL CHECK ("f1_overall" >= 0 AND "f1_overall" <= 1),
  "metrics" jsonb NOT NULL,
  "baseline_run_id" text,
  "regressed" integer CHECK ("regressed" IS NULL OR "regressed" IN (0, 1)),
  CHECK ("correct" >= 0 AND "correct" <= "total")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_golden_set_run_ran_at" ON "golden_set_run" ("ran_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "claim_feedback" (
  "id" text PRIMARY KEY,
  "claim_id" text NOT NULL REFERENCES "claim"("id") ON DELETE CASCADE,
  "reporter_agent_id" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "application_method" text NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('held','failed','partial')),
  "failure_dimension" text,
  "partial_truth" double precision CHECK ("partial_truth" IS NULL OR ("partial_truth" >= 0 AND "partial_truth" <= 1)),
  "context_domain" text,
  "context_time_from" timestamp with time zone,
  "context_time_until" timestamp with time zone,
  "context_scope" jsonb,
  "counter_source_url" text CHECK ("counter_source_url" IS NULL OR length("counter_source_url") <= 2000),
  "counter_claim_text" text,
  "counter_nli_score" double precision CHECK ("counter_nli_score" IS NULL OR ("counter_nli_score" >= 0 AND "counter_nli_score" <= 1)),
  "audit_note" text CHECK ("audit_note" IS NULL OR length("audit_note") <= 4000),
  "failure_dimension_inferred" text,
  "partial_truth_inferred" double precision CHECK ("partial_truth_inferred" IS NULL OR ("partial_truth_inferred" >= 0 AND "partial_truth_inferred" <= 1)),
  "counter_source_url_inferred" text,
  "enriched_at" timestamp with time zone,
  "enriched_by" text,
  "enrichment_llm_version" text,
  "reporter_responded" integer CHECK ("reporter_responded" IS NULL OR "reporter_responded" IN (0, 1)),
  "enrichment_status" text NOT NULL DEFAULT 'pending',
  "evidence_strength" double precision NOT NULL DEFAULT 0.0 CHECK ("evidence_strength" >= 0 AND "evidence_strength" <= 1),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("context_time_from" IS NULL OR "context_time_until" IS NULL OR "context_time_from" <= "context_time_until")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_feedback_claim" ON "claim_feedback" ("claim_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_feedback_reporter" ON "claim_feedback" ("reporter_agent_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_feedback_enrichment_status" ON "claim_feedback" ("enrichment_status");
--> statement-breakpoint

-- claim_feedback push-channel cleanup. Earlier v0.4 versions added
-- these columns for a planned reporter callback path; reporter
-- agents are almost always transient (no inbound HTTP server) so
-- the push channel never carried weight.
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_callback_capability_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_callback_url_len";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_push_outcome_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "enrichment_callback_url";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "callback_capability";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "push_attempted_at";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "push_outcome";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_feedback_authority" (
  "agent_id" text PRIMARY KEY,
  "feedback_authority" double precision NOT NULL DEFAULT 0.5 CHECK ("feedback_authority" >= 0 AND "feedback_authority" <= 1),
  "total_feedbacks" integer NOT NULL DEFAULT 0 CHECK ("total_feedbacks" >= 0),
  "correct_feedbacks" integer NOT NULL DEFAULT 0 CHECK ("correct_feedbacks" >= 0),
  "incorrect_feedbacks" integer NOT NULL DEFAULT 0 CHECK ("incorrect_feedbacks" >= 0),
  "last_updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("correct_feedbacks" + "incorrect_feedbacks" <= "total_feedbacks")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_feedback_authority" ON "agent_feedback_authority" ("feedback_authority" DESC);
--> statement-breakpoint

-- ============================================================
-- Named enum CHECK constraints — attached NOT VALID so a legacy
-- deployment carrying snake_case values isn't rejected here. The
-- 0001 migration first rewrites those rows to kebab and then runs
-- `ALTER TABLE ... VALIDATE CONSTRAINT` to flip each constraint
-- to enforced. On fresh deployments NOT VALID is moot — there's no
-- data to fail validation against.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_verdict_values') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_verdict_values"
      CHECK ("verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verdict_log_verdict_values') THEN
    ALTER TABLE "verdict_log" ADD CONSTRAINT "verdict_log_verdict_values"
      CHECK ("verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'golden_set_expected_verdict_values') THEN
    ALTER TABLE "golden_set_claim" ADD CONSTRAINT "golden_set_expected_verdict_values"
      CHECK ("expected_verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_relation_type_values') THEN
    ALTER TABLE "claim_relation" ADD CONSTRAINT "claim_relation_type_values"
      CHECK ("relation_type" IN ('supports','contradicts','derives-from','superseded-by','refines')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_application_method_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_application_method_values"
      CHECK ("application_method" IN ('verified','applied','cited','reasoned-over')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_failure_dimension_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_failure_dimension_values"
      CHECK ("failure_dimension" IS NULL OR "failure_dimension" IN
        ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_failure_dimension_inferred_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_failure_dimension_inferred_values"
      CHECK ("failure_dimension_inferred" IS NULL OR "failure_dimension_inferred" IN
        ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_enrichment_status_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_enrichment_status_values"
      CHECK ("enrichment_status" IN (
        'pending','finalized-inferred','awaiting-pull','enriched',
        'expired-reporter-unavailable','skipped-backpressure','not-needed'
      )) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_source_source_type_values') THEN
    ALTER TABLE "entry_source" ADD CONSTRAINT "entry_source_source_type_values"
      CHECK ("source_type" IN (
        'official-docs','github-release','cve-db','official-blog','research-paper',
        'established-blog','community-forum','personal-blog','ai-generated',
        'reference-wiki','unknown'
      )) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_log_signal_values') THEN
    ALTER TABLE "feedback_log" ADD CONSTRAINT "feedback_log_signal_values"
      CHECK ("signal" IN ('positive', 'negative')) NOT VALID;
  END IF;
END $$;
