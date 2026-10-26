import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { commitWorkerEdits } from "#src/run-task.js";

const branch = "run-unfiled-tracked-ignore-fixture";
function fixture(t: test.TestContext) {
  const repo = gitRepo({ scope: t, branch, kind: "tracked-ignored-worker" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  mkdirSync(join(repo.dir, "coverage"));
  for (const name of ["kept.txt", "removed.txt", "outside.txt"]) {
    writeFileSync(join(repo.dir, "coverage", name), "before\n");
  }
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed tracked files before their directory is ignored");
  writeFileSync(join(repo.dir, ".gitignore"), "coverage/\n");
  repo.git("add", "--", ".gitignore");
  repo.git("commit", "-qm", "ignore future generated coverage files");
  const priorHeadSha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", priorHeadSha);
  writeFileSync(join(repo.dir, "coverage/kept.txt"), "fixed\n");
  rmSync(join(repo.dir, "coverage/removed.txt"));
  writeFileSync(join(repo.dir, "added.txt"), "new\n");
  writeFileSync(join(repo.dir, "coverage/outside.txt"), "unpublished outside edit\n");
  writeFileSync(join(repo.dir, "coverage/untracked.txt"), "ignored unpublished file\n");
  return { repo, priorHeadSha };
}

const declared = ["coverage/kept.txt", "coverage/removed.txt", "added.txt"];
function assertSaved(repo: ReturnType<typeof gitRepo>) {
  assert.equal(repo.git("show", "HEAD:coverage/kept.txt"), "fixed");
  const paths = repo.git("ls-tree", "-r", "--name-only", "HEAD").split("\n");
  assert.equal(paths.includes("coverage/removed.txt"), false);
  assert.equal(paths.includes("added.txt"), true);
  assert.equal(paths.includes("coverage/untracked.txt"), false);
  assert.equal(repo.git("show", "HEAD:coverage/outside.txt"), "before");
  assert.equal(readFileSync(join(repo.dir, "coverage/outside.txt"), "utf8"), "unpublished outside edit\n");
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
  assert.equal(repo.git("diff", "--name-only"), "coverage/outside.txt");
}

test("guarded worker commits retain tracked files under ignored directories", t => {
  const { repo, priorHeadSha } = fixture(t);
  const result = commitWorkerEdits(repo.dir, declared, "fix: save declared edits", {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, true);
  assert.deepEqual(result.undeclared, ["coverage/outside.txt"]);
  assertSaved(repo);
});

test("ordinary worker commits retain tracked files under ignored directories", t => {
  const { repo } = fixture(t);
  const result = commitWorkerEdits(repo.dir, declared, "fix: save declared edits");
  assert.equal(result.committed, true);
  assert.deepEqual(result.undeclared, ["coverage/outside.txt"]);
  assertSaved(repo);
});

test("ignored untracked files remain outside guarded worker commits", t => {
  const { repo, priorHeadSha } = fixture(t);
  const result = commitWorkerEdits(repo.dir, [...declared, "coverage/untracked.txt"], "fix: retain the ignore boundary", {}, [], { priorHeadSha, branch });
  assert.equal(result.committed, true);
  assertSaved(repo);
  assert.equal(readFileSync(join(repo.dir, "coverage/untracked.txt"), "utf8"), "ignored unpublished file\n");
  assert.equal(repo.git("show", "HEAD:.gitignore"), "coverage/");
});
