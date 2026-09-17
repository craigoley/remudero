import { execFileSync, spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, accessSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectUsageLimitRefusal, type UsageLimitRefusal } from "./classify.js";
import { systemClock, type Clock } from "./clock.js";
import { RmdError } from "./errors.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
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
import {
  CASH_WEB_SEARCH_KEY_ENV,
  CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS,
  cashWebSearchEnabled,
  cashWebSearchEndpoint,
  performCashWebSearch,
} from "./cash-web-bridge.js";

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
// Same deployment-id grammar as Codex. The Azure deployment id reaches a URL path, so accepting
// a broader string would make a configuration typo an outbound-target bug.
const SAFE_OPENWEIGHT_MODEL_ID = SAFE_CODEX_MODEL_ID;
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

/** Last-resort data for a missing capability table. Real open-weight routing resolves the table
 * below; this keeps a malformed optional table from changing the existing fail-soft contract. */
/**
 * The code-side default when mounts declares no `capabilities.cash` table. It must name the
 * SAME leading deployment as that table (W1-T3598): if the two disagreed, a checkout with no table
 * would silently route the DEARER deployment while the configured fleet routed the cheaper one, and
 * nothing would report the divergence. test/the-trial-deployment-is-the-cheaper-compliant-one.test.ts
 * asserts the two agree.
 *
 * FRONTIER NO LONGER NAMES ONE DEPLOYMENT (W1-T3689). gpt-oss-120b alone left frontier
 * single-candidate -- the same shape that had already gone wrong for `codex.balanced.low` -- so
 * gpt-5.6-luna now leads it (measured 2026-09-16), taking gpt-5-mini's place outright: cheaper on both axes
 * and 0 reasoning tokens where mini spent 64 of 76. gpt-5.6-terra TRAILS as the escalation, at 10x
 * luna, reached only when luna is unavailable. ECONOMY AND BALANCED ARE UNTOUCHED: nano is cheaper
 * than luna per token, and W1-T3614 fixed those leads from measured PER-TASK cost, which luna has
 * not yet been measured against. gpt-oss-120b TRAILS rather than being deleted,
 * the same demotion shape the `codex` table uses for a demoted model, so a deployment that stops
 * answering falls back instead of failing the lane.
 */
// W1-T3614: economy leads with gpt-oss-120b and balanced with gpt-5-nano, MIRRORING
// .remudero/mounts.yaml exactly -- a checkout with no mounts table must not silently prefer a
// different deployment from one with it, which test/the-trial-deployment-is-the-cheaper-compliant-one
// asserts directly. The leads differ because the cheaper deployment differs by prompt shape:
// measured 2026-09-15, a 259,181-token inbox_draft favours nano 2.83x while a 446-token escalation
// judgement favours gpt-oss 2.40x, since nano spends ~5x the completion tokens on reasoning.
const FALLBACK_OPENWEIGHT_MODELS: Record<CodexModelTier, string[]> = {
  economy: ["gpt-oss-120b", "gpt-5-nano"],
  balanced: ["gpt-5-nano", "gpt-oss-120b"],
  frontier: ["gpt-5.6-luna", "gpt-5.6-terra"],
};

/** The provider-neutral Claude-model -> capability lookup is shared with Codex: both adapters
 * resolve a mount by table data, never a substring heuristic over a Claude model name. */
export function openWeightCapabilityForRequestedModel(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
): CodexModelTier {
  return codexCapabilityForRequestedModel(capabilities, requestedModel);
}

/** Ordered Azure deployment candidates for a capability/effort pair. This mirrors the Codex
 * table shape so model additions stay a mounts-data edit. */
export function openWeightCandidatesForCapability(
  capabilities: CapabilityLadder | undefined,
  tier: CodexModelTier,
  requestedEffort: string | undefined,
): string[] {
  // W1-T3607: `cash` is canonical; `openweight` is read only as a fallback for a caller that built a
  // CapabilityLadder-shaped object directly (mounts.ts's loader already mirrors both, so this only
  // matters for a table that bypassed it).
  const byEffort = capabilities?.cash?.[tier] ?? capabilities?.openweight?.[tier];
  if (!byEffort) return FALLBACK_OPENWEIGHT_MODELS[tier];
  return (requestedEffort && byEffort[requestedEffort]) || byEffort.medium || FALLBACK_OPENWEIGHT_MODELS[tier];
}

/**
 * THE CONTEXT WINDOW IS A PROPERTY OF THE DEPLOYMENT, exactly as price and temperature are.
 *
 * It is the third row of the same table discipline, and it arrived last for a measurable reason:
 * price and temperature announce themselves with an HTTP 400 on the FIRST request, while an
 * oversized prompt fails only on the requests that happen to be large, so the gap read as
 * flakiness rather than as a missing lookup.
 *
 * MEASURED 2026-09-15 from state/openweight-allowance.json: 32 of 96 LARGE nano requests never
 * settled -- exactly 33% -- while all 8 small requests settled, with the failures spread uniformly
 * across each concurrency triple (12/10/10) rather than clustered. That is a window edge, not a
 * transport fault. gpt-oss-120b announces the same wall outright:
 *   HTTP 400: The input (259242 tokens) is longer than the model's context length (131072)
 *
 * TREATED AS A TOTAL, AND COMPARED AGAINST PROMPT + {@link OPENWEIGHT_MAX_COMPLETION_TOKENS}.
 * gpt-oss-120b's 131,072 is a total context; gpt-5-nano publishes 272,000 as an INPUT ceiling.
 * Requiring room for the completion in both cases can only refuse a request that would have fit,
 * never admit one that would not -- the safe direction, and the same asymmetry
 * {@link OPENWEIGHT_PRICES} reasons about.
 *
 * A deployment with no row here is REFUSED rather than assumed to fit, because the alternative is
 * to discover the answer by spending a full reservation on a request that cannot succeed.
 */
export interface OpenWeightContextWindow {
  readonly totalTokens: number;
  readonly readAt: string;
}

export const OPENWEIGHT_CONTEXT_WINDOWS: Readonly<Record<string, OpenWeightContextWindow>> = {
  "gpt-oss-120b": { totalTokens: 131_072, readAt: "2026-09-15" },
  "gpt-5-nano": { totalTokens: 272_000, readAt: "2026-09-15" },
  // A DELIBERATE FLOOR, NOT A MEASURED CEILING. Microsoft's published gpt-5.6 rates are
  // labelled "short context" and disclose neither the window nor a long-context rate, and the
  // account's per-request TPM ceiling refuses an oversized probe before the model can answer one.
  // So the window is recorded LOW on purpose: a request above it refuses pre-transport rather than
  // silently entering a tier whose price is unknown, which is the direction that keeps
  // `dailyCapUsd` honest. Raise it only when a long-context rate has been read AND priced.
  "gpt-5.6-luna": { totalTokens: 128_000, readAt: "2026-09-16" },
  "gpt-5.6-terra": { totalTokens: 128_000, readAt: "2026-09-16" },
};

/**
 * Bytes per token, used ONLY to decide which deployment can hold a request -- never to price one.
 *
 * DERIVED, NOT ASSUMED. Inverting the live allowance file on nano's $0.05/1M input and the fixed
 * 5,000-token output ceiling: a $0.0547 reservation is 1,054,000 request bytes, and the $0.0142 it
 * settled to bounds the real prompt between 244,000 tokens (if the completion used the full
 * ceiling) and 284,000 (if it used none) -- so 3.71 to 4.32 bytes per token over this corpus. 4.0
 * is the middle of that measured band and the usual English/code heuristic.
 *
 * THIS GATE IS COARSE, AND SAYING SO IS THE POINT. Its reliable job is separating deployments that
 * differ by MULTIPLES: gpt-oss-120b's 131,072 against gpt-5-nano's 272,000 is a 2x gap, and no
 * plausible ratio confuses a 260K-token prompt for one that fits gpt-oss. It CANNOT resolve a thin
 * margin. inbox_draft runs at ~4% under nano's window, which is inside this constant's own error
 * band, so the residual edge failures there are not something a better divisor fixes -- the fix for
 * that lane is a smaller prompt, not a sharper estimate.
 *
 * A DELIBERATELY CONSERVATIVE RATIO WAS TRIED AND REJECTED, on measurement. At 3.5 the estimate for
 * the same body is 301,143 tokens, which exceeds every declared window, so the gate refused the
 * WHOLE inbox_draft lane -- turning a 33% wire failure into a 100% local refusal and pushing the
 * lane back onto the subscription. Over-refusing is not the safe direction when the safe-looking
 * error deletes the routing this exists to enable.
 */
export const OPENWEIGHT_BYTES_PER_TOKEN = 4.0;

/** The conservative token estimate the fit gate reasons about. */
export function openWeightEstimatedTokens(requestBodyBytes: number): number {
  return Math.ceil(requestBodyBytes / OPENWEIGHT_BYTES_PER_TOKEN);
}

/** Raised INSTEAD of selecting a deployment that cannot hold the request. Thrown before any
 *  reservation exists, so an impossible request costs nothing against the daily cap.
 *
 *  NAMES BOTH FIGURES (W1-T3613): the request's own estimated size, and every considered
 *  deployment's declared context window. A message that named only "no deployment fits" would
 *  send an operator back to the source to learn WHY -- the gap this refusal exists to surface
 *  should be readable from the error text alone. */
export class OpenWeightRequestTooLargeError extends RmdError {
  readonly estimatedTokens: number;
  constructor(detail: { estimatedTokens: number; capability: string; considered: readonly string[] }) {
    const consideredWithWindows = detail.considered.map((id) => {
      const window = OPENWEIGHT_CONTEXT_WINDOWS[id];
      return window ? `${id} (context window ${window.totalTokens})` : `${id} (no declared context window)`;
    });
    super(
      "usage",
      1,
      `openweight request is ~${detail.estimatedTokens} tokens and no '${detail.capability}' deployment can hold it ` +
        `(considered: ${consideredWithWindows.join(", ") || "none"}). Refusing before the request reserves, so it costs nothing. ` +
        `Shrink the prompt or declare a deployment with a larger context window.`,
      { estimatedTokens: detail.estimatedTokens, capability: detail.capability, considered: [...detail.considered] },
    );
    this.estimatedTokens = detail.estimatedTokens;
  }
}

/** Does this deployment hold a prompt of `estimatedTokens`, leaving room for the completion the
 *  adapter itself puts on the wire? An UNLISTED deployment holds nothing -- it is refused, never
 *  assumed, for the same reason an unpriced one is. */
export function openWeightDeploymentHolds(deployment: string, estimatedTokens: number): boolean {
  const window = OPENWEIGHT_CONTEXT_WINDOWS[deployment];
  if (window === undefined) return false;
  return estimatedTokens + OPENWEIGHT_MAX_COMPLETION_TOKENS <= window.totalTokens;
}

export interface OpenWeightModelSelection {
  model: string;
  effort: string;
  capability: CodexModelTier;
  /** Present only when the fit gate ran, so a ledger row can distinguish "held" from "not checked". */
  estimatedTokens?: number;
}

