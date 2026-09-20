import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptOperatorAgentProofRows } from "../src/lib/operator-agent-proof.js";

test("W1-T3794 criterion 1: executed proof passes and failures are counted from review.posted proof_exec values with a named denominator", () => {
  const signal = adaptOperatorAgentProofRows([
    { step: "review.posted", task_id: "W1-T1", proof_exec: ["executed_pass", "executed_fail", "not_executable", "exec_error"] },
    { step: "review.posted", task_id: "W1-T2", proof_exec: ["executed_pass"] },
  ]);

  assert.equal(signal.status, "measured");
  assert.equal(signal.reviewRows, 2);
  assert.equal(signal.executedPass, 2);
  assert.equal(signal.executedFail, 1);
  assert.equal(signal.nonExecutable, 1);
  assert.equal(signal.executionError, 1);
  assert.equal(signal.denominator, 3);
  assert.equal(signal.passRate, 2 / 3);
});

test("proof adapter keeps unknown and absent proof outcomes unmeasurable rather than changing the rate", () => {
  const signal = adaptOperatorAgentProofRows([
    { step: "review.posted", task_id: "W1-T3" },
    { step: "review.posted", task_id: "W1-T4", proof_exec: [] },
    { step: "review.posted", task_id: "W1-T5", proof_exec: ["future_outcome"] },
  ]);

  assert.equal(signal.status, "not-collected");
  assert.equal(signal.denominator, null);
  assert.equal(signal.passRate, null);
  assert.deepEqual(signal.unmeasurable.map((item) => item.cause), [
    "missing-proof-exec",
    "empty-proof-exec",
    "unknown-proof-exec",
  ]);
});
