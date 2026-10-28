import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import {
  CHECKPOINT_HANDOFF_REASONS, handoffReceiptsToCarry, pendingWorkerBoundaryHandoffs,
  runBranchDispatchOpts, runBranchStateFrom, runDaemon, type DaemonDeps,
} from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import {
  TASK as ORPHAN_TASK, RUN_ID, BRANCH as ORPHAN_BRANCH, HEAD as ORPHAN_HEAD,
  MINT_ISO, DEAD_PID, LOCAL, anchorMessage, orphanRunRows, fakeReserver, instance, gitRemote, orphanVerdicts,
} from "#test/helpers/restart-orphan.js";

const TASK = "W1-T8133";
const BRANCH = `run-${TASK}-1791807256528`;
const HEAD = "a".repeat(40);
const checkpoint = { branch: BRANCH, headSha: HEAD };
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));
const quiet = (extra: Record<string, unknown> = {}) => ({
  task_id: TASK, run_id: "quiet-round", step: "verdict", verdict: "handed_off",
  reason: "quiet_worker_round_ended", branch: BRANCH, head_sha: HEAD, ...extra,
});

test("W1-T8133: a quiet round end verdict is a resumable receipt", () => {
  const row = quiet();
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([row])).get(TASK), checkpoint);
  assert.equal(row.reason, "quiet_worker_round_ended");
  assert.deepEqual(handoffReceiptsToCarry(lines([row])), [[TASK, checkpoint]],
    "a verdict-only quiet receipt must survive verdict retention");
  assert.deepEqual(handoffReceiptsToCarry(lines([row, {
    task_id: TASK, step: "run.freshness_handoff", branch: BRANCH, head_sha: HEAD, carried: true,
  }])), [], "an already carried receipt needs no duplicate");

  for (const invalid of [
    { branch: "main" }, { branch: "run-W1-T99-123" }, { branch: `run-${TASK}-bad` },
    { branch: null }, { head_sha: "abc" }, { head_sha: null }, { head_sha: "g".repeat(40) },
    { pr_url: "https://github.com/example/repo/pull/1" }, { verdict: "failed" }, { reason: "another_handoff" },
  ]) {
    assert.equal(pendingWorkerBoundaryHandoffs(lines([quiet(invalid)])).size, 0, JSON.stringify(invalid));
  }
});

test("W1-T8133: a quiet round end replaces an earlier receipt instead of erasing it", () => {
  for (const earlier of [
    { step: "verdict", verdict: "handed_off", reason: "freshness_yield" },
    { step: "run.freshness_handoff", waiting_on: "worker_round" },
  ]) {
    const prior = { task_id: TASK, branch: `run-${TASK}-1`, head_sha: "b".repeat(40), ...earlier };
    assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([prior])).get(TASK),
      { branch: prior.branch, headSha: prior.head_sha }, "control: the older receipt is pending");
    const history = lines([prior, quiet()]);
    assert.deepEqual(pendingWorkerBoundaryHandoffs(history).get(TASK), checkpoint);
    assert.deepEqual(handoffReceiptsToCarry(history), [[TASK, checkpoint]]);
  }
});

test("W1-T8133: a later verdict still consumes a quiet receipt", () => {
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([quiet()])).get(TASK), checkpoint);
  for (const verdict of ["merged", "failed", "no_pr"]) {
    const history = lines([quiet(), { task_id: TASK, step: "verdict", verdict }]);
    assert.equal(pendingWorkerBoundaryHandoffs(history).has(TASK), false, verdict);
    assert.deepEqual(handoffReceiptsToCarry(history), []);
  }
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines([
    quiet(), { task_id: "W1-T99", step: "verdict", verdict: "merged" },
  ])).get(TASK), checkpoint, "another task's verdict cannot consume the quiet receipt");
});

