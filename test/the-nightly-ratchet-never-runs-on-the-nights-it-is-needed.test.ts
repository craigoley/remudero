import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ── W1-T2514: the nightly ratchet was SKIPPED on every night it was needed ─────────────────────
//
// .github/workflows/mutation-nightly.yml's per-file Stryker loop deliberately runs every planned
// config and carries a failure to the end -- "so one bad file cannot silently shrink the night
// into a smaller (and passing) measurement", per the loop's own (still-true) comment. The bug was
// WHERE it re-raised: `exit "$rc"` at the STEP boundary, with the `--nightly-ratchet` step that
// follows carrying the default `if: success()`. Measured verbatim on two of two failing runs
// inspected (#26 2026-08-24, #31 2026-08-29): `stryker=failure ratchet=skipped`. The re-raise
// achieved its first half (no shrunken measurement ever passed) and destroyed its second (the
// ratchet never judged the files that DID complete) -- so a failing night produced a real report
// artifact and no comparison against it at all.
//
// THE FIX, restated as what this file proves:
//   - `stryker` now carries `continue-on-error: true`. That overrides the step's `conclusion`
//     (what `if: success()` reads) to `success`, while leaving its real `outcome` (what a
//     diagnostic can still read) as `failure` -- so `ratchet` runs regardless.
//   - A new `stryker-guard` step, `if: always() && steps.stryker.outcome == 'failure'`, runs
//     AFTER `ratchet` and turns a swallowed `stryker` failure back into a real job failure. The
//     degrade-LOUDLY polarity (W1-T130) this task is barred from relaxing survives: an errored
//     config still fails the workflow, just after `ratchet` has had its turn.
//   - The `stryker` loop now captures each failing config's identity into `failed_configs`
//     (previously printed to the log and thrown away -- the old diagnostic named only the STEP,
//     never the config) and both the guard step and the `notify` step's diagnostic line read it.
//
// HOW THIS FILE PROVES THE WORKFLOW-LEVEL CLAIMS (1, 2, 4, 8). GitHub Actions has no "dry run"
// this suite can invoke, so `simulateJob` below implements the small, load-bearing slice of its
// step-execution semantics that this fix depends on: a step's default `if:` is `success()`;
// `continue-on-error: true` overrides a failed step's `conclusion` (what `success()`/`failure()`
// read) but never its `outcome`; and an unrecognised `if:` expression THROWS rather than being
// guessed at, so a future edit to a step's `if:` this file does not understand fails loudly
// instead of silently mis-simulating. The steps it simulates are read from the REAL production
// YAML (via the `yaml` package this repo already depends on), not a hand-authored copy -- so a
// regression in the actual file, not a stale fixture, is what these tests would catch.
//
// CLAIM 3 (the diagnostic names every failing config) and the "all configs succeed" half of claim
// 4 are proven a level lower: the `stryker` step's own `run:` script is extracted verbatim from
// the real YAML and executed via `bash -c` against a stub `npx` that fails only for configs whose
// path contains "bad" -- real shell execution, not a regex over the script text.
//
// CLAIMS 5, 6 and 7 (vacuous / invalid / missing-baseline refusal) exercise
// scripts/mutation-ratchet.mjs's `--nightly-ratchet` CLI directly, against the same fixtures
// test/mutation-per-file-runner.test.ts and test/mutation-report-validity.test.ts already prove
// this behaviour with -- restated here because this task's acceptance ties every claim to THIS
// file, not because the guard itself changed: W1-T2514 changes ordering and reporting only, never
// the ratchet script's refusal polarity.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mutation-nightly.yml");
const SCRIPT = join(REPO_ROOT, "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");

// ── Read the REAL production workflow, not a copy ───────────────────────────────────────────────

type RawStep = {
  id?: string;
  if?: string;
  run?: string;
  "continue-on-error"?: boolean;
};

type WorkflowDoc = {
  jobs: Record<string, { steps: RawStep[] }>;
};

const workflowDoc = parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as WorkflowDoc;
const rawSteps: RawStep[] = workflowDoc.jobs["mutation-nightly"].steps;

type StepDef = { id?: string; if?: string; continueOnError: boolean };

const steps: StepDef[] = rawSteps.map((s) => ({
  id: s.id,
  if: s.if,
  continueOnError: s["continue-on-error"] === true,
}));

function extractRunScript(id: string): string {
  const step = rawSteps.find((s) => s.id === id);
  if (!step?.run) throw new Error(`the real workflow has no run: script for step id=${id}`);
  return step.run;
}

// ── A minimal, self-checking model of the GitHub Actions step-execution semantics this fix
//    depends on -- see the header comment above for what it deliberately does and does not model.

type StepResult = {
  ran: boolean;
  outcome: "success" | "failure" | "skipped";
  conclusion: "success" | "failure" | "skipped";
};

