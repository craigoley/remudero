import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "../src/lib/ledger-projector.js";
import { READ_MODEL_LEASE_TTL_MS, currentReadModelPath, openReadModel, peekLease } from "../src/lib/read-model-db.js";
import {
  READ_MODEL_STALL_MS,
  createReadModelTicker,
  createReadModelWorker,
  readModelStatusView,
  runReadModelViewWorker,
  threadViews,
  type ReadModelInstanceState,
  type ReadModelViewsInput,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const LIVE = "ledger.ndjson";

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

function row(ms: number, runId: string): string {
  return `${JSON.stringify({ ts: new Date(ms).toISOString(), step: "run.start", task_id: "W1-T1", run_id: runId })}\n`;
}

async function until(done: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(10);
  assert.ok(done(), what);
}

function moduleFile(t: TestCtx, kind: string, source: string): URL {
  const path = join(scratch(t, kind), "module.mjs");
  writeFileSync(path, source);
  return pathToFileURL(path);
}

/** A projector with no views, as the read-model worker runs it, and the states it posts. */
function projectorOf(stateDir: string, instances: Array<{ name: string; ledgerDir: string }>, clock: Clock) {
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances, clock, holder: "proj-holder", views: [], oracle: "off", post: (m) => void posted.push(m) });
  ticker.start();
  ticker.tick();
  const states = (): ReadModelInstanceState[] => {
    const last = posted.findLast((m) => m.type === "state");
    return last?.type === "state" ? last.instances : [];
  };
  return { ticker, states };
}

test("a six minute view build neither stalls projection nor silences the read-model worker", async (t) => {
  const stateDir = scratch(t, "slowview-state");
  const ledgerDir = scratch(t, "slowview-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(Date.now(), "boot"));
  const marks = join(scratch(t, "slowview-marks"), "marks.txt");
  // The watchdog's clock runs 30 times real time, so a 12 s build is 6 minutes to it.
  const scale = 30;
  const blockMs = 12_000;
  const viewsModule = moduleFile(t, "slowview-module", `import { appendFileSync } from "node:fs";
export default [{ name: "slow", version: 1, materialize: () => {
  appendFileSync(${JSON.stringify(marks)}, "start " + Date.now() + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
  appendFileSync(${JSON.stringify(marks)}, "end " + Date.now() + "\\n");
  return [{ key: "", data: { built: true }, sources: [] }];
} }];
`).href;
  const base = Date.now();
  const scaled: Clock = { now: () => base + (Date.now() - base) * scale, date: () => new Date(scaled.now()), iso: () => new Date(scaled.now()).toISOString() };
  const logs: string[] = [];
  const states: Array<{ at: number; newestTs: string | null }> = [];
  let watch: (() => void) | undefined;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 20, clock: scaled, viewsModule,
    log: (step) => void logs.push(step), every: (run) => ((watch = run), () => undefined),
    observe: (m) => void (m.type === "state" && states.push({ at: Date.now(), newestTs: m.instances[0]?.newestTs ?? null })),
  });
  t.after(() => handle.stop());
  handle.start();
  await until(() => states.some((s) => s.newestTs !== null), "the projector applied the boot row");
  const appended: Array<{ at: number; ts: string }> = [];
  const deadline = Date.now() + blockMs + 30_000;
  while (handle.body("slow") === undefined && Date.now() < deadline) {
    const ts = new Date().toISOString();
    appendFileSync(join(ledgerDir, LIVE), row(Date.parse(ts), `during-${appended.length}`));
    appended.push({ at: Date.now(), ts });
    watch?.();
    await sleep(50);
  }
  watch?.();
  assert.deepEqual(logs.filter((step) => /worker_(silent|recycled|exited)/.test(step)), [], "the watchdog never saw the worker go silent");
  assert.ok(handle.body("slow"), "the slow view finished its build");
  const [start, end] = readFileSync(marks, "utf8").trim().split("\n").slice(0, 2).map((line) => Number(line.split(" ")[1]));
  assert.ok(end! - start! >= blockMs, `the build held its thread ${end! - start!} ms`);
  assert.ok(((end! - start!) * scale) >= 6 * 60_000, "six minutes or more on the watchdog's clock");
  const during = states.filter((s) => s.at > start! && s.at < end!);
  const gaps = during.slice(1).map((s, i) => s.at - during[i]!.at);
  assert.ok(during.length >= 20, `${during.length} projector states arrived during the build`);
  assert.ok(Math.max(...gaps) * scale < READ_MODEL_STALL_MS, `the longest silence during the build was ${Math.max(...gaps)} ms`);
  const mid = appended.find((a) => a.at > start! + 2_000 && a.at < end! - 4_000);
  assert.ok(mid, "a row was appended in the middle of the build");
  assert.ok(during.some((s) => s.newestTs !== null && s.newestTs >= mid.ts && s.at < end!), "the row appended mid-build was projected before the build ended");
});

