/**
 * W1-T6027 — A WORKER RESULT NAMES HOW ITS PROCESS ENDED.
 *
 * The codex runner (`spawnCodexWorkerInPrivateTemp`) resolved its exit promise with the exit code
 * alone, so a signal-ended worker read `error_exit_null` with no signal name. One whose stream had
 * already logged turn.failed, an error event or a torn last JSONL line read `error_codex` instead,
 * and W1-T5999's `fixWorkerEndedBySignal` (which compared that subtype string) recorded the round
 * `fix.commit_refused` again. `WorkerResult.exit` now carries what the process itself reported:
 * an exit code, a signal name, or `unobserved` for a runner that saw no process end.
 *
 * Each runner is driven through its exported entry point: the codex runner with a fake child whose
 * `exit` event the test emits, the claude collector with a synthetic SDK stream, and the cash HTTP
 * runner on its no-credential path. The fix rung is driven through `runFixRung` with the real
 * `harnessCommitForShellLessWorker`, the harness of
 * test/a-signal-terminated-fix-worker-is-not-a-commit-refusal.test.ts. Each signal case has an
 * exit-code control, so the classification cannot collapse to "every error is a kill".
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { harnessCommitForShellLessWorker, runFixRung } from "./helpers/run-task-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as worker from "../src/lib/worker.js";
import { spawnCodexWorker, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import type { WorkerExit, WorkerResult } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { ReviewVerdict } from "../src/lib/review.js";

const TASK = "W1-T6027X";
const HEAD = "head-a";
const MISSING_LINE = "no anchored COMMIT_MESSAGE line in the report";

// ── the codex runner ──────────────────────────────────────────────────────────────────────────

/** A fake codex child. `end` writes the stream, closes it, then emits Node's `exit(code, signal)`. */
async function codexRun(stream: string, code: number | null, signal?: string): Promise<WorkerResult> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6027-home-`));
  try {
    const run = spawnCodexWorker(
      {
        workerHome: home,
        cwd: process.cwd(),
        prompt: "how did it end",
        settingsFile: join(process.cwd(), "settings", "worker.json"),
        containment: { spawn: () => ({ process: proc as never, pid: 60_270 }), teardown: () => {} },
      },
      { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna" } } as Config,
    );
    stdout.write(stream);
    stdout.end();
    // Let the stream's data events land before the child reports its end, as a real pipe drains.
    await new Promise((resolve) => setImmediate(resolve));
    if (signal === undefined) proc.emit("exit", code);
    else proc.emit("exit", code, signal);
    return (await run) as WorkerResult;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const STARTED = '{"type":"thread.started","thread_id":"t6027"}\n{"type":"turn.started"}\n';
const NARRATION = '{"type":"item.completed","item":{"type":"agent_message","text":"I will update the test"}}\n';

test("W1-T6027: a codex worker whose stream logged turn.failed and then died by SIGTERM names the signal", async () => {
  const result = await codexRun(`${STARTED}${NARRATION}{"type":"turn.failed","error":{"message":"stream disconnected"}}\n`, null, "SIGTERM");
  assert.deepEqual(result.exit, { kind: "signal", signal: "SIGTERM" });
  assert.equal(result.isError, true);
  assert.equal(result.subtype, "error_codex", "the subtype is unchanged: verdict rows and retro mappings do not move");
});

test("W1-T6027: a codex worker killed mid-write, leaving a torn last line, names the signal", async () => {
  const result = await codexRun(`${STARTED}${NARRATION}{"type":"item.completed","item":{"type":"agent_mes`, null, "SIGKILL");
  assert.deepEqual(result.exit, { kind: "signal", signal: "SIGKILL" });
  assert.equal(result.isError, true);
  assert.equal(result.subtype, "error_codex", "the torn half-line is still parsed as an error");
});

test("W1-T6027: a codex worker that died by a signal with a clean stream is still an error naming the signal", async () => {
  const result = await codexRun(`${STARTED}${NARRATION}`, null, "SIGTERM");
  assert.deepEqual(result.exit, { kind: "signal", signal: "SIGTERM" });
  assert.equal(result.isError, true, "a signal is an error whatever the stream parsed");
  assert.equal(result.subtype, "error_exit_null");
});

