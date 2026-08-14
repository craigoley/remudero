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

// The `process-boundary` directive reads the CHECKED-OUT source file (the diff carries only added
// lines, not the surrounding declaration/close), resolved relative to CWD -- so these fixtures ship
// a `.fxt` source beside the lcov/diff and the CLI runs with cwd=FIXTURES.
function runDiffCoverageInFixtures(lcovFixture: string, diffFixture: string) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--lcov", join(FIXTURES, lcovFixture), "--diff", join(FIXTURES, diffFixture)],
    { cwd: FIXTURES },
  );
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

test("diff-coverage CLI: an ENTERED function's declaration line (FNDA>0 beside DA:0 — the source-map decl artifact) does NOT block; the closer-only `}` line is furniture", () => {
  const result = runDiffCoverage("fnda-decl.lcov", "fnda-decl.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
});

test("diff-coverage CLI: an UNENTERED function (FNDA:0) still blocks on its uncovered body — FNDA-awareness rescues declarations, never dead code", () => {
  const result = runDiffCoverage("fnda-uncalled.lcov", "fnda-decl.diff");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /src\/lib\/newfn\.ts:4/);
});

// ── W1-T481: a shared FN declaration line must not last-wins-resolve to the wrong function ──
//
// fnda-shared-decl.lcov declares TWO functions on the SAME line (3): `myFn` (called, FNDA:11)
// and `anonymous_1` (a default-param callback, never called, FNDA:0). Before the fix, `fnLines`
// keyed line 3 by whichever FN record parsed last (`anonymous_1`) and `fnHits` had no collision
// to hide the bug -- the line resolved to the uncalled anonymous function and DA:3,0 blocked a
// function that was genuinely entered 11 times. The same fixture also adds `otherFn` (line 7),
// declared but never called and sharing no line with anyone -- it and its uncovered body (line 8)
// must still block, proving the fix does not turn the gate permissive.
test("diff-coverage CLI: a CALLED function sharing its declaration line with an uncalled anonymous callback does NOT block (the fnLines/fnHits last-wins collision, W1-T481)", () => {
  const result = runDiffCoverage("fnda-shared-decl.lcov", "fnda-shared-decl.diff");
  assert.doesNotMatch(
    result.stderr.toString(),
    /src\/lib\/shared\.ts:3\b/,
    result.stdout?.toString() + result.stderr?.toString(),
  );
});

