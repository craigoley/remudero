import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createServeDemand, recordServeRequest, SERVE_DEMAND_WINDOW_MS, SERVE_DEMAND_FAMILY_CAP } from "#src/lib/serve-demand.js";
import { buildServeServer, type ServeDeps } from "#src/lib/serve.js";
import { createService, type Route } from "#src/lib/service.js";
import { withTempDir } from "#src/lib/tmp.js";

function rows(path: string): Array<{ step: string; windowStart: number; windowEnd: number; families: Record<string, {
  n: number; ok: number; error: number; aborted: number; statuses: Record<string, number>; p50: number; p95: number; max: number;
}> }> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function response() {
  return Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
}

test("W1-T11814 criterion 1: finish and early close tally exactly once, with aborts separate from errors", async () => {
  await withTempDir("demand-events", async root => {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    let clock = 0;
    const demand = createServeDemand({ ledgerPath, routes: [{ method: "GET", path: "/v1/probe" }], now: () => clock });
    for (const [status, aborted, elapsed] of [[200, false, 5], [302, false, 10], [401, false, 25], [500, false, 50], [503, true, 100]] as const) {
      const res = response(); res.statusCode = status;
      res.once("finish", () => res.emit("close"));
      recordServeRequest(demand, { method: "GET", url: "/v1/probe?token=secret" } as IncomingMessage, res as unknown as ServerResponse);
      clock += elapsed;
      res.writableFinished = !aborted;
      res.emit(aborted ? "close" : "finish");
      res.emit("close"); res.emit("finish");
      assert.equal(res.listenerCount("close"), 0);
      assert.equal(res.listenerCount("finish"), 0);
    }
    clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
    assert.deepEqual(rows(ledgerPath)[0]!.families["/v1/probe"], {
      n: 5, ok: 2, error: 2, aborted: 1, statuses: { "1xx": 0, "2xx": 1, "3xx": 1, "4xx": 1, "5xx": 1 },
      p50: 25, p95: 100, max: 100,
    });
  });
});

test("W1-T11814 criterion 2: declared families redact instance and id segments, queries and unknown paths", async () => {
  await withTempDir("demand-families", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    let clock = 0;
    const routes = ["/v1/i/private-instance/task", "/v1/i/second-instance/task", "/v1/tasks/private-task", "/v1/runs/private-run", "/v1/items/private-id"]
      .map(path => ({ method: "GET", path }));
    const demand = createServeDemand({ ledgerPath, routes, now: () => clock });
    for (const route of routes) {
      const res = response();
      recordServeRequest(demand, { method: route.method, url: route.path + "?token=private-token&id=private-query" } as IncomingMessage, res as unknown as ServerResponse);
      res.writableFinished = true; res.emit("finish");
    }
    const unknown = response();
    recordServeRequest(demand, { method: "GET", url: "/v1/unknown/private-unknown?token=private-token" } as IncomingMessage, unknown as unknown as ServerResponse);
    unknown.writableFinished = true; unknown.emit("finish");
    clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
    const families = rows(ledgerPath)[0]!.families;
    assert.deepEqual(Object.keys(families).sort(), ["/v1/i/:instance/task", "/v1/items/:id", "/v1/runs/:id", "/v1/tasks/:id", "other"].sort());
    assert.equal(families["/v1/i/:instance/task"]!.n, 2);
    assert.equal(readFileSync(ledgerPath, "utf8").includes("private-"), false);
  });
});

test("W1-T11814 criterion 3: a nonempty five-minute window writes one row and resets its fixed histogram", async () => {
  await withTempDir("demand-windows", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    let clock = 10_000, tick: (() => void) | undefined, stopped = 0;
    const demand = createServeDemand({ ledgerPath, routes: [], now: () => clock, every: (fn, ms) => {
      assert.equal(ms, 300_000); tick = fn; return () => { stopped++; };
    } });
    const stop = demand.start();
    clock += SERVE_DEMAND_WINDOW_MS; tick!();
    assert.deepEqual(rows(ledgerPath), []);
    for (let i = 0; i < 100; i++) demand.record("other", 200, i < 95 ? 10 : 100, false);
    demand.record("other", 500, 120_001, true);
    assert.deepEqual(rows(ledgerPath), [], "requests never write ledger rows");
    clock += SERVE_DEMAND_WINDOW_MS; tick!(); tick!();
    const first = rows(ledgerPath);
    assert.equal(first.length, 1); assert.equal(first[0]!.step, "serve.demand");
    assert.equal(first[0]!.windowStart, 310_000); assert.equal(first[0]!.windowEnd, 610_000);
    assert.deepEqual(first[0]!.families.other, { n: 101, ok: 100, error: 0, aborted: 1,
      statuses: { "1xx": 0, "2xx": 100, "3xx": 0, "4xx": 0, "5xx": 0 }, p50: 10, p95: 100, max: 120_001 });
    clock += SERVE_DEMAND_WINDOW_MS; tick!(); assert.equal(rows(ledgerPath).length, 1);
    demand.record("other", 503, 3, false);
    clock += SERVE_DEMAND_WINDOW_MS; tick!(); stop();
    assert.equal(stopped, 1);
    assert.deepEqual(rows(ledgerPath)[1]!.families.other, { n: 1, ok: 0, error: 1, aborted: 0,
      statuses: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 1 }, p50: 3, p95: 3, max: 3 });
  });
});

