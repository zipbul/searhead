// v0.4 라이브 smoke — 외부 LLM 없이 데이터 경로만 검증.
//
// Verifies:
//   1. v0.4 schema applied (new columns + tables present)
//   2. claim_feedback insert → claim.authority EMA delta visible
//   3. claim_relation edge write via relation-writer
//   4. fetchFactBundlesForEntries returns the inserted graph context
//   5. authority-learn EMA on a faked verdict transition
//
// Run with:
//   DATABASE_URL=postgres://knoldr:knoldr@localhost:5436/knoldr_test \
//     bun run scripts/smoke-v04.ts

import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import { handleClaimFeedback } from '../src/a2a/handlers/claim-feedback';
import { recordVerdictTransition } from '../src/claim/authority-learn';
import { fetchFactBundlesForEntries } from '../src/claim/query';
import { writeClaimEdges } from '../src/claim/relation-writer';
import { getDb } from '../src/db/connection';
import { entry, claim, claimRelation, claimFeedback, agentFeedbackAuthority } from '../src/db/schema';
import { ApplicationMethod, ClaimType, EntryStatus, FailureDimension, Outcome, RelationType, Verdict } from '../src/score/enums';

async function setupTwoClaims(): Promise<{
  entryId: string;
  entryCreatedAt: Date;
  claimAId: string;
  claimBId: string;
}> {
  const entryId = `smoke-${ulid()}`;
  const entryCreatedAt = new Date();
  // Embedding vector — fill with 0.01 (cosine-distinct from real data).
  const emb = Array.from({ length: 384 }, () => 0.01);

  await getDb().transaction(async tx => {
    await tx.insert(entry).values({
      id: entryId,
      title: 'smoke',
      content: 'smoke entry',
      language: 'en',
      authority: 0.5,
      status: EntryStatus.Active,
      createdAt: entryCreatedAt,
      embedding: emb,
    });
    await tx.insert(claim).values([
      {
        id: ulid(),
        entryId,
        entryCreatedAt,
        statement: 'Bun runs on V8',
        type: ClaimType.Factual,
        verdict: Verdict.Verified,
        certainty: 0.8,
        authority: 0.8,
        embedding: emb,
      },
      {
        id: ulid(),
        entryId,
        entryCreatedAt,
        statement: 'Bun runs on JavaScriptCore',
        type: ClaimType.Factual,
        verdict: Verdict.Verified,
        certainty: 0.7,
        authority: 0.7,
        embedding: emb,
      },
    ]);
  });

  const rows = await getDb()
    .select({ id: claim.id, statement: claim.statement })
    .from(claim)
    .where(eq(claim.entryId, entryId))
    .orderBy(claim.createdAt);

  return {
    entryId,
    entryCreatedAt,
    claimAId: rows[0]!.id,
    claimBId: rows[1]!.id,
  };
}

