// W1-T12292: a lane held by its lane target is decided again on a later poll. On 2026-11-11 one reading of 1 ended
// a freed lane for good, and no build started for 70 minutes while the slow lane ran. These drive the real runDaemon
// with the real lane governor in enforce mode. Only the worker spawn, the memory reading and the clock are faked.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import type { LaneGovernorPorts, LaneMemoryReading } from "#src/lib/lane-governor.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";

type Line = { step: string; extra?: Record<string, unknown> };

function reading(pressed: boolean): LaneMemoryReading {
  return {
    containerBaseMib: 2000, containerOnsetMib: 8379, containerArmCounts: true, containerBasis: "memory.high",
    hostBaseAvailableMib: 20_000, hostReserveMib: 2048, perLaneMib: 1400, containerPressed: pressed, highEvents: 10,
  };
}

function plan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-target-park-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B") + task("C"));
  return loadPlan(f);
}

const ok = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as unknown as RunResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await drainMicrotasks(); };

/** A runs long and B short. B finishes under a pressed reading, so its lane meets a lane target of 1. */
async function parkedHarness() {
  const steps: Line[] = [];
  const started: string[] = [];
  const startedWhileARan: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  const clock = { ms: Date.parse("2026-11-11T10:36:11Z") };
  const merged = new Set<string>();
  const memory = { pressed: false };
  const sleepers: Array<() => void> = [];
  let aSettled = false;
  const runOne = (id: string): Promise<RunResult> => {
    started.push(id);
    if (!aSettled && id !== "A") startedWhileARan.push(id);
    if (started.includes("A") && started.includes("B")) bothStarted.resolve();
    const result = id === "A" || id === "B" ? release[id].promise : Promise.resolve(ok(id));
    return result.then((r) => { merged.add(id); return r; });
  };
  const laneGovernor: LaneGovernorPorts = { mode: () => "enforce", read: () => reading(memory.pressed), cpuCount: () => 2 };
  const run = runDaemon(
    plan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      // The in-flight ticker's wait: each poll the test lets pass moves the clock one interval.
      sleep: (ms: number) => new Promise<void>((resolve) => sleepers.push(() => { clock.ms += ms; resolve(); })),
      now: () => new Date(clock.ms),
      checkFreshness: () => ({ stale: false }),
      laneGovernor,
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2, pollIntervalMs: 1000 },
  );
  const poll = async (): Promise<void> => {
    for (const wake of sleepers.splice(0)) wake();
    await settle();
  };
  await bothStarted.promise;
  memory.pressed = true;
  clock.ms += 1000;
  release.B.resolve(ok("B"));
  await settle();
  const settleA = async () => {
    aSettled = true;
    release.A.resolve(ok("A"));
    for (let i = 0; i < 20 && sleepers.length > 0; i++) await poll();
    return run;
  };
  return { steps, started, startedWhileARan, memory, poll, settleA };
}

const rows = (steps: Line[], step: string) => steps.filter((l) => l.step === step).map((l) => l.extra!);

test("W1-T12292: a lane held by its lane target parks while a sibling runs", async () => {
  const h = await parkedHarness();
  assert.deepEqual(h.startedWhileARan, ["B"], "a target of 1 with 1 lane busy starts nothing at that moment");
  const parked = rows(h.steps, "dispatch.lane_parked");
  assert.equal(parked.length, 1);
  assert.deepEqual({ ...parked[0], phase_age_ms: undefined },
    { lane: 1, finished_task: "B", reason: "lane target", phase_age_ms: undefined, waiting_on: ["A"] });
  assert.equal(rows(h.steps, "dispatch.lane_refill_held").length, 0, "the lane is not ended for the rest of the phase");
  const targets = rows(h.steps, "dispatch.lane_target").map((r) => [r.target, r.in_flight]);
  assert.deepEqual(targets.at(-1), [1, 1]);
  h.memory.pressed = false;
  await h.settleA();
});

test("W1-T12292: a parked lane starts a task when a later poll raises the lane target", async () => {
  const h = await parkedHarness();
  h.memory.pressed = false;
  await h.poll();
  assert.deepEqual(h.startedWhileARan, ["B", "C"], "C started on B's lane while A still ran");
  assert.deepEqual(rows(h.steps, "dispatch.lane_target").map((r) => [r.target, r.in_flight]).slice(-2), [[1, 1], [2, 1]]);
  assert.deepEqual(rows(h.steps, "dispatch.lane_refilled"), [{ lane: 1, finished_task: "B", next_task: "C" }]);
  const summary = await h.settleA();
  assert.equal(summary.stopReason, "max_reached");
  const passes = rows(h.steps, "dispatch.settled_set") as Array<{ tasks: Array<{ id: string }> }>;
  assert.deepEqual(passes.map((p) => p.tasks.map((t) => t.id)), [["A", "B", "C"]]);
});

test("W1-T12292: a lane target that stays low starts nothing and writes one park row", async () => {
  const h = await parkedHarness();
  for (let i = 0; i < 3; i++) await h.poll();
  assert.deepEqual(h.startedWhileARan, ["B"], "no poll starts a task while the target reads 1 with 1 lane busy");
  assert.ok(rows(h.steps, "dispatch.lane_target").filter((r) => r.in_flight === 1).length >= 3, "each poll read the target again");
  assert.equal(rows(h.steps, "dispatch.lane_parked").length, 1, "one park row, not one per poll");
  assert.equal(rows(h.steps, "dispatch.lane_refill_held").length, 0);
  // When A ends no lane is in flight, so the parked lane wakes and the phase does not wait on it.
  const summary = await h.settleA();
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(h.started, ["A", "B", "C"]);
  const passes = rows(h.steps, "dispatch.settled_set") as Array<{ tasks: Array<{ id: string }> }>;
  assert.deepEqual(passes.map((p) => p.tasks.map((t) => t.id)), [["A", "B", "C"]]);
});

test("W1-T12292: the idle sample names the lane target hold", async () => {
  const h = await parkedHarness();
  const parkedAt = h.steps.findIndex((l) => l.step === "dispatch.lane_parked");
  const idle = h.steps.slice(parkedAt).filter((l) => l.step === "lane.idle_changed").map((l) => l.extra!);
  assert.equal(idle.length, 1);
  assert.equal(idle[0]!.cause, "governor");
  assert.deepEqual(idle[0]!.hold, { reason: "lane target" });
  assert.equal(idle[0]!.idle_slots, 1);
  h.memory.pressed = false;
  await h.settleA();
});
