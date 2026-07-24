import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── The containment preflight is WIRED into the run path (mirrors
// test/isolation-wiring.test.ts's checks for the isolation preflight) ───────

test("the run path INVOKES probeContainment and converts a failed probe into a terminal verdict", () => {
  assert.match(runTaskSrc, /probeContainment\(/, "run-task.ts must call probeContainment");
  assert.match(runTaskSrc, /ContainmentError/, "run-task.ts must convert a failed probe into a terminal verdict");
});

test("a failed containment preflight returns a terminal blocked_containment verdict BEFORE the worktree add", () => {
  const failBlockMatch = /ContainmentError[\s\S]*?return \{ taskId, runId, merged: false, costUsd, verdict: "blocked_containment" \};/;
  assert.match(runTaskSrc, failBlockMatch, "the ContainmentError catch must return a terminal blocked_containment verdict");
  const returnIdx = runTaskSrc.search(failBlockMatch);
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  assert.ok(returnIdx >= 0 && returnIdx < worktreeAddIdx, "the fail-closed return must be BEFORE worktreeAdd");
});

// ── W1-T91/P23: the ledger verdict line carries the structured guard-cause ──

test("the blocked_containment ledger verdict line forwards guard/check/observed off the caught ContainmentError", () => {
  const containmentCatchIdx = runTaskSrc.indexOf("if (e instanceof ContainmentError)");
  assert.ok(containmentCatchIdx >= 0, "run-task.ts must catch ContainmentError");
  const block = runTaskSrc.slice(containmentCatchIdx, containmentCatchIdx + 500);
  assert.match(block, /guard:\s*e\.guard/, "the ledger verdict line must carry the structured guard field");
  assert.match(block, /check:\s*e\.check/, "the ledger verdict line must carry the structured check field");
  assert.match(block, /observed:\s*e\.observed/, "the ledger verdict line must carry the structured observed field");
});
