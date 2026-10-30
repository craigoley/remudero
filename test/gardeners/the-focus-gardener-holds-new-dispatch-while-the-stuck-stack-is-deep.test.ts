import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  FOCUS_DWELL_MS, FOCUS_ENTERED_STEP, FOCUS_EXITED_STEP, FOCUS_FILE, FOCUS_FLAG_FAILED_STEP, FOCUS_OWNER,
  FOCUS_RELEASED_STEP, decideFocus, focusBounds, focusGateFor, readFocusFlag,
} from "#src/lib/focus-gardener.js";
import type { QueueGovernorResult } from "#src/lib/sweep.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { withTempDir } from "#src/lib/tmp.js";

const BASE = 10;
const MIN = 60_000;

function reading(stuck: number, deferred = false): QueueGovernorResult {
  return { deferred, observedOpenCount: 20, wipLimit: 30, baseWipLimit: BASE, stuckOwnedCount: stuck, tier: deferred ? "growing" : "under_limit" };
}

/** A queue gate whose next consultation admits or defers the reading it is given. */
function fakeGate() {
  let next: QueueGovernorResult | undefined;
  let admission: QueueGovernorResult | undefined;
  const gate = (): QueueGovernorResult | undefined => {
    const r = next;
    admission = r && !r.deferred ? r : undefined;
    return r?.deferred ? r : undefined;
  };
  return { gate: Object.assign(gate, { readAdmission: () => admission }), set: (r: QueueGovernorResult | undefined) => { next = r; } };
}

function harness(dir: string, startMs = Date.parse("2026-10-30T15:00:00Z")) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let nowMs = startMs;
  const inner = fakeGate();
  const gate = focusGateFor(inner.gate, { stateDir: dir, log: (step, fields) => rows.push({ step, fields }), clock: clockFromMillisFn(() => nowMs) });
  return {
    rows, gate,
    consult: (r: QueueGovernorResult | undefined, advanceMs = 0) => { nowMs += advanceMs; inner.set(r); return gate(); },
  };
}

test("W1-T11026 criterion 1: the bounds are the base WIP limit and half of it", () => {
  assert.deepEqual(focusBounds(BASE), { enterAt: 10, exitAt: 5 });
  assert.deepEqual(focusBounds(0), { enterAt: 1, exitAt: 0 }, "a degenerate base never enters at zero stuck PRs");
});

test("W1-T11026 criterion 1: decideFocus enters only after the deep stack holds for the dwell", () => {
  const t0 = 1_000_000;
  const first = decideFocus({ on: false }, { stuckOwnedCount: 12, observedOpenCount: 20, baseWipLimit: BASE }, t0);
  assert.equal(first.on, false);
  assert.equal(first.pendingSinceMs, t0);
  assert.match(first.reason, /entering once it holds 30 minutes/);
  const early = decideFocus(first, { stuckOwnedCount: 11, observedOpenCount: 20, baseWipLimit: BASE }, t0 + FOCUS_DWELL_MS - 1);
  assert.equal(early.on, false);
  const entered = decideFocus(early, { stuckOwnedCount: 10, observedOpenCount: 20, baseWipLimit: BASE }, t0 + FOCUS_DWELL_MS);
  assert.deepEqual([entered.on, entered.changed], [true, true]);
  assert.match(entered.reason, /10 stuck of 20 owned open PRs \(enter at 10, leave at 5\)/);
});

test("W1-T11026 criterion 1: one reading that flips back restarts the wait", () => {
  const t0 = 1_000_000;
  const pending = decideFocus({ on: false }, { stuckOwnedCount: 12, observedOpenCount: 20, baseWipLimit: BASE }, t0);
  const reset = decideFocus(pending, { stuckOwnedCount: 9, observedOpenCount: 20, baseWipLimit: BASE }, t0 + 20 * MIN);
  assert.equal(reset.pendingSinceMs, undefined);
  const again = decideFocus(reset, { stuckOwnedCount: 12, observedOpenCount: 20, baseWipLimit: BASE }, t0 + 40 * MIN);
  assert.deepEqual([again.on, again.pendingSinceMs], [false, t0 + 40 * MIN], "the dwell starts over at the new reading");
});

test("W1-T11026 criterion 1: between the bounds the current state holds, and it leaves at half the limit", () => {
  const t0 = 1_000_000;
  for (const stuck of [6, 7, 8, 9]) {
    assert.deepEqual(decideFocus({ on: true }, { stuckOwnedCount: stuck, observedOpenCount: 20, baseWipLimit: BASE }, t0),
      { on: true, changed: false, reason: `${stuck} stuck of 20 owned open PRs (enter at 10, leave at 5)` });
    assert.equal(decideFocus({ on: false }, { stuckOwnedCount: stuck, observedOpenCount: 20, baseWipLimit: BASE }, t0).on, false);
  }
  const leaving = decideFocus({ on: true }, { stuckOwnedCount: 5, observedOpenCount: 9, baseWipLimit: BASE }, t0);
  assert.match(leaving.reason, /leaving once it holds 30 minutes/);
  const left = decideFocus(leaving, { stuckOwnedCount: 2, observedOpenCount: 6, baseWipLimit: BASE }, t0 + FOCUS_DWELL_MS);
  assert.deepEqual([left.on, left.changed], [false, true]);
});

