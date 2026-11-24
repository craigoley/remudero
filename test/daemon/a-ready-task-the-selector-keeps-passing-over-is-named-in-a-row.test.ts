// W1-T14490 — INVARIANT a-long-wait-is-named: an eligible task the daemon's pick leaves unpicked past the
// starvation age writes one dispatch.starved row per UTC day, and naming it changes nothing about the pick.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
// The daemon and the live analytics cache import each other; the cache loads first (see ops-catalog-shadow-revision).
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import * as dispatchValue from "#src/lib/dispatch-value.js";
import type { DispatchValueContext } from "#src/lib/dispatch-value.js";
import {
  DISPATCH_STARVED_STEP, STARVATION_AGE_MS, dispatchReadySince, indexStarvationLedger, observeDispatchStarvation,
} from "#src/lib/dispatch-starvation.js";
import { runnableCandidates } from "#src/lib/drain.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { assertLintClean } from "#src/lib/task-linter.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-13T12:00:00Z");

function task(id: string, overrides: Partial<Task> = {}): Task {
  const value: Task = {
    id, title: id, repo: "remudero", type: "implement", verify: "auto", risk: "high",
    band_meaning: "span", status: "queued", attempts: 0, origin: "architect",
    files: [`src/${id}.ts`], priority: 1, depends_on: [],
    acceptance: [{ claim: "a long wait is named", proof: "unit test: W1-T14490 criterion 1" }],
    ...overrides,
  };
  assertLintClean(value);
  return value;
}

/** A measured context whose order is fixed by score, with each task's filing age set apart from it. */
function contextFor(tasks: Task[], scores: number[], ageMsById: Record<string, number>): DispatchValueContext {
  const historyId = "W1-T6000";
  const built = dispatchValue.buildDispatchValueContext(tasks, [
    { step: "run.start", task_id: historyId, run_id: "history", task_class: "src", ts: new Date(NOW - 4 * HOUR).toISOString() },
    { step: "verdict", task_id: historyId, run_id: "history", verdict: "merged", cost_usd: 2, ts: new Date(NOW - 3 * HOUR).toISOString() },
  ], new Set(tasks.map(t => t.id)), NOW, true, "seed", {
    planTreeSha: "fixed-tree",
    filedAtByTaskId: new Map([[historyId, NOW - 6 * HOUR], ...tasks.map(t => [t.id, NOW] as const)]),
  });
  assert.equal(built.kind, "ready");
  const context = built.context;
  return {
    ...context,
    costOfDelayByTaskId: new Map(tasks.map((t, i) => [t.id, scores[i]])),
    stridePassByTaskId: new Map(tasks.map((t, i) => [t.id, 1 / scores[i]])),
    costOfDelayInputsByTaskId: new Map(tasks.map(t => [t.id,
      { ...context.costOfDelayInputsByTaskId!.get(t.id)!, filing_age_ms: ageMsById[t.id] ?? 0 }])),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });
type Row = { step: string; extra?: Record<string, unknown> };

function harness(tasks: Task[], context: DispatchValueContext, lanes: number, extra: Partial<DaemonDeps> = {}) {
  const rows: Row[] = [];
  const started: string[] = [];
  const release = new Map(tasks.map(t => [t.id, deferred<RunResult>()]));
  const merged = new Set<string>();
  const ready = deferred<void>();
  let stopped = false;
  const plan: Plan = { tasks, byId: new Map(tasks.map(t => [t.id, t])) };
  const run = runDaemon(plan, {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(NOW),
    refreshMerged: () => id => merged.has(id),
    log: (step, payload) => { rows.push({ step, extra: payload }); },
    buildDispatchValueContext: () => context,
    runOne: async id => {
      started.push(id);
      if (started.length === lanes) ready.resolve();
      const result = await release.get(id)!.promise;
      merged.add(id);
      return result;
    },
    sleep: async () => { await drainMicrotasks(); },
    checkStop: () => stopped ? "fixture complete" : undefined,
    ...extra,
  }, { laneCount: lanes, max: tasks.length });
  return {
    plan, rows, started, ready: ready.promise,
    starved: () => rows.filter(r => r.step === DISPATCH_STARVED_STEP).map(r => r.extra),
    free: async (id: string) => { release.get(id)!.resolve(okResult(id)); for (let i = 0; i < 20; i++) await drainMicrotasks(); },
    finish: async () => {
      stopped = true;
      for (const [id, held] of release) held.resolve(okResult(id));
      return run;
    },
  };
}

