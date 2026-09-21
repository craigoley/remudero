// test/consequence-policy-confirmation.test.ts — W1-T3894 acceptance (3):
//   "ambiguous targets, stale evidence, expired confirmations, and exceeded limits refuse before
//    execution"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyConsequenceAction,
  evaluateConsequencePolicy,
  recordConsequenceExecution,
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
    evidence: [{ label: "row-count-quote", observedAt: new Date(NOW - 1_000).toISOString(), maxAgeSeconds: 60 }],
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

test("W1-T3894 (3): an ambiguous target refuses before any other check runs", () => {
  const action = irreversibleAction({ target: { identity: "db:???", source: "trusted", ambiguous: true } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ambiguous-target");
});

test("W1-T3894 (3): stale evidence refuses the action, naming the evidence label", () => {
  const action = irreversibleAction({
    evidence: [{ label: "row-count-quote", observedAt: PAST, maxAgeSeconds: 60 }],
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "stale-evidence");
    assert.match(result.reason, /row-count-quote/);
  }
});

test("W1-T3894 (3): evidence exactly at its freshness bound is still fresh", () => {
  const observedAt = new Date(NOW - 60_000).toISOString();
  const action = irreversibleAction({ evidence: [{ label: "row-count-quote", observedAt, maxAgeSeconds: 60 }] });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, true);
});

test("W1-T3894 (3): an expired confirmation nonce refuses the action", () => {
  const base = irreversibleAction().irreversible!;
  const action = irreversibleAction({ irreversible: { ...base, confirmationExpiresAt: new Date(NOW - 1_000).toISOString() } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "expired-confirmation");
});

test("W1-T3894 (3): a still-valid confirmation nonce is accepted", () => {
  const action = irreversibleAction();
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, true);
});

test("W1-T3894 (3): exceeded limits refuse a financial action the same way (per-action ceiling)", () => {
  const action = classifyConsequenceAction({
    consequenceClass: "financial",
    target: { identity: "vendor:acme-invoices", source: "trusted" },
    requiredApprovers: 1,
    approvals: [{ approverId: "operator:alice", approvedAt: new Date(NOW - 1_000).toISOString(), source: "trusted" }],
    financial: {
      amount: 900,
      currency: "USD",
      perActionCeiling: 500,
      aggregateCeiling: 1000,
      aggregateSpentBefore: 0,
      quoteExpiresAt: FUTURE,
      coolingOffSeconds: 0,
      coolingOffStartedAt: PAST,
    },
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "per-action-ceiling-exceeded");
});

test("W1-T3894 (3): every refusal above stops execution — recordConsequenceExecution never marks a refused preflight executed", () => {
  const action = irreversibleAction({ target: { identity: "db:???", source: "trusted", ambiguous: true } });
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, false);
  const receipt = recordConsequenceExecution(preflight, "external-effect-1", undefined, { now: NOW });
  assert.equal(receipt.outcome, "refused");
  assert.notEqual(receipt.outcome, "executed");
});

test("W1-T3894 (3): a ready preflight still requires evidence of the effect before execution is recorded", () => {
  const action = irreversibleAction();
  const preflight = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(preflight.ok, true);
  assert.throws(() => recordConsequenceExecution(preflight, "", undefined, { now: NOW }));
});
