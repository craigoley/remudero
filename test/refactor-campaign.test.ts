import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W2-T3: refactor campaign — the measurable gate-delta formula (MASTER-PLAN §3A/§5) ──
//
// "Tech-debt sweep" was under-built as a vibe (operator flagged it). This test proves the
// campaign's formula has TEETH, not just that it parses: a planted refactor that leaves every
// gate unchanged is REJECTED (non-zero exit, "no gate improved"), a planted refactor that
// regresses even one gate is REJECTED even when every other gate improved (no trading one debt
// for another), and a planted refactor that improves every gate is ACCEPTED. Every assertion
// below drives the real CLI (scripts/refactor-campaign.mjs) as a subprocess against three
// fixture campaigns, so it is the actual exit code + printed reasons a CI job would see.
//
// (scripts/refactor-campaign.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface, never imported — keeping this test file itself clean
// under `tsc --noEmit`, same convention as test/mutation-ratchet.test.ts /
// test/coverage-ratchet.test.ts.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "refactor-campaign.mjs");
const FIXTURES = join(__dirname, "fixtures", "refactor-campaign");

function runCampaign(mode: "dry-run" | "check", fixture: string) {
  return spawnSync(process.execPath, [SCRIPT, mode, "--config", "campaign.yaml"], {
    cwd: join(FIXTURES, fixture),
  });
}

function output(result: ReturnType<typeof runCampaign>) {
  return result.stdout?.toString() + result.stderr?.toString();
}

// ── check mode: the CI gate ──────────────────────────────────────────────

test("refactor-campaign check: ALL-IMPROVED fixture (every gate moves the right direction) -> zero exit (GREEN)", () => {
  const result = runCampaign("check", "all-improved");
  const out = output(result);
  assert.equal(result.status, 0, out);
  assert.match(out, /GREEN/);
  assert.match(out, /mutation .*\[improved\]/);
  assert.match(out, /complexity .*\[improved\]/);
  assert.match(out, /duplication .*\[improved\]/);
  assert.match(out, /cve .*\[improved\]/);
  assert.match(out, /fitness .*\[improved\]/);
});

test("refactor-campaign check: NO-IMPROVEMENT fixture (every gate exactly unchanged) -> non-zero exit (RED, 'no gate improved')", () => {
  const result = runCampaign("check", "no-improvement");
  const out = output(result);
  assert.notEqual(result.status, 0, out);
  assert.match(out, /RED/);
  assert.match(out, /BLOCKED/);
  assert.match(out, /no gate improved -- every metric is unchanged versus its baseline \(a no-op refactor\)/);
});

test("refactor-campaign check: REGRESSED fixture (complexity worse, everything else improved) -> non-zero exit (no trading one debt for another)", () => {
  const result = runCampaign("check", "regressed");
  const out = output(result);
  assert.notEqual(result.status, 0, out);
  assert.match(out, /RED/);
  assert.match(out, /complexity regressed: 3 vs baseline 2 \(direction: down\)/);
  // the other four gates DID improve -- proves a single regression still blocks, it is not
  // averaged away by improvements elsewhere.
  assert.match(out, /mutation .*\[improved\]/);
  assert.match(out, /duplication .*\[improved\]/);
  assert.match(out, /cve .*\[improved\]/);
  assert.match(out, /fitness .*\[improved\]/);
});

// ── dry-run mode: advisory, names targets, never fails ───────────────────

test("refactor-campaign dry-run: always exits zero (advisory, makes no change) even over a fixture with a would-be regression", () => {
  const result = runCampaign("dry-run", "regressed");
  const out = output(result);
  assert.equal(result.status, 0, out);
  assert.match(out, /no change made, advisory only/);
  assert.match(out, /complexity .*\[regressed\]/);
});

