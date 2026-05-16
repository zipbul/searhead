// CLI entry for the golden-set evaluator. Run with `bun run eval:golden`.
//
// Exit codes:
//   0 — evaluation ran (or no-op on empty corpus) without regression
//   1 — evaluation ran and macro-F1 regressed below the most recent prior run
//       (only when EVAL_FAIL_ON_REGRESSION=1; otherwise regression is reported
//       in stdout but exit stays 0)
//   2 — evaluator itself threw before producing a result
//
// The opt-in regression gate keeps the script safe to wire into CI on day
// one — early runs with a near-empty corpus would otherwise flip green/red
// on noise alone. Set EVAL_FAIL_ON_REGRESSION=1 once the corpus has enough
// labels for the macro-F1 signal to be stable.

import { logger } from '../observability/logger';
import { runGoldenEval } from './golden';

async function main(): Promise<void> {
  const commitSha = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? undefined;
  const result = await runGoldenEval({ commitSha });

  if (!result) {
    console.log('golden set is empty — add labelled rows to golden_set_claim to begin measurement');
    process.exit(0);
  }

  console.log(`run_id        ${result.runId}`);
  console.log(`total         ${result.total}  (correct=${result.correct}  wrong=${result.total - result.correct})`);
  console.log(
    `macro_p/r/f1  ${result.precisionOverall.toFixed(3)} / ${result.recallOverall.toFixed(3)} / ${result.f1Overall.toFixed(3)}`,
  );
  if (result.baselineRunId) {
    console.log(`baseline      ${result.baselineRunId}  (regressed=${result.regressed ? 'yes' : 'no'})`);
  } else {
    console.log('baseline      (none — first run)');
  }

  console.log('');
  console.log('per-verdict');
  for (const [v, m] of Object.entries(result.byVerdict)) {
    if (m.support === 0) {
      continue;
    }
    console.log(
      `  ${v.padEnd(16)} support=${String(m.support).padStart(4)}  P=${m.precision.toFixed(3)}  R=${m.recall.toFixed(3)}  F1=${m.f1.toFixed(3)}`,
    );
  }

  console.log('');
  console.log('per-claim-type');
  for (const [t, m] of Object.entries(result.byType)) {
    console.log(`  ${t.padEnd(16)} support=${String(m.support).padStart(4)}  acc=${(m.tp / Math.max(1, m.support)).toFixed(3)}`);
  }

  const failOnRegression = process.env.EVAL_FAIL_ON_REGRESSION === '1';
  if (failOnRegression && result.regressed) {
    console.error(`\nREGRESSION: macro-F1 dropped vs baseline ${result.baselineRunId}. Failing.`);
    process.exit(1);
  }
  process.exit(0);
}

try {
  await main();
} catch (err) {
  logger.error({ err: (err as Error).message }, 'golden eval CLI failed');
  console.error(`eval failed: ${(err as Error).message}`);
  process.exit(2);
}
