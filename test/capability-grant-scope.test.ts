// test/capability-grant-scope.test.ts — W1-T3880 acceptance (1):
//   "a capability grant is scoped to an operation, target, audience, expiry, use limit, approval
//    receipt, and revocation link"
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CAPABILITY_GRANT_SCHEMA_VERSION,
  createCapabilityGrant,
  InMemoryCapabilityGrantStore,
  verifyCapabilityGrant,
  type CapabilityUseRequest,
} from "../src/lib/capability-grant.js";
import type { Config } from "../src/lib/config.js";
import { CapabilityGrantRefusedError, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";

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

// W1-T3880 acceptance (6): "the provider execution path verifies the capability grant before
// using it" (grep: verifyCapabilityGrant( in src/lib/worker-provider.ts). This drives that call
// site: a refused grant must stop spawnOpenWeightWorker before it ever reads the API key or makes
// a network call.
test("W1-T3880 (6): spawnOpenWeightWorker refuses a capability grant BEFORE reading the API key or calling fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capability-grant-provider-"));
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant(baseInput({ operations: ["repo.read"] }));
  store.issue(grant);
  let fetchCalls = 0;
  const config = { claudeBin: "/unused/claude", root, dailyCapUsd: 5 } as Config;
  const result = await spawnOpenWeightWorker(
    {
      cwd: root,
      workerHome: join(root, "worker-home"),
      prompt: "classify",
      // Deliberately NO RMD_OPENWEIGHT_API_KEY in env — if verification did not refuse first, the
      // very next line this function reaches would throw on the missing key instead, which would
      // prove nothing about the capability-grant call site specifically.
      env: {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("should never be reached", { status: 200 });
      },
      capabilityGrant: {
        store,
        request: { grantId: grant.id, operation: "repo.admin", target: grant.targetIdentity, audience: grant.audience, nonce: "n1" },
      },
    },
    config,
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(fetchCalls, 0, "a refused grant must never reach the transport call");
  assert.equal(result.isError, true);
  assert.match(result.stderr, /capability grant .* refused/);
  assert.match(result.stderr, /repo\.admin/);
});

test("W1-T3880 (6): CapabilityGrantRefusedError carries the machine-readable refusal code", () => {
  const err = new CapabilityGrantRefusedError("operation not in the allowlist", "operation-not-granted", "cap-1");
  assert.equal(err.code, "operation-not-granted");
  assert.equal(err.kind, "usage");
});
