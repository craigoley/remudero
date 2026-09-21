// test/agent-delegation-human-gates.test.ts — W1-T3883 acceptance (4):
//   "high-risk, destructive, financial, and credential actions remain human-gated across
//    handoffs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptDelegationEnvelope,
  createDelegationEnvelope,
  delegationRequiresHumanGate,
  executeBoundedDelegation,
  forwardDelegation,
  InMemoryDelegationEnvelopeStore,
  type DelegationRiskTier,
} from "../src/lib/automation-action.js";

const GATED_TIERS: readonly DelegationRiskTier[] = ["high", "production", "financial", "credential", "destructive"];

function issueAndAccept(store: InMemoryDelegationEnvelopeStore, capabilities: readonly string[] = ["deploy.advance"]) {
  const envelope = createDelegationEnvelope({
    sender: "agent:scheduler",
    recipient: "agent:deployer",
    principal: "operator:alice",
    purpose: "advance a risky step",
    capabilities,
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.issue(envelope);
  acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: capabilities });
  return envelope;
}

for (const risk of GATED_TIERS) {
  test(`W1-T3883 (4): a ${risk}-risk action with no human approval is refused human-gate-required`, () => {
    const store = new InMemoryDelegationEnvelopeStore();
    const envelope = issueAndAccept(store);
    const { verification } = executeBoundedDelegation(store, {
      envelopeId: envelope.id,
      actorIdentity: envelope.recipient,
      capability: "deploy.advance",
      audience: envelope.audience,
      nonce: "n1",
      risk,
    });
    assert.equal(verification.ok, false);
    if (!verification.ok) assert.equal(verification.code, "human-gate-required");
  });

  test(`W1-T3883 (4): a ${risk}-risk action with a valid human approval proceeds`, () => {
    const store = new InMemoryDelegationEnvelopeStore();
    const envelope = issueAndAccept(store);
    const { verification } = executeBoundedDelegation(store, {
      envelopeId: envelope.id,
      actorIdentity: envelope.recipient,
      capability: "deploy.advance",
      audience: envelope.audience,
      nonce: "n1",
      risk,
      humanApproval: { approvedBy: "operator:alice", approvedAt: new Date().toISOString() },
    });
    assert.equal(verification.ok, true);
  });
}

test("W1-T3883 (4): low and medium risk actions need no human approval", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  for (const risk of ["low", "medium"] as const) {
    const { verification } = executeBoundedDelegation(store, {
      envelopeId: envelope.id,
      actorIdentity: envelope.recipient,
      capability: "deploy.advance",
      audience: envelope.audience,
      nonce: `n-${risk}`,
      risk,
    });
    assert.equal(verification.ok, true);
  }
});

test("W1-T3883 (4): a malformed human approval (missing approvedBy) still refuses the gate", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const { verification } = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: "deploy.advance",
    audience: envelope.audience,
    nonce: "n1",
    risk: "financial",
    humanApproval: { approvedBy: "", approvedAt: new Date().toISOString() },
  });
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "human-gate-required");
});

test("W1-T3883 (4): every gated tier is recognised by delegationRequiresHumanGate and nothing else is", () => {
  for (const risk of GATED_TIERS) assert.equal(delegationRequiresHumanGate(risk), true);
  assert.equal(delegationRequiresHumanGate("low"), false);
  assert.equal(delegationRequiresHumanGate("medium"), false);
});

test("W1-T3883 (4): the human gate holds ACROSS a handoff — a forwarded envelope still requires approval for a gated action", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = issueAndAccept(store, ["payment.charge"]);
  const forward = forwardDelegation(store, {
    parentEnvelopeId: parent.id,
    forwarder: parent.recipient,
    newRecipient: "agent:sub-payer",
    capabilities: ["payment.charge"],
    purpose: "hand off a financial action",
    audience: parent.audience,
    expiresAt: parent.expiresAt,
  });
  assert.equal(forward.ok, true);
  if (!forward.ok) return;
  const child = forward.envelope;
  acceptDelegationEnvelope(store, { envelopeId: child.id, recipient: child.recipient, acceptedCapabilities: child.capabilities });

  const refused = executeBoundedDelegation(store, {
    envelopeId: child.id,
    actorIdentity: child.recipient,
    capability: "payment.charge",
    audience: child.audience,
    nonce: "n1",
    risk: "financial",
  });
  assert.equal(refused.verification.ok, false);
  if (!refused.verification.ok) assert.equal(refused.verification.code, "human-gate-required");

  const approved = executeBoundedDelegation(store, {
    envelopeId: child.id,
    actorIdentity: child.recipient,
    capability: "payment.charge",
    audience: child.audience,
    nonce: "n2",
    risk: "financial",
    humanApproval: { approvedBy: "operator:alice", approvedAt: new Date().toISOString() },
  });
  assert.equal(approved.verification.ok, true);
});
