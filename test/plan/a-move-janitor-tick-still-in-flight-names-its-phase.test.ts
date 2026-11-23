/**
 * W1-T14536: a move janitor tick still in flight names its phase.
 *
 * OBSERVED 2026-11-23: each daemon process wrote exactly one janitor row and then nothing for hours, with no mover
 * child running, although every path past that gate writes a row. The daemon skips the janitor while the
 * plan-task-move action is in flight; W1-T14532 made that skip write plan.move.tick_in_flight with the tick's age at
 * most hourly, and this names the phase the tick waits in, with one more row per change of phase. Here the janitor's
 * ports are fakes that hold each awaited read until the suite releases it, and the real daemon loop runs.
 */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { DECISION_RELEVANT_LEDGER_STEPS, ledgerExceedsRotationCeiling, rotateLedger } from "#src/lib/ledger.js";
import { readReleaseLedgerLines } from "#src/lib/operator-release.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { detachedActionInFlight, drainDetachedSweepActions } from "#src/lib/sweep.js";
import * as janitor from "#src/lib/plan-task-move-janitor.js";
import type { MovePin, MoveRun, MoverPull, PlanTaskMover, PlanTaskMovePorts, PlanTaskMoveSwitch } from "#src/lib/plan-task-move-janitor.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Json = Record<string, unknown>;
type Row = { step: string; data: Json };
type Phase = "heads" | "last_step" | "dry_run" | "apply";
const PUBLIC = "acme/remudero", OPS = "acme/remudero-ops";
const ON: PlanTaskMoveSwitch = { move: { outcome: "on", repository: OPS, checkoutDir: "/ops" }, dispatch: { outcome: "on", repository: OPS, checkoutDir: "/ops" } };
/** Read at call time: on a tree without the helper this throws, and only the claims that need it read red. */
const tickPhase = (mover: PlanTaskMover) =>
  ((janitor as Record<string, unknown>).planTaskMoveTickPhase as typeof janitor.planTaskMoveTickPhase)(mover);
const HOUR = 60 * 60_000;

interface Gate { entered: Promise<void>; release(): void }
interface Fake {
  mover: PlanTaskMover;
  calls: { switch: number; heads: number; pulls: number; dry: number; apply: number };
  /** The mover's memory.inFlight as each port saw it when it was called. */
  seen: Array<[string, unknown]>;
  /** Hold the next call of that port at its start until released. */
  hold(phase: Phase): Gate;
}

/** The janitor over fake ports that answer a converged copy: heads, the last step merged and landed, a copy preview, an
 *  applied step. Each heads read is a new pin, so a dry-run answer is never kept between ticks. */
function fakeMover(over: Partial<PlanTaskMovePorts> = {}): Fake {
  const calls = { switch: 0, heads: 0, pulls: 0, dry: 0, apply: 0 };
  const seen: Array<[string, unknown]> = [];
  const gates = new Map<Phase, { gate: Promise<void>; enter: () => void }>();
  const pass = async (phase: Phase) => {
    const held = gates.get(phase);
    if (!held) return;
    gates.delete(phase);
    held.enter();
    await held.gate;
  };
  let mover!: PlanTaskMover;
  const look = (port: string) => { const f = mover.memory.inFlight; seen.push([port, f === undefined ? undefined : { phase: f.phase, startedAtMs: f.startedAtMs }]); };
  let heads = 0, pr = 100;
  const ports: PlanTaskMovePorts = {
    readSwitch: () => { calls.switch++; look("readSwitch"); return ON; },
    readOpsCatalog: () => "ok",
    readHeads: async ops => { calls.heads++; look("readHeads"); await pass("heads");
      return { ops, publicRepository: PUBLIC, publicCommit: "a".repeat(40), opsCommit: "b".repeat(40), key: `pin-${++heads}` } satisfies MovePin; },
    readPull: async (): Promise<MoverPull> => { calls.pulls++; look("readPull"); await pass("last_step"); return { state: "MERGED", mergeCommit: "c".repeat(40) }; },
    onMain: async () => { look("onMain"); return true; },
    move: async (_pin, apply): Promise<MoveRun> => {
      if (apply) { calls.apply++; look("apply"); await pass("apply"); return { status: 0, out: { step: "copy", applied: true, repository: OPS, pullRequest: ++pr, id: "W1-T1" } }; }
      calls.dry++; look("dry"); await pass("dry_run"); return { status: 0, out: { step: "copy" } };
    },
    ...over,
  };
  mover = { ports, memory: {} };
  return {
    mover, calls, seen,
    hold: phase => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      gates.set(phase, { gate, enter });
      return { entered, release };
    },
  };
}

