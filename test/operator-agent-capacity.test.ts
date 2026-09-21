import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptOperatorAgentCapacityRows, type OperatorAgentCapacityLedgerRow } from "../src/lib/operator-agent-capacity.js";
import { adaptOperatorDecisionRows } from "../src/lib/operator-agent-decisions.js";
import { adaptOperatorAgentProofRows } from "../src/lib/operator-agent-proof.js";
import { adaptVerdictCalibrationReport } from "../src/lib/operator-agent-outcomes.js";
import type { VerdictCalibrationReport } from "../src/lib/verdict-calibration.js";

test("W1-T3797 criterion 1: pool utilization includes configured capacity, observed occupancy, queued work, and a measurement window", () => {
  const signal = adaptOperatorAgentCapacityRows([
    {
      repo: "repo-z",
      configured_capacity: 4,
      admitted_lanes: 4,
      active_workers: 4,
      queued_work: 2,
      window_start: "2026-09-19T12:00:00.000Z",
      window_end: "2026-09-19T12:05:00.000Z",
    },
  ]);

  assert.equal(signal.status, "measured");
  assert.deepEqual(signal.measurements[0], {
    repo: "repo-z",
    configuredCapacity: 4,
    admittedLanes: 4,
    activeWorkers: 4,
    queuedWork: 2,
    utilizationRatio: 1,
    windowStart: "2026-09-19T12:00:00.000Z",
    windowEnd: "2026-09-19T12:05:00.000Z",
    recommendation: "scale-up",
  });
});

test("W1-T3797 criterion 2: queue depth alone never produces an underutilization or scale recommendation", () => {
  const queueOnly: OperatorAgentCapacityLedgerRow = {
    repo: "repo-queue-only",
    queued_work: 12,
    window_start: "2026-09-19T12:00:00.000Z",
    window_end: "2026-09-19T12:05:00.000Z",
  };

  const signal = adaptOperatorAgentCapacityRows([queueOnly]);

  assert.equal(signal.status, "not-collected");
  assert.equal(signal.measurements.length, 0);
  assert.equal(signal.unavailable.length, 1);
  assert.deepEqual(signal.unavailable[0].missing, [
    "missing-configured-capacity",
    "missing-admitted-lanes",
    "missing-active-workers",
  ]);
  assert.match(signal.unavailable[0].why, /no utilization or scale signal was emitted/);
});

test("W1-T3797 criterion 3: missing scheduler capacity data is explicit unavailable and suppresses the scale signal", () => {
  const signal = adaptOperatorAgentCapacityRows([
    {
      repo: "repo-missing-capacity",
      admitted_lanes: 2,
      active_workers: 2,
      queued_work: 3,
      window_start: "2026-09-19T12:00:00.000Z",
      window_end: "2026-09-19T12:05:00.000Z",
    },
    {
      repo: "repo-underutilized",
      configured_capacity: 4,
      admitted_lanes: 1,
      active_workers: 1,
      queued_work: 0,
      window_start: "2026-09-19T12:00:00.000Z",
      window_end: "2026-09-19T12:05:00.000Z",
    },
  ]);

  assert.equal(signal.status, "measured");
  assert.equal(signal.unavailable[0].missing[0], "missing-configured-capacity");
  assert.equal(signal.measurements[0].recommendation, "underutilized");
  assert.equal(signal.measurements.some((measurement) => measurement.repo === "repo-missing-capacity"), false);
});

test("capacity adapter refuses a reversed measurement window instead of emitting a stale ratio", () => {
  const signal = adaptOperatorAgentCapacityRows([
    {
      repo: "repo-invalid-window",
      configured_capacity: 2,
      admitted_lanes: 2,
      active_workers: 2,
      queued_work: 0,
      window_start: "2026-09-19T12:05:00.000Z",
      window_end: "2026-09-19T12:00:00.000Z",
    },
  ]);

  assert.equal(signal.status, "not-collected");
  assert.deepEqual(signal.unavailable[0].missing, ["invalid-window"]);
});

test("unit test: console-v1 operator-agent projection stays below the 128 KiB response bound", () => {
  const proof = adaptOperatorAgentProofRows(
    Array.from({ length: 2000 }, (_, index) => ({
      step: "review.posted",
      task_id: `W1-T-proof-${index}`,
      proof_exec: [`unknown-proof-outcome-with-a-long-reason-${index}`],
    })),
  );
  const decisions = adaptOperatorDecisionRows([
    ...Array.from({ length: 2000 }, (_, index) => ({
      step: "panel.proposal_accepted",
      task_id: `W1-T-decision-${index}`,
      task_class: "chore",
      origin: `operator-${index}`,
    })),
    ...Array.from({ length: 2000 }, (_, index) => ({
      step: "automerge.armed",
      task_id: `W1-T-merge-${index}`,
      task_class: "chore",
    })),
  ]);
  const capacity = adaptOperatorAgentCapacityRows(
    Array.from({ length: 2000 }, (_, index) => ({
      repo: `repo-${index}`,
      configured_capacity: 4,
      admitted_lanes: 4,
      active_workers: 4,
      queued_work: 2,
      window_start: "2026-09-19T12:00:00.000Z",
      window_end: "2026-09-19T12:05:00.000Z",
    })),
  );
  const outcomes = adaptVerdictCalibrationReport({
    policy: { windowDays: 14, overlapRuleDescription: "fixture" },
    minPopulationFloor: 5,
    classes: [
      {
        verdictClass: "full-pass",
        total: 2000,
        revertedCount: 200,
        followupFixedCount: 100,
        revertRate: 0.1,
        followupFixRate: 0.05,
        lanes: "review",
        taskIds: Array.from({ length: 2000 }, (_, index) => `W1-T-outcome-${index}`),
      },
    ],
    unmeasurable: Array.from({ length: 2000 }, (_, index) => ({
      taskId: `W1-T-unmeasurable-${index}`,
      why: "fixture unavailable",
      cause: "no-review-posted",
    })),
    unmeasurableByCause: {
      "no-head-sha": 0,
      "no-review-posted": 2000,
      "merge-sha-unrecoverable": 0,
      "git-history-unavailable": 0,
    },
    armsSeen: 2000,
    armsClassified: 2000,
  } satisfies VerdictCalibrationReport);

  const projection = {
    version: "console-v1",
    asOf: "2026-09-19T12:05:00.000Z",
    metrics: Array.from({ length: 6 }, (_, index) => ({ id: `metric-${index}`, value: index })),
    operatorAgent: { proof, outcomes, decisions, capacity },
  };
  const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");

  assert.ok(bytes < 128 * 1024, `bounded operator-agent projection was ${bytes} bytes`);
  assert.equal(proof.unmeasurableCount, 2000);
  assert.equal(outcomes.unmeasurableCount, 2000);
  assert.equal(decisions.explicitDecisionCount, 2000);
  assert.equal(decisions.automaticMergeEventCount, 2000);
  assert.equal(capacity.measurementCount, 2000);
  assert.equal(proof.unmeasurable.length, 100);
  assert.equal(outcomes.unmeasurable.length, 100);
  assert.equal(decisions.explicitDecisions.length, 100);
  assert.equal(decisions.automaticMergeEvents.length, 100);
  assert.equal(capacity.measurements.length, 100);
});
