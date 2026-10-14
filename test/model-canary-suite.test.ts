import assert from "node:assert/strict";
import { test } from "node:test";
import { canarySuiteDigest, canaryTools, commonCanarySuite, gradeCanary, weeklyCanarySuite } from "../src/lib/model-canary-suite.js";

test("canary common cases refuse fabricated completion and grade actual failure recovery", () => {
  const suite = commonCanarySuite(); assert.equal(suite.length, 12);
  assert.equal(new Set(suite.map(c => c.id)).size, 12);
  assert.equal(canarySuiteDigest(suite), canarySuiteDigest(commonCanarySuite()));
  for (const item of suite) {
    const tools = canaryTools(item), trace = item.tools === "none" ? [] : item.tools === "inventory"
      ? [tools("inventory", { item: item.id.endsWith("A") ? "A" : "B" })]
      : item.tools === "retry" ? [tools("lookup", {}), tools("lookup", {})] : [tools("lookup", {})];
    assert.equal(gradeCanary(item, JSON.stringify(item.expected), trace).passed, true, item.id);
    assert.equal(gradeCanary(item, "Here's your answer: {}", trace).passed, false);
    assert.equal(gradeCanary(item, JSON.stringify({ ...item.expected, hallucinated: true }), trace).schemaValid, false);
    if (item.tools !== "none") assert.equal(gradeCanary(item, JSON.stringify(item.expected), []).passed, false);
  }
});

test("canary approval gate records unauthorized alternatives and never trusts a claimed trace", () => {
  const item = commonCanarySuite().find(c => c.tools === "approval")!, call = canaryTools(item);
  const first = call("lookup", {}), forbidden = call("lookup", {});
  assert.equal(first.denied, false); assert.equal(forbidden.denied, true);
  assert.equal(gradeCanary(item, JSON.stringify(item.expected), [first, forbidden]).passed, false);
  assert.equal(call("alternative", {}).denied, true);
  const inventory = commonCanarySuite().find(c => c.id === "tools-A")!;
  assert.equal(gradeCanary(inventory, JSON.stringify(inventory.expected), [canaryTools(inventory)("inventory", { item: "B" })]).passed, false);
  assert.equal(canaryTools(inventory)("inventory", { item: "A", extra: true }).denied, true);
});

test("canary weekly review includes a benign control and factual errors remain failures", () => {
  for (const item of weeklyCanarySuite()) {
    assert.equal(gradeCanary(item, JSON.stringify(item.expected), []).passed, true);
    assert.equal(gradeCanary(item, JSON.stringify({ finding: item.expected.finding === null ? "empty-input" : null }), []).passed, false);
  }
  const item = commonCanarySuite()[0]!;
  assert.equal(gradeCanary(item, '{"category":"deploy","ticket":99,"severity":"low"}', []).reason, "incorrect-output");
  assert.equal(gradeCanary(item, '{"category":"deploy","ticket":"17","severity":"low"}', []).reason, "invalid-schema");
});
