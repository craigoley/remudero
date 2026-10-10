/**
 * W1-T6032 — A SIGNAL-ENDED FIX ROUND THAT LEFT WORK STILL COMMITS IT.
 *
 * W1-T5999 (#9566) stands a fix round down as `signal_terminated` when its codex worker ended by
 * signal, checked right after the spawn and before the harness commit. MEASURED 2026-10-04 01:06:
 * W1-T4283's fix worker ended by signal (`worker_subtype: "error_exit_null"`) AFTER leaving edits;
 * the harness derived a subject, committed and pushed a77eedf, and #8973 merged. An unconditional
 * stand-down discards that work. The stand-down now applies only when the worker left NO work —
 * no uncommitted edits and no commits ahead of the round's start.
 *
 * Driven through `runFixRung` with the real `harnessCommitForShellLessWorker`, the same harness as
 * test/a-signal-terminated-fix-worker-is-not-a-commit-refusal.test.ts, with the worktree's leftover
 * work (edits, commits ahead) as the variable. The no-work case is the control that keeps the
 * narrowing from collapsing to "never stand down".
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "./helpers/run-task-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";

const TASK = "W1-T6032X";
const HEAD = "head-a";
/** The codex runner's result for a child a signal ended: subtype `error_exit_null`, and since W1-T6027 the signal's name. */
const SIGNAL_EXIT = { subtype: "error_exit_null", isError: true, exit: { kind: "signal", signal: "SIGTERM" } } as const;

type Row = { step: string; task_id: string } & Record<string, unknown>;

async function signalEndedFixRound(t: TestContext, left: { edits?: boolean; ahead?: number }) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return HEAD;
    // W1-T6148: the host git leaf vets the pinned config first; an empty listing admits the call.
    if (args.includes("--show-scope")) return "";
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6032-`));
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
    provider: "codex", sessionId: "DAEMON-1-session", costUsd: 0, numTurns: 1,
    text: "I'll update the ordering test to locate the actual spawn call", blocks: [], stderr: "",
    ...SIGNAL_EXIT, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: TASK, runId: "DAEMON-1", task: { id: TASK, title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/8973", branch: "run-W1-T6032X-1",
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
      say: () => {}, account: (result) => result, commitsAhead: () => left.ahead ?? 0,
      worktreeHasUncommittedChanges: () => left.edits ?? false,
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

test("W1-T6032: a signal-ended fix worker that LEFT EDITS still has its work committed and pushed, never signal_terminated", async (t) => {
  // W1-T4283 / #8973 (2026-10-04 01:06): a codex worker ended by signal had left edits; the harness derived
  // the subject, committed and pushed a77eedf, and the PR merged. That round must keep landing its work.
  const { rows, commits, pushes } = await signalEndedFixRound(t, { edits: true });
  assert.equal(rows.some((row) => row.step === "fix.done" && row.subtype === "signal_terminated"), false);
  assert.ok(rows.some((row) => row.step === "implement.harness_commit"), "the harness commits the work the worker left");
  assert.match(commits[0] ?? "", /^fix: repair coverage-shard \(8\/8\) on #8973/);
  assert.ok(pushes >= 1, "the committed round is pushed");
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false);
});

test("W1-T6032: a signal-ended fix worker that committed on its own is not signal_terminated either", async (t) => {
  const { rows, pushes } = await signalEndedFixRound(t, { ahead: 1 });
  assert.equal(rows.some((row) => row.step === "fix.done" && row.subtype === "signal_terminated"), false);
  assert.ok(pushes >= 1, "the worker's own commit is pushed");
});

test("W1-T6032: a signal-ended fix worker that left no work still stands down, without a refusal", async (t) => {
  const { outcome, rows, commits, pushes } = await signalEndedFixRound(t, {});
  assert.equal(rows.find((row) => row.step === "fix.done")?.subtype, "signal_terminated");
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false);
  assert.deepEqual(commits, []);
  assert.equal(pushes, 0);
  assert.equal(outcome.outcome, "stood_down");
});
