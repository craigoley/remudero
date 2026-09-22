import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTERNAL_EFFECT_VERSION } from "../src/lib/action-reconciliation.js";
import {
  ACTION_RESULTS_MAX_FILTER_LENGTH,
  ACTION_RESULTS_MAX_ITEMS,
  ACTION_RESULTS_MAX_RESPONSE_BYTES,
  buildActionResultsProjection,
  parseActionResultsFilters,
} from "../src/lib/action-results.js";
import { EXTERNAL_EFFECT_RECONCILED_STEP } from "../src/lib/ledger.js";
import { buildActionResultsRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";

function ledgerLines(rows: Array<Record<string, unknown>>, opts: { present?: boolean; torn?: number } = {}) {
  const value = rows as Array<Record<string, unknown>> & { present: boolean; torn: number };
  value.present = opts.present ?? true;
  value.torn = opts.torn ?? 0;
  return value;
}

function baseEffect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: EXTERNAL_EFFECT_VERSION,
    originatingActionId: "action-1",
    originatingReceiptId: "receipt-1",
    capabilityGrantId: "grant-1",
    connector: "github",
    targetIdentity: "repo:owner/name#123",
    requestedOperation: "merge-pr",
    reconciliationState: "applied",
    expectedPostconditions: [],
    observation: { status: "fresh", maxAgeMs: 60_000 },
    retryPath: { kind: "none", allowed: false, reason: "already applied" },
    evidenceReference: `sha256:${"a".repeat(64)}`,
    safeToComplete: true,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}, effectOverrides: Record<string, unknown> = {}) {
  return {
    step: EXTERNAL_EFFECT_RECONCILED_STEP,
    run_id: "run-1",
    task_id: "W1-T4044",
    ts: "2026-09-22T10:00:00.000Z",
    external_effect: baseEffect(effectOverrides),
    ...overrides,
  };
}

// ── Filters: a closed allowlist, never a daemon URL / credential / connector payload / observed
// measurement / compensation instruction from the caller (W1-T4044 design). ─────────────────────

test("unit test: action-results route refuses any filter outside its closed allowlist", () => {
  for (const forbidden of ["daemonUrl", "credential", "connectorPayload", "observedMeasurement", "compensation", "token"]) {
    const parsed = parseActionResultsFilters(new URLSearchParams({ [forbidden]: "x" }));
    assert.equal(parsed.ok, false, `expected '${forbidden}' to be refused`);
  }
});

test("unit test: action-results route enforces bounded filters and explicit unavailable states", () => {
  assert.equal(parseActionResultsFilters(new URLSearchParams({ state: "not-a-real-state" })).ok, false);
  assert.equal(parseActionResultsFilters(new URLSearchParams({ changedSince: "not-a-timestamp" })).ok, false);
  assert.equal(parseActionResultsFilters(new URLSearchParams({ limit: "0" })).ok, false);
  assert.equal(parseActionResultsFilters(new URLSearchParams({ limit: `${ACTION_RESULTS_MAX_ITEMS + 1}` })).ok, false);
  assert.equal(parseActionResultsFilters(new URLSearchParams({ limit: "not-a-number" })).ok, false);
  assert.equal(parseActionResultsFilters(new URLSearchParams({ connector: "x".repeat(ACTION_RESULTS_MAX_FILTER_LENGTH + 1) })).ok, false);
  assert.equal(parseActionResultsFilters(new URLSearchParams({ connector: "" })).ok, false);

  const valid = parseActionResultsFilters(
    new URLSearchParams({ state: "drifted", connector: "github", taskId: "W1-T4044", runId: "run-9", changedSince: "2026-09-22T00:00:00.000Z", limit: "10" }),
  );
  assert.equal(valid.ok, true);
  if (!valid.ok) throw new Error("expected the closed allowlist to accept every declared filter");
  assert.deepEqual(valid.filters, {
    state: "drifted",
    connector: "github",
    taskId: "W1-T4044",
    runId: "run-9",
    changedSince: "2026-09-22T00:00:00.000Z",
    limit: 10,
  });
});

