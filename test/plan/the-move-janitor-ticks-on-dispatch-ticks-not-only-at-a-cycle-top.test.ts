/**
 * W1-T14584: the move janitor ticks on dispatch ticks, not only at a cycle's top.
 *
 * OBSERVED 2026-11-23: dispatch selection ran 9 times in one daemon process and 5 in the next, yet each process wrote
 * exactly one janitor row, at its first cycle top, and no tick was in flight: the janitor started only at a cycle's
 * top, while selections run on the dispatch tick inside a cycle whose lanes are busy, and a cycle can last hours. The
 * first cycle top after a boot meets source_pending, so a process booting into busy lanes never moved a task.
 * Here the loop is the real runDaemon with one lane held busy; the janitor's ports and the ops read are fakes.
 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { detachedActionInFlight, drainDetachedSweepActions } from "#src/lib/sweep.js";
import type { MoveRun, PlanTaskMover, PlanTaskMovePorts } from "#src/lib/plan-task-move-janitor.js";
import type { RunResult } from "#src/lib/run-result.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

type Json = Record<string, unknown>;
type Row = { step: string; data: Json };
const OPS = "fixture-private/ops";
const PLAN = mergePlanBlobs([{ label: "public", text: "- id: PUBLIC-T1\n  title: public fixture\n  repo: remudero\n  type: implement\n" }]);
const HEALTHY: OpsTaskDispatchRead = { outcome: "selected", publicCommit: "a".repeat(40),
  source: { outcome: "ok", plan: mergePlanBlobs([{ label: "ops", text: "[]\n" }]), opsCommit: "b".repeat(40), identityDigest: "c".repeat(64) } };
const PENDING: OpsTaskDispatchRead = { outcome: "unavailable", reason: "source_pending" };
const NO_IDENTITY: OpsTaskDispatchRead = { outcome: "selected", publicCommit: "a".repeat(40),
  source: { outcome: "ok", plan: mergePlanBlobs([{ label: "ops", text: "[]\n" }]), opsCommit: "b".repeat(40), identityDigest: "not-a-digest" } };
const OFF: OpsTaskDispatchRead = { outcome: "off" };

/** Fake janitor ports: every preview answers copy, every apply opens a new ops pull request, and the last step is
 *  always merged on main, so each tick that is not held applies one step. `park()` holds the next apply. */
