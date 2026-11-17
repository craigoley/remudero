import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { clockFromMillisFn } from "#src/lib/clock.js";
import {
  procSelfThreads, SERVE_THREAD_LOAD_SAMPLE_MS, SERVE_THREAD_LOAD_STEP, startServeThreadLoad,
  type OsThreadCpu, type ServeThreadLoadRow,
} from "#src/lib/serve-thread-load.js";
import { OS_THREAD_NAME_MAX, THREAD_NAMES } from "#src/lib/thread-names.js";
import { withTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = { step: string } & Record<string, unknown>;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/** A sampler whose OS-thread reads come from `reads` in order; a function entry throws. */
function osSampler(reads: Array<ReadonlyMap<string, OsThreadCpu> | (() => never)>) {
  let now = 0, at = 0, run: () => void = () => {};
  const rows: Row[] = [];
  const handle = { unref: () => handle } as unknown as ReturnType<typeof setInterval>;
  const load = startServeThreadLoad({
    workers: () => [], clock: clockFromMillisFn(() => now),
    setInterval: ((fn: () => void) => { run = fn; return handle; }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
    mainCpu: () => ({ user: 0, system: 0 }), observeGc: () => () => {},
    osThreads: () => { const next = reads[Math.min(at++, reads.length - 1)]!; return typeof next === "function" ? next() : next; },
    log: (step, extra) => void rows.push({ step, ...extra }),
  });
  return {
    load,
    minute: async (): Promise<ServeThreadLoadRow> => { now += SERVE_THREAD_LOAD_SAMPLE_MS; run(); await settle(); return rows.filter((r) => r.step === SERVE_THREAD_LOAD_STEP).at(-1) as unknown as ServeThreadLoadRow; },
  };
}
const threads = (entries: Array<[string, string, number]>): Map<string, OsThreadCpu> => new Map(entries.map(([tid, name, cpu_ms]) => [tid, { name, cpu_ms }]));

test("W1-T13441 criterion 1: every worker thread name is unique and fits the OS's 15-byte thread name", () => {
  const names = Object.values(THREAD_NAMES);
  assert.ok(names.length >= 20, `positive control: the registry holds the spawn sites (${names.length})`);
  assert.equal(new Set(names).size, names.length, "two spawn sites sharing a name would share one line");
  for (const name of names) assert.ok(Buffer.byteLength(name) <= OS_THREAD_NAME_MAX, `${name} is cut by the OS`);
});

test("W1-T13441 criterion 1: every worker spawn site in src passes a name from threadName()", () => {
  const files = execFileSync("git", ["grep", "-lE", "new Worker\\(|startWorker\\(", "--", "src"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().split("\n");
  // The two forwarders hand on the caller's options (and with them its name); they are not spawn sites of their own.
  const forwarders = /\(url: string \| URL, workerOptions: WorkerOptions\) => new Worker\(url, workerOptions\)|\(url, options\) => new Worker\(url, options\)/;
  let sites = 0;
  const unnamed: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of text.matchAll(/new Worker\(|startWorker\(/g)) {
      const line = text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index));
      if (/^\s*(\*|\/\/|\/\*\*)/.test(line) || /function startWorker\(/.test(line) || forwarders.test(line)) continue;
      sites += 1;
      const named = /name: (threadName\("\w+"\)|given\.name|"([\w-]+)")/.exec(text.slice(match.index, match.index + 600));
      // A literal name (a module in the baked supervisor's closure cannot import thread-names.ts) must be a registered one.
      if (!named || (named[2] !== undefined && !Object.values(THREAD_NAMES).includes(named[2] as never))) unnamed.push(`${file}: ${line.trim().slice(0, 140)}`);
    }
  }
  assert.ok(sites >= 20, `positive control: the census saw the spawn sites (${sites})`);
  assert.deepEqual(unnamed, [], "an unnamed worker reads WorkerThread in /proc and is lumped with every other unnamed one");
});

test("W1-T13441 criterion 1: on the real runtime a worker's name reaches its OS thread, nested ones included", { skip: process.platform !== "linux" }, async (t) => {
  const nested = `const { Worker } = require("node:worker_threads"); new Worker("require('node:worker_threads').parentPort; setTimeout(() => {}, 30000)", { eval: true, name: ${JSON.stringify(THREAD_NAMES.readModelTxnWriter)} }); require("node:worker_threads").parentPort.postMessage("up"); setTimeout(() => {}, 30000);`;
  const outer = new Worker(nested, { eval: true, name: THREAD_NAMES.readModelViews });
  t.after(() => outer.terminate());
  await new Promise((resolve) => outer.once("message", resolve));
  let names: string[] = [];
  for (let i = 0; i < 200 && !names.includes(THREAD_NAMES.readModelTxnWriter); i++) {
    names = [...procSelfThreads().values()].map((thread) => thread.name);
    await settle();
  }
  assert.ok(names.includes(THREAD_NAMES.readModelViews), `the named worker's OS thread: ${names.join(", ")}`);
  assert.ok(names.includes(THREAD_NAMES.readModelTxnWriter), `the nested worker's OS thread: ${names.join(", ")}`);
  for (const thread of procSelfThreads().values()) assert.ok(Number.isFinite(thread.cpu_ms) && thread.cpu_ms >= 0, JSON.stringify(thread));
});

test("W1-T13441 criterion 2: serve.thread_load's os_threads sums every OS thread's CPU over the window by name, hottest first", async () => {
  const s = osSampler([
    threads([["1", "MainThread", 1_000], ["2", "rmd-rm-views", 500], ["3", "WorkerThread", 10], ["4", "V8Worker", 100], ["5", "V8Worker", 100]]),
    // A minute later: views burned 32.4 s, a new nested thread started, one V8Worker ended (its tail is lost, never invented).
    threads([["1", "MainThread", 13_000], ["2", "rmd-rm-views", 32_900], ["3", "WorkerThread", 610], ["4", "V8Worker", 1_300], ["6", "rmd-rm-txn-wrtr", 120]]),
  ]);
  const row = await s.minute();
  assert.deepEqual(row.os_threads, [
    { name: "rmd-rm-views", tids: 1, cpu_ms: 32_400, cpu_share: 0.54 },
    { name: "MainThread", tids: 1, cpu_ms: 12_000, cpu_share: 0.2 },
    { name: "V8Worker", tids: 1, cpu_ms: 1_200, cpu_share: 0.02 },
    { name: "WorkerThread", tids: 1, cpu_ms: 600, cpu_share: 0.01 },
    { name: "rmd-rm-txn-wrtr", tids: 1, cpu_ms: 120, cpu_share: 0.002 },
  ]);
  s.load.stop();
});

test("W1-T13441 criterion 2: a tid reused under another name counts from its own start, and an unreadable /proc is named on the row", async () => {
  const s = osSampler([
    threads([["9", "rmd-plan-reload", 400]]),
    threads([["9", "rmd-repo-telem", 50]]),
    () => { throw new Error("ENOENT: /proc/self/task"); },
  ]);
  assert.deepEqual((await s.minute()).os_threads, [{ name: "rmd-repo-telem", tids: 1, cpu_ms: 50, cpu_share: 0.0008 }]);
  const blind = await s.minute();
  assert.equal(blind.os_threads, undefined, "never read as no threads");
  assert.equal(blind.os_threads_error, "ENOENT: /proc/self/task");
  s.load.stop();
});

test("W1-T13441 criterion 2: procSelfThreads reads comm and user+system ticks, and skips a thread gone mid-read or a malformed stat", async () => {
  await withTempDir("os-threads", async (root) => {
    const stat = (comm: string, utime: number, stime: number): string =>
      `42 (${comm}) S 1 1 1 0 -1 4194304 10 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 100 0 0`;
    mkdirSync(join(root, "100")); writeFileSync(join(root, "100", "stat"), stat("MainThread", 250, 50));
    mkdirSync(join(root, "101")); writeFileSync(join(root, "101", "stat"), stat("rmd (odd) name", 7, 3));
    mkdirSync(join(root, "102")); // ended between the listing and the read: no stat file
    mkdirSync(join(root, "103")); writeFileSync(join(root, "103", "stat"), "garbage without a comm");
    assert.deepEqual([...procSelfThreads(root)], [
      ["100", { name: "MainThread", cpu_ms: 3_000 }],
      ["101", { name: "rmd (odd) name", cpu_ms: 100 }],
    ]);
  });
});

test("W1-T13441 criterion 2: by default the sampler reads this process's real /proc and lists main among its OS threads", { skip: process.platform !== "linux" }, async (t) => {
  const rows: Row[] = [];
  const load = startServeThreadLoad({ workers: () => [], intervalMs: 30, log: (step, extra) => void rows.push({ step, ...extra }) });
  t.after(() => load.stop());
  for (let i = 0; i < 300 && !rows.some((r) => r.step === SERVE_THREAD_LOAD_STEP); i++) await settle();
  const row = rows.find((r) => r.step === SERVE_THREAD_LOAD_STEP) as unknown as ServeThreadLoadRow;
  assert.ok(row, "a real row landed");
  assert.equal(row.os_threads_error, undefined);
  const names = row.os_threads!.map((thread) => thread.name);
  assert.ok(names.length >= 2 && names.some((name) => /^(MainThread|node)$/.test(name)), names.join(", "));
});
