import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createReadModelTicker, createReadModelWorker, READ_MODEL_SWITCH_RECHECK_MS, threadViews, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { shadowReadiness, viewShadowPath, withViewShadow } from "../src/lib/view-shadow.js";
import { readShadowCounters } from "../src/lib/view-shadow-store.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { trackWorkerThreads } from "../src/lib/worker-heaps.js";

async function until(done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), "real worker lanes produced the expected receipt");
}

function fixture(t: TestContext) {
  const dir = makeTempDir("shadow-owner");
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, `import { parentPort, workerData } from "node:worker_threads";
const lane = workerData.lane;
parentPort.on("message", (msg) => {
  if (msg.type === "shadow") parentPort.postMessage({ type: "log", step: "fixture.shadow", extra: { lane, view: msg.request.view, key: msg.request.key, requests: msg.request.requests, preparedBy: msg.request.paired?.legacy.data.lane, legacyOrigin: msg.request.legacy?.data.origin } });
  if (msg.type === "shadow-prepare") {
    const body = { view: msg.request.view, version: 1, generatedAt: new Date().toISOString(), asOf: null, stale: false, sources: [], data: { lane } };
    parentPort.postMessage({ type: "shadow_prepared", request: { ...msg.request, paired: { body, legacy: { data: { lane }, asOfMs: Date.now() } } } });
  }
  if (msg.type === "lane") parentPort.postMessage({ type: "log", step: "fixture.ready", extra: { lane, view: msg.view, instance: msg.instance, heavy: msg.heavy } });
  if (msg.type !== "want") return;
  if (msg.view === "move" && lane === "fast") {
    parentPort.postMessage({ type: "view_lane", view: "agent", heavy: true, dueAt: 0, costMs: 2000 });
    parentPort.postMessage({ type: "view_lane", view: "now", instance: "core", heavy: true, dueAt: 0, costMs: 2000 });
  }
  if (msg.view === "return-agent" && lane === "heavy") parentPort.postMessage({ type: "view_lane", view: "agent", heavy: false, dueAt: 0, costMs: 1 });
  if (msg.view === "die" && lane === "heavy") process.exit(3);
});
`);
  const book = trackWorkerThreads();
  const events: ReadModelWorkerMessage[] = [];
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const lanes = threadViews({
    data: { stateDir: dir, instances: [], tickMs: 50, holder: "fixture" },
    workerUrl: pathToFileURL(worker), relay: (message) => void events.push(message),
    log: (step, extra) => void logs.push({ step, extra: extra ?? {} }),
  });
  t.after(async () => {
    lanes.close();
    await book.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const rows = (step: string) => events.flatMap((message) => message.type === "log" && message.step === step ? [message.extra] : []);
  const ready = () => rows("fixture.ready").filter((row) => row.lane === "heavy" && row.heavy === true).length === 2;
  return { lanes, logs, rows, ready };
}

test("shadow owner: heavy legacy inputs return to one fast comparator", async (t) => {
  const f = fixture(t);
  f.lanes.want("move", "");
  await until(f.ready);
  const requests = [
    { view: "agent", key: "instance=core&part=history", requests: 1 },
    { view: "agent", key: "instance=console&part=proposals", requests: 2 },
    { view: "now", key: "instance=core", requests: 3 },
    { view: "now", key: "instance=site", requests: 4 },
    { view: "nav-badge", key: "", requests: 5 },
    { view: "agent", key: "instance=core&part=proposals", requests: 6, legacy: { data: { origin: "server" }, asOfMs: Date.now() } },
  ];
  for (const request of requests) f.lanes.shadow(request);
  await until(() => f.rows("fixture.shadow").length === requests.length);
  for (const [index, request] of requests.entries()) {
    const receipts = f.rows("fixture.shadow").filter((row) => row.requests === request.requests);
    assert.deepEqual(receipts, [{ lane: "fast", view: request.view, key: request.key, requests: request.requests, preparedBy: index < 3 ? "heavy" : undefined, legacyOrigin: index === 5 ? "server" : undefined }], "only the owning worker prepares legacy; all comparisons use one fast writer, and server-provided legacy is unchanged");
  }
});

test("shadow owner: hand-back and worker death keep single comparator", async (t) => {
  const f = fixture(t);
  f.lanes.want("move", "");
  await until(f.ready);
  const agent = { view: "agent", key: "instance=site&part=settings", requests: 1 };
  f.lanes.shadow(agent);
  await until(() => f.rows("fixture.shadow").length === 1);
  assert.deepEqual(f.rows("fixture.shadow"), [{ lane: "fast", ...agent, preparedBy: "heavy", legacyOrigin: undefined }]);

  f.lanes.want("return-agent", "");
  await until(() => f.logs.some((row) => row.step === "read_model.view_lane_moved" && row.extra.view === "agent" && row.extra.to === "fast"));
  f.lanes.shadow({ ...agent, requests: 2 });
  await until(() => f.rows("fixture.shadow").length === 2);
  assert.deepEqual(f.rows("fixture.shadow")[1], { lane: "fast", ...agent, requests: 2, preparedBy: undefined, legacyOrigin: undefined });

  f.lanes.want("die", "");
  await until(() => f.logs.some((row) => row.step === "read_model.view_lane_reclaimed" && row.extra.reason === "respawn"));
  const reclaimed = { view: "now", key: "instance=core", requests: 3 };
  f.lanes.shadow(reclaimed);
  await until(() => f.rows("fixture.shadow").length === 3);
  assert.deepEqual(f.rows("fixture.shadow")[2], { lane: "fast", ...reclaimed, preparedBy: undefined, legacyOrigin: undefined });
});

test("shadow owner: captured inputs stay paired and failed preparation grants no readiness", (t) => {
  const dir = makeTempDir("shadow-pair");
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "on", views: { paired: "shadow" } }));
  writeFileSync(join(dir, "ledger.ndjson"), JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T1", run_id: "fixture" }) + "\n");
  let value = 1;
  let fail = false;
  const events: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], holder: "pair-fixture", oracle: "off",
    views: [{ name: "paired", version: 1, materialize: () => [{ key: "instance=core", data: { value }, sources: [] }], legacy: (_key, now, data) => {
      if (fail) throw Error("fixture preparation failed");
      return { data, asOfMs: now };
    } }], post: (message) => void events.push(message),
  });
  t.after(() => { ticker.release(); rmSync(dir, { recursive: true, force: true }); });
  ticker.start();
  ticker.tick();
  const request = { view: "paired", key: "instance=core", requests: 1 };
  const prepared = ticker.prepareShadow(request);
  assert.ok(prepared?.paired);
  assert.deepEqual(prepared.paired.body.data, { value: 1 });
  assert.equal(existsSync(viewShadowPath(dir)), false, "preparation never opens a second comparator store");
  value = 2;
  ticker.buildNow("paired");
  assert.equal(ticker.shadow(prepared), true, "compare the captured body, not the peer's newer body");
  const persisted = () => readShadowCounters(viewShadowPath(dir), true)!.states;
  const bytes = JSON.stringify(persisted());
  const state = persisted().paired!;
  assert.equal(state.samples, 1);
  assert.equal(state.diffs.real, 0);
  assert.equal(shadowReadiness("paired", state, Date.now()).ready, false, "one matching sample never waives the sustained readiness guard");
  assert.equal(ticker.prepareShadow({ ...request, key: "instance=missing" }), undefined);
  fail = true;
  assert.equal(ticker.prepareShadow(request), undefined);
  assert.ok(events.some((message) => message.type === "log" && message.step === "view.shadow_failed"));
  assert.equal(JSON.stringify(persisted()), bytes, "missing and failed preparation cannot manufacture a sample");
});

