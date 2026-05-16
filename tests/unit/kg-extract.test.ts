import { describe, test, expect, beforeAll } from 'bun:test';

import { extractTriples, normalizeEntityKey } from '../../src/kg/extract';

beforeAll(() => {
  // Point Ollama at a dead port so the LLM call fails fast and the
  // code-under-test exercises its graceful-degradation branch.
  process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
  process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '200';
});

describe('normalizeEntityKey', () => {
  test('lowercases and trims both fields', () => {
    expect(normalizeEntityKey({ name: '  Bun  ', type: ' Tech ' })).toBe('tech|bun');
  });

  test('distinguishes entities with same name but different type', () => {
    const a = normalizeEntityKey({ name: 'Bun', type: 'tech' });
    const b = normalizeEntityKey({ name: 'Bun', type: 'food' });
    expect(a).not.toBe(b);
  });
});

describe('extractTriples — LLM unavailable', () => {
  test('returns [] when both CLIs fail', async () => {
    const triples = await extractTriples('Bun is a JavaScript runtime.');
    expect(triples).toEqual([]);
  });

  test('does not throw on empty input', async () => {
    const triples = await extractTriples('');
    expect(triples).toEqual([]);
  });
});
