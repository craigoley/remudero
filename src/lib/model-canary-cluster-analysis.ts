/** Private cluster bootstrap for predeclared paired canary comparisons. */
import { createHash } from "node:crypto";

export type CanaryAnalysisEstimandV1 = "first-attempt" | "all-repeats" | "best-of-k";
export type CanaryAnalysisSplitV1 = "development" | "sealed-holdout";
export type CanaryAnalysisExecutionSourceV1 = "native-provider-execution" | "synthetic-control-replay";

export interface ClusterAnalysisDesignV1 {
  comparisons: readonly { id: string; endpoints: readonly string[]; estimands: readonly CanaryAnalysisEstimandV1[] }[];
  splits: readonly CanaryAnalysisSplitV1[];
}

export interface ClusteredCanaryPairV1 {
  pairId: string;
  comparisonId: string;
  endpoint: string;
  estimand: CanaryAnalysisEstimandV1;
  split: CanaryAnalysisSplitV1;
  caseId: string;
  sourceFamilyId: string;
  incidentRootId: string;
  executionSource: CanaryAnalysisExecutionSourceV1;
  complete: boolean;
  leftValue: number | null;
  rightValue: number | null;
}

export interface ClusteredCanaryAnalysisInputV1 {
  pairs: readonly ClusteredCanaryPairV1[];
  design: ClusterAnalysisDesignV1;
  /** Fixed before outcomes are read; never generated from observed results. */
  seed: string;
  resamples?: number;
  minIndependentClusters?: number;
}

export interface ClusteredCanaryComparisonV1 {
  comparisonId: string;
  endpoint: string;
  estimand: CanaryAnalysisEstimandV1;
  split: CanaryAnalysisSplitV1;
  state: "estimated" | "withheld";
  reason: string | null;
  pairCount: number;
  caseCount: number;
  independentClusterCount: number;
  unit: "independent-family-root-component";
  difference: { estimate: number; lower95: number; upper95: number } | null;
}

export interface ClusteredCanaryAnalysisV1 {
  version: "model-canary-cluster-analysis-v1";
  private: true;
  state: "available" | "unavailable";
  inference: "cluster-bootstrap-95" | "withheld";
  differenceDirection: "right-minus-left";
  seed: string;
  resamples: number;
  minIndependentClusters: number;
  exclusions: { syntheticControlPairs: number };
  comparisons: ClusteredCanaryComparisonV1[];
}

const MAX_PAIRS = 100_000;
const MAX_COMPARISONS = 32;
const MAX_ENDPOINTS = 16;
const MAX_GROUPS = 512;
const MAX_RESAMPLES = 10_000;
const MAX_MIN_CLUSTERS = 1_000;
const MAX_TOTAL_BOOTSTRAP_WORK = 10_000_000;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const estimands: readonly CanaryAnalysisEstimandV1[] = ["first-attempt", "all-repeats", "best-of-k"];
const splits: readonly CanaryAnalysisSplitV1[] = ["development", "sealed-holdout"];
const executionSources: readonly CanaryAnalysisExecutionSourceV1[] = ["native-provider-execution", "synthetic-control-replay"];
const clusterAnalysisRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const clusterAnalysisText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const clusterAnalysisCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const clusterAnalysisFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_VALUE;
const clusterAnalysisExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

interface DeclaredComparison { endpoints: Set<string>; estimands: Set<CanaryAnalysisEstimandV1> }

