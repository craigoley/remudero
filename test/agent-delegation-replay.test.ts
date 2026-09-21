// test/agent-delegation-replay.test.ts — W1-T3883 acceptance (3):
//   "forwarding, replay, expiry, revocation, identity mismatch, and unavailable audit sources
//    refuse safely"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptDelegationEnvelope,
  createDelegationEnvelope,
  executeBoundedDelegation,
  forwardDelegation,
  InMemoryDelegationEnvelopeStore,
  revokeDelegationEnvelope,
} from "../src/lib/automation-action.js";

function issueAndAccept(
  store: InMemoryDelegationEnvelopeStore,
  overrides: Partial<Parameters<typeof createDelegationEnvelope>[0]> = {},
  acceptedCapabilities?: readonly string[],
) {
  const envelope = createDelegationEnvelope({
    sender: "agent:scheduler",
    recipient: "agent:deployer",
    principal: "operator:alice",
    purpose: "roll the canary forward one step",
    capabilities: ["deploy.advance"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
  store.issue(envelope);
  const accept = acceptDelegationEnvelope(store, {
    envelopeId: envelope.id,
    recipient: envelope.recipient,
    acceptedCapabilities: acceptedCapabilities ?? envelope.capabilities,
  });
  assert.equal(accept.ok, true, "fixture setup: acceptance must succeed");
  return envelope;
}

function actionFor(envelope: ReturnType<typeof issueAndAccept>, patch: Record<string, unknown> = {}) {
  return {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: envelope.capabilities[0],
    audience: envelope.audience,
    nonce: "n1",
    risk: "low" as const,
    ...patch,
  };
}

test("W1-T3883 (3): a replayed nonce is refused even though the envelope is otherwise valid", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const first = executeBoundedDelegation(store, actionFor(envelope, { nonce: "n1" }));
  assert.equal(first.verification.ok, true);
  const replay = executeBoundedDelegation(store, actionFor(envelope, { nonce: "n1" }));
  assert.equal(replay.verification.ok, false);
  if (!replay.verification.ok) assert.equal(replay.verification.code, "replayed-nonce");
});

test("W1-T3883 (3): an expired envelope is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  // Accepted while still valid, then acted on AFTER its own expiry — expiry is checked live at
  // the execute step, not only at acceptance.
  const envelope = issueAndAccept(store, { expiresAt: new Date(Date.now() + 1_000).toISOString() });
  const { verification } = executeBoundedDelegation(store, actionFor(envelope), { now: Date.now() + 5_000 });
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "expired");
});

test("W1-T3883 (3): a revoked envelope is refused even though it has not expired", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  revokeDelegationEnvelope(store, envelope.id);
  const { verification } = executeBoundedDelegation(store, actionFor(envelope));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "revoked");
});

test("W1-T3883 (3): acting after the PARENT of a forwarded envelope is revoked is refused, even though the child itself was never revoked", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = issueAndAccept(store);
  const forward = forwardDelegation(store, {
    parentEnvelopeId: parent.id,
    forwarder: parent.recipient,
    newRecipient: "agent:sub-deployer",
    capabilities: ["deploy.advance"],
    purpose: "hand this step to the sub-deployer",
    audience: parent.audience,
    expiresAt: parent.expiresAt,
  });
  assert.equal(forward.ok, true);
  if (!forward.ok) return;
  const child = forward.envelope;
  const childAccept = acceptDelegationEnvelope(store, {
    envelopeId: child.id,
    recipient: child.recipient,
    acceptedCapabilities: child.capabilities,
  });
  assert.equal(childAccept.ok, true);
  revokeDelegationEnvelope(store, parent.id);
  const { verification } = executeBoundedDelegation(store, actionFor(child));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "parent-revoked");
});

test("W1-T3883 (3): an action requesting an audience other than the envelope's own is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const { verification } = executeBoundedDelegation(store, actionFor(envelope, { audience: "provider:someone-else" }));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "wrong-audience");
});

test("W1-T3883 (3): an identity other than the envelope's own recipient is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const { verification } = executeBoundedDelegation(store, actionFor(envelope, { actorIdentity: "agent:impostor" }));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "identity-mismatch");
});

