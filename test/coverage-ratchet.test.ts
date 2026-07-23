import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T25: coverage ratchet gate (MASTER-PLAN §5 TIER 2, quality gate 1/4) ──
//
// Coverage % is not proof tests are real -- but the gate must be proven ACTIVE, not merely
// present: a below-baseline score is REJECTED (non-zero exit), an at/above-baseline score is
// ACCEPTED (zero exit). Every test below drives the actual CLI (scripts/coverage-ratchet.mjs)
// as a subprocess against a planted fixture, so the assertion is on the real exit code a CI job
// would see -- the falsifier fixture proves the gate is ACTIVE, not merely present.
//
// (scripts/coverage-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface, never imported -- keeping this test file itself
// clean under `tsc --noEmit`.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "..", "scripts", "coverage-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "coverage-ratchet");
const BASELINE = join(FIXTURES, "baseline.json");

function runRatchet(lcovFixture: string) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--lcov",
    join(FIXTURES, lcovFixture),
    "--baseline",
    BASELINE,
  ]);
}

test("coverage-ratchet CLI: BELOW-baseline fixture -> non-zero exit (the gate BLOCKS)", () => {
  const result = runRatchet("below-baseline.lcov");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /BLOCKED/);
  assert.match(result.stderr.toString(), /lines coverage 70\.00% < baseline 90\.00%/);
});

test("coverage-ratchet CLI: AT-baseline fixture (exact match) -> zero exit (the gate ACCEPTS)", () => {
  const result = runRatchet("at-baseline.lcov");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("coverage-ratchet CLI (W1-T220 falsifier): an out-of-repo temp-dir record is EXCLUDED, so an in-repo-above-baseline suite is not false-blocked by child-process coverage pollution", () => {
  // temp-dir-polluted.lcov: an in-repo record (src/fixture-a.ts, 95%/90% — above the
  // 90/85 baseline) plus one record whose SF path escapes the checkout
  // (../../../.../T/rmd-*/generate-plan-index.mjs, 10%/10%). WITHOUT the filter the
  // aggregate is 52.50%/50.00% and the gate BLOCKS (this is the live #614/#622/#632
  // flake). WITH the filter the out-of-repo record is dropped and the gate ACCEPTS.
  const result = runRatchet("temp-dir-polluted.lcov");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /excluded 1 out-of-repo record/);
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("coverage-ratchet CLI: ABOVE-baseline fixture -> zero exit (the gate ACCEPTS)", () => {
  const result = runRatchet("above-baseline.lcov");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("coverage-ratchet CLI: lines at/above baseline but BRANCHES below -> non-zero exit (both metrics gate independently)", () => {
  const result = runRatchet("branches-below-lines-ok.lcov");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /branches coverage 75\.00% < baseline 85\.00%/);
  // lines were fine -- only the branches violation should be reported.
  assert.doesNotMatch(result.stderr.toString(), /lines coverage .* < baseline/);
});

test("coverage-ratchet CLI: lcov record with NO line data -> linesPct falls back to 100% (lf === 0 edge case)", () => {
  const result = runRatchet("no-line-data.lcov");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /lines 100\.00%/);
});

test("coverage-ratchet CLI: lcov record with NO branch data -> branchesPct falls back to 100% (brf === 0 edge case)", () => {
  const result = runRatchet("no-branch-data.lcov");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /branches 100\.00%/);
});

// ── W1-T220 defect 1: the CI log used to name nothing when this gate failed ──
//
// The "Test with coverage" step ran node --test with ONLY --test-reporter=lcov, whose
// destination is a FILE -- so a failing run's CI log carried zero test output, just
// "Process completed with exit code 1" (verified first-hand against PR #473's real 436-line job
// log: zero failing-test lines, zero coverage/threshold mentions, one ##[error] line). Node's
// test runner accepts multiple reporter/destination pairs, so a human-readable `spec` reporter to
// stdout now runs alongside the existing `lcov` pair -- this test proves that wiring is present
// in ci.yml, and that the lcov artifact the ratchet step consumes is unchanged (same flag, same
// destination), so making the run legible does not break the gate it feeds.

test("coverage-ratchet CI wiring: ci.yml's coverage-ratchet job emits a human-readable reporter to stdout ALONGSIDE the unchanged lcov-to-file reporter", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("coverage-ratchet:");
  assert.notEqual(jobStart, -1, "ci.yml must declare a coverage-ratchet job");
  const nextJobStart = ciYml.indexOf("\n  mutation-ratchet:", jobStart);
  assert.notEqual(nextJobStart, -1, "coverage-ratchet job body must be findable in ci.yml");
  const jobBody = ciYml.slice(jobStart, nextJobStart);

  // Defect 1's fix: a human-readable reporter to stdout, so a failing run's log names what failed.
  assert.match(
    jobBody,
    /--test-reporter=spec --test-reporter-destination=stdout/,
    "coverage-ratchet's test-with-coverage step must emit a spec reporter to stdout",
  );
  // The lcov artifact the ratchet step consumes must be unchanged -- same flag, same file.
  assert.match(
    jobBody,
    /--test-reporter=lcov --test-reporter-destination=coverage\/lcov\.info/,
    "coverage-ratchet's test-with-coverage step must still emit the unchanged lcov artifact",
  );
  assert.match(
    jobBody,
    /node scripts\/coverage-ratchet\.mjs --lcov coverage\/lcov\.info --baseline scripts\/coverage-baseline\.json/,
    "the ratchet step must still consume that same unchanged lcov artifact",
  );
});

// ── W1-T210 round 2: without `--enable-source-maps`, Node's `--experimental-test-coverage`
// reports DA:<line> positions against the tsx/esbuild-TRANSPILED JS (comments and type-only
// lines stripped) rather than the original .ts file named in `SF:` -- verified empirically:
// `neutralizeFenceMarkers` (a real `src/run-task.ts` line 1120) was reported at line 506 without
// this flag, growing more wrong deeper into any heavily-commented file. `coverage-ratchet.mjs`'s
// aggregate sum tolerates this (it only ever sums LF/LH/BRF/BRH, never reads a line number), but
// `diff-coverage.mjs` (W1-T212) looks up `git diff`'s ORIGINAL-file line numbers directly against
// lcov's DA: map -- with the offset bug, that lookup silently reads some UNRELATED older line's
// hit count, which can block a PR's own new, fully-tested code with a false "uncovered" verdict.
test("coverage-ratchet CI wiring: ci.yml's coverage-collection step passes --enable-source-maps, so lcov's DA: line numbers agree with git diff's (the diff-coverage false-positive fix)", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("coverage-ratchet:");
  assert.notEqual(jobStart, -1, "ci.yml must declare a coverage-ratchet job");
  const nextJobStart = ciYml.indexOf("\n  mutation-ratchet:", jobStart);
  assert.notEqual(nextJobStart, -1, "coverage-ratchet job body must be findable in ci.yml");
  const jobBody = ciYml.slice(jobStart, nextJobStart);

  assert.match(
    jobBody,
    /node --enable-source-maps --experimental-test-coverage/,
    "the coverage-collection step must pass --enable-source-maps ahead of --experimental-test-coverage " +
      "so Node translates V8 coverage positions through tsx's source map back to real .ts line numbers",
  );
});

