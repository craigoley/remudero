import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import {
  SERVE_THREAD_LOAD_SAMPLE_MS, SERVE_THREAD_LOAD_STEP, startServeThreadLoad,
  type OsThreadCpu, type ServeThreadLoadRow,
} from "#src/lib/serve-thread-load.js";
import { OS_THREAD_NAME_MAX, THREAD_NAMES } from "#src/lib/thread-names.js";
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
