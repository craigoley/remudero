import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorktreeBase, recordWorktreeBase, worktreeAdd, worktreeBasePath } from "../src/lib/worker.js";

// W1-T405 acceptance (4): the base commit is recorded when the worktree is created, so a
// later refusal can be attributed without re-deriving it. `worktreeAdd` never asserted or
// recorded a base before this task -- these tests pin the sibling-file record (same
// convention as run.lock's liveness token, {@link worktreeBasePath}) both in isolation and
// as a real side effect of `worktreeAdd`, on both the healthy and the refused paths.

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

test("recordWorktreeBase / readWorktreeBase round-trip via a SIBLING file, never inside the working tree", () => {
  const root = tmp("rmd-wt-record-");
  try {
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    recordWorktreeBase(wt, "deadbeef");
    assert.equal(readWorktreeBase(wt), "deadbeef");
    assert.equal(worktreeBasePath(wt), `${wt}.base`, "outside the working tree, same convention as run.lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorktreeBase returns null, never throws, when nothing was recorded", () => {
  assert.equal(readWorktreeBase(join(tmp("rmd-wt-record-absent-"), "no-such-worktree")), null);
});

test("worktreeAdd records the base it actually created, on the healthy path", () => {
  const root = tmp("rmd-wt-record-healthy-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    worktreeAdd(clone, wt, "run-record-probe", "origin/main");
    const actualHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(readWorktreeBase(wt), actualHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the base is recorded BEFORE a stale-base refusal, so the refusal can be attributed without re-deriving it", () => {
  const root = tmp("rmd-wt-record-stale-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    seedClone(clone);
    assert.throws(() =>
      worktreeAdd(clone, wt, "run-record-stale-probe", "origin/main", {
        readRemoteHead: () => "3333333333333333333333333333333333333333",
      }),
    );
    // worktreeAdd got far enough to create the worktree before refusing -- its sibling
    // .base file must already name the commit it was actually cut from, so an operator (or
    // a later dispatch) can attribute the refusal without shelling `git merge-base` again.
    const actualHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(readWorktreeBase(wt), actualHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