/**
 * Resolve and validate a deployment before it can enter an Azure URL.
 *
 * WHAT CHANGED, AND WHY IT IS THE SAME RULE THE LADDER ALREADY ENCODED. This used to take the
 * FIRST SYNTACTICALLY VALID id and find out on the wire whether it could hold the request. The
 * ladder compensated by hand: `economy` leads gpt-oss-120b and `balanced` leads gpt-5-nano, and
 * the comment on {@link FALLBACK_OPENWEIGHT_MODELS} says exactly why -- "a 259,181-token
 * inbox_draft favours nano 2.83x while a 446-token escalation judgement favours gpt-oss 2.40x".
 * That is a SIZE-DEPENDENT routing decision written into two static row orders, because the
 * selector could not see the prompt.
 *
 * So `promptBytes` is not a new policy; it is the input that policy always needed. Row order still
 * expresses the operator's MEASURED cost ranking within a tier -- it is not re-derived here, and
 * this function never reorders it. The window check only SKIPS a candidate that provably cannot
 * hold the request, which makes the first surviving candidate the cheapest one that fits.
 *
 * `promptBytes: undefined` means the caller genuinely does not know the size. The gate is then
 * SKIPPED rather than guessed, and selection behaves exactly as it did before.
 */
export function selectOpenWeightModel(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  promptBytes?: number,
): OpenWeightModelSelection {
  const capability = openWeightCapabilityForRequestedModel(capabilities, requestedModel);
  const candidates = openWeightCandidatesForCapability(capabilities, capability, requestedEffort);
  const safe = candidates.filter((candidate) => SAFE_OPENWEIGHT_MODEL_ID.test(candidate));
  if (safe.length === 0) throw new Error(`openweight capability '${capability}' has no safe deployment id`);
  if (promptBytes === undefined) {
    return { model: safe[0]!, effort: requestedEffort ?? "default", capability };
  }
  const estimatedTokens = openWeightEstimatedTokens(promptBytes);
  const model = safe.find((candidate) => openWeightDeploymentHolds(candidate, estimatedTokens));
  if (!model) throw new OpenWeightRequestTooLargeError({ estimatedTokens, capability, considered: safe });
  return { model, effort: requestedEffort ?? "default", capability, estimatedTokens };
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
  failureKind: "timeout" | "terminal" | "starved";
}

/**
 * How late a deadline may fire before it is read as THIS PROCESS stalling rather than the
 * app-server being slow. A healthy loop delivers a timer within milliseconds of its deadline.
 *
 * WHY THE DISTINCTION IS LOAD-BEARING (W1-T3690). Node runs timers in the timers phase, which
 * precedes the poll phase that delivers a child's stdout. If the main thread is blocked when the
 * deadline passes, the timer callback runs on the NEXT free tick BEFORE any queued stdout is
 * read -- so a child that answered in 300ms is recorded as "timed out after 10000ms; unfinished:
 * initialize". MEASURED on the fleet 2026-09-16 inside the daemon's own container: a free loop
 * replies in 366ms; a loop blocked 12s produces that exact string with a WALL TIME of 12000ms
 * against a 10000ms deadline. The overrun is the only signal that separates the two, and the
 * consequence of confusing them is severe: codex reads unreadable, the capacity auction gives it
 * zero allocation, and every lane silently migrates onto the Claude subscription.
 */
