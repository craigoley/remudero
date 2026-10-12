import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Config } from "../src/lib/config.js";
import {
  buildSweepEffects, classifyMergeRefusal, runSweep, type ArmedStalledPr, type OpenPrView, type RollupCheckEntry, type SweepDeps,
} from "./helpers/sweep-test.js";
import { ghShim } from "./helpers/gh-shim.js";

const HEAD = "8620862086208620862086208620862086208620";
const TASK = "W1-T8620";
const PR_URL = "https://github.com/craigoley/remudero/pull/8620";
const GATE_REFUSAL = 'gh: Required status check "ci-gate" is failing. (HTTP 405)';
const TEST_REFUSAL = 'gh: Required status check "test" is failing. (HTTP 405)';
const REQUIRED = ["ci-gate", "test", "lint"];

// #11096's mergeability: the sweep's snapshot read it unknown on every refused pass.
function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 8620, prUrl: PR_URL, taskId: TASK, headSha: HEAD, headRefName: "run-W1-T8620-1",
    autoMergeArmed: true, reviewState: "success", checksState: "green",
    mergeable: undefined, mergeableState: "unknown",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

const job = (run: number, id: number) => `https://github.com/craigoley/remudero/actions/runs/${run}/job/${id}`;

// The #11096 shape: ci-gate's one run failed at 14:14Z; the CI run it gates passed at 14:23Z.
const GATE_OLDER_THAN_INPUTS: RollupCheckEntry[] = [
  { name: "ci-gate", conclusion: "FAILURE", workflowId: 9, workflowRunId: 38259738068, checkRunId: 11,
    startedAt: "2026-10-12T14:00:25Z", completedAt: "2026-10-12T14:14:00Z", detailsUrl: job(38259738068, 900001) },
  { name: "test", conclusion: "SUCCESS", workflowId: 3, workflowRunId: 38259941644, checkRunId: 12,
    startedAt: "2026-10-12T14:01:59Z", completedAt: "2026-10-12T14:23:17Z", detailsUrl: job(38259941644, 900002) },
  { name: "lint", conclusion: "SUCCESS", workflowId: 3, workflowRunId: 38259941644, checkRunId: 13,
    startedAt: "2026-10-12T14:01:59Z", completedAt: "2026-10-12T14:05:00Z", detailsUrl: job(38259941644, 900003) },
];

// W1-T4908's shape: `test` run 100 failed, then run 101 of the same check passed on the same head.
const SUPERSEDED: RollupCheckEntry[] = [
  { name: "test", conclusion: "FAILURE", workflowId: 3, workflowRunId: 100, checkRunId: 21,
    startedAt: "2026-10-12T09:00:00Z", completedAt: "2026-10-12T09:20:00Z", detailsUrl: job(100, 700001) },
  { name: "test", conclusion: "SUCCESS", workflowId: 3, workflowRunId: 101, checkRunId: 22,
    startedAt: "2026-10-12T10:00:00Z", completedAt: "2026-10-12T10:20:00Z", detailsUrl: job(101, 700002) },
  { name: "ci-gate", conclusion: "SUCCESS", workflowId: 9, workflowRunId: 102, checkRunId: 23,
    startedAt: "2026-10-12T10:00:00Z", completedAt: "2026-10-12T10:21:00Z", detailsUrl: job(102, 700003) },
];

// A real red: ci-gate concluded AFTER its inputs, and one of them failed.
const REAL_RED: RollupCheckEntry[] = [
  { name: "ci-gate", conclusion: "FAILURE", workflowId: 9, workflowRunId: 300, checkRunId: 31,
    startedAt: "2026-10-12T11:00:00Z", completedAt: "2026-10-12T11:30:00Z", detailsUrl: job(300, 800001) },
  { name: "test", conclusion: "FAILURE", workflowId: 3, workflowRunId: 301, checkRunId: 32,
    startedAt: "2026-10-12T11:00:00Z", completedAt: "2026-10-12T11:25:00Z", detailsUrl: job(301, 800002) },
  { name: "lint", conclusion: "SUCCESS", workflowId: 3, workflowRunId: 301, checkRunId: 33,
    startedAt: "2026-10-12T11:00:00Z", completedAt: "2026-10-12T11:05:00Z", detailsUrl: job(301, 800003) },
];

