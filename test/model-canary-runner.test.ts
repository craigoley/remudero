import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCanary, type CanaryExecutionPorts, type CanaryResponse } from "../src/lib/model-canary-runner.js";
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
  assert.equal(saves, 2); assert.equal(calls, 1);
  await assert.rejects(() => executeCanary(cases[0]!, pin, ports, { maxCalls: 9, wallMs: 1, maxOutputBytes: 1 }), /bound-invalid/);
});
test("canary runner enforces the real wall bound even if transport ignores its abort signal", async () => {
  let saves = 0;
  // A frozen clock keeps the pre-request clock checks from tripping "wall-bound" on a slow runner before
  // any attempt exists; only the real abort timer (the behaviour under test) can end this run.
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
    request: async () => new Promise(() => {}), save: async r => { saves++; assert.equal(r.attempts[0]!.terminal, "timeout"); } };
  const r = await executeCanary(cases[0]!, pin, ports, { maxCalls: 1, wallMs: 10, maxOutputBytes: 64 });
  assert.equal(r.reason, "transport-timeout"); assert.equal(r.run.verified, null); assert.equal(saves, 1);
  assert.equal(r.run.attempts[0]!.usageRatedUsd, null); assert.ok(r.run.totalDurationMs! >= 0);
  ports.request = async () => ({ text: JSON.stringify(cases[0]!.expected), toolCalls: [], resources });
  ports.save = async () => { saves++; throw new Error("durable-write-refused"); };
  await assert.rejects(() => executeCanary(cases[0]!, pin, ports), /durable-write-refused/);
  assert.equal(saves, 2);
});
test("canary runner observes missing duration and preserves bounded and incomplete responses", async () => {
  let saved = 0;
  const response: CanaryResponse = { text: JSON.stringify(cases[0]!.expected), toolCalls: [],
    resources: { ...resources, durationMs: null } };
  const ports: CanaryExecutionPorts = { monotonicMs: () => 5, admit: async () => ({ state: "admitted" }),
    request: async () => response, save: async () => { saved++; } };
  const complete = await executeCanary(cases[0]!, pin, ports);
  assert.equal(complete.run.verified, true); assert.equal(complete.run.attempts[0]!.durationMs, 0);
  const bounded = await executeCanary(cases[0]!, pin, ports, { maxCalls: 1, wallMs: 100, maxOutputBytes: 1 });
  assert.equal(bounded.reason, "output-bound"); assert.equal(bounded.run.verified, false);
  response.resources = { ...response.resources, terminal: "error" };
  const incomplete = await executeCanary(cases[0]!, pin, ports);
  assert.equal(incomplete.run.verified, null); assert.equal(incomplete.reason, "error"); assert.equal(saved, 3);
});
