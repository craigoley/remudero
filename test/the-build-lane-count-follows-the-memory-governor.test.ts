// W1-T9097 — THE BUILD LANE COUNT FOLLOWS THE MEMORY GOVERNOR, NOT A FIXED NUMBER. `sweep.dispatchLanes` is a fixed 3
// (max 4) that only a plan PR and a restart can change, while ADR 0007 makes each lane cost a whole Node process more.
// `laneTarget` (src/lib/lane-governor.ts) is the largest lane count whose projection fits under the memory onsets;
// these drive it directly and through the REAL runDaemon, with only the worker spawn (`runOne`) and the governor's
// reading faked.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps, type DaemonOpts } from "../src/lib/daemon.js";
import {
  LANE_TARGET_STEP,
  laneArmsFromShadow,
  laneTarget,
  laneTargetRow,
  readLaneGovernor,
  type LaneGovernorReading,
} from "../src/lib/lane-governor.js";
import { laneGovernorModeField, loadPolicy, PolicyError } from "../src/lib/policy.js";
import type { RunResult } from "../src/lib/run-result.js";

function disjointPlan(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-governor-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, ids.map(task).join(""));
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

/** A container arm with room for four lanes (8379 MiB onset, 4000 MiB in flight, 1000 MiB per run tree). */
function reading(pressed: boolean, crossings: number | null = 0): LaneGovernorReading {
  return {
    arms: [{ arm: "container", baseMib: 4000, perLaneMib: 1000, onsetMib: 8379 }],
    pressure: { pressed, crossingsSincePrevious: crossings },
    cpuLanes: 8,
  };
}

type Line = { step: string; extra?: Record<string, unknown> };

function daemon(ids: string[], opts: DaemonOpts, extra: Partial<DaemonDeps> = {}, runOne?: (id: string) => Promise<RunResult>) {
  const steps: Line[] = [];
  const started: string[] = [];
  const run = runDaemon(
    disjointPlan(ids),
    {
      refreshMerged: () => () => false,
      log: (step: string, fields?: Record<string, unknown>) => steps.push({ step, extra: fields }),
      runOne: (id: string) => {
        started.push(id);
        return runOne ? runOne(id) : Promise.resolve(okResult(id));
      },
      sleep: async () => {},
      ...extra,
    } as unknown as DaemonDeps,
    opts,
  );
  return { steps, started, run };
}

const rowsOf = (steps: Line[], step: string) => steps.filter((l) => l.step === step).map((l) => l.extra!);

test("W1-T9097: the lane target shrinks at once and grows one lane per quiet tick", async () => {
  // Pressed at three lanes: one lane goes now, whatever the projection reads.
  const pressed = laneTarget({ reading: reading(true), previousTarget: 3, fixedLanes: 3 });
  assert.equal(pressed.target, 2);
  assert.equal(pressed.binding, "pressure");
  // A memory.high crossing since the previous tick is pressure too.
  assert.equal(laneTarget({ reading: reading(false, 2), previousTarget: 3, fixedLanes: 3 }).target, 2);
  // A projection that fits one lane takes it at once, not one step at a time.
  const tight = laneTarget({
    reading: { ...reading(false), arms: [{ arm: "container", baseMib: 7000, perLaneMib: 1000, onsetMib: 8379 }] },
    previousTarget: 4,
    fixedLanes: 3,
  });
  assert.deepEqual([tight.target, tight.binding, tight.projectionMib, tight.onsetMib], [1, "container", 8000, 8379]);
  // Quiet ticks grow it back one lane each, up to the projection's fit (four lanes), never past it.
  const grown: number[] = [];
  let previous = 1;
  for (let tick = 0; tick < 5; tick++) {
    const decision = laneTarget({ reading: reading(false), previousTarget: previous, fixedLanes: 3 });
    grown.push(decision.target);
    previous = decision.target;
  }
  assert.deepEqual(grown, [2, 3, 4, 4, 4]);
  // A refill's re-read may shrink but never grows.
  assert.equal(laneTarget({ reading: reading(false), previousTarget: 2, fixedLanes: 3, holdGrowth: true }).target, 2);

  // Through the daemon: the fixed count admits three lanes under a pressed container; the enforcing governor two.
  const fixed = daemon(["A", "B", "C"], { max: 3, laneCount: 3 });
  await fixed.run;
  assert.equal((rowsOf(fixed.steps, "dispatch.concurrent_set")[0]!.tasks as string[]).length, 3);
  const governed = daemon(["A", "B", "C"], { max: 3, laneCount: 3, laneGovernorMode: "enforce" }, {
    readLaneGovernor: () => reading(true),
  });
  await governed.run;
  assert.deepEqual(rowsOf(governed.steps, "dispatch.concurrent_set")[0]!.tasks, ["A", "B"]);
  assert.equal(rowsOf(governed.steps, LANE_TARGET_STEP)[0]!.target, 2);
});

