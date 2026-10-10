// @source-text-subject: one case below asserts the sampler module's own text names no heap
// snapshot, debugger or collection entry point — the module's source IS that claim's subject.
/**
 * W1-T7092 — THE DAEMON HEARTBEAT NAMES ITS WORKER THREAD HEAPS.
 *
 * The core daemon held 4.3-4.65 GB rss against a 0.45-0.60 GB main heap and ran worker_threads whose
 * isolates `process.memoryUsage()` does not count. `workerHeapReadings`
 * (src/lib/daemon-memory-telemetry.ts) reports each thread by creation site, role, thread id and daemon
 * generation, with the main isolate's heap figures and an explicit state; the daemon's `afterRow` hook
 * (daemon.ts) starts a request round only after `daemon.alive` is written.
 *
 * MEASURED (isolated probe, node 24.21.0): a worker blocked in `execFileSync` cannot answer
 * `getHeapStatistics()`, and every timed-out request stayed outstanding (1, 2, 3, 4) until it unblocked.
 * The cases below hold the book to ONE unresolved request per worker generation.
 *
 * The production reader's own case lives in test/the-daemon-heartbeat-says-what-its-memory-is.test.ts,
 * which already imports run-task.ts (the affected-suite reach ratchet counts every importer of it).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { workerHeapReadings, type HeapStatistics, type WorkerHeapEntry, type WorkerHeapFields } from "../src/lib/daemon-memory-telemetry.js";
import { readWorkerHeaps, type TrackedWorker, type WorkerThread } from "../src/lib/worker-heaps.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A whole getHeapStatistics() answer whose every figure derives from `mb`, so each field is checkable. */
function heap(mb: number): HeapStatistics {
  const m = mb * 1_000_000;
  return { used_heap_size: m, total_heap_size: 2 * m, total_physical_size: 2 * m - 1, external_memory: 3 * m, malloced_memory: 4 * m, heap_size_limit: 8_000 * 1_000_000 };
}

/** A thread double whose answers the test controls. `answer()` settles a request; `exit()` fires its exit. */
function controlledThread(threadId: number) {
  const requests: Array<{ resolve: (h: HeapStatistics) => void; reject: (e: Error) => void }> = [];
  const exitListeners: Array<(code: number) => void> = [];
  const thread = {
    threadId,
    once: ((event: string, listener: (code: number) => void) => {
      if (event === "exit") exitListeners.push(listener);
      return thread;
    }) as unknown as WorkerThread["once"],
    getHeapStatistics: (() => new Promise<HeapStatistics>((resolve, reject) => requests.push({ resolve, reject }))) as unknown as WorkerThread["getHeapStatistics"],
  };
  return {
    thread: thread as unknown as WorkerThread,
    get asked(): number { return requests.length; },
    answer(h: HeapStatistics, index = 0): void { requests[index].resolve(h); },
    fail(message: string, index = 0): void { requests[index].reject(new Error(message)); },
    exit(code: number): void { for (const listener of exitListeners.splice(0)) listener(code); },
  };
}

const MAIN_HEAP = heap(500);
const MAIN = { rss_bytes: 4_600_000_000, vm_swap_bytes: 400_000_000, external_bytes: 50_000_000 };

function book(live: () => readonly TrackedWorker[], timeoutMs = 15) {
  return workerHeapReadings({ live, mainHeap: () => MAIN_HEAP, generation: "DAEMON-1791542911631", timeoutMs });
}
const threadsOf = (fields: WorkerHeapFields): WorkerHeapEntry[] => fields.worker_heaps?.threads ?? [];
const entry = (fields: WorkerHeapFields, threadId: number): WorkerHeapEntry | undefined => threadsOf(fields).find((t) => t.thread_id === threadId);

test("a thread that never answers keeps exactly one outstanding request across repeated timeouts", async () => {
  const stuck = controlledThread(21);
  const readings = book(() => [{ kind: "read-plane:startReadPlane", thread: stuck.thread }]);
  for (let i = 0; i < 6; i++) {
    readings.refresh();
    await settle(30); // twice the 15 ms timeout, every round
  }
  assert.equal(stuck.asked, 1, "a timeout neither cancels the request nor permits another");
  const row = entry(readings.fields(MAIN), 21);
  assert.equal(row?.state, "unanswered");
  assert.ok((row?.outstanding_ms ?? 0) >= 150, `the one request's wait is reported (${row?.outstanding_ms} ms)`);
  assert.equal(row?.total_heap_bytes, undefined, "an unanswered thread carries no figures, never zeros");
});

