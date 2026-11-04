import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  summarizeReviewSettlements,
  type ReviewCapacityDecision,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";

// W1-T11150 — a CPU shed that does not lower core's CPU pressure stops shedding and hands its lanes
// back, and width restores in proportion to the relief. The tests drive the real controller with
// sample sequences: shed then flat, shed then falling, falling then rising.

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
  settlementWindowMs: 1_800_000,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
} as unknown as ReviewCapacityPolicy;

const BOUNDS = { minWidth: 1, baseWidth: 4, maxWidth: 4 };
/** The measured CPU phase of a review: the shed is judged once this has elapsed. */
const SETTLE_MS = 60_000;

function sample(nowMs: number, cpuFull: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs,
    memAvailableMib: 28_000,
    cpuPsiSomeAvg10Pct: 80,
    cpuPsiFullAvg10Pct: cpuFull,
    memoryPsiSomeAvg10Pct: 0,
    activeWorkers: 0,
    queueDepth: 9,
    // Load far above cores + active workers: attributed to `host-load`, as all 78 measured sheds were.
    hostLoad1: 40,
    hostCpuCount: 8,
    settlements: { failures: 0, timeouts: 0, successes: 5, cpuPhaseMs: SETTLE_MS },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
    ...over,
  } as unknown as ReviewCapacityObservation;
}

/** Feed a sequence of `[offsetMs, cpuFull]` samples; returns each decision and the final state. */
function run(
  steps: ReadonlyArray<readonly [number, number, Partial<ReviewCapacityObservation>?]>,
  start: ReviewCapacityState = initialReviewCapacityState(BOUNDS.baseWidth),
  policy: ReviewCapacityPolicy = POLICY,
): { decisions: ReviewCapacityDecision[]; state: ReviewCapacityState } {
  let state = start;
  const decisions: ReviewCapacityDecision[] = [];
  for (const [at, cpu, over] of steps) {
    const result = selectAdaptiveReviewWidth(state, policy, sample(1_000_000 + at, cpu, over), BOUNDS);
    state = result.state;
    decisions.push(result.decision);
  }
  return { decisions, state };
}

const widths = (decisions: ReviewCapacityDecision[]): number[] => decisions.map((d) => d.effectiveWidth);

test("test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: a flat shed hands its lanes back and suspends", () => {
  const { decisions } = run([
    [0, 40],
    [10_000, 40],
    [20_000, 40],
    [60_000, 40], // settled: the reading did not fall by more than its own spread
    [70_000, 40],
    [80_000, 40],
  ]);
  assert.deepEqual(widths(decisions).slice(0, 3), [3, 2, 1], "sheds as before while the check is pending");
  assert.equal(decisions[0]!.evidence.shedEffect, "pending");
  assert.equal(decisions[0]!.evidence.shedReading, 40, "the shedding reading is recorded");
  assert.equal(decisions[3]!.effectiveWidth, 4, "the width returns to what it was before the shed");
  assert.equal(decisions[3]!.evidence.shedEffect, "ineffective");
  assert.equal(decisions[3]!.evidence.shedSuspended, true);
  assert.equal(decisions[4]!.effectiveWidth, 4, "further cpu sheds on that source are suspended");
  assert.notEqual(decisions[4]!.reason, "cpu-pressure");
  assert.equal(decisions[5]!.effectiveWidth, 4);
  assert.equal(decisions[5]!.evidence.shedSuspended, true);
});

test("test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: noise inside the spread is not relief", () => {
  // A reading that bounces by ~3 each sample has a spread of ~3; a 2-point fall is inside it.
  const { decisions } = run([
    [0, 40],
    [10_000, 43],
    [20_000, 40],
    [30_000, 43],
    [60_000, 38],
  ]);
  assert.equal(decisions[4]!.evidence.shedEffect, "ineffective");
  assert.equal(decisions[4]!.effectiveWidth, 4);
  assert.ok((decisions[4]!.evidence.noiseBand ?? 0) >= 3, "the spread used is recorded");
});

