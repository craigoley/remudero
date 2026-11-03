import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { commitWorkerEdits } from "#src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

function fixture(t: test.TestContext) {
  const repo = gitRepo({ scope: t, kind: "ignored-declared-worker" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const write = (path: string, content = "worker edit\n") => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  };
  write(".gitignore", "# fixture rules\nlocal/\n*.secret\n!kept.secret\n");
  write("test/.gitignore", "dist/\n");
  write("declared.txt", "unchanged\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: seed ignore rules");
  const head = repo.git("rev-parse", "HEAD");
  return { repo, write, head };
}

test("test/worker/run-task/a-declared-path-git-ignores-is-a-named-commit-refusal.test.ts", t => {
  const { repo, write, head } = fixture(t);
  const paths = ["test/local/a test.ts", "test/dist/雪\tline\n.test.ts", "hidden.secret"];
  for (const path of paths) write(path);
  write("local/undeclared.txt");
  assert.equal(repo.git("status", "--porcelain", "--untracked-files=all"), "");

  const result = commitWorkerEdits(repo.dir, [...paths, "absent.secret"], "fix: retain worker edits");

  assert.equal(result.committed, false);
  assert.deepEqual(result.ignored_declared, paths);
  assert.deepEqual(result.undeclared, []);
  assert.equal(result.reason, "declared path ignored by .gitignore: " + [
    `${paths[0]} (rule .gitignore:2:local/)`,
    `${paths[1]} (rule test/.gitignore:1:dist/)`,
    `${paths[2]} (rule .gitignore:3:*.secret)`,
  ].join(", "));
  assert.equal(repo.git("rev-parse", "HEAD"), head);
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
  assert.equal(repo.git("ls-files", "--", ...paths), "");
  for (const path of paths) assert.equal(readFileSync(join(repo.dir, path), "utf8"), "worker edit\n");
});

test("an ignored declared write is also refused in a guarded fix round", t => {
  const { repo, write, head } = fixture(t);
  write("test/local/fix.ts");
  const result = commitWorkerEdits(repo.dir, ["test/local/fix.ts"], "fix: save round", {}, [], {
    priorHeadSha: head, branch: "main",
  });
  assert.equal(result.committed, false);
  assert.deepEqual(result.ignored_declared, ["test/local/fix.ts"]);
  assert.equal(result.reason, "declared path ignored by .gitignore: test/local/fix.ts (rule .gitignore:2:local/)");
  assert.equal(repo.git("rev-parse", "HEAD"), head);
  assert.equal(repo.git("diff", "--cached", "--name-only"), "");
});

test("an ignored declared directory names the rule hiding that directory", t => {
  const { repo, write } = fixture(t);
  write("test/local/child.txt");
  const result = commitWorkerEdits(repo.dir, ["test/local/"], "fix: save directory");
  assert.equal(result.committed, false);
  assert.deepEqual(result.ignored_declared, ["test/local/"]);
  assert.equal(result.reason, "declared path ignored by .gitignore: test/local/ (rule .gitignore:2:local/)");
});

test("W1-T11124 criterion 2: an undeclared ignored write keeps the empty-round outcome", t => {
  const { repo, write, head } = fixture(t);
  write("local/undeclared.txt");
  const result = commitWorkerEdits(repo.dir, ["declared.txt"], "fix: save declared edits");
  assert.deepEqual(result, { committed: false, undeclared: [], reason: "the worker changed nothing" });
  assert.equal(repo.git("rev-parse", "HEAD"), head);
});

test("W1-T11124 criterion 2: a genuinely empty round keeps its reason, including absent ignored paths", t => {
  const { repo, head } = fixture(t);
  const result = commitWorkerEdits(repo.dir, ["declared.txt", "absent.secret"], "fix: save declared edits");
  assert.deepEqual(result, { committed: false, undeclared: [], reason: "the worker changed nothing" });
  assert.equal(repo.git("rev-parse", "HEAD"), head);
});

test("W1-T11124 criterion 2: ignored undeclared files do not change an outside-scope refusal", t => {
  const { repo, write } = fixture(t);
  write("local/undeclared.txt");
  write("outside.txt");
  const result = commitWorkerEdits(repo.dir, ["declared.txt"], "fix: save declared edits");
  assert.deepEqual(result, {
    committed: false, undeclared: ["outside.txt"],
    reason: "every change the worker made is outside its declared files",
  });
});

test("clean tracked files beneath an ignored directory remain an empty round", t => {
  const { repo, write } = fixture(t);
  write("local/kept.txt");
  repo.git("add", "-f", "--", "local/kept.txt");
  repo.git("commit", "-qm", "chore: seed a previously tracked ignored path");
  const result = commitWorkerEdits(repo.dir, ["local/kept.txt"], "fix: save declared edits");
  assert.deepEqual(result, { committed: false, undeclared: [], reason: "the worker changed nothing" });
});

test("an ignore negation remains eligible for an ordinary worker commit", t => {
  const { repo, write } = fixture(t);
  write("kept.secret");
  const result = commitWorkerEdits(repo.dir, ["kept.secret"], "fix: save negated path");
  assert.equal(result.committed, true);
  assert.equal(result.ignored_declared, undefined);
  assert.equal(repo.git("show", "HEAD:kept.secret"), "worker edit");
});
