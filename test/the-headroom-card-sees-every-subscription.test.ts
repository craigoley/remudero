/**
 * W1-T4024 — the console's headroom card sees every subscription, and cash spend is money.
 *
 * The provider fixture is the SHAPE of the live snapshot read on 2026-09-22 (state/provider-routing-
 * status.json): claude selected with three windows, codex readable with one, codex carrying no
 * account label. The ledger fixture reproduces the measured double-count hazards — a `verdict` that
 * restates its run's worker cost and a `cost.anomaly` row — so the cash assertions have something to
 * get wrong.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { adaptLiveAnalyticsMetrics, type LiveProviderSnapshot } from "../src/lib/analytics-live-metrics.js";
import { buildAnalyticsRoute, createAnalyticsSnapshotCache, deriveAnalyticsSnapshot, type AnalyticsSnapshot } from "../src/lib/analytics-route.js";

const NOW = "2026-09-22T18:00:00.000Z";

function liveSnapshot(overrides: Partial<LiveProviderSnapshot> = {}): LiveProviderSnapshot {
  return {
    state: "selected",
    freshness: "fresh",
    observedAt: "2026-09-22T17:45:22.199Z",
    selected: { tightestRemainingPercent: 58 },
    providers: [
      {
        provider: "claude",
        accountLabel: "19ffed6f-0be2-478c-b0a9-8b3a06684a7b",
        readable: true,
        windows: [
          { name: "session (5h)", usedPercent: 2, resetsAt: "2026-09-22T22:30:00.490Z" },
          { name: "weekly (all models)", usedPercent: 42, resetsAt: "2026-09-27T05:00:00.000Z" },
          { name: "weekly (Fable)", usedPercent: 0, resetsAt: "2026-09-27T05:00:00.000Z" },
        ],
      },
      {
        provider: "codex",
        readable: true,
        windows: [{ name: "codex primary 10080m", usedPercent: 70, resetsAt: "2026-09-26T10:15:10.000Z" }],
      },
    ],
    ...overrides,
  };
}

/** Every key anywhere in a value — used to prove two units never share a field. */
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allKeys(item, into);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

test("W1-T4024: every snapshot window reaches the payload with its provider", () => {
  const accounts = adaptLiveAnalyticsMetrics({ provider: liveSnapshot() }).provider.accounts;
  assert.equal(accounts.state, "observed");
  assert.equal(accounts.asOf, "2026-09-22T17:45:22.199Z");
  const flat = accounts.accounts.flatMap((a) => a.windows.map((w) => `${a.provider}/${w.name}/${w.usedPercent}/${w.remainingPercent}`));
  assert.deepEqual(flat, [
    "claude/session (5h)/2/98",
    "claude/weekly (all models)/42/58",
    "claude/weekly (Fable)/0/100",
    "codex/codex primary 10080m/70/30",
  ]);
  const codex = accounts.accounts.find((a) => a.provider === "codex");
  assert.equal(codex?.accountLabel, undefined, "codex carried no account label; one must never be invented");
  assert.equal(codex?.windows[0].resetsAt, "2026-09-26T10:15:10.000Z");

  // An unreadable window keeps its NAME and loses its NUMBER — never drawn as 0% or 100%.
  const partial = adaptLiveAnalyticsMetrics({
    provider: liveSnapshot({ providers: [{ provider: "codex", readable: false, reason: "capacity-unreadable", windows: [{ name: "codex primary 10080m" }] }] }),
  }).provider.accounts.accounts[0];
  assert.equal(partial.readable, false);
  assert.deepEqual(partial.windows, [{ name: "codex primary 10080m" }]);
});

test("W1-T4024: windows of a provider that was not selected are not dropped", () => {
  const metrics = adaptLiveAnalyticsMetrics({ provider: liveSnapshot() });
  // CONTROL: the pre-existing scalar is unchanged — still the SELECTED provider's tightest window.
  assert.deepEqual(metrics.provider.allowance.remaining, { state: "observed", value: 58, asOf: "2026-09-22T17:45:22.199Z" });
  // THE DEFECT THIS TASK FIXES: codex was not selected and sits at 70% used, 30% left.
  const codex = metrics.provider.accounts.accounts.find((a) => a.provider === "codex");
  assert.ok(codex, "the non-selected provider must still be reported");
  assert.equal(codex.windows[0].remainingPercent, 30);
  assert.ok(codex.windows[0].remainingPercent < (metrics.provider.allowance.remaining.value ?? 0),
    "the scalar overstates headroom; the per-provider view is what shows the tighter lane");

  // A stale snapshot is reported stale, with its values and its as-of, never silently current.
  const stale = adaptLiveAnalyticsMetrics({ provider: liveSnapshot({ freshness: "stale" }) }).provider.accounts;
  assert.equal(stale.state, "stale");
  assert.equal(stale.accounts.length, 2);
});

