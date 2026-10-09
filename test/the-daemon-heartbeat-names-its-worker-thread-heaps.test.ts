// @source-text-subject: one case below asserts the sampler module's own text names no heap
// snapshot, debugger or collection entry point — the module's source IS that claim's subject.
/**
 * W1-T7092 — THE DAEMON HEARTBEAT NAMES ITS WORKER THREAD HEAPS.
 *
 * The core daemon held 4.3-4.65 GB rss against a 0.45-0.60 GB main heap, and ran worker_threads
 * whose isolates `process.memoryUsage()` does not count. `workerHeapReadings`
 * (src/lib/daemon-memory-telemetry.ts) sizes each live thread in worker-heaps.ts's registry by spawn
 * site; the daemon's `afterRow` hook (daemon.ts) starts that read only after `daemon.alive` is
 * written, and the NEXT row carries it.
 *
 * Every heartbeat case runs through the real `runDaemon` ticker. Awaiting the read inside the tick
 * fails the not-awaited case (the run never finishes); counting an unanswered thread as 0 bytes
 * fails the unsized case (no thread is named and the remainder carries no bound).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { workerHeapReadings, type RemainderInputs } from "../src/lib/daemon-memory-telemetry.js";
import { workerThreads, type TrackedWorker, type WorkerThread } from "../src/lib/worker-heaps.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-thread-heaps-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(f);
}

const okResult = (id: string): Awaited<ReturnType<DaemonDeps["runOne"]>> =>
  ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One dispatch held open across `ticks` ticker sleeps; `events` records the row and read order. */
async function heartbeat(extra: Partial<DaemonDeps>, opts: { ticks: number; settleMs: number; events?: string[] }): Promise<Record<string, unknown>[]> {
  const merged = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let sleeps = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { await gate; merged.add(id); return okResult(id); },
      sweepLight: async () => {},
      sleep: async () => { sleeps++; await settle(opts.settleMs); if (sleeps >= opts.ticks) release?.(); },
      log: (step, e = {}) => {
        if (step !== "daemon.alive") return;
        rows.push(e);
        opts.events?.push("row");
      },
      ...extra,
    },
    { max: 1 },
  );
  return rows;
}

/** A thread double: answers `heap`, or never answers when `heap` is undefined. */
function fakeThread(threadId: number, heap: { total: number; used: number } | undefined, events?: string[]): WorkerThread {
  return {
    threadId,
    once: (() => undefined) as unknown as WorkerThread["once"],
    getHeapStatistics: (() => {
      events?.push(`read:${threadId}`);
      return heap === undefined
        ? new Promise(() => {})
        : Promise.resolve({ total_heap_size: heap.total, used_heap_size: heap.used });
    }) as unknown as WorkerThread["getHeapStatistics"],
  };
}

const MAIN: Required<RemainderInputs> = { rss_bytes: 4_600_000_000, vm_swap_bytes: 400_000_000, heap_total_bytes: 550_000_000, external_bytes: 50_000_000 };

/** A telemetry reader built from the book alone, so every row value is a fixture value. */
function bookReader(live: () => readonly TrackedWorker[], timeoutMs: number): DaemonDeps["readMemoryTelemetry"] {
  const book = workerHeapReadings({ live, timeoutMs });
  return Object.assign(() => ({ ...MAIN, ...book.fields(MAIN) }), { afterRow: () => book.refresh() });
}

