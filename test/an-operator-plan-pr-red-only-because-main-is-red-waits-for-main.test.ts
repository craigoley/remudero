import assert from "node:assert/strict";
import test from "node:test";

// Read through the namespace, so this file still LOADS at a base that lacks a symbol and fails per test.
import * as sweep from "#src/lib/sweep.js";
import type { CiFailure, OpenPrView, SweepDeps } from "#src/lib/sweep.js";

// W1-T9250 — #11407 (plan-file-1791906392752, authored by cao825) went red on ci-shard (8/8) while main
// was red on the same check. `decidePlanRepair` gave its base-red wait only to fleet machine-lane heads,
// so the operator filing got no decision while main was red, and the plan-only block escalated it as a
// plan violation (`refused-escalate`, blocker plan-proof-unrunnable) until a hand update-branch. Every
// plan filing now waits for main and is refreshed once main is green; a red of its own still escalates.

const NOW = Date.parse("2026-10-13T16:30:00Z");
const HEAD = "a".repeat(40);
const MAIN_RED = "b".repeat(40);
const MAIN_GREEN = "c".repeat(40);
const OPERATOR_HEAD = "plan-file-1791906392752";

function failure(name: string): CiFailure {
  return { name, logTail: "", conclusion: "FAILURE" };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11407,
    prUrl: "https://github.com/acme/remudero/pull/11407",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: OPERATOR_HEAD,
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [failure("ci-shard (8/8)"), failure("ci-gate")],
    body: "Files W1-T9153.\n\n## Acceptance\n- W1-T9153 is filed | grep: W1-T9153 in plan/tasks.d",
    ...over,
  };
}

// A green peer keeps the red on ONE PR, so the pass never reads it as every PR's base-caused red.
function greenPeer(): OpenPrView {
  return planPr({
    prNumber: 6900, prUrl: "https://github.com/acme/remudero/pull/6900", taskId: "W1-T4000", checksState: "green",
    reviewState: "success", headSha: "e".repeat(40), headRefName: "run-W1-T4000-1", isPlanFiling: false, ciFailures: undefined,
  });
}

function mainObserved(sha: string, state: string, failing: string[], observed?: string[]): Record<string, unknown> {
  return { step: "main.health.observed", sha, state, failing_checks: failing, ...(observed ? { observed_checks: observed } : {}) };
}

async function pass(prs: OpenPrView[], ledger: Record<string, unknown>[], behind: number) {
  const escalated: Array<{ pr: number; reason: string }> = [];
  const updated: number[] = [];
  const factReads: number[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, postReview: async () => {},
    escalate: (pr: OpenPrView, reason: string) => { escalated.push({ pr: pr.prNumber, reason }); },
    updateBranch: (pr: { prNumber: number }) => { updated.push(pr.prNumber); return "updated" as const; },
    readPlanRepairFacts: (pr: OpenPrView) => { factReads.push(pr.prNumber); return { authorLogin: "cao825", title: "chore(plan): file W1-T9153" }; },
    repairPlanPr: () => ({ outcome: "renumbered" }),
    behindMainByPr: new Map(prs.map((p) => [p.prNumber, p.prNumber === 6900 ? 0 : behind])),
    ledgerPath: "/dev/null/w1-t9250.ndjson",
    runId: "W1-T9250-test",
    readLedger: () => ledger,
    appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
  await sweep.runSweep(prs, deps, sweep.DEFAULT_SWEEP_POLICY);
  const disposed = () => ledger.filter((l) => l.step === "sweep.disposed" && l.pr_number === 11407).at(-1);
  const repairRows = () => ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP && l.pr_number === 11407);
  return { escalated, updated, factReads, disposed, repairRows };
}

test("W1-T9250: an operator plan PR red on a check main also fails waits for main", async () => {
  const ledger: Record<string, unknown>[] = [mainObserved(MAIN_RED, "red", ["ci-shard (8/8)", "ci-gate"])];
  const first = await pass([planPr(), greenPeer()], ledger, 4);
  assert.deepEqual(first.escalated, [], "main's red is not this filing's plan violation");
  assert.deepEqual(first.updated, [], "refreshing onto a red main would re-import the red");
  assert.equal(first.disposed()?.disposition, "wait");
  assert.equal(first.disposed()?.blocker, "base-red");
  assert.deepEqual(first.factReads, [], "a head no machine lane owns is never read");
  assert.equal(first.repairRows().length, 1);
  assert.equal(first.repairRows()[0]!.action, "wait");
  assert.equal(first.repairRows()[0]!.cause, "main-red");

  // Still red on the next pass: still a wait, and no second row for the same head.
  const again = await pass([planPr(), greenPeer()], ledger, 4);
  assert.equal(again.disposed()?.disposition, "wait");
  assert.deepEqual(again.escalated, []);
  assert.equal(again.repairRows().length, 1);
});

test("W1-T9250: the waiting operator plan PR is refreshed once main is green", async () => {
  // lint-plan is a check a plan file CAN turn red, so the inherited-red refresh never takes it: only the
  // recorded wait proves this red was main's.
  const pr = planPr({ ciFailures: [failure("lint-plan"), failure("ci-gate")] });
  const ledger: Record<string, unknown>[] = [mainObserved(MAIN_RED, "red", ["lint-plan", "ci-gate"])];
  const waiting = await pass([pr, greenPeer()], ledger, 3);
  assert.equal(waiting.disposed()?.disposition, "wait");
  assert.deepEqual(waiting.updated, []);

  ledger.push(mainObserved(MAIN_GREEN, "green", []));
  const refreshed = await pass([pr, greenPeer()], ledger, 3);
  assert.deepEqual(refreshed.updated, [11407], "one update-branch press onto the green main");
  assert.deepEqual(refreshed.escalated, []);
  assert.equal(refreshed.repairRows().at(-1)?.action, "refresh");
  assert.equal(refreshed.repairRows().at(-1)?.outcome, "updated");

  // One press per head: the same head still red after it is no longer main's red.
  const after = await pass([pr, greenPeer()], ledger, 3);
  assert.deepEqual(after.updated, []);
  assert.equal(after.escalated.length, 1);
});

test("W1-T9250: an operator plan PR red on its own check still escalates", async () => {
  // Main is red, but on another check, and its census shows lint-plan PASSED there: this red is the filing's.
  const ledger: Record<string, unknown>[] = [
    mainObserved(MAIN_RED, "red", ["ci-shard (8/8)", "ci-gate"], ["ci-shard (8/8)", "ci-gate", "lint-plan"]),
  ];
  const own = await pass([planPr({ ciFailures: [failure("lint-plan"), failure("ci-gate")] }), greenPeer()], ledger, 4);
  assert.deepEqual(own.updated, []);
  assert.equal(own.escalated.length, 1);
  assert.match(own.escalated[0]!.reason, /plan-only PR is red on lint-plan/);
  assert.equal(own.disposed()?.disposition, "refused-escalate");
  assert.equal(own.disposed()?.blocker, "plan-proof-unrunnable");
  assert.deepEqual(own.repairRows(), []);
});
