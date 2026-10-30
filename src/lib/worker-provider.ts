import { setTimeout as abortableDelay } from "node:timers/promises";
import { recordCashRequestEffort, type CashRequestEffortCount } from "./cash-request-effort.js";
import { createWorkerToolLineage, observeWorkerToolLineage } from "./worker-tool-lineage.js";
import { CASH_RESPONSES_DEPLOYMENTS, CashResponsesConversation } from "./cash-responses.js";
import { randomUUID } from "node:crypto";
import { codexExperimentArmForTask, routingDrawSeed, routingDrawValue, type RoutingDrawKey, type RoutingDrawSeed } from "./routing-experiments.js";
export { routingDrawSeed, routingDrawValue, type RoutingDrawKey, type RoutingDrawSeed } from "./routing-experiments.js";
import { execFileSync, spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { constants as fsConstants, accessSync, appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { prepareWorkerNativeCache } from "./worker-native-cache.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import {
  verifyCapabilityGrant,
  type CapabilityGrantStore,
  type CapabilityUseRequest,
} from "./capability-grant.js";
import { reconcileExternalEffect, type ExternalEffectRequest, type ExternalEffectResult } from "./action-reconciliation.js";
import {
  affectedSelectionOrFull,
  changedSymbols,
  symbollessSourceFiles,
  type AffectedSelection,
  type AffectedSuitesInput,
} from "./affected-suites.js";
import { callerReachableSuites } from "./ci-parity.js";
import { defaultPreflightSpawn, type PreflightSpawn } from "./commit-message.js";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { detectUsageLimitRefusal, type UsageLimitRefusal } from "./classify.js";
import { fixedClock, loopAvailableDeadline, systemClock, type Clock } from "./clock.js";
import { RmdError } from "./errors.js";
import { hostWorktreeGit, hostWorktreeGitAsync, recordedWorktreeGitDir } from "./worktree-git.js";
import { aliasRewriteFields, rewriteAddedTestImports, type AddedTestAliasRewrite } from "./added-test-alias-rewrite.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { seedOf } from "./knowledge-value.js";
import { withFleetCashAllowanceLock } from "./cash-allowance-lock.js";
import type { UsageSnapshot } from "./headroom.js";
import type { Config, WorkerProviderId } from "./config.js";
import { loadMounts, mountsPath, type CapabilityLadder } from "./mounts.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { makeTempDir, withTempDir } from "./tmp.js";
import { assertModelAllowed, modelAllowed } from "./model-gate.js";
import { switchbackArmFor, type SwitchbackAssignment, type VersionSwitchbackWindow } from "./version-switchback.js";
import type { ModelApproval } from "./config-schema.js";
import { cashDeploymentEndpoint, cashDeploymentTarget } from "./config-schema.js";
import {
  hasUsableTypecheckBuildInfo, installedTypescriptVersion, lowMemoryTypecheckArgs, seedFromCanonical, TYPECHECK_BUILDINFO_NAME, TYPECHECK_COLD_PEAK_BYTES,
  TYPECHECK_WARM_PEAK_BYTES, typecheckEnv,
} from "./typecheck-buildinfo.js";
import { acquireTestSlotAsync, defaultTestSlots, readHostLoad, readMemoryHeadroom, testRunConcurrency, testSlotExecutionAllowed, TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV } from "./test-slot.js";
import { selectFromRoutingPool, type RoutingPoolDecision, type RoutingPoolRequest, type RoutingPoolSnapshot } from "./model-pool.js";
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
import {
  allocateUpgrades,
  type LiveUpgradeWindow,
  type UpgradeAllocationDecision,
  type UpgradeCandidateTask,
} from "./upgrade-allocation.js";

interface CodexSpawnArgs {
  cwd: string;
  prompt: string;
  /** The validated worker policy whose PreToolUse floor is translated onto the Codex CLI. */
  settingsFile: string;
  resumeSessionId?: string;
  /** W1-T2800: `spawnWorker` establishes this redirected home before provider selection
   * (`perRunWorkerHomeDir` + `materializeWorkerHome`, as Claude has since W1-T18).
   * Pass it explicitly: relying on `args.env.HOME` copy order silently restores the leak on reorder. */
  workerHome: string;
  /** W1-T2800 — `workerZdotdir(config)`, the SAME value the Claude path passes, so a directly
   *  invoked zsh cannot reach the operator's zdotdir (W1-T1C compinit contamination). */
  zdotdir?: string;
  env?: Record<string, string>;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  /** The shell-less surface a caller declares only when its harness owns git (run-task.ts's coherence rule). */
  cashTools?: readonly string[];
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
  /** W1-T10763: a codex tool call also carries `toolName`/`toolInput`/`cwd`, the fields the run-task observer signs. */
  streamObserver?: (event: {
    kind: "working" | "tool-executing" | "message"; tsMs: number; text?: string; toolName?: string; toolInput?: unknown; cwd?: string;
  }) => void;
  clockBound?: { boundMs: number; now?: () => number; pollMs?: number };
  /** W1-T9245 — the caller's cancel, as `SpawnWorkerArgs.signal` is for Claude: aborting it (or passing it aborted) tears the
   * process group down through `teardownOnce`, so an `end_round` abort stops the worker instead of letting it run on. */
  signal?: AbortSignal;
}

/** W1-T6027: how a worker's process ended. `exit` carries a code (0 included) and `signal` the signal's name, each as the
 * runner OBSERVED it. `unobserved` is for a runner that saw no process end: the cash HTTP runner, or a claude envelope with
 * no SDK throw. It is never read as exit 0. Re-exported by worker.ts beside `WorkerResult.exit`. */
export type WorkerExit = { kind: "exit"; code: number } | { kind: "signal"; signal: string } | { kind: "unobserved" };

interface CodexWorkerResult {
  provider: "codex";
  /** W1-T6148: what the harness did with a codex writer's edits; absent when its caller commits them. */
  harnessCommit?: CodexHarnessCommit;
  sessionId: string;
  costUsd: number;
  /** W1-T5629: NOTIONAL, never billed — see {@link codexNotionalCostUsd}. Absent when the model is unpriced. */
  notionalCostUsd?: number;
  numTurns: number;
  maxTurns?: number;
  text: string;
  blocks: string[];
  stderr: string;
  outputTruncation?: CodexOutputTruncation;
  /** W1-T8203: set when stderr passed its retention bound and only its head and tail were kept. */
  stderrTruncation?: CodexStderrTruncation;
  subtype: string;
  isError: boolean;
  /** W1-T6027: the child's own `exit(code, signal)`, never derived from `subtype`. */
  exit: WorkerExit;
  apiError: boolean;
  usageRefusal?: UsageLimitRefusal;
  permissionDenials: unknown[];
  childEnvKeys: string[];
  accountLabel?: string;
  model: string;
  effort: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  tokenUsageState: "observed" | "partial" | "unavailable";
  modelUsage: Record<string, never>;
  /** W1-T4650: always `null` — see {@link CODEX_SERVED_MODEL_REASON}, which says why. */
  servedModel?: null;
  servedModelReason?: string;
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
  /** W1-T10382: the Codex bucket's prepaid credits as read; see {@link codexCreditsSpendable}. */
  credits?: CodexCredits;
  /** W1-T3718: `readable: false` because the provider ANSWERED and every candidate sat below the
   *  reserve, not because the probe failed. See {@link providerRefusalCondition}. */
  exhausted?: boolean;
  carriedForward?: { readAt: number; ageMs: number; failure: string };
}

/** W1-T10382: the lane a Codex account past its reserve is admitted on when its prepaid credits can carry it. */
export type ProviderLane = "codex-credits";

/** W1-T10382: prepaid Codex credits. `balance` is `null` when the app-server's decimal string is unreadable, never 0. */
export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null;
  /** Why these credits cannot carry the bucket: a reached spend control, or a reached type credits do not lift. */
  blocked?: string;
}

/** Whether credits can carry a Codex bucket past its reserve: unlimited, or a positive balance, and nothing blocking. */
export function codexCreditsSpendable(credits: CodexCredits | undefined): boolean {
  if (!credits || credits.blocked !== undefined) return false;
  return credits.unlimited || (credits.hasCredits && credits.balance !== null && credits.balance > 0);
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
  /** W1-T10382: eligible only because its credits carry it past the reserve. */
  lane?: ProviderLane;
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
  /** Task-stable overlap assignment, attached only when both versions were eligible. */
  switchback?: SwitchbackAssignment;
  /** W1-T3097: original Claude model, e.g. `"claude-opus-5"`, for attributing
   * {@link capabilityFallbackReason} to the lane that downgraded. */
  requestedModel?: string;
  /** W1-T3097: present ONLY for an unreadable capability table; see {@link resolveCodexCapability}.
   * A loaded table with no model row uses the documented "balanced" default without a reason.
   * Keep read failure distinct from policy when attributing `served_model`. */
  capabilityFallbackReason?: CodexCapabilityFallbackReason;
  /** W1-T3958: the routing-pool-v1 receipt, present only when the read was given a pool. */
  routingPool?: RoutingPoolDecision;
}

export interface ProviderSelection {
  provider: WorkerProviderId;
  capacity: ProviderCapacity;
  tightestRemainingPercent: number;
  /** Squared usable headroom after reserve; present on every live selector result. */
  allocationWeight?: number;
  /** Intended share among the eligible providers at this decision point. */
  allocationSharePercent?: number;
  /** W1-T4617: the draw that picked this provider, and every drawn candidate's probability. */
  draw?: RoutingDraw;
  /** W1-T10382: present when no subscription had headroom and Codex credits carry this spawn. */
  lane?: ProviderLane;
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

/** Largest percentage-point burn across reset-stable windows. Changed/absent resets are incomparable;
 * regressed counters are refused, never negative credits. Callers must separately exclude overlapping
 * same-provider work before attributing these captured readings to one worker. */
export function providerWindowConsumption(
  before: ProviderCapacity,
  after: ProviderCapacity,
): ProviderWindowConsumption {
  if (before.provider !== after.provider) {
    return { provider: before.provider, percentConsumed: null, reason: "provider-mismatch" };
  }
  // W1-T2828: refuse known cross-account subtraction. TRAP: name + resetsAt can match across
  // accounts sharing a weekly reset, falsely attributing their delta to one worker.
  // An absent label proves no mismatch; unlabeled hosts must still attribute ordinary spend.
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
    super(`no configured worker subscription has readable headroom: ${capacities.map(renderProviderRefusal).join(", ")}`);
    this.name = "ProviderCapacityBlockedError";
  }
}

/** W1-T3718: `full` answered without reserve headroom; `cannot-be-asked` gave no readable answer.
 * The 2026-09-17 unreadable/174s probe failures masqueraded as budget exhaustion. Keep them apart:
 * only `full` argues for paying for fallback. */
export type ProviderRefusalCondition = "full" | "cannot-be-asked";

export function providerRefusalCondition(capacity: ProviderCapacity): ProviderRefusalCondition {
  if (capacity.exhausted === true) return "full";
  if (!capacity.readable) return "cannot-be-asked";
  return capacity.windows.some(validCapacityWindow) ? "full" : "cannot-be-asked";
}

function providerRefusalDetail(capacity: ProviderCapacity): string {
  const remaining = tightestRemaining(capacity);
  return capacity.readable && Number.isFinite(remaining) ? `${remaining}% remaining` : capacity.detail ?? "unreadable";
}

