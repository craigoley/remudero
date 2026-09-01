// W1-T2565: the account-headroom governor sampled on the very loop whose duration it was meant to
// bound, so the longer a tick spent, the longer the fleet went unmeasured.
//
// `daemon.headroom` is written once per `runOne` iteration and the read sits AFTER `runGatedSweep`
// — the sweep that carries the inbox-draft rung, the largest single spender. MEASURED 2026-09-01
// over the three-form ledger union: gaps run median 158s but p95 4,400s and max 21,586s (six
// hours). In one 58-minute window (09:17:25 -> 10:15:26) the account went from 30% used to
// exhausted while the governor held its last value; 472 session-limit refusals in that period all
// resolve to that single stale 30% reading, and no `usage.probe_failed` row was written either.
//
// THE CADENCE ALREADY EXISTED. `startInFlightTicker` runs every poll interval for the whole of a
// long phase and already samples DISK headroom there. Across that same 58-minute window: 43 ticker
// passes, 43 carrying `disk_free_bytes`, ZERO carrying an account reading. The probe is free — a
// control-only SDK session over an async generator that yields nothing — so nothing forced the
// sparse cadence.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { HEADROOM_SAMPLE_MAX_AGE_MS, runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "headroom-blind-window-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const snapAt = (pct: number): UsageSnapshot => ({
  billingMode: "subscription",
  session: { percentUsed: pct, resetsAt: "2026-09-01T12:00:00.000Z" },
  weekly: [],
});

/** One long in-flight phase, with a controllable clock — the shape the blind window actually had:
 *  the ticker fires many times while the main loop is stuck inside one iteration. */
function driveLongPhase(opts: { ticks: number; msPerTick: number; readUsage?: DaemonDeps["readUsage"] }) {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-09-01T09:00:00.000Z");
  let releaseRunOne: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  let sleeps = 0;
  const runPromise = runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await gate;
        merged.add(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" } as RunResult;
      },
      sweepLight: async () => {},
      // EVERY tick advances the injected clock, so staleness is driven by the test rather than by
      // real elapsed time — the fixed-date/real-clock mismatch this repo has been bitten by.
      sleep: async () => {
        sleeps++;
        nowMs += opts.msPerTick;
        if (sleeps >= opts.ticks) releaseRunOne?.();
      },
      now: () => new Date(nowMs),
      ...(opts.readUsage ? { readUsage: opts.readUsage } : {}),
      log: (step, ex = {}) => lines.push({ step, extra: ex }),
    },
    { max: 1 },
  );
  return { runPromise, lines, sleeps: () => sleeps };
}

test("a long in-flight phase is SAMPLED — the governor no longer goes blind for the whole of it", async () => {
  let reads = 0;
  const { runPromise, lines } = driveLongPhase({
    // Each tick advances well past the staleness bound, so every pass is due for a sample.
    ticks: 6,
    msPerTick: HEADROOM_SAMPLE_MAX_AGE_MS + 1_000,
    readUsage: async () => {
      reads++;
      return snapAt(30);
    },
  });
  await runPromise;

  const alive = lines.filter((l) => l.step === "daemon.alive");
  const inFlight = lines.filter((l) => l.step === "daemon.headroom" && l.extra.source === "in-flight");
  assert.ok(alive.length >= 3, `the ticker must actually be running; saw ${alive.length} daemon.alive rows`);
  assert.ok(
    inFlight.length >= 1,
    `a long phase must produce at least one in-flight headroom reading — the measured window produced ${43} ticker passes and ZERO. Saw ${inFlight.length}.`,
  );
  assert.ok(reads >= 1, "and the probe must genuinely have been called, not the row fabricated");
  const r = inFlight[0].extra;
  assert.equal(r.percent_used, 30);
  assert.equal(r.window, "session (5h)", "the row must carry the same shape every daemon.headroom consumer already parses");
  assert.equal(typeof r.over_ceiling, "boolean");
  assert.equal(r.phase !== undefined, true, "and name the phase it was taken during");
});

test("a phase SHORTER than the staleness bound is not sampled — this bounds staleness, it does not set a rate", async () => {
  let reads = 0;
  const { runPromise, lines } = driveLongPhase({
    ticks: 4,
    msPerTick: 1_000, // nowhere near HEADROOM_SAMPLE_MAX_AGE_MS
    readUsage: async () => {
      reads++;
      return snapAt(30);
    },
  });
  await runPromise;
  const inFlight = lines.filter((l) => l.step === "daemon.headroom" && l.extra.source === "in-flight");
  assert.equal(
    inFlight.length,
    0,
    "on a healthy fleet the main loop re-reads before the bound elapses, so this sampler must fire never",
  );
  assert.ok(reads >= 1, "the MAIN loop still takes its own authoritative reading — the control that this test is not vacuous");
});

test("a THROWING probe costs one skipped sample, never the liveness heartbeat", async () => {
  // The first call is the MAIN loop's own authoritative read, which is UNGUARDED on origin/main —
  // a throw there takes the daemon loop down, and that is a pre-existing defect this task does not
  // widen its scope to fix (noted in the PR body instead). Letting it succeed isolates the arm
  // under test: every LATER call is the in-flight ticker's, and those must be swallowed.
  let calls = 0;
  const { runPromise, lines } = driveLongPhase({
    ticks: 6,
    msPerTick: HEADROOM_SAMPLE_MAX_AGE_MS + 1_000,
    readUsage: async () => {
      calls++;
      if (calls === 1) return snapAt(30);
      throw new Error("usage control request threw");
    },
  });
  await runPromise;
  const alive = lines.filter((l) => l.step === "daemon.alive");
  const inFlight = lines.filter((l) => l.step === "daemon.headroom" && l.extra.source === "in-flight");
  assert.ok(alive.length >= 3, `a throwing probe must not stop the ticker; saw ${alive.length} daemon.alive rows`);
  assert.equal(inFlight.length, 0, "an unreadable probe is an ABSENT sample, never a fabricated one");
  assert.ok(calls > 1, "the ticker must genuinely have attempted a read — otherwise this asserts nothing");
});

test("a daemon with NO readUsage wired samples nothing and still ticks — the seam is optional", async () => {
  const { runPromise, lines } = driveLongPhase({ ticks: 5, msPerTick: HEADROOM_SAMPLE_MAX_AGE_MS + 1_000 });
  await runPromise;
  assert.ok(lines.filter((l) => l.step === "daemon.alive").length >= 3);
  assert.equal(lines.filter((l) => l.step === "daemon.headroom").length, 0);
});

test("the staleness bound is minutes, not hours — the measured gap it has to beat was 58 minutes", () => {
  assert.ok(HEADROOM_SAMPLE_MAX_AGE_MS > 0);
  assert.ok(
    HEADROOM_SAMPLE_MAX_AGE_MS <= 15 * 60_000,
    `a bound above ~15min would not have closed the measured 58-minute window; it is ${HEADROOM_SAMPLE_MAX_AGE_MS}ms`,
  );
});
