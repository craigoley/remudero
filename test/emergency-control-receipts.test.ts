// test/emergency-control-receipts.test.ts — W1-T3900 acceptance (5):
//   "stop, refusal, cancellation, and clear events produce linked bounded receipts"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkEmergencyStop,
  clearEmergencyStop,
  createEmergencyStop,
  EMERGENCY_RECEIPT_REASON_MAX_CHARS,
  emergencyStopIssuedReceipt,
  requestRunningEffectCancellation,
  type RunningEffectConnector,
} from "../src/lib/emergency-control.js";

// Every field name a receipt could carry — no field here is a plausible home for a raw prompt,
// credential, or transcript, mirroring agent-delegation-receipts.test.ts's precedent.
const ALLOWED_RECEIPT_KEYS = new Set(["receiptId", "stopId", "parentReceiptId", "kind", "outcome", "decidedAt", "reason"]);

function assertBoundedReceipt(receiptLike: object, stopId: string, incidentReceiptId: string) {
  const receipt = receiptLike as Record<string, unknown>;
  for (const key of Object.keys(receipt)) {
    assert.ok(ALLOWED_RECEIPT_KEYS.has(key), `unexpected receipt field ${key}`);
  }
  assert.equal(receipt.stopId, stopId);
  assert.equal(receipt.parentReceiptId, incidentReceiptId);
  assert.ok((receipt.reason as string).length <= EMERGENCY_RECEIPT_REASON_MAX_CHARS + 1); // +1 for the ellipsis
  assert.equal(typeof receipt.receiptId, "string");
  assert.ok((receipt.receiptId as string).length > 0);
  assert.equal(typeof receipt.decidedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(receipt.decidedAt as string)));
}

function issuedStop() {
  return createEmergencyStop({
    scope: "fleet",
    reason: "credential leak suspected on the review provider",
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-100",
  });
}

test("W1-T3900 (5): the issuance event produces a bounded, linked \"stop\" receipt", () => {
  const stop = issuedStop();
  const receipt = emergencyStopIssuedReceipt(stop);
  assertBoundedReceipt(receipt, stop.id, stop.incidentReceiptId);
  assert.equal(receipt.kind, "stop");
  assert.equal(receipt.outcome, "issued");
});

test("W1-T3900 (5): a blocked admission produces a bounded, linked \"refusal\" receipt", () => {
  const stop = issuedStop();
  const result = checkEmergencyStop([stop], { actionKind: "action-admission" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assertBoundedReceipt(result.receipt, stop.id, stop.incidentReceiptId);
  assert.equal(result.receipt.kind, "refusal");
  assert.equal(result.receipt.outcome, "action-admission");
});

test("W1-T3900 (5): a cancellation attempt produces a bounded, linked \"cancellation\" receipt", () => {
  const stop = issuedStop();
  const connector: RunningEffectConnector = { supportsCancellation: true, requestCancellation: () => "applied" };
  const { receipt } = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-1", effectKind: "deploy" });
  assertBoundedReceipt(receipt, stop.id, stop.incidentReceiptId);
  assert.equal(receipt.kind, "cancellation");
});

test("W1-T3900 (5): a clear event produces a bounded, linked \"clear\" receipt", () => {
  const stop = issuedStop();
  const now = Date.now();
  const result = clearEmergencyStop(stop, false, {
    stopId: stop.id,
    confirmation: { confirmedBy: "operator:alice", confirmedAt: new Date(now).toISOString() },
    health: { source: "daemon-health", status: "healthy", checkedAt: new Date(now).toISOString() },
    revocation: { coverage: "complete" },
  }, { now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assertBoundedReceipt(result.receipt, stop.id, stop.incidentReceiptId);
  assert.equal(result.receipt.kind, "clear");
});

test("W1-T3900 (5): a long refusal reason is truncated at the named bound, never silently dropped", () => {
  const stop = createEmergencyStop({
    scope: "fleet",
    reason: "x".repeat(1000),
    issuedBy: "operator:alice",
    clearPolicy: "explicit-clear-required",
    incidentReceiptId: "incident-101",
  });
  const result = checkEmergencyStop([stop], { actionKind: "capability-use", capability: "deploy.trigger" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.receipt.reason.length <= EMERGENCY_RECEIPT_REASON_MAX_CHARS + 1);
  assert.ok(result.receipt.reason.endsWith("…"));
});

test("W1-T3900 (5): every receipt kind for the same stop shares one parent — its incident receipt", () => {
  const stop = issuedStop();
  const now = Date.now();
  const issued = emergencyStopIssuedReceipt(stop, { now });
  const refusalResult = checkEmergencyStop([stop], { actionKind: "agent-handoff" }, now);
  const connector: RunningEffectConnector = { supportsCancellation: false, requestCancellation: () => "applied" };
  const cancellation = requestRunningEffectCancellation(connector, { stop, effectRef: "eff-2", effectKind: "email" }, { now });
  assert.equal(refusalResult.ok, false);
  if (refusalResult.ok) return;
  const parents = new Set([issued.parentReceiptId, refusalResult.receipt.parentReceiptId, cancellation.receipt.parentReceiptId]);
  assert.deepEqual([...parents], [stop.incidentReceiptId]);
});
