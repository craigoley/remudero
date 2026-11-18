import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { procSelfThreads, SERVE_THREAD_LOAD_STEP, startServeThreadLoad, type ServeThreadLoadRow } from "#src/lib/serve-thread-load.js";
import { THREAD_NAMES } from "#src/lib/thread-names.js";
import { withTempDir } from "#src/lib/tmp.js";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

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

test("W1-T13441 criterion 2: by default the sampler reads this process's real /proc and lists main among its OS threads", { skip: process.platform !== "linux" }, async (t) => {
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const load = startServeThreadLoad({ workers: () => [], intervalMs: 30, log: (step, extra) => void rows.push({ step, ...extra }) });
  t.after(() => load.stop());
  for (let i = 0; i < 300 && !rows.some((r) => r.step === SERVE_THREAD_LOAD_STEP); i++) await settle();
  const row = rows.find((r) => r.step === SERVE_THREAD_LOAD_STEP) as unknown as ServeThreadLoadRow;
  assert.ok(row, "a real row landed");
  assert.equal(row.os_threads_error, undefined);
  const names = row.os_threads!.map((thread) => thread.name);
  assert.ok(names.length >= 2 && names.some((name) => /^(MainThread|node)$/.test(name)), names.join(", "));
});
