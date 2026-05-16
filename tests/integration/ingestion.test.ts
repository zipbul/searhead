import { describe, test, expect, afterAll, afterEach } from 'bun:test';

import { EntryStatus, IngestAction, SourceType } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb, getTestClient } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers, setOllamaHandler } from '../helpers/mock-apis';

// Set env vars before importing app modules
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19876';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
// Route LLM calls at the mock Ollama on port 11499 (real Ollama on
// 11434 stays untouched). Short timeout so any test that expects a
// graceful-degradation path fails fast rather than hanging.
process.env.OLLAMA_HOST = 'http://127.0.0.1:11499';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';
process.env.KNOLDR_OLLAMA_JURY_MODELS = 'mock';

// Dynamic imports to pick up env vars
let ingest: typeof import('../../src/ingest/engine').ingest;
let parseStoreInput: typeof import('../../src/ingest/validate').parseStoreInput;

// Top-level probe so `test.skipIf(...)` evaluates at registration time.
const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19876);
    startMockOllamaServer(11499);
    const engineMod = await import('../../src/ingest/engine');
    const validateMod = await import('../../src/ingest/validate');
    ingest = engineMod.ingest;
    parseStoreInput = validateMod.parseStoreInput;
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable, skipping integration tests:', (err as Error).message);
    return false;
  }
})();

afterEach(async () => {
  if (dbAvailable) {
    await cleanTestDb();
  }
  setOllamaHandler(null);
});

afterAll(async () => {
  stopMockServers();
  if (dbAvailable) {
    await teardownTestDb();
  }
});

describe('Ingestion Engine — Mode 1 (raw)', () => {
  test.skipIf(!dbAvailable)('decomposes raw text and stores entry', async () => {
    const input = parseStoreInput({ raw: 'Bun is a fast JavaScript runtime.' });
    const results = await ingest(input);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.action).toBe(IngestAction.Stored);
    expect(results[0]!.entryId).toBeTruthy();
    expect(results[0]!.authority).toBe(0.1); // no sources
  });

  test.skipIf(!dbAvailable)('stores with sources → higher authority', async () => {
    const input = parseStoreInput({
      raw: 'React 19 released',
      sources: [{ url: 'https://react.dev/blog', sourceType: SourceType.OfficialBlog }],
    });
    const results = await ingest(input);

    expect(results[0]!.action).toBe(IngestAction.Stored);
    expect(results[0]!.authority).toBe(0.8); // official_blog
  });

  test.skipIf(!dbAvailable)('handles LLM returning multiple entries', async () => {
    setOllamaHandler('multi');

    const input = parseStoreInput({ raw: 'Multi-topic article' });
    const results = await ingest(input);

    expect(results.length).toBe(2);
    expect(results[0]!.action).toBe(IngestAction.Stored);
    expect(results[1]!.action).toBe(IngestAction.Stored);
  });

  test.skipIf(!dbAvailable)('logs rejected when LLM fails', async () => {
    setOllamaHandler('fail');

    const input = parseStoreInput({ raw: "Bad input that LLM can't handle" });
    const results = await ingest(input);

    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe(IngestAction.Rejected);
  });
});

describe('Ingestion Engine — Mode 2 (structured)', () => {
  test.skipIf(!dbAvailable)('stores pre-structured entry (skips decompose)', async () => {
    const input = parseStoreInput({
      entries: [
        {
          title: 'Direct Entry',
          content: 'Pre-structured content that bypasses LLM.',
          domain: ['testing'],
          tags: ['structured'],
          language: 'en',
          decayRate: 0.01,
        },
      ],
    });
    const results = await ingest(input);

    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe(IngestAction.Stored);
  });

  test.skipIf(!dbAvailable)('stores multiple structured entries', async () => {
    const input = parseStoreInput({
      entries: [
        { title: 'Entry A', content: 'Content A', domain: ['a'] },
        { title: 'Entry B', content: 'Content B completely different', domain: ['b'] },
      ],
    });
    const results = await ingest(input);

    const stored = results.filter(r => r.action === IngestAction.Stored);
    expect(stored.length).toBe(2);
  });
});

