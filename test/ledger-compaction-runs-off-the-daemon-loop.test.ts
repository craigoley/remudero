/**
 * W1-T13333 — LEDGER COMPACTION RUNS OFF THE DAEMON LOOP.
 *
 * The daemon's compaction hook ran the whole pass, with synchronous zlib, on the daemon loop: 12 passes and
 * 1,107 s of loop lag in six hours on 2026-11-17. Each test drives the production hooks
 * (buildLedgerCompactionDaemonHooks) over a state dir of real gzip rotations and the real worker. A held or cut
 * pass starts the same worker module behind a small entry that holds or ends the thread at one named step.
 */
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import fs, { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import zlib, { gunzipSync, gzipSync } from "node:zlib";

import type { Config } from "#src/lib/config.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { writeAtomic } from "#src/lib/fs-race-safe.js";
import { LEDGER_COLD_STORE_DIRNAME, type LedgerCompactFs } from "#src/lib/ledger-compact.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { loadPlan } from "#src/lib/plan.js";
import { writeLedger, type LedgerRotationFixture } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildLedgerCompactionDaemonHooks, daemonLedgerCompactArgs, ledgerCompactCommand } from "#test/helpers/run-task-test.js";

const WORKER_MODULE = "src/lib/ledger-compact-worker.ts";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A UTC midnight twenty days back: every fixture rotation is far older than the age a daemon pass protects. */
const BASE = Math.floor((Date.now() - 20 * DAY) / DAY) * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();
const rotationName = (at: string): string => `ledger.${at.replace(/[:.]/g, "-")}.ndjson.gz`;
const TIMEOUT = { timeout: 240_000 };
const FIRES = { fire: true as const, overBound: true, reason: "fixture: archives over the bound" };
type Outcome = { sourceCount: number; rowsWritten: number; duplicatesCollapsed: number; archiveName: string };

/** Two days of three gzip rotations each; every rotation holds four rows of its own and one row its day shares. */
function rotations(): LedgerRotationFixture[] {
  const out: LedgerRotationFixture[] = [];
  for (let day = 0; day < 2; day++) {
    for (let k = 0; k < 3; k++) {
      const at = BASE + day * DAY + (k + 1) * HOUR;
      const own = [1, 2, 3, 4].map((i) => ({ ts: iso(at - i * 1000), step: "fixture.row", day, k, i }));
      out.push({ at: iso(at), gz: true, rows: [{ ts: iso(BASE + day * DAY + 60_000), step: "fixture.shared", day }, ...own] });
    }
  }
  return out;
}

function world(t: TestContext): { stateDir: string; config: Config; sources: string[] } {
  const root = ownedFixtureDir(t, "ledger-off-loop").dir;
  const stateDir = join(root, "state");
  writeLedger([{ ts: iso(Date.now()), step: "fixture.live" }], { dir: stateDir, rotations: rotations() });
  return { stateDir, config: { root } as unknown as Config, sources: rotations().map((r) => rotationName(r.at)) };
}

const archiveNames = (stateDir: string): string[] => readdirSync(stateDir).filter((name) => name.startsWith("ledger.")).sort();
const linesOf = (path: string): string[] =>
  (path.endsWith(".gz") ? gunzipSync(readFileSync(path)) : readFileSync(path)).toString("utf8").split("\n").filter((line) => line !== "");
/** Each ledger file's rows by file name. Every file must decompress and every row must parse. */
function archives(stateDir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of archiveNames(stateDir)) {
    out[name] = linesOf(join(stateDir, name));
    for (const line of out[name]!) JSON.parse(line);
  }
  return out;
}
/** Every row a union read returns, copies included. An unread archive fails the read. */
function unionRows(stateDir: string): string[] {
  const read = readLedgerUnionRecordsSync(stateDir, { refuseIncomplete: true, dedupe: false });
  assert.equal(read.ok, true, "the union read is complete");
  return read.rows.map((row) => JSON.stringify(row));
}
const distinct = (rows: string[]): string[] => [...new Set(rows)].sort();
const copies = (rows: string[], row: string): number => rows.filter((r) => r === row).length;
const coldFiles = (stateDir: string): string[] => (existsSync(join(stateDir, LEDGER_COLD_STORE_DIRNAME)) ? readdirSync(join(stateDir, LEDGER_COLD_STORE_DIRNAME)).sort() : []);

