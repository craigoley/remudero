/**
 * W1-T9034 — an implement-stage worker error releases on provider recovery, as every other worker stage does.
 * `failOnWorkerError(impl, "implement", driverResult.reason)` overwrites the verdict's reason with the retry
 * driver's ("strikes exhausted (2)"), so W1-T8676's reason-prefix test read that latch as task-caused. These tests
 * drive `independentFailureLatch` with rows shaped as `failOnWorkerError` writes them, plain and indexed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INDEPENDENT_BLOCK_BASE_BACKOFF_MS, WORKER_ERROR_VERDICT_STAGES, buildLedgerIndex, independentFailureLatch,
} from "#src/lib/status.js";

const TASK = "W1-T9034";
const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const MINUTE = 60_000;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** A failed run of TASK, its verdict shaped by `verdictExtra`, and the block the daemon writes for it. */
function latchedRun(verdictExtra: Record<string, unknown> = {}, run = "r2"): Record<string, unknown>[] {
  return [
    { ts: at(0), task_id: TASK, run_id: run, step: "run.start" },
    { ts: at(1000), task_id: TASK, run_id: run, step: "verdict", verdict: "failed", stage: "implement", subtype: "error_codex",
      provider: "codex", reason: "strikes exhausted (2)", ...verdictExtra },
    { ts: at(2000), task_id: TASK, task: TASK, run_id: run, step: "dispatch.blocked_independent", verdict: "failed" },
  ];
}
const clean = (offsetMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ts: at(offsetMs), task_id: "W1-T9999", run_id: "o1", step: "implement.done", provider: "codex", subtype: "success", ...extra });
const merge = { ts: at(30 * MINUTE), task_id: "W1-T8000", step: "verdict.merged", pr_url: "https://github.com/o/r/pull/1" };

function latch(rows: Record<string, unknown>[], indexed: boolean, nowOffsetMs: number) {
  return independentFailureLatch(rows, TASK, indexed ? buildLedgerIndex(rows) : undefined, T0 + nowOffsetMs);
}

test("W1-T9034: an implement-stage worker error releases once its provider serves a clean end", () => {
  for (const indexed of [false, true]) {
    const latched = latchedRun();
    assert.equal(latch(latched, indexed, 3 * MINUTE).blocked, true, "no clean result yet");
    const result = latch([...latched, clean(MINUTE)], indexed, 2 * MINUTE);
    assert.equal(result.blocked, false);
    assert.equal(result.release?.evidence, "provider_recovered");
    assert.equal(result.release?.backoffMs, 0, "no back-off");
    assert.equal(result.release?.blockingRunId, "r2");
    assert.equal(result.release?.provider, "codex");
    assert.equal(result.release?.recoveredAt, at(MINUTE));
    // Another provider's clean end is no evidence this one is back.
    assert.equal(latch([...latched, clean(MINUTE, { provider: "claude" })], indexed, 2 * MINUTE).blocked, true);
  }
});

test("W1-T9034: a worker error is classified by its verdict fields, not its reason text", () => {
  for (const reason of ["strikes exhausted (2)", "fix progress loop: no progress", "usage window shut — resets later", undefined]) {
    for (const stage of WORKER_ERROR_VERDICT_STAGES) {
      const rows = [...latchedRun({ stage, reason }), clean(MINUTE)];
      const result = latch(rows, false, 2 * MINUTE);
      assert.equal(result.release?.evidence, "provider_recovered", `${stage} / ${String(reason)}`);
      assert.equal(latch(rows, true, 2 * MINUTE).release?.evidence, "provider_recovered", `${stage} / ${String(reason)} indexed`);
    }
  }
  assert.deepEqual([...WORKER_ERROR_VERDICT_STAGES].sort(),
    ["implement", "implement.continued", "implement.preopen_continued", "implement.resumed", "recon"]);
  // A row carrying neither field falls back to the reason prefix `workerErrorVerdict` writes.
  const legacy = { stage: undefined, subtype: undefined, reason: "worker error at implement: error_codex" };
  assert.equal(latch([...latchedRun(legacy), clean(MINUTE)], false, 2 * MINUTE).release?.evidence, "provider_recovered");
  const legacySignal = { stage: undefined, subtype: undefined, reason: "worker ended by signal SIGKILL at implement" };
  assert.equal(latch([...latchedRun(legacySignal), clean(MINUTE)], false, 2 * MINUTE).blocked, false);
});

test("W1-T9034: a failed verdict without a worker error subtype keeps its back-off", () => {
  const taskCaused: Record<string, unknown>[] = [
    { subtype: undefined }, // no error subtype
    { subtype: "success" }, // a clean end is never a worker error
    { subtype: "error_max_budget_usd" }, // a budget breach
    { stage: undefined }, // no worker stage
    { stage: "pr_open.refused" }, // a stage failOnWorkerError never uses
    { stage: undefined, subtype: undefined, reason: "tests failed" }, // neither field, and no worker-error reason
    { stage: "implement", subtype: undefined, reason: "worker error at implement: error_codex" }, // fields beat the text
  ];
  for (const indexed of [false, true]) {
    for (const extra of taskCaused) {
      const rows = [...latchedRun(extra), clean(MINUTE), merge];
      const early = latch(rows, indexed, 31 * MINUTE);
      assert.equal(early.blocked, true, `a clean provider result does not release ${JSON.stringify(extra)}`);
      assert.equal(early.release, undefined);
      const late = latch(rows, indexed, INDEPENDENT_BLOCK_BASE_BACKOFF_MS + 3000);
      assert.equal(late.release?.evidence, "main_moved", JSON.stringify(extra));
      assert.equal(late.release?.backoffMs, INDEPENDENT_BLOCK_BASE_BACKOFF_MS);
    }
  }
});
