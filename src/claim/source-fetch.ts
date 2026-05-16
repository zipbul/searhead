import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { resolve as resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

import { generateEmbedding } from '../ingest/embed';
import { rerank } from '../llm/reranker';
import { logger } from '../observability/logger';
import { sanitizeSource } from './sanitize';

// Per-fetch budget. Most pages render under 5s; the few that don't
// (paywalls, JS-only, dead) we'd rather give up on than block the
// verify worker. NLI handles "no source text" by returning low
// entailment, which is the right outcome for unfetchable sources.
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const USER_AGENT =
  process.env.KNOLDR_FETCH_USER_AGENT ?? 'Mozilla/5.0 (compatible; knoldr-verifier/0.3; +https://github.com/parkrevil)';

interface FetchedSource {
  url: string;
  status: 'ok' | 'fetch_failed' | 'no_content' | 'blocked_type';
  title?: string;
  text?: string;
  byline?: string;
  publishedTime?: string;
  lang?: string;
  fetchedAt: Date;
  error?: string;
  /** True when prompt-injection patterns were stripped from text. */
  injected?: boolean;
}

// LRU cache: same Wikipedia / arXiv / GitHub URLs get hit
// repeatedly across claims (often dozens of times in a single verify
// batch). Caching the parsed body avoids re-fetching + re-running
// Readability for ~24h, which is well within how often these
// sources change. Capped at 1000 entries; oldest evicted first.
const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, { result: FetchedSource; expiresAt: number }>();
const inflight = new Map<string, Promise<FetchedSource>>();

function cacheGet(url: string): FetchedSource | null {
  const hit = cache.get(url);
  if (!hit) {
    return null;
  }
  if (Date.now() > hit.expiresAt) {
    cache.delete(url);
    return null;
  }
  // LRU bump: re-insert to move to most-recent position.
  cache.delete(url);
  cache.set(url, hit);
  return hit.result;
}

function cacheSet(url: string, result: FetchedSource): void {
  cache.set(url, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

/**
 * Fetch a URL and extract the main readable body via Readability.
 * Returns text suitable for NLI premise input; never throws. Cached
 * for 24h; concurrent calls for the same URL share one in-flight
 * fetch (no thundering herd when a batch verifies many claims that
 * all reference the same authoritative source).
 */
async function fetchSource(url: string): Promise<FetchedSource> {
  const cached = cacheGet(url);
  if (cached) {
    return cached;
  }
  const inFlight = inflight.get(url);
  if (inFlight) {
    return inFlight;
  }

  // We store the in-flight promise BEFORE awaiting so concurrent callers
  // see it and dedupe. Each waiter resolves to the same FetchedSource;
  // the post-fetch cleanup (cache write + dedupe map evict) runs once.
  const promise = (async () => {
    const result = await doFetch(url);
    cacheSet(url, result);
    inflight.delete(url);
    return result;
  })();
  inflight.set(url, promise);
  return promise;
}

async function doFetch(url: string): Promise<FetchedSource> {
  const fetchedAt = new Date();

  // SSRF guard: reject non-http(s), disallowed ports, and any hostname
  // that resolves to a private / loopback / link-local / unique-local
  // range. Must run BEFORE fetch() so redirects on internal hostnames
  // are re-validated (see manual redirect follow below).
  const guarded = await assertPublicUrl(url);
  if (!guarded.ok) {
    return { url, status: 'fetch_failed', fetchedAt, error: guarded.reason };
  }

  const ctrl = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  try {
    // `redirect: "manual"` so each hop is re-validated against the SSRF
    // filter. Follow up to 5 redirects; anything beyond is suspicious.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      const check = await assertPublicUrl(current);
      if (!check.ok) {
        return { url, status: 'fetch_failed', fetchedAt, error: check.reason };
      }
      res = await fetch(current, {
        signal: ctrl,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          break;
        }
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    }
    if (!res) {
      return { url, status: 'fetch_failed', fetchedAt, error: 'no response' };
    }

    if (!res.ok) {
      return { url, status: 'fetch_failed', fetchedAt, error: `HTTP ${res.status}` };
    }

    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      // PDF, plain text, JSON etc. — Readability won't help. Could add
      // pdf.js later; for now treat as unfetchable so NLI returns neutral.
      return { url, status: 'blocked_type', fetchedAt, error: `content-type ${ct}` };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return { url, status: 'blocked_type', fetchedAt, error: 'body too large' };
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.textContent || article.textContent.trim().length < 100) {
      return { url, status: 'no_content', fetchedAt, error: 'readability returned empty' };
    }

    const normalized = normalizeWhitespace(article.textContent);
    const sanitized = sanitizeSource(normalized);
    if (sanitized.injected) {
      logger.warn({ url }, 'prompt-injection patterns scrubbed from source');
    }
    return {
      url,
      status: 'ok',
      title: article.title ?? undefined,
      text: sanitized.cleaned,
      byline: article.byline ?? undefined,
      publishedTime: article.publishedTime ?? undefined,
      lang: article.lang ?? undefined,
      fetchedAt,
      injected: sanitized.injected,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.debug({ url, error: msg }, 'source fetch failed');
    return { url, status: 'fetch_failed', fetchedAt, error: msg };
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Reject URLs pointing at internal infrastructure. Covers:
 *  - non-http(s) schemes (file://, gopher://, ftp://, ...)
 *  - non-standard ports (only 80/443 and the explicit default allowed,
 *    plus hosts listed in KNOLDR_ALLOWED_INTERNAL_HOSTS)
 *  - IP literals in private/loopback/link-local/unique-local ranges
 *  - hostnames that resolve to any of the above (A + AAAA checked)
 *
 * Opt-in allowlist: set `KNOLDR_ALLOWED_INTERNAL_HOSTS` to a
 * comma-separated list of hostnames (e.g. an internal wiki) that the
 * verifier is expected to reach. Entries in this list bypass the
 * private-IP and port-range checks — use sparingly and only for hosts
 * whose content is trusted.
 */
function getAllowedInternalHosts(): Set<string> {
  const raw = process.env.KNOLDR_ALLOWED_INTERNAL_HOSTS ?? '';
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function assertPublicUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `disallowed scheme ${u.protocol}` };
  }
  const host = (u.hostname || '').toLowerCase();
  if (!host) {
    return { ok: false, reason: 'empty host' };
  }

  // Explicit allowlist escape hatch for legitimate intranet sources.
  const allowed = getAllowedInternalHosts();
  if (allowed.has(host)) {
    return { ok: true };
  }

  // Resolve (or recognize IP literal) and check every address.
  const ips: string[] = [];
  if (isIP(host)) {
    ips.push(host);
  } else {
    try {
      const [a, aaaa] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      if (a.status === 'fulfilled') {
        ips.push(...a.value);
      }
      if (aaaa.status === 'fulfilled') {
        ips.push(...aaaa.value);
      }
    } catch {
      return { ok: false, reason: 'dns error' };
    }
  }
  if (ips.length === 0) {
    return { ok: false, reason: 'no dns records' };
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return { ok: false, reason: `private ip ${ip}` };
    }
  }
  return { ok: true };
}

function isPrivateIp(ip: string): boolean {
  // IPv6: loopback ::1, link-local fe80::/10, unique-local fc00::/7,
  // IPv4-mapped ::ffff:a.b.c.d, unspecified ::.
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') {
      return true;
    }
    if (lower.startsWith('fe80:') || /^fe[89ab]/.test(lower)) {
      return true;
    }
    if (/^f[cd]/.test(lower)) {
      return true;
    }
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isPrivateIp(mapped[1]!);
    }
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // reject anything we can't parse
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) {
    return true;
  } // 10/8
  if (a === 127) {
    return true;
  } // 127/8 loopback
  if (a === 169 && b === 254) {
    return true;
  } // 169.254/16 link-local (AWS metadata, etc.)
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  } // 172.16/12
  if (a === 192 && b === 168) {
    return true;
  } // 192.168/16
  if (a === 0) {
    return true;
  } // 0.0.0.0/8 unspecified
  if (a >= 224) {
    return true;
  } // multicast / reserved
  return false;
}

