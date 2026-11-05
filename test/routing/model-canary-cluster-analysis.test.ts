import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeClusterPairedCanaries, type ClusteredCanaryPairV1, type ClusterAnalysisDesignV1 } from "#src/lib/model-canary-cluster-analysis.js";

const design: ClusterAnalysisDesignV1 = {
  comparisons: [{ id: "model-a-vs-b", endpoints: ["correct"], estimands: ["all-repeats"] }],
  splits: ["sealed-holdout"],
};

function pair(index: number, overrides: Partial<ClusteredCanaryPairV1> = {}): ClusteredCanaryPairV1 {
  return {
    pairId: `pair-${index}`, comparisonId: "model-a-vs-b", endpoint: "correct", estimand: "all-repeats",
    split: "sealed-holdout", caseId: `case-${index}`, sourceFamilyId: `family-${index}`,
    incidentRootId: `root-${index}`, executionSource: "native-provider-execution", complete: true,
    leftValue: 0, rightValue: index, ...overrides,
  };
}

const run = (pairs: readonly ClusteredCanaryPairV1[], minIndependentClusters = 10) =>
  analyzeClusterPairedCanaries({ pairs, design, seed: "predeclared-seed-v1", resamples: 1000, minIndependentClusters });

test("cluster paired analysis keeps repeated attempts within independent task families", () => {
  const pairs = Array.from({ length: 10 }, (_, index) => pair(index));
  pairs.push(pair(0, { pairId: "pair-0-repeat", rightValue: 100 }));
  const result = run(pairs).comparisons[0]!;
  assert.equal(result.pairCount, 11);
  assert.equal(result.caseCount, 10);
  assert.equal(result.independentClusterCount, 10);
  assert.equal(result.difference?.estimate, 9.5);
  assert.equal(result.unit, "independent-family-root-component");
});

test("cluster paired analysis joins families that share incident roots before resampling", () => {
  const pairs = Array.from({ length: 10 }, (_, index) => pair(index));
  pairs[0] = pair(0, { sourceFamilyId: "family-a", incidentRootId: "root-a" });
  pairs[1] = pair(1, { sourceFamilyId: "family-b", incidentRootId: "root-a" });
  pairs[2] = pair(2, { sourceFamilyId: "family-b", incidentRootId: "root-b" });
  const result = run(pairs, 8).comparisons[0]!;
  assert.equal(result.independentClusterCount, 8);
  assert.equal(result.state, "estimated");
});

test("cluster paired analysis withholds uncertainty for incomplete or undersized evidence", () => {
  const undersized = run(Array.from({ length: 9 }, (_, index) => pair(index))).comparisons[0]!;
  assert.equal(undersized.state, "withheld");
  assert.equal(undersized.reason, "insufficient-independent-clusters");
  assert.equal(undersized.difference, null);

  const incomplete = run([...Array.from({ length: 10 }, (_, index) => pair(index)),
    pair(10, { complete: false, rightValue: null })]).comparisons[0]!;
  assert.equal(incomplete.state, "withheld");
  assert.equal(incomplete.reason, "incomplete-or-missing-paired-outcome");
  assert.equal(incomplete.difference, null);
});

test("cluster bootstrap is deterministic across evidence ordering and excludes synthetic replay", () => {
  const pairs = Array.from({ length: 12 }, (_, index) => pair(index));
  assert.deepEqual(run(pairs), run([...pairs].reverse()));
  const replay = run([pair(0, { executionSource: "synthetic-control-replay" })]);
  assert.equal(replay.comparisons[0]!.state, "withheld");
  assert.equal(replay.comparisons[0]!.reason, "no-observed-native-pairs");
  assert.equal(replay.exclusions.syntheticControlPairs, 1);
});

test("cluster paired analysis rejects family provenance that crosses sealed and development splits", () => {
  const leaked = [pair(0), pair(1, { split: "development", sourceFamilyId: "family-0" })];
  const result = analyzeClusterPairedCanaries({ pairs: leaked, design: {
    comparisons: [{ id: "model-a-vs-b", endpoints: ["correct"], estimands: ["all-repeats"] }],
    splits: ["sealed-holdout", "development"],
  }, seed: "predeclared-seed-v1" }).comparisons;
  assert.ok(result.every(item => item.state === "withheld" && item.reason === "source-family-cross-split"));
});

test("cluster paired analysis keeps first-attempt all-repeat and best-of-k estimands separate", () => {
  const estimands = ["first-attempt", "all-repeats", "best-of-k"] as const;
  const comparisons = estimands.flatMap(estimand => Array.from({ length: 10 }, (_, index) =>
    pair(index, { pairId: `${estimand}-${index}`, estimand, rightValue: estimands.indexOf(estimand) + 1 })));
  const result = analyzeClusterPairedCanaries({ pairs: comparisons, seed: "predeclared-seed-v1", resamples: 500,
    design: { comparisons: [{ id: "model-a-vs-b", endpoints: ["correct"], estimands }], splits: ["sealed-holdout"] } });
  assert.deepEqual(result.comparisons.map(item => [item.estimand, item.difference?.estimate]),
    [["all-repeats", 2], ["best-of-k", 3], ["first-attempt", 1]]);
});
