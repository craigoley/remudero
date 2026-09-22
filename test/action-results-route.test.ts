import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACTION_RESULTS_CONTRACT_VERSION,
  buildActionResultsProjection,
  buildActionResultsRoute,
} from "../src/lib/action-results.js";
import type { ExternalEffectResult } from "../src/lib/action-reconciliation.js";
import type { LedgerLines } from "../src/lib/status.js";
import { buildPanelReadRoutes } from "../src/lib/panel-graph.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const STATES = ["applied", "refused", "pending", "partially-applied", "drifted", "stale", "unobservable"] as const;

function result(state: ExternalEffectResult["reconciliationState"] = "applied", id = "action-1"): ExternalEffectResult {
  return {
    version: "external-effect-v1",
    originatingActionId: id,
    originatingReceiptId: `receipt-${id}`,
    capabilityGrantId: `grant-${id}`,
    connector: "provider",
    targetIdentity: "provider:account",
    requestedOperation: "rotate-secret",
    preconditionSnapshot: { status: "ready" },
    expectedPostconditions: [{ path: "status", equals: "ready" }],
    observedState: { status: "ready" },
    observation: { status: state === "stale" ? "stale" : state === "unobservable" ? "unavailable" : "fresh", observedAt: "2026-09-22T18:00:00.000Z", ageMs: 10, maxAgeMs: 5_000 },
    idempotencyKey: `key-${id}`,
    reconciliationState: state,
    retryPath: { kind: "retry", allowed: false, reason: "test" },
    evidenceReference: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    safeToComplete: state === "applied",
  };
}

function ledger(rows: Array<Record<string, unknown>>, present = true): LedgerLines {
  const value = rows as LedgerLines;
  Object.defineProperties(value, {
    present: { value: present, writable: true, configurable: true },
    torn: { value: 0, writable: true, configurable: true },
  });
  return value;
}

function responseCapture() {
  let status = 0;
  let body = "";
  return {
    response: { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as never,
    status: () => status,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

test("unit test: action-results route preserves bounded external-effect projections", () => {
  const rows = STATES.map((state, index) => ({ step: "external_effect.reconciled", task_id: "W1-T3899", ts: `2026-09-22T18:0${index}:00.000Z`, external_effect: result(state, `action-${index}`) }));
  const projection = buildActionResultsProjection(ledger(rows), { taskId: "W1-T3899", limit: 5 }, () => Date.parse("2026-09-22T18:30:00.000Z"));
  assert.equal(projection.version, ACTION_RESULTS_CONTRACT_VERSION);
  assert.equal(projection.state, "verified");
  assert.equal(projection.results?.length, 5);
  assert.equal(projection.source, "rmd:/v1/action-results");
  assert.equal(projection.results?.[0]?.originatingActionId, "action-0");
  assert.equal(projection.results?.[0]?.observation.status, "fresh");
  assert.equal(projection.results?.[0]?.safeToComplete, true);
});

test("unit test: action-results route preserves every reconciliation state", () => {
  const rows = STATES.map((state, index) => ({ step: "external_effect.reconciled", task_id: "W1-T3899", ts: `2026-09-22T18:0${index}:00.000Z`, external_effect: result(state, `action-${index}`) }));
  const projection = buildActionResultsProjection(ledger(rows));
  assert.deepEqual(new Set(projection.results?.map((item) => item.reconciliationState)), new Set(STATES));
});

test("unit test: action-results route is mounted as a read-scoped route", () => {
  const routes = buildPanelReadRoutes({
    root: "/tmp/repo",
    planPath: "/tmp/repo/plan/tasks.yaml",
    ledgerPath: "/tmp/repo/state/ledger.ndjson",
    github: {} as never,
    statusGithub: {} as never,
    inboxRoot: "/tmp/state",
    ratify: {} as never,
  });
  const route = routes.find((candidate) => candidate.path === "/v1/action-results");
  assert.ok(route);
  assert.equal(route?.method, "GET");
  assert.equal(route?.scope, "read");
});

test("unit test: action-results route reports an unavailable source instead of a healthy empty list", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}action-results-route-`));
  const missingLedger = join(root, "state", "ledger.ndjson");
  try {
    const captured = responseCapture();
    buildActionResultsRoute(missingLedger).handler({ url: "/v1/action-results" } as never, captured.response, { params: {} });
    assert.equal(captured.status(), 200);
    assert.equal(captured.json().state, "unavailable");
    assert.equal(captured.json().reason, "ledger-unavailable");

    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(missingLedger, "{not-json}\n");
    const partial = responseCapture();
    buildActionResultsRoute(missingLedger).handler({ url: "/v1/action-results" } as never, partial.response, { params: {} });
    assert.equal(partial.json().state, "unavailable");
  } finally {
    // The temporary directory is owned by this test process and is intentionally left to the OS temp cleaner.
  }
});
