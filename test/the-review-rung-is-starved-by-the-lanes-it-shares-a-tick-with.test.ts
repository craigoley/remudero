import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/run-task.js";
import type { MergedSet } from "../src/lib/drain.js";

/**
 * W1-T2519 — THE REVIEW RUNG IS STARVED BY THE LANES IT SHARES A TICK WITH.
 *
 * `deps.sweep()` — the full reconciler, the ONLY thing that posts `remudero-review` on a PR no
 * run lane owns — used to run exactly once per top-of-iteration tick, and the tick could not come
 * back around to it until `Promise.allSettled` over that tick's admitted dispatch lanes (and any
 * fired retro) had settled. W1-T1272 already built the fix this task's rationale calls for
 * (design option (a) — "run the review rung on its own cadence, independent of the drain"): a
 * `sweepRetrigger` config threaded into `startInFlightTicker` (daemon.ts) that re-fires the full
 * sweep, gated by `runSweep`'s own cross-call mutex, on its OWN interval (`sweepRetriggerIntervalMs`,
 * default 20 minutes) WHILE a "dispatch" or "retro" phase holds the loop open — see
 * `test/daemon.test.ts`'s own "W1-T1272: a long-held dispatch re-triggers the full sweep more than
 * once without waiting for the iteration to end".
 *
 * What that mechanism did NOT do until this task: honour a STOP/PAUSE raised WHILE it is running.
 * `deps.checkStop`/`deps.checkPause` already gate the once-per-iteration `deps.sweep()` call at the
 * top of `runDaemon` (a hold observed there is never even reached) — but the retrigger fired on its
 * own clock, unconditionally, regardless of an operator hold requested mid-lane. This suite proves
 * the gap is closed: the retrigger now reads the SAME two predicates, on every tick it itself runs,
 * and withholds only a NEW full sweep — never the lane already in flight, which this change never
 * touches.
 *
 * This file intentionally imports and drives `runDaemon` exactly as `test/daemon.test.ts` already
 * does — same plan fixture shape, same fake-clock discipline — so a reviewer can diff the two
 * suites' style directly.
 */

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "review-rung-starved-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;
const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

/**
 * Shared shape for the "one lane held open for a long time" fixture every test below drives: a
 * single admitted task whose `runOne` never resolves until the test releases it, plus a fake clock
 * — `sleep` advances a shared `clock.nowMs` by `tickMs` and counts ticks, and `now` reads that SAME
 * clock — so "a long lane" is simulated in ticks of fake time, never real minutes, and the
 * retrigger's own `nowMs - last >= intervalMs` arithmetic (daemon.ts) actually measures against it
 * (a `now` that reads the real wall clock instead would see ~0ms elapsed across an all-microtask
 * fake `sleep` and never cross any interval worth testing).
 */
function longHeldLaneFixture(opts: { releaseAfterTicks: number; tickMs?: number }) {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const tickMs = opts.tickMs ?? 10;
  const clock = { nowMs: 0, ticks: 0 };
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async () => {
    clock.ticks++;
    clock.nowMs += tickMs;
    if (clock.ticks >= opts.releaseAfterTicks) releaseRunOne?.();
  };
  const now = () => new Date(clock.nowMs);
  const runOne: DaemonDeps["runOne"] = async (id) => {
    await runOneGate;
    merged.add(id);
    return okResult(id);
  };
  return { plan, merged, sleep, runOne, now, clock };
}

test("W1-T2519: the review rung runs on a cadence independent of the dispatch lane holding the tick", async () => {
  const { plan, sleep, runOne, now } = longHeldLaneFixture({ releaseAfterTicks: 20 });
  let sweepCalls = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne,
      sweep: async () => {
        sweepCalls += 1;
      },
      sweepLight: async () => {},
      now,
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  assert.equal(s.stopReason, "max_reached");
  // 1 (the once-per-iteration call before this lane was even admitted) + at least one more while
  // the ONE admitted lane's `runOne` was still held open — proving the review rung's cadence does
  // not wait for that lane.
  assert.ok(sweepCalls > 1, `expected more than one full sweep while the single lane was in flight (saw ${sweepCalls})`);
});

test("W1-T2519: a long-running lane no longer delays the next review beyond the retrigger interval", async () => {
  const { plan, sleep, runOne, now, clock } = longHeldLaneFixture({ releaseAfterTicks: 300, tickMs: 1 });
  const sweepAtMs: number[] = [];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne,
      sweep: async () => {
        sweepAtMs.push(clock.nowMs);
      },
      sweepLight: async () => {},
      now,
      sleep,
    },
    { max: 1, pollIntervalMs: 1, sweepRetriggerIntervalMs: 50 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(sweepAtMs.length >= 3, `expected several reviews across the one long lane (saw ${sweepAtMs.length})`);
  // The GAP between any two consecutive reviews is bounded by the retrigger interval — never by
  // how much longer the lane itself still had to run. Before this task's independent cadence
  // existed, the second entry here would never appear until the lane's OWN duration had elapsed.
  for (let i = 1; i < sweepAtMs.length; i++) {
    const gap = sweepAtMs[i] - sweepAtMs[i - 1];
    assert.ok(gap <= 50 + 1, `review gap ${gap}ms exceeded the retrigger interval (50ms) — lane duration leaked through`);
  }
});

