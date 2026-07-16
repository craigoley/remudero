import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── §5C Layer A pre-dispatch guard is WIRED into the run path (W1-T20c) ───────

test("the run path INVOKES assertLintClean right after assertRunnable (the pre-dispatch guard is wired, not just implemented)", () => {
  assert.match(runTaskSrc, /assertLintClean\(/, "run-task.ts must call assertLintClean");
  assert.match(runTaskSrc, /TaskLintError/, "run-task.ts must convert a failing lint into a terminal verdict");
  const assertRunnableIdx = runTaskSrc.indexOf("assertRunnable(plan, task, isMerged)");
  const lintIdx = runTaskSrc.indexOf("assertLintClean(");
  assert.ok(assertRunnableIdx >= 0, "assertRunnable must be called");
  assert.ok(lintIdx > assertRunnableIdx, "the lint guard must run AFTER assertRunnable (unmet-deps/blocked/verify:human are checked first)");
});

test("the lint guard runs BEFORE the inflight lock and BEFORE any worktree/worker work — no spawn on a linter-failing task", () => {
  const lintIdx = runTaskSrc.indexOf("assertLintClean(");
  const inflightIdx = runTaskSrc.indexOf("acquireInflightLock(");
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  assert.ok(lintIdx >= 0, "assertLintClean must be called somewhere in run-task.ts");
  assert.ok(lintIdx < inflightIdx, "the lint guard must precede the inflight lock");
  assert.ok(lintIdx < worktreeAddIdx, "the lint guard must precede worktreeAdd (repo/worktree setup)");
  assert.ok(lintIdx < reconIdx, "the lint guard must precede the recon worker spawn");
});

test("a failing lint returns a terminal blocked_illformed verdict with zero cost — no worker ever ran", () => {
  const failBlockMatch =
    /TaskLintError[\s\S]*?return \{ taskId, runId, merged: false, costUsd: 0, verdict: "blocked_illformed" \};/;
  assert.match(runTaskSrc, failBlockMatch, "the TaskLintError catch must return a terminal blocked_illformed verdict");
});

test("blocked_illformed is a recognized terminal verdict on RunResult", () => {
  assert.match(runTaskSrc, /"blocked_illformed"/);
});

// ── the CI half is wired too ───────────────────────────────────────────────────

test("rmd lint-plan is wired into the CLI dispatch", () => {
  assert.match(runTaskSrc, /cmd === "lint-plan"/);
  assert.match(runTaskSrc, /lintPlanCommand/);
});