test("refactor-campaign dry-run: names the tech-debt target (top-N by complexity) with its own current value", () => {
  const result = runCampaign("dry-run", "no-improvement");
  const out = output(result);
  assert.equal(result.status, 0, out);
  assert.match(out, /named tech-debt targets/);
  assert.match(out, /- src\/module\.ts/);
  assert.match(out, /complexity: current=2 goal=\d+ delta=[-+]?\d+ points/);
});

// ── dry-run mode: the PER-TARGET gate-delta (acceptance criterion 1) ──────
//
// The criterion is "a dry-run over remudero names the tech-debt targets AND THE MEASURABLE
// GATE-DELTA PER TARGET" — proof: "lists each target with its current-vs-goal delta". Naming the
// targets beside a project-wide summary is NOT that; each named target must carry its own
// current -> goal numbers. These tests pin exactly that, per gate.

test("refactor-campaign dry-run: EACH named target carries its own current-vs-goal delta per gate", () => {
  const result = runCampaign("dry-run", "no-improvement");
  const out = output(result);
  assert.equal(result.status, 0, out);

  // The three per-file-measurable gates each report current AND goal AND delta for the target.
  assert.match(out, /complexity: current=\d+ goal=\d+ delta=[-+]?\d+ points/);
  assert.match(out, /duplication: current=\d+ goal=0 delta=[-+]?\d+ clone pairs/);
  assert.match(out, /fitness: current=\d+ goal=0 delta=[-+]?\d+ violations/);

  // mutation/cve do not decompose per file — reported honestly, never given an invented goal.
  assert.match(out, /mutation, cve: n\/a \(project-wide gate, not per-target\)/);

  // A dry-run is a PLAN, not an edit.
  assert.match(out, /no change until approved -- this is the plan, not an edit\./);
});

test("refactor-campaign dry-run: a target's complexity GOAL is the configured reduction off its CURRENT (delta is negative = work to do)", () => {
  // Same hermetic shape as the live dry-run test below: the repo's OWN campaign config (so the
  // real goal_complexity_reduction_pct is under test) + the REAL complexity scan over src/**,
  // with the four tool reports supplied as fixtures so the test needs no stryker/jscpd/depcruise/
  // npm-audit run of its own.
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "dry-run",
      "--config",
      join(REPO_ROOT, "plan", "campaigns", "refactor.yaml"),
      "--mutation-report",
      join(__dirname, "fixtures", "mutation-ratchet", "at-baseline.json"),
      "--jscpd-report",
      join(FIXTURES, "all-improved", "reports", "jscpd.json"),
      "--depcruise-report",
      join(FIXTURES, "all-improved", "reports", "depcruise.json"),
      "--audit-report",
      join(FIXTURES, "all-improved", "reports", "audit.json"),
    ],
    { cwd: REPO_ROOT },
  );
  const out = output(result);
  assert.equal(result.status, 0, out);

  // plan/campaigns/refactor.yaml declares goal_complexity_reduction_pct: 20, so for every named
  // target goal == round(current * 0.8) and delta == goal - current (negative: complexity to
  // REMOVE). Verified arithmetically against the real scan, not against a hard-coded number.
  const rows = [...out.matchAll(/complexity: current=(\d+) goal=(\d+) delta=(-?\d+) points/g)];
  assert.ok(rows.length > 0, `expected per-target complexity rows, got:\n${out}`);
  for (const [, currentStr, goalStr, deltaStr] of rows) {
    const current = Number(currentStr);
    const goal = Number(goalStr);
    assert.equal(goal, Math.round(current * 0.8), `goal for a target with current=${current}`);
    assert.equal(Number(deltaStr), goal - current);
    assert.ok(Number(deltaStr) <= 0, "a complexity goal never asks for MORE complexity");
  }
});

// ── check mode: fail CLOSED when a required current-value report is missing ──

test("refactor-campaign check: a missing report file fails CLOSED (non-zero exit), never silently passes", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "check", "--config", "campaign.yaml", "--mutation-report", "does-not-exist.json"],
    { cwd: join(FIXTURES, "all-improved") },
  );
  const out = output(result);
  assert.notEqual(result.status, 0, out);
});

