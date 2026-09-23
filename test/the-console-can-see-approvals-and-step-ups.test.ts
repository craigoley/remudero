import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { projectConsoleStatusResponse } from "../src/lib/serve.js";

const NOW = Date.parse("2026-09-22T20:00:00.000Z");

test("W1-T4062: approvals are published and nothing else from config is", () => {
  const response = projectConsoleStatusResponse(
    { generated_at: "2026-09-22T20:00:00.000Z", counts: { total: 0 }, tasks: [] },
    [
      {
        model: "gpt-6-astra",
        approvedBy: "operator:craig",
        approvedAt: "2026-09-22T19:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    NOW,
  ) as Record<string, unknown>;

  assert.deepEqual(response.modelApprovals, [
    {
      model: "gpt-6-astra",
      approvedBy: "operator:craig",
      approvedAt: "2026-09-22T19:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      expired: false,
    },
  ]);
  assert.equal("root" in response, false, "the status projection does not leak another config.json field");
  assert.equal("claudeBin" in response, false, "credentials stay outside the browser-facing status response");
});

test("W1-T4062: an expired approval is marked expired", () => {
  const response = projectConsoleStatusResponse(
    { generated_at: "2026-09-22T20:00:00.000Z", counts: { total: 0 }, tasks: [] },
    [{ model: "claude-fable-5-1", approvedBy: "operator:craig", approvedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-22T19:59:59.000Z" }],
    NOW,
  ) as { modelApprovals: Array<{ expired: boolean }> };

  assert.equal(response.modelApprovals[0]?.expired, true);
});

test("W1-T4062: step-ups are counted by target model", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [
      { step: "implement.step_up", to: "opus" },
      { step: "implement.step_up", to: "opus" },
      { step: "fix.step_up", to: "gpt-5.6-sol" },
    ],
    "2026-09-22T20:00:00.000Z",
  );

  assert.equal(snapshot.routingTelemetry.stepUps.total, 3);
  assert.deepEqual(snapshot.routingTelemetry.stepUps.byTargetModel, [
    { model: "opus", count: 2 },
    { model: "gpt-5.6-sol", count: 1 },
  ]);
  assert.deepEqual(snapshot.routingTelemetry.stepUps.byStep, [
    { step: "fix.step_up", count: 1 },
    { step: "implement.step_up", count: 2 },
  ]);
});

test("W1-T4062: frontier preference outcomes are counted", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [
      {
        step: "worker.assignment",
        worker_assignment: {
          id: "assignment-kept",
          selected: { provider: "claude", model: "claude-sonnet-4" },
          routing: { capabilityPreference: { capability: "frontier", provider: "claude" } },
        },
      },
      {
        step: "worker.assignment",
        worker_assignment: {
          id: "assignment-bypassed",
          selected: { provider: "codex", model: "gpt-5.6-sol" },
          routing: {
            capabilityPreference: { capability: "frontier", provider: "claude" },
            preferenceBypass: { provider: "codex", reason: "claude-exhausted" },
          },
        },
      },
    ],
    "2026-09-22T20:00:00.000Z",
  );

  assert.deepEqual(snapshot.routingTelemetry.preferenceOutcomes, [
    {
      preferredProvider: "claude",
      selectedProvider: "claude",
      selectedModel: "claude-sonnet-4",
      outcome: "kept",
      count: 1,
    },
    {
      preferredProvider: "claude",
      selectedProvider: "codex",
      selectedModel: "gpt-5.6-sol",
      outcome: "bypassed",
      reason: "claude-exhausted",
      count: 1,
    },
  ]);
});
