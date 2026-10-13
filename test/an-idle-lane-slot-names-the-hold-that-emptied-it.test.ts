import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import {
  accountIdleLaneMinutes,
  chargeRestartGap,
  idleLaneCauseForRefillReason,
  idleLaneCauseForStep,
  idleLaneStateChanged,
  idleLaneStateOf,
  lastIdleLaneRecord,
  newIdleLaneAccount,
  summarizeIdleLaneAccount,
  type IdleLaneAccount,
  type IdleLaneSample,
} from "../src/lib/idle-lane-accounting.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// ── W1-T8235: an idle lane SLOT is charged to the hold that emptied it ──────────────────────
//
// W1-T4837's account counted a minute only when ZERO builds ran, sampled once per dispatching tick, and had one
// `pause` cause. On 2026-10-11 it saw about 33 idle minutes on a day whose recycle drain alone left two of three
// lanes empty behind one long worker for 52 minutes. These drive the pure account and the REAL runDaemon.

const MIN = 60_000;
const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";

function fold(samples: IdleLaneSample[]): IdleLaneAccount {
  return samples.reduce(accountIdleLaneMinutes, newIdleLaneAccount(samples[0]!.atMs));
}

test("W1-T8235: two idle lanes beside one busy lane are charged", () => {
  const account = fold([
    { atMs: 0, busyLanes: 1, capacity: 3, dispatchable: 4, cause: "recycle_drain" },
    { atMs: 10 * MIN, busyLanes: 3, capacity: 3, dispatchable: 4 },
  ]);
  const row = summarizeIdleLaneAccount(account, 10 * MIN);
  assert.equal(idleLaneStateOf({ atMs: 0, busyLanes: 1, capacity: 3, dispatchable: 4, cause: "wip_limit" }).idleSlots, 2);
  assert.equal(row.slot_minutes_by_cause.recycle_drain, 20, "two empty slots for ten minutes are twenty slot-minutes");
  assert.equal(row.minutes_by_cause.recycle_drain, 10, "the wall minute keeps its display meaning");
  assert.equal(row.capacity, 3);
  // A busy lane that fills the capacity, or an empty queue, is still not idle.
  assert.equal(idleLaneStateOf({ atMs: 0, busyLanes: 3, capacity: 3, dispatchable: 4 }).cause, null);
  assert.equal(idleLaneStateOf({ atMs: 0, busyLanes: 1, capacity: 3, dispatchable: 0 }).cause, null);
});

