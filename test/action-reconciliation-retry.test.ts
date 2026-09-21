// Proof path: test/action-reconciliation-retry.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { retryExternalEffect, type ExternalEffectRequest } from "../src/lib/action-reconciliation.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function request(overrides: Partial<ExternalEffectRequest["attempt"]> = {}, authority: Partial<ExternalEffectRequest["authority"]> = {}): ExternalEffectRequest {
  return {
    originatingActionId: "action-retry",
    originatingReceiptId: "receipt-retry",
    capabilityGrantId: "grant-retry",
    connector: "calendar",
    targetIdentity: "calendar:event-retry",
    requestedOperation: "upsert-event",
    preconditionSnapshot: {},
    expectedPostconditions: [{ path: "status", equals: "confirmed" }],
    idempotencyKey: "same-idempotency-key",
    freshnessMs: 5_000,
    authority: {
      capabilityGrantId: "grant-retry",
      expiresAt: "2026-09-21T13:00:00.000Z",
      budgetUsd: 2,
      spentUsd: 0.2,
      retryCostUsd: 0.1,
      ...authority,
    },
    attempt: { outcome: "pending", attemptNumber: 1, maxAttempts: 2, idempotent: true, ...overrides },
    observe: async () => ({ kind: "unavailable", reason: "not used before retry" }),
    now: () => NOW,
  };
}

test("retry uses the original idempotency key, grant, and bounded attempt number", async () => {
  const calls: unknown[] = [];
  const result = await retryExternalEffect(request(), async (context) => {
    calls.push(context);
    return { observedState: { status: "confirmed" }, observedAt: NOW.toISOString() };
  });
  assert.deepEqual(calls, [{ idempotencyKey: "same-idempotency-key", capabilityGrantId: "grant-retry", attemptNumber: 2 }]);
  assert.equal(result.reconciliationState, "pending");
  assert.equal(result.retryPath.allowed, false, "the retry result has consumed the declared final attempt");
});

test("non-idempotent, expired, exhausted, and over-budget operations never retry", async () => {
  const cases: Array<[string, ExternalEffectRequest]> = [
    ["non-idempotent", request({ idempotent: false })],
    ["expired", request({}, { expiresAt: "2026-09-21T11:00:00.000Z" })],
    ["attempt budget", request({ attemptNumber: 2 })],
    ["spend budget", request({}, { spentUsd: 2 })],
  ];
  for (const [label, input] of cases) {
    let called = false;
    const result = await retryExternalEffect(input, async () => {
      called = true;
      return { observedState: { status: "confirmed" }, observedAt: NOW.toISOString() };
    });
    assert.equal(called, false, `${label} must not reach the connector`);
    assert.equal(result.retryPath.allowed, false, `${label} must be refused`);
    assert.equal(result.safeToComplete, false);
  }
});
