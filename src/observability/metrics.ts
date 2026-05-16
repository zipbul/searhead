import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

const register = new Registry();
collectDefaultMetrics({ register });

// Ingestion metrics
export const ingestionTotal = new Counter({
  name: 'knoldr_ingestion_total',
  help: 'Total ingestion operations',
  labelNames: ['action'] as const,
  registers: [register],
});

export const ingestionLatency = new Histogram({
  name: 'knoldr_ingestion_latency_ms',
  help: 'Ingestion latency in milliseconds',
  registers: [register],
});

// Search metrics
export const searchTotal = new Counter({
  name: 'knoldr_search_total',
  help: 'Total search operations',
  registers: [register],
});

export const searchLatency = new Histogram({
  name: 'knoldr_search_latency_ms',
  help: 'Search latency in milliseconds',
  registers: [register],
});

// Feedback metrics
export const feedbackTotal = new Counter({
  name: 'knoldr_feedback_total',
  help: 'Total feedback operations',
  labelNames: ['signal'] as const,
  registers: [register],
});

// Verify pipeline metrics. Without these we're flying blind: the
// only signals were docker logs (grep for "error|failed") and DB
// count snapshots. Those catch exceptions but miss silent bugs
// (wrong verdicts, stage-level slowdowns, model under-use).
export const verifyVerdicts = new Counter({
  name: 'knoldr_verify_verdicts_total',
  help: 'Verdicts committed by source and outcome',
  labelNames: ['source', 'verdict'] as const,
  registers: [register],
});

export const verifyStageLatency = new Histogram({
  name: 'knoldr_verify_stage_latency_ms',
  help: 'Per-stage latency in the verify pipeline',
  labelNames: ['stage'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 180_000],
  registers: [register],
});

export const verifyErrors = new Counter({
  name: 'knoldr_verify_errors_total',
  help: 'Verify pipeline errors by kind',
  labelNames: ['kind'] as const,
  registers: [register],
});

// Invariant gauges. Updated every minute by the invariants worker.
export const invariantQueueEligible = new Gauge({
  name: 'knoldr_queue_eligible',
  help: 'Eligible items in queues (attempts < 3, next_attempt_at <= now)',
  labelNames: ['queue'] as const,
  registers: [register],
});

export const invariantOrphans = new Gauge({
  name: 'knoldr_orphan_rows',
  help: 'Row count of orphaned / inconsistent rows per check',
  labelNames: ['check'] as const,
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}
