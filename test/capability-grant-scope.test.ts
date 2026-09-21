// test/capability-grant-scope.test.ts — W1-T3880 acceptance (1):
//   "a capability grant is scoped to an operation, target, audience, expiry, use limit, approval
//    receipt, and revocation link"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPABILITY_GRANT_SCHEMA_VERSION,
  createCapabilityGrant,
  InMemoryCapabilityGrantStore,
  verifyCapabilityGrant,
  type CapabilityUseRequest,
} from "../src/lib/capability-grant.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const APPROVAL = { approvedBy: "operator:alice", approvedAt: new Date(Date.now() - 1_000).toISOString() };

function baseInput(overrides: Partial<Parameters<typeof createCapabilityGrant>[0]> = {}) {
  return {
    targetIdentity: "github-app:acme/widgets",
    operations: ["repo.read"],
    audience: "provider:cash",
    expiresAt: FUTURE,
    approval: APPROVAL,
    revocationLink: "https://revoke.example/cap-1",
    ...overrides,
  };
}

test("W1-T3880 (1): a grant carries operation allowlist, target, audience, expiry, use limit, approval receipt and revocation link", () => {
  const grant = createCapabilityGrant(baseInput({ operations: ["repo.read", "repo.list"], useLimit: 3 }));
  assert.equal(grant.schema, CAPABILITY_GRANT_SCHEMA_VERSION);
  assert.equal(grant.targetIdentity, "github-app:acme/widgets");
  assert.deepEqual(grant.operations, ["repo.read", "repo.list"]);
  assert.equal(grant.audience, "provider:cash");
  assert.equal(grant.expiresAt, FUTURE);
  assert.equal(grant.useLimit, 3);
  assert.deepEqual(grant.approval, APPROVAL);
  assert.equal(grant.revocationLink, "https://revoke.example/cap-1");
});

test("W1-T3880 (1): useLimit defaults to 1 — a one-time grant — when omitted", () => {
  const grant = createCapabilityGrant(baseInput());
  assert.equal(grant.useLimit, 1);
});

test("W1-T3880 (1): a grant object carries no field named value/secret/token/password", () => {
  const grant = createCapabilityGrant(baseInput());
  const keys = Object.keys(grant);
  for (const forbidden of ["value", "secret", "token", "password", "credential"]) {
    assert.equal(keys.includes(forbidden), false, `grant must not carry a "${forbidden}" field`);
  }
});

test("W1-T3880 (1): a grant is frozen — no caller can widen one in place", () => {
  const grant = createCapabilityGrant(baseInput());
  assert.throws(() => {
    (grant.operations as string[]).push("repo.admin");
  });
  assert.throws(() => {
    (grant as { audience: string }).audience = "provider:anyone";
  });
});

for (const [label, patch] of Object.entries({
  "missing targetIdentity": { targetIdentity: "" },
  "empty operations": { operations: [] },
  "blank operation entry": { operations: [""] },
  "missing audience": { audience: "" },
  "invalid expiresAt": { expiresAt: "not-a-date" },
  "missing revocationLink": { revocationLink: "" },
  "useLimit zero": { useLimit: 0 },
  "useLimit fractional": { useLimit: 1.5 },
})) {
  test(`W1-T3880 (1): createCapabilityGrant refuses ${label}`, () => {
    assert.throws(() => createCapabilityGrant(baseInput(patch as Partial<Parameters<typeof createCapabilityGrant>[0]>)));
  });
}

test("W1-T3880 (1): createCapabilityGrant refuses a missing approval receipt", () => {
  assert.throws(() =>
    createCapabilityGrant(baseInput({ approval: { approvedBy: "", approvedAt: "" } })),
  );
});

test("W1-T3880 (1): operation matching is EXACT — a superset string does not ride an allowed entry through (the capability-ladder lesson)", () => {
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant(baseInput({ operations: ["email.read"] }));
  store.issue(grant);
  const request: CapabilityUseRequest = {
    grantId: grant.id,
    operation: "email.read.and.forward",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  };
  const verification = verifyCapabilityGrant(store, request);
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "operation-not-granted");
});

test("W1-T3880 (1): a request naming exactly one allowlisted operation and the correct target/audience is accepted", () => {
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant(baseInput({ operations: ["email.read", "email.list"] }));
  store.issue(grant);
  const verification = verifyCapabilityGrant(store, {
    grantId: grant.id,
    operation: "email.read",
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
  });
  assert.equal(verification.ok, true);
  if (verification.ok) assert.equal(verification.remainingUses, 0);
});
