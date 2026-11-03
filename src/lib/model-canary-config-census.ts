/** Pure, private inventory of declared canary configurations and explicitly supplied eligibility evidence. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { canonicalWorkerProviderId, WORKER_PROVIDER_IDS, type WorkerProviderId } from "./config.js";
import { resolveProviderRoutingPolicy, PROVIDER_ROUTING_POLICY_VERSION,
  MAX_PROVIDER_POLICY_RESERVE_PERCENT,
  type EffectiveProviderRoutingPolicy } from "./provider-routing-policy.js";
import type { Mounts } from "./mounts.js";
import { MODEL_CANARY_VERSION, type CanaryCase } from "./model-canary-suite.js";

export type ConfigCensusState = "eligible" | "excluded" | "unknown";
export type ConfigCensusBilling = "api" | "subscription";

export interface ModelCanaryTreatment {
  scaffold: string | null;
  tools: string | null;
  context: string | null;
  cache: string | null;
}

/** Full configuration identity. `model` is the concrete provider model; `requestedModel` remains the router input. */
export interface ModelCanaryConfiguration {
  provider: WorkerProviderId;
  deployment: string | null;
  requestedModel: string;
  model: string;
  effort: string | null;
  route: string;
  billing: ConfigCensusBilling | null;
  treatment: ModelCanaryTreatment;
}

/** Native scheduling fields may be null only for retained, non-schedulable unknown configurations. */
export interface ModelCanaryConfigPin {
  model: string;
  route: string;
  effort: string | null;
  suiteHash: string;
  billing: ConfigCensusBilling | null;
}

export interface ModelCanaryConfigEvidence {
  configId: string;
  state: ConfigCensusState;
  reasons: string[];
  asOf: string;
  sourceDigest: string;
  billing?: ConfigCensusBilling | null;
}

export interface ModelCanaryConfigOverrideEvidence extends ModelCanaryConfigEvidence {
  sourcePath: string;
  changes: Array<{ field: "model" | "effort"; from: string | null; to: string | null }>;
}

export interface ModelCanaryEvidenceSnapshot {
  state: ConfigCensusState;
  reasons: string[];
  asOf: string;
  sourceDigest: string;
  billing?: ConfigCensusBilling | null;
}

export interface ModelCanaryCaseEvidence extends ModelCanaryConfigEvidence {
  caseId: string;
}

export interface ModelCanaryConfigRow {
  configId: string;
  pin: ModelCanaryConfigPin;
  configuration: ModelCanaryConfiguration;
  eligibility: { state: ConfigCensusState; reasons: string[] };
  caseEligibility: Array<{ caseId: string; state: ConfigCensusState; reasons: string[] }>;
  evidence: { capability: ModelCanaryEvidenceSnapshot | null; access: ModelCanaryEvidenceSnapshot | null;
    configurationOverride: ModelCanaryConfigOverrideEvidence | null;
    cases: Array<{ caseId: string; evidence: ModelCanaryEvidenceSnapshot | null }> };
}

export interface ModelCanaryConfigDeclaration {
  scope: "mounted-route" | "configuration-override" | "capability-table";
  configId: string | null;
  sourcePath: string;
  route: string | null;
  requestedModel: string | null;
  requestedEffort: string | null;
  provider: WorkerProviderId;
  deployment: string | null;
  model: string | null;
  effort: string | null;
  billing: ConfigCensusBilling | null;
  treatment: ModelCanaryTreatment;
  state: ConfigCensusState;
  projection: "present" | "missing" | "override" | "unmapped";
  reasons: string[];
}

export interface ModelCanaryConfigCensusV1 {
  version: "model-canary-config-census-v1";
  asOf: string;
  maxEvidenceAgeMs: number;
  digest: string;
  evidenceDigest: string;
  sourceDigests: Record<string, string>;
  caseSet: { suiteVersion: string; caseDigest: string; caseIds: string[] };
  declarations: ModelCanaryConfigDeclaration[];
  declarationCoverage: { complete: boolean; declared: number; projected: number; missing: number; reasons: string[] };
  tableCoverage: { complete: boolean; declared: number; mapped: number; projected: number; missing: number;
    unmapped: number; reasons: string[] };
  rows: ModelCanaryConfigRow[];
}

/** Sanitized effective configuration supplied by the caller; it contains no endpoint, key, or credential values. */
export interface ModelCanaryConfigCandidate {
  configuration: ModelCanaryConfiguration;
  sourceDigests: Record<string, string>;
}

export interface BuildEffectiveConfigCensusInput {
  asOf: string;
  mounts: Mounts;
  policy: EffectiveProviderRoutingPolicy;
  sourceDigests: Record<string, string>;
  cases: readonly CanaryCase[];
  treatments: readonly ModelCanaryTreatment[];
  /** Maximum accepted evidence age; defaults to exact as-of only. Bounded separately from caller policy. */
  maxEvidenceAgeMs?: number;
  configurations: readonly ModelCanaryConfigCandidate[];
  capabilityEvidence: readonly ModelCanaryConfigEvidence[];
  accessEvidence: readonly ModelCanaryConfigEvidence[];
  configurationOverrideEvidence?: readonly ModelCanaryConfigOverrideEvidence[];
  caseEvidence: readonly ModelCanaryCaseEvidence[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const MAX_CASES = 256;
const MAX_CONFIGURATIONS = 512;
const MAX_TREATMENTS = 32;
const MAX_ROUTE_TUPLES = 4096;
const MAX_DECLARATIONS = 32_768;
const MAX_CASE_EVIDENCE = MAX_CONFIGURATIONS * MAX_CASES;
const MAX_SOURCE_DIGESTS = 128;
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const MAX_CASE_SET_BYTES = 2 * 1024 * 1024;
interface JsonByteBudget { remaining: number; exceeded: boolean }

function chargeJsonBytes(budget: JsonByteBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remaining) {
    budget.exceeded = true;
    return false;
  }
  budget.remaining -= bytes;
  return true;
}

/** Count JSON string bytes without materializing its escaped representation. */
function chargeJsonString(value: string, budget: JsonByteBudget): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_CASE_SET_BYTES) {
    budget.exceeded = true;
    return false;
  }
  let bytes = 2; // quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a
      || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
      else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > budget.remaining) { budget.exceeded = true; return false; }
  }
  return chargeJsonBytes(budget, bytes);
}