function fakeMover() {
  const calls = { switch: 0, apply: 0 };
  let parked: Promise<void> | undefined, entered: (() => void) | undefined;
  let pr = 0;
  const ports: PlanTaskMovePorts = {
    readSwitch: () => { calls.switch++; return { move: { outcome: "on", repository: OPS, checkoutDir: "" }, dispatch: { outcome: "on", repository: OPS, checkoutDir: "" } }; },
    readOpsCatalog: () => "ok",
    readHeads: async ops => ({ ops, publicRepository: "fixture/public", publicCommit: "d".repeat(40), opsCommit: "e".repeat(40), key: `pin-${calls.switch}` }),
    move: async (_pin, apply): Promise<MoveRun> => {
      if (!apply) return { status: 0, out: { step: "copy" } };
      calls.apply++;
      entered?.(); entered = undefined;
      if (parked) await parked;
      return { status: 0, out: { step: "copy", applied: true, id: "W1-T1", repository: OPS, pullRequest: ++pr } };
    },
    readPull: async () => ({ state: "MERGED", mergeCommit: "f".repeat(40) }),
    onMain: async () => true,
  };
  const mover: PlanTaskMover = { ports, memory: {} };
  return {
    mover, calls,
    park: () => {
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const own = new Promise<void>(resolve => { release = resolve; });
      parked = own;
      // Releasing one park never lifts a later one.
      return { started, release: () => { if (parked === own) parked = undefined; release(); } };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const until = async (what: string, ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 2_000 && !ok(); i++) await delay(2);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/** One real daemon run whose single lane stays busy until `finish()`: the cycle top runs once, and every later
 *  janitor start can only come from the in-flight dispatch tick. */
function busyDaemon(mover: PlanTaskMover, reads: ((n: number, plan: Plan) => OpsTaskDispatchRead) | undefined,
  pause: () => string | undefined = () => undefined) {
  const rows: Row[] = [];
  const opsReads: Plan[] = [];
  const lane = deferred<RunResult>();
  let started = 0, stop = false, now = Date.parse("2026-11-23T17:00:00Z");
  const run = runDaemon(PLAN, {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => false, targetRepo: "remudero",
    checkFreshness: () => ({ stale: false }),
    runOne: async () => { started++; return lane.promise; },
    checkPause: pause,
    checkStop: () => (stop ? "fixture stop" : undefined),
    now: () => new Date(now),
    sleep: async () => { now += 60_000; await delay(1); },
    log: (step: string, data: Json = {}) => { rows.push({ step, data }); },
    ...(reads === undefined ? {} : { readOpsTaskDispatch: (plan: Plan) => { opsReads.push(plan); return reads(opsReads.length - 1, plan); } }),
    planTaskMover: mover,
  } as unknown as DaemonDeps, { pollIntervalMs: 5 });
  return {
    rows, opsReads, run,
    started: () => started > 0,
    finish: async () => {
      stop = true;
      lane.resolve({ taskId: "PUBLIC-T1", runId: "PUBLIC-T1", merged: false, verdict: "no_pr", costUsd: 0 });
      await run;
      await drainDetachedSweepActions({ boundMs: 60_000 });
    },
  };
}
const named = (rows: Row[], step: string) => rows.filter(row => row.step === step);
const janitorRows = (rows: Row[]) => rows.filter(row => row.step === "plan.move.janitor_step" || row.step === "plan.move.stand_down");

test("W1-T14584 criterion 1: when the dispatch tick runs and no plan-task-move action is in flight, the daemon starts one janitor tick, not only at a cycle's top", async () => {
  const { mover, calls } = fakeMover();
  const daemon = busyDaemon(mover, () => HEALTHY);
  try {
    await until("the lane to start", daemon.started);
    await until("a janitor tick from a dispatch tick", () => calls.switch >= 3);
    assert.equal(calls.switch >= 3, true, "THE CLAIM: dispatch ticks during one busy cycle start janitor ticks, beyond the cycle top's one");
    assert.equal(janitorRows(daemon.rows).filter(row => row.step === "plan.move.janitor_step").length >= 2, true,
      "each started tick applies its step: the janitor moves on while the lane is busy");
  } finally { await daemon.finish(); }

  // A paused daemon starts no janitor tick from its dispatch tick.
  let paused = false;
  const held = fakeMover();
  const pausedDaemon = busyDaemon(held.mover, () => HEALTHY, () => (paused ? "fixture pause" : undefined));
  try {
    await until("the lane to start", pausedDaemon.started);
    await until("a dispatch-tick janitor tick", () => held.calls.switch >= 2);
    await drainDetachedSweepActions({ boundMs: 60_000 });
    paused = true;
    await delay(20);
    const atPause = held.calls.switch;
    await until("pause_seen on the dispatch heartbeat", () => named(pausedDaemon.rows, "daemon.alive").filter(row => row.data.pause_seen === true).length >= 5);
    assert.equal(held.calls.switch, atPause, "a paused dispatch tick starts no janitor tick");
  } finally { paused = false; await pausedDaemon.finish(); }
});

test("W1-T14584 criterion 2: a janitor tick a dispatch tick starts reads the ops dispatch hold fresh from the cached ops snapshot against the bound plan, with no row and no recorded hold", async () => {
  // The cycle top meets source_pending (as every first cycle after a boot does); the snapshot is healthy after it.
  const { mover, calls } = fakeMover();
  const cleared = busyDaemon(mover, n => (n === 0 ? PENDING : HEALTHY));
  try {
    await until("the lane to start", cleared.started);
    await until("a tick after the hold cleared applies", () => calls.apply >= 1);
    const ticks = janitorRows(cleared.rows);
    assert.deepEqual(ticks[0], { step: "plan.move.stand_down", data: { reason: "ops_dispatch_held", detail: "source_pending" } },
      "sanity: the cycle top's tick stood down on the hold the cycle top recorded");
    assert.equal(ticks.slice(1).some(row => row.step === "plan.move.janitor_step" && row.data.applied === true), true,
      "THE CLAIM: a hold that cleared since the cycle's top reads clear, and the dispatch tick's janitor tick applies");
    assert.equal(cleared.opsReads.length >= 2 && cleared.opsReads.every(plan => plan === PLAN), true,
      "the hold is read through readOpsTaskDispatch against the bound plan");
    assert.deepEqual(named(cleared.rows, "dispatch.ops_catalog_held").map(row => row.data.outcome), ["source_pending"],
      "the cycle top's hold row is the only one");
    assert.deepEqual(named(cleared.rows, "dispatch.ops_catalog_hold_cleared"), [],
      "the dispatch tick's read records nothing: the hold clears in the ledger only at the next cycle top");
  } finally { await cleared.finish(); }

  // The other direction: a hold that appears after a healthy cycle top holds the dispatch tick's janitor tick.
  for (const [name, later, detail] of [["a pending source", PENDING, "source_pending"],
    ["a source with no identity", NO_IDENTITY, "source_identity_unknown"]] as const) {
    const fresh = fakeMover();
    const appeared = busyDaemon(fresh.mover, n => (n === 0 ? HEALTHY : later));
    try {
      await until("the lane to start", appeared.started);
      await until(`a held tick on ${name}`, () => janitorRows(appeared.rows).some(row => row.step === "plan.move.stand_down"));
      const ticks = janitorRows(appeared.rows);
      assert.equal(ticks[0]?.step, "plan.move.janitor_step", `sanity: the healthy cycle top's tick applied (${name})`);
      assert.deepEqual(ticks.find(row => row.step === "plan.move.stand_down"),
        { step: "plan.move.stand_down", data: { reason: "ops_dispatch_held", detail } },
        `THE CLAIM: ${name} read fresh holds the dispatch tick's janitor tick with captureOpsDispatchPlan's own label`);
      assert.deepEqual(named(appeared.rows, "dispatch.ops_catalog_held"), [], `no hold row from the dispatch tick (${name})`);
    } finally { await appeared.finish(); }
  }

  // An ops read that is off holds nothing: the dispatch tick's tick applies, as the cycle top's does.
  const off = fakeMover();
  const offDaemon = busyDaemon(off.mover, () => OFF);
  try {
    await until("the lane to start", offDaemon.started);
    await until("two applied janitor ticks (off)", () => off.calls.apply >= 2);
    assert.deepEqual(janitorRows(offDaemon.rows).slice(0, 2).map(row => row.step), ["plan.move.janitor_step", "plan.move.janitor_step"],
      "an off ops read holds neither start point's tick");
  } finally { await offDaemon.finish(); }
  // An unwired one reads ops_dispatch_unwired from either start point (a repeated stand-down writes no second row).
  const unwired = fakeMover();
  const unwiredDaemon = busyDaemon(unwired.mover, undefined);
  try {
    await until("the lane to start", unwiredDaemon.started);
    await until("dispatch-tick janitor ticks (unwired)", () => unwired.calls.switch >= 3);
    assert.deepEqual(janitorRows(unwiredDaemon.rows), [{ step: "plan.move.stand_down", data: { reason: "ops_dispatch_held", detail: "ops_dispatch_unwired" } }]);
    assert.equal(unwired.calls.apply, 0, "an unwired ops read holds the dispatch tick's ticks too: none applies");
  } finally { await unwiredDaemon.finish(); }
});

test("W1-T14584 criterion 3: invariant:one-tick-in-flight — at most one janitor tick is in flight whichever start point launched it, and W1-T14532's in-flight row is written from either", async () => {
  const { mover, calls, park } = fakeMover();
  const gate = park();
  const daemon = busyDaemon(mover, () => HEALTHY);
  try {
    await until("the lane to start", daemon.started);
    await gate.started;
    assert.equal(detachedActionInFlight("plan-task-move"), true, "sanity: the cycle top's tick is in flight, held in its apply");
    await until("dispatch ticks over the held tick", () => named(daemon.rows, "daemon.alive").length >= 20);
    assert.equal(calls.switch, 1, "THE CLAIM: no dispatch tick starts a second janitor tick while one is in flight");
    const inFlight = named(daemon.rows, "plan.move.tick_in_flight");
    assert.equal(inFlight.length >= 1, true, "THE CLAIM: the dispatch tick writes W1-T14532's in-flight row for the held tick");
    assert.equal(inFlight[0]?.data.phase, "apply", "the row names the phase the held tick waits in");
    assert.equal(Number(inFlight[0]?.data.age_ms) > 0, true, "and its age on the daemon clock");
    assert.equal(inFlight.length <= 2, true, "at most hourly, plus a change of phase, not one per dispatch tick");

    // Released, the next dispatch tick starts exactly one more, and it is again alone.
    const second = park();
    gate.release();
    await second.started;
    assert.equal(calls.switch, 2, "the first dispatch tick after it settles starts exactly one more");
    const alive = named(daemon.rows, "daemon.alive").length;
    await until("more dispatch ticks", () => named(daemon.rows, "daemon.alive").length >= alive + 10);
    assert.equal(calls.switch, 2, "and no third while that one is in flight");
    second.release();
  } finally { gate.release(); await daemon.finish(); }
});
