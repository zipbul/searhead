#!/usr/bin/env bun
/**
 * Probe LangSearch response shape and summary characteristics.
 * Verifies the assumptions baked into search-scraper.ts:
 *   - datePublished field presence
 *   - summary field presence and length distribution
 *   - siteName field presence
 *   - effect of `summary: true` parameter
 */
const KEY = process.env.LANGSEARCH_API_KEY;
if (!KEY) {
  console.error('LANGSEARCH_API_KEY not set');
  process.exit(1);
}

const QUERIES = [
  'FActScore atomic factual evaluation',
  'Bun runtime performance benchmark 2025',
  'xz-utils backdoor supply chain',
  'pgvector HNSW index tuning',
];

interface Hit {
  url?: string;
  name?: string;
  snippet?: string;
  summary?: string;
  datePublished?: string;
  siteName?: string;
  [key: string]: unknown;
}

async function probe(query: string, withSummary: boolean): Promise<Hit[]> {
  const body: Record<string, unknown> = { query, count: 10 };
  if (withSummary) {
    body.summary = true;
  }

  const res = await fetch('https://api.langsearch.com/v1/web-search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[${query}] HTTP ${res.status}`);
    return [];
  }
  const json = (await res.json()) as {
    data?: { webPages?: { value?: Hit[] } };
  };
  return json.data?.webPages?.value ?? [];
}

function stats(values: number[]): string {
  if (values.length === 0) {
    return 'n=0';
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return `n=${values.length} min=${sorted[0]} p50=${sorted[Math.floor(values.length / 2)]} p95=${sorted[Math.floor(values.length * 0.95)]} max=${sorted[sorted.length - 1]} avg=${Math.round(sum / values.length)}`;
}

async function main() {
  for (const withSummary of [false, true]) {
    console.log(`\n=== summary parameter: ${withSummary} ===\n`);
    const summaryLens: number[] = [];
    const snippetLens: number[] = [];
    let datePublishedCount = 0;
    let siteNameCount = 0;
    let totalHits = 0;
    let keyUnion = new Set<string>();

    for (const q of QUERIES) {
      const hits = await probe(q, withSummary);
      totalHits += hits.length;
      console.log(`[${q}] ${hits.length} hits`);
      if (hits.length > 0) {
        const first = hits[0]!;
        console.log(`  first hit keys: ${Object.keys(first).join(', ')}`);
        console.log(`  sample:`);
        console.log(`    url: ${first.url}`);
        console.log(`    name: ${(first.name ?? '').slice(0, 80)}`);
        console.log(`    snippet[${(first.snippet ?? '').length}]: ${(first.snippet ?? '').slice(0, 120)}`);
        console.log(`    summary[${(first.summary ?? '').length}]: ${(first.summary ?? '').slice(0, 120)}`);
        console.log(`    datePublished: ${first.datePublished ?? '(missing)'}`);
        console.log(`    siteName: ${first.siteName ?? '(missing)'}`);
      }
      for (const h of hits) {
        Object.keys(h).forEach(k => keyUnion.add(k));
        if (h.summary) {
          summaryLens.push(h.summary.length);
        }
        if (h.snippet) {
          snippetLens.push(h.snippet.length);
        }
        if (h.datePublished) {
          datePublishedCount++;
        }
        if (h.siteName) {
          siteNameCount++;
        }
      }
    }

    console.log(`\n  totalHits: ${totalHits}`);
    console.log(`  summary  : ${stats(summaryLens)}`);
    console.log(`  snippet  : ${stats(snippetLens)}`);
    console.log(`  datePublished present: ${datePublishedCount}/${totalHits}`);
    console.log(`  siteName present     : ${siteNameCount}/${totalHits}`);
    console.log(`  union of keys seen   : ${[...keyUnion].sort().join(', ')}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}

// Top-level await requires the file be a module; this empty export
// satisfies the TS module check without polluting any namespace.
export {};
