import assert from "node:assert/strict";
import { test } from "node:test";
import {
  refreshStaleRollupAfterRefusal, runSweep, STALE_ROLLUP_REFRESHED_STEP,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const pr = (overrides: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 10741, prUrl: "https://github.com/o/r/pull/10741", taskId: "W1-T10741",
  headSha: HEAD, autoMergeArmed: true, checksState: "green", reviewState: "success",
  mergeable: true, mergeableState: "blocked", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date().toISOString(), ...overrides,
});

test("W1-T10741: fix-lane-armed-idle-armed-idle-merge-review-success-required-checks-green-arm clears without a person", async () => {
  const rows: Record<string, unknown>[] = [];
  const review = (head: string) => rows.push({
    step: "review.posted", run_id: "review", task_id: "W1-T10741", head_sha: head,
    state: "success", capped: false, plan_only: false, proof_exec: ["executed_pass"],
  });
  review(HEAD);
  let refreshes = 0;
  let escalations = 0;
  const arms: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/idle-retry", runId: "idle-retry", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); },
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    arm: (view, mode) => {
      assert.equal(mode, "armed-idle");
      arms.push(view.headSha);
      return view.headSha === NEXT ? "direct-merged"
        : { outcome: "direct-merge-failed", error: "HTTP 405: Pull Request is not mergeable" };
    },
    updateBranch: () => {
      refreshes++;
      if (refreshes === 1) return "error"; // updateBranchViaGh catches transport failures.
      return "updated";
    },
    close: () => assert.fail("no close"), dispatchFix: () => assert.fail("no fix worker"),
    escalate: () => { escalations++; },
  };
  await runSweep([pr()], deps);
  await runSweep([pr()], deps);
  assert.equal(refreshes, 1);
  await runSweep([pr()], deps);
  assert.equal(refreshes, 2, "retry the refresh that never produced a head");
  assert.deepEqual(rows.filter(row => row.step === STALE_ROLLUP_REFRESHED_STEP)
    .map(row => row.outcome), ["error", "updated"]);
  await runSweep([pr({ headSha: NEXT, checksState: "pending", reviewState: "pending" })], deps);
  assert.deepEqual(arms, [HEAD, HEAD], "fresh head must earn checks and review");
  review(NEXT);
  await runSweep([pr({ headSha: NEXT })], deps);
  const completed = await runSweep([pr({ headSha: NEXT })], deps);
  assert.equal(completed.actionsTaken, 1);
  assert.equal(refreshes, 2);
  assert.equal(escalations, 0, "a transient refresh failure needs no person");
  assert.equal(rows.findLast(row => row.step === "automerge.armed_idle_merged")?.head_sha, NEXT);
});

for (const outcome of ["updated", "head-moved", "repushed", "conflict", "error: permission denied"] as const) {
  test(`an idle refresh outcome of ${outcome} still consumes its allowance across heads`, async () => {
    const rows: Record<string, unknown>[] = [{
      step: STALE_ROLLUP_REFRESHED_STEP, pr_number: 10741, head_sha: HEAD, outcome,
    }];
    let escalations = 0;
    const result = await refreshStaleRollupAfterRefusal({
      ledgerPath: "/unused/idle-retry", runId: "bound", updateBranch: () => assert.fail("no second refresh"),
      escalate: () => { escalations++; }, appendLine: (_path, row) => { rows.push(row); },
    }, pr({ headSha: NEXT }), rows);
    assert.equal(escalations, 1);
    assert.match(result, /still refused after its one stale-rollup refresh/);
  });
}

test("a second ambiguous idle refresh error exhausts the bounded retry", async () => {
  const rows: Record<string, unknown>[] = [{
    step: STALE_ROLLUP_REFRESHED_STEP, pr_number: 10741, head_sha: HEAD, outcome: "error",
  }, {
    step: STALE_ROLLUP_REFRESHED_STEP, pr_number: 10741, head_sha: HEAD, outcome: "error",
  }];
  let escalations = 0;
  const result = await refreshStaleRollupAfterRefusal({
    ledgerPath: "/unused/idle-retry", runId: "bounded-errors", updateBranch: () => assert.fail("no third refresh"),
    escalate: () => { escalations++; }, appendLine: (_path, row) => { rows.push(row); },
  }, pr(), rows);
  assert.equal(escalations, 1);
  assert.match(result, /still refused after its one stale-rollup refresh/);
});