test("W1-T6027: a codex worker that exits with a non-zero code names that code, not a signal", async () => {
  const result = await codexRun(`${STARTED}${NARRATION}`, 1, undefined);
  assert.deepEqual(result.exit, { kind: "exit", code: 1 });
  assert.equal(result.isError, true);
  assert.equal(result.subtype, "error_exit_1");
});

test("W1-T6027: a codex worker that exits 0 names exit code 0", async () => {
  const result = await codexRun(`${STARTED}${NARRATION}{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n`, 0, undefined);
  assert.deepEqual(result.exit, { kind: "exit", code: 0 });
  assert.equal(result.isError, false);
  assert.equal(result.subtype, "success");
});

test("W1-T6027: a codex exit event carrying neither a code nor a signal is unobserved, never exit 0", async () => {
  const result = await codexRun(`${STARTED}${NARRATION}`, null, undefined);
  assert.deepEqual(result.exit, { kind: "unobserved" });
  assert.equal(result.isError, true);
});

// ── the claude collector and the SDK's process errors ─────────────────────────────────────────

/** The SDK's shapes (getProcessExitError, sdk 0.3.284): an Error with `signal` or `exitCode` attached. */
const killedBySignal = (signal: string) =>
  Object.assign(new Error(`Claude Code process terminated by signal ${signal}`), { errorClass: "process_killed_by_signal", signal });
const exitedNonzero = (exitCode: number) =>
  Object.assign(new Error(`Claude Code process exited with code ${exitCode}`), { errorClass: "process_exited_nonzero", exitCode });

async function* envelopeThen(error?: unknown): AsyncGenerator<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };
  yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-6027", total_cost_usd: 0, num_turns: 1 };
  if (error !== undefined) throw error;
}

test("W1-T6027: workerExitOfError reads an SDK error's signal and exit code, and nothing else", () => {
  const workerExitOfError = (worker as { workerExitOfError?: (e: unknown) => WorkerExit }).workerExitOfError;
  assert.equal(typeof workerExitOfError, "function", "worker.ts exports workerExitOfError");
  assert.deepEqual(workerExitOfError!(killedBySignal("SIGTERM")), { kind: "signal", signal: "SIGTERM" });
  assert.deepEqual(workerExitOfError!(exitedNonzero(137)), { kind: "exit", code: 137 });
  assert.deepEqual(workerExitOfError!(new Error("network reset")), { kind: "unobserved" });
  assert.deepEqual(workerExitOfError!("a thrown string"), { kind: "unobserved" });
  assert.deepEqual(workerExitOfError!(null), { kind: "unobserved" });
  assert.deepEqual(workerExitOfError!(Object.assign(new Error("x"), { signal: "", exitCode: 1.5 })), { kind: "unobserved" },
    "an empty signal or a non-integer code is not an observation");
});

test("W1-T6027: a claude envelope followed by the SDK's signal throw names the signal", async () => {
  const result = await worker.collectWorkerResult(envelopeThen(killedBySignal("SIGTERM")), { childEnvKeys: [] });
  assert.deepEqual(result.exit, { kind: "signal", signal: "SIGTERM" });
  assert.equal(result.isError, true);
  assert.equal(result.subtype, "success", "the swallow arm leaves the envelope's subtype untouched");
});

test("W1-T6027: a claude envelope followed by the SDK's non-zero exit throw names the code", async () => {
  const result = await worker.collectWorkerResult(envelopeThen(exitedNonzero(2)), { childEnvKeys: [] });
  assert.deepEqual(result.exit, { kind: "exit", code: 2 });
});

test("W1-T6027: a claude envelope with no SDK throw, or a throw naming no process end, is unobserved", async () => {
  const clean = await worker.collectWorkerResult(envelopeThen(), { childEnvKeys: [] });
  assert.deepEqual(clean.exit, { kind: "unobserved" }, "no process end was seen, so none is guessed");
  const plain = await worker.collectWorkerResult(envelopeThen(new Error("api error after the envelope")), { childEnvKeys: [] });
  assert.deepEqual(plain.exit, { kind: "unobserved" });
});

