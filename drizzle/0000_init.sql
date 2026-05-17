-- Baseline schema migration.
--
-- This file is generated from `bunx drizzle-kit generate` output and
-- then post-processed for Postgres features drizzle-kit does not
-- model (extensions, partitioning, HNSW / pgroonga index types, the
-- legacy push-channel cleanup, IF-NOT-EXISTS idempotency, and the
-- NOT VALID enum guards that 0001_kebab_cleanup.sql VALIDATEs after
-- rewriting legacy snake values).
--
-- Do not edit by hand. Run `bun /tmp/build-init.ts` (or its
-- archived form) after every `db:generate` and commit the result.

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgroonga;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_feedback_authority" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"feedback_authority" double precision DEFAULT 0.5 NOT NULL,
	"total_feedbacks" integer DEFAULT 0 NOT NULL,
	"correct_feedbacks" integer DEFAULT 0 NOT NULL,
	"incorrect_feedbacks" integer DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_feedback_authority_range" CHECK ("agent_feedback_authority"."feedback_authority" >= 0 AND "agent_feedback_authority"."feedback_authority" <= 1),
	CONSTRAINT "agent_feedback_total_nonneg" CHECK ("agent_feedback_authority"."total_feedbacks" >= 0),
	CONSTRAINT "agent_feedback_correct_nonneg" CHECK ("agent_feedback_authority"."correct_feedbacks" >= 0),
	CONSTRAINT "agent_feedback_incorrect_nonneg" CHECK ("agent_feedback_authority"."incorrect_feedbacks" >= 0),
	CONSTRAINT "agent_feedback_consistency" CHECK ("agent_feedback_authority"."correct_feedbacks" + "agent_feedback_authority"."incorrect_feedbacks" <= "agent_feedback_authority"."total_feedbacks")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calibration_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"nli_support_threshold" double precision DEFAULT 0.7 NOT NULL,
	"nli_refute_threshold" double precision DEFAULT 0.7 NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"best_f1" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"statement" text NOT NULL,
	"type" text NOT NULL,
	"verdict" text DEFAULT 'unverified' NOT NULL,
	"certainty" double precision DEFAULT 0 NOT NULL,
	"authority" double precision DEFAULT 0 NOT NULL,
	"evidence" jsonb,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_drift_check_at" timestamp with time zone,
	"source_span" text,
	"source_url" text,
	"modality" text,
	"polarity" integer,
	"quantifier" text,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	CONSTRAINT "claim_type_values" CHECK ("claim"."type" IN ('factual', 'subjective', 'predictive', 'normative')),
	CONSTRAINT "claim_verdict_values" CHECK ("claim"."verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable')),
	CONSTRAINT "claim_certainty_range" CHECK ("claim"."certainty" >= 0 AND "claim"."certainty" <= 1),
	CONSTRAINT "claim_authority_range" CHECK ("claim"."authority" >= 0 AND "claim"."authority" <= 1),
	CONSTRAINT "claim_statement_len" CHECK (length("claim"."statement") <= 2000),
	CONSTRAINT "claim_source_span_len" CHECK ("claim"."source_span" IS NULL OR length("claim"."source_span") <= 4000),
	CONSTRAINT "claim_source_url_len" CHECK ("claim"."source_url" IS NULL OR length("claim"."source_url") <= 2000),
	CONSTRAINT "claim_modality_values" CHECK ("claim"."modality" IS NULL OR "claim"."modality" IN ('asserted','hedged','possible','conditional','quoted')),
	CONSTRAINT "claim_polarity_values" CHECK ("claim"."polarity" IS NULL OR "claim"."polarity" IN (0, 1)),
	CONSTRAINT "claim_quantifier_values" CHECK ("claim"."quantifier" IS NULL OR "claim"."quantifier" IN ('universal','existential','majority','minority','specific','none')),
	CONSTRAINT "claim_valid_range" CHECK ("claim"."valid_from" IS NULL OR "claim"."valid_until" IS NULL OR "claim"."valid_from" <= "claim"."valid_until")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"reporter_agent_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"application_method" text NOT NULL,
	"outcome" text NOT NULL,
	"failure_dimension" text,
	"partial_truth" double precision,
	"context_domain" text,
	"context_time_from" timestamp with time zone,
	"context_time_until" timestamp with time zone,
	"context_scope" jsonb,
	"counter_source_url" text,
	"counter_claim_text" text,
	"counter_nli_score" double precision,
	"audit_note" text,
	"failure_dimension_inferred" text,
	"partial_truth_inferred" double precision,
	"counter_source_url_inferred" text,
	"enriched_at" timestamp with time zone,
	"enriched_by" text,
	"enrichment_llm_version" text,
	"reporter_responded" integer,
	"enrichment_status" text DEFAULT 'pending' NOT NULL,
	"evidence_strength" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_feedback_application_method_values" CHECK ("claim_feedback"."application_method" IN ('verified','applied','cited','reasoned-over')),
	CONSTRAINT "claim_feedback_outcome_values" CHECK ("claim_feedback"."outcome" IN ('held','failed','partial')),
	CONSTRAINT "claim_feedback_failure_dimension_values" CHECK ("claim_feedback"."failure_dimension" IS NULL OR "claim_feedback"."failure_dimension" IN ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct')),
	CONSTRAINT "claim_feedback_failure_dimension_inferred_values" CHECK ("claim_feedback"."failure_dimension_inferred" IS NULL OR "claim_feedback"."failure_dimension_inferred" IN ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct')),
	CONSTRAINT "claim_feedback_partial_truth_range" CHECK ("claim_feedback"."partial_truth" IS NULL OR ("claim_feedback"."partial_truth" >= 0 AND "claim_feedback"."partial_truth" <= 1)),
	CONSTRAINT "claim_feedback_partial_truth_inferred_range" CHECK ("claim_feedback"."partial_truth_inferred" IS NULL OR ("claim_feedback"."partial_truth_inferred" >= 0 AND "claim_feedback"."partial_truth_inferred" <= 1)),
	CONSTRAINT "claim_feedback_counter_nli_score_range" CHECK ("claim_feedback"."counter_nli_score" IS NULL OR ("claim_feedback"."counter_nli_score" >= 0 AND "claim_feedback"."counter_nli_score" <= 1)),
	CONSTRAINT "claim_feedback_evidence_strength_range" CHECK ("claim_feedback"."evidence_strength" >= 0 AND "claim_feedback"."evidence_strength" <= 1),
	CONSTRAINT "claim_feedback_enrichment_status_values" CHECK ("claim_feedback"."enrichment_status" IN ('pending','finalized-inferred','awaiting-pull','enriched','expired-reporter-unavailable','skipped-backpressure','not-needed')),
	CONSTRAINT "claim_feedback_reporter_responded_values" CHECK ("claim_feedback"."reporter_responded" IS NULL OR "claim_feedback"."reporter_responded" IN (0, 1)),
	CONSTRAINT "claim_feedback_audit_note_len" CHECK ("claim_feedback"."audit_note" IS NULL OR length("claim_feedback"."audit_note") <= 4000),
	CONSTRAINT "claim_feedback_counter_source_url_len" CHECK ("claim_feedback"."counter_source_url" IS NULL OR length("claim_feedback"."counter_source_url") <= 2000),
	CONSTRAINT "claim_feedback_context_time_range" CHECK ("claim_feedback"."context_time_from" IS NULL OR "claim_feedback"."context_time_until" IS NULL OR "claim_feedback"."context_time_from" <= "claim_feedback"."context_time_until")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_relation" (
	"id" text PRIMARY KEY NOT NULL,
	"source_claim_id" text NOT NULL,
	"target_claim_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"weight" double precision DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_relation_type_values" CHECK ("claim_relation"."relation_type" IN ('supports','contradicts','derives-from','superseded-by','refines')),
	CONSTRAINT "claim_relation_weight_range" CHECK ("claim_relation"."weight" >= 0 AND "claim_relation"."weight" <= 1),
	CONSTRAINT "claim_relation_no_self_loop" CHECK ("claim_relation"."source_claim_id" <> "claim_relation"."target_claim_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_name_len" CHECK (length("entity"."name") <= 200),
	CONSTRAINT "entity_type_len" CHECK (length("entity"."type") <= 50)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry" (
	"id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"metadata" jsonb,
	"authority" double precision DEFAULT 0 NOT NULL,
	"decay_rate" double precision DEFAULT 0.01 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"embedding" vector(384) NOT NULL,
	CONSTRAINT "entry_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "entry_title_len" CHECK (length("entry"."title") <= 500),
	CONSTRAINT "entry_content_len" CHECK (length("entry"."content") <= 50000),
	CONSTRAINT "entry_authority_range" CHECK ("entry"."authority" >= 0 AND "entry"."authority" <= 1),
	CONSTRAINT "entry_decay_rate_range" CHECK ("entry"."decay_rate" >= 0 AND "entry"."decay_rate" <= 1),
	CONSTRAINT "entry_status_values" CHECK ("entry"."status" IN ('draft', 'active')),
	CONSTRAINT "entry_metadata_size" CHECK (pg_column_size("entry"."metadata") <= 1048576)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry_domain" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"domain" text NOT NULL,
	CONSTRAINT "entry_domain_entry_id_entry_created_at_domain_pk" PRIMARY KEY("entry_id","entry_created_at","domain"),
	CONSTRAINT "entry_domain_len" CHECK (length("entry_domain"."domain") <= 50)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry_score" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"dimension" text NOT NULL,
	"value" double precision NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scored_by" text DEFAULT 'system' NOT NULL,
	CONSTRAINT "entry_score_entry_id_entry_created_at_dimension_pk" PRIMARY KEY("entry_id","entry_created_at","dimension"),
	CONSTRAINT "entry_score_dimension_values" CHECK ("entry_score"."dimension" IN ('factuality', 'novelty', 'actionability', 'signal')),
	CONSTRAINT "entry_score_value_range" CHECK ("entry_score"."value" >= 0 AND "entry_score"."value" <= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry_source" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"source_type" text NOT NULL,
	"trust" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "entry_source_entry_id_entry_created_at_url_pk" PRIMARY KEY("entry_id","entry_created_at","url"),
	CONSTRAINT "entry_source_trust_range" CHECK ("entry_source"."trust" >= 0 AND "entry_source"."trust" <= 1),
	CONSTRAINT "entry_source_source_type_values" CHECK ("entry_source"."source_type" IN ('official-docs','github-release','cve-db','official-blog','research-paper','established-blog','community-forum','personal-blog','ai-generated','reference-wiki','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry_tag" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "entry_tag_entry_id_entry_created_at_tag_pk" PRIMARY KEY("entry_id","entry_created_at","tag"),
	CONSTRAINT "entry_tag_len" CHECK (length("entry_tag"."tag") <= 50)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_log" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"signal" text NOT NULL,
	"reason" text,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_log_signal_values" CHECK ("feedback_log"."signal" IN ('positive', 'negative'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "golden_set_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"statement" text NOT NULL,
	"claim_type" text NOT NULL,
	"expected_verdict" text NOT NULL,
	"domain" text,
	"source_hint" text,
	"source_urls" jsonb,
	"labeled_by" text NOT NULL,
	"labeled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "golden_set_statement_len" CHECK (length("golden_set_claim"."statement") <= 2000),
	CONSTRAINT "golden_set_claim_type_values" CHECK ("golden_set_claim"."claim_type" IN ('factual', 'subjective', 'predictive', 'normative')),
	CONSTRAINT "golden_set_expected_verdict_values" CHECK ("golden_set_claim"."expected_verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable')),
	CONSTRAINT "golden_set_active_values" CHECK ("golden_set_claim"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "golden_set_run" (
	"id" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"commit_sha" text,
	"model_versions" jsonb,
	"total" integer NOT NULL,
	"correct" integer NOT NULL,
	"precision_overall" double precision NOT NULL,
	"recall_overall" double precision NOT NULL,
	"f1_overall" double precision NOT NULL,
	"metrics" jsonb NOT NULL,
	"baseline_run_id" text,
	"regressed" integer,
	CONSTRAINT "golden_set_run_total_nonneg" CHECK ("golden_set_run"."total" >= 0),
	CONSTRAINT "golden_set_run_correct_range" CHECK ("golden_set_run"."correct" >= 0 AND "golden_set_run"."correct" <= "golden_set_run"."total"),
	CONSTRAINT "golden_set_run_precision_range" CHECK ("golden_set_run"."precision_overall" >= 0 AND "golden_set_run"."precision_overall" <= 1),
	CONSTRAINT "golden_set_run_recall_range" CHECK ("golden_set_run"."recall_overall" >= 0 AND "golden_set_run"."recall_overall" <= 1),
	CONSTRAINT "golden_set_run_f1_range" CHECK ("golden_set_run"."f1_overall" >= 0 AND "golden_set_run"."f1_overall" <= 1),
	CONSTRAINT "golden_set_run_regressed_values" CHECK ("golden_set_run"."regressed" IS NULL OR "golden_set_run"."regressed" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_log" (
	"id" text PRIMARY KEY NOT NULL,
	"url_hash" text,
	"entry_id" text,
	"entry_created_at" timestamp with time zone,
	"action" text NOT NULL,
	"reason" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_log_action_values" CHECK ("ingest_log"."action" IN ('stored', 'duplicate', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kg_relation" (
	"id" text PRIMARY KEY NOT NULL,
	"source_entity_id" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"claim_id" text,
	"weight" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_relation_weight_range" CHECK ("kg_relation"."weight" >= 0 AND "kg_relation"."weight" <= 1),
	CONSTRAINT "kg_relation_no_self_loop" CHECK ("kg_relation"."source_entity_id" <> "kg_relation"."target_entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retry_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"raw_content" text NOT NULL,
	"source_url" text,
	"error_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verdict_log" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"verdict" text NOT NULL,
	"certainty" double precision NOT NULL,
	"evidence_source" text,
	"grounder_model" text,
	"trigger" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdict_log_verdict_values" CHECK ("verdict_log"."verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable')),
	CONSTRAINT "verdict_log_certainty_range" CHECK ("verdict_log"."certainty" >= 0 AND "verdict_log"."certainty" <= 1),
	CONSTRAINT "verdict_log_trigger_values" CHECK ("verdict_log"."trigger" IN ('auto', 'feedback', 'drift', 'reverify', 'cove', 'manual'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verify_queue" (
	"claim_id" text PRIMARY KEY NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_entry_id_entry_created_at_entry_id_created_at_fk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_claim_id_claim_id_fk') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_relation_source_claim_id_claim_id_fk') THEN
    ALTER TABLE "claim_relation" ADD CONSTRAINT "claim_relation_source_claim_id_claim_id_fk" FOREIGN KEY ("source_claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_relation_target_claim_id_claim_id_fk') THEN
    ALTER TABLE "claim_relation" ADD CONSTRAINT "claim_relation_target_claim_id_claim_id_fk" FOREIGN KEY ("target_claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_domain_entry_id_entry_created_at_entry_id_created_at_fk') THEN
    ALTER TABLE "entry_domain" ADD CONSTRAINT "entry_domain_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_score_entry_id_entry_created_at_entry_id_created_at_fk') THEN
    ALTER TABLE "entry_score" ADD CONSTRAINT "entry_score_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_source_entry_id_entry_created_at_entry_id_created_at_fk') THEN
    ALTER TABLE "entry_source" ADD CONSTRAINT "entry_source_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_tag_entry_id_entry_created_at_entry_id_created_at_fk') THEN
    ALTER TABLE "entry_tag" ADD CONSTRAINT "entry_tag_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_log_entry_id_entry_created_at_entry_id_created_at_fk') THEN
    ALTER TABLE "feedback_log" ADD CONSTRAINT "feedback_log_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kg_relation_source_entity_id_entity_id_fk') THEN
    ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_source_entity_id_entity_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kg_relation_target_entity_id_entity_id_fk') THEN
    ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_target_entity_id_entity_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kg_relation_claim_id_claim_id_fk') THEN
    ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verdict_log_claim_id_claim_id_fk') THEN
    ALTER TABLE "verdict_log" ADD CONSTRAINT "verdict_log_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verify_queue_claim_id_claim_id_fk') THEN
    ALTER TABLE "verify_queue" ADD CONSTRAINT "verify_queue_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_feedback_authority" ON "agent_feedback_authority" USING btree ("feedback_authority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_entry" ON "claim" USING btree ("entry_id","entry_created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_type_verdict" ON "claim" USING btree ("type","verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_feedback_claim" ON "claim_feedback" USING btree ("claim_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_feedback_reporter" ON "claim_feedback" USING btree ("reporter_agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_feedback_enrichment_status" ON "claim_feedback" USING btree ("enrichment_status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_claim_relation_edge" ON "claim_relation" USING btree ("source_claim_id","target_claim_id","relation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_relation_source" ON "claim_relation" USING btree ("source_claim_id","relation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_relation_target" ON "claim_relation" USING btree ("target_claim_id","relation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_claim_relation_type" ON "claim_relation" USING btree ("relation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_name" ON "entity" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entity_type" ON "entity" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_status" ON "entry" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_authority" ON "entry" USING btree ("authority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_language" ON "entry" USING btree ("language");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_created_at" ON "entry" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_domain_domain" ON "entry_domain" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_score_dimension" ON "entry_score" USING btree ("dimension","value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_source_type" ON "entry_source" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entry_tag_tag" ON "entry_tag" USING btree ("tag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_log_entry" ON "feedback_log" USING btree ("entry_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedback_log_agent_entry" ON "feedback_log" USING btree ("agent_id","entry_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_golden_set_domain" ON "golden_set_claim" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_golden_set_active" ON "golden_set_claim" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_golden_set_run_ran_at" ON "golden_set_run" USING btree ("ran_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ingest_log_url_hash" ON "ingest_log" USING btree ("url_hash") WHERE "ingest_log"."url_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingest_log_ingested_at" ON "ingest_log" USING btree ("ingested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kg_relation_edge" ON "kg_relation" USING btree ("source_entity_id","target_entity_id","relation_type","claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kg_relation_source" ON "kg_relation" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kg_relation_target" ON "kg_relation" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_retry_queue_next" ON "retry_queue" USING btree ("next_retry_at") WHERE "retry_queue"."attempts" < 3;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verdict_log_claim" ON "verdict_log" USING btree ("claim_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verdict_log_created" ON "verdict_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verify_queue_next" ON "verify_queue" USING btree ("priority" DESC NULLS LAST,"next_attempt_at") WHERE "verify_queue"."attempts" < 3;
CREATE INDEX IF NOT EXISTS "idx_entry_embedding" ON "entry" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "idx_claim_embedding" ON "claim" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "idx_entity_embedding" ON "entity" USING hnsw ("embedding" vector_cosine_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_entity_type_name_ci" ON "entity" ("type", lower("name"));
CREATE INDEX IF NOT EXISTS "idx_entity_name_lower" ON "entity" (lower("name"));
CREATE INDEX IF NOT EXISTS "idx_entry_fulltext" ON "entry" USING pgroonga ("title", "content");
--> statement-breakpoint

-- Drop obsolete table from prior crawler architecture.
DROP TABLE IF EXISTS "crawl_domain";
--> statement-breakpoint

-- Legacy push-channel cleanup (pre-v0.4 columns + constraints).
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

-- Legacy verify_queue sweep: anything past attempts=3 is committed
-- as unverified + dropped from the queue.
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
INSERT INTO "calibration_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
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
