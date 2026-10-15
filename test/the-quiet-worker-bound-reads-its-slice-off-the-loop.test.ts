// W1-T9527 — OBSERVED 2026-10-14 on the core daemon: watchDispatchSpawn's `history` read the whole ledger union
// synchronously (readLedgerUnionRecordsSync, 401 rotations of ~9.5 MB decompressed, every line parsed) the first time
// each worker spawn went quiet. Two of those reads froze the loop 1,447 s and 965 s back to back. These tests pin that
// the bound's history loads its rotations off the loop, through one durable slice reader per process, and that the
// slice answers exactly what the whole union answers. watchDispatchSpawn's wiring of the process's one history is pinned
// in test/a-hung-worker-in-its-own-wait-loop-is-recovered.test.ts, which already imports src/run-task.ts.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "../src/lib/ledger-union.js";
import {
  createQuietBoundHistory, deriveQuietBound, projectQuietHistoryRow, quietGapsByProvider, quietHistoryOptions, runQuietWorkerWatchdog,
  QUIET_BASIS_LEDGER_STEP, QUIET_HISTORY_STEPS, type QuietBoundHistory, type QuietWatchdogOptions,
} from "../src/lib/quiet-worker-watchdog.js";
import { createEscalationTriageHistoryReader } from "../src/lib/sweep.js";
import { DEFAULT_WORKER_QUIET_FLOOR_MS } from "../src/lib/worker.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const STEPS = ["worker.state", "worker.assignment"];
const FALLBACK_MS = 3_600_000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const rotationName = (s: number, gz: boolean): string => `ledger.${at(s).replace(/[:.]/g, "-")}.ndjson${gz ? ".gz" : ""}`;
const ndjson = (rows: Array<Record<string, unknown>>): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function assignment(run: string, provider: string, s: number): Record<string, unknown> {
  return {
    ts: at(s), host: "h1", actor_pid: 7, run_id: run, task_id: "W1-T1", step: "worker.assignment",
    worker_assignment: { id: `a-${run}`, selected: { provider, model: "m" }, routing: { evidence: "x".repeat(300) } },
  };
}

function state(run: string, value: string, s: number): Record<string, unknown> {
  return { ts: at(s), host: "h1", actor_pid: 7, run_id: run, task_id: "W1-T1", step: "worker.state", state: value, actor: "daemon" };
}

function noise(tag: string, count: number, s: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ ts: at(s), run_id: `${tag}-${i}`, task_id: "W1-T1", step: "heartbeat.tick", note: "worker.state in prose" }));
}

/** One run: assigned, working, then a quiet episode of `gap` seconds that ends with the worker speaking again. */
function episode(run: string, provider: string, s: number, gap: number): Array<Record<string, unknown>> {
  return [assignment(run, provider, s), state(run, "working", s + 1), state(run, "quiet", s + 2), state(run, "tool-executing", s + 2 + gap)];
}

/** A corpus whose quiet episodes span gzip and plain rotations and the live file. */
function corpus() {
  const a = [...episode("R1", "claude", 0, 40), ...noise("a", 30, 5), ...episode("R2", "codex", 100, 90)];
  const b = [...episode("R3", "claude", 1000, 120), ...noise("b", 30, 1005), assignment("R4", "claude", 1100), state("R4", "quiet", 1102)];
  const c = [state("R4", "working", 1300), ...episode("R5", "claude", 2000, 75), ...noise("c", 30, 2005)];
  const fixture = writeLedger([...episode("R6", "codex", 3000, 30), ...noise("live", 20, 3005)], {
    rotations: [{ at: at(999), gz: true, rows: a }, { at: at(1999), gz: false, rows: b }, { at: at(2999), gz: true, rows: c }],
  });
  return fixture;
}

/** The whole-union read the bound used before W1-T9527, as the watchdog consumed it. */
function wholeUnion(dir: string): Array<Record<string, unknown>> {
  const read = readLedgerUnionRecordsSync(dir, { step: STEPS });
  return read.ok ? read.rows : [];
}

