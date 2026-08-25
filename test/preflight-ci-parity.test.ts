import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { CI_PARITY_TABLE, parseCiJobNames, runCiParity } from "../src/lib/ci-parity.js";
import { preflightCommand } from "../src/run-task.js";
import { skipInMutationSandbox } from "./helpers/mutation-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── W1-T294: `rmd preflight --ci-parity` — mirroring CI's own thirteen jobs ─────────────────
//
// The shipped `rmd preflight` (W1-T221) runs three hand-route steps, none of which is any of
// the thirteen jobs .github/workflows/ci.yml actually gates a merge on. This suite proves the
// `--ci-parity` mode this task adds: every ci.yml job is accounted for (mirrored or a recorded
// exclusion), the diff-consuming steps refresh their base before diffing, the coverage step
// never runs scoped or without source maps, the diff-scoped steps reuse CI's own trigger
// scripts, every step reports independently, and an unavailable toolchain fails loud rather
// than reading as green.

/** Records every spawn call and answers from a lookup table keyed by a substring of
 *  `[file, ...args].join(" ")`, falling back to a clean `{status: 0}` for anything unlisted —
 *  runCiParity's table has thirteen jobs' worth of steps, and most tests below only care about
 *  ONE of them, so an unmatched call must not throw the way test/preflight.test.ts's stricter
 *  fakeSpawn does (that suite's fixtures name every call up front; this one would be unreadably
 *  long if it had to). Duplicated locally per that suite's own file-scoping convention. */
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

// ── acceptance 1: every ci.yml job has a parity entry, mirrored or excluded-with-reason ─────

test("ci-parity table: every REAL ci.yml job has an entry, either mirrored (with a run()) or excluded (with a reason) — no entry is silently absent", () => {
  const ciYamlText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobs = parseCiJobNames(ciYamlText);
  assert.ok(jobs.length >= 13, `expected at least the 13 jobs ci.yml defined at filing time, got ${jobs.length}`);

  const byJob = new Map(CI_PARITY_TABLE.map((e) => [e.job, e]));
  for (const job of jobs) {
    const entry = byJob.get(job);
    assert.ok(entry, `ci.yml job '${job}' has no CI_PARITY_TABLE entry at all`);
    if (entry!.mirrored) {
      assert.equal(typeof entry!.run, "function", `'${job}' is mirrored but has no run()`);
    } else {
      assert.ok(entry!.reason && entry!.reason.length > 0, `'${job}' is excluded but carries no reason`);
    }
  }
});

test("ci-parity table: carries no entry for a job ci.yml does not define (the table cannot silently grow ahead of the workflow either)", () => {
  const ciYamlText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobs = new Set(parseCiJobNames(ciYamlText));
  for (const entry of CI_PARITY_TABLE) {
    assert.ok(jobs.has(entry.job), `CI_PARITY_TABLE names '${entry.job}', which ci.yml does not define`);
  }
});

test("ci-parity DRIFT FALSIFIER: a synthetic ci.yml job with no table entry turns the ci-parity:drift step red", () => {
  const { spawn } = recordingSpawn();
  const syntheticCiYaml = `
name: CI
on:
  pull_request:
jobs:
  ci:
    name: ci
    runs-on: ubuntu-latest
    steps: []
  brand-new-gate-nobody-mirrored-yet:
    name: brand-new-gate-nobody-mirrored-yet
    runs-on: ubuntu-latest
    steps: []
`;
  const result = runCiParity(REPO_ROOT, { spawn, ciYamlText: syntheticCiYaml });
  const drift = result.steps.find((s) => s.name === "ci-parity:drift")!;
  assert.equal(drift.ok, false, "an unmirrored, unexcluded new job must turn the drift step red");
  assert.match(drift.detail, /brand-new-gate-nobody-mirrored-yet/, "the drift step must NAME the missing job, not just fail silently");
  assert.equal(result.ok, false);
});

