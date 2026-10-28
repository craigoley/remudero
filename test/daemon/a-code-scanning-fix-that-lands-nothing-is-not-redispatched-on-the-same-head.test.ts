import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { codeScanningHeadSettled, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { loadDefaultPolicy } from "#src/lib/policy.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const HEAD = "2baea6d".padEnd(40, "a");
const ALERTS = [909, 910].map((alertNumber, index) => ({
  alertNumber, ruleId: "js/file-system-race", severity: "high",
  path: "src/lib/sweep.ts", line: 42 + index, message: "The file may have changed.",
}));
const PR: OpenPrView = {
  prNumber: 13317, prUrl: "https://github.com/craigoley/remudero/pull/13317",
  taskId: "W1-T10086", headRefName: "run-W1-T10086-1792623961310", headSha: HEAD,
  reviewState: "success", checksState: "green", autoMergeArmed: false,
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
  codeqlHeadAlerts: { headSha: HEAD, alerts: ALERTS },
};

function fixture(t: TestContext, outcome?: string, ageMs = 1000) {
  const now = Date.now();
  const intent = { step: "code_scanning.fix_dispatch", pr_number: PR.prNumber, pr_url: PR.prUrl,
    task_id: PR.taskId, run_id: "old", head_sha: HEAD, alert_numbers: [910, 909],
    dispatched: false, phase: "preparing", ts: new Date(now - ageMs).toISOString() };
  const ledger = writeLedger([intent, ...(outcome ? [{ step: "fix.dispatch", task_id: PR.taskId,
    run_id: "old", head_sha: HEAD, mode: "ci-log", ts: new Date(now - ageMs).toISOString() },
    { step: outcome, task_id: PR.taskId,
    run_id: "old", head_sha: HEAD, reason: "no anchored COMMIT_MESSAGE line in the report",
    ts: new Date(now - ageMs + 1).toISOString() }] : [])], { scope: t });
  const calls = { judged: 0, dispatched: 0, armed: 0, escalated: [] as string[] };
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "new", now: () => now,
    arm: () => { calls.armed++; }, close: () => {},
    dispatchFix: () => { calls.dispatched++; },
    judgeCodeScanningAlerts: async () => { calls.judged++; return { ruling: "fix", reason: "real race" }; },
    escalate: (_pr, reason) => { calls.escalated.push(reason); },
  };
  return { ledger, deps, calls, intent, rows: () => readLedgerLines(ledger.path) };
}

test("W1-T10386: an empty code-scanning round escalates once instead of re-dispatching", async t => {
  for (const outcome of ["fix.commit_refused", "fix.refused", "fix.done"]) {
    const f = fixture(t, outcome);
    if (outcome === "fix.commit_refused") f.ledger.append([{ step: "fix.done", task_id: PR.taskId,
      run_id: "old", head_sha: HEAD, subtype: "unchanged" }]);
    await runSweep([PR], f.deps);
    await runSweep([PR], f.deps);
    assert.equal(f.calls.dispatched, 0, "an empty round cannot be dispatched again");
    assert.equal(f.calls.escalated.length, 1, outcome);
    assert.equal(f.calls.judged, 0);
    assert.equal(f.calls.armed, 0);
    assert.match(f.calls.escalated[0], new RegExp(outcome.replaceAll(".", "\\.")));
    assert.ok(f.calls.escalated[0].includes(HEAD));
    for (const alert of ALERTS) {
      assert.ok(f.calls.escalated[0].includes(`#${alert.alertNumber}`));
      assert.ok(f.calls.escalated[0].includes(`${alert.path}:${alert.line}`));
      assert.ok(f.calls.escalated[0].includes(alert.ruleId));
    }
    const escalation = f.rows().filter(row => row.step === "code_scanning.fix_dispatch" && row.escalated === true);
    assert.equal(escalation.length, 1);
    assert.deepEqual(escalation[0].alert_numbers, [909, 910]);
  }
});

