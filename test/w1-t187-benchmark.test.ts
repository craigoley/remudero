import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus, projectPlan, readLedgerLines, type DeriveDeps } from "../src/lib/status.js";
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
 * an absolute measured budget, never 'faster than before'". Proof required: a benchmark test
 * over a seeded corpus at production scale (>= 200 tasks, >= 18,000 ledger lines): projectPlan
 * completes under the ceiling, asserted ABSOLUTELY in the test itself.
 *
 * Stated ABSOLUTELY on purpose (the task's own design note): a relative claim ("faster than
 * before") cannot fail. FALSIFIER, measured 2026-07-20 on the live corpus pre-fix: 5,229 ms
 * warm and 8,207 ms cold, against 113 ms for the identical derivations with a single hoisted
 * ledger read -- a 46x gap that is entirely re-parsing.
 *
 * NO injected `readLedger` here -- this exercises the REAL default `readLedgerLines`, a REAL
 * fs.readFileSync of the committed 1.2MB `ledger.ndjson` fixture, exactly the code path a real
 * `GET /v1/status` request drives (board.ts's `computeBoardSnapshot` -> `projectPlan`).
 *
 * W1-T2310 -- THE CLOCK IS NOT THE ONLY GATE ANY MORE. The regression this file exists to
 * catch (a per-task re-read+re-parse of the ledger) is COUNTABLE, not just timeable: a
 * counting wrapper around the real `readLedgerLines`, driven through `projectPlan` over this
 * same corpus, reads the ledger exactly ONCE for 220 tasks; the pre-hoist call pattern
 * (`deriveStatus` invoked directly, once per task, with no `projectPlan`-level hoist) reads it
 * 220 times. That assertion has no clock in it and cannot flake on a busy runner -- see the two
 * tests below. Because a read-count invariant now shares the job, the wall-clock ceiling was
 * widened from 500ms to 2000ms (this repo's existing convention for 13 other wall-clock upper
 * bounds -- grep `< 2000` across test/): on a GitHub runner the 500ms bound left 0%-25%
 * headroom (400ms passing, 525-567ms failing) and had breached CI twice (W1-T220 / PR #497,
 * and PR #2945 attempt 1) for reasons unrelated to the diffs under review -- coverage
 * instrumentation and concurrent-suite contention, not a real regression. 2000ms still fails
 * the measured pre-fix cost (5,229ms warm / 8,207ms cold) by 2.6x-4.1x, so the falsifier this
 * criterion was written for still fails it; what it stops catching -- a slowdown between
 * roughly 4x and 17x -- is exactly the gap the read-count invariant now covers instead. See
 * `scripts/clock-sweep-baseline.json`'s own doctrine: a ceiling may FALL when the underlying
 * thing is fixed, and must never be RAISED to paper over a regression -- this raise ships
 * beside the new invariant that keeps the regression class it gives up covered.
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
// still run unconditionally, and the ceiling itself stays fully enforced, unrelaxed, by the
// sibling `ci` job's uninstrumented `npm test` run of this exact file, which is where this
// criterion's falsifier proof lives. The ledger-read-count invariant added by W1-T2310 (below,
// in the two tests after this one) is UNAFFECTED by coverage instrumentation -- it has no clock
// in it -- so it runs unconditionally in every mode, coverage-instrumented or not.
const COVERAGE_INSTRUMENTED = process.execArgv.some(
  (arg) => arg.startsWith("--test-coverage") || arg === "--experimental-test-coverage",
);

// W1-T2310 -- the ceiling raised from 500 to 2000. NOT the house's other most permissive number
// (45000) and not a fresh number chosen from today's worst CI reading plus slack (567.4ms plus
// margin would be a number picked by a busy runner, not by an argument): 2000 is this repo's
// existing convention for a wall-clock upper bound (13 other `< 2000` assertions across test/,
// vs. 500 twice, 1000 once, 4000 twice, 5000 twice, 45000 once), and it still fails the
// measured pre-fix cost below by 2.6x (warm) to 4.1x (cold).
const CEILING_MS = 2000;
// Measured 2026-07-20 on the live corpus pre-hoist (see file doc comment above) -- the
// falsifier this ceiling must still catch.
const PRE_FIX_WARM_MS = 5229;
const PRE_FIX_COLD_MS = 8207;

test("W1-T187 criterion 3: projectPlan over the production-scale corpus completes UNDER 2000ms (absolute ceiling, not a relative speedup claim)", (t) => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const ledgerLineCount = loadCorpusLedgerLines().length;
  assert.ok(plan.tasks.length >= CORPUS_MIN_TASKS, `corpus must carry >= ${CORPUS_MIN_TASKS} tasks`);
  assert.ok(ledgerLineCount >= CORPUS_MIN_LEDGER_LINES, `corpus ledger must carry >= ${CORPUS_MIN_LEDGER_LINES} lines`);

  // The raised ceiling must still fail the measured pre-fix cost on BOTH samples -- a purely
  // arithmetic, deterministic check of the constants above, independent of anything measured on
  // this run/host. Never widen CEILING_MS without keeping this comfortably true.
  assert.ok(
    PRE_FIX_COLD_MS > CEILING_MS,
    `raising the ceiling to ${CEILING_MS}ms must still fail the measured pre-fix cold cost (${PRE_FIX_COLD_MS}ms)`,
  );
  assert.ok(
    PRE_FIX_WARM_MS > CEILING_MS,
    `raising the ceiling to ${CEILING_MS}ms must still fail the measured pre-fix warm cost (${PRE_FIX_WARM_MS}ms)`,
  );

  const deps: DeriveDeps = { ledgerPath: corpusLedgerPath(), github, now: () => Date.parse(FIXED_NOW_ISO) };

  // Two measured calls -- "cold" (first read of this fixture in this process) and "warm"
  // (module/JIT/OS-file-cache already primed). BOTH samples are measured here, before either is
  // asserted against the ceiling below -- W1-T2310: a prior run's failure record named only
  // whichever sample was asserted first (cold), so the other (warm) was left unknown at the
  // moment CI went red even though it had already been measured. Combining both readings into
  // one failure message (further below) makes every failure record name both, unconditionally.
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
        `${CEILING_MS}ms ceiling enforced by the uninstrumented \`ci\` job's npm test instead (see comment above)`,
    );
    return;
  }

  // BOTH samples must clear the ceiling; the ceiling is not allowed to depend on which one a
  // caller happens to hit. A single assertion over both readings -- rather than two separate
  // `assert.ok` calls -- so a failure names both cold and warm together, whichever breached.
  const breaches: string[] = [];
  if (coldMs >= CEILING_MS) breaches.push(`cold ${coldMs.toFixed(1)}ms`);
  if (warmMs >= CEILING_MS) breaches.push(`warm ${warmMs.toFixed(1)}ms`);
  assert.equal(
    breaches.length,
    0,
    `projectPlan over ${plan.tasks.length} tasks / ${ledgerLineCount} ledger lines must complete under ` +
      `${CEILING_MS}ms on both samples -- measured cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms, ` +
      `breached: ${breaches.join(", ")} (pre-fix measured ${PRE_FIX_COLD_MS}ms cold / ${PRE_FIX_WARM_MS}ms warm; ` +
      `post-hoist control measured 113ms)`,
  );
});

