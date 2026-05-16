import { logger } from '../observability/logger';

// Specialized retrieval routing.
//
// Generic web search is good for general factual claims but suboptimal
// for narrow domains where a primary database exists:
//
//  - Code / library / framework claims → GitHub Search API. Returns
//    actual repository code and READMEs that authoritatively describe
//    behavior, not blog summaries that may be wrong.
//  - Research / paper / study claims → arXiv API. Returns the paper
//    abstract; we cite the abstract directly rather than a press
//    release that mistranslated the result.
//
// Detection is keyword-based today — light, no extra LLM call. When
// none of the patterns match, only generic web_search runs.

const FETCH_TIMEOUT_MS = 6000;

interface RetrievalHit {
  url: string;
  title: string;
  snippet: string;
  source: 'github' | 'arxiv';
}

const CODE_PATTERNS = [
  /\b(npm|cargo|pip|composer|gem|go install|bun install|yarn add)\b/i,
  /\b(function|class|interface|method|API|endpoint|library|framework|runtime|module)\b/i,
  /\b(github\.com|gitlab|bitbucket)\b/i,
  /\.(js|ts|py|rs|go|java|rb|cpp|c|cs)\b/,
  /\b(repo|repository|commit|pull request|branch)\b/i,
];

const PAPER_PATTERNS = [
  /\b(paper|preprint|arxiv|study|research|published|journal)\b/i,
  /\b(authors? (?:show|demonstrate|find|propose|prove))\b/i,
  /\b(et al\.?|doi:|arxiv:)/i,
  /\b\d{4}\.\d{4,5}\b/, // arXiv-style ID
];

function classifyClaim(statement: string): Array<'code' | 'paper'> {
  const tags: Array<'code' | 'paper'> = [];
  if (CODE_PATTERNS.some(re => re.test(statement))) {
    tags.push('code');
  }
  if (PAPER_PATTERNS.some(re => re.test(statement))) {
    tags.push('paper');
  }
  return tags;
}

async function getSpecializedHits(statement: string): Promise<RetrievalHit[]> {
  const tags = classifyClaim(statement);
  if (tags.length === 0) {
    return [];
  }
  const out: RetrievalHit[] = [];
  if (tags.includes('code')) {
    out.push(...(await searchGithub(statement)));
  }
  if (tags.includes('paper')) {
    out.push(...(await searchArxiv(statement)));
  }
  return out;
}

async function searchGithub(query: string): Promise<RetrievalHit[]> {
  const ctrl = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const url = `https://api.github.com/search/repositories?${new URLSearchParams({
    q: query.slice(0, 200),
    sort: 'stars',
    order: 'desc',
    per_page: '3',
  })}`;
  try {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'knoldr-verifier/0.3',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(url, { signal: ctrl, headers });
    if (!res.ok) {
      return [];
    }
    const json = (await res.json()) as {
      items?: Array<{
        html_url: string;
        full_name: string;
        description?: string;
      }>;
    };
    return (json.items ?? []).slice(0, 3).map(r => ({
      url: r.html_url,
      title: r.full_name,
      snippet: r.description ?? '',
      source: 'github' as const,
    }));
  } catch (err) {
    logger.debug({ error: (err as Error).message }, 'github search failed');
    return [];
  }
}

async function searchArxiv(query: string): Promise<RetrievalHit[]> {
  const ctrl = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  // arXiv API returns Atom XML — small response, easy to parse with
  // regex for our needs (title + summary + abs URL).
  const url = `https://export.arxiv.org/api/query?${new URLSearchParams({
    search_query: `all:${query.slice(0, 200)}`,
    start: '0',
    max_results: '3',
  })}`;
  try {
    const res = await fetch(url, { signal: ctrl });
    if (!res.ok) {
      return [];
    }
    const xml = await res.text();
    const entries = xml.split('<entry>').slice(1, 4);
    return entries
      .map(entry => {
        const linkMatch = entry.match(/<id>([^<]+)<\/id>/);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
        return {
          url: linkMatch?.[1]?.trim() ?? '',
          title: (titleMatch?.[1] ?? '').trim().replace(/\s+/g, ' '),
          snippet: (summaryMatch?.[1] ?? '').trim().replace(/\s+/g, ' ').slice(0, 500),
          source: 'arxiv' as const,
        };
      })
      .filter(h => h.url);
  } catch (err) {
    logger.debug({ error: (err as Error).message }, 'arxiv search failed');
    return [];
  }
}

export { getSpecializedHits };
