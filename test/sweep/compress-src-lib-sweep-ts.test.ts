import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { stripComments } from "#src/lib/test-placement.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const { countCommentLines } = createRequire(import.meta.url)("#scripts/comment-load-ratchet.mjs") as {
  countCommentLines(source: string, path: string): { comments: number; code: number };
};

// @source-text-subject: this task changes source prose and must preserve every code line.
const SOURCE_PATH = "src/lib/sweep.ts";
const TEST_PATH = "test/sweep/compress-src-lib-sweep-ts.test.ts";

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
  return result.stdout.trimEnd();
}

function executableLines(source: string): string {
  return stripComments(source).split("\n").map(line => line.trimEnd())
    .filter(line => line.trim()).join("\n");
}

test("W1-T10821: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, SOURCE_PATH), "utf8");
  // This three-line explanation was compressed to one line by this PR. Check it even when
  // the test is already present at the comparison base, without freezing the whole module.
  const importCycleComment = source.match(/^\/\/ W1-T2384:[^\n]*(?:\n\/\/[^\n]*)*/m)?.[0];
  assert.ok(importCycleComment, "the import-cycle explanation must remain present");
  const importCycleComments = countCommentLines(importCycleComment, SOURCE_PATH).comments;
  assert.ok(importCycleComments > 0 && importCycleComments < 3,
    `the original three-line import-cycle explanation must stay compressed: ${importCycleComments}`);

  const base = git(["merge-base", "origin/main", "HEAD"]);
  const added = git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", TEST_PATH]);
  if (added !== TEST_PATH) {
    return;
  }
  const before = git(["show", `${base}:${SOURCE_PATH}`]);
  assert.equal(executableLines(source), executableLines(before),
    "all non-comment code lines, including literal contents and types, must remain identical");
  const previousComments = countCommentLines(before, SOURCE_PATH).comments;
  const comments = countCommentLines(source, SOURCE_PATH).comments;
  assert.ok(previousComments > 0 && comments > 0, "the measurement must see comments in both sources");
  assert.ok(comments < previousComments,
    `comments must decrease from the PR base: ${comments} >= ${previousComments}`);
});

test("comment stripping retains literals and detects executable edits", () => {
  const source = 'const url = "https://example.com"; // explanation\nconst n = 1;';
  assert.equal(executableLines(source), 'const url = "https://example.com";\nconst n = 1;');
  assert.equal(executableLines(source), executableLines(source.replace("explanation", "shorter")));
  assert.notEqual(executableLines(source), executableLines(source.replace("n = 1", "n = 2")));
  assert.notEqual(executableLines(source), executableLines(source.replace("example.com", "other.test")));
});
