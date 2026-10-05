import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import * as daemon from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// W1-T5720 — A BOOT REVIEWS BEFORE IT RUNS ITS CADENCES. The loop ticks a median 2 times per lifetime, so
// every iteration-top cadence ran on tick 1 ahead of the first full pass: first `sweep.pass` p50 8.1 / p90
// 20.0 min after `daemon.boot`. Tick 1 now runs a light pass at once, then holds the cadences and the
// garden fan-out until the first full pass settles or BOOT_CADENCE_GATE_BOUND_MS passes.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-reviews-first-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

type Line = { step: string; extra: Record<string, unknown> };

/** One boot over fake deps. `firstPass` is the first full pass's own promise; every later pass settles at once. */
async function bootOnce(firstPass: Promise<void>, opts: { bootCadenceGateBoundMs: number; sweepWallClockBoundMs: number },
  onLightPass: () => void = () => {}) {
  const events: string[] = [];
  const lines: Line[] = [];
  let sweeps = 0;
  let nowMs = 0;
  const merged = new Set<string>();
  const summary = await daemon.runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        events.push("dispatch");
        merged.add(id);
        return okResult(id);
      },
      sweep: async () => {
        if (++sweeps === 1) {
          await firstPass;
          events.push("first-pass-settled");
        }
      },
      sweepLight: async (scope) => {
        events.push(scope?.reviewOnly ? "light-pass:review-only" : "light-pass");
        events.push("review-admitted");
        onLightPass();
      },
      checkMeasurementCadence: () => {
        events.push("measurement");
        return { fire: false, reason: "fixture" };
      },
      checkRetroTrigger: () => {
        events.push("retro");
        return undefined;
      },
      gardens: [
        () => {
          events.push("garden");
          return { stop: () => {} };
        },
      ],
      now: () => new Date(nowMs),
      checkStop: () => undefined,
      checkPause: () => undefined,
      // A real timer, so a phase ticker's own light pass lands well after any same-tick cadence would.
      sleep: async () => {
        nowMs += 10;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1, pollIntervalMs: 5, ...opts },
  );
  return { events, lines, summary };
}

test("W1-T5720: a boot's light pass and review admission run before any tick-1 cadence, released when the first full pass settles", async () => {
  let releaseFirstPass: (() => void) | undefined;
  const firstPass = new Promise<void>((resolve) => (releaseFirstPass = resolve));
  // The first light pass releases the first full pass a little later, so a cadence that did not wait would be seen first.
  const { events, lines, summary } = await bootOnce(firstPass, { bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 60_000 },
    () => setTimeout(() => releaseFirstPass?.(), 30));
  assert.deepEqual(summary.merged, ["A"], "the boot still dispatches");
  const first = (e: string): number => events.indexOf(e);
  assert.ok(first("light-pass:review-only") >= 0, `fixture: a light pass ran (saw ${events.join(", ")})`);
  for (const cadence of ["measurement", "retro", "garden", "dispatch"]) {
    assert.ok(first(cadence) >= 0, `fixture: ${cadence} ran (saw ${events.join(", ")})`);
    assert.ok(first("review-admitted") < first(cadence), `the boot's review admission precedes ${cadence} (saw ${events.join(", ")})`);
    assert.ok(first("first-pass-settled") < first(cadence), `${cadence} waits for the first full pass (saw ${events.join(", ")})`);
  }
  assert.equal(events[0], "light-pass:review-only", `the boot's light pass runs with no initial sleep (saw ${events.join(", ")})`);
  const deferred = lines.filter((l) => l.step === "daemon.boot_gate.deferred").map((l) => l.extra.cadence);
  assert.deepEqual(deferred, ["gardens", "checkMeasurementCadence", "checkRetroTrigger"], "each deferral names its cadence");
  for (const l of lines.filter((r) => r.step === "daemon.boot_gate.deferred")) {
    assert.equal(l.extra.reason, "first full pass has not settled", "each deferral names why");
    assert.equal(l.extra.bound_ms, 60_000);
  }
  const opened = lines.filter((l) => l.step === "daemon.boot_gate.opened");
  assert.equal(opened.length, 1, "the gate opens once per boot");
  assert.equal(opened[0]!.extra.trigger, "first_pass");
  assert.equal(events.filter((e) => e === "measurement").length, 1, "no cadence is skipped: tick 1 still runs it");
});