test("an abandoned code-scanning dispatch counts as empty only after the existing fix bound", async t => {
  const bound = loadDefaultPolicy().values.fixSpawnWallClockBoundMs;
  for (const age of [bound - 1, bound, bound + 1]) {
    const f = fixture(t, undefined, age);
    await runSweep([PR], f.deps);
    await runSweep([PR], f.deps);
    assert.equal(f.calls.escalated.length, age >= bound ? 1 : 0, `age ${age}`);
    assert.equal(f.calls.dispatched, 0);
    assert.equal(f.calls.judged, 0);
    assert.equal(f.calls.armed, 0);
  }
});

test("W1-T10386: a new head re-arms the code-scanning fix path", async t => {
  for (const changed of ["head", "alerts"]) {
    const f = fixture(t, "fix.commit_refused");
    await runSweep([PR], f.deps);
    assert.equal(f.calls.escalated.length, 1);
    assert.equal(codeScanningHeadSettled(f.rows(), PR.prNumber, HEAD), false,
      "hydration must keep reading alerts so a changed set can re-arm the path");
    const headSha = changed === "head" ? "b".repeat(40) : HEAD;
    const alerts = changed === "alerts" ? [{ ...ALERTS[0], alertNumber: 911 }] : ALERTS;
    await runSweep([{ ...PR, headSha, codeqlHeadAlerts: { headSha, alerts } }], f.deps);
    assert.equal(f.calls.judged, 1, changed);
    assert.equal(f.calls.dispatched, 1, changed);
    assert.equal(f.calls.escalated.length, 1, changed);
    assert.equal(f.calls.armed, 0);
  }
});

test("unrelated fix outcomes and a pushed head do not exhaust a code-scanning round", async t => {
  for (const over of [{ task_id: "W1-T999" }, { head_sha: "b".repeat(40) },
    { pr_number: 999 }, { pushed_head_sha: "b".repeat(40) }]) {
    const f = fixture(t);
    f.ledger.append([{ step: "fix.done", task_id: PR.taskId, run_id: "old", head_sha: HEAD, ...over }]);
    await runSweep([PR], f.deps);
    assert.equal(f.calls.escalated.length, 0, JSON.stringify(over));
    assert.equal(f.calls.dispatched, 0);
    assert.equal(f.calls.armed, 0);
  }
});

test("a stale preparation without a worker is empty while fresh preparation progress still holds", async t => {
  const bound = loadDefaultPolicy().values.fixSpawnWallClockBoundMs;
  for (const recent of [false, true]) {
    const f = fixture(t, undefined, bound + 1000);
    f.ledger.append([{ step: "fix.base_refresh_checked", task_id: PR.taskId, run_id: "old", head_sha: HEAD,
      ts: recent ? new Date(f.deps.now!() - 1).toISOString() : f.intent.ts }]);
    await runSweep([PR], f.deps);
    assert.equal(f.calls.escalated.length, recent ? 0 : 1);
    assert.equal(f.calls.dispatched, 0);
    assert.equal(f.calls.armed, 0);
  }
});

test("the code-scanning escalation names each historical empty round's outcome", async t => {
  const f = fixture(t, "fix.commit_refused");
  f.ledger.append([{ ...f.intent, run_id: "second" },
    { step: "fix.refused", task_id: PR.taskId, run_id: "second", head_sha: HEAD, reason: "no block evidence" }]);
  await runSweep([PR], f.deps);
  await runSweep([PR], f.deps);
  assert.equal(f.calls.escalated.length, 1);
  assert.match(f.calls.escalated[0], /fix\.commit_refused: no anchored COMMIT_MESSAGE/);
  assert.match(f.calls.escalated[0], /fix\.refused: no block evidence/);
  assert.equal(f.calls.dispatched, 0);
  assert.equal(f.calls.judged, 0);
  assert.equal(f.calls.armed, 0);
});

test("the code-scanning round bound accepts the fix lane's injected timeout", async t => {
  const f = fixture(t, undefined, 1000);
  f.deps.codeScanningRoundBoundMs = 500;
  await runSweep([PR], f.deps);
  assert.equal(f.calls.escalated.length, 1);
  assert.equal(f.calls.dispatched, 0);
  assert.equal(f.calls.armed, 0);
});
