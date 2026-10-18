import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import * as dispatchValue from "../src/lib/dispatch-value.js";
import type { DispatchValueContext } from "../src/lib/dispatch-value.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { assertLintClean } from "../src/lib/task-linter.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");

function task(id: string, overrides: Partial<Task> = {}): Task {
  const value: Task = {
    id, title: id, repo: "remudero", type: "implement", verify: "auto", risk: "high",
    band_meaning: "span", status: "queued", attempts: 0, origin: "architect",
    files: [`src/${id}.ts`], priority: 1, depends_on: [],
    acceptance: [{ claim: "dispatch records its score", proof: "unit test: W1-T9325:" }],
    ...overrides,
  };
  assertLintClean(value);
  return value;
}

function contextFor(tasks: Task[]): DispatchValueContext {
  const historyId = "W1-T6000";
  const result = dispatchValue.buildDispatchValueContext(tasks, [
    { step: "run.start", task_id: historyId, run_id: "history", task_class: "src", ts: new Date(NOW - 4 * HOUR).toISOString() },
    { step: "verdict", task_id: historyId, run_id: "history", verdict: "merged", cost_usd: 2, ts: new Date(NOW - 3 * HOUR).toISOString() },
  ], new Set(tasks.map(t => t.id)), NOW, true, "seed", {
    planTreeSha: "fixed-tree",
    filedAtByTaskId: new Map([[historyId, NOW - 6 * HOUR], ...tasks.map(t => [t.id, NOW] as const)]),
  });
  assert.equal(result.kind, "ready");
  return result.context;
}

function fixedContext(tasks: Task[]): DispatchValueContext {
  return {
    ...contextFor(tasks),
    costOfDelayByTaskId: new Map(tasks.map((t, i) => [t.id, [3.5, 2, 1.1, 0.8][i]])),
    stridePassByTaskId: new Map(tasks.map((t, i) => [t.id, 1 / [3.5, 2, 1.1, 0.8][i]])),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });
type Row = { step: string; extra?: Record<string, unknown> };

function harness(tasks: Task[], context: DispatchValueContext | undefined, max = 2, extra: Partial<DaemonDeps> = {}) {
  const rows: Row[] = [];
  const started: string[] = [];
  const release = new Map(tasks.map(t => [t.id, deferred<RunResult>()]));
  const merged = new Set<string>();
  const ready = deferred<void>();
  let builds = 0;
  let selections = 0;
  let stopped = false;
  const plan: Plan = { tasks, byId: new Map(tasks.map(t => [t.id, t])) };
  const run = runDaemon(plan, {
    refreshMerged: () => id => merged.has(id),
    log: (step, payload) => { rows.push({ step, extra: payload }); },
    beginSelectionPass: () => { selections++; },
    buildDispatchValueContext: () => { builds++; return context; },
    runOne: async id => {
      started.push(id);
      if (started.length === 2) ready.resolve();
      const result = await release.get(id)!.promise;
      merged.add(id);
      return result;
    },
    sleep: async () => { await drainMicrotasks(); },
    checkStop: () => stopped ? "fixture complete" : undefined,
    ...extra,
  }, { laneCount: 2, max });
  return {
    rows, started, ready: ready.promise, builds: () => builds, selections: () => selections,
    picks: () => rows.filter(r => r.step === "dispatch.pick_scored").map(r => r.extra),
    free: async (id: string) => { release.get(id)!.resolve(okResult(id)); await drainMicrotasks(); },
    finish: async () => {
      stopped = true;
      for (const [id, held] of release) held.resolve(okResult(id));
      return run;
    },
  };
}

test("W1-T9325: a tick start logs dispatch.pick_scored with its components and the runner-up", async () => {
  const tasks = [task("X"), task("Y"), task("Z"), task("BLOCKED", { dispatch_hold: true })];
  const context = { ...fixedContext(tasks), stridePassByTaskId: new Map([["X", 1 / 3.5], ["Y", 0.5], ["Z", 1 / 1.1], ["BLOCKED", 0]]) };
  const h = harness(tasks, context);
  try {
    await h.ready;
    assert.deepEqual(h.started, ["X", "Y"]);
    assert.equal(h.builds(), 1, "the ordering context is built once");
    assert.equal(h.selections(), 1, "observing the frontier never repeats eligibility");
    const components = (score: number) => ({
      basis: "cost-of-delay", priority: 1, priority_head_start: 1, filing_age_ms: 0,
      median_wait_ms: 2 * HOUR, urgency: 1, score, stride_pass: 1 / score,
      starts: 0, open_dependents: 0, dependent_value: 0, imputed: false,
    });
    assert.deepEqual(h.picks(), [3.5, 2].map((score, i) => ({
      task: tasks[i].id, site: "tick", rank: i + 1, ...components(score),
      runner_up: { task: "Z", ...components(1.1), reason: "order" },
    })));
    assert.deepEqual(h.rows.find(r => r.step === "dispatch.concurrent_set")?.extra, { tasks: ["X", "Y"], lane_count: 2 });
  } finally { await h.finish(); }
});

