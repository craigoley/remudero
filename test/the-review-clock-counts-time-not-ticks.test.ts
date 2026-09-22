/**
 * W1-T4045 — the inter-phase review clock counts TIME as well as ticks.
 *
 * Each fake wait stands for one trip round the event loop. `blockMs` is how much real time that trip
 * took: 0 for a free loop, ~9 s for one synchronous ledger-union read (measured, W1-T4046). The old
 * clock added a nominal quantum per wait, so a blocked loop needed sixty waits to reach a 60 s
 * interval; the new one reaches it after sixty real seconds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { startInterphaseReviewClock, type DaemonDeps } from "../src/lib/daemon.js";

const POLL_MS = 60_000; // quantum = min(POLL_MS, 1000) = 1000

/** Drive the clock through exactly `waits` waits, each costing `blockMs` of real time. */
async function drive(opts: { waits: number; blockMs: number; firstIsWake?: boolean }) {
  let nowMs = Date.parse("2026-09-22T13:19:23.868Z");
  let calls = 0;
  let passes = 0;
  const steps: string[] = [];
  let reached: () => void = () => {};
  const done = new Promise<void>((resolve) => { reached = resolve; });
  const deps = {
    now: () => new Date(nowMs),
    sleepUntilSweepWake: async (): Promise<"wake" | "timeout"> => {
      // Signal on ENTRY to the wait AFTER the last one we drive: the clock only calls again once it
      // has fully handled the previous wake — including running any pass it earned. Signalling from
      // inside the last wait instead lets stop() win the race and cancel that pass.
      if (calls >= opts.waits) {
        reached();
        await new Promise((r) => setImmediate(r));
        return "timeout";
      }
      await new Promise((r) => setImmediate(r));
      calls += 1;
      nowMs += opts.blockMs;
      return opts.firstIsWake && calls === 1 ? "wake" : "timeout";
    },
    sweepLight: async () => { passes += 1; },
  } as unknown as DaemonDeps;
  const clock = startInterphaseReviewClock(deps, POLL_MS, (step) => steps.push(step));
  await done;
  await clock.stop();
  return { passes, steps, calls };
}

test("W1-T4045: a blocked loop fires the review clock on elapsed time not tick count", async () => {
  // Six trips of ten seconds each is sixty real seconds — a full review interval.
  const blocked = await drive({ waits: 6, blockMs: 10_000 });
  assert.equal(blocked.passes, 1, "sixty real seconds must run one review pass, not wait for sixty ticks");
  // CONTROL: one trip short of the interval runs nothing, so the pass above was earned, not free.
  const short = await drive({ waits: 5, blockMs: 10_000 });
  assert.equal(short.passes, 0);
});

test("W1-T4045: with time frozen the clock still fires after its tick budget", async () => {
  // Every existing fixture freezes its clock. The tick budget must still govern there, unchanged.
  assert.equal((await drive({ waits: 59, blockMs: 0 })).passes, 0, "59 ticks is short of a 60 s interval");
  assert.equal((await drive({ waits: 60, blockMs: 0 })).passes, 1, "the 60th tick runs the pass, exactly as before");
});

test("W1-T4045: a GitHub wake still starts a pass at once", async () => {
  const woke = await drive({ waits: 1, blockMs: 0, firstIsWake: true });
  assert.equal(woke.passes, 1);
  assert.ok(woke.steps.includes("daemon.review_clock.wake_consumed"));
});
