// W1-T3031 — `hostTelemetryAvailable` gates on `cpuPsiFullAvg10Pct`, and until this task the
// `review.capacity` row recorded only the `some` metric — so the largest shed reason in the fleet
// (`telemetry-unavailable`, 349 of 753 decisions measured 2026-09-07) could not be diagnosed from
// its own row, and its single token named none of its three conditions.
//
// THE INVARIANCE HALF IS THE LOAD-BEARING HALF. A diagnostic change that moves a width is not a
// diagnostic change, so the table below pins every arm's width AND reason against the values the
// controller produces today.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  absentHostReadings,
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "../src/lib/review-capacity.js";

const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 4,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  cpuPsiHighPct: 20,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  settlementWindowMs: 1_800_000,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
  latencyExpansionRatio: 2,
};

function healthy(nowMs: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs,
    queueDepth: 5,
    activeWorkers: 0,
    memAvailableMib: 4096,
    cpuPsiSomeAvg10Pct: 1,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 1,
    provider: { fresh: true, readable: true, headroomPct: 80, reservePct: 5, ageMs: 1000 },
    settlements: { successes: 2, failures: 0, timeouts: 0 },
    ...over,
  };
}

const decide = (state: ReviewCapacityState, observation: ReviewCapacityObservation) =>
  selectAdaptiveReviewWidth(state, POLICY, observation, { baseWidth: 2, minWidth: 1, maxWidth: 3 });

test("W1-T3031 criterion 1: the evidence carries the cpu PSI FULL reading the decision gates on", () => {
  // The `some` metric is the one that was already recorded; `full` is the one that decides.
  const { decision } = decide(initialReviewCapacityState(2), healthy(1_000, { cpuPsiFullAvg10Pct: 3.5 }));
  assert.equal(decision.evidence.cpuPsiFullAvg10Pct, 3.5);
});

test("W1-T3031 criterion 2: a missing cpu full reading is NAMED, not collapsed into one token", () => {
  const obs = healthy(1_000, { cpuPsiFullAvg10Pct: undefined });
  const { decision } = decide(initialReviewCapacityState(2), obs);
  assert.equal(decision.reason, "telemetry-unavailable");
  assert.deepEqual(decision.evidence.absentHostReadings, ["cpu_psi_full_avg10_pct"]);
});

test("W1-T3031 criterion 2 (falsifier): the list DISCRIMINATES — memory alone, cpu alone, and both", () => {
  // A list that is always empty or always full would pass a test that only checks the field exists.
  assert.deepEqual(absentHostReadings({ memAvailableMib: undefined, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 1 }), [
    "mem_available_mib",
  ]);
  assert.deepEqual(absentHostReadings({ memAvailableMib: 4096, cpuPsiFullAvg10Pct: undefined, memoryPsiSomeAvg10Pct: 1 }), [
    "cpu_psi_full_avg10_pct",
  ]);
  assert.deepEqual(
    absentHostReadings({ memAvailableMib: undefined, cpuPsiFullAvg10Pct: undefined, memoryPsiSomeAvg10Pct: undefined }),
    ["mem_available_mib", "cpu_psi_full_avg10_pct", "memory_psi_some_avg10_pct"],
  );
  // NaN and Infinity are non-finite readings, not present ones.
  assert.deepEqual(absentHostReadings({ memAvailableMib: NaN, cpuPsiFullAvg10Pct: 0, memoryPsiSomeAvg10Pct: 1 }), [
    "mem_available_mib",
  ]);
});

test("W1-T3031 criterion 3: complete telemetry names NO absent reading", () => {
  const { decision } = decide(initialReviewCapacityState(2), healthy(1_000));
  assert.deepEqual(decision.evidence.absentHostReadings, []);
});

test("W1-T3031 criterion 4 (falsifier): every arm's WIDTH and REASON are unchanged", () => {
  // The invariance table. Each row is an arm of the controller; the expected pair is what the
  // shipped controller produces, so any policy drift introduced by this task reddens here.
  const state = initialReviewCapacityState(2);
  const rows: Array<[string, ReviewCapacityObservation, string, number]> = [
    ["host telemetry absent", healthy(1_000, { cpuPsiFullAvg10Pct: undefined }), "telemetry-unavailable", 2],
    [
      "provider telemetry absent",
      healthy(1_000, { provider: { fresh: false, readable: false, ageMs: 90_000 } }),
      "provider-telemetry-unavailable",
      2,
    ],
    ["backlog not sustained", healthy(1_000, { queueDepth: 0 }), "backlog-not-sustained", 2],
    ["cpu pressure", healthy(1_000, { cpuPsiFullAvg10Pct: 90 }), "cpu-pressure", 1],
    ["memory pressure", healthy(1_000, { memoryPsiSomeAvg10Pct: 90 }), "memory-pressure", 1],
  ];
  for (const [label, obs, expectedReason, expectedWidth] of rows) {
    const { decision } = decide(state, obs);
    assert.equal(decision.reason, expectedReason, `${label}: reason moved`);
    assert.equal(decision.effectiveWidth, expectedWidth, `${label}: width moved`);
  }
});

test("W1-T3031 criterion 4: the absent list never gates a decision", () => {
  // Same observation, same outcome, whether or not a reading is missing elsewhere: the ONLY
  // difference a missing reading may make is the one the controller already made before this task.
  const withAll = decide(initialReviewCapacityState(2), healthy(1_000, { queueDepth: 0 }));
  assert.deepEqual(withAll.decision.evidence.absentHostReadings, []);
  assert.equal(withAll.decision.reason, "backlog-not-sustained");
});
