import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import {
  buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

type Row = Record<string, unknown>;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MAIN = "c".repeat(40);
const PR = 16498;
const TASK = "W1-T11294";
const NOW = Date.parse("2026-11-04T00:45:51Z");

function fixture(base: unknown = BASE, main: string | undefined = MAIN) {
  const identity = { task_id: TASK, head_sha: HEAD, round_id: "round-3", strike: 1 };
  const ledger: Row[] = [
    { step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD,
      disposition: "blocked-fixable", acted: true },
    { ...identity, step: "fix.dispatch", mode: "ci-log", verdict_regime: "executed" },
    { ...identity, step: "fix.done", subtype: "success" },
  ];
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK,
    headSha: HEAD, headRefName: "run-W1-T11294-1", reviewState: "none", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
    ciFailures: [{ name: "coverage-shard (8/8)", logTail: "AssertionError: census", conclusion: "FAILURE" }],
  };
  const reads: string[][] = [];
  const writes: string[][] = [];
  const updates: number[] = [];
  const dispatched: number[] = [];
  const logs: Array<{ step: string; fields?: Row }> = [];
  let runs: unknown = { total_count: 1, workflow_runs: [{
    id: 41, head_sha: HEAD, status: "completed", conclusion: "failure", event: "pull_request",
    pull_requests: [{ number: PR, base: { sha: base } }],
  }] };
  let readError: string | undefined;
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", config: { root: "/dev/null/w1-t11294" } as Config,
    ledgerPath: "/dev/null/w1-t11294", runId: "test", log: (step, fields) => logs.push({ step, fields }),
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    issuesImpl: { create: () => "unused" }, registeredWorktreeOwnerImpl: () => undefined,
    readJsonImpl: async args => {
      reads.push(args);
      if (args[1]?.endsWith(`/pulls/${PR}`)) return { state: "open", head: { sha: HEAD } };
      assert.match(args[1]!, /actions\/runs\?head_sha=/);
      if (readError) throw new Error(readError);
      return runs;
    },
    ghRunImpl: (_file, args) => { writes.push([...args]); },
  });
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {},
    dispatchFix: view => { dispatched.push(view.prNumber); },
    readLiveState: () => ({ ok: true, state: "OPEN", headSha: HEAD }),
    readMainTip: () => main,
    readFailedRunBase: effects.readFailedRunBase,
    rerunFailedChecks: effects.rerunFailedChecks,
    updateBranch: view => {
      assert.equal(ledger.at(-1)?.no_commit_rerun_attempted, true, "claim precedes the effect");
      assert.equal(ledger.at(-1)?.no_commit_refresh_attempted, true);
      updates.push(view.prNumber);
      return "updated";
    },
    ledgerPath: "/dev/null/w1-t11294", runId: "test", now: () => NOW,
    log: (step, fields) => logs.push({ step, fields }),
    readLedger: () => ledger.map(row => ({ ...row })), appendLine: (_path, row) => { ledger.push(row); },
  };
  return {
    ledger, pr, deps, effects, reads, writes, updates, dispatched, logs,
    setRuns: (value: unknown) => { runs = value; },
    failRead: (reason: string) => { readError = reason; },
    pass: async () => {
      await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
      return ledger.findLast(row => row.step === "sweep.disposed")!;
    },
  };
}

test("test/a-no-commit-fix-on-a-moved-main-refreshes-instead-of-replaying-the-old-merge.test.ts", async () => {
  const moved = fixture();
  const receipt = await moved.pass();
  assert.deepEqual(moved.updates, [PR]);
  assert.deepEqual(moved.writes, [], "the stale merge's failed jobs are never rerun");
  assert.deepEqual(moved.dispatched, []);
  assert.equal(receipt.no_commit_refresh_attempted, true);
  assert.equal(receipt.run_base_sha, BASE);
  assert.equal(receipt.main_sha, MAIN);
  assert.equal(receipt.no_commit_refresh_outcome, "updated");
  const claim = moved.ledger.find(row => row.no_commit_refresh_attempted === true)!;
  assert.equal(claim.run_base_sha, BASE);
  assert.equal(claim.main_sha, MAIN);

  const unchanged = fixture(MAIN);
  const rerun = await unchanged.pass();
  assert.deepEqual(unchanged.updates, []);
  assert.deepEqual(unchanged.writes, [["api", "-X", "POST", "repos/acme/remudero/actions/runs/41/rerun-failed-jobs"]]);
  assert.equal(rerun.no_commit_rerun_outcome, "rerun");
  assert.notEqual(rerun.no_commit_refresh_attempted, true);
});