function validateClusterAnalysisDesign(design: ClusterAnalysisDesignV1): Map<string, DeclaredComparison> {
  if (!clusterAnalysisRecord(design) || !clusterAnalysisExactKeys(design, ["comparisons", "splits"])
    || !Array.isArray(design.comparisons) || design.comparisons.length < 1
    || design.comparisons.length > MAX_COMPARISONS || !Array.isArray(design.splits)
    || design.splits.length < 1 || design.splits.length > splits.length
    || design.splits.some(split => !splits.includes(split)) || new Set(design.splits).size !== design.splits.length)
    throw new Error("canary-cluster-design-invalid");
  const declared = new Map<string, DeclaredComparison>();
  let groups = 0;
  for (const item of design.comparisons) {
    if (!clusterAnalysisRecord(item) || !clusterAnalysisExactKeys(item, ["id", "endpoints", "estimands"])
      || !clusterAnalysisText(item.id, 128) || !Array.isArray(item.endpoints) || item.endpoints.length < 1
      || item.endpoints.length > MAX_ENDPOINTS || item.endpoints.some(endpoint => !clusterAnalysisText(endpoint, 64))
      || new Set(item.endpoints).size !== item.endpoints.length || !Array.isArray(item.estimands)
      || item.estimands.length < 1 || item.estimands.some(estimand => !estimands.includes(estimand))
      || new Set(item.estimands).size !== item.estimands.length || declared.has(item.id))
      throw new Error("canary-cluster-design-invalid");
    declared.set(item.id, { endpoints: new Set(item.endpoints), estimands: new Set(item.estimands) });
    groups += item.endpoints.length * item.estimands.length * design.splits.length;
  }
  if (groups > MAX_GROUPS) throw new Error("canary-cluster-design-bound");
  return declared;
}

function validateClusterAnalysisPair(value: unknown, declared: Map<string, DeclaredComparison>, allowedSplits: readonly CanaryAnalysisSplitV1[]): ClusteredCanaryPairV1 {
  const keys = ["pairId", "comparisonId", "endpoint", "estimand", "split", "caseId", "sourceFamilyId", "incidentRootId",
    "executionSource", "complete", "leftValue", "rightValue"];
  if (!clusterAnalysisRecord(value) || !clusterAnalysisExactKeys(value, keys) || !clusterAnalysisText(value.pairId, 128)
    || !clusterAnalysisText(value.comparisonId, 128) || !declared.has(value.comparisonId)
    || !clusterAnalysisText(value.endpoint, 64) || !declared.get(value.comparisonId)!.endpoints.has(value.endpoint)
    || !estimands.includes(value.estimand as CanaryAnalysisEstimandV1)
    || !declared.get(value.comparisonId)!.estimands.has(value.estimand as CanaryAnalysisEstimandV1)
    || !splits.includes(value.split as CanaryAnalysisSplitV1) || !allowedSplits.includes(value.split as CanaryAnalysisSplitV1)
    || !clusterAnalysisText(value.caseId, 160) || !clusterAnalysisText(value.sourceFamilyId, 160) || !clusterAnalysisText(value.incidentRootId, 160)
    || !executionSources.includes(value.executionSource as CanaryAnalysisExecutionSourceV1)
    || typeof value.complete !== "boolean"
    || !(value.leftValue === null || clusterAnalysisFinite(value.leftValue)) || !(value.rightValue === null || clusterAnalysisFinite(value.rightValue)))
    throw new Error("canary-cluster-pair-invalid");
  return value as unknown as ClusteredCanaryPairV1;
}

interface PairGroup {
  comparisonId: string;
  endpoint: string;
  estimand: CanaryAnalysisEstimandV1;
  split: CanaryAnalysisSplitV1;
  rows: ClusteredCanaryPairV1[];
}
const clusterAnalysisGroupKey = (comparisonId: string, endpoint: string, estimand: string, split: string) =>
  JSON.stringify([comparisonId, endpoint, estimand, split]);

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) { this.parent.set(value, value); return value; }
    if (parent === value) return value;
    const root = this.find(parent); this.parent.set(value, root); return root;
  }
  union(left: string, right: string): void {
    const a = this.find(left), b = this.find(right);
    if (a === b) return;
    if (clusterAnalysisCompare(a, b) <= 0) this.parent.set(b, a); else this.parent.set(a, b);
  }
}

function clusterAnalysisMean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clusterAnalysisQuantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function clusterAnalysisRandomIndexGenerator(seed: string, key: string): (bound: number) => number {
  const stateBytes = createHash("sha256").update(seed).update("\0").update(key).digest();
  let state = stateBytes.readUInt32LE(0) || 0x9e3779b9;
  return (bound: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return Math.floor((state >>> 0) / 0x1_0000_0000 * bound);
  };
}

