import { execFileSync, spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, accessSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectUsageLimitRefusal, type UsageLimitRefusal } from "./classify.js";
import type { UsageSnapshot } from "./headroom.js";
import type { Config, WorkerProviderId } from "./config.js";
import { loadMounts, mountsPath, type CapabilityLadder } from "./mounts.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { withTempDir } from "./tmp.js";
import {
  spawnDetachedGroup,
  teardownProcessGroup,
  withWorkerGroupTeardown,
  workerInstallationScope,
  workerMarkerEnv,
  type ContainedProcess,
  type ContainedSpawnOptions,
} from "./worker-containment.js";

interface CodexSpawnArgs {
  cwd: string;
  prompt: string;
  /** The validated worker policy whose PreToolUse floor is translated onto the Codex CLI. */
  settingsFile: string;
  resumeSessionId?: string;
  /**
   * W1-T2800 — THE REDIRECTED PER-SPAWN WORKER HOME, threaded EXPLICITLY rather than left to
   * `args.env` ordering. `spawnWorker` establishes it (`perRunWorkerHomeDir` +
   * `materializeWorkerHome`) before provider selection commits, so the Codex branch can no longer
   * return past the redirection the Claude path has had since W1-T18.
   *
   * WHY EXPLICIT: `codexSpawnEnv` assigned `env.HOME` first and then copied `args.env` over it, so
   * an `args.env.HOME` would HAPPEN to win. That is an implicit ordering dependency, and the
   * design forbids it becoming the mechanism — a later reorder of those two statements would
   * silently restore the leak with no test failing.
   */
  workerHome: string;
  /** W1-T2800 — `workerZdotdir(config)`, the SAME value the Claude path passes, so a directly
   *  invoked zsh cannot reach the operator's zdotdir (W1-T1C compinit contamination). */
  zdotdir?: string;
  env?: Record<string, string>;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  sandboxIntent?: "disposable-review";
  sandboxReadRoots?: string[];
  runId?: string;
  taskId?: string;
  containment?: {
    spawn?: (
      opts: ContainedSpawnOptions,
      onStderr?: (chunk: string) => void,
      onSpawnError?: (error: NodeJS.ErrnoException) => void,
    ) => ContainedProcess;
    teardown?: (pgid: number) => void;
  };
  onSpawnError?: (error: NodeJS.ErrnoException) => void;
  streamObserver?: (event: { kind: "working" | "tool-executing" | "message"; tsMs: number; text?: string }) => void;
  clockBound?: { boundMs: number; now?: () => number; pollMs?: number };
}

interface CodexWorkerResult {
  provider: "codex";
  sessionId: string;
  costUsd: number;
  numTurns: number;
  maxTurns?: number;
  text: string;
  blocks: string[];
  stderr: string;
  subtype: string;
  isError: boolean;
  apiError: boolean;
  usageRefusal?: UsageLimitRefusal;
  permissionDenials: unknown[];
  childEnvKeys: string[];
  accountLabel?: string;
  model: string;
  effort: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  modelUsage: Record<string, never>;
  compactionEvents: [];
  compactionFailures: [];
  compactionConfigured: false;
  qualitySuspect: false;
  workerDurationMs: number;
  windowConsumption?: ProviderWindowConsumption;
}

export interface ProviderCapacityWindow {
  name: string;
  usedPercent: number;
  resetsAt?: number | string;
}

export interface ProviderCapacity {
  provider: WorkerProviderId;
  readable: boolean;
  windows: ProviderCapacityWindow[];
  /**
   * Optional provider-level pressure used only for cross-subscription allocation. Concrete model
   * eligibility and before/after attribution remain scoped to `windows`.
   */
  allocationWindows?: ProviderCapacityWindow[];
  detail?: string;
  accountLabel?: string;
  /** Concrete account-visible model chosen for this capacity reading. */
  model?: string;
  /** Concrete reasoning effort supported by that model. */
  effort?: string;
  /** Bounded account-visible Codex broker decision captured by the same app-server read. */
  modelDecision?: CodexModelDecision;
  /** Manual reset readiness — count and earliest expiry only, NEVER a credit id. */
  resetCredits?: { availableCount: number; earliestExpiresAt?: number };
}

export type CodexModelTier = "economy" | "balanced" | "frontier";
export type CodexModelIneligibleReason =
  | "unmapped"
  | "unsupported-effort"
  | "quota-unreadable"
  | "below-reserve";
export type CodexModelPreferenceBypassReason = CodexModelIneligibleReason | "not-visible";

export interface CodexModelPreference {
  capability: CodexModelTier;
  effort: string;
  model: string;
}

export interface CodexModelDecisionOption {
  id: string;
  displayName?: string;
  supportedEfforts: string[];
  accountDefault: boolean;
  mapped: boolean;
  eligible: boolean;
  selected: boolean;
  windows: ProviderCapacityWindow[];
  reason?: CodexModelIneligibleReason;
}

export interface CodexModelDecision {
  requestedCapability: CodexModelTier;
  requestedEffort: string;
  mappedCandidates: string[];
  options: CodexModelDecisionOption[];
  selectedModel?: string;
  selectedEffort?: string;
  preferredModel?: string;
  preferenceBypass?: CodexModelPreferenceBypassReason;
  /** The Claude model this Codex request was routed FOR, e.g. `"claude-opus-5"` — carried here (rather than left to the
   *  caller to re-thread) so a spawn served under {@link capabilityFallbackReason} is attributable to the exact lane that
   *  silently downgraded (W1-T3097). */
  requestedModel?: string;
  /**
   * Present ONLY when `.remudero/mounts.yaml`'s capability table could not be loaded at all — see
   * {@link resolveCodexCapability}. A capability table that loaded fine and simply has no row for `requestedModel` is a
   * DIFFERENT, documented event (the "balanced" default) and leaves this field absent. Distinguishing the two means an arm
   * built from `served_model` is no longer poisoned by an artefact of a failed file read that looks like a policy decision
   * (W1-T3097).
   */
  capabilityFallbackReason?: CodexCapabilityFallbackReason;
}

export interface ProviderSelection {
  provider: WorkerProviderId;
  capacity: ProviderCapacity;
  tightestRemainingPercent: number;
  /** Squared usable headroom after reserve; present on every live selector result. */
  allocationWeight?: number;
  /** Intended share among the eligible providers at this decision point. */
  allocationSharePercent?: number;
}

export interface ProviderWindowConsumption {
  provider: WorkerProviderId;
  percentConsumed: number | null;
  windowName?: string;
  resetsAt?: number | string;
  reason?:
    | "provider-mismatch"
    | "capacity-unreadable"
    | "no-reset-stable-window"
    | "counter-regressed"
    | "overlapping-provider-work"
    | "account-mismatch";
}

export interface ProviderWindowMeasurement {
  readonly provider: WorkerProviderId;
  readonly before: ProviderCapacity;
  overlapped: boolean;
}

const activeProviderWindowMeasurements = new Map<WorkerProviderId, Set<ProviderWindowMeasurement>>();

export function clearProviderWindowMeasurements(): void {
  activeProviderWindowMeasurements.clear();
}

/** Begin a per-worker attribution interval, contaminating every same-provider peer already live. */
export function beginProviderWindowMeasurement(before: ProviderCapacity): ProviderWindowMeasurement {
  const active = activeProviderWindowMeasurements.get(before.provider) ?? new Set<ProviderWindowMeasurement>();
  for (const measurement of active) measurement.overlapped = true;
  const measurement: ProviderWindowMeasurement = {
    provider: before.provider,
    before,
    overlapped: active.size > 0,
  };
  active.add(measurement);
  activeProviderWindowMeasurements.set(before.provider, active);
  return measurement;
}

function removeProviderWindowMeasurement(measurement: ProviderWindowMeasurement): void {
  const active = activeProviderWindowMeasurements.get(measurement.provider);
  active?.delete(measurement);
  if (active?.size === 0) activeProviderWindowMeasurements.delete(measurement.provider);
}

export function abandonProviderWindowMeasurement(measurement: ProviderWindowMeasurement): void {
  removeProviderWindowMeasurement(measurement);
}

/** Finish an interval only when one worker owned that provider for the full observation. */
export function finishProviderWindowMeasurement(
  measurement: ProviderWindowMeasurement,
  after: ProviderCapacity,
): ProviderWindowConsumption {
  removeProviderWindowMeasurement(measurement);
  if (measurement.overlapped) {
    return { provider: measurement.provider, percentConsumed: null, reason: "overlapping-provider-work" };
  }
  return providerWindowConsumption(measurement.before, after);
}

