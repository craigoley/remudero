/**
 * W1-T14713 — the measurement cadence child's V8 heap limit follows its own recorded heap peaks.
 *
 * 2026-11-24: the child's state file reported heapUsed 976 MB under a 7826 MB limit (the parent's whole heap, W1-T5723)
 * while its RSS held 5.0-6.6 GB: with that much room V8 defers collection, and host memory capped the fleet at one lane.
 * These drive the exported pure derivation and the production spawn over a real state file and a fake spawner.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  childMeasurementCadenceSpawn,
  measurementCadenceChildHeapLimitMb,
  measurementCadenceChildLogPath,
  measurementCadenceChildMain,
  noteMeasurementCadencePhase,
  type MeasurementCadenceChildState,
  type MeasurementCadenceRunResult,
} from "#src/lib/measurement-cadence.js";
// The history's own exports by namespace, so the criteria above load and fail on their assertions at the base.
import * as cadence from "#src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MB = 1024 * 1024;
/** The live parent's heap limit on 2026-11-24. */
const PARENT_MB = 7826;

/** Peaks shaped as the history keeps them: one per finished run. */
function peaks(values: readonly number[]): { runId: string; attempt: number; peakMb: number }[] {
  return values.map((peakMb, i) => ({ runId: `RUN-${i}`, attempt: 1, peakMb }));
}

/** About 1 GB a run, as the live child reported. */
const LIVE_LIKE = [941, 958, 962, 970, 976, 949, 955, 968, 973, 980, 944, 951, 966, 959, 975, 947, 963, 971, 957, 969];

function scratch(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14713-`));
}

/** The production spawn over a fake spawner: returns the `--max-old-space-size` each launch was given. */
function spawnRecorder(statePath: string) {
  const limits: number[] = [];
  const spawn = childMeasurementCadenceSpawn({
    entry: "/entry.ts",
    execPath: "/node",
    execArgv: [],
    parentHeapLimitBytes: () => PARENT_MB * MB,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnChild: ((_file: string, args: readonly string[]) => {
      const flag = args.find((a) => a.startsWith("--max-old-space-size="));
      limits.push(Number(flag?.split("=")[1]));
      return { pid: 4242, unref: () => {} };
    }) as any,
    setPriority: () => {},
  });
  return { limits, launch: (runId: string) => spawn(runId, statePath) };
}

function writeState(statePath: string, state: MeasurementCadenceChildState & { peakHeapCommittedMb?: number }): void {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

function doneRun(statePath: string, runId: string, peakHeapCommittedMb: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeState(statePath, { runId, pid: 4242, attempt: 1, startedAt: "2026-11-24T10:00:00.000Z", status: "done", result: {} as any, peakHeapCommittedMb });
}

test("W1-T14713 criterion 1: recorded ~1 GB peaks give a limit near them plus a variance-derived headroom, well under the parent's", () => {
  const limit = measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks(LIVE_LIKE));
  const largest = Math.max(...LIVE_LIKE);
  assert.ok(limit > largest, `the limit keeps headroom above the largest peak: ${limit} > ${largest}`);
  assert.ok(limit < PARENT_MB / 4, `and sits near the ~1 GB peaks, well under the parent's ${PARENT_MB} MB: ${limit}`);

  // The headroom comes from the spread: the same centre with a wider spread gets more room.
  const centre = LIVE_LIKE.reduce((a, b) => a + b, 0) / LIVE_LIKE.length;
  const wider = LIVE_LIKE.map((x) => Math.round(centre + (x - centre) * 4));
  const widerLimit = measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks(wider));
  assert.ok(widerLimit - Math.max(...wider) > limit - largest, `a wider spread keeps more headroom: ${widerLimit} vs ${limit}`);

  // End to end: finished runs' peaks, as each child's state file reports them, reach the next launch's argv.
  const statePath = join(scratch(), "measurement-cadence-child.json");
  const spawn = spawnRecorder(statePath);
  LIVE_LIKE.forEach((peak, i) => {
    doneRun(statePath, `RUN-${i}`, peak);
    spawn.launch(`RUN-${i + 1}`);
  });
  const last = spawn.limits.at(-1) ?? NaN;
  assert.ok(last > largest && last < PARENT_MB / 4, `the spawn gives the child the derived limit, not the parent's: ${spawn.limits.join(",")}`);
});