function withholdClusterAnalysis(group: PairGroup, reason: string, pairCount: number, caseCount: number,
  independentClusterCount: number): ClusteredCanaryComparisonV1 {
  return { comparisonId: group.comparisonId, endpoint: group.endpoint, estimand: group.estimand, split: group.split,
    state: "withheld", reason, pairCount, caseCount, independentClusterCount,
    unit: "independent-family-root-component", difference: null };
}

function estimateClusterAnalysis(group: PairGroup, seed: string, resamples: number, minIndependentClusters: number,
  leakedAcrossSplits: boolean, remainingWork: number): { result: ClusteredCanaryComparisonV1; work: number } {
  const native = group.rows.filter(row => row.executionSource === "native-provider-execution")
    .sort((a, b) => clusterAnalysisCompare(a.pairId, b.pairId));
  if (native.length === 0)
    return { result: withholdClusterAnalysis(group, "no-observed-native-pairs", 0, 0, 0), work: 0 };
  const pairCount = native.length;
  const caseCount = new Set(native.map(row => row.caseId)).size;
  const uf = new UnionFind();
  for (const row of native) {
    const family = JSON.stringify(["family", row.sourceFamilyId]);
    const root = JSON.stringify(["incident", row.incidentRootId]);
    const task = JSON.stringify(["case", row.caseId]);
    uf.union(family, root); uf.union(task, family);
  }
  if (leakedAcrossSplits)
    return { result: withholdClusterAnalysis(group, "case-or-source-family-cross-split", pairCount, caseCount, 0), work: 0 };
  if (native.some(row => !row.complete || row.leftValue === null || row.rightValue === null))
    return { result: withholdClusterAnalysis(group, "incomplete-or-missing-paired-outcome", pairCount, caseCount,
      new Set(native.map(row => uf.find(JSON.stringify(["family", row.sourceFamilyId])))).size), work: 0 };

  const clusterCases = new Map<string, Map<string, number[]>>();
  for (const row of native) {
    const cluster = uf.find(JSON.stringify(["case", row.caseId]));
    const cases = clusterCases.get(cluster) ?? new Map<string, number[]>();
    const values = cases.get(row.caseId) ?? [];
    values.push(row.rightValue! - row.leftValue!);
    cases.set(row.caseId, values); clusterCases.set(cluster, cases);
  }
  const clusterMeans = [...clusterCases.values()].map(cases => clusterAnalysisMean([...cases.values()].map(clusterAnalysisMean))).sort((a, b) => a - b);
  const independentClusterCount = clusterMeans.length;
  if (independentClusterCount < minIndependentClusters)
    return { result: withholdClusterAnalysis(group, "insufficient-independent-clusters", pairCount, caseCount, independentClusterCount), work: 0 };
  const work = independentClusterCount * resamples;
  if (work > remainingWork || work > MAX_TOTAL_BOOTSTRAP_WORK)
    return { result: withholdClusterAnalysis(group, "bootstrap-work-bound", pairCount, caseCount, independentClusterCount), work: 0 };

  const randomIndex = clusterAnalysisRandomIndexGenerator(seed, clusterAnalysisGroupKey(group.comparisonId, group.endpoint, group.estimand, group.split));
  const draws = new Array<number>(resamples);
  for (let sample = 0; sample < resamples; sample++) {
    let total = 0;
    for (let index = 0; index < independentClusterCount; index++) total += clusterMeans[randomIndex(independentClusterCount)]!;
    draws[sample] = total / independentClusterCount;
  }
  draws.sort((a, b) => a - b);
  return { result: { comparisonId: group.comparisonId, endpoint: group.endpoint, estimand: group.estimand, split: group.split,
    state: "estimated", reason: null, pairCount, caseCount, independentClusterCount,
    unit: "independent-family-root-component",
    difference: { estimate: clusterAnalysisMean(clusterMeans), lower95: clusterAnalysisQuantile(draws, 0.025), upper95: clusterAnalysisQuantile(draws, 0.975) } }, work };
}

