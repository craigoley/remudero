// W1-T13695: an idle dispatch slot re-reads the lane target while its siblings run. On 2026-11-18 a pass that read a lane
// target of 1 at its start ran one lane for two hours while later memory readings fitted three: a lane the pool never
// started was never offered again. These drive the real runDaemon with the real lane governor in enforce mode. Only the
// worker spawn (which writes its own dispatch.claim row, as run-task does), the memory reading and the clock are faked.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";

import {
  DISPATCH_PHASE_REFILL_BOUND_MS, runDaemon, runLanePool, type DaemonDeps, type LanePoolControl, type WorkerAdmissionHold,
} from "#src/lib/daemon.js";
import type { LaneGovernorPorts, LaneMemoryReading } from "#src/lib/lane-governor.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";

type Line = { step: string; extra?: Record<string, unknown> };
type Verdict = "merged" | "blocked_transient";

const POLL_MS = 1000;
const PER_LANE_MIB = 1400;
const HOST_RESERVE_MIB = 2048;

/** A reading whose host arm (lane-governor.ts: inFlight + floor((base - reserve) / perLane)) is exactly `fits`. */
function reading(fits: number, running: number): LaneMemoryReading {
  return {
    containerBaseMib: null, containerOnsetMib: null, containerArmCounts: false, containerBasis: "unbounded",
    hostBaseAvailableMib: HOST_RESERVE_MIB + PER_LANE_MIB * (fits - running) + PER_LANE_MIB / 2,
    hostReserveMib: HOST_RESERVE_MIB, perLaneMib: PER_LANE_MIB, containerPressed: false, highEvents: 10,
  };
}

