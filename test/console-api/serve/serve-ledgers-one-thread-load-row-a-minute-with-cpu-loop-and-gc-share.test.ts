import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { EventLoopUtilization } from "node:perf_hooks";
import { test } from "node:test";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { SERVE_MEMORY_STEP } from "#src/lib/incident-invariants.js";
import { buildServeServer, type ServeDeps } from "#src/lib/serve.js";
import {
  SERVE_THREAD_LOAD_FAILED_STEP, SERVE_THREAD_LOAD_SAMPLE_MS, SERVE_THREAD_LOAD_STEP, startServeThreadLoad,
  type ServeThreadLoadOptions, type ServeThreadLoadRow, type ThreadLoadReading,
} from "#src/lib/serve-thread-load.js";
import { withTempDir } from "#src/lib/tmp.js";
import type { TrackedWorker, WorkerThread } from "#src/lib/worker-heaps.js";

type Row = { step: string } & Record<string, unknown>;
const MB = 1024 * 1024;

/** A timer the test fires by hand; records every interval asked for, and whether it was unref'd and cleared. */
function manualTimer() {
  const asked: number[] = [];
  const state = { unrefs: 0, cleared: 0 };
  let run: () => void = () => {};
  const handle = { unref: () => { state.unrefs += 1; return handle; } } as unknown as ReturnType<typeof setInterval>;
  return {
    asked, state, tick: () => run(),
    setInterval: ((fn: () => void, ms: number) => { asked.push(ms); run = fn; return handle; }) as unknown as typeof setInterval,
    clearInterval: ((h: unknown) => { if (h === handle) state.cleared += 1; }) as unknown as typeof clearInterval,
  };
}

const elu = (active: number, idle: number): EventLoopUtilization => ({ active, idle, utilization: active / (active + idle) });
/** performance.eventLoopUtilization's contract: one argument is a delta from it; none is the running total. */
function eluReader(totals: EventLoopUtilization[]) {
  let at = 0;
  return (a?: EventLoopUtilization, b?: EventLoopUtilization): EventLoopUtilization => {
    if (a && b) return elu(a.active - b.active, a.idle - b.idle);
    const now = totals[Math.min(at++, totals.length - 1)]!;
    return a ? elu(now.active - a.active, now.idle - a.idle) : now;
  };
}

/** A worker the sampler can read: CPU totals (µs) in order, and loop totals in order. */
function fakeWorker(threadId: number, cpu: Array<NodeJS.CpuUsage | Error> | undefined, loops: EventLoopUtilization[]) {
  let at = 0;
  return Object.assign(new EventEmitter(), {
    threadId,
    ...(cpu ? { cpuUsage: async () => { const next = cpu[Math.min(at++, cpu.length - 1)]!; if (next instanceof Error) throw next; return next; } } : {}),
    performance: { eventLoopUtilization: eluReader(loops) },
    getHeapStatistics: async () => ({ total_heap_size: 10 * MB, used_heap_size: 8 * MB, external_memory: 0 }),
  }) as unknown as WorkerThread;
}

