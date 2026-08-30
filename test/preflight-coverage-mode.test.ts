import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { runPreflightCoverage } from "../src/lib/ci-parity.js";
import { FAST_GATE_STEPS, runPreflightFast } from "../src/lib/ci-parity.js";
import { preflightCommand } from "../src/run-task.js";

// ── W1-T1074: `rmd preflight --coverage` — diff-coverage, at author-time, on its OWN base ────
//
// `scripts/diff-coverage.mjs` is a correct gate that today runs ONLY in CI's coverage-ratchet
// job — prose to the author until a push has already been spent. This suite proves the new
// `--coverage` mode: it derives its own three-dot `origin/main...HEAD` base rather than trusting
// a caller-supplied diff, it REFUSES (rather than reports a pass) on an empty diff or a tree left
// dirty in a diffed file, it asserts every changed source file actually carries an lcov `SF:`
// record before it may report a PASS (else UNPROVEN, naming the file), and `--fast` still shells
// no test suite now that this mode exists beside it.

const REPO_ROOT = process.cwd();

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

const SOME_LCOV = "TN:\nSF:src/lib/example.ts\nDA:1,1\nend_of_record\n";

// ── acceptance 1: the mode derives its OWN three-dot base, never a caller-supplied one ──────

test("runPreflightCoverage: takes no diff/range parameter at all — a caller cannot supply one, only (repoRoot, deps)", () => {
  // `Function.length` counts only parameters BEFORE the first default-valued one, so
  // `(repoRoot, deps = {})` reports 1 — that itself is the falsifiable part of this claim: a
  // THIRD parameter (a diff, a range) would push the count to 2 whether or not it carried a
  // default, so 1 proves no scope/diff-injecting parameter exists alongside `deps`.
  assert.equal(runPreflightCoverage.length, 1, "runPreflightCoverage must accept only (repoRoot, deps = {}) — no scope/diff-injecting parameter");
});

test("runPreflightCoverage: refreshes origin/main (git fetch) BEFORE deriving the three-dot changed-file list, and BEFORE the diff piped into diff-coverage.mjs", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "diff origin/main...HEAD": { status: 0, stdout: "diff --git a/src/lib/example.ts b/src/lib/example.ts\n+x\n" },
  });
  runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const fetchIdx = calls.findIndex((c) => c.file === "git" && c.args.join(" ") === "fetch origin main");
  assert.ok(fetchIdx >= 0, "expected a `git fetch origin main` call to refresh the base");

  const changedFilesIdx = calls.findIndex((c, i) => i > fetchIdx && c.file === "git" && c.args.join(" ") === "diff --name-only origin/main...HEAD");
  assert.ok(changedFilesIdx > fetchIdx, "the changed-file list must be derived AFTER the refresh, never before");

  const diffCoverageDiffIdx = calls.findIndex((c, i) => i > fetchIdx && c.file === "git" && c.args.join(" ") === "diff origin/main...HEAD");
  assert.ok(diffCoverageDiffIdx > fetchIdx, "the diff fed to diff-coverage.mjs must also be derived AFTER the refresh");

  const twoDot = calls.some((c) => c.file === "git" && c.args.some((a) => /^origin\/main\.\.HEAD$/.test(a)));
  assert.equal(twoDot, false, "must never fall back to a two-dot range — three-dot only, the same range --ci-parity's coverage-ratchet job uses");
});

test("runPreflightCoverage: the diff piped into diff-coverage.mjs is exactly what the refreshed three-dot `git diff` produced, never a hand-built or cached one", () => {
  const sentinelDiff = "diff --git a/src/lib/example.ts b/src/lib/example.ts\n+added line\n";
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "diff origin/main...HEAD": { status: 0, stdout: sentinelDiff },
  });
  runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const diffCoverageCall = calls.find((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
  assert.ok(diffCoverageCall, "expected a diff-coverage.mjs invocation");
  assert.equal(diffCoverageCall!.opts?.input, sentinelDiff, "diff-coverage.mjs must receive the refreshed three-dot diff verbatim as stdin");
});

test("runPreflightCoverage: a base-refresh failure REFUSES immediately — no changed-file derivation, no suite run, nothing further spawned", () => {
  const { spawn, calls } = recordingSpawn({
    "fetch origin main": { status: 1, stderr: "could not resolve origin" },
  });
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1, "only the base-refresh step should be reported once it fails");
  const refreshStep = result.steps.find((s) => s.name === "coverage-mode:base-refresh")!;
  assert.equal(refreshStep.ok, false);

  const laterCalls = calls.filter((c) => !(c.file === "git" && c.args.join(" ") === "fetch origin main"));
  assert.equal(laterCalls.length, 0, "nothing else may run once the base itself could not be refreshed");
});