test("W1-T2519: two concurrent sweep callers never overlap — the daemon serializes the once-per-iteration call against every retrigger", async () => {
  const { plan, sleep, runOne, now } = longHeldLaneFixture({ releaseAfterTicks: 20 });
  let inFlight = 0;
  let maxInFlight = 0;
  let sweepCalls = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne,
      sweep: async () => {
        sweepCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A microtask-only gap — never a real timer, this suite's clock is fake and always
        // resolves synchronously — is enough to surface a genuine overlap: a caller that ever
        // started a second `deps.sweep()` before this one finished would increment `inFlight`
        // while this call is still suspended here (the same discipline `test/daemon.test.ts`'s
        // "W1-T1272: the sweep still runs one at a time" fixture uses, reused verbatim).
        await Promise.resolve();
        inFlight -= 1;
      },
      sweepLight: async () => {},
      now,
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(sweepCalls > 1, `expected the retrigger to have fired at least once (saw ${sweepCalls})`);
  assert.equal(maxInFlight, 1, "no two `deps.sweep()` calls (once-per-iteration or retriggered) ever overlapped — never the same head reviewed twice at once");
});

test("W1-T2519: STOP raised mid-lane halts the independent cadence exactly as it halts dispatch — no new sweep starts, but the in-flight lane still runs to completion", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let nowMs = 0;
  let ticks = 0;
  let stopped = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 10;
    // The operator raises STOP partway through the lane — well after the first couple of
    // retriggers would have had a chance to fire, well before the lane itself is released.
    if (ticks === 8) stopped = true;
    if (ticks >= 30) releaseRunOne?.();
  };
  let sweepCalls = 0;
  let sweepCallsAtStop: number | undefined;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweep: async () => {
        sweepCalls += 1;
      },
      sweepLight: async () => {},
      checkStop: () => {
        if (stopped && sweepCallsAtStop === undefined) sweepCallsAtStop = sweepCalls;
        return stopped ? "STOP requested mid-lane" : undefined;
      },
      now: () => new Date(nowMs),
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  // The lane admitted before STOP was raised still ran to completion and merged — STOP never
  // aborts a lane already in flight.
  assert.deepEqual(s.merged, ["A"], "the already-admitted lane was never aborted by STOP");
  assert.ok(sweepCallsAtStop !== undefined, "the fixture's own STOP transition must actually have been observed");
  const finalCount = sweepCalls;
  assert.ok(finalCount - sweepCallsAtStop! <= 1, `expected at most one more sweep after STOP was observed (an already-in-flight one), saw ${finalCount - sweepCallsAtStop!} more`);
});

test("W1-T2519: PAUSE gates the independent cadence identically to STOP — and identically to how quiet hours would, via the SAME generic checkPause predicate", async () => {
  // `checkPause` is the one generic per-tick hold hook `runDaemon` already reads for BOTH a
  // literal operator PAUSE and (per fleet-control.ts's own doc: "quiet hours ... does not gate
  // the drain loop by itself [today]; the scheduler that reads it ... is later work") whatever a
  // future caller composes into that same predicate. This daemon module stays pure — it never
  // knows or cares WHICH reason string it was handed — so proving the retrigger honours an
  // arbitrary truthy `checkPause()` reason proves it would honour a quiet-hours-flavoured one
  // exactly the same way, with no daemon.ts change required when that wiring lands.
  const plan = fixturePlan();
  const merged = new Set<string>();
  let nowMs = 0;
  let ticks = 0;
  let paused = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 10;
    if (ticks === 8) paused = true;
    if (ticks >= 30) releaseRunOne?.();
  };
  let sweepCalls = 0;
  let sweepCallsAtPause: number | undefined;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweep: async () => {
        sweepCalls += 1;
      },
      sweepLight: async () => {},
      // A quiet-hours-flavoured detail string on purpose — daemon.ts never inspects the content.
      checkPause: () => {
        if (paused && sweepCallsAtPause === undefined) sweepCallsAtPause = sweepCalls;
        return paused ? "QUIET_HOURS active — holding rather than dispatching" : undefined;
      },
      now: () => new Date(nowMs),
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  assert.deepEqual(s.merged, ["A"], "the already-admitted lane was never aborted by the pause-shaped hold");
  assert.ok(sweepCallsAtPause !== undefined, "the fixture's own pause transition must actually have been observed");
  const finalCount = sweepCalls;
  assert.ok(finalCount - sweepCallsAtPause! <= 1, `expected at most one more sweep after the hold was observed, saw ${finalCount - sweepCallsAtPause!} more`);
});

