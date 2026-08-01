import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/lib/run-result.js";

// ── W1-T276: the RETRO SWEEP TICKER ─────────────────────────────────────────
//
// `runOne` is wrapped by a light-sweep ticker (W1-T254, the #707 fix) so a
// long dispatch never blinds the sweep — but `runRetroTrigger` was a bare
// `await` in the same single-threaded `for (;;)` loop, with nothing ticking
// while it ran. MEASURED over the live ledger: the retro fired twice, holding
// the loop for 22.0 and 21.0 minutes respectively, with ZERO sweep
// dispositions in either window. This file proves `sweepLightDuringRetro`
// (src/lib/daemon.ts) closes that gap the same way W1-T254 closed it for
// `runOne`: same clock, same stopTicker discipline, same "never dispatch"
// restriction.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "retro-sweep-ticker-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

function firingDecision() {
  // A fire:true decision shaped like retro.ts's `evaluateRetroTrigger` output
  // — this file's whole point is the DAEMON LOOP's ticker wiring around a
  // firing decision, not the trigger's own threshold logic (covered
  // elsewhere: test/retro-trigger-check.test.ts, test/daemon-retro-trigger.test.ts).
  return { fire: true as const, reason: "merges" as const, mergesSinceMarker: 99, daysSinceMarker: 0 };
}

test("W1-T276: the light sweep runs while a fired retro is in flight, so the sweep is never blind for the retro's whole duration", async () => {
  const plan = fixturePlan();
  let lightSweeps = 0;
  let sleeps = 0;
  let releaseRetro: (() => void) | undefined;
  const retroGate = new Promise<void>((resolve) => {
    releaseRetro = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 3) releaseRetro?.();
  };
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true, // everything merged -> nextRunnable would be "nothing runnable" if ever reached
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id}) — the retro trigger owns every tick`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    checkRetroTrigger: () => firingDecision(),
    runRetroTrigger: async () => {
      // FALSIFIER: pre-fix, nothing ran again to sweep until this (unbounded)
      // call finally returned — stays "in flight" here until the ticker has
      // ticked a few times, proving it runs CONCURRENTLY, not only before/after.
      await retroGate;
    },
    sweepLight: async () => {
      lightSweeps++;
    },
    sleep,
  });
  assert.equal(summary.stopReason, "stopped");
  assert.ok(lightSweeps >= 3, `the light-sweep ticker ran while the retro was in flight (saw ${lightSweeps} tick(s))`);
});

test("W1-T276: the ticker stops on every retro exit path — including a THROWING runRetroTrigger — and never outlives it", async () => {
  const plan = fixturePlan();
  let lightSweeps = 0;
  let fired = false;
  let releaseRetro: (() => void) | undefined;
  const retroGate = new Promise<void>((resolve) => {
    releaseRetro = resolve;
  });
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    // everything already merged -> once the (one-shot) retro is done, the
    // loop only ever sees "nothing runnable" — an idle tick, never a dispatch.
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id})`);
    },
    // Several idle ticks AFTER the retro settles — driven far enough past the
    // throw to give a leaked (not-actually-stopped) ticker room to keep
    // incrementing lightSweeps in the background if `sweepLightDuringRetro`
    // failed to await it to completion in its `finally`.
    checkStop: () => {
      stopChecks++;
      return stopChecks > 6 ? "test bound reached" : undefined;
    },
    // Fires exactly ONCE — a stale re-fire on every tick would make "idle
    // ticks after the retro" indistinguishable from "retro still running".
    checkRetroTrigger: () => {
      if (fired) return { fire: false as const, mergesSinceMarker: 0, daysSinceMarker: 0 };
      fired = true;
      return firingDecision();
    },
    runRetroTrigger: async () => {
      await retroGate;
      throw new Error("fixture: the automated retro run exploded");
    },
    // The release is tied to an OBSERVED sweep, not to a sleep counter shared
    // with the unrelated idle-poll sleeps that follow — so any lightSweeps
    // seen afterward can only come from the ticker itself still running.
    sweepLight: async () => {
      lightSweeps++;
      if (lightSweeps === 2) releaseRetro?.();
    },
    sleep: async () => {},
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
  });
  assert.equal(summary.stopReason, "stopped", "a throwing runRetroTrigger must never crash the daemon loop");
  const runFailed = lines.find((l) => l.step === "daemon.retro_trigger.run_failed");
  assert.ok(runFailed, "the retro's own throw is still ledgered as daemon.retro_trigger.run_failed");
  const idleTicks = lines.filter((l) => l.step === "daemon.idle").length;
  assert.ok(idleTicks >= 3, `several idle ticks ran after the one-shot retro settled (saw ${idleTicks})`);
  assert.ok(lightSweeps >= 2, "the ticker ran while the retro was in flight, up to the tick that released it");
  // Once the retro throws, `sweepLightDuringRetro`'s `finally` must clear
  // `tickerActive` AND await the ticker before returning control — so no
  // FURTHER sweepLight call can happen, no matter how many idle-poll sleeps
  // follow. At most ONE extra call is allowed past the release (the design's
  // documented "already in flight" tick), never one per subsequent idle tick.
  assert.ok(
    lightSweeps <= 3,
    `the ticker must have STOPPED once the retro threw, not kept ticking through the ${idleTicks} idle ticks that followed (saw ${lightSweeps} sweeps)`,
  );
});

test("W1-T276: the retro's light-sweep ticker never dispatches a task while the retro is running", async () => {
  const plan = fixturePlan();
  let runOneCalls = 0;
  let lightSweeps = 0;
  let sleeps = 0;
  let releaseRetro: (() => void) | undefined;
  const retroGate = new Promise<void>((resolve) => {
    releaseRetro = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 4) releaseRetro?.();
  };
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    // Deliberately NOT already-merged: if the ticker (or anything else) drove
    // a real dispatch while the retro held the loop, `runOne` would fire on
    // task A and this fixture would catch it.
    refreshMerged: () => () => false,
    runOne: async (id): Promise<RunResult> => {
      runOneCalls++;
      throw new Error(`runOne must never be called while the retro is in flight (task ${id})`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    checkRetroTrigger: () => firingDecision(),
    runRetroTrigger: async () => {
      await retroGate;
    },
    sweepLight: async () => {
      lightSweeps++;
    },
    sleep,
  });
  assert.equal(summary.stopReason, "stopped");
  assert.ok(lightSweeps >= 4, `the ticker ran multiple times during the retro (saw ${lightSweeps})`);
  assert.equal(runOneCalls, 0, "the light-sweep ticker restricted to sweepLight must never dispatch a task");
});

test("W1-T276: no sweepLight wired -> a fired retro behaves exactly as before this ticker existed", async () => {
  const plan = fixturePlan();
  let runCalls = 0;
  let stopChecks = 0;
  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called in this fixture (task ${id})`);
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    checkRetroTrigger: () => firingDecision(),
    runRetroTrigger: async () => {
      runCalls++;
    },
    sleep: async () => {},
  });
  assert.equal(summary.stopReason, "stopped");
  assert.equal(runCalls, 1, "the retro still runs exactly once with no sweepLight wired");
});