test("W1-T9097: shadow ledgers the target and changes nothing", async () => {
  // Four tasks over three lanes, so a freed lane refills: a shadow refill must not consult the target either.
  const plain = daemon(["A", "B", "C", "D"], { max: 4, laneCount: 3 });
  const plainSummary = await plain.run;
  const shadow = daemon(["A", "B", "C", "D"], { max: 4, laneCount: 3, laneGovernorMode: "shadow" }, {
    readLaneGovernor: () => reading(true),
  });
  const shadowSummary = await shadow.run;
  assert.deepEqual(shadow.started, plain.started, "the same tasks start");
  assert.deepEqual(shadow.started, ["A", "B", "C", "D"]);
  assert.deepEqual(rowsOf(shadow.steps, "dispatch.lane_refilled"), rowsOf(plain.steps, "dispatch.lane_refilled"));
  assert.equal(rowsOf(shadow.steps, "dispatch.lane_refilled").length, 1, "D rode a refilled lane");
  assert.deepEqual(rowsOf(shadow.steps, "dispatch.concurrent_set"), rowsOf(plain.steps, "dispatch.concurrent_set"));
  assert.equal(shadowSummary.stopReason, plainSummary.stopReason);
  assert.equal(rowsOf(plain.steps, LANE_TARGET_STEP).length, 0, "no governor wired, no row");
  // One row for the one tick that selected work; its refills read nothing in shadow.
  assert.deepEqual(rowsOf(shadow.steps, LANE_TARGET_STEP), [{
    target: 2, fixed: 3, binding: "pressure", projection_mib: 6000, onset_mib: 8379, pressed: true, previous: null,
    mode: "shadow", at: "tick",
  }]);
});

test("W1-T9097: enforce caps refill and never stops a running lane", async () => {
  let pressed = false;
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>(), C: deferred<RunResult>() };
  const threeStarted = deferred<void>();
  const settled: string[] = [];
  const h = daemon(["A", "B", "C", "D"], { max: 4, laneCount: 3, laneGovernorMode: "enforce" }, {
    readLaneGovernor: () => reading(pressed),
  }, (id) => {
    if (id === "C") threeStarted.resolve();
    const held = release[id as keyof typeof release];
    const done = held ? held.promise : Promise.resolve(okResult(id));
    return done.then((r) => { settled.push(id); return r; });
  });
  await threeStarted.promise;
  assert.deepEqual(h.started, ["A", "B", "C"], "a quiet first tick admits the fixed three");

  pressed = true;
  release.B.resolve(okResult("B"));
  await drainMicrotasks();
  await drainMicrotasks();
  assert.deepEqual(h.started, ["A", "B", "C"], "B's freed lane is held: the target fell to two with two running");
  assert.deepEqual(settled, ["B"], "A and C run on under the lower target");
  const held = rowsOf(h.steps, "dispatch.lane_refill_held");
  assert.equal(held[0]!.reason, "lane target: 2");
  assert.equal(held[0]!.finished_task, "B");

  // The pressure lifts and one more lane frees: a refill never grows the target, but one running lane is under two,
  // so it admits D beside C.
  pressed = false;
  release.A.resolve(okResult("A"));
  await drainMicrotasks();
  await drainMicrotasks();
  assert.deepEqual(h.started, ["A", "B", "C", "D"]);
  assert.ok(!settled.includes("C"), "D was admitted while C still ran");
  release.C.resolve(okResult("C"));
  const summary = await h.run;
  assert.equal(summary.stopReason, "max_reached");
  assert.deepEqual([...settled].sort(), ["A", "B", "C", "D"], "every admitted lane ran to its own end");
  const targets = rowsOf(h.steps, LANE_TARGET_STEP).map((r) => [r.target, r.at]);
  assert.deepEqual(targets.slice(0, 3), [[3, "tick"], [2, "refill"], [2, "refill"]]);
});

test("a throwing governor read is ledgered as unread and holds the previous target", async () => {
  const unread = readLaneGovernor(() => { throw new Error("cgroup gone"); });
  assert.deepEqual(unread, { unread: "lane governor read failed: cgroup gone" });
  const decision = laneTarget({ reading: unread, previousTarget: 2, fixedLanes: 3 });
  assert.deepEqual([decision.target, decision.binding, decision.projectionMib], [2, "unread", null]);
  assert.deepEqual(laneTargetRow(decision, "enforce").unread, ["lane governor read failed: cgroup gone"]);

  const h = daemon(["A", "B"], { max: 2, laneCount: 2, laneGovernorMode: "enforce" }, {
    readLaneGovernor: () => { throw new Error("cgroup gone"); },
  });
  await h.run;
  const row = rowsOf(h.steps, LANE_TARGET_STEP)[0]!;
  assert.deepEqual([row.target, row.binding], [2, "unread"], "at boot it holds the fixed count");
});

