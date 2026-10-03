import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// W1-T5368 — ci.yml's `commitlint` check run is the AND of two UNRELATED steps: the PR-title lint and
// the `rule-checks` step (the tree-derived census and ratchet suites, W1-T4433). W1-T3720 titles a
// bundled check by the gate that refused, but this bundle was posted from two BARE outcomes, and a
// bare outcome's id is the check's own name — so a red census suite was still titled `commitlint`.
// These tests EXECUTE the real workflow steps (the rule-checks step and the reporting step) under
// bash with stubbed `node`/`gh`, so a later edit to either is what they check.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { id?: string; env?: Record<string, string>; run?: string };

function commitlintSteps(): Step[] {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { commitlint: { steps: Step[] } };
  };
  return workflow.jobs.commitlint.steps;
}

/** Run the REAL rule-checks step the way Actions runs an unspecified-shell step (`bash -e`, NO pipefail),
 *  with `node` stubbed to print `report` and exit `exitCode`. Returns the step's status and its teed log. */
function runRuleChecksStep(report: string, exitCode: number): { status: number | null; log: string | undefined } {
  const step = commitlintSteps().find((s) => s.id === "rule-checks");
  assert.ok(step?.run, "ci.yml's commitlint job must carry the rule-checks step");
  const runnerTemp = mkdtempSync(join(tmpdir(), "rmd-rule-checks-step-"));
  try {
    const stub = `node() { printf '%s\\n' "$STUB_REPORT"; return "$STUB_EXIT"; }\n`;
    const run = spawnSync("bash", ["-e", "-c", stub + step.run], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: runnerTemp, STUB_REPORT: report, STUB_EXIT: String(exitCode) },
    });
    const logPath = join(runnerTemp, "gate-reports", "rule-checks.log");
    return { status: run.status, log: existsSync(logPath) ? readFileSync(logPath, "utf8") : undefined };
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

/** Run the REAL reporting step with a recording `gh` stub; return the posted `commitlint` check run. */
function postedCommitlint(outcomes: Record<string, string>, reports: Record<string, string>): { name: string; conclusion: string; title: string } | undefined {
  const reporter = commitlintSteps().find((s) => s.run?.includes("report()"));
  assert.ok(reporter?.run && reporter.env, "ci.yml's commitlint job must carry the report() step");
  const root = mkdtempSync(join(tmpdir(), "rmd-commitlint-report-"));
  try {
    for (const [id, text] of Object.entries(reports)) writeFileSync(join(root, `${id}.log`), text);
    const logFile = join(root, "calls");
    writeFileSync(logFile, "");
    const stub = `gh() { printf '%s\\n' "$*" >> "$GH_LOG_FILE"; }\nsleep() { :; }\n`;
    const outcomeEnv = Object.fromEntries(Object.keys(reporter.env).filter((k) => k.startsWith("OUTCOME_")).map((k) => [k, outcomes[k] ?? "success"]));
    const run = spawnSync("bash", ["-c", stub + reporter.run], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...outcomeEnv, GITHUB_REPOSITORY: "owner/repo", HEAD_SHA: "abc123", POSTING_JOB_ID: "1", GATE_REPORT_DIR: root, GH_LOG_FILE: logFile },
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({
        name: /-f name=(\S+) /.exec(line)?.[1] ?? "",
        conclusion: /-f conclusion=(\S+) /.exec(line)?.[1] ?? "",
        title: /-f output\[title\]=(.*?) -f output\[summary\]=/.exec(line)?.[1] ?? "",
      }))
      .find((c) => c.name === "commitlint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T5368: a failing rule-checks step with a passing commitlint is titled rule-checks, and the check name stays commitlint", () => {
  // FALSIFIER: with the bare `report "commitlint" "${OUTCOME_COMMITLINT}" "${OUTCOME_RULE_CHECKS}"`
  // the failing rule-checks outcome's id is the check name, so this title reads `commitlint`.
  assert.deepEqual(postedCommitlint({ OUTCOME_RULE_CHECKS: "failure" }, {}), { name: "commitlint", conclusion: "failure", title: "rule-checks" });
  // A rule-checks report that names the refusing suite's gate BLOCKED titles the check by that gate.
  assert.deepEqual(
    postedCommitlint({ OUTCOME_RULE_CHECKS: "failure" }, { "rule-checks": "clock-signature-census: BLOCKED -- 2 new signature(s)\n" }),
    { name: "commitlint", conclusion: "failure", title: "clock-signature-census" },
  );
  // The PR-title half is still named commitlint, and both halves failing name both.
  assert.deepEqual(postedCommitlint({ OUTCOME_COMMITLINT: "failure" }, {}), { name: "commitlint", conclusion: "failure", title: "commitlint" });
  assert.deepEqual(postedCommitlint({ OUTCOME_COMMITLINT: "failure", OUTCOME_RULE_CHECKS: "failure" }, {}), {
    name: "commitlint",
    conclusion: "failure",
    title: "commitlint, rule-checks",
  });
  assert.deepEqual(postedCommitlint({}, {}), { name: "commitlint", conclusion: "success", title: "commitlint" });
});

test("W1-T5368: the rule-checks step tees its report under pipefail, so its outcome is unchanged", () => {
  const red = runRuleChecksStep("clock-signature-census: BLOCKED -- 2 new signature(s)", 1);
  // Without the step's own `set -o pipefail`, `tee` exits 0 and a red population would read green.
  assert.notEqual(red.status, 0, "a failing rule-checks population must still fail the step");
  assert.equal(red.log, "clock-signature-census: BLOCKED -- 2 new signature(s)\n", "the report is teed where the reporter reads it");
  const green = runRuleChecksStep("rule-checks: OK", 0);
  assert.equal(green.status, 0);
  assert.equal(green.log, "rule-checks: OK\n");

  // End to end: the teed log, read back by the real reporting step, names the refusing gate.
  assert.deepEqual(postedCommitlint({ OUTCOME_RULE_CHECKS: "failure" }, { "rule-checks": red.log ?? "" }), {
    name: "commitlint",
    conclusion: "failure",
    title: "clock-signature-census",
  });
});
