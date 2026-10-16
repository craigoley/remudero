import { test } from "node:test";
import assert from "node:assert/strict";
import { dropDerivativeAggregateCiFailure } from "../src/lib/derivative-ci-failure.js";

test("W1-T5378: check:ci-log:ci is prevented, not retried", () => {
  const shard = { name: "ci-shard (3/8)", logTail: "not ok 1 - x" };
  // aggregate beside a real shard failure is dropped
  assert.deepEqual(dropDerivativeAggregateCiFailure([{ name: "ci", logTail: "shard failed" }, shard]), [shard]);
  // aggregate alone is kept even with an empty log (the strike behaviour is unchanged)
  const empty = { name: "ci", logTail: "  " };
  assert.deepEqual(dropDerivativeAggregateCiFailure([empty]), [empty]);
  // aggregate alone with evidence is kept
  const kept = { name: "ci", logTail: "boom" };
  assert.deepEqual(dropDerivativeAggregateCiFailure([kept]), [kept]);
  assert.deepEqual(dropDerivativeAggregateCiFailure([shard]), [shard]);
});