test("diff-coverage CLI: the SAME shared-decl-line diff still blocks a genuinely uncovered, unshared, never-called function -- the collision fix costs no strictness", () => {
  const result = runDiffCoverage("fnda-shared-decl.lcov", "fnda-shared-decl.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /src\/lib\/shared\.ts:7/);
  assert.match(result.stderr.toString(), /src\/lib\/shared\.ts:8/);
});

// ── W1-T221: the `// diff-cov: process-boundary — <reason>` directive ────────
//
// Re-exec/exit glue (`spawnSync(process.execPath, …)` then `process.exit(…)`) cannot carry a
// DA:<line>,N>0 hit without forking a real subprocess -- unit tests can't cover a process boundary,
// so the diff gate blocked it forever (fb-1784807764940-ce2404 / W1-T144 digest glue; W1-T79 /
// PR #662 defaultReexec). The directive exempts ONE such function, and only such a function: it is
// honoured only above a declaration whose body has a process-boundary call and stays small.

test("diff-coverage: a valid `process-boundary` directive over re-exec/exit glue -> exit 0, and EVERY exempted line is logged (no silent caps)", () => {
  const result = runDiffCoverageInFixtures("boundary-ok.lcov", "boundary-ok.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const out = result.stdout.toString();
  assert.match(out, /exempt \(process-boundary\) boundary-ok\.fxt:4/);
  assert.match(out, /exempt \(process-boundary\) boundary-ok\.fxt:9/);
});

test("diff-coverage: a `process-boundary` directive over a function with NO boundary call -> exit 1 (fails CLOSED), naming the invalid directive — abuse cannot hide business logic", () => {
  const result = runDiffCoverageInFixtures("boundary-abuse.lcov", "boundary-abuse.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stderr.toString(), /INVALID process-boundary directive/);
  assert.match(result.stderr.toString(), /boundary-abuse\.fxt:2/);
});

test("diff-coverage: a `process-boundary` directive over a too-large region (> 15 executable lines) -> exit 1 (fails CLOSED)", () => {
  const result = runDiffCoverageInFixtures("boundary-toobig.lcov", "boundary-toobig.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stderr.toString(), /INVALID process-boundary directive/);
  assert.match(result.stderr.toString(), /executable lines/);
});

test("diff-coverage: a directive exempts its own region, but an uncovered line OUTSIDE it still BLOCKS — the directive rescues process boundaries, never neighbouring code", () => {
  const result = runDiffCoverageInFixtures("boundary-mixed.lcov", "boundary-mixed.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stdout.toString(), /exempt \(process-boundary\) boundary-mixed\.fxt:3/);
  assert.match(result.stderr.toString(), /BLOCKED/);
  assert.match(result.stderr.toString(), /boundary-mixed\.fxt:6/);
});

// W1-T83 / PR #698: the worker-spawn boundary — a thin `return spawnWorker(buildXArgs(opts))`
// wrapper is the codebase's canonical "arg-builder is the tested contract; the spawn shells out
// via the Agent SDK, untested by design" pattern (spawnSpecialistWorker, spawnReconSpecialist).
test("diff-coverage: a thin `spawnWorker(...)` wrapper is a recognised process boundary -> exempt (the untested-by-design spawn pattern)", () => {
  const result = runDiffCoverageInFixtures("boundary-spawnworker.lcov", "boundary-spawnworker.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /exempt \(process-boundary\) boundary-spawnworker\.fxt:4/);
});

test("diff-coverage: an INDIRECT spawn caller (calls spawnReconSpecialist, not spawnWorker directly) is NOT a boundary -> INVALID (must earn coverage, never exempt orchestration logic)", () => {
  const result = runDiffCoverageInFixtures("boundary-indirectspawn.lcov", "boundary-indirectspawn.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stderr.toString(), /INVALID process-boundary directive/);
  assert.match(result.stderr.toString(), /no process-boundary call/);
});

test("diff-coverage: a `process-boundary` directive with NO `— <reason>` -> exit 1 (a mandatory reason, fails CLOSED)", () => {
  const result = runDiffCoverageInFixtures("boundary-noreason.lcov", "boundary-noreason.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stderr.toString(), /INVALID process-boundary directive/);
  assert.match(result.stderr.toString(), /requires "— <reason>"/);
});

test("diff-coverage: a `process-boundary` directive with no declaration after it -> exit 1 (fails CLOSED)", () => {
  const result = runDiffCoverageInFixtures("boundary-nodecl.lcov", "boundary-nodecl.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stderr.toString(), /INVALID process-boundary directive/);
  assert.match(result.stderr.toString(), /no declaration follows/);
});

test("diff-coverage: a `process-boundary` directive whose declaration never closes at its indent -> exit 1 (fails CLOSED)", () => {
  const result = runDiffCoverageInFixtures("boundary-noend.lcov", "boundary-noend.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stderr.toString(), /INVALID process-boundary directive/);
  assert.match(result.stderr.toString(), /could not find the end/);
});

// ── W1-T171 round 2: type-only declarations (interface bodies, `import type`) are erased to ZERO
// runtime JS, so under --enable-source-maps every one of their lines still gets a `DA:<line>,0`
// record (the same source-map-preamble artifact the leading-comment carve-out above already
// documents) -- no test can ever turn that 0 positive, so the gate must recognise them, not wait
// for coverage that can never arrive. Unlike `process-boundary`, no directive is required: an
// interface/type-literal body can never hide business logic, so there is no misuse risk in
// exempting it unconditionally.

test("diff-coverage: a type-only import + a brand-new interface's member lines do NOT block, even though lcov marks every one DA:0 (the type-erasure source-map artifact) -- the real function alongside them still must (and does) carry a hit", () => {
  const result = runDiffCoverageInFixtures("typeonly-ok.lcov", "typeonly-ok.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const out = result.stdout.toString();
  // line 1 (`import type ...`) is non-executable per-line (isNonExecutableLine) -- it never even
  // becomes a raw violation, so it is silently skipped, the same as a blank/comment line always
  // has been; only the interface BODY needs the range-based type-only carve-out to be logged.
  assert.doesNotMatch(result.stderr.toString(), /typeonly-ok\.fxt:1\b/);
  assert.match(out, /exempt \(type-only\) typeonly-ok\.fxt:3/); // export interface Foo {
  assert.match(out, /exempt \(type-only\) typeonly-ok\.fxt:4/); // id: string;
  assert.match(out, /exempt \(type-only\) typeonly-ok\.fxt:5/); // count: number;
});

test("diff-coverage FALSIFIER: an interface exempts ONLY its own body -- a genuinely UNENTERED function declared alongside it still BLOCKS, proving the carve-out cannot hide real business logic", () => {
  const result = runDiffCoverageInFixtures("typeonly-mixed.lcov", "typeonly-mixed.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString());
  assert.match(result.stdout.toString(), /exempt \(type-only\) typeonly-mixed\.fxt:1/); // interface open
  assert.match(result.stdout.toString(), /exempt \(type-only\) typeonly-mixed\.fxt:2/); // id: string;
  assert.match(result.stderr.toString(), /BLOCKED/);
  assert.match(result.stderr.toString(), /typeonly-mixed\.fxt:5/); // the real, unentered function
  assert.match(result.stderr.toString(), /typeonly-mixed\.fxt:6/);
});

test("computeTypeOnlyRanges: an `interface`/object-`type` declaration with no matching closer at its own indent is left UNEXEMPTED (fails safe, never silently widens the carve-out)", async () => {
  const { computeTypeOnlyRanges } = await import(pathToFileURL(SCRIPT).href);
  const ranges = computeTypeOnlyRanges("export interface Unclosed {\n  id: string;\n");
  assert.deepEqual(ranges, []);
});

test("computeTypeOnlyRanges: a `const` object LITERAL (real runtime value, not a type declaration) is never exempted -- only `interface`/`type X = {` openers qualify", async () => {
  const { computeTypeOnlyRanges } = await import(pathToFileURL(SCRIPT).href);
  const ranges = computeTypeOnlyRanges("const config = {\n  retries: 3,\n};\n");
  assert.deepEqual(ranges, []);
});

test("computeTypeOnlyRanges: an object-`type` ALIAS (`type X = { ... }`), not just `interface`, is recognised the same way -- both TS type-declaration shapes erase to zero runtime code", async () => {
  const { computeTypeOnlyRanges } = await import(pathToFileURL(SCRIPT).href);
  const ranges = computeTypeOnlyRanges("export type Bar = {\n  id: string;\n};\n");
  assert.deepEqual(ranges, [
    {
      start: 1,
      end: 3,
      reason: 'interface/type-literal member -- erases to zero runtime code, can never carry a hit',
      kind: 'type-only',
    },
  ]);
});
