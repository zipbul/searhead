import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { extractTriples } from './extract';

// Short-lived memoization: a single verify run hits expandWithKgFacts
// once for the parent claim, and once per CoVe sub-claim — previously
// each sub-claim re-extracted triples via LLM and re-queried the KG.
// Sub-claims share most of the parent's entities, so the triple
// extraction + KG SELECT overlap is large. TTL is 2 minutes so a
// long-running batch doesn't serve stale KG facts.
interface CachedFacts {
  value: string;
  expiresAt: number;
}
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, CachedFacts>();

function cacheKey(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
}

// KG premise expansion.
//
// NLI scores improve dramatically when the premise contains the
// fact being asserted. A chunk that says "Bun is fast and modern"
// gives weak signal about whether Bun runs on V8, but if we prefix
// the premise with verified KG facts about Bun ("Bun runs on
// JavaScriptCore", "Bun was created by Jarred Sumner") then the
// model can directly compare the claim's V8 assertion against
// those known facts.
//
// We pull at most a handful of verified triples about the claim's
// subject and serialize them as natural-language sentences so the
// NLI model can attend to them as ordinary text.

const MAX_FACTS = 6;
const MAX_FACT_CHARS = 800;

interface KgFact {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Pull up to MAX_FACTS verified KG facts where the subject (or
 * object) matches one of the entities in the claim. Returns a
 * short prefix string suitable for prepending to NLI premise input.
 * Empty string when nothing matches — caller's premise unchanged.
 */
export async function expandWithKgFacts(claim: string): Promise<string> {
  const key = cacheKey(claim);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) {
    return hit.value;
  }

  const triples = await extractTriples(claim);
  if (triples.length === 0) {
    cache.set(key, { value: '', expiresAt: Date.now() + CACHE_TTL_MS });
    return '';
  }

  const entityNames = new Set<string>();
  for (const t of triples) {
    entityNames.add(t.subject.name.trim().toLowerCase());
    entityNames.add(t.object.name.trim().toLowerCase());
  }
  if (entityNames.size === 0) {
    return '';
  }

  const names = Array.from(entityNames);
  // Drizzle's tagged template expands array bindings positionally,
  // so ANY(${names}) becomes ANY(($1, $2, ...)) — not a valid Postgres
  // array literal. Build the array as a single bind via sql.array
  // (text[]) so ANY() sees one parameter.
  const namesArr = sql`ARRAY[${sql.join(
    names.map(n => sql`${n}`),
    sql`, `,
  )}]::text[]`;
  const rows = (await getDb().execute(sql`
    SELECT
      src.name AS subject,
      r.relation_type AS predicate,
      tgt.name AS object
    FROM kg_relation r
    JOIN entity src ON src.id = r.source_entity_id
    JOIN entity tgt ON tgt.id = r.target_entity_id
    JOIN claim c ON c.id = r.claim_id
    WHERE c.verdict = 'verified'
      AND (lower(src.name) = ANY(${namesArr}) OR lower(tgt.name) = ANY(${namesArr}))
    ORDER BY r.weight DESC, r.created_at DESC
    LIMIT ${MAX_FACTS}
  `)) as unknown as KgFact[];

  if (rows.length === 0) {
    cache.set(key, { value: '', expiresAt: Date.now() + CACHE_TTL_MS });
    return '';
  }

  const sentences = rows.map(r => `${r.subject} ${r.predicate.replace(/_/g, ' ')} ${r.object}.`);
  let out = `Known facts: ${sentences.join(' ')}\n\n`;
  if (out.length > MAX_FACT_CHARS) {
    out = out.slice(0, MAX_FACT_CHARS) + '\n\n';
  }
  cache.set(key, { value: out, expiresAt: Date.now() + CACHE_TTL_MS });
  return out;
}
