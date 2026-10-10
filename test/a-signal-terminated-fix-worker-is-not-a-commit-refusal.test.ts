/**
 * W1-T5999 — A FIX WORKER KILLED BY A SIGNAL IS NOT A COMMIT REFUSAL.
 *
 * MEASURED 2026-10-06 on #9528 (W1-T5682): two codex fix workers were killed mid-run (the codex
 * runner's own `fix.done` row read `worker_subtype: "error_exit_null"` — Node's `exit` event hands
 * a signal-terminated child `code === null`). Each truncated report carried no COMMIT_MESSAGE
 * line, so each round was recorded `fix.commit_refused` "no anchored COMMIT_MESSAGE line in the
 * report", and the sweep's `fixRoundTally` read the pair as "fix rounds refused twice at this
 * head" and the strike ladder closed the PR. W1-T2402 exempts a signal death only when the spawn
 * THROWS; the codex runner returns its partial report instead.
 *
 * Driven through `runFixRung` with the real `harnessCommitForShellLessWorker`, so the refusal
 * this task removes is the one production writes. A worker that exits normally without the line
 * is still a refusal — the control that keeps the classification from collapsing to "never refuse".
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "./helpers/run-task-test.js";
import { fixRoundTally } from "../src/lib/sweep.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";

const TASK = "W1-T5999X";
const HEAD = "head-a";
const MISSING_LINE = "no anchored COMMIT_MESSAGE line in the report";
/** The codex runner's result for a child a signal ended: subtype `error_exit_null`, and since W1-T6027 the signal's name. */
const SIGNAL_EXIT = { subtype: "error_exit_null", isError: true, exit: { kind: "signal", signal: "SIGTERM" } } as const;
const NORMAL_EXIT = { subtype: "success", isError: false, exit: { kind: "exit", code: 0 } } as const;

type Row = { step: string; task_id: string } & Record<string, unknown>;

async function fixRound(t: TestContext, runId: string, exit: Pick<WorkerResult, "subtype" | "isError" | "exit">) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return HEAD;
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5999-"));
  const rows: Row[] = [];
  const commits: string[] = [];
  let pushes = 0;
  const mount: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "failure",
  };
  // The truncated report a killed worker leaves: narration, no COMMIT_MESSAGE line, no outcome.
  const worker: WorkerResult = {
    provider: "codex", sessionId: `${runId}-session`, costUsd: 0, numTurns: 1,
    text: "I'll update the ordering test to locate the actual spawn call", blocks: [], stderr: "",
    ...exit, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: TASK, runId, task: { id: TASK, title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/9528", branch: "run-W1-T5999X-1",
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "coverage-shard (8/8)", logTail: "test/review-provider-provenance.test.ts failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => worker,
      waitForCiGreen: async () => "green", runReview: async () => review,
      fetchPrBody: async () => "REPORT", push: () => { pushes++; },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, task_id: TASK, ...(extra ?? {}) }),
      readHeadShaForProvenance: () => HEAD,
      say: () => {}, account: (result) => result, commitsAhead: () => 0,
      // The killed worker left nothing behind, as on #9528: no derived subject can rescue the round.
      worktreeHasUncommittedChanges: () => false,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input, {
        commit: (_cwd, _paths, message) => {
          commits.push(message);
          return { committed: true, sha: "new-head", undeclared: [] };
        },
        ahead: () => 1,
      }),
    },
  });
  return { outcome, rows, commits, pushes };
}

test("W1-T5999: a signal-terminated fix worker records its own outcome, never fix.commit_refused", async (t) => {
  const { outcome, rows, commits, pushes } = await fixRound(t, "DAEMON-1", SIGNAL_EXIT);
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false,
    "a killed worker's missing COMMIT_MESSAGE line is the kill, not a refusal");
  const done = rows.filter((row) => row.step === "fix.done");
  assert.equal(done.length, 1, "the round still ends with exactly one fix.done row");
  assert.equal(done[0]!.subtype, "signal_terminated");
  assert.equal(done[0]!.worker_subtype, "error_exit_null", "the runner's own exit evidence rides the row");
  assert.equal(done[0]!.worker_exit, "signal");
  assert.equal(done[0]!.head_sha, HEAD);
  assert.equal(rows.some((row) => row.step === "implement.harness_commit_refused"), false,
    "the harness never tries to commit a truncated round");
  assert.deepEqual(commits, []);
  assert.equal(pushes, 0, "nothing new to push");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "no strike is spent on a killed worker");
  assert.equal(outcome.reason, "fix worker terminated by signal");
});

test("W1-T5999: two signal-terminated fix rounds at one head never count toward the repeated-refusal ladder", async (t) => {
  const first = await fixRound(t, "DAEMON-1", SIGNAL_EXIT);
  const second = await fixRound(t, "DAEMON-2", SIGNAL_EXIT);
  const tally = fixRoundTally([...first.rows, ...second.rows], TASK, HEAD, "executed");
  assert.deepEqual(tally.refusals, []);
  assert.equal(tally.repeatedRefusal, undefined, "two kills are not \"fix rounds refused twice at this head\"");
  assert.equal(tally.strikes, 0);
});

test("W1-T5999: a fix worker that exits normally without a COMMIT_MESSAGE line is still a refusal", async (t) => {
  const first = await fixRound(t, "DAEMON-1", NORMAL_EXIT);
  assert.equal(first.rows.find((row) => row.step === "fix.commit_refused")?.reason, MISSING_LINE);
  assert.equal(first.rows.find((row) => row.step === "fix.done")?.subtype, "commit_refused");
  assert.equal(first.outcome.reason, "harness commit refused");
  const second = await fixRound(t, "DAEMON-2", NORMAL_EXIT);
  const tally = fixRoundTally([...first.rows, ...second.rows], TASK, HEAD, "executed");
  assert.equal(tally.refusals.length, 2);
  assert.equal(tally.repeatedRefusal, MISSING_LINE);
});

test("W1-T5999: a non-zero exit CODE is not a signal — the worker exited, so its missing line is a refusal", async (t) => {
  const { rows } = await fixRound(t, "DAEMON-1", { subtype: "error_exit_1", isError: true, exit: { kind: "exit", code: 1 } });
  assert.equal(rows.find((row) => row.step === "fix.commit_refused")?.reason, MISSING_LINE);
  assert.equal(rows.find((row) => row.step === "fix.done")?.subtype, "commit_refused");
});
