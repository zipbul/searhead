import type { Source } from '../ingest/validate';

import { SourceType } from './enums';

const SOURCE_TYPE_SCORES: Record<SourceType, number> = {
  [SourceType.OfficialDocs]: 0.9,
  [SourceType.GithubRelease]: 0.85,
  [SourceType.CveDb]: 0.9,
  [SourceType.OfficialBlog]: 0.8,
  [SourceType.ResearchPaper]: 0.75,
  [SourceType.EstablishedBlog]: 0.6,
  [SourceType.CommunityForum]: 0.4,
  [SourceType.PersonalBlog]: 0.3,
  [SourceType.AiGenerated]: 0.2,
  [SourceType.ReferenceWiki]: 0.6,
  [SourceType.Unknown]: 0.1,
};

/** Get trust score for a source, always rule-based from sourceType. Caller-supplied trust is ignored. */
export function getSourceTrust(sourceType: string): number {
  return SOURCE_TYPE_SCORES[sourceType as SourceType] ?? 0.1;
}

/**
 * Calculate authority score from sources (rule-based, $0).
 * Multiple sources: max * 0.8 + avg * 0.2
 * No sources: 0.1
 */
export function calculateAuthority(sources: Source[]): number {
  if (sources.length === 0) {
    return 0.1;
  }

  const scores = sources.map(s => getSourceTrust(s.sourceType));

  if (scores.length === 1) {
    return scores[0]!;
  }

  const max = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  return max * 0.8 + avg * 0.2;
}
