// @source-text-subject: one case below asserts the sampler module's own text names no heap
// snapshot, debugger or collection entry point — the module's source IS that claim's subject.
/**
 * W1-T6782 — THE DAEMON HEARTBEAT SAYS WHAT ITS MEMORY IS.
 *
 * The daemon held 4-5 GB with no row saying whether that was a fixed baseline, retained state,
 * uncollected garbage or a worker peak. `sampleDaemonMemory` (src/lib/daemon-memory-telemetry.ts)
 * now rides the EXISTING `daemon.alive` row through the `readMemoryTelemetry` dep.
 *
 * Each case below is driven through the real `runDaemon` heartbeat, from fixture /proc and cgroup
 * files, so removing the spread from `startInFlightTicker` fails the field assertions; zeroing an
 * unreadable file fails the unknown-is-never-zero case; letting a throw escape fails the
 * heartbeat-still-written case.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { daemonMemoryTelemetryReader, type RunResult } from "../src/run-task.js";
import { runDaemon, v8HeapStatistics, type DaemonDeps } from "../src/lib/daemon.js";
import { activeWorkerCount } from "../src/lib/worker.js";
import { drainInFlightReviews, inFlightReviewCount, trackInFlightReview } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { sampleCgroupMemory, sampleDaemonMemory, type DaemonMemorySources, type WorkerHeapFields } from "../src/lib/daemon-memory-telemetry.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-mem-plan-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

interface Line { step: string; extra: Record<string, unknown> }

/** One dispatch held open across a few ticker sleeps, so `daemon.alive` is written mid-dispatch. */
async function heartbeatRows(extra: Partial<DaemonDeps>): Promise<Record<string, unknown>[]> {
  const merged = new Set<string>();
  const lines: Line[] = [];
  let sleeps = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { await gate; merged.add(id); return okResult(id); },
      sweepLight: async () => {},
      sleep: async () => { sleeps++; if (sleeps >= 3) release?.(); },
      log: (step, e = {}) => lines.push({ step, extra: e }),
      ...extra,
    },
    { max: 1 },
  );
  return lines.filter((l) => l.step === "daemon.alive").map((l) => l.extra);
}

/** Pessimistic production-magnitude fixture: a 4.9 GB daemon in a 9.25 GB container, thirty days of
 *  memory.events counters (the measured rate was ~3,000 `max` events an hour), so the byte bound holds. */