/**
 * Measure one provider's largest percentage-point burn across windows whose reset identity stayed
 * stable for the whole observation. A changed/absent reset is not comparable, and a regressed
 * counter is refused rather than turned into a negative consumption credit. This function does
 * attribution only between two already-captured readings; callers must separately prove that no
 * same-provider work overlapped the observation before attaching the result to one worker.
 */
export function providerWindowConsumption(
  before: ProviderCapacity,
  after: ProviderCapacity,
): ProviderWindowConsumption {
  if (before.provider !== after.provider) {
    return { provider: before.provider, percentConsumed: null, reason: "provider-mismatch" };
  }
  // W1-T2828: refuse a CROSS-ACCOUNT subtraction.
  //
  // TRAP: what protects this today is incidental, not designed. A window is comparable only when
  // name AND resetsAt match exactly, so a mid-spawn account switch usually lands in
  // no-reset-stable-window or counter-regressed. Two accounts whose weekly windows share a reset
  // timestamp would match, and the delta between them would be attributed to one worker's spend.
  //
  // Only a KNOWN mismatch refuses. One reading without a label cannot establish that the accounts
  // differ, and refusing there would stop attributing ordinary spend on every host that has run
  // fine without a label for months.
  if (
    before.accountLabel !== undefined &&
    after.accountLabel !== undefined &&
    before.accountLabel !== after.accountLabel
  ) {
    return { provider: before.provider, percentConsumed: null, reason: "account-mismatch" };
  }
  if (!before.readable || !after.readable) {
    return { provider: before.provider, percentConsumed: null, reason: "capacity-unreadable" };
  }

  const candidates: Array<{ percentConsumed: number; windowName: string; resetsAt: number | string }> = [];
  let regressed = false;
  for (const start of before.windows) {
    if (start.resetsAt === undefined) continue;
    const end = after.windows.find(
      (window) =>
        window.name === start.name &&
        window.resetsAt !== undefined &&
        typeof window.resetsAt === typeof start.resetsAt &&
        window.resetsAt === start.resetsAt,
    );
    if (!end) continue;
    if (
      !Number.isFinite(start.usedPercent) ||
      !Number.isFinite(end.usedPercent) ||
      start.usedPercent < 0 ||
      start.usedPercent > 100 ||
      end.usedPercent < 0 ||
      end.usedPercent > 100
    ) {
      continue;
    }
    const delta = end.usedPercent - start.usedPercent;
    if (delta < 0) {
      regressed = true;
      continue;
    }
    candidates.push({ percentConsumed: delta, windowName: start.name, resetsAt: start.resetsAt });
  }
  if (regressed) return { provider: before.provider, percentConsumed: null, reason: "counter-regressed" };
  if (candidates.length === 0) {
    return { provider: before.provider, percentConsumed: null, reason: "no-reset-stable-window" };
  }
  candidates.sort((a, b) => b.percentConsumed - a.percentConsumed || a.windowName.localeCompare(b.windowName));
  return { provider: before.provider, ...candidates[0] };
}

export class ProviderCapacityBlockedError extends Error {
  readonly reasonClass = "blocked_toolchain";
  constructor(readonly capacities: ProviderCapacity[]) {
    super(
      `no configured worker subscription has readable headroom: ${capacities
        .map((c) => `${c.provider}=${c.readable ? `${tightestRemaining(c)}% remaining` : c.detail ?? "unreadable"}`)
        .join(", ")}`,
    );
    this.name = "ProviderCapacityBlockedError";
  }
}

export class CodexToolchainBlockedError extends Error {
  readonly reasonClass = "blocked_toolchain";
  constructor(message: string) {
    super(message);
    this.name = "CodexToolchainBlockedError";
  }
}

function validCapacityWindow(window: ProviderCapacityWindow): boolean {
  return Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100;
}

function providerAllocationWindows(capacity: ProviderCapacity): ProviderCapacityWindow[] {
  const projected = capacity.allocationWindows?.filter(validCapacityWindow) ?? [];
  return projected.length > 0 ? projected : capacity.windows;
}

function tightestRemaining(capacity: ProviderCapacity): number {
  const windows = providerAllocationWindows(capacity);
  if (!capacity.readable || windows.length === 0) return Number.NEGATIVE_INFINITY;
  return Math.min(...windows.map((window) => 100 - window.usedPercent));
}

const GOLDEN_RATIO_CONJUGATE = (Math.sqrt(5) - 1) / 2;

function deterministicAllocationPoint(tieBreaker: number): number {
  const index = Number.isFinite(tieBreaker) ? Math.abs(Math.trunc(tieBreaker)) : 0;
  return (index * GOLDEN_RATIO_CONJUGATE) % 1;
}

/**
 * Select across eligible subscriptions in proportion to squared usable tight-window headroom.
 * Unreadable providers and providers at the reserve boundary are excluded before weighting.
 */
export function selectWorkerProvider(
  capacities: ProviderCapacity[],
  reservePercent = 5,
  tieBreaker = 0,
): ProviderSelection {
  const ceiling = 100 - reservePercent;
  const eligible = capacities
    .filter(
      (capacity) =>
        capacity.readable &&
        capacity.windows.length > 0 &&
        capacity.windows.every(
          (window) =>
            validCapacityWindow(window) &&
            window.usedPercent < ceiling,
        ),
    )
    .map((capacity) => {
      const tightestRemainingPercent = tightestRemaining(capacity);
      return {
        provider: capacity.provider,
        capacity,
        tightestRemainingPercent,
        allocationWeight: Math.max(1, tightestRemainingPercent - reservePercent) ** 2,
      };
    })
    .sort((a, b) => b.tightestRemainingPercent - a.tightestRemainingPercent);
  if (eligible.length === 0) throw new ProviderCapacityBlockedError(capacities);
  const totalWeight = eligible.reduce((sum, item) => sum + item.allocationWeight, 0);
  const weighted = eligible.map((item) => ({
    ...item,
    allocationSharePercent: item.allocationWeight / totalWeight * 100,
  }));
  const best = eligible[0].tightestRemainingPercent;
  const tied = weighted.filter((item) => item.tightestRemainingPercent === best);
  if (tied.length === weighted.length) {
    const index = Number.isFinite(tieBreaker) ? Math.abs(Math.trunc(tieBreaker)) : 0;
    return tied[index % tied.length];
  }

  const targetWeight = deterministicAllocationPoint(tieBreaker) * totalWeight;
  let cumulativeWeight = 0;
  for (const item of weighted) {
    cumulativeWeight += item.allocationWeight;
    if (targetWeight < cumulativeWeight) return item;
  }
  return weighted[weighted.length - 1];
}

export function claudeCapacityFromUsage(
  snapshot: UsageSnapshot | undefined,
  accountLabel?: string,
): ProviderCapacity {
  if (!snapshot) return { provider: "claude", readable: false, windows: [], detail: "capacity unreadable" };
  const weeklyWindows: ProviderCapacityWindow[] = snapshot.weekly.map((window) => ({
    name: `weekly (${window.label})`,
    usedPercent: window.percentUsed,
    resetsAt: window.resetsAt,
  }));
  const validWeeklyWindows = weeklyWindows.filter(validCapacityWindow);
  return {
    provider: "claude",
    readable: true,
    // Same shape as the Codex path's own label (capacityFromBucket), so a reader comparing two
    // rows never has to know which provider produced which format.
    ...(accountLabel ? { accountLabel } : {}),
    windows: [
      { name: "session (5h)", usedPercent: snapshot.session.percentUsed, resetsAt: snapshot.session.resetsAt },
      ...weeklyWindows,
    ],
    ...(validWeeklyWindows.length > 0 ? { allocationWindows: validWeeklyWindows } : {}),
  };
}

interface CodexRateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexRateLimitBucket {
  limitId?: unknown;
  limitName?: unknown;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: unknown;
  spendControlReached?: unknown;
}

interface CodexRateLimitResult {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
  accountId?: unknown;
  /** Manual rate-limit reset grants. Read for READINESS only — never for spending. */
  rateLimitResetCredits?: CodexResetCreditsBlock | null;
}

/** The `rateLimitResetCredits` block as the app-server sends it. `credits[].id` is an actionable
 *  handle for `account/rateLimitResetCredit/consume`; this module never calls that method and
 *  {@link parseResetCredits} never carries the id out, so a leaked status file cannot become a
 *  spend. Only `expiresAt` is read from a credit. */
interface CodexResetCreditsBlock {
  availableCount?: unknown;
  credits?: Array<{ id?: unknown; status?: unknown; expiresAt?: unknown }> | null;
}