test("shadow owner: native heavy worker accrues parity for unchanged values without promoting", async (t) => {
  const dir = makeTempDir("shadow-native-owner");
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "on", views: { "paired-worker": "auto" } }));
  writeFileSync(join(dir, "ledger.ndjson"), JSON.stringify({ ts: new Date().toISOString(), step: "run.start", task_id: "W1-T1", run_id: "fixture" }) + "\n");
  const modulePath = join(dir, "views.mjs");
  const marks = join(dir, "marks.ndjson");
  writeFileSync(modulePath, `import { appendFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
const mark = (stage, owned) => appendFileSync(${JSON.stringify(marks)}, JSON.stringify({ stage, owned, lane: workerData.lane }) + "\\n");
const owned = new WeakSet();
export default [{ name: "paired-worker", version: 1, materialize: () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  const data = { value: 1 };
  owned.add(data);
  mark("build", true);
  return [{ key: "", data, sources: [] }];
}, legacy: (_key, now, data) => {
  mark("legacy", owned.has(data));
  return owned.has(data) ? { data, asOfMs: now } : undefined;
} }];
`);
  const book = trackWorkerThreads();
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const timers = new Map<number, () => void>();
  const worker = createReadModelWorker({
    stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], viewsModule: pathToFileURL(modulePath).href,
    log: (step, extra) => void logs.push({ step, extra: extra ?? {} }),
    every: (run, ms) => { timers.set(ms, run); return () => void timers.delete(ms); },
  });
  let sent = 0;
  t.after(async () => {
    t.diagnostic(JSON.stringify(logs.filter((row) => row.extra.view === "paired-worker" || /failed|exited/.test(row.step)).slice(-15)));
    t.diagnostic(JSON.stringify({ sent, switches: worker.switches(), body: worker.body("paired-worker")?.body.data, marks: existsSync(marks) ? readFileSync(marks, "utf8").trim().split("\n").slice(-15) : [] }));
    worker.stop(); await book.stop(); rmSync(dir, { recursive: true, force: true });
  });
  worker.start();
  const state = () => {
    try { return readShadowCounters(viewShadowPath(dir), true)?.states["paired-worker"]; }
    catch (error) {
      // A reader can see the new SQLite file before its first schema transaction commits.
      // This is UNKNOWN, never an old receipt or a sample. Wait for the real committed control.
      if ((error as { code?: string }).code === "ERR_SQLITE_ERROR" && /no such table: meta/.test(String(error))) return undefined;
      throw error;
    }
  };
  // Native threads load the application under the flake screen's CPU contention before building.
  await until(() => logs.some((row) => row.step === "read_model.view_lane_moved" && row.extra.view === "paired-worker" && row.extra.to === "heavy"), 60_000);
  await until(() => existsSync(marks) && readFileSync(marks, "utf8").includes('"lane":"heavy"'), 60_000);
  // Attach the real sampler once the heavy reader exists: an earlier cold sample is held for its minute.
  withViewShadow({ shadow: (request) => { sent++; worker.shadow(request); }, driveShadow: (sample) => worker.driveShadow(sample) }, { readModel: worker, legacy: [] });
  const drive = timers.get(READ_MODEL_SWITCH_RECHECK_MS);
  assert.ok(drive, "the real handle registered its shadow driver");
  drive();
  await until(() => (state()?.samples ?? 0) > 0, 60_000);
  assert.equal(sent, 1, "one driver offer produces one comparison without a request");
  assert.equal(state().samples, 1);
  assert.equal(state().requests, 0);
  assert.equal(state().diffs.real, 0);
  assert.equal(shadowReadiness("paired-worker", state(), Date.now()).ready, false);
  assert.equal(worker.autoMode?.("paired-worker"), "shadow");
  assert.deepEqual(worker.body("paired-worker")?.body.data, { value: 1 });
  assert.equal(logs.some((row) => row.step === "view.auto_promoted"), false, "actual default workers preserve the sustained readiness gate");
});