test("test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: suspension lifts when the source changes", () => {
  const flat = run([
    [0, 40],
    [10_000, 40],
    [60_000, 40],
    [70_000, 40],
  ]);
  assert.equal(flat.decisions[3]!.evidence.shedSuspended, true);
  const changed = run([[80_000, 40, { hostLoad1: 4 }]], flat.state); // load now explained by cores
  assert.equal(changed.decisions[0]!.reason, "cpu-pressure", "a different pressure source sheds again");
  assert.equal(changed.decisions[0]!.evidence.shedSuspended, false);
  assert.equal(changed.decisions[0]!.effectiveWidth, 3);
});

test("test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: suspension lifts when the review lane's CPU share rises", () => {
  const flat = run(
    [
      [0, 40, { reviewCpuChildren: 1 }],
      [10_000, 40, { reviewCpuChildren: 1 }],
      [60_000, 40, { reviewCpuChildren: 1 }],
      [70_000, 40, { reviewCpuChildren: 1 }],
    ],
  );
  assert.equal(flat.decisions[3]!.evidence.shedSuspended, true, "same share, same source: still suspended");
  const grew = run([[80_000, 40, { reviewCpuChildren: 3 }]], flat.state);
  assert.equal(grew.decisions[0]!.reason, "cpu-pressure", "more review children in their CPU phase lifts it");
});

test("test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: a calm host lifts the suspension", () => {
  const flat = run([
    [0, 40],
    [60_000, 40],
    [70_000, 40],
  ]);
  assert.equal(flat.decisions[2]!.evidence.shedSuspended, true);
  const calm = run([[80_000, 1]], flat.state);
  assert.equal(calm.decisions[0]!.evidence.shedSuspended, false, "the pressure ended; the next episode is judged afresh");
});

test("W1-T11150 criterion 2 in test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: restore in proportion to relief", () => {
  // Shed 4 -> 1 at 25, then pressure falls under the high line: relief = (25 - lowest) / (25 - 5).
  const { decisions } = run([
    [0, 25],
    [5_000, 25],
    [10_000, 25],
    [20_000, 19], // relief 6/20 -> 1 + ceil(3 * .3) = 2
    [30_000, 12], // relief 13/20 -> 1 + ceil(3 * .65) = 3
    [40_000, 6], // relief 19/20 -> 1 + ceil(2.85) = 4, never above base
  ]);
  assert.deepEqual(widths(decisions), [3, 2, 1, 2, 3, 4]);
  assert.equal(decisions[3]!.evidence.shedEffect, "pending", "restoring does not wait for the settle time");
  assert.equal(decisions[5]!.evidence.shedEffect, undefined, "fully handed back: no shed left open");
});

test("W1-T11150 criterion 2 in test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: a flat reading below high holds, a rise sheds again", () => {
  const { decisions } = run([
    [0, 25],
    [5_000, 25],
    [10_000, 25],
    [20_000, 19],
    [30_000, 19], // not falling any further: holds
    [40_000, 19.5], // rising but under high: holds
    [50_000, 22], // rises past high: sheds as before
  ]);
  assert.deepEqual(widths(decisions), [3, 2, 1, 2, 2, 2, 1]);
  assert.equal(decisions[6]!.reason, "cpu-pressure");
});

test("W1-T11150 criterion 2 in test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: never past the host worker budget", () => {
  const tight = { ...POLICY, hostWorkerBudget: 5 } as ReviewCapacityPolicy;
  const { decisions } = run(
    [
      [0, 25, { activeWorkers: 3 }],
      [5_000, 25, { activeWorkers: 3 }],
      [10_000, 25, { activeWorkers: 3 }],
      [20_000, 6, { activeWorkers: 3 }], // relief ~1 would be base 4, but 3 workers leave room for 2
    ],
    initialReviewCapacityState(BOUNDS.baseWidth),
    tight,
  );
  assert.equal(decisions[3]!.effectiveWidth, 2);
});

