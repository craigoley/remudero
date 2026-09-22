import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { EXTERNAL_EFFECT_STATES, EXTERNAL_EFFECT_VERSION } from "../src/lib/action-reconciliation.js";
import { ACTION_RESULTS_CONTRACT_VERSION, buildActionResultsProjection } from "../src/lib/action-results.js";
import { EXTERNAL_EFFECT_RECONCILED_STEP } from "../src/lib/ledger.js";
import { buildActionResultsRoute, buildPanelReadRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";

function ledgerLines(rows: Array<Record<string, unknown>>, opts: { present?: boolean; torn?: number } = {}) {
  const value = rows as Array<Record<string, unknown>> & { present: boolean; torn: number };
  value.present = opts.present ?? true;
  value.torn = opts.torn ?? 0;
  return value;
}

function effectRow(overrides: Record<string, unknown> = {}, effectOverrides: Record<string, unknown> = {}) {
  return {
    step: EXTERNAL_EFFECT_RECONCILED_STEP,
    run_id: "run-1",
    task_id: "W1-T4044",
    ts: "2026-09-22T10:00:00.000Z",
    external_effect: {
      version: EXTERNAL_EFFECT_VERSION,
      originatingActionId: "action-1",
      originatingReceiptId: "receipt-1",
      capabilityGrantId: "grant-1",
      connector: "github",
      targetIdentity: "repo:owner/name#123",
      requestedOperation: "merge-pr",
      reconciliationState: "applied",
      expectedPostconditions: [{ path: "state", equals: "merged" }],
      observation: { status: "fresh", observedAt: "2026-09-22T09:59:50.000Z", ageMs: 10_000, maxAgeMs: 60_000 },
      retryPath: { kind: "none", allowed: false, reason: "already applied" },
      evidenceReference: `sha256:${"a".repeat(64)}`,
      safeToComplete: true,
      ...effectOverrides,
    },
    ...overrides,
  };
}

test("unit test: action-results route preserves bounded external-effect projections", () => {
  const result = buildActionResultsProjection({
    ledgerLines: ledgerLines([effectRow()]),
    filters: {},
    now: () => new Date("2026-09-22T10:05:00.000Z"),
  });
  assert.equal(result.version, ACTION_RESULTS_CONTRACT_VERSION);
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("expected a verified projection");
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.rejected, 0);

  const item = result.items[0];
  assert.equal(item.version, EXTERNAL_EFFECT_VERSION);
  assert.equal(item.runId, "run-1");
  assert.equal(item.taskId, "W1-T4044");
  assert.equal(item.connector, "github");
  assert.equal(item.targetIdentity, "repo:owner/name#123");
  assert.equal(item.requestedOperation, "merge-pr");
  assert.deepEqual(item.expectedPostconditions, [{ path: "state", equals: "merged" }]);
  assert.equal(item.reconciliationState, "applied");
  assert.equal(item.safeToComplete, true);
  assert.match(item.evidenceReference, /^sha256:[0-9a-f]{64}$/);
  assert.equal(item.observation.status, "fresh");
  assert.equal(item.observation.maxAgeMs, 60_000);
  assert.equal(item.retryPath.kind, "none");
  assert.equal(result.cursor, item.recordedAt);
  assert.equal(result.source, "rmd:/v1/action-results");
});

test("unit test: action-results route preserves every reconciliation state", () => {
  const rows = EXTERNAL_EFFECT_STATES.map((state, index) =>
    effectRow(
      { run_id: `run-${index}`, ts: new Date(Date.parse("2026-09-22T10:00:00.000Z") + index * 1000).toISOString() },
      { reconciliationState: state, safeToComplete: state === "applied" },
    ),
  );
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines(rows), filters: {} });
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("expected a verified projection");
  assert.equal(result.rejected, 0);
  const states = result.items.map((item) => item.reconciliationState).sort();
  assert.deepEqual(states, [...EXTERNAL_EFFECT_STATES].sort());
  // Every state stays distinct: none collapses to a bare boolean or a single "success" value.
  for (const item of result.items) {
    assert.equal(typeof item.reconciliationState, "string");
    assert.notEqual(item.reconciliationState, "success");
    assert.notEqual(item.reconciliationState as unknown, true);
  }
  assert.equal(result.items.find((item) => item.reconciliationState === "applied")?.safeToComplete, true);
  for (const item of result.items) {
    if (item.reconciliationState !== "applied") assert.equal(item.safeToComplete, false);
  }
});

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

test("unit test: action-results route is mounted read-scoped, reports unavailable, and serves a live projection", () => {
  const routes = buildPanelReadRoutes(routeDeps("/tmp/repo/state/ledger.ndjson"));
  const route = routes.find((candidate) => candidate.path === "/v1/action-results");
  assert.ok(route);
  assert.equal(route?.method, "GET");
  assert.equal(route?.scope, "read");

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}action-results-route-`));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(effectRow()) + "\n");
  try {
    const missing = responseCapture();
    buildActionResultsRoute(routeDeps(join(root, "missing.ndjson"))).handler(
      { url: "/v1/action-results" } as never,
      missing.response,
      { params: {} },
    );
    assert.equal(missing.status(), 200);
    assert.equal(missing.json().state, "unavailable");
    assert.equal("items" in missing.json(), false);

    const served = responseCapture();
    buildActionResultsRoute(routeDeps(ledgerPath)).handler({ url: "/v1/action-results" } as never, served.response, { params: {} });
    assert.equal(served.status(), 200);
    assert.equal(served.json().state, "verified");
    assert.equal((served.json().items as unknown[]).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
