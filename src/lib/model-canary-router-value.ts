/**
 * Router attribution remains unavailable until durable frozen decisions can be joined to the same
 * trusted private cases and outcomes used to qualify a static baseline.
 *
 * Current worker.assignment receipts carry a decision timestamp and selected provider/model/effort,
 * but do not carry a private canary case ID, corpus/scorer binding, feature digest, or frozen config
 * digest. Current canary terminal receipts are tied to matrix slots and have no assignment-ID join.
 * A caller-supplied replay row or qualified boolean cannot fill those provenance gaps.
 */
export interface FrozenRouterOutcomeRowV1 {
  caseId: string;
  sourceFamilyId: string;
  incidentRootId: string;
  split: "development" | "sealed-holdout";
  executionSource: "native-provider-execution" | "synthetic-control-replay";
  preOutcomeFeatureDigest: string;
  decisionId: string;
  selectedConfigId: string;
  decisionAt: string;
  outcomeAt: string;
  outcomes: Readonly<Record<string, boolean | null>>;
}
export interface QualifiedStaticBaselineV1 {
  configId: string;
  qualified: boolean;
  qualificationEvidenceDigest: string;
}
export interface EvaluateCanaryRouterValueInputV1 {
  rows: readonly FrozenRouterOutcomeRowV1[];
  baselines: readonly QualifiedStaticBaselineV1[];
  analysisSeed: string;
  minDevelopmentCases?: number;
  minIndependentClusters?: number;
  resamples?: number;
}
export interface EvaluateCanaryRouterValueResultV1 {
  version: "model-canary-router-value-v1";
  private: true;
  state: "unavailable";
  selection: { state: "unavailable"; split: "development"; configId: null;
    qualifiedCandidates: 0; developmentCases: 0; reason: string };
  evaluation: { split: "sealed-holdout"; comparison: null;
    routerSuccesses: 0; routerCases: 0; baselineSuccesses: 0; baselineCases: 0;
    optimisticOracleSuccesses: 0; optimisticOracleCases: 0;
    oracleLabel: "optimistic-empirical-per-case-diagnostic" };
  exclusions: { syntheticRows: number; incompleteSelectedOutcome: number };
}
const MAX_ROWS = 50_000, MAX_BASELINES = 64;
function unavailable(input: EvaluateCanaryRouterValueInputV1): EvaluateCanaryRouterValueResultV1 {
  const syntheticRows = input.rows.filter(row => row?.executionSource === "synthetic-control-replay").length;
  return { version: "model-canary-router-value-v1", private: true, state: "unavailable",
    selection: { state: "unavailable", split: "development", configId: null,
      qualifiedCandidates: 0, developmentCases: 0, reason: "native-router-case-and-decision-linkage-unavailable" },
    evaluation: { split: "sealed-holdout", comparison: null, routerSuccesses: 0, routerCases: 0,
      baselineSuccesses: 0, baselineCases: 0, optimisticOracleSuccesses: 0, optimisticOracleCases: 0,
      oracleLabel: "optimistic-empirical-per-case-diagnostic" },
    exclusions: { syntheticRows, incompleteSelectedOutcome: input.rows.length - syntheticRows } };
}
/**
 * No attribution is produced from caller-supplied replay rows. A future native evidence adapter
 * must bind assignment IDs/timestamps and selected configuration to private corpus case metadata,
 * and join terminal outcomes before this reducer can be enabled.
 */
export function evaluateCanaryRouterValue(input: EvaluateCanaryRouterValueInputV1): EvaluateCanaryRouterValueResultV1 {
  if (!input || !Array.isArray(input.rows) || input.rows.length > MAX_ROWS
    || !Array.isArray(input.baselines) || input.baselines.length < 1 || input.baselines.length > MAX_BASELINES
    || typeof input.analysisSeed !== "string" || input.analysisSeed.length < 1 || input.analysisSeed.length > 128)
    throw new Error("canary-router-input-invalid");
  return unavailable(input);
}
