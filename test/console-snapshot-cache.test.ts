import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import {
  CONSOLE_SNAPSHOT_VIEWER_IDLE_MS,
  createConsoleSnapshotCache,
  createConsoleWriteGeneration,
  invalidateSnapshotsOnWrite,
  type ConsoleResponseStaleness,
} from "../src/lib/console-snapshot-cache.js";
import { boundConsoleReadRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";

class Capture {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = { ...this.headers, ...(headers ?? {}) };
    return this;
  }
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  end(chunk?: unknown): this {
    if (chunk !== undefined) this.body += String(chunk);
    return this;
  }
  json(): Record<string, unknown> & { staleness: ConsoleResponseStaleness } {
    return JSON.parse(this.body);
  }
}

function manualClock(start = 1_790_000_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    date: () => fixedClock(now).date(),
    iso: () => fixedClock(now).iso(),
    advance: (ms: number) => void (now += ms),
  };
}

function reqOf(url: string, headers: Record<string, string> = { authorization: "Bearer reader-a" }): IncomingMessage {
  return { method: "GET", url, headers } as unknown as IncomingMessage;
}

function countingRoute(path: string, body: () => unknown = () => ({ entries: [] })): Route & { calls: number } {
  const route = {
    method: "GET" as const,
    path,
    scope: "read" as const,
    calls: 0,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      route.calls += 1;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body()));
    },
  };
  return route;
}

async function read(handler: Route["handler"], req: IncomingMessage): Promise<Capture> {
  const res = new Capture();
  await handler(req, res as unknown as ServerResponse, { params: {} });
  return res;
}

function manualTimers(): { setTimer: (run: () => void, ms: number) => void; pending: Array<{ run: () => void; ms: number }> } {
  const pending: Array<{ run: () => void; ms: number }> = [];
  return { setTimer: (run, ms) => void pending.push({ run, ms }), pending };
}

const fallbackBody = (staleness: ConsoleResponseStaleness) => ({ entries: [], staleness });

test("a fresh console buffer is served without running the route handler", async () => {
  const clock = manualClock();
  const route = countingRoute("/v1/recent", () => ({ entries: [{ id: "one" }] }));
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, minRefreshMs: 2_000, setTimer: () => {} });
  await read(cache.handler, reqOf("/v1/recent"));
  clock.advance(1_500);
  const second = await read(cache.handler, reqOf("/v1/recent"));
  assert.equal(route.calls, 1);
  assert.deepEqual(second.json().entries, [{ id: "one" }]);
  assert.equal(second.json().staleness.stale, false);
  assert.equal(second.json().staleness.ageMs, 1_500);
  assert.equal(second.headers["x-rmd-cache-age-ms"], "1500");
  assert.equal(second.headers["x-rmd-generated-at"], second.json().staleness.generatedAt);
});

test("a stale buffer is answered first and its refresh runs after the response", async () => {
  const clock = manualClock();
  let version = 1;
  const route = countingRoute("/v1/status", () => ({ version }));
  const deferred: Array<() => void> = [];
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, minRefreshMs: 2_000, defer: (run) => void deferred.push(run), setTimer: () => {} });
  await read(cache.handler, reqOf("/v1/status"));
  version = 2;
  clock.advance(2_000);
  const answered = await read(cache.handler, reqOf("/v1/status"));
  assert.equal(answered.json().version, 1, "the older buffer is the answer");
  assert.equal(answered.json().staleness.refreshing, true);
  assert.equal(route.calls, 1, "no compute ran on the request's stack");
  assert.equal(deferred.length, 1);
  deferred[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(route.calls, 2);
  const after = await read(cache.handler, reqOf("/v1/status"));
  assert.equal(after.json().version, 2);
});

test("a viewed snapshot keeps itself warm and stops once its reader goes idle", async () => {
  const clock = manualClock();
  const timers = manualTimers();
  const route = countingRoute("/v1/recent");
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, minRefreshMs: 2_000, setTimer: timers.setTimer });
  await read(cache.handler, reqOf("/v1/recent"));
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, 2_000);
  clock.advance(2_000);
  timers.pending.shift()!.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(route.calls, 2, "the keep-warm timer refreshed with no request");
  assert.equal(timers.pending.length, 1, "and re-armed while the reader is recent");
  clock.advance(CONSOLE_SNAPSHOT_VIEWER_IDLE_MS);
  timers.pending.shift()!.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(route.calls, 2, "an idle snapshot stops refreshing");
  assert.equal(timers.pending.length, 0);
});

test("a slow projection refreshes less often than its minimum interval", async () => {
  const clock = manualClock();
  const timers = manualTimers();
  const route: Route = {
    method: "GET",
    path: "/v1/feedback",
    scope: "read",
    handler: (_req, res) => {
      clock.advance(2_100);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  };
  const cache = createConsoleSnapshotCache(route, { budgetMs: 10_000, fallbackBody, clock, setTimer: timers.setTimer });
  const first = await read(cache.handler, reqOf("/v1/feedback"));
  assert.equal(timers.pending[0].ms, 21_000);
  assert.equal(first.json().staleness.stale, false);
});

test("a completed write makes the next read recompute", async () => {
  const clock = manualClock();
  const generation = createConsoleWriteGeneration();
  let entries = ["before"];
  const route = countingRoute("/v1/feedback", () => ({ entries }));
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, generation, setTimer: () => {} });
  const submit = invalidateSnapshotsOnWrite(
    { method: "POST", path: "/v1/feedback", scope: "write", tier: "low", handler: () => void (entries = ["before", "mine"]) },
    generation,
  );
  await read(cache.handler, reqOf("/v1/feedback"));
  await read(submit.handler, reqOf("/v1/feedback"));
  const after = await read(cache.handler, reqOf("/v1/feedback"));
  assert.deepEqual(after.json().entries, ["before", "mine"]);
  assert.equal(route.calls, 2);
  const get = countingRoute("/v1/recent");
  assert.equal(invalidateSnapshotsOnWrite(get, generation), get, "a GET route is never wrapped");
});