test("daemon.alive carries per-spawn-site worker heap totals from the previous tick's read", async () => {
  const live: TrackedWorker[] = [
    { kind: "read-plane:startReadPlane", thread: fakeThread(1, { total: 300_000_000, used: 200_000_000 }) },
    { kind: "read-plane:startReadPlane", thread: fakeThread(2, { total: 100_000_000, used: 60_000_000 }) },
    { kind: "secret-boundary:spawnSocketThread", thread: fakeThread(3, { total: 50_000_000, used: 40_000_000 }) },
  ];
  const rows = await heartbeat({ readMemoryTelemetry: bookReader(() => live, 1_000) }, { ticks: 3, settleMs: 20 });
  assert.ok(rows.length >= 2, `two heartbeats were written (got ${rows.length})`);
  const [first, second] = rows;
  assert.equal(first.mem_worker_heaps, "pending:first-read", "the first row precedes any completed read");
  assert.equal("worker_heaps" in first, false, "no reading is invented before one completes");
  assert.deepEqual(second.worker_heaps, {
    "read-plane:startReadPlane": { threads: 2, total_bytes: 400_000_000, used_bytes: 260_000_000 },
    "secret-boundary:spawnSocketThread": { threads: 1, total_bytes: 50_000_000, used_bytes: 40_000_000 },
  });
  assert.equal(second.worker_heap_total_bytes, 450_000_000);
  assert.ok(Number.isInteger(second.worker_heap_age_ms) && (second.worker_heap_age_ms as number) >= 0, "the reading's age is recorded");
  assert.equal(second.native_remainder_bytes, 4_600_000_000 + 400_000_000 - 550_000_000 - 50_000_000 - 450_000_000);
  assert.equal(second.native_remainder_kind, "inferred", "every thread answered: the remainder is inferred, not bounded");
  assert.equal(second.mem_worker_heaps, undefined);
  assert.equal(second.phase, "dispatch", "the existing heartbeat fields still ride the row");
});

test("an unanswered thread is named unsized and makes the remainder a bound, never 0 bytes", async () => {
  const live: TrackedWorker[] = [
    { kind: "read-plane:startReadPlane", thread: fakeThread(4, { total: 300_000_000, used: 200_000_000 }) },
    { kind: "read-plane:startReadPlane", thread: fakeThread(5, undefined) },
    { kind: "board-worker:spawnBoard", thread: fakeThread(6, undefined) },
  ];
  const rows = await heartbeat({ readMemoryTelemetry: bookReader(() => live, 15) }, { ticks: 3, settleMs: 60 });
  const read = rows.find((row) => row.worker_heaps !== undefined);
  assert.ok(read, "a row carries the completed read");
  assert.deepEqual(read.worker_heaps, {
    "read-plane:startReadPlane": { threads: 2, total_bytes: 300_000_000, used_bytes: 200_000_000, unsized: [5] },
    "board-worker:spawnBoard": { threads: 1, total_bytes: 0, used_bytes: 0, unsized: [6] },
  }, "each unanswered thread is counted and named unsized at its own spawn site");
  assert.equal(read.worker_heap_total_bytes, 300_000_000, "only sized threads are summed: the worker total is a lower bound");
  assert.equal(read.native_remainder_bytes, 4_600_000_000 + 400_000_000 - 550_000_000 - 50_000_000 - 300_000_000);
  assert.equal(read.native_remainder_kind, "inferred-upper-bound",
    "the unsized heaps are still inside the remainder, so it is marked a bound rather than read as exact");
});

test("the heartbeat is written without awaiting the read", { timeout: 20_000 }, async () => {
  const events: string[] = [];
  // A thread that never answers, under a backstop far longer than this whole run.
  const live: TrackedWorker[] = [{ kind: "stuck:never", thread: fakeThread(7, undefined, events) }];
  const rows = await heartbeat({ readMemoryTelemetry: bookReader(() => live, 3_600_000) }, { ticks: 4, settleMs: 0, events });
  assert.ok(rows.length >= 3, `every tick still wrote daemon.alive while the read hung (got ${rows.length})`);
  assert.equal(events[0], "row", "the row is written before the read starts");
  assert.equal(events[1], "read:7", "the read starts right after the first row");
  assert.equal(events.filter((e) => e === "read:7").length, 1, "a read still in flight is not doubled");
  assert.ok(rows.every((row) => row.mem_worker_heaps === "pending:first-read"), "an unfinished read is pending, never zero");
});

