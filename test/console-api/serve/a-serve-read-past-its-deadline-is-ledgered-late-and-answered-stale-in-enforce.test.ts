/**
 * W1-T11817: on 2026-11-08 every console read reaching serve ended "context canceled". The console waits 5000 ms and
 * serve held a read that met a cold view until it gave up. A covered read now races a deadline under that timeout:
 * shadow counts it late, and enforce answers it from the committed body or with a fast 503.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { CONSOLE_CACHED_READ_PATHS } from "#src/lib/route-read-rollup.js";
import { createServeDemand, SERVE_DEMAND_WINDOW_MS } from "#src/lib/serve-demand.js";
import {
  committedViewBody, CONSOLE_REQUEST_TIMEOUT_MS, createReadDeadline, DEFAULT_SERVE_READ_DEADLINE_MS, readDeadlineConfig,
  readDeadlineCovers, READ_DEADLINE_STEP, withReadDeadline, type CommittedRead, type ReadDeadlineMode,
} from "#src/lib/serve-read-deadline.js";
import type { Route } from "#src/lib/service.js";
import { withTempDir } from "#src/lib/tmp.js";
import { VIEW_EVENTS_PATH } from "#src/lib/view-events.js";
import { buildReadModelViewRoutes, viewEtag, viewKey, type ViewBody, type ViewBodyEntry } from "#src/lib/views.js";

const DEADLINE_MS = 40;
const SLOW_MS = 250;
const readRoutes = { cachedReadPaths: CONSOLE_CACHED_READ_PATHS, viewEventsPath: VIEW_EVENTS_PATH };
type Counts = { late: number; stale: number; deferred: number };
type Row = { step: string; mode: string; deadlineMs: number; families: Record<string, Counts> };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function rows(path: string): Row[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
    .filter((row) => row.step === READ_DEADLINE_STEP);
}

/** A real HTTP server answering `routes` through one deadline, whose window shares serve.demand's families and clock. */
async function world(t: { after: (fn: () => void) => void }, root: string, mode: ReadDeadlineMode, routes: Route[],
  committed: (route: Route) => ((req: IncomingMessage) => CommittedRead | undefined) | undefined = () => undefined) {
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let clock = 0;
  const demand = createServeDemand({ ledgerPath, routes, clock: clockFromMillisFn(() => clock) });
  const deadline = createReadDeadline({ ...readRoutes, ledgerPath, mode, deadlineMs: DEADLINE_MS, clock: clockFromMillisFn(() => clock), family: (req) => demand.familyFor(req) });
  const wrapped = routes.map((route) => withReadDeadline(route, deadline, committed(route)));
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const route = wrapped.find((r) => r.method === req.method && r.path === path);
    if (!route) return void res.writeHead(404).end();
    void route.handler(req, res, { params: {} });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (path: string, method = "GET") => {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, { method });
    return { status: response.status, headers: response.headers, text: await response.text(), ms: performance.now() - started };
  };
  const counted = (): Row | undefined => { clock += SERVE_DEMAND_WINDOW_MS; deadline.flush(); return rows(ledgerPath).at(-1); };
  return { read, counted, setClock: (ms: number) => { clock = ms; } };
}

/** A legacy cached route that answers `{"n":<call>}` with setHeader, write and end, slowly on the calls `slow` names. */
function legacyStatus(slow: (call: number) => boolean, finished: number[] = []): Route {
  let calls = 0;
  return { method: "GET", path: "/v1/status", scope: "read", handler: async (_req, res) => {
    const call = ++calls;
    if (slow(call)) await sleep(SLOW_MS);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.write(`{"n":`);
    res.end(`${call}}`);
    finished.push(call);
  } };
}

/** The real view route, answering a held body for `?instance=core`, with its whole answer delayed past the deadline. */
function heldView(generatedAt: string) {
  const data = { instance: "core", cards: [1, 2, 3] };
  const key = viewKey(new URLSearchParams({ instance: "core" }));
  const body: ViewBody = { view: "held", version: 1, generatedAt, asOf: generatedAt, stale: false, sources: [], data };
  const entry: ViewBodyEntry = { view: "held", key, version: 1, generation: 1, etag: viewEtag("held", 1, false, data), body };
  const source = { body: (view: string, k?: string) => view === "held" && k === key ? entry : undefined };
  const [route] = buildReadModelViewRoutes({ legacy: [], readModelViews: ["held"], servedByDefault: ["held"],
    readModel: { ...source, switches: () => ({ views: {} }), judge: (sources) => [...sources] } });
  const slow: Route = { ...route!, handler: async (req, res, ctx) => { await sleep(SLOW_MS); await route!.handler(req, res, ctx); } };
  return { route: slow, source, data };
}

