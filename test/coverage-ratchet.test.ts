import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ── W1-T1277: a malformed (present but non-number) linesPct/branchesPct must REFUSE, not silently
// disarm ──
//
// The pre-fix guard was `typeof baseline.linesPct === 'number' && actual.linesPct < baseline...`
// -- any non-number short-circuited the `&&`, so no violation was ever pushed and the run reported
// OK. below-baseline.lcov (lines 70%, branches 80%) is below BOTH baseline.json's numeric floors
// (90/85), so a numeric control on either field would BLOCK -- proving the refusal is not just
// "any malformed value happens to pass anyway".

function runRatchetWithBaseline(lcovFixture: string, baselineFixture: string) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--lcov",
    join(FIXTURES, lcovFixture),
    "--baseline",
    join(FIXTURES, baselineFixture),
  ]);
}

test("coverage-ratchet CLI: a linesPct present but not a number refuses instead of passing (acceptance criterion 1)", () => {
  const result = runRatchetWithBaseline("below-baseline.lcov", "malformed-lines-baseline.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /'linesPct' must be a number, got "90"/);
});

test("coverage-ratchet CLI: a branchesPct present but not a number refuses instead of passing (acceptance criterion 1)", () => {
  const result = runRatchetWithBaseline("below-baseline.lcov", "malformed-branches-baseline.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /'branchesPct' must be a number, got "85"/);
});

test("coverage-ratchet CLI: a malformed linesPct never prints a baseline figure it is not enforcing", () => {
  const result = runRatchetWithBaseline("below-baseline.lcov", "malformed-lines-baseline.json");
  assert.doesNotMatch(result.stdout.toString(), /lines \d/, result.stdout?.toString() + result.stderr?.toString());
  assert.doesNotMatch(result.stdout.toString(), /OK --/, result.stdout?.toString() + result.stderr?.toString());
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

test("coverage-ratchet CLI: baseline record missing BOTH metrics -> no crash, no false block; lines still print a 0.00% baseline but branches print their TIER CUTS, never a misleading 0% floor", () => {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--lcov",
    join(FIXTURES, "above-baseline.lcov"),
    "--baseline",
    join(FIXTURES, "baseline-no-metrics.json"),
  ]);
  const stdout = result.stdout.toString();
  assert.equal(result.status, 0, stdout + result.stderr?.toString());
  // Lines keep a recorded baseline, so an absent one still renders as 0.00% -- unchanged behaviour.
  assert.match(stdout, /lines 95\.00% \(baseline 0\.00%\)/);
  // Branches no longer HAVE a recorded baseline: `branchesPct` was removed from
  // scripts/coverage-baseline.json when the absolute thresholds landed. The old `?? 0` rendering
  // would therefore print `branches 90.00% (baseline 0.00%)` on EVERY real CI run, which reads as
  // "the branch floor is zero" -- the misleading-zero shape this repo keeps paying for. The branch
  // half must report the cuts it is actually judged against instead.
  assert.match(stdout, /branches 90\.00% \(pass 90% \/ block 85%\)/);
  assert.doesNotMatch(
    stdout,
    /branches [\d.]+% \(baseline/,
    "branches must never report a `baseline` -- they are judged against absolute tier cuts, and " +
      "an absent branchesPct rendering as `(baseline 0.00%)` would advertise a 0% floor",
  );
  assert.match(stdout, /OK -- at or above baseline/);
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

// ── W1-T466: absolute branch thresholds (tier one) ──
//
// The gate used to compare branch coverage against a RECORDED branch baseline, and main fell
// below its own floor: every PR inherited `branches 90.27% < baseline 90.40%` and could not go
// green on its own merits. The driver was the DENOMINATOR, not a real regression -- #1739 moved
// BRF +204 / BRH +107 and lines ROSE 2.102pt while the branch RATIO fell. Absolute cuts are
// immune to that: 90% is 90% however many modules the suite loaded.
//
// The tiers, and note that only the LOWEST cut blocks:
//   >= 90  healthy, PASS
//   85-90  improve, PASS (tier two will inject one coverage-improvement task; not yet wired)
//   < 85   remediate, BLOCK
//
// These drive the real CLI against synthesized fixtures, per this file's never-import convention.
// Fixtures are built in a temp dir rather than checked in, keeping W1-T466's declared `files:`
// list to this one path.

/** Build an lcov whose aggregate totals are exactly the requested found/hit counts. */
function writeLcov(
  dir: string,
  name: string,
  totals: { lf: number; lh: number; brf: number; brh: number },
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "SF:src/lib/synthetic.ts",
      `LF:${totals.lf}`,
      `LH:${totals.lh}`,
      `BRF:${totals.brf}`,
      `BRH:${totals.brh}`,
      "end_of_record",
      "",
    ].join("\n"),
  );
  return path;
}

function writeBaseline(dir: string, name: string, body: Record<string, number>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** An lcov whose BRANCH percentage is exactly `pct` and whose lines are comfortably high. */
function lcovAtBranchPct(dir: string, name: string, pct: number): string {
  return writeLcov(dir, name, { lf: 10000, lh: 9900, brf: 10000, brh: Math.round(pct * 100) });
}

function runCli(lcov: string, baseline: string) {
  const r = spawnSync(process.execPath, [SCRIPT, "--lcov", lcov, "--baseline", baseline]);
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test("W1-T466 absolute thresholds: the three tiers classify by BRANCH percentage, and only the sub-85 tier blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-covtier-"));
  try {
    const baseline = writeBaseline(dir, "b.json", {
      linesPct: 95,
      tierPassPct: 90,
      tierBlockPct: 85,
    });

    const healthy = runCli(lcovAtBranchPct(dir, "healthy.lcov", 92), baseline);
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
    assert.match(healthy.stdout, /tier=healthy/);
    assert.match(healthy.stdout, /branches 92\.00% is at or above 90%/);

    const improve = runCli(lcovAtBranchPct(dir, "improve.lcov", 87), baseline);
    assert.equal(
      improve.status,
      0,
      "the 85-90 band PASSES -- it owes a coverage-improvement task, it does not fail the build:\n" +
        improve.stdout +
        improve.stderr,
    );
    assert.match(improve.stdout, /tier=improve/);
    assert.match(improve.stdout, /coverage-improvement task is owed/);

    const remediate = runCli(lcovAtBranchPct(dir, "remediate.lcov", 80), baseline);
    assert.equal(remediate.status, 1, remediate.stdout + remediate.stderr);
    assert.match(remediate.stdout, /tier=remediate/);
    assert.match(remediate.stderr, /BLOCKED/);
    assert.match(remediate.stderr, /branches 80\.00% is below the 85% floor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T466 absolute thresholds: the cuts are INCLUSIVE at the boundary -- exactly 85.00% passes and exactly 90.00% is healthy, so a run landing on the number is never blocked by rounding", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-covedge-"));
  try {
    const baseline = writeBaseline(dir, "b.json", {
      linesPct: 95,
      tierPassPct: 90,
      tierBlockPct: 85,
    });

    const onBlockCut = runCli(lcovAtBranchPct(dir, "at85.lcov", 85), baseline);
    assert.equal(onBlockCut.status, 0, onBlockCut.stdout + onBlockCut.stderr);
    assert.match(onBlockCut.stdout, /tier=improve/);

    const justUnder = runCli(lcovAtBranchPct(dir, "under85.lcov", 84.99), baseline);
    assert.equal(justUnder.status, 1, justUnder.stdout + justUnder.stderr);
    assert.match(justUnder.stdout, /tier=remediate/);

    const onPassCut = runCli(lcovAtBranchPct(dir, "at90.lcov", 90), baseline);
    assert.equal(onPassCut.status, 0, onPassCut.stdout + onPassCut.stderr);
    assert.match(onPassCut.stdout, /tier=healthy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T466 absolute thresholds: main's real reading (branches 90.27%) PASSES, where the delta gate it replaces blocked it against a 90.40% recorded floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-covmain-"));
  try {
    // The exact shape that was blocking every PR on main.
    const lcov = lcovAtBranchPct(dir, "main.lcov", 90.27);

    const oldGate = runCli(lcov, writeBaseline(dir, "old.json", { branchesPct: 90.4 }));
    assert.equal(oldGate.status, 1, "the delta gate must be shown to have really blocked this");
    assert.match(oldGate.stderr, /branches coverage 90\.27% < baseline 90\.40%/);

    const newGate = runCli(
      lcov,
      writeBaseline(dir, "new.json", { linesPct: 95, tierPassPct: 90, tierBlockPct: 85 }),
    );
    assert.equal(newGate.status, 0, newGate.stdout + newGate.stderr);
    assert.match(newGate.stdout, /tier=healthy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T466 absolute thresholds: a line-coverage regression STILL blocks -- replacing the branch floor did not silently delete the line gate, and both reasons are reported together rather than one pre-empting the other", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-covboth-"));
  try {
    const baseline = writeBaseline(dir, "b.json", {
      linesPct: 95,
      tierPassPct: 90,
      tierBlockPct: 85,
    });

    // Lines regress; branches stay healthy. The line ratchet must still fail the build.
    const linesOnly = runCli(
      writeLcov(dir, "lines-bad.lcov", { lf: 10000, lh: 7000, brf: 10000, brh: 9200 }),
      baseline,
    );
    assert.equal(linesOnly.status, 1, linesOnly.stdout + linesOnly.stderr);
    assert.match(linesOnly.stdout, /tier=healthy/);
    assert.match(linesOnly.stderr, /lines coverage 70\.00% < baseline 95\.00%/);

    // BOTH regress. An earlier draft returned as soon as the tier blocked, so the line violation
    // never printed and the author would fix branches, re-push, and only then learn about lines.
    const both = runCli(
      writeLcov(dir, "both-bad.lcov", { lf: 10000, lh: 7000, brf: 10000, brh: 8000 }),
      baseline,
    );
    assert.equal(both.status, 1, both.stdout + both.stderr);
    assert.match(both.stderr, /branches 80\.00% is below the 85% floor/);
    assert.match(
      both.stderr,
      /lines coverage 70\.00% < baseline 95\.00%/,
      "the branch tier must not suppress the line violation -- both reasons report in one run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T466 absolute thresholds: the SHIPPED scripts/coverage-baseline.json carries both tier cuts, no longer carries a branchesPct delta floor, and RETAINS its linesPct floor", async () => {
  const shipped = JSON.parse(
    await readFile(join(REPO_ROOT, "scripts", "coverage-baseline.json"), "utf8"),
  );
  assert.equal(shipped.tierPassPct, 90);
  assert.equal(shipped.tierBlockPct, 85);
  assert.equal(
    Object.hasOwn(shipped, "branchesPct"),
    false,
    "a recorded branch baseline would re-arm the delta comparison this task removed -- the branch " +
      "ratio moves with the DENOMINATOR, which is how main fell below its own floor",
  );
  assert.equal(
    typeof shipped.linesPct,
    "number",
    "the line floor must survive -- this task replaced the BRANCH gate, it did not remove coverage gating",
  );
});
