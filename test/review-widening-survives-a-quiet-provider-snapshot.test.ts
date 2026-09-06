import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectAdaptiveReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "../src/lib/review-capacity.js";

// W1-T2987 — REVIEW WIDENING MUST SURVIVE A QUIET PROVIDER SNAPSHOT.
//
// `provider-routing-status.json` carries `freshUntil = observedAt + 60s` and is rewritten only when
// a WORKER SPAWNS. During a long build nothing spawns, so it expires a minute in and stays expired —
// and review widening then depends on a signal that only the work whose absence makes widening
// matter can refresh. MEASURED across the ledger union: `telemetry-unavailable` was the LARGEST
// shed reason at 347 of 670 rows (cpu-pressure 111, host-worker-budget 22), with `effective_width`
// at the floor in 310 samples against 289 at base — while those same rows showed host telemetry
// perfectly readable (`cpu_psi_some 3.16`, `mem_available_mib 26516`, `memory_psi_some 0`) and only
// `provider_fresh False`, `provider_readable False`, headroom/reserve `None`, age 263410 ms.

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

/** The measured fleet condition: host readable, provider snapshot quiet and unrefused. */
function quietProvider(overrides: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    memAvailableMib: 26516,
    cpuPsiSomeAvg10Pct: 3.16,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    activeWorkers: 0,
    queueDepth: 5,
    settlements: { failures: 0, timeouts: 0, successes: 5, baselineLatencyMs: 1000, recentLatencyMs: 1000 },
    provider: { fresh: false, readable: false, refused: undefined, headroomPct: undefined, reservePct: undefined },
    ...overrides,
  } as unknown as ReviewCapacityObservation;
}

test("W1-T2987: a stale-but-unrefused provider snapshot still permits the base width", () => {
  // Shed to the floor first — exactly the state the fleet was pinned in.
  const prior: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
  const { decision } = selectAdaptiveReviewWidth(prior, POLICY, quietProvider(), BOUNDS);

  assert.equal(
    decision.effectiveWidth,
    2,
    "width climbs back toward base on host telemetry alone. Before this task the branch ran " +
      "Math.min(effectiveWidth, baseWidth), which from the floor is min(1, 2) = 1 — so a width shed " +
      "for any reason could never recover while the provider snapshot was quiet, which is most of " +
      "the time during a long build.",
  );
  assert.equal(
    decision.reason,
    "provider-telemetry-unavailable",
    "and the reason distinguishes an absent PROVIDER reading from an unreadable HOST",
  );
});

test("W1-T2987: a quiet provider snapshot never authorises more than the base width", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 2, healthySamples: 99 };
  const { decision } = selectAdaptiveReviewWidth(prior, POLICY, quietProvider(), BOUNDS);
  assert.equal(
    decision.effectiveWidth,
    2,
    "the lane ABOVE base is earned capacity and still requires real provider telemetry",
  );
});

test("W1-T2987: a refusing provider still blocks widening", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 2, healthySamples: 0 };
  const refusing = quietProvider({
    provider: { fresh: true, readable: true, refused: true, headroomPct: 50, reservePct: 5 },
  } as Partial<ReviewCapacityObservation>);
  const { decision } = selectAdaptiveReviewWidth(prior, POLICY, refusing, BOUNDS);
  assert.equal(decision.reason, "provider-refused", "a real refusal is a signal, not an absence");
  assert.equal(decision.effectiveWidth, 1, "and it still sheds a lane");
});

test("W1-T2987: an unreadable HOST still pins the width, unchanged", () => {
  const prior: ReviewCapacityState = { effectiveWidth: 1, healthySamples: 0 };
  const blindHost = quietProvider({ memAvailableMib: undefined } as Partial<ReviewCapacityObservation>);
  const { decision } = selectAdaptiveReviewWidth(prior, POLICY, blindHost, BOUNDS);
  assert.equal(decision.reason, "telemetry-unavailable", "the host arm is untouched");
  assert.equal(decision.effectiveWidth, 1, "with the host unreadable nothing can be authorised");
});
