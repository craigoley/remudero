// A DECIDED RESTART NAMES THE LANES IT WAITS ON. A freshness restart decided mid-dispatch runs only once every
// in-flight lane settles, and until then the daemon wrote nothing: on 2026-10-10 the core daemon decided a restart at
// 11:04:55Z, held every freed lane as "stale code", and then logged no freshness row for over an hour while W1-T5866's
// lane ran on — an operator read it as a restart that would never run. These drive the REAL runDaemon at laneCount 2;
// only the worker spawn, the freshness reading and the clock are faked.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { FRESHNESS_COALESCE_WINDOW_MS } from "../src/lib/deploy-judge.js";
import type { RunResult } from "../src/run-task.js";

const POLL_MS = 60_000;

function twoDisjointPlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-restart-wait-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B"));
  return loadPlan(f);
}

const okResult = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as unknown as RunResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Line = { step: string; extra?: Record<string, unknown> };

const staleOwnCode = {
  stale: true as const,
  oldSha: "a".repeat(40),
  newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: x", files: ["src/lib/daemon.ts"] }],
};

function harness() {
  const steps: Line[] = [];
  const started: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  let stale = false;
  let nowMs = Date.now();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const run = runDaemon(
    twoDisjointPlan(),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne: (id: string): Promise<RunResult> => {
        started.push(id);
        if (started.includes("A") && started.includes("B")) bothStarted.resolve();
        return id === "A" || id === "B" ? release[id].promise : Promise.resolve(okResult(id));
      },
      now: () => new Date(nowMs),
      sleep: () => {
        const sleep = deferred<void>();
        sleeps.push(sleep);
        return sleep.promise;
      },
      checkFreshness: () => (stale ? staleOwnCode : { stale: false }),
    } as unknown as DaemonDeps,
    { max: 2, laneCount: 2, pollIntervalMs: POLL_MS },
  );
  const tick = async () => {
    await drainMicrotasks();
    sleeps.shift()?.resolve();
    await drainMicrotasks();
    await drainMicrotasks();
  };
  return {
    steps, release, bothStarted, run, tick,
    goStale: () => { stale = true; },
    advanceClock: (ms: number) => { nowMs += ms; },
    waits: () => steps.filter((l) => l.step === "daemon.freshness_restart_waiting"),
  };
}

async function decideRestartWithBothLanesInFlight() {
  const h = harness();
  await h.bothStarted.promise;
  h.goStale();
  await h.tick(); // the dispatch tick observes the advance and opens the quiet window
  h.advanceClock(FRESHNESS_COALESCE_WINDOW_MS.value);
  await h.tick(); // past the window: the dispatch tick decides to restart
  assert.ok(h.steps.some((l) => l.step === "daemon.freshness_decision" && l.extra?.action === "restart"),
    "control: the restart was decided while both lanes were in flight");
  return h;
}

async function settled(h: ReturnType<typeof harness>, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } finally {
    h.release.A.resolve(okResult("A"));
    h.release.B.resolve(okResult("B"));
    await Promise.race([h.run.catch(() => undefined), new Promise((r) => setTimeout(r, 2_000))]);
  }
}

test("a decided freshness restart names the in-flight lanes it is still waiting on", async () => {
  const h = await decideRestartWithBothLanesInFlight();
  await settled(h, async () => {
    h.advanceClock(POLL_MS);
    await h.tick();
    const first = h.waits()[0];
    assert.ok(first, "the next dispatch tick records why the decided restart has not run");
    assert.equal(first.extra?.waiting_on, "in_flight_lanes");
    assert.deepEqual((first.extra?.lanes as Array<{ task: string }>).map((l) => l.task).sort(), ["A", "B"]);
    assert.equal(first.extra?.new_sha, staleOwnCode.newSha);
    assert.equal(first.extra?.waited_ms, POLL_MS);

    h.release.B.resolve(okResult("B")); // B frees its lane: the refill is held, A still runs
    await drainMicrotasks();
    h.advanceClock(2 * POLL_MS);
    await h.tick();
    const latest = h.waits().at(-1);
    assert.equal(h.waits().length, 2, "a second row once the wait has doubled");
    assert.deepEqual((latest?.extra?.lanes as Array<{ task: string }>).map((l) => l.task), ["A"],
      "the row names only the lane still holding the restart");

    h.release.A.resolve(okResult("A"));
    assert.equal((await h.run).stopReason, "stale", "the restart runs once the last lane settles");
  });
});

test("a decided restart's wait rows back off, one per doubling of the wait", async () => {
  const h = await decideRestartWithBothLanesInFlight();
  await settled(h, async () => {
    for (let i = 0; i < 8; i++) {
      h.advanceClock(POLL_MS);
      await h.tick();
    }
    // Waits of 1..8 polls report at 1, 2, 4 and 8 polls — four rows over eight ticks, never one a poll.
    assert.deepEqual(h.waits().map((l) => l.extra?.waited_ms), [1, 2, 4, 8].map((n) => n * POLL_MS));
  });
});
