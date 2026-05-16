import { describe, test, expect } from 'bun:test';

import { buildEmbeddingInput } from '../../src/ingest/embed';

describe('buildEmbeddingInput', () => {
  test('combines title and content with double newline', () => {
    const result = buildEmbeddingInput('My Title', 'My content here');
    expect(result).toBe('My Title\n\nMy content here');
  });

  test('handles empty title', () => {
    const result = buildEmbeddingInput('', 'content');
    expect(result).toBe('\n\ncontent');
  });

  test('handles empty content', () => {
    const result = buildEmbeddingInput('title', '');
    expect(result).toBe('title\n\n');
  });

  test('does not truncate short text', () => {
    const title = 'Short title';
    const content = 'Short content';
    const result = buildEmbeddingInput(title, content);
    expect(result).toBe(`${title}\n\n${content}`);
  });

  test('truncates very long content to stay within token limit', () => {
    const title = 'Title';
    // ~40,000 chars ≈ 10,000 tokens (over 8000 limit)
    const content = 'This is a sentence. '.repeat(2000);
    const result = buildEmbeddingInput(title, content);

    // Rough token estimate: result bytes / 4 should be <= 8000
    const estimatedTokens = new TextEncoder().encode(result).length / 4;
    expect(estimatedTokens).toBeLessThanOrEqual(8000);
  });

  test('truncation preserves sentence boundaries', () => {
    const title = 'Title';
    const content = 'First sentence. Second sentence. Third sentence. '.repeat(500);
    const result = buildEmbeddingInput(title, content);

    // Should end at a sentence boundary (after . and space)
    const lastPeriod = result.lastIndexOf('.');
    expect(lastPeriod).toBeGreaterThan(0);
    // The text after the last period should be empty or whitespace
    const afterLastPeriod = result.slice(lastPeriod + 1).trim();
    expect(afterLastPeriod).toBe('');
  });

  test('handles single very long sentence (no sentence boundary)', () => {
    const title = 'Title';
    const content = 'x'.repeat(50_000); // single long string, no periods
    const result = buildEmbeddingInput(title, content);

    // Should still truncate (fallback: byte cut)
    const estimatedTokens = new TextEncoder().encode(result).length / 4;
    expect(estimatedTokens).toBeLessThanOrEqual(8100); // some tolerance
  });

  test('handles unicode content', () => {
    const title = '제목';
    const content = '한국어 내용입니다.';
    const result = buildEmbeddingInput(title, content);
    expect(result).toBe('제목\n\n한국어 내용입니다.');
  });
});
