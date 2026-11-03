/** Pure deterministic partitioning of an effective census into existing bounded canary schedules. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { buildCanarySchedule } from "./model-canary-schedule.js";
import { modelCanaryCaseSetDigest, modelCanaryConfigId, type ModelCanaryConfigCensusV1,
  type ModelCanaryConfigRow } from "./model-canary-config-census.js";
import { canarySuiteDigest, MODEL_CANARY_VERSION, type CanaryCase } from "./model-canary-suite.js";
import type { CanaryPin } from "./model-canary-runner.js";

const MAX_SCHEDULE_SLOTS = 128;
const MAX_MATRIX_CASES = 256;
const MAX_MATRIX_CONFIGURATIONS = 512;
const MAX_MATRIX_REPLICATES = 32;
const MAX_MATRIX_DENOMINATOR_SLOTS = 100_000;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function compareCodeUnits(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value))!; }
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  return value;
}

/** Cases must be canonicalized identically when a prepared shard is later handed to executeCanarySchedule. */
export function canonicalCanaryMatrixCases(cases: readonly CanaryCase[]): CanaryCase[] {
  return cases.map(item => canonicalValue(item) as CanaryCase).sort((a, b) => compareCodeUnits(a.id, b.id));
}

export interface MatrixEligibilityRow {
  caseId: string;
  configId: string;
  state: "eligible" | "excluded" | "unknown";
  reasons: string[];
}
export interface MatrixPanelState {
  replicateId: string;
  caseId: string;
  state: "complete" | "partial" | "none";
  eligibleConfigCount: number;
  nativeFragments: number;
  reasons: string[];
}
export interface MatrixSlotMapping {
  nativeSlotId: string;
  matrixSlotId: string;
  replicateId: string;
  caseId: string;
  configId: string;
  aaLabel: "A" | "B" | null;
}
export interface MatrixShard {
  shardId: string;
  replicateId: string;
  replicateSeed: string;
  caseIds: string[];
  configIds: string[];
  pairing: "complete" | "partial";
  panelStates: MatrixPanelState[];
  /** Existing native schedule. Its pins carry only schedule-local suite identity. */
  schedule: ReturnType<typeof buildCanarySchedule>;
  /** Native slots cannot distinguish census configurations that share the same pin projection. */
  slotConfigIds: Record<string, string>;
  slotMappings: MatrixSlotMapping[];
}
export interface ModelCanaryMatrixPlanV1 {
  version: "model-canary-matrix-plan-v1";
  digest: string;
  asOf: string;
  maxEvidenceAgeMs: number;
  day: string;
  seed: string;
  aa: boolean;
  replicateIds: string[];
  censusDigest: string;
  evidenceDigest: string;
  sourceDigests: Record<string, string>;
  caseSet: { suiteVersion: string; censusCaseDigest: string; nativeSuiteHash: string; caseIds: string[] };
  /** All declarations and projections remain visible; complete eligible slots do not imply full router coverage. */
  declarations: ModelCanaryConfigCensusV1["declarations"];
  declarationCoverage: ModelCanaryConfigCensusV1["declarationCoverage"];
  tableCoverage: ModelCanaryConfigCensusV1["tableCoverage"];
  configurationCoverage: { complete: boolean; declared: number; projected: number; missing: number; reasons: string[] };
  readiness: { scope: "matrix-only"; state: "complete" | "incomplete"; reasons: string[] };
  configurations: ModelCanaryConfigRow[];
  eligibility: MatrixEligibilityRow[];
  panels: MatrixPanelState[];
  denominator: {
    scope: "projected-configurations-only";
    declarations: { declared: number; projected: number; missing: number; eligible: number; excluded: number; unknown: number };
    capabilityTable: { declared: number; mapped: number; projected: number; missing: number; unmapped: number;
      unknownUnmapped: number; excludedUnmapped: number };
    pairs: { eligible: number; excluded: number; unknown: number };
    slots: { eligible: number; excluded: number; unknown: number; planned: number };
  };
  shards: MatrixShard[];
}

