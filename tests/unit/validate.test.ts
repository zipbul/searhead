import { describe, test, expect } from 'bun:test';

import {
  parseStoreInput,
  queryInputSchema,
  exploreInputSchema,
  feedbackInputSchema,
  auditInputSchema,
  decomposeResponseSchema,
  isRawInput,
  stripHtml,
} from '../../src/ingest/validate';
import { Signal, SortBy, SourceType, TrustLevel } from '../../src/score/enums';

// ============================================================
// storeInputSchema
// ============================================================
describe('storeInputSchema — Mode 1 (raw)', () => {
  test('accepts valid raw input', () => {
    const result = parseStoreInput({ raw: 'Hello world' });
    expect(result).toBeDefined();
  });

  test('accepts raw with sources', () => {
    const result = parseStoreInput({
      raw: 'Hello world',
      sources: [{ url: 'https://example.com', sourceType: SourceType.OfficialDocs }],
    });
    expect(result).toBeDefined();
  });

  test('rejects empty raw string', () => {
    expect(() => parseStoreInput({ raw: '' })).toThrow();
  });

  test('rejects raw exceeding 200,000 chars', () => {
    expect(() => parseStoreInput({ raw: 'x'.repeat(200_001) })).toThrow();
  });

  test('accepts raw at exactly 200,000 chars', () => {
    expect(() => parseStoreInput({ raw: 'x'.repeat(200_000) })).not.toThrow();
  });

  test('rejects invalid source URL', () => {
    expect(() =>
      parseStoreInput({
        raw: 'test',
        sources: [{ url: 'not-a-url', sourceType: SourceType.Unknown }],
      }),
    ).toThrow();
  });

  test('rejects invalid source type', () => {
    expect(() =>
      parseStoreInput({
        raw: 'test',
        sources: [{ url: 'https://example.com', sourceType: 'invalid_type' }],
      }),
    ).toThrow();
  });

  test('rejects more than 20 sources', () => {
    const sources = Array.from({ length: 21 }, (_, i) => ({
      url: `https://example${i}.com`,
      sourceType: SourceType.Unknown,
    }));
    expect(() => parseStoreInput({ raw: 'test', sources })).toThrow();
  });
});

describe('storeInputSchema — Mode 2 (structured)', () => {
  const validEntry = {
    title: 'Test',
    content: 'Content',
    domain: ['web-security'],
  };

  test('accepts valid structured input', () => {
    const result = parseStoreInput({ entries: [validEntry] });
    expect(result).toBeDefined();
  });

  test('accepts all optional fields', () => {
    const result = parseStoreInput({
      entries: [
        {
          ...validEntry,
          tags: ['tag1', 'tag2'],
          language: 'ko',
          decayRate: 0.02,
          metadata: { key: 'value' },
        },
      ],
    });
    expect(result).toBeDefined();
  });

  test('rejects empty entries array', () => {
    expect(() => parseStoreInput({ entries: [] })).toThrow();
  });

  test('rejects more than 20 entries', () => {
    const entries = Array.from({ length: 21 }, () => validEntry);
    expect(() => parseStoreInput({ entries })).toThrow();
  });

  test('rejects title > 500 chars', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, title: 'x'.repeat(501) }] })).toThrow();
  });

  test('rejects content > 50,000 chars', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, content: 'x'.repeat(50_001) }] })).toThrow();
  });

  test('rejects domain with spaces', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, domain: ['web security'] }] })).toThrow();
  });

  test('rejects domain with uppercase', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, domain: ['WebSecurity'] }] })).toThrow();
  });

  test('rejects empty domain array', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, domain: [] }] })).toThrow();
  });

  test('rejects more than 5 domains', () => {
    expect(() =>
      parseStoreInput({
        entries: [{ ...validEntry, domain: ['a', 'b', 'c', 'd', 'e', 'f'] }],
      }),
    ).toThrow();
  });

  test('rejects more than 20 tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(() => parseStoreInput({ entries: [{ ...validEntry, tags }] })).toThrow();
  });

  test('rejects invalid language code', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, language: 'eng' }] })).toThrow();
    expect(() => parseStoreInput({ entries: [{ ...validEntry, language: 'EN' }] })).toThrow();
  });

  test('rejects decayRate out of range', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, decayRate: 0 }] })).toThrow();
    expect(() => parseStoreInput({ entries: [{ ...validEntry, decayRate: 0.2 }] })).toThrow();
  });

  test('accepts decayRate at boundaries', () => {
    expect(() => parseStoreInput({ entries: [{ ...validEntry, decayRate: 0.0001 }] })).not.toThrow();
    expect(() => parseStoreInput({ entries: [{ ...validEntry, decayRate: 0.1 }] })).not.toThrow();
  });
});

