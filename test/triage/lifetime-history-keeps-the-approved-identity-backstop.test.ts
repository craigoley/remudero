import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { MAX_LIFETIME_ARCHIVE_START_IDENTITIES } from "#test/helpers/run-task-test.js";

// The operator retained this bound while approving a structural repair for PR #13789.
// A passing presence proof must not silently authorize a larger identity population.
test("lifetime history retains the operator-protected 4096 identity backstop", () => {
  assert.equal(MAX_LIFETIME_ARCHIVE_START_IDENTITIES, 4_096,
    "a larger lifetime identity backstop requires a separate operator decision");
});

test("the temporary recovery keeps the unapproved reduced scout fixture out of main", () => {
  assert.equal(existsSync(join(REPO_ROOT, "test/gardeners/scout-dispatch-lifetime-history-unavailable.test.ts")), false,
    "the reduced fixture remains preserved outside main until the original history contract is repaired");
});
