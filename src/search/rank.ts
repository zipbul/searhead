interface RawRow {
  id: string;
  title: string;
  content: string;
  language: string;
  metadata: unknown;
  authority: number;
  decayRate: number;
  status: string;
  createdAt: Date;
  pgroongaScore: number;
  domains: string[];
  tags: string[];
  sources: Array<{ url: string; sourceType: string; trust: number }>;
}

interface ScoredEntry {
  id: string;
  title: string;
  content: string;
  language: string;
  metadata: unknown;
  authority: number;
  decayRate: number;
  status: string;
  createdAt: string; // ISO string
  domains: string[];
  tags: string[];
  sources: Array<{ url: string; sourceType: string; trust: number }>;
}

interface ScoreBreakdown {
  relevance: number;
  authority: number;
  freshness: number;
  termCoverage: number;
  final: number;
}

interface RankResult {
  entries: ScoredEntry[];
  scores: ScoreBreakdown[];
  trustLevels: string[];
}

/**
 * Rank search/explore results.
 *
 * Query mode:  final = relevance * 0.5 + authority * 0.2 + freshness * 0.3
 * Explore mode: final = authority * 0.4 + freshness * 0.6 (no relevance)
 *
 * termCoverage: fraction of query terms (lowercased substring) present in
 * title+content. Used by callers (find skill) to detect weak OR-matches
 * that passed FTS on a single incidental term. When queryTerms is empty,
 * defaults to 1.0 (no signal available, don't penalize).
 */
function rank(rows: RawRow[], mode: 'query' | 'explore', queryTerms: string[] = []): RankResult {
  if (rows.length === 0) {
    return { entries: [], scores: [], trustLevels: [] };
  }

  const now = Date.now();

  // Min-max normalize pgroonga scores (per-query, not global)
  const rawScores = rows.map(r => r.pgroongaScore);
  const minScore = Math.min(...rawScores);
  const maxScore = Math.max(...rawScores);
  const scoreRange = maxScore - minScore;

  const normalizedTerms = queryTerms.map(t => t.toLowerCase()).filter(t => t.length > 0);

  const scored = rows.map(row => {
    const relevance = mode === 'explore' ? 0 : scoreRange === 0 ? 1.0 : (row.pgroongaScore - minScore) / scoreRange;

    const authority = row.authority;
    // Use publication date from source metadata when available; fall back to
    // ingest time. Without this, a 10-year-old paper ingested today scores
    // as "fresh" because createdAt = now. A future-dated `publishedAt` is
    // clamped to now so a document can't inflate its freshness by claiming
    // publication in the future.
    const metaDate = extractPublishedAt(row.metadata);
    const referenceDate = metaDate && metaDate.getTime() <= now ? metaDate : row.createdAt;
    const daysSinceReference = Math.max(0, (now - referenceDate.getTime()) / (1000 * 60 * 60 * 24));
    const freshness = Math.exp(-row.decayRate * daysSinceReference);

    let termCoverage = 1.0;
    if (normalizedTerms.length > 0) {
      // Word-boundary matching using Unicode letter/number classes so
      // "go" doesn't claim coverage against "google" and "ai" doesn't
      // match "detail". Each term is escaped and anchored to \b-style
      // boundaries implemented via negative lookaround (the native \b
      // only considers ASCII word chars).
      const text = `${row.title} ${row.content}`.toLowerCase();
      const matched = normalizedTerms.filter(t => containsWord(text, t)).length;
      termCoverage = matched / normalizedTerms.length;
    }

    const final = mode === 'query' ? relevance * 0.5 + authority * 0.2 + freshness * 0.3 : authority * 0.4 + freshness * 0.6;

    const trustLevel = getTrustLevel(authority);

    return {
      entry: {
        id: row.id,
        title: row.title,
        content: row.content,
        language: row.language,
        metadata: row.metadata,
        authority: row.authority,
        decayRate: row.decayRate,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        domains: row.domains,
        tags: row.tags,
        sources: row.sources,
      },
      score: { relevance, authority, freshness, termCoverage, final },
      trustLevel,
    };
  });

  // Sort by final score descending, then id descending
  scored.sort((a, b) => b.score.final - a.score.final || b.entry.id.localeCompare(a.entry.id));

  return {
    entries: scored.map(s => s.entry),
    scores: scored.map(s => s.score),
    trustLevels: scored.map(s => s.trustLevel),
  };
}

function getTrustLevel(authority: number): string {
  if (authority >= 0.7) {
    return 'high';
  }
  if (authority >= 0.4) {
    return 'medium';
  }
  return 'low';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWord(haystack: string, term: string): boolean {
  if (!term) {
    return false;
  }
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(term)}(?:[^\\p{L}\\p{N}]|$)`, 'u');
  return re.test(haystack);
}

function extractPublishedAt(metadata: unknown): Date | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const raw = (metadata as Record<string, unknown>).publishedAt;
  if (typeof raw !== 'string') {
    return null;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export { rank };
export type { RawRow, ScoredEntry, ScoreBreakdown };
