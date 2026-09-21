// test/consequence-policy-receipts.test.ts — W1-T3894 acceptance (5):
//   "approval, execution, refusal, and recovery limits produce linked bounded receipts"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONSEQUENCE_RECEIPT_REASON_MAX_CHARS,
  classifyConsequenceAction,
  evaluateConsequencePolicy,
  recordConsequenceApproval,
  recordConsequenceExecution,
  recordConsequenceRecovery,
  recordConsequenceRefusal,
  type ConsequenceActionInput,
} from "../src/lib/consequence-policy.js";

const NOW = Date.now();
const FUTURE = new Date(NOW + 60_000).toISOString();
const PAST = new Date(NOW - 3_600_000).toISOString();

function irreversibleAction(overrides: Partial<ConsequenceActionInput> = {}) {
  const input: ConsequenceActionInput = {
    consequenceClass: "irreversible",
    target: { identity: "db:prod-orders", source: "trusted" },
    requiredApprovers: 1,
    approvals: [{ approverId: "operator:alice", approvedAt: new Date(NOW - 1_000).toISOString(), source: "trusted" }],
    irreversible: {
      affectedResource: "table:orders",
      recoveryAvailable: false,
      recoveryStatement: "dropping this table cannot be undone",
      rollbackUnavailableReason: "no backup snapshot exists",
      confirmationNonce: "nonce-1",
      confirmationExpiresAt: FUTURE,
    },
    ...overrides,
  };
  return classifyConsequenceAction(input);
}

function financialAction(overrides: Partial<ConsequenceActionInput> = {}) {
  const input: ConsequenceActionInput = {
    consequenceClass: "financial",
    target: { identity: "vendor:acme-invoices", source: "trusted" },
    requiredApprovers: 1,
    approvals: [{ approverId: "operator:alice", approvedAt: new Date(NOW - 1_000).toISOString(), source: "trusted" }],
    financial: {
      amount: 100,
      currency: "USD",
      perActionCeiling: 500,
      aggregateCeiling: 1000,
      aggregateSpentBefore: 0,
      quoteExpiresAt: FUTURE,
      coolingOffSeconds: 0,
      coolingOffStartedAt: PAST,
    },
    ...overrides,
  };
  return classifyConsequenceAction(input);
}

test("W1-T3894 (5): an approval receipt names the actor, the action, and the consequence class", () => {
  const action = financialAction({ approvals: [] });
  const receipt = recordConsequenceApproval(
    action,
    { approverId: "operator:alice", approvedAt: new Date(NOW - 1_000).toISOString(), source: "trusted" },
    { now: NOW },
  );
  assert.equal(receipt.event, "approval");
  assert.equal(receipt.outcome, "approved");
  assert.equal(receipt.actionId, action.id);
  assert.equal(receipt.consequenceClass, "financial");
});

test("W1-T3894 (5): a refusal receipt carries the preflight's machine-readable code and reason", () => {
  const action = financialAction({ target: { identity: "vendor:???", source: "trusted", ambiguous: true } });
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, false);
  if (preflight.ok) return;
  const receipt = recordConsequenceRefusal(preflight, { now: NOW });
  assert.equal(receipt.event, "refusal");
  assert.equal(receipt.outcome, "refused");
  assert.equal(receipt.code, "ambiguous-target");
  assert.equal(receipt.actionId, action.id);
});

test("W1-T3894 (5): an execution receipt links back to the approval receipt that authorized it", () => {
  const action = financialAction();
  const approvalReceipt = recordConsequenceApproval(action, action.approvals[0], { now: NOW });
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  const executionReceipt = recordConsequenceExecution(preflight, "external-effect-42", approvalReceipt.id, { now: NOW });
  assert.equal(executionReceipt.event, "execution");
  assert.equal(executionReceipt.outcome, "executed");
  assert.equal(executionReceipt.linkedReceiptId, approvalReceipt.id);
  assert.match(executionReceipt.reason, /external-effect-42/);
});

test("W1-T3894 (5): execution never manufactures success without an external-effect receipt id", () => {
  const action = financialAction();
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  assert.throws(() => recordConsequenceExecution(preflight, "", undefined, { now: NOW }));
});

test("W1-T3894 (5): a recovery receipt for an unavailable recovery is linked and never claims recovery occurred", () => {
  const action = irreversibleAction();
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  const executionReceipt = recordConsequenceExecution(preflight, "external-effect-drop-1", undefined, { now: NOW });
  const recoveryReceipt = recordConsequenceRecovery(action, { requestedBy: "operator:alice" }, executionReceipt.id, { now: NOW });
  assert.equal(recoveryReceipt.event, "recovery");
  assert.equal(recoveryReceipt.outcome, "recovery-unavailable");
  assert.notEqual(recoveryReceipt.outcome, "recovered");
  assert.equal(recoveryReceipt.linkedReceiptId, executionReceipt.id);
  assert.equal(recoveryReceipt.reason, "no backup snapshot exists");
});

test("W1-T3894 (5): a recovery request exceeding the original financial amount is refused, never partially claimed", () => {
  const action = financialAction();
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  const executionReceipt = recordConsequenceExecution(preflight, "external-effect-pay-1", undefined, { now: NOW });
  const recoveryReceipt = recordConsequenceRecovery(
    action,
    { requestedBy: "operator:alice", amount: 500 },
    executionReceipt.id,
    { now: NOW },
  );
  assert.equal(recoveryReceipt.outcome, "refused");
  assert.equal(recoveryReceipt.code, "recovery-exceeds-original-amount");
  assert.equal(recoveryReceipt.linkedReceiptId, executionReceipt.id);
});

test("W1-T3894 (5): a recovery request within the original financial amount is recorded as recovered and linked", () => {
  const action = financialAction();
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  const executionReceipt = recordConsequenceExecution(preflight, "external-effect-pay-1", undefined, { now: NOW });
  const recoveryReceipt = recordConsequenceRecovery(
    action,
    { requestedBy: "operator:alice", amount: 100 },
    executionReceipt.id,
    { now: NOW },
  );
  assert.equal(recoveryReceipt.outcome, "recovered");
  assert.equal(recoveryReceipt.linkedReceiptId, executionReceipt.id);
});

test("W1-T3894 (5): every receipt's reason text is bounded at CONSEQUENCE_RECEIPT_REASON_MAX_CHARS", () => {
  const longReason = "x".repeat(CONSEQUENCE_RECEIPT_REASON_MAX_CHARS * 3);
  const action = irreversibleAction({
    irreversible: {
      affectedResource: "table:orders",
      recoveryAvailable: false,
      recoveryStatement: "dropping this table cannot be undone",
      rollbackUnavailableReason: longReason,
      confirmationNonce: "nonce-1",
      confirmationExpiresAt: FUTURE,
    },
  });
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  const executionReceipt = recordConsequenceExecution(preflight, "external-effect-drop-1", undefined, { now: NOW });
  const recoveryReceipt = recordConsequenceRecovery(action, { requestedBy: "operator:alice" }, executionReceipt.id, { now: NOW });
  assert.ok(recoveryReceipt.reason.length <= CONSEQUENCE_RECEIPT_REASON_MAX_CHARS + 1);
  assert.notEqual(recoveryReceipt.reason, longReason);
});
