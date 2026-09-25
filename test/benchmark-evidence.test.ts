import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveBenchmarkEvidence,
  unavailableBenchmarkEvidence,
  type BenchmarkAssignmentEvidence,
  type BenchmarkEvidenceInput,
  type BenchmarkTerminalEvidence,
} from "../src/lib/benchmark-evidence.js";

function evidence(
  assignments: Array<[string, BenchmarkAssignmentEvidence]>,
  terminals: Array<[string, BenchmarkTerminalEvidence]>,
  overrides: Partial<BenchmarkEvidenceInput> = {},
): BenchmarkEvidenceInput {
  return {
    assignments: new Map(assignments),
    joinedTerminals: new Map(terminals),
    unmatchedTerminals: new Map(),
    assignmentRowsSeen: assignments.length,
    terminalRowsSeen: terminals.length,
    invalidAssignmentRows: 0,
    terminalsWithoutAssignmentId: 0,
    duplicateAssignmentRows: 0,
    duplicateTerminalRows: 0,
    asOf: "2026-09-25T20:00:00.000Z",
    latestSourceAt: "2026-09-25T19:59:00.000Z",
    ...overrides,
  };
}

test("benchmark quality joins terminal evidence exactly once", () => {
  const result = deriveBenchmarkEvidence(evidence(
    [["assignment-private-1", { id: "assignment-private-1", provider: "codex", selectedModel: "model-a", requestedModel: "model-a", effort: "medium", taskClass: "src", risk: "low" }]],
    [["assignment-private-1", { success: true, servedModel: "model-a", tokensMeasured: true, durationMs: 100, costUsd: 0.01, billingMode: "api" }]],
    { assignmentRowsSeen: 2, terminalRowsSeen: 2, duplicateAssignmentRows: 1, duplicateTerminalRows: 1 },
  ));
  assert.equal(result.assignments, 1);
  assert.equal(result.joinedTerminalOutcomes, 1);
  assert.equal(result.outcomes.success, 1);
  assert.equal(result.duplicates.assignmentRows, 1);
  assert.equal(result.duplicates.terminalRows, 1);
  assert.equal(result.accounting.apiRequestCostUsd, 0.01);
});

test("benchmark quality preserves per-field missingness and unmatched rows", () => {
  const result = deriveBenchmarkEvidence(evidence(
    [
      ["a", { id: "a", provider: "codex", selectedModel: "model-a" }],
      ["b", { id: "b", provider: "claude", selectedModel: "model-b", effort: "medium" }],
    ],
    [["a", { success: false, servedModel: null }]],
    {
      unmatchedTerminals: new Map([["orphan", { success: true, costUsd: 3 }]]),
      terminalRowsSeen: 2,
      terminalsWithoutAssignmentId: 1,
    },
  ));
  assert.equal(result.assignmentsWithoutTerminal, 1);
  assert.equal(result.terminalsWithoutAssignment, 2);
  assert.deepEqual(result.coverage.servedModel, { denominator: 2, observed: 0, noTerminal: 1, notRecorded: 1 });
  assert.deepEqual(result.coverage.tokens, { denominator: 2, observed: 0, noTerminal: 1, notRecorded: 1 });
  assert.deepEqual(result.coverage.duration, { denominator: 2, observed: 0, noTerminal: 1, notRecorded: 1 });
  assert.deepEqual(result.coverage.cost, { denominator: 2, observed: 0, noTerminal: 1, notRecorded: 1 });
  assert.equal(result.outcomes.failure, 1);
  assert.equal(result.outcomes.success, 0, "unmatched success cannot become an assigned success");
  assert.equal(result.accounting.apiRequestCostUsd, 0, "unknown spend is not a measured free request");
});

test("benchmark quality separates accounting modes and redacts identifiers", () => {
  const result = deriveBenchmarkEvidence(evidence(
    [
      ["secret-run-api", { id: "secret-run-api", provider: "codex", selectedModel: "model-a", requestedModel: "model-a" }],
      ["secret-run-sub", { id: "secret-run-sub", provider: "claude", selectedModel: "model-b", requestedModel: "model-b" }],
      ["secret-run-unknown", { id: "secret-run-unknown", provider: "claude", selectedModel: "model-b" }],
    ],
    [
      ["secret-run-api", { success: true, billingMode: "api", costUsd: 1.25, servedModel: "model-a" }],
      ["secret-run-sub", { success: true, billingMode: "subscription", costUsd: 2.5, servedModel: "model-b" }],
      ["secret-run-unknown", { success: true, costUsd: 9 }],
    ],
  ));
  assert.equal(result.accounting.apiRequestCostUsd, 1.25);
  assert.equal(result.accounting.subscriptionNotionalCostUsd, 2.5);
  assert.equal(result.accounting.unclassifiedCostRows, 1);
  assert.equal(result.accounting.source, "worker-result-estimate-not-invoice");
  assert.equal(result.experimentalCrossover, "unavailable-no-random-allocation-receipt");
  assert.doesNotMatch(JSON.stringify(result), /secret-run|account_label|prompt|repo/);
  assert.equal(unavailableBenchmarkEvidence("checkpoint predates quality projection").state, "unavailable");
});
