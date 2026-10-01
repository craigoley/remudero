/**
 * Gate G's instrument: serve counts reads per route and caller in memory and writes one
 * serve.route_reads row per hour; GET /v1/route-reads answers each legacy layer's zero-console-read
 * streak with the views as its positive control.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import {
  ROUTE_READS_FILE, buildRouteReadsRoute, createRouteReadRollup, legacyLayersOf, routeReadCaller, worstPhase, type RouteReadsRow, type RouteReadsSummary,
} from "../src/lib/route-read-rollup.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { Route, SseRoute } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { TraceGithub } from "../src/lib/trace.js";


function stateDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}route-reads-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(dir: string | undefined, startIso: string) {
  let now = Date.parse(startIso);
  const rows: RouteReadsRow[] = [];
  const logs: string[] = [];
  const rollup = createRouteReadRollup({ stateDir: dir, clock: clockFromMillisFn(() => now), write: (row) => rows.push(row), log: (step) => logs.push(step), tickMs: 3_600_000 });
  return { rollup, rows, logs, at: (iso: string) => { now = Date.parse(iso); }, advance: (ms: number) => { now += ms; } };
}

const req = (headers: Record<string, string> = {}): IncomingMessage => ({ headers }) as unknown as IncomingMessage;

function respond(route: Route, request: IncomingMessage = req()): { status: number; body: string } {
  const out = { status: 0, body: "" };
  const res = { writeHead: (status: number) => { out.status = status; return res; }, end: (body?: string) => { out.body = body ?? ""; } };
  void route.handler(request, res as unknown as ServerResponse, {} as never);
  return out;
}

test("the route read rollup writes one row per hour with per path read counts by caller", (t) => {
  const dir = stateDir(t);
  const h = harness(dir, "2026-10-01T10:05:00Z");
  const stop = h.rollup.start();
  for (let i = 0; i < 3; i++) h.rollup.count("/v1/status", "console");
  h.rollup.count("/v1/status", "fleet");
  h.at("2026-10-01T10:40:00Z");
  h.rollup.count("/v1/views/now", "console");
  h.rollup.count("/v1/views/now", "console");
  h.at("2026-10-01T10:59:59Z");
  h.rollup.tick();
  assert.equal(h.rows.length, 0, "six reads inside the hour are counted, not logged");

  h.at("2026-10-01T11:00:30Z");
  h.rollup.tick();
  assert.deepEqual(h.rows, [{
    hour: "2026-10-01T10:00:00.000Z", window_start: "2026-10-01T10:05:00.000Z", window_end: "2026-10-01T11:00:00.000Z", reads: 6,
    routes: { "/v1/status": { console: 3, fleet: 1 }, "/v1/views/now": { console: 2 } },
  }]);

  h.at("2026-10-01T11:10:00Z");
  h.rollup.count("/v1/recent", "fleet");
  h.at("2026-10-01T13:00:10Z");
  h.rollup.tick();
  assert.equal(h.rows.length, 2, "a tick that skips an hour still writes the finished hour once");
  assert.deepEqual(h.rows[1]!.routes, { "/v1/recent": { fleet: 1 } });
  h.at("2026-10-01T14:00:10Z");
  h.rollup.tick();
  assert.equal(h.rows.length, 3);
  assert.equal(h.rows[2]!.reads, 0, "a quiet hour still writes its row: it is coverage for a zero");

  const persisted = JSON.parse(readFileSync(join(dir, ROUTE_READS_FILE), "utf8"));
  assert.equal(persisted.hours, 3);
  assert.deepEqual(persisted.routes["/v1/status"], { console: { reads: 3, lastAt: "2026-10-01T10:05:00.000Z" }, fleet: { reads: 1, lastAt: "2026-10-01T10:05:00.000Z" } });
  stop();
  assert.equal(h.rows.length, 3, "a stop with nothing counted writes no partial row");
});

test("a quiet legacy route reports its zero console read streak with the views as positive control", (t) => {
  const h = harness(stateDir(t), "2026-10-01T10:00:00Z");
  h.rollup.start();
  h.rollup.count("/v1/status", "console");
  h.rollup.count("/v1/analytics", "console");
  for (let day = 1; day <= 8; day++) {
    h.at(`2026-10-0${day + 1}T09:00:00Z`);
    h.rollup.count("/v1/views/now", "console");
    h.rollup.count("/v1/status", "fleet");
    h.rollup.tick();
  }
  h.at("2026-10-09T11:00:00Z");
  h.rollup.count("/v1/analytics", "console");
  const summary = h.rollup.summary();
  const layer = (name: string) => summary.layers.find((l) => l.layer === name)!;
  assert.equal(summary.routes.find((r) => r.path === "/v1/status")!.zeroConsoleDays, 8, "fleet reads never break a console zero");
  assert.deepEqual({ ...layer("board-memo") }, {
    layer: "board-memo", paths: ["/v1/status"], consoleReads: 1, lastConsoleReadAt: "2026-10-01T10:00:00.000Z", zeroConsoleDays: 8, positiveControl: true, gateHolds: true,
  });
  assert.equal(layer("analytics-checkpoint").zeroConsoleDays, 0, "a console read in the current hour resets the streak before any flush");
  assert.equal(layer("analytics-checkpoint").gateHolds, false);
  assert.equal(layer("instance-gateways").zeroConsoleDays, 8, "a layer never read is zero since the rollup began");
  assert.equal(summary.views.consoleReads, 8);

  h.rollup.count("/v1/i/site/status", "console");
  const after = h.rollup.summary();
  assert.equal(after.layers.find((l) => l.layer === "instance-gateways")!.gateHolds, false);
  assert.equal(after.layers.find((l) => l.layer === "board-memo")!.zeroConsoleDays, 0, "an instance copy is the same legacy layer");

  const blind = harness(undefined, "2026-10-01T10:00:00Z");
  blind.rollup.start();
  blind.rollup.count("/v1/status", "fleet");
  blind.at("2026-10-10T10:00:00Z");
  const noViews = blind.rollup.summary().layers.find((l) => l.layer === "board-memo")!;
  assert.equal(noViews.zeroConsoleDays, 9);
  assert.equal(noViews.positiveControl, false, "a zero with no console view reads in its window proves nothing");
  assert.equal(noViews.gateHolds, false);
});

test("the route reads get answers the persisted rollup after a restart and counts each caller", (t) => {
  const dir = stateDir(t);
  const first = harness(dir, "2026-10-01T10:00:00Z");
  const stop = first.rollup.start();
  first.rollup.wrap({ method: "GET", path: "/v1/repos", scope: "read", handler: () => {} }).handler(req({ "cf-ray": "abc" }), { once: () => {} } as never, {} as never);
  first.rollup.wrap({ method: "GET", path: "/v1/repos", scope: "read", handler: () => {} }).handler(req(), { once: () => {} } as never, {} as never);
  const post: Route = { method: "POST", path: "/v1/drain/kick", scope: "write", handler: () => {} };
  assert.equal(first.rollup.wrap(post), post, "only reads are counted");
  first.at("2026-10-01T10:30:00Z");
  stop();
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0]!.partial, true, "the stop flush persists the partial hour");

  const second = harness(dir, "2026-10-01T10:45:00Z");
  second.rollup.start();
  const answer = respond(buildRouteReadsRoute(second.rollup));
  assert.equal(answer.status, 200);
  const body = JSON.parse(answer.body) as RouteReadsSummary;
  assert.deepEqual(body.routes.find((r) => r.path === "/v1/repos"), {
    path: "/v1/repos", kind: "legacy", layers: ["snapshot-cache", "repo-index"], zeroConsoleDays: 0,
    console: { reads: 1, lastAt: "2026-10-01T10:00:00.000Z" }, fleet: { reads: 1, lastAt: "2026-10-01T10:00:00.000Z" },
  });
  assert.equal(body.since, "2026-10-01T10:00:00.000Z");
  assert.equal(body.hours, 0, "a partial hour is not counted as coverage");

  assert.equal(routeReadCaller(req({ "cf-connecting-ip": "1.2.3.4" })), "console");
  assert.equal(routeReadCaller(req({ host: "127.0.0.1:4317" })), "fleet");
  assert.deepEqual(legacyLayersOf("/v1/operator-agent/proposals"), ["rotation-memos"]);
  assert.deepEqual(legacyLayersOf("/v1/i/site/repos/summary"), ["snapshot-cache", "repo-index", "instance-gateways"]);
  assert.deepEqual(legacyLayersOf("/v1/views/now"), []);
});

test("a route read rollup that cannot read or persist its file names why and keeps counting", (t) => {
  const dir = stateDir(t);
  writeFileSync(join(dir, ROUTE_READS_FILE), "{not json");
  const clock = clockFromMillisFn(() => Date.parse("2026-10-01T10:00:00Z"));
  const logs: string[] = [];
  const failing = createRouteReadRollup({ stateDir: dir, clock, log: (step) => logs.push(step), write: () => { throw new Error("ledger full"); } });
  const stopFailing = failing.start();
  assert.deepEqual(logs, ["serve.route_reads.unreadable"]);
  failing.count("/v1/status", "console");
  stopFailing();
  assert.ok(logs.includes("serve.route_reads.write_failed"), "a ledger write failure is named");
  assert.equal(failing.summary().routes[0]!.console!.reads, 1, "and the totals still fold");

  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "a file where the state dir should be");
  const unwritable = createRouteReadRollup({ stateDir: join(blocked, "state"), clock, log: (step) => logs.push(step) });
  const stopUnwritable = unwritable.start();
  unwritable.count("/v1/status", "fleet");
  stopUnwritable();
  assert.ok(logs.includes("serve.route_reads.persist_failed"), logs.join(","));
  assert.equal(unwritable.summary().routes[0]!.fleet!.reads, 1);
});

test("the served gateway counts each get by caller and writes the partial hour when it closes", async (t) => {
  const root = stateDir(t);
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const externalLedgerDir = stateDir(t);
  const ledgerPath = join(externalLedgerDir, "ledger.ndjson");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null } as TraceGithub, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "reads-read", write: "reads-write" },
    pollMs: 50,
    log: (step, extra) => void rows.push({ step, ...extra }),
  };
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let summary: RouteReadsSummary;
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { authorization: "Bearer reads-read", ...headers } });
    assert.equal((await get("/v1/version", { "cf-ray": "edge-1" })).status, 200);
    assert.equal((await get("/v1/version")).status, 200);
    summary = (await (await get("/v1/route-reads")).json()) as RouteReadsSummary;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const version = summary.routes.find((r) => r.path === "/v1/version")!;
  assert.deepEqual([version.kind, version.console?.reads, version.fleet?.reads], ["other", 1, 1]);
  const flushed = rows.filter((r) => r.step === "serve.route_reads");
  assert.equal(flushed.length, 1, "one row for the hour, not one per request");
  assert.deepEqual(flushed[0]!.routes, { "/v1/version": { console: 1, fleet: 1 }, "/v1/route-reads": { fleet: 1 } });
  assert.equal(existsSync(join(root, "state", ROUTE_READS_FILE)), true, "the rollup belongs to the serve state root");
  assert.equal(existsSync(join(externalLedgerDir, ROUTE_READS_FILE)), false, "an external ledger source is never a state write target");
});

function timedHarness(startIso: string) {
  let now = Date.parse(startIso);
  let monotonic = 0;
  const rows: RouteReadsRow[] = [];
  const rollup = createRouteReadRollup({ clock: clockFromMillisFn(() => now), write: (row) => rows.push(row), elapsed: () => monotonic });
  const timed = (path: string, ms: number, contentType = "application/json; charset=utf-8"): void => {
    const res = Object.assign(new EventEmitter(), { getHeader: (name: string) => (name === "content-type" ? contentType : undefined) });
    void rollup.wrap({ method: "GET", path, scope: "read", handler: () => { monotonic += ms; } }).handler(req(), res as unknown as ServerResponse, {} as never);
    res.emit("finish");
  };
  return { rollup, rows, timed, at: (iso: string) => { now = Date.parse(iso); } };
}

test("the route read rollup times each get from finish into p50 and p99 per path", () => {
  const h = timedHarness("2026-10-01T10:05:00Z");
  for (let i = 0; i < 98; i++) h.timed("/v1/views/now", 0.8);
  h.timed("/v1/views/now", 40);
  h.timed("/v1/views/now", 40);
  h.timed("/v1/status", 120);
  h.timed("/v1/views/events", 5_000, "text/event-stream");
  const summary = h.rollup.summary();
  const route = (path: string) => summary.routes.find((r) => r.path === path)!;
  assert.deepEqual(route("/v1/views/now").latency, { n: 100, maxMs: 40, buckets: { "1": 98, "50": 2 }, p50Ms: 1, p99Ms: 40 });
  assert.deepEqual([route("/v1/status").latency?.p50Ms, route("/v1/status").latency?.p99Ms], [120, 120], "a percentile never reads above the slowest sample");
  assert.equal(route("/v1/views/events").latency, undefined, "an event stream's lifetime is not a handler time");
  assert.equal(route("/v1/views/events").fleet?.reads, 1, "but its open is still a counted read");
  assert.deepEqual([summary.viewLatency.n, summary.viewLatency.p99Ms], [100, 40], "the view total leaves the legacy route out");

  h.at("2026-10-01T11:00:10Z");
  h.rollup.tick();
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.rows[0]!.latency!["/v1/views/now"], { n: 100, maxMs: 40, buckets: { "1": 98, "50": 2 }, p50Ms: 1, p99Ms: 40 });
  for (let i = 0; i < 100; i++) h.timed("/v1/views/now", 2.5);
  const later = h.rollup.summary().routes.find((r) => r.path === "/v1/views/now")!.latency!;
  assert.deepEqual([later.n, later.buckets, later.p50Ms, later.p99Ms], [200, { "1": 98, "3": 100, "50": 2 }, 3, 3], "the totals are cumulative histograms");
  assert.equal(h.rollup.summary().viewLatency.p50Ms, 3);
  const quiet = timedHarness("2026-10-01T10:00:00Z");
  assert.deepEqual([quiet.rollup.summary().viewLatency.p50Ms, quiet.rollup.summary().viewLatency.p99Ms], [null, null], "no reads read as no percentile, never as zero");
  quiet.timed("/v1/views/slow", 60_000);
  assert.equal(quiet.rollup.summary().viewLatency.p99Ms, 60_000, "an overflow read reports its own time");
});

test("a stale view response is counted with its worst source phase", (t) => {
  const dir = stateDir(t);
  const h = harness(dir, "2026-10-01T10:05:00Z");
  h.rollup.start();
  const fresh = { name: "ledger:core", asOf: null, state: "fresh" as const };
  for (let i = 0; i < 3; i++) h.rollup.served("now", { stale: false, sources: [fresh] });
  h.rollup.served("now", { stale: true, sources: [{ ...fresh, state: "stale", phase: "catching_up" }, { name: "github:core", asOf: null, state: "stale", phase: "behind" }] });
  h.rollup.served("inbox", { stale: true, sources: [{ ...fresh, state: "stale", phase: "failed" }] });
  h.rollup.served("inbox", { stale: true, sources: [{ name: "plan:core", asOf: null, state: "unavailable" }] });
  const { staleness } = h.rollup.summary();
  assert.deepEqual([staleness.served, staleness.stale], [6, 3]);
  assert.deepEqual(staleness.byView, { now: { served: 4, stale: 1 }, inbox: { served: 2, stale: 2 } });
  assert.deepEqual(staleness.bySource["ledger:core"], { stale: 2, phases: { catching_up: 1, failed: 1 } });
  assert.deepEqual(staleness.worstPhases, { "ledger:core": "failed", "github:core": "behind", "plan:core": "none" }, "a stale source with no phase is counted as none");

  h.at("2026-10-01T11:00:30Z");
  h.rollup.tick();
  assert.deepEqual(h.rows[0]!.staleness, { served: 6, stale: 3, byView: staleness.byView, bySource: staleness.bySource }, "the hour's row carries the counts");
  h.rollup.served("now", { stale: true, sources: [{ ...fresh, state: "stale", phase: "behind" }] });
  const persisted = JSON.parse(readFileSync(join(dir, ROUTE_READS_FILE), "utf8"));
  assert.equal(persisted.staleness.stale, 3, "the flushed hour is persisted");
  const second = harness(dir, "2026-10-01T11:30:00Z");
  second.rollup.start();
  assert.deepEqual(second.rollup.summary().staleness.bySource["ledger:core"], { stale: 2, phases: { catching_up: 1, failed: 1 } }, "and survives a restart");
  assert.equal(worstPhase({ stale: 1, phases: { warming: 1, refreshing: 2 } }), "refreshing");
  assert.equal(worstPhase({ stale: 0, phases: {} }), "none");
});

test("the status stream subscribers are counted as opens and closes and a quiet hour keeps the gauge", () => {
  const h = harness(undefined, "2026-10-01T10:05:00Z");
  h.rollup.start();
  const unsubscribed: number[] = [];
  const route: SseRoute = { path: "/v1/status/stream", scope: "read", subscribe: () => () => void unsubscribed.push(1) };
  const counted = h.rollup.wrapSse("status", route);
  const first = counted.subscribe(() => {});
  counted.subscribe(() => {});
  first();
  first();
  assert.equal(unsubscribed.length, 2, "the wrapped unsubscribe always runs");
  h.rollup.stream("views", "open", 1);
  h.rollup.stream("views", "handover", 0, "slow_consumer");
  h.rollup.stream("views", "handover", 0);
  const { streams } = h.rollup.summary();
  assert.deepEqual(streams.status, { opened: 2, closed: 1, peak: 2, handovers: {}, subscribers: 1 }, "a second close of one subscriber is not counted");
  assert.deepEqual(streams.views, { opened: 1, closed: 0, peak: 1, handovers: { slow_consumer: 1, unknown: 1 }, subscribers: 0 });

  h.at("2026-10-01T11:00:30Z");
  h.rollup.tick();
  h.at("2026-10-01T12:00:30Z");
  h.rollup.tick();
  assert.deepEqual(h.rows[0]!.streams, { views: { opened: 1, closed: 0, peak: 1, handovers: { slow_consumer: 1, unknown: 1 }, subscribers: 0 }, status: { opened: 2, closed: 1, peak: 2, handovers: {}, subscribers: 1 } });
  assert.deepEqual(h.rows[1]!.streams, { status: { opened: 0, closed: 0, peak: 1, handovers: {}, subscribers: 1 } }, "an open subscriber shows in a quiet hour; an idle stream is left out");
  assert.equal(h.rollup.summary().streams.status.peak, 2);
});

test("the served gateway times view reads and counts its status stream subscribers", async (t) => {
  const root = stateDir(t);
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null } as TraceGithub, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "timed-read", write: "timed-write" },
    pollMs: 50,
  };
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  let summary: RouteReadsSummary;
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: "Bearer timed-read" };
    assert.equal((await fetch(`${base}/v1/views/nav-badge`, { headers })).status, 200);
    const stream = await fetch(`${base}/v1/status/stream`, { headers, signal: controller.signal });
    assert.equal(stream.status, 200);
    summary = (await (await fetch(`${base}/v1/route-reads`, { headers })).json()) as RouteReadsSummary;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const nav = summary.routes.find((r) => r.path === "/v1/views/nav-badge")!;
  assert.equal(nav.latency?.n, 1, "the view read was timed on the real clock");
  assert.ok(nav.latency!.maxMs >= 0);
  assert.equal(summary.viewLatency.n, 1);
  assert.equal(summary.staleness.byView["nav-badge"]?.served, 1, "the view route told the rollup what it served");
  assert.deepEqual([summary.streams.status.opened, summary.streams.status.subscribers], [1, 1]);
});
