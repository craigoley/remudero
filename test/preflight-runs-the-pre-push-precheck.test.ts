import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { FAST_GATE_STEPS, runPreflightFast } from "../src/lib/ci-parity.js";

// ── W1-T6435: the fast gate runs the census precheck the pre-push hook runs ─────────────────
//
// hooks/pre-push runs `node scripts/census-precheck.mjs --base origin/main`, but nothing installs
// that hook in an operator or agent clone, so a hand-built PR passed the local fast gate and
// reddened a census in CI (#10108). Every spawn here is injected: nothing runs the precheck.

const REPO_ROOT = process.cwd();
const PRECHECK_ARGS = ["scripts/census-precheck.mjs", "--base", "origin/main"];

const PACKAGE_JSON = JSON.stringify({
  scripts: Object.fromEntries(FAST_GATE_STEPS.map((s) => [s.script, "echo stub"])),
});

function run(precheck: { status: number | null; stdout?: string; stderr?: string }) {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    if (args.includes("scripts/census-precheck.mjs")) {
      return { status: precheck.status, stdout: precheck.stdout ?? "", stderr: precheck.stderr ?? "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: PACKAGE_JSON });
  const step = result.steps.find((s) => s.name === "census-precheck");
  return { calls, result, step };
}

test("W1-T6435: preflight runs the census precheck the pre-push hook runs", () => {
  assert.ok(
    FAST_GATE_STEPS.some((s) => s.job === "census-precheck"),
    "FAST_GATE_STEPS must carry a census-precheck step",
  );
  const { calls, step } = run({ status: 0 });
  const precheckCalls = calls.filter((c) => c.args.includes("scripts/census-precheck.mjs"));
  assert.equal(precheckCalls.length, 1, "exactly one precheck spawn");
  assert.equal(precheckCalls[0].file, process.execPath, "run with node, as the hook does");
  assert.deepEqual(precheckCalls[0].args, PRECHECK_ARGS, "the hook's own arguments, byte for byte");
  assert.equal(precheckCalls[0].cwd, REPO_ROOT);
  assert.ok(step, "the step reports itself by name");
  assert.equal(step.ok, true);
  assert.match(step.detail, /^census-precheck: PASS/);
});

test("W1-T6435: a precheck violation refuses the fast gate and carries the precheck's own words", () => {
  const { step, result } = run({ status: 1, stderr: "census-precheck: host-capability-fixtures: UNDECLARED fixture" });
  assert.ok(step);
  assert.equal(step.ok, false);
  assert.match(step.detail, /^census-precheck: FAIL/);
  assert.match(step.detail, /UNDECLARED fixture/);
  assert.equal(result.ok, false);
});

test("W1-T6435: a precheck that could not measure is named UNMEASURED, never a silent pass", () => {
  const { step } = run({ status: 2, stderr: "census-precheck: merge base unreadable" });
  assert.ok(step);
  assert.equal(step.ok, true, "not blocking, as the hook does not block on exit 2");
  assert.match(step.detail, /UNMEASURED/);
  assert.match(step.detail, /merge base unreadable/);
});

test("W1-T6435: a precheck killed by a signal is a failure, not a pass", () => {
  const { step } = run({ status: null });
  assert.ok(step);
  assert.equal(step.ok, false);
});
