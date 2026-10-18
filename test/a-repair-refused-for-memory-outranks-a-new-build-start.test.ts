// W1-T9706 — a repair the sweep refused for host memory outranks a new build start.
//
// The fixture is the 2026-10-16 16:45:51Z sweep.fix_capacity refusal: headroom 1,617 MiB over the 3,072 MiB floor,
// 2 planned reviews charged at review_estimate_mib 1,162 (2,324 MiB), fix_estimate_mib 859 against fix_typical_mib 279,
// admission_rung none. And the 10-15 17:06Z build gate: 5,898 MiB available against the same floor, tier "fits", with
// three builds started 25 s later. memoryGovernorGateFor composes checkMemoryGovernor with buildYieldsToRepair; this
// suite drives that same composition from lib modules (a new suite may not import src/run-task.ts).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  DEFAULT_SWEEP_POLICY, checkMemoryGovernor, createSweepFixAdmissionController, logMemoryObservation, runSweep,
  withFullSweepRepairAdmission, type OpenPrView,
} from "../src/lib/sweep.js";
import { HOST_MEMORY_PRIORITY_PROPOSAL } from "../src/lib/host-memory-priority.js";
import { buildYieldsToRepair, freshRepairMemoryDemand, resetRepairMemoryDemand } from "../src/lib/repair-memory-demand.js";

const MIN = 60_000;
const REFUSED_AT = Date.parse("2026-10-15T17:04:00Z");
const FLOOR = 3_072;
const POLICY = { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: FLOOR };
const ROOMY = { headroomMib: 5_898, ceilingMib: 8_820, workingSetMib: 2_922 };
const BOUND = HOST_MEMORY_PRIORITY_PROPOSAL.demandRefreshBoundMs;

function at(t: TestContext, ms: number): void {
  t.mock.timers.enable({ apis: ["Date"], now: ms });
}

/** One sweep pass's repair claim on the measured 16:45:51Z reading, or on a roomy one. */
function claimRepair(prNumber: number, opts: { headroomMib?: number; rows?: Record<string, unknown>[] } = {}) {
  const controller = createSweepFixAdmissionController({
    surface: "light",
    queueDepth: 2,
    hostWorkerBudget: 8,
    activeWorkers: 3,
    reviewReservations: 2,
    readReviewReservations: () => 2,
    readActiveWorkers: () => 3,
    readPressure: () => ({ availableMib: FLOOR + (opts.headroomMib ?? 1_617), floorMib: FLOOR, tier: "fits" }),
    readEstimate: (workerClass) => workerClass === "review" ? { estimateMib: 1_162, samples: 40 } : { estimateMib: 859, samples: 30 },
    readTypical: () => ({ estimateMib: 279, samples: 30 }),
    readResidents: () => ({ review: [], fix: [] }),
    log: (step, extra) => void opts.rows?.push({ step, ...extra }),
  });
  return controller.claim({ prNumber } as OpenPrView);
}

/** The build gate at 17:06Z: the floor admits (tier fits), then the build is asked to yield. */
function buildGate(ownWorkLive: () => boolean) {
  const admitted = checkMemoryGovernor(5_898, POLICY, ROOMY, ownWorkLive);
  assert.equal(admitted.deferred, false, "control: the floor alone admits this build");
  assert.equal(admitted.tier, "fits");
  return buildYieldsToRepair(admitted, ownWorkLive);
}

test("W1-T9706: a build start yields to a repair refused for host memory", (t) => {
  resetRepairMemoryDemand();
  at(t, REFUSED_AT);
  const rows: Record<string, unknown>[] = [];
  const claim = claimRepair(12058, { rows });
  assert.equal(claim.admitted, false, "the measured reading refuses the fix");
  assert.equal(rows.at(-1)?.admission_rung, "none");
  assert.deepEqual(freshRepairMemoryDemand(REFUSED_AT).map((d) => [d.prNumber, d.shortMib]), [[12058, 859 - (1_617 - 2_324)]],
    "the refusal is recorded as repair demand, short by the fix estimate less what is left");

  t.mock.timers.setTime(REFUSED_AT + 2 * MIN);
  const verdict = buildGate(() => true);
  assert.equal(verdict.deferred, true, "the build yields to the waiting repair");
  assert.equal(verdict.tier, "yield-to-repair");
  assert.equal(verdict.repairYield?.repair.prNumber, 12058);
  assert.ok(verdict.repairYield!.repairScore > verdict.repairYield!.buildScore, "the repair outranks a build that has not waited");

  const ledger: Record<string, unknown>[] = [];
  logMemoryObservation(verdict, (_path, line) => void ledger.push(line), "/dev/null", "RUN-9706");
  assert.equal(ledger[0]?.step, "dispatch_memory_observed");
  assert.equal(ledger[0]?.deferred, true);
  assert.equal(ledger[0]?.tier, "yield-to-repair");
  assert.equal(ledger[0]?.repair_yield, true);
  assert.equal(ledger[0]?.repair_pr, 12058);
  assert.equal(ledger[0]?.repair_wait_ms, 2 * MIN);
  assert.equal(ledger[0]?.repair_short_mib, 1_566);
  assert.equal(typeof ledger[0]?.repair_score, "number");
  assert.equal(typeof ledger[0]?.build_score, "number");

  assert.equal(claimRepair(12058, { headroomMib: 4_000 }).admitted, true, "the repair is admitted once memory frees");
  assert.equal(buildGate(() => true).deferred, false, "an admitted repair holds no build");
});

