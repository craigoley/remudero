import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import * as drain from "#src/lib/drain.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { assertLintClean } from "#src/lib/task-linter.js";

const { runDrain, runnableCandidates } = drain;
type NextRunnableOpts = drain.NextRunnableOpts;

function task(id: string, files: string[], priority = 1, depends_on: string[] = []): Task {
  const value: Task = {
    id, title: id, repo: "remudero", type: "implement", verify: "auto", risk: "high", band_meaning: "span",
    status: "queued", attempts: 0, origin: "architect", files, priority, depends_on,
    acceptance: [{ claim: "the pack names passed-over work", proof: "unit test: W1-T8771:" }],
  };
  assertLintClean(value);
  return value;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

type Observation = { task: string; detail: unknown };
function observer(rows: Observation[]): NextRunnableOpts {
  return { onPassedOver: (t, detail) => { rows.push({ task: t.id, detail }); } };
}

test("W1-T8771: the pack names a P1 it passes over with its holder and paths", () => {
  for (const observed of [false, true]) {
    const X = task("X", observed ? ["src/a.ts"] : ["src/a.ts", "src/b.ts"]);
    const Y = task("Y", ["src/b.ts"]);
    const Z = task("Z", ["src/c.ts"], 2);
    const rows: Observation[] = [];
    const observedByTask = observed ? new Map([["X", { files: ["src/b.ts"] }]]) : undefined;
    assert.deepEqual(runnableCandidates(plan([X, Y, Z]), () => false, 2, { ...observer(rows), observedByTask }), [X, Z]);
    assert.deepEqual(rows, [{ task: "Y", detail: { passedFor: ["Z"], holders: [{ task: "X", paths: ["src/b.ts"] }] } }]);
  }

  const A = task("A", ["src/a.ts"], 0);
  const X = task("X", ["src/b.ts"]);
  const Y = task("Y", ["src/a.ts", "src/b.ts"]);
  const Z = task("Z", ["src/c.ts"], 2);
  const rows: Observation[] = [];
  assert.deepEqual(runnableCandidates(plan([A, X, Y, Z]), () => false, 2, { ...observer(rows), inFlight: [A] }), [X, Z]);
  assert.deepEqual(rows, [{ task: "Y", detail: { passedFor: ["Z"], holders: [
    { task: "X", paths: ["src/b.ts"] }, { task: "A", paths: ["src/a.ts"] },
  ] } }]);
});

test("W1-T8771: the pack result is unchanged and a task behind the cut is not named", () => {
  const X = task("X", ["src/a.ts", "src/b.ts"]);
  const Y = task("Y", ["src/b.ts"]);
  const Z = task("Z", ["src/c.ts"], 2);
  const tail = task("tail", ["src/b.ts"], 3);
  const queue = plan([X, Y, Z, tail]);
  const rows: Observation[] = [];
  const baseline = runnableCandidates(queue, () => false, 2);
  assert.deepEqual(runnableCandidates(queue, () => false, 2, observer(rows)), baseline);
  assert.deepEqual(rows.map((r) => r.task), ["Y"]);
  assert.deepEqual(runnableCandidates(queue, () => false, 2, {
    onPassedOver: () => { throw new Error("observer unavailable"); },
  }), baseline);
  rows.length = 0;
  assert.deepEqual(runnableCandidates(plan([X, Y]), () => false, 2, observer(rows)), [X, Y]);
  assert.deepEqual(rows, [], "the fallback still collects an overlapping candidate");
  assert.deepEqual(runnableCandidates(queue, () => false, 0, observer(rows)), []);
  assert.deepEqual(rows, []);

  const waiting = task("waiting", ["src/b.ts", "src/c.ts"]);
  const deferred = task("deferred", ["src/c.ts"], 2);
  const later = task("later", ["src/d.ts"], 3);
  const deferrals: string[] = [];
  const priorityRows: Observation[] = [];
  assert.deepEqual(runnableCandidates(plan([X, waiting, deferred, later]), () => false, 2, {
    ...observer(priorityRows), onDeferredForPriority: (d) => { deferrals.push(d.task.id); },
  }), [X, later]);
  assert.deepEqual(deferrals, ["deferred"]);
  assert.deepEqual(priorityRows.map((r) => r.task), ["waiting"], "priority deferrals already have their own row");
});

type Row = { step: string; extra?: Record<string, unknown> };
const passedRows = (rows: Row[]) => rows.filter((r) => r.step === "dispatch.passed_over").map((r) => r.extra);
const ok = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });

