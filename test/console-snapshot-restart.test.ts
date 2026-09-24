import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { CONSOLE_SNAPSHOT_PERSIST_MIN_MS, createConsoleSnapshotCache, prewarmReadRoutes, type ConsoleResponseStaleness } from "../src/lib/console-snapshot-cache.js";
import { CONSOLE_SNAPSHOT_CONTRACT, createConsoleSnapshotStore } from "../src/lib/console-snapshot-store.js";
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
  return { now: () => now, date: () => fixedClock(now).date(), iso: () => fixedClock(now).iso(), advance: (ms) => void (now += ms) };
}

const reqOf = (url: string): IncomingMessage => ({ method: "GET", url, headers: { authorization: "Bearer reader-a" } }) as unknown as IncomingMessage;

async function read(handler: Route["handler"], url: string): Promise<Capture> {
  const res = new Capture();
  await handler(reqOf(url), res as unknown as ServerResponse, { params: {} });
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body()));
    },
  };
  return route;
}

const fallbackBody = (staleness: ConsoleResponseStaleness) => ({ staleness });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function persisted(dir: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    try {
      if (readdirSync(dir).some((name) => name.endsWith(".json"))) return;
    } catch {
      // not created yet
    }
    await settle();
  }
  throw new Error(`no snapshot was persisted under ${dir}`);
}
const snapshotDir = () => join(mkdtempSync(join(tmpdir(), "rmd-console-snapshots-")), "console-snapshots");

test("a restarted serve answers its first console read from the persisted snapshot", async () => {
  const dir = snapshotDir();
  const clock = manualClock();
  const before = countingRoute("/v1/feedback", () => ({ entries: ["kept"] }));
  const first = createConsoleSnapshotCache(before, { budgetMs: 50, fallbackBody, clock, setTimer: () => {}, store: createConsoleSnapshotStore({ dir, codeRev: "sha-before", clock }) });
  await read(first.handler, "/v1/feedback");
  await persisted(dir);

  clock.advance(90_000);
  const after = countingRoute("/v1/feedback", () => ({ entries: ["kept", "new"] }));
  const deferred: Array<() => void> = [];
  const restarted = createConsoleSnapshotCache(after, {
    budgetMs: 50,
    fallbackBody,
    clock,
    setTimer: () => {},
    defer: (run) => void deferred.push(run),
    store: createConsoleSnapshotStore({ dir, codeRev: "sha-after", clock }),
  });
  const res = await read(restarted.handler, "/v1/feedback");
  assert.deepEqual(res.json().entries, ["kept"], "the persisted body answered");
  assert.equal(after.calls, 0, "no compute ran before the answer");
  assert.equal(res.json().staleness.stale, true);
  assert.equal(res.json().staleness.ageMs, 90_000, "labelled with its true age");
  assert.match(String(res.json().staleness.reason), /restored from before a serve restart \(code sha-before\)/);
  assert.equal(deferred.length, 1, "a refresh is queued behind the answer");
  deferred[0]();
  await settle();
  const fresh = await read(restarted.handler, "/v1/feedback");
  assert.deepEqual(fresh.json().entries, ["kept", "new"]);
  assert.equal(fresh.json().staleness.reason, undefined);
});

test("a snapshot from another contract version is not restored", async () => {
  const dir = snapshotDir();
  const clock = manualClock();
  const store = createConsoleSnapshotStore({ dir, codeRev: "a", clock });
  await store.save("/v1/recent", "k", { status: 200, headers: {}, body: "{}", generatedAtMs: clock.now() });
  const [file] = readdirSync(dir);
  const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), JSON.stringify({ ...record, contract: CONSOLE_SNAPSHOT_CONTRACT + 1 }));
  writeFileSync(join(dir, "corrupt.json"), "{not json");
  const lines: string[] = [];
  const reopened = createConsoleSnapshotStore({ dir, codeRev: "b", clock, log: (step) => lines.push(step) });
  assert.deepEqual(await reopened.restore("/v1/recent"), []);
  assert.deepEqual(lines, ["serve.console_snapshot_restore_failed"], "the corrupt file is reported, not thrown");
});

test("a snapshot older than a day is not restored", async () => {
  const dir = snapshotDir();
  const clock = manualClock();
  await createConsoleSnapshotStore({ dir, codeRev: "a", clock }).save("/v1/recent", "k", { status: 200, headers: {}, body: "{}", generatedAtMs: clock.now() });
  clock.advance(25 * 60 * 60 * 1000);
  assert.deepEqual(await createConsoleSnapshotStore({ dir, codeRev: "a", clock }).restore("/v1/recent"), []);
});

