import assert from "node:assert/strict";
import { test } from "node:test";
import {
  harnessCommitForShellLessWorker,
  retroPrompt,
} from "../src/run-task.js";
import {
  cashCanServeToolSurface,
  cashDivertToolsForLane,
  harnessOwnsGitFor,
} from "../src/lib/worker.js";

test("W1-T3746: retro's cash surface is runnable and shell-less", () => {
  const tools = cashDivertToolsForLane("retro");
  assert.deepEqual([...tools!], ["Read", "Grep", "Glob", "Edit", "RunCheck"]);
  assert.equal(cashCanServeToolSurface(tools), true);
  assert.equal(harnessOwnsGitFor(tools), true);
});

test("W1-T3746: the retro prompt carries a coherent shell and shell-less commit contract", () => {
  const prompt = retroPrompt("gather", "calibration", "RETRO-123", true);
  assert.match(prompt, /If your surface includes Bash, git add MASTER-PLAN\.md/);
  assert.match(prompt, /if your surface is shell-less, do NOT run git commands/);
  assert.match(prompt, /COMMIT_MESSAGE: <type>\(<scope>\): <subject>/);
  assert.match(prompt, /the harness commits,\n  regenerates its artifacts/);
});

test("W1-T3746: a shell-less retro report is committed by the harness bridge", () => {
  const calls: string[][] = [];
  const events: string[] = [];
  const ahead = harnessCommitForShellLessWorker(
    {
      harnessOwnsGit: true,
      commitCount: 0,
      report: "REPORT\nCOMMIT_MESSAGE: chore(plan): retro update",
      worktreePath: "/tmp/retro-worktree",
      declaredPaths: ["MASTER-PLAN.md"],
      log: (step) => events.push(step),
      say: () => undefined,
    },
    {
      commit: (path, declared, message) => {
        calls.push([path, ...declared, message]);
        return { committed: true, sha: "abc12345", undeclared: [] };
      },
      ahead: () => 1,
    },
  );
  assert.equal(ahead, 1);
  assert.deepEqual(calls, [["/tmp/retro-worktree", "MASTER-PLAN.md", "chore(plan): retro update"]]);
  assert.deepEqual(events, ["implement.harness_commit"]);
});
