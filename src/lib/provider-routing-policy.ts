/**
 * Live, state-resident provider-routing policy.
 *
 * The host config remains the durable authority. An override may narrow its provider set and
 * temporarily tune selection, but it cannot add an unconfigured provider, bypass capacity
 * readability/reserve, or survive beyond the bounded expiry recorded with it.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { enabledWorkerProviders, type Config, type WorkerProviderId } from "./config.js";
import {
  ProviderCapacityBlockedError,
  selectWorkerProvider,
  type ProviderCapacity,
  type CodexModelPreference,
  type ProviderSelection,
} from "./worker-provider.js";

export const PROVIDER_ROUTING_POLICY_VERSION = 2;
const LEGACY_PROVIDER_ROUTING_POLICY_VERSION = 1;
/** BACKSTOP: ordinary records are under 1 KiB; this caps hostile/corrupt state before parsing. */
export const MAX_PROVIDER_ROUTING_POLICY_BYTES = 16 * 1024;
/** PRIMARY CONTROL: every live override expires within one day even if no worker runs. */
export const MAX_PROVIDER_POLICY_OVERRIDE_MS = 24 * 60 * 60 * 1000;
/** PRIMARY CONTROL: an operator override cannot reserve more than half of either subscription. */
export const MAX_PROVIDER_POLICY_RESERVE_PERCENT = 50;

export type ProviderRoutingPreference = "automatic" | WorkerProviderId;
export type ProviderRoutingPolicyFallbackReason =
  | "unreadable"
  | "malformed"
  | "unsupported-version"
  | "expired"
  | "incompatible-with-config";

export interface ProviderPark {
  provider: WorkerProviderId;
  until: string;
}

export interface ProviderRoutingPolicyOverrideInput {
  enabledProviders: WorkerProviderId[];
  preference: ProviderRoutingPreference;
  reservePercent: number;
  parks: ProviderPark[];
  /** Omitted legacy payloads are equivalent to automatic model selection. */
  codexModelPreference?: CodexModelPreference | null;
  expiresAt: string;
}

type ValidatedProviderRoutingPolicyOverride = Omit<ProviderRoutingPolicyOverrideInput, "codexModelPreference"> & {
  codexModelPreference: CodexModelPreference | null;
};

export interface ProviderRoutingPolicyOverrideRecord extends ValidatedProviderRoutingPolicyOverride {
  version: number;
  writtenAt: string;
  writerFingerprint: string;
}

export interface CommittedProviderRoutingPolicy {
  enabledProviders: WorkerProviderId[];
  preference: "automatic";
  reservePercent: number;
  parks: [];
  codexModelPreference: null;
}

export interface EffectiveProviderRoutingPolicy {
  provenance: "default" | "overridden";
  committed: CommittedProviderRoutingPolicy;
  enabledProviders: WorkerProviderId[];
  /** Enabled providers after active parks are applied. Capacity readers consume this list. */
  routableProviders: WorkerProviderId[];
  preference: ProviderRoutingPreference;
  reservePercent: number;
  parks: ProviderPark[];
  codexModelPreference?: CodexModelPreference;
  overrideExpiresAt?: string;
  writtenAt?: string;
  writerFingerprint?: string;
  fallback?: { reason: ProviderRoutingPolicyFallbackReason };
}

export interface ProviderRoutingPolicyWriteDeps {
  config: Pick<Config, "workerProviders">;
  writerFingerprint: string;
  now?: () => number;
}

export interface ProviderRoutingPolicyReadDeps {
  now?: () => number;
  readFile?: (path: string, encoding: BufferEncoding) => string;
}

export interface ProviderRoutingPolicySelection {
  selection: ProviderSelection;
  preferenceBypass?: { provider: WorkerProviderId; reason: "unreadable" | "below-reserve" };
}

export class ProviderRoutingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRoutingPolicyError";
  }
}

export function providerRoutingPolicyOverridePath(root: string): string {
  return join(root, "state", "provider-routing-policy.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeWriterFingerprint(value: string): boolean {
  // Tailnet identity can authorize a HIGH-tier request without a bearer header. The shared
  // audit helper deliberately projects that case as this fixed sentinel; accept no other
  // free-form provenance so the state file remains safe to render and ledger.
  return value === "unknown" || /^[a-f0-9]{12}$/.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], subject: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProviderRoutingPolicyError(`${subject} has unknown or missing keys`);
  }
}

