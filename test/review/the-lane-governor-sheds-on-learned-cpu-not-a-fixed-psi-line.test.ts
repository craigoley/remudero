import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cpuLaneBound,
  initialLaneCpuLearner,
  laneCpuReading,
  laneTarget,
  learnLaneCpu,
  parseCpuUsageUsec,
  type LaneCpuLearnerState,
  type LaneTargetInputs,
} from "#src/lib/lane-governor.js";
import {
  cpuPressureTier,
  cpuWeightShare,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";

// W1-T11129 — the governor learns CPU from cgroup cpu.stat; review sheds on that and on PSI relative to its weight share.

const memory: LaneTargetInputs["memory"] = { unread: "test" };
const baseInputs = { inFlight: 1, memory, cpuCount: 8, previous: { target: 6 } } as const;

test("W1-T11129 criterion 1: the cpu bound is host cpus less the learned baseline over the per-lane median", () => {
  assert.equal(cpuLaneBound(8, { baselineCpus: 2, perLaneCpus: 1.5 }), 4);
  const result = laneTarget({ ...baseInputs, previous: { target: 6 }, cpu: { baselineCpus: 2, perLaneCpus: 1.5 } });
  assert.equal(result.target, 4);
  assert.equal(result.binding, "cpu");
});

test("W1-T11129 criterion 1: an unread or unlearned input keeps the cap at the cpu count", () => {
  for (const cpu of [undefined, { baselineCpus: null, perLaneCpus: 1 }, { baselineCpus: 1, perLaneCpus: null }, { baselineCpus: 1, perLaneCpus: 0 }]) {
    assert.equal(cpuLaneBound(8, cpu), null);
    const result = laneTarget({ ...baseInputs, previous: { target: 20 }, cpu });
    assert.equal(result.target, 8);
    assert.equal(result.binding, "cpu");
  }
});

test("W1-T11129 criterion 1: usage_usec deltas teach the baseline while idle and the per-lane figure while lanes run", () => {
  assert.equal(parseCpuUsageUsec("usage_usec 1234\nuser_usec 1\n"), 1234);
  assert.equal(parseCpuUsageUsec("user_usec 1\n"), null);
  let state: LaneCpuLearnerState = initialLaneCpuLearner();
  const at = (atMs: number, usageUsec: number, runningClasses: string[]) => {
    state = learnLaneCpu(state, { atMs, usageUsec, runningClasses });
  };
  at(0, 0, []);
  at(10_000, 20_000_000, []); // 2 CPUs of non-lane work
  // 20 s long: 70 CPU-s over 20 s = 3.5 CPUs; less the 2 baseline, over 2 lanes.
  at(30_000, 90_000_000, ["implement", "implement"]);
  const reading = laneCpuReading(state, "implement");
  assert.equal(reading.baselineCpus, 2);
  assert.equal(reading.perLaneCpus, 0.75);
  assert.equal(laneCpuReading(state, "review").perLaneCpus, null);
  // A mixed-class interval, a backwards counter and an unlearned baseline teach nothing.
  const before = JSON.stringify(state.perClass);
  at(40_000, 190_000_000, ["implement", "review"]);
  at(50_000, 1, ["implement"]);
  assert.equal(JSON.stringify(state.perClass), before);
  const fresh = learnLaneCpu(learnLaneCpu(initialLaneCpuLearner(), { atMs: 0, usageUsec: 0, runningClasses: [] }), {
    atMs: 1000, usageUsec: 5_000_000, runningClasses: ["implement"],
  });
  assert.equal(fresh.idle.length, 0);
  assert.deepEqual(fresh.perClass, {});
});

const POLICY = {
  hostWorkerBudget: 8,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
} as unknown as ReviewCapacityPolicy; // no cpuPsiHighPct: nothing may read one
const BOUNDS = { minWidth: 1, baseWidth: 4, maxWidth: 5 };

function observation(over: Partial<ReviewCapacityObservation>): ReviewCapacityObservation {
  return {
    nowMs: 0,
    queueDepth: 10,
    activeWorkers: 0,
    memAvailableMib: 20_000,
    cpuPsiSomeAvg10Pct: 70,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    settlements: { successes: 3, failures: 0, timeouts: 0 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 2 },
    ...over,
  } as ReviewCapacityObservation;
}

const run = (prior: ReviewCapacityState, over: Partial<ReviewCapacityObservation>) =>
  selectAdaptiveReviewWidth(prior, POLICY, observation(over), BOUNDS).decision;

test("W1-T11129 criterion 2: a PSI full that is only the low weight's own contention does not shed", () => {
  // The measured host: core's full 40 under some 70, its weight 59 against serve's 303 and a sibling's 59.
  const share = cpuWeightShare(59, [59, 303, 59]);
  assert.ok(share !== undefined && share < 0.2);
  const decision = run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 40, cpuWeightShare: share });
  assert.notEqual(decision.reason, "cpu-pressure");
  assert.equal(decision.effectiveWidth, 4);
  // The same reading with no weight excuse is the container's own overload.
  assert.equal(run({ effectiveWidth: 4, healthySamples: 0 }, { cpuPsiFullAvg10Pct: 40 }).reason, "cpu-pressure");
});

