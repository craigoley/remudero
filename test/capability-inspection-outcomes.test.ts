import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapabilityGrant, InMemoryCapabilityGrantStore, verifyCapabilityGrant } from "../src/lib/capability-grant.js";
import { inspectCapabilityDecision } from "../src/lib/capability-inspection.js";

test("test/capability-inspection-outcomes.test.ts: allow and every refusal agree with the explicit verifier clock", () => {
  const request = { grantId: "g", operation: "read", target: "t", audience: "a", nonce: "n" };
  const grant = createCapabilityGrant({ id: "g", targetIdentity: "t", operations: ["read"], audience: "a",
    scope: { repo: "repo", instance: "instance" }, expiresAt: "2026-10-09T00:00:00Z", useLimit: 1,
    approval: { approvedBy: "o", approvedAt: "2026-01-01Z" }, revocationLink: "r" });
  const cases = [
    { code: "allow" }, { code: "unknown-grant", patch: { grantId: "absent" } },
    { code: "revoked", revoke: true }, { code: "expired", now: grant.expiresAt },
    { code: "wrong-audience", patch: { audience: "other" } },
    { code: "wrong-target", patch: { target: "other" } },
    { code: "operation-not-granted", patch: { operation: "read.admin" } },
    { code: "replayed-nonce", record: "n" }, { code: "use-limit-exceeded", record: "other" },
  ];
  for (const control of cases) {
    const store = new InMemoryCapabilityGrantStore();
    store.issue(grant);
    if (control.revoke) store.revoke("g");
    if (control.record) store.record("g", control.record);
    const input = { ...request, ...control.patch };
    const now = control.now ?? "2026-10-08T00:00:00Z";
    const actual = verifyCapabilityGrant(store, input, { now });
    const inspected = inspectCapabilityDecision(store, input, now);
    assert.equal(inspected.code, control.code);
    assert.equal(inspected.verdict, actual.ok ? "allow" : "refuse");
    assert.equal(inspected.observedAt, new Date(now).toISOString());
    assert.equal(inspected.predicates.repo, "not-checked");
    assert.equal(inspected.predicates.instance, "not-checked");
    if (actual.ok) assert.equal(inspected.remainingUsesAfterHypotheticalUse, actual.remainingUses);
    else assert.equal(inspected.predicates[actual.code === "unknown-grant" ? "canonical-grant" : actual.code], "fail");
    if (control.revoke) assert.equal(inspected.predicates.expired, "not-checked");
  }
});
