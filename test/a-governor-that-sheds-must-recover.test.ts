import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "../src/lib/review-capacity.js";

// W1-T2992 — A GOVERNOR THAT CAN SHED MUST PROVE IT CAN RECOVER.
//
// MEASURED across the full ledger union, every adaptive review-width decision ever taken:
//     effective_width ever observed ... {1: 311, 2: 290}   <- the MAXIMUM of 3 never occurred
//     healthy_samples histogram ...... {0: 596, 1: 5}      <- needs 3; reached 1 five times, 2 never
// 601 decisions, and the third lane — what policy calls "temporary capacity earned by a sustained
// healthy window" — was never once earned. Dispatch, by contrast, ran three-wide 151 times when it
// was configured at 3: a static bound with evidence works, this adaptive one had never functioned.
//
// THREE DEFECTS OF ONE SHAPE WERE FOUND IN A SINGLE DAY, all "shed easily, recover never":
//   W1-T2985  the cpu shed read PSI `some` (saturation, 80.57%) not `full` (starvation, 0.00%)
//   W1-T2987  provider telemetry expired 60s after a worker spawn and gated every recovery
//   W1-T2987  `effectiveWidth = Math.min(effectiveWidth, baseWidth)` — from the floor, min(1,2) = 1
// Each held for months while every reading looked healthy. This file is the invariant that would
// have caught all three at authoring time: drive the controller from the FLOOR under steady healthy
// observations and assert it climbs.

const POLICY = {
  hostWorkerBudget: 16,
  workerMemoryReserveMib: 1536,
  healthyWindowSamples: 3,
  sampleCadenceMs: 60_000,
  telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5,
  cpuPsiHighPct: 20,
  memoryPsiLowPct: 5,
  memoryPsiHighPct: 15,
  providerAllowancePct: 2,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
} as unknown as ReviewCapacityPolicy;

const BOUNDS = { minWidth: 1, baseWidth: 2, maxWidth: 3 };

/** Everything healthy, a sustained backlog, and full telemetry — the condition under which the
 *  advertised ceiling is supposed to be earned. Nothing here is marginal: if the controller cannot
 *  climb on this observation it cannot climb on any. */
function steadyHealthy(over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    memAvailableMib: 28_000,
    cpuPsiSomeAvg10Pct: 0.03,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    activeWorkers: 0,
    queueDepth: 9,
    settlements: { failures: 0, timeouts: 0, successes: 5, baselineLatencyMs: 1000, recentLatencyMs: 1000 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
    ...over,
  } as unknown as ReviewCapacityObservation;
}

/** Run the controller forward, feeding its own state back, the way the sampler does. */
function drive(from: ReviewCapacityState, samples: number, obs = steadyHealthy()): ReviewCapacityState {
  let state = from;
  for (let i = 0; i < samples; i++) state = selectAdaptiveReviewWidth(state, POLICY, obs, BOUNDS).state;
  return state;
}

test("W1-T2992: a shed width recovers to base under steady healthy observations", () => {
  // RECOVERY IS EARNED, NOT INSTANT, and that is the design: `healthyWindowSamples` of sustained
  // health buys one step. The invariant is that the climb HAPPENS AT ALL — every defect this file
  // exists for made it unreachable rather than slow, by resetting `healthySamples` to 0 on a shed
  // that fired on a healthy condition. Measured curve from the floor on steady-healthy input:
  //     sample 1 -> 1, sample 2 -> 1, sample 3 -> 2 (base), sample 4 -> 3 (max)
  const floored: ReviewCapacityState = { effectiveWidth: BOUNDS.minWidth, healthySamples: 0 };
  const after = drive(floored, POLICY.healthyWindowSamples);
  assert.ok(
    after.effectiveWidth >= BOUNDS.baseWidth,
    `a floored governor must reach at least base within its own healthy window (got ${after.effectiveWidth}). ` +
      "In production this never happened: 601 decisions, width 3 never observed, healthy_samples never " +
      "past 1 of 3 — because a shed fired on a healthy condition and zeroed the window every sample",
  );
});

