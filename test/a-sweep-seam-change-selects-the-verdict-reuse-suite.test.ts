import assert from "node:assert/strict";
import { test } from "node:test";

import { selectAffectedSuites } from "../src/lib/affected-suites.js";

/**
 * W1-T4994 — A SWEEP-SEAM CHANGE SELECTS THE VERDICT-REUSE SUITE. The suite drives runSweep and
 * buildSweepEffects, and a coverage shard failed on it at 39737b73 after the narrow selector missed it,
 * so a change to the sweep, status or run-task seams must select it by path even when nothing imports it.
 */

const VERDICT_REUSE = "test/a-verdict-is-reused-when-nothing-it-judged-changed.test.ts";

function select(changed: string[]) {
  // The suite exists but imports nothing the change touches, so only the path rule can pick it.
  const files = new Map<string, string>([
    [VERDICT_REUSE, "import { test } from \"node:test\";\n"],
    ["src/lib/sweep.ts", "export const x = 1;\n"],
    ["src/lib/status.ts", "export const y = 1;\n"],
    ["src/run-task.ts", "export const z = 1;\n"],
    ["src/lib/inbox.ts", "export const w = 1;\n"],
  ]);
  return selectAffectedSuites(changed, { files, pathReaders: [] });
}

test("W1-T4994: a change to a sweep, status or run-task seam selects the verdict-reuse suite", () => {
  for (const seam of ["src/lib/sweep.ts", "src/lib/status.ts", "src/run-task.ts"]) {
    const selection = select([seam]);
    assert.equal(selection.fullRun, false, `${seam} is a narrow change in this fixture`);
    assert.ok(selection.suites.includes(VERDICT_REUSE), `${seam} must select ${VERDICT_REUSE}`);
  }
});

test("W1-T4994: a change outside those seams does not select the verdict-reuse suite by path", () => {
  const selection = select(["src/lib/inbox.ts"]);
  assert.equal(selection.suites.includes(VERDICT_REUSE), false);
});
