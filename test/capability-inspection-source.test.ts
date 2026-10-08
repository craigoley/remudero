import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCapabilityGrant, InMemoryCapabilityGrantStore, type CapabilityGrant } from "../src/lib/capability-grant.js";
import { inspectCapabilityDecision, replayCapabilityDecisions, compareCapabilityReplays, loadCapabilityInspectionSource, type CapabilityInspectionSource } from "../src/lib/capability-inspection.js";

test("test/capability-inspection-source.test.ts: unknown input and unavailable sources are distinct from refusal", () => {
  const request = { grantId: "g", target: "t", operation: "read", audience: "a", nonce: "n" };
  const now = "2026-10-08Z";
  const store = new InMemoryCapabilityGrantStore();
  assert.equal(inspectCapabilityDecision(store, request, now).verdict, "refuse");
  assert.equal(inspectCapabilityDecision(null, request, now).code, "missing-source");
  for (const invalid of [null, [], {}, { ...request, nonce: "" }, { ...request, audience: 7 }]) {
    assert.equal(inspectCapabilityDecision(store, invalid, now).verdict, "unknown");
  }
  for (const invalid of [undefined, "bad", Infinity, {}, 9e20]) {
    assert.equal(inspectCapabilityDecision(store, request, invalid).code, "invalid-clock");
  }
  const grant = createCapabilityGrant({ id: "g", targetIdentity: "t", operations: ["read"], audience: "a",
    expiresAt: "2030-01-01Z", scope: { repo: "other", instance: "other" },
    approval: { approvedBy: "o", approvedAt: "2026-01-01Z" }, revocationLink: "r" });
  const source = { get: () => grant, isRevoked: () => false, useCount: () => 0, hasSeenNonce: () => false };
  for (const seam of ["get", "isRevoked", "useCount", "hasSeenNonce"]) {
    const broken = { ...source, [seam]: () => { throw new Error("secret upstream error"); } };
    const outcome = inspectCapabilityDecision(broken, request, now);
    assert.equal(outcome.verdict, "unavailable");
    assert.equal(outcome.code, "unreadable-source");
  }
  for (const broken of [
    { ...source, get: () => ({ ...grant, id: "wrong" }) },
    { ...source, get: () => ({ ...grant, expiresAt: "bad" }) },
    { ...source, get: () => ({ ...grant, useLimit: 0 }) },
    { ...source, get: () => ({ ...grant, operations: [] }) },
    { ...source, get: () => ({ ...grant, schema: "other" }) },
    { ...source, get: () => null as unknown as CapabilityGrant },
    { ...source, useCount: () => -1 },
    { ...source, isRevoked: () => "false" as unknown as boolean },
    { ...source, hasSeenNonce: () => undefined as unknown as boolean },
  ]) assert.equal(inspectCapabilityDecision(broken as CapabilityInspectionSource, request, now).code, "malformed-source");
  const allowed = inspectCapabilityDecision(source, { ...request, repo: "different", instance: "different" }, now);
  assert.equal(allowed.verdict, "allow");
  assert.equal(allowed.predicates.repo, "not-checked");
  assert.equal(allowed.predicates.instance, "not-checked");
  const good = replayCapabilityDecisions(source, [request], now);
  const unknown = replayCapabilityDecisions(null, [request], now);
  assert.deepEqual(compareCapabilityReplays(good, unknown).changes, ["incomparable"]);
  assert.deepEqual(compareCapabilityReplays(good, replayCapabilityDecisions(source, [], now)).changes, ["incomparable"]);
  assert.equal(replayCapabilityDecisions(source, "bad", now).code, "invalid-cases");
});

test("canonical snapshot rejects malformed rows as unavailable without accepting a valid prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inspection-rows-"));
  try {
    const path = join(dir, "canonical.json");
    const now = "2026-10-08T00:00:00Z";
    const input = { grantId: "g", target: "t", operation: "read", audience: "a", nonce: "n" };
    const grant = createCapabilityGrant({ id: "g", targetIdentity: "t", operations: ["read"], audience: "a",
      expiresAt: "2030-01-01Z", approval: { approvedBy: "o", approvedAt: "2026-01-01Z" }, revocationLink: "r" });
    const valid = { grant, revoked: false, useCount: 0, nonces: [] };
    const write = (rows: unknown[]) => {
      const content = JSON.stringify({ schema: "capability-inspection-source-v1", grants: rows });
      writeFileSync(path, content);
      return content;
    };
    write([valid]);
    assert.equal(inspectCapabilityDecision(loadCapabilityInspectionSource(path), input, now).verdict, "allow");
    const invalidRows = [
      null, [], {},
      { ...valid, grant: null },
      { ...valid, grant: { ...grant, id: "" } },
      { ...valid, grant: { ...grant, id: "other", expiresAt: "invalid" } },
      valid,
      { ...valid, grant: { ...grant, id: "other" }, revoked: "false" },
      { ...valid, grant: { ...grant, id: "other" }, useCount: 0.5 },
      { ...valid, grant: { ...grant, id: "other" }, useCount: -1 },
      { ...valid, grant: { ...grant, id: "other" }, nonces: [7] },
      { ...valid, grant: { ...grant, id: "other" }, nonces: Array(1001).fill("n") },
    ];
    for (const row of invalidRows) {
      const content = write([valid, row]);
      const source = loadCapabilityInspectionSource(path);
      assert.deepEqual(source, { unavailable: "malformed-source" });
      const inspected = inspectCapabilityDecision(source, input, now);
      assert.equal(inspected.verdict, "unavailable");
      assert.equal(inspected.code, "malformed-source");
      assert.ok(Object.values(inspected.predicates).every((value) => value === "not-checked"));
      const replay = replayCapabilityDecisions(source, [input, { ...input, grantId: "absent" }], now);
      assert.deepEqual(replay.results.map(({ verdict, code }) => ({ verdict, code })), [
        { verdict: "unavailable", code: "malformed-source" },
        { verdict: "unavailable", code: "malformed-source" },
      ]);
      assert.equal(readFileSync(path, "utf8"), content);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
