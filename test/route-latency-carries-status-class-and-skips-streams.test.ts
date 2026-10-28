/** W1-T6371: serve's route latency histogram splits handler time by status class and never times a stream route. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { createRouteReadRollup } from "#src/lib/route-read-rollup.js";

function harness() {
  let monotonic = 0;
  const rollup = createRouteReadRollup({ clock: clockFromMillisFn(() => Date.parse("2026-10-01T10:05:00Z")), elapsed: () => monotonic });
  rollup.start();
  const hit = (path: string, ms: number, statusCode: number, contentType = "application/json"): void => {
    const res = Object.assign(new EventEmitter(), { statusCode, getHeader: (n: string) => (n === "content-type" ? contentType : undefined) });
    void rollup.wrap({ method: "GET", path, scope: "read", handler: () => { monotonic += ms; } })
      .handler({ headers: {}, url: `${path}?q=secret` } as unknown as IncomingMessage, res as unknown as ServerResponse, {} as never);
    res.emit("finish");
  };
  return { rollup, hit };
}

test("a 5xx and a 2xx on one route are counted in separate status classes, a stream route is never timed, and no recorded key holds a path parameter or query", () => {
  const h = harness();
  for (let i = 0; i < 9; i++) h.hit("/v1/views/now", 40, 200);
  h.hit("/v1/views/now", 0.2, 500);
  h.hit("/v1/views/now", 0.3, 304);
  h.hit("/v1/views/now", 0.3, 404);
  h.hit("/v1/views/events", 645_000, 200, "text/event-stream");
  h.hit("/v1/views/events", 645_000, 200, "application/json");

  const summary = h.rollup.summary();
  const now = summary.routes.find((r) => r.path === "/v1/views/now")!.latency!;
  assert.equal(now.n, 12, "the per-template total is unchanged");
  assert.deepEqual(Object.keys(now.statusClass!).sort(), ["2xx", "304", "4xx", "5xx"]);
  assert.deepEqual([now.statusClass!["2xx"]!.n, now.statusClass!["2xx"]!.p50Ms], [9, 40]);
  assert.deepEqual([now.statusClass!["5xx"]!.n, now.statusClass!["5xx"]!.p50Ms], [1, 0.2], "the fast 500 stays out of the 2xx histogram");

  assert.equal(summary.routes.find((r) => r.path === "/v1/views/events")!.latency, undefined, "a stream route is never timed, whatever header it sets");
  assert.equal(summary.viewLatency.n, 12, "viewLatency excludes the stream");
  assert.ok(summary.viewLatency.maxMs < 100);

  const keys = summary.routes.filter((r) => r.latency).map((r) => r.path);
  assert.deepEqual(keys, ["/v1/views/now"]);
  assert.ok(keys.every((k) => !k.includes("?") && !k.includes("secret")));
});