function renderProviderRefusal(capacity: ProviderCapacity): string {
  const condition = providerRefusalCondition(capacity) === "full" ? "full" : "cannot be asked";
  return `${capacity.provider}=${condition} (${providerRefusalDetail(capacity)})`;
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

/** One subscription as the auction saw it: whether it could take work, why not, and its headroom. */
export interface ProviderEligibility {
  eligible: boolean;
  reason?: "unreadable" | "below-reserve";
  /** W1-T10382: admitted past the reserve on prepaid Codex credits, not on subscription headroom. */
  lane?: ProviderLane;
  /** Tightest remaining window percentage; `null` when nothing readable was reported. */
  headroomPercent: number | null;
}

/** The auction's own admission test, exported so a decision record states it rather than re-deriving it. */
export function providerEligibility(capacity: ProviderCapacity, reservePercent: number): ProviderEligibility {
  // W1-T10383: an exhausted capacity ANSWERED (every candidate sat below the reserve), so it is
  // `below-reserve` with the tightest window it still carries, not `unreadable`.
  if (capacity.exhausted === true) {
    const carried = providerAllocationWindows(capacity).filter(validCapacityWindow);
    return { eligible: false, reason: "below-reserve",
      headroomPercent: carried.length > 0 ? Math.min(...carried.map((window) => 100 - window.usedPercent)) : null };
  }
  const remaining = tightestRemaining(capacity);
  const headroomPercent = Number.isFinite(remaining) ? remaining : null;
  if (!capacity.readable || capacity.windows.length === 0) return { eligible: false, reason: "unreadable", headroomPercent };
  const ceiling = 100 - reservePercent;
  const admitted = capacity.windows.every((window) => validCapacityWindow(window) && window.usedPercent < ceiling);
  if (admitted) return { eligible: true, headroomPercent };
  // W1-T10382: past the reserve, Codex credits carry the work ahead of every cash fallback.
  if (capacity.provider === "codex" && capacity.windows.every(validCapacityWindow) && codexCreditsSpendable(capacity.credits)) {
    return { eligible: true, lane: "codex-credits", headroomPercent };
  }
  return { eligible: false, reason: "below-reserve", headroomPercent };
}

/** W1-T4617: record selection probability for outcome weighting. One uniform draw uses FNV-1a
 * {@link seedOf} + mulberry32 {@link seededRandom}, keyed by `(task id, attempt, decision point)`.
 * Unlike the old arrival-correlated golden-ratio counter, it is clock/weight independent and
 * reproducible; expected shares equal normalized `(headroom - reserve)^2` weights. */
export const ROUTING_DRAW_METHOD = "fnv1a-mulberry32/v1";

/** The decision point of one spawn: a digest of what it asks for, so a fix rung and a reviewer draw apart. */
export function spawnDecisionPoint(request: { model?: string; effort?: string; sandboxIntent?: string; prompt: string }): string {
  const text = [request.model ?? "", request.effort ?? "", request.sandboxIntent ?? "", request.prompt].join("\u0000");
  return `spawn:${seedOf(text).toString(16).padStart(8, "0")}`;
}

/** One recorded draw: its method, value, seed and each drawn candidate's selection probability. */
export interface RoutingDraw {
  method: typeof ROUTING_DRAW_METHOD;
  value: number;
  /** Eight hex digits of the hashed seed, or `supplied` when a caller passed the value itself. */
  seed: string;
  key?: RoutingDrawKey;
  probabilities: Array<{ provider: WorkerProviderId; probability: number }>;
  /** W1-T5535: present ONLY when a learned mixing shaped the probabilities; each provider's three shares. */
  learned?: {
    epsilon: number;
    probabilities: Array<{ provider: WorkerProviderId; headroom: number; learned: number; final: number }>;
  };
}

/**
 * W1-T5535: a learned per-provider multiplier on the headroom weights, mixed with the pure-headroom
 * probabilities as `(1 - epsilon) * p_learned + epsilon * p_headroom`. Absent, the selector is unchanged.
 */
export interface ProviderMixing {
  epsilon: number;
  multipliers: Partial<Record<WorkerProviderId, number>>;
}

function resolveRoutingDraw(source: number | RoutingDrawSeed): { value: number; seed: string; key?: RoutingDrawKey; order?: readonly WorkerProviderId[] } {
  if (typeof source !== "object") {
    const value = Number.isFinite(source) ? Math.min(Math.max(source, 0), 1 - Number.EPSILON) : 0;
    return { value, seed: "supplied" };
  }
  const { order, ...key } = source;
  return { ...routingDrawValue(key), key, ...(order ? { order } : {}) };
}

/**
 * Select across eligible subscriptions in proportion to squared usable tight-window headroom.
 * Unreadable providers and providers at the reserve boundary are excluded before weighting. The
 * pick is ONE draw over those weights (see {@link ROUTING_DRAW_METHOD}); a number is taken as the
 * drawn value itself, which is the test seam and the single-candidate path.
 */
export function selectWorkerProvider(
  capacities: ProviderCapacity[],
  reservePercent = 5,
  draw: number | RoutingDrawSeed = 0,
  mixing?: ProviderMixing,
): ProviderSelection {
  const admitted = capacities
    .map((capacity) => ({ capacity, lane: providerEligibility(capacity, reservePercent) }))
    .filter((entry) => entry.lane.eligible);
  // W1-T10382: subscription headroom wins; a credits lane is drawn only when no subscription has any.
  const headroom = admitted.filter((entry) => entry.lane.lane === undefined);
  const eligible = (headroom.length > 0 ? headroom : admitted)
    .map(({ capacity, lane: { lane } }) => {
      const tightestRemainingPercent = tightestRemaining(capacity);
      return {
        provider: capacity.provider,
        capacity,
        tightestRemainingPercent,
        allocationWeight: Math.max(1, tightestRemainingPercent - reservePercent) ** 2,
        ...(lane ? { lane } : {}),
      };
    })
    .sort((a, b) => b.tightestRemainingPercent - a.tightestRemainingPercent);
  if (eligible.length === 0) throw new ProviderCapacityBlockedError(capacities);
  const headroomTotal = eligible.reduce((sum, item) => sum + item.allocationWeight, 0);
  const mixed = mixing ? mixedProbabilities(eligible, headroomTotal, mixing) : undefined;
  // The walk's weights ARE the probabilities when a mixing is present, else the headroom weights themselves.
  const walkWeight = (item: { allocationWeight: number }, index: number) => mixed ? mixed[index].final : item.allocationWeight;
  const totalWeight = mixed ? mixed.reduce((sum, entry) => sum + entry.final, 0) : headroomTotal;
  const resolved = resolveRoutingDraw(draw);
  const recorded: RoutingDraw = {
    method: ROUTING_DRAW_METHOD,
    value: resolved.value,
    seed: resolved.seed,
    ...(resolved.key ? { key: resolved.key } : {}),
    probabilities: eligible.map((item, index) => ({ provider: item.provider, probability: walkWeight(item, index) / totalWeight })),
    ...(mixed && mixing
      ? { learned: { epsilon: mixing.epsilon, probabilities: mixed.map((entry, index) => ({ provider: eligible[index].provider, ...entry })) } }
      : {}),
  };
  const weighted = eligible.map((item, index) => ({
    ...item,
    walkWeight: walkWeight(item, index),
    allocationSharePercent: walkWeight(item, index) / totalWeight * 100,
    draw: recorded,
  }));
  // The walk's order moves no probability; an experiment fixes it so one task-keyed value reads as one arm.
  const rank = (provider: WorkerProviderId) => {
    const index = resolved.order?.indexOf(provider) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const walk = resolved.order ? [...weighted].sort((a, b) => rank(a.provider) - rank(b.provider)) : weighted;
  const targetWeight = resolved.value * totalWeight;
  let cumulativeWeight = 0;
  for (const item of walk) {
    cumulativeWeight += item.walkWeight;
    if (targetWeight < cumulativeWeight) return stripWalkWeight(item);
  }
  return stripWalkWeight(walk[walk.length - 1]);
}

/** The walk weight is the selector's own bookkeeping: the returned selection keeps its pre-W1-T5535 shape. */
function stripWalkWeight<T extends { walkWeight: number }>(item: T): Omit<T, "walkWeight"> {
  const { walkWeight: _walkWeight, ...selection } = item;
  return selection;
}

/** Each provider's headroom share, its share once weighted by its learned multiplier, and the epsilon mix. */
function mixedProbabilities(
  eligible: ReadonlyArray<{ provider: WorkerProviderId; allocationWeight: number }>,
  headroomTotal: number,
  mixing: ProviderMixing,
): Array<{ headroom: number; learned: number; final: number }> {
  const positive = (value: number | undefined): value is number => typeof value === "number" && value > 0;
  const known = eligible.map((item) => mixing.multipliers[item.provider]).filter(positive);
  // A provider with no learned multiplier takes the mean of the others', so it is neither favoured nor starved.
  const fallback = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : 1;
  const raw = eligible.map((item) => {
    const multiplier = mixing.multipliers[item.provider];
    return item.allocationWeight * (positive(multiplier) ? multiplier : fallback);
  });
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);
  const epsilon = Math.min(Math.max(mixing.epsilon, 0), 1);
  return eligible.map((item, index) => {
    const headroom = item.allocationWeight / headroomTotal;
    const learned = raw[index] / rawTotal;
    return { headroom, learned, final: (1 - epsilon) * learned + epsilon * headroom };
  });
}

/**
 * W1-T4617: the selection probability a `worker.assignment` row carries. `unavailable` is a named
 * state with a reason -- never 0, never omitted -- because a propensity-weighted estimate that read
 * a missing probability as zero would divide by it.
 */
export interface RoutingPropensity {
  method: typeof ROUTING_DRAW_METHOD | "single-candidate" | "unavailable";
  selectedProbability: number | "unavailable";
  candidates: Array<{ provider: WorkerProviderId; probability: number | "unavailable" }>;
  unavailableReason?: string;
  draw?: { value: number; seed: string; key?: RoutingDrawKey };
}

/**
 * Derive the propensity of one assignment. An auction selection reads its own draw (an ineligible
 * or policy-excluded candidate is a KNOWN 0); no auction means one candidate at probability 1; a
 * rule that settled the provider outside any weighing, or a selection with no draw, is unavailable.
 */
export function selectionPropensity(input: {
  selected: WorkerProviderId;
  considered: readonly WorkerProviderId[];
  selection?: Pick<ProviderSelection, "draw">;
  unavailableReason?: string;
}): RoutingPropensity {
  const providers = [...new Set([...input.considered, input.selected])];
  const reason = input.unavailableReason ?? (input.selection && !input.selection.draw ? "missing-weight" : undefined);
  if (reason !== undefined) {
    return {
      method: "unavailable",
      selectedProbability: "unavailable",
      candidates: providers.map((provider) => ({ provider, probability: "unavailable" as const })),
      unavailableReason: reason,
    };
  }
  const draw = input.selection?.draw;
  if (!draw) {
    return { method: "single-candidate", selectedProbability: 1, candidates: [{ provider: input.selected, probability: 1 }] };
  }
  const probability = new Map(draw.probabilities.map((entry) => [entry.provider, entry.probability]));
  return {
    method: draw.method,
    selectedProbability: probability.get(input.selected) ?? "unavailable",
    candidates: providers.map((provider) => ({ provider, probability: probability.get(provider) ?? 0 })),
    draw: { value: draw.value, seed: draw.seed, ...(draw.key ? { key: draw.key } : {}) },
  };
}

/** W1-T4670: expose {@link allocateUpgrades} for queued candidates by predicted gain/window share.
 * ADDITIVE ONLY: mounts' per-role tiers and {@link selectWorkerProvider}'s auction remain live.
 * Spending requires a winning offline {@link import("./upgrade-allocation.js").replayUpgradeAllocationPolicy}
 * (design point ii); default empty candidates cost nothing and upgrade nothing until operator wiring. */
export function queuedUpgradeAllocation(
  candidates: readonly UpgradeCandidateTask[],
  liveWindow: LiveUpgradeWindow,
): UpgradeAllocationDecision[] {
  return allocateUpgrades(candidates, liveWindow);
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
  /** W1-T10382: prepaid credits, spelled as the app-server's `CreditsSnapshot`; `balance` is a decimal string. */
  credits?: { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null;
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

/** Non-sensitive reset count and earliest readable expiry. Absent block/unreadable count yields
 * `undefined` (unmeasured); a readable count without expiry stays count-only. Never invent a date
 * or synthesize 0: that would falsely claim no reset is available. */
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

/** W1-T2573: last-resort candidates ONLY when mounts' capabilities are unavailable/omitted.
 * Real routing uses {@link CapabilityLadder.codex}; missing data preserves fail-soft dispatch. */
const FALLBACK_CODEX_MODELS: Record<CodexModelTier, string[]> = {
  economy: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-5.4-mini"],
  balanced: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
  frontier: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"],
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

/** W1-T2573: look up mounts' `capabilities.claude`, never infer tiers from model-name substrings.
 * Undeclared models or absent data explicitly default to "balanced", preserving legacy fallback. */
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

/** W1-T3097: wrap `codexCapabilityForRequestedModel` with a reason ONLY for an unreadable table.
 * Unmapped models also default to "balanced" but carry no reason. Both remain usable: never throw
 * or block dispatch (design point ii); tier-only callers retain the original lookup. */
export function resolveCodexCapability(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
): CodexCapabilityResolution {
  const tier = codexCapabilityForRequestedModel(capabilities, requestedModel);
  return capabilities === undefined ? { tier, fallbackReason: "capability-table-unavailable" } : { tier };
}

/** W1-T2573, rationale 2: ordered candidates depend on BOTH capability and effort (e.g. sonnet/high
 * versus sonnet/medium). Missing effort rows use "medium"; absent capability data uses
 * {@link FALLBACK_CODEX_MODELS}. */
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

/** Fail-soft default for absent/malformed mounts' `capabilities.cash`. W1-T3598 requires the same
 * leading deployment as the table; test/the-trial-deployment-is-the-cheaper-compliant-one.test.ts
 * checks parity so missing data cannot silently select a dearer deployment.
 * W1-T3689 (2026-09-16): frontier uses Luna then Terra (10x Luna), avoiding the single-candidate
 * trap seen in codex.balanced.low. Luna replaced mini: cheaper on both axes, 0 versus 64/76 reasoning
 * tokens. Economy/balanced retain W1-T3614's measured OSS/nano leads; promote Luna for cash squeeze
 * only after the subscription auction blocks. */
// W1-T3614: economy leads with gpt-oss-120b and balanced with gpt-5-nano, MIRRORING
// .remudero/mounts.yaml exactly -- a checkout with no mounts table must not silently prefer a
// different deployment from one with it, which test/the-trial-deployment-is-the-cheaper-compliant-one
// asserts directly. The leads differ because the cheaper deployment differs by prompt shape:
// measured 2026-09-15, a 259,181-token inbox_draft favours nano 2.83x while a 446-token escalation
// judgement favours gpt-oss 2.40x, since nano spends ~5x the completion tokens on reasoning.
const FALLBACK_OPENWEIGHT_MODELS: Record<CodexModelTier, string[]> = {
  economy: ["gpt-oss-120b", "gpt-5-nano", "gpt-5.6-luna"],
  balanced: ["gpt-5-nano", "gpt-oss-120b", "gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-terra", "gpt-6.1-sol"],
  frontier: ["gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-terra", "gpt-5.6-terra"],
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

/** Context belongs to the deployment, like price/temperature. Large-only failures can look flaky:
 * state/openweight-allowance.json (2026-09-15) showed 32/96 large nano requests unsettled (12/10/10
 * across concurrency triples), versus 0/8 small; OSS explicitly rejected 259242 > 131072 tokens.
 * Compare prompt + {@link OPENWEIGHT_MAX_COMPLETION_TOKENS} against a TOTAL: OSS's 131,072 is total,
 * nano's 272,000 is input-only. Reserving completion room in both may over-refuse but never over-admit
 * (as with {@link OPENWEIGHT_PRICES}). Refuse missing rows before spending on impossible requests. */
export interface OpenWeightContextWindow {
  readonly totalTokens: number;
  readonly readAt: string;
}

export const OPENWEIGHT_CONTEXT_WINDOWS: Readonly<Record<string, OpenWeightContextWindow>> = {
  "claude-haiku-5-5": { totalTokens: 1_000_000, readAt: "2026-10-07" },
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
  // Azure's 922K input limit is lower than the combined window; reserve 8K for output.
  "gpt-6-luna": { totalTokens: 922_000, readAt: "2026-09-24" },
  "gpt-6.1-sol": { totalTokens: 922_000, readAt: "2026-10-02" },
  // Terra metadata (2026-10-27): 922K input, conservatively leaving room for output as above.
  // https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#gpt-61
  "gpt-6.1-terra": { totalTokens: 922_000, readAt: "2026-10-27" },
};

/** Fit-only bytes/token estimate, NEVER pricing. Nano's $0.05/1M input, 5,000 output ceiling,
 * $0.0547 reservation (1,054,000 bytes) and $0.0142 settlement bound the prompt at 244K–284K tokens:
 * 3.71–4.32 bytes/token, centered near 4.0. This separates OSS's 131,072 from nano's 272,000 window,
 * but cannot resolve inbox_draft's ~4% margin: shrink that prompt instead.
 * Falsifier: 3.5 estimated 301,143 tokens, refusing every window and turning 33% wire failure into
 * 100% local refusal. Over-refusal that eliminates this routing is not the safe direction. */
export const OPENWEIGHT_BYTES_PER_TOKEN = 4.0;

/** The conservative token estimate the fit gate reasons about. */
export function openWeightEstimatedTokens(requestBodyBytes: number): number {
  return Math.ceil(requestBodyBytes / OPENWEIGHT_BYTES_PER_TOKEN);
}

/**
 * W1-T10856 -- THE SECOND FIT CEILING: A DEPLOYMENT'S PER-MINUTE TOKEN LIMIT, LEARNED, NEVER DECLARED.
 *
 * MEASURED 2026-10-27 against synthwatch-foundry: Azure enforces a deployment's tokens-per-minute
 * quota as a PER-REQUEST ceiling for partner models too. A ~25K-token prompt to DeepSeek-V4-Flash
 * (20,000 TPM) returned HTTP 429 on the first try while a 300-token call on the same deployment
 * succeeded. Waiting cannot help: the request can never fit. The limit is readable from the data
 * plane -- every response carries `x-ratelimit-limit-tokens` and `x-ratelimit-renewalperiod-tokens`
 * -- so this table is FILLED BY RESPONSES. NO NUMBER IS DECLARED HERE: a deployment that has not yet
 * answered has no row and is gated by its context window alone, so its first request teaches it.
 *
 * Keyed by resolved endpoint AND deployment id: moving a deployment must not carry its old quota.
 */
export interface LearnedCashCapacity {
  readonly limitTokens: number;
  /** The `x-ratelimit-renewalperiod-tokens` header, or null when the response carried none. */
  readonly renewalSeconds: number | null;
  readonly observedAt: string;
}

export const CASH_TPM_STATE_FILE = "cash-capacity.json";
export const CASH_TPM_OBSERVED_STEP = "cash.capacity.observed";
const LEARNED_CASH_CAPACITY = new Map<string, LearnedCashCapacity>();

export function cashCapacityPath(config: Pick<Config, "root">): string {
  return join(config.root, "state", CASH_TPM_STATE_FILE);
}

/** The bounded unsigned-integer parse every cash header read shares: digits only, safe integer. */
function cashUnsignedHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  return value !== null && /^[0-9]{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function cashCapacityKey(deployment: string, endpoint: string): string {
  return JSON.stringify([endpoint.replace(/\/+$/, ""), deployment]);
}

/** The limit this endpoint's deployment last reported; an unresolved endpoint teaches nothing. */
export function learnedCashLimit(deployment: string, endpoint: string | undefined): number | undefined {
  return endpoint === undefined ? undefined : LEARNED_CASH_CAPACITY.get(cashCapacityKey(deployment, endpoint))?.limitTokens;
}

/** Forget every in-process reading (the state file is untouched). */
export function resetLearnedCashCapacity(): void {
  LEARNED_CASH_CAPACITY.clear();
}

function parseCashCapacityFile(raw: string | undefined): Record<string, LearnedCashCapacity> {
  const rows: Record<string, LearnedCashCapacity> = {};
  if (raw === undefined) return rows;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    // A torn or foreign file teaches nothing; the next response rewrites it whole.
    console.error(JSON.stringify({ event: "cash.capacity.state_unreadable", reason: error instanceof Error ? error.name : "parse" }));
    return rows;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return rows;
  for (const [deployment, row] of Object.entries(parsed as Record<string, unknown>)) {
    const r = row as Partial<Record<keyof LearnedCashCapacity, unknown>> | null;
    if (r === null || typeof r !== "object" || typeof r.limitTokens !== "number" || !Number.isSafeInteger(r.limitTokens) ||
        r.limitTokens < 0 || typeof r.observedAt !== "string") continue;
    rows[deployment] = { limitTokens: r.limitTokens, observedAt: r.observedAt,
      renewalSeconds: typeof r.renewalSeconds === "number" && Number.isSafeInteger(r.renewalSeconds) ? r.renewalSeconds : null };
  }
  return rows;
}

/** Load persisted observations before selection and cash spawns, including other processes' updates. */
export function hydrateCashCapacity(config: Pick<Config, "root">): void {
  let rows: Record<string, LearnedCashCapacity>;
  try { rows = parseCashCapacityFile(readFileIfExists(cashCapacityPath(config))); }
  catch (error) {
    console.error(JSON.stringify({ event: "cash.capacity.state_unreadable", reason: String(error) }));
    return;
  }
  for (const [key, row] of Object.entries(rows)) LEARNED_CASH_CAPACITY.set(key, row);
}

/**
 * Read the two integers a response carries and keep them. A changed limit replaces the old one and
 * writes ONE ledger row; an unchanged limit writes nothing. Raw header text never reaches storage.
 */
export function recordCashCapacity(
  config: Pick<Config, "root" | "workerProviders">,
  deployment: string,
  headers: Headers,
  ctx: { clock: Pick<Clock, "iso">; runId?: string; taskId?: string; endpoint?: string },
): boolean {
  const endpoint = ctx.endpoint ?? cashDeploymentEndpoint(config, deployment);
  if (endpoint === undefined) return false;
  const key = cashCapacityKey(deployment, endpoint);
  const limitTokens = cashUnsignedHeader(headers, "x-ratelimit-limit-tokens");
  if (limitTokens === undefined) return false;
  const renewalSeconds = cashUnsignedHeader(headers, "x-ratelimit-renewalperiod-tokens") ?? null;
  const path = cashCapacityPath(config);
  const observedAt = ctx.clock.iso();
  const learned: LearnedCashCapacity = { limitTokens, renewalSeconds, observedAt };
  let previous: LearnedCashCapacity | undefined;
  for (let attempt = 1; ; attempt++) {
    const snapshot = readFileIfExists(path);
    const rows = parseCashCapacityFile(snapshot);
    previous = rows[key];
    if (previous !== undefined && previous.limitTokens === limitTokens && previous.renewalSeconds === renewalSeconds) {
      LEARNED_CASH_CAPACITY.set(key, previous);
      return false;
    }
    rows[key] = learned;
    if (writeAtomic(path, `${JSON.stringify(rows)}\n`, {
      mode: 0o600, tmpTag: "cash-capacity", beforeRename: () => readFileIfExists(path) === snapshot,
    })) break;
    if (attempt >= 5) throw new Error(`cash capacity contention: 5 compare-and-swap attempts lost at ${path}`);
  }
  LEARNED_CASH_CAPACITY.set(key, learned);
  if (previous?.limitTokens === limitTokens) return false;
  appendLedger(ledgerPathFor(config), {
    run_id: ctx.runId ?? "unattributed",
    task_id: ctx.taskId ?? "unattributed",
    step: CASH_TPM_OBSERVED_STEP,
    deployment,
    endpoint,
    limit_tokens: limitTokens,
    renewal_seconds: renewalSeconds,
    previous_limit_tokens: previous?.limitTokens ?? null,
  });
  return true;
}

/** What a deployment's learned limit says about a token need (prompt plus completion). Pure. */
export type CashCapacityReadiness =
  | { state: "unlearned" }
  | { state: "covered"; limitTokens: number }
  | { state: "shortfall"; limitTokens: number; shortfallTokens: number };

/**
 * THE LANE READINESS SEAM (W1-T10857, W1-T10859): does a learned per-minute limit cover `needTokens`?
 * Callers pass a lane's OBSERVED prompt size plus its completion allowance. `learnedLimitTokens` is
 * the value from {@link learnedCashLimit}; an undefined one is "unlearned", never "covered".
 */
export function cashCapacityReadiness(learnedLimitTokens: number | undefined, needTokens: number): CashCapacityReadiness {
  if (learnedLimitTokens === undefined) return { state: "unlearned" };
  if (needTokens <= learnedLimitTokens) return { state: "covered", limitTokens: learnedLimitTokens };
  return { state: "shortfall", limitTokens: learnedLimitTokens, shortfallTokens: needTokens - learnedLimitTokens };
}

/** The window a request must fit: the smaller of the context window and the learned limit. */
export function openWeightEffectiveWindow(deployment: string, learnedLimitTokens?: number): number | undefined {
  const window = OPENWEIGHT_CONTEXT_WINDOWS[deployment];
  if (window === undefined) return undefined;
  return learnedLimitTokens === undefined ? window.totalTokens : Math.min(window.totalTokens, learnedLimitTokens);
}

/** Raised INSTEAD of selecting a deployment that cannot hold the request. Thrown before any
 *  reservation exists, so an impossible request costs nothing against the daily cap.
 *
 *  NAMES BOTH FIGURES (W1-T3613): the request's own estimated size, and every considered
 *  deployment's declared context window. A message that named only "no deployment fits" would
 *  send an operator back to the source to learn WHY -- the gap this refusal exists to surface
 *  should be readable from the error text alone. W1-T10856 adds the learned per-minute limit. */
export class OpenWeightRequestTooLargeError extends RmdError {
  readonly estimatedTokens: number;
  constructor(detail: { estimatedTokens: number; capability: string; considered: readonly string[];
    learnedLimit?: (deployment: string) => number | undefined }) {
    const consideredWithWindows = detail.considered.map((id) => {
      const window = OPENWEIGHT_CONTEXT_WINDOWS[id];
      const learned = detail.learnedLimit?.(id);
      const limit = learned === undefined ? "" : `, learned per-minute limit ${learned}`;
      return window ? `${id} (context window ${window.totalTokens}${limit})` : `${id} (no declared context window)`;
    });
    super(
      "usage",
      1,
      `openweight request is ~${detail.estimatedTokens} tokens and no '${detail.capability}' deployment can hold it ` +
        `(considered: ${consideredWithWindows.join(", ") || "none"}). Refusing before the request reserves, so it costs nothing. ` +
        `Shrink the prompt, raise the deployment quota in the portal, or use a larger deployment.`,
      { estimatedTokens: detail.estimatedTokens, capability: detail.capability, considered: [...detail.considered] },
    );
    this.estimatedTokens = detail.estimatedTokens;
  }
}

/** Does this deployment hold a prompt of `estimatedTokens`, leaving room for the completion the
 *  adapter itself puts on the wire? An UNLISTED deployment holds nothing -- it is refused, never
 *  assumed, for the same reason an unpriced one is. The ceiling is the smaller of the context window
 *  and the learned per-minute limit; with no learned limit it is the context window alone. */
export function openWeightDeploymentHolds(
  deployment: string,
  estimatedTokens: number,
  learnedLimitTokens?: number,
): boolean {
  const window = openWeightEffectiveWindow(deployment, learnedLimitTokens);
  if (window === undefined) return false;
  return estimatedTokens + OPENWEIGHT_MAX_COMPLETION_TOKENS <= window;
}

/** One candidate the learned per-minute limit removed although its context window would have held. */
export interface CapacityShortfall {
  reason: "capacity_shortfall";
  deployment: string;
  estimatedTokens: number;
  limitTokens: number;
}

export function recordCashCapacityShortfall(
  config: Pick<Config, "root" | "workerProviders">,
  shortfall: CapacityShortfall,
  ctx: { runId?: string; taskId?: string },
): void {
  appendLedger(ledgerPathFor(config), {
    run_id: ctx.runId ?? "unattributed", task_id: ctx.taskId ?? "unattributed",
    step: "cash.capacity.shortfall", reason: shortfall.reason, deployment: shortfall.deployment,
    endpoint: cashDeploymentEndpoint(config, shortfall.deployment),
    estimated_tokens: shortfall.estimatedTokens, limit_tokens: shortfall.limitTokens,
  });
}

export interface OpenWeightModelSelection {
  model: string;
  effort: string;
  capability: CodexModelTier;
  /** Present only when the fit gate ran, so a ledger row can distinguish "held" from "not checked". */
  estimatedTokens?: number;
  /** Remaining context-fitting candidates after {@link model}, in ladder order, for failure fallback.
   * Live evidence: 21,942/22,356 errors (98%, three days) hit one deployment while two peers went
   * untried. Empty means no alternative FITS this prompt, not that none is configured. */
  alternatives: readonly string[];
  /** W1-T10856: candidates skipped pre-transport because the learned per-minute limit could not hold the request. */
  capacityShortfalls?: readonly CapacityShortfall[];
}

export interface OpenWeightSelectionOptions {
  config?: Pick<Config, "root" | "workerProviders">;
  runId?: string;
  taskId?: string;
  /** Called once per {@link CapacityShortfall}, as selection walks past the candidate. */
  onCapacityShortfall?: (shortfall: CapacityShortfall) => void;
  /** Promote Luna only for the cash request reached after the subscription auction blocks. */
  cashSqueezed?: boolean;
  /** The operator's approvals; a human-gated deployment (Astra, Fable) is skipped without one. */
  modelApprovals?: ModelApproval[];
  /** W1-T4079 readiness seam; defaults to {@link openWeightDeploymentReady}. */
  ready?: (deployment: string) => boolean;
  /** Restricts the row to these deployments, keeping row order (the cash trial's model list). */
  only?: readonly string[];
  /** Inbox replay measures a ready deployment independently of its production routing row. */
  bakeoffDeployment?: string;
}

/** Validate before a deployment enters an Azure URL. Preserve the operator's measured cost order;
 * skip only candidates that cannot hold the prompt, never re-rank. Size explains the original rows:
 * 259,181-token inbox_draft favored nano 2.83x; 446-token escalation favored OSS 2.40x.
 * Undefined `promptBytes` means unknown size: skip the fit gate rather than guess. */
export function selectOpenWeightModel(
  capabilities: CapabilityLadder | undefined,
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  promptBytes?: number,
  options: OpenWeightSelectionOptions = {},
): OpenWeightModelSelection {
  if (options.config) hydrateCashCapacity(options.config);
  const learnedLimit = (deployment: string) => learnedCashLimit(deployment,
    options.config ? cashDeploymentEndpoint(options.config, deployment) : undefined);
  const capability = openWeightCapabilityForRequestedModel(capabilities, requestedModel);
  const rowCandidates = openWeightCandidatesForCapability(capabilities, capability, requestedEffort);
  const ready = options.ready ?? ((deployment: string) => openWeightDeploymentReady(deployment));
  const trial = options.bakeoffDeployment;
  if (trial !== undefined && (!ready(trial) ||
    (CASH_RESPONSES_DEPLOYMENTS[trial] && !CASH_RESPONSES_DEPLOYMENTS[trial]!.includes(requestedEffort ?? "medium")))) {
    throw new Error(`inbox bake-off deployment '${trial}' is not ready at effort '${requestedEffort ?? "medium"}'`);
  }
  const configured = trial !== undefined ? [trial]
    : options.only ? rowCandidates.filter((candidate) => options.only!.includes(candidate)) : rowCandidates;
  // Cash and subscription are separate billing lanes. A normal cash request keeps the measured
  // OSS/nano order, but a cash request reached only after a blocked subscription auction may use
  // Luna first. The context gate still wins: a squeeze never routes an oversized prompt to Luna.
  // Every Luna generation is promoted, in row order, so a ready gpt-6-luna leads the squeeze (W1-T4079).
  const luna = configured.filter((candidate) => /^gpt-[0-9.]+-luna$/.test(candidate));
  const candidates = options.cashSqueezed && luna.length > 0
    ? [...luna, ...configured.filter((candidate) => !luna.includes(candidate))]
    : configured;
  const allowed = candidates.filter((candidate) =>
    SAFE_OPENWEIGHT_MODEL_ID.test(candidate) && modelAllowed(candidate, { modelApprovals: options.modelApprovals }));
  // PREFER READY, ELSE BEHAVE AS BEFORE: with no ready candidate every existing refusal still fires.
  const readyOnes = allowed.filter((candidate) => ready(candidate));
  const safe = readyOnes.length > 0 ? readyOnes : allowed;
  if (safe.length === 0) throw new Error(`openweight capability '${capability}' has no safe deployment id`);
  if (promptBytes === undefined) {
    return { model: safe[0]!, effort: requestedEffort ?? "default", capability, alternatives: safe.slice(1) };
  }
  const estimatedTokens = openWeightEstimatedTokens(promptBytes);
  const capacityShortfalls: CapacityShortfall[] = [];
  const holds = safe.filter((candidate) => {
    const learned = learnedLimit(candidate);
    if (openWeightDeploymentHolds(candidate, estimatedTokens, learned)) return true;
    // The learned limit is to blame only when the context window alone would have held the request.
    if (learned !== undefined && openWeightDeploymentHolds(candidate, estimatedTokens, Number.POSITIVE_INFINITY)) {
      const shortfall: CapacityShortfall = { reason: "capacity_shortfall", deployment: candidate, estimatedTokens, limitTokens: learned };
      capacityShortfalls.push(shortfall);
      if (options.config) recordCashCapacityShortfall(options.config, shortfall, options);
      options.onCapacityShortfall?.(shortfall);
    }
    return false;
  });
  const model = holds[0];
  if (!model) throw new OpenWeightRequestTooLargeError({ estimatedTokens, capability, considered: safe, learnedLimit });
  // The tail is every OTHER candidate that also holds this prompt — the fit gate has already
  // removed the ones that cannot, so a caller walking this list can never widen the context rule.
  return { model, effort: requestedEffort ?? "default", capability, estimatedTokens, alternatives: holds.slice(1),
    ...(capacityShortfalls.length > 0 ? { capacityShortfalls } : {}) };
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
  const credits = parseCodexCredits(bucket);
  return { provider: "codex", readable: true, windows, ...(accountLabel ? { accountLabel } : {}), ...(credits ? { credits } : {}) };
}

/** Only a plain rate-limit hit is what credits lift; a depleted-credits or workspace usage limit is not. */
const CREDITS_CARRIED_REACHED_TYPE = "rate_limit_reached";
const UNSIGNED_DECIMAL = /^\d+(?:\.\d+)?$/;

/** W1-T10382: absent or malformed flags mean no credits reading at all; an unreadable balance reads `null`. */
function parseCodexCredits(bucket: CodexRateLimitBucket): CodexCredits | undefined {
  const block = bucket.credits;
  if (!block || typeof block !== "object" || typeof block.hasCredits !== "boolean" || typeof block.unlimited !== "boolean") return undefined;
  const parsed = typeof block.balance === "string" && UNSIGNED_DECIMAL.test(block.balance) ? Number(block.balance) : Number.NaN;
  const reached = bucket.rateLimitReachedType;
  const blocked = bucket.spendControlReached === true
    ? "spend-control-reached"
    : reached == null || reached === CREDITS_CARRIED_REACHED_TYPE
      ? undefined
      : typeof reached === "string" && /^[a-z_]{1,64}$/.test(reached) ? reached : "rate-limit-reached";
  return { hasCredits: block.hasCredits, unlimited: block.unlimited, balance: Number.isFinite(parsed) ? parsed : null,
    ...(blocked ? { blocked } : {}) };
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
  policy: { preferredModel?: CodexModelPreference; reservePercent?: number;
    switchback?: { window: VersionSwitchbackWindow; taskId: string; at: string } } = {},
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
  // A human-gated model (Astra, Fable) is never a candidate without an operator approval.
  const mappedCandidates = [...new Set(preferred)].filter((id) => modelAllowed(id, config));
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
    const measured = capacity.readable && capacity.windows.length > 0 && capacity.windows.every(validCapacityWindow);
    const hasHeadroom = measured && capacity.windows.every((window) => window.usedPercent < 100 - reserve);
    // W1-T10382: past the reserve, prepaid credits keep the model eligible as the credits lane.
    const creditsLane = measured && !hasHeadroom && codexCreditsSpendable(capacity.credits);
    const reason: CodexModelIneligibleReason | undefined = !mapped
      ? "unmapped"
      : !effortSupported
        ? "unsupported-effort"
        : !capacity.readable
          ? "quota-unreadable"
          : !hasHeadroom && !creditsLane
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
      ...(reason === undefined && creditsLane ? { lane: "codex-credits" as const } : {}),
    };
  });
  const ranked = candidates.map((model, preference) => {
    const option = options.find((candidate) => candidate.id === canonicalCodexModelId(model));
    const capacity = capacityFromBucket(codexBucketForModel(reading, model));
    return { model, capacity, option, preference, remaining: tightestRemaining(capacity) };
  }).sort((a, b) => b.remaining - a.remaining || a.preference - b.preference);
  const admitted = ranked.filter((candidate) => candidate.option?.eligible);
  // W1-T10382: a model with subscription headroom is always chosen over one its credits carry.
  const headroom = admitted.filter((candidate) => candidate.option?.lane === undefined);
  const eligible = headroom.length > 0 ? headroom : admitted;
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
    preferenceBypass = preferredOption?.reason ?? (preferredOption?.lane ? "below-reserve" : "not-visible");
  }
  const switchback = !forced && !scopedPreference && policy.switchback?.window.provider === "codex"
    ? switchbackArmFor(policy.switchback.window, policy.switchback.taskId, policy.switchback.at,
      eligible.map((candidate) => candidate.option!.id))
    : null;
  if (switchback) selected = eligible.find((candidate) => candidate.option?.id === switchback.model);
  selected ??= eligible[0];
  const decisionBase: CodexModelDecision = {
    requestedCapability: tier,
    requestedEffort: requestedEffortLabel,
    mappedCandidates,
    options,
    ...(requestedModel ? { requestedModel } : {}),
    ...(scopedPreference ? { preferredModel: scopedPreference.model } : {}),
    ...(preferenceBypass ? { preferenceBypass } : {}),
    ...(switchback ? { switchback } : {}),
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
      // W1-T3718: the detail names WHY. It said "no reserved headroom" for every cause, a quota
      // that was never readable included -- so an unanswerable probe read as a full subscription.
      const reason = fallback.option?.reason;
      return {
        ...fallback.capacity,
        readable: false,
        ...(reason === "below-reserve" ? { exhausted: true } : {}),
        detail: reason === "below-reserve"
          ? `${tier} Codex models have no reserved headroom`
          : reason === "quota-unreadable"
            ? `${tier} Codex quota is unreadable (${fallback.capacity.detail ?? "no detail"})`
            : `no ${tier} Codex model is eligible (${reason ?? "no decision"})`,
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
  /** Explicit task context for an operator-registered version overlap. */
  switchback?: { window: VersionSwitchbackWindow; taskId: string; at: string };
  /**
   * Injected capability ladder (W1-T2573), bypassing the `loadMounts` disk read below — for a
   * caller that already holds a validated Mounts table, and for tests. When omitted,
   * `readCodexCapacity` loads `.remudero/mounts.yaml` itself via `config.root`.
   */
  capabilities?: CapabilityLadder;
  /**
   * W1-T3958: a routing-pool-v1 snapshot and the session's request. A Codex route chosen from
   * the pool becomes the model-plus-effort preference unless the provider policy already set one.
   * {@link selectCodexModel} still checks that preference against this read. The receipt is
   * attached as `modelDecision.routingPool` whatever the outcome.
   */
  routingPool?: { snapshot: RoutingPoolSnapshot; request: RoutingPoolRequest };
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

/** W1-T3690: deadline lateness distinguishes a blocked daemon from a slow app-server. Node's timers
 * run before queued stdout, so blocking can time out an already-answered probe. Fleet 2026-09-16:
 * free loop 366ms; 12s block yielded "timed out after 10000ms; unfinished: initialize" at 12000ms.
 * Misclassification makes Codex unreadable, gives it zero allocation and shifts every lane to Claude. */
const CODEX_DEADLINE_OVERRUN_MS = 1_000;
const CODEX_OVERDUE_STDOUT_GRACE_MS = 1_000;

type CodexRuntimeResult = CodexRuntimeReading | CodexRuntimeFailure;

function codexRuntimeFailure(detail: string, failureKind: CodexRuntimeFailure["failureKind"] = "terminal"): CodexRuntimeFailure {
  return { provider: "codex", readable: false, windows: [], detail, failureKind };
}

const codexCapacityCache = new Map<string, { at: number; value: CodexRuntimeReading }>();
const codexCapacityFailureCache = new Map<string, { at: number; value: ProviderCapacity; failureKind: CodexRuntimeFailure["failureKind"] }>();
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
    /** Receives each spawned app-server's exit, so an off-thread probe can let it be reaped before its thread ends. */
    onChildSpawned?: (exited: Promise<void>) => void;
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
  deps.onChildSpawned?.(new Promise<void>((exited) => {
    child.once("exit", () => exited());
    child.once("error", () => exited());
  }));

  return new Promise<CodexRuntimeResult>((resolve) => {
    let settled = false;
    let cancelOverrunGrace: (() => void) | undefined;
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
      cancelDeadline();
      cancelOverrunGrace?.();
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
    const cancelDeadline = loopAvailableDeadline(systemClock, timeoutMs, () => {
      const malformed = malformedStdoutLines > 0 ? `; malformed app-server stdout: ${malformedStdoutLines} line(s)` : "";
      // THE DEADLINE OVERRAN => WE STALLED, NOT THE APP-SERVER. See CODEX_DEADLINE_OVERRUN_MS.
      // The child's reply may be sitting unread in the poll queue right now; this exchange
      // observed nothing about Codex and must not be reported as evidence against it.
      const elapsedMs = monotonicNow() - deadlineSetAt;
      if (malformedStdoutLines === 0 && elapsedMs >= timeoutMs + CODEX_DEADLINE_OVERRUN_MS) {
        // Timers run before the poll phase that delivers child stdout. Give a reply already
        // waiting in that phase one bounded turn before killing the child. Otherwise every
        // concurrent probe can declare Codex unreadable after the same event-loop stall.
        cancelOverrunGrace = loopAvailableDeadline(systemClock, CODEX_OVERDUE_STDOUT_GRACE_MS, () => finish(codexRuntimeFailure(
          `app-server deadline overran: ${timeoutMs}ms budget fired after ${elapsedMs}ms, so this process was stalled; ` +
            `unfinished after ${CODEX_OVERDUE_STDOUT_GRACE_MS}ms stdout grace: ${unfinishedPhases().join(", ") || "response validation"}`,
          malformedStdoutLines > 0 ? "terminal" : "starved",
        )));
        return;
      }
      finish(codexRuntimeFailure(
        `app-server timed out after ${timeoutMs}ms${malformed}; unfinished: ${unfinishedPhases().join(", ") || "response validation"}`,
        // Protocol noise is not the fleet-observed transient RPC stall and must not be retried.
        malformedStdoutLines > 0 ? "terminal" : "timeout",
      ));
    });
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
export async function readCodexRuntimeWithTimeoutHedge(
  config: Config,
  bin: string,
  deps: Pick<CodexCapacityDeps, "spawn" | "timeoutMs"> & { clock: Pick<Clock, "now">; onChildSpawned?: (exited: Promise<void>) => void },
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

/** Upper bound on waiting for a SIGKILLed app-server to exit before a probe thread reports. */
export const CODEX_PROBE_REAP_GRACE_MS = 2_000;

/**
 * The off-thread probe's read. A child spawned on a worker thread is reaped by that thread's event
 * loop, so the probe must not report (and be terminated) while a killed app-server is still
 * unreaped: otherwise the dead child stays a zombie of the daemon process.
 */
export async function readCodexRuntimeAwaitingReap(
  config: Config,
  bin: string,
  deps: Pick<CodexCapacityDeps, "spawn" | "timeoutMs"> & { clock: Pick<Clock, "now"> },
  graceMs = CODEX_PROBE_REAP_GRACE_MS,
): Promise<CodexRuntimeResult> {
  const exits: Promise<void>[] = [];
  const result = await readCodexRuntimeWithTimeoutHedge(config, bin, { ...deps, onChildSpawned: (exited) => exits.push(exited) });
  let grace: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(exits),
    new Promise<void>((done) => { grace = setTimeout(done, graceMs); }),
  ]);
  clearTimeout(grace);
  return result;
}

export function readCodexRuntimeOffThread(
  config: Config,
  bin: string,
  timeoutMs: number,
  workerFactory: (url: URL, options: ConstructorParameters<typeof Worker>[1]) => Worker = (url, options) => new Worker(url, options),
  outerDeadlineMs = 2 * timeoutMs + 5_000,
): Promise<CodexRuntimeResult> {
  return new Promise((resolve) => {
    let probe: Worker;
    try {
      probe = workerFactory(new URL("./codex-capacity-probe.mjs", import.meta.url), {
        workerData: { bin, codexHome: codexHome(config), timeoutMs },
        execArgv: ["--import", "tsx"],
      });
    } catch (error) {
      const reason = `app-server probe worker failed to start: ${String((error as Error).message ?? error)}`;
      resolve(codexRuntimeFailure(reason));
      return;
    }
    let settled = false;
    const finish = (result: CodexRuntimeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      void probe.terminate().catch((error) => {
        console.error(JSON.stringify({ event: "codex.capacity_probe.terminate_failed", error: String(error) }));
      });
      resolve(result);
    };
    const watchdog = setTimeout(() => {
      setImmediate(() => finish(codexRuntimeFailure("app-server probe worker exceeded its outer deadline")));
    }, outerDeadlineMs);
    probe.once("message", (result: CodexRuntimeResult) => {
      if (!result || typeof result !== "object" || !("provider" in result || "rateLimits" in result)) {
        finish(codexRuntimeFailure("app-server probe worker returned a malformed result"));
      } else {
        finish(result);
      }
    });
    probe.once("error", (error) => finish(codexRuntimeFailure(`app-server probe worker error: ${error.message}`)));
    probe.once("exit", (code) => finish(codexRuntimeFailure(`app-server probe worker exited ${code} before reporting`)));
  });
}

function startCodexRuntime(config: Config, bin: string, deps: CodexCapacityDeps, now: Clock["now"]): Promise<CodexRuntimeResult> {
  return deps.spawn
    ? readCodexRuntimeWithTimeoutHedge(config, bin, { ...deps, clock: { now } })
    : readCodexRuntimeOffThread(config, bin, deps.timeoutMs ?? 10_000);
}

function selectCodexRuntime(
  value: CodexRuntimeReading,
  config: Config,
  deps: CodexCapacityDeps,
  capabilities: CapabilityLadder | undefined,
): ProviderCapacity {
  // An attribution re-read measures a route that is already chosen, so it never consults the pool.
  const pooled = deps.routingPool && !deps.selectedModel
    ? selectFromRoutingPool(deps.routingPool.snapshot, deps.routingPool.request)
    : undefined;
  const pooledRoute = !deps.preferredModel && pooled?.chosen?.provider === "codex" &&
    (pooled.outcome === "pool" || pooled.outcome === "pinned" || pooled.outcome === "baseline")
    ? pooled.chosen
    : undefined;
  const requestedEffort = pooledRoute?.effort ?? deps.requestedEffort;
  const preferredModel = pooledRoute
    ? { capability: resolveCodexCapability(capabilities, deps.requestedModel).tier, effort: pooledRoute.effort, model: pooledRoute.model }
    : deps.preferredModel;
  const read = deps.selectedModel
    ? selectCodexAttributionModel(value.models, value.rateLimits, deps.selectedModel)
    : selectCodexModel(value.models, value.rateLimits, config, deps.requestedModel, requestedEffort, capabilities, {
      preferredModel,
      reservePercent: deps.reservePercent,
      switchback: deps.switchback,
    });
  const selected = pooled && read.modelDecision ? { ...read, modelDecision: { ...read.modelDecision, routingPool: pooled } } : read;
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

interface CodexLastGoodPoint { readAt: number; value: CodexRuntimeReading; invalidated?: true }
interface CodexLastGood { version: 1; bin: string; home: string; current: CodexLastGoodPoint; previous?: CodexLastGoodPoint }
/** PRIMARY CONTROL: bound retained telemetry, never a quota or reading-age threshold. */
const CODEX_LAST_GOOD_MAX_BYTES = 2 * 1024 * 1024;
function codexLastGoodPath(config: Config): string { return join(config.root, "state", "codex-capacity-last-good.json"); }

function readCodexLastGoodText(config: Config): string {
  const fd = openSync(codexLastGoodPath(config), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > CODEX_LAST_GOOD_MAX_BYTES) throw new Error("last-good telemetry exceeds its readable byte bound");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0, n: number;
    while (count < bytes.length && (n = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += n;
    if (count !== stat.size) throw new Error("last-good telemetry changed while reading");
    return bytes.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}

function decodeCodexLastGood(text: string, config: Config, bin: string): CodexLastGood {
  const value = JSON.parse(text) as CodexLastGood;
  const point = (p: CodexLastGoodPoint | undefined) => p && Number.isFinite(p.readAt) && p.readAt >= 0 &&
    p.value && typeof p.value.rateLimits === "object" && p.value.rateLimits !== null &&
    Array.isArray(p.value.models) && (p.invalidated === true || p.value.models.length > 0) && p.value.models.every(m => m && typeof m.id === "string");
  if (!value || value.version !== 1 || value.bin !== bin || value.home !== codexHome(config) ||
      !point(value.current) || (value.previous !== undefined && !point(value.previous)))
    throw new Error("last-good telemetry has a different identity or unreadable shape");
  return value;
}

function storedCodexRuntime(value: CodexRuntimeReading): CodexRuntimeReading {
  const source = value.rateLimits as CodexRateLimitResult;
  const window = (w: CodexRateLimitWindow | null | undefined) => w == null ? w
    : { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt };
  const bucket = (b: CodexRateLimitBucket | null | undefined) => b == null ? b : ({ limitId: b.limitId, limitName: b.limitName,
    primary: window(b.primary), secondary: window(b.secondary), rateLimitReachedType: b.rateLimitReachedType, spendControlReached: b.spendControlReached,
    credits: b.credits == null ? b.credits : { hasCredits: b.credits.hasCredits, unlimited: b.credits.unlimited, balance: b.credits.balance } });
  return { rateLimits: { rateLimits: bucket(source.rateLimits), accountId: source.accountId,
    rateLimitsByLimitId: source.rateLimitsByLimitId && Object.fromEntries(Object.entries(source.rateLimitsByLimitId).map(([id, b]) => [id, bucket(b)])) },
    models: value.models.map(({id, model, displayName, hidden, isDefault, defaultReasoningEffort, supportedReasoningEfforts}) =>
      ({id, model, displayName, hidden, isDefault, defaultReasoningEffort,
        supportedReasoningEfforts: supportedReasoningEfforts?.map(({reasoningEffort}) => ({reasoningEffort}))})) };
}

function rememberCodexRuntime(config: Config, bin: string, value: CodexRuntimeReading | undefined, readAt: number): string | undefined {
  try {
    let snapshot: string | undefined, previous: CodexLastGoodPoint | undefined;
    try { snapshot = readCodexLastGoodText(config); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (snapshot !== undefined) {
      try { previous = decodeCodexLastGood(snapshot, config, bin).current; }
      catch { /* A corrupt or foreign record cannot improve this genuinely fresh reading. */ }
    }
    if (previous && previous.readAt >= readAt) return undefined;
    const record: CodexLastGood = { version: 1, bin, home: codexHome(config), current: { readAt,
      value: value ? storedCodexRuntime(value) : { rateLimits: {}, models: [] }, ...(value ? {} : { invalidated: true }) },
      ...(previous ? { previous } : {}) };
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > CODEX_LAST_GOOD_MAX_BYTES) throw new Error("last-good telemetry exceeds its byte bound");
    const written = writeAtomic(codexLastGoodPath(config), body, { mode: 0o600, beforeRename: () => {
      try { return readCodexLastGoodText(config) === snapshot; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot === undefined; throw error; }
    } });
    if (!written) return "last-good persistence stood aside for a concurrent reading";
    return undefined;
  } catch (error) {
    const reason = `last-good persistence unavailable: ${String((error as Error).message).slice(0, 256)}`;
    console.error(JSON.stringify({ event: "codex.capacity.last_good_unavailable", reason }));
    return reason;
  }
}

function carryCodexCapacity(config: Config, bin: string, deps: CodexCapacityDeps, capabilities: CapabilityLadder | undefined,
  failure: ProviderCapacity, failureKind: CodexRuntimeFailure["failureKind"], now: number): ProviderCapacity {
  if (deps.forceRefresh || (failureKind !== "timeout" && failureKind !== "starved")) return failure;
  try {
    const saved = decodeCodexLastGood(readCodexLastGoodText(config), config, bin), current = saved.current, previous = saved.previous;
    if (current.invalidated) throw new Error("last-good invalidated by terminal probe evidence");
    const ageMs = now - current.readAt, reserve = deps.reservePercent ?? config.workerProviders?.reservePercent ?? 5;
    if (!Number.isFinite(ageMs) || ageMs < 0 || !Number.isFinite(reserve) || reserve < 0 || reserve >= 100) throw new Error("invalid clock or reserve");
    let windows = 0;
    const project = (w: CodexRateLimitWindow | null | undefined, old: CodexRateLimitWindow | null | undefined): CodexRateLimitWindow | null => {
      if (!w) return null;
      const used = w.usedPercent, duration = w.windowDurationMins, reset = w.resetsAt;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 ||
          typeof reset !== "number" || !Number.isFinite(reset) || reset * 1000 <= now) return null;
      const elapsed = current.readAt - (reset * 1000 - duration * 60_000);
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 || elapsed < 0 || (elapsed === 0 && used > 0))
        throw new Error("unreadable quota window");
      let burn = elapsed > 0 ? used / elapsed : 0;
      if (previous && previous.readAt < current.readAt && old?.resetsAt === reset && old.windowDurationMins === duration &&
          typeof old.usedPercent === "number" && Number.isFinite(old.usedPercent) && old.usedPercent >= 0 && old.usedPercent <= used)
        burn = Math.max(burn, (used - old.usedPercent) / (current.readAt - previous.readAt));
      const projected = used + burn * ageMs;
      if (!Number.isFinite(projected) || projected >= 100 - reserve) throw new Error("projected burn reaches the reserve");
      windows++;
      return { usedPercent: projected, windowDurationMins: duration, resetsAt: reset };
    };
    const currentRates = current.value.rateLimits as CodexRateLimitResult, previousRates = previous?.value.rateLimits as CodexRateLimitResult | undefined;
    const bucket = (b: CodexRateLimitBucket | null | undefined, old: CodexRateLimitBucket | null | undefined) => b == null ? b
      : { ...b, primary: project(b.primary, old?.primary), secondary: project(b.secondary, old?.secondary) };
    const rateLimits = { ...currentRates, rateLimits: bucket(currentRates.rateLimits, previousRates?.rateLimits),
      rateLimitsByLimitId: currentRates.rateLimitsByLimitId && Object.fromEntries(Object.entries(currentRates.rateLimitsByLimitId)
        .map(([id, b]) => [id, bucket(b, previousRates?.rateLimitsByLimitId?.[id])])) };
    if (windows === 0) throw new Error("no unreset quota window with a duration");
    const selected = selectCodexRuntime({ rateLimits, models: current.value.models }, config, deps, capabilities);
    if (!selected.readable) throw new Error(selected.detail ?? "projected model is unavailable");
    return { ...selected, carriedForward: { readAt: current.readAt, ageMs, failure: failure.detail ?? "probe unavailable" },
      detail: `Codex capacity carried forward ${ageMs}ms from ${fixedClock(current.readAt).iso()}; ${failure.detail ?? "probe unavailable"}` };
  } catch (error) {
    const reason = String((error as Error).message).slice(0, 256);
    return { ...failure, detail: `${failure.detail}; last-good unavailable: ${reason}` };
  }
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
      if (ageMs < failureBackoffMs) return carryCodexCapacity(config, bin, deps, capabilities,
        backedOffCodexFailure(failed.value, ageMs, failureBackoffMs), failed.failureKind, now());
      codexCapacityFailureCache.delete(cacheKey);
    }
  }

  let exchange: Promise<CodexRuntimeResult>;
  if (!deps.forceRefresh) {
    const active = codexCapacityInFlight.get(cacheKey);
    if (active) {
      exchange = active;
    } else {
      exchange = startCodexRuntime(config, bin, deps, now);
      codexCapacityInFlight.set(cacheKey, exchange);
    }
  } else {
    exchange = startCodexRuntime(config, bin, deps, now);
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
    if (failureKind === "terminal") rememberCodexRuntime(config, bin, undefined, now());
    // A STARVED READ IS NOT EVIDENCE ABOUT CODEX, so it must not buy a failure backoff. Caching it
    // would suppress the next read for up to CODEX_CAPACITY_FAILURE_BACKOFF_MAX_MS on the strength
    // of an exchange that observed nothing -- turning one blocked tick into a window in which the
    // provider is declared unreadable and every lane routes to the subscription instead.
    if (!deps.forceRefresh && failureKind !== "starved") {
      codexCapacityFailureCache.set(cacheKey, { at: now(), value: capacity, failureKind });
    }
    return carryCodexCapacity(config, bin, deps, capabilities, capacity, failureKind, now());
  }
  codexCapacityCache.set(cacheKey, { at: now(), value });
  codexCapacityFailureCache.delete(cacheKey);
  const selected = selectCodexRuntime(value, config, deps, capabilities);
  const persistence = rememberCodexRuntime(config, bin, value, now());
  if (persistence && !selected.readable) rememberCodexRuntime(config, bin, undefined, now());
  return persistence ? { ...selected, detail: [selected.detail, persistence].filter(Boolean).join("; ") } : selected;
}

/**
 * W1-T4650: WHY A CODEX ATTEMPT NAMES NO SERVED MODEL. The `exec --json` stream's events
 * (`thread.started`, `turn.*`, `item.*`, see {@link CodexJsonEvent}) carry no model id, so what
 * served the attempt is genuinely unreportable. Saying so by name keeps the row apart from one
 * that was never checked; `--model` is the REQUEST and is never echoed back as the served model.
 */
export const CODEX_SERVED_MODEL_REASON =
  "codex exec --json names no model: its thread, turn and item events carry no model id";

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  item?: {
    type?: string; text?: string; command?: string; aggregated_output?: string;
    /** A `file_change` item's changed paths; `kind` is "add", "update" or "delete". */
    changes?: ReadonlyArray<{ path?: unknown; kind?: unknown } | null>;
  };
}

export interface ParsedCodexEvents {
  sessionId: string;
  text: string;
  blocks: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  tokenUsageState: "observed" | "partial" | "unavailable";
  numTurns: number;
  isError: boolean;
  subtype: string;
  errors: string[];
  usageRefusal?: UsageLimitRefusal;
  outputTruncation?: CodexOutputTruncation;
}

export interface CodexOutputTruncation {
  limitBytes: number;
  retainedBytes: number;
  droppedBytes: number;
  spilledBytes: number;
}

/** PRIMARY CONTROL (W1-T4595): the most stdout one Codex worker may RETAIN (W1-T3490's heap), not stream. */
export const CODEX_WORKER_STDOUT_MAX_BYTES = 1 * 1024 * 1024;
/** BACKSTOP (W1-T4595): the total stdout one Codex worker may STREAM, against a runaway process. */
export const CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES = 64 * 1024 * 1024;
/** PRIMARY CONTROL (W1-T8203): a MEMORY bound on what is RETAINED of stderr, a share of the stdout retention bound. stderr is
 * diagnostic evidence (failure tail, retro evidence), never protocol input: passing this keeps the head and the
 * tail and records the drop. It never tears the worker down and never decides a verdict. */
export const CODEX_WORKER_STDERR_MAX_BYTES = CODEX_WORKER_STDOUT_MAX_BYTES / 4;

export interface CodexStderrTruncation {
  limitBytes: number;
  retainedBytes: number;
  droppedBytes: number;
}

/** W1-T8203: bounded stderr retention. Keeps the first quarter of the bound and the last three quarters (the tail
 * carries the final error); everything between is counted, not held. */
export class CodexStderrRetainer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private totalBytes = 0;

  constructor(private readonly limitBytes: number = CODEX_WORKER_STDERR_MAX_BYTES) {
    this.headLimit = Math.floor(limitBytes / 4);
    this.tailLimit = limitBytes - this.headLimit;
  }

  push(chunk: string): void {
    let buf = Buffer.from(chunk, "utf8");
    this.totalBytes += buf.length;
    if (this.headBytes < this.headLimit) {
      const take = Math.min(buf.length, this.headLimit - this.headBytes);
      this.head.push(buf.subarray(0, take));
      this.headBytes += take;
      buf = buf.subarray(take);
    }
    if (buf.length === 0) return;
    this.tail.push(buf);
    this.tailBytes += buf.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].length >= this.tailLimit) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  /** The retained tail, cut to its byte limit. */
  private tailBuffer(): Buffer {
    const all = Buffer.concat(this.tail);
    return all.length > this.tailLimit ? all.subarray(all.length - this.tailLimit) : all;
  }

  truncation(): CodexStderrTruncation | undefined {
    if (this.totalBytes <= this.limitBytes) return undefined;
    const retainedBytes = this.headBytes + this.tailBuffer().length;
    return { limitBytes: this.limitBytes, retainedBytes, droppedBytes: this.totalBytes - retainedBytes };
  }

  text(): string {
    const truncation = this.truncation();
    const head = Buffer.concat(this.head).toString("utf8");
    if (!truncation) return head + Buffer.concat(this.tail).toString("utf8");
    return `${head}\n[... ${truncation.droppedBytes} bytes of stderr dropped ...]\n${this.tailBuffer().toString("utf8")}`;
  }
}

/** A worker exceeded a bounded protocol or diagnostic stream before it could return a result. */
export interface CodexWorkerOutputLimitError extends Error {
  readonly name: "CodexWorkerOutputLimitError";
  readonly reasonClass: "bounded_output";
  readonly stream: "stdout" | "stderr";
  readonly limitBytes: number;
  readonly observedBytes: number;
  /** Bounded byte totals for complete JSONL events retained before stdout hit its cap. */
  readonly eventBytesByKind: Readonly<Record<string, number>>;
  /** Ledger-shaped alias kept on the error so the emitted retro field has a typed source. */
  readonly event_bytes_by_kind: Readonly<Record<string, number>>;
  /** Bytes in the incomplete JSONL line held when the cap fired. */
  readonly pendingLineBytes: number;
}

export function isCodexWorkerOutputLimitError(error: unknown): error is CodexWorkerOutputLimitError {
  if (!(error instanceof Error) || error.name !== "CodexWorkerOutputLimitError") return false;
  const candidate = error as Partial<CodexWorkerOutputLimitError>;
  // Older callers and test fixtures construct this typed error before the bounded event
  // evidence fields were added. Keep the established type guard compatible with those
  // producers; real spawn failures always populate both fields below.
  return (
    candidate.reasonClass === "bounded_output" &&
    (candidate.stream === "stdout" || candidate.stream === "stderr") &&
    typeof candidate.limitBytes === "number" &&
    typeof candidate.observedBytes === "number" &&
    (candidate.pendingLineBytes === undefined || typeof candidate.pendingLineBytes === "number") &&
    (candidate.eventBytesByKind === undefined ||
      (candidate.eventBytesByKind !== null && typeof candidate.eventBytesByKind === "object")) &&
    (candidate.event_bytes_by_kind === undefined ||
      (candidate.event_bytes_by_kind !== null && typeof candidate.event_bytes_by_kind === "object"))
  );
}

function codexWorkerOutputLimitError(
  stream: "stdout" | "stderr",
  limitBytes: number,
  observedBytes: number,
  eventBytesByKind: Readonly<Record<string, number>> = {},
  pendingLineBytes = 0,
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
    eventBytesByKind,
    event_bytes_by_kind: eventBytesByKind,
    pendingLineBytes,
  });
}