function countingReads() {
  const counts = { asyncLoads: [] as string[], syncRotationReads: 0, digestReads: 0, gunzips: 0 };
  const fs: LedgerGrepFsDeps = {
    ...realLedgerFs,
    readFileSync: (path) => {
      if (path.includes("rotation-digests")) counts.digestReads += 1;
      else if (/ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.syncRotationReads += 1;
      return realLedgerFs.readFileSync(path);
    },
    gunzipSync: (buf) => (counts.gunzips += 1, realLedgerFs.gunzipSync(buf)),
  };
  const readRotation = async (path: string): Promise<Buffer> => {
    counts.asyncLoads.push(path);
    return readFile(path);
  };
  const reset = (): void => {
    counts.asyncLoads = [];
    counts.syncRotationReads = 0;
    counts.digestReads = 0;
    counts.gunzips = 0;
  };
  return { counts, fs, readRotation, reset };
}

/** The bound's history as production builds it, over the real slice reader, with the test's file-system seams. */
function boundHistory(io: { fs?: LedgerGrepFsDeps; readFile?: (path: string) => Promise<Buffer> } = {}): QuietBoundHistory {
  return createQuietBoundHistory({
    holder: "test.quiet-worker-bound", ...(io.fs ? { fs: io.fs } : {}),
    createReader: (reader) => createEscalationTriageHistoryReader({ ...reader, ...(io.readFile ? { readFile: io.readFile } : {}) }),
  });
}

/** One spawn's watchdog over `history`, on a fake clock; `quiet()` moves the clock past the quiet floor. */
function watchedSpawn(stateDir: string, runId: string, history: QuietBoundHistory) {
  const clock = { ms: 0 };
  const rows: Array<[string, Record<string, unknown>]> = [];
  const handle = runQuietWorkerWatchdog({
    taskId: "W1-T9527", runId, rootPid: () => undefined, provider: () => "claude", ...quietHistoryOptions(stateDir, history),
    fallbackBoundMs: FALLBACK_MS, quietFloorMs: DEFAULT_WORKER_QUIET_FLOOR_MS, clock: clockFromMillisFn(() => clock.ms),
    ledger: (step, fields) => { rows.push([step, fields]); }, judge: async () => undefined, listProcesses: () => [],
  });
  const quiet = (): void => { clock.ms = DEFAULT_WORKER_QUIET_FLOOR_MS + 1_000; };
  const bound = (): Record<string, unknown> | undefined => rows.find(([step]) => step === QUIET_BASIS_LEDGER_STEP)?.[1];
  return { tick: () => handle.tick(), quiet, bound, rows };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("W1-T9527: a slow quiet-bound history read does not block a concurrent timer", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const gate = deferred();
  const reached = deferred();
  const loads: string[] = [];
  const { counts, fs } = countingReads();
  const history = boundHistory({
    fs,
    readFile: async (path) => {
      loads.push(path);
      reached.resolve();
      await gate.promise;
      return readFile(path);
    },
  });
  const spawn = watchedSpawn(fixture.dir, "W1-T9527-1", history);
  spawn.quiet();

  const events: string[] = [];
  let timerTicks = 0;
  const timer = setInterval(() => { timerTicks += 1; }, 1);
  t.after(() => { clearInterval(timer); gate.resolve(); });
  const bound = spawn.tick().then(() => { events.push("bound"); });
  await new Promise<void>((done) => setTimeout(() => { events.push("timer"); done(); }, 0));
  await Promise.race([reached.promise, delay(10_000)]);
  await delay(20);
  const ticksWhilePending = timerTicks;
  assert.deepEqual(events, ["timer"], "a concurrent timer fired while the bound's rotations were still loading");
  assert.ok(ticksWhilePending > 0, `an interval kept ticking while the load was pending (${ticksWhilePending})`);
  assert.equal(spawn.bound(), undefined, "no bound is derived before its history resolved");
  assert.equal(loads.length, 1, "the first rotation's load is pending, off the loop");
  gate.resolve();
  await bound;
  clearInterval(timer);
  assert.deepEqual(events, ["timer", "bound"]);
  assert.equal(counts.syncRotationReads + counts.gunzips, 0, "no rotation is read or decompressed on the loop: no synchronous union read");
  assert.equal(loads.length, 3, "each gzip and plain rotation is loaded once, off the loop");
  const row = spawn.bound()!;
  assert.equal(row.bound_source, "observed_quiet_gaps");
  assert.equal(row.samples, 4, "claude's four closed quiet episodes, one of them spanning two rotations");
  assert.equal(row.history_ok, true);
  assert.equal(row.history_rotations, 3);
  assert.equal(row.history_rotations_unseen, 3);
  assert.equal(row.history_rotation_bytes_reused, 0);
  assert.ok(typeof row.history_ms === "number" && (row.history_ms as number) >= 0);
  assert.ok(typeof row.derive_ms === "number" && (row.derive_ms as number) >= 0);
  assert.ok((row.history_loop_read_bytes as number) > 0, "the live file is read on the loop, and counted");
});

test("W1-T9527: the slice gives the same quiet bound as the whole union", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const history = boundHistory();
  const same = async (label: string, read: QuietBoundHistory = history): Promise<void> => {
    const whole = wholeUnion(fixture.dir);
    const slice = await read(fixture.dir);
    assert.deepEqual(slice.rows, whole.map(projectQuietHistoryRow), `${label}: the slice holds the whole union's rows, projected`);
    assert.deepEqual(quietGapsByProvider(slice.rows), quietGapsByProvider(whole), `${label}: the same gaps per provider`);
    for (const provider of ["claude", "codex", "unknown"]) {
      assert.deepEqual(deriveQuietBound(slice.rows, provider, FALLBACK_MS), deriveQuietBound(whole, provider, FALLBACK_MS),
        `${label}: the same ${provider} bound, source and samples`);
    }
    assert.equal(deriveQuietBound(whole, "claude", FALLBACK_MS).source, "observed_quiet_gaps", `${label}: control — the corpus has claude history`);
  };
  await same("first pass");

  // The daemon writes while the reader reads: a partial last line, then its completion and more rows.
  const tail = JSON.stringify(state("R7", "quiet", 3100));
  appendFileSync(fixture.path, ndjson([assignment("R7", "claude", 3099)]) + tail.slice(0, 40));
  await same("a torn live tail");
  appendFileSync(fixture.path, tail.slice(40) + "\n" + ndjson([state("R7", "working", 3160), ...noise("more", 5, 3161)]));
  await same("the tail completed");

  // Rotation: the live file is cut into a gzip archive and a new live file begins.
  const cut = join(fixture.dir, rotationName(3999, true));
  writeFileSync(cut, gzipSync(readFileSync(fixture.path)));
  writeFileSync(fixture.path, ndjson([...episode("R8", "claude", 4000, 55)]));
  await same("after a rotation");

  // Restart: a fresh process answers from the durable digests and still agrees.
  const restarted = boundHistory();
  await same("after a restart", restarted);

  // An unreadable rotation: the slice refuses an incomplete corpus, and the bound falls back to the policy row, saying so.
  writeFileSync(join(fixture.dir, rotationName(500, true)), Buffer.from("not gzip"));
  const whole = readLedgerUnionRecordsSync(fixture.dir, { step: STEPS, refuseIncomplete: true });
  assert.equal(whole.ok, false, "control: the union cannot read the damaged rotation");
  const refused = await history(fixture.dir);
  assert.equal(refused.cost.history_ok, false);
  assert.deepEqual(refused.rows, []);
  assert.deepEqual(deriveQuietBound(refused.rows, "claude", FALLBACK_MS), { provider: "claude", boundMs: FALLBACK_MS, source: "no_history_fallback", samples: 0 });
  assert.deepEqual(QUIET_HISTORY_STEPS, STEPS);
});

