import test from "node:test";
import assert from "node:assert/strict";
import { blockerOwner } from "#src/lib/pr-blocker.js";

test("W1-T10266: flow-plan-proof-unrunnable-plan-only-pr-is-red-on-ci-shard-n-n-lint-plan clears without a person", () => {
  assert.equal(blockerOwner("plan-proof-unrunnable", true), "plan-repair");
  assert.equal(blockerOwner("plan-proof-unrunnable", false), "operator");
  assert.equal(blockerOwner("own-red", false), "fix-lane");
});