const CODEX_EVENT_BYTE_KIND_KEYS = [
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "error",
  "item.completed:agent_message",
  "item.completed:command_execution",
  "item.completed:file_change",
  "item.completed:reasoning",
  "item.completed:web_search",
  "malformed",
  "other",
] as const;
type CodexEventByteKind = (typeof CODEX_EVENT_BYTE_KIND_KEYS)[number];

/** Incrementally reduce Codex JSONL without retaining the complete transcript. */
class CodexJsonlAccumulator {
  private sessionId = "";
  private readonly blocks: string[] = [];
  private readonly errors: string[] = [];
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private completedTurns = 0;
  private usageTurns = 0;
  private missingUsageTurns = 0;
  private turnInProgress = false;
  private numTurns = 0;
  private usageRefusal: UsageLimitRefusal | undefined;
  private pending = "";
  private keptBytes = 0;
  private droppedBytes = 0;
  private spilledBytes = 0;
  private spilling = false;
  private failed = false;
  private readonly eventBytes: Record<CodexEventByteKind, number> = Object.fromEntries(
    CODEX_EVENT_BYTE_KIND_KEYS.map((key) => [key, 0]),
  ) as Record<CodexEventByteKind, number>;

  constructor(private nowMs: number, private readonly pendingFile?: string, private readonly observeToolLineage?: (raw: unknown) => void,
    private readonly observeMessage?: (text: string, tsMs: number) => void,
    private readonly observeToolCall?: (toolName: "Bash" | "Edit" | "Write", toolInput: Record<string, string>, tsMs: number) => void) {}

  push(chunk: string, nowMs = this.nowMs): void {
    this.nowMs = nowMs;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const part = chunk.slice(offset, newline < 0 ? chunk.length : newline);
      if (this.pendingFile && !this.spilling && this.retainedBytes() + Buffer.byteLength(part) > CODEX_WORKER_STDOUT_MAX_BYTES) {
        writeFileSync(this.pendingFile, this.pending, { mode: 0o600 });
        this.spilledBytes += this.pendingLineBytes();
        this.pending = "";
        this.spilling = true;
      }
      if (this.spilling) {
        appendFileSync(this.pendingFile!, part);
        this.spilledBytes += Buffer.byteLength(part);
      } else {
        this.pending += part;
      }
      if (newline < 0) break;
      this.consumePending();
      offset = newline + 1;
    }
  }

  private consumePending(): void {
    const line = this.spilling ? readFileSync(this.pendingFile!, "utf8") : this.pending;
    this.pending = "";
    this.spilling = false;
    this.consumeLine(line);
    if (this.pendingFile) this.boundRetained();
  }

  finish(): ParsedCodexEvents {
    if (this.spilling || this.pending.trim()) this.consumePending();
    const text = this.blocks.at(-1) ?? "";
    if (this.droppedBytes > 0 && this.blocks.length > 1) this.blocks.splice(1, 0, this.truncationMarker(this.droppedBytes));
    else if (this.spilledBytes > 0 && this.droppedBytes === 0) this.blocks.splice(1, 0, `\n[Codex stdout buffer truncated: ${this.spilledBytes} bytes spilled to disk]\n`);
    this.keptBytes = [...this.blocks, ...this.errors].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    return {
      sessionId: this.sessionId,
      text,
      blocks: this.blocks,
      tokens: { input: this.input, output: this.output, cacheRead: this.cacheRead, cacheCreation: 0 },
      tokenUsageState: this.usageTurns === 0 ? "unavailable"
        : this.missingUsageTurns > 0 || this.failed || this.turnInProgress || this.numTurns > this.completedTurns ? "partial" : "observed",
      numTurns: this.numTurns,
      isError: this.failed,
      subtype: this.failed ? "error_codex" : "success",
      errors: this.errors,
      ...(this.usageRefusal ? { usageRefusal: this.usageRefusal } : {}),
      ...(this.droppedBytes > 0 || this.spilledBytes > 0 ? { outputTruncation: {
        limitBytes: CODEX_WORKER_STDOUT_MAX_BYTES,
        retainedBytes: this.retainedBytes(),
        droppedBytes: this.droppedBytes,
        spilledBytes: this.spilledBytes,
      } } : {}),
    };
  }

  eventBytesByKind(): Readonly<Record<string, number>> {
    return { ...this.eventBytes };
  }

  pendingLineBytes(): number {
    return Buffer.byteLength(this.pending, "utf8");
  }

  /** W1-T4595: the unterminated line plus the kept blocks and errors. */
  retainedBytes(): number {
    return this.pendingLineBytes() + this.keptBytes;
  }

  private truncationMarker(bytes: number): string {
    return `\n[Codex output truncated: ${bytes} bytes omitted]\n`;
  }

  private boundText(text: string, limit: number): string {
    const raw = Buffer.from(text);
    if (raw.length <= limit) return text;
    const allowance = Math.max(0, limit - 80);
    let head = Math.floor(allowance / 2);
    let tail = raw.length - (allowance - head);
    while (head > 0 && (raw[head]! & 0xc0) === 0x80) head--;
    while (tail < raw.length && (raw[tail]! & 0xc0) === 0x80) tail++;
    const dropped = tail - head;
    this.droppedBytes += dropped;
    return raw.subarray(0, head).toString() + this.truncationMarker(dropped) + raw.subarray(tail).toString();
  }

  private boundRetained(): void {
    const budget = CODEX_WORKER_STDOUT_MAX_BYTES - 128;
    const bytes = (values: string[]) => values.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    while (this.errors.length > 1 && bytes(this.errors) > budget / 4) this.droppedBytes += Buffer.byteLength(this.errors.pop()!);
    if (this.errors.length) this.errors[0] = this.boundText(this.errors[0]!, budget / 4);
    const blockBudget = budget - bytes(this.errors);
    while (this.blocks.length > 2 && bytes(this.blocks) > blockBudget) this.droppedBytes += Buffer.byteLength(this.blocks.splice(1, 1)[0]!);
    if (bytes(this.blocks) > blockBudget) {
      if (this.blocks.length === 1) this.blocks[0] = this.boundText(this.blocks[0]!, blockBudget);
      else {
        const headBudget = Math.min(Buffer.byteLength(this.blocks[0]!), Math.floor(blockBudget / 2));
        this.blocks[0] = this.boundText(this.blocks[0]!, headBudget);
        this.blocks[1] = this.boundText(this.blocks[1]!, blockBudget - Buffer.byteLength(this.blocks[0]!));
      }
    }
    this.keptBytes = bytes(this.blocks) + bytes(this.errors);
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      this.observeToolLineage?.(null);
      this.eventBytes.malformed += Buffer.byteLength(line, "utf8") + 1;
      // Preserve malformed output in the returned error verdict instead of treating it as absence.
      this.errors.push(`unparseable Codex event: ${line.slice(0, 160)}`);
      this.failed = true;
      return;
    }
    this.observeToolLineage?.(event);
    const eventType = typeof event.type === "string" ? event.type : undefined;
    const itemType = typeof event.item?.type === "string" ? event.item.type : undefined;
    const combined = itemType && eventType ? `${eventType}:${itemType}` : eventType;
    const kind: CodexEventByteKind = CODEX_EVENT_BYTE_KIND_KEYS.includes(combined as CodexEventByteKind)
      ? (combined as CodexEventByteKind)
      : "other";
    this.eventBytes[kind] += Buffer.byteLength(line, "utf8") + 1;
    if (event.type === "thread.started" && typeof event.thread_id === "string") this.sessionId = event.thread_id;
    if (event.type === "turn.started") {
      this.numTurns += 1;
      this.turnInProgress = true;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      this.blocks.push(event.item.text);
      this.keptBytes += Buffer.byteLength(event.item.text, "utf8");
      this.observeMessage?.(event.item.text, this.nowMs);
    }
    if (event.type === "item.completed") this.observeToolCalls(event.item);
    if (event.type === "turn.completed") {
      this.turnInProgress = false;
      this.completedTurns += 1;
      const input = event.usage?.input_tokens;
      const output = event.usage?.output_tokens;
      const cached = event.usage?.cached_input_tokens;
      if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0
        && typeof output === "number" && Number.isSafeInteger(output) && output >= 0
        && typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0 && cached <= input
        && [this.input + input, this.output + output, this.cacheRead + cached].every(Number.isSafeInteger)) {
        this.input += input;
        this.output += output;
        this.cacheRead += cached;
        this.usageTurns += 1;
      } else {
        this.missingUsageTurns += 1;
      }
    }
    if (event.type === "turn.failed" || event.type === "error") {
      this.failed = true;
      this.turnInProgress = false;
      const message = event.error?.message ?? event.type;
      this.errors.push(message);
      this.keptBytes += Buffer.byteLength(message, "utf8");
      // Codex 0.152.0 preserves its structured UsageLimitExceeded classification inside app-server,
      // but `codex exec --json` intentionally projects only the terminal message. Normalize at this
      // adapter boundary while the text is known to be provider error evidence; never scan agent
      // output, which may discuss usage limits as part of the task.
      this.usageRefusal ??= detectUsageLimitRefusal(message, this.nowMs);
    }
  }

  /** W1-T10763: a completed command or file change is a tool call, named as a claude tool call is so its
   *  `worker.activity` row carries the same `toolStepSignature`. Only the item's own fields are read: a
   *  command is `Bash` with the script its shell wrapper ran, and a file change is one call per changed path,
   *  `Write` for an added file and `Edit` otherwise. */
  private observeToolCalls(item: CodexJsonEvent["item"]): void {
    if (!this.observeToolCall) return;
    if (item?.type === "command_execution" && typeof item.command === "string") {
      this.observeToolCall("Bash", { command: codexCommandScript(item.command) }, this.nowMs);
    }
    if (item?.type === "file_change" && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (typeof change?.path !== "string" || change.path.length === 0) continue;
        this.observeToolCall(change.kind === "add" ? "Write" : "Edit", { file_path: change.path }, this.nowMs);
      }
    }
  }
}

