import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { CONSOLE_SNAPSHOT_REFRESH_STEP, createConsoleSnapshotCache } from "#src/lib/console-snapshot-cache.js";
import { boundConsoleReadRoutes, type ServeDeps } from "#src/lib/serve.js";
import type { Route } from "#src/lib/service.js";

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
}

const reqOf = (url: string): IncomingMessage => ({ method: "GET", url, headers: { authorization: "Bearer reader-a" } }) as unknown as IncomingMessage;

function statusRoute(handler: (res: ServerResponse) => Promise<void> | void): Route {
  return { method: "GET", path: "/v1/status", scope: "read", handler: (_req, res) => handler(res) };
}

function recorder(): { rows: Array<Record<string, unknown>>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const rows: Array<Record<string, unknown>> = [];
  return { rows, log: (step, extra) => { if (step === CONSOLE_SNAPSHOT_REFRESH_STEP) rows.push(extra ?? {}); } };
}

test("W1-T14682: a status refresh that throws is logged with its reason", async () => {
  const { rows, log } = recorder();
  const route = statusRoute(() => { throw new Error("board snapshot unreadable"); });
  const { handler } = createConsoleSnapshotCache(route, { budgetMs: 200, fallbackBody: () => ({ fallback: true }), log, instance: "wreckterra", minRefreshMs: 0 });
  const res = new Capture();
  await handler(reqOf("/v1/status"), res as unknown as ServerResponse, { params: {} });
  assert.equal(JSON.parse(res.body).fallback, true, "the read still answers with the fallback body");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.path, "/v1/status");
  assert.equal(rows[0]!.instance, "wreckterra");
  assert.equal(rows[0]!.outcome, "threw");
  assert.equal(rows[0]!.reason, "board snapshot unreadable");
  assert.equal(typeof rows[0]!.ms, "number");
});

test("W1-T14682: a refresh past the budget logs budget then its completion", async () => {
  const { rows, log } = recorder();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const route = statusRoute(async (res) => {
    await gate;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ live: true }));
  });
  const { handler } = createConsoleSnapshotCache(route, { budgetMs: 20, fallbackBody: () => ({ fallback: true }), log, minRefreshMs: 0 });
  const res = new Capture();
  await handler(reqOf("/v1/status"), res as unknown as ServerResponse, { params: {} });
  assert.equal(JSON.parse(res.body).fallback, true, "the deadline won, so the fallback answered");
  assert.deepEqual(rows.map((row) => row.outcome), ["budget"]);
  assert.equal(rows[0]!.instance, "core", "a route with no instance names core");
  assert.equal(rows[0]!.ms, 20);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rows.map((row) => row.outcome), ["budget", "ready"], "the late settle logs its own row");
});

test("W1-T14682: a bound instance read route logs its refreshes through serve's log under the instance name", async () => {
  const { rows, log } = recorder();
  const route = statusRoute((res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ live: true }));
  });
  const [bound] = boundConsoleReadRoutes([route], { log } as unknown as ServeDeps, 500, undefined, undefined, "oleyarcade");
  const res = new Capture();
  await bound!.handler(reqOf("/v1/status"), res as unknown as ServerResponse, { params: {} });
  assert.equal(JSON.parse(res.body).live, true);
  assert.deepEqual(rows.map((row) => [row.instance, row.outcome]), [["oleyarcade", "ready"]]);
});
