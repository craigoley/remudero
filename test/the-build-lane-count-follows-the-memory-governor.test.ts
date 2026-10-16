// W1-T9097 (ADR 0007 decision C, "Parallelism adapts") — THE BUILD LANE COUNT FOLLOWS THE MEMORY GOVERNOR, NOT A
// FIXED NUMBER. `sweep.dispatchLanes` is a fixed 3 that only a plan PR and a restart can change. `laneTarget` shrinks
// at once under container pressure and grows by at most one lane per quiet reading; the daemon ledgers it as
// `dispatch.lane_target` and, only under `enforce`, lets it cap new admissions. The daemon tests drive the REAL
// runDaemon at laneCount 2; only the worker spawn (`runOne`) and the governor's ports are faked.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadHostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import {
  defaultLaneGovernorPorts, laneTarget, readLaneMemory, type LaneGovernorPorts, type LaneMemoryReading, type LaneTargetPrevious,
} from "../src/lib/lane-governor.js";
import { loadPlan } from "../src/lib/plan.js";
import { loadLaneGovernorMode, parseLaneGovernorMode, PolicyError } from "../src/lib/policy.js";
import type { RunResult } from "../src/run-task.js";

/** A container with room for four more 1,400 MiB build trees under its 8,379 MiB memory.high, and a roomy host. */
function quiet(over: Partial<LaneMemoryReading> = {}): LaneMemoryReading {
  return {
    containerBaseMib: 2000, containerOnsetMib: 8379, containerArmCounts: true, containerBasis: "memory.high",
    hostBaseAvailableMib: 20_000, hostReserveMib: 2048, perLaneMib: 1400, containerPressed: false, highEvents: 10, ...over,
  };
}

test("W1-T9097: the lane target shrinks at once and grows one lane per quiet tick", () => {
  // Three lanes running at the fixed count, and the container pressed with its projection 1,500 MiB over memory.high:
  // more than one lane's worth, so the target drops straight to one rather than stepping down.
  const pressedOver = laneTarget({
    previous: { target: 3, highEvents: 10 }, inFlight: 3, cpuCount: 8,
    memory: quiet({ containerBaseMib: 8379 + 1500, containerPressed: true }),
  });
  assert.equal(pressedOver.target, 1, "a pressed container never keeps the fixed three lanes");
  assert.equal(pressedOver.binding, "container");
  assert.equal(pressedOver.pressed, true);

  // Pressure alone (the projection still fits) shrinks by a lane in the same reading, and memory.high events rising
  // since the previous reading is pressure too.
  const pressedFits = laneTarget({ previous: { target: 3, highEvents: 10 }, inFlight: 3, cpuCount: 8, memory: quiet({ containerPressed: true }) });
  assert.deepEqual([pressedFits.target, pressedFits.binding], [2, "pressure"]);
  const highRose = laneTarget({ previous: { target: 3, highEvents: 10 }, inFlight: 3, cpuCount: 8, memory: quiet({ highEvents: 12 }) });
  assert.deepEqual([highRose.target, highRose.binding, highRose.pressed], [2, "pressure", true]);

  // Quiet readings from one lane: one more lane each, until the container's projection binds at four.
  let previous: LaneTargetPrevious = pressedOver.next;
  const grown: Array<[number, string]> = [];
  for (let tick = 0; tick < 5; tick++) {
    const r = laneTarget({ previous, inFlight: 0, cpuCount: 8, memory: quiet() });
    grown.push([r.target, r.binding]);
    previous = r.next;
  }
  assert.deepEqual(grown, [[2, "growth"], [3, "growth"], [4, "container"], [4, "container"], [4, "container"]]);
  assert.equal(laneTarget({ previous, inFlight: 0, cpuCount: 8, memory: quiet() }).projectionMib, 2000 + 4 * 1400);

  // The only upper bounds are the adaptive WIP bound, the CPU count and the host arm — no fixed lane number.
  const roomy = quiet({ containerBaseMib: 0, containerOnsetMib: 100_000, hostBaseAvailableMib: 100_000 });
  assert.deepEqual([laneTarget({ previous: { target: 6 }, inFlight: 0, cpuCount: 16, wipBound: 5, memory: roomy }).binding,
    laneTarget({ previous: { target: 6 }, inFlight: 0, cpuCount: 16, wipBound: 5, memory: roomy }).target], ["wip", 5]);
  assert.deepEqual([laneTarget({ previous: { target: 6 }, inFlight: 0, cpuCount: 4, memory: roomy }).target], [4]);
  const hostTight = laneTarget({ inFlight: 0, cpuCount: 16, memory: quiet({ hostBaseAvailableMib: 2048 + 2 * 1400 }) });
  assert.deepEqual([hostTight.target, hostTight.binding], [2, "host"]);

  // W1-T8472: a container whose projection flags do not predict its pressure lets the host arm alone bound memory.
  const unpredictive = laneTarget({ inFlight: 0, cpuCount: 16, memory: quiet({ containerBaseMib: 9000, containerArmCounts: false }) });
  assert.equal(unpredictive.binding, "host");

  // An unread reading holds where it was and never grows.
  const unread = laneTarget({ previous: { target: 2, highEvents: 10 }, inFlight: 1, cpuCount: 8, memory: { unread: "EACCES" } });
  assert.deepEqual([unread.target, unread.binding, unread.unread, unread.next], [2, "unread", "EACCES", { target: 2, highEvents: 10 }]);
  assert.equal(laneTarget({ inFlight: 0, cpuCount: 8, memory: { unread: "EACCES" } }).target, 1);
});

function threeDisjointPlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-governor-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B") + task("C"));
  return loadPlan(f);
}

function okResult(id: string): RunResult {
  return { taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` } as unknown as RunResult;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Line = { step: string; extra?: Record<string, unknown> };

/** A and B are held open until the test releases them; C completes at once. */
function harness(laneGovernor: LaneGovernorPorts | undefined, extra: Partial<DaemonDeps> = {}) {
  const steps: Line[] = [];
  const started: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  let aSettled = false;
  const startedWhileARan: string[] = [];
  const clock = { ms: Date.parse("2026-10-16T00:00:00Z") };
  const merged = new Set<string>();
  const runOne = (id: string): Promise<RunResult> => {
    started.push(id);
    if (!aSettled && id !== "A") startedWhileARan.push(id);
    if (started.includes("A") && started.includes("B")) bothStarted.resolve();
    const settled = id === "A" || id === "B" ? release[id].promise : Promise.resolve(okResult(id));
    return settled.then((result) => { merged.add(id); return result; });
  };
  const settleA = () => {
    aSettled = true;
    release.A.resolve(okResult("A"));
  };
  const run = runDaemon(
    threeDisjointPlan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      sleep: async () => {},
      now: () => new Date(clock.ms),
      ...(laneGovernor ? { laneGovernor } : {}),
      ...extra,
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2, pollIntervalMs: 1000 },
  );
  return { steps, started, release, bothStarted, settleA, startedWhileARan, run, clock };
}

/** Fake ports whose reading the test swaps between ticks. */
function ports(mode: "shadow" | "enforce", first: LaneMemoryReading | Error) {
  const state: { reading: LaneMemoryReading | Error } = { reading: first };
  const fake: LaneGovernorPorts = {
    mode: () => mode,
    read: () => { if (state.reading instanceof Error) throw state.reading; return state.reading; },
    cpuCount: () => 8,
  };
  return { fake, state };
}

const laneTargetRows = (steps: Line[]) => steps.filter((l) => l.step === "dispatch.lane_target").map((l) => l.extra!);

test("W1-T9097: shadow ledgers the target and changes nothing", async () => {
  // Without a governor: the baseline dispatch this test compares against.
  const baseline = harness(undefined);
  await baseline.bothStarted.promise;
  baseline.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  baseline.settleA();
  await baseline.run;

  // Shadow, with the container pressed the whole time: the target reads one lane, yet both lanes still run and B's
  // freed lane still refills with C while A runs.
  const { fake } = ports("shadow", quiet({ containerBaseMib: 8379 + 3000, containerPressed: true }));
  const h = harness(fake);
  await h.bothStarted.promise;
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B", "C"], "C started on B's freed lane while A still ran");
  h.settleA();
  const summary = await h.run;
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(h.started, baseline.started, "the same tasks started in the same order");
  const refills = (steps: Line[]) => steps.filter((l) => l.step === "dispatch.lane_refilled" || l.step === "dispatch.lane_refill_held").map((l) => l.extra);
  assert.deepEqual(refills(h.steps), refills(baseline.steps), "the same refill decisions");
  assert.equal(h.steps.some((l) => l.step === "dispatch.lane_target_held"), false);

  const rows = laneTargetRows(h.steps);
  assert.ok(rows.length >= 1, "the target is ledgered");
  assert.deepEqual(rows[0], {
    mode: "shadow", target: 1, fixed: 2, binding: "container", projection_mib: 8379 + 3000 + 1400, onset_mib: 8379, in_flight: 0,
    pressed: true,
  });
  assert.equal(laneTargetRows(baseline.steps).length, 0, "no governor, no row");
});

test("W1-T9097: enforce caps refill and never stops a running lane", async () => {
  const { fake, state } = ports("enforce", quiet());
  const h = harness({ ...fake, cpuCount: () => 2 });
  await h.bothStarted.promise;
  // The tick's reading admitted both lanes (bound by the CPU count, two).
  assert.deepEqual(laneTargetRows(h.steps).map((r) => [r.mode, r.target, r.binding]), [["enforce", 2, "cpu"]]);

  // The container is pressed by the next reading: the target drops to one while A and B both run.
  state.reading = quiet({ containerPressed: true });
  h.clock.ms += 1000;
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B"], "B's freed lane is not refilled while A alone fills the target");
  const held = h.steps.filter((l) => l.step === "dispatch.lane_refill_held").map((l) => l.extra);
  assert.deepEqual(held, [{ lane: 1, finished_task: "B", reason: "lane target" }]);
  assert.deepEqual(laneTargetRows(h.steps).map((r) => [r.target, r.binding, r.in_flight]), [[2, "cpu", 0], [1, "pressure", 1]]);

  // A ran on above the target and settled on its own; the next tick admits C within the one-lane target.
  h.settleA();
  const summary = await h.run;
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual(h.started, ["A", "B", "C"]);
  const passes = h.steps.filter((l) => l.step === "dispatch.settled_set").map((l) => l.extra as { tasks: Array<{ id: string; status: string }> });
  assert.deepEqual(passes.map((p) => p.tasks.map((t) => `${t.id}:${t.status}`)), [["A:fulfilled", "B:fulfilled"], ["C:fulfilled"]],
    "A was never stopped: it settled fulfilled with its pass, and C ran alone in the next");
  assert.equal(h.steps.some((l) => l.step === "dispatch.lane_refilled"), false);
});

test("W1-T9097: an unreadable reading holds the target and an unreadable mode never enforces", async () => {
  // The mode read throws: the row names it and the governor stays in shadow, so a pressed reading changes nothing.
  const pressed = quiet({ containerPressed: true, containerBaseMib: 20_000 });
  const h = harness({ mode: () => { throw new Error("policy.yaml: bad mode"); }, read: () => pressed, cpuCount: () => 8 });
  await h.bothStarted.promise;
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B", "C"]);
  h.settleA();
  await h.run;
  const rows = laneTargetRows(h.steps);
  assert.deepEqual(rows[0], { mode: "shadow", mode_unread: "policy.yaml: bad mode" });
  assert.equal(rows[1]!.mode, "shadow");

  // The memory read throws: the reading is unread and the target holds at one lane rather than growing.
  const { fake } = ports("enforce", new Error("EACCES: memory.current"));
  const u = harness(fake);
  for (let i = 0; i < 200 && u.started.length === 0; i++) await drainMicrotasks();
  await drainMicrotasks();
  assert.deepEqual(u.started, ["A"], "one lane: the unread reading holds the floor");
  assert.deepEqual(laneTargetRows(u.steps)[0], {
    mode: "enforce", target: 1, fixed: 2, binding: "unread", projection_mib: null, onset_mib: null, in_flight: 0, pressed: false,
    unread: "EACCES: memory.current",
  });
  u.settleA();
  u.release.B.resolve(okResult("B"));
  await u.run;
});

const MIB = 1024 * 1024;
const PSI = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";

/** A /proc and cgroup snapshot: 4 GiB charged, memory.high 8,379 MiB, 8 GB available on the host. */
function hostFiles(over: Record<string, string | undefined> = {}): (path: string) => string {
  const files: Record<string, string | undefined> = {
    "/sys/fs/cgroup/memory.current": String(4096 * MIB),
    "/sys/fs/cgroup/memory.max": String(8379 * MIB),
    "/sys/fs/cgroup/memory.high": String(8379 * MIB),
    "/sys/fs/cgroup/memory.swap.current": "0",
    "/sys/fs/cgroup/memory.stat": `anon ${3000 * MIB}\nfile ${1096 * MIB}\ninactive_file ${96 * MIB}\npswpin 0\n`,
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 7\nmax 0\noom 0\noom_kill 0\n",
    "/sys/fs/cgroup/memory.pressure": PSI,
    "/proc/pressure/memory": PSI,
    "/proc/meminfo": "MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\n",
    ...over,
  };
  return (path) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

test("W1-T9097: the real reading is the shadow budget's projection for a zero-claim build start", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lane-reading-"));
  try {
    const overrides = {
      clock: fixedClock(Date.parse("2026-10-16T00:00:00Z")),
      policy: () => loadHostMemoryBudgetPolicy(),
      readLedger: () => undefined,
      readTail: () => "",
      readHostServe: undefined,
      listStateDir: () => [],
      daemonPid: () => undefined,
      instance: () => "fixture",
      estimate: () => 1400,
      typical: () => 900,
    };
    const reading = readLaneMemory(root, { ...overrides, readFile: hostFiles() });
    assert.equal(reading.containerOnsetMib, 8379);
    assert.equal(typeof reading.containerBaseMib, "number");
    assert.ok(reading.containerBaseMib! >= 4000 && reading.containerBaseMib! < 8379, `base ${reading.containerBaseMib}`);
    assert.equal(typeof reading.hostBaseAvailableMib, "number");
    assert.equal(reading.hostReserveMib, loadHostMemoryBudgetPolicy().hostReserveMib);
    assert.deepEqual([reading.perLaneMib, reading.highEvents, reading.containerPressed, reading.containerArmCounts], [1400, 7, false, true]);
    assert.deepEqual(readdirSync(root), [], "the reading writes nothing: it never trains the shadow budget's store");

    const noHigh = readLaneMemory(root, { ...overrides, readFile: hostFiles({ "/sys/fs/cgroup/memory.events": "low 0\n" }) });
    assert.deepEqual([noHigh.highEvents, noHigh.highEventsUnread], [undefined, "no high line in memory.events"]);
    const noEvents = readLaneMemory(root, { ...overrides, readFile: hostFiles({ "/sys/fs/cgroup/memory.events": undefined }) });
    assert.equal(noEvents.highEventsUnread, "ENOENT: /sys/fs/cgroup/memory.events");

    // The default ports really read this installation's policy, the host and the CPU count.
    const real = defaultLaneGovernorPorts(join(root, "state"));
    assert.equal(real.mode(), "shadow");
    assert.ok(real.cpuCount() >= 1);
    const live = real.read();
    assert.equal(typeof live.perLaneMib, "number");
    assert.equal(typeof live.containerPressed, "boolean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9097: sweep.laneGovernor.mode reads shadow or enforce and refuses anything else", () => {
  assert.equal(parseLaneGovernorMode({}), "shadow", "an absent block reads as shadow");
  assert.equal(parseLaneGovernorMode(undefined), "shadow");
  assert.equal(parseLaneGovernorMode({ laneGovernor: { mode: { value: "enforce", origin: "proposal" } } }), "enforce");
  assert.throws(() => parseLaneGovernorMode({ laneGovernor: "enforce" }), PolicyError);
  assert.throws(() => parseLaneGovernorMode({ laneGovernor: { mode: "enforce" } }), /must be a mapping with 'value'\/'origin'/);
  assert.throws(() => parseLaneGovernorMode({ laneGovernor: { mode: { value: "enforce", origin: "net-new" } } }), /must be "proposal"/);
  assert.throws(() => parseLaneGovernorMode({ laneGovernor: { mode: { value: "on", origin: "proposal" } } }), /accepts only "shadow", "enforce"/);
  assert.equal(loadLaneGovernorMode(), "shadow", "the shipped row is shadow");
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-policy-"));
  try {
    const bad = join(dir, "policy.yaml");
    writeFileSync(bad, "sweep: [unclosed\n");
    assert.throws(() => loadLaneGovernorMode(bad), /not valid YAML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
