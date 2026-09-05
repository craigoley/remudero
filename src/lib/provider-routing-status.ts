/**
 * Durable, bounded projection of the provider-routing decision most recently made by the
 * daemon. The daemon/worker is the only writer; the console only reads this file. Capacity
 * probes and provider credentials therefore never cross into the console process.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerProviderId } from "./config.js";
import type { ClaudeModelHealthRoute, ClaudeModelHealthSource, ClaudeModelHealthState } from "./claude-model-health.js";
import type {
  EffectiveProviderRoutingPolicy,
  ProviderPark,
  ProviderRoutingPolicyFallbackReason,
  ProviderRoutingPreference,
} from "./provider-routing-policy.js";
import type { ProviderCapacity, ProviderSelection } from "./worker-provider.js";

export const PROVIDER_ROUTING_STATUS_VERSION = 1;
/** BACKSTOP: field-count and string-length projection limits are the normal size controls. */
export const MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES = 16 * 1024;
const MAX_WINDOWS_PER_PROVIDER = 8;
const MAX_CODEX_MODEL_OPTIONS = 32;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+:@-]{0,95}$/;

export type ProviderRoutingUnknownReason = "absent" | "unreadable" | "malformed" | "unsupported-version";
export type ProviderRoutingFreshness = "fresh" | "stale" | "not-probed" | "unknown";

export interface ProviderRoutingWindowStatus {
  name: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ProviderRoutingProviderStatus {
  provider: WorkerProviderId;
  readable: boolean;
  windows: ProviderRoutingWindowStatus[];
  allocationWindows?: ProviderRoutingWindowStatus[];
  reason?: "capacity-unreadable" | "authentication-unavailable" | "capacity-unavailable";
  accountLabel?: string;
  model?: string;
  effort?: string;
  modelDecision?: CodexModelDecisionStatus;
}

export interface CodexModelDecisionOptionStatus {
  id: string;
  displayName?: string;
  supportedEfforts: string[];
  accountDefault: boolean;
  mapped: boolean;
  eligible: boolean;
  selected: boolean;
  windows: ProviderRoutingWindowStatus[];
  reason?: "unmapped" | "unsupported-effort" | "quota-unreadable" | "below-reserve";
}

export interface CodexModelDecisionStatus {
  requestedCapability: "economy" | "balanced" | "frontier";
  requestedEffort: string;
  mappedCandidates: string[];
  options: CodexModelDecisionOptionStatus[];
  selectedModel?: string;
  selectedEffort?: string;
  preferredModel?: string;
  preferenceBypass?: "unmapped" | "unsupported-effort" | "quota-unreadable" | "below-reserve" | "not-visible";
}

export interface ProviderRoutingSelectedStatus {
  provider: WorkerProviderId;
  tightestRemainingPercent: number;
  allocationWeight?: number;
  allocationSharePercent?: number;
  accountLabel?: string;
  model?: string;
  effort?: string;
}

export interface ProviderRoutingModelHealthStatus {
  requestedModel?: string;
  routedModel?: string;
  state: ClaudeModelHealthState;
  source: ClaudeModelHealthSource;
  eligible: boolean;
}

export interface ProviderRoutingPolicyStatus {
  provenance: "default" | "overridden";
  committed: {
    enabledProviders: WorkerProviderId[];
    preference: "automatic";
    reservePercent: number;
    parks: [];
    codexModelPreference: null;
  };
  enabledProviders: WorkerProviderId[];
  routableProviders: WorkerProviderId[];
  preference: ProviderRoutingPreference;
  reservePercent: number;
  parks: ProviderPark[];
  codexModelPreference?: { capability: "economy" | "balanced" | "frontier"; effort: string; model: string };
  overrideExpiresAt?: string;
  writtenAt?: string;
  writerFingerprint?: string;
  fallback?: { reason: ProviderRoutingPolicyFallbackReason };
}

export interface ProviderRoutingPreferenceBypass {
  provider: WorkerProviderId;
  reason: "unreadable" | "below-reserve";
}

export interface ProviderRoutingStatus {
  version: number;
  state: "unknown" | "not-probed" | "selected" | "blocked";
  freshness: ProviderRoutingFreshness;
  reason?: ProviderRoutingUnknownReason;
  enabledProviders?: WorkerProviderId[];
  reservePercent?: number;
  observedAt?: string;
  freshUntil?: string;
  providers?: ProviderRoutingProviderStatus[];
  selected?: ProviderRoutingSelectedStatus;
  blockedReason?: "no-provider-headroom";
  modelHealth?: ProviderRoutingModelHealthStatus;
  policy?: ProviderRoutingPolicyStatus;
  preferenceBypass?: ProviderRoutingPreferenceBypass;
}

interface ProviderRoutingWriteBase {
  enabledProviders: readonly WorkerProviderId[];
  reservePercent: number;
  observedAtMs: number;
  cacheValidMs: number;
  policy?: EffectiveProviderRoutingPolicy;
  modelHealth?: ClaudeModelHealthRoute;
  preferenceBypass?: ProviderRoutingPreferenceBypass;
}

export type ProviderRoutingWriteInput = ProviderRoutingWriteBase &
  (
    | { state: "not-probed" }
    | { state: "selected"; capacities: readonly ProviderCapacity[]; selection: ProviderSelection }
    | { state: "blocked"; capacities: readonly ProviderCapacity[] }
  );

export function providerRoutingStatusPath(root: string): string {
  return join(root, "state", "provider-routing-status.json");
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_LABEL.test(value) ? value : undefined;
}

function providerId(value: unknown): WorkerProviderId | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function safePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function safeAllocationWeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

function isoTime(value: unknown): string | undefined {
  let millis: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    millis = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string") {
    millis = Date.parse(value);
  } else {
    return undefined;
  }
  if (!Number.isFinite(millis)) return undefined;
  try {
    return new Date(millis).toISOString();
  } catch {
    // Invalid or out-of-range timestamps are omitted, never rewritten as the current time.
    return undefined;
  }
}

