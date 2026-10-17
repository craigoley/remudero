// W1-T9924 — A LATCHED RESTART WITH NO HOLDOUT LEFT REFILLS NO LANE ITS DRAIN WOULD ABANDON. On 2026-10-16 seven build
// refills started from 16:36 to 16:59 under the 16:30:23 latch with `waiting_on: []`, and each was asked to yield as
// latch_refill_past_restart within 1 to 3 minutes: W1-T9069's span check ran only while a holdout waited, and child mode
// skipped the stale-code close. These drive the REAL runDaemon in child mode (`adoptRunChildren` wired) on a fake clock
// with an injected runOne; the history is fixture rows stamped from the fake epoch, never a live ledger.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonFreshness, type RestartBoundary } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import type { Task } from "../src/lib/plan.js";

const minute = 60_000;
const epoch = Date.parse("2026-10-16T16:28:00Z");
// The latch lands at minute 1 and the drain's bound is 20 minutes, so the drain has until minute 21.
const BOUND_MS = 20 * minute;
const material: Extract<DaemonFreshness, { stale: true }> = {
  stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: update worker", files: ["src/lib/worker.ts"] }],
  staleSinceMs: epoch - 120 * minute,
};

/** Three settled src runs of `spanMin` minutes each (W1-T9069's class median), or none. */
function history(spanMin: number | undefined): string[] {
  if (spanMin === undefined) return [];
  return [0, 1, 2].flatMap((n) => [
    JSON.stringify({ ts: new Date(epoch - (300 + n) * minute).toISOString(), step: "run.start", task_class: "src", run_id: `span-${n}`, task_id: `span-${n}` }),
    JSON.stringify({ ts: new Date(epoch - (300 + n - spanMin) * minute).toISOString(), step: "verdict", run_id: `span-${n}`, verdict: "merged" }),
  ]);
}

type Row = { step: string; fields: Record<string, unknown> };

