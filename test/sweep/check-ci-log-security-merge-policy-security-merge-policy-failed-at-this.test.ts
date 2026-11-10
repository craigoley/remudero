import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runSweep, securityRecoveryDisposition, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

const HEAD = "9f1c2d3e4a5b6c7d8e9f00112233445566778899";
const URL = "https://github.com/craigoley/remudero/pull/17217";
const CONTEXT = "security-merge-policy";

function fixture(t: TestContext, overrides: Partial<OpenPrView> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-security-recovery-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  const pr: OpenPrView = { prNumber: 17217, prUrl: URL, taskId: "W1-T10976", headSha: HEAD,
    headRefName: "run-W1-T10976-123", checksState: "red", reviewState: "success", unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(), redRequiredChecks: [CONTEXT],
    ciFailures: [{ name: CONTEXT, logTail: "security-merge-policy failed at this head" }],
    securityMergePolicy: { state: "unknown", reason: "codeql-configuration-recovery-exhausted" }, ...overrides };
  const dispatched: OpenPrView[] = [];
  const escalated: Array<{ pr: OpenPrView; reason: string }> = [];
  let failEscalation = false;
  const deps: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "security-recovery-test", now: () => now,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    dispatchFix: view => { dispatched.push(view); return true; },
    arm: () => assert.fail("a red PR must not arm"), close: () => assert.fail("no close is due"),
    escalate: (view, reason) => {
      if (failEscalation) throw new Error("issue gateway unavailable");
      escalated.push({ pr: view, reason });
    },
  };
  return { rows, pr, deps, dispatched, escalated, failEscalation: () => { failEscalation = true; },
    pass: (view = pr) => runSweep([view], deps) };
}

test("an exhausted missing-configuration recovery is escalated once to its owner with no generic fix round", async t => {
  const f = fixture(t);
  assert.deepEqual(securityRecoveryDisposition(f.pr),
    { reason: "codeql-configuration-recovery-exhausted", owner: "W1-T10976", evidence: URL });
  const first = await f.pass();
  assert.equal(first.actions[0]!.disposition, "blocked-ambiguous");
  assert.match(first.actions[0]!.reason, /codeql-configuration-recovery-exhausted/);
  assert.match(first.actions[0]!.reason, /W1-T10976/);
  assert.equal(f.escalated.length, 1, "one durable escalation for the head");
  await f.pass();
  await f.pass();
  assert.equal(f.dispatched.length, 0, "two more sweep passes dispatch no generic security fix round");
  assert.equal(f.escalated.length, 1, "repeated sweeps reuse the disposition");
  const disposed = f.rows.filter(row => row.step === "sweep.disposed");
  assert.ok(disposed.length >= 3);
  assert.ok(disposed.every(row => row.blocker === "security-unknown-hold" && row.blocker_owner === "security-policy"));
  assert.equal(f.rows.some(row => row.step === "fix.strike" || row.step === "fix.dispatched"), false, "no strike is consumed");
});

test("a PR with no task is owned by the security-policy owner", async t => {
  const f = fixture(t, { taskId: undefined, headRefName: "feature/x" });
  assert.equal(securityRecoveryDisposition(f.pr)?.owner, "security-policy");
});

test("invalid evidence and an unrecognized warning take the same owner disposition", async t => {
  for (const reason of ["codeql-configuration-recovery-invalid-evidence", "codeql-configuration-recovery-unrecognized-warning"]) {
    const f = fixture(t, { securityMergePolicy: { state: "unknown", reason } });
    const result = await f.pass();
    assert.equal(result.actions[0]!.disposition, "blocked-ambiguous", reason);
    assert.equal(f.dispatched.length, 0, reason);
  }
});

test("real alerts, other reds and unrelated unknown reasons keep their ordinary repair route", async t => {
  const alert = { alertNumber: 9, ruleId: "js/sql-injection", path: "src/a.ts", line: 3 };
  const routes: Array<[string, Partial<OpenPrView>]> = [
    ["blocked verdict", { securityMergePolicy: { state: "blocked", reason: "new-high-or-critical-security-alert" } }],
    ["unrelated unknown reason", { securityMergePolicy: { state: "unknown", reason: "security-analysis-failed-or-unrecognized" } }],
    ["concurrent genuine alert", { codeqlHeadAlerts: { headSha: HEAD, alerts: [alert] } as OpenPrView["codeqlHeadAlerts"] }],
    ["another red check", { redRequiredChecks: [CONTEXT, "unit"], ciFailures: [{ name: CONTEXT, logTail: "x" }, { name: "unit", logTail: "boom" }] }],
    ["status not parsed", { securityMergePolicy: undefined }],
  ];
  for (const [label, patch] of routes) {
    const f = fixture(t, patch);
    assert.equal(securityRecoveryDisposition(f.pr), undefined, label);
    const result = await f.pass();
    assert.equal(result.actions[0]!.disposition, "blocked-fixable", label);
    assert.equal(f.dispatched.length, 1, label);
  }
});

test("a disposition that cannot be recorded stays actionable and visible, never handled", async t => {
  const f = fixture(t);
  f.failEscalation();
  const first = await f.pass();
  assert.equal(first.actions[0]!.acted, false);
  assert.match(String(first.actions[0]!.actionError), /issue gateway unavailable/);
  assert.equal(f.dispatched.length, 0, "a failed write does not fall back to a generic fix round");
  await f.pass();
  assert.equal(f.escalated.length, 0);
  assert.ok(f.rows.filter(row => row.step === "sweep.disposed").every(row => row.acted !== true), "no row claims it was handled");
});
