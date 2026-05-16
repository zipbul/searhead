import { ulid } from 'ulid';

import type { ExtractedClaim } from './extract';

import { getDb } from '../db/connection';
import { claim, verifyQueue } from '../db/schema';
import { generateEmbedding } from '../ingest/embed';
import { logger } from '../observability/logger';
import { ClaimType, Verdict } from '../score/enums';

interface StoredClaim {
  id: string;
  type: string;
  verdict: string;
}

/**
 * Persist extracted claims for an entry. Factual claims are immediately
 * enqueued for Pyreez verification; subjective/predictive/normative go in
 * with verdict=not_applicable and never leave that state.
 */
export async function storeClaims(
  entryId: string,
  entryCreatedAt: Date,
  extracted: ExtractedClaim[],
  priority = 0,
): Promise<StoredClaim[]> {
  if (extracted.length === 0) {
    return [];
  }

  const stored: StoredClaim[] = [];

  for (const c of extracted) {
    const id = ulid();
    const embedding = await generateEmbedding(c.statement);
    const verdict = c.type === ClaimType.Factual ? Verdict.Unverified : Verdict.NotApplicable;

    await getDb().transaction(async tx => {
      await tx.insert(claim).values({
        id,
        entryId,
        entryCreatedAt,
        statement: c.statement,
        type: c.type,
        verdict,
        certainty: 0,
        // Authority starts equal to certainty; the verify pipeline
        // raises certainty on commit (via processVerifyQueueInner's
        // UPDATE) and that path also bumps authority. From there
        // claim_feedback moves authority but not certainty.
        authority: 0,
        embedding,
        // Verifiability fields — populated whenever the extractor
        // supplied them. NULL preserved for legacy callers that
        // bypass the gated extract path.
        sourceSpan: c.quote ?? null,
        modality: c.modality ?? null,
        polarity: c.polarity === undefined ? null : c.polarity ? 1 : 0,
        quantifier: c.quantifier ?? null,
        validFrom: c.validFrom ? new Date(c.validFrom) : null,
        validUntil: c.validUntil ? new Date(c.validUntil) : null,
      });

      if (c.type === ClaimType.Factual) {
        await tx.insert(verifyQueue).values({
          claimId: id,
          priority,
        });
      }
    });

    stored.push({ id, type: c.type, verdict });
  }

  logger.info(
    {
      entryId,
      total: stored.length,
      factual: stored.filter(s => s.type === ClaimType.Factual).length,
    },
    'claims stored',
  );

  return stored;
}
