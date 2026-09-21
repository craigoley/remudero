// test/consequence-policy-classification.test.ts — W1-T3894 acceptance (1):
//   "actions classify consequence and preserve the exact target, scope, and recovery boundary"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONSEQUENCE_CLASSES,
  CONSEQUENCE_POLICY_SCHEMA_VERSION,
  classifyConsequenceAction,
  type ConsequenceActionInput,
} from "../src/lib/consequence-policy.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function reversibleInput(overrides: Partial<ConsequenceActionInput> = {}): ConsequenceActionInput {
  return {
    consequenceClass: "reversible",
    target: { identity: "flow:cache-warm", source: "trusted" },
    scope: { repo: "acme/widgets" },
    requiredApprovers: 0,
    ...overrides,
  };
}

function financialInput(overrides: Partial<ConsequenceActionInput> = {}): ConsequenceActionInput {
  return {
    consequenceClass: "financial",
    target: { identity: "vendor:acme-invoices", source: "trusted" },
    scope: { repo: "acme/widgets" },
    requiredApprovers: 1,
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
}

function irreversibleInput(overrides: Partial<ConsequenceActionInput> = {}): ConsequenceActionInput {
  return {
    consequenceClass: "irreversible",
    target: { identity: "db:prod-orders", source: "trusted" },
    requiredApprovers: 1,
    irreversible: {
      affectedResource: "table:orders",
      recoveryAvailable: false,
      recoveryStatement: "dropping this table cannot be undone",
      rollbackUnavailableReason: "no backup snapshot exists for this table",
      confirmationNonce: "nonce-1",
      confirmationExpiresAt: FUTURE,
    },
    ...overrides,
  };
}

test("W1-T3894 (1): every class in CONSEQUENCE_CLASSES is exactly reversible/disruptive/irreversible/financial", () => {
  assert.deepEqual([...CONSEQUENCE_CLASSES].sort(), ["disruptive", "financial", "irreversible", "reversible"]);
});

test("W1-T3894 (1): a reversible action classifies with the schema tag and preserves target/scope exactly", () => {
  const action = classifyConsequenceAction(reversibleInput());
  assert.equal(action.schema, CONSEQUENCE_POLICY_SCHEMA_VERSION);
  assert.equal(action.consequenceClass, "reversible");
  assert.deepEqual(action.target, { identity: "flow:cache-warm", source: "trusted" });
  assert.deepEqual(action.scope, { repo: "acme/widgets" });
});

test("W1-T3894 (1): a disruptive action classifies without financial/irreversible sub-records", () => {
  const action = classifyConsequenceAction(reversibleInput({ consequenceClass: "disruptive" }));
  assert.equal(action.consequenceClass, "disruptive");
  assert.equal(action.financial, undefined);
  assert.equal(action.irreversible, undefined);
});

test("W1-T3894 (1): a financial action preserves target, amount, currency, and both ceilings exactly", () => {
  const action = classifyConsequenceAction(financialInput());
  assert.equal(action.target.identity, "vendor:acme-invoices");
  assert.ok(action.financial);
  assert.equal(action.financial!.amount, 100);
  assert.equal(action.financial!.currency, "USD");
  assert.equal(action.financial!.perActionCeiling, 500);
  assert.equal(action.financial!.aggregateCeiling, 1000);
});

test("W1-T3894 (1): financial consequenceClass without financial details is refused", () => {
  assert.throws(() => classifyConsequenceAction(reversibleInput({ consequenceClass: "financial", requiredApprovers: 1 })));
});

test("W1-T3894 (1): a non-financial class carrying financial details is refused", () => {
  const input = financialInput({ consequenceClass: "reversible", requiredApprovers: 0 });
  assert.throws(() => classifyConsequenceAction(input));
});

test("W1-T3894 (1): classification refuses malformed target, approver, financial, and recovery fields", () => {
  assert.throws(() => classifyConsequenceAction(reversibleInput({ target: undefined as unknown as ConsequenceActionInput["target"] })), /target\.identity/);
  assert.throws(() => classifyConsequenceAction(reversibleInput({ requiredApprovers: -1 })), /requiredApprovers/);
  assert.throws(() => classifyConsequenceAction(financialInput({ financial: { ...financialInput().financial!, aggregateSpentBefore: -1 } })), /aggregateSpentBefore/);
  assert.throws(() => classifyConsequenceAction(financialInput({ financial: { ...financialInput().financial!, coolingOffStartedAt: "not-a-date" } })), /coolingOffStartedAt/);

  assert.throws(() => classifyConsequenceAction(irreversibleInput({ irreversible: { ...irreversibleInput().irreversible!, affectedResource: "" } })), /affectedResource/);
  assert.throws(() => classifyConsequenceAction(irreversibleInput({ irreversible: { ...irreversibleInput().irreversible!, recoveryStatement: "" } })), /recoveryStatement/);
  assert.throws(() => classifyConsequenceAction(irreversibleInput({ irreversible: { ...irreversibleInput().irreversible!, confirmationNonce: "" } })), /confirmationNonce/);
  assert.throws(() => classifyConsequenceAction(irreversibleInput({ irreversible: { ...irreversibleInput().irreversible!, confirmationExpiresAt: "not-a-date" } })), /confirmationExpiresAt/);
  assert.throws(() => classifyConsequenceAction(irreversibleInput({ irreversible: { ...irreversibleInput().irreversible!, recoveryAvailable: "yes" as unknown as boolean } })), /recoveryAvailable/);
  assert.throws(() => classifyConsequenceAction(reversibleInput({ irreversible: irreversibleInput().irreversible })), /must not carry irreversible/);
});

test("W1-T3894 (1): an irreversible action preserves the exact recovery boundary — resource, statement, availability, and reason", () => {
  const action = classifyConsequenceAction(irreversibleInput());
  assert.ok(action.irreversible);
  assert.equal(action.irreversible!.affectedResource, "table:orders");
  assert.equal(action.irreversible!.recoveryAvailable, false);
  assert.equal(action.irreversible!.recoveryStatement, "dropping this table cannot be undone");
  assert.equal(action.irreversible!.rollbackUnavailableReason, "no backup snapshot exists for this table");
  assert.equal(action.irreversible!.confirmationNonce, "nonce-1");
});

test("W1-T3894 (1): irreversible consequenceClass without irreversible details is refused", () => {
  assert.throws(() => classifyConsequenceAction(reversibleInput({ consequenceClass: "irreversible", requiredApprovers: 1 })));
});

test("W1-T3894 (1): recoveryAvailable=false without a rollbackUnavailableReason is refused — recovery is never silently absent", () => {
  const input = irreversibleInput({
    irreversible: {
      affectedResource: "table:orders",
      recoveryAvailable: false,
      recoveryStatement: "dropping this table cannot be undone",
      confirmationNonce: "nonce-1",
      confirmationExpiresAt: FUTURE,
    },
  });
  assert.throws(() => classifyConsequenceAction(input));
});

test("W1-T3894 (1): recoveryAvailable=true does not require a rollbackUnavailableReason", () => {
  const action = classifyConsequenceAction(
    irreversibleInput({
      irreversible: {
        affectedResource: "table:orders",
        recoveryAvailable: true,
        recoveryStatement: "restorable from the last snapshot within 24h",
        confirmationNonce: "nonce-1",
        confirmationExpiresAt: FUTURE,
      },
    }),
  );
  assert.equal(action.irreversible!.recoveryAvailable, true);
  assert.equal(action.irreversible!.rollbackUnavailableReason, undefined);
});

test("W1-T3894 (1): financial and irreversible classes require at least one configured approver", () => {
  assert.throws(() => classifyConsequenceAction(financialInput({ requiredApprovers: 0 })));
  assert.throws(() => classifyConsequenceAction(irreversibleInput({ requiredApprovers: 0 })));
});

test("W1-T3894 (1): an unknown consequenceClass is refused", () => {
  assert.throws(() =>
    classifyConsequenceAction(reversibleInput({ consequenceClass: "catastrophic" as ConsequenceActionInput["consequenceClass"] })),
  );
});

test("W1-T3894 (1): an unknown target.source is refused", () => {
  const input = reversibleInput();
  assert.throws(() =>
    classifyConsequenceAction({
      ...input,
      target: { identity: "flow:cache-warm", source: "guessed" as ConsequenceActionInput["target"]["source"] },
    }),
  );
});

for (const [label, patch] of Object.entries({
  "amount not positive": { amount: 0 },
  "invalid currency": { currency: "usd" },
  "aggregateCeiling below perActionCeiling": { aggregateCeiling: 10, perActionCeiling: 500 },
  "invalid quoteExpiresAt": { quoteExpiresAt: "not-a-date" },
  "negative coolingOffSeconds": { coolingOffSeconds: -1 },
})) {
  test(`W1-T3894 (1): classifyConsequenceAction refuses financial details with ${label}`, () => {
    const base = financialInput().financial!;
    assert.throws(() => classifyConsequenceAction(financialInput({ financial: { ...base, ...patch } })));
  });
}

test("W1-T3894 (1): a classified action is frozen — no caller can widen its target, scope, or approvals in place", () => {
  const action = classifyConsequenceAction(financialInput());
  assert.throws(() => {
    (action.target as { identity: string }).identity = "vendor:someone-else";
  });
  assert.throws(() => {
    (action.approvals as unknown[]).push({ approverId: "x", approvedAt: FUTURE, source: "trusted" });
  });
});
