/**
 * W1-T13685: serve folded the analytics ledger, built its snapshot and wrote the ~85 MB checkpoint on its request loop.
 * On a copy of the Azure core ledger (2026-11-18) a refresh held the loop up to 1.9 s per turn and stop() blocked 3.6 s;
 * analytics frames were in 107 of 619 main-thread stalls (202 of 851 s) in the two hours to 12:15Z. The fold now runs
 * on a worker thread, and this thread receives only each finished snapshot.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAnalyticsSnapshotCache, type AnalyticsTimer } from "#src/lib/analytics-route.js";

const CHECKPOINT = ".analytics-console-v1.checkpoint.json";
const noTimers = (): AnalyticsTimer => ({ unref: () => {}, cancel: () => {} });

/** A ledger whose fold holds a large state: one dispatch start, one verdict and one priced worker row per run. */
function ledgerDir(t: { after: (fn: () => void) => void }, runs: number): string {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-analytics-offloop-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const base = Date.parse("2026-11-18T00:00:00.000Z");
  const lines: string[] = [];
  for (let i = 0; i < runs; i += 1) {
    const ts = new Date(base + i * 1000).toISOString();
    const run_id = `run-${i}`, task_id = `W1-T${i % 5000}`;
    lines.push(JSON.stringify({ ts, run_id, task_id, step: "run.start", lane: "fleet", source: "queue-dispatch" }));
    lines.push(JSON.stringify({ ts, run_id, task_id, step: "worker.done", lane: `lane-${i % 7}`, model: `model-${i % 5}`,
      worker_duration_ms: 1000 + i, total_cost_usd: 0.01, tokens: { input: 10, output: 5, cacheRead: 1, cacheCreation: 1 } }));
    lines.push(JSON.stringify({ ts, run_id, task_id, step: "verdict", verdict: i % 3 === 0 ? "fail" : "pass" }));
    lines.push(JSON.stringify({ ts, run_id, step: "cli.invoked", verb: `verb-${i % 40}` }));
  }
  writeFileSync(join(stateDir, "ledger.ndjson"), lines.join("\n") + "\n");
  return stateDir;
}

/** This thread's own CPU time while `work` runs (not the process's, and not wall time a loaded host can stretch).
 *  It bounds every turn on this thread: no turn can hold the loop longer than the CPU the thread spent. */
async function threadCpuMs(work: () => Promise<void>): Promise<number> {
  const usage = (process as unknown as { threadCpuUsage(): NodeJS.CpuUsage }).threadCpuUsage;
  const before = usage.call(process);
  await work();
  const after = usage.call(process);
  return (after.user - before.user + after.system - before.system) / 1000;
}

/** Counts this thread's JSON.stringify calls whose text is at least `bytes` long while `work` runs. */
async function largeStringifies(t: { mock: { method: typeof import("node:test").mock.method } }, bytes: number, work: () => Promise<void> | void): Promise<number> {
  const real = JSON.stringify;
  let large = 0;
  const spy = t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
    const text = real(...args);
    if (typeof text === "string" && text.length >= bytes) large += 1;
    return text;
  });
  try { await work(); } finally { spy.mock.restore(); }
  return large;
}

const cache = (stateDir: string, offThread: boolean) =>
  createAnalyticsSnapshotCache({ stateDir, schedule: noTimers, ...(offThread ? { offThread: true } : {}) });

test("W1-T13685: the fold and its checkpoint write run off this thread, which serializes no checkpoint", async (t) => {
  const stateDir = ledgerDir(t, 4_000);
  const off = cache(stateDir, true);
  t.after(() => off.stop());
  const large = await largeStringifies(t as never, 200_000, () => off.refresh());
  assert.equal(existsSync(join(stateDir, CHECKPOINT)), true, "the worker wrote the checkpoint");
  assert.ok(statSync(join(stateDir, CHECKPOINT)).size >= 200_000, "positive control: the checkpoint is large");
  assert.equal(large, 0, "this thread serialized no checkpoint-sized text");
  assert.ok(off.current().asOf !== null, "the worker's snapshot is served");
});

test("W1-T13685: a refresh of a bench-sized ledger spends under 500 ms of this thread's CPU, so no turn on it is longer", async (t) => {
  const stateDir = ledgerDir(t, 30_000);
  const off = cache(stateDir, true);
  t.after(() => off.stop());
  const spent = await threadCpuMs(() => off.refresh());
  assert.ok(off.current().asOf !== null, "positive control: the refresh finished a snapshot");
  assert.ok(spent < 500, `this thread spent ${Math.round(spent)} ms of CPU on the refresh`);
});

test("W1-T13685: stop() writes the held-back checkpoint on the worker and does not block this thread", async (t) => {
  const stateDir = ledgerDir(t, 4_000);
  const off = cache(stateDir, true);
  await off.refresh();
  const first = readFileSync(join(stateDir, CHECKPOINT), "utf8");
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({ ts: "2026-11-18T12:00:00.000Z", step: "cli.invoked", verb: "late" }) + "\n", { flag: "a" });
  await off.refresh(); // inside the write interval: this checkpoint is held back for stop
  assert.equal(readFileSync(join(stateDir, CHECKPOINT), "utf8"), first, "positive control: the second checkpoint was held back");
  const large = await largeStringifies(t as never, 200_000, () => off.stop());
  assert.equal(large, 0, "stop serialized nothing on this thread");
  for (let i = 0; i < 200 && readFileSync(join(stateDir, CHECKPOINT), "utf8") === first; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.notEqual(readFileSync(join(stateDir, CHECKPOINT), "utf8"), first, "the worker wrote the held-back checkpoint");
});

test("W1-T13685: invariant:no-cold-before-load — a cache built over a saved checkpoint serves it before any refresh", async (t) => {
  const stateDir = ledgerDir(t, 500);
  const seed = cache(stateDir, true);
  await seed.refresh();
  const asOf = seed.current().asOf;
  seed.stop();
  assert.ok(asOf !== null, "positive control: a checkpoint was saved");
  const booted = cache(stateDir, true);
  t.after(() => booted.stop());
  assert.equal(booted.current().asOf, asOf, "the saved snapshot is served at once, never a cold one");
});
