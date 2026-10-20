// W1-T9647: THE DAEMON NAMES WHAT HOLDS ITS HEAP, AND ITS CENSUS FILES THE TOP HOLDERS.
//
// After the slack reclaimer's full collection the core daemon held 867 MiB p50 of live heap (2026-10-15, n=282) and
// W1-T9105's memo_sizes named 7 MiB of it. These tests hold the `daemon.memory` row (every heap space, the process's
// swap, every holder with how it was sized), its sliced sizing, its coverage measure, and the offline census ranking.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  accountedHolder, calibrationFrom, capHolders, censusEstimate, censusFilingThreshold, createDaemonMemoryRegistry, createLiveSetKeeper,
  createPlanCopyBook, daemonHolderSource, DAEMON_MEMORY_SAMPLE_FAILED_STEP, DAEMON_MEMORY_SAMPLE_MS, DAEMON_MEMORY_STEP,
  DAEMON_MEMORY_TURN_BUDGET_MS, liveSetFromReclaim, measureHeapHolders, observedPlanSync, rankHeapCensus, readProcMemory,
  renderHeapCensus, sampleDaemonMemoryCensus, sourceMapCacheHolder, startDaemonMemoryCensus, type CensusCalibration, type CensusHolderSpec,
  type DaemonHolderReading, type DaemonMemoryHolder,
} from "../src/lib/daemon-memory-census.js";
import {
  createIncrementalLedgerUnion, createLedgerRotationMemo, createSizedMemo, LEDGER_ROTATION_LOAD_LINES_PER_TURN, ledgerMemoHolders, memoCreationSite,
} from "../src/lib/ledger-union.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MIB = 1024 * 1024;

