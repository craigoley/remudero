// W1-T12057: measured 2026-11-10, about 545 daemon actions failed in three days because the gh pacer
// refused to sleep 8, 25 or 62 ms on the daemon loop. The gh call that follows blocks the loop for longer.
// The pacer now sleeps a wait within its own normal gap, records it, and still refuses a longer wait.
// The read cadence's lock wait is slept the same way, and the daemon appends every recorded wait to its ledger.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drainGhPaceLoopWaits, runDaemon } from "#src/lib/daemon.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import {
  applyGhReadCadence,
  createGhCallPacer,
  createNonBlockingGhCallPacer,
  DEFAULT_GH_PACE_MIN_GAP_MS,
  DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS,
  GH_PACE_LOOP_WAIT_STEP,
  ghReadCadenceStampPath,
  GhPaceWouldBlockError,
  paceGhEntry,
  stampGhRead,
  takeGhPaceLoopWaits,
  withDaemonGhTransportFloor,
} from "#src/lib/github-transport.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const THIS_FILE = "test/github/the-pacer-waits-out-a-normal-gap-on-the-daemon-loop.test.ts";
const neverLimited = (): boolean => false;

/** A pacer on a fake clock: `sleeps` lists every blocking sleep, and each sleep advances the clock. */
function scene(build: typeof createGhCallPacer = createGhCallPacer) {
  let now = 0;
  const sleeps: number[] = [];
  const pacer = build({ now: () => now, sleepSync: (ms) => { sleeps.push(ms); now += ms; } });
  return { pacer, sleeps, advance: (ms: number) => { now += ms; } };
}

/** Runs `fn` inside the daemon's loop scope. The empty env keeps the real environment untouched. */
async function onDaemonLoop(fn: () => void): Promise<void> {
  await withDaemonGhTransportFloor(fn, {});
}

test("W1-T12057 criterion 1: on the daemon loop a wait within the normal gap is slept and the gh call is made", async () => {
  takeGhPaceLoopWaits();
  for (const waitMs of [8, 25, 62, DEFAULT_GH_PACE_MIN_GAP_MS]) {
    const s = scene();
    s.pacer.wait();
    s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - waitMs);
    let calls = 0;
    await onDaemonLoop(() => {
      const out = paceGhEntry(s.pacer, neverLimited, () => { calls += 1; return "made"; });
      assert.equal(out, "made", `a ${waitMs}ms wait must not fail the action`);
    });
    assert.deepEqual(s.sleeps, [waitMs], `the loop sleeps the ${waitMs}ms that remain of the gap`);
    assert.equal(calls, 1, "the gh call runs once, after the wait");
  }
  takeGhPaceLoopWaits();
});

test("W1-T12057 criterion 2: each loop wait writes one row with the wait in milliseconds and the call site", async () => {
  takeGhPaceLoopWaits();
  const s = scene();
  s.pacer.wait();
  assert.deepEqual(takeGhPaceLoopWaits(), [], "a first call has nothing to wait for, so it writes no row");

  s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - 62);
  await onDaemonLoop(() => { s.pacer.wait(); });
  const first = takeGhPaceLoopWaits();
  assert.equal(first.length, 1, "one wait writes one row");
  assert.equal(first[0].step, GH_PACE_LOOP_WAIT_STEP);
  assert.equal(first[0].step, "github.pace.loop_wait");
  assert.equal(first[0].wait_ms, 62);
  const [file, line] = first[0].call_site.split(":");
  assert.equal(file, THIS_FILE, "the call site is the first frame outside the transport, relative to the repository");
  assert.match(line, /^\d+$/, "the call site carries a line number");
  assert.deepEqual(takeGhPaceLoopWaits(), [], "a drained row is not reported twice");

  s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - 8);
  await onDaemonLoop(() => {
    paceGhEntry(s.pacer, neverLimited, () => "made");
  });
  const second = takeGhPaceLoopWaits();
  assert.equal(second.length, 1);
  assert.equal(second[0].wait_ms, 8);
  assert.ok(second[0].call_site.startsWith(`${THIS_FILE}:`), "a call through paceGhEntry still names its caller");
  assert.notEqual(second[0].call_site, first[0].call_site, "two call sites are told apart, so each can be found and moved");

  s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - 25);
  s.pacer.wait();
  assert.deepEqual(s.sleeps, [62, 8, 25]);
  assert.deepEqual(takeGhPaceLoopWaits(), [], "a wait off the loop blocks no loop, so it writes no row");
});

