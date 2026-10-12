// W1-T5846 — A STALE-GENERATION REFILL READS OFF THE EVENT LOOP. W1-T5762's `refreshMerged` falls back to the
// synchronous projection on a refused read generation, and the lane refill called it directly, so a dispatch
// phase longer than the backstop blocked the loop on a live read at every refill. These drive the REAL
// runDaemon at three lanes; only `runOne` and the merged-set ports are faked.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";

const IDS = ["W1-T9101", "W1-T9102", "W1-T9103", "W1-T9104"];

type Row = { step: string; extra?: Record<string, unknown> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const result = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as RunResult;

/** Three lanes admit 9101..9103; freeing 9101 refills a lane with 9104. `withAsyncPort` wires
 *  `refreshMergedAsync`; both ports read the same merged set so the admissions can be compared. */
async function phase(withAsyncPort: boolean, asyncRead?: () => Promise<(id: string) => boolean>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-refill-async-merged-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, IDS.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  const releases = new Map(IDS.map((id) => [id, deferred<RunResult>()]));
  const started: string[] = [];
  const rows: Row[] = [];
  const merged = new Set<string>();
  const calls = { sync: 0, async: 0 };
  let cleaningUp = false;
  const run = runDaemon(loadPlan(path), {
    refreshMerged: () => { calls.sync++; return (id: string) => merged.has(id); },
    ...(withAsyncPort ? {
      refreshMergedAsync: async () => {
        calls.async++;
        return asyncRead ? asyncRead() : (id: string) => merged.has(id);
      },
    } : {}),
    checkStop: () => cleaningUp ? "test cleanup" : undefined,
    log: (step, extra) => { rows.push({ step, extra }); },
    runOne: async (id) => {
      started.push(id);
      return cleaningUp ? result(id) : releases.get(id)!.promise;
    },
    sleep: async () => {},
  } as DaemonDeps, { laneCount: 3, max: 10 });
  try {
    await drainMicrotasks();
    assert.deepEqual(started, IDS.slice(0, 3), "the tick's start admits three lanes");
    // Only the refill's reads are counted: the tick's own reads happened before this point.
    const before = { ...calls };
    merged.add(IDS[0]);
    releases.get(IDS[0])!.resolve(result(IDS[0]));
    for (let i = 0; i < 8; i++) await drainMicrotasks();
    return { started: [...started], rows: [...rows], refillCalls: { sync: calls.sync - before.sync, async: calls.async - before.async } };
  } finally {
    cleaningUp = true;
    for (const [id, release] of releases) release.resolve(result(id));
    await run;
    rmSync(dir, { recursive: true, force: true });
  }
}

const refilledWith = (rows: Row[]) => rows.filter((r) => r.step === "dispatch.lane_refilled").map((r) => r.extra?.next_task);

test("a lane refill with an async merged-set port wired reads through it and never calls the sync refreshMerged", async () => {
  const { started, rows, refillCalls } = await phase(true);
  assert.equal(refillCalls.sync, 0, "the refill never calls the synchronous refreshMerged");
  assert.equal(refillCalls.async, 1, "the refill reads its merged set through the async port");
  assert.deepEqual(refilledWith(rows), [IDS[3]]);
  assert.deepEqual(started, IDS);
});

test("a deps object without the async port still refills through the sync refreshMerged", async () => {
  const { started, rows, refillCalls } = await phase(false);
  assert.equal(refillCalls.sync, 1, "the refill reads through the synchronous port");
  assert.equal(refillCalls.async, 0);
  assert.deepEqual(refilledWith(rows), [IDS[3]]);
  assert.deepEqual(started, IDS);
});

test("the refill admits the same tasks with or without the async merged-set port", async () => {
  const withPort = await phase(true);
  const without = await phase(false);
  assert.deepEqual(withPort.started, without.started);
  assert.deepEqual(refilledWith(withPort.rows), refilledWith(without.rows));
});

test("a refill whose async merged-set read rejects is held with a refill read failed reason", async () => {
  let reads = 0;
  const { started, rows } = await phase(true, async () => {
    reads++;
    // The tick's own reads succeed; the refill's read is the one that fails.
    if (reads > 1) throw new Error("gh exited 1");
    return () => false;
  });
  assert.deepEqual(started, IDS.slice(0, 3), "the failed read refills nothing");
  const held = rows.filter((r) => r.step === "dispatch.lane_refill_held").at(-1);
  assert.equal(held?.extra?.reason, "refill read failed: gh exited 1");
});
