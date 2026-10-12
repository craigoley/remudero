import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { priorStrikesFor } from "../src/run-task.js";

// W1-T6405 — OBSERVED 2026-10-08: #10058, #10084 and #10089 were red on failures main had already
// fixed. Main's fix landed BEFORE the first base-reproduction probe, so the first probe already read
// `clear`, nothing was ever "previously reproduced", and the PR went to a fix round — or, with no
// round admitted, the stalled own-red stage escalated "DIAGNOSIS: unknown signature" (#10072).

const NOW = Date.UTC(2026, 9, 8, 13);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const MAIN = "b".repeat(40);
const HEAD = "a".repeat(40);
const REFRESHED_HEAD = "e".repeat(40);
const FILE = "test/operator-agent-scan-routes-never-block-the-loop.test.ts";
const PR = 10058;
type Row = Record<string, unknown>;

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "W1-T6301",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: ago(1), headSha: HEAD, headRefName: "run-W1-T6301-1", autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: `not ok 1 - ${FILE}` }], ...over,
  };
}

function peer(): OpenPrView {
  return redPr({ prNumber: 6000, prUrl: "https://github.com/acme/remudero/pull/6000", taskId: "W1-T6000",
    headRefName: "run-W1-T6000-1", checksState: "green", reviewState: "success", ciFailures: [] });
}

function harness(rows: Row[], behindBy: number) {
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const probes: string[] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    dispatchFix: (pr) => {
      fixed.push(pr.prNumber);
      rows.push({ step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1 });
    },
    updateBranch: (pr) => { refreshed.push(pr.prNumber); return "updated"; },
    // The FIRST probe of this head already runs on a main that fixed the failure: it passes.
    reproduceFailingTestsOnMain: async (_pr, files, sha) => {
      probes.push(...files.map((file) => `${sha}:${file}`));
      return files.map((file) => ({ file, outcome: "passes", duration_ms: 9, cached: false }));
    },
    behindMainByPr: new Map([[PR, behindBy]]),
    ledgerPath: "/dev/null/w1-t6405.ndjson", runId: "W1-T6405-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => MAIN,
  };
  return { rows, fixed, refreshed, probes, escalations, deps };
}

test("W1-T6405: a red already fixed on main refreshes the branch before any fix round", async () => {
  const h = harness([{ step: "main.health.observed", sha: MAIN, state: "undetermined" }], 3);
  await runSweep([redPr(), peer()], h.deps, DEFAULT_SWEEP_POLICY);
  // No earlier probe reproduced anything — this pass's probe is the first, and it reads clear.
  assert.deepEqual(h.probes, [`${MAIN}:${FILE}`]);
  assert.equal(h.rows.filter((r) => r.step === "sweep.base_reproduction" && r.verdict === "reproduced").length, 0);
  assert.deepEqual(h.refreshed, [PR], "the branch takes the main that already fixed its red");
  assert.deepEqual(h.fixed, [], "no fix round on the refreshing pass");
  assert.equal(priorStrikesFor(h.rows, "W1-T6301", "keyword_only", HEAD), 0, "no strike spent");
  const refresh = h.rows.filter((r) => r.step === "sweep.base_fixed.refresh");
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0]?.pr_number, PR);
  assert.equal(refresh[0]?.head_sha, HEAD);
  assert.equal(refresh[0]?.main_sha, MAIN);
  assert.deepEqual(refresh[0]?.test_files, [FILE]);
  assert.equal(refresh[0]?.outcome, "updated");
  const disposed = h.rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === PR);
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /fixed on main/);

  // One refresh per head: the same head still red on a later pass is the PR's own red.
  await runSweep([redPr(), peer()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.fixed, [PR]);

  // A head that is not behind main has nothing to take: the fix rung proceeds as today.
  const current = harness([{ step: "main.health.observed", sha: MAIN, state: "undetermined" }], 0);
  await runSweep([redPr(), peer()], current.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(current.refreshed, []);
  assert.deepEqual(current.fixed, [PR]);
  assert.equal(current.rows.filter((r) => r.step === "sweep.base_fixed.refresh").length, 0);
});

test("W1-T6405: a stalled own-red fixed on main refreshes instead of escalating", async () => {
  const rows: Row[] = [
    { step: "main.health.observed", sha: MAIN, state: "undetermined" },
    { ts: ago(50), run_id: "old", task_id: "W1-T6301", step: "sweep.disposed", pr_number: PR, head_sha: HEAD,
      disposition: "blocked-fixable", acted: false, blocker: "own-red", blocker_since: ago(50) },
    // An earlier pass already probed this head's failing test on the CURRENT main: it passes there.
    { ts: ago(20), run_id: "old", task_id: "W1-T6301", step: "sweep.base_reproduction", pr_number: PR,
      head_sha: HEAD, main_sha: MAIN, verdict: "clear",
      files: [{ file: FILE, outcome: "passes", duration_ms: 9, cached: false }] },
  ];
  const h = harness(rows, 3);
  // No fix round is admitted (the fix rung never runs) — only the stalled-stage rung sees this PR.
  const deps = { ...h.deps, actionable: () => false };
  await runSweep([redPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.escalations, [], "a red main already fixed is not escalated");
  assert.deepEqual(h.refreshed, [PR]);
  assert.deepEqual(h.fixed, []);
  const stuck = h.rows.filter((r) => r.step === "pr.stuck");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]?.blocker, "own-red");
  assert.equal(stuck[0]?.diagnosis, "fixed-on-main");
  const refresh = h.rows.filter((r) => r.step === "sweep.base_fixed.refresh");
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0]?.head_sha, HEAD);
  assert.equal(refresh[0]?.main_sha, MAIN);
  assert.deepEqual(refresh[0]?.test_files, [FILE]);
  await runSweep([redPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR], "the stalled stage refreshes once");
  assert.deepEqual(h.escalations, []);

  // The refreshed head now carries main, and is STILL red past its backstop: that red is its own.
  h.rows.push({ ts: ago(1), run_id: "later", task_id: "W1-T6301", step: "sweep.disposed", pr_number: PR,
    head_sha: REFRESHED_HEAD, disposition: "blocked-fixable", acted: false, blocker: "own-red", blocker_since: ago(46) });
  const refreshedDeps = { ...deps, behindMainByPr: new Map([[PR, 0]]) };
  await runSweep([redPr({ headSha: REFRESHED_HEAD })], refreshedDeps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [PR]);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0]!, /own-red .*DIAGNOSIS: unknown signature/);
});
