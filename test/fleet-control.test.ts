import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeStop,
  isPaused,
  isQuietHours,
  isStopped,
  pauseDetail,
  pauseFilePath,
  quietHoursFilePath,
  requestPause,
  requestStop,
  resumeFleet,
  setQuietHours,
  stopDetail,
  stopFilePath,
} from "../src/lib/fleet-control.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "fleet-control-"));
}

// ── STOP ─────────────────────────────────────────────────────────────────

test("requestStop writes the STOP flag; isStopped flips true; stopDetail surfaces the reason", () => {
  const root = tmpRoot();
  assert.equal(isStopped(root), false);
  assert.equal(stopDetail(root), undefined);

  requestStop(root, "operator pulled the plug");
  assert.equal(isStopped(root), true);
  assert.match(stopDetail(root) ?? "", /operator pulled the plug/);
});

test("requestStop with no reason still stops, with a generic detail", () => {
  const root = tmpRoot();
  requestStop(root);
  assert.equal(isStopped(root), true);
  assert.match(stopDetail(root) ?? "", /STOP file present/);
});

// ── PAUSE ────────────────────────────────────────────────────────────────

test("requestPause writes the PAUSE flag; isPaused flips true; pauseDetail surfaces the reason", () => {
  const root = tmpRoot();
  assert.equal(isPaused(root), false);
  assert.equal(pauseDetail(root), undefined);

  requestPause(root, "quiet hours");
  assert.equal(isPaused(root), true);
  assert.match(pauseDetail(root) ?? "", /quiet hours/);
});

// ── RESUME clears BOTH ───────────────────────────────────────────────────

test("resumeFleet clears both STOP and PAUSE and reports what it cleared", () => {
  const root = tmpRoot();
  requestStop(root, "a");
  requestPause(root, "b");
  const r = resumeFleet(root);
  assert.deepEqual(r, { clearedStop: true, clearedPause: true });
  assert.equal(isStopped(root), false);
  assert.equal(isPaused(root), false);
});

test("resumeFleet is idempotent — nothing to clear is not an error", () => {
  const root = tmpRoot();
  const r = resumeFleet(root);
  assert.deepEqual(r, { clearedStop: false, clearedPause: false });
});

// ── fail CLOSED on a garbage file (a kill switch must not fail open) ───────

test("a garbage/unreadable STOP file still gates as stopped (fails closed)", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(stopFilePath(root), "not json{{{");
  assert.equal(isStopped(root), true);
  assert.match(stopDetail(root) ?? "", /STOP file present/);
});

test("stopFilePath/pauseFilePath are distinct paths under <root>/state", () => {
  const root = tmpRoot();
  assert.notEqual(stopFilePath(root), pauseFilePath(root));
  assert.match(stopFilePath(root), /state[\\/]STOP$/);
  assert.match(pauseFilePath(root), /state[\\/]PAUSE$/);
});

// ── STOP is ONE-SHOT (fix/cli-safe-control-surface): the halted run consumes it so a
// future drain is never silently blocked. PAUSE stays PERSISTENT (resume only). ──
test("consumeStop clears ONLY the STOP flag (one-shot) and leaves PAUSE (persistent)", () => {
  const root = tmpRoot();
  requestStop(root, "accidental run");
  requestPause(root, "maintenance");
  assert.equal(isStopped(root), true);
  assert.equal(isPaused(root), true);

  const cleared = consumeStop(root);
  assert.equal(cleared, true, "consumeStop reports it cleared a present STOP");
  assert.equal(isStopped(root), false, "STOP is one-shot — consumed");
  assert.equal(isPaused(root), true, "PAUSE is persistent — NOT consumed by consumeStop");
});

test("consumeStop with no STOP present is a no-op (idempotent, returns false)", () => {
  const root = tmpRoot();
  assert.equal(consumeStop(root), false);
  assert.equal(isStopped(root), false);
});

test("LIFECYCLE: after a run consumes STOP, a subsequent drain sees a clean slate WITHOUT a manual resume", () => {
  const root = tmpRoot();
  requestStop(root); // operator stops an accidental run
  assert.equal(isStopped(root), true);
  consumeStop(root); // the halted run auto-consumes STOP as it terminates
  // the NEXT drain's gate predicate is clear — no `rmd resume` / manual rm needed:
  assert.equal(isStopped(root), false);
});

test("PAUSE still requires resume — it is NOT consumed by consumeStop and survives across runs", () => {
  const root = tmpRoot();
  requestPause(root, "hold for maintenance");
  consumeStop(root); // a run terminating consumes STOP only
  assert.equal(isPaused(root), true, "PAUSE persists across a STOP consume");
  const r = resumeFleet(root);
  assert.equal(r.clearedPause, true);
  assert.equal(isPaused(root), false, "only resume clears PAUSE");
});

// ── QUIET HOURS (W3-T5): a THIRD, independent flag — a schedule preference, not an
// emergency hold, so `rmd resume` must never touch it. ─────────────────────────────

test("setQuietHours(true) writes the QUIET_HOURS flag; isQuietHours flips true; returns the new state", () => {
  const root = tmpRoot();
  assert.equal(isQuietHours(root), false);

  const result = setQuietHours(root, true);
  assert.equal(result, true);
  assert.equal(isQuietHours(root), true);
});

test("setQuietHours(false) clears the QUIET_HOURS flag; returns the new state", () => {
  const root = tmpRoot();
  setQuietHours(root, true);
  assert.equal(isQuietHours(root), true);

  const result = setQuietHours(root, false);
  assert.equal(result, false);
  assert.equal(isQuietHours(root), false);
});

test("setQuietHours(false) with nothing set is a no-op, not an error", () => {
  const root = tmpRoot();
  assert.equal(setQuietHours(root, false), false);
  assert.equal(isQuietHours(root), false);
});

test("quietHoursFilePath is distinct from stopFilePath/pauseFilePath, under <root>/state", () => {
  const root = tmpRoot();
  assert.notEqual(quietHoursFilePath(root), stopFilePath(root));
  assert.notEqual(quietHoursFilePath(root), pauseFilePath(root));
  assert.match(quietHoursFilePath(root), /state[\\/]QUIET_HOURS$/);
});

test("resumeFleet does NOT touch quiet hours — it is a schedule preference, not an emergency hold", () => {
  const root = tmpRoot();
  setQuietHours(root, true);
  requestStop(root, "a");
  requestPause(root, "b");

  resumeFleet(root);

  assert.equal(isStopped(root), false);
  assert.equal(isPaused(root), false);
  assert.equal(isQuietHours(root), true, "resumeFleet must leave quiet hours untouched");
});
