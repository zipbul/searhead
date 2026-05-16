// provenance A2A skill — walk DERIVES_FROM edges back to the roots.
//
// Given a claim ID, returns every ancestor reachable via the
// `derives_from` claim_relation edges, plus each ancestor's
// surface metadata (statement, verdict, certainty, source URL).
// The walk caps at MAX_DEPTH hops to bound runtime.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../../db/connection';

const MAX_DEPTH = 8;
const MAX_RESULTS = 100;

const inputSchema = z.object({
  claimId: z.string().min(1).max(200),
  maxDepth: z.number().int().min(1).max(MAX_DEPTH).default(4),
});

interface ProvenanceNode {
  claimId: string;
  statement: string;
  verdict: string;
  certainty: number;
  sourceUrl: string | null;
  depth: number;
}

type ProvenanceResult =
  | {
      ok: true;
      rootClaimId: string;
      ancestors: ProvenanceNode[];
    }
  | { ok: false; error: 'invalid_input' | 'claim_not_found'; message: string };

export async function handleProvenance(input: Record<string, unknown>): Promise<ProvenanceResult> {
  let validated: z.infer<typeof inputSchema>;
  try {
    validated = inputSchema.parse(input);
  } catch (err) {
    return { ok: false, error: 'invalid_input', message: (err as Error).message };
  }

  const rootCheck = (await getDb().execute(
    sql`SELECT id FROM claim WHERE id = ${validated.claimId} LIMIT 1`,
  )) as unknown as Array<{
    id: string;
  }>;
  if (rootCheck.length === 0) {
    return {
      ok: false,
      error: 'claim_not_found',
      message: `claim ${validated.claimId} does not exist`,
    };
  }

  // Recursive CTE: follow derives_from edges. Each step expands the
  // frontier; depth is bounded by maxDepth. We surface the minimum
  // depth at which each ancestor first appears.
  const rows = (await getDb().execute(sql`
    WITH RECURSIVE walk(cid, depth) AS (
      SELECT ${validated.claimId}::text AS cid, 0 AS depth
      UNION ALL
      SELECT cr.target_claim_id, w.depth + 1
      FROM walk w
      JOIN claim_relation cr ON cr.source_claim_id = w.cid AND cr.relation_type = 'derives-from'
      WHERE w.depth < ${validated.maxDepth}
    )
    SELECT
      c.id AS claim_id,
      c.statement,
      c.verdict,
      c.certainty,
      c.source_url,
      MIN(w.depth) AS depth
    FROM walk w
    JOIN claim c ON c.id = w.cid
    WHERE w.depth > 0
    GROUP BY c.id, c.statement, c.verdict, c.certainty, c.source_url
    ORDER BY MIN(w.depth) ASC, c.certainty DESC
    LIMIT ${MAX_RESULTS}
  `)) as unknown as Array<{
    claim_id: string;
    statement: string;
    verdict: string;
    certainty: number;
    source_url: string | null;
    depth: number;
  }>;

  return {
    ok: true,
    rootClaimId: validated.claimId,
    ancestors: rows.map(r => ({
      claimId: r.claim_id,
      statement: r.statement,
      verdict: r.verdict,
      certainty: r.certainty,
      sourceUrl: r.source_url,
      depth: Number(r.depth),
    })),
  };
}
