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

// ── W1-T481: FN is keyed by LINE and FNDA by NAME, and both were LAST-WINS ───
//
// Two collisions, both measured on a full-suite lcov, both producing the SAME symptom — a function
// that really was entered reported as never entered, blocking a covered line:
//   LINE COLLISION  — 282 (file, line) keys carry more than one FN record against 4,042 distinct
//     keys (~1 declaration line in 14). Always the same shape: an exported function sharing its
//     line with an anonymous callback (`buildAccountUsageRoute`+`anonymous_14` at account-usage.ts
//     line 593). Last-wins resolved the line to the anonymous one, whose FNDA is 0.
//   NAME COLLISION  — 1,362 duplicate (file, name) FNDA pairs, 48 with more than one NON-ZERO
//     (`findMergedByTrailer` carries both FNDA:79 and FNDA:1089). Last-wins let a later FNDA:0
//     erase a real call count.
// The two COMPOUND: fixing either alone leaves the false positive reachable through the other.
//
// ONE fixture pair drives BOTH DIRECTIONS IN A SINGLE INVOCATION, which is the point — a fix that
// only proved the false positives were gone would be indistinguishable from switching the gate off.
// Measured against origin/main's script, the same fixture blocks all FIVE lines; patched it blocks
// exactly the two that are genuinely uncovered.

test("diff-coverage CLI: a shared declaration line where ONE of the functions was entered does NOT block — the line-keyed FN collision (W1-T481)", () => {
  const result = runDiffCoverage("fnda-shared-decl.lcov", "fnda-shared-decl.diff");
  const err = result.stderr.toString();
  // t481-shared.ts line 3 declares BOTH `keptFn` (FNDA:13) and `anonymous_1` (FNDA:0).
  assert.doesNotMatch(err, /t481-shared\.ts:3/, "an entered function's declaration line must not block because an anonymous callback shares it");
  // t481-livebody.ts line 1 is the same collision in the measured account-usage.ts shape.
  assert.doesNotMatch(err, /t481-livebody\.ts:1/, "the exported function's declaration line is covered — it was entered 13 times");
});

test("diff-coverage CLI: a REPEATED FNDA name keeps its non-zero hit — a later FNDA:0 must not erase it (W1-T481)", () => {
  const result = runDiffCoverage("fnda-shared-decl.lcov", "fnda-shared-decl.diff");
  // t481-dupname.ts carries FNDA:13,dupFn followed by FNDA:0,dupFn — the merged-lcov shape.
  assert.doesNotMatch(
    result.stderr.toString(),
    /t481-dupname\.ts:1/,
    "any non-zero FNDA for a name means the function was entered; last-wins dropped the 13",
  );
});

