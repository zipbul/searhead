// FQA background workers. No A2A surface — the reporter-facing
// completion path runs through `claim_feedback` (update mode) on
// the main Knoldr A2A. This module wires the two periodic jobs:
//
//   - audit-and-enrich: every 5 min, LLM-infer missing fields from
//     audit_note and attempt push to the reporter's callback URL
//     when present.
//   - ttl-sweep: every 30 min, transition stale awaiting_pull rows
//     to expired_reporter_unavailable.
//
// Both are wrapped in a Postgres advisory lock so overlapping ticks
// and multi-replica deployments can't double-enrich.
//
// Opt-in: starts only when KNOLDR_FQA_WORKERS=1 (or implicitly when
// the main Knoldr process starts and the env hasn't disabled it).

import { logger } from "../observability/logger";
import { withClusterLock } from "../observability/worker-lock";
import { auditAndEnrich, expireStalePullTasks } from "./enrich";

export function startFqaWorkers(): void {
  // Honor opt-out for deployments that want FQA wholly disabled.
  if (process.env.KNOLDR_FQA_WORKERS === "0") {
    logger.info("FQA workers disabled by KNOLDR_FQA_WORKERS=0");
    return;
  }

  const auditMs = Number(
    process.env.KNOLDR_FQA_AUDIT_INTERVAL_MS ?? 5 * 60 * 1000,
  );
  setInterval(async () => {
    await withClusterLock("fqa-audit", async () => {
      try {
        const report = await auditAndEnrich({ timeWindowHours: 24, maxItems: 20 });
        if (report.scanned > 0) {
          logger.info({ ...report }, "FQA audit sweep complete");
        }
      } catch (err) {
        logger.error({ error: (err as Error).message }, "FQA audit sweep failed");
      }
    });
  }, auditMs);

  const ttlHours = Number(process.env.KNOLDR_FQA_PULL_TTL_HOURS ?? "24");
  const ttlMs = Number(
    process.env.KNOLDR_FQA_TTL_SWEEP_INTERVAL_MS ?? 30 * 60 * 1000,
  );
  setInterval(async () => {
    await withClusterLock("fqa-ttl-sweep", async () => {
      try {
        await expireStalePullTasks(ttlHours);
      } catch (err) {
        logger.error({ error: (err as Error).message }, "FQA TTL sweep failed");
      }
    });
  }, ttlMs);

  logger.info({ auditMs, ttlMs, ttlHours }, "FQA background workers started");
}