test("eventual completion clears the one request, and only then is the thread asked again", async () => {
  const slow = controlledThread(22);
  const readings = book(() => [{ kind: "read-plane:startReadPlane", thread: slow.thread }]);
  readings.refresh();
  await settle(30);
  readings.refresh();
  assert.equal(slow.asked, 1);
  slow.answer(heap(300));
  await settle(5);
  const stale = entry(readings.fields(MAIN), 22);
  assert.equal(stale?.state, "stale", "an answer to an earlier round is stale, with its figures and age");
  assert.equal(stale?.total_heap_bytes, heap(300).total_heap_size);
  readings.refresh();
  assert.equal(slow.asked, 2, "the next round asks again once the request settled");
  slow.answer(heap(310), 1);
  await settle(5);
  const fresh = entry(readings.fields(MAIN), 22);
  assert.equal(fresh?.state, "fresh");
  assert.equal(fresh?.used_heap_bytes, heap(310).used_heap_size);
  assert.equal(fresh?.outstanding_ms, undefined);
});

test("an exited worker is reported exited once, and its late answer is dropped, not attributed", async () => {
  const leaving = controlledThread(23);
  let live: TrackedWorker[] = [{ kind: "ledger-union:rotationDigestCodec", thread: leaving.thread }];
  const readings = book(() => live);
  readings.refresh();
  leaving.exit(1);
  live = [];
  const first = entry(readings.fields(MAIN), 23);
  assert.deepEqual({ state: first?.state, exit_code: first?.exit_code }, { state: "exited", exit_code: 1 });
  assert.equal(entry(readings.fields(MAIN), 23), undefined, "an exit is reported once, then dropped");
  leaving.answer(heap(900));
  await settle(5);
  const after = readings.fields(MAIN);
  assert.equal(entry(after, 23), undefined, "the late answer does not resurrect the exited thread");
  assert.equal(after.worker_heaps?.late_dropped, 1, "the late answer is counted as dropped");
});

test("a replacement thread at the same site is a new generation that the old thread's late answer never reaches", async () => {
  const old = controlledThread(24);
  const replacement = controlledThread(25);
  let live: TrackedWorker[] = [{ kind: "read-plane:startReadPlane", thread: old.thread }];
  const readings = book(() => live);
  readings.refresh();
  old.exit(0);
  live = [{ kind: "read-plane:startReadPlane", thread: replacement.thread }];
  readings.refresh();
  assert.equal(replacement.asked, 1, "the replacement is asked in its own right while the old request is still unresolved");
  replacement.answer(heap(120));
  old.answer(heap(999));
  await settle(5);
  const fields = readings.fields(MAIN);
  assert.equal(entry(fields, 24)?.state, "exited");
  const now = entry(fields, 25);
  assert.equal(now?.state, "fresh");
  assert.equal(now?.total_heap_bytes, heap(120).total_heap_size, "the replacement carries only its own answer");
  assert.equal(fields.worker_heaps?.late_dropped, 1);
});

test("each thread is named by creation site, fixed-map role or unmapped, thread id and generation, with every heap figure", async () => {
  const sites: Array<[string, number, number, string]> = [
    ["read-plane:startReadPlane", 31, 300, "read-plane"],
    ["secret-boundary:startSocketThread", 32, 20, "git-credential-socket"],
    ["some-module:spawnSomething", 33, 40, "unmapped"],
  ];
  const threads = sites.map(([kind, id]) => ({ kind, t: controlledThread(id) }));
  const readings = book(() => threads.map(({ kind, t }) => ({ kind, thread: t.thread })));
  readings.refresh();
  threads.forEach(({ t }, i) => t.answer(heap(sites[i][2])));
  await settle(5);
  const fields = readings.fields(MAIN);
  assert.equal(fields.worker_heaps?.generation, "DAEMON-1791542911631");
  assert.deepEqual(fields.worker_heaps?.main, {
    role: "main", thread_id: 0, used_heap_bytes: MAIN_HEAP.used_heap_size, total_heap_bytes: MAIN_HEAP.total_heap_size,
    physical_heap_bytes: MAIN_HEAP.total_physical_size, external_bytes: MAIN_HEAP.external_memory,
    malloced_bytes: MAIN_HEAP.malloced_memory, heap_limit_bytes: MAIN_HEAP.heap_size_limit,
  });
  for (const [kind, id, mb, role] of sites) {
    const row = entry(fields, id);
    const h = heap(mb);
    assert.ok(row && Number.isSafeInteger(row.age_ms), `thread ${id} is reported with its reading's age`);
    assert.deepEqual({ ...row, age_ms: 0 }, {
      site: kind, role, thread_id: id, state: "fresh", age_ms: 0,
      used_heap_bytes: h.used_heap_size, total_heap_bytes: h.total_heap_size, physical_heap_bytes: h.total_physical_size,
      external_bytes: h.external_memory, malloced_bytes: h.malloced_memory, heap_limit_bytes: h.heap_size_limit,
    });
  }
});