test("ci-parity DRIFT FALSIFIER, negative control: a synthetic ci.yml whose every job the table already covers stays green on that step", () => {
  const { spawn } = recordingSpawn();
  const syntheticCiYaml = `
name: CI
on:
  pull_request:
jobs:
  ci:
    name: ci
    runs-on: ubuntu-latest
    steps: []
  commitlint:
    name: commitlint
    runs-on: ubuntu-latest
    steps: []
`;
  const result = runCiParity(REPO_ROOT, { spawn, ciYamlText: syntheticCiYaml });
  const drift = result.steps.find((s) => s.name === "ci-parity:drift")!;
  assert.equal(drift.ok, true, "every job in this synthetic file has a table entry — the drift step must stay green");
});

// ── acceptance 2: merge-base parity — refresh before a three-dot diff ───────────────────────

test("coverage-ratchet job: refreshes origin/main (git fetch) BEFORE computing the three-dot diff diff-coverage.mjs consumes", () => {
  const { spawn, calls } = recordingSpawn();
  runCiParity(REPO_ROOT, { spawn });

  const fetchIdx = calls.findIndex((c) => c.file === "git" && c.args.join(" ") === "fetch origin main" && c.opts?.cwd === REPO_ROOT);
  assert.ok(fetchIdx >= 0, "expected a `git fetch origin main` call to refresh the base before any diff");

  const diffIdx = calls.findIndex((c, i) => i > fetchIdx && c.file === "git" && c.args.includes("origin/main...HEAD"));
  assert.ok(diffIdx >= 0, "expected a `git diff origin/main...HEAD` (three-dot) call AFTER the refresh");

  const twoDot = calls.some((c) => c.file === "git" && c.args.some((a) => /^origin\/main\.\.HEAD$/.test(a)));
  assert.equal(twoDot, false, "must never fall back to a two-dot range — three-dot only, matching ci.yml's own diff");
});

test("coverage-ratchet job: the diff piped into diff-coverage.mjs is exactly what the refreshed three-dot `git diff` produced (a stale-base checkout cannot silently narrow it)", () => {
  const sentinelDiff = "diff --git a/x.ts b/x.ts\n+added line\n";
  const { spawn, calls } = recordingSpawn({
    "fetch origin main": { status: 0 },
    "diff origin/main...HEAD": { status: 0, stdout: sentinelDiff },
  });
  runCiParity(REPO_ROOT, { spawn });

  const diffCoverageCall = calls.find((c) => c.args.some((a) => a.includes("diff-coverage.mjs")));
  assert.ok(diffCoverageCall, "expected a diff-coverage.mjs invocation");
  assert.equal(diffCoverageCall!.opts?.input, sentinelDiff, "diff-coverage.mjs must receive the refreshed three-dot diff verbatim as stdin");
});

// ── acceptance 3: coverage flags — source maps, test/** excluded, full glob, never scoped ───

test("coverage-ratchet job: the coverage run is invoked with --enable-source-maps, --test-coverage-exclude=test/**, and the FULL test/**/*.test.ts glob — always, never scoped and never source-map-less", () => {
  const { spawn, calls } = recordingSpawn();
  runCiParity(REPO_ROOT, { spawn });

  const coverageCall = calls.find((c) => c.args.includes("--experimental-test-coverage"));
  assert.ok(coverageCall, "expected the coverage-run invocation");
  assert.ok(coverageCall!.args.includes("--enable-source-maps"), "source maps must be enabled — without it lcov's DA: line numbers disagree with git diff's (W1-T210)");
  assert.ok(coverageCall!.args.includes("--test-coverage-exclude=test/**"), "test/** must stay excluded from the coverage ratio, same as ci.yml");
  assert.ok(coverageCall!.args.includes("test/**/*.test.ts"), "the FULL glob must be in scope — a scoped run attributes covering lines to nothing");
});

test("coverage-ratchet job: the coverage invocation's argv has no scope-narrowing parameter at all — the function that builds it is not parameterized by a caller-supplied file list, so a scoped call is structurally impossible, not just discouraged", () => {
  // CI_PARITY_TABLE's coverage-ratchet run() takes only (repoRoot, spawn) — there is no
  // optional third argument through which a caller could narrow the test glob or drop a flag.
  const entry = CI_PARITY_TABLE.find((e) => e.job === "coverage-ratchet")!;
  assert.equal(entry.run!.length, 2, "coverage-ratchet's run() must accept exactly (repoRoot, spawn) — no scope-narrowing parameter");
});