function plan(tasks: Array<{ id: string; file: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-grow-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, tasks.map(({ id, file }) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [${file}]\n`).join(""));
  return loadPlan(f);
}

const result = (id: string, verdict: Verdict): RunResult =>
  ({ taskId: id, merged: verdict === "merged", verdict, costUsd: 0, prUrl: `https://x/${id}` }) as unknown as RunResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await drainMicrotasks(); };

type State = {
  fits: number; pause?: string; stop?: string; restart: boolean; cost: boolean; open: number;
  hold?: WorkerAdmissionHold; holdThrows: boolean;
};

type HarnessOpts = {
  tasks?: Array<{ id: string; file: string }>;
  fits?: number;
  freshness?: boolean;
  opts?: Record<string, unknown>;
  /** Tasks that settle as soon as they start, with this verdict. */
  instant?: Record<string, Verdict>;
  /** Boot ledger lines: a run.start/verdict pair gives the pass a measured refill bound. */
  history?: string[];
};

async function harness(o: HarnessOpts = {}) {
  const tasks = o.tasks ?? ["A", "B", "C", "D"].map((id) => ({ id, file: `src/${id}.ts` }));
  const steps: Line[] = [];
  const started: string[] = [];
  const running = new Set<string>();
  const gates = new Map<string, ReturnType<typeof deferred<RunResult>>>();
  const merged = new Set<string>();
  const clock = { ms: Date.parse("2026-11-18T13:06:12Z") };
  const state: State = { fits: o.fits ?? 1, restart: false, cost: false, open: 0, holdThrows: false };
  const sleepers: Array<(advanceMs?: number) => void> = [];
  const firstStarted = deferred<void>();
  const log = (step: string, extra?: Record<string, unknown>) => { steps.push({ step, extra }); };
  const runOne = (id: string): Promise<RunResult> => {
    started.push(id);
    running.add(id);
    log("dispatch.claim", { task: id, outcome: "created", while_running: [...running].filter((r) => r !== id) });
    firstStarted.resolve();
    const gate = deferred<RunResult>();
    gates.set(id, gate);
    const instant = o.instant?.[id];
    if (instant) release(id, instant);
    return gate.promise.then((r) => { if (r.merged) merged.add(id); return r; });
  };
  const release = (id: string, verdict: Verdict = "merged"): void => {
    if (!running.delete(id)) return;
    log("test.finished", { task: id });
    gates.get(id)!.resolve(result(id, verdict));
  };
  const laneGovernor: LaneGovernorPorts = { mode: () => "enforce", read: () => reading(state.fits, running.size), cpuCount: () => 8 };
  const run = runDaemon(
    plan(tasks),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      refreshMergedAsync: async () => (id: string) => merged.has(id),
      log,
      runOne,
      // The in-flight ticker's wait: each poll the test lets pass moves the clock one interval (or as told).
      sleep: (ms: number) => new Promise<void>((resolve) => sleepers.push((advanceMs = ms) => { clock.ms += advanceMs; resolve(); })),
      now: () => new Date(clock.ms),
      ...(o.freshness === false ? {} : { checkFreshness: () => ({ stale: false }) }),
      checkPause: () => state.pause,
      checkStop: () => state.stop,
      consumeRestartRequest: () => {
        if (!state.restart) return null;
        state.restart = false;
        return { origin: "test", requestedAt: new Date(clock.ms).toISOString(), codeSha: "feedface" };
      },
      checkCostGovernor: () => (state.cost ? { deferred: true, observedDayCostUsd: 9, ceilingUsd: 1 } : undefined),
      workerAdmissionHold: () => {
        if (state.holdThrows) throw new Error("hold reader failed");
        return state.hold;
      },
      openPrCount: () => state.open,
      laneGovernor,
      ...(o.history ? { readLedgerLines: () => o.history! } : {}),
    } as unknown as DaemonDeps,
    { laneCount: 3, pollIntervalMs: POLL_MS, ...o.opts },
  );
  const poll = async (advanceMs?: number): Promise<void> => {
    for (const wake of sleepers.splice(0)) wake(advanceMs);
    await settle();
  };
  await firstStarted.promise;
  await settle();
  /** Lifts every hold, stops the daemon and lets every lane settle. */
  const end = async () => {
    Object.assign(state, { pause: undefined, cost: false, hold: undefined, holdThrows: false, open: 0, stop: "test over" });
    for (const id of [...running]) release(id);
    for (let i = 0; i < 40 && sleepers.length > 0; i++) { await poll(); for (const id of [...running]) release(id); }
    return run;
  };
  return { steps, started, running, state, poll, release, end };
}

const rows = (steps: Line[], step: string) => steps.filter((l) => l.step === step).map((l) => l.extra!);
const targets = (steps: Line[]) => rows(steps, "dispatch.lane_target").map((r) => [r.target, r.in_flight]);
const growHolds = (steps: Line[]) => rows(steps, "dispatch.lane_refill_held").filter((r) => r.finished_task === null);

test("W1-T13695 criterion 1: a pass started at target 1 starts a second task on a never-started lane once a later reading fits three", async () => {
  const h = await harness({ fits: 1 });
  assert.deepEqual(h.started, ["A"], "the pass starts one lane at a target of 1");
  assert.deepEqual(targets(h.steps), [[1, 0]]);
  h.state.fits = 3;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B"], "B starts on a never-started lane while A still runs");
  assert.ok(h.running.has("A"), "A is still in flight");
  const claimB = rows(h.steps, "dispatch.claim").find((r) => r.task === "B");
  assert.deepEqual(claimB?.while_running, ["A"], "B's dispatch.claim row is written while A is in flight");
  assert.equal(rows(h.steps, "test.finished").length, 0, "nothing finished before B's claim");
  assert.deepEqual(rows(h.steps, "dispatch.lane_grow"), [{ lane: 1, target: 2, in_flight: 1, task: "B" }]);
  await h.end();
});

test("W1-T13695 criterion 1: a reading that reads low at one interval holds only that interval's grow", async () => {
  const h = await harness({ fits: 1 });
  await h.poll();
  assert.deepEqual(h.started, ["A"], "a reading of 1 with 1 lane busy grows nothing");
  h.state.fits = 2;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B"], "the next interval's reading of 2 starts B at once");
  assert.deepEqual(targets(h.steps), [[1, 0], [1, 1], [2, 1]]);
  await h.end();
});

test("W1-T13695 criterion 2: each in-flight ticker interval reads the target once and writes its lane_target row", async () => {
  // No freshness reader, restart or reload: under enforce the dispatch hook is installed for the grow alone.
  const h = await harness({ fits: 1, freshness: false });
  for (let i = 0; i < 3; i++) await h.poll();
  assert.deepEqual(targets(h.steps), [[1, 0], [1, 1], [1, 1], [1, 1]], "one row at dispatch, then one per interval");
  assert.deepEqual(h.started, ["A"]);
  assert.equal(growHolds(h.steps).length, 0, "a target the lanes in flight already fill decides nothing");
  h.state.fits = 3;
  await h.poll();
  await h.poll();
  assert.deepEqual(targets(h.steps).slice(-2), [[2, 1], [3, 2]], "each row reads that moment's in-flight count");
  await h.end();
});

test("W1-T13695 criterion 3: a grow is held to the reading's target and to laneCount", async () => {
  const h = await harness({ fits: 1 });
  h.state.fits = 3;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B"], "the growth bound holds a host arm of 3 to 2: one lane at this tick");
  assert.deepEqual(rows(h.steps, "dispatch.lane_target").at(-1)!.binding, "growth");
  await h.poll();
  assert.deepEqual(h.started, ["A", "B", "C"], "the next tick's reading of 3 starts the third lane");
  assert.deepEqual(rows(h.steps, "dispatch.lane_grow"), [
    { lane: 1, target: 2, in_flight: 1, task: "B" },
    { lane: 2, target: 3, in_flight: 2, task: "C" },
  ]);
  h.state.fits = 6;
  await h.poll();
  assert.deepEqual(targets(h.steps).at(-1), [3, 3], "the reading is held to laneCount, so a later shed bites at once");
  assert.deepEqual(h.started, ["A", "B", "C"], "no lane past laneCount starts");
  await h.end();
});

type HoldCase = {
  name: string;
  reason: RegExp;
  setup?: HarnessOpts;
  hold: (h: Awaited<ReturnType<typeof harness>>) => void | Promise<void>;
  advanceMs?: number;
  /** The never-started lane the grow offers: the first wave's length. */
  lane?: number;
};

const holdCases: HoldCase[] = [
  { name: "a pause", reason: /^pause: operator hold$/, hold: (h) => { h.state.pause = "operator hold"; } },
  { name: "a stop", reason: /^stop: stopping$/, hold: (h) => { h.state.stop = "stopping"; } },
  { name: "a decided restart", reason: /^stale code/, hold: (h) => { h.state.restart = true; } },
  { name: "the phase bound", reason: /^phase bound$/, hold: () => {}, advanceMs: DISPATCH_PHASE_REFILL_BOUND_MS + 1 },
  { name: "max reached", reason: /^max reached$/, setup: { opts: { max: 1 } }, hold: () => {} },
  { name: "the WIP budget", reason: /^no disjoint runnable task within the lane budget$/, setup: { opts: { wipLimit: 3 } },
    hold: (h) => { h.state.open = 3; } },
  { name: "file overlap with a running task", reason: /^no disjoint runnable task within the lane budget$/,
    setup: { tasks: [{ id: "A", file: "src/A.ts" }, { id: "B", file: "src/A.ts" }] }, hold: () => {} },
  {
    // B and then C (refilled onto B's lane) end blocked_transient: two different tasks open the API window.
    name: "an API window", reason: /^blocked_transient$/,
    setup: { fits: 2, instant: { B: "blocked_transient", C: "blocked_transient" } }, hold: () => {}, advanceMs: POLL_MS / 2, lane: 2,
  },
  { name: "a governor hold", reason: /^governor: cost$/, hold: (h) => { h.state.cost = true; } },
  { name: "a fleet review-yield hold", reason: /^fleet REVIEW hold: a review goes first$/,
    hold: (h) => { h.state.hold = { control: "REVIEW", detail: "a review goes first" }; } },
];

for (const c of holdCases) {
  test(`W1-T13695 criterion 5: a never-started lane is refused under ${c.name} exactly as a refill is`, async () => {
    const h = await harness({ fits: 1, ...c.setup });
    const before = [...h.started];
    h.state.fits = 3;
    await c.hold(h);
    const polledAt = h.steps.length;
    await h.poll(c.advanceMs);
    assert.deepEqual(h.started, before, "the grow starts nothing");
    assert.equal(rows(h.steps, "dispatch.lane_grow").length, 0);
    const held = growHolds(h.steps);
    assert.equal(held.length, 1, `one refill hold row: ${JSON.stringify(rows(h.steps, "dispatch.lane_refill_held"))}`);
    assert.match(String(held[0]!.reason), c.reason);
    assert.equal(held[0]!.lane, c.lane ?? 1, "the row names the never-started lane");
    if (c.name === "file overlap with a running task") {
      assert.deepEqual(rows(h.steps.slice(polledAt), "dispatch.serialized").map((r) => r.task), ["B"], "the refill path's own serialized row");
    }
    await h.end();
  });
}

test("W1-T13695 criterion 5: a hold that lasts writes one row, and the lane grows once it lifts", async () => {
  const h = await harness({ fits: 1 });
  h.state.fits = 3;
  h.state.pause = "operator hold";
  for (let i = 0; i < 3; i++) await h.poll();
  assert.equal(growHolds(h.steps).length, 1, "one row per lane and reason, not one per interval");
  assert.deepEqual(h.started, ["A"]);
  assert.deepEqual(targets(h.steps).at(-1), [3, 1], "the readings went on rising through the pause");
  h.state.pause = undefined;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B", "C"], "the lifted pause lets the next interval grow to that interval's target");
  assert.deepEqual(rows(h.steps, "dispatch.lane_grow").map((r) => [r.lane, r.target]), [[1, 3], [2, 3]]);
  await h.end();
});

test("W1-T13695 criterion 5: under a measured phase bound a never-started lane is held while a freed lane parks", async () => {
  // One prior run of 10 minutes: the pass's refill bound is measured, so the phase bound holds once the pass is older
  // than 10 minutes while every lane in flight is younger than that.
  const minute = 60_000;
  const history = [
    JSON.stringify({ step: "run.start", run_id: "r0", task_id: "Z", ts: "2026-11-18T12:00:00.000Z" }),
    JSON.stringify({ step: "verdict", run_id: "r0", ts: "2026-11-18T12:10:00.000Z" }),
  ];
  const h = await harness({ fits: 2, history, tasks: ["A", "B", "C", "D", "E"].map((id) => ({ id, file: `src/${id}.ts` })) });
  assert.deepEqual(rows(h.steps, "dispatch.refill_bound").map((r) => [r.bound_ms, r.source]), [[10 * minute, "observed_runs"]]);
  assert.deepEqual(h.started, ["A", "B"], "the pass starts two lanes at a target of 2");
  await h.poll(6 * minute);
  h.release("A");
  await h.poll(3 * minute);
  h.release("B");
  await h.poll(POLL_MS);
  assert.deepEqual(h.started, ["A", "B", "C", "D"], "both first-wave lanes refilled before the bound");
  h.state.fits = 3;
  await h.poll(2 * minute);
  assert.deepEqual(h.started, ["A", "B", "C", "D"], "the grow starts nothing under the phase bound");
  const held = growHolds(h.steps);
  assert.equal(held.length, 1, `one refill hold row: ${JSON.stringify(rows(h.steps, "dispatch.lane_refill_held"))}`);
  assert.equal(held[0]!.lane, 2, "the row names the never-started lane");
  assert.equal(held[0]!.reason, "phase bound");
  assert.equal(held[0]!.refill_bound_ms, 10 * minute, "the hold names the measured bound");
  assert.ok(Number(held[0]!.phase_age_ms) > 10 * minute, "the pass is older than the measured bound");
  assert.equal(rows(h.steps, "dispatch.lane_parked").length, 0, "a grow is never parked");
  h.release("C");
  await h.poll(POLL_MS);
  assert.deepEqual(h.started, ["A", "B", "C", "D"], "the freed lane starts nothing under the phase bound");
  assert.deepEqual(rows(h.steps, "dispatch.lane_parked").map((r) => [r.lane, r.finished_task, r.reason, r.waiting_on]),
    [[0, "C", "phase bound", ["D"]]], "the freed lane parks on the refill path's own row");
  assert.equal(growHolds(h.steps).length, 1, "the held grow writes no second row for the same reason");
  await h.end();
});

test("W1-T13695: a grow decision that throws closes the pass's starts and ends it as an error", async () => {
  const h = await harness({ fits: 1 });
  h.state.fits = 3;
  h.state.holdThrows = true;
  const polledAt = h.steps.length;
  await h.poll();
  assert.deepEqual(h.started, ["A"]);
  const after = h.steps.slice(polledAt).map((l) => `${l.step} ${JSON.stringify(l.extra ?? {}).slice(0, 160)}`);
  assert.ok(after.some((l) => l.startsWith("dispatch.lane_target")), `the tick read the target: ${after.join(" | ")}`);
  h.state.holdThrows = false;
  const summary = await h.end();
  assert.equal(summary.stopReason, "error");
  assert.match(String(summary.stopDetail), /dispatch\.lane_grow: hold reader failed/);
});

// The pool's own offer, without the daemon: what it accepts, and that a refused or failed offer starts nothing.
test("W1-T13695: the lane pool offers only a lane it never started, and only while it runs", async () => {
  const a = deferred<string>();
  const control: LanePoolControl<string, { id: string }> = {};
  const started: string[] = [];
  const pool = runLanePool([{ id: "A" }], (id) => { started.push(id); return id === "A" ? a.promise : Promise.resolve(id); },
    () => undefined, undefined, () => true, undefined, control);
  assert.deepEqual(control.unstarted!(3), [1, 2]);
  assert.equal(control.offer!(0, async () => ({ id: "X" })), false, "a lane of the first wave is never offered");
  const empty = deferred<{ id: string } | undefined>();
  let emptyStarted: boolean | undefined;
  assert.equal(control.offer!(1, () => empty.promise, (s) => { emptyStarted = s; }), true);
  assert.deepEqual(control.unstarted!(3), [2], "a lane being decided is not offered twice");
  empty.resolve(undefined);
  await settle();
  assert.equal(emptyStarted, false);
  assert.deepEqual(control.unstarted!(3), [1, 2], "a refused offer frees its lane");
  let bStarted: boolean | undefined;
  control.offer!(1, async () => ({ id: "B" }), (s) => { bStarted = s; });
  await settle();
  assert.equal(bStarted, true);
  assert.deepEqual(started, ["A", "B"]);
  assert.deepEqual(control.unstarted!(3), [2]);
  a.resolve("A");
  const outcome = await pool;
  assert.deepEqual(outcome.settled.map((s) => s.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(control.unstarted!(3), [], "a settled pool offers nothing");
  assert.equal(control.offer!(2, async () => ({ id: "C" })), false);
});

test("W1-T13695: a rejected offer closes the pool's starts as an external fault", async () => {
  const a = deferred<string>();
  const control: LanePoolControl<string, { id: string }> = {};
  const pool = runLanePool([{ id: "A" }], () => a.promise, () => undefined, undefined, () => true, undefined, control);
  let after: boolean | undefined;
  control.offer!(1, () => Promise.reject(new Error("decision failed")), (s) => { after = s; });
  await settle();
  assert.equal(after, false);
  assert.deepEqual(control.unstarted!(3), [], "a closed pool offers nothing");
  a.resolve("A");
  const outcome = await pool;
  assert.equal(outcome.externalFault?.phase, "lane-grow");
});