const FOUR = () => [task("W1-T9001"), task("W1-T9002"), task("W1-T9003"), task("W1-T9004", { priority: 2 })];
const TEN_DAYS_ON_FOURTH = { "W1-T9004": 10 * DAY };
const ROW = {
  task: "W1-T9004", rank: 4, eligible_count: 4, ready_since: new Date(NOW - 10 * DAY).toISOString(),
  waited_days: 10, priority: 2, outranked_by: ["W1-T9001", "W1-T9002", "W1-T9003"],
};

test("W1-T14490 criterion 1: a 10-day-old eligible task ranked fourth with three lanes writes one dispatch.starved row", async () => {
  const tasks = FOUR();
  const h = harness(tasks, contextFor(tasks, [4, 3, 2, 1], TEN_DAYS_ON_FOURTH), 3);
  try {
    await h.ready;
    assert.deepEqual(h.started, ["W1-T9001", "W1-T9002", "W1-T9003"]);
    assert.deepEqual(h.starved(), [ROW]);
  } finally { await h.finish(); }

  // A second pass the same day writes none: a new process reads today's row back from the ledger.
  const ledger = [JSON.stringify({ ts: new Date(NOW - HOUR).toISOString(), step: DISPATCH_STARVED_STEP, ...ROW })];
  const again = harness(tasks, contextFor(tasks, [4, 3, 2, 1], TEN_DAYS_ON_FOURTH), 3, { readLedgerLines: () => ledger });
  try {
    await again.ready;
    assert.deepEqual(again.starved(), []);
  } finally { await again.finish(); }
});

test("W1-T14490 criterion 1: a lane refill that passes over the starved task again writes no second row that day", async () => {
  const tasks = [...FOUR(), task("W1-T9005")];
  const h = harness(tasks, contextFor(tasks, [5, 4, 3, 2, 1], { "W1-T9005": 9 * DAY }), 3);
  try {
    await h.ready;
    assert.deepEqual(h.starved().map(r => [r?.task, r?.rank, r?.eligible_count]), [["W1-T9005", 5, 5]]);
    assert.deepEqual(h.starved()[0]?.outranked_by, ["W1-T9001", "W1-T9002", "W1-T9003", "W1-T9004"]);
    await h.free("W1-T9001");
    assert.deepEqual(h.started, ["W1-T9001", "W1-T9002", "W1-T9003", "W1-T9004"]);
    assert.ok(h.rows.some(r => r.step === "dispatch.pick_scored" && r.extra?.site === "lane-refill"), "the refill picked");
    assert.equal(h.starved().length, 1, "the refill's pass over it the same day is not named again");
  } finally { await h.finish(); }
});

test("W1-T14490 criterion 1: the lane refill names a task its own fresh frontier finds starved", async () => {
  const tasks = [...FOUR(), task("W1-T9005")];
  const scores = [5, 4, 3, 2, 1];
  let builds = 0;
  const h = harness(tasks, contextFor(tasks, scores, {}), 3, {
    buildDispatchValueContext: () => contextFor(tasks, scores, ++builds === 1 ? {} : { "W1-T9005": 10 * DAY }),
  });
  try {
    await h.ready;
    assert.deepEqual(h.starved(), [], "the tick's context dates nothing past the age");
    await h.free("W1-T9001");
    assert.deepEqual(h.started, ["W1-T9001", "W1-T9002", "W1-T9003", "W1-T9004"]);
    assert.deepEqual(h.starved(), [{
      task: "W1-T9005", rank: 2, eligible_count: 2, ready_since: new Date(NOW - 10 * DAY).toISOString(),
      waited_days: 10, priority: 1, outranked_by: ["W1-T9004"],
    }]);
  } finally { await h.finish(); }
});

test("W1-T14490 criterion 1: the pure observer names rank, wait and what outranked it once per UTC day", () => {
  const eligible = [...FOUR(), task("W1-T9005"), task("W1-T9006"), task("W1-T9007", { priority: undefined })];
  const readySinceById = new Map([["W1-T9004", NOW - 10 * DAY], ["W1-T9006", NOW - STARVATION_AGE_MS],
    ["W1-T9007", NOW - 8.25 * DAY], ["W1-T9001", NOW - 30 * DAY]]);
  const picked = eligible.slice(0, 3);
  const first = observeDispatchStarvation({ eligible, picked, readySinceById, nowMs: NOW, lastRowDayById: new Map() });
  assert.deepEqual(first.map(r => r.task), ["W1-T9004", "W1-T9007"], "picked, undated and exactly-a-week tasks are not named");
  assert.deepEqual(first[1], {
    task: "W1-T9007", rank: 7, eligible_count: 7, ready_since: new Date(NOW - 8.25 * DAY).toISOString(),
    waited_days: 8.3, priority: null, outranked_by: ["W1-T9001", "W1-T9002", "W1-T9003", "W1-T9004", "W1-T9005"],
  });
  const days = indexStarvationLedger(first.map(r => JSON.stringify({ ts: new Date(NOW).toISOString(), step: DISPATCH_STARVED_STEP, ...r })));
  const later = observeDispatchStarvation({ eligible, picked, readySinceById, nowMs: NOW + HOUR, lastRowDayById: days.lastRowDayById });
  assert.deepEqual(later.map(r => r.task), ["W1-T9006"], "the same day names only the task that has just crossed the age");
  const tomorrow = observeDispatchStarvation({ eligible, picked, readySinceById, nowMs: NOW + DAY, lastRowDayById: days.lastRowDayById });
  assert.deepEqual(tomorrow.map(r => [r.task, r.waited_days]), [["W1-T9004", 11], ["W1-T9006", 8], ["W1-T9007", 9.3]]);
  const doubled = observeDispatchStarvation({ eligible: [eligible[3], eligible[3]], picked: [], readySinceById, nowMs: NOW, lastRowDayById: new Map() });
  assert.equal(doubled.length, 1, "a task listed twice is named once");
});

