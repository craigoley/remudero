import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// OBSERVED 2026-10-15: main was red on test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts
// until #12034 merged at 15:02Z. #12019's probe at cd482d43 (15:17Z) and #12044's (15:35Z) read `clear`, yet no
// refresh followed: W1-T6405's fixed-on-main arm needed `behindMainByPr > 0`, which the light pass never supplies and
// the full pass reads for a rotating slice of three PRs. #12044 then reached the fix-progress judge, which escalated
// its inherited red as "cannot be judged as fixable".

const NOW = Date.UTC(2026, 9, 15, 15, 30);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const MAIN = "c".repeat(40);
const OLD_MAIN = "7".repeat(40);
const HEAD = "a".repeat(40);
const FILE = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const SHARD = "coverage-shard (6/8)";
const PR = 12044;
type Row = Record<string, unknown>;

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "W1-T9633",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    createdAt: ago(90), lastActivityAt: ago(1), headSha: HEAD, headRefName: "run-W1-T9633-1", autoMergeArmed: false,
    ciFailures: [{ name: SHARD, logTail: `not ok 1 - ${FILE}` }], ...over,
  };
}

/** A probe another PR ran while main was red: the file failed at an older main. */
const formerlyFailing = (): Row => ({ ts: ago(80), run_id: "old", task_id: "W1-T9557", step: "sweep.base_reproduction",
  pr_number: 12017, head_sha: "d".repeat(40), main_sha: OLD_MAIN, verdict: "reproduced",
  files: [{ file: FILE, outcome: "fails", duration_ms: 9, cached: false }] });

function harness(rows: Row[], behindMainByPr?: Map<number, number>) {
  // W1-T8533: unrelated PR history covers this PR's entire lifetime for every refresh reader.
  rows.unshift(...["fix.base_refreshed", "sweep.base_red.refresh", "sweep.base_fixed.refresh", "refresh.clearance"]
    .map(step => ({ step, ts: new Date(NOW - 120 * 60_000).toISOString(), pr_number: 1, outcome: "skipped" })));
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const escalations: string[] = [];
  const judged: number[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    dispatchFix: (pr) => {
      fixed.push(pr.prNumber);
      rows.push({ step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1 });
    },
    updateBranch: (pr) => { refreshed.push(pr.prNumber); return "updated"; },
    // The 15:38Z verdict: round 0 with no history reads as "cannot be judged".
    fixProgressJudge: async (input) => {
      judged.push(input.prNumber ?? -1);
      return { verdict: "escalate", loop: "coverage-ratchet+coverage-shard", reason: "cannot be judged as fixable from this evidence" };
    },
    reproduceFailingTestsOnMain: async (_pr, files) => files.map((file) => ({ file, outcome: "passes", duration_ms: 9, cached: false })),
    ...(behindMainByPr ? { behindMainByPr } : {}),
    ledgerPath: "/dev/null/inherited-red.ndjson", runId: "inherited-red-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => MAIN,
  };
  return { rows, fixed, refreshed, escalations, judged, deps };
}

test("a red main once failed is refreshed on a clear probe when the head's distance from main is unread", async () => {
  const h = harness([{ step: "main.health.observed", sha: MAIN, state: "green" }, formerlyFailing()]);
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR], "the head takes the main that fixed the red it inherited");
  assert.deepEqual(h.fixed, [], "no fix round on an inherited red");
  const noted = h.rows.filter((r) => r.step === "sweep.base_fixed.inherited" && r.pr_number === PR);
  assert.equal(noted.length, 1);
  assert.equal(noted[0]?.basis, "main-formerly-failing");
  assert.equal(noted[0]?.main_sha, MAIN);
  assert.deepEqual(noted[0]?.test_files, [FILE]);
  const refresh = h.rows.filter((r) => r.step === "sweep.base_fixed.refresh" && r.pr_number === PR);
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0]?.outcome, "updated");
  const disposed = h.rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === PR);
  assert.match(String(disposed?.stand_down_reason), /already fixed on main/);

  // Once per head: the same head still red on a later pass is its own red and goes to the fix lane.
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR]);
  assert.equal(h.rows.filter((r) => r.step === "sweep.base_fixed.inherited").length, 1, "the basis is logged once per head");
});

test("a head stood down as base red is refreshed once main clears it, even while main's last reading is red", async () => {
  // #12019 at 15:17Z: main's latest run (an older sha) was still red on `ci` alone and saw the shard pass, so
  // decideBaseRed read the shard red as the PR's own; the stood-down promise "refreshes once main is green" was lost.
  const h = harness([
    { step: "main.health.observed", sha: MAIN, state: "red", decided_by_sha: OLD_MAIN, failing_checks: ["ci"], observed_checks: ["ci", SHARD] },
    { ts: ago(35), run_id: "old", task_id: "W1-T9633", step: "sweep.base_red.stood_down", pr_number: PR, head_sha: HEAD,
      check_name: SHARD, main_sha: OLD_MAIN },
  ]);
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.fixed, []);
  assert.equal(h.rows.find((r) => r.step === "sweep.base_fixed.inherited" && r.pr_number === PR)?.basis, "stood-down");
});

test("the fix-progress judge is never asked to escalate a red the base probe attributes to main", async () => {
  const h = harness([{ step: "main.health.observed", sha: MAIN, state: "green" }, formerlyFailing()]);
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.judged, [], "an inherited red never reaches the judge");
  assert.deepEqual(h.escalations, []);
  assert.equal(h.rows.filter((r) => r.step === "fix.progress_judged").length, 0);
});

test("an unread distance with no record of main carrying the red keeps the PR on its own fix lane", async () => {
  const h = harness([{ step: "main.health.observed", sha: MAIN, state: "green" }]);
  await runSweep([redPr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.fixed, [PR], "its own red goes to its own fix lane");
  assert.deepEqual(h.judged, [], "W1-T10039: its first round is not put to the judge");
  assert.equal(h.rows.filter((r) => r.step === "sweep.base_fixed.inherited").length, 0);

  // A head measured as already carrying main has nothing to take, whatever main once failed.
  const current = harness([{ step: "main.health.observed", sha: MAIN, state: "green" }, formerlyFailing()], new Map([[PR, 0]]));
  await runSweep([redPr()], current.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(current.refreshed, []);
  assert.equal(current.rows.filter((r) => r.step === "sweep.base_fixed.inherited").length, 0);
});

test("main's formerly failing files skip the current tip and shas main's own CI judged green", async () => {
  const { mainFormerlyFailingTestFiles } = await import("#src/lib/base-reproduction.js");
  const green = "9".repeat(40);
  const rows: Row[] = [
    formerlyFailing(),
    { step: "sweep.base_reproduction", main_sha: MAIN, verdict: "reproduced", files: [{ file: "test/now.test.ts", outcome: "fails" }] },
    { step: "main.health.observed", sha: green, state: "green" },
    { step: "sweep.base_reproduction", main_sha: green, verdict: "reproduced", files: [{ file: "test/env.test.ts", outcome: "fails" }] },
    { step: "sweep.base_reproduction", main_sha: OLD_MAIN, verdict: "partial", files: [{ file: "test/partial.test.ts", outcome: "fails" }] },
  ];
  assert.deepEqual([...mainFormerlyFailingTestFiles(rows, MAIN)], [FILE]);
});