test("W1-T3883 (3): an unavailable audit source refuses the action rather than let it proceed unrecorded", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  store.setAuditAvailable(false);
  const { verification } = executeBoundedDelegation(store, actionFor(envelope));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "audit-unavailable");
});

test("W1-T3883 (3): forwarding never transfers transitive authority — the new recipient must still accept before acting", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = issueAndAccept(store);
  const forward = forwardDelegation(store, {
    parentEnvelopeId: parent.id,
    forwarder: parent.recipient,
    newRecipient: "agent:sub-deployer",
    capabilities: ["deploy.advance"],
    purpose: "hand this step to the sub-deployer",
    audience: parent.audience,
    expiresAt: parent.expiresAt,
  });
  assert.equal(forward.ok, true);
  if (!forward.ok) return;
  const child = forward.envelope;
  assert.notEqual(child.id, parent.id);
  assert.equal(child.parentReceiptId, forward.receipt.receiptId);
  const attempt = executeBoundedDelegation(store, {
    envelopeId: child.id,
    actorIdentity: child.recipient,
    capability: "deploy.advance",
    audience: child.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(attempt.verification.ok, false);
  if (!attempt.verification.ok) assert.equal(attempt.verification.code, "not-accepted");
});

test("W1-T3883 (3): forwarding can only narrow — it refuses a capability the forwarder itself never accepted", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = createDelegationEnvelope({
    sender: "agent:scheduler",
    recipient: "agent:deployer",
    principal: "operator:alice",
    purpose: "roll the canary forward",
    capabilities: ["deploy.advance", "deploy.rollback"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.issue(parent);
  acceptDelegationEnvelope(store, { envelopeId: parent.id, recipient: parent.recipient, acceptedCapabilities: ["deploy.advance"] });
  const forward = forwardDelegation(store, {
    parentEnvelopeId: parent.id,
    forwarder: parent.recipient,
    newRecipient: "agent:sub-deployer",
    capabilities: ["deploy.rollback"],
    purpose: "attempt to hand off a capability never accepted",
    audience: parent.audience,
    expiresAt: parent.expiresAt,
  });
  assert.equal(forward.ok, false);
  if (!forward.ok) assert.equal(forward.code, "capability-widened");
});

test("W1-T3883 (3): forwarding can never outlive the parent's own expiry", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = issueAndAccept(store, { expiresAt: new Date(Date.now() + 30_000).toISOString() });
  const forward = forwardDelegation(store, {
    parentEnvelopeId: parent.id,
    forwarder: parent.recipient,
    newRecipient: "agent:sub-deployer",
    capabilities: ["deploy.advance"],
    purpose: "attempt to outlive the parent",
    audience: parent.audience,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(forward.ok, false);
  if (!forward.ok) assert.equal(forward.code, "expiry-widened");
});

test("W1-T3883 (3): forwarding an already-expired parent envelope is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = issueAndAccept(store, { expiresAt: new Date(Date.now() + 1_000).toISOString() });
  const forward = forwardDelegation(
    store,
    {
      parentEnvelopeId: parent.id,
      forwarder: parent.recipient,
      newRecipient: "agent:sub-deployer",
      capabilities: ["deploy.advance"],
      purpose: "attempt to forward after the parent expired",
      audience: parent.audience,
      expiresAt: parent.expiresAt,
    },
    { now: Date.now() + 5_000 },
  );
  assert.equal(forward.ok, false);
  if (!forward.ok) assert.equal(forward.code, "expired");
});

test("W1-T3883 (3): only the envelope's own recipient may forward it", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const parent = issueAndAccept(store);
  const forward = forwardDelegation(store, {
    parentEnvelopeId: parent.id,
    forwarder: "agent:impostor",
    newRecipient: "agent:sub-deployer",
    capabilities: ["deploy.advance"],
    purpose: "attempt to forward without being the recipient",
    audience: parent.audience,
    expiresAt: parent.expiresAt,
  });
  assert.equal(forward.ok, false);
  if (!forward.ok) assert.equal(forward.code, "identity-mismatch");
});