/** Validate while charging expanded serialized bytes, so shared DAGs cannot expand unboundedly. */
function isJsonRoundTrippable(value: unknown, budget: JsonByteBudget, depth = 0,
  ancestors = new Set<object>()): boolean {
  if (depth > 64) return false;
  if (value === null) return chargeJsonBytes(budget, 4);
  if (typeof value === "string") return chargeJsonString(value, budget);
  if (typeof value === "boolean") return chargeJsonBytes(budget, value ? 4 : 5);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && chargeJsonBytes(budget, Buffer.byteLength(serialized, "utf8"));
  }
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1
      || !chargeJsonBytes(budget, 1)) valid = false; // opening bracket
    for (let index = 0; valid && index < value.length; index++) {
      if (index > 0 && !chargeJsonBytes(budget, 1)) { valid = false; break; } // comma
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      valid = descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, "value")
        && isJsonRoundTrippable(descriptor.value, budget, depth + 1, ancestors);
    }
    if (valid) valid = chargeJsonBytes(budget, 1); // closing bracket
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || !chargeJsonBytes(budget, 1)) valid = false; // opening brace
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (!valid) break;
      if (typeof key !== "string") { valid = false; break; }
      if (count > 0 && !chargeJsonBytes(budget, 1)) { valid = false; break; } // comma
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || !chargeJsonString(key, budget) || !chargeJsonBytes(budget, 1) // colon
        || !isJsonRoundTrippable(descriptor.value, budget, depth + 1, ancestors)) { valid = false; break; }
      count++;
    }
    if (valid) valid = chargeJsonBytes(budget, 1); // closing brace
  }
  ancestors.delete(value);
  return valid;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonical(value));
  if (typeof serialized !== "string") throw new Error("canary-config-census-json-invalid");
  return serialized;
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function addDigest(target: Record<string, string>, name: string, digest: string): void {
  const previous = target[name];
  if (previous !== undefined && previous !== digest) throw new Error("canary-config-census-source-digest-conflict");
  target[name] = digest;
}

function validTreatment(value: unknown): value is ModelCanaryTreatment {
  if (!record(value) || Object.keys(value).length !== 4) return false;
  return (["scaffold", "tools", "context", "cache"] as const).every((axis) => {
    const field = value[axis];
    return field === null || nonempty(field) && field.length <= 120;
  });
}

function validateConfiguration(value: unknown): value is ModelCanaryConfiguration {
  if (!record(value) || Object.keys(value).length !== 8
    || !["provider", "deployment", "requestedModel", "model", "effort", "route", "billing", "treatment"]
      .every((key) => Object.hasOwn(value, key))
    || !["claude", "codex", "cash", "openweight"].includes(String(value.provider))) return false;
  if (!(value.deployment === null || nonempty(value.deployment) && value.deployment.length <= 160)) return false;
  if (!nonempty(value.requestedModel) || value.requestedModel.length > 200
    || typeof value.model !== "string" || value.model.length > 200
    || !(value.effort === null || nonempty(value.effort) && value.effort.length <= 80)
    || !nonempty(value.route) || value.route.length > 320
    || !(value.billing === null || value.billing === "api" || value.billing === "subscription")
    || !validTreatment(value.treatment)) return false;
  return true;
}

function sanitizeConfiguration(value: ModelCanaryConfiguration): ModelCanaryConfiguration {
  return { provider: canonicalWorkerProviderId(value.provider) as WorkerProviderId, deployment: value.deployment, requestedModel: value.requestedModel,
    model: value.model, effort: value.effort, route: value.route, billing: value.billing,
    treatment: { scaffold: value.treatment.scaffold, tools: value.treatment.tools,
      context: value.treatment.context, cache: value.treatment.cache } };
}