function providerId(value: unknown): WorkerProviderId | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function parseTime(value: unknown, field: string): number {
  if (typeof value !== "string") throw new ProviderRoutingPolicyError(`${field} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ProviderRoutingPolicyError(`${field} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function committedPolicy(config: Pick<Config, "workerProviders">): CommittedProviderRoutingPolicy {
  return {
    enabledProviders: [...enabledWorkerProviders(config)],
    preference: "automatic",
    reservePercent: config.workerProviders?.reservePercent ?? 5,
    parks: [],
    codexModelPreference: null,
  };
}

function defaultPolicy(
  committed: CommittedProviderRoutingPolicy,
  fallback?: ProviderRoutingPolicyFallbackReason,
): EffectiveProviderRoutingPolicy {
  return {
    provenance: "default",
    committed,
    enabledProviders: [...committed.enabledProviders],
    routableProviders: [...committed.enabledProviders],
    preference: "automatic",
    reservePercent: committed.reservePercent,
    parks: [],
    ...(fallback ? { fallback: { reason: fallback } } : {}),
  };
}

function validateInput(
  value: unknown,
  committed: CommittedProviderRoutingPolicy,
  nowMs: number,
): ValidatedProviderRoutingPolicyOverride {
  if (!isRecord(value)) throw new ProviderRoutingPolicyError("provider routing policy must be a JSON object");
  const inputKeys = Object.keys(value).sort();
  const legacyKeys = ["enabledProviders", "preference", "reservePercent", "parks", "expiresAt"].sort();
  const currentKeys = [...legacyKeys, "codexModelPreference"].sort();
  if (
    (inputKeys.length !== legacyKeys.length || inputKeys.some((key, index) => key !== legacyKeys[index])) &&
    (inputKeys.length !== currentKeys.length || inputKeys.some((key, index) => key !== currentKeys[index]))
  ) {
    throw new ProviderRoutingPolicyError("provider routing policy has unknown or missing keys");
  }

  if (!Array.isArray(value.enabledProviders) || value.enabledProviders.length === 0) {
    throw new ProviderRoutingPolicyError("enabledProviders must contain at least one provider");
  }
  const enabledProviders = value.enabledProviders.map(providerId);
  if (enabledProviders.some((provider) => !provider)) {
    throw new ProviderRoutingPolicyError('enabledProviders accepts only "claude" and "codex"');
  }
  const closedEnabled = enabledProviders as WorkerProviderId[];
  if (new Set(closedEnabled).size !== closedEnabled.length) {
    throw new ProviderRoutingPolicyError("enabledProviders contains a duplicate provider");
  }
  for (const provider of closedEnabled) {
    if (!committed.enabledProviders.includes(provider)) {
      throw new ProviderRoutingPolicyError(`${provider} is not enabled by the committed host config`);
    }
  }

  const preference = value.preference;
  if (preference !== "automatic" && preference !== "claude" && preference !== "codex") {
    throw new ProviderRoutingPolicyError('preference must be "automatic", "claude" or "codex"');
  }
  if (preference !== "automatic" && !closedEnabled.includes(preference)) {
    throw new ProviderRoutingPolicyError("preferred provider must be in enabledProviders");
  }

  const reservePercent = value.reservePercent;
  if (
    typeof reservePercent !== "number" ||
    !Number.isFinite(reservePercent) ||
    reservePercent < 0 ||
    reservePercent > MAX_PROVIDER_POLICY_RESERVE_PERCENT
  ) {
    throw new ProviderRoutingPolicyError(
      `reservePercent must be finite and between 0 and ${MAX_PROVIDER_POLICY_RESERVE_PERCENT}`,
    );
  }

  const expiresAtMs = parseTime(value.expiresAt, "expiresAt");
  if (expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_PROVIDER_POLICY_OVERRIDE_MS) {
    throw new ProviderRoutingPolicyError("expiresAt must be in the future and within the committed override bound");
  }

  if (!Array.isArray(value.parks)) throw new ProviderRoutingPolicyError("parks must be an array");
  const parks: ProviderPark[] = [];
  const parked = new Set<WorkerProviderId>();
  for (const candidate of value.parks) {
    if (!isRecord(candidate)) throw new ProviderRoutingPolicyError("each park must be a JSON object");
    exactKeys(candidate, ["provider", "until"], "provider park");
    const provider = providerId(candidate.provider);
    if (!provider || !closedEnabled.includes(provider)) {
      throw new ProviderRoutingPolicyError("parked provider must be in enabledProviders");
    }
    if (parked.has(provider)) throw new ProviderRoutingPolicyError("parks contains a duplicate provider");
    const untilMs = parseTime(candidate.until, "park until");
    if (untilMs <= nowMs || untilMs > expiresAtMs) {
      throw new ProviderRoutingPolicyError("park until must be in the future and no later than expiresAt");
    }
    parked.add(provider);
    parks.push({ provider, until: candidate.until as string });
  }
  const routableProviders = closedEnabled.filter((provider) => !parked.has(provider));
  if (routableProviders.length === 0) {
    throw new ProviderRoutingPolicyError("policy cannot park every enabled provider");
  }
  if (preference !== "automatic" && !routableProviders.includes(preference)) {
    throw new ProviderRoutingPolicyError("preferred provider cannot be actively parked");
  }

  let codexModelPreference: CodexModelPreference | null = null;
  if (value.codexModelPreference !== null && value.codexModelPreference !== undefined) {
    if (!isRecord(value.codexModelPreference)) {
      throw new ProviderRoutingPolicyError("codexModelPreference must be a JSON object or null");
    }
    exactKeys(value.codexModelPreference, ["capability", "effort", "model"], "Codex model preference");
    const { capability, effort, model } = value.codexModelPreference;
    if (capability !== "economy" && capability !== "balanced" && capability !== "frontier") {
      throw new ProviderRoutingPolicyError("Codex model preference capability is invalid");
    }
    if (typeof effort !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(effort)) {
      throw new ProviderRoutingPolicyError("Codex model preference effort is invalid");
    }
    if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}$/.test(model)) {
      throw new ProviderRoutingPolicyError("Codex model preference model is invalid");
    }
    if (!routableProviders.includes("codex")) {
      throw new ProviderRoutingPolicyError("Codex model preference requires Codex to be enabled and unparked");
    }
    codexModelPreference = { capability, effort, model };
  }

  return {
    enabledProviders: closedEnabled,
    preference,
    reservePercent,
    parks,
    codexModelPreference,
    expiresAt: value.expiresAt as string,
  };
}

