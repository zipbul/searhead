// Source authority weighting. NLI gives the *probability* a source
// supports a claim; authority gives the *credibility* of that source.
// The aggregator multiplies them so a 0.99 entailment from a random
// blog is weighted below a 0.85 entailment from arXiv.
//
// Scores come from a hand-curated domain table — calibrating these
// against a labeled set is future work, but even rough buckets beat
// treating reddit and gov.uk as equally trustworthy.

interface AuthorityRule {
  match: (host: string) => boolean;
  score: number;
}

const RULES: AuthorityRule[] = [
  // Tier 1: primary / official sources
  { match: h => h.endsWith('.gov') || h.endsWith('.gov.uk') || h.endsWith('.gov.kr'), score: 0.95 },
  { match: h => h.endsWith('.edu') || h.endsWith('.ac.uk') || h.endsWith('.ac.kr'), score: 0.9 },
  { match: h => /(^|\.)arxiv\.org$/.test(h), score: 0.9 },
  { match: h => /(^|\.)nature\.com$/.test(h) || /(^|\.)science\.org$/.test(h), score: 0.9 },
  { match: h => /(^|\.)nih\.gov$/.test(h) || /pubmed\.ncbi/.test(h), score: 0.9 },
  { match: h => /(^|\.)github\.com$/.test(h), score: 0.85 },
  { match: h => /(^|\.)ietf\.org$/.test(h) || /(^|\.)w3\.org$/.test(h), score: 0.9 },

  // Tier 2: established journalism / encyclopedias
  { match: h => /(^|\.)nytimes\.com$/.test(h), score: 0.75 },
  { match: h => /(^|\.)bbc\.(com|co\.uk)$/.test(h), score: 0.8 },
  { match: h => /(^|\.)reuters\.com$/.test(h) || /(^|\.)apnews\.com$/.test(h), score: 0.8 },
  { match: h => /(^|\.)economist\.com$/.test(h), score: 0.75 },
  { match: h => /(^|\.)wikipedia\.org$/.test(h), score: 0.7 },
  { match: h => /(^|\.)wsj\.com$/.test(h) || /(^|\.)ft\.com$/.test(h), score: 0.75 },

  // Tier 3: tech-press / Stack Exchange
  { match: h => /(^|\.)stackoverflow\.com$/.test(h) || /(^|\.)stackexchange\.com$/.test(h), score: 0.6 },
  { match: h => /(^|\.)mdn\./.test(h) || h.endsWith('developer.mozilla.org'), score: 0.85 },
  { match: h => /(^|\.)techcrunch\.com$/.test(h) || /(^|\.)theverge\.com$/.test(h), score: 0.55 },

  // Tier 4: blogs / community
  { match: h => /(^|\.)medium\.com$/.test(h) || /(^|\.)dev\.to$/.test(h), score: 0.4 },
  { match: h => /(^|\.)qiita\.com$/.test(h) || /(^|\.)zenn\.dev$/.test(h), score: 0.4 },
  { match: h => /(^|\.)substack\.com$/.test(h), score: 0.35 },

  // Tier 5: social / forums
  { match: h => /(^|\.)reddit\.com$/.test(h) || /(^|\.)hackernews\.com$/.test(h), score: 0.25 },
  { match: h => /(^|\.)twitter\.com$/.test(h) || /(^|\.)x\.com$/.test(h), score: 0.2 },
  { match: h => /(^|\.)facebook\.com$/.test(h) || /(^|\.)instagram\.com$/.test(h), score: 0.15 },
];

const DEFAULT_AUTHORITY = 0.5;

export function authorityFor(url: string): number {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return DEFAULT_AUTHORITY;
  }
  for (const rule of RULES) {
    if (rule.match(host)) {
      return rule.score;
    }
  }
  return DEFAULT_AUTHORITY;
}
