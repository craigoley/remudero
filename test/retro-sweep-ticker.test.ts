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

// ── W1-T463 — THE DIAGNOSIS: "a restricted light sweep ticks every 60s ... yet a PR sat
// 21-green and unreviewed for ~15 minutes". `startInFlightTicker` (src/lib/daemon.ts, the SAME
// ticker function this file's other tests exercise via the retro wiring) only schedules its
// NEXT `pollIntervalMs` sleep AFTER the CURRENT `sweepLight()` call resolves — it never runs on
// a fixed wall-clock schedule independent of that call's own duration. That is correct and
// deliberate on its own (no overlapping `sweepLight()` calls, so no second concurrent
// dedup-reader is ever introduced — design (iv)) — but it means "ticks every ~60s" only bounds
// when a NEW pass STARTS, never how long that pass takes to finish. `buildSweepLightHook`'s
// `postReview` effect (run-task.ts) runs the REAL `reviewCommand` — a worktree materialize plus
// every whitelisted proof for that PR — never a cheap status flip, and `runSweep`'s own
// per-PR loop is sequential, so a single `sweepLight()` call's wall time scales with however
// many PRs are due for post-review AND how long each one's proofs take. A PR ordered behind a
// slow sibling in that pass's `openPrs` snapshot silently misses the "checked every ~60s"
// expectation by however long the PRs ahead of it take — the observed ~15-minute shape.
// (`runSweepLightPass`, src/lib/sweep.ts, is W1-T463's fix for the OTHER half of this: it runs
// every open PR's own `runSweep` call CONCURRENTLY rather than the whole snapshot sequentially,
// so PRs no longer queue behind each other WITHIN one pass. This test pins the ticker-level
// mechanism that made a slow pass matter in the first place — it is deliberately NOT about
// sweepLight's internals, which this file's other tests treat as an opaque injected function.)
test("W1-T463: the ticker's next tick does not begin until the CURRENT sweepLight() call resolves — 'ticks every ~60s' bounds when a pass starts, never how long it runs", async () => {
  const plan = fixturePlan();
  let sweepLightCalls = 0;
  let releaseSlowPass: (() => void) | undefined;
  const slowPass = new Promise<void>((resolve) => {
    releaseSlowPass = resolve;
  });
  let stopChecks = 0;
  const pending = runDaemon(plan, {
    refreshMerged: () => () => false, // stay OPEN — this fixture drives a real in-flight runOne
    runOne: async (): Promise<RunResult> => {
      // The dispatch this ticker exists to route around — it only settles once the test
      // releases it below, so the ticker stays "in flight" for the whole real-time window.
      await slowPass;
      return { taskId: "A", runId: "A-run", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 1 ? "test bound reached" : undefined;
    },
    sweepLight: async () => {
      sweepLightCalls++;
      if (sweepLightCalls === 1) {
        // Simulates a real pass that outran pollIntervalMs (e.g. a post-review action's
        // worktree-materialize-plus-proofs, or several such PRs queued in the same
        // snapshot): it holds here across the real-time window below, and the ticker must
        // not start a second sweepLight() call while this one is in flight — see
        // startInFlightTicker's own doc for why overlap is refused, not merely absent by luck.
        await slowPass;
      }
    },
    sleep: async () => {}, // the injected mock clock — instantaneous, never itself gates real time
  });
  // Let REAL wall-clock time pass while the first sweepLight() call is still gated. If the
  // ticker ran sweepLight() on a schedule independent of that call's own duration (the
  // property this test would catch a regression of), several more calls would already have
  // fired by now; instead it is coupled to the in-flight call's own completion.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sweepLightCalls, 1, "a slow sweepLight() call is never overlapped by a second one — the tick cadence is gated on ITS completion, not a fixed wall clock");
  releaseSlowPass?.();
  const summary = await pending;
  assert.equal(summary.stopReason, "stopped");
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
