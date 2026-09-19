import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptOperatorAgentCapacityRows, type OperatorAgentCapacityLedgerRow } from "../src/lib/operator-agent-capacity.js";

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
