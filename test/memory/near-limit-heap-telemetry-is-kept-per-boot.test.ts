import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createNearLimitHeapTelemetry, NEAR_LIMIT_MAX_BOOTS, NEAR_LIMIT_MAX_FILE_BYTES,
  NEAR_LIMIT_MAX_ROWS_PER_BOOT, NEAR_LIMIT_READ_BACKSTOP_MS, type NearLimitHeapOptions,
} from "#src/lib/daemon-heap-near-limit.js";
import {
  createDaemonMemoryGovernor, HEAP_SAMPLE_MIN_GAP_MS, HEAP_SAMPLE_RETAIN_MS,
  HEAP_SAMPLE_PERSIST_GAP_MS, HEAP_PROPOSAL_EVERY_MS,
} from "#src/lib/daemon-memory-policy.js";
import { FOOTPRINT_MAX_SAMPLES } from "#src/lib/daemon-footprint.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { withTempDir } from "#src/lib/tmp.js";

const work = { active: 3, admitted: 1, in_flight_tasks: 1, in_flight_reviews: 1, detached_sweep_actions: 1 };
function fixture() {
  let at = 1_000, used = 100, stored: string | undefined;
  const writes: number[] = [];
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const options: NearLimitHeapOptions = {
    path: "/fixture/heap.json", pid: 138, bootStart: 100, clock: clockFromMillisFn(() => at),
    heap: () => ({ used_heap_size: used, heap_size_limit: 1_000 }),
    memory: () => ({ rss_bytes: 300, swap_bytes: 20, budget_bytes: 2_000 }),
    pressure: () => "some avg10=1.25 avg60=0.50 avg300=0.10 total=12\nfull avg10=0.25 avg60=0.10 avg300=0.01 total=3\n",
    io: {
      readFile: () => { if (stored === undefined) throw Object.assign(Error("missing"), { code: "ENOENT" }); return stored; },
      writeFile: (_path, value) => { stored = value; writes.push(Buffer.byteLength(value)); },
    },
    log: (step, fields) => rows.push({ step, fields }),
  };
  return { options, rows, writes, at: (n: number) => { at = n; }, used: (n: number) => { used = n; },
    stored: () => stored!, corrupt: (text: string) => { stored = text; } };
}

test("test/memory/near-limit-heap-telemetry-is-kept-per-boot.test.ts W1-T11382 criterion 1", () => {
  const f = fixture();
  const telemetry = createNearLimitHeapTelemetry(f.options);
  const first = telemetry.recordNearLimitHeapSample("tick", work)!;
  assert.deepEqual(first, { at: 1_000, boot_key: "138:100", surface: "tick", used_bytes: 100, limit_bytes: 1_000,
    rss_bytes: 300, swap_bytes: 20, budget_bytes: 2_000,
    memory_psi: { some_avg10: 1.25, full_avg10: 0.25 }, ...work });
  f.at(1_000 + NEAR_LIMIT_READ_BACKSTOP_MS - 1);
  assert.equal(telemetry.recordNearLimitHeapSample("admission:dispatch", work), first);
  assert.equal(telemetry.snapshot().samples.length, 1);
  f.at(2_000);
  assert.equal(telemetry.recordNearLimitHeapSample("in-flight-tick", work)!.elapsed_ms, 1_000);
  f.at(3_000);
  assert.equal(telemetry.recordNearLimitHeapSample("admission:dispatch", work)!.surface, "admission:dispatch");
  f.at(473_000);
  assert.equal(telemetry.recordNearLimitHeapSample("in-flight-tick", work)!.elapsed_ms, 470_000);
  const unreadable = createNearLimitHeapTelemetry({ ...f.options, bootStart: 200,
    heap: () => { throw Error("heap unreadable"); }, memory: () => { throw Error("memory unreadable"); },
    pressure: () => { throw Error("psi unreadable"); } });
  const sample = unreadable.recordNearLimitHeapSample("tick", work)!;
  for (const field of ["used_bytes", "limit_bytes", "rss_bytes", "swap_bytes", "budget_bytes", "memory_psi", "elapsed_ms"]) {
    assert.equal(Object.hasOwn(sample, field), false, field);
  }
});

