// W1-T9633 (2026-10-15): #11936 and #11910 sat green and reviewed for 2+ hours while every sweep row
// read `mergeable / awaiting-arm / arm` and "arming auto-merge", yet each `automerge.arm_failed` row
// said "security merge unknown: …" or "security merge blocked: …". The stall escalated as
// awaiting-arm with a duplicate-build guess. The blocker, owner, reason and escalation now name the
// security policy's verdict.
import assert from "node:assert/strict";
import { test } from "node:test";

// A namespace import, so the file still loads at a base without these exports and each test fails on its own.
import * as blockers from "#src/lib/pr-blocker.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 15, 8, 30);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const HEAD = "fdd23555a3de1ad756e78efe5c27f1a1de18bf73";
const URL = "https://github.com/craigoley/remudero/pull/11936";
// The real #11936 row's error text (core ledger, 2026-10-15T08:20:28Z).
const UNKNOWN = "security merge unknown: security-analysis-failed-or-unrecognized";
const BLOCKED = "security merge blocked: new-high-or-critical-security-alert";

function armFailed(error: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: ago(10), run_id: "DAEMON-1792042718195", task_id: "PR-11936", step: "automerge.arm_failed",
    lane: "review", outcome: "arm-error-ignored", head_sha: HEAD, error, pr_number: 11936, pr_url: URL, ...over };
}
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11936, prUrl: URL, headSha: HEAD, headRefName: "run-unfiled-1792040000000",
    checksState: "green", reviewState: "success", autoMergeArmed: false,
    priorStrikes: 0, unmetCriteria: [], lastActivityAt: ago(5), ...over,
  };
}
function fixture(rows: Record<string, unknown>[]) {
  const ledger = writeLedger(rows);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "w1-t9633", now: () => NOW,
    arm: () => "arm-error-ignored", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
  };
  const rowsOf = (step: string) => readLedgerLines(ledger.path).filter(row => row.step === step);
  return { deps, escalations, rowsOf };
}

test("W1-T9633: a security merge unknown arm refusal names a security-unknown-hold owned by the security policy", async () => {
  const f = fixture([armFailed(UNKNOWN)]);
  await runSweep([pr()], f.deps);
  const row = f.rowsOf("sweep.disposed").at(-1);
  assert.equal(row?.disposition, "mergeable");
  assert.equal(row?.blocker, "security-unknown-hold");
  assert.equal(row?.blocker_owner, "security-policy");
  assert.match(String(row?.reason), /security merge unknown: security-analysis-failed-or-unrecognized/);
  assert.doesNotMatch(String(row?.reason), /arming auto-merge/);
  assert.match(String(row?.blocker_cause), /security merge unknown: security-analysis-failed-or-unrecognized/);
});

test("W1-T9633: a new high alert arm refusal names a security-alert-hold owned by the fix lane and the alert", async () => {
  const f = fixture([armFailed(BLOCKED)]);
  const alert = { alertNumber: 412, ruleId: "js/path-injection", severity: "high", path: "src/lib/x.ts", line: 7, message: "m" };
  await runSweep([pr({ codeqlHeadAlerts: { headSha: HEAD, alerts: [alert] } })], f.deps);
  const row = f.rowsOf("sweep.disposed").at(-1);
  assert.equal(row?.blocker, "security-alert-hold");
  assert.equal(row?.blocker_owner, "fix-lane");
  assert.match(String(row?.reason), /security merge blocked: new-high-or-critical-security-alert/);
  assert.match(String(row?.reason), /alert #412 js\/path-injection at src\/lib\/x\.ts:7/);
  // An alert read at another head is never named as this head's.
  assert.doesNotMatch(blockers.securityHoldReason({ state: "blocked", reason: "r" }), /alert #/);
});

test("W1-T9633: a stalled security hold escalates with the policy verdict", async () => {
  const f = fixture([
    { ts: ago(40), run_id: "old", task_id: "unfiled", step: "sweep.disposed", pr_number: 11936, head_sha: HEAD,
      disposition: "mergeable", acted: false, blocker: "security-unknown-hold", blocker_since: ago(40) },
    armFailed(UNKNOWN),
  ]);
  await runSweep([pr()], f.deps);
  const stuck = f.rowsOf("pr.stuck");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]?.blocker, "security-unknown-hold");
  assert.match(String(stuck[0]?.diagnosis), /^security hold: .*security merge unknown: security-analysis-failed-or-unrecognized/);
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0]!, /security-unknown-hold for 40 minutes/);
  assert.match(f.escalations[0]!, /DIAGNOSIS: security hold: .*security merge unknown/);
  assert.doesNotMatch(f.escalations[0]!, /awaiting-arm/);
});

test("W1-T9633: a later arm or another head's refusal leaves awaiting-arm", async () => {
  const later = { ts: ago(5), step: "automerge.armed", pr_number: 11936, head_sha: HEAD, pr_url: URL };
  for (const rows of [[armFailed(UNKNOWN), later], [armFailed(BLOCKED, { head_sha: "b".repeat(40) })],
    [armFailed("GraphQL: Something went wrong")]]) {
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    const row = f.rowsOf("sweep.disposed").at(-1);
    assert.equal(row?.blocker, "awaiting-arm", JSON.stringify(rows));
    assert.equal(row?.blocker_cause, undefined);
  }
  assert.equal(blockers.securityArmRefusalAtHead([armFailed(UNKNOWN), later], 11936, HEAD), undefined);
  assert.deepEqual(blockers.securityArmRefusalAtHead([later, armFailed(UNKNOWN)], 11936, HEAD),
    { state: "unknown", reason: "security-analysis-failed-or-unrecognized" });
  // An armed PR, or one under an operator hold, keeps its own blocker.
  const refusal = { state: "unknown" as const, reason: "r" };
  assert.equal(blockers.finalBlocker("awaiting-arm", { mergeable: true, autoMergeArmed: true, securityArmRefusal: refusal }), "armed-idle");
  assert.equal(blockers.finalBlocker("awaiting-arm", { mergeable: true, operatorHold: true, securityArmRefusal: refusal }), "operator-hold");
  assert.equal(blockers.finalBlocker("own-red", { securityArmRefusal: refusal }), "own-red");
});


test("a security UNKNOWN asks for complete evidence without prescribing a policy relaxation", () => {
 const text = blockers.securityHoldReason({ state: "unknown", reason: "security-analysis-failed-or-unrecognized" });
 assert.match(text, /restore complete trusted exact-head evidence and re-evaluate the policy/);
 assert.match(text, /hold remains until qualified/);
 assert.doesNotMatch(text, /policy, not the arm, must change/);
});
