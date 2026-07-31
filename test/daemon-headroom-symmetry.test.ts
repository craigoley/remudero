import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";

/**
 * THE HEADROOM HEARTBEAT MUST BE SYMMETRIC. This file is the regression lock on that, and it
 * lives apart from test/daemon.test.ts deliberately (the house rule against parking
 * coverage-load-bearing tests in a file that has crashed at FILE level under
 * `--experimental-test-coverage`).
 *
 * WHAT WAS WRONG. `runDaemon`'s headroom block read, in substance:
 *
 *     if (headroomEnabled) { if (over) { ...log("daemon.headroom", ...); ...continue; } }
 *     else                 { log("daemon.headroom", { ..., enforced: false, note: "..." }); }
 *
 * There was NO `else` on the inner `if (over)`. So the single most common posture for a healthy
 * fleet — governor ARMED, usage comfortably UNDER the ceiling — logged NOTHING AT ALL.
 *
 * THAT IS NOT HYPOTHETICAL. Measured on this host, over the live ledger unioned with all 661
 * rotations: 1,243 `daemon.headroom` lines, of which 922 carry `enforced: false` and 321 carry no
 * `enforced` key at all (the pre-symmetry over-ceiling branch never set it). **ZERO carry
 * `enforced: true`** — in the whole recorded history of this fleet there has never been an
 * armed-and-under heartbeat, because the code could not emit one. The operator armed the governor
 * on 2026-07-31 and the newest `daemon.headroom` line anywhere is still `14:59:05.671Z`,
 * `enforced: false`, from before the switch.
 *
 * A console panel keyed on that step would therefore have rendered permanently-frozen numbers and
 * been believed. These two tests are what stops that from coming back.
 */

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  acceptance:
    - claim: a
      proof: unit test
  verify: auto
  status: queued
`;

function fixturePlan() {
  const dir = mkdtempSync(join(tmpdir(), "headroom-symmetry-plan-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, YAML);
  return loadPlan(path);
}

const NONE_MERGED: MergedSet = () => false;

function okResult(taskId: string): RunResult {
  return { taskId, runId: `RUN-${taskId}`, merged: true, costUsd: 0, verdict: "merged" } as RunResult;
}

/**
 * The UNDER-CEILING reading, taken from a REAL capture rather than invented: these are the
 * percentages and reset instants this host's own `~/.claude.json` `cachedUsageUtilization` block
 * held at 2026-07-31T16:46:53Z (five_hour 3%, seven_day 0%), which is the account the operator
 * switched to that afternoon. A hand-picked "50%" would have proven the same branch, but this is
 * the reading the panel is actually being built to display, and an invented one is exactly how a
 * fixture ends up agreeing with a bug instead of with the world.
 */
const UNDER_CEILING: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 3, resetsAt: "2026-07-31T20:49:59.209107+00:00" },
  weekly: [{ label: "all models", percentUsed: 0, resetsAt: "2026-08-02T04:59:59.209129+00:00" }],
};

/**
 * The OVER-CEILING reading, likewise real: the values off this fleet's own last enforcing
 * heartbeat, ledger line `2026-07-25T14:02:24.640Z` — `"percent_used": 99, "limit_pct": 95,
 * "window": "weekly (all models)"`.
 */
const OVER_CEILING: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 42, resetsAt: "2026-07-25T18:00:00.000Z" },
  weekly: [{ label: "all models", percentUsed: 99, resetsAt: "2026-07-28T04:00:00.000Z" }],
};

/** Fixed clock, far enough from either reset that the time-aware ceiling stays at the reserve. */
const JUL_20_2026_2200 = () => new Date("2026-07-20T22:00:00.000Z");

test("governor ARMED and usage UNDER the ceiling still emits a daemon.headroom heartbeat, tagged enforced true", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let spawned = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        spawned++;
        return okResult(id);
      },
      readUsage: () => UNDER_CEILING,
      now: JUL_20_2026_2200,
      checkStop: () => undefined,
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: true, max: 1 },
  );

  // ASSERT THE LINE, not that the code ran. This is the whole point of the lock: before the fix
  // the daemon reached exactly this state, dispatched happily, and wrote no headroom line at all.
  const beats = lines.filter((l) => l.step === "daemon.headroom");
  assert.equal(beats.length >= 1, true, "an ARMED-and-UNDER tick must still write a daemon.headroom line");
  const beat = beats[0].extra;
  assert.equal(beat.enforced, true, "the line must say the governor IS enforcing — this is how the console tells ARMED from telemetry-only");
  assert.equal(beat.over_ceiling, false, "under the ceiling");
  assert.equal(beat.percent_used, 3, "the most-burned window's real reading rides the line");
  assert.equal(beat.window, "session (5h)", "most-burned-first: 3% session outranks the 0% weekly");
  assert.equal(typeof beat.resets_at, "string");
  assert.equal(typeof beat.limit_pct, "number");
  assert.equal(beat.note, undefined, "the telemetry-only note belongs to the DISABLED posture, not this one");

  // …and enforcement genuinely did not engage: under the ceiling the daemon dispatches.
  assert.equal(spawned >= 1, true, "an under-ceiling armed governor never pauses dispatch");
  assert.equal(s.stopReason, "max_reached");
});

test("governor ARMED and OVER the ceiling is unchanged — it still pauses, still escalates once per episode, still emits", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "headroom-symmetry-over-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const breaches: Array<{ window: string; percentUsed: number }> = [];
  let spawned = 0;
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    // A "test operator" ends the idle loop after a few heartbeats — headroom exhaustion by itself
    // never exits (KeepAlive would relaunch straight into the same reading).
    if (sleeps >= 3) requestStop(root, "test done polling — headroom never freed up");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      spawned++;
      return okResult(id);
    },
    readUsage: () => OVER_CEILING,
    now: JUL_20_2026_2200,
    checkStop: () => stopDetail(root),
    sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    onHeadroomBreach: async (b) => {
      breaches.push({ window: b.window, percentUsed: b.percentUsed });
    },
  });

  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0, "STILL PAUSES: no task spawns while a window is at/over its limit");
  assert.equal(s.ticks >= 3, true, "STILL IDLES in-process via the injected clock rather than exiting");
  assert.equal(sleeps, s.ticks, "one sleep() per idle heartbeat tick — the pacing is unchanged");
  assert.equal(breaches.length, 1, "STILL ESCALATES EXACTLY ONCE per breach episode, across every tick of it");
  assert.equal(breaches[0].percentUsed, 99);

  const beats = lines.filter((l) => l.step === "daemon.headroom");
  assert.equal(beats.length >= 3, true, "STILL EMITS one heartbeat per idle tick");
  assert.equal(beats[0].extra.window, "weekly (all models)", "the OFFENDING window, not merely the most-burned one");
  assert.equal(beats[0].extra.percent_used, 99);
  assert.equal(beats[0].extra.limit_pct, 95);
  assert.equal(beats[0].extra.enforced, true);
  assert.equal(beats[0].extra.over_ceiling, true);
  // The idle-tick counter still rides the line, and still counts up within the one process (a
  // launchd relaunch would reset it to 1 — this is also the no-restart-storm falsifier).
  assert.equal(beats[0].extra.tick, 1);
  assert.equal(beats[2].extra.tick, 3);
});
