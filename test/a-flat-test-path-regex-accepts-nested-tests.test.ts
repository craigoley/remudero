/**
 * A FLAT TEST-PATH READER ACCEPTS NESTED TESTS (W1-T9871, test restructure letter D part 3).
 *
 * Three readers assumed `test/<name>.test.ts`: the fixture-copy census's directory walk, the
 * census precheck's FIXTURE_SCOPE_RE, and run-task's addedTestFilesAtHead filter. Once a test is
 * moved under test/<dir>/, each read it as absent: the census shrank silently, a nested hand-rolled
 * fixture escaped the pre-push precheck, and body repair reported "diff adds no test file".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { addedTestFilesAtHead } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs modules have no declaration file.
import { evaluateCensusPrecheck } from "../scripts/census-precheck.mjs";
// @ts-ignore the executable .mjs modules have no declaration file.
import { countFixtureCopies, listFixtureCopyFiles } from "../scripts/fixture-copy-census.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = "scripts/fixture-copy-baseline.json";
// Built by concatenation so THIS file never scores as a raw init site in the census it tests.
const INIT_SITE = 'run(["' + 'init"]);\n';

function treeOf(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-nested-census-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test("W1-T9871: the fixture-copy census reads a nested test file", () => {
  const root = treeOf({
    "test/top.test.ts": INIT_SITE,
    "test/x/y.test.ts": INIT_SITE,
    "test/x/deeper/z.test.ts": INIT_SITE,
    "test/x/helper.ts": INIT_SITE,
  });
  try {
    assert.deepEqual(listFixtureCopyFiles(root), ["top.test.ts", "x/deeper/z.test.ts", "x/y.test.ts"]);
    assert.equal(countFixtureCopies(root).gitInitSites, 3, "the two nested suites count; a non-suite helper does not");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9871: the census precheck takes a nested test into scope", () => {
  const baselines = { [FIXTURES]: JSON.stringify({ gitInitSites: 1, gitInitFiles: 1 }) };
  const base: Record<string, string> = { ...baselines, "test/one.test.ts": INIT_SITE };
  const head: Record<string, string> = { ...base, "test/x/y.test.ts": INIT_SITE };
  const found: string[] = evaluateCensusPrecheck({
    changed: ["test/x/y.test.ts"],
    readHead: (p: string) => head[p] ?? null,
    readBase: (p: string) => base[p] ?? null,
    measuredFiles: [],
    testFiles: ["one.test.ts", "x/y.test.ts"],
  });
  assert.deepEqual(
    found.map((f) => f.split(" — ")[0]),
    ["fixture-copy: gitInitSites 2 > baseline 1", "fixture-copy: gitInitFiles 2 > baseline 1"],
  );
});

test("W1-T9871: a nested new test counts as an added test file at head", () => {
  const repo = gitRepo({ kind: "nested-added-tests" });
  try {
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(repo.dir, "test", "x"), { recursive: true });
    writeFileSync(join(repo.dir, "test", "x", "y.test.ts"), "");
    writeFileSync(join(repo.dir, "test", "x", "helper.ts"), "");
    repo.git("add", ".");
    repo.git("commit", "--quiet", "-m", "add a nested suite");
    assert.deepEqual(addedTestFilesAtHead(repo.git("rev-parse", "HEAD"), repo.dir), { kind: "read", files: ["test/x/y.test.ts"] });
  } finally {
    repo.cleanup();
  }
});

test("W1-T9871: a test under test/fixtures is still excluded", () => {
  const root = treeOf({ "test/top.test.ts": INIT_SITE, "test/fixtures/a/test/existing.test.ts": INIT_SITE });
  const repo = gitRepo({ kind: "fixture-excluded" });
  try {
    assert.deepEqual(listFixtureCopyFiles(root), ["top.test.ts"], "the census walk skips test/fixtures/**");
    const fixturePath = "test/fixtures/a/test/existing.test.ts";
    const zero = JSON.stringify({ gitInitSites: 0, gitInitFiles: 0 });
    const found: string[] = evaluateCensusPrecheck({
      changed: [fixturePath],
      readHead: (p: string) => (p === FIXTURES ? zero : p === fixturePath ? INIT_SITE : null),
      readBase: (p: string) => (p === FIXTURES ? zero : null),
      measuredFiles: [],
      testFiles: ["fixtures/a/test/existing.test.ts"],
    });
    assert.deepEqual(found, [], "a fixtures path is not in the precheck's scope");

    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(repo.dir, "test", "fixtures", "a"), { recursive: true });
    writeFileSync(join(repo.dir, "test", "fixtures", "a", "existing.test.ts"), "");
    repo.git("add", ".");
    repo.git("commit", "--quiet", "-m", "add a fixture");
    assert.deepEqual(addedTestFilesAtHead(repo.git("rev-parse", "HEAD"), repo.dir), { kind: "read", files: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("W1-T9871: the census inspects exactly the tracked test suites outside test/fixtures", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "test/"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter((p) => p.endsWith(".test.ts") && !p.startsWith("test/fixtures/") && p !== "test/fixture-copy-census.test.ts")
    .map((p) => p.slice("test/".length))
    .sort();
  const inspected: string[] = listFixtureCopyFiles(REPO_ROOT);
  assert.ok(inspected.length > 0, "the census must inspect something");
  assert.ok(inspected.some((p) => p.includes("/")), "the live tree has nested suites (test/helpers/*.test.ts) the walk must reach");
  assert.deepEqual(inspected, tracked);
});
