import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRoutingExperiment,
  experimentTaskIdentity,
  ROUTING_EXPERIMENTS,
  routingExperimentFor,
} from "../src/lib/routing-experiments.js";
import { auctionDrawSeed, workerSelectionAssignment, type SpawnWorkerArgs } from "../src/lib/worker.js";
import type { ProviderCapacity } from "../src/lib/worker-provider.js";

const old = ROUTING_EXPERIMENTS.find((item) => item.id === "sol-vs-sonnet")!;
const next = ROUTING_EXPERIMENTS.find((item) => item.id === "sol-vs-sonnet55")!;
const candidate = (claudeModel: string) => [
  { provider: "claude" as const, model: claudeModel, eligible: true },
  { provider: "codex" as const, model: "gpt-6-sol", eligible: true },
];
const capacity = (provider: "claude" | "codex", model: string): ProviderCapacity => ({
  provider, model, readable: true, windows: [{ name: "weekly", usedPercent: 40 }],
});

test("the Sonnet 5.5 switch starts a separate concrete-model experiment epoch", () => {
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: candidate("claude-sonnet-5") }), old.id);
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: candidate("claude-sonnet-5-5") }), next.id);
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: candidate("sonnet") }), undefined);
  assert.equal(next.startedOn, "2026-09-29");
});

test("generic lane labels cannot share one task-randomization seed", () => {
  assert.equal(experimentTaskIdentity("unfiled"), undefined);
  assert.equal(experimentTaskIdentity("TRIAGE"), undefined);
  assert.equal(experimentTaskIdentity("PR-7890"), "PR-7890");
  const capacities = [capacity("claude", "claude-sonnet-5-5"), capacity("codex", "gpt-6-sol")];
  const policy = { preference: "automatic" as const, reservePercent: 5, provenance: "default" as const };
  const args = { cwd: "/w", prompt: "fix", taskId: "unfiled", runId: "unfiled-1", model: "sonnet", effort: "high" } as SpawnWorkerArgs;
  assert.equal(auctionDrawSeed(args, policy, capacities, "balanced").unit, "spawn");
  const row = workerSelectionAssignment(args, {
    provider: "claude", model: "claude-sonnet-5-5", effort: "high", capacity: capacities[0], capacities,
    mode: "multi-provider", selectionPath: "auction", policy, capability: "balanced",
  });
  assert.equal(row.routing.decision?.ab, undefined);
  assert.equal(row.routing.experiment, undefined);
  const filed = { ...args, taskId: "W1-T4799" };
  assert.equal(auctionDrawSeed(filed, policy, capacities, "balanced").unit, "task");
  assert.equal(workerSelectionAssignment(filed, {
    provider: "claude", model: "claude-sonnet-5-5", effort: "high", capacity: capacities[0], capacities,
    mode: "multi-provider", selectionPath: "auction", policy, capability: "balanced",
  }).routing.decision?.ab, next.id);
});

test("a changed treatment and a generic unit are excluded while the terminal attempt supplies cost", () => {
  const assignment = (id: string, task: string, model: string, experimentId: string) => ({
    ts: "2026-09-29T14:20:00Z", task_id: task, step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "claude", model }, routing: {
      decision: { ab: experimentId, considered: candidate(model) },
      experiment: { assignedArm: "sonnet", servedArm: "sonnet", crossover: false },
    } },
  });
  const rows = [
    assignment("a1", "W1-T4799", "claude-sonnet-5-5", old.id),
    assignment("a2", "unfiled", "claude-sonnet-5", old.id),
    { ...assignment("a5", "W1-T4802", "claude-sonnet-5", old.id),
      worker_assignment: { id: "a5", selected: { provider: "claude", model: "claude-sonnet-5" },
        routing: { decision: { ab: old.id }, experiment: { assignedArm: "sonnet" } } } },
    assignment("a3", "W1-T4800", "claude-sonnet-5", old.id),
    { ts: "2026-09-29T14:21:00Z", step: "worker.activity", selection_assignment_id: "a3" },
    { ts: "2026-09-29T14:22:00Z", step: "worker.attempt", selection_assignment_id: "a3",
      worker_duration_ms: 120_000, tokens: { input: 100, output: 20 }, total_cost_usd: 0.25, billing_mode: "subscription" },
  ];
  const report = evaluateRoutingExperiment(rows, old, "2026-09-29");
  assert.deepEqual(report.excludedAssignments, { genericUnit: 1, changedTreatment: 1, unverifiedTreatment: 1 });
  assert.equal(report.assignments, 1);
  assert.equal(report.arms[0]?.tasks, 1);
  assert.equal(report.arms[0]?.medianWorkerMinutes, 2);
  assert.equal(report.arms[0]?.meanTokens, 120);
  assert.equal(report.arms[0]?.meanNotionalCostUsd, 0.25);
  assert.equal(report.arms[0]?.meanCashCostUsd, null);
  assert.equal(report.arms[0]?.costMissingAssignments, 0);
  const cash = evaluateRoutingExperiment([...rows, assignment("a4", "W1-T4801", "claude-sonnet-5", old.id),
    { ts: "2026-09-29T14:23:00Z", step: "worker.attempt", selection_assignment_id: "a4",
      total_cost_usd: 0.1, billing_mode: "api" }], old, "2026-09-29");
  assert.equal(cash.arms[0]?.meanCashCostUsd, 0.1);
  assert.equal(cash.arms[0]?.meanNotionalCostUsd, 0.25);
});