const inFlight = (mover: PlanTaskMover) => {
  const f = mover.memory.inFlight;
  return f === undefined ? undefined : { phase: f.phase, startedAtMs: f.startedAtMs };
};
const tick = (mover: PlanTaskMover, rows: Row[], startedAtMs?: number, opsDispatchHold?: string) =>
  janitor.runPlanTaskMoveTick({ opsDispatchHold, log: (step, data) => { rows.push({ step, data }); },
    ...(startedAtMs === undefined ? {} : { startedAtMs }) } as Parameters<typeof janitor.runPlanTaskMoveTick>[0], mover);

const PLAN = mergePlanBlobs([{ label: "public", text: "- id: PUBLIC-T1\n  title: public fixture\n  repo: remudero\n  type: implement\n" }]);
/** `ticks` iterations of the real daemon loop with the janitor wired, every other rung idle, on the daemon clock `now`. */
async function daemonIterations(mover: PlanTaskMover, ticks: number, nowMs: number): Promise<Row[]> {
  const rows: Row[] = [];
  let count = 0;
  await runDaemon(PLAN, {
    ...hostIndependentDaemonDeps(), now: () => new Date(nowMs),
    refreshMerged: () => () => true, targetRepo: "remudero",
    runOne: async (id: string) => ({ taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }),
    checkPause: () => undefined, checkStop: () => (++count > ticks ? "fixture stop" : undefined),
    sleep: async () => {}, log: (step: string, data: Json = {}) => { rows.push({ step, data }); },
    planTaskMover: mover,
  } as unknown as DaemonDeps);
  return rows;
}
const inFlightRows = (rows: Row[]) => rows.filter(row => row.step === "plan.move.tick_in_flight").map(row => row.data);
const T0 = Date.UTC(2030, 0, 2);

test("W1-T14536 criterion 1: runPlanTaskMoveTick records the phase it is in (switch, heads, last_step, dry_run, apply) and the time the tick started, and clears both when the tick settles", async () => {
  const fake = fakeMover();
  fake.mover.memory.lastStep = { side: "ops", number: 9 };
  const gates = { heads: fake.hold("heads"), last_step: fake.hold("last_step"), dry_run: fake.hold("dry_run"), apply: fake.hold("apply") };
  const rows: Row[] = [];
  const running = tick(fake.mover, rows, T0);
  for (const phase of ["heads", "last_step", "dry_run", "apply"] as const) {
    await gates[phase].entered;
    assert.deepEqual(inFlight(fake.mover), { phase, startedAtMs: T0 }, `THE CLAIM: a tick awaiting its ${phase} port names that phase and its start`);
    gates[phase].release();
  }
  assert.deepEqual(await running, { outcome: "step", step: "copy" });
  assert.equal(fake.mover.memory.inFlight, undefined, "a settled tick leaves no phase and no start behind");
  assert.deepEqual(fake.seen, [
    ["readSwitch", { phase: "switch", startedAtMs: T0 }], ["readHeads", { phase: "heads", startedAtMs: T0 }],
    ["readPull", { phase: "last_step", startedAtMs: T0 }], ["onMain", { phase: "last_step", startedAtMs: T0 }],
    ["dry", { phase: "dry_run", startedAtMs: T0 }], ["apply", { phase: "apply", startedAtMs: T0 }],
  ], "each port is called with its own phase already recorded");

  // A tick that fails, or stands down at a gate, settles the same way.
  const failing = fakeMover({ readHeads: async () => { throw new Error("ls_remote_unreadable"); } });
  assert.deepEqual(await tick(failing.mover, [], T0), { outcome: "stand_down", reason: "heads_unreadable", detail: "ls_remote_unreadable" });
  assert.equal(failing.mover.memory.inFlight, undefined);
  const thrown = fakeMover({ readSwitch: () => { throw new Error("EACCES"); } });
  assert.deepEqual(await tick(thrown.mover, [], T0), { outcome: "stand_down", reason: "tick_failed", detail: "EACCES" });
  assert.equal(thrown.mover.memory.inFlight, undefined, "even a tick whose first read throws clears its phase");

  // A caller that names no start (the janitor's own suites) still records the phase.
  const unstarted = fakeMover();
  const gate = unstarted.hold("heads");
  const pending = tick(unstarted.mover, []);
  await gate.entered;
  assert.deepEqual(inFlight(unstarted.mover), { phase: "heads", startedAtMs: undefined });
  gate.release();
  await pending;
  assert.equal(unstarted.mover.memory.inFlight, undefined);
});

/** One real daemon run whose clock and held ports the suite moves between cycles: `between[i]` runs in the loop's
 *  sleep after cycle i and returns the clock the next cycle reads; the cycle after the last one stops the run. */
