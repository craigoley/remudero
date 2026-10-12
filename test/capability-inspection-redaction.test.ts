import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapabilityGrant, InMemoryCapabilityGrantStore } from "../src/lib/capability-grant.js";
import { inspectCapabilityDecision, replayCapabilityDecisions, CAPABILITY_INSPECTION_MAX_CASES, CAPABILITY_INSPECTION_MAX_STRING } from "../src/lib/capability-inspection.js";

test("test/capability-inspection-redaction.test.ts: allowlisted output omits payloads and bounds counts and strings", () => {
  const payload = "sensitive-attacker-payload";
  const grant = createCapabilityGrant({ id: payload, targetIdentity: payload, operations: [payload], audience: payload,
    expiresAt: "2030-01-01Z", approval: { approvedBy: payload, approvedAt: "2026-01-01Z", reason: payload },
    revocationLink: payload, scope: { repo: payload, instance: payload } });
  const store = new InMemoryCapabilityGrantStore();
  store.issue(grant, () => assert.fail("secret resolver"));
  const request = { grantId: payload, target: payload, operation: payload, audience: payload, nonce: payload,
    arguments: { token: payload }, approval: payload, receipt: payload };
  const allow = inspectCapabilityDecision(store, request, "2026-10-08Z");
  assert.equal(allow.verdict, "allow");
  const refusal = inspectCapabilityDecision(store, { ...request, operation: "denied" }, "2026-10-08Z");
  assert.equal(refusal.verdict, "refuse");
  for (const result of [allow, refusal]) {
    assert.equal(JSON.stringify(result).includes(payload), false);
    assert.deepEqual(Object.keys(result).sort(), (result.verdict === "allow"
      ? ["schema", "observedAt", "verdict", "code", "predicates", "remainingUsesAfterHypotheticalUse"]
      : ["schema", "observedAt", "verdict", "code", "predicates"]).sort());
  }
  const long = "x".repeat(CAPABILITY_INSPECTION_MAX_STRING + 1);
  assert.equal(inspectCapabilityDecision(store, { ...request, nonce: long }, "2026-10-08Z").code, "invalid-request");
  assert.equal(inspectCapabilityDecision(store, request, long).code, "invalid-clock");
  const tooMany = replayCapabilityDecisions(store, Array(CAPABILITY_INSPECTION_MAX_CASES + 1).fill(request), "2026-10-08Z");
  assert.equal(tooMany.code, "too-many-cases");
  assert.equal(tooMany.results.length, 0);
  const batch = replayCapabilityDecisions(store, Array(CAPABILITY_INSPECTION_MAX_CASES).fill(request), "2026-10-08Z");
  assert.equal(batch.results.length, CAPABILITY_INSPECTION_MAX_CASES);
  assert.ok(JSON.stringify(batch).length < 100_000);
});
