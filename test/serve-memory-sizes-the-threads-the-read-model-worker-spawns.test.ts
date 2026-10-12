// test/serve-memory-sizes-the-threads-the-read-model-worker-spawns.test.ts — W1-T5480.
//
// W1-T5355 sizes each thread serve's main thread spawns, from that thread's `worker_threads`
// channel. The read-model worker spawns four more (views, slow lane, oracle, integrity check), whose
// spawns publish on ITS channel, so their heaps sat in `unattributed_bytes`: serve at 3.49 GB rss
// named 338 MB of worker heaps and left 2.57 GB unattributed (2026-10-03 19:17Z). The worker now
// answers for its own threads over its port, and serve folds them in as `worker-heap:<spawn site>`.
// FALSIFIER: drop `answerThreadHeaps` from `runReadModelWorker` and the real worker's views thread
// never appears in the sample; its bytes stay in `unattributed_bytes`.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { createReadModelWorker, runReadModelWorker } from "../src/lib/read-model-worker.js";
import * as memory from "../src/lib/serve-memory.js";
import { makeTempDir } from "../src/lib/tmp.js";

type HolderReading = memory.HolderReading;
type Book = ReturnType<typeof memory.trackWorkerThreads>;
/** The W1-T5480 exports, read off the namespace so this file loads on a base that lacks them. */
const nested = memory as unknown as {
  THREAD_HEAPS_REQUEST: string;
  THREAD_HEAPS_ANSWER: string;
  askNestedThreadHeaps: (thread: Worker) => (msg: unknown) => boolean;
};

const MB = 1024 ** 2;
const USAGE: NodeJS.MemoryUsage = { rss: 3_000 * MB, heapTotal: 600 * MB, heapUsed: 500 * MB, external: 14 * MB, arrayBuffers: 6 * MB };
const OWN = `${memory.WORKER_HEAP_PREFIX}read-model-worker:spawn`;
const VIEWS = `${memory.WORKER_HEAP_PREFIX}read-model-worker:spawnViews`;
const LEDGER_ROW = `${JSON.stringify({ ts: "2026-10-03T19:17:20.000Z", step: "run.start", task_id: "W1-T1" })}\n`;

/**
 * ONE after-hook owns the order (#8917): node:test skips the hooks behind a throwing one, so every
 * thread is stopped and awaited before the scratch dir goes, and a thread left running never holds
 * a coverage shard open.
 */
function scratch(t: TestContext, kind: string, book: Book): { dir: string; stopsFirst: (stop: () => void) => void } {
  const dir = makeTempDir(kind);
  const stops: Array<() => void> = [];
  t.after(async () => {
    for (const stop of stops) stop();
    await Promise.all(book.live().map(({ thread }) => (thread as Worker).terminate()));
    book.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  writeFileSync(join(dir, "ledger.ndjson"), LEDGER_ROW);
  return { dir, stopsFirst: (stop) => void stops.push(stop) };
}

const named = (readings: readonly HolderReading[], name: string): HolderReading | undefined => readings.find((reading) => reading.name === name);
const sized = (reading: HolderReading | undefined): boolean => reading !== undefined && reading.bytes > 0 && reading.error === undefined;

test("W1-T5480: a real read-model worker's views thread is sized on serve's sample and leaves unattributed_bytes", async (t) => {
  const book = memory.trackWorkerThreads();
  const { dir, stopsFirst } = scratch(t, "rmw-nested-heaps", book);
  const handle = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], tickMs: 20, every: () => () => {} });
  stopsFirst(() => handle.stop());
  handle.start();
  // The first request waits in the port while the worker loads; a thread not yet online reads unsized.
  let readings: HolderReading[] = [];
  for (let read = 0; read < 4 && !(sized(named(readings, OWN)) && sized(named(readings, VIEWS))); read += 1) {
    if (read > 0) await sleep(250);
    readings = await memory.readWorkerHeaps(book.live(), 5_000);
  }
  const own = named(readings, OWN);
  const views = named(readings, VIEWS);
  assert.ok(sized(own), `the read-model worker itself is still sized by serve: ${JSON.stringify(readings)}`);
  assert.ok(sized(views), `the thread it spawned is reported over its port under its own spawn site: ${JSON.stringify(readings)}`);
  assert.equal(views?.entries, 1);
  assert.notDeepEqual(Object.keys(views?.parts ?? {}), Object.keys(own?.parts ?? {}), "a part per nested thread, by its own thread id");

  const sample = memory.sampleServeMemory([], { usage: () => USAGE, headroom: () => undefined, workerHeaps: readings });
  const unnested = memory.sampleServeMemory([], { usage: () => USAGE, headroom: () => undefined, workerHeaps: readings.filter((reading) => reading !== views) });
  assert.ok(sample.holders.some((holder) => holder.name === VIEWS && holder.kind === "worker-heap"), "the views thread is a holder on the serve.memory row");
  assert.equal(unnested.unattributed_bytes - sample.unattributed_bytes, views?.bytes, "its bytes are subtracted from unattributed_bytes");
});

