import { test } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error -- plain .mjs script without declarations
import { formatFlakeLabel } from "#scripts/test-with-retry.mjs";

test("W1-T10140: check:ci-log:coverage-shard:flake-retry-first-attempt-failed-no-test-name-parsed-from-ou is prevented, not retried", () => {
  // The nameless first-attempt label is the one stable signature the gardener counts; pin it so the
  // signature cannot drift silently, and a named failure never collapses into it.
  assert.equal(formatFlakeLabel([]), "(no test name parsed from output)");
  assert.equal(formatFlakeLabel(["a", "b"]), "a, b");
});
