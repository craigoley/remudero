/**
 * W1-T2744 — a full-sweep wall-clock bound must release the review scheduler even when a
 * light-pass fix is still waiting on CI. The detached fix remains owned by sweep.ts until it
 * settles; crossing a daemon phase boundary must not turn that process-wide ownership into a
 * phase-local wait.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  drainDetachedSweepActions,
  detachedSweepActionCount,
  runSweepLightPass,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-03T01:33:05Z");
const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixturePlan(): Plan {
  const root = mkdtempSync(join(tmpdir(), "rmd-t2744-plan-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `
- id: W1-T2744FIX
  title: keep the review clock live
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`);
  return loadPlan(path);
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-T2744-BLOCKED",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      { claim: "fix it", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
    priorStrikes: 0,
    lastActivityAt: "2026-09-03T01:00:00Z",
    headSha: "blocked-head",
    autoMergeArmed: false,
    ...over,
  };
}

function sweepDeps(dispatchFix: NonNullable<SweepDeps["dispatchFix"]>, postReview?: SweepDeps["postReview"]): SweepDeps {
  const root = mkdtempSync(join(tmpdir(), "rmd-t2744-sweep-"));
  return {
    arm: () => {},
    close: () => {},
    dispatchFix,
    escalate: () => {},
    actionable: (disposition) => disposition === "blocked-fixable" || disposition === "post-review",
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-T2744",
    now: () => NOW,
    postReview,
  };
}

test("W1-T2744: an abandoned sweep releases the next review tick while its detached fix keeps settling", async () => {
  let releaseFix!: () => void;
  let fixSettled = false;
  let fixDispatches = 0;
  const fixGate = new Promise<void>((resolve) => {
    releaseFix = () => {
      fixSettled = true;
      resolve();
    };
  });
  const dispatchFix: NonNullable<SweepDeps["dispatchFix"]> = () => {
    fixDispatches++;
    return fixGate as never;
  };

  const blocked = pr();
  const base = sweepDeps(dispatchFix);
  await runSweepLightPass([blocked], base);
  assert.equal(detachedSweepActionCount(), 1, "precondition: one fix remains detached while CI is pending");

  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const reviewed: number[] = [];
  let greenReady = false;
  let lightPassesInFlight = 0;
  let maxLightPassesInFlight = 0;
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const lightDeps = sweepDeps(dispatchFix, (candidate) => {
    reviewed.push(candidate.prNumber);
    releaseRun();
    return Promise.resolve(undefined) as never;
  });

  const daemon = runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => false,
      runOne: async (taskId) => {
        await runGate;
        return { taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sweep: () => new Promise<void>(() => {}),
      sweepLight: async () => {
        lightPassesInFlight++;
        maxLightPassesInFlight = Math.max(maxLightPassesInFlight, lightPassesInFlight);
        try {
          await runSweepLightPass(
            greenReady
              ? [
                  blocked,
                  pr({
                    prNumber: 2,
                    prUrl: "https://github.com/o/r/pull/2",
                    taskId: "W1-T2744-GREEN",
                    reviewState: "none",
                    unmetCriteria: [],
                    headSha: "green-head",
                  }),
                ]
              : [blocked],
            lightDeps,
          );
        } finally {
          lightPassesInFlight--;
        }
      },
      sleep: REAL_SLEEP,
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "daemon.sweep.abandoned") greenReady = true;
      },
    },
    { max: 1, pollIntervalMs: 5, sweepWallClockBoundMs: 20 },
  );

  const progressedBeforeFixSettled = await Promise.race([
    daemon.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
  ]);

  // Always release both held promises before asserting so the pre-fix implementation can exit
  // and the module-global registry cannot leak into another test.
  releaseRun();
  releaseFix();
  await daemon;
  await drainDetachedSweepActions();

  assert.equal(progressedBeforeFixSettled, true, "the wall-clock bound must return before the detached fix settles");
  assert.ok(reviewed.includes(2), "the distinct green head was admitted after the abandonment");
  assert.equal(fixDispatches, 1, "later light passes did not dispatch a duplicate fix for the same head");
  assert.equal(fixSettled, true, "the already-admitted fix was allowed to settle");
  assert.equal(maxLightPassesInFlight, 1, "the phase transition never ran two light passes at once");
  const postAbandonAlive = lines.findIndex((line, index) =>
    line.step === "daemon.alive" && lines.slice(0, index).some((prior) => prior.step === "daemon.sweep.abandoned"));
  assert.notEqual(postAbandonAlive, -1, "daemon.alive continued on the configured ticker after abandonment");
  assert.equal(
    lines[postAbandonAlive]!.extra.detached_sweep_actions,
    1,
    "the heartbeat exposes the bounded detached-action count while the review clock remains live",
  );
  assert.equal(detachedSweepActionCount(), 0, "the daemon-lifetime owner released the fix after settlement");
});

test("W1-T2744: STOP and PAUSE withhold new sweep admission without waiting on or rejecting detached work", async () => {
  for (const control of ["STOP", "PAUSE"] as const) {
    let rejectFix!: (error: Error) => void;
    const fixGate = new Promise<void>((_resolve, reject) => { rejectFix = reject; });
    await runSweepLightPass(
      [pr({ prNumber: control === "STOP" ? 11 : 12, headSha: `${control}-head` })],
      sweepDeps(() => fixGate as never),
    );
    assert.equal(detachedSweepActionCount(), 1, `precondition: ${control}'s admitted fix is still settling`);

    let slept = false;
    let sweepCalls = 0;
    const summary = await runDaemon(
      fixturePlan(),
      {
        refreshMerged: () => () => false,
        runOne: async () => { throw new Error("control must withhold dispatch"); },
        checkStop: () => control === "STOP" || slept ? "operator hold" : undefined,
        checkPause: () => control === "PAUSE" && !slept ? "operator hold" : undefined,
        sleep: async () => { slept = true; },
        sweep: async () => { sweepCalls++; },
        sweepLight: async () => { sweepCalls++; },
      },
    );

    assert.equal(summary.stopReason, "stopped");
    assert.equal(sweepCalls, 0, `${control} admitted no new review or fix sweep`);
    assert.equal(detachedSweepActionCount(), 1, `${control} did not abort or phase-drain work already admitted`);
    rejectFix(new Error("settled after operator hold"));
    await settle();
    await drainDetachedSweepActions();
    assert.equal(detachedSweepActionCount(), 0, "the handled rejection settled and released its daemon-lifetime owner");
  }
});
