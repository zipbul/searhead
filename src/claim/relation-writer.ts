// claim_relation edge writer.
//
// Centralizes every place CONTRADICTS / SUPPORTS / DERIVES_FROM /
// SUPERSEDED_BY / REFINES edges land. Callers pass:
//   - sourceClaimId: the just-decided claim
//   - targetClaimIds: the existing claims being linked
//   - relationType, weight, createdBy ('auto' or agent_id), metadata
//
// All writes are idempotent — the (source, target, relation_type)
// unique index lets us issue ON CONFLICT DO NOTHING. Self-loops are
// dropped silently so callers don't have to filter their own claim id
// out of a candidate list.

import { ulid } from 'ulid';

import { getDb } from '../db/connection';
import { claimRelation } from '../db/schema';
import { logger } from '../observability/logger';

type ClaimRelationType = 'supports' | 'contradicts' | 'derives-from' | 'superseded-by' | 'refines';

interface WriteEdgesOptions {
  weight?: number; // default 1.0
  createdBy?: string; // default 'auto'
  metadata?: Record<string, unknown>;
}

export async function writeClaimEdges(
  sourceClaimId: string,
  targetClaimIds: string[],
  relationType: ClaimRelationType,
  opts: WriteEdgesOptions = {},
): Promise<number> {
  if (targetClaimIds.length === 0) {
    return 0;
  }
  const distinct = Array.from(new Set(targetClaimIds)).filter(id => id && id !== sourceClaimId);
  if (distinct.length === 0) {
    return 0;
  }

  const weight = opts.weight ?? 1.0;
  const createdBy = opts.createdBy ?? 'auto';
  const metadata = opts.metadata ?? null;

  const values = distinct.map(targetId => ({
    id: ulid(),
    sourceClaimId,
    targetClaimId: targetId,
    relationType,
    weight,
    createdBy,
    metadata,
  }));

  try {
    const inserted = await getDb()
      .insert(claimRelation)
      .values(values)
      .onConflictDoNothing({
        target: [claimRelation.sourceClaimId, claimRelation.targetClaimId, claimRelation.relationType],
      })
      .returning({ id: claimRelation.id });

    if (inserted.length > 0) {
      logger.info(
        {
          sourceClaimId,
          relationType,
          attempted: distinct.length,
          inserted: inserted.length,
          createdBy,
        },
        'claim_relation edges written',
      );
    }
    return inserted.length;
  } catch (err) {
    // FK violation = one of the target claim ids didn't exist; happens
    // when KG carries claims that were deleted in between. Log and
    // swallow so the verify pipeline isn't blocked by stale references.
    logger.warn(
      {
        sourceClaimId,
        relationType,
        targets: distinct.length,
        error: (err as Error).message,
      },
      'claim_relation edge write failed (likely FK violation)',
    );
    return 0;
  }
}
