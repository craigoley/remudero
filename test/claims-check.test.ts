import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T29: PLAN-CLAIMS gate (MASTER-PLAN §12A) ──────────────────────────────
//
// Plan prose is unverifiable; a FALSIFIABLE claim with a command that must exit 0 is not. This
// suite proves the gate is ACTIVE, not merely present: a claims file with a deliberately-broken
// assertion turns the gate RED and NAMES the false claim (id + prose) in its output; a claims
// file where every assertion holds turns it GREEN. It also proves the real plan/claims.yaml is
// currently green (seeded with the six checkable claims) and that the CI wiring exists.
//
// (scripts/claims-check.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface, never imported -- keeping this test file itself
// clean under `tsc --noEmit`, same convention as coverage-ratchet.test.ts / jscpd-gate.test.ts.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "claims-check.mjs");
const FIXTURES = join(__dirname, "fixtures", "claims-check");

function runCli(file: string) {
  return spawnSync(process.execPath, [SCRIPT, "--file", join(FIXTURES, file)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("claims-check CLI: ALL-TRUE fixture -> zero exit, every claim printed PASS (the gate ACCEPTS)", () => {
  const result = runCli("all-true.yaml");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /PASS {2}fixture-true-one/);
  assert.match(output, /PASS {2}fixture-true-two/);
  assert.match(output, /OK -- all 2 claim\(s\) hold/);
});

test("claims-check CLI: ONE-FALSE fixture (a deliberately-broken claim) -> non-zero exit, NAMES the false claim id + prose, and does not hide the true claim's PASS (the gate BLOCKS and is legible)", () => {
  const result = runCli("one-false.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /PASS {2}fixture-true\b/);
  assert.match(output, /FAIL {2}fixture-false-planted-lie/);
  assert.match(output, /THE PLAN IS LYING ABOUT THE SYSTEM/);
  assert.match(output, /\[fixture-false-planted-lie\]/);
  assert.match(output, /deliberately false claim/);
  assert.match(output, /assertion:\s+test -e \/definitely-not-a-real-path-xyz/);
});

test("claims-check CLI: EMPTY claims file -> non-zero exit (an empty gate proves nothing, never a silent pass)", () => {
  const result = runCli("empty.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /ZERO claims/);
});

test("claims-check CLI: MISSING-FIELD claims file -> non-zero exit, names the missing field", () => {
  const result = runCli("missing-field.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /missing required string field "assertion"/);
});

test("claims-check CLI: an unreadable --file path -> non-zero exit (no crash-with-stack-only, the runner reports and exits cleanly)", () => {
  const result = runCli("does-not-exist.yaml");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

// ── The real plan/claims.yaml: seeded, green, and wired into CI ─────────────

test("claims-check: the real plan/claims.yaml is seeded with (at least) the six W1-T29 checkable claims and every assertion currently holds", async () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  const raw = await readFile(join(REPO_ROOT, "plan", "claims.yaml"), "utf8");
  const claims = parseYaml(raw) as Array<{ id: string }>;
  assert.ok(Array.isArray(claims) && claims.length >= 6, `expected >= 6 seeded claims, found ${claims?.length}`);
  const ids = new Set(claims.map((c) => c.id));
  for (const expected of [
    "worker-no-mcp-config",
    "worker-env-strips-anthropic",
    "tasks-yaml-never-machine-written",
    "default-budget-usd-100",
    "containment-fails-closed",
    "merge-gate-required-contexts",
  ]) {
    assert.ok(ids.has(expected), `plan/claims.yaml is missing seeded claim "${expected}"`);
  }
});

test("claims-check: CI wires a claims job unconditionally into ci.yml, and ci-gate.yml's REQUIRED list waits on it", async () => {
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /^\s*claims:\s*$/m, "ci.yml must declare a claims job");
  assert.match(ciYml, /npm run --silent claims/, "ci.yml's claims job must actually invoke the claims-check runner");

  const ciGateYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
  assert.match(ciGateYml, /"claims"/, "ci-gate.yml's REQUIRED list must include claims");
});