test("W1-T9325: a lane refill logs dispatch.pick_scored for the task it starts", async () => {
  const tasks = [task("X"), task("Y"), task("Z"), task("NEXT")];
  const context = fixedContext(tasks);
  const refillContext = {
    ...context,
    costOfDelayByTaskId: new Map([...context.costOfDelayByTaskId!, ["Z", 0.9]]),
    stridePassByTaskId: new Map([...context.stridePassByTaskId!, ["Z", 1 / 0.9]]),
  };
  let builds = 0;
  const h = harness(tasks, context, 3, {
    buildDispatchValueContext: () => ++builds === 1 ? context : refillContext,
  });
  try {
    await h.ready;
    await h.free("Y");
    assert.deepEqual(h.started, ["X", "Y", "Z"]);
    assert.equal(builds, 2, "one context for tick, one for refill");
    assert.equal(h.selections(), 2);
    assert.deepEqual(h.picks()[2], {
      task: "Z", site: "lane-refill", rank: 1,
      basis: "cost-of-delay", priority: 1, priority_head_start: 1, filing_age_ms: 0,
      median_wait_ms: 2 * HOUR, urgency: 1, score: 0.9, stride_pass: 1 / 0.9,
      starts: 0, open_dependents: 0, dependent_value: 0, imputed: false,
      runner_up: {
        task: "NEXT", basis: "cost-of-delay", priority: 1, priority_head_start: 1,
        filing_age_ms: 0, median_wait_ms: 2 * HOUR, urgency: 1, score: 0.8,
        stride_pass: 1 / 0.8, starts: 0, open_dependents: 0, dependent_value: 0, imputed: false, reason: "order",
      },
    });
    assert.deepEqual(h.rows.find(r => r.step === "dispatch.lane_refilled")?.extra,
      { lane: 1, finished_task: "Y", next_task: "Z" });
  } finally { await h.finish(); }
});

test("W1-T9325: a fallback pick logs dispatch.pick_scored with basis priority-first", async () => {
  const tasks = [task("X", { priority: 3 }), task("Y", { priority: 1 }), task("Z", { priority: 2 })];
  for (const context of [undefined, { ...fixedContext(tasks), costOfDelayFallback: true }]) {
    const h = harness(tasks, context);
    try {
      await h.ready;
      assert.deepEqual(h.started, ["Y", "Z"]);
      assert.deepEqual(h.picks(), ["Y", "Z"].map((id, i) => ({
        task: id, site: "tick", rank: i + 1, basis: "priority-first", priority: i + 1,
        runner_up: { task: "X", basis: "priority-first", priority: 3, reason: "order" },
      })));
    } finally { await h.finish(); }
  }
});

test("W1-T9325: a runner-up serialized by packing keeps its score and reason", async () => {
  for (const observed of [false, true]) {
    const tasks = [task("X"), task("Y", { files: [observed ? "src/Y.ts" : "src/X.ts"] }), task("Z")];
    const h = harness(tasks, fixedContext(tasks), 2, {
      observedByTask: observed ? new Map([["Y", { files: ["src/X.ts"] }]]) : undefined,
    });
    try {
      await h.ready;
      assert.deepEqual(h.started, ["X", "Z"]);
      assert.deepEqual(h.picks().map(row => row?.rank), [1, 3]);
      for (const row of h.picks()) {
        assert.deepEqual(row?.runner_up, {
          task: "Y", basis: "cost-of-delay", priority: 1, priority_head_start: 1,
          filing_age_ms: 0, median_wait_ms: 2 * HOUR, urgency: 1, score: 2,
          stride_pass: 0.5, starts: 0, open_dependents: 0, dependent_value: 0, imputed: false, reason: "serialized",
        });
      }
    } finally { await h.finish(); }
  }
});

