import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPaused,
  isStopped,
  pauseDetail,
  pauseFilePath,
  requestPause,
  requestStop,
  resumeFleet,
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
