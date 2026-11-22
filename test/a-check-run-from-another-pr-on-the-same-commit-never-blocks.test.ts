/**
 * W1-T14176: a check run from another PR on the same commit never blocks.
 *
 * On 2026-11-21 PR #20016 was first pushed with the same head commit as PR #20014. #20016's own
 * commitlint and proof-discrimination runs failed on that commit, later than #20014's green runs,
 * and #20014's ci-gate read every check run on the commit, so it held #20014 for #20016's reds.
 *
 * These tests drive the REAL aggregation step from ci-gate.yml (read from the file, never re-typed)
 * with a fake `gh` that answers the check-runs read and the workflow-runs read from separate
 * fixtures. The last tests run it through scripts/ci-gate-from-contract.mjs, the entry ci.yml uses,
 * and check that both ci-gate jobs pass the step its event and head branch.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GATE_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");
const CI_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RUNNER = join(REPO_ROOT, "scripts", "ci-gate-from-contract.mjs");
const SHA = "d7d80c5a7d80c5a7d80c5a7d80c5a7d80c5a7d80";
const THIS = "this-branch";
const OTHER = "other-branch";

type Job = { env?: Record<string, string>; permissions?: Record<string, string>; steps?: Array<{ run?: string }> };
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> };

function gateStep(): string {
  const doc = parseYaml(readFileSync(GATE_PATH, "utf8")) as Workflow;
  const step = (doc.jobs["ci-gate"]!.steps ?? []).find((s) => typeof s.run === "string" && s.run.includes("runs_json"));
  assert.ok(step?.run, "ci-gate.yml's ci-gate job must have the step that defines runs_json()");
  return step.run;
}

/** The workflow runs on the shared commit: two of this branch's, two of the other branch's. */
const WORKFLOW_RUNS = [
  { id: 101, head_branch: THIS, check_suite_id: 9001, name: "pr-title-lint" },
  { id: 102, head_branch: THIS, check_suite_id: 9002, name: "CI" },
  { id: 201, head_branch: OTHER, check_suite_id: 9101, name: "pr-title-lint" },
  { id: 202, head_branch: OTHER, check_suite_id: 9102, name: "CI" },
];

/** Both PRs on the commit, as GitHub lists them on a shared head: this field cannot say whose run it is. */
const BOTH_PRS = [{ number: 20014 }, { number: 20016 }];

type Row = { id: number; name: string; conclusion: string | null; status?: string; started_at: string; suite: number; external_id?: string };

function checkRun(row: Row) {
  return {
    id: row.id, name: row.name, status: row.status ?? "completed", conclusion: row.conclusion, started_at: row.started_at,
    external_id: row.external_id ?? "", check_suite: { id: row.suite }, pull_requests: BOTH_PRS,
  };
}

const ownCommitlintSuccess: Row = { id: 1, name: "commitlint", conclusion: "success", started_at: "2026-11-21T13:00:00Z", suite: 9001 };
const otherCommitlintFailure: Row = { id: 2, name: "commitlint", conclusion: "failure", started_at: "2026-11-21T13:21:00Z", suite: 9101 };
const ownCommitlintFailure: Row = { id: 3, name: "commitlint", conclusion: "failure", started_at: "2026-11-21T13:00:00Z", suite: 9001 };
const otherCommitlintSuccess: Row = { id: 4, name: "commitlint", conclusion: "success", started_at: "2026-11-21T13:21:00Z", suite: 9101 };

type Run = { status: number | null; out: string; calls: string[] };

function gateEnv(shimDir: string, required: string[], over: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    GH_TOKEN: "fake-token",
    REPO: "example/example",
    SHA,
    REQUIRED: JSON.stringify(required),
    IGNORE: JSON.stringify(["ci-gate"]),
    GATE_EVENT: "pull_request",
    HEAD_REF: THIS,
    GRACE_WINDOW_SECONDS: "0",
    GRACE_POLL_INTERVAL_SECONDS: "0",
    WAIT_CAP_SECONDS: "0",
    RETRY_BACKOFF_SECONDS: "0",
    ...over,
  };
}

