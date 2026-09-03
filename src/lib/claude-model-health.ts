/**
 * Advisory Claude model-health resolver.
 *
 * The public status feed decides only which concrete Claude models are eligible. Provider
 * subscription selection remains the separate, reset-aware decision in worker.ts. An unreadable
 * advisory source never invents health and never stops the only configured Claude subscription.
 */
import { claudeModelDisplayName, type CapabilityLadder } from "./mounts.js";

export const CLAUDE_STATUS_URL = "https://status.claude.com/api/v2/incidents/unresolved.json";
/** BACKSTOP (W1-T1266): the unresolved-incidents payload is ordinarily a few KiB; this caps a
 *  hostile or malfunctioning feed before it is buffered, never a bound normal traffic nears. */
export const MAX_CLAUDE_STATUS_BYTES = 256 * 1024;
export const CLAUDE_HEALTH_FRESH_MS = 60_000;
export const CLAUDE_HEALTH_STALE_MS = 5 * 60_000;
/** BACKSTOP (W1-T1266): a healthy status-feed response returns in well under a second; this
 *  fires only once the request has already hung, never during ordinary traffic. */
export const CLAUDE_HEALTH_TIMEOUT_MS = 3_000;

export type ClaudeModelHealthSource = "fresh" | "stale" | "unknown";
export type ClaudeModelHealthState = "healthy" | "degraded" | "unknown";

export interface ClaudeModelHealthReading {
  degradedModels: string[];
  source: ClaudeModelHealthSource;
  observedAtMs?: number;
  detail?: string;
}

export interface ClaudeModelHealthRoute extends ClaudeModelHealthReading {
  requestedModel?: string;
  routedModel?: string;
  capability?: string;
  eligible: boolean;
  state: ClaudeModelHealthState;
}

