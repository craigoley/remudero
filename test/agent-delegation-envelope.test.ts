// test/agent-delegation-envelope.test.ts — W1-T3883 acceptance (1):
//   "a delegation envelope binds sender, recipient, principal, purpose, capability, scope,
//    audience, expiry, nonce, and parent receipt"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDelegationEnvelope,
  DELEGATION_ENVELOPE_SCHEMA_VERSION,
  type DelegationEnvelopeInput,
} from "../src/lib/automation-action.js";

function baseInput(overrides: Partial<DelegationEnvelopeInput> = {}): DelegationEnvelopeInput {
  return {
    sender: "agent:scheduler",
    recipient: "agent:deployer",
    principal: "operator:alice",
    purpose: "roll the canary forward one step",
    capabilities: ["deploy.advance"],
    scope: { repo: "acme/widgets" },
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "n-issue-1",
    ...overrides,
  };
}

test("W1-T3883 (1): a created envelope binds every named field", () => {
  const envelope = createDelegationEnvelope(baseInput());
  assert.equal(envelope.schema, DELEGATION_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.sender, "agent:scheduler");
  assert.equal(envelope.recipient, "agent:deployer");
  assert.equal(envelope.principal, "operator:alice");
  assert.equal(envelope.purpose, "roll the canary forward one step");
  assert.deepEqual(envelope.capabilities, ["deploy.advance"]);
  assert.deepEqual(envelope.scope, { repo: "acme/widgets" });
  assert.equal(envelope.audience, "provider:cash");
  assert.equal(typeof envelope.expiresAt, "string");
  assert.equal(envelope.nonce, "n-issue-1");
});

test("W1-T3883 (1): a parent receipt id, when supplied, is preserved on the envelope", () => {
  const envelope = createDelegationEnvelope(baseInput({ parentReceiptId: "rcpt-parent-1" }));
  assert.equal(envelope.parentReceiptId, "rcpt-parent-1");
});

test("W1-T3883 (1): a root envelope (no forwarding yet) carries no parent receipt", () => {
  const envelope = createDelegationEnvelope(baseInput());
  assert.equal(envelope.parentReceiptId, undefined);
});

test("W1-T3883 (1): id and nonce default to unique values when omitted", () => {
  const a = createDelegationEnvelope(baseInput({ nonce: undefined }));
  const b = createDelegationEnvelope(baseInput({ nonce: undefined }));
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.nonce, b.nonce);
});

test("W1-T3883 (1): the envelope is deep-frozen — no field is mutable after issuance", () => {
  const envelope = createDelegationEnvelope(baseInput());
  assert.throws(() => {
    (envelope as { sender: string }).sender = "agent:someone-else";
  });
  assert.throws(() => {
    (envelope.capabilities as string[]).push("deploy.rollback");
  });
});

test("W1-T3883 (1): sender and recipient must be different identities", () => {
  assert.throws(() => createDelegationEnvelope(baseInput({ sender: "agent:same", recipient: "agent:same" })), /different identities/);
});

test("W1-T3883 (1): missing principal is refused at issuance", () => {
  assert.throws(() => createDelegationEnvelope(baseInput({ principal: "" })), /principal/);
});

test("W1-T3883 (1): an empty capability allowlist is refused at issuance", () => {
  assert.throws(() => createDelegationEnvelope(baseInput({ capabilities: [] })), /capabilities/);
});

test("W1-T3883 (1): a malformed expiresAt is refused at issuance", () => {
  assert.throws(() => createDelegationEnvelope(baseInput({ expiresAt: "not-a-date" })), /expiresAt/);
});
