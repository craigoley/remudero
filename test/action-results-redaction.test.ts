import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTERNAL_EFFECT_VERSION } from "../src/lib/action-reconciliation.js";
import { ACTION_RESULTS_MAX_ROW_BYTES, buildActionResultsProjection } from "../src/lib/action-results.js";
import { EXTERNAL_EFFECT_RECONCILED_STEP } from "../src/lib/ledger.js";

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

test("unit test: action-results route never exposes raw connector evidence", () => {
  const contaminated = row(
    {},
    {
      // Simulates a write-time redaction bug: raw connector fields riding alongside the safe ones.
      observedState: { apiKey: "sk-live-should-never-leak", nested: { authorization: "Bearer super-secret" } },
      preconditionSnapshot: { password: "hunter2" },
      evidence: { cookie: "raw-session-cookie-should-never-leak" },
    },
  );
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines([contaminated]), filters: {} });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /sk-live-should-never-leak|hunter2|raw-session-cookie-should-never-leak|observedState|preconditionSnapshot/,
  );
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("expected a verified projection");
  assert.equal(result.items.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result.items[0], "observedState"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.items[0], "preconditionSnapshot"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.items[0], "evidence"), false);
});

test("unit test: action-results route redacts a sensitive key nested inside a preserved postcondition", () => {
  const contaminated = row(
    {},
    { expectedPostconditions: [{ path: "status", equals: { apiKey: "raw-secret-value", state: "merged" } }] },
  );
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines([contaminated]), filters: {} });
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("expected a verified projection");
  const equals = result.items[0]?.expectedPostconditions[0]?.equals as Record<string, unknown>;
  assert.equal(equals.apiKey, "[REDACTED]");
  assert.equal(equals.state, "merged");
  assert.doesNotMatch(JSON.stringify(result), /raw-secret-value/);
});

test("unit test: action-results route rejects a malformed row without exposing its raw content", () => {
  const malformed = row({}, { reconciliationState: "raw-connector-leak-marker" });
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines([malformed]), filters: {} });
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("expected a verified (empty) projection");
  assert.equal(result.items.length, 0);
  assert.equal(result.rejected, 1);
  assert.doesNotMatch(JSON.stringify(result), /raw-connector-leak-marker/);
});

test("unit test: action-results route rejects an oversized row without exposing its content", () => {
  assert.ok(ACTION_RESULTS_MAX_ROW_BYTES < 64 * 1024);
  const oversized = row({}, { reason: "raw-oversized-marker-" + "y".repeat(64 * 1024) });
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines([oversized]), filters: {} });
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("expected a verified (empty) projection");
  assert.equal(result.items.length, 0);
  assert.equal(result.rejected, 1);
  assert.doesNotMatch(JSON.stringify(result), /raw-oversized-marker/);
});

test("unit test: action-results route reports unavailable rather than a healthy empty array on a corrupt ledger", () => {
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines([], { torn: 1 }), filters: {} });
  assert.equal(result.state, "unavailable");
  assert.equal("items" in result, false);
  if (result.state !== "unavailable") throw new Error("expected unavailable");
  assert.equal(result.reason, "ledger-corrupt");
});

test("unit test: action-results route reports unavailable rather than a healthy empty array on an absent ledger", () => {
  const result = buildActionResultsProjection({ ledgerLines: ledgerLines([], { present: false }), filters: {} });
  assert.equal(result.state, "unavailable");
  if (result.state !== "unavailable") throw new Error("expected unavailable");
  assert.equal(result.reason, "ledger-unavailable");
});
