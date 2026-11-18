import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { finishTransientRetry } from "#src/cli/commands/run-task-verb.js";
import { buildFixProgressInput, judgeFixProgress, type FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import type { WorkerResult } from "#src/lib/worker.js";

// This suite deliberately does not import src/lib/classify.ts: any test that does must be listed in
// stryker.conf.json's commandRunner (an instrument-only PR, Standing rule 25), so the retry driver's
// result is injected here in the exact shape classify.ts's `runDiagnoseThenRetry` returns when the
// transient budget is exhausted (see its `give_up` arm), with the judge consulted for real.
type DriverResult = Parameters<typeof finishTransientRetry>[1];

// A codex run whose stream ended `error_codex` with the api_error flag — the shape measured on
// W1-T13224, where the attempts were API errors yet the judge named a needs-operator-input loop.
const worker = { subtype: "error_codex", numTurns: 4, apiError: true, isError: true, accountLabel: "codex-acct",
  childEnvKeys: [] } as unknown as WorkerResult;
const host = { terminalVerdictFields: () => ({ model: null, served_model: null }) };
const EXHAUSTED = "transient retries exhausted";

/** The exhausted-transient driver result, with the reason classify.ts derives from the judge's ruling. */
async function exhausted(judge: FixProgressJudge | undefined): Promise<DriverResult> {
  const base = { strikes: 0, transientRetries: 3, diagnosed: false, attempts: 4 };
  if (!judge) return { ...base, outcome: "gave_up", reason: EXHAUSTED, exhaustedClass: "transient" };
  const decision = await judgeFixProgress(
    buildFixProgressInput({ taskId: "W1-T13284", headSha: "implement", currentRed: ["codex stream error"], ledger: [] }),
    judge,
  );
  if (decision.verdict === "continue" || decision.verdict === "change-approach") return { ...base, outcome: "success" };
  if (decision.verdict === "unavailable") return { ...base, outcome: "held", reason: decision.reason };
  return { ...base, outcome: "gave_up", exhaustedClass: "transient",
    reason: `fix progress loop: ${decision.loop} — ${decision.reason}` };
}

async function drive(judge: FixProgressJudge | undefined) {
  const driverResult = await exhausted(judge);
  const rows: Record<string, unknown>[] = [];
  const messages: string[] = [];
  const result = finishTransientRetry(host, driverResult, {
    taskId: "W1-T13284", runId: "run-1", repoDir: "/repo", worktreePath: "/worktree", costUsd: 1.5, worker,
    log: (step, fields) => rows.push({ step, ...fields }), say: (t) => messages.push(t),
  }, () => {});
  return { driverResult, result, rows, messages };
}

describe("a worker that cannot progress is not recorded as a transient API error", () => {
  test("W1-T13284 criterion 1: an error_codex run the judge calls a needs-operator-input loop ends blocked, naming the loop", async () => {
    const judge: FixProgressJudge = async () => ({ verdict: "escalate", loop: "needs-operator-input refusal loop",
      reason: "blocked on host ledger receipts outside worker read scope" });
    const { result, rows, messages } = await drive(judge);
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
    const { result, rows } = await drive(judge);
    assert.equal(result?.verdict, "blocked");
    assert.match(String(rows.at(-1)!.reason), /no-progress retry loop/);
  });

  test("W1-T13284 criterion 2: repeated API errors with no judge verdict still end blocked_transient", async () => {
    const { driverResult, result, rows } = await drive(undefined);
    assert.equal(driverResult.outcome, "gave_up");
    assert.equal(driverResult.exhaustedClass, "transient");
    assert.equal(result?.verdict, "blocked_transient");
    const verdict = rows.at(-1)!;
    assert.equal(verdict.verdict, "blocked_transient");
    assert.match(String(verdict.reason), /^repeated transient API error across \d+ retries/);
  });

  test("W1-T13284 criterion 2: a judge with no verdict holds the run and records no blocking verdict", async () => {
    const judge: FixProgressJudge = async () => undefined;
    const { driverResult, result } = await drive(judge);
    assert.equal(driverResult.outcome, "held");
    assert.equal(result, undefined);
  });

  test("W1-T13284 criterion 2: a successful run is not touched", () => {
    const result = finishTransientRetry(host, { outcome: "success", strikes: 0, transientRetries: 1, diagnosed: false,
      attempts: 2 }, { taskId: "W1-T13284", runId: "run-1", repoDir: "/repo", worktreePath: "/worktree", costUsd: 1,
      worker, log: () => {}, say: () => {} }, () => {});
    assert.equal(result, undefined);
  });
});