function validateRecord(
  value: unknown,
  committed: CommittedProviderRoutingPolicy,
): ProviderRoutingPolicyOverrideRecord {
  if (!isRecord(value)) throw new ProviderRoutingPolicyError("provider routing policy record must be a JSON object");
  if (value.version !== PROVIDER_ROUTING_POLICY_VERSION && value.version !== LEGACY_PROVIDER_ROUTING_POLICY_VERSION) {
    throw new ProviderRoutingPolicyError("unsupported provider routing policy version");
  }
  const legacy = value.version === LEGACY_PROVIDER_ROUTING_POLICY_VERSION;
  exactKeys(
    value,
    legacy
      ? ["version", "enabledProviders", "preference", "reservePercent", "parks", "expiresAt", "writtenAt", "writerFingerprint"]
      : ["version", "enabledProviders", "preference", "reservePercent", "parks", "codexModelPreference", "expiresAt", "writtenAt", "writerFingerprint"],
    "provider routing policy record",
  );
  const writtenAtMs = parseTime(value.writtenAt, "writtenAt");
  if (typeof value.writerFingerprint !== "string" || !isSafeWriterFingerprint(value.writerFingerprint)) {
    throw new ProviderRoutingPolicyError("writerFingerprint must be a redacted token fingerprint or unknown");
  }
  const parsed = validateInput(
    {
      enabledProviders: value.enabledProviders,
      preference: value.preference,
      reservePercent: value.reservePercent,
      parks: value.parks,
      codexModelPreference: legacy ? null : value.codexModelPreference,
      expiresAt: value.expiresAt,
    },
    committed,
    writtenAtMs,
  );
  const expiresAtMs = Date.parse(parsed.expiresAt);
  if (expiresAtMs - writtenAtMs > MAX_PROVIDER_POLICY_OVERRIDE_MS) {
    throw new ProviderRoutingPolicyError("stored override exceeds the committed lifetime bound");
  }
  return {
    version: PROVIDER_ROUTING_POLICY_VERSION,
    ...parsed,
    writtenAt: value.writtenAt as string,
    writerFingerprint: value.writerFingerprint,
  };
}

/** Validate and atomically write one time-bounded override under the shared state root. */
export function writeProviderRoutingPolicyOverride(
  root: string,
  input: ProviderRoutingPolicyOverrideInput,
  deps: ProviderRoutingPolicyWriteDeps,
): ProviderRoutingPolicyOverrideRecord {
  const nowMs = (deps.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) throw new ProviderRoutingPolicyError("current time is invalid");
  if (!isSafeWriterFingerprint(deps.writerFingerprint)) {
    throw new ProviderRoutingPolicyError("writerFingerprint must be a redacted token fingerprint or unknown");
  }
  const parsed = validateInput(input, committedPolicy(deps.config), nowMs);
  const record: ProviderRoutingPolicyOverrideRecord = {
    version: PROVIDER_ROUTING_POLICY_VERSION,
    ...parsed,
    writtenAt: new Date(nowMs).toISOString(),
    writerFingerprint: deps.writerFingerprint,
  };
  const payload = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(payload) > MAX_PROVIDER_ROUTING_POLICY_BYTES) {
    throw new ProviderRoutingPolicyError("provider routing policy exceeds its fixed size bound");
  }
  const target = providerRoutingPolicyOverridePath(root);
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
      // The original write failure is the useful diagnostic; temp cleanup is best effort.
    }
    throw error;
  }
  return record;
}

