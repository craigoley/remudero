// W1-T12123: measured 2026-11-10, after W1-T12057 went live the daemon still refused four waits in 13 minutes.
// Three were the shared read gap (993, 1474 and 72 ms). One was a 25 ms lock wait behind its own async read.
// The loop now sleeps a shared-gap wait, and it does not wait for a lock its own async read holds.
// A wait longer than the shared read gap, and every wait on serve's pacer, is still refused.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyGhReadCadence,
  applyGhReadCadenceAsync,
  createNonBlockingGhCallPacer,
  DEFAULT_GH_SHARED_READ_GAP_MS,
  GH_PACE_LOOP_WAIT_STEP,
  ghGatedStampPath,
  ghReadCadenceStampPath,
  GhPaceWouldBlockError,
  readGhReadCadenceStampMs,
  readGhReadTickets,
  stampGhRead,
  takeGhPaceLoopWaits,
  withDaemonGhTransportFloor,
} from "#src/lib/github-transport.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const THIS_FILE = "test/github/the-shared-read-gap-is-waited-out-on-the-daemon-loop.test.ts";
const READ = ["api", "repos/fixture/loop/pulls/1"];

/** A shared read cache in a temp directory. Another process stamped it `agoMs` before the fake clock's now.
 *  `waits` lists every blocking sleep, and each sleep advances the clock. */
