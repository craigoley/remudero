import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeClusterPairedCanaries } from "#src/lib/model-canary-cluster-analysis.js";
import { compareCanaryToFieldTrials, type CanaryFieldComparisonIdentityV1 } from "#src/lib/model-canary-field-comparison.js";
import { buildExperimentProposal } from "#src/lib/model-canary-proposal-export.js";
import { evaluateCanaryRouterValue } from "#src/lib/model-canary-router-value.js";

const digest = "a".repeat(64);
const identity: CanaryFieldComparisonIdentityV1 = { provider: "codex", deployment: "prod", requestedModel: "router",
  model: "model-a", route: "subscription", effort: "medium", billing: "subscription",
  treatment: { scaffold: "s1", tools: "none", context: "standard", cache: "cold" },
  corpusDigest: digest, scorerDigest: digest, role: "worker",
  observationWindow: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" } };

test("whole clustered evaluation keeps evidence streams, denominators and proposal effects separate", () => {
  const pairs = Array.from({ length: 10 }, (_, i) => ({
    pairId: `pair-${i}`, comparisonId: "model-a-vs-model-b", endpoint: "verified-completion",
    estimand: "first-attempt" as const, split: "sealed-holdout" as const, caseId: `case-${i}`,
    sourceFamilyId: `family-${i}`, incidentRootId: `root-${i}`,
    executionSource: "native-provider-execution" as const, complete: true,
    leftValue: i < 6 ? 1 : 0, rightValue: i < 8 ? 1 : 0,
  }));
  const clustered = analyzeClusterPairedCanaries({ pairs, seed: "fixed",
    design: { comparisons: [{ id: "model-a-vs-model-b", endpoints: ["verified-completion"],
      estimands: ["first-attempt"] }], splits: ["sealed-holdout"] }, minIndependentClusters: 5 });
  assert.equal(clustered.comparisons[0]!.independentClusterCount, 10);
  assert.equal(clustered.comparisons[0]!.difference?.estimate, 0.2);

  const field = compareCanaryToFieldTrials({ benchmarkCases: Array.from({ length: 10 }, (_, i) => ({
    runId: `run-${i}`, caseId: `case-${i}`, sourceFamilyId: `family-${i}`, incidentRootId: `root-${i}`,
    split: "sealed-holdout" as const, executionSource: "native-provider-execution" as const, identity,
    outcomes: { "first-attempt": i < 8, "all-repeats": null, "best-of-k": null },
  })), fieldTrials: [{
    id: "observational-cohort", design: "observational", state: "observed", identity: { ...identity, route: "unknown" },
    assignedTasks: 20, observedTasks: 18, successfulTasks: 12,
    assignmentAudit: null, randomizationUnit: null, analysis: null, assignmentProbabilities: null,
  }] });
  assert.equal(field.comparisons.length, 0);
  assert.equal(field.unmatched[0]!.reason, "serving-identity-mismatch");
  assert.equal(field.denominators.benchmarkDistinctCases, 10);
  assert.equal(field.denominators.observationalAssignedTasks, 20);
  assert.equal(field.denominators.randomizedAssignedTasks, 0);

  const routerRows = [
    ...Array.from({ length: 10 }, (_, i) => ({ caseId: `dev-${i}`, sourceFamilyId: `df-${i}`, incidentRootId: `dr-${i}`,
      split: "development" as const, executionSource: "native-provider-execution" as const, preOutcomeFeatureDigest: digest,
      decisionId: `dd-${i}`, selectedConfigId: "router", decisionAt: "2026-10-01T00:00:00Z",
      outcomeAt: "2026-10-01T00:00:01Z", outcomes: { router: true, static: i < 7 } })),
    ...Array.from({ length: 10 }, (_, i) => ({ caseId: `hold-${i}`, sourceFamilyId: `hf-${i}`, incidentRootId: `hr-${i}`,
      split: "sealed-holdout" as const, executionSource: "native-provider-execution" as const, preOutcomeFeatureDigest: digest,
      decisionId: `hd-${i}`, selectedConfigId: "router", decisionAt: "2026-10-01T00:00:00Z",
      outcomeAt: "2026-10-01T00:00:01Z", outcomes: { router: i < 8, static: i < 6 } })),
  ];
  const router = evaluateCanaryRouterValue({ rows: routerRows,
    baselines: [{ configId: "static", qualified: true, qualificationEvidenceDigest: digest }],
    analysisSeed: "fixed", minIndependentClusters: 5 });
  assert.equal(router.state, "unavailable");
  assert.equal(router.selection.reason, "native-router-case-and-decision-linkage-unavailable");
  assert.equal(router.selection.configId, null);
  assert.equal(router.evaluation.optimisticOracleCases, 0);
  assert.equal(router.evaluation.oracleLabel, "optimistic-empirical-per-case-diagnostic");

  const proposal = buildExperimentProposal({ evidence: Array.from({ length: 3 }, (_, i) => ({
    signatureId: "tool-timeout", failureClass: "tool-use-failure" as const, caseId: `failed-${i}`,
    sourceFamilyId: `ff-${i}`, incidentRootId: `fr-${i}`, evidenceDigest: (i + 10).toString(16).padStart(64, "0"),
    executionSource: "native-provider-execution" as const, split: "development" as const,
  })) });
  assert.equal(proposal.proposals[0]!.outcome, "unmeasured");
  assert.deepEqual(proposal.effects, { measured: false, createsTasks: false, createsSchedules: false,
    writesLedger: false, writesRoutingPolicy: false, writesPromotionState: false });
});
