import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_RESULTS_MAX_RESPONSE_BYTES, ACTION_RESULTS_MAX_RESULTS, buildActionResultsProjection, buildActionResultsRoute } from "../src/lib/action-results.js";
import type { LedgerLines } from "../src/lib/status.js";

function row(index: number): Record<string, unknown> {
  return {
    step: "external_effect.reconciled",
    task_id: `task-${index}`,
    ts: new Date(Date.parse("2026-09-22T18:00:00.000Z") + index * 1000).toISOString(),
    external_effect: {
      version: "external-effect-v1",
      originatingActionId: `action-${index}`,
      originatingReceiptId: `receipt-${index}`,
      capabilityGrantId: `grant-${index}`,
      connector: "provider",
      targetIdentity: `provider:account-${index}`,
      requestedOperation: "observe",
      preconditionSnapshot: {},
      expectedPostconditions: [],
      observation: { status: "fresh", observedAt: new Date(Date.parse("2026-09-22T18:00:00.000Z") + index * 1000).toISOString(), ageMs: 0, maxAgeMs: 5_000 },
      idempotencyKey: `key-${index}`,
      reconciliationState: "pending",
      retryPath: { kind: "none", allowed: false, reason: "test" },
      evidenceReference: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      safeToComplete: false,
    },
  };
}

function ledger(rows: Array<Record<string, unknown>>): LedgerLines {
  const value = rows as LedgerLines;
  Object.defineProperties(value, {
    present: { value: true, writable: true, configurable: true },
    torn: { value: 0, writable: true, configurable: true },
  });
  return value;
}

test("unit test: action-results route enforces bounded filters and explicit unavailable states", () => {
  const projection = buildActionResultsProjection(ledger(Array.from({ length: ACTION_RESULTS_MAX_RESULTS + 25 }, (_, index) => row(index))), { limit: ACTION_RESULTS_MAX_RESULTS });
  assert.equal(projection.state, "verified");
  assert.ok((projection.results?.length ?? 0) <= ACTION_RESULTS_MAX_RESULTS);
  assert.equal(projection.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= ACTION_RESULTS_MAX_RESPONSE_BYTES);
});

test("unit test: action-results route rejects a malformed partialSuccess shape without crashing", () => {
  const malformed = row(0);
  const externalEffect = malformed.external_effect as Record<string, unknown>;
  externalEffect.partialSuccess = { satisfied: "not-an-array", unsatisfied: [] };
  const projection = buildActionResultsProjection(ledger([malformed]));
  assert.equal(projection.state, "unavailable");
  assert.equal(projection.reason, "malformed-external-effect");
});

test("unit test: action-results route rejects caller-owned measurements and out-of-range limits", () => {
  let status = 0;
  let body = "";
  const response = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as never;
  buildActionResultsRoute("/tmp/no-ledger").handler({ url: "/v1/action-results?measurement=client-owned" } as never, response, { params: {} });
  assert.equal(status, 400);
  assert.match(body, /server-owned/);
  buildActionResultsRoute("/tmp/no-ledger").handler({ url: "/v1/action-results?limit=201" } as never, response, { params: {} });
  assert.equal(status, 400);
  assert.match(body, /limit/);
});
