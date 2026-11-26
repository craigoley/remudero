import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { benchmarkRunLedgerLogger, endThrownRun, withInflightRunLock } from "#src/run-task.js";
import { deriveAnalyticsSnapshot } from "#src/lib/analytics-route.js";
import { bootSweepDispatchClaims, bootSweepDispatchClaimsAsync, dispatchClaimRef } from "#src/lib/dispatch-claim.js";
import { acquireInflightLock, readInflightLock } from "#src/lib/inflight-lock.js";
import { anchorMessage, DEAD_PID, fakeReserver, FIXED_HOST_PROBE, instance, LOCAL } from "#test/helpers/restart-orphan.js";

const day = "2026-11-10";
const now = `${day}T23:59:59.000Z`;

function ledger() {
  const rows: Record<string, unknown>[] = [];
  const log = benchmarkRunLedgerLogger((step, fields) => rows.push({ step, ...fields }));
  return { log, rows };
}

function runRow(runId: string, seconds: number, step: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> & { ts: string } {
  const ts = new Date(Date.parse(`${day}T00:00:00.000Z`) + seconds * 1000).toISOString();
  return { ts, run_id: runId, step, ...fields };
}

function lastPoint(rows: Record<string, unknown>[], seriesId: string) {
  return deriveAnalyticsSnapshot(rows, now).timeSeries.find((series) => series.id === seriesId)?.points.at(-1);
}

test("W1-T12154 criterion 1 records the last run phase across a generic terminal error", () => {
  const { log, rows } = ledger();
  log("run.start", { type: "implement" });
  log("run.phase", { waiting_on: "recon" });
  log("run.phase", { waiting_on: "implementing" });
  log("run.agent_wait_heap", { waiting_on: "implementing" });
  log("verdict", { verdict: "failed", stage: "run.error", reason: "could not launch worker" });
  assert.deepEqual(rows.at(-1), {
    step: "verdict", verdict: "failed", stage: "run.error", reason: "could not launch worker",
    worker_assigned: false, last_stage: "implementing",
  });
});

test("W1-T12154 criterion 1 records a thrown setup failure at its named terminal stage", async (t) => {
  const { log, rows } = ledger();
  const taskId = "W1-T12154";
  const inflight = join(instance(t, []).stateDir, "inflight");
  const lock = acquireInflightLock(inflight, taskId, { run_id: "setup-failure" });
  await withInflightRunLock(lock, taskId, log, async (runLog) => {
    runLog("run.start", { type: "implement" });
    endThrownRun(runLog, false, "worktree.node_modules", new Error("dependency setup failed"), 0);
  });
  assert.equal(rows.at(-1)?.worker_assigned, false);
  assert.equal(rows.at(-1)?.last_stage, "worktree.node_modules");
  assert.equal(readInflightLock(inflight, taskId), null);
});

test("W1-T12154 criterion 1 retains the latest ledger step when no phase or stage was recorded", () => {
  const { log, rows } = ledger();
  log("run.start", { type: "implement" });
  log("containment.probe", { check: "worker-environment" });
  log("verdict", { verdict: "blocked_containment" });
  assert.equal(rows.at(-1)?.last_stage, "containment.probe");
});

test("W1-T12154 criterion 3 counts explicit and legacy pre-assignment runs apart from completions and durations", () => {
  const rows = [
    runRow("explicit", 0, "run.start"),
    runRow("explicit", 1, "verdict", { verdict: "failed", worker_assigned: false }),
    runRow("legacy", 2, "run.start"),
    runRow("legacy", 3, "verdict", { verdict: "failed", stage: "preflight.isolation" }),
    runRow("unknown", 4, "run.start"),
    runRow("unknown", 14, "verdict", { verdict: "failed", stage: "run.error" }),
  ];
  assert.equal(lastPoint(rows, "runs.completed")?.value, 1);
  assert.equal(lastPoint(rows, "runs.completed")?.endedBeforeWorkerAssignment, 2);
  assert.equal(lastPoint(rows, "duration.p50.ms")?.value, 10_000);
});

test("W1-T12154 criterion 3 counts an explicit verdict even when the run start is outside the retained ledger", () => {
  const rows = [runRow("explicit", 1, "verdict", { worker_assigned: false })];
  assert.deepEqual(lastPoint(rows, "runs.completed"), {
    t: `${day}T00:00:00.000Z`, value: 0, gap: false, endedBeforeWorkerAssignment: 1,
  });
  assert.equal(lastPoint(rows, "duration.p50.ms")?.gap, true);
});

test("W1-T12154 criterion 4 preserves an assigned run even when its verdict matches the legacy refusal rule", () => {
  const { log, rows } = ledger();
  log("run.start", { type: "implement" });
  log("worker.assignment", { worker_assignment: {
    id: "assigned", requested: { model: "m", effort: "low" }, selected: { provider: "codex", model: "m", effort: "low" },
  } });
  log("verdict", { verdict: "blocked_transient" });
  assert.equal(Object.hasOwn(rows.at(-1)!, "worker_assigned"), false);
  assert.equal(Object.hasOwn(rows.at(-1)!, "last_stage"), false);
  const dated = rows.map((row, index) => runRow("assigned", index * 5, String(row.step), row));
  assert.equal(lastPoint(dated, "runs.completed")?.value, 1);
  assert.equal(lastPoint(dated, "runs.completed")?.endedBeforeWorkerAssignment, undefined);
  assert.equal(lastPoint(dated, "duration.p50.ms")?.value, 10_000);
});

test("W1-T12154 criterion 4 preserves a terminal row explicitly marked as assigned", () => {
  const rows = [
    runRow("assigned", 0, "run.start"),
    runRow("assigned", 7, "verdict", { verdict: "blocked_containment", worker_assigned: true }),
  ];
  assert.equal(lastPoint(rows, "runs.completed")?.value, 1);
  assert.equal(lastPoint(rows, "runs.completed")?.endedBeforeWorkerAssignment, undefined);
  assert.equal(lastPoint(rows, "duration.p50.ms")?.value, 7000);
});

for (const sweep of [bootSweepDispatchClaims, bootSweepDispatchClaimsAsync]) {
  test(`W1-T12154 criterion 4 preserves an assigned run ended by ${sweep.name}`, async (t) => {
    const taskId = "W1-T12154";
    const runId = `${taskId}-${Date.parse(`${day}T00:00:00.000Z`)}`;
    const claim = { task_id: taskId, host: LOCAL };
    const rows = [
      runRow(runId, 0, "run.start", { ...claim, type: "implement" }),
      runRow(runId, 1, "dispatch.claim", { ...claim, actor: "run_child", ref: dispatchClaimRef(taskId), outcome: "created" }),
      runRow(runId, 2, "worker.assignment", { ...claim, worker_assignment: { id: "assigned" } }),
    ];
    const mint = rows[1]!.ts;
    const restarted = instance(t, rows);
    await sweep(fakeReserver({ [taskId]: anchorMessage(DEAD_PID, LOCAL, mint) }), {
      stateDir: restarted.stateDir,
      hostProbe: { ...FIXED_HOST_PROBE, namespaceBootMs: () => Date.parse(rows[2]!.ts) + 1000 },
      lockHeldSinceMs: Date.parse(now),
      lockHeldSinceIso: now,
      log: (step, fields) => rows.push(runRow(runId, 4, step, fields)),
    });
    const verdict = rows.find((row) => row.step === "verdict");
    assert.equal(verdict?.reason, "orphaned-by-restart");
    assert.equal(lastPoint(rows, "runs.completed")?.value, 1);
    assert.equal(lastPoint(rows, "runs.completed")?.endedBeforeWorkerAssignment, undefined);
    assert.equal(lastPoint(rows, "duration.p50.ms")?.value, 4000);
  });
}
