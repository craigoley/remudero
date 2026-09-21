// Proof path: test/action-reconciliation-redaction.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendExternalEffectLedger } from "../src/lib/ledger.js";
import { reconcileExternalEffect } from "../src/lib/action-reconciliation.js";

test("connector evidence is redacted and an unavailable observation cannot become a healthy receipt", async () => {
  const result = await reconcileExternalEffect({
    originatingActionId: "action-redact",
    originatingReceiptId: "receipt-redact",
    capabilityGrantId: "grant-redact",
    connector: "provider",
    targetIdentity: "provider:account",
    requestedOperation: "rotate-secret",
    preconditionSnapshot: { token: "request-token" },
    expectedPostconditions: [{ path: "status", equals: "ready" }],
    idempotencyKey: "redact-key",
    freshnessMs: 5_000,
    authority: { capabilityGrantId: "grant-redact", expiresAt: "2026-09-21T13:00:00.000Z", budgetUsd: 1, spentUsd: 0, retryCostUsd: 0 },
    attempt: { outcome: "applied", attemptNumber: 1, maxAttempts: 1, idempotent: true },
    observe: async () => ({ kind: "unavailable", reason: "provider timeout", evidence: { authorization: "Bearer top-secret" } }),
    now: () => new Date("2026-09-21T12:00:00.000Z"),
  });
  assert.equal(result.reconciliationState, "unobservable");
  assert.equal(result.safeToComplete, false);
  assert.equal(JSON.stringify(result).includes("top-secret"), false);
  assert.equal(JSON.stringify(result).includes("request-token"), false);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-external-effect-")), "ledger.ndjson");
  appendExternalEffectLedger(ledgerPath, { runId: "run-redact", taskId: "W1-T3899" }, result);
  const ledger = readFileSync(ledgerPath, "utf8");
  assert.equal(ledger.includes("top-secret"), false);
  assert.match(ledger, /external_effect\.reconciled/);
});
