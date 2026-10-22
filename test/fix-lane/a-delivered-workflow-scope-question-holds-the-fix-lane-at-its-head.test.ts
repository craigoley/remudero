import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeEscalationStandDown } from "#src/lib/fix-progress-judge.js";
import { CONTRACT_AMENDED_REFRESH_STEP, DEFAULT_SWEEP_POLICY, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps,
  type UpdateBranchOutcome } from "#src/lib/sweep.js";

// #13317 (W1-T10086), 2026-10-21: round 2 at 8c5222b and round 3 at 71e7cc7 each ended NEEDS_SCOPE on
// .github/workflows/acr-build.yml, escalated (`workflow-escalated`) and stood down; the next pass dispatched
// another paid round at the same head, which asked the same question again.
const PR = 13317;
const TASK = "W1-T10086";
const HEAD = "71e7cc7bfa2ec1a81c7f7bbb87d66487012ef52b";
const ISSUE = "https://github.com/acme/remudero/issues/2";
const PATHS = [".github/workflows/acr-build.yml", "deploy/install-host-units.sh"];
const escalated = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: TASK, step: "fix.scope_amendment", pr_number: PR, head_sha: HEAD,
  outcome: "workflow-escalated", paths: PATHS, issue_url: ISSUE, ...extra,
});
const view = (extra: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK, headSha: HEAD,
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 1,
  autoMergeArmed: false, lastActivityAt: new Date().toISOString(), redRequiredChecks: ["coverage-shard (7/8)"],
  ciFailures: [{ name: "coverage-shard (7/8)", logTail: "not ok 2 - W1-T6282: a daemon tree behind on deploy logic still defers" }],
  ...extra,
});
function fixture(initial: Record<string, unknown>[]) {
  const rows = [...initial];
  const calls = { judges: 0, fixes: 0, escalations: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/workflow-scope-hold", runId: "workflow-scope-hold", now: () => Date.now(),
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => { calls.judges++; return { verdict: "continue", reason: "fixture permits another round" }; },
    dispatchFix: () => { calls.fixes++; }, escalate: () => { calls.escalations++; },
    arm: () => {}, close: () => {},
  };
  return { rows, calls, deps };
}

test("a delivered workflow-scope question holds a filed task's fix lane at its head", async () => {
  for (const pass of [runSweep, runSweepLightPass]) {
    const f = fixture([escalated()]);
    await pass([view()], f.deps, DEFAULT_SWEEP_POLICY);
    await pass([view()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(f.calls, { judges: 0, fixes: 0, escalations: 0 }, pass.name);
    const disposed = f.rows.filter(r => r.step === "sweep.disposed");
    assert.ok(disposed.length >= 2, "positive control: both passes disposed the real PR");
    assert.ok(disposed.every(r => r.acted === false));
    assert.ok(disposed.some(r => String(r.stand_down_reason).startsWith(`workflow scope decision awaits resolution at this head — ${ISSUE}`)),
      "the open question stays visible on every pass");
  }
});

test("a workflow-scope hold releases on a new head and never leaks to another PR or an undelivered question", async () => {
  for (const [extra, row] of [[{ headSha: "a-new-head" }, {}], [{ prNumber: PR + 1 }, {}],
    [{}, { outcome: "workflow-escalation-failed" }], [{}, { issue_url: "" }], [{}, { paths: [] }]] as const) {
    const f = fixture([escalated(row)]);
    await runSweep([view(extra)], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(f.calls.judges > 0, JSON.stringify({ extra, row, calls: f.calls }));
    assert.ok(f.calls.fixes > 0, "positive control: a released candidate dispatches");
  }
});

test("a filed task's unfiled-scope row still never holds it, and the unfiled hold keeps its own wording", () => {
  assert.equal(scopeEscalationStandDown([escalated({ outcome: "unfiled-escalated" })], { taskId: TASK, prNumber: PR, headSha: HEAD }), undefined);
  assert.match(scopeEscalationStandDown([escalated({ outcome: "unfiled-escalated" })], { taskId: "unfiled", prNumber: PR, headSha: HEAD })?.reason ?? "",
    /^unfiled scope decision awaits resolution at this head/);
  assert.match(scopeEscalationStandDown([escalated()], { prNumber: PR, headSha: HEAD })?.reason ?? "", /^workflow scope decision/);
});

test("a revise-pr answer that amends the task contract takes main into a workflow-held branch once", async () => {
  // The operator's revise-pr answer on #13332 merged a files: amendment (#13358); the fix rung reads the contract at
  // the head, so only main taken into the branch lets the next round see it. The hold must not block that refresh.
  // An instrument hold (#13368) is the same operator-only grant, so it releases the same way.
  for (const outcome of ["workflow-escalated", "instrument-escalated"]) {
    const state = { revision: "contract-A", refreshed: 0 };
    const f = fixture([escalated({ contract_revision: "contract-A", outcome })]);
    const deps: SweepDeps = { ...f.deps, readTaskContractRevision: (taskId) => (taskId === TASK ? state.revision : undefined),
      updateBranch: async (): Promise<UpdateBranchOutcome> => { state.refreshed++; return "updated"; } };
    await runSweep([view()], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(state.refreshed, 0, "an unchanged contract is still a hold");
    state.revision = "contract-B";
    await runSweep([view()], deps, DEFAULT_SWEEP_POLICY);
    await runSweep([view()], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(state.refreshed, 1, "the amended contract takes main into the branch exactly once");
    assert.deepEqual({ judges: f.calls.judges, fixes: f.calls.fixes }, { judges: 0, fixes: 0 });
    const refresh = f.rows.filter(r => r.step === CONTRACT_AMENDED_REFRESH_STEP);
    assert.deepEqual(refresh.map(r => [r.escalated_under, r.contract_revision, r.outcome]), [["contract-A", "contract-B", "updated"]]);
    const disposed = f.rows.filter(r => r.step === "sweep.disposed");
    assert.ok(disposed.some(r => String(r.stand_down_reason).startsWith("task contract amended since this head was escalated — took main")));
  }
});