test("W1-T11817 criterion 1: in shadow a read past the deadline is answered exactly as before and counted late in its family's window", async (t) => {
  await withTempDir("read-deadline-shadow", async (root) => {
    const w = await world(t, root, "shadow", [legacyStatus((call) => call === 2)]);
    const fast = await w.read("/v1/status");
    const late = await w.read("/v1/status");
    assert.deepEqual([fast.status, fast.text, late.status, late.text], [200, `{"n":1}`, 200, `{"n":2}`]);
    assert.ok(late.ms >= SLOW_MS - 5, `the shadow read was held for its own answer (${late.ms} ms)`);
    for (const header of ["x-rmd-stale", "x-rmd-stale-ms", "retry-after"]) assert.equal(late.headers.get(header), null);
    const row = w.counted();
    assert.equal(row?.mode, "shadow");
    assert.equal(row?.deadlineMs, DEADLINE_MS);
    assert.deepEqual(row?.families, { "/v1/status": { late: 1, stale: 0, deferred: 0 } });
  });
});

test("W1-T11817 criterion 2: in enforce a late read with a committed body is answered from it, aged and marked stale, and counted stale", async (t) => {
  await withTempDir("read-deadline-stale", async (root) => {
    const view = heldView("1970-01-01T00:00:00.000Z");
    const finished: number[] = [];
    const w = await world(t, root, "enforce", [view.route, legacyStatus((call) => call === 2, finished)], (route) => committedViewBody(view.source, route, viewKey));
    w.setClock(90_000);
    const viewed = await w.read("/v1/views/held?instance=core");
    assert.equal(viewed.status, 200);
    assert.ok(viewed.ms < SLOW_MS, `answered at the deadline, not after the build (${viewed.ms} ms)`);
    assert.equal(viewed.headers.get("x-rmd-stale"), "true");
    assert.equal(viewed.headers.get("x-rmd-stale-ms"), "90000");
    const body = JSON.parse(viewed.text) as ViewBody;
    assert.equal(body.stale, true);
    assert.deepEqual(body.data, view.data);
    // A legacy read answers from the last body it committed; the abandoned read finishes for no one.
    assert.equal((await w.read("/v1/status")).text, `{"n":1}`);
    w.setClock(95_000);
    const legacy = await w.read("/v1/status");
    assert.deepEqual([legacy.status, legacy.text, legacy.headers.get("x-rmd-stale"), legacy.headers.get("x-rmd-stale-ms")], [200, `{"n":1}`, "true", "5000"]);
    await sleep(SLOW_MS);
    assert.deepEqual(finished, [1, 2]);
    assert.deepEqual(w.counted()?.families, {
      "/v1/views/held": { late: 1, stale: 1, deferred: 0 },
      "/v1/status": { late: 1, stale: 1, deferred: 0 },
    });
  });
});

test("W1-T11817 criterion 3: in enforce a late read with no committed body is answered at once with 503 and retry-after, and counted deferred", async (t) => {
  await withTempDir("read-deadline-deferred", async (root) => {
    const view = heldView("1970-01-01T00:00:00.000Z");
    const w = await world(t, root, "enforce", [view.route, legacyStatus(() => true)], (route) => committedViewBody(view.source, route, viewKey));
    for (const path of ["/v1/views/held?instance=cold", "/v1/status"]) {
      const read = await w.read(path);
      assert.equal(read.status, 503);
      assert.equal(read.headers.get("retry-after"), "5");
      assert.ok(read.ms < SLOW_MS, `${path} was not held (${read.ms} ms)`);
      assert.deepEqual(JSON.parse(read.text), { error: "read_deadline", deadlineMs: DEADLINE_MS, retryAfterS: 5 });
    }
    await sleep(SLOW_MS);
    assert.deepEqual(w.counted()?.families, {
      "/v1/views/held": { late: 1, stale: 0, deferred: 1 },
      "/v1/status": { late: 1, stale: 0, deferred: 1 },
    });
  });
});