test("W1-T14713 criterion 2: too few recorded peaks, or none, give the parent's limit exactly; the derived limit never exceeds it", () => {
  assert.equal(measurementCadenceChildHeapLimitMb(PARENT_MB * MB), PARENT_MB, "no history: the parent's limit, as on origin/main");
  assert.equal(measurementCadenceChildHeapLimitMb(PARENT_MB * MB, []), PARENT_MB, "an empty history: the parent's limit");
  assert.equal(measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks([976])), PARENT_MB, "one peak has no variance: the parent's limit");
  assert.equal(
    measurementCadenceChildHeapLimitMb(PARENT_MB * MB, [{ runId: "RUN-A", attempt: 1, abortedUnderMb: 1200 }]),
    PARENT_MB,
    "an abort alone is not a peak: the parent's limit",
  );

  assert.equal(measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks([7000, 7600, 7800])), PARENT_MB, "headroom past the parent's limit is cut at it");
  assert.equal(measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks([9000, 9100])), PARENT_MB, "peaks above the parent's limit never raise it past it");
  assert.equal(
    measurementCadenceChildHeapLimitMb(PARENT_MB * MB, [...peaks(LIVE_LIKE), { runId: "RUN-B", attempt: 1, abortedUnderMb: 7000 }]),
    PARENT_MB,
    "an abort's rise is cut at the parent's limit",
  );

  // The spawn on a fresh state directory still gives the parent's limit, and so does one finished run.
  const statePath = join(scratch(), "measurement-cadence-child.json");
  const spawn = spawnRecorder(statePath);
  spawn.launch("RUN-0");
  doneRun(statePath, "RUN-0", 976);
  spawn.launch("RUN-1");
  assert.deepEqual(spawn.limits, [PARENT_MB, PARENT_MB], "with one recorded peak the child still gets the parent's limit");
});