test("W1-T11150 criterion 3 in test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: the row carries the shed's effect", () => {
  const { decisions } = run([
    [0, 40],
    [10_000, 38],
    [20_000, 39],
    [60_000, 19], // fell by 21 against a spread of ~2: effective
  ]);
  const pending = decisions[0]!.evidence;
  assert.equal(pending.shedEffect, "pending");
  assert.equal(pending.shedReading, 40);
  assert.equal(pending.currentReading, 40);
  assert.equal(pending.shedSuspended, false);
  const effective = decisions[3]!.evidence;
  assert.equal(effective.shedEffect, "effective");
  assert.equal(effective.shedReading, 40);
  assert.equal(effective.currentReading, 19);
  assert.ok(typeof effective.noiseBand === "number" && effective.noiseBand < 21, "the spread used is recorded");
  assert.equal(effective.shedSuspended, false);
  assert.notEqual(effective.effectiveWidth, 4, "an effective shed is kept, not handed back");
});

test("W1-T11150 criterion 3 in test/review/a-review-shed-that-does-not-lower-pressure-stops-shedding.test.ts: a row with no shed carries no effect", () => {
  const { decisions } = run([[0, 1]]);
  assert.equal(decisions[0]!.evidence.shedEffect, undefined);
  assert.equal(decisions[0]!.evidence.shedSuspended, false);
  assert.equal(decisions[0]!.evidence.currentReading, 1);
});

test("a shed with no measured cpu phase settles in one telemetry cadence", () => {
  const noPhase = { settlements: { failures: 0, timeouts: 0, successes: 5 } } as Partial<ReviewCapacityObservation>;
  const { decisions } = run([
    [0, 40, noPhase],
    [60_000, 40, noPhase], // a minute is not a telemetry cadence: still pending
    [300_000, 40, noPhase],
  ]);
  assert.equal(decisions[1]!.evidence.shedEffect, "pending");
  assert.equal(decisions[2]!.evidence.shedEffect, "ineffective");
  assert.equal(decisions[2]!.effectiveWidth, 4);
});

test("memory pressure still sheds while cpu sheds are suspended", () => {
  const flat = run([
    [0, 40],
    [60_000, 40],
    [70_000, 40],
  ]);
  const memory = run([[80_000, 40, { memoryPsiSomeAvg10Pct: 30 }]], flat.state);
  assert.equal(memory.decisions[0]!.reason, "memory-pressure");
  assert.equal(memory.decisions[0]!.effectiveWidth, 3);
});

test("the setup-plus-proofs phase of recent reviews is the median the shed settles on", () => {
  const ts = (s: number): string => new Date(1_000_000 + s * 1000).toISOString();
  const lines = [
    { ts: ts(1), step: "review.posted", head_sha: "a", proof_exec: [], setup_ms: 10_000, proofs_ms: 20_000 },
    { ts: ts(2), step: "review.posted", head_sha: "b", proof_exec: [], setup_ms: 20_000, proofs_ms: 40_000 },
    { ts: ts(3), step: "review.posted", head_sha: "c", proof_exec: [] },
  ];
  const summary = summarizeReviewSettlements(lines, 1_000_000 + 10_000, 1_800_000);
  assert.equal(summary.cpuPhaseMs, 45_000, "median of 30 s and 60 s; the row without phases is skipped");
  assert.equal(summarizeReviewSettlements([], 1_000_000, 1_800_000).cpuPhaseMs, undefined);
});

// ---- Production row shapes. Nothing in production writes `setup_ms`/`proofs_ms` on `review.posted`; ----
// ---- what it DOES write is `sweep.post_review.attempt` (start) and `review.posted` (settled), the   ----
// ---- latter by the hosted review child, so a hosted review has no `.done` row at all.                ----