test("W1-T2519: a lane already admitted or running is never aborted by this change", async () => {
  // Same shape as the STOP test above, but the assertion is squarely on the LANE's own outcome
  // rather than the sweep count: `runOne` must be awaited to full completion (merged, verdict
  // returned) even though a hold was raised, and observed, while it was still in flight.
  const plan = fixturePlan();
  const merged = new Set<string>();
  let nowMs = 0;
  let ticks = 0;
  let stopped = false;
  let runOneStarted = false;
  let runOneFinished = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 10;
    if (ticks === 5) stopped = true;
    if (ticks >= 15) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        runOneStarted = true;
        await runOneGate;
        merged.add(id);
        runOneFinished = true;
        return okResult(id);
      },
      sweep: async () => {},
      sweepLight: async () => {},
      checkStop: () => (stopped ? "STOP requested mid-lane" : undefined),
      now: () => new Date(nowMs),
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  assert.ok(runOneStarted, "the lane was admitted and started");
  assert.ok(runOneFinished, "the lane ran all the way to completion despite the mid-flight hold");
  assert.deepEqual(s.merged, ["A"]);
  assert.equal(s.stopReason, "max_reached", "the lane's own completion — not an abort — is what ended this bounded run");
});

test("W1-T2519: a daemon with no lanes running behaves exactly as it did before this change (idle ticks are untouched)", async () => {
  // An empty plan never admits anything, so the "dispatch" ticker this task's fix lives inside
  // never even starts — proving the new STOP/PAUSE gate inside it can never fire, let alone
  // change, an idle daemon's behaviour.
  const dir = mkdtempSync(join(tmpdir(), "review-rung-starved-idle-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "[]\n");
  const plan = loadPlan(f);
  const steps: string[] = [];
  let sweepCalls = 0;
  // `max` counts ADMITTED dispatches (`attempted.length`), never idle ticks — an all-empty plan
  // never admits anything, so `max` alone would never end this run. `checkStop` after a handful of
  // GENUINE top-of-iteration idle passes is this suite's own stand-in for the daemon's ordinary
  // "keep polling forever" idle behaviour, which `runDaemon` never bounds on its own. Counted off
  // the `daemon.idle` LOG LINE rather than raw `sleep()` calls: the once-per-iteration sweep call
  // above starts its OWN "sweep"-phase in-flight ticker (`startInFlightTicker`, daemon.ts), which
  // also calls `deps.sleep` while it waits for `deps.sweep()` to resolve — on an all-microtask
  // fake clock like this fixture's, that inner loop can tick several times before the outer sweep
  // promise's own longer microtask chain settles, so raw sleep-call counting conflates "the sweep
  // phase ticked" with "a whole top-of-iteration idle pass completed".
  let idleLogCount = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw new Error("FALSIFIER: nothing is dispatchable from an empty plan");
      },
      sweep: async () => {
        sweepCalls += 1;
      },
      sweepLight: async () => {},
      checkStop: () => (idleLogCount >= 3 ? "three idle ticks observed" : undefined),
      log: (step) => {
        steps.push(step);
        if (step === "daemon.idle") idleLogCount++;
      },
      sleep: async () => {},
    },
    { sweepRetriggerIntervalMs: 5 },
  );
  assert.equal(s.stopReason, "stopped");
  assert.ok(steps.includes("daemon.idle"), "an idle tick still logs daemon.idle exactly as before");
  assert.ok(!steps.includes("daemon.sweep.retriggered"), "an idle daemon never starts the dispatch ticker, so it never retriggers");
  assert.ok(!steps.includes("daemon.sweep.retrigger_held"), "an idle daemon never even reaches the new STOP/PAUSE gate — there is no ticker to hold");
  // Exactly the once-per-iteration sweep, once per tick — unchanged from before this task.
  assert.equal(sweepCalls, 3, `expected exactly one full sweep per idle tick (saw ${sweepCalls} across 3 ticks)`);
});

test("W1-T2519: restoring the shared tick (an interval no lane can ever reach) makes the long-lane-delays-review assertion fail", async () => {
  // The counterfactual named by this task's own acceptance list: prove the independent cadence is
  // what does the work, not a coincidence of the fixture. Setting the retrigger interval far
  // beyond the lane's own duration reproduces the ORIGINAL, shared-tick behaviour this task
  // exists to fix — `deps.sweep()` runs once, at the top of the iteration, and does not run again
  // until the lane settles — so the SAME assertion the first test in this file makes (`sweepCalls
  // > 1`) must now fail.
  const { plan, sleep, runOne, now } = longHeldLaneFixture({ releaseAfterTicks: 20 });
  let sweepCalls = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne,
      sweep: async () => {
        sweepCalls += 1;
      },
      sweepLight: async () => {},
      now,
      sleep,
    },
    // An interval effectively unreachable within this fixture's 20-tick lane: the shared-tick
    // world this task's rationale describes, where the review rung's period is
    // `pollIntervalMs + max(lane duration)`, never its own cadence.
    { max: 1, sweepRetriggerIntervalMs: 1_000_000 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.equal(sweepCalls, 1, `expected exactly the ONE once-per-iteration sweep with the shared-tick interval restored (saw ${sweepCalls}) — the independent cadence must be what produced >1 in the earlier test, not chance`);
});
