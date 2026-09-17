import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIX_CASH_TOOLS, FIX_WORKER_TOOLS } from "../src/lib/fix-fence.js";
import { cashCanServeToolSurface, cashFallbackRefusal } from "../src/lib/worker.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import type { Config } from "../src/lib/config-schema.js";

// W1-T3727. MEASURED on the first live squeeze (2026-09-17): claude weekly 100%, codex unreadable,
// and this rung logged "fix rung: strike 1/2 REFUSED — spawn infrastructure blocked" on every
// attempt. Repairing a red pull request is exactly what a squeeze needs and exactly what died.

const cfg = (over: Record<string, unknown> = {}) =>
  ({ claudeBin: "/unused", root: "/tmp", dailyCapUsd: 25,
     workerProviders: { enabled: ["claude", "cash"], cashFallbackWhenBlocked: true, ...over } }) as unknown as Config;

test("the fix rung's Claude surface is what the auction refused — this is the defect", () => {
  assert.ok(FIX_WORKER_TOOLS.includes("Bash"), "the Claude surface really does name a shell");
  assert.equal(cashCanServeToolSurface(FIX_WORKER_TOOLS), false);
  assert.match(String(cashFallbackRefusal(cfg(), FIX_WORKER_TOOLS)), /not implementable by cash/);
});

test("the cash surface is servable, and swaps ONLY the shell for the check-runner", () => {
  assert.equal(cashCanServeToolSurface(FIX_CASH_TOOLS), true);
  assert.equal(cashFallbackRefusal(cfg(), FIX_CASH_TOOLS), undefined, "eligible for the fallback");
  assert.equal(FIX_CASH_TOOLS.includes("Bash"), false, "no shell");
  assert.ok(FIX_CASH_TOOLS.includes("RunCheck"), "the check-runner replaces it");
  // The EDIT surface is untouched — this rung's actual job is reading and editing failing code.
  for (const t of ["Read", "Write", "Edit", "Grep", "Glob"]) {
    assert.ok(FIX_CASH_TOOLS.includes(t), `${t} must survive the swap`);
    assert.ok(FIX_WORKER_TOOLS.includes(t), `${t} is in the Claude surface too`);
  }
});

test("the Claude surface is NOT narrowed — this adds a lane, it does not take one away", () => {
  assert.deepEqual(FIX_WORKER_TOOLS, ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
});

const promptOpts = {
  task: { id: "W1-T1", title: "t", files: ["src/a.ts"] },
  round: 1,
  branch: "run-W1-T1-1",
  evidence: { constraint: undefined } as never,
};

test("a shell-less round is told the HARNESS commits, and is never asked to run git", () => {
  const p = renderFixPrompt({ ...promptOpts, harnessCommits: true } as never);
  assert.match(p, /you have no shell on this round/);
  assert.match(p, /the\s+harness commits them/);
  assert.match(p, /COMMIT_MESSAGE:/);
  assert.doesNotMatch(p, /git push origin HEAD/, "asking a shell-less worker to push is the incoherence");
});

test("a Claude round still pushes for itself — the default is unchanged", () => {
  const p = renderFixPrompt({ ...promptOpts } as never);
  assert.match(p, /git push origin HEAD/);
  assert.doesNotMatch(p, /you have no shell/);
});

test("the cash surface is offered ONLY where the prompt already said the harness commits", () => {
  // THE COHERENCE RULE. The prompt is built before the auction runs, so offering a shell-less
  // surface to a worker whose prompt said `git push` hands it, on retry, a contract it cannot
  // honour — the same rule W1-T3696 states for implement.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(src, /const fixCashTools = fixHarnessOwnsGit \? \[\.\.\.FIX_CASH_TOOLS\] : undefined;/);
  assert.match(src, /harnessCommits: fixHarnessOwnsGit,/, "the same value governs the prompt");
});

test("the harness commit runs BEFORE the round's commits are counted, or the push carries nothing", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const commit = src.indexOf("harnessCommitForShellLessWorker({\n        harnessOwnsGit: true,");
  const count = src.indexOf("deps.readRoundCommits", commit);
  assert.ok(commit > 0, "the harness commit is wired into the fix round");
  assert.ok(count > commit, "and it precedes readRoundCommits, which decides what the push carries");
});