test("W1-T11382 criterion 2 same pid boots never pair and a fatal leaves an unmeasured final gap", () => {
  const f = fixture();
  const first = createNearLimitHeapTelemetry(f.options);
  first.recordNearLimitHeapSample("admission:dispatch", work);
  f.at(3_000); f.used(600);
  first.recordNearLimitHeapSample("tick", work);
  first.flush();
  const fatalFile = JSON.parse(f.stored());
  delete fatalFile.boots[0].clean_close;
  delete fatalFile.boots[0].final_gap;
  f.corrupt(JSON.stringify(fatalFile));
  f.at(4_000); f.used(900);
  const second = createNearLimitHeapTelemetry({ ...f.options, bootStart: 200 });
  assert.equal(second.recordNearLimitHeapSample("tick", work)!.elapsed_ms, undefined);
  let boots = second.snapshot().boots;
  assert.equal(boots.length, 2);
  assert.equal(boots[0].worst_rise!.rise_bytes, 500);
  assert.equal(boots[0].final_gap, "unmeasured");
  assert.equal(boots[0].last.used_bytes, 600);
  assert.equal(boots[0].clean_close, false);
  assert.equal(boots[1].worst_rise, undefined);
  f.at(5_000); f.used(700);
  second.recordNearLimitHeapSample("tick", work);
  second.close();
  const reloaded = createNearLimitHeapTelemetry({ ...f.options, bootStart: 300 });
  boots = reloaded.snapshot().boots;
  assert.equal(boots[1].largest_recovery!.rise_bytes, 200);
  assert.equal(boots[1].final_gap, "clean_close");
  assert.equal(boots[1].clean_close, true);
});

test("W1-T11382 criterion 3 retention bounds preserve worst rise and immediately persist a rising band", () => {
  const f = fixture();
  const telemetry = createNearLimitHeapTelemetry(f.options);
  telemetry.recordNearLimitHeapSample("tick", work);
  f.at(2_000); f.used(600);
  telemetry.recordNearLimitHeapSample("admission:dispatch", work);
  assert.equal(f.writes.length, 2, "rise persists without waiting five minutes");
  for (let i = 0; i < FOOTPRINT_MAX_SAMPLES * 10; i++) {
    f.at(3_000 + i * 10); telemetry.recordNearLimitHeapSample("tick", work);
  }
  assert.equal(telemetry.snapshot().samples.length, FOOTPRINT_MAX_SAMPLES);
  assert.equal(telemetry.snapshot().boots[0].worst_rise!.rise_bytes, 500);
  telemetry.flush();
  for (let i = 0; i < NEAR_LIMIT_MAX_BOOTS * 10; i++) {
    f.at(20_000 + i * 10);
    const boot = createNearLimitHeapTelemetry({ ...f.options, bootStart: 1_000 + i });
    boot.recordNearLimitHeapSample("tick", work); boot.close();
  }
  const loaded = createNearLimitHeapTelemetry({ ...f.options, bootStart: 99_999 });
  assert.equal(loaded.snapshot().boots.length, NEAR_LIMIT_MAX_BOOTS);
  assert.equal(loaded.snapshot().samples.length, FOOTPRINT_MAX_SAMPLES);
  assert.ok(Buffer.byteLength(f.stored()) <= NEAR_LIMIT_MAX_FILE_BYTES);
  assert.ok(f.writes.every(bytes => bytes <= NEAR_LIMIT_MAX_FILE_BYTES));
  f.at(HEAP_SAMPLE_RETAIN_MS + 100_000);
  loaded.recordNearLimitHeapSample("tick", work);
  assert.equal(loaded.snapshot().boots.length, 1);
  assert.equal(loaded.snapshot().samples.length, 1);
  f.corrupt('{"samples":[');
  const torn = createNearLimitHeapTelemetry(f.options);
  assert.equal(torn.snapshot().unread, "unparseable");
  assert.ok(f.rows.some(row => row.step === "daemon.heap_near_limit_persist_failed" && row.fields.reason === "unparseable"));
});

