import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T212 (recon R-12): per-diff coverage gate ────────────────────────────
//
// scripts/coverage-ratchet.mjs's floor is aggregate-only (test/coverage-ratchet.test.ts's
// PLAN-ONLY FALSIFIER proves the verdict is a pure function of the lcov + baseline files, never
// of which files a diff touched) -- so new source lines added with zero covering tests merge
// freely as long as the codebase-wide aggregate stays above the floor. Raising the aggregate
// floor does not fix this (it makes the build brittle and still can't catch one untested addition
// in a large codebase); the design note calls for a measure over the lines the PR ADDS, using the
// per-file lcov data the reporter already emits.
//
// Every test below drives the actual CLI (scripts/diff-coverage.mjs) as a subprocess against
// planted fixtures, so the assertion is on the real exit code a CI job would see -- same shape as
// coverage-ratchet's falsifier tests. (scripts/diff-coverage.mjs is a plain .mjs file outside
// tsconfig's `include`, so it is exercised here only via its CLI surface, never imported.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "..", "scripts", "diff-coverage.mjs");
const FIXTURES = join(__dirname, "fixtures", "diff-coverage");

function runDiffCoverage(lcovFixture: string, diffFixture: string) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--lcov",
    join(FIXTURES, lcovFixture),
    "--diff",
    join(FIXTURES, diffFixture),
  ]);
}

test("diff-coverage CLI: a diff adding an UNCOVERED source line (lcov DA:<line>,0) -> non-zero exit (the gate BLOCKS), naming file:line", () => {
  const result = runDiffCoverage("uncovered.lcov", "added-line.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /BLOCKED/);
  assert.match(result.stderr.toString(), /src\/example\.ts:2/);
});

test("diff-coverage CLI: the SAME added line, now covered (lcov DA:<line>,1) -> zero exit (the gate ACCEPTS)", () => {
  const result = runDiffCoverage("covered.lcov", "added-line.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /OK -- every added source line/);
});

test("diff-coverage CLI: an added line lcov never instruments at all (no DA: record -- e.g. a blank/comment line) -> zero exit, not a false block", () => {
  // sparse.lcov has DA:1 and DA:3 for src/sparse.ts but NO DA:2 record -- the diff adds line 2.
  const result = runDiffCoverage("sparse.lcov", "added-line-sparse.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
});

test("diff-coverage CLI: an added line in a file lcov never saw at all (e.g. test/**, excluded from the coverage run) -> zero exit, not a crash", () => {
  const result = runDiffCoverage("covered.lcov", "added-line-test-file.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
});

test("diff-coverage CLI: a hunk ending with a '\\ No newline at end of file' marker is not mistaken for a content line (it consumes no new-file line number)", () => {
  const result = runDiffCoverage("covered.lcov", "added-line-no-newline.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
});

test("diff-coverage CLI FALSIFIER: a second hunk's new-file line numbers are anchored to ITS OWN `@@ -a,b +c,d @@` header, not a naive running count carried over from the first hunk", () => {
  // multi-hunk.diff's second hunk opens `@@ -5,2 +6,2 @@` after a gap the diff never shows --
  // the true added line is 7 (lcov DA:7,1, covered). A parser that instead kept incrementing a
  // single counter from hunk 1 (which left off at 3) would misidentify the added line as 4 --
  // multi.lcov deliberately records DA:4,0 so that exact bug would report a false BLOCKED here.
  const result = runDiffCoverage("multi.lcov", "multi-hunk.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.doesNotMatch(result.stderr.toString(), /src\/multi\.ts:4/);
});

// ── CI wiring: the gate must actually run on every PR, unconditionally ─────

test("diff-coverage CI wiring: ci.yml's coverage-ratchet job also runs diff-coverage against a full-history checkout and the PR's base..head diff", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("coverage-ratchet:");
  assert.notEqual(jobStart, -1, "ci.yml must declare a coverage-ratchet job");
  const nextJobStart = ciYml.indexOf("\n  mutation-ratchet:", jobStart);
  assert.notEqual(nextJobStart, -1, "coverage-ratchet job body must be findable in ci.yml");
  const jobBody = ciYml.slice(jobStart, nextJobStart);

  // Runs UNCONDITIONALLY (same job as the always-runs aggregate ratchet -- no separate `if:`, so
  // it can never go silently absent and deadlock merge the way a path-filtered required check
  // would).
  assert.doesNotMatch(jobBody, /\n\s*if:/, "diff-coverage must not be gated behind a conditional");
  // Needs the full base..head history to diff against, not the default shallow clone.
  assert.match(jobBody, /fetch-depth:\s*0/, "coverage-ratchet's checkout must fetch full history for the diff");
  assert.match(
    jobBody,
    /git diff .*BASE_SHA.*\.\.\.HEAD/s,
    "the job must compute the PR's base...head diff for diff-coverage to consume",
  );
  assert.match(
    jobBody,
    /node scripts\/diff-coverage\.mjs --lcov coverage\/lcov\.info --diff/,
    "the job must invoke diff-coverage.mjs against the same lcov artifact coverage-ratchet consumes",
  );
});

test("diff-coverage module: importing (not spawning as the entry script) does not re-invoke main() -- process.argv[1] is undefined when eval'd", () => {
  const scriptUrl = pathToFileURL(SCRIPT).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(scriptUrl)}); console.log("imported-without-main-invocation");`,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /imported-without-main-invocation/);
});

test("diff-coverage CLI: a new file's LEADING comment block carrying DA:0 records (the --enable-source-maps preamble artifact) does NOT block — comment/blank lines are non-executable regardless of DA presence", () => {
  const result = runDiffCoverage("leading-comment.lcov", "leading-comment.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
});

test("diff-coverage CLI: the comment carve-out rescues ONLY non-executable lines — a genuinely uncovered added CODE line in the same file still blocks", () => {
  const result = runDiffCoverage("leading-comment-real-miss.lcov", "leading-comment-real-miss.diff");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /src\/lib\/newmod\.ts:5/);
});