test("a snapshot over its size bound is not written", async () => {
  const dir = snapshotDir();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const store = createConsoleSnapshotStore({ dir, codeRev: "a", maxBytes: 100, log: (step, extra) => lines.push({ step, extra }) });
  await store.save("/v1/inbox", "k", { status: 200, headers: {}, body: "x".repeat(200), generatedAtMs: 1 });
  assert.equal(lines[0].step, "serve.console_snapshot_too_large");
  assert.deepEqual(await store.restore("/v1/inbox"), []);
});

test("an unwritable snapshot directory is reported and leaves nothing staged", async () => {
  const parent = mkdtempSync(join(tmpdir(), "rmd-console-snapshots-file-"));
  const dir = join(parent, "not-a-dir");
  writeFileSync(dir, "a file where the directory should be");
  const lines: string[] = [];
  const store = createConsoleSnapshotStore({ dir, codeRev: "a", log: (step) => lines.push(step) });
  await store.save("/v1/recent", "k", { status: 200, headers: {}, body: "{}", generatedAtMs: 1 });
  assert.deepEqual(await store.restore("/v1/recent"), []);
  assert.deepEqual(lines, ["serve.console_snapshot_save_failed", "serve.console_snapshot_restore_failed"]);
  assert.deepEqual(readdirSync(parent), ["not-a-dir"]);
});

test("a changed snapshot is persisted at most once per interval", async () => {
  const saves: string[] = [];
  const clock = manualClock();
  let n = 0;
  const route = countingRoute("/v1/recent", () => ({ n }));
  const deferred: Array<() => void> = [];
  const cache = createConsoleSnapshotCache(route, {
    budgetMs: 50,
    fallbackBody,
    clock,
    minRefreshMs: 1_000,
    setTimer: () => {},
    defer: (run) => void deferred.push(run),
    store: { restore: async () => [], save: async (_path, _key, cached) => void saves.push(cached.body) },
  });
  await read(cache.handler, "/v1/recent");
  const refreshAfter = async (ms: number) => {
    clock.advance(ms);
    n += 1;
    await read(cache.handler, "/v1/recent");
    for (const run of deferred.splice(0)) run();
    await settle();
  };
  await refreshAfter(1_000);
  assert.deepEqual(saves, ['{"n":0}'], "a change inside the interval is not written");
  await refreshAfter(CONSOLE_SNAPSHOT_PERSIST_MIN_MS);
  assert.deepEqual(saves, ['{"n":0}', '{"n":2}']);
});

test("boot prewarm runs each named read route once before any reader", async () => {
  const activity = countingRoute("/v1/operator-activity", () => ({}));
  const results = countingRoute("/v1/action-results", () => ({}));
  const failing: Route = { method: "GET", path: "/v1/broken", scope: "read", handler: () => { throw new Error("boom"); } };
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await prewarmReadRoutes([activity, results, failing], ["/v1/operator-activity", "/v1/action-results", "/v1/broken", "/v1/absent"], (step, extra) => lines.push({ step, extra }));
  assert.equal(activity.calls, 1);
  assert.equal(results.calls, 1);
  assert.deepEqual(lines.map((l) => [l.step, l.extra.path]), [
    ["serve.boot_prewarm", "/v1/operator-activity"],
    ["serve.boot_prewarm", "/v1/action-results"],
    ["serve.boot_prewarm_failed", "/v1/broken"],
  ]);
});

test("serve's bound console reads persist and restore through the snapshot directory", async () => {
  const dir = snapshotDir();
  const deps = { consoleSnapshots: { dir }, consoleSha: "sha-1" } as unknown as ServeDeps;
  const recent = countingRoute("/v1/recent", () => ({ entries: ["one"] }));
  const [bound] = boundConsoleReadRoutes([recent], deps, 500);
  await read(bound.handler, "/v1/recent");
  await persisted(dir);
  const [rebound] = boundConsoleReadRoutes([countingRoute("/v1/recent", () => ({ entries: ["two"] }))], deps, 500);
  const res = await read(rebound.handler, "/v1/recent");
  assert.deepEqual(res.json().entries, ["one"]);
  assert.match(String(res.json().staleness.reason), /code sha-1/);
});
