import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';

import { FeedbackReason, IngestAction, Signal, SourceType } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb, getTestClient } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from '../helpers/mock-apis';

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19876';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:11499';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';
process.env.KNOLDR_OLLAMA_JURY_MODELS = 'mock';

let processFeedback: typeof import('../../src/score/feedback').processFeedback;
let RateLimitError: typeof import('../../src/score/feedback').RateLimitError;
let ingest: typeof import('../../src/ingest/engine').ingest;
let parseStoreInput: typeof import('../../src/ingest/validate').parseStoreInput;

// Top-level probe so `test.skipIf(...)` evaluates at registration time.
const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19876);
    startMockOllamaServer(11499);
    const fbMod = await import('../../src/score/feedback');
    processFeedback = fbMod.processFeedback;
    RateLimitError = fbMod.RateLimitError;
    const engineMod = await import('../../src/ingest/engine');
    ingest = engineMod.ingest;
    const validateMod = await import('../../src/ingest/validate');
    parseStoreInput = validateMod.parseStoreInput;
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable, skipping feedback tests:', (err as Error).message);
    return false;
  }
})();

afterEach(async () => {
  if (dbAvailable) {
    await cleanTestDb();
  }
});

afterAll(async () => {
  stopMockServers();
  if (dbAvailable) {
    await teardownTestDb();
  }
});