test("W1-T6027: the cash HTTP runner reports unobserved — it has no process to end", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6027-cash-`));
  try {
    const result = await spawnOpenWeightWorker(
      {
        cwd: root, workerHome: join(root, "worker-home"), prompt: "classify", env: {},
        fetchImpl: async () => { throw new Error("test: no transport"); },
      },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 5 } as Config,
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(result.isError, true, "the missing credential is reported as a failed result");
    assert.deepEqual(result.exit, { kind: "unobserved" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the fix rung ──────────────────────────────────────────────────────────────────────────────

type Row = { step: string; task_id: string } & Record<string, unknown>;

async function fixRound(t: TestContext, runId: string, ended: Pick<WorkerResult, "subtype" | "isError" | "exit">) {
  t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
    if (args.includes("rev-parse")) return HEAD;
    throw new Error("test: subprocess reads unavailable");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6027-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Row[] = [];
  const commits: string[] = [];
  const mount: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair the check", proof: "unit test: repair the check", met: false,
      reason: "still failing", proof_exec: "not_executable" }],
    testTheater: false, summary: "still failing", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "failure",
  };
  // A truncated report: narration, no COMMIT_MESSAGE line.
  const result: WorkerResult = {
    provider: "codex", sessionId: `${runId}-session`, costUsd: 0, numTurns: 1,
    text: "I'll update the ordering test to locate the actual spawn call", blocks: [], stderr: "",
    ...ended, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
  const outcome = await runFixRung({
    taskId: TASK, runId, task: { id: TASK, title: "repair the check", files: ["src/run-task.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/9600", branch: "run-W1-T6027X-1",
    worktreePath: process.cwd(), initialSessionId: "writer-session", mount,
    settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "coverage-shard (8/8)", logTail: "test/review-provider-provenance.test.ts failed" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async () => result,
      waitForCiGreen: async () => "green", runReview: async () => review,
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} } as IssueGateway,
      ledgerPath: join(root, "ledger.ndjson"), log: (step, extra) => rows.push({ step, task_id: TASK, ...(extra ?? {}) }),
      readHeadShaForProvenance: () => HEAD,
      say: () => {}, account: (r) => r, commitsAhead: () => 0,
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
  return { outcome, rows, commits };
}

test("W1-T6027: a fix worker whose stream logged turn.failed before SIGTERM is signal_terminated with the signal's name", async (t) => {
  const { outcome, rows, commits } = await fixRound(t, "DAEMON-1",
    { subtype: "error_codex", isError: true, exit: { kind: "signal", signal: "SIGTERM" } });
  assert.equal(rows.some((row) => row.step === "fix.commit_refused"), false, "the kill is not a refusal");
  const done = rows.filter((row) => row.step === "fix.done");
  assert.equal(done.length, 1);
  assert.equal(done[0]!.subtype, "signal_terminated");
  assert.equal(done[0]!.worker_subtype, "error_codex", "the runner's own subtype still rides the row");
  assert.equal(done[0]!.worker_exit, "signal", "W1-T6028 keys on this value");
  assert.equal(done[0]!.worker_exit_signal, "SIGTERM");
  assert.deepEqual(commits, []);
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0);
});

test("W1-T6027: a fix worker that exited with a non-zero code and no COMMIT_MESSAGE line is still a refusal", async (t) => {
  const { rows } = await fixRound(t, "DAEMON-1", { subtype: "error_exit_1", isError: true, exit: { kind: "exit", code: 1 } });
  assert.equal(rows.find((row) => row.step === "fix.commit_refused")?.reason, MISSING_LINE);
  assert.equal(rows.find((row) => row.step === "fix.done")?.subtype, "commit_refused");
  assert.equal(rows.some((row) => "worker_exit_signal" in row), false);
});

test("W1-T6027: the fix rung reads the exit, never the subtype — error_exit_null with no observed signal is a refusal", async (t) => {
  const { rows } = await fixRound(t, "DAEMON-1", { subtype: "error_exit_null", isError: true, exit: { kind: "unobserved" } });
  assert.equal(rows.find((row) => row.step === "fix.commit_refused")?.reason, MISSING_LINE);
  assert.equal(rows.find((row) => row.step === "fix.done")?.subtype, "commit_refused");
});