test("with no memory arm read the lane target holds rather than growing blind", () => {
  const blind: LaneGovernorReading = { arms: [], unreadArms: ["container: no projection or onset"],
    pressure: { pressed: false, crossingsSincePrevious: null }, cpuLanes: 8 };
  const decision = laneTarget({ reading: blind, previousTarget: 2, fixedLanes: 3 });
  assert.deepEqual([decision.target, decision.binding], [2, "unread"]);
  assert.deepEqual(laneTargetRow(decision, "shadow").unread, ["container: no projection or onset"]);
});

test("the adaptive WIP bound and the CPU count bound the lane target, never a fixed number", () => {
  const wip = laneTarget({ reading: reading(false), previousTarget: 4, fixedLanes: 3, wipBound: 2 });
  assert.deepEqual([wip.target, wip.binding], [2, "wip"]);
  const cpu = laneTarget({ reading: { ...reading(false), cpuLanes: 1 }, previousTarget: 3, fixedLanes: 3 });
  assert.deepEqual([cpu.target, cpu.binding], [1, "cpu"]);
  // Under pressure a bound tighter than the one-lane relief names itself.
  const pressedWip = laneTarget({ reading: reading(true), previousTarget: 4, fixedLanes: 3, wipBound: 1 });
  assert.deepEqual([pressedWip.target, pressedWip.binding], [1, "wip"]);
  // Above the fixed count when memory allows: the fixed number is a seed, not a ceiling.
  const roomy = laneTarget({
    reading: { ...reading(false), arms: [{ arm: "host", baseMib: 0, perLaneMib: 0, onsetMib: 1 }], cpuLanes: 6 },
    previousTarget: 5,
    fixedLanes: 3,
  });
  assert.deepEqual([roomy.target, roomy.binding], [6, "growth-step"]);
  const atCeiling = laneTarget({ reading: { ...reading(false), cpuLanes: 6 }, previousTarget: 4, fixedLanes: 3 });
  assert.deepEqual([atCeiling.target, atCeiling.binding], [4, "container"]);
  // The first tick has no previous one, so it seeds from the fixed count and does not grow.
  const boot = laneTarget({ reading: reading(false), fixedLanes: 3 });
  assert.deepEqual([boot.target, boot.binding, boot.previous], [3, "held", null]);
});

test("the lane arms read the shadow budget's projection and onset", () => {
  const numbers = {
    containerProjectedMib: 6000, containerOnsetMib: 8379, memAvailableMib: 9000, projectedAvailableMib: 7000,
    hostReserveMib: 2048, containerPressed: false, containerSighted: true,
  };
  assert.deepEqual(laneArmsFromShadow(numbers, 1500), {
    arms: [
      { arm: "container", baseMib: 6000, perLaneMib: 1500, onsetMib: 8379 },
      { arm: "host", baseMib: 2000, perLaneMib: 1500, onsetMib: 6952 },
    ],
    unreadArms: [],
    pressed: true,
  });
  const unread = laneArmsFromShadow({ ...numbers, containerOnsetMib: null, memAvailableMib: null, containerSighted: false }, 1500);
  assert.deepEqual(unread, { arms: [], unreadArms: ["container: no projection or onset", "host: MemAvailable unread"], pressed: false });
});

test("sweep.laneGovernor.mode reads shadow by default and refuses anything but shadow or enforce", () => {
  assert.equal(laneGovernorModeField(undefined), "shadow");
  assert.equal(laneGovernorModeField({ mode: { value: "enforce", origin: "proposal" } }), "enforce");
  assert.throws(() => laneGovernorModeField({ mode: { value: "on", origin: "proposal" } }), PolicyError);
  assert.throws(() => laneGovernorModeField({ mode: { value: "shadow" } }), /origin' must be a non-empty string/);
  assert.throws(() => laneGovernorModeField("shadow"), /must be a mapping/);
  assert.equal(loadPolicy("plan/policy.yaml").values.sweep.laneGovernor.mode, "shadow", "the shipped row is shadow");
});

test("a WIP-deferred tick under an enforcing target names the governed width, not the fixed count", async () => {
  let slept = false;
  const h = daemon(["A", "B", "C"], { max: 3, laneCount: 3, wipLimit: 4, laneGovernorMode: "enforce" }, {
    readLaneGovernor: () => reading(true),
    openPrCount: () => 4,
    checkStop: () => (slept ? "operator stop" : undefined),
    sleep: async () => { slept = true; },
  });
  await h.run;
  assert.deepEqual(h.started, [], "no WIP headroom, nothing starts");
  const deferredRow = rowsOf(h.steps, "dispatch.wip_deferred")[0]!;
  assert.deepEqual([deferredRow.lane_count, deferredRow.wip_limit, deferredRow.observed_open_count], [2, 4, 4]);
});
