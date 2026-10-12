import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import * as daemon from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// W1-T5366 — A DISPATCH PHASE'S TICKER NEVER WAITS ON A FULL SWEEP BEFORE ITS LIGHT PASS. The in-flight
// ticker AWAITED its retriggered `runGatedSweep` (bound 559 s) before its light pass and `daemon.alive`, so
// on 2026-10-02 a 90-minute dispatch phase wrote no `daemon.alive` after 19:37 and ran no sweep from 19:51
// to 20:26. The retriggered pass now starts unawaited in the main loop's one background-sweep slot.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ticker-never-waits-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

type Line = { step: string; extra: Record<string, unknown> };

test("W1-T5366: a slow retriggered full sweep never delays the dispatch ticker's light pass or heartbeat", async () => {
  const lines: Line[] = [];
  let nowMs = 0;
  let sleeps = 0;
  let sweepCalls = 0;
  let activeSweeps = 0;
  let maxActiveSweeps = 0;
  let slowInFlight = false;
  let abandoned = false;
  let declinesWhileSlow = 0;
  let releaseDue = false;
  let releaseSlow: (() => void) | undefined;
  const slowSweep = new Promise<void>((resolve) => (releaseSlow = resolve));
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  let lightWhileSlow = 0;
  let aliveWhileSlow = 0;
  const merged = new Set<string>();
  const s = await daemon.runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      // Call 1 is the iteration's own pass; call 2, the first retrigger, hangs until released.
      sweep: async () => {
        sweepCalls++;
        activeSweeps++;
        maxActiveSweeps = Math.max(maxActiveSweeps, activeSweeps);
        if (sweepCalls === 2) {
          slowInFlight = true;
          await slowSweep;
        }
        activeSweeps--;
        if (sweepCalls >= 3) releaseRunOne?.();
      },
      sweepLight: async () => {
        if (slowInFlight && !abandoned) lightWhileSlow++;
      },
      now: () => new Date(nowMs),
      checkStop: () => undefined,
      checkPause: () => undefined,
      sleep: async () => {
        sleeps++;
        nowMs += 10;
        if (releaseDue && slowInFlight) {
          slowInFlight = false;
          lines.push({ step: "test.slow_sweep_released", extra: {} });
          releaseSlow?.();
          // A real sleep spans a timer, so the released pass has settled before the next tick reads the slot.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (sleeps >= 80) releaseRunOne?.();
      },
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "daemon.sweep.abandoned") abandoned = true;
        if (step === "daemon.alive" && extra.phase === "dispatch" && slowInFlight && !abandoned) aliveWhileSlow++;
        if (step === "daemon.sweep.skipped_concurrent" && slowInFlight && ++declinesWhileSlow >= 2) releaseDue = true;
      },
    },
    // A real-time bound long enough that only a ticker WAITING on the hung pass ever reaches it.
    { max: 1, sweepRetriggerIntervalMs: 30, sweepWallClockBoundMs: 2_000 },
  );
  releaseSlow?.();
  assert.deepEqual(s.merged, ["A"], "the dispatch phase still drains");
  assert.ok(sweepCalls >= 2, `fixture: the ticker retriggered the slow pass (saw ${sweepCalls} sweeps)`);
  assert.equal(abandoned, false, "the ticker never waited the hung pass out to its wall-clock bound");
  assert.ok(lightWhileSlow >= 2, `the light pass kept its cadence while the full pass ran (saw ${lightWhileSlow})`);
  assert.ok(aliveWhileSlow >= 2, `daemon.alive kept its cadence while the full pass ran (saw ${aliveWhileSlow})`);
  assert.equal(maxActiveSweeps, 1, "no second full sweep ever started while one was in flight");
  const declines = lines.filter((l) => l.step === "daemon.sweep.skipped_concurrent");
  assert.ok(
    declines.some((l) => l.extra.phase === "dispatch"),
    "a due retrigger that finds the slot taken is declined on the ledger and names its phase",
  );
  // Declines on consecutive ticks never advanced lastRunAtMs: the first tick after the release is
  // already due (30 ms since the slow pass STARTED), where an advanced clock would hold it 20 ms more.
  const released = lines.findIndex((l) => l.step === "test.slow_sweep_released");
  assert.ok(released > 0, "fixture: the slow pass was released mid-phase");
  const nextAlive = lines.findIndex((l, i) => i > released && l.step === "daemon.alive");
  const tickAfter = lines.slice(nextAlive + 1);
  const tickEnd = tickAfter.findIndex((l) => l.step === "daemon.alive");
  const rows = (tickEnd < 0 ? tickAfter : tickAfter.slice(0, tickEnd)).map((l) => l.step);
  assert.ok(rows.includes("daemon.sweep.retriggered"), `the first tick after the release retriggers (saw ${rows.join(", ")})`);
});