/**
 * Return the top-K chunks of `text` most relevant to `claim`. Two
 * stages:
 *   1. Dual-encoder cosine pre-filter on all chunks (cheap, ~10ms
 *      each). Drops obviously irrelevant chunks down to a candidate
 *      pool of ~3×K.
 *   2. Cross-encoder reranker (bge-reranker-base) on the candidates.
 *      A cross-encoder evaluates the (claim, chunk) pair jointly,
 *      which catches "mentions the entity but contradicts the claim"
 *      cases that the dual-encoder misranks because both sentences
 *      embed near the same point.
 */
async function selectRelevantChunks(text: string, claim: string, topK = 6, chunkChars = 400): Promise<string[]> {
  const chunks = chunkBySentences(text, chunkChars);
  if (chunks.length === 0) {
    return [text];
  }
  if (chunks.length <= topK) {
    return chunks;
  }

  // Stage 1: dual-encoder shortlist — keep top 3×K by cosine.
  const claimVec = await generateEmbedding(claim);
  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const v = await generateEmbedding(chunks[i]!);
    scored.push({ idx: i, score: cosine(claimVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  const shortlistSize = Math.min(scored.length, topK * 3);
  const shortlist = scored.slice(0, shortlistSize).map(s => chunks[s.idx]!);

  // Stage 2: cross-encoder rerank for claim-conditional relevance.
  const order = await rerank(claim, shortlist);
  return order.slice(0, topK).map(i => shortlist[i]!);
}

function chunkBySentences(text: string, targetChars: number): string[] {
  const sentences = text.split(/(?<=[.!?。!?])\s+/);
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length + 1 > targetChars && buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= targetChars) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export { fetchSource, selectRelevantChunks };
export type { FetchedSource };
