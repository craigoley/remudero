import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import type { AffectedSuitesInput } from "../src/lib/affected-suites.js";
import {
  preflightCommand,
  runPreflightCiChecks,
  runPreflightScopedDiffCoverage,
  PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING,
  PREFLIGHT_SCOPED_COVERAGE_PER_SUITE_ESTIMATE_MS,
} from "../src/run-task.js";
// @ts-expect-error scripts/diff-coverage-local.mjs is a plain .mjs script with no declaration file.
import { extractCoverageFlags, readCiYaml } from "../scripts/diff-coverage-local.mjs";

// ── W1-T4108: PREFLIGHT RUNS WHAT CI RUNS ────────────────────────────────────────────────────
//
// On 2026-09-23, PRs #6677/#6687/#6690/#6693 each went red in CI after a green `rmd preflight`,
// on checks that need no GitHub: diff-coverage, the deps census, console-parity, the command-name
// inventory, and the comment-load census. `runPreflightScopedDiffCoverage` and
// `runPreflightCiChecks` (src/run-task.ts) close the gap this task's declared scope owns: a
// scoped, source-mapped diff-coverage step cheap enough to run BY DEFAULT (never the full
// instrumented suite `--coverage` shells), plus console-parity and the two census-shaped suites
// #6687 named. Both ride the same `--no-fast` escape `runPreflightFast` already uses.

const REPO_ROOT = process.cwd();
const PINNED_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const PINNED_RANGE = `${PINNED_BASE_SHA}...HEAD`;

/** Records every spawn call and answers from a lookup table keyed by a substring of
 *  `[file, ...args].join(" ")`, falling back to a clean `{status: 0}` for anything unlisted —
 *  the same file-scoping convention test/preflight-coverage-mode.test.ts already uses. */
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
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

/** A minimal import graph: one changed src file, one suite that imports it — the smallest input
 *  `selectAffectedSuites` (lib/affected-suites.ts) needs to select a non-empty, non-full scope. */
function oneSuiteInput(): AffectedSuitesInput {
  return {
    files: new Map([
      ["src/lib/example.ts", "export const value = 1;\n"],
      ["test/example.test.ts", 'import { value } from "../src/lib/example.js";\n'],
    ]),
    pathReaders: [],
  };
}

/** `count` distinct suites, each importing the SAME one changed src file — used to push the
 *  scope past {@link PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING} without hand-writing each entry. */
function manySuitesInput(count: number): AffectedSuitesInput {
  const files = new Map<string, string>([["src/lib/example.ts", "export const value = 1;\n"]]);
  for (let i = 0; i < count; i += 1) {
    files.set(`test/generated-${i}.test.ts`, 'import { value } from "../src/lib/example.js";\n');
  }
  return { files, pathReaders: [] };
}

// ── acceptance 1: preflight fails where CI's diff-coverage would ───────────────────────────────

test("W1-T4108: preflight fails where CI's diff-coverage would", () => {
  // scripts/diff-coverage-local.mjs (W1-T4084) is the mechanism this step delegates to — it runs
  // the scoped suites under coverage and then shells the REAL scripts/diff-coverage.mjs, exiting
  // non-zero exactly when CI's own coverage-ratchet job would (an added line the lcov marks
  // uncovered). This test drives that boundary from the outside: the underlying subprocess
  // reports the failure CI's diff-coverage.mjs itself reports on an uncovered added line, and
  // runPreflightScopedDiffCoverage must carry that failure through rather than swallow it.
  //
  // FALSIFIER (this task's own): drop the call to diff-coverage-local.mjs from
  // runPreflightScopedDiffCoverage entirely and this stub is never asked — `ok` reads `true` from
  // the scope step alone, the assertion below reads `false` against the actual `true`, and this
  // test fails loudly instead of silently passing.
  const { spawn, calls } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "src/lib/example.ts\n" },
    "diff-coverage-local.mjs": {
      status: 1,
      stderr: "diff-coverage: BLOCKED — src/lib/example.ts:1 added and not covered by any executed test\n",
    },
  });
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => oneSuiteInput() });

  assert.equal(result.ok, false, "an uncovered added line must read as a FAIL, never a pass");
  const step = result.steps.find((s) => s.name === "fast-coverage:diff-coverage")!;
  assert.ok(step, "expected a fast-coverage:diff-coverage step");
  assert.equal(step.ok, false);
  assert.match(step.detail, /not covered/, "the underlying diff-coverage.mjs failure text must reach the caller");
  assert.match(step.detail, /predicts CI/i, "a failing step must name the CI job it predicts (design iii)");

  const invocation = calls.find((c) => c.args.some((a) => a.includes("diff-coverage-local.mjs")));
  assert.ok(invocation, "expected a scripts/diff-coverage-local.mjs invocation");
  assert.equal(invocation!.args.includes("--base"), true);
  assert.equal(invocation!.args[invocation!.args.indexOf("--base") + 1], PINNED_BASE_SHA, "must diff against the pinned base, never the moving ref");
  assert.ok(invocation!.args.includes("test/example.test.ts"), "must pass the scoped suite(s), never the whole test/**/*.test.ts glob");
});