function closedUnreadableReason(detail: unknown): ProviderRoutingProviderStatus["reason"] {
  if (typeof detail !== "string") return "capacity-unreadable";
  if (/auth|credential|login|token/i.test(detail)) return "authentication-unavailable";
  if (/unavailable|request|exit|timeout|network|connect/i.test(detail)) return "capacity-unavailable";
  return "capacity-unreadable";
}

function projectModelDecision(capacity: ProviderCapacity): CodexModelDecisionStatus | undefined {
  const decision = capacity.modelDecision;
  if (!decision) return undefined;
  if (
    decision.requestedCapability !== "economy" &&
    decision.requestedCapability !== "balanced" &&
    decision.requestedCapability !== "frontier"
  ) return undefined;
  const requestedEffort = safeLabel(decision.requestedEffort);
  if (!requestedEffort) return undefined;
  const mappedCandidates = decision.mappedCandidates.slice(0, MAX_CODEX_MODEL_OPTIONS)
    .map(safeLabel).filter((value): value is string => value !== undefined);
  const options: CodexModelDecisionOptionStatus[] = [];
  for (const option of decision.options.slice(0, MAX_CODEX_MODEL_OPTIONS)) {
    const id = safeLabel(option.id);
    if (!id) continue;
    const supportedEfforts = option.supportedEfforts.slice(0, 8)
      .map(safeLabel).filter((value): value is string => value !== undefined);
    const windows: ProviderRoutingWindowStatus[] = [];
    for (const window of option.windows.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
      const name = safeLabel(window.name);
      const usedPercent = safePercent(window.usedPercent);
      if (!name || usedPercent === undefined) continue;
      const resetsAt = isoTime(window.resetsAt);
      windows.push({ name, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
    }
    options.push({
      id,
      ...(safeLabel(option.displayName) ? { displayName: safeLabel(option.displayName) } : {}),
      supportedEfforts,
      accountDefault: option.accountDefault === true,
      mapped: option.mapped === true,
      eligible: option.eligible === true,
      selected: option.selected === true,
      windows,
      ...(option.reason ? { reason: option.reason } : {}),
    });
  }
  return {
    requestedCapability: decision.requestedCapability,
    requestedEffort,
    mappedCandidates,
    options,
    ...(safeLabel(decision.selectedModel) ? { selectedModel: safeLabel(decision.selectedModel) } : {}),
    ...(safeLabel(decision.selectedEffort) ? { selectedEffort: safeLabel(decision.selectedEffort) } : {}),
    ...(safeLabel(decision.preferredModel) ? { preferredModel: safeLabel(decision.preferredModel) } : {}),
    ...(decision.preferenceBypass ? { preferenceBypass: decision.preferenceBypass } : {}),
  };
}

function projectWindows(candidates: ReadonlyArray<ProviderCapacity["windows"][number]>): ProviderRoutingWindowStatus[] {
  const windows: ProviderRoutingWindowStatus[] = [];
  for (const candidate of candidates.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
    const name = safeLabel(candidate.name);
    const usedPercent = safePercent(candidate.usedPercent);
    if (!name || usedPercent === undefined) continue;
    const resetsAt = isoTime(candidate.resetsAt);
    windows.push({ name, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

function projectCapacity(capacity: ProviderCapacity): ProviderRoutingProviderStatus | undefined {
  const provider = providerId(capacity.provider);
  if (!provider) return undefined;
  const windows = projectWindows(capacity.windows);
  const allocationWindows = capacity.allocationWindows ? projectWindows(capacity.allocationWindows) : undefined;
  const modelDecision = projectModelDecision(capacity);
  return {
    provider,
    readable: capacity.readable === true,
    windows,
    ...(allocationWindows ? { allocationWindows } : {}),
    ...(capacity.readable ? {} : { reason: closedUnreadableReason(capacity.detail) }),
    ...(safeLabel(capacity.accountLabel) ? { accountLabel: safeLabel(capacity.accountLabel) } : {}),
    ...(safeLabel(capacity.model) ? { model: safeLabel(capacity.model) } : {}),
    ...(safeLabel(capacity.effort) ? { effort: safeLabel(capacity.effort) } : {}),
    ...(modelDecision ? { modelDecision } : {}),
  };
}

function projectCapacities(capacities: readonly ProviderCapacity[]): ProviderRoutingProviderStatus[] {
  const seen = new Set<WorkerProviderId>();
  const projected: ProviderRoutingProviderStatus[] = [];
  for (const capacity of capacities) {
    const row = projectCapacity(capacity);
    if (!row || seen.has(row.provider)) continue;
    seen.add(row.provider);
    projected.push(row);
    if (seen.size === 2) break;
  }
  return projected;
}

function projectPolicy(policy: EffectiveProviderRoutingPolicy): ProviderRoutingPolicyStatus {
  return {
    provenance: policy.provenance,
    committed: {
      enabledProviders: [...policy.committed.enabledProviders],
      preference: "automatic",
      reservePercent: policy.committed.reservePercent,
      parks: [],
      codexModelPreference: null,
    },
    enabledProviders: [...policy.enabledProviders],
    routableProviders: [...policy.routableProviders],
    preference: policy.preference,
    reservePercent: policy.reservePercent,
    parks: policy.parks.map((park) => ({ ...park })),
    ...(policy.codexModelPreference ? { codexModelPreference: { ...policy.codexModelPreference } } : {}),
    ...(policy.overrideExpiresAt ? { overrideExpiresAt: policy.overrideExpiresAt } : {}),
    ...(policy.writtenAt ? { writtenAt: policy.writtenAt } : {}),
    ...(policy.writerFingerprint ? { writerFingerprint: policy.writerFingerprint } : {}),
    ...(policy.fallback ? { fallback: { ...policy.fallback } } : {}),
  };
}

function projectModelHealth(value: unknown): ProviderRoutingModelHealthStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  const source = raw.source;
  if (
    (state !== "healthy" && state !== "degraded" && state !== "unknown") ||
    (source !== "fresh" && source !== "stale" && source !== "unknown") ||
    typeof raw.eligible !== "boolean"
  ) return undefined;
  const requestedModel = raw.requestedModel === undefined ? undefined : safeLabel(raw.requestedModel);
  const routedModel = raw.routedModel === undefined ? undefined : safeLabel(raw.routedModel);
  if (raw.requestedModel !== undefined && !requestedModel) return undefined;
  if (raw.routedModel !== undefined && !routedModel) return undefined;
  return {
    ...(requestedModel ? { requestedModel } : {}),
    ...(routedModel ? { routedModel } : {}),
    state,
    source,
    eligible: raw.eligible,
  };
}

function projectWrite(input: ProviderRoutingWriteInput): ProviderRoutingStatus {
  if (!Number.isFinite(input.observedAtMs)) throw new Error("provider routing observation time is invalid");
  if (!Number.isFinite(input.cacheValidMs) || input.cacheValidMs <= 0) {
    throw new Error("provider routing freshness bound is invalid");
  }
  const observedAtMs = input.observedAtMs;
  const cacheValidMs = input.cacheValidMs;
  const enabledProviders = [...new Set(input.enabledProviders.map(providerId).filter((p): p is WorkerProviderId => p !== undefined))];
  const reservePercent = safePercent(input.reservePercent);
  if (reservePercent === undefined || reservePercent >= 100) throw new Error("provider routing reserve is invalid");
  const modelHealth = input.modelHealth ? projectModelHealth(input.modelHealth) : undefined;
  if (input.modelHealth && !modelHealth) throw new Error("provider routing model-health observation is invalid");
  const base = {
    version: PROVIDER_ROUTING_STATUS_VERSION,
    enabledProviders,
    reservePercent,
    observedAt: new Date(observedAtMs).toISOString(),
    freshUntil: new Date(observedAtMs + cacheValidMs).toISOString(),
    ...(modelHealth ? { modelHealth } : {}),
    ...(input.policy ? { policy: projectPolicy(input.policy) } : {}),
    ...(input.preferenceBypass ? { preferenceBypass: { ...input.preferenceBypass } } : {}),
  };
  if (input.state === "not-probed") {
    return { ...base, state: "not-probed", freshness: "not-probed", providers: [] };
  }
  const providers = projectCapacities(input.capacities);
  if (input.state === "blocked") {
    return { ...base, state: "blocked", freshness: "fresh", providers, blockedReason: "no-provider-headroom" };
  }
  const selectedCapacity = projectCapacity(input.selection.capacity);
  const tightestRemainingPercent = safePercent(input.selection.tightestRemainingPercent);
  if (tightestRemainingPercent === undefined) throw new Error("provider routing selection headroom is invalid");
  const hasAllocation = input.selection.allocationWeight !== undefined || input.selection.allocationSharePercent !== undefined;
  const allocationWeight = safeAllocationWeight(input.selection.allocationWeight);
  const allocationSharePercent = safePercent(input.selection.allocationSharePercent);
  if (hasAllocation && (allocationWeight === undefined || allocationSharePercent === undefined)) {
    throw new Error("provider routing selection allocation is invalid");
  }
  return {
    ...base,
    state: "selected",
    freshness: "fresh",
    providers,
    selected: {
      provider: input.selection.provider,
      tightestRemainingPercent,
      ...(allocationWeight !== undefined ? { allocationWeight, allocationSharePercent } : {}),
      ...(selectedCapacity?.accountLabel ? { accountLabel: selectedCapacity.accountLabel } : {}),
      ...(selectedCapacity?.model ? { model: selectedCapacity.model } : {}),
      ...(selectedCapacity?.effort ? { effort: selectedCapacity.effort } : {}),
    },
  };
}

/** Write one fixed, mode-0600 snapshot atomically. Throws so callers can record a bounded failure. */
export function writeProviderRoutingStatus(root: string, input: ProviderRoutingWriteInput): void {
  const target = providerRoutingStatusPath(root);
  const payload = `${JSON.stringify(projectWrite(input))}\n`;
  if (Buffer.byteLength(payload) > MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES) {
    throw new Error("provider routing snapshot exceeds its fixed size bound");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    throw error;
  }
}

function unknown(reason: ProviderRoutingUnknownReason): ProviderRoutingStatus {
  return { version: PROVIDER_ROUTING_STATUS_VERSION, state: "unknown", freshness: "unknown", reason };
}

function parseProviderList(value: unknown, allowEmpty = false): WorkerProviderId[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return undefined;
  const providers = value.map(providerId).filter((provider): provider is WorkerProviderId => provider !== undefined);
  if (providers.length !== value.length || new Set(providers).size !== providers.length) return undefined;
  return providers;
}

function parseWindows(value: unknown): ProviderRoutingWindowStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const windows: ProviderRoutingWindowStatus[] = [];
  for (const candidate of value.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const window = candidate as Record<string, unknown>;
    const name = safeLabel(window.name);
    const usedPercent = safePercent(window.usedPercent);
    if (!name || usedPercent === undefined) return undefined;
    const resetsAt = isoTime(window.resetsAt);
    windows.push({ name, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

function parseCodexPreference(value: unknown): ProviderRoutingPolicyStatus["codexModelPreference"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const capability = raw.capability;
  const effort = safeLabel(raw.effort);
  const model = safeLabel(raw.model);
  if (
    (capability !== "economy" && capability !== "balanced" && capability !== "frontier") ||
    !effort ||
    !model
  ) return undefined;
  return { capability, effort, model };
}

function parseModelDecision(value: unknown): CodexModelDecisionStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const requestedCapability = raw.requestedCapability;
  const requestedEffort = safeLabel(raw.requestedEffort);
  if (
    (requestedCapability !== "economy" && requestedCapability !== "balanced" && requestedCapability !== "frontier") ||
    !requestedEffort ||
    !Array.isArray(raw.mappedCandidates) ||
    !Array.isArray(raw.options)
  ) return undefined;
  const mappedCandidates = raw.mappedCandidates.slice(0, MAX_CODEX_MODEL_OPTIONS)
    .map(safeLabel).filter((candidate): candidate is string => candidate !== undefined);
  if (mappedCandidates.length !== Math.min(raw.mappedCandidates.length, MAX_CODEX_MODEL_OPTIONS)) return undefined;
  const options: CodexModelDecisionOptionStatus[] = [];
  for (const candidate of raw.options.slice(0, MAX_CODEX_MODEL_OPTIONS)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const option = candidate as Record<string, unknown>;
    const id = safeLabel(option.id);
    if (
      !id ||
      !Array.isArray(option.supportedEfforts) ||
      typeof option.accountDefault !== "boolean" ||
      typeof option.mapped !== "boolean" ||
      typeof option.eligible !== "boolean" ||
      typeof option.selected !== "boolean" ||
      !Array.isArray(option.windows)
    ) return undefined;
    const supportedEfforts = option.supportedEfforts.slice(0, 8)
      .map(safeLabel).filter((effort): effort is string => effort !== undefined);
    if (supportedEfforts.length !== Math.min(option.supportedEfforts.length, 8)) return undefined;
    const windows: ProviderRoutingWindowStatus[] = [];
    for (const rawWindow of option.windows.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
      if (!rawWindow || typeof rawWindow !== "object" || Array.isArray(rawWindow)) return undefined;
      const window = rawWindow as Record<string, unknown>;
      const name = safeLabel(window.name);
      const usedPercent = safePercent(window.usedPercent);
      const resetsAt = window.resetsAt === undefined ? undefined : isoTime(window.resetsAt);
      if (!name || usedPercent === undefined || (window.resetsAt !== undefined && !resetsAt)) return undefined;
      windows.push({ name, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
    }
    const reason = option.reason;
    if (
      reason !== undefined &&
      reason !== "unmapped" &&
      reason !== "unsupported-effort" &&
      reason !== "quota-unreadable" &&
      reason !== "below-reserve"
    ) return undefined;
    options.push({
      id,
      ...(safeLabel(option.displayName) ? { displayName: safeLabel(option.displayName) } : {}),
      supportedEfforts,
      accountDefault: option.accountDefault,
      mapped: option.mapped,
      eligible: option.eligible,
      selected: option.selected,
      windows,
      ...(reason ? { reason } : {}),
    });
  }
  const preferenceBypass = raw.preferenceBypass;
  if (
    preferenceBypass !== undefined &&
    preferenceBypass !== "unmapped" &&
    preferenceBypass !== "unsupported-effort" &&
    preferenceBypass !== "quota-unreadable" &&
    preferenceBypass !== "below-reserve" &&
    preferenceBypass !== "not-visible"
  ) return undefined;
  return {
    requestedCapability,
    requestedEffort,
    mappedCandidates,
    options,
    ...(safeLabel(raw.selectedModel) ? { selectedModel: safeLabel(raw.selectedModel) } : {}),
    ...(safeLabel(raw.selectedEffort) ? { selectedEffort: safeLabel(raw.selectedEffort) } : {}),
    ...(safeLabel(raw.preferredModel) ? { preferredModel: safeLabel(raw.preferredModel) } : {}),
    ...(preferenceBypass ? { preferenceBypass } : {}),
  };
}

function parsePolicy(value: unknown): ProviderRoutingPolicyStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.provenance !== "default" && raw.provenance !== "overridden") return undefined;
  if (!raw.committed || typeof raw.committed !== "object" || Array.isArray(raw.committed)) return undefined;
  const committedRaw = raw.committed as Record<string, unknown>;
  const committedProviders = parseProviderList(committedRaw.enabledProviders);
  const committedReserve = safePercent(committedRaw.reservePercent);
  if (
    !committedProviders ||
    committedRaw.preference !== "automatic" ||
    !Array.isArray(committedRaw.parks) ||
    committedRaw.parks.length !== 0 ||
    committedReserve === undefined ||
    committedReserve >= 100 ||
    (committedRaw.codexModelPreference !== undefined && committedRaw.codexModelPreference !== null)
  ) return undefined;
  const enabledProviders = parseProviderList(raw.enabledProviders);
  const routableProviders = parseProviderList(raw.routableProviders);
  const preference = raw.preference;
  const reservePercent = safePercent(raw.reservePercent);
  if (
    !enabledProviders ||
    !routableProviders ||
    (preference !== "automatic" && preference !== "claude" && preference !== "codex") ||
    reservePercent === undefined ||
    reservePercent >= 100 ||
    !Array.isArray(raw.parks)
  ) return undefined;
  const parks: ProviderPark[] = [];
  for (const candidate of raw.parks.slice(0, 2)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const park = candidate as Record<string, unknown>;
    const provider = providerId(park.provider);
    const until = isoTime(park.until);
    if (!provider || !until) return undefined;
    parks.push({ provider, until });
  }
  const overrideExpiresAt = raw.overrideExpiresAt === undefined ? undefined : isoTime(raw.overrideExpiresAt);
  const writtenAt = raw.writtenAt === undefined ? undefined : isoTime(raw.writtenAt);
  const writerFingerprint =
    typeof raw.writerFingerprint === "string" &&
    (raw.writerFingerprint === "unknown" || /^[a-f0-9]{12}$/.test(raw.writerFingerprint))
      ? raw.writerFingerprint
      : undefined;
  if (raw.overrideExpiresAt !== undefined && !overrideExpiresAt) return undefined;
  if (raw.writtenAt !== undefined && !writtenAt) return undefined;
  if (raw.writerFingerprint !== undefined && !writerFingerprint) return undefined;
  const fallbackRaw = raw.fallback;
  let fallback: ProviderRoutingPolicyStatus["fallback"];
  if (fallbackRaw !== undefined) {
    if (!fallbackRaw || typeof fallbackRaw !== "object" || Array.isArray(fallbackRaw)) return undefined;
    const reason = (fallbackRaw as Record<string, unknown>).reason;
    if (
      reason !== "unreadable" &&
      reason !== "malformed" &&
      reason !== "unsupported-version" &&
      reason !== "expired" &&
      reason !== "incompatible-with-config"
    ) return undefined;
    fallback = { reason };
  }
  const codexModelPreference = raw.codexModelPreference === undefined
    ? undefined
    : parseCodexPreference(raw.codexModelPreference);
  if (raw.codexModelPreference !== undefined && !codexModelPreference) return undefined;
  return {
    provenance: raw.provenance,
    committed: {
      enabledProviders: committedProviders,
      preference: "automatic",
      reservePercent: committedReserve,
      parks: [],
      codexModelPreference: null,
    },
    enabledProviders,
    routableProviders,
    preference,
    reservePercent,
    parks,
    ...(codexModelPreference ? { codexModelPreference } : {}),
    ...(overrideExpiresAt ? { overrideExpiresAt } : {}),
    ...(writtenAt ? { writtenAt } : {}),
    ...(writerFingerprint ? { writerFingerprint } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

function parseSnapshot(value: unknown, nowMs: number): ProviderRoutingStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== PROVIDER_ROUTING_STATUS_VERSION) return undefined;
  if (raw.state !== "not-probed" && raw.state !== "selected" && raw.state !== "blocked") return undefined;
  const reservePercent = safePercent(raw.reservePercent);
  if (!Array.isArray(raw.enabledProviders) || reservePercent === undefined || reservePercent >= 100) return undefined;
  const observedAt = isoTime(raw.observedAt);
  const freshUntil = isoTime(raw.freshUntil);
  if (!observedAt || !freshUntil) return undefined;
  const enabledProviders = raw.enabledProviders.map(providerId).filter((p): p is WorkerProviderId => p !== undefined);
  if (enabledProviders.length !== raw.enabledProviders.length) return undefined;
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];
  const providers: ProviderRoutingProviderStatus[] = [];
  for (const item of rawProviders.slice(0, 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    const provider = providerId(row.provider);
    if (!provider || typeof row.readable !== "boolean" || !Array.isArray(row.windows)) return undefined;
    const windows = parseWindows(row.windows);
    if (!windows) return undefined;
    const allocationWindows = row.allocationWindows === undefined ? undefined : parseWindows(row.allocationWindows);
    if (row.allocationWindows !== undefined && !allocationWindows) return undefined;
    const modelDecision = row.modelDecision === undefined ? undefined : parseModelDecision(row.modelDecision);
    if (row.modelDecision !== undefined && !modelDecision) return undefined;
    providers.push({
      provider,
      readable: row.readable,
      windows,
      ...(allocationWindows ? { allocationWindows } : {}),
      ...(row.reason === "capacity-unreadable" || row.reason === "authentication-unavailable" || row.reason === "capacity-unavailable"
        ? { reason: row.reason }
        : {}),
      ...(safeLabel(row.accountLabel) ? { accountLabel: safeLabel(row.accountLabel) } : {}),
      ...(safeLabel(row.model) ? { model: safeLabel(row.model) } : {}),
      ...(safeLabel(row.effort) ? { effort: safeLabel(row.effort) } : {}),
      ...(modelDecision ? { modelDecision } : {}),
    });
  }
  const freshness: ProviderRoutingFreshness =
    raw.state === "not-probed" ? "not-probed" : nowMs <= Date.parse(freshUntil) ? "fresh" : "stale";
  const base: ProviderRoutingStatus = {
    version: PROVIDER_ROUTING_STATUS_VERSION,
    state: raw.state,
    freshness,
    enabledProviders,
    reservePercent,
    observedAt,
    freshUntil,
    providers,
  };
  if (raw.modelHealth !== undefined) {
    const modelHealth = projectModelHealth(raw.modelHealth);
    if (!modelHealth) return undefined;
    base.modelHealth = modelHealth;
  }
  if (raw.policy !== undefined) {
    const policy = parsePolicy(raw.policy);
    if (!policy) return undefined;
    base.policy = policy;
  }
  if (raw.preferenceBypass !== undefined) {
    if (!raw.preferenceBypass || typeof raw.preferenceBypass !== "object" || Array.isArray(raw.preferenceBypass)) return undefined;
    const bypass = raw.preferenceBypass as Record<string, unknown>;
    const provider = providerId(bypass.provider);
    if (!provider || (bypass.reason !== "unreadable" && bypass.reason !== "below-reserve")) return undefined;
    base.preferenceBypass = { provider, reason: bypass.reason };
  }
  if (raw.state === "blocked") {
    if (raw.blockedReason !== "no-provider-headroom") return undefined;
    return { ...base, blockedReason: "no-provider-headroom" };
  }
  if (raw.state === "selected") {
    if (!raw.selected || typeof raw.selected !== "object" || Array.isArray(raw.selected)) return undefined;
    const selectedRaw = raw.selected as Record<string, unknown>;
    const provider = providerId(selectedRaw.provider);
    const tightestRemainingPercent = safePercent(selectedRaw.tightestRemainingPercent);
    if (!provider || tightestRemainingPercent === undefined) return undefined;
    const hasAllocation = selectedRaw.allocationWeight !== undefined || selectedRaw.allocationSharePercent !== undefined;
    const allocationWeight = safeAllocationWeight(selectedRaw.allocationWeight);
    const allocationSharePercent = safePercent(selectedRaw.allocationSharePercent);
    if (hasAllocation && (allocationWeight === undefined || allocationSharePercent === undefined)) return undefined;
    return {
      ...base,
      selected: {
        provider,
        tightestRemainingPercent,
        ...(allocationWeight !== undefined ? { allocationWeight, allocationSharePercent } : {}),
        ...(safeLabel(selectedRaw.accountLabel) ? { accountLabel: safeLabel(selectedRaw.accountLabel) } : {}),
        ...(safeLabel(selectedRaw.model) ? { model: safeLabel(selectedRaw.model) } : {}),
        ...(safeLabel(selectedRaw.effort) ? { effort: safeLabel(selectedRaw.effort) } : {}),
      },
    };
  }
  return base;
}

/** Read-only projection. Absence/corruption/permission failure is explicit and never fabricated as zero. */
export function readProviderRoutingStatus(
  root: string,
  deps: { now?: () => number; readFile?: (path: string, encoding: BufferEncoding) => string } = {},
): ProviderRoutingStatus {
  let raw: string;
  try {
    raw = (deps.readFile ?? readFileSync)(providerRoutingStatusPath(root), "utf8");
  } catch (error) {
    // ENOENT is absence; every other read failure is explicitly unreadable.
    return unknown((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable");
  }
  if (Buffer.byteLength(raw) > MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES) return unknown("malformed");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== PROVIDER_ROUTING_STATUS_VERSION) return unknown("unsupported-version");
    return parseSnapshot(parsed, (deps.now ?? Date.now)()) ?? unknown("malformed");
  } catch {
    // JSON/schema/clock failures are malformed, distinct from absent and unreadable state.
    return unknown("malformed");
  }
}