/** W1-T10763: the wrapper codex runs every command in, `<shell> -lc <script>`. */
export const CODEX_SHELL_WRAPPER_RE = /^(?:\/(?:usr\/)?bin\/)?(?:bash|sh|zsh|dash) +-l?c +([\s\S]+)$/;
/** One character a shell word may hold unquoted and still mean only itself. */
export const UNQUOTED_LITERAL_RE = /[A-Za-z0-9_./:@%+,=-]/;
/** The characters a backslash escapes inside double quotes; before any other, the backslash is literal. */
const DOUBLE_QUOTE_ESCAPABLE = "$`\"\\\n";

/** W1-T10763: codex reports a command as its whole shell wrapper, `/bin/bash -lc '<script>'`, and the script is
 *  the command the worker ran. It is returned only when the line is a known shell, `-c`/`-lc` and ONE word whose
 *  quoting expands nothing; any other line (a variable, a second argument, an unterminated quote) is returned as
 *  it came, never guessed at. */
export function codexCommandScript(command: string): string {
  const wrapped = CODEX_SHELL_WRAPPER_RE.exec(command);
  return (wrapped && literalShellWord(wrapped[1]!)) || command;
}

/** The value of one POSIX shell word that expands nothing, or `undefined` for anything else. */
function literalShellWord(text: string): string | undefined {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "$" || text[j] === "`") return undefined;
        if (text[j] === "\\" && j + 1 < text.length && DOUBLE_QUOTE_ESCAPABLE.includes(text[j + 1]!)) {
          j += 1;
          if (text[j] !== "\n") out += text[j];
        } else {
          out += text[j];
        }
      }
      if (j >= text.length) return undefined;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= text.length) return undefined;
      i += 1;
      if (text[i] !== "\n") out += text[i];
    } else if (UNQUOTED_LITERAL_RE.test(c)) {
      out += c;
    } else {
      return undefined;
    }
  }
  return out;
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

function codexSpawnEnv(config: Config, args: CodexSpawnEnvArgs, nativeCacheRoot?: string): Record<string, string | undefined> {
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
  if (nativeCacheRoot !== undefined) env.SWC_NATIVE_BINDING_CACHE = nativeCacheRoot;
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
    return hostWorktreeGit(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    // `git` missing, not a repo, or the probe otherwise failed to prove worktree membership --
    // treat as "not a worktree" so the bypass stays fail-closed on any unproven cwd.
    return false;
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

/** The adapter's actual resume boundary; routers reuse it rather than guessing from a mount. */
export function codexReadOnly(args: Pick<CodexSpawnArgs, "sandboxIntent" | "tools">): boolean {
  return args.sandboxIntent !== "disposable-review" && Array.isArray(args.tools) &&
    !args.tools.some((tool) => ["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(tool));
}

/**
 * W1-T6148 — WHO COMMITS A CODEX WRITER'S EDITS. The worker cannot (no gitdir write), so: its CALLER when
 * the caller told it the harness owns git (a shell-less bound, or a declared cash surface — the coherence
 * rule run-task.ts holds), else this module, after the run, through the host git leaf.
 */
export function codexHarnessCommits(args: Pick<CodexSpawnArgs, "sandboxIntent" | "tools" | "cashTools">): boolean {
  if (args.sandboxIntent === "disposable-review" || codexReadOnly(args as CodexSpawnArgs)) return false;
  const shellLess = Array.isArray(args.tools) && !args.tools.includes("Bash");
  return args.cashTools === undefined && !shellLess;
}

/** Told to a codex writer whose edits {@link commitCodexWriterEdits} commits. */
export const CODEX_HARNESS_COMMITS_PART =
  "GIT: your sandbox cannot write this repository's git directory, so do not run `git commit`, `git push` or any git " +
  "command that writes. The harness commits every change you leave in the worktree when you finish. End your final " +
  "message with one line `COMMIT_MESSAGE: <conventional-commit subject, at most 100 characters>`.\n\n";

const CODEX_FALLBACK_SUBJECT = "chore: commit the Codex worker's edits (harness commit, W1-T6148)";

/** The subject a codex writer asked for: its last anchored `COMMIT_MESSAGE:` line, as worker.ts reads one. */
export function codexCommitSubject(text: string): string {
  const matches = [...text.matchAll(/^[ \t]*COMMIT_MESSAGE:[ \t]*(.+)$/gim)];
  const subject = matches.at(-1)?.[1]?.trim() ?? "";
  return subject.length > 0 && subject.length <= 100 ? subject : CODEX_FALLBACK_SUBJECT;
}

export type CodexHarnessCommit =
  | { outcome: "committed"; sha: string; aliasRewrite?: AddedTestAliasRewrite }
  | { outcome: "nothing-to-commit" | "not-a-harness-worktree" }
  | { outcome: "refused"; reason: string };

/** Commit what a codex writer left in `cwd`, through the leaf (pinned gitdir, vetted config, harness hooks).
 *  Only in a tree `worktreeAdd` cut and recorded: a checkout the harness did not cut is never committed in. */
export function commitCodexWriterEdits(cwd: string, text: string): CodexHarnessCommit {
  if (recordedWorktreeGitDir(cwd) === null) return { outcome: "not-a-harness-worktree" };
  try {
    const status = hostWorktreeGit(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (status.trim() === "") return { outcome: "nothing-to-commit" };
    const changed = status.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
    const aliasRewrite = rewriteAddedTestImports(cwd, status, changed, (args) => hostWorktreeGit(cwd, args));
    hostWorktreeGit(cwd, ["add", "-A"]);
    hostWorktreeGit(cwd, ["commit", "-q", "-m", codexCommitSubject(text)]);
    const sha = hostWorktreeGit(cwd, ["rev-parse", "HEAD"]).trim();
    return Object.keys(aliasRewriteFields(aliasRewrite)).length > 0 ? { outcome: "committed", sha, aliasRewrite } : { outcome: "committed", sha };
  } catch (error) {
    // Not a success: the edits stay uncommitted and the reason is the row the caller's no-commit verdict cites.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "codex.harness_commit_refused", cwd, reason }));
    return { outcome: "refused", reason };
  }
}

/**
 * A Codex WRITER's grant to the host-wide test slot (#10612's src/lib/typecheck-run.ts). Its shell inherits only the
 * "core" variables and its bwrap binds `/` read-only, so without this a model's own `npm run typecheck` resolves no
 * {@link TEST_SLOT_DIR_ENV} and falls to a sandbox-local `/tmp/rmd-test-slots` (test-slot.ts `resolveTestSlotDir`):
 * a cold check that serialises against nothing on the host. Grant the ONE directory (lock records only, no credential,
 * no git config) and name it, plus the host's slot count, in the shell. Nothing outside the fleet (unset), and nothing
 * inside a test process, so a suite run in a fleet container builds the same argv as on a Mac.
 */
export function codexTestSlotArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env[TEST_SLOT_DIR_ENV];
  if (!dir || env.NODE_TEST_CONTEXT) return [];
  const args = ["--add-dir", dir, "-c", `shell_environment_policy.set.${TEST_SLOT_DIR_ENV}=${JSON.stringify(dir)}`];
  const slots = Number(env[TEST_SLOTS_ENV]);
  if (Number.isSafeInteger(slots) && slots >= 1) args.push("-c", `shell_environment_policy.set.${TEST_SLOTS_ENV}=${JSON.stringify(String(slots))}`);
  return args;
}

function codexExecArgs(args: CodexSpawnArgs, config: Config, selection?: Pick<ProviderCapacity, "model" | "effort">, nativeCacheRoot?: string): string[] {
  const model = selection?.model ?? config.workerProviders?.codexModel;
  // Never unnamed: with no --model, Codex runs the ACCOUNT default, which is gpt-6-astra (2026-09-22).
  if (!model) throw new Error("refusing a Codex spawn with no model: the account default would run unreviewed");
  assertModelAllowed(model, config);
  const effort = selection?.effort === "default" ? undefined : selection?.effort;
  const disposableReview = args.sandboxIntent === "disposable-review";
  const readOnly = codexReadOnly(args);
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
    ...(nativeCacheRoot === undefined ? [] : ["-c", `shell_environment_policy.set.SWC_NATIVE_BINDING_CACHE=${JSON.stringify(nativeCacheRoot)}`]),
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
  shared.push("--model", model);
  if (effort) shared.push("-c", `model_reasoning_effort=\"${effort}\"`);
  // `codex exec resume` accepts none of the fresh worker's workspace-write, cwd, or bounded-Git
  // containment arguments. A resumed writer must therefore start fresh through the ordinary
  // contained path below; the prompt already carries its predecessor's repair evidence. Read-only
  // and disposable-review continuations retain the CLI resume form byte-for-byte.
  if (args.resumeSessionId && (readOnly || disposableReview)) {
    return ["exec", "resume", ...shared, args.resumeSessionId, "-"];
  }
  // W1-T6148: NO `--add-dir` for the tree's git dir or common dir. A writer that could write either could
  // plant config the host's authenticated push honours, so the harness commits for it instead
  // ({@link commitCodexWriterEdits}).
  return [
    "exec",
    ...shared,
    ...(disposableReview ? [] : ["--sandbox", readOnly ? "read-only" : "workspace-write"]),
    ...(readOnly || disposableReview ? [] : ["-c", "sandbox_workspace_write.network_access=true"]),
    // Writers only: a reader or review runs no typecheck that needs the host slot.
    ...(readOnly || disposableReview ? [] : codexTestSlotArgs()),
    ...(nativeCacheRoot === undefined ? [] : ["--add-dir", nativeCacheRoot]),
    "-C", args.cwd,
    "-",
  ];
}

export async function spawnCodexWorker(
  args: CodexSpawnArgs,
  config: Config,
  selection?: Pick<ProviderCapacity, "model" | "effort"> & Partial<Pick<ProviderCapacity, "modelDecision">>,
): Promise<CodexWorkerResult> {
  const decision = selection?.modelDecision;
  const trial = decision && args.taskId && config.workerProviders?.codexModel === undefined && !decision.preferredModel && !decision.switchback
    ? await codexExperimentArmForTask({ stateDir: join(config.root, "state"), taskId: args.taskId,
      provider: "codex", capability: decision?.requestedCapability, effort: selection?.effort, model: selection?.model })
    : undefined;
  const assignment = trial?.state === "assigned" ? trial.assignment : undefined;
  const assignmentId = assignment ? randomUUID() : undefined;
  if (assignment && selection) {
    const target = decision?.options.find(option => option.id === assignment.assignedModel);
    const reserve = config.workerProviders?.reservePercent ?? 5;
    const available = target && modelAllowed(target.id, config) && target.supportedEfforts.includes(selection.effort ?? "")
      && target.windows.length > 0 && target.windows.every(window => validCapacityWindow(window) && window.usedPercent < 100 - reserve);
    if (available) {
      selection.model = assignment.assignedModel;
      if (decision) {
        decision.selectedModel = selection.model;
        for (const option of decision.options) option.selected = option.id === selection.model;
      }
    }
    appendLedger(ledgerPathFor(config), { run_id: args.runId ?? "unattributed", task_id: args.taskId!,
      step: "codex_experiment.assignment", assignment_id: assignmentId, experiment: assignment,
      requested_model: selection.model, crossover: selection.model !== assignment.assignedModel });
  }
  let result: CodexWorkerResult | undefined;
  let failure: string | undefined;
  try {
    result = await withTempDir("codex-worker", async (privateTmpDir) => {
      // Only positively verified writer worktrees receive the native-cache write grant.
      const nativeCacheRoot = process.platform !== "win32" && !codexReadOnly(args) && args.sandboxIntent !== "disposable-review" &&
        await verifiedGitWorktree(args.cwd)
        ? prepareWorkerNativeCache() : undefined;
      return spawnCodexWorkerInPrivateTemp(args, config, privateTmpDir, selection, nativeCacheRoot);
    });
    return result;
  } catch (error) {
    failure = (error as Error).message;
    throw error;
  } finally {
    if (assignment) appendLedger(ledgerPathFor(config), { run_id: args.runId ?? "unattributed", task_id: args.taskId!,
      step: "codex_experiment.receipt", assignment_id: assignmentId, experiment: assignment,
      requested_model: selection?.model, served_model: result?.servedModel ?? null,
      served_model_reason: result?.servedModelReason ?? failure ?? "worker produced no receipt",
      billing_mode: "subscription", total_cost_usd: result?.costUsd ?? null, notional_cost_usd: result?.notionalCostUsd ?? null,
      worker_duration_ms: result?.workerDurationMs, tokens: result?.tokens, success: result ? !result.isError : false,
      crossover: result?.servedModel == null ? null : result.servedModel !== assignment.assignedModel });
  }
}

/**
 * Native-cache eligibility: the trusted (pinned, config-vetted) Git adapter must answer
 * `rev-parse --is-inside-work-tree` with `true`. A missing `git`, a refused pointer, a non-repository
 * or a timed-out probe is NOT an answer, so eligibility stays closed (fail closed on every doubt).
 */
async function verifiedGitWorktree(cwd: string): Promise<boolean> {
  try {
    return (await hostWorktreeGitAsync(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    // The probe is unavailable or refused (git absent, pointer refused, not a repository, timeout): the
    // repository is unverified, so no cache grant or namespace is created.
    return false;
  }
}

/** Azure deployment authentication is process-local to the daemon. It is deliberately not a
 * config field and never enters a worker environment or a ledger row. */
export const OPENWEIGHT_API_KEY_ENV = "RMD_OPENWEIGHT_API_KEY";
export const FOUNDRY_CLAUDE_API_KEY_ENV = "RMD_FOUNDRY_CLAUDE_API_KEY";
export const FOUNDRY_CLAUDE_ENDPOINT_ENV = "RMD_FOUNDRY_CLAUDE_ENDPOINT";
/**
 * PRIMARY CONTROL: gpt-oss-120b is a reasoning model; 1,500 truncated a shard mid-string in the
 * live probe. The live cash union then recorded 54 replies truncated at the 5,000-token ceiling
 * (53 inbox drafts and one review). 8,000 is a bounded increase, not a removal: this exact value
 * still limits both context admission and the maximum cash reservation for every request.
 */
export const OPENWEIGHT_MAX_COMPLETION_TOKENS = 8_000;
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
 * W1-T3693(d) — THE GROUNDING/CITATION CONTRACT — DELIBERATELY NOT BUILT HERE.
 *
 * The task's own falsifier: "Close (d) without implementing if no lane wants a grounding
 * contract -- it is machinery for a judgement lane, and building it before one exists would be
 * the shipped-unwired shape." CHECKED 2026-09-17: `ruling-judge.ts` and `verify-human-judge.ts`
 * carry no reference to this provider at all, and the one judgement lane that CAN route through
 * `cash` -- `Mounts.escalation_judge` (escalate.ts) -- is ROUTING-ONLY: it parses a single
 * `ESCALATION_JUDGE_DECISION`/`ESCALATION_JUDGE_REASON` pair, not a list of asserted, citable
 * items. No lane asserts observed facts through this adapter today, so there is nothing for a
 * citation validator to guard, and imposing one unconditionally would be the "turn every task
 * into a YAML task" mistake this same file's output contract already warns against.
 *
 * (a) the request deadline ({@link OPENWEIGHT_REQUEST_TIMEOUT_MS}/{@link
 * OpenWeightRequestTimeoutError}), (b) the truncation refusal ({@link openWeightReplyIsTruncated}/
 * {@link OpenWeightTruncatedReplyError}) and (c) the fence-tolerant extractor ({@link
 * openWeightUnfence}) above are the transport fixes the falsifier says "stand regardless": they
 * are correctness on the transport, not a feature gated on a consumer wanting it.
 */
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
  /** Explicit Azure OpenAI billing policy, never inferred for another vendor or deployment. */
  unbilledAzureOpenAi429?: true;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Upper bound used before transport when a provider can bill cache writes above base input. */
  reservationInputUsdPerMillion?: number;
  /** Standard requests above this input size bill the whole request at the long-context rates. */
  cachedInputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  longContext?: { thresholdInputTokens: number; inputUsdPerMillion: number; outputUsdPerMillion: number;
    cachedInputUsdPerMillion?: number; cacheWriteUsdPerMillion?: number; reservationInputUsdPerMillion?: number };
  /** ISO date the published figures were last read. Not decorative: it is what lets a later
   *  reader tell a stale row from a current one without diffing against the vendor's page. */
  readAt: string;
}

/** Haiku's whole-request tier includes uncached input, cache reads and cache creation.
 *  Reserve the dearer one-hour cache-write rate; actual Azure invoice cost remains separate. */
export const FOUNDRY_HAIKU_PRICE: OpenWeightPrice = {
  inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, cachedInputUsdPerMillion: 0.01,
  cacheWriteUsdPerMillion: 0.2, reservationInputUsdPerMillion: 0.2,
  longContext: { thresholdInputTokens: 100_000, inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.05, cacheWriteUsdPerMillion: 1, reservationInputUsdPerMillion: 1 },
  readAt: "2026-10-07",
};

export const OPENWEIGHT_PRICES: Readonly<Record<string, OpenWeightPrice>> = {
  "claude-haiku-5-5": FOUNDRY_HAIKU_PRICE,
  // Azure serverless published rate. These are the two numbers this adapter has always used;
  // they are unchanged, and are now this deployment's ROW rather than the provider's default.
  "gpt-oss-120b": { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, readAt: "2026-09-14" },
  // W1-T3598: cheaper than gpt-oss-120b on BOTH axes (3x on input, 1.5x on output) and an
  // Azure-OpenAI-family deployment, so it rides `openWeightEndpoint`'s existing
  // `openai/deployments/...` route with no second endpoint shape.
  "gpt-5-nano": { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.4, unbilledAzureOpenAi429: true, readAt: "2026-09-15" },
  // gpt-5-mini was REMOVED, not demoted. Luna is cheaper on BOTH axes ($0.20/$1.20 vs
  // $0.25/$2.00) and measurably more efficient -- on an identical trivial prompt Luna spent 0
  // reasoning tokens where mini spent 64 of 76 -- so mini had no lane left where it was the right
  // row. Keeping it trailing would have implied a fallback worth reaching; there is none.
  //
  // PUBLISHED SHORT-CONTEXT RATES, read 2026-09-16 from Microsoft's GPT-5.6 Foundry announcement.
  // These are the SAME models the Codex subscription already routes (`gpt-5.6-luna`/`-terra` lead
  // the codex economy and balanced rows), so a squeeze diverts a lane to identical intelligence on
  // a different bill rather than to a cheaper substitute of unknown quality.
  "gpt-5.6-luna": { inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2, unbilledAzureOpenAi429: true, readAt: "2026-09-16" },
  // TERRA IS 10x LUNA ON BOTH AXES. It exists for the frontier band alone; nothing else may lead
  // with it. Sol ($5.00/$30.00) is deliberately NOT here -- 2.5x terra for the same band.
  "gpt-5.6-terra": { inputUsdPerMillion: 2.0, outputUsdPerMillion: 12.0, unbilledAzureOpenAi429: true, readAt: "2026-09-16" },
  // Foundry Global Standard, 2026-09-24; requests above 272K input use long-context rates.
  "gpt-6-luna": {
    unbilledAzureOpenAi429: true,
    inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5,
    longContext: { thresholdInputTokens: 272_000, inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.75 },
    readAt: "2026-09-24",
  },
  // Azure Global Standard, verified 2026-10-02; long context bills the entire request.
  "gpt-6.1-sol": {
    unbilledAzureOpenAi429: true,
    inputUsdPerMillion: 2, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 2.5,
    reservationInputUsdPerMillion: 2.5,
    longContext: { thresholdInputTokens: 272_000, inputUsdPerMillion: 4, outputUsdPerMillion: 15,
      cachedInputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 5, reservationInputUsdPerMillion: 5 },
    readAt: "2026-10-02",
  },
  // Global Standard, read 2026-10-27:
  // https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/gpt-6-1-terra-now-generally-available-in-microsoft-foundry-build-agents-that-see/4567769
  // No Microsoft threshold verified at https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/.
  // -1 selects long-context rates for EVERY request (including zero-input output receipts).
  "gpt-6.1-terra": {
    unbilledAzureOpenAi429: true,
    inputUsdPerMillion: 1, outputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.05, cacheWriteUsdPerMillion: 1.25,
    reservationInputUsdPerMillion: 1.25,
    longContext: { thresholdInputTokens: -1, inputUsdPerMillion: 2, outputUsdPerMillion: 7.5,
      cachedInputUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 2.5, reservationInputUsdPerMillion: 2.5 },
    readAt: "2026-10-27",
  },
};

/** Codex analytics only; these rows never admit a cash deployment (W1-T5664). */
export const CODEX_NOTIONAL_PRICES: Readonly<Record<string, OpenWeightPrice>> = {
  ...OPENWEIGHT_PRICES,
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  "gpt-6-sol": { inputUsdPerMillion: 2, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.2, readAt: "2026-10-08" },
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  "gpt-5.6-sol": { inputUsdPerMillion: 4, outputUsdPerMillion: 20, cachedInputUsdPerMillion: 0.4, readAt: "2026-10-08" },
};

/** Separate protocol and provider, but the same atomic cash allowance. */
export const FOUNDRY_OPUS_PRICE: OpenWeightPrice = {
  inputUsdPerMillion: 4, outputUsdPerMillion: 20,
  reservationInputUsdPerMillion: 8, readAt: "2026-09-24",
};

/**
 * Foundry Sonnet 5.5, through the SAME /anthropic adapter as Opus (W1-T4785). List price
 * $2 input / $10 output per million, read 2026-09-29. A cache write is reserved at 2x input, the
 * same discipline as the Opus row, so a later cache_control cannot undercount.
 */
export const FOUNDRY_SONNET_PRICE: OpenWeightPrice = {
  inputUsdPerMillion: 2, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.1,
  reservationInputUsdPerMillion: 4, readAt: "2026-10-07",
};

/** The deployment -> price table the Foundry Claude adapter serves. A deployment absent from it is
 *  not a Foundry Claude deployment, and the adapter refuses it. */
export const FOUNDRY_CLAUDE_PRICES: Readonly<Record<string, OpenWeightPrice>> = {
  "claude-haiku-5-5": FOUNDRY_HAIKU_PRICE,
  "claude-opus-5-5": FOUNDRY_OPUS_PRICE,
  "claude-sonnet-5-5": FOUNDRY_SONNET_PRICE,
};

export function isFoundryClaudeDeployment(deployment: string): boolean {
  return Object.hasOwn(FOUNDRY_CLAUDE_PRICES, deployment);
}

/** PRIMARY CONTROL: the UTC-day FOUNDRY CLAUDE limit inside the shared cash allowance. ONE cap over
 *  every Foundry Claude deployment (Opus and Sonnet), so a second deployment cannot double it. */
export const FOUNDRY_CLAUDE_DAILY_CAP_USD = { normal: 5, squeezed: 10 } as const;

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
  "gpt-6.1-sol": ["json_object"],
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
  "claude-haiku-5-5": null,
  "gpt-oss-120b": 0,
  "gpt-5-nano": null,
  // MEASURED 2026-09-16 with the adapter's own URL and api-version: `temperature: 0` returns
  // HTTP 400 ("does not support 0 with this model. Only the default (1) value is supported"),
  // byte-identical to nano's refusal. So the field is OMITTED, never sent as 0.
  // Both refuse `temperature: 0` with HTTP 400 ("only the default (1) value is supported"),
  // measured 2026-09-16 -- the same refusal nano gives, so the field is omitted rather than sent.
  "gpt-5.6-luna": null,
  "gpt-5.6-terra": null,
  "gpt-6-luna": null,
  "gpt-6.1-sol": null,
  // GA request shape, read 2026-10-27; omit temperature for Terra reasoning requests.
  // https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/gpt-6-1-terra-now-generally-available-in-microsoft-foundry-build-agents-that-see/4567769
  "gpt-6.1-terra": null,
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

/** The endpoint answered 404: no deployment by this name exists (yet). Distinct from every other
 *  failure because the NEXT rung can succeed and a retry of this one cannot (W1-T4079). */
export class OpenWeightDeploymentNotFoundError extends RmdError {
  readonly deployment: string;
  constructor(deployment: string) {
    super("usage", 1, `openweight deployment ${JSON.stringify(deployment)} does not exist on the endpoint (HTTP 404)`, { deployment });
    this.name = "OpenWeightDeploymentNotFoundError";
    this.deployment = deployment;
  }
}

/** W1-T10837 design (iii): `deployment` is named in `workerProviders.cashDeploymentEndpoints` but
 *  its own `keyEnv` is unset in the daemon environment. Distinct from the plain "requires
 *  RMD_OPENWEIGHT_API_KEY" refusal an UNMAPPED deployment gets: this deployment is NOT READY and
 *  must never fall back to the default key, which bills a different Azure account. */
export class CashDeploymentNotReadyError extends RmdError {
  readonly deployment: string;
  readonly keyEnv: string;
  constructor(deployment: string, keyEnv: string) {
    super("usage", 1, `cash deployment ${JSON.stringify(deployment)} maps to ${keyEnv}, which is unset in the daemon environment`, { deployment, keyEnv });
    this.name = "CashDeploymentNotReadyError";
    this.deployment = deployment;
    this.keyEnv = keyEnv;
  }
}

class CashHttpFailure extends RmdError {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number, readonly limitTokens?: number) {
    super("usage", 1, message, { status, retryAfterMs, limitTokens });
    this.name = "CashHttpFailure";
  }
}

/** W1-T10856: a 429 whose own request cannot fit the limit THE SAME RESPONSE reported. Waiting cannot
 *  help, so it carries no `retryAfterMs` and is never retried. A subclass, so every settlement rule
 *  that reads a 429 (the unbilled Azure OpenAI refusal) still sees one. */
class CashCapacityShortfallFailure extends CashHttpFailure {
  constructor(source: string, readonly estimatedTokens: number, limitTokens: number) {
    super(`${source} request failed with HTTP 429 capacity_shortfall ${JSON.stringify({ estimated_tokens: estimatedTokens, limit_tokens: limitTokens })}`,
      429, undefined, limitTokens);
    this.name = "CashCapacityShortfallFailure";
  }
}

/** Operator-approved prospectively: Azure OpenAI throttles are unbilled (Microsoft Q&A 1632971).
 * A model name alone is not provider identity: another HTTPS endpoint keeps conservative charging. */
function unbilledAzureOpenAi429Policy(model: string, endpoint: string): boolean {
  const url = new URL(endpoint);
  return openWeightPriceFor(model).unbilledAzureOpenAi429 === true && url.protocol === "https:" &&
    url.port === "" && (url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".cognitiveservices.azure.com"));
}

function unbilledCashRefusal(error: unknown, azureOpenAi429: boolean): boolean {
  return error instanceof OpenWeightDeploymentNotFoundError ||
    (azureOpenAi429 && error instanceof CashHttpFailure && error.status === 429);
}

const CASH_ERROR_CATEGORY_TYPES = new Set(["invalid_request_error", "authentication_error", "permission_error",
  "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "billing_error", "timeout_error"]);
/** Operator-approved retained/decoded byte bound, not a transport-buffer/RSS cap or another request's authority. */
const CASH_ERROR_BODY_BYTES = 8 * 1024;
type CashBadRequestEvidence = { error_category?: string; context_too_long?: true; body_diagnostics?: "oversized" | "unreadable" };

/** Interpret only a complete bounded HTTP400 envelope. No body/message or arbitrary value leaves this reader. */
async function cashBadRequestEvidence(response: Response, signal: AbortSignal): Promise<CashBadRequestEvidence> {
  if (response.status !== 400) return {};
  let evidence: CashBadRequestEvidence = {}, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = []; let length = 0, complete = false;
      for (;;) {
        const part = await cashAbortable(signal, () => reader!.read());
        if (part.done) { complete = true; break; }
        if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) throw new Error("invalid error-envelope chunk");
        length += part.value.byteLength;
        // Never classify a valid-looking prefix or trust the server's Content-Length.
        if (length > CASH_ERROR_BODY_BYTES) { evidence = { body_diagnostics: "oversized" }; break; }
        chunks.push(part.value);
      }
      if (complete) {
        const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
        const error = payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { error?: unknown }).error : undefined;
        if (error !== null && typeof error === "object" && !Array.isArray(error)) {
          const { type, message } = error as { type?: unknown; message?: unknown };
          if (typeof type === "string" && CASH_ERROR_CATEGORY_TYPES.has(type)) evidence.error_category = type;
          // Signature inference is advisory only; it never changes HTTP status, retries or allowance accounting.
          if (evidence.error_category && typeof message === "string" && message.includes("prompt is too long")) evidence.context_too_long = true;
        }
      }
    }
  } catch {
    signal.throwIfAborted(); // Diagnostics cannot absorb caller cancellation or extend the existing request window.
    evidence = { body_diagnostics: "unreadable" };
  } finally {
    try { reader?.releaseLock(); }
    catch {
      // A broken stream lock invalidates classification; retain only unreadability, never its exception text.
      evidence = { body_diagnostics: "unreadable" };
    }
  }
  return evidence;
}

/** Keep bounded allowlisted diagnostics, never response bodies, arbitrary headers or credentials. */
async function cashHttpFailure(response: Response, source: string, signal: AbortSignal): Promise<Error> {
  const evidence: Record<string, number | string | boolean> = {};
  let continuationDelay: number | undefined;
  let limitTokens: number | undefined;
  try {
    const unsigned = (name: string): number | undefined => cashUnsignedHeader(response.headers, name);
    const millis = unsigned("retry-after-ms"), seconds = unsigned("retry-after");
    const retryAfter = millis ?? (seconds !== undefined && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined);
    continuationDelay = response.headers.get("retry-after-ms") !== null ? millis : retryAfter;
    if (retryAfter !== undefined) evidence.retry_after_ms = retryAfter;
    const requests = unsigned("x-ratelimit-remaining-requests"), tokens = unsigned("x-ratelimit-remaining-tokens");
    if (requests !== undefined) evidence.remaining_requests = requests;
    if (tokens !== undefined) evidence.remaining_tokens = tokens;
    limitTokens = unsigned("x-ratelimit-limit-tokens");
    if (limitTokens !== undefined) evidence.limit_tokens = limitTokens;
    for (const name of ["apim-request-id", "x-request-id"]) {
      const value = response.headers.get(name);
      if (value !== null && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
        evidence.request_id = value;
        break;
      }
    }
  } catch {
    // An unreadable diagnostic must not replace the actual HTTP failure or expose its exception.
    evidence.diagnostics = "unreadable";
    continuationDelay = undefined;
  }
  Object.assign(evidence, await cashBadRequestEvidence(response, signal));
  const suffix = Object.keys(evidence).length > 0 ? ` ${JSON.stringify(evidence)}` : "";
  return new CashHttpFailure(`${source} request failed with HTTP ${response.status}${suffix}`, response.status, continuationDelay, limitTokens);
}

/** A provider that ignores cancellation must still not hold its caller or wake up to spend later. */
function cashAbortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const finish = (done: () => void): void => {
      signal.removeEventListener("abort", aborted);
      done();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(
      value => finish(() => resolve(value)), error => finish(() => reject(error)),
    );
  });
}

