/**
 * A PRE-PUSH GATE THAT NEVER READS ITS STDIN IS JUDGED BY ITS EXIT STATUS, AS GIT JUDGES IT.
 *
 * The push leaf runs the harness's pre-push itself, feeding it git's ref line through `spawnSync`'s
 * `input`. A hook that exits without reading that line closes the pipe first when the runner is loaded,
 * and `spawnSync` then reports EPIPE on a hook that exited 0: the push was refused with no stderr
 * (W1-T6133's renumber test in the slow shard). git ignores SIGPIPE while feeding pre-push, so the exit
 * status is the whole verdict. A refusal that has no stderr also names how the hook ended.
 *
 * FIXTURES ONLY: every repository and hook below is under this suite's own mkdtemp root.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

// A NAMESPACE import: at the merge base `gateHookRefused` does not exist, and a named import would fail
// the whole file at load rather than the subtests that need it.
import * as gitPush from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { worktreeAdd } from "../src/lib/worker.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

let root: string;
let harnessHooks: string;
const savedHooksDir = process.env.RMD_HARNESS_HOOKS_DIR;
let counter = 0;

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

before(() => {
  root = makeTempDir("prepush-stdin");
  harnessHooks = join(root, "harness-hooks");
  mkdirSync(harnessHooks);
  process.env.RMD_HARNESS_HOOKS_DIR = harnessHooks;
});

after(() => {
  if (savedHooksDir === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
  else process.env.RMD_HARNESS_HOOKS_DIR = savedHooksDir;
  rmSync(root, { recursive: true, force: true });
});

/** A run worktree cut by the real `worktreeAdd`, so its pinned config enables the harness gate. */
function lane(): { wt: string } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `prepush-stdin-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `prepush-stdin-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `wt-${n}`);
  worktreeAdd(seed.dir, wt, `run-prepush-stdin-${n}-1`, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  writeFileSync(join(wt, "a.txt"), `${n}\n`);
  spawnSync("git", ["-C", wt, "add", "a.txt"]);
  spawnSync("git", ["-C", wt, "-c", "core.hooksPath=/dev/null", "-c", `user.email=${GIT_REPO_FIXTURE_IDENTITY.email}`, "-c", `user.name=${GIT_REPO_FIXTURE_IDENTITY.name}`, "commit", "-q", "-m", "feat: a"]);
  return { wt };
}

test("a pre-push gate that exits 0 without reading its stdin passes even when feeding it hits a closed pipe", () => {
  const hook = join(root, "never-reads.sh");
  script(hook, "exit 0");
  // A large input makes the closed pipe certain; under load a one-line input hits it by timing alone.
  const res = spawnSync(hook, [], { input: "x".repeat(512 * 1024), encoding: "utf8" });
  assert.equal((res.error as NodeJS.ErrnoException | undefined)?.code, "EPIPE", "control: feeding the hook really hit a closed pipe");
  assert.equal(res.status, 0, "control: and the hook itself passed");
  assert.equal(gitPush.gateHookRefused(res), false, "an EPIPE on a passing hook is not a refusal");
  script(hook, "exit 3");
  assert.equal(gitPush.gateHookRefused(spawnSync(hook, [], { input: "x".repeat(512 * 1024), encoding: "utf8" })), true, "a failing hook still refuses");
  assert.equal(gitPush.gateHookRefused(spawnSync(join(root, "absent-hook"), [], { input: "x" })), true, "a hook that cannot start refuses");
});

test("a gate refusal with no stderr names the exit status, signal or spawn error, on both push paths", async () => {
  const refusedWith = (detail: string) => (e: unknown) =>
    e instanceof gitPush.PushFailedError && e.message.includes(`refused this push (${detail}); nothing was pushed`);
  script(join(harnessHooks, "pre-push"), "exit 7");
  const first = lane();
  assert.throws(() => withLiveWritesAllowed(() => gitPush.gitPushRunBranch(first.wt, { stdio: "ignore" })), refusedWith("exit 7"));
  await assert.rejects(withLiveWritesAllowed(() => gitPush.gitPushRunBranchAsync(first.wt, { stdio: "ignore" })), refusedWith("exit 7"));
  script(join(harnessHooks, "pre-push"), "kill -TERM $$");
  assert.throws(() => withLiveWritesAllowed(() => gitPush.gitPushRunBranch(lane().wt, { stdio: "ignore" })), refusedWith("signal SIGTERM"));
  rmSync(join(harnessHooks, "pre-push"));
  mkdirSync(join(harnessHooks, "pre-push")); // a directory where the hook belongs: no uid can execute it
  assert.throws(() => withLiveWritesAllowed(() => gitPush.gitPushRunBranch(lane().wt, { stdio: "ignore" })), refusedWith("spawn EACCES"));
  rmSync(join(harnessHooks, "pre-push"), { recursive: true });
});
