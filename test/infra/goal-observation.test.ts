import assert from "node:assert/strict";
import test from "node:test";
import { goalObservationFromRow } from "#src/lib/goal-observation.js";

const observation = () => ({ goal_id: "G-flow", key: "a".repeat(64), step: "goal.moved", ts: "2026-10-19T12:00:00.000Z",
  baseline: 8, value: 3 as number | null, tasks: ["W1-T123"], pricedUsd: 0, unpricedRows: 1,
  priorityAction: "governed-proposal", measurement: "pr-flow-minutes", windowDays: 7,
  costBasis: "produced-ledger-receipts", costComplete: false });

test("pure goal observations preserve measured and unmeasured states without inventing complete cost", () => {
  for (const step of ["goal.moved", "goal.unmoved", "goal.unmeasured"]) {
    const row = { ...observation(), step, value: step === "goal.unmeasured" ? null : 3 };
    assert.deepEqual(goalObservationFromRow(row), row);
  }
  assert.equal(goalObservationFromRow({ ...observation(), step: "goal.unmeasured" }), undefined);
  assert.equal(goalObservationFromRow({ ...observation(), value: null }), undefined);
});

test("pure goal observations refuse malformed identities units windows and unsafe costs", () => {
  for (const change of [{ goal_id: "OTHER" }, { key: "bad" }, { ts: "not-a-time" }, { baseline: Infinity },
    { value: NaN }, { tasks: ["not-a-task"] }, { tasks: Array(1001).fill("W1-T123") },
    { pricedUsd: -1 }, { pricedUsd: Infinity }, { unpricedRows: -1 }, { unpricedRows: 1.5 },
    { costComplete: null }, { costBasis: "subscription-notional" }, { windowDays: 1 },
    { measurement: "made-up" }, { priorityAction: "execute-now" }, { step: "goal.started" }])
    assert.equal(goalObservationFromRow({ ...observation(), ...change }), undefined, JSON.stringify(change));
});

test("pure goal observations redact unrelated payloads and bound the retained diagnostic", () => {
  const row = observation();
  const result = goalObservationFromRow({ ...row, reason: "r".repeat(300), rawPrompt: "MUST-NOT-RETAIN" })!;
  assert.deepEqual(result, { ...row, reason: "r".repeat(256) });
  assert.ok(!JSON.stringify(result).includes("MUST-NOT-RETAIN"));
  assert.equal(goalObservationFromRow({ ...row, reason: { secret: "MUST-NOT-RETAIN" } })!.reason, undefined);
});
