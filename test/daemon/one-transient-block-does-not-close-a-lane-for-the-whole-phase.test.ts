// W1-T13283: one blocked_transient run closed its lane for the rest of the dispatch phase. On 2026-11-16 W1-T13224
// ended blocked_transient at 21:18:52Z; its lane wrote `dispatch.lane_refill_held {"reason":"blocked_transient"}` and
// started nothing for 150.7 minutes while two siblings ran and dozens of tasks were queued. A refill whose open-PR
// board read failed ended its lane the same way. These drive the real runDaemon lane pool through its injected seams:
// only the worker spawn (`runOne`), the board read (`openPrCount`), the poll sleep and the clock are faked.

import assert from "node:assert/strict";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";

type Fields = Record<string, unknown>;

const BOARD_UNREADABLE = "open PR board count is unreadable";

const ok = (id: string): RunResult =>
  ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }) as unknown as RunResult;
const transient = (id: string): RunResult =>
  ({ taskId: id, runId: `${id}-run`, merged: false, costUsd: 0, verdict: "blocked_transient" }) as unknown as RunResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Independent tasks, `files:`-disjoint so any of them may share a phase. Equal priority dispatches them in id order. */
function planOf(ids: string[]) {
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  return loadPlanFromYaml(ids.map(task).join(""), "fixture");
}

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await drainMicrotasks(); };

/**
 * Every run stays open until the test ends it by name. The clock moves only when the test moves it, and a poll
 * releases whatever the daemon is sleeping on (the dispatch ticker's wait, or a hold between phases).
 */
function harness(
  t: TestContext, ids: string[], opts: { laneCount: number; max: number; maxApiWindowHoldMs?: number }, extra: Fields = {},
) {
  const rows: Array<{ step: string; extra: Fields }> = [];
  const started: string[] = [];
  const merged = new Set<string>();
  const gates = new Map<string, ReturnType<typeof deferred<RunResult>>>();
  const gate = (id: string) => gates.get(id) ?? gates.set(id, deferred<RunResult>()).get(id)!;
  const clock = { ms: Date.parse("2026-11-16T21:18:52Z") };
  const sleepers: Array<() => void> = [];
  const hooks: { onRow?: (step: string) => void; stop?: string } = {};
  let cleaningUp = false;
  let ended = false;
  const run = runDaemon(
    planOf(ids),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      log: (step: string, fields: Fields = {}) => { rows.push({ step, extra: fields }); hooks.onRow?.(step); },
      runOne: (id: string) => { started.push(id); return cleaningUp ? Promise.resolve(ok(id)) : gate(id).promise; },
      sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
      now: () => new Date(clock.ms),
      // A freshness reader gives the phase its dispatch tick, the wake a parked lane is decided again on.
      checkFreshness: () => ({ stale: false }),
      checkStop: () => hooks.stop,
      ...extra,
    } as unknown as DaemonDeps,
    { pollIntervalMs: 1000, ...opts },
  );
  const poll = async (): Promise<void> => {
    for (const wake of sleepers.splice(0)) wake();
    await settle();
  };
  void run.then(() => { ended = true; }, () => { ended = true; });
  // The dispatch ticker is one per process: a daemon a failed assertion left running would take the next test's
  // ticks. So every test ends its daemon, pass or fail.
  t.after(async () => {
    cleaningUp = true;
    hooks.stop = "test cleanup";
    for (const [id, open] of gates) open.resolve(ok(id));
    for (let i = 0; i < 40 && !ended; i++) await poll();
  });
  return {
    rows, started, clock, hooks, poll,
    of: (step: string): Fields[] => rows.filter((r) => r.step === step).map((r) => r.extra),
    /** Park rows without the phase age, which no criterion here is about. */
    parked: (): Fields[] => rows.filter((r) => r.step === "dispatch.lane_parked")
      .map(({ extra: { phase_age_ms: _age, ...row } }) => row),
    firstWave: async (count: number): Promise<void> => {
      for (let i = 0; i < 200 && started.length < count; i++) await drainMicrotasks();
      assert.equal(started.length, count, `the first wave started ${count} lanes`);
    },
    finish: async (result: RunResult): Promise<void> => {
      if (result.merged) merged.add(result.taskId);
      gate(result.taskId).resolve(result);
      await settle();
    },
    ends: async () => {
      let summary: Awaited<typeof run> | undefined;
      void run.then((s) => { summary = s; });
      for (let i = 0; i < 40 && summary === undefined; i++) await poll();
      assert.ok(summary, "the daemon run ended");
      return summary;
    },
  };
}

const phases = (h: ReturnType<typeof harness>): string[][] =>
  (h.of("dispatch.settled_set") as Array<{ tasks: Array<{ id: string }> }>).map((p) => p.tasks.map((t) => t.id));

