// neighbors A2A skill — n-hop walk over the entity KG.
//
// Lookup is by entity name (case-insensitive) or by entity ULID.
// Returns the connected entities up to `hops` away, optionally
// filtered by relation_type. Uses a recursive CTE so a single
// round-trip handles arbitrary hop counts within the cap.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../../db/connection';

const MAX_HOPS = 4;
const MAX_RESULTS = 200;

const inputSchema = z.object({
  entity: z.string().min(1).max(200),
  // When entity is a human name and multiple entities share that
  // name across types (the unique key is (type, lower(name))),
  // pass entityType to disambiguate. Without it the caller gets
  // an `ambiguous_entity` error instead of a silent type pick.
  entityType: z.string().max(50).optional(),
  relationType: z.string().max(80).optional(),
  hops: z.number().int().min(1).max(MAX_HOPS).default(1),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(50),
});

interface NeighborEntity {
  id: string;
  name: string;
  type: string;
  distance: number;
  viaRelations: string[];
}

type NeighborsResult =
  | { ok: true; root: { id: string; name: string; type: string }; neighbors: NeighborEntity[] }
  | {
      ok: false;
      error: 'invalid_input' | 'entity_not_found' | 'ambiguous_entity';
      message: string;
      candidates?: Array<{ id: string; name: string; type: string }>;
    };

export async function handleNeighbors(input: Record<string, unknown>): Promise<NeighborsResult> {
  let validated: z.infer<typeof inputSchema>;
  try {
    validated = inputSchema.parse(input);
  } catch (err) {
    return { ok: false, error: 'invalid_input', message: (err as Error).message };
  }

  // Resolve the root by ULID or by case-insensitive name match. The
  // entity unique key is (type, lower(name)) — same name across
  // different types is legal. We fetch all matches and:
  //   - 0 hits   → entity_not_found
  //   - 1 hit    → proceed
  //   - 2+ hits  → ambiguous_entity, caller must re-issue with
  //                entityType to disambiguate
  const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(validated.entity);
  const matchRows = looksLikeUlid
    ? ((await getDb().execute(sql`SELECT id, name, type FROM entity WHERE id = ${validated.entity}`)) as unknown as Array<{
        id: string;
        name: string;
        type: string;
      }>)
    : validated.entityType
      ? ((await getDb().execute(
          sql`SELECT id, name, type FROM entity
              WHERE lower(name) = lower(${validated.entity})
                AND type = ${validated.entityType}`,
        )) as unknown as Array<{ id: string; name: string; type: string }>)
      : ((await getDb().execute(
          sql`SELECT id, name, type FROM entity
              WHERE lower(name) = lower(${validated.entity})
              LIMIT 5`,
        )) as unknown as Array<{ id: string; name: string; type: string }>);

  if (matchRows.length === 0) {
    return {
      ok: false,
      error: 'entity_not_found',
      message: `no entity matches ${validated.entity}`,
    };
  }
  if (matchRows.length > 1) {
    return {
      ok: false,
      error: 'ambiguous_entity',
      message: `${matchRows.length} entities share name '${validated.entity}'; re-issue with entityType`,
      candidates: matchRows,
    };
  }
  const root = matchRows[0]!;

  // Recursive walk. relation_type filter is optional; when omitted
  // the array_agg captures the path's relation labels so the caller
  // sees HOW the neighbor connects.
  const typeFilter = validated.relationType ? sql`AND relation_type = ${validated.relationType}` : sql``;

  const rows = (await getDb().execute(sql`
    WITH RECURSIVE walk(eid, dist, rels) AS (
      SELECT ${root.id}::text AS eid, 0 AS dist, ARRAY[]::text[] AS rels
      UNION ALL
      SELECT
        CASE WHEN r.source_entity_id = w.eid THEN r.target_entity_id ELSE r.source_entity_id END,
        w.dist + 1,
        w.rels || r.relation_type
      FROM walk w
      JOIN kg_relation r
        ON (r.source_entity_id = w.eid OR r.target_entity_id = w.eid)
       ${typeFilter}
      WHERE w.dist < ${validated.hops}
    )
    -- GROUP BY already dedupes by entity; DISTINCT ON was forcing
    -- ORDER BY to lead with e.id which made LIMIT pick neighbors
    -- alphabetically by id rather than by shortest distance — the
    -- opposite of what the caller wants.
    SELECT
      e.id, e.name, e.type,
      MIN(w.dist) AS distance,
      array_agg(DISTINCT unnest_label) AS via_relations
    FROM walk w
    JOIN entity e ON e.id = w.eid
    LEFT JOIN LATERAL unnest(w.rels) AS unnest_label ON TRUE
    WHERE w.dist > 0
    GROUP BY e.id, e.name, e.type
    ORDER BY MIN(w.dist) ASC, e.id
    LIMIT ${validated.limit}
  `)) as unknown as Array<{
    id: string;
    name: string;
    type: string;
    distance: number;
    via_relations: (string | null)[];
  }>;

  return {
    ok: true,
    root,
    neighbors: rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      distance: Number(r.distance),
      viaRelations: (r.via_relations ?? []).filter((x): x is string => x !== null),
    })),
  };
}
