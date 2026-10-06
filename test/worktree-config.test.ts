import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ensureWorktreeConfigEnabledAsync, type WorktreeConfigGit } from "../src/lib/worktree-config.js";
import { gitRepo } from "./helpers/git-repo.js";

const exec = promisify(execFile);
const missing = Object.assign(new Error("no matching key"), { code: 1 });
const locked = Object.assign(new Error("git config refused"), {
  code: 255, stderr: "error: could not lock config file .git/config: File exists\n",
});

test("worktree config already enabled needs no shared write", async () => {
  const calls: string[][] = [];
  await ensureWorktreeConfigEnabledAsync(async (args) => { calls.push(args); return "true\n"; });
  assert.deepEqual(calls, [["config", "--local", "--get", "extensions.worktreeConfig"]]);
});

test("worktree config absent or false enables the exact shared extension", async () => {
  for (const absent of [true, false]) {
    const calls: string[][] = [];
    await ensureWorktreeConfigEnabledAsync(async (args) => {
      calls.push(args);
      if (args.includes("--get")) { if (absent) throw missing; return "false\n"; }
      return "";
    });
    assert.deepEqual(calls.at(-1), ["config", "--local", "extensions.worktreeConfig", "true"]);
    assert.equal(calls.length, 2);
  }
});

test("worktree config unreadable is not an absent key or a successful migration", async () => {
  const malformed = Object.assign(new Error("bad config line"), { code: 128 });
  let calls = 0;
  await assert.rejects(ensureWorktreeConfigEnabledAsync(async () => { calls++; throw malformed; }),
    (error) => error === malformed);
  assert.equal(calls, 1, "a failed read must not start a write");
});

test("worktree config lock retry rereads a peer migration instead of rewriting it", async () => {
  let reads = 0;
  let writes = 0;
  const waits: number[] = [];
  await ensureWorktreeConfigEnabledAsync(async (args) => {
    if (args.includes("--get")) { if (++reads === 1) throw missing; return "true\n"; }
    writes++; throw locked;
  }, async (ms) => { waits.push(ms); });
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  assert.deepEqual(waits, [100]);
});

test("worktree config retries only transient config locks and preserves other write failures", async () => {
  for (const error of [new Error("cannot lock ref refs/remotes/origin/main"),
    new Error("could not lock config file .git/config: Permission denied"), new Error("read-only filesystem")]) {
    let writes = 0;
    let waits = 0;
    await assert.rejects(ensureWorktreeConfigEnabledAsync(async (args) => {
      if (args.includes("--get")) throw missing;
      writes++; throw error;
    }, async () => { waits++; }), (caught) => caught === error);
    assert.equal(writes, 1);
    assert.equal(waits, 0);
  }
});

test("worktree config a persistent lock is refused after three native attempts", async () => {
  let writes = 0;
  const waits: number[] = [];
  await assert.rejects(ensureWorktreeConfigEnabledAsync(async (args) => {
    if (args.includes("--get")) throw missing;
    writes++; throw locked;
  }, async (ms) => { waits.push(ms); }), (caught) => caught === locked);
  assert.equal(writes, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("worktree config real Git recovers a released lock without deleting an owner's lock", async (t) => {
  const repo = gitRepo({ kind: "worktree-config-retry" });
  t.after(() => repo.cleanup());
  const lock = join(repo.dir, ".git", "config.lock");
  writeFileSync(lock, "owned by the other writer\n", { flag: "wx" });
  let failures = 0;
  let loopTurns = 0;
  const timer = setInterval(() => { loopTurns++; }, 1);
  t.after(() => clearInterval(timer));
  const git: WorktreeConfigGit = async (args) => {
    try {
      return (await exec("git", ["-c", "core.configLockTimeout=0", "-C", repo.dir, ...args], {
        encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
      })).stdout;
    } catch (error) {
      if (!args.includes("--get")) {
        assert.match(String((error as { stderr?: string }).stderr), /could not lock config file.*File exists/);
        assert.equal(readFileSync(lock, "utf8"), "owned by the other writer\n");
        failures++;
        unlinkSync(lock); // The fixture OWNER releases it after the observed real refusal.
      }
      throw error;
    }
  };
  await ensureWorktreeConfigEnabledAsync(git);
  assert.equal(failures, 1, "a native config-lock refusal was actually observed");
  assert.ok(loopTurns > 0, "the real timer backoff leaves the event loop available");
  assert.equal(repo.git("config", "--local", "--get", "extensions.worktreeConfig"), "true");
});

test("worktree config persistent real Git lock remains intact on refusal", async (t) => {
  const repo = gitRepo({ kind: "worktree-config-owned-lock" });
  t.after(() => repo.cleanup());
  const lock = join(repo.dir, ".git", "config.lock");
  writeFileSync(lock, "keep this live lock\n", { flag: "wx" });
  let writes = 0;
  await assert.rejects(ensureWorktreeConfigEnabledAsync(async (args) => {
    if (!args.includes("--get")) writes++;
    return (await exec("git", ["-c", "core.configLockTimeout=0", "-C", repo.dir, ...args], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    })).stdout;
  }), /could not lock config file/);
  assert.equal(writes, 3);
  assert.ok(existsSync(lock));
  assert.equal(readFileSync(lock, "utf8"), "keep this live lock\n");
});