function evalIf(expr: string, ctx: { jobFailed: boolean; results: Record<string, StepResult> }): boolean {
  const trimmed = expr.trim();
  if (trimmed === "success()") return !ctx.jobFailed;
  if (trimmed === "failure()") return ctx.jobFailed;
  if (trimmed === "always()") return true;
  const compound = trimmed.match(/^always\(\)\s*&&\s*steps\.([\w-]+)\.outcome\s*==\s*'([^']+)'$/);
  if (compound) {
    const [, stepId, wantOutcome] = compound;
    return ctx.results[stepId]?.outcome === wantOutcome;
  }
  throw new Error(
    `simulateJob: unsupported "if:" expression -- extend evalIf() deliberately rather than guessing: ${JSON.stringify(expr)}`,
  );
}

// `stryker-guard`'s own `run:` body is an UNCONDITIONAL `exit 1` -- its `if:` already restricts it
// to the case where `stryker` actually failed, so reaching it at all means failing. That is a fact
// about its body, not an externally injected scenario, so it is modeled here rather than folded
// into `failingStepIds` -- keeping `failingStepIds` reserved for "which config errored tonight".
const STEPS_THAT_ALWAYS_FAIL_WHEN_THEY_RUN = new Set(["stryker-guard"]);

/**
 * Simulate one job run: steps in order, each gated by its own `if:` (defaulting to `success()`),
 * `continue-on-error: true` overriding a failing step's `conclusion` (not its `outcome`). Steps
 * with no `id` (checkout, setup-node, the two `find` listing steps) are not separately modeled --
 * none of them are in `failingStepIds` in any scenario below, so they always succeed and never
 * move `jobFailed`.
 */
function simulateJob(jobSteps: readonly StepDef[], failingStepIds: ReadonlySet<string>): Record<string, StepResult> {
  const results: Record<string, StepResult> = {};
  let jobFailed = false;
  for (const step of jobSteps) {
    if (!step.id) continue;
    const ran = evalIf(step.if ?? "success()", { jobFailed, results });
    if (!ran) {
      results[step.id] = { ran: false, outcome: "skipped", conclusion: "skipped" };
      continue;
    }
    const didFail = failingStepIds.has(step.id) || STEPS_THAT_ALWAYS_FAIL_WHEN_THEY_RUN.has(step.id);
    const outcome: StepResult["outcome"] = didFail ? "failure" : "success";
    const conclusion: StepResult["conclusion"] = didFail && !step.continueOnError ? "failure" : "success";
    if (conclusion === "failure") jobFailed = true;
    results[step.id] = { ran: true, outcome, conclusion };
  }
  return results;
}

// ── Claim: "the nightly ratchet runs and judges the files that completed, even when another
//    config errored" ──────────────────────────────────────────────────────────────────────────

test("claim: the nightly ratchet runs and judges the files that completed, even when another config errored", () => {
  const results = simulateJob(steps, new Set(["stryker"]));
  assert.equal(results.ratchet?.ran, true, "ratchet must run even though stryker's step outcome is failure");
  assert.equal(results.ratchet?.conclusion, "success", "ratchet itself is not the one that failed");
});

// ── Claim: "a night with an errored config still fails the workflow -- the polarity is
//    unchanged" ───────────────────────────────────────────────────────────────────────────────

test("claim: a night with an errored config still fails the workflow -- the polarity is unchanged", () => {
  const results = simulateJob(steps, new Set(["stryker"]));
  // continue-on-error hides the failure from the JOB's success()/failure() context...
  assert.equal(results.stryker?.outcome, "failure", "the real outcome must still say the config errored");
  assert.equal(results.stryker?.conclusion, "success", "continue-on-error overrides the conclusion, not the outcome");
  // ...but the guard step reads the real outcome and turns the job red again, after ratchet ran.
  assert.equal(results["stryker-guard"]?.ran, true, "the guard step must run to catch the swallowed failure");
  assert.equal(results["stryker-guard"]?.conclusion, "failure", "an errored config must still redden the job");
});

// ── Claim: "a night where every config succeeds behaves exactly as it does today" ───────────────

test("claim: a night where every config succeeds behaves exactly as it does today (workflow ordering)", () => {
  const results = simulateJob(steps, new Set());
  assert.equal(results.stryker?.conclusion, "success");
  assert.equal(results.ratchet?.ran, true);
  assert.equal(results.ratchet?.conclusion, "success");
  assert.equal(results["stryker-guard"]?.ran, false, "the new guard step must stay dormant on a clean night");
});

// ── Claim: "restoring the step-boundary re-raise makes the ratchet-ran assertion fail" ──────────

test("claim: restoring the step-boundary re-raise makes the ratchet-ran assertion fail", () => {
  // The bug this task fixes, reproduced structurally: drop continue-on-error from `stryker` (the
  // old `exit "$rc"`-at-the-step-boundary shape) and nothing else.
  const reverted = steps.map((s) => (s.id === "stryker" ? { ...s, continueOnError: false } : s));
  const fixed = simulateJob(steps, new Set(["stryker"]));
  const oldShape = simulateJob(reverted, new Set(["stryker"]));
  assert.equal(fixed.ratchet?.ran, true, "sanity: the actual fixed workflow makes ratchet run");
  assert.equal(
    oldShape.ratchet?.ran,
    false,
    "the pre-fix shape (step-boundary re-raise, no continue-on-error) must reproduce runs #26/#31's ratchet=skipped",
  );
});