const CODEX_DEADLINE_OVERRUN_MS = 1_000;

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
    /** Real-time source for the deadline-overrun check. Injected ONLY by tests: a fake clock in
     *  production would defeat the very stall this measurement exists to detect. */
    monotonicNow?: () => number;
  },
): Promise<CodexRuntimeResult> {
  const spawn = deps.spawn ?? ((command, args, options) => spawnChild(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const monotonicNow = deps.monotonicNow ?? Date.now;
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
    const deadlineSetAt = monotonicNow();
    const timer = setTimeout(() => {
      const malformed = malformedStdoutLines > 0 ? `; malformed app-server stdout: ${malformedStdoutLines} line(s)` : "";
      // THE DEADLINE OVERRAN => WE STALLED, NOT THE APP-SERVER. See CODEX_DEADLINE_OVERRUN_MS.
      // The child's reply may be sitting unread in the poll queue right now; this exchange
      // observed nothing about Codex and must not be reported as evidence against it.
      const elapsedMs = monotonicNow() - deadlineSetAt;
      if (malformedStdoutLines === 0 && elapsedMs >= timeoutMs + CODEX_DEADLINE_OVERRUN_MS) {
        finish(codexRuntimeFailure(
          `app-server deadline overran: ${timeoutMs}ms budget fired after ${elapsedMs}ms, so this process was stalled ` +
            `and the child was never given a readable turn; unfinished: ${unfinishedPhases().join(", ") || "response validation"}`,
          "starved",
        ));
        return;
      }
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
  deps: Pick<CodexCapacityDeps, "spawn" | "timeoutMs"> & { clock: Pick<Clock, "now"> },
): Promise<CodexRuntimeResult> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const hedgeDelayMs = codexCapacityHedgeDelay(timeoutMs);
  // The primary installs its timeout while it constructs the app-server exchange. Schedule the
  // hedge from before that setup, not after it returns: synchronous setup work (notably coverage
  // instrumentation) must not consume the hedge's entire head start and let the primary timeout
  // settle first.
  const primaryStartedAt = deps.clock.now();
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
    const remainingHedgeDelayMs = hedgeDelayMs - (deps.clock.now() - primaryStartedAt);
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
      exchange = readCodexRuntimeWithTimeoutHedge(config, bin, { ...deps, clock: { now } });
      codexCapacityInFlight.set(cacheKey, exchange);
    }
  } else {
    exchange = readCodexRuntimeWithTimeoutHedge(config, bin, { ...deps, clock: { now } });
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
    const { failureKind, ...capacity } = value;
    codexCapacityCache.delete(cacheKey);
    // A STARVED READ IS NOT EVIDENCE ABOUT CODEX, so it must not buy a failure backoff. Caching it
    // would suppress the next read for up to CODEX_CAPACITY_FAILURE_BACKOFF_MAX_MS on the strength
    // of an exchange that observed nothing -- turning one blocked tick into a window in which the
    // provider is declared unreadable and every lane routes to the subscription instead.
    if (!deps.forceRefresh && failureKind !== "starved") {
      codexCapacityFailureCache.set(cacheKey, { at: now(), value: capacity });
    }
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

/** PRIMARY CONTROL: the maximum JSONL transcript one Codex worker may retain before it is
 * terminated. This is the ordinary containment boundary for worker output, not a recovery
 * fallback after another guard has failed. */
export const CODEX_WORKER_STDOUT_MAX_BYTES = 1 * 1024 * 1024;
/** PRIMARY CONTROL: stderr is diagnostic evidence, not protocol input, so it receives its own
 * smaller containment ceiling. */
export const CODEX_WORKER_STDERR_MAX_BYTES = 256 * 1024;

/** A worker exceeded a bounded protocol or diagnostic stream before it could return a result. */
export interface CodexWorkerOutputLimitError extends Error {
  readonly name: "CodexWorkerOutputLimitError";
  readonly reasonClass: "bounded_output";
  readonly stream: "stdout" | "stderr";
  readonly limitBytes: number;
  readonly observedBytes: number;
}

export function isCodexWorkerOutputLimitError(error: unknown): error is CodexWorkerOutputLimitError {
  if (!(error instanceof Error) || error.name !== "CodexWorkerOutputLimitError") return false;
  const candidate = error as Partial<CodexWorkerOutputLimitError>;
  return (
    candidate.reasonClass === "bounded_output" &&
    (candidate.stream === "stdout" || candidate.stream === "stderr") &&
    typeof candidate.limitBytes === "number" &&
    typeof candidate.observedBytes === "number"
  );
}

function codexWorkerOutputLimitError(
  stream: "stdout" | "stderr",
  limitBytes: number,
  observedBytes: number,
): CodexWorkerOutputLimitError {
  const error = new Error(
    `Codex worker ${stream} output exceeded its ${limitBytes}-byte retention budget ` +
      `(${observedBytes} bytes observed)`,
  );
  return Object.assign(error, {
    name: "CodexWorkerOutputLimitError" as const,
    reasonClass: "bounded_output" as const,
    stream,
    limitBytes,
    observedBytes,
  });
}

/** Incrementally reduce Codex JSONL without retaining the complete transcript. */
class CodexJsonlAccumulator {
  private sessionId = "";
  private readonly blocks: string[] = [];
  private readonly errors: string[] = [];
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private numTurns = 0;
  private usageRefusal: UsageLimitRefusal | undefined;
  private pending = "";

  constructor(private nowMs: number) {}

  push(chunk: string, nowMs = this.nowMs): void {
    this.nowMs = nowMs;
    this.pending += chunk;
    for (;;) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) return;
      this.consumeLine(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
  }

  finish(): ParsedCodexEvents {
    if (this.pending.trim()) this.consumeLine(this.pending);
    this.pending = "";
    return {
      sessionId: this.sessionId,
      text: this.blocks.at(-1) ?? "",
      blocks: this.blocks,
      tokens: { input: this.input, output: this.output, cacheRead: this.cacheRead, cacheCreation: 0 },
      numTurns: this.numTurns,
      isError: this.errors.length > 0,
      subtype: this.errors.length > 0 ? "error_codex" : "success",
      errors: this.errors,
      ...(this.usageRefusal ? { usageRefusal: this.usageRefusal } : {}),
    };
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      // Preserve malformed output in the returned error verdict instead of treating it as absence.
      this.errors.push(`unparseable Codex event: ${line.slice(0, 160)}`);
      return;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") this.sessionId = event.thread_id;
    if (event.type === "turn.started") this.numTurns += 1;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      this.blocks.push(event.item.text);
    }
    if (event.type === "turn.completed" && event.usage) {
      this.input += event.usage.input_tokens ?? 0;
      this.output += event.usage.output_tokens ?? 0;
      this.cacheRead += event.usage.cached_input_tokens ?? 0;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = event.error?.message ?? event.type;
      this.errors.push(message);
      // Codex 0.152.0 preserves its structured UsageLimitExceeded classification inside app-server,
      // but `codex exec --json` intentionally projects only the terminal message. Normalize at this
      // adapter boundary while the text is known to be provider error evidence; never scan agent
      // output, which may discuss usage limits as part of the task.
      this.usageRefusal ??= detectUsageLimitRefusal(message, this.nowMs);
    }
  }
}

/** Parse Codex exec JSONL into the existing provider-neutral worker envelope. */
export function parseCodexJsonl(raw: string, nowMs = Date.now()): ParsedCodexEvents {
  const accumulator = new CodexJsonlAccumulator(nowMs);
  accumulator.push(raw);
  return accumulator.finish();
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

/** Azure deployment authentication is process-local to the daemon. It is deliberately not a
 * config field and never enters a worker environment or a ledger row. */
export const OPENWEIGHT_API_KEY_ENV = "RMD_OPENWEIGHT_API_KEY";
/** PRIMARY CONTROL: gpt-oss-120b is a reasoning model; 1,500 truncated a shard mid-string in the live probe. */
export const OPENWEIGHT_MAX_COMPLETION_TOKENS = 5_000;
/**
 * PRIMARY CONTROL (W1-T1266): the wall-clock bound on ONE cash request. Nothing else bounds a hung
 * one -- before this the `fetch` carried no `signal` at all, so a stalled Azure request held the
 * tool loop and its reservation for as long as the socket stayed open. It is not a backstop firing
 * after some other guard failed; it IS the guard.
 *
 * Generous on purpose: a reasoning model on a large prompt is legitimately slow, and a deadline
 * that fires early would refuse work the cap has already paid to reserve.
 */
export const OPENWEIGHT_REQUEST_TIMEOUT_MS = 180_000;

/** Raised when a reply was cut off by the completion budget rather than finished. */
export class OpenWeightTruncatedReplyError extends RmdError {
  readonly finishReason: string;
  constructor(finishReason: string, completionTokens: number) {
    super(
      "usage",
      1,
      `openweight reply was TRUNCATED by the completion budget (finish_reason=${JSON.stringify(finishReason)}, ` +
        `${completionTokens} completion tokens against OPENWEIGHT_MAX_COMPLETION_TOKENS=${OPENWEIGHT_MAX_COMPLETION_TOKENS}). ` +
        `Refusing to return a partial answer as a whole one — shrink the request or raise the budget.`,
      { finishReason, completionTokens },
    );
    this.finishReason = finishReason;
  }
}

/** Raised when a request passed its deadline. Distinct from a transport error so a caller can tell
 *  "we stopped waiting" from "the endpoint refused". */
export class OpenWeightRequestTimeoutError extends RmdError {
  constructor(readonly timeoutMs: number, readonly deployment: string) {
    super(
      "usage",
      1,
      `openweight request to ${JSON.stringify(deployment)} exceeded ${timeoutMs}ms and was abandoned. ` +
        `Its reservation stays CHARGED: the request may have been served and billed, so returning the ` +
        `allowance would let a timeout buy free authority.`,
      { timeoutMs, deployment },
    );
  }
}

/**
 * Is this reply complete, or did the budget cut it off?
 *
 * `finish_reason` was never read. `length` means the model stopped because it ran out of completion
 * budget, and the content returned is a PREFIX -- indistinguishable, to every caller, from a
 * genuinely short answer. OPENWEIGHT_MAX_COMPLETION_TOKENS's own comment records a shard already
 * truncated mid-string at 1,500, so this is a measured failure mode rather than a hypothetical one.
 *
 * `stop` and `tool_calls` are the two complete outcomes. An ABSENT reason is treated as complete:
 * not every OpenAI-compatible endpoint sets it, and inventing a refusal from a missing field would
 * fail closed on deployments that work.
 */
export function openWeightReplyIsTruncated(finishReason: unknown): boolean {
  return finishReason === "length";
}
/**
 * Adapter-owned output constraints for every OpenWeight lane. Each rule is conditional: the
 * adapter must not turn a code-review or prose task into a YAML-only task by accident.
 */
/**
 * Strip a Markdown fence a model wrapped a structured reply in, and return the payload.
 *
 * ASK AND STRIP, NOT ASK ALONE. OPENWEIGHT_OUTPUT_CONTRACT already tells the model to emit a raw
 * document "without Markdown fences", and that instruction is correct -- but an instruction is not
 * a guarantee, and this adapter has less margin than most: it deliberately cannot lean on
 * `response_format` for every deployment (gpt-oss-120b returns malformed JSON under json_object),
 * so for those the prompt is the ONLY defence there is. synthwatch's production adapter asks AND
 * strips; this closes the gap on the stripping half.
 *
 * DELIBERATELY NARROW. It removes ONE wrapping fence and nothing else: no trimming of prose around
 * an unfenced reply, no outermost-brace slice, no JSON parse. A reply that is already raw comes
 * back byte-identical, because the failure this fixes is a wrapper, not malformed content -- and a
 * cleverer extractor would start silently editing answers rather than unwrapping them.
 */
export function openWeightUnfence(text: string): string {
  const match = /^\s*```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
  return match?.[1] ?? text;
}

export const OPENWEIGHT_OUTPUT_CONTRACT = [
  "Apply each output rule below only when its condition is true:",
  "- When emitting YAML, double-quote every scalar value containing a colon (`:`), especially a `proof:` value.",
  "- When the request names a closed enum, emit exactly one listed literal; choose the nearest listed value rather than inventing `unknown` or `ambiguous`.",
  "- When the request asks for a raw document, emit that document without Markdown fences.",
  "- When the request names literal output markers or delimiters (for example a fixed START/END " +
    "line or a STAMP line), emit those markers verbatim and print the requested artifact between " +
    "or after them instead of describing it in prose.",
].join("\n");
/**
 * PRICE IS A PROPERTY OF THE DEPLOYMENT, NOT OF THE PROVIDER.
 *
 * `openWeightCandidatesForCapability` already resolves a whole LADDER of deployments out of
 * mounts, and that table's own comment calls model additions "a mounts-data edit". The routing
 * layer has therefore been multi-deployment since W1-T3546 while the pricing layer was a single
 * pair of module constants — every deployment billed at gpt-oss-120b's rate.
 *
 * THE ASYMMETRY IS WHY THIS IS A TABLE AND NOT A TIDY-UP. A CHEAPER deployment priced at these
 * numbers over-reserves: wasteful, but safe. A DEARER one UNDER-reserves, which re-opens exactly
 * the hole {@link reserveOpenWeightBudget} exists to close — the cap would admit requests it
 * cannot afford and the day's true spend would pass `dailyCapUsd`. So a deployment with no row
 * here is refused rather than priced by a neighbour.
 *
 * Each row carries the date its figures were read, because published prices move and a number
 * with no as-of is unauditable.
 */
export interface OpenWeightPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** ISO date the published figures were last read. Not decorative: it is what lets a later
   *  reader tell a stale row from a current one without diffing against the vendor's page. */
  readAt: string;
}

export const OPENWEIGHT_PRICES: Readonly<Record<string, OpenWeightPrice>> = {
  // Azure serverless published rate. These are the two numbers this adapter has always used;
  // they are unchanged, and are now this deployment's ROW rather than the provider's default.
  "gpt-oss-120b": { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, readAt: "2026-09-14" },
  // W1-T3598: cheaper than gpt-oss-120b on BOTH axes (3x on input, 1.5x on output) and an
  // Azure-OpenAI-family deployment, so it rides `openWeightEndpoint`'s existing
  // `openai/deployments/...` route with no second endpoint shape.
  "gpt-5-nano": { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.4, readAt: "2026-09-15" },
  // gpt-5-mini was REMOVED, not demoted. Luna is cheaper on BOTH axes ($0.20/$1.20 vs
  // $0.25/$2.00) and measurably more efficient -- on an identical trivial prompt Luna spent 0
  // reasoning tokens where mini spent 64 of 76 -- so mini had no lane left where it was the right
  // row. Keeping it trailing would have implied a fallback worth reaching; there is none.
  //
  // PUBLISHED SHORT-CONTEXT RATES, read 2026-09-16 from Microsoft's GPT-5.6 Foundry announcement.
  // These are the SAME models the Codex subscription already routes (`gpt-5.6-luna`/`-terra` lead
  // the codex economy and balanced rows), so a squeeze diverts a lane to identical intelligence on
  // a different bill rather than to a cheaper substitute of unknown quality.
  "gpt-5.6-luna": { inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2, readAt: "2026-09-16" },
  // TERRA IS 10x LUNA ON BOTH AXES. It exists for the frontier band alone; nothing else may lead
  // with it. Sol ($5.00/$30.00) is deliberately NOT here -- 2.5x terra for the same band.
  "gpt-5.6-terra": { inputUsdPerMillion: 2.0, outputUsdPerMillion: 12.0, readAt: "2026-09-16" },
};

/**
 * Per-deployment request TEMPERATURE, because a deployment may REFUSE a value rather than clamp it.
 * MEASURED 2026-09-15 against the live account with the adapter's own URL and api-version:
 * `gpt-oss-120b` answers `temperature: 0` with 200; `gpt-5-nano` answers it with HTTP 400
 * ("does not support 0 with this model. Only the default (1) value is supported").
 *
 * `null` means OMIT THE FIELD ENTIRELY -- not "send 1". The adapter must never assert a
 * temperature it has not measured, and an omitted field is the only way to say "whatever this
 * deployment's default is". W1-T3608.
 *
 * KEYED EXACTLY AS {@link OPENWEIGHT_PRICES}, and read by TABLE LOOKUP -- never a prefix or
 * substring match on the model id (W1-T2573): `gpt-5-nano` and `gpt-5.4-nano` are different
 * deployments with no guarantee of shared behaviour.
 */
/**
 * Which structured-output modes each deployment can actually honour.
 *
 * MEASURED, NOT ASSUMED, with the adapter's own URL and api-version:
 *   gpt-5.6-luna   `response_format: {type:"json_object"}` -> HTTP 200, clean `{"ok":true}`
 *   gpt-5.6-terra  same, HTTP 200
 *   gpt-oss-120b   returns MALFORMED JSON under the same field (the measurement that put
 *                  "Do not add `response_format` here" on spawnOpenWeightWorker)
 *   gpt-5-nano     unmeasured, so it declares nothing and may not be asked
 *
 * A DEPLOYMENT WITH NO ROW SUPPORTS NOTHING, and an unmeasured one is exactly that: the refusal
 * below is what stops a lane silently receiving prose where it required JSON, which is the failure
 * gpt-oss-120b already demonstrated.
 */
export const OPENWEIGHT_RESPONSE_FORMATS: Readonly<Record<string, readonly string[]>> = {
  "gpt-5.6-luna": ["json_object"],
  "gpt-5.6-terra": ["json_object"],
};

/** Raised INSTEAD of sending a structured-output request a deployment cannot honour. Thrown before
 *  transport, like its pricing and temperature siblings, so no reservation is spent proving it. */
export class OpenWeightUnsupportedResponseFormatError extends RmdError {
  readonly deployment: string;
  readonly requested: string;
  constructor(deployment: string, requested: string) {
    const supported = OPENWEIGHT_RESPONSE_FORMATS[deployment] ?? [];
    super(
      "usage",
      1,
      `openweight deployment ${JSON.stringify(deployment)} cannot honour response_format ` +
        `${JSON.stringify(requested)}: ${supported.length ? `supports ${supported.join(", ")}` : "declares no structured-output support"}. ` +
        `Route this lane to a deployment that declares it, or ask for prose and parse defensively.`,
      { deployment, requested },
    );
    this.deployment = deployment;
    this.requested = requested;
  }
}

/** The `response_format` field for one request, or nothing. REFUSES rather than silently dropping
 *  an unsupported request: a caller that asked for JSON and quietly got prose is the exact failure
 *  gpt-oss-120b produced under json_object. */
export function openWeightResponseFormatField(
  deployment: string,
  requested: string | undefined,
): { response_format: { type: string } } | Record<string, never> {
  if (requested === undefined) return {};
  const supported = OPENWEIGHT_RESPONSE_FORMATS[deployment] ?? [];
  if (!supported.includes(requested)) throw new OpenWeightUnsupportedResponseFormatError(deployment, requested);
  return { response_format: { type: requested } };
}

export const OPENWEIGHT_TEMPERATURE: Readonly<Record<string, number | null>> = {
  "gpt-oss-120b": 0,
  "gpt-5-nano": null,
  // MEASURED 2026-09-16 with the adapter's own URL and api-version: `temperature: 0` returns
  // HTTP 400 ("does not support 0 with this model. Only the default (1) value is supported"),
  // byte-identical to nano's refusal. So the field is OMITTED, never sent as 0.
  // Both refuse `temperature: 0` with HTTP 400 ("only the default (1) value is supported"),
  // measured 2026-09-16 -- the same refusal nano gives, so the field is omitted rather than sent.
  "gpt-5.6-luna": null,
  "gpt-5.6-terra": null,
};

/** Raised INSTEAD of guessing a request shape. Thrown before the transport, like its pricing
 *  sibling, so a caller seeing it knows no request was built against an unmeasured deployment. */
export class OpenWeightUnshapedDeploymentError extends RmdError {
  readonly deployment: string;
  constructor(deployment: string) {
    super(
      "usage",
      1,
      `openweight deployment ${JSON.stringify(deployment)} has no request-temperature row: refusing to guess a request shape. ` +
        `Shaped deployments: ${Object.keys(OPENWEIGHT_TEMPERATURE).sort().join(", ")}`,
      { deployment, shaped: Object.keys(OPENWEIGHT_TEMPERATURE).sort() },
    );
    this.deployment = deployment;
  }
}

/**
 * The `temperature` fragment of a request body for one deployment: `{ temperature: n }` when the
 * deployment accepts an explicit value, and `{}` when it accepts only its own default. Spread into
 * the body so "omit" is expressible at all -- a deployment that refuses the field is not satisfied
 * by a null, and `temperature: undefined` still reads as an asserted key at some call sites.
 */
export function openWeightTemperatureField(deployment: string): { temperature?: number } {
  if (!Object.prototype.hasOwnProperty.call(OPENWEIGHT_TEMPERATURE, deployment)) {
    throw new OpenWeightUnshapedDeploymentError(deployment);
  }
  const value = OPENWEIGHT_TEMPERATURE[deployment];
  return value === null ? {} : { temperature: value };
}

/** Raised INSTEAD of pricing a deployment by a neighbour's row. Thrown before the transport, so a
 *  caller seeing it knows no paid request was made against an unknown price. */
export class OpenWeightUnpricedDeploymentError extends RmdError {
  readonly deployment: string;
  constructor(deployment: string) {
    // Kind "usage", the discriminant every refusal-of-a-call in this file carries.
    super(
      "usage",
      1,
      `openweight deployment ${JSON.stringify(deployment)} has no price row: refusing to spend against an unknown rate. ` +
        `Priced deployments: ${Object.keys(OPENWEIGHT_PRICES).sort().join(", ")}`,
      { deployment, priced: Object.keys(OPENWEIGHT_PRICES).sort() },
    );
    this.name = "OpenWeightUnpricedDeploymentError";
    this.deployment = deployment;
  }
}

/** The one lookup. Every consumer of a price — the ledger's cost, the cap's reservation, its
 *  settlement — resolves through here, so none of them can quietly disagree about what a
 *  deployment costs. An absent row FAILS CLOSED; it never falls back to another row. */
export function openWeightPriceFor(deployment: string): OpenWeightPrice {
  const row = OPENWEIGHT_PRICES[deployment];
  if (row === undefined) throw new OpenWeightUnpricedDeploymentError(deployment);
  return row;
}

/** Dollars for one request's measured usage, at that deployment's own rate. */
export function openWeightUsageUsd(deployment: string, promptTokens: number, completionTokens: number): number {
  const price = openWeightPriceFor(deployment);
  return (promptTokens * price.inputUsdPerMillion + completionTokens * price.outputUsdPerMillion) / 1_000_000;
}

/** The allowance file, a pure function of `config.root` the way {@link
 *  import("./ledger-path.js").ledgerPathFor} is — one canonical path, never inlined at a call site. */
export const OPENWEIGHT_ALLOWANCE_FILENAME = "openweight-allowance.json";
export function openWeightAllowancePath(config: Config): string {
  return join(config.root, "state", OPENWEIGHT_ALLOWANCE_FILENAME);
}

/**
 * UTC day key, taken from the {@link Clock} port's own ISO reading rather than from a raw Date
 * constructor.
 *
 * The cap is a CALENDAR-day allowance, so the boundary must not follow the host timezone: two
 * daemons in different zones would otherwise disagree on which day a request spends. Reading the
 * day off `clock.iso()` gets that for free — an ISO-8601 instant is UTC by construction — and keeps
 * this file off the legacy date-construction shape `test/clock-signature-census.test.ts` ratchets
 * down — that census counts the TEXT, so even a comment naming the old shape would raise the row.
 */
export function openWeightUtcDay(atIso: string): string {
  const day = atIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`openweight allowance needs an ISO-8601 instant to derive its UTC day, got ${JSON.stringify(atIso)}`);
  }
  return day;
}

/**
 * One day's committed allowance. `reservations` is keyed by request identity so a settlement can
 * find the row it is settling; a row whose `settledUsd` is still null counts at its CONSERVATIVE
 * `reservedUsd`, which is what keeps a crashed request (one that never reached ANY settlement call
 * -- the process died before its `catch` could run) charged.
 *
 * `settledReason` is present ONLY when a failure, not a usage receipt, is what settled the row --
 * see {@link settleOpenWeightBudget}. Its presence is itself the ledger entry W1-T3666 asks for:
 * an ordinary settle-from-receipt leaves it absent, so a reader can tell "this figure came from
 * the provider's own bill" from "this figure was corrected after the request failed" without
 * parsing anything else.
 */
export interface OpenWeightAllowanceState {
  utcDay: string;
  reservations: Record<string, { reservedUsd: number; settledUsd: number | null; settledReason?: string }>;
}

/** Committed spend = the settled figure where one was read back, the conservative reservation
 *  everywhere else. Never the optimistic sum of settlements alone. */
export function openWeightCommittedUsd(state: OpenWeightAllowanceState): number {
  return Object.values(state.reservations).reduce((total, row) => total + (row.settledUsd ?? row.reservedUsd), 0);
}

/**
 * A conservative upper bound on what one request can cost, in dollars, BEFORE it is sent.
 *
 * Output is bounded exactly: {@link OPENWEIGHT_MAX_COMPLETION_TOKENS} is the ceiling the adapter
 * itself puts on the wire. Input is bounded by the serialized body's BYTE length, which is a strict
 * over-estimate: no tokenizer emits more tokens than the UTF-8 bytes it consumed, so this can never
 * under-reserve. Over-reserving is the safe direction for a cap — settlement corrects it downward.
 */
export function openWeightReservationUsd(
  deployment: string,
  requestBodyBytes: number,
  extraInputTokens = 0,
): number {
  const price = openWeightPriceFor(deployment);
  // `extraInputTokens` is input the request BODY does not contain, and it exists because the
  // byte-bound argument above holds only while the body is the whole input. A server-side tool —
  // `web_search` is the first — makes the provider fetch pages we never sent and bill them as
  // input, so a caller that turns one on MUST declare a ceiling for what it may retrieve or the
  // reservation silently stops being an upper bound. W1-T3558.
  const inputTokenCeiling = requestBodyBytes + Math.max(0, extraInputTokens);
  return (inputTokenCeiling * price.inputUsdPerMillion + OPENWEIGHT_MAX_COMPLETION_TOKENS * price.outputUsdPerMillion) / 1_000_000;
}

/** Raised INSTEAD of sending a paid request. It is thrown before the transport, never after, so a
 *  caller that sees it knows no money was spent on the refused attempt. */
export class OpenWeightAllowanceExhaustedError extends RmdError {
  readonly committedUsd: number;
  readonly capUsd: number;
  readonly wantUsd: number;
  constructor(detail: { committedUsd: number; capUsd: number; wantUsd: number; utcDay: string }) {
    // Kind "usage", the same discriminant `GhReadCadenceRefusal` carries: both are a LIMIT refusing
    // a call that was otherwise well-formed, not a malformed request. Adopting the shared envelope
    // rather than extending `Error` directly is what `test/error-subclass-census.test.ts` asks a new
    // class to do — its ceiling is a ratchet, so a new direct subclass would have to raise it.
    super(
      "usage",
      1,
      `openweight daily allowance exhausted for ${detail.utcDay}: committed $${detail.committedUsd.toFixed(6)} + ` +
        `$${detail.wantUsd.toFixed(6)} would exceed the $${detail.capUsd.toFixed(2)} dailyCapUsd`,
      { committedUsd: detail.committedUsd, capUsd: detail.capUsd, wantUsd: detail.wantUsd, utcDay: detail.utcDay },
    );
    this.name = "OpenWeightAllowanceExhaustedError";
    this.committedUsd = detail.committedUsd;
    this.capUsd = detail.capUsd;
    this.wantUsd = detail.wantUsd;
  }
}

/** How many times a compare-and-swap may lose its race before the reservation gives up. A loss
 *  needs a PEER to have committed between this call's read and its rename, so a handful of retries
 *  covers any realistic interleaving; the bound only stops a pathological peer spinning us forever. */
export const OPENWEIGHT_ALLOWANCE_CAS_ATTEMPTS = 12;

/**
 * Read-modify-write the allowance file atomically ACROSS PROCESSES.
 *
 * `writeAtomic`'s `beforeRename` is the compare-and-swap: the new state is staged in the same
 * directory, then, immediately before the rename commits it, the live file is re-read and compared
 * to the exact bytes this attempt planned from. A peer that committed in that window changes those
 * bytes, the stage is withdrawn, and the whole read-modify-write retries against the peer's
 * committed state. That is what makes two concurrent daemon workers unable to spend the same
 * allowance twice — a plain read-then-write would lose one of the two updates.
 *
 * Durability across a restart is the file itself: every committed reservation is on disk before the
 * request it pays for is sent, so a process that dies mid-request comes back to a state that still
 * counts that reservation.
 */
function mutateOpenWeightAllowance<T>(
  path: string,
  utcDay: string,
  mutate: (state: OpenWeightAllowanceState) => { next: OpenWeightAllowanceState; result: T },
  beforeCommit?: () => void,
): T {
  for (let attempt = 1; ; attempt++) {
    const snapshot = readFileIfExists(path);
    let state: OpenWeightAllowanceState | undefined;
    if (snapshot !== undefined) {
      // FAIL CLOSED ON AN UNREADABLE ALLOWANCE. A corrupt or truncated file is the one case where
      // "start fresh" is actively dangerous: it hands the whole day's cap back, so a single bad
      // write — or anything that can damage this file — silently uncaps paid spend. An ABSENT file
      // is a genuine "nothing spent yet"; a PRESENT file we cannot read is unknown spend, and
      // unknown spend is refused rather than assumed to be zero. Clearing it is an operator act.
      let parsed: Partial<OpenWeightAllowanceState>;
      try {
        parsed = JSON.parse(snapshot) as Partial<OpenWeightAllowanceState>;
      } catch (error) {
        throw new Error(
          `openweight allowance file is unreadable at ${path}; refusing to spend against an unknown committed total ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (typeof parsed.utcDay !== "string" || parsed.reservations === null || typeof parsed.reservations !== "object") {
        throw new Error(`openweight allowance file at ${path} has no readable utcDay/reservations; refusing to spend against an unknown committed total`);
      }
      state = { utcDay: parsed.utcDay, reservations: parsed.reservations as OpenWeightAllowanceState["reservations"] };
    }
    // A different UTC day starts a fresh allowance: yesterday's committed spend must not consume
    // today's cap, and must not be carried forward as credit either. This is the ONLY reset.
    if (state === undefined || state.utcDay !== utcDay) state = { utcDay, reservations: {} };

    const { next, result } = mutate(state);
    // TEST-ONLY seam, in the shape {@link import("./fs-race-safe.js").reclaimStaleLock}'s own
    // `beforeDelete` already uses: a test runs a PEER's entire reservation here, inside this
    // attempt's read-to-rename window, so the compare-and-swap below is exercised deterministically
    // rather than by hoping two real processes happen to interleave.
    beforeCommit?.();
    const committed = writeAtomic(path, `${JSON.stringify(next)}\n`, {
      tmpTag: "openweight-allowance",
      // THE COMPARE-AND-SWAP. Re-read the live file and refuse to commit unless it is still the
      // exact bytes this attempt planned from.
      beforeRename: () => readFileIfExists(path) === snapshot,
    });
    if (committed) return result;
    if (attempt >= OPENWEIGHT_ALLOWANCE_CAS_ATTEMPTS) {
      throw new Error(`openweight allowance contention: ${OPENWEIGHT_ALLOWANCE_CAS_ATTEMPTS} compare-and-swap attempts lost at ${path}`);
    }
  }
}

/**
 * Commit a conservative reservation for ONE outbound request, or refuse it.
 *
 * Called before the transport, never after. On refusal nothing is committed and {@link
 * OpenWeightAllowanceExhaustedError} is thrown by the caller, so no paid request is made.
 */
/**
 * the cash ceiling for THIS request's UTC day.
 *
 * A plain number is the whole cap, exactly as before. A pair raises it only when the request
 * reached cash because the capacity auction found NO subscription with readable headroom -- the
 * W1-T3692 fallback -- so routine mount-affinity work stays on the lower figure and the higher one
 * is reachable only on a day the subscriptions are genuinely tapped out.
 *
 * IT IS A CEILING, NOT A BUDGET. `squeezed` does not authorise spending more; it stops the cap
 * refusing work on the one day cash is the only thing that can do it.
 *
 * REFUSES A PAIR THAT INVERTS. A `squeezed` below `normal` would mean the squeeze DAY buys less
 * than an ordinary one, which is never what an operator means -- far likelier a transposition, and
 * silently honouring it would cap the fleet hardest exactly when it is most constrained.
 */
export function effectiveCashCapUsd(
  cap: number | { normal: number; squeezed: number } | null | undefined,
  opts: { squeezed?: boolean } = {},
): number | undefined {
  if (cap === undefined || cap === null) return undefined;
  if (typeof cap === "number") return cap;
  const { normal, squeezed } = cap;
  if (!Number.isFinite(normal) || !Number.isFinite(squeezed)) {
    throw new Error(`dailyCapUsd pair must be two finite numbers, got normal=${String(normal)} squeezed=${String(squeezed)}`);
  }
  if (squeezed < normal) {
    throw new Error(
      `dailyCapUsd.squeezed ($${squeezed}) is below dailyCapUsd.normal ($${normal}) — refusing: a squeeze day must not buy ` +
        `LESS than an ordinary one. If the two were transposed, swap them.`,
    );
  }
  return opts.squeezed === true ? squeezed : normal;
}

export function reserveOpenWeightBudget(
  config: Config,
  input: {
    requestId: string;
    deployment: string;
    requestBodyBytes: number;
    atIso: string;
    beforeCommit?: () => void;
    /** true when this request reached cash only because no subscription had readable
     *  headroom. Selects `dailyCapUsd.squeezed` over `.normal`; ignored for a plain-number cap. */
    squeezed?: boolean;
    /** Input tokens this request may consume that its body does NOT carry — see
     *  {@link openWeightReservationUsd}. Omitted for an ordinary chat turn. */
    extraInputTokens?: number;
  },
): { reservedUsd: number; committedUsd: number; capUsd: number } {
  const capUsd = effectiveCashCapUsd(config.dailyCapUsd, { squeezed: input.squeezed });
  // validateConfig already refuses an enabled cash provider (W1-T3607: canonical id, "openweight"
  // accepted as a deprecated alias) with no dailyCapUsd. This is the runtime half of that same rule:
  // an absent cap here means the transport must not run at all, rather than defaulting to unlimited.
  if (capUsd === undefined || capUsd === null) {
    throw new Error("cash provider requires a dailyCapUsd before any paid request");
  }
  const utcDay = openWeightUtcDay(input.atIso);
  const wantUsd = openWeightReservationUsd(input.deployment, input.requestBodyBytes, input.extraInputTokens ?? 0);
  return mutateOpenWeightAllowance(openWeightAllowancePath(config), utcDay, (state) => {
    const committedUsd = openWeightCommittedUsd(state);
    if (committedUsd + wantUsd > capUsd) {
      throw new OpenWeightAllowanceExhaustedError({ committedUsd, capUsd, wantUsd, utcDay });
    }
    return {
      next: { ...state, reservations: { ...state.reservations, [input.requestId]: { reservedUsd: wantUsd, settledUsd: null } } },
      result: { reservedUsd: wantUsd, committedUsd: committedUsd + wantUsd, capUsd },
    };
  }, input.beforeCommit);
}

/**
 * Settle a committed reservation DOWN, either to the provider's own reported usage, or — W1-T3666
 * — to the input-only portion of the same conservative estimate when the request FAILED before any
 * usage could be read.
 *
 * `reason`, present only on the failure path, is what makes settlement recorded rather than
 * inferred: an ordinary settle-from-receipt passes nothing, so the ledger row itself distinguishes
 * a bill it actually read from a figure it corrected after a failure (see
 * {@link OpenWeightAllowanceState}). Settlement never raises a reservation above what was
 * reserved; the reservation is a ceiling either way.
 */
export function settleOpenWeightBudget(
  config: Config,
  input: { requestId: string; actualUsd: number; atIso: string; reason?: string },
): void {
  const utcDay = openWeightUtcDay(input.atIso);
  mutateOpenWeightAllowance(openWeightAllowancePath(config), utcDay, (state) => {
    const row = state.reservations[input.requestId];
    // A reservation that is no longer present (a UTC-day rollover between reserve and settle)
    // must not be re-created here: doing so would charge today's cap for yesterday's request.
    if (row === undefined) return { next: state, result: undefined };
    return {
      next: {
        ...state,
        reservations: {
          ...state.reservations,
          [input.requestId]: {
            ...row,
            settledUsd: Math.min(input.actualUsd, row.reservedUsd),
            ...(input.reason !== undefined ? { settledReason: input.reason } : {}),
          },
        },
      },
      result: undefined,
    };
  });
}

export interface OpenWeightSpawnArgs {
  /** set ONLY by W1-T3692's blocked-auction fallback. Selects `dailyCapUsd.squeezed`
   *  over `.normal` for every reservation this run makes. */
  cashSqueezed?: boolean;
  cwd: string;
  prompt: string;
  workerHome: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  runId?: string;
  taskId?: string;
  /** Opt-in structured output, e.g. "json_object". Honoured only by a deployment that
   *  DECLARES it (OPENWEIGHT_RESPONSE_FORMATS); asking an undeclared one REFUSES before transport
   *  rather than sending a field it mishandles. Absent means prose, which is every lane's default
   *  and must stay so -- forcing JSON on a prose lane is the mistake OPENWEIGHT_OUTPUT_CONTRACT
   *  already warns about. */
  responseFormat?: string;
  /** Test-only override; production uses the global fetch implementation. */
  fetchImpl?: typeof fetch;
  /** The request deadline, defaulting to {@link OPENWEIGHT_REQUEST_TIMEOUT_MS}. A seam ONLY so a
   *  test can reach the aborted arm of the catch below: with the real 180s bound, covering it means
   *  a test that waits three minutes, and an uncovered catch arm is how a refusal quietly stops
   *  refusing. Production passes nothing and gets the constant. */
  requestTimeoutMs?: number;
  /** Test-only override; production reads the daemon process environment. */
  env?: NodeJS.ProcessEnv;
  /** Test-only clock port; production records duration from the system clock. `iso` rides beside
   *  `now` because the daily allowance keys on a UTC calendar day, which is read off the ISO
   *  instant rather than re-derived from milliseconds. */
  clock?: Pick<Clock, "now" | "iso">;
}

export interface OpenWeightWorkerResult {
  // W1-T3607: the canonical runtime provider id — "cash", never the deprecated "openweight" config
  // spelling. No out-of-scope caller asserts this literal value (only import symbol names, which stay
  // unchanged; see this task's PR body for the deliberate scoping).
  provider: "cash";
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
  permissionDenials: unknown[];
  /** This adapter runs in the daemon, not a child worker process. The Azure key is absent. */
  childEnvKeys: string[];
  model: string;
  routedModel?: string;
  effort: string;
  selectionAssignmentId?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  modelUsage: Record<string, never>;
  compactionEvents: [];
  compactionFailures: [];
  compactionConfigured: false;
  qualitySuspect: false;
  workerDurationMs: number;
  /** Brokered web search, metered apart from conversation tokens (W1-T3558). `webSearchUsd` is
   *  INCLUDED in `costUsd` and in `budgetSettledUsd` — it is a breakdown of the bill, not an
   *  addition to it. A refused search still counts in `webSearchRefused` and still costs, because
   *  the provider billed the attempt whatever we decided to do with its answer. */
  webSearchAttempted: number;
  webSearchAccepted: number;
  webSearchRefused: number;
  webSearchUsd: number;
  /** Attributable cash fields for the ledger. Money, not prompts: no request body, no response
   *  text and no credential is carried here. `budgetRefused` is true only when the daily allowance
   *  refused this run BEFORE any paid request was made. */
  budgetReservedUsd: number;
  budgetSettledUsd: number;
  budgetRefused: boolean;
}

type OpenWeightMessage = Record<string, unknown>;
type OpenWeightToolCall = { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };

/** The tools this adapter actually implements. EXPORTED so a lane's declared bound can be
 *  checked against it at test time rather than discovered as a throw at spawn (W1-T3656). */
export const OPENWEIGHT_FUNCTIONS: Record<string, { name: string; description: string; required: string[] }> = {
  Read: { name: "read_file", description: "Read a UTF-8 file under the worker cwd.", required: ["path"] },
  Write: { name: "write_file", description: "Write a UTF-8 file under the worker cwd.", required: ["path", "content"] },
  Edit: { name: "edit_file", description: "Replace one exact UTF-8 string in a file under the worker cwd.", required: ["path", "old_string", "new_string"] },
  Grep: { name: "grep_files", description: "Find a literal string in UTF-8 files under the worker cwd.", required: ["query"] },
  Glob: { name: "glob_files", description: "List files under the worker cwd by a suffix-like pattern.", required: ["pattern"] },
  RunCheck: { name: "run_check", description: "Run ONE permitted repository check by name (unit_test, typecheck). Fixed argv: it takes no paths or flags. No shell; no network.", required: ["check"] },
};

/** Checks an open-weight worker may run, as fixed argv — never a command string (W1-T3617).
 *  NOTHING HERE MAY REACH THE NETWORK OR THE FORGE (no git/gh/curl/install): the worker produces a
 *  diff and the ORCHESTRATOR pushes, the boundary hooks/deny-floor.sh already enforces. */
export const OPENWEIGHT_CHECKS: Readonly<Record<string, readonly string[]>> = {
  unit_test: ["node", "--import", "tsx", "--test"],
  typecheck: ["node_modules/.bin/tsc", "-p", "tsconfig.json", "--noEmit"],
  // READ-ONLY git, SUBCOMMAND PINNED. W1-T3572's "no git" meant no FORGE authority; these carry no
  // push and no network, and are what the recon/diagnose prompts name. `git push` is absent, not
  // one entry away. Caller args are contained PATHS, which resolve absolute and cannot be flags.
  git_log: ["git", "log", "--oneline", "-20"],
  git_status: ["git", "status", "--porcelain"],
  git_diff: ["git", "diff"],
  git_remote: ["git", "remote", "-v"],
};

/** Read-only git subcommands the table may use. Enforced over the table by test. */
export const OPENWEIGHT_READONLY_GIT_SUBCOMMANDS: readonly string[] = ["log", "status", "diff", "remote", "show"];

/** PRIMARY CONTROL: wall-clock bound on one check. Nothing else stops a hung check process — the
 *  cash cap bounds spend, this bounds time — so this is what normally ends the loop, not a
 *  fallback behind some other limit. */
export const OPENWEIGHT_CHECK_TIMEOUT_MS = 10 * 60_000;

/** Raised INSTEAD of executing an unlisted check, before any process spawns. */
export class OpenWeightUnlistedCheckError extends RmdError {
  readonly check: string;
  constructor(check: string) {
    super(
      "usage",
      1,
      `openweight check ${JSON.stringify(check)} is not permitted: refusing to run a command this adapter does not declare. ` +
        `Permitted checks: ${Object.keys(OPENWEIGHT_CHECKS).sort().join(", ")}`,
      { check, permitted: Object.keys(OPENWEIGHT_CHECKS).sort() },
    );
    this.check = check;
  }
}

/**
 * Argv for one permitted check. EVERY ARGUMENT IS A CONSTANT — the caller chooses a check by NAME
 * and contributes nothing else to the command line.
 *
 * WHY FIXED RATHER THAN SANITIZED. An earlier revision appended model-supplied paths through
 * {@link openWeightContainedPath}, which is real containment: a flag-shaped argument resolves to a
 * file under the worktree and is inert. CodeQL flagged it anyway — "this command line depends on a
 * user-provided value" — and it was right to. Every other `execFileSync` in this repo passes
 * internally-derived arguments; that revision was the FIRST model-derived value to reach a command
 * line, and `.github/codeql/codeql-config.yml` excludes only `test/`, so the repo has no
 * suppression precedent to lean on. A sanitizer the analyser cannot see is a sanitizer the next
 * reader cannot see either.
 *
 * THE COST, STATED: a lane cannot scope `unit_test` to one file, so it runs the whole suite.
 * That is the read-only lanes' actual need (git status/diff/log and typecheck take no path), and
 * re-admitting caller arguments is a separate, deliberate decision rather than a default. */
export function openWeightCheckArgv(check: unknown, paths: unknown): string[] {
  if (typeof check !== "string" || !Object.prototype.hasOwnProperty.call(OPENWEIGHT_CHECKS, check)) {
    throw new OpenWeightUnlistedCheckError(typeof check === "string" ? check : String(check));
  }
  // REFUSED, NOT IGNORED. A model told its scoped check ran, when the whole suite ran instead,
  // would read the wrong result off a green — so an unusable argument is an error, never a no-op.
  if (paths !== undefined) {
    throw new OpenWeightUnlistedCheckError(`${check} with caller arguments — every check runs a FIXED argv`);
  }
  return [...OPENWEIGHT_CHECKS[check]];
}

/** The one tool the adapter does NOT execute itself: the daemon brokers it. Declared to the model
 *  only when the operator has consented, so without consent `WebSearch` stays unimplemented and the
 *  refusal below fires exactly as it did before W1-T3558. */
export const CASH_WEB_SEARCH_FUNCTION = {
  name: "web_search",
  description:
    "Search the public web for current information. The daemon performs the search; you never reach the network. " +
    "A result is returned only when the search actually ran and produced at least one source URL, and every " +
    "returned document carries its sources. If the search is refused, do not invent the answer — say what is unknown.",
  required: ["query"],
} as const;

function openWeightTools(
  declared: readonly string[] | undefined,
  webSearch = false,
): Array<Record<string, unknown>> {
  const requested = [...new Set(declared ?? [])];
  const brokered: string[] = webSearch ? requested.filter((tool) => tool === "WebSearch") : [];
  const unsupported = requested.filter(
    (tool) => OPENWEIGHT_FUNCTIONS[tool] === undefined && !brokered.includes(tool),
  );
  // Never silently drop a declared tool: the prompt may rely on it (for example triage's
  // WebSearch), and a partial capability set would make the model fabricate a missing result.
  if (unsupported.length > 0) throw new Error(`openweight adapter does not implement declared tool(s): ${unsupported.join(", ")}`);
  return requested
    .map((tool) => (brokered.includes(tool) ? CASH_WEB_SEARCH_FUNCTION : OPENWEIGHT_FUNCTIONS[tool]!))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(tool.required.map((name) => [name, { type: "string" }])),
          required: tool.required,
          additionalProperties: false,
        },
      },
    }));
}

