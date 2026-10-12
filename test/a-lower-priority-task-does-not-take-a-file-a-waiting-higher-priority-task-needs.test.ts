// W1-T8514 — A LOWER-PRIORITY TASK DOES NOT TAKE A FILE A WAITING HIGHER-PRIORITY TASK NEEDS. On 2026-10-12
// a P1 (sweep.ts + run-task.ts) lost run-task.ts to a co-collected P1, and a P2 took sweep.ts in the same
// tick and held it over three runs. These drive the real pack (`runnableCandidates`) and the REAL runDaemon;
// only the worker spawn (`runOne`) is faked, as deferred promises the test settles by hand.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { runnableCandidates, type PriorityBackfillEstimates, type PriorityReservationRelease } from "../src/lib/drain.js";
import { partitionByFileOverlap } from "../src/lib/dispatch-overlap.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { assertLintClean } from "../src/lib/task-linter.js";
import type { RunResult } from "../src/run-task.js";

function task(id: string, files: string[], priority: number, depends_on: string[] = []): Task {
  const value: Task = {
    id, title: id, repo: "remudero", type: "implement", verify: "auto", risk: "high", band_meaning: "span",
    status: "queued", attempts: 0, origin: "architect", files, priority, depends_on,
    acceptance: [{ claim: "a reservation holds the file", proof: "unit test: W1-T8514: a refill" }],
  };
  assertLintClean(value);
  return value;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Boot-ledger history of two measured 30-minute runs, so a holder that has run for milliseconds has not outrun
 *  them and C's own history is no shorter than the holder's expected remainder: the reservation holds. */
function longRunHistory(): string[] {
  const end = Date.now();
  return ["C", "Z"].flatMap((taskId) => [
    JSON.stringify({ step: "run.start", run_id: `h-${taskId}`, task_id: taskId, ts: new Date(end - 30 * 60_000).toISOString() }),
    JSON.stringify({ step: "verdict", run_id: `h-${taskId}`, task_id: taskId, ts: new Date(end).toISOString(), verdict: "merged" }),
  ]);
}

function okResult(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 };
}

/** In-flight A holds src/x.ts and B a disjoint file; the candidates depend on B, so they become runnable only
 *  when B's lane frees and refills. Every later task completes at once. */