test("two readers of one path never share a snapshot", async () => {
  const route: Route & { calls: number } = countingRoute("/v1/feedback");
  route.handler = (req, res) => {
    route.calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url, reader: req.headers.authorization }));
  };
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock: manualClock(), setTimer: () => {} });
  const a = await read(cache.handler, reqOf("/v1/feedback"));
  const b = await read(cache.handler, reqOf("/v1/feedback", { authorization: "Bearer reader-b" }));
  const filtered = await read(cache.handler, reqOf("/v1/feedback?status=open"));
  assert.equal(a.json().reader, "Bearer reader-a");
  assert.equal(b.json().reader, "Bearer reader-b");
  assert.equal(filtered.json().url, "/v1/feedback?status=open");
  assert.equal(route.calls, 3);
});

test("a recap acknowledgement is always answered live", async () => {
  const route = countingRoute("/v1/status");
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock: manualClock(), setTimer: () => {} });
  await read(cache.handler, reqOf("/v1/status"));
  await read(cache.handler, reqOf("/v1/status", { authorization: "Bearer reader-a", "x-rmd-recap-ack": "1" }));
  assert.equal(route.calls, 2);
});

test("a failed refresh marks the served buffer stale with its reason", async () => {
  const clock = manualClock();
  let fail = false;
  const route: Route = {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: (_req, res) => {
      if (fail) throw new Error("ledger unreadable");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"entries":["kept"]}');
    },
  };
  const deferred: Array<() => void> = [];
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, defer: (run) => void deferred.push(run), setTimer: () => {} });
  await read(cache.handler, reqOf("/v1/recent"));
  fail = true;
  clock.advance(2_000);
  await read(cache.handler, reqOf("/v1/recent"));
  deferred[0]();
  await new Promise((resolve) => setImmediate(resolve));
  const after = await read(cache.handler, reqOf("/v1/recent"));
  assert.deepEqual(after.json().entries, ["kept"]);
  assert.equal(after.json().staleness.stale, true);
  assert.equal(after.json().staleness.reason, "ledger unreadable");
  assert.equal(after.headers["x-rmd-cache-state"], "stale");
});

test("a snapshot that outlived its reader is recomputed before it is served", async () => {
  const clock = manualClock();
  const route = countingRoute("/v1/recent");
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, setTimer: () => {} });
  await read(cache.handler, reqOf("/v1/recent"));
  clock.advance(CONSOLE_SNAPSHOT_VIEWER_IDLE_MS + 1);
  const res = await read(cache.handler, reqOf("/v1/recent"));
  assert.equal(route.calls, 2);
  assert.equal(res.json().staleness.ageMs, 0);
});

test("a route keeps a bounded number of reader snapshots", async () => {
  const clock = manualClock();
  const route = countingRoute("/v1/feedback");
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock, setTimer: () => {} });
  for (let i = 0; i < 17; i += 1) {
    await read(cache.handler, reqOf(`/v1/feedback?n=${i}`));
    clock.advance(1);
  }
  await read(cache.handler, reqOf("/v1/feedback?n=16"));
  assert.equal(route.calls, 17, "the newest snapshot is still cached");
  await read(cache.handler, reqOf("/v1/feedback?n=0"));
  assert.equal(route.calls, 18, "the least recently read snapshot was evicted");
});

test("a write through serve's bound routes invalidates its cached reads", async () => {
  let entries = ["old"];
  const recent = countingRoute("/v1/recent", () => ({ entries }));
  const kick: Route = { method: "POST", path: "/v1/kick", scope: "write", tier: "low", handler: () => void (entries = ["new"]) };
  const [get, post] = boundConsoleReadRoutes([recent, kick], {} as ServeDeps, 500);
  await read(get.handler, reqOf("/v1/recent"));
  assert.deepEqual((await read(get.handler, reqOf("/v1/recent"))).json().entries, ["old"]);
  await read(post.handler, reqOf("/v1/kick"));
  assert.deepEqual((await read(get.handler, reqOf("/v1/recent"))).json().entries, ["new"]);
});

test("a spliced staleness envelope parses to the same object a reparse would give", async () => {
  for (const raw of ['{"a":1,"staleness":"inner"}', "{}", " { }\n", '{"b":[1,{"c":2}]}\n', "[1,2]"]) {
    const route: Route = {
      method: "GET",
      path: "/v1/recent",
      scope: "read",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(raw);
      },
    };
    const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody, clock: manualClock(), setTimer: () => {} });
    const res = await read(cache.handler, reqOf("/v1/recent"));
    const parsed = JSON.parse(raw) as unknown;
    const { staleness: _inner, ...expected } = (Array.isArray(parsed) ? { value: parsed } : parsed) as Record<string, unknown>;
    const { staleness, ...rest } = res.json();
    assert.deepEqual(rest, expected, raw);
    assert.equal(staleness.status, "fresh", raw);
  }
});
