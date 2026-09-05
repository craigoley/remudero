import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_PATH = join(REPO_ROOT, "test", "a-source-file-cannot-outgrow-its-baseline.test.ts");

/**
 * Find the obsolete compatibility-mode shape: this suite's local `run` helper receiving both
 * `--root REPO_ROOT` and `--baseline …`. The baseline expression is deliberately unconstrained;
 * copying the historical file first still subjects the shipped tree to that historical ceiling.
 */
function shippedTreeLegacyBaselineCalls(source: string): string[] {
  return [...source.matchAll(/\brun\s*\(\s*\[([^\]]*)\]\s*\)/g)]
    .map((match) => match[0])
    .filter(
      (call) =>
        /["']--root["']\s*,\s*REPO_ROOT\b/.test(call) &&
        /["']--baseline["']/.test(call),
    );
}

test("W1-T2861: the full suite never applies legacy source-size baseline enforcement to the shipped repository tree", () => {
  const source = readFileSync(SUITE_PATH, "utf8");
  assert.deepEqual(
    shippedTreeLegacyBaselineCalls(source),
    [],
    "legacy --baseline mode belongs in isolated fixtures; applying it to REPO_ROOT turns honest source growth into a full-suite failure",
  );
});