test("W1-T14713 criterion 3: invariant:a-child-is-never-starved-below-its-own-peak, and a heap abort raises the next limit", async () => {
  // One run far above the rest: its peak is the floor, whatever the percentile and the spread say.
  const outlier = [...LIVE_LIKE.slice(0, 19), 2600];
  const limit = measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks(outlier));
  assert.ok(limit >= 2600, `the limit is never below the largest recorded peak: ${limit}`);
  for (let n = 2; n <= LIVE_LIKE.length; n += 1) {
    const some = LIVE_LIKE.slice(0, n);
    const derived = measurementCadenceChildHeapLimitMb(PARENT_MB * MB, peaks(some));
    assert.ok(derived >= Math.max(...some), `with ${n} peaks the limit ${derived} is at or above their largest`);
  }

  // A child that dies of a heap abort under the derived limit records it, and the next launch gets more.
  const statePath = join(scratch(), "measurement-cadence-child.json");
  const spawn = spawnRecorder(statePath);
  LIVE_LIKE.forEach((peak, i) => {
    doneRun(statePath, `RUN-${i}`, peak);
    spawn.launch(`RUN-${i + 1}`);
  });
  const diedUnder = spawn.limits.at(-1) ?? NaN;
  assert.ok(diedUnder < PARENT_MB, `precondition: the run launched under a derived limit: ${diedUnder}`);
  writeState(statePath, {
    runId: `RUN-${LIVE_LIKE.length}`, pid: 4242, attempt: 1, startedAt: "2026-11-24T11:00:00.000Z", status: "running",
    phase: { verb: "hand_run_census", heapUsedMb: 990, heapLimitMb: diedUnder + 60, at: "2026-11-24T11:20:00.000Z" },
  });
  writeFileSync(
    measurementCadenceChildLogPath(statePath),
    `<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n\n[measurement cadence child 4242 exited: code=null signal=SIGABRT heap_limit_mb=${diedUnder}]\n`,
  );
  spawn.launch(`RUN-${LIVE_LIKE.length}`); // the restart's attempt 2
  const restartLimit = spawn.limits.at(-1) ?? NaN;
  assert.ok(restartLimit > diedUnder, `the restart after a heap abort gets more than the ${diedUnder} MB it died under: ${restartLimit}`);
  assert.equal(restartLimit, 2 * diedUnder, "and the step is geometric: twice the limit it died under");

  // A second abort, after a daemon restart (no exit line: the limit comes from the state's phase), rises again.
  writeState(statePath, {
    runId: `RUN-${LIVE_LIKE.length}`, pid: 4243, attempt: 2, startedAt: "2026-11-24T11:30:00.000Z", status: "running",
    phase: { verb: "hand_run_census", heapUsedMb: 1010, heapLimitMb: restartLimit, at: "2026-11-24T11:50:00.000Z" },
  });
  writeFileSync(measurementCadenceChildLogPath(statePath), "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n");
  spawn.launch("RUN-NEXT");
  assert.equal(spawn.limits.at(-1), 2 * restartLimit, `a second abort doubles it again: ${spawn.limits.slice(-3).join(" -> ")}`);
  // A third abort would double past the parent's limit: the parent's limit is the ceiling.
  writeState(statePath, {
    runId: "RUN-NEXT", pid: 4244, attempt: 1, startedAt: "2026-11-24T12:00:00.000Z", status: "running",
    phase: { verb: "hand_run_census", heapUsedMb: 1020, heapLimitMb: 2 * restartLimit, at: "2026-11-24T12:20:00.000Z" },
  });
  writeFileSync(measurementCadenceChildLogPath(statePath), "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
  spawn.launch("RUN-NEXT");
  assert.equal(spawn.limits.at(-1), Math.min(PARENT_MB, 4 * restartLimit), "the doubling stops at the parent's limit");

  // A death that is not a heap abort records nothing: the next launch keeps the derived limit.
  const quiet = join(scratch(), "measurement-cadence-child.json");
  const other = spawnRecorder(quiet);
  LIVE_LIKE.forEach((peak, i) => {
    doneRun(quiet, `RUN-${i}`, peak);
    other.launch(`RUN-${i + 1}`);
  });
  writeState(quiet, { runId: "RUN-X", pid: 4242, attempt: 1, startedAt: "2026-11-24T11:00:00.000Z", status: "running" });
  writeFileSync(measurementCadenceChildLogPath(quiet), "[measurement cadence child 4242 exited: code=null signal=SIGKILL heap_limit_mb=1100]\n");
  other.launch("RUN-X");
  assert.equal(other.limits.at(-1), other.limits.at(-2), "a killed child is not a heap abort");

  // The child itself records the peak heapUsed it saw, which the next launch reads.
  const childState = join(scratch(), "measurement-cadence-child.json");
  const code = await measurementCadenceChildMain(childState, "RUN-CHILD", async () => {
    noteMeasurementCadencePhase("rule_efficacy");
    return {} as MeasurementCadenceRunResult;
  });
  assert.equal(code, 0);
  const recorded = JSON.parse(readFileSync(childState, "utf8")) as { status: string; peakHeapCommittedMb?: number; phase?: { heapUsedMb: number } };
  assert.equal(recorded.status, "done");
  assert.ok(typeof recorded.peakHeapCommittedMb === "number" && recorded.peakHeapCommittedMb >= (recorded.phase?.heapUsedMb ?? Infinity), `the child records its committed peak: ${JSON.stringify(recorded)}`);

  // The peak is the committed heap's max over every sample, including the interval sampler's between phase boundaries:
  // here the committed heap spikes to 3000 MB only while the run is between phases, and only the sampler can see it.
  const sampled = join(scratch(), "measurement-cadence-child.json");
  let calls = 0;
  let spiked!: () => void;
  const spikeSeen = new Promise<void>((resolve) => { spiked = resolve; });
  const committedBytes = () => {
    calls += 1;
    if (calls === 2) { spiked(); return 3000 * MB; }
    return (calls === 1 ? 900 : 1100) * MB;
  };
  const keepAlive = setTimeout(() => {}, 10_000); // the sampler is unref'd: this keeps the loop up while it runs
  await measurementCadenceChildMain(sampled, "RUN-SAMPLED", async () => {
    noteMeasurementCadencePhase("rule_efficacy"); // call 1: 900 MB at the boundary
    await spikeSeen; // call 2 can only be the interval sampler
    return {} as MeasurementCadenceRunResult;
  }, { committedBytes, everyMs: 1 });
  clearTimeout(keepAlive);
  const sampledState = JSON.parse(readFileSync(sampled, "utf8")) as { peakHeapCommittedMb?: number };
  assert.equal(sampledState.peakHeapCommittedMb, 3000, "the sampler's between-phase spike is the recorded peak");
  const callsAtExit = calls;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, callsAtExit, "the sampler is cleared when the child's run ends");
});

