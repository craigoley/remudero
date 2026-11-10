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
} from "#src/lib/review-capacity.js";
import { DEFAULT_SWEEP_POLICY } from "#src/lib/sweep.js";

const POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 8,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
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
    // W1-T11129: a learned cpu.weight share of 1 (the container is the whole host, so its PSI has no weight excuse);
    // with no share the CPU verdict holds and neither sheds nor widens on PSI alone.
    cpuWeightShare: 1,
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

// ── W1-T11841 — the SHIPPED bounds: the ceiling is hostWorkerBudget, not reviewLanes.max ─────────
//
// Driven with DEFAULT_SWEEP_POLICY's own reviewCapacity and {reviewLanes, reviewLaneMin,
// reviewLaneMax}, so a regression of the ceiling to the policy row's max (5) reddens here.

const SHIPPED = DEFAULT_SWEEP_POLICY.reviewCapacity;
const SHIPPED_BOUNDS = {
  baseWidth: DEFAULT_SWEEP_POLICY.reviewLanes,
  minWidth: DEFAULT_SWEEP_POLICY.reviewLaneMin,
  maxWidth: DEFAULT_SWEEP_POLICY.reviewLaneMax,
};

function shippedHealthy(nowMs: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return healthy(nowMs, { queueDepth: 50, ...over });
}

/** Drives `samples` cadence-spaced samples, returning every decision. */
function drive(
  start: ReviewCapacityState,
  samples: number,
  over: Partial<ReviewCapacityObservation> = {},
  firstAtMs = 0,
) {
  let state = start;
  const decisions = [];
  for (let i = 0; i < samples; i += 1) {
    const result = selectAdaptiveReviewWidth(
      state,
      SHIPPED,
      shippedHealthy(firstAtMs + i * SHIPPED.sampleCadenceMs, over),
      SHIPPED_BOUNDS,
    );
    decisions.push(result.decision);
    state = result.state;
  }
  return { state, decisions };
}

test("claim: sustained healthy windows widen past 5, one lane per window, up to hostWorkerBudget and never past it", () => {
  assert.ok(SHIPPED_BOUNDS.maxWidth > 5, "the shipped ceiling must exceed the policy row's max of 5");
  assert.equal(SHIPPED_BOUNDS.maxWidth, SHIPPED.hostWorkerBudget);
  const { decisions } = drive(
    initialReviewCapacityState(SHIPPED_BOUNDS.baseWidth),
    SHIPPED.healthyWindowSamples + (SHIPPED.hostWorkerBudget - SHIPPED_BOUNDS.baseWidth) + 4,
  );
  const widths = decisions.map((d) => d.effectiveWidth);
  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i]! - widths[i - 1]! <= 1, `one lane per healthy window, got ${widths.join(",")}`);
  }
  assert.ok(widths.includes(6), `the width passes 5: ${widths.join(",")}`);
  assert.equal(Math.max(...widths), SHIPPED.hostWorkerBudget, "the width reaches the budget");
  assert.equal(widths[widths.length - 1], SHIPPED.hostWorkerBudget, "and never goes past it");
});

test("claim: with active workers present the width stops at the room they leave and records host-worker-budget", () => {
  const activeWorkers = 3;
  const { decisions } = drive(initialReviewCapacityState(SHIPPED_BOUNDS.baseWidth), 20, { activeWorkers });
  const room = SHIPPED.hostWorkerBudget - activeWorkers;
  const widths = decisions.map((d) => d.effectiveWidth);
  assert.equal(Math.max(...widths), room, `width stops at the room: ${widths.join(",")}`);
  assert.equal(decisions[decisions.length - 1]!.reason, "host-worker-budget");
  for (const d of decisions) assert.ok(d.effectiveWidth + activeWorkers <= SHIPPED.hostWorkerBudget);
});

test("claim: every refusal still blocks a widen and never admits past the budget", () => {
  // From width 6 with a full healthy window banked: the next healthy sample WOULD widen to 7.
  const earned: ReviewCapacityState = {
    effectiveWidth: 6,
    healthySamples: SHIPPED.healthyWindowSamples,
    lastHealthySampleAtMs: 0,
  };
  const at = 10 * SHIPPED.sampleCadenceMs;
  const control = selectAdaptiveReviewWidth(earned, SHIPPED, shippedHealthy(at), SHIPPED_BOUNDS);
  assert.equal(control.decision.reason, "healthy-window");
  assert.equal(control.decision.effectiveWidth, 7, "control: the unrefused sample widens");

  const latency = { baselineLatencyMs: 1000, recentLatencyMs: 5000, recentLatencySamples: 5, baselineLatencySamples: 6 };
  const cases: ReadonlyArray<[string, Partial<ReviewCapacityObservation>]> = [
    ["cpu-pressure", { cpuPsiFullAvg10Pct: 75.9 }],
    ["memory-pressure", { memoryPsiSomeAvg10Pct: 50 }],
    ["memory-reserve", { memAvailableMib: 100 }],
    ["provider-refused", { provider: { fresh: true, readable: true, headroomPct: 80, reservePct: 5, refused: true } }],
    ["provider-headroom", { provider: { fresh: true, readable: true, headroomPct: 6, reservePct: 5, ageMs: 1_000 } }],
    ["review-unhealthy", { settlements: { successes: 2, failures: 2, timeouts: 0 } }],
    ["review-latency-expanded", { memoryPsiSomeAvg10Pct: 10, settlements: { successes: 2, failures: 0, timeouts: 0, ...latency } }],
    ["review-latency-uncorroborated", { settlements: { successes: 2, failures: 0, timeouts: 0, ...latency } }],
    ["review-history-insufficient", { settlements: { successes: 0, failures: 0, timeouts: 0 } }],
    ["telemetry-unavailable", { memAvailableMib: undefined }],
    ["backlog-not-sustained", { queueDepth: 2 }],
  ];
  for (const [reason, over] of cases) {
    for (const activeWorkers of [0, 1]) {
      const result = selectAdaptiveReviewWidth(
        earned,
        SHIPPED,
        shippedHealthy(at, { activeWorkers, ...over }),
        SHIPPED_BOUNDS,
      );
      assert.equal(result.decision.reason, reason, `${reason} fires`);
      assert.ok(result.decision.effectiveWidth <= 6, `${reason} must not widen, got ${result.decision.effectiveWidth}`);
      assert.ok(
        result.decision.effectiveWidth + activeWorkers <= SHIPPED.hostWorkerBudget,
        `${reason} admits past the budget`,
      );
    }
  }
});