async function scriptedDaemon(mover: PlanTaskMover, between: Array<() => Promise<number>>): Promise<Row[]> {
  const rows: Row[] = [];
  let nowMs = T0, next = 0;
  await runDaemon(PLAN, {
    ...hostIndependentDaemonDeps(), now: () => new Date(nowMs),
    refreshMerged: () => () => true, targetRepo: "remudero",
    runOne: async (id: string) => ({ taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }),
    checkPause: () => undefined, checkStop: () => (next >= between.length ? "fixture stop" : undefined),
    sleep: async () => { if (next < between.length) nowMs = await between[next++]!(); },
    log: (step: string, data: Json = {}) => { rows.push({ step, data }); },
    planTaskMover: mover,
  } as unknown as DaemonDeps);
  return rows;
}

test("W1-T14536 criterion 2: the plan.move.tick_in_flight row W1-T14532 writes for a tick still in flight also names its phase, and a phase change writes one more row besides W1-T14532's hourly row", async () => {
  const fake = fakeMover();
  fake.mover.memory.lastStep = { side: "ops", number: 9 };
  const heads = fake.hold("heads"), lastStep = fake.hold("last_step");
  let again: Gate | undefined;
  const RESTART = T0 + 2 * HOUR;
  try {
    const rows = await scriptedDaemon(fake.mover, [
      // Cycle 1 at T0 started the tick; it waits on its heads read.
      async () => { await heads.entered; assert.equal(detachedActionInFlight("plan-task-move"), true, "sanity: the tick is in flight"); return T0 + 5_000; },
      async () => T0 + 5_000,
      async () => T0 + 60_000,
      // Three cycles skipped it on its heads read; now it moves on and waits on its last step's pull request.
      async () => { heads.release(); await lastStep.entered; return T0 + 61_000; },
      async () => T0 + 61_000,
      async () => T0 + 61_000 + HOUR,
      // The tick settles; the next cycle starts a new one, which waits on its heads read again.
      async () => { again = fake.hold("heads"); lastStep.release(); await drainDetachedSweepActions({ boundMs: 60_000 }); return RESTART; },
      async () => { await again!.entered; return RESTART + 2_500; },
      async () => RESTART + 2_500,
    ]);
    assert.deepEqual(inFlightRows(rows), [
      { phase: "heads", age_ms: 5_000 },
      { phase: "last_step", age_ms: 61_000 },
      { phase: "last_step", age_ms: 61_000 + HOUR },
      { phase: "heads", age_ms: 2_500 },
    ], "THE CLAIM: each row names the phase; three skips on the heads read write one row, the change to last_step one more " +
      "well inside the hour, the unchanged phase W1-T14532's hourly row, and a new tick its own row with its own age");
  } finally {
    heads.release(); lastStep.release(); again?.release();
    await drainDetachedSweepActions({ boundMs: 60_000 });
  }

  // The phase the row reads: none once nothing is in flight, else the phase the tick recorded.
  const idle = fakeMover();
  assert.equal(tickPhase(idle.mover), undefined);
  idle.mover.memory.inFlight = { phase: "dry_run" };
  assert.equal(tickPhase(idle.mover), "dry_run");
});

test("W1-T14536 criterion 3: plan.move.tick_in_flight joins DECISION_RELEVANT_LEDGER_STEPS beside the other plan.move steps, so compaction keeps it, and leaves the write-only baseline", t => {
  for (const step of ["plan.move.janitor_step", "plan.move.stand_down", "plan.move.step", "plan.move.tick_in_flight"]) {
    assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has(step), true, `THE CLAIM: ${step} is a retained step`);
  }
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "write-only-ledger-step-baseline.json"), "utf8")) as
    { writeOnly: string[]; recordOnly: Record<string, string> };
  assert.ok(baseline.writeOnly.length > 0 && Object.keys(baseline.recordOnly).length > 0, "sanity: the write-only baseline was read");
  assert.equal(baseline.writeOnly.includes("plan.move.tick_in_flight"), false, "a retained step is not listed write-only");
  assert.equal(Object.hasOwn(baseline.recordOnly, "plan.move.tick_in_flight"), false,
    "THE CLAIM: and it leaves the recordOnly list W1-T14532 put it in, since compaction now keeps it for its readers");

  // A real rotation over a real ledger file keeps the row live, whole.
  const TS = new Date(T0 - 24 * 3_600_000).toISOString();
  const kept = { ts: TS, run_id: "daemon", task_id: "DAEMON", step: "plan.move.tick_in_flight", phase: "heads", age_ms: 5_000 };
  const { path } = writeLedger([kept], { scope: t });
  appendFileSync(path, Array.from({ length: 400 }, (_, i) => JSON.stringify({ ts: TS, run_id: `noise-${i}`, task_id: "DAEMON", step: "ci.polling", i }) + "\n").join(""));
  const ceilingBytes = Math.floor(readFileSync(path).length / 2);
  assert.ok(ledgerExceedsRotationCeiling(path, ceilingBytes), "sanity: the ledger is over its ceiling");
  assert.equal(rotateLedger(path, { ceilingBytes, now: () => new Date(T0) }).rotated, true, "sanity: the rotation ran");
  const live = readReleaseLedgerLines(path).map(row => JSON.parse(row) as Json);
  assert.ok(live.filter(row => row.step === "ci.polling").length < 50, "sanity: the rotation archived the noise");
  assert.deepEqual(live.filter(row => row.step === "plan.move.tick_in_flight"), [kept], "the in-flight row is still live, whole");
});

