import { describe, test, expect } from 'bun:test';

import { SourceType } from '../../src/score/enums';
import { rank, type RawRow } from '../../src/search/rank';

function makeRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: '01HX0000000000000000000000',
    title: 'Test Entry',
    content: 'Test content',
    language: 'en',
    metadata: null,
    authority: 0.5,
    decayRate: 0.01,
    status: 'active',
    createdAt: new Date(),
    pgroongaScore: 1.0,
    domains: ['test'],
    tags: ['tag1'],
    sources: [],
    ...overrides,
  };
}

describe('rank — query mode', () => {
  test('empty rows returns empty result', () => {
    const result = rank([], 'query');
    expect(result.entries).toHaveLength(0);
    expect(result.scores).toHaveLength(0);
    expect(result.trustLevels).toHaveLength(0);
  });

  test('single row gets relevance=1.0', () => {
    const result = rank([makeRow({ pgroongaScore: 5.0 })], 'query');
    expect(result.scores[0]!.relevance).toBe(1.0);
  });

  test('pgroonga score min-max normalization', () => {
    const rows = [
      makeRow({ id: 'A', pgroongaScore: 10.0 }),
      makeRow({ id: 'B', pgroongaScore: 5.0 }),
      makeRow({ id: 'C', pgroongaScore: 0.0 }),
    ];
    const result = rank(rows, 'query');

    // Find entries by id (order may change after ranking)
    const scoreA = result.scores[result.entries.findIndex(e => e.id === 'A')]!;
    const scoreB = result.scores[result.entries.findIndex(e => e.id === 'B')]!;
    const scoreC = result.scores[result.entries.findIndex(e => e.id === 'C')]!;

    expect(scoreA.relevance).toBe(1.0); // max → 1.0
    expect(scoreB.relevance).toBe(0.5); // mid → 0.5
    expect(scoreC.relevance).toBe(0.0); // min → 0.0
  });

  test('all same pgroonga scores → all get relevance 1.0', () => {
    const rows = [makeRow({ id: 'A', pgroongaScore: 5.0 }), makeRow({ id: 'B', pgroongaScore: 5.0 })];
    const result = rank(rows, 'query');
    expect(result.scores[0]!.relevance).toBe(1.0);
    expect(result.scores[1]!.relevance).toBe(1.0);
  });

  test('formula: relevance*0.5 + authority*0.2 + freshness*0.3', () => {
    const now = new Date();
    const row = makeRow({
      pgroongaScore: 10.0,
      authority: 0.8,
      decayRate: 0.0, // no decay → freshness=1.0
      createdAt: now,
    });
    const result = rank([row], 'query');
    const score = result.scores[0]!;

    // relevance=1.0 (single row), authority=0.8, freshness≈1.0
    expect(score.final).toBeCloseTo(1.0 * 0.5 + 0.8 * 0.2 + 1.0 * 0.3, 2);
  });

  test('freshness decay: exp(-decayRate * days)', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const row = makeRow({
      decayRate: 0.05,
      createdAt: tenDaysAgo,
    });
    const result = rank([row], 'query');
    const freshness = result.scores[0]!.freshness;

    // exp(-0.05 * 10) = exp(-0.5) ≈ 0.6065
    expect(freshness).toBeCloseTo(Math.exp(-0.5), 3);
  });

  test('permanent data (decayRate=0.0001) stays fresh after 365 days', () => {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const row = makeRow({
      decayRate: 0.0001,
      createdAt: oneYearAgo,
    });
    const result = rank([row], 'query');
    // exp(-0.0001 * 365) ≈ 0.964
    expect(result.scores[0]!.freshness).toBeGreaterThan(0.95);
  });

  test('news (decayRate=0.05) decays quickly', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const row = makeRow({
      decayRate: 0.05,
      createdAt: thirtyDaysAgo,
    });
    const result = rank([row], 'query');
    // exp(-0.05 * 30) = exp(-1.5) ≈ 0.223
    expect(result.scores[0]!.freshness).toBeCloseTo(Math.exp(-1.5), 3);
  });

  test('sorts by final score descending', () => {
    const rows = [
      makeRow({ id: 'LOW', authority: 0.1, pgroongaScore: 1.0 }),
      makeRow({ id: 'HIGH', authority: 0.9, pgroongaScore: 10.0 }),
      makeRow({ id: 'MID', authority: 0.5, pgroongaScore: 5.0 }),
    ];
    const result = rank(rows, 'query');

    expect(result.entries[0]!.id).toBe('HIGH');
    expect(result.entries[2]!.id).toBe('LOW');
  });

  test('same final score → tiebreak by id descending', () => {
    const rows = [
      makeRow({ id: 'AAA', authority: 0.5, pgroongaScore: 5.0 }),
      makeRow({ id: 'ZZZ', authority: 0.5, pgroongaScore: 5.0 }),
    ];
    const result = rank(rows, 'query');
    expect(result.entries[0]!.id).toBe('ZZZ');
    expect(result.entries[1]!.id).toBe('AAA');
  });
});

