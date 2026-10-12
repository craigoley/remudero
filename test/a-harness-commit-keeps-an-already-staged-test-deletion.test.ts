/**
 * W1-T6639: a harness commit must not hand `git add` a path whose deletion is ALREADY staged.
 *
 * `commitWorkerEdits` admits every changed test/ path (admitTests) into `git add -A -- <paths>`.
 * A deletion a merge already staged (`D `) exists in neither the index nor the worktree, so git
 * refuses the whole pathspec ("did not match any files") and the fix round throws instead of
 * committing the resolved merge. The fixtures here are real git repositories, never a stubbed git.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { commitWorkerEdits } from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

function configure(repo: GitRepo): void {
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.git("config", "commit.gpgsign", "false");
  repo.git("config", "core.hooksPath", "/dev/null");
}

function seed(repo: GitRepo): void {
  repo.git("add", "-A");
  repo.git("commit", "-m", "seed");
}

test("W1-T6639: an already-staged test deletion is committed, not passed to git add", () => {
  const repo = gitRepo({ kind: "w1t6639-plain", seedCommit: true, branch: "main" });
  try {
    configure(repo);
    writeFiles(repo, ["src.txt", "test/staged-gone.test.ts", "test/worktree-gone.test.ts"]);
    seed(repo);

    repo.git("rm", "-q", "test/staged-gone.test.ts"); // `D ` — already staged, absent on disk
    rmSync(join(repo.dir, "test", "worktree-gone.test.ts")); // ` D` — worktree only
    writeFileSync(join(repo.dir, "src.txt"), "edited\n");
    assert.match(repo.git("status", "--porcelain"), /^D {2}test\/staged-gone\.test\.ts$/m);

    const landed = commitWorkerEdits(repo.dir, ["src.txt"], "fix(x): land the deletion", {}, [], { admitTests: true });
    assert.equal(landed.committed, true, landed.reason);
    const names = repo.git("show", "--name-status", "--format=", "HEAD").split("\n").sort();
    assert.deepEqual(names, ["D\ttest/staged-gone.test.ts", "D\ttest/worktree-gone.test.ts", "M\tsrc.txt"]);
    assert.equal(repo.git("status", "--porcelain"), "");
  } finally {
    repo.cleanup();
  }
});

test("W1-T6639: a staged deletion alone commits without an empty-pathspec add -A", () => {
  const repo = gitRepo({ kind: "w1t6639-only", seedCommit: true, branch: "main" });
  try {
    configure(repo);
    writeFiles(repo, ["src.txt", "test/staged-gone.test.ts"]);
    seed(repo);
    repo.git("rm", "-q", "test/staged-gone.test.ts");
    writeFileSync(join(repo.dir, "unrelated.txt"), "not declared\n");

    const landed = commitWorkerEdits(repo.dir, ["src.txt"], "fix(x): land the deletion", {}, [], { admitTests: true });
    assert.equal(landed.committed, true, landed.reason);
    assert.equal(repo.git("show", "--name-status", "--format=", "HEAD"), "D\ttest/staged-gone.test.ts");
    assert.deepEqual(landed.undeclared, ["unrelated.txt"]);
    assert.equal(repo.git("status", "--porcelain"), "?? unrelated.txt", "the undeclared file was never swept in");
  } finally {
    repo.cleanup();
  }
});

test("W1-T6639: the guarded fix-round commit keeps a deletion the merge already staged", () => {
  const repo = gitRepo({ kind: "w1t6639-merge", seedCommit: true, branch: "main" });
  try {
    configure(repo);
    writeFiles(repo, ["src.txt", "test/staged-gone.test.ts"]);
    seed(repo);
    repo.git("checkout", "-q", "-b", "pr");
    writeFileSync(join(repo.dir, "src.txt"), "pr side\n");
    repo.git("commit", "-qam", "pr change");
    repo.git("checkout", "-q", "main");
    repo.git("rm", "-q", "test/staged-gone.test.ts");
    repo.git("commit", "-qm", "main deletes the test");
    repo.git("checkout", "-q", "pr");
    const prior = repo.git("rev-parse", "HEAD");
    repo.git("merge", "--no-commit", "--no-ff", "main");
    assert.match(repo.git("status", "--porcelain"), /^D {2}test\/staged-gone\.test\.ts$/m);
    writeFileSync(join(repo.dir, "src.txt"), "resolved\n");

    const landed = commitWorkerEdits(repo.dir, ["src.txt"], "fix(x): resolve the merge", {}, [], {
      admitTests: true,
      priorHeadSha: prior,
      branch: "pr",
    });
    assert.equal(landed.committed, true, landed.reason);
    assert.equal(repo.git("rev-parse", "pr"), landed.sha);
    assert.equal(repo.git("log", "-1", "--format=%P", "pr").split(/\s+/).length, 2, "a two-parent merge commit");
    assert.equal(repo.git("ls-tree", "--name-only", "pr", "--", "test/staged-gone.test.ts"), "");
    assert.equal(repo.git("show", "pr:src.txt"), "resolved");
  } finally {
    repo.cleanup();
  }
});

function writeFiles(repo: GitRepo, names: string[]): void {
  for (const name of names) {
    const parts = name.split("/");
    mkdirParent(join(repo.dir, ...parts));
    writeFileSync(join(repo.dir, ...parts), `${name}\n`);
  }
}

function mkdirParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
