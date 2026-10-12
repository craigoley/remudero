import assert from "node:assert/strict";
import test from "node:test";

// The new symbols are read through the namespace, so this file still LOADS at a base that lacks
// them and fails per test instead of at import.
import * as sweep from "../src/lib/sweep.js";
import type { CiFailure, OpenPrView, SweepDeps } from "../src/lib/sweep.js";

// #10365 — a plan-only filing sat red for hours on ci-shard (1/8): its branch was 58 commits behind and
// based inside the 10-09 13:52-14:45Z main typecheck red. Every red on a plan-only PR went to plan repair,
// which a session head never gets, so it escalated until a hand `merge origin/main`. A red no plan file
// can cause, on a head behind a green main, is main's red: the sweep takes main once instead.

const NOW = Date.parse("2026-10-09T20:00:00Z");
const HEAD = "a".repeat(40);
const MAIN_GREEN = "c".repeat(40);
const OLD_BASE = "d".repeat(40);
const FLEET = "remudero-fleet[bot]";

function failure(name: string): CiFailure {
  return { name, logTail: "", conclusion: "FAILURE" };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10365,
    prUrl: "https://github.com/acme/remudero/pull/10365",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: "plan-file-fix-round-census-1791555023000",
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [failure("ci-shard (1/8)"), failure("ci-gate")],
    body: "Files W1-T7182.\n\n## Acceptance\n- W1-T7182 is filed | grep: W1-T7182 in plan/tasks.d",
    ...over,
  };
}

function greenPeer(): OpenPrView {
  return planPr({
    prNumber: 6900, prUrl: "https://github.com/acme/remudero/pull/6900", taskId: "W1-T4000", checksState: "green",
    reviewState: "success", headSha: "e".repeat(40), headRefName: "run-W1-T4000-1", isPlanFiling: false, ciFailures: undefined,
  });
}

// Behind by 5 keeps the legacy distance refresh (threshold 11) out of these passes: production feeds it a
// base-file map under which a plan file is never "touched by main", which is why #10365 was never refreshed.
const mainGreen = { step: "main.health.observed", sha: MAIN_GREEN, state: "green", failing_checks: [] };

async function pass(prs: OpenPrView[], ledger: Record<string, unknown>[], behind: number, over: Partial<SweepDeps> = {}) {
  const escalated: Array<{ pr: number; reason: string }> = [];
  const updated: number[] = [];
  const factReads: number[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, postReview: async () => {},
    escalate: (pr: OpenPrView, reason: string) => { escalated.push({ pr: pr.prNumber, reason }); },
    updateBranch: (pr: { prNumber: number }) => { updated.push(pr.prNumber); return "updated" as const; },
    readPlanRepairFacts: (pr: OpenPrView) => { factReads.push(pr.prNumber); return { authorLogin: FLEET, title: "chore(plan): x" }; },
    repairPlanPr: () => ({ outcome: "renumbered" }),
    behindMainByPr: new Map(prs.map((p) => [p.prNumber, p.prNumber === 6900 ? 0 : behind])),
    ledgerPath: "/dev/null/pr-10365.ndjson",
    runId: "pr-10365-test",
    readLedger: () => ledger,
    appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
    ...over,
  } as unknown as SweepDeps;
  await sweep.runSweep(prs, deps, sweep.DEFAULT_SWEEP_POLICY);
  const repairRows = () => ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP);
  return { escalated, updated, factReads, repairRows };
}

test("a session plan filing red only on a check no plan file can cause, behind a green main, takes main instead of escalating", async () => {
  const ledger: Record<string, unknown>[] = [mainGreen];
  const first = await pass([planPr(), greenPeer()], ledger, 5);
  assert.deepEqual(first.updated, [10365], "one update-branch press");
  assert.deepEqual(first.escalated, [], "not escalated for a plan repair it can never get");
  assert.deepEqual(first.factReads, [], "a head no machine lane owns is never read");
  assert.equal(first.repairRows().at(-1)?.cause, "inherited");
  assert.equal(first.repairRows().at(-1)?.outcome, "updated");

  // The same head again: no second press for one head.
  const again = await pass([planPr(), greenPeer()], ledger, 5);
  assert.deepEqual(again.updated, []);
});

test("a plan filing red on a check a plan file can cause still goes to plan repair, and nothing refreshes it", async () => {
  const lint = await pass([planPr({ ciFailures: [failure("lint-plan"), failure("ci-gate")] }), greenPeer()], [mainGreen], 5);
  assert.deepEqual(lint.updated, []);
  assert.equal(lint.escalated.length, 1);
  assert.match(lint.escalated[0]!.reason, /plan-only PR is red on lint-plan/);

  // Mixed: one plan-caused red keeps the whole PR on the plan-repair route.
  const mixed = await pass([planPr({ ciFailures: [failure("ci-shard (1/8)"), failure("claims")] }), greenPeer()], [mainGreen], 5);
  assert.deepEqual(mixed.updated, []);
});

test("an inherited-looking red is not refreshed onto a red main, or when the head is already on main", async () => {
  const redMain = await pass([planPr(), greenPeer()],
    [{ step: "main.health.observed", sha: MAIN_GREEN, state: "red", failing_checks: ["ci-shard (2/8)"] }], 5);
  assert.deepEqual(redMain.updated, [], "refreshing onto a red main would re-import a red");

  const current = await pass([planPr(), greenPeer()], [mainGreen], 0);
  assert.deepEqual(current.updated, [], "a head on main's tip has nothing to take");

  // The merge base, when hydrated, is evidence too.
  const byBase = await pass([planPr({ currentMergeBaseSha: OLD_BASE }), greenPeer()], [mainGreen], 0);
  assert.deepEqual(byBase.updated, [10365]);
});

test("a machine-lane plan PR red only on an inherited check is refreshed too", async () => {
  const lane = await pass([planPr({ headRefName: "backlog-garden-1791555000000" }), greenPeer()], [mainGreen], 5);
  assert.deepEqual(lane.updated, [10365]);
  assert.deepEqual(lane.factReads, [10365]);
  assert.equal(lane.repairRows().at(-1)?.cause, "inherited");
});

test("the inherited-red classifier names only checks a plan file cannot turn red", () => {
  const classify = sweep.inheritedPlanRedChecks;
  assert.equal(typeof classify, "function");
  assert.deepEqual(classify(["ci-shard (1/8)", "coverage-shard (3/8)", "ci-gate"]), ["ci-shard (1/8)", "coverage-shard (3/8)"]);
  assert.deepEqual(classify(["typecheck"]), ["typecheck"]);
  assert.equal(classify(["ci-gate"]), undefined, "the aggregate alone names no red");
  assert.equal(classify(["lint-plan"]), undefined);
  assert.equal(classify(["ci-shard (1/8)", "task-id-existence"]), undefined);
  assert.equal(classify(["proof-discrimination"]), undefined);
});
