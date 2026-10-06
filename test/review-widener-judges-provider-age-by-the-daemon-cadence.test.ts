// The review widener reads `provider-routing-status.json`, whose `freshUntil` is the ROUTER's 60 s
// cache validity and which is rewritten only when a worker spawns. MEASURED 2026-10-05/06 on the
// fleet: `provider-telemetry-unavailable` was the commonest `review.capacity` reason (142 of 316
// rows) at provider_status_age_ms ~500-800 s, so lane five (plan/policy.yaml `reviewLanes.max`) was
// almost never earnable. The fix judges a lapsed reading against the daemon's own sampling cadence,
// the bound #9370 gave analytics. These tests drive the REAL projection into the REAL controller.
import assert from "node:assert/strict";
import { test } from "node:test";

import { HEADROOM_SAMPLE_MAX_AGE_MS } from "../src/lib/daemon.js";
import type { ProviderRoutingStatus } from "../src/lib/provider-routing-status.js";
import * as reviewCapacity from "../src/lib/review-capacity.js";
import {
  initialReviewCapacityState,
  reviewProviderObservation,
  selectAdaptiveReviewWidth,
  type ReviewCapacityDecision,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
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

// The 2026-10-06 operator ruling's shape: base 4, room to earn 5.
const BOUNDS = { baseWidth: 4, minWidth: 1, maxWidth: 5 };
const T0 = Date.parse("2026-10-06T14:00:00Z");
// Read off the namespace, not a named import: at a base without the export a named import fails the
// whole file at LOAD, which reads as "could not execute" rather than the red these tests must show.
const MAX_AGE_MS = 3 * HEADROOM_SAMPLE_MAX_AGE_MS;

/** A routing snapshot written `ageMs` before `nowMs` with the router's 60 s cache, so any age past
 *  a minute reads `stale` exactly as `readProviderRoutingStatus` would report it. */
function snapshot(nowMs: number, ageMs: number, over: Partial<ProviderRoutingStatus> = {}): ProviderRoutingStatus {
  const observedMs = nowMs - ageMs;
  return {
    version: 1,
    state: "selected",
    freshness: ageMs <= 60_000 ? "fresh" : "stale",
    reservePercent: 5,
    observedAt: new Date(observedMs).toISOString(),
    freshUntil: new Date(observedMs + 60_000).toISOString(),
    providers: [{ provider: "claude", readable: true, windows: [{ name: "session", usedPercent: 40 }] }],
    ...over,
  } as ProviderRoutingStatus;
}

function hostHealthy(nowMs: number, provider: ProviderRoutingStatus, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs,
    queueDepth: 12,
    activeWorkers: 2,
    memAvailableMib: 6_700,
    cpuPsiSomeAvg10Pct: 30,
    cpuPsiFullAvg10Pct: 0,
    memoryPsiSomeAvg10Pct: 0,
    provider: reviewProviderObservation(provider, nowMs),
    settlements: { successes: 4, failures: 0, timeouts: 0 },
    ...over,
  };
}

/** Run the controller once a minute for `samples` minutes, the provider reading `ageMs` old each time. */
function run(
  samples: number,
  ageMs: number,
  over: (nowMs: number) => Partial<ReviewCapacityObservation> = () => ({}),
  statusOver: Partial<ProviderRoutingStatus> = {},
): ReviewCapacityDecision[] {
  let state = initialReviewCapacityState(BOUNDS.baseWidth);
  const decisions: ReviewCapacityDecision[] = [];
  for (let i = 0; i < samples; i += 1) {
    const nowMs = T0 + i * 60_000;
    const result = selectAdaptiveReviewWidth(state, POLICY, hostHealthy(nowMs, snapshot(nowMs, ageMs, statusOver), over(nowMs)), BOUNDS);
    state = result.state;
    decisions.push(result.decision);
  }
  return decisions;
}

test("a router-lapsed but recent provider reading lets a healthy host widen the review lanes to max", () => {
  const decisions = run(5, 640_000);
  const last = decisions.at(-1)!;
  assert.equal(last.effectiveWidth, BOUNDS.maxWidth, "a 640 s reading is the fleet's normal case and must earn lane five");
  assert.equal(last.reason, "healthy-window");
  assert.equal(last.evidence.providerFresh, true);
  assert.equal(last.evidence.providerCacheLapsed, true, "the row says the router cache had lapsed");
  assert.ok(decisions.every((d) => d.reason !== "provider-telemetry-unavailable"));
});

test("a provider reading older than three daemon sampling intervals still cannot widen past base", () => {
  const decisions = run(5, MAX_AGE_MS + 1);
  assert.ok(decisions.every((d) => d.effectiveWidth === BOUNDS.baseWidth), "genuinely stale telemetry earns nothing");
  assert.ok(decisions.every((d) => d.reason === "provider-telemetry-unavailable"));
  assert.equal(decisions.at(-1)!.evidence.providerCacheLapsed, false);
});

test("an unknown provider reading on an unhealthy host sheds instead of widening", () => {
  let state = initialReviewCapacityState(BOUNDS.baseWidth);
  const unknown = { version: 1, state: "unknown", freshness: "unknown", reason: "absent" } as unknown as ProviderRoutingStatus;
  for (let i = 0; i < 5; i += 1) {
    const nowMs = T0 + i * 60_000;
    const observation = hostHealthy(nowMs, unknown, { memoryPsiSomeAvg10Pct: 22 });
    assert.equal(observation.provider.fresh, false);
    const result = selectAdaptiveReviewWidth(state, POLICY, observation, BOUNDS);
    state = result.state;
    assert.equal(result.decision.reason, "memory-pressure");
  }
  assert.equal(state.effectiveWidth, BOUNDS.minWidth);
});

test("memory pressure still sheds review lanes while the provider reading is lapsed but recent", () => {
  const widened = run(5, 640_000);
  assert.equal(widened.at(-1)!.effectiveWidth, BOUNDS.maxWidth);
  const reserve = run(3, 640_000, () => ({ memAvailableMib: 1_000 }));
  assert.deepEqual(reserve.map((d) => [d.effectiveWidth, d.reason]), [
    [3, "memory-reserve"],
    [2, "memory-reserve"],
    [1, "memory-reserve"],
  ]);
  const psi = run(2, 640_000, () => ({ memoryPsiSomeAvg10Pct: 15 }));
  assert.deepEqual(psi.map((d) => d.reason), ["memory-pressure", "memory-pressure"]);
});

test("a lapsed blocked provider reading is neither a refusal nor an authorisation", () => {
  const nowMs = T0;
  const blocked = snapshot(nowMs, 640_000, { state: "blocked", providers: [] });
  assert.deepEqual(reviewProviderObservation(blocked, nowMs), { fresh: false, readable: false, ageMs: 640_000 });
  const decisions = run(5, 640_000, () => ({}), { state: "blocked", providers: [] });
  assert.ok(decisions.every((d) => d.effectiveWidth === BOUNDS.baseWidth && d.reason === "provider-telemetry-unavailable"));
});

test("the provider-age bound is three of the daemon's own headroom sampling intervals", () => {
  assert.equal(reviewCapacity.REVIEW_PROVIDER_READING_MAX_AGE_MS, MAX_AGE_MS);
  const nowMs = T0;
  assert.equal(reviewProviderObservation(snapshot(nowMs, MAX_AGE_MS), nowMs).fresh, true, "the bound is inclusive");
  assert.equal(reviewProviderObservation(snapshot(nowMs, 30_000), nowMs).cacheLapsed, undefined, "a router-fresh reading is not lapsed");
});
