import { sql, eq, and } from 'drizzle-orm';
import { ulid } from 'ulid';

import { getDb } from '../db/connection';
import { entry, feedbackLog } from '../db/schema';
import { decodeUlidTimestamp } from '../lib/ulid-utils';
import { logger } from '../observability/logger';
import { feedbackTotal } from '../observability/metrics';

interface FeedbackResult {
  entryId: string;
  newAuthority: number;
}

/**
 * Process feedback signal on an entry.
 *
 * Concurrency model:
 *   1. `SELECT ... FOR UPDATE` on the target entry row inside a
 *      transaction. This serializes overlapping feedback calls on the
 *      same entry across ALL replicas without relying on a process-
 *      local lock.
 *   2. Rate-limit COUNTs run inside the same transaction against the
 *      committed log. The previous check-then-update pattern allowed
 *      concurrent requests from the same agent to all pass the 1/hour
 *      guard and compound the authority multiplier (reproduced in
 *      testing: 5 simultaneous negatives took authority 0.6 → 0.20).
 *   3. Authority update + feedback_log insert share the same commit
 *      boundary so a crash between UPDATE and INSERT can't leave the
 *      audit log without its corresponding score change.
 *
 * Negative floor: authority values very close to zero are set to
 * `max(0.05, authority * 0.8)` ONLY when the prior authority was
 * already above 0.05. Without this guard a negative signal on an
 * authority=0 entry paradoxically lifted it to 0.05 (0 * 0.8 = 0 but
 * GREATEST(0.05, 0) = 0.05). We clamp based on the PRIOR value so
 * legitimate zero-authority rows stay at zero.
 */
export async function processFeedback(
  entryId: string,
  signal: 'positive' | 'negative',
  reason: string | undefined,
  agentId: string,
): Promise<FeedbackResult> {
  // Extract created_at from ULID for partition routing
  const entryCreatedAt = new Date(decodeUlidTimestamp(entryId));
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return getDb().transaction(async tx => {
    // Row-lock the target entry. Any concurrent feedback TX on the same
    // entry blocks here until we commit/rollback. postgres-js's raw
    // binding doesn't accept Date objects for TIMESTAMPTZ parameters
    // through drizzle's sql template — cast to ISO string explicitly.
    const locked = await tx.execute(sql`
      SELECT authority FROM entry
      WHERE id = ${entryId} AND created_at = ${entryCreatedAt.toISOString()}::timestamptz
      FOR UPDATE
    `);
    const lockedRow = (locked as unknown as Array<{ authority: number }>)[0];
    if (!lockedRow) {
      throw new Error(`Entry not found: ${entryId}`);
    }
    const priorAuthority = lockedRow.authority;

    // Rate limits are computed inside the TX against the committed log;
    // since we hold the entry row lock, no other writer can insert a
    // competing feedback_log row for this entry concurrently.
    const agentRecent = await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM feedback_log
      WHERE agent_id = ${agentId}
        AND entry_id = ${entryId}
        AND created_at > ${oneHourAgo.toISOString()}::timestamptz
    `);
    if (((agentRecent as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0) > 0) {
      throw new RateLimitError('same agent+entry feedback limited to 1 per hour');
    }

    const entryRecent = await tx.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM feedback_log
      WHERE entry_id = ${entryId}
        AND created_at > ${oneHourAgo.toISOString()}::timestamptz
    `);
    if (((entryRecent as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0) >= 10) {
      throw new RateLimitError('entry feedback limited to 10 per hour');
    }

    // Authority update math:
    //   - negative: multiplicative decay (×0.8). When priorAuthority is
    //     already ≤0.05 we let it decay to 0 rather than clamping it
    //     back up to 0.05 — the previous GREATEST(0.05, ...) paradox
    //     *raised* dead entries on a negative signal.
    //   - positive: multiplicative boost (×1.1). A zero-authority entry
    //     is stuck at zero because 0×1.1 = 0; bootstrap to 0.05 so a
    //     legitimately useful entry that started with no sources can
    //     earn authority through positive feedback. Ceiling 1.0.
    let newAuthority: number;
    if (signal === 'negative') {
      newAuthority = priorAuthority > 0.05 ? Math.max(0.05, priorAuthority * 0.8) : priorAuthority * 0.8;
    } else {
      const BOOTSTRAP = 0.05;
      const boosted = priorAuthority > 0 ? priorAuthority * 1.1 : BOOTSTRAP;
      newAuthority = Math.min(1.0, boosted);
    }

    await tx
      .update(entry)
      .set({ authority: newAuthority })
      .where(and(eq(entry.id, entryId), eq(entry.createdAt, entryCreatedAt)));

    await tx.insert(feedbackLog).values({
      id: ulid(),
      entryId,
      entryCreatedAt,
      signal,
      reason,
      agentId,
    });

    feedbackTotal.inc({ signal });
    logger.info({ entryId, signal, newAuthority, agentId }, 'feedback processed');

    return { entryId, newAuthority };
  });
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}