test("the real production workflow gives the Stryker loop continue-on-error rather than a step-boundary re-raise", () => {
  const strykerStep = steps.find((s) => s.id === "stryker");
  assert.equal(strykerStep?.continueOnError, true);
});

// ── Claim: "the diagnostic line names every config that exited non-zero, not just the step" ────
//
// Proven by REAL shell execution: the `stryker` step's own `run:` script, extracted verbatim from
// the production YAML with its `${{ steps.plan.outputs.configs }}` template swapped for a shell
// variable (the same literal substitution GitHub Actions itself performs before invoking bash),
// run against a stub `npx` on PATH that fails only for a config path containing "bad".

const STRYKER_RUN_SCRIPT = extractRunScript("stryker").replace(
  "${{ steps.plan.outputs.configs }}",
  "$CONFIGS",
);

function runStrykerLoopScript(configs: string): { status: number | null; githubOutput: string } {
  const workDir = mkdtempSync(join(tmpdir(), "mutation-nightly-stryker-loop-"));
  const binDir = mkdtempSync(join(tmpdir(), "mutation-nightly-fake-npx-"));
  const npxPath = join(binDir, "npx");
  writeFileSync(
    npxPath,
    // Called as `npx stryker run "$cfg"` -- $1=stryker $2=run $3=the config path.
    ["#!/usr/bin/env bash", 'case "$3" in', "  *bad*) exit 1 ;;", "  *) exit 0 ;;", "esac", ""].join("\n"),
  );
  chmodSync(npxPath, 0o755);
  const outputFile = join(workDir, "github-output.txt");
  writeFileSync(outputFile, "");

  const result = spawnSync("bash", ["-c", STRYKER_RUN_SCRIPT], {
    cwd: workDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CONFIGS: configs,
      GITHUB_OUTPUT: outputFile,
    },
  });
  return { status: result.status, githubOutput: readFileSync(outputFile, "utf8") };
}

test("claim: the diagnostic line names every config that exited non-zero, not just the step", () => {
  const { status, githubOutput } = runStrykerLoopScript("good.stryker.json bad.stryker.json");
  assert.notEqual(status, 0, "one bad config must still fail the loop's own step (before continue-on-error swallows it)");
  const failedLine = githubOutput.split("\n").find((l) => l.startsWith("failed_configs="));
  assert.ok(failedLine, `expected a failed_configs= line in $GITHUB_OUTPUT, got:\n${githubOutput}`);
  assert.match(failedLine!, /bad\.stryker\.json/);
  assert.doesNotMatch(failedLine!, /good\.stryker\.json/, "only the config(s) that actually errored may be named");
});

test("a night where every config succeeds -- the loop's own script exits zero and names nothing failed", () => {
  const { status, githubOutput } = runStrykerLoopScript("good-one.stryker.json good-two.stryker.json");
  assert.equal(status, 0, githubOutput);
  const failedLine = githubOutput.split("\n").find((l) => l.startsWith("failed_configs="));
  assert.equal(failedLine, "failed_configs=");
});

// ── Claims 5, 6, 7: the ratchet script's existing degrade-loudly refusals are untouched ─────────

function runNightlyRatchet(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--nightly-ratchet", ...args]);
}

test('claim: the ratchet still refuses a vacuous report -- no file judged is not a smaller measurement', () => {
  const emptyReportDir = mkdtempSync(join(tmpdir(), "mutation-nightly-vacuous-"));
  const result = runNightlyRatchet([
    "--report-dir",
    emptyReportDir,
    "--baseline",
    join(FIXTURES, "nightly-baseline-zero.json"),
  ]);
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED -- VACUOUS RUN/);
});

test("claim: the ratchet still refuses an invalid report, naming each file that caught nothing", () => {
  const result = runNightlyRatchet([
    "--report",
    join(FIXTURES, "real-runner-unreached.json"),
    "--baseline",
    join(FIXTURES, "nightly-baseline-zero.json"),
    "--mutate-scope",
    "src/lib/dispatch-governor.ts",
  ]);
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED -- INVALID RUN/);
  assert.match(result.stderr.toString(), /src\/lib\/dispatch-governor\.ts -- 36 valid mutant\(s\), 0 caught/);
});

test('claim: a report missing its nightly baseline section still refuses rather than passing', () => {
  const result = runNightlyRatchet([
    "--report",
    join(FIXTURES, "above-baseline.json"),
    "--baseline",
    join(FIXTURES, "nightly-baseline-missing-section.json"),
  ]);
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED.*no "nightly" section/);
});
