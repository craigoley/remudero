// Proof path: test/action-reconciliation-drift.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileExternalEffect } from "../src/lib/action-reconciliation.js";

test("observed external drift never renders as successful completion and names the reconciliation state", async () => {
  const result = await reconcileExternalEffect({
    originatingActionId: "action-drift",
    originatingReceiptId: "receipt-drift",
    capabilityGrantId: "grant-drift",
    connector: "repository",
    targetIdentity: "repo:acme/project",
    requestedOperation: "update-branch-protection",
    preconditionSnapshot: { sha: "before" },
    expectedPostconditions: [{ path: "branchProtection.required", equals: true }],
    idempotencyKey: "action-drift:update-branch-protection",
    freshnessMs: 5_000,
    authority: { capabilityGrantId: "grant-drift", expiresAt: "2026-09-21T13:00:00.000Z", budgetUsd: 1, spentUsd: 0, retryCostUsd: 0 },
    attempt: { outcome: "applied", attemptNumber: 1, maxAttempts: 1, idempotent: true },
    observe: async () => ({
      observedState: { branchProtection: { required: false } },
      observedAt: "2026-09-21T12:00:00.000Z",
      evidence: { providerRequestId: "secret-provider-id" },
    }),
    now: () => new Date("2026-09-21T12:00:01.000Z"),
  });

  assert.equal(result.reconciliationState, "drifted");
  assert.equal(result.safeToComplete, false);
  assert.match(result.reason ?? "", /does not satisfy/);
  assert.deepEqual(result.observedState, { branchProtection: { required: false } });
});
