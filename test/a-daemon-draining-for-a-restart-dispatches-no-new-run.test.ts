// W1-T6274 — A DAEMON DRAINING FOR A RESTART DISPATCHES NO NEW RUN. A freed lane's refill checked freshness, then
// awaited its merged-set and run-branch reads, and dispatched whatever those reads chose. A restart decided while a
// read was in flight never reached it: on 2026-10-07 the core daemon decided a freshness restart at 20:38:42Z and
// started W1-T6262 at 20:39:46Z, a 20-minute run that then had to yield. These drive the REAL runDaemon at
// laneCount 2; only the worker spawn, the freshness reading and the two awaited reads are faked.

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

function threeDisjointPlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t6274-drain-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B") + task("C"));
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

/** A and B are held open; the refill after B frees parks on whichever awaited read `gate` names. */
function harness(gate: "merged" | "run-branches") {
  const steps: Line[] = [];
  const started: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  const refillRead = deferred<void>();
  const refillReadStarted = deferred<void>();
  let stale = false;
  let bReleased = false;
  let nowMs = Date.now();
  let branchReads = 0;
  let mergedReads = 0;
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const runOne = (id: string): Promise<RunResult> => {
    started.push(id);
    if (started.includes("A") && started.includes("B")) bothStarted.resolve();
    if (id === "A" || id === "B") return release[id].promise;
    return Promise.resolve(okResult(id));
  };
  const run = runDaemon(
    threeDisjointPlan(),
    {
      refreshMerged: () => () => false,
      ...(gate === "merged"
        ? {
            refreshMergedAsync: async () => {
              // Any read before the refill answers at once; the refill's parks until released.
              if (!started.includes("B") || mergedReads++ > 0 || !bReleased) return () => false;
              refillReadStarted.resolve();
              await refillRead.promise;
              return () => false;
            },
          }
        : {}),
      ...(gate === "run-branches"
        ? {
            readPushedRunBranches: async () => {
              // The tick's own read answers at once; the refill's parks until released.
              if (branchReads++ === 0 || !bReleased) return "";
              refillReadStarted.resolve();
              await refillRead.promise;
              return "";
            },
          }
        : {}),
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      now: () => new Date(nowMs),
      sleep: () => {
        const sleep = deferred<void>();
        sleeps.push(sleep);
        return sleep.promise;
      },
      checkFreshness: () => (stale ? staleOwnCode : { stale: false }),
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2 },
  );
  return {
    steps, started, release, bothStarted, refillRead, refillReadStarted, run,
    freeB: () => { bReleased = true; release.B.resolve(okResult("B")); },
    goStale: () => { stale = true; },
    advanceClock: (ms: number) => { nowMs += ms; },
    tick: async () => {
      await drainMicrotasks();
      sleeps.shift()?.resolve();
      await drainMicrotasks();
      await drainMicrotasks();
    },
  };
}

async function decideRestartWhileTheRefillReadIsInFlight(gate: "merged" | "run-branches") {
  const h = harness(gate);
  await h.bothStarted.promise;
  h.freeB(); // B frees its lane; the refill starts its awaited read while still fresh
  await h.refillReadStarted.promise;
  h.goStale();
  await h.tick(); // the dispatch tick observes the advance and opens the quiet window
  h.advanceClock(FRESHNESS_COALESCE_WINDOW_MS.value);
  await h.tick(); // past the window: the dispatch tick decides to restart
  assert.ok(h.steps.some((l) => l.step === "daemon.freshness_decision" && l.extra?.action === "restart"),
    "control: the restart was decided while the refill read was in flight");
  h.refillRead.resolve();
  await drainMicrotasks();
  await drainMicrotasks();
  return h;
}

/** Releases the held run and settles the daemon whatever the assertions found, so one red never leaks a live
 *  daemon (and its ticker) into the next test. */
async function settled<T>(h: ReturnType<typeof harness>, body: () => T | Promise<T>): Promise<void> {
  try {
    await body();
  } finally {
    h.release.A.resolve(okResult("A"));
    await Promise.race([h.run.catch(() => undefined), new Promise((r) => setTimeout(r, 2_000))]);
  }
}

test("W1-T6274: a pending freshness restart refuses a new dispatch and says why", async () => {
  const h = await decideRestartWhileTheRefillReadIsInFlight("merged");
  await settled(h, async () => {
    assert.deepEqual(h.started, ["A", "B"], "C is not dispatched onto B's freed lane");
    const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
    assert.match(String(held?.extra?.reason), /^stale code \(decided while the refill read was in flight\)$/);
    h.release.A.resolve(okResult("A"));
    assert.equal((await h.run).stopReason, "stale", "the in-flight run finishes and the daemon restarts");
  });
});

test("W1-T6274: a restart decided while a refill's run-branch read is in flight holds the lane", async () => {
  const h = await decideRestartWhileTheRefillReadIsInFlight("run-branches");
  await settled(h, async () => {
    assert.deepEqual(h.started, ["A", "B"], "C is not dispatched onto B's freed lane");
    const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
    assert.match(String(held?.extra?.reason), /^stale code/);
    h.release.A.resolve(okResult("A"));
    assert.equal((await h.run).stopReason, "stale");
  });
});