async function main(): Promise<void> {
  console.log('\n=== v0.4 LIVE SMOKE ===');

  // 1. Schema columns exist?
  const cols = await getDb().execute<{ column_name: string }>(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'claim'
      AND column_name IN ('authority','source_span','modality','polarity','quantifier','valid_from','valid_until')
    ORDER BY column_name
  `);
  const colNames = (cols as unknown as Array<{ column_name: string }>).map(r => r.column_name).sort();
  console.log('[1] claim verifiability columns:', colNames.join(','));
  if (colNames.length !== 7) {
    throw new Error('missing verifiability columns');
  }

  // 2. Seed two claims
  const { entryId, entryCreatedAt, claimAId, claimBId } = await setupTwoClaims();
  console.log(`[2] seeded claims  A=${claimAId}  B=${claimBId}`);

  // 3. Write a CONTRADICTS edge A→B
  const edgesWritten = await writeClaimEdges(claimAId, [claimBId], RelationType.Contradicts, {
    weight: 0.9,
    createdBy: 'auto',
    metadata: { source: 'smoke' },
  });
  console.log(`[3] writeClaimEdges(contradicts): edges_inserted=${edgesWritten}`);
  if (edgesWritten !== 1) {
    throw new Error('edge not inserted');
  }

  // Idempotency — re-write should hit ON CONFLICT DO NOTHING
  const edgesAgain = await writeClaimEdges(claimAId, [claimBId], RelationType.Contradicts);
  console.log(`[3a] re-write idempotency: edges_inserted=${edgesAgain} (expect 0)`);
  if (edgesAgain !== 0) {
    throw new Error('duplicate edge inserted');
  }

  // 4. Fact bundle for the entry — both outgoing (A→B) and incoming (B receives) should surface
  const bundles = await fetchFactBundlesForEntries([{ id: entryId, createdAt: entryCreatedAt.toISOString() }], {
    maxPerEntry: 5,
  });
  console.log(`[4] factBundles returned: ${bundles.length}`);
  const bundleA = bundles.find(b => b.id === claimAId);
  const bundleB = bundles.find(b => b.id === claimBId);
  console.log(`    A.contradicts: ${bundleA?.contradicts.length ?? 0}  B.contradicts: ${bundleB?.contradicts.length ?? 0}`);
  if ((bundleA?.contradicts.length ?? 0) !== 1) {
    throw new Error('A should surface outgoing CONTRADICTS to B');
  }
  if ((bundleB?.contradicts.length ?? 0) !== 1) {
    throw new Error('B should surface incoming CONTRADICTS from A');
  }

  // 5. claim_feedback insert → claim.authority moves
  const beforeAuth = (await getDb().select({ a: claim.authority }).from(claim).where(eq(claim.id, claimAId)).limit(1))[0]!.a;
  const fbResult = await handleClaimFeedback({
    claimId: claimAId,
    reporterAgentId: 'smoke-agent',
    applicationMethod: ApplicationMethod.Applied,
    outcome: Outcome.Failed,
    failureDimension: FailureDimension.FullyFalse,
    counterSourceUrl: 'https://example.com/x',
    counterNliScore: 0.9,
  });
  console.log('[5] claim_feedback result:', JSON.stringify(fbResult));
  if (!('ok' in fbResult) || !fbResult.ok) {
    throw new Error('feedback failed');
  }
  const afterAuth = (await getDb().select({ a: claim.authority }).from(claim).where(eq(claim.id, claimAId)).limit(1))[0]!.a;
  console.log(
    `    claim.authority: ${beforeAuth.toFixed(4)} → ${afterAuth.toFixed(4)}  (Δ=${(afterAuth - beforeAuth).toFixed(4)})`,
  );
  if (afterAuth >= beforeAuth) {
    throw new Error('authority should drop on failed feedback');
  }

  // 6. Feedback update mode (same feedbackId, different counter)
  const fbUpdate = await handleClaimFeedback({
    feedbackId: fbResult.feedbackId,
    claimId: claimAId,
    reporterAgentId: 'smoke-agent',
    applicationMethod: ApplicationMethod.Applied,
    outcome: Outcome.Failed,
    partialTruth: 0.2,
  });
  console.log('[6] update mode result:', JSON.stringify(fbUpdate));
  if (!('ok' in fbUpdate) || !fbUpdate.ok || !fbUpdate.updated) {
    throw new Error('update mode failed');
  }

  // 7. authority-learn EMA on a verdict transition
  const learnResult = await recordVerdictTransition(claimAId, Verdict.Verified, Verdict.Disputed);
  console.log('[7] authority-learn:', JSON.stringify(learnResult));
  const repRow = await getDb()
    .select({
      fa: agentFeedbackAuthority.feedbackAuthority,
      total: agentFeedbackAuthority.totalFeedbacks,
      correct: agentFeedbackAuthority.correctFeedbacks,
    })
    .from(agentFeedbackAuthority)
    .where(eq(agentFeedbackAuthority.agentId, 'smoke-agent'))
    .limit(1);
  console.log('    reporter authority row:', JSON.stringify(repRow[0]));
  if (!repRow[0] || repRow[0].correct !== 1) {
    throw new Error('verdict transition should have credited reporter');
  }

  // 8. Reject feedbackId/claimId mismatch
  const mismatchResult = await handleClaimFeedback({
    feedbackId: fbResult.feedbackId,
    claimId: claimBId, // wrong claim
    reporterAgentId: 'smoke-agent',
    applicationMethod: ApplicationMethod.Applied,
    outcome: Outcome.Failed,
  });
  console.log('[8] feedbackId/claimId mismatch:', JSON.stringify(mismatchResult));
  if ('ok' in mismatchResult && mismatchResult.ok) {
    throw new Error('mismatch should have been rejected');
  }

  // Cleanup
  await getDb().delete(claimRelation).where(eq(claimRelation.sourceClaimId, claimAId));
  await getDb().delete(claimFeedback).where(eq(claimFeedback.claimId, claimAId));
  await getDb().delete(entry).where(eq(entry.id, entryId));
  await getDb().delete(agentFeedbackAuthority).where(eq(agentFeedbackAuthority.agentId, 'smoke-agent'));
  console.log('=== SMOKE OK ===');
  process.exit(0);
}

try {
  await main();
} catch (err) {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
}