test("W1-T11382 criterion 4 transition rows are rate limited and carry suppressed counts", () => {
  const f = fixture();
  const telemetry = createNearLimitHeapTelemetry(f.options);
  telemetry.recordNearLimitHeapSample("tick", work);
  for (let i = 1; i <= 10; i++) { f.at(1_000 + i * 10); telemetry.recordNearLimitHeapSample("tick", work); }
  assert.equal(f.rows.filter(r => r.step === "daemon.heap_near_limit").length, 0);
  f.at(2_000); f.used(300); telemetry.recordNearLimitHeapSample("tick", work);
  f.at(3_000); f.used(500); telemetry.recordNearLimitHeapSample("tick", work);
  f.at(2_000 + HEAP_SAMPLE_MIN_GAP_MS); f.used(700); telemetry.recordNearLimitHeapSample("tick", work);
  const transitions = f.rows.filter(r => r.step === "daemon.heap_near_limit");
  assert.equal(transitions.length, 2);
  assert.equal(transitions[1].fields.suppressed, 1);
  for (let i = 2; i < NEAR_LIMIT_MAX_ROWS_PER_BOOT * 10; i++) {
    f.at(2_000 + i * HEAP_SAMPLE_MIN_GAP_MS); f.used(i % 2 ? 100 : 700);
    telemetry.recordNearLimitHeapSample("tick", work);
  }
  assert.equal(f.rows.filter(r => r.step === "daemon.heap_near_limit").length, NEAR_LIMIT_MAX_ROWS_PER_BOOT);
  telemetry.flush();
  const restored = createNearLimitHeapTelemetry(f.options);
  f.at(HEAP_SAMPLE_MIN_GAP_MS * NEAR_LIMIT_MAX_ROWS_PER_BOOT * 11);
  f.used(700); restored.recordNearLimitHeapSample("tick", work);
  assert.equal(f.rows.filter(r => r.step === "daemon.heap_near_limit").length, NEAR_LIMIT_MAX_ROWS_PER_BOOT);
  assert.equal(restored.snapshot().boots[0].transition_rows, NEAR_LIMIT_MAX_ROWS_PER_BOOT);
});

test("W1-T11382 criterion 5 shadow proposals learn only from same boot growth and recovery", () => {
  const f = fixture();
  const telemetry = createNearLimitHeapTelemetry(f.options);
  telemetry.recordNearLimitHeapSample("admission:dispatch", work);
  const cold = f.rows.find(r => r.step === "daemon.heap_hold_shadow")!.fields;
  assert.equal(cold.shadow, true);
  assert.equal(cold.candidate_high_unlearned, "no same-boot rise");
  assert.equal(cold.recovery_unlearned, "no same-boot recovery");
  f.at(2_000); f.used(400); telemetry.recordNearLimitHeapSample("tick", work);
  f.at(3_000); f.used(200); telemetry.recordNearLimitHeapSample("tick", work);
  f.at(HEAP_PROPOSAL_EVERY_MS + 1_000); telemetry.recordNearLimitHeapSample("tick", work);
  const learned = f.rows.filter(r => r.step === "daemon.heap_hold_shadow").at(-1)!.fields;
  assert.equal(learned.shadow, true);
  assert.equal(learned.worst_rise_bytes, 300);
  assert.equal(learned.p99_rise_bytes, 300);
  assert.equal(learned.rise_bytes_per_second, 300);
  assert.equal(learned.recovery_bytes, 200);
  assert.equal(learned.reserve_fraction, 0.75 - 0.4);
  assert.ok(Math.abs(Number(learned.candidate_high_fraction) - 0.15) < 1e-12);
  const held = fixture();
  const noAdmission = createNearLimitHeapTelemetry(held.options);
  const quietWork = { ...work, admitted: 0 };
  noAdmission.recordNearLimitHeapSample("admission:dispatch", quietWork);
  held.at(2_000); held.used(400); noAdmission.recordNearLimitHeapSample("tick", quietWork);
  held.at(HEAP_PROPOSAL_EVERY_MS + 1_000); noAdmission.recordNearLimitHeapSample("tick", quietWork);
  const heldShadow = held.rows.filter(r => r.step === "daemon.heap_hold_shadow").at(-1)!.fields;
  assert.equal(heldShadow.candidate_high_unlearned, "no rise following admission");
  assert.equal(Object.hasOwn(heldShadow, "candidate_high_fraction"), false);
});