test("W1-T8771: holder state ignores holder order, path order, and passed-for changes", () => {
  const holders = [{ task: "B", paths: ["src/b.ts", "src/a.ts"] }, { task: "A", paths: ["src/c.ts"] }];
  const key = drain.passedOverStateKey({ passedFor: ["X"], holders });
  assert.equal(drain.passedOverStateKey({ passedFor: ["Y"], holders: [
    holders[1], { task: "B", paths: ["src/a.ts", "src/b.ts"] },
  ] }), key);
  assert.notEqual(drain.passedOverStateKey({ passedFor: ["X"], holders: [holders[0]] }), key);
  assert.notEqual(drain.passedOverStateKey({ passedFor: ["X"], holders: [
    { task: "B", paths: ["src/a.ts"] }, holders[1],
  ] }), key);
  assert.deepEqual(holders.map((h) => h.task), ["B", "A"]);
  assert.deepEqual(holders[0].paths, ["src/b.ts", "src/a.ts"]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function tickRows(): Promise<Row[]> {
  const X = task("X", ["src/a.ts", "src/b.ts"]);
  const other = task("V", ["src/b.ts", "src/a.ts"]);
  const reordered = { ...other, files: ["src/a.ts", "src/b.ts"] };
  const Y = task("Y", ["src/a.ts", "src/b.ts"]);
  const Z = task("Z", ["src/c.ts"], 2);
  const Q = task("Q", ["src/d.ts"], 2);
  const snapshots = [
    [X, Y, Z], [X, Y, Q], [other, Y, Q], [reordered, Y, Q],
    [Y, Q], [other, Y, Q], [other, Q], [other, Y, Q],
  ];
  let pass = 0;
  let governorReads = 0;
  const rows: Row[] = [];
  await runDaemon(plan(snapshots[0]), {
    refreshMerged: () => () => false,
    reloadPlan: () => plan(snapshots[pass]),
    checkQueueGovernor: () => ++governorReads % 2 === 0
      ? { deferred: true, observedOpenCount: 2, wipLimit: 2 } : undefined,
    runOne: async (id) => { assert.fail(`held task ${id} must not start`); },
    sleep: async () => { pass++; },
    checkStop: () => pass >= snapshots.length ? "fixture complete" : undefined,
    log: (step, extra) => { rows.push({ step, extra }); },
  }, { laneCount: 2 });
  return rows;
}

async function refillRows(observedOnTick = false): Promise<Row[]> {
  const A = task("A", ["src/a.ts"], 0);
  const B = task("B", ["src/b.ts"], observedOnTick ? 2 : 0);
  const X = task("X", ["src/a.ts", "src/changed.ts"], 1, observedOnTick ? [] : ["B"]);
  const fast = ["C", "D", "E", "F"].map((id) => task(id, [`src/${id}.ts`], 2, ["B"]));
  const release = new Map([A, B, ...fast].map((t) => [t.id, deferred<RunResult>()]));
  const started = new Set<string>();
  const rows: Row[] = [];
  const merged = new Set<string>();
  const observedByTask = new Map<string, { files: string[] }>();
  let stopped = false;
  const run = runDaemon(plan([A, B, X, ...fast]), {
    refreshMerged: () => (id) => merged.has(id),
    observedByTask,
    runOne: async (id) => {
      started.add(id);
      const result = await release.get(id)!.promise;
      merged.add(id);
      return result;
    },
    log: (step, extra) => { rows.push({ step, extra }); },
    sleep: async () => { await drainMicrotasks(); },
    checkStop: () => stopped ? "fixture complete" : undefined,
  }, { laneCount: 2, max: 6 });
  try {
    await drainMicrotasks();
    assert.deepEqual([...started], ["A", "B"]);
    release.get("B")!.resolve(ok("B"));
    await drainMicrotasks();
    assert.ok(started.has("C"));
    release.get("C")!.resolve(ok("C"));
    await drainMicrotasks();
    assert.ok(started.has("D"));
    assert.equal(passedRows(rows).length, 1, "a different passed_for set does not repeat the holder state");
    observedByTask.set("A", { files: ["src/changed.ts"] });
    release.get("D")!.resolve(ok("D"));
    await drainMicrotasks();
    assert.ok(started.has("E"));
    assert.equal(passedRows(rows).length, 2, "changed holder paths are a new state");
  } finally {
    stopped = true;
    for (const [id, held] of release) held.resolve(ok(id));
    await run;
  }
  return rows;
}

test("W1-T8771: the daemon logs dispatch.passed_over once per state on tick and refill", { timeout: 5_000 }, async () => {
  const tick = passedRows(await tickRows());
  assert.deepEqual(tick, [
    { task: "Y", priority: 1, site: "tick", passed_for: ["Z"], holders: [{ task: "X", paths: ["src/a.ts", "src/b.ts"] }] },
    ...Array.from({ length: 3 }, () => ({ task: "Y", priority: 1, site: "tick", passed_for: ["Q"],
      holders: [{ task: "V", paths: ["src/b.ts", "src/a.ts"] }] })),
  ], "holder changes, collecting the task, and removing it from the plan each begin a new observation");
  const refill = passedRows(await refillRows());
  assert.deepEqual(refill, [
    { task: "X", priority: 1, site: "lane-refill", passed_for: ["C", "D"], holders: [{ task: "A", paths: ["src/a.ts"] }] },
    { task: "X", priority: 1, site: "lane-refill", passed_for: ["E", "F"],
      holders: [{ task: "A", paths: ["src/a.ts", "src/changed.ts"] }] },
  ]);
  const shared = passedRows(await refillRows(true));
  assert.deepEqual(shared, [
    { task: "X", priority: 1, site: "tick", passed_for: ["B"], holders: [{ task: "A", paths: ["src/a.ts"] }] },
    refill[1],
  ], "the same state is shared between tick and refill");
  assert.equal(passedRows(await tickRows()).length, 4, "a fresh daemon records the states again");
});

test("W1-T8771: drain lanes name passed-over work", async () => {
  const X = task("X", ["src/a.ts", "src/b.ts"]);
  const Y = task("Y", ["src/b.ts"]);
  const Z = task("Z", ["src/c.ts"], 2);
  const rows: Row[] = [];
  const merged = new Set<string>();
  const summary = await runDrain(plan([X, Y, Z]), {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => { merged.add(id); return ok(id); },
    log: (step, extra) => { rows.push({ step, extra }); },
  }, { laneCount: 2, max: 3 });
  assert.deepEqual(summary.attempted, ["X", "Z", "Y"]);
  assert.deepEqual(passedRows(rows), [
    { task: "Y", priority: 1, site: "drain", passed_for: ["Z"], holders: [{ task: "X", paths: ["src/b.ts"] }] },
  ]);
});
