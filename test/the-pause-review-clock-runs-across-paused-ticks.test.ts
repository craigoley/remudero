/**
 * W1-T5803 — THE PAUSE REVIEW CLOCK RUNS ACROSS PAUSED TICKS.
 *
 * LIVE 2026-10-05, run DAEMON-1791176702134 (poll_interval_ms 60000): under the 05:10Z recycle
 * PAUSE, 33 `daemon.pause` rows and ONE `daemon.pause.review_passes`. Each paused tick started a
 * fresh pause clock, slept one poll interval and stopped it, so the clock's interval restarted
 * every tick and stop() won the race; and a GitHub event resolved only the paused tick's own
 * sleep (the wake signal's first waiter), ending the tick before the clock ever saw it.
 *
 * The fixture drives the REAL `createSweepWakeSignal` on a virtual timer queue, so the
 * first-waiter ordering is production's, and `deps.now` reads the same virtual instant.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type LightPassScope } from "../src/lib/daemon.js";
import { createSweepWakeSignal, type SweepWakeTimerDeps } from "../src/lib/github-event-wake.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const POLL_MS = 10_000; // the clock's quantum is min(POLL_MS, 1000) = 1000
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5803-plan-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

type Row = { step: string; extra: Record<string, unknown>; atMs: number };

/** A virtual timer queue: the driver fires the earliest live timer only once every party has
 *  settled onto a wait, so concurrency is deterministic and no real time passes. */
function virtualTimers(startMs: number) {
  let nowMs = startMs;
  let seq = 0;
  type Timer = { dueMs: number; seq: number; callback: () => void; cancelled: boolean };
  const timers: Timer[] = [];
  const deps: SweepWakeTimerDeps = {
    setTimer(callback, ms) {
      const timer: Timer = { dueMs: nowMs + ms, seq: seq++, callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as Timer).cancelled = true;
    },
  };
  const fireNext = (): boolean => {
    const live = timers.filter((t) => !t.cancelled).sort((a, b) => a.dueMs - b.dueMs || a.seq - b.seq);
    const next = live[0];
    if (!next) return false;
    next.cancelled = true;
    nowMs = Math.max(nowMs, next.dueMs);
    next.callback();
    return true;
  };
  return { deps, fireNext, now: () => nowMs };
}

