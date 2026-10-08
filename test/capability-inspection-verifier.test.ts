import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapabilityGrant, InMemoryCapabilityGrantStore, useCapabilityGrant } from "../src/lib/capability-grant.js";
import { inspectCapabilityDecision, replayCapabilityDecisions, compareCapabilityReplays } from "../src/lib/capability-inspection.js";

test("test/capability-inspection-verifier.test.ts: canonical verification and independent replay preserve state", () => {
  const store = new InMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant({ id: "g", targetIdentity: "target", operations: ["read"],
    audience: "caller", expiresAt: "2030-01-01T00:00:00Z", useLimit: 1,
    approval: { approvedBy: "operator", approvedAt: "2026-01-01T00:00:00Z" }, revocationLink: "revoke" });
  let secretReads = 0;
  store.issue(grant, () => { secretReads++; return "secret"; });
  const request = { grantId: "g", target: "target", operation: "read", audience: "caller", nonce: "n" };
  const now = "2026-10-08T00:00:00Z";
  const before = replayCapabilityDecisions(store, [request, request], now);
  assert.deepEqual(before.results.map((r) => r.verdict), ["allow", "allow"]);
  assert.equal(before.results[0].schema, "capability-inspection-v1");
  assert.equal(store.get("g"), grant);
  assert.equal(store.useCount("g"), 0);
  assert.equal(store.hasSeenNonce("g", "n"), false);
  assert.equal(store.isRevoked("g"), false);
  assert.equal(secretReads, 0);
  const wider = { ...request, operation: "admin", grant: { ...grant, operations: ["admin"] } };
  assert.equal(inspectCapabilityDecision(store, wider, now).code, "operation-not-granted");
  useCapabilityGrant(store, request, { now });
  const after = replayCapabilityDecisions(store, [request, { ...request, nonce: "new" }], now);
  assert.deepEqual(after.results.map((r) => r.code), ["replayed-nonce", "use-limit-exceeded"]);
  assert.deepEqual(compareCapabilityReplays(before, after).changes, ["changed", "changed"]);
  assert.deepEqual(compareCapabilityReplays(after, after).changes, ["unchanged", "unchanged"]);
  assert.equal(store.useCount("g"), 1);
  assert.equal(secretReads, 0);
  store.revoke("g");
  assert.equal(inspectCapabilityDecision(store, request, now).code, "revoked");
});

test("replay captures each canonical grant and state once before evaluating cases", () => {
  const grant = createCapabilityGrant({ id: "g", targetIdentity: "t", operations: ["read"], audience: "a",
    expiresAt: "2030-01-01Z", approval: { approvedBy: "o", approvedAt: "2026-01-01Z" }, revocationLink: "r" });
  const calls = { get: 0, revoked: 0, count: 0, nonce: 0 };
  const source = {
    get: () => { calls.get++; return grant; },
    isRevoked: () => { calls.revoked++; return false; },
    useCount: () => { calls.count++; return 0; },
    hasSeenNonce: () => { calls.nonce++; return false; },
    record: () => assert.fail("inspection records nothing"),
    resolveSecret: () => assert.fail("inspection resolves nothing"),
  };
  const request = { grantId: "g", target: "t", operation: "read", audience: "a", nonce: "n" };
  assert.deepEqual(replayCapabilityDecisions(source, [request, request], "2026-01-02Z").results.map((r) => r.verdict), ["allow", "allow"]);
  assert.deepEqual(calls, { get: 1, revoked: 1, count: 1, nonce: 1 });
});
