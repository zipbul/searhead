import { and, eq, desc, inArray, or, sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { claim, claimRelation, entryScore } from '../db/schema';
import { rerank } from '../llm/reranker';
import { logger } from '../observability/logger';
import { RelationType } from '../score/enums';

interface ClaimSummary {
  id: string;
  statement: string;
  type: string;
  verdict: string;
  certainty: number;
}

const MAX_CLAIMS_PER_ENTRY = 5;

/**
 * Fetch up to MAX_CLAIMS_PER_ENTRY claims per entry, preferring high-
 * certainty claims. Ordering carries `claim.id` as the final tie-
 * breaker so the results are deterministic across repeated queries
 * — the previous `ORDER BY certainty DESC, created_at DESC` without a
 * stable secondary key produced different orderings on equal-certainty
 * rows (the comment even claimed "by id for stability" but the id
 * wasn't in the ORDER BY list).
 *
 * Also threads `entry_created_at` through the WHERE clause so the
 * composite index `(entry_id, entry_created_at)` actually gets used —
 * without it Postgres only utilizes the first column.
 */
async function fetchClaimsForEntries(entries: Array<{ id: string; createdAt: string }>): Promise<Map<string, ClaimSummary[]>> {
  const byEntry = new Map<string, ClaimSummary[]>();
  if (entries.length === 0) {
    return byEntry;
  }

  // Build (entry_id, entry_created_at) pair predicate. When all entries
  // share a single created_at column this produces the same plan as a
  // plain IN, but in the heterogeneous case Postgres can use the
  // composite index efficiently.
  const pairPredicates = entries.map(e => and(eq(claim.entryId, e.id), eq(claim.entryCreatedAt, new Date(e.createdAt)))!);

  const rows = await getDb()
    .select({
      id: claim.id,
      entryId: claim.entryId,
      statement: claim.statement,
      type: claim.type,
      verdict: claim.verdict,
      certainty: claim.certainty,
    })
    .from(claim)
    .where(or(...pairPredicates))
    .orderBy(desc(claim.certainty), desc(claim.createdAt), sql`${claim.id} DESC`);

  for (const r of rows) {
    const bucket = byEntry.get(r.entryId) ?? [];
    if (bucket.length >= MAX_CLAIMS_PER_ENTRY) {
      continue;
    }
    bucket.push({
      id: r.id,
      statement: r.statement,
      type: r.type,
      verdict: r.verdict,
      certainty: r.certainty,
    });
    byEntry.set(r.entryId, bucket);
  }

  return byEntry;
}

// ============================================================
// Fact bundle — the v0.4 retrieval surface.
//
// A FactBundle is what an agent receives when it asks for facts: a
// single atomic claim plus its 1-hop graph context (supporting,
// contradicting, deriving-from claims). Surfacing contradictions on
// every retrieved fact is the design's core guard against hallucination
// — the agent sees disputes explicitly and never has to assume.
// ============================================================

interface FactRelationLink {
  claimId: string;
  statement: string;
  verdict: string;
  certainty: number;
}

interface FactBundle {
  id: string;
  entryId: string;
  statement: string;
  type: string;
  verdict: string;
  certainty: number;
  sourceSpan: string | null;
  sourceUrl: string | null;
  modality: string | null;
  // true = positive assertion, false = negated, null = legacy/unknown
  polarity: boolean | null;
  quantifier: string | null;
  validFrom: string | null;
  validUntil: string | null;
  // 1-hop typed edges from claim_relation. Each list is bounded to
  // maxEdgesPerType so the response stays predictable.
  supports: FactRelationLink[];
  contradicts: FactRelationLink[];
  derivesFrom: FactRelationLink[];
  supersededBy: FactRelationLink[];
  refines: FactRelationLink[];
}

interface FetchFactBundlesOptions {
  /** Max bundles per source entry. Default 5. */
  maxPerEntry?: number;
  /**
   * When true (default) only verdict='verified' claims surface as
   * primary bundles. Contradicting/disputed claims still appear via
   * the `contradicts` edges so the agent can see the dispute.
   */
  verifiedOnly?: boolean;
  /** Max edges per relation type per bundle. Default 5. */
  maxEdgesPerType?: number;
  /**
   * When provided, the candidate claim statements are reordered by
   * cross-encoder relevance to this query before graph expansion.
   * Without this primary claims sit in `certainty DESC` order, which
   * surfaces "most confident" facts but not necessarily "most
   * relevant to the query" — the design's stage-2 rerank step.
   */
  query?: string;
}

const DEFAULT_MAX_PER_ENTRY = 5;
const DEFAULT_MAX_EDGES = 5;

/**
 * Build claim-level fact bundles for a set of entries.
 *
 * Strategy:
 *   1. Pick top-N claims per entry by certainty (verified-only by default).
 *   2. Bulk-fetch every claim_relation edge whose source is one of those
 *      claims — five relation types in one round trip.
 *   3. Bulk-fetch the target claims referenced by those edges so each
 *      edge can carry the neighbor's statement / verdict / certainty.
 *   4. Stitch.
 *
 * No N+1 — every step is a single SQL call regardless of bundle count.
 */
async function fetchFactBundlesForEntries(
  entries: Array<{ id: string; createdAt: string }>,
  opts: FetchFactBundlesOptions = {},
): Promise<FactBundle[]> {
  if (entries.length === 0) {
    return [];
  }

  const maxPerEntry = opts.maxPerEntry ?? DEFAULT_MAX_PER_ENTRY;
  const maxEdges = opts.maxEdgesPerType ?? DEFAULT_MAX_EDGES;
  const verifiedOnly = opts.verifiedOnly !== false;

  const pairPredicates = entries.map(e => and(eq(claim.entryId, e.id), eq(claim.entryCreatedAt, new Date(e.createdAt)))!);
  const whereClause = verifiedOnly ? and(or(...pairPredicates), eq(claim.verdict, 'verified')) : or(...pairPredicates);

  const claimRows = await getDb()
    .select({
      id: claim.id,
      entryId: claim.entryId,
      statement: claim.statement,
      type: claim.type,
      verdict: claim.verdict,
      certainty: claim.certainty,
      sourceSpan: claim.sourceSpan,
      sourceUrl: claim.sourceUrl,
      modality: claim.modality,
      polarity: claim.polarity,
      quantifier: claim.quantifier,
      validFrom: claim.validFrom,
      validUntil: claim.validUntil,
    })
    .from(claim)
    .where(whereClause)
    .orderBy(desc(claim.certainty), desc(claim.createdAt), sql`${claim.id} DESC`);

  // Trim per entry — DB cap would require a window function; cheaper to
  // do this in memory once.
  const perEntryCount = new Map<string, number>();
  let primaryClaims: typeof claimRows = [];
  for (const c of claimRows) {
    const n = perEntryCount.get(c.entryId) ?? 0;
    if (n >= maxPerEntry) {
      continue;
    }
    perEntryCount.set(c.entryId, n + 1);
    primaryClaims.push(c);
  }
  if (primaryClaims.length === 0) {
    return [];
  }

  // Stage 2 rerank: when a query was supplied, reorder primary
  // claims by cross-encoder relevance. Without this they sit in
  // certainty DESC order — "most confident facts" rather than "facts
  // most relevant to the query". The reranker call cost is bounded
  // by primaryClaims.length which is already capped via maxPerEntry.
  if (opts.query && primaryClaims.length > 1) {
    try {
      const order = await rerank(
        opts.query,
        primaryClaims.map(c => c.statement),
      );
      primaryClaims = order.map(idx => primaryClaims[idx]!);
    } catch (err) {
      // Reranker failure shouldn't drop bundles entirely — fall back
      // to the certainty ordering we already have.
      logger.warn({ error: (err as Error).message }, 'claim rerank failed; falling back to certainty order');
    }
  }

  const claimIds = primaryClaims.map(c => c.id);

  // 1-hop edges — outgoing (this claim → other) AND incoming for
  // CONTRADICTS / REFINES / SUPERSEDED_BY where the dispute /
  // refinement is conceptually symmetric. Without the incoming fetch,
  // a verified claim X disputed by a later claim Y would never
  // surface the conflict — the edge is Y→X and X's outgoing-only
  // query misses it.
  const outgoingEdges = await getDb()
    .select({
      pivot: claimRelation.sourceClaimId,
      other: claimRelation.targetClaimId,
      type: claimRelation.relationType,
      weight: claimRelation.weight,
      direction: sql<'out'>`'out'`.as('direction'),
    })
    .from(claimRelation)
    .where(inArray(claimRelation.sourceClaimId, claimIds))
    .orderBy(desc(claimRelation.weight), desc(claimRelation.createdAt));

  // Only CONTRADICTS is direction-symmetric — both endpoints
  // "contradict each other" with equal meaning. REFINES and
  // SUPERSEDED_BY are directional: A--refines-->B means A is the
  // refinement of B, so the buckets `refines` and `supersededBy`
  // only make sense from the outgoing side. Surfacing the inverse
  // semantics ("what refines this?" / "what supersedes this?")
  // would need separate buckets; for now incoming-only fetch is
  // scoped to contradicts to avoid reversing the meaning.
  const incomingEdges = await getDb()
    .select({
      pivot: claimRelation.targetClaimId,
      other: claimRelation.sourceClaimId,
      type: claimRelation.relationType,
      weight: claimRelation.weight,
      direction: sql<'in'>`'in'`.as('direction'),
    })
    .from(claimRelation)
    .where(and(inArray(claimRelation.targetClaimId, claimIds), eq(claimRelation.relationType, 'contradicts')))
    .orderBy(desc(claimRelation.weight), desc(claimRelation.createdAt));

  const edges = [...outgoingEdges, ...incomingEdges];

  // Resolve other-side metadata in one batch.
  const otherIds = Array.from(new Set(edges.map(e => e.other)));
  const targetRows =
    otherIds.length === 0
      ? []
      : await getDb()
          .select({
            id: claim.id,
            statement: claim.statement,
            verdict: claim.verdict,
            certainty: claim.certainty,
          })
          .from(claim)
          .where(inArray(claim.id, otherIds));
  const targetById = new Map(targetRows.map(t => [t.id, t] as const));

  // Bucket edges by pivot claim + relation type.
  type EdgeBuckets = {
    supports: FactRelationLink[];
    contradicts: FactRelationLink[];
    derivesFrom: FactRelationLink[];
    supersededBy: FactRelationLink[];
    refines: FactRelationLink[];
  };
  const emptyBuckets = (): EdgeBuckets => ({
    supports: [],
    contradicts: [],
    derivesFrom: [],
    supersededBy: [],
    refines: [],
  });
  const bucketsByClaim = new Map<string, EdgeBuckets>();
  const dedupeSeen = new Set<string>();
  for (const e of edges) {
    const tgt = targetById.get(e.other);
    if (!tgt) {
      continue;
    }
    const dedupeKey = `${e.pivot}|${e.other}|${e.type}`;
    if (dedupeSeen.has(dedupeKey)) {
      continue;
    }
    dedupeSeen.add(dedupeKey);
    let b = bucketsByClaim.get(e.pivot);
    if (!b) {
      b = emptyBuckets();
      bucketsByClaim.set(e.pivot, b);
    }
    const link: FactRelationLink = {
      claimId: tgt.id,
      statement: tgt.statement,
      verdict: tgt.verdict,
      certainty: tgt.certainty,
    };
    switch (e.type as RelationType) {
      case RelationType.Supports:
        if (b.supports.length < maxEdges) {
          b.supports.push(link);
        }
        break;
      case RelationType.Contradicts:
        if (b.contradicts.length < maxEdges) {
          b.contradicts.push(link);
        }
        break;
      case RelationType.DerivesFrom:
        if (b.derivesFrom.length < maxEdges) {
          b.derivesFrom.push(link);
        }
        break;
      case RelationType.SupersededBy:
        if (b.supersededBy.length < maxEdges) {
          b.supersededBy.push(link);
        }
        break;
      case RelationType.Refines:
        if (b.refines.length < maxEdges) {
          b.refines.push(link);
        }
        break;
      default:
        // Unknown relation type — log and skip rather than throwing.
        // CHECK constraint enforces validity at write time; this is a
        // safety net for legacy rows.
        logger.warn({ relationType: e.type }, 'factBundle: ignoring unknown claim_relation.type');
    }
  }

  return primaryClaims.map(c => {
    const b = bucketsByClaim.get(c.id) ?? emptyBuckets();
    return {
      id: c.id,
      entryId: c.entryId,
      statement: c.statement,
      type: c.type,
      verdict: c.verdict,
      certainty: c.certainty,
      sourceSpan: c.sourceSpan,
      sourceUrl: c.sourceUrl,
      modality: c.modality,
      polarity: c.polarity === null || c.polarity === undefined ? null : c.polarity === 1,
      quantifier: c.quantifier,
      validFrom: c.validFrom ? c.validFrom.toISOString() : null,
      validUntil: c.validUntil ? c.validUntil.toISOString() : null,
      supports: b.supports,
      contradicts: b.contradicts,
      derivesFrom: b.derivesFrom,
      supersededBy: b.supersededBy,
      refines: b.refines,
    };
  });
}

/**
 * Fetch factuality score (0-1) per entry when available.
 */
async function fetchFactualityForEntries(entries: Array<{ id: string; createdAt: string }>): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (entries.length === 0) {
    return result;
  }

  const rows = await getDb()
    .select({
      entryId: entryScore.entryId,
      value: entryScore.value,
    })
    .from(entryScore)
    .where(
      and(
        inArray(
          entryScore.entryId,
          entries.map(e => e.id),
        ),
        eq(entryScore.dimension, 'factuality'),
      ),
    );

  for (const r of rows) {
    result.set(r.entryId, r.value);
  }
  return result;
}

export { fetchClaimsForEntries, fetchFactBundlesForEntries, fetchFactualityForEntries };