function fixtureFiles(): { cgroupRoot: string; procStatusPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-mem-fixture-`));
  const cgroupRoot = join(dir, "cgroup");
  mkdirSync(cgroupRoot);
  writeFileSync(join(cgroupRoot, "memory.current"), "9223372032\n");
  writeFileSync(join(cgroupRoot, "memory.swap.current"), "2952790016\n");
  writeFileSync(join(cgroupRoot, "memory.max"), "9932111872\n");
  writeFileSync(join(cgroupRoot, "memory.stat"), "anon 8589934592\nfile 536870912\nkernel 104857600\nshmem 0\n");
  writeFileSync(join(cgroupRoot, "memory.events"), "low 0\nhigh 1234567\nmax 7777777\noom 123456\noom_kill 12345\noom_group_kill 0\n");
  const procStatusPath = join(dir, "status");
  writeFileSync(procStatusPath, "Name:\tnode\nVmRSS:\t 4194304 kB\nVmSwap:\t 2883584 kB\nThreads:\t11\n");
  return { cgroupRoot, procStatusPath };
}

const SHA = "5d8fc7bd99b192bebfcab2e28d7975e3b6992851";

function sources(over: Partial<DaemonMemorySources> = {}): DaemonMemorySources {
  return {
    heapStatistics: () => ({ heap_size_limit: 8_640_266_240 }),
    workload: () => ({ active_workers: 12, in_flight_reviews: 7 }),
    bootHeadSha: SHA,
    memoryUsage: () => ({ rss: 4_912_345_678, heapUsed: 3_987_654_321, heapTotal: 4_123_456_789, external: 123_456_789, arrayBuffers: 98_765_432 }),
    uptimeSeconds: () => 2_592_000.4, // thirty days up
    ...fixtureFiles(),
    ...over,
  };
}

const PROCESS_FIELDS = ["rss_bytes", "heap_used_bytes", "heap_total_bytes", "external_bytes", "array_buffers_bytes", "heap_size_limit_bytes", "vm_swap_bytes"];
const CGROUP_FIELDS = ["cg_memory_current_bytes", "cg_swap_current_bytes", "cg_memory_max_bytes", "cg_anon_bytes", "cg_file_bytes",
  "cg_events_high", "cg_events_max", "cg_events_oom", "cg_events_oom_kill"];
const MEMORY_FIELDS = [...PROCESS_FIELDS, ...CGROUP_FIELDS, "active_workers", "in_flight_reviews", "uptime_s", "boot_head_sha", "telemetry_sample_us"];

test("daemon.alive carries the process, cgroup, workload and identity fields from fixture cgroup and proc files", async () => {
  const [alive] = await heartbeatRows({ readMemoryTelemetry: () => ({ ...sampleDaemonMemory(sources()) }) });
  assert.ok(alive, "a daemon.alive row was written");
  assert.equal(alive.phase, "dispatch", "the existing heartbeat fields still ride the row");
  assert.deepEqual(
    Object.fromEntries(MEMORY_FIELDS.filter((k) => k !== "telemetry_sample_us").map((k) => [k, alive[k]])),
    {
      rss_bytes: 4_912_345_678, heap_used_bytes: 3_987_654_321, heap_total_bytes: 4_123_456_789, external_bytes: 123_456_789,
      array_buffers_bytes: 98_765_432, heap_size_limit_bytes: 8_640_266_240, vm_swap_bytes: 2_883_584 * 1024,
      cg_memory_current_bytes: 9_223_372_032, cg_swap_current_bytes: 2_952_790_016, cg_memory_max_bytes: 9_932_111_872,
      cg_anon_bytes: 8_589_934_592, cg_file_bytes: 536_870_912,
      cg_events_high: 1_234_567, cg_events_max: 7_777_777, cg_events_oom: 123_456, cg_events_oom_kill: 12_345,
      active_workers: 12, in_flight_reviews: 7, uptime_s: 2_592_000, boot_head_sha: SHA.slice(0, 12),
    },
  );
  assert.ok(Number.isInteger(alive.telemetry_sample_us) && (alive.telemetry_sample_us as number) >= 0, "the sampler's own wall time is recorded");
  assert.equal(alive.mem_cgroup, undefined, "a fully readable cgroup names no unreadable file");
  assert.equal(alive.mem_proc, undefined);
  assert.equal(alive.mem_telemetry, undefined);
});

test("the production memory reader samples real process memory and live review workload on each heartbeat", async () => {
  const readMemoryTelemetry = daemonMemoryTelemetryReader(SHA);
  const before = readMemoryTelemetry();
  let release!: () => void;
  const review = trackInFlightReview(new Promise<void>((resolve) => { release = resolve; }));
  try {
    const [alive] = await heartbeatRows({ readMemoryTelemetry });
    assert.ok(alive, "the production reader reaches daemon.alive");
    for (const field of PROCESS_FIELDS.filter((key) => key !== "vm_swap_bytes")) {
      assert.ok(Number.isSafeInteger(alive[field]) && (alive[field] as number) > 0, `${field} measures this process`);
    }
    assert.equal(alive.heap_size_limit_bytes, v8HeapStatistics().heap_size_limit);
    assert.equal(alive.active_workers, activeWorkerCount());
    assert.equal(alive.in_flight_reviews, (before.in_flight_reviews as number) + 1);
    assert.equal(alive.in_flight_reviews, inFlightReviewCount());
    assert.equal(alive.boot_head_sha, SHA.slice(0, 12));
    assert.ok(Math.abs((alive.uptime_s as number) - process.uptime()) <= 1);
    assert.ok(Number.isSafeInteger(alive.telemetry_sample_us) && (alive.telemetry_sample_us as number) >= 0);
    assert.equal(alive.mem_telemetry, undefined);
  } finally {
    release();
    await review;
    await drainInFlightReviews({ boundMs: 1_000 });
  }
  assert.equal(readMemoryTelemetry().in_flight_reviews, before.in_flight_reviews, "the same reader observes review settlement");
});

// W1-T7092: the PRODUCTION reader (run-task.ts), with the real worker-heaps registry and a real Worker.
// It lives here because this module already imports run-task.ts; the reach ratchet counts each importer.
test("the production reader names a real worker thread by creation site, role, thread id and generation", { timeout: 20_000 }, async () => {
  const readMemoryTelemetry = daemonMemoryTelemetryReader(SHA, { generation: "DAEMON-1791542911631" }); // subscribes the registry first
  const thread = new Worker("setInterval(() => {}, 1000);", { eval: true });
  try {
    await new Promise<void>((resolve) => thread.once("online", () => resolve()));
    let row: Record<string, unknown> & WorkerHeapFields = readMemoryTelemetry();
    assert.equal(row.mem_worker_heaps, "pending:first-read", "no request round has run before the first row");
    readMemoryTelemetry.afterRow();
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      row = readMemoryTelemetry();
      if (row.worker_heaps?.threads.some((t) => t.thread_id === thread.threadId && t.state === "fresh")) break;
    }
    const mine = row.worker_heaps?.threads.find((t) => t.thread_id === thread.threadId);
    assert.ok(mine, `the real thread is reported (threads: ${JSON.stringify(row.worker_heaps?.threads)})`);
    assert.match(mine.site, /^the-daemon-heartbeat-says-what-its-memory-is\.test:/, "named by the frame that spawned it");
    assert.equal(mine.role, "unmapped", "a site outside the daemon's fixed map is unmapped, never guessed");
    assert.equal(mine.state, "fresh");
    for (const field of ["used_heap_bytes", "total_heap_bytes", "physical_heap_bytes", "heap_limit_bytes"] as const) {
      assert.ok(Number.isSafeInteger(mine[field]) && (mine[field] as number) > 0, `${field} measures the worker's own isolate`);
    }
    assert.equal(row.worker_heaps?.generation, "DAEMON-1791542911631");
    assert.ok((row.worker_heaps?.main?.total_heap_bytes ?? 0) > 0, "the main isolate is reported the same way");
    assert.ok(Number.isSafeInteger(row.rss_bytes) && Number.isSafeInteger(row.vm_swap_bytes ?? 0), "rss and swap stay separate fields");
    assert.doesNotMatch(JSON.stringify(row), /native/i, "no field is labelled native memory");
  } finally {
    await thread.terminate();
  }
});