test("unit test: action-results route filters by state, connector, taskId, runId, and changedSince", () => {
  const rows = [
    row({ run_id: "run-a", task_id: "A", ts: "2026-09-22T10:00:00.000Z" }, { reconciliationState: "applied", connector: "github" }),
    row({ run_id: "run-b", task_id: "B", ts: "2026-09-22T11:00:00.000Z" }, { reconciliationState: "drifted", connector: "stripe" }),
    row({ run_id: "run-c", task_id: "A", ts: "2026-09-22T09:00:00.000Z" }, { reconciliationState: "applied", connector: "github" }),
  ];
  const byState = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: { state: "drifted" } });
  if (byState.state !== "verified") throw new Error("expected verified");
  assert.deepEqual(byState.items.map((item) => item.runId), ["run-b"]);

  const byConnector = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: { connector: "stripe" } });
  if (byConnector.state !== "verified") throw new Error("expected verified");
  assert.deepEqual(byConnector.items.map((item) => item.runId), ["run-b"]);

  const byTask = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: { taskId: "A" } });
  if (byTask.state !== "verified") throw new Error("expected verified");
  assert.deepEqual(byTask.items.map((item) => item.runId).sort(), ["run-a", "run-c"]);

  const byRun = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: { runId: "run-c" } });
  if (byRun.state !== "verified") throw new Error("expected verified");
  assert.deepEqual(byRun.items.map((item) => item.runId), ["run-c"]);

  const changedSince = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: { changedSince: "2026-09-22T09:30:00.000Z" } });
  if (changedSince.state !== "verified") throw new Error("expected verified");
  assert.deepEqual(changedSince.items.map((item) => item.runId).sort(), ["run-a", "run-b"]);
});

// ── Result count and byte bounds ─────────────────────────────────────────────────────────────

test("unit test: action-results route bounds item count and marks truncation explicitly", () => {
  const rows = Array.from({ length: ACTION_RESULTS_MAX_ITEMS + 10 }, (_, index) =>
    row({ run_id: `run-${index}`, ts: new Date(Date.parse("2026-09-22T10:00:00.000Z") + index * 1000).toISOString() }),
  );
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: {} });
  if (result.state !== "verified") throw new Error("expected verified");
  assert.equal(result.items.length, ACTION_RESULTS_MAX_ITEMS);
  assert.equal(result.truncated, true);
});

test("unit test: action-results route bounds total response bytes and never silently drops the signal", () => {
  const bigPostconditions = Array.from({ length: 50 }, (_, index) => ({
    path: `p-${index}-${"p".repeat(190)}`,
    description: "d".repeat(190),
  }));
  const rows = Array.from({ length: 20 }, (_, index) =>
    row(
      { run_id: `run-${index}`, ts: new Date(Date.parse("2026-09-22T10:00:00.000Z") + index * 1000).toISOString() },
      { expectedPostconditions: bigPostconditions },
    ),
  );
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: {} });
  if (result.state !== "verified") throw new Error("expected verified");
  assert.ok(result.items.length > 0);
  assert.ok(result.items.length < rows.length, "expected the byte bound to cut the read short of every matching row");
  assert.equal(result.truncated, true);
  const totalBytes = result.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  assert.ok(totalBytes <= ACTION_RESULTS_MAX_RESPONSE_BYTES, `expected ${totalBytes} <= ${ACTION_RESULTS_MAX_RESPONSE_BYTES}`);
});

// ── The route itself refuses a forbidden/invalid filter before ever touching the ledger ────────

function routeDeps(ledgerPath: string): PanelGraphDeps {
  return {
    root: "/tmp/repo",
    planPath: "/tmp/repo/plan/tasks.yaml",
    ledgerPath,
    github: {} as never,
    statusGithub: {} as never,
    inboxRoot: "/tmp/state",
    ratify: {} as never,
  };
}

function responseCapture() {
  let status = 0;
  let body = "";
  return {
    response: {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    } as never,
    status: () => status,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

test("unit test: action-results route refuses a forbidden or invalid filter with 400, never a healthy empty list", () => {
  const route = buildActionResultsRoute(routeDeps("/tmp/repo/state/ledger.ndjson"));

  const forbidden = responseCapture();
  route.handler({ url: "/v1/action-results?daemonUrl=https://evil.example/hook" } as never, forbidden.response, { params: {} });
  assert.equal(forbidden.status(), 400);
  assert.equal(forbidden.json().error, "invalid_request");

  const invalidState = responseCapture();
  route.handler({ url: "/v1/action-results?state=bogus" } as never, invalidState.response, { params: {} });
  assert.equal(invalidState.status(), 400);
});
