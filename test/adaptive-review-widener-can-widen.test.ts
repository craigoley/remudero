// W1-T3025 — THE ADAPTIVE REVIEW WIDENER HAS NEVER WIDENED. 718 decisions since 2026-09-05, 0
// above base_width, `healthy-window` firing 5 times in three days, 59% of refusals missing
// telemetry rather than observed pressure. `selectAdaptiveReviewWidth` (W1-T2987, W1-T3031,
// W1-T2985) already carries the fix as PURE logic; this file is the first test that drives the
// widening arm, the pressure-narrowing arm and the observed/absent split end-to-end, against the
// controller's OWN bounds argument (`ReviewCapacityBounds`), rather than proving one isolated
// diagnostic field in passing.
//
// `plan/policy.yaml`'s operator-set `reviewLanes.max === reviewLanes.value` (both 3) closes the
// room ABOVE base in PRODUCTION today — that ceiling belongs to the operator, not this reader,
// and raising it is explicitly out of this task's scope. The claim under test is that the PURE
// controller's widening arm is reachable and correct for whatever bounds a caller supplies; a
// unit test proves exactly that, independent of the currently-committed policy row.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "../src/lib/review-capacity.js";

const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 8,
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

// baseWidth 2, maxWidth 4: room ABOVE base_width so the widening arm has somewhere to go.
const BOUNDS = { baseWidth: 2, minWidth: 1, maxWidth: 4 };

function healthy(nowMs: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs,
    queueDepth: 5,
    activeWorkers: 0,
    memAvailableMib: 4096,
    cpuPsiSomeAvg10Pct: 1,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 1,
    provider: { fresh: true, readable: true, headroomPct: 80, reservePct: 5, ageMs: 1_000 },
    settlements: { successes: 2, failures: 0, timeouts: 0 },
    ...over,
  };
}

function decide(state: ReviewCapacityState, observation: ReviewCapacityObservation) {
  return selectAdaptiveReviewWidth(state, POLICY, observation, BOUNDS);
}

test("claim: a sustained window healthy on every reading the host CAN supply widens above base_width", () => {
  let state = initialReviewCapacityState(BOUNDS.baseWidth);

  let result = decide(state, healthy(0));
  assert.equal(result.decision.reason, "healthy-window");
  assert.equal(result.decision.effectiveWidth, BOUNDS.baseWidth, "sample 1 of 3 only accrues the window");
  state = result.state;

  result = decide(state, healthy(60_000));
  assert.equal(result.decision.effectiveWidth, BOUNDS.baseWidth, "sample 2 of 3 still below threshold");
  state = result.state;

  // The third sustained-healthy sample crosses `policy.healthyWindowSamples` — the widening arm
  // MUST be reachable here, and this assertion is the one that fails if it is not.
  result = decide(state, healthy(120_000));
  assert.equal(result.decision.reason, "healthy-window");
  assert.equal(result.decision.evidence.healthySamples, POLICY.healthyWindowSamples);
  assert.ok(
    result.decision.effectiveWidth > BOUNDS.baseWidth,
    `widening arm unreachable: effectiveWidth ${result.decision.effectiveWidth} did not exceed base_width ${BOUNDS.baseWidth}`,
  );
  assert.equal(result.decision.effectiveWidth, BOUNDS.baseWidth + 1);
  state = result.state;

  // A further sustained-healthy window climbs again, up to max_width — proving a real earned
  // arm rather than a one-shot artifact of the threshold boundary above.
  result = decide(state, healthy(180_000));
  assert.equal(result.decision.effectiveWidth, BOUNDS.baseWidth + 2);
  assert.equal(result.decision.effectiveWidth, BOUNDS.maxWidth);
});

test("claim: genuine pressure observed at 75.9% PSI still narrows — current behaviour unchanged", () => {
  const state = initialReviewCapacityState(BOUNDS.baseWidth);
  const result = decide(state, healthy(0, { activeWorkers: 1, cpuPsiFullAvg10Pct: 75.9 }));
  assert.equal(result.decision.reason, "cpu-pressure");
  assert.equal(result.decision.effectiveWidth, BOUNDS.baseWidth - 1, "direct pressure sheds one lane");
  assert.equal(result.decision.evidence.healthySamples, 0, "observed pressure clears any accrued healthy window");
  assert.equal(result.decision.evidence.cpuPsiFullAvg10Pct, 75.9, "the observed reading is carried, not rounded away");
  assert.deepEqual(result.decision.evidence.absentHostReadings, [], "this narrowing came from a READING, not an absence");
});