async function rig(options: { spanMin?: number; runsAsChild?: (task: Task) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9924-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "ABCD".split("").map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  let now = epoch;
  let latched = false;
  const merged = new Set<string>();
  const finishers = new Map<string, (result: RunResult) => void>();
  const boundaries = new Map<string, RestartBoundary>();
  const started: string[] = [];
  const sleeps: Array<() => void> = [];
  const rows: Row[] = [];
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(now), refreshMerged: () => (id: string) => merged.has(id),
    checkFreshness: () => latched ? material : { stale: false },
    readLedgerLines: () => [],
    readRestartHistory: () => history("spanMin" in options ? options.spanMin : 30),
    adoptRunChildren: () => [],
    ...(options.runsAsChild ? { refillRunsAsChild: options.runsAsChild } : {}),
    runOne: (id: string, opts?: { restartAtWorkerBoundary: RestartBoundary; onChild?: (child: unknown) => void }) => {
      started.push(id);
      boundaries.set(id, opts!.restartAtWorkerBoundary);
      const settled = new Promise<RunResult>((resolve) => finishers.set(id, resolve));
      if (options.runsAsChild?.({ id } as Task)) {
        opts?.onChild?.({ started: true, runId: `${id}-child`, dir, pid: 1, settled, abort: async () => ({ aborted: true }) });
      }
      return settled;
    },
    log: (step: string, fields?: Record<string, unknown>) => rows.push({ step, fields: fields ?? {} }),
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
  } as unknown as DaemonDeps, { laneCount: 2, max: 12, sweepWallClockBoundMs: BOUND_MS });
  await flush();
  const settleTick = async () => { sleeps.shift()?.(); for (let i = 0; i < 5; i++) await flush(); };
  const h = {
    rows, started, run,
    find: (step: string, task?: string) => rows.filter((row) => row.step === step && (task === undefined ||
      row.fields.task === task || row.fields.next_task === task || row.fields.task_id === task)),
    at: (minutes: number) => { now = epoch + minutes * minute; },
    boundary: (id: string, waitingOn = "recon") => boundaries.get(id)!({ waitingOn, runId: `${id}-run` }),
    latch: async () => {
      latched = true;
      h.at(1);
      await settleTick();
      assert.ok(rows.some((row) => row.step === "daemon.freshness_decision" && row.fields.action === "restart"),
        "positive control: the restart was decided");
    },
    /** Lane B's holdout yields (no history for recon), so no holdout is left; lane A then frees at `minutes`. */
    drainHoldouts: async (minutes: number) => {
      assert.equal(h.boundary("B"), material, "B yields at its unmeasured recon boundary");
      assert.ok(rows.some((row) => row.step === "daemon.restart_yield_asked" && row.fields.task_id === "B"));
      await h.settle("A", minutes);
    },
    settle: async (id: string, minutes: number) => {
      h.at(minutes);
      merged.add(id);
      finishers.get(id)!({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
      for (let i = 0; i < 10; i++) await flush();
    },
    close: async () => {
      let done = false;
      void run.then(() => { done = true; }, () => { done = true; });
      for (let pass = 0; pass < 100 && !done; pass++) {
        for (const [id, finish] of finishers) finish({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
        for (const sleep of sleeps.splice(0)) sleep();
        await flush();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

test("W1-T9924: a latch with no holdout refills no lane its drain would abandon", async () => {
  const h = await rig({ spanMin: 30 });
  try {
    assert.deepEqual(h.started, ["A", "B"]);
    await h.latch();
    await h.drainHoldouts(2);
    assert.deepEqual(h.started, ["A", "B"], "C's 30-minute class median exceeds the drain's 19 minutes left");
    assert.equal(h.find("dispatch.lane_refilled").length, 0, "no lane refilled under the latch");
    const held = h.find("daemon.admission_held").filter((row) => row.fields.surface === "dispatch-refill");
    assert.equal(held.length, 1, "one hold row names the refill");
    assert.equal(held[0].fields.kind, "dispatch-refill");
    assert.equal(held[0].fields.task, "C");
    assert.equal(held[0].fields.task_class, "src");
    assert.equal(held[0].fields.measured_length_ms, 30 * minute);
    assert.equal(held[0].fields.time_left_ms, 19 * minute);
    assert.equal(held[0].fields.samples, 3);
    assert.equal(held[0].fields.runs_as_child, false);
    const parked = h.find("dispatch.lane_parked");
    assert.equal(parked.length, 1, "B is still in-process work, so the lane parks on the latch path");
    assert.equal(parked[0].fields.reason, "the drain would abandon it");
    assert.equal(parked[0].fields.nearest_task, "C");
    // The last in-process lane settling leaves only children, so the pool ends without starting the held refill.
    await h.settle("B", 3);
    assert.deepEqual(h.started, ["A", "B"]);
    assert.equal(h.find("daemon.admission_held").filter((row) => row.fields.surface === "dispatch-refill").length, 1,
      "one row per lane and state");
    const summary = await h.run;
    assert.equal(summary.stopReason, "stale");
    const cost = h.find("daemon.restart_latch_cost")[0]?.fields;
    assert.equal(cost?.refills_under_latch, 0);
    assert.equal(cost?.refills_held_after_latch, 1);
  } finally { await h.close(); }
});

test("W1-T9924: a refill that fits the drain still starts under the latch", async () => {
  const h = await rig({ spanMin: 10 });
  try {
    await h.latch();
    await h.drainHoldouts(2);
    assert.deepEqual(h.started, ["A", "B", "C"], "C's 10-minute class median fits the drain's 19 minutes left");
    const refilled = h.find("dispatch.lane_refilled", "C")[0]?.fields;
    assert.equal(refilled?.restart_pending, true);
    assert.deepEqual(refilled?.waiting_on, []);
    assert.equal(refilled?.latch_admission, "fits_drain");
    assert.equal(refilled?.measured_length_ms, 10 * minute);
    assert.equal(h.find("daemon.admission_held").length, 0);
    // Admitted to fit the drain, it is not abandoned at its first boundary; past the drain's deadline it yields.
    h.at(4);
    assert.equal(h.boundary("C"), undefined, "the refill continues inside the drain it was admitted to fit");
    h.at(21);
    assert.equal(h.boundary("C"), material);
    assert.equal(h.find("daemon.restart_yield_asked", "C")[0]?.fields.reason, "latch_refill_past_restart");
  } finally { await h.close(); }
});

test("W1-T9924: a refill that runs as an adoptable child starts under the latch", async () => {
  const h = await rig({ spanMin: 30, runsAsChild: (task) => task.id === "C" });
  try {
    await h.latch();
    await h.drainHoldouts(2);
    assert.deepEqual(h.started, ["A", "B", "C"], "the restart does not wait on a child, so its span is not judged");
    const refilled = h.find("dispatch.lane_refilled", "C")[0]?.fields;
    assert.equal(refilled?.restart_pending, true);
    assert.equal(refilled?.latch_admission, "runs_as_child");
    assert.equal(h.find("daemon.admission_held").length, 0);
  } finally { await h.close(); }
});

test("W1-T9924: with no latch or no history refill is unchanged", async () => {
  const quiet = await rig({ spanMin: 30 });
  try {
    await quiet.settle("A", 2);
    assert.deepEqual(quiet.started, ["A", "B", "C"], "with no latch the 30-minute refill starts as before");
    const refilled = quiet.find("dispatch.lane_refilled", "C")[0]?.fields;
    assert.equal(refilled?.restart_pending, undefined);
    assert.equal(refilled?.latch_admission, undefined);
    assert.equal(quiet.find("daemon.admission_held").length, 0);
  } finally { await quiet.close(); }
  const unmeasured = await rig({ spanMin: undefined });
  try {
    await unmeasured.latch();
    await unmeasured.drainHoldouts(2);
    assert.deepEqual(unmeasured.started, ["A", "B", "C"], "with no class history the refill admits as today");
    const refilled = unmeasured.find("dispatch.lane_refilled", "C")[0]?.fields;
    assert.equal(refilled?.restart_pending, true);
    assert.equal(refilled?.latch_admission, "no_history");
    assert.equal(unmeasured.find("daemon.admission_held").length, 0);
  } finally { await unmeasured.close(); }
});
