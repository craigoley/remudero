import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { FAST_GATE_STEPS, runPreflightFast } from "../src/lib/ci-parity.js";
import { preflightCommand } from "../src/run-task.js";

// ── W1-T373: `rmd preflight --fast` — the deterministic npm-script gates, nothing else ──────
//
// `--ci-parity`'s `ci` job entry shells `npm run test:ci`, the full test/**/*.test.ts glob, so
// the only way to reach a two-second check like `claims` was to run everything else too — a CI
// round-trip instead of the ~4.3 seconds the curated gates actually cost (measured at 81af5af).
// This suite proves `--fast`: it runs ONLY FAST_GATE_STEPS's curated npm-script gates, reports
// each independently, and — the property that makes it a mode a worker can run habitually
// instead of a slow mode wearing a fast name — it never shells the test suite.

const REPO_ROOT = process.cwd();

const REAL_PACKAGE_JSON = JSON.stringify({
  scripts: Object.fromEntries(FAST_GATE_STEPS.map((s) => [s.script, "echo stub"])),
});

/** Records every spawn call and answers from a lookup table keyed by a substring of
 *  `[file, ...args].join(" ")`, falling back to a clean `{status: 0}` for anything unlisted —
 *  duplicated locally per test/preflight-ci-parity.test.ts's own file-scoping convention. */
function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string } }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

// ── acceptance 1: the fast mode runs the curated npm-script gates and reports each ──────────
// step's own pass/fail ───────────────────────────────────────────────────────────────────────

test("FAST_GATE_STEPS: the curated list is exactly the seven deterministic npm-script gates the task names plus the four W1-T2478 census entries — the required core, the same-class rest, and the census class", () => {
  const scripts = FAST_GATE_STEPS.map((s) => s.script).sort();
  assert.deepEqual(scripts, [
    "api-client:check",
    "census:bound-kind",
    "census:catch-erasure",
    "census:negative-reachability",
    "census:no-shallowing",
    "claims",
    "cli-reference:check",
    "depcruise",
    "jscpd",
    "learnings-budget-ratchet",
    "no-hand-rolled-fetch:check",
  ]);
});

test("FAST_GATE_STEPS: every entry states WHICH of the two curation reasons admits it (required-core or same-class)", () => {
  for (const step of FAST_GATE_STEPS) {
    assert.match(step.reason, /^required-core|^same-class/, `'${step.job}' names neither curation reason: ${step.reason}`);
  }
  const requiredCore = FAST_GATE_STEPS.filter((s) => s.reason.startsWith("required-core")).map((s) => s.job);
  assert.deepEqual(requiredCore.sort(), ["claims", "cli-reference"], "the required core is exactly cli-reference and claims, both demonstrated on #1352");
});

test("runPreflightFast: runs `npm run --silent <script>` for every FAST_GATE_STEPS entry, and nothing else", () => {
  const { spawn, calls } = recordingSpawn();
  runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });

  assert.equal(calls.length, FAST_GATE_STEPS.length, "exactly one spawn per curated step, no extras");
  for (const { script } of FAST_GATE_STEPS) {
    const call = calls.find((c) => c.file === "npm" && c.args.join(" ") === `run --silent ${script}`);
    assert.ok(call, `expected an \`npm run --silent ${script}\` call`);
  }
});

test("runPreflightFast: every step's detail names itself in both directions (PASS/FAIL), never legible only as a missing success line", () => {
  const { spawn } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });
  assert.equal(result.steps.length, FAST_GATE_STEPS.length);
  for (const step of result.steps) {
    assert.match(step.detail, new RegExp(`^${step.name}: (PASS|FAIL|SCRIPT MISSING)`), `step '${step.name}' detail does not name itself: ${step.detail}`);
  }
});

test("runPreflightFast: one step's failure never blocks a later step from running and reporting — same independent-step discipline as --ci-parity", () => {
  const { spawn } = recordingSpawn({
    "cli-reference:check": { status: 1, stderr: "docs/cli-reference.md is stale" },
    claims: { status: 1, stderr: "missing operator-guide.md row" },
  });
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });

  const cliRef = result.steps.find((s) => s.name === "cli-reference")!;
  const claims = result.steps.find((s) => s.name === "claims")!;
  assert.equal(cliRef.ok, false);
  assert.equal(claims.ok, false);
  // every OTHER step still ran and reported despite the two earlier failures
  assert.ok(result.steps.some((s) => s.name === "depcruise" && s.ok));
  assert.ok(result.steps.some((s) => s.name === "jscpd" && s.ok));
  assert.equal(result.ok, false, "the overall verdict is red — but only after every step reported");
});

