import { z } from 'zod';

import type { SearchResult } from '../../search/search';
import type { Progress } from '../types';

import { fetchClaimsForEntries, fetchFactBundlesForEntries, fetchFactualityForEntries } from '../../claim/query';
import { research } from '../../collect/research';
import { logger } from '../../observability/logger';
import { SortBy, TrustLevel } from '../../score/enums';
import { search, explore } from '../../search/search';

const NOOP_PROGRESS: Progress = { emit: () => {} };

const findInputSchema = z.object({
  query: z.string().min(1).max(1000).optional(),
  topic: z.string().min(1).max(1000).optional(),
  domain: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  minAuthority: z.number().min(0).max(1).optional(),
  minTrustLevel: z.enum(TrustLevel).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

async function handleFind(input: Record<string, unknown>, progress: Progress = NOOP_PROGRESS): Promise<unknown> {
  const validated = findInputSchema.parse(input);
  const queryText = validated.query ?? validated.topic;

  // No query text → explore mode (filter-only browsing)
  if (!queryText) {
    progress.emit('explore');
    const result = await explore({
      domain: validated.domain,
      tags: validated.tags,
      minAuthority: validated.minAuthority,
      minTrustLevel: validated.minTrustLevel,
      sortBy: SortBy.Authority,
      limit: validated.limit,
      cursor: validated.cursor,
    });
    return await formatResult(result, false, undefined, undefined);
  }

  // Step 1: search existing data
  progress.emit('search_stored', { query: queryText });
  const firstResult = await search({
    query: queryText,
    domain: validated.domain,
    tags: validated.tags,
    language: validated.language,
    minAuthority: validated.minAuthority,
    minTrustLevel: validated.minTrustLevel,
    limit: validated.limit,
    cursor: validated.cursor,
  });

  // Enough results AND top match actually covers the query → return.
  // OR-based FTS (search.ts) can return entries that share only one
  // incidental query term (e.g. "2023"); count alone is not a quality
  // signal. termCoverage from rank.ts expresses how much of the query
  // the top entry actually covers.
  const MIN_RESULTS = 3;
  const MIN_TOP_COVERAGE = 0.4;
  const topCoverage = firstResult.scores[0]?.termCoverage ?? 0;
  const enoughResults = firstResult.entries.length >= MIN_RESULTS;
  const strongTopMatch = topCoverage >= MIN_TOP_COVERAGE;
  if (validated.cursor || (enoughResults && strongTopMatch)) {
    return await formatResult(firstResult, false, undefined, queryText);
  }

  // Step 2: auto-research to collect new data
  logger.info(
    {
      query: queryText,
      found: firstResult.entries.length,
      minResults: MIN_RESULTS,
      topCoverage,
      minTopCoverage: MIN_TOP_COVERAGE,
    },
    'find: insufficient or weak results, starting auto-research',
  );
  progress.emit('research_started', {
    query: queryText,
    storedMatches: firstResult.entries.length,
    topCoverage,
  });

  const researchResult = await research(
    {
      topic: queryText,
      domain: validated.domain,
    },
    progress,
  );

  logger.info(
    {
      urlsProcessed: researchResult.urlsProcessed,
      entriesStored: researchResult.entriesStored,
      entriesSkippedLowRelevance: researchResult.entriesSkippedLowRelevance,
    },
    'find: auto-research completed',
  );
  progress.emit('research_completed', {
    urlsProcessed: researchResult.urlsProcessed,
    entriesStored: researchResult.entriesStored,
    entriesSkippedLowRelevance: researchResult.entriesSkippedLowRelevance,
    status: researchResult.status,
  });

  // Step 3: re-search with newly ingested data
  progress.emit('search_rerun');
  const finalResult = await search({
    query: queryText,
    domain: validated.domain,
    tags: validated.tags,
    language: validated.language,
    minAuthority: validated.minAuthority,
    minTrustLevel: validated.minTrustLevel,
    limit: validated.limit,
  });

  return await formatResult(
    finalResult,
    true,
    {
      urlsProcessed: researchResult.urlsProcessed,
      entriesStored: researchResult.entriesStored,
      entriesSkippedLowRelevance: researchResult.entriesSkippedLowRelevance,
    },
    queryText,
  );
}

interface ResearchStats {
  urlsProcessed: number;
  entriesStored: number;
  entriesSkippedLowRelevance: number;
}

async function formatResult(result: SearchResult, researched: boolean, researchStats?: ResearchStats, query?: string) {
  // v0.3: attach top claims + factuality to each entry when present.
  // fetchClaimsForEntries returns an empty map when no claims exist for
  // the given entries, so this is a zero-cost no-op for v0.2 callers.
  // v0.4: also build top-level factBundles — verified atomic claims
  // with their 1-hop graph context (supports / contradicts / derives /
  // supersedes / refines). This is the surface the design promises:
  // structured fact + provenance + dispute, not raw paragraphs.
  //
  // When a query is present we run a cross-encoder rerank over the
  // candidate claim statements (stage 2 of the design's retrieval
  // pipeline) — without that, bundles surface by certainty alone,
  // which prefers "most confident" over "most relevant".
  const entryRefs = result.entries.map(e => ({ id: e.id, createdAt: e.createdAt }));
  const [claimsByEntry, factualityByEntry, factBundles] = await Promise.all([
    fetchClaimsForEntries(entryRefs),
    fetchFactualityForEntries(entryRefs),
    fetchFactBundlesForEntries(entryRefs, { query }),
  ]);

  const enrichedEntries = result.entries.map(e => {
    const claims = claimsByEntry.get(e.id);
    const factuality = factualityByEntry.get(e.id);
    return {
      ...e,
      ...(claims && claims.length > 0 ? { claims } : {}),
      ...(factuality !== undefined ? { factuality } : {}),
    };
  });

  return {
    entries: enrichedEntries,
    scores: result.scores,
    trustLevels: result.trustLevels,
    nextCursor: result.nextCursor,
    // v0.4 retrieval surface — verified facts with graph context.
    // Empty array when no verified claims exist for the result set.
    factBundles,
    researched,
    ...(researchStats && { research: researchStats }),
  };
}

export { handleFind };
