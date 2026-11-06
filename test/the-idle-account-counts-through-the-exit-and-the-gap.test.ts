import assert from "node:assert/strict";
import { test } from "node:test";
import { runDaemon } from "#src/lib/daemon.js";
import {
  accountIdleLaneMinutes,
  chargeRestartGap,
  lastIdleLaneRecord,
  newIdleLaneAccount,
} from "#src/lib/idle-lane-accounting.js";
import type { Plan, Task } from "#src/lib/plan.js";

const CHANGE = Date.parse("2026-10-14T00:19:14.840Z");
const SAMPLE = Date.parse("2026-10-14T00:23:21.728Z");
const EXIT = Date.parse("2026-10-14T00:49:58.765Z");
const BOOT = Date.parse("2026-10-14T00:50:34.000Z");
const DISPATCH = Date.parse("2026-10-14T00:51:58.000Z");
const MIN = 60_000;
const change = JSON.stringify({
  step: "lane.idle_changed", at_ms: CHANGE, idle_slots: 3, capacity: 3, dispatchable: 1,
});
const exit = JSON.stringify({ step: "lane.idle_summary", window_end_ms: EXIT, partial: true });

function onePlan(): Plan {
  const task: Task = {
    id: "A", title: "a", repo: "remudero", type: "implement", verify: "auto",
    risk: "low", depends_on: [], status: "queued", attempts: 0,
  };
  return { tasks: [task], byId: new Map([[task.id, task]]) };
}

async function replay(start: number, sleepsAt: number[], lines: readonly string[] = [], firstSample = start) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let now = start;
  let sleeps = 0;
  let governorReads = 0;
  const result = await runDaemon(onePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => { throw new Error(`unexpected dispatch: ${id}`); },
    readLedgerLines: () => lines,
    now: () => new Date(now),
    sleep: async () => { now = sleepsAt[sleeps++]!; },
    checkStop: () => {
      if (sleeps >= sleepsAt.length) return "operator stop";
      if (sleeps === 0) now = firstSample;
      return undefined;
    },
    checkQueueGovernor: () => ++governorReads % 2 === 0
      ? { deferred: true, observedOpenCount: 3, wipLimit: 3 } : undefined,
    log: (step, fields) => rows.push({ step, fields: fields ?? {} }),
  }, { laneCount: 3 });
  assert.equal(result.stopReason, "stopped");
  const summaries = rows.filter((row) => row.step === "lane.idle_summary");
  assert.equal(summaries.length, 1);
  return { rows, summary: summaries[0]!.fields };
}

test("W1-T9360: the exit flush charges the open interval to its cause", async () => {
  const { rows, summary } = await replay(CHANGE, [SAMPLE, EXIT]);
  const changes = rows.filter((row) => row.step === "lane.idle_changed");
  assert.equal(changes.length, 1, "the same-state sample does not create another transition");
  assert.equal(changes[0]!.fields.at_ms, CHANGE);
  assert.equal(changes[0]!.fields.cause, "wip_limit");
  assert.equal(summary.window_end_ms, EXIT);
  assert.equal(summary.partial, true);
  assert.equal((summary.minutes_by_cause as Record<string, number>).wip_limit, 30.73);
  assert.equal((summary.slot_minutes_by_cause as Record<string, number>).wip_limit, 92.2);
  assert.equal(summary.idle_minutes, 30.73);
});

test("W1-T9360: the restart charge starts at the old exit and never double-counts", async () => {
  const last = lastIdleLaneRecord([change, exit]);
  assert.deepEqual(last, { atMs: EXIT, idleSlots: 3, capacity: 3, dispatchable: 1 });
  const seeded = chargeRestartGap(newIdleLaneAccount(BOOT), last);
  const first = accountIdleLaneMinutes(seeded, {
    atMs: DISPATCH, busyLanes: 3, capacity: 3, dispatchable: 1,
  });
  assert.equal(first.slotMsByCause.restart, (DISPATCH - EXIT) * 3);
  assert.equal((EXIT - CHANGE) * 3 + first.slotMsByCause.restart, (DISPATCH - CHANGE) * 3);
  const { summary } = await replay(BOOT, [DISPATCH], [change, exit], DISPATCH);
  assert.equal((summary.slot_minutes_by_cause as Record<string, number>).restart, 5.96);
});

test("W1-T9360: no exit summary falls back to the last change row", () => {
  const latest = { step: "lane.idle_changed", at_ms: SAMPLE, idle_slots: 2, capacity: 3, dispatchable: 1 };
  const last = lastIdleLaneRecord([change, JSON.stringify(latest)]);
  assert.deepEqual(last, { atMs: SAMPLE, idleSlots: 2, capacity: 3, dispatchable: 1 });
  const first = accountIdleLaneMinutes(chargeRestartGap(newIdleLaneAccount(BOOT), last), {
    atMs: DISPATCH, busyLanes: 3, capacity: 3, dispatchable: 1,
  });
  assert.equal(first.slotMsByCause.restart / MIN, (DISPATCH - SAMPLE) * 2 / MIN);
});

test("W1-T9360: invalid summaries are skipped and older summaries cannot move the anchor back", () => {
  const invalid = [
    '{"step":"lane.idle_summary",',
    JSON.stringify({ step: "lane.idle_summary", window_end_ms: "yesterday" }),
    JSON.stringify({ step: "lane.idle_summary", ts: new Date(EXIT).toISOString() }),
    JSON.stringify({ step: "other", detail: "lane.idle_summary", window_end_ms: DISPATCH }),
  ];
  assert.equal(lastIdleLaneRecord([change, ...invalid])!.atMs, CHANGE);
  const older = JSON.stringify({ step: "lane.idle_summary", window_end_ms: CHANGE - MIN });
  assert.equal(lastIdleLaneRecord([older, change])!.atMs, CHANGE);
  assert.equal(lastIdleLaneRecord([change, exit, ...invalid])!.atMs, EXIT);
  assert.equal(lastIdleLaneRecord([exit]), undefined, "a summary cannot invent the last lane state");
});

test("W1-T9360: a later busy change prevents a stale idle summary from charging restart", () => {
  const busy = JSON.stringify({ step: "lane.idle_changed", at_ms: BOOT, idle_slots: 0, dispatchable: 1 });
  const last = lastIdleLaneRecord([change, exit, busy]);
  assert.equal(last!.atMs, BOOT);
  const account = newIdleLaneAccount(BOOT);
  assert.equal(chargeRestartGap(account, last), account);
});