test("W1-T12057 criterion 3: a wait longer than the normal gap is still refused on the daemon loop", async () => {
  takeGhPaceLoopWaits();
  const s = scene();
  s.pacer.wait();
  s.pacer.recordResult(true);
  let calls = 0;
  await onDaemonLoop(() => {
    assert.throws(
      () => paceGhEntry(s.pacer, neverLimited, () => { calls += 1; return "made"; }),
      (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs === DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS,
      "a rate-limit gap must not be slept on the loop",
    );
    s.advance(DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS - DEFAULT_GH_PACE_MIN_GAP_MS - 1);
    assert.throws(
      () => s.pacer.wait(),
      (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs === DEFAULT_GH_PACE_MIN_GAP_MS + 1,
      "one millisecond over the normal gap is refused",
    );
    assert.throws(() => s.pacer.sleepSync!(DEFAULT_GH_PACE_MIN_GAP_MS), GhPaceWouldBlockError, "a refusal backoff never sleeps on the loop");
  });
  assert.equal(calls, 0, "a refused wait makes no gh call");
  assert.deepEqual(s.sleeps, [], "a refused wait never reaches the blocking sleep");
  assert.deepEqual(takeGhPaceLoopWaits(), [], "a refused wait writes no row");

  // Serve's pacer keeps refusing every wait, on the daemon loop and off it.
  const serve = createNonBlockingGhCallPacer({ now: () => 0 });
  serve.wait();
  assert.throws(() => serve.wait(), GhPaceWouldBlockError);
  await onDaemonLoop(() => {
    assert.throws(() => serve.wait(), GhPaceWouldBlockError);
  });
  assert.deepEqual(takeGhPaceLoopWaits(), [], "serve's refusal writes no row");
});

/** A shared read cache in a temp directory, with no gap pending, so only the lock can make a read wait. */
function cadenceScene() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}loop-wait-`));
  const env = { RMD_GH_CACHE_HOME: root, RMD_GH_TRANSPORT_FLOOR: "advisory", RMD_GH_SHARED_READ_GAP_MS: "0" };
  const stamp = ghReadCadenceStampPath(env, "core")!;
  const now = Date.now();
  stampGhRead(stamp, "advisory\n", now);
  const lock = `${stamp}.lock`;
  mkdirSync(lock);
  return { root, env, lock, deps: { env, nowMs: () => now, bucketOverride: "core", warn: () => {} } };
}

const READ = ["api", "repos/fixture/loop/pulls/1"];

test("W1-T12057 criterion 4: on the daemon loop the read cadence's lock wait is slept and the read is made", async () => {
  takeGhPaceLoopWaits();
  const freed = cadenceScene();
  try {
    const waits: number[] = [];
    // The holder releases during the first wait.
    const sleepSync = (ms: number): void => { waits.push(ms); rmSync(freed.lock, { recursive: true }); };
    await onDaemonLoop(() => {
      assert.equal(applyGhReadCadence(READ, { ...freed.deps, sleepSync }).allow, true, "the read is made after the lock wait");
    });
    assert.equal(waits.length, 1, "one lock wait is slept");
    assert.equal(existsSync(freed.lock), false, "the read takes the lock and releases it");
    const rows = takeGhPaceLoopWaits();
    assert.equal(rows.length, 1, "the lock wait writes one row");
    assert.deepEqual({ step: rows[0].step, wait_ms: rows[0].wait_ms }, { step: GH_PACE_LOOP_WAIT_STEP, wait_ms: waits[0] });
    assert.ok(rows[0].call_site.startsWith(`${THIS_FILE}:`), "the row names the caller of the read");
  } finally { rmSync(freed.root, { recursive: true, force: true }); }

  // A holder that never releases: the wait ends at the cadence's own maximum, and the read fails open as before.
  const held = cadenceScene();
  try {
    const waits: number[] = [];
    const startedAt = Date.now();
    const sleepSync = (ms: number): void => { waits.push(ms); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    await onDaemonLoop(() => {
      assert.equal(applyGhReadCadence(READ, { ...held.deps, sleepSync }).allow, true, "a read past the lock's maximum still fails open");
    });
    const total = waits.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waits.length > 1, "the loop keeps waiting while the lock is held");
    assert.ok(total - waits[0] < Date.now() - startedAt, "every wait but the last starts inside the cadence's maximum");
    assert.equal(existsSync(held.lock), true, "a lock the read never took stays with its holder");
    assert.equal(takeGhPaceLoopWaits().length, waits.length, "each lock wait writes one row");
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test("W1-T12057 criterion 5: the daemon drains the loop waits into its ledger and leaves the buffer empty", async (t) => {
  takeGhPaceLoopWaits();
  const s = scene();
  s.pacer.wait();
  s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - 62);
  await onDaemonLoop(() => { s.pacer.wait(); });
  s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - 8);
  await onDaemonLoop(() => { s.pacer.wait(); });

  const planDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}loop-wait-plan-`));
  t.after(() => rmSync(planDir, { recursive: true, force: true }));
  writeFileSync(join(planDir, "tasks.yaml"), "- id: M\n  title: merged\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let polls = 0;
  await runDaemon(loadPlan(join(planDir, "tasks.yaml")), {
    refreshMerged: () => (id) => id === "M",
    runOne: async (id) => { throw new Error(`falsifier: ${id} dispatched`); },
    log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    checkStop: () => stopDetail(planDir),
    sleep: async () => { if (++polls >= 3) requestStop(planDir, "test done polling"); },
  });
  const rows = lines.filter((l) => l.step === "github.pace.loop_wait");
  assert.deepEqual(rows.map((l) => l.extra.wait_ms), [62, 8], "each wait is appended once, in order, over several ticks");
  for (const row of rows) assert.ok(String(row.extra.call_site).startsWith(`${THIS_FILE}:`), "the appended row keeps its call site");
  assert.deepEqual(takeGhPaceLoopWaits(), [], "the buffer is empty after the daemon drains it");

  // The drain itself: it appends through the function it is given and empties the buffer.
  s.advance(DEFAULT_GH_PACE_MIN_GAP_MS - 25);
  await onDaemonLoop(() => { s.pacer.wait(); });
  const appended: Array<[string, Record<string, unknown> | undefined]> = [];
  drainGhPaceLoopWaits((step, extra) => appended.push([step, extra]));
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], "github.pace.loop_wait");
  assert.equal(appended[0][1]?.wait_ms, 25);
  assert.deepEqual(takeGhPaceLoopWaits(), []);
});
