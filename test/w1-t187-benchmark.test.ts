import assert from "node:assert/strict";
import { test } from "node:test";
import { projectPlan, type DeriveDeps } from "../src/lib/status.js";
import {
  CORPUS_MIN_LEDGER_LINES,
  CORPUS_MIN_TASKS,
  FIXED_NOW_ISO,
  corpusLedgerPath,
  loadCorpusGithub,
  loadCorpusLedgerLines,
  loadCorpusPlan,
} from "./fixtures/w1-t187/load.js";

/**
 * W1-T187 acceptance criterion 3 — "projectPlan over the real-scale corpus completes UNDER
 * 500 ms — an absolute measured budget, never 'faster than before'". Proof required: a
 * benchmark test over a seeded corpus at production scale (>= 200 tasks, >= 18,000 ledger
 * lines): projectPlan completes under 500 ms, asserted as a FIXED CEILING in the test itself.
 *
 * Stated ABSOLUTELY on purpose (the task's own design note): a relative claim ("faster than
 * before") cannot fail. FALSIFIER, measured 2026-07-20 on the live corpus pre-fix: 5,229 ms
 * warm and 8,207 ms cold, against 113 ms for the identical derivations with a single hoisted
 * ledger read -- a 46x gap that is entirely re-parsing.
 *
 * NO injected `readLedger` here -- this exercises the REAL default `readLedgerLines`, a REAL
 * fs.readFileSync of the committed 1.2MB `ledger.ndjson` fixture, exactly the code path a real
 * `GET /v1/status` request drives (board.ts's `computeBoardSnapshot` -> `projectPlan`).
 */

// W1-T220 defect 2 (root cause, found from a REAL failing run's output -- coverage-ratchet's own
// CI log used to be blind, per defect 1 above; once it wasn't, a coverage-ratchet job log pulled
// off PR #497 (run 29850982215) showed every one of ~1764 tests green except THIS one, which
// measured 1074ms against its hard-coded 500ms ceiling. This test is untouched by whatever diff
// happened to be under review -- it benchmarks src/lib/status.ts's projectPlan over a 1.2MB seeded
// ledger fixture -- which matches the coverage-ratchet flake's sharpest clue: PRs #474/#475 flaked
// this same gate while touching zero source and zero test files, ruling out any explanation that
// rests on changed code. `--experimental-test-coverage` measurably slows V8 execution (isolated
// single-file runs under the same flags measure 147-321ms, comfortably clear), and the coverage-
// ratchet job runs this benchmark alongside dozens of concurrently executing Playwright/Chromium
// test files under that same instrumentation -- real CPU contention this test's own diff never
// introduces. Detected via process.execArgv (--test-coverage-exclude=... is present under the
// coverage-ratchet command, absent under a plain `npm test`), the timing assertions are skipped
// ONLY in that instrumented mode -- the functional assertions (result size matches corpus size)
// still run unconditionally, and the 500ms ceiling itself stays fully enforced, unrelaxed, by the
// sibling `ci` job's uninstrumented `npm test` run of this exact file, which is where this
// criterion's falsifier proof lives.
const COVERAGE_INSTRUMENTED = process.execArgv.some(
  (arg) => arg.startsWith("--test-coverage") || arg === "--experimental-test-coverage",
);

test("W1-T187 criterion 3: projectPlan over the production-scale corpus completes UNDER 500ms (absolute ceiling, not a relative speedup claim)", (t) => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const ledgerLineCount = loadCorpusLedgerLines().length;
  assert.ok(plan.tasks.length >= CORPUS_MIN_TASKS, `corpus must carry >= ${CORPUS_MIN_TASKS} tasks`);
  assert.ok(ledgerLineCount >= CORPUS_MIN_LEDGER_LINES, `corpus ledger must carry >= ${CORPUS_MIN_LEDGER_LINES} lines`);

  const deps: DeriveDeps = { ledgerPath: corpusLedgerPath(), github, now: () => Date.parse(FIXED_NOW_ISO) };

  // Two measured calls -- "cold" (first read of this fixture in this process) and "warm"
  // (module/JIT/OS-file-cache already primed) -- BOTH must clear the 500ms ceiling; the
  // ceiling is not allowed to depend on which one a caller happens to hit.
  const coldStart = performance.now();
  const coldById = projectPlan(plan, deps);
  const coldMs = performance.now() - coldStart;

  const warmStart = performance.now();
  const warmById = projectPlan(plan, deps);
  const warmMs = performance.now() - warmStart;

  assert.equal(coldById.size, plan.tasks.length);
  assert.equal(warmById.size, plan.tasks.length);

  if (COVERAGE_INSTRUMENTED) {
    // Functional assertions above (sizes match the corpus) already ran unconditionally -- only
    // the timing ceiling, which coverage instrumentation itself distorts under CI's concurrent
    // test-file contention, is skipped here.
    t.diagnostic(
      `coverage-instrumented run: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms -- ` +
        `500ms ceiling enforced by the uninstrumented \`ci\` job's npm test instead (see comment above)`,
    );
    return;
  }

  assert.ok(
    coldMs < 500,
    `projectPlan (cold) took ${coldMs.toFixed(1)}ms over ${plan.tasks.length} tasks / ${ledgerLineCount} ledger lines -- ` +
      `must be < 500ms (pre-fix measured 8,207ms cold; post-hoist control measured 113ms)`,
  );
  assert.ok(
    warmMs < 500,
    `projectPlan (warm) took ${warmMs.toFixed(1)}ms over ${plan.tasks.length} tasks / ${ledgerLineCount} ledger lines -- ` +
      `must be < 500ms (pre-fix measured 5,229ms warm; post-hoist control measured 113ms)`,
  );
});
