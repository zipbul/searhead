-- Snake → kebab data migration + finalize the NOT VALID CHECKs.
--
-- 0000_init.sql attached every enum CHECK with `NOT VALID` so legacy
-- deployments carrying snake_case values weren't rejected by the
-- baseline. This file rewrites those rows to kebab and then runs
-- `VALIDATE CONSTRAINT` on each, flipping the CHECKs to enforced.
--
-- On a fresh install all UPDATE statements match zero rows (no
-- snake data exists), the legacy auto-named CHECK cleanup matches
-- nothing, and VALIDATE CONSTRAINT succeeds trivially.

UPDATE "claim" SET "verdict" = 'not-applicable' WHERE "verdict" = 'not_applicable';
--> statement-breakpoint
UPDATE "verdict_log" SET "verdict" = 'not-applicable' WHERE "verdict" = 'not_applicable';
--> statement-breakpoint
UPDATE "golden_set_claim" SET "expected_verdict" = 'not-applicable' WHERE "expected_verdict" = 'not_applicable';
--> statement-breakpoint
UPDATE "claim_relation" SET "relation_type" = 'derives-from' WHERE "relation_type" = 'derives_from';
--> statement-breakpoint
UPDATE "claim_relation" SET "relation_type" = 'superseded-by' WHERE "relation_type" = 'superseded_by';
--> statement-breakpoint
UPDATE "claim_feedback" SET "application_method" = 'reasoned-over' WHERE "application_method" = 'reasoned_over';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension" = 'fully-false' WHERE "failure_dimension" = 'fully_false';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension" = 'scope-too-broad' WHERE "failure_dimension" = 'scope_too_broad';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension" = 'time-expired' WHERE "failure_dimension" = 'time_expired';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension" = 'modality-too-strong' WHERE "failure_dimension" = 'modality_too_strong';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension" = 'context-mismatch' WHERE "failure_dimension" = 'context_mismatch';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension" = 'partially-correct' WHERE "failure_dimension" = 'partially_correct';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension_inferred" = 'fully-false' WHERE "failure_dimension_inferred" = 'fully_false';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension_inferred" = 'scope-too-broad' WHERE "failure_dimension_inferred" = 'scope_too_broad';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension_inferred" = 'time-expired' WHERE "failure_dimension_inferred" = 'time_expired';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension_inferred" = 'modality-too-strong' WHERE "failure_dimension_inferred" = 'modality_too_strong';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension_inferred" = 'context-mismatch' WHERE "failure_dimension_inferred" = 'context_mismatch';
--> statement-breakpoint
UPDATE "claim_feedback" SET "failure_dimension_inferred" = 'partially-correct' WHERE "failure_dimension_inferred" = 'partially_correct';
--> statement-breakpoint
UPDATE "claim_feedback" SET "enrichment_status" = 'finalized-inferred' WHERE "enrichment_status" = 'finalized_inferred';
--> statement-breakpoint
UPDATE "claim_feedback" SET "enrichment_status" = 'awaiting-pull' WHERE "enrichment_status" = 'awaiting_pull';
--> statement-breakpoint
UPDATE "claim_feedback" SET "enrichment_status" = 'expired-reporter-unavailable' WHERE "enrichment_status" = 'expired_reporter_unavailable';
--> statement-breakpoint
UPDATE "claim_feedback" SET "enrichment_status" = 'skipped-backpressure' WHERE "enrichment_status" = 'skipped_backpressure';
--> statement-breakpoint
UPDATE "claim_feedback" SET "enrichment_status" = 'not-needed' WHERE "enrichment_status" = 'not_needed';
--> statement-breakpoint
-- `awaiting_reporter_push` was retired entirely (push channel removed)
UPDATE "claim_feedback" SET "enrichment_status" = 'awaiting-pull' WHERE "enrichment_status" = 'awaiting_reporter_push';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'official-docs' WHERE "source_type" = 'official_docs';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'github-release' WHERE "source_type" = 'github_release';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'cve-db' WHERE "source_type" = 'cve_db';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'official-blog' WHERE "source_type" = 'official_blog';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'research-paper' WHERE "source_type" = 'research_paper';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'established-blog' WHERE "source_type" = 'established_blog';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'community-forum' WHERE "source_type" = 'community_forum';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'personal-blog' WHERE "source_type" = 'personal_blog';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'ai-generated' WHERE "source_type" = 'ai_generated';
--> statement-breakpoint
UPDATE "entry_source" SET "source_type" = 'reference-wiki' WHERE "source_type" = 'reference_wiki';
--> statement-breakpoint

-- Drop pre-v0.4 auto-named *_check siblings whose body still
-- carries snake values, so the NOT VALID *_values constraints
-- attached in 0000 are the only enum gate left on these columns.
DO $$
DECLARE _r RECORD;
BEGIN
  FOR _r IN
    SELECT c.conname AS cname, t.relname AS tname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname IN ('claim','verdict_log','claim_relation','claim_feedback','golden_set_claim','entry_source')
      AND c.contype = 'c'
      AND c.conname LIKE '%_check'
      AND pg_get_constraintdef(c.oid) ~* '(not_applicable|derives_from|superseded_by|reasoned_over|fully_false|scope_too_broad|time_expired|modality_too_strong|context_mismatch|partially_correct|finalized_inferred|awaiting_pull|expired_reporter_unavailable|skipped_backpressure|not_needed|awaiting_reporter_push|official_docs|github_release|cve_db|official_blog|research_paper|established_blog|community_forum|personal_blog|ai_generated|reference_wiki)'
  LOOP
    EXECUTE 'ALTER TABLE ' || quote_ident(_r.tname) || ' DROP CONSTRAINT ' || quote_ident(_r.cname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Flip every NOT VALID enum CHECK to enforced. Each VALIDATE re-
-- scans the table once; on fresh deployments that scan is instant
-- (empty), on legacy ones every row was rewritten above so the
-- scan succeeds.
ALTER TABLE "claim" VALIDATE CONSTRAINT "claim_verdict_values";
--> statement-breakpoint
ALTER TABLE "verdict_log" VALIDATE CONSTRAINT "verdict_log_verdict_values";
--> statement-breakpoint
ALTER TABLE "golden_set_claim" VALIDATE CONSTRAINT "golden_set_expected_verdict_values";
--> statement-breakpoint
ALTER TABLE "claim_relation" VALIDATE CONSTRAINT "claim_relation_type_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" VALIDATE CONSTRAINT "claim_feedback_application_method_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" VALIDATE CONSTRAINT "claim_feedback_failure_dimension_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" VALIDATE CONSTRAINT "claim_feedback_failure_dimension_inferred_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" VALIDATE CONSTRAINT "claim_feedback_enrichment_status_values";
--> statement-breakpoint
ALTER TABLE "entry_source" VALIDATE CONSTRAINT "entry_source_source_type_values";
--> statement-breakpoint
ALTER TABLE "feedback_log" VALIDATE CONSTRAINT "feedback_log_signal_values";
