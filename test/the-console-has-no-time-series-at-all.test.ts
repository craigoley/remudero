import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConsoleTimeSeries,
  buildShellRoute,
  DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS,
  renderConsoleTimeSeriesHtml,
  renderShellHtml,
  unreadableConsoleTimeSeries,
} from "../src/lib/serve.js";

const NOW_MS = Date.parse("2026-09-08T12:00:00.000Z");

function row(ts: string, over: Record<string, unknown>): Record<string, unknown> {
  return { ts, ...over };
}

function renderShellWithLedger(lines: ReadonlyArray<Record<string, unknown>>): string {
  let body = "";
  const route = buildShellRoute(
    DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS,
    "1234567890abcdef",
    {
      ledgerPath: "fixture-ledger.ndjson",
      readLedger: () => lines,
      now: () => new Date(NOW_MS),
    },
    { armed: false },
    () => "1234567890abcdef",
  );
  const res = {
    writeHead() {
      return this;
    },
    end(chunk?: unknown) {
      body += chunk === undefined ? "" : String(chunk);
      return this;
    },
  };
  route.handler({} as never, res as never, { params: {} });
  return body;
}

test("console time series: renders bounded inline SVG with no external chart dependency", () => {
  const html = renderShellWithLedger([
    row("2026-09-08T10:05:00.000Z", { step: "implement.done", cost_usd: 0.25 }),
    row("2026-09-08T10:20:00.000Z", { step: "fix.done", cost_usd: 0.5 }),
    row("2026-09-08T10:35:00.000Z", { step: "github.wake.accepted" }),
  ]);

  assert.match(html, /<section id="time-series"/);
  assert.match(html, /<svg class="time-series-svg"/);
  assert.match(html, /<polyline class="time-series-line"/);
  assert.doesNotMatch(html, /<script[^>]+src=|<canvas|chart\.js/i);
});

test("console time series: every rendered series states its window and bucket", () => {
  const html = renderConsoleTimeSeriesHtml(
    buildConsoleTimeSeries([row("2026-09-08T10:05:00.000Z", { step: "github.wake.accepted" })], { nowMs: NOW_MS }),
  );

  assert.match(html, /data-time-series-window="86400000"/);
  assert.match(html, /data-time-series-bucket="900000"/);
  assert.match(html, /24h window · 15m buckets/);
  assert.match(html, /wake volume over 24h in 15m buckets/);
});

test("console time series: empty and unreadable series render as absent, never as flat zero", () => {
  const empty = renderConsoleTimeSeriesHtml(buildConsoleTimeSeries([], { nowMs: NOW_MS }));
  assert.match(empty, /ABSENT/);
  assert.match(empty, /not drawn as zero/);
  assert.doesNotMatch(empty, /<polyline/);

  const unreadable = renderConsoleTimeSeriesHtml(unreadableConsoleTimeSeries("EACCES", { nowMs: NOW_MS }));
  assert.match(unreadable, /ABSENT — time series ledger unreadable: EACCES/);
  assert.doesNotMatch(unreadable, /<polyline/);
});

test("console time series: 15m buckets keep a repeating sub-hourly event visible", () => {
  const lines = [
    row("2026-09-08T11:10:00.000Z", { step: "github.wake.accepted" }),
    row("2026-09-08T11:40:00.000Z", { step: "github.wake.accepted" }),
  ];
  const fine = buildConsoleTimeSeries(lines, { nowMs: NOW_MS, windowMs: 60 * 60 * 1000, bucketMs: 15 * 60 * 1000 });
  const daily = buildConsoleTimeSeries(lines, { nowMs: NOW_MS, windowMs: 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 });
  const fineWake = fine.series.find((s) => s.id === "wake-volume");
  const dailyWake = daily.series.find((s) => s.id === "wake-volume");

  assert.deepEqual(
    fineWake?.points.map((p) => p.value),
    [1, 1],
    "two half-hour-apart wakes must remain two visible buckets at the console bucket size",
  );
  assert.deepEqual(dailyWake?.points.map((p) => p.value), [2], "a daily bucket averages the same episode into one point");
  assert.equal((renderConsoleTimeSeriesHtml(fine).match(/class="time-series-point"/g) ?? []).length, 2);
  assert.equal((renderConsoleTimeSeriesHtml(daily).match(/class="time-series-point"/g) ?? []).length, 1);
});

test("renderShellHtml keeps the embedded client script parseable", () => {
  const scripts = [...renderShellHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  assert.ok(scripts.length > 0, "the shell must carry an inline client script");
  const largest = scripts.reduce((max, script) => (script.length > max.length ? script : max), "");
  assert.doesNotThrow(() => new Function(largest));
});