// ── W1-T220 acceptance criterion 3: the ratchet must print observed totals, baseline, AND the
// delta on failure, not just exit nonzero ──

test("coverage-ratchet CLI: BELOW-baseline failure names the delta explicitly, not just the two raw percentages", () => {
  const result = runRatchet("below-baseline.lcov");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const stderr = result.stderr.toString();
  assert.match(stderr, /lines coverage 70\.00% < baseline 90\.00% \(delta -20\.00pts\)/);
});

test("coverage-ratchet CLI: BRANCHES-below-baseline failure also names the delta explicitly", () => {
  const result = runRatchet("branches-below-lines-ok.lcov");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const stderr = result.stderr.toString();
  assert.match(stderr, /branches coverage 75\.00% < baseline 85\.00% \(delta -10\.00pts\)/);
});

// ── W1-T220 acceptance criterion 5 (THE PLAN-ONLY FALSIFIER): the explanation must account for a
// diff touching ZERO source and ZERO test files producing a red -- so any candidate cause that
// requires changed code is wrong by construction (PRs #474/#475 flaked this gate while touching
// neither src/** nor test/**). Both halves of the shipped mechanism are proven here, by reading
// their actual source, to be diff-content-BLIND:
//
//   (a) scripts/coverage-ratchet.mjs's verdict is a PURE function of two files on disk -- the lcov
//       report and the baseline JSON -- and nothing else. Unlike its sibling
//       scripts/mutation-ratchet.mjs (which explicitly reads a `--changed-files` list, itself
//       `git diff --name-only <base>...HEAD` output, to scope whether it even runs -- see ci.yml's
//       mutation-ratchet job), coverage-ratchet.mjs never inspects which files a PR touched. A
//       zero-source/zero-test diff therefore exercises the EXACT SAME comparison path as any
//       other diff -- there is no diff-aware branch that could have behaved differently.
//
//   (b) test/w1-t187-benchmark.test.ts's flake fix -- skipping the 500ms timing assertion -- is
//       keyed SOLELY on `process.execArgv` (whether THIS run was launched with coverage
//       instrumentation flags), an environment/runtime signal identical on every coverage-ratchet
//       job invocation regardless of the PR's diff. It is never keyed on git diff, changed-file
//       lists, or any other diff-derived input. So the skip/no-skip decision -- and therefore the
//       CPU-contention-driven timing flake it guards against -- is identical whether the
//       triggering PR touches src/**, test/**, or nothing at all, matching the plan-only firings.
//
// Both assertions below are genuine falsifiers, not just documentation: the pre-fix
// coverage-ratchet.mjs never referenced process.execArgv (that guard did not exist), and neither
// file would have failed the diff-blindness check either -- so these tests would have caught a fix
// that "solved" the flake by inspecting the diff, which is precisely the class of explanation the
// plan-only firings rule out.

