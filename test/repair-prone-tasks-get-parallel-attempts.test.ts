// test/repair-prone-tasks-get-parallel-attempts.test.ts — W1-T4667: repair rounds are 77% of
// PR time and run sequentially. Every case here is pure: no ledger, no worker spawn, no
// worktree — see lib/parallel-attempts.ts's own module doc for why no spawn seam lives there.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_PARALLEL_K,
  MIN_GAIN_PER_EXTRA_WINDOW,
  MIN_ROWS_FOR_SIGNAL,
  measureShapeGains,
  planParallelAttempts,
  selectPreferredAttempt,
  shapeGainPays,
  taskShapeKey,
  type ParallelAttemptCandidate,
  type RepairShapeTrialRow,
  type ShapeGain,
} from "../src/lib/parallel-attempts.js";

const RISKY_SHAPE_TASK = { risk: "high" as const, files: ["src/lib/sweep.ts"] };

function rowsForShape(shape: string, opts: { n: number; singlePassN: number; anyOfKPassN: number; windowShare?: number }): RepairShapeTrialRow[] {
  const rows: RepairShapeTrialRow[] = [];
  for (let i = 0; i < opts.n; i++) {
    rows.push({
      shape,
      singlePassed: i < opts.singlePassN,
      anyOfKPassed: i < opts.anyOfKPassN,
      windowShare: opts.windowShare ?? 3,
    });
  }
  return rows;
}

test("W1-T4667: parallel attempts are spawned only for shapes whose measured any-of-k gain pays", () => {
  const shape = taskShapeKey(RISKY_SHAPE_TASK);
  // 10 paired rows: single attempt passes 3/10, any-of-k passes 9/10 — a large, well-measured
  // gain (0.6) at a 3x reserved-window cost (2x EXTRA), well above MIN_GAIN_PER_EXTRA_WINDOW.
  const payingRows = rowsForShape(shape, { n: 10, singlePassN: 3, anyOfKPassN: 9, windowShare: 3 });
  const payingGains = measureShapeGains(payingRows);
  assert.equal(shapeGainPays(payingGains.get(shape)), true);
  const payingPlan = planParallelAttempts({ task: RISKY_SHAPE_TASK, priorStrikes: 1, gains: payingGains });
  assert.equal(payingPlan.parallel, true);
  assert.ok(payingPlan.k >= 2 && payingPlan.k <= DEFAULT_MAX_PARALLEL_K);
  assert.equal(payingPlan.shape, shape);

  // Same shape, but the measured gain barely moves the pass rate (1/10 -> 2/10): too small to
  // clear MIN_GAIN_PER_EXTRA_WINDOW at the same window cost — plans the ordinary single attempt.
  const thinRows = rowsForShape(shape, { n: 10, singlePassN: 1, anyOfKPassN: 2, windowShare: 3 });
  const thinGains = measureShapeGains(thinRows);
  assert.equal(shapeGainPays(thinGains.get(shape)), false);
  const thinPlan = planParallelAttempts({ task: RISKY_SHAPE_TASK, priorStrikes: 1, gains: thinGains });
  assert.equal(thinPlan.parallel, false);
  assert.equal(thinPlan.k, 1);
  assert.equal(thinPlan.reason, "gain-does-not-pay-for-window");

  // A shape with fewer rows than MIN_ROWS_FOR_SIGNAL is UNMEASURED even with a large gain: never
  // a guess dressed as a measurement.
  const sparseRows = rowsForShape(shape, { n: MIN_ROWS_FOR_SIGNAL - 1, singlePassN: 0, anyOfKPassN: MIN_ROWS_FOR_SIGNAL - 1, windowShare: 2 });
  const sparseGains = measureShapeGains(sparseRows);
  assert.equal(shapeGainPays(sparseGains.get(shape)), false);

  // A shape absent from the measured map plans the ordinary single attempt, reason unmeasured.
  const unmeasuredPlan = planParallelAttempts({ task: RISKY_SHAPE_TASK, priorStrikes: 1, gains: new Map<string, ShapeGain>() });
  assert.equal(unmeasuredPlan.parallel, false);
  assert.equal(unmeasuredPlan.reason, "shape-unmeasured");

  // A COLD first strike (no prior failed strike) never runs parallel, even for a paying shape —
  // design: parallel attempts follow a first FAILED strike, never the cold first attempt.
  const coldPlan = planParallelAttempts({ task: RISKY_SHAPE_TASK, priorStrikes: 0, gains: payingGains });
  assert.equal(coldPlan.parallel, false);
  assert.equal(coldPlan.reason, "no-prior-failed-strike");
});

test("W1-T4667: the attempt chosen is the one the proofs prefer", () => {
  // Exactly one candidate's proofs pass: it wins outright, the reviewer is never consulted.
  const onePasses: ParallelAttemptCandidate[] = [
    { id: "attempt-a", proofVerdict: "fail" },
    { id: "attempt-b", proofVerdict: "pass", reviewerScore: 0.1 },
    { id: "attempt-c", proofVerdict: "unmeasurable" },
  ];
  const proofChoice = selectPreferredAttempt(onePasses);
  assert.deepEqual(proofChoice, { id: "attempt-b", selectedBy: "proofs" });

  // Two candidates' proofs both pass: the proofs alone don't separate them, so the reviewer's
  // score breaks the tie (design (ii): "select by proofs, then reviewer").
  const twoPass: ParallelAttemptCandidate[] = [
    { id: "attempt-a", proofVerdict: "pass", reviewerScore: 0.4 },
    { id: "attempt-b", proofVerdict: "pass", reviewerScore: 0.9 },
    { id: "attempt-c", proofVerdict: "fail", reviewerScore: 0.99 },
  ];
  const reviewerChoice = selectPreferredAttempt(twoPass);
  assert.deepEqual(reviewerChoice, { id: "attempt-b", selectedBy: "reviewer" });

  // No candidate's proofs pass: the reviewer still picks among what ran, by score.
  const nonePass: ParallelAttemptCandidate[] = [
    { id: "attempt-a", proofVerdict: "fail", reviewerScore: 0.2 },
    { id: "attempt-b", proofVerdict: "unmeasurable", reviewerScore: 0.7 },
  ];
  const fallbackChoice = selectPreferredAttempt(nonePass);
  assert.deepEqual(fallbackChoice, { id: "attempt-b", selectedBy: "reviewer" });

  // No candidates at all: nothing to choose among.
  assert.equal(selectPreferredAttempt([]), null);
});

test("W1-T4667: taskShapeKey buckets by risk and a coarse touched-file count", () => {
  assert.equal(taskShapeKey({ risk: "low", files: [] }), "low:1-file");
  assert.equal(taskShapeKey({ risk: "low", files: ["a.ts"] }), "low:1-file");
  assert.equal(taskShapeKey({ risk: "medium", files: ["a.ts", "b.ts", "c.ts"] }), "medium:2-3-file");
  assert.equal(taskShapeKey({ risk: "high", files: ["a.ts", "b.ts", "c.ts", "d.ts"] }), "high:4-plus-file");
});

test("W1-T4667: MIN_GAIN_PER_EXTRA_WINDOW is a payoff ratio, not a fixed attempt count", () => {
  assert.ok(MIN_GAIN_PER_EXTRA_WINDOW > 0 && MIN_GAIN_PER_EXTRA_WINDOW < 1);
});
