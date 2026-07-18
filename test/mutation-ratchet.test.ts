import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T96: mutation-testing ratchet gate (MASTER-PLAN §5 TIER 2, quality gate 2/4) ──
//
// A green test suite that kills no mutants is theater -- the gate must be proven ACTIVE, not
// merely present: a below-baseline mutation score is REJECTED (non-zero exit), an at/above-
// baseline score is ACCEPTED (zero exit). Every test below drives the actual CLI
// (scripts/mutation-ratchet.mjs) as a subprocess against a planted fixture report, so the
// assertion is on the real exit code a CI job would see -- the falsifier fixture proves the gate
// is ACTIVE, not merely present.
//
// (scripts/mutation-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface, never imported -- keeping this test file itself clean
// under `tsc --noEmit`.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
const BASELINE = join(FIXTURES, "baseline.json");

function runRatchet(reportFixture: string, baseline: string = BASELINE) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--report",
    join(FIXTURES, reportFixture),
    "--baseline",
    baseline,
  ]);
}

test("mutation-ratchet CLI: BELOW-baseline fixture -> non-zero exit (the gate BLOCKS)", () => {
  const result = runRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /BLOCKED/);
  assert.match(result.stderr.toString(), /mutation score 20\.00% < baseline 80\.00%/);
});

test("mutation-ratchet CLI: AT-baseline fixture (exact match) -> zero exit (the gate ACCEPTS)", () => {
  const result = runRatchet("at-baseline.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("mutation-ratchet CLI: ABOVE-baseline fixture -> zero exit (the gate ACCEPTS)", () => {
  const result = runRatchet("above-baseline.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 90\.00%/);
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("mutation-ratchet CLI: report with NO valid mutants (all Ignored/CompileError) -> scorePct falls back to 100% (validTotal === 0 edge case)", () => {
  const result = runRatchet("no-valid-mutants.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 100\.00%/);
});

test("mutation-ratchet CLI: report with NO `files` key at all -> report.files ?? {} fallback, scorePct 100%", () => {
  const result = runRatchet("no-files-key.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 100\.00%/);
});

test("mutation-ratchet CLI: file record with NO `mutants` key -> mutants ?? [] fallback, scorePct 100%", () => {
  const result = runRatchet("file-missing-mutants.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 100\.00%/);
});

test("mutation-ratchet CLI: baseline record missing scorePct -> no crash, no false block, prints 0.00% baseline", () => {
  const result = runRatchet("above-baseline.json", join(FIXTURES, "baseline-no-metrics.json"));
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /baseline 0\.00%/);
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("mutation-ratchet module: importing (not spawning as the entry script) does not re-invoke main() -- process.argv[1] is undefined when eval'd", () => {
  // Drives the `import.meta.url === pathToFileURL(process.argv[1] ?? '').href` direct-execution
  // guard down its OTHER path: when this module is loaded via `node --input-type=module -e`
  // (dynamic import, no script-file argv[1]), process.argv[1] is undefined, so the `?? ''`
  // fallback is exercised and the guard correctly evaluates to false -- main() must not run (it
  // would otherwise crash trying to read a nonexistent default report/baseline path).
  const scriptUrl = pathToFileURL(SCRIPT).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(scriptUrl)}); console.log("imported-without-main-invocation");`,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /imported-without-main-invocation/);
});
