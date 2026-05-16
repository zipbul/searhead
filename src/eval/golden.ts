// Golden-set regression evaluator.
//
// Pulls every active row from golden_set_claim, runs it through the
// real verify pipeline by creating a temporary draft entry + claim,
// invoking verifyClaim, then deleting the entry (CASCADE removes the
// claim and any verdict_log rows). Macro-averaged precision / recall /
// F1 across the four verdict classes is the headline metric; raw
// confusion counts and per-claim-type breakdown live in the
// golden_set_run.metrics JSONB for later analysis.
//
// Without labels in golden_set_claim this function is a no-op — it
// returns null and inserts nothing, so wiring this into CI from day
// one is safe.

import { and, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import { authorityFor } from '../claim/authority';
import { verifyClaim } from '../claim/verify';
import { getDb } from '../db/connection';
import { entry, entrySource, claim, goldenSetClaim, goldenSetRun } from '../db/schema';
import { generateEmbedding } from '../ingest/embed';
import { logger } from '../observability/logger';
import { enumValues, SourceType, Verdict } from '../score/enums';

const VERDICTS: readonly Verdict[] = enumValues(Verdict);

interface PerVerdictMetric {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

interface EvalResult {
  runId: string;
  total: number;
  correct: number;
  precisionOverall: number;
  recallOverall: number;
  f1Overall: number;
  byVerdict: Record<Verdict, PerVerdictMetric>;
  byType: Record<string, PerVerdictMetric>;
  baselineRunId: string | null;
  regressed: boolean | null;
}

interface ItemResult {
  goldenId: string;
  statement: string;
  claimType: string;
  expected: Verdict;
  predicted: Verdict;
  correct: boolean;
  certainty: number;
  error?: string;
}

function emptyMetric(): PerVerdictMetric {
  return { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0, support: 0 };
}

function finalizeMetric(m: PerVerdictMetric): PerVerdictMetric {
  const precision = m.tp + m.fp === 0 ? 0 : m.tp / (m.tp + m.fp);
  const recall = m.tp + m.fn === 0 ? 0 : m.tp / (m.tp + m.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...m, precision, recall, f1 };
}

async function evaluateOne(
  item: {
    id: string;
    statement: string;
    claimType: string;
    expectedVerdict: string;
    sourceUrls: string[] | null;
  },
  runId: string,
): Promise<ItemResult> {
  const expected = item.expectedVerdict as Verdict;
  const tempEntryId = `eval-${runId}-${item.id}`;
  const tempCreatedAt = new Date();

  try {
    const embedding = await generateEmbedding(item.statement);
    const claimId = ulid();
    const initialVerdict: Verdict = item.claimType === 'factual' ? Verdict.Unverified : Verdict.NotApplicable;

    await getDb().transaction(async tx => {
      await tx.insert(entry).values({
        id: tempEntryId,
        title: `eval-${runId}`.slice(0, 500),
        content: item.statement.slice(0, 50000),
        language: 'en',
        metadata: { eval: true, runId, goldenId: item.id },
        authority: 0,
        // status='draft' keeps the eval entry invisible to active-only
        // search/extract queries. Verify's dbCrossRef ignores it via
        // the entry_id <> match exclusion, so cross-contamination
        // between concurrent eval items is also blocked.
        status: 'draft',
        createdAt: tempCreatedAt,
        embedding,
      });
      await tx.insert(claim).values({
        id: claimId,
        entryId: tempEntryId,
        entryCreatedAt: tempCreatedAt,
        statement: item.statement,
        type: item.claimType,
        verdict: initialVerdict,
        certainty: 0,
        embedding,
      });
      // Source URLs from the golden row → entry_source rows so the
      // verifier's source_check branch can actually fire. Without
      // this the harness only exercises KG / CoVe / jury paths,
      // missing the production-dominant source-grounded NLI signal.
      if (item.sourceUrls && item.sourceUrls.length > 0) {
        await tx.insert(entrySource).values(
          item.sourceUrls.map(url => ({
            entryId: tempEntryId,
            entryCreatedAt: tempCreatedAt,
            url,
            sourceType: SourceType.Unknown,
            trust: authorityFor(url),
          })),
        );
      }
    });

    let predicted: Verdict;
    let certainty = 0;

    if (item.claimType === 'factual') {
      const result = await verifyClaim(claimId);
      if (!result) {
        predicted = Verdict.Unverified;
      } else {
        predicted = result.verdict as Verdict;
        certainty = result.certainty;
      }
    } else {
      // Production never verifies non-factual claims — they ship as
      // not_applicable. Mirror that here so the metric reflects real
      // pipeline behavior, not a hypothetical verifier.
      predicted = Verdict.NotApplicable;
    }

    return {
      goldenId: item.id,
      statement: item.statement,
      claimType: item.claimType,
      expected,
      predicted,
      correct: predicted === expected,
      certainty,
    };
  } catch (err) {
    return {
      goldenId: item.id,
      statement: item.statement,
      claimType: item.claimType,
      expected,
      predicted: Verdict.Unverified,
      correct: false,
      certainty: 0,
      error: (err as Error).message,
    };
  } finally {
    try {
      await getDb()
        .delete(entry)
        .where(and(eq(entry.id, tempEntryId), eq(entry.createdAt, tempCreatedAt)));
    } catch (cleanupErr) {
      logger.warn({ tempEntryId, err: (cleanupErr as Error).message }, 'golden eval cleanup failed — temp entry may persist');
    }
  }
}

interface GoldenEvalOptions {
  commitSha?: string;
  modelVersions?: Record<string, string>;
}

// Same lock key that finetune/run.py acquires *exclusively* before
// LoRA training (FT_LOCK_KEY = 0x6B6E6F6C64720001). The eval harness
// holds a SHARED lock so multiple eval runs can stack but a finetune
// cycle can't start mid-eval — they'd otherwise contend for GPU /
// Ollama. Compute the decimal from the hex literal so a typo in
// either side can't silently desync the two locks (the previous
// hand-converted decimal was wrong and rendered this coordination
// inert).
const FT_LOCK_KEY = BigInt('0x6B6E6F6C64720001').toString();

async function withFinetuneShield<T>(fn: () => Promise<T>): Promise<T> {
  const { getPgClient } = await import('../db/connection');
  const client = getPgClient();
  const reserved = await client.reserve();
  try {
    // Try to acquire a SHARED advisory lock — non-blocking. If the
    // finetune cycle currently holds the EXCLUSIVE lock, we yield
    // the lock attempt and surface the conflict to the caller.
    const rows = await reserved<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_lock_shared(${FT_LOCK_KEY}::bigint) AS ok
    `;
    if (!rows[0]?.ok) {
      throw new Error('finetune cycle in progress — eval skipped to avoid GPU/Ollama contention');
    }
    try {
      return await fn();
    } finally {
      try {
        await reserved`SELECT pg_advisory_unlock_shared(${FT_LOCK_KEY}::bigint)`;
      } catch {
        /* best-effort release */
      }
    }
  } finally {
    reserved.release();
  }
}

async function runGoldenEval(opts: GoldenEvalOptions = {}): Promise<EvalResult | null> {
  return await withFinetuneShield(() => runGoldenEvalInner(opts));
}

async function runGoldenEvalInner(opts: GoldenEvalOptions = {}): Promise<EvalResult | null> {
  const runId = ulid();
  const rawItems = await getDb()
    .select({
      id: goldenSetClaim.id,
      statement: goldenSetClaim.statement,
      claimType: goldenSetClaim.claimType,
      expectedVerdict: goldenSetClaim.expectedVerdict,
      sourceUrls: goldenSetClaim.sourceUrls,
    })
    .from(goldenSetClaim)
    .where(eq(goldenSetClaim.active, 1));

  const items = rawItems.map(r => ({
    id: r.id,
    statement: r.statement,
    claimType: r.claimType,
    expectedVerdict: r.expectedVerdict,
    sourceUrls: Array.isArray(r.sourceUrls)
      ? (r.sourceUrls as unknown[]).filter((u): u is string => typeof u === 'string')
      : null,
  }));

  if (items.length === 0) {
    logger.info({ runId }, 'golden set empty — no evaluation performed');
    return null;
  }

  logger.info({ runId, total: items.length }, 'golden eval starting');

  const results: ItemResult[] = [];
  for (const item of items) {
    const r = await evaluateOne(item, runId);
    results.push(r);
    if (r.error) {
      logger.warn({ goldenId: r.goldenId, error: r.error }, 'golden eval item errored — counted as incorrect');
    }
  }

  const byVerdict: Record<Verdict, PerVerdictMetric> = {
    verified: emptyMetric(),
    disputed: emptyMetric(),
    unverified: emptyMetric(),
    'not-applicable': emptyMetric(),
  };
  const byType: Record<string, PerVerdictMetric> = {};

  for (const r of results) {
    byVerdict[r.expected].support++;
    if (r.predicted === r.expected) {
      byVerdict[r.expected].tp++;
    } else {
      byVerdict[r.expected].fn++;
      byVerdict[r.predicted].fp++;
    }

    const tk = r.claimType;
    if (!byType[tk]) {
      byType[tk] = emptyMetric();
    }
    byType[tk].support++;
    if (r.correct) {
      byType[tk].tp++;
    } else {
      byType[tk].fp++;
    }
  }

  for (const v of VERDICTS) {
    byVerdict[v] = finalizeMetric(byVerdict[v]);
  }
  for (const k of Object.keys(byType)) {
    byType[k] = finalizeMetric(byType[k]!);
  }

  const correct = results.filter(r => r.correct).length;
  const total = results.length;

  // Macro-averaged across verdict classes that have any support.
  // Macro (not micro) so a minority class can't be drowned out by the
  // common one — a verifier that calls everything 'unverified' should
  // score badly here even if 70% of the golden set happens to be
  // unverified.
  const supported = VERDICTS.filter(v => byVerdict[v].support > 0);
  const macroPrecision =
    supported.length === 0 ? 0 : supported.reduce((s, v) => s + byVerdict[v].precision, 0) / supported.length;
  const macroRecall = supported.length === 0 ? 0 : supported.reduce((s, v) => s + byVerdict[v].recall, 0) / supported.length;
  const macroF1 = supported.length === 0 ? 0 : supported.reduce((s, v) => s + byVerdict[v].f1, 0) / supported.length;

  // Baseline lookup: pull the most recent run *from Knoldr's own
  // eval harness only*. finetune/run.py writes accuracy-only rows
  // into the same table with metric_semantics='accuracy_only';
  // those numbers (single-task verdict accuracy) are not comparable
  // to this harness's macro-F1 across the full verify pipeline.
  // Filtering them out prevents finetune accuracy bleeding into the
  // pipeline regression check.
  const [prior] = await getDb()
    .select({ id: goldenSetRun.id, f1: goldenSetRun.f1Overall })
    .from(goldenSetRun)
    .where(sql`COALESCE(${goldenSetRun.metrics}->>'metric_semantics', '') <> 'accuracy_only'`)
    .orderBy(desc(goldenSetRun.ranAt))
    .limit(1);

  const regressed = prior ? macroF1 < prior.f1 : null;

  await getDb()
    .insert(goldenSetRun)
    .values({
      id: runId,
      commitSha: opts.commitSha ?? null,
      modelVersions: opts.modelVersions ?? { embedding: 'all-MiniLM-L6-v2' },
      total,
      correct,
      precisionOverall: macroPrecision,
      recallOverall: macroRecall,
      f1Overall: macroF1,
      metrics: {
        byVerdict,
        byType,
        // Store every result so post-hoc analysis can drill into
        // specific misclassifications without re-running.
        results: results.map(r => ({
          goldenId: r.goldenId,
          statement: r.statement,
          claimType: r.claimType,
          expected: r.expected,
          predicted: r.predicted,
          correct: r.correct,
          certainty: r.certainty,
          error: r.error ?? null,
        })),
      },
      baselineRunId: prior?.id ?? null,
      regressed: regressed === null ? null : regressed ? 1 : 0,
    });

  logger.info(
    {
      runId,
      total,
      correct,
      precision: macroPrecision,
      recall: macroRecall,
      f1: macroF1,
      regressed,
      baselineRunId: prior?.id ?? null,
    },
    'golden eval complete',
  );

  return {
    runId,
    total,
    correct,
    precisionOverall: macroPrecision,
    recallOverall: macroRecall,
    f1Overall: macroF1,
    byVerdict,
    byType,
    baselineRunId: prior?.id ?? null,
    regressed,
  };
}

export { runGoldenEval };