// ── acceptance 4: diff-scoped steps reuse CI's OWN trigger predicates ───────────────────────

test("mutation-ratchet job: the trigger step calls scripts/mutation-ratchet.mjs --changed-files — the SAME script (and same path-filter mode) ci.yml's own trigger step calls, never a re-decided predicate", () => {
  const { spawn, calls } = recordingSpawn();
  runCiParity(REPO_ROOT, { spawn });

  const trigger = calls.find((c) => c.args.some((a) => a.includes("mutation-ratchet.mjs")) && c.args.includes("--changed-files"));
  assert.ok(trigger, "expected scripts/mutation-ratchet.mjs --changed-files <path>, the SAME predicate ci.yml's mutation-ratchet job's trigger step calls");
});

// SKIPPED INSIDE STRYKER'S SANDBOX (skipInMutationSandbox), and for a DIFFERENT reason than its two
// siblings: nothing here reads source text. The assertion below is a substring test for "stryker"
// over recorded spawn args, and every arg is `join(repoRoot, ...)` — inside the sandbox repoRoot
// ITSELF contains that substring, so the check matches the sandbox's own directory name rather
// than a stryker invocation. Measured both ways: same 23 calls and the same single trigger call,
// with the predicate reading false on the real root and true on a sandbox-shaped one. It still
// runs on the real tree under `ci`.
test("mutation-ratchet job: a diff the trigger script reports as NOT required never runs stryker locally — the expensive step is skipped for the identical reason CI would skip it", skipInMutationSandbox(), () => {
  const { spawn, calls } = recordingSpawn({
    "mutation-ratchet.mjs --changed-files": { status: 0, stdout: "mutation-ratchet: skip -- no relevant path touched\n" },
  });
  const result = runCiParity(REPO_ROOT, { spawn });

  const strykerCalled = calls.some((c) => c.file.includes("stryker") || c.args.some((a) => a.includes("stryker")));
  assert.equal(strykerCalled, false, "a skip verdict must never shell out to stryker");
  const strykerStep = result.steps.find((s) => s.name === "mutation-ratchet:stryker");
  assert.equal(strykerStep, undefined, "no stryker step should even be reported when the trigger skips");
});

test("mutation-ratchet job: a diff the trigger script reports as REQUIRED does run the scoped Stryker + ratchet steps", () => {
  const { spawn, calls } = recordingSpawn({
    "mutation-ratchet.mjs --changed-files": { status: 0, stdout: "mutation-ratchet: REQUIRED -- touches src/lib/classify.ts\n" },
    stryker: { status: 0 },
    "mutation-ratchet.mjs --report": { status: 0 },
  });
  const result = runCiParity(REPO_ROOT, { spawn });

  const strykerCalled = calls.some((c) => c.file.includes("stryker") || c.args.some((a) => a.includes("stryker")));
  assert.ok(strykerCalled, "a REQUIRED verdict must run stryker, same as CI would");
  assert.ok(result.steps.some((s) => s.name === "mutation-ratchet:stryker"));
  assert.ok(result.steps.some((s) => s.name === "mutation-ratchet:ratchet"));
});

test("containment-probe job: the trigger step calls .github/scripts/containment-diff-trigger.ts — the SAME script (containmentTrigger()) ci.yml's own trigger step calls", () => {
  const { spawn, calls } = recordingSpawn();
  runCiParity(REPO_ROOT, { spawn });

  const trigger = calls.find((c) => c.args.some((a) => a.includes("containment-diff-trigger.ts")));
  assert.ok(trigger, "expected .github/scripts/containment-diff-trigger.ts to be invoked");
});

