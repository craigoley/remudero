import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { loadLaneGovernorMode, parseLaneGovernorMode, PolicyError } from "#src/lib/policy.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T11884: the shipped plan/policy.yaml reads the lane governor as enforce, and an absent or invalid mode never does", () => {
  assert.equal(loadLaneGovernorMode(join(REPO_ROOT, "plan", "policy.yaml")), "enforce");
  assert.equal(parseLaneGovernorMode(undefined), "shadow", "no sweep block reads shadow");
  assert.equal(parseLaneGovernorMode({}), "shadow", "no laneGovernor block reads shadow");
  assert.throws(() => parseLaneGovernorMode({ laneGovernor: { mode: { value: "bogus" } } }), PolicyError, "an unknown mode is refused, never read as enforce");
});