/**
 * Non-sensitive reset readiness: how many manual resets are available, and the EARLIEST expiry
 * when the detail is readable.
 *
 * THREE STATES, KEPT APART. Absent block or unreadable count => `undefined`, which the status
 * projection renders as a missing field: the operator learns nothing was measured. A readable
 * count with no usable expiry => the count alone, never a synthesised `0` or an invented date —
 * a `0` would positively claim "no reset available", which is a different and wrong fact.
 */
export function parseResetCredits(block: unknown): { availableCount: number; earliestExpiresAt?: number } | undefined {
  if (!block || typeof block !== "object") return undefined;
  const raw = block as CodexResetCreditsBlock;
  const count = raw.availableCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return undefined;
  const expiries = (Array.isArray(raw.credits) ? raw.credits : [])
    .filter((credit) => credit && typeof credit === "object")
    .map((credit) => credit.expiresAt)
    .filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at > 0);
  const earliest = expiries.length > 0 ? Math.min(...expiries) : undefined;
  return earliest === undefined ? { availableCount: count } : { availableCount: count, earliestExpiresAt: earliest };
}

export interface CodexModelInfo {
  id: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}

interface CodexModelListResult {
  data?: CodexModelInfo[];
  nextCursor?: string | null;
}

/**
 * Last-resort Codex candidates (W1-T2573), used ONLY when `.remudero/mounts.yaml`'s
 * `capabilities` axis is unavailable — the routing table failed to load, or a caller (e.g. a
 * unit test) omitted it. Real routing always resolves through {@link CapabilityLadder.codex}
 * (mounts.ts); this is a documented degenerate fallback, not the primary source of truth, so a
 * missing routing table degrades no further than it always has rather than blocking dispatch.
 */
const FALLBACK_CODEX_MODELS: Record<CodexModelTier, string[]> = {
  economy: ["gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-5.4-mini"],
  balanced: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
  frontier: ["gpt-5.6-sol", "gpt-5.5"],
};
const SAFE_CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}$/;
const SAFE_CODEX_MODEL_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+:@-]{0,95}$/;
const SAFE_CODEX_EFFORT = /^[a-z][a-z0-9-]{0,31}$/;

function safeCodexModelLabel(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODEX_MODEL_LABEL.test(value) ? value : undefined;
}

function canonicalCodexModelId(model: CodexModelInfo): string | undefined {
  return typeof model.model === "string" && SAFE_CODEX_MODEL_ID.test(model.model)
    ? model.model
    : typeof model.id === "string" && SAFE_CODEX_MODEL_ID.test(model.id)
      ? model.id
      : undefined;
}

function normalizedModelName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function isCodexModelTier(value: unknown): value is CodexModelTier {
  return value === "economy" || value === "balanced" || value === "frontier";
}

/**
 * Resolve the requested Claude model's capability (W1-T2573): a TABLE LOOKUP against
 * `.remudero/mounts.yaml`'s `capabilities.claude` map (src/lib/mounts.ts), never a substring
 * match on the model name. A model with no declared capability — or no capability data at all —
 * resolves to "balanced", the SAME degenerate default the old substring function fell through to
 * for "everything else"; here it is an explicit, documented fallback rather than the silent
 * result of an `.includes()` miss, and any model this table DOES declare (including one whose
 * name carries neither "haiku" nor "opus") resolves correctly regardless of its spelling.
 */
export function codexCapabilityForRequestedModel(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
): CodexModelTier {
  const model = requestedModel?.toLowerCase() ?? "";
  const capability = capabilities?.claude[model];
  return isCodexModelTier(capability) ? capability : "balanced";
}

/** Why {@link resolveCodexCapability} fell back to "balanced" for this request. Exactly one member today: the two OTHER
 *  ways a request can land on "balanced" — a genuinely unmapped model, or `requestedModel` itself being absent — are the
 *  documented default and carry no reason at all (W1-T3097). */
export type CodexCapabilityFallbackReason = "capability-table-unavailable";

/** Resolved Codex capability tier, paired with WHY a fallback was taken when one was. */
export interface CodexCapabilityResolution {
  tier: CodexModelTier;
  fallbackReason?: CodexCapabilityFallbackReason;
}

/**
 * THE SEAM `codexCapabilityForRequestedModel` collapses (W1-T3097): an UNREADABLE capability table
 * (`capabilities === undefined`, `.remudero/mounts.yaml` failed to load anywhere it was searched) and a genuinely UNMAPPED
 * model both resolve to the tier "balanced" there, indistinguishably. This wraps the same lookup and adds the ONE bit that
 * tells them apart — `fallbackReason` is present only for the former — while leaving `codexCapabilityForRequestedModel`
 * itself untouched (existing callers that only need the tier keep working byte-for-byte). Both cases still return a usable
 * capability; this never throws and never blocks dispatch (design point (ii), fail-soft stays fail-soft).
 */
export function resolveCodexCapability(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
): CodexCapabilityResolution {
  const tier = codexCapabilityForRequestedModel(capabilities, requestedModel);
  return capabilities === undefined ? { tier, fallbackReason: "capability-table-unavailable" } : { tier };
}

/**
 * Resolve the ordered Codex candidate models for a (capability, effort) pair — the table lookup
 * that replaces the old tier function's dropped-effort selection (W1-T2573, rationale point 2).
 * `requestedEffort` now genuinely changes which candidates are preferred: whenever the table
 * declares different rows for two efforts under the same capability, a `sonnet/high` mount and a
 * `sonnet/medium` mount resolve DIFFERENT candidate lists — they are not the same Codex request.
 * An effort the table has no row for falls back to "medium"; capability data unavailable at all
 * falls back to {@link FALLBACK_CODEX_MODELS}.
 */
export function codexCandidatesForCapability(
  capabilities: CapabilityLadder | undefined,
  tier: CodexModelTier,
  requestedEffort: string | undefined,
): string[] {
  const byEffort = capabilities?.codex[tier];
  if (!byEffort) return FALLBACK_CODEX_MODELS[tier];
  const row = (requestedEffort && byEffort[requestedEffort]) || byEffort.medium;
  return row ?? FALLBACK_CODEX_MODELS[tier];
}

function codexBucketForModel(result: CodexRateLimitResult, model: CodexModelInfo): CodexRateLimitBucket | undefined {
  const buckets = Object.values(result.rateLimitsByLimitId ?? {});
  const names = new Set([model.id, model.model, model.displayName].map(normalizedModelName).filter(Boolean));
  const named = buckets.find((bucket) => names.has(normalizedModelName(bucket.limitName)));
  return named ?? buckets.find((bucket) => bucket.limitId === "codex") ?? result.rateLimits ?? undefined;
}

function capacityFromBucket(bucket: CodexRateLimitBucket | undefined, accountLabel?: string): ProviderCapacity {
  if (!bucket) return { provider: "codex", readable: false, windows: [], detail: "rate-limit response missing" };
  const label = safeCodexModelLabel(bucket.limitName) ?? safeCodexModelLabel(bucket.limitId) ?? "codex";
  const windows: ProviderCapacityWindow[] = [];
  for (const [kind, window] of [["primary", bucket.primary], ["secondary", bucket.secondary]] as const) {
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    const duration = typeof window.windowDurationMins === "number" ? ` ${window.windowDurationMins}m` : "";
    windows.push({
      name: `${label} ${kind}${duration}`,
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === "number" || typeof window.resetsAt === "string" ? { resetsAt: window.resetsAt } : {}),
    });
  }
  if (windows.length === 0) return { provider: "codex", readable: false, windows: [], detail: "no usable rate-limit windows" };
  if (bucket.rateLimitReachedType != null || bucket.spendControlReached === true) windows.push({ name: "reached", usedPercent: 100 });
  return { provider: "codex", readable: true, windows, ...(accountLabel ? { accountLabel } : {}) };
}