test("rss and swap stay separate, and the residual is an approximate unattributed figure only when every thread is fresh", async () => {
  const a = controlledThread(41);
  const b = controlledThread(42);
  const live: TrackedWorker[] = [{ kind: "read-plane:startReadPlane", thread: a.thread }, { kind: "status:prewarm", thread: b.thread }];
  const readings = book(() => live);
  readings.refresh();
  a.answer(heap(300));
  await settle(30);
  const partial = readings.fields(MAIN);
  assert.equal(partial.unattributed_bytes_approx, undefined, "a thread not fresh leaves no residual");
  assert.match(String(partial.unattributed_omitted), /threads-not-fresh:42=unanswered/);
  b.answer(heap(100));
  await settle(5);
  readings.refresh();
  a.answer(heap(300), 1);
  b.answer(heap(100), 1);
  await settle(5);
  const whole = readings.fields(MAIN);
  assert.equal(whole.unattributed_bytes_approx,
    MAIN.rss_bytes - MAIN_HEAP.total_physical_size - heap(300).total_physical_size - heap(100).total_physical_size - MAIN.external_bytes);
  assert.equal(whole.unattributed_omitted, undefined);
  const flat = JSON.stringify(whole);
  assert.doesNotMatch(flat, /native/i, "nothing is labelled native memory");
  assert.ok(!flat.includes(String(MAIN.rss_bytes + MAIN.vm_swap_bytes)), "no figure adds swap to rss");
});

test("a thread list or heap read that throws is named, and leaves no request outstanding", () => {
  const throwing = workerHeapReadings({ live: () => { throw new Error("registry gone"); }, mainHeap: () => MAIN_HEAP });
  throwing.refresh();
  assert.deepEqual(throwing.fields(MAIN), { mem_worker_heaps: "error:registry gone" });
  const refusing = {
    threadId: 51, once: (() => undefined) as unknown as WorkerThread["once"],
    getHeapStatistics: (() => { throw new Error("worker is terminating"); }) as unknown as WorkerThread["getHeapStatistics"],
  } as unknown as WorkerThread;
  const readings = book(() => [{ kind: "read-plane:startReadPlane", thread: refusing }]);
  readings.refresh();
  const row = entry(readings.fields(MAIN), 51);
  assert.equal(row?.state, "unanswered");
  assert.equal(row?.error, "worker is terminating");
  assert.equal(row?.outstanding_ms, undefined, "a request that never started is not outstanding");
});

test("an exited Worker's -1 thread id is skipped, and a thread with no exit event is marked exited once the registry drops it", () => {
  const gone = { threadId: -1, once: () => undefined, getHeapStatistics: () => { throw new Error("never asked"); } } as unknown as WorkerThread;
  const deaf = controlledThread(81);
  const noExitEvent = { ...deaf.thread, once: () => { throw new Error("no exit event"); } } as unknown as WorkerThread;
  let live: TrackedWorker[] = [{ kind: "status:prewarm", thread: gone }, { kind: "status:prewarm", thread: noExitEvent }];
  const readings = book(() => live);
  readings.refresh();
  const first = readings.fields(MAIN);
  assert.deepEqual(threadsOf(first).map((t) => t.thread_id), [81], "a thread reading -1 has already exited and is not booked");
  live = [];
  readings.refresh();
  const second = entry(readings.fields(MAIN), 81);
  assert.equal(second?.state, "exited", "a thread the registry stopped listing is exited even without an exit event");
  assert.equal(second?.exit_code, undefined, "no exit code is invented");
});