interface StatusFetchDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface HealthReadDeps {
  now?: () => number;
  fetchJson?: (signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  freshMs?: number;
  staleMs?: number;
}

interface SuccessfulStatusRead {
  payload: unknown;
  observedAtMs: number;
}

let lastSuccess: SuccessfulStatusRead | undefined;
let inFlight: Promise<SuccessfulStatusRead> | undefined;

export function clearClaudeModelHealthCache(): void {
  lastSuccess = undefined;
  inFlight = undefined;
}

/** Fetch and buffer no more than the fixed public-status payload bound. */
export async function fetchBoundedStatusJson(url: string, deps: StatusFetchDeps = {}): Promise<unknown> {
  const response = await (deps.fetchImpl ?? fetch)(url, {
    headers: { accept: "application/json" },
    signal: deps.signal,
  });
  if (!response.ok) throw new Error(`status request returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CLAUDE_STATUS_BYTES) {
    throw new Error(`status response exceeds ${MAX_CLAUDE_STATUS_BYTES}-byte size bound`);
  }
  if (!response.body) throw new Error("status response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_CLAUDE_STATUS_BYTES) {
      await reader.cancel();
      throw new Error(`status response exceeds ${MAX_CLAUDE_STATUS_BYTES}-byte size bound`);
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("status response is malformed JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const INCIDENT_SCOPE_RE = /\b(?:only affected models(?: right now)? are|exhaustive list of affected models)\b/i;

function statusText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.incidents)) {
    throw new Error("status response is malformed: incidents must be an array");
  }
  const lines: string[] = [];
  for (const incident of payload.incidents) {
    if (!isRecord(incident)) throw new Error("status response is malformed: incident must be an object");
    if (!Array.isArray(incident.incident_updates)) {
      throw new Error("status response is malformed: incident_updates must be an array");
    }
    const updates: Array<{ body: string; createdAtMs?: number }> = [];
    for (const update of incident.incident_updates) {
      if (!isRecord(update) || typeof update.body !== "string") {
        throw new Error("status response is malformed: incident update body must be a string");
      }
      const createdAtMs = typeof update.created_at === "string" ? Date.parse(update.created_at) : Number.NaN;
      updates.push({ body: update.body, ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}) });
    }
    const scoped = updates
      .filter((update) => INCIDENT_SCOPE_RE.test(update.body))
      .sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0))[0];
    // A newer explicit "only affected"/"exhaustive list" replaces older scope. Progress-only
    // updates do not: without a newer scope statement, preserve the name and every update. An
    // explicit scope also supersedes a model-specific incident name, which does not get renamed
    // merely because one model recovered while the incident remains open.
    if (scoped) lines.push(scoped.body);
    else {
      if (typeof incident.name === "string") lines.push(incident.name);
      lines.push(...updates.map((update) => update.body));
    }
  }
  return lines.join("\n");
}

/** Match only configured concrete candidates; the trailing guard keeps Opus 5 distinct from 5.1. */
export function parseDegradedClaudeModels(payload: unknown, capabilities: CapabilityLadder): string[] {
  const text = statusText(payload);
  const degraded: string[] = [];
  for (const capability of Object.keys(capabilities.ladder)) {
    for (const model of capabilities.claudeCandidates?.[capability] ?? []) {
      const label = claudeModelDisplayName(model);
      if (!label) continue;
      const exactModel = new RegExp(`(?:^|[^A-Za-z0-9])${escaped(label)}(?!\\d|\\.\\d)`, "i");
      if (exactModel.test(text)) degraded.push(model);
    }
  }
  return degraded;
}

function within(age: number, bound: number): boolean {
  return age >= 0 && age < bound;
}

async function boundedFetch(deps: HealthReadDeps, now: () => number): Promise<SuccessfulStatusRead> {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? CLAUDE_HEALTH_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Claude status read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const payload = await Promise.race([
      (deps.fetchJson ?? ((signal) => fetchBoundedStatusJson(CLAUDE_STATUS_URL, { signal })))(controller.signal),
      timeout,
    ]);
    return { payload, observedAtMs: now() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One process-wide status read, fresh-cached and single-flight; failures may reuse bounded success. */
export async function readClaudeModelHealth(
  capabilities: CapabilityLadder,
  deps: HealthReadDeps = {},
): Promise<ClaudeModelHealthReading> {
  const now = deps.now ?? Date.now;
  const freshMs = deps.freshMs ?? CLAUDE_HEALTH_FRESH_MS;
  const staleMs = deps.staleMs ?? CLAUDE_HEALTH_STALE_MS;
  const cachedAge = lastSuccess ? now() - lastSuccess.observedAtMs : Number.POSITIVE_INFINITY;
  if (lastSuccess && within(cachedAge, freshMs)) {
    return {
      degradedModels: parseDegradedClaudeModels(lastSuccess.payload, capabilities),
      source: "fresh",
      observedAtMs: lastSuccess.observedAtMs,
    };
  }

  try {
    inFlight ??= boundedFetch(deps, now).finally(() => { inFlight = undefined; });
    const success = await inFlight;
    parseDegradedClaudeModels(success.payload, capabilities);
    lastSuccess = success;
    return {
      degradedModels: parseDegradedClaudeModels(success.payload, capabilities),
      source: "fresh",
      observedAtMs: success.observedAtMs,
    };
  } catch (error) {
    // Transport failure is explicit in source/detail; only a bounded prior success may substitute.
    const staleAge = lastSuccess ? now() - lastSuccess.observedAtMs : Number.POSITIVE_INFINITY;
    if (lastSuccess && within(staleAge, staleMs)) {
      return {
        degradedModels: parseDegradedClaudeModels(lastSuccess.payload, capabilities),
        source: "stale",
        observedAtMs: lastSuccess.observedAtMs,
        detail: `live status unavailable; using bounded last success: ${String((error as Error)?.message ?? error)}`,
      };
    }
    return {
      degradedModels: [],
      source: "unknown",
      detail: String((error as Error)?.message ?? error),
    };
  }
}

/** Resolve within one capability, starting at an exact pin so a pin can never be upgraded. */
export function resolveClaudeModelHealth(
  requestedModel: string | undefined,
  capabilities: CapabilityLadder | undefined,
  reading: ClaudeModelHealthReading,
): ClaudeModelHealthRoute {
  const requested = requestedModel?.toLowerCase();
  const capability = requested ? capabilities?.claude[requested] : undefined;
  const base = {
    ...reading,
    ...(requestedModel ? { requestedModel } : {}),
    ...(capability ? { capability } : {}),
  };
  if (!requested || !capability || !capabilities) {
    return { ...base, routedModel: requestedModel, eligible: true, state: "unknown" };
  }
  if (reading.source === "unknown") {
    return { ...base, routedModel: requestedModel, eligible: true, state: "unknown" };
  }
  const candidates = capabilities.claudeCandidates?.[capability] ?? [];
  const exactIndex = candidates.indexOf(requested);
  const eligibleCandidates = candidates.slice(exactIndex >= 0 ? exactIndex : 0);
  const degraded = new Set(reading.degradedModels);
  const routedModel = eligibleCandidates.find((model) => !degraded.has(model));
  if (!routedModel) {
    return {
      ...base,
      eligible: false,
      state: "degraded",
      detail: `every ${capability} Claude candidate at or below ${requestedModel} is named in an unresolved incident`,
    };
  }
  const preferred = eligibleCandidates[0];
  return {
    ...base,
    routedModel,
    eligible: true,
    state: degraded.has(preferred) ? "degraded" : "healthy",
  };
}
