import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { runnableCandidates } from "../src/lib/drain.js";
import type { ObservedScopeByTask } from "../src/lib/dispatch-overlap.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { assertLintClean } from "../src/lib/task-linter.js";
import type { RunResult } from "../src/run-task.js";

function task(id: string, files: string[], priority: number, depends_on: string[] = []): Task {
  const value: Task = {
    id, title: id, repo: "remudero", type: "implement", verify: "auto", risk: "high", band_meaning: "span",
    status: "queued", attempts: 0, origin: "architect", files, priority, depends_on,
    acceptance: [{ claim: "refill respects occupied lanes", proof: "unit test: W1-T8502: a lane refill" }],
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

function okResult(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 };
}

function refillHarness(candidates: Task[], observedByTask?: ObservedScopeByTask, sibling?: Task) {
  const A = task("A", ["src/lib/sweep.ts"], 0);
  const B = task("B", ["src/b.ts"], 0);
  const initial = [A, B, ...(sibling ? [sibling] : [])];
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
    observedByTask,
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

test("W1-T8502: a lane refill picks the P1 disjoint from the in-flight lanes over a later P2", { timeout: 5_000 }, async () => {
  for (const observed of [false, true]) {
    const X = task("X", observed ? ["src/run-task.ts"] : ["src/lib/sweep.ts", "src/run-task.ts"], 1, ["B"]);
    const Y = task("Y", ["src/run-task.ts"], 1, ["B"]);
    const Z = task("Z", ["src/z.ts"], 2, ["B"]);
    const observedByTask = observed ? new Map([["X", { files: ["src/lib/sweep.ts"] }]]) : undefined;
    const h = refillHarness([X, Y, Z], observedByTask);
    try {
      await h.ready;
      assert.deepEqual(h.started, ["A", "B"]);
      await h.freeLane();
      assert.deepEqual(h.started, ["A", "B", "Y"], "Y takes B's lane while sweep.ts is occupied");
      assert.deepEqual(h.rows.filter((r) => r.step === "dispatch.lane_refilled").map((r) => r.extra),
        [{ lane: 1, finished_task: "B", next_task: "Y" }]);
    } finally {
      await h.finish();
    }
  }
});

test("W1-T8502: a lane refill logs dispatch.serialized for a pool task an in-flight lane blocks", { timeout: 5_000 }, async () => {
  for (const siblingOverlap of [false, true]) {
    const X = task("X", ["src/lib/sweep.ts", "src/x.ts"], 1, ["B"]);
    const Y = task("Y", ["src/y.ts"], 1.5, ["B"]);
    const observedByTask = new Map([["Y", { files: ["src/lib/sweep.ts"] }]]);
    const C = siblingOverlap ? task("C", ["src/c.ts"], 0) : undefined;
    const h = refillHarness([X, Y], observedByTask, C);
    try {
      await h.ready;
      assert.equal(h.rows.some((r) => r.step === "dispatch.serialized"), false);
      if (C) observedByTask.set(C.id, { files: ["src/lib/sweep.ts"] });
      await h.freeLane();
      assert.deepEqual(h.started, C ? ["A", "B", "C"] : ["A", "B"]);
      assert.deepEqual(h.rows.filter((r) => r.step === "dispatch.serialized").map((r) => r.extra), [
        { task: "X", blocked_by: "A", reason: "file-overlap", paths: ["src/lib/sweep.ts"] },
        { task: "Y", blocked_by: "A", reason: "file-overlap", paths: ["src/lib/sweep.ts"] },
      ], "only pool deferrals are logged, even if an occupied sibling's observed scope now overlaps");
    } finally {
      await h.finish();
    }
  }
});

test("W1-T8502: a lane refill pack is unchanged when nothing in flight constrains it", () => {
  const X = task("X", ["src/shared.ts"], 1);
  const Y = task("Y", ["src/shared.ts"], 1.5);
  const Z = task("Z", ["src/z.ts"], 2);
  const queue = plan([X, Y, Z]);
  const select = (inFlight?: readonly Task[], limit = 2) =>
    runnableCandidates(queue, () => false, limit, { inFlight });
  const baseline = runnableCandidates(queue, () => false, 2);
  assert.deepEqual(baseline, [X, Z]);
  assert.equal(JSON.stringify(select()), JSON.stringify(baseline));
  assert.equal(JSON.stringify(select([])), JSON.stringify(baseline));
  assert.deepEqual(select([task("A", ["src/a.ts"], 0)]), baseline);

  const blockedQueue = plan([X, Y]);
  const occupied = task("A", ["src/shared.ts"], 0);
  assert.equal(JSON.stringify(runnableCandidates(blockedQueue, () => false, 2, { inFlight: [occupied] })),
    JSON.stringify(runnableCandidates(blockedQueue, () => false, 2)));
  assert.deepEqual(select([X], 3), [Z, Y], "an occupied task is never returned, even by the fallback");
  assert.deepEqual(select([{ ...X }], 3), [Z, Y], "task identity is its id, not an object reference");
  assert.deepEqual(select([X], 0), []);
  assert.deepEqual(runnableCandidates(plan([X]), () => false, 2, { inFlight: [X] }), []);
});
