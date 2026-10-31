import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { commitWorkerEdits } from "#test/helpers/run-task-commit-seam.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

function fixture(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "empty-fix-surface" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, "README.md"), "before\n");
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), "{}\n");
  repo.git("add", "--", "README.md", "scripts/source-size-baseline.json");
  repo.git("commit", "-qm", "seed generated baseline");
  writeFileSync(join(repo.dir, "README.md"), "unrelated unpublished edit\n");
  return repo;
}

test("W1-T10722: fix-lane-commit-refused-the-task-declares-no-files-so-there-is-no-surface-to-stage clears without a person", t => {
  const repo = fixture(t);
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, "test/repair.test.ts"), "export {};\n");
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), '{"repaired": true}\n');
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): repair admitted surfaces", {}, [], {
    admitTests: true, priorHeadSha: repo.git("rev-parse", "HEAD"), branch: "main",
  });
  assert.equal(result.committed, true);
  assert.deepEqual(result.admittedTests, ["test/repair.test.ts"]);
  assert.deepEqual(result.regenerable, ["scripts/source-size-baseline.json"]);
  assert.deepEqual(result.undeclared, ["README.md"]);
  assert.equal(repo.git("show", "HEAD:test/repair.test.ts"), "export {};");
  assert.equal(repo.git("show", "HEAD:scripts/source-size-baseline.json"), '{"repaired": true}');
  assert.equal(repo.git("show", "HEAD:README.md"), "before");
  assert.equal(readFileSync(join(repo.dir, "README.md"), "utf8"), "unrelated unpublished edit\n");
});

test("empty-scope fix rounds can commit a generated repair without a test edit", t => {
  const repo = fixture(t);
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), '{"repaired": true}\n');
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): repair generated baseline", {}, [], { admitTests: true });
  assert.equal(result.committed, true);
  assert.deepEqual(result.regenerable, ["scripts/source-size-baseline.json"]);
  assert.deepEqual(result.undeclared, ["README.md"]);
  assert.equal(repo.git("show", "HEAD:scripts/source-size-baseline.json"), '{"repaired": true}');
  assert.equal(repo.git("show", "HEAD:README.md"), "before");
});

test("empty-scope fix rounds refuse unrelated edits without staging them", t => {
  const repo = fixture(t);
  const before = repo.git("rev-parse", "HEAD");
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): reject unrelated edit", {}, [], { admitTests: true });
  assert.equal(result.committed, false);
  assert.deepEqual(result.undeclared, ["README.md"]);
  assert.match(result.reason!, /outside its declared files/);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
});

test("ordinary empty-scope tasks still refuse admitted repair surfaces", t => {
  const repo = fixture(t);
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), '{"repaired": true}\n');
  const before = repo.git("rev-parse", "HEAD");
  const result = commitWorkerEdits(repo.dir, [], "fix(worker): reject unpermitted repair");
  assert.equal(result.committed, false);
  assert.match(result.reason!, /declares no files/);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
});
