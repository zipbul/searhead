import { describe, test, expect, afterAll, afterEach } from 'bun:test';

import { IngestAction, SourceType } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from '../helpers/mock-apis';

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19876';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:11499';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';
process.env.KNOLDR_OLLAMA_JURY_MODELS = 'mock';
process.env.KNOLDR_PORT = '19960';
process.env.KNOLDR_API_TOKEN = 'test-token';

let server: ReturnType<typeof Bun.serve> | null = null;

// Probe the DB once at module load. `test.skipIf(...)` evaluates at
// registration time, so the flag must be known before tests register.
// If TEST_DATABASE_URL points at a reachable Postgres, dbAvailable
// becomes true; otherwise every test in this file skips cleanly.
const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19876);
    startMockOllamaServer(11499);
    const { startServer } = await import('../../src/a2a/server');
    server = startServer();
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable:', (err as Error).message);
    return false;
  }
})();

const A2A_URL = 'http://localhost:19960';

async function a2aSend(skill: string, input: Record<string, unknown> = {}) {
  const res = await fetch(`${A2A_URL}/a2a`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `req-${Date.now()}`,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: `msg-${Date.now()}`,
          role: 'user',
          parts: [{ kind: 'data', data: { skill, input } }],
        },
      },
    }),
  });
  return res.json();
}

afterEach(async () => {
  if (dbAvailable) {
    await cleanTestDb();
  }
});

afterAll(async () => {
  server?.stop();
  stopMockServers();
  if (dbAvailable) {
    await teardownTestDb();
  }
});

// ============================================================
// Agent Card
// ============================================================
describe('A2A — Agent Card', () => {
  test.skipIf(!dbAvailable)('exposes the v0.4 skill surface', async () => {
    const res = await fetch(`${A2A_URL}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      name: string;
      capabilities: { streaming: boolean };
      skills: Array<{ id: string }>;
    };
    expect(card.name).toBe('knoldr');
    expect(card.capabilities.streaming).toBe(true);
    const ids = card.skills.map(s => s.id).sort();
    expect(ids).toEqual(['claim_feedback', 'contradictions', 'feedback', 'find', 'ingest', 'neighbors', 'provenance']);
  });
});

// ============================================================
// Health
// ============================================================
describe('A2A — Health', () => {
  test.skipIf(!dbAvailable)('GET /health reports db up', async () => {
    const res = await fetch(`${A2A_URL}/health`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as { db: string };
    expect(health.db).toBe('up');
  });
});

// ============================================================
// Auth
// ============================================================
describe('A2A — Auth', () => {
  test.skipIf(!dbAvailable)('rejects request without bearer token', async () => {
    const res = await fetch(`${A2A_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-noauth',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'm-noauth',
            role: 'user',
            parts: [{ kind: 'data', data: { skill: 'find', input: { query: 'x' } } }],
          },
        },
      }),
    });
    expect(res.status).toBe(401);
  });
});

// ============================================================
// find — core search skill
// ============================================================
describe('A2A — find', () => {
  test.skipIf(!dbAvailable)('returns stored entries as a shaped response', async () => {
    // Seed an entry directly through the ingest engine so find has something
    // to return without triggering auto-research (which would hit the
    // network in an integration run).
    const { ingest } = await import('../../src/ingest/engine');
    const { parseStoreInput } = await import('../../src/ingest/validate');
    const seeded = await ingest(
      parseStoreInput({
        entries: [
          {
            title: 'pgvector HNSW index tuning notes',
            content: 'pgvector supports HNSW indexes. Tune ef_construction and m parameters for recall/latency trade-off.',
            domain: ['pgvector'],
            tags: ['hnsw'],
            language: 'en',
          },
          {
            title: 'pgvector approximate nearest neighbor',
            content: 'Approximate nearest neighbor search via HNSW indexes in pgvector improves query latency substantially.',
            domain: ['pgvector'],
            tags: ['ann'],
            language: 'en',
          },
          {
            title: 'pgvector ivfflat background',
            content: 'ivfflat is the other pgvector index family; HNSW usually wins for high-dimensional recall.',
            domain: ['pgvector'],
            tags: ['ivfflat'],
            language: 'en',
          },
        ],
      }),
    );
    expect(seeded.filter(r => r.action === IngestAction.Stored).length).toBeGreaterThanOrEqual(3);

    const result = (await a2aSend('find', {
      query: 'pgvector HNSW',
      limit: 5,
    })) as {
      result?: {
        parts?: Array<{
          data?: {
            entries?: Array<{ id: string; title: string }>;
            researched?: boolean;
          };
        }>;
      };
    };

    const data = result.result?.parts?.[0]?.data;
    expect(data).toBeDefined();
    expect(data?.entries).toBeArray();
    expect((data?.entries ?? []).length).toBeGreaterThan(0);
    expect(typeof data?.researched).toBe('boolean');
  });
});

