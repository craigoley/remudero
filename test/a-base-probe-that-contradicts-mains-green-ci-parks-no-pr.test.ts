// test/a-base-probe-that-contradicts-mains-green-ci-parks-no-pr.test.ts
//
// LIVE 2026-10-09: #10296's red test-slow shard named test/plan-resequence-pr-invalidation-wiring.test.ts.
// The daemon's local base probe found that file failing at eight successive main tips (d11071433,
// 6ca760e82, 488baa22f, …) while main's own CI judged those same shas green — the probe's environment
// failed, not main. Every pass stood #10296 down as "base red reproduced … no fix dispatched", so it
// sat red for two hours with no fix round and no exit. CI's verdict on main now outranks the probe.
import assert from "node:assert/strict";
import test from "node:test";
import { ciContradictedProbeFiles } from "../src/lib/base-reproduction.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.now();
const MAIN = "b".repeat(40);
const NEXT = "c".repeat(40);
const FILE = "test/plan-resequence-pr-invalidation-wiring.test.ts";
type Row = Record<string, unknown>;

function redPr(): OpenPrView {
  return {
    prNumber: 10296, prUrl: "https://github.com/acme/remudero/pull/10296", taskId: "W1-T5830",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(), headSha: "a".repeat(40),
    headRefName: "run-W1-T5830-1", autoMergeArmed: false,
    ciFailures: [{ name: "test-slow-shard (2/2)", logTail: `not ok 1 - ${FILE}` }],
  };
}

function peer(): OpenPrView {
  return { ...redPr(), prNumber: 6000, taskId: "W1-T6000", checksState: "green", reviewState: "success", ciFailures: [] };
}

function harness(rows: Row[], tip: string) {
  const fixed: number[] = [];
  const judged: string[][] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    fixProgressJudge: async (input) => {
      judged.push(input.currentRed);
      return { verdict: "continue", reason: "main's CI clears base attribution; diagnose this head" };
    },
    dispatchFix: (pr) => {
      fixed.push(pr.prNumber);
      rows.push({ step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1 });
    },
    updateBranch: () => "updated",
    ledgerPath: "/dev/null/base-probe-contradicted.ndjson", runId: "W1-T5830-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => tip,
    reproduceFailingTestsOnMain: async (_pr, files) => files.map((file) => ({ file, outcome: "fails", duration_ms: 1, cached: false })),
  };
  return { rows, fixed, judged, sweep: () => runSweep([redPr(), peer()], deps, DEFAULT_SWEEP_POLICY) };
}

test("a probe failing at a main sha whose CI is green dispatches the fix instead of parking the PR", async () => {
  const h = harness([{ step: "main.health.observed", sha: MAIN, state: "green" }], MAIN);
  await h.sweep();
  assert.deepEqual(h.fixed, [10296]);
  assert.deepEqual(h.judged, [["test-slow-shard (2/2)"]]);
  const contradicted = h.rows.find((r) => r.step === "sweep.base_reproduction.contradicted");
  assert.equal(contradicted?.main_sha, MAIN);
  const disposed = h.rows.find((r) => r.step === "sweep.disposed" && r.pr_number === 10296);
  assert.doesNotMatch(String(disposed?.stand_down_reason ?? ""), /base red/);
});

test("an earlier probe contradicted by green CI still frees the PR at a newer, not-yet-judged tip", async () => {
  const h = harness([
    { step: "main.health.observed", sha: NEXT, state: "green", decided_by_sha: MAIN },
    { step: "sweep.base_reproduction", pr_number: 10296, main_sha: MAIN, verdict: "reproduced",
      files: [{ file: FILE, outcome: "fails", duration_ms: 1, cached: false }] },
  ], "d".repeat(40));
  await h.sweep();
  assert.deepEqual(h.fixed, [10296]);
  assert.deepEqual(h.judged, [["test-slow-shard (2/2)"]]);
});

test("a probe failing where main's CI is not green still stands the PR down as base red", async () => {
  const h = harness([{ step: "main.health.observed", sha: MAIN, state: "undetermined" },
    { step: "main.health.observed", sha: NEXT, state: "green" }], MAIN);
  await h.sweep();
  assert.deepEqual(h.fixed, []);
  assert.deepEqual(h.judged, []);
  assert.equal(h.rows.some((r) => r.step === "sweep.base_reproduction.contradicted"), false);
});

test("ciContradictedProbeFiles names only files that failed at a sha CI judged green", () => {
  const rows: Row[] = [
    { step: "main.health.observed", sha: NEXT, state: "green", decided_by_sha: MAIN },
    { step: "sweep.base_reproduction", main_sha: MAIN, files: [{ file: FILE, outcome: "fails" }, { file: "test/x.test.ts", outcome: "passes" }] },
    { step: "sweep.base_reproduction", main_sha: "e".repeat(40), files: [{ file: "test/y.test.ts", outcome: "fails" }] },
  ];
  assert.deepEqual([...ciContradictedProbeFiles(rows)], [FILE]);
});