test("containment-probe job: a diff the trigger reports as not required never runs test/containment.test.ts locally", () => {
  const { spawn, calls } = recordingSpawn({
    "containment-diff-trigger.ts": { status: 0, stdout: "containment-probe: not required for this diff — no changed path touches sandbox/hooks/env/deny-floor.\n" },
  });
  const result = runCiParity(REPO_ROOT, { spawn });

  const probeCalled = calls.some((c) => c.args.some((a) => a.includes("containment.test.ts")));
  assert.equal(probeCalled, false);
  assert.equal(result.steps.find((s) => s.name === "containment-probe:test"), undefined);
});

test("containment-probe job: a diff the trigger reports as REQUIRED does run test/containment.test.ts", () => {
  const { spawn, calls } = recordingSpawn({
    "containment-diff-trigger.ts": { status: 0, stdout: "containment-probe: REQUIRED — touches .claude/settings.json\n" },
  });
  const result = runCiParity(REPO_ROOT, { spawn });

  const probeCalled = calls.some((c) => c.args.some((a) => a.includes("containment.test.ts")));
  assert.ok(probeCalled);
  assert.ok(result.steps.some((s) => s.name === "containment-probe:test" && s.ok));
});

// ── acceptance 5: independent reporting — one failure never blocks a later step ─────────────

test("runCiParity: every table entry's step(s) run and report regardless of an earlier one's outcome — one failure never prevents a later job from running", () => {
  const { spawn } = recordingSpawn({
    "leak-grep.sh": { status: 1, stderr: "found a plaintext secret" },
    jscpd: { status: 1, stderr: "duplication over threshold" },
  });
  const result = runCiParity(REPO_ROOT, { spawn });

  const leakGrep = result.steps.find((s) => s.name === "leak-grep")!;
  const jscpd = result.steps.find((s) => s.name === "jscpd-gate")!;
  assert.equal(leakGrep.ok, false);
  assert.equal(jscpd.ok, false);
  // Every OTHER job's step(s) still ran and reported despite two earlier failures.
  assert.ok(result.steps.some((s) => s.name === "claims" && s.ok));
  assert.ok(result.steps.some((s) => s.name === "depcruise" && s.ok));
  assert.ok(result.steps.some((s) => s.name === "ci-parity:drift" && s.ok));
  assert.equal(result.ok, false, "the overall verdict is red — exit non-zero only after every step reported");
});

test("runCiParity: every step's detail names itself in both directions (PASS/FAIL/EXCLUDED), never legible only as a missing success line", () => {
  const { spawn } = recordingSpawn();
  const result = runCiParity(REPO_ROOT, { spawn });
  for (const step of result.steps) {
    assert.match(step.detail, new RegExp(`^${step.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (PASS|FAIL|EXCLUDED)`), `step '${step.name}' detail does not name itself: ${step.detail}`);
  }
});

// ── acceptance 6: an unavailable toolchain fails loud, never green ──────────────────────────

