import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import { isTransientTestPath } from "#scripts/test-location-codemod.mjs";

test("W1-T10595: check:test:test/a-test-imports-through-the-subpath-alias.test.ts:flaky is prevented, not retried", () => {
  assert.equal(isTransientTestPath("test/.tmp-evid-lint-ab12/x.test.ts"), true);
  assert.equal(isTransientTestPath("test/proof-status-ab12/probe.ts"), true);
  assert.equal(isTransientTestPath("test/a-real-suite.test.ts"), false);
  assert.equal(isTransientTestPath("test/ci/suites/a.test.ts"), false);
});
