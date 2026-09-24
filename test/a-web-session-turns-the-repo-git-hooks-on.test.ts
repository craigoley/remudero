import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

// hooks/pre-commit, pre-push and commit-msg only run where core.hooksPath=hooks. The fleet sets it
// per worktree; a Claude Code web session's clone never had it, so #6955, #6962 and #6986 each met
// a local gate for the first time in CI. .claude/hooks/session-start.sh closes that gap for web
// sessions only, and never overrides a value someone already set.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, ".claude", "hooks", "session-start.sh");

function runHook(dir: string, remote: string | undefined): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.CLAUDE_CODE_REMOTE;
  if (remote !== undefined) env.CLAUDE_CODE_REMOTE = remote;
  execFileSync("bash", [SCRIPT], { env, encoding: "utf8" });
}

function hooksPath(repo: { git(...args: string[]): string }): string {
  try {
    return repo.git("config", "--get", "core.hooksPath").trim();
  } catch {
    return "";
  }
}

test("a Claude Code web session sets core.hooksPath to the repo's hooks directory", () => {
  const repo = gitRepo({ seedCommit: false, kind: "session-start-hooks" });
  assert.equal(hooksPath(repo), "", "a fresh clone starts with no hooksPath");
  runHook(repo.dir, "true");
  assert.equal(hooksPath(repo), "hooks");
});

test("the session-start hook does nothing outside a web session and never overrides an existing hooksPath", () => {
  const local = gitRepo({ seedCommit: false, kind: "session-start-local" });
  runHook(local.dir, undefined);
  assert.equal(hooksPath(local), "", "a local session leaves the shared checkout alone");

  const custom = gitRepo({ seedCommit: false, kind: "session-start-custom" });
  custom.git("config", "core.hooksPath", "my-hooks");
  runHook(custom.dir, "true");
  assert.equal(hooksPath(custom), "my-hooks");
});

test(".claude/settings.json registers the session-start hook", () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"));
  const commands = (settings.hooks.SessionStart ?? []).flatMap((entry: { hooks: Array<{ command: string }> }) =>
    entry.hooks.map((h) => h.command),
  );
  assert.deepEqual(commands, ["bash $CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"]);
  // .gitignore excludes .claude/* by default; an ignored script never reaches a clone, and the
  // registration above would point at nothing.
  const ignored = spawnSync("git", ["check-ignore", "-q", ".claude/hooks/session-start.sh"], { cwd: REPO_ROOT });
  assert.equal(ignored.status, 1, ".claude/hooks/session-start.sh must not be git-ignored");
});