test("W1-T14490 criterion 1: ready-since is the later of filing and the last dependency's merge, read from the ledger", () => {
  const dep = task("W1-T9010");
  const child = task("W1-T9011", { depends_on: ["W1-T9010", "W1-T9012"] });
  const imputed = task("W1-T9013");
  const context = contextFor([dep, child, imputed], [3, 2, 1], { "W1-T9011": 20 * DAY, "W1-T9013": 20 * DAY });
  const lines = [
    "{torn",
    JSON.stringify({ ts: "not a time", step: "verdict.merged", task_id: "W1-T9010" }),
    JSON.stringify({ ts: new Date(NOW - 12 * DAY).toISOString(), step: "verdict.merged", task_id: "W1-T9010" }),
    JSON.stringify({ ts: new Date(NOW - 9 * DAY).toISOString(), step: "verdict", verdict: "merged", task_id: "W1-T9010" }),
    JSON.stringify({ ts: new Date(NOW - 11 * DAY).toISOString(), step: "verdict.merged", task_id: "W1-T9010" }),
    JSON.stringify({ ts: new Date(NOW - 2 * DAY).toISOString(), step: DISPATCH_STARVED_STEP, task: "W1-T9011" }),
    JSON.stringify({ ts: new Date(NOW - 3 * DAY).toISOString(), step: DISPATCH_STARVED_STEP, task: "W1-T9011" }),
    JSON.stringify({ ts: new Date(NOW).toISOString(), step: "run.start", task_id: "W1-T9011" }),
  ];
  const index = indexStarvationLedger(lines);
  assert.deepEqual([...index.mergedAtById], [["W1-T9010", NOW - 9 * DAY]]);
  assert.deepEqual([...index.lastRowDayById], [["W1-T9011", new Date(NOW - 2 * DAY).toISOString().slice(0, 10)]]);
  const withImputed = { ...context, costOfDelayImputed: ["W1-T9013"] };
  const ready = dispatchReadySince([dep, child, imputed], withImputed, NOW, index.mergedAtById);
  assert.deepEqual([...ready], [["W1-T9010", NOW], ["W1-T9011", NOW - 9 * DAY]]);
  assert.deepEqual([...dispatchReadySince([child], undefined, NOW, index.mergedAtById)], [], "no context dates nothing");
});

test("W1-T14490 criterion 2: the starvation row does not change which tasks the pick starts or their order", async () => {
  const tasks = FOUR();
  const order = async (ages: Record<string, number>) => {
    const h = harness(tasks, contextFor(tasks, [4, 3, 2, 1], ages), 3);
    try {
      await h.ready;
      const picks = h.rows.filter(r => r.step === "dispatch.pick_scored").map(r => [r.extra?.task, r.extra?.rank]);
      return { started: [...h.started], picks, starved: h.starved().length };
    } finally { await h.finish(); }
  };
  const named = await order(TEN_DAYS_ON_FOURTH);
  const silent = await order({});
  assert.equal(named.starved, 1);
  assert.equal(silent.starved, 0, "the observer writes nothing: the pick is the selector's alone");
  assert.deepEqual(named.started, silent.started);
  assert.deepEqual(named.picks, silent.picks);
  // And the selector itself, with no daemon and no observer, starts the same three in the same order.
  const plan: Plan = { tasks, byId: new Map(tasks.map(t => [t.id, t])) };
  const selector = runnableCandidates(plan, () => false, 3, { dispatchValueContext: contextFor(tasks, [4, 3, 2, 1], TEN_DAYS_ON_FOURTH) });
  assert.deepEqual(named.started, selector.map(t => t.id));
});
