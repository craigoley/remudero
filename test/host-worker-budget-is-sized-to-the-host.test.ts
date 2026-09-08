import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
} from "../src/lib/review-capacity.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";

const HOST_LOGICAL_CORES = 8;
const MEASURED_MEM_AVAILABLE_MIB = 23_483;
const POLICY_MAX = 16;

function observation(activeWorkers: number): ReviewCapacityObservation {
  return {
    nowMs: 0,
    queueDepth: 12,
    activeWorkers,
    memAvailableMib: MEASURED_MEM_AVAILABLE_MIB,
    cpuPsiSomeAvg10Pct: 26.04,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    provider: { fresh: true, readable: true, headroomPct: 68, reservePct: 5 },
    settlements: { successes: 5, failures: 0, timeouts: 0, baselineLatencyMs: 1_000, recentLatencyMs: 1_000 },
  };
}

test("W1-T3209: the host worker budget is derived from measured cores and memory", () => {
  const raw = readFileSync(new URL("../plan/policy.yaml", import.meta.url), "utf8");
  const parsed = parseYaml(raw) as {
    sweep: { reviewCapacity: { hostWorkerBudget: { value: number; min: number; max: number } } };
  };
  const row = parsed.sweep.reviewCapacity.hostWorkerBudget;
  const reserveMib = DEFAULT_SWEEP_POLICY.reviewCapacity.workerMemoryReserveMib;
  const derived = Math.min(HOST_LOGICAL_CORES, Math.floor(MEASURED_MEM_AVAILABLE_MIB / reserveMib), POLICY_MAX);

  assert.equal(derived, 8, "8 cores, not memory or the policy maximum, are the measured bound");
  assert.equal(row.value, derived);
  assert.equal(DEFAULT_SWEEP_POLICY.reviewCapacity.hostWorkerBudget, derived, "the production loader consumes the row");
  assert.ok(row.value >= row.min && row.value <= row.max, "the derived value remains inside its declared bounds");
});

test("W1-T3209: the measured steady state admits two reviews at the new budget but shed at four", () => {
  const policy = DEFAULT_SWEEP_POLICY.reviewCapacity;
  const bounds = { minWidth: 1, baseWidth: 2, maxWidth: 3 };
  const prior = initialReviewCapacityState(2);
  const measured = observation(3);
  const old = selectAdaptiveReviewWidth(prior, { ...policy, hostWorkerBudget: 4 }, measured, bounds).decision;
  const resized = selectAdaptiveReviewWidth(prior, policy, measured, bounds).decision;

  assert.equal(old.reason, "host-worker-budget", "three active workers plus two reviews exceeded the old budget");
  assert.equal(old.effectiveWidth, 1);
  assert.notEqual(resized.reason, "host-worker-budget", "the measured five-worker demand fits the resized host budget");
  assert.equal(resized.effectiveWidth, 2);
});

test("W1-T3209: the resized host worker governor still sheds when genuinely exceeded", () => {
  const policy: ReviewCapacityPolicy = DEFAULT_SWEEP_POLICY.reviewCapacity;
  const decision = selectAdaptiveReviewWidth(
    initialReviewCapacityState(2),
    policy,
    observation(7),
    { minWidth: 1, baseWidth: 2, maxWidth: 3 },
  ).decision;

  assert.equal(decision.reason, "host-worker-budget");
  assert.equal(decision.effectiveWidth, 1, "seven active workers leave only one review slot under the budget of eight");
});
