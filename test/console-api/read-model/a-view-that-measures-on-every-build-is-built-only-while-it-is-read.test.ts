import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createReadModelTicker, createReadModelWorker, READ_MODEL_IDLE_STRETCH_MAX, READ_MODEL_READ_HOT_MS,
  READ_MODEL_VIEW_SHARE, readModelLaneViews, readModelSwitchesPath,
  type ReadModelView, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import { createViewEvents, VIEW_EVENTS_SWEEP_MS } from "#src/lib/view-events.js";
import { buildReadModelViewRoutes, type ViewBody } from "#src/lib/views.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-11T10:00:00Z");

function fixture(t: TestContext, { production = false, costMs = 400 } = {}) {
  const stateDir = readModelFixtureDir(t, "unread-view");
  const planPath = join(stateDir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  let now = START;
  const clock = { now: () => now, iso: () => new Date(now).toISOString(), date: () => new Date(now) };
  const instances = (production ? ["core", "site"] : ["core"]).map(name => {
    const ledgerDir = join(stateDir, name);
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, "ledger.ndjson"), JSON.stringify({ ts: clock.iso(), step: "daemon.tick" }) + "\n");
    return { name, ledgerDir, planPath };
  });
  mkdirSync(join(stateDir, "read-model"));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({
    push: "on", views: { now: "serve", steady: "serve" },
  }));
  const messages: ReadModelWorkerMessage[] = [];
  const calls = { now: 0, steady: 0 };
  const measured = (name: keyof typeof calls): ReadModelView => ({
    name, version: 1, ...(name === "now" ? { readPaced: true as const } : {}),
    materialize: () => {
      now += name === "now" ? costMs : 400;
      return [{ key: "", data: { sample: ++calls[name] }, sources: [] }];
    },
  });
  const views = production
    ? readModelLaneViews({ instances }, clock, () => {}, createDemandBook({ clock })).filter(view => view.name === "now")
    : [measured("now"), measured("steady")];
  const ticker = createReadModelTicker({ stateDir, instances, views, clock, oracle: "off",
    ...(costMs > 400 ? { passBudgetMs: 20_000 } : {}), post: msg => void messages.push(msg) });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start();
  ticker.tick();
  const tick = (ms = 250) => { now += ms; ticker.tick(); };
  const body = (instance = "") => messages.findLast(msg => msg.type === "body" && msg.entry.view === "now" && msg.entry.key === instance);
  const rows = (from: number, view: string, instance?: string) => messages.flatMap(msg =>
    msg.type === "log" && msg.step === "read_model.view_builds" && msg.extra.view === view && msg.extra.instance === instance
    && (msg.extra.window as [number, number])[0] >= from ? [msg.extra] : []);
  return { stateDir, instances, ticker, calls, rows, body, tick, clock };
}

test("W1-T12270 criterion 1: a stopped unit contributes no calls to view_builds", t => {
  const f = fixture(t);
  f.tick(READ_MODEL_READ_HOT_MS - 1_000);
  assert.ok(f.calls.now > 1, "now kept building within the hot window");
  f.tick(10 * MINUTE);
  const idleFrom = f.clock.now();
  const last = f.calls.now;
  f.tick(10 * MINUTE);
  f.tick(10 * MINUTE);
  assert.ok(last > 0, "now built before idling");
  assert.equal(f.calls.now, last);
  assert.equal(f.rows(idleFrom, "now").length, 0);
  assert.ok(f.rows(idleFrom, "steady").some(row => Number(row.calls) > 0), "the report windows closed");
});

test("unread waits double until the cost-based limit", t => {
  const costMs = 4_000;
  const interval = costMs / READ_MODEL_VIEW_SHARE;
  const f = fixture(t, { costMs });
  const tickAt = (at: number) => f.tick(at - f.clock.now());
  tickAt(START + READ_MODEL_READ_HOT_MS);
  assert.equal(f.calls.now, 2);
  for (const stretch of [2, 4]) {
    const body = f.body();
    assert.ok(body?.type === "body");
    const due = Date.parse(body.entry.body.generatedAt) + stretch * interval;
    const before: number = f.calls.now;
    tickAt(due - 500);
    assert.equal(f.calls.now, before);
    tickAt(due);
    assert.equal(f.calls.now, before + 1);
  }
  tickAt(START + interval * READ_MODEL_IDLE_STRETCH_MAX);
  assert.equal(f.calls.now, 4, "a tick past the old due time does not build at the unread limit");
});

test("W1-T12270 criterion 2: needs-you, status and recent each wake their now source", t => {
  const f = fixture(t);
  for (const path of ["/v1/views/needs-you", "/v1/status", "/v1/recent"]) {
    f.tick(10 * MINUTE);
    const before = f.calls.now;
    f.ticker.read(path);
    f.tick();
    assert.equal(f.calls.now, before + 1, path);
  }
});

