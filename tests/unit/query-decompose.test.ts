import { describe, expect, test, beforeAll } from 'bun:test';

import { decomposeQuery } from '../../src/collect/query-decompose';

// Force the LLM to fail so fallbackQueries() is exercised. Ollama is
// the only LLM path, so redirecting OLLAMA_HOST to an unreachable
// port with a short timeout is enough.
beforeAll(() => {
  process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
  process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '200';
});

describe('Query Decompose', () => {
  test('fallback produces 3 queries when CLI fails', async () => {
    // With the LLM unreachable, should fall back to 3 simple queries
    const queries = await decomposeQuery('test topic');
    expect(queries.length).toBe(3);
    expect(queries[0]!.main).toBe('test topic');
    expect(queries[1]!.main).toBe('test topic overview');
    expect(queries[2]!.main).toBe('test topic latest');
  });

  test('fallback queries have empty expansions', async () => {
    const queries = await decomposeQuery('test');
    for (const q of queries) {
      expect(q.expansions).toEqual([]);
    }
  });
});
