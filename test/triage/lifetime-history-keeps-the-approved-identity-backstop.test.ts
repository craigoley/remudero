import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LIFETIME_ARCHIVE_START_IDENTITIES } from "#test/helpers/run-task-test.js";

// The operator retained this bound while approving a structural repair for PR #13789.
// A passing presence proof must not silently authorize a larger identity population.
test("lifetime history retains the operator-protected 4096 identity backstop", () => {
  assert.equal(MAX_LIFETIME_ARCHIVE_START_IDENTITIES, 4_096,
    "a larger lifetime identity backstop requires a separate operator decision");
});