test("W1-T4108: a clean, covered diff (the positive control) PASSES all the way through", () => {
  const { spawn, calls } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "src/lib/example.ts\n" },
    "diff-coverage-local.mjs": { status: 0, stdout: "diff-coverage: OK\n" },
  });
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => oneSuiteInput() });

  assert.equal(result.ok, true);
  const step = result.steps.find((s) => s.name === "fast-coverage:diff-coverage")!;
  assert.equal(step.ok, true);
  const scopeStep = result.steps.find((s) => s.name === "fast-coverage:scope")!;
  assert.equal(scopeStep.ok, true);
  assert.match(scopeStep.detail, /PASS/);
  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage-local.mjs")));
  assert.equal(diffCoverageCalled, true);
});

test("W1-T4108: no changed src/**/*.ts file is a trivial PASS — nothing for diff-coverage to prove, and the expensive step never runs", () => {
  const { spawn, calls } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "docs/README.md\n" },
  });
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => oneSuiteInput() });

  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0]!.detail, /PASS/);
  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage-local.mjs")));
  assert.equal(diffCoverageCalled, false, "no changed source file means nothing to scope a suite run to");
});

test("W1-T4108: a change the selector cannot model forces the full suite, and this default-tier step SKIPS it rather than pay the cost — run --coverage for the full mirror", () => {
  const { spawn, calls } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "src/lib/example.ts\npackage-lock.json\n" },
  });
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => oneSuiteInput() });

  assert.equal(result.ok, true, "a SKIP must never read as a failure");
  const step = result.steps.find((s) => s.name === "fast-coverage:scope")!;
  assert.match(step.detail, /SKIPPED/);
  assert.match(step.detail, /package-lock\.json/, "must name the file that forced the full run");
  assert.match(step.detail, /--coverage/, "must point at the full local mirror");
  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage-local.mjs")));
  assert.equal(diffCoverageCalled, false);
});

test("W1-T4108: a changed src file the import graph reaches from NO suite is a named FAIL, not a silent pass — CI's coverage-ratchet would report it UNPROVEN", () => {
  const { spawn } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "src/lib/orphan.ts\n" },
  });
  const orphanInput: AffectedSuitesInput = { files: new Map([["src/lib/orphan.ts", "export const x = 1;\n"]]), pathReaders: [] };
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => orphanInput });

  assert.equal(result.ok, false);
  const step = result.steps.find((s) => s.name === "fast-coverage:scope")!;
  assert.equal(step.ok, false);
  assert.match(step.detail, /FAIL/);
  assert.match(step.detail, /src\/lib\/orphan\.ts/);
  assert.match(step.detail, /UNPROVEN/i);
});

test("W1-T4108: too many affected suites SKIPS the default-tier run and states the size and a stated (never measured) time estimate", () => {
  const tooMany = PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING + 5;
  const { spawn, calls } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "src/lib/example.ts\n" },
  });
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => manySuitesInput(tooMany) });

  assert.equal(result.ok, true);
  const step = result.steps.find((s) => s.name === "fast-coverage:scope")!;
  assert.match(step.detail, /SKIPPED/);
  assert.match(step.detail, new RegExp(String(tooMany)), "must name the actual suite count");
  assert.match(step.detail, /~\d+s/, "must state an estimate");
  assert.match(step.detail, /guess/i, "must own the estimate as a stated guess, never a measured bound");
  assert.ok(PREFLIGHT_SCOPED_COVERAGE_PER_SUITE_ESTIMATE_MS > 0);
  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage-local.mjs")));
  assert.equal(diffCoverageCalled, false, "too large for the default tier — the expensive step must not run");
});