test("diff-coverage FALSIFIER: the shared-line rescue still BLOCKS when NO function on that line was entered, and blocks an unentered sibling's BODY (W1-T481)", () => {
  // THE FALSIFIER THAT SEPARATES A FIX FROM A DISABLED GATE. If the rescue were unconditional --
  // or scoped to a function's whole region rather than its declaration line -- both of these
  // would go quiet and the gate would be off.
  const result = runDiffCoverage("fnda-shared-decl.lcov", "fnda-shared-decl.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const err = result.stderr.toString();
  assert.match(err, /BLOCKED/);
  // Two functions declared on line 1, NEITHER entered -- permissiveness needs an entered function.
  assert.match(err, /t481-bothdead\.ts:1/, "a shared line with no entered function must still block");
  // The rescue covers the DECLARATION line only: the unentered callback's body is judged on its
  // own DA record, which is why permissiveness at the declaration costs no strictness.
  assert.match(err, /t481-livebody\.ts:2/, "the unentered callback's body must still block");
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

// ── W1-T2325: a RELOCATED line inherits its coverage debt, it doesn't manufacture a new one ─────
//
// The gate's own header comment already settles the policy: "an already-uncovered pre-existing
// line is the aggregate ratchet's problem, not a new regression this diff introduced". A line that
// was uncovered at the merge base and moves to a new offset during a restructure IS pre-existing
// text by that sentence -- but `addedLinesByFile` only ever saw the `+` side, so a pure relocation
// (identical text removed and re-added in the SAME diff) used to read exactly like a fresh
// regression and blocked the refactor the gate exists to reward.

test("removedLinesByFile: mirrors addedLinesByFile -- records `-` lines keyed by OLD (not new) line number, and does not consume a line number for `+` or context lines", async () => {
  const { removedLinesByFile } = await import(pathToFileURL(SCRIPT).href);
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,3 +1,2 @@",
    " head",
    "-gone",
    " tail",
    "",
  ].join("\n");
  const removed = removedLinesByFile(diff);
  assert.deepEqual([...removed.get("src/x.ts").entries()], [[2, "gone"]]);
});

test("diff-coverage CLI: an added block whose identical text was REMOVED elsewhere in the same diff is a RELOCATION -- it does not block even though lcov marks it DA:0, and every relocated line is printed naming its counterpart old line", () => {
  const result = runDiffCoverage("relocated-block.lcov", "relocated-block.diff");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const out = result.stdout.toString();
  assert.match(out, /exempt \(relocated\) src\/reloc\.ts:6 -- relocated from src\/reloc\.ts:2/);
  assert.match(out, /exempt \(relocated\) src\/reloc\.ts:7 -- relocated from src\/reloc\.ts:3/);
  assert.match(out, /exempt \(relocated\) src\/reloc\.ts:8 -- relocated from src\/reloc\.ts:4/);
  assert.match(out, /exempt \(relocated\) src\/reloc\.ts:9 -- relocated from src\/reloc\.ts:5/);
  assert.match(out, /exempt \(relocated\) src\/reloc\.ts:10 -- relocated from src\/reloc\.ts:6/);
  assert.match(out, /OK -- every added source line/);
});

test("diff-coverage FALSIFIER: each removed counterpart exempts AT MOST ONE added line -- a block pasted TWICE against a single removal exempts the first copy and still BLOCKS the second (consume-once)", () => {
  const result = runDiffCoverage("relocated-duplicate.lcov", "relocated-duplicate.diff");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const out = result.stdout.toString();
  const err = result.stderr.toString();
  // First copy (new lines 6-10) consumed the sole removed counterpart -- exempt.
  assert.match(out, /exempt \(relocated\) src\/reloc-dup\.ts:6 -- relocated from src\/reloc-dup\.ts:2/);
  assert.match(out, /exempt \(relocated\) src\/reloc-dup\.ts:10 -- relocated from src\/reloc-dup\.ts:6/);
  // Second copy (new lines 15-19) has no unconsumed counterpart left -- still blocks.
  assert.match(err, /BLOCKED/);
  assert.match(err, /src\/reloc-dup\.ts:15/);
  assert.match(err, /src\/reloc-dup\.ts:16/);
  assert.match(err, /src\/reloc-dup\.ts:17/);
  assert.match(err, /src\/reloc-dup\.ts:18/);
  assert.match(err, /src\/reloc-dup\.ts:19/);
  assert.doesNotMatch(err, /src\/reloc-dup\.ts:6\b/, "the relocated copy must not also appear in the blocking list");
});

test("computeRelocatedLines: a run SHORTER than MIN_RELOCATION_RUN is never recognised as a relocation, even with identical text on both sides -- a single coincidental line match must not exempt anything", async () => {
  const { addedLinesByFile, removedLinesByFile, computeRelocatedLines } = await import(pathToFileURL(SCRIPT).href);
  const diff = [
    "diff --git a/src/y.ts b/src/y.ts",
    "+++ b/src/y.ts",
    "@@ -1,2 +1,1 @@",
    "-return;",
    " tail",
    "@@ -5,1 +4,2 @@",
    " head2",
    "+return;",
    "",
  ].join("\n");
  const added = addedLinesByFile(diff);
  const removed = removedLinesByFile(diff);
  const relocated = computeRelocatedLines(added, removed);
  assert.equal(relocated.get("src/y.ts"), undefined);
});

test("computeRelocatedLines: a genuinely new added line with NO merge-base counterpart is never marked relocated -- the residual regression case must still surface", async () => {
  const { addedLinesByFile, removedLinesByFile, computeRelocatedLines } = await import(pathToFileURL(SCRIPT).href);
  const diff = [
    "diff --git a/src/z.ts b/src/z.ts",
    "+++ b/src/z.ts",
    "@@ -1,1 +1,2 @@",
    " head",
    "+brandNewLine1",
    "",
  ].join("\n");
  const added = addedLinesByFile(diff);
  const removed = removedLinesByFile(diff);
  const relocated = computeRelocatedLines(added, removed);
  assert.equal(relocated.get("src/z.ts"), undefined);
});
