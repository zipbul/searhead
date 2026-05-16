import { logger } from '../observability/logger';

const LANGSEARCH_ENDPOINT = 'https://api.langsearch.com/v1/web-search';
const SEARCH_DELAY_MS = 500;
let lastSearchTime = 0;

interface SearchHit {
  url: string;
  title: string;
  // May be up to tens of KB — LangSearch's `summary` is effectively the
  // extracted article text, not a short preview. Falls back to `snippet`
  // (~200 chars) when `summary` is missing.
  content: string;
}

interface LangSearchResponse {
  data?: {
    webPages?: {
      value?: Array<{
        url?: string;
        name?: string;
        snippet?: string;
        summary?: string;
      }>;
    };
  };
}

async function queryLangSearch(query: string): Promise<SearchHit[]> {
  const apiKey = process.env.LANGSEARCH_API_KEY;
  if (!apiKey) {
    logger.error('LANGSEARCH_API_KEY not configured');
    return [];
  }

  try {
    const res = await fetch(LANGSEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, count: 10 }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.warn({ query, status: res.status }, 'LangSearch returned non-OK');
      return [];
    }

    const json = (await res.json()) as LangSearchResponse;
    const hits: SearchHit[] = [];
    for (const p of json.data?.webPages?.value ?? []) {
      if (!p.url || !p.url.startsWith('http')) {
        continue;
      }
      const title = (p.name ?? '').trim();
      const content = (p.summary ?? p.snippet ?? '').trim();
      if (!title && !content) {
        continue;
      }
      hits.push({
        url: p.url,
        title: title || p.url,
        content,
      });
    }

    logger.debug({ query, count: hits.length }, 'LangSearch returned results');
    return hits;
  } catch (err) {
    logger.warn({ query, error: (err as Error).message }, 'LangSearch request failed');
    return [];
  }
}

/**
 * Collect search hits (URL + title + summary + publishedAt) from sub-queries.
 * De-duplicates by URL; prefers the first hit encountered.
 */
async function collectSearchHits(
  subQueries: Array<{ main: string; expansions: string[] }>,
  focusDomains?: string[],
): Promise<SearchHit[]> {
  const byUrl = new Map<string, SearchHit>();

  const queries: string[] = [];
  for (const sq of subQueries) {
    queries.push(sq.main);
    for (const exp of sq.expansions) {
      queries.push(exp);
    }
  }

  for (const query of queries) {
    const elapsed = Date.now() - lastSearchTime;
    if (elapsed < SEARCH_DELAY_MS) {
      await new Promise(r => setTimeout(r, SEARCH_DELAY_MS - elapsed));
    }
    lastSearchTime = Date.now();

    const hits = await queryLangSearch(query);
    for (const hit of hits) {
      if (!byUrl.has(hit.url)) {
        byUrl.set(hit.url, hit);
      }
    }
  }

  const all = [...byUrl.values()];
  if (!focusDomains || focusDomains.length === 0) {
    return all;
  }

  const focused: SearchHit[] = [];
  const rest: SearchHit[] = [];
  for (const hit of all) {
    try {
      const hostname = new URL(hit.url).hostname;
      if (focusDomains.some(d => hostname === d || hostname.endsWith(`.${d}`))) {
        focused.push(hit);
      } else {
        rest.push(hit);
      }
    } catch {
      rest.push(hit);
    }
  }
  return [...focused, ...rest];
}

export { collectSearchHits };
export type { SearchHit };
