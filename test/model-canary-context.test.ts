import assert from "node:assert/strict";
import { test } from "node:test";
import { contextCanaryProtocol, executeContextCanary } from "#src/lib/model-canary-context.js";
import { projectCanaryRuns } from "#src/lib/model-canary-metrics.js";
import type { CanaryExecutionPorts, CanaryResponse } from "#src/lib/model-canary-runner.js";

const namespace = "a".repeat(64);
const protocol = () => contextCanaryProtocol(2048, "repeat", namespace);
const pin = () => ({ model: "synthetic", route: "fixture", effort: "medium", billing: "subscription" as const,
  suiteHash: protocol().suiteHash });
function fixture() {
  let clock = 0, requests = 0, admissions = 0, saves = 0;
  const prompts: string[] = [];
  const response: CanaryResponse = { text: '{"answer":23,"sources":["D1"]}', toolCalls: [], resources: {
    durationMs: 10, firstTextMs: 2, generationMs: 4, inputTokens: 500, outputTokens: 12,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
    billing: "subscription", servedModel: "synthetic", terminal: "complete" } };
  const ports: CanaryExecutionPorts = { monotonicMs: () => clock,
    admit: async () => { admissions++; return { state: "admitted" }; },
    request: async input => { requests++; prompts.push(input.prompt); clock += 10; return structuredClone(response); },
    save: async () => { saves++; } };
  return { ports, response, prompts, counts: () => ({ requests, admissions, saves }), setClock: (n: number) => { clock = n; } };
}

test("context profiles bind exact synthetic byte sizes and identical repetition without claiming tokens", () => {
  for (const bytes of [2048, 16384, 65536] as const) {
    const p = contextCanaryProtocol(bytes, "repeat", namespace);
    const document = p.cases[0]!.prompt.split("\n").slice(1).join("\n").split("\nQuestion:")[0]!;
    assert.equal(Buffer.byteLength(document), bytes);
    assert.equal(p.cases[0]!.prompt, p.cases[1]!.prompt);
    assert.equal(p.cacheGuarantee, "none");
    assert.equal(p.byteUnit, "utf8-bytes");
    assert.notEqual(p.suiteHash, contextCanaryProtocol(bytes, "first-use", namespace).suiteHash);
    assert.notEqual(p.suiteHash, contextCanaryProtocol(bytes, "repeat", "b".repeat(64)).suiteHash);
  }
});

test("context profiles refuse changed protocol and unsupported workload before admission", async () => {
  for (const args of [[1024, "repeat", namespace], [2048, "warm", namespace], [2048, "repeat", "bad"]])
    assert.throws(() => contextCanaryProtocol(...args as Parameters<typeof contextCanaryProtocol>), /profile-invalid/);
  const f = fixture(), p = protocol(); p.cases[0]!.prompt += "changed";
  await assert.rejects(executeContextCanary(p, pin(), f.ports), /protocol-invalid/);
  await assert.rejects(executeContextCanary(protocol(), { ...pin(), suiteHash: "b".repeat(64) }, f.ports), /protocol-invalid/);
  for (const limit of [0, NaN, 120001]) await assert.rejects(executeContextCanary(protocol(), pin(), f.ports, limit), /protocol-invalid/);
  assert.deepEqual(f.counts(), { requests: 0, admissions: 0, saves: 0 });
});

test("repeat profile owns primer and probe usage in one durable task and preserves unknown cache evidence", async () => {
  const f = fixture(), result = await executeContextCanary(protocol(), pin(), f.ports);
  assert.deepEqual(f.counts(), { requests: 2, admissions: 2, saves: 1 });
  assert.equal(result.run.verified, true);
  assert.equal(result.run.attempts.length, 2);
  assert.deepEqual(result.phases.map(p => p.phase), ["primer", "probe"]);
  assert.equal(result.probeCache, "unavailable");
  assert.equal(result.sampleUnit, "whole-profile");
  assert.equal(result.run.contextProfile!.phases.length, 2);
  assert.equal(projectCanaryRuns([result.run]).uniqueRuns, 1);
  assert.equal(f.prompts[0], f.prompts[1]);
});

test("cache read treatment is scored from observed probe counters rather than repeat labels", async () => {
  for (const [counter, state] of [[0, "observed-zero"], [100, "observed-read"], [-1, "unavailable"]] as const) {
    const f = fixture(); f.response.resources.cacheReadTokens = counter;
    const result = await executeContextCanary(protocol(), pin(), f.ports);
    assert.equal(result.probeCache, state);
  }
});

test("first-use context profile admits one call and only names a requested first use", async () => {
  const f = fixture(), p = contextCanaryProtocol(16384, "first-use", namespace);
  f.response.resources.cacheReadTokens = 32;
  const result = await executeContextCanary(p, { ...pin(), suiteHash: p.suiteHash }, f.ports);
  assert.deepEqual(f.counts(), { requests: 1, admissions: 1, saves: 1 });
  assert.equal(result.probeCache, "observed-read");
  assert.equal(result.cacheGuarantee, "none");
});

test("refused or interrupted primers do not replay uncertain work or manufacture a probe", async () => {
  const refused = fixture(); refused.ports.admit = async () => ({ state: "refused", reason: "busy" });
  const a = await executeContextCanary(protocol(), pin(), refused.ports);
  assert.equal(a.run.verified, null); assert.equal(a.run.attempts.length, 0); assert.equal(a.probeCache, "unavailable");
  const failed = fixture(); failed.response.resources.terminal = "error";
  const b = await executeContextCanary(protocol(), pin(), failed.ports);
  assert.equal(b.run.verified, null); assert.equal(b.run.attempts.length, 1); assert.equal(b.phases.length, 1);
  assert.equal(b.run.attempts[0]!.inputTokens, 500);
});

test("incorrect primers remain a failed whole task even if the later probe is correct", async () => {
  const f = fixture(), request = f.ports.request; let calls = 0;
  f.ports.request = async input => { const r = await request(input); if (++calls === 1) r.text = '{}'; return r; };
  const result = await executeContextCanary(protocol(), pin(), f.ports);
  assert.equal(result.run.verified, false); assert.equal(result.phases[1]!.verified, true);
  assert.equal(result.run.outcomeReason, "context-profile-incorrect");
});

test("shared context wall bound and durable save errors preserve uncertainty", async () => {
  const f = fixture(); let clocks = 0;
  f.ports.monotonicMs = () => ++clocks === 1 ? 0 : 120001;
  const result = await executeContextCanary(protocol(), pin(), f.ports);
  assert.equal(result.run.verified, null); assert.equal(f.counts().requests, 0);
  const corruptClock = fixture(); corruptClock.ports.monotonicMs = () => NaN;
  const unknown = await executeContextCanary(protocol(), pin(), corruptClock.ports);
  assert.equal(unknown.run.totalDurationMs, null);
  const save = fixture(); save.ports.save = async () => { throw new Error("durable-save-failed"); };
  await assert.rejects(executeContextCanary(protocol(), pin(), save.ports), /durable-save-failed/);
});
