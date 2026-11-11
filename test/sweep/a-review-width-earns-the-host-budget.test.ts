// W1-T11841: the review width can earn every lane the host worker budget allows.
//
// The runtime ceiling was the `sweep.reviewLanes` row's own max (5). It is now
// `sweep.reviewCapacity.hostWorkerBudget`. The row's max still bounds edits of the base value.
// Every refusal the widener had stays as it was.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { PolicyError } from "#src/lib/policy.js";
import {
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  selectRuntimeReviewWidth,
  type ReviewCapacityObservation,
  type ReviewCapacityReason,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { repoRoot } from "#test/helpers/repo-root.js";
import {
  DEFAULT_SWEEP_POLICY,
  reviewPolicyFromRows,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

const CAPACITY = DEFAULT_SWEEP_POLICY.reviewCapacity;
const BUDGET = CAPACITY.hostWorkerBudget;
const BASE = DEFAULT_SWEEP_POLICY.reviewLanes;
/** The bounds the production sweep hands the widener (`selectRuntimeReviewWidth` in src/lib/sweep.ts). */
const BOUNDS = {
  baseWidth: DEFAULT_SWEEP_POLICY.reviewLanes,
  minWidth: DEFAULT_SWEEP_POLICY.reviewLaneMin,
  maxWidth: DEFAULT_SWEEP_POLICY.reviewLaneMax,
};

interface SweepRows {
  reviewLanes: { value: number; origin: string; min: number; max: number };
  reviewCapacity: Record<string, { value: number; origin: string; min: number; max: number }>;
  dispatchLanes: { value: number };
}

function shippedSweepRows(): SweepRows {
  const raw = parseYaml(readFileSync(join(repoRoot(), "plan", "policy.yaml"), "utf8")) as { sweep: SweepRows };
  return raw.sweep;
}

/** One sample that is healthy on every reading, one sample cadence after the last. */
function healthy(sample: number, over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs: sample * CAPACITY.sampleCadenceMs,
    queueDepth: 40,
    activeWorkers: 0,
    memAvailableMib: CAPACITY.workerMemoryReserveMib * 4,
    cpuPsiSomeAvg10Pct: 0,
    cpuPsiFullAvg10Pct: 0,
    cpuWeightShare: 1,
    memoryPsiSomeAvg10Pct: 0,
    provider: { fresh: true, readable: true, headroomPct: 80, reservePct: 5, ageMs: 1_000 },
    settlements: { successes: CAPACITY.minHealthySettlements, failures: 0, timeouts: 0 },
    ...over,
  };
}

function decide(state: ReviewCapacityState, observation: ReviewCapacityObservation) {
  return selectAdaptiveReviewWidth(state, CAPACITY, observation, BOUNDS);
}

/** Runs healthy samples from the base width and returns the width after each one. */
function widthsOverHealthySamples(count: number, activeWorkers: number): { widths: number[]; reasons: ReviewCapacityReason[]; state: ReviewCapacityState } {
  let state = initialReviewCapacityState(BASE);
  const widths: number[] = [];
  const reasons: ReviewCapacityReason[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const result = decide(state, healthy(sample, { activeWorkers }));
    state = result.state;
    widths.push(result.decision.effectiveWidth);
    reasons.push(result.decision.reason);
  }
  return { widths, reasons, state };
}

test("W1-T11841 criterion 1: the shipped ceiling is the host worker budget, and the policy rows are unchanged", () => {
  const rows = shippedSweepRows();
  assert.deepEqual(
    { value: rows.reviewLanes.value, min: rows.reviewLanes.min, max: rows.reviewLanes.max },
    { value: 4, min: 1, max: 5 },
    "plan/policy.yaml sweep.reviewLanes",
  );
  assert.equal(rows.reviewCapacity.hostWorkerBudget?.value, 8, "plan/policy.yaml sweep.reviewCapacity.hostWorkerBudget");
  assert.equal(rows.dispatchLanes.value, 3, "plan/policy.yaml sweep.dispatchLanes");

  assert.equal(DEFAULT_SWEEP_POLICY.reviewLaneMax, 8, "the ceiling is the budget, not the row's max of 5");
  assert.equal(DEFAULT_SWEEP_POLICY.reviewLaneMax, DEFAULT_SWEEP_POLICY.reviewCapacity.hostWorkerBudget);
  assert.equal(DEFAULT_SWEEP_POLICY.reviewLanes, 4, "the base value is the row's value");
  assert.equal(DEFAULT_SWEEP_POLICY.reviewLaneMin, 1, "the minimum is the row's min");
  assert.equal(DEFAULT_SWEEP_POLICY.reviewCapacity.hostWorkerBudget, 8);
  assert.equal(DEFAULT_SWEEP_POLICY.dispatchLanes, 3);
});

test("W1-T11841 criterion 1: healthy windows widen past 5, one lane per window, up to the budget and never past it", () => {
  const first = CAPACITY.healthyWindowSamples;
  const { widths, reasons } = widthsOverHealthySamples(first + 8, 0);
  assert.deepEqual(widths.slice(0, first - 1), Array.from({ length: first - 1 }, () => BASE), "the window must fill first");
  assert.deepEqual(widths.slice(first - 1, first + 3), [5, 6, 7, 8], "one lane per healthy window");
  assert.deepEqual(widths.slice(first + 3), [8, 8, 8, 8, 8], "the width stays at the budget");
  assert.equal(Math.max(...widths), BUDGET);
  assert.ok(reasons.every((reason) => reason === "healthy-window"));
});

test("W1-T11841 criterion 1: with active workers the width stops at the room they leave", () => {
  const { widths, reasons, state } = widthsOverHealthySamples(CAPACITY.healthyWindowSamples + 6, 2);
  assert.equal(Math.max(...widths), BUDGET - 2, "two active workers leave room for six review lanes");
  assert.equal(widths.at(-1), BUDGET - 2);
  assert.equal(reasons.at(-1), "host-worker-budget", "the existing budget refusal names why the width stopped");

  const crowded = decide(state, healthy(100, { activeWorkers: 4 }));
  assert.equal(crowded.decision.reason, "host-worker-budget");
  assert.equal(crowded.decision.effectiveWidth, BUDGET - 3, "more active workers shed one lane per sample");

  const full = widthsOverHealthySamples(CAPACITY.healthyWindowSamples + 6, BUDGET - BASE);
  assert.equal(Math.max(...full.widths), BASE, "no room above the base value means no widening");
});

test("W1-T11841 criterion 1: each existing refusal still blocks a widen above 5 and never admits past the budget", () => {
  const earnedWidth = 6;
  const earned = widthsOverHealthySamples(CAPACITY.healthyWindowSamples + 1, 0);
  assert.equal(earned.state.effectiveWidth, earnedWidth);
  const at = CAPACITY.healthyWindowSamples + 1;
  const settlements = healthy(at).settlements;
  const provider = healthy(at).provider;

  const refusals: Array<{ reason: ReviewCapacityReason; over: Partial<ReviewCapacityObservation>; width: number }> = [
    { reason: "cpu-pressure", over: { cpuPsiFullAvg10Pct: 95, cpuPsiSomeAvg10Pct: 95 }, width: earnedWidth - 1 },
    { reason: "memory-pressure", over: { memoryPsiSomeAvg10Pct: CAPACITY.memoryPsiHighPct }, width: earnedWidth - 1 },
    { reason: "memory-reserve", over: { memAvailableMib: CAPACITY.workerMemoryReserveMib - 1 }, width: earnedWidth - 1 },
    { reason: "provider-refused", over: { provider: { ...provider, refused: true } }, width: earnedWidth - 1 },
    {
      reason: "review-unhealthy",
      over: { settlements: { ...settlements, failures: CAPACITY.unhealthySettlementThreshold } },
      width: earnedWidth - 1,
    },
    {
      reason: "review-unhealthy",
      over: { settlements: { ...settlements, timeouts: CAPACITY.unhealthySettlementThreshold } },
      width: earnedWidth - 1,
    },
    {
      reason: "review-latency-expanded",
      over: {
        cpuPsiFullAvg10Pct: CAPACITY.cpuPsiLowPct + 1,
        cpuPsiSomeAvg10Pct: CAPACITY.cpuPsiLowPct + 1,
        settlements: { ...settlements, baselineLatencyMs: 100_000, recentLatencyMs: 100_000 * CAPACITY.latencyExpansionRatio },
      },
      width: BASE - 1,
    },
    { reason: "telemetry-unavailable", over: { cpuPsiFullAvg10Pct: undefined }, width: BASE },
    { reason: "backlog-not-sustained", over: { queueDepth: 1 }, width: BASE },
    {
      reason: "provider-headroom",
      over: { provider: { ...provider, headroomPct: provider.reservePct } },
      width: earnedWidth,
    },
    { reason: "review-history-insufficient", over: { settlements: { ...settlements, successes: 0 } }, width: earnedWidth },
  ];

  for (const refusal of refusals) {
    const result = decide(earned.state, healthy(at, refusal.over));
    assert.equal(result.decision.reason, refusal.reason);
    assert.equal(result.decision.effectiveWidth, refusal.width, `${refusal.reason} width`);
    assert.ok(result.decision.effectiveWidth <= earnedWidth, `${refusal.reason} must not widen`);
    assert.ok(result.decision.effectiveWidth <= BUDGET, `${refusal.reason} must stay inside the budget`);
    assert.equal(result.decision.evidence.healthySamples, 0, `${refusal.reason} clears the healthy window`);

    // One healthy sample after a refusal does not widen: the window must fill again.
    const next = decide(result.state, healthy(at + 1));
    assert.ok(next.decision.effectiveWidth <= Math.max(refusal.width, BASE), `${refusal.reason} then one healthy sample`);
  }
});

test("W1-T11841 criterion 1: the loader refuses a base value above the budget and names the derived bound", () => {
  const shipped = shippedSweepRows();
  assert.deepEqual(
    reviewPolicyFromRows(shipped),
    { value: 4, min: 1, laneMax: 8, capacity: DEFAULT_SWEEP_POLICY.reviewCapacity },
    "the shipped rows load with the ceiling at the budget",
  );

  const aboveBudget = structuredClone(shipped);
  aboveBudget.reviewLanes = { ...aboveBudget.reviewLanes, value: 9, max: 16 };
  assert.throws(
    () => reviewPolicyFromRows(aboveBudget),
    (error: unknown) =>
      error instanceof PolicyError &&
      /'sweep\.reviewLanes\.value' \(9\) is above the review ceiling derived from 'sweep\.reviewCapacity\.hostWorkerBudget\.value' \(8\)/
        .test(error.message),
  );

  const smallBudget = structuredClone(shipped);
  smallBudget.reviewCapacity.hostWorkerBudget = { ...smallBudget.reviewCapacity.hostWorkerBudget!, value: 3 };
  assert.throws(
    () => reviewPolicyFromRows(smallBudget),
    (error: unknown) => error instanceof PolicyError && /\(4\) is above the review ceiling .*hostWorkerBudget\.value' \(3\)/.test(error.message),
    "a budget edited below the base value is refused, not clamped",
  );

  const atBudget = structuredClone(shipped);
  atBudget.reviewLanes = { ...atBudget.reviewLanes, value: 8, max: 8 };
  assert.equal(reviewPolicyFromRows(atBudget).value, 8, "a base value equal to the budget loads");
});

test("W1-T11841 criterion 1: every existing review-lane row refusal still fires through the loader", () => {
  const withRow = (reviewLanes: unknown): { reviewLanes: unknown; reviewCapacity: unknown } => ({
    reviewLanes,
    reviewCapacity: shippedSweepRows().reviewCapacity,
  });
  const refused: Array<[unknown, RegExp]> = [
    [undefined, /must be a mapping/],
    [{ value: "4", min: 1, max: 5 }, /'sweep\.reviewLanes\.value' must be a finite number/],
    [{ value: 4, min: 1 }, /must carry numeric 'min' and 'max' bounds/],
    [{ value: 4, min: 5, max: 1 }, /min \(5\) > max \(1\)/],
    [{ value: 0, min: 1, max: 5 }, /is out of its declared bound \[1, 5\]/],
    [{ value: 6, min: 1, max: 5 }, /'sweep\.reviewLanes\.value' \(6\) is out of its declared bound \[1, 5\]/],
  ];
  for (const [row, message] of refused) {
    assert.throws(
      () => reviewPolicyFromRows(withRow(row)),
      (error: unknown) => error instanceof PolicyError && message.test(error.message),
      `row ${JSON.stringify(row)}`,
    );
  }
  assert.throws(
    () => reviewPolicyFromRows({ reviewLanes: shippedSweepRows().reviewLanes, reviewCapacity: undefined }),
    (error: unknown) => error instanceof PolicyError && /'sweep\.reviewCapacity' must be a mapping/.test(error.message),
  );
});

function reviewablePr(prNumber: number): OpenPrView {
  return {
    prNumber,
    prUrl: `url/${prNumber}`,
    taskId: `W1-WIDTH-${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-11-10T11:00:00Z",
    headSha: `sha${prNumber}`,
    autoMergeArmed: false,
  };
}

/** The most reviews in flight at once when a sweep runs twelve reviewable PRs at the selected width. */
async function reviewsInFlight(selectedWidth: number): Promise<number> {
  let inFlight = 0;
  let most = 0;
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11841-`)), "ledger.ndjson"),
    runId: "SWEEP-T11841-1",
    now: () => Date.parse("2026-11-10T12:00:00Z"),
    selectAdaptiveReviewWidth: () => selectedWidth,
    postReview: async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      for (let tick = 0; tick < 5; tick += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
    },
  };
  await runSweep(Array.from({ length: 12 }, (_, index) => reviewablePr(11_841_00 + index)), deps, DEFAULT_SWEEP_POLICY);
  return most;
}

test("W1-T11841 criterion 1: a sweep under the shipped policy runs an earned width above 5 and stops at the budget", async () => {
  assert.equal(await reviewsInFlight(7), 7, "a width of seven is admitted");
  assert.equal(await reviewsInFlight(BUDGET + 4), BUDGET, "a width past the budget is cut to the budget");
});

test("W1-T11841 criterion 1: the review.capacity row reports the budget as max_width", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const width = selectRuntimeReviewWidth({
    root: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11841-root-`)),
    queueDepth: 12,
    activeWorkers: 0,
    nowMs: Date.parse("2026-11-10T12:00:00Z"),
    ledgerLines: [],
    policy: DEFAULT_SWEEP_POLICY.reviewCapacity,
    ...BOUNDS,
    log: (step, extra) => rows.push({ step, extra }),
  });
  assert.ok(width >= DEFAULT_SWEEP_POLICY.reviewLaneMin && width <= BASE, "one sample earns no lane above the base value");
  const row = rows.find((entry) => entry.step === "review.capacity");
  assert.equal(row?.extra?.max_width, BUDGET);
  assert.equal(row?.extra?.base_width, BASE);
});
