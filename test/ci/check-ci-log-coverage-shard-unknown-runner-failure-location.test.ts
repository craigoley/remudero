import assert from "node:assert/strict";
import { test } from "node:test";
import { ciFailureSignature } from "#src/lib/ci-friction-gardener.js";

const tap = (location: string) =>
  [
    "not ok 1277 - semantic mode with no head-resolved task metadata names its deterministic fallback",
    "  ---",
    "  duration_ms: 28411.08",
    "  type: 'test'",
    ...(location ? [`  location: '${location}'`] : []),
    "  failureType: 'testCodeFailure'",
    "  code: 'ERR_ASSERTION'",
    "  ...",
  ].join("\n");

test("W1-T10241: check:ci-log:coverage-shard:unknown-runner-failure-location is prevented, not retried", () => {
  // A located failure is attributed to its file, so a fix round can aim at it.
  assert.equal(
    ciFailureSignature(tap("/home/runner/work/remudero/remudero/test/event-driven-semantic-review.test.ts:118:1")),
    "test/event-driven-semantic-review.test.ts",
  );
  // A failure with no usable location never borrows a path from its title: it is named unknown.
  const unlocated = ciFailureSignature(tap(""));
  assert.ok(unlocated, "an unlocated failure still yields a signature");
  assert.doesNotMatch(unlocated, /^test\//);
});
