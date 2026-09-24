import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureFeedback } from "../src/lib/feedback.js";
import { buildFeedbackInboxRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createConsoleSnapshotCache, ifNoneMatchHits, snapshotEtag, type ConsoleResponseStaleness } from "../src/lib/console-snapshot-cache.js";
import { boundConsoleReadRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { fakeGitHub } from "./helpers/fake-github.js";

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

function reqOf(url: string, headers: Record<string, string> = { authorization: "Bearer reader-a" }): IncomingMessage {
  return { method: "GET", url, headers } as unknown as IncomingMessage;
}

async function read(handler: Route["handler"], req: IncomingMessage): Promise<Capture> {
  const res = new Capture();
  await handler(req, res as unknown as ServerResponse, { params: {} });
  return res;
}

function countingRoute(path: string, body: () => unknown): Route & { calls: number } {
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


test("a second feedback read within its refresh interval does not list feedback again", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-snapshot-feedback-"));
  captureFeedback(root, { raw: "first", origin: "cli", id: "fb-snap-1" });
  const deps = { root, planPath: join(root, "plan", "tasks.yaml"), statusGithub: fakeGitHub() } as unknown as PanelGraphDeps;
  const [route] = boundConsoleReadRoutes([buildFeedbackInboxRoute(deps)], {} as ServeDeps, 5_000);
  const first = await read(route.handler, reqOf("/v1/feedback"));
  assert.deepEqual((first.json().entries as Array<{ id: string }>).map((e) => e.id), ["fb-snap-1"]);
  captureFeedback(root, { raw: "second", origin: "cli", id: "fb-snap-2" });
  const second = await read(route.handler, reqOf("/v1/feedback"));
  assert.deepEqual((second.json().entries as Array<{ id: string }>).map((e) => e.id), ["fb-snap-1"], "the store was not listed again");
  assert.equal(second.json().staleness.stale, false);
});

test("operator activity is answered from the console snapshot cache", async () => {
  const activity = countingRoute("/v1/operator-activity", () => ({ version: "operator-activity-v1", state: "verified", items: [] }));
  const [route] = boundConsoleReadRoutes([activity], {} as ServeDeps, 500);
  await read(route.handler, reqOf("/v1/operator-activity"));
  const second = await read(route.handler, reqOf("/v1/operator-activity"));
  assert.equal(activity.calls, 1);
  assert.equal(second.json().state, "verified");
  assert.equal(second.headers["x-rmd-cache-state"], "fresh");
});

test("cold feedback and operator activity reads fall back to route-shaped bodies", async () => {
  const never = (path: string): Route => ({ method: "GET", path, scope: "read", handler: () => new Promise<void>(() => {}) });
  const [feedback, activity] = boundConsoleReadRoutes([never("/v1/feedback"), never("/v1/operator-activity")], {} as ServeDeps, 5);
  const f = (await read(feedback.handler, reqOf("/v1/feedback"))).json();
  assert.deepEqual(f.entries, []);
  assert.equal(f.staleness.status, "unavailable");
  const a = (await read(activity.handler, reqOf("/v1/operator-activity"))).json();
  assert.equal(a.version, "operator-activity-v1");
  assert.equal(a.state, "not-collected");
  assert.equal(a.reason, "not-yet-collected");
});

test("an unchanged cached body answers 304 to its own etag", async () => {
  let version = 1;
  const inbox = countingRoute("/v1/inbox", () => ({ ready: [version] }));
  const deferred: Array<() => void> = [];
  const cache = createConsoleSnapshotCache(inbox, { budgetMs: 50, fallbackBody: (staleness) => ({ staleness }), minRefreshMs: 0, defer: (run) => void deferred.push(run), setTimer: () => {} });
  const first = await read(cache.handler, reqOf("/v1/inbox"));
  const etag = first.headers.etag;
  assert.equal(etag, snapshotEtag(JSON.stringify({ ready: [1] })));
  const revalidated = await read(cache.handler, reqOf("/v1/inbox", { authorization: "Bearer reader-a", "if-none-match": etag }));
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body, "");
  assert.equal(revalidated.headers.etag, etag);
  assert.equal(revalidated.headers["content-type"], undefined);
  assert.ok(revalidated.headers["x-rmd-cache-age-ms"], "a 304 still says how old the snapshot is");
  for (const run of deferred.splice(0)) run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await read(cache.handler, reqOf("/v1/inbox", { authorization: "Bearer reader-a", "if-none-match": etag }))).status, 304, "a recompute with the same bytes keeps its etag");
  version = 2;
  for (const run of deferred.splice(0)) run();
  await new Promise((resolve) => setImmediate(resolve));
  const changed = await read(cache.handler, reqOf("/v1/inbox", { authorization: "Bearer reader-a", "if-none-match": etag }));
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.json().ready, [2]);
  assert.notEqual(changed.headers.etag, etag);
});

test("a non-200 cached body never answers 304", async () => {
  const route: Route = {
    method: "GET",
    path: "/v1/feedback",
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":"invalid_request"}');
    },
  };
  const cache = createConsoleSnapshotCache(route, { budgetMs: 50, fallbackBody: (staleness) => ({ staleness }), setTimer: () => {} });
  const first = await read(cache.handler, reqOf("/v1/feedback?status=nope"));
  const again = await read(cache.handler, reqOf("/v1/feedback?status=nope", { authorization: "Bearer reader-a", "if-none-match": first.headers.etag }));
  assert.equal(again.status, 400);
});

test("If-None-Match matching is a weak comparison over a tag list", () => {
  assert.equal(ifNoneMatchHits('"a", W/"b"', 'W/"b"'), true);
  assert.equal(ifNoneMatchHits(['"x"', '"a"'], 'W/"a"'), true);
  assert.equal(ifNoneMatchHits("*", 'W/"a"'), true);
  assert.equal(ifNoneMatchHits('"c"', 'W/"a"'), false);
  assert.equal(ifNoneMatchHits(undefined, 'W/"a"'), false);
  assert.equal(ifNoneMatchHits('"a"', undefined), false);
});