test("W1-T9706: a build is admitted when nothing live can free memory for the repair", (t) => {
  resetRepairMemoryDemand();
  at(t, REFUSED_AT);
  assert.equal(claimRepair(12058).admitted, false);
  t.mock.timers.setTime(REFUSED_AT + 2 * MIN);
  let asked = 0;
  const verdict = buildGate(() => { asked++; return false; });
  assert.ok(asked > 0, "live work was asked");
  assert.equal(verdict.deferred, false, "holding the build cannot make the repair fit");
  assert.equal(verdict.repairYield?.yielded, false);
  assert.equal(verdict.repairYield?.reason, "nothing-live", "the admission is named");
  assert.equal(buildGate(() => true).deferred, true, "control: with live work the same build yields");
});

test("W1-T9706: an aged build outranks a waiting repair and starts", (t) => {
  resetRepairMemoryDemand();
  at(t, REFUSED_AT);
  assert.equal(claimRepair(12058).admitted, false);
  assert.equal(buildGate(() => true).deferred, true, "the build's yield streak starts here");
  // Repair A stays refused every few minutes, so the build keeps yielding to it.
  for (let minute = 4; minute <= 28; minute += 4) {
    t.mock.timers.setTime(REFUSED_AT + minute * MIN);
    assert.equal(claimRepair(12058).admitted, false);
    assert.equal(buildGate(() => true).deferred, true, `minute ${minute}: still yields to the older repair`);
  }
  // A is admitted; B is refused now, so B has not waited at all while the build has waited 30 min.
  t.mock.timers.setTime(REFUSED_AT + 30 * MIN);
  assert.equal(claimRepair(12058, { headroomMib: 4_000 }).admitted, true);
  assert.equal(claimRepair(12099).admitted, false);
  const aged = buildGate(() => true);
  assert.equal(aged.deferred, false, "the build held 30 min outranks the repair that just began waiting");
  assert.equal(aged.repairYield?.reason, "build-outranks");
  assert.equal(aged.repairYield?.repair.prNumber, 12099);
  assert.equal(aged.repairYield?.buildWaitMs, 30 * MIN);
  assert.ok(aged.repairYield!.buildScore > aged.repairYield!.repairScore);
  const next = buildGate(() => true);
  assert.equal(next.deferred, true, "the build that started ended the streak: the next build yields again");
  assert.equal(next.repairYield?.buildWaitMs, 0);
});

test("W1-T9706: a stale repair refusal holds no build", (t) => {
  resetRepairMemoryDemand();
  at(t, REFUSED_AT);
  assert.equal(claimRepair(12058).admitted, false);
  t.mock.timers.setTime(REFUSED_AT + BOUND);
  assert.equal(buildGate(() => true).deferred, true, "control: a refusal inside the refresh bound holds the build");
  t.mock.timers.setTime(REFUSED_AT + BOUND + 1);
  const verdict = buildGate(() => true);
  assert.equal(verdict.deferred, false, "past the refresh bound the refusal is stale");
  assert.equal(verdict.repairYield, undefined, "a stale refusal is not waiting demand");
});

test("W1-T9706: a pass that no longer derives a repair clears it; one it refused again keeps it", async (t) => {
  resetRepairMemoryDemand();
  at(t, REFUSED_AT);
  assert.equal(claimRepair(12058).admitted, false);
  let noted = false;
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/nonexistent/rmd-9706/ledger.ndjson", runId: "t9706",
    readLedger: () => [], appendLine: () => {},
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set<string>(), runningLong: new Set<string>() }),
    // A refusal noted while the pass runs is this pass's own and survives it.
    log: () => { if (!noted) { noted = true; assert.equal(claimRepair(12099).admitted, false); } },
  };
  await runSweep([], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(freshRepairMemoryDemand(REFUSED_AT).map((d) => d.prNumber).sort(), [12058, 12099],
    "a pass scoped to other PRs leaves both repairs waiting");
  noted = true;
  await runSweep([], withFullSweepRepairAdmission(deps), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(freshRepairMemoryDemand(REFUSED_AT), [], "a full pass that refused neither again clears both");
  noted = false;
  await runSweep([], withFullSweepRepairAdmission(deps), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(freshRepairMemoryDemand(REFUSED_AT).map((d) => d.prNumber), [12099], "a refusal during the pass is kept");
});