function harness(t: TestContext, refusal: string, rollup: RollupCheckEntry[] | undefined) {
  const root = mkdtempSync(join(tmpdir(), "rmd-refused-green-merge-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  // GitHub's own fresh read at merge time is mergeable: the refusal is the required check, not a conflict.
  const live = { state: "open", merged: false, auto_merge: {} as unknown, draft: false,
    head: { sha: HEAD }, base: { ref: "main" }, mergeable: true as boolean | null, mergeable_state: "blocked", body: "" };
  const shim = ghShim([
    { when: "/merge", exit: 1, stderr: refusal },
    { when: "/update-branch", stdout: "{}" },
    { when: "/files", stdout: '[{"filename":"src/example.ts"}]' },
    { when: "/compare/", stdout: '{"behind_by":0}' },
    { when: "/rules/branches/main", stdout: "[]" },
    { when: "/pulls/8620", stdout: JSON.stringify(live) },
  ], { kind: "refused-green-merge-gh" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "refused-green-merge", plan: { tasks: [], byId: new Map() },
    log: (step, fields = {}) => { logs.push({ step, fields }); },
    armSessionPrsOverride: true, spawnWallClockBoundMsOverride: 1,
  });
  const updates: ArmedStalledPr[] = [];
  const escalations: string[] = [];
  const requeues: Array<{ name: string; jobId?: string }> = [];
  const deps: SweepDeps = {
    arm: effects.arm, close: () => {}, dispatchFix: () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    ledgerPath, runId: "refused-green-merge", readLedgerUnion: () => ({ complete: false, lines: [] }),
    updateBranch: (target) => { updates.push(target); return "updated"; },
    readCiGateRollup: () => rollup,
    readCiGateRequired: () => REQUIRED,
    requeueCheck: (_pr, check) => { requeues.push({ name: check.name, jobId: check.jobId }); return true; },
  };
  appendLedger(ledgerPath, { step: "review.posted", run_id: "review", task_id: TASK, head_sha: HEAD,
    state: "success", capped: false, plan_only: false, proof_exec: ["executed_pass"] });
  const pass = (view = pr(), overrides: Partial<SweepDeps> = {}) =>
    withLiveWritesAllowed(() => runSweep([view], { ...deps, ...overrides }));
  const rows = (step: string) => readLedgerLines(ledgerPath).filter(row => row.step === step);
  const merges = () => shim.calls().filter(call => call.includes("/pulls/8620/merge"));
  return { pass, rows, merges, logs, updates, escalations, requeues };
}

test("W1-T8620: a refused direct merge records GitHub refusal text on the ledger", async t => {
  const h = harness(t, GATE_REFUSAL, GATE_OLDER_THAN_INPUTS);
  await h.pass();
  await h.pass();
  assert.equal(h.merges().length, 1, "the second idle sighting attempted the direct merge");
  const failed = h.logs.filter(l => l.step === "automerge.arm_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].fields.outcome, "direct-merge-failed");
  assert.match(String(failed[0].fields.error), /Required status check "ci-gate" is failing\. \(HTTP 405\)/);
  const refused = h.rows("automerge.armed_idle_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].outcome, "direct-merge-failed");
  assert.match(String(refused[0].error), /Required status check "ci-gate" is failing\. \(HTTP 405\)/);
});

test("W1-T8620: the 11096 shape re-runs the stale ci-gate job once", async t => {
  const h = harness(t, GATE_REFUSAL, GATE_OLDER_THAN_INPUTS);
  await h.pass();
  await h.pass();
  assert.deepEqual(h.requeues, [{ name: "ci-gate", jobId: "900001" }], "the stale ci-gate job, never the whole run");
  const rerun = h.rows("automerge.stale_check_rerun");
  assert.equal(rerun.length, 1);
  assert.equal(rerun[0].check_name, "ci-gate");
  assert.equal(rerun[0].head_sha, HEAD);
  assert.equal(rerun[0].shape, "gate-older-than-inputs");
  assert.equal(rerun[0].stale_run_id, 38259738068);
  assert.equal(rerun[0].outranked_by_run_id, 38259941644);
  assert.equal(rerun[0].job_id, "900001");
  assert.match(String(rerun[0].refusal), /Required status check "ci-gate" is failing/);
  assert.equal(h.updates.length, 0, "no fresh sha: mergeability read unknown and a stale check is re-run, not refreshed");
  assert.equal(h.escalations.length, 0);
  const disposed = h.rows("sweep.disposed").at(-1);
  assert.match(String(disposed?.stand_down_reason),
    /direct-merge-failed; stale-check ci-gate \(run 38259738068 concluded before its gated test run 38259941644\) — job re-run requested/);
  // While the job re-runs the rollup reads pending: the next pass waits rather than retrying the merge blind.
  const mergesBefore = h.merges().length;
  await h.pass(pr({ checksState: "pending" }));
  assert.equal(h.merges().length, mergesBefore);
  assert.equal(h.requeues.length, 1);
});

test("W1-T8620: a superseded failed run is re-run once", async t => {
  const h = harness(t, TEST_REFUSAL, SUPERSEDED);
  await h.pass();
  await h.pass();
  assert.deepEqual(h.requeues, [{ name: "test", jobId: "700001" }]);
  const rerun = h.rows("automerge.stale_check_rerun");
  assert.equal(rerun.length, 1);
  assert.equal(rerun[0].shape, "superseded");
  assert.equal(rerun[0].stale_run_id, 100);
  assert.equal(rerun[0].outranked_by_run_id, 101);
  assert.equal(h.updates.length, 0);
  assert.equal(h.escalations.length, 0);
});

test("W1-T8620: a repeat stale-check refusal at the same run escalates", async t => {
  const h = harness(t, GATE_REFUSAL, GATE_OLDER_THAN_INPUTS);
  await h.pass();
  await h.pass();
  assert.equal(h.requeues.length, 1);
  await h.pass();
  assert.equal(h.requeues.length, 1, "the (head, run id) re-run is spent once");
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0], /Required status check "ci-gate" is failing\. \(HTTP 405\)/);
  assert.match(h.escalations[0], /refused again after its one job re-run/);
  const escalated = h.rows("automerge.merge_refusal_escalated");
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].kind, "stale-check");
  await h.pass();
  assert.equal(h.requeues.length, 1);
  assert.equal(h.escalations.length, 1, "once per (head, refusal text)");
});

