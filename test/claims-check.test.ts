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

// ── W1-T2640: falsifier fixture for plan/claims.yaml's `plan-format-covers-shards` claim ────────
//
// plan/claims.yaml's new claim pins MASTER-PLAN.md §2 documenting the sharded filing home (a NEW
// task's plan/tasks.d/<id>-<kebab-slug>.yaml shard), the monolith-append refusal, and the
// loadPlan merge/duplicate-id rule. This fixture mirrors that assertion's exact shape against two
// synthetic §2 fragments -- one carrying the amended wording, one carrying only the pre-amendment
// (monolith-only) wording -- proving the assertion actually FAILS on the wording it is meant to
// catch, not merely that plan/claims.yaml parses.

test("claims-check CLI: plan-format-covers-shards falsifier fixture -- the amended §2 wording PASSES, the pre-amendment (monolith-only) wording FAILS and is named, and a missing input fixture reports COULD-NOT-RUN", () => {
  const result = runCli("plan-format-covers-shards.yaml");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /PASS {2}fixture-plan-format-amended/);
  assert.match(output, /FAIL {2}fixture-plan-format-pre-amendment-planted-lie/);
  assert.match(output, /THE PLAN IS LYING ABOUT THE SYSTEM/);
  assert.match(output, /\[fixture-plan-format-pre-amendment-planted-lie\]/);
  assert.match(output, /COULD-NOT-RUN {2}fixture-plan-format-could-not-run/);
  assert.doesNotMatch(output, /PASS {2}fixture-plan-format-could-not-run/);
  assert.doesNotMatch(output, /FAIL {2}fixture-plan-format-could-not-run/);
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
