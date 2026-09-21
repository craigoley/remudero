// test/agent-delegation-receipts.test.ts — W1-T3883 acceptance (5):
//   "parent and child receipts are linked and bounded without raw prompts, secrets, or
//    transcripts"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptDelegationEnvelope,
  createDelegationEnvelope,
  DELEGATION_RECEIPT_FIELD_MAX_CHARS,
  DELEGATION_RECEIPT_REASON_MAX_CHARS,
  executeBoundedDelegation,
  forwardDelegation,
  InMemoryDelegationEnvelopeStore,
} from "../src/lib/automation-action.js";

function issueAndAccept(store: InMemoryDelegationEnvelopeStore) {
  const envelope = createDelegationEnvelope({
    sender: "agent:scheduler",
    recipient: "agent:deployer",
    principal: "operator:alice",
    purpose: "roll the canary forward one step",
    capabilities: ["deploy.advance"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.issue(envelope);
  acceptDelegationEnvelope(store, { envelopeId: envelope.id, recipient: envelope.recipient, acceptedCapabilities: envelope.capabilities });
  return envelope;
}

// Every field name a receipt could carry — no field here is a plausible home for a raw prompt,
// credential, or transcript. Asserting the exact key set makes a future field addition reviewable
// rather than silently widening what a receipt can carry.
const ALLOWED_RECEIPT_KEYS = new Set(["receiptId", "envelopeId", "parentReceiptId", "capability", "audience", "actorIdentity", "decidedAt", "outcome", "code", "reason"]);

function assertBoundedReceipt(receipt: Record<string, unknown>) {
  for (const key of Object.keys(receipt)) {
    assert.ok(ALLOWED_RECEIPT_KEYS.has(key), `unexpected receipt field ${key} — no field here should hide a prompt, secret, or transcript`);
  }
  assert.ok((receipt.reason as string).length <= DELEGATION_RECEIPT_REASON_MAX_CHARS);
  for (const field of ["envelopeId", "capability", "audience", "actorIdentity"] as const) {
    assert.ok((receipt[field] as string).length <= DELEGATION_RECEIPT_FIELD_MAX_CHARS + 1); // +1 for the ellipsis
  }
}

test("W1-T3883 (5): a successful execution produces a bounded, attributable receipt", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const { receipt } = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: "deploy.advance",
    audience: envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(receipt.outcome, "executed");
  assert.equal(receipt.envelopeId, envelope.id);
  assert.equal(receipt.actorIdentity, envelope.recipient);
  assertBoundedReceipt(receipt as unknown as Record<string, unknown>);
});

test("W1-T3883 (5): a refused execution ALSO produces a bounded, attributable receipt", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const { receipt } = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: "agent:impostor",
    capability: "deploy.advance",
    audience: envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(receipt.outcome, "refused");
  assert.equal(receipt.code, "identity-mismatch");
  assertBoundedReceipt(receipt as unknown as Record<string, unknown>);
});

test("W1-T3883 (5): a forwarded child envelope's parentReceiptId links to the forward receipt, reconstructing who authorized the handoff", () => {
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
  assertBoundedReceipt(forward.receipt as unknown as Record<string, unknown>);
  assert.equal(forward.envelope.parentReceiptId, forward.receipt.receiptId);

  acceptDelegationEnvelope(store, { envelopeId: forward.envelope.id, recipient: forward.envelope.recipient, acceptedCapabilities: forward.envelope.capabilities });
  const { receipt: childReceipt } = executeBoundedDelegation(store, {
    envelopeId: forward.envelope.id,
    actorIdentity: forward.envelope.recipient,
    capability: "deploy.advance",
    audience: forward.envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  // The CHILD's own execution receipt links back to the FORWARD receipt (not the parent's
  // execution), which is itself traceable to the parent envelope — a reconstructable chain
  // without ever storing the parent's raw purpose text a second time.
  assert.equal(childReceipt.parentReceiptId, forward.receipt.receiptId);
  assertBoundedReceipt(childReceipt as unknown as Record<string, unknown>);
});

test("W1-T3883 (5): an oversized capability/audience/reason is bounded, not echoed unbounded", () => {
  const store = new InMemoryDelegationEnvelopeStore();
  const envelope = issueAndAccept(store);
  const longCapability = "deploy.advance".padEnd(DELEGATION_RECEIPT_FIELD_MAX_CHARS + 500, "x");
  const { receipt } = executeBoundedDelegation(store, {
    envelopeId: envelope.id,
    actorIdentity: envelope.recipient,
    capability: longCapability,
    audience: envelope.audience,
    nonce: "n1",
    risk: "low",
  });
  assert.equal(receipt.outcome, "refused");
  assert.ok(receipt.capability.length <= DELEGATION_RECEIPT_FIELD_MAX_CHARS + 1);
});