test("W1-T13283 criterion 1: a lane whose run ended blocked_transient refills from a pool without that task, in the same phase", async (t) => {
  // A is first in dispatch order, so only its exclusion for the phase can make the refill choose C.
  const h = harness(t, ["A", "B", "C"], { laneCount: 2, max: 3 });
  await h.firstWave(2);
  await h.finish(transient("A"));
  // Observed BEFORE B is released: the 2026-11-16 lane waited on its slowest sibling instead.
  assert.deepEqual(h.started, ["A", "B", "C"], "C started on A's lane while B still ran, and A was not offered again");
  assert.deepEqual(h.of("dispatch.lane_refilled"), [{ lane: 0, finished_task: "A", next_task: "C" }]);
  assert.deepEqual(h.of("dispatch.lane_refill_held"), [], "one blocked_transient run holds no lane");
  assert.deepEqual(h.parked(), [], "one task is below the API-window floor, so nothing parks either");
  await h.finish(ok("C"));
  await h.finish(ok("B"));
  const summary = await h.ends();
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(phases(h), [["A", "B", "C"]], "all three ran in one phase");
  assert.deepEqual(h.of("dispatch.lane_refill_held").map((r) => r.reason), ["max reached"]);
  assert.equal(h.of("daemon.api_window_hold").length, 0, "one task alone never reads as a closed API window");
});

test("W1-T13283 criterion 2: a refill whose open-PR board read fails parks the lane and asks again on the next tick", async (t) => {
  const board = { down: false, reads: 0 };
  const h = harness(t, ["A", "B", "C"], { laneCount: 2, max: 3 }, {
    openPrCount: () => {
      board.reads++;
      if (board.down) throw new Error(BOARD_UNREADABLE);
      return 0;
    },
  });
  await h.firstWave(2);
  board.down = true;
  await h.finish(ok("B"));
  assert.deepEqual(h.started, ["A", "B"], "an unreadable board starts nothing");
  assert.deepEqual(h.parked(), [{ lane: 1, finished_task: "B", reason: `refill read failed: ${BOARD_UNREADABLE}`, waiting_on: ["A"] }],
    "the park row names the read that failed and the sibling the lane waits beside");
  assert.deepEqual(h.of("dispatch.lane_refill_held"), [], "the lane is not ended for the rest of the phase");

  const readsWhileParked = board.reads;
  await h.poll();
  assert.ok(board.reads > readsWhileParked, "the next tick asked the board again");
  assert.deepEqual(h.started, ["A", "B"], "the board is still unreadable, so the lane stays parked");
  assert.equal(h.parked().length, 1, "one park row per lane and reason, not one per tick");

  board.down = false;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B", "C"], "the first readable tick refilled B's lane while A still ran");
  assert.deepEqual(h.of("dispatch.lane_refilled"), [{ lane: 1, finished_task: "B", next_task: "C" }]);
  await h.finish(ok("C"));
  await h.finish(ok("A"));
  const summary = await h.ends();
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(phases(h), [["A", "B", "C"]]);
  assert.deepEqual(h.of("dispatch.lane_refill_held").map((r) => r.reason), ["max reached"], "no hold row ever named the board read");
});

test("W1-T13283 criterion 3: blocked_transient runs on two different tasks close refill for the API-window guard's bounded hold", async (t) => {
  // A hold ceiling under the poll interval, so the bound is the guard's ceiling and not the streak's own doubling.
  // A runs to the end; B and C block; D and E are the next two candidates.
  const h = harness(t, ["A", "B", "C", "D", "E"], { laneCount: 3, max: 9, maxApiWindowHoldMs: 400 });
  const t0 = h.clock.ms;
  await h.firstWave(3);
  await h.finish(transient("B"));
  assert.deepEqual(h.started, ["A", "B", "C", "D"], "the first blocked task is below the floor: its lane refills");

  await h.finish(transient("C"));
  assert.deepEqual(h.started, ["A", "B", "C", "D"], "a second different task reaches the floor: refill closes");
  assert.deepEqual(h.parked(), [{
    lane: 2, finished_task: "C", reason: "blocked_transient", resumes_at_ms: t0 + 400, consecutive_different_tasks: 2,
    waiting_on: ["A", "D"],
  }], "the lane parks for min(pollIntervalMs, maxApiWindowHoldMs), and the row names when it is asked again");
  assert.deepEqual(h.of("dispatch.lane_refill_held"), []);

  h.clock.ms = t0 + 399;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B", "C", "D"], "a tick inside the hold starts nothing");
  assert.equal(h.parked().length, 1, "and writes no second park row");

  h.clock.ms = t0 + 400;
  await h.poll();
  assert.deepEqual(h.started, ["A", "B", "C", "D", "E"], "the first tick past the bound refills the parked lane");
  assert.deepEqual(h.of("dispatch.lane_refilled").at(-1), { lane: 2, finished_task: "C", next_task: "E" });

  // The window stays closed to the end: each further blocked task parks its lane, and the last one, with no sibling
  // left to wake it, is held under the reason origin/main wrote.
  await h.finish(transient("D"));
  await h.finish(transient("E"));
  assert.deepEqual(h.parked().slice(1).map((r) => [r.lane, r.finished_task, r.consecutive_different_tasks, r.resumes_at_ms]),
    [[1, "D", 3, t0 + 800], [2, "E", 4, t0 + 800]], "the hold stays at the ceiling however long the streak grows");
  await h.finish(transient("A"));
  assert.deepEqual(h.of("dispatch.lane_refill_held").map((r) => [r.finished_task, r.reason]).sort(),
    [["A", "blocked_transient"], ["D", "blocked_transient"], ["E", "blocked_transient"]]);

  // The guard between phases is the one origin/main had: one row, the same streak, the same ceiling.
  assert.deepEqual(h.of("daemon.api_window_hold").map((r) => [r.hold_ms, r.consecutive_different_tasks]), [[400, 5]]);
  h.hooks.stop = "the test is done";
  assert.equal((await h.ends()).stopReason, "stopped");
  assert.deepEqual(phases(h), [["A", "B", "C", "D", "E"]]);
});

