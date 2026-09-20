import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";

const NOW = "2026-09-20T12:00:00.000Z";

test("W1-T3808 criterion 1: the producer returns five bounded ordered historical series with named windows and aggregations", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [
      { ts: "2026-09-19T10:00:00.000Z", step: "run.start", run_id: "run-1", task_id: "W1-T3808" },
      {
        ts: "2026-09-19T10:00:02.000Z",
        step: "verdict",
        run_id: "run-1",
        model: "gpt-5.6-luna",
        tokens: { input: 10, output: 5, cacheRead: 2, cacheCreation: 1 },
        total_cost_usd: 0.01,
      },
    ],
    NOW,
  );

  assert.deepEqual(snapshot.timeSeries.map((series) => series.id), [
    "runs.completed",
    "tokens.total",
    "cache.reuse",
    "cost.modeled.usd",
    "duration.p50.ms",
  ]);
  assert.ok(snapshot.timeSeries.every((series) => series.points.length <= 30));
  assert.ok(snapshot.timeSeries.every((series) => series.window.includes("/")));
  assert.ok(snapshot.timeSeries.every((series) => series.points.every((point, index, points) => index === 0 || point.t >= points[index - 1]!.t)));
});

test("W1-T3808 criterion 3: pre-collection, partial, missing, unreadable, and not-collected intervals remain explicit gaps", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [{ ts: "2026-09-19T10:00:00.000Z", step: "cli.invoked", verb: "status" }],
    NOW,
  );
  const completed = snapshot.timeSeries.find((series) => series.id === "runs.completed");
  const cache = snapshot.timeSeries.find((series) => series.id === "cache.reuse");
  assert.ok(completed?.points.some((point) => point.gap === true && point.note === "missing"));
  assert.ok(cache?.points.some((point) => point.gap === true && point.note === "not-collected"));
  assert.ok(snapshot.timeSeries.every((series) => series.points.every((point) => point.gap === true || point.value !== undefined)));
});

test("W1-T3808 criterion 4: queue and provider historical trends remain explicitly not-collected and no raw rows or task identifiers escape", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [{ ts: "2026-09-19T10:00:00.000Z", step: "run.start", run_id: "run-1", task_id: "secret-task" }],
    NOW,
  );
  assert.equal(snapshot.queue.trend.state, "not-collected");
  assert.equal(snapshot.provider.allowance.trend.state, "not-collected");
  assert.equal(JSON.stringify(snapshot.timeSeries).includes("secret-task"), false);
  assert.equal(JSON.stringify(snapshot.timeSeries).includes("run-1"), false);
});
