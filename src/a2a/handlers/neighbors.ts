// neighbors A2A skill — n-hop walk over the entity KG.
//
// Lookup is by entity name (case-insensitive) or by entity ULID.
// Returns the connected entities up to `hops` away, optionally
// filtered by relation_type. Uses a recursive CTE so a single
// round-trip handles arbitrary hop counts within the cap.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../db/connection";

const MAX_HOPS = 4;
const MAX_RESULTS = 200;

const inputSchema = z.object({
  entity: z.string().min(1).max(200),
  relationType: z.string().max(80).optional(),
  hops: z.number().int().min(1).max(MAX_HOPS).default(1),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(50),
});

export interface NeighborEntity {
  id: string;
  name: string;
  type: string;
  distance: number;
  viaRelations: string[];
}

export type NeighborsResult =
  | { ok: true; root: { id: string; name: string; type: string }; neighbors: NeighborEntity[] }
  | { ok: false; error: "invalid_input" | "entity_not_found"; message: string };

export async function handleNeighbors(
  input: Record<string, unknown>,
): Promise<NeighborsResult> {
  let validated: z.infer<typeof inputSchema>;
  try {
    validated = inputSchema.parse(input);
  } catch (err) {
    return { ok: false, error: "invalid_input", message: (err as Error).message };
  }

  // Resolve the root by ULID or by case-insensitive name match. The
  // entity table has a (type, lower(name)) unique index so this is
  // a fast lookup; we just need to handle the "is this a ULID or a
  // human name" branch.
  const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(validated.entity);
  const rootRows = (await db.execute(
    looksLikeUlid
      ? sql`SELECT id, name, type FROM entity WHERE id = ${validated.entity} LIMIT 1`
      : sql`SELECT id, name, type FROM entity WHERE lower(name) = lower(${validated.entity}) LIMIT 1`,
  )) as unknown as Array<{ id: string; name: string; type: string }>;

  if (rootRows.length === 0) {
    return {
      ok: false,
      error: "entity_not_found",
      message: `no entity matches ${validated.entity}`,
    };
  }
  const root = rootRows[0]!;

  // Recursive walk. relation_type filter is optional; when omitted
  // the array_agg captures the path's relation labels so the caller
  // sees HOW the neighbor connects.
  const typeFilter = validated.relationType
    ? sql`AND relation_type = ${validated.relationType}`
    : sql``;

  const rows = (await db.execute(sql`
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
    SELECT DISTINCT ON (e.id)
      e.id, e.name, e.type,
      MIN(w.dist) AS distance,
      array_agg(DISTINCT unnest_label) AS via_relations
    FROM walk w
    JOIN entity e ON e.id = w.eid
    LEFT JOIN LATERAL unnest(w.rels) AS unnest_label ON TRUE
    WHERE w.dist > 0
    GROUP BY e.id, e.name, e.type
    ORDER BY e.id, MIN(w.dist) ASC
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
    neighbors: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      distance: Number(r.distance),
      viaRelations: (r.via_relations ?? []).filter((x): x is string => x !== null),
    })),
  };
}