function validAsOf(value: string): boolean {
  if (!nonempty(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && fixedClock(parsed).iso() === value;
}

function policySnapshotReasons(policy: EffectiveProviderRoutingPolicy, asOf: string): string[] {
  const providerSet = (value: unknown): value is WorkerProviderId[] => Array.isArray(value)
    && value.length > 0 && value.length <= WORKER_PROVIDER_IDS.length
    && value.every(provider => typeof provider === "string"
      && WORKER_PROVIDER_IDS.includes(canonicalWorkerProviderId(provider) as WorkerProviderId))
    && new Set(value.map(canonicalWorkerProviderId)).size === value.length;
  const committed = policy.committed;
  if (!record(committed) || !providerSet(committed.enabledProviders)
    || committed.preference !== "automatic" || !Array.isArray(committed.parks) || committed.parks.length !== 0
    || committed.codexModelPreference !== null || !Number.isFinite(committed.reservePercent)
    || committed.reservePercent < 0 || committed.reservePercent > MAX_PROVIDER_POLICY_RESERVE_PERCENT
    || !providerSet(policy.enabledProviders) || !providerSet(policy.routableProviders) || !Array.isArray(policy.parks))
    return ["effective-routing-policy-snapshot-shape-invalid"];
  if (policy.provenance === "default") {
    const committed = [...policy.committed.enabledProviders].map(canonicalWorkerProviderId).sort(compareStrings);
    const enabled = [...policy.enabledProviders].map(canonicalWorkerProviderId).sort(compareStrings);
    const routable = [...policy.routableProviders].map(canonicalWorkerProviderId).sort(compareStrings);
    if (JSON.stringify(enabled) !== JSON.stringify(committed) || JSON.stringify(routable) !== JSON.stringify(committed)
      || policy.preference !== "automatic" || policy.reservePercent !== policy.committed.reservePercent
      || policy.parks.length !== 0 || policy.codexModelPreference !== undefined)
      return ["effective-routing-policy-default-snapshot-inconsistent"];
    return [];
  }
  if (policy.provenance !== "overridden") return ["effective-routing-policy-provenance-invalid"];
  if (!validAsOf(policy.writtenAt ?? "") || !validAsOf(policy.overrideExpiresAt ?? ""))
    return ["effective-routing-policy-override-timestamps-invalid"];
  const writtenAt = Date.parse(policy.writtenAt!);
  const expiresAt = Date.parse(policy.overrideExpiresAt!);
  if (writtenAt > expiresAt) return ["effective-routing-policy-override-window-invalid"];
  if (writtenAt > Date.parse(asOf)) return ["effective-routing-policy-override-written-in-future"];
  if (expiresAt <= Date.parse(asOf)) return ["effective-routing-policy-override-expired-at-census-as-of"];
  // Reuse native override validation with an injected snapshot reader: no state or clock reads.
  // This checks committed-provider subsets, park/preference consistency and native bounds.
  const resolved = resolveProviderRoutingPolicy(".", { workerProviders: {
    enabled: policy.committed.enabledProviders, reservePercent: policy.committed.reservePercent,
  } }, { now: () => Date.parse(asOf), readFile: () => canonicalJson({
    version: PROVIDER_ROUTING_POLICY_VERSION, enabledProviders: policy.enabledProviders,
    preference: policy.preference, reservePercent: policy.reservePercent, parks: policy.parks,
    codexModelPreference: policy.codexModelPreference ?? null, expiresAt: policy.overrideExpiresAt,
    writtenAt: policy.writtenAt, writerFingerprint: policy.writerFingerprint ?? "unknown",
  }) });
  const selection = (value: EffectiveProviderRoutingPolicy) => ({
    enabledProviders: [...value.enabledProviders].sort(compareStrings),
    routableProviders: [...value.routableProviders].sort(compareStrings),
    preference: value.preference, reservePercent: value.reservePercent,
    parks: [...value.parks].sort((a, b) => compareStrings(a.provider, b.provider)),
    codexModelPreference: value.codexModelPreference ?? null,
  });
  if (resolved.provenance !== "overridden" || canonicalJson(selection(resolved)) !== canonicalJson(selection(policy)))
    return ["effective-routing-policy-override-snapshot-inconsistent"];
  return [];
}

function sortedReasons(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat().filter(nonempty))].sort(compareStrings);
}

/** Stable ID over configuration only; deliberately excludes case set, as-of, and eligibility. */
export function modelCanaryConfigId(configuration: ModelCanaryConfiguration): string {
  if (!validateConfiguration(configuration)) throw new Error("canary-config-census-configuration-invalid");
  return canonicalDigest(sanitizeConfiguration(configuration));
}

/** Stable digest for a complete case corpus; expectations contribute only through this hash. */
export function modelCanaryCaseSetDigest(cases: readonly CanaryCase[]): string {
  if (cases.length === 0 || cases.length > MAX_CASES) throw new Error("canary-config-census-case-set-bound");
  const ordered = [...cases];
  if (ordered.some((item) => !record(item) || !nonempty(item.id) || item.id.length > 128
    || !nonempty(item.prompt) || item.prompt.length > 65_536
    || !["schema", "evidence", "tools", "recovery", "review", "retention"].includes(item.family)
    || !["none", "inventory", "retry", "approval"].includes(item.tools)
    || !["daily", "weekly"].includes(item.cadence)
    || !record(item.expected)))
    throw new Error("canary-config-census-case-identity-invalid");
  const expectedBudget: JsonByteBudget = { remaining: MAX_CASE_SET_BYTES, exceeded: false };
  for (const item of ordered) {
    if (!isJsonRoundTrippable(item.expected, expectedBudget))
      throw new Error(expectedBudget.exceeded ? "canary-config-census-case-set-byte-bound"
        : "canary-config-census-expected-json-invalid");
  }
  ordered.sort((a, b) => compareStrings(a.id, b.id));
  if (ordered.some((item, index) => index > 0 && item.id === ordered[index - 1]!.id))
    throw new Error("canary-config-census-case-identity-invalid");
  const canonicalCases = canonicalJson({ suiteVersion: MODEL_CANARY_VERSION, cases: ordered });
  if (Buffer.byteLength(canonicalCases, "utf8") > MAX_CASE_SET_BYTES)
    throw new Error("canary-config-census-case-set-byte-bound");
  return sha256(canonicalCases);
}

function routeMount(mounts: Mounts, route: string) {
  const match = /^routes\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(route);
  if (!match) return undefined;
  return mounts.routes[match[1]!]?.[match[2]!]?.[match[3]!];
}