test("W1-T14536 criterion 4: invariant:one-tick-in-flight — the daemon still starts at most one tick at a time, and a tick's own decisions and rows are exactly as on origin/main", async () => {
  // At most one tick: iterations over a held tick start none, and the first iteration after it settles starts one.
  const fake = fakeMover();
  const heads = fake.hold("heads");
  try {
    await daemonIterations(fake.mover, 1, T0);
    await heads.entered;
    await daemonIterations(fake.mover, 4, T0 + 1_000);
    assert.equal(fake.calls.switch, 1, "THE CLAIM: no second tick starts while one is in flight");
    heads.release();
    await drainDetachedSweepActions({ boundMs: 60_000 });
    await daemonIterations(fake.mover, 1, T0 + 2_000);
    await drainDetachedSweepActions({ boundMs: 60_000 });
    assert.equal(fake.calls.switch, 2, "the first iteration after it settles starts exactly one");
  } finally { heads.release(); await drainDetachedSweepActions({ boundMs: 60_000 }); }

  // A tick's own decisions and rows, with its phase read at every step the way the daemon's row reads it, are those of
  // origin/main's tick.
  const scenarios: Array<{ name: string; over: Partial<PlanTaskMovePorts>; lastStep?: boolean; hold?: string;
    outcome: Json; rows: Row[]; calls: Fake["calls"] }> = [
    { name: "a converged copy", over: {}, lastStep: true, outcome: { outcome: "step", step: "copy" },
      rows: [{ step: "plan.move.janitor_step", data: { move_step: "copy", applied: true, task_id: "W1-T1", side: "ops", pull_request: 101, exit: 0 } }],
      calls: { switch: 1, heads: 1, pulls: 1, dry: 1, apply: 1 } },
    { name: "a held ops dispatch", over: {}, hold: "ops_paused", outcome: { outcome: "stand_down", reason: "ops_dispatch_held", detail: "ops_paused" },
      rows: [{ step: "plan.move.stand_down", data: { reason: "ops_dispatch_held", detail: "ops_paused" } }],
      calls: { switch: 1, heads: 1, pulls: 0, dry: 1, apply: 0 } },
    { name: "an open last step", over: { readPull: async () => ({ state: "OPEN" }) }, lastStep: true, outcome: { outcome: "stand_down", reason: "mover_pull_request_open" },
      rows: [{ step: "plan.move.stand_down", data: { reason: "mover_pull_request_open" } }],
      calls: { switch: 1, heads: 1, pulls: 0, dry: 0, apply: 0 } },
    { name: "nothing to move", over: { move: async () => ({ status: 0, out: { step: "none" } }) }, outcome: { outcome: "stand_down", reason: "nothing_to_move" },
      rows: [{ step: "plan.move.stand_down", data: { reason: "nothing_to_move" } }],
      calls: { switch: 1, heads: 1, pulls: 0, dry: 0, apply: 0 } },
  ];
  for (const scenario of scenarios) {
    for (const noted of [false, true]) {
      const run = fakeMover(scenario.over);
      if (scenario.lastStep) run.mover.memory.lastStep = { side: "ops", number: 9 };
      const rows: Row[] = [];
      const phases: unknown[] = [];
      const pending = tick(run.mover, rows, T0, scenario.hold);
      if (noted) for (let i = 0; i < 6; i++) { phases.push(tickPhase(run.mover)); await Promise.resolve(); }
      assert.deepEqual(await pending, scenario.outcome, `${scenario.name}${noted ? ", noted" : ""}: the tick decides as on origin/main`);
      assert.deepEqual(rows, scenario.rows, `${scenario.name}${noted ? ", noted" : ""}: the tick writes its own rows as on origin/main`);
      assert.deepEqual(run.calls, scenario.calls, `${scenario.name}${noted ? ", noted" : ""}: the tick reads the same ports`);
      if (noted) assert.ok(phases.some(phase => phase !== undefined), `sanity: ${scenario.name} was read while in flight`);
    }
  }
});
