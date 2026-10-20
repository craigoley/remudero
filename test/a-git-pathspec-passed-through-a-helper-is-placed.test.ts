// @census-reads: test/a-test-imports-through-the-subpath-alias.test.ts — the declaration replaces what the fixture strings below appear to read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { censusMembershipCommand } from "#src/run-task.js";
import { sourceTextReaderOf } from "#src/lib/source-text-readers.js";

/**
 * W1-T10063: on 2026-10-17 #12582, #12601, #12604 and #12600 each went red in CI on the W1-T9864 subpath-alias
 * census after a pre-push census run that could not see it. That census reaches `git grep` and `git diff` with a
 * `"--", "test"` pathspec its CALLER passes into a helper, so the argv literal carrying `"grep"` never holds the
 * pathspec, and the reader derivation placed it on package.json and two fixture paths only.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALIAS_CENSUS = "test/a-test-imports-through-the-subpath-alias.test.ts";
const ROOTS = new Set(["src", "test", "scripts", "package.json"]);

function captured(fn: () => number): { code: number; stdout: string } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = () => undefined;
  try {
    return { code: fn(), stdout: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("W1-T10063: the subpath-alias census is placed as a census of test/", () => {
  const reader = sourceTextReaderOf(ALIAS_CENSUS, readFileSync(join(REPO_ROOT, ALIAS_CENSUS), "utf8"), ROOTS);
  assert.ok(reader.walks.includes("test/"), `walks were ${JSON.stringify(reader.walks)}`);
  assert.equal(reader.censusShaped, true, "a git pathspec walk is a census, so the precheck runs it");
});

test("W1-T10063: a pathspec passed to a git helper after a double-dash is a walk", () => {
  const walksOf = (text: string) => sourceTextReaderOf("test/x.test.ts", text, ROOTS);
  const diff = walksOf('const added = git(["diff", "--name-only", base, "--", "src"]);');
  assert.deepEqual(diff.walks, ["src/"]);
  assert.equal(diff.censusShaped, true);
  const helper = walksOf(
    'function grepFiles(rest: string[]) { return git(["grep", "-l", "-e", PATTERN, ...rest]); }\n' +
      'const atHead = grepFiles(["--untracked", "--", "scripts/*.mjs", ":!scripts/spike.mjs"]);',
  );
  assert.deepEqual(helper.walks, ["scripts/"], "the caller's pathspec is the walk, and an exclusion is not");
  assert.equal(helper.censusShaped, true);
});

test("W1-T10063: a double-dash array that names no tracked root, or that no git spawn reads, places nothing", () => {
  const walksOf = (text: string) => sourceTextReaderOf("test/x.test.ts", text, ROOTS);
  const temp = walksOf('git(["status", "--porcelain", "--", join(dir, "a.txt"), "fixture/b.txt"]);');
  assert.deepEqual(temp.walks, [], "a temp fixture path is not the tree");
  assert.equal(temp.censusShaped, false);
  const noGit = walksOf('spawnSync(process.execPath, ["--test", "--", "test/x.test.ts"]);');
  assert.deepEqual(noGit.walks, [], "a double-dash only reads as a pathspec in a suite that spawns git");
  assert.equal(noGit.censusShaped, false);
});

test("W1-T10063: census-membership names the alias census for an added test file", () => {
  const r = captured(() => censusMembershipCommand(["--files"], { repoRoot: REPO_ROOT, changedPaths: ["test/new.test.ts"] }));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.split("\n").includes(ALIAS_CENSUS), `--files printed:\n${r.stdout}`);
});
