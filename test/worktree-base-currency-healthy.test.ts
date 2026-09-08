import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertWorktreeBaseCurrent, worktreeAdd } from "../src/lib/worker.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

// W1-T405 design note (iii): the base-currency check "must not fire on a healthy run" --
// this repo has earned that caution four times over (ci-gate's wait cap, a deploy ceiling
// burned by a dry run, a check-wait bound, the idle-gate ceiling). These tests exercise the
// REAL default `git ls-remote` (no injected fake at all) against a real, self-pointing
// local "origin" remote -- the exact ordinary path every one of `worktreeAdd`'s six
// existing call sites takes today -- and pin that it proceeds untouched.

function seedClone(): GitRepo {
  const repo = gitRepo({ kind: "rmd-wt-healthy" });
  writeFileSync(join(repo.dir, "seed.txt"), "x\n");
  repo.git("add", "-A");
  repo.git("commit", "--no-verify", "--quiet", "-m", "chore: seed");
  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin", "--quiet");
  return repo;
}

test("worktreeAdd proceeds untouched on a genuinely current base -- the REAL ls-remote, nothing injected", () => {
  const repo = seedClone();
  const wt = `${repo.dir}-wt`;
  // No `deps` argument at all: exercises the real default `git ls-remote` against the
  // real local "origin" remote.
  assert.doesNotThrow(() => worktreeAdd(repo.dir, wt, "run-healthy-probe", "origin/main"));
  // "Proceeds untouched" means the rest of worktreeAdd's own work still ran too -- the
  // check did not silently short-circuit worktree setup.
  const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.match(head, /^[0-9a-f]{40}$/);
});

test("a second worktreeAdd off the same, unchanged remote also proceeds untouched -- repeated healthy dispatch never fires the check", () => {
  const repo = seedClone();
  const wt1 = `${repo.dir}-wt1`;
  const wt2 = `${repo.dir}-wt2`;
  assert.doesNotThrow(() => worktreeAdd(repo.dir, wt1, "run-healthy-probe-a", "origin/main"));
  assert.doesNotThrow(() => worktreeAdd(repo.dir, wt2, "run-healthy-probe-b", "origin/main"));
});

test("assertWorktreeBaseCurrent-level: identical base and remote head never throws", () => {
  assert.doesNotThrow(() =>
    assertWorktreeBaseCurrent("deadbeef", "main", { readRemoteHead: () => "deadbeef" }),
  );
});
