// W1-T12057: measured 2026-11-10, about 545 daemon actions failed in three days because the gh pacer
// refused to sleep 8, 25 or 62 ms on the daemon loop. The gh call that follows blocks the loop for longer.
// The pacer now sleeps a wait within its own normal gap, records it, and still refuses a longer wait.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createGhCallPacer,
  createNonBlockingGhCallPacer,
  DEFAULT_GH_PACE_MIN_GAP_MS,
  DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS,
  GH_PACE_LOOP_WAIT_STEP,
  GhPaceWouldBlockError,
  paceGhEntry,
  takeGhPaceLoopWaits,
  withDaemonGhTransportFloor,
} from "#src/lib/github-transport.js";

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
