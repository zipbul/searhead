import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { normalizeTokenizerSpacing, isSemanticGarbage, hostPasses, estimateSourceType } from '../../src/collect/research';
import { SourceType } from '../../src/score/enums';

describe('normalizeTokenizerSpacing', () => {
  test('collapses spaces around closing punctuation', () => {
    expect(normalizeTokenizerSpacing('json schema . 2')).toBe('json schema. 2');
  });

  test('collapses multiple punctuation marks', () => {
    expect(normalizeTokenizerSpacing('a , b ; c : d')).toBe('a, b; c: d');
  });

  test('collapses spaces around opening brackets', () => {
    expect(normalizeTokenizerSpacing('foo ( bar )')).toBe('foo (bar)');
  });

  test('collapses excess whitespace', () => {
    expect(normalizeTokenizerSpacing('a    b   c')).toBe('a b c');
  });

  test('idempotent on already-normal text', () => {
    const text = 'Python is a programming language. It supports OOP.';
    expect(normalizeTokenizerSpacing(text)).toBe(text);
  });

  test('preserves newlines as whitespace, then collapses', () => {
    expect(normalizeTokenizerSpacing('line one\n\nline two')).toBe('line one line two');
  });
});

describe('isSemanticGarbage', () => {
  test('short text passes (length < 200)', () => {
    expect(isSemanticGarbage('a'.repeat(150))).toBe(false);
  });

  test('clear English prose passes', () => {
    const prose =
      'Python is a high-level programming language. It supports object-oriented, procedural, and functional paradigms. ' +
      'The language was created by Guido van Rossum in 1991.'.repeat(2);
    expect(isSemanticGarbage(prose)).toBe(false);
  });

  test('Korean prose passes', () => {
    const prose =
      '트랜스포머 아키텍처는 self-attention 메커니즘을 핵심으로 한다. ' +
      'RNN이나 CNN 없이 시퀀스를 처리하며 병렬화에 유리하다. '.repeat(4);
    expect(isSemanticGarbage(prose)).toBe(false);
  });

  test('Japanese prose passes', () => {
    const prose =
      '深層 学習 は 機械 学習 の 一 分野 で ある 。 ニューラル ネットワーク を 多 層 化 した モデル を 用い る 。 '.repeat(6);
    expect(isSemanticGarbage(prose)).toBe(false);
  });

  test('Chinese prose passes', () => {
    const prose = '深度 学习 是 机器 学习 的 一个 分支 。 它 使用 多 层 神经 网络 来 处理 复杂 的 模式 识别 任务 。 '.repeat(6);
    expect(isSemanticGarbage(prose)).toBe(false);
  });

  test('low-alpha symbol-heavy dump rejected', () => {
    const garbage = '{ } [ ] $ % & * + = | < > / \\ '.repeat(20);
    expect(isSemanticGarbage(garbage)).toBe(true);
  });

  test('long no-sentence listing rejected', () => {
    const listing = 'logs init pics scripts tests docs config readme license '.repeat(15);
    expect(isSemanticGarbage(listing)).toBe(true);
  });

  test('file-listing-style content rejected', () => {
    const dump =
      'code\n  ysy myth\n  logs\n  logs\n  init\n  pics\n  pics\n  tot package\n  scripts\n  scripts\n  src / to t\n  src / to t\n  feature add\n  gitignore\n  pip package\n  license\n  manifest in\n  readme md\n  pyproject toml\n  pip package\n'.repeat(
        4,
      );
    expect(isSemanticGarbage(dump)).toBe(true);
  });
});

describe('hostPasses', () => {
  const ENV_KEYS = ['KNOLDR_HOST_ALLOWLIST', 'KNOLDR_HOST_BLOCKLIST'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  test('empty allowlist accepts all', () => {
    expect(hostPasses('https://example.com/x')).toBe(true);
    expect(hostPasses('https://random.io')).toBe(true);
  });

  test('invalid url rejected', () => {
    expect(hostPasses('not-a-url')).toBe(false);
  });

  test('allowlist accepts exact host', () => {
    process.env.KNOLDR_HOST_ALLOWLIST = 'arxiv.org';
    expect(hostPasses('https://arxiv.org/abs/123')).toBe(true);
    expect(hostPasses('https://other.com/x')).toBe(false);
  });

  test('allowlist accepts subdomains', () => {
    process.env.KNOLDR_HOST_ALLOWLIST = 'github.com';
    expect(hostPasses('https://api.github.com/x')).toBe(true);
    expect(hostPasses('https://raw.github.com/x')).toBe(true);
  });

  test('blocklist beats allowlist', () => {
    process.env.KNOLDR_HOST_ALLOWLIST = 'example.com';
    process.env.KNOLDR_HOST_BLOCKLIST = 'example.com';
    expect(hostPasses('https://example.com/x')).toBe(false);
  });

  test('strips www. prefix', () => {
    process.env.KNOLDR_HOST_ALLOWLIST = 'wikipedia.org';
    expect(hostPasses('https://www.wikipedia.org/x')).toBe(true);
  });
});

describe('estimateSourceType', () => {
  test('arxiv → ResearchPaper', () => {
    expect(estimateSourceType('https://arxiv.org/abs/2404.10774')).toBe(SourceType.ResearchPaper);
  });

  test('openreview → ResearchPaper', () => {
    expect(estimateSourceType('https://openreview.net/forum?id=abc')).toBe(SourceType.ResearchPaper);
  });

  test('learn.microsoft → OfficialDocs', () => {
    expect(estimateSourceType('https://learn.microsoft.com/en-us/azure')).toBe(SourceType.OfficialDocs);
  });

  test('docs.python → OfficialDocs', () => {
    expect(estimateSourceType('https://docs.python.org/3/library/asyncio.html')).toBe(SourceType.OfficialDocs);
  });

  test('wikipedia → ReferenceWiki', () => {
    expect(estimateSourceType('https://en.wikipedia.org/wiki/Transformer')).toBe(SourceType.ReferenceWiki);
  });

  test('github README → OfficialDocs (path-aware)', () => {
    expect(estimateSourceType('https://github.com/owner/repo/blob/main/README.md')).toBe(SourceType.OfficialDocs);
  });

  test('github issues → CommunityForum (path-aware)', () => {
    expect(estimateSourceType('https://github.com/owner/repo/issues/42')).toBe(SourceType.CommunityForum);
  });

  test('github releases → GithubRelease', () => {
    expect(estimateSourceType('https://github.com/owner/repo/releases/tag/v1.0')).toBe(SourceType.GithubRelease);
  });

  test('github root → GithubRelease (default)', () => {
    expect(estimateSourceType('https://github.com/owner/repo')).toBe(SourceType.GithubRelease);
  });

  test('.gov → OfficialDocs', () => {
    expect(estimateSourceType('https://nist.gov/x')).toBe(SourceType.OfficialDocs);
  });

  test('medium → EstablishedBlog', () => {
    expect(estimateSourceType('https://medium.com/@author/post')).toBe(SourceType.EstablishedBlog);
  });

  test('stackoverflow → CommunityForum', () => {
    expect(estimateSourceType('https://stackoverflow.com/q/123')).toBe(SourceType.CommunityForum);
  });

  test('unknown host → Unknown', () => {
    expect(estimateSourceType('https://random-blog.example.io/post')).toBe(SourceType.Unknown);
  });

  test('malformed url → Unknown', () => {
    expect(estimateSourceType('not a url')).toBe(SourceType.Unknown);
  });
});