test("memory.max reading `max` is null, never a number standing in for unlimited", () => {
  const { cgroupRoot } = fixtureFiles();
  writeFileSync(join(cgroupRoot, "memory.max"), "max\n");
  const got = sampleCgroupMemory((p) => readFileSync(p, "utf8"), cgroupRoot);
  assert.equal(got.cg_memory_max_bytes, null);
  assert.equal(got.mem_cgroup, undefined);
});

test("unreadable cgroup files yield mem_cgroup unreadable and no zero-valued cgroup fields", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-mem-nocg-`)), "no-cgroup-v2-here");
  const [alive] = await heartbeatRows({ readMemoryTelemetry: () => ({ ...sampleDaemonMemory(sources({ cgroupRoot: missing })) }) });
  assert.ok(alive, "the heartbeat is still written");
  assert.match(String(alive.mem_cgroup), /^unreadable:memory\.current:ENOENT/);
  assert.deepEqual(Object.keys(alive).filter((k) => k.startsWith("cg_")), [], "no cgroup field is present, zero or otherwise");
  assert.equal(alive.rss_bytes, 4_912_345_678, "the process half is unaffected");

  // A garbled file is unknown too, and a partially readable cgroup keeps what it could read.
  const { cgroupRoot } = fixtureFiles();
  writeFileSync(join(cgroupRoot, "memory.swap.current"), "garbage\n");
  const partial = sampleCgroupMemory((p) => readFileSync(p, "utf8"), cgroupRoot);
  assert.equal("cg_swap_current_bytes" in partial, false);
  assert.equal(partial.cg_memory_current_bytes, 9_223_372_032);
  assert.match(String(partial.mem_cgroup), /memory\.swap\.current:unparseable/);

  // No /proc either (a macOS host): VmSwap is absent and named, not zero.
  const noProc = sampleDaemonMemory(sources({ procStatusPath: join(missing, "status") }));
  assert.equal("vm_swap_bytes" in noProc, false);
  assert.match(String(noProc.mem_proc), /^unreadable:ENOENT/);
});

test("a throwing sampler still writes the heartbeat with mem_telemetry error", async () => {
  const rows = await heartbeatRows({ readMemoryTelemetry: () => { throw new Error("procfs vanished"); } });
  assert.ok(rows.length >= 1, "daemon.alive is still written when the memory sampler throws");
  assert.equal(rows[0].mem_telemetry, "error:procfs vanished");
  assert.equal(rows[0].phase, "dispatch");
  assert.equal(rows[0].poll_interval_ms !== undefined, true);
});

test("the added fields stay under 600 serialized bytes", async () => {
  const [alive] = await heartbeatRows({ readMemoryTelemetry: () => ({ ...sampleDaemonMemory(sources({ nowNs: (() => {
    let t = 0n;
    return () => (t += 999_999_000n); // a pessimistic 999,999 us sample: six digits on the row
  })() })) }) });
  const without = Object.fromEntries(Object.entries(alive).filter(([k]) => !MEMORY_FIELDS.includes(k)));
  assert.equal(Object.keys(alive).length - Object.keys(without).length, MEMORY_FIELDS.length, "every memory field was measured");
  const added = Buffer.byteLength(JSON.stringify(alive)) - Buffer.byteLength(JSON.stringify(without));
  assert.ok(added < 600, `the memory fields add ${added} serialized bytes to daemon.alive (bound: 600)`);
});

test("the sampler module references no heap snapshot, inspector or gc entry point", () => {
  const text = readFileSync(join(REPO_ROOT, "src", "lib", "daemon-memory-telemetry.ts"), "utf8");
  for (const forbidden of [
    /HeapSnapshot/, /\binspector\b/i, /\bgc\s*\(/, /expose[-_]gc/, /max[-_]old[-_]space/, /NODE_OPTIONS/, /setFlagsFromString/,
  ]) {
    assert.doesNotMatch(text, forbidden, `the sampler must stay passive: ${forbidden} found`);
  }
  // The control: the same scan is live, not vacuous.
  assert.match(text, /process\.memoryUsage\(\)/);
});
