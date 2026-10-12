import assert from "node:assert/strict";
import { test } from "node:test";
import { retentionCanaryProtocol, executeRetentionCanary } from "../src/lib/model-canary-retention.js";
import { projectCanaryRuns } from "../src/lib/model-canary-metrics.js";
import type { CanaryExecutionPorts } from "../src/lib/model-canary-runner.js";

test("canary retention replays native roles at 25 and 50 turns and grades the whole conversation", async () => {
  for (const turns of [25, 50] as const) {
    const protocol = retentionCanaryProtocol(turns), pin = { model: "model", route: "subscription", effort: "low",
      billing: "subscription" as const, suiteHash: protocol.suiteHash }; let calls = 0, saved = 0;
    const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
      save: async () => { saved++; }, request: async input => {
        calls++; assert.equal(input.conversation!.length, 2 * calls); assert.equal(input.conversation![0]!.role, "system");
        const expected = protocol.cases[calls - 1]!.expected;
        const answer = calls === 25 ? { ...expected, key: "maple" } : expected;
        return { text: JSON.stringify(answer), toolCalls: [], resources: { durationMs: 1, firstTextMs: null, generationMs: null,
          inputTokens: 10, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
          usageRatedUsd: null, billing: "subscription", servedModel: "model", terminal: "complete" } };
      } };
    const result = await executeRetentionCanary(protocol, pin, ports);
    assert.equal(result.turnsObserved, turns); assert.equal(result.firstViolationTurn, 25); assert.equal(result.violations, 1);
    assert.equal(saved, 1); assert.equal(result.run.verified, false);
    const metrics = projectCanaryRuns([result.run]).groups[0]!; assert.equal(metrics.tasks, 1); assert.equal(metrics.attempts, turns);
    assert.equal(result.sampleUnit, "whole-conversation");
    await assert.rejects(() => executeRetentionCanary({ ...protocol, instruction: "changed" }, pin, ports), /protocol-invalid/);
  }
});
test("canary retention refuses fabricated success after a mid-conversation transport failure", async () => {
  const protocol = retentionCanaryProtocol(25), pin = { model: "model", route: "subscription", effort: "low",
    billing: "subscription" as const, suiteHash: protocol.suiteHash }; let calls = 0;
  const result = await executeRetentionCanary(protocol, pin, { monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
    save: async () => {}, request: async () => { calls++; throw new Error("failed"); } });
  assert.equal(calls, 1); assert.equal(result.run.verified, null); assert.equal(result.turnsObserved, 0);
  assert.equal(result.run.attempts[0]!.usageRatedUsd, null);
});