/** One unchanged-payload request, bounded across all paid attempts, body reads and server cooldowns. */
async function cashRequestJson<T>(input: {
  args: OpenWeightSpawnArgs; deployment: string; source: string; endpoint: string;
  body: string; headers: Record<string, string>; next: (checkActive: () => void) => T;
  canContinue: () => boolean; chargeFailure: (error: Error) => void;
  /** W1-T10856: sees every response's headers (success or failure) before its status is handled. */
  observeHeaders?: (headers: Headers) => void;
}): Promise<{ envelope: unknown; attempt: T }> {
  const { args } = input;
  const timeoutMs = args.requestTimeoutMs ?? OPENWEIGHT_REQUEST_TIMEOUT_MS;
  const clock = args.clock ?? systemClock;
  const expires = clock.now() + timeoutMs;
  const controller = new AbortController();
  const relay = (): void => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) relay();
  else args.signal?.addEventListener("abort", relay, { once: true });
  const timeout = (): void => controller.abort(new OpenWeightRequestTimeoutError(timeoutMs, input.deployment));
  const checkActive = (): void => {
    if (clock.now() >= expires) timeout();
    controller.signal.throwIfAborted();
  };
  const timer = setTimeout(timeout, timeoutMs);
  try {
    for (;;) {
      checkActive();
      const attempt = input.next(checkActive);
      checkActive();
      try {
        const response = await cashAbortable(controller.signal, () => {
          checkActive();
          return (args.fetchImpl ?? fetch)(input.endpoint, {
            method: "POST", headers: input.headers, body: input.body, signal: controller.signal,
          });
        });
        try { input.observeHeaders?.(response.headers); }
        catch (error) {
          // Unreadable headers teach nothing; a failing response reports them itself in `cashHttpFailure`.
          console.error(JSON.stringify({ event: "cash.capacity.headers_unreadable", reason: error instanceof Error ? error.name : "unknown" }));
        }
        if (response.status === 404) throw new OpenWeightDeploymentNotFoundError(input.deployment);
        if (!response.ok) {
          try {
            const failure = await cashHttpFailure(response, input.source, controller.signal);
            checkActive();
            // AN OVERSIZED 429 IS NOT TRANSIENT: the same sum the fit gate uses, against the limit this response named.
            if (failure instanceof CashHttpFailure && failure.status === 429 && failure.limitTokens !== undefined) {
              const need = openWeightEstimatedTokens(Buffer.byteLength(input.body, "utf8")) + OPENWEIGHT_MAX_COMPLETION_TOKENS;
              if (need > failure.limitTokens) throw new CashCapacityShortfallFailure(input.source, need - OPENWEIGHT_MAX_COMPLETION_TOKENS, failure.limitTokens);
            }
            throw failure;
          } finally {
            // The bounded reader releases its lock first; unread or oversized tails are never retained.
            try { void response.body?.cancel().catch(() => {
              console.error(JSON.stringify({ event: "cash.error_body_cancel_failed", status: response.status }));
            }); } catch {
              console.error(JSON.stringify({ event: "cash.error_body_cancel_failed", status: response.status }));
            }
          }
        }
        const envelope = await cashAbortable(controller.signal, () => response.json());
        checkActive();
        args.streamObserver?.({ kind: "working", tsMs: (args.clock ?? systemClock).now() });
        return { envelope, attempt };
      } catch (error) {
        if (!(error instanceof CashHttpFailure) || error.status !== 429 ||
            error.retryAfterMs === undefined || error.retryAfterMs <= 0 ||
            error.retryAfterMs >= expires - clock.now() || !input.canContinue()) throw error;
        input.chargeFailure(error);
        checkActive();
        if (error.retryAfterMs >= expires - clock.now()) throw error;
        await abortableDelay(error.retryAfterMs, undefined, { signal: controller.signal });
      }
    }
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", relay);
  }
}

/** How long a 404 keeps a deployment out of selection before one request asks again. */
export const OPENWEIGHT_ABSENT_TTL_MS = 30 * 60_000;
const openWeightAbsentUntil = new Map<string, number>();

/** Record a definitive 404. Only a 404 changes the reading; a timeout or any other failure leaves it. */
export function markOpenWeightDeploymentAbsent(deployment: string, nowMs = systemClock.now()): void {
  openWeightAbsentUntil.set(deployment, nowMs + OPENWEIGHT_ABSENT_TTL_MS);
}

export function openWeightDeploymentKnownAbsent(deployment: string, nowMs = systemClock.now()): boolean {
  const until = openWeightAbsentUntil.get(deployment);
  return until !== undefined && nowMs < until;
}

export function clearOpenWeightAbsence(): void {
  openWeightAbsentUntil.clear();
}

/** READY = priced, shaped and context-sized, and not known absent. A successor can lead a ladder row
 *  before any of that is true; until it is, selection passes over it as if it were not listed. */
export function openWeightDeploymentReady(deployment: string, nowMs = systemClock.now()): boolean {
  return (
    Object.prototype.hasOwnProperty.call(OPENWEIGHT_PRICES, deployment) &&
    Object.prototype.hasOwnProperty.call(OPENWEIGHT_TEMPERATURE, deployment) &&
    Object.prototype.hasOwnProperty.call(OPENWEIGHT_CONTEXT_WINDOWS, deployment) &&
    !openWeightDeploymentKnownAbsent(deployment, nowMs)
  );
}

/** Successors listed in the cash ladder ahead of their deployment and price (W1-T4079). The one
 *  exemption from "every listed deployment is priced, shaped and bounded"; selection passes over them
 *  until {@link openWeightDeploymentReady}. Remove an id once its rows exist. */
export const OPENWEIGHT_AWAITING_READINESS: ReadonlySet<string> = new Set();

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
  const row = isFoundryClaudeDeployment(deployment) ? FOUNDRY_CLAUDE_PRICES[deployment] : OPENWEIGHT_PRICES[deployment];
  if (row === undefined) throw new OpenWeightUnpricedDeploymentError(deployment);
  return row;
}

/** Dollars for one request's measured usage, at that deployment's own rate. */
export function openWeightUsageUsd(deployment: string, promptTokens: number, completionTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0): number {
  const price = openWeightPriceFor(deployment);
  const rate = price.longContext && promptTokens > price.longContext.thresholdInputTokens ? price.longContext : price;
  const cached = Math.min(promptTokens, Math.max(0, cacheReadTokens));
  const written = Math.min(promptTokens - cached, Math.max(0, cacheCreationTokens));
  return ((promptTokens - cached - written) * rate.inputUsdPerMillion +
    cached * (rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion) +
    written * (rate.cacheWriteUsdPerMillion ?? rate.inputUsdPerMillion) +
    completionTokens * rate.outputUsdPerMillion) / 1_000_000;
}

/**
 * W1-T5629: the NOTIONAL dollars of one codex session — what its tokens would cost at the routed model's published
 * BASE rate, so a codex row stops reading as free beside Claude's notional price. Never billed: the subscription
 * charges no per-request dollar, so this rides `notional_cost_usd` and `costUsd` stays 0 for every budget and cap.
 * Base rate because the tokens are a SESSION sum, and the long-context tier prices a single request. Codex input
 * includes its cached input. `undefined`, never 0, for a model {@link CODEX_NOTIONAL_PRICES} does not price.
 */
export function codexNotionalCostUsd(model: string, tokens: { input: number; output: number; cacheRead: number }): number | undefined {
  if (!Object.hasOwn(CODEX_NOTIONAL_PRICES, model)) return undefined;
  const price = CODEX_NOTIONAL_PRICES[model];
  const cached = Math.min(tokens.input, tokens.cacheRead);
  return ((tokens.input - cached) * price.inputUsdPerMillion +
    cached * (price.cachedInputUsdPerMillion ?? price.inputUsdPerMillion) +
    tokens.output * price.outputUsdPerMillion) / 1_000_000;
}

/** The allowance file. A fleet override must point at the same pre-migrated host mount in every cash instance. */
export const OPENWEIGHT_ALLOWANCE_FILENAME = "openweight-allowance.json";
export function sharedCashAllowancePath(config: Config): string | undefined {
  const path = config.workerProviders?.fleetCashAllowancePath;
  if (path !== undefined && (!isAbsolute(path) || !path.endsWith(".json"))) {
    throw new Error("shared cash allowance path must be an absolute JSON file path");
  }
  return path;
}
export function openWeightAllowancePath(config: Config): string {
  return sharedCashAllowancePath(config) ?? join(config.root, "state", OPENWEIGHT_ALLOWANCE_FILENAME);
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
  fleetCapUsd?: number;
  reservations: Record<string, { reservedUsd: number; settledUsd: number | null; settledReason?: string; deployment?: string }>;
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
  const rate = price.longContext && inputTokenCeiling > price.longContext.thresholdInputTokens ? price.longContext : price;
  return (inputTokenCeiling * (rate.reservationInputUsdPerMillion ?? price.reservationInputUsdPerMillion ?? rate.inputUsdPerMillion) + OPENWEIGHT_MAX_COMPLETION_TOKENS * rate.outputUsdPerMillion) / 1_000_000;
}

/** Raised INSTEAD of sending a paid request. It is thrown before the transport, never after, so a
 *  caller that sees it knows no money was spent on the refused attempt. */
export class OpenWeightAllowanceExhaustedError extends RmdError {
  readonly committedUsd: number;
  readonly capUsd: number;
  readonly wantUsd: number;
  readonly resetAt: string;
  /** W1-T10384: which limit refused. `fleet` is the shared dailyCapUsd; `foundry-claude` is the
   *  Foundry Claude sub-cap, which binds below the fleet cap and is the one a Luna rung can outlive. */
  readonly limit: CashAllowanceLimitName;
  readonly squeezed: boolean;
  constructor(detail: { committedUsd: number; capUsd: number; wantUsd: number; utcDay: string; limit?: CashAllowanceLimitName; squeezed?: boolean }) {
    const limit = detail.limit ?? "fleet";
    const posture = detail.squeezed === true ? "squeezed" : "normal";
    const bound = limit === "foundry-claude"
      ? `foundry-claude cap (FOUNDRY_CLAUDE_DAILY_CAP_USD.${posture}, ${posture} posture)`
      : `dailyCapUsd (fleet limit, ${posture} posture)`;
    // Kind "usage", the same discriminant `GhReadCadenceRefusal` carries: both are a LIMIT refusing
    // a call that was otherwise well-formed, not a malformed request. Adopting the shared envelope
    // rather than extending `Error` directly is what `test/error-subclass-census.test.ts` asks a new
    // class to do — its ceiling is a ratchet, so a new direct subclass would have to raise it.
    super(
      "usage",
      1,
      `openweight daily allowance exhausted for ${detail.utcDay}: committed $${detail.committedUsd.toFixed(6)} + ` +
        `$${detail.wantUsd.toFixed(6)} would exceed the $${detail.capUsd.toFixed(2)} ${bound}`,
      { committedUsd: detail.committedUsd, capUsd: detail.capUsd, wantUsd: detail.wantUsd, utcDay: detail.utcDay, limit, posture },
    );
    this.name = "OpenWeightAllowanceExhaustedError";
    this.committedUsd = detail.committedUsd;
    this.capUsd = detail.capUsd;
    this.wantUsd = detail.wantUsd;
    this.resetAt = openWeightAllowanceReset(detail.utcDay);
    this.limit = limit;
    this.squeezed = detail.squeezed === true;
  }
}

/** The two limits a cash reservation is checked against. */
export type CashAllowanceLimitName = "fleet" | "foundry-claude";

function openWeightAllowanceReset(day: string): string {
  return fixedClock(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).iso();
}