test("W1-T9527: a second spawn reloads no rotation", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const { counts, fs, readRotation, reset } = countingReads();
  const history = boundHistory({ fs, readFile: readRotation });

  const first = watchedSpawn(fixture.dir, "W1-T9527-1", history);
  first.quiet();
  await first.tick();
  assert.equal(counts.asyncLoads.length, 3, `the first spawn loads each rotation once, off the loop (${counts.asyncLoads})`);
  assert.equal(counts.syncRotationReads + counts.gunzips, 0, "no rotation is read or decompressed on the loop");
  assert.equal(first.bound()?.samples, 4);

  fixture.append([...episode("R9", "claude", 3500, 65)]);
  reset();
  const second = watchedSpawn(fixture.dir, "W1-T9527-2", history);
  second.quiet();
  await second.tick();
  assert.deepEqual(counts.asyncLoads, [], "the second spawn loads no rotation");
  assert.equal(counts.syncRotationReads + counts.gunzips + counts.digestReads, 0, "nor reads one, or its digest, on the loop");
  const row = second.bound()!;
  assert.equal(row.samples, 5, "and still sees the episode appended since");
  assert.equal(row.history_rotations_unseen, 0);
  const archived = ["999", "1999", "2999"].map((s, i) => statSync(join(fixture.dir, rotationName(Number(s), i !== 1))).size);
  assert.equal(row.history_rotation_bytes_reused, archived.reduce((sum, size) => sum + size, 0));
  assert.equal(row.history_rotation_bytes_unseen, 0);

  // Two spawns going quiet together still load each rotation once (a fresh corpus: no durable digest yet).
  const fresh = corpus();
  t.after(() => rmSync(fresh.dir, { recursive: true, force: true }));
  const together = countingReads();
  const shared = boundHistory({ fs: together.fs, readFile: together.readRotation });
  const a = watchedSpawn(fresh.dir, "W1-T9527-3", shared);
  const b = watchedSpawn(fresh.dir, "W1-T9527-4", shared);
  a.quiet();
  b.quiet();
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(together.counts.asyncLoads.length, 3, `concurrent first passes load each rotation once (${together.counts.asyncLoads})`);
  assert.equal(a.bound()?.samples, b.bound()?.samples);
});

