import { describe, test, expect } from 'bun:test';

import { splitText, deriveTitle } from '../../src/collect/text-split';

describe('splitText', () => {
  test('returns single chunk for short content', () => {
    const chunks = splitText('This is a short paragraph about Bun runtime.');
    expect(chunks).toHaveLength(0); // below MIN_CHARS
  });

  test('returns single chunk for content under MAX_CHARS', () => {
    const content = 'A'.repeat(200);
    const chunks = splitText(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
  });

  test('splits long content on double-newlines', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(300)}`).join('\n\n');
    const chunks = splitText(paras);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThanOrEqual(80);
    }
  });

  test('splits on headings', () => {
    const md =
      '## First Section\n' +
      'a'.repeat(1500) +
      '\n\n## Second Section\n' +
      'b'.repeat(1500) +
      '\n\n## Third Section\n' +
      'c'.repeat(1500);
    const chunks = splitText(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test('falls back to sentence split for wall-of-text', () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} with enough words to be meaningful.`).join(' ');
    const chunks = splitText(sentences);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('chunks have sequential indexes', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Topic ${i}: ${'content '.repeat(50)}`).join('\n\n');
    const chunks = splitText(long);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });
});

describe('deriveTitle', () => {
  test('uses first line if reasonable length', () => {
    expect(deriveTitle('## Introduction to pgvector\nSome content here.')).toBe('Introduction to pgvector');
  });

  test('strips heading markers', () => {
    expect(deriveTitle('### Heading\nBody')).toBe('Heading');
  });

  test('truncates for very long first lines', () => {
    const long = 'A'.repeat(200) + '\nBody';
    expect(deriveTitle(long).length).toBeLessThanOrEqual(120);
  });
});
