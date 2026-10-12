import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkCommitMessage } from "../src/lib/commit-message.js";
import { applyPlanProposalCommit, planCommitMessage } from "../src/lib/plan-architect.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { planCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
}
function seed(cwd: string): void {
  git(cwd, "init", "--quiet", "-b", "main");
  git(cwd, "config", "user.name", "test");
  git(cwd, "config", "user.email", "test@example.com");
  mkdirSync(join(cwd, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(cwd, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T4\n    title: seed task\n");
  writeFileSync(join(cwd, "MASTER-PLAN.md"), "# Plan\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "chore(plan): seed");
}

test("W1-T5122: a proposal over a long multi-line brief commits and passes commitlint", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-architect-commit-"));
  const url = `https://example.com/${"evidence".repeat(40)}`;
  const brief = `Repair the proposal lane.\nEvidence: ${url}\n${"unbreakable".repeat(20)}\n${"measured ledger evidence ".repeat(200)}`;
  try {
    seed(cwd);
    const cli = join(root, "node_modules", ".bin", "commitlint");
    const config = join(root, "commitlint.config.mjs");
    const quote = (s: string) => `'${s.replaceAll("'", "'\"'\"'")}'`;
    writeFileSync(join(cwd, ".git", "hooks", "commit-msg"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} --config ${quote(config)} --edit "$1"\n`,
      { mode: 0o755 });
    for (const detail of ["add a grounded task", `add a task citing ${url}`, "x".repeat(300)]) {
      writeFileSync(join(cwd, "MASTER-PLAN.md"), `# Plan\n\n${detail}\n`);
      const before = git(cwd, "rev-parse", "HEAD");
      const message = planCommitMessage({
        decision: { action: "propose", detail, files: ["MASTER-PLAN.md"] }, mode: "expand", brief,
      });
      // W1-T6136: the default leaf runs no tracked hook, so the commitlint hook needs a raw git to fire.
      applyPlanProposalCommit(cwd, message, undefined, (dir, args, stdio) =>
        String(execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv, stdio }) ?? ""));
      assert.notEqual(git(cwd, "rev-parse", "HEAD"), before);
      assert.deepEqual(checkCommitMessage(message), []);
      assert.match(message, /Operator brief \(summary\) — repair the proposal lane/);
      assert.doesNotMatch(message, /Evidence:|Brief:/);
      assert.ok(!message.includes(url), "unbreakable overflow falls back to the header and brief summary");
      assert.equal(git(cwd, "log", "-1", "--format=%B").trimEnd(), message);
      const result = spawnSync(process.execPath, [cli, "--config", config], { input: message, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const wholePlan = planCommitMessage({
      decision: { action: "propose", detail: "consider the whole plan", files: ["MASTER-PLAN.md"] },
      mode: "clarify", brief: "",
    });
    assert.match(wholePlan, /Operator brief \(summary\) — \(none — whole-plan scope\)/);
    assert.deepEqual(checkCommitMessage(wholePlan), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("W1-T5122: the Architect resolves its model from the mounts architect row", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "rmd-architect-mount-"));
  const shim = ghShim([{ when: "pr list", stdout: "[]" }]);
  const oldPath = process.env.PATH;
  const configRoot = join(fixture, "instance");
  const repoDir = join(configRoot, "repos", "remudero");
  const bare = join(fixture, "origin.git");
  const mount = loadMounts(mountsPath(root)).architect;
  const stopped = new Error("fixture stops at the paid spawn boundary");
  let spawns = 0;
  try {
    mkdirSync(repoDir, { recursive: true });
    seed(repoDir);
    git(fixture, "init", "--quiet", "--bare", "-b", "main", bare);
    git(repoDir, "remote", "add", "origin", bare);
    git(repoDir, "push", "--quiet", "origin", "main");
    process.env.PATH = `${shim.dir}:${oldPath}`;
    await assert.rejects(planCommand(["--mode=clarify", "inspect the existing task"], {
      config: { root: configRoot, installRoot: root, claudeBin: "/bin/true", architectModel: "opus" },
      spawn: async (options) => {
        spawns++;
        assert.equal(options.model, mount.model);
        assert.equal(options.effort, mount.effort);
        assert.equal(options.maxTurns, mount.maxTurns);
        throw stopped;
      },
    }), (error: unknown) => error === stopped);
    assert.equal(spawns, 1);
    const rows = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const start = rows.find((row) => row.step === "plan.start");
    assert.equal(start.architect, mount.model);
    assert.equal(start.effort, mount.effort);
    assert.equal(start.brief, "inspect the existing task");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
