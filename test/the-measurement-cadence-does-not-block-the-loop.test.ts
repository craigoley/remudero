/**
 * W1-T4034 — the measurement cadence must not hold the daemon's iteration.
 *
 * Review admission happens ONLY inside a sweep pass, and a sweep pass happens only once per daemon
 * iteration. Measured 2026-09-22: `sweep.pass` rows stopped at 13:19:23Z and resumed at 13:40:53Z —
 * 21.5 minutes with no sweep — while two already-green PRs waited 42 and 29 minutes for a review
 * that took 21 seconds. The cadence's verify-human leg alone ran 8m38s inside that inline await.
 *
 * Each test blocks the cadence on a promise that cannot settle until the assertion has already
 * proved the rest of the tick proceeded — the same discipline W1-T3997 used for `ci-learning`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { drainDetachedSweepActions, detachedActionInFlight } from "../src/lib/sweep.js";
import type { MeasurementCadenceRunResult } from "../src/lib/measurement-cadence.js";
import type { RunResult } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4034-`));
  const path = join(directory, "tasks.yaml");
  writeFileSync(path, YAML);
  return loadPlan(path);
}

function result(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
}

function cadenceResult(): MeasurementCadenceRunResult {
  return {
    ruleEfficacy: "SENTINEL_ruleEfficacy",
    verdictCalibration: "SENTINEL_verdictCalibration",
    autonomyRate: "SENTINEL_autonomyRate",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as MeasurementCadenceRunResult;
}

/** The daemon deps every test here shares; only the cadence hook differs. */
function daemonDeps(lines: string[], merged: Set<string>, extra: Record<string, unknown>) {
  return {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => { merged.add(id); return result(id); },
    sleep: async () => {},
    sweep: async () => {},
    log: (step: string) => lines.push(step),
    checkMeasurementCadence: () => ({ fire: true, reason: "due" }),
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("W1-T4034: the measurement cadence does not block the daemon iteration", { timeout: 2_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in from another test");
  const lines: string[] = [];
  const detachedRows: Record<string, unknown>[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });

  // runDaemon RESOLVING while the cadence is still unsettled IS the assertion: before this fix the
  // await below could not return until `release()` ran, so this call would hit its own timeout.
  await runDaemon(fixturePlan(), daemonDeps(lines, new Set(), {
    runMeasurementCadence: async () => { await blocked; return cadenceResult(); },
    log: (step: string, extra?: Record<string, unknown>) => {
      lines.push(step);
      if (step === "measurement_cadence.detached") detachedRows.push(extra ?? {});
    },
  }), { max: 1 });

  assert.ok(lines.includes("measurement_cadence.fired"), "control: the cadence really fired this tick");
  assert.ok(lines.includes("measurement_cadence.detached"), "the fired cadence is detached rather than awaited inline");
  assert.equal(detachedRows[0]?.flow, "the cadence runs detached so the sweep keeps its turn", "the detached site records why the sweep remains free");
  assert.ok(!lines.includes("measurement_cadence.ran"), "and it has NOT completed — the iteration finished ahead of it");

  release();
  await drainDetachedSweepActions();
});

test("W1-T4034: a second measurement cadence is refused while the first is unsettled", { timeout: 2_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in from another test");
  const lines: string[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const deps = () => daemonDeps(lines, new Set(), {
    runMeasurementCadence: async () => { await blocked; return cadenceResult(); },
  });

  await runDaemon(fixturePlan(), deps(), { max: 1 });
  assert.ok(lines.includes("measurement_cadence.detached"), "control: the first cadence detached and is still in flight");

  const second: string[] = [];
  await runDaemon(fixturePlan(), daemonDeps(second, new Set(), {
    runMeasurementCadence: async () => { await blocked; return cadenceResult(); },
  }), { max: 1 });
  assert.ok(second.includes("measurement_cadence.already_detached"), "the second fire is refused, never stacked");
  assert.ok(!second.includes("measurement_cadence.fired"), "and it never claims to have fired");

  release();
  await drainDetachedSweepActions();
});

test("W1-T4034: a detached measurement cadence still ledgers that it ran", { timeout: 2_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in from another test");
  const lines: string[] = [];
  await runDaemon(fixturePlan(), daemonDeps(lines, new Set(), {
    runMeasurementCadence: async () => cadenceResult(),
  }), { max: 1 });

  await drainDetachedSweepActions();
  assert.ok(lines.includes("measurement_cadence.ran"), "detaching moved the await, it did not drop the completion row");
});

test("W1-T4034: a throwing measurement cadence never fails the daemon loop", { timeout: 2_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in from another test");
  const lines: string[] = [];
  await runDaemon(fixturePlan(), daemonDeps(lines, new Set(), {
    // A SYNCHRONOUS throw, before any promise exists to detach — the shape a legacy or injected
    // runner takes. The daemon must still complete its iteration.
    runMeasurementCadence: () => { throw new Error("cadence exploded"); },
  }), { max: 1 });

  assert.ok(lines.includes("measurement_cadence.run_failed"), "the failure is ledgered");
  assert.ok(!lines.includes("measurement_cadence.detached"), "and nothing was detached, because nothing started");
  await drainDetachedSweepActions();
});