test("W1-T14713: an unreadable or unhelpful heap history degrades to the parent's limit and never blocks the launch", () => {
  const dir = scratch();
  const statePath = join(dir, "measurement-cadence-child.json");
  const historyPath = cadence.measurementCadenceChildHeapHistoryPath(statePath);

  assert.equal(cadence.recordMeasurementCadenceChildHeapRun(statePath), undefined, "no state file: nothing to record");
  writeFileSync(statePath, "{not json");
  assert.equal(cadence.recordMeasurementCadenceChildHeapRun(statePath), undefined, "an unreadable state file: nothing to record");

  // A run that failed in JS, and a done run from a child that recorded no peak, add nothing.
  writeState(statePath, { runId: "RUN-F", pid: 1, attempt: 1, startedAt: "2026-11-24T10:00:00.000Z", status: "failed", error: "boom" });
  assert.equal(cadence.recordMeasurementCadenceChildHeapRun(statePath), undefined, "a failed run is not a peak");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeState(statePath, { runId: "RUN-OLD", pid: 1, attempt: 1, startedAt: "2026-11-24T10:00:00.000Z", status: "done", result: {} as any });
  assert.equal(cadence.recordMeasurementCadenceChildHeapRun(statePath), undefined, "a done run without a recorded peak adds nothing");

  // One run attempt is kept once, however many launches read it.
  doneRun(statePath, "RUN-1", 970);
  assert.deepEqual(cadence.recordMeasurementCadenceChildHeapRun(statePath), { runId: "RUN-1", attempt: 1, peakMb: 970 });
  assert.equal(cadence.recordMeasurementCadenceChildHeapRun(statePath), undefined, "the same attempt is not recorded twice");
  assert.equal(cadence.readMeasurementCadenceChildHeapHistory(statePath).length, 1);

  // A heap abort whose limit is unknown says nothing about how much more it needs: the parent's limit.
  writeState(statePath, { runId: "RUN-2", pid: 1, attempt: 1, startedAt: "2026-11-24T10:00:00.000Z", status: "running" });
  writeFileSync(measurementCadenceChildLogPath(statePath), "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
  assert.equal(cadence.nextMeasurementCadenceChildHeapLimitMb(statePath, PARENT_MB * MB), PARENT_MB, "an abort under an unknown limit gives the parent's");
  assert.equal(
    measurementCadenceChildHeapLimitMb(PARENT_MB * MB, [...peaks(LIVE_LIKE), { runId: "RUN-L", attempt: 1, abortedUnderMb: 900 }]),
    1800,
    "an abort under 900 MB, even one the recorded peaks passed, gives twice that",
  );

  // A malformed or non-array history reads empty; one that cannot be read or written does not stop the launch.
  writeFileSync(historyPath, "{not json");
  assert.deepEqual(cadence.readMeasurementCadenceChildHeapHistory(statePath), []);
  writeFileSync(historyPath, `${JSON.stringify({ runId: "x" })}\n`);
  assert.deepEqual(cadence.readMeasurementCadenceChildHeapHistory(statePath), []);
  writeFileSync(historyPath, `${JSON.stringify([{ runId: "ok", attempt: 1, peakMb: 900 }, { peakMb: 5 }, null])}\n`);
  assert.deepEqual(cadence.readMeasurementCadenceChildHeapHistory(statePath), [{ runId: "ok", attempt: 1, peakMb: 900 }], "malformed rows are dropped");

  const blocked = join(dir, "blocked.json");
  mkdirSync(cadence.measurementCadenceChildHeapHistoryPath(blocked)); // a directory where the history file belongs
  doneRun(blocked, "RUN-B", 970);
  assert.deepEqual(cadence.readMeasurementCadenceChildHeapHistory(blocked), [], "an unreadable history reads empty");
  assert.equal(cadence.nextMeasurementCadenceChildHeapLimitMb(blocked, PARENT_MB * MB), PARENT_MB, "and a history it cannot write still launches, on the parent's limit");
});
