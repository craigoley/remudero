/** Side-by-side private comparison; benchmark and field-trial denominators never pool. */
import { createHash } from "node:crypto";

export type FieldTrialDesignV1 = "observational" | "registered-randomized";
export type FieldTrialEvidenceStateV1 = "observed" | "unavailable";
export type FieldOutcomeEstimandV1 = "first-attempt" | "all-repeats" | "best-of-k";
export interface CanaryFieldComparisonIdentityV1 {
  provider: string | null; deployment: string | null; requestedModel: string | null; model: string | null;
  route: string | null; effort: string | null; billing: string | null;
  treatment: { scaffold: string | null; tools: string | null; context: string | null; cache: string | null } | null;
  corpusDigest: string | null; scorerDigest: string | null; role: string | null;
  observationWindow: { start: string | null; end: string | null } | null;
}
export interface CanaryBenchmarkCaseV1 {
  runId: string; caseId: string; sourceFamilyId: string; incidentRootId: string;
  split: "development" | "sealed-holdout"; executionSource: "native-provider-execution" | "synthetic-control-replay";
  identity: CanaryFieldComparisonIdentityV1; outcomes: Record<FieldOutcomeEstimandV1, boolean | null>;
}
export interface FieldTrialComparisonCohortV1 {
  id: string; design: FieldTrialDesignV1; state: FieldTrialEvidenceStateV1; identity: CanaryFieldComparisonIdentityV1;
  assignedTasks: number | null; observedTasks: number | null; successfulTasks: number | null;
  assignmentAudit: "pass" | "fail" | "unavailable" | null; randomizationUnit: "task" | null;
  analysis: "intention-to-treat" | null; assignmentProbabilities: Readonly<Record<string, number>> | null;
}
export interface CompareCanaryFieldTrialsInputV1 {
  benchmarkCases: readonly CanaryBenchmarkCaseV1[]; fieldTrials: readonly FieldTrialComparisonCohortV1[];
}
interface BenchmarkOutcomeSummary {
  caseDenominator: { unit: "distinct-cases"; count: number }; observedRuns: number; caseMean: number | null;
  selection: "none" | "optimistic-best-of-k-diagnostic";
}
interface FieldTrialDenominator {
  unit: "assigned-tasks"; assigned: number; observed: number; successful: number;
  rate: number; metricDenominator: "assigned" | "observed";
}
export interface CanaryFieldComparisonV1 {
  identityDigest: string; split: "development" | "sealed-holdout";
  benchmark: { denominator: { unit: "distinct-cases"; count: number };
    outcomes: Record<FieldOutcomeEstimandV1, BenchmarkOutcomeSummary> };
  fieldTrial: { cohortDigest: string; design: FieldTrialDesignV1; denominator: FieldTrialDenominator;
    inference: "descriptive-only" | "randomized-itt-separate"; assignmentAudit: "pass" | null;
    randomizationUnit: "task" | null; analysis: "intention-to-treat" | "descriptive-only";
    assignmentProbabilities: Record<string, number> | null };
}
export interface CanaryFieldComparisonResultV1 {
  version: "model-canary-field-comparison-v1"; private: true; state: "available" | "unavailable";
  denominators: { benchmarkDistinctCases: number; observationalAssignedTasks: number; randomizedAssignedTasks: number };
  exclusions: { syntheticControlRuns: number }; comparisons: CanaryFieldComparisonV1[];
  unmatched: { cohortDigest: string; reason: string; design: FieldTrialDesignV1; state: FieldTrialEvidenceStateV1;
    assignedTasks: number | null; observedTasks: number | null; successfulTasks: number | null;
    inference: "descriptive-only" | "randomized-itt-separate"; assignmentAudit: "pass" | "fail" | "unavailable" | null;
    randomizationUnit: "task" | null; analysis: "intention-to-treat" | "descriptive-only";
    assignmentProbabilities: Record<string, number> | null }[];
}
const ESTIMANDS: readonly FieldOutcomeEstimandV1[] = ["first-attempt", "all-repeats", "best-of-k"];
const SOURCES = ["native-provider-execution", "synthetic-control-replay"] as const;
const SPLITS = ["development", "sealed-holdout"] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_BENCHMARK_ROWS = 50_000, MAX_FIELD_COHORTS = 512, MAX_TEXT = 256;
const fieldComparisonRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fieldComparisonExact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join("\0") === [...keys].sort().join("\0");
const fieldComparisonText = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const fieldComparisonCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fieldComparisonHash = (v: string) => createHash("sha256").update(v).digest("hex");