test("W1-T11129 criterion 2: the shed is tiered, hold then shrink one then halve while it persists", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 4, healthySamples: 2 };
  // The band just above the calm line holds: nothing shed, nothing added.
  const hold = run(prior, { cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 70 });
  assert.equal(hold.effectiveWidth, 4);
  assert.notEqual(hold.reason, "cpu-pressure");
  assert.equal(hold.evidence.healthySamples, 0);
  // Beyond it the first sample shrinks one lane...
  const first = selectAdaptiveReviewWidth(prior, POLICY, observation({ cpuPsiFullAvg10Pct: 25 }), BOUNDS);
  assert.equal(first.decision.reason, "cpu-pressure");
  assert.equal(first.decision.effectiveWidth, 3);
  // ...and an overload that persists halves.
  const second = selectAdaptiveReviewWidth(first.state, POLICY, observation({ cpuPsiFullAvg10Pct: 25 }), BOUNDS);
  assert.equal(second.decision.effectiveWidth, 1);
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 25, cpuPsiSomeAvg10Pct: 70 }, POLICY).tier, "shrink");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 25, cpuPsiSomeAvg10Pct: 70 }, POLICY, true).tier, "halve");
  assert.equal(cpuPressureTier({ cpuPsiFullAvg10Pct: 8, cpuPsiSomeAvg10Pct: 70 }, POLICY).tier, "hold");
  assert.equal(cpuPressureTier({ cpuPsiSomeAvg10Pct: 70 }, POLICY).calm, false);
});

test("W1-T11129 criterion 2: the governor's learned cpu bound holds the width without stopping a lane", () => {
  const held = run({ effectiveWidth: 3, healthySamples: 2 }, { activeWorkers: 1, laneCpuBound: 4 });
  assert.equal(held.reason, "cpu-capacity-held");
  assert.equal(held.effectiveWidth, 3);
  assert.equal(held.evidence.healthySamples, 0);
  const room = run({ effectiveWidth: 3, healthySamples: 2 }, { activeWorkers: 1, laneCpuBound: 6 });
  assert.notEqual(room.reason, "cpu-capacity-held");
});

test("W1-T11129 criterion 2: width grows back on its own once the pressure eases", () => {
  let state: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
  const stressed = selectAdaptiveReviewWidth(state, POLICY, observation({ cpuPsiFullAvg10Pct: 60 }), BOUNDS);
  assert.equal(stressed.decision.effectiveWidth, 1);
  state = stressed.state;
  const calm = selectAdaptiveReviewWidth(state, POLICY, observation({ cpuPsiFullAvg10Pct: 1 }), BOUNDS);
  assert.equal(calm.decision.effectiveWidth, 4);
  assert.notEqual(calm.decision.reason, "cpu-pressure");
});

test("W1-T11129 criterion 2: cpuWeightShare is the container's weight over the running total", () => {
  assert.equal(cpuWeightShare(100, [100, 300]), 0.25);
  assert.equal(cpuWeightShare(0, [100]), undefined);
  assert.equal(cpuWeightShare(100, []), undefined);
});