test("W1-T11026 criterion 1: the gate holds new dispatch with tier focus, writes FOCUS, and releases it when the stack halves", async () => {
  await withTempDir("focus-gardener", (dir) => {
    writeFileSync(join(dir, "QUIET_HOURS"), "operator bytes");
    const h = harness(dir);
    assert.equal(h.consult(reading(12)), undefined, "the first deep reading only starts the dwell");
    assert.equal(h.gate.readAdmission()?.stuckOwnedCount, 12, "an admitted reading still sizes the lanes");
    const held = h.consult(reading(12), FOCUS_DWELL_MS);
    assert.deepEqual([held?.deferred, held?.tier, held?.stuckOwnedCount], [true, "focus", 12]);
    assert.equal(h.gate.readAdmission(), undefined, "a held consultation offers no admission");
    const flag = readFocusFlag(dir);
    assert.equal(flag?.owner, FOCUS_OWNER);
    assert.deepEqual([flag?.stuck_owned_count, flag?.observed_open_count, flag?.base_wip_limit], [12, 20, 10]);
    assert.deepEqual(h.rows.map((r) => r.step), [FOCUS_ENTERED_STEP]);
    assert.equal(h.rows[0].fields.stuck_owned_count, 12);

    assert.equal(h.consult(reading(7), 5 * MIN)?.tier, "focus", "between the bounds the hold stands");
    const deferring = reading(7, true);
    assert.equal(h.consult(deferring), deferring, "the governor's own deferral passes through unchanged");
    assert.equal(h.consult(reading(4))?.tier, "focus", "the halved stack must hold for the dwell first");
    assert.equal(h.consult(reading(3), FOCUS_DWELL_MS), undefined);
    assert.equal(existsSync(join(dir, FOCUS_FILE)), false);
    assert.equal(h.gate.readAdmission()?.stuckOwnedCount, 3);
    assert.deepEqual(h.rows.map((r) => r.step), [FOCUS_ENTERED_STEP, FOCUS_EXITED_STEP]);
    assert.equal(readFileSync(join(dir, "QUIET_HOURS"), "utf8"), "operator bytes", "QUIET_HOURS is never written or removed");
  });
});

test("W1-T11026 criterion 1: a restart keeps the hold, and removing FOCUS by hand releases it", async () => {
  await withTempDir("focus-gardener", (dir) => {
    writeFileSync(join(dir, FOCUS_FILE), JSON.stringify({ owner: FOCUS_OWNER, since: "2026-10-30T15:00:00.000Z", reason: "r",
      stuck_owned_count: 12, observed_open_count: 20, base_wip_limit: 10 }));
    const h = harness(dir);
    assert.equal(h.consult(reading(9))?.tier, "focus", "a restarted daemon reads its standing hold from the file");
    assert.equal(h.consult(undefined), undefined, "a consultation with no reading decides nothing");
    writeFileSync(join(dir, FOCUS_FILE), "not json");
    assert.equal(h.consult(reading(12)), undefined, "an unreadable flag is no hold of the gardener's");
    assert.deepEqual(h.rows.map((r) => r.step), [FOCUS_RELEASED_STEP]);
    assert.equal(h.consult(reading(12), FOCUS_DWELL_MS)?.tier, "focus", "re-entry waits a full dwell");
  });
});

test("W1-T11026 criterion 1: a flag owned by anyone else is not the gardener's hold", async () => {
  await withTempDir("focus-gardener", (dir) => {
    writeFileSync(join(dir, FOCUS_FILE), JSON.stringify({ owner: "operator" }));
    assert.equal(readFocusFlag(dir), undefined);
    assert.equal(harness(dir).consult(reading(3)), undefined);
  });
});

test("W1-T11026 criterion 1: a flag write that fails is ledgered, and the switch still takes effect this consultation", async () => {
  await withTempDir("focus-gardener", (dir) => {
    mkdirSync(join(dir, FOCUS_FILE, "blocker"), { recursive: true });
    const h = harness(dir);
    h.consult(reading(12));
    assert.equal(h.consult(reading(12), FOCUS_DWELL_MS)?.tier, "focus");
    assert.deepEqual(h.rows.map((r) => r.step), [FOCUS_FLAG_FAILED_STEP, FOCUS_ENTERED_STEP]);
    assert.equal(h.rows[0].fields.on, true);
    assert.equal(typeof h.rows[0].fields.error, "string");
  });
});