let entryCounter = 0;
async function createTestEntry() {
  entryCounter++;
  // fakeEmbedding in mock-apis.ts hashes only the first 384 chars position
  // by position, so varying tokens must appear early in the string to
  // yield distinct vectors. Put the unique id at the very start.
  const uniqueId = `${entryCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const input = parseStoreInput({
    entries: [
      {
        title: `${uniqueId} Feedback Test Entry`,
        content: `${uniqueId} Completely unique and different content for feedback testing.`,
        domain: [`testing-${entryCounter}`],
      },
    ],
    sources: [{ url: 'https://docs.example.com', sourceType: SourceType.OfficialDocs }],
  });
  const results = await ingest(input);
  if (results[0]!.action !== IngestAction.Stored || !results[0]!.entryId) {
    throw new Error(`createTestEntry failed: action=${results[0]!.action}`);
  }
  return results[0]!.entryId;
}

describe('Feedback — authority adjustment', () => {
  test.skipIf(!dbAvailable)('positive feedback increases authority', async () => {
    const entryId = await createTestEntry();
    const sql = getTestClient();
    const before = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    const beforeAuth = before[0]!.authority as number;

    const result = await processFeedback(entryId, Signal.Positive, undefined, 'agent-1');
    expect(result.newAuthority).toBeGreaterThan(beforeAuth);
    // LEAST(1.0, authority * 1.1)
    expect(result.newAuthority).toBeCloseTo(Math.min(1.0, beforeAuth * 1.1), 3);
  });

  test.skipIf(!dbAvailable)('negative feedback decreases authority', async () => {
    const entryId = await createTestEntry();
    const sql = getTestClient();
    const before = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    const beforeAuth = before[0]!.authority as number;

    const result = await processFeedback(entryId, Signal.Negative, FeedbackReason.Outdated, 'agent-1');
    expect(result.newAuthority).toBeLessThan(beforeAuth);
    // GREATEST(0.05, authority * 0.8)
    expect(result.newAuthority).toBeCloseTo(Math.max(0.05, beforeAuth * 0.8), 3);
  });

  test.skipIf(!dbAvailable)('authority never drops below 0.05', async () => {
    const entryId = await createTestEntry();

    // Apply many negative feedbacks (from different agents)
    for (let i = 0; i < 20; i++) {
      try {
        await processFeedback(entryId, Signal.Negative, undefined, `agent-${i}`);
      } catch {
        // rate limit is fine
      }
    }

    const sql = getTestClient();
    const after = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    expect(after[0]!.authority as number).toBeGreaterThanOrEqual(0.05);
  });

  test.skipIf(!dbAvailable)('authority never exceeds 1.0', async () => {
    const entryId = await createTestEntry();

    for (let i = 0; i < 10; i++) {
      try {
        await processFeedback(entryId, Signal.Positive, undefined, `agent-${i}`);
      } catch {
        // rate limit
      }
    }

    const sql = getTestClient();
    const after = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    expect(after[0]!.authority as number).toBeLessThanOrEqual(1.0);
  });
});

describe('Feedback — rate limiting', () => {
  test.skipIf(!dbAvailable)('same agent+entry blocked within 1 hour', async () => {
    const entryId = await createTestEntry();
    await processFeedback(entryId, Signal.Positive, undefined, 'agent-rl');

    await expect(processFeedback(entryId, Signal.Positive, undefined, 'agent-rl')).rejects.toThrow(RateLimitError);
  });

  test.skipIf(!dbAvailable)('different agent on same entry is allowed', async () => {
    const entryId = await createTestEntry();
    await processFeedback(entryId, Signal.Positive, undefined, 'agent-a');

    // Different agent should work
    const result = await processFeedback(entryId, Signal.Positive, undefined, 'agent-b');
    expect(result.newAuthority).toBeGreaterThan(0);
  });

  test.skipIf(!dbAvailable)('same agent on different entries is allowed', async () => {
    const entryId1 = await createTestEntry();
    const entryId2 = await createTestEntry();

    await processFeedback(entryId1, Signal.Positive, undefined, 'agent-x');
    const result = await processFeedback(entryId2, Signal.Positive, undefined, 'agent-x');
    expect(result.newAuthority).toBeGreaterThan(0);
  });
});

describe('Feedback — audit log', () => {
  test.skipIf(!dbAvailable)('feedback is recorded in feedback_log', async () => {
    const entryId = await createTestEntry();
    await processFeedback(entryId, Signal.Negative, 'test reason', 'agent-log');

    const sql = getTestClient();
    const logs = await sql`SELECT signal, reason, agent_id FROM feedback_log WHERE entry_id = ${entryId}`;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.signal).toBe(Signal.Negative);
    expect(logs[0]!.reason).toBe('test reason');
    expect(logs[0]!.agent_id).toBe('agent-log');
  });
});

describe('Feedback — structured-reason routing', () => {
  let routeFeedbackAction: typeof import('../../src/score/feedback-router').routeFeedbackAction;

  beforeAll(async () => {
    const mod = await import('../../src/score/feedback-router');
    routeFeedbackAction = mod.routeFeedbackAction;
  });

  async function createEntryWithClaim(): Promise<{ entryId: string; claimId: string }> {
    const entryId = await createTestEntry();
    const sql = getTestClient();
    const [entryRow] = await sql`SELECT created_at FROM entry WHERE id = ${entryId}`;
    if (!entryRow) {
      throw new Error('entry not found');
    }
    const claimId = `01TEST${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`.padEnd(26, 'X').slice(0, 26);
    // Embedding column requires vector(384); use zero-padded literal.
    const zeroVec = `[${new Array(384).fill(0).join(',')}]`;
    await sql`
      INSERT INTO claim (id, entry_id, entry_created_at, statement, type, verdict, certainty, embedding, created_at)
      VALUES (${claimId}, ${entryId}, ${entryRow.created_at as Date}, 'test claim', 'factual', 'unverified', 0.5, ${zeroVec}::vector, NOW())
    `;
    return { entryId, claimId };
  }

  test.skipIf(!dbAvailable)('wrong reason re-queues claims with high priority', async () => {
    const { entryId, claimId } = await createEntryWithClaim();

    await routeFeedbackAction({
      entryId,
      reason: FeedbackReason.Wrong,
      agentId: 'agent-route',
    });

    const sql = getTestClient();
    const [vq] = await sql`
      SELECT priority, attempts FROM verify_queue WHERE claim_id = ${claimId}
    `;
    expect(vq).toBeDefined();
    expect(Number(vq!.priority)).toBeGreaterThanOrEqual(100);
    expect(Number(vq!.attempts)).toBe(0);
  });

  test.skipIf(!dbAvailable)('outdated reason marks entry metadata + bumps verify_queue', async () => {
    const { entryId, claimId } = await createEntryWithClaim();

    await routeFeedbackAction({
      entryId,
      reason: FeedbackReason.Outdated,
      agentId: 'agent-route',
    });

    const sql = getTestClient();
    const [entryRow] = await sql`SELECT metadata FROM entry WHERE id = ${entryId}`;
    expect(entryRow).toBeDefined();
    const md = entryRow!.metadata as Record<string, unknown> | null;
    expect(md).toBeTruthy();
    expect(md!.outdated_at).toBeDefined();

    const [vq] = await sql`
      SELECT priority FROM verify_queue WHERE claim_id = ${claimId}
    `;
    expect(vq).toBeDefined();
    expect(Number(vq!.priority)).toBeGreaterThanOrEqual(100);
  });

  test.skipIf(!dbAvailable)('missing/used/helpful/irrelevant reasons no-op on routing', async () => {
    const { entryId, claimId } = await createEntryWithClaim();
    const sql = getTestClient();

    const reasons = [
      FeedbackReason.Missing,
      FeedbackReason.Used,
      FeedbackReason.Helpful,
      FeedbackReason.Irrelevant,
      FeedbackReason.Other,
    ];
    for (const reason of reasons) {
      await routeFeedbackAction({ entryId, reason, agentId: 'agent-route' });
    }
    const vq = await sql`SELECT * FROM verify_queue WHERE claim_id = ${claimId}`;
    expect(vq).toHaveLength(0);
  });
});
