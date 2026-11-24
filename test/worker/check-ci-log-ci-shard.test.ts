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

test("W1-T10550: boundary matcher rejects same-suffix siblings lacking a '/' boundary", () => {
  const own = "/runner/repo/test/worker/check-ci-log-ci-shard.test.ts";
  const line = (p: string) => `${p}(1,1): error TS2304: x`;
  // A path that is a bare string-suffix of the own path, but not a whole component.
  assert.deepEqual(ownTscDiagnostics(line("k-ci-log-ci-shard.test.ts"), own), []);
  assert.deepEqual(ownTscDiagnostics(line("ker/check-ci-log-ci-shard.test.ts"), own), []);
  // Same-suffix sibling where the own path is the suffix of the diagnostic path.
  assert.deepEqual(
    ownTscDiagnostics(line("xtest/worker/foo.test.ts"), "test/worker/foo.test.ts"),
    [],
  );
  assert.deepEqual(
    ownTscDiagnostics(line("test/worker/xfoo.test.ts"), "/runner/repo/test/worker/foo.test.ts"),
    [],
  );
  // Whole-component matches still count.
  assert.equal(ownTscDiagnostics(line("test/worker/check-ci-log-ci-shard.test.ts"), own).length, 1);
  assert.equal(ownTscDiagnostics(line(own), own).length, 1);
});
