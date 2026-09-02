/**
 * W1-T2656 — a durable GitHub-event wake must not be consumed by a sweep that never ran.
 *
 * THE RACE (observed after #3535 merged). `runDaemon` acknowledged the wake marker immediately
 * BEFORE calling `runGatedSweep`, but that gate can decline: when an earlier pass has exceeded the
 * wall-clock await bound and is still settling, W1-T2582's liveness check correctly refuses the
 * overlapping attempt and logs `daemon.sweep.skipped_concurrent`. The acknowledge had already
 * deleted the marker, so the delivery was owned by a pass that never started and no later pass
 * ever reconciled it.
 *
 * This lives in its OWN file rather than appended to test/github-event-sweep-wake.test.ts because
 * that file already exists and passes on the merge-base: a proof naming it would match head AND
 * base and grade `executed_stale`, substantiating nothing. A new file discriminates.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import {
  consumeSweepWakeMarker,
  readSweepWakeMarker,
  sweepWakeMarkerPath,
  wireSweepWakeToDaemon,
  writeSweepWakeMarkerAtomic,
} from "../src/lib/github-event-wake.js";
import { loadPlan } from "../src/lib/plan.js";

const REPOSITORY = "craigoley/remudero";

function oneTaskPlan(root: string) {
  const path = join(root, "tasks.yaml");
  writeFileSync(path, "- id: W1-T2656\n  title: wake\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(path);
}

test("a delivery is not consumed when the sweep gate declines because an abandoned pass is still settling", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-abandoned-sweep-"));
  const path = sweepWakeMarkerPath(root);
  const wiring = wireSweepWakeToDaemon(root);
  let sweeps = 0;
  let releaseFirst!: () => void;
  let reportFirstStarted!: () => void;
  let reportSkipped!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    reportFirstStarted = resolve;
  });
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const skipped = new Promise<void>((resolve) => {
    reportSkipped = resolve;
  });
  try {
    const running = runDaemon(
      oneTaskPlan(root),
      {
        refreshMerged: () => () => true,
        runOne: async () => {
          throw new Error("a merged fixture task must never dispatch");
        },
        sweep: async () => {
          sweeps++;
          if (sweeps === 1) {
            reportFirstStarted();
            await holdFirst;
          }
        },
        checkStop: () => (sweeps >= 2 ? "follow-up pass completed" : undefined),
        sleep: async () => {},
        sleepUntilSweepWake: wiring.sleep,
        acknowledgeSweepWake: wiring.acknowledge,
        log: (step) => {
          if (step === "daemon.sweep.skipped_concurrent") reportSkipped();
        },
      },
      { pollIntervalMs: 10, sweepWallClockBoundMs: 10 },
    );
    await firstStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "after-abandon-before-settle",
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:00.000Z",
    });
    await Promise.race([
      skipped,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the busy gate was not exercised")), 500)),
    ]);
    assert.equal(
      readSweepWakeMarker(path)?.deliveryId,
      "after-abandon-before-settle",
      "a pass that never started cannot claim the event intended for its successor",
    );
    releaseFirst();
    const summary = await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the retained wake did not reach a later pass")), 500)),
    ]);
    assert.equal(summary.stopReason, "stopped");
    assert.equal(sweeps, 2);
    assert.equal(consumeSweepWakeMarker(path), undefined);
  } finally {
    releaseFirst?.();
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});