/** The pass run in place on this thread, as the hook ran it before this task. */
function inPlace(stateDir: string): { code: number; outcome: Outcome | undefined; errors: string[] } {
  let report: string | undefined;
  const errors: string[] = [];
  const code = ledgerCompactCommand(daemonLedgerCompactArgs(stateDir), { stateDir, out: (line) => void (report = line), error: (line) => void errors.push(line) });
  const parsed = report === undefined ? undefined : (JSON.parse(report) as Outcome);
  return { code, errors, outcome: parsed && { sourceCount: parsed.sourceCount, rowsWritten: parsed.rowsWritten, duplicatesCollapsed: parsed.duplicatesCollapsed, archiveName: parsed.archiveName } };
}

type Step = "gunzip" | "gzip" | "cold-dir" | "second-move";
/**
 * A worker entry that loads the real worker module after it wraps one step of the pass: the first decompression
 * (nothing staged), the first compression (outputs checked, none written), the cold directory (outputs written,
 * no source moved) or the second move. At that step the thread waits for the `release` file, or ends.
 */
function workerAt(t: TestContext, step: Step, action: "hold" | "exit"): { url: URL; held: string; release: () => void } {
  const dir = ownedFixtureDir(t, "ledger-off-loop-entry").dir;
  const [held, released] = [join(dir, "held"), join(dir, "release")];
  const source = `
import fs from "node:fs";
import zlib from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
const exists = fs.existsSync, mark = fs.writeFileSync;
let done = false, moves = 0;
const reach = () => {
  if (done) return;
  done = true;
  mark(${JSON.stringify(held)}, "");
  if (${JSON.stringify(action)} === "exit") process.exit(7);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!exists(${JSON.stringify(released)})) Atomics.wait(cell, 0, 0, 10);
};
const wrap = (mod, name, due) => { const real = mod[name]; mod[name] = (...args) => { if (due(...args)) reach(); return real(...args); }; };
const cold = (path) => String(path).includes(${JSON.stringify(LEDGER_COLD_STORE_DIRNAME)});
const step = ${JSON.stringify(step)};
if (step === "gunzip") wrap(zlib, "gunzipSync", () => true);
if (step === "gzip") wrap(zlib, "gzipSync", () => true);
if (step === "cold-dir") wrap(fs, "mkdirSync", cold);
if (step === "second-move") wrap(fs, "renameSync", (_from, to) => cold(to) && ++moves === 2);
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, WORKER_MODULE)).href)});
`;
  const path = join(dir, "entry.mjs");
  writeFileSync(path, source);
  return { url: pathToFileURL(path), held, release: () => writeFileSync(released, "") };
}