function codexAllocationWindows(reading: CodexRateLimitResult, modelCapacity: ProviderCapacity): ProviderCapacityWindow[] {
  const standard = capacityFromBucket(reading.rateLimits ?? reading.rateLimitsByLimitId?.codex ?? undefined);
  const source = standard.readable ? [...standard.windows, ...modelCapacity.windows] : modelCapacity.windows;
  const seen = new Set<string>();
  return source.filter((window) => {
    const key = `${window.name}\u0000${window.usedPercent}\u0000${String(window.resetsAt ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((window) => ({ ...window }));
}

/** Map the documented app-server result without treating absent numbers as zero. */
export function codexCapacityFromRateLimits(result: unknown): ProviderCapacity {
  if (!result || typeof result !== "object") {
    return { provider: "codex", readable: false, windows: [], detail: "rate-limit response missing" };
  }
  const reading = result as CodexRateLimitResult;
  const generic = reading.rateLimits ?? reading.rateLimitsByLimitId?.codex;
  const capacity = capacityFromBucket(generic ?? undefined, typeof reading.accountId === "string" ? reading.accountId : undefined);
  // Readiness rides the SAME read that already produced the buckets — no second RPC, no consume.
  const resetCredits = parseResetCredits(reading.rateLimitResetCredits);
  return resetCredits ? { ...capacity, resetCredits } : capacity;
}

/**
 * Pick an account-visible model for the requested Remudero mount and attach only
 * that model's quota bucket. Independent model buckets must not veto each other.
 *
 * `capabilities` (W1-T2573) is the `.remudero/mounts.yaml` capability ladder — see
 * {@link codexCapabilityForRequestedModel} / {@link codexCandidatesForCapability}. It resolves
 * BOTH the capability tier (a table lookup on the Claude model name, never a substring match)
 * and, keyed also on `requestedEffort`, the ordered default candidates for that tier — so effort
 * now genuinely reaches the candidate pool instead of being dropped at the provider boundary. An
 * operator's `workerProviders.codexModels` override, when present, still wins outright per tier
 * (unchanged — it is not effort-keyed) exactly as it did before this axis existed.
 */
export function selectCodexModel(
  models: CodexModelInfo[],
  rateLimits: unknown,
  config: Config,
  requestedModel?: string,
  requestedEffort?: string,
  capabilities?: CapabilityLadder,
  policy: { preferredModel?: CodexModelPreference; reservePercent?: number } = {},
): ProviderCapacity {
  const reading = rateLimits && typeof rateLimits === "object" ? rateLimits as CodexRateLimitResult : {};
  const visible: CodexModelInfo[] = [];
  const visibleIds = new Set<string>();
  for (const model of models) {
    const id = canonicalCodexModelId(model);
    if (model.hidden || !id || visibleIds.has(id)) continue;
    visibleIds.add(id);
    visible.push(model);
    if (visible.length === 100) break;
  }
  const forced = config.workerProviders?.codexModel;
  const { tier, fallbackReason: capabilityFallbackReason } = resolveCodexCapability(capabilities, requestedModel);
  const preferred = forced
    ? [forced]
    : [...(config.workerProviders?.codexModels?.[tier] ?? codexCandidatesForCapability(capabilities, tier, requestedEffort))];
  const mappedCandidates = [...new Set(preferred)];
  const candidates = mappedCandidates
    .map((id) => visible.find((model) => model.id === id || model.model === id))
    .filter((model): model is CodexModelInfo => model !== undefined);
  const reserve = policy.reservePercent ?? config.workerProviders?.reservePercent ?? 5;
  const requestedEffortLabel = requestedEffort ?? "default";
  const mappedIds = new Set(candidates.flatMap((model) => [model.id, model.model]
    .filter((id): id is string => typeof id === "string" && SAFE_CODEX_MODEL_ID.test(id))));
  const options = visible.map((model): CodexModelDecisionOption => {
    const supportedEfforts = [...new Set((model.supportedReasoningEfforts ?? [])
      .map((entry) => entry.reasoningEffort)
      .filter((effort): effort is string => typeof effort === "string" && SAFE_CODEX_EFFORT.test(effort)))].slice(0, 8);
    const mapped = mappedIds.has(model.id) || (typeof model.model === "string" && mappedIds.has(model.model));
    const capacity = capacityFromBucket(codexBucketForModel(reading, model));
    const effortSupported = !requestedEffort || supportedEfforts.includes(requestedEffort);
    const hasHeadroom = capacity.readable && capacity.windows.length > 0 && capacity.windows.every((window) =>
      Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 && window.usedPercent < 100 - reserve);
    const reason: CodexModelIneligibleReason | undefined = !mapped
      ? "unmapped"
      : !effortSupported
        ? "unsupported-effort"
        : !capacity.readable
          ? "quota-unreadable"
          : !hasHeadroom
            ? "below-reserve"
            : undefined;
    return {
      id: canonicalCodexModelId(model)!,
      ...(safeCodexModelLabel(model.displayName) ? { displayName: safeCodexModelLabel(model.displayName) } : {}),
      supportedEfforts,
      accountDefault: model.isDefault === true,
      mapped,
      eligible: reason === undefined,
      selected: false,
      windows: capacity.windows.map((window) => ({ ...window })),
      ...(reason ? { reason } : {}),
    };
  });
  const ranked = candidates.map((model, preference) => {
    const option = options.find((candidate) => candidate.id === canonicalCodexModelId(model));
    const capacity = capacityFromBucket(codexBucketForModel(reading, model));
    return { model, capacity, option, preference, remaining: tightestRemaining(capacity) };
  }).sort((a, b) => b.remaining - a.remaining || a.preference - b.preference);
  const eligible = ranked.filter((candidate) => candidate.option?.eligible);
  const scopedPreference = policy.preferredModel &&
    policy.preferredModel.capability === tier &&
    policy.preferredModel.effort === requestedEffortLabel
      ? policy.preferredModel
      : undefined;
  let preferenceBypass: CodexModelPreferenceBypassReason | undefined;
  let selected = scopedPreference
    ? eligible.find((candidate) => candidate.option?.id === scopedPreference.model)
    : undefined;
  if (scopedPreference && !selected) {
    const preferredOption = options.find((option) => option.id === scopedPreference.model);
    preferenceBypass = preferredOption?.reason ?? "not-visible";
  }
  selected ??= eligible[0];
  const decisionBase: CodexModelDecision = {
    requestedCapability: tier,
    requestedEffort: requestedEffortLabel,
    mappedCandidates,
    options,
    ...(requestedModel ? { requestedModel } : {}),
    ...(scopedPreference ? { preferredModel: scopedPreference.model } : {}),
    ...(preferenceBypass ? { preferenceBypass } : {}),
    ...(capabilityFallbackReason ? { capabilityFallbackReason } : {}),
  };
  if (!selected) {
    // Preserve W1-T2573's fail-closed attribution contract: when mapped models are visible but
    // their quota cannot authorize dispatch, return the first ranked concrete model alongside
    // `readable:false`. The provider selector still refuses Codex (there is no proved headroom),
    // while callers that explain the capability mapping do not lose which candidate the table
    // resolved to. It is deliberately NOT marked selected in `modelDecision`: no worker can run.
    const fallback = ranked[0];
    if (fallback) {
      const fallbackEfforts = fallback.option?.supportedEfforts ?? [];
      const fallbackEffort = requestedEffort ?? fallback.model.defaultReasoningEffort ?? fallbackEfforts[0] ?? "default";
      return {
        ...fallback.capacity,
        readable: false,
        detail: `${tier} Codex models have no reserved headroom`,
        model: canonicalCodexModelId(fallback.model),
        effort: fallbackEffort,
        modelDecision: decisionBase,
      };
    }
    return {
      provider: "codex",
      readable: false,
      windows: [],
      detail: forced
        ? `configured Codex model is not available or eligible for this account: ${forced}`
        : `no account-visible Codex model is eligible for ${tier}/${requestedEffortLabel}`,
      modelDecision: decisionBase,
    };
  }
  const efforts = selected.option?.supportedEfforts ?? [];
  const effort = requestedEffort ?? selected.model.defaultReasoningEffort ?? efforts[0] ?? "default";
  const selectedModel = canonicalCodexModelId(selected.model)!;
  for (const option of options) option.selected = option.id === selectedModel;
  return {
    ...selected.capacity,
    allocationWindows: codexAllocationWindows(reading, selected.capacity),
    model: selectedModel,
    effort,
    modelDecision: {
      ...decisionBase,
      options,
      selectedModel,
      selectedEffort: effort,
    },
  };
}

/**
 * Re-read the quota bucket for the concrete model that already crossed a worker attribution
 * boundary. This is measurement, not another routing decision: a model that was eligible when
 * selected must remain attributable if its reserve or supported-effort state changes while the
 * worker is running.
 */
function selectCodexAttributionModel(
  models: CodexModelInfo[],
  rateLimits: unknown,
  selectedModel: string,
): ProviderCapacity {
  const reading = rateLimits && typeof rateLimits === "object" ? rateLimits as CodexRateLimitResult : {};
  const model = models.find((candidate) =>
    !candidate.hidden && canonicalCodexModelId(candidate) !== undefined &&
    (candidate.id === selectedModel || candidate.model === selectedModel));
  if (!model) {
    return {
      provider: "codex",
      readable: false,
      windows: [],
      detail: `selected Codex model is no longer visible to this account: ${selectedModel}`,
      model: selectedModel,
    };
  }
  return {
    ...capacityFromBucket(codexBucketForModel(reading, model)),
    model: canonicalCodexModelId(model),
    effort: model.defaultReasoningEffort ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort ?? "default",
  };
}

export interface CodexCapacityDeps {
  now?: () => number;
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  requestedModel?: string;
  requestedEffort?: string;
  /** Process environment used only for PATH resolution of an unconfigured Codex binary. */
  resolveEnv?: NodeJS.ProcessEnv;
  /** Bypass the routing cache at an attribution boundary. */
  forceRefresh?: boolean;
  /** Re-read the exact concrete model selected at the start of an attribution interval. */
  selectedModel?: string;
  /** Live model preference and reserve from the provider policy; revalidated against this read. */
  preferredModel?: CodexModelPreference;
  reservePercent?: number;
  /**
   * Injected capability ladder (W1-T2573), bypassing the `loadMounts` disk read below — for a
   * caller that already holds a validated Mounts table, and for tests. When omitted,
   * `readCodexCapacity` loads `.remudero/mounts.yaml` itself via `config.root`.
   */
  capabilities?: CapabilityLadder;
}

/**
 * Resolve the capability ladder `readCodexCapacity` routes through (W1-T2573): the caller's
 * injected `deps.capabilities` when supplied, else `.remudero/mounts.yaml`'s own `capabilities`
 * block via `config.root`. A missing/malformed routing table degrades to `undefined` — the same
 * documented fallback {@link codexCapabilityForRequestedModel} / {@link codexCandidatesForCapability}
 * already define — rather than blocking a capacity read on a routing-table hiccup.
 */
function resolveCapabilityLadder(config: Config, deps: CodexCapacityDeps): CapabilityLadder | undefined {
  if (deps.capabilities) return deps.capabilities;
  try {
    return loadMounts(mountsPath(config.root)).capabilities;
  } catch (error) {
    // Deliberate compatibility fallback: a missing/malformed optional table preserves the
    // pre-capability balanced routing path; callers already treat `undefined` as that state.
    return undefined;
  }
}

interface CodexRuntimeReading {
  rateLimits: unknown;
  models: CodexModelInfo[];
  /** Present only when a stalled primary exchange was replaced by a fresh successful hedge. */
  retryDetail?: string;
}

interface CodexRuntimeFailure extends ProviderCapacity {
  /** Internal retry classification; stripped before a capacity leaves this module. */
  failureKind: "timeout" | "terminal";
}

type CodexRuntimeResult = CodexRuntimeReading | CodexRuntimeFailure;

function codexRuntimeFailure(detail: string, failureKind: CodexRuntimeFailure["failureKind"] = "terminal"): CodexRuntimeFailure {
  return { provider: "codex", readable: false, windows: [], detail, failureKind };
}

const codexCapacityCache = new Map<string, { at: number; value: CodexRuntimeReading }>();
const codexCapacityFailureCache = new Map<string, { at: number; value: ProviderCapacity }>();
const codexCapacityInFlight = new Map<string, Promise<CodexRuntimeResult>>();
const CODEX_CAPACITY_FAILURE_BACKOFF_MAX_MS = 10_000;
const CODEX_CAPACITY_HEDGE_DELAY_MS = 6_000;

export function clearCodexCapacityCache(): void {
  codexCapacityCache.clear();
  codexCapacityFailureCache.clear();
  codexCapacityInFlight.clear();
}

function resolveCodexBin(config: Config, resolveEnv: NodeJS.ProcessEnv = process.env): string {
  const configured = config.workerProviders?.codexBin;
  let resolved = configured;
  if (!resolved) {
    try {
      resolved = execFileSync("which", ["codex"], { encoding: "utf8", env: resolveEnv }).trim();
    } catch (error) {
      throw new CodexToolchainBlockedError("Codex is enabled but no codex executable is on PATH and workerProviders.codexBin is unset");
    }
  }
  try {
    accessSync(resolved, fsConstants.X_OK);
  } catch (error) {
    throw new CodexToolchainBlockedError(`Codex executable is absent or not executable: ${resolved}`);
  }
  return resolved;
}

function codexHome(config: Config): string {
  return config.workerProviders?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function codexControlEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome(config) };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** One raw Codex control-plane exchange. It applies no caller model or provider policy. */
export async function readCodexRuntime(
  config: Config,
  bin: string,
  deps: Pick<CodexCapacityDeps, "spawn" | "timeoutMs"> & {
    signal?: AbortSignal;
    onHedgeEligibility?: (eligible: boolean) => void;
  },
): Promise<CodexRuntimeResult> {
  const spawn = deps.spawn ?? ((command, args, options) => spawnChild(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ["app-server", "--listen", "stdio://"], { env: codexControlEnv(config) });
  } catch (error) {
    // A synchronous spawn failure excludes Codex without erasing its reason.
    return codexRuntimeFailure(`app-server spawn failed: ${(error as Error).message}`);
  }

  return new Promise<CodexRuntimeResult>((resolve) => {
    let settled = false;
    let buffer = "";
    let stderr = "";
    let rateLimits: unknown;
    let models: CodexModelInfo[] | undefined;
    let initialized = false;
    let rateLimitsReceived = false;
    let modelsReceived = false;
    let malformedStdoutLines = 0;
    const finish = (result: CodexRuntimeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      resolve(result);
    };
    const onAbort = () => finish(codexRuntimeFailure("app-server hedge cancelled"));
    const unfinishedPhases = (): string[] => {
      if (!initialized) return ["initialize"];
      const pending: string[] = [];
      if (!rateLimitsReceived) pending.push("account/rateLimits/read");
      if (!modelsReceived) pending.push("model/list");
      return pending;
    };
    const timer = setTimeout(() => {
      const malformed = malformedStdoutLines > 0 ? `; malformed app-server stdout: ${malformedStdoutLines} line(s)` : "";
      finish(codexRuntimeFailure(
        `app-server timed out after ${timeoutMs}ms${malformed}; unfinished: ${unfinishedPhases().join(", ") || "response validation"}`,
        // Protocol noise is not the fleet-observed transient RPC stall and must not be retried.
        malformedStdoutLines > 0 ? "terminal" : "timeout",
      ));
    }, timeoutMs);
    if (deps.signal?.aborted) {
      onAbort();
      return;
    }
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(codexRuntimeFailure(`app-server error: ${error.message}`)));
    child.on("exit", (code) => {
      if (!settled) finish(codexRuntimeFailure(`app-server exited ${code}: ${stderr.slice(-240)}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(raw) as typeof message;
        } catch (error) {
          // Non-protocol stdout is skipped; missing RPC responses still fail closed at the timeout.
          malformedStdoutLines += 1;
          deps.onHedgeEligibility?.(false);
          continue;
        }
        if (message.id === 1) {
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2, params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "model/list", id: 3, params: { limit: 100, includeHidden: false } })}\n`);
        } else if (message.id === 2) {
          rateLimitsReceived = true;
          if (message.error) {
            finish(codexRuntimeFailure(message.error.message ?? "rate-limit RPC error"));
          } else {
            rateLimits = message.result;
            if (modelsReceived) finish({ rateLimits, models: models ?? [] });
          }
        } else if (message.id === 3) {
          modelsReceived = true;
          if (message.error) {
            finish(codexRuntimeFailure(message.error.message ?? "model-list RPC error"));
          } else {
            const result = message.result as CodexModelListResult | undefined;
            if (result?.nextCursor) {
              finish(codexRuntimeFailure("model/list exceeded the supported 100-model page"));
            } else {
              models = Array.isArray(result?.data) ? result.data : [];
              if (rateLimitsReceived) finish({ rateLimits, models });
            }
          }
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "remudero", title: "Remudero", version: "0.1.0" } } })}\n`,
    );
  });
}

