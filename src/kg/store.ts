import { and, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { ExtractedTriple } from './extract';

import { getDb } from '../db/connection';
import { entity, kgRelation } from '../db/schema';
import { generateEmbedding } from '../ingest/embed';
import { logger } from '../observability/logger';
import { normalizePredicate } from './predicate';

/**
 * Upsert an entity by (type, lower(name)). Aliases accumulate if the same
 * underlying entity appears under a different spelling.
 *
 * Race-safe: the DB holds a UNIQUE(type, lower(name)) index (see
 * migrate.ts), so concurrent upserts collapse to a single row. We
 * attempt the INSERT with ON CONFLICT DO NOTHING and read back the
 * surviving row's id rather than doing SELECT-then-INSERT, which had a
 * TOCTOU window where two workers both saw "not found" and both
 * inserted.
 */
async function upsertEntity(name: string, type: string): Promise<string> {
  const normName = name.trim();
  const normType = type.trim().toLowerCase();

  // Exact match first — cheap and resolves 99% of calls without the
  // embedding generation round-trip.
  const [existing] = await getDb()
    .select({ id: entity.id })
    .from(entity)
    .where(and(eq(entity.type, normType), sql`lower(${entity.name}) = lower(${normName})`))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  // Fuzzy merge: same type, high-cosine embedding match → same entity.
  // HNSW-friendly query shape (ORDER BY distance LIMIT 1, then threshold
  // in JS) so the index is actually used.
  const vec = await generateEmbedding(`${normType}: ${normName}`);
  const vecStr = `[${vec.join(',')}]`;
  const fuzzy = await getDb().execute(sql`
    SELECT id, aliases, 1 - (embedding <=> ${vecStr}::vector) AS similarity
    FROM entity
    WHERE type = ${normType}
    ORDER BY embedding <=> ${vecStr}::vector
    LIMIT 1
  `);

  const fuzzyRow = (fuzzy as unknown as Array<{ id: string; aliases: string[]; similarity: number }>)[0];
  if (fuzzyRow && fuzzyRow.similarity >= 0.9) {
    if (!fuzzyRow.aliases.map(a => a.toLowerCase()).includes(normName.toLowerCase())) {
      await getDb()
        .update(entity)
        .set({ aliases: sql`array_append(${entity.aliases}, ${normName})` })
        .where(eq(entity.id, fuzzyRow.id));
    }
    return fuzzyRow.id;
  }

  // ON CONFLICT DO NOTHING against the UNIQUE(type, lower(name)) index
  // resolves the race: if another worker inserted first, this INSERT
  // becomes a no-op and we re-SELECT the winner's id.
  const id = ulid();
  const inserted = await getDb().execute(sql`
    INSERT INTO entity (id, name, type, embedding)
    VALUES (${id}, ${normName}, ${normType}, ${vecStr}::vector)
    ON CONFLICT (type, lower(name)) DO NOTHING
    RETURNING id
  `);
  const row = (inserted as unknown as Array<{ id: string }>)[0];
  if (row) {
    return row.id;
  }

  const [winner] = await getDb()
    .select({ id: entity.id })
    .from(entity)
    .where(and(eq(entity.type, normType), sql`lower(${entity.name}) = lower(${normName})`))
    .limit(1);
  if (!winner) {
    throw new Error(`upsertEntity race lost but winner not found: (${normType}, ${normName})`);
  }
  return winner.id;
}

/**
 * Store extracted triples as entity + kg_relation rows. Idempotent on
 * the (source, target, relation_type, claim_id) unique index.
 */
export async function storeTriples(claimId: string, triples: ExtractedTriple[], weight = 0.8): Promise<number> {
  if (triples.length === 0) {
    return 0;
  }

  let stored = 0;
  for (const t of triples) {
    try {
      const sourceId = await upsertEntity(t.subject.name, t.subject.type);
      const targetId = await upsertEntity(t.object.name, t.object.type);
      if (sourceId === targetId) {
        continue;
      }

      await getDb()
        .insert(kgRelation)
        .values({
          id: ulid(),
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relationType: normalizePredicate(t.predicate),
          claimId,
          weight,
        })
        .onConflictDoNothing({
          target: [kgRelation.sourceEntityId, kgRelation.targetEntityId, kgRelation.relationType, kgRelation.claimId],
        });
      stored++;
    } catch (err) {
      logger.warn({ claimId, triple: t, error: (err as Error).message }, 'triple store failed');
    }
  }

  if (stored > 0) {
    logger.info({ claimId, triples: stored }, 'KG triples stored');
  }
  return stored;
}
