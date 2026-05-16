import { describe, test, expect } from 'bun:test';

import { extractSkillRequest } from '../../src/a2a/types';

describe('extractSkillRequest', () => {
  test('extracts skill and input from data part', () => {
    const parts = [{ kind: 'data', data: { skill: 'store', input: { raw: 'hello' } } }];
    const result = extractSkillRequest(parts);
    expect(result.skill).toBe('store');
    expect(result.input).toEqual({ raw: 'hello' });
  });

  test('handles missing input field', () => {
    const parts = [{ kind: 'data', data: { skill: 'audit' } }];
    const result = extractSkillRequest(parts);
    expect(result.skill).toBe('audit');
    expect(result.input).toEqual({});
  });

  test('throws on missing data part', () => {
    expect(() => extractSkillRequest([{ kind: 'text' }])).toThrow();
  });

  test('throws on missing skill field', () => {
    expect(() => extractSkillRequest([{ kind: 'data', data: { input: {} } }])).toThrow("Missing or invalid 'skill'");
  });

  test('ignores non-data parts', () => {
    const parts = [{ kind: 'text' }, { kind: 'data', data: { skill: 'query', input: { query: 'bun' } } }];
    const result = extractSkillRequest(parts);
    expect(result.skill).toBe('query');
  });
});
