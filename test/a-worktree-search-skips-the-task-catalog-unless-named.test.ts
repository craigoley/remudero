import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14645 — a recursive rg from the root skips plan/tasks.d; naming it (or a shard) still reads it.
const RGIGNORE = join(REPO_ROOT, ".rgignore");
const NEEDLE = "needle-w1-t14645";
const hasRg = spawnSync("rg", ["--version"]).status === 0;
// No user ripgrep config may add or drop flags under the test.
const RG_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

function rg(cwd: string, ...args: string[]): string {
  const r = spawnSync("rg", ["--no-config", "--no-messages", "--no-ignore-vcs", "-l", NEEDLE, ...args],
    { cwd, encoding: "utf8", env: RG_ENV, stdio: ["ignore", "pipe", "pipe"] });
  return r.stdout;
}

/** A worktree-shaped fixture on the shared git helper: one hit in src, one in a catalog shard;
 *  the real `.rgignore` copied in only on request. */
function fixture(withRgignore: boolean): GitRepo {
  const repo = gitRepo({ seedCommit: false, kind: "rgignore" });
  const root = repo.dir;
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  if (withRgignore) copyFileSync(RGIGNORE, join(root, ".rgignore"));
  writeFileSync(join(root, "plan", "tasks.d", "shard.yaml"), `${NEEDLE}\n`);
  writeFileSync(join(root, "plan", "tasks.d", "other.yaml"), "nothing here\n");
  writeFileSync(join(root, "src", "code.ts"), `${NEEDLE}\n`);
  repo.git("add", "-A");
  return repo;
}

test("W1-T14645 criterion 1: rg from the root prints the src hit and no plan/tasks.d path", { skip: !hasRg }, () => {
  const repo = fixture(true);
  try {
    for (const recursive of [rg(repo.dir, "."), rg(repo.dir, repo.dir), rg(repo.dir)]) {
      assert.match(recursive, /src[\\/]code\.ts/);
      assert.doesNotMatch(recursive, /tasks\.d/);
    }
  } finally {
    repo.cleanup();
  }
});

test("W1-T14645 criterion 1: without .rgignore (origin/main) the same rg prints the plan hit", { skip: !hasRg }, () => {
  const repo = fixture(false);
  try {
    const recursive = rg(repo.dir, ".");
    assert.match(recursive, /src[\\/]code\.ts/);
    assert.match(recursive, /plan[\\/]tasks\.d[\\/]shard\.yaml/);
  } finally {
    repo.cleanup();
  }
});

test("W1-T14645 criterion 2: rg naming plan/tasks.d or a shard path still prints its matches", { skip: !hasRg }, () => {
  const repo = fixture(true);
  try {
    for (const named of ["plan/tasks.d", "plan/tasks.d/", "./plan/tasks.d", "plan/tasks.d/shard.yaml"]) {
      const out = rg(repo.dir, named);
      assert.match(out, /shard\.yaml/, `rg ${named} must search the named path`);
      assert.doesNotMatch(out, /other\.yaml/);
    }
    // Naming the shard's parent from inside plan/ also reaches it.
    assert.match(rg(join(repo.dir, "plan"), "tasks.d"), /shard\.yaml/);
  } finally {
    repo.cleanup();
  }
});

test("W1-T14645 criterion 2: git grep is unaffected by .rgignore and still prints the plan hit", () => {
  const repo = fixture(true);
  try {
    const hits = repo.git("grep", "-l", NEEDLE).split("\n").filter(Boolean).sort();
    assert.deepEqual(hits, ["plan/tasks.d/shard.yaml", "src/code.ts"]);
  } finally {
    repo.cleanup();
  }
});