function fieldComparisonIdentity(value: unknown): { value: CanaryFieldComparisonIdentityV1; key: string; missing: boolean } {
  const keys = ["provider", "deployment", "requestedModel", "model", "route", "effort", "billing", "treatment",
    "corpusDigest", "scorerDigest", "role", "observationWindow"];
  if (!fieldComparisonRecord(value) || !fieldComparisonExact(value, keys)) throw new Error("canary-field-identity-invalid");
  for (const key of ["provider", "deployment", "requestedModel", "model", "route", "effort", "billing",
    "corpusDigest", "scorerDigest", "role"]) {
    const item = value[key];
    if (!(item === null || fieldComparisonText(item))) throw new Error("canary-field-identity-invalid");
  }
  for (const key of ["corpusDigest", "scorerDigest"])
    if (value[key] !== null && !DIGEST.test(value[key] as string)) throw new Error("canary-field-identity-invalid");
  let treatment: CanaryFieldComparisonIdentityV1["treatment"] = null;
  if (value.treatment !== null) {
    if (!fieldComparisonRecord(value.treatment) || !fieldComparisonExact(value.treatment, ["scaffold", "tools", "context", "cache"])
      || ["scaffold", "tools", "context", "cache"].some(key => !fieldComparisonText((value.treatment as Record<string, unknown>)[key])))
      throw new Error("canary-field-identity-invalid");
    treatment = { scaffold: value.treatment.scaffold as string, tools: value.treatment.tools as string,
      context: value.treatment.context as string, cache: value.treatment.cache as string };
  }
  let observationWindow: CanaryFieldComparisonIdentityV1["observationWindow"] = null;
  if (value.observationWindow !== null) {
    if (!fieldComparisonRecord(value.observationWindow) || !fieldComparisonExact(value.observationWindow, ["start", "end"])
      || !fieldComparisonText(value.observationWindow.start) || !fieldComparisonText(value.observationWindow.end)
      || !Number.isFinite(Date.parse(value.observationWindow.start)) || !Number.isFinite(Date.parse(value.observationWindow.end))
      || Date.parse(value.observationWindow.start) >= Date.parse(value.observationWindow.end))
      throw new Error("canary-field-identity-invalid");
    observationWindow = { start: value.observationWindow.start, end: value.observationWindow.end };
  }
  const normalized = { provider: value.provider as string | null, deployment: value.deployment as string | null,
    requestedModel: value.requestedModel as string | null, model: value.model as string | null,
    route: value.route as string | null, effort: value.effort as string | null, billing: value.billing as string | null,
    treatment, corpusDigest: value.corpusDigest as string | null, scorerDigest: value.scorerDigest as string | null,
    role: value.role as string | null, observationWindow };
  const tuple = [normalized.provider, normalized.deployment, normalized.requestedModel, normalized.model,
    normalized.route, normalized.effort, normalized.billing, treatment?.scaffold ?? null, treatment?.tools ?? null,
    treatment?.context ?? null, treatment?.cache ?? null, normalized.corpusDigest, normalized.scorerDigest,
    normalized.role, observationWindow?.start ?? null, observationWindow?.end ?? null];
  return { value: normalized, key: JSON.stringify(tuple),
    missing: Object.entries(normalized).some(([k, v]) => v === null && !["treatment", "observationWindow"].includes(k))
      || treatment === null || observationWindow === null };
}

