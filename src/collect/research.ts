import type { Progress } from '../a2a/types';

import { ingest } from '../ingest/engine';
import { parseStoreInput } from '../ingest/validate';
import { logger } from '../observability/logger';
import { SourceType } from '../score/enums';
import { classifyBatch } from './classify-batch';
import { decomposeQuery } from './query-decompose';
import { collectSearchHits, type SearchHit } from './search-scraper';
import { splitText, deriveTitle } from './text-split';

const NOOP_PROGRESS: Progress = { emit: () => {} };
const TITLE_MAX = 500;
const MAX_CHUNKS_PER_URL = 5;
const MAX_TOTAL_CHUNKS = 100;

interface ResearchInput {
  topic: string;
  domain?: string;
  maxResults?: number;
  focusDomains?: string[];
}

interface ResearchResult {
  entries: Array<{ entryId: string; action: string }>;
  urlsProcessed: number;
  entriesStored: number;
  entriesSkippedLowRelevance: number;
  status: 'completed' | 'partial';
}

const TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TOPIC_COVERAGE = 0.25;

/**
 * LangSearch-only research pipeline:
 *   1. Decompose topic into sub-queries (1 LLM call)
 *   2. LangSearch web search → rich hits
 *   3. Drop hits below topic coverage gate
 *   4. Recursive text-split each hit (code, 0 LLM)
 *   5. Batch-classify all chunks (1-5 LLM calls for domain/tags/decay/lang)
 *   6. Store as structured entries (Mode 2, 0 LLM)
 *
 * Total LLM calls: 2-6 per research (was ~50 with per-hit decompose).
 * Claim/KG extraction runs asynchronously in background workers.
 */