function routes(rows: Row[], workflowRuns: GhShimRoute | object[] = WORKFLOW_RUNS): GhShimRoute[] {
  const runsRoute = Array.isArray(workflowRuns)
    ? { when: "actions/runs", stdout: JSON.stringify([{ total_count: workflowRuns.length, workflow_runs: workflowRuns }]) }
    : workflowRuns;
  return [runsRoute, { when: "check-runs", stdout: JSON.stringify([{ check_runs: rows.map(checkRun) }]) }];
}

/** Runs the real ci-gate.yml step under bash, the way the ci-gate.yml job does. */
function runStep(rows: Row[], required: string[], over: Record<string, string> = {}, workflowRuns?: GhShimRoute | object[]): Run {
  const shim = ghShim(routes(rows, workflowRuns), { kind: "w1t14176" });
  const r = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", gateStep()], {
    encoding: "utf8",
    env: gateEnv(shim.dir, required, over),
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls: shim.calls() };
}

/** Runs the step through scripts/ci-gate-from-contract.mjs, the entry ci.yml's ci-gate job uses. */
function runRunner(rows: Row[], required: string[], over: Record<string, string> = {}): Run {
  const shim = ghShim(routes(rows), { kind: "w1t14176-runner" });
  const r = spawnSync(process.execPath, [RUNNER, "--event", over.GATE_EVENT ?? "pull_request"], {
    encoding: "utf8",
    env: gateEnv(shim.dir, required, over),
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls: shim.calls() };
}

function gatedList(out: string): string {
  const at = out.indexOf("--- gated check runs ---");
  assert.ok(at >= 0, `the step must print its gated list:\n${out}`);
  return out.slice(at);
}

test("W1-T14176 criterion 1: a later commitlint failure from another branch's run on the same commit does not block; this branch's success is the gated row", () => {
  const r = runStep([ownCommitlintSuccess, otherCommitlintFailure], ["commitlint"]);
  assert.equal(r.status, 0, r.out);
  assert.match(gatedList(r.out), /^ {2}success\tcommitlint$/m);
  assert.doesNotMatch(gatedList(r.out), /failure\tcommitlint/);
  assert.match(r.out, /merge may proceed\./);
  assert.ok(r.calls.some((c) => c.includes(`repos/example/example/actions/runs?head_sha=${SHA}`)), "the step reads the workflow runs on the commit");
  // The old read, which the design rejects: with no branch filter the other branch's later failure wins.
  const unfiltered = runStep([ownCommitlintSuccess, otherCommitlintFailure], ["commitlint"], { GATE_EVENT: "" });
  assert.equal(unfiltered.status, 1, unfiltered.out);
  assert.match(unfiltered.out, /required check\(s\) FAILED — holding merge:\n {2}- commitlint/);
});

test("W1-T14176 criterion 2: this branch's own commitlint failure still blocks and is named, even with a later success from another branch's run", () => {
  const r = runStep([ownCommitlintFailure, otherCommitlintSuccess], ["commitlint"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::ci-gate: required check\(s\) FAILED — holding merge:\n {2}- commitlint/);
  assert.match(gatedList(r.out), /^ {2}failure\tcommitlint$/m);
  assert.doesNotMatch(r.out, /merge may proceed\./);
});

test("W1-T14176 criterion 3: a posted check run counts only when the run in its external_id is this branch's", () => {
  const posted = (run: number): Row => ({
    id: 10, name: "proof-discrimination", conclusion: "failure", started_at: "2026-11-21T13:22:00Z",
    // The checks API can file a posted row in any suite, so the suite here is one of this branch's.
    suite: 9002, external_id: `run:${run}:1:job:136858926491`,
  });
  const ownPass: Row = { id: 11, name: "proof-discrimination", conclusion: "success", started_at: "2026-11-21T13:05:00Z", suite: 9002, external_id: "run:102:1:job:5001" };

  const foreign = runStep([ownPass, posted(202)], ["proof-discrimination"]);
  assert.equal(foreign.status, 0, foreign.out);
  assert.doesNotMatch(gatedList(foreign.out), /failure\tproof-discrimination/);

  const own = runStep([ownPass, posted(102)], ["proof-discrimination"]);
  assert.equal(own.status, 1, own.out);
  assert.match(own.out, /holding merge:\n {2}- proof-discrimination/);
});

test("W1-T14176 criterion 4: a required check present only from another branch's runs is not ready, and the wait ends TIMED OUT, never a pass", () => {
  const r = runStep([ownCommitlintSuccess, { ...otherCommitlintSuccess, id: 5, name: "lint-plan" }], ["commitlint", "lint-plan"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::ci-gate: TIMED OUT waiting for required check\(s\) to complete/);
  assert.match(r.out, /^ {2}- lint-plan$/m);
  assert.doesNotMatch(r.out, /merge may proceed\./);
});

test("W1-T14176 criterion 5: an empty HEAD_REF on a pull_request event fails closed with a named error", () => {
  const r = runStep([ownCommitlintSuccess], ["commitlint"], { HEAD_REF: "" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::ci-gate: HEAD_REF is EMPTY on a pull_request event/);
  assert.doesNotMatch(r.out, /merge may proceed\./);
  assert.equal(r.calls.length, 0, "it refuses before any read");
});

test("W1-T14176 criterion 5: a workflow-runs read that fails on every retry exits 1 with a named error, never a pass", () => {
  const r = runStep([ownCommitlintSuccess], ["commitlint"], {}, { when: "actions/runs", stderr: "HTTP 502", exit: 1 });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /workflow-runs read FAILED \(attempt 1\/3\)/);
  assert.match(r.out, /::error::ci-gate: could NOT READ the workflow-runs API after 3 attempt\(s\)/);
  assert.doesNotMatch(r.out, /merge may proceed\./);
  assert.equal(r.calls.filter((c) => c.includes("actions/runs")).length, 3);
});

test("W1-T14176 criterion 5: on a merge_group event no branch filter applies and no workflow-runs read is made", () => {
  const r = runStep([ownCommitlintSuccess, otherCommitlintFailure], ["commitlint"], { GATE_EVENT: "merge_group", HEAD_REF: "" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /holding merge:\n {2}- commitlint/);
  assert.equal(r.calls.filter((c) => c.includes("actions/runs")).length, 0);
});

test("W1-T14176 criterion 5: a check run whose suite is no workflow run's (another app) is kept, and its failure still blocks", () => {
  const otherApp: Row = { id: 7, name: "License Review", conclusion: "failure", started_at: "2026-11-21T13:30:00Z", suite: 7777 };
  const r = runStep([ownCommitlintSuccess, otherApp], ["commitlint", "License Review"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /holding merge:\n {2}- License Review/);
});

test("W1-T14176: ci.yml's entry, scripts/ci-gate-from-contract.mjs, applies the same branch filter", () => {
  const pass = runRunner([ownCommitlintSuccess, otherCommitlintFailure], ["commitlint"]);
  assert.equal(pass.status, 0, pass.out);
  assert.match(gatedList(pass.out), /^ {2}success\tcommitlint$/m);
  const held = runRunner([ownCommitlintFailure, otherCommitlintSuccess], ["commitlint"]);
  assert.equal(held.status, 1, held.out);
  assert.match(held.out, /holding merge:\n {2}- commitlint/);
});

test("W1-T14176: both ci-gate jobs give the step the event and the PR's head branch, and may read workflow runs", () => {
  const gate = parseYaml(readFileSync(GATE_PATH, "utf8")) as Workflow;
  const ci = parseYaml(readFileSync(CI_PATH, "utf8")) as Workflow;
  const gateEnvBlock = gate.jobs["ci-gate"]!.env!;
  assert.equal(gateEnvBlock.GATE_EVENT, "${{ github.event_name }}");
  assert.equal(gateEnvBlock.HEAD_REF, "${{ github.event.pull_request.head.ref }}");
  assert.equal(gate.permissions?.actions, "read");
  const ciJob = ci.jobs["ci-gate"]!;
  assert.equal(ciJob.env!.GATE_EVENT, "${{ github.event_name }}");
  assert.equal(ciJob.env!.HEAD_REF, "${{ github.event.pull_request.head.ref || '' }}");
  assert.equal(ciJob.permissions?.actions, "read");
});