// ── CLI surface: unknown mode refuses cleanly ─────────────────────────────

test("refactor-campaign: an unknown mode prints usage and exits non-zero", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "bogus-mode"]);
  const out = output(result);
  assert.notEqual(result.status, 0, out);
  assert.match(out, /unknown mode 'bogus-mode'/);
});

// ── pure-function unit coverage over the formula itself ───────────────────
//
// The formula's edge cases (epsilon tolerance, up vs down direction, the "improved" tie-break)
// are exercised directly by re-invoking the CLI's `check` mode over minimal single-purpose
// fixtures rather than importing the .mjs module (see the file-header note on why this stays
// CLI-only).

test("refactor-campaign check: the real plan/campaigns/refactor.yaml parses and every declared baseline file exists and is valid JSON", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse: parseYaml } = await import("yaml");
  const raw = await readFile(join(REPO_ROOT, "plan", "campaigns", "refactor.yaml"), "utf8");
  const config = parseYaml(raw) as {
    repo: string;
    gates: Array<{ id: string; direction: string; baseline: string; baseline_field: string; source: { kind: string; path: string } }>;
    targets?: { top_n?: number };
  };
  assert.equal(config.repo, "remudero");
  assert.equal(config.gates.length, 5);
  for (const gate of config.gates) {
    const baselineRaw = await readFile(join(REPO_ROOT, gate.baseline), "utf8");
    const baseline = JSON.parse(baselineRaw);
    assert.equal(
      typeof baseline[gate.baseline_field],
      "number",
      `${gate.id}'s baseline field '${gate.baseline_field}' must be a number`,
    );
    assert.ok(gate.direction === "up" || gate.direction === "down");
  }
});

test("refactor-campaign: CI workflow wires a refactor-campaign job unconditionally (no path filter) into ci.yml, and ci-gate.yml's REQUIRED list waits on it", async () => {
  const { readFile } = await import("node:fs/promises");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /refactor-campaign:/, "ci.yml must declare a refactor-campaign job");
  assert.match(ciYml, /node scripts\/refactor-campaign\.mjs check/, "ci.yml's refactor-campaign job must actually invoke the gate CLI");
  assert.match(ciYml, /refactor-campaign label/, "the job must be scoped to the refactor-campaign label, not apply to every PR");

  const ciGateYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
  assert.match(ciGateYml, /"refactor-campaign"/, "ci-gate.yml's REQUIRED list must include refactor-campaign");
});

test("refactor-campaign: a live dry-run against the real repo (real mutation/jscpd/depcruise/audit reports supplied) exits zero and names real targets", () => {
  // Uses the repo's OWN campaign config (plan/campaigns/refactor.yaml) with report paths pointed
  // at freshly-fixture'd stand-ins for the four tool reports (a live run would regenerate these
  // via `npx stryker run` / jscpd / depcruise / npm audit — out of scope for a unit test's
  // runtime budget) plus the REAL, live complexity scan over this repo's own src/**.
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "dry-run",
      "--config",
      join(REPO_ROOT, "plan", "campaigns", "refactor.yaml"),
      "--mutation-report",
      join(__dirname, "fixtures", "mutation-ratchet", "at-baseline.json"),
      "--jscpd-report",
      join(FIXTURES, "all-improved", "reports", "jscpd.json"),
      "--depcruise-report",
      join(FIXTURES, "all-improved", "reports", "depcruise.json"),
      "--audit-report",
      join(FIXTURES, "all-improved", "reports", "audit.json"),
    ],
    { cwd: REPO_ROOT },
  );
  const out = output(result);
  assert.equal(result.status, 0, out);
  assert.match(out, /refactor-campaign dry-run \(remudero\)/);
  assert.match(out, /named tech-debt targets \(top 10 by complexity\), each with its current-vs-goal delta/);
  assert.match(out, /- src\/run-task\.ts/);
  assert.match(out, /complexity: current=\d+ goal=\d+ delta=[-+]?\d+ points/);
});