test("W1-T4024: cash spend counts only cash-lane worker rows", () => {
  const lines = [
    { ts: "2026-09-22T10:00:00.000Z", step: "implement.done", run_id: "R1", provider: "cash", model: "gpt-5-nano", billing_mode: "api", total_cost_usd: 0.5 },
    { ts: "2026-09-22T11:00:00.000Z", step: "implement.done", run_id: "R2", provider: "cash", model: "gpt-5-nano", billing_mode: "api", total_cost_usd: 0.25 },
    // Restatements, as measured: neither carries `provider`.
    { ts: "2026-09-22T12:00:00.000Z", step: "verdict", run_id: "R1", model: "gpt-5-nano", total_cost_usd: 0.5 },
    { ts: "2026-09-22T12:00:00.000Z", step: "cost.anomaly", run_id: "R2", cost_usd: 0.25, total_cost_usd: 0.25 },
    // Another lane's money, and a fix-rung row that records no provider at all.
    { ts: "2026-09-22T12:00:00.000Z", step: "implement.done", run_id: "R3", provider: "claude", model: "claude-sonnet-5", billing_mode: "subscription", total_cost_usd: 3 },
    { ts: "2026-09-22T12:00:00.000Z", step: "fix.done", run_id: "R4", cost_usd: 9, billing_mode: "api" },
  ];
  // CONTROL: the fixture discriminates — a naive sum of every cost field is far from the right answer.
  const naive = lines.reduce((sum, line) => sum + ((line as { total_cost_usd?: number }).total_cost_usd ?? 0), 0);
  assert.equal(naive, 4.5);

  const cash = deriveAnalyticsSnapshot(lines, NOW).spend.cash;
  const week = cash.windows.find((w) => w.name === "7d");
  assert.equal(cash.state, "observed");
  assert.equal(week?.usd, 0.75, "only the two cash-lane implement.done rows");
  assert.equal(week?.rows, 2);
  assert.match(cash.coverage, /fix-rung/, "the reading states what it cannot attribute");
});

test("W1-T4024: window utilisation and money are separate units", () => {
  const live = adaptLiveAnalyticsMetrics({ provider: liveSnapshot() });
  const snapshot = deriveAnalyticsSnapshot(
    [{ ts: "2026-09-22T10:00:00.000Z", step: "implement.done", run_id: "R1", provider: "cash", total_cost_usd: 0.5 }],
    NOW,
  );
  assert.equal(snapshot.spend.cash.unit, "usd");
  const moneyKeys = allKeys(snapshot.spend);
  const percentKeys = allKeys(live.provider.accounts);
  assert.ok(moneyKeys.has("usd") && !moneyKeys.has("usedPercent") && !moneyKeys.has("remainingPercent"),
    "cash carries dollars and no percentage");
  assert.ok(percentKeys.has("usedPercent") && !percentKeys.has("usd"), "subscription windows carry percentages and no dollars");
});

test("W1-T4024: cash spend over a window older than the ledger is marked incomplete", () => {
  // Only three days of history retained: both windows start before it.
  const short = deriveAnalyticsSnapshot(
    [{ ts: "2026-09-20T09:00:00.000Z", step: "implement.done", run_id: "R1", provider: "cash", total_cost_usd: 0.1 }],
    NOW,
  ).spend.cash;
  for (const window of short.windows) {
    assert.equal(window.complete, false, `${window.name} starts before the oldest retained day`);
    assert.match(window.reason ?? "", /oldest retained day 2026-09-20/);
  }

  // CONTROL: with history reaching back past the 7-day start, the 7-day window IS complete — so the
  // flag above is doing work rather than always reading false.
  const long = deriveAnalyticsSnapshot(
    [
      { ts: "2026-09-10T09:00:00.000Z", step: "run.start", run_id: "R0" },
      { ts: "2026-09-20T09:00:00.000Z", step: "implement.done", run_id: "R1", provider: "cash", total_cost_usd: 0.1 },
    ],
    NOW,
  ).spend.cash;
  const week = long.windows.find((w) => w.name === "7d");
  const month = long.windows.find((w) => w.name === "30d");
  assert.equal(week?.complete, true);
  assert.equal(week?.reason, undefined);
  assert.equal(month?.complete, false, "the 30-day window still reaches past 2026-09-10");
});

