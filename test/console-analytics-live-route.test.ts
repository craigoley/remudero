import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import {
  adaptLiveAnalyticsMetrics,
  type LiveAnalyticsMetrics,
} from "../src/lib/analytics-live-metrics.js";
import { buildAnalyticsRoute, deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";

function responseCapture(): { response: ServerResponse; status: () => number; body: () => unknown } {
  let code = 0;
  let raw = "";
  const response = {
    writeHead(next: number) {
      code = next;
    },
    end(chunk?: string) {
      raw = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { response, status: () => code, body: () => JSON.parse(raw) };
}

test("W1-T3807 criterion 1: a complete process-owned status snapshot yields queue.pending, including a measured zero, without credentials", () => {
  const metrics = adaptLiveAnalyticsMetrics({
    status: { generated_at: "2026-09-19T20:00:00.000Z", counts: { queued: 0 } },
    provider: {
      state: "selected",
      freshness: "fresh",
      observedAt: "2026-09-19T19:59:00.000Z",
      selected: { tightestRemainingPercent: 37 },
    },
  });
  assert.deepEqual(metrics.queue.pending, {
    state: "observed",
    value: 0,
    asOf: "2026-09-19T20:00:00.000Z",
  });
  assert.deepEqual(metrics.provider.allowance.remaining, {
    state: "observed",
    value: 37,
    asOf: "2026-09-19T19:59:00.000Z",
  });
});

test("W1-T3807 criterion 3: an analytics request performs no refresh, provider probe, credential read, or routing write", () => {
  let snapshotReads = 0;
  let liveReads = 0;
  const base = deriveAnalyticsSnapshot([], "2026-09-19T20:00:00.000Z");
  const live: LiveAnalyticsMetrics = adaptLiveAnalyticsMetrics({ status: { counts: { queued: 2 } } });
  const route = buildAnalyticsRoute({
    currentSnapshot: () => {
      snapshotReads += 1;
      return base;
    },
    currentLiveMetrics: () => {
      liveReads += 1;
      return live;
    },
  });
  const captured = responseCapture();
  route.handler({ url: "/v1/analytics", headers: {} } as unknown as IncomingMessage, captured.response, { params: {} });
  assert.equal(captured.status(), 200);
  assert.equal(snapshotReads, 1);
  assert.equal(liveReads, 1);
  const body = captured.body() as Record<string, any>;
  assert.equal(body.queue.pending.value, 2);
  assert.equal(body.provider.allowance.remaining.state, "not-probed");
});

test("W1-T3807 criterion 4: live unavailable and stale states remain explicit while queue and provider historical trends remain not-collected", () => {
  const unavailable = adaptLiveAnalyticsMetrics({
    status: { github_unreachable: true, generated_at: "2026-09-19T20:00:00.000Z" },
    provider: { state: "unknown", freshness: "unknown", reason: "unauthorized" },
  });
  assert.equal(unavailable.queue.pending.state, "unavailable");
  assert.equal(unavailable.provider.allowance.remaining.state, "unauthorized");
  assert.equal(unavailable.queue.trend.state, "not-collected");
  assert.equal(unavailable.provider.allowance.trend.state, "not-collected");

  const unreadable = adaptLiveAnalyticsMetrics({
    status: { generated_at: "2026-09-19T20:00:00.000Z", counts: {} },
  });
  assert.equal(unreadable.queue.pending.state, "unreadable");
  assert.equal(unreadable.queue.pending.reason, "status snapshot has no queued count");

  const stale = adaptLiveAnalyticsMetrics({
    status: { counts: { queued: 4 } },
    provider: { state: "selected", freshness: "stale", observedAt: "2026-09-19T18:00:00.000Z" },
  });
  assert.equal(stale.provider.allowance.remaining.state, "stale");
  assert.equal(stale.provider.allowance.remaining.value, undefined);
});
