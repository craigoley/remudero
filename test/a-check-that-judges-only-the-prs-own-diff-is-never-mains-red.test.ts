import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_FIXED_INHERITED_STEP, BASE_RED_STOOD_DOWN_STEP, DEFAULT_SWEEP_POLICY,
  baseRedHistoryFromLedger, decideBaseRed, mainLatestRunFromLedger, runSweep,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

type Row = Record<string, unknown>;
const NOW = Date.now();
const MAIN = "b".repeat(40);
const HEAD = "a".repeat(40);
const OWN_CHECKS = ["prompt-surface-gate", "proof-discrimination", "acceptance-author-gate", "commitlint"];
const SHARD = "ci-shard (7/8)";
const FILE = "test/claude-md-rules-reach-their-scope.test.ts";

function pr(names: string[]): OpenPrView {
  return {
    prNumber: 12394, prUrl: "https://github.com/craigoley/remudero/pull/12394", taskId: "W1-T9628",
    headSha: HEAD, headRefName: "run-W1-T9628-1", checksState: "red", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    createdAt: new Date(NOW - 90 * 60_000).toISOString(),
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    ciFailures: names.map(name => ({ name, logTail: `${name}: FAILED` })),
  };
}

const redMain = (): Row => ({
  step: "main.health.observed", sha: MAIN, state: "red",
  failing_checks: ["ci"], observed_checks: ["ci", SHARD],
});
const stoodDown = (name: string): Row => ({
  step: BASE_RED_STOOD_DOWN_STEP, pr_number: 12394, head_sha: HEAD, check_name: name,
  main_sha: "c".repeat(40), ts: new Date(NOW - 30 * 60_000).toISOString(),
});

test("W1-T9931: a prompt-surface-gate red is the PR own red while main is red", () => {
  const none = baseRedHistoryFromLedger([]);
  for (const name of OWN_CHECKS) {
    const p = pr([name]);
    assert.deepEqual(decideBaseRed(p, mainLatestRunFromLedger([redMain()]), none), { kind: "own" }, `${name}: absent`);
    const shared = { ...redMain(), failing_checks: ["ci", name], observed_checks: ["ci", name] };
    assert.deepEqual(decideBaseRed(p, mainLatestRunFromLedger([shared]), none), { kind: "own" }, `${name}: shared`);
    const history = baseRedHistoryFromLedger([stoodDown(name)]);
    for (const state of ["red", "undetermined", "green"]) {
      const main = mainLatestRunFromLedger([{ step: "main.health.observed", sha: MAIN, state, failing_checks: ["ci"] }]);
      assert.deepEqual(decideBaseRed(p, main, history), { kind: "own" }, `${name}: recorded, main ${state}`);
    }
    assert.deepEqual(decideBaseRed(p, undefined, history), { kind: "own" }, `${name}: main unread`);
    assert.deepEqual(decideBaseRed(pr([name, "ci"]), mainLatestRunFromLedger([shared]), none),
      { kind: "wait", check: "ci" }, `${name}: inherited red beside it`);
    assert.deepEqual(decideBaseRed(pr([name, "lint-plan"]), mainLatestRunFromLedger([redMain()]), none),
      { kind: "wait", check: "lint-plan" }, `${name}: absent tree check beside it`);
  }
});

test("W1-T9931: a light gate main can break is still held while main is red", () => {
  for (const name of ["lint-plan", "rule-checks", "claims", "coverage-ratchet"]) {
    const p = pr([name]);
    const main = mainLatestRunFromLedger([redMain()]);
    assert.deepEqual(decideBaseRed(p, main, baseRedHistoryFromLedger([])), { kind: "wait", check: name });
    const shared = mainLatestRunFromLedger([{ ...redMain(), failing_checks: ["ci", name], observed_checks: ["ci", name] }]);
    assert.deepEqual(decideBaseRed(p, shared, baseRedHistoryFromLedger([])), { kind: "wait", check: name });
    const history = baseRedHistoryFromLedger([stoodDown(name)]);
    assert.deepEqual(decideBaseRed(p, undefined, history), { kind: "wait", check: name });
    const green = mainLatestRunFromLedger([{ step: "main.health.observed", sha: MAIN, state: "green" }]);
    assert.deepEqual(decideBaseRed(p, green, history), { kind: "refresh", check: name });
  }
});

async function sweepAfterStandDown(check: string) {
  const rows: Row[] = [redMain(), stoodDown(check)];
  rows.unshift(...["fix.base_refreshed", "sweep.base_red.refresh", "sweep.base_fixed.refresh", "refresh.clearance"]
    .map(step => ({ step, ts: new Date(NOW - 120 * 60_000).toISOString(), pr_number: 1, outcome: "skipped" })));
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const probed: string[] = [];
  const red = pr([SHARD]);
  red.ciFailures = [{ name: SHARD, logTail: `not ok 1 - ${FILE}` }];
  const peer = { ...pr([]), prNumber: 12395, headSha: "d".repeat(40), checksState: "green" as const,
    reviewState: "success" as const };
  const deps: SweepDeps = {
    ledgerPath: "/dev/null/w1-t9931.ndjson", runId: "W1-T9931-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); },
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: p => { fixed.push(p.prNumber); },
    updateBranch: p => { refreshed.push(p.prNumber); return "updated"; },
    readMainTip: () => MAIN,
    reproduceFailingTestsOnMain: async (_pr, files) => {
      probed.push(...files);
      return files.map(file => ({ file, outcome: "passes", duration_ms: 1, cached: false }));
    },
  };
  await runSweep([red, peer], deps, DEFAULT_SWEEP_POLICY);
  return { rows, fixed, refreshed, probed };
}

test("W1-T9931: a stand-down on a PR-own-input check is no base-fixed basis", async () => {
  for (const name of OWN_CHECKS) {
    const h = await sweepAfterStandDown(name);
    assert.deepEqual(h.probed, [FILE], `${name}: the clear probe actually ran`);
    assert.deepEqual(h.fixed, [12394], `${name}: its own failing test reaches the fix rung`);
    assert.deepEqual(h.refreshed, [], name);
    assert.equal(h.rows.some(row => row.step === BASE_FIXED_INHERITED_STEP), false, name);
    const disposed = h.rows.findLast(row => row.step === "sweep.disposed" && row.pr_number === 12394);
    assert.equal(String(disposed?.stand_down_reason).includes("already fixed on main"), false, name);
  }
  const inherited = await sweepAfterStandDown(SHARD);
  assert.deepEqual(inherited.probed, [FILE]);
  assert.deepEqual(inherited.fixed, [], "a stand-down on a tree check still supplies the basis");
  assert.equal(inherited.rows.find(row => row.step === BASE_FIXED_INHERITED_STEP)?.basis, "stood-down");
});
