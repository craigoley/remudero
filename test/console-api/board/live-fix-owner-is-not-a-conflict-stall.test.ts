import assert from "node:assert/strict";
import { test } from "node:test";
import { detachSweepAction, drainDetachedSweepActions, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const now = Date.UTC(2026, 9, 23, 23, 37);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const pr: OpenPrView = {
  prNumber: 13834, prUrl: "https://github.com/craigoley/remudero/pull/13834", taskId: "unfiled",
  headSha: "4035557b", headRefName: "run-unfiled-1", reviewState: "success", checksState: "green",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false, mergeState: "dirty",
};
function fixture() {
  const ledger = writeLedger([
    { ts: ago(36), run_id: "current", task_id: "unfiled", step: "sweep.disposed", pr_number: pr.prNumber,
      head_sha: pr.headSha, disposition: "conflicted", acted: false, blocker: "conflict", blocker_since: ago(36) },
    { ts: ago(13), run_id: "current", task_id: "unfiled", step: "sweep.disposed", pr_number: pr.prNumber,
      head_sha: pr.headSha, disposition: "conflicted", acted: true, blocker: "conflict", blocker_since: ago(36) },
    { ts: ago(2), run_id: "current", task_id: "PR-13834", step: "fix.routing_decision", strike: 1 },
  ]);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "current", now: () => now, actionable: () => false,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  return { ledger, deps, escalations, stuck: () => readLedgerLines(ledger.path).filter(r => r.step === "pr.stuck") };
}
for (const phase of ["admission", "worker"] as const) {
  test(`a live ${phase} fix owner prevents a false conflict stall after preparation rows`, async () => {
    const f = fixture();
    let finish!: () => void;
    detachSweepAction(new Promise<void>(resolve => { finish = resolve; }), {
      actionKind: "fix-dispatch", taskId: "PR-13834", fixKey: `PR-13834@${pr.headSha}`, phase, startedAtMs: now,
    });
    try {
      await runSweep([pr], f.deps);
      assert.equal(f.stuck().length, 0);
      assert.equal(f.escalations.length, 0);
    } finally { finish(); await drainDetachedSweepActions(); }
    await runSweep([pr], f.deps);
    assert.equal(f.stuck().length, 1, "settlement restores the unchanged stall backstop");
    assert.equal(f.escalations.length, 1);
  });
}
for (const [label, key, phase] of [
  ["another head", "PR-13834@different", "worker"],
  ["another PR", `PR-13835@${pr.headSha}`, "worker"],
  ["CI wait", `PR-13834@${pr.headSha}`, "ci-wait"],
] as const) {
  test(`the ${label} registry entry does not silence a conflict stall`, async () => {
    const f = fixture();
    let finish!: () => void;
    detachSweepAction(new Promise<void>(resolve => { finish = resolve; }), {
      actionKind: "fix-dispatch", taskId: "PR-13834", fixKey: key, phase, startedAtMs: now,
    });
    try {
      await runSweep([pr], f.deps);
      assert.equal(f.stuck().length, 1);
      assert.equal(f.escalations.length, 1);
    } finally { finish(); await drainDetachedSweepActions(); }
  });
}