test("W1-T11817 criterion 4: 4000 ms under the console's 5000 ms, shadow by default, GET view and cached reads only, writes and streams never cut", async (t) => {
  assert.deepEqual(readDeadlineConfig({}), { mode: "shadow", deadlineMs: 4000 });
  assert.equal(DEFAULT_SERVE_READ_DEADLINE_MS < CONSOLE_REQUEST_TIMEOUT_MS, true);
  assert.deepEqual(readDeadlineConfig({ RMD_SERVE_READ_DEADLINE: "enforce", RMD_SERVE_READ_DEADLINE_MS: "2500" }), { mode: "enforce", deadlineMs: 2500 });
  assert.deepEqual(readDeadlineConfig({ RMD_SERVE_READ_DEADLINE: "on", RMD_SERVE_READ_DEADLINE_MS: "soon" }), { mode: "shadow", deadlineMs: 4000 });
  assert.deepEqual(createReadDeadline({ ...readRoutes, ledgerPath: "unused", family: () => undefined }).deadlineMs, 4000);
  const covered = (method: string, path: string, scope = "read") => readDeadlineCovers({ method: method as Route["method"], path, scope: scope as Route["scope"] }, readRoutes);
  assert.deepEqual([covered("GET", "/v1/views/now"), covered("GET", "/v1/status"), covered("GET", "/v1/i/games/status"), covered("GET", "/v1/operator-activity")], [true, true, true, true]);
  assert.deepEqual([covered("POST", "/v1/views/batch"), covered("GET", VIEW_EVENTS_PATH), covered("POST", "/v1/inbox/approve", "write"), covered("GET", "/v1/task")], [false, false, false, false]);
  await withTempDir("read-deadline-scope", async (root) => {
    const write: Route = { method: "POST", path: "/v1/inbox/approve", scope: "write", tier: "high", handler: async (_req, res) => {
      await sleep(SLOW_MS); res.writeHead(202, { "content-type": "application/json" }); res.end(`{"ok":true}`);
    } };
    const stream: Route = { method: "GET", path: VIEW_EVENTS_PATH, scope: "read", handler: async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: ping\n\n"); await sleep(SLOW_MS); res.end();
    } };
    const deadline = createReadDeadline({ ...readRoutes, ledgerPath: join(root, "ledger.ndjson"), mode: "enforce", deadlineMs: DEADLINE_MS, family: () => undefined });
    assert.equal(withReadDeadline(write, deadline), write);
    assert.equal(withReadDeadline(stream, deadline), stream);
    const w = await world(t, root, "enforce", [write, stream]);
    assert.deepEqual([(await w.read("/v1/inbox/approve", "POST")).status, (await w.read(VIEW_EVENTS_PATH)).text], [202, "event: ping\n\n"]);
    assert.equal(w.counted(), undefined);
  });
});

test("an enforce read already answering at the deadline is counted late and never cut", async (t) => {
  await withTempDir("read-deadline-begun", async (root) => {
    const begun: Route = { method: "GET", path: "/v1/recent", scope: "read", handler: async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "identity" }); res.write("["); await sleep(SLOW_MS); res.end("]");
    } };
    const w = await world(t, root, "enforce", [begun]);
    assert.deepEqual([(await w.read("/v1/recent")).text, (await w.read("/v1/recent")).text], ["[]", "[]"]);
    assert.deepEqual(w.counted()?.families, { "/v1/recent": { late: 2, stale: 0, deferred: 0 } });
  });
});

test("the deadline window starts its own timer and reports a ledger it cannot write", async () => {
  await withTempDir("read-deadline-window", async (root) => {
    mkdirSync(join(root, "dir"));
    const logged: string[] = [];
    let clock = 0;
    const deadline = createReadDeadline({ ...readRoutes, ledgerPath: join(root, "dir"), mode: "enforce", deadlineMs: 1, clock: clockFromMillisFn(() => clock),
      family: () => undefined, log: (step) => logged.push(step) });
    const stop = deadline.start();
    stop(); stop();
    const route = withReadDeadline({ method: "GET", path: "/v1/repos", scope: "read", handler: async () => {} }, deadline);
    const res = Object.assign(new (await import("node:events")).EventEmitter(), { writableEnded: false, headersSent: true, getHeader: () => undefined });
    await route.handler({ method: "GET", url: "/v1/repos" } as IncomingMessage, res as unknown as ServerResponse, { params: {} });
    await sleep(20);
    clock = SERVE_DEMAND_WINDOW_MS; deadline.flush();
    assert.deepEqual(logged, ["serve.read_deadline_write_failed"]);
    let ticks = 0;
    const every = createReadDeadline({ ...readRoutes, ledgerPath: join(root, "dir"), family: () => undefined, every: () => { ticks++; return () => {}; } });
    every.start()();
    assert.equal(ticks, 1);
  });
});
