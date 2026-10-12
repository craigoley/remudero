// The console's /fleet map evidences a worker process only from a task's `workerState` (or activity
// telemetry) and hides a row marked `processUnevidenced`. The board row carries both, but the now view
// projected only the worker's model, so whenever /fleet read core's now view it showed "0 worker
// processes" while /now (which reads `phase`) showed live workers.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow, BoardSnapshot } from "../src/lib/board.js";
import { assembleNowView, type NowHealth } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";

const NOW_MS = Date.parse("2026-10-05T15:05:00.000Z");

function boardRow(taskId: string, extra: Partial<BoardRow>): BoardRow {
  return { taskId, title: taskId, risk: "low", status: "running", merged: false, source: "ledger", phase: "implement", ...extra } as BoardRow;
}

function viewOf(tasks: BoardRow[]) {
  const snapshot = {
    tasks,
    counts: { running: tasks.length, queued: 0, blocked: 0 },
    spend: { spendTodayUsd: 0 },
    prQueue: { complete: true, rows: [] },
    blockedPrs: [],
    mergeHeld: [],
  } as unknown as BoardSnapshot;
  const plan = { byId: new Map() } as unknown as Plan;
  const health = { daemon: { state: "polling" } } as unknown as NowHealth;
  return assembleNowView({ instance: "core", snapshot, rows: [], plan, recent: [], health, decisions: { decisions: [] } as never, nowMs: NOW_MS });
}

test("the now view carries each running task's worker liveness so the fleet map can evidence its process", () => {
  const view = viewOf([
    boardRow("W1-T1", { workerState: "tool-executing", workerTelemetry: { servedModel: "sonnet" } }),
    boardRow("W1-T2", { workerState: "quiet", workerStateSince: "2026-10-05T15:00:00.000Z" }),
    boardRow("W1-T3", { processUnevidenced: true }),
    boardRow("W1-T4", { workerState: "working", workerStateSince: "2026-10-05T14:00:00.000Z" }),
  ]);
  const byId = new Map(view.board.tasks.map((t) => [t.taskId, t]));
  assert.equal(byId.size, 4);
  assert.equal(byId.get("W1-T1")!.workerState, "tool-executing");
  assert.deepEqual(byId.get("W1-T1")!.worker, { servedModel: "sonnet" });
  assert.equal(byId.get("W1-T2")!.workerState, "quiet");
  assert.equal(byId.get("W1-T2")!.workerStateSince, "2026-10-05T15:00:00.000Z");
  assert.equal(byId.get("W1-T3")!.processUnevidenced, true);
  assert.equal(byId.get("W1-T3")!.workerState, undefined);
  // `workerStateSince` stays sparse: only a quiet worker carries it.
  assert.equal(byId.get("W1-T4")!.workerState, "working");
  assert.equal("workerStateSince" in byId.get("W1-T4")!, false);
});
