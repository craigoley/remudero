import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { commitWorkerEdits, harnessCommitForShellLessWorker } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const title = "the worker's [proof] (lands)";
const acceptance = [{ claim: "lands", proof: `unit test: ${title}` }];
const source = `import { test } from "node:test";\ntest(${JSON.stringify(title)}, () => {});\n`;

function fixture(): GitRepo {
  const repo = gitRepo({ kind: "proof-named-test" });
  repo.git("config", "user.name", "proof test fixture");
  repo.git("config", "user.email", "proof@example.invalid");
  repo.git("config", "commit.gpgsign", "false");
  return repo;
}

function write(repo: GitRepo, path: string, content = source): void {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), content);
}

test("W1-T5386: a new test file carrying a title the task proof names is staged though undeclared", () => {
  const repo = fixture();
  try {
    write(repo, "test/nested/new.test.ts");
    write(repo, "stray.ts");
    const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): add proof", {}, acceptance);
    assert.equal(result.committed, true, result.reason);
    assert.deepEqual(result.proofMatchedTests, ["test/nested/new.test.ts"]);
    assert.deepEqual(result.undeclared, ["stray.ts"]);
    assert.equal(repo.git("show", "--pretty=", "--name-only", "HEAD"), "test/nested/new.test.ts");
    assert.match(repo.git("status", "--porcelain"), /stray.ts/);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5386: an undeclared test file that names no proof title is still refused", () => {
  const repo = fixture();
  try {
    write(repo, "test/unrelated.test.ts", 'test("unrelated", () => {});');
    write(repo, "test/comment.test.ts", `// ${source.replaceAll("\n", " ")}\n`);
    write(repo, "test/string.test.ts", `const example = ${JSON.stringify(source)};`);
    write(repo, "test/template.test.ts", `const example = \`${source}\`;`);
    write(repo, "test/regex.test.ts", `const example = /test("the worker's [proof] (lands)", () => {})/;`);
    write(repo, "src/matched.test.ts");
    const before = repo.git("rev-parse", "HEAD");
    const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): refuse stray", {}, acceptance);
    assert.equal(result.committed, false);
    assert.match(result.reason!, /outside its declared files/);
    assert.deepEqual(result.undeclared, ["src/matched.test.ts", "test/comment.test.ts", "test/regex.test.ts",
      "test/string.test.ts", "test/template.test.ts", "test/unrelated.test.ts"]);
    assert.equal(repo.git("rev-parse", "HEAD"), before);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5386: existing test edits stay refused even when they declare the proof title", () => {
  const repo = fixture();
  try {
    write(repo, "test/existing.test.ts", 'test("old", () => {});');
    repo.git("add", ".");
    repo.git("commit", "-m", "test(worker): seed existing test");
    const before = repo.git("rev-parse", "HEAD");
    write(repo, "test/existing.test.ts");
    for (const staged of [false, true]) {
      if (staged) repo.git("add", "test/existing.test.ts");
      const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): refuse edit", {}, acceptance);
      assert.equal(result.committed, false);
      assert.deepEqual(result.undeclared, ["test/existing.test.ts"]);
      assert.equal(repo.git("rev-parse", "HEAD"), before);
    }
    repo.git("rm", "--cached", "test/existing.test.ts");
    const removedFromIndex = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): refuse readd", {}, acceptance);
    assert.equal(removedFromIndex.committed, false, "an untracked status cannot make a HEAD file new");
    assert.ok(removedFromIndex.undeclared.includes("test/existing.test.ts"));
  } finally {
    repo.cleanup();
  }
});

test("W1-T5386: literal titles in multiline and modifier declarations are admitted", () => {
  const repo = fixture();
  try {
    write(repo, "test/multiline.test.ts", `test /* declaration */ (\n'${title.replaceAll("'", "\\'")}', () => {});`);
    write(repo, "test/template.test.ts", `it.only(\`${title}\`, () => {});`);
    write(repo, "test/nested.test.ts", `t.test(${JSON.stringify(title)}, () => {});`);
    const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): add literal proofs", {}, acceptance);
    assert.equal(result.committed, true);
    assert.deepEqual(result.proofMatchedTests, ["test/multiline.test.ts", "test/nested.test.ts", "test/template.test.ts"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5386: a staged addition is admitted and a proof title uses literal substring matching", () => {
  const repo = fixture();
  try {
    write(repo, "test/staged.test.ts", `test(${JSON.stringify(`prefix ${title} suffix`)}, () => {});`);
    repo.git("add", "test/staged.test.ts");
    const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): add staged proof", {}, acceptance);
    assert.equal(result.committed, true);
    assert.deepEqual(result.proofMatchedTests, ["test/staged.test.ts"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5386: only the task's own title proof grants the exception", () => {
  const repo = fixture();
  try {
    write(repo, "test/new.test.ts");
    for (const criteria of [[], [{ claim: "x", proof: "unit test: test/new.test.ts" }],
      [{ claim: "x", proof: `grep: ${title} in test/new.test.ts` }],
      [{ claim: "x", proof: "unit test: another task's proof" }]]) {
      const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): refuse proof", {}, criteria);
      assert.equal(result.committed, false);
      assert.deepEqual(result.undeclared, ["test/new.test.ts"]);
    }
    symlinkSync(join(repo.dir, "test/new.test.ts"), join(repo.dir, "test/link.test.ts"));
    const result = commitWorkerEdits(repo.dir, ["src/feature.ts"], "test(worker): refuse link", {}, acceptance);
    assert.equal(result.committed, true);
    assert.deepEqual(result.undeclared, ["test/link.test.ts"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T5386: the harness forwards acceptance and reports proof-matched tests on the commit row", () => {
  const repo = fixture();
  try {
    write(repo, "test/new.test.ts");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const count = harnessCommitForShellLessWorker({
      harnessOwnsGit: true, commitCount: 0,
      report: "REPORT\nCOMMIT_MESSAGE: test(worker): add own proof",
      worktreePath: repo.dir, declaredPaths: ["src/feature.ts"], acceptance,
      log: (step, extra) => rows.push({ step, extra }), say: () => {},
    }, { ahead: () => 1 });
    assert.equal(count, 1);
    assert.equal(rows[0]?.step, "implement.harness_commit");
    assert.deepEqual(rows[0]?.extra?.proofMatchedTests, ["test/new.test.ts"]);
    assert.equal(rows[0]?.extra?.sha, repo.git("rev-parse", "HEAD"));
  } finally {
    repo.cleanup();
  }
});
