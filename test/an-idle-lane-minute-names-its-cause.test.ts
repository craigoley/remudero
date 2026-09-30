import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDLE_LANE_CAUSES,
  accountIdleLaneMinutes,
  idleLaneCauseForStep,
  newIdleLaneAccount,
  rollIdleLaneWindow,
  summarizeIdleLaneAccount,
  type IdleLaneAccount,
  type IdleLaneSample,
} from "../src/lib/idle-lane-accounting.js";

const MIN = 60_000;

function fold(samples: IdleLaneSample[]): IdleLaneAccount {
  return samples.reduce(accountIdleLaneMinutes, newIdleLaneAccount(samples[0]!.atMs));
}

test("W1-T4837: an empty lane with a dispatchable task names one cause", () => {
  // Ten minutes held by the WIP limit, then five paused, then ten with selection running and finding nothing.
  const account = fold([
    { atMs: 0, busyLanes: 0, dispatchable: 3, cause: "wip_limit" },
    { atMs: 10 * MIN, busyLanes: 0, dispatchable: 3, cause: "pause" },
    { atMs: 15 * MIN, busyLanes: 0, dispatchable: 3, selectionRan: true },
    { atMs: 25 * MIN, busyLanes: 1, dispatchable: 3 },
  ]);
  const row = summarizeIdleLaneAccount(account, 25 * MIN);

  assert.equal(row.minutes_by_cause.wip_limit, 10);
  assert.equal(row.minutes_by_cause.pause, 5);
  assert.equal(row.minutes_by_cause.selection_empty, 10);
  assert.equal(row.largest_cause, "wip_limit");
  // Exactly one cause per minute: the causes partition the idle total, none is counted twice.
  const sum = IDLE_LANE_CAUSES.reduce((n, c) => n + row.minutes_by_cause[c], 0);
  assert.equal(sum, row.idle_minutes);
  assert.equal(row.idle_minutes, 25);
});

test("W1-T4837: minutes with no known cause are reported as unknown", () => {
  const account = fold([
    { atMs: 0, busyLanes: 0, dispatchable: 2, cause: "value_refusal" },
    { atMs: 4 * MIN, busyLanes: 0, dispatchable: 2 }, // idle, work exists, nothing names why
    { atMs: 11 * MIN, busyLanes: 0, dispatchable: 2, cause: "capacity_headroom" },
    { atMs: 13 * MIN, busyLanes: 0, dispatchable: 2 },
  ]);
  const row = summarizeIdleLaneAccount(account, 13 * MIN);

  assert.equal(row.minutes_by_cause.unknown, 7, "the unexplained interval is its own cause");
  assert.equal(row.minutes_by_cause.value_refusal, 4);
  assert.equal(row.minutes_by_cause.capacity_headroom, 2);
  assert.equal(row.minutes_by_cause.selection_empty, 0, "unknown is never folded into a named cause");
  assert.equal(row.largest_cause, "unknown");
});

test("W1-T4837: busy lanes and an empty queue are not idle minutes", () => {
  const account = fold([
    { atMs: 0, busyLanes: 1, dispatchable: 5, cause: "pause" },
    { atMs: 30 * MIN, busyLanes: 0, dispatchable: 0, cause: "pause" },
    { atMs: 60 * MIN, busyLanes: 0, dispatchable: 0 },
  ]);
  const row = summarizeIdleLaneAccount(account, 60 * MIN);
  assert.equal(row.idle_minutes, 0);
  assert.equal(row.largest_cause, null);
});

test("W1-T4837: a clock step backwards charges no negative minutes", () => {
  const account = fold([
    { atMs: 10 * MIN, busyLanes: 0, dispatchable: 1, cause: "pause" },
    { atMs: 5 * MIN, busyLanes: 0, dispatchable: 1, cause: "pause" },
    { atMs: 12 * MIN, busyLanes: 0, dispatchable: 1, cause: "pause" },
  ]);
  const row = summarizeIdleLaneAccount(account, 12 * MIN);
  assert.equal(row.minutes_by_cause.pause, 2);
});

test("W1-T4837: rolling the window keeps the interval in progress", () => {
  const before = fold([{ atMs: 0, busyLanes: 0, dispatchable: 1, cause: "wip_limit" }]);
  const rolled = rollIdleLaneWindow(accountIdleLaneMinutes(before, { atMs: 60 * MIN, busyLanes: 0, dispatchable: 1, cause: "wip_limit" }), 60 * MIN);
  assert.equal(summarizeIdleLaneAccount(rolled, 60 * MIN).idle_minutes, 0);
  const next = accountIdleLaneMinutes(rolled, { atMs: 70 * MIN, busyLanes: 0, dispatchable: 1, cause: "wip_limit" });
  assert.equal(summarizeIdleLaneAccount(next, 70 * MIN).minutes_by_cause.wip_limit, 10);
});

test("W1-T4837: ledger steps map to their cause and unrelated steps to none", () => {
  assert.equal(idleLaneCauseForStep("dispatch.wip_deferred"), "wip_limit");
  assert.equal(idleLaneCauseForStep("daemon.pause"), "pause");
  assert.equal(idleLaneCauseForStep("dispatch.value.refused"), "value_refusal");
  assert.equal(idleLaneCauseForStep("daemon.admission_stood_down"), "claim_race");
  assert.equal(idleLaneCauseForStep("daemon.cost_governor"), "capacity_headroom");
  assert.equal(idleLaneCauseForStep("daemon.tick"), undefined);
});