test("W1-T4108: an unresolvable base SKIPS (never REFUSES) — this is an additive default-tier member, not the opt-in --coverage mode", () => {
  // Unlike `--coverage` (an explicit ask, where runPreflightCoverage's own base-pin failure
  // REFUSES — see test/preflight-coverage-mode.test.ts), this step rides the always-on default
  // tier beside every other FAST_GATE_STEPS entry that treats an unmet precondition as a SKIP.
  // Failing the whole default push gate over one convenience step's unresolvable ref would be
  // disproportionate — and, mechanically, is exactly what would otherwise break every existing
  // preflightCommand([], ...) test fixture that never scripted a real `git rev-parse origin/main`.
  const { spawn, calls } = recordingSpawn({ "rev-parse origin/main": { status: 128, stdout: "", stderr: "fatal: not a git repository" } });
  const result = runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => oneSuiteInput() });

  assert.equal(result.ok, true, "a SKIP must never read as a failure");
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0]!.detail, /SKIPPED/);
  assert.match(result.steps[0]!.detail, /predicts CI/i);
  const diffScopeCalled = calls.some((c) => c.file === "git" && c.args[0] === "diff");
  assert.equal(diffScopeCalled, false, "nothing else may run once the base itself cannot be resolved");
});

// ── acceptance 2: preflight runs the census suites and console-parity ──────────────────────────

test("W1-T4108: preflight runs the census suites and console-parity", () => {
  const { spawn, calls } = recordingSpawn();
  const result = runPreflightCiChecks(REPO_ROOT, { spawn });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s) => s.name).sort(),
    ["ci-checks:command-registry-census", "ci-checks:console-parity", "ci-checks:deps-interface-census"].sort(),
  );

  const consoleParityCall = calls.find((c) => c.file === "npm" && c.args.join(" ") === "run --silent console-parity");
  assert.ok(consoleParityCall, "expected `npm run --silent console-parity`, the exact script ci.yml's Console-parity ratchet step runs");

  const commandRegistryCall = calls.find((c) => c.args.some((a) => a.includes("help-renders-a-summary-not-a-paragraph.test.ts")));
  assert.ok(commandRegistryCall, "expected the command-name inventory suite to run — #6687's own second miss");
  assert.ok(commandRegistryCall!.args.includes("--test"), "must run under node --test, the same runner CI uses");

  const depsCensusCall = calls.find((c) => c.args.some((a) => a.includes("deps-interface-census.test.ts")));
  assert.ok(depsCensusCall, "expected the deps-interface census to run — #6687's third miss, and not in any census registry at all yet");
});

test("W1-T4108: a failing ci-checks entry FAILS the overall result and names the CI job it predicts", () => {
  const { spawn } = recordingSpawn({ "run --silent console-parity": { status: 1, stdout: "", stderr: "console-parity: BLOCKED — new verb with no CLI-only reason\n" } });
  const result = runPreflightCiChecks(REPO_ROOT, { spawn });

  assert.equal(result.ok, false);
  const step = result.steps.find((s) => s.name === "ci-checks:console-parity")!;
  assert.equal(step.ok, false);
  assert.match(step.detail, /BLOCKED/);
  assert.match(step.detail, /predicts CI/i);
  assert.match(step.detail, /commitlint/, 'must name the real ci.yml job ("commitlint", the console-parity step\'s actual home)');

  // The other two checks are INDEPENDENT — one failing must never stop the others from running or reporting.
  assert.ok(result.steps.some((s) => s.name === "ci-checks:command-registry-census" && s.ok));
  assert.ok(result.steps.some((s) => s.name === "ci-checks:deps-interface-census" && s.ok));
});