test("the registry sizes a real worker thread by its spawn site on the heartbeat", { timeout: 20_000 }, async () => {
  const registry = workerThreads(); // subscribe before creating the worker, as the daemon does
  const readMemoryTelemetry = bookReader(registry.live, 1_000);
  const thread = new Worker("setInterval(() => {}, 1000);", { eval: true });
  try {
    await new Promise<void>((resolve) => thread.once("online", () => resolve()));
    const rows = await heartbeat({ readMemoryTelemetry }, { ticks: 3, settleMs: 100 });
    const read = rows.find((row) => row.worker_heaps !== undefined);
    assert.ok(read, "a row carries the real thread's read");
    const sites = read.worker_heaps as Record<string, { threads: number; total_bytes: number; used_bytes: number }>;
    const mine = Object.entries(sites).find(([site]) => site.startsWith("the-daemon-heartbeat-names-its-worker-thread-heaps.test:"));
    assert.ok(mine, `the thread is named by its spawn site (sites: ${Object.keys(sites).join(", ")})`);
    assert.ok(mine[1].threads >= 1 && mine[1].total_bytes > 0 && mine[1].used_bytes > 0, "its isolate's heap is measured");
    assert.equal(read.worker_heap_total_bytes, Object.values(sites).reduce((sum, s) => sum + s.total_bytes, 0));
    assert.equal(read.native_remainder_bytes,
      MAIN.rss_bytes + MAIN.vm_swap_bytes - MAIN.heap_total_bytes - MAIN.external_bytes -
      (read.worker_heap_total_bytes as number));
  } finally {
    await thread.terminate();
  }
});

test("the sampler module references no heap snapshot, inspector or gc entry point", () => {
  const text = readFileSync(join(REPO_ROOT, "src", "lib", "daemon-memory-telemetry.ts"), "utf8");
  for (const forbidden of [
    /HeapSnapshot/, /\binspector\b/i, /\bgc\s*\(/, /expose[-_]gc/, /max[-_]old[-_]space/, /NODE_OPTIONS/, /setFlagsFromString/,
    /resourceLimits/, /\bSession\b/,
  ]) {
    assert.doesNotMatch(text, forbidden, `the sampler must stay passive: ${forbidden} found`);
  }
  // The control: the same scan is live, not vacuous, and reaches the thread read.
  assert.match(text, /getHeapStatistics\(\)/);
});

test("a thread whose heap read rejects is named unsized with its reason, never read as 0 bytes", async () => {
  const refusing: WorkerThread = {
    threadId: 8,
    once: (() => undefined) as unknown as WorkerThread["once"],
    getHeapStatistics: (() => Promise.reject(new Error("worker exited"))) as unknown as WorkerThread["getHeapStatistics"],
  };
  const book = workerHeapReadings({ live: () => [{ kind: "board-worker:spawnBoard", thread: refusing }], timeoutMs: 1_000, nowMs: () => 0 });
  book.refresh();
  await settle(20);
  const fields = book.fields(MAIN);
  assert.deepEqual(fields.worker_heaps, { "board-worker:spawnBoard": { threads: 1, total_bytes: 0, used_bytes: 0, unsized: [8] } });
  assert.equal(fields.native_remainder_kind, "inferred-upper-bound", "a refused read leaves its heap inside the remainder");
});

test("a registry that throws on listing carries error:<reason> on the next row instead of a reading", () => {
  const book = workerHeapReadings({ live: () => { throw new Error("registry gone"); }, timeoutMs: 1_000 });
  book.refresh();
  assert.deepEqual(book.fields(MAIN), { mem_worker_heaps: "error:registry gone" });
});

test("an afterRow hook that throws is logged and never stops the heartbeat", async () => {
  const steps: string[] = [];
  const failures: Record<string, unknown>[] = [];
  const readMemoryTelemetry = Object.assign(() => ({ ...MAIN }), { afterRow: () => { throw new Error("read could not start"); } });
  let sleeps = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => { await gate; return okResult(id); },
      sweepLight: async () => {},
      sleep: async () => { sleeps++; await settle(5); if (sleeps >= 3) release?.(); },
      log: (step, e = {}) => { steps.push(step); if (step === "daemon.memory_read_failed") failures.push(e); },
      readMemoryTelemetry,
    },
    { max: 1 },
  );
  assert.ok(steps.filter((s) => s === "daemon.alive").length >= 2, "heartbeats kept being written after the hook threw");
  assert.ok(failures.length >= 1, "the throw is logged as daemon.memory_read_failed");
  assert.equal(failures[0].error, "read could not start");
});
