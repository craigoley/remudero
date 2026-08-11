import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorktreeBaseStaleError, worktreeAdd } from "../src/lib/worker.js";

// W1-T405: a run-task dispatch on a stale worktree base used to be detected only AFTER
// recon, implement, and commit had all run, by the out-of-scope scope guard -- which then
// named the RAREST of several causes that produce the identical diff shape ("a forged
// merge-base") rather than the actual, far more likely one (the base was simply behind).
// `worktreeAdd` (lib/worker.ts) is the single function every run-task dispatch path calls
// BEFORE any worker (recon/implement/commit) ever spawns, so asserting base currency there
// makes "refuses before any worker runs" true structurally, for free.
//
// The mechanism that lets a base go stale despite `worktreeAdd`'s own fail-closed `git
// fetch` is, per the task's own rationale, UNMEASURED -- so these tests simulate it the
// only honest way available: injecting the independent remote-head read, never faking the
// fetch/worktree-add themselves, which run for real against a real local git repo.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedClone(clone: string): void {
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["-C", clone, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "probe"]);
  writeFileSync(join(clone, "seed.txt"), "x\n");
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  // `worktreeAdd` fetches origin; point it at itself so that fetch (and the default
  // ls-remote) are both local no-ops, same convention as worktree-node-modules.test.ts.
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
}

test("worktreeAdd REFUSES (throws WorktreeBaseStaleError) when the base it just created is behind an independently-read remote head", () => {
  const root = tmp("rmd-wt-stale-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    assert.throws(
      () =>
        worktreeAdd(clone, wt, "run-stale-probe", "origin/main", {
          // Simulates the unmeasured failure mode the task's rationale describes: the
          // fetch exits zero, but an independent read of the remote disagrees with the
          // base the worktree was actually cut from.
          readRemoteHead: () => "0000000000000000000000000000000000000000",
        }),
      (e: unknown) => e instanceof WorktreeBaseStaleError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refusal names being BEHIND -- never the scope guard's rarer 'forged merge-base' cause", () => {
  const root = tmp("rmd-wt-stale-msg-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    try {
      worktreeAdd(clone, wt, "run-stale-probe-2", "origin/main", {
        readRemoteHead: () => "1111111111111111111111111111111111111111",
      });
      assert.fail("expected worktreeAdd to throw");
    } catch (e) {
      assert.ok(e instanceof WorktreeBaseStaleError);
      const message = (e as Error).message;
      assert.match(message, /behind/i, "must name the observed condition: behind");
      assert.doesNotMatch(message, /forged/i, "must never assert the rarer forged-merge-base cause");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale base is caught BEFORE worktreeAdd returns -- there is no return value a caller could ignore and spawn a worker anyway", () => {
  const root = tmp("rmd-wt-stale-order-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    let reachedCaller = false;
    try {
      worktreeAdd(clone, wt, "run-stale-probe-3", "origin/main", {
        readRemoteHead: () => "2222222222222222222222222222222222222222",
      });
      reachedCaller = true; // would mean the caller could now proceed to spawn a worker
    } catch {
      // expected: WorktreeBaseStaleError
    }
    assert.equal(reachedCaller, false, "a worker must never be reachable once the base is stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
