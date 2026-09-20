import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAnalyticsBreakdowns, type AnalyticsBreakdownSourceState } from "../src/lib/analytics-breakdowns.js";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";

const NOW = "2026-09-20T12:00:00.000Z";

test("W1-T3809 criterion 2: outcome and work-category dimensions carry bounded named denominators and drilldown rows", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [
      { step: "run.start", run_id: "R1", task_id: "W1-T1", type: "implement" },
      { step: "verdict", run_id: "R1", task_id: "W1-T1", verdict: "merged" },
      { step: "run.start", run_id: "R2", task_id: "W1-T2", type: "triage" },
      { step: "verdict", run_id: "R2", task_id: "W1-T2", verdict: "blocked_ci" },
      { step: "run.start", run_id: "R3", task_id: "W1-T3" },
    ],
    NOW,
  );

  const outcome = snapshot.dimensions.find((dimension) => dimension.key === "outcome");
  const workCategory = snapshot.dimensions.find((dimension) => dimension.key === "work-category");
  assert.equal(outcome?.denominator, 3);
  assert.equal(workCategory?.denominator, 3);
  assert.deepEqual(
    outcome?.buckets.map(({ key, count, denominator }) => ({ key, count, denominator })),
    [
      { key: "success", count: 1, denominator: 3 },
      { key: "failure", count: 1, denominator: 3 },
      { key: "missing-terminal-receipt", count: 1, denominator: 3 },
    ],
  );
  assert.deepEqual(
    workCategory?.buckets.map(({ key, count, denominator }) => ({ key, count, denominator })),
    [
      { key: "implement", count: 1, denominator: 3 },
      { key: "triage", count: 1, denominator: 3 },
      { key: "unknown", count: 1, denominator: 3 },
    ],
  );
  assert.equal(snapshot.drilldowns.length, 6);
  assert.ok(snapshot.drilldowns.every((row) => row.denominator > 0));
});

test("W1-T3809 criterion 3: missing receipts and unknown categories remain visible and failures are never relabeled as success or revert", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [
      { step: "run.start", run_id: "R1", task_id: "W1-T1", type: "implement" },
      { step: "verdict", run_id: "R1", task_id: "W1-T1", verdict: "merged", success: true },
      { step: "run.start", run_id: "R2", task_id: "W1-T2", type: "review" },
      { step: "verdict", run_id: "R2", task_id: "W1-T2", verdict: "failed", success: false },
      { step: "run.start", run_id: "R3", task_id: "W1-T3" },
      { step: "implement.done", run_id: "R2", task_id: "W1-T2", verdict: "error_max_turns" },
    ],
    NOW,
    {
      operatorAgentOutcomes: {
        signal: "task-outcomes",
        status: "measured",
        policy: { windowDays: 14, overlapRuleDescription: "bounded test policy" },
        minPopulationFloor: 1,
        classes: [
          {
            verdictClass: "full-pass",
            total: 1,
            revertedCount: 1,
            followupFixedCount: 0,
            revertRate: 1,
            followupFixRate: 0,
            lanes: "review",
            taskIds: ["W1-T1"],
          },
          {
            verdictClass: "keyword-floor",
            total: 0,
            revertedCount: 0,
            followupFixedCount: 0,
            revertRate: null,
            followupFixRate: null,
            lanes: "none",
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
            taskIds: [],
          },
        ],
        unmeasurable: [],
        unmeasurableByCause: { "no-head-sha": 0, "no-review-posted": 0, "merge-sha-unrecoverable": 0, "git-history-unavailable": 0 },
        armsSeen: 1,
        armsClassified: 1,
      },
    },
  );

  const outcome = snapshot.dimensions.find((dimension) => dimension.key === "outcome");
  assert.equal(outcome?.buckets.find((bucket) => bucket.key === "missing-terminal-receipt")?.count, 1);
  assert.equal(outcome?.buckets.find((bucket) => bucket.key === "failure")?.count, 1);
  assert.equal(outcome?.buckets.find((bucket) => bucket.key === "reverted")?.count, 1);
  assert.equal(outcome?.buckets.find((bucket) => bucket.key === "follow-up-fix")?.count, undefined);
  assert.equal(outcome?.buckets.find((bucket) => bucket.key === "failure")?.key, "failure");
  assert.equal(outcome?.buckets.some((bucket) => bucket.key === "success" && bucket.count === 2), false);
  assert.equal(snapshot.dimensions.find((dimension) => dimension.key === "work-category")?.buckets.find((bucket) => bucket.key === "unknown")?.count, 1);
});

test("W1-T3809 criterion 4: empty, unreadable, unauthorized, and not-collected inputs remain explicit without credentials or raw rows", () => {
  const states: AnalyticsBreakdownSourceState[] = ["empty", "unreadable", "unauthorized", "not-collected"];
  for (const state of states) {
    const breakdowns = buildAnalyticsBreakdowns([], { sourceState: state });
    assert.deepEqual(breakdowns.dimensions.map((dimension) => dimension.state), [state, state]);
    assert.deepEqual(breakdowns.dimensions.map((dimension) => dimension.buckets), [[], []]);
    assert.deepEqual(breakdowns.drilldowns, []);
    assert.equal(JSON.stringify(breakdowns).includes("secret-token"), false);
  }

  const cold = deriveAnalyticsSnapshot([], NOW);
  assert.equal(cold.dimensions.every((dimension) => dimension.state === "empty"), true);
  assert.equal(JSON.stringify(cold.dimensions).includes("run_id"), false);
});
