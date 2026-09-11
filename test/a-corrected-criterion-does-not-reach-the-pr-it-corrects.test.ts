import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Acceptance proof: unit test: test/a-corrected-criterion-does-not-reach-the-pr-it-corrects.test.ts

const task = (id: string, criterion: string) => [
  `- id: ${id}`,
  "  title: stale criterion",
  "  repo: remudero",
  "  type: implement",
  "  depends_on: []",
  "  verify: auto",
  "  status: queued",
  "  attempts: 0",
  "  acceptance:",
  `    - claim: \"${criterion}\"`,
  "      proof: \"grep: marker in src/example.ts\"",
].join("\n");

function gitPlanRepo(): { dir: string; run: (args: string[]) => string; commit: (message: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-stale-plan-tree-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Test"]);
  run(["remote", "add", "origin", "https://github.com/o/r.git"]);
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  const commit = (message: string) => {
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", message, "--allow-empty"]);
    return run(["rev-parse", "HEAD"]).trim();
  };
  return { dir, run, commit };
}

let reviewCommand: typeof import("../src/run-task.js").reviewCommand | undefined;

async function reviewLogs(repoDir: string, headRefOid: string, state: "success" | "failure"): Promise<string[]> {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-stale-plan-tree-state-"));
  try {
    if (!reviewCommand) {
      const argv = process.argv;
      process.argv = [...argv, "--repo-root", repoDir];
      try {
        ({ reviewCommand } = await import("../src/run-task.js"));
      } finally {
        process.argv = argv;
      }
    }
    const logs: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => logs.push(parts.join(" "));
    try {
      await reviewCommand("branch", ["--repo", "o/r"], {
        fetchView: () => ({ headRefOid, headRefName: "branch", body: "Remudero-Task: W1-STALE", url: "https://github.com/o/r/pull/1", number: 1 }),
        loadConfig: () => ({ root: stateRoot }),
        fetchHead: () => {},
        materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip" } }),
        postReviewPending: async () => ({ posted: false }),
        runReview: async () => ({ state, headSha: headRefOid, keywordOnly: false, criteria: [{ met: state === "success" }] }),
      });
    } finally {
      console.log = log;
    }
    return logs;
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

test("a corrected criterion does not reach the PR it corrects", async () => {
  const { dir, run, commit } = gitPlanRepo();
  try {
    writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-BASE", "base criterion") + "\n");
    writeFileSync(join(dir, "plan", "tasks.d", "task.yaml"), task("W1-STALE", "old criterion"));
    const oldHead = commit("old criterion");
    writeFileSync(join(dir, "plan", "tasks.d", "task.yaml"), task("W1-STALE", "corrected criterion"));
    const mainHead = commit("correct criterion on main");
    run(["update-ref", "refs/remotes/origin/main", mainHead]);

    const staleFailure = await reviewLogs(dir, oldHead, "failure");
    assert.match(staleFailure.join("\n"), /older than origin\/main.*merge origin\/main into the branch/);

    // MUTANT: changing either guard to warn for a matching tree or a fully MET verdict makes one
    // of these controls fail.
    assert.doesNotMatch((await reviewLogs(dir, oldHead, "success")).join("\n"), /older than origin\/main/);
    assert.doesNotMatch((await reviewLogs(dir, mainHead, "failure")).join("\n"), /older than origin\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