// ── acceptance 2: refuse — never report a pass — on an empty diff or a dirty diffed file ────

test("runPreflightCoverage: an EMPTY diff (origin/main...HEAD touches nothing) is REFUSED, not reported as a pass, and the expensive suite never runs", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "" },
  });
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  assert.equal(result.ok, false, "an empty diff must never read as a pass");
  const scopeStep = result.steps.find((s) => s.name === "coverage-mode:diff-scope")!;
  assert.equal(scopeStep.ok, false);
  assert.match(scopeStep.detail, /REFUSED/, "an empty diff is a REFUSAL, not an ordinary FAIL");

  const suiteCalled = calls.some((c) => c.args.some((a) => a.includes("test-with-retry.mjs")));
  assert.equal(suiteCalled, false, "the multi-minute suite must never run once the diff is already known to be empty");
  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
  assert.equal(diffCoverageCalled, false, "diff-coverage.mjs itself must never run over an empty diff either");
});

test("runPreflightCoverage: a TREE DIRTY in a diffed file is REFUSED, not reported as a pass, and the expensive suite never runs", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: " M src/lib/example.ts\n" },
  });
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  assert.equal(result.ok, false, "a dirty diffed file must never read as a pass");
  const treeStep = result.steps.find((s) => s.name === "coverage-mode:tree-clean")!;
  assert.equal(treeStep.ok, false);
  assert.match(treeStep.detail, /REFUSED/, "a dirty tree is a REFUSAL, not an ordinary FAIL");
  assert.match(treeStep.detail, /src\/lib\/example\.ts/, "the refusal must NAME the dirty diffed file");

  const suiteCalled = calls.some((c) => c.args.some((a) => a.includes("test-with-retry.mjs")));
  assert.equal(suiteCalled, false, "the multi-minute suite must never run once the tree is already known to be dirty in a diffed file");
});

test("runPreflightCoverage: a diffed file with NO uncommitted change (clean tree) is a positive control — tree-clean PASSES and the run proceeds", () => {
  const { spawn } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
  });
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const treeStep = result.steps.find((s) => s.name === "coverage-mode:tree-clean")!;
  assert.equal(treeStep.ok, true, "a clean tree must pass this step");
  assert.ok(result.steps.some((s) => s.name === "coverage-mode:test-with-coverage"), "the run must proceed to the suite once the tree checks out clean");
});

test("runPreflightCoverage: the dirty-tree check is SCOPED to exactly the diffed pathspec, never a bare tree-wide `git status --porcelain` — a dirty file outside the diff cannot refuse the run", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
  });
  runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const statusCall = calls.find((c) => c.file === "git" && c.args[0] === "status");
  assert.ok(statusCall, "expected a git status --porcelain call");
  assert.deepEqual(statusCall!.args, ["status", "--porcelain", "--", "src/lib/example.ts"], "must scope the porcelain query to exactly the diffed file(s), never a bare `git status --porcelain` over the whole tree");
});

// ── acceptance 3: instrumentation must be asserted BEFORE a PASS may be reported ────────────

test("runPreflightCoverage: a changed source file with NO lcov SF: record yields UNPROVEN and NAMES the file — never a bare pass over an empty set", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
  });
  // lcov this run produced never saw src/lib/example.ts at all — no SF: record for it.
  const lcovMissingTheFile = "TN:\nSF:src/lib/other.ts\nDA:1,1\nend_of_record\n";
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: lcovMissingTheFile });

  assert.equal(result.ok, false, "an unproven file must never let the overall run read as a pass");
  const instrumentation = result.steps.find((s) => s.name === "coverage-mode:instrumentation")!;
  assert.equal(instrumentation.ok, false);
  assert.match(instrumentation.detail, /UNPROVEN/, "must say UNPROVEN, distinct from an ordinary FAIL");
  assert.match(instrumentation.detail, /src\/lib\/example\.ts/, "must NAME the uninstrumented file");

  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
  assert.equal(diffCoverageCalled, false, "diff-coverage.mjs must never even be asked for a verdict once instrumentation cannot be proven");
});

