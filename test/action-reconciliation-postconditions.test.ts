// Proof path: test/action-reconciliation-postconditions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTERNAL_EFFECT_VERSION,
  reconcileExternalEffect,
  type ExternalEffectRequest,
} from "../src/lib/action-reconciliation.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function request(overrides: Partial<ExternalEffectRequest> = {}): ExternalEffectRequest {
  return {
    originatingActionId: "action-42",
    originatingReceiptId: "receipt-42",
    capabilityGrantId: "grant-42",
    connector: "calendar",
    targetIdentity: "calendar:event-7",
    requestedOperation: "create-event",
    preconditionSnapshot: { version: 3, owner: "operator" },
    expectedPostconditions: [
      { path: "id", equals: "event-7" },
      { path: "status", equals: "confirmed" },
    ],
    idempotencyKey: "action-42:create-event",
    freshnessMs: 5_000,
    authority: {
      capabilityGrantId: "grant-42",
      expiresAt: "2026-09-21T13:00:00.000Z",
      budgetUsd: 2,
      spentUsd: 0.25,
      retryCostUsd: 0.1,
    },
    attempt: { outcome: "applied", attemptNumber: 1, maxAttempts: 2, idempotent: true },
    observe: async () => ({
      observedState: { id: "event-7", status: "confirmed" },
      observedAt: NOW.toISOString(),
      evidence: { providerRequestId: "provider-7", authorization: "Bearer secret" },
    }),
    now: () => NOW,
    ...overrides,
  };
}

test("external-effect-v1 carries postconditions, target identity, freshness, and its originating action", async () => {
  const result = await reconcileExternalEffect(request());

  assert.equal(result.version, EXTERNAL_EFFECT_VERSION);
  assert.equal(result.originatingActionId, "action-42");
  assert.equal(result.originatingReceiptId, "receipt-42");
  assert.equal(result.capabilityGrantId, "grant-42");
  assert.equal(result.connector, "calendar");
  assert.equal(result.targetIdentity, "calendar:event-7");
  assert.deepEqual(result.expectedPostconditions, [
    { path: "id", equals: "event-7" },
    { path: "status", equals: "confirmed" },
  ]);
  assert.equal(result.observation.status, "fresh");
  assert.equal(result.reconciliationState, "applied");
  assert.equal(result.safeToComplete, true);
  assert.match(result.evidenceReference, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes("Bearer secret"), false, "raw connector evidence must not cross the result seam");
});