test("W1-T8620: a deferred re-run voids its row for the next pass", async t => {
  const h = harness(t, GATE_REFUSAL, GATE_OLDER_THAN_INPUTS);
  const deferred = (_pr: OpenPrView, check: { name: string; jobId?: string }) => {
    h.requeues.push({ name: check.name, jobId: check.jobId });
    return { kind: "deferred" as const, refusal: "already_running" as const, error: "already running (HTTP 403)" };
  };
  await h.pass();
  await h.pass(pr(), { requeueCheck: deferred });
  await h.pass();
  assert.equal(h.requeues.length, 2, "a deferral spent nothing; the next pass re-runs");
  assert.equal(h.escalations.length, 0);
  assert.deepEqual(h.rows("automerge.stale_check_rerun").map(r => r.outcome ?? "requested"), ["requested", "deferred", "requested"]);
});

test("W1-T8620: a real red re-runs nothing and an unknown refusal escalates once", async t => {
  const red = harness(t, GATE_REFUSAL, REAL_RED);
  await red.pass();
  await red.pass();
  await red.pass();
  assert.equal(red.requeues.length, 0, "a really failing check is never re-run");
  assert.equal(red.escalations.length, 0);
  assert.equal(red.updates.length, 0);
  assert.equal(red.rows("automerge.stale_check_rerun").length, 0);
  assert.equal(classifyMergeRefusal(GATE_REFUSAL, REAL_RED, REQUIRED).kind, "real-red");

  const unknown = harness(t, "gh: Merge rejected by a repository rule (HTTP 405)", GATE_OLDER_THAN_INPUTS);
  await unknown.pass();
  await unknown.pass();
  await unknown.pass();
  assert.equal(unknown.requeues.length, 0);
  assert.equal(unknown.updates.length, 0);
  assert.equal(unknown.escalations.length, 1);
  assert.match(unknown.escalations[0], /Merge rejected by a repository rule \(HTTP 405\)/);
  const escalated = unknown.rows("automerge.merge_refusal_escalated");
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].kind, "other");

  const unreadable = harness(t, GATE_REFUSAL, undefined);
  await unreadable.pass();
  await unreadable.pass();
  assert.equal(unreadable.requeues.length, 0);
  assert.equal(unreadable.escalations.length, 1);
  assert.match(unreadable.escalations[0], /rollup is unreadable/);
});

test("W1-T8620: classifyMergeRefusal names the transient and cancelled shapes", () => {
  assert.equal(classifyMergeRefusal("gh: API rate limit exceeded (HTTP 403)", undefined, REQUIRED).kind, "transient");
  assert.equal(classifyMergeRefusal(undefined, GATE_OLDER_THAN_INPUTS, REQUIRED).kind, "other");
  const cancelled: RollupCheckEntry[] = [{ name: "test", conclusion: "CANCELLED", workflowId: 3, workflowRunId: 400,
    startedAt: "2026-10-12T12:00:00Z", completedAt: "2026-10-12T12:01:00Z", detailsUrl: job(400, 600001) }];
  const verdict = classifyMergeRefusal(TEST_REFUSAL, cancelled, REQUIRED);
  assert.equal(verdict.kind, "stale-check");
  assert.equal(verdict.kind === "stale-check" ? verdict.jobId : undefined, "600001");
  // Absent is not passed: a gated check missing from the rollup leaves a failed gate a real red.
  assert.equal(classifyMergeRefusal(GATE_REFUSAL, GATE_OLDER_THAN_INPUTS.slice(0, 2), REQUIRED).kind, "real-red");
  assert.equal(classifyMergeRefusal(GATE_REFUSAL, GATE_OLDER_THAN_INPUTS, []).kind, "other");
});
