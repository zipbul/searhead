import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { logger } from './logger';
import { invariantQueueEligible, invariantOrphans } from './metrics';

// Periodic invariant checks. These queries encode the *shapes* the
// DB is supposed to stay in: queues drain, no orphaned FK rows,
// verdict↔evidence consistency, KG nodes reachable. Each value is
// published as a Prometheus gauge; an alert on non-zero
// `knoldr_orphan_rows{check=...}` catches data drift that the
// exception-based error logging will never see.
//
// All checks are shaped as "count up to N anomalies, cap at N" rather
// than full COUNT(*) so the runtime stays flat as tables grow. The
// cap is high enough to distinguish "none / a few / many" on the
// dashboard without forcing a sequential scan of millions of rows.

const ANOMALY_CAP = 1000;

const CHECKS: Array<{ name: string; sql: string; expect: 'zero' | 'monitor' }> = [
  {
    name: 'claim_missing_evidence_but_verified',
    sql: `
      SELECT COUNT(*)::int AS n FROM (
        SELECT 1 FROM claim
        WHERE verdict IN ('verified', 'disputed')
          AND evidence IS NULL
        LIMIT ${ANOMALY_CAP}
      ) s
    `,
    expect: 'zero',
  },
  {
    name: 'verify_queue_orphaned',
    sql: `
      SELECT COUNT(*)::int AS n FROM (
        SELECT 1
        FROM verify_queue vq
        LEFT JOIN claim c ON c.id = vq.claim_id
        WHERE c.id IS NULL
        LIMIT ${ANOMALY_CAP}
      ) s
    `,
    expect: 'zero',
  },
  {
    name: 'kg_relation_orphan_entity',
    sql: `
      SELECT COUNT(*)::int AS n FROM (
        SELECT 1
        FROM kg_relation r
        LEFT JOIN entity s ON s.id = r.source_entity_id
        LEFT JOIN entity t ON t.id = r.target_entity_id
        WHERE s.id IS NULL OR t.id IS NULL
        LIMIT ${ANOMALY_CAP}
      ) x
    `,
    expect: 'zero',
  },
  {
    name: 'entry_tag_orphan',
    sql: `
      SELECT COUNT(*)::int AS n FROM (
        SELECT 1
        FROM entry_tag et
        LEFT JOIN entry e ON e.id = et.entry_id AND e.created_at = et.entry_created_at
        WHERE e.id IS NULL
        LIMIT ${ANOMALY_CAP}
      ) s
    `,
    expect: 'zero',
  },
  {
    name: 'claim_stuck_in_queue_over_24h',
    sql: `
      SELECT COUNT(*)::int AS n FROM (
        SELECT 1
        FROM verify_queue
        WHERE queued_at < NOW() - INTERVAL '24 hours'
          AND attempts < 3
        LIMIT ${ANOMALY_CAP}
      ) s
    `,
    expect: 'monitor',
  },
];

const QUEUES = [
  {
    name: 'verify_queue',
    sql: `SELECT COUNT(*)::int AS n FROM (
      SELECT 1 FROM verify_queue WHERE attempts < 3 AND next_attempt_at <= NOW() LIMIT ${ANOMALY_CAP}
    ) s`,
  },
  {
    name: 'retry_queue',
    sql: `SELECT COUNT(*)::int AS n FROM (
      SELECT 1 FROM retry_queue WHERE attempts < 3 AND next_retry_at <= NOW() LIMIT ${ANOMALY_CAP}
    ) s`,
  },
];

export async function runInvariantChecks(): Promise<void> {
  for (const q of QUEUES) {
    try {
      const rows = (await getDb().execute(sql.raw(q.sql))) as unknown as Array<{ n: number }>;
      const n = rows[0]?.n ?? 0;
      invariantQueueEligible.set({ queue: q.name }, n);
    } catch (err) {
      logger.warn({ queue: q.name, error: (err as Error).message }, 'queue gauge failed');
    }
  }
  for (const c of CHECKS) {
    try {
      const rows = (await getDb().execute(sql.raw(c.sql))) as unknown as Array<{ n: number }>;
      const n = rows[0]?.n ?? 0;
      invariantOrphans.set({ check: c.name }, n);
      if (c.expect === 'zero' && n > 0) {
        logger.warn({ check: c.name, count: n }, 'invariant violated');
      }
    } catch (err) {
      logger.warn({ check: c.name, error: (err as Error).message }, 'invariant check failed');
    }
  }
}
