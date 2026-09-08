import assert from "node:assert/strict";
import { test } from "node:test";
import {
  systemClock,
  fixedClock,
  clockFromDateFn,
  clockFromMillisFn,
  clockFromIsoFn,
  type Clock,
} from "../src/lib/clock.js";

test("systemClock's three projections agree with the real wall clock within a generous tolerance", () => {
  const before = Date.now();
  const nowMs = systemClock.now();
  const dateMs = systemClock.date().getTime();
  const isoMs = new Date(systemClock.iso()).getTime();
  const after = Date.now();

  for (const ms of [nowMs, dateMs, isoMs]) {
    assert.ok(ms >= before && ms <= after, `${ms} should fall within [${before}, ${after}]`);
  }
});

test("fixedClock( freezes every projection to the same instant, provable across two calls", () => {
  const ms = Date.parse("2026-01-15T12:00:00.000Z");
  const clock: Clock = fixedClock(ms);

  assert.equal(clock.now(), ms);
  assert.equal(clock.date().getTime(), ms);
  assert.equal(clock.iso(), new Date(ms).toISOString());
  // Two reads never drift apart — the whole point of freezing time for a cross-module test.
  assert.equal(clock.now(), clock.now());
  assert.equal(clock.date().getTime(), clock.date().getTime());
});

test("a fixedClock( lets two independently-constructed readers agree, which is the drift this port exists to close", () => {
  const ms = 1_700_000_000_000;
  const readerA = fixedClock(ms);
  const readerB = fixedClock(ms);
  assert.equal(readerA.now(), readerB.now());
  assert.equal(readerA.iso(), readerB.iso());
});

test("clockFromDateFn( adapts the () => Date legacy shape without losing precision", () => {
  const ms = Date.parse("2025-06-01T00:00:00.000Z");
  const clock = clockFromDateFn(() => new Date(ms));
  assert.equal(clock.now(), ms);
  assert.equal(clock.date().getTime(), ms);
  assert.equal(clock.iso(), new Date(ms).toISOString());
});

test("clockFromDateFn( defaults to the real clock when no legacy function is injected", () => {
  const before = Date.now();
  const clock = clockFromDateFn(undefined);
  const ms = clock.now();
  const after = Date.now();
  assert.ok(ms >= before && ms <= after);
});

test("clockFromMillisFn( adapts the () => number legacy shape", () => {
  const ms = 1_600_000_000_000;
  const clock = clockFromMillisFn(() => ms);
  assert.equal(clock.now(), ms);
  assert.equal(clock.date().getTime(), ms);
  assert.equal(clock.iso(), new Date(ms).toISOString());
});

test("clockFromIsoFn( adapts the () => string legacy shape", () => {
  const iso = "2024-12-25T00:00:00.000Z";
  const clock = clockFromIsoFn(() => iso);
  assert.equal(clock.iso(), iso);
  assert.equal(clock.now(), Date.parse(iso));
  assert.equal(clock.date().toISOString(), iso);
});
