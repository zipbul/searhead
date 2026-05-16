import { sql, eq, and } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { claim } from '../db/schema';
import { decodeUlidTimestamp } from '../lib/ulid-utils';
import { logger } from '../observability/logger';
import { FeedbackReason } from './enums';

interface RouteInput {
  entryId: string;
  reason: FeedbackReason;
  agentId: string;
  note?: string;
}

// Routes a structured feedback reason to its downstream action. Each
// branch is best-effort and isolated — a failure here is logged but
// must not roll back the authority update that the feedback handler
// already committed.
async function routeFeedbackAction(input: RouteInput): Promise<void> {
  const entryCreatedAt = new Date(decodeUlidTimestamp(input.entryId));
  switch (input.reason) {
    case FeedbackReason.Wrong:
      await reverifyEntryClaims(input.entryId, entryCreatedAt);
      return;
    case FeedbackReason.Outdated:
      // Re-research is heavier (LangSearch hit + ingest) and depends on
      // the topic; defer to a worker that batches outdated signals.
      await markOutdated(input.entryId, entryCreatedAt);
      return;
    case FeedbackReason.Missing:
      // The "missing" path applies when an agent expected knowledge
      // and didn't find it. The entry id here is the closest match,
      // not the missing item — so the action is to log a gap, not
      // mutate this entry. Gap-log table is added in a follow-up.
      logger.info({ entryId: input.entryId, agentId: input.agentId, note: input.note }, 'feedback: missing knowledge gap noted');
      return;
    case FeedbackReason.Used:
    case FeedbackReason.Helpful:
    case FeedbackReason.Irrelevant:
    case FeedbackReason.Other:
      // Authority update by feedback handler is sufficient. No extra
      // routing action.
      return;
    default:
      // Exhaustiveness guard: every FeedbackReason member is handled
      // above; a new member that lands without a case lights up here.
      logger.warn({ reason: input.reason }, 'feedback router: unknown reason — no-op');
  }
}

// Bumps every claim attached to the entry to the front of verify_queue
// so the grounder re-runs against current sources. Inserts queue rows
// for claims that aren't currently queued; resets attempts on rows
// already in flight so a previously-exhausted claim gets another shot.
async function reverifyEntryClaims(entryId: string, entryCreatedAt: Date): Promise<void> {
  const claims = await getDb()
    .select({ id: claim.id })
    .from(claim)
    .where(and(eq(claim.entryId, entryId), eq(claim.entryCreatedAt, entryCreatedAt)));
  if (claims.length === 0) {
    return;
  }

  for (const c of claims) {
    await getDb().execute(sql`
      INSERT INTO verify_queue (claim_id, queued_at, priority, attempts, next_attempt_at)
      VALUES (${c.id}, NOW(), 100, 0, NOW())
      ON CONFLICT (claim_id) DO UPDATE
      SET priority = GREATEST(verify_queue.priority, 100),
          attempts = 0,
          next_attempt_at = NOW()
    `);
  }
  logger.info({ entryId, claimsRequeued: claims.length }, 'feedback wrong: claims requeued for re-verification');
}

// Records an outdated signal on the entry by stamping its metadata.
// A follow-up worker reads recently-outdated entries and triggers a
// fresh LangSearch + ingest pass; we don't run that synchronously here
// because it can take 30s+ and the feedback caller is waiting.
async function markOutdated(entryId: string, entryCreatedAt: Date): Promise<void> {
  await getDb().execute(sql`
    UPDATE entry
    SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('outdated_at', NOW()::text)
    WHERE id = ${entryId} AND created_at = ${entryCreatedAt.toISOString()}::timestamptz
  `);
  // Also bump verify_queue for claims so a next pass re-grounds them
  // against whatever new evidence the re-research worker pulls in.
  await reverifyEntryClaims(entryId, entryCreatedAt);
  logger.info({ entryId }, 'feedback outdated: entry marked, claims requeued');
}

export { routeFeedbackAction };
