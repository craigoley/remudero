import test from "node:test";
import assert from "node:assert/strict";
import { blockerFields } from "#src/lib/pr-blocker.js";

test("W1-T10226: flow-plan-proof-unrunnable-plan-only-pr-is-red-on-lint-plan-ci-shard-n-n clears without a person", () => {
  for (const capable of [true, false]) {
    const row = blockerFields("plan-proof-unrunnable", undefined, Date.now(), capable);
    assert.equal(row.blocker_owner, "plan-repair");
  }
});
