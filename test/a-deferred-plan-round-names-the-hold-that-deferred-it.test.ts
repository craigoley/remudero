import assert from "node:assert/strict";
import test from "node:test";
import * as sweep from "../src/lib/sweep.js";
import type { OpenPrView, SweepDeps } from "../src/lib/sweep.js";

// #10488 (2026-10-09): a fleet plan filing sat on "plan-scoped round deferred" for passes with no
// plan round ever dispatched, and the one reason covered three different holds — a light pass, a
// dry run, and a worker admission hold — so nobody could tell which one was holding it.

const HEAD = "c".repeat(40);
const PATH = "plan/tasks.d/W1-T7475-fixture.yaml";
const pr: OpenPrView = {
  prNumber: 9100, prUrl: "https://github.com/acme/remudero/pull/9100", headSha: HEAD,
  headRefName: "selector-shadow-garden-1791583108721", isPlanFiling: true, planFilingSource: "github-files",
  checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
  ciFailures: [{ name: "lint-plan", logTail: "machine-filing admission refused", conclusion: "FAILURE" }],
  body: `## Acceptance\n- the shard is filed | grep: id: W1-T7475 in ${PATH}`,
};
const peer = { ...pr, prNumber: 9101, checksState: "green", reviewState: "success", isPlanFiling: false, ciFailures: undefined } as OpenPrView;

async function disposedReason(overrides: Partial<SweepDeps>): Promise<{ reason: string; rounds: number }> {
  const ledger: Record<string, unknown>[] = [];
  let rounds = 0;
  const deps = {
    runId: "deferred-plan-round", ledgerPath: "/dev/null/ledger", readLedger: () => ledger,
    appendLine: (_: string, line: Record<string, unknown>) => ledger.push(line),
    arm() {}, close() {}, postReview: async () => {}, escalate() {},
    dispatchFix() { assert.fail("plan filings never enter the code rung"); },
    readPlanRepairFacts: () => ({ authorLogin: "remudero-fleet[bot]" }),
    repairPlanPr() { assert.fail("no mechanical cure matches"); },
    dispatchPlanGateRound: async () => { rounds++; return { outcome: "pushed", headSha: "d".repeat(40) }; },
    ...overrides,
  } as unknown as SweepDeps;
  await sweep.runSweep([pr, peer], deps, sweep.DEFAULT_SWEEP_POLICY);
  const row = ledger.findLast((l) => l.step === "sweep.disposed" && l.pr_number === pr.prNumber);
  return { reason: String(row?.reason), rounds };
}

test("a light pass names itself when it defers a plan-scoped round to the full sweep", async () => {
  const { reason, rounds } = await disposedReason({ actionable: () => false } as Partial<SweepDeps>);
  assert.equal(rounds, 0);
  assert.match(reason, /deferred to the full sweep \(light pass\)/);
});

test("a worker admission hold names its own reason on the deferred plan-scoped round", async () => {
  const { reason, rounds } = await disposedReason({ workerAdmissionHold: () => "host memory below its budget" } as Partial<SweepDeps>);
  assert.equal(rounds, 0);
  assert.match(reason, /held by worker admission: host memory below its budget/);
});

test("a full pass with no hold dispatches the plan-scoped round instead of deferring it", async () => {
  const { reason, rounds } = await disposedReason({});
  assert.equal(rounds, 1);
  assert.doesNotMatch(reason, /deferred/);
});
