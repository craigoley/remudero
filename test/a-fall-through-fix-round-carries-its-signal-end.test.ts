import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "./helpers/run-task-test.js";
import { fixArmEvidence } from "../src/lib/fix-routing-learner.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";

const PROOF = "test/a-fall-through-fix-round-carries-its-signal-end.test.ts";
const TASK = "W1-T6073X";
const HEAD = "head-a";
const NOW = Date.parse("2026-10-07T12:00:00Z");
type Row = { step: string; task_id: string; ts: string } & Record<string, unknown>;

async function fixRound(t: TestContext, subtype: string, exit: WorkerResult["exit"], pushed: boolean) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return HEAD;
    if (args.includes("--show-scope")) return "";
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6073-`));
  const rows: Row[] = [];
  let pushes = 0;
  const mount: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "failure",
  };
  const worker: WorkerResult = {
    provider: "codex", sessionId: "fix-session", costUsd: 0, numTurns: 1,
    text: "I'll repair the check", blocks: [], stderr: "", subtype, exit,
    isError: exit?.kind !== "exit" || exit.code !== 0, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "gpt-6.1-sol", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: TASK, runId: "DAEMON-6073", task: { id: TASK, title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/6073", branch: "run-W1-T6073X-1",
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    ciFailures: [{ name: "coverage-shard (8/8)", logTail: "test/repair.test.ts failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async (args) => {
        args.onSelectionAssignment?.({
          version: 1, id: "selection-6073", phase: "pre-execution",
          requested: { model: mount.model, effort: mount.effort, maxTurns: mount.maxTurns },
          selected: { provider: "codex", model: worker.model, effort: worker.effort },
          routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 10, provenance: "default" } },
          candidates: [],
        });
        return worker;
      },
      waitForCiGreen: async () => "green", runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT", push: () => { pushes++; },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step, extra) => rows.push({ step, task_id: TASK, ts: new Date(NOW).toISOString(), ...extra }),
      readHeadShaForProvenance: () => HEAD,
      say: () => {}, account: (result) => result, commitsAhead: () => 0,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input, {
        commit: () => pushed
          ? { committed: true, sha: "new-head", undeclared: [] }
          : { committed: false, reason: "undeclared paths", undeclared: ["outside.ts"] },
        ahead: () => 1,
      }),
    },
  });
  const done = rows.filter((row) => row.step === "fix.done");
  assert.equal(done.length, 1);
  assert.equal(done[0]!.provider, "codex");
  assert.equal(done[0]!.selected_model, worker.model);
  assert.equal(pushes, pushed ? 1 : 0);
  return { row: done[0]!, outcome };
}

for (const subtype of ["error_codex", "error_exit_null", "success", "error_during_execution"]) {
  test(`${PROOF}: unpushed signal-ended ${subtype} retains its signal and teaches no arm`, async (t) => {
    const { row, outcome } = await fixRound(t, subtype, { kind: "signal", signal: "SIGTERM" }, false);
    assert.equal(outcome.reason, "harness commit refused");
    assert.equal(row.subtype, "commit_refused");
    assert.equal(row.worker_subtype, subtype);
    assert.equal(row.worker_exit, "signal");
    assert.equal(row.worker_exit_signal, "SIGTERM");
    assert.equal(row.pushed_head_sha, undefined);
    const evidence = fixArmEvidence([row], NOW);
    assert.equal(evidence.signalExcluded, 1);
    assert.deepEqual(evidence.arms, []);
    assert.equal(evidence.priorMean, 0.5);
  });
}

test(`${PROOF}: a pushed signal-ended round retains its signal and earns the usual rewards`, async (t) => {
  const { row } = await fixRound(t, "error_codex", { kind: "signal", signal: "SIGKILL" }, true);
  assert.equal(row.subtype, "error_codex");
  assert.equal(Object.hasOwn(row, "worker_subtype"), false);
  assert.equal(row.worker_exit, "signal");
  assert.equal(row.worker_exit_signal, "SIGKILL");
  assert.equal(row.pushed_head_sha, "new-head");
  const accepted = fixArmEvidence([row], NOW);
  assert.equal(accepted.signalExcluded, 0);
  assert.deepEqual(accepted.arms.map((arm) => [arm.rounds, arm.acceptedWeight, arm.refusedWeight]), [[1, 1, 0]]);
  const red = fixArmEvidence([row, { step: "fix.ci_not_green", task_id: TASK, sha: "new-head" }], NOW);
  assert.equal(red.signalExcluded, 0);
  assert.deepEqual(red.arms.map((arm) => [arm.rounds, arm.acceptedWeight, arm.refusedWeight]), [[1, 0.5, 0.5]]);
});

for (const pushed of [false, true]) {
  test(`${PROOF}: a normal exit ${pushed ? "pushed" : "refused"} round keeps its previous score`, async (t) => {
    const { row } = await fixRound(t, "success", { kind: "exit", code: 0 }, pushed);
    assert.equal(row.worker_exit, "exit");
    assert.equal(row.worker_exit_code, 0);
    assert.equal(Object.hasOwn(row, "worker_exit_signal"), false);
    assert.equal(row.subtype, pushed ? "success" : "commit_refused");
    if (!pushed) assert.equal(row.worker_subtype, "success");
    const evidence = fixArmEvidence([row], NOW);
    assert.equal(evidence.signalExcluded, 0);
    assert.deepEqual(evidence.arms.map((arm) => [arm.rounds, arm.acceptedWeight, arm.refusedWeight]),
      [[1, pushed ? 1 : 0, pushed ? 0 : 1]]);
  });
}

test(`${PROOF}: legacy error_exit_null rows still require a pushed head to be scored`, () => {
  const base = { step: "fix.done", task_id: TASK, ts: new Date(NOW).toISOString(), provider: "codex", selected_model: "gpt-6.1-sol" };
  for (const fields of [{ subtype: "error_exit_null" }, { subtype: "commit_refused", worker_subtype: "error_exit_null" }]) {
    const row = { ...base, ...fields };
    assert.equal(fixArmEvidence([row], NOW).signalExcluded, 1);
    const pushed = fixArmEvidence([{ ...row, pushed_head_sha: "legacy-head" }], NOW);
    assert.equal(pushed.signalExcluded, 0);
    assert.equal(pushed.arms[0]!.rounds, 1);
    assert.equal(pushed.arms[0]!.acceptedWeight, fields.subtype === "commit_refused" ? 0 : 1);
  }
});