function refillHarness(candidates: Task[], readLedgerLines?: () => string[]) {
  const A = task("A", ["src/x.ts"], 0);
  const B = task("B", ["src/b.ts"], 0);
  const initial = [A, B];
  const started: string[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const release = new Map(initial.map((t) => [t.id, deferred<RunResult>()]));
  const ready = deferred<void>();
  const merged = new Set<string>();
  let stopped = false;
  const deps: DaemonDeps = {
    refreshMerged: () => (id) => merged.has(id),
    log: (step, extra) => { rows.push({ step, extra }); },
    runOne: async (id) => {
      started.push(id);
      if (initial.every((t) => started.includes(t.id))) ready.resolve();
      const held = release.get(id);
      const result = held ? await held.promise : okResult(id);
      merged.add(id);
      return result;
    },
    checkStop: () => stopped ? "fixture complete" : undefined,
    sleep: async () => { await drainMicrotasks(); },
    ...(readLedgerLines ? { readLedgerLines } : {}),
  };
  const run = runDaemon(plan([...initial, ...candidates]), deps, { laneCount: initial.length, max: initial.length + 1 });
  return {
    started, rows, ready: ready.promise,
    freeLane: async () => {
      release.get("B")!.resolve(okResult("B"));
      await drainMicrotasks();
    },
    finish: async () => {
      stopped = true;
      for (const [id, held] of release) held.resolve(okResult(id));
      await run;
    },
  };
}

test("W1-T8514: a refill does not start a P2 on a file a waiting P1 needs and starts a disjoint P2", { timeout: 5_000 }, async () => {
  // A (in flight) holds x.ts. P1 W needs x.ts + y.ts, so it waits. P2 C needs y.ts, and P2 D is disjoint.
  const W = task("W", ["src/x.ts", "src/y.ts"], 1, ["B"]);
  const C = task("C", ["src/y.ts"], 2, ["B"]);
  const D = task("D", ["src/d.ts"], 2, ["B"]);
  const h = refillHarness([W, C, D], longRunHistory);
  try {
    await h.ready;
    assert.deepEqual(h.started, ["A", "B"]);
    await h.freeLane();
    assert.deepEqual(h.started, ["A", "B", "D"], "D takes the lane; C must not take the y.ts that W needs");
    assert.deepEqual(h.rows.filter((r) => r.step === "dispatch.lane_refilled").map((r) => r.extra),
      [{ lane: 1, finished_task: "B", next_task: "D" }]);
  } finally {
    await h.finish();
  }
});

test("W1-T8514: a tick pack keeps a P2 off the files of a P1 it skipped for overlap", () => {
  // The 05:35:54Z shape: H (R) is collected, W (R + S) loses R to it, and a P2 needing S must not take S.
  const build = (cPriority: number) => [
    task("H", ["src/r.ts"], 1), task("W", ["src/r.ts", "src/s.ts"], 1),
    task("C", ["src/s.ts"], cPriority), task("D", ["src/t.ts"], 2),
  ];
  const dispatched = (tasks: Task[]): string[] => {
    const packed = runnableCandidates(plan(tasks), () => false, 3);
    return partitionByFileOverlap(packed).dispatch.map((t) => t.id);
  };
  assert.deepEqual(dispatched(build(2)), ["H", "D"], "C is deferred for W; W serializes behind H");
  assert.deepEqual(dispatched(build(1)).sort(), ["C", "D", "H"], "a same-tier C keeps today's behaviour");
  // An absent priority is the lowest, as in compareDispatch.
  const noPriority = build(2);
  noPriority[2] = { ...noPriority[2], priority: undefined };
  assert.deepEqual(dispatched(noPriority), ["H", "D"]);
  // Observed scope joins the reservation: W's observed s.ts alone is enough to keep C off it.
  const observed = [task("H", ["src/r.ts"], 1), task("W", ["src/r.ts"], 1), task("C", ["src/s.ts"], 2), task("D", ["src/t.ts"], 2)];
  const observedByTask = new Map([["W", { files: ["src/s.ts"] }]]);
  assert.deepEqual(runnableCandidates(plan(observed), () => false, 3, { observedByTask }).map((t) => t.id).filter((id) => id !== "W"),
    ["H", "D"]);
});

test("W1-T8514: a priority reservation releases on the measured backfill bound", () => {
  const minute = 60_000;
  const A = task("A", ["src/x.ts"], 0);
  const W = task("W", ["src/x.ts", "src/y.ts"], 1);
  const C = task("C", ["src/y.ts"], 2);
  const queue = plan([A, W, C]);
  const pick = (est: { own?: Record<string, number[]>; fleet?: number[]; elapsed?: number } | undefined) => {
    const released: PriorityReservationRelease[] = [];
    const priorityBackfill: PriorityBackfillEstimates | undefined = est && {
      runLengthsMs: (id) => est.own?.[id] ?? [],
      fleetRunLengthsMs: () => est.fleet ?? [],
      elapsedMs: (id) => (id === "A" ? est.elapsed ?? 0 : undefined),
    };
    const ids = runnableCandidates(queue, (id) => id === "A-merged", 2, {
      inFlight: [A], priorityBackfill, onPriorityReservationReleased: (r) => released.push(r),
      excludeIds: new Set(["A"]),
    }).map((t) => t.id);
    return { ids, released: released.map((r) => r.reason) };
  };
  // No estimator, or nothing measured: the reservation holds and C waits.
  assert.deepEqual(pick(undefined), { ids: ["W"], released: [] });
  assert.deepEqual(pick({}), { ids: ["W"], released: [] });
  // C is expected to run 1 min; A has 10 min of history and has run 2: its expected remaining is 8 > 1.
  assert.deepEqual(pick({ own: { C: [minute], A: [10 * minute] }, elapsed: 2 * minute }),
    { ids: ["C", "W"], released: ["finishes_before_waiting_start"] });
  // The comparison is strict: equal estimates hold.
  assert.deepEqual(pick({ own: { C: [8 * minute], A: [10 * minute] }, elapsed: 2 * minute }), { ids: ["W"], released: [] });
  // The fleet's lengths stand in for a task with none of its own.
  assert.deepEqual(pick({ fleet: [minute, minute, 10 * minute], elapsed: 0 }), { ids: ["W"], released: [] },
    "mean 4 min vs a holder remaining mean of 4 min holds");
  // A holder that has outrun every measured run releases the reservation.
  assert.deepEqual(pick({ own: { C: [20 * minute], A: [10 * minute] }, elapsed: 30 * minute }),
    { ids: ["C", "W"], released: ["holder_outran_history"] });
});

test("W1-T8514: a priority deferral logs dispatch\.deferred_for_priority with the waiting task and paths", { timeout: 5_000 }, async () => {
  const W = task("W", ["src/x.ts", "src/y.ts"], 1, ["B"]);
  const C = task("C", ["src/y.ts"], 2, ["B"]);
  const h = refillHarness([W, C], longRunHistory);
  try {
    await h.ready;
    await h.freeLane();
    assert.deepEqual(h.started, ["A", "B"], "the only runnable work is reserved, so the lane stays idle");
    const rows = h.rows.filter((r) => r.step === "dispatch.deferred_for_priority");
    assert.ok(rows.length > 0, "a deferral row is written");
    assert.deepEqual(rows[0].extra, {
      task: "C", priority: 2, waiting_task: "W", waiting_priority: 1, holders: ["A"], paths: ["src/y.ts"],
      expected_duration_ms: 30 * 60_000, expected_start_ms: rows[0].extra?.expected_start_ms,
    });
    assert.ok(Number(rows[0].extra?.expected_start_ms) >= 30 * 60_000 - 1_000, "the holder's remainder is measured, not fixed");
    const held = h.rows.find((r) => r.step === "dispatch.lane_refill_held");
    assert.match(String(held?.extra?.reason), /priority reservation: C deferred for waiting W/);
  } finally {
    await h.finish();
  }
});
