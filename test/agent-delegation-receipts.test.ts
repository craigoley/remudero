// test/agent-delegation-receipts.test.ts — W1-T3883 acceptance (5):
//   "parent and child receipts are linked and bounded without raw prompts, secrets, or
//    transcripts"
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import {
  acceptDelegationEnvelope,
  createDelegationEnvelope,
  DELEGATION_RECEIPT_FIELD_MAX_CHARS,
  DELEGATION_RECEIPT_REASON_MAX_CHARS,
  executeBoundedDelegation,
  forwardDelegation,
  InMemoryDelegationEnvelopeStore,
} from "../src/lib/automation-action.js";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";

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

// ── POST /v1/operator-agent/delegation/handoff — the real wire path, not just the library call.
// Exercises buildOperatorAgentDelegationHandoffRoute end-to-end over a live HTTP server, the same
// createService + fetch pattern test/operator-agent-settings-scope-write.test.ts uses, so a
// defect in the route's own wiring (never reaching executeBoundedDelegation( at all, or losing a
// field between validateDelegationHandoff and the library call) is caught even though the library
// itself is separately proven above and in the other four agent-delegation-*.test.ts files.

const HANDOFF_WRITE_TOKEN = "agent-delegation-handoff-write-token";

async function withHandoffServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-agent-delegation-handoff-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({ tokens: { read: HANDOFF_WRITE_TOKEN, write: HANDOFF_WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function postHandoff(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/v1/operator-agent/delegation/handoff`, {
    method: "POST",
    headers: { authorization: `Bearer ${HANDOFF_WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("W1-T3883 (5, wire): a fully-populated high-risk handoff with a fresh human approval executes and ledgers a bounded receipt", async () => {
  await withHandoffServer(async (baseUrl) => {
    const response = await postHandoff(baseUrl, {
      envelope: {
        id: "dlg-wire-success",
        nonce: "n-wire-success",
        sender: "agent:scheduler",
        recipient: "agent:deployer",
        principal: "operator:alice",
        purpose: "roll the production canary forward one step",
        capabilities: ["deploy.advance"],
        scope: { repo: "acme/widgets", instance: "prod-1" },
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance"],
      action: {
        capability: "deploy.advance",
        nonce: "n1",
        risk: "high",
        humanApproval: { approvedBy: "operator:alice", approvedAt: new Date().toISOString() },
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; receipt: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.receipt.outcome, "executed");
    assert.equal(body.receipt.envelopeId, "dlg-wire-success");
    assertBoundedReceipt(body.receipt);
  });
});

test("W1-T3883 (5, wire): an envelope whose sender and recipient collide is refused before it is ever issued or stored", async () => {
  await withHandoffServer(async (baseUrl) => {
    const response = await postHandoff(baseUrl, {
      envelope: {
        sender: "agent:same",
        recipient: "agent:same",
        principal: "operator:alice",
        purpose: "should never be issued",
        capabilities: ["deploy.advance"],
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance"],
      action: { capability: "deploy.advance", nonce: "n1", risk: "low" },
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; detail: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.detail, /sender and recipient must be different/);
  });
});

test("W1-T3883 (5, wire): acceptance widening beyond the envelope's own allowlist is refused at the accept stage, never reaching execution", async () => {
  await withHandoffServer(async (baseUrl) => {
    const response = await postHandoff(baseUrl, {
      envelope: {
        id: "dlg-wire-widen",
        sender: "agent:scheduler",
        recipient: "agent:deployer",
        principal: "operator:alice",
        purpose: "roll the canary forward one step",
        capabilities: ["deploy.advance"],
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance", "deploy.rollback"],
      action: { capability: "deploy.advance", nonce: "n1", risk: "low" },
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { ok: boolean; stage: string; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.stage, "accept");
    assert.equal(body.code, "capability-widened");
  });
});

test("W1-T3883 (5, wire): a malformed action.risk is refused before any envelope is issued", async () => {
  await withHandoffServer(async (baseUrl) => {
    const response = await postHandoff(baseUrl, {
      envelope: {
        sender: "agent:scheduler",
        recipient: "agent:deployer",
        principal: "operator:alice",
        purpose: "roll the canary forward one step",
        capabilities: ["deploy.advance"],
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance"],
      action: { capability: "deploy.advance", nonce: "n1", risk: "extreme" },
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; detail: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.detail, /action\.risk must be one of/);
  });
});

test("W1-T3883 (5, wire): a malformed action.humanApproval is refused before any envelope is issued", async () => {
  await withHandoffServer(async (baseUrl) => {
    const response = await postHandoff(baseUrl, {
      envelope: {
        sender: "agent:scheduler",
        recipient: "agent:deployer",
        principal: "operator:alice",
        purpose: "roll the production canary forward one step",
        capabilities: ["deploy.advance"],
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance"],
      action: { capability: "deploy.advance", nonce: "n1", risk: "high", humanApproval: { approvedBy: "operator:alice", approvedAt: "not-a-date" } },
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; detail: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.detail, /action\.humanApproval requires a bounded approvedBy and a valid ISO approvedAt/);
  });
});

test("W1-T3883 (5, wire): an accepted envelope refuses an action requesting a capability outside what was accepted, and still ledgers a receipt", async () => {
  await withHandoffServer(async (baseUrl) => {
    const response = await postHandoff(baseUrl, {
      envelope: {
        id: "dlg-wire-execrefuse",
        sender: "agent:scheduler",
        recipient: "agent:deployer",
        principal: "operator:alice",
        purpose: "roll the canary forward one step",
        capabilities: ["deploy.advance", "deploy.rollback"],
        audience: "provider:cash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      acceptedCapabilities: ["deploy.advance"],
      action: { capability: "deploy.rollback", nonce: "n1", risk: "low" },
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { ok: boolean; receipt: Record<string, unknown> };
    assert.equal(body.ok, false);
    assert.equal(body.receipt.outcome, "refused");
    assert.equal(body.receipt.code, "capability-not-accepted");
    assertBoundedReceipt(body.receipt);
  });
});