function sampler(overrides: Partial<ServeThreadLoadOptions> & { workers: ServeThreadLoadOptions["workers"] }) {
  const timer = manualTimer();
  let now = 0;
  const rows: Row[] = [];
  let add: (ms: number) => void = () => {};
  let unsubscribed = 0;
  const load = startServeThreadLoad({
    clock: clockFromMillisFn(() => now),
    setInterval: timer.setInterval, clearInterval: timer.clearInterval,
    mainCpu: (() => { const seq = [{ user: 0, system: 0 }, { user: 9_000_000, system: 3_000_000 }, { user: 15_000_000, system: 3_000_000 }]; let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; })(),
    mainElu: eluReader([elu(0, 0), elu(30_000, 30_000), elu(36_000, 84_000)]),
    observeGc: (fn) => { add = fn; return () => { unsubscribed += 1; }; },
    usage: () => ({ rss: 900 * MB, heapUsed: 400 * MB, heapTotal: 500 * MB, external: 0, arrayBuffers: 0 }),
    heapLimit: () => 4096 * MB,
    log: (step, extra) => void rows.push({ step, ...extra }),
    ...overrides,
  });
  return {
    load, rows, timer, gc: (ms: number) => add(ms), unsubscribed: () => unsubscribed,
    advance: (ms: number) => { now += ms; },
    minute: async () => { now += SERVE_THREAD_LOAD_SAMPLE_MS; timer.tick(); await settle(); },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
const loadRows = (rows: Row[]): ServeThreadLoadRow[] => rows.filter((row) => row.step === SERVE_THREAD_LOAD_STEP) as unknown as ServeThreadLoadRow[];
async function waitFor<T>(read: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("W1-T11816 criterion 1: each minute's row names main and every live worker by its holder name with CPU ms and loop utilization", async () => {
  const board: TrackedWorker = { kind: "board-projection:start", thread: fakeWorker(4, [{ user: 1_000_000, system: 0 }, { user: 23_000_000, system: 1_000_000 }], [elu(100, 900), elu(45_100, 15_900)]) };
  const views: TrackedWorker = { kind: "read-model-worker:spawn", thread: fakeWorker(7, [{ user: 500_000, system: 500_000 }, { user: 6_000_000, system: 1_000_000 }], [elu(0, 1_000), elu(6_000, 55_000)]) };
  const s = sampler({ workers: () => [board, views] });
  await s.minute();
  await s.minute();
  const rows = loadRows(s.rows);
  assert.equal(rows.length, 2, "one row a minute");
  const [first, second] = rows as [ServeThreadLoadRow, ServeThreadLoadRow];
  assert.deepEqual(first.threads.map((t) => [t.name, t.thread]), [["main", "thread-0"], ["worker-heap:board-projection:start", "thread-4"], ["worker-heap:read-model-worker:spawn", "thread-7"]]);
  assert.equal(first.threads[1]!.since_thread_start, true, "a worker first seen counts from its own start");
  assert.equal(second.window_ms, SERVE_THREAD_LOAD_SAMPLE_MS);
  assert.deepEqual(second.threads, [
    { name: "main", thread: "thread-0", cpu_ms: 6_000, cpu_share: 0.1, elu: 0.1 },
    { name: "worker-heap:board-projection:start", thread: "thread-4", cpu_ms: 23_000, cpu_share: 23_000 / 60_000, elu: 0.75 },
    { name: "worker-heap:read-model-worker:spawn", thread: "thread-7", cpu_ms: 6_000, cpu_share: 0.1, elu: 0.1 },
  ] satisfies ThreadLoadReading[], "the second minute is the delta since the first");
  s.load.stop();
});

test("W1-T11816 criterion 1: on the real runtime a busy worker's CPU and loop are read and main's are measured", async (t) => {
  const worker = new Worker("const end = Date.now() + 150; while (Date.now() < end); require('node:worker_threads').parentPort.postMessage('spun'); setTimeout(() => {}, 30_000);", { eval: true });
  t.after(() => worker.terminate());
  await new Promise((resolve) => worker.once("message", resolve));
  const rows: Row[] = [];
  const load = startServeThreadLoad({ workers: () => [{ kind: "spin:eval", thread: worker }], intervalMs: 50, log: (step, extra) => void rows.push({ step, ...extra }) });
  t.after(() => load.stop());
  const row = await waitFor(() => loadRows(rows).find((r) => !r.threads[1]?.since_thread_start) ?? undefined, "a second real row");
  const first = loadRows(rows)[0]!;
  assert.ok((first.threads[1]!.cpu_ms ?? 0) >= 100, `the spinning worker used its CPU: ${JSON.stringify(first.threads[1])}`);
  const main = row.threads[0]!;
  assert.equal(main.name, "main");
  assert.ok(typeof main.cpu_ms === "number" && main.cpu_ms >= 0 && typeof main.elu === "number" && main.elu >= 0 && main.elu <= 1, JSON.stringify(main));
  assert.equal(row.threads[1]!.name, "worker-heap:spin:eval");
  assert.ok(typeof row.threads[1]!.elu === "number", JSON.stringify(row.threads[1]));
});

test("W1-T11816 criterion 1: serve starts the sampler over the threads its serve.memory row names, and stops it at close", async () => {
  await withTempDir("thread-load-serve", async (root) => {
    mkdirSync(join(root, "state"));
    const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan.yaml");
    writeFileSync(ledgerPath, ""); writeFileSync(planPath, "[]\n");
    const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const projector: TrackedWorker = { kind: "read-model-worker:spawn", thread: fakeWorker(7, [{ user: 0, system: 0 }], [elu(0, 1)]) };
    const memoryTimer = manualTimer(), loadTimer = manualTimer();
    const rows: Row[] = [];
    let unsubscribed = 0;
    const deps: ServeDeps = {
      ledgerPath, fleetControlRoot: root, questionsRoot: root,
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
      issues: { close() {} }, tokens: { read: "r", write: "w" },
      consoleSha: "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa", gatewayCheckout: async () => ({ state: "clean" }) as never,
      githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
      assistantRepository: "craigoley/remudero",
      demand: { every: () => () => {} },
      log: (step, extra) => void rows.push({ step, ...extra }),
      serveMemory: { setInterval: memoryTimer.setInterval, clearInterval: memoryTimer.clearInterval, headroom: () => undefined, workers: () => [projector] },
      threadLoad: { setInterval: loadTimer.setInterval, clearInterval: loadTimer.clearInterval, observeGc: () => () => { unsubscribed += 1; } },
    };
    const server = buildServeServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/version`;
      const before = await fetch(url, { headers: { authorization: "Bearer r" } });
      assert.equal(before.status, 200); await before.text();
      assert.deepEqual(loadTimer.asked, [SERVE_THREAD_LOAD_SAMPLE_MS], "one minute interval");
      memoryTimer.tick(); loadTimer.tick();
      const row = await waitFor(() => loadRows(rows)[0], "serve's thread-load row");
      await waitFor(() => rows.find((r) => r.step === SERVE_MEMORY_STEP), "serve's memory row");
      const memoryNames = (rows.find((r) => r.step === SERVE_MEMORY_STEP)!.holders as Array<{ name: string; parts?: Record<string, unknown> }>)
        .filter((holder) => holder.name.startsWith("worker-heap:")).map((holder) => [holder.name, Object.keys(holder.parts ?? {})[0]]);
      assert.deepEqual(row.threads.slice(1).map((t) => [t.name, t.thread]), memoryNames, "a thread is named as serve.memory names its heap");
      assert.equal(row.threads[0]!.name, "main");
      const after = await fetch(url, { headers: { authorization: "Bearer r" } });
      assert.equal(after.status, 200, "the sampler changes no response"); await after.text();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    assert.equal(loadTimer.state.cleared, 1, "close stops the minute timer");
    assert.equal(unsubscribed, 1, "close stops the gc observer");
  });
});

test("W1-T11816 criterion 2: the row carries the minute's gc share from gc entries and the heap used and its limit", async () => {
  const s = sampler({ workers: () => [] });
  s.gc(1_200); s.gc(1_800);
  await s.minute();
  const [row] = loadRows(s.rows);
  assert.equal(row!.gc_ms, 3_000);
  assert.equal(row!.gc_count, 2);
  assert.equal(row!.gc_share, 0.05, "3 s of gc in a 60 s minute");
  assert.equal(row!.heap_used_bytes, 400 * MB);
  assert.equal(row!.heap_total_bytes, 500 * MB);
  assert.equal(row!.heap_limit_bytes, 4096 * MB);
  await s.minute();
  assert.deepEqual([loadRows(s.rows)[1]!.gc_ms, loadRows(s.rows)[1]!.gc_count, loadRows(s.rows)[1]!.gc_share], [0, 0, 0], "each minute counts only its own gc");
});

test("W1-T11816 criterion 2: on the real runtime a forced collection reaches the row through the gc observer", async (t) => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const rows: Row[] = [];
  const timer = manualTimer();
  const load = startServeThreadLoad({ workers: () => [], setInterval: timer.setInterval, clearInterval: timer.clearInterval, log: (step, extra) => void rows.push({ step, ...extra }) });
  t.after(() => load.stop());
  gc(); gc();
  await new Promise((resolve) => setTimeout(resolve, 50));
  timer.tick();
  const row = await waitFor(() => loadRows(rows)[0], "a real row");
  assert.ok(row.gc_count >= 2, `forced collections were observed: ${row.gc_count}`);
  assert.ok(row.gc_ms > 0 && row.gc_share > 0, JSON.stringify(row));
  assert.equal(row.heap_limit_bytes, getHeapStatistics().heap_size_limit);
  assert.ok(row.heap_used_bytes > 0 && row.heap_total_bytes >= row.heap_used_bytes);
});

test("W1-T11816 criterion 3: an ended or throwing worker is listed with its error and the row still lands; no per-thread CPU omits the fields", async (t) => {
  const ended = new Worker("", { eval: true });
  await new Promise((resolve) => ended.once("exit", resolve));
  const broken = Object.assign(new EventEmitter(), {
    threadId: 9, cpuUsage: async () => ({ user: 0, system: 0 }),
    performance: { eventLoopUtilization: () => { throw new Error("loop read refused"); } },
  }) as unknown as WorkerThread;
  const hung = Object.assign(new EventEmitter(), { threadId: 11, cpuUsage: () => new Promise(() => {}), performance: { eventLoopUtilization: eluReader([elu(0, 1)]) } }) as unknown as WorkerThread;
  const healthy: TrackedWorker = { kind: "ok:spawn", thread: fakeWorker(3, [{ user: 0, system: 0 }], [elu(0, 1)]) };
  const s = sampler({
    cpuTimeoutMs: 1,
    workers: () => [
      { kind: "ended:spawn", thread: ended }, { kind: "throws:spawn", thread: fakeWorker(5, [new Error("cpu read refused")], [elu(0, 1)]) },
      { kind: "broken:spawn", thread: broken }, { kind: "hung:spawn", thread: hung }, healthy,
    ],
  });
  t.after(() => s.load.stop());
  await s.minute();
  const [row] = loadRows(s.rows);
  const byName = new Map(row!.threads.map((reading) => [reading.name, reading]));
  assert.match(byName.get("worker-heap:ended:spawn")!.error ?? "", /not running/i, "the runtime's own refusal for an ended worker");
  assert.equal(byName.get("worker-heap:throws:spawn")!.error, "cpu read refused");
  assert.equal(byName.get("worker-heap:broken:spawn")!.error, "loop read refused");
  assert.match(byName.get("worker-heap:hung:spawn")!.error ?? "", /did not answer within 1 ms/);
  assert.equal(byName.get("worker-heap:ok:spawn")!.error, undefined, "the healthy worker is still read");
  assert.equal(typeof byName.get("main")!.cpu_ms, "number");

  const bare = sampler({ mainCpu: () => undefined, workers: () => [{ kind: "nocpu:spawn", thread: fakeWorker(6, undefined, [elu(0, 1), elu(30, 31)]) }] });
  await bare.minute(); await bare.minute();
  const plain = loadRows(bare.rows)[1]!;
  for (const reading of plain.threads) {
    assert.equal(Object.hasOwn(reading, "cpu_ms") || Object.hasOwn(reading, "cpu_share") || Object.hasOwn(reading, "error"), false, JSON.stringify(reading));
    assert.equal(typeof reading.elu, "number", "loop utilization is still read");
  }
  bare.load.stop();

  const throwing = sampler({ mainCpu: (() => { let i = 0; return () => { if (i++ > 0) throw new Error("main cpu refused"); return { user: 0, system: 0 }; }; })(), workers: () => [] });
  await throwing.minute();
  assert.equal(loadRows(throwing.rows)[0]!.threads[0]!.error, "main cpu refused");
  throwing.load.stop();

  const failing = sampler({ workers: () => { throw new Error("thread book unreadable"); } });
  await failing.minute();
  assert.deepEqual(failing.rows, [{ step: SERVE_THREAD_LOAD_FAILED_STEP, reason: "thread book unreadable" }], "a failed sample is ledgered, never thrown");
  failing.load.stop();
});

test("W1-T11816 criterion 4: a fixed set of counters, one unref'd minute interval, one row per minute, and only reads of each thread", async () => {
  const touched = new Set<string>();
  const readOnly = (threadId: number): WorkerThread => new Proxy(fakeWorker(threadId, [{ user: 0, system: 0 }], [elu(0, 1)]) as unknown as object, {
    get(target, key, receiver) { touched.add(String(key)); return Reflect.get(target, key, receiver); },
    set(_target, key) { throw new Error(`the sampler wrote ${String(key)} on a thread`); },
  }) as unknown as WorkerThread;
  let live: TrackedWorker[] = [1, 2, 3].map((id) => ({ kind: `w${id}:spawn`, thread: readOnly(id) }));
  const s = sampler({ workers: () => live });
  assert.deepEqual(s.timer.asked, [SERVE_THREAD_LOAD_SAMPLE_MS], "exactly one interval, a minute");
  assert.equal(s.timer.state.unrefs, 1, "the interval never holds serve open");
  await s.minute();
  assert.equal(s.load.baselines(), 3);
  for (let i = 0; i < 10_000; i++) s.gc(0.01);
  await s.minute();
  assert.equal(s.load.baselines(), 3, "ten thousand gc entries hold no more counters");
  live = live.slice(1);
  await s.minute();
  assert.equal(s.load.baselines(), 2, "an ended thread's baseline is dropped");
  assert.equal(loadRows(s.rows).length, 3, "one row per minute");
  assert.equal(s.rows.length, 3, "and nothing else is written");
  assert.deepEqual([...touched].filter((key) => !["threadId", "cpuUsage", "performance"].includes(key)), [], "only reads");
  assert.deepEqual(s.timer.asked, [SERVE_THREAD_LOAD_SAMPLE_MS], "no schedule change");
  s.load.stop();
  assert.equal(s.timer.state.cleared, 1);
  assert.equal(s.unsubscribed(), 1);
});
