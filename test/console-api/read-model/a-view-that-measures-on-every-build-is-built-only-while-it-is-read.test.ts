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
import { buildReadModelViewRoutes, type ViewBody, type ViewBodyEntry } from "#src/lib/views.js";
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
  const builds: Record<keyof typeof calls, number[]> = { now: [], steady: [] };
  const measured = (name: keyof typeof calls): ReadModelView => ({
    name, version: 1, ...(name === "now" ? { readPaced: true as const } : {}),
    materialize: () => {
      builds[name].push(now);
      now += name === "now" ? costMs : 400;
      return [{ key: "", data: { sample: ++calls[name] }, sources: [] }];
    },
  });
  const views = production
    ? readModelLaneViews({ instances }, clock, () => {}, createDemandBook({ clock }))
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
  return { stateDir, instances, ticker, calls, builds, rows, body, tick, clock };
}

test("W1-T12270 criterion 1: a stopped unit contributes no calls to view_builds", t => {
  const f = fixture(t);
  assert.ok(f.calls.now > 0, "now built before the idle window");
  f.tick(10 * MINUTE);
  const idleFrom = f.clock.now();
  const last = f.calls.now;
  const stoppedBody = f.body();
  assert.ok(stoppedBody?.type === "body");
  assert.equal(f.ticker.shadow({ view: "now", key: "", requests: 1_441,
    legacy: { data: stoppedBody.entry.body.data, asOfMs: Date.parse(stoppedBody.entry.body.generatedAt) } }), false,
  "a synthetic shadow batch cannot qualify a body marked idle");
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

test("the pre-cap unread intervals still double before the unit stops", t => {
  const costMs = 16_000;
  const interval = costMs / READ_MODEL_VIEW_SHARE;
  const f = fixture(t, { costMs });
  f.ticker.read("/v1/views/now");
  const readAt = f.clock.now();
  const tickAt = (at: number) => f.tick(at - f.clock.now());
  tickAt(readAt + READ_MODEL_READ_HOT_MS);
  const waits: number[] = [];
  for (const stretch of [2, 4, 8]) {
    const previous = f.builds.now.at(-1)!;
    const before = f.calls.now;
    tickAt(previous + costMs + stretch * interval);
    for (let retry = 0; retry < 4 && f.calls.now === before; retry++) f.tick(250);
    assert.equal(f.calls.now, before + 1, `the ${stretch}x build ran`);
    waits.push(f.builds.now.at(-1)! - previous - costMs);
  }
  assert.deepEqual(waits.map(ms => Math.round(ms / interval)), [2, 4, 8], `the unread schedule doubles before stopping: ${waits.join(", ")} ms`);
  const stoppedAt = f.calls.now;
  tickAt(readAt + 30 * MINUTE);
  assert.equal(f.calls.now, stoppedAt, "the stopped body is not rebuilt until a read arrives");
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

test("a production batch read of needs-you wakes its now source before answering", async t => {
  const f = fixture(t);
  f.tick(10 * MINUTE);
  const now = f.body();
  assert.ok(now?.type === "body");
  const derived: ViewBodyEntry = {
    view: "needs-you", key: "", version: 1, generation: 1, etag: "needs-you-v1",
    body: { view: "needs-you", version: 1, generatedAt: f.clock.iso(), asOf: f.clock.iso(), stale: false, sources: [], data: {} },
  };
  const readModel = {
    body: (view: string): ViewBodyEntry | undefined => view === "now" ? now.entry : view === "needs-you" ? derived : undefined,
    judge: (sources: ViewBodyEntry["body"]["sources"]) => sources,
    switches: () => ({ views: { now: "serve" as const, "needs-you": "serve" as const } }),
    noteViewRead: (path: string) => f.ticker.read(path),
  };
  const route = buildReadModelViewRoutes({ legacy: [], readModelViews: ["now", "needs-you"], readModel, clock: f.clock })
    .find(candidate => candidate.path === "/v1/views/batch")!;
  const req = Object.assign(new EventEmitter(), { url: "/v1/views/batch", headers: {} });
  let response = "";
  const res = Object.assign(new EventEmitter(), { writeHead() {}, end(value?: string) { response = value ?? ""; } });
  const before = f.calls.now;
  const answer = route.handler(req as never, res as never, {} as never);
  req.emit("data", Buffer.from(JSON.stringify({ reads: [{ view: "needs-you" }] })));
  req.emit("end");
  await answer;
  assert.equal(JSON.parse(response).answers[0].status, 200);
  f.tick();
  assert.equal(f.calls.now, before + 1);
});

test("W1-T12270 criterion 3: the first read after a stop shows the age of the body while rebuilding", async t => {
  const f = fixture(t);
  const built = f.body();
  assert.ok(built?.type === "body");
  f.tick(10 * MINUTE);
  const readModel = createReadModelWorker({ stateDir: f.stateDir, instances: f.instances, clock: f.clock });
  closeReadModelFixture(t, () => readModel.stop());
  readModel.noteViewRead = path => f.ticker.read(path);
  const [route] = buildReadModelViewRoutes({ legacy: [], readModelViews: ["now"], readModel, clock: f.clock });
  const before = f.calls.now;
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
  const idleMarker = body?.sources.find(source => source.name.startsWith("read-model:idle:now"));
  assert.match(idleMarker?.reason ?? "", new RegExp(built.entry.body.generatedAt), "the stale answer states when its last body was generated");
  f.tick();
  assert.equal(f.calls.now, before + 1);
  const rebuilt = f.body();
  assert.ok(rebuilt?.type === "body" && !rebuilt.entry.body.stale);
});

test("W1-T12270 criterion 4: regular reads keep the usual cadence and leave the unpaced unit alone", t => {
  const f = fixture(t);
  const before = { ...f.calls };
  const perMinute: Array<[number, number]> = [];
  for (let minute = 0; minute < 5; minute++) {
    f.ticker.read("/v1/views/now");
    for (let elapsed = 0; elapsed < MINUTE; elapsed += 2_000) f.tick(2_000);
    perMinute.push([f.calls.now - before.now - perMinute.reduce((n, item) => n + item[0], 0), f.calls.steady - before.steady - perMinute.reduce((n, item) => n + item[1], 0)]);
  }
  assert.ok(f.calls.now - before.now > 1, "regular reads kept now building");
  assert.ok(f.calls.now - before.now >= 50, `frequent reads kept now on its normal cadence: ${JSON.stringify(perMinute)}`);
  const after = { ...f.calls };
  f.tick(10 * MINUTE);
  assert.equal(f.calls.steady, after.steady + 1);
  assert.equal(f.calls.now, after.now);
});

test("view-events counts delivered bodies as reads and does not count an idle sweep", async t => {
  const f = fixture(t);
  const seen: unknown[] = [];
  const entry = f.body();
  assert.ok(entry?.type === "body");
  const bodyEntry = entry.entry;
  const bodies = new Map<string, ViewBodyEntry>();
  const listeners = new Set<(body: typeof bodyEntry) => void>();
  const readModel = {
    bodies,
    body: (view: string, key = "") => bodies.get(`${view}\u0000${key}`),
    judge: (sources: typeof bodyEntry.body.sources) => sources,
    switches: () => ({ projector: "on" as const, push: "on" as const, views: { now: "serve" as const } }),
    onBody: (listener: (body: typeof bodyEntry) => void) => { listeners.add(listener); return () => void listeners.delete(listener); },
    noteViewRead: (path: string) => { seen.push(path); },
  };
  const timers = new Map<number, () => void>();
  const events = createViewEvents({ names: ["now"], readModel, clock: f.clock, every: (run, ms) => {
    timers.set(ms, run);
    return () => void timers.delete(ms);
  } });
  const req = Object.assign(new EventEmitter(), { url: "/v1/views/events", headers: {} });
  const res = Object.assign(new EventEmitter(), { writableLength: 0, writableEnded: false, writeHead() {}, write() {}, end() {} });
  await events.routes[0]!.handler(req as never, res as never, {} as never);
  bodies.set("now\u0000", bodyEntry);
  for (const listener of listeners) listener(bodyEntry);
  await new Promise<void>(resolve => setImmediate(resolve));
  f.tick(MINUTE);
  timers.get(VIEW_EVENTS_SWEEP_MS)!();
  await new Promise<void>(resolve => setImmediate(resolve));
  req.emit("close");
  assert.deepEqual(seen, ["/v1/views/now"]);
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
    const rows = [...f.rows(0, "now", "site"), ...f.rows(0, "now", "core")];
    assert.ok(rows.some(row => row.instance === "site" && Number(row.builds) > 0), `the addressed unit resumes: ${JSON.stringify(rows)}`);
    assert.equal(rows.filter(row => row.instance === "core" && (row.window as [number, number])[1] > idleFrom).length, 0, "the unaddressed unit stays stopped");
  });
});
