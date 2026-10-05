import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createReadModelWorker, threadOracle, threadViews } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { LIVE_WRITE_SENTINEL_TOKEN } from "../src/lib/live-write-guard.js";

// 2026-10-04: a worker thread gets a COPY of process.env unless it is spawned with SHARE_ENV, so it
// keeps the GH_TOKEN it was born with while serve refreshes its own hourly (github-app.ts). The
// read-plane worker 401'd from 20:10:41Z for exactly this (#9156); the read-model projector files
// stall escalations and its oracle files drift escalations through GitHub, so both 401 the same way.
// Each thread re-runs the runner's setup through execArgv, which rewrites GH_TOKEN to the no-live
// sentinel, so the refresh is written only once a thread has answered: its setup has run by then.

const REFRESHED = "token-refreshed-an-hour-later";
const thread = (body: string): URL => new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from "node:worker_threads";\n${body}`)}`);

async function until(seen: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!seen() && Date.now() < deadline) await sleep(10);
}

function restoreToken(t: { after: (fn: () => void) => void }): void {
  const saved = process.env.GH_TOKEN;
  t.after(() => {
    if (saved === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved;
  });
}

test("the read-model projector thread reads serve's refreshed GH_TOKEN, not the one it was spawned with", async (t) => {
  const stateDir = makeTempDir("rmw-token");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  restoreToken(t);
  const seen: unknown[] = [];
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], stopWaitMs: 20,
    workerUrl: thread(`setInterval(() => parentPort.postMessage({ type: "log", step: "token", extra: { token: process.env.GH_TOKEN ?? "" } }), 10);`),
    log: (step, extra) => void (step === "token" && seen.push(extra?.token)),
  });
  handle.start();
  t.after(() => void handle.stop());
  await until(() => seen.length > 0);
  assert.ok(seen.length > 0, "the thread answered before the refresh");
  process.env.GH_TOKEN = REFRESHED;
  await until(() => seen.at(-1) === REFRESHED, 3_000);
  assert.equal(seen.at(-1), REFRESHED);
});

test("the read-model oracle thread reads its spawner's refreshed GH_TOKEN, not the one it was spawned with", async (t) => {
  restoreToken(t);
  const oracle = threadOracle({
    workerUrl: thread(`parentPort.on("message", (m) => parentPort.postMessage({ type: "done", id: m.id, result: { ok: false, error: process.env.GH_TOKEN ?? "", leaseLost: false } }));`),
    log: () => {},
  });
  t.after(() => oracle.close());
  const ask = (): Promise<string> => new Promise((resolve) => oracle.run({} as never, (result) => resolve(result.ok ? "" : result.error)));
  await ask();
  process.env.GH_TOKEN = REFRESHED;
  assert.equal(await ask(), REFRESHED);
});

test("the read-model view thread reads its spawner's refreshed GH_TOKEN, not the one it was spawned with", async (t) => {
  restoreToken(t);
  const seen: unknown[] = [];
  const lane = threadViews({
    data: { stateDir: "/nonexistent", instances: [], tickMs: 10, holder: "test" },
    workerUrl: thread(`parentPort.on("message", () => parentPort.postMessage({ type: "log", step: "token", extra: { token: process.env.GH_TOKEN ?? "" } }));`),
    relay: (msg) => void (msg.type === "log" && seen.push(msg.extra.token)),
    log: () => {},
    every: () => () => {},
  });
  t.after(() => lane.close());
  lane.want("x", "");
  await until(() => seen.length === 1);
  assert.equal(seen.length, 1, "the thread answered before the refresh");
  process.env.GH_TOKEN = REFRESHED;
  lane.want("x", "");
  await until(() => seen.length === 2);
  assert.equal(seen[1], REFRESHED);
});

// SHARE_ENV makes a thread's env the parent's, and each thread re-runs the runner's setup: a thread
// that minted its own HOME or appended GIT_CONFIG_* entries would write them into the parent test.
test("a read-model thread re-running the test setup leaves the parent's HOME and GIT_CONFIG_COUNT alone", async (t) => {
  restoreToken(t);
  const home = process.env.HOME;
  const count = process.env.GIT_CONFIG_COUNT;
  process.env.GH_TOKEN = "set-by-the-parent";
  const oracle = threadOracle({
    workerUrl: thread(`parentPort.on("message", (m) => parentPort.postMessage({ type: "done", id: m.id, result: { ok: true, rows: 0, elapsedMs: 0 } }));`),
    log: () => {},
  });
  t.after(() => oracle.close());
  await new Promise<void>((resolve) => oracle.run({} as never, () => resolve()));
  // Positive control: the thread ran the setup, and its writes reached this env.
  assert.equal(process.env.GH_TOKEN, LIVE_WRITE_SENTINEL_TOKEN);
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.GIT_CONFIG_COUNT, count);
});