describe('storeInputSchema — mutual exclusion', () => {
  test('rejects input with both raw and entries', () => {
    expect(() =>
      parseStoreInput({
        raw: 'hello',
        entries: [{ title: 'T', content: 'C', domain: ['d'] }],
      }),
    ).toThrow();
  });

  test('rejects input with neither raw nor entries', () => {
    expect(() => parseStoreInput({})).toThrow();
    expect(() => parseStoreInput({ sources: [] })).toThrow();
  });
});

describe('isRawInput', () => {
  test('returns true for raw input', () => {
    const input = parseStoreInput({ raw: 'hello' });
    expect(isRawInput(input)).toBe(true);
  });

  test('returns false for structured input', () => {
    const input = parseStoreInput({
      entries: [{ title: 'T', content: 'C', domain: ['d'] }],
    });
    expect(isRawInput(input)).toBe(false);
  });
});

// ============================================================
// queryInputSchema
// ============================================================
describe('queryInputSchema', () => {
  test('accepts minimal query', () => {
    const result = queryInputSchema.parse({ query: 'bun runtime' });
    expect(result.query).toBe('bun runtime');
    expect(result.limit).toBe(10); // default
  });

  test('accepts all optional fields', () => {
    const result = queryInputSchema.parse({
      query: 'test',
      domain: 'javascript',
      tags: ['runtime', 'performance'],
      language: 'en',
      minAuthority: 0.5,
      minTrustLevel: TrustLevel.High,
      limit: 25,
      cursor: 'abc123',
    });
    expect(result.domain).toBe('javascript');
    expect(result.minTrustLevel).toBe(TrustLevel.High);
  });

  test('rejects empty query', () => {
    expect(() => queryInputSchema.parse({ query: '' })).toThrow();
  });

  test('rejects query > 1000 chars', () => {
    expect(() => queryInputSchema.parse({ query: 'x'.repeat(1001) })).toThrow();
  });

  test('rejects limit > 50', () => {
    expect(() => queryInputSchema.parse({ query: 'test', limit: 51 })).toThrow();
  });

  test('rejects limit < 1', () => {
    expect(() => queryInputSchema.parse({ query: 'test', limit: 0 })).toThrow();
  });

  test('rejects invalid minTrustLevel', () => {
    expect(() => queryInputSchema.parse({ query: 'test', minTrustLevel: 'super' })).toThrow();
  });

  test('rejects minAuthority out of range', () => {
    expect(() => queryInputSchema.parse({ query: 'test', minAuthority: -0.1 })).toThrow();
    expect(() => queryInputSchema.parse({ query: 'test', minAuthority: 1.1 })).toThrow();
  });
});

// ============================================================
// exploreInputSchema
// ============================================================
describe('exploreInputSchema', () => {
  test('accepts empty input (all defaults)', () => {
    const result = exploreInputSchema.parse({});
    expect(result.sortBy).toBe(SortBy.Authority);
    expect(result.limit).toBe(10);
  });

  test('accepts sortBy CreatedAt', () => {
    const result = exploreInputSchema.parse({ sortBy: SortBy.CreatedAt });
    expect(result.sortBy).toBe(SortBy.CreatedAt);
  });

  test('rejects invalid sortBy', () => {
    expect(() => exploreInputSchema.parse({ sortBy: 'relevance' })).toThrow();
  });
});