test("a failed main-heap read omits main and the residual with its reason, and a missing input is named", async () => {
  const t = controlledThread(91);
  const failing = workerHeapReadings({ live: () => [{ kind: "read-plane:startReadPlane", thread: t.thread }], mainHeap: () => { throw new Error("v8 unavailable"); }, timeoutMs: 15 });
  failing.refresh();
  t.answer(heap(10));
  await settle(5);
  const noMain = failing.fields(MAIN);
  assert.equal(noMain.worker_heaps?.main, undefined, "an unread main isolate is absent, never zero");
  assert.equal(noMain.unattributed_omitted, "main-heap-unread:v8 unavailable");
  const u = controlledThread(92);
  const partial = book(() => [{ kind: "read-plane:startReadPlane", thread: u.thread }]);
  partial.refresh();
  u.answer(heap(10));
  await settle(5);
  const missing = partial.fields({ rss_bytes: MAIN.rss_bytes });
  assert.equal(missing.unattributed_bytes_approx, undefined);
  assert.equal(missing.unattributed_omitted, "needs:rss_bytes,external_bytes");
});

test("a heap request that rejects is named on the thread, releases it for the next round, and is ignored once the thread exited", async () => {
  const flaky = controlledThread(101);
  const leaving = controlledThread(102);
  let live: TrackedWorker[] = [{ kind: "read-plane:startReadPlane", thread: flaky.thread }, { kind: "status:prewarm", thread: leaving.thread }];
  const readings = book(() => live);
  readings.refresh();
  flaky.fail("worker is terminating");
  leaving.exit(0);
  leaving.fail("terminated");
  await settle(5);
  const fields = readings.fields(MAIN);
  const failed = entry(fields, 101);
  assert.deepEqual({ state: failed?.state, error: failed?.error, outstanding: failed?.outstanding_ms }, { state: "unanswered", error: "worker is terminating", outstanding: undefined },
    "a rejected request is named, never zero, and leaves nothing outstanding");
  assert.equal(entry(fields, 102)?.error, undefined, "a rejection after the thread exited is not attributed to it");
  live = [{ kind: "read-plane:startReadPlane", thread: flaky.thread }];
  readings.refresh();
  assert.equal(flaky.asked, 2, "the settled rejection lets the next round ask again");
});

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-thread-heaps-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(f);
}

/** One dispatch held open across `ticks` ticker sleeps of `settleMs` each; returns every daemon.alive row. */
async function heartbeat(extra: Partial<DaemonDeps>, ticks: number, settleMs: number, events: string[]): Promise<Record<string, unknown>[]> {
  const merged = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let sleeps = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { await gate; merged.add(id); return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" }; },
      sweepLight: async () => {},
      sleep: async () => { sleeps++; await settle(settleMs); if (sleeps >= ticks) release?.(); },
      log: (step, e = {}) => {
        if (step === "daemon.alive") { rows.push(e); events.push("row"); }
        if (step === "daemon.memory_read_failed") events.push(`failed:${String(e.error)}`);
      },
      ...extra,
    },
    { max: 1 },
  );
  return rows;
}

test("every heartbeat is written on time while a thread never answers, and it is asked once", { timeout: 20_000 }, async () => {
  const events: string[] = [];
  const stuck = controlledThread(61);
  const counted = { ...stuck.thread, getHeapStatistics: () => { events.push("read"); return stuck.thread.getHeapStatistics(); } } as unknown as WorkerThread;
  const readings = book(() => [{ kind: "read-plane:startReadPlane", thread: counted }]);
  const readMemoryTelemetry = Object.assign(() => ({ ...MAIN, ...readings.fields(MAIN) }), { afterRow: () => readings.refresh() });
  const rows = await heartbeat({ readMemoryTelemetry }, 5, 30, events);
  assert.ok(rows.length >= 4, `every tick wrote daemon.alive while the thread stayed silent (got ${rows.length})`);
  assert.deepEqual(events.slice(0, 2), ["row", "read"], "the row is written before the request starts");
  assert.equal(events.filter((e) => e === "read").length, 1, "the silent thread is never asked twice");
  const last = rows.at(-1) as WorkerHeapFields;
  assert.equal(entry(last, 61)?.state, "unanswered", "the silent thread is unanswered, never zero");
});

test("serve's own worker-heap reading keeps its shape: the daemon book changes nothing serve.memory reads", async () => {
  const served = controlledThread(71);
  const reading = readWorkerHeaps([{ kind: "read-model-worker:spawnReadModel", thread: served.thread }], 1_000);
  served.answer(heap(200));
  const h = heap(200);
  assert.deepEqual(await reading, [{
    name: "worker-heap:read-model-worker:spawnReadModel", kind: "worker-heap", entries: 1,
    bytes: h.total_heap_size + h.external_memory, parts: { "thread-71": { entries: 1, bytes: h.total_heap_size + h.external_memory } },
  }], "serve.memory's worker-heap line is still committed heap plus external, one part per thread");
});