const NOW = 1_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** In-memory review rows, never a ledger file (summarizeReviewSettlements takes rows, not a path, so
 *  test/helpers/ledger-fixture.ts's on-disk writeLedger does not apply): two settled hosted reviews
 *  (30 s and 90 s from attempt to posted: median 60 s) and `inFlight` heads attempted just now. */
function productionReviewRows(at: number, inFlight: ReadonlyArray<string>, extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  const settled = (head: string, startMs: number, durationMs: number): Array<Record<string, unknown>> => [
    { ts: iso(startMs), step: "sweep.post_review.attempt", pr_number: 1, head_sha: head, review_mode: "full-review" },
    { ts: iso(startMs + 1), step: "sweep.post_review.child", pr_number: 1, head_sha: head },
    { ts: iso(startMs + durationMs), step: "review.posted", head_sha: head, proof_exec: ["executed_pass"] },
  ];
  return [
    ...settled("h1", NOW - 400_000, 30_000),
    ...settled("h2", NOW - 300_000, 90_000),
    ...inFlight.map((head) => ({ ts: iso(NOW + at - 10_000), step: "sweep.post_review.attempt", pr_number: 2, head_sha: head, review_mode: "full-review" })),
    ...extra,
  ];
}

test("the settle time comes from the attempt and review.posted rows production writes", () => {
  const summary = summarizeReviewSettlements(productionReviewRows(0, []), NOW, 1_800_000);
  assert.equal(summary.cpuPhaseMs, 60_000, "median of the 30 s and 90 s attempt-to-posted times, with no setup_ms or proofs_ms anywhere");
  assert.equal(summary.cpuPhaseChildren, undefined, "nothing in flight");
  const reuse = summarizeReviewSettlements(
    [
      { ts: iso(NOW - 100_000), step: "sweep.post_review.attempt", pr_number: 3, head_sha: "r", review_mode: "reuse" },
      { ts: iso(NOW - 99_000), step: "review.posted", head_sha: "r", proof_exec: [] },
    ],
    NOW,
    1_800_000,
  );
  assert.equal(reuse.cpuPhaseMs, undefined, "a verdict reuse runs no setup or proofs, so it is not a CPU phase");
});

test("reviews attempted and unsettled inside their CPU phase are the review lane's children", () => {
  const ledger = productionReviewRows(0, ["x", "y"], [
    { ts: iso(NOW - 5_000), step: "sweep.post_review.attempt", pr_number: 4, head_sha: "cheap", review_mode: "reuse" },
    { ts: iso(NOW - 200_000), step: "sweep.post_review.attempt", pr_number: 5, head_sha: "stale", review_mode: "full-review" },
    { ts: iso(NOW - 20_000), step: "sweep.post_review.attempt", pr_number: 6, head_sha: "done", review_mode: "full-review" },
    { ts: iso(NOW - 15_000), step: "review.posted", head_sha: "done", proof_exec: [] },
  ]);
  assert.equal(
    summarizeReviewSettlements(ledger, NOW, 1_800_000).cpuPhaseChildren,
    2,
    "x and y only: not the reuse, not the one past its 60 s phase, not the one already posted",
  );
});

test("production-shaped ledger rows drive the shed's settle time and the suspension lift end to end", () => {
  const observe = (at: number, cpu: number, inFlight: ReadonlyArray<string>): Partial<ReviewCapacityObservation> => {
    const settlements = summarizeReviewSettlements(productionReviewRows(at, inFlight), NOW + at, 1_800_000);
    return { settlements, reviewCpuChildren: settlements.cpuPhaseChildren ?? 0 };
  };
  const flat = run([
    [0, 40, observe(0, 40, ["a"])],
    [30_000, 40, observe(30_000, 40, ["a"])],
    [59_000, 40, observe(59_000, 40, ["a"])],
    [60_000, 40, observe(60_000, 40, ["a"])],
    [70_000, 40, observe(70_000, 40, ["a"])],
  ]);
  assert.equal(flat.decisions[2]!.evidence.shedEffect, "pending", "59 s: the measured 60 s phase has not elapsed, so no verdict yet");
  assert.equal(flat.decisions[3]!.evidence.shedEffect, "ineffective", "60 s: the median attempt-to-posted time has elapsed");
  assert.equal(flat.decisions[3]!.effectiveWidth, 4);
  assert.equal(flat.decisions[4]!.evidence.shedSuspended, true);
  const same = run([[80_000, 40, observe(80_000, 40, ["a"])]], flat.state);
  assert.equal(same.decisions[0]!.evidence.shedSuspended, true, "the same one review in its CPU phase: still suspended");
  const grew = run([[80_000, 40, observe(80_000, 40, ["a", "b", "c"])]], flat.state);
  assert.equal(grew.decisions[0]!.reason, "cpu-pressure", "three reviews now in their CPU phase lifts the suspension");
  assert.equal(grew.decisions[0]!.evidence.shedSuspended, false);
});
