/**
 * W1-T4453 — the console reads console-v1 and console-signals-v1, never the unversioned body, so the
 * routing-v1 summary must ride the signals projection or the console reports it as "not deployed".
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";

import { buildAnalyticsRoute, deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";

const NOW = "2026-09-24T12:00:00.000Z";

const LINES: Array<Record<string, unknown>> = [
  { ts: "2026-09-24T11:00:00.000Z", step: "run.start", run_id: "R1", type: "implement" },
  {
    ts: "2026-09-24T11:00:01.000Z",
    step: "worker.assignment",
    run_id: "R1",
    worker_assignment: {
      version: 1,
      id: "assignment-1",
      phase: "pre-execution",
      requested: { model: "sonnet", effort: "high", maxTurns: 400 },
      selected: { provider: "codex", model: "gpt-6-luna", effort: "high" },
      routing: { mode: "multi-provider", selectionPath: "auction", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
      candidates: [],
    },
  },
  { ts: "2026-09-24T11:30:00.000Z", step: "verdict", run_id: "R1", verdict: "merged", success: true, selection_assignment_id: "assignment-1", total_cost_usd: 0 },
];

function fakeResponse() {
  let body = "";
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead() { return this; },
    end(chunk?: string) { body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, body: () => body };
}

test("the console signals projection carries the routing telemetry snapshot", async () => {
  const base = deriveAnalyticsSnapshot(LINES, NOW);
  const route = buildAnalyticsRoute({ currentSnapshot: () => base });
  const { res, body } = fakeResponse();
  await route.handler({ url: "/v1/analytics?projectionVersion=console-signals-v1" } as never, res, { params: {} });
  const got = JSON.parse(body()) as { version: string; routingTelemetry?: Record<string, unknown> };
  assert.equal(got.version, "console-signals-v1", "the field is additive: the version string is unchanged");
  assert.ok(got.routingTelemetry, "routing-v1 reaches the projection the console actually reads");
  assert.equal(got.routingTelemetry.version, "routing-v1");
  assert.equal(got.routingTelemetry.evidenceState, "observed");
  assert.equal(got.routingTelemetry.assignmentsObserved, 1);
  assert.equal(got.routingTelemetry.terminalResultsObserved, 1);
  assert.deepEqual(got.routingTelemetry, JSON.parse(JSON.stringify(base.routingTelemetry)), "the SAME object the full snapshot serves");
});