function codexCapacityHedgeDelay(timeoutMs: number): number {
  return Math.min(CODEX_CAPACITY_HEDGE_DELAY_MS, Math.max(1, Math.floor(timeoutMs * 0.6)));
}

/**
 * Recover the observed clean app-server stall without waiting through two serial timeout bounds.
 * The hedge is inside the raw exchange, so ordinary single-flight callers still share one attempt
 * pair and a successful result is always freshly read from the winning child.
 */
async function readCodexRuntimeWithTimeoutHedge(
  config: Config,
  bin: string,
  deps: Pick<CodexCapacityDeps, "spawn" | "timeoutMs">,
): Promise<CodexRuntimeResult> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const hedgeDelayMs = codexCapacityHedgeDelay(timeoutMs);
  // The primary installs its timeout while it constructs the app-server exchange. Schedule the
  // hedge from before that setup, not after it returns: synchronous setup work (notably coverage
  // instrumentation) must not consume the hedge's entire head start and let the primary timeout
  // settle first.
  const primaryStartedAt = Date.now();
  const primaryAbort = new AbortController();
  let primaryHedgeEligible = true;
  const primary = readCodexRuntime(config, bin, {
    ...deps,
    signal: primaryAbort.signal,
    onHedgeEligibility: (eligible) => { primaryHedgeEligible = eligible; },
  });

  return new Promise<CodexRuntimeResult>((resolve) => {
    let settled = false;
    let hedgeStarted = false;
    let primaryResult: CodexRuntimeResult | undefined;
    let hedgeResult: CodexRuntimeResult | undefined;
    let hedgeAbort: AbortController | undefined;
    let hedgeTimer: NodeJS.Timeout | undefined;

    const finish = (result: CodexRuntimeResult) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      resolve(result);
    };
    const failures = (): CodexRuntimeFailure => {
      const primaryFailure = primaryResult as CodexRuntimeFailure;
      const hedgeFailure = hedgeResult as CodexRuntimeFailure;
      return {
        ...hedgeFailure,
        detail:
          `app-server capacity read failed after hedge; primary: ${primaryFailure.detail ?? "failed"}; ` +
          `hedge: ${hedgeFailure.detail ?? "failed"}`,
      };
    };
    const maybeFinishFailure = () => {
      if (!primaryResult) return;
      if (!hedgeStarted) {
        finish(primaryResult);
        return;
      }
      if (hedgeResult) finish(failures());
    };
    const observePrimary = (result: CodexRuntimeResult) => {
      primaryResult = result;
      if (!("provider" in result)) {
        hedgeAbort?.abort();
        finish(result);
        return;
      }
      maybeFinishFailure();
    };
    const observeHedge = (result: CodexRuntimeResult) => {
      hedgeResult = result;
      if (!("provider" in result)) {
        const primaryDetail = primaryResult && "provider" in primaryResult
          ? primaryResult.detail ?? "failed"
          : "still pending";
        primaryAbort.abort();
        finish({
          ...result,
          retryDetail: `app-server recovered by hedge after ${codexCapacityHedgeDelay(timeoutMs)}ms; primary: ${primaryDetail}`,
        });
        return;
      }
      maybeFinishFailure();
    };

    const startHedge = () => {
      if (settled || primaryResult || !primaryHedgeEligible) return;
      hedgeStarted = true;
      hedgeAbort = new AbortController();
      readCodexRuntime(config, bin, { ...deps, signal: hedgeAbort.signal }).then(observeHedge);
    };

    primary.then(observePrimary);
    const remainingHedgeDelayMs = hedgeDelayMs - (Date.now() - primaryStartedAt);
    if (remainingHedgeDelayMs <= 0) {
      // Let an already-settled primary publish its result first; otherwise start the hedge before
      // the overdue primary timeout gets a timer turn.
      queueMicrotask(startHedge);
    } else {
      hedgeTimer = setTimeout(startHedge, remainingHedgeDelayMs);
    }
  });
}

