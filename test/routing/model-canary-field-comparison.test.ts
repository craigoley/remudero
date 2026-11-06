import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCanaryToFieldTrials, type CanaryFieldComparisonIdentityV1,
  type CanaryBenchmarkCaseV1, type FieldTrialComparisonCohortV1 } from "#src/lib/model-canary-field-comparison.js";

const identity: CanaryFieldComparisonIdentityV1 = {
  provider: "codex", deployment: "deployment-a", requestedModel: "router-default", model: "model-a",
  route: "subscription", effort: "medium", billing: "subscription",
  treatment: { scaffold: "scaffold-a", tools: "none", context: "standard", cache: "cold" },
  corpusDigest: "a".repeat(64), scorerDigest: "b".repeat(64), role: "worker",
  observationWindow: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" },
};

function benchmark(runId: string, caseId: string, overrides: Partial<CanaryBenchmarkCaseV1> = {}): CanaryBenchmarkCaseV1 {
  return { runId, caseId, sourceFamilyId: `family-${caseId}`, incidentRootId: `root-${caseId}`,
    split: "sealed-holdout", executionSource: "native-provider-execution", identity,
    outcomes: { "first-attempt": true, "all-repeats": true, "best-of-k": true }, ...overrides };
}

function field(overrides: Partial<FieldTrialComparisonCohortV1> = {}): FieldTrialComparisonCohortV1 {
  return { id: "private-cohort-1", design: "observational", state: "observed", identity,
    assignedTasks: 20, observedTasks: 18, successfulTasks: 12,
    assignmentAudit: null, randomizationUnit: null, analysis: null, assignmentProbabilities: null, ...overrides };
}

test("private field comparison separates benchmark and field trial denominators", () => {
  const result = compareCanaryToFieldTrials({ benchmarkCases: [
    benchmark("run-1", "case-1"), benchmark("run-2", "case-1", { outcomes: {
      "first-attempt": false, "all-repeats": true, "best-of-k": true,
    } }), benchmark("run-3", "case-2", { outcomes: {
      "first-attempt": true, "all-repeats": false, "best-of-k": false,
    } }),
    benchmark("synthetic", "synthetic-case", { executionSource: "synthetic-control-replay" }),
  ], fieldTrials: [field()] });
  assert.equal(result.state, "available");
  assert.equal(result.exclusions.syntheticControlRuns, 1);
  assert.equal(result.comparisons.length, 1);
  const comparison = result.comparisons[0]!;
  assert.equal(comparison.benchmark.denominator.unit, "distinct-cases");
  assert.equal(comparison.benchmark.denominator.count, 2);
  assert.equal(comparison.fieldTrial.denominator.unit, "assigned-tasks");
  assert.equal(comparison.fieldTrial.denominator.assigned, 20);
  assert.equal(comparison.fieldTrial.denominator.observed, 18);
  assert.equal(comparison.fieldTrial.denominator.successful, 12);
  assert.equal("combinedDenominator" in comparison, false);
  assert.equal(comparison.fieldTrial.design, "observational");
  assert.equal(comparison.fieldTrial.inference, "descriptive-only");
});

test("field comparison withholds attribution for mismatched serving identity or scaffold", () => {
  const result = compareCanaryToFieldTrials({ benchmarkCases: [benchmark("run-1", "case-1")],
    fieldTrials: [field({ identity: { ...identity, treatment: { scaffold: "other-scaffold", tools: "none", context: "standard", cache: "cold" } } })] });
  assert.equal(result.comparisons.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0]!.reason, "serving-identity-mismatch");
});

test("field comparison identifies incomplete serving identity when its window is verified", () => {
  const result = compareCanaryToFieldTrials({ benchmarkCases: [benchmark("run-1", "case-1")],
    fieldTrials: [field({ identity: { ...identity, route: null } })] });
  assert.equal(result.comparisons.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0]!.reason, "serving-identity-incomplete");
});

test("field comparison preserves observational and randomized design provenance", () => {
  const randomized = field({ id: "registered-epoch-1", design: "registered-randomized", assignmentAudit: "pass",
    randomizationUnit: "task", analysis: "intention-to-treat",
    assignmentProbabilities: { "model-a": 0.5, "model-b": 0.5 } });
  const result = compareCanaryToFieldTrials({ benchmarkCases: [benchmark("run-1", "case-1")],
    fieldTrials: [field(), randomized] });
  assert.equal(result.comparisons.length, 2);
  const obs = result.comparisons.find(item => item.fieldTrial.design === "observational")!;
  const controlled = result.comparisons.find(item => item.fieldTrial.design === "registered-randomized")!;
  assert.equal(obs.fieldTrial.inference, "descriptive-only");
  assert.equal(controlled.fieldTrial.inference, "randomized-itt-separate");
  assert.equal(controlled.fieldTrial.randomizationUnit, "task");
  assert.equal(controlled.fieldTrial.assignmentAudit, "pass");
  assert.deepEqual(controlled.fieldTrial.assignmentProbabilities, { "model-a": 0.5, "model-b": 0.5 });
  assert.equal(controlled.fieldTrial.denominator.assigned, 20);
});

test("field comparison refuses randomized outcomes without a passing audit and normalized probabilities", () => {
  const result = compareCanaryToFieldTrials({ benchmarkCases: [benchmark("run-1", "case-1")],
    fieldTrials: [field({ design: "registered-randomized", assignmentAudit: "unavailable", randomizationUnit: "task",
      analysis: "intention-to-treat", assignmentProbabilities: { "model-a": 0.7, "model-b": 0.7 } })] });
  assert.equal(result.comparisons.length, 0);
  assert.equal(result.unmatched[0]!.reason, "randomization-provenance-unavailable");
  assert.equal(result.unmatched[0]!.design, "registered-randomized");
  assert.equal(result.unmatched[0]!.inference, "randomized-itt-separate");
  assert.equal(result.unmatched[0]!.assignmentAudit, "unavailable");
  assert.deepEqual(result.unmatched[0]!.assignmentProbabilities, { "model-a": 0.7, "model-b": 0.7 });
});

test("field comparison keeps repeated benchmark runs within one distinct case denominator", () => {
  const result = compareCanaryToFieldTrials({ benchmarkCases: [benchmark("run-1", "same-case"),
    benchmark("run-2", "same-case", { outcomes: { "first-attempt": false, "all-repeats": false, "best-of-k": true } })],
    fieldTrials: [field()] });
  assert.equal(result.comparisons[0]!.benchmark.denominator.count, 1);
  assert.equal(result.comparisons[0]!.benchmark.outcomes["all-repeats"].caseMean, 0.5);
});

test("field comparison withholds a caller window when benchmark execution time is unverified", () => {
  const result = compareCanaryToFieldTrials({ benchmarkCases: [
    benchmark("run-legacy", "case-legacy", { identity: { ...identity, observationWindow: null } }),
  ], fieldTrials: [field()] });
  assert.equal(result.comparisons.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0]!.reason, "observation-window-unverified");
});
