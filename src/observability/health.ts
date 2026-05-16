import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';

// Ollama reachability cache: Bun's fetch has no DNS cache, so a
// /health that hits host.docker.internal:11434 on every probe adds
// latency that stacks up on docker healthcheck cadence. Re-check
// once per minute — plenty for human-debug accuracy.
interface LlmCache {
  ok: boolean;
  at: number;
}
let llmCache: LlmCache | null = null;
const LLM_TTL_MS = 60_000;

async function probeOllama(): Promise<boolean> {
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getLlmStatus(): Promise<boolean> {
  const now = Date.now();
  if (llmCache && now - llmCache.at < LLM_TTL_MS) {
    return llmCache.ok;
  }
  const ok = await probeOllama();
  llmCache = { ok, at: now };
  return ok;
}

export async function getHealthStatus() {
  const startTime = Date.now();

  let dbStatus = 'down';
  try {
    // Cheap liveness probe — no row scan. The previous implementation
    // called `SELECT COUNT(*) FROM entry` which was fine at 13k rows
    // but would regress to seconds at 10M, causing docker healthcheck
    // timeouts and pointless restart loops.
    await getDb().execute(sql`SELECT 1`);
    dbStatus = 'up';
  } catch {
    dbStatus = 'down';
  }

  const llmOk = await getLlmStatus();

  return {
    db: dbStatus,
    llm: llmOk ? 'up' : 'down',
    embedding: 'local',
    uptime: process.uptime(),
    latencyMs: Date.now() - startTime,
  };
}