test("W1-T5480: the worker branch answers a heap request with the threads it spawned", async (t) => {
  const book = memory.trackWorkerThreads();
  const { dir, stopsFirst } = scratch(t, "rmw-nested-branch", book);
  const answers: Array<{ type?: string; id?: number; readings?: HolderReading[] }> = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  const port = {
    on: (_event: "message", run: (msg: { type?: string }) => void) => void (onMessage = run),
    postMessage: (m: unknown) => void ((m as { type?: string }).type === nested.THREAD_HEAPS_ANSWER && answers.push(m as (typeof answers)[number])),
    close: () => {},
  };
  runReadModelWorker(port, { kind: "remudero-read-model", stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], tickMs: 20, signal: new SharedArrayBuffer(8) });
  stopsFirst(() => onMessage?.({ type: "stop" }));
  let answer: (typeof answers)[number] | undefined;
  for (let id = 1; id <= 4 && !sized(named(answer?.readings ?? [], VIEWS)); id += 1) {
    if (id > 1) await sleep(250);
    onMessage?.({ type: nested.THREAD_HEAPS_REQUEST, id, timeoutMs: 10_000 } as { type?: string });
    for (let turn = 0; turn < 200 && !answers.some((posted) => posted.id === id); turn += 1) await sleep(25);
    answer = answers.find((posted) => posted.id === id);
  }
  assert.ok(answer, "the request is answered over the same port");
  assert.ok(sized(named(answer.readings ?? [], VIEWS)), `its views thread is in the answer: ${JSON.stringify(answer.readings)}`);
});

test("W1-T5480: a thread that never answers for its own threads is named unsized, never counted as none", async (t) => {
  const book = memory.trackWorkerThreads();
  const { stopsFirst } = scratch(t, "rmw-nested-silent", book);
  const silent = new Worker("setInterval(() => {}, 1000);", { eval: true });
  stopsFirst(() => void silent.terminate());
  const answered = nested.askNestedThreadHeaps(silent);
  assert.equal(answered({ type: "log" }), false, "the read-model worker's other messages pass through");
  assert.equal(answered({ type: nested.THREAD_HEAPS_ANSWER }), false, "an answer with no id settles nothing");
  assert.equal(answered({ type: nested.THREAD_HEAPS_ANSWER, id: 99, readings: [] }), true, "a late answer is consumed, never relayed");
  await new Promise((resolve) => silent.once("online", resolve));

  const readings = await memory.readWorkerHeaps([{ kind: "probe:spawn", thread: silent }], 300);
  const unsized = named(readings, `${memory.WORKER_HEAP_PREFIX}inside:probe:spawn`);
  assert.ok(sized(named(readings, `${memory.WORKER_HEAP_PREFIX}probe:spawn`)), "the thread's own heap is still read");
  assert.equal(unsized?.bytes, 0);
  assert.match(unsized?.error ?? "", new RegExp(`thread ${silent.threadId}'s own threads unsized: no answer within 300ms`));
  const sample = memory.sampleServeMemory([], { usage: () => USAGE, headroom: () => undefined, workerHeaps: readings });
  assert.ok(sample.holders.some((holder) => holder.name === unsized?.name && holder.error), "the sample carries the unsized reading by name");
});
