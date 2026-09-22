/**
 * W1-T3979 — A LIVE IN-FLIGHT CLAIM IS A SCHEDULING DEFERRAL, NOT AN INDEPENDENT FAILURE.
 *
 * `blocked_inflight` (run-task.ts's per-task lock, guard 1) fires when a real worker is ALREADY
 * running the same task and a second admission is contested. Before this task, daemon.ts's generic
 * `independent_failure` arm treated that exactly like any other self-contained failure: it wrote
 * `dispatch.blocked_independent` + `daemon.block.independent_failure` and added the task to
 * `independentFailureBlocksThisRun`. status.ts's `latestIndependentFailureBlock` then read that
 * retained row as a PERMANENT block — so a lock doing its job durably poisoned the very task it
 * protected, long after the lock released and the first worker's run had finished.
 *
 * TWO PRODUCER-SIDE ARMS (daemon.ts) plus their shared falsifier, and TWO READER-SIDE arms
 * (status.ts) plus its own falsifier — matching the task's own design/falsifier exactly:
 *
 *   (1) PRODUCER, POSITIVE: a `blocked_inflight` dispatch result must not write
 *       `dispatch.blocked_independent` or `daemon.block.independent_failure`, must not enter
 *       `independentFailureBlocksThisRun`, and the tick must continue (the task remains eligible
 *       on a later tick — a deferral, not an exclusion).
 *   (2) PRODUCER, FALSIFIER: the identical fixture with only the verdict swapped to
 *       `blocked_review` (a genuine independent failure) must still durably block — proving the
 *       repair narrows to `blocked_inflight` rather than weakening independent-failure handling.
 *   (3) PRODUCER, CONCURRENCY: a REAL live lock (`acquireInflightLock`) held throughout every
 *       tick must keep the "worker" spawn count at exactly zero — the fix must never trade a
 *       stuck ledger row for a second live worker.
 *   (4) READER, POSITIVE: a retained historical `dispatch.blocked_independent` row whose exact
 *       verdict is `blocked_inflight` must not set `independentFailureBlocked` — admission is
 *       restored for forensics-only rows written by an older daemon.
 *   (5) READER, FALSIFIER: the SAME fixture — same task, same cost, same row order — with only the
 *       verdict mutated to `blocked_review` must remain durably blocked.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import { acquireInflightLock, InflightLockError } from "../src/lib/inflight-lock.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { deriveStatus, latestIndependentFailureBlock, type GitHub } from "../src/lib/status.js";

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** One independent task — zero transitive dependents, the premise `reasonAboutBlock` needs to
 *  route a strike into `independent_failure` at all. */
function independentTaskPlan(id = "D"): Plan {
  const t: Task = {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
  } as unknown as Task;
  return { tasks: [t], byId: new Map([[id, t]]) } as unknown as Plan;
}

// ── (1) PRODUCER, POSITIVE — a live claim is a deferral: no durable write, tick continues ──

test("W1-T3979 producer: blocked_inflight writes no durable block and the task stays eligible for a later tick", async () => {
  const plan = independentTaskPlan("D");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  let dispatches = 0;
  const summary = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        dispatches++;
        if (dispatches === 1) {
          return { taskId: id, runId: `${id}-run-1`, merged: false, costUsd: 0, verdict: "blocked_inflight" };
        }
        merged.add(id);
        return { taskId: id, runId: `${id}-run-2`, merged: true, costUsd: 0.1, verdict: "merged" };
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 2 },
  );

  assert.equal(dispatches, 2, "the deferred task must be re-offered on a later tick, not permanently excluded");
  assert.deepEqual(summary.merged, ["D"], "the second, uncontested dispatch merges normally");
  assert.ok(
    !lines.some((l) => l.step === "dispatch.blocked_independent"),
    "a live contention must never write the durable independent-block row",
  );
  assert.ok(
    !lines.some((l) => l.step === "daemon.block.independent_failure"),
    "a live contention must never fire the independent-failure ledger event",
  );
  const deferralLine = lines.find((l) => l.step === "daemon.block.inflight_contention");
  assert.ok(deferralLine, "the deferral is still logged, just under its own non-durable step");
  assert.deepEqual(deferralLine?.extra, { task: "D", verdict: "blocked_inflight", run_id: "D-run-1" });
});

// ── (2) PRODUCER, FALSIFIER — the identical fixture, only the verdict swapped, must still block ──