// ============================================================
// feedback — authority adjustment skill
// ============================================================
describe('A2A — feedback', () => {
  test.skipIf(!dbAvailable)('applies positive feedback and increases authority', async () => {
    const { ingest } = await import('../../src/ingest/engine');
    const { parseStoreInput } = await import('../../src/ingest/validate');
    const seeded = await ingest(
      parseStoreInput({
        entries: [
          {
            title: 'Feedback test entry',
            content: 'Entry used to exercise the feedback skill end to end via A2A.',
            domain: ['testing'],
            language: 'en',
          },
        ],
        sources: [{ url: 'https://docs.example.com', sourceType: SourceType.OfficialDocs }],
      }),
    );
    const entryId = seeded[0]!.entryId;
    expect(entryId).toBeTruthy();

    const first = (await a2aSend('feedback', {
      entryId,
      signal: 'positive',
      agentId: 'integration-agent-1',
    })) as {
      result?: { parts?: Array<{ data?: { ok?: boolean; newAuthority?: number } }> };
    };
    const firstData = first.result?.parts?.[0]?.data;
    expect(firstData?.ok).toBe(true);
    expect(firstData?.newAuthority).toBeGreaterThan(0.8);
  });

  test.skipIf(!dbAvailable)('rate-limits the same agent on the same entry', async () => {
    const { ingest } = await import('../../src/ingest/engine');
    const { parseStoreInput } = await import('../../src/ingest/validate');
    const seeded = await ingest(
      parseStoreInput({
        entries: [
          {
            title: 'Rate-limit fixture entry',
            content: 'Another unique content body for a fresh embedding.',
            domain: ['testing'],
            language: 'en',
          },
        ],
      }),
    );
    const entryId = seeded[0]!.entryId;

    const first = (await a2aSend('feedback', {
      entryId,
      signal: 'positive',
      agentId: 'rate-limit-agent',
    })) as {
      result?: { parts?: Array<{ data?: { ok?: boolean } }> };
    };
    expect(first.result?.parts?.[0]?.data?.ok).toBe(true);

    const second = (await a2aSend('feedback', {
      entryId,
      signal: 'negative',
      agentId: 'rate-limit-agent',
    })) as {
      result?: {
        parts?: Array<{ data?: { ok?: boolean; error?: string } }>;
      };
    };
    const secondData = second.result?.parts?.[0]?.data;
    expect(secondData?.ok).toBe(false);
    expect(secondData?.error).toBe('rate_limited');
  });

  test.skipIf(!dbAvailable)('reports invalid_input for bad payloads', async () => {
    const result = (await a2aSend('feedback', {
      // Missing entryId / agentId; signal is a bogus value.
      signal: 'maybe',
    })) as {
      result?: { parts?: Array<{ data?: { ok?: boolean; error?: string } }> };
    };
    const data = result.result?.parts?.[0]?.data;
    expect(data?.ok).toBe(false);
    expect(data?.error).toBe('invalid_input');
  });
});

// ============================================================
// Dispatcher
// ============================================================
describe('A2A — unknown skill', () => {
  test.skipIf(!dbAvailable)('returns a typed error message', async () => {
    const result = (await a2aSend('does-not-exist')) as {
      result?: { parts?: Array<{ data?: { error?: string } }> };
    };
    expect(result.result?.parts?.[0]?.data?.error).toContain('Unknown skill');
  });
});