/** A collector for the tests that must see a WeakRef cleared; never used by the code under test. */
function testCollector(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

/** Fake timers: the test fires each scheduled tick itself. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; unrefed: boolean; cleared: boolean }> = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, unrefed: false, cleared: false, unref() { timer.unrefed = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer: { unref?: () => unknown }) => { (timer as { cleared: boolean }).cleared = true; },
  };
}

/** Lets a fired tick's sample (which yields between holders) finish. */
async function drain(turns = 400): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

const quietIo = {
  heapStatistics: () => ({ used_heap_size: 1, total_heap_size: 2, total_physical_size: 2, heap_size_limit: 4, external_memory: 0, malloced_memory: 0,
    number_of_native_contexts: 1, number_of_detached_contexts: 0, used_global_handles_size: 0 }) as never,
  heapSpaces: () => [],
  heapCode: () => ({ bytecode_and_metadata_size: 0, code_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
  memoryUsage: () => ({ rss: 10, heapTotal: 2, heapUsed: 1, external: 0, arrayBuffers: 0 }),
  procStatus: () => "VmRSS:\t1 kB\nVmSwap:\t0 kB\nVmHWM:\t1 kB\nRssAnon:\t1 kB\nRssFile:\t0 kB\n",
  sourceMapsEnabled: () => true,
  uptimeSeconds: () => 5,
};

test("W1-T9647: a holder the daemon grows appears on the memory row with a non-zero estimate", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const timers = fakeTimers();
  const memo = createSizedMemo<string, { body: string }>();
  for (let i = 0; i < 1000; i++) memo.set(`k${i}`, { body: `row ${i} ${"x".repeat(40)}` });
  const stop = startDaemonMemoryCensus({
    holders: daemonHolderSource({ sizedMemos: { growing: memo.size } }),
    log: (step, extra) => rows.push({ step, ...extra }),
    io: quietIo, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  timers.scheduled[0]!.fn();
  await drain();
  const first = rows.find((row) => row.step === DAEMON_MEMORY_STEP);
  assert.ok(first, "a daemon.memory row is written");
  const holderOf = (row: Record<string, unknown>) => (row.holders as DaemonHolderReading[]).find((h) => h.name === "memo:growing")!;
  assert.equal(holderOf(first).entries, 1000);
  assert.equal(holderOf(first).basis, "accounted");
  assert.ok(holderOf(first).bytes > 0);
  for (let i = 1000; i < 2000; i++) memo.set(`k${i}`, { body: `row ${i} ${"x".repeat(40)}` });
  timers.scheduled[1]!.fn();
  await drain();
  const second = rows.filter((row) => row.step === DAEMON_MEMORY_STEP)[1]!;
  assert.equal(holderOf(second).entries, 2000);
  assert.ok(holderOf(second).bytes > holderOf(first).bytes, "the estimate grows with the holder");
  stop();

  // Ledger memos name themselves on the row through ledger-union.ts's book, with no registration by their owner.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9647-`));
  try {
    const rotation = join(dir, "ledger.2026-10-15T00-00-00Z.ndjson");
    writeFileSync(rotation, Array.from({ length: 50 }, (_, i) => JSON.stringify({ ts: `2026-10-15T00:00:${String(i % 60).padStart(2, "0")}Z`, step: "keep", n: i })).join("\n") + "\n");
    const named = createLedgerRotationMemo((r) => r, { holder: "w1-t9647.named", statKey: () => "fixed" });
    const unnamed = createLedgerRotationMemo((r) => r.filter((row) => row.step === "keep"), { statKey: () => "fixed" });
    const unnamedEmpty = createLedgerRotationMemo((r) => r, { statKey: () => "fixed" });
    await named.load([{ path: rotation, form: "plain" }]);
    await unnamed.load([{ path: rotation, form: "plain" }]);
    const book = ledgerMemoHolders();
    const namedReading = book.find((m) => m.kind === "rotation-memo" && m.name === "w1-t9647.named")!;
    assert.equal(namedReading.entries, 50);
    assert.ok(namedReading.approx_bytes > 0);
    const site = book.find((m) => m.kind === "rotation-memo" && m.name.startsWith("the-daemon-names-what-holds-its-heap.test.ts"))!;
    assert.equal(site.instances, 2, "two unnamed memos built in this file are one holder name with two instances");
    assert.equal(site.entries, 50);
    assert.ok(site.approx_bytes > 0 && site.approx_bytes === unnamed.approxBytes() + unnamedEmpty.approxBytes());
    const union = createIncrementalLedgerUnion({ holder: "w1-t9647.union", reducerVersion: "1" });
    union(dir, { step: "keep" });
    const unionReading = ledgerMemoHolders().find((m) => m.kind === "incremental-union" && m.name === "w1-t9647.union")!;
    assert.equal(unionReading.instances, 1);
    assert.ok(unionReading.entries >= 50 && unionReading.approx_bytes > 0);
    const holders = daemonHolderSource({ ledgerMemos: ledgerMemoHolders })();
    const onRow = holders.find((h) => h.name === "rotation-memo:w1-t9647.named")!;
    assert.deepEqual(onRow.size!(), { entries: 50, bytes: namedReading.approx_bytes, basis: "accounted" });
    assert.deepEqual(holders.find((h) => h.name.startsWith("rotation-memo:the-daemon-names"))!.size!()!.parts, { instances: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9647: rotation memo bytes are accounted when a rotation is kept, on every load path", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9647-`));
  try {
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ ts: `2026-10-15T00:00:${String(i).padStart(2, "0")}Z`, step: "keep", n: i }));
    const rotation = join(dir, "ledger.2026-10-15T00-00-00Z.ndjson");
    writeFileSync(rotation, lines.join("\n") + "\n");
    const entry = { path: rotation, form: "plain" as const };
    // Streamed load: a sliced measure after the rows are kept.
    const streamed = createLedgerRotationMemo((r) => r, { statKey: () => "fixed" });
    assert.equal(streamed.approxBytes(), 0);
    await streamed.load([entry]);
    const expected = Buffer.byteLength(JSON.stringify(lines.map((line) => JSON.parse(line))));
    assert.equal(streamed.approxBytes(), expected);
    // A rotation past one slice is measured a slice per turn: the slices' arrays sum to the rows' JSON.
    const bigLines = Array.from({ length: LEDGER_ROTATION_LOAD_LINES_PER_TURN + 5 }, (_, i) => JSON.stringify({ step: "keep", n: i }));
    const bigRotation = join(dir, "ledger.2026-10-15T01-00-00Z.ndjson");
    writeFileSync(bigRotation, bigLines.join("\n") + "\n");
    const sliced = createLedgerRotationMemo((r) => r, { statKey: () => "fixed" });
    await sliced.load([{ path: bigRotation, form: "plain" }]);
    const whole = Buffer.byteLength(JSON.stringify(bigLines.map((line) => JSON.parse(line))));
    assert.equal(sliced.approxBytes(), whole + 1, "two slices: one more bracket pair, one fewer comma");
    // Injected-buffer load measures the same rows the same way.
    const buffered = createLedgerRotationMemo((r) => r, { statKey: () => "fixed", readFile: async () => Buffer.from(lines.join("\n") + "\n") });
    await buffered.load([entry]);
    assert.equal(buffered.approxBytes(), expected);
    // Inline parse inside a pass.
    const inline = createLedgerRotationMemo((r) => r.slice(0, 2), { statKey: () => "fixed" });
    const pass = inline.pass({ parseMissing: true });
    pass.rotationRecords(entry, () => ({ rows: [{ a: 1 }, { b: "two" }, { c: 3 }], torn: 0, tornLines: [] }));
    assert.equal(pass.complete(), true);
    assert.equal(inline.approxBytes(), Buffer.byteLength(JSON.stringify([{ a: 1 }, { b: "two" }])));
    // A durable digest: the written digest's own length, then a cold memo answers from the digest's length.
    const digested = createLedgerRotationMemo((r) => r, { holder: "w1-t9647.digest", durableDigest: { reducerVersion: "1" } });
    await digested.load([entry]);
    const written = digested.approxBytes();
    assert.ok(written > expected, "the digest text carries the rows and its own header");
    const cold = createLedgerRotationMemo((r) => r, { holder: "w1-t9647.digest", durableDigest: { reducerVersion: "1" } });
    await cold.load([entry]);
    assert.equal(cold.retention().digestHits, 1);
    assert.equal(cold.approxBytes(), written);
    // A reducer that keeps a value JSON cannot serialize: the rotation is kept, unsized, and named.
    const bigint = createLedgerRotationMemo((r) => r.map((row) => ({ ...row, big: 1n })), { statKey: () => "fixed",
      readFile: async () => Buffer.from(lines.join("\n") + "\n"), holder: "w1-t9647.bigint" });
    await bigint.load([entry]);
    assert.equal(bigint.retention().failedArchives, 0);
    assert.equal(bigint.retention().rows, 30);
    assert.equal(bigint.approxBytes(), 0);
    const inlineBig = createLedgerRotationMemo((r) => r.map((row) => ({ ...row, big: 2n })), { statKey: () => "fixed" });
    const bigPass = inlineBig.pass({ parseMissing: true });
    bigPass.rotationRecords(entry, () => ({ rows: [{ a: 1 }], torn: 0, tornLines: [] }));
    assert.equal(inlineBig.approxBytes(), 0);
    const bigDigest = createLedgerRotationMemo((r) => r.map((row) => ({ ...row, big: 3n })), { holder: "w1-t9647.bigdigest",
      durableDigest: { reducerVersion: "1" }, statKey: () => "fixed", readFile: async () => Buffer.from(lines.join("\n") + "\n") });
    await bigDigest.load([entry]);
    assert.equal(bigDigest.retention().digestOutcomes?.unsized, 1);
    assert.equal(bigDigest.retention().rows, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9647: a memo's creation site names it, and a collected memo leaves the book", async () => {
  function namedBuilder(): string {
    return memoCreationSite(1);
  }
  const formatter = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  assert.match(namedBuilder(), /^the-daemon-names-what-holds-its-heap\.test\.ts#namedBuilder$/);
  assert.equal(memoCreationSite(500), "unknown");
  assert.equal(Error.prepareStackTrace, formatter, "the stack formatter is restored");
  assert.equal(Error.stackTraceLimit, limit);
  const gc = testCollector();
  (() => { createLedgerRotationMemo((r) => r, { holder: "w1-t9647.transient" }); })();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  assert.equal(ledgerMemoHolders().some((m) => m.name === "w1-t9647.transient"), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  gc();
  assert.equal(ledgerMemoHolders().some((m) => m.name === "w1-t9647.transient"), false);
});

test("W1-T9647: the memory row carries every heap space and the process swap, and unknown is never zero", async () => {
  const spaces = ["read_only_space", "new_space", "old_space", "code_space", "large_object_space", "code_large_object_space",
    "new_large_object_space", "trusted_space", "a_space_v8_adds_later"];
  const io = {
    ...quietIo,
    heapSpaces: () => spaces.map((space_name, i) => ({ space_name, space_size: 100 * (i + 1), space_used_size: 10 * (i + 1),
      space_available_size: 0, physical_space_size: 50 * (i + 1) })),
    heapCode: () => ({ bytecode_and_metadata_size: 7_000_000, code_and_metadata_size: 9_000_000, external_script_source_size: 21_000_000, cpu_profiler_metadata_size: 0 }),
    heapStatistics: () => ({ used_heap_size: 900 * MIB, total_heap_size: 1000 * MIB, total_physical_size: 990 * MIB, heap_size_limit: 8192 * MIB,
      external_memory: 3 * MIB, malloced_memory: 2 * MIB, number_of_native_contexts: 1, number_of_detached_contexts: 2, used_global_handles_size: 4096 }) as never,
    memoryUsage: () => ({ rss: 2000 * MIB, heapTotal: 1000 * MIB, heapUsed: 900 * MIB, external: 30 * MIB, arrayBuffers: 12 * MIB }),
    procStatus: () => "Name:\tnode\nVmHWM:\t3800000 kB\nVmRSS:\t1900000 kB\nRssAnon:\t1800000 kB\nRssFile:\t100000 kB\nVmSwap:\t1700000 kB\n",
    sourceMapsEnabled: () => true,
  };
  const row = await sampleDaemonMemoryCensus([], { bootHeadSha: "0123456789abcdef" }, io);
  assert.deepEqual(Object.keys(row.heap_spaces as object), spaces);
  assert.deepEqual((row.heap_spaces as Record<string, unknown>).old_space, { used: 30, size: 300, physical: 150 });
  assert.deepEqual(row.code, { bytecode_and_metadata_bytes: 7_000_000, code_and_metadata_bytes: 9_000_000, external_script_source_bytes: 21_000_000 });
  assert.equal((row.heap as Record<string, unknown>).detached_contexts, 2);
  assert.equal((row.heap as Record<string, unknown>).used_bytes, 900 * MIB);
  assert.equal(row.vm_swap_bytes, 1_700_000 * 1024);
  assert.equal(row.vm_hwm_bytes, 3_800_000 * 1024);
  assert.equal(row.rss_anon_bytes, 1_800_000 * 1024);
  assert.equal(row.rss_file_bytes, 100_000 * 1024);
  assert.equal(row.vm_rss_bytes, 1_900_000 * 1024);
  assert.equal(row.array_buffers_bytes, 12 * MIB);
  assert.equal(row.external_bytes, 30 * MIB);
  assert.equal(row.source_maps_enabled, true);
  assert.equal(row.boot_head_sha, "0123456789ab");
  assert.equal(row.mem_proc, undefined);
  // A missing line is named and absent, never zero.
  const noSwap = await sampleDaemonMemoryCensus([], {}, { ...io, procStatus: () => "VmRSS:\t1 kB\nVmHWM:\t2 kB\nRssAnon:\t1 kB\nRssFile:\t0 kB\n" });
  assert.equal(noSwap.mem_proc, "missing:VmSwap");
  assert.equal("vm_swap_bytes" in noSwap, false);
  assert.equal(noSwap.rss_file_bytes, 0, "a reported zero stays a zero");
  // An unreadable file is named, and no proc field is written at all.
  const unreadable = await sampleDaemonMemoryCensus([], {}, { ...io, procStatus: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  assert.equal(unreadable.mem_proc, "unreadable:ENOENT");
  for (const field of ["vm_rss_bytes", "vm_swap_bytes", "vm_hwm_bytes", "rss_anon_bytes", "rss_file_bytes"]) assert.equal(field in unreadable, false, field);
  assert.deepEqual(readProcMemory(() => { throw new TypeError("no code"); }), { mem_proc: "unreadable:TypeError" });
});

test("W1-T9647: the memory row is written on its cadence and a slow holder never blocks the loop", async () => {
  // A clock that charges 1 ms for every reading: the walk reads it once per node, so one node costs 1 ms.
  let t = 0;
  let resumedAt = 0;
  const slices: number[] = [];
  const io = {
    ...quietIo,
    monotonicMs: () => ++t,
    yieldTurn: async () => {
      slices.push(t - resumedAt);
      await new Promise((resolve) => setImmediate(resolve));
      resumedAt = t;
    },
  };
  const wide = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i })) };
  const rows: Array<Record<string, unknown>> = [];
  const timers = fakeTimers();
  const holders: DaemonMemoryHolder[] = [
    { name: "slow", kind: "test", walk: () => ({ entries: 1000, roots: [wide] }) },
    { name: "throws", kind: "test", size: () => { throw new Error("cannot size"); } },
    { name: "empty", kind: "test" },
    { name: "walk-throws", kind: "test", walk: () => { throw new Error("cannot walk"); } },
    accountedHolder("fine", "test", () => ({ entries: 3, approx_bytes: 300 })),
  ];
  let failNext = false;
  const stop = startDaemonMemoryCensus({
    holders: () => { if (failNext) throw new Error("holder book unreadable"); return holders; },
    log: (step, extra) => rows.push({ step, ...extra }), io, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]!.ms, DAEMON_MEMORY_SAMPLE_MS);
  assert.equal(timers.scheduled[0]!.unrefed, true, "the census timer never holds the daemon open");
  assert.equal(rows.length, 0, "nothing is sampled before the first tick");
  timers.scheduled[0]!.fn();
  assert.equal(timers.scheduled.length, 1, "the next tick is scheduled only after this sample is written");
  await drain(3000);
  assert.equal(timers.scheduled.length, 2);
  const row = rows.find((r) => r.step === DAEMON_MEMORY_STEP)!;
  const readings = row.holders as DaemonHolderReading[];
  const slow = readings.find((h) => h.name === "slow")!;
  assert.equal(slow.basis, "walked");
  assert.equal(slow.entries, 1000);
  assert.ok(slow.bytes > 1000 * 16, "every node was walked");
  assert.equal(slow.truncated, undefined);
  const longest = Math.max(...slices);
  assert.ok(longest <= DAEMON_MEMORY_TURN_BUDGET_MS + 2, `one synchronous slice ran ${longest} ms`);
  assert.ok(slices.length >= 1000 / (DAEMON_MEMORY_TURN_BUDGET_MS + 2), "the walk was spread over many turns");
  assert.ok(Number(row.max_slice_us) <= (DAEMON_MEMORY_TURN_BUDGET_MS + 2) * 1000);
  assert.ok(Number(row.turns) > 1 && Number(row.sample_us) > 0 && Number(row.late_ms) >= 0);
  assert.ok(slow.sample_us > 0);
  assert.deepEqual(readings.find((h) => h.name === "throws"), { name: "throws", kind: "test", entries: 0, bytes: 0, basis: "accounted", error: "cannot size", sample_us: readings.find((h) => h.name === "throws")!.sample_us });
  assert.equal(readings.find((h) => h.name === "empty")!.error, "no size and no walk");
  assert.equal(readings.find((h) => h.name === "walk-throws")!.basis, "walked");
  assert.equal(readings.find((h) => h.name === "walk-throws")!.error, "cannot walk");
  assert.equal(readings.find((h) => h.name === "fine")!.bytes, 300);
  // A failed sample is named and the next tick still runs.
  failNext = true;
  timers.scheduled[1]!.fn();
  await drain();
  assert.equal(rows.at(-1)!.step, DAEMON_MEMORY_SAMPLE_FAILED_STEP);
  assert.equal(rows.at(-1)!.reason, "holder book unreadable");
  assert.equal(timers.scheduled.length, 3, "a failed sample still schedules the next");
  failNext = false;
  timers.scheduled[2]!.fn();
  await drain(3000);
  assert.equal(rows.at(-1)!.step, DAEMON_MEMORY_STEP);
  stop();
  assert.equal(timers.scheduled.at(-1)!.cleared, true);
  // A sample still running when the daemon stops is not written, and schedules nothing.
  const late: Array<Record<string, unknown>> = [];
  const lateTimers = fakeTimers();
  const stopLate = startDaemonMemoryCensus({ holders: () => holders, log: (step, extra) => late.push({ step, ...extra }), io, setTimer: lateTimers.setTimer, clearTimer: lateTimers.clearTimer });
  lateTimers.scheduled[0]!.fn();
  stopLate();
  await drain(3000);
  assert.equal(late.length, 0);
  assert.equal(lateTimers.scheduled.length, 1);
  // The walk stops at its node cap and says the figure is a lower bound.
  const capped = await sampleDaemonMemoryCensus([{ name: "capped", kind: "test", walk: () => ({ entries: 1, roots: [wide] }) }], {}, { ...quietIo, walkNodeMax: 10 });
  assert.equal((capped.holders as DaemonHolderReading[])[0]!.truncated, true);
});

test("W1-T9647: the walk counts every container shape once and never invokes an accessor", async () => {
  const shared = { s: "abcd" };
  let invoked = false;
  const accessor = Object.defineProperty({}, "lazy", { get() { invoked = true; return "x"; }, enumerable: true });
  const value = { map: new Map([["k", shared]]), set: new Set([shared, 5]), bytes: new Uint8Array(64), list: [shared, shared, null], accessor };
  const row = await sampleDaemonMemoryCensus([{ name: "shapes", kind: "test", walk: () => ({ entries: 1, roots: [value] }) }], {}, quietIo);
  const reading = (row.holders as DaemonHolderReading[])[0]!;
  assert.equal(invoked, false);
  assert.ok(reading.bytes >= 64 + 4, "the typed array and the shared string are counted");
  const twice = await sampleDaemonMemoryCensus([{ name: "shapes", kind: "test", walk: () => ({ entries: 1, roots: [value, value] }) }], {}, quietIo);
  assert.equal((twice.holders as DaemonHolderReading[])[0]!.bytes, reading.bytes + 0, "a shared reference counts once");
});

test("W1-T9647: unattributed live bytes are the last measured live set less the holders", async () => {
  const clock = fixedClock(Date.parse("2026-10-15T12:00:00Z"));
  const holders = [accountedHolder("a", "test", () => ({ entries: 1, approx_bytes: 1_000_000 })), accountedHolder("b", "test", () => ({ entries: 2, approx_bytes: 2_000_000 }))];
  const row = await sampleDaemonMemoryCensus(holders, { liveSet: () => ({ bytes: 10_000_000, atMs: clock.now() - 5000 }) }, { ...quietIo, clock });
  assert.equal(row.attributed_bytes, 3_000_000);
  assert.equal(row.live_after_gc_bytes, 10_000_000);
  assert.equal(row.live_after_gc_age_ms, 5000);
  assert.equal(row.unattributed_live_bytes, 7_000_000);
  assert.equal(row.unattributed_reason, undefined);
  const none = await sampleDaemonMemoryCensus(holders, { liveSet: () => undefined }, quietIo);
  assert.equal("unattributed_live_bytes" in none, false);
  assert.match(String(none.unattributed_reason), /no slack_reclaim live set/);
  // The live set is the reclaimer's own reading: a reclaimed record sets it; paced or unavailable ones keep the last.
  const keeper = createLiveSetKeeper(clock);
  assert.equal(keeper.read(), undefined);
  const reclaimed = { outcome: "reclaimed", heap_used_after_bytes: 867 * MIB, pool: "container" };
  assert.equal(keeper.keep(reclaimed), reclaimed, "the record passes through unchanged");
  keeper.keep({ outcome: "paced" });
  assert.deepEqual(keeper.read(), { bytes: 867 * MIB, atMs: clock.now() });
  assert.equal(liveSetFromReclaim({ outcome: "reclaimed" }), undefined);
  assert.ok(liveSetFromReclaim({ outcome: "reclaimed", heap_used_after_bytes: 1 })!.atMs > 0);
});

test("W1-T9647: plan copies are counted by distinct plan, sized by distinct task", async () => {
  const table: Record<string, CensusCalibration> = { "plan.task": { per_entry_bytes: 10_000, entries: 3789, census_sha: "abcdef1234567890", census_date: "2026-10-15" } };
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}` }));
  const boot = { tasks };
  const reload = { tasks: [...tasks.slice(0, 9), { id: "T9" }] }; // a reload sharing nine task objects
  const clone = structuredClone(boot);
  const book = createPlanCopyBook({ refs: () => [boot, boot, undefined, "not a plan"], table });
  book.observe(reload);
  book.observe(reload);
  book.observe(clone);
  book.observe(undefined);
  const holder = book.holder();
  const sized = holder.size!()!;
  assert.equal(sized.entries, 3);
  assert.deepEqual(sized.parts, { pinned: 1, tracked: 2, distinct_tasks: 21 });
  assert.equal(sized.bytes, 21 * 10_000);
  assert.equal(sized.basis, "census");
  assert.equal(sized.calibration, "plan.task@abcdef123456/2026-10-15");
  // Uncalibrated, the holder is walked, shared tasks once.
  const walked = createPlanCopyBook({ refs: () => [boot], table: {} });
  walked.observe(clone);
  assert.equal(walked.holder().size!(), undefined);
  assert.equal(walked.holder().walk!().roots.length, 2);
  const row = await sampleDaemonMemoryCensus([walked.holder()], {}, quietIo);
  assert.equal((row.holders as DaemonHolderReading[])[0]!.basis, "walked");
  // A plan nothing holds any more leaves the book once collected.
  const gc = testCollector();
  const transient = createPlanCopyBook({ refs: () => [], table });
  (() => transient.observe({ tasks: [{ id: "gone" }] }))();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  assert.equal(transient.holder().size!()!.entries, 0);
  // Each lane's synced plan is shown to the book as it resolves.
  const seen: unknown[] = [];
  const sync = observedPlanSync(async (dir: string) => ({ plan: { dir } }), (plan) => seen.push(plan));
  assert.deepEqual(await sync("x"), { plan: { dir: "x" } });
  assert.deepEqual(seen, [{ dir: "x" }]);
});

test("W1-T9647: the daemon's holder source names board rows, the tick read, sized memos and a broken source", async () => {
  const closed = new Map([[1, { number: 1, body: "b".repeat(100) }], [2, { number: 2, body: "c".repeat(100) }]]);
  const caches = [{ rows: () => ({ closed }) }, { rows: () => ({}) }, {}];
  const table: Record<string, CensusCalibration> = { "board.closed-pr": { per_entry_bytes: 4000, entries: 10, census_sha: "f".repeat(40), census_date: "2026-10-15" } };
  const holders = daemonHolderSource({
    boardSnapshots: () => caches,
    tickRead: () => ({ plan: { tasks: [] }, openPrRows: [{ number: 3, body: "d".repeat(50) }] }),
    table,
  })();
  const closedHolder = holders.find((h) => h.name === "board-snapshot.closed")!;
  assert.deepEqual(closedHolder.size!(), { entries: 2, bytes: 8000, basis: "census", calibration: "board.closed-pr@ffffffffffff/2026-10-15" });
  const issues = holders.find((h) => h.name === "board-snapshot.issues")!;
  assert.equal(issues.size!(), undefined);
  assert.deepEqual(issues.walk!(), { entries: 0, roots: [] });
  const tick = holders.find((h) => h.name === "tick-read")!;
  assert.equal(tick.walk!().roots.length, 1, "the tick read's plan is a plan copy, not a tick-read byte");
  const empty = daemonHolderSource({ tickRead: () => undefined })();
  assert.deepEqual(empty[0]!.walk!(), { entries: 0, roots: [] });
  const registry = createDaemonMemoryRegistry();
  registry.add(accountedHolder("x", "test", () => ({ entries: 1, approx_bytes: 1 })));
  registry.add(accountedHolder("x", "test", () => ({ entries: 2, approx_bytes: 2 })));
  registry.addSource("broken", () => { throw new Error("book unreadable"); });
  const listed = registry.holders();
  assert.equal(listed.length, 2, "re-adding a name replaces it");
  const row = await sampleDaemonMemoryCensus(listed, {}, quietIo);
  assert.equal((row.holders as DaemonHolderReading[]).find((h) => h.name === "broken")!.error, "book unreadable");
  assert.equal(censusEstimate("absent", 5, {}), undefined);
});

test("W1-T9647: the row stays under its byte cap and sums what it folds", () => {
  const readings: DaemonHolderReading[] = Array.from({ length: 200 }, (_, i) => ({ name: `holder-${i}`, kind: "test", basis: "accounted", entries: i, bytes: i * 1000, sample_us: 1 }));
  const row = capHolders({ step: "daemon.memory" }, readings, 6 * 1024);
  assert.ok(JSON.stringify(row).length <= 6 * 1024);
  const kept = row.holders as DaemonHolderReading[];
  assert.equal(kept[0]!.name, "holder-199", "the largest holders are kept");
  const omitted = row.holders_omitted as { count: number; bytes: number };
  assert.equal(kept.length + omitted.count, 200);
  assert.equal(kept.reduce((s, r) => s + r.bytes, 0) + omitted.bytes, readings.reduce((s, r) => s + r.bytes, 0));
  assert.equal("holders_omitted" in capHolders({}, readings.slice(0, 2), 6 * 1024), false);
});

test("W1-T9647: the offline census ranks holders by retained bytes and proposes tasks for the top ones", async () => {
  // A fake heap: a base plus every holder still alive. Building a holder adds it; dropping it removes it.
  const live = new Map<string, number>();
  const heapUsed = () => 100 * MIB + [...live.values()].reduce((s, b) => s + b, 0);
  let collections = 0;
  const io = { collect: () => { collections += 1; }, heapUsed, log: () => {} };
  const spec = (name: string, bytes: number, entries: number): CensusHolderSpec => ({
    name, holder: `holder.${name}`, calibrationKey: `key.${name}`, files: [`src/lib/${name}.ts`],
    build: () => { live.set(name, bytes); return { value: { name }, entries }; },
    drop: () => { live.delete(name); },
  });
  const baseline = await measureHeapHolders([spec("unchanged", 10 * MIB, 100), spec("grown", 10 * MIB, 100)], io);
  assert.deepEqual(baseline.map((m) => m.retained_bytes), [10 * MIB, 10 * MIB]);
  const measured = await measureHeapHolders([
    spec("unchanged", 10 * MIB, 100),
    spec("grown", 100 * MIB, 1000),
    { name: "broken", holder: "holder.broken", files: [], build: () => { throw new Error("no corpus"); } },
  ], io);
  assert.ok(collections >= 12, "every reading is settled by collections");
  const liveSet = 867 * MIB;
  const ranking = rankHeapCensus(measured, { liveSetBytes: liveSet, censusSha: "0123456789abcdef0123", censusDate: "2026-10-15", corpus: "synthetic" });
  assert.deepEqual(ranking.holders.map((h) => h.holder), ["holder.grown", "holder.unchanged", "holder.broken"]);
  const [grown, unchanged, broken] = ranking.holders;
  assert.equal(grown!.retained_bytes, 100 * MIB);
  assert.equal(grown!.per_entry_bytes, Math.round(100 * MIB / 1000));
  assert.ok(Math.abs(grown!.share - 100 / 867) < 1e-9);
  assert.equal(ranking.threshold_bytes, Math.round(censusFilingThreshold(liveSet)));
  assert.equal(ranking.threshold_bytes, Math.round(0.05 * liveSet), "5% of 867 MiB is under 50 MiB");
  assert.ok(grown!.proposed_task, "the holder over the filing share is proposed");
  assert.equal(grown!.proposed_task!.holder, "holder.grown");
  assert.deepEqual(grown!.proposed_task!.files, ["src/lib/grown.ts"]);
  assert.match(grown!.proposed_task!.evidence[0]!, /OBSERVED offline census 0123456789ab 2026-10-15 \(synthetic\)/);
  assert.equal(unchanged!.proposed_task, undefined, "a holder under the filing share is ranked, never proposed");
  assert.equal(broken!.error, "no corpus");
  assert.equal(broken!.proposed_task, undefined);
  assert.equal(broken!.per_entry_bytes, 0);
  assert.equal(censusFilingThreshold(10_000 * MIB), 50 * MIB, "a large live set is capped at the byte floor");
  const table = renderHeapCensus(ranking);
  assert.match(table, /\| 1 \| holder\.grown \| grown \| 1000 \| 100\.0 \| 11\.5% \| 104858 \| \*\*file\*\* \|/);
  assert.match(table, /error: no corpus/);
  assert.deepEqual(Object.keys(calibrationFrom(ranking)), ["key.grown", "key.unchanged"]);
  assert.equal(calibrationFrom(ranking)["key.grown"]!.census_sha, "0123456789ab");
  assert.equal(rankHeapCensus([], { liveSetBytes: 0, censusSha: "x", censusDate: "d" }).holders.length, 0);
  assert.equal(rankHeapCensus(measured, { liveSetBytes: 0, censusSha: "x", censusDate: "d" }).holders[0]!.share, 0);
});

test("W1-T9647: the default seams read the real heap spaces and proc status", async () => {
  const row = await sampleDaemonMemoryCensus([{ name: "real", kind: "test", walk: () => ({ entries: 1, roots: [{ a: [1, 2, 3] }] }) }]);
  const spaces = row.heap_spaces as Record<string, { used: number; size: number; physical: number }>;
  assert.ok(spaces.old_space!.used > 0, "old space holds this process's heap");
  assert.ok((row.heap as { used_bytes: number }).used_bytes > 0);
  assert.ok((row.code as { bytecode_and_metadata_bytes: number }).bytecode_and_metadata_bytes > 0);
  assert.equal(typeof row.source_maps_enabled, "boolean");
  assert.ok(Number(row.rss_bytes) > 0);
  if (process.platform === "linux") {
    assert.equal(row.mem_proc, undefined, "this kernel reports every status line");
    assert.ok(Number(row.vm_rss_bytes) > 0 && Number(row.vm_hwm_bytes) >= Number(row.vm_rss_bytes) - 1024 * 1024);
    assert.equal(typeof row.vm_swap_bytes, "number");
  }
  assert.ok((row.holders as DaemonHolderReading[])[0]!.bytes > 0);
  // The real timer: started and stopped without a tick, and unref'd so it never holds a process open.
  const stop = startDaemonMemoryCensus({ holders: () => [], log: () => {} });
  stop();
  const stopAfterTick = startDaemonMemoryCensus({ holders: () => [], log: () => {}, intervalMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stopAfterTick();
});

test("W1-T9647: the source-map cache is the census's upper bound while maps are on, and nothing once they are off", async () => {
  const table: Record<string, CensusCalibration> = { "source-maps.module": { per_entry_bytes: 240_000, entries: 587, census_sha: "a".repeat(40), census_date: "2026-10-15" } };
  let enabled = true;
  // W1-T9822: with no source-map count the holder is the ceiling; a count is sized in its own test file.
  const notCounted = () => ({ basis: "not-installed" as const });
  const holder = sourceMapCacheHolder(() => enabled, table, notCounted);
  assert.deepEqual(holder.size!(), { entries: 587, bytes: 587 * 240_000, basis: "census", calibration: "source-maps.module@aaaaaaaaaaaa/2026-10-15", parts: { upper_bound: 1 } });
  enabled = false;
  assert.deepEqual(holder.size!(), { entries: 0, bytes: 0, basis: "census", parts: { source_maps_enabled: 0 } });
  assert.deepEqual(sourceMapCacheHolder(() => true, {}).size!(), { entries: 0, bytes: 0, basis: "census", parts: { uncalibrated: 1 } });
  assert.equal(typeof sourceMapCacheHolder().size!()!.bytes, "number");
  const listed = daemonHolderSource({ sourceMapsEnabled: () => true, table, sourceMapCount: { install: () => {}, read: notCounted } })();
  assert.equal(listed.find((h) => h.name === "source-map-cache")!.size!()!.bytes, 587 * 240_000);
  // A holder that cannot be dropped in-process is measured in a process of its own; one with neither is an error.
  const measured = await measureHeapHolders([
    { name: "maps", holder: "source-map-cache", files: ["src/lib/read-plane.ts"], measure: async () => ({ entries: 587, retained_bytes: 134 * MIB, grown_bytes: 134 * MIB }) },
    { name: "nothing", holder: "none", files: [] },
  ], { collect: () => {}, heapUsed: () => 0 });
  assert.deepEqual(measured[0], { name: "maps", holder: "source-map-cache", files: ["src/lib/read-plane.ts"], entries: 587, retained_bytes: 134 * MIB, grown_bytes: 134 * MIB });
  assert.equal(measured[1]!.error, "a census holder needs build or measure");
});
