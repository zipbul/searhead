import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { logger } from '../observability/logger';
import { extractTriples, type ExtractedTriple } from './extract';
import { normalizePredicate } from './predicate';

interface KgContradiction {
  newTriple: ExtractedTriple;
  conflictingObjects: Array<{
    objectName: string;
    objectType: string;
    supportingClaims: number;
    /**
     * IDs of the verified claims that asserted this conflicting
     * object. Caller uses these to write CONTRADICTS edges from the
     * new claim into each. Capped to the top few to bound edge fanout
     * on subjects with hundreds of corroborations.
     */
    claimIds: string[];
  }>;
  /**
   * Heuristic confidence the contradiction is real. Combines:
   *  - functional-predicate prior (predicate has historically mapped
   *    each subject to exactly one object across the verified KG)
   *  - corroboration depth (number of independent verified claims
   *    that asserted the conflicting object)
   * Range 0-1; >= 0.7 is the threshold callers use to short-circuit
   * to `disputed` without running source_check.
   */
  confidence: number;
}

/**
 * Check whether the supplied claim's triples conflict with existing
 * verified knowledge in the KG. Returns at most one strongest
 * contradiction (the predicate with the highest confidence).
 *
 * "Conflict" means: the same (subject, predicate) was previously
 * asserted with a *different* object by one or more verified claims.
 * Multi-value predicates (e.g. "supports", "contains") naturally have
 * many objects per subject and are filtered out by the functional-
 * predicate test below — only single-value relations (e.g. "runs_on",
 * "founded_by", "capital_of") trigger a contradiction signal.
 */
async function checkKgContradiction(statement: string): Promise<KgContradiction | null> {
  const triples = await extractTriples(statement);
  if (triples.length === 0) {
    return null;
  }

  let best: KgContradiction | null = null;

  for (const t of triples) {
    const conflicts = await findConflictingObjects(t);
    if (conflicts.length === 0) {
      continue;
    }

    const isFunctional = await isFunctionalPredicate(t.predicate);
    if (!isFunctional) {
      continue;
    }

    const totalSupport = conflicts.reduce((s, c) => s + c.supportingClaims, 0);
    // confidence floor 0.7 once functional + at least one corroborated
    // conflicting object exists; rises with corroboration depth.
    const confidence = Math.min(0.95, 0.7 + 0.05 * Math.min(totalSupport, 5));

    if (!best || confidence > best.confidence) {
      best = { newTriple: t, conflictingObjects: conflicts, confidence };
    }
  }

  if (best) {
    logger.info(
      {
        subject: best.newTriple.subject.name,
        predicate: best.newTriple.predicate,
        newObject: best.newTriple.object.name,
        conflicts: best.conflictingObjects.length,
        confidence: best.confidence,
      },
      'KG contradiction detected',
    );
  }
  return best;
}

interface ConflictRow {
  object_name: string;
  object_type: string;
  claim_ids: string[];
  supporting_claims: number;
}

/**
 * Find verified KG triples sharing (subject, predicate) with the new
 * triple but pointing at a *different* object. Subject is matched by
 * normalized name + type (case-insensitive).
 */
async function findConflictingObjects(t: ExtractedTriple): Promise<
  Array<{
    objectName: string;
    objectType: string;
    supportingClaims: number;
    claimIds: string[];
  }>
> {
  const subjName = t.subject.name.trim();
  const predicate = normalizePredicate(t.predicate);
  const newObjName = t.object.name.trim().toLowerCase();

  // Match subjects by name (case-insensitive), ignoring `type`. The
  // LLM that extracts triples assigns types inconsistently across
  // calls — same entity might be "tech" once and "other" another
  // time — so requiring type-equality misses real conflicts. Same
  // for the object exclusion: compare object names only.
  //
  // We also array_agg the contributing claim ids (capped to 10 per
  // object) so the verify pipeline can write CONTRADICTS edges from
  // the new claim into each. The cap bounds edge fanout when a
  // subject has hundreds of corroborating claims.
  const rows = (await getDb().execute(sql`
    SELECT
      tgt.name AS object_name,
      tgt.type AS object_type,
      COUNT(DISTINCT r.claim_id)::int AS supporting_claims,
      (array_agg(DISTINCT r.claim_id))[1:10] AS claim_ids
    FROM kg_relation r
    JOIN entity src ON src.id = r.source_entity_id
    JOIN entity tgt ON tgt.id = r.target_entity_id
    JOIN claim c ON c.id = r.claim_id
    WHERE lower(src.name) = lower(${subjName})
      AND r.relation_type = ${predicate}
      AND c.verdict = 'verified'
      AND lower(tgt.name) <> ${newObjName}
    GROUP BY tgt.name, tgt.type
    ORDER BY supporting_claims DESC
    LIMIT 5
  `)) as unknown as ConflictRow[];

  return rows.map(r => ({
    objectName: r.object_name,
    objectType: r.object_type,
    claimIds: r.claim_ids ?? [],
    supportingClaims: r.supporting_claims,
  }));
}

/**
 * A predicate is "functional" when, across the verified KG so far, it
 * has rarely mapped a single subject to multiple distinct objects.
 * Cheap proxy: the average number of distinct objects per subject for
 * this predicate is below 1.5. Multi-value predicates like "supports"
 * or "contains" sit far above that threshold and are correctly
 * exempted from triggering a contradiction.
 *
 * The first time a predicate is seen with a single (subject, object)
 * pair we treat it as functional by default — better to surface an
 * over-eager dispute that source_check can clear than to miss a real
 * factual conflict.
 */
// Cache predicate functional-ness so every verify-hot-path claim
// doesn't re-aggregate the full kg_relation table. 5-minute TTL means
// a newly-added relation type picks up its true cardinality within one
// calibration window without blocking the live verify queue.
interface FunctionalCacheEntry {
  functional: boolean;
  expiresAt: number;
}
const FUNCTIONAL_TTL_MS = 5 * 60 * 1000;
const functionalCache = new Map<string, FunctionalCacheEntry>();

async function isFunctionalPredicate(predicate: string): Promise<boolean> {
  const pred = normalizePredicate(predicate);
  const cached = functionalCache.get(pred);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.functional;
  }

  const rows = (await getDb().execute(sql`
    SELECT
      COUNT(DISTINCT r.target_entity_id)::float
        / GREATEST(COUNT(DISTINCT r.source_entity_id), 1) AS avg_objects_per_subject,
      COUNT(*)::int AS total
    FROM kg_relation r
    JOIN claim c ON c.id = r.claim_id
    WHERE r.relation_type = ${pred}
      AND c.verdict = 'verified'
  `)) as unknown as Array<{ avg_objects_per_subject: number; total: number }>;

  const row = rows[0];
  const functional = !row || row.total === 0 ? true : row.avg_objects_per_subject < 1.5;
  functionalCache.set(pred, { functional, expiresAt: Date.now() + FUNCTIONAL_TTL_MS });
  return functional;
}

export { checkKgContradiction };
export type { KgContradiction };
