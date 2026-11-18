import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { mock, test } from "node:test";
import {
  DETACHED_DRAIN_DEFAULT_BOUND_MS, detachedSweepActionCount, detachSweepAction, drainDetachedSweepActions,
} from "#src/lib/sweep.js";

// W1-T13591 — W1-T13546's shard hang: one test left a detached retro running, and every later drain called with no
// options waited on it until its own test timed out, 120 s each. Such a drain now waits a bound, then fails once,
// naming what never settled, and no later drain waits on it again.

async function settleTurns(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

test("W1-T13591 criterion 1: a drain with no options fails at its bound, naming the detached action that never settled", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    detachSweepAction(new Promise<void>(() => {}), { actionKind: "retro", taskId: "DAEMON" });
    const seen: { outcome?: unknown } = {};
    const drained = drainDetachedSweepActions().then((v) => { seen.outcome = v; }, (e: unknown) => { seen.outcome = e; });
    await settleTurns();
    mock.timers.tick(DETACHED_DRAIN_DEFAULT_BOUND_MS - 1);
    await settleTurns();
    assert.ok(!("outcome" in seen), "control: one millisecond inside the bound the drain still waits");
    mock.timers.tick(1);
    await drained;
    const failure = seen.outcome;
    assert.ok(failure instanceof Error, "the drain fails at its bound");
    assert.match(failure.message, /1 detached action\(s\) did not settle within 30000 ms: retro for DAEMON/);
  } finally {
    mock.timers.reset();
  }
});

test("W1-T13591 criterion 2: after one drain reports a stalled action, the next drain does not wait on it", async () => {
  // Criterion 1 left its never-settling retro behind, as W1-T13546's leak did. A drain now returns at once.
  assert.equal(detachedSweepActionCount(), 0, "the reporting drain stopped tracking the stalled action");
  let finish!: () => void;
  detachSweepAction(new Promise<void>((resolve) => { finish = resolve; }), { actionKind: "retro", taskId: "LATER" });
  const drained = drainDetachedSweepActions();
  finish();
  assert.deepEqual(await drained, [], "a drain still waits for, and settles with, an action that does settle");
});

test("W1-T13591 criterion 3: invariant:explicit-bound-unchanged — a drain given a bound still returns its stragglers without throwing", async () => {
  let finish!: () => void;
  const before = detachedSweepActionCount();
  detachSweepAction(new Promise<void>((resolve) => { finish = resolve; }), { actionKind: "retro", taskId: "BOUNDED" });
  const stragglers = await drainDetachedSweepActions({ boundMs: 1 });
  assert.ok(stragglers.some((s) => s.actionKind === "retro" && s.taskId === "BOUNDED"), "the straggler is returned, not thrown");
  assert.equal(detachedSweepActionCount(), before + 1, "a bounded drain keeps tracking its straggler");
  finish();
  const after = await drainDetachedSweepActions({ boundMs: 1_000 });
  assert.ok(!after.some((s) => s.taskId === "BOUNDED"), "the straggler settles and leaves the registry");
});