describe('Ingestion Engine — Dedup', () => {
  test.skipIf(!dbAvailable)('detects duplicate on second ingestion of same content', async () => {
    // First: store
    const input1 = parseStoreInput({
      entries: [{ title: 'Dedup Test', content: 'Exact same content for dedup test', domain: ['testing'] }],
    });
    const results1 = await ingest(input1);
    expect(results1[0]!.action).toBe(IngestAction.Stored);

    // Second: same title + content → same embedding → duplicate
    const input2 = parseStoreInput({
      entries: [{ title: 'Dedup Test', content: 'Exact same content for dedup test', domain: ['testing'] }],
    });
    const results2 = await ingest(input2);
    expect(results2[0]!.action).toBe(IngestAction.Duplicate);
  });

  test.skipIf(!dbAvailable)('allows different content in same domain', async () => {
    const input1 = parseStoreInput({
      entries: [{ title: 'Topic A', content: 'Completely different topic about quantum computing', domain: ['science'] }],
    });
    await ingest(input1);

    const input2 = parseStoreInput({
      entries: [{ title: 'Topic B', content: 'Entirely unrelated topic about medieval history', domain: ['science'] }],
    });
    const results2 = await ingest(input2);
    expect(results2[0]!.action).toBe(IngestAction.Stored);
  });
});

describe('Ingestion Engine — DB transaction', () => {
  test.skipIf(!dbAvailable)('entry has correct status after ingestion', async () => {
    const input = parseStoreInput({
      entries: [{ title: 'Status Test', content: 'Check status is active', domain: ['testing'] }],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const rows = await sql`SELECT status FROM entry WHERE id = ${entryId}`;
    expect(rows[0]?.status).toBe(EntryStatus.Active);
  });

  test.skipIf(!dbAvailable)('domain and tags are stored correctly', async () => {
    const input = parseStoreInput({
      entries: [
        {
          title: 'Relations Test',
          content: 'Check domain and tag storage',
          domain: ['web-security', 'javascript'],
          tags: ['xss', 'csp', 'headers'],
        },
      ],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const domains = await sql`SELECT domain FROM entry_domain WHERE entry_id = ${entryId}`;
    expect(domains.map(d => (d as Record<string, string>).domain).sort()).toEqual(['javascript', 'web-security']);

    const tags = await sql`SELECT tag FROM entry_tag WHERE entry_id = ${entryId}`;
    expect(tags.map(t => (t as Record<string, string>).tag).sort()).toEqual(['csp', 'headers', 'xss']);
  });

  test.skipIf(!dbAvailable)('ingest_log records stored action', async () => {
    const input = parseStoreInput({
      entries: [{ title: 'Log Test', content: 'Check ingest log', domain: ['testing'] }],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const logs = await sql`SELECT action FROM ingest_log WHERE entry_id = ${entryId}`;
    expect(logs[0]?.action).toBe(IngestAction.Stored);
  });

  test.skipIf(!dbAvailable)('sources stored with rule-based trust', async () => {
    const input = parseStoreInput({
      entries: [{ title: 'Source Test', content: 'Check source trust values', domain: ['testing'] }],
      sources: [
        { url: 'https://docs.example.com', sourceType: SourceType.OfficialDocs },
        { url: 'https://blog.example.com', sourceType: SourceType.PersonalBlog },
      ],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const sources = await sql`SELECT source_type, trust FROM entry_source WHERE entry_id = ${entryId} ORDER BY source_type`;
    expect(sources).toHaveLength(2);

    const official = sources.find(s => (s as Record<string, unknown>).source_type === SourceType.OfficialDocs);
    expect((official as Record<string, unknown>)?.trust).toBe(0.9);

    const personal = sources.find(s => (s as Record<string, unknown>).source_type === SourceType.PersonalBlog);
    expect((personal as Record<string, unknown>)?.trust).toBe(0.3);
  });
});