function selectCodexRuntime(
  value: CodexRuntimeReading,
  config: Config,
  deps: CodexCapacityDeps,
  capabilities: CapabilityLadder | undefined,
): ProviderCapacity {
  const selected = deps.selectedModel
    ? selectCodexAttributionModel(value.models, value.rateLimits, deps.selectedModel)
    : selectCodexModel(value.models, value.rateLimits, config, deps.requestedModel, deps.requestedEffort, capabilities, {
      preferredModel: deps.preferredModel,
      reservePercent: deps.reservePercent,
    });
  if (!value.retryDetail) return selected;
  return {
    ...selected,
    detail: selected.detail ? `${value.retryDetail}; ${selected.detail}` : value.retryDetail,
  };
}

function backedOffCodexFailure(value: ProviderCapacity, ageMs: number, backoffMs: number): ProviderCapacity {
  const remainingMs = Math.max(0, backoffMs - ageMs);
  return {
    ...value,
    windows: [],
    detail: `${value.detail ?? "Codex capacity read failed"}; failure backoff ${ageMs}ms old, retry in ${remainingMs}ms`,
  };
}

/** Read account-visible models and their subscription buckets through one app-server session. */
export async function readCodexCapacity(config: Config, deps: CodexCapacityDeps = {}): Promise<ProviderCapacity> {
  let bin: string;
  try {
    bin = resolveCodexBin(config, deps.resolveEnv);
  } catch (error) {
    // Toolchain absence is a named unreadable capacity, so routing can still use Claude.
    return { provider: "codex", readable: false, windows: [], detail: (error as Error).message };
  }
  const capabilities = resolveCapabilityLadder(config, deps);
  const now = deps.now ?? Date.now;
  const cacheKey = `${bin}\0${codexHome(config)}`;
  const cacheMs = config.workerProviders?.capacityCacheMs ?? 60_000;
  const failureBackoffMs = Math.min(CODEX_CAPACITY_FAILURE_BACKOFF_MAX_MS, cacheMs);
  if (!deps.forceRefresh) {
    const cached = codexCapacityCache.get(cacheKey);
    if (cached && now() - cached.at < cacheMs) return selectCodexRuntime(cached.value, config, deps, capabilities);
    const failed = codexCapacityFailureCache.get(cacheKey);
    if (failed) {
      const ageMs = now() - failed.at;
      if (ageMs < failureBackoffMs) return backedOffCodexFailure(failed.value, ageMs, failureBackoffMs);
      codexCapacityFailureCache.delete(cacheKey);
    }
  }

  let exchange: Promise<CodexRuntimeResult>;
  if (!deps.forceRefresh) {
    const active = codexCapacityInFlight.get(cacheKey);
    if (active) {
      exchange = active;
    } else {
      exchange = readCodexRuntimeWithTimeoutHedge(config, bin, deps);
      codexCapacityInFlight.set(cacheKey, exchange);
    }
  } else {
    exchange = readCodexRuntimeWithTimeoutHedge(config, bin, deps);
  }

  let value: CodexRuntimeResult;
  try {
    value = await exchange;
  } finally {
    if (!deps.forceRefresh && codexCapacityInFlight.get(cacheKey) === exchange) {
      codexCapacityInFlight.delete(cacheKey);
    }
  }
  if ("provider" in value) {
    const { failureKind: _failureKind, ...capacity } = value;
    codexCapacityCache.delete(cacheKey);
    if (!deps.forceRefresh) codexCapacityFailureCache.set(cacheKey, { at: now(), value: capacity });
    return capacity;
  }
  codexCapacityCache.set(cacheKey, { at: now(), value });
  codexCapacityFailureCache.delete(cacheKey);
  return selectCodexRuntime(value, config, deps, capabilities);
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  item?: { type?: string; text?: string; command?: string; aggregated_output?: string };
}

export interface ParsedCodexEvents {
  sessionId: string;
  text: string;
  blocks: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  numTurns: number;
  isError: boolean;
  subtype: string;
  errors: string[];
  usageRefusal?: UsageLimitRefusal;
}

/** Parse Codex exec JSONL into the existing provider-neutral worker envelope. */
export function parseCodexJsonl(raw: string, nowMs = Date.now()): ParsedCodexEvents {
  let sessionId = "";
  const blocks: string[] = [];
  const errors: string[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let numTurns = 0;
  let usageRefusal: UsageLimitRefusal | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch (error) {
      // Preserve malformed output in the returned error verdict instead of treating it as absence.
      errors.push(`unparseable Codex event: ${line.slice(0, 160)}`);
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    if (event.type === "turn.started") numTurns += 1;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      blocks.push(event.item.text);
    }
    if (event.type === "turn.completed" && event.usage) {
      input += event.usage.input_tokens ?? 0;
      output += event.usage.output_tokens ?? 0;
      cacheRead += event.usage.cached_input_tokens ?? 0;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = event.error?.message ?? event.type;
      errors.push(message);
      // Codex 0.152.0 preserves its structured UsageLimitExceeded classification inside app-server,
      // but `codex exec --json` intentionally projects only the terminal message. Normalize at this
      // adapter boundary while the text is known to be provider error evidence; never scan agent
      // output, which may discuss usage limits as part of the task.
      usageRefusal ??= detectUsageLimitRefusal(message, nowMs);
    }
  }
  return {
    sessionId,
    text: blocks.at(-1) ?? "",
    blocks,
    tokens: { input, output, cacheRead, cacheCreation: 0 },
    numTurns,
    isError: errors.length > 0,
    subtype: errors.length > 0 ? "error_codex" : "success",
    errors,
    ...(usageRefusal ? { usageRefusal } : {}),
  };
}