test("runCiParity: a step whose spawn THROWS (binary missing) is caught and reported as that step's OWN named failure, never aborting the run and never reading as a pass", () => {
  const spawn: PreflightSpawn = (file, args) => {
    if (args.some((a) => a.includes("leak-grep.sh"))) throw new Error("ENOENT: bash not found");
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = runCiParity(REPO_ROOT, { spawn });

  const leakGrep = result.steps.find((s) => s.name === "leak-grep")!;
  assert.equal(leakGrep.ok, false, "an unrunnable toolchain must be a FAILED step, never silently passed");
  assert.match(leakGrep.detail, /toolchain unavailable/, "the step must name WHY it could not run, as a distinct line");
  assert.match(leakGrep.detail, /ENOENT/);
  assert.equal(result.ok, false);

  // The run did not abort — every other job's step(s) are still present and reported.
  assert.ok(result.steps.some((s) => s.name === "claims"));
  assert.ok(result.steps.some((s) => s.name === "depcruise"));
});

test("runCiParity: a spawn that fails for a non-exit reason (status: null, e.g. ENOBUFS) is reported as a spawn failure naming what happened, never as a bare red step with empty output (W1-T338)", () => {
  const spawn: PreflightSpawn = (file, args) => {
    if (args.some((a) => a.includes("leak-grep.sh"))) {
      // This is exactly the shape spawnSync returns when the child never produced an exit
      // status — killed for exceeding a buffer ceiling, ENOENT, etc: `status: null`, and
      // typically thin-to-empty stdout/stderr, with `error` naming why.
      return { status: null, stdout: "", stderr: "", error: "spawnSync bash ENOBUFS" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = runCiParity(REPO_ROOT, { spawn });

  const leakGrep = result.steps.find((s) => s.name === "leak-grep")!;
  assert.equal(leakGrep.ok, false, "a spawn that never exited must never read as a passing step");
  assert.doesNotMatch(
    leakGrep.detail,
    /^leak-grep: FAIL —/,
    "a non-exit spawn failure must not be rendered as an ordinary red test step (that is the ENOBUFS-as-bare-FAIL bug)",
  );
  assert.match(leakGrep.detail, /SPAWN FAILURE/, "the detail must name that the SPAWN failed, distinct from a real test failure");
  assert.match(leakGrep.detail, /ENOBUFS/, "the detail must say WHY — not present empty output as an unexplained failure");
  assert.equal(result.ok, false);
});

test("runCiParity: an entry whose run() ITSELF throws (not just a leaf's spawn inside runStep) is caught by the TOP-LEVEL catch and reported as '<job>:error', never aborting the run", () => {
  // lint-plan's run() calls `spawn("git", ["rev-parse", ...])` directly, OUTSIDE any runStep —
  // a throw there must be caught by runCiParity's own try/catch around entry.run!(), not just
  // the per-leaf one runStep already covers (see the "spawn THROWS" test above).
  const spawn: PreflightSpawn = (file, args) => {
    if (file === "git" && args.includes("rev-parse")) throw new Error("ENOENT: git not found");
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = runCiParity(REPO_ROOT, { spawn });

  const lintPlanError = result.steps.find((s) => s.name === "lint-plan:error");
  assert.ok(lintPlanError, "expected a 'lint-plan:error' step from runCiParity's top-level catch");
  assert.equal(lintPlanError!.ok, false, "an entry.run() throw must never read as a passing step");
  assert.match(lintPlanError!.detail, /toolchain unavailable/, "the top-level catch reuses the SAME toolchainFailure phrasing as a leaf-level throw");
  assert.match(lintPlanError!.detail, /ENOENT/);
  assert.equal(result.ok, false);

  // The run did not abort — later table entries still ran and reported despite lint-plan's throw.
  assert.ok(result.steps.some((s) => s.name === "depcruise"));
  assert.ok(result.steps.some((s) => s.name === "containment-probe:trigger"));
});

// ── acceptance 7: `rmd preflight` with no flag is unchanged; `--ci-parity` is additive ──────

test("preflightCommand: --ci-parity ADDS the ci-parity steps after the three hand-route steps and folds their verdict into the exit code", async () => {
  const spawn: PreflightSpawn = (file, args) => {
    const key = [file, ...args].join(" ");
    if (key.includes("commitlint")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("tsc")) return { status: 0, stdout: "", stderr: "" };
    if (key.includes("git log")) return { status: 0, stdout: "\0feat(x): fine\n", stderr: "" };
    if (args.some((a) => a.includes("leak-grep.sh"))) return { status: 1, stdout: "", stderr: "found a secret" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  let code: number;
  try {
    code = await preflightCommand(["--ci-parity"], { spawn });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1, "a failing ci-parity step must fail the overall command even when the three hand-route steps are clean");
  assert.ok(lines.some((l) => l.includes("typecheck: PASS")), "the hand-route steps still print");
  assert.ok(lines.some((l) => l.includes("leak-grep: FAIL")), "the ci-parity steps print too, under --ci-parity");
  assert.ok(lines.some((l) => l.includes("ci-parity:drift: PASS")));
});

test("preflightCommand: WITHOUT --ci-parity, none of the ci-parity steps run or print — the shipped hand route is untouched", async () => {
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
  assert.equal(lines.some((l) => l.includes("ci-parity")), false, "no ci-parity output at all without the flag");
  assert.deepEqual(
    lines.filter((l) => /^(commitlint|typecheck|emitter-checks):/.test(l)).length,
    3,
    "exactly the three shipped hand-route steps",
  );
});
