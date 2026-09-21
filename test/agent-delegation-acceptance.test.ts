// test/agent-delegation-acceptance.test.ts — W1-T3883 acceptance (2):
//   "the recipient must explicitly accept before acting and may only narrow the granted
//    capability"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptDelegationEnvelope,
  createDelegationEnvelope,
  executeBoundedDelegation,
  InMemoryDelegationEnvelopeStore,
  revokeDelegationEnvelope,
} from "../src/lib/automation-action.js";

function issue(store: InMemoryDelegationEnvelopeStore, overrides: Partial<Parameters<typeof createDelegationEnvelope>[0]> = {}) {
  const envelope = createDelegationEnvelope({
    sender: "agent:scheduler",
    recipient: "agent:deployer",
    principal: "operator:alice",
    purpose: "roll the canary forward one step",
    capabilities: ["deploy.advance", "deploy.observe"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
  store.issue(envelope);
  return envelope;
}

test("W1-T3883 (2): an action attempted before acceptance is refused not-accepted", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const { verification } = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: "deploy.advance",
    audience: envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "not-accepted");
});

test("W1-T3883 (2): accepting the full envelope permits acting on any granted capability", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const accept = acceptDelegationEnvelope(store, {
    envelopeId: envelope.id,
    recipient: envelope.recipient,
    acceptedCapabilities: ["deploy.advance", "deploy.observe"],
  });
  assert.equal(accept.ok, true);
  const { verification } = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: "deploy.observe",
    audience: envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(verification.ok, true);
});

test("W1-T3883 (2): the recipient may narrow the granted capability set at acceptance", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const accept = acceptDelegationEnvelope(store, {
    envelopeId: envelope.id,
    recipient: envelope.recipient,
    acceptedCapabilities: ["deploy.observe"],
  });
  assert.equal(accept.ok, true);
  const attempt = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: "deploy.advance",
    audience: envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(attempt.verification.ok, false);
  if (!attempt.verification.ok) assert.equal(attempt.verification.code, "capability-not-accepted");
});

test("W1-T3883 (2): acceptance can never WIDEN the envelope's own capability set", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const accept = acceptDelegationEnvelope(store, {
    envelopeId: envelope.id,
    recipient: envelope.recipient,
    acceptedCapabilities: ["deploy.advance", "deploy.rollback"],
  });
  assert.equal(accept.ok, false);
  if (!accept.ok) assert.equal(accept.code, "capability-widened");
});

test("W1-T3883 (2): an acceptance from any identity other than the envelope's own recipient is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const accept = acceptDelegationEnvelope(store, {
    envelopeId: envelope.id,
    recipient: "agent:impostor",
    acceptedCapabilities: ["deploy.advance"],
  });
  assert.equal(accept.ok, false);
  if (!accept.ok) assert.equal(accept.code, "identity-mismatch");
});

test("W1-T3883 (2): a second acceptance of the same envelope is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const first = acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: ["deploy.advance"] });
  assert.equal(first.ok, true);
  const second = acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: ["deploy.observe"] });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "already-accepted");
});

test("W1-T3883 (2): an empty acceptance is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  const accept = acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: [] });
  assert.equal(accept.ok, false);
  if (!accept.ok) assert.equal(accept.code, "empty-acceptance");
});

test("W1-T3883 (2): acceptance of an unknown envelope id is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const accept = acceptDelegationEnvelope(store, { envelopeId: "dlg-never-issued", recipient: "agent:deployer", acceptedCapabilities: ["deploy.advance"] });
  assert.equal(accept.ok, false);
  if (!accept.ok) assert.equal(accept.code, "unknown-envelope");
});

test("W1-T3883 (2): acceptance of a revoked envelope is refused even before it was ever accepted", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store);
  revokeDelegationEnvelope(store, envelope.id);
  const accept = acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: ["deploy.advance"] });
  assert.equal(accept.ok, false);
  if (!accept.ok) assert.equal(accept.code, "revoked");
});

test("W1-T3883 (2): acceptance of an already-expired envelope is refused", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issue(store, { expiresAt: new Date(Date.now() + 1_000).toISOString() });
  const accept = acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: ["deploy.advance"] }, { now: Date.now() + 5_000 });
  assert.equal(accept.ok, false);
  if (!accept.ok) assert.equal(accept.code, "expired");
});