test("a request round that throws is logged, and every heartbeat is still written", { timeout: 20_000 }, async () => {
  const events: string[] = [];
  const readMemoryTelemetry = Object.assign(() => ({ ...MAIN }), { afterRow: () => { throw new Error("round refused"); } });
  const rows = await heartbeat({ readMemoryTelemetry }, 4, 5, events);
  assert.ok(rows.length >= 3, `the heartbeat survived every failed round (got ${rows.length})`);
  assert.equal(events.filter((e) => e === "failed:round refused").length, rows.length, "each failed round is logged once, after its row");
});

test("the sampler module references no heap snapshot, inspector or gc entry point", () => {
  const text = readFileSync(join(REPO_ROOT, "src", "lib", "daemon-memory-telemetry.ts"), "utf8");
  for (const forbidden of [
    /HeapSnapshot/, /\binspector\b/i, /\bgc\s*\(/, /expose[-_]gc/, /max[-_]old[-_]space/, /NODE_OPTIONS/, /setFlagsFromString/,
    /resourceLimits/, /\bSession\b/, /\.terminate\(/,
  ]) {
    assert.doesNotMatch(text, forbidden, `the sampler must stay passive: ${forbidden} found`);
  }
  // The control: the same scan is live, not vacuous, and reaches the thread read.
  assert.match(text, /getHeapStatistics\(\)/);
});

// The three cases below replace the original implementation's refusal, listing and hook-throw tests (2ba829d99),
// keeping each scenario but asserting the amended W1-T7092 contract instead of the removed per-site `unsized`
// aggregation and `native_remainder_kind`.
test("a heap read that rejects leaves its thread unanswered with the reason, no figures and no residual, never 0 bytes", async () => {
  const refusing = {
    threadId: 8,
    once: (() => undefined) as unknown as WorkerThread["once"],
    getHeapStatistics: (() => Promise.reject(new Error("worker exited"))) as unknown as WorkerThread["getHeapStatistics"],
  } as unknown as WorkerThread;
  const readings = book(() => [{ kind: "board-worker:spawnBoard", thread: refusing }]);
  readings.refresh();
  await settle(20);
  const fields = readings.fields(MAIN);
  assert.deepEqual(entry(fields, 8), { site: "board-worker:spawnBoard", role: "unmapped", thread_id: 8, state: "unanswered", error: "worker exited" },
    "a refused read names the thread and its reason and carries no figures");
  assert.equal(fields.unattributed_bytes_approx, undefined);
  assert.equal(fields.unattributed_omitted, "threads-not-fresh:8=unanswered", "the residual is withheld, naming the thread");
  assert.doesNotMatch(JSON.stringify(fields), /native|unsized/, "no removed field survives");
});

test("a registry that throws on listing carries error:<reason>, and the next good listing recovers", async () => {
  const healthy = controlledThread(9);
  let broken = true;
  const readings = book(() => { if (broken) throw new Error("registry gone"); return [{ kind: "read-plane:startReadPlane", thread: healthy.thread }]; });
  readings.refresh();
  assert.deepEqual(readings.fields(MAIN), { mem_worker_heaps: "error:registry gone" }, "no reading is invented while the listing fails");
  broken = false;
  readings.refresh();
  healthy.answer(heap(50));
  await settle(5);
  const recovered = readings.fields(MAIN);
  assert.equal(recovered.mem_worker_heaps, undefined, "the error clears once a listing succeeds");
  assert.equal(entry(recovered, 9)?.state, "fresh");
});

test("an afterRow hook that throws is logged after its row and every heartbeat still carries the memory fields", { timeout: 20_000 }, async () => {
  const events: string[] = [];
  const readMemoryTelemetry = Object.assign(() => ({ ...MAIN }), { afterRow: () => { throw new Error("read could not start"); } });
  const rows = await heartbeat({ readMemoryTelemetry }, 3, 5, events);
  assert.ok(rows.length >= 2, `heartbeats kept being written after the hook threw (got ${rows.length})`);
  assert.ok(rows.every((row) => row.rss_bytes === MAIN.rss_bytes), "each row still carries the memory reading");
  assert.deepEqual(events.slice(0, 2), ["row", "failed:read could not start"], "the failure is logged after its row, not instead of it");
});
