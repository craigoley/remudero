import assert from "node:assert/strict";
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

// ── the coherence rule, asserted by CALLING it ──────────────────────────────────────────────────
// These two facts were first written as tests that read `run-task.ts` AS TEXT, which
// `source-text-assertion-census` refuses: such a test passes when the prose is right and the
// behaviour is wrong. `fixRoundGitOwnership` returns BOTH halves from one call, so the rule is a
// property of the value rather than of two call sites someone must keep in step.

import { fixRoundGitOwnership } from "../src/run-task.js";

test("with the opt-in, the harness holds git AND a shell-less surface is offered — together", () => {
  const d = fixRoundGitOwnership({ workerProviders: { harnessCommitsFix: true } } as never);
  assert.equal(d.harnessCommits, true);
  assert.deepEqual(d.cashTools, [...FIX_CASH_TOOLS]);
  assert.equal(cashCanServeToolSurface(d.cashTools), true, "and cash can actually run it");
});

test("without it, NEITHER half appears — the default is untouched", () => {
  for (const cfg of [{}, { workerProviders: {} }, { workerProviders: { harnessCommitsFix: false } }]) {
    const d = fixRoundGitOwnership(cfg as never);
    assert.equal(d.harnessCommits, false, JSON.stringify(cfg));
    assert.equal(d.cashTools, undefined, "no surface is offered to a worker told to push");
  }
});

test("the two halves cannot diverge — a surface is offered EXACTLY when the harness commits", () => {
  // THE COHERENCE RULE ITSELF. The prompt is built before the auction runs, so offering a
  // shell-less surface to a worker told to `git push` hands it, on retry, a contract it cannot
  // honour. One return value makes that impossible to get half-right.
  for (const on of [true, false]) {
    const d = fixRoundGitOwnership({ workerProviders: { harnessCommitsFix: on } } as never);
    assert.equal(d.harnessCommits, d.cashTools !== undefined, `both halves must agree at ${on}`);
  }
});
