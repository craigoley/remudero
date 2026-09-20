import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAnalyticsRoute, deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { createLiveAnalyticsSnapshotCache, readLiveStatusSnapshot } from "../src/lib/live-analytics-snapshot-cache.js";

function responseCapture(): { response: ServerResponse; body: () => unknown } {
  let raw = "";
  const response = {
    writeHead() {},
    end(chunk?: string) {
      raw = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { response, body: () => JSON.parse(raw) };
}

test("W1-T3807 follow-up: the status reader counts only queued task projections", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-live-analytics-"));
  mkdirSync(join(root, "state"));
  writeFileSync(
    join(root, "state", "status.json"),
    JSON.stringify({
      generated_at: "2026-09-20T02:00:00.000Z",
      tasks: {
        queuedA: { status: "queued" },
        queuedB: { status: "queued" },
        running: { status: "running" },
        merged: { status: "merged" },
      },
    }),
  );

  assert.deepEqual(readLiveStatusSnapshot(root), {
    generated_at: "2026-09-20T02:00:00.000Z",
    counts: { queued: 2 },
  });
});

test("W1-T3807 follow-up: the live cache refreshes queue and provider snapshots off the analytics request path", async () => {
  let statusReads = 0;
  let providerReads = 0;
  const cache = createLiveAnalyticsSnapshotCache({
    root: "/state",
    readStatus: () => {
      statusReads += 1;
      return { generated_at: "2026-09-20T02:00:00.000Z", counts: { queued: 0 } };
    },
    readProvider: () => {
      providerReads += 1;
      return {
        state: "selected",
        freshness: "fresh",
        observedAt: "2026-09-20T02:00:01.000Z",
        selected: { tightestRemainingPercent: 78 },
      };
    },
  });

  await cache.refresh();
  assert.equal(statusReads, 1);
  assert.equal(providerReads, 1);
  assert.deepEqual(cache.current().queue.pending, { state: "observed", value: 0, asOf: "2026-09-20T02:00:00.000Z" });
  assert.deepEqual(cache.current().provider.allowance.remaining, { state: "observed", value: 78, asOf: "2026-09-20T02:00:01.000Z" });

  const route = buildAnalyticsRoute({
    currentSnapshot: () => deriveAnalyticsSnapshot([], "2026-09-20T02:00:02.000Z"),
    currentLiveMetrics: cache.current,
  });
  const captured = responseCapture();
  route.handler({ url: "/v1/analytics", headers: {} } as unknown as IncomingMessage, captured.response, { params: {} });

  assert.equal(statusReads, 1, "the request reads only the in-memory live snapshot");
  assert.equal(providerReads, 1, "the request does not probe or reread provider state");
  const body = captured.body() as { queue: { pending: { value?: number } }; provider: { allowance: { remaining: { value?: number } } } };
  assert.equal(body.queue.pending.value, 0);
  assert.equal(body.provider.allowance.remaining.value, 78);
});