function validateFieldBenchmark(value: unknown): CanaryBenchmarkCaseV1 {
  const keys = ["runId", "caseId", "sourceFamilyId", "incidentRootId", "split", "executionSource", "identity", "outcomes"];
  if (!fieldComparisonRecord(value) || !fieldComparisonExact(value, keys) || !fieldComparisonText(value.runId, 128) || !fieldComparisonText(value.caseId, 160)
    || !fieldComparisonText(value.sourceFamilyId, 160) || !fieldComparisonText(value.incidentRootId, 160)
    || !SPLITS.includes(value.split as typeof SPLITS[number])
    || !SOURCES.includes(value.executionSource as typeof SOURCES[number])
    || !fieldComparisonRecord(value.outcomes) || !fieldComparisonExact(value.outcomes, ESTIMANDS)) throw new Error("canary-field-benchmark-invalid");
  if (ESTIMANDS.some(e => !((value.outcomes as Record<string, unknown>)[e] === null || typeof (value.outcomes as Record<string, unknown>)[e] === "boolean")))
    throw new Error("canary-field-benchmark-invalid");
  fieldComparisonIdentity(value.identity);
  return value as unknown as CanaryBenchmarkCaseV1;
}
function validateFieldTrial(value: unknown): FieldTrialComparisonCohortV1 {
  const keys = ["id", "design", "state", "identity", "assignedTasks", "observedTasks", "successfulTasks",
    "assignmentAudit", "randomizationUnit", "analysis", "assignmentProbabilities"];
  if (!fieldComparisonRecord(value) || !fieldComparisonExact(value, keys) || !fieldComparisonText(value.id, 160)
    || !["observational", "registered-randomized"].includes(String(value.design))
    || !["observed", "unavailable"].includes(String(value.state))) throw new Error("canary-field-trial-invalid");
  for (const key of ["assignedTasks", "observedTasks", "successfulTasks"]) {
    const n = value[key];
    if (!(n === null || Number.isSafeInteger(n) && (n as number) >= 0)) throw new Error("canary-field-trial-invalid");
  }
  if (value.state === "observed" && (value.assignedTasks === null || value.observedTasks === null || value.successfulTasks === null
    || (value.observedTasks as number) > (value.assignedTasks as number)
    || (value.successfulTasks as number) > (value.observedTasks as number))) throw new Error("canary-field-trial-invalid");
  if (value.state === "unavailable" && (value.assignedTasks !== null || value.observedTasks !== null || value.successfulTasks !== null))
    throw new Error("canary-field-trial-invalid");
  fieldComparisonIdentity(value.identity);
  if (value.design === "observational") {
    if (value.assignmentAudit !== null || value.randomizationUnit !== null || value.analysis !== null
      || value.assignmentProbabilities !== null) throw new Error("canary-field-trial-invalid");
  } else {
    if (!["pass", "fail", "unavailable"].includes(String(value.assignmentAudit))
      || !(value.randomizationUnit === "task" || value.randomizationUnit === null)
      || !(value.analysis === "intention-to-treat" || value.analysis === null)) throw new Error("canary-field-trial-invalid");
    if (value.assignmentProbabilities !== null && (!fieldComparisonRecord(value.assignmentProbabilities)
      || Object.keys(value.assignmentProbabilities).length < 2 || Object.keys(value.assignmentProbabilities).length > 16
      || Object.entries(value.assignmentProbabilities).some(([arm, p]) => !fieldComparisonText(arm, 64)
        || typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 1)))
      throw new Error("canary-field-trial-invalid");
  }
  return value as unknown as FieldTrialComparisonCohortV1;
}

interface Group { identity: CanaryFieldComparisonIdentityV1; key: string; split: "development" | "sealed-holdout";
  cases: Map<string, { family: string; root: string; rows: CanaryBenchmarkCaseV1[] }> }
