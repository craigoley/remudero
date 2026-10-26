import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { preserveTrackedDirtyFixOwner } from "#src/run-task.js";
import { makeTempDir } from "#src/lib/tmp.js";

const tmp = () => makeTempDir("fix-owner-ignored-index");
const sha = (root: string, ref: string) => execFileSync("git", ["-C", root, "rev-parse", ref], { encoding: "utf8" }).trim();
function cloneOf(upstream: string, path: string) {
  execFileSync("git", ["clone", "--quiet", upstream, path]);
  execFileSync("git", ["-C", path, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", path, "config", "user.name", "probe"]);
}
function seedUpstream(root: string) {
  const upstream = join(root, "upstream.git"), seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", upstream]);
  cloneOf(upstream, seed);
  writeFileSync(join(seed, "seed.txt"), "base\n");
  execFileSync("git", ["-C", seed, "add", "seed.txt"]);
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);
  return upstream;
}

for (const merging of [false, true]) {
  test(`dirty fix-owner preservation retains staged additions under ignored paths${merging ? " during an interrupted merge" : ""}`, () => {
    const root = tmp();
    try {
      const upstream = seedUpstream(root);
      const repoDir = join(root, "repo");
      cloneOf(upstream, repoDir);
      const git = (path: string, args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" });
      git(repoDir, ["config", "user.email", "probe@example.invalid"]);
      git(repoDir, ["config", "user.name", "probe"]);
      writeFileSync(join(repoDir, ".gitignore"), "coverage/\n");
      git(repoDir, ["add", ".gitignore"]);
      git(repoDir, ["commit", "--quiet", "-m", "chore: fixture ignore policy"]);
      const branch = "run-W1-T3822-1789876999000";
      git(repoDir, ["branch", branch]);
      const ownerPath = join(root, "owner");
      git(repoDir, ["worktree", "add", "--quiet", ownerPath, branch]);
      const ignored = "coverage/staged.txt";
      const ignoredBytes = "a tracked addition remains recoverable under an ignore rule\n";
      if (merging) {
        git(repoDir, ["checkout", "--quiet", "-b", "incoming"]);
        mkdirSync(join(repoDir, "coverage"));
        writeFileSync(join(repoDir, ignored), ignoredBytes);
        writeFileSync(join(repoDir, "seed.txt"), "incoming\n");
        git(repoDir, ["add", "-f", ignored]);
        git(repoDir, ["add", "seed.txt"]);
        git(repoDir, ["commit", "--quiet", "-m", "chore: incoming fixture"]);
        writeFileSync(join(ownerPath, "seed.txt"), "owner\n");
        git(ownerPath, ["add", "seed.txt"]);
        git(ownerPath, ["commit", "--quiet", "-m", "chore: owner fixture"]);
        assert.throws(() => git(ownerPath, ["merge", "incoming"]));
        assert.ok(git(ownerPath, ["ls-files", "--unmerged"]).includes("seed.txt"));
      } else {
        mkdirSync(join(ownerPath, "coverage"));
        writeFileSync(join(ownerPath, ignored), ignoredBytes);
        git(ownerPath, ["add", "-f", ignored]);
        writeFileSync(join(ownerPath, "seed.txt"), "unstaged owner work\n");
      }
      assert.match(git(ownerPath, ["check-ignore", "--no-index", "-v", ignored]), /coverage\//);
      const localSha = sha(ownerPath, "HEAD");
      const indexPath = git(ownerPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
      const status = git(ownerPath, ["status", "--porcelain=v1"]);
      const index = readFileSync(indexPath);
      const working = readFileSync(join(ownerPath, "seed.txt"), "utf8");
      const recovery = preserveTrackedDirtyFixOwner(repoDir, ownerPath, branch, localSha);
      assert.equal(git(repoDir, ["show", `${recovery}:${ignored}`]), ignoredBytes);
      assert.equal(git(repoDir, ["show", `${recovery}:seed.txt`]), working);
      assert.equal(sha(repoDir, `${recovery}^1`), localSha);
      assert.equal(sha(ownerPath, "HEAD"), localSha);
      assert.equal(git(ownerPath, ["status", "--porcelain=v1"]), status);
      assert.deepEqual(readFileSync(indexPath), index, "preservation never edits the live index");
      assert.equal(preserveTrackedDirtyFixOwner(repoDir, ownerPath, branch, localSha), recovery);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("dirty fix-owner preservation still refuses an ignored working copy hidden by a staged deletion", () => {
  const root = tmp();
  try {
    const upstream = seedUpstream(root), repoDir = join(root, "repo"), ownerPath = join(root, "owner");
    cloneOf(upstream, repoDir);
    const git = (path: string, args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
    writeFileSync(join(repoDir, ".gitignore"), "coverage/\n");
    mkdirSync(join(repoDir, "coverage"));
    const path = "coverage/staged.txt";
    writeFileSync(join(repoDir, path), "recorded\n");
    git(repoDir, ["add", ".gitignore"]);
    git(repoDir, ["add", "--force", path]);
    git(repoDir, ["commit", "--quiet", "-m", "chore: tracked ignored fixture"]);
    const branch = "run-W1-T3822-1789876999001";
    git(repoDir, ["branch", branch]);
    git(repoDir, ["worktree", "add", "--quiet", ownerPath, branch]);
    git(ownerPath, ["rm", "--cached", path]);
    writeFileSync(join(ownerPath, path), "unpublished working bytes\n");
    const localSha = sha(ownerPath, "HEAD");
    const indexPath = git(ownerPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
    const status = git(ownerPath, ["status", "--porcelain=v1"]), index = readFileSync(indexPath);
    assert.throws(() => preserveTrackedDirtyFixOwner(repoDir, ownerPath, branch, localSha), /dirty recovery patch tree .* does not match owner tree/);
    assert.equal(readFileSync(join(ownerPath, path), "utf8"), "unpublished working bytes\n");
    assert.equal(git(ownerPath, ["status", "--porcelain=v1"]), status);
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/rmd-recovery/fix-dirty"]), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an empty owner index cannot turn preservation into staging ignored untracked work", () => {
  const root = tmp();
  try {
    const upstream = seedUpstream(root), repoDir = join(root, "repo"), ownerPath = join(root, "owner");
    cloneOf(upstream, repoDir);
    const git = (path: string, args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
    const branch = "run-W1-T3822-1789876999002";
    git(repoDir, ["branch", branch]);
    git(repoDir, ["worktree", "add", "--quiet", ownerPath, branch]);
    const exclude = join(root, "exclude");
    writeFileSync(exclude, "*\n");
    git(ownerPath, ["config", "core.excludesFile", exclude]);
    git(ownerPath, ["rm", "--cached", "--", "seed.txt"]);
    writeFileSync(join(ownerPath, "untracked.txt"), "unpublished ignored bytes\n");
    assert.equal(git(ownerPath, ["ls-files", "--cached", "-z"]), "");
    const localSha = sha(ownerPath, "HEAD");
    const indexPath = git(ownerPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
    const index = readFileSync(indexPath);
    assert.throws(() => preserveTrackedDirtyFixOwner(repoDir, ownerPath, branch, localSha), /dirty recovery patch tree .* does not match owner tree/);
    assert.equal(readFileSync(join(ownerPath, "untracked.txt"), "utf8"), "unpublished ignored bytes\n");
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/rmd-recovery/fix-dirty"]), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
