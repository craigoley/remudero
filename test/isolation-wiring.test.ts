import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── The isolation preflight is WIRED into the run path, before any task work ─

test("the run path INVOKES probeIsolation (the preflight probe is wired, not just implemented)", () => {
  assert.match(runTaskSrc, /probeIsolation\(/, "run-task.ts must call probeIsolation");
  assert.match(runTaskSrc, /IsolationError/, "run-task.ts must convert a failed probe into a terminal verdict");
});

test("the isolation preflight runs BEFORE any task worker (recon/implement) or worktree work", () => {
  const isoCallIdx = runTaskSrc.indexOf("probeIsolation(");
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  const implPromptIdx = runTaskSrc.indexOf("renderImplementPrompt(task,");
  assert.ok(isoCallIdx >= 0, "probeIsolation must be called somewhere in run-task.ts");
  assert.ok(isoCallIdx < worktreeAddIdx, "preflight must precede worktreeAdd (repo/worktree setup)");
  assert.ok(isoCallIdx < reconIdx, "preflight must precede the recon worker spawn");
  assert.ok(isoCallIdx < implPromptIdx, "preflight must precede the implement prompt/spawn");
});

test("a failed isolation preflight returns BEFORE the worktree add — no implement.done can ever log", () => {
  const failBlockMatch = /IsolationError[\s\S]*?return \{ taskId, runId, merged: false, costUsd, verdict: "blocked_isolation" \};/;
  assert.match(runTaskSrc, failBlockMatch, "the IsolationError catch must return a terminal blocked_isolation verdict");
  const returnIdx = runTaskSrc.search(failBlockMatch);
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  assert.ok(returnIdx >= 0 && returnIdx < worktreeAddIdx, "the fail-closed return must be BEFORE worktreeAdd");
});

test("blocked_isolation is a recognized terminal verdict on RunResult", () => {
  assert.match(runTaskSrc, /"blocked_isolation"/);
});