type CodexSpawnEnvArgs = Pick<
  CodexSpawnArgs,
  "cwd" | "prompt" | "workerHome" | "zdotdir" | "env" | "runId" | "taskId"
>;

function codexSpawnEnv(config: Config, args: CodexSpawnEnvArgs): Record<string, string | undefined> {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"];
  const env: Record<string, string | undefined> = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.CODEX_HOME = codexHome(config);
  for (const [key, value] of Object.entries(args.env ?? {})) {
    if (!/^ANTHROPIC_|^OPENAI_API_KEY$/.test(key)) env[key] = value;
  }
  // W1-T2800 — ASSIGNED AFTER `args.env` IS COPIED, AND FROM THE THREADED HOME ONLY.
  //
  // MEASURED against pinned codex-cli 0.152.0, with a sentinel exported only from `$HOME/.bashrc`
  // and this function's own filter plus `shell_environment_policy.exclude` both in force:
  // `/proc/self/environ` in the child carried ZERO ANTHROPIC keys and a bare `env` (no shell)
  // carried zero — BOTH EXCLUSIONS HELD — while the worker's SHELL-VISIBLE value was the
  // sentinel. Plain `bash -c` under the same HOME without Codex read empty, which is the
  // discriminating control. The exclusions act at the PROCESS BOUNDARY and cannot stop a shell
  // that re-reads the value FROM DISK afterwards; only a redirected HOME whose rc files are blank
  // can. Removing `.bashrc` closed the leak and restoring it re-opened it.
  //
  // So neither exclusion above is wrong and neither is edited here — this is the missing THIRD
  // boundary, not a replacement for the two that already work.
  env.HOME = args.workerHome;
  if (args.zdotdir !== undefined) env.ZDOTDIR = args.zdotdir;
  Object.assign(env, workerMarkerEnv(args.runId, args.taskId, workerInstallationScope(config.root)));
  return env;
}

/**
 * W1-T2800 SCOPE NOTE — a widening recorded here and in the PR body, never in the shard (a
 * `verify: auto` task cannot declare its own plan record, and `rule15-filing` refuses it).
 *
 * `CodexSpawnArgs.workerHome` is REQUIRED, which is the point: an optional field with a fallback
 * is the defect this task fixes. Making it required is a type-level contract change, so five test
 * files outside this task's declared `files:` construct Codex spawn fakes the compiler now
 * refuses — `a-codex-reviewer-scratch-directory-is-not-a-repository`,
 * `a-codex-worker-starts-outside-a-git-repository`, `a-codex-worker-uses-a-private-temporary-root`,
 * `codex-model-console` and `worker-provider`. Each gained ONE field on its fake and nothing else;
 * no assertion, subject or expectation in them was touched.
 *
 * The alternative — leaving `workerHome` optional so those fakes still compile — would have kept
 * a reachable `process.env.HOME` fallback on the spawn path, i.e. preserved the leak to avoid an
 * advisory. `scope_violation` is advisory precisely so a review can ratify a widening like this
 * one; the fakes were updated rather than the contract weakened.
 */

/** W1-T2800: {@link codexSpawnEnv} under test — the env boundary this task fixes is the whole
 *  subject, so it is reachable directly rather than only through a live spawn. Exported for the
 *  test seam ONLY; every production caller still goes through {@link codexSpawnEnv}. */
export function codexSpawnEnvForTest(config: Config, args: CodexSpawnEnvArgs): Record<string, string | undefined> {
  return codexSpawnEnv(config, args);
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    // A not-yet-created path still has a lexical absolute form; callers separately check scope.
    return resolve(path);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Codex's trust bypass is safe only for the deliberately non-repository, read-only call sites
 * (semantic review and isolation probes). A write-capable worker whose checkout is missing must
 * keep failing closed at Codex's own repository gate instead of running in the wrong directory.
 */
function isGitWorktree(cwd: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    // `git` missing, not a repo, or the probe otherwise failed to prove worktree membership --
    // treat as "not a worktree" so the bypass stays fail-closed on any unproven cwd.
    return false;
  }
}

/**
 * Resolve only this checkout's Git administrative directories. Codex workspace-write protects
 * `.git` by default, while Remudero implementation prompts require the worker to commit. Linked
 * worktrees need both the per-worktree git dir and their shared common dir; paths outside the
 * configured Remudero root are refused instead of widening the sandbox from repository metadata.
 */
export function codexGitWritableRoots(cwd: string, configRoot: string): string[] {
  try {
    const root = physicalPath(configRoot);
    const output = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean).map(physicalPath))]
      .filter((candidate) => isWithin(root, candidate));
  } catch (error) {
    // A non-repository or unreadable Git layout earns no extra writable root, never a broad grant.
    return [];
  }
}

/**
 * The `project_doc_max_bytes` the Codex spawn pins (W1-T3135). KIND: BACKSTOP (W1-T1266) — the
 * PRIMARY CONTROL on this lane's doctrine size is the CLAUDE.md budget ratchet
 * (`scripts/claude-md-budget-baseline.json`'s `capBytes`), and this ceiling binds only if that
 * control is breached. Codex's own default, 32768, sits BELOW that cap and truncates silently, so
 * this must stay above it; the test asserts it against the baseline file rather than a second
 * hand-typed number, making a raised doc budget fail loudly instead of cutting doctrine.
 */
export const CODEX_PROJECT_DOC_MAX_BYTES = 65536;

/**
 * The nudge every Codex worker prompt opens with (W1-T3135/W1-T3267). It names the maintained
 * source rather than the generated index, and it stays even though `project_doc_fallback_filenames`
 * now prefers AGENTS.md and falls back to CLAUDE.md, because a worker that is told what it was
 * given reads it as doctrine rather than as background.
 */
export const CODEX_DOCTRINE_PRELUDE =
  "Before acting, read and follow the repository instruction files present in the checkout, starting with CLAUDE.md — this repository's standing instructions, which are also loaded as your project doc.\n\n";

interface WorkerCommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

interface WorkerPreToolUseHook {
  matcher: string;
  hooks: WorkerCommandHook[];
}

/**
 * Translate the already-validated worker settings' PreToolUse hooks into Codex's inline TOML
 * profile. Claude consumes the JSON file directly; Codex has no settings-file flag, so omitting
 * this translation silently dropped the repository's deterministic deny floor while preserving
 * the same GitHub credential and network access.
 *
 * Fail closed on an unreadable hook shape. A worker policy without its floor is not a weaker but
 * acceptable profile: it is a different authority boundary.
 */
export function codexPreToolUseProfile(settingsFile: string): string[] {
  const settings = validateWorkerSettingsFile(settingsFile);
  const configured = (settings.hooks as { PreToolUse?: unknown } | undefined)?.PreToolUse;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error("Codex worker settings must define at least one PreToolUse hook.");
  }

  const hooks = configured.map((entry, entryIndex): WorkerPreToolUseHook => {
    const candidate = entry as { matcher?: unknown; hooks?: unknown };
    if (typeof candidate?.matcher !== "string" || !Array.isArray(candidate.hooks) || candidate.hooks.length === 0) {
      throw new Error(`Codex worker PreToolUse[${entryIndex}] has an unreadable matcher or empty hooks list.`);
    }
    return {
      matcher: candidate.matcher,
      hooks: candidate.hooks.map((hook, hookIndex): WorkerCommandHook => {
        const commandHook = hook as { type?: unknown; command?: unknown; timeout?: unknown };
        if (commandHook?.type !== "command" || typeof commandHook.command !== "string" || commandHook.command.length === 0) {
          throw new Error(`Codex worker PreToolUse[${entryIndex}].hooks[${hookIndex}] is not a command hook.`);
        }
        if (commandHook.timeout !== undefined &&
            (typeof commandHook.timeout !== "number" || !Number.isFinite(commandHook.timeout) || commandHook.timeout <= 0)) {
          throw new Error(`Codex worker PreToolUse[${entryIndex}].hooks[${hookIndex}] has an invalid timeout.`);
        }
        return {
          type: "command",
          command: commandHook.command,
          ...(commandHook.timeout === undefined ? {} : { timeout: commandHook.timeout }),
        };
      }),
    };
  });

  const inlineToml = hooks
    .map((entry) => {
      const commands = entry.hooks
        .map((hook) =>
          `{type=${JSON.stringify(hook.type)},command=${JSON.stringify(hook.command)}` +
          `${hook.timeout === undefined ? "" : `,timeout=${hook.timeout}`}}`,
        )
        .join(",");
      return `{matcher=${JSON.stringify(entry.matcher)},hooks=[${commands}]}`;
    })
    .join(",");

  return [
    "--enable", "hooks",
    // The source was validated above and is repository-owned. A headless worker cannot answer a
    // first-use trust prompt, so this narrowly bypasses hook trust without bypassing the sandbox.
    "--dangerously-bypass-hook-trust",
    "-c", `hooks.PreToolUse=[${inlineToml}]`,
  ];
}

