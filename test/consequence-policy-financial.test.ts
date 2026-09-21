// test/consequence-policy-financial.test.ts — W1-T3894 acceptance (2):
//   "financial actions enforce target, amount, currency, aggregate ceiling, expiry, and
//    cooling-off policy"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyConsequenceAction,
  evaluateConsequencePolicy,
  type ConsequenceActionInput,
  type ConsequenceApproval,
} from "../src/lib/consequence-policy.js";

const NOW = Date.now();
const FUTURE = new Date(NOW + 60_000).toISOString();
const PAST = new Date(NOW - 3_600_000).toISOString();

function approval(id: string): ConsequenceApproval {
  return { approverId: id, approvedAt: new Date(NOW - 1_000).toISOString(), source: "trusted" };
}

function financialAction(overrides: Partial<ConsequenceActionInput> = {}) {
  const input: ConsequenceActionInput = {
    consequenceClass: "financial",
    target: { identity: "vendor:acme-invoices", source: "trusted" },
    scope: { repo: "acme/widgets" },
    requiredApprovers: 1,
    approvals: [approval("operator:alice")],
    financial: {
      amount: 100,
      currency: "USD",
      perActionCeiling: 500,
      aggregateCeiling: 1000,
      aggregateSpentBefore: 0,
      quoteExpiresAt: FUTURE,
      coolingOffSeconds: 60,
      coolingOffStartedAt: PAST,
    },
    ...overrides,
  };
  return classifyConsequenceAction(input);
}

test("W1-T3894 (2): a financial action within its target, ceilings, quote, and cooling-off window is ready", () => {
  const action = financialAction();
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, true);
});

test("W1-T3894 (2): an ambiguous target is refused before any financial check", () => {
  const action = financialAction({ target: { identity: "vendor:???", source: "trusted", ambiguous: true } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ambiguous-target");
});

test("W1-T3894 (2): a target sourced from external content is refused", () => {
  const action = financialAction({ target: { identity: "vendor:acme-invoices", source: "external" } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "external-target");
});

test("W1-T3894 (2): a request over its per-action ceiling is refused, naming the exact amount and currency", () => {
  const base = financialAction().financial!;
  const action = financialAction({ financial: { ...base, amount: 600, perActionCeiling: 500 } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "per-action-ceiling-exceeded");
    assert.match(result.reason, /600/);
    assert.match(result.reason, /USD/);
  }
});

test("W1-T3894 (2): a request under its per-action ceiling but over the aggregate ceiling is refused", () => {
  const base = financialAction().financial!;
  const action = financialAction({ financial: { ...base, amount: 200, aggregateSpentBefore: 900, aggregateCeiling: 1000 } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "aggregate-ceiling-exceeded");
});

test("W1-T3894 (2): a request exactly at the aggregate ceiling is accepted (not exceeded)", () => {
  const base = financialAction().financial!;
  const action = financialAction({ financial: { ...base, amount: 100, aggregateSpentBefore: 900, aggregateCeiling: 1000 } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, true);
});

test("W1-T3894 (2): an expired quote is refused", () => {
  const base = financialAction().financial!;
  const action = financialAction({ financial: { ...base, quoteExpiresAt: new Date(NOW - 1_000).toISOString() } });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "quote-expired");
});

test("W1-T3894 (2): a request still inside its cooling-off window is refused", () => {
  const base = financialAction().financial!;
  const action = financialAction({
    financial: { ...base, coolingOffStartedAt: new Date(NOW - 1_000).toISOString(), coolingOffSeconds: 300 },
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cooling-off-active");
});

test("W1-T3894 (2): a request past its cooling-off window is accepted", () => {
  const base = financialAction().financial!;
  const action = financialAction({
    financial: { ...base, coolingOffStartedAt: new Date(NOW - 300_000).toISOString(), coolingOffSeconds: 60 },
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, true);
});

test("W1-T3894 (2): a capability grant reference alongside the action never widens a ceiling — the same over-ceiling request is still refused", () => {
  const base = financialAction().financial!;
  const action = classifyConsequenceAction({
    consequenceClass: "financial",
    target: { identity: "vendor:acme-invoices", source: "trusted" },
    requiredApprovers: 1,
    approvals: [approval("operator:alice")],
    financial: { ...base, amount: 600, perActionCeiling: 500 },
    capabilityGrant: { grantId: "cap-broad-access-1" },
  });
  const result = evaluateConsequencePolicy(action, { now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "per-action-ceiling-exceeded");
});
