import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { STALE_REVIEWER_SKIP_RESTART_STREAK } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

/**
 * W1-T4998 — the admission decision waited behind a 15-minute tick. Every tick awaited the full
 * sweep (bounded at 559 s) before asking whether to start a build; measured 2026-09-30, a full
 * pass ran 12.5 minutes, so with src/ restarts every ~40 minutes a cycle got one or two admission
 * chances and 16:30Z-20:19Z started zero builds. The sweep now runs in the background: a tick
 * reaches admission without waiting for it, and the stale-reviewer re-check (W1-T3618/W1-T3691)
 * reads the most recent COMPLETED pass, each completed pass counted exactly once.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}admission-before-sweep-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

/** Race a daemon against a real timer, so the pre-fix loop (which blocks on the sweep) reads as a
 *  red assertion rather than a hung suite. */
function within<T>(work: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

test("W1-T4998: a tick reaches the admission decision before its sweep completes", async () => {
  const plan = fixturePlan();
  let releaseSweep!: () => void;
  const sweepGate = new Promise<void>((resolve) => {
    releaseSweep = resolve;
  });
  let sweepSettled = false;
  let dispatchedWhileSweepRan: boolean | undefined;
  const steps: string[] = [];

  const daemon = runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        dispatchedWhileSweepRan ??= !sweepSettled;
        return okResult(id);
      },
      sleep: async () => {},
      log: (step) => steps.push(step),
      sweep: async () => {
        await sweepGate;
        sweepSettled = true;
        return {};
      },
    },
    { max: 1, sweepWallClockBoundMs: 60_000 },
  );

  const early = await within(daemon, 3_000);
  releaseSweep();
  const summary = await daemon;

  assert.equal(dispatchedWhileSweepRan, true, "the build was admitted while the full sweep was still running");
  assert.notEqual(early, "timed-out", "the daemon reached its admission cap without waiting for the sweep");
  assert.equal(summary.stopReason, "max_reached");
  assert.ok(steps.indexOf("daemon.iteration") >= 0, "an admission was recorded");
});

test("W1-T4998: the stale-reviewer re-check reads the most recent completed sweep outcome", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  // Each full pass stays open across several ticks; the idle wait releases it. A pass started once
  // the recurrence is decided resolves at once, so the freshness exit's own wait never deadlocks.
  const pending: Array<() => void> = [];
  let passes = 0;
  let completedPasses = 0;
  let completedAtRestart: number | undefined;
  let idleWaits = 0;

  const daemon = runDaemon(
    plan,
    {
      refreshMerged: () => () => true, // nothing runnable -> every tick idles
      runOne: async (id) => okResult(id),
      sleep: async () => {
        idleWaits++;
        if (idleWaits % 3 === 0) pending.shift()?.();
      },
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "review.stale_reviewer_restart_requested") completedAtRestart = completedPasses;
      },
      sweep: async () => {
        passes++;
        if (passes <= STALE_REVIEWER_SKIP_RESTART_STREAK) await new Promise<void>((resolve) => pending.push(resolve));
        completedPasses++;
        return { reviewerCodeStale: { oldSha: OLD_SHA, newSha: NEW_SHA } };
      },
    },
    { sweepWallClockBoundMs: 60_000 },
  );

  const outcome = await within(daemon, 5_000);
  // Unstick a pre-fix loop so the suite can finish and report the red below.
  while (outcome === "timed-out" && pending.length > 0) pending.shift()?.();

  assert.notEqual(outcome, "timed-out", "idle ticks kept polling while each pass was still running");
  if (outcome === "timed-out") return;
  assert.equal(outcome.stopReason, "stale", "the sustained recurrence ended the cycle for a freshness restart");
  const restart = lines.filter((l) => l.step === "review.stale_reviewer_restart_requested");
  assert.equal(restart.length, 1);
  assert.ok(Number(restart[0]!.extra.streak) >= STALE_REVIEWER_SKIP_RESTART_STREAK);
  assert.equal(restart[0]!.extra.streak, completedAtRestart, "the streak counts completed passes, each exactly once");
  assert.equal(lines.filter((l) => l.step === "review.stale_reviewer_held").length, 1, "only the second completed pass rendered as held");
  const ticks = lines.filter((l) => l.step === "daemon.tick").length;
  assert.ok(ticks > completedAtRestart!, `ticks (${ticks}) outnumber the passes the re-check consumed (${completedAtRestart})`);
});

test("W1-T4998: each tick logs its phase timings with ms to admission", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let idleWaits = 0;

  const summary = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: async () => {
      idleWaits++;
    },
    log: (step, extra = {}) => lines.push({ step, extra }),
    checkStop: () => (idleWaits >= 3 ? "test done" : undefined),
    sweep: async () => ({}),
  });

  assert.equal(summary.stopReason, "stopped");
  const phases = lines.filter((l) => l.step === "daemon.tick_phases");
  const admissions = lines.filter((l) => l.step === "daemon.idle").length;
  assert.ok(admissions >= 3, "sanity: several ticks reached the admission decision");
  assert.equal(phases.length, admissions, "one phase row per tick that reached admission");
  for (const row of phases) {
    assert.equal(typeof row.extra.ms_to_admission, "number");
    assert.equal(typeof row.extra.ms_in_cadences, "number");
    assert.ok("ms_in_sweep" in row.extra, "the completed pass's duration, or null when none completed");
    assert.equal(typeof row.extra.sweep_in_flight, "boolean");
  }
});
