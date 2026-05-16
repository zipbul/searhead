import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
} from '@a2a-js/sdk/server';

import { processRetryQueue } from '../ingest/retry-runner';
import { logger } from '../observability/logger';
import { withClusterLock } from '../observability/worker-lock';
import { agentCard } from './agent-card';
import { authenticate, requireTokenOrThrow } from './auth';
import { KnoldrExecutor } from './dispatcher';

// Hard cap on request body size. A2A payloads are JSON-RPC with small
// `input` objects; any legitimate request is <1MB. Anything larger is
// either buggy client batching or an attempt to exhaust memory by
// streaming a huge body before zod validation runs.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

let transportHandler: JsonRpcTransportHandler;

function getTransportHandler(): JsonRpcTransportHandler {
  if (!transportHandler) {
    const executor = new KnoldrExecutor();
    const taskStore = new InMemoryTaskStore();
    const eventBusManager = new DefaultExecutionEventBusManager();

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor, eventBusManager);

    transportHandler = new JsonRpcTransportHandler(requestHandler);
  }
  return transportHandler;
}

function startServer() {
  requireTokenOrThrow();
  const port = Number(process.env.KNOLDR_PORT ?? 5100);
  const host = process.env.KNOLDR_HOST ?? '0.0.0.0';

  const server = Bun.serve({
    port,
    hostname: host,
    // `find` auto-research can run for minutes (LangSearch + LLM decompose +
    // embed). Bun's default idleTimeout (10s) closes the SSE stream before
    // the final event arrives, so raise it to cover the research budget.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Agent Card — no auth required
      if (req.method === 'GET' && path === '/.well-known/agent-card.json') {
        return Response.json(agentCard);
      }

      // Health check — no auth required
      if (req.method === 'GET' && path === '/health') {
        const { getHealthStatus } = await import('../observability/health');
        return Response.json(await getHealthStatus());
      }

      // Metrics — no auth required
      if (req.method === 'GET' && path === '/metrics') {
        const { getMetrics } = await import('../observability/metrics');
        const metrics = await getMetrics();
        return new Response(metrics, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      // A2A JSON-RPC endpoint — auth required
      if (req.method === 'POST' && path === '/a2a') {
        if (!authenticate(req)) {
          return Response.json({ jsonrpc: '2.0', error: { code: 1004, message: 'Unauthorized' }, id: null }, { status: 401 });
        }

        // Enforce body-size cap before parsing. We read the body via
        // req.arrayBuffer() (not req.json()) so a client that lies about
        // Content-Length can't sneak past the limit — we count the
        // actual bytes we consumed.
        const declared = Number(req.headers.get('content-length') ?? -1);
        if (declared > MAX_BODY_BYTES) {
          return Response.json(
            { jsonrpc: '2.0', error: { code: -32600, message: 'Payload too large' }, id: null },
            { status: 413 },
          );
        }

        try {
          const buf = await req.arrayBuffer();
          if (buf.byteLength > MAX_BODY_BYTES) {
            return Response.json(
              { jsonrpc: '2.0', error: { code: -32600, message: 'Payload too large' }, id: null },
              { status: 413 },
            );
          }
          let body: unknown;
          try {
            body = JSON.parse(new TextDecoder().decode(buf));
          } catch {
            return Response.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, { status: 400 });
          }
          const handler = getTransportHandler();
          const result = await handler.handle(body);

          // handle() returns JSONRPCResponse for `message/send` or an
          // AsyncGenerator for `message/stream`/`tasks/resubscribe`.
          if (isAsyncGenerator(result)) {
            return streamSse(result);
          }

          return Response.json(result);
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'A2A request failed');
          return Response.json(
            {
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal error' },
              id: null,
            },
            { status: 500 },
          );
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  // Partition rollover — daily. Creates next-year's entry partition
  // when within 30 days of the year boundary. migrate.ts only
  // pre-creates currentYear+1 at install time; without this worker
  // a 2026-12-31 production write would fail because no 2027
  // partition exists. Idempotent CREATE IF NOT EXISTS.
  setInterval(
    async () => {
      await withClusterLock('partition-rollover', async () => {
        try {
          const now = new Date();
          const yearEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
          const daysUntilBoundary = (yearEnd.getTime() - now.getTime()) / (24 * 3600 * 1000);
          if (daysUntilBoundary > 30) {
            return;
          }
          const { getDb } = await import('../db/connection');
          const { sql } = await import('drizzle-orm');
          const nextYear = now.getUTCFullYear() + 1;
          const partName = `entry_${nextYear}`;
          await getDb().execute(
            sql.raw(
              `CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF entry
             FOR VALUES FROM ('${nextYear}-01-01') TO ('${nextYear + 1}-01-01')`,
            ),
          );
          logger.info({ partName, daysUntilBoundary: Math.round(daysUntilBoundary) }, 'next-year partition ensured');
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'partition rollover failed');
        }
      });
    },
    24 * 3600 * 1000,
  ); // daily

  // Batch dedup job — daily at UTC 03:00.
  // Uses Postgres advisory lock so only ONE replica runs it even in a
  // scaled deployment. The process-local lastDedupDate was meaningless
  // across multiple processes; the lock is the durable guard.
  setInterval(
    async () => {
      const now = new Date();
      if (now.getUTCHours() < 3) {
        return;
      }
      await withClusterLock('batch-dedup-daily', async () => {
        // Extra guard: only run once per UTC day globally. We record the
        // latest run in a claim/claim-less way — leverage a Postgres
        // table-less CTE with now() check instead of introducing a new
        // table. Advisory lock alone allows repeated runs within the
        // same hour; the >1h `INTERVAL` check keeps us to one per day.
        try {
          const { getDb } = await import('../db/connection');
          const { sql } = await import('drizzle-orm');
          const r = (await getDb().execute(sql`
          SELECT MAX(ingested_at) AS last_run
          FROM ingest_log
          WHERE action = 'duplicate'
            AND reason LIKE 'batch_dedup:%'
        `)) as unknown as Array<{ last_run: Date | null }>;
          const last = r[0]?.last_run ? new Date(r[0].last_run).getTime() : 0;
          if (Date.now() - last < 20 * 3600 * 1000) {
            return;
          }
          const { batchDedup } = await import('../collect/batch-dedup');
          await batchDedup();
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'batch dedup failed');
        }
      });
    },
    10 * 60 * 1000,
  ); // check every 10 minutes

  // Retry queue processor — every 5 minutes
  setInterval(
    async () => {
      await withClusterLock('retry-queue', async () => {
        try {
          await processRetryQueue();
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'retry queue processing failed');
        }
      });
    },
    5 * 60 * 1000,
  );

  // Reclassify worker — every 90 seconds, batch=3
  // Picks entries stored with default metadata (0 tags) and re-runs
  // batch classify to fill in domain/tags/decayRate. Covers the case
  // where the original classify LLM call failed during research.
  setInterval(async () => {
    await withClusterLock('reclassify-queue', async () => {
      try {
        const { processReclassifyQueue } = await import('../collect/reclassify-queue');
        await processReclassifyQueue(3);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'reclassify worker failed');
      }
    });
  }, 90 * 1000);

  // Claim extraction worker — every 60 seconds, batch=3
  // Picks recently stored entries without claims and extracts them
  // serially. Separated from ingest so bursty research doesn't
  // saturate Ollama with dozens of concurrent generations that each
  // hold a model in memory.
  setInterval(async () => {
    await withClusterLock('claim-extract', async () => {
      try {
        const { processClaimExtractionQueue } = await import('../claim/extract-queue');
        await processClaimExtractionQueue(3);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'claim extraction worker failed');
      }
    });
  }, 60 * 1000);

  // KG triple extraction worker — every 120 seconds, batch=3
  setInterval(async () => {
    await withClusterLock('kg-extract', async () => {
      try {
        const { processKgExtractionQueue } = await import('../kg/extract-queue');
        await processKgExtractionQueue(3);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'KG extraction worker failed');
      }
    });
  }, 120 * 1000);

  // Claim verify queue processor — every 60 seconds, batch=6.
  //
  // Sizing tradeoff: each claim's verify runs source-fetch + JSDOM
  // parse + NLI forward + reranker forward + embedding + optional
  // CoVe/jury branches. The ML passes run on onnxruntime worker
  // threads that saturate whatever cores are available, so a batch
  // of 15 fanned out with Promise.allSettled was eating ~24 cores
  // and starving every other worker in the same container. 6 is
  // small enough to leave headroom for reclassify / claim extract
  // / invariants / health, yet large enough to overlap the
  // network-bound waits meaningfully.
  setInterval(async () => {
    await withClusterLock('verify-queue', async () => {
      try {
        const { processVerifyQueue, updateFactualityScore } = await import('../claim/verify');
        const processed = await processVerifyQueue(6);
        if (processed > 0) {
          // Recompute factuality for entries touched by this batch.
          const { getDb } = await import('../db/connection');
          const { claim } = await import('../db/schema');
          const { sql } = await import('drizzle-orm');
          const recent = await getDb()
            .selectDistinct({
              entryId: claim.entryId,
              entryCreatedAt: claim.entryCreatedAt,
            })
            .from(claim)
            .where(sql`${claim.createdAt} > NOW() - INTERVAL '1 hour'`);
          for (const r of recent) {
            await updateFactualityScore(r.entryId, r.entryCreatedAt);
          }
        }
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'verify queue processing failed');
      }
    });
  }, 60 * 1000);

  // Calibration worker — every 30 minutes. Sweeps NLI thresholds
  // against pseudo-gold (signal-agreement) labels and writes the
  // best (support, refute) cutoffs to calibration_state. Verify
  // workers pick up the new values within ~60s via cache TTL.
  setInterval(
    async () => {
      await withClusterLock('calibration', async () => {
        try {
          const { calibrate } = await import('../claim/calibration');
          await calibrate();
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'calibration failed');
        }
      });
    },
    30 * 60 * 1000,
  );

  // Drift detector — every 6 hours, batch=5. Re-verifies the oldest
  // verified/disputed claims; demotes verdicts that no longer hold
  // under current sources or current model. Runs at low rate so it
  // doesn't crowd out the live verify queue.
  setInterval(
    async () => {
      await withClusterLock('drift', async () => {
        try {
          const { detectDrift } = await import('../claim/reverify');
          await detectDrift(5);
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'drift detection failed');
        }
      });
    },
    6 * 60 * 60 * 1000,
  );

  // Invariant checks — every minute. Publishes Prometheus gauges
  // for queue eligibility, orphan rows, evidence consistency. Alerts
  // fire from the metrics, not the code: a non-zero orphan count is
  // the signal. Cheap to run (all SELECT COUNT), safe on hot DB.
  setInterval(async () => {
    await withClusterLock('invariants', async () => {
      try {
        const { runInvariantChecks } = await import('../observability/invariants');
        await runInvariantChecks();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'invariant checks failed');
      }
    });
  }, 60 * 1000);

  // Smoke evaluation — every hour. Samples 20 high-consensus
  // verdicts, re-verifies through the current pipeline, flags
  // divergences. Without a gold set this is our proxy for regression
  // detection: a sudden spike in divergence means something shifted.
  setInterval(
    async () => {
      await withClusterLock('smoke-eval', async () => {
        try {
          const { runSmokeEval } = await import('../claim/smoke-eval');
          await runSmokeEval();
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'smoke eval failed');
        }
      });
    },
    60 * 60 * 1000,
  );

  logger.info({ port, host }, 'knoldr A2A server started');
  return server;
}

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator {
  return obj !== null && typeof obj === 'object' && Symbol.asyncIterator in (obj as object);
}

/** Forward an A2A SDK AsyncGenerator as a text/event-stream response.
 * Emits an SSE comment line every KEEPALIVE_MS so the TCP connection
 * does not hit Bun's idleTimeout between executor events. */
function streamSse(gen: AsyncGenerator<unknown>): Response {
  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 15_000;

  const stream = new ReadableStream({
    async start(controller) {
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // controller may already be closed
        }
      }, KEEPALIVE_MS);

      try {
        for await (const event of gen) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        const payload = {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        logger.error({ error: (err as Error).message }, 'A2A stream failed');
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export { startServer };
