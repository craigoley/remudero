import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
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
