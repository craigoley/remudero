import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T97: jscpd duplication gate (MASTER-PLAN §5 TIER 2, quality gate 3/4) ──
//
// A duplication gate must BLOCK a planted duplicate above threshold, proven by a falsifier
// fixture, not merely be wired. Unlike the coverage/mutation ratchets (W1-T25/W1-T96), jscpd
// needs no custom wrapper script: its own `--threshold <PCT>` CLI flag natively exits non-zero
// when the duplicated-lines percentage exceeds the given ceiling, and exits zero otherwise (see
// node_modules/jscpd/README.md's Options table). This test drives jscpd's real CLI entry point
// (node_modules/jscpd/run-jscpd.js -- the file its own package.json `bin` field points at) as a
// subprocess against two planted fixture pairs, so the assertion is on the actual exit code a CI
// job would see:
//
//   - test/fixtures/jscpd/above-threshold/{alpha,sibling}.ts -- alpha.ts's function body is
//     copy-pasted verbatim into sibling.ts under a different name. Against a threshold low
//     enough that real src/** duplication (1.11%, measured 2026-07-18) stays under it, this
//     fixture's ~38% duplicated-lines figure must be REJECTED.
//   - test/fixtures/jscpd/below-threshold/{alpha,sibling}.ts -- no shared block anywhere in the
//     pair. This must be ACCEPTED at the same threshold.
//
// (jscpd's CLI entry is a plain .js file outside tsconfig's `include`, so it is exercised here
// only via subprocess, never imported.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const JSCPD_BIN = join(REPO_ROOT, "node_modules", "jscpd", "run-jscpd.js");
const FIXTURES = join(__dirname, "fixtures", "jscpd");

// Threshold used by every test below: strictly above the real src/** baseline (1.11%) so this
// gate's OWN fixture assertions never drift if src/** duplication creeps up slightly, but well
// below the ~38% the above-threshold fixture produces -- there is no ambiguity about which side
// of the line each fixture falls on.
const TEST_THRESHOLD = "5";

function runJscpd(fixtureDir: string) {
  return spawnSync(process.execPath, [
    JSCPD_BIN,
    join(FIXTURES, fixtureDir),
    "--format",
    "typescript",
    "--threshold",
    TEST_THRESHOLD,
    "--reporters",
    "console",
    "--no-colors",
  ]);
}

test("jscpd-gate CLI: ABOVE-threshold fixture (verbatim copy-pasted function) -> non-zero exit (the gate BLOCKS)", () => {
  const result = runJscpd("above-threshold");
  const output = result.stdout?.toString() + result.stderr?.toString();
  assert.notEqual(result.status, 0, output);
  assert.match(output, /found too many duplicates/i);
  assert.match(output, /over threshold \(5\.0%\)/);
});

test("jscpd-gate CLI: BELOW-threshold fixture (no shared block) -> zero exit (the gate ACCEPTS)", () => {
  const result = runJscpd("below-threshold");
  const output = result.stdout?.toString() + result.stderr?.toString();
  assert.equal(result.status, 0, output);
  assert.match(output, /No duplicates found/i);
});

test("jscpd-gate: the real .jscpd.json config (scoped to src/**) is present, parses as valid JSON, and declares a threshold ceiling", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(join(REPO_ROOT, ".jscpd.json"), "utf8");
  const config = JSON.parse(raw);
  assert.equal(typeof config.threshold, "number");
  assert.ok(config.threshold > 0, "threshold must be a positive ceiling, not 0 (which would block on any pre-existing duplication)");
  assert.ok(Array.isArray(config.format) && config.format.includes("typescript"));
});

test("jscpd-gate: the real repo config, run against actual src/**, is currently at or under its own threshold (the checked-in baseline is not already red)", () => {
  const result = spawnSync(process.execPath, [
    JSCPD_BIN,
    "src",
    "--config",
    ".jscpd.json",
    "--no-colors",
  ], { cwd: REPO_ROOT });
  const output = result.stdout?.toString() + result.stderr?.toString();
  assert.equal(result.status, 0, output);
});

test("jscpd-gate: CI workflow wires a jscpd job unconditionally (no path filter) into ci.yml, and ci-gate.yml's REQUIRED list waits on it", async () => {
  const { readFile } = await import("node:fs/promises");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /jscpd-gate:/, "ci.yml must declare a jscpd-gate job");
  assert.match(ciYml, /npm run --silent jscpd/, "ci.yml's jscpd-gate job must actually invoke the jscpd CLI");

  const ciGateYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
  assert.match(ciGateYml, /"jscpd-gate"/, "ci-gate.yml's REQUIRED list must include jscpd-gate");
});
