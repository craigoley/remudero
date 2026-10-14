/**
 * W1-T8883 — THE HEAP-CEILING SHADOW LEARNS FROM LIVE SAMPLES.
 *
 * `daemon.heap_ceiling_shadow` was written at boot only, from live sets held in memory, so `live_samples` was 0 in 13
 * of 13 rows while the daemon rebooted about hourly. The shadow now samples the heap on the heartbeat, keeps the
 * samples across boots in the state directory (7 days), and ledgers a proposed ceiling: p99.9 of the post-collection
 * live set times the policy headroom, never below 2x the largest live set seen. REPORT ONLY.
 *
 * The first case drives the real `runDaemon` loop through three simulated boots over one state directory. Sampling at
 * boot only reports `live_samples` 0 on every boot and fails it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockFromDateFn } from "../src/lib/clock.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon } from "../src/lib/daemon.js";
import {
  createHeapShadow, heapSamplePath, HEAP_SAMPLE_RETAIN_MS, installedHeapShadow, parseHeapSamples, proposeHeapCeiling,
  quantileOf, type HeapSample, type HeapSampleIo, type SlackSnapshot,
} from "../src/lib/daemon-memory-policy.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const POLL_MS = 60_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const LIMIT = 8 * GIB;

function fixturePlan(dir: string): Plan {
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(f);
}

interface Row { step: string; extra: Record<string, unknown> }

/** One boot of an idle daemon over `stateDir`: `ticks` heartbeats, the heap in use growing by `growMib` per sample. */
async function boot(stateDir: string, planDir: string, o: { pid: number; startMs: number; baseBytes: number; ticks: number; growMib: number }): Promise<Row[]> {
  let nowMs = o.startMs;
  let reads = 0;
  const rows: Row[] = [];
  const snapshot = (): SlackSnapshot => {
    const used = o.baseBytes + reads++ * o.growMib * MIB;
    return { rss_bytes: used + 200 * MIB, heap_used_bytes: used, heap_physical_bytes: used + 100 * MIB, external_bytes: 0, heap_size_limit_bytes: LIMIT };
  };
  await runDaemon(
    fixturePlan(planDir),
    {
      refreshMerged: () => () => true,
      runOne: async () => { throw new Error("an idle daemon dispatches nothing"); },
      now: () => new Date(nowMs),
      sleep: async (ms: number) => { nowMs += ms; },
      checkStop: () => (rows.filter((r) => r.step === "daemon.tick").length >= o.ticks ? "test done" : undefined),
      log: (step, e = {}) => { rows.push({ step, extra: e }); },
      readMemoryTelemetry: Object.assign(() => ({ rss_bytes: 1 }), { afterRow: () => {} }),
      plainBackfill: { stateDir, readProposals: () => [] },
      heapShadowSeams: { snapshot, pid: o.pid },
    },
    { pollIntervalMs: POLL_MS },
  );
  return rows;
}

const shadowRows = (rows: Row[]): Record<string, unknown>[] => rows.filter((r) => r.step === "daemon.heap_ceiling_shadow").map((r) => r.extra);