test("W1-T11382 criterion 6 telemetry cannot change daemon work holds flags or the 75% exit", async t => {
  const signals = t.mock.method(process, "kill", () => { throw Error("telemetry must not signal a process"); });
  const nodeOptions = process.env.NODE_OPTIONS;
  await withTempDir("near-limit-daemon", async dir => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, '- id: W1-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  files: [src/fixture.ts]\n  verify: auto\n  status: queued\n');
    const outcomes = [];
    for (const mode of ["absent", "present", "throwing"] as const) {
      let at = 1_000, runs = 0, holds = 0;
      const f = fixture();
      let sampleAt = 1_000;
      f.options.clock = clockFromMillisFn(() => sampleAt++);
      const flags: string[] = [];
      const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
      const telemetry = mode === "present" ? createNearLimitHeapTelemetry(f.options) : mode === "throwing" ? {
        recordNearLimitHeapSample: () => { throw Error("telemetry failed"); },
        close: () => { throw Error("close failed"); },
      } : undefined;
      const deps: DaemonDeps = {
        refreshMerged: () => () => false, runOne: async () => {
          runs++; return { verdict: "merged", taskId: "W1-T1", runId: "fixture", merged: true, costUsd: 0 };
        },
        sleep: async () => { at += HEAP_SAMPLE_PERSIST_GAP_MS; }, now: () => new Date(at),
        heapStatistics: () => ({ used_heap_size: runs ? 750 : 100, heap_size_limit: 1_000 }),
        memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: f => flags.push(f) }),
        workerAdmissionHold: () => { holds++; return undefined; },
        nearLimitHeapTelemetry: telemetry,
        log: (step, fields = {}) => rows.push({ step, fields }),
      };
      const result = await runDaemon(loadPlan(path), deps, { pollIntervalMs: 1 });
      assert.equal(result.stopReason, "heap_pressure");
      assert.equal(rows.find(r => r.step === "daemon.heap_pressure_exit")!.fields.threshold, 0.75);
      assert.deepEqual(flags, []);
      if (mode === "present") {
        assert.ok(telemetry && "snapshot" in telemetry);
        const samples = telemetry.snapshot().samples;
        assert.ok(samples.some(s => s.surface === "tick"));
        assert.ok(samples.some(s => s.surface === "admission:dispatch"));
      }
      if (mode === "throwing") assert.equal(rows.filter(r => r.step === "daemon.heap_near_limit_persist_failed").length, 1);
      outcomes.push({ result, runs, holds, flags });
      let heldSleeps = 0;
      const heldResult = await runDaemon(loadPlan(path), {
        ...deps, checkStop: () => heldSleeps >= 1 ? "fixture done" : undefined,
        heapStatistics: () => ({ used_heap_size: 100, heap_size_limit: 1_000 }),
        sleep: async () => { heldSleeps++; },
        workerAdmissionHold: () => ({ control: "PAUSE", detail: "fixture hold" }),
      }, { pollIntervalMs: 1 });
      assert.equal(heldResult.stopReason, "stopped");
      assert.equal(runs, 1, "a held admission started no extra work");
      assert.equal(rows.find(r => r.step === "daemon.admission_held")!.fields.reason, "fleet PAUSE hold: fixture hold");
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.deepEqual(outcomes[2], outcomes[0]);
    assert.equal(outcomes[0].runs, 1);
  });
  assert.equal(signals.mock.callCount(), 0);
  assert.equal(process.env.NODE_OPTIONS, nodeOptions);
});

