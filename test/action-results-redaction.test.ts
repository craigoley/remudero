import assert from "node:assert/strict";
import { test } from "node:test";
import { buildActionResultsProjection } from "../src/lib/action-results.js";
import type { LedgerLines } from "../src/lib/status.js";

test("unit test: action-results route never exposes raw connector evidence", () => {
  const rows = [{
    step: "external_effect.reconciled",
    task_id: "W1-T3899",
    ts: "2026-09-22T18:00:00.000Z",
    external_effect: {
      version: "external-effect-v1",
      originatingActionId: "action-redact",
      originatingReceiptId: "receipt-redact",
      capabilityGrantId: "grant-redact",
      connector: "provider",
      targetIdentity: "provider:account",
      requestedOperation: "rotate-secret",
      preconditionSnapshot: { status: "ready", providerPayload: { authorization: "Bearer top-secret" } },
      expectedPostconditions: [{ path: "status", equals: "ready" }],
      observedState: { status: "ready", providerResponse: { body: "raw-provider-output", apiKey: "top-secret" } },
      observation: { status: "fresh", observedAt: "2026-09-22T18:00:00.000Z", ageMs: 0, maxAgeMs: 5_000 },
      idempotencyKey: "key-redact",
      reconciliationState: "applied",
      retryPath: { kind: "none", allowed: false, reason: "done" },
      evidenceReference: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      safeToComplete: true,
    },
  }] as unknown as LedgerLines;
  Object.defineProperties(rows, {
    present: { value: true, writable: true, configurable: true },
    torn: { value: 0, writable: true, configurable: true },
  });
  const projection = buildActionResultsProjection(rows);
  const encoded = JSON.stringify(projection);
  assert.equal(projection.state, "verified");
  assert.equal(encoded.includes("top-secret"), false);
  assert.equal(encoded.includes("raw-provider-output"), false);
  assert.match(encoded, /\[REDACTED\]/);
});

test("unit test: action-results route rejects malformed external-effect rows", () => {
  const rows = [{ step: "external_effect.reconciled", task_id: "W1-T3899", external_effect: { version: "external-effect-v1" } }] as unknown as LedgerLines;
  Object.defineProperties(rows, {
    present: { value: true, writable: true, configurable: true },
    torn: { value: 0, writable: true, configurable: true },
  });
  const projection = buildActionResultsProjection(rows);
  assert.equal(projection.state, "unavailable");
  assert.equal(projection.reason, "malformed-external-effect");
});