function assessConfiguration(configuration: ModelCanaryConfiguration, mounts: Mounts,
  policy: EffectiveProviderRoutingPolicy, declaredModels: readonly { route: string; provider: WorkerProviderId;
    requestedModel: string; model: string | null; effort: string | null; deployment: string | null }[],
  overrideEvidence: ModelCanaryConfigOverrideEvidence | undefined, asOf: string, maxEvidenceAgeMs: number):
  { state: ConfigCensusState; reasons: string[] } {
  const excluded: string[] = [], unknown: string[] = [], informational: string[] = [];
  const mount = routeMount(mounts, configuration.route);
  if (!mount) excluded.push("route-not-declared-in-mounts");
  else {
    if (configuration.requestedModel !== mount.model) excluded.push("requested-model-mismatches-mount");
    if (mount.provider !== undefined
      && canonicalWorkerProviderId(mount.provider) !== configuration.provider) excluded.push("provider-mismatches-mount");
    const modelDeclared = declaredModels.some((row) => row.route === configuration.route
      && row.provider === configuration.provider && row.requestedModel === configuration.requestedModel
      && row.model === configuration.model && row.effort === configuration.effort
      && row.deployment === configuration.deployment);
    const changes = overrideEvidence?.changes ?? [];
    const evidenceCurrent = overrideEvidence !== undefined
      && evidenceFreshness(overrideEvidence, asOf, maxEvidenceAgeMs) === "current"
      && overrideEvidence.state === "eligible";
    if (!modelDeclared && !changes.some((change) => change.field === "model"
      && change.from === mount.model && change.to === configuration.model)) {
      unknown.push("model-override-evidence-unavailable");
    } else if (!modelDeclared && !evidenceCurrent) {
      unknown.push(overrideEvidence ? "model-override-evidence-not-current-or-eligible" : "model-override-evidence-unavailable");
    }
    if (configuration.effort !== mount.effort && !changes.some((change) => change.field === "effort"
      && change.from === mount.effort && change.to === configuration.effort)) {
      unknown.push("effort-override-evidence-unavailable");
    } else if (configuration.effort !== mount.effort && !evidenceCurrent) {
      unknown.push(overrideEvidence ? "effort-override-evidence-not-current-or-eligible" : "effort-override-evidence-unavailable");
    }
    const capability = mounts.capabilities?.claude[mount.model];
    if (configuration.provider === "cash" && capability
      && mounts.capabilities?.subscriptionOnly?.includes(capability)) excluded.push("capability-subscription-only");
  }
  if (!policy.enabledProviders.some((provider) => canonicalWorkerProviderId(provider) === configuration.provider))
    excluded.push("provider-not-enabled-by-effective-policy");
  else if (!policy.routableProviders.some((provider) => canonicalWorkerProviderId(provider) === configuration.provider))
    excluded.push("provider-not-routable-under-effective-policy");
  unknown.push(...policySnapshotReasons(policy, asOf));
  if (policy.fallback) informational.push(`effective-routing-policy-fallback-${policy.fallback.reason}`);
  if (configuration.provider === "cash" && configuration.billing !== null && configuration.billing !== "api")
    excluded.push("billing-mismatches-cash-provider");
  if (!nonempty(configuration.requestedModel)) unknown.push("requested-model-unknown");
  if (!nonempty(configuration.model)) unknown.push("concrete-model-unknown");
  if (configuration.effort === null || !nonempty(configuration.effort)) unknown.push("effort-unknown");
  if (configuration.deployment === null || !nonempty(configuration.deployment)) unknown.push("deployment-unknown");
  if (configuration.billing === null) unknown.push("billing-unknown");
  // The shared durable owner has narrower native binding limits than the private inventory.
  // Keep these configurations in the denominator, but never prepare an unclaimable slot.
  if (configuration.model.length > 128 || configuration.route.length > 128
    || (configuration.effort !== null && configuration.effort.length > 32))
    unknown.push("native-owner-pin-binding-bound");
  for (const axis of ["scaffold", "tools", "context", "cache"] as const) {
    if (!nonempty(configuration.treatment[axis])) unknown.push(`${axis}-treatment-unknown`);
  }
  return { state: excluded.length ? "excluded" : unknown.length ? "unknown" : "eligible",
    reasons: sortedReasons(excluded, unknown, informational) };
}

function combineEvidence(configuration: { state: ConfigCensusState; reasons: string[] },
  evidence: ModelCanaryConfigEvidence | undefined, asOf: string, maxEvidenceAgeMs: number,
  missingReason: string): { state: ConfigCensusState; reasons: string[] } {
  const reasons = [...configuration.reasons];
  let state = configuration.state;
  if (!evidence) {
    if (state === "eligible") state = "unknown";
    reasons.push(missingReason);
    return { state, reasons: sortedReasons(reasons) };
  }
  const freshness = evidenceFreshness(evidence, asOf, maxEvidenceAgeMs);
  if (freshness !== "current") {
    if (state === "eligible") state = "unknown";
    reasons.push(freshness === "future" ? "evidence-from-future" : "evidence-stale");
    return { state, reasons: sortedReasons(reasons) };
  }
  if (evidence.state === "excluded") state = "excluded";
  else if (evidence.state === "unknown" && state === "eligible") state = "unknown";
  reasons.push(...evidence.reasons);
  return { state, reasons: sortedReasons(reasons) };
}

function validateEvidence<T extends ModelCanaryConfigEvidence>(evidence: readonly T[], kind: string): void {
  const limit = kind === "case" ? MAX_CASE_EVIDENCE : MAX_CONFIGURATIONS;
  if (evidence.length > limit) throw new Error(`canary-config-census-${kind}-evidence-bound`);
  const seen = new Set<string>();
  for (const row of evidence) {
    if (!record(row)) throw new Error(`canary-config-census-${kind}-evidence-invalid`);
    const requiredKeys = kind === "override" ? ["configId", "state", "reasons", "asOf", "sourceDigest", "sourcePath", "changes"]
      : kind === "case" ? ["configId", "state", "reasons", "asOf", "sourceDigest", "caseId"]
        : ["configId", "state", "reasons", "asOf", "sourceDigest"];
    const optionalKeys = kind === "override" || kind === "case"
      ? ["billing"] : ["billing"];
    const key = `${row.configId}\0${"caseId" in row ? row.caseId : ""}`;
    if (!exactKeys(row, requiredKeys, optionalKeys)
      || !nonempty(row.configId) || row.configId.length > 160 || !["eligible", "excluded", "unknown"].includes(row.state)
      || !Array.isArray(row.reasons) || row.reasons.length > 32
      || !row.reasons.every((reason) => typeof reason === "string" && /^[a-z0-9][a-z0-9._:-]{0,119}$/.test(reason))
      || ("caseId" in row && (!nonempty(row.caseId) || row.caseId.length > 160))
      || (row.state !== "eligible" && row.reasons.length === 0)
      || !(row.billing === undefined || row.billing === null || row.billing === "api" || row.billing === "subscription")
      || !validAsOf(row.asOf) || !validDigest(row.sourceDigest))
      throw new Error(`canary-config-census-${kind}-evidence-invalid`);
    if (kind === "override") {
      const override: Record<string, unknown> = row;
      if (!nonempty(override.sourcePath) || !/^[A-Za-z0-9._/-]{1,160}$/.test(override.sourcePath)
        || !Array.isArray(override.changes) || override.changes.length === 0 || override.changes.length > 8
        || override.changes.some((change) => !record(change) || !exactKeys(change, ["field", "from", "to"])
          || typeof change.field !== "string" || !["model", "effort"].includes(change.field)
          || !(change.from === null || nonempty(change.from) && change.from.length <= 200)
          || !(change.to === null || nonempty(change.to) && change.to.length <= 200))
        || new Set(override.changes.map((change) => change.field)).size !== override.changes.length)
        throw new Error(`canary-config-census-${kind}-evidence-invalid`);
    }
    if (seen.has(key)) throw new Error(`canary-config-census-${kind}-evidence-duplicate`);
    seen.add(key);
  }
}