test("W1-T9325: exhausted candidates have no runner-up and refused admissions have no pick row", async () => {
  const tasks = [task("X"), task("Y")];
  const h = harness(tasks, fixedContext(tasks));
  try {
    await h.ready;
    assert.equal(h.picks().length, 2);
    assert.ok(h.picks().every(row => row?.runner_up === null));
  } finally { await h.finish(); }
  const held = harness(tasks, fixedContext(tasks), 2, {
    checkHeavyNewBuild: () => ({ deferred: true, requestId: "heavy", readyAtMs: NOW, expiresAtMs: NOW + HOUR, detail: "ready" }),
  });
  await drainMicrotasks();
  await held.finish();
  assert.deepEqual(held.started, []);
  assert.deepEqual(held.picks(), []);
});

test("W1-T9325: explanation preserves calibrated inputs without reading a clock", t => {
  const tasks = [task("X"), task("Y", { priority: 2, depends_on: ["X"] })];
  const context = contextFor(tasks);
  const absentPriority = task("ABSENT", { priority: undefined });
  t.mock.method(Date, "now", () => { throw new Error("explanations must use the context's time"); });
  const explanation = dispatchValue.explainDispatchScore(tasks[0], context);
  assert.deepEqual(explanation, {
    basis: "cost-of-delay", priority: 1, priority_head_start: 1, filing_age_ms: 0,
    median_wait_ms: 2 * HOUR, urgency: 1, score: context.costOfDelayByTaskId!.get("X"),
    stride_pass: context.stridePassByTaskId!.get("X"), starts: 0, open_dependents: 1, dependent_value: 0.25, imputed: false,
  });
  assert.deepEqual(dispatchValue.explainDispatchScore(tasks[0], context), explanation);
  const lower = dispatchValue.explainDispatchScore(tasks[1], context);
  assert.equal(lower.basis, "cost-of-delay");
  assert.equal(lower.priority_head_start, 0.5);
  assert.equal(lower.dependent_value, 0);
  assert.deepEqual(dispatchValue.explainDispatchScore(absentPriority),
    { basis: "priority-first", priority: null });
});

test("W1-T9325: calibrated age, starts and imputation survive in the explanation", () => {
  const dated = task("W1-T7001");
  const imputed = task("W1-T7002", { priority: 2, depends_on: [dated.id] });
  const result = dispatchValue.buildDispatchValueContext([dated, imputed], [
    { step: "run.start", task_id: dated.id, run_id: "attempt", task_class: "src", ts: new Date(NOW - 4 * HOUR).toISOString() },
    { step: "verdict", task_id: dated.id, run_id: "attempt", verdict: "merged", cost_usd: 2, ts: new Date(NOW - 3 * HOUR).toISOString() },
  ], new Set([dated.id, imputed.id]), NOW, true, "seed", {
    planTreeSha: "fixed-tree", filedAtByTaskId: new Map([[dated.id, NOW - 6 * HOUR]]),
  });
  assert.equal(result.kind, "ready");
  const explanation = dispatchValue.explainDispatchScore(dated, result.context);
  assert.equal(explanation.basis, "cost-of-delay");
  assert.equal(explanation.filing_age_ms, 6 * HOUR);
  assert.equal(explanation.median_wait_ms, 2 * HOUR);
  assert.equal(explanation.urgency, 3);
  assert.equal(explanation.starts, 1);
  assert.equal(explanation.open_dependents, 1);
  assert.equal(explanation.dependent_value, 0.25, "fresh P2 dependent is discounted one dependency level");
  assert.equal(explanation.imputed, false);
  // W1-T9968: the stride pass is a no-fan-out slot of the task's tier; alone in it, the task holds its own.
  const ownScore = explanation.score! * 3 / (3 + 0.25);
  assert.ok(Math.abs(explanation.stride_pass! - 2 / ownScore) < 1e-12,
    "the tier slot uses own urgency, excluding the weighted dependent value");
  const undated = dispatchValue.explainDispatchScore(imputed, result.context);
  assert.equal(undated.basis, "cost-of-delay");
  assert.equal(undated.filing_age_ms, 0);
  assert.equal(undated.imputed, true);
  assert.equal(undated.urgency, 0.5);
  assert.equal(undated.dependent_value, 0);
});