test("the view thread writes bodies under the projector lease only while the projector's word is fresh", (t) => {
  const stateDir = scratch(t, "slowview-lease-state");
  const ledgerDir = scratch(t, "slowview-lease-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(T0, "r1"));
  const hand = handClock(T0 + 1_000);
  const projector = projectorOf(stateDir, [{ name: "core", ledgerDir }], hand.clock);
  t.after(() => projector.ticker.release());
  const posted: ReadModelWorkerMessage[] = [];
  const views = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "proj-holder", views: [readModelStatusView], viewsOnly: true, oracle: "off", post: (m) => void posted.push(m) });
  t.after(() => views.release());
  views.start();
  views.tick();
  assert.equal(posted.length, 0, "nothing is built or posted before the projector's first word");

  views.observe(projector.states());
  views.tick();
  assert.deepEqual(posted.filter((m) => m.type === "view_unit").map((m) => m.type === "view_unit" && m.phase), ["start", "end"]);
  const body = posted.find((m) => m.type === "body");
  assert.ok(body?.type === "body" && body.entry.view === "read-model");
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true });
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM view_body").get()?.n), 1, "the body was persisted under the projector's lease");
  db.close();
  const sample = { view: "read-model", key: "", requests: 1, legacy: { data: { instances: [] }, asOfMs: T0 } };
  assert.equal(views.shadow(sample), true, "a fresh lease lets the comparator write");

  hand.advance(READ_MODEL_LEASE_TTL_MS);
  views.tick();
  assert.equal(views.shadow(sample), false, "a projector silent for a lease TTL leaves the view thread unable to write");
  assert.equal(views.release(), 0, "the view thread never releases the projector's lease");
  assert.equal(peekLease(currentReadModelPath(stateDir, "core", LEDGER_PROJECTOR_SCHEMA_VERSION))?.holder, "proj-holder");
});

test("a views-only ticker reattaches after its file is swapped and logs an unattachable store once", (t) => {
  const stateDir = scratch(t, "slowview-swap-state");
  const coreDir = scratch(t, "slowview-swap-core");
  const siteDir = scratch(t, "slowview-swap-site");
  writeFileSync(join(coreDir, LIVE), row(T0, "c1"));
  writeFileSync(join(siteDir, LIVE), row(T0, "s1"));
  const hand = handClock(T0 + 1_000);
  const instances = [{ name: "core", ledgerDir: coreDir }, { name: "site", ledgerDir: siteDir }];
  const projector = projectorOf(stateDir, instances, hand.clock);
  const states = projector.states();
  projector.ticker.release();
  // With the projector gone nothing may be persisted, so the views only build and post.
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ projector: "off", views: {} }));
  const posted: ReadModelWorkerMessage[] = [];
  const views = createReadModelTicker({ stateDir, instances, clock: hand.clock, holder: "proj-holder", views: [readModelStatusView], viewsOnly: true, oracle: "off", post: (m) => void posted.push(m) });
  t.after(() => views.release());
  views.observe(states);
  views.tick();
  const steps = (): string[] => posted.flatMap((m) => (m.type === "log" ? [`${m.step}:${m.extra.instance}`] : []));
  assert.deepEqual(steps(), []);

  // A rebuild renames a new file over the path; the view thread follows it.
  const path = currentReadModelPath(stateDir, "core", LEDGER_PROJECTOR_SCHEMA_VERSION);
  copyFileSync(path, `${path}.next`);
  renameSync(`${path}.next`, path);
  writeFileSync(join(stateDir, "read-model", `site.v${LEDGER_PROJECTOR_SCHEMA_VERSION}.current`), "not-a-generation\n");
  hand.advance(1_000);
  views.observe(states);
  views.tick();
  views.tick();
  assert.deepEqual(steps(), ["read_model.reopened:core", "read_model.view_attach_failed:site"], "the swap is followed and the bad pointer logged once");
  assert.ok(existsSync(path));
  assert.ok(posted.some((m) => m.type === "body" && m.entry.view === "read-model"), "the other views still build");
});

test("the view lane relays the thread's messages and reports a build that outlasts the stall bound without killing it", async (t) => {
  const workerUrl = moduleFile(t, "slowview-lane", `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "log", step: "fake.hello", extra: {} });
parentPort.postMessage({ type: "view_unit", view: "now", instance: "core", phase: "start" });
parentPort.on("message", (msg) => {
  parentPort.postMessage({ type: "log", step: "fake.got", extra: { type: msg.type } });
  if (msg.type === "bodies") parentPort.postMessage({ type: "view_unit", view: "now", phase: "end" });
});
setInterval(() => {}, 1000);
`);
  const hand = handClock(T0);
  const relayed: string[] = [];
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let watch: (() => void) | undefined;
  const lane = threadViews({
    data: { stateDir: "/nonexistent", instances: [], tickMs: 5, holder: "h" }, workerUrl, clock: hand.clock,
    relay: (m) => void relayed.push(m.type === "log" ? `${m.step}${m.extra.type ? `:${m.extra.type}` : ""}` : m.type),
    log: (step, extra) => void logs.push({ step, extra }), every: (run) => ((watch = run), () => undefined),
  });
  t.after(() => lane.close());
  await until(() => relayed.includes("fake.hello"), "the thread's log was relayed");
  await sleep(50);
  watch?.();
  hand.advance(READ_MODEL_STALL_MS);
  watch?.();
  watch?.();
  assert.deepEqual(logs.map((l) => [l.step, l.extra.view, l.extra.instance, l.extra.ms]), [["read_model.view_build_long", "now", "core", READ_MODEL_STALL_MS]], "a long build is reported once");
  lane.state([]);
  lane.shadow({ view: "now", key: "", requests: 1 });
  lane.accept({ view: "inbox", version: 1, bodies: [] });
  await until(() => relayed.includes("fake.got:bodies"), "every input reached the thread");
  assert.deepEqual(relayed.filter((r) => r.startsWith("fake.got")), ["fake.got:state", "fake.got:shadow", "fake.got:bodies"]);
  assert.ok(!relayed.includes("view_unit"), "the thread's heartbeat is read by the lane, never relayed to serve");
  hand.advance(READ_MODEL_STALL_MS);
  watch?.();
  assert.equal(logs.length, 1, "a finished build is not reported");
  lane.close();
  await until(() => relayed.includes("fake.got:stop"), "close asks the thread to stop");
});

