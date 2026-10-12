import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { createConsoleSnapshotCache, RouteResponseBuffer } from "../src/lib/console-snapshot-cache.js";
import { createConsoleSnapshotStore } from "../src/lib/console-snapshot-store.js";
import { bearerTokenId } from "../src/lib/panel-actions.js";
import type { Route } from "../src/lib/service.js";

const clock = fixedClock(1_790_000_000_000);
const request = { method: "GET", url: "/v1/status", headers: { authorization: "Bearer fixture-reader" } } as IncomingMessage;
const key = `${bearerTokenId(request)} /v1/status`;
const cold = { error: "board_unavailable", state: "unavailable", reason: "not_ready" };
const buffered = (status: number, body: unknown) => ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json" }, generatedAtMs: clock.now() });

function route(status: () => number): Route & { calls: number } {
  const result = {
    method: "GET" as const, path: "/v1/status", scope: "read" as const, calls: 0,
    handler(_req: IncomingMessage, res: ServerResponse) {
      result.calls++;
      const code = status();
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(code === 200 ? { state: "ready", measured: 7 } : cold));
    },
  };
  return result;
}

async function read(handler: Route["handler"]) {
  const output = new RouteResponseBuffer();
  await handler(request, output as unknown as ServerResponse, { params: {} });
  const captured = output.buffered(clock.now());
  return { ...captured, json: JSON.parse(captured.body) };
}

const options = { budgetMs: 50, clock, setTimer: () => {}, fallbackBody: () => ({ state: "unavailable" }) };

test("a restored unavailable console snapshot cannot fail the first read of a recovered generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-unavailable-snapshot-"));
  // Real disk store exercises legacy error rows left by an earlier serving generation.
  await createConsoleSnapshotStore({ dir, codeRev: "before", clock }).save("/v1/status", key, buffered(503, cold));
  const recovered = route(() => 200);
  const cache = createConsoleSnapshotCache(recovered, { ...options, store: createConsoleSnapshotStore({ dir, codeRev: "after", clock }) });
  const response = await read(cache.handler);
  assert.equal(response.status, 200);
  assert.equal(recovered.calls, 1, "the first smoke read verifies the current route within its existing budget");
  assert.equal(response.json.measured, 7);
  assert.equal(response.json.staleness.status, "fresh");
});

test("an unavailable console response is not persisted as a reusable data snapshot", async () => {
  const saves: number[] = [];
  let status = 503;
  const current = route(() => status);
  const cache = createConsoleSnapshotCache(current, {
    ...options, minRefreshMs: 0,
    store: { restore: async () => [], save: async (_path, _key, value) => { saves.push(value.status); } },
  });
  assert.equal((await read(cache.handler)).status, 503);
  assert.deepEqual(saves, [], "an error is a response receipt, not measured data to restore after a restart");
  status = 200;
  // A human acknowledgement uses the existing bounded refresh path, not a new retry policy.
  const output = new RouteResponseBuffer();
  await cache.handler({ method: "GET", url: "/v1/status", headers: { ...request.headers, "x-rmd-recap-ack": "1" } } as unknown as IncomingMessage, output as unknown as ServerResponse, { params: {} });
  assert.equal(output.statusCode, 200);
  assert.deepEqual(saves, [200], "a later actual success still persists normally");
});

test("an error console buffer is unavailable rather than fresh even when its response is recent", async () => {
  const cache = createConsoleSnapshotCache(route(() => 503), options);
  for (let i = 0; i < 2; i++) {
    const response = await read(cache.handler);
    assert.equal(response.status, 503);
    assert.deepEqual({ error: response.json.error, reason: response.json.reason }, { error: cold.error, reason: cold.reason });
    assert.equal(response.json.staleness.status, "unavailable");
    assert.equal(response.json.staleness.stale, true);
    assert.equal(response.json.measured, undefined, "no success-shaped numbers replace a real outage");
  }
});

test("ignoring a legacy error snapshot never converts a continuing live outage into success", async () => {
  const current = route(() => 503);
  const cache = createConsoleSnapshotCache(current, {
    ...options,
    store: { restore: async () => [{ key, cached: buffered(503, cold), codeRev: "before" }], save: async () => {} },
  });
  const response = await read(cache.handler);
  assert.equal(current.calls, 1);
  assert.equal(response.status, 503);
  assert.equal(response.json.reason, "not_ready");
  assert.equal(response.json.staleness.status, "unavailable");
});

test("a successful restored console snapshot retains stale-while-revalidate behavior", async () => {
  const current = route(() => 200);
  const cache = createConsoleSnapshotCache(current, {
    ...options,
    store: { restore: async () => [{ key, cached: buffered(200, { measured: 3 }), codeRev: "before" }], save: async () => {} },
  });
  const response = await read(cache.handler);
  assert.equal(response.status, 200);
  assert.equal(response.json.measured, 3);
  assert.equal(current.calls, 0, "a valid prior measurement still answers without blocking on recompute");
  assert.equal(response.json.staleness.status, "stale");
  assert.match(response.json.staleness.reason, /restored from before a serve restart/);
});
