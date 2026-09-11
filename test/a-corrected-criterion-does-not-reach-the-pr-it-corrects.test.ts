import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_TS = join(REPO_ROOT, "src", "run-task.ts");

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

function reviewLogs(repoDir: string, headRefOid: string, state: "success" | "failure"): string[] {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-stale-plan-tree-state-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "rmd-stale-plan-tree-probe-"));
  const script = join(scriptDir, "probe.ts");
  try {
    writeFileSync(script, [
      `import { reviewCommand } from ${JSON.stringify(RUN_TASK_TS)};`,
      "const logs = [];",
      "console.log = (...parts) => logs.push(parts.join(' '));",
      "async function main() {",
      `await reviewCommand("branch", ["--repo", "o/r"], {`,
      `  fetchView: () => ({ headRefOid: ${JSON.stringify(headRefOid)}, headRefName: "branch", body: "Remudero-Task: W1-STALE", url: "https://github.com/o/r/pull/1", number: 1 }),`,
      `  loadConfig: () => ({ root: ${JSON.stringify(stateRoot)} }),`,
      "  fetchHead: () => {},",
      "  materialize: () => ({ worktreePath: undefined, failure: { errorClass: 'test', message: 'skip' } }),",
      "  postReviewPending: async () => ({ posted: false }),",
      `  runReview: async () => ({ state: ${JSON.stringify(state)}, headSha: ${JSON.stringify(headRefOid)}, keywordOnly: false, criteria: [{ met: ${state === "success"} }] }),`,
      "});",
      "process.stdout.write(JSON.stringify(logs));",
      "}",
      "main();",
    ].join("\n"));
    const env = { ...process.env, NODE_V8_COVERAGE: undefined };
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--repo-root", repoDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as string[];
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

test("a corrected criterion does not reach the PR it corrects", () => {
  const { dir, run, commit } = gitPlanRepo();
  try {
    writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-BASE", "base criterion") + "\n");
    writeFileSync(join(dir, "plan", "tasks.d", "task.yaml"), task("W1-STALE", "old criterion"));
    const oldHead = commit("old criterion");
    writeFileSync(join(dir, "plan", "tasks.d", "task.yaml"), task("W1-STALE", "corrected criterion"));
    const mainHead = commit("correct criterion on main");
    run(["update-ref", "refs/remotes/origin/main", mainHead]);

    const staleFailure = reviewLogs(dir, oldHead, "failure");
    assert.match(staleFailure.join("\n"), /older than origin\/main.*merge origin\/main into the branch/);

    // MUTANT: changing either guard to warn for a matching tree or a fully MET verdict makes one
    // of these controls fail.
    assert.doesNotMatch(reviewLogs(dir, oldHead, "success").join("\n"), /older than origin\/main/);
    assert.doesNotMatch(reviewLogs(dir, mainHead, "failure").join("\n"), /older than origin\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