// A, B, C start together; PAUSE (the recycle's) is set while all run, B frees at +2 min and C at +8, A ends at +52.
function recycleDrainHarness(pauseDetail: string) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-slot-`));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B") + task("C"));
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const gates = new Map<string, { resolve: (r: RunResult) => void; promise: Promise<RunResult> }>();
  for (const id of ["A", "B", "C"]) {
    let resolve!: (r: RunResult) => void;
    const promise = new Promise<RunResult>((r) => { resolve = r; });
    gates.set(id, { resolve, promise });
  }
  const ok = (id: string): RunResult => ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as unknown as RunResult;
  let nowMs = Date.parse("2026-10-11T16:16:00.000Z");
  const startMs = nowMs;
  let paused: string | undefined;
  let stopped = false;
  const started: string[] = [];
  const run = runDaemon(
    loadPlan(f),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra: extra ?? {} }),
      runOne: (id: string) => { started.push(id); return gates.get(id)!.promise; },
      now: () => new Date(nowMs),
      sleep: async () => {},
      checkPause: () => paused,
      checkStop: () => (stopped ? "operator stop" : undefined),
    } as unknown as DaemonDeps,
    { max: 4, laneCount: 3 },
  );
  return {
    rows, run, startMs,
    allStarted: async () => { while (started.length < 3) await drainMicrotasks(); },
    pause: () => { paused = pauseDetail; },
    advance: (ms: number) => { nowMs += ms; },
    stop: () => { stopped = true; },
    finish: async (id: string) => { gates.get(id)!.resolve(ok(id)); await drainMicrotasks(); await drainMicrotasks(); },
    nowMs: () => nowMs,
  };
}

test("W1-T8235: a lane freed mid-tick is sampled when it frees", async () => {
  const h = recycleDrainHarness(RECYCLE);
  await h.allStarted();
  h.pause();
  h.advance(2 * MIN);
  const freedAt = h.nowMs();
  await h.finish("B");
  // A still runs: the tick has not ended, yet the freed slot is already on the ledger, stamped when it freed.
  const changed = h.rows.filter((r) => r.step === "lane.idle_changed" && r.extra.idle_slots === 1);
  assert.equal(changed.length, 1, "one row for the one idle slot, written before the tick ends");
  assert.equal(changed[0]!.extra.at_ms, freedAt);
  assert.equal(changed[0]!.extra.cause, "recycle_drain");
  assert.equal(changed[0]!.extra.capacity, 3);
  h.advance(50 * MIN);
  await h.finish("C");
  h.stop();
  await h.finish("A");
  await h.run;
});

test("W1-T8235: the recycle-drain replay is charged to recycle_drain", async () => {
  const h = recycleDrainHarness(RECYCLE);
  await h.allStarted();
  h.pause();
  h.advance(2 * MIN);
  await h.finish("B");
  h.advance(6 * MIN);
  await h.finish("C");
  h.advance(44 * MIN);
  h.stop();
  await h.finish("A");
  await h.run;
  const summaries = h.rows.filter((r) => r.step === "lane.idle_summary");
  assert.ok(summaries.length >= 1, "the exit flushes the open window");
  const slot = summaries.reduce((n, r) => n + ((r.extra.slot_minutes_by_cause as Record<string, number>).recycle_drain ?? 0), 0);
  // one empty slot from +2 to +8, two from +8 to +52
  assert.equal(slot, 1 * 6 + 2 * 44);
  const noOperatorPause = summaries.every((r) => (r.extra.slot_minutes_by_cause as Record<string, number>).operator_pause === 0);
  assert.ok(noOperatorPause, "a recycle drain is never charged to an operator's pause");
  const held = summaries.find((r) => (r.extra.holds as Record<string, unknown>).recycle_drain !== undefined);
  assert.ok(held, "the row names the hold behind the cause");
  assert.match(String((held!.extra.holds as Record<string, { reason?: string }>).recycle_drain!.reason), /container recycle/);
});

test("W1-T8235: an operator pause and a recycle drain are different causes", () => {
  assert.equal(idleLaneCauseForStep("daemon.pause", { detail: RECYCLE }), "recycle_drain");
  assert.equal(idleLaneCauseForStep("daemon.pause", { detail: "PAUSE requested: reviewing the budget" }), "operator_pause");
  assert.equal(idleLaneCauseForStep("daemon.pause"), "pause", "a pause that does not say what it is stays the unnamed pause");
  assert.equal(idleLaneCauseForRefillReason(`pause: ${RECYCLE}`), "recycle_drain");
  assert.equal(idleLaneCauseForRefillReason("pause: PAUSE requested: reviewing the budget"), "operator_pause");
  const account = fold([
    { atMs: 0, busyLanes: 0, capacity: 3, dispatchable: 2, cause: "operator_pause" },
    { atMs: 5 * MIN, busyLanes: 1, capacity: 3, dispatchable: 2, cause: "recycle_drain" },
    { atMs: 9 * MIN, busyLanes: 3, capacity: 3, dispatchable: 2 },
  ]);
  const row = summarizeIdleLaneAccount(account, 9 * MIN);
  assert.equal(row.slot_minutes_by_cause.operator_pause, 15);
  assert.equal(row.slot_minutes_by_cause.recycle_drain, 8);
});

test("W1-T8235: a held refill names its phase-bound or stale-code cause", () => {
  assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "phase bound" }), "phase_bound");
  assert.equal(idleLaneCauseForStep("dispatch.lane_parked", { reason: "phase bound" }), "phase_bound");
  assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "stale code" }), "freshness_drain");
  assert.equal(
    idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "stale code (decided while the refill read was in flight)" }),
    "freshness_drain",
  );
  assert.equal(
    idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "fleet PAUSE hold: PAUSE requested: container recycle" }),
    "recycle_drain",
  );
  assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "governor: queue" }), "wip_limit");
  assert.equal(idleLaneCauseForStep("daemon.boot_gate.deferred"), "boot_gate");
  assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "something new" }), undefined, "an unknown reason names nothing");
  const account = fold([
    { atMs: 0, busyLanes: 2, capacity: 3, dispatchable: 1, cause: idleLaneCauseForRefillReason("phase bound") },
    { atMs: 7 * MIN, busyLanes: 1, capacity: 3, dispatchable: 1, cause: idleLaneCauseForRefillReason("stale code") },
    { atMs: 10 * MIN, busyLanes: 3, capacity: 3, dispatchable: 1 },
  ]);
  const row = summarizeIdleLaneAccount(account, 10 * MIN);
  assert.equal(row.slot_minutes_by_cause.phase_bound, 7);
  assert.equal(row.slot_minutes_by_cause.freshness_drain, 6);
});

test("W1-T8235: the gap across a restart is charged to restart", async () => {
  const lastAt = Date.parse("2026-10-11T12:00:00.000Z");
  const previous = JSON.stringify({ step: "lane.idle_changed", at_ms: lastAt, cause: "capacity_headroom", idle_slots: 2, capacity: 3, dispatchable: 2, hold: null });
  const record = lastIdleLaneRecord(["not json", JSON.stringify({ step: "daemon.boot" }), previous, "{torn"]);
  assert.deepEqual(record, { atMs: lastAt, idleSlots: 2, capacity: 3, dispatchable: 2 });
  assert.equal(lastIdleLaneRecord([JSON.stringify({ step: "lane.idle_summary" })]), undefined);
  // The pure fold: ten minutes from the old process's record to the new process's first sample.
  const seeded = chargeRestartGap(newIdleLaneAccount(lastAt + 10 * MIN), record);
  const first = accountIdleLaneMinutes(seeded, { atMs: lastAt + 10 * MIN, busyLanes: 3, capacity: 3, dispatchable: 2 });
  assert.equal(summarizeIdleLaneAccount(first, lastAt + 10 * MIN).slot_minutes_by_cause.restart, 20);
  // The real daemon: boot reads the previous process's row and the first held tick closes the gap.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-slot-restart-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = lastAt + 10 * MIN;
  let sleeps = 0;
  let reads = 0;
  await runDaemon(loadPlan(f), {
    refreshMerged: () => () => false,
    runOne: async (id: string): Promise<RunResult> => { throw new Error(`unexpected dispatch of ${id}`); },
    now: () => new Date(nowMs),
    sleep: async () => { sleeps++; nowMs += 5 * MIN; },
    readLedgerLines: () => [previous],
    checkCostGovernor: () => (++reads % 2 === 0 ? { deferred: true, observedDayCostUsd: 9, ceilingUsd: 5 } : undefined),
    checkStop: () => (sleeps >= 2 ? "operator stop" : undefined),
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra: extra ?? {} }),
  } as unknown as DaemonDeps, { laneCount: 3 });
  const charged = rows.filter((r) => r.step === "lane.idle_summary")
    .reduce((n, r) => n + (r.extra.slot_minutes_by_cause as Record<string, number>).restart, 0);
  assert.equal(charged, 20, "ten minutes at the two slots the previous process left empty");
});

test("W1-T8235: a hold change writes one lane.idle_changed row", async () => {
  const prev = idleLaneStateOf({ atMs: 0, busyLanes: 0, capacity: 3, dispatchable: 2, cause: "wip_limit" });
  assert.equal(idleLaneStateChanged(prev, idleLaneStateOf({ atMs: 1, busyLanes: 0, capacity: 3, dispatchable: 5, cause: "wip_limit" })), false);
  assert.equal(idleLaneStateChanged(prev, idleLaneStateOf({ atMs: 1, busyLanes: 1, capacity: 3, dispatchable: 2, cause: "wip_limit" })), true);
  assert.equal(idleLaneStateChanged(prev, idleLaneStateOf({ atMs: 1, busyLanes: 0, capacity: 3, dispatchable: 2, cause: "governor" })), true);
  assert.equal(idleLaneStateChanged(prev, idleLaneStateOf({ atMs: 1, busyLanes: 0, capacity: 3, dispatchable: 2, cause: "wip_limit", hold: { reason: "x" } })), true);
  // The real daemon: four ticks held by the same governor write one row for the whole hold, not one per tick.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-slot-change-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-10-11T00:00:00.000Z");
  let sleeps = 0;
  let reads = 0;
  await runDaemon(loadPlan(f), {
    refreshMerged: () => () => false,
    runOne: async (id: string): Promise<RunResult> => { throw new Error(`unexpected dispatch of ${id}`); },
    now: () => new Date(nowMs),
    sleep: async () => { sleeps++; nowMs += 5 * MIN; },
    checkCostGovernor: () => (++reads % 2 === 0 ? { deferred: true, observedDayCostUsd: 9, ceilingUsd: 5 } : undefined),
    checkStop: () => (sleeps >= 4 ? "operator stop" : undefined),
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra: extra ?? {} }),
  } as unknown as DaemonDeps, { laneCount: 3 });
  const held = rows.filter((r) => r.step === "daemon.cost_governor").length;
  assert.ok(held >= 3, `the governor held several ticks, got ${held}`);
  const changed = rows.filter((r) => r.step === "lane.idle_changed");
  assert.equal(changed.length, 1, `one transition row for the whole hold, got ${JSON.stringify(changed.map((r) => r.extra))}`);
  assert.equal(changed[0]!.extra.cause, "capacity_headroom");
  assert.equal(changed[0]!.extra.idle_slots, 3);
  assert.equal(changed[0]!.extra.capacity, 3);
  assert.equal(changed[0]!.extra.dispatchable, 1);
  assert.equal(changed[0]!.extra.hold, null);
});
