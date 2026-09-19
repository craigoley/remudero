import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptVerdictCalibrationReport, type OperatorAgentTaskOutcomeSignal } from "../src/lib/operator-agent-outcomes.js";
import { verdictCalibrationReport, type VerdictCalibrationReport, type VerdictRow } from "../src/lib/verdict-calibration.js";

const policy = {
  windowDays: 14,
  overlapRuleDescription: "fix commits need changed-file overlap or task-id citation",
};

const emptyUnmeasurableByCause = {
  "no-head-sha": 0,
  "no-review-posted": 0,
  "merge-sha-unrecoverable": 0,
  "git-history-unavailable": 0,
};

function report(overrides: Partial<VerdictCalibrationReport> = {}): VerdictCalibrationReport {
  return {
    policy,
    minPopulationFloor: 5,
    classes: [
      {
        verdictClass: "full-pass",
        total: 5,
        revertedCount: 1,
        followupFixedCount: 2,
        revertRate: 0.2,
        followupFixRate: 0.4,
        lanes: "review",
        taskIds: ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5"],
      },
      {
        verdictClass: "keyword-floor",
        total: 0,
        revertedCount: 0,
        followupFixedCount: 0,
        revertRate: null,
        followupFixRate: null,
        lanes: "none",
        rateRefusedReason: "below-population-floor",
        taskIds: [],
      },
      {
        verdictClass: "degraded-arm",
        total: 0,
        revertedCount: 0,
        followupFixedCount: 0,
        revertRate: null,
        followupFixRate: null,
        lanes: "none",
        rateRefusedReason: "below-population-floor",
        taskIds: [],
      },
    ],
    unmeasurable: [],
    armsSeen: 5,
    armsClassified: 5,
    unmeasurableByCause: emptyUnmeasurableByCause,
    ...overrides,
  };
}

test("W1-T3795 criterion 1: reports revert and follow-up-fix rates with policy and denominators", () => {
  const source = report();
  const signal = adaptVerdictCalibrationReport(source);

  assert.equal(signal.signal, "task-outcomes");
  assert.equal(signal.status, "measured");
  assert.equal(signal.policy.windowDays, 14);
  assert.equal(signal.minPopulationFloor, 5);
  assert.equal(signal.armsSeen, 5);
  assert.equal(signal.armsClassified, 5);
  assert.deepEqual(signal.classes[0], {
    verdictClass: "full-pass",
    total: 5,
    revertedCount: 1,
    followupFixedCount: 2,
    revertRate: 0.2,
    followupFixRate: 0.4,
    lanes: "review",
    taskIds: ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5"],
  });
  assert.notEqual(signal.classes, source.classes);
  assert.notEqual(signal.policy, source.policy);
});

test("W1-T3795 criterion 2: preserves below-floor, mixed-lane, and unmeasurable rows", () => {
  const signal = adaptVerdictCalibrationReport(
    report({
      classes: [
        {
          verdictClass: "full-pass",
          total: 4,
          revertedCount: 1,
          followupFixedCount: 0,
          revertRate: null,
          followupFixRate: null,
          lanes: "review",
          rateRefusedReason: "below-population-floor",
          taskIds: ["W1-T1", "W1-T2", "W1-T3", "W1-T4"],
        },
        {
          verdictClass: "keyword-floor",
          total: 5,
          revertedCount: 1,
          followupFixedCount: 1,
          revertRate: null,
          followupFixRate: null,
          lanes: "operator, review",
          rateRefusedReason: "mixed-lane-population",
          taskIds: ["W1-T5", "W1-T6", "W1-T7", "W1-T8", "W1-T9"],
        },
        {
          verdictClass: "degraded-arm",
          total: 0,
          revertedCount: 0,
          followupFixedCount: 0,
          revertRate: null,
          followupFixRate: null,
          lanes: "none",
          rateRefusedReason: "below-population-floor",
          taskIds: [],
        },
      ],
      unmeasurable: [{ taskId: "W1-T10", why: "no matching review.posted line", cause: "no-review-posted" }],
      armsSeen: 10,
      armsClassified: 9,
      unmeasurableByCause: { ...emptyUnmeasurableByCause, "no-review-posted": 1 },
    }),
  );

  assert.equal(signal.status, "measured");
  assert.equal(signal.classes[0]?.revertRate, null);
  assert.equal(signal.classes[0]?.rateRefusedReason, "below-population-floor");
  assert.equal(signal.classes[1]?.followupFixRate, null);
  assert.equal(signal.classes[1]?.rateRefusedReason, "mixed-lane-population");
  assert.deepEqual(signal.unmeasurable, [{ taskId: "W1-T10", why: "no matching review.posted line", cause: "no-review-posted" }]);
  assert.equal(signal.unmeasurableByCause["no-review-posted"], 1);
});

test("W1-T3795 criterion 3: a failed worker result is not classified as a reverted task", () => {
  const failedWorkerRow: VerdictRow = {
    taskId: "W1-T11",
    armedTs: "2026-09-19T00:00:00.000Z",
    verdictClass: null,
    unjoinableCause: "no-review-posted",
    classifyWhy: "worker result failed before a review.posted verdict existed",
  };
  const calibration = verdictCalibrationReport([failedWorkerRow], "");
  const signal: OperatorAgentTaskOutcomeSignal = adaptVerdictCalibrationReport(calibration);

  assert.equal(signal.status, "not-collected");
  assert.equal(signal.unavailableReason, "verdict-join-unavailable");
  assert.equal(signal.armsSeen, 1);
  assert.equal(signal.armsClassified, 0);
  assert.equal(signal.classes.every((item) => item.revertedCount === 0 && item.revertRate === null), true);
  assert.deepEqual(signal.unmeasurableByCause, { ...emptyUnmeasurableByCause, "no-review-posted": 1 });
  assert.match(signal.unmeasurable[0]?.why ?? "", /worker result failed/);
});

test("operator-agent task outcomes refuse a healthy zero when git history is unavailable", () => {
  const signal = adaptVerdictCalibrationReport(
    report({
      armsSeen: 5,
      armsClassified: 0,
      classes: report().classes.map((item) => ({ ...item, total: 0, revertedCount: 0, followupFixedCount: 0, revertRate: null, followupFixRate: null, taskIds: [] })),
      unmeasurable: [{ taskId: "W1-T12", why: "git history unavailable: shallow clone", cause: "git-history-unavailable" }],
      unmeasurableByCause: { ...emptyUnmeasurableByCause, "git-history-unavailable": 5 },
    }),
  );

  assert.equal(signal.status, "not-collected");
  assert.equal(signal.unavailableReason, "git-history-unavailable");
  assert.equal(signal.classes[0]?.revertRate, null);
});