async function research(input: ResearchInput, progress: Progress = NOOP_PROGRESS): Promise<ResearchResult> {
  const maxResults = Math.min(input.maxResults ?? 50, 200);
  const deadline = Date.now() + TIMEOUT_MS;

  logger.info({ topic: input.topic, maxResults }, 'research started');

  // Step 1: Query decomposition (1 LLM call)
  progress.emit('query_decompose', { topic: input.topic });
  const subQueries = await decomposeQuery(input.topic);
  logger.info({ queryCount: subQueries.length, queries: subQueries.map(q => q.main) }, 'queries decomposed');
  progress.emit('query_decomposed', { queryCount: subQueries.length });

  // Step 2: LangSearch (0 LLM)
  progress.emit('langsearch_querying', { queryCount: subQueries.length });
  const hits = await collectSearchHits(subQueries, input.focusDomains);
  const limited = hits.slice(0, maxResults);
  logger.info({ hitCount: hits.length, limited: limited.length }, 'hits collected');
  progress.emit('langsearch_collected', { hits: hits.length, toProcess: limited.length });

  const topicTerms = input.topic
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2);

  const result: ResearchResult = {
    entries: [],
    urlsProcessed: 0,
    entriesStored: 0,
    entriesSkippedLowRelevance: 0,
    status: 'completed',
  };

  // Step 3: Topic gate + split (0 LLM)
  progress.emit('splitting');
  interface PreparedChunk {
    title: string;
    text: string;
    url: string;
    sourceType: string;
  }
  const allChunks: PreparedChunk[] = [];

  for (const hit of limited) {
    if (Date.now() > deadline) {
      result.status = 'partial';
      break;
    }
    result.urlsProcessed++;

    if (!passesTopicGate(hit, topicTerms)) {
      result.entriesSkippedLowRelevance++;
      continue;
    }

    // Host allowlist gate (opt-in). When KNOLDR_HOST_ALLOWLIST is set,
    // only hits whose host (or parent domain) appears in the list are
    // ingested; everything else is dropped before any further work.
    // Empty/unset = accept-all. Blocklist takes precedence over
    // allowlist when both are configured.
    if (!hostPasses(hit.url)) {
      result.entriesSkippedLowRelevance++;
      continue;
    }

    // Normalize LangSearch tokenizer format ("json schema . 2" →
    // "json schema. 2"). The upstream extractor wraps every punctuation
    // glyph in whitespace; collapsing this back is required for clean
    // embeddings, grounders, and titles. Applied to all hits because the
    // format is uniform across sources.
    const normalized = normalizeTokenizerSpacing(hit.content || '');

    // Reject only after normalization, against semantic markers — a hit
    // is garbage when there's almost no alphanumeric prose (file
    // listings, code-only fragments) or no sentence structure.
    if (isSemanticGarbage(normalized)) {
      result.entriesSkippedLowRelevance++;
      logger.warn({ url: hit.url }, 'rejected: semantic garbage content');
      continue;
    }
    const cleanedHit = { ...hit, content: normalized };

    const sourceType = estimateSourceType(cleanedHit.url);
    const chunks = splitText(cleanedHit.content || cleanedHit.title);

    if (chunks.length === 0) {
      allChunks.push({
        title: cleanedHit.title.slice(0, TITLE_MAX),
        text: cleanedHit.content || cleanedHit.title,
        url: cleanedHit.url,
        sourceType,
      });
    } else {
      for (const chunk of chunks.slice(0, MAX_CHUNKS_PER_URL)) {
        allChunks.push({
          title: deriveTitle(chunk.text).slice(0, TITLE_MAX),
          text: chunk.text,
          url: cleanedHit.url,
          sourceType,
        });
      }
    }

    if (allChunks.length >= MAX_TOTAL_CHUNKS) {
      break;
    }
  }

  if (allChunks.length === 0) {
    logger.info({ topic: input.topic }, 'no chunks to ingest');
    return result;
  }

  logger.info({ chunks: allChunks.length }, 'chunks prepared');
  progress.emit('chunks_prepared', { count: allChunks.length });

  // Step 4: Batch classify (1-5 LLM calls for ALL chunks)
  progress.emit('classifying', { count: allChunks.length });
  const metas = await classifyBatch(
    allChunks.map(c => ({ title: c.title, text: c.text })),
    input.topic,
  );
  progress.emit('classified');

  // Step 5: Mode 2 ingest (0 LLM) — bounded parallelism.
  //
  // Previous implementation ran ingest sequentially on up to 100
  // chunks, which easily exhausted the 5-minute deadline because each
  // ingest does embedding (CPU) + HNSW lookup + TX. Parallelizing
  // uncapped would overwhelm Postgres and the embedding pipeline
  // itself, so we cap at CONCURRENCY simultaneous ingests — empirical
  // sweet spot on the postgres max_connections=80 pool without
  // starving other workers.
  progress.emit('ingesting', { count: allChunks.length });
  const PROGRESS_STRIDE = Math.max(1, Math.floor(allChunks.length / 10));
  const CONCURRENCY = 6;
  let nextIdx = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      if (Date.now() > deadline) {
        result.status = 'partial';
        return;
      }
      const i = nextIdx++;
      if (i >= allChunks.length) {
        return;
      }
      const chunk = allChunks[i]!;
      const meta = metas[i]!;
      try {
        const storeInput = parseStoreInput({
          entries: [
            {
              title: chunk.title,
              content: chunk.text,
              domain: meta.domain,
              tags: meta.tags,
              language: meta.language,
              decayRate: meta.decayRate,
            },
          ],
          sources: [{ url: chunk.url, sourceType: chunk.sourceType }],
        });
        const ingested = await ingest(storeInput);
        for (const r of ingested) {
          // Skip rejected rows from the exported `entries` list — they
          // have no useful id, and `action:"stored"` is the only one
          // the caller tracks. Rejections are counted separately via
          // ingestionTotal metric.
          if (r.entryId) {
            result.entries.push({ entryId: r.entryId, action: r.action });
          }
          if (r.action === 'stored') {
            result.entriesStored++;
          }
        }
      } catch (err) {
        logger.warn({ url: chunk.url, error: (err as Error).message }, 'chunk ingest failed');
      }
      completed++;
      if (completed % PROGRESS_STRIDE === 0 || completed === allChunks.length) {
        progress.emit('ingest_progress', {
          processed: completed,
          total: allChunks.length,
          stored: result.entriesStored,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  logger.info(
    {
      topic: input.topic,
      urlsProcessed: result.urlsProcessed,
      entriesStored: result.entriesStored,
      entriesSkippedLowRelevance: result.entriesSkippedLowRelevance,
      chunks: allChunks.length,
      status: result.status,
    },
    'research finished',
  );

  return result;
}

// Host allowlist / blocklist. Domain match accepts an exact host or
// any subdomain. Empty allowlist = accept-all. Blocklist always wins.
const parseHostList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map(s =>
      s
        .trim()
        .toLowerCase()
        .replace(/^www\./, ''),
    )
    .filter(Boolean);
function hostPasses(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const block = parseHostList(process.env.KNOLDR_HOST_BLOCKLIST);
  for (const b of block) {
    if (host === b || host.endsWith(`.${b}`)) {
      return false;
    }
  }
  const allow = parseHostList(process.env.KNOLDR_HOST_ALLOWLIST);
  if (allow.length === 0) {
    return true;
  }
  for (const a of allow) {
    if (host === a || host.endsWith(`.${a}`)) {
      return true;
    }
  }
  return false;
}

function passesTopicGate(hit: SearchHit, topicTerms: string[]): boolean {
  if (topicTerms.length === 0) {
    return true;
  }
  const haystack = `${hit.title} ${hit.content}`.toLowerCase();
  const matched = topicTerms.filter(t => haystack.includes(t)).length;
  return matched / topicTerms.length >= MIN_TOPIC_COVERAGE;
}

// LangSearch wraps every punctuation glyph in whitespace ("json schema
// . 2"). This is uniform across all sources — measured in DB at 1.85-4%
// ratio for both legitimate arxiv prose and fragmented code dumps —
// so the spacing alone can't gate. We collapse the spacing back to the
// canonical form before any downstream embedding / grounding sees it.
// Two-pass normalizer:
//   (1) closing-punct rule: "x . y" → "x. y", "x )" → "x)"
//       Match whitespace BEFORE punctuation regardless of what follows.
//   (2) opening-punct rule: "( x" → "(x"
//       Match whitespace AFTER punctuation regardless of what precedes.
//   (3) collapse leftover runs.
const TOKENIZER_PUNCT_RE = /\s+([.,;:!?)\]}'"])/g;
const TOKENIZER_OPEN_RE = /([([{])\s+/g;
function normalizeTokenizerSpacing(text: string): string {
  return text.replace(TOKENIZER_PUNCT_RE, '$1').replace(TOKENIZER_OPEN_RE, '$1').replace(/\s+/g, ' ').trim();
}

// Conservative reject — only blocks extreme cases (code-heavy dumps,
// large unstructured listings). Tuned to minimize false positives over
// recall; downstream verify pipeline + retrieval ranking handle the
// gray area. Thresholds are ENV-overridable so we can tighten after
// observing production data.
//
// Alpha range covers Latin, Hangul (AC00-D7AF), CJK Unified (4E00-9FFF),
// CJK Extension A (3400-4DBF), Hiragana (3040-309F), Katakana (30A0-30FF).
// Initial range was Latin+Hangul only and falsely flagged Chinese /
// Japanese passages as low-alpha garbage in production samples.
const ALPHA_RE = /[A-Za-z\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g;
const SENTENCE_END_RE = /[.!?。!?]/g;
const GARBAGE_MIN_ALPHA = Number(process.env.KNOLDR_GARBAGE_MIN_ALPHA ?? 0.4);
const GARBAGE_NO_SENT_LEN = Number(process.env.KNOLDR_GARBAGE_NO_SENT_LEN ?? 600);
function isSemanticGarbage(text: string): boolean {
  if (text.length < 200) {
    return false;
  }
  const alphaCount = (text.match(ALPHA_RE) ?? []).length;
  if (alphaCount / text.length < GARBAGE_MIN_ALPHA) {
    return true;
  }
  const sentenceCount = (text.match(SENTENCE_END_RE) ?? []).length;
  if (sentenceCount === 0 && text.length > GARBAGE_NO_SENT_LEN) {
    return true;
  }
  return false;
}

function estimateSourceType(url: string): SourceType {
  // Host-based matching so paths like /evil/fake-github.com/... can't
  // impersonate a trusted publisher. The `is()` helper accepts an exact
  // host or any subdomain of it. Path-aware refinements (GitHub
  // README/issue/release distinction) handled below for the cases that
  // actually skew downstream verify weighting.
  let host: string;
  let pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname.toLowerCase();
  } catch {
    return SourceType.Unknown;
  }
  const is = (...domains: string[]) => domains.some(d => host === d || host.endsWith(`.${d}`));

  // Research papers
  if (is('arxiv.org', 'arxiv-vanity.com', 'ar5iv.labs.arxiv.org')) {
    return SourceType.ResearchPaper;
  }
  if (is('openreview.net', 'aclanthology.org', 'papers.nips.cc', 'proceedings.mlr.press')) {
    return SourceType.ResearchPaper;
  }
  if (is('biorxiv.org', 'medrxiv.org', 'ssrn.com')) {
    return SourceType.ResearchPaper;
  }

  // Official docs (vendor / language / framework)
  if (
    is(
      'learn.microsoft.com',
      'docs.microsoft.com',
      'developer.mozilla.org',
      'docs.python.org',
      'pytorch.org',
      'tensorflow.org',
      'huggingface.co',
      'platform.openai.com',
      'platform.claude.com',
      'docs.anthropic.com',
      'ai.google.dev',
      'cloud.google.com',
      'docs.aws.amazon.com',
      'kubernetes.io',
      'rust-lang.org',
      'doc.rust-lang.org',
      'crates.io',
      'go.dev',
      'pkg.go.dev',
      'nodejs.org',
      'bun.sh',
      'deno.land',
      'docs.deno.com',
      'postgresql.org',
      'redis.io',
    )
  ) {
    return SourceType.OfficialDocs;
  }
  if (host.endsWith('.gov') || host.endsWith('.edu')) {
    return SourceType.OfficialDocs;
  }
  if (is('pypi.org', 'npmjs.com')) {
    return SourceType.OfficialDocs;
  }

  // Reference / encyclopedia
  if (is('wikipedia.org', 'en.wikipedia.org') || host.endsWith('.wikipedia.org')) {
    return SourceType.ReferenceWiki;
  }
  if (is('wikidata.org', 'handwiki.org', 'scholarpedia.org')) {
    return SourceType.ReferenceWiki;
  }

  // GitHub: differentiate by URL shape — README/blob is documentation,
  // issues/discussions are community forum, releases are versioned
  // artifacts. Coarse-grained but better than blanket `github_release`.
  if (is('github.com')) {
    if (/\/(issues|discussions|pull)(\/|$)/.test(pathname)) {
      return SourceType.CommunityForum;
    }
    if (/\/releases(\/|$)/.test(pathname)) {
      return SourceType.GithubRelease;
    }
    if (/\/(blob|tree|wiki)\//.test(pathname)) {
      return SourceType.OfficialDocs;
    }
    return SourceType.GithubRelease;
  }
  if (is('gitlab.com', 'bitbucket.org')) {
    return SourceType.GithubRelease;
  }

  // Established blogs / publishers
  if (is('medium.com', 'dev.to', 'substack.com', 'hashnode.dev')) {
    return SourceType.EstablishedBlog;
  }
  if (is('blog.csdn.net', 'qiita.com', 'zenn.dev')) {
    return SourceType.EstablishedBlog;
  }

  // Community forums
  if (is('stackoverflow.com', 'stackexchange.com', 'reddit.com', 'news.ycombinator.com')) {
    return SourceType.CommunityForum;
  }

  return SourceType.Unknown;
}

export { research, hostPasses, normalizeTokenizerSpacing, isSemanticGarbage, estimateSourceType };
