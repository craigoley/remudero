/**
 * W1-T14532: the two states a stalled catalog mover could be in each write a row. A cycle that clears the ops dispatch
 * hold the previous cycle held writes dispatch.ops_catalog_hold_cleared; a cycle that skips the move tick because an
 * earlier one never settled writes plan.move.tick_in_flight with its age, at most once an hour. The janitor's ports are
 * fakes; the loop is the real runDaemon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { drainDetachedSweepActions } from "#src/lib/sweep.js";
import type { MoveRun, PlanTaskMover, PlanTaskMovePorts } from "#src/lib/plan-task-move-janitor.js";

type Json = Record<string, unknown>;
type Row = { step: string; data: Json };
const OPS = "fixture-private/ops";
const PLAN = mergePlanBlobs([{ label: "public", text: "- id: PUBLIC-T1\n  title: public fixture\n  repo: remudero\n  type: implement\n" }]);
const HEALTHY: OpsTaskDispatchRead = { outcome: "selected", publicCommit: "a".repeat(40),
  source: { outcome: "ok", plan: mergePlanBlobs([{ label: "ops", text: "[]\n" }]), opsCommit: "b".repeat(40), identityDigest: "c".repeat(64) } };
const PENDING: OpsTaskDispatchRead = { outcome: "unavailable", reason: "source_pending" };

/** Fake janitor ports: every preview answers copy, every apply opens ops pull request 7, unless `hold` parks it. */
function fakeMover(): { mover: PlanTaskMover; applies: () => number; park(): () => void } {
  let applies = 0;
  let parked: Promise<void> | undefined;
  const ports: PlanTaskMovePorts = {
    readSwitch: () => ({ move: { outcome: "on", repository: OPS, checkoutDir: "" }, dispatch: { outcome: "on", repository: OPS, checkoutDir: "" } }),
    readOpsCatalog: () => "ok",
    readHeads: async ops => ({ ops, publicRepository: "fixture/public", publicCommit: "d".repeat(40), opsCommit: "e".repeat(40), key: "pin" }),
    move: async (_pin, apply): Promise<MoveRun> => {
      if (!apply) return { status: 0, out: { step: "copy" } };
      applies++;
      if (parked) await parked;
      return { status: 0, out: { step: "copy", applied: true, id: "W1-T1", repository: OPS, pullRequest: 7 } };
    },
    readPull: async () => ({ state: "OPEN" }),
    onMain: async () => false,
  };
  return {
    mover: { ports, memory: {} }, applies: () => applies,
    park: () => { let release!: () => void; parked = new Promise<void>(resolve => { release = resolve; }); return () => { parked = undefined; release(); }; },
  };
}

/** `cycles` iterations of the real loop; `reads` answers the ops dispatch read per cycle, and `clock` drives deps.now. */
async function iterate(mover: PlanTaskMover, cycles: number, reads: (cycle: number) => OpsTaskDispatchRead,
  clock: { now: number } = { now: Date.parse("2026-11-23T17:00:00Z") }, stepMs = 0): Promise<Row[]> {
  const rows: Row[] = [];
  let cycle = 0, read = 0;
  await runDaemon(PLAN, {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => true, targetRepo: "remudero",
    runOne: async (id: string) => ({ taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }),
    checkPause: () => undefined,
    checkStop: () => { if (++cycle > cycles) return "fixture stop"; clock.now += stepMs; return undefined; },
    now: () => new Date(clock.now),
    sleep: async () => {}, log: (step: string, data: Json = {}) => { rows.push({ step, data }); },
    readOpsTaskDispatch: () => reads(read++),
    planTaskMover: mover,
  } as unknown as DaemonDeps);
  return rows;
}
const named = (rows: Row[], step: string) => rows.filter(row => row.step === step);

test("W1-T14532 a cleared ops dispatch hold writes one row naming the hold it clears", async () => {
  const { mover, applies } = fakeMover();
  const rows = await iterate(mover, 4, n => (n === 0 ? PENDING : HEALTHY));
  await drainDetachedSweepActions({ boundMs: 60_000 });
  assert.deepEqual(named(rows, "dispatch.ops_catalog_held").map(row => row.data.outcome), ["source_pending"]);
  assert.deepEqual(named(rows, "dispatch.ops_catalog_hold_cleared").map(row => row.data), [{ outcome: "source_pending" }],
    "THE CLAIM: the cycle that composes again names the hold it cleared, once");
  // The janitor saw the hold on its first tick and applies once it clears: the row describes a real transition.
  const later = await iterate(mover, 2, () => HEALTHY);
  await drainDetachedSweepActions({ boundMs: 60_000 });
  assert.equal(applies() >= 1, true, "a tick after the hold cleared applied a step");
  assert.deepEqual(named(later, "dispatch.ops_catalog_hold_cleared"), [], "a cycle that held nothing before writes none");
});

test("W1-T14532 a move tick skipped while one is in flight writes one row per hour with its age", async () => {
  const { mover, park } = fakeMover();
  const release = park();
  const clock = { now: Date.parse("2026-11-23T17:00:00Z") };
  // Ten-minute cycles: the first launches the tick (parked in its apply), the next skip it.
  const rows = await iterate(mover, 9, () => HEALTHY, clock, 10 * 60_000);
  const inFlight = named(rows, "plan.move.tick_in_flight");
  assert.equal(inFlight.length, 2, "THE CLAIM: eight skipped cycles across 80 minutes write two rows, an hour apart");
  const ages = inFlight.map(row => Number(row.data.age_ms));
  assert.equal(ages[0]! > 0, true, "the first row names the unsettled tick's age");
  assert.equal(ages[1]! - ages[0]! >= 60 * 60_000, true, "the second comes an hour after the first");
  release();
  await drainDetachedSweepActions({ boundMs: 60_000 });
  const after = await iterate(mover, 1, () => HEALTHY, clock, 10 * 60_000);
  await drainDetachedSweepActions({ boundMs: 60_000 });
  assert.deepEqual(named(after, "plan.move.tick_in_flight"), [], "a cycle with no tick in flight launches one and writes none");
});