test("W1-T13283: a real verdict between two blocked_transient runs resets the streak, so the second parks nothing", async (t) => {
  const h = harness(t, ["A", "B", "C", "D", "E", "F"], { laneCount: 3, max: 6 });
  await h.firstWave(3);
  await h.finish(transient("B"));
  await h.finish(ok("D"));
  await h.finish(transient("C"));
  assert.deepEqual(h.started, ["A", "B", "C", "D", "E", "F"], "each freed lane refilled while A still ran");
  assert.deepEqual(h.parked(), []);
  for (const id of ["E", "F", "A"]) await h.finish(ok(id));
  assert.equal((await h.ends()).stopReason, "max_reached");
  assert.equal(h.of("daemon.api_window_hold").length, 0);
});

test("W1-T13283: a lane parked on a failed board read is asked again when a sibling lane finishes", async (t) => {
  const board = { down: false };
  const h = harness(t, ["A", "B", "C", "D", "E"], { laneCount: 3, max: 5 }, {
    openPrCount: () => {
      if (board.down) throw new Error(BOARD_UNREADABLE);
      return 0;
    },
  });
  await h.firstWave(3);
  board.down = true;
  await h.finish(ok("B"));
  assert.deepEqual(h.parked().map((r) => [r.lane, r.reason]), [[1, `refill read failed: ${BOARD_UNREADABLE}`]]);
  board.down = false;
  // No tick passes: C's finish is the lane event that wakes B's parked lane.
  await h.finish(ok("C"));
  assert.deepEqual(h.started, ["A", "B", "C", "D", "E"], "C's lane took D and B's parked lane took E");
  assert.deepEqual(h.of("dispatch.lane_refilled"),
    [{ lane: 2, finished_task: "C", next_task: "D" }, { lane: 1, finished_task: "B", next_task: "E" }]);
  for (const id of ["D", "E", "A"]) await h.finish(ok(id));
  assert.equal((await h.ends()).stopReason, "max_reached");
});

test("W1-T13283: a failed board read with no sibling left to wake the lane still holds it, naming the read", async (t) => {
  const board = { down: false };
  const h = harness(t, ["A", "B", "C"], { laneCount: 2, max: 3 }, {
    openPrCount: () => {
      if (board.down) throw new Error(BOARD_UNREADABLE);
      return 0;
    },
  });
  // The phase's own rows are what this asserts: the board reads again once the phase has settled.
  h.hooks.onRow = (step) => { if (step === "dispatch.settled_set") board.down = false; };
  await h.firstWave(2);
  board.down = true;
  await h.finish(ok("B"));
  assert.equal(h.parked().length, 1);
  await h.finish(ok("A"));
  assert.deepEqual(h.of("dispatch.lane_refill_held").map((r) => [r.finished_task, r.reason]).sort(), [
    ["A", `refill read failed: ${BOARD_UNREADABLE}`], ["B", `refill read failed: ${BOARD_UNREADABLE}`],
  ], "with nothing in flight the phase ends, and the next tick reads the board itself");
  for (let i = 0; i < 40 && !h.started.includes("C"); i++) await h.poll();
  await h.finish(ok("C"));
  assert.equal((await h.ends()).stopReason, "max_reached");
  assert.deepEqual(phases(h), [["A", "B"], ["C"]], "the unreadable board started nothing more in its phase: C ran in the next");
});