test("claim: an unreadable telemetry sample is distinguished from an unhealthy one — missing readings cannot masquerade as observed pressure", () => {
  const missing = (nowMs: number) =>
    healthy(nowMs, {
      cpuPsiSomeAvg10Pct: undefined,
      cpuPsiFullAvg10Pct: undefined,
      memoryPsiSomeAvg10Pct: undefined,
      memAvailableMib: undefined,
    });

  // Real, repeatedly OBSERVED pressure sheds one lane EVERY sample until it hits the floor.
  let pressuredState = initialReviewCapacityState(BOUNDS.baseWidth);
  for (const nowMs of [0, 60_000, 120_000]) {
    const result = decide(pressuredState, healthy(nowMs, { cpuPsiFullAvg10Pct: 75.9 }));
    assert.equal(result.decision.reason, "cpu-pressure");
    pressuredState = result.state;
  }
  assert.equal(pressuredState.effectiveWidth, BOUNDS.minWidth, "repeated observed pressure decays toward min_width");

  // The same NUMBER of samples, but each one an unreadable/ABSENT reading rather than an
  // observed one, must be distinguished from that pressure stream: it holds at base_width
  // instead of decaying the way genuine pressure does. If a missing reading masqueraded as
  // observed pressure, this loop would also bottom out at min_width — it must not.
  let missingState = initialReviewCapacityState(BOUNDS.baseWidth);
  for (const nowMs of [0, 60_000, 120_000]) {
    const result = decide(missingState, missing(nowMs));
    assert.equal(result.decision.reason, "telemetry-unavailable", "an unreadable sample is its own reason, never cpu-pressure");
    assert.notEqual(result.decision.reason, "cpu-pressure");
    missingState = result.state;
  }
  assert.equal(
    missingState.effectiveWidth,
    BOUNDS.baseWidth,
    "a stream of unreadable/missing readings must hold at base_width, not masquerade as observed pressure and decay toward min_width",
  );
});

test("claim: the decision row names whether a refusal is OBSERVED or ABSENT, re-derivable from evidence alone", () => {
  // A reader holding only the ledger row — never re-reading source — must be able to tell these
  // two refusal kinds apart using nothing but `reason` and `absentHostReadings`.
  const classify = (evidence: { readonly absentHostReadings: readonly string[] }): "OBSERVED" | "ABSENT" =>
    evidence.absentHostReadings.length > 0 ? "ABSENT" : "OBSERVED";

  const observedRefusal = decide(initialReviewCapacityState(BOUNDS.baseWidth), healthy(0, { cpuPsiFullAvg10Pct: 75.9 }));
  assert.equal(observedRefusal.decision.reason, "cpu-pressure");
  assert.deepEqual(observedRefusal.decision.evidence.absentHostReadings, []);
  assert.equal(classify(observedRefusal.decision.evidence), "OBSERVED");

  const absentRefusal = decide(
    initialReviewCapacityState(BOUNDS.baseWidth),
    healthy(0, { cpuPsiFullAvg10Pct: undefined }),
  );
  assert.equal(absentRefusal.decision.reason, "telemetry-unavailable");
  assert.deepEqual(absentRefusal.decision.evidence.absentHostReadings, ["cpu_psi_full_avg10_pct"]);
  assert.equal(classify(absentRefusal.decision.evidence), "ABSENT");

  // The decision row's own fields discriminate the two refusal kinds without any other source of
  // truth: same shape of evidence, opposite verdict, purely from `reason`/`absentHostReadings`.
  assert.notEqual(observedRefusal.decision.reason, absentRefusal.decision.reason);
  assert.notEqual(
    classify(observedRefusal.decision.evidence),
    classify(absentRefusal.decision.evidence),
  );
});
