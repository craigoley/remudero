import assert from "node:assert/strict";
import test from "node:test";
import * as sweep from "../src/lib/sweep.js";
import type { OpenPrView, SweepDeps } from "../src/lib/sweep.js";

// A namespace read, so the file still loads at a base without sweepWalkOrder and the proof misses there.
const { DEFAULT_SWEEP_POLICY, runSweep } = sweep;

const HEAD = "a".repeat(40);
const PATH = "plan/tasks.d/W1-T5543-fixture.yaml";
const base: OpenPrView = {
  prNumber: 0, prUrl: "", headSha: HEAD, headRefName: "ci-friction-garden-1791084979333",
  isPlanFiling: true, planFilingSource: "github-files", checksState: "red", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
  ciFailures: [{ name: "lint-plan", logTail: "rationale is missing", conclusion: "FAILURE" }],
  body: `## Acceptance\n- the shard is filed | grep: id: W1-T5543 in ${PATH}`,
};
const pr = (prNumber: number, createdAt: string, taskId: string): OpenPrView =>
  ({ ...base, prNumber, createdAt, taskId, prUrl: `https://github.com/acme/remudero/pull/${prNumber}` });

// 2026-10-09: GitHub lists newest-first, and the full pass claimed its 8-slot repair budget in that
// order — #10344 was refused "host worker budget 8 exhausted" on 9 passes running while newer PRs
// took every slot.
const older = pr(10344, "2026-10-09T08:00:00Z", "W1-T7093");
const newer = pr(10375, "2026-10-09T14:30:00Z", "W1-T7200");

test("a scarce repair slot goes to the oldest waiting PR, not the newest listed", async () => {
  const ledger: Record<string, unknown>[] = [];
  const claimed: number[] = [];
  const rounds: number[] = [];
  let slots = 1;
  const deps = {
    runId: "fair-admission-test", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
    appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
    arm() {}, close() {}, postReview: async () => {}, escalate() {},
    dispatchFix() { assert.fail("plan filings never enter the code rung"); },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]" }),
    repairPlanPr() { assert.fail("no mechanical cure applies"); },
    claimFixAdmission: (p: OpenPrView) => {
      claimed.push(p.prNumber);
      return slots-- > 0 ? { admitted: true } : { admitted: false, reason: "host worker budget 1 exhausted" };
    },
    dispatchPlanGateRound: async (p: OpenPrView) => { rounds.push(p.prNumber); return { outcome: "pushed", headSha: "b".repeat(40) }; },
  } as unknown as SweepDeps;
  const summary = await runSweep([newer, older], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(claimed, [10344, 10375], "the oldest PR claims first");
  assert.deepEqual(rounds, [10344], "the single slot repairs the PR that has waited longest");
  assert.deepEqual(summary.actions.map((a) => a.prNumber), [10375, 10344], "summary keeps input order");
});

test("the sweep walk visits oldest-first and keeps a total order", () => {
  assert.deepEqual(sweep.sweepWalkOrder([newer, older]), [1, 0]);
  const noDate = { prNumber: 1, createdAt: undefined };
  assert.deepEqual(sweep.sweepWalkOrder([{ prNumber: 3 }, noDate, { prNumber: 2 }]), [1, 2, 0], "prNumber breaks ties");
});