test("W1-T11382 criterion 1 the daemon ticker and full sweep admission feed the same boot trace", async () => {
  await withTempDir("near-limit-ticker", async dir => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, '- id: W1-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  status: queued\n');
    const f = fixture();
    let at = 1_000, lightPasses = 0, fullAdmissions = 0;
    f.options.clock = clockFromMillisFn(() => at++);
    const telemetry = createNearLimitHeapTelemetry(f.options);
    let release!: () => void;
    const running = new Promise<void>(resolve => { release = resolve; });
    const summary = await runDaemon(loadPlan(path), {
      refreshMerged: () => () => false,
      runOne: async id => { await running; return { taskId: id, runId: "fixture", verdict: "merged", merged: true, costUsd: 0 }; },
      sleep: async () => { await new Promise<void>(resolve => setImmediate(resolve)); },
      sweepLight: async () => { if (++lightPasses >= 3) release(); },
      sweep: async gate => { fullAdmissions++; assert.equal(gate?.workerAdmissionHold?.("review"), undefined); },
      nearLimitHeapTelemetry: telemetry,
      heapStatistics: () => ({ used_heap_size: 100, heap_size_limit: 1_000 }),
      memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {} }),
    }, { max: 1, pollIntervalMs: 1 });
    assert.equal(summary.stopReason, "max_reached");
    assert.ok(fullAdmissions > 0);
    const samples = telemetry.snapshot().samples;
    assert.ok(samples.some(s => s.surface === "admission:full-sweep"));
    const busy = samples.find(s => s.surface === "in-flight-tick" && s.in_flight_tasks === 1)!;
    assert.ok(busy, "an in-flight beat measured the running task");
    assert.equal(busy.active, 1);
    assert.equal(samples.reduce((n, s) => n + s.admitted, 0), 1);
    assert.equal(new Set(samples.map(s => s.boot_key)).size, 1);
  });
});

test("near limit failures remain named with unread fields absent and no reporting exception escapes", () => {
  for (const bad of ['{}', '{"samples":[],"boots":[],"foreign":true}', "x".repeat(NEAR_LIMIT_MAX_FILE_BYTES + 1)]) {
    const f = fixture(); f.corrupt(bad);
    const telemetry = createNearLimitHeapTelemetry(f.options);
    assert.equal(typeof telemetry.snapshot().unread, "string");
    telemetry.recordNearLimitHeapSample("tick", work);
    telemetry.flush();
    assert.equal(typeof JSON.parse(f.stored()).unread, "string");
    assert.equal(f.rows.filter(r => r.step === "daemon.heap_near_limit_persist_failed").length, 1);
  }
  const f = fixture();
  const telemetry = createNearLimitHeapTelemetry({ ...f.options,
    io: { readFile: () => { throw Object.assign(Error("denied"), { code: "EACCES" }); },
      writeFile: () => { throw Error("disk full"); } },
    log: () => { throw Error("sink unavailable"); },
    pressure: () => "unreadable pressure", memory: () => ({ rss_bytes: NaN, swap_bytes: -1 }),
    heap: () => ({ used_heap_size: NaN, heap_size_limit: 0 }),
  });
  const sample = telemetry.recordNearLimitHeapSample("tick", work)!;
  assert.equal(Object.hasOwn(sample, "rss_bytes"), false);
  assert.equal(Object.hasOwn(sample, "swap_bytes"), false);
  assert.equal(Object.hasOwn(sample, "used_bytes"), false);
  assert.equal(Object.hasOwn(sample, "memory_psi"), false);
  assert.equal(telemetry.snapshot().unread, "denied");
  assert.doesNotThrow(() => telemetry.close());
  const disk = fixture();
  const failed = createNearLimitHeapTelemetry({ ...disk.options,
    io: { readFile: disk.options.io!.readFile, writeFile: () => { throw Error("disk full"); } } });
  failed.recordNearLimitHeapSample("tick", work); failed.flush(); failed.close();
  assert.equal(disk.rows.filter(r => r.step === "daemon.heap_near_limit_persist_failed").length, 1);
  assert.match(String(disk.rows[0].fields.reason), /disk full/);
});

test("near limit default readers and atomic store keep a real sample and a clean close", async () => {
  await withTempDir("near-limit-real", async dir => {
    const path = join(dir, "daemon-heap-near-limit.json");
    const telemetry = createNearLimitHeapTelemetry({ path });
    const sample = telemetry.recordNearLimitHeapSample("tick", work)!;
    assert.equal(sample.boot_key.split(":")[0], String(process.pid));
    assert.ok(sample.used_bytes! > 0);
    assert.ok(sample.rss_bytes! > 0);
    telemetry.close();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).boots[0].clean_close, true);
  });
});