test("W1-T12270 criterion 3: the first read after a stop shows the age of the body while rebuilding", async t => {
  const f = fixture(t);
  const built = f.body();
  assert.ok(built?.type === "body");
  f.tick(10 * MINUTE);
  const readModel = createReadModelWorker({ stateDir: f.stateDir, instances: f.instances, clock: f.clock });
  closeReadModelFixture(t, () => readModel.stop());
  const [route] = buildReadModelViewRoutes({ legacy: [], readModelViews: ["now"], readModel, clock: f.clock });
  const before = f.calls.now;
  f.ticker.read("/v1/views/now");
  let status: number | undefined;
  let body: ViewBody | undefined;
  await route!.handler({ url: "/v1/views/now", headers: { "if-none-match": built.entry.etag } } as never, {
    writeHead: (code: number) => { status = code; },
    end: (json: string) => { body = JSON.parse(json) as ViewBody; },
  } as never, {} as never);
  assert.equal(status, 200);
  assert.equal(body?.stale, true);
  assert.equal(body?.generatedAt, built.entry.body.generatedAt);
  assert.ok(body?.sources.some(source => Number(source.lagMs) >= 10 * MINUTE && source.state === "stale"));
  f.tick();
  assert.equal(f.calls.now, before + 1);
  const rebuilt = f.body();
  assert.ok(rebuilt?.type === "body" && !rebuilt.entry.body.stale);
});

test("W1-T12270 criterion 4: regular reads keep the usual cadence and leave the unpaced unit alone", t => {
  const f = fixture(t);
  const before = { ...f.calls };
  for (let minute = 0; minute < 5; minute++) {
    f.ticker.read("/v1/views/now");
    for (let elapsed = 0; elapsed < MINUTE; elapsed += 2_000) f.tick(2_000);
  }
  assert.equal(f.calls.now - before.now, 150);
  assert.equal(f.calls.steady - before.steady, 150);
  const after = { ...f.calls };
  f.tick(10 * MINUTE);
  assert.equal(f.calls.steady, after.steady + 1);
  assert.equal(f.calls.now, after.now);
});

test("a connected view-events reader keeps noting now reads between HTTP fetches", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const source = `
    import { parentPort } from "node:worker_threads";
    parentPort.on("message", message => {
      if (message.type === "read") parentPort.postMessage({ type: "log", step: "read", extra: { path: message.path } });
      if (message.type === "stop") parentPort.close();
    });
  `;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  const seen: unknown[] = [];
  const secondRead = new EventEmitter();
  const readModel = createReadModelWorker({ stateDir: f.stateDir, instances: f.instances, clock: f.clock, workerUrl, stopWaitMs: 1,
    observe: message => {
      if (message.type !== "log" || message.step !== "read") return;
      seen.push(message.extra.path);
      if (seen.length === 2) secondRead.emit("read");
    },
  });
  closeReadModelFixture(t, () => readModel.stop());
  const timers = new Map<number, () => void>();
  const events = createViewEvents({ names: ["now"], readModel, clock: f.clock, every: (run, ms) => {
    timers.set(ms, run);
    return () => void timers.delete(ms);
  } });
  const req = Object.assign(new EventEmitter(), { url: "/v1/views/events", headers: {} });
  const res = Object.assign(new EventEmitter(), { writeHead() {}, write() {} });
  const read = new Promise<void>((resolve, reject) => {
    secondRead.once("read", resolve);
    t.signal.addEventListener("abort", () => reject(t.signal.reason), { once: true });
  });
  readModel.start();
  await events.routes[0]!.handler(req as never, res as never, {} as never);
  f.tick(MINUTE);
  timers.get(VIEW_EVENTS_SWEEP_MS)!();
  await read;
  req.emit("close");
  assert.deepEqual(seen, ["/v1/views/now", "/v1/views/now"]);
  assert.equal(timers.size, 0);
});

test("W1-T12270 criterion 5: the production lane stops an unread instance of now", async t => {
  await withGhShim([{ when: "api rate_limit", stdout: "4999" }], shim => {
    const f = fixture(t, { production: true });
    f.tick(MINUTE);
    assert.ok(f.body("instance=site"), "site's production body built");
    assert.ok(shim.calls().some(call => call.startsWith("api rate_limit")), "core ran the real probe path");
    f.tick(10 * MINUTE);
    const idleFrom = f.clock.now();
    f.tick(10 * MINUTE);
    assert.equal(f.rows(idleFrom, "now", "site").length, 0);
    f.ticker.read("/v1/views/now?instance=site");
    f.tick();
    f.tick(10 * MINUTE);
    assert.ok(f.rows(idleFrom, "now", "site").some(row => Number(row.builds) > 0), "the addressed unit resumes");
    assert.equal(f.rows(idleFrom, "now", "core").length, 0);
  });
});
