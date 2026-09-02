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
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
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

test("a repeat of the same delivery level raises no new edge, so a retained marker cannot spin the poll", async () => {
  // THE THIRD CRITERION'S FALSIFIER. Retaining the marker (the fix above) is only safe because an
  // already-observed delivery id raises no further in-memory edge: the sleep path re-reads the
  // durable level before EVERY poll wait and the watcher re-reads it on every filesystem event, so
  // without that guard each wait resolves at zero delay and the poll stops bounding anything.
  // MEASURED: deleting the observed-id check leaves the settling-race test above at `# fail 0`,
  // so this is the only test in this file that discriminates the guard's presence.
  const root = mkdtempSync(join(tmpdir(), "rmd-github-retained-level-"));
  const path = sweepWakeMarkerPath(root);
  const fake = new EventEmitter() as FSWatcher;
  fake.close = () => {};
  let notify: ((eventType: string, filename: string) => void) | undefined;
  const wiring = wireSweepWakeToDaemon(root, () => {}, ((_dir: string, listener: (e: string, f: string) => void) => {
    notify = listener;
    return fake;
  }) as unknown as typeof import("node:fs").watch);
  try {
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "retained-level-delivery",
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:00.000Z",
    });
    // The durable level owes the daemon exactly one edge, and the first re-read pays it.
    await Promise.race([
      wiring.sleep(60_000),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the durable level never raised its first edge")), 100)),
    ]);
    // NOT acknowledged: this is exactly the state the fix creates on purpose, where a declined
    // pass leaves the wake on disk for its successor. Re-reading it must not re-arm the signal.
    notify?.("rename", "SWEEP_WAKE_REQUESTED");
    const retained = wiring.sleep(60_000).then(() => "woke" as const);
    assert.equal(
      await Promise.race([retained, new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 100))]),
      "waited",
      "an already-observed delivery id must not re-raise a wake edge",
    );
    assert.equal(readSweepWakeMarker(path)?.deliveryId, "retained-level-delivery");
    // A DIFFERENT delivery id is a genuinely new level and must interrupt the waiting poll at
    // once — the guard suppresses repetition, never delivery.
    writeSweepWakeMarkerAtomic(path, {
      deliveryId: "second-level-delivery",
      event: "check_run",
      action: "completed",
      repository: REPOSITORY,
      receivedAtIso: "2026-09-01T20:00:01.000Z",
    });
    notify?.("rename", "SWEEP_WAKE_REQUESTED");
    assert.equal(
      await Promise.race([
        retained,
        new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 500)),
      ]),
      "woke",
      "a new delivery id must wake the waiting poll immediately",
    );
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});
