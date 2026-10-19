import assert from "node:assert/strict";
import { test } from "node:test";
import { ownTscDiagnostics } from "#src/lib/prompt-render.js";

test("W1-T9839: check:ci-log:ci-shard is prevented, not retried", () => {
  const out = [
    "src/lib/other.ts(3,9): error TS7006: Parameter 'args' implicitly has an 'any' type.",
    "test/the-prerequisite-split-contract-has-no-optional-seam.test.ts(20,3): error TS2578: Unused '@ts-expect-error' directive.",
    "    continuation line",
  ].join("\n");
  const abs = "/w/test/the-prerequisite-split-contract-has-no-optional-seam.test.ts";
  assert.equal(ownTscDiagnostics(out, abs).length, 1);
  assert.match(ownTscDiagnostics(out, abs)[0], /TS2578/);
  assert.deepEqual(ownTscDiagnostics(out.split("\n")[0], abs), []);
});