test("W1-T11294 criterion 2: refresh spends the same receipt and cannot rerun on a later round", async () => {
  const f = fixture();
  await f.pass();
  f.ledger.push({ step: "fix.done", task_id: TASK, head_sha: HEAD, round_id: "round-4", subtype: "success" });
  await f.pass();
  assert.deepEqual(f.updates, [PR]);
  assert.deepEqual(f.writes, []);
  const receipt = f.ledger.findLast(row => row.step === "sweep.disposed")!;
  assert.equal(receipt.no_commit_rerun_attempted, true);
  assert.equal(receipt.no_commit_rerun_round_id, "round-3");
  assert.equal(receipt.no_commit_refresh_attempted, true);
  assert.equal(receipt.run_base_sha, BASE);
  assert.equal(receipt.main_sha, MAIN);
});

test("W1-T11294 criterion 2: concurrent passes claim only one refresh", async () => {
  const f = fixture();
  let attempts = 0;
  f.deps.updateBranch = async () => { attempts++; return "updated" as const; };
  await Promise.all([f.pass(), f.pass()]);
  assert.equal(attempts, 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.ledger.filter(row => row.no_commit_refresh_outcome === "updated").length, 1);
});

test("W1-T11294 criterion 2: unreadable run bases preserve the one-shot rerun", async () => {
  for (const base of [null, "", 123]) {
    const f = fixture(base);
    const receipt = await f.pass();
    assert.deepEqual(f.updates, []);
    assert.equal(f.writes.length, 1);
    assert.equal(receipt.no_commit_rerun_outcome, "rerun");
    await f.pass();
    assert.equal(f.writes.length, 1);
  }
});

test("W1-T11294: an unavailable base reader or main tip retains the rerun", async () => {
  for (const missing of ["base", "main"] as const) {
    const f = fixture();
    if (missing === "base") f.deps.readFailedRunBase = undefined;
    else f.deps.readMainTip = () => undefined;
    await f.pass();
    assert.deepEqual(f.updates, []);
    assert.equal(f.writes.length, 1);
  }
});

test("W1-T11294: a base read failure is logged and falls back to the rerun", async () => {
  const f = fixture();
  f.deps.readFailedRunBase = async () => { throw new Error("run base unavailable"); };
  await f.pass();
  assert.deepEqual(f.updates, []);
  assert.equal(f.writes.length, 1);
  assert.ok(f.logs.some(row => String(row.fields?.error).includes("run base unavailable")));
});

test("W1-T11294: a failed refresh records its reason without rerunning", async () => {
  const f = fixture();
  f.deps.updateBranch = async () => { throw new Error("refresh transport failed"); };
  const receipt = await f.pass();
  assert.equal(receipt.no_commit_refresh_outcome, "failed");
  assert.match(String(receipt.no_commit_refresh_reason), /refresh transport failed/);
  assert.deepEqual(f.writes, []);
  await f.pass();
  assert.deepEqual(f.writes, []);
});

test("W1-T11294: a stale run waits for an update gateway without spending its receipt", async () => {
  const f = fixture();
  const update = f.deps.updateBranch;
  f.deps.updateBranch = undefined;
  const held = await f.pass();
  assert.match(String(held.stand_down_reason), /awaits a branch-update gateway/);
  assert.notEqual(held.no_commit_rerun_attempted, true);
  assert.deepEqual(f.writes, []);
  f.deps.updateBranch = update;
  f.deps.rerunFailedChecks = undefined;
  await f.pass();
  assert.deepEqual(f.updates, [PR], "refresh does not need the rerun gateway");
  assert.deepEqual(f.writes, []);
});

test("W1-T11294: the base reader uses only this PR's completed failed run at this head", async () => {
  const f = fixture();
  const run = { id: 41, head_sha: HEAD, status: "completed", conclusion: "failure", event: "pull_request" };
  f.setRuns({ workflow_runs: [
    { ...run, id: 42, conclusion: "success", pull_requests: [{ number: PR, base: { sha: MAIN } }] },
    { ...run, id: 43, status: "in_progress", pull_requests: [{ number: PR, base: { sha: MAIN } }] },
    { ...run, id: 44, head_sha: "old-head", pull_requests: [{ number: PR, base: { sha: MAIN } }] },
    { ...run, id: 45, pull_requests: [{ number: PR + 1, base: { sha: MAIN } }] },
    { ...run, pull_requests: [{ number: PR, base: { sha: BASE } }] },
  ] });
  assert.equal(await f.effects.readFailedRunBase!(f.pr), BASE);
  assert.deepEqual(f.writes, []);
  f.setRuns({ workflow_runs: [{ ...run, pull_requests: [] }] });
  assert.equal(await f.effects.readFailedRunBase!(f.pr), undefined);
  f.setRuns({ workflow_runs: [run] });
  assert.equal(await f.effects.readFailedRunBase!(f.pr), undefined);
  f.setRuns({ workflow_runs: [] });
  assert.equal(await f.effects.readFailedRunBase!(f.pr), undefined);
  f.setRuns({});
  await assert.rejects(f.effects.readFailedRunBase!(f.pr), /failed workflow runs could not be read/);
  f.failRead("run list transport failed");
  await assert.rejects(f.effects.readFailedRunBase!(f.pr), /run list transport failed/);
});