test("W1-T8133: a mid-session quiet handoff is resumable on the next tick", async () => {
  const plan = loadPlanFromYaml(`- id: ${TASK}
  title: quiet checkpoint fixture
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  files: [src/quiet-fixture.ts]
`, "fixture");
  const ledger: Record<string, unknown>[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let branches = "";
  let started = 0;
  let checks = 0;
  let merged = false;
  let resumed: { branch: string; headSha: string } | undefined;
  await runDaemon(plan, {
    refreshMerged: () => () => merged,
    readLedgerLines: () => lines(ledger),
    readPushedRunBranches: () => branches,
    checkStop: () => started >= 2 || ++checks > 60 ? "fixture done" : undefined,
    log: (step, extra) => {
      rows.push({ step, extra });
      ledger.push({ ts: new Date().toISOString(), step, ...extra });
    },
    runOne: async () => {
      started++;
      if (started === 1) {
        branches = `${HEAD}\trefs/heads/${BRANCH}\n`;
        ledger.push({ ts: new Date().toISOString(), ...quiet() });
        return { taskId: TASK, runId: "quiet-round", merged: false, verdict: "handed_off", costUsd: 0 } as RunResult;
      }
      resumed = pendingWorkerBoundaryHandoffs(lines(ledger)).get(TASK);
      merged = true;
      return { taskId: TASK, runId: "resumed-round", merged: true, verdict: "merged", costUsd: 0 } as RunResult;
    },
    sleep: async () => { await flush(); },
  } as DaemonDeps, { laneCount: 1, max: 60 });
  assert.equal(started, 2, "the same daemon dispatches the checkpoint on its next pass");
  assert.deepEqual(resumed, checkpoint);
  assert.deepEqual(rows.filter(({ step, extra }) =>
    step === "dispatch.skipped" && extra?.reason === "run-branch-already-pushed"), []);
  assert.equal(rows.find(({ step, extra }) =>
    step === "daemon.iteration" && extra?.resumes_handoff === BRANCH)?.extra?.task, TASK);
});

test("W1-T10896: the daemon resumes only the exact orphaned head", (t) => {
  // The claim and the pushed branch live on a real remote, read through the git reserver the daemon uses.
  const origin = gitRemote(t);
  const resumed = `${origin.head}\trefs/heads/${ORPHAN_BRANCH}\n`;
  const blocked = (lines: readonly string[]) =>
    runBranchDispatchOpts(runBranchStateFrom(resumed, undefined, pendingWorkerBoundaryHandoffs(lines)), [], () => {})
      .hasPushedRunBranch!(ORPHAN_TASK);
  const node = instance(t, orphanRunRows());
  assert.equal(blocked(node.rawLines()), true, "before the boot sweep the pushed branch blocks dispatch");

  node.boot(origin.reserver);
  assert.equal(origin.claimTip(), "", "the dead claim is dropped from origin");
  const verdict = orphanVerdicts(node.rows())[0]!;
  assert.equal(CHECKPOINT_HANDOFF_REASONS.has(String(verdict.reason)), true, "its reason is a checkpoint handoff reason");
  assert.equal(verdict.branch, ORPHAN_BRANCH);
  assert.equal(verdict.head_sha, origin.head, "the receipt names origin's exact pushed head");
  assert.equal(blocked(node.rawLines()), false, "the exact pushed head is a resumable checkpoint");
  const pending = pendingWorkerBoundaryHandoffs(node.rawLines());
  assert.deepEqual(pending.get(ORPHAN_TASK), { branch: ORPHAN_BRANCH, headSha: origin.head });
  // A re-push moves the tip off the receipt, so that head blocks again.
  const moved = `${"f".repeat(40)}\trefs/heads/${ORPHAN_BRANCH}\n`;
  assert.equal(runBranchDispatchOpts(runBranchStateFrom(moved, undefined, pending), [], () => {}).hasPushedRunBranch!(ORPHAN_TASK), true);
});

test("W1-T10896: a run that already opened its PR gets the verdict without a resume receipt", (t) => {
  const prUrl = "https://github.com/o/r/pull/1";
  const seed = [...orphanRunRows(), { ts: "2000-01-01T00:40:00.000Z", run_id: RUN_ID, task_id: ORPHAN_TASK, step: "pr.opened", pr_url: prUrl }];
  const node = instance(t, seed);
  const reserver = fakeReserver({ [ORPHAN_TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) }, { heads: { [ORPHAN_BRANCH]: ORPHAN_HEAD } });
  node.boot(reserver);
  const verdict = orphanVerdicts(node.rows())[0]!;
  assert.equal(verdict.pr_url, prUrl);
  assert.equal(verdict.head_sha, undefined);
  assert.deepEqual(reserver.askedHeads, [], "a run with its own PR is not resumed from its branch");
  assert.equal(pendingWorkerBoundaryHandoffs(node.rawLines()).get(ORPHAN_TASK), undefined);
});

