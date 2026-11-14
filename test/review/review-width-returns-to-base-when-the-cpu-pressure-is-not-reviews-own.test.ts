import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishLaneCpuBound } from "#src/lib/lane-governor.js";
import {
  initialReviewCapacityState,
  selectAdaptiveReviewWidth,
  selectRuntimeReviewWidth,
  type ReviewCapacityBounds,
  type ReviewCapacityDecision,
  type ReviewCapacityObservation,
  type ReviewCapacityPolicy,
  type ReviewCapacityState,
} from "#src/lib/review-capacity.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T12529 — review width returns to base when the CPU pressure is not review's own. The samples copy the
// 2026-11-13T18:31:28Z review.capacity row: width 1, 6 PRs queued, 5 active workers, cpu full 22.61 and some 66.18
// at a weight share of 0.123, load1 32.87 on 8 cores, no review in its CPU phase.

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
  settlementWindowMs: 1_800_000,
  latencyExpansionRatio: 2,
  unhealthySettlementThreshold: 2,
  minHealthySettlements: 1,
} as unknown as ReviewCapacityPolicy;

const BOUNDS: ReviewCapacityBounds = { minWidth: 1, baseWidth: 4, maxWidth: 8 };

function measured(over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs: 1_000_000,
    queueDepth: 6,
    activeWorkers: 5,
    memAvailableMib: 20_000,
    cpuPsiSomeAvg10Pct: 66.18,
    cpuPsiFullAvg10Pct: 22.61,
    cpuWeightShare: 0.123,
    memoryPsiSomeAvg10Pct: 0,
    hostLoad1: 32.87,
    hostCpuCount: 8,
    reviewCpuChildren: 0,
    settlements: { failures: 0, timeouts: 0, successes: 5 },
    provider: { fresh: true, readable: true, refused: false, headroomPct: 80, reservePct: 5 },
    ...over,
  } as ReviewCapacityObservation;
}

function decide(
  over: Partial<ReviewCapacityObservation>,
  prior: ReviewCapacityState = initialReviewCapacityState(1),
  bounds: ReviewCapacityBounds = BOUNDS,
): { state: ReviewCapacityState; decision: ReviewCapacityDecision } {
  return selectAdaptiveReviewWidth(prior, POLICY, measured(over), bounds);
}

test("W1-T12529 criterion 1: a width shed to 1 returns to base in one sample when the load is not review's", () => {
  // The budget leaves 8 - 5 = 3 lanes: the restore stops there.
  const measuredRow = decide({});
  assert.equal(measuredRow.decision.reason, "cpu-pressure-not-review");
  assert.equal(measuredRow.decision.effectiveWidth, 3);
  // With room for every base lane it reaches base.
  const roomy = decide({ activeWorkers: 2 });
  assert.equal(roomy.decision.reason, "cpu-pressure-not-review");
  assert.equal(roomy.decision.effectiveWidth, 4);
  assert.equal(roomy.decision.evidence.healthySamples, 0, "no healthy sample is earned on PSI that is not calm");
});

test("W1-T12529 criterion 2: the restore never goes above base or max", () => {
  // Many samples of the same foreign pressure: the width holds at base 4 though max is 8.
  let state = initialReviewCapacityState(1);
  for (let i = 0; i < 10; i += 1) {
    const next = decide({ activeWorkers: 0, nowMs: 1_000_000 + i * 120_000 }, state);
    assert.ok(next.decision.effectiveWidth <= BOUNDS.baseWidth, `sample ${i}: ${next.decision.effectiveWidth}`);
    state = next.state;
  }
  assert.equal(state.effectiveWidth, 4);
  // Base equal to max: still never above it.
  const tight = { minWidth: 1, baseWidth: 2, maxWidth: 2 };
  const capped = decide({ activeWorkers: 0 }, initialReviewCapacityState(1), tight);
  assert.equal(capped.decision.effectiveWidth, 2);
  // A width already at base is not lowered and not raised by the new branch.
  const atBase = decide({ activeWorkers: 0 }, initialReviewCapacityState(4));
  assert.equal(atBase.decision.effectiveWidth, 4);
});

test("W1-T12529 criterion 3: review's own CPU-phase children keep the width down, and a CPU shed still drops a lane", () => {
  // Load 10 on 8 cores with 4 reviews in their CPU phase: without them the queue fits the cores.
  const own = decide({ hostLoad1: 10, reviewCpuChildren: 4 });
  assert.equal(own.decision.reason, "backlog-not-sustained");
  assert.equal(own.decision.effectiveWidth, 1);
  // PSI full past what the weight share predicts ((1 - 0.123) * 80 + 5 = 75.2) is a shed, whatever the load says.
  const shed = decide({ cpuPsiFullAvg10Pct: 78, cpuPsiSomeAvg10Pct: 80, activeWorkers: 0 }, initialReviewCapacityState(4));
  assert.equal(shed.decision.reason, "cpu-pressure");
  assert.equal(shed.decision.effectiveWidth, 3);
});

test("W1-T12529 criterion 4: an unread input or memory PSI above its low watermark never restores", () => {
  const cases: Array<[string, Partial<ReviewCapacityObservation>]> = [
    ["no host load", { hostLoad1: undefined }],
    ["no core count", { hostCpuCount: undefined }],
    ["no review child count", { reviewCpuChildren: undefined }],
    ["no weight share", { cpuWeightShare: undefined }],
    ["memory PSI above low", { memoryPsiSomeAvg10Pct: 6 }],
  ];
  for (const [name, over] of cases) {
    const result = decide(over);
    assert.equal(result.decision.reason, "backlog-not-sustained", name);
    assert.equal(result.decision.effectiveWidth, 1, name);
  }
});

test("W1-T12529 criterion 5: the review.capacity row carries the review child count the branch judged", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-cpu-children-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  publishLaneCpuBound(null);
  const nowMs = Date.parse("2026-11-13T18:31:28Z");
  const ledgerLines = [1, 2].map((n) => ({
    ts: new Date(nowMs - n * 1_000).toISOString(),
    step: "sweep.post_review.attempt",
    pr_number: 18_000 + n,
    head_sha: `${n}`.repeat(40),
  }));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const width = selectRuntimeReviewWidth({
    root, queueDepth: 6, activeWorkers: 5, nowMs, ledgerLines, policy: POLICY, cpuWeightShare: 0.123,
    baseWidth: 4, minWidth: 1, maxWidth: 8, log: (step, extra) => logs.push({ step, extra }),
  });
  assert.ok(width >= 1 && width <= 4, `width ${width}`);
  const row = logs.find((entry) => entry.step === "review.capacity");
  assert.ok(row, "the sample writes its row");
  assert.equal(row.extra?.review_cpu_children, 2);
});
