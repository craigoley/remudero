/**
 * W1-T7690 — a wall-clock-due rung is evaluated on its own timer, not only when the outer cycle comes round.
 *
 * Observed 2026-10-10: the measurement cadence's rolling-24h slot freed at 06:26:40Z and no cycle
 * evaluated it for 18+ minutes, because every due check sat inside the outer cycle's cadence block.
 * Each test holds `runOne` unresolved, which is exactly "the outer cycle is busy dispatching".
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { detachedActionInFlight, drainDetachedSweepActions } from "../src/lib/sweep.js";
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
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7690-`));
  const path = join(directory, "tasks.yaml");
  writeFileSync(path, YAML);
  return loadPlan(path);
}

function result(id: string): RunResult {
  return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
}

function cadenceResult(): MeasurementCadenceRunResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ruleEfficacy: "r", verdictCalibration: "v", autonomyRate: "a" } as any as MeasurementCadenceRunResult;
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("W1-T7690: a due measurement cadence fires while the outer cycle is blocked", { timeout: 4_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in from another test");
  const lines: string[] = [];
  const merged = new Set<string>();
  let due = false;
  let cadenceRuns = 0;
  let releaseRunOne: () => void = () => {};
  const runOneBlocked = new Promise<void>((resolve) => { releaseRunOne = resolve; });
  let runOneEntered = false;

  const daemon = runDaemon(fixturePlan(), {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => { runOneEntered = true; await runOneBlocked; merged.add(id); return result(id); },
    sleep: async () => {},
    sweep: async () => {},
    log: (step: string) => lines.push(step),
    checkMeasurementCadence: () => (due ? { fire: true, reason: "slot freed" } : { fire: false, reason: "daily cap reached (4/4)" }),
    runMeasurementCadence: async () => { cadenceRuns++; return cadenceResult(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, { max: 1, pollIntervalMs: 10 });

  await until(() => runOneEntered, "the outer cycle to reach dispatch");
  assert.ok(lines.includes("measurement_cadence.skipped"), "control: the first evaluation ran and skipped");
  assert.equal(cadenceRuns, 0, "control: nothing was due yet");

  due = true; // the rolling slot frees while the cycle is still inside runOne
  await until(() => lines.includes("measurement_cadence.fired"), "the due cadence to fire");
  assert.equal(runOneEntered && !merged.has("A"), true, "the outer cycle is STILL blocked when the cadence fires");
  await until(() => cadenceRuns === 1, "the cadence to start");

  releaseRunOne();
  await daemon;
  await drainDetachedSweepActions();
});

test("W1-T7690: the due timer never starts a second run of an in-flight rung", { timeout: 4_000 }, async () => {
  assert.equal(detachedActionInFlight("measurement-cadence"), false, "precondition: no cadence leaked in from another test");
  const lines: string[] = [];
  const merged = new Set<string>();
  let cadenceRuns = 0;
  let releaseCadence: () => void = () => {};
  const cadenceBlocked = new Promise<void>((resolve) => { releaseCadence = resolve; });
  let releaseRunOne: () => void = () => {};
  const runOneBlocked = new Promise<void>((resolve) => { releaseRunOne = resolve; });
  let runOneEntered = false;

  const daemon = runDaemon(fixturePlan(), {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => { runOneEntered = true; await runOneBlocked; merged.add(id); return result(id); },
    sleep: async () => {},
    sweep: async () => {},
    log: (step: string) => lines.push(step),
    // Still due on every look: the policy bound has not advanced because the run has not finished.
    checkMeasurementCadence: () => ({ fire: true, reason: "due" }),
    runMeasurementCadence: async () => { cadenceRuns++; await cadenceBlocked; return cadenceResult(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, { max: 1, pollIntervalMs: 10 });

  await until(() => runOneEntered, "the outer cycle to reach dispatch");
  await until(() => lines.filter((l) => l === "measurement_cadence.already_detached").length >= 3, "the timer to look again while the run is in flight");
  assert.equal(cadenceRuns, 1, "the rung ran once; every later timer look was refused");
  assert.equal(lines.filter((l) => l === "measurement_cadence.fired").length, 1, "and only one fire was claimed");

  releaseCadence();
  releaseRunOne();
  await daemon;
  await drainDetachedSweepActions();
});
