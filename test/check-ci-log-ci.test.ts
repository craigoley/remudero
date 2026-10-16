import { test } from "node:test";
import assert from "node:assert/strict";
import { dropDerivativeAggregateCiFailure } from "../src/run-task.js";

test("W1-T5378: check:ci-log:ci is prevented, not retried", () => {
  const shard = { name: "ci-shard (3/8)", logTail: "not ok 1 - x" };
  // aggregate beside a real shard failure is dropped
  assert.deepEqual(dropDerivativeAggregateCiFailure([{ name: "ci", logTail: "shard failed" }, shard]), [shard]);
  // aggregate alone with an empty log leaves nothing enumerable (stand-down, no strike)
  assert.deepEqual(dropDerivativeAggregateCiFailure([{ name: "ci", logTail: "  " }]), []);
  // aggregate alone with evidence is kept
  const kept = { name: "ci", logTail: "boom" };
  assert.deepEqual(dropDerivativeAggregateCiFailure([kept]), [kept]);
  assert.deepEqual(dropDerivativeAggregateCiFailure([shard]), [shard]);
});
