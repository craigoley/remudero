// test/capability-grant-replay.test.ts — W1-T3880 acceptance (3):
//   "expired, revoked, replayed, wrong-audience, and operation-expanding requests are refused"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCapabilityGrant,
  InMemoryCapabilityGrantStore,
  useCapabilityGrant,
  verifyCapabilityGrant,
  type CapabilityUseRequest,
} from "../src/lib/capability-grant.js";

const APPROVAL = { approvedBy: "operator:alice", approvedAt: new Date(Date.now() - 1_000).toISOString() };

function issue(overrides: Partial<Parameters<typeof createCapabilityGrant>[0]> = {}) {
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant({
    targetIdentity: "github-app:acme/widgets",
    operations: ["repo.read"],
    audience: "provider:cash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    useLimit: 1,
    approval: APPROVAL,
    revocationLink: "https://revoke.example/cap-1",
    ...overrides,
  });
  store.issue(grant);
  return { store, grant };
}

function requestFor(grant: ReturnType<typeof issue>["grant"], patch: Partial<CapabilityUseRequest> = {}): CapabilityUseRequest {
  return {
    grantId: grant.id,
    operation: grant.operations[0],
    target: grant.targetIdentity,
    audience: grant.audience,
    nonce: "n1",
    ...patch,
  };
}

test("W1-T3880 (3): an unknown grant id is refused", () => {
  const { store, grant } = issue();
  const verification = verifyCapabilityGrant(store, requestFor(grant, { grantId: "cap-does-not-exist" }));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "unknown-grant");
});

test("W1-T3880 (3): an expired grant is refused", () => {
  const { store, grant } = issue({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
  const verification = verifyCapabilityGrant(store, requestFor(grant));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "expired");
});

test("W1-T3880 (3): a revoked grant is refused even though it has not expired and has remaining uses", () => {
  const { store, grant } = issue({ useLimit: 5 });
  store.revoke(grant.id);
  const verification = verifyCapabilityGrant(store, requestFor(grant));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "revoked");
});

test("W1-T3880 (3): a wrong-audience request is refused", () => {
  const { store, grant } = issue();
  const verification = verifyCapabilityGrant(store, requestFor(grant, { audience: "provider:someone-else" }));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "wrong-audience");
});

test("W1-T3880 (3): a wrong-target request is refused", () => {
  const { store, grant } = issue();
  const verification = verifyCapabilityGrant(store, requestFor(grant, { target: "github-app:acme/OTHER" }));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "wrong-target");
});

test("W1-T3880 (3): an operation-expanding request (not in the allowlist) is refused", () => {
  const { store, grant } = issue();
  const verification = verifyCapabilityGrant(store, requestFor(grant, { operation: "repo.admin" }));
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.code, "operation-not-granted");
});

test("W1-T3880 (3): a replayed nonce is refused, even with uses remaining", () => {
  const { store, grant } = issue({ useLimit: 5 });
  const first = useCapabilityGrant(store, requestFor(grant, { nonce: "n1" }));
  assert.equal(first.verification.ok, true);
  const replay = verifyCapabilityGrant(store, requestFor(grant, { nonce: "n1" }));
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.code, "replayed-nonce");
});

test("W1-T3880 (3): a one-time grant's second use is refused by use-limit, even with a FRESH nonce (never a mere replay)", () => {
  const { store, grant } = issue({ useLimit: 1 });
  const first = useCapabilityGrant(store, requestFor(grant, { nonce: "n1" }));
  assert.equal(first.verification.ok, true);
  const second = verifyCapabilityGrant(store, requestFor(grant, { nonce: "n2" }));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "use-limit-exceeded");
});

test("W1-T3880 (3): a refused attempt never consumes the grant — the next legitimate attempt still succeeds", () => {
  const { store, grant } = issue({ useLimit: 1 });
  const refused = useCapabilityGrant(store, requestFor(grant, { operation: "repo.admin", nonce: "n1" }));
  assert.equal(refused.verification.ok, false);
  const legit = useCapabilityGrant(store, requestFor(grant, { nonce: "n2" }));
  assert.equal(legit.verification.ok, true);
});
