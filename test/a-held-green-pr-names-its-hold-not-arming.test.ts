// #10339 (2026-10-09): a green, reviewed PR sat for hours under Craig's own merge hold while every
// sweep row said "review success, required checks green — arming auto-merge" with blocker
// awaiting-arm. `automerge.arm_skipped` named the hold, but the row an operator reads did not, so
// the PR looked like a stuck arm. The disposition now names the hold and who released it is up to.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as blockers from "../src/lib/pr-blocker.js";
import { runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.UTC(2026, 9, 9, 20);
const HOLD = { step: "automerge.hold_engaged", pr_number: 71, by: "Craig Oley", reason: "hold pending W1-T7092 corrections", authority: "interactive-cli" };

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 71, prUrl: "url/71", taskId: "W1-T7092", headSha: "head-71",
    checksState: "green", reviewState: "success", autoMergeArmed: false,
    priorStrikes: 0, unmetCriteria: [], lastActivityAt: new Date(NOW).toISOString(), ...over,
  };
}
function deps(ledgerPath: string): SweepDeps {
  return { arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, ledgerPath, runId: "hold-test", now: () => NOW };
}

test("a held green PR's sweep row names the hold and its owner, not arming", async () => {
  const d = deps(writeLedger([HOLD]).path);
  await runSweep([pr()], d);
  const [row] = readLedgerLines(d.ledgerPath).filter((r) => r.step === "sweep.disposed");
  assert.equal(row?.blocker, "operator-hold");
  assert.equal(row?.blocker_owner, "operator");
  assert.match(String(row?.reason), /held by Craig Oley: hold pending W1-T7092 corrections/);
  assert.doesNotMatch(String(row?.reason), /arming auto-merge/);
});

test("operator-hold is a blocker class owned by the operator that never climbs the SLO ladder", () => {
  const list: readonly string[] = blockers.PR_BLOCKERS;
  assert.ok(list.includes("operator-hold"));
  assert.equal((blockers.PR_BLOCKER_OWNERS as Record<string, string>)["operator-hold"], "operator");
});

test("a released hold goes back to arming", async () => {
  const released = { ...HOLD, step: "automerge.hold_released" };
  const d = deps(writeLedger([HOLD, released]).path);
  await runSweep([pr()], d);
  const [row] = readLedgerLines(d.ledgerPath).filter((r) => r.step === "sweep.disposed");
  assert.equal(row?.blocker, "awaiting-arm");
  assert.match(String(row?.reason), /arming auto-merge/);
});
