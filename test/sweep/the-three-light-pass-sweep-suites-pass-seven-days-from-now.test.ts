import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runSuitesShifted } from "#src/lib/gate-gardener.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T15078. OBSERVED 2026-11-27: each of these suites held a fixed gh-shim `updated_at` that aged past
// sweep.staleDays as the wall clock moved, and the expiring-fixture census confirmed two of them red with
// Date.now shifted +2 days, which blocked every core PR's light-gates. Their fixtures now age from the clock.
const FILES = [
  "test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts",
  "test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts",
  "test/sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views.test.ts",
] as const;

function failures(shiftDays: number): string[] {
  const results = runSuitesShifted(REPO_ROOT, FILES, shiftDays);
  assert.equal(results.size, FILES.length, "every suite reported its own result");
  return [...results].flatMap(([file, r]) => {
    if ("error" in r) return [`${file}: ${r.error.message}`];
    assert.ok(r.tests > 0, `${file} ran named tests`);
    return r.passed ? [] : [file];
  });
}

test("W1-T15078 criterion 1: the three light-pass suites pass seven days from now", () => {
  for (const file of FILES) assert.ok(existsSync(join(REPO_ROOT, file)), `${file} exists — a ghost path would read as a clean pass`);
  assert.deepEqual(failures(0), [], "every suite passes at the real clock");
  assert.deepEqual(failures(7), [], "every suite passes with Date.now shifted +7 days");
});