test("W1-T2992: recovery never overshoots the earned ceiling", () => {
  const floored: ReviewCapacityState = { effectiveWidth: BOUNDS.minWidth, healthySamples: 0 };
  const after = drive(floored, 12);
  assert.equal(
    after.effectiveWidth,
    BOUNDS.maxWidth,
    "sustained health settles AT the ceiling, never above it",
  );
  const stillHealthy = drive(after, 5);
  assert.equal(stillHealthy.effectiveWidth, BOUNDS.maxWidth, "and stays there rather than oscillating");
});

test("W1-T2992: the advertised maximum is reachable under sustained health", () => {
  // The ceiling policy advertises must be REACHABLE, or it is not a ceiling — it is a number in a
  // config file. `healthyWindowSamples` is 3, so a generous window is driven here: if the maximum
  // cannot be earned in ten consecutive perfectly-healthy samples with a sustained backlog, it
  // cannot be earned in production either, and the honest response is to DELETE the earn-back
  // mechanism and run a static width, exactly as this task's shard permits.
  const based: ReviewCapacityState = { effectiveWidth: BOUNDS.baseWidth, healthySamples: 0 };
  const after = drive(based, 10);
  assert.equal(
    after.effectiveWidth,
    BOUNDS.maxWidth,
    `the maximum of ${BOUNDS.maxWidth} was never reached in ten steady-healthy samples (ended at ` +
      `${after.effectiveWidth}, healthySamples ${after.healthySamples}). MEASURED in production: 601 ` +
      "decisions, width 3 never once observed, healthy_samples never past 1 of 3. A ceiling that " +
      "cannot be earned is a floor with extra steps and three ways to fail closed",
  );
});

// The two tests above establish that recovery is reachable under IDEAL input. That is necessary and
// not sufficient: both W1-T2985 and W1-T2987 left recovery reachable in the ideal case and blocked
// it in the case the fleet actually ran in. These two drive the MEASURED production observations.

test("W1-T2992: a saturated-but-not-starved box still recovers", () => {
  // MEASURED on the fleet 2026-09-06 while two builds and a retro ran healthily on 8 cores:
  // cpu `some avg10=80.57`, cpu `full avg10=0.00`. Against a shed threshold of 20 read from `some`,
  // this pinned width at the floor permanently and zeroed the healthy window every sample.
  const saturated = steadyHealthy({ cpuPsiSomeAvg10Pct: 80.57, cpuPsiFullAvg10Pct: 0 } as Partial<ReviewCapacityObservation>);
  const floored: ReviewCapacityState = { effectiveWidth: BOUNDS.minWidth, healthySamples: 0 };
  const after = drive(floored, POLICY.healthyWindowSamples * 2, saturated);
  assert.ok(
    after.effectiveWidth >= BOUNDS.baseWidth,
    `heavy cpu saturation with zero starvation must not block recovery (got ${after.effectiveWidth}). ` +
      "Reading PSI `some` here is what pinned the fleet's review lane at 1",
  );
});

test("W1-T2992: a quiet provider snapshot still recovers to base", () => {
  // MEASURED: `telemetry-unavailable` was the largest shed reason at 347 of 670 rows, because
  // provider-routing-status.json is fresh for 60s and rewritten only when a worker spawns — so it is
  // stale for most of a long build, and the branch then ran Math.min(effectiveWidth, baseWidth),
  // which from the floor is min(1, 2) = 1.
  const quiet = steadyHealthy({
    provider: { fresh: false, readable: false, refused: undefined, headroomPct: undefined, reservePct: undefined },
  } as Partial<ReviewCapacityObservation>);
  const floored: ReviewCapacityState = { effectiveWidth: BOUNDS.minWidth, healthySamples: 0 };
  const after = drive(floored, 3, quiet);
  assert.equal(
    after.effectiveWidth,
    BOUNDS.baseWidth,
    `an absent provider reading must still permit the base width (got ${after.effectiveWidth}); only the ` +
      "lane ABOVE base is earned capacity requiring real provider telemetry",
  );
});