/** Resample connected source-family/incident-root components; attempts never become independent units. */
export function analyzeClusterPairedCanaries(input: ClusteredCanaryAnalysisInputV1): ClusteredCanaryAnalysisV1 {
  if (!clusterAnalysisRecord(input) || !Array.isArray(input.pairs) || input.pairs.length > MAX_PAIRS
    || !clusterAnalysisText(input.seed, 128)) throw new Error("canary-cluster-input-invalid");
  const declared = validateClusterAnalysisDesign(input.design);
  const resamples = input.resamples ?? 2000;
  const minIndependentClusters = input.minIndependentClusters ?? 10;
  if (!Number.isSafeInteger(resamples) || resamples < 100 || resamples > MAX_RESAMPLES
    || !Number.isSafeInteger(minIndependentClusters) || minIndependentClusters < 2
    || minIndependentClusters > MAX_MIN_CLUSTERS) throw new Error("canary-cluster-bounds-invalid");

  const unique = new Map<string, { row: ClusteredCanaryPairV1; identity: string }>();
  let syntheticControlPairs = 0;
  for (const raw of input.pairs) {
    const row = validateClusterAnalysisPair(raw, declared, input.design.splits);
    const key = clusterAnalysisGroupKey(row.comparisonId, row.endpoint, row.estimand, row.split) + "\0" + row.pairId;
    const identity = JSON.stringify([row.caseId, row.sourceFamilyId, row.incidentRootId, row.executionSource,
      row.complete, row.leftValue, row.rightValue]);
    const prior = unique.get(key);
    if (prior) {
      if (prior.identity !== identity) throw new Error("canary-cluster-contradictory-pair");
      continue;
    }
    unique.set(key, { row, identity });
    if (row.executionSource === "synthetic-control-replay") syntheticControlPairs++;
  }

  const splitByIdentity = new Map<string, Set<CanaryAnalysisSplitV1>>();
  for (const { row } of unique.values()) {
    if (row.executionSource !== "native-provider-execution") continue;
    for (const identity of [JSON.stringify(["case", row.caseId]), JSON.stringify(["family", row.sourceFamilyId]),
      JSON.stringify(["incident", row.incidentRootId])]) {
      const values = splitByIdentity.get(identity) ?? new Set<CanaryAnalysisSplitV1>();
      values.add(row.split); splitByIdentity.set(identity, values);
    }
  }
  const leaked = new Set([...splitByIdentity].filter(([, values]) => values.size > 1).map(([key]) => key));
  const groups = new Map<string, PairGroup>();
  for (const item of input.design.comparisons) for (const endpoint of item.endpoints)
    for (const estimand of item.estimands) for (const split of input.design.splits) {
      const key = clusterAnalysisGroupKey(item.id, endpoint, estimand, split);
      groups.set(key, { comparisonId: item.id, endpoint, estimand, split, rows: [] });
    }
  for (const { row } of unique.values()) {
    const group = groups.get(clusterAnalysisGroupKey(row.comparisonId, row.endpoint, row.estimand, row.split));
    if (!group) throw new Error("canary-cluster-unpredeclared-group");
    group.rows.push(row);
  }

  const comparisons: ClusteredCanaryComparisonV1[] = [];
  let remainingWork = MAX_TOTAL_BOOTSTRAP_WORK;
  for (const [key, group] of [...groups].sort(([a], [b]) => clusterAnalysisCompare(a, b))) {
    const groupHasLeak = group.rows.some(row =>
      leaked.has(JSON.stringify(["case", row.caseId])) || leaked.has(JSON.stringify(["family", row.sourceFamilyId]))
      || leaked.has(JSON.stringify(["incident", row.incidentRootId])));
    const result = estimateClusterAnalysis(group, input.seed, resamples, minIndependentClusters, groupHasLeak, remainingWork);
    remainingWork -= result.work;
    comparisons.push(result.result);
  }
  const available = comparisons.some(result => result.state === "estimated");
  return { version: "model-canary-cluster-analysis-v1", private: true, state: available ? "available" : "unavailable",
    inference: available ? "cluster-bootstrap-95" : "withheld", differenceDirection: "right-minus-left", seed: input.seed,
    resamples, minIndependentClusters, exclusions: { syntheticControlPairs }, comparisons };
}