test("runPreflightCoverage: a changed TEST file with no SF: record is fine — the instrumentation assertion only names SOURCE files, never test files", () => {
  const { spawn } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\ntest/example.test.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
  });
  // lcov instruments the source file but (as node --test's own coverage does) carries no SF:
  // record for the test file itself.
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const instrumentation = result.steps.find((s) => s.name === "coverage-mode:instrumentation")!;
  assert.equal(instrumentation.ok, true, "a test file carrying no SF: record must never be treated as an unproven SOURCE file");
  assert.doesNotMatch(instrumentation.detail, /example\.test\.ts/, "the test file must never be named as uninstrumented");
});

test("runPreflightCoverage: every changed source file instrumented — the positive control — PASSES and proceeds to the real diff-coverage.mjs", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "diff origin/main...HEAD": { status: 0, stdout: "diff --git a/src/lib/example.ts b/src/lib/example.ts\n+x\n" },
  });
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const instrumentation = result.steps.find((s) => s.name === "coverage-mode:instrumentation")!;
  assert.equal(instrumentation.ok, true);
  assert.match(instrumentation.detail, /PASS/);

  const diffCoverageCall = calls.find((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
  assert.ok(diffCoverageCall, "diff-coverage.mjs must run once instrumentation is proven for every changed source file");
  assert.equal(result.ok, true, "a fully instrumented, clean-tree, non-empty diff with a passing diff-coverage.mjs must read as an overall pass");
});

test("runPreflightCoverage: the suite run itself failing (e.g. a real test failure) is reported as its own FAIL and short-circuits — instrumentation is never asserted over a failed run's lcov", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "test-with-retry.mjs": { status: 1, stderr: "1 test failed" },
  });
  const result = runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const testStep = result.steps.find((s) => s.name === "coverage-mode:test-with-coverage")!;
  assert.equal(testStep.ok, false);
  assert.equal(result.ok, false);
  assert.equal(result.steps.find((s) => s.name === "coverage-mode:instrumentation"), undefined, "instrumentation must never be asserted once the suite itself failed to run cleanly");

  const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
  assert.equal(diffCoverageCalled, false);
});

test("runPreflightCoverage: the coverage run is invoked with --enable-source-maps, --test-coverage-exclude=test/**, and the FULL test/**/*.test.ts glob — same flags --ci-parity's coverage-ratchet job uses, never a scoped run", () => {
  const { spawn, calls } = recordingSpawn({
    "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
    "status --porcelain": { status: 0, stdout: "" },
  });
  runPreflightCoverage(REPO_ROOT, { spawn, lcovText: SOME_LCOV });

  const coverageCall = calls.find((c) => c.args.includes("--experimental-test-coverage"));
  assert.ok(coverageCall, "expected the coverage-run invocation");
  assert.ok(coverageCall!.args.includes("--enable-source-maps"), "source maps must be enabled");
  assert.ok(coverageCall!.args.includes("--test-coverage-exclude=test/**"), "test/** must stay excluded from the ratio");
  assert.ok(coverageCall!.args.includes("test/**/*.test.ts"), "the FULL glob must be in scope — a scoped run cannot prove instrumentation honestly");
});

