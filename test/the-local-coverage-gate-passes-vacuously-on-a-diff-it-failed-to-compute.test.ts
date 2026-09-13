/**
 * W1-T3013 — THE LOCAL COVERAGE GATE PASSED VACUOUSLY ON A DIFF IT FAILED TO COMPUTE.
 *
 * Two behaviours, each correct alone, composed into a gate that could not fail:
 *   (1) `mergeBaseDiffText` returned `res.stdout` without reading `res.status`, so a failed
 *       `git diff` yielded "".
 *   (2) `scripts/diff-coverage.mjs` over an EMPTY added-line set reports OK — rightly, because the
 *       claim is vacuously true, and its `--diff` defaults to stdin so "" is indistinguishable
 *       from a PR that adds nothing.
 * The ci-parity `coverage-ratchet` entry pipes (1) into (2) as `input:`, so a git failure rendered
 * as a clean green `diff-coverage` step — the vacuous-pass family, reached from the diff side.
 *
 * The gate now REFUSES rather than repairs: no retry, no fallback ref, no synthesised diff.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CI_PARITY_TABLE, EMPTY_DIFF_COVERAGE_REFUSAL } from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

type SpawnResult = { status: number | null; stdout: string; stderr: string };

/** A spawn seam answering every call the coverage-ratchet entry makes, with the `git diff`
 *  three-dot call under the test's control. Fresh per test: `pinnedBase` memoises per spawn. */
function seam(diff: SpawnResult): { spawn: PreflightSpawn; stdinSeen: (string | undefined)[] } {
  const stdinSeen: (string | undefined)[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    const a = [...args].join(" ");
    if (a === "rev-parse origin/main") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
    if (a === `diff ${SHA}...HEAD`) return diff;
    if (a.includes("test-tier-manifest.mjs") && a.includes("--select-all")) {
      return { status: 0, stdout: "test/coverage-fixture.test.ts\n", stderr: "" };
    }
    if (a.includes("diff-coverage.mjs")) {
      stdinSeen.push((opts as { input?: string } | undefined)?.input);
      return { status: 0, stdout: "diff-coverage: OK — every added line covered", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" }; // base-refresh, coverage shards, merge, ratchet
  };
  return { spawn, stdinSeen };
}

function diffCoverageStep(diff: SpawnResult): { step: { name: string; ok: boolean; detail: string }; stdinSeen: (string | undefined)[] } {
  const entry = CI_PARITY_TABLE.find((e) => e.job === "coverage-ratchet");
  assert.ok(entry?.run, "the coverage-ratchet entry must exist and be runnable");
  const { spawn, stdinSeen } = seam(diff);
  const steps = entry.run(REPO_ROOT, spawn);
  const step = steps.find((s) => s.name === "coverage-ratchet:diff-coverage");
  assert.ok(step, `the entry must emit a diff-coverage step; saw ${steps.map((s) => s.name).join(", ")}`);
  return { step, stdinSeen };
}

// ── THE LOAD-BEARING FALSIFIER: the false green itself ───────────────────────────────────────

test("W1-T3013: a FAILED `git diff` produces a NOT-OK step — with the check removed this is the false green", () => {
  const { step, stdinSeen } = diffCoverageStep({ status: 1, stdout: "", stderr: "fatal: bad revision" });
  assert.equal(step.ok, false, "a gate that cannot measure must not report a pass");
  assert.deepEqual(stdinSeen, [], "and diff-coverage.mjs is never even asked — it cannot refuse this question");
});

test("W1-T3013: the refusal names the DIFF as what could not be measured, so a reader is not sent to look at coverage", () => {
  const { step } = diffCoverageStep({ status: 1, stdout: "", stderr: "fatal: bad revision" });
  assert.match(step.detail, /could not compute the origin\/main\.\.\.HEAD diff/);
  assert.match(step.detail, /the DIFF could not be measured/);
  assert.match(step.detail, /not a coverage result/);
});

test("W1-T3013: a NULL status is refused too — a spawn that never ran is not a clean diff", () => {
  const { step } = diffCoverageStep({ status: null, stdout: "", stderr: "" });
  assert.equal(step.ok, false);
  assert.match(step.detail, /exited null/);
});

// ── the second fault the status check does NOT catch ─────────────────────────────────────────

test("W1-T3013: git SUCCEEDING over an empty diff is refused on the SAME ground preflight --coverage already uses", () => {
  const { step, stdinSeen } = diffCoverageStep({ status: 0, stdout: "", stderr: "" });
  assert.equal(step.ok, false, "an empty diff is equally not a coverage result");
  assert.ok(step.detail.includes(EMPTY_DIFF_COVERAGE_REFUSAL), "the wording is the shared constant, not a second hand-written copy");
  assert.deepEqual(stdinSeen, []);
});

test("W1-T3013: whitespace-only output is empty too — a diff of blank lines asserts nothing", () => {
  assert.equal(diffCoverageStep({ status: 0, stdout: "\n  \n", stderr: "" }).step.ok, false);
});

// ── THE REGRESSION LOCK: the honest green must be byte-identical ─────────────────────────────

test("W1-T3013: a REAL non-empty diff still reaches diff-coverage.mjs, on stdin, unchanged", () => {
  const real = ["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1,2 @@", " const a = 1;", "+const b = 2;", ""].join("\n");
  const { step, stdinSeen } = diffCoverageStep({ status: 0, stdout: real, stderr: "" });
  assert.equal(step.ok, true, "the verdict this gate already reaches correctly must not move");
  assert.deepEqual(stdinSeen, [real], "the diff text arrives on stdin byte-identical — not trimmed, not re-derived");
  assert.match(step.detail, /^coverage-ratchet:diff-coverage: PASS — diff-coverage\.mjs \(origin\/main\.\.\.HEAD, refreshed base\)$/,
    "and the PASS detail is byte-identical to what this step reported before the check existed");
});

test("W1-T3013: the step keeps its name, so nothing downstream that matches on it moves", () => {
  const real = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n+const b = 2;\n";
  assert.equal(diffCoverageStep({ status: 0, stdout: real, stderr: "" }).step.name, "coverage-ratchet:diff-coverage");
});

// ── THE CONTROL AGAINST PROVING NOTHING ──────────────────────────────────────────────────────

test("W1-T3013: diff-coverage.mjs is UNCHANGED — it still reports OK over an empty added-line set", () => {
  // The bug was never that its answer was wrong. It was that the gate asked it a question it
  // cannot refuse. If this ever fails, the fix went to the wrong file.
  const out = execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "diff-coverage.mjs"), "--lcov", join(REPO_ROOT, "scripts", "diff-coverage.mjs")], {
    input: "",
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.match(out, /OK/, "an empty added-line set is vacuously covered, and saying so is correct");
});