async function runPausedFleet(opts: { pausedTicks: number; wakeAtMs?: number; unpausedTicks: number; failSleepOnTick?: number }) {
  const startMs = Date.parse("2026-10-05T05:10:00.000Z");
  const vt = virtualTimers(startMs);
  const signal = createSweepWakeSignal(false, vt.deps);
  const rows: Row[] = [];
  const passes: Array<LightPassScope | undefined> = [];
  const pauseRows = () => rows.filter((r) => r.step === "daemon.pause").length;
  let ticksAfterUnpause = 0;
  if (opts.wakeAtMs !== undefined) vt.deps.setTimer(() => signal.wake(), opts.wakeAtMs);

  let done = false;
  const daemon = runDaemon(fixturePlan(), {
    refreshMerged: () => () => true, // A is merged: nothing is runnable once the pause ends
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id}`);
    },
    now: () => new Date(vt.now()),
    checkPause: () => (pauseRows() < opts.pausedTicks ? "PAUSE held — container recycle" : undefined),
    checkStop: () => (ticksAfterUnpause > opts.unpausedTicks ? "test done" : undefined),
    sleepUntilSweepWake: (ms) =>
      ms === POLL_MS && pauseRows() === opts.failSleepOnTick ? Promise.reject(new Error("sleep seam failed")) : signal.sleep(ms),
    sleep: async (ms) => {
      await signal.sleep(ms);
    },
    sweepLight: async (scope?: LightPassScope) => {
      passes.push(scope);
    },
    log: (step, extra = {}) => {
      if (step === "daemon.tick" && pauseRows() >= opts.pausedTicks) ticksAfterUnpause += 1;
      rows.push({ step, extra, atMs: vt.now() - startMs });
    },
  }, { pollIntervalMs: POLL_MS }).catch((e: Error) => e).finally(() => {
    done = true;
  });

  for (let guard = 0; !done && guard < 10_000; guard += 1) {
    for (let i = 0; i < 25; i += 1) await settle();
    if (done) break;
    vt.fireNext();
  }
  const summary = await daemon;
  const clockWaitStillQueued = vt.fireNext();
  signal.close();
  return { summary, rows, passes, clockWaitStillQueued };
}

test("W1-T5803: the pause review clock runs across paused ticks", async () => {
  const { summary, rows } = await runPausedFleet({ pausedTicks: 10, unpausedTicks: 3 });
  assert.ok(!(summary instanceof Error) && summary.stopReason === "stopped", String(summary));
  assert.equal(rows.filter((r) => r.step === "daemon.pause").length, 10, "ten paused ticks ran");

  const pausePasses = rows.filter((r) => r.step === "daemon.review_clock.pass" && r.extra.during_pause === true);
  assert.ok(pausePasses.length >= 9,
    `ten paused ticks of one poll interval each run at least nine review-only passes (saw ${pausePasses.length})`);
  // The per-tick row keeps its shape: { tick, passes }, and it accounts for every pass exactly once.
  const tickRows = rows.filter((r) => r.step === "daemon.pause.review_passes");
  assert.ok(tickRows.every((r) => typeof r.extra.tick === "number" && typeof r.extra.passes === "number"
    && Object.keys(r.extra).length === 2), JSON.stringify(tickRows));
  const reported = tickRows.reduce((sum, r) => sum + (r.extra.passes as number), 0);
  assert.equal(reported, pausePasses.length, "the per-tick rows count every pause pass exactly once");

  // The clock stops on the first unpaused tick: no pause pass is ledgered once that tick begins,
  // though the fixture keeps running unpaused for several more poll intervals.
  const lastPauseIdx = rows.map((r) => r.step).lastIndexOf("daemon.pause");
  const unpausedTick = rows.find((r, i) => i > lastPauseIdx && r.step === "daemon.tick");
  assert.ok(unpausedTick, "the fixture reached an unpaused tick");
  const stopByMs = unpausedTick.atMs + 1_000; // stop() lets the clock's current quantum wait end
  const lateRows = rows.filter((r) => r.atMs > stopByMs
    && (r.extra.during_pause === true || r.step === "daemon.pause.review_passes"));
  assert.deepEqual(lateRows, [], "the pause clock stopped on the first unpaused tick");
  const endMs = rows[rows.length - 1]!.atMs;
  assert.ok(endMs >= 12 * POLL_MS, `the fixture ran past the pause for whole intervals (ended at ${endMs} ms)`);
});

test("W1-T5803: a paused tick ended by an event wake runs a pass for it", async () => {
  // 13.5 s: inside the second paused tick, after the clock re-queued its quantum wait behind that
  // tick's own sleep — the first waiter, the one production's wake() resolves.
  const { rows } = await runPausedFleet({ pausedTicks: 3, wakeAtMs: 13_500, unpausedTicks: 1 });
  const pauseRows = rows.filter((r) => r.step === "daemon.pause");
  assert.ok(pauseRows[2]!.atMs < 2 * POLL_MS, `the event wake ended the second paused tick early (at ${pauseRows[2]!.atMs} ms)`);
  const consumed = rows.filter((r) => r.step === "daemon.review_clock.wake_consumed" && r.extra.during_pause === true);
  assert.equal(consumed.length, 1, `the wake that ended a paused tick ran a pass for it (saw ${JSON.stringify(consumed)})`);
  assert.ok(consumed[0]!.atMs >= 13_500 && consumed[0]!.atMs <= 13_500 + 2_000, `promptly, within a quantum or two (at ${consumed[0]!.atMs} ms)`);
});

test("W1-T5803: a paused sleep that throws still stops the pause review clock", async () => {
  const { summary, rows, clockWaitStillQueued } = await runPausedFleet({ pausedTicks: 5, unpausedTicks: 1, failSleepOnTick: 3 });
  assert.ok(summary instanceof Error && summary.message === "sleep seam failed", String(summary));
  assert.ok(rows.some((r) => r.step === "daemon.review_clock.pass" && r.extra.during_pause === true), "the clock ran before the throw");
  assert.equal(clockWaitStillQueued, false, "no clock wait outlives the failed tick — the clock was stopped");
});