test("a view thread that dies is respawned with a doubling back-off", async (t) => {
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const lane = threadViews({
    data: { stateDir: "/nonexistent", instances: [], tickMs: 5, holder: "h" }, workerUrl: new URL("data:text/javascript,throw new Error('views boom')"),
    relay: () => {}, log: (step, extra) => void logs.push({ step, extra }),
  });
  t.after(() => lane.close());
  await until(() => logs.filter((l) => l.step === "read_model.views_exited").length >= 2, "two deaths");
  lane.close();
  assert.deepEqual(logs.filter((l) => l.step === "read_model.views_exited").slice(0, 2).map((l) => [l.extra.deaths, l.extra.respawnInMs]), [[1, 10], [2, 20]]);
  assert.match(String(logs.find((l) => l.step === "read_model.views_failed")?.extra.error), /views boom/);
});

function fakePort() {
  let onMessage: ((msg: ReadModelViewsInput) => void) | undefined;
  const posted: ReadModelWorkerMessage[] = [];
  let closed = 0;
  return {
    port: { on: (_event: "message", run: (msg: ReadModelViewsInput) => void) => void (onMessage = run), postMessage: (m: unknown) => void posted.push(m as ReadModelWorkerMessage), close: () => void closed++ },
    send: (msg: ReadModelViewsInput) => onMessage?.(msg),
    posted,
    closed: () => closed,
  };
}

test("the view thread body builds the extra views it loads and answers shadow and slow-lane inputs", async (t) => {
  const stateDir = scratch(t, "slowview-body-state");
  const ledgerDir = scratch(t, "slowview-body-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(Date.now(), "r1"));
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: { inbox: "shadow" } }));
  const projector = projectorOf(stateDir, [{ name: "core", ledgerDir }], { now: () => Date.now(), date: () => new Date(), iso: () => new Date().toISOString() });
  t.after(() => projector.ticker.release());
  const viewsModule = moduleFile(t, "slowview-extra", `export default [{ name: "extra", version: 1, materialize: () => [{ key: "", data: { extra: true }, sources: [] }] }];\n`).href;
  const fake = fakePort();
  runReadModelViewWorker(fake.port, { stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 5, holder: "proj-holder", viewsModule });
  fake.send({ type: "state", instances: projector.states() });
  t.after(() => fake.send({ type: "stop" }));
  await until(() => fake.posted.some((m) => m.type === "body" && m.entry.view === "extra"), "the loaded view was built");
  fake.send({ type: "state", instances: projector.states() });
  fake.send({ type: "shadow", request: { view: "extra", key: "", requests: 1, legacy: { data: { extra: false }, asOfMs: T0 } } });
  assert.ok(fake.posted.some((m) => m.type === "log" && m.step === "view.shadow_diff" && m.extra.view === "extra"), "the shadow sample was compared");
  fake.send({ type: "bodies", built: { view: "inbox", version: 1, bodies: [{ key: "section=a", data: { a: 1 }, sources: [] }] } });
  assert.ok(fake.posted.some((m) => m.type === "body" && m.entry.view === "inbox"), "a slow-lane body is served");
  fake.send({ type: "stop" });
  assert.equal(fake.closed(), 1);
});

test("the view thread body logs a module it cannot load and stops cleanly before its views are ready", async (t) => {
  const stateDir = scratch(t, "slowview-bad-state");
  const fake = fakePort();
  runReadModelViewWorker(fake.port, { stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 5, holder: "h", viewsModule: "file:///nonexistent/views.mjs" });
  await until(() => fake.posted.some((m) => m.type === "log" && m.step === "read_model.views_module_failed"), "the bad module is logged");

  const early = fakePort();
  runReadModelViewWorker(early.port, { stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 5, holder: "h", viewsModule: "file:///nonexistent/views.mjs" });
  early.send({ type: "stop" });
  await sleep(100);
  assert.equal(early.closed(), 1);
  assert.deepEqual(early.posted.filter((m) => m.type !== "log"), [], "a thread stopped before its views loaded builds nothing");
  fake.send({ type: "stop" });
});