test("W1-T11814 criterion 4: family and histogram storage stay bounded and observing a response only reads two clocks", async () => {
  await withTempDir("demand-bounds", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    let clock = 0, reads = 0;
    const demand = createServeDemand({ ledgerPath, routes: [{ method: "GET", path: "/v1/probe" }], now: () => { reads++; return clock; } });
    const res = response();
    const guarded = new Proxy(res, { set: () => assert.fail("observation must never mutate a response"), get: (target, key) => {
      if (["writeHead", "setHeader", "write", "end", "destroy"].includes(String(key))) assert.fail("observation touched response output");
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    reads = 0;
    recordServeRequest(demand, { method: "GET", url: "/v1/probe" } as IncomingMessage, guarded as unknown as ServerResponse);
    clock = 2; res.writableFinished = true; res.emit("finish"); res.emit("close");
    assert.equal(reads, 2);
    for (let i = 0; i < 10_000; i++) demand.record(`/v1/family-${i}`, 200, i, false);
    clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
    const families = rows(ledgerPath)[0]!.families;
    assert.equal(Object.keys(families).length, SERVE_DEMAND_FAMILY_CAP + 1);
    assert.equal(SERVE_DEMAND_FAMILY_CAP, 40);
    assert.equal(families.other!.n, 10_001 - 40);
    assert.equal(Object.values(families).reduce((sum, family) => sum + family.n, 0), 10_001);
    assert.ok(readFileSync(ledgerPath, "utf8").length < 15_000);
    reads = 0;
    recordServeRequest(demand, { method: "GET", url: "/health" } as IncomingMessage, guarded as unknown as ServerResponse);
    assert.equal(reads, 0); assert.equal(res.listenerCount("finish"), 0);
  });
});

test("a failed demand ledger write reports its reason and the next window can still be written", async t => {
  await withTempDir("demand-write-failure", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); mkdirSync(ledgerPath);
    let clock = 0;
    const failures: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const demand = createServeDemand({ ledgerPath, routes: [], now: () => clock,
      log: (step, extra) => { failures.push({ step, extra }); } });
    demand.record("other", 200, 1, false);
    clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
    assert.equal(failures.length, 1); assert.equal(failures[0]!.step, "serve.demand_write_failed");
    assert.match(String(failures[0]!.extra.reason), /EISDIR/);
    assert.equal(failures[0]!.extra.windowEnd, clock);
    const errorLog = t.mock.method(console, "error", () => {});
    let reporterClock = clock;
    const defaultReporter = createServeDemand({ ledgerPath, routes: [], now: () => reporterClock });
    defaultReporter.record("other", 200, 1, false);
    reporterClock += SERVE_DEMAND_WINDOW_MS; defaultReporter.flush();
    assert.equal(errorLog.mock.callCount(), 1);
    assert.equal(errorLog.mock.calls[0]!.arguments[0], "serve.demand_write_failed");
    assert.match(String(errorLog.mock.calls[0]!.arguments[1].reason), /EISDIR/);
    rmdirSync(ledgerPath); writeFileSync(ledgerPath, "");
    demand.record("other", 500, 2, false);
    clock += SERVE_DEMAND_WINDOW_MS; demand.flush();
    assert.equal(rows(ledgerPath).length, 1); assert.equal(rows(ledgerPath)[0]!.families.other!.error, 1);
    assert.equal(rows(ledgerPath)[0]!.windowStart, SERVE_DEMAND_WINDOW_MS);
  });
});

test("the default demand timer writes at five minutes, starts once, and stops idempotently", async t => {
  await withTempDir("demand-default-timer", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    let clock = 0;
    t.mock.timers.enable({ apis: ["setInterval"] });
    const demand = createServeDemand({ ledgerPath, routes: [], now: () => clock });
    const stop = demand.start(); demand.start();
    demand.record("other", 200, 1, false);
    t.mock.timers.tick(SERVE_DEMAND_WINDOW_MS - 1);
    assert.equal(rows(ledgerPath).length, 0);
    clock = SERVE_DEMAND_WINDOW_MS; t.mock.timers.tick(1);
    assert.equal(rows(ledgerPath).length, 1);
    assert.equal(rows(ledgerPath)[0]!.families.other!.n, 1);
    stop(); stop();
    demand.record("other", 200, 1, false);
    t.mock.timers.tick(SERVE_DEMAND_WINDOW_MS);
    assert.equal(rows(ledgerPath).length, 1);
    t.mock.timers.reset();
  });
});

