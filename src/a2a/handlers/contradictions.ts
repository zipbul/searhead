// contradictions A2A skill — surface CONTRADICTS edges.
//
// Two query modes:
//   - { claimId } : claims directly contradicting this one (1-hop)
//   - { entity }  : every CONTRADICTS pair where either endpoint is
//                   a claim about the entity. Useful when the agent
//                   wants to know "is there active dispute around
//                   topic X" without knowing a specific claim id.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../../db/connection';

const MAX_RESULTS = 50;

const inputSchema = z
  .object({
    claimId: z.string().min(1).max(200).optional(),
    entity: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
  })
  .refine(v => v.claimId || v.entity, {
    message: 'either claimId or entity must be provided',
  });

interface ContradictionPair {
  fromClaimId: string;
  fromStatement: string;
  fromVerdict: string;
  fromCertainty: number;
  toClaimId: string;
  toStatement: string;
  toVerdict: string;
  toCertainty: number;
  weight: number;
}

type ContradictionsResult = { ok: true; pairs: ContradictionPair[] } | { ok: false; error: 'invalid_input'; message: string };

export async function handleContradictions(input: Record<string, unknown>): Promise<ContradictionsResult> {
  let validated: z.infer<typeof inputSchema>;
  try {
    validated = inputSchema.parse(input);
  } catch (err) {
    return { ok: false, error: 'invalid_input', message: (err as Error).message };
  }

  const limit = validated.limit;

  let rows: Array<{
    src_id: string;
    src_statement: string;
    src_verdict: string;
    src_certainty: number;
    tgt_id: string;
    tgt_statement: string;
    tgt_verdict: string;
    tgt_certainty: number;
    weight: number;
  }>;

  if (validated.claimId) {
    rows = (await getDb().execute(sql`
      SELECT
        c1.id AS src_id, c1.statement AS src_statement, c1.verdict AS src_verdict, c1.certainty AS src_certainty,
        c2.id AS tgt_id, c2.statement AS tgt_statement, c2.verdict AS tgt_verdict, c2.certainty AS tgt_certainty,
        cr.weight
      FROM claim_relation cr
      JOIN claim c1 ON c1.id = cr.source_claim_id
      JOIN claim c2 ON c2.id = cr.target_claim_id
      WHERE cr.relation_type = 'contradicts'
        AND (cr.source_claim_id = ${validated.claimId} OR cr.target_claim_id = ${validated.claimId})
      ORDER BY cr.weight DESC, cr.created_at DESC
      LIMIT ${limit}
    `)) as unknown as typeof rows;
  } else {
    // Entity mode: surface CONTRADICTS pairs where *at least one*
    // endpoint cites this entity. The earlier "both endpoints" gate
    // missed real disputes where a new claim about an entity is
    // contradicted by a claim that didn't yet have the same entity
    // attached — both directions of asymmetric mention should
    // count as "this entity is involved in a dispute".
    rows = (await getDb().execute(sql`
      WITH entity_claims AS (
        SELECT DISTINCT kr.claim_id
        FROM kg_relation kr
        JOIN entity e
          ON (kr.source_entity_id = e.id OR kr.target_entity_id = e.id)
        WHERE kr.claim_id IS NOT NULL
          AND lower(e.name) = lower(${validated.entity})
      )
      SELECT
        c1.id AS src_id, c1.statement AS src_statement, c1.verdict AS src_verdict, c1.certainty AS src_certainty,
        c2.id AS tgt_id, c2.statement AS tgt_statement, c2.verdict AS tgt_verdict, c2.certainty AS tgt_certainty,
        cr.weight
      FROM claim_relation cr
      JOIN claim c1 ON c1.id = cr.source_claim_id
      JOIN claim c2 ON c2.id = cr.target_claim_id
      WHERE cr.relation_type = 'contradicts'
        AND (
          cr.source_claim_id IN (SELECT claim_id FROM entity_claims)
          OR cr.target_claim_id IN (SELECT claim_id FROM entity_claims)
        )
      ORDER BY cr.weight DESC, cr.created_at DESC
      LIMIT ${limit}
    `)) as unknown as typeof rows;
  }

  return {
    ok: true,
    pairs: rows.map(r => ({
      fromClaimId: r.src_id,
      fromStatement: r.src_statement,
      fromVerdict: r.src_verdict,
      fromCertainty: r.src_certainty,
      toClaimId: r.tgt_id,
      toStatement: r.tgt_statement,
      toVerdict: r.tgt_verdict,
      toCertainty: r.tgt_certainty,
      weight: r.weight,
    })),
  };
}