// ============================================================
// feedbackInputSchema
// ============================================================
describe('feedbackInputSchema', () => {
  test('accepts valid feedback', () => {
    const result = feedbackInputSchema.parse({
      entryId: '01HX0000000000000000000000',
      signal: Signal.Positive,
      agentId: 'agent-1',
    });
    expect(result.signal).toBe(Signal.Positive);
  });

  test('accepts with reason', () => {
    const result = feedbackInputSchema.parse({
      entryId: '01HX0000000000000000000000',
      signal: Signal.Negative,
      reason: 'Outdated information',
      agentId: 'agent-1',
    });
    expect(result.reason).toBe('Outdated information');
  });

  test('rejects invalid signal', () => {
    expect(() => feedbackInputSchema.parse({ entryId: 'x', signal: 'neutral', agentId: 'a' })).toThrow();
  });

  test('rejects missing agentId', () => {
    expect(() => feedbackInputSchema.parse({ entryId: 'x', signal: 'positive' })).toThrow();
  });

  test('rejects empty entryId', () => {
    expect(() => feedbackInputSchema.parse({ entryId: '', signal: 'positive', agentId: 'a' })).toThrow();
  });

  test('rejects reason > 1000 chars', () => {
    expect(() =>
      feedbackInputSchema.parse({
        entryId: 'x',
        signal: 'positive',
        agentId: 'a',
        reason: 'x'.repeat(1001),
      }),
    ).toThrow();
  });
});

// ============================================================
// auditInputSchema
// ============================================================
describe('auditInputSchema', () => {
  test('accepts empty input', () => {
    const result = auditInputSchema.parse({});
    expect(result.domain).toBeUndefined();
  });

  test('accepts domain filter', () => {
    const result = auditInputSchema.parse({ domain: 'javascript' });
    expect(result.domain).toBe('javascript');
  });
});

// ============================================================
// decomposeResponseSchema
// ============================================================
describe('decomposeResponseSchema', () => {
  const validEntry = {
    title: 'Test',
    content: 'Content',
    domain: ['web-security'],
    tags: ['xss'],
    language: 'en',
    decayRate: 0.01,
  };

  test('accepts valid response', () => {
    const result = decomposeResponseSchema.parse({ entries: [validEntry] });
    expect(result.entries).toHaveLength(1);
  });

  test('rejects empty entries', () => {
    expect(() => decomposeResponseSchema.parse({ entries: [] })).toThrow();
  });

  test('rejects more than 20 entries', () => {
    const entries = Array.from({ length: 21 }, () => validEntry);
    expect(() => decomposeResponseSchema.parse({ entries })).toThrow();
  });

  test('rejects domain with uppercase', () => {
    expect(() =>
      decomposeResponseSchema.parse({
        entries: [{ ...validEntry, domain: ['WebSecurity'] }],
      }),
    ).toThrow();
  });

  test('rejects domain with spaces', () => {
    expect(() =>
      decomposeResponseSchema.parse({
        entries: [{ ...validEntry, domain: ['web security'] }],
      }),
    ).toThrow();
  });

  test('rejects tags with special characters', () => {
    expect(() =>
      decomposeResponseSchema.parse({
        entries: [{ ...validEntry, tags: ['tag with spaces'] }],
      }),
    ).toThrow();
  });

  test('rejects invalid language code', () => {
    expect(() =>
      decomposeResponseSchema.parse({
        entries: [{ ...validEntry, language: 'eng' }],
      }),
    ).toThrow();
  });

  test('rejects decayRate out of range', () => {
    expect(() =>
      decomposeResponseSchema.parse({
        entries: [{ ...validEntry, decayRate: 0.00001 }],
      }),
    ).toThrow();
    expect(() =>
      decomposeResponseSchema.parse({
        entries: [{ ...validEntry, decayRate: 0.2 }],
      }),
    ).toThrow();
  });

  test('defaults tags to empty array', () => {
    const { tags, ...noTags } = validEntry;
    const result = decomposeResponseSchema.parse({ entries: [noTags] });
    expect(result.entries[0]!.tags).toEqual([]);
  });
});

// ============================================================
// stripHtml
// ============================================================
describe('stripHtml', () => {
  test('strips HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  test('handles text without HTML', () => {
    expect(stripHtml('plain text')).toBe('plain text');
  });

  test('handles empty string', () => {
    expect(stripHtml('')).toBe('');
  });

  test('strips self-closing tags', () => {
    expect(stripHtml('line1<br/>line2')).toBe('line1line2');
  });

  test('strips tags with attributes', () => {
    expect(stripHtml('<a href="https://example.com">link</a>')).toBe('link');
  });

  test('handles nested tags', () => {
    expect(stripHtml('<div><p><span>deep</span></p></div>')).toBe('deep');
  });
});