function fieldComparisonCaseMean(rows: readonly CanaryBenchmarkCaseV1[], e: FieldOutcomeEstimandV1): number | null {
  const xs = rows.flatMap(row => row.outcomes[e] === null ? [] : [Number(row.outcomes[e])]);
  if (!xs.length) return null;
  return e === "best-of-k" ? Math.max(...xs) : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function fieldComparisonSummary(group: Group, e: FieldOutcomeEstimandV1): BenchmarkOutcomeSummary {
  const values = [...group.cases.values()].map(c => fieldComparisonCaseMean(c.rows, e)).filter((x): x is number => x !== null);
  return { caseDenominator: { unit: "distinct-cases", count: values.length },
    observedRuns: [...group.cases.values()].reduce((n, c) => n + c.rows.length, 0),
    caseMean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    selection: e === "best-of-k" ? "optimistic-best-of-k-diagnostic" : "none" };
}
function fieldComparisonCohortDigest(id: string) { return fieldComparisonHash(id); }
function unmatchedFieldEvidence(c: FieldTrialComparisonCohortV1, reason: string) {
  return { cohortDigest: fieldComparisonCohortDigest(c.id), reason, design: c.design, state: c.state,
    assignedTasks: c.assignedTasks, observedTasks: c.observedTasks, successfulTasks: c.successfulTasks,
    inference: c.design === "observational" ? "descriptive-only" as const : "randomized-itt-separate" as const,
    assignmentAudit: c.assignmentAudit, randomizationUnit: c.randomizationUnit,
    analysis: c.design === "observational" ? "descriptive-only" as const : "intention-to-treat" as const,
    assignmentProbabilities: c.assignmentProbabilities === null ? null
      : Object.fromEntries(Object.entries(c.assignmentProbabilities).sort(([a], [b]) => fieldComparisonCompare(a, b))) };
}

/** Join exact identity only and report each side with its own denominator; never compute a pooled effect. */
export function compareCanaryToFieldTrials(input: CompareCanaryFieldTrialsInputV1): CanaryFieldComparisonResultV1 {
  if (!fieldComparisonRecord(input) || !Array.isArray(input.benchmarkCases) || input.benchmarkCases.length > MAX_BENCHMARK_ROWS
    || !Array.isArray(input.fieldTrials) || input.fieldTrials.length > MAX_FIELD_COHORTS)
    throw new Error("canary-field-comparison-input-invalid");
  const benchmarks = input.benchmarkCases.map(validateFieldBenchmark), field = input.fieldTrials.map(validateFieldTrial);
  const uniqueRuns = new Map<string, string>(), groups = new Map<string, Group>();
  let syntheticControlRuns = 0;
  const unverifiedWindowIdentityKeys = new Set<string>();
  for (const row of benchmarks) {
    const ident = fieldComparisonIdentity(row.identity), fingerprint = JSON.stringify([row.caseId, row.sourceFamilyId, row.incidentRootId,
      row.split, row.executionSource, ident.key, row.outcomes]);
    const priorFingerprint = uniqueRuns.get(row.runId);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint !== fingerprint) throw new Error("canary-field-duplicate-run-contradictory");
      continue;
    }
    uniqueRuns.set(row.runId, fingerprint);
    if (row.executionSource === "synthetic-control-replay") { syntheticControlRuns++; continue; }
    if (ident.missing) {
      if (ident.value.observationWindow === null)
        unverifiedWindowIdentityKeys.add(fieldComparisonIdentity({ ...ident.value, observationWindow: null }).key);
      continue;
    }
    const key = JSON.stringify([ident.key, row.split]);
    const group = groups.get(key) ?? { identity: ident.value, key: ident.key, split: row.split, cases: new Map() };
    const priorCase = group.cases.get(row.caseId);
    if (priorCase && (priorCase.family !== row.sourceFamilyId || priorCase.root !== row.incidentRootId))
      throw new Error("canary-field-case-provenance-conflict");
    const c = priorCase ?? { family: row.sourceFamilyId, root: row.incidentRootId, rows: [] };
    c.rows.push(row); group.cases.set(row.caseId, c); groups.set(key, group);
  }

  const comparisons: CanaryFieldComparisonV1[] = [], unmatchedRows: ReturnType<typeof unmatchedFieldEvidence>[] = [];
  const seen = new Map<string, string>();
  let observationalAssignedTasks = 0, randomizedAssignedTasks = 0;
  for (const cohort of field) {
    const ident = fieldComparisonIdentity(cohort.identity);
    const fingerprint = JSON.stringify([ident.key, cohort.design, cohort.state, cohort.assignedTasks, cohort.observedTasks,
      cohort.successfulTasks, cohort.assignmentAudit, cohort.randomizationUnit, cohort.analysis, cohort.assignmentProbabilities]);
    const prior = seen.get(cohort.id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("canary-field-duplicate-cohort-contradictory");
      continue;
    }
    seen.set(cohort.id, fingerprint);
    if (cohort.design === "observational" && cohort.assignedTasks !== null) observationalAssignedTasks += cohort.assignedTasks;
    if (cohort.design === "registered-randomized" && cohort.assignedTasks !== null) randomizedAssignedTasks += cohort.assignedTasks;
    if (cohort.state === "unavailable") { unmatchedRows.push(unmatchedFieldEvidence(cohort, "field-trial-evidence-unavailable")); continue; }
    if (ident.missing) {
      unmatchedRows.push(unmatchedFieldEvidence(cohort,
        ident.value.observationWindow === null ? "observation-window-unverified" : "serving-identity-incomplete"));
      continue;
    }
    const cohortWithoutWindow = fieldComparisonIdentity({ ...ident.value, observationWindow: null }).key;
    if (unverifiedWindowIdentityKeys.has(cohortWithoutWindow)) {
      unmatchedRows.push(unmatchedFieldEvidence(cohort, "observation-window-unverified"));
      continue;
    }
    if (cohort.design === "registered-randomized" && (cohort.assignmentAudit !== "pass" || cohort.randomizationUnit !== "task"
      || cohort.analysis !== "intention-to-treat" || cohort.assignmentProbabilities === null
      || Math.abs(Object.values(cohort.assignmentProbabilities ?? {}).reduce((a, b) => a + b, 0) - 1) > 1e-6)) {
      unmatchedRows.push(unmatchedFieldEvidence(cohort, "randomization-provenance-unavailable")); continue;
    }
    const matching = [...groups.values()].filter(g => g.key === ident.key);
    if (!matching.length) { unmatchedRows.push(unmatchedFieldEvidence(cohort, "serving-identity-mismatch")); continue; }
    if (cohort.assignedTasks === 0 || cohort.observedTasks === 0 && cohort.design === "observational") {
      unmatchedRows.push(unmatchedFieldEvidence(cohort, "field-trial-denominator-empty")); continue;
    }
    for (const group of matching) {
      const assigned = cohort.assignedTasks!, observed = cohort.observedTasks!, successful = cohort.successfulTasks!;
      const metricDenominator = cohort.design === "registered-randomized" ? "assigned" as const : "observed" as const;
      const rate = metricDenominator === "assigned" ? successful / assigned : successful / observed;
      comparisons.push({ identityDigest: fieldComparisonHash(group.key), split: group.split,
        benchmark: { denominator: { unit: "distinct-cases", count: group.cases.size }, outcomes: {
          "first-attempt": fieldComparisonSummary(group, "first-attempt"), "all-repeats": fieldComparisonSummary(group, "all-repeats"),
          "best-of-k": fieldComparisonSummary(group, "best-of-k") } },
        fieldTrial: { cohortDigest: fieldComparisonCohortDigest(cohort.id), design: cohort.design,
          denominator: { unit: "assigned-tasks", assigned, observed, successful, rate, metricDenominator },
          inference: cohort.design === "observational" ? "descriptive-only" : "randomized-itt-separate",
          assignmentAudit: cohort.design === "registered-randomized" ? "pass" : null,
          randomizationUnit: cohort.design === "registered-randomized" ? "task" : null,
          analysis: cohort.design === "observational" ? "descriptive-only" : "intention-to-treat",
          assignmentProbabilities: cohort.design === "registered-randomized"
            ? Object.fromEntries(Object.entries(cohort.assignmentProbabilities!).sort(([a], [b]) => fieldComparisonCompare(a, b))) : null } });
    }
  }
  const benchmarkDistinctCases = [...groups.values()].reduce((n, g) => n + g.cases.size, 0);
  comparisons.sort((a, b) => fieldComparisonCompare(JSON.stringify([a.identityDigest, a.split, a.fieldTrial.design, a.fieldTrial.cohortDigest]),
    JSON.stringify([b.identityDigest, b.split, b.fieldTrial.design, b.fieldTrial.cohortDigest])));
  unmatchedRows.sort((a, b) => fieldComparisonCompare(JSON.stringify(a), JSON.stringify(b)));
  return { version: "model-canary-field-comparison-v1", private: true, state: comparisons.length ? "available" : "unavailable",
    denominators: { benchmarkDistinctCases, observationalAssignedTasks, randomizedAssignedTasks },
    exclusions: { syntheticControlRuns }, comparisons, unmatched: unmatchedRows };
}
