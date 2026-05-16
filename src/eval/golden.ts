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

import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/connection";
import {
  entry,
  entrySource,
  claim,
  goldenSetClaim,
  goldenSetRun,
} from "../db/schema";
import { generateEmbedding } from "../ingest/embed";
import { verifyClaim } from "../claim/verify";
import { authorityFor } from "../claim/authority";
import { logger } from "../observability/logger";

type Verdict = "verified" | "disputed" | "unverified" | "not_applicable";

const VERDICTS: readonly Verdict[] = [
  "verified",
  "disputed",
  "unverified",
  "not_applicable",
] as const;

interface PerVerdictMetric {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface EvalResult {
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

async function evaluateOne(item: {
  id: string;
  statement: string;
  claimType: string;
  expectedVerdict: string;
  sourceUrls: string[] | null;
}, runId: string): Promise<ItemResult> {
  const expected = item.expectedVerdict as Verdict;
  const tempEntryId = `eval-${runId}-${item.id}`;
  const tempCreatedAt = new Date();

  try {
    const embedding = await generateEmbedding(item.statement);
    const claimId = ulid();
    const initialVerdict: Verdict =
      item.claimType === "factual" ? "unverified" : "not_applicable";

    await db.transaction(async (tx) => {
      await tx.insert(entry).values({
        id: tempEntryId,
        title: `eval-${runId}`.slice(0, 500),
        content: item.statement.slice(0, 50000),
        language: "en",
        metadata: { eval: true, runId, goldenId: item.id },
        authority: 0,
        // status='draft' keeps the eval entry invisible to active-only
        // search/extract queries. Verify's dbCrossRef ignores it via
        // the entry_id <> match exclusion, so cross-contamination
        // between concurrent eval items is also blocked.
        status: "draft",
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
          item.sourceUrls.map((url) => ({
            entryId: tempEntryId,
            entryCreatedAt: tempCreatedAt,
            url,
            sourceType: "unknown",
            trust: authorityFor(url),
          })),
        );
      }
    });

    let predicted: Verdict;
    let certainty = 0;

    if (item.claimType === "factual") {
      const result = await verifyClaim(claimId);
      if (!result) {
        predicted = "unverified";
      } else {
        predicted = result.verdict as Verdict;
        certainty = result.certainty;
      }
    } else {
      // Production never verifies non-factual claims — they ship as
      // not_applicable. Mirror that here so the metric reflects real
      // pipeline behavior, not a hypothetical verifier.
      predicted = "not_applicable";
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
      predicted: "unverified",
      correct: false,
      certainty: 0,
      error: (err as Error).message,
    };
  } finally {
    try {
      await db
        .delete(entry)
        .where(
          and(
            eq(entry.id, tempEntryId),
            eq(entry.createdAt, tempCreatedAt),
          ),
        );
    } catch (cleanupErr) {
      logger.warn(
        { tempEntryId, err: (cleanupErr as Error).message },
        "golden eval cleanup failed — temp entry may persist",
      );
    }
  }
}

export interface GoldenEvalOptions {
  commitSha?: string;
  modelVersions?: Record<string, string>;
}

export async function runGoldenEval(
  opts: GoldenEvalOptions = {},
): Promise<EvalResult | null> {
  const runId = ulid();
  const rawItems = await db
    .select({
      id: goldenSetClaim.id,
      statement: goldenSetClaim.statement,
      claimType: goldenSetClaim.claimType,
      expectedVerdict: goldenSetClaim.expectedVerdict,
      sourceUrls: goldenSetClaim.sourceUrls,
    })
    .from(goldenSetClaim)
    .where(eq(goldenSetClaim.active, 1));

  const items = rawItems.map((r) => ({
    id: r.id,
    statement: r.statement,
    claimType: r.claimType,
    expectedVerdict: r.expectedVerdict,
    sourceUrls: Array.isArray(r.sourceUrls)
      ? (r.sourceUrls as unknown[]).filter((u): u is string => typeof u === "string")
      : null,
  }));

  if (items.length === 0) {
    logger.info({ runId }, "golden set empty — no evaluation performed");
    return null;
  }

  logger.info({ runId, total: items.length }, "golden eval starting");

  const results: ItemResult[] = [];
  for (const item of items) {
    const r = await evaluateOne(item, runId);
    results.push(r);
    if (r.error) {
      logger.warn(
        { goldenId: r.goldenId, error: r.error },
        "golden eval item errored — counted as incorrect",
      );
    }
  }

  const byVerdict: Record<Verdict, PerVerdictMetric> = {
    verified: emptyMetric(),
    disputed: emptyMetric(),
    unverified: emptyMetric(),
    not_applicable: emptyMetric(),
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
    if (!byType[tk]) byType[tk] = emptyMetric();
    byType[tk].support++;
    if (r.correct) byType[tk].tp++;
    else byType[tk].fp++;
  }

  for (const v of VERDICTS) byVerdict[v] = finalizeMetric(byVerdict[v]);
  for (const k of Object.keys(byType)) byType[k] = finalizeMetric(byType[k]!);

  const correct = results.filter((r) => r.correct).length;
  const total = results.length;

  // Macro-averaged across verdict classes that have any support.
  // Macro (not micro) so a minority class can't be drowned out by the
  // common one — a verifier that calls everything 'unverified' should
  // score badly here even if 70% of the golden set happens to be
  // unverified.
  const supported = VERDICTS.filter((v) => byVerdict[v].support > 0);
  const macroPrecision =
    supported.length === 0
      ? 0
      : supported.reduce((s, v) => s + byVerdict[v].precision, 0) / supported.length;
  const macroRecall =
    supported.length === 0
      ? 0
      : supported.reduce((s, v) => s + byVerdict[v].recall, 0) / supported.length;
  const macroF1 =
    supported.length === 0
      ? 0
      : supported.reduce((s, v) => s + byVerdict[v].f1, 0) / supported.length;

  const [prior] = await db
    .select({ id: goldenSetRun.id, f1: goldenSetRun.f1Overall })
    .from(goldenSetRun)
    .orderBy(desc(goldenSetRun.ranAt))
    .limit(1);

  const regressed = prior ? macroF1 < prior.f1 : null;

  await db.insert(goldenSetRun).values({
    id: runId,
    commitSha: opts.commitSha ?? null,
    modelVersions: opts.modelVersions ?? { embedding: "all-MiniLM-L6-v2" },
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
      results: results.map((r) => ({
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
    "golden eval complete",
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
