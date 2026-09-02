/**
 * Durable, bounded projection of the provider-routing decision most recently made by the
 * daemon. The daemon/worker is the only writer; the console only reads this file. Capacity
 * probes and provider credentials therefore never cross into the console process.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerProviderId } from "./config.js";
import type { ProviderCapacity, ProviderSelection } from "./worker-provider.js";

export const PROVIDER_ROUTING_STATUS_VERSION = 1;
export const MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES = 16 * 1024;
const MAX_WINDOWS_PER_PROVIDER = 8;
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
  reason?: "capacity-unreadable" | "authentication-unavailable" | "capacity-unavailable";
  accountLabel?: string;
  model?: string;
  effort?: string;
}

export interface ProviderRoutingSelectedStatus {
  provider: WorkerProviderId;
  tightestRemainingPercent: number;
  accountLabel?: string;
  model?: string;
  effort?: string;
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
}

interface ProviderRoutingWriteBase {
  enabledProviders: readonly WorkerProviderId[];
  reservePercent: number;
  observedAtMs: number;
  cacheValidMs: number;
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
    return undefined;
  }
}

function closedUnreadableReason(detail: unknown): ProviderRoutingProviderStatus["reason"] {
  if (typeof detail !== "string") return "capacity-unreadable";
  if (/auth|credential|login|token/i.test(detail)) return "authentication-unavailable";
  if (/unavailable|request|exit|timeout|network|connect/i.test(detail)) return "capacity-unavailable";
  return "capacity-unreadable";
}

function projectCapacity(capacity: ProviderCapacity): ProviderRoutingProviderStatus | undefined {
  const provider = providerId(capacity.provider);
  if (!provider) return undefined;
  const windows: ProviderRoutingWindowStatus[] = [];
  for (const candidate of capacity.windows.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
    const name = safeLabel(candidate.name);
    const usedPercent = safePercent(candidate.usedPercent);
    if (!name || usedPercent === undefined) continue;
    const resetsAt = isoTime(candidate.resetsAt);
    windows.push({ name, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  }
  return {
    provider,
    readable: capacity.readable === true,
    windows,
    ...(capacity.readable ? {} : { reason: closedUnreadableReason(capacity.detail) }),
    ...(safeLabel(capacity.accountLabel) ? { accountLabel: safeLabel(capacity.accountLabel) } : {}),
    ...(safeLabel(capacity.model) ? { model: safeLabel(capacity.model) } : {}),
    ...(safeLabel(capacity.effort) ? { effort: safeLabel(capacity.effort) } : {}),
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
  const base = {
    version: PROVIDER_ROUTING_STATUS_VERSION,
    enabledProviders,
    reservePercent,
    observedAt: new Date(observedAtMs).toISOString(),
    freshUntil: new Date(observedAtMs + cacheValidMs).toISOString(),
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
  return {
    ...base,
    state: "selected",
    freshness: "fresh",
    providers,
    selected: {
      provider: input.selection.provider,
      tightestRemainingPercent,
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
    const windows: ProviderRoutingWindowStatus[] = [];
    for (const candidate of row.windows.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
      const window = candidate as Record<string, unknown>;
      const name = safeLabel(window.name);
      const usedPercent = safePercent(window.usedPercent);
      if (!name || usedPercent === undefined) return undefined;
      const resetsAt = isoTime(window.resetsAt);
      windows.push({ name, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
    }
    providers.push({
      provider,
      readable: row.readable,
      windows,
      ...(row.reason === "capacity-unreadable" || row.reason === "authentication-unavailable" || row.reason === "capacity-unavailable"
        ? { reason: row.reason }
        : {}),
      ...(safeLabel(row.accountLabel) ? { accountLabel: safeLabel(row.accountLabel) } : {}),
      ...(safeLabel(row.model) ? { model: safeLabel(row.model) } : {}),
      ...(safeLabel(row.effort) ? { effort: safeLabel(row.effort) } : {}),
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
    return {
      ...base,
      selected: {
        provider,
        tightestRemainingPercent,
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
    return unknown((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable");
  }
  if (Buffer.byteLength(raw) > MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES) return unknown("malformed");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== PROVIDER_ROUTING_STATUS_VERSION) return unknown("unsupported-version");
    return parseSnapshot(parsed, (deps.now ?? Date.now)()) ?? unknown("malformed");
  } catch {
    return unknown("malformed");
  }
}
