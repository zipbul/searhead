// FQA background workers. No A2A surface — the reporter-facing
// completion path runs through `claim_feedback` (update mode) on
// the main Knoldr A2A.
//
// Primary enrichment path is *event-driven*: the claim_feedback
// insert handler calls enqueueEnrichment(id) which kicks an in-
// process FIFO drainer (see queue.ts). Latency is ~1s, not minutes.
//
// This module wires two SAFETY-NET periodic jobs:
//   - audit-and-enrich: catches rows the in-process drainer missed
//     (e.g., the process crashed between insert and dispatch, or
//     a multi-replica deployment where the insert landed on a
//     different node). Defaults to 5 min cadence with a small
//     drain cap.
//   - ttl-sweep: every 30 min, transitions stale awaiting_pull
//     rows to expired_reporter_unavailable.
//
// Both are wrapped in a Postgres advisory lock so overlapping ticks
// and multi-replica deployments can't double-enrich.
//
// Knobs (env):
//   KNOLDR_FQA_AUDIT_INTERVAL_MS    default 300_000 (5 min)
//   KNOLDR_FQA_AUDIT_BATCH          default 50
//   KNOLDR_FQA_AUDIT_WINDOW_HOURS   default 24
//   KNOLDR_FQA_AUDIT_MAX_DRAIN      default 5 (cap on chained
//                                   drain cycles — safety-net runs
//                                   shouldn't monopolize the lock)
//   KNOLDR_FQA_PULL_TTL_HOURS       default 24
//   KNOLDR_FQA_TTL_SWEEP_INTERVAL_MS default 30 min
//   KNOLDR_FQA_WORKERS=0            disables both workers

import { logger } from '../observability/logger';
import { withClusterLock } from '../observability/worker-lock';
import { auditAndEnrich, expireStalePullTasks } from './enrich';

export function startFqaWorkers(): void {
  // Honor opt-out for deployments that want FQA wholly disabled.
  if (process.env.KNOLDR_FQA_WORKERS === '0') {
    logger.info('FQA workers disabled by KNOLDR_FQA_WORKERS=0');
    return;
  }

  const auditMs = Number(process.env.KNOLDR_FQA_AUDIT_INTERVAL_MS ?? 5 * 60 * 1000);
  const batchSize = Number(process.env.KNOLDR_FQA_AUDIT_BATCH ?? 50);
  const windowHours = Number(process.env.KNOLDR_FQA_AUDIT_WINDOW_HOURS ?? 24);
  const maxDrain = Number(process.env.KNOLDR_FQA_AUDIT_MAX_DRAIN ?? 5);

  // Continuous-drain sweep:
  // - Acquire the lock once per tick.
  // - Pull a batch. If scanned === batchSize the queue may have
  //   more; pull again immediately. Repeat up to maxDrain times.
  // - Release the lock between ticks so a co-located finetune cycle
  //   or a sibling replica can take a turn.
  const runDrainCycle = async (): Promise<void> => {
    await withClusterLock('fqa-audit', async () => {
      let drainPasses = 0;
      let totalScanned = 0;
      let totalEnriched = 0;
      const skippedAgg = new Map<string, number>();
      try {
        for (let i = 0; i < maxDrain; i++) {
          const report = await auditAndEnrich({
            timeWindowHours: windowHours,
            maxItems: batchSize,
          });
          totalScanned += report.scanned;
          totalEnriched += report.enriched;
          for (const s of report.skipped) {
            skippedAgg.set(s.reason, (skippedAgg.get(s.reason) ?? 0) + s.count);
          }
          drainPasses++;
          if (report.scanned < batchSize) {
            break;
          } // queue drained
        }
        if (totalScanned > 0) {
          logger.info(
            {
              drainPasses,
              totalScanned,
              totalEnriched,
              skipped: Array.from(skippedAgg, ([reason, count]) => ({
                reason,
                count,
              })),
              hitDrainCap: drainPasses === maxDrain,
            },
            'FQA audit drain complete',
          );
        }
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'FQA audit drain failed');
      }
    });
  };

  setInterval(runDrainCycle, auditMs);

  const ttlHours = Number(process.env.KNOLDR_FQA_PULL_TTL_HOURS ?? '24');
  const ttlMs = Number(process.env.KNOLDR_FQA_TTL_SWEEP_INTERVAL_MS ?? 30 * 60 * 1000);
  setInterval(async () => {
    await withClusterLock('fqa-ttl-sweep', async () => {
      try {
        await expireStalePullTasks(ttlHours);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'FQA TTL sweep failed');
      }
    });
  }, ttlMs);

  logger.info({ auditMs, batchSize, windowHours, maxDrain, ttlMs, ttlHours }, 'FQA background workers started');
}
