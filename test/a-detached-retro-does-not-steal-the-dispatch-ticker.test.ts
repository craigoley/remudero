import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { MergedSet } from "../src/lib/drain.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { drainDetachedSweepActions } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`fixture timed out waiting for ${detail}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function exerciseHandoff(wake: "wake" | undefined): Promise<{
  lightSweeps: number;
  lines: Array<{ step: string; extra: Record<string, unknown> }>;
}> {
  const planDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3181-`));
  const planFile = join(planDir, "tasks.yaml");
  writeFileSync(planFile, PLAN_YAML);
  const plan = loadPlan(planFile);
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const retro = deferred();
  const worker = deferred();
  const workerStarted = deferred();
  const waits: Array<{ ms: number; resolve: (result: "wake" | undefined) => void }> = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let lightSweeps = 0;
  let retroChecked = false;
  let workerReleased = false;

  const pending = runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id): Promise<RunResult> => {
      workerStarted.resolve();
      await worker.promise;
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    sleepUntilSweepWake: async (ms) => {
      if (workerReleased) return undefined;
      return new Promise((resolve) => waits.push({ ms, resolve }));
    },
    sweepLight: async () => {
      lightSweeps++;
    },
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    checkRetroTrigger: () => {
      if (retroChecked) return { fire: false as const, mergesSinceMarker: 0, daysSinceMarker: 0 };
      retroChecked = true;
      return { fire: true as const, reason: "merges" as const, mergesSinceMarker: 99, daysSinceMarker: 0 };
    },
    runRetroTrigger: async () => {
      await retro.promise;
    },
    checkStop: () => (workerReleased ? "fixture complete" : undefined),
  }, { pollIntervalMs: 5_000 });

  // Call 1 is the interphase clock's 1s quantum; call 2 is the retro ticker's 5s wait.
  // Dispatch cannot start until the interphase clock observes its stop, so release only call 1.
  await until(() => waits.some((entry) => entry.ms === 1_000) && waits.some((entry) => entry.ms === 5_000), "both pre-dispatch clocks");
  waits.find((entry) => entry.ms === 1_000)!.resolve(undefined);
  await workerStarted.promise;

  // Retro fails and settles FIRST. Its old stop handle must not stop the clock that dispatch now owns.
  retro.reject(new Error("fixture retro failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const dispatchWait = waits.find((entry) => entry.ms === 5_000)!;
  dispatchWait.resolve(wake);
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Let the admitted run settle only after observing the overlap; then wake any wait that stopTicker
  // is draining. STOP is checked on the next loop boundary, so no idle polling call is introduced.
  workerReleased = true;
  worker.resolve();
  await until(() => lines.some((line) => line.step === "dispatch.settled_set"), "dispatch settlement");
  for (const entry of waits.slice(2)) entry.resolve(undefined);
  await pending;
  await drainDetachedSweepActions({ boundMs: 5_000 });

  return { lightSweeps, lines };
}

for (const wake of [undefined, "wake"] as const) {
  test(`W1-T3181: dispatch keeps the detached retro ticker after retro settles first (${wake ?? "interval"})`, async () => {
    const { lightSweeps, lines } = await exerciseHandoff(wake);
    assert.ok(lines.some((line) => line.step === "daemon.retro_trigger.run_failed"), "the detached retro failure remains handled and attributable");
    assert.ok(
      lines.some((line) => line.step === "daemon.alive" && line.extra.phase === "dispatch"),
      "the one ticker changes ownership and reports dispatch; the old boolean leaves dispatch with an inert stub",
    );
    assert.ok(lightSweeps >= 1, "the restricted light pass still runs before the worker settles");
  });
}
