import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWorktreeBaseCurrent, worktreeAdd } from "../src/lib/worker.js";

// W1-T405 design note (iii): the base-currency check "must not fire on a healthy run" --
// this repo has earned that caution four times over (ci-gate's wait cap, a deploy ceiling
// burned by a dry run, a check-wait bound, the idle-gate ceiling). These tests exercise the
// REAL default `git ls-remote` (no injected fake at all) against a real, self-pointing
// local "origin" remote -- the exact ordinary path every one of `worktreeAdd`'s six
// existing call sites takes today -- and pin that it proceeds untouched.

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
  execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
  execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);
}

test("worktreeAdd proceeds untouched on a genuinely current base -- the REAL ls-remote, nothing injected", () => {
  const root = tmp("rmd-wt-healthy-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    // No `deps` argument at all: exercises the real default `git ls-remote` against the
    // real local "origin" remote.
    assert.doesNotThrow(() => worktreeAdd(clone, wt, "run-healthy-probe", "origin/main"));
    // "Proceeds untouched" means the rest of worktreeAdd's own work still ran too -- the
    // check did not silently short-circuit worktree setup.
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.match(head, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second worktreeAdd off the same, unchanged remote also proceeds untouched -- repeated healthy dispatch never fires the check", () => {
  const root = tmp("rmd-wt-healthy-repeat-");
  const clone = join(root, "clone");
  const wt1 = join(root, "wt1");
  const wt2 = join(root, "wt2");
  try {
    seedClone(clone);
    assert.doesNotThrow(() => worktreeAdd(clone, wt1, "run-healthy-probe-a", "origin/main"));
    assert.doesNotThrow(() => worktreeAdd(clone, wt2, "run-healthy-probe-b", "origin/main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertWorktreeBaseCurrent-level: identical base and remote head never throws", () => {
  assert.doesNotThrow(() =>
    assertWorktreeBaseCurrent("deadbeef", "main", { readRemoteHead: () => "deadbeef" }),
  );
});