export interface PlanCanaryMatrixInput {
  census: ModelCanaryConfigCensusV1;
  cases: readonly CanaryCase[];
  day: string;
  seed: string;
  replicates: number;
  aa?: boolean;
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function sortedUnique(values: readonly string[]): string[] {
  const sorted = [...values].sort(compareCodeUnits);
  if (new Set(sorted).size !== sorted.length) throw new Error("canary-matrix-duplicate-identity");
  return sorted;
}
function nativePinComplete(pin: ModelCanaryConfigRow["pin"]): pin is ModelCanaryConfigRow["pin"]
  & { effort: string; billing: "api" | "subscription" } {
  return nonEmpty(pin.model) && nonEmpty(pin.route) && nonEmpty(pin.effort)
    && (pin.billing === "api" || pin.billing === "subscription");
}
function pinTuple(pin: ModelCanaryConfigRow["pin"]): Omit<CanaryPin, "suiteHash"> {
  if (!nativePinComplete(pin)) throw new Error("canary-matrix-native-pin-incomplete");
  return { model: pin.model, route: pin.route, effort: pin.effort, billing: pin.billing };
}
function rowIdentity(row: ModelCanaryConfigRow): string { return canonicalJson(row.configuration); }
function censusDeclarations(rows: ModelCanaryConfigCensusV1["declarations"]): ModelCanaryConfigCensusV1["declarations"] {
  return [...rows].map(row => canonicalValue(row) as ModelCanaryConfigCensusV1["declarations"][number])
    .sort((a, b) => compareCodeUnits(canonicalJson(a), canonicalJson(b)));
}
function isValidDay(day: string): boolean {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(time) && fixedClock(time).iso().slice(0, 10) === day;
}
/** Build a complete eligible-subset matrix while preserving every excluded/unknown denominator row. */
export function planCanaryMatrix(input: PlanCanaryMatrixInput): ModelCanaryMatrixPlanV1 {
  const { census } = input;
  if (census.version !== "model-canary-config-census-v1" || !nonEmpty(census.digest) || !nonEmpty(census.asOf) ||
      !isValidDay(input.day) || !nonEmpty(input.seed) || !Number.isSafeInteger(input.replicates) || input.replicates < 1 ||
      (input.aa !== undefined && typeof input.aa !== "boolean")) throw new Error("canary-matrix-input-invalid");
  if (input.replicates > MAX_MATRIX_REPLICATES || input.cases.length > MAX_MATRIX_CASES || census.rows.length > MAX_MATRIX_CONFIGURATIONS)
    throw new Error("canary-matrix-input-bound");
  const armCount = input.aa ? 2 : 1;
  const denominatorSlotCount = census.rows.length * input.cases.length * input.replicates * armCount;
  if (!Number.isSafeInteger(denominatorSlotCount) || denominatorSlotCount > MAX_MATRIX_DENOMINATOR_SLOTS)
    throw new Error("canary-matrix-denominator-slot-bound");
  if (census.caseSet.suiteVersion !== MODEL_CANARY_VERSION) throw new Error("canary-matrix-suite-version-mismatch");

  const cases = canonicalCanaryMatrixCases(input.cases);
  const caseIds = sortedUnique(cases.map(item => item.id));
  if (caseIds.length !== input.cases.length || canonicalJson(caseIds) !== canonicalJson(sortedUnique(census.caseSet.caseIds)) ||
      modelCanaryCaseSetDigest(cases) !== census.caseSet.caseDigest) throw new Error("canary-matrix-case-set-mismatch");
  const nativeSuiteHash = canarySuiteDigest(cases);
  const aa = input.aa ?? false, maxPinsPerPlan = Math.floor(MAX_SCHEDULE_SLOTS / armCount);

  const rows = [...census.rows].map(row => {
    const normalized = canonicalValue(row) as ModelCanaryConfigRow;
    return { ...normalized, eligibility: { ...normalized.eligibility, reasons: [...normalized.eligibility.reasons].sort() },
      caseEligibility: [...normalized.caseEligibility].map(evidence => ({ ...evidence, reasons: [...evidence.reasons].sort() }))
        .sort((a, b) => compareCodeUnits(a.caseId, b.caseId)) };
  })
    .sort((a, b) => compareCodeUnits(a.configId, b.configId));
  const declarations = censusDeclarations(census.declarations);
  const declarationCoverage = { ...census.declarationCoverage, reasons: [...census.declarationCoverage.reasons].sort() };
  const tableCoverage = { ...census.tableCoverage, reasons: [...census.tableCoverage.reasons].sort() };
  const sourceDigests = canonicalValue(census.sourceDigests) as Record<string, string>;
  if (!/^[a-f0-9]{64}$/.test(census.digest) || !/^[a-f0-9]{64}$/.test(census.evidenceDigest) ||
      !/^[a-f0-9]{64}$/.test(census.caseSet.caseDigest) || Object.values(sourceDigests).some(value => !/^[a-f0-9]{64}$/.test(value)))
    throw new Error("canary-matrix-census-digest-invalid");
  const routeDeclarations = declarations.filter(row => row.scope === "mounted-route");
  const missingDeclarationCount = routeDeclarations.filter(row => row.projection === "missing").length;
  const unmappedDeclarations = declarations.filter(row => row.projection === "unmapped").length;
  if (declarations.some(row => !["eligible", "excluded", "unknown"].includes(row.state) ||
      !["mounted-route", "configuration-override", "capability-table"].includes(row.scope) ||
      !["present", "missing", "override", "unmapped"].includes(row.projection) || !Array.isArray(row.reasons) ||
      (row.scope === "mounted-route" && row.route === null) ||
      (row.scope === "mounted-route" && !["present", "missing"].includes(row.projection)) ||
      (row.scope === "configuration-override" && row.projection !== "override") ||
      (row.scope === "capability-table" && (row.projection !== "unmapped" || row.route !== null || row.configId !== null)) ||
      (row.projection === "unmapped" && (row.route !== null || row.configId !== null))) ||
      declarationCoverage.declared !== routeDeclarations.length || declarationCoverage.projected + declarationCoverage.missing !== declarationCoverage.declared ||
      declarationCoverage.missing !== missingDeclarationCount || declarationCoverage.complete !== (missingDeclarationCount === 0) ||
      !Number.isSafeInteger(tableCoverage.declared) || !Number.isSafeInteger(tableCoverage.mapped) ||
      !Number.isSafeInteger(tableCoverage.projected) || !Number.isSafeInteger(tableCoverage.missing) ||
      !Number.isSafeInteger(tableCoverage.unmapped) || tableCoverage.declared < 0 || tableCoverage.mapped < 0 ||
      tableCoverage.projected < 0 || tableCoverage.missing < 0 || tableCoverage.unmapped < 0 ||
      tableCoverage.mapped + tableCoverage.unmapped !== tableCoverage.declared ||
      tableCoverage.projected + tableCoverage.missing !== tableCoverage.mapped ||
      tableCoverage.unmapped !== unmappedDeclarations ||
      tableCoverage.complete !== (tableCoverage.missing === 0 && tableCoverage.unmapped === 0))
    throw new Error("canary-matrix-declaration-coverage-inconsistent");
  if (!Number.isSafeInteger(census.maxEvidenceAgeMs) || census.maxEvidenceAgeMs < 0 || census.maxEvidenceAgeMs > 7 * 24 * 60 * 60 * 1000)
    throw new Error("canary-matrix-evidence-age-bound-invalid");
  const censusBody = { version: census.version, asOf: census.asOf, maxEvidenceAgeMs: census.maxEvidenceAgeMs,
    evidenceDigest: census.evidenceDigest, sourceDigests,
    caseSet: { suiteVersion: census.caseSet.suiteVersion, caseDigest: census.caseSet.caseDigest, caseIds },
    declarations, declarationCoverage, tableCoverage, rows };
  if (sha256(canonicalJson(censusBody)) !== census.digest) throw new Error("canary-matrix-census-digest-mismatch");
  const byId = new Map<string, ModelCanaryConfigRow>();
  const identityToId = new Map<string, string>();
  for (const row of rows) {
    if (!row.eligibility || !["eligible", "excluded", "unknown"].includes(row.eligibility.state) ||
        !Array.isArray(row.eligibility.reasons) || !Array.isArray(row.caseEligibility) ||
        row.caseEligibility.some(evidence => !["eligible", "excluded", "unknown"].includes(evidence.state) || !Array.isArray(evidence.reasons)))
      throw new Error("canary-matrix-census-eligibility-invalid");
    if (!nonEmpty(row.configId) || modelCanaryConfigId(row.configuration) !== row.configId) throw new Error("canary-matrix-config-id-mismatch");
    if (byId.has(row.configId)) {
      if (rowIdentity(byId.get(row.configId)!) !== rowIdentity(row)) throw new Error("canary-matrix-conflicting-config-id");
      throw new Error("canary-matrix-duplicate-config-id");
    }
    const tuple = rowIdentity(row), priorId = identityToId.get(tuple);
    if (priorId && priorId !== row.configId) throw new Error("canary-matrix-conflicting-config-identity");
    identityToId.set(tuple, row.configId); byId.set(row.configId, row);
    if (row.pin.suiteHash !== census.caseSet.caseDigest) throw new Error("canary-matrix-census-pin-suite-mismatch");
    if ((row.pin.model !== row.configuration.model) || (row.pin.route !== row.configuration.route) ||
        (row.pin.effort !== row.configuration.effort) || (row.pin.billing !== row.configuration.billing))
      throw new Error("canary-matrix-pin-configuration-mismatch");
  }

  const eligibility: MatrixEligibilityRow[] = [];
  const eligibleByCase = new Map<string, string[]>();
  for (const caseId of caseIds) {
    const eligible: string[] = [];
    for (const row of rows) {
      const evidenceRows = row.caseEligibility.filter(evidence => evidence.caseId === caseId);
      if (row.caseEligibility.some(evidence => !caseIds.includes(evidence.caseId))) throw new Error("canary-matrix-case-evidence-out-of-set");
      if (evidenceRows.length > 1) throw new Error("canary-matrix-duplicate-case-evidence");
      const caseEvidence = evidenceRows[0];
      const states = [row.eligibility.state, caseEvidence?.state];
      let state: MatrixEligibilityRow["state"] = states.includes("excluded") ? "excluded"
        : states.includes("unknown") || !caseEvidence ? "unknown" : "eligible";
      const reasons = [...(row.eligibility.reasons ?? []), ...(caseEvidence?.reasons ?? [])];
      if (!caseEvidence) reasons.push("case-eligibility-evidence-missing");
      if (state === "eligible" && !nativePinComplete(row.pin)) {
        state = "unknown";
        reasons.push("native-pin-incomplete");
      }
      const normalized = { caseId, configId: row.configId, state,
        reasons: [...new Set(reasons.length ? reasons : state === "eligible" ? [] : [state === "excluded" ? "excluded-by-census" : "eligibility-unknown"])].sort() };
      eligibility.push(normalized);
      if (state === "eligible") eligible.push(row.configId);
    }
    eligibleByCase.set(caseId, eligible.sort(compareCodeUnits));
  }
  eligibility.sort((a, b) => compareCodeUnits(a.caseId, b.caseId) || compareCodeUnits(a.configId, b.configId));

  const pairCounts = { eligible: 0, excluded: 0, unknown: 0 };
  for (const row of eligibility) pairCounts[row.state]++;
  const replicateIds = Array.from({ length: input.replicates }, (_, index) => `replicate-${String(index + 1).padStart(4, "0")}`);
  const slotCounts = { eligible: pairCounts.eligible * input.replicates * armCount,
    excluded: pairCounts.excluded * input.replicates * armCount,
    unknown: pairCounts.unknown * input.replicates * armCount, planned: 0 };
  if (![slotCounts.eligible, slotCounts.excluded, slotCounts.unknown].every(Number.isSafeInteger)) throw new Error("canary-matrix-size-overflow");

  const panels: MatrixPanelState[] = [], shards: MatrixShard[] = [], mappedMatrixSlots = new Set<string>();
  for (const replicateId of replicateIds) {
    const groups = new Map<string, { configIds: string[]; caseIds: string[] }>();
    for (const [caseId, configIds] of eligibleByCase) {
      if (!configIds.length) {
        panels.push({ replicateId, caseId, state: "none", eligibleConfigCount: 0, nativeFragments: 0, reasons: ["no-eligible-configurations"] });
        continue;
      }
      const key = canonicalJson(configIds);
      const group = groups.get(key) ?? { configIds, caseIds: [] };
      group.caseIds.push(caseId); groups.set(key, group);
    }
    const groupRows = [...groups.values()].sort((a, b) => compareCodeUnits(canonicalJson(a.configIds), canonicalJson(b.configIds)));
    for (const group of groupRows) {
      group.caseIds.sort(compareCodeUnits);
      const chunks: string[][] = [];
      let chunk: string[] = [], pinKeys = new Set<string>();
      for (const configId of group.configIds) {
        const row = byId.get(configId)!;
        const key = canonicalJson(pinTuple(row.pin));
        if (chunk.length && (chunk.length >= maxPinsPerPlan || pinKeys.has(key))) {
          chunks.push(chunk); chunk = []; pinKeys = new Set();
        }
        chunk.push(configId); pinKeys.add(key);
      }
      if (chunk.length) chunks.push(chunk);
      const fullSlots = group.configIds.length * armCount;
      const reasons = [...(fullSlots > MAX_SCHEDULE_SLOTS ? ["panel-exceeds-native-128-slot-block"] : []),
        ...(chunks.length > 1 && fullSlots <= MAX_SCHEDULE_SLOTS ? ["native-pin-collision-fragments-panel"] : [])];
      const panelState = chunks.length === 1 ? "complete" as const : "partial" as const;
      for (const caseId of group.caseIds) panels.push({ replicateId, caseId, state: panelState,
        eligibleConfigCount: group.configIds.length, nativeFragments: chunks.length, reasons });

      for (const configIds of chunks) {
        const casesPerSchedule = Math.floor(MAX_SCHEDULE_SLOTS / (configIds.length * armCount));
        if (casesPerSchedule < 1) throw new Error("canary-matrix-panel-fragment-overflow");
        for (let offset = 0; offset < group.caseIds.length; offset += casesPerSchedule) {
          const shardCaseIds = group.caseIds.slice(offset, offset + casesPerSchedule);
          const shardCases = cases.filter(item => shardCaseIds.includes(item.id));
          const suiteHash = canarySuiteDigest(shardCases);
          const pins = configIds.map(configId => ({ ...pinTuple(byId.get(configId)!.pin), suiteHash })) as CanaryPin[];
          const shardSeed = sha256(canonicalJson(["model-canary-matrix-shard-seed-v1", input.seed, replicateId, shardCaseIds, configIds]));
          const schedule = buildCanarySchedule(input.day, shardSeed, shardCases, pins, aa);
          const shardId = sha256(canonicalJson(["model-canary-matrix-shard-v1", census.digest, input.day, input.seed, aa,
            replicateId, shardCaseIds, configIds]));
          const slotConfigIds: Record<string, string> = {}, slotMappings: MatrixSlotMapping[] = [];
          const byPin = new Map(configIds.map(configId => [canonicalJson(pinTuple(byId.get(configId)!.pin)), configId]));
          for (const slot of schedule.slots) {
            const configId = byPin.get(canonicalJson({ model: slot.pin.model, route: slot.pin.route,
              effort: slot.pin.effort, billing: slot.pin.billing }));
            if (!configId) throw new Error("canary-matrix-native-slot-unmapped");
            const matrixSlotId = sha256(canonicalJson(["model-canary-matrix-slot-v1", census.digest, input.day, input.seed,
              nativeSuiteHash, replicateId, slot.caseId, configId, slot.aaLabel]));
            const matrixKey = `${replicateId}\0${slot.caseId}\0${configId}\0${slot.aaLabel ?? "none"}`;
            if (mappedMatrixSlots.has(matrixKey)) throw new Error("canary-matrix-duplicate-slot");
            mappedMatrixSlots.add(matrixKey); slotConfigIds[slot.id] = configId;
            slotMappings.push({ nativeSlotId: slot.id, matrixSlotId, replicateId, caseId: slot.caseId, configId, aaLabel: slot.aaLabel });
          }
          const shardPanels = shardCaseIds.map(caseId => panels.find(panel => panel.replicateId === replicateId && panel.caseId === caseId)!)
            .map(panel => ({ ...panel }));
          shards.push({ shardId, replicateId, replicateSeed: sha256(canonicalJson([input.seed, replicateId])),
            caseIds: shardCaseIds, configIds, pairing: panelState, panelStates: shardPanels, schedule, slotConfigIds, slotMappings });
        }
      }
    }
  }
  slotCounts.planned = mappedMatrixSlots.size;
  if (slotCounts.planned !== slotCounts.eligible) throw new Error("canary-matrix-slot-union-incomplete");
  panels.sort((a, b) => compareCodeUnits(a.replicateId, b.replicateId) || compareCodeUnits(a.caseId, b.caseId));
  shards.sort((a, b) => compareCodeUnits(a.replicateId, b.replicateId) || compareCodeUnits(a.caseIds[0]!, b.caseIds[0]!) ||
    compareCodeUnits(canonicalJson(a.configIds), canonicalJson(b.configIds)));

  const coverageReasons = [...new Set([...declarationCoverage.reasons, ...tableCoverage.reasons])].sort();
  const coverageComplete = declarationCoverage.complete && tableCoverage.complete;
  const declarationStates = { eligible: 0, excluded: 0, unknown: 0 };
  const unmappedStates = { eligible: 0, excluded: 0, unknown: 0 };
  for (const row of declarations) {
    if (row.scope === "mounted-route") declarationStates[row.state]++;
    else if (row.scope === "capability-table") unmappedStates[row.state]++;
  }
  const partialPanels = panels.some(panel => panel.state === "partial");
  const unknownPairs = pairCounts.unknown > 0;
  const readinessReasons = [...(!coverageComplete ? coverageReasons.length ? coverageReasons : ["configuration-projections-incomplete"] : []),
    ...(unknownPairs ? ["unknown-eligibility-remains"] : []), ...(partialPanels ? ["paired-panels-fragmented-across-native-schedules"] : []),
    ...(slotCounts.planned === 0 ? ["no-eligible-matrix-slots"] : [])];
  const resultWithoutDigest = {
    version: "model-canary-matrix-plan-v1" as const, asOf: census.asOf, maxEvidenceAgeMs: census.maxEvidenceAgeMs,
    day: input.day, seed: input.seed, aa,
    replicateIds, censusDigest: census.digest, evidenceDigest: census.evidenceDigest,
    sourceDigests,
    caseSet: { suiteVersion: census.caseSet.suiteVersion, censusCaseDigest: census.caseSet.caseDigest, nativeSuiteHash,
      caseIds }, declarations, declarationCoverage, tableCoverage,
    configurationCoverage: { complete: coverageComplete, declared: declarationCoverage.declared,
      projected: declarationCoverage.projected, missing: declarationCoverage.missing, reasons: coverageReasons },
    readiness: { scope: "matrix-only" as const, state: readinessReasons.length ? "incomplete" as const : "complete" as const,
      reasons: readinessReasons }, configurations: rows, eligibility, panels,
    denominator: { scope: "projected-configurations-only" as const,
      declarations: { declared: declarationCoverage.declared, projected: declarationCoverage.projected,
        missing: declarationCoverage.missing, ...declarationStates },
      capabilityTable: { declared: tableCoverage.declared, mapped: tableCoverage.mapped,
        projected: tableCoverage.projected, missing: tableCoverage.missing, unmapped: tableCoverage.unmapped,
        unknownUnmapped: unmappedStates.unknown, excludedUnmapped: unmappedStates.excluded },
      pairs: pairCounts, slots: slotCounts }, shards,
  };
  const digest = sha256(canonicalJson(resultWithoutDigest));
  return { ...resultWithoutDigest, digest };
}
