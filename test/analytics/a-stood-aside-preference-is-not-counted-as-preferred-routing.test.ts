import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAnalyticsSnapshot } from "#src/lib/analytics-route.js";

const NOW = "2026-11-22T20:00:00.000Z";

function assignment(id: string, provider: string, model: string, routing: Record<string, unknown>): Record<string, unknown> {
  return {
    step: "worker.assignment",
    run_id: "R1",
    worker_assignment: {
      id,
      selected: { provider, model },
      routing: { mode: "automatic", selectionPath: "headroom", ...routing },
    },
  };
}

const standAside = { capability: "balanced", provider: "codex", stoodAside: "expiring-budget" };

test("W1-T14373 criterion 1: a stood-aside preference is auction routing, not preferred-provider routing", () => {
  const stood = deriveAnalyticsSnapshot([assignment("a1", "claude", "claude-sonnet-4", { capabilityPreference: standAside })], NOW);
  const plain = deriveAnalyticsSnapshot([assignment("a1", "claude", "claude-sonnet-4", {})], NOW);

  assert.deepEqual(stood.routingTelemetry.preferenceOutcomes, [], "no preferredProvider outcome for a stood-aside row");
  assert.equal(stood.routingTelemetry.buckets.length, 1, "the row is still counted as an assignment");
  assert.equal(stood.routingTelemetry.buckets[0]?.assignments, 1);
  assert.deepEqual(stood.routingTelemetry, plain.routingTelemetry, "it reads exactly as an auction row with no preference");
});

test("W1-T14373 criterion 2: a preference that did not stand aside is counted as before", () => {
  const snapshot = deriveAnalyticsSnapshot(
    [
      assignment("kept", "codex", "gpt-5.6-sol", { capabilityPreference: { capability: "balanced", provider: "codex" } }),
      assignment("bypassed", "claude", "claude-sonnet-4", {
        capabilityPreference: { capability: "balanced", provider: "codex" },
        preferenceBypass: { provider: "claude", reason: "codex-exhausted" },
      }),
      assignment("role", "claude", "claude-sonnet-4", { rolePreference: { role: "review", provider: "claude" } }),
    ],
    NOW,
  );
  assert.deepEqual(snapshot.routingTelemetry.preferenceOutcomes, [
    { preferredProvider: "codex", selectedProvider: "claude", selectedModel: "claude-sonnet-4", outcome: "bypassed", reason: "codex-exhausted", count: 1 },
    { preferredProvider: "codex", selectedProvider: "codex", selectedModel: "gpt-5.6-sol", outcome: "kept", count: 1 },
  ]);
});

test("W1-T14373 criterion 3: a row with no stoodAside field reads as on origin/main", () => {
  const rows = [
    assignment("x1", "claude", "claude-sonnet-4", { capabilityPreference: { capability: "frontier", provider: "claude" } }),
    assignment("x2", "codex", "gpt-5.6-sol", {}),
    assignment("x3", "codex", "gpt-5.6-sol", { capabilityPreference: { capability: "frontier", provider: "claude", stoodAside: undefined } }),
  ];
  const snapshot = deriveAnalyticsSnapshot(rows, NOW);
  assert.deepEqual(snapshot.routingTelemetry.preferenceOutcomes, [
    { preferredProvider: "claude", selectedProvider: "claude", selectedModel: "claude-sonnet-4", outcome: "kept", count: 1 },
    { preferredProvider: "claude", selectedProvider: "codex", selectedModel: "gpt-5.6-sol", outcome: "kept", count: 1 },
  ]);
  assert.equal(snapshot.routingTelemetry.buckets.reduce((sum, bucket) => sum + bucket.assignments, 0), 3);
});