test("W1-T3979 falsifier: the identical fixture with blocked_review instead of blocked_inflight still durably blocks", async () => {
  const plan = independentTaskPlan("D");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  let dispatches = 0;
  let ticks = 0;
  const summary = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isIndependentFailureBlocked: (id) => latestIndependentFailureBlock(lines.map((l) => ({ step: l.step, ...l.extra })), id),
      // Once durably blocked, D has nothing left to dispatch — like the exact precedent
      // ("W1-T3565 preserves paid independent block across reload"), an explicit tick cap is what
      // stops the daemon's idle loop, not `max` (which bounds DISPATCHES, never reached again).
      checkStop: () => (++ticks > 4 ? "test tick cap" : undefined),
      runOne: async (id): Promise<RunResult> => {
        dispatches++;
        return { taskId: id, runId: `${id}-run-${dispatches}`, merged: false, costUsd: 0.2, verdict: "blocked_review" };
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 3 },
  );

  assert.equal(dispatches, 1, "a genuine independent failure is dispatched once, then durably excluded");
  assert.deepEqual(summary.merged, [], "a durably blocked task is never counted as merged");
  assert.ok(
    lines.some((l) => l.step === "dispatch.blocked_independent" && l.extra.verdict === "blocked_review"),
    "a genuine independent failure still writes the durable ledger row",
  );
  assert.ok(
    lines.some((l) => l.step === "daemon.block.independent_failure"),
    "a genuine independent failure still fires the independent-failure ledger event",
  );
});

// ── (3) PRODUCER, CONCURRENCY — a REAL live lock keeps the spawn count at zero ──

test("W1-T3979 concurrency: a real held inflight lock keeps the worker spawn count at zero across every tick", async () => {
  const inflightDir = mkdtempSync(join(tmpdir(), "rmd-inflight-contention-"));
  try {
    // The FIRST worker really holds the lock for the whole test — it never releases, mirroring a
    // healthy worker still making progress while the daemon's OWN tick re-consults admission.
    const holder = acquireInflightLock(inflightDir, "D", {
      run_id: "first-worker-run",
      isPidAlive: () => true,
    });

    let spawnCount = 0;
    const plan = independentTaskPlan("D");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let ticks = 0;
    const summary = await runDaemon(
      plan,
      {
        refreshMerged: () => () => false,
        checkStop: () => (++ticks > 4 ? "test tick cap" : undefined),
        runOne: async (id): Promise<RunResult> => {
          // Mirrors run-task.ts's OWN admission (guard 1): a live holder REFUSES the second
          // acquire before any worker logic runs, so `spawnCount` only increments on a genuine
          // second worker — exactly what must never happen while `holder` is live.
          try {
            const second = acquireInflightLock(inflightDir, id, { run_id: `second-run-${ticks}`, isPidAlive: () => true });
            spawnCount++;
            second.release();
          } catch (e) {
            if (!(e instanceof InflightLockError)) throw e;
            return { taskId: id, runId: `${id}-second-run-${ticks}`, merged: false, costUsd: 0, verdict: "blocked_inflight" };
          }
          return { taskId: id, runId: `${id}-second-run-${ticks}`, merged: true, costUsd: 0.1, verdict: "merged" };
        },
        sleep: async () => {},
        log: (step, extra = {}) => lines.push({ step, extra }),
      },
      { max: 4 },
    );

    assert.equal(spawnCount, 0, "the live lock must prevent every single second-worker spawn attempt");
    assert.deepEqual(summary.merged, [], "the still-locked task never gets credited as merged");
    assert.ok(
      !lines.some((l) => l.step === "dispatch.blocked_independent"),
      "a still-live contention must never write the durable independent-block row",
    );
    assert.ok(
      lines.filter((l) => l.step === "daemon.block.inflight_contention").length >= 1,
      "the daemon must observe and log the contention at least once",
    );
  } finally {
    rmSync(inflightDir, { recursive: true, force: true });
  }
});

// ── (4) READER, POSITIVE — a retained historical row is a deferral, not a permanent block ──

test("W1-T3979 reader: a retained blocked_inflight row does not durably block — admission is restored", () => {
  const rows = [{ task_id: "D", task: "D", step: "dispatch.blocked_independent", verdict: "blocked_inflight", run_id: "old-run" }];
  assert.equal(
    latestIndependentFailureBlock(rows, "D"),
    false,
    "a historical live-contention row must not read as a durable independent-failure block",
  );

  const proj = deriveStatus(
    {
      id: "D",
      title: "d",
      repo: "remudero",
      depends_on: [],
      type: "implement",
      verify: "auto",
      risk: "low",
      status: "queued",
      attempts: 0,
    } as unknown as Task,
    { ledgerPath: "unused", github: OFFLINE_GITHUB, readLedger: () => rows },
  );
  assert.equal(proj.independentFailureBlocked, undefined, "the projection must not carry a durable block for this row");
});

// ── (5) READER, FALSIFIER — same fixture, only the verdict mutated, remains durably blocked ──

test("W1-T3979 reader falsifier: the same row with only the verdict changed to blocked_review remains blocked", () => {
  const rows = [{ task_id: "D", task: "D", step: "dispatch.blocked_independent", verdict: "blocked_review", run_id: "old-run" }];
  assert.equal(
    latestIndependentFailureBlock(rows, "D"),
    true,
    "a genuine independent failure's retained row must remain a durable block",
  );

  const proj = deriveStatus(
    {
      id: "D",
      title: "d",
      repo: "remudero",
      depends_on: [],
      type: "implement",
      verify: "auto",
      risk: "low",
      status: "queued",
      attempts: 0,
    } as unknown as Task,
    { ledgerPath: "unused", github: OFFLINE_GITHUB, readLedger: () => rows },
  );
  assert.equal(proj.independentFailureBlocked, true, "the projection must still carry the durable block for a real failure");
});