test("W1-T5720: a first full pass that never settles releases the tick-1 cadences at the backstop bound", async () => {
  const { events, lines } = await bootOnce(new Promise<void>(() => {}), { bootCadenceGateBoundMs: 80, sweepWallClockBoundMs: 1_500 });
  assert.ok(!events.includes("first-pass-settled"), "fixture: the first pass never settled");
  const opened = lines.find((l) => l.step === "daemon.boot_gate.opened");
  assert.equal(opened?.extra.trigger, "backstop", "the backstop, not the pass's own wall-clock bound, released the gate");
  assert.equal(opened?.extra.pass_in_flight, true, "the row says the pass was still running");
  const openedAt = lines.indexOf(opened!);
  const abandonedAt = lines.findIndex((l) => l.step === "daemon.sweep.abandoned");
  assert.ok(abandonedAt < 0 || abandonedAt > openedAt, "the gate did not wait the pass out to its own bound");
  for (const cadence of ["measurement", "retro", "garden"]) {
    assert.ok(events.includes(cadence), `${cadence} still runs once the backstop releases it (saw ${events.join(", ")})`);
  }
});

test("W1-T5720: a daemon with no full pass wired has nothing to wait for and starts its gardens at boot", async () => {
  const events: string[] = [];
  const lines: Line[] = [];
  await daemon.runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => okResult(id),
      gardens: [() => (events.push("garden"), { stop: () => {} })],
      checkStop: () => undefined,
      checkPause: () => undefined,
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 0 },
  );
  assert.deepEqual(events, ["garden"], "gardens start at boot when there is no first pass to wait for");
  assert.ok(!lines.some((l) => l.step.startsWith("daemon.boot_gate.")), "no gate row without a full pass");
});

test("W1-T5720: a boot light pass that throws is ledgered and the cadences still wait for the first full pass", async () => {
  let releaseFirstPass: (() => void) | undefined;
  const firstPass = new Promise<void>((resolve) => (releaseFirstPass = resolve));
  const { events, lines } = await bootOnce(firstPass, { bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 60_000 }, () => {
    setTimeout(() => releaseFirstPass?.(), 20);
    throw new Error("light pass boom");
  });
  const failed = lines.find((l) => l.step === "daemon.sweep_light.failed" && l.extra.phase === "boot");
  assert.match(String(failed?.extra.error), /light pass boom/, "the boot light pass's failure is ledgered");
  assert.ok(events.indexOf("first-pass-settled") < events.indexOf("measurement"), `measurement still waits (saw ${events.join(", ")})`);
});

test("W1-T5720: with a full pass but nothing to defer, tick 1 admits without waiting for that pass", async () => {
  let releaseFirstPass: (() => void) | undefined;
  const firstPass = new Promise<void>((resolve) => (releaseFirstPass = resolve));
  const lines: Line[] = [];
  let dispatchedWhilePassRan: boolean | undefined;
  let settled = false;
  const summary = await daemon.runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        dispatchedWhilePassRan ??= !settled;
        releaseFirstPass?.();
        return okResult(id);
      },
      sweep: async () => {
        await firstPass;
        settled = true;
      },
      checkStop: () => undefined,
      checkPause: () => undefined,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 60_000 },
  );
  assert.equal(summary.stopReason, "max_reached");
  assert.equal(dispatchedWhilePassRan, true, "W1-T4998's admission contract holds when the gate has nothing to hold");
  assert.ok(!lines.some((l) => l.step.startsWith("daemon.boot_gate.")), "no gate row when nothing is deferred");
});
