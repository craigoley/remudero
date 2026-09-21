// test/consequence-policy-approval.test.ts — W1-T3894 acceptance (4):
//   "irreversible and financial actions require the configured human approval level across
//    handoffs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyConsequenceAction,
  evaluateConsequencePolicy,
  recordConsequenceApproval,
  type ConsequenceActionInput,
  type ConsequenceApproval,
} from "../src/lib/consequence-policy.js";

const NOW = Date.now();
const FUTURE = new Date(NOW + 60_000).toISOString();
const PAST = new Date(NOW - 3_600_000).toISOString();

function trusted(id: string, atMs = NOW - 1_000): ConsequenceApproval {
  return { approverId: id, approvedAt: new Date(atMs).toISOString(), source: "trusted" };
}

function dualApprovalFinancial(overrides: Partial<ConsequenceActionInput> = {}) {
  const input: ConsequenceActionInput = {
    consequenceClass: "financial",
    target: { identity: "vendor:acme-invoices", source: "trusted" },
    requiredApprovers: 2,
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

test("W1-T3894 (4): a financial action with zero approvals is refused for missing approvers", () => {
  const action = dualApprovalFinancial({ requiredApprovers: 1, approvals: [] });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing-approvers");
});

test("W1-T3894 (4): dual-control requires TWO DISTINCT approvers — one approver approving twice does not satisfy it", () => {
  const action = dualApprovalFinancial({ approvals: [trusted("operator:alice"), trusted("operator:alice")] });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing-approvers");
});

test("W1-T3894 (4): dual-control is satisfied by two distinct trusted approvers", () => {
  const action = dualApprovalFinancial({ approvals: [trusted("operator:alice"), trusted("operator:bob")] });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, true);
});

test("W1-T3894 (4): an approval sourced from external content never counts toward the required approver level", () => {
  const action = dualApprovalFinancial({
    approvals: [trusted("operator:alice"), { approverId: "operator:bob", approvedAt: new Date(NOW - 1_000).toISOString(), source: "external" }],
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing-approvers");
});

test("W1-T3894 (4): an approval dated in the future does not yet count", () => {
  const action = dualApprovalFinancial({ approvals: [trusted("operator:alice"), trusted("operator:bob", NOW + 60_000)] });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing-approvers");
});

test("W1-T3894 (4): irreversible actions carry the same required-approver enforcement as financial ones", () => {
  const action = classifyConsequenceAction({
    consequenceClass: "irreversible",
    target: { identity: "db:prod-orders", source: "trusted" },
    requiredApprovers: 1,
    approvals: [],
    irreversible: {
      affectedResource: "table:orders",
      recoveryAvailable: false,
      recoveryStatement: "dropping this table cannot be undone",
      rollbackUnavailableReason: "no backup snapshot exists",
      confirmationNonce: "nonce-1",
      confirmationExpiresAt: FUTURE,
    },
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing-approvers");
});

test("W1-T3894 (4): approval level is enforced identically across repeated handoffs — a second delegate cannot narrow the requirement", () => {
  // Two "handoffs" evaluate the same underlying action shape independently. Neither handoff may
  // relax the required-approver count just because a different call site is asking.
  const underApproved = dualApprovalFinancial({ approvals: [trusted("operator:alice")] });
  const firstHandoff = evaluateConsequencePolicy(underApproved, { now: NOW });
  const secondHandoff = evaluateConsequencePolicy(underApproved, { now: NOW + 5_000 });
  assert.equal(firstHandoff.ok, false);
  assert.equal(secondHandoff.ok, false);
  if (!firstHandoff.ok) assert.equal(firstHandoff.code, "missing-approvers");
  if (!secondHandoff.ok) assert.equal(secondHandoff.code, "missing-approvers");

  const fullyApproved = dualApprovalFinancial({ approvals: [trusted("operator:alice"), trusted("operator:bob")] });
  const thirdHandoff = evaluateConsequencePolicy(fullyApproved, { now: NOW + 10_000 });
  assert.equal(thirdHandoff.ok, true);
});

test("W1-T3894 (4): recordConsequenceApproval refuses (never records approved for) an approval sourced from external content", () => {
  const action = dualApprovalFinancial({ approvals: [] });
  const receipt = recordConsequenceApproval(
    action,
    { approverId: "operator:mallory", approvedAt: new Date(NOW - 1_000).toISOString(), source: "external" },
    { now: NOW },
  );
  assert.equal(receipt.outcome, "refused");
  assert.match(receipt.reason, /external/);
});

test("W1-T3894 (4): recordConsequenceApproval records a trusted approval as approved", () => {
  const action = dualApprovalFinancial({ approvals: [] });
  const receipt = recordConsequenceApproval(action, trusted("operator:alice"), { now: NOW });
  assert.equal(receipt.outcome, "approved");
  assert.match(receipt.reason, /operator:alice/);
});