// ── acceptance 2: the fast mode never shells the test suite ─────────────────────────────────

test("runPreflightFast: never invokes `npm run test:ci`, `npm test`, or a direct `node --test` — no path to the full suite exists in this mode", () => {
  const { spawn, calls } = recordingSpawn();
  runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });

  for (const call of calls) {
    const key = [call.file, ...call.args].join(" ");
    assert.doesNotMatch(key, /test:ci/, `runPreflightFast must never shell test:ci, saw: ${key}`);
    assert.doesNotMatch(key, /\bnode\b.*--test\b/, `runPreflightFast must never spawn node --test directly, saw: ${key}`);
  }
});

test("runPreflightFast: FAST_GATE_STEPS itself names no test:ci/test-suite script — the refusal (design iii) is enforced in the data, not just at the call site", () => {
  for (const step of FAST_GATE_STEPS) {
    assert.doesNotMatch(step.script, /^test/, `'${step.job}' names a test-suite-shaped script: ${step.script}`);
  }
});

test("preflightCommand: --fast ADDS the fast-mode steps after the three hand-route steps, and never prints or runs anything ci-parity- or test:ci-shaped", async () => {
  // runPreflightFast reads the REPO's real package.json (not through `spawn`) — this repo
  // already declares every FAST_GATE_STEPS script (confirmed by package.json itself), so no
  // fixture is needed here; only the individual gate commands are stubbed.
  const spawn: PreflightSpawn = (file, args) => {
    const key = [file, ...args].join(" ");
    if (key.includes("commitlint")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("tsc")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("git log")) return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
    if (key.includes("run --silent claims")) return { status: 1, stdout: "", stderr: "docs row missing" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand(["--fast"], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1, "a failing fast-mode step must fail the overall command even when the three hand-route steps are clean");
  assert.ok(lines.some((l) => l.includes("typecheck: PASS")), "the hand-route steps still print");
  assert.ok(lines.some((l) => l.includes("claims: FAIL")), "the fast-mode steps print too, under --fast");
  assert.equal(lines.some((l) => l.includes("ci-parity")), false, "no --ci-parity output when only --fast was passed");
});

test("preflightCommand: WITHOUT --fast, no fast-mode step runs or prints — the shipped hand route (and --ci-parity mode) is untouched", async () => {
  const spawn: PreflightSpawn = () => ({ status: 0, stdout: "\0feat(x): fine\n", stderr: "" });
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand([], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 0);
  for (const { job } of FAST_GATE_STEPS) {
    assert.equal(
      lines.some((l) => l.startsWith(`${job}:`)),
      false,
      `'${job}' must not print without --fast`,
    );
  }
});

// ── acceptance 3: a step whose script is missing reports itself DISTINCTLY from a step that ──
// ran and failed ─────────────────────────────────────────────────────────────────────────────

test("runPreflightFast: a script absent from package.json's \"scripts\" is reported as SCRIPT MISSING, never as FAIL, and never spawns npm for it", () => {
  const packageJsonMissingClaims = JSON.stringify({
    scripts: Object.fromEntries(FAST_GATE_STEPS.filter((s) => s.script !== "claims").map((s) => [s.script, "echo stub"])),
  });
  const { spawn, calls } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: packageJsonMissingClaims });

  const claimsStep = result.steps.find((s) => s.name === "claims")!;
  assert.equal(claimsStep.ok, false, "a missing script can never run, so it can never read as a pass");
  assert.match(claimsStep.detail, /SCRIPT MISSING/, "a missing script must be named distinctly, not as an ordinary FAIL");
  assert.doesNotMatch(claimsStep.detail, /claims: FAIL/, "must not be indistinguishable from a step that ran and failed");
  assert.equal(result.ok, false);

  const npmClaimsCall = calls.find((c) => c.file === "npm" && c.args.includes("claims"));
  assert.equal(npmClaimsCall, undefined, "a step reported as SCRIPT MISSING must never actually spawn npm for it — there is nothing to run");

  // every other step still ran and reported.
  assert.ok(result.steps.some((s) => s.name === "depcruise" && s.ok));
});

test("runPreflightFast: a script that IS defined and genuinely fails is reported as FAIL, never as SCRIPT MISSING — the two outcomes stay distinguishable in both directions", () => {
  const { spawn } = recordingSpawn({ claims: { status: 1, stderr: "docs row missing" } });
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: REAL_PACKAGE_JSON });

  const claimsStep = result.steps.find((s) => s.name === "claims")!;
  assert.equal(claimsStep.ok, false);
  assert.match(claimsStep.detail, /claims: FAIL/);
  assert.doesNotMatch(claimsStep.detail, /SCRIPT MISSING/);
});
