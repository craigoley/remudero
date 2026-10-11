import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, previousProcessIdleSample, type DaemonDeps } from "../src/lib/daemon.js";
import {
  accountIdleLaneMinutes,
  chargeRestartGap,
  idleLaneCauseForRefillReason,
  idleLaneCauseForStep,
  idleLaneChange,
  newIdleLaneAccount,
  summarizeIdleLaneAccount,
  type IdleLaneAccount,
  type IdleLaneSample,
} from "../src/lib/idle-lane-accounting.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// ── W1-T8235: an idle lane SLOT is charged to the hold that emptied it ─────────────────────
//
// MEASURED 2026-10-11: the hourly rows added up to ~33 idle minutes on a day that lost hundreds. One busy lane
// hid its empty siblings, the daemon sampled once per dispatching tick and then awaited its lanes, and an
// operator pause and a recycle drain shared one `pause` cause.

const MIN = 60_000;
const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";

function fold(samples: IdleLaneSample[]): IdleLaneAccount {
  return samples.reduce(accountIdleLaneMinutes, newIdleLaneAccount(samples[0]!.atMs));
}

test("W1-T8235: two idle lanes beside one busy lane are charged", () => {
  const account = fold([
    { atMs: 0, busyLanes: 1, dispatchable: 4, capacity: 3, cause: "phase_bound" },
    { atMs: 10 * MIN, busyLanes: 1, dispatchable: 4, capacity: 3, cause: "phase_bound" },
  ]);
  const row = summarizeIdleLaneAccount(account, 10 * MIN);
  assert.equal(row.slot_minutes_by_cause.phase_bound, 20, "two empty slots for ten minutes are twenty slot-minutes");
  assert.equal(row.capacity, 3);
  assert.equal(row.idle_minutes, 0, "the legacy figure still means zero builds running");
  // Work bounds the slots: one dispatchable task cannot idle two lanes.
  const bounded = fold([
    { atMs: 0, busyLanes: 1, dispatchable: 1, capacity: 3, cause: "phase_bound" },
    { atMs: 10 * MIN, busyLanes: 1, dispatchable: 1, capacity: 3, cause: "phase_bound" },
  ]);
  assert.equal(summarizeIdleLaneAccount(bounded, 10 * MIN).slot_minutes_by_cause.phase_bound, 10);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const result = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as RunResult;

type Row = { step: string; extra: Record<string, unknown>; atMs: number };

/**
 * 2026-10-11 16:16: three lanes, one worker (A) runs through; B frees at 16:18 and C at 16:24 and the recycle
 * PAUSE holds their refill until A ends at 17:08.
 */
async function recycleDrainReplay(): Promise<Row[]> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-slot-`));
  const path = join(dir, "tasks.yaml");
  const ids = "ABCDEFGH".split("");
  writeFileSync(path, ids.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  const releases = new Map(ids.map((id) => [id, deferred<RunResult>()]));
  const merged = new Set<string>();
  const rows: Row[] = [];
  let nowMs = Date.parse("2026-10-11T16:16:00.000Z");
  let paused: string | undefined;
  let over = false;
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    refreshMerged: () => (id: string) => merged.has(id),
    checkPause: () => paused,
    checkStop: () => (over ? "replay over" : undefined),
    log: (step, extra) => rows.push({ step, extra: extra ?? {}, atMs: nowMs }),
    runOne: async (id) => releases.get(id)!.promise,
    sleep: async () => {
      nowMs += 10 * MIN;
      over = true;
    },
  } as DaemonDeps, { laneCount: 3 });
  const settle = async (id: string, advanceMs: number) => {
    nowMs += advanceMs;
    merged.add(id);
    releases.get(id)!.resolve(result(id));
    await drainMicrotasks();
  };
  try {
    await drainMicrotasks();
    paused = RECYCLE;
    await settle("B", 2 * MIN);
    await settle("C", 6 * MIN);
    await settle("A", 44 * MIN);
    await run;
  } finally {
    over = true;
    for (const [id, release] of releases) release.resolve(result(id));
    await run;
  }
  return rows;
}

test("W1-T8235: a lane freed mid-tick is sampled when it frees", async () => {
  const rows = await recycleDrainReplay();
  const freedAt = Date.parse("2026-10-11T16:18:00.000Z");
  const atFree = rows.filter((r) => r.step === "lane.idle_changed" && r.atMs === freedAt);
  assert.ok(atFree.length > 0, "the lane that freed at 16:18 was sampled at 16:18, inside the dispatching tick's wait");
  assert.equal(atFree.at(-1)!.extra.in_flight, 2, "two lanes are still building");
  assert.equal(atFree.at(-1)!.extra.idle_slots, 1);
  assert.equal(rows.filter((r) => r.step === "daemon.tick" && r.atMs < freedAt + 1).length, 1, "the whole sample sits inside one tick");
});

test("W1-T8235: an operator pause and a recycle drain are different causes", () => {
  assert.equal(idleLaneCauseForStep("daemon.pause", { detail: RECYCLE }), "recycle_drain");
  assert.equal(idleLaneCauseForStep("daemon.pause", { detail: "PAUSE requested: reviewing the plan" }), "operator_pause");
  assert.equal(idleLaneCauseForRefillReason(`fleet PAUSE hold: ${RECYCLE}`), "recycle_drain");
  assert.equal(idleLaneCauseForRefillReason("fleet PAUSE hold: PAUSE requested: reviewing the plan"), "operator_pause");
  assert.equal(idleLaneCauseForRefillReason("pause: PAUSE requested: reviewing the plan"), "operator_pause");

  const hold = { reason: "reviewing the plan", pid: 4242, session_id: "sess-1", actor: "operator" };
  const account = fold([
    { atMs: 0, busyLanes: 0, dispatchable: 3, capacity: 3, cause: "operator_pause", hold },
    { atMs: 10 * MIN, busyLanes: 0, dispatchable: 3, capacity: 3, cause: "recycle_drain" },
    { atMs: 15 * MIN, busyLanes: 3, dispatchable: 3, capacity: 3 },
  ]);
  const row = summarizeIdleLaneAccount(account, 15 * MIN);
  assert.equal(row.slot_minutes_by_cause.operator_pause, 30);
  assert.equal(row.slot_minutes_by_cause.recycle_drain, 15);
  assert.equal(row.slot_minutes_by_cause.pause, 0, "the single `pause` bucket no longer swallows either");
  assert.deepEqual(row.holds.operator_pause, hold, "the row names the PAUSE flag's own record of the hold");
});

test("W1-T8235: a held refill names its phase-bound or stale-code cause", () => {
  assert.equal(idleLaneCauseForRefillReason("phase bound"), "phase_bound");
  assert.equal(idleLaneCauseForRefillReason("stale code"), "freshness_drain");
  assert.equal(idleLaneCauseForRefillReason("stale code (decided while the refill read was in flight)"), "freshness_drain");
  assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "phase bound" }), "phase_bound");
  assert.equal(idleLaneCauseForStep("dispatch.lane_refill_held", { reason: "stale code" }), "freshness_drain");
  assert.equal(idleLaneCauseForStep("dispatch.lane_parked", { reason: "phase bound" }), "phase_bound");
  assert.equal(idleLaneCauseForRefillReason("governor: queue"), "wip_limit");
  assert.equal(idleLaneCauseForRefillReason("refill read failed: boom"), undefined, "an unnamed hold stays unnamed, so it lands in unknown");

  const account = fold([
    { atMs: 0, busyLanes: 1, dispatchable: 3, capacity: 3, cause: idleLaneCauseForRefillReason("phase bound") },
    { atMs: 5 * MIN, busyLanes: 1, dispatchable: 3, capacity: 3, cause: idleLaneCauseForRefillReason("stale code") },
    { atMs: 8 * MIN, busyLanes: 1, dispatchable: 3, capacity: 3, cause: idleLaneCauseForRefillReason("refill read failed: boom") },
    { atMs: 9 * MIN, busyLanes: 3, dispatchable: 3, capacity: 3 },
  ]);
  const row = summarizeIdleLaneAccount(account, 9 * MIN);
  assert.equal(row.slot_minutes_by_cause.phase_bound, 10);
  assert.equal(row.slot_minutes_by_cause.freshness_drain, 6);
  assert.equal(row.slot_minutes_by_cause.unknown, 2, "unknown is kept apart, never folded into a named cause");
});

test("W1-T8235: the gap across a restart is charged to restart", async () => {
  const at = (min: number) => new Date(Date.parse("2026-10-11T10:00:00.000Z") + min * MIN).toISOString();
  const lines = [
    JSON.stringify({ ts: at(-90), step: "lane.idle_changed", cause: "phase_bound", idle_slots: 2, capacity: 3, dispatchable: 5, in_flight: 1, hold: null }),
    JSON.stringify({ ts: at(-30), step: "daemon.tick" }),
    JSON.stringify({ ts: at(-20), step: "daemon.summary" }),
    JSON.stringify({ ts: at(0), step: "daemon.boot" }),
  ];
  const prev = previousProcessIdleSample(lines);
  assert.deepEqual(prev, { atMs: Date.parse(at(-20)), inFlight: 1, capacity: 3, dispatchable: 5, bootMs: Date.parse(at(0)) },
    "the gap starts at the previous process's last sign of life, not at its hours-old transition row");

  const charged = chargeRestartGap(newIdleLaneAccount(prev!.bootMs!), prev!, prev!.bootMs!, false);
  assert.equal(summarizeIdleLaneAccount(charged, prev!.bootMs!).slot_minutes_by_cause.restart, 40, "two empty slots for twenty minutes");
  const gated = chargeRestartGap(newIdleLaneAccount(prev!.bootMs!), prev!, prev!.bootMs!, true);
  const after = accountIdleLaneMinutes(gated, { atMs: prev!.bootMs! + 5 * MIN, busyLanes: 0, dispatchable: 5, capacity: 3 });
  assert.equal(summarizeIdleLaneAccount(after, prev!.bootMs! + 5 * MIN).slot_minutes_by_cause.boot_gate, 10, "once the gate is up the interval is boot_gate");

  // The daemon seeds its account from the ledger union it already reads at boot.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-slot-restart-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n");
  const rows: Row[] = [];
  let nowMs = Date.parse(at(0));
  await runDaemon(loadPlan(path), {
    refreshMerged: () => () => false,
    runOne: async (id: string) => { throw new Error(`unexpected dispatch of ${id}`); },
    now: () => new Date(nowMs),
    sleep: async () => { nowMs += 10 * MIN; },
    readLedgerLines: () => lines,
    checkCostGovernor: (() => { let n = 0; return () => (++n % 2 === 0 ? { deferred: true, observedDayCostUsd: 9, ceilingUsd: 5 } : undefined); })(),
    checkStop: (() => { let n = 0; return () => (++n > 4 ? "done" : undefined); })(),
    log: (step, extra) => rows.push({ step, extra: extra ?? {}, atMs: nowMs }),
  } as DaemonDeps);
  const summary = rows.filter((r) => r.step === "lane.idle_summary").at(-1)!.extra;
  const slots = summary.slot_minutes_by_cause as Record<string, number>;
  assert.equal(slots.restart, 40, "the daemon charged the 20 minutes with no process, at the previous busy count");
});

test("W1-T8235: a hold change writes one lane.idle_changed row", async () => {
  const samples: IdleLaneSample[] = [
    { atMs: 0, busyLanes: 3, dispatchable: 4, capacity: 3 },
    { atMs: 1 * MIN, busyLanes: 2, dispatchable: 4, capacity: 3, cause: "recycle_drain" },
    { atMs: 2 * MIN, busyLanes: 2, dispatchable: 4, capacity: 3, cause: "recycle_drain" },
    { atMs: 3 * MIN, busyLanes: 2, dispatchable: 3, capacity: 3, cause: "recycle_drain" },
    { atMs: 4 * MIN, busyLanes: 1, dispatchable: 3, capacity: 3, cause: "recycle_drain" },
    { atMs: 5 * MIN, busyLanes: 1, dispatchable: 3, capacity: 3, cause: "operator_pause" },
    { atMs: 6 * MIN, busyLanes: 3, dispatchable: 3, capacity: 3 },
  ];
  let account = newIdleLaneAccount(0);
  const changes: Array<ReturnType<typeof idleLaneChange>> = [];
  for (const sample of samples) {
    const next = accountIdleLaneMinutes(account, sample);
    changes.push(idleLaneChange(account, next));
    account = next;
  }
  assert.deepEqual(changes.map((c) => (c === null ? null : [c.cause, c.idle_slots])), [
    null, ["recycle_drain", 1], null, null, ["recycle_drain", 2], ["operator_pause", 2], [null, 0],
  ], "a tick that changes neither cause, idle slots nor hold writes nothing");
  assert.equal(changes[1]!.capacity, 3);
  assert.equal(changes[1]!.dispatchable, 4);

  // And through the daemon: the steady-state ticks of the replay write no extra rows.
  const rows = await recycleDrainReplay();
  const changed = rows.filter((r) => r.step === "lane.idle_changed").map((r) => r.extra);
  for (let i = 1; i < changed.length; i++) {
    assert.notDeepEqual(
      [changed[i]!.cause, changed[i]!.idle_slots, changed[i]!.hold],
      [changed[i - 1]!.cause, changed[i - 1]!.idle_slots, changed[i - 1]!.hold],
      "each row is a change from the one before it",
    );
  }
});

test("W1-T8235: the recycle-drain replay is charged to recycle_drain", async () => {
  const rows = await recycleDrainReplay();
  const summary = rows.filter((r) => r.step === "lane.idle_summary").at(-1);
  assert.ok(summary, "the exit flush wrote the window");
  const slots = summary.extra.slot_minutes_by_cause as Record<string, number>;
  // B and C emptied two lanes behind A for 6 and 44 minutes, then all three lanes sat empty for the 10 minutes
  // after A ended: 1x6 + 2x44 = 94 slot-minutes during the drain, the ~92 the ledger reconstruction measured.
  assert.equal(slots.recycle_drain, 94 + 30, `recycle_drain carries the drain plus the 10 idle minutes of the three empty lanes, got ${JSON.stringify(slots)}`);
  assert.equal(slots.operator_pause, 0);
  assert.equal(summary.extra.capacity, 3);
  const drain = rows.filter((r) => r.step === "lane.idle_changed" && r.extra.cause === "recycle_drain");
  assert.deepEqual(drain.map((r) => r.extra.idle_slots).slice(0, 2), [1, 2], "one empty slot after B, two after C");
  assert.equal(drain[0]!.extra.in_flight, 2);
  const hold = (summary.extra.holds as Record<string, { reason: string }>).recycle_drain;
  assert.match(hold.reason, /container recycle/);
});
