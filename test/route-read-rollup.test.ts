/**
 * Gate G's instrument: serve counts reads per route and caller in memory and writes one
 * serve.route_reads row per hour; GET /v1/route-reads answers each legacy layer's zero-console-read
 * streak with the views as its positive control.
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import {
  ROUTE_READS_FILE, buildRouteReadsRoute, createRouteReadRollup, legacyLayersOf, routeReadCaller, type RouteReadsRow, type RouteReadsSummary,
} from "../src/lib/route-read-rollup.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
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
  first.rollup.wrap({ method: "GET", path: "/v1/repos", scope: "read", handler: () => {} }).handler(req({ "cf-ray": "abc" }), {} as never, {} as never);
  first.rollup.wrap({ method: "GET", path: "/v1/repos", scope: "read", handler: () => {} }).handler(req(), {} as never, {} as never);
  const post: Route = { method: "POST", path: "/v1/drain/kick", scope: "write", handler: () => {} };
  assert.equal(first.rollup.wrap(post), post, "only reads are counted");
  first.at("2026-10-01T10:30:00Z");
  stop();
  assert.equal(first.rows.length, 0, "a stop hands its partial hour on instead of writing a row");
  assert.equal(JSON.parse(readFileSync(join(dir, ROUTE_READS_FILE), "utf8")).carry.row.reads, 2);

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
  let now = Date.parse("2026-10-01T10:00:00Z");
  const clock = clockFromMillisFn(() => now);
  const logs: string[] = [];
  const failing = createRouteReadRollup({ stateDir: dir, clock, log: (step) => logs.push(step), write: () => { throw new Error("ledger full"); } });
  const stopFailing = failing.start();
  assert.deepEqual(logs, ["serve.route_reads.unreadable"]);
  failing.count("/v1/status", "console");
  now = Date.parse("2026-10-01T11:00:05Z");
  failing.tick();
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
  assert.equal(rows.filter((r) => r.step === "serve.route_reads").length, 0, "no row per request and none at close: the hour is handed on");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "state", ROUTE_READS_FILE), "utf8")).carry.row.routes,
    { "/v1/version": { console: 1, fleet: 1 }, "/v1/route-reads": { fleet: 1 } });
  assert.equal(existsSync(join(externalLedgerDir, ROUTE_READS_FILE)), false, "an external ledger source is never a state write target");
});

test("a promoted generation takes over the in progress hour so each hour has exactly one row", (t) => {
  const dir = stateDir(t);
  const a = harness(dir, "2026-10-01T10:05:00Z");
  const stopA = a.rollup.start();
  for (let i = 0; i < 3; i++) a.rollup.count("/v1/status", "console");
  const b = harness(dir, "2026-10-01T10:20:00Z");
  b.rollup.count("/v1/status", "fleet");
  b.rollup.count("/v1/status", "fleet");
  b.at("2026-10-01T11:20:00Z");
  b.rollup.tick();
  assert.equal(existsSync(join(dir, ROUTE_READS_FILE)), false, "a standby counts nothing and writes nothing");
  b.at("2026-10-01T10:30:00Z");
  const stopB = b.rollup.start();
  assert.equal(b.rollup.start()(), undefined, "a second promotion is a no-op");
  b.rollup.count("/v1/views/now", "console");
  a.at("2026-10-01T10:32:00Z");
  a.rollup.count("/v1/status", "fleet");
  a.at("2026-10-01T10:33:00Z");
  stopA();
  stopA();
  assert.equal(a.rows.length, 0, "the draining generation writes no row");
  b.at("2026-10-01T11:00:30Z");
  b.rollup.tick();
  assert.deepEqual(b.rows, [{
    hour: "2026-10-01T10:00:00.000Z", window_start: "2026-10-01T10:05:00.000Z", window_end: "2026-10-01T11:00:00.000Z", reads: 5,
    routes: { "/v1/views/now": { console: 1 }, "/v1/status": { console: 3, fleet: 1 } },
  }], "one row for the hour across the swap with both generations' reads and none of the standby's");
  const persisted = JSON.parse(readFileSync(join(dir, ROUTE_READS_FILE), "utf8"));
  assert.deepEqual([persisted.hours, persisted.carry, persisted.lastHour], [1, undefined, "2026-10-01T10:00:00.000Z"]);
  assert.equal(persisted.routes["/v1/status"].fleet.lastAt, "2026-10-01T10:32:00.000Z", "a carried read keeps its own time");

  const late = harness(dir, "2026-10-01T10:50:00Z");
  const stopLate = late.rollup.start();
  late.rollup.count("/v1/recent", "fleet");
  late.at("2026-10-01T10:59:00Z");
  stopLate();
  b.at("2026-10-01T12:00:30Z");
  b.rollup.tick();
  assert.deepEqual(b.rows.map((r) => r.hour), ["2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z"], "a late carry never writes its hour twice");
  assert.deepEqual(b.rows[1]!.routes, { "/v1/recent": { fleet: 1 } }, "it rides in the next row");
  assert.equal(b.rows[1]!.window_start, "2026-10-01T11:00:00.000Z");
  stopB();

  const old = harness(dir, "2026-10-01T15:10:00Z");
  const stopOld = old.rollup.start();
  old.rollup.count("/v1/status", "fleet");
  old.at("2026-10-01T15:20:00Z");
  stopOld();
  const reboot = harness(dir, "2026-10-01T18:10:00Z");
  reboot.rollup.start();
  reboot.rollup.count("/v1/status", "fleet");
  reboot.at("2026-10-01T19:00:30Z");
  reboot.rollup.tick();
  assert.deepEqual(reboot.rows.map((r) => [r.hour, r.reads, r.partial ?? false]),
    [["2026-10-01T15:00:00.000Z", 1, true], ["2026-10-01T18:00:00.000Z", 1, false]], "a carry whose hour nobody closed is written once as its own partial row");
});

test("a standby serve counts and writes nothing until it listens", async (t) => {
  const root = stateDir(t);
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null } as TraceGithub, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "standby-read", write: "standby-write" },
    pollMs: 50,
    log: (step, extra) => void rows.push({ step, ...extra }),
  };
  const server = buildServeServer(deps);
  const smoke = createServer((req, res) => void server.emit("request", req, res));
  await new Promise<void>((resolve) => smoke.listen(0, "127.0.0.1", resolve));
  const headers = { authorization: "Bearer standby-read" };
  assert.equal((await fetch(`http://127.0.0.1:${(smoke.address() as AddressInfo).port}/v1/version`, { headers })).status, 200, "the standby answers a smoke read");
  await new Promise<void>((resolve) => smoke.close(() => resolve()));
  const file = join(root, "state", ROUTE_READS_FILE);
  assert.equal(existsSync(file), false, "a standby writes no rollup state");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/version`, { headers })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(rows.filter((r) => r.step === "serve.route_reads").length, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).carry.row.routes, { "/v1/version": { fleet: 1 } }, "only the promoted generation's read is counted");
});

test("two drains in one hour leave one carry and a rollup with no state file writes its partial row", (t) => {
  const dir = stateDir(t);
  const first = harness(dir, "2026-10-01T10:05:00Z");
  const stopFirst = first.rollup.start();
  first.rollup.count("/v1/status", "fleet");
  first.at("2026-10-01T10:10:00Z");
  stopFirst();
  const second = harness(dir, "2026-10-01T10:20:00Z");
  const stopSecond = second.rollup.start();
  second.rollup.count("/v1/status", "console");
  second.at("2026-10-01T10:25:00Z");
  stopSecond();
  const carry = JSON.parse(readFileSync(join(dir, ROUTE_READS_FILE), "utf8")).carry;
  assert.deepEqual([carry.row.reads, carry.row.window_start, carry.row.routes], [2, "2026-10-01T10:05:00.000Z", { "/v1/status": { console: 1, fleet: 1 } }]);
  assert.deepEqual(carry.last["/v1/status"], { fleet: "2026-10-01T10:05:00.000Z", console: "2026-10-01T10:20:00.000Z" });

  const blind = harness(undefined, "2026-10-01T10:00:00Z");
  const stopBlind = blind.rollup.start();
  blind.rollup.count("/v1/status", "fleet");
  stopBlind();
  assert.deepEqual(blind.rows.map((r) => [r.reads, r.partial]), [[1, true]], "with nowhere to hand it, the partial hour is written once");
  assert.equal(blind.rollup.summary().routes[0]!.fleet!.reads, 1);
});