test("W1-T9527: the bound waits for its history, and a worker that spoke meanwhile is not inspected", async () => {
  const clock = { ms: 0 };
  const rows: Array<[string, Record<string, unknown>]> = [];
  const gate = deferred();
  let listed = 0;
  const options: QuietWatchdogOptions = {
    taskId: "W1-T9527", runId: "W1-T9527-7", rootPid: () => 4321, provider: () => "claude",
    history: async () => {
      await gate.promise;
      return [...episode("R1", "claude", 0, 1)];
    },
    historyCost: () => ({ history_rows: 4 }),
    fallbackBoundMs: FALLBACK_MS, quietFloorMs: 30_000, clock: clockFromMillisFn(() => clock.ms),
    ledger: (step, extra) => { rows.push([step, extra]); }, judge: async () => undefined,
    listProcesses: () => { listed += 1; return []; },
  };
  const dog = runQuietWorkerWatchdog(options);
  clock.ms = 40_000;
  const pending = dog.tick();
  await delay(5);
  dog.observer({ kind: "working", tsMs: 40_000 });
  gate.resolve();
  await pending;
  const bound = rows.find(([step]) => step === QUIET_BASIS_LEDGER_STEP)?.[1];
  assert.equal(bound?.bound_ms, 1_000);
  assert.equal(bound?.history_rows, 4, "the history's cost rides on the bound row");
  assert.equal(listed, 0, "the worker spoke while the history loaded: no inspection");
});

test("W1-T9527: a history read that throws gives the fallback bound and says why", async () => {
  const rows: Array<[string, Record<string, unknown>]> = [];
  const clock = { ms: 0 };
  const dog = runQuietWorkerWatchdog({
    taskId: "W1-T9527", runId: "W1-T9527-8", rootPid: () => undefined, provider: () => "claude",
    history: async () => { throw new Error("EIO: ledger unreadable"); },
    fallbackBoundMs: FALLBACK_MS, quietFloorMs: 30_000, clock: clockFromMillisFn(() => clock.ms),
    ledger: (step, extra) => { rows.push([step, extra]); }, judge: async () => undefined,
  });
  clock.ms = 40_000;
  await dog.tick();
  const bound = rows.find(([step]) => step === QUIET_BASIS_LEDGER_STEP)?.[1];
  assert.equal(bound?.bound_source, "no_history_fallback");
  assert.equal(bound?.history_error, "EIO: ledger unreadable");
});

test("W1-T9527: a failed history pass rejects to its caller and never wedges the next pass", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  let broken = true;
  const flaky: LedgerGrepFsDeps = {
    ...realLedgerFs,
    existsSync: (path) => {
      if (broken) throw new Error("EIO: stat refused");
      return realLedgerFs.existsSync(path);
    },
  };
  const history = boundHistory({ fs: flaky });
  await assert.rejects(history(fixture.dir), /EIO: stat refused/);
  broken = false;
  const next = await history(fixture.dir);
  assert.equal(next.cost.history_ok, true);
  assert.deepEqual(next.rows, wholeUnion(fixture.dir).map(projectQuietHistoryRow));
});

test("W1-T9527: the bound's projection keeps only what the bound reads, and is idempotent", () => {
  const row = { ...assignment("R1", "claude", 0), extra: { big: "y".repeat(100) } };
  const projected = projectQuietHistoryRow(row);
  assert.deepEqual(projected, { ts: at(0), step: "worker.assignment", run_id: "R1", host: "h1", actor_pid: 7, worker_assignment: { selected: { provider: "claude" } } });
  assert.deepEqual(projectQuietHistoryRow(projected), projected);
  assert.deepEqual(projectQuietHistoryRow(state("R1", "quiet", 2)), { ts: at(2), step: "worker.state", run_id: "R1", state: "quiet", host: "h1", actor_pid: 7 });
});