function evidenceFreshness(evidence: ModelCanaryConfigEvidence, asOf: string, maxEvidenceAgeMs: number):
  "current" | "future" | "stale" {
  const ageMs = Date.parse(asOf) - Date.parse(evidence.asOf);
  return ageMs < 0 ? "future" : ageMs > maxEvidenceAgeMs ? "stale" : "current";
}

function evidenceSnapshot(evidence: ModelCanaryConfigEvidence | undefined): ModelCanaryEvidenceSnapshot | null {
  if (!evidence) return null;
  return { state: evidence.state, reasons: [...evidence.reasons], asOf: evidence.asOf,
    sourceDigest: evidence.sourceDigest, ...(evidence.billing === undefined ? {} : { billing: evidence.billing }) };
}

/**
 * Build a deterministic census from already-parsed mounts/policy and sanitized declarations.
 * This function reads no files, environment variables, credentials, or provider availability.
 */
export function buildEffectiveConfigCensus(input: BuildEffectiveConfigCensusInput): ModelCanaryConfigCensusV1 {
  if (!validAsOf(input.asOf)) throw new Error("canary-config-census-as-of-invalid");
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? 0;
  if (!Number.isSafeInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs < 0 || maxEvidenceAgeMs > MAX_EVIDENCE_AGE_MS)
    throw new Error("canary-config-census-evidence-age-bound");
  if (!input.mounts || !input.policy || !Array.isArray(input.configurations) || !Array.isArray(input.cases))
    throw new Error("canary-config-census-input-invalid");
  if (input.configurations.length > MAX_CONFIGURATIONS
    || input.treatments.length === 0 || input.treatments.length > MAX_TREATMENTS
    || Object.keys(input.sourceDigests).length > MAX_SOURCE_DIGESTS)
    throw new Error("canary-config-census-input-bound");
  for (const [name, digest] of Object.entries(input.sourceDigests)) {
    if (!nonempty(name) || name.length > 160 || !validDigest(digest)) throw new Error("canary-config-census-source-digest-invalid");
  }
  if (!input.treatments.every(validTreatment)) throw new Error("canary-config-census-treatment-invalid");
  if (!input.configurations.every((candidate) => validateConfiguration(candidate.configuration)
    && record(candidate.sourceDigests) && Object.keys(candidate.sourceDigests).length <= 32))
    throw new Error("canary-config-census-configuration-invalid");
  validateEvidence(input.capabilityEvidence, "capability");
  validateEvidence(input.accessEvidence, "access");
  const overrideEvidence = input.configurationOverrideEvidence ?? [];
  validateEvidence(overrideEvidence, "override");
  validateEvidence(input.caseEvidence, "case");
  // Validation above guarantees unique keys. Index once so the bounded census does not rescan
  // every evidence array for each configuration/case pair.
  const capabilityEvidenceByConfig = new Map(input.capabilityEvidence.map((row) => [row.configId, row]));
  const accessEvidenceByConfig = new Map(input.accessEvidence.map((row) => [row.configId, row]));
  const overrideEvidenceByConfig = new Map(overrideEvidence.map((row) => [row.configId, row]));
  const caseEvidenceByConfig = new Map<string, Map<string, ModelCanaryCaseEvidence>>();
  for (const row of input.caseEvidence) {
    let byCaseId = caseEvidenceByConfig.get(row.configId);
    if (!byCaseId) { byCaseId = new Map(); caseEvidenceByConfig.set(row.configId, byCaseId); }
    byCaseId.set(row.caseId, row);
  }
  const sourceEvidenceCount = input.configurations.reduce((total, candidate) =>
    total + Object.keys(candidate.sourceDigests).length, 0)
    + input.capabilityEvidence.length + input.accessEvidence.length + overrideEvidence.length + input.caseEvidence.length;
  if (Object.keys(input.sourceDigests).length + sourceEvidenceCount > 150_000)
    throw new Error("canary-config-census-source-digest-bound");

  if (input.cases.length === 0 || input.cases.length > MAX_CASES)
    throw new Error("canary-config-census-case-set-bound");
  const caseDigest = modelCanaryCaseSetDigest(input.cases);
  const cases = [...input.cases].sort((a, b) => compareStrings(a.id, b.id));
  const caseIds = cases.map((item) => item.id);
  const caseSet = { suiteVersion: MODEL_CANARY_VERSION, caseDigest, caseIds };
  const rows: ModelCanaryConfigRow[] = [];
  const seenIds = new Set<string>();
  const sourceDigests = { ...input.sourceDigests };
  addDigest(sourceDigests, "derived:parsed-mounts:v1", canonicalDigest(input.mounts));
  addDigest(sourceDigests, "derived:effective-routing-policy:v1", canonicalDigest(input.policy));
  const declarations: ModelCanaryConfigDeclaration[] = [];

  const declaredModels: Array<{ route: string; requestedModel: string; requestedEffort: string; provider: WorkerProviderId;
    deployment: string | null; model: string | null; effort: string | null }> = [];
  for (const [taskType, risks] of Object.entries(input.mounts.routes).sort(([a], [b]) => compareStrings(a, b))) {
    for (const [risk, classes] of Object.entries(risks).sort(([a], [b]) => compareStrings(a, b))) {
      for (const [taskClass, mount] of Object.entries(classes).sort(([a], [b]) => compareStrings(a, b))) {
        const route = `routes.${taskType}.${risk}.${taskClass}`;
        const capability = input.mounts.capabilities?.claude[mount.model];
        const providers = mount.provider ? [mount.provider] : [...WORKER_PROVIDER_IDS];
        const canonicalProviders = [...new Set(providers.map((provider) => canonicalWorkerProviderId(provider) as WorkerProviderId))]
          .sort(compareStrings);
        for (const provider of canonicalProviders) {
          let models: string[] | undefined;
          if (provider === "claude") {
            const candidates = capability ? input.mounts.capabilities?.claudeCandidates?.[capability] : undefined;
            if (capability && candidates?.length) {
              const exactIndex = candidates.indexOf(mount.model.toLowerCase());
              models = candidates.slice(exactIndex >= 0 ? exactIndex : 0);
            }
          } else if (provider === "codex") {
            models = capability ? input.mounts.capabilities?.codex[capability]?.[mount.effort] : undefined;
          } else {
            const cash = input.mounts.capabilities?.cash ?? input.mounts.capabilities?.openweight;
            models = capability ? cash?.[capability]?.[mount.effort] : undefined;
          }
          const concreteModels = models?.length ? [...new Set(models)] : [null];
          for (const model of concreteModels) {
            declaredModels.push({ route, requestedModel: mount.model, requestedEffort: mount.effort, provider,
              deployment: model === null ? null : provider === "cash" ? model : "native-default",
              model, effort: model === null ? null : mount.effort });
            if (declaredModels.length > MAX_ROUTE_TUPLES) throw new Error("canary-config-census-route-tuple-bound");
          }
        }
      }
    }
  }

  const tableEntries = new Map<string, { provider: WorkerProviderId; model: string; effort: string | null;
    deployment: string; sourcePath: string }>();
  const addTableEntry = (entry: { provider: WorkerProviderId; model: string; effort: string | null;
    deployment: string; sourcePath: string }): void => {
    const key = canonicalJson([entry.provider, entry.model, entry.effort]);
    const previous = tableEntries.get(key);
    if (!previous || compareStrings(entry.sourcePath, previous.sourcePath) < 0) tableEntries.set(key, entry);
  };
  const ladder = input.mounts.capabilities;
  if (ladder) {
    for (const [capability, models] of Object.entries(ladder.claudeCandidates ?? {}).sort(([a], [b]) => compareStrings(a, b))) {
      for (const model of models) addTableEntry({ provider: "claude", model, effort: null,
        deployment: "native-default", sourcePath: `capabilities.claudeCandidates.${capability}` });
    }
    for (const [capability, efforts] of Object.entries(ladder.codex).sort(([a], [b]) => compareStrings(a, b))) {
      for (const [effort, models] of Object.entries(efforts).sort(([a], [b]) => compareStrings(a, b))) {
        for (const model of models) addTableEntry({ provider: "codex", model, effort,
          deployment: "native-default", sourcePath: `capabilities.codex.${capability}.${effort}` });
      }
    }
    const cash = ladder.cash ?? ladder.openweight ?? {};
    const cashPath = ladder.cash ? "capabilities.cash" : "capabilities.openweight";
    for (const [capability, efforts] of Object.entries(cash).sort(([a], [b]) => compareStrings(a, b))) {
      for (const [effort, models] of Object.entries(efforts).sort(([a], [b]) => compareStrings(a, b))) {
        for (const model of models) addTableEntry({ provider: "cash", model, effort,
          deployment: model, sourcePath: `${cashPath}.${capability}.${effort}` });
      }
    }
  }
  if (tableEntries.size > MAX_ROUTE_TUPLES) throw new Error("canary-config-census-table-entry-bound");

  const configurations = input.configurations.map((candidate) => ({ ...candidate,
    configuration: sanitizeConfiguration(candidate.configuration) }));
  const treatments = new Map<string, ModelCanaryTreatment>();
  for (const treatment of [...input.treatments, ...configurations.map((candidate) => candidate.configuration.treatment)]) {
    const normalized = structuredClone(treatment);
    treatments.set(canonicalJson(normalized), normalized);
  }
  const orderedTreatments = [...treatments.values()].sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b)));
  if (declaredModels.length * orderedTreatments.length > MAX_DECLARATIONS)
    throw new Error("canary-config-census-declaration-bound");
  const matchedConfigIds = new Set<string>();
  for (const declared of declaredModels) {
    for (const treatment of orderedTreatments) {
      const matches = configurations.filter(({ configuration }) =>
        configuration.route === declared.route && configuration.provider === declared.provider
        && configuration.requestedModel === declared.requestedModel && configuration.model === declared.model
        && configuration.effort === declared.effort && configuration.deployment === declared.deployment
        && canonicalJson(configuration.treatment) === canonicalJson(treatment));
      if (matches.length === 0) {
        const missingConfig: ModelCanaryConfiguration | undefined = declared.model === null ? undefined : {
          provider: declared.provider, deployment: declared.deployment, requestedModel: declared.requestedModel,
          model: declared.model, effort: declared.effort, route: declared.route, billing: null,
          treatment: structuredClone(treatment) };
        const missingId = missingConfig ? modelCanaryConfigId(missingConfig) : null;
        const disabled = !input.policy.enabledProviders.some((provider) => canonicalWorkerProviderId(provider) === declared.provider)
          || !input.policy.routableProviders.some((provider) => canonicalWorkerProviderId(provider) === declared.provider);
        declarations.push({ scope: "mounted-route", configId: missingId, sourcePath: declared.route, route: declared.route, requestedModel: declared.requestedModel,
          requestedEffort: declared.requestedEffort, provider: declared.provider, deployment: declared.deployment,
          model: declared.model, effort: declared.effort, billing: null, treatment: structuredClone(treatment),
          state: disabled ? "excluded" : "unknown", projection: "missing", reasons: sortedReasons(["configuration-projection-missing"],
            ...(declared.model === null ? [["concrete-model-unknown"]] : []),
            ...(declared.deployment === null ? [["deployment-unknown"]] : []),
            ...(declared.effort === null ? [["effort-unknown"]] : []), ["billing-unknown"],
            ...(disabled ? [["provider-not-routable-under-effective-policy"]] : [])) });
      } else {
        for (const match of matches) {
          const configId = modelCanaryConfigId(match.configuration);
          matchedConfigIds.add(configId);
          declarations.push({ scope: "mounted-route", configId, sourcePath: declared.route, route: match.configuration.route, requestedModel: match.configuration.requestedModel,
            requestedEffort: declared.requestedEffort, provider: match.configuration.provider,
            deployment: match.configuration.deployment, model: match.configuration.model, effort: match.configuration.effort,
            billing: match.configuration.billing, treatment: structuredClone(match.configuration.treatment),
            state: "unknown", projection: "present", reasons: [] });
        }
      }
    }
  }
  for (const candidate of configurations) {
    const configId = modelCanaryConfigId(candidate.configuration);
    if (!matchedConfigIds.has(configId)) {
      const mount = routeMount(input.mounts, candidate.configuration.route);
      declarations.push({ scope: "configuration-override", configId, sourcePath: "effective-config-overrides", ...structuredClone(candidate.configuration), requestedEffort: mount?.effort ?? null,
        state: "unknown", projection: "override", reasons: ["configuration-not-in-mounted-capability-table"] });
    }
  }
  let tableMapped = 0, tableProjected = 0, tableUnmapped = 0, tableMissing = 0;
  const nullTreatment: ModelCanaryTreatment = { scaffold: null, tools: null, context: null, cache: null };
  for (const entry of [...tableEntries.values()].sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b)))) {
    const routeMatches = declaredModels.filter((row) => row.provider === entry.provider && row.model === entry.model
      && (entry.effort === null || row.effort === entry.effort));
    const projected = configurations.some((candidate) => {
      const configuration = candidate.configuration;
      if (configuration.provider !== entry.provider || configuration.model !== entry.model
        || (entry.effort !== null && configuration.effort !== entry.effort)) return false;
      const mount = routeMount(input.mounts, configuration.route);
      if (!mount || configuration.requestedModel !== mount.model) return false;
      const configId = modelCanaryConfigId(configuration);
      const override = overrideEvidenceByConfig.get(configId);
      const overrideCurrent = override !== undefined && override.state === "eligible"
        && evidenceFreshness(override, input.asOf, maxEvidenceAgeMs) === "current";
      const modelOnRoute = declaredModels.some((route) => configuration.route === route.route
        && configuration.provider === route.provider && configuration.requestedModel === route.requestedModel
        && configuration.model === route.model && configuration.deployment === route.deployment);
      const modelOverride = overrideCurrent && override?.changes.some((change) => change.field === "model"
        && change.from === mount.model && change.to === configuration.model);
      const effortOverride = overrideCurrent && override?.changes.some((change) => change.field === "effort"
        && change.from === mount.effort && change.to === configuration.effort);
      if (!(modelOnRoute || modelOverride) || !(configuration.effort === mount.effort || effortOverride)) return false;
      // Claude's table has no effort column; its route effort needs a current explicit capability receipt.
      if (entry.effort === null) {
        const capabilityEvidence = capabilityEvidenceByConfig.get(configId);
        return capabilityEvidence !== undefined && capabilityEvidence.state === "eligible"
          && evidenceFreshness(capabilityEvidence, input.asOf, maxEvidenceAgeMs) === "current";
      }
      return true;
    });
    if (routeMatches.length > 0 || projected) tableMapped++;
    if (projected) tableProjected++;
    else if (routeMatches.length > 0) tableMissing++;
    else tableUnmapped++;
    if (!projected && routeMatches.length === 0) {
      const disabled = !input.policy.enabledProviders.some((provider) => canonicalWorkerProviderId(provider) === entry.provider)
        || !input.policy.routableProviders.some((provider) => canonicalWorkerProviderId(provider) === entry.provider);
      const reasons = ["capability-table-entry-unmapped"];
      if (entry.effort === null) reasons.push("table-does-not-declare-model-effort");
      if (disabled) reasons.push("provider-not-enabled-by-effective-policy");
      declarations.push({ scope: "capability-table", configId: null, sourcePath: entry.sourcePath, route: null, requestedModel: null,
        requestedEffort: null, provider: entry.provider, deployment: entry.deployment, model: entry.model,
        effort: entry.effort, billing: null, treatment: structuredClone(nullTreatment),
        state: disabled ? "excluded" : "unknown", projection: "unmapped", reasons: sortedReasons(reasons) });
    }
  }
  if (declarations.length > MAX_DECLARATIONS) throw new Error("canary-config-census-declaration-bound");

  for (const candidate of configurations) {
    const configuration = sanitizeConfiguration(candidate.configuration);
    const configId = modelCanaryConfigId(configuration);
    if (seenIds.has(configId)) throw new Error("canary-config-census-configuration-duplicate");
    seenIds.add(configId);
    for (const [name, digest] of Object.entries(candidate.sourceDigests)) {
      if (!nonempty(name) || name.length > 160 || !validDigest(digest)) throw new Error("canary-config-census-source-digest-invalid");
      addDigest(sourceDigests, `config:${canonicalJson([configId, name])}`, digest);
    }
    const capabilityRow = capabilityEvidenceByConfig.get(configId);
    const accessRow = accessEvidenceByConfig.get(configId);
    const overrideRow = overrideEvidenceByConfig.get(configId);
    const caseEvidenceById = caseEvidenceByConfig.get(configId);
    const base = assessConfiguration(configuration, input.mounts, input.policy, declaredModels,
      overrideRow, input.asOf, maxEvidenceAgeMs);
    const capability = combineEvidence(base, capabilityRow,
      input.asOf, maxEvidenceAgeMs, "capability-evidence-unavailable");
    const access = combineEvidence(capability, accessRow,
      input.asOf, maxEvidenceAgeMs, "access-evidence-unavailable");
    const override = overrideRow
      ? combineEvidence(access, overrideRow, input.asOf, maxEvidenceAgeMs, "configuration-override-evidence-unavailable")
      : access;
    let finalConfig = override;
    // Cash is intrinsically API-billed; other providers use the explicit configuration projection.
    // Missing billing evidence is allowed for cash, but current contradictory evidence is not.
    const expectedBilling = configuration.provider === "cash" ? "api" : configuration.billing;
    const billingEvidence = [capabilityRow, accessRow]
      .filter((evidence): evidence is ModelCanaryConfigEvidence => evidence !== undefined
        && evidenceFreshness(evidence, input.asOf, maxEvidenceAgeMs) === "current" && evidence.billing !== undefined
        && evidence.billing !== null);
    if (expectedBilling !== null) {
      const billingMatches = billingEvidence.some((evidence) => evidence.billing === expectedBilling);
      const billingConflicts = billingEvidence.some((evidence) => evidence.billing !== expectedBilling);
      if (billingConflicts) finalConfig = { state: "excluded", reasons: sortedReasons(finalConfig.reasons,
        ["billing-evidence-conflicts-with-configuration"]) };
      else if (configuration.provider !== "cash" && !billingMatches && finalConfig.state === "eligible")
        finalConfig = { state: "unknown", reasons: sortedReasons(finalConfig.reasons, ["billing-evidence-unavailable"]) };
    }
    const overrideBillingConflict = overrideRow !== undefined && expectedBilling !== null
      && overrideRow.billing !== undefined && overrideRow.billing !== null
      && evidenceFreshness(overrideRow, input.asOf, maxEvidenceAgeMs) === "current"
      && overrideRow.billing !== expectedBilling;
    if (overrideBillingConflict) finalConfig = { state: "excluded", reasons: sortedReasons(finalConfig.reasons,
      ["billing-evidence-conflicts-with-configuration"]) };
    const caseEligibility = caseIds.map((caseId) => {
      const evidence = caseEvidenceById?.get(caseId);
      let result = combineEvidence(finalConfig, evidence, input.asOf, maxEvidenceAgeMs,
        "case-eligibility-evidence-unavailable");
      const caseBillingConflict = evidence !== undefined && expectedBilling !== null
        && evidence.billing !== undefined && evidence.billing !== null
        && evidenceFreshness(evidence, input.asOf, maxEvidenceAgeMs) === "current"
        && evidence.billing !== expectedBilling;
      if (caseBillingConflict) result = { state: "excluded", reasons: sortedReasons(result.reasons,
        ["case-billing-evidence-conflicts-with-configuration"]) };
      if (evidence) addDigest(sourceDigests, `case:${canonicalJson([configId, caseId])}`, evidence.sourceDigest);
      return { caseId, state: result.state, reasons: result.reasons };
    });
    const rowEligibility = {
      state: caseEligibility.some((row) => row.state === "eligible") ? finalConfig.state
        : caseEligibility.every((row) => row.state === "excluded") ? "excluded" as const
          : finalConfig.state === "excluded" ? "excluded" as const : "unknown" as const,
      reasons: sortedReasons(finalConfig.reasons, ...caseEligibility.map((row) => row.reasons)),
    };
    if (capabilityRow) addDigest(sourceDigests, `capability:${configId}`, capabilityRow.sourceDigest);
    if (accessRow) addDigest(sourceDigests, `access:${configId}`, accessRow.sourceDigest);
    if (overrideRow) addDigest(sourceDigests, `override:${configId}`, overrideRow.sourceDigest);
    rows.push({ configId,
      pin: { model: configuration.model, route: configuration.route, effort: configuration.effort,
        suiteHash: caseDigest, billing: configuration.billing },
      configuration, eligibility: rowEligibility, caseEligibility,
      evidence: { capability: evidenceSnapshot(capabilityRow),
        access: evidenceSnapshot(accessRow),
        configurationOverride: overrideRow ? structuredClone(overrideRow) : null,
        cases: caseIds.map((caseId) => ({ caseId,
          evidence: evidenceSnapshot(caseEvidenceById?.get(caseId)) })) } });
  }
  const configIds = new Set(rows.map((row) => row.configId));
  if ([...input.capabilityEvidence, ...input.accessEvidence, ...overrideEvidence, ...input.caseEvidence]
    .some((evidence) => !configIds.has(evidence.configId)))
    throw new Error("canary-config-census-evidence-orphaned");
  if (input.caseEvidence.some((evidence) => !caseIds.includes(evidence.caseId)))
    throw new Error("canary-config-census-case-evidence-orphaned");
  const rowById = new Map(rows.map((row) => [row.configId, row]));
  for (const declaration of declarations) {
    const row = declaration.configId === null ? undefined : rowById.get(declaration.configId);
    if (row && declaration.projection !== "missing") declaration.state = row.eligibility.state;
  }
  rows.sort((a, b) => compareStrings(a.configId, b.configId));
  declarations.sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b)));
  const sortedSourceDigests = Object.fromEntries(Object.entries(sourceDigests).sort(([a], [b]) => compareStrings(a, b)));
  const routeDeclarations = declarations.filter((row) => row.scope === "mounted-route");
  const missingDeclarations = routeDeclarations.filter((row) => row.projection === "missing").length;
  const declarationCoverage = { complete: missingDeclarations === 0, declared: routeDeclarations.length,
    projected: routeDeclarations.length - missingDeclarations, missing: missingDeclarations,
    reasons: missingDeclarations ? ["declared-configurations-missing-projection"] : [] };
  const tableCoverage = { complete: tableMissing === 0 && tableUnmapped === 0, declared: tableEntries.size,
    mapped: tableMapped, projected: tableProjected, missing: tableMissing, unmapped: tableUnmapped,
    reasons: sortedReasons(tableMissing ? ["capability-table-projection-missing"] : [],
      tableUnmapped ? ["capability-table-entry-unmapped"] : []) };
  const census = { version: "model-canary-config-census-v1" as const, asOf: input.asOf,
    maxEvidenceAgeMs,
    evidenceDigest: canonicalDigest({
      capabilityEvidence: [...input.capabilityEvidence].sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b))),
      accessEvidence: [...input.accessEvidence].sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b))),
      configurationOverrideEvidence: [...overrideEvidence].sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b))),
      caseEvidence: [...input.caseEvidence].sort((a, b) => compareStrings(canonicalJson(a), canonicalJson(b))),
    }),
    sourceDigests: sortedSourceDigests, caseSet, declarations, declarationCoverage, tableCoverage, rows };
  return { ...census, digest: canonicalDigest(census) };
}
