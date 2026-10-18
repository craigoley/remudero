import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { commitWorkerEdits } from "#test/helpers/run-task-test.js";

const branch = "run-W1-T10068-1";
function fixture(t: test.TestContext) {
  const repo = gitRepo({ scope: t, branch, kind: "fix-index" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  writeFileSync(join(repo.dir, "declared.txt"), "before\n");
  writeFileSync(join(repo.dir, "outside.txt"), "outside before\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed declared paths");
  const priorHeadSha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", priorHeadSha);
  writeFileSync(join(repo.dir, "declared.txt"), "fixed\n");
  writeFileSync(join(repo.dir, "added.txt"), "new\n");
  return { repo, priorHeadSha };
}

test("W1-T10068: a fix commit leaves its worktree index at the commit", t => {
  const { repo, priorHeadSha } = fixture(t);
  const result = commitWorkerEdits(repo.dir, ["declared.txt", "added.txt"], "fix: save the round", {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, true);
  assert.equal(repo.git("status", "--porcelain"), "");
  assert.equal(repo.git("write-tree"), repo.git("rev-parse", "HEAD^{tree}"));
  assert.equal(readFileSync(join(repo.dir, "declared.txt"), "utf8"), "fixed\n");
  assert.equal(readFileSync(join(repo.dir, "added.txt"), "utf8"), "new\n");
});

test("W1-T10068: an undeclared edit stays unstaged after the commit", t => {
  const { repo, priorHeadSha } = fixture(t);
  writeFileSync(join(repo.dir, "outside.txt"), "unpublished outside edit\n");
  writeFileSync(join(repo.dir, "untracked.txt"), "unpublished new file\n");
  const result = commitWorkerEdits(repo.dir, ["declared.txt", "added.txt"], "fix: save only the round", {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, true);
  assert.equal(readFileSync(join(repo.dir, "outside.txt"), "utf8"), "unpublished outside edit\n");
  assert.equal(readFileSync(join(repo.dir, "untracked.txt"), "utf8"), "unpublished new file\n");
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
  assert.equal(repo.git("diff", "--name-only"), "outside.txt");
  assert.equal(repo.git("ls-files", "--others", "--exclude-standard"), "untracked.txt");
  assert.equal(repo.git("show", "HEAD:outside.txt"), "outside before");
});

test("W1-T10068: a refused compare-and-swap leaves the worktree index unchanged", t => {
  const { repo, priorHeadSha } = fixture(t);
  const movedSha = repo.git("commit-tree", repo.git("rev-parse", "HEAD^{tree}"), "-p", priorHeadSha, "-m", "concurrent writer");
  const indexPath = repo.git("rev-parse", "--path-format=absolute", "--git-path", "index");
  const before = readFileSync(indexPath);
  const result = commitWorkerEdits(repo.dir, ["declared.txt", "added.txt"], "fix: refuse the race", {
    runGit: args => {
      if (args[0] === "update-ref") repo.git("update-ref", `refs/heads/${branch}`, movedSha, priorHeadSha);
      return execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" });
    },
  }, [], { priorHeadSha, branch });
  assert.equal(result.committed, false);
  assert.equal(result.headMoved?.observed_head_sha, movedSha);
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(readFileSync(join(repo.dir, "declared.txt"), "utf8"), "fixed\n");
});

test("an index lock surfaces the real refresh failure without rewinding the committed branch", t => {
  const { repo, priorHeadSha } = fixture(t);
  const indexPath = repo.git("rev-parse", "--path-format=absolute", "--git-path", "index");
  const before = readFileSync(indexPath);
  writeFileSync(indexPath + ".lock", "fixture-owned index lock\n");
  writeFileSync(join(repo.dir, "outside.txt"), "keep unpublished work\n");
  assert.throws(() => commitWorkerEdits(repo.dir, ["declared.txt", "added.txt"], "fix: surface index lock", {}, [], { priorHeadSha, branch }), /index\.lock/);
  assert.notEqual(repo.git("rev-parse", "HEAD"), priorHeadSha, "the failure must be after the successful CAS");
  assert.equal(repo.git("show", "HEAD:added.txt"), "new");
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(readFileSync(join(repo.dir, "outside.txt"), "utf8"), "keep unpublished work\n");
});
