import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const result = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as RunResult;

test("a dispatch phase refills through the bound, drains admitted lanes, then refreshes at the next tick", async () => {
  const minute = 60_000;
  const bound = 20 * minute;
  const dir = mkdtempSync(join(tmpdir(), "rmd-phase-bound-"));
  const path = join(dir, "tasks.yaml");
  const ids = "ABCDEFGHIJKLM".split("");
  writeFileSync(path, ids.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  const releases = new Map(ids.map((id) => [id, deferred<RunResult>()]));
  const started: Array<{ id: string; tick: number; generation: number }> = [];
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  let nowMs = Date.UTC(2026, 9, 5);
  let tick = 0;
  let generation = 0;
  let cleaningUp = false;
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    refreshMergedAsync: async () => {
      generation++;
      // Top-of-tick work is older than the bound before the FIRST phase even starts.
      if (generation === 1) nowMs += 25 * minute;
      return (id: string) => merged.has(id);
    },
    refreshMerged: () => (id: string) => merged.has(id),
    checkStop: () => cleaningUp ? "test cleanup" : undefined,
    log: (step, extra) => {
      steps.push({ step, extra });
      if (step === "daemon.tick") tick++;
    },
    runOne: async (id) => {
      started.push({ id, tick, generation });
      return cleaningUp ? result(id) : releases.get(id)!.promise;
    },
    sleep: async () => {},
  } as DaemonDeps, { laneCount: 3, max: 11 });
  const settle = async (id: string, advanceMs: number) => {
    nowMs += advanceMs;
    merged.add(id);
    releases.get(id)!.resolve(result(id));
    await drainMicrotasks();
  };
  try {
    await drainMicrotasks();
    assert.deepEqual(started.map(({ id }) => id), ["A", "B", "C"]);
    for (const id of ["B", "D", "E", "F"]) await settle(id, 5 * minute);
    assert.deepEqual(started.map(({ id }) => id), ["A", "B", "C", "D", "E", "F", "G"],
      "refill remains open below and exactly at the 20-minute phase bound");
    await settle("G", 1);
    assert.deepEqual(started.map(({ id }) => id), ["A", "B", "C", "D", "E", "F", "G"],
      "a runnable H must not start once the phase is older than the bound");
    const held = steps.filter(({ step }) => step === "dispatch.lane_refill_held");
    assert.deepEqual(held.map(({ extra }) => extra), [{
      lane: 1, finished_task: "G", reason: "phase bound", phase_age_ms: bound + 1,
    }]);
    assert.equal(tick, 1);
    assert.equal(generation, 1);
    assert.equal(steps.some(({ step }) => step === "dispatch.settled_set"), false,
      "the bound must leave A and C running");
    await settle("C", minute);
    assert.equal(started.length, 7, "another freed lane is held while A still runs");
    assert.equal(steps.at(-1)?.step, "dispatch.lane_refill_held");
    assert.equal(steps.at(-1)?.extra?.reason, "phase bound");
    assert.equal(steps.at(-1)?.extra?.phase_age_ms, bound + minute + 1);
    assert.equal(tick, 1, "the next tick waits for the last admitted lane");
    await settle("A", 4 * minute);
    assert.deepEqual(started.slice(7), ["H", "I", "J"].map((id) => ({ id, tick: 2, generation: 2 })),
      "the next phase admits only after the next top-of-tick refresh");
    const settled = steps.find(({ step }) => step === "dispatch.settled_set");
    assert.equal(settled?.extra?.dispatched, 7);
    assert.deepEqual((settled?.extra?.tasks as Array<{ id: string }>).map(({ id }) => id),
      ["A", "B", "C", "D", "E", "F", "G"]);
    await settle("I", 5 * minute);
    assert.deepEqual(started.at(-1), { id: "K", tick: 2, generation: 2 },
      "the refill age resets for the next phase");
    await settle("K", minute);
    await settle("J", minute);
    await settle("H", minute);
    assert.equal((await run).stopReason, "max_reached");
  } finally {
    cleaningUp = true;
    for (const [id, release] of releases) release.resolve(result(id));
    await run;
  }
});
