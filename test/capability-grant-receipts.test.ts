// test/capability-grant-receipts.test.ts — W1-T3880 acceptance (5):
//   "a successful use and a refused use both produce bounded, attributable receipts"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPABILITY_RECEIPT_FIELD_MAX_CHARS,
  CAPABILITY_RECEIPT_REASON_MAX_CHARS,
  createCapabilityGrant,
  InMemoryCapabilityGrantStore,
  useCapabilityGrant,
} from "../src/lib/capability-grant.js";

const APPROVAL = { approvedBy: "operator:alice", approvedAt: new Date(Date.now() - 1_000).toISOString() };

function issue(overrides: Partial<Parameters<typeof createCapabilityGrant>[0]> = {}) {
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant({
    targetIdentity: "github-app:acme/widgets",
    operations: ["repo.read"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    useLimit: 2,
    approval: APPROVAL,
    revocationLink: "https://revoke.example/cap-1",
    ...overrides,
  });
  store.issue(grant);
  return { store, grant };
}

test("W1-T3880 (5): a successful use produces an attributable, 'used' receipt naming the grant, operation and audience", () => {
  const { store, grant } = issue();
  const { receipt } = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "repo.read",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(receipt.outcome, "used");
  assert.equal(receipt.grantId, grant.id);
  assert.equal(receipt.operation, "repo.read");
  assert.equal(receipt.audience, grant.audience);
  assert.equal(receipt.code, undefined);
  assert.equal(receipt.remainingUses, 1);
  assert.equal(typeof receipt.requestedAt, "string");
  assert.equal(Number.isNaN(Date.parse(receipt.requestedAt)), false, "requestedAt must be a real instant");
});

test("W1-T3880 (5): a caller-supplied clock provides the deterministic receipt timestamp", () => {
  const { store, grant } = issue();
  const { receipt } = useCapabilityGrant(
    store,
    { grantId: grant.id, operation: "repo.read", target: grant.targetIdentity, audience: grant.audience, nonce: "clocked-1" },
    { clock: { iso: () => "2030-01-02T03:04:05.000Z" } },
  );

  assert.equal(receipt.outcome, "used");
  assert.equal(receipt.requestedAt, "2030-01-02T03:04:05.000Z");
});

test("W1-T3880 (5): a refused use produces an attributable, 'refused' receipt naming a machine-readable code and a reason", () => {
  const { store, grant } = issue();
  const { receipt } = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: "repo.admin",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(receipt.outcome, "refused");
  assert.equal(receipt.code, "operation-not-granted");
  assert.equal(receipt.grantId, grant.id);
  assert.ok(receipt.reason.length > 0);
  assert.equal(receipt.remainingUses, undefined);
});

test("W1-T3880 (5): two attempts against the same grant are individually attributable — never merged or conflated", () => {
  const { store, grant } = issue({ useLimit: 5 });
  const first = useCapabilityGrant(store, {
    grantId: grant.id, operation: "repo.read", target: grant.targetIdentity, audience: grant.audience, nonce: "n1",
  });
  const second = useCapabilityGrant(store, {
    grantId: grant.id, operation: "repo.admin", target: grant.targetIdentity, audience: grant.audience, nonce: "n2",
  });
  assert.equal(first.receipt.outcome, "used");
  assert.equal(second.receipt.outcome, "refused");
  assert.notDeepEqual(first.receipt, second.receipt);
});

test("W1-T3880 (5): a receipt's free-text fields are BOUNDED — an oversized grantId/operation/audience is capped, never echoed unbounded", () => {
  const hugeOperation = "op." + "x".repeat(10_000);
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant({
    targetIdentity: "github-app:acme/widgets",
    operations: ["repo.read"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approval: APPROVAL,
    revocationLink: "https://revoke.example/cap-1",
  });
  store.issue(grant);
  const { receipt } = useCapabilityGrant(store, {
    grantId: grant.id,
    operation: hugeOperation,
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(receipt.outcome, "refused");
  assert.ok(
    receipt.operation.length <= CAPABILITY_RECEIPT_FIELD_MAX_CHARS + 1,
    `operation field must be capped at ${CAPABILITY_RECEIPT_FIELD_MAX_CHARS} chars, was ${receipt.operation.length}`,
  );
  assert.ok(
    receipt.reason.length <= CAPABILITY_RECEIPT_REASON_MAX_CHARS + 1,
    `reason field must be capped at ${CAPABILITY_RECEIPT_REASON_MAX_CHARS} chars, was ${receipt.reason.length}`,
  );
  assert.ok(
    JSON.stringify(receipt).length < hugeOperation.length,
    "the whole receipt must stay far smaller than an attacker-sized input field, not merely trim one copy of it",
  );
});

test("W1-T3880 (5): a refused attempt's receipt never claims 'used', and a used one never claims a refusal code", () => {
  const { store, grant } = issue();
  const used = useCapabilityGrant(store, {
    grantId: grant.id, operation: "repo.read", target: grant.targetIdentity, audience: grant.audience, nonce: "n1",
  });
  const refused = useCapabilityGrant(store, {
    grantId: grant.id, operation: "repo.read", target: grant.targetIdentity, audience: grant.audience, nonce: "n1",
  });
  assert.equal(used.receipt.outcome, "used");
  assert.equal("code" in used.receipt && used.receipt.code !== undefined, false);
  assert.equal(refused.receipt.outcome, "refused");
  assert.equal(refused.receipt.code, "replayed-nonce");
});