test("declared SSE families and method matching follow the service router", async () => {
  await withTempDir("demand-sse", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    let clock = 0;
    const demand = createServeDemand({ ledgerPath, routes: [{ method: "POST", path: "/v1/probe" }],
      sse: [{ path: "/v1/status/stream" }], now: () => clock });
    for (const [method, url] of [["GET", "/v1/status/stream"], ["GET", "/v1/probe"], ["POST", "/v1/probe"], ["GET", "/v1"], ["GET", "/v10/secret"]]) {
      const res = response();
      recordServeRequest(demand, { method, url } as IncomingMessage, res as unknown as ServerResponse);
      res.emit("close");
    }
    clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
    const families = rows(ledgerPath)[0]!.families;
    assert.equal(families["/v1/status/stream"]!.aborted, 1);
    assert.equal(families["/v1/probe"]!.aborted, 1);
    assert.equal(families.other!.aborted, 2);
    assert.equal(Object.values(families).reduce((n, f) => n + f.n, 0), 4);
  });
});

test("real HTTP completion, handler failure, auth refusal and client cancellation reach the demand tally", async () => {
  await withTempDir("demand-http", async root => {
    const ledgerPath = join(root, "ledger.ndjson"); writeFileSync(ledgerPath, "");
    let clock = 0;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const routes: Route[] = [
      { method: "GET", path: "/v1/probe", scope: "read", handler: (_req, res) => { res.writeHead(201, { "x-probe": "unchanged" }); res.end("original"); } },
      { method: "GET", path: "/v1/error", scope: "read", handler: () => { throw new Error("test-handler-failure"); } },
      { method: "GET", path: "/v1/slow", scope: "read", handler: (_req, res) => { res.writeHead(200); res.write("partial"); entered(); } },
    ];
    const demand = createServeDemand({ ledgerPath, routes, now: () => clock });
    const server = createService({ tokens: { read: "r", write: "w" }, routes });
    server.prependListener("request", (req, res) => recordServeRequest(demand, req, res));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const good = await fetch(base + "/v1/probe", { headers: { authorization: "Bearer r" } });
      assert.equal(good.status, 201); assert.equal(good.headers.get("x-probe"), "unchanged"); assert.equal(await good.text(), "original");
      assert.equal((await fetch(base + "/v1/probe")).status, 401);
      assert.equal((await fetch(base + "/v1/error", { headers: { authorization: "Bearer r" } })).status, 500);
      assert.equal((await fetch(base + "/v1/unknown-secret")).status, 404);
      const closed = new Promise<void>(resolve => server.once("request", (_req, res) => res.once("close", resolve)));
      const req = request(base + "/v1/slow", { headers: { authorization: "Bearer r" } });
      req.on("response", res => res.on("error", () => {}));
      req.on("error", () => {}); req.end(); await pending; req.destroy(); await closed;
      clock = SERVE_DEMAND_WINDOW_MS; demand.flush();
      const families = rows(ledgerPath)[0]!.families;
      assert.equal(families["/v1/probe"]!.n, 2); assert.equal(families["/v1/probe"]!.error, 1);
      assert.equal(families["/v1/error"]!.error, 1);
      assert.equal(families.other!.n, 1);
      assert.equal(families["/v1/slow"]!.aborted, 1); assert.equal(families["/v1/slow"]!.error, 0);
      assert.equal(Object.values(families).reduce((sum, f) => sum + f.n, 0), 5);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test("serve production assembly records an answered request and stops its five-minute writer on close", async () => {
  await withTempDir("demand-serve", async root => {
    mkdirSync(join(root, "state"));
    const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan.yaml");
    writeFileSync(ledgerPath, ""); writeFileSync(planPath, "[]\n");
    let clock = 0, tick: (() => void) | undefined, stopped = false;
    const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const deps: ServeDeps = {
      ledgerPath, fleetControlRoot: root, questionsRoot: root,
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
      issues: { close() {} }, tokens: { read: "r", write: "w" },
      consoleSha: "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa", gatewayCheckout: async () => ({ state: "clean" }) as never,
      githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
      assistantRepository: "craigoley/remudero",
      demand: { now: () => clock, every: (fn, ms) => { assert.equal(ms, 300_000); tick = fn; return () => { stopped = true; }; } },
    };
    const server = buildServeServer(deps);
    assert.equal(tick, undefined, "a standby starts no demand writer");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/version?token=private-token`, { headers: { authorization: "Bearer r" } });
      assert.equal(result.status, 200); await result.text();
      clock = SERVE_DEMAND_WINDOW_MS; tick!();
      const demandRows = rows(ledgerPath).filter(row => row.step === "serve.demand");
      assert.equal(demandRows.length, 1); assert.equal(demandRows[0]!.families["/v1/version"]!.n, 1);
      assert.equal(demandRows[0]!.families["/v1/version"]!.ok, 1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    assert.equal(stopped, true);
  });
});