test(
  "runPreflightCoverage: the lcov this run was supposed to produce being UNREADABLE is a toolchain " +
    "FAIL, not a silent pass — the real readFileSync arm every other test in this file injects past",
  () => {
    // Every other test here supplies `deps.lcovText`, so the production read — `readFileSync` on
    // the lcov the coverage step just wrote — never executes, and neither does its catch arm.
    // That is exactly why diff-coverage reported those lines as added-and-uncovered. This test
    // omits `lcovText` so the REAL read runs, against a repoRoot that carries no
    // `coverage/lcov.info` at all, so it throws and the catch arm is the thing under test.
    const emptyRoot = mkdtempSync(join(tmpdir(), "preflight-coverage-no-lcov-"));
    try {
      const { spawn, calls } = recordingSpawn({
        "diff --name-only origin/main...HEAD": { status: 0, stdout: "src/lib/example.ts\n" },
        "status --porcelain": { status: 0, stdout: "" },
      });
      const result = runPreflightCoverage(emptyRoot, { spawn });

      assert.equal(result.ok, false, "an unreadable lcov must never let the overall run read as a pass");
      const instrumentation = result.steps.find((s) => s.name === "coverage-mode:instrumentation");
      assert.ok(instrumentation, "the failure is reported under the instrumentation step, not swallowed");
      assert.equal(instrumentation.ok, false);
      assert.match(
        instrumentation.detail,
        /toolchain unavailable/,
        `an unreadable lcov is reported as a toolchain failure (got: ${instrumentation.detail})`,
      );
      // DISCRIMINATOR: this is NOT the UNPROVEN arm above it — that one names uninstrumented
      // files off an lcov it successfully read. Here there is no lcov to read at all.
      assert.doesNotMatch(
        instrumentation.detail,
        /UNPROVEN/,
        "an unreadable lcov must not be mistaken for a readable one that merely lacks a record",
      );
      const diffCoverageCalled = calls.some((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
      assert.equal(diffCoverageCalled, false, "diff-coverage.mjs is never asked for a verdict over an lcov that could not be read");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  },
);

// ── acceptance 4: --fast still shells no test suite now that --coverage exists beside it ────

test("FAST_GATE_STEPS: unaffected by --coverage's existence — still exactly the seven pre-existing deterministic npm-script gates plus the four W1-T2478 census entries plus the W1-T2491 branch-shape gate, no coverage-shaped entry added", () => {
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
    "worker-branch-shape:check",
  ]);
  for (const step of FAST_GATE_STEPS) {
    assert.doesNotMatch(step.script, /^test/, "no FAST_GATE_STEPS entry may be a test-suite-shaped script");
    assert.doesNotMatch(step.job, /coverage/, "no FAST_GATE_STEPS entry may be the new coverage job — --fast and --coverage stay disjoint modes");
  }
});

test("runPreflightFast: never invokes node --test, npm run test:ci, or scripts/diff-coverage.mjs/test-with-retry.mjs — no path to the coverage mode's cost exists in --fast", () => {
  const { spawn, calls } = recordingSpawn();
  const packageJsonText = JSON.stringify({ scripts: Object.fromEntries(FAST_GATE_STEPS.map((s) => [s.script, "echo stub"])) });
  runPreflightFast(REPO_ROOT, { spawn, packageJsonText });

  for (const call of calls) {
    const key = [call.file, ...call.args].join(" ");
    assert.doesNotMatch(key, /test:ci/, `runPreflightFast must never shell test:ci, saw: ${key}`);
    assert.doesNotMatch(key, /\bnode\b.*--test\b/, `runPreflightFast must never spawn node --test directly, saw: ${key}`);
    assert.doesNotMatch(key, /test-with-retry\.mjs/, `runPreflightFast must never spawn the coverage mode's suite runner, saw: ${key}`);
    assert.doesNotMatch(key, /diff-coverage\.mjs/, `runPreflightFast must never spawn diff-coverage.mjs, saw: ${key}`);
  }
});

test("preflightCommand: --coverage ADDS the coverage-mode steps after the three hand-route steps and folds a refusal into the exit code", async () => {
  const spawn: PreflightSpawn = (file, args) => {
    const key = [file, ...args].join(" ");
    if (key.includes("commitlint")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("tsc")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("git log")) return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
    if (key.includes("fetch origin main")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("diff --name-only origin/main...HEAD")) return { status: 0, stdout: "", stderr: "" }; // empty diff -> refused
    return { status: 0, stdout: "", stderr: "" };
  };
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand(["--coverage"], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1, "an empty-diff refusal under --coverage must fail the overall command even when the three hand-route steps are clean");
  assert.ok(lines.some((l) => l.includes("typecheck: PASS")), "the hand-route steps still print");
  assert.ok(lines.some((l) => l.includes("coverage-mode:diff-scope") && l.includes("REFUSED")), "the coverage-mode steps print too, under --coverage");
  assert.equal(lines.some((l) => l.includes("ci-parity")), false, "no --ci-parity output when only --coverage was passed");
});

test("preflightCommand: WITHOUT --coverage, no coverage-mode step runs or prints — the shipped hand route (and --ci-parity/--fast) is untouched", async () => {
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
  assert.equal(lines.some((l) => l.includes("coverage-mode")), false, "no coverage-mode output at all without the flag");
  assert.deepEqual(
    lines.filter((l) => /^(commitlint|typecheck|emitter-checks):/.test(l)).length,
    3,
    "exactly the three shipped hand-route steps",
  );
});

test("preflightCommand: --coverage is a recognised flag — passing it never trips the unknown-argument refusal", async () => {
  const spawn: PreflightSpawn = () => ({ status: 0, stdout: "\0feat(x): fine\n", stderr: "" });
  const originalError = console.error;
  const errLines: string[] = [];
  console.error = (...args: unknown[]) => {
    errLines.push(args.join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand(["--coverage"], { spawn });
  } finally {
    console.error = originalError;
  }
  assert.notEqual(code, 2, "an unknown-argument refusal exits 2 — --coverage must never trip it");
  assert.equal(errLines.some((l) => l.includes("unexpected argument")), false);
});