test("W1-T4108: preflightCommand runs the new ci-checks and scoped-coverage steps by default, and --no-fast drops both, exactly like the fast gate", async () => {
  const spawn: PreflightSpawn = (file, args) => {
    const key = [file, ...args].join(" ");
    if (key.includes("commitlint")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("tsc")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("git log")) return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
    if (file === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${PINNED_BASE_SHA}\n`, stderr: "" };
    if (file === "git" && args[0] === "diff" && args.includes("--name-only")) return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const originalLog = console.log;
  const defaultLines: string[] = [];
  console.log = (...a: unknown[]) => defaultLines.push(a.join(" "));
  let defaultCode: number;
  try {
    defaultCode = await preflightCommand([], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(defaultCode, 0);
  assert.ok(defaultLines.some((l) => l.includes("ci-checks:console-parity")), "console-parity must run by default, no flag needed");
  assert.ok(defaultLines.some((l) => l.includes("fast-coverage:scope")), "the scoped diff-coverage step must run by default, no flag needed");

  const noFastLines: string[] = [];
  console.log = (...a: unknown[]) => noFastLines.push(a.join(" "));
  let noFastCode: number;
  try {
    noFastCode = await preflightCommand(["--no-fast"], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(noFastCode, 0);
  assert.equal(noFastLines.some((l) => l.includes("ci-checks:")), false, "--no-fast must drop the new ci-checks steps too");
  assert.equal(noFastLines.some((l) => l.includes("fast-coverage:")), false, "--no-fast must drop the new scoped-coverage step too");
});

test("W1-T4108: a launcher exception becomes a named preflight failure and the summary still completes", async () => {
  // The older summary-containment fixture intentionally recognises only the original
  // preflight commands. Its launcher throws on both added checks; that must leave a failed
  // verdict, not abort before preflight can write/report its summary.
  const spawn: PreflightSpawn = (file, args) => {
    const key = [file, ...args].join(" ");
    if (key.includes("commitlint")) return { status: 1, stdout: "", stderr: "header-max-length" };
    if (key.includes("tsc")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("git log")) return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
    throw new Error(`unscripted launcher call: ${key}`);
  };
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  let code: number;
  try {
    code = await preflightCommand([], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("ci-checks:invocation: FAIL") && line.includes("console-parity")));
  assert.ok(lines.some((line) => line.includes("fast-coverage:base-pin: SKIPPED") && line.includes("unscripted launcher call")));
  assert.ok(lines.some((line) => line.includes("summary NOT written")), "the existing injected-spawn summary rule must still run");
});

// ── acceptance 3: local coverage is measured with source maps ──────────────────────────────────

test("W1-T4108: local coverage is measured with source maps", () => {
  // Two hand-rolled local coverage attempts measurably drifted from CI by omitting
  // --enable-source-maps (scripts/diff-coverage-local.mjs's own file header, W1-T4084) — so this
  // step never re-derives the node coverage flags: it delegates to that script, which reads them
  // straight out of ci.yml's own "coverage-ratchet" job. First, prove THAT is what gets spawned...
  const { spawn, calls } = recordingSpawn({
    [`diff --name-only ${PINNED_RANGE}`]: { status: 0, stdout: "src/lib/example.ts\n" },
    "diff-coverage-local.mjs": { status: 0, stdout: "diff-coverage: OK\n" },
  });
  runPreflightScopedDiffCoverage(REPO_ROOT, { spawn, readAffectedInput: () => oneSuiteInput() });

  const invocation = calls.find((c) => c.args.some((a) => a.includes("diff-coverage-local.mjs")));
  assert.ok(invocation, "expected an invocation of scripts/diff-coverage-local.mjs");
  assert.equal(invocation!.file, process.execPath, "must run the script directly under node, never through an intermediate shell");
  for (const badFlag of ["--test", "node_modules/.bin"]) {
    assert.equal(invocation!.args.some((a) => a.includes(badFlag) && !a.includes("diff-coverage-local.mjs")), false);
  }

  // ...then prove, against the REAL, live ci.yml (never a hand-copied literal), that what that
  // script runs really does carry --enable-source-maps and --experimental-test-coverage — the
  // exact two flags the two earlier hand-rolled attempts measurably omitted.
  const realCiYamlText = readCiYaml();
  const realFlags = extractCoverageFlags(realCiYamlText);
  assert.ok(realFlags.includes("--enable-source-maps"), "ci.yml's own coverage-ratchet step must carry --enable-source-maps");
  assert.ok(realFlags.includes("--experimental-test-coverage"), "ci.yml's own coverage-ratchet step must carry --experimental-test-coverage");
});