test("W1-T8883: the heap ceiling shadow learns from live samples", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-shadow-`));
  try {
    const boots: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const rows = await boot(dir, dir, { pid: 1000 + i, startMs: Date.parse("2026-10-12T00:00:00Z") + i * 3_600_000, baseBytes: (1 + i) * GIB, ticks: 8, growMib: 20 });
      const learned = shadowRows(rows).find((r) => r.basis === "learned");
      assert.ok(learned, `boot ${i}: a learned daemon.heap_ceiling_shadow row, saw ${rows.map((r) => r.step).join(",")}`);
      boots.push(learned);
      assert.equal(installedHeapShadow(), undefined, "the shadow is uninstalled when the daemon stops");
    }
    // The first boot has nothing to learn from; every later boot starts with what the earlier ones sampled.
    assert.equal(boots[0].live_samples, 0);
    assert.equal(boots[0].proposed_unlearned, "no live heap sample yet");
    assert.ok((boots[1].live_samples as number) >= 6, `boot 2 learned from boot 1's samples: ${String(boots[1].live_samples)}`);
    assert.ok((boots[2].live_samples as number) > (boots[1].live_samples as number), "samples accumulate across boots");
    assert.equal(boots[1].boots_sampled, 1);
    assert.equal(boots[2].boots_sampled, 2);

    // The proposal: never below 2x the largest live set seen, and REPORT ONLY (the ceiling in force is the heap limit).
    const third = boots[2];
    const max = third.live_max_bytes as number;
    assert.ok(max >= 2 * GIB, "the largest live set is from the second boot's heap");
    assert.ok((third.proposed_ceiling_bytes as number) >= 2 * max, "never below 2x the max observed live set");
    assert.equal(third.floor_bytes, 2 * max);
    assert.equal(third.shadow, true);
    assert.equal(third.report_only, true);
    assert.equal(third.ceiling_in_force_bytes, LIMIT, "the ceiling in force is unchanged");

    // The samples are in the state directory, one pid per boot.
    const persisted = parseHeapSamples(readFileSync(heapSamplePath(dir), "utf8"));
    assert.ok(Array.isArray(persisted));
    assert.deepEqual([...new Set((persisted as HeapSample[]).map((s) => s.pid))], [1000, 1001, 1002]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function memoryIo(initial?: string): HeapSampleIo & { file: string | undefined; failWrites: boolean } {
  const io = {
    file: initial, failWrites: false,
    readFile: () => { if (io.file === undefined) throw Object.assign(new Error("no file"), { code: "ENOENT" }); return io.file; },
    writeFile: (_p: string, content: string) => { if (io.failWrites) throw Object.assign(new Error("full"), { code: "ENOSPC" }); io.file = content; },
  };
  return io;
}

function fakeClock(startMs: number) {
  let t = startMs;
  return { clock: clockFromDateFn(() => new Date(t)), advance: (ms: number) => { t += ms; } };
}

const snapshotOf = (used: number): (() => SlackSnapshot) => () => ({
  rss_bytes: used, heap_used_bytes: used, heap_physical_bytes: used + MIB, external_bytes: 0, heap_size_limit_bytes: LIMIT,
});

test("the proposal is p99.9 of the collected live set times the headroom, floored at twice the largest live set", () => {
  const collected = Array.from({ length: 1000 }, (_, i): HeapSample => ({ at: i, used_bytes: (i + 1) * MIB, size_bytes: 0, after_gc: true, pid: 1 }));
  // A heartbeat reading above every collected one raises the floor but not the quantile.
  const samples = [...collected, { at: 1001, used_bytes: 1500 * MIB, size_bytes: 0, after_gc: false, pid: 2 }];
  const wide = proposeHeapCeiling(samples, 250, LIMIT);
  assert.equal(wide.live_p999_bytes, 999 * MIB);
  assert.equal(wide.live_max_bytes, 1500 * MIB);
  assert.equal(wide.headroom_factor, 3.5);
  assert.equal(wide.proposed_ceiling_bytes, Math.round(999 * MIB * 3.5), "the quantile term wins when the headroom passes the floor's multiple");
  const tight = proposeHeapCeiling(samples, 50, LIMIT);
  assert.equal(tight.proposed_ceiling_bytes, 3000 * MIB, "the 2x floor wins when the headroom is below it");
  assert.equal(tight.boots_sampled, 2);
  assert.equal(quantileOf([], 0.5), undefined);
  assert.equal(quantileOf([3, 1, 2], 0.999), 3);
  // Without a collected sample the quantile is taken over the heartbeat readings.
  const heartbeatOnly = proposeHeapCeiling([{ at: 1, used_bytes: 10, size_bytes: 0, after_gc: false, pid: 1 }], 50, LIMIT);
  assert.equal(heartbeatOnly.after_gc_samples, 0);
  assert.equal(heartbeatOnly.live_p999_bytes, 10);
});

test("the store keeps a rolling 7-day window, rate-limits heartbeat samples and survives a restart", () => {
  const io = memoryIo();
  const { clock, advance } = fakeClock(Date.parse("2026-10-01T00:00:00Z"));
  const proposals: unknown[] = [];
  const a = createHeapShadow({ path: "p", clock, io, snapshot: snapshotOf(GIB), pid: 1, onProposal: (p) => proposals.push(p) });
  a.sampleNow();
  advance(10_000);
  a.sampleNow();
  assert.equal(a.samples().length, 1, "a heartbeat inside the minimum gap adds no sample");
  advance(60_000);
  a.sampleNow();
  assert.equal(a.samples().length, 2);
  assert.equal(a.propose().ceiling_in_force_bytes, LIMIT);
  a.flush();
  // A restart over the same file keeps the samples.
  const b = createHeapShadow({ path: "p", clock, io, snapshot: snapshotOf(2 * GIB), pid: 2 });
  assert.equal(b.samples().length, 2);
  assert.equal(b.loadError, undefined);
  // Eight days later the earlier samples fall out of the window on the next reading.
  advance(HEAP_SAMPLE_RETAIN_MS + 86_400_000);
  b.sampleNow();
  assert.equal(b.samples().length, 1);
  assert.equal(b.samples()[0].pid, 2);
  // A proposal row is due about hourly from a running shadow, never per reading.
  const c = createHeapShadow({ path: "q", clock, io: memoryIo(), snapshot: snapshotOf(GIB), pid: 3, onProposal: (p) => proposals.push(p) });
  for (let i = 0; i < 125; i++) { advance(60_000); c.sampleNow(); }
  assert.equal(proposals.length, 2, "one proposal per hour of heartbeats");
});

test("an unreadable file is named and starts empty, and a failed persist keeps the samples and says so", () => {
  const torn = createHeapShadow({ path: "p", io: memoryIo("{not json"), snapshot: snapshotOf(GIB), pid: 1 });
  assert.equal(torn.loadError, "unparseable");
  assert.equal(torn.samples().length, 0);
  const foreign = createHeapShadow({ path: "p", io: memoryIo("{}"), snapshot: snapshotOf(GIB), pid: 1 });
  assert.equal(foreign.loadError, "no samples array");
  assert.equal(createHeapShadow({ path: "p", io: memoryIo(), snapshot: snapshotOf(GIB), pid: 1 }).loadError, undefined, "a first boot has no file and no error");
  // Rows that are not a sample are dropped, not read as zero.
  const parsed = parseHeapSamples(JSON.stringify({ samples: [[1, 2, 3, 0, 4], [1, "x", 3, 0, 4], [1, 2, 3, 2, 4], "junk"] }));
  assert.equal((parsed as HeapSample[]).length, 1);

  const io = memoryIo();
  io.failWrites = true;
  const reasons: string[] = [];
  const { clock, advance } = fakeClock(1_000_000);
  const s = createHeapShadow({ path: "p", clock, io, snapshot: snapshotOf(GIB), pid: 1, onPersistError: (r) => reasons.push(r) });
  s.sampleNow();
  assert.deepEqual(reasons, ["ENOSPC"]);
  assert.equal(s.samples().length, 1, "the sample is kept in memory");
  advance(60_000);
  s.sampleNow();
  assert.equal(reasons.length, 1, "a failed persist retries on the normal cadence, not on every heartbeat");
  assert.deepEqual(s.flush(), { persisted: false, reason: "ENOSPC" });
});

test("the default store reads and writes its real file", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-shadow-real-`));
  try {
    const path = heapSamplePath(dir);
    const first = createHeapShadow({ path, snapshot: snapshotOf(GIB), pid: 7 });
    first.sampleNow();
    assert.deepEqual(first.flush(), { persisted: true });
    assert.ok(existsSync(path));
    assert.equal(createHeapShadow({ path, snapshot: snapshotOf(GIB), pid: 8 }).samples().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
