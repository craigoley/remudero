// W1-T10064: the harness commit rewrites a NEW test's relative imports to the subpath aliases before it stages, so
// the W1-T9864 census never reds a fleet head for the shape #12582, #12600, #12601 and #12604 each hand-fixed.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitWorkerEdits, harnessCommitForShellLessWorker, rewriteAddedTestImports } from "#src/run-task.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

// Built from UP so this file's own source never carries the specifier the census counts.
const UP = "..";
const HERE = ".";
const RELATIVE = `import { preopenGate } from "${UP}/src/lib/preopen-gate.js";\n`;
const ALIASED = 'import { preopenGate } from "#src/lib/preopen-gate.js";\n';

function seeded(existing?: { path: string; text: string }) {
  const repo = gitRepo({ kind: "w1-t10064" });
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  if (existing) {
    writeFileSync(join(repo.dir, existing.path), existing.text);
    repo.git("add", "--", existing.path);
    repo.git("commit", "--quiet", "-m", "chore: seed an existing test");
  }
  return repo;
}

const committed = (repo: ReturnType<typeof gitRepo>, path: string) => repo.git("show", `HEAD:${path}`) + "\n";

test("W1-T10064: an added test is committed through the subpath alias", () => {
  const repo = seeded();
  writeFileSync(join(repo.dir, "test/preopen.test.ts"), `${RELATIVE}import { x } from "${HERE}/helpers/x.js";\n`);

  const result = commitWorkerEdits(repo.dir, ["test/preopen.test.ts"], "test: add preopen");

  assert.equal(result.committed, true);
  assert.equal(committed(repo, "test/preopen.test.ts"), `${ALIASED}import { x } from "#test/helpers/x.js";\n`);
  assert.deepEqual(result.aliasRewrite?.rewritten, ["test/preopen.test.ts"]);
});

test("W1-T10064: an existing test file is never rewritten by the harness commit", () => {
  const repo = seeded({ path: "test/old.test.ts", text: RELATIVE });
  writeFileSync(join(repo.dir, "test/old.test.ts"), `${RELATIVE}import { y } from "${UP}/src/lib/y.js";\n`);

  const result = commitWorkerEdits(repo.dir, ["test/old.test.ts"], "test: extend old");

  assert.equal(result.committed, true);
  assert.equal(committed(repo, "test/old.test.ts"), `${RELATIVE}import { y } from "${UP}/src/lib/y.js";\n`);
  assert.equal(result.aliasRewrite, undefined);
});

test("W1-T10064: an unresolved specifier is left and named on the commit row", () => {
  const repo = seeded();
  const text = `${RELATIVE}import pkg from "${UP}/package.json" with { type: "json" };\n`;
  writeFileSync(join(repo.dir, "test/pkg.test.ts"), text);
  const rows: { step: string; extra?: Record<string, unknown> }[] = [];

  harnessCommitForShellLessWorker({
    harnessOwnsGit: true, commitCount: 0, report: "REPORT\nCOMMIT_MESSAGE: test: add pkg", worktreePath: repo.dir,
    declaredPaths: ["test/pkg.test.ts"], log: (step, extra) => rows.push({ step, extra }), say: () => {},
  }, { ahead: () => 1 });

  assert.equal(committed(repo, "test/pkg.test.ts"), `${ALIASED}import pkg from "${UP}/package.json" with { type: "json" };\n`);
  const row = rows.find((r) => r.step === "implement.harness_commit");
  assert.deepEqual(row?.extra?.alias_rewritten, ["test/pkg.test.ts"]);
  assert.deepEqual(row?.extra?.alias_unresolved, [
    { path: "test/pkg.test.ts", specifier: "../package.json (leaves src/, scripts/ and test/)" },
  ]);
});

test("W1-T10064: a rewrite that throws leaves the file as written, and the commit still lands", () => {
  const repo = seeded();
  writeFileSync(join(repo.dir, "test/boom.test.ts"), RELATIVE);

  const result = commitWorkerEdits(repo.dir, ["test/boom.test.ts"], "test: add boom", {}, [], {
    aliasRewriter: () => { throw new Error("codemod exploded"); },
  });

  assert.equal(result.committed, true);
  assert.equal(committed(repo, "test/boom.test.ts"), RELATIVE);
  assert.deepEqual(result.aliasRewrite?.failed, [{ path: "test/boom.test.ts", error: "codemod exploded" }]);
});

test("W1-T10064: a test a merge brings in from main is not the worker's and is left alone", () => {
  const repo = seeded();
  writeFileSync(join(repo.dir, "test/mine.test.ts"), RELATIVE);
  writeFileSync(join(repo.dir, "test/main.test.ts"), RELATIVE);
  const status = "?? test/mine.test.ts\0A  test/main.test.ts\0";
  const runGit = (args: string[]) => args[0] === "rev-parse" ? "sha\n" : "test/main.test.ts\n";

  const result = rewriteAddedTestImports(repo.dir, status, ["test/mine.test.ts", "test/main.test.ts"], runGit);

  assert.deepEqual(result.rewritten, ["test/mine.test.ts"]);
  assert.equal(readFileSync(join(repo.dir, "test/main.test.ts"), "utf8"), RELATIVE);
});
