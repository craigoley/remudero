import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCanary, type CanaryExecutionPorts } from "../src/lib/model-canary-runner.js";
import { canarySuiteDigest, commonCanarySuite } from "../src/lib/model-canary-suite.js";
const cases = commonCanarySuite(), pin = { model: "model", route: "subscription", effort: "low", suiteHash: canarySuiteDigest(cases), billing: "subscription" as const };
const resources = { durationMs: 1, firstTextMs: null, generationMs: null, inputTokens: 1, outputTokens: 1,
  cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
  billing: "subscription" as const, servedModel: "model", terminal: "complete" as const };
test("canary runner gates every request and owns real scripted tool failures", async () => {
  const item = cases.find(c => c.tools === "retry")!; let calls = 0, admits = 0, saves = 0;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => { admits++; return { state: "admitted" }; },
    request: async input => { calls++; assert.ok(!input.prompt.includes('"value":23'));
      if (input.history.length < 2) return { text: "", toolCalls: [{ name: "lookup", args: {} }], resources };
      assert.deepEqual(input.history[0]!.toolResults[0]!.result, { error: "transient" });
      assert.deepEqual(input.history[1]!.toolResults[0]!.result, { value: 23 });
      return { text: JSON.stringify(item.expected), toolCalls: [], resources }; },
    save: async r => { saves++; assert.equal(r.verified, true); } };
  const result = await executeCanary(item, pin, ports); assert.equal(result.state, "scored");
  assert.equal(result.grade!.passed, true); assert.equal(calls, 3); assert.equal(admits, 3); assert.equal(saves, 1);
});
test("canary runner refuses capacity before transport and preserves an unmeasurable transport failure", async () => {
  let calls = 0, saves = 0;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => ({ state: "refused", reason: "capacity" }),
    request: async () => { calls++; throw new Error("transport"); }, save: async () => { saves++; } };
  const refused = await executeCanary(cases[0]!, pin, ports); assert.equal(refused.reason, "capacity"); assert.equal(calls, 0);
  ports.admit = async () => ({ state: "admitted" });
  const failed = await executeCanary(cases[0]!, pin, ports); assert.equal(failed.run.verified, null); assert.equal(failed.reason, "transport-error");
  assert.equal(failed.run.attempts.length, 1); assert.equal(failed.run.attempts[0]!.usageRatedUsd, null);
  assert.equal(saves, 1); assert.equal(calls, 1);
  await assert.rejects(() => executeCanary(cases[0]!, pin, ports, { maxCalls: 9, wallMs: 1, maxOutputBytes: 1 }), /bound-invalid/);
});