/** Resolves when `done` holds, or when `stop` does: a pass that settled early never hangs a test. */
async function until(done: () => boolean, stop: () => boolean = () => false): Promise<void> {
  while (!done() && !stop()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Counts the threads this thread starts while `run` runs. */
async function countingThreads<T>(run: (started: () => number) => Promise<T>): Promise<T> {
  let started = 0;
  const onThread = (): void => { started += 1; };
  subscribe("worker_threads", onThread);
  try {
    return await run(() => started);
  } finally {
    unsubscribe("worker_threads", onThread);
  }
}

/** Records this thread's synchronous zlib calls and its reads of a rotation file until `restore`. */
function watchThisThread(): { zlibCalls: () => number; rotationReads: () => string[]; restore: () => void } {
  const [z, f] = [zlib as unknown as Record<string, (...args: unknown[]) => unknown>, fs as unknown as Record<string, (...args: unknown[]) => unknown>];
  const originals = [[z, "gzipSync"], [z, "gunzipSync"], [f, "readFileSync"], [f, "openSync"]].map(([mod, name]) => [mod, name, (mod as typeof z)[name as string]] as const);
  let calls = 0;
  const reads: string[] = [];
  const isRotation = (path: unknown): boolean => /^ledger\..+\.ndjson(\.gz)?$/.test(basename(String(path)));
  for (const [mod, name, real] of originals) {
    (mod as typeof z)[name as string] = (...args: unknown[]) => {
      if (mod === z) calls += 1;
      else if (isRotation(args[0])) reads.push(String(args[0]));
      return (real as (...a: unknown[]) => unknown)(...args);
    };
  }
  syncBuiltinESMExports();
  return {
    zlibCalls: () => calls,
    rotationReads: () => reads,
    restore: () => {
      for (const [mod, name, real] of originals) (mod as typeof z)[name as string] = real as (...a: unknown[]) => unknown;
      syncBuiltinESMExports();
    },
  };
}

/** The ledger_compaction rows of a real daemon that runs `ticks` cycles with the given hooks. */
async function daemonRows(t: TestContext, deps: Partial<DaemonDeps>, ticks = 1): Promise<Array<{ step: string; extra?: Record<string, unknown> }>> {
  const plan = join(ownedFixtureDir(t, "ledger-off-loop-plan").dir, "tasks.yaml");
  writeFileSync(plan, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let stopChecks = 0;
  await runDaemon(loadPlan(plan), {
    refreshMerged: () => () => true,
    runOne: async () => { throw new Error("never"); },
    checkStop: () => (++stopChecks > ticks ? "bound" : undefined),
    sleep: async () => {},
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    ...deps,
  });
  return rows.filter((row) => row.step.startsWith("ledger_compaction"));
}

test("W1-T13333 criterion 1: the default hook starts the listed worker, and its pass leaves the archives and the report of an in-place pass", TIMEOUT, async (t) => {
  const build = (await import(pathToFileURL(join(REPO_ROOT, "scripts/build-child-entries.mjs")).href)) as { WORKER_ENTRIES: readonly string[] };
  assert.ok(build.WORKER_ENTRIES.includes(WORKER_MODULE), "the bundled daemon has a bundle for the worker");
  const fx = world(t);
  const copy = join(ownedFixtureDir(t, "ledger-off-loop-copy").dir, "state");
  cpSync(fx.stateDir, copy, { recursive: true });
  const direct = inPlace(copy);
  assert.deepEqual([direct.code, direct.errors], [0, []]);
  assert.deepEqual([direct.outcome?.sourceCount, direct.outcome?.rowsWritten, direct.outcome?.duplicatesCollapsed], [6, 26, 4]);

  const hooks = buildLedgerCompactionDaemonHooks({ config: fx.config });
  const { outcome, threads } = await countingThreads(async (started) => ({ outcome: await hooks.runLedgerCompaction(), threads: started() }));
  assert.equal(threads, 1, "the pass ran in one worker thread");
  assert.deepEqual(outcome, direct.outcome);
  assert.deepEqual(archives(fx.stateDir), archives(copy));
  assert.equal(archiveNames(fx.stateDir).length, 3, "the live ledger and one archive per day");
});

test("W1-T13333 criterion 2: invariant:no-compaction-work-on-the-loop — this thread calls no zlib, reads no rotation and its 20 ms timer fires through a held pass", TIMEOUT, async (t) => {
  const fx = world(t);
  const entry = workerAt(t, "gunzip", "hold");
  const hooks = buildLedgerCompactionDaemonHooks({ config: fx.config, worker: { workerUrl: entry.url } });
  let fires = 0;
  const timer = setInterval(() => { fires += 1; }, 20);
  const watch = watchThisThread();
  try {
    let settled = false;
    const pass = hooks.runLedgerCompaction().finally(() => { settled = true; });
    await until(() => existsSync(entry.held), () => settled);
    assert.equal(settled, false, "the pass is held in the worker, so it has not settled");
    const atHold = fires;
    // Fifty fires of a 20 ms timer span at least one second of the held pass.
    await until(() => fires - atHold >= 50, () => settled);
    assert.equal(settled, false, "the pass stayed held while the timer fired");
    assert.ok(fires - atHold >= 50, `the timer fired ${fires - atHold} times during the held pass`);
    entry.release();
    const outcome = await pass;
    assert.equal(outcome?.sourceCount, 6, "the held pass then compacted all six rotations");
    assert.equal(watch.zlibCalls(), 0, "no synchronous zlib call on the daemon thread");
    assert.deepEqual(watch.rotationReads(), [], "no rotation file read on the daemon thread");
  } finally {
    watch.restore();
    clearInterval(timer);
    entry.release();
  }
});

test("W1-T13333 criterion 3: invariant:no-row-lost-or-duplicated — a completed pass keeps every distinct row, adds no copy and moves each source to cold storage", TIMEOUT, async (t) => {
  const fx = world(t);
  const before = unionRows(fx.stateDir);
  const bytes = new Map(fx.sources.map((name) => [name, readFileSync(join(fx.stateDir, name))]));
  assert.equal(distinct(before).length, 27);
  assert.equal(before.length, 31, "the shared rows have copies before the pass");

  const outcome = await buildLedgerCompactionDaemonHooks({ config: fx.config }).runLedgerCompaction();
  assert.equal(outcome?.duplicatesCollapsed, 4);
  const after = unionRows(fx.stateDir);
  assert.deepEqual(distinct(after), distinct(before));
  for (const row of distinct(before)) assert.ok(copies(after, row) <= copies(before, row), `no more copies of ${row}`);
  assert.equal(after.length, 27);
  assert.deepEqual(coldFiles(fx.stateDir), [...fx.sources].sort(), "every merged source is in cold storage");
  for (const name of fx.sources) {
    assert.equal(existsSync(join(fx.stateDir, name)), false, `${name} left the state dir`);
    assert.deepEqual(readFileSync(join(fx.stateDir, LEDGER_COLD_STORE_DIRNAME, name)), bytes.get(name), `${name} was moved whole, not rewritten`);
  }
});

/** The real file system with one step that throws: the write of output `failWrite`, or the move of source `failMove` (both counted from 1). */
function cutFs(cut: { failWrite?: number; failMove?: number }): LedgerCompactFs {
  let [writes, moves] = [0, 0];
  return {
    readdirSync: (dir) => readdirSync(dir),
    readFileSync: (path) => readFileSync(path),
    existsSync: (path) => existsSync(path),
    writeAtomic: (path, content) => {
      if (++writes === cut.failWrite) throw new Error("fixture: the file writes stopped at an output");
      return writeAtomic(path, content, { tmpTag: "ledger-compact-tmp" });
    },
    rmSync: (path) => rmSync(path),
    gzipSync: (content) => gzipSync(content),
    gunzipSync: (content, options) => gunzipSync(content, options),
    sizeOf: (path) => statSync(path).size,
    mkdirSync: (dir) => void mkdirSync(dir, { recursive: true }),
    renameSync: (from, to) => {
      if (++moves === cut.failMove) throw new Error("fixture: the file writes stopped at a move");
      renameSync(from, to);
    },
    touch: (path, atMs) => utimesSync(path, atMs / 1000, atMs / 1000),
    mtimeMs: (path) => statSync(path).mtimeMs,
  };
}

test("W1-T13333 criterion 4: invariant:a-crash-leaves-a-readable-ledger — a pass cut before the outputs, before the moves or part-way through them is run_failed over a whole ledger", TIMEOUT, async (t) => {
  type Cut = { label: string; hooks: (fx: ReturnType<typeof world>) => ReturnType<typeof buildLedgerCompactionDaemonHooks>; held?: string; error: RegExp; outputs: number; moved: number };
  const ended = (step: Step): Pick<Cut, "hooks" | "held" | "error"> => {
    const entry = workerAt(t, step, "exit");
    return { hooks: (fx) => buildLedgerCompactionDaemonHooks({ config: fx.config, worker: { workerUrl: entry.url } }), held: entry.held, error: /^the ledger compaction worker exited with code 7 before it reported$/ };
  };
  const stopped = (cut: Parameters<typeof cutFs>[0]): Pick<Cut, "hooks" | "error"> => ({
    hooks: (fx) => buildLedgerCompactionDaemonHooks({ config: fx.config, compact: (rest, deps) => ledgerCompactCommand(rest, { ...deps, fs: cutFs(cut) }) }),
    error: /^rmd ledger-compact: apply failed — fixture: the file writes stopped at /,
  });
  // A pass held before its first output, which the parent terminates at its bound.
  const boundEntry = workerAt(t, "gunzip", "hold");
  const cuts: Cut[] = [
    { label: "terminated at the bound before any output", hooks: (fx) => buildLedgerCompactionDaemonHooks({ config: fx.config, worker: { workerUrl: boundEntry.url, boundMs: 1500 } }), error: /^the ledger compaction worker passed its 1500 ms bound$/, outputs: 0, moved: 0 },
    { label: "the worker ended before any output", ...ended("gzip"), outputs: 0, moved: 0 },
    { label: "the worker ended after the outputs and before the moves", ...ended("cold-dir"), outputs: 2, moved: 0 },
    { label: "the worker ended part-way through the moves", ...ended("second-move"), outputs: 2, moved: 1 },
    { label: "the writes stopped at the first output", ...stopped({ failWrite: 1 }), outputs: 0, moved: 0 },
    { label: "the writes stopped at the second output", ...stopped({ failWrite: 2 }), outputs: 1, moved: 0 },
    { label: "the writes stopped at the first move", ...stopped({ failMove: 1 }), outputs: 2, moved: 0 },
    { label: "the writes stopped at the third move", ...stopped({ failMove: 3 }), outputs: 2, moved: 2 },
  ];
  for (const cut of cuts) {
    const fx = world(t);
    const before = distinct(unionRows(fx.stateDir));
    const hooks = cut.hooks(fx);
    const rows = await daemonRows(t, { checkLedgerCompaction: () => FIRES, runLedgerCompaction: hooks.runLedgerCompaction });
    assert.deepEqual(rows.map((row) => row.step), ["ledger_compaction.fired", "ledger_compaction.run_failed"], `${cut.label}: never ledger_compaction.ran`);
    assert.match(String(rows[1]!.extra?.error), cut.error, cut.label);
    if (cut.held) assert.ok(existsSync(cut.held), `${cut.label}: the pass reached the step it was cut at`);
    // The cut landed where it says: so many outputs written, so many sources moved.
    assert.equal(archiveNames(fx.stateDir).length, 1 + 6 - cut.moved + cut.outputs, `${cut.label}: files in the state dir`);
    assert.equal(coldFiles(fx.stateDir).length, cut.moved, `${cut.label}: sources in cold storage`);
    // Every ledger file decompresses and parses, and the union read is whole.
    archives(fx.stateDir);
    assert.deepEqual(distinct(unionRows(fx.stateDir)), before, `${cut.label}: every earlier row is still read`);
  }
});

test("W1-T13333 criterion 5: invariant:a-new-rotation-is-untouched — an archive written during the pass is no source of it and keeps its bytes", TIMEOUT, async (t) => {
  // The output names of a pass over this fixture, from an in-place pass on a copy.
  const probe = world(t);
  assert.equal(inPlace(probe.stateDir).code, 0);
  const outputNames = archiveNames(probe.stateDir).filter((name) => name.endsWith(".gz"));
  assert.equal(outputNames.length, 2);
  const packed = (row: Record<string, unknown>): Buffer => gzipSync(Buffer.from(`${JSON.stringify(row)}\n`));
  const fresh = { name: rotationName(iso(Date.now())), bytes: packed({ ts: iso(Date.now() - 1000), step: "fixture.fresh" }) };
  const onOutput = { name: outputNames[0]!, bytes: packed({ ts: iso(BASE + 120_000), step: "fixture.landed-on-an-output-name" }) };

  // Written after the pass listed its sources and before it staged an output: both stay, and the pass completes beside them.
  {
    const fx = world(t);
    const before = distinct(unionRows(fx.stateDir));
    const entry = workerAt(t, "gunzip", "hold");
    let settled = false;
    const pass = buildLedgerCompactionDaemonHooks({ config: fx.config, worker: { workerUrl: entry.url } }).runLedgerCompaction().finally(() => { settled = true; });
    try {
      await until(() => existsSync(entry.held), () => settled);
      assert.equal(settled, false, "the pass is held after it listed its sources");
      for (const file of [fresh, onOutput]) writeFileSync(join(fx.stateDir, file.name), file.bytes);
    } finally {
      entry.release();
    }
    const outcome = await pass;
    assert.equal(outcome?.sourceCount, 6, "the pass merged the six rotations it listed, and no other");
    for (const file of [fresh, onOutput]) {
      assert.deepEqual(readFileSync(join(fx.stateDir, file.name)), file.bytes, `${file.name} has the same bytes`);
      assert.equal(coldFiles(fx.stateDir).includes(file.name), false, `${file.name} was not a source`);
    }
    assert.deepEqual(coldFiles(fx.stateDir), [...fx.sources].sort());
    assert.deepEqual(distinct(unionRows(fx.stateDir)), distinct([...before, ...linesOf(join(fx.stateDir, fresh.name)), ...linesOf(join(fx.stateDir, onOutput.name))]));
  }

  // Written on an output name after the outputs were checked and before one was written: the pass refuses and changes nothing.
  {
    const fx = world(t);
    const before = distinct(unionRows(fx.stateDir));
    const entry = workerAt(t, "gzip", "hold");
    let settled = false;
    const pass = buildLedgerCompactionDaemonHooks({ config: fx.config, worker: { workerUrl: entry.url } }).runLedgerCompaction().finally(() => { settled = true; });
    const refused = assert.rejects(pass, new RegExp(`apply failed — refusing to overwrite unselected archive .*${onOutput.name}$`));
    try {
      await until(() => existsSync(entry.held), () => settled);
      assert.equal(settled, false, "the pass is held before it writes an output");
      writeFileSync(join(fx.stateDir, onOutput.name), onOutput.bytes);
    } finally {
      entry.release();
    }
    await refused;
    assert.deepEqual(readFileSync(join(fx.stateDir, onOutput.name)), onOutput.bytes, "the archive was not overwritten");
    assert.deepEqual(coldFiles(fx.stateDir), [], "no source moved");
    assert.deepEqual(archiveNames(fx.stateDir), ["ledger.ndjson", ...fx.sources, onOutput.name].sort());
    assert.deepEqual(distinct(unionRows(fx.stateDir)), distinct([...before, ...linesOf(join(fx.stateDir, onOutput.name))]));
  }
});

test("W1-T13333 criterion 6: a failed worker rejects with the in-place error text, one pass runs at a time, each pass has its own worker, and the command runs in place", TIMEOUT, async (t) => {
  const js = (code: string): URL => new URL(`data:text/javascript,${encodeURIComponent(code)}`);
  const rejection = async (hooks: ReturnType<typeof buildLedgerCompactionDaemonHooks>): Promise<string> =>
    hooks.runLedgerCompaction().then(() => assert.fail("the pass must reject"), (error: Error) => error.message);

  // A non-zero exit code: one corrupt rotation, read by the real worker and then in place.
  const corrupt = world(t);
  writeFileSync(join(corrupt.stateDir, corrupt.sources[0]!), "not gzip");
  const config = corrupt.config;
  const nonZero = await rejection(buildLedgerCompactionDaemonHooks({ config }));
  assert.match(nonZero, /^rmd ledger-compact: cannot list or size eligible archives in /);
  assert.equal(nonZero, await rejection(buildLedgerCompactionDaemonHooks({ config, compact: ledgerCompactCommand })));
  assert.equal(inPlace(corrupt.stateDir).errors.join("\n"), nonZero);
  assert.deepEqual(coldFiles(corrupt.stateDir), [], "a failed pass moved nothing");

  // A throw, and an exit code 0 with no outcome report.
  const thrown = await rejection(buildLedgerCompactionDaemonHooks({ config, worker: { workerUrl: js('throw new Error("fixture: the pass threw")') } }));
  assert.equal(thrown, "fixture: the pass threw");
  assert.equal(thrown, await rejection(buildLedgerCompactionDaemonHooks({ config, compact: () => { throw new Error("fixture: the pass threw"); } })));
  const post = 'import { parentPort } from "node:worker_threads"; parentPort.postMessage({ kind: "started" }); parentPort.postMessage({ kind: "result", code: 0, errors: [] });';
  const silent = await rejection(buildLedgerCompactionDaemonHooks({ config, worker: { workerUrl: js(post) } }));
  assert.equal(silent, "rmd ledger-compact exited 0 without its required outcome report");
  assert.equal(silent, await rejection(buildLedgerCompactionDaemonHooks({ config, compact: () => 0 })));
  // A thread that ends with no report at all, and one that cannot start.
  assert.equal(await rejection(buildLedgerCompactionDaemonHooks({ config, worker: { workerUrl: js("process.exit(3)") } })), "the ledger compaction worker exited with code 3 before it reported");
  assert.equal(await rejection(buildLedgerCompactionDaemonHooks({ config, worker: { workerUrl: new URL("nope:not-a-worker") } })), "The URL must be of scheme file");

  // Two due passes on a real daemon: the second starts only after the first has reported, in a new worker.
  const fx = world(t);
  const entry = workerAt(t, "gunzip", "hold");
  const hooks = buildLedgerCompactionDaemonHooks({ config: fx.config, worker: { workerUrl: entry.url } });
  let [passes, inFlight, most] = [0, 0, 0];
  const runLedgerCompaction = async (): Promise<Outcome | undefined> => {
    passes += 1;
    most = Math.max(most, ++inFlight);
    try {
      return await hooks.runLedgerCompaction();
    } finally {
      inFlight -= 1;
    }
  };
  let turns = 0;
  const timer = setInterval(() => { turns += 1; }, 5);
  try {
    const { rows, threads } = await countingThreads(async (started) => {
      let ended = false;
      const daemon = daemonRows(t, { checkLedgerCompaction: () => FIRES, runLedgerCompaction }, 2).finally(() => { ended = true; });
      await until(() => existsSync(entry.held), () => ended);
      const atHold = turns;
      await until(() => turns - atHold >= 20, () => ended);
      assert.deepEqual([ended, passes, started()], [false, 1, 1], "the daemon waits on the pass in flight and starts no second one");
      entry.release();
      return { rows: await daemon, threads: started() };
    });
    assert.deepEqual(rows.map((row) => row.step), ["ledger_compaction.fired", "ledger_compaction.ran", "ledger_compaction.fired", "ledger_compaction.nothing_eligible"]);
    assert.deepEqual([passes, most, threads], [2, 1, 2], "two passes, never two at once, each in its own worker");
  } finally {
    clearInterval(timer);
    entry.release();
  }

  // The command line path: no thread, and the zlib work on the calling thread.
  const cli = world(t);
  const watch = watchThisThread();
  try {
    const threads = await countingThreads(async (started) => {
      assert.equal(ledgerCompactCommand(daemonLedgerCompactArgs(cli.stateDir), { stateDir: cli.stateDir, out: () => {}, error: () => {} }), 0);
      return started();
    });
    assert.equal(threads, 0, "rmd ledger-compact starts no worker");
    assert.ok(watch.zlibCalls() > 0, "rmd ledger-compact compacts on the calling thread");
  } finally {
    watch.restore();
  }
  assert.deepEqual(coldFiles(cli.stateDir), [...cli.sources].sort());
});
