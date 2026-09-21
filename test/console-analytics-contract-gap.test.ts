import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import {
  buildAnalyticsRoute,
  buildConsoleV1Metrics,
  CONSOLE_V1_METRIC_KEYS,
  CONSOLE_V1_PROJECTION_VERSION,
  deriveAnalyticsSnapshot,
  resolveConsoleV1Projection,
  type AnalyticsSnapshot,
  type ConsoleV1MeasurementClass,
} from "../src/lib/analytics-route.js";

/**
 * W1-T3623 — TWO CONTRACTS BOTH CALLED console-v1 AND THEY SHARE NO METRIC. The console's
 * analytics page asks `/v1/analytics` for `runs.completed`, `tokens.total`, `cache.reuse`,
 * `cost.modeled.usd`, `duration.p50.ms` and `queue.pending`; before this task the daemon answered
 * with a wholly disjoint set (`invocationsByVerb`, `workersByLaneModel`, …) under the SAME
 * version string, so every card read "Unavailable: not collected". These tests hold the four
 * acceptance criteria that close the gap without reopening the door the rationale names: a
 * measure this instance genuinely does not collect must keep saying so, never render as zero.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

// Two resolved runs (run.start -> verdict), each verdict line ALSO carrying the worker telemetry
// (model/tokens/total_cost_usd) exactly as worker.ts's `workerLedgerFields` spreads it onto a
// real ledger row — the same discriminator (`line.model !== undefined`) this module's
// accumulator already uses for `workersByLaneModel`.
const TWO_RUN_CORPUS: Array<Record<string, unknown>> = [
  { ts: "2026-08-14T00:00:00.000Z", task_id: "W1-T1", run_id: "R1", step: "run.start" },
  { ts: "2026-08-14T00:00:00.000Z", task_id: "W1-T2", run_id: "R2", step: "run.start" },
  {
    ts: "2026-08-14T00:00:01.000Z",
    task_id: "W1-T1",
    run_id: "R1",
    step: "verdict",
    lane: "run-task",
    model: "sonnet",
    total_cost_usd: 1.5,
    tokens: { input: 1000, output: 200, cacheRead: 500, cacheCreation: 50 },
  },
  {
    ts: "2026-08-14T00:00:03.000Z",
    task_id: "W1-T2",
    run_id: "R2",
    step: "verdict",
    lane: "triage",
    model: "opus",
    total_cost_usd: 2.5,
    tokens: { input: 2000, output: 300, cacheRead: 100, cacheCreation: 0 },
  },
];

// ── acceptance (i): the projection emits every metric key the console catalog names ────────────

test("console-v1 projection: emits every metric key the console catalog names, not a disjoint set", () => {
  const snapshot = deriveAnalyticsSnapshot([], "2026-08-14T00:00:00.000Z");
  const emittedKeys = snapshot.consoleV1.metrics.map((m) => m.key);
  assert.deepEqual(
    emittedKeys,
    [...CONSOLE_V1_METRIC_KEYS],
    "the daemon must answer with exactly the keys the console's own catalog names",
  );
  // The literal keys the console page asks for (W1-T3623's own title) — pinned here so a future
  // edit to CONSOLE_V1_METRIC_KEYS cannot silently drop one without this test noticing.
  assert.deepEqual(emittedKeys, [
    "runs.completed",
    "tokens.total",
    "cache.reuse",
    "cost.modeled.usd",
    "duration.p50.ms",
    "queue.pending",
  ]);
});

// ── acceptance (ii): an uncollected metric reads not collected, never a fabricated zero ────────

test("console-v1 projection: a genuinely uncollected metric is null with a reason, never a fabricated zero", () => {
  const cold = deriveAnalyticsSnapshot([], "2026-08-14T00:00:00.000Z");
  const byKey = Object.fromEntries(cold.consoleV1.metrics.map((m) => [m.key, m]));

  // No worker call: cache.reuse has a zero denominator -- NOT COLLECTED, not a fabricated 0% hit rate.
  assert.equal(byKey["cache.reuse"].value, null);
  assert.equal(typeof byKey["cache.reuse"].notCollectedReason, "string");
  // No resolved run: duration.p50.ms has no sample -- NOT COLLECTED, not a fabricated 0ms.
  assert.equal(byKey["duration.p50.ms"].value, null);
  assert.equal(typeof byKey["duration.p50.ms"].notCollectedReason, "string");
  // queue.pending is /v1/status's own live counter -- this route never observes it directly.
  assert.equal(byKey["queue.pending"].value, null);
  assert.equal(typeof byKey["queue.pending"].notCollectedReason, "string");

  // Contrast: counts a fresh instance genuinely HAS observed (zero calls, zero spend) render as
  // real zeros, not as "not collected" -- the distinction is deliberate, not a blanket null.
  assert.equal(byKey["runs.completed"].value, 0);
  assert.equal(byKey["runs.completed"].notCollectedReason, undefined);
  assert.equal(byKey["tokens.total"].value, 0);
  assert.equal(byKey["tokens.total"].notCollectedReason, undefined);
  assert.equal(byKey["cost.modeled.usd"].value, 0);
  assert.equal(byKey["cost.modeled.usd"].notCollectedReason, undefined);
});

test("console-v1 projection: once a corpus has real data, the previously-uncollected metrics resolve", () => {
  const snapshot = deriveAnalyticsSnapshot(TWO_RUN_CORPUS, "2026-08-14T00:10:00.000Z");
  const byKey = Object.fromEntries(snapshot.consoleV1.metrics.map((m) => [m.key, m]));

  assert.equal(byKey["runs.completed"].value, 2, "both R1 and R2 resolved run.start -> verdict");
  assert.equal(byKey["tokens.total"].value, 1750 + 2400, "sum of input+output+cacheRead+cacheCreation across both calls");
  const expectedCacheReuse = 600 / (600 + 3000 + 50); // cacheRead / (cacheRead + input + cacheCreation)
  assert.ok(
    Math.abs((byKey["cache.reuse"].value as number) - expectedCacheReuse) < 1e-9,
    "cache.reuse matches digest.ts's own cacheHitRatio formula",
  );
  assert.equal(byKey["cache.reuse"].notCollectedReason, undefined);
  assert.equal(byKey["cost.modeled.usd"].value, 4, "1.5 + 2.5 off total_cost_usd, never the cost_usd typo");
  assert.equal(byKey["duration.p50.ms"].value, 1000, "nearest-rank p50 of [1000ms, 3000ms] is the lower sample");
  // queue.pending stays not-collected even with a real corpus: this route has no live queue read.
  assert.equal(byKey["queue.pending"].value, null);
});

// ── acceptance (iii): every emitted metric names its measurement class ─────────────────────────
// (test title below is quoted verbatim by the PR body's proof for this criterion; keep in sync)

test("console-v1 projection: every emitted metric names its measurement class", () => {
  const VALID: ConsoleV1MeasurementClass[] = ["observed", "provider_reported", "modeled"];
  const snapshot = deriveAnalyticsSnapshot(TWO_RUN_CORPUS, "2026-08-14T00:10:00.000Z");
  for (const metric of snapshot.consoleV1.metrics) {
    assert.ok(VALID.includes(metric.class), `${metric.key} must name a valid measurement class, got ${metric.class}`);
  }
  const classByKey = Object.fromEntries(snapshot.consoleV1.metrics.map((m) => [m.key, m.class]));
  assert.deepEqual(classByKey, {
    "runs.completed": "observed",
    "tokens.total": "provider_reported",
    "cache.reuse": "modeled",
    "cost.modeled.usd": "modeled",
    "duration.p50.ms": "observed",
    "queue.pending": "observed",
  });
});

test("buildConsoleV1Metrics: pure — no measurement class is ever left implicit", () => {
  const metrics = buildConsoleV1Metrics({
    runsCompleted: 0,
    tokensTotal: 0,
    cacheReuseTokens: { input: 0, cacheRead: 0, cacheCreation: 0 },
    costModeledUsd: 0,
    taskDurationsMs: [],
  });
  assert.equal(metrics.length, CONSOLE_V1_METRIC_KEYS.length);
  for (const metric of metrics) assert.ok(metric.class, `${metric.key} carries no class`);
});

// ── acceptance (iv): an unrecognised projection version is refused, not answered disjoint ──────

test("resolveConsoleV1Projection: an unrecognised version is refused rather than answered with today's shape", () => {
  const snapshot = deriveAnalyticsSnapshot([], "2026-08-14T00:00:00.000Z");

  const refused = resolveConsoleV1Projection(snapshot, "console-v2");
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error, "unsupported_projection_version");
    assert.equal(refused.requestedVersion, "console-v2");
    assert.equal(refused.supportedVersion, CONSOLE_V1_PROJECTION_VERSION);
  }

  const matched = resolveConsoleV1Projection(snapshot, "console-v1");
  assert.equal(matched.ok, true);
  if (matched.ok) assert.deepEqual(matched.projection, snapshot.consoleV1);

  const unspecified = resolveConsoleV1Projection(snapshot, undefined);
  assert.equal(unspecified.ok, true, "no opinion from the caller resolves to this instance's own version, never a refusal");
});

// ── the route: version refusal reaches the wire, ordinary requests are unaffected ──────────────

function fakeResponse(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      body = chunk;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

test("GET /v1/analytics: an unrecognised ?projectionVersion= is refused with 409, not a 200 disjoint payload", async () => {
  const expected = deriveAnalyticsSnapshot(TWO_RUN_CORPUS, "2026-08-14T00:10:00.000Z");
  const route = buildAnalyticsRoute({ currentSnapshot: () => expected });
  const { res, status, body } = fakeResponse();

  await route.handler({ url: "/v1/analytics?projectionVersion=console-v2" } as never, res, { params: {} });

  assert.equal(status(), 409);
  const parsed = JSON.parse(body()) as { ok: boolean; error: string };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "unsupported_projection_version");
});

test("GET /v1/analytics: no ?projectionVersion= still answers 200 with the full snapshot, unchanged", async () => {
  const expected: AnalyticsSnapshot = deriveAnalyticsSnapshot(TWO_RUN_CORPUS, "2026-08-14T00:10:00.000Z");
  const route = buildAnalyticsRoute({ currentSnapshot: () => expected });
  const { res, status, body } = fakeResponse();

  await route.handler({} as never, res, { params: {} });

  assert.equal(status(), 200);
  assert.deepEqual(JSON.parse(body()), expected);
});

test("GET /v1/analytics: a matching ?projectionVersion=console-v1 answers 200 with the bounded console-v1 projection", async () => {
  const expected: AnalyticsSnapshot = deriveAnalyticsSnapshot(TWO_RUN_CORPUS, "2026-08-14T00:10:00.000Z");
  const route = buildAnalyticsRoute({ currentSnapshot: () => expected });
  const { res, status, body } = fakeResponse();

  await route.handler({ url: "/v1/analytics?projectionVersion=console-v1" } as never, res, { params: {} });

  assert.equal(status(), 200);
  assert.deepEqual(JSON.parse(body()), expected.consoleV1);
  assert.notDeepEqual(JSON.parse(body()), expected);
});