/** Clear an override. False means it was already absent or concurrently cleared. */
export function clearProviderRoutingPolicyOverride(root: string): boolean {
  try {
    unlinkSync(providerRoutingPolicyOverridePath(root));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve current effective policy; every invalid state fails closed to the committed config. */
export function resolveProviderRoutingPolicy(
  root: string,
  config: Pick<Config, "workerProviders">,
  deps: ProviderRoutingPolicyReadDeps = {},
): EffectiveProviderRoutingPolicy {
  const committed = committedPolicy(config);
  const nowMs = (deps.now ?? Date.now)();
  let raw: string;
  try {
    raw = (deps.readFile ?? readFileSync)(providerRoutingPolicyOverridePath(root), "utf8");
  } catch (error) {
    // Preserve absent versus unreadable as distinct policy outcomes for the console and telemetry.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? defaultPolicy(committed)
      : defaultPolicy(committed, "unreadable");
  }
  if (Buffer.byteLength(raw) > MAX_PROVIDER_ROUTING_POLICY_BYTES) return defaultPolicy(committed, "malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A present but invalid JSON record is malformed, never equivalent to an absent override.
    return defaultPolicy(committed, "malformed");
  }
  if (
    isRecord(parsed) &&
    parsed.version !== PROVIDER_ROUTING_POLICY_VERSION &&
    parsed.version !== LEGACY_PROVIDER_ROUTING_POLICY_VERSION
  ) {
    return defaultPolicy(committed, "unsupported-version");
  }
  let record: ProviderRoutingPolicyOverrideRecord;
  try {
    record = validateRecord(parsed, committed);
  } catch (error) {
    // Preserve host-config incompatibility separately from all other malformed record failures.
    const message = error instanceof Error ? error.message : "";
    return defaultPolicy(
      committed,
      /committed host config/.test(message) ? "incompatible-with-config" : "malformed",
    );
  }
  if (nowMs >= Date.parse(record.expiresAt)) return defaultPolicy(committed, "expired");
  const activeParks = record.parks.filter((park) => nowMs < Date.parse(park.until));
  const parked = new Set(activeParks.map((park) => park.provider));
  const routableProviders = record.enabledProviders.filter((provider) => !parked.has(provider));
  if (routableProviders.length === 0) return defaultPolicy(committed, "malformed");
  const preference =
    record.preference !== "automatic" && !routableProviders.includes(record.preference)
      ? "automatic"
      : record.preference;
  return {
    provenance: "overridden",
    committed,
    enabledProviders: [...record.enabledProviders],
    routableProviders,
    preference,
    reservePercent: record.reservePercent,
    parks: activeParks,
    ...(record.codexModelPreference ? { codexModelPreference: { ...record.codexModelPreference } } : {}),
    overrideExpiresAt: record.expiresAt,
    writtenAt: record.writtenAt,
    writerFingerprint: record.writerFingerprint,
  };
}

/**
 * Prefer one eligible provider, otherwise use the existing most-headroom selector unchanged.
 * Readability/reserve are never bypassed and an all-ineligible set still throws its named error.
 */
export function selectWorkerProviderForPolicy(
  capacities: ProviderCapacity[],
  policy: EffectiveProviderRoutingPolicy,
  tieBreaker = 0,
): ProviderRoutingPolicySelection {
  const effective = capacities.filter((capacity) => policy.routableProviders.includes(capacity.provider));
  const automatic = () => selectWorkerProvider(effective, policy.reservePercent, tieBreaker);
  if (policy.preference === "automatic") return { selection: automatic() };
  const preferred = effective.find((capacity) => capacity.provider === policy.preference);
  if (preferred) {
    try {
      return { selection: selectWorkerProvider([preferred], policy.reservePercent, 0) };
    } catch (error) {
      if (!(error instanceof ProviderCapacityBlockedError)) throw error;
    }
  }
  const selection = automatic();
  const reason = !preferred || !preferred.readable || preferred.windows.length === 0 ? "unreadable" : "below-reserve";
  return { selection, preferenceBypass: { provider: policy.preference, reason } };
}
