import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { SHARED_LAST_GOOD_REASON, createConsoleSnapshotCache, sharedKeyOfEntryKey, type BufferedRouteResponse } from "#src/lib/console-snapshot-cache.js";
import type { ConsoleSnapshotStore } from "#src/lib/console-snapshot-store.js";
import { boundConsoleReadRoutes, instanceStatusPrewarmPaths, statusBodyWithoutReader, type ServeDeps } from "#src/lib/serve.js";
import type { Route } from "#src/lib/service.js";

const URL_PATH = "/v1/i/wreckterra/status";

class Capture {
  status = 0;
  body = "";
  headers: Record<string, string> = {};
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
  json(): Record<string, unknown> & { staleness?: { status: string; reason?: string } } {
    return JSON.parse(this.body);
  }
}

const reqAs = (token: string, url = URL_PATH): IncomingMessage =>
  ({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;

/** A status route whose body carries a per-reader recap, and whose reads after the first hang until released. */
function statusRoute(): { route: Route; release: () => void } {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const route: Route = {
    method: "GET", path: "/v1/status", scope: "read",
    handler: async (req, res) => {
      reads += 1;
      if (reads > 1) await gate;
      const token = String(req.headers.authorization).slice("Bearer ".length);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ queue: ["W1-T1 building"], recap: [`recap for ${token}`], sinceCheckpoint: `checkpoint of ${token}` }));
    },
  };
  return { route, release };
}

async function read(handler: Route["handler"], req: IncomingMessage): Promise<Capture> {
  const res = new Capture();
  await handler(req, res as unknown as ServerResponse, { params: {} });
  return res;
}

test("W1-T14683: a one-off reader of an instance status gets the last good snapshot, not the fallback", async () => {
  const { route, release } = statusRoute();
  const [bound] = boundConsoleReadRoutes([route], {} as ServeDeps, 30);
  const first = await read(bound!.handler, reqAs("reader-a"));
  assert.deepEqual(first.json().queue, ["W1-T1 building"]);
  const later = await read(bound!.handler, reqAs("reader-b"));
  const body = later.json();
  assert.deepEqual(body.queue, ["W1-T1 building"], "reader B sees the live queue, not fallbackStatusSnapshot");
  assert.equal(body.staleness?.status, "stale");
  assert.equal(body.staleness?.reason, SHARED_LAST_GOOD_REASON);
  release();
});

test("W1-T14683: reader B's instance status response contains none of reader A's recap", async () => {
  const { route, release } = statusRoute();
  const [bound] = boundConsoleReadRoutes([route], {} as ServeDeps, 30);
  await read(bound!.handler, reqAs("reader-a"));
  const later = await read(bound!.handler, reqAs("reader-b"));
  assert.doesNotMatch(later.body, /reader-a/);
  assert.deepEqual(later.json().recap, []);
  assert.equal(later.json().sinceCheckpoint, undefined);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const own = await read(bound!.handler, reqAs("reader-b"));
  assert.deepEqual(own.json().recap, ["recap for reader-b"], "reader B's own read brings their recap");
});

test("W1-T14683: a body restored after a serve restart is shared with a new reader", async () => {
  const restoredBody = JSON.stringify({ queue: ["restored"], recap: ["recap for reader-a"], sinceCheckpoint: "a" });
  const cached: BufferedRouteResponse = { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: restoredBody, generatedAtMs: Date.now() - 5_000 };
  const store: ConsoleSnapshotStore = {
    restore: async () => [{ key: `reader-a ${URL_PATH}`, cached, codeRev: "abc123" }],
    save: async () => {},
  };
  const route: Route = { method: "GET", path: "/v1/status", scope: "read", handler: () => new Promise<void>(() => {}) };
  const { handler } = createConsoleSnapshotCache(route, { budgetMs: 20, fallbackBody: () => ({ fallback: true }), store, sharedBody: statusBodyWithoutReader, minRefreshMs: 0 });
  const res = await read(handler, reqAs("reader-c"));
  assert.deepEqual(res.json().queue, ["restored"]);
  assert.doesNotMatch(res.body, /reader-a/);
});

test("W1-T14683: a route without a sharer never hands one reader's body to another", async () => {
  const { route, release } = statusRoute();
  const { handler } = createConsoleSnapshotCache({ ...route, path: "/v1/feedback" }, { budgetMs: 20, fallbackBody: () => ({ fallback: true }), minRefreshMs: 0 });
  await read(handler, reqAs("reader-a", "/v1/feedback"));
  assert.equal((await read(handler, reqAs("reader-b", "/v1/feedback"))).json().fallback, true);
  release();
});

test("W1-T14683: a failed own read is named beside the shared body", async () => {
  let reads = 0;
  const route: Route = {
    method: "GET", path: "/v1/status", scope: "read",
    handler: async (_req, res) => {
      reads += 1;
      if (reads > 1) throw new Error("board unreadable");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ queue: ["live"], recap: [] }));
    },
  };
  const { handler } = createConsoleSnapshotCache(route, { budgetMs: 200, fallbackBody: () => ({ fallback: true }), sharedBody: statusBodyWithoutReader, minRefreshMs: 0 });
  await read(handler, reqAs("reader-a"));
  const res = await read(handler, reqAs("reader-b"));
  assert.deepEqual(res.json().queue, ["live"]);
  assert.match(String(res.json().staleness?.reason), /this reader's read failed: board unreadable/);
});

test("W1-T14683: only a JSON object status body is shared, and qualified keys share per url and qualification", () => {
  assert.equal(statusBodyWithoutReader("not json"), undefined);
  assert.equal(statusBodyWithoutReader("[1,2]"), undefined);
  assert.equal(statusBodyWithoutReader("null"), undefined);
  assert.deepEqual(JSON.parse(statusBodyWithoutReader(JSON.stringify({ a: 1, recap: ["x"], sinceCheckpoint: "y" }))!), { a: 1, recap: [] });
  assert.equal(sharedKeyOfEntryKey(`reader-a ${URL_PATH}`), URL_PATH);
  assert.equal(sharedKeyOfEntryKey(JSON.stringify([`reader-a ${URL_PATH}`, "q1"])), JSON.stringify([URL_PATH, "q1"]));
});

test("W1-T14683: boot prewarms every mounted instance's status and nothing else", () => {
  const route = (path: string, method: "GET" | "POST" = "GET"): Route => ({ method, path, scope: "read", handler: () => {} });
  assert.deepEqual(
    instanceStatusPrewarmPaths([route("/v1/status"), route(URL_PATH), route("/v1/i/oleyarcade/status"), route("/v1/i/wreckterra/inbox"), route("/v1/i/x/status", "POST")]),
    [URL_PATH, "/v1/i/oleyarcade/status"],
  );
});