function fakeResponse() {
  let status = 0;
  let body = "";
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { body = chunk ?? ""; if (!status) status = (res as { statusCode: number }).statusCode || 200; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

const ROUTE_LINES = [
  { ts: "2026-09-22T10:00:00.000Z", step: "run.start", run_id: "R1", type: "implement" },
  { ts: "2026-09-22T10:05:00.000Z", step: "implement.done", run_id: "R1", provider: "cash", model: "gpt-5-nano", total_cost_usd: 0.5 },
  { ts: "2026-09-22T10:06:00.000Z", step: "verdict", run_id: "R1", model: "gpt-5-nano", total_cost_usd: 0.5, verdict: "merged" },
];

test("W1-T4024: the console-signals-v1 projection carries headroom spend and series", async () => {
  const base = deriveAnalyticsSnapshot(ROUTE_LINES, NOW);
  const live = adaptLiveAnalyticsMetrics({ provider: liveSnapshot() });
  const route = buildAnalyticsRoute({ currentSnapshot: () => base, currentLiveMetrics: () => live });
  const { res, body } = fakeResponse();
  await route.handler({ url: "/v1/analytics?projectionVersion=console-signals-v1" } as never, res, { params: {} });
  const got = JSON.parse(body()) as Record<string, any>;
  assert.deepEqual(Object.keys(got).sort(), ["asOf", "provider", "queue", "routingTelemetry", "spend", "timeSeries", "version"],
    "exactly the signals the console lacks — nothing from the operator-agent block, no per-run arrays");
  assert.equal(got.version, "console-signals-v1");
  assert.ok(got.provider.accounts.accounts.some((a: { provider: string }) => a.provider === "codex"), "codex reaches the console");
  assert.equal(got.spend.cash.windows.find((w: { name: string }) => w.name === "7d").usd, 0.5);
  assert.deepEqual(got.timeSeries, JSON.parse(JSON.stringify(base.timeSeries)), "the same series the full snapshot serves");
  // BOUNDED: the reason this is a separate projection is size, so assert it stays small.
  assert.ok(Buffer.byteLength(body()) < 32 * 1024, `signals projection is ${Buffer.byteLength(body())} bytes`);
});

test("W1-T4024: the console-v1 envelope is unchanged", async () => {
  const base = deriveAnalyticsSnapshot(ROUTE_LINES, NOW);
  const route = buildAnalyticsRoute({ currentSnapshot: () => base, currentLiveMetrics: () => adaptLiveAnalyticsMetrics({ provider: liveSnapshot() }) });
  const { res, body } = fakeResponse();
  await route.handler({ url: "/v1/analytics?projectionVersion=console-v1" } as never, res, { params: {} });
  assert.deepEqual(JSON.parse(body()), JSON.parse(JSON.stringify(base.consoleV1)),
    "console-v1 must stay byte-identical: the new signals travel in their own projection");
});

test("W1-T4024: a refreshed snapshot freezes every provider window", async () => {
  // A refresh freezes whatever the reader returns. A snapshot carrying real provider accounts (a
  // checkpoint written after W1-T4024, or a reader that merges live metrics) must come back frozen
  // down to each window — the cold/derived path alone never carries accounts, so this is the arm
  // that exercises the per-account freeze.
  const base = deriveAnalyticsSnapshot([], NOW);
  const snapshot = structuredClone(base) as AnalyticsSnapshot;
  (snapshot as { dimensions: unknown }).dimensions = structuredClone(base.dimensions);
  (snapshot as { drilldowns: unknown }).drilldowns = structuredClone(base.drilldowns);
  snapshot.provider.accounts = adaptLiveAnalyticsMetrics({ provider: liveSnapshot() }).provider.accounts;
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-w1t4024-freeze-"));
  try {
    const cache = createAnalyticsSnapshotCache({ stateDir, readSnapshot: () => snapshot });
    await cache.refresh();
    const accounts = cache.current().provider.accounts;
    assert.equal(accounts.accounts.length, 2, "control: the refreshed value carries both providers");
    assert.ok(Object.isFrozen(accounts) && Object.isFrozen(accounts.accounts));
    for (const account of accounts.accounts) {
      assert.ok(Object.isFrozen(account), `${account.provider} is frozen`);
      assert.ok(Object.isFrozen(account.windows), `${account.provider}.windows is frozen`);
      for (const window of account.windows) assert.ok(Object.isFrozen(window), `${account.provider}/${window.name} is frozen`);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