test("coverage-ratchet PLAN-ONLY FALSIFIER: the gate's verdict is a pure function of the lcov + baseline files, never of which files a diff touched (unlike mutation-ratchet's explicit --changed-files diff-scoping)", async () => {
  const ratchetSrc = await readFile(SCRIPT, "utf8");
  assert.doesNotMatch(
    ratchetSrc,
    /changed-files|changedFiles|git diff|BASE_SHA/i,
    "coverage-ratchet.mjs must stay diff-blind -- a verdict that inspected the diff would no " +
      "longer explain a red on a diff touching zero source and zero test files",
  );
  assert.match(
    ratchetSrc,
    /options:\s*{\s*lcov:\s*{[^}]*}\s*,\s*baseline:\s*{[^}]*}\s*,?\s*}/s,
    "coverage-ratchet.mjs's CLI surface must stay exactly --lcov/--baseline -- no diff-scoping flag",
  );

  // Contrast proof: the sibling mutation-ratchet gate DOES scope itself off the diff -- confirming
  // that shape exists elsewhere in this file family, so coverage-ratchet's absence of it is a
  // deliberate, checked property rather than an accident this test would fail to notice drifting.
  const mutationRatchetSrc = await readFile(
    join(REPO_ROOT, "scripts", "mutation-ratchet.mjs"),
    "utf8",
  );
  assert.match(
    mutationRatchetSrc,
    /changed-files/,
    "sanity check: mutation-ratchet.mjs is the diff-scoped sibling -- if this ever stops matching, " +
      "the contrast this test draws is stale",
  );
});

test("coverage-ratchet PLAN-ONLY FALSIFIER: the W1-T187 benchmark's flake-avoidance skip is keyed on process.execArgv (environment), never on git diff or changed-file content", async () => {
  const benchmarkSrc = await readFile(
    join(REPO_ROOT, "test", "w1-t187-benchmark.test.ts"),
    "utf8",
  );
  // The mechanism that prevents the flake must be a pure environment read -- present identically
  // whether the triggering PR touched src/**, test/**, or (per PRs #474/#475) nothing at all.
  assert.match(
    benchmarkSrc,
    /process\.execArgv/,
    "the coverage-instrumentation skip must be keyed on process.execArgv, an environment signal " +
      "identical across every coverage-ratchet run regardless of diff content",
  );
  assert.doesNotMatch(
    benchmarkSrc,
    /changed-files|changedFiles|git diff|BASE_SHA/i,
    "the flake fix must never key its skip decision on diff/changed-file content -- doing so " +
      "would stop explaining the plan-only firings (PRs #474/#475 touched zero source, zero test)",
  );
});

test("coverage-ratchet CLI: baseline record missing BOTH metrics -> no crash, no false block, prints 0.00% baseline", () => {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--lcov",
    join(FIXTURES, "above-baseline.lcov"),
    "--baseline",
    join(FIXTURES, "baseline-no-metrics.json"),
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /baseline 0\.00%.*baseline 0\.00%/s);
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("coverage-ratchet module: importing (not spawning as the entry script) does not re-invoke main() -- process.argv[1] is undefined when eval'd", () => {
  // Drives the `import.meta.url === pathToFileURL(process.argv[1] ?? '').href` direct-execution
  // guard down its OTHER path: when this module is loaded via `node --input-type=module -e`
  // (dynamic import, no script-file argv[1]), process.argv[1] is undefined, so the `?? ''`
  // fallback is exercised and the guard correctly evaluates to false -- main() must not run
  // (it would otherwise crash trying to read a nonexistent default lcov/baseline path).
  const scriptUrl = pathToFileURL(SCRIPT).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(scriptUrl)}); console.log("imported-without-main-invocation");`,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /imported-without-main-invocation/);
});