/**
 * W1-T2310 -- THE DETERMINISTIC HALF OF THE PROOF. The regression W1-T187 exists to catch is a
 * COUNT, not a duration: `projectPlan` must read+parse the ledger exactly ONCE per projection,
 * no matter how many tasks it projects, via the hoisted `DeriveDeps.readLedger` override
 * (src/lib/status.ts). A counting wrapper around the REAL `readLedgerLines` -- injected through
 * the same optional `DeriveDeps.readLedger` seam the production code already exposes -- proves
 * it: `tasks=220 projected=220 ledgerReads=1`. This assertion has no clock in it and cannot
 * flake under CI contention or coverage instrumentation, so it is NOT gated by
 * `COVERAGE_INSTRUMENTED` -- it runs unconditionally in every mode.
 */
test("W1-T2310: projectPlan reads+parses the ledger exactly ONCE per projection, regardless of task count (deterministic, no clock)", () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  let readCount = 0;
  const countingReadLedger = (path: string) => {
    readCount += 1;
    return readLedgerLines(path);
  };
  const deps: DeriveDeps = {
    ledgerPath: corpusLedgerPath(),
    github,
    now: () => Date.parse(FIXED_NOW_ISO),
    readLedger: countingReadLedger,
  };

  const projected = projectPlan(plan, deps);

  assert.equal(projected.size, plan.tasks.length);
  assert.equal(
    readCount,
    1,
    `projectPlan must read+parse the ledger exactly ONCE per projection (hoisted), regardless of ` +
      `task count -- saw ${readCount} read(s) over ${plan.tasks.length} tasks. A per-task read ` +
      `reintroduces the pre-hoist O(tasks x ledger) defect (5,229ms warm / 8,207ms cold falsifier).`,
  );
});

/**
 * W1-T2310 -- THE FALSIFIER, PROVEN LIVE. This reproduces the PRE-HOIST call pattern exactly:
 * `deriveStatus` invoked directly, once per task, with no `projectPlan`-level hoist overriding
 * `readLedger` to an already-parsed array. This is not a hypothetical -- it is the real code
 * this repo shipped before W1-T187's hoist, still reachable today because `deriveStatus` is a
 * public, independently-callable export. Driving the SAME counting `readLedger` through it shows
 * the deterministic invariant above actually distinguishes fixed from regressed: it reads the
 * ledger once per task here (220 times), not once, so a `readCount === 1` assertion against this
 * call pattern would fail exactly the way the pre-hoist defect failed the timing ceiling.
 */
test("W1-T2310 falsifier control: the pre-hoist call pattern (deriveStatus once per task) reads the ledger once PER TASK, not once per projection", () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  let readCount = 0;
  const countingReadLedger = (path: string) => {
    readCount += 1;
    return readLedgerLines(path);
  };
  const deps: DeriveDeps = {
    ledgerPath: corpusLedgerPath(),
    github,
    now: () => Date.parse(FIXED_NOW_ISO),
    readLedger: countingReadLedger,
  };

  const projectedByTaskId = new Map();
  for (const task of plan.tasks) projectedByTaskId.set(task.id, deriveStatus(task, deps));

  assert.equal(projectedByTaskId.size, plan.tasks.length);
  assert.equal(
    readCount,
    plan.tasks.length,
    `the pre-hoist call pattern (deriveStatus once per task, no projectPlan-level hoist) must ` +
      `read the ledger once per task -- saw ${readCount} read(s) over ${plan.tasks.length} tasks. ` +
      `This is the read-count invariant's control: it proves readCount === 1 (asserted in the ` +
      `test above) is NOT vacuously true -- the regression it exists to catch really does move ` +
      `the count, with no clock involved.`,
  );
});
