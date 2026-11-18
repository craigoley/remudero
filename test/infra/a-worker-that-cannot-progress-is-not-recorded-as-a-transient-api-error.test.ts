import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { finishTransientRetry } from "#src/cli/commands/run-task-verb.js";
import { runDiagnoseThenRetry, type AttemptOutcome } from "#src/lib/classify.js";
import { buildFixProgressInput, type FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import type { WorkerResult } from "#src/lib/worker.js";

// A codex run whose stream ended `error_codex` with the api_error flag — the shape measured on
// W1-T13224, where the attempts were API errors yet the judge named a needs-operator-input loop.
const worker = { subtype: "error_codex", numTurns: 4, apiError: true, isError: true, accountLabel: "codex-acct",
  childEnvKeys: [] } as unknown as WorkerResult;
const host = { terminalVerdictFields: () => ({ model: null, served_model: null }) };
const apiError: AttemptOutcome = { success: false, evidence: { subtype: "error_codex", apiError: true, text: "codex stream error" } };

async function drive(judge: FixProgressJudge | undefined, attempt: () => Promise<AttemptOutcome>) {
  let attempts = 0;
  const driverResult = await runDiagnoseThenRetry({
    attempt: async () => { attempts++; return attempt(); },
    diagnose: async () => ({ text: "diagnosis" }),
    fixProgressJudge: judge,
    progressInput: buildFixProgressInput({ taskId: "W1-T13284", headSha: "implement", currentRed: [], ledger: [] }),
  });
  const rows: Record<string, unknown>[] = [];
  const messages: string[] = [];
  const result = finishTransientRetry(host, driverResult, {
    taskId: "W1-T13284", runId: "run-1", repoDir: "/repo", worktreePath: "/worktree", costUsd: 1.5, worker,
    log: (step, fields) => rows.push({ step, ...fields }), say: (t) => messages.push(t),
  }, () => {});
  return { driverResult, result, rows, messages, attempts: () => attempts };
}

describe("a worker that cannot progress is not recorded as a transient API error", () => {
  test("W1-T13284 criterion 1: an error_codex run the judge calls a needs-operator-input loop ends blocked, naming the loop", async () => {
    const judge: FixProgressJudge = async () => ({ verdict: "escalate", loop: "needs-operator-input refusal loop",
      reason: "blocked on host ledger receipts outside worker read scope" });
    const { result, rows, messages } = await drive(judge, async () => apiError);
    assert.equal(result?.verdict, "blocked");
    assert.equal(result?.merged, false);
    const verdict = rows.at(-1)!;
    assert.equal(verdict.step, "verdict");
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.subtype, "error_codex");
    assert.equal(verdict.stage, "implement");
    assert.equal(verdict.account_label, "codex-acct");
    assert.match(String(verdict.reason), /needs-operator-input refusal loop/);
    assert.match(String(verdict.reason), /host ledger receipts/);
    assert.doesNotMatch(String(verdict.reason), /repeated transient API error/);
    assert.match(messages[0], /^verdict: blocked — /);
    assert.equal(rows.some((r) => r.verdict === "blocked_transient"), false);
  });

  test("W1-T13284 criterion 1: a no-progress loop is named the same way", async () => {
    const judge: FixProgressJudge = async () => ({ verdict: "escalate", loop: "no-progress retry loop", reason: "three identical failures" });
    const { result, rows } = await drive(judge, async () => apiError);
    assert.equal(result?.verdict, "blocked");
    assert.match(String(rows.at(-1)!.reason), /no-progress retry loop/);
  });

  test("W1-T13284 criterion 2: repeated API errors with no judge verdict still end blocked_transient", async () => {
    const { driverResult, result, rows } = await drive(undefined, async () => apiError);
    assert.equal(driverResult.outcome, "gave_up");
    assert.equal(driverResult.exhaustedClass, "transient");
    assert.equal(result?.verdict, "blocked_transient");
    const verdict = rows.at(-1)!;
    assert.equal(verdict.verdict, "blocked_transient");
    assert.match(String(verdict.reason), /^repeated transient API error across \d+ retries/);
  });

  test("W1-T13284 criterion 2: a judge that lets the loop continue past its ceiling is not a blocking verdict", async () => {
    let judged = 0;
    const judge: FixProgressJudge = async () => (++judged < 2
      ? { verdict: "continue", reason: "new evidence" }
      : undefined); // no verdict at all: the judge is unavailable and the run is held
    const { driverResult, result } = await drive(judge, async () => apiError);
    assert.equal(driverResult.outcome, "held");
    assert.equal(result, undefined);
  });

  test("W1-T13284 criterion 2: a single API error is still retried", async () => {
    let n = 0;
    const { driverResult, result, attempts } = await drive(undefined, async () => (++n === 1 ? apiError : { success: true }));
    assert.equal(driverResult.outcome, "success");
    assert.equal(driverResult.transientRetries, 1);
    assert.equal(attempts(), 2);
    assert.equal(result, undefined);
  });
});