function parseOpenWeightAllowance(snapshot: string | undefined, path: string, utcDay: string, requireFleetCap: boolean): OpenWeightAllowanceState {
  if (snapshot === undefined) {
    if (requireFleetCap) throw new Error(`shared cash allowance is missing at ${path}; refusing to reset unknown fleet spend`);
    return { utcDay, reservations: {} };
  }
  let parsed: Partial<OpenWeightAllowanceState>;
  try { parsed = JSON.parse(snapshot) as Partial<OpenWeightAllowanceState>; }
  catch (error) {
    throw new Error(`openweight allowance file is unreadable at ${path}; refusing to spend against an unknown committed total (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.utcDay) ||
      parsed.reservations === null || typeof parsed.reservations !== "object" || Array.isArray(parsed.reservations)) {
    throw new Error(`openweight allowance file at ${path} has no readable utcDay/reservations; refusing to spend against an unknown committed total`);
  }
  if (requireFleetCap && (!Number.isFinite(parsed.fleetCapUsd) || (parsed.fleetCapUsd ?? 0) <= 0))
    throw new Error(`shared cash allowance at ${path} has no valid fleet cap; refusing paid spend`);
  for (const [id, row] of Object.entries(parsed.reservations)) {
    if (!id || row === null || typeof row !== "object" || !Number.isFinite(row.reservedUsd) || row.reservedUsd < 0 ||
        (row.settledUsd !== null && (!Number.isFinite(row.settledUsd) || row.settledUsd < 0 || row.settledUsd > row.reservedUsd)) ||
        (row.deployment !== undefined && typeof row.deployment !== "string")) {
      throw new Error(`openweight allowance file at ${path} has an unreadable reservation ${id}; refusing to spend against an unknown committed total`);
    }
  }
  if (requireFleetCap && parsed.utcDay > utcDay)
    throw new Error(`shared cash allowance is already on ${parsed.utcDay}; refusing an older ${utcDay} request`);
  return { utcDay, fleetCapUsd: parsed.fleetCapUsd, reservations: parsed.utcDay === utcDay ? parsed.reservations : {} };
}

function configuredCashCap(config: Config, squeezed?: boolean): number {
  const cap = effectiveCashCapUsd(config.dailyCapUsd, { squeezed });
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) throw new Error("cash provider requires a dailyCapUsd before any paid request");
  return cap;
}

function cashAllowanceLimits(state: OpenWeightAllowanceState, cap: number, deployment: string, squeezed?: boolean) {
  const limits: { committedUsd: number; capUsd: number; limit: CashAllowanceLimitName }[] =
    [{ committedUsd: openWeightCommittedUsd(state), capUsd: Math.min(cap, state.fleetCapUsd ?? Infinity), limit: "fleet" }];
  if (isFoundryClaudeDeployment(deployment)) {
    const reservations = Object.fromEntries(Object.entries(state.reservations)
      .filter(([, row]) => row.deployment !== undefined && isFoundryClaudeDeployment(row.deployment)));
    limits.push({ committedUsd: openWeightCommittedUsd({ utcDay: state.utcDay, reservations }),
      capUsd: squeezed ? FOUNDRY_CLAUDE_DAILY_CAP_USD.squeezed : FOUNDRY_CLAUDE_DAILY_CAP_USD.normal, limit: "foundry-claude" });
  }
  return limits;
}

/** Observe without locking, reserving or writing; the adapter's later reservation remains binding. */
export function readOpenWeightAllowance(config: Config,
  input: { deployments: readonly string[]; atIso: string; squeezed?: boolean }) {
  const utcDay = openWeightUtcDay(input.atIso), path = openWeightAllowancePath(config);
  const state = parseOpenWeightAllowance(readFileIfExists(path), path, utcDay, sharedCashAllowancePath(config) !== undefined);
  const cap = configuredCashCap(config, input.squeezed);
  return { resetAt: openWeightAllowanceReset(utcDay), deployments: input.deployments.map(deployment => {
    const limits = cashAllowanceLimits(state, cap, deployment, input.squeezed);
    const tightest = limits.reduce((a, b) => a.capUsd - a.committedUsd <= b.capUsd - b.committedUsd ? a : b);
    return { deployment, ...tightest, remainingUsd: tightest.capUsd - tightest.committedUsd };
  }) };
}

/** How many times a compare-and-swap may lose its race before the reservation gives up. A loss
 *  needs a PEER to have committed between this call's read and its rename, so a handful of retries
 *  covers any realistic interleaving; the bound only stops a pathological peer spinning us forever. */
export const OPENWEIGHT_ALLOWANCE_CAS_ATTEMPTS = 12;

/**
 * Fleet mode holds a SQLite write lock; local mode retains its historical optimistic retry.
 *
 * `writeAtomic`'s `beforeRename` checks for a changed snapshot: the new state is staged in the same
 * directory, then, immediately before the rename commits it, the live file is re-read and compared
 * to the exact bytes this attempt planned from. A peer that committed in that window changes those
 * bytes, the stage is withdrawn, and the whole read-modify-write retries against the peer's
 * committed state. This check alone is not an interprocess CAS; the fleet lock supplies that.
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
  shared = false,
  requireFleetCap = false,
): T {
  if (shared) {
    return withFleetCashAllowanceLock(path, () => mutateOpenWeightAllowance(path, utcDay, mutate, beforeCommit, false, true));
  }
  for (let attempt = 1; ; attempt++) {
    const snapshot = readFileIfExists(path);
    const state = parseOpenWeightAllowance(snapshot, path, utcDay, requireFleetCap);

    const { next, result } = mutate(state);
    // TEST-ONLY seam, in the shape {@link import("./fs-race-safe.js").reclaimStaleLock}'s own
    // `beforeDelete` already uses: a test runs a PEER's entire reservation here, inside this
    // attempt's read-to-rename window, so the compare-and-swap below is exercised deterministically
    // rather than by hoping two real processes happen to interleave.
    beforeCommit?.();
    const committed = writeAtomic(path, `${JSON.stringify(next)}\n`, {
      // The stage replaces the inode on every reservation and settlement. Preserve the private
      // allowance mode across those renames instead of letting the process umask create 0644.
      mode: 0o600,
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
  const configuredCapUsd = configuredCashCap(config, input.squeezed);
  const utcDay = openWeightUtcDay(input.atIso);
  const wantUsd = openWeightReservationUsd(input.deployment, input.requestBodyBytes, input.extraInputTokens ?? 0);
  return mutateOpenWeightAllowance(openWeightAllowancePath(config), utcDay, (state) => {
    const limits = cashAllowanceLimits(state, configuredCapUsd, input.deployment, input.squeezed);
    const { capUsd, committedUsd } = limits[0]!;
    if (Object.hasOwn(state.reservations, input.requestId)) {
      throw new Error(`cash allowance request identity already reserved: ${input.requestId}`);
    }
    for (const limit of limits) {
      if (limit.committedUsd + wantUsd > limit.capUsd)
        throw new OpenWeightAllowanceExhaustedError({ ...limit, wantUsd, utcDay, squeezed: input.squeezed === true });
    }
    return {
      next: { ...state, reservations: { ...state.reservations, [input.requestId]: { reservedUsd: wantUsd, settledUsd: null, deployment: input.deployment } } },
      result: { reservedUsd: wantUsd, committedUsd: committedUsd + wantUsd, capUsd },
    };
  }, input.beforeCommit, sharedCashAllowancePath(config) !== undefined);
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
  }, undefined, sharedCashAllowancePath(config) !== undefined);
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
  signal?: AbortSignal;
  streamObserver?: CodexSpawnArgs["streamObserver"];
  /** The request deadline, defaulting to {@link OPENWEIGHT_REQUEST_TIMEOUT_MS}. A seam ONLY so a
   *  test can reach the aborted arm of the catch below: with the real 180s bound, covering it means
   *  a test that waits three minutes, and an uncovered catch arm is how a refusal quietly stops
   *  refusing. Production passes nothing and gets the constant. */
  requestTimeoutMs?: number;
  /** Test-only override; production reads the daemon process environment. */
  env?: NodeJS.ProcessEnv;
  /** Caller-supplied check-child extras, never the daemon credential environment (W1-T10024). */
  workerEnv?: Record<string, string>;
  /** Test-only check port for hosts without bubblewrap; production runs fixed argv in fresh user/network namespaces. */
  runCheck?: (input: OpenWeightCheckInput) => string | Promise<string>;
  /** Test-only clock port; production records duration from the system clock. `iso` rides beside
   *  `now` because the daily allowance keys on a UTC calendar day, which is read off the ISO
   *  instant rather than re-derived from milliseconds. */
  clock?: Pick<Clock, "now" | "iso">;
  /**
   * W1-T3880: when this spawn is USING a capability grant rather than a credential this lane
   * already holds by default, the caller passes the grant store and the structured (never
   * content-derived) use request here. Verified BEFORE `env`/the API key are even read below —
   * "the last responsible moment" this file's own boundary can enforce. Absent for every existing
   * caller, which is unaffected: no store, no verification, no change in behaviour.
   */
  capabilityGrant?: { store: CapabilityGrantStore; request: CapabilityUseRequest };
  /** Reconcile a bounded provider action against connector truth before returning the worker result. */
  externalEffect?: {
    request: ExternalEffectRequest;
    onReconciled?: (result: ExternalEffectResult) => void | Promise<void>;
  };
}

/**
 * W1-T3880: thrown by {@link spawnOpenWeightWorker} when a caller-supplied `capabilityGrant` use
 * request fails {@link verifyCapabilityGrant} — expired, revoked, replayed, wrong-audience, or an
 * operation outside the grant's own allowlist. `kind: "usage"` follows this file's own convention
 * for a request refused before anything is spawned (see `OpenWeightRequestTooLargeError` above),
 * so the process boundary's exit-code lookup needs no new case.
 */
export class CapabilityGrantRefusedError extends RmdError {
  readonly code: string;
  constructor(reason: string, code: string, grantId: string) {
    super("usage", 1, `capability grant ${grantId} refused: ${reason}`, { grantId, code });
    this.code = code;
  }
}

export interface OpenWeightWorkerResult {
  // W1-T3607: the canonical runtime provider id — "cash", never the deprecated "openweight" config
  // spelling. No out-of-scope caller asserts this literal value (only import symbol names, which stay
  // unchanged; see this task's PR body for the deliberate scoping).
  provider: "cash";
  /** W1-T4079: the deployment this attempt found absent (HTTP 404). */
  openWeightDeploymentAbsent?: string;
  openWeightCapacityShortfall?: CapacityShortfall;
  sessionId: string;
  costUsd: number;
  numTurns: number;
  maxTurns?: number;
  text: string;
  blocks: string[];
  stderr: string;
  subtype: string;
  isError: boolean;
  /** W1-T6027: always `unobserved` — an HTTP runner has no process whose end it could see. */
  exit: WorkerExit;
  apiError: boolean;
  permissionDenials: unknown[];
  /** This adapter runs in the daemon, not a child worker process. The Azure key is absent. */
  childEnvKeys: string[];
  model: string;
  routedModel?: string;
  effort: string;
  /** Counts of actual adapter fetch invocations by observed parameter, including failures. */
  requestEfforts: readonly CashRequestEffortCount[];
  selectionAssignmentId?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  modelUsage: Record<string, never>;
  /** W1-T4650: the model the provider's own responses named (see {@link cashServedModel}), or
   *  `null` beside a named {@link servedModelReason}. Never the requested deployment echoed back. */
  servedModel?: string | null;
  servedModelReason?: string;
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
  cashAllowanceResetAt?: string;
  /** W1-T10384: the limit that refused, when `budgetRefused`. */
  cashAllowanceLimit?: CashAllowanceLimitName;
  externalEffect?: ExternalEffectResult;
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
  RunCheck: { name: "run_check", description: "Run ONE permitted repository check by name (unit_test, typecheck). Fixed argv: it takes no paths or flags; unit_test runs only the suites the harness selects from your diff, and refuses a selection too broad to run here. No shell; no network.", required: ["check"] },
};

/** The `--import` chain package.json's `test`/`test:ci` scripts load before any suite: tsx, then
 *  test/setup/tmp-hygiene.ts, which installs the temp-dir reaper and the no-live-remote guards. A
 *  `node --test` without it runs every fixture unguarded. The path is relative to the check's cwd,
 *  the worktree root (`--chdir cwd`). Parity with package.json is enforced by test.
 *  {@link openWeightCheckArgv} drops the setup import in a tree that has no such file. */
export const TEST_SETUP_IMPORT = "./test/setup/tmp-hygiene.ts";
export const TEST_PROCESS_GUARD_IMPORTS: readonly string[] = ["--import", "tsx", "--import", TEST_SETUP_IMPORT];

/** Checks an open-weight worker may run, as fixed argv — never a command string (W1-T3617).
 *  NOTHING HERE MAY REACH THE NETWORK OR THE FORGE (no git/gh/curl/install): the worker produces a
 *  diff and the ORCHESTRATOR pushes, the boundary hooks/deny-floor.sh already enforces. */
export const OPENWEIGHT_CHECKS: Readonly<Record<string, readonly string[]>> = {
  unit_test: ["node", ...TEST_PROCESS_GUARD_IMPORTS, "--test", "--test-reporter=tap"],
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

/** The Linux-only runner that gives a fixed check a new user and network namespace. */
export const OPENWEIGHT_CHECK_SANDBOX = "bwrap";

export interface OpenWeightCheckInput {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  workerHome: string;
  /** Test-only platform port. Production leaves this absent and uses the host platform. */
  platform?: NodeJS.Platform;
}

/**
 * Environment for a fixed-argv cash check.  The Azure key is deliberately read by the daemon
 * before the tool loop, but a model-selected check must never inherit it (or any other daemon
 * credential) merely because the adapter itself runs in this process.  `HOME` and `TMPDIR` are
 * private per-worker paths, so a check cannot rediscover operator shell state through either.
 *
 * This is intentionally narrower than the Claude/Codex worker environments: the check table has
 * no forge, shell, or network command, and it needs only executable discovery plus locale.  Add a
 * variable here only with a demonstrated fixed-check need; copying `process.env` would turn the
 * adapter boundary into a claim rather than a control.
 */
export function openWeightCheckEnv(workerHome: string, env: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {}): Record<string, string> {
  for (const key of Object.keys(extra)) {
    // W1-T10837: widened to `RMD_CASH_.*_API_KEY$` so a MAPPED deployment's own key (and the
    // existing shared `CASH_WEB_SEARCH_KEY_ENV`, the same shape) trips this boundary exactly like
    // the default `RMD_OPENWEIGHT_API_KEY` always has -- design (iv) names the worker environment
    // as one of the four places a cash key value must never reach.
    if (/^(ANTHROPIC_|RMD_OPENWEIGHT_API_KEY$|RMD_FOUNDRY_CLAUDE_API_KEY$|RMD_CASH_[A-Z0-9_]*API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$|GH_TOKEN$)/i.test(key)) {
      throw new Error(`openWeightCheckEnv: credential/billing-boundary violation: ${key}`);
    }
  }
  const tmp = join(workerHome, "tmp");
  mkdirSync(tmp, { recursive: true });
  const out: Record<string, string> = {
    HOME: workerHome,
    TMPDIR: tmp,
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of ["LANG", "LC_ALL"] as const) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  Object.assign(out, extra, { HOME: workerHome, TMPDIR: tmp });
  return out;
}

/**
 * Bubblewrap arguments for a model-selected fixed check. The worktree and isolated worker home
 * are the only application mounts; the host root is NOT mounted at all. A small read-only runtime
 * plus a new network namespace denies both host-secret reads and routes to the daemon, forge, or
 * public network. `argv` is already an internal table entry — never model-supplied text.
 */
export function openWeightCheckSandboxArgv(
  input: Pick<OpenWeightCheckInput, "argv" | "cwd" | "workerHome"> & { platform?: NodeJS.Platform },
): string[] {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error("cash RunCheck requires Linux bubblewrap; refusing an unsandboxed local check");
  }
  const cwd = realpathSync(input.cwd);
  const workerHome = realpathSync(input.workerHome);
  if (cwd === "/" || workerHome === "/") throw new Error("cash RunCheck refuses / as a writable sandbox bind");
  const runtimeRoots = ["/usr", "/lib", "/lib64", "/bin", "/usr/local"].filter(existsSync);
  const dirs = new Set<string>();
  for (const path of [cwd, workerHome]) {
    let current = path;
    while (current !== "/") {
      dirs.add(current);
      current = dirname(current);
    }
  }
  const createDirs = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length);
  return [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-net",
    ...runtimeRoots.flatMap((path) => ["--ro-bind", path, path]),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...createDirs.flatMap((path) => ["--dir", path]),
    "--bind", cwd, cwd,
    ...(workerHome === cwd ? [] : ["--bind", workerHome, workerHome]),
    "--chdir", cwd,
    "--",
    ...input.argv,
  ];
}

/** The only production route for `RunCheck`: no fallback can execute an unchecked process. */

interface CheckJudge {
  inlineJudgedArgs(): string[];
  judgedNodeTestArgs(args: readonly string[], judgedArgs: readonly string[]): string[];
  splitInlineTally(stdout: string): { output: string; tallyText: string };
  testFilesInArgv(args: readonly string[], cwd: string): string[];
  judgeRun(files: readonly string[], opts: { status: number; pool: boolean; root: string; tallyText: string }): { complete: boolean; status: number };
  describeJudgedRun(role: string, verdict: { complete: boolean }, opts: { prefix: string }): string;
}
// The judge comes from the ORCHESTRATOR's checkout (this module's), never the worktree the check runs in.
const loadCheckJudge = (): CheckJudge => createRequire(import.meta.url)("../../scripts/pure-test-pool.mjs") as CheckJudge;

/** W1-T8380: a `node --test` check whose exit 0 left a file short of its own summary (a real `process.exit(0)`) is thrown
 *  as a red run: nonzero `status`, the judge's line in its output. The sandboxed child sees only the worktree, so the
 *  judge's tally reporter rides the argv as a `data:` URL and its stdout line is taken back off. */
export async function runOpenWeightCheck(input: OpenWeightCheckInput): Promise<string> {
  const judge = input.argv.includes("--test") ? loadCheckJudge() : undefined;
  const argv = judge ? judge.judgedNodeTestArgs(input.argv, judge.inlineJudgedArgs()) : input.argv;
  const cwd = realpathSync(input.cwd);
  let stdout: string;
  try {
    ({ stdout } = await execFileLoopBounded(OPENWEIGHT_CHECK_SANDBOX, openWeightCheckSandboxArgv({ ...input, argv }), {
      cwd,
      env: input.env,
      encoding: "utf8",
      timeout: OPENWEIGHT_CHECK_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (err) {
    const e = err as { stdout?: unknown };
    if (judge && typeof e.stdout === "string") e.stdout = judge.splitInlineTally(e.stdout).output;
    throw err;
  }
  if (!judge) return stdout;
  const { output, tallyText } = judge.splitInlineTally(stdout);
  const verdict = judge.judgeRun(judge.testFilesInArgv(input.argv, cwd), { status: 0, pool: false, root: cwd, tallyText });
  if (verdict.complete) return output;
  const line = judge.describeJudgedRun("unit_test", verdict, { prefix: "test-judge" });
  throw Object.assign(new Error(line), { status: verdict.status, stdout: `${output}\n${line}\n`, stderr: "" });
}

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
 * THE COST, STATED: a lane cannot scope `unit_test` to one file. In a tree carrying the selector
 * (W1-T6091) the HARNESS scopes it instead — {@link openWeightUnitTestPlan} appends the suites
 * {@link selectOpenWeightUnitTestSuites} derives from git, never from the model. Consumer trees
 * use changed tests and source basename matches instead. This argv is only the prefix;
 * {@link openWeightUnitTestPlan} must append an explicit suite list before it runs. */
export function openWeightCheckArgv(check: unknown, paths: unknown, cwd?: string): string[] {
  if (typeof check !== "string" || !Object.prototype.hasOwnProperty.call(OPENWEIGHT_CHECKS, check)) {
    throw new OpenWeightUnlistedCheckError(typeof check === "string" ? check : String(check));
  }
  // REFUSED, NOT IGNORED. A model told its scoped check ran, when the whole suite ran instead,
  // would read the wrong result off a green — so an unusable argument is an error, never a no-op.
  if (paths !== undefined) {
    throw new OpenWeightUnlistedCheckError(`${check} with caller arguments — every check runs a FIXED argv`);
  }
  const argv = [...OPENWEIGHT_CHECKS[check]];
  // A CONSUMER REPO HAS NO SETUP FILE. Loading a missing `--import` fails before any test runs, so
  // a tree without it runs exactly what main ran: tsx alone. Remudero's own tree always has it.
  const at = argv.indexOf(TEST_SETUP_IMPORT);
  if (cwd !== undefined && at > 0 && !existsSync(join(cwd, TEST_SETUP_IMPORT))) argv.splice(at - 1, 2);
  return argv;
}

/** The typecheck runs incremental against a buildinfo in the worker's private home — the sandbox's one writable bind
 *  besides the worktree, so it is never part of the diff — seeded from the canonical checkout's on first use. Same
 *  diagnostics as a cold check at about half its peak memory (lib/typecheck-buildinfo.ts). Harness-built: the model
 *  still supplies no argument. */
export function openWeightIncrementalTypecheck(argv: readonly string[], cwd: string, workerHome: string): string[] {
  const buildInfo = join(workerHome, TYPECHECK_BUILDINFO_NAME);
  seedFromCanonical(cwd, buildInfo);
  return [...argv, "--incremental", "--tsBuildInfoFile", buildInfo];
}

// ── W1-T6091: THE unit_test CHECK RUNS THE DIFF'S AFFECTED SUITES ────────────────────────────
// MEASURED 2026-10-06: the whole suite is ~21 min against OPENWEIGHT_CHECK_TIMEOUT_MS's 10, so a
// whole-tree unit_test always timed out, at ~70 core-minutes a call, and left no ledger row.

/** A tree with this marker uses the affected-suites model; consumers use the basename rule. */
export const OPENWEIGHT_UNIT_TEST_SELECTOR_MARKER = "scripts/diff-class.mjs";
/** PRIMARY CONTROL: above this many selected suites the check refuses rather than run. At the
 *  cap below, forty suites is the most that plausibly finishes inside OPENWEIGHT_CHECK_TIMEOUT_MS. */
export const OPENWEIGHT_UNIT_TEST_MAX_SUITES = 40;
/** `--test-concurrency` for a harness-scoped run: node's default is cores-1, which on the fleet
 *  host is 7 suites at once per lane, each spawning git and tsx. W1-T6090's testRunConcurrency
 *  replaces this constant when it lands. */
export const OPENWEIGHT_UNIT_TEST_CONCURRENCY = 2;
/** Prefix that runs a scoped check below the daemon's own priority. */
export const OPENWEIGHT_UNIT_TEST_NICE: readonly string[] = ["nice", "-n", "10"];
/** BACKSTOP on computing the selection itself (git reads plus the census listings): it fires
 *  only when a listing hangs, and the overrun is a refusal naming it. */
export const OPENWEIGHT_UNIT_TEST_SELECTION_TIMEOUT_MS = 2 * 60_000;
/** One row per run_check call, any check. Deliberately NOT in DECISION_RELEVANT_LEDGER_STEPS
 *  (lib/ledger.ts): nothing decides on it; it prices the check, so rotation may archive it. */
export const OPENWEIGHT_RUN_CHECK_LEDGER_STEP = "cash.run_check";
/** The prefix every refusal of a too-broad selection carries, so a lane reads one sentence. */
export const OPENWEIGHT_UNIT_TEST_TOO_BROAD = "selection too broad for an open-weight check — run in CI";

const UNIT_TEST_SUITE = /^test\/[^\0\n]*\.test\.ts$/;
const CONSUMER_UNIT_TEST_SUITE = /(?:^|\/)[^/\0\n]+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const CONSUMER_UNIT_TEST_SCOPE_RULE = "consumer: changed tests + changed source basenames";
/** This module's own checkout: the selector's helper scripts run from HERE, never from the
 *  worktree, whose files the model writes and which therefore run only inside the sandbox. */
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fullSelection(reason: string): AffectedSelection {
  return { suites: [], fullRun: true, reasons: [`full run: ${reason}`], recentOnly: { floor: [] } };
}

/**
 * The suites a worktree's diff against its merge base with origin/main affects, by the same
 * selector `preflight-author.mjs`'s authorSelection uses: the NARROW arm (changed tests, suites
 * naming a changed symbol or its src/ caller, path readers and namers) when every changed source
 * file names a symbol, else the floor. Every input is read from git and from files as DATA;
 * the census listings come from {@link HARNESS_ROOT}'s diff-class.mjs pointed at the worktree,
 * since the worktree's own copy is model-writable code this process must not execute.
 * Anything unreadable is a FULL selection naming why — never a narrower guess.
 */
export function selectOpenWeightUnitTestSuites(cwd: string, spawn: PreflightSpawn = (file, args, opts) => {
  if (file !== "git") return defaultPreflightSpawn(file, args, opts);
  try {
    const stdout = hostWorktreeGit(opts?.cwd ?? cwd, args, {
      maxBuffer: 64 * 1024 * 1024, env: opts?.env, input: opts?.input,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    if (typeof result.status !== "number") throw error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}): AffectedSelection {
  const root = realpathSync(cwd);
  const run = (file: string, args: string[], at = root): string => {
    const r = spawn(file, args, { cwd: at });
    if (r.status !== 0) throw new Error(`${file} ${args.slice(0, 3).join(" ")} exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}`);
    return r.stdout;
  };
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const consumer = !existsSync(join(root, OPENWEIGHT_UNIT_TEST_SELECTOR_MARKER));
  let base: string;
  let changed: string[];
  let tracked: string[];
  try {
    base = run("git", ["merge-base", "origin/main", "HEAD"]).trim();
    const paths = consumer ? (text: string) => text.split("\0").filter(Boolean) : lines;
    const untracked = paths(run("git", ["ls-files", ...(consumer ? ["-z"] : []), "--others", "--exclude-standard"]));
    changed = [...new Set([
      ...paths(run("git", ["diff", "--name-only", ...(consumer ? ["-z", "--diff-filter=ACMRT"] : []), base])),
      ...untracked,
    ])].sort();
    tracked = paths(run("git", ["ls-files", ...(consumer ? ["-z"] : ["--", "src", "scripts", "bin", "test"])]));
    if (consumer) {
      const sourceNames = new Set(changed.filter((path) => !CONSUMER_UNIT_TEST_SUITE.test(path) && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path))
        .map((path) => basename(path).replace(/\.[^.]+$/, "")));
      const candidates = [...new Set([...tracked, ...untracked])];
      const suites = candidates.filter((path) => CONSUMER_UNIT_TEST_SUITE.test(path) && existsSync(join(root, path)) &&
        (changed.includes(path) || sourceNames.has(basename(path).replace(/\.(?:test|spec)\.[^.]+$/, "")))).sort();
      for (const suite of suites) openWeightContainedPath(root, suite);
      if (suites.length > 0 && existsSync(join(root, "package.json"))) {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: { test?: unknown } };
        if (pkg.scripts?.test !== undefined &&
          (typeof pkg.scripts.test !== "string" || !/\bnode\b[^\n]*\s--test(?:\s|$)/.test(pkg.scripts.test))) {
          return fullSelection("consumer unit_test requires node --test suites; the declared test runner is unsupported");
        }
      }
      return { suites: suites.map((path) => path.startsWith("-") ? `./${path}` : path),
        fullRun: false, reasons: [CONSUMER_UNIT_TEST_SCOPE_RULE], recentOnly: { floor: [] } };
    }
  } catch (err) {
    // No readable diff means no narrow answer: a FULL selection naming why, which then refuses.
    return fullSelection(`the worktree's diff could not be read — ${(err as Error).message}`);
  }
  return affectedSelectionOrFull(changed, (): AffectedSuitesInput => {
    const diff = run("git", ["diff", "-U0", base, "--", "src", "scripts", "bin"]);
    const readFile = (path: string) => readFileSync(join(root, path), "utf8");
    const symbolless = symbollessSourceFiles(changed, diff, readFile);
    const symbols = symbolless.length > 0 ? [] : changedSymbols(diff, readFile);
    const files = new Map<string, string>();
    for (const path of tracked) {
      if (!/\.(?:ts|mts|mjs|js|cjs)$/.test(path) || !existsSync(join(root, path))) continue;
      files.set(path, readFile(path));
    }
    const dir = makeTempDir("ow-unit-test");
    try {
      const list = join(dir, "changed.txt");
      writeFileSync(list, changed.join("\n") + "\n");
      const diffClass = join(HARNESS_ROOT, "scripts", "diff-class.mjs");
      const listing = (flag: string) =>
        lines(run(process.execPath, ["--import", "tsx", diffClass, flag, "--changed-files", list, "--plan-reading-root", root], HARNESS_ROOT));
      const prose = changed.some((f) => !/^(?:src|scripts|bin|test)\//.test(f));
      const pathReaders = [...listing("--list-census-suites"), ...(prose ? listing("--list-plan-reading-suites") : [])];
      return {
        files,
        pathReaders,
        ...(symbolless.length > 0 ? {} : { symbolSuites: symbols.length === 0 ? [] : callerReachableSuites(symbols, root, spawn).suites }),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** What one `unit_test` call does with a selection: run an explicit file list, run nothing, or
 *  refuse with the reason. A whole-tree run is never one of the outcomes. */
export type OpenWeightUnitTestPlan =
  | { kind: "run"; argv: string[]; suites: string[] }
  | { kind: "empty"; reasons: string[] }
  | { kind: "refused"; reason: string; suites: number };

/** `baseArgv` is the fixed prefix. Only present suites matching the tree's naming rule run. */
export function openWeightUnitTestPlan(
  selection: AffectedSelection, baseArgv: readonly string[], cwd: string,
  concurrency = OPENWEIGHT_UNIT_TEST_CONCURRENCY,
): OpenWeightUnitTestPlan {
  if (selection.fullRun) {
    return { kind: "refused", reason: `${OPENWEIGHT_UNIT_TEST_TOO_BROAD}: ${selection.reasons.join("; ")}`, suites: 0 };
  }
  const suitePattern = existsSync(join(cwd, OPENWEIGHT_UNIT_TEST_SELECTOR_MARKER)) ? UNIT_TEST_SUITE : CONSUMER_UNIT_TEST_SUITE;
  const suites = [...new Set(selection.narrow ?? selection.suites)]
    .filter((s) => suitePattern.test(s) && existsSync(join(cwd, s)))
    .sort();
  if (suites.length > OPENWEIGHT_UNIT_TEST_MAX_SUITES) {
    return {
      kind: "refused",
      reason: `${OPENWEIGHT_UNIT_TEST_TOO_BROAD}: ${suites.length} affected suites exceed the ${OPENWEIGHT_UNIT_TEST_MAX_SUITES}-suite bound`,
      suites: suites.length,
    };
  }
  if (suites.length === 0) return { kind: "empty", reasons: selection.reasons };
  const argv = [...OPENWEIGHT_UNIT_TEST_NICE, ...baseArgv, `--test-concurrency=${concurrency}`, ...suites];
  return { kind: "run", argv, suites };
}

/** {@link selectOpenWeightUnitTestSuites} in a child process, so its git reads and listings never
 *  block the daemon's event loop. It runs THIS checkout's code (cwd {@link HARNESS_ROOT}) with the
 *  check's credential-free env; a child that fails or overruns is a FULL selection naming why. */
export async function selectOpenWeightUnitTestSuitesOffLoop(cwd: string, env: Record<string, string>): Promise<AffectedSelection> {
  const code = "const m = await import(process.argv[1]);" +
    "process.stdout.write(JSON.stringify(m.selectOpenWeightUnitTestSuites(process.argv[2])));";
  try {
    const { stdout } = await execFileLoopBounded(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", code, import.meta.url, cwd],
      { cwd: HARNESS_ROOT, env, encoding: "utf8", timeout: OPENWEIGHT_UNIT_TEST_SELECTION_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as AffectedSelection;
  } catch (err) {
    // A failed or overrun selection is never an empty one: it is FULL, so the check refuses.
    const e = err as { killed?: boolean; message?: string };
    return fullSelection(e.killed === true
      ? `the selection overran ${OPENWEIGHT_UNIT_TEST_SELECTION_TIMEOUT_MS / 1000}s`
      : `the selection failed — ${String(e.message ?? err).slice(0, 300)}`);
  }
}

/** Where a run_check row goes, and whose run it belongs to. */
export interface OpenWeightRunCheckLedger {
  config: Config;
  runId?: string;
  taskId?: string;
  clock: Pick<Clock, "now" | "iso">;
}

function ledgerRunCheck(
  ledger: OpenWeightRunCheckLedger,
  row: { check: unknown; outcome: "ran" | "empty" | "refused"; suites: number | null; startedAt: number; exitCode?: number; timedOut?: boolean; reason?: string; scopeRule?: string },
): void {
  appendLedger(ledgerPathFor(ledger.config), {
    run_id: ledger.runId ?? "unattributed",
    task_id: ledger.taskId ?? "unattributed",
    step: OPENWEIGHT_RUN_CHECK_LEDGER_STEP,
    check: String(row.check),
    outcome: row.outcome,
    suites: row.suites,
    duration_ms: ledger.clock.now() - row.startedAt,
    exit_code: row.exitCode ?? null,
    timed_out: row.timedOut ?? false,
    ...(row.scopeRule !== undefined ? { scope_rule: row.scopeRule } : {}),
    ...(row.reason !== undefined ? { reason: row.reason.slice(0, 500) } : {}),
  });
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

/** W1-T6106: the open-weight write tools' path — contained like a read, and never the worktree's `.git`
 *  entry, which a host git call would otherwise follow. hooks/ stays writable: it is product source here, and
 *  the host never executes the worktree's copy. */
export function openWeightWritablePath(cwd: string, candidate: unknown): string {
  const target = openWeightContainedPath(cwd, candidate);
  const root = realpathSync(cwd);
  let existing = target;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  for (const rel of [relative(root, target), relative(root, realpathSync(existing))]) {
    if (rel.split(sep)[0]!.toLowerCase() === ".git") throw new Error("tool path names the worktree's .git entry, which only the harness writes");
  }
  return target;
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

async function executeOpenWeightTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  checkEnv: Record<string, string>,
  workerHome: string,
  runCheck: ((input: OpenWeightCheckInput) => string | Promise<string>) | undefined,
  ledger: OpenWeightRunCheckLedger,
): Promise<unknown> {
  switch (name) {
    case "read_file":
      return { content: readFileSync(openWeightContainedPath(cwd, args.path), "utf8") };
    case "write_file": {
      if (typeof args.content !== "string") throw new Error("write_file content must be a string");
      const path = openWeightWritablePath(cwd, args.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.content, "utf8");
      return { written: relative(realpathSync(cwd), path) };
    }
    case "edit_file": {
      if (typeof args.old_string !== "string" || typeof args.new_string !== "string") throw new Error("edit_file strings must be strings");
      const path = openWeightWritablePath(cwd, args.path);
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
      // takes an array and never a shell, while runOpenWeightCheck puts even repository code in a
      // fresh network namespace before it runs.
      const startedAt = ledger.clock.now();
      let argv = openWeightCheckArgv(args.check, args.paths, cwd);
      if (args.check === "typecheck") argv = openWeightIncrementalTypecheck(argv, cwd, workerHome);
      // Every unit_test runs a harness-derived file list, or nothing, or refuses.
      let suites: number | null = null;
      let scopeRule: string | undefined;
      if (args.check === "unit_test") {
        scopeRule = existsSync(join(cwd, OPENWEIGHT_UNIT_TEST_SELECTOR_MARKER))
          ? "harness: affected suites" : CONSUMER_UNIT_TEST_SCOPE_RULE;
        const load = readHostLoad();
        const concurrency = scopeRule === CONSUMER_UNIT_TEST_SCOPE_RULE
          ? testRunConcurrency(load, defaultTestSlots(load.cores)) : OPENWEIGHT_UNIT_TEST_CONCURRENCY;
        const plan = openWeightUnitTestPlan(await selectOpenWeightUnitTestSuitesOffLoop(cwd, checkEnv), argv, cwd, concurrency);
        if (plan.kind === "refused") {
          ledgerRunCheck(ledger, { check: args.check, outcome: "refused", suites: plan.suites, startedAt, reason: plan.reason, scopeRule });
          return { check: args.check, ran: false, suites: plan.suites, refused: plan.reason };
        }
        if (plan.kind === "empty") {
          const output = `no suite is affected by this worktree's diff; nothing ran (${plan.reasons.join("; ") || "no changed file reaches a suite"})`;
          ledgerRunCheck(ledger, { check: args.check, outcome: "empty", suites: 0, startedAt, reason: plan.reasons.join("; "), scopeRule });
          return { check: args.check, ran: false, suites: 0, output };
        }
        argv = plan.argv;
        suites = plan.suites.length;
      }
      const scoped = suites === null ? {} : { suites };
      const slot = args.check === "typecheck" &&
        !hasUsableTypecheckBuildInfo(join(workerHome, TYPECHECK_BUILDINFO_NAME), installedTypescriptVersion(cwd))
        ? await acquireTestSlotAsync("typecheck:bwrap", { memoryBytes: TYPECHECK_COLD_PEAK_BYTES }) : undefined;
      if (slot && !testSlotExecutionAllowed(slot)) {
        slot.release();
        ledgerRunCheck(ledger, { check: args.check, outcome: "refused", suites, startedAt, reason: slot.note, scopeRule });
        return { check: args.check, ran: false, refused: `NOT_RUN (${slot.note})` };
      }
      if (args.check === "typecheck") argv = [...argv, ...lowMemoryTypecheckArgs(readMemoryHeadroom(), slot ? TYPECHECK_COLD_PEAK_BYTES : TYPECHECK_WARM_PEAK_BYTES)];
      try {
        const stdout = await (runCheck ?? runOpenWeightCheck)({
          argv,
          cwd: realpathSync(cwd),
          workerHome,
          env: args.check === "typecheck" ? typecheckEnv(checkEnv) : checkEnv,
        });
        ledgerRunCheck(ledger, { check: args.check, outcome: "ran", suites, startedAt, exitCode: 0, scopeRule });
        return { check: args.check, exitCode: 0, output: stdout.slice(-20_000), ...scoped };
      } catch (err) {
        // A FAILING CHECK IS A RESULT, NOT AN ERROR — the lane must read its own red. A refusal above
        // still throws, because that is not a result.
        const e = err as { status?: number; code?: number | string; killed?: boolean; stdout?: string | Buffer; stderr?: string | Buffer };
        const out = `${String(e.stdout ?? "")}${String(e.stderr ?? "")}`;
        const exitCode = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : 1;
        ledgerRunCheck(ledger, { check: args.check, outcome: "ran", suites, startedAt, exitCode, timedOut: e.killed === true, scopeRule });
        return { check: args.check, exitCode, output: out.slice(-20_000), ...scoped };
      } finally {
        slot?.release();
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
 * Verify the boundary a cash worker actually receives, without asking a model to simulate a
 * shell it is never offered.  This is the cash counterpart to the subscription containment probe:
 * an outside-cwd write must be rejected by the same resolver `write_file` uses, while every
 * runnable command remains an internally-declared, shell-less, non-network argv.
 *
 * The check is deliberately executable at run time.  A CI-only census would not protect a daemon
 * that is running a mounted checkout whose capability table has drifted from the image.
 */
export function assertOpenWeightToolBoundary(
  cwd: string,
  deps: {
    platform?: NodeJS.Platform;
    runSandbox?: (argv: readonly string[]) => void;
    /** Test seam for the real bubblewrap invocation. Production defaults to execFileSync. */
    execFile?: typeof execFileSync;
    /** Test seam for the resolver that every cash file tool uses in production. */
    resolveContainedPath?: typeof openWeightContainedPath;
  } = {},
): string {
  const root = realpathSync(cwd);
  const resolveContainedPath = deps.resolveContainedPath ?? openWeightContainedPath;
  const allowed = resolveContainedPath(root, "cash-boundary-probe.txt");
  const allowedRelative = relative(root, allowed);
  if (allowedRelative === ".." || allowedRelative.startsWith(`..${sep}`) || isAbsolute(allowedRelative)) {
    throw new Error("cash containment probe resolved an inside-cwd path outside the worker root");
  }

  let outsideWriteRefused = false;
  try {
    resolveContainedPath(root, "../cash-boundary-probe.txt");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "tool path escapes the worker cwd") throw error;
    outsideWriteRefused = true;
  }
  if (!outsideWriteRefused) {
    throw new Error("cash containment probe could not prove outside-cwd writes are refused");
  }

  if (OPENWEIGHT_FUNCTIONS.Bash !== undefined) {
    throw new Error("cash containment probe found a shell capability");
  }
  const forbidden = new Set(["gh", "curl", "wget", "ssh", "scp", "npm", "npx", "pnpm", "yarn", "pip", "docker", "nc", "sh", "bash", "zsh", "env", "eval"]);
  const checks = Object.entries(OPENWEIGHT_CHECKS);
  if (checks.length === 0) throw new Error("cash containment probe found no fixed check table");
  for (const [name, argv] of checks) {
    const command = argv[0]?.split("/").at(-1);
    if (!command || forbidden.has(command)) {
      throw new Error(`cash containment probe found unsafe fixed check '${name}'`);
    }
    if (command === "git" && !OPENWEIGHT_READONLY_GIT_SUBCOMMANDS.includes(argv[1] ?? "")) {
      throw new Error(`cash containment probe found non-read-only git check '${name}'`);
    }
    if (argv.some((part) => /:\/\/|^https?:|^git@|[;&|`$><]/.test(part))) {
      throw new Error(`cash containment probe found network or shell syntax in check '${name}'`);
    }
  }
  const sandboxArgs = openWeightCheckSandboxArgv({
    argv: ["/bin/true"],
    cwd: root,
    workerHome: root,
    platform: deps.platform,
  });
  (deps.runSandbox ?? ((argv) => {
    (deps.execFile ?? execFileSync)(OPENWEIGHT_CHECK_SANDBOX, argv, {
      cwd: root,
      env: openWeightCheckEnv(root),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }))(sandboxArgs);
  return "cash adapter boundary proved: outside-cwd writes refused; fixed checks require a fresh network namespace";
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
  // W1-T10837: resolves THIS deployment's own endpoint when `workerProviders.cashDeploymentEndpoints`
  // names it, else W1-T3607's canonical `cashEndpoint` falling back to the deprecated
  // `openweightEndpoint` spelling -- so an already-deployed host's config.json with no map need not
  // be hand-edited the moment this ships.
  const raw = cashDeploymentEndpoint(config, model);
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("cash provider requires workerProviders.cashEndpoint");
  const endpoint = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  if (endpoint.protocol !== "https:") throw new Error("cash endpoint must use https");
  if (CASH_RESPONSES_DEPLOYMENTS[model]) return new URL("openai/v1/responses", endpoint).toString();
  return new URL(`openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-10-21`, endpoint).toString();
}

/** W1-T4650: the named reasons a cash attempt reports no served model. */
export const CASH_SERVED_MODEL_REASONS = {
  noResponse: "no cash response was received, so none named the model that served it",
  unnamed: "a cash response named no model id",
  mixed: "cash responses in this attempt named different models",
} as const;

/** The model id ONE cash response names in its `model` field, or `undefined`. Both endpoint
 *  shapes (Azure chat completions, Foundry Anthropic messages) carry it there. A non-id — blank,
 *  over-long, or a placeholder such as `<synthetic>` — is not a claim about what served the call. */
export function cashResponseModel(model: unknown): string | undefined {
  return typeof model === "string" && SAFE_OPENWEIGHT_MODEL_ID.test(model) ? model : undefined;
}

/**
 * W1-T4650: THE SERVED MODEL OF A WHOLE CASH ATTEMPT, from what each response named, in order.
 *
 * A tool loop sends one paid request per turn, so one attempt can hold several responses. The
 * attempt reports a model ONLY when every response received named one and all named the SAME one;
 * a missing name or a disagreement is a named reason, never a pick of first or last, because an
 * attempt served by two models has no single served model to compare arms on. The requested
 * deployment is never a fallback: echoing the ask is the guess W1-T2572 refuses.
 */
export function cashServedModel(named: readonly (string | undefined)[]): { servedModel: string | null; servedModelReason?: string } {
  if (named.length === 0) return { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.noResponse };
  if (named.some((model) => model === undefined)) return { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.unnamed };
  const distinct = [...new Set(named)].sort();
  if (distinct.length > 1) {
    return { servedModel: null, servedModelReason: `${CASH_SERVED_MODEL_REASONS.mixed}: ${distinct.join(", ")}` };
  }
  return { servedModel: distinct[0]! };
}

function openWeightResult(input: {
  model: string;
  effort: string;
  requestEfforts: readonly CashRequestEffortCount[];
  /** W1-T4650: {@link cashResponseModel} of every response received, in order. */
  servedModels: readonly (string | undefined)[];
  startedAt: number;
  clock: Pick<Clock, "now" | "iso">;
  text?: string;
  sessionId?: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  actualCostUsd?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  error?: unknown;
  budgetReservedUsd?: number;
  budgetSettledUsd?: number;
  budgetRefused?: boolean;
  /** W1-T4079: the deployment this attempt found absent (HTTP 404). */
  deploymentAbsent?: string;
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
    costUsd: input.actualCostUsd ?? (
      (input.promptTokens === 0 && input.completionTokens === 0
        ? 0
        : openWeightUsageUsd(input.model, input.promptTokens, input.completionTokens)) +
      // Brokered searches are billed on a DIFFERENT API than the conversation, so their tokens are
      // not in `promptTokens`/`completionTokens` and pricing those alone would understate the run.
      (input.webSearchUsd ?? 0)),
    numTurns: input.turns,
    maxTurns: undefined,
    text,
    blocks: text ? [text] : [],
    stderr: error ?? "",
    subtype: input.budgetRefused ? "cash_allowance_exhausted" : error ? "openweight_error" : "success",
    isError: error !== undefined,
    exit: { kind: "unobserved" },
    apiError: error !== undefined && !input.budgetRefused,
    permissionDenials: [],
    childEnvKeys: [],
    model: input.model,
    effort: input.effort,
    requestEfforts: [...input.requestEfforts],
    tokens: { input: input.promptTokens, output: input.completionTokens, cacheRead: input.cacheReadTokens ?? 0, cacheCreation: input.cacheCreationTokens ?? 0 },
    modelUsage: {},
    ...cashServedModel(input.servedModels),
    compactionEvents: [],
    compactionFailures: [],
    compactionConfigured: false,
    qualitySuspect: false,
    workerDurationMs: input.clock.now() - input.startedAt,
    budgetReservedUsd: input.budgetReservedUsd ?? 0,
    budgetSettledUsd: input.budgetSettledUsd ?? 0,
    budgetRefused: input.budgetRefused ?? false,
    ...(input.error instanceof OpenWeightAllowanceExhaustedError ? { cashAllowanceResetAt: input.error.resetAt, cashAllowanceLimit: input.error.limit } : {}),
    ...(input.deploymentAbsent ? { openWeightDeploymentAbsent: input.deploymentAbsent } : {}),
    ...(input.error instanceof CashCapacityShortfallFailure ? { openWeightCapacityShortfall: {
      reason: "capacity_shortfall" as const, deployment: input.model,
      estimatedTokens: input.error.estimatedTokens, limitTokens: input.error.limitTokens!,
    } } : {}),
    webSearchAttempted: input.webSearchAttempted ?? 0,
    webSearchAccepted: input.webSearchAccepted ?? 0,
    webSearchRefused: input.webSearchRefused ?? 0,
    webSearchUsd: input.webSearchUsd ?? 0,
  };
}

function foundryClaudeEndpoint(env: NodeJS.ProcessEnv, label: string): string {
  const raw = env[FOUNDRY_CLAUDE_ENDPOINT_ENV];
  if (!raw) throw new Error(`cash ${label} requires ${FOUNDRY_CLAUDE_ENDPOINT_ENV}`);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "/anthropic" || url.search || url.hash) {
    throw new Error(`cash ${label} requires an HTTPS Foundry /anthropic base endpoint`);
  }
  return new URL("v1/messages", `${url.toString().replace(/\/$/, "")}/`).toString();
}

/** Published cache-read USD per million for legacy flat-rate Foundry Claude deployments. */
const FOUNDRY_CLAUDE_CACHE_READ_USD_PER_MILLION: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 0.2,
  "claude-sonnet-5-5": 0.1,
};

function foundryClaudeUsageUsd(deployment: string, usage: {
  input_tokens: number; output_tokens: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}): number {
  const price = openWeightPriceFor(deployment);
  const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const rate = price.longContext && inputTokens > price.longContext.thresholdInputTokens ? price.longContext : price;
  // Price cache writes at the dearer 1h rate so a later cache_control cannot undercount.
  return (usage.input_tokens * rate.inputUsdPerMillion +
    (usage.cache_read_input_tokens ?? 0) * (rate.cachedInputUsdPerMillion ?? FOUNDRY_CLAUDE_CACHE_READ_USD_PER_MILLION[deployment] ?? rate.inputUsdPerMillion) +
    (usage.cache_creation_input_tokens ?? 0) * (rate.reservationInputUsdPerMillion ?? rate.inputUsdPerMillion) +
    usage.output_tokens * rate.outputUsdPerMillion) / 1_000_000;
}

function validFoundryTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function spawnFoundryClaudeWorker(
  args: OpenWeightSpawnArgs,
  config: Config,
  selection: Pick<OpenWeightModelSelection, "model" | "effort">,
): Promise<OpenWeightWorkerResult> {
  const label = selection.model === "claude-haiku-5-5" ? "Haiku" : selection.model === "claude-sonnet-5-5" ? "Sonnet" : "Opus";
  const toolLineage = createWorkerToolLineage({ provider: "cash-claude", root: config.root, runId: args.runId, taskId: args.taskId });
  let lineageEnd: "stream-ended" | "interrupted" = "interrupted";
  const clock = args.clock ?? systemClock;
  const startedAt = clock.now();
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let spentUsd = 0;
  let budgetReservedUsd = 0;
  let budgetSettledUsd = 0;
  let text = "";
  let sessionId = "";
  const servedModels: Array<string | undefined> = [];
  const requestEfforts: CashRequestEffortCount[] = [];
  let pending: { requestId: string; reservedUsd: number } | undefined;
  const requestPrefix = `${args.runId ?? args.taskId ?? "foundry-claude"}-${startedAt}-${randomUUID()}`;
  try {
    if (!isFoundryClaudeDeployment(selection.model) || (selection.model !== "claude-haiku-5-5" && args.cashSqueezed !== true)) {
      throw new Error(`cash ${label} requires an actual blocked-subscription squeeze`);
    }
    if (args.capabilityGrant) {
      const verification = verifyCapabilityGrant(args.capabilityGrant.store, args.capabilityGrant.request);
      if (!verification.ok) throw new CapabilityGrantRefusedError(verification.reason, verification.code, args.capabilityGrant.request.grantId);
    }
    if (args.responseFormat !== undefined) throw new Error(`cash ${label} structured output is not declared by the Foundry adapter`);
    const env = args.env ?? process.env;
    const key = env[FOUNDRY_CLAUDE_API_KEY_ENV];
    if (!key) throw new Error(`cash ${label} requires ${FOUNDRY_CLAUDE_API_KEY_ENV}`);
    const endpoint = foundryClaudeEndpoint(env, label);
    const tools = openWeightTools(args.tools, false).map((row) => {
      const fn = row.function as { name: string; description: string; parameters: Record<string, unknown> };
      return { name: fn.name, description: fn.description, input_schema: fn.parameters };
    });
    const declaredNames = new Set(tools.map((tool) => tool.name));
    const checkEnv = openWeightCheckEnv(args.workerHome, env, args.workerEnv);
    const maxTurns = args.maxTurns ?? 1;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) throw new Error(`cash ${label} maxTurns must be a positive integer`);
    const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: args.prompt }];
    for (;;) {
      const body = JSON.stringify({
        model: selection.model,
        system: OPENWEIGHT_OUTPUT_CONTRACT,
        messages,
        max_tokens: OPENWEIGHT_MAX_COMPLETION_TOKENS,
        output_config: { effort: selection.effort === "default" ? "medium" : selection.effort },
        ...(tools.length ? { tools } : {}),
      });
      const { envelope, attempt: { requestId, reservation } } = await cashRequestJson({
        args, deployment: selection.model, source: `cash ${label}`, endpoint, body,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        canContinue: () => turns < maxTurns,
        chargeFailure: () => {
          spentUsd += pending!.reservedUsd;
          budgetSettledUsd += pending!.reservedUsd;
          pending = undefined;
        },
        next: (checkActive) => {
          if (turns >= maxTurns) throw new Error(`cash ${label} tool loop exceeded maxTurns=${maxTurns}`);
          if (args.capabilityGrant) {
            const verification = verifyCapabilityGrant(args.capabilityGrant.store, args.capabilityGrant.request);
            if (!verification.ok) throw new CapabilityGrantRefusedError(verification.reason, verification.code, args.capabilityGrant.request.grantId);
          }
          checkActive();
          const requestId = `${requestPrefix}-${++turns}`;
          const reservation = reserveOpenWeightBudget(config, { requestId, deployment: selection.model,
            requestBodyBytes: Buffer.byteLength(body, "utf8"), atIso: clock.iso(), squeezed: args.cashSqueezed === true });
          budgetReservedUsd += reservation.reservedUsd;
          pending = { requestId, reservedUsd: reservation.reservedUsd };
          recordCashRequestEffort(requestEfforts, body, "foundry-messages");
          return { requestId, reservation };
        },
      });
      const payload = envelope as {
        id?: unknown; model?: unknown; stop_reason?: unknown; stop_details?: { category?: unknown } | null;
        content?: Array<Record<string, unknown>>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
      };
      sessionId = typeof payload.id === "string" ? payload.id : sessionId;
      servedModels.push(cashResponseModel(payload.model));
      const usage = payload.usage;
      if (!usage || !validFoundryTokenCount(usage.input_tokens) || !validFoundryTokenCount(usage.output_tokens) ||
          (usage.cache_read_input_tokens !== undefined && !validFoundryTokenCount(usage.cache_read_input_tokens)) ||
          (usage.cache_creation_input_tokens !== undefined && !validFoundryTokenCount(usage.cache_creation_input_tokens))) {
        // The provider may have billed this request. Keep the conservative reservation.
        spentUsd += reservation.reservedUsd;
        budgetSettledUsd += reservation.reservedUsd;
      } else {
        const measured = {
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cache_read_input_tokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
          cache_creation_input_tokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
        };
        const actualUsd = foundryClaudeUsageUsd(selection.model, measured);
        if (actualUsd > reservation.reservedUsd) throw new Error(`cash ${label} usage exceeded its conservative reservation`);
        settleOpenWeightBudget(config, { requestId, actualUsd, atIso: clock.iso() });
        promptTokens += measured.input_tokens;
        completionTokens += measured.output_tokens;
        cacheReadTokens += measured.cache_read_input_tokens;
        cacheCreationTokens += measured.cache_creation_input_tokens;
        spentUsd += actualUsd;
        budgetSettledUsd += actualUsd;
      }
      pending = undefined;
      if (!Array.isArray(payload.content)) throw new Error(`cash ${label} response has no content blocks`);
      if (payload.stop_reason === "max_tokens") throw new OpenWeightTruncatedReplyError("max_tokens", completionTokens);
      if (payload.stop_reason === "refusal") {
        // `stop_details.category` names the safeguard that fired; `explanation` is display-only prose and is never copied.
        const category = payload.stop_details?.category;
        throw new Error(`cash ${label} refused the request${typeof category === "string" && category ? ` (category: ${category})` : ""}`);
      }
      text = payload.content.filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string).join("\n");
      const calls = payload.content.filter((block) => block.type === "tool_use");
      for (const call of calls) observeWorkerToolLineage(toolLineage, { type: "tool_use", turnId: requestId, id: call.id, name: call.name });
      if (calls.length === 0) {
        lineageEnd = "stream-ended";
        if (payload.stop_reason !== "end_turn") throw new Error(`cash ${label} ended without a complete turn (${String(payload.stop_reason)})`);
        if (!text.trim()) throw new Error(`cash ${label} ended with no visible text`);
        return reconcileBoundedProviderAttempt(openWeightResult({
          model: selection.model, effort: selection.effort, requestEfforts, servedModels, startedAt, clock, text, sessionId, turns,
          promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens,
          actualCostUsd: spentUsd, budgetReservedUsd, budgetSettledUsd,
        }), args.externalEffect);
      }
      if (payload.stop_reason !== "tool_use") throw new Error(`cash ${label} returned a tool call with stop_reason=${String(payload.stop_reason)}`);
      if (turns >= maxTurns) throw new Error(`cash ${label} tool loop exceeded maxTurns=${maxTurns}`);
      messages.push({ role: "assistant", content: payload.content });
      const results: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        if (typeof call.id !== "string" || typeof call.name !== "string" || !declaredNames.has(call.name) ||
            !call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
          throw new Error(`cash ${label} requested an undeclared or malformed tool`);
        }
        let result: unknown;
        args.streamObserver?.({ kind: "tool-executing", tsMs: (args.clock ?? systemClock).now(), text: `[tool_use: ${call.name}]` });
        try {
          result = await executeOpenWeightTool(call.name, call.input as Record<string, unknown>, args.cwd, checkEnv, args.workerHome, args.runCheck,
            { config, runId: args.runId, taskId: args.taskId, clock });
        } catch (error) {
          observeWorkerToolLineage(toolLineage, { type: "tool_result", turnId: requestId, tool_use_id: call.id, is_error: true });
          // A failed tool invalidates this chain; never turn its error into success.
          throw new Error(`cash ${label} tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        observeWorkerToolLineage(toolLineage, { type: "tool_result", turnId: requestId, tool_use_id: call.id, is_error: false });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    // An unknown transport outcome remains charged. Only a definite 404 is known to cost zero.
    if (pending) {
      const billed = error instanceof OpenWeightDeploymentNotFoundError ? 0 : pending.reservedUsd;
      if (billed === 0) settleOpenWeightBudget(config, { requestId: pending.requestId, actualUsd: 0, atIso: clock.iso(), reason: "deployment not found" });
      spentUsd += billed;
      budgetSettledUsd += billed;
    }
    return reconcileBoundedProviderAttempt(openWeightResult({
      model: selection.model, effort: selection.effort, requestEfforts, servedModels, startedAt, clock, text, sessionId, turns,
      promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens,
      actualCostUsd: spentUsd, budgetReservedUsd, budgetSettledUsd,
      budgetRefused: error instanceof OpenWeightAllowanceExhaustedError,
      ...(error instanceof OpenWeightDeploymentNotFoundError ? { deploymentAbsent: selection.model } : {}),
      error,
    }), args.externalEffect);
  } finally {
    toolLineage.finish(lineageEnd);
  }
}

async function reconcileBoundedProviderAttempt(
  result: OpenWeightWorkerResult,
  externalEffect: OpenWeightSpawnArgs["externalEffect"],
): Promise<OpenWeightWorkerResult> {
  if (externalEffect === undefined) return result;
  const reconciliation = await reconcileExternalEffect(externalEffect.request);
  await externalEffect.onReconciled?.(reconciliation);
  return { ...result, externalEffect: reconciliation };
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
  if (isFoundryClaudeDeployment(selection.model)) return spawnFoundryClaudeWorker(args, config, selection);
  const usesResponses = CASH_RESPONSES_DEPLOYMENTS[selection.model] !== undefined;
  const toolLineage = createWorkerToolLineage({ provider: usesResponses ? "cash-responses" : "cash-chat",
    root: config.root, runId: args.runId, taskId: args.taskId });
  let lineageEnd: "stream-ended" | "interrupted" = "interrupted";
  const clock = args.clock ?? systemClock;
  const startedAt = clock.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let turns = 0;
  let sessionId = "";
  let text = "";
  const servedModels: Array<string | undefined> = [];
  const requestEfforts: CashRequestEffortCount[] = [];
  let budgetReservedUsd = 0;
  let budgetSettledUsd = 0;
  // W1-T3666: the reservation the CURRENT turn is still carrying, cleared the instant its own
  // settlement question (settle down from a receipt, or leave the conservative figure standing --
  // see the usage block below) is decided. If the turn throws before that point, this is what the
  // outer `catch` settles down instead of stranding: everything before it in a PRIOR turn already
  // reached its own decision and is no longer "pending".
  let pendingReservation: { requestId: string; deployment: string; requestBodyBytes: number } | undefined;
  let azureOpenAi429Unbilled = false;
  // Metered SEPARATELY from conversation turns (W1-T3558). They share the day cap — one cap is the
  // only way it bounds total Azure spend — but are counted apart so an operator can read what web
  // access cost, and how often it was refused, without inferring it from a conversation total.
  let webSearchAttempted = 0;
  let webSearchAccepted = 0;
  let webSearchRefused = 0;
  let webSearchUsd = 0;
  // Identity for this run's reservations. The run id is not sufficient on its own: the tool loop
  // sends one paid request PER TURN, and each needs its own settleable row.
  const runRequestPrefix = `${args.runId ?? args.taskId ?? "openweight"}-${startedAt}-${randomUUID()}`;
  try {
    // W1-T3880: verified FIRST, before `env`/the API key below are even read — a refused grant
    // must never reach the point where a real credential is used on its behalf. `capabilityGrant`
    // is absent for every caller that does not opt in, so this is a no-op until one does.
    if (args.capabilityGrant) {
      const verification = verifyCapabilityGrant(args.capabilityGrant.store, args.capabilityGrant.request);
      if (!verification.ok) {
        throw new CapabilityGrantRefusedError(verification.reason, verification.code, args.capabilityGrant.request.grantId);
      }
    }
    const env = args.env ?? process.env;
    // Built once, before any model tool call.  The Azure key stays in `env` for the HTTPS request
    // below, but never crosses this distinct process boundary into `run_check`.
    const checkEnv = openWeightCheckEnv(args.workerHome, env, args.workerEnv);
    const webSearchConsented = cashWebSearchEnabled(config);
    const tools = openWeightTools(args.tools, webSearchConsented);
    // W1-T10837: THE ONE RESOLVER, read here for the key (and again below, beside price, for the
    // endpoint -- see `openWeightEndpoint`). A deployment named in `cashDeploymentEndpoints` is
    // NOT READY when its own `keyEnv` is unset: it must never borrow the default key, which bills a
    // different account (design iii), so that case is a DISTINCT, named refusal rather than the
    // plain "requires RMD_OPENWEIGHT_API_KEY" message an unmapped deployment gets.
    const cashTarget = cashDeploymentTarget(config, selection.model, env);
    if (!cashTarget.ok) {
      if (cashTarget.reason === "no-endpoint") throw new Error("cash provider requires workerProviders.cashEndpoint");
      if (cashTarget.mapped) throw new CashDeploymentNotReadyError(selection.model, cashTarget.keyEnv);
      throw new Error(`openweight provider requires ${cashTarget.keyEnv} in the daemon environment`);
    }
    const key = cashTarget.key;
    const declaredNames = new Set(tools.map((tool) => String((tool.function as { name?: unknown }).name)));
    const messages: OpenWeightMessage[] = [
      { role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT },
      { role: "user", content: args.prompt },
    ];
    const responses = usesResponses ? new CashResponsesConversation(OPENWEIGHT_OUTPUT_CONTRACT, args.prompt) : undefined;
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
    const endpoint = openWeightEndpoint(config, selection.model);
    const capacityEndpoint = cashDeploymentEndpoint(config, selection.model);
    azureOpenAi429Unbilled = unbilledAzureOpenAi429Policy(selection.model, endpoint);
    hydrateCashCapacity(config);
    for (;;) {
      const body = responses ? responses.body(selection.model, selection.effort, OPENWEIGHT_MAX_COMPLETION_TOKENS, tools, args.responseFormat) : JSON.stringify({
        model: selection.model,
        messages,
        ...temperatureField,
        ...responseFormatField,
        // GPT-6 Chat Completions accepts function tools only at reasoning_effort=none.
        ...(selection.model === "gpt-6-luna" && declaredNames.size > 0 ? { reasoning_effort: "none" } : {}),
        max_completion_tokens: OPENWEIGHT_MAX_COMPLETION_TOKENS,
        ...(declaredNames.size > 0 ? { tools, tool_choice: "auto" } : {}),
      });
      const requestBodyBytes = Buffer.byteLength(body, "utf8");
      const { envelope, attempt: { requestId, reservation } } = await cashRequestJson({
        args, deployment: selection.model, source: "openweight", endpoint, body,
        headers: { "content-type": "application/json", "api-key": key },
        observeHeaders: (headers) => {
          try { recordCashCapacity(config, selection.model, headers, { clock, runId: args.runId, taskId: args.taskId, endpoint: capacityEndpoint }); }
          catch (error) {
            // Learning is advisory: a state file that cannot be written never fails the request it rode on.
            console.error(JSON.stringify({ event: "cash.capacity.record_failed", deployment: selection.model,
              reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
          }
        },
        canContinue: () => turns < maxTurns,
        chargeFailure: (error) => {
          const inputOnlyUsd = unbilledCashRefusal(error, azureOpenAi429Unbilled) ? 0
            : usesResponses ? openWeightReservationUsd(selection.model, requestBodyBytes)
            : openWeightUsageUsd(selection.model, requestBodyBytes, 0);
          settleOpenWeightBudget(config, { requestId: pendingReservation!.requestId, actualUsd: inputOnlyUsd,
            atIso: clock.iso(), reason: error.message });
          budgetSettledUsd += inputOnlyUsd;
          pendingReservation = undefined;
        },
        next: (checkActive) => {
          if (turns >= maxTurns) throw new Error(`openweight tool loop exceeded maxTurns=${maxTurns}`);
          if (args.capabilityGrant) {
            const verification = verifyCapabilityGrant(args.capabilityGrant.store, args.capabilityGrant.request);
            if (!verification.ok) throw new CapabilityGrantRefusedError(verification.reason, verification.code, args.capabilityGrant.request.grantId);
          }
          checkActive();
          const requestId = `${runRequestPrefix}-${++turns}`;
          const reservation = reserveOpenWeightBudget(config, { requestId, deployment: selection.model,
            requestBodyBytes, atIso: clock.iso(), squeezed: args.cashSqueezed === true });
          budgetReservedUsd += reservation.reservedUsd;
          pendingReservation = { requestId, deployment: selection.model, requestBodyBytes };
          recordCashRequestEffort(requestEfforts, body, usesResponses ? "responses" : "chat-completions");
          return { requestId, reservation };
        },
      });
      const payload = (responses ? responses.read(envelope as Parameters<CashResponsesConversation["read"]>[0]) : envelope) as {
        id?: unknown;
        model?: unknown;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cached_tokens?: unknown; cache_creation_tokens?: unknown };
        choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
      };
      sessionId = typeof payload.id === "string" ? payload.id : sessionId;
      servedModels.push(cashResponseModel(payload.model));
      const turnPromptTokens = typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : 0;
      const turnCompletionTokens = typeof payload.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : 0;
      const turnCached = typeof payload.usage?.cached_tokens === "number" ? payload.usage.cached_tokens : 0;
      const turnWritten = typeof payload.usage?.cache_creation_tokens === "number" ? payload.usage.cache_creation_tokens : 0;
      cacheReadTokens += turnCached;
      cacheCreationTokens += turnWritten;
      promptTokens += turnPromptTokens;
      completionTokens += turnCompletionTokens;
      // SETTLE DOWN ONLY FROM A RECEIPT WE COULD ACTUALLY READ. A response carrying no usage block
      // settles at 0 tokens, which would silently hand the allowance back for a request that really
      // was billed — so an absent receipt leaves the conservative reservation standing instead.
      if (usesResponses
        ? typeof payload.usage?.prompt_tokens === "number" && typeof payload.usage?.completion_tokens === "number" &&
          typeof payload.usage?.cache_creation_tokens === "number"
        : typeof payload.usage?.prompt_tokens === "number" || typeof payload.usage?.completion_tokens === "number") {
        const actualUsd = openWeightUsageUsd(selection.model, turnPromptTokens, turnCompletionTokens, turnCached, turnWritten);
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
      for (const call of calls) observeWorkerToolLineage(toolLineage, { type: "tool_use", turnId: requestId, id: call.id, name: call.function?.name });
      // UNFENCED ONLY WHEN A STRUCTURED REPLY WAS ASKED FOR. A prose lane may legitimately contain a
      // fenced code block as part of its answer, and unwrapping that would corrupt it; a lane that
      // requested `responseFormat` asked for a document, so a fence around the whole reply is a
      // wrapper rather than content.
      if (typeof message.content === "string") {
        text = args.responseFormat === undefined ? message.content : openWeightUnfence(message.content);
      }
      if (calls.length === 0) {
        lineageEnd = "stream-ended";
        return reconcileBoundedProviderAttempt(
          openWeightResult({ model: selection.model, effort: selection.effort, requestEfforts, servedModels, startedAt, clock, text, sessionId, turns, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, ...(usesResponses ? { actualCostUsd: budgetSettledUsd } : {}), budgetReservedUsd, budgetSettledUsd, webSearchAttempted, webSearchAccepted, webSearchRefused, webSearchUsd }),
          args.externalEffect,
        );
      }
      if (turns >= maxTurns) throw new Error(`openweight tool loop exceeded maxTurns=${maxTurns}`);
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        const id = call.id;
        if (typeof name !== "string" || !declaredNames.has(name) || typeof id !== "string") {
          throw new Error("openweight response requested an undeclared tool");
        }
        args.signal?.throwIfAborted();
        args.streamObserver?.({ kind: "tool-executing", tsMs: clock.now(), text: `[tool_use: ${name}]` });
        let content: string;
        let toolFailed = false;
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
            : JSON.stringify(await executeOpenWeightTool(
                name,
                objectArguments(call.function?.arguments),
                args.cwd,
                checkEnv,
                args.workerHome,
                args.runCheck,
                { config, runId: args.runId, taskId: args.taskId, clock },
              ));
        } catch (error) {
          toolFailed = true;
          observeWorkerToolLineage(toolLineage, { type: "tool_result", turnId: requestId, tool_use_id: id, is_error: true });
          if (usesResponses) throw new Error(`cash ${selection.model} tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        if (!toolFailed) observeWorkerToolLineage(toolLineage, { type: "tool_result", turnId: requestId, tool_use_id: id, is_error: false });
        responses?.toolOutput(id, content);
        messages.push({ role: "tool", tool_call_id: id, content });
      }
    }
  } catch (error) {
    // W1-T3666: A RESERVATION STILL PENDING WHEN THE TURN FAILS IS SETTLED DOWN HERE, NOT
    // STRANDED. `pendingReservation` is set only between a reservation's commit and its own
    // settlement decision (above), so reaching this with it defined means a 429, a transport
    // fault or an unparseable body cut the turn short before any usage receipt could be read --
    // exactly the gap `settleOpenWeightBudget`'s own doc names. A definite unbilled refusal settles
    // to zero; every other outcome keeps the INPUT-ONLY portion of the same byte-bound estimate
    // the reservation used (zero completion tokens): a failed
    // request produced no completion, so it must not be charged for the
    // `OPENWEIGHT_MAX_COMPLETION_TOKENS` ceiling the reservation assumed it might. `reason` is the
    // failure's own message, so the ledger row itself says which failure settled it.
    if (error instanceof CashCapacityShortfallFailure) recordCashCapacityShortfall(config, {
      reason: "capacity_shortfall", deployment: selection.model,
      estimatedTokens: error.estimatedTokens, limitTokens: error.limitTokens!,
    }, args);
    if (pendingReservation !== undefined) {
      // Only a definite unbilled refusal releases this request's reservation. Unknown outcomes stay charged.
      const inputOnlyUsd = unbilledCashRefusal(error, azureOpenAi429Unbilled)
        ? 0
        : usesResponses ? openWeightReservationUsd(pendingReservation.deployment, pendingReservation.requestBodyBytes)
        : openWeightUsageUsd(pendingReservation.deployment, pendingReservation.requestBodyBytes, 0);
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
    return reconcileBoundedProviderAttempt(
      openWeightResult({
        model: selection.model,
        effort: selection.effort,
        requestEfforts,
        servedModels,
        startedAt,
        clock,
        text,
        sessionId,
        turns,
        promptTokens,
        completionTokens,
        cacheReadTokens, cacheCreationTokens,
        ...(usesResponses ? { actualCostUsd: budgetSettledUsd } : {}),
        error,
        budgetReservedUsd,
        budgetSettledUsd,
        // A refusal is a distinct outcome from a transport failure: no paid request was made, so the
        // operator reading the ledger can tell "we declined to spend" from "we spent and it failed".
        budgetRefused: error instanceof OpenWeightAllowanceExhaustedError,
        ...(error instanceof OpenWeightDeploymentNotFoundError ? { deploymentAbsent: selection.model } : {}),
        webSearchAttempted,
        webSearchAccepted,
        webSearchRefused,
        webSearchUsd,
      }),
      args.externalEffect,
    );
  } finally {
    toolLineage.finish(lineageEnd);
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
  // W1-T10837: THIS deployment's own endpoint (the search credential itself stays the daemon's
  // single shared `CASH_WEB_SEARCH_KEY_ENV`, deliberately not per-deployment -- see that const's doc).
  const rawEndpoint = cashDeploymentEndpoint(input.config, input.model);
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

/** W1-T6027: Node's `exit` event hands a child `(code, signal)`, exactly one non-null. The signal is kept by name; an event
 * carrying neither is `unobserved`, never exit 0. */
function codexWorkerExit(code: number | null, signal: NodeJS.Signals | null | undefined): WorkerExit {
  if (signal) return { kind: "signal", signal };
  if (typeof code === "number") return { kind: "exit", code };
  return { kind: "unobserved" };
}

async function spawnCodexWorkerInPrivateTemp(
  args: CodexSpawnArgs,
  config: Config,
  privateTmpDir: string,
  selection?: Pick<ProviderCapacity, "model" | "effort">,
  nativeCacheRoot?: string,
): Promise<CodexWorkerResult> {
  const bin = resolveCodexBin(config);
  const startedAt = Date.now();
  const toolLineage = createWorkerToolLineage({ provider: "codex", root: config.root, runId: args.runId, taskId: args.taskId });
  let lineageEnd: "stream-ended" | "interrupted" = "interrupted";
  const stdout = new CodexJsonlAccumulator(startedAt, join(privateTmpDir, "stdout-pending.jsonl"), raw => observeWorkerToolLineage(toolLineage, raw),
    (text, tsMs) => args.streamObserver?.({ kind: "message", tsMs, text }),
    (toolName, toolInput, tsMs) =>
      args.streamObserver?.({ kind: "tool-executing", tsMs, text: `[tool_use: ${toolName}]`, toolName, toolInput, cwd: args.cwd }));
  const stdoutDecoder = new StringDecoder("utf8");
  let stdoutBytes = 0;
  const stderrRetainer = new CodexStderrRetainer();
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
    outputLimit = codexWorkerOutputLimitError(
      stream,
      limitBytes,
      observedBytes,
      stream === "stdout" ? stdout.eventBytesByKind() : {},
      stream === "stdout" ? stdout.pendingLineBytes() : 0,
    );
    if (pidRef.pid !== undefined) teardownOnce(pidRef.pid);
  };
  const childEnv = { ...codexSpawnEnv(config, args, nativeCacheRoot), TMPDIR: privateTmpDir };
  const contained = spawn(
    { command: bin, args: codexExecArgs(args, config, selection, nativeCacheRoot), cwd: args.cwd, env: childEnv },
    (chunk) => {
      if (outputLimit || timedOut) return;
      // W1-T8203: stderr past its bound is truncated (head + tail), never a teardown and never a verdict.
      stderrRetainer.push(chunk);
    },
    args.onSpawnError,
  );
  pidRef.pid = contained.pid;
  if (outputLimit) teardownOnce(contained.pid);
  const process = contained.process as unknown as ContainedProcess["process"] & NodeJS.EventEmitter & {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
  };
  const exitPromise = new Promise<WorkerExit>((resolve, reject) => {
    process.once("exit", (code: number | null, signal?: NodeJS.Signals | null) => resolve(codexWorkerExit(code, signal)));
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
    const text = stdoutDecoder.write(chunk);
    stdoutBytes += chunk.length;
    if (stdoutBytes > CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES) {
      exceedOutputBudget("stdout", CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES, stdoutBytes);
      return;
    }
    const observedAt = Date.now();
    stdout.push(text, observedAt);
    if (/\"type\":\"agent_message\"/.test(text)) args.streamObserver?.({ kind: "working", tsMs: observedAt });
    else args.streamObserver?.({ kind: "message", tsMs: observedAt });
    armClockBound();
  });
  armClockBound();
  const harnessCommits = codexHarnessCommits(args);
  const prompt = CODEX_DOCTRINE_PRELUDE + (harnessCommits ? CODEX_HARNESS_COMMITS_PART : "") + args.prompt;
  process.stdin.write(`${prompt}\n`);
  process.stdin.end();
  // W1-T9245: no timer and no bound — the abort acts when it fires; the listener goes when the spawn settles.
  const signal = args.signal;
  const onAbort = () => teardownOnce(contained.pid);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const exit = await withWorkerGroupTeardown(pidRef, () => exitPromise, teardownOnce);
    if (outputLimit) throw outputLimit;
    if (timedOut) throw new Error(`Codex worker exceeded the ${args.clockBound?.boundMs}ms clock bound`);
    stdout.push(stdoutDecoder.end());
    const parsed = stdout.finish();
    lineageEnd = exit.kind === "exit" && exit.code === 0 && !parsed.isError ? "stream-ended" : "interrupted";
    if (parsed.outputTruncation && args.runId) appendLedger(ledgerPathFor(config), {
      run_id: args.runId,
      task_id: args.taskId ?? "unattributed",
      step: "worker.output_truncated",
      output_truncation: parsed.outputTruncation,
    });
    const stderr = stderrRetainer.text();
    const stderrTruncation = stderrRetainer.truncation();
    // A signal is an error whatever the stream parsed, so is an end with no code: only an observed exit 0 is clean.
    const exitCode = exit.kind === "exit" ? exit.code : null;
    const isError = parsed.isError || exitCode !== 0;
    const model = selection?.model ?? config.workerProviders?.codexModel ?? "codex-default";
    const notionalCostUsd = parsed.tokenUsageState === "observed" ? codexNotionalCostUsd(model, parsed.tokens) : undefined;
    const harnessCommit = harnessCommits && !isError ? commitCodexWriterEdits(args.cwd, parsed.text) : undefined;
    if (harnessCommit && args.runId) appendLedger(ledgerPathFor(config), {
      run_id: args.runId,
      task_id: args.taskId ?? "unattributed",
      step: "codex.harness_commit",
      outcome: harnessCommit.outcome,
      ...(harnessCommit.outcome === "committed" ? { sha: harnessCommit.sha, ...aliasRewriteFields(harnessCommit.aliasRewrite) } : {}),
      ...(harnessCommit.outcome === "refused" ? { reason: harnessCommit.reason } : {}),
    });
    return {
      ...(harnessCommit === undefined ? {} : { harnessCommit }),
      sessionId: parsed.sessionId || args.resumeSessionId || "",
      costUsd: 0,
      ...(notionalCostUsd === undefined ? {} : { notionalCostUsd }),
      numTurns: parsed.numTurns,
      // Codex exec 0.152.0 exposes no max-turn flag; never ledger the Claude cap as enforced.
      maxTurns: undefined,
      text: parsed.text,
      blocks: parsed.blocks,
      ...(parsed.outputTruncation ? { outputTruncation: parsed.outputTruncation } : {}),
      ...(stderrTruncation ? { stderrTruncation } : {}),
      stderr,
      subtype: isError ? (parsed.isError ? parsed.subtype : `error_exit_${exitCode}`) : "success",
      isError,
      exit,
      apiError: parsed.errors.some((error) => /rate limit|server|network/i.test(error)),
      ...(parsed.usageRefusal ? { usageRefusal: parsed.usageRefusal } : {}),
      permissionDenials: parsed.errors.filter((error) => /permission|sandbox|denied/i.test(error)),
      childEnvKeys: Object.keys(childEnv),
      accountLabel: undefined,
      provider: "codex",
      model,
      effort: selection?.effort ?? args.effort ?? "default",
      tokens: parsed.tokens,
      tokenUsageState: parsed.tokenUsageState,
      modelUsage: {},
      servedModel: null,
      servedModelReason: CODEX_SERVED_MODEL_REASON,
      compactionEvents: [],
      compactionFailures: [],
      compactionConfigured: false,
      qualitySuspect: false,
      workerDurationMs: Date.now() - startedAt,
    };
  } finally {
    // W1-T8203: ledgered beside output_truncation, on success and on a failure that never parsed a result alike.
    const droppedStderr = stderrRetainer.truncation();
    if (droppedStderr && args.runId) appendLedger(ledgerPathFor(config), {
      run_id: args.runId,
      task_id: args.taskId ?? "unattributed",
      step: "worker.stderr_truncated",
      stderr_truncation: droppedStderr,
    });
    toolLineage.finish(lineageEnd);
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ── W1-T3718: THE REPAIR LADDER IS A FLEET STATE, NOT A PER-ATTEMPT LINE ────────────────────
// MEASURED 2026-09-17: the fix rung could not spawn for ~90 minutes, every provider refusing and
// both paid rungs switched off. The only trace was one `fix.spawn_infra_blocked` row among 731, so
// the operator's sole symptom was red PRs that stopped moving. A stalled ladder is the repair
// mechanism being OFF: one durable record with its first-seen instant, cleared by the first spawn
// that succeeds, and read by the surfaces an operator already watches.

/** The two paid rungs below the subscriptions, in the order `spawnWorker` tries them. */
export type RepairLadderRungId = "cash" | "overflow";

/** One paid rung as a blocked spawn saw it. `refusal` is why it did not carry the spawn;
 *  `refusalIfSwitched` is what would STILL refuse it with its operator switch turned on. */
export interface RepairLadderFallback {
  rung: RepairLadderRungId;
  refusal?: string;
  refusalIfSwitched?: string;
}

export interface RepairLadderProvider {
  provider: WorkerProviderId;
  condition: ProviderRefusalCondition;
  detail: string;
}

/** The durable record. It carries NO refusal count, by design: a count is the shape nobody read. */
export interface RepairLadderStallRecord {
  version: 1;
  /** First-seen instant of THIS stall; kept across every later refusal until a spawn succeeds. */
  since: string;
  lastSeen: string;
  reason: string;
  providers: RepairLadderProvider[];
  fallbacks: RepairLadderFallback[];
}

export type RepairLadderStall = Omit<RepairLadderStallRecord, "version" | "since" | "lastSeen">;

export type RepairLadderState =
  | { state: "running" }
  | ({
      state: "stalled";
      ageMs: number;
      downFor: string;
      /** True when some provider could not be ASKED: an infrastructure fault a paid rung routes
       *  around but does not repair. */
      infrastructureFault: boolean;
    } & Omit<RepairLadderStallRecord, "version">)
  | { state: "unreadable"; reason: string };

export function repairLadderStatePath(root: string): string {
  return join(root, "state", "repair-ladder.json");
}

/** The stall a spawn refusal represents, or `undefined` when it is not the ladder being off -- a
 *  refusal other than "no provider would take the work" is a per-spawn fault, not this state. */
export function repairLadderStallFrom(error: unknown, fallbacks: readonly RepairLadderFallback[]): RepairLadderStall | undefined {
  if (!(error instanceof ProviderCapacityBlockedError)) return undefined;
  return {
    reason: error.message,
    providers: error.capacities.map((capacity) => ({
      provider: capacity.provider,
      condition: providerRefusalCondition(capacity),
      detail: providerRefusalDetail(capacity),
    })),
    fallbacks: fallbacks.map((fallback) => ({ ...fallback })),
  };
}

function parseRepairLadderRecord(raw: string): RepairLadderStallRecord | undefined {
  const parsed = JSON.parse(raw) as Partial<RepairLadderStallRecord> | null;
  if (!parsed || typeof parsed !== "object" || typeof parsed.since !== "string" || !Number.isFinite(Date.parse(parsed.since))) {
    return undefined;
  }
  return {
    version: 1,
    since: parsed.since,
    lastSeen: typeof parsed.lastSeen === "string" ? parsed.lastSeen : parsed.since,
    reason: typeof parsed.reason === "string" ? parsed.reason : "no reason recorded",
    providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    fallbacks: Array.isArray(parsed.fallbacks) ? parsed.fallbacks : [],
  };
}

/** Record (or extend) the stall. A stall already on record keeps its `since`: the surface reports
 *  how long the ladder has been down, never when it was last refused. */
export function recordRepairLadderStall(
  root: string,
  stall: RepairLadderStall,
  nowMs: number = systemClock.now(),
): { record: RepairLadderStallRecord; began: boolean } {
  const path = repairLadderStatePath(root);
  const raw = readFileIfExists(path);
  let prior: RepairLadderStallRecord | undefined;
  try {
    prior = raw === undefined ? undefined : parseRepairLadderRecord(raw);
  } catch (error) {
    // A torn or foreign file is not evidence of an earlier stall; this one starts now.
    console.error(JSON.stringify({ event: "repair_ladder.prior_unreadable", reason: (error as Error).message }));
  }
  const at = fixedClock(nowMs).iso();
  const record: RepairLadderStallRecord = { version: 1, since: prior?.since ?? at, lastSeen: at, ...stall };
  writeAtomic(path, `${JSON.stringify(record)}\n`);
  return { record, began: prior === undefined };
}

/** Clear the stall on a successful spawn. Returns the record it cleared, if one was on file. */
export function clearRepairLadderStall(root: string): RepairLadderStallRecord | undefined {
  const path = repairLadderStatePath(root);
  if (!existsSync(path)) return undefined;
  let cleared: RepairLadderStallRecord | undefined;
  try {
    cleared = parseRepairLadderRecord(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(JSON.stringify({ event: "repair_ladder.clear_unparsed", reason: (error as Error).message }));
  }
  rmSync(path, { force: true });
  return cleared;
}

export function formatDownFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** The live state, as the status surfaces and the operator verb read it. An unreadable file is
 *  reported as UNREADABLE, never as a running ladder. */
export function readRepairLadderState(root: string, nowMs: number = systemClock.now()): RepairLadderState {
  let record: RepairLadderStallRecord | undefined;
  try {
    const raw = readFileIfExists(repairLadderStatePath(root));
    if (raw === undefined) return { state: "running" };
    record = parseRepairLadderRecord(raw);
  } catch (error) {
    return { state: "unreadable", reason: (error as Error).message };
  }
  if (record === undefined) return { state: "unreadable", reason: "repair-ladder record has no readable first-seen instant" };
  const { version: _version, ...rest } = record;
  const ageMs = Math.max(0, nowMs - Date.parse(record.since));
  return {
    state: "stalled",
    ageMs,
    downFor: formatDownFor(ageMs),
    infrastructureFault: record.providers.some((provider) => provider.condition === "cannot-be-asked"),
    ...rest,
  };
}

/** One paid rung, priced: what switching it on would bill, the ceiling, and what would still refuse. */
export interface RepairLadderRungPrice {
  rung: RepairLadderRungId;
  /** The ONE config edit that arms this rung. Printed, never applied. */
  switchSetting: string;
  /** True when this rung would carry a blocked spawn right now. */
  armed: boolean;
  refusal?: string;
  /** What would still refuse this rung with its switch on; absent when the switch alone suffices. */
  stillBlockedBy?: string;
  billing: string;
  dailyCeilingUsd: number | null;
  price: string;
}

const RUNG_TERMS: Record<RepairLadderRungId, { switchSetting: string; billing: string; squeezed: boolean }> = {
  cash: {
    switchSetting: "workerProviders.cashFallbackWhenBlocked: true",
    billing: "per request to the cash provider, outside every subscription",
    // The blocked-auction cash spawn is the ONE place the squeeze ceiling is claimed.
    squeezed: true,
  },
  overflow: {
    switchSetting: 'overflow: "api_key"',
    billing: "per token to Anthropic API credits, outside the subscription",
    squeezed: false,
  },
};

/** Price every paid rung from config alone. PURE: it reads the config it is handed and writes
 *  nothing -- enabling a paid fallback spends money and stays an operator act. */
export function priceRepairLadderRungs(
  config: Pick<Config, "dailyCapUsd">,
  fallbacks: readonly RepairLadderFallback[],
): RepairLadderRungPrice[] {
  return fallbacks.map((fallback) => {
    const terms = RUNG_TERMS[fallback.rung];
    let dailyCeilingUsd: number | null;
    let ceilingNote: string | undefined;
    try {
      dailyCeilingUsd = effectiveCashCapUsd(config.dailyCapUsd, { squeezed: terms.squeezed }) ?? null;
    } catch (error) {
      // An inverted cap pair is refused, never guessed: the rung is priced with NO ceiling and the
      // price line carries the refusal's own words.
      dailyCeilingUsd = null;
      ceilingNote = (error as Error).message;
    }
    const price = dailyCeilingUsd === null
      ? `billed ${terms.billing}; NO daily ceiling (${ceilingNote ?? "dailyCapUsd is unset"}), so this rung refuses even when switched on`
      : `billed ${terms.billing}; at most $${dailyCeilingUsd}/UTC day (dailyCapUsd${typeof config.dailyCapUsd === "object" ? (terms.squeezed ? ".squeezed" : ".normal") : ""})`;
    return {
      rung: fallback.rung,
      switchSetting: terms.switchSetting,
      armed: fallback.refusal === undefined,
      ...(fallback.refusal === undefined ? {} : { refusal: fallback.refusal }),
      ...(fallback.refusalIfSwitched === undefined ? {} : { stillBlockedBy: fallback.refusalIfSwitched }),
      billing: terms.billing,
      dailyCeilingUsd,
      price,
    };
  });
}

/** The operator verb's text: the ladder's live state, then each rung priced. Changes nothing. */
export function renderRepairLadderReport(state: RepairLadderState, rungs: readonly RepairLadderRungPrice[]): string[] {
  const lines: string[] = [];
  if (state.state === "running") lines.push("repair ladder: RUNNING — no stall on record since the last successful spawn");
  else if (state.state === "unreadable") lines.push(`repair ladder: UNREADABLE — ${state.reason}`);
  else {
    lines.push(`repair ladder: STALLED for ${state.downFor} (since ${state.since}, last refused ${state.lastSeen})`);
    for (const provider of state.providers) {
      lines.push(`  ${provider.provider}: ${provider.condition === "full" ? "FULL" : "CANNOT BE ASKED"} — ${provider.detail}`);
    }
    if (state.infrastructureFault) {
      lines.push("  a provider that cannot be asked is an infrastructure fault: a paid rung routes around it, it does not repair it");
    }
  }
  lines.push("paid rungs (this verb changes nothing — switching one on spends money and stays an operator act):");
  for (const rung of rungs) {
    lines.push(`  ${rung.rung}: ${rung.armed ? "ARMED" : "OFF"} — switch: ${rung.switchSetting}`);
    lines.push(`    price: ${rung.price}`);
    if (rung.refusal !== undefined) lines.push(`    refused now: ${rung.refusal}`);
    lines.push(`    ${rung.stillBlockedBy === undefined ? "the switch alone would arm it" : `still blocked with the switch on: ${rung.stillBlockedBy}`}`);
  }
  return lines;
}