describe('rank — explore mode', () => {
  test('relevance is always 0 in explore mode', () => {
    const rows = [makeRow({ pgroongaScore: 10.0 }), makeRow({ pgroongaScore: 0.0, id: 'B' })];
    const result = rank(rows, 'explore');
    expect(result.scores[0]!.relevance).toBe(0);
    expect(result.scores[1]!.relevance).toBe(0);
  });

  test('formula: authority*0.4 + freshness*0.6', () => {
    const row = makeRow({
      authority: 0.8,
      decayRate: 0.0,
      createdAt: new Date(),
    });
    const result = rank([row], 'explore');
    // authority=0.8, freshness≈1.0
    expect(result.scores[0]!.final).toBeCloseTo(0.8 * 0.4 + 1.0 * 0.6, 2);
  });
});

describe('rank — trustLevel', () => {
  test('high: authority >= 0.7', () => {
    const result = rank([makeRow({ authority: 0.7 })], 'query');
    expect(result.trustLevels[0]).toBe('high');
  });

  test('high: authority = 1.0', () => {
    const result = rank([makeRow({ authority: 1.0 })], 'query');
    expect(result.trustLevels[0]).toBe('high');
  });

  test('medium: authority >= 0.4 and < 0.7', () => {
    const result = rank([makeRow({ authority: 0.4 })], 'query');
    expect(result.trustLevels[0]).toBe('medium');

    const result2 = rank([makeRow({ authority: 0.69 })], 'query');
    expect(result2.trustLevels[0]).toBe('medium');
  });

  test('low: authority < 0.4', () => {
    const result = rank([makeRow({ authority: 0.39 })], 'query');
    expect(result.trustLevels[0]).toBe('low');

    const result2 = rank([makeRow({ authority: 0.0 })], 'query');
    expect(result2.trustLevels[0]).toBe('low');
  });
});

describe('rank — output structure', () => {
  test('entries include domains, tags, sources', () => {
    const row = makeRow({
      domains: ['web-security', 'javascript'],
      tags: ['xss', 'csp'],
      sources: [{ url: 'https://mdn.com', sourceType: SourceType.OfficialDocs, trust: 0.9 }],
    });
    const result = rank([row], 'query');
    expect(result.entries[0]!.domains).toEqual(['web-security', 'javascript']);
    expect(result.entries[0]!.tags).toEqual(['xss', 'csp']);
    expect(result.entries[0]!.sources).toEqual([{ url: 'https://mdn.com', sourceType: SourceType.OfficialDocs, trust: 0.9 }]);
  });

  test('createdAt is ISO string', () => {
    const date = new Date('2025-06-15T12:00:00Z');
    const result = rank([makeRow({ createdAt: date })], 'query');
    expect(result.entries[0]!.createdAt).toBe(date.toISOString());
  });

  test('entries, scores, trustLevels have same length', () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: `ID${i}`, pgroongaScore: i }));
    const result = rank(rows, 'query');
    expect(result.entries.length).toBe(result.scores.length);
    expect(result.entries.length).toBe(result.trustLevels.length);
  });
});
