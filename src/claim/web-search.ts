import { logger } from '../observability/logger';

// Self-hosted SearXNG meta-search. Aggregates Google/Bing/DuckDuckGo +
// GitHub/arXiv/Wikipedia and returns dedup'd results. JSON API.
const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://searxng:8080';
const SEARCH_TIMEOUT_MS = 6000;
const MAX_RESULTS = 8;

interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  engine?: string;
}

/**
 * Search the web for evidence about a claim. Returns up to N URLs
 * sorted by SearXNG's internal score (which factors in source
 * authority + result freshness + multi-engine agreement). Empty
 * array on failure — caller commits unverified via exhausted_pipeline.
 *
 * The query is the claim text verbatim. SearXNG reformulates as
 * needed via its language detection; passing a manually rewritten
 * query yielded *worse* recall in practice because the rewrite
 * dropped distinctive entity names.
 */
async function webSearch(claim: string): Promise<WebSearchResult[]> {
  const ctrl = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const url = `${SEARXNG_URL}/search?${new URLSearchParams({
    q: claim,
    format: 'json',
    safesearch: '0',
  })}`;

  try {
    const res = await fetch(url, { signal: ctrl, headers: { accept: 'application/json' } });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'searxng search failed');
      return [];
    }
    const json = (await res.json()) as {
      results?: Array<{
        url: string;
        title?: string;
        content?: string;
        engine?: string;
      }>;
    };
    const results = json.results ?? [];
    return dedupByDomain(results)
      .slice(0, MAX_RESULTS)
      .map(r => ({
        url: r.url,
        title: r.title ?? '',
        snippet: r.content ?? '',
        engine: r.engine,
      }));
  } catch (err) {
    logger.debug({ error: (err as Error).message }, 'web search error');
    return [];
  }
}

/**
 * Dedup results by registrable domain so five copies of the same
 * Reuters wire story don't count as five independent sources. We
 * keep the first (highest-ranked) hit per domain.
 */
function dedupByDomain<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./, '');
      if (seen.has(host)) {
        continue;
      }
      seen.add(host);
      out.push(item);
    } catch {
      // malformed URL — skip
    }
  }
  return out;
}

export { webSearch };
