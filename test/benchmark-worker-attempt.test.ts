import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkRunAttemptReceipt } from "../src/lib/benchmark-run.js";

test("benchmark worker attempts join each spawn without duplicating the run verdict", () => {
  const one = benchmarkRunAttemptReceipt({ step: "worker.attempt", selection_assignment_id: "a1", success: true });
  const two = benchmarkRunAttemptReceipt({ step: "worker.attempt", selection_assignment_id: "a2", success: false });
  assert.equal(one?.phase, "attempt");
  assert.equal(two?.phase, "attempt");
  assert.deepEqual(one?.assignmentJoin, { state: "observed", value: true });
  assert.equal(benchmarkRunAttemptReceipt({ step: "verdict", selection_assignment_id: "a2", success: true }), undefined);
  assert.doesNotMatch(JSON.stringify([one, two]), /a1|a2/);
});

test("benchmark worker attempts preserve failure and missing resource evidence", () => {
  const failed = benchmarkRunAttemptReceipt({ step: "worker.attempt", success: false, worker_failure: "thrown" });
  assert.deepEqual(failed?.workerCall, { state: "failed", value: false });
  assert.deepEqual(failed?.assignmentJoin, { state: "unavailable", reason: "assignment-id-not-reported" });
  assert.equal(failed?.servedModel.state, "unavailable");
  assert.equal(failed?.tokens.state, "unavailable");
  assert.equal(failed?.durationMs.state, "unavailable");
  assert.equal(failed?.accounting.apiCostUsd.state, "unavailable");
});

test("benchmark worker attempts separate cash from notional cost", () => {
  const base = { step: "worker.attempt", selection_assignment_id: "a1", success: true,
    served_model: "model", tokens: { input: 2, output: 3 }, worker_duration_ms: 12, total_cost_usd: 0.5 };
  const cash = benchmarkRunAttemptReceipt({ ...base, billing_mode: "api" });
  const subscription = benchmarkRunAttemptReceipt({ ...base, billing_mode: "subscription" });
  assert.deepEqual(cash?.accounting.apiCostUsd, { state: "observed", value: 0.5 });
  assert.equal(cash?.accounting.subscriptionNotionalUsd.state, "unavailable");
  assert.deepEqual(subscription?.accounting.subscriptionNotionalUsd, { state: "observed", value: 0.5 });
  assert.equal(subscription?.accounting.apiCostUsd.state, "unavailable");
});
