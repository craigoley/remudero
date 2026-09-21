// Proof path: test/action-reconciliation-partial-success.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileExternalEffect, type ExternalEffectRequest, type ExternalObservationResponse } from "../src/lib/action-reconciliation.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function request(outcome: ExternalEffectRequest["attempt"]["outcome"], observed: ExternalObservationResponse = {
  observedState: { first: true, second: true },
  observedAt: NOW.toISOString(),
}): ExternalEffectRequest {
  return {
    originatingActionId: `action-${outcome}`,
    originatingReceiptId: `receipt-${outcome}`,
    capabilityGrantId: "grant-1",
    connector: "repository",
    targetIdentity: "repo:acme/project",
    requestedOperation: "apply-labels",
    preconditionSnapshot: { sha: "abc" },
    expectedPostconditions: [{ path: "first", equals: true }, { path: "second", equals: true }],
    idempotencyKey: `idempotency-${outcome}`,
    freshnessMs: 10_000,
    authority: { capabilityGrantId: "grant-1", expiresAt: "2026-09-21T13:00:00.000Z", budgetUsd: 1, spentUsd: 0, retryCostUsd: 0.1 },
    attempt: { outcome, attemptNumber: 1, maxAttempts: 1, idempotent: true },
    observe: async () => observed,
    now: () => NOW,
  };
}

test("partial, pending, and refused outcomes remain distinct from applied", async () => {
  const states = await Promise.all([
    reconcileExternalEffect(request("applied")),
    reconcileExternalEffect(request("refused")),
    reconcileExternalEffect(request("pending")),
    reconcileExternalEffect(request("partially-applied", { observedState: { first: true, second: false }, observedAt: NOW.toISOString() })),
  ]);
  assert.deepEqual(states.map((state) => state.reconciliationState), ["applied", "refused", "pending", "partially-applied"]);
  assert.deepEqual(states[3]?.partialSuccess, { satisfied: ["first"], unsatisfied: ["second"] });
  assert.equal(states.some((state) => state.safeToComplete === true), true);
  assert.equal(states[1]?.safeToComplete, false);
  assert.equal(states[2]?.safeToComplete, false);
  assert.equal(states[3]?.safeToComplete, false);
});

test("stale and unobservable connector reads are named rather than collapsed into failure or success", async () => {
  const stale = await reconcileExternalEffect(request("applied", {
    observedState: { first: true, second: true },
    observedAt: "2026-09-21T11:59:00.000Z",
  }));
  const unavailable = await reconcileExternalEffect(request("applied", { kind: "unavailable", reason: "connector timeout" }));
  assert.equal(stale.reconciliationState, "stale");
  assert.equal(stale.observation.status, "stale");
  assert.equal(stale.safeToComplete, false);
  assert.equal(unavailable.reconciliationState, "unobservable");
  assert.equal(unavailable.observation.status, "unavailable");
  assert.equal(unavailable.safeToComplete, false);
});