function openWeightContainedPath(cwd: string, candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("tool path must be a non-empty string");
  const root = realpathSync(cwd);
  const target = resolve(root, candidate);
  let existing = target;
  // A declared Write may create nested paths. Resolve the nearest existing parent before the
  // write, so a missing child cannot turn containment into an ENOENT bypass.
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const physical = realpathSync(existing);
  const rel = relative(root, physical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("tool path escapes the worker cwd");
  }
  return target;
}

function openWeightFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) openWeightFiles(path, out);
    else if (entry.isFile()) out.push(path);
    if (out.length >= 100) return out;
  }
  return out;
}

function objectArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") throw new Error("tool arguments must be JSON text");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

function executeOpenWeightTool(name: string, args: Record<string, unknown>, cwd: string): unknown {
  switch (name) {
    case "read_file":
      return { content: readFileSync(openWeightContainedPath(cwd, args.path), "utf8") };
    case "write_file": {
      if (typeof args.content !== "string") throw new Error("write_file content must be a string");
      const path = openWeightContainedPath(cwd, args.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.content, "utf8");
      return { written: relative(realpathSync(cwd), path) };
    }
    case "edit_file": {
      if (typeof args.old_string !== "string" || typeof args.new_string !== "string") throw new Error("edit_file strings must be strings");
      const path = openWeightContainedPath(cwd, args.path);
      const before = readFileSync(path, "utf8");
      const at = before.indexOf(args.old_string);
      if (at < 0 || before.indexOf(args.old_string, at + args.old_string.length) >= 0) {
        throw new Error("edit_file old_string must match exactly once");
      }
      writeFileSync(path, `${before.slice(0, at)}${args.new_string}${before.slice(at + args.old_string.length)}`, "utf8");
      return { edited: relative(realpathSync(cwd), path) };
    }
    case "run_check": {
      // W1-T3617. Argv BUILT FIRST, so an unlisted check refuses before anything spawns; execFileSync
      // takes an array and never a shell, so metacharacters are inert rather than discouraged.
      const argv = openWeightCheckArgv(args.check, args.paths);
      const [command, ...rest] = argv;
      try {
        const stdout = execFileSync(command, rest, {
          cwd: realpathSync(cwd),
          encoding: "utf8",
          timeout: OPENWEIGHT_CHECK_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { check: args.check, exitCode: 0, output: stdout.slice(-20_000) };
      } catch (err) {
        // A FAILING CHECK IS A RESULT, NOT AN ERROR — the lane must read its own red. A refusal above
        // still throws, because that is not a result.
        const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
        const out = `${String(e.stdout ?? "")}${String(e.stderr ?? "")}`;
        return { check: args.check, exitCode: typeof e.status === "number" ? e.status : 1, output: out.slice(-20_000) };
      }
    }
    case "grep_files": {
      if (typeof args.query !== "string" || args.query.length === 0) throw new Error("grep_files query must be a non-empty string");
      const query = args.query;
      const root = realpathSync(cwd);
      const matches = openWeightFiles(root).flatMap((path) => {
        const lines = readFileSync(path, "utf8").split("\n");
        return lines.flatMap((line, index) => line.includes(query) ? [{ path: relative(root, path), line: index + 1, text: line.slice(0, 500) }] : []);
      }).slice(0, 100);
      return { matches };
    }
    case "glob_files": {
      if (typeof args.pattern !== "string" || args.pattern.length === 0) throw new Error("glob_files pattern must be a non-empty string");
      const root = realpathSync(cwd);
      const suffix = args.pattern.replace(/^\*+/, "");
      return { paths: openWeightFiles(root).filter((path) => path.endsWith(suffix)).map((path) => relative(root, path)).slice(0, 100) };
    }
    default:
      throw new Error(`openweight tool '${name}' is not implemented`);
  }
}

/**
 * A NON-OPENAI DEPLOYMENT NEEDS NO SECOND SHAPE HERE. W1-T3598 ruled the wider catalog out on the
 * premise that its cheapest non-OpenAI candidate "sits behind the Azure AI Model Inference
 * `/models` route instead and would need an endpoint branch". W1-T3695 re-probed BOTH routes
 * against a live DeepSeek-V4-Flash deployment (non-OpenAI family) on the same account:
 *
 *   POST {endpoint}/models/chat/completions                   -> HTTP 200
 *   POST {endpoint}/openai/deployments/DeepSeek-V4-Flash/...  -> HTTP 200
 *
 * The second IS this function's own path. The deployment answered it unchanged -- tool calls
 * (`finish_reason: tool_calls`), `temperature: 0` (HTTP 200, unlike the gpt-5 family's 400) and
 * `response_format: json_object` all measured clean against it. So this class rides the adapter's existing route
 * with no second endpoint shape required, and the branch W1-T3598 deferred is not needed for it
 * at all.
 *
 * IT IS STILL NOT WIRED INTO {@link OPENWEIGHT_PRICES}, deliberately. No published rate for
 * DeepSeek-V4-Flash could be confirmed (absent from the pricing page, the retail prices API and
 * the catalog's `cost` field), and its billing is publicly disputed -- Microsoft Q&A threads
 * report ~357x the published rate on cached tokens and 4.5x on V4 Pro. `OPENWEIGHT_PRICES`'s own
 * contract is that a deployment with no row is refused rather than priced by a neighbour (see
 * {@link openWeightPriceFor}), so naming this deployment in the cash ladder before a bill
 * confirms its real rate would convert a disputed page number into an under-reservation. The
 * route is proven here; the price is not, and only an OBSERVED bill (not this recon) closes that
 * gap (W1-T3695).
 */
function openWeightEndpoint(config: Config, model: string): string {
  // W1-T3607: canonical `cashEndpoint` first, falling back to the deprecated `openweightEndpoint`
  // spelling so an already-deployed host's config.json need not be hand-edited the moment this ships.
  const raw = config.workerProviders?.cashEndpoint ?? config.workerProviders?.openweightEndpoint;
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("cash provider requires workerProviders.cashEndpoint");
  const endpoint = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  if (endpoint.protocol !== "https:") throw new Error("cash endpoint must use https");
  return new URL(`openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-10-21`, endpoint).toString();
}

function openWeightResult(input: {
  model: string;
  effort: string;
  startedAt: number;
  clock: Pick<Clock, "now" | "iso">;
  text?: string;
  sessionId?: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  error?: unknown;
  budgetReservedUsd?: number;
  budgetSettledUsd?: number;
  budgetRefused?: boolean;
  webSearchAttempted?: number;
  webSearchAccepted?: number;
  webSearchRefused?: number;
  webSearchUsd?: number;
}): OpenWeightWorkerResult {
  const text = input.text ?? "";
  const error = input.error instanceof Error ? input.error.message : input.error === undefined ? undefined : String(input.error);
  return {
    provider: "cash",
    sessionId: input.sessionId ?? "",
    // ZERO USAGE COSTS ZERO AT ANY RATE, so it needs no price row. That is not a convenience: this
    // result is also built on the ERROR path, and one way to get here is the refusal raised when a
    // deployment has NO row. Pricing unconditionally would throw a second time out of the catch
    // that is meant to turn a failure into a reportable result, so the refusal would escape
    // `spawnOpenWeightWorker` instead of being returned — collapsing the very contract the catch
    // exists to hold. A run that never reached the transport has no tokens, hence no cost, and
    // saying so requires no rate.
    costUsd:
      (input.promptTokens === 0 && input.completionTokens === 0
        ? 0
        : openWeightUsageUsd(input.model, input.promptTokens, input.completionTokens)) +
      // Brokered searches are billed on a DIFFERENT API than the conversation, so their tokens are
      // not in `promptTokens`/`completionTokens` and pricing those alone would understate the run.
      (input.webSearchUsd ?? 0),
    numTurns: input.turns,
    maxTurns: undefined,
    text,
    blocks: text ? [text] : [],
    stderr: error ?? "",
    subtype: error ? "openweight_error" : "success",
    isError: error !== undefined,
    apiError: error !== undefined,
    permissionDenials: [],
    childEnvKeys: [],
    model: input.model,
    effort: input.effort,
    tokens: { input: input.promptTokens, output: input.completionTokens, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    compactionFailures: [],
    compactionConfigured: false,
    qualitySuspect: false,
    workerDurationMs: input.clock.now() - input.startedAt,
    budgetReservedUsd: input.budgetReservedUsd ?? 0,
    budgetSettledUsd: input.budgetSettledUsd ?? 0,
    budgetRefused: input.budgetRefused ?? false,
    webSearchAttempted: input.webSearchAttempted ?? 0,
    webSearchAccepted: input.webSearchAccepted ?? 0,
    webSearchRefused: input.webSearchRefused ?? 0,
    webSearchUsd: input.webSearchUsd ?? 0,
  };
}

/** Run one bounded OpenAI-compatible Azure conversation.
 *
 * `response_format` is now PER DEPLOYMENT, not forbidden outright. The original
 * prohibition was measured against gpt-oss-120b, which returns malformed JSON under json_object --
 * that deployment still declares no support and still refuses. The gpt-5.6 deployments answer it
 * correctly, so they declare it and a caller may opt in through `args.responseFormat`. */
export async function spawnOpenWeightWorker(
  args: OpenWeightSpawnArgs,
  config: Config,
  selection: Pick<OpenWeightModelSelection, "model" | "effort">,
): Promise<OpenWeightWorkerResult> {
  const clock = args.clock ?? systemClock;
  const startedAt = clock.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let turns = 0;
  let sessionId = "";
  let text = "";
  let budgetReservedUsd = 0;
  let budgetSettledUsd = 0;
  // W1-T3666: the reservation the CURRENT turn is still carrying, cleared the instant its own
  // settlement question (settle down from a receipt, or leave the conservative figure standing --
  // see the usage block below) is decided. If the turn throws before that point, this is what the
  // outer `catch` settles down instead of stranding: everything before it in a PRIOR turn already
  // reached its own decision and is no longer "pending".
  let pendingReservation: { requestId: string; deployment: string; requestBodyBytes: number } | undefined;
  // Metered SEPARATELY from conversation turns (W1-T3558). They share the day cap — one cap is the
  // only way it bounds total Azure spend — but are counted apart so an operator can read what web
  // access cost, and how often it was refused, without inferring it from a conversation total.
  let webSearchAttempted = 0;
  let webSearchAccepted = 0;
  let webSearchRefused = 0;
  let webSearchUsd = 0;
  // Identity for this run's reservations. The run id is not sufficient on its own: the tool loop
  // sends one paid request PER TURN, and each needs its own settleable row.
  const runRequestPrefix = `${args.runId ?? args.taskId ?? "openweight"}-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const env = args.env ?? process.env;
    const webSearchConsented = cashWebSearchEnabled(config);
    const tools = openWeightTools(args.tools, webSearchConsented);
    const key = env[OPENWEIGHT_API_KEY_ENV];
    if (!key) throw new Error(`openweight provider requires ${OPENWEIGHT_API_KEY_ENV} in the daemon environment`);
    const declaredNames = new Set(tools.map((tool) => String((tool.function as { name?: unknown }).name)));
    const messages: OpenWeightMessage[] = [
      { role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT },
      { role: "user", content: args.prompt },
    ];
    const maxTurns = args.maxTurns ?? 1;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) throw new Error("openweight maxTurns must be a positive integer");
    // BOTH PER-DEPLOYMENT LOOKUPS ARE RESOLVED ONCE, HERE, AND PRICE GOES FIRST. They are
    // loop-invariant -- `selection.model` cannot change between turns -- but the ORDER is the
    // load-bearing part, not the hoist: an unknown deployment must refuse on its missing PRICE
    // row (W1-T3597's contract, "refuses before transport rather than borrowing a rate"), not on
    // its missing request-shape row. Building the body first put the shape lookup ahead of the
    // reservation and silently changed that refusal's message. W1-T3608.
    openWeightPriceFor(selection.model);
    const temperatureField = openWeightTemperatureField(selection.model);
    // Resolved ONCE, beside the temperature field and before the turn loop, so an unsupported
    // request refuses before the first reservation rather than once per turn.
    const responseFormatField = openWeightResponseFormatField(selection.model, args.responseFormat);
    for (;;) {
      turns += 1;
      const body = JSON.stringify({
        model: selection.model,
        messages,
        ...temperatureField,
        ...responseFormatField,
        max_completion_tokens: OPENWEIGHT_MAX_COMPLETION_TOKENS,
        ...(declaredNames.size > 0 ? { tools, tool_choice: "auto" } : {}),
      });
      // THE CAP IS ENFORCED HERE, NOT IN CONFIGURATION. Every turn of the tool loop is its own paid
      // Azure request, so each one reserves before it is sent. A refusal throws out of this loop
      // with no `fetch` performed, which is what makes `dailyCapUsd` a spend bound rather than a
      // declared intention. Reserve FIRST, then send: the reservation is committed to disk before
      // the money can be spent, so a crash between the two leaves the allowance charged, never free.
      const requestId = `${runRequestPrefix}-${turns}`;
      const requestBodyBytes = Buffer.byteLength(body, "utf8");
      const reservation = reserveOpenWeightBudget(config, {
        requestId,
        deployment: selection.model,
        requestBodyBytes,
        atIso: clock.iso(),
        squeezed: args.cashSqueezed === true,
      });
      budgetReservedUsd += reservation.reservedUsd;
      // ARMED THE MOMENT THE RESERVATION COMMITS, CLEARED ONLY ONCE ITS SETTLEMENT IS DECIDED
      // (below). Anything that throws in between -- a transport error, a non-2xx status, an
      // unparseable body -- leaves this set, which is exactly what the outer `catch` reads to know
      // there is a reservation still to settle down (W1-T3666).
      pendingReservation = { requestId, deployment: selection.model, requestBodyBytes };
      // THE DEADLINE IS ARMED AROUND THE REQUEST, AND THE RESERVATION IS ALREADY COMMITTED. An
      // abandoned request keeps its charge on purpose: the endpoint may have served and billed it,
      // so handing the allowance back would let a timeout buy free authority against `dailyCapUsd`.
      const abort = new AbortController();
      const requestTimeoutMs = args.requestTimeoutMs ?? OPENWEIGHT_REQUEST_TIMEOUT_MS;
      const deadline = setTimeout(() => abort.abort(), requestTimeoutMs);
      let response: Response;
      try {
        response = await (args.fetchImpl ?? fetch)(openWeightEndpoint(config, selection.model), {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": key },
          body,
          signal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.aborted) throw new OpenWeightRequestTimeoutError(requestTimeoutMs, selection.model);
        throw error;
      } finally {
        clearTimeout(deadline);
      }
      if (!response.ok) throw new Error(`openweight request failed with HTTP ${response.status}`);
      const payload = await response.json() as {
        id?: unknown;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
      };
      sessionId = typeof payload.id === "string" ? payload.id : sessionId;
      const turnPromptTokens = typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : 0;
      const turnCompletionTokens = typeof payload.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : 0;
      promptTokens += turnPromptTokens;
      completionTokens += turnCompletionTokens;
      // SETTLE DOWN ONLY FROM A RECEIPT WE COULD ACTUALLY READ. A response carrying no usage block
      // settles at 0 tokens, which would silently hand the allowance back for a request that really
      // was billed — so an absent receipt leaves the conservative reservation standing instead.
      if (typeof payload.usage?.prompt_tokens === "number" || typeof payload.usage?.completion_tokens === "number") {
        const actualUsd = openWeightUsageUsd(selection.model, turnPromptTokens, turnCompletionTokens);
        settleOpenWeightBudget(config, { requestId, actualUsd, atIso: clock.iso() });
        budgetSettledUsd += actualUsd;
      } else {
        budgetSettledUsd += reservation.reservedUsd;
      }
      // THIS TURN'S SETTLEMENT QUESTION IS NOW DECIDED, one way or the other, so it is no longer
      // "pending" for the failure-settlement catch below -- a later throw in this same turn (an
      // undeclared tool, `maxTurns` exceeded) must not re-settle a row already resolved above.
      pendingReservation = undefined;
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("openweight response has no assistant message");
      // A TRUNCATED REPLY IS A NAMED FAILURE, NOT A SHORT ANSWER. Checked AFTER settlement above so
      // the turn is still billed honestly -- the tokens were spent whether or not the answer is
      // usable -- and before the content can be returned or appended to the conversation.
      if (openWeightReplyIsTruncated(payload.choices?.[0]?.finish_reason)) {
        throw new OpenWeightTruncatedReplyError(String(payload.choices?.[0]?.finish_reason), turnCompletionTokens);
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls as OpenWeightToolCall[] : [];
      // UNFENCED ONLY WHEN A STRUCTURED REPLY WAS ASKED FOR. A prose lane may legitimately contain a
      // fenced code block as part of its answer, and unwrapping that would corrupt it; a lane that
      // requested `responseFormat` asked for a document, so a fence around the whole reply is a
      // wrapper rather than content.
      if (typeof message.content === "string") {
        text = args.responseFormat === undefined ? message.content : openWeightUnfence(message.content);
      }
      if (calls.length === 0) return openWeightResult({ model: selection.model, effort: selection.effort, startedAt, clock, text, sessionId, turns, promptTokens, completionTokens, budgetReservedUsd, budgetSettledUsd, webSearchAttempted, webSearchAccepted, webSearchRefused, webSearchUsd });
      if (turns >= maxTurns) throw new Error(`openweight tool loop exceeded maxTurns=${maxTurns}`);
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        const id = call.id;
        if (typeof name !== "string" || !declaredNames.has(name) || typeof id !== "string") {
          throw new Error("openweight response requested an undeclared tool");
        }
        let content: string;
        try {
          // `web_search` is the one declared tool this process does not execute: the daemon brokers
          // it against a different API, with its own credential, and returns a document only when
          // the provider actually searched and cited a source.
          content = name === CASH_WEB_SEARCH_FUNCTION.name
            ? JSON.stringify(
                await brokerCashWebSearch({
                  args: objectArguments(call.function?.arguments),
                  config,
                  env,
                  model: selection.model,
                  clock,
                  requestId: `${runRequestPrefix}-${turns}-search-${webSearchAttempted + 1}`,
                  fetchImpl: args.fetchImpl,
                  onMetered: (metered) => {
                    webSearchAttempted += 1;
                    if (metered.accepted) webSearchAccepted += 1;
                    else webSearchRefused += 1;
                    // Folded into the run totals as well as reported apart: a caller reading only
                    // `budget*Usd` must not see an understated bill.
                    budgetReservedUsd += metered.reservedUsd;
                    budgetSettledUsd += metered.settledUsd;
                    webSearchUsd += metered.settledUsd;
                  },
                }),
              )
            : JSON.stringify(executeOpenWeightTool(name, objectArguments(call.function?.arguments), args.cwd));
        } catch (error) {
          content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        messages.push({ role: "tool", tool_call_id: id, content });
      }
    }
  } catch (error) {
    // W1-T3666: A RESERVATION STILL PENDING WHEN THE TURN FAILS IS SETTLED DOWN HERE, NOT
    // STRANDED. `pendingReservation` is set only between a reservation's commit and its own
    // settlement decision (above), so reaching this with it defined means a 429, a transport
    // fault or an unparseable body cut the turn short before any usage receipt could be read --
    // exactly the gap `settleOpenWeightBudget`'s own doc names. Settled to the INPUT-ONLY portion
    // of the same byte-bound estimate the reservation used (zero completion tokens): a failed
    // request produced no completion, so it must not be charged for the
    // `OPENWEIGHT_MAX_COMPLETION_TOKENS` ceiling the reservation assumed it might. `reason` is the
    // failure's own message, so the ledger row itself says which failure settled it.
    if (pendingReservation !== undefined) {
      const inputOnlyUsd = openWeightUsageUsd(pendingReservation.deployment, pendingReservation.requestBodyBytes, 0);
      settleOpenWeightBudget(config, {
        requestId: pendingReservation.requestId,
        actualUsd: inputOnlyUsd,
        atIso: clock.iso(),
        reason: error instanceof Error ? error.message : String(error),
      });
      budgetSettledUsd += inputOnlyUsd;
    }
    // Preserve the transport/tool failure in the result's stderr + error flags; a failure must not
    // collapse into an ordinary empty worker response for callers or the catch-erasure census.
    return openWeightResult({
      model: selection.model,
      effort: selection.effort,
      startedAt,
      clock,
      text,
      sessionId,
      turns,
      promptTokens,
      completionTokens,
      error: error instanceof Error ? error.message : String(error),
      budgetReservedUsd,
      budgetSettledUsd,
      // A refusal is a distinct outcome from a transport failure: no paid request was made, so the
      // operator reading the ledger can tell "we declined to spend" from "we spent and it failed".
      budgetRefused: error instanceof OpenWeightAllowanceExhaustedError,
      webSearchAttempted,
      webSearchAccepted,
      webSearchRefused,
      webSearchUsd,
    });
  }
}

/**
 * Reserve, perform and settle ONE brokered web search. The reservation commits BEFORE the request,
 * as a chat turn's does; what differs is the ceiling, since a search's input is not bounded by the
 * bytes we send (see {@link CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS}).
 *
 * SETTLEMENT FOLLOWS THE RECEIPT, NOT THE VERDICT: a refused search settles from its usage block
 * like an accepted one, because the provider billed it either way. Refusing an un-attributed
 * document does not refund the search that produced it.
 */
async function brokerCashWebSearch(input: {
  args: Record<string, unknown>;
  config: Config;
  env: NodeJS.ProcessEnv;
  model: string;
  clock: Pick<Clock, "now" | "iso">;
  requestId: string;
  fetchImpl?: typeof fetch;
  onMetered: (metered: { accepted: boolean; reservedUsd: number; settledUsd: number }) => void;
}): Promise<unknown> {
  const query = input.args.query;
  if (typeof query !== "string" || query.trim() === "") throw new Error("web_search query must be a non-empty string");
  const searchKey = input.env[CASH_WEB_SEARCH_KEY_ENV];
  // A declared-but-unusable tool must refuse loudly rather than return an empty result the model
  // would read as "the web knows nothing about this".
  if (!searchKey) throw new Error(`web_search requires ${CASH_WEB_SEARCH_KEY_ENV} in the daemon environment`);
  const rawEndpoint = input.config.workerProviders?.cashEndpoint ?? input.config.workerProviders?.openweightEndpoint;
  const endpoint = cashWebSearchEndpoint(typeof rawEndpoint === "string" ? rawEndpoint : "", input.model);
  const body = JSON.stringify({ model: input.model, input: query, tools: [{ type: "web_search" }] });
  let reservation: { reservedUsd: number; committedUsd: number; capUsd: number };
  try {
    reservation = reserveOpenWeightBudget(input.config, {
      requestId: input.requestId,
      deployment: input.model,
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      extraInputTokens: CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS,
      atIso: input.clock.iso(),
    });
  } catch (error) {
    // AN EXHAUSTED ALLOWANCE REFUSES THE SEARCH, NOT THE RUN, and it is metered as a refusal at
    // zero cost: the model asked, we declined, and no request was sent. Letting the exhaustion
    // escape would abort a worker that could still finish without the search, and leaving it
    // uncounted would hide "we ran out of money" among the searches that merely failed.
    if (!(error instanceof OpenWeightAllowanceExhaustedError)) throw error;
    input.onMetered({ accepted: false, reservedUsd: 0, settledUsd: 0 });
    return { error: `web_search refused (allowance): ${error.message}`, sources: [] };
  }
  const result = await performCashWebSearch({
    query,
    endpoint,
    apiKey: searchKey,
    model: input.model,
    fetchImpl: input.fetchImpl,
  });
  let settledUsd = reservation.reservedUsd;
  if (result.usageRead) {
    settledUsd = Math.min(
      openWeightUsageUsd(input.model, result.usage.promptTokens, result.usage.completionTokens),
      reservation.reservedUsd,
    );
    settleOpenWeightBudget(input.config, { requestId: input.requestId, actualUsd: settledUsd, atIso: input.clock.iso() });
  }
  input.onMetered({ accepted: result.outcome === "accepted", reservedUsd: reservation.reservedUsd, settledUsd });
  if (result.outcome === "refused") {
    return { error: `web_search refused (${result.reason}): ${result.detail}`, sources: [] };
  }
  return { text: result.text, sources: result.citations };
}

async function spawnCodexWorkerInPrivateTemp(
  args: CodexSpawnArgs,
  config: Config,
  privateTmpDir: string,
  selection?: Pick<ProviderCapacity, "model" | "effort">,
): Promise<CodexWorkerResult> {
  const bin = resolveCodexBin(config);
  const startedAt = Date.now();
  const stdout = new CodexJsonlAccumulator(startedAt);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderr = "";
  let outputLimit: CodexWorkerOutputLimitError | undefined;
  const pidRef: { pid?: number } = {};
  const spawn = args.containment?.spawn ?? spawnDetachedGroup;
  const teardown = args.containment?.teardown ?? ((pgid: number) => void teardownProcessGroup(pgid));
  let timedOut = false;
  let teardownRequested = false;
  const teardownOnce = (pgid: number) => {
    if (teardownRequested) return;
    teardownRequested = true;
    teardown(pgid);
  };
  const exceedOutputBudget = (stream: "stdout" | "stderr", limitBytes: number, observedBytes: number) => {
    if (outputLimit || timedOut) return;
    outputLimit = codexWorkerOutputLimitError(stream, limitBytes, observedBytes);
    if (pidRef.pid !== undefined) teardownOnce(pidRef.pid);
  };
  const childEnv = { ...codexSpawnEnv(config, args), TMPDIR: privateTmpDir };
  const contained = spawn(
    { command: bin, args: codexExecArgs(args, config, selection), cwd: args.cwd, env: childEnv },
    (chunk) => {
      if (outputLimit || timedOut) return;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > CODEX_WORKER_STDERR_MAX_BYTES) {
        exceedOutputBudget("stderr", CODEX_WORKER_STDERR_MAX_BYTES, stderrBytes);
        return;
      }
      stderr += chunk;
    },
    args.onSpawnError,
  );
  pidRef.pid = contained.pid;
  if (outputLimit) teardownOnce(contained.pid);
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
      if (outputLimit) return;
      timedOut = true;
      teardownOnce(contained.pid);
    }, args.clockBound.boundMs);
  };
  process.stdout.on("data", (chunk: Buffer) => {
    if (outputLimit || timedOut) return;
    const text = chunk.toString("utf8");
    stdoutBytes += Buffer.byteLength(text, "utf8");
    if (stdoutBytes > CODEX_WORKER_STDOUT_MAX_BYTES) {
      exceedOutputBudget("stdout", CODEX_WORKER_STDOUT_MAX_BYTES, stdoutBytes);
      return;
    }
    const observedAt = Date.now();
    stdout.push(text, observedAt);
    if (/\"type\":\"agent_message\"/.test(text)) args.streamObserver?.({ kind: "working", tsMs: observedAt });
    else args.streamObserver?.({ kind: "message", tsMs: observedAt });
    armClockBound();
  });
  armClockBound();
  const prompt = CODEX_DOCTRINE_PRELUDE + args.prompt;
  process.stdin.write(`${prompt}\n`);
  process.stdin.end();
  try {
    const exitCode = await withWorkerGroupTeardown(pidRef, () => exitPromise, teardownOnce);
    if (outputLimit) throw outputLimit;
    if (timedOut) throw new Error(`Codex worker exceeded the ${args.clockBound?.boundMs}ms clock bound`);
    const parsed = stdout.finish();
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
      stderr,
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