function scene(opts: { gapMs?: number; agoMs?: number; floor?: string; stampText?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shared-gap-`));
  const env: NodeJS.ProcessEnv = { RMD_GH_CACHE_HOME: root, RMD_GH_TRANSPORT_FLOOR: opts.floor ?? "advisory" };
  if (opts.gapMs !== undefined) env.RMD_GH_SHARED_READ_GAP_MS = String(opts.gapMs);
  const stamp = ghReadCadenceStampPath(env, "core")!;
  stampGhRead(stamp, opts.stampText ?? "advisory\n", 1_800_000_000_000);
  let now = readGhReadCadenceStampMs(stamp)! + (opts.agoMs ?? 0);
  const waits: number[] = [];
  const deps = {
    env, nowMs: () => now, bucketOverride: "core", warn: () => {},
    sleepSync: (ms: number) => { waits.push(ms); now += ms; },
  };
  return { root, env, stamp, waits, deps, lock: `${stamp}.lock`, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("W1-T12123 criterion 1: on the daemon loop a shared read gap wait is slept, the read is made, and a row names its call site", async () => {
  takeGhPaceLoopWaits();
  // The three shared-gap waits the daemon refused on 2026-11-10, and the whole gap.
  for (const waitMs of [993, 1474, 72, DEFAULT_GH_SHARED_READ_GAP_MS]) {
    const s = scene({ agoMs: DEFAULT_GH_SHARED_READ_GAP_MS - waitMs });
    try {
      const before = readGhReadCadenceStampMs(s.stamp)!;
      await withDaemonGhTransportFloor(() => {
        assert.equal(applyGhReadCadence(READ, s.deps).allow, true, `a ${waitMs}ms shared-gap wait must not fail the action`);
      }, s.env);
      assert.deepEqual(s.waits, [waitMs], `the loop sleeps the ${waitMs}ms that remain of the shared gap`);
      assert.equal(readGhReadCadenceStampMs(s.stamp), before + DEFAULT_GH_SHARED_READ_GAP_MS, "the read is stamped after the gap");
      assert.equal(existsSync(s.lock), false, "the read releases the lock it took");
      const rows = takeGhPaceLoopWaits();
      assert.equal(rows.length, 1, "one wait writes one row");
      assert.equal(rows[0].step, GH_PACE_LOOP_WAIT_STEP);
      assert.equal(rows[0].step, "github.pace.loop_wait");
      assert.equal(rows[0].wait_ms, waitMs);
      assert.equal(rows[0].lock, undefined, "a read that took the lock names no lock reason");
      const [file, line] = rows[0].call_site.split(":");
      assert.equal(file, THIS_FILE, "the call site is the first frame outside the transport");
      assert.match(line, /^\d+$/, "the call site carries a line number");
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  }

  // An operator's shorter gap is slept the same way. A read with no gap pending sleeps nothing and writes no row.
  const s = scene({ gapMs: 100 });
  try {
    await withDaemonGhTransportFloor(() => {
      assert.equal(applyGhReadCadence(READ, s.deps).allow, true);
      assert.equal(applyGhReadCadence(READ, s.deps).allow, true, "a read after this process's own stamp has no gap to wait");
    }, s.env);
    assert.deepEqual(s.waits, [100]);
    assert.deepEqual(takeGhPaceLoopWaits().map((row) => row.wait_ms), [100]);
    // Off the loop the same wait is slept and blocks no loop, so it writes no row.
    const off = scene({ gapMs: 100 });
    try {
      assert.equal(applyGhReadCadence(READ, off.deps).allow, true);
      assert.deepEqual(off.waits, [100]);
      assert.deepEqual(takeGhPaceLoopWaits(), []);
    } finally { rmSync(off.root, { recursive: true, force: true }); }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("W1-T12123 criterion 2: on the daemon loop a read behind its own async read's lock is made, and the row says it did not wait for the lock", async () => {
  takeGhPaceLoopWaits();
  const s = scene({ gapMs: 100 });
  let entered!: () => void;
  const sleeping = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await withDaemonGhTransportFloor(async () => {
      // The async read takes the lock and waits its gap on a timer. Only the loop can end that wait.
      const pending = applyGhReadCadenceAsync(READ, { ...s.deps, sleep: async () => { entered(); await gate; } });
      let syncStampMs: number | undefined;
      try {
        await sleeping;
        assert.equal(existsSync(s.lock), true, "the async read holds the lock while it waits");
        const before = readGhReadCadenceStampMs(s.stamp)!;
        assert.equal(applyGhReadCadence(READ, s.deps).allow, true, "the loop read must not fail behind its own async read");
        assert.deepEqual(s.waits, [100], "it sleeps its shared gap once and never sleeps a lock wait");
        syncStampMs = readGhReadCadenceStampMs(s.stamp)!;
        assert.equal(syncStampMs, before + 100, "the loop read is stamped after its gap");
        assert.equal(existsSync(s.lock), true, "the async read still holds its lock");
        const rows = takeGhPaceLoopWaits();
        assert.equal(rows.length, 2, "one row for the gap wait and one for the lock it did not wait for");
        assert.deepEqual({ wait_ms: rows[0].wait_ms, lock: rows[0].lock }, { wait_ms: 100, lock: undefined });
        assert.deepEqual(
          { step: rows[1].step, wait_ms: rows[1].wait_ms, lock: rows[1].lock },
          { step: GH_PACE_LOOP_WAIT_STEP, wait_ms: 0, lock: "own-async-read" },
        );
        assert.ok(rows[1].call_site.startsWith(`${THIS_FILE}:`), "the row names the caller of the read");
      } finally {
        s.advance(7);
        release();
      }
      assert.equal((await pending).allow, true, "the async read is made after the loop read");
      assert.equal(readGhReadCadenceStampMs(s.stamp), syncStampMs! + 7, "the async read writes its own stamp at its own time");
      assert.equal(existsSync(s.lock), false, "the async read releases its lock");
      assert.equal(applyGhReadCadence(READ, s.deps).allow, true);
      assert.deepEqual(s.waits, [100], "once the async read has finished, the next loop read takes the lock and waits for nothing");
      assert.deepEqual(takeGhPaceLoopWaits(), [], "a read that took a free lock writes no row");
    }, s.env);
  } finally { rmSync(s.root, { recursive: true, force: true }); }

  // An async read that is queued but does not hold the lock: another process holds it.
  // The loop read waits for that lock inside the lock's own bound, as W1-T12057 set.
  const other = scene({ gapMs: 0 });
  mkdirSync(other.lock);
  let otherEntered!: () => void;
  const otherSleeping = new Promise<void>((resolve) => { otherEntered = resolve; });
  let otherRelease!: () => void;
  const otherGate = new Promise<void>((resolve) => { otherRelease = resolve; });
  try {
    await withDaemonGhTransportFloor(async () => {
      const pending = applyGhReadCadenceAsync(READ, { ...other.deps, sleep: async () => { otherEntered(); await otherGate; } });
      try {
        await otherSleeping;
        // The other process releases during the first lock wait.
        const sleepSync = (ms: number): void => { other.waits.push(ms); rmSync(other.lock, { recursive: true }); };
        assert.equal(applyGhReadCadence(READ, { ...other.deps, sleepSync }).allow, true);
        assert.equal(other.waits.length, 1, "one lock wait is slept");
        const rows = takeGhPaceLoopWaits();
        assert.deepEqual(rows.map((row) => ({ wait_ms: row.wait_ms, lock: row.lock })), [{ wait_ms: other.waits[0], lock: undefined }]);
        assert.equal(existsSync(other.lock), false, "the loop read took the lock and released it for the queued async read");
      } finally { otherRelease(); }
      assert.equal((await pending).allow, true, "the queued async read still gets its turn");
    }, other.env);
  } finally { rmSync(other.root, { recursive: true, force: true }); }
});

test("W1-T12123 criterion 3: a wait longer than the shared read gap, and every wait on serve's pacer, is still refused", async () => {
  takeGhPaceLoopWaits();
  // A wait-mode read inside the 180-second floor: its wait is far longer than the shared read gap.
  const s = scene({ floor: "wait", stampText: "" });
  let entered!: () => void;
  const sleeping = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const before = readGhReadCadenceStampMs(s.stamp);
    await withDaemonGhTransportFloor(async () => {
      assert.throws(
        () => applyGhReadCadence(READ, s.deps),
        (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs > DEFAULT_GH_SHARED_READ_GAP_MS,
        "a floor wait must not be slept on the loop",
      );
      // The same long wait behind this process's own async read is refused too, and writes no row.
      const pending = applyGhReadCadenceAsync(READ, { ...s.deps, sleep: async () => { entered(); await gate; } });
      try {
        await sleeping;
        assert.throws(
          () => applyGhReadCadence(READ, s.deps),
          (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs > DEFAULT_GH_SHARED_READ_GAP_MS,
          "a floor wait is refused whoever holds the lock",
        );
      } finally {
        s.advance(180_000);
        release();
        await pending;
      }
    }, s.env);
    assert.deepEqual(s.waits, [], "a refused wait never reaches the blocking sleep");
    assert.deepEqual(takeGhPaceLoopWaits(), [], "a refused wait writes no row");
    assert.deepEqual(readGhReadTickets(s.stamp), [], "a refused read leaves the queue");

    // A refused read does not stamp: a fresh scene, with no async read to stamp after it.
    const lone = scene({ floor: "wait", stampText: "" });
    try {
      const loneBefore = readGhReadCadenceStampMs(lone.stamp);
      await withDaemonGhTransportFloor(() => {
        assert.throws(() => applyGhReadCadence(READ, lone.deps), GhPaceWouldBlockError);
      }, lone.env);
      assert.equal(readGhReadCadenceStampMs(lone.stamp), loneBefore, "a refused read is not stamped");
      assert.equal(existsSync(ghGatedStampPath(lone.stamp)), false, "a refused read consumes no gated read");
      assert.equal(existsSync(lone.lock), false);
    } finally { rmSync(lone.root, { recursive: true, force: true }); }
    assert.notEqual(before, undefined);
  } finally { rmSync(s.root, { recursive: true, force: true }); }

  // With the shared gap switched off there is no gap to wait within, so any wait on the loop is refused.
  const zero = scene({ gapMs: 0, floor: "wait", stampText: "" });
  try {
    await withDaemonGhTransportFloor(() => {
      assert.throws(() => applyGhReadCadence(READ, zero.deps), GhPaceWouldBlockError);
    }, zero.env);
    assert.deepEqual(zero.waits, []);
  } finally { rmSync(zero.root, { recursive: true, force: true }); }

  // Serve's pacer refuses every wait, on the daemon loop and off it, and never reaches a blocking sleep.
  const serve = createNonBlockingGhCallPacer({ now: () => 0 });
  serve.wait();
  assert.throws(() => serve.wait(), GhPaceWouldBlockError);
  assert.throws(() => serve.sleepSync!(1), GhPaceWouldBlockError);
  await withDaemonGhTransportFloor(() => {
    assert.throws(() => serve.wait(), GhPaceWouldBlockError);
    assert.throws(() => serve.sleepSync!(1), GhPaceWouldBlockError);
  }, {});
  assert.deepEqual(takeGhPaceLoopWaits(), [], "serve's refusal writes no row");
});
