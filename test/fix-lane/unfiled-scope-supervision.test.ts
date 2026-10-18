import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import { DEFAULT_SWEEP_POLICY, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

const PR = 12703;
const HEAD = "8da9f6470e2c9195afb101f123696e3fad7d5f6d";
const ISSUE = "https://github.com/acme/remudero/issues/1";
const scope = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: `PR-${PR}`, step: "fix.scope_amendment", pr_number: PR, head_sha: HEAD,
  outcome: "unfiled-escalated", paths: ["scripts/mutation-relevant-paths.json"], issue_url: ISSUE, ...extra,
});
const view = (extra: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "unfiled", headSha: HEAD,
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
  autoMergeArmed: false, lastActivityAt: new Date().toISOString(), redRequiredChecks: ["ci-shard (6/8)"],
  ciFailures: [{ name: "ci-shard (6/8)", logTail: "not ok 1 - the mutation registry is incomplete" }], ...extra,
});
function fixture(initial: Record<string, unknown>[]) {
  const rows = [...initial];
  const calls = { judges: 0, fixes: 0, escalations: 0, arms: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/unfiled-scope-supervision", runId: "scope-supervision", now: () => Date.now(),
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => { calls.judges++; return { verdict: "continue", reason: "fixture permits another round" }; },
    dispatchFix: () => { calls.fixes++; }, escalate: () => { calls.escalations++; },
    arm: () => { calls.arms++; }, close: () => {},
  };
  return { rows, calls, deps };
}

test("an unfiled scope escalation is not an open amendment PR in progress evidence", () => {
  for (const outcome of ["unfiled-escalated", "unfiled-escalation-failed", "unfiled-own-diff", "future-outcome"]) {
    const result = buildFixProgressInput({ taskId: `PR-${PR}`, prNumber: PR, headSha: HEAD, currentRed: ["ci-shard (6/8)"], ledger: [
      { task_id: `PR-${PR}`, pr_number: PR, head_sha: HEAD, step: "fix.dispatch", round_id: "r1" },
      scope({ outcome }),
      { task_id: `PR-${PR}`, pr_number: PR, head_sha: HEAD, step: "fix.done", round_id: "r1" },
    ] });
    assert.equal(result.rounds[0]?.scopeAmendment, undefined, outcome);
    assert.equal(result.signals.scopeAmendmentsPending, undefined, outcome);
    assert.equal(result.signals.noOpRounds, 1, "a delivered question did not produce a code diff or amendment");
  }
});

test("an unresolved unfiled scope decision spends no automatic judge or fix round at the same head", async () => {
  for (const pass of [runSweep, runSweepLightPass]) {
    const f = fixture([scope()]);
    await pass([view()], f.deps, DEFAULT_SWEEP_POLICY);
    await pass([view()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(f.calls, { judges: 0, fixes: 0, escalations: 0, arms: 0 });
    const disposed = f.rows.filter(r => r.step === "sweep.disposed");
    assert.ok(disposed.length >= 2, "positive control: both passes disposed the real PR");
    assert.ok(disposed.every(r => r.acted === false));
    assert.ok(disposed.some(r => String(r.stand_down_reason).includes(ISSUE)), "the existing owner question remains visible");
  }
});

test("an unfiled scope hold releases on a new head or a genuine filed identity and never leaks to another PR", async () => {
  for (const extra of [{ headSha: "a-new-head" }, { prNumber: PR + 1 }, { taskId: "W1-T9001" }]) {
    const f = fixture([scope()]);
    await runSweep([view(extra)], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(f.calls.judges > 0, JSON.stringify({ extra, calls: f.calls }));
    assert.ok(f.calls.fixes > 0, "positive control: a genuinely released candidate can dispatch");
  }
});

test("an undelivered or malformed unfiled escalation does not silently park the queue", async () => {
  for (const extra of [{ outcome: "unfiled-escalation-failed" }, { issue_url: "" }, { paths: [] }]) {
    const f = fixture([scope(extra)]);
    await runSweep([view()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(f.calls.judges > 0);
    assert.ok(f.calls.fixes > 0);
  }
});

test("a scope question never prevents an already green unfiled PR from normal auto-merge arming", async () => {
  const f = fixture([scope()]);
  await runSweep([view({ checksState: "green", reviewState: "success", priorStrikes: 0,
    redRequiredChecks: [], ciFailures: [] })], f.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(f.calls.arms, 1);
  assert.equal(f.calls.fixes, 0);
});
