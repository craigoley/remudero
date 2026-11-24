import assert from "node:assert/strict";
import { test } from "node:test";
import { ownTscDiagnostics } from "#src/lib/prompt-render.js";

test("W1-T10550: check:ci-log:ci-shard is prevented, not retried", () => {
  const output = [
    "test/worker/check-ci-log-ci-shard.test.ts(8,1): error TS2304: own test error",
    "/runner/repo/test/other/check-ci-log-ci-shard.test.ts(9,1): error TS2304: sibling test error",
  ].join("\n");

  assert.deepEqual(
    ownTscDiagnostics(output, "/runner/repo/test/worker/check-ci-log-ci-shard.test.ts"),
    ["test/worker/check-ci-log-ci-shard.test.ts(8,1): error TS2304: own test error"],
  );
});
