import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCanaryRouterValue, type FrozenRouterOutcomeRowV1 } from "#src/lib/model-canary-router-value.js";

const digestA = "a".repeat(64), digestB = "b".repeat(64);
function row(split: "development" | "sealed-holdout", n: number, router: boolean, baselineA: boolean,
  baselineB: boolean, extra: Partial<FrozenRouterOutcomeRowV1> = {}): FrozenRouterOutcomeRowV1 {
  return { caseId: `${split}-case-${n}`, sourceFamilyId: `family-${split}-${n}`,
    incidentRootId: `root-${split}-${n}`, split, executionSource: "native-provider-execution",
    preOutcomeFeatureDigest: digestA, decisionId: `decision-${split}-${n}`, selectedConfigId: "router",
    decisionAt: "2026-10-01T00:00:00.000Z", outcomeAt: "2026-10-01T00:00:01.000Z",
    outcomes: { router, "static-a": baselineA, "static-b": baselineB }, ...extra };
}
const baselines = [
  { configId: "static-a", qualified: true, qualificationEvidenceDigest: digestA },
  { configId: "static-b", qualified: true, qualificationEvidenceDigest: digestB },
];

test("router attribution is withheld without native frozen-decision and baseline qualification receipts", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => row("development", i, false, i < 8, i < 5)),
    ...Array.from({ length: 10 }, (_, i) => row("sealed-holdout", i, i < 6, i < 5, i < 9)),
  ];
  const result = evaluateCanaryRouterValue({ rows, baselines, analysisSeed: "seed-1", minIndependentClusters: 5 });
  assert.equal(result.state, "unavailable");
  assert.equal(result.selection.reason, "native-router-case-and-decision-linkage-unavailable");
  assert.equal(result.evaluation.comparison, null);
  assert.equal(result.evaluation.routerCases, 0);
});

test("caller-supplied qualification, timestamps, split, family, and root cannot create router attribution", () => {
  const forged = row("sealed-holdout", 1, true, false, false, {
    decisionAt: "2026-10-01T00:00:02.000Z",
    sourceFamilyId: "forged-family", incidentRootId: "forged-root", split: "development",
  });
  const result = evaluateCanaryRouterValue({
    rows: [forged], baselines: [{ configId: "static-a", qualified: true, qualificationEvidenceDigest: digestA }],
    analysisSeed: "seed",
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.selection.reason, "native-router-case-and-decision-linkage-unavailable");
  assert.equal(result.selection.qualifiedCandidates, 0);
  assert.equal(result.evaluation.routerCases, 0);
});

test("router replay excludes synthetic rows and remains unavailable without native provenance", () => {
  const result = evaluateCanaryRouterValue({
    rows: [row("development", 0, true, true, false, { executionSource: "synthetic-control-replay" })],
    baselines, analysisSeed: "seed-1",
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.exclusions.syntheticRows, 1);
});