function codexExecArgs(args: CodexSpawnArgs, config: Config, selection?: Pick<ProviderCapacity, "model" | "effort">): string[] {
  const model = selection?.model ?? config.workerProviders?.codexModel;
  const effort = selection?.effort === "default" ? undefined : selection?.effort;
  const disposableReview = args.sandboxIntent === "disposable-review";
  const readOnly = !disposableReview && Array.isArray(args.tools) && !args.tools.some((tool) => ["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(tool));
  const skipGitRepoCheck = readOnly && !isGitWorktree(args.cwd);
  const disposableReadRoots = disposableReview
    ? [...new Set((args.sandboxReadRoots ?? []).filter(isAbsolute).map(physicalPath))]
    : [];
  const disposableFilesystem = [
    [":slash_tmp", "deny"],
    [":tmpdir", "write"],
    ...disposableReadRoots.map((root) => [root, "read"]),
  ].map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(",");
  const disposableReviewProfile = disposableReview
    ? [
        "--enable", "network_proxy",
        "-c", 'default_permissions="rmd_review"',
        "-c", 'permissions.rmd_review.extends=":workspace"',
        "-c", `permissions.rmd_review.filesystem={${disposableFilesystem}}`,
        "-c", "permissions.rmd_review.network.enabled=true",
      ]
    : [];
  const shared = [
    "--json",
    "--ignore-user-config",
    ...codexPreToolUseProfile(args.settingsFile),
    ...disposableReviewProfile,
    // W1-T2754: Codex refuses to start when its `-C` cwd is neither a git repository nor a
    // configured trusted directory — "Not inside a trusted directory and --skip-git-repo-check
    // was not specified." — and it does so by EXITING 0 WITH NO OUTPUT, so the caller sees an
    // empty transcript rather than an error. That is how it reached production as a parse
    // failure: `probeIsolation`'s `defaultExecutor` (src/lib/isolation.ts) creates its probe cwd
    // with a bare `mkdirSync` under `config.root/tmp`, which is NOT a repo, so every Codex-routed
    // isolation probe returned nothing, parsed to NaN counts and failed closed as
    // `blocked_isolation — the probe's alias/function counts could not be parsed`, at $0 cost.
    // Task workers never hit it because their cwd IS a git worktree, which is exactly why the
    // failure looked provider-correlated and intermittent rather than structural.
    //
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", 'shell_environment_policy.exclude=["CODEX_HOME","OPENAI_API_KEY","ANTHROPIC_API_KEY"]',
    // W1-T3135/W1-T3267 — THE CODEX LANE'S PROJECT-DOC ROUTE, AND BOTH FLAGS OR NEITHER.
    // The generated AGENTS.md is the preferred, compact index; CLAUDE.md stays in the same list as
    // the maintained fallback for a checkout that lacks the generated file. The cap is unchanged:
    // without it, a fallback to CLAUDE.md can still truncate at Codex's smaller default. Falsifiers
    // for the cap and fallback live in test/the-codex-lane-auto-loads-no-doctrine.test.ts and
    // test/a-dispatched-codex-worker-loads-the-whole-file.test.ts.
    "-c", 'project_doc_fallback_filenames=["AGENTS.md","CLAUDE.md"]',
    "-c", `project_doc_max_bytes=${CODEX_PROJECT_DOC_MAX_BYTES}`,
  ];
  // W1-T2748 narrows W1-T2754's trust bypass to the two call-site properties that make it safe:
  // read-only tools and positive evidence that the cwd is not a Git worktree. The flag remains in
  // this shared segment so fresh and resumed reviewers/probes cannot drift apart. A write-capable
  // non-repository cwd receives no bypass and Codex refuses it before doing work.
  if (skipGitRepoCheck) shared.splice(2, 0, "--skip-git-repo-check");
  if (model) shared.push("--model", model);
  if (effort) shared.push("-c", `model_reasoning_effort=\"${effort}\"`);
  if (args.resumeSessionId) return ["exec", "resume", ...shared, args.resumeSessionId, "-"];
  const gitWritableRoots = readOnly || disposableReview ? [] : codexGitWritableRoots(args.cwd, config.root);
  return [
    "exec",
    ...shared,
    ...(disposableReview ? [] : ["--sandbox", readOnly ? "read-only" : "workspace-write"]),
    ...(readOnly || disposableReview ? [] : ["-c", "sandbox_workspace_write.network_access=true"]),
    ...gitWritableRoots.flatMap((root) => ["--add-dir", root]),
    "-C", args.cwd,
    "-",
  ];
}

export async function spawnCodexWorker(
  args: CodexSpawnArgs,
  config: Config,
  selection?: Pick<ProviderCapacity, "model" | "effort">,
): Promise<CodexWorkerResult> {
  return withTempDir("codex-worker", (privateTmpDir) =>
    spawnCodexWorkerInPrivateTemp(args, config, privateTmpDir, selection),
  );
}

async function spawnCodexWorkerInPrivateTemp(
  args: CodexSpawnArgs,
  config: Config,
  privateTmpDir: string,
  selection?: Pick<ProviderCapacity, "model" | "effort">,
): Promise<CodexWorkerResult> {
  const bin = resolveCodexBin(config);
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const pidRef: { pid?: number } = {};
  const spawn = args.containment?.spawn ?? spawnDetachedGroup;
  const teardown = args.containment?.teardown ?? ((pgid: number) => void teardownProcessGroup(pgid));
  const startedAt = Date.now();
  let timedOut = false;
  const childEnv = { ...codexSpawnEnv(config, args), TMPDIR: privateTmpDir };
  const contained = spawn(
    { command: bin, args: codexExecArgs(args, config, selection), cwd: args.cwd, env: childEnv },
    (chunk) => stderrChunks.push(chunk),
    args.onSpawnError,
  );
  pidRef.pid = contained.pid;
  const process = contained.process as unknown as ContainedProcess["process"] & NodeJS.EventEmitter & {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
  };
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    process.once("exit", (code: number | null) => resolve(code));
    process.once("error", reject);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armClockBound = () => {
    if (!args.clockBound) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      teardown(contained.pid);
    }, args.clockBound.boundMs);
  };
  process.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdoutChunks.push(text);
    if (/\"type\":\"agent_message\"/.test(text)) args.streamObserver?.({ kind: "working", tsMs: Date.now() });
    else args.streamObserver?.({ kind: "message", tsMs: Date.now() });
    armClockBound();
  });
  armClockBound();
  const prompt = CODEX_DOCTRINE_PRELUDE + args.prompt;
  process.stdin.write(`${prompt}\n`);
  process.stdin.end();
  try {
    const exitCode = await withWorkerGroupTeardown(pidRef, () => exitPromise, teardown);
    if (timedOut) throw new Error(`Codex worker exceeded the ${args.clockBound?.boundMs}ms clock bound`);
    const parsed = parseCodexJsonl(stdoutChunks.join(""));
    const isError = parsed.isError || exitCode !== 0;
    const model = selection?.model ?? config.workerProviders?.codexModel ?? "codex-default";
    return {
      sessionId: parsed.sessionId || args.resumeSessionId || "",
      costUsd: 0,
      numTurns: parsed.numTurns,
      // Codex exec 0.152.0 exposes no max-turn flag; never ledger the Claude cap as enforced.
      maxTurns: undefined,
      text: parsed.text,
      blocks: parsed.blocks,
      stderr: stderrChunks.join(""),
      subtype: isError ? (parsed.isError ? parsed.subtype : `error_exit_${exitCode}`) : "success",
      isError,
      apiError: parsed.errors.some((error) => /rate limit|server|network/i.test(error)),
      ...(parsed.usageRefusal ? { usageRefusal: parsed.usageRefusal } : {}),
      permissionDenials: parsed.errors.filter((error) => /permission|sandbox|denied/i.test(error)),
      childEnvKeys: Object.keys(childEnv),
      accountLabel: undefined,
      provider: "codex",
      model,
      effort: selection?.effort ?? args.effort ?? "default",
      tokens: parsed.tokens,
      modelUsage: {},
      compactionEvents: [],
      compactionFailures: [],
      compactionConfigured: false,
      qualitySuspect: false,
      workerDurationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
