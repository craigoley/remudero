import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitWorkerEdits } from "../src/run-task.js";

// W1-T3849. `git status --porcelain -z` with git's DEFAULT untracked mode collapses a
// wholly-new directory into ONE entry -- the directory path itself, never the files inside it.
// `commitWorkerEdits` classifies raw porcelain paths against the task's declared surface, so a
// declared nested new file such as `a/one.ts` never appeared in that list; only `a/` did, and
// `pathIsUnderDeclaredSurface("a/", ["a/one.ts"])` is false -- the directory neither equals nor
// starts with the declared FILE path plus `/`. The fix reads status with `--untracked-files=all`
// so newly-created directories are always expanded into their individual untracked file paths
// BEFORE classification runs. This drives the REAL git binary against a throwaway repo -- a fake
// `runGit` stub can't reproduce the collapsing behaviour the bug depends on, since the caller
// would have to fabricate the very porcelain shape under test.

function initRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "rmd-harness-commit-new-dir-"));
  execFileSync("git", ["-C", repoDir, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "probe"]);
  writeFileSync(join(repoDir, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", repoDir, "add", "-A"]);
  execFileSync("git", ["-C", repoDir, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  return repoDir;
}

test("W1-T3849: a declared new file inside a brand-new directory is committed", () => {
  const repoDir = initRepo();
  try {
    mkdirSync(join(repoDir, "a"));
    writeFileSync(join(repoDir, "a", "one.ts"), "export const one = 1;\n");

    const result = commitWorkerEdits(repoDir, ["a/one.ts", "a/two.ts"], "feat: add a/one.ts");

    assert.equal(result.committed, true, "the declared nested new file must be committed, not stranded");
    assert.deepEqual(result.undeclared, []);
    const files = execFileSync(
      "git",
      ["-C", repoDir, "show", "--pretty=", "--name-only", "HEAD"],
      { encoding: "utf8" },
    ).trim().split("\n");
    assert.deepEqual(files, ["a/one.ts"]);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("W1-T3849: an unrelated new file in the SAME new directory stays uncommitted and reported", () => {
  const repoDir = initRepo();
  try {
    mkdirSync(join(repoDir, "a"));
    writeFileSync(join(repoDir, "a", "one.ts"), "export const one = 1;\n");
    writeFileSync(join(repoDir, "a", "three.ts"), "export const three = 1;\n");

    const result = commitWorkerEdits(repoDir, ["a/one.ts"], "feat: add a/one.ts");

    assert.equal(result.committed, true);
    assert.deepEqual(result.undeclared, ["a/three.ts"], "undeclared sibling in the same new dir must be reported");
    const files = execFileSync(
      "git",
      ["-C", repoDir, "show", "--pretty=", "--name-only", "HEAD"],
      { encoding: "utf8" },
    ).trim().split("\n");
    assert.deepEqual(files, ["a/one.ts"], "the undeclared sibling must never be staged");

    const status = execFileSync(
      "git",
      ["-C", repoDir, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8" },
    );
    assert.match(status, /a\/three\.ts/, "it remains on disk, untracked");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("W1-T3849: status enumerates all untracked files individually before classification", () => {
  const calls: string[][] = [];
  const runGit = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "status") return "?? a/one.ts\0";
    if (args[0] === "rev-parse") return "abc123\n";
    return "";
  };

  const result = commitWorkerEdits("/unused", ["a/one.ts"], "feat: add a/one.ts", { runGit });

  assert.equal(result.committed, true);
  assert.deepEqual(calls[0], ["status", "--porcelain", "-z", "--untracked-files=all"]);
});
