import type { ReleaseEvidence } from "./operator-release.js";
/** lib/daemon.ts — the daemon's scheduler-loop core (W1-T12a).
 *
 * This is the headless, unit-testable half of W1-T12 (Daemonize). Launchd unit generation is W1-T12b
 * (lib/launchd.ts). Crash recovery's resume/clean split is W1-T12c (`reconstructOrphan`, below); its
 * batch driver `reconstructState` was retired as superseded by runRecoverability in
 * src/run-task.ts (W1-T361). Live commissioning is W1-T12d and is not here.
 *
 * Invariant: this module is pure. It never touches the filesystem, git, the network or a spawn. Every
 * side effect arrives through an injected dependency, so the loop is provable against a fake clock,
 * and locking belongs to the CLI wiring exactly as it does for `rmd drain`. It reuses drain.ts's
 * machinery rather than reimplementing it: where drain treats "nothing runnable" as a terminal stop,
 * this loop paces itself on the injected clock and keeps polling, because new work lands later. Each
 * non-merged verdict is reasoned about by `block-reason.ts` rather than halting the pass (W1-T46).
 *
 * Forensics for this file: docs/forensics/daemon.md. */

import type { AutoTriageDecision } from "./auto-triage.js";
import { startPlainBackfill, type PlainBackfillDeps } from "./inbox-plain.js";
import { startRecommendationBackfill, type RecommendationBackfill } from "./inbox-recommendation.js";
import { startFleetLane, triageFleetLaneAsync, type FleetLaneDeps } from "./fleet-lane.js";
import type { Escalation } from "./escalate.js";
import { governorIncidentFromLedgerRow, governorTiersFromLedger, sreGovernorVerdict, SRE_GOVERNOR_STEP, type SreGovernorControls, type SreGovernorIncident, type SreGovernorVerdict } from "./sre-governor.js";
import { runSreLanePass, sreLaneOffPath, type SreLaneInput } from "./sre-lane.js";
import { daemonSreGovernorEnforcer, receiptFromLedgerRow, type SreGovernorEnforcer, type SreRunbookReceipt } from "./sre-runbooks.js";
import { startGarden, type GardenerDeps, type PrState } from "./gardener.js";
import { knowledgeGardenSpec, type GardenWorkspace } from "./knowledge-gardener.js";
import { startInboxResponder, type InboxResponderDeps } from "./inbox-responder.js";
import { startLivenessPulse } from "./liveness-pulse.js";
import { installSpawnHelper, startSpawnHelper } from "./spawn-helper.js";


import type {
  CiLearningCadenceRunResult,
  MeasurementCadenceChildRunner,
  MeasurementCadenceDecision,
  MeasurementCadenceRunResult,
  WipeTestCadenceDecision,
  WipeTestCadenceRunResult,
} from "./measurement-cadence.js";
import { buildMeasurementCadenceRow, wipeTestCadenceEvidenceFields } from "./measurement-cadence.js";
import { runOpportunityIntake, openOpportunityIntakePorts, type OpportunityIntakePorts } from "./opportunity-intake.js";
import { reconcileOpportunityOutcomesAsync, openOpportunityOutcomePorts, type OpportunityOutcomePorts } from "./opportunity-outcomes.js";
import type { BoardReviewCadenceDecision, BoardReviewReport } from "./board-review.js";
import type { DigestCadenceRunResult } from "./digest.js";
import type { LedgerCompactionDecision, LedgerCompactionOutcome } from "./ledger-compaction-rung.js";
import type { BenchmarkCohortPassResult } from "./benchmark-cohort.js";
import { planSha, runChildOutsideKill, type AdoptedRunChild, type RunChildHandle, type RunChildPending } from "./run-child.js";
import type { RunResult } from "./run-result.js";
import { assertCleanBoot, type BootAssertion } from "./env.js";
import { classifyFailure } from "./classify.js";
import { changesInstallInputs, coalesceFreshnessRestart, decideFreshnessRestart, DEPLOY_RESTART_SCORE_THRESHOLD, FRESHNESS_COALESCE_WINDOW_MS, FRESHNESS_DECISION_STEP, FRESHNESS_MIN_LIFETIME_MS, INSTALL_INPUTS_RELEASE, MIN_LIFETIME_HOLD, type DeployRestartPressureState, type DeployWorthChange } from "./deploy-judge.js";
import { INITIAL_RETRY_STATE, reasonAboutBlock, type RetryState } from "./block-reason.js";
import {
  nextRunnable,
  runnableCandidates,
  passedOverStateKey,
  laneDispatchBudget,
  wipDeferredAdmissionFields,
  type QueueAdmissionReading,
  type MergedSet,
  type NextRunnableOpts,
  parsePushedRunRefs,
  stillBlockedByPushedRunBranch,
  logPlanOnlyRunBranchException,
  type OrphanRunBranchEvidence,
  type PushedRunRef,
  type PlanOnlyRunBranchReceipt,
  type OpenPrCheck,
  tallyDispatchFilters,
  type IdleReasonBucket,
  IDLE_REASON_ID_CAP,
  laneCredentialRefusal,
  laneDeliveryFailure,
  type PriorityBackfillEstimates,
  type PriorityDeferral,
  type PriorityReservationRelease,
  applyCuratedSelection,
  type DrainOpts,
  type DrainSummary,
  type StopReason,
  type TargetJobAdmission,
  type TargetJobRead,
  type TargetJobRecord,
  type TargetJobStatus,
} from "./drain.js";
import { preDispatchContractRevision } from "./dispatch-repair.js";
// Why: drain.ts already owns the overlap partition, so it is reused rather than re-derived (W1-T343).
import {
  NO_OBSERVED_SCOPE,
  partitionByFileOverlap,
  serializedLedgerPayload,
  settledSetPayload,
  type ObservedScopeByTask,
} from "./dispatch-overlap.js";
import { DEPLOY_IDLE_DEFER_CEILING_MS } from "./deployer.js";
import { evaluatePauseTier, isRecyclePauseDetail, type PauseTier, type PauseTierInput } from "./fleet-control.js";
import { createFleetAccountEpisode, redactedAccountLabel, type FleetAccountDivergence, type FleetAccountPair } from "./account-usage.js";
import { HEADROOM_LIMIT_PCT, RESET_UNKNOWN, UNREADABLE_DEGRADED_LIMIT } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
// Type-only, so no runtime edge is added to daemon-health.ts, which already imports a value from
// here; a value import would close a real cycle. This module never shells GitHub itself (W1-T372).
import type { GhRateLimitBuckets } from "./daemon-health.js";
import type { CostGovernorResult, LightPassScopeName, MemoryGovernorResult, QueueGovernorResult } from "./sweep.js";
// W1-T3691 — a value import (`trackStaleReviewerSkipRecurrence`, `renderHeldReviewQueueBlocker`)
// alongside the type-only ones above: sweep.ts imports nothing from this module, so this closes
// no cycle either, same as the value import just below.
import {
  detectStaleBody,
  trackStaleReviewerSkipRecurrence,
  renderHeldReviewQueueBlocker,
  type StaleBodyFinding,
  type StaleBodyPrView,
  type StaleReviewerRecurrenceAction,
  type StaleReviewerRecurrenceState,
  type StaleReviewerSkipObservation,
} from "./sweep.js";
// A value import, unlike the type-only line above. Safe: sweep.ts imports nothing from this
// module, so this edge closes no cycle (W1-T2744).
import {
  detachSweepAction,
  detachedActionInFlight,
  detachedSweepActionCount,
  drainDetachedSweepActions,
  abandonDetachedSweepAction,
  drainInFlightReviews,
  inFlightReviewCount,
  inFlightReviewRunsNow,
  restartDrainInventory,
  type RestartDrainInventoryEntry,
} from "./sweep.js";
// VALUE import (W1-T342's gate moved to its own pure module so drain.ts can share it — see that
// module's header for why neither daemon.ts nor sweep.ts could host it). Pure, no filesystem.
import { checkDispatchGovernors, checkNewBuildReservation, governorDeferPayload, newBuildReservationPayload, type DispatchGovernorDeps, type DispatchGovernorVerdict, type MemoryReadTracker, type QuietHoursHoldResult } from "./dispatch-governor.js";
import { assertRunnable, PlanError, TaskAdmissionError, type MergedResolver, type Plan, type Task } from "./plan.js";
import { resolveReleases, closedUnmergedRunBranchRefs, type DispatchFilterReason, type ReleaseResolution } from "./drain.js";
import type { StatusProjection } from "./status.js";
import { ENVIRONMENTAL_BLOCK_COOLDOWN_MS, INDEPENDENT_BLOCK_RELEASED_STEP, isEnvironmentalBlock, PRE_RESTORE_RUN_VERDICT_STAGES, type IndependentBlockRelease } from "./status.js";
import { explainDispatchScore, type DispatchValueContext } from "./dispatch-value.js";
import { GhJsonUnreadableResponseError, takeGhReadCadenceTally, type GhReadCadenceTally } from "./github-transport.js";
// Type-only: retro.ts owns this shape, so the two hooks below never re-declare it (W1-T160).
import type { RetroTriggerDecision } from "./retro.js";
// Type-only, keeping this module free of a runtime dependency on worker-containment.ts.
import type { OrphanSweepReport } from "./worker-containment.js";
// Type-only — shapes the feedback-landing injection points below (W1-T530).
import type { LandFeedbackResult } from "./feedback-landing.js";
// Type-only — github-posture.ts owns this shape; the real read lives in run-task.ts (W1-T1040).
import type { GithubPostureFinding } from "./github-posture.js";
// The Clock port (W1-T2897): declared in "../lib/clock" so every reachable-through-lib import
// still resolves through this same file. `DaemonDeps.now`/`crashLoopCheck.now` keep their legacy
// `() => Date` / `() => string` shapes (many tests inject those directly), so the adapters below
// convert them into a `Clock` at the read site instead of forcing every caller to change; the
// headroom sampler is internal-only, so it is migrated onto `Clock` outright, no adapter needed.
import { clockFromDateFn, clockFromIsoFn, fixedClock, loopAvailableDeadline, systemClock, type Clock } from "../lib/clock.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { createGateObservationState, observeGate } from "./gate-observations.js";
import { getHeapStatistics } from "node:v8";
import { defaultLaneGovernorPorts, LANE_TARGET_STEP, laneTarget, laneTargetPayload, type LaneGovernorPorts, type LaneMemoryReading, type LaneTarget } from "./lane-governor.js";
import type { LaneGovernorMode } from "./policy.js";
import {
  createDaemonMemoryGovernor, createHeapShadow, heapSamplePath, installedHeapShadow, installHeapShadow, reclaimBeforeMemoryRestart, reclaimLedgerFields, type DaemonMemoryGovernor, type HeapShadowOptions,
} from "./daemon-memory-policy.js";
import {
  IDLE_LANE_SUMMARY_WINDOW_MS,
  accountIdleLaneMinutes,
  chargeRestartGap,
  idleLaneCauseForStep,
  idleLaneStateChanged,
  lastIdleLaneRecord,
  newIdleLaneAccount,
  rollIdleLaneWindow,
  summarizeIdleLaneAccount,
  type IdleLaneCause,
  type IdleLaneHold,
} from "./idle-lane-accounting.js";

/** W1-T3978: the implement producer's exact refusal, carried as runtime metadata without widening
 * the shared RunResult union used by every other dispatch lane. */
type HarnessCommitRefusalResult = RunResult & {
  harnessCommitRefused?: true;
  harnessCommitRefusalReason?: string;
};

/** Await the daemon's merge-rate read before handing the SRE lane its synchronous input. */
export function startDaemonSreLane(
  input: (mergedLastDay: number) => SreLaneInput,
  mergedLastDay: () => Promise<number>,
  log: (step: string, extra?: Record<string, unknown>) => void,
): (intervalMs: number) => { stop: () => void; settled: () => Promise<void> } {
  return (intervalMs) => {
    let inFlight: Promise<void> | undefined;
    const tick = () => {
      if (inFlight) return;
      inFlight = Promise.resolve().then(mergedLastDay)
        .then((rate) => runSreLanePass(input(rate)))
        .then(() => undefined)
        .catch((error: unknown) => log("sre_lane.failed", { error: String((error as Error)?.message ?? error) }))
        .finally(() => { inFlight = undefined; });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer), settled: async () => inFlight };
  };
}

/** Reason the scheduler loop returned. Every terminal state is one of these. `headroom_exhausted` and `paused` are
 * deliberately absent: both are awaiting-states whose exit the supervisor would relaunch straight back into, so both
 * idle in process instead (W1-T197; 2026-07-22). `stale` has the opposite polarity — it is a request to exit, because
 * a supervisor restart is the only way a long-running daemon gets off the code it loaded at boot (W1-T126). */

export type DaemonStopReason = "stopped" | "blocked" | "max_reached" | "error" | "stale" | "heap_pressure" | "idle_starved";

/** Default idle-poll pace: check back once a minute while nothing is runnable. The literal stays
 *  here because this module never touches the filesystem; `daemonCommand` threads the policy value
 *  on every real invocation, so this is provably dead for the operating path (W1-T253).
 *
 *  W1-T2895: `daemon-health.ts` used to import this VALUE from here, which — paired with this
 *  file's own `import type { GhRateLimitBuckets }` from `daemon-health.ts` above (dependency-
 *  cruiser's `swc` parser counts a type-only edge the same as a value one for cycle detection) —
 *  closed a genuine two-module ring. `daemon-health.ts` now sources the value from the leaf module
 *  `poll-interval.ts` instead: that module restates this same literal and imports nothing, so it
 *  cannot itself close a cycle back here. This declaration is therefore unchanged (still the
 *  canonical, filesystem-free constant every other consumer of `daemon.js` imports), and the ring
 *  is cut on `daemon-health.ts`'s side, not by turning this export into a re-export. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export type IntakeRungDecision =
  | { rung: string; fire: true; reason: string }
  | { rung: string; fire: false; reason: string };

export interface IntakeRungRunResult {
  rung: string;
  status: string;
  [key: string]: unknown;
}

/** Default cold-start bound on the full reconciliation pass and the review-drain bound, mirroring
 *  `plan/policy.yaml`'s `sweepWallClockBoundMs` row, which carries the derivation. Same fs-free
 *  fallback reasoning as {@link DEFAULT_POLL_INTERVAL_MS} above (W1-T1044, W1-T9563). */
export const DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS = 559_000;

/** PRIMARY CONTROL (W1-T9563): the full pass's bound is learned from passes that SETTLED, abandoned-then-settled
 *  ones included: they are the healthy-slow population a fixed bound misread as hangs (10-14 12-24Z: 21 of 41
 *  passes abandoned at 559 s, p50 16.6 min, none hung). Bound = nearest-rank p90 of the last
 *  {@link SWEEP_BOUND_WINDOW} settled durations x {@link SWEEP_BOUND_HEADROOM}. On 10-14 12-24Z's sample that is 3 x 33.7 = 101.1 min: 2.9x the slowest
 *  settled pass (35.3 min), 0.61x the shortest confirmed hang (165.5 min); on 10-13 00-12Z, 3 x 9.8 = 29.4 min still
 *  clears that window's slowest (15.0 min). Never clamped to the policy row's max: no fixed ceiling. A hang never
 *  settles, so it never widens the sample. Below {@link SWEEP_BOUND_MIN_SAMPLES}, see {@link learnedSweepBound}. */
export const SWEEP_BOUND_QUANTILE = 0.9;
/** PRIMARY CONTROL: headroom over the quantile; the 10-14 12-24Z sample admits 1.05x (slowest settled) to 4.9x (shortest hang). */
export const SWEEP_BOUND_HEADROOM = 3;
/** PRIMARY CONTROL: about one 12 h window of settled passes at 10-14's rate (20-40), so the bound follows a
 *  slowdown within half a day. */
export const SWEEP_BOUND_WINDOW = 40;
/** BACKSTOP: fewest settled passes the quantile is read from; below it nearest-rank p90 is only the newest few maxima. */
export const SWEEP_BOUND_MIN_SAMPLES = 5;

/** The learner's state: the policy cold-start value and the most recent settled full-pass durations, oldest first;
 *  `seededFrom` is the boot seed's source, logged once with the first pass (W1-T9632). */
export interface SweepBoundLearner { fallbackMs: number; settledMs: number[]; seededFrom?: "ledger_union" | "live_ledger" }

export interface LearnedSweepBound { boundMs: number; basis: "observed_passes" | "settled_max_fallback" | "no_history_fallback"; samples: number }

/** The step every settled full pass writes, and the restart-history union read carries for the boot seed (W1-T9632). */
export const SWEEP_SETTLED_STEP = "daemon.sweep.settled";

/** W1-T9632: below {@link SWEEP_BOUND_MIN_SAMPLES} the bound never falls under the longest held pass x the same
 *  headroom (`settled_max_fallback`), else the policy value (`no_history_fallback`). On 10-15 settled passes of
 *  1,384-4,995 s left the learner at 0-2 samples per boot and every pass was abandoned at 559 s. */
export function learnedSweepBound(learner: SweepBoundLearner): LearnedSweepBound {
  const samples = learner.settledMs.length;
  if (samples < SWEEP_BOUND_MIN_SAMPLES) {
    const longest = Math.round(Math.max(0, ...learner.settledMs) * SWEEP_BOUND_HEADROOM);
    return longest > learner.fallbackMs
      ? { boundMs: longest, basis: "settled_max_fallback", samples }
      : { boundMs: learner.fallbackMs, basis: "no_history_fallback", samples };
  }
  const sorted = [...learner.settledMs].sort((a, b) => a - b);
  const p = sorted[Math.min(samples, Math.max(1, Math.ceil(SWEEP_BOUND_QUANTILE * samples))) - 1];
  return { boundMs: Math.round(p * SWEEP_BOUND_HEADROOM), basis: "observed_passes", samples };
}

/** Appends one settled duration, keeping the newest {@link SWEEP_BOUND_WINDOW}; a non-positive one measures nothing. */
export function recordSettledSweep(learner: SweepBoundLearner, elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  learner.settledMs.push(elapsedMs);
  if (learner.settledMs.length > SWEEP_BOUND_WINDOW) learner.settledMs.splice(0, learner.settledMs.length - SWEEP_BOUND_WINDOW);
}

/** The boot seed: settled durations from the restart-history union's rows, else the live file's (W1-T9632), in `ts`
 *  order when every row has one, so the window keeps the newest whatever order the union read returned. */
export function settledSweepDurations(rawLines: readonly string[]): number[] {
  const out: number[] = [];
  const at: number[] = [];
  for (const raw of rawLines) {
    if (!raw.includes(`"${SWEEP_SETTLED_STEP}"`)) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw); } catch (error) { /* a torn ledger row supplies no measurement */ continue; }
    if (row?.step === SWEEP_SETTLED_STEP && typeof row.elapsed_ms === "number" && row.elapsed_ms > 0) {
      out.push(row.elapsed_ms);
      at.push(typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);
    }
  }
  if (at.every(Number.isFinite)) return out.map((ms, i) => ({ ms, at: at[i] })).sort((a, b) => a.at - b.at).map(({ ms }) => ms);
  return out;
}

/** Default minimum gap between two full passes started by the in-flight ticker's retrigger; it never
 *  throttles the once-per-iteration call. Why: without a retrigger, a boot whose phase held the loop
 *  for its measured mean of 38.5 minutes got one full pass for that whole span (W1-T1272). Trap:
 *  this interval is itself a route into a concurrent pass that the wall-clock bound does not cover,
 *  so {@link SweepLiveness} excludes the duplicate (W1-T2582). Forensics: docs/forensics/daemon.md. */
export const DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS = 20 * 60_000;

/** BACKSTOP: no-history fallback (W1-T5761); measured run lengths govern later phases (W1-T7697). */
export const DISPATCH_PHASE_REFILL_BOUND_MS = 20 * 60_000;

/** One measured run: its task (when the start row names one) and its length. */
export interface MeasuredRun { taskId?: string; ms: number }

/** Pair starts and verdicts by run id; missing, torn or non-positive measurements contribute nothing. Each
 *  measured run is also appended to `runs` when given, so a caller can read per-task lengths (W1-T8514). */
export function dispatchRunHistory(rawLines: readonly string[], runs?: MeasuredRun[]): { totalMs: number; samples: number } {
  const starts = new Map<string, { at: number; taskId?: string }>();
  let totalMs = 0;
  let samples = 0;
  for (const raw of rawLines) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw); } catch (error) { /* a torn ledger row supplies no measurement */ continue; }
    if (!row || typeof row.run_id !== "string" || typeof row.ts !== "string") continue;
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at)) continue;
    if (row.step === "run.start") starts.set(row.run_id, { at, taskId: typeof row.task_id === "string" ? row.task_id : undefined });
    if (row.step !== "verdict") continue;
    const start = starts.get(row.run_id);
    starts.delete(row.run_id);
    if (start === undefined || at <= start.at) continue;
    totalMs += at - start.at;
    samples++;
    runs?.push({ ...(start.taskId !== undefined ? { taskId: start.taskId } : {}), ms: at - start.at });
  }
  return { totalMs, samples };
}

/** W1-T8172: the median review run length, `sweep.review_started` to the next `review.posted` for the same PR, or
 *  undefined with no pair. Torn rows and unpaired or reversed ends contribute nothing. */
export function medianReviewRunMs(rawLines: readonly string[]): number | undefined {
  const started = new Map<number, number>();
  const lengths: number[] = [];
  for (const raw of rawLines) {
    if (!raw.includes('"sweep.review_started"') && !raw.includes('"review.posted"')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw); } catch (error) { /* a torn ledger row supplies no measurement */ continue; }
    const at = typeof row?.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at)) continue;
    if (row.step === "sweep.review_started" && typeof row.pr_number === "number") started.set(row.pr_number, at);
    const pr = row.step === "review.posted" && typeof row.pr_url === "string" ? Number(/\/pull\/(\d+)$/.exec(row.pr_url)?.[1]) : NaN;
    const startedAt = started.get(pr);
    if (startedAt === undefined) continue;
    started.delete(pr);
    if (at > startedAt) lengths.push(at - startedAt);
  }
  return medianOf(lengths);
}

function medianOf(lengths: number[]): number | undefined {
  if (lengths.length === 0) return undefined;
  lengths.sort((a, b) => a - b);
  const mid = lengths.length >> 1;
  return lengths.length % 2 === 1 ? lengths[mid] : (lengths[mid - 1]! + lengths[mid]!) / 2;
}

/** W1-T9808: the median fix round length, from its start (the `fix.dispatch` row less its spawn's `elapsed_ms`) to
 *  the `fix.done` row for the same round, or undefined with no pair. */
export function medianFixRoundMs(rawLines: readonly string[]): number | undefined {
  const started = new Map<string, number>();
  const lengths: number[] = [];
  for (const raw of rawLines) {
    if (!raw.includes('"fix.dispatch"') && !raw.includes('"fix.done"')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw); } catch (error) { /* a torn ledger row supplies no measurement */ continue; }
    const at = typeof row?.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || typeof row.round_id !== "string") continue;
    if (row.step === "fix.dispatch") started.set(row.round_id, at - (typeof row.elapsed_ms === "number" ? row.elapsed_ms : 0));
    const startedAt = row.step === "fix.done" ? started.get(row.round_id) : undefined;
    if (startedAt === undefined) continue;
    started.delete(row.round_id);
    if (at > startedAt) lengths.push(at - startedAt);
  }
  return medianOf(lengths);
}

type RestartEstimate = { ms: number | undefined; samples: number };
export type RestartWorkHistory = { yieldCost: RestartEstimate; remaining: ReadonlyMap<string, RestartEstimate> };
export const RESTART_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** W1-T8927: a seven-day sampling window, not a yield threshold; durations come only from completed observations. */
/** Read the restart comparison's complete recent corpus once at boot, including phases archived out of the live tail;
 *  it carries the settled full passes too, so the sweep-bound seed survives a restart (W1-T9632). */
export function readRestartHistoryLines(stateDir: string, nowMs = systemClock.now()): readonly string[] {
  const read = readLedgerUnionRecordsSync(stateDir, {
    refuseIncomplete: true, sinceTs: fixedClock(nowMs - RESTART_HISTORY_WINDOW_MS).iso(),
    rotationWindowMs: RESTART_HISTORY_WINDOW_MS,
    step: ["run.start", "verdict", "pr.opened", "run.phase", "recon.done", "implement.done", "implement.unfinished", "fallback_push.cause", SWEEP_SETTLED_STEP],
  });
  if (!read.ok) throw new Error(`restart history unreadable: ${[...read.unread, ...read.unclassified].join(", ")}`);
  return read.rows.map((row) => JSON.stringify(row));
}

export function restartWorkHistory(rawLines: readonly string[], nowMs: number): RestartWorkHistory {
  const since = nowMs - RESTART_HISTORY_WINDOW_MS;
  const rows: Array<{ row: Record<string, unknown>; at: number }> = [];
  for (const raw of new Set(rawLines)) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw); } catch (error) { /* a torn row is not a duration */ continue; }
    if (!row || typeof row.ts !== "string" || typeof row.run_id !== "string") continue;
    const at = Date.parse(row.ts);
    if (Number.isFinite(at) && at >= since && at <= nowMs) rows.push({ row, at });
  }
  rows.sort((a, b) => a.at - b.at);
  const yields = new Map<string, { at: number; run: string }>();
  const phases = new Map<string, Map<string, number>>();
  const gaps: number[] = [];
  const durations = new Map<string, number[]>();
  for (const { row, at } of rows) {
    const run = row.run_id as string;
    const task = typeof row.task_id === "string" ? row.task_id : undefined;
    if (row.step === "run.start" && task) {
      const yielded = yields.get(task);
      if (yielded && yielded.run !== run) {
        yields.delete(task);
        if (at > yielded.at) gaps.push(at - yielded.at);
      }
    }
    if (row.step === "verdict" && row.reason === "freshness_yield" && task) yields.set(task, { at, run });
    const phase = row.step === "run.phase" ? row.waiting_on
      : row.step === "recon.done" ? "implementing"
      : row.step === "implement.done" ? "preopen_gate"
      : row.step === "implement.unfinished" ? "checkpointed"
      : row.step === "fallback_push.cause" ? "pushing" : undefined;
    if (typeof phase === "string") {
      const observed = phases.get(run) ?? new Map<string, number>();
      if (!observed.has(phase)) observed.set(phase, at);
      phases.set(run, observed);
    }
    if (row.step === "pr.opened") {
      for (const [phase, startedAt] of phases.get(run) ?? []) {
        if (at <= startedAt) continue;
        const samples = durations.get(phase) ?? [];
        samples.push(at - startedAt);
        durations.set(phase, samples);
      }
      phases.delete(run);
    }
    if (row.step === "verdict") phases.delete(run);
  }
  const estimate = (values: number[]): RestartEstimate => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return { ms: values.length === 0 ? undefined : values.length % 2 ? values[middle]
      : (values[middle - 1] + values[middle]) / 2, samples: values.length };
  };
  return { yieldCost: estimate(gaps), remaining: new Map([...durations].map(([phase, values]) => [phase, estimate(values)])) };
}

/** The step a pre-PR handoff writes beside its verdict, and the daemon re-writes for a receipt the live ledger
 *  holds only as a verdict row: verdicts keep the newest 200, so a parked checkpoint aged out of resumption. */
export const HANDOFF_RECEIPT_STEP = "run.freshness_handoff";
export const CHECKPOINT_HANDOFF_REASONS: ReadonlySet<string> = new Set(["freshness_yield", "quiet_worker_round_ended"]);

/** A pre-PR handoff's exact pushed head is resumable; any later verdict replaces that receipt, except a failed
 *  restore, which consumed nothing (W1-T7806). A matching checkpoint drop consumes the receipt;
 *  a `run.freshness_handoff` row is a receipt too (W1-T7747). W1-T8676: an `implement.checkpoint_kept` row,
 *  which run-task writes right after a worker-error verdict of the run that restored the checkpoint, re-pends
 *  the exact receipt that verdict consumed. A run refused before it could restore (a stale engine's lockfile,
 *  2026-10-17 W1-T9089) consumed nothing either; its verdict left the P1 run-branch-already-pushed for 5 h. */
export function pendingWorkerBoundaryHandoffs(rawLines: readonly string[]): Map<string, { branch: string; headSha: string }> {
  const pending = new Map<string, { branch: string; headSha: string }>();
  const resumable = (taskId: string, branch: unknown, headSha: unknown): branch is string =>
    typeof branch === "string" && branch.startsWith(`run-${taskId}-`) && /^run-.+-[0-9]+$/.test(branch) &&
    typeof headSha === "string" && /^[a-f0-9]{40}$/.test(headSha);
  for (const raw of rawLines) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw); } catch (error) { /* malformed rows establish no ownership */ continue; }
    if (!row || typeof row.task_id !== "string") continue;
    if (row.step === "implement.checkpoint_dropped") {
      const prior = pending.get(row.task_id);
      if (prior && row.source_branch === prior.branch && row.head_sha === prior.headSha) pending.delete(row.task_id);
      continue;
    }
    if (row.step === "implement.checkpoint_kept") {
      if (resumable(row.task_id, row.source_branch, row.head_sha)) pending.set(row.task_id, { branch: row.source_branch, headSha: String(row.head_sha) });
      continue;
    }
    const receipt = row.step === HANDOFF_RECEIPT_STEP ? row.waiting_on !== "pr" && row.waiting_on !== "ci"
      : row.step === "verdict" && row.verdict === "handed_off" && typeof row.reason === "string" &&
        CHECKPOINT_HANDOFF_REASONS.has(row.reason) && !row.pr_url;
    if (row.step !== "verdict" && !receipt) continue;
    if (row.verdict === "no_pr" && row.reason === "restart_checkpoint_restore_failed") continue;
    if (row.step === "verdict" && typeof row.stage === "string" && PRE_RESTORE_RUN_VERDICT_STAGES.has(row.stage)) continue;
    pending.delete(row.task_id);
    if (receipt && resumable(row.task_id, row.branch, row.head_sha)) {
      pending.set(row.task_id, { branch: row.branch, headSha: String(row.head_sha) });
    }
  }
  return pending;
}

/** The pending receipts whose only live record is a verdict row — what the daemon re-writes at boot. */
export function handoffReceiptsToCarry(rawLines: readonly string[]): Array<[string, { branch: string; headSha: string }]> {
  const recorded = new Set<string>();
  for (const raw of rawLines) {
    if (!raw.includes(HANDOFF_RECEIPT_STEP)) continue;
    try {
      const row = JSON.parse(raw) as Record<string, unknown>;
      if (row?.step === HANDOFF_RECEIPT_STEP) recorded.add(`${String(row.task_id)}|${String(row.branch)}|${String(row.head_sha)}`);
    } catch (error) { /* a torn row records nothing */ continue; }
  }
  return [...pendingWorkerBoundaryHandoffs(rawLines)].filter(([taskId, r]) => !recorded.has(`${taskId}|${r.branch}|${r.headSha}`));
}

/** W1-T5720 — BACKSTOP: the longest tick 1's cadences and the garden fan-out wait, from boot, for the
 *  first full pass. That pass's own 559 s bound normally opens the gate first, so this fires never. */
export const BOOT_CADENCE_GATE_BOUND_MS = 10 * 60_000;

/** W1-T9119: the decompressed bytes the retro check's ledger read would open, and the rotations behind the figure. */
export interface RetroReadProjection { projectedBytes: number; rotations: number; undigested: number; unreadable?: string[] }

/** W1-T9119: the reads a `checkRetroTrigger` may carry as properties (see buildRetroDaemonHooks); `deps` fields win. */
export interface RetroCheckCompanions {
  projectRetroReadCost?: () => Promise<RetroReadProjection>;
  readRetroHistory?: () => Promise<{ retroTriggeredAtMs: number[]; fallbackIntervalMs: number }>;
}

/** W1-T9119: the retro's recent `retro_triggered` gaps considered when learning its expected interval. */
const RETRO_INTERVAL_SAMPLE = 8;

/** W1-T9119: one run of consecutive retro deferrals of one reason class. */
interface RetroDeferralEpisode {
  reasonClass: string;
  firstAtMs: number;
  lastAtMs: number;
  observations: number;
  gapsMs: number[];
  named: boolean;
}

/** W1-T5720: the tick-1 rungs the boot gate holds, by their deps key, each ledgered when deferred. */
const BOOT_GATED_CADENCES = [
  "sweepOrphans", "sweepFeedbackLanding", "checkGithubPosture", "checkMeasurementCadence", "checkDigestCadence",
  "checkLedgerCompaction", "checkBenchmarkCohort", "checkCiLearningCadence", "checkBoardReview", "checkIntakeRungs",
  "checkRetroTrigger", "checkWipeTestCadence", "checkAutoTriage",
] as const satisfies ReadonlyArray<keyof DaemonDeps>;

/** The exit code a freshness self-restart uses, distinct from a crash's 1 (W1-T490). 75 is
 *  `EX_TEMPFAIL` from sysexits(3), which is what a stale stop is: nothing is wrong, the process
 *  needs newer code. Trap: the value is duplicated in `deploy/entrypoint.sh`, which cannot import
 *  this module. Falsifier: `test/entrypoint-boot.test.ts` fails if the two disagree. Forensics: docs/forensics/daemon.md. */
export const DAEMON_EXIT_STALE = 75;

/** The exit code for a completed pass reporting a blocked task, which is news rather than a crash
 *  (W1-T2537). `error` keeps 1 so a genuine crash stays countable against docker's restart budget.
 *  Why: a red board is what produces blocked passes, so the budget was spent fastest when the fleet
 *  was most needed — measured 2026-08-30, 46 minutes exited. Forensics: docs/forensics/daemon.md. */
export const DAEMON_EXIT_BLOCKED = 76;

/** The exit code for a pass killed by an environmental refusal, a third thing that is not a crash (W1-T2546). The
 * decision is delegated to `classifyFailure`, this repo's one failure classifier, so a reworded provider message is a
 * one-place fix and this can only ever narrow what counts as a crash. Forensics: docs/forensics/daemon.md. */
export const DAEMON_EXIT_ENVIRONMENTAL = 77;

/** A positively empty dedicated queue hands control to the zero-token shell supervisor. */
export const DAEMON_EXIT_IDLE_STARVED = 78;

/** W1-T3335 — the share of V8's OWN reported heap limit at which restarting beats continuing.
 *  Deliberately a fraction, not a byte count: the limit comes from NODE_OPTIONS and any literal
 *  here would drift out of agreement with it the moment that changed. 0.75 leaves a quarter of the
 *  heap as headroom for the tick that discovers the pressure, which must itself allocate to log
 *  and return. Forensics: docs/forensics/daemon.md. */
export const HEAP_PRESSURE_RESTART_FRACTION = 0.75;

/**
 * W1-T3335 — is the heap far enough along that restarting beats continuing? Pure, so the arm can be
 * falsified without allocating anything: the loop supplies the numbers and this decides.
 *
 * Returns the operator-facing detail when it is time to go, `undefined` when it is not. A
 * non-positive or non-finite limit answers `undefined` — an unreadable limit is NOT pressure, and
 * failing the other way would restart the daemon forever on a host whose V8 reported nothing.
 */
export function heapPressureDetail(
  stats: { used_heap_size: number; heap_size_limit: number },
  fraction: number = HEAP_PRESSURE_RESTART_FRACTION,
): string | undefined {
  const { used_heap_size: used, heap_size_limit: limit } = stats;
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return undefined;
  const usedFraction = used / limit;
  if (usedFraction < fraction) return undefined;
  return (
    `heap at ${Math.round(usedFraction * 100)}% of V8's ${Math.round(limit / 1e6)} MB limit ` +
    `(${Math.round(used / 1e6)} MB used) — restarting at a tick boundary rather than aborting mid-pass`
  );
}

/** V8's live heap accounting. A function rather than an import binding so the daemon's deps can
 *  substitute it without a module mock (Rule 18). */
export function v8HeapStatistics(): { used_heap_size: number; heap_size_limit: number } {
  const s = getHeapStatistics();
  return { used_heap_size: s.used_heap_size, heap_size_limit: s.heap_size_limit };
}

/** The pure stop-reason to exit-code mapping, extracted so it is unit-testable with no process spawn
 *  (operator ruling, 2026-07-21; Rule 18). Deliberate exits map to 0; every other reason is non-zero
 *  so a supervisor restarts. Trap: neither headroom exhaustion nor pause may reach this function —
 *  each would map to silence or to a relaunch storm (see {@link DaemonStopReason}). Why `stale` has
 *  its own code: docker counts every non-zero exit and cannot read the value, so routine restarts
 *  spent the crash budget and a 2h56m outage followed (W1-T490). Forensics: docs/forensics/daemon.md. */
export function daemonExitCode(stopReason: DaemonStopReason): number {
  if (stopReason === "stopped" || stopReason === "max_reached") return 0;
  if (stopReason === "stale") return DAEMON_EXIT_STALE;
  // W1-T3335: heap pressure maps to the SAME code as `stale` on purpose. Both mean "restart me now,
  // this is not a crash", and the entrypoint's non-crash arm for 75 already does exactly the right
  // thing — 5s pause, re-sync, docker's budget untouched. A distinct code would be more honest in
  // the ENTRYPOINT's log line (it will say "freshness") but needs an entrypoint arm, and that is a
  // Dockerfile/entrypoint change requiring an IMAGE REBUILD, which no self-sync delivers. The
  // daemon's own ledger row carries the true reason, so nothing is lost where it is read.
  if (stopReason === "heap_pressure") return DAEMON_EXIT_STALE;
  // `error` deliberately falls through to 1 below, so a genuine crash stays countable against
  // docker's on-failure budget exactly as it always was (W1-T2537).
  if (stopReason === "blocked") return DAEMON_EXIT_BLOCKED;
  if (stopReason === "idle_starved") return DAEMON_EXIT_IDLE_STARVED;
  return 1;
}

/** The exit code for a whole summary, which is what the real call site has and what
 *  {@link daemonExitCode} deliberately cannot see: the stop detail. A second function rather than a
 *  second parameter, because point-free callers would otherwise be handed an array index as a stop
 *  detail. Fail-closed: anything not positively transient stays `error` (W1-T2546). Forensics: docs/forensics/daemon.md. */
/**
 * W1-T3310 — THIS REPO'S OWN PRE-PUSH GATE, REFUSING. `hooks/pre-push` prints this banner at the
 * start of a line and exits non-zero; the push then fails and the task cannot proceed.
 *
 * NARROW AND ANCHORED ON PURPOSE. A bare `/REFUSED/` would catch a worker echoing the word, and an
 * unanchored match would catch this file's own prose quoted in a task's output. The banner is stable
 * text emitted by a checked-in hook, which is the strongest thing available to match on.
 */
/**
 * W1-T3319 — ONE TASK'S FAILURE, RECOGNISED STRUCTURALLY RATHER THAN BY A TOOL'S PROSE.
 *
 * `drain.ts`'s two worker-failure sites build `${taskId}: ${message}` — one wrapping
 * `deps.runOne` in a try/catch, one reporting a lane's recorded failure. The separate owned
 * admission/reporting-fault site includes a phase and may name `dispatch`, not a task.
 * That infrastructure failure must keep exit 1 rather than borrowing a worker's blocked code.
 * The worker prefix is a property of the EMITTER, not a guess about a tool's prose.
 *
 * THIS REPLACES W1-T3310's BANNER MATCH, which keyed on the pre-push hook's refusal text. That was
 * right about the case it saw and blind to the next one: the very next crash was a failed GitHub
 * check-runs read, which carries no such banner and exited 1 like all the rest. Matching the
 * emitter's own shape cannot drift when a tool rewords itself.
 *
 * EXPORTED FOR ITS OWN FIXTURE (negative-reachability-ratchet): a regex surface must be driven
 * directly with BOTH arms, because a pattern exercised only through a caller proves nothing about
 * where it STOPS — and stopping is the load-bearing arm here. If this matched an unprefixed detail,
 * a genuine crash would be reclassified as blocked and docker's budget would protect nothing.
 *
 * NARROW BY CONSTRUCTION, IN TWO WAYS, and the second was forced by an existing test rather than
 * chosen: the task-id prefix both worker sites emit, anchored at the start — not "anything with a colon" —
 * AND `Command failed: `, the shape a SPAWNED COMMAND's failure carries.
 *
 * WHY THE SECOND HALF EXISTS. W1-T2546's criterion 3 pins that an UNRECOGNISED failure still exits
 * as a crash, "so this can only ever NARROW what counts as one", and it drives that with
 * task-prefixed `TypeError` / `AssertionError` / `SyntaxError` details. A first draft of this rule
 * keyed on the task prefix alone and reclassified all three — which would have been wrong, not just
 * test-breaking: a TypeError inside `runOne` is a defect in RMD ITSELF and will recur on every task,
 * which is precisely the "meaningful regression" the operator's ruling still reserves a stop for.
 * A spawned command failing is the task's problem; the daemon's own code throwing is the daemon's.
 * All five measured fleet crashes are `Command failed:` — a push and a GitHub read — so the narrow
 * rule covers every observed case and leaves the crash budget pointed at real defects.
 */
export const PER_TASK_FAILURE_RE = /^W\d+-T[0-9A-Za-z]+: Command failed: /;

/**
 * ONE TASK'S FAILURE IS NOT THE DAEMON'S CRASH — the fourth instance of one pattern (W1-T490's
 * stale restart, W1-T2537's blocked pass, W1-T2546's environmental refusal, W1-T3310's gate
 * refusal), and now the GENERAL case rather than another special one.
 *
 * MEASURED on the fleet host 2026-09-10: three `exited 1`, three `pre-push REFUSED`, three
 * `test-tier-manifest: 1 test file` — a 1:1:1 correspondence — against `RestartPolicy=on-failure:5`.
 * The daemon dispatched normally between each exit. At five, docker stops restarting and the fleet
 * stays down behind a green board.
 *
 * IT IS BLOCKED, NOT A FIFTH CODE: the task genuinely cannot proceed and must be reported, which is
 * exactly what {@link DAEMON_EXIT_BLOCKED} already means — and `deploy/entrypoint.sh` already
 * retries 76 on the right pause. A fifth code would need a matching entrypoint arm, and that file is
 * IMAGE-BAKED: it would sit inert until a rebuild while the fleet is one restart from stopping.
 *
 * THIS BOUNDS THE CRASH BUDGET, IT DOES NOT DELETE IT. Exits 75/76/77 each get a bounded
 * in-container retry (100 attempts) before falling through to the throttle and a real docker
 * restart. A genuinely broken daemon still reaches docker — after 100 bounded attempts instead of on
 * the first task that trips a tool. A new code would need a new meaning.
 *
 * ORDER IS LOAD-BEARING. The transient check runs FIRST and keeps precedence, so a push that failed
 * on a network fault or a rate limit is still environmental (77) even if a gate banner is somewhere
 * in the same buffer. Fail-closed is unchanged: text matching neither stays `error` → 1, because a
 * push can fail for reasons that ARE crashes — a dead credential, a non-fast-forward — and mapping
 * every push failure to 76 would hide a real credential outage as "blocked".
 */
export function daemonExitCodeForSummary(summary: Pick<DaemonSummary, "stopReason" | "stopDetail">): number {
  if (summary.stopReason !== "error") return daemonExitCode(summary.stopReason);
  const detail = summary.stopDetail;
  if (detail !== undefined && classifyFailure({ text: detail }) === "transient") return DAEMON_EXIT_ENVIRONMENTAL;
  if (detail !== undefined && PER_TASK_FAILURE_RE.test(detail)) return DAEMON_EXIT_BLOCKED;
  return daemonExitCode(summary.stopReason);
}

/** One rung of the headroom ceiling's time-to-reset curve — policy data rather than a code
 *  constant (operator ruling, 2026-07-21, rule 2). Ordered narrowest bound first;
 *  {@link resolveHeadroomLimitPct} picks the first rung covering a window's hours-to-reset. */
export interface HeadroomPolicyRule {
  /** This rung applies when hours-to-reset is <= this bound. */
  maxHoursToReset: number;
  /** The ceiling (percent used) that binds under this rung. */
  limitPct: number;
}

/** A time-to-reset → ceiling curve, DATA rather than a single constant. */
export type HeadroomPolicy = HeadroomPolicyRule[];

/** The default curve: inside a window's final day the ceiling relaxes to 100%, because headroom
 *  unspent at reset is destroyed; every other day it holds at the operator reserve. Why: on
 *  2026-07-20 the fleet parked about 98 minutes over 56 consecutive exhausted stops, protecting
 *  headroom that expired at the midnight reset regardless (operator ruling, 2026-07-21). The live
 *  curve is `plan/policy.yaml`'s; this literal is the fs-free fallback (W1-T253). Forensics: docs/forensics/daemon.md. */
export function buildDefaultHeadroomPolicy(holdLimitPct: number = HEADROOM_LIMIT_PCT): HeadroomPolicy {
  return [
    { maxHoursToReset: 24, limitPct: 100 },
    { maxHoursToReset: Infinity, limitPct: holdLimitPct },
  ];
}

/** Resolve the ceiling that binds for a window `hoursToReset` away. A null or non-finite
 *  hours-to-reset resolves to the last, widest rung: uncertainty is never read as "we must be in
 *  the final day", so the ceiling only relaxes on a confirmed close reset. */
export function resolveHeadroomLimitPct(hoursToReset: number | null, policy: HeadroomPolicy = buildDefaultHeadroomPolicy()): number {
  // A reset already in the past is upstream lag, and a negative hours-to-reset would select the laxer
  // rung. Past-dated and unknown-shaped are the same epistemic state, so they share the strict
  // fallback. Honest scope: hardening, not a live bug fix — the sole production caller's every branch
  // rolls forward, so this is unreachable today. Forensics: docs/forensics/daemon.md.
  if (hoursToReset === null || !Number.isFinite(hoursToReset) || hoursToReset < 0) {
    return policy[policy.length - 1]?.limitPct ?? HEADROOM_LIMIT_PCT;
  }
  const rule = policy.find((r) => hoursToReset <= r.maxHoursToReset);
  return rule?.limitPct ?? HEADROOM_LIMIT_PCT;
}

const MONTH_ABBRS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_ABBRS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** `h` in 1-12 + `ampm` ("am"/"pm") → 24-hour `h`, with the 12am/12pm fix-up. */
function to24Hour(h: number, ampm: string): number {
  const hour = h % 12;
  return /pm/i.test(ampm) ? hour + 12 : hour;
}

/** Best-effort parse of a free-form usage reset string into an absolute instant, resolved as the nearest instant at or
 * after `now`. Returns `null` when the text matches no recognised shape, and callers must treat `null` conservatively
 * and never throw: the numeric percent check stays the real safety gate. Recognised shapes, every one actually
 * observed: month-and-day with a clock time, with or without "at"; a bare clock time; a bare weekday name; and
 * ISO-8601 with an offset. The ISO form is additive — no human shape's regex accepts a `T` separator or an offset
 * suffix, so every shape that matched before still matches (W1-T482). */
const UNRECOGNISED_RESET_MAX_LEN = 200;

/** Every window a previous process already announced an unrecognised reset for. The ledger is the
 *  store, so no new state file exists. Keyed on `window`, not `raw`: a microsecond-precision reset
 *  defeats a raw key outright, so the bound never bound anything — measured 56-for-56 and
 *  335-for-335 fired, zero suppressed, on two independent ledgers (W1-T482). Forensics: docs/forensics/daemon.md. */
export function priorUnrecognisedResetStrings(lines: ReadonlyArray<Record<string, unknown>>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.step === "daemon.usage_reset_unrecognised" && typeof l.window === "string") out.add(l.window);
  }
  return out;
}

/** W1-T3691 — reconstructs `StaleReviewerRecurrenceState` across a process restart from the
 *  ledger's own history: the process that requested a freshness restart over a stale
 *  reviewer-code sha is a NEW process by the time it boots again, and its own in-memory streak
 *  went with it -- this is the only place that fact survives (design (v)'s falsifier: "restart
 *  again on an unchanged sha and the fourth test fails"). Takes RAW lines, the same shape
 *  `DaemonDeps.readLedgerLines` (W1-T3216) already threads, so no second ledger-reading contract
 *  is needed. A torn/unparseable line is skipped, never fatal -- the same tolerance
 *  `readLedgerLines` itself documents. Scans the WHOLE ledger, same cost profile as
 *  `priorUnrecognisedResetStrings` above. */
export function priorStaleReviewerRecurrenceState(rawLedgerLines: readonly string[]): StaleReviewerRecurrenceState | undefined {
  let requestedForSha: string | undefined;
  for (const raw of rawLedgerLines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // torn/malformed line — skip it, never take out the whole read (same discipline as
      // readLedgerLines' own "torn" handling, run-task.ts's readQuestionsNdjson).
      continue;
    }
    if (row.step === "review.stale_reviewer_restart_requested" && typeof row.code_sha === "string") {
      requestedForSha = row.code_sha;
    }
  }
  return requestedForSha === undefined ? undefined : { codeSha: requestedForSha, streak: 1, restartRequested: true };
}

/** W1-T9124 — which of a completed pass's open PRs had their body edited with no new head since their last
 *  delivered verdict. Reads the ledger through the SAME `DaemonDeps.readLedgerLines` seam; a torn line is skipped,
 *  as {@link priorStaleReviewerRecurrenceState} does. Empty when the pass reported no PR views. */
export function staleBodyFindingsForTick(
  views: readonly StaleBodyPrView[] | undefined,
  readLedgerLines: (() => readonly string[]) | undefined,
): StaleBodyFinding[] {
  if (!views || views.length === 0 || !readLedgerLines) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of readLedgerLines()) {
    try {
      rows.push(JSON.parse(raw) as Record<string, unknown>);
    } catch (e) {
      // torn/malformed line: skipped so one bad row cannot blind the detector to the rest of the ledger
      void e;
    }
  }
  return detectStaleBody(views, rows);
}

/** W1-T5476 — the terminal verdicts `postReviewStatusGuarded` withheld for stale reviewer code at or after
 *  `sinceMs`, read through `DaemonDeps.readLedgerLines`: review subprocesses write the refusals, so the ledger
 *  is the only place this process sees them. A torn line is counted, and a failed read is its own outcome.
 *  W1-T5530 DECISION: a refusal whose freshness is "unreadable" is counted apart and adds NO restart pressure.
 *  All 12 distinct ones in the live ledger (09-20..09-30) were `git fetch origin failed`: ref-lock races on the
 *  shared .git, or a reflog it could not append to. A restart fixes neither, so `unreadable` stays off the bound. */
export function withheldReviewsSince(
  readLedgerLines: () => readonly string[],
  sinceMs: number,
): { kind: "counted"; withheld: number; unreadable: number; unparseable: number } | { kind: "unreadable"; error: string } {
  let rawLedgerLines: readonly string[];
  try {
    rawLedgerLines = readLedgerLines();
  } catch (error) {
    return { kind: "unreadable", error: String((error as Error)?.message ?? error) };
  }
  let withheld = 0;
  let unreadable = 0;
  let unparseable = 0;
  for (const raw of rawLedgerLines) {
    if (!raw.includes('"review.post_refused"')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A torn refusal line is counted, so the decision row names it instead of reading it as none.
      unparseable++;
      continue;
    }
    if (row.step !== "review.post_refused" || !(typeof row.ts === "string" && Date.parse(row.ts) >= sinceMs)) continue;
    if (row.reviewer_code_freshness === "stale") withheld++;
    else if (row.reviewer_code_freshness === "unreadable") unreadable++;
  }
  return { kind: "counted", withheld, unreadable, unparseable };
}

/** W1-T5344 — the first park after one task's delivery failure. Policy (design): long enough that
 *  the next tick does not re-pick a task whose push a gate just refused, short enough that a fix
 *  merged meanwhile is picked up within the hour. Forensics: docs/forensics/daemon.md. */
export const LANE_DELIVERY_BACKOFF_FLOOR_MS = 30 * 60_000;

/** W1-T5344 — BACKSTOP: the ceiling the doubling park stops at. It binds only once a task has
 *  already failed delivery five times running, so a task that fails every attempt is still
 *  re-offered a few times a day rather than never. */
export const LANE_DELIVERY_BACKOFF_CEILING_MS = 6 * 60 * 60_000;

/** W1-T5344 — the park for the Nth consecutive delivery failure of one task: the floor, doubled per
 *  repeat, held at the ceiling. A non-positive streak is floored to the first rung. */
export function laneDeliveryBackoffMs(consecutive: number): number {
  const rung = Math.max(1, Math.floor(consecutive));
  return Math.min(LANE_DELIVERY_BACKOFF_FLOOR_MS * 2 ** (rung - 1), LANE_DELIVERY_BACKOFF_CEILING_MS);
}

/** W1-T5344 — one task's delivery-failure park: its consecutive streak, the instant it may be
 *  offered again, and the shard revision it failed on (a new revision clears the park). */
export interface LaneDeliveryPark {
  consecutive: number;
  parkedUntilMs: number;
  revision: string | undefined;
}

/** W1-T5344 — rebuilds the per-task delivery parks across a restart from the `daemon.lane_failed`
 *  rows this process family wrote, so a boot neither re-dispatches a parked task at once (the loop
 *  that ended the process four times in a row for W1-T3116) nor resets its streak. A later
 *  `dispatch.settled_set` that FULFILLED the task ends its streak. A torn line or a row missing a
 *  numeric streak/instant is skipped, never guessed at. Same raw-line contract as
 *  {@link priorStaleReviewerRecurrenceState}. */
export function priorLaneDeliveryParks(rawLedgerLines: readonly string[]): Map<string, LaneDeliveryPark> {
  const parks = new Map<string, LaneDeliveryPark>();
  for (const raw of rawLedgerLines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // torn/malformed line — skipped, exactly as priorStaleReviewerRecurrenceState above skips it
      continue;
    }
    if (row.step === "dispatch.settled_set" && Array.isArray(row.tasks)) {
      for (const lane of row.tasks as Array<{ id?: unknown; status?: unknown }>) {
        if (typeof lane?.id === "string" && lane.status === "fulfilled") parks.delete(lane.id);
      }
      continue;
    }
    if (row.step !== "daemon.lane_failed" || typeof row.task !== "string") continue;
    if (typeof row.consecutive !== "number" || typeof row.parked_until_ms !== "number") continue;
    parks.set(row.task, {
      consecutive: row.consecutive,
      parkedUntilMs: row.parked_until_ms,
      revision: typeof row.revision === "string" ? row.revision : undefined,
    });
  }
  return parks;
}

export function parseResetInstant(raw: string, now: Date): Date | null {
  const text = raw.trim();

  const monthDay = /^([A-Za-z]{3,9})\s+(\d{1,2})\s*(?:,|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (monthDay) {
    const monthIdx = MONTH_ABBRS.indexOf(monthDay[1].slice(0, 3).toLowerCase());
    if (monthIdx === -1) return null;
    const day = Number(monthDay[2]);
    const hour = to24Hour(Number(monthDay[3]), monthDay[5]);
    const minute = monthDay[4] ? Number(monthDay[4]) : 0;
    const year = now.getFullYear();
    let candidate = new Date(year, monthIdx, day, hour, minute, 0, 0);
    if (candidate.getTime() < now.getTime()) candidate = new Date(year + 1, monthIdx, day, hour, minute, 0, 0);
    return candidate;
  }

  const timeOnly = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (timeOnly) {
    const hour = to24Hour(Number(timeOnly[1]), timeOnly[3]);
    const minute = timeOnly[2] ? Number(timeOnly[2]) : 0;
    let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    // Roll to "tomorrow, same wall-clock time" via the LOCAL CALENDAR (day + 1
    // in the Date constructor, which normalizes month/year overflow itself),
    // never by adding 24h in milliseconds: a fixed-ms roll crosses a DST
    // transition an hour off (e.g. spring-forward turns "3pm" into 4pm local
    // the next day). The calendar constructor re-resolves the wall-clock
    // fields against whatever UTC offset the target date actually has.
    if (candidate.getTime() < now.getTime()) {
      candidate = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + 1, hour, minute, 0, 0);
    }
    return candidate;
  }

  const weekday = /^(sun(day)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?)$/i.exec(text);
  if (weekday) {
    const target = WEEKDAY_ABBRS.indexOf(text.slice(0, 3).toLowerCase());
    if (target === -1) return null;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    let deltaDays = (target - startOfToday.getDay() + 7) % 7;
    // A bare weekday matching TODAY, with no time of day given, is read as NEXT week's occurrence, not "already
    // underway" — the conservative (larger hours-to-reset, never-relax-on-ambiguity) reading.
    if (deltaDays === 0) deltaDays = 7;
    return new Date(startOfToday.getTime() + deltaDays * 24 * 3_600_000);
  }

  // A strict shape check first, never handing the text straight to `Date.parse`: that accepts a
  // wide, engine-dependent grab-bag of non-ISO strings, and this function's `null` contract is
  // load-bearing for the conservative fallback in `resolveHeadroomLimitPct`.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (iso) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

/** Round an instant to the nearest hour. The upstream has phrased the same intended reset two ways a
 *  minute apart across consecutive boots ("Jul 21 at 12am" versus "Jul 20 at 11:59pm"), and sub-hour
 *  jitter is meaningless for these windows, so rounding it away is what makes the two render alike. */
export function canonicalizeResetInstant(d: Date): Date {
  const hourMs = 3_600_000;
  return new Date(Math.round(d.getTime() / hourMs) * hourMs);
}

/** Canonical rendering of a resolved reset instant as a fixed UTC ISO string, so the same instant
 *  renders identically on every boot however the upstream phrased it. Used for logging and
 *  display; the raw `UsageWindow.resetsAt` is untouched everywhere else. */
export function formatResetInstant(d: Date): string {
  return canonicalizeResetInstant(d).toISOString();
}

/** One window's headroom reading, resolved against the time-aware ceiling. */
interface ResolvedWindow {
  window: string;
  percentUsed: number;
  resetsAt: string;
  /** Canonical rendering of the parsed reset instant, or the raw string when unparseable. */
  resetsAtDisplay: string;
  limitPct: number;
}

/** The daemon's own per-window headroom resolution, applying the time-aware ceiling per window because
 *  a session window and a weekly cap reset on different clocks. Returns every window most-burned
 *  first, so telemetry and enforcement share one resolution. Not `headroom.ts`'s flat predicate. */
function resolveHeadroomWindows(
  snap: UsageSnapshot,
  now: Date,
  policy: HeadroomPolicy,
  /** Called for state (b) only — a reset clause was present and unrecognised. Appended last and optional, so no
   * existing caller shifts. Emission lives at the call site rather than inside `parseResetInstant`, whose purity is
   * why it is testable and why it must not learn about ledgers. */
  onUnrecognisedReset?: (window: string, raw: string) => void,
): ResolvedWindow[] {
  // `resetsAt` is OPTIONAL on a `UsageWindow` (headroom.ts): the CLI emits weekly lines with no
  // `· resets …` clause at all. Carried through as possibly-absent rather than coerced here, so
  // the two distinct cases below stay distinguishable.
  const windows: Array<{ window: string; percentUsed: number; resetsAt?: string }> = [
    { window: "session (5h)", percentUsed: snap.session.percentUsed, resetsAt: snap.session.resetsAt },
    ...snap.weekly.map((w) => ({ window: `weekly (${w.label})`, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
  ];
  return windows
    .map((w) => {
      // Three states, and the ceiling treats the last two identically on purpose:
      //   (a) reset present and parseable   -> a real hoursToReset; the time-aware curve applies.
      //   (b) reset present but unparseable -> null, per parseResetInstant's own contract.
      //   (c) reset absent entirely         -> null, without calling parseResetInstant at all.
      // A null takes the strict reserve, never the relaxed final-day rung, so a window whose reset we do
      // not know is held to the stricter ceiling. Absent is explicit here, not accidental.
      const instant = w.resetsAt !== undefined ? parseResetInstant(w.resetsAt, now) : null;
        // State (b) only. An absent clause is the normal shape for a weekly line and must never fire
        // this: recon-FH measured 184 legitimate "unknown" sentinels against 56 raw passthroughs. The two
        // are separable only here — four lines down the distinction collapses into the sentinel.
        if (w.resetsAt !== undefined && instant === null) onUnrecognisedReset?.(w.window, w.resetsAt);
      const hoursToReset = instant ? (instant.getTime() - now.getTime()) / 3_600_000 : null;
      return {
        ...w,
        // The sentinel is applied HERE, at the one render/record boundary, so `resets_at` on the
        // ledger line and the escalation issue read "unknown" rather than the word "undefined".
        resetsAt: w.resetsAt ?? RESET_UNKNOWN,
        resetsAtDisplay: instant ? formatResetInstant(instant) : (w.resetsAt ?? RESET_UNKNOWN),
        limitPct: resolveHeadroomLimitPct(hoursToReset, policy),
      };
    })
    .sort((a, b) => b.percentUsed - a.percentUsed); // most-burned first
}

/** Default: escalate to the same in-process idle heartbeat as a confirmed breach after this many
 *  consecutive unreadable usage reads. Bounded rather than immediate because recon R-7 found the
 *  read unavailable about 78% of the time, so failing closed on the first miss would halt the fleet
 *  most of the time. Resolves to {@link UNREADABLE_DEGRADED_LIMIT} so the drain and the daemon
 *  cannot drift apart (W1-T290). Forensics: docs/forensics/daemon.md. */
export const DEFAULT_UNREADABLE_DEGRADED_LIMIT = UNREADABLE_DEGRADED_LIMIT;

/** The park ceiling. Resolves to {@link DEPLOY_IDLE_DEFER_CEILING_MS} rather than re-spelling the number, because two
 * independent literals drift and one shared export cannot. The deploy supervisor already settled the argument: a
 * fleet that never goes idle still gets through after thirty minutes, ledgered as forced. */
export const HEADROOM_PARK_CEILING_MS = DEPLOY_IDLE_DEFER_CEILING_MS;

/** {@link evaluateHeadroomPark}'s result — deliberately {@link evaluateIdleGate}'s shape. */
export interface HeadroomParkGate {
  /** Parked this tick: unreadable beyond the bounded allowance. */
  parked: boolean;
  /** May the daemon dispatch anyway, because the ceiling fired? */
  forced: boolean;
  /** How long this park episode has run; 0 when not parked or on its first tick. */
  waitedMs: number;
}

/** The park with a ceiling — the counterpart of {@link evaluateIdleGate}, same shape on purpose. Why:
 *  the degraded branch had no ceiling and no exit of its own, so a probe that cannot recover parked
 *  the fleet permanently about four minutes after boot while every liveness indicator stayed
 *  healthy. An undefined `parkedSinceMs` reads as a fresh park, so a caller that does not track the
 *  clock degrades to the old unbounded park. Forensics: docs/forensics/daemon.md. */
export function evaluateHeadroomPark(
  consecutiveUnreadable: number,
  degradedLimit: number,
  parkedSinceMs: number | undefined,
  nowMs: number,
  ceilingMs: number = HEADROOM_PARK_CEILING_MS,
): HeadroomParkGate {
  if (consecutiveUnreadable <= degradedLimit) return { parked: false, forced: false, waitedMs: 0 };
  const waitedMs = parkedSinceMs === undefined ? 0 : Math.max(0, nowMs - parkedSinceMs);
  return { parked: true, forced: waitedMs >= ceilingMs, waitedMs };
}

export interface DaemonOpts {
  /** 
   * Optional iteration cap (a bounded supervised run, or a test). Absent ⇒ unbounded — the real daemon runs until
   * STOP, a block, or headroom. */
  max?: number;
  /** Idle-poll pace in ms when nothing is currently runnable (default {@link DEFAULT_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /** The headroom governor switch (operator ruling fb-1784894405468-a4153e). When false, headroom is still read and
   * ledgered every cycle but never gates dispatch, and an unreadable read is absent telemetry rather than a hold.
   * Defaults true here and in the live entry's own resolution, so the library and an unconfigured install agree. */
  headroomEnabled?: boolean;
  /** At or above this percent on any window, on a day the ceiling holds, the loop idles in process.
   *  Ignored when `headroomPolicy` is also supplied — that curve wins outright. Threading this still
   *  builds a full {@link HeadroomPolicy} rather than a flat ceiling. */
  headroomLimitPct?: number;
  /** The time-to-reset to ceiling curve (policy data, rule 2). Supply a different curve here to
   *  retune the reserve without a source change. */
  headroomPolicy?: HeadroomPolicy;
  /** Consecutive unreadable usage reads allowed before the daemon escalates to the in-process idle
   *  heartbeat. A single successful read resets the count to zero. */
  unreadableDegradedLimit?: number;
  /** How long the governor may stay parked before dispatching blind for one tick. Injectable so the
   *  park is reachable in a test without a real thirty-minute wait. */
  headroomParkCeilingMs?: number;
  /** The spawn-infra backoff ceiling in ms: consecutive failures double the poll interval up to
   *  this cap. Policy data (rule 2), retunable without a source change (W1-T113). */
  maxSpawnInfraBackoffMs?: number;
  /** The cross-task API-window-hold ceiling in ms — the same doubling-capped shape
   *  `maxSpawnInfraBackoffMs` uses, for a different signal. Policy data (rule 2). See
   *  {@link reasonAboutApiWindow} for why task identity is the discriminator (W1-T2517). */
  maxApiWindowHoldMs?: number;
  /** How wide this tick's dispatch batch may be — `SweepPolicy.dispatchLanes` (policy data, rule 2),
   *  resolved by the real command, never re-derived here. Ships dark: default 1, which is also the
   *  floor, and at 1 the selection, callbacks and ordering are byte-identical to before this parameter
   *  existed. W1-T344 owns raising the row that flips it (W1-T343). Forensics: docs/forensics/daemon.md. */
  laneCount?: number;
  /** `SweepPolicy.wipLimit` (W1-T121), threaded through only to size a batch of two or more lanes, exactly as
   * `runDrainLanes` does. Distinct from `checkQueueGovernor`, which stops new dispatch outright for the whole tick;
   * this is how many lanes still fit under the ceiling right now. Without it a wide batch could overshoot by up to
   * `laneCount - 1` before the next tick caught it. Never consulted at one lane, whose budget is 1 unconditionally. */
  wipLimit?: number;
  /** The wall-clock bound in ms on the full reconciliation pass. Policy data (rule 2): the real entry threads the
   * policy value, never a literal at the call site. A pass still in flight after this many real ms is abandoned — the
   * tick ledgers it and returns control rather than awaiting forever. Why: a fix-rung worker's shell loop with no
   * exit condition parked the daemon up to 165 minutes (W1-T1044). W1-T9563: a full pass uses it only as the cold
   * start; once enough passes settle the bound is learned ({@link learnedSweepBound}). Review drains keep this value. */
  sweepWallClockBoundMs?: number;
  /** The minimum gap in ms between two retriggers fired while an in-flight ticker holds the loop.
   *  Distinct from the bound above, which limits how long any one pass may run; this limits how
   *  often a new one may start. Never consulted by the once-per-iteration call (W1-T1272). */
  sweepRetriggerIntervalMs?: number;
  /** W1-T5720: the boot gate's bound in real ms (default {@link BOOT_CADENCE_GATE_BOUND_MS}). */
  bootCadenceGateBoundMs?: number;
  /** How long a lifetime runs before a freshness restart may take it (default {@link FRESHNESS_MIN_LIFETIME_MS}, the
   *  operator ruling of 2026-10-17). A test of a different restart mechanic passes 0 to reach it at once. */
  freshnessMinLifetimeMs?: number;
}

/** A non-stale freshness verdict must name the decision arm that produced it. `unassessed` deliberately retains the
 * service status: `guarded` and `degraded` both decline a restart, but only the latter means the daemon could not
 * read its own freshness. The optional shape preserves existing injected test seams; the real service adapter always
 * supplies it (W1-T3756). */
export type DaemonFreshnessNotStale =
  | { arm: "unassessed"; serviceStatus: "guarded" | "degraded"; detail?: string }
  | { arm: "dirty"; oldSha?: string; newSha?: string; behind?: boolean; dirty_paths?: readonly string[];
      changes?: readonly DeployWorthChange[] }
  | { arm: "up_to_date" }
  | { arm: "immaterial"; oldSha: string; newSha: string; basis?: "closure" | "prefix"; outsideClosure?: number; closureUnreadable?: string };

/** The result of comparing this process's own boot sha against origin/main (W1-T126). `stale` carries the sha pair, so
 * the caller and the ledger line it drives name exactly what advanced. `installNeeded` means the pull also changed
 * the manifest or lockfile, so the install runs before the loop stops for restart, never after, and a stale
 * dependency tree never survives into the relaunched process (W1-T151). */
export type DaemonFreshness =
  | { stale: false; notStale?: DaemonFreshnessNotStale }
  | { stale: true; oldSha: string; newSha: string; installNeeded?: boolean; changes?: readonly DeployWorthChange[];
      /** The tree was behind before this reading could say so (a live edit held it, live-edit-ladder.ts). */
      staleSinceMs?: number };

/** W1-T5282 — the real wiring's reading is awaited, its `git fetch` off the loop; a sync reading stays sync. */
/** W1-T5723: start, adopt, restart or discard the cadence child; only its settle is detached. */
function startMeasurementCadenceChild(
  runner: MeasurementCadenceChildRunner,
  fire: boolean,
  reason: string | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
): void {
  let outcome: ReturnType<MeasurementCadenceChildRunner["start"]>;
  try {
    outcome = runner.start({ fire });
  } catch (e) {
    log("measurement_cadence.run_failed", { error: String((e as Error)?.message ?? e), flow: "child" });
    return;
  }
  if (outcome.kind === "none") return;
  log("measurement_cadence.child", {
    outcome: outcome.kind, run_id: outcome.runId, pid: outcome.pid, attempt: outcome.attempt, reason,
    previous_run_id: outcome.previous?.runId, previous_pid: outcome.previous?.pid,
    previous_rule: outcome.previous?.rule, previous_detail: outcome.previous?.detail, previous_cause: outcome.previous?.cause,
  });
  if (!outcome.settled) return;
  detachSweepAction(
    outcome.settled
      .then((result) => log("measurement_cadence.ran", buildMeasurementCadenceRow(result)))
      .catch((e) => log("measurement_cadence.run_failed", { error: String((e as Error)?.message ?? e), run_id: outcome.runId })),
    { actionKind: "measurement-cadence", taskId: "DAEMON" },
  );
}

function isPendingFreshness(read: DaemonFreshness | Promise<DaemonFreshness> | undefined): read is Promise<DaemonFreshness> {
  return read instanceof Promise;
}

/** W1-T3618 — a sweep pass's OWN report of a freshness discovery {@link DaemonDeps.checkFreshness}
 *  cannot see: reviewer-code freshness is read inside the sweep's review path, once per pass and
 *  before the first PR's worktree materializes, never by this module. When that read is stale the
 *  pass materializes and spends nothing on any review for the rest of its run and carries the sha
 *  pair here so the tick's pre-admission freshness re-check (below) can end the cycle through the
 *  SAME `stopForFreshness` path a `checkFreshness`-driven stale reading already uses — never a
 *  second, independently-worded restart. Absent (or `reviewerCodeStale` omitted) is the ordinary
 *  case and changes nothing: every existing caller that returns `void` still satisfies this type. */
export interface SweepCycleOutcome {
  reviewerCodeStale?: { oldSha: string; newSha: string };
  /** W1-T9124 — the review-input identity of each open PR THIS pass read, so the tick can ask
   *  {@link staleBodyFindingsForTick} which of them were edited without a push. Absent changes nothing. */
  reviewInputViews?: readonly StaleBodyPrView[];
  /** W1-T4002 — the bounded set of CURRENT plan-only filing receipts THIS pass's full sweep
   *  positively proved (sweep.ts's `planOnlyRunBranchReceipts`, built from the SAME `OpenPrView[]`
   *  the sweep already read — no second GitHub call). Consulted by the tick's OWN dispatch-options
   *  builder below, in the SAME tick, so a raw pushed-run-branch guard can release the exact
   *  matching tip a proven plan-only filing occupies rather than blocking the real implementation
   *  forever. Absent/empty on a tick that ran no sweep (or proved no receipts) changes nothing:
   *  every observed run branch keeps blocking exactly as it did before this task. */
  planOnlyRunBranchReceipts?: readonly PlanOnlyRunBranchReceipt[];
}

/** The recoverable-class subset of an idle tick's dispatch-filter tally: the classes that could clear
 *  on their own, as opposed to already-merged, where the plan is done, or verify-not-auto, where
 *  waiting never helps. `retired` is carried but excluded from the starved verdict, since a retired
 *  task will never be built; it stays on the census so the count is legible (W1-T2474). Forensics: docs/forensics/daemon.md. */
export interface StarvationCensus {
  circuitBroken: IdleReasonBucket;
  blocked: IdleReasonBucket;
  unmetDeps: IdleReasonBucket;
  retired: IdleReasonBucket;
}

/** The cleared half of a starvation episode: which of the two sites in `runDaemon` ended it, so the escalation can be
 * closed with a reason rather than a bare "resolved". Only a dispatchable-task clear has a task to name. */
export interface StarvationClearedInfo {
  reason: "no-recoverable-blockers" | "dispatchable-task";
  /** Present only for `reason: "dispatchable-task"` — the task whose eligibility ended the episode. */
  taskId?: string;
}

/** Same shape/truncation discipline as {@link tallyDispatchFilters}'s own buckets, applied to
 *  the circuit-broken ids collected outside that tally (see {@link StarvationCensus}'s doc). */
function bucketFromIds(ids: readonly string[]): IdleReasonBucket {
  return { count: ids.length, ids: ids.slice(0, IDLE_REASON_ID_CAP), truncated: Math.max(0, ids.length - IDLE_REASON_ID_CAP) };
}

export interface DaemonSummary {
  attempted: string[];
  merged: string[];
  stopReason: DaemonStopReason;
  /** Human detail: the blocked task + verdict, the reset time, the error, etc. */
  stopDetail?: string;
  costUsd: number;
  /** Count of idle polls (no runnable task, so the loop slept and re-checked). */
  ticks: number;
  /** Reporting failures after settlement; not proof that a ledger receipt was delivered. */
  reportingFaults?: Array<{ phase: string; detail: string }>;
}

/** Injectable dependencies — the real command wires GitHub/run-task/usage/locks. */
/** Should the daemon poll security alerts on this tick (W1-T462)? The gap was cadence, not capability:
 *  the poller already read all three sources, but nothing scheduled it, and its step had two rows in
 *  the entire ledger corpus. Shaped after {@link decideAutoTriage} rather than a fourth clock. The
 *  idle gate is not decoration — a poll shells three API endpoints, and a dispatch tick is where the
 *  REST budget is under pressure. Forensics: docs/forensics/daemon.md. */
export interface AlertPollInputs {
  enabled: boolean;
  idle: boolean;
  now: Date;
  /** ISO of the last successful poll, or undefined if it has never run. */
  lastPollIso: string | undefined;
  minIntervalMinutes: number;
}

export interface AlertPollDecision {
  fire: boolean;
  reason: string;
}

export function decideAlertPoll(i: AlertPollInputs): AlertPollDecision {
  if (!i.enabled) return { fire: false, reason: "alert poll disabled (policy.alertPoll.enabled=false)" };
  if (!i.idle) return { fire: false, reason: "daemon is not idle" };
  if (i.lastPollIso === undefined) return { fire: true, reason: "no prior poll recorded — first run" };
  const last = Date.parse(i.lastPollIso);
  // An unparseable marker fails closed, as auto-triage does: firing on an unreadable timestamp
  // would poll every tick, which is the noise this gate exists to prevent.
  if (Number.isNaN(last)) return { fire: false, reason: "last poll timestamp unreadable — failing closed" };
  const sinceMin = (i.now.getTime() - last) / 60_000;
  if (sinceMin < i.minIntervalMinutes) {
    return { fire: false, reason: `polled ${sinceMin.toFixed(1)}m ago — under the ${i.minIntervalMinutes}m interval` };
  }
  return { fire: true, reason: `last poll ${sinceMin.toFixed(1)}m ago — interval elapsed` };
}

export type ReviewAdmissionGate = (() => boolean) & {
  workerAdmissionHold?: (kind?: "review") => string | undefined;
};

/** One pending "run this task now" kick. `repo` is set for a repo-scoped marker (W1-T429) and absent for a
 *  legacy/unscoped one; the binding hands this daemon only the kicks addressed to its own target (W1-T10615). */
export interface DaemonKick { taskId: string; origin: string; repo?: string }

/** A repo-scoped kick's ledger rows name its repo; an unscoped kick's rows stay byte-identical to before W1-T10615. */
function kickRepoField(kick: DaemonKick): { repo?: string } {
  return kick.repo === undefined ? {} : { repo: kick.repo };
}

export interface DaemonDeps {
  repositoryMaintenance?: (context: { activeLanes: number; disk: "healthy" | "low" | "unknown"; queueBusy: boolean }) => Promise<void>;
  /** Only a supervised dedicated daemon may exit into the shell's 30-minute zero-token probe. */
  idleStarvedSupervised?: boolean;
  /** Complete, readable target-repo PR board count; undefined or throw means unknown, never empty. */
  confirmedOpenPrCount?: () => number | undefined;
  buildDispatchValueContext?: (plan: Plan, isMerged: MergedSet) => DispatchValueContext | undefined;
  /** W1-T3216 — the ledger's RAW lines, for {@link resolveReleasedIds}: a console KICK for an
   *  operator-released `verify: human` task must be admitted here too, or the release works from
   *  the drain and is refused from the console. Same seam and same contract as `DrainDeps`'s.
   *  ABSENT = today's behaviour exactly, an empty released set. */
  readLedgerLines?: () => readonly string[];
  /** W1-T10348 — the operator releases kept in state/operator-releases.json, which ledger rotation cannot
   *  shed. Read with `readLedgerLines` once per tick by the shared release resolver. Absent = ledger only. */
  readDurableReleases?: () => ReleaseEvidence;
  /** Complete archive union for the boot-time restart estimates and sweep-bound seed (W1-T9632); unreadable disables holdouts. */
  readRestartHistory?: () => readonly string[];
  /** Re-read the plan from the same source the boot used, returning the fresh plan or `null` when
   *  nothing changed; omitted means the plan stays frozen at boot. The dep owns change detection
   *  because the cheap signal is caller-specific: a plan tree sha costs ~8ms, the parse ~60ms (impl-FZ). */
  reloadPlan?: () => Plan | null | Promise<Plan | null>;
  /** Fresh merged predicate each call (re-derived from GitHub between iterations). */
  refreshMerged: (plan?: Plan) => MergedSet;
  refreshMergedAsync?: (plan?: Plan) => Promise<MergedSet>;
  readLoopTelemetry?: (() => { loop_delay_max_ms: number; loop_delay_p99_ms: number; sync_spawn_ms: number;
    sync_spawn_top?: unknown[] }) & { takeLagInterval?: (consumer?: string) => { top: unknown; sync_spawn_ms: number;
      by_caller?: unknown[]; unnamed_ms?: number; // W1-T9577: the interval's callers by total, and the rest
      async_spawn_sync_ms?: number; async_by_caller?: unknown[] }; // W1-T9754: the async spawns' fork time
    /** W1-T7746: each tick's lag, the history the loop-stall profiler's bound is a quantile of. */
    observeLoopLag?: (reading: { lagMs: number; intervalMs: number }, log: (step: string, extra?: Record<string, unknown>) => void) => void };
  /** W1-T6782: flat, payload-free memory fields (`sampleDaemonMemory`, daemon-memory-telemetry.ts)
   *  spread into the existing `daemon.alive` row. A throw is carried as `mem_telemetry`, never lost.
   *  W1-T7092: `afterRow` starts the worker-thread heap read once the row is written; the tick never
   *  awaits it, and the NEXT row's fields carry what it found. */
  readMemoryTelemetry?: (() => Record<string, unknown>) & { afterRow?: () => void };
  /** W1-T8883: the heap-ceiling shadow's heap reading and process id; absent, this process's own. A test seam. */
  heapShadowSeams?: Pick<HeapShadowOptions, "snapshot" | "pid">;
  lastStepBeforeBlock?: () => string | undefined;
  /** Rebind daemon-owned sweep/projection closures when the live plan reloads. */
  onPlanReload?: (plan: Plan) => void;
  /** The in-flight guard: the open PR number for a task, re-derived from the same projection `refreshMerged` just
   * built, never a second read path. Optional (W1-T80, the #143/#145 duplicate-build race). */
  isOpenPr?: OpenPrCheck;
  /** The credit-read-failed probe, resolved by the caller from the same projection, exactly as
   *  `isOpenPr` is. See {@link NextRunnableOpts.isCreditIndeterminate} for why an unmerged reading
   *  carrying `indeterminate` must refuse rather than dispatch. Optional (W1-T2675). */
  isCreditIndeterminate?: (taskId: string) => boolean;
  /** The repo this daemon targets, forwarded into the tick's opts so eligibility can refuse a task belonging to
   * another repo. Optional: omitted, the guard does not fire and every existing caller is byte-identical. A guard
   * that defaults to refusing is the shape that stops the fleet (W1-T988). */
  targetRepo?: string;
  /** The open-sibling observation's two halves, forwarded into this tick's {@link NextRunnableOpts}; see
   *  those fields' docs in drain.ts. This is the lane that dispatches: measured over the ledger union,
   *  347 boots and 558 run starts against 16 drain starts. Trap: never fold these into `isOpenPr`. */
  openSiblingBuildFor?: NextRunnableOpts["openSiblingBuildFor"];
  onOpenSiblingBuild?: NextRunnableOpts["onOpenSiblingBuild"];
  /** An optional fresh, live re-read of one candidate in-flight PR's state, consulted only when
   *  `isOpenPr` reports a task in-flight. See drain.ts's `readLiveState` for the full contract
   *  (W1-T177, the terminal-state check at every spending site). */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /** The per-task dispatch circuit breaker: true when a task has been dispatched the policy-capped
   *  number of times with no new owned PR since. Re-derived from the ledger each call, so it persists
   *  across restarts, unlike this loop's in-memory flip below (P29(ii)). */
  isCircuitTripped?: (taskId: string) => boolean;
  /** Raw pushed-run-branch listing, read at the tick's start and again by each lane refill (W1-T5805),
   *  parsed by `runBranchTaskIds`. Injected for the same reason it is on `DrainDeps`: this module reads
   *  its world through deps (W1-T916). A promised read is awaited; a throw or rejection is ledgered. */
  readPushedRunBranches?: () => string | Promise<string>;
  /** W1-T9680: is the fleet's push credential alive? Asked before one lane's credential refusal can stop the
   *  daemon. Absent reads `unreadable`, so the refusal stays fatal as before W1-T9680. */
  probeFleetPushCredential?: () => Promise<FleetCredentialProbe>;
  /** Same contract as `DrainDeps.readOrphanRunBranchEvidence`: read once per tick, absent releases nothing. */
  readOrphanRunBranchEvidence?: () => OrphanRunBranchEvidence | undefined;
  /** Same contract as `DrainDeps.readClosedRunBranchPrs` (W1-T1207): raw `<head-ref>\t<unmerged>` rows, parsed by
   *  `closedUnmergedRunBranchRefs`. W1-T9482: the daemon arm reads it too, lazily, only for a task holding a pushed
   *  ref. Absent or throwing keeps every ref blocking. */
  readClosedRunBranchPrs?: () => string;
  /** The same {@link ObservedScopeByTask} `DrainDeps.observedByTask` takes, threaded to both the
   *  pack step and the partition call below so the two never disagree about a candidate's effective
   *  scope. Optional — omitted, both fall back to the empty union (W1-T2286). */
  observedByTask?: ObservedScopeByTask;
  /** What the breaker saw for a task, from the same memoised evaluation the predicates answered
   *  from, never a second call. Spread onto the refusal rows so they record the count, the bound and
   *  which outcome was reached. Optional: a caller that omits it logs the bare rows. */
  breakerDetail?: (taskId: string) => Record<string, unknown> | undefined;
  /** 
   * Called once per task whose circuit breaker trips this tick — the real command escalates ONE (deduped) needs-human
   * issue naming the loop, mirroring `escalateBlock` below. */
  onCircuitBreak?: (task: Task) => void;
  /**
   * W1-T4025: repeated attributable lifetime work is an adaptive pressure signal, not a terminal
   * cap. The predicate is consulted by selection and must never itself refuse a task. */
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /** Legacy observation hook for callers that still record the pressure sensor. */
  onLifetimeCapExceeded?: (task: Task) => void;
  /** Async adaptive judge/follow-up route, flushed after the current selection/dispatch settles. */
  onLifetimePressure?: (tasks: readonly Task[]) => Promise<void>;
  /** The daily cost ceiling, re-derived from the ledger each call. One answer per tick, so it is consulted directly in
   * the loop; a defined return means defer, and the deferral is an in-process idle heartbeat rather than drain.ts's
   * outright stop. Never consulted from the sweep hooks: stranding in-flight work to save money is a worse failure
   * than the spend (W1-T317). It is consulted again immediately before dispatch, because a reading taken before lane
   * 1 was admitted cannot see lane 1's own unledgered spend (W1-T342). Forensics: docs/forensics/daemon.md. */
  checkCostGovernor?: (dailyCostCeilingUsd?: number) => CostGovernorResult | undefined;
  /** Re-reads the live daily-cost-ceiling policy row, mirroring `reloadPlan`'s placement and contract: once at the top
   * of the tick, so everything in this tick sees one ceiling (W1-T331). Trap: a throw is caught by the loop, which
   * holds the last known-good ceiling rather than discarding it — an undefined here reads as "no override, use the
   * shipped default", silently widening an operator-tightened ceiling the moment one read glitches. */
  reloadDailyCostCeilingUsd?: () => number;
  /** The WIP ceiling, re-derived from the current open-PR count each call — same freshness contract and
   *  same in-process-deferral shape as `checkCostGovernor` above, and likewise never consulted from the
   *  sweep hooks (W1-T321, the W1-T121 23-open-PR incident). Wrapped by the same governor seam,
   *  consulted again before dispatch, failing closed on a throw (W1-T342). Forensics: docs/forensics/daemon.md. */
  checkQueueGovernor?: () => QueueGovernorResult | undefined;
  /** W1-T5347 (wiring W1-T1038's `memoryGovernorGateFor`): THE HOST MEMORY FLOOR, a fresh
   *  `/proc/meminfo` reading per call. Consulted only through `checkDispatchGovernors`, so it holds
   *  NEW dispatch per lane and a throw fails OPEN there. Never consulted from the sweep. Optional. */
  checkMemoryGovernor?: () => MemoryGovernorResult | undefined;
  /** W1-T7720: the streak tracker the unreadable memory probe / reservation store report to, and the
   *  store read itself. Both are consulted only through `checkDispatchGovernors`. Optional. */
  memoryReadTracker?: MemoryReadTracker;
  readMemoryStoreFailure?: () => string | undefined;
  /** Quiet-hours preference: a defined return defers NEW dispatch only. Routed through the dispatch
   *  governor, never through `checkPause`, so sweep/drainage paths keep running and an unreadable
   *  read fails open in `checkDispatchGovernors` (W1-T2655). */
  checkQuietHours?: () => QuietHoursHoldResult | undefined;
  /** Opt-in heavy READY reservation: checked only at an actual NEW implement start, UNKNOWN holds. */
  checkHeavyNewBuild?: DispatchGovernorDeps["checkHeavyNewBuild"];
  /** True when a task's own read is indeterminate — a genuine read failure rather than a clean
   *  absence of evidence — re-derived from the same projection. Optional (W1-T119). */
  isIndeterminate?: (taskId: string) => boolean;
  /** W1-T8616: release the dispatch claims of tasks this cycle's `isMerged` credits (`releaseLandedDispatchClaims`:
   *  the evidence arm, each drop leased to the sha one `ls-remote` listed, a `--rerun` lane's claim left alone, a failed
   *  listing ledgered and never read as no claims). Started once per cycle, never awaited, never overlapped. Optional. */
  releaseLandedClaims?: (isMerged: (taskId: string) => boolean) => Promise<void>;
  /** True when status.ts derives a durable independent-failure block from the ledger. */
  isIndependentFailureBlocked?: NextRunnableOpts["isIndependentFailureBlocked"];
  /** W1-T8676: every latch release the status projection derives (`independentFailureLatch`), by task id. Each
   *  selection pass ledgers the unrecorded ones, and a `provider_recovered` one lifts this process's own hold. */
  independentBlockReleases?: () => ReadonlyMap<string, IndependentBlockRelease>;
  categorizedRefusalRejoinFor?: (taskId: string) => {
    sourceRunId: string; refusedContractRevision: string; contractRevision: string; receiptRecorded: boolean;
  } | undefined;
  /** W1-T6358: renews the breaker gate's ledger snapshot; forwarded into tick selection and every lane refill. */
  beginSelectionPass?: NextRunnableOpts["beginSelectionPass"];
  /** W1-T3959: bounded durable terminal-refusal records, read once per selection pass by the
   * composition root. Missing/unreadable state returns an empty map and therefore fails open. */
  readTerminalPreDispatchRefusalRevisions?: () => ReadonlyMap<string, string>;
  /** Called once per task excluded because its own read is indeterminate. */
  onIndeterminate?: (task: Task) => void;
  adoptRunChildren?: () => AdoptedRunChild[];
  /** W1-T9924: will the run-child policy run this refill as an adoptable child? Unwired, it reads false. */
  refillRunsAsChild?: (task: Task) => boolean;
  /** Run ONE task through the existing run-task path (default = runTask). W1-T9089: a restart never reaches into a
   *  run; a child run is left running for the next boot to adopt and an in-process lane is awaited. */
  runOne: (taskId: string, options?: {
    onChild?: (child: RunChildHandle) => void;
    /** W1-T10000: the run waits for its child's memory admission; no child exists yet. */
    onChildPending?: (pending: RunChildPending) => void;
    /** W1-T10000: asked before a run whose child did not start stays in-process; `false` ends its lane. */
    mayRunInProcess?: (reason: string) => boolean;
  }) => Promise<RunResult>;
  /** `laneDispatchBudget`'s other input: the same open-PR-count closure the real wiring already
   *  builds for `checkQueueGovernor`, never a second read path. Consulted only at two or more lanes.
   *  Optional — omitted, a wide batch is bounded by `laneCount` alone (W1-T343). */
  openPrCount?: () => number;
  /** The reading behind `checkQueueGovernor`'s most recent ADMISSION; present, it sizes the lane budget
   *  in place of `wipLimit`/`openPrCount` — see `LaneBudgetInput.queueAdmission` (drain.ts). */
  readQueueAdmission?: () => QueueAdmissionReading | undefined;
  /** Read current /usage; `undefined` ⇒ unavailable (headroom check is skipped). */
  /** May return a promise. Widened rather than made async, so every existing synchronous supplier —
   *  the CLI probe and all 60 test fakes — keeps working byte for byte. The contract-supported SDK
   *  reading is a control request on a streaming session, which is inherently async. */
  readUsage?: () => UsageSnapshot | undefined | Promise<UsageSnapshot | undefined>;
  /** Windows already reported by a previous process, read back off the ledger by whoever builds these deps. The ledger
   * is the dedup — a step written once and read back as the key, never a new state file — which makes the
   * once-per-window bound survive a restart. Keyed on `window`; see {@link priorUnrecognisedResetStrings} (W1-T482). */
  priorUnrecognisedResets?: ReadonlySet<string>;
  /** Called when a window first crosses the operator reserve on a confirmed, readable breach, never on
   *  the unreadable path. Fires at most once per episode, and dispatch is already paused by then, so
   *  the hook is a pure notification. The real command wires an escalation with its own cross-boot
   *  ledger dedup, because this in-process flag resets on every restart (P34 (c), W1-T249). */
  onHeadroomBreach?: (info: {
    window: string;
    percentUsed: number;
    limitPct: number;
    resetsAt: string;
  }) => void | Promise<void>;
  /** W1-T10381: the identities of the fleet credential store and the host login. Present, the
   *  `daemon.headroom` row names the measured (store) account as a redacted `account`, and a store at
   *  or over its reserve beside a different host account with headroom is one divergence episode.
   *  Identity fields only; nothing is copied. A throw is ledgered, never fatal. */
  readFleetAccounts?: () => FleetAccountPair | undefined;
  /** Called at most once per (store uuid, host uuid) episode, on top of the `daemon.fleet_account_diverged`
   *  row. A pure notification: the real command may add its own cross-boot ledger dedup. */
  onFleetAccountDivergence?: (info: FleetAccountDivergence) => void | Promise<void>;
  /** Called at most once per park, on the tick the ceiling forces a blind dispatch — never per tick,
   *  which at a 60s poll would be a pager. Re-armed when the park ends. */
  onHeadroomParkCeiling?: (info: {
    consecutiveUnreadable: number;
    parkedMs: number;
    ceilingMs: number;
  }) => void | Promise<void>;
  /** The two rate-limit buckets, read fresh each tick. An undefined bucket means unreadable, never
   *  an exhaustion — the same fail-soft contract `readUsage` carries. Consulted on the same per-tick
   *  cadence as the headroom block, so no second rate-limit call is made per tick (W1-T372). */
  readGhQuota?: () => GhRateLimitBuckets;
  /** W1-T10271: the gh read cadence since the previous poll, carried on that poll's `daemon.quota` row:
   *  this process's reads stamped by floor mode and slots it yielded to a waiting gated read, and every
   *  process's admitted gated reads. Defaults to {@link takeGhReadCadenceTally}. */
  takeGhReadCadence?: () => GhReadCadenceTally;
  /** Called at most once per bucket per exhaustion episode, on the tick a bucket first crosses from
   *  having budget to having none. Trap: a bare zero check would re-fire every tick for up to an hour,
   *  so the loop latches per bucket. Unlike `onHeadroomBreach` this never pauses dispatch: it observes
   *  and surfaces (W1-T372). Forensics: docs/forensics/daemon.md. */
  onQuotaExhausted?: (info: { bucket: "core" | "graphql"; remaining: number; resetsAt: string }) => void | Promise<void>;
  /** Real free disk space for this tick, pre-judged against the same thresholds `rmd doctor` reports
   *  against. Judged in the CLI wiring, never here, because a daemon alarming at a different number
   *  than `rmd doctor` is a contradiction an operator must adjudicate mid-incident. An unreadable read
   *  is undefined, never a fake zero, and the loop treats it as unreadable. Optional (W1-T1082). */
  readDiskHeadroom?: () => { freeBytes?: number; verdict: "OK" | "WARN" | "FAIL" };
  /** Called at most once per continuous disk-headroom breach episode, and cleared the instant a later
   *  reading is OK. It escalates at WARN, not only FAIL, because by FAIL the issue body, the dedup marker
   *  and the ledger row are all writes that may lose to the same ENOSPC this reports ahead of. Never
   *  called for an unreadable read (W1-T1082). */
  onDiskHeadroomBreach?: (info: { freeBytes: number; verdict: "WARN" | "FAIL"; ts: string }) => void | Promise<void>;
  /** Reclaim `review-PR*` worktrees a SIGKILL stranded — see {@link
   *  import("./review-worktree-reclaim.js").sweepStrandedReviewWorktrees} (W1-T3378). A zero-arg
   *  closure so the caller binds `config` and its own ledger `log`, matching `readDiskHeadroom`
   *  above. Best-effort: a throw is caught and logged, never allowed to take the tick down.
   *  Optional — omitted, this tick performs no sweep, unchanged behaviour for every existing caller. */
  sweepStrandedReviewWorktrees?: () => void;
  /** Reclaim regenerable build output inside checkouts that must be KEPT — see {@link
   *  import("./disk-artifact-reclaim.js").sweepReclaimableArtifacts} (W1-T3528). Every shipped
   *  reclaim rung's unit is a whole tree, so none can free a `coverage/` or `node_modules` inside
   *  a tree held by uncommitted work. Same zero-arg, best-effort contract as the sweep above.
   *  Optional — omitted, this tick performs no artifact sweep. */
  sweepReclaimableArtifacts?: () => void;
  /** W1-T7093: update this instance's shared host-memory reservation tree on every heartbeat.
   *  Bookkeeping only; a failure is logged and never delays or gates work. */
  sweepHostMemoryReservations?: () => void;
  /** Called on an idle tick whose census names at least one recoverable-class blocker — see
   *  {@link StarvationCensus}. Fires at most once per episode, and dispatch is already idle by then, so
   *  the hook is a pure notification. The real command wires an escalation with its own cross-boot
   *  ledger dedup, because this in-process bound resets on every restart. Optional. */
  onStarvation?: (census: StarvationCensus) => void | Promise<void>;
  /** The cleared half of the transition `onStarvation` only ever opens. Without it the escalation issue
   *  stays open forever, even once a later dispatch has made the condition moot. Mirrors `onStarvation`
   *  exactly: optional, same try/catch, fired from the same two sites, and on the edge rather than per
   *  tick, so a daemon never escalated stays silent and a long quiet stretch closes nothing repeatedly. */
  onStarvationCleared?: (info: StarvationClearedInfo) => void | Promise<void>;
  /** W1-T3691 (design v) — called once per stuck sha, the FIRST tick a freshness restart already
   *  requested for this exact code sha reports coming back unchanged: the target looks genuinely
   *  pinned behind origin/main rather than transiently behind it, so this is a "needs a human"
   *  notification, never another restart request. Optional; the real command wires an escalation
   *  the same way `onStarvation` does. Omitted, this stays a ledger line only (`review.stale_
   *  reviewer_needs_human`), never a throw. */
  onStaleReviewerNeedsHuman?: (info: { codeSha: string; originMainSha: string; reason: string }) => void | Promise<void>;
  /** Fleet control: a defined return means a hard STOP is in effect, and the string is the ledger
   *  and summary detail. Checked first, every tick, so it takes precedence over PAUSE and wins the
   *  race if both flags are set (W1-T11, MASTER-PLAN §4A/§4B). */
  checkStop?: () => string | undefined;
  /** W1-T3335 — V8 heap accounting, injectable so the pressure arm is testable without allocating
   *  gigabytes. Defaults to {@link v8HeapStatistics}. */
  heapStatistics?: () => { used_heap_size: number; heap_size_limit: number };
  /** The memory governor (daemon-memory-policy.ts): RSS plus swap as a share of the container's budget,
   *  read once per tick. Defaults to one on the default policy and the real /proc and cgroup readings. */
  memoryGovernor?: DaemonMemoryGovernor;
  /** Fleet control: a defined return means a graceful PAUSE, a drain-and-hold. Checked between
   *  iterations only, after the current dispatch has resolved, so in-flight work always runs to full
   *  completion before a pause is honoured (W1-T11). */
  checkPause?: () => string | undefined;
  /** W1-T4429: the hold behind `checkPause` (owner/expiry/liveness); absent, no governor runs. It calls
   *  `clearPauseHold` once at `lapsed` and `onPauseNeedsHuman` once at `needs_human`. */
  checkPauseHold?: () => PauseHoldGovernorInput | undefined;
  clearPauseHold?: () => void | Promise<void>;
  onPauseNeedsHuman?: (info: { holdId: string; owner: PauseHoldOwner; expiresAt: string | null }) => void | Promise<void>;
  workerAdmissionHold?: () => FleetControlHold | undefined;
  /** Reads freshness between iterations and on the dispatch ticker's cadence. A restart-worthy advance
   *  closes admission; admitted lanes settle before the existing drain and stale exit (W1-T5308). A
   *  promise is awaited at the tick's own boundaries; a lane's sync refill reads the latest settled one (W1-T5282). */
  checkFreshness?: () => DaemonFreshness | Promise<DaemonFreshness>;
  /** W1-T9631: the sha the boot checkout could not reach; defaults to the entrypoint's RMD_BOOT_CHECKOUT_BLOCKED. */
  bootCheckoutBlocked?: string;
  /** Consulted only when freshness reports an install is needed. Runs before the loop stops for
   *  restart, never after, so the relaunched process inherits a dependency tree matching `newSha`.
   *  This module stays pure; the real command wires the install (W1-T151). */
  runInstall?: () => void;
  /** Peek the pending "run this queued task now" kick markers, oldest first — a pure injection, no filesystem here.
   * The daemon gates each through {@link assertRunnable} and the merged projection and clears it as it dispatches or
   * refuses it, so a runnable kick it cannot service this cycle survives to the next (fb-1784988460437-9daa9b). */
  pendingKicks?: () => Array<DaemonKick>;
  /** Delete one kick marker (consumed-once) after the daemon dispatches or refuses it. W1-T10615: `repo` is the
   *  SAME repo the pending kick carried, so the clear names that exact marker, never a sibling repo's. */
  clearKick?: (taskId: string, repo?: string) => void;
  /** W1-T10799: the repo-scoped kick markers for a MANAGED TARGET with no daemon of its own, which only the core daemon
   *  may service. Never offered to {@link pendingKicks}' consumer, so a foreign marker cannot dispatch a core task. */
  pendingTargetJobs?: () => Array<DaemonKick & { repo: string }>;
  /** W1-T10799: runs ONE such job to its terminal verdict, through the maintained drain. The daemon passes its own deps so
   *  the job meets every governor this daemon applies, and awaits it: one job occupies the one reserved lane. A `held` or
   *  `resumed` outcome keeps the marker for a later tick; `ended` and `refused` closed it. */
  runTargetJob?: (kick: DaemonKick & { repo: string }, daemonDeps: DaemonDeps) => Promise<{ state: "ended" | "refused" | "held" | "resumed" }>;
  /** Read and delete the "drain now" marker, consumed once; a defined return means the operator
   *  asked for one immediate dispatch cycle. */
  consumeDrainNow?: () => { origin: string } | null;
  /** Pending bounded PR repair/review requests recorded by the authenticated console. The daemon
   * consumes at most one per poll and keeps final fix/review authority in its established command
   * path; the HTTP writer never starts a process. */
  pendingPrActions?: () => Array<{ action: "fix" | "review"; prNumber: number; origin: string; requestedAt: string; operator?: string }>;
  pendingImprovementActions?: () => AsyncIterable<{ operationId: string; stateDir: string; repoRoot: string }>;
  handOffImprovementAction?: (target: { operationId: string; stateDir: string; repoRoot: string }) => Promise<unknown>;
  /** Clear the request only after its established command reaches a named terminal outcome. */
  clearPrAction?: (action: "fix" | "review", prNumber: number) => void;
  /** W1-T4087: writes plain-language messages for operator-owned inbox items that have none yet,
   *  on its own timer beside the main loop. Absent in tests that do not exercise it. */
  plainBackfill?: PlainBackfillDeps;
  /** W1-T8950: writes a recommended decision for each operator inbox item, on its own timer beside the plain backfill. */
  recommendationBackfill?: RecommendationBackfill;
  /** W1-T4089: files and folds the fleet's own findings, on its own timer beside the main loop. */
  fleetLane?: FleetLaneDeps<number | Promise<number>>;
  /** W1-T9097: the lane governor's mode, memory reading and CPU count (lib/lane-governor.ts). Absent, the real ports over
   *  `fleetLane`'s state directory; neither, no governor. Consulted only at two or more lanes. */
  laneGovernor?: LaneGovernorPorts;
  /** W1-T4390: the SRE governor's second enforcer, evaluated every tick over the SRE instance's
   *  ledger ({@link stepSreGovernor}). Absent, it reads `fleetLane`'s state root — TRAP: the
   *  registry (W1-T4227) names no instance `state_dir` yet, and the SRE lane runs on this daemon's
   *  own state root, so that IS the SRE instance's ledger; that default has no repo to escalate under. */
  sreGovernor?: SreGovernorEnforcer;
  /** W1-T4095: the knowledge gardener — scores, prunes and consolidates the knowledge base on its own
   *  timer beside the main loop, and lands its changes as one reviewed PR per pass. */
  knowledgeGardener?: GardenerDeps<GardenWorkspace, PrState | Promise<PrState>>;
  /** W1-T4110/W1-T4941: registered gardens, including the backlog gardener, start off the loop
   * through `rmd garden run <name>` on independent timers. */
  gardens?: ReadonlyArray<(intervalMs: number) => { stop: () => void }>;
  /** W1-T4088: answers operator replies on inbox threads, on its own timer beside the main loop. */
  inboxResponder?: InboxResponderDeps;
  /** E32: write `daemon.pulse` once per poll interval while no other `daemon.*` row has, for this
   *  run's whole life ({@link startLivenessPulse}). Off in tests that count rows or sleeps. */
  livenessPulse?: boolean;
  /** The CLI wiring binds this to the existing selected-repository `rmd fix` / `rmd review`
   * commands. It is injected so this scheduler module never grows a second repair implementation. */
  runPrAction?: (request: { action: "fix" | "review"; prNumber: number; origin: string; requestedAt: string; operator?: string }) => Promise<{ outcome: "completed" | "refused"; detail?: string }>;
  /** The injected clock, pacing idle polling when nothing is runnable. The real command wires a timer-backed wait;
   * tests inject a fake that resolves immediately, so the loop is provable without a real wall-clock wait. */
  sleep: (ms: number) => Promise<void>;
  /** The daemon's interruptible reconciliation wait. The top-level loop always uses it; phase tickers
   *  use it only when they carry the full-pass retrigger, so a GitHub event reaches the same gated pass
   *  without an ordinary heartbeat consuming the event. Only an explicit wake bypasses it (W1-T2568). */
  sleepUntilSweepWake?: (ms: number) => Promise<"wake" | "timeout" | void>;
  /** Acknowledge one durable event wake only after the full-pass liveness gate accepts a pass. A
   *  hold, or a still-settling prior pass, leaves the marker for a later accepted pass. This module
   *  stays filesystem-free; production injects the claim (W1-T2656). */
  acknowledgeSweepWake?: () => void;
  /** The injected wall clock, distinct from the pacing clock above: read once per headroom check to
   *  resolve each window's hours-to-reset against the time-aware ceiling. Tests inject a fake the
   *  pacing fake can advance, so "resumes once the window resets" is provable without a real wait. */
  now?: () => Date;
  /** One ledger line per tick/task/terminal reason (reuses run-task's ledger). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** The level-triggered PR-pipeline reconciler: the same entry point `rmd sweep` invokes, wired here so
   *  it runs once per poll iteration, re-deriving every open PR to a disposition and taking its gated
   *  action. Best-effort, and called alongside dispatch, never instead of it (W1-T77, ratifies P22).
   *  W1-T3618: may resolve a {@link SweepCycleOutcome} naming a mid-pass reviewer-code freshness
   *  discovery; `void` (every caller that predates that task) is unchanged and carries no signal. */
  sweep?: (continueReviewAdmissions?: ReviewAdmissionGate) => Promise<SweepCycleOutcome | void> | SweepCycleOutcome | void;
  /** Run one security-alert poll. Best-effort by the same contract as the reconciler: a throw costs one logged tick.
   * Returns the poll's timestamp so the caller can persist the interval marker (W1-T462). */
  alertPoll?: () => Promise<string | undefined> | string | undefined;
  /** The same orphan sweep `daemonBoot` runs once at boot, wired here so it also runs once per poll
   *  iteration — a stray from a run that ended between polls is then found within one cycle.
   *  Best-effort. Optional (W1-T117 part ii). */
  sweepOrphans?: () => Promise<OrphanSweepReport> | OrphanSweepReport;
  /** The same feedback-landing sweep `daemonBoot` runs once at boot, wired here so it also runs once per
   *  poll iteration. Why: an entry captured while landing was unavailable, or on a host that never
   *  captures again, is otherwise stranded off origin/main forever (W1-T530, ratifies P22). */
  sweepFeedbackLanding?: () => Promise<LandFeedbackResult> | LandFeedbackResult;
  /** Reads whether the repo's GitHub-side security capabilities are on, at most once a day, returning
   *  only findings that changed since the recorded baseline — empty otherwise, including on an
   *  unreadable read, never a false all-clear. A finding is a ledger row, never a gate (W1-T1040). */
  checkGithubPosture?: () => Promise<GithubPostureFinding[]> | GithubPostureFinding[];
  /** The measurement-cadence rung: decides whether the three measurement verbs run this tick. Paced
   *  by its own policy-data bound, never the raw poll interval — the same marker-plus-interval-plus-
   *  cap shape auto-triage uses. Optional (W1-T1259). */
  checkMeasurementCadence?: () => MeasurementCadenceDecision;
  /** Run all three measurement verbs once, returning a summary this loop logs, never the producer
   *  itself. The write path is default-off: the default cadence runs every verb report-only, and
   *  never files a task or mints an id (Law 5). Best-effort (W1-T1259). */
  runMeasurementCadence?: () => Promise<MeasurementCadenceRunResult>;
  /** W1-T5723: when present the cadence runs as a child process instead of `runMeasurementCadence`,
   *  and a boot adopts a live child rather than starting another. */
  measurementCadenceChild?: MeasurementCadenceChildRunner;
  /** The digest's own cadence rung. Its own policy row on its own marker file, separate from the measurement row so
   * the two can never drag each other, while reusing the same pure decision function. Optional (W1-T2277). */
  checkDigestCadence?: () => MeasurementCadenceDecision;
  /** Build and deliver one digest, returning what got sent — never inside the producer itself. Never
   *  files a task, mints an id or spawns a worker (Law 5). Best-effort (W1-T2277). */
  runDigestCadence?: () => Promise<DigestCadenceRunResult>;
  /** W1-T3368 — the SELF-HEALING rung: is the ledger archive corpus large enough that a union read
   *  is heading for the heap? Pure from this module's side; the pressure read and the trigger live in
   *  `ledger-compaction-rung.ts`. Optional, so a host that never wires it behaves exactly as before. */
  checkLedgerCompaction?: () => LedgerCompactionDecision;
  /** Run ONE bounded compaction pass. Never touches the live ledger, never a rotation dependency, and
   *  best-effort like every cadence above it — a compaction fault must never break a daemon cycle. */
  runLedgerCompaction?: () => Promise<LedgerCompactionOutcome | undefined>;
  /** Local, best-effort projection. A source fault is evidence debt, never a work gate. */
  checkBenchmarkCohort?: () => boolean;
  runBenchmarkCohortPass?: () => Promise<BenchmarkCohortPassResult>;
  /** W1-T2923: one scheduler over repository-intake rungs. The check is pure from this module's
   *  perspective; run-task.ts owns markers, policy, GitHub, filesystem and worker effects. */
  checkIntakeRungs?: () => readonly IntakeRungDecision[];
  opportunityIntake?: OpportunityIntakePorts;
  opportunityOutcomes?: OpportunityOutcomePorts;
  /** Run one enabled intake rung selected by {@link checkIntakeRungs}. */
  runIntakeRung?: (decision: Extract<IntakeRungDecision, { fire: true }>) => Promise<IntakeRungRunResult> | IntakeRungRunResult;
  /** The board-review rung, wired. Its unit is the whole open board rather than one PR, and it has its own policy row
   * and marker file so three cadences sharing one bound cannot drag each other. Why the check-and-run pair matters:
   * #2952 merged 385 tested lines and the rung never fired once, because nothing called it. It also carries retired
   * proposal ids, reconciled on every call (W1-T2304, W1-T2464). */
  checkBoardReview?: () => BoardReviewCadenceDecision & { retiredProposalIds?: string[] };
  /** W1-T5481: awaited before {@link checkBoardReview}, so the open-board read it decides over is
   *  done off the loop. MEASURED 2026-10-03: that read, synchronous, held the loop 30-98 s per tick. */
  prefetchBoardReview?: () => Promise<void>;
  /** Runs one board-review tick. Read-only by construction: it writes one report artifact and drafts
   *  registry proposals, and nothing else — it does not push, merge, mint or file, and Rule 15
   *  stands. Best-effort, and a fired review never gates dispatch or changes a verdict. */
  runBoardReview?: () => Promise<BoardReviewReport>;
  /** W1-T2659's wipe-test cadence rung. It spends by dispatching one generated sandbox subject
   *  through both arms, so the loop checks it after dispatch governors and paces it independently. */
  checkWipeTestCadence?: () => WipeTestCadenceDecision;
  /** Runs the selected wipe-test pair. A preflight or target refusal is a `wipetest.cadence.refused`
   *  row, not a skipped tick and not a synthetic pair. */
  runWipeTestCadence?: (
    decision: Extract<WipeTestCadenceDecision, { fire: true }>,
  ) => Promise<WipeTestCadenceRunResult>;
  /** W1-T2972 — the daily CI-failure learning rung: own policy row, own marker, the shared
   *  two-bound decision. Optional like its siblings. WITHOUT run-task.ts's producer line these are
   *  undefined and the rung is dead code — the shape #1066 and #2952 shipped, W1-T2959 making three. */
  checkCiLearningCadence?: () => MeasurementCadenceDecision;
  /** Run one CI learning tick, returning its draft and state-backed landing counts for the durable
   *  row. Every resulting task remains MARKED/PARKED (`author_class: machine`, `verify: human`);
   *  a throw is best-effort and the tick continues. */
  runCiLearningCadence?: () => Promise<
    CiLearningCadenceRunResult & { filedCount: number; skippedCount: number; refusedCount: number }
  >;
  /** Evaluate the retro cadence trigger this tick. Fires on merges-since-marker or days-since-marker, whichever
   * crosses first (policy data). An undefined return means there is nothing safe to evaluate — a corrupt marker, a
   * degraded read — and the loop only acts on an explicit fire. Optional (W1-T160). */
  checkRetroTrigger?: () => RetroTriggerDecision | undefined | Promise<RetroTriggerDecision | undefined>;
  /** W1-T9119: what the retro check's own ledger read would decompress right now (the rotations it holds no digest
   *  for). The retro defers only when this exceeds the heap's measured headroom; absent, nothing gates the check. */
  projectRetroReadCost?: RetroCheckCompanions["projectRetroReadCost"];
  /** W1-T9119: the `retro_triggered` times (ms, ascending) and the policy's own cadence in ms, from which a
   *  persisting deferral learns the retro's expected interval. Absent, no episode is named. */
  readRetroHistory?: RetroCheckCompanions["readRetroHistory"];
  /** Run the automated retro once the trigger fires. The real wiring threads the fired decision's
   *  merge count into the retro command, so the integrity gate can compare it against the real
   *  gather's credited count and abort loudly on a mismatch. Best-effort (W1-T160). */
  runRetroTrigger?: (decision: Extract<RetroTriggerDecision, { fire: true }>) => Promise<void>;
  /** The auto-triage rung's decision hook — same injected shape as the retro trigger, so the whole
   *  rung is unit-testable without a clock, a filesystem or a spend. The caller passes the census it
   *  already computed this tick; a hook that ignores it still typechecks (impl-DJ, W1-T318). */
  checkAutoTriage?: (signals: {
    deferralPending: boolean;
    dispatchCount: number;
    laneBudget: number;
  }) => AutoTriageDecision | Promise<AutoTriageDecision>;
  /** impl-DJ: run ONE triage for the decided entry. Awaited under the light-sweep ticker. */
  runAutoTriage?: (feedbackId: string) => Promise<void>;
  /** The auto-triage rung's own in-flight guard, symmetric with `isOpenPr` but keyed on feedback id. Why: a feedback
   * entry's status only advances when its triage PR merges, so between dispatch and merge the same head keeps being
   * returned and a slow CI round re-fires the identical entry (W1-T300, the #1184/#1185 duplicate-triage race). */
  isFeedbackOpenPr?: (feedbackId: string) => number | undefined;
  /** An optional fresh, live re-read of one candidate in-flight triage PR's state, mirroring
   *  `readLiveState`'s contract, so a merged-or-closed-but-cached PR can never park a feedback entry
   *  forever. An unreadable result fails open, same as the task lane (W1-T300). */
  readFeedbackLiveState?: (feedbackId: string, prNumber: number) => string | undefined;
  /** The entry's `status:` on origin/main, read only once its triage PR reads MERGED; `undefined` fails open (#10265). */
  readFeedbackStatusOnMain?: (feedbackId: string) => string | undefined;
  /** The restricted light-sweep ticker. Dispatch is unbounded and the full reconciler only runs between
   *  iterations, so a PR that went green-but-review-absent sat invisible for the dispatch's whole
   *  remaining duration — #707 swept at 13:12 and never swept the new head again (W1-T254). Trap: the
   *  real wiring restricts it to the sha-pinned, mutex-serialized post-review re-post only; every other
   *  lane must stay single-threaded and never runs from here. Forensics: docs/forensics/daemon.md.
   *  W1-T4053: only a freshness drain passes a {@link LightPassScope}; every other caller passes nothing. */
  sweepLight?: (scope?: LightPassScope) => Promise<void> | void;
  /** W1-T7734 — eligible review demand the last passes left waiting, and the light-pass interval derived
   *  from observed review duration and head churn. Memory only, never a ledger read. `undefined` or
   *  `eligible <= 0` is no demand: the idle branch sleeps as it always has. A `cadenceMs` that is
   *  `undefined` (nothing observed yet) leaves the idle sleep a single poll interval. */
  readIdleReviewDemand?: () => { eligible: number; cadenceMs?: number; medianReviewMs?: number; pushesPerPrHour?: number } | undefined;
  /** Existing bounded completed-review memo, independent of current eligible demand. */
  readReviewMedianMs?: () => number | undefined;
  /** Called exactly once, when a block classifies as a genuine blocker — one or more tasks
   *  transitively depend on the blocked task. The real command escalates naming the dependents.
   *  Optional: omitted, a genuine blocker still halts the loop, it just opens no issue (W1-T46). */
  escalateBlock?: (info: { task: Task; result: RunResult; dependents: string[] }) => void | Promise<void>;
  /** Called for a fixable genuine blocker — dependents exist, but the verdict names actionable
   *  evidence — before any halt and escalate. The real command wires the same fix rung the
   *  reconciler dispatches. Optional: omitted, or once the strike bound is exhausted, a fixable
   *  block falls through to the same halt, so the daemon never silently stalls (W1-T174). */
  dispatchFix?: (info: { task: Task; result: RunResult; dependents: string[] }) => void | Promise<void>;
  /** Called at most once per distinct reason for the life of this run — never per tick and never per
   *  task — when a dispatch throws a spawn-infrastructure error. Detected by a duck-typed class tag,
   *  never an `instanceof` import, so this module stays decoupled from worker.ts. Content-keyed, so
   *  an already-open toolchain issue for the same cause suppresses a repeat (W1-T113 part iii). */
  onSpawnInfraBlocked?: (info: { task: Task; reason: string }) => void | Promise<void>;
}

export interface FleetControlHold {
  control: "STOP" | "PAUSE";
  detail: string;
}

export function resolveFleetControlHold(
  deps: Pick<DaemonDeps, "checkStop" | "checkPause">,
): FleetControlHold | undefined {
  const stopped = deps.checkStop?.();
  if (stopped !== undefined) return { control: "STOP", detail: stopped };
  const paused = deps.checkPause?.();
  if (paused !== undefined) return { control: "PAUSE", detail: paused };
  return undefined;
}

function retroTriggerCrossingKey(decision: Extract<RetroTriggerDecision, { fire: true }>): string {
  return decision.reason;
}

/** Duck-typed classifier for a spawn-infrastructure failure, checked by a plain string tag rather than `instanceof` so
 * this module never imports worker.ts as a value. Any other throw is still a genuine, unclassified error: this daemon
 * must not learn to swallow every crash, only the one named infrastructure class (W1-T113). */
function isSpawnInfraBlocked(err: unknown): err is { reasonClass: "blocked_toolchain"; message: string } {
  return typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";
}

/** A rejected worker may be reporting GitHub backpressure from its post-run PR/check polling rather
 * than a software crash. Keep this carve-out deliberately narrower than {@link classifyFailure}:
 * the command evidence must name `gh`, and the joined message/stderr/code must positively classify
 * transient. This prevents arbitrary worker prose such as "internal server error" from being
 * swallowed while retaining the stderr/code fields Node does not always copy into Error.message. */
function transientGhDispatchFailure(err: unknown): { detail: string } | undefined {
  if (err instanceof GhJsonUnreadableResponseError) return { detail: err.message };
  if (typeof err !== "object" || err === null) return undefined;
  const failure = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
  const message = String(failure.message ?? "");
  if (!/(?:^|\s)gh(?:\s|$)/i.test(message)) return undefined;
  const detail = [message, failure.stderr == null ? "" : String(failure.stderr), failure.code ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
  return classifyFailure({ text: detail }) === "transient" ? { detail } : undefined;
}

/**
 * W1-T4466 — a failed GitHub READ, scoped to the KNOWN read endpoints the rationale's two
 * pass-ending errors actually named: `gh api repos/.../commits/<sha>/check-runs` and
 * `commits/<sha>/status` (open-prs-rest.ts's `checkRunsRestArgs`/`combinedStatusRestArgs`). One lane
 * reading CI state off a head it does not even own must not end the whole pass — the daemon
 * container's own 30-hour window charged two of six pass-ending errors to exactly this read.
 *
 * DELIBERATELY NARROWER than "any `gh api` call with no `--method`": a bare `gh api
 * repos/.../pulls` is ALSO how the PR-create endpoint is spelled in the auth/rate-limit fixtures
 * the fatal path must still cover (test/daemon.test.ts, "W1-T3165 ... auth refusals ... remain
 * fatal"), so a blanket read/write split by `--method` presence alone would silently swallow those
 * too. Matching the two named endpoints keeps a WRITE failure (create, merge, comment) on today's
 * fatal path unchanged, per design (iii).
 */
/** W1-T5805: the run-branch facts one selection pass decides on. The tick's start reads them and so does
 *  each lane refill: a branch pushed mid-phase (#9210, 02:16Z) was invisible to a refill at 02:43Z. */
export interface RunBranchState {
  ids: ReadonlySet<string> | undefined;
  refs: readonly PushedRunRef[];
  orphanEvidence: OrphanRunBranchEvidence | undefined;
  /** W1-T9482: reads the closed-unmerged exclusion set; absent when no reader is wired. */
  readClosedUnmerged?: () => ReadonlySet<string> | undefined;
}

/** W1-T9482: the latest `sweep.strike_ladder.requeued` instant per task in `lines`; unparseable rows are skipped. */
export function requeueTimesFromLedger(lines: readonly string[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    if (!line.includes("sweep.strike_ladder.requeued")) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      void error; // a torn ledger line is not a requeue receipt; the ref keeps blocking
      continue;
    }
    if (row.step !== "sweep.strike_ladder.requeued" || typeof row.task_id !== "string" || typeof row.ts !== "string") continue;
    const at = Date.parse(row.ts);
    if (Number.isFinite(at) && at > (out.get(row.task_id) ?? -Infinity)) out.set(row.task_id, at);
  }
  return out;
}

/** W1-T9482: threads the ledger's requeue receipts into the orphan evidence. The ledger is read on the first
 *  lookup only, and only for a task whose ref already passed the reaper's no-PR sha proof. */
export function withRequeueReceipts(
  evidence: OrphanRunBranchEvidence | undefined,
  readLedgerLines: (() => readonly string[]) | undefined,
): OrphanRunBranchEvidence | undefined {
  if (evidence === undefined || readLedgerLines === undefined || evidence.requeuedAtMs !== undefined) return evidence;
  let times: ReadonlyMap<string, number> | undefined;
  return {
    ...evidence,
    requeuedAtMs: (taskId) => {
      if (times === undefined) {
        try {
          times = requeueTimesFromLedger(readLedgerLines());
        } catch (error) {
          void error; // unreadable ledger: no receipt, every ref keeps blocking
          times = new Map();
        }
      }
      return times.get(taskId);
    },
  };
}

/** W1-T9482: a memoised, fail-closed reader of the closed-unmerged set (empty on a throw, so refs keep blocking). */
export function lazyClosedUnmerged(read: (() => string) | undefined): (() => ReadonlySet<string> | undefined) | undefined {
  if (read === undefined) return undefined;
  let set: ReadonlySet<string> | undefined;
  return () => {
    if (set === undefined) {
      try {
        set = closedUnmergedRunBranchRefs(read());
      } catch (error) {
        void error; // unreadable closed-PR sweep: exclude nothing
        set = new Set();
      }
    }
    return set;
  };
}

/** The epoch-ms suffix of a `run-<id>-<epochMs>` branch; NaN (never older) when it has none. */
function runBranchEpoch(branch: string): number {
  const match = /-([0-9]+)$/.exec(branch);
  return match ? Number(match[1]) : Number.NaN;
}

export function runBranchStateFrom(raw: string | undefined, orphanEvidence: OrphanRunBranchEvidence | undefined,
  resumable: ReadonlyMap<string, { branch: string; headSha: string }> = new Map(),
  readClosedUnmerged?: () => ReadonlySet<string> | undefined): RunBranchState {
  if (raw === undefined) return { ids: undefined, refs: [], orphanEvidence };
  const refs = parsePushedRunRefs(raw).filter((ref) => {
    const checkpoint = resumable.get(ref.taskId);
    if (checkpoint === undefined) return true;
    if (checkpoint.branch === ref.ref) return checkpoint.headSha !== ref.sha;
    // W1-T7837: a run started after this branch was pushed, so the branch was restored or released then; the
    // newer checkpoint carries the work. Left blocking, it held a resumable task as run-branch-already-pushed.
    return !(runBranchEpoch(ref.ref) < runBranchEpoch(checkpoint.branch));
  });
  return { ids: new Set(refs.map((ref) => ref.taskId)), refs, orphanEvidence, readClosedUnmerged };
}

/** Calls the reader, awaiting only a promised read, so a sync reader keeps a refill synchronous. */
function readRunBranchListing(
  read: (() => string | Promise<string>) | undefined,
  onFailure: (error: unknown) => string | undefined,
): string | undefined | Promise<string | undefined> {
  let raw: string | Promise<string> | undefined;
  try {
    raw = read?.();
  } catch (error) {
    return onFailure(error); // the caller's `onFailure` ledgers the failure and names the fallback
  }
  return raw instanceof Promise ? raw.catch((error: unknown) => /* ledgered, as above */ onFailure(error)) : raw;
}

/** The two options a pass's run-branch read decides; none when no reader was wired. */
export function runBranchDispatchOpts(
  { ids, refs, orphanEvidence, readClosedUnmerged }: RunBranchState,
  receipts: readonly PlanOnlyRunBranchReceipt[],
  log: (step: string, extra?: Record<string, unknown>) => void,
): Pick<NextRunnableOpts, "hasPushedRunBranch" | "onSkipRunBranch"> {
  if (!ids) return {};
  return {
    // W1-T4002: `stillBlockedByPushedRunBranch` is the SAME predicate drain.ts's own
    // selection loops apply — see that function's doc. Before returning, name every
    // OTHERWISE-blocking ref this pass's receipts released, so the collision an operator
    // sees is explicit rather than a silent non-block.
    hasPushedRunBranch: (id: string) => {
      const refsForTask = refs.filter((r) => r.taskId === id);
      // W1-T9482: the closed-unmerged exclusion drain.ts's arms apply, read only for a task that holds a ref.
      const closedUnmerged = refsForTask.length > 0 ? readClosedUnmerged?.() : undefined;
      const stillBlocked = stillBlockedByPushedRunBranch(id, ids, closedUnmerged, refs, receipts, orphanEvidence);
      if (!stillBlocked && refsForTask.length > 0) logPlanOnlyRunBranchException(log, id, refsForTask, receipts, orphanEvidence);
      return stillBlocked;
    },
    // Rides the existing skip row with its own reason: no new step, and deliberately not the stood-down
    // row, which has three emitters and no reader.
    onSkipRunBranch: (t: Task) => log("dispatch.skipped", { task: t.id, reason: "run-branch-already-pushed" }),
  };
}

/**
 * W1-T10348 — A RELEASED TASK THAT DISPATCH FILTERS OUT IS NAMED. Wraps the tick's `onFiltered` (the idle
 * tally, which is written only when the daemon is idle and caps its ids) so a released task, or a machine
 * release set aside under a standing escalate ruling, writes `dispatch.released_filtered` with its reason.
 * `named` is the daemon process's own set: a stable filter is named once, and a changed reason again.
 */
export function releasedFilteredLogger(
  releases: ReleaseResolution,
  named: Set<string>,
  tally: (task: Task, reason: DispatchFilterReason) => void,
  log: (step: string, extra?: Record<string, unknown>) => void,
): (task: Task, reason: DispatchFilterReason) => void {
  return (task, reason) => {
    tally(task, reason);
    const setAside = releases.setAside.has(task.id);
    if (!setAside && !releases.ids.has(task.id)) return;
    const key = `${task.id}\u0000${reason}`;
    if (named.has(key)) return;
    named.add(key);
    log("dispatch.released_filtered", {
      task: task.id, reason, release_author: releases.authors.get(task.id) ?? "operator",
      ...(setAside ? { set_aside: releases.reapprovalRequired?.has(task.id) ? "explicit operator reapproval required" : releases.unknownReleaseHistory?.has(task.id) ? "operator release history is unreadable" : "current-pin escalate ruling" } : {}),
    });
  };
}

/** W1-T10028: exported so a test can drive the pick row with the selector's own frontier. */
export function captureDispatchFrontier(plan: Plan, opts: NextRunnableOpts) {
  // W1-T10028: the selector's own ordered eligible set and the context whose fan-out slots were dealt over it —
  // never the eligibility walk's order or the pre-pass context, which dealt slots to tasks that cannot dispatch.
  const eligible: Task[] = [];
  const selection: { eligible: Task[]; context: DispatchValueContext | undefined; opts: NextRunnableOpts } = {
    eligible, context: opts.dispatchValueContext,
    opts: { ...opts, onEligibleOrdered: (ordered, context) => {
      opts.onEligibleOrdered?.(ordered, context);
      eligible.length = 0;
      eligible.push(...ordered);
      selection.context = context;
    } },
  };
  return selection;
}

export function dispatchPickPayload(
  task: Task, site: "tick" | "lane-refill", eligible: readonly Task[], context: DispatchValueContext | undefined,
  started: readonly Task[], occupied: readonly Task[], observed: ObservedScopeByTask,
): Record<string, unknown> {
  const startedIds = new Set(started.map(t => t.id));
  const runner = eligible.find(t => !startedIds.has(t.id));
  const serialized = runner && !partitionByFileOverlap([...occupied, ...started, runner], observed).dispatch.includes(runner);
  return {
    task: task.id, site, rank: Math.max(1, eligible.findIndex(t => t.id === task.id) + 1),
    ...explainDispatchScore(task, context),
    runner_up: runner ? { task: runner.id, ...explainDispatchScore(runner, context), reason: serialized ? "serialized" : "order" } : null,
  };
}

/** W1-T9680: the fleet credential probe's answer. Only `alive` makes a lane's credential refusal lane-local. */
export type FleetCredentialProbe = { state: "alive" } | { state: "refused" | "unreadable"; detail: string };

/** W1-T9680: where the probe's push token comes from — a mint like the credential socket's, or a fixed token. */
export type PushTokenSource = () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;

/** W1-T9680: the token a worker push sends — the credential socket's scoped mint while it listens, else GH_TOKEN. */
export function daemonPushTokenSource(
  repo: string,
  mint: ((repo: string) => ReturnType<PushTokenSource>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PushTokenSource {
  return async () => {
    if (mint) return mint(repo);
    const token = env.GH_TOKEN;
    return token ? { ok: true, token } : { ok: false, reason: "GH_TOKEN is not set" };
  };
}

/**
 * W1-T9680 — the fleet push credential probe: receive-pack discovery at `originUrl` with the token a worker push
 * sends. The repo is public, so an upload-pack read (`git ls-remote`) answers 200 with no credential at all;
 * receive-pack answers 401 to a missing or wrong token and pushes nothing. Bounded by loop-available time.
 */
export function receivePackCredentialProbe(opts: {
  originUrl: string;
  token: PushTokenSource;
  timeoutMs?: number;
  clock?: Clock;
}): () => Promise<FleetCredentialProbe> {
  return async () => {
    const minted = await opts.token().catch((error: unknown) => ({ ok: false as const, reason: String((error as Error)?.message ?? error) }));
    if (!minted.ok) return { state: "refused", detail: `no push token: ${minted.reason}` };
    const controller = new AbortController();
    const cancel = loopAvailableDeadline(opts.clock ?? systemClock, opts.timeoutMs ?? 15_000, () => controller.abort());
    try {
      const auth = Buffer.from(`x-access-token:${minted.token}`).toString("base64");
      const url = `${opts.originUrl.replace(/\/+$/, "")}/info/refs?service=git-receive-pack`;
      const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: controller.signal });
      await response.body?.cancel();
      if (response.status === 200) return { state: "alive" };
      const state = response.status === 401 || response.status === 403 ? "refused" : "unreadable";
      return { state, detail: `receive-pack discovery answered HTTP ${response.status}` };
    } catch (error) {
      return { state: "unreadable", detail: `receive-pack discovery failed: ${String((error as Error)?.message ?? error)}` };
    } finally {
      cancel();
    }
  };
}

/** W1-T5083: a rejection the settle loop treats as lane-local (it logs and the pass continues). */
function refillLaneLocalRejection(err: unknown): boolean {
  if (transientGhDispatchFailure(err) !== undefined || isSpawnInfraBlocked(err)) return false;
  // W1-T5344: one task's delivery failure is lane-local too — it parks that task, never its siblings.
  return ghLaneReadFailure(err) !== undefined || laneDeliveryFailure(err) !== undefined;
}

function ghLaneReadFailure(err: unknown): { detail: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const failure = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
  const message = String(failure.message ?? "");
  if (!/(?:^|\s)gh(?:\s|$)/i.test(message)) return undefined;
  if (!/commits\/[^/\s]+\/(?:check-runs|status)\b/i.test(message)) return undefined;
  const detail = [message, failure.stderr == null ? "" : String(failure.stderr), failure.code ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
  return { detail };
}

/** BACKSTOP — the maximum time the inter-phase review clock's stop may wait for an idle wait to notice its phase
 * ended. The wait seam is deliberately promise-only with no cancellation handle, so waiting out the whole poll
 * interval would add up to 60 seconds to every phase transition. The clock therefore subdivides only its in-process
 * wait into one-second quanta, while the poll interval stays the cadence that may start a light pass. No read or
 * reconciliation runs on the quantum itself (W1-T2852). */
export const INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS = 1_000;

/** W1-T4053 — what one light pass may act on. The ordinary pass opens its fix rung whenever nothing is in
 * flight (W1-T1211), and a freshness drain has nothing in flight by construction, so a fix admitted there
 * would detach one more action into the very drain it runs beside. `reviewOnly` closes every lane but review. */
export interface LightPassScope {
  readonly reviewOnly: boolean;
  /** W1-T9569: WHY the pass is review-only, so its stand-downs name it; an ordinary pass passes none. */
  readonly scope?: LightPassScopeName;
  /** W1-T9808: present only while a restart is latched; the pass asks it before each review or fix it admits. */
  readonly admit?: RestartAdmission;
}

/** W1-T9808: a latched restart's admission predicate. A call without `surface` is a probe: no hold row, no count. */
export type RestartAdmission = (
  kind: "review" | "fix-dispatch" | "dispatch-refill", surface?: "light" | "light-refill" | "full-sweep", lengthMs?: number,
) => boolean;

/** W1-T9808: may this light pass open its fix lanes? Never on a review-only pass, nor when the latch refuses a fix. */
export function lightPassFixAdmitted(scope?: LightPassScope): boolean {
  return scope?.reviewOnly !== true && scope?.admit?.("fix-dispatch", "light") !== false;
}

interface InterphaseReviewClock {
  /** Stops new admission, lets an already-started pass settle, and reports whether this clock
   * consumed an event edge that the ordinary full-sweep gate still needs to reconcile, and how
   * many passes it admitted. */
  stop(): Promise<{ eventWakeSeen: boolean; passes: number; held: number }>;
  /** W1-T5803: an event wake the caller's own sleep consumed, handed on so this clock passes for it. */
  handWake(): void;
  /** Passes admitted so far, read without stopping the clock. */
  passCount(): number;
}

/** The memory half of `daemon.alive` (W1-T6782). A throwing sampler must never cost the heartbeat
 *  the watchdog and doctor read, so its error rides the row instead of escaping the tick. */
function readMemoryTelemetrySafely(deps: Pick<DaemonDeps, "readMemoryTelemetry">): Record<string, unknown> {
  if (!deps.readMemoryTelemetry) return {};
  // W1-T8883: the same heartbeat feeds the heap-ceiling shadow (rate-limited there); it never costs the heartbeat.
  try { installedHeapShadow()?.sampleNow(); } catch { /* Reason: observability only; the shadow is report-only. */ }
  try {
    return deps.readMemoryTelemetry();
  } catch (e) {
    return { mem_telemetry: `error:${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
}

/** W1-T7126: when each sampler last rode a row, keyed by the sampler itself, so the main loop's
 *  `daemon.tick` and every in-flight ticker's `daemon.alive` share one reading with no new parameter. */
const memorySampledAtMs = new WeakMap<object, number>();

/** W1-T7126: the `daemon.alive` memory sample, stamped so a tick within one poll interval defers to it. */
function aliveMemorySample(deps: Pick<DaemonDeps, "readMemoryTelemetry">, nowMs: number): Record<string, unknown> {
  if (!deps.readMemoryTelemetry) return {};
  memorySampledAtMs.set(deps.readMemoryTelemetry, nowMs);
  return { ...readMemoryTelemetrySafely(deps), mem_sample_via: "alive" };
}

/** W1-T7126: an idle daemon writes `daemon.tick` and never `daemon.alive`, so the tick carries the same
 *  sample, but only when no row has carried one within `pollIntervalMs`. The reference starts at boot, so
 *  a dispatch's first heartbeat stays the first row to start the thread heap read (W1-T7092). Nothing
 *  here sleeps, schedules or wakes: a loop that does not iterate leaves a visible gap. */
function tickMemorySample(
  deps: Pick<DaemonDeps, "readMemoryTelemetry">, nowMs: number, pollIntervalMs: number, taken: { sampled: boolean },
): Record<string, unknown> {
  taken.sampled = false;
  if (!deps.readMemoryTelemetry) return {};
  const lastMs = memorySampledAtMs.get(deps.readMemoryTelemetry);
  if (lastMs === undefined) {
    memorySampledAtMs.set(deps.readMemoryTelemetry, nowMs);
    return {};
  }
  if (nowMs - lastMs < pollIntervalMs) return {};
  memorySampledAtMs.set(deps.readMemoryTelemetry, nowMs);
  taken.sampled = true;
  return { ...readMemoryTelemetrySafely(deps), mem_sample_via: "tick" };
}

/** W1-T7092: start the thread heap read only AFTER `daemon.alive` is written, never awaited. */
function startMemoryReadAfterRow(deps: Pick<DaemonDeps, "readMemoryTelemetry">, log: (step: string, extra?: Record<string, unknown>) => void): void {
  try {
    deps.readMemoryTelemetry?.afterRow?.();
  } catch (e) {
    log("daemon.memory_read_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}

/** W1-T7745: what the spawns of THIS consumer's own interval were, read and closed so the next row starts clean.
 *  Spread into a `reportLoopLag` sample; a daemon without the sampler contributes neither field. */
export function takeSyncSpawn(deps: Pick<DaemonDeps, "readLoopTelemetry">, consumer: string):
  { syncSpawnTop?: unknown; syncSpawnMs?: number; syncSpawnByCaller?: unknown[]; syncSpawnUnnamedMs?: number;
    asyncSpawnSyncMs?: number; asyncSpawnByCaller?: unknown[] } {
  try {
    const taken = deps.readLoopTelemetry?.takeLagInterval?.(consumer);
    return taken === undefined ? {} : { syncSpawnTop: taken.top, syncSpawnMs: taken.sync_spawn_ms,
      syncSpawnByCaller: taken.by_caller, syncSpawnUnnamedMs: taken.unnamed_ms,
      asyncSpawnSyncMs: taken.async_spawn_sync_ms, asyncSpawnByCaller: taken.async_by_caller };
  } catch { return {}; /* Reason: observability only. */ }
}

/** W1-T7746: report a tick's lag, and first hand it to the loop-stall profiler, which sets its bound from
 *  this interval and these lags. A daemon without the sampler reports exactly as before. */
export function reportTickLag(deps: Pick<DaemonDeps, "readLoopTelemetry">, sample: Parameters<typeof reportLoopLag>[0],
  log: (step: string, extra?: Record<string, unknown>) => void): void {
  try {
    deps.readLoopTelemetry?.observeLoopLag?.({ lagMs: sample.observedAtMs - sample.dueAtMs, intervalMs: sample.intervalMs }, log);
  } catch (error) {
    log("daemon.loop_stall_profile_failed", { reason: `observe: ${String((error as Error)?.message ?? error).slice(0, 160)}` });
  }
  reportLoopLag(sample, log);
}

/**
 * W1-T4041 — REPORT A TICK THAT CAME BACK LATE, AND NAME THE PHASE THAT WAS IN FORCE.
 *
 * On 2026-09-22 three lanes went silent TOGETHER for 34 minutes while the process stayed alive and
 * later continued: `daemon.alive` (13:05:54Z to 13:40:02Z), the inter-phase review clock (last row
 * 13:19:23.868Z) and the sweep (13:19:23Z to 13:40:53Z). They share exactly one property — all three
 * are timer-driven on this event loop. Every lane that could have reported the outage was frozen by
 * it, so absence of evidence was the only evidence, and reasoning from it produced two wrong root
 * causes before this one.
 *
 * THE THRESHOLD IS DERIVED, NOT PICKED: an overrun is reported only when the tick came back later
 * than one WHOLE interval past its due time, i.e. at least one tick was missed. That scales with
 * whatever interval the caller is running and needs no tuning.
 *
 * WHAT IT CANNOT DO, STATED RATHER THAN HIDDEN: a sampler on the blocked loop records nothing WHILE
 * the block is in force — it reports the lag it just suffered, on the first tick that runs after the
 * block clears. That is a real limit, and it is why this reports rather than gates.
 *
 * Swallows everything: observability must never be able to take down the loop it observes.
 */
export function reportLoopLag(
  sample: { phase: string; dueAtMs: number; observedAtMs: number; intervalMs: number; lastStepBeforeBlock?: string;
    /** W1-T5718: the longest synchronous spawn of the interval this lag closes (W1-T7745: its own interval's). */
    syncSpawnTop?: unknown;
    /** W1-T7745: the synchronous spawn time of that same interval, so a row says how much of its lag was spawn. */
    syncSpawnMs?: number; syncSpawnByCaller?: unknown[]; syncSpawnUnnamedMs?: number; // W1-T9577
    /** W1-T9754: the same interval's async spawns: the time each held the loop inside its own spawn call. */
    asyncSpawnSyncMs?: number; asyncSpawnByCaller?: unknown[] },
  log: (step: string, extra?: Record<string, unknown>) => void,
): void {
  try {
    const lagMs = sample.observedAtMs - sample.dueAtMs;
    if (!(lagMs > sample.intervalMs)) return;
    log("daemon.loop_lag", {
      phase: sample.phase,
      lag_ms: Math.round(lagMs),
      interval_ms: sample.intervalMs,
      missed_ticks: Math.floor(lagMs / sample.intervalMs),
      last_step_before_block: sample.lastStepBeforeBlock,
      ...(sample.syncSpawnTop === undefined ? {} : { sync_spawn_top: sample.syncSpawnTop }),
      ...(sample.syncSpawnMs === undefined ? {} : { sync_spawn_ms: sample.syncSpawnMs }),
      ...(sample.syncSpawnByCaller === undefined ? {} : { sync_spawn_by_caller: sample.syncSpawnByCaller }),
      ...(sample.syncSpawnUnnamedMs === undefined ? {} : { sync_spawn_unnamed_ms: sample.syncSpawnUnnamedMs }),
      ...(sample.asyncSpawnSyncMs === undefined ? {} : { async_spawn_sync_ms: sample.asyncSpawnSyncMs }),
      ...(sample.asyncSpawnByCaller === undefined ? {} : { async_spawn_sync_by_caller: sample.asyncSpawnByCaller }),
    });
  } catch {
    // Reason: a throwing logger must cost the reading, never the tick.
  }
}

/** A `"pause"` clock runs through operator holds, but a recycle PAUSE must drain without new reviews. */
export type InterphaseReviewClockScope = "drain" | "pause";

/** The review-only clock for the part of an iteration that previously had none: after the full
 *  reconciliation await returns and before a phase ticker or an idle wait takes over. It owns only
 *  the light pass, so it adds no action that pass does not already take — which, with nothing in
 *  flight, includes a fix (W1-T1211); a `scope` closes that lane. A wake
 *  observed during an active pass stays pending. W1-T4732 permits one review-only follow-up
 *  beside a slow pass, while further wakes coalesce until a slot opens. Forensics: docs/forensics/daemon.md.
 *  W1-T4053: `scope: "drain"` runs it beside a freshness drain, ledgering `during_drain: true`; W1-T4429:
 *  `"pause"` beside a PAUSE's sleep (`during_pause: true`) — a pause stops NEW work, never verdicts.
 *  W1-T8172: `admit`, when given, is probed before each due pass; a refusal spends the slot and counts as `held`.
 *  W1-T9808: an admitted pass carries it, so the pass asks it again for each review. */
export function startInterphaseReviewClock(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  scope?: InterphaseReviewClockScope,
  admit?: RestartAdmission,
): InterphaseReviewClock {
  let active = true;
  let eventWakeSeen = false;
  let eventWakePending = false;
  let elapsedMs = 0;
  let passes = 0;
  let held = 0;
  const activePasses = new Set<Promise<void>>();
  const phase = scope === "drain" ? "freshness_drain" : scope === "pause" ? "pause" : "interphase";
  const scopeTag: Record<string, boolean> =
    scope === "drain" ? { during_drain: true } : scope === "pause" ? { during_pause: true } : {};
  const wait = deps.sleepUntilSweepWake;
  const quantumMs = Math.max(1, Math.min(pollIntervalMs, INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS));
  // W1-T2897 Clock port: the same instant source as `deps.now`, never a second bare `new Date()`
  // in this file (the clock-signature census holds src/lib/daemon.ts at its recorded row).
  const interphaseClock = clockFromDateFn(deps.now);
  // W1-T4045: when the last pass ran, so the interval can be measured in TIME as well as in ticks.
  let lastPassAtMs = interphaseClock.now();
  // This clock exists to consume the durable event signal, and must not synthesize it over the
  // legacy plain wait seam, which cannot be interrupted at a phase boundary. Production always wires
  // the interruptible form; omission retains the exact earlier call cadence.
  const runner = deps.sweepLight && wait
    ? (async () => {
        while (active) {
          const clockDueAtMs = interphaseClock.now() + quantumMs;
          const result = await wait(quantumMs);
          reportTickLag(deps,
            { phase, dueAtMs: clockDueAtMs, observedAtMs: interphaseClock.now(), intervalMs: quantumMs,
              lastStepBeforeBlock: deps.lastStepBeforeBlock?.(), ...takeSyncSpawn(deps, "review_clock") },
            log,
          );
          if (result === "wake") {
            eventWakeSeen = true;
            eventWakePending = true;
          } else {
            // W1-T4045 — COUNT TIME, NOT ONLY TICKS. A late wake used to add the NOMINAL quantum, so when
            // the event loop was blocked between waits (one synchronous ledger-union read measured 9.22 s,
            // W1-T4046) a 60 s interval needed sixty resolved waits — roughly nine minutes of ~9 s blocks.
            // The maximum keeps today's behaviour wherever time does not outrun the ticks (every frozen
            // fixture clock) and fires promptly where it does, so it can never make a pass later.
            elapsedMs = Math.max(elapsedMs + quantumMs, interphaseClock.now() - lastPassAtMs);
          }
          if (!active) break;
          if (!eventWakePending && elapsedMs < pollIntervalMs) continue;
          // W1-T4732: a long reviewer must not hold a newly green head out of the next
          // pass. Keep at most two passes alive; only the first may take the ordinary light
          // actions. When both slots are occupied, retain the wake/time debt for a later tick.
          if (activePasses.size >= 2) continue;

          const halt = deps.checkStop?.() ?? (scope === "pause" ? undefined : deps.checkPause?.());
          if (halt) continue;
          const paused = scope === "pause" ? deps.checkPause?.() : undefined;

          const reviewOnly = scope !== undefined || activePasses.size > 0 || inFlightReviewCount() > 0;
          const trigger = eventWakePending ? "github-event" : "interval";
          eventWakePending = false;
          elapsedMs = 0;
          lastPassAtMs = interphaseClock.now();
          if (isRecyclePauseDetail(paused)) {
            held += 1;
            log("daemon.review_clock.held", { trigger, ...scopeTag, detail: paused, reason: "recycle_pause" });
            continue;
          }
          if (admit && !admit("review")) {
            held += 1;
            continue;
          }
          passes += 1;
          const pass = (async () => {
            try {
              const named = { reviewOnly: true, scope: scope ?? "interphase-review" } as const;
              await (reviewOnly ? deps.sweepLight!(admit ? { ...named, admit } : named) : deps.sweepLight!());
              if (reviewOnly) log("daemon.review_clock.pass", { trigger, ...scopeTag, review_only: true });
              if (trigger === "github-event") log("daemon.review_clock.wake_consumed", { trigger, ...scopeTag });
            } catch (e) {
              log("daemon.sweep_light.failed", { phase, ...scopeTag, error: String((e as Error)?.message ?? e) });
            }
          })();
          activePasses.add(pass);
          void pass.finally(() => activePasses.delete(pass));
        }
      })()
    : undefined;

  return {
    stop: async () => {
      active = false;
      if (runner) await runner;
      if (activePasses.size > 0) await Promise.all(activePasses);
      return { eventWakeSeen, passes, held };
    },
    handWake: () => {
      eventWakeSeen = true;
      eventWakePending = true;
    },
    passCount: () => passes,
  };
}

export interface PauseHoldOwner {
  pid: string;
  host: string;
  sessionId?: string;
  reason?: string;
}

export interface PauseHoldGovernorInput extends PauseTierInput {
  /** The anchor sha, or `"local"`: a NEW hold never inherits an old hold's tier. */
  holdId: string;
  owner: PauseHoldOwner;
}

/** The last tier seen for ONE hold (keyed by `holdId`, process-lifetime), so a transition ledgers once. */
export interface PauseHoldGovernorState {
  lastTier?: PauseTier;
}

/** W1-T4429 design (ii): on a TRANSITION only, ledger `pause.<tier>`. `orphaned` leaves the hold alone;
 *  `needs_human` pages via `onPauseNeedsHuman` (a throw ledgers `pause.needs_human_failed`); `lapsed`
 *  calls `clearPauseHold`. `held` ledgers nothing. Returns the tier. */
export async function stepPauseHoldGovernor(
  input: PauseHoldGovernorInput,
  state: PauseHoldGovernorState,
  deps: Pick<DaemonDeps, "clearPauseHold" | "onPauseNeedsHuman">,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<PauseTier> {
  const tier = evaluatePauseTier(input);
  if (tier === state.lastTier) return tier;
  state.lastTier = tier;
  const base = {
    hold_id: input.holdId,
    owner_pid: input.owner.pid,
    owner_host: input.owner.host,
    owner_session: input.owner.sessionId ?? null,
    reason: input.owner.reason ?? null,
  };
  if (tier === "orphaned") {
    log("pause.orphaned", base);
  } else if (tier === "needs_human") {
    log("pause.needs_human", { ...base, expires_at: input.expiresAt });
    try {
      await deps.onPauseNeedsHuman?.({ holdId: input.holdId, owner: input.owner, expiresAt: input.expiresAt });
    } catch (e) {
      log("pause.needs_human_failed", { ...base, error: String((e as Error)?.message ?? e) });
    }
  } else if (tier === "lapsed") {
    log("pause.lapsed", { ...base, expires_at: input.expiresAt });
    await deps.clearPauseHold?.();
  }
  return tier;
}


// ── W1-T4390: the SRE governor's SECOND enforcer ──────────────────────────────────────────────

/** Text the step writes into the lane's pause switch for a global hold — and the ONLY text it will
 *  remove, so an operator's own pause, or a runbook stop, is never lifted by a hold ending. */
export const SRE_GOVERNOR_GLOBAL_HOLD_TEXT = "sre-governor global hold";

const isLiveAct = (r: SreRunbookReceipt): boolean => r.mode === "live" && (r.outcome === "cleared" || r.outcome === "failed");

/** One tick of the core daemon's governor: `sreGovernorVerdict` over the SRE instance's ledger —
 *  never the lane's memory — ledgering each tier change as an `sre.governor` row. A runbook newly
 *  stopped (flapping, harm twice), or one that acted AFTER its stop (a lane that skipped its own
 *  check), pauses the lane and escalates to the operator; a global hold pauses the lane only while
 *  it holds. Nothing happens for a ledger with no receipts. Returns the verdicts. */
export function stepSreGovernor(
  enforcer: SreGovernorEnforcer,
  controls: SreGovernorControls,
  log: (step: string, extra?: Record<string, unknown>) => void,
  nowMs: number,
): Record<string, SreGovernorVerdict> {
  const rows = enforcer.readLedger();
  const receipts = rows.map((row) => receiptFromLedgerRow(row)).filter((r): r is SreRunbookReceipt => r !== undefined);
  if (receipts.length === 0) return {};
  const incidents = rows.map((row) => governorIncidentFromLedgerRow(row)).filter((e): e is SreGovernorIncident => e !== undefined);
  const verdicts = sreGovernorVerdict(receipts, incidents, controls, nowMs);
  const previous = governorTiersFromLedger(rows);
  let globalHeld = false;
  for (const [runbook, verdict] of Object.entries(verdicts)) {
    const prev = previous.get(runbook);
    const global = verdict.global === true;
    if (prev?.tier !== verdict.tier || prev.global !== global) {
      log(SRE_GOVERNOR_STEP, { runbook, from: prev?.tier ?? "none", to: verdict.tier, reason: verdict.reason, evidence: verdict.evidence ?? [], global });
    }
    if (verdict.tier !== "stopped") continue;
    if (global) {
      globalHeld = true;
      continue;
    }
    const wasStopped = prev?.tier === "stopped" && !prev.global;
    const bypassed = wasStopped && receipts.some((r) => r.id === runbook && isLiveAct(r) && (r.ts_ms ?? 0) > prev.atMs);
    if (wasStopped && !bypassed) continue;
    enforcer.pauseLane(`sre-governor: ${runbook} stopped — ${verdict.reason}\n`);
    log("sre.governor.lane_paused", { runbook, reason: verdict.reason, bypassed });
    if (bypassed) continue; // the operator was paged at the stop itself; a bypass re-pauses, quietly.
    if (!enforcer.escalate) {
      log("sre.governor.escalation_unwired", { runbook, reason: verdict.reason });
      continue;
    }
    const url = enforcer.escalate(sreGovernorEscalation(runbook, verdict));
    log("sre.governor.escalated", { runbook, issue_url: url ?? null });
  }
  const off = enforcer.laneOff();
  if (globalHeld && off === undefined) {
    enforcer.pauseLane(`${SRE_GOVERNOR_GLOBAL_HOLD_TEXT}\n`);
    log("sre.governor.lane_paused", { global: true });
  } else if (!globalHeld && off?.startsWith(SRE_GOVERNOR_GLOBAL_HOLD_TEXT)) {
    enforcer.resumeLane();
    log("sre.governor.lane_resumed", { global: true });
  }
  return verdicts;
}

/** The needs-human issue for a governor stop — one per runbook, whatever incident was burning. */
function sreGovernorEscalation(runbook: string, verdict: SreGovernorVerdict): Escalation {
  return {
    class: "BLOCKED",
    taskId: `SRE-GOVERNOR-${runbook}`,
    summary: `SRE governor stopped runbook ${runbook}: ${verdict.reason}`,
    detail: [
      `The core daemon's SRE governor stopped runbook \`${runbook}\` and paused the SRE lane (state/SRE_LANE_OFF).`,
      ``,
      `Reason: ${verdict.reason}`,
      ``,
      `Evidence:`,
      ...(verdict.evidence?.length ? verdict.evidence.map((e) => `- ${e}`) : ["- (none recorded)"]),
    ].join("\n"),
    options: [
      { label: "Fix the cause, then resume the lane", detail: "Remove state/SRE_LANE_OFF; the stopped runbook stays held until its evidence ages out of the governor's memory." },
      { label: "Leave the lane paused", detail: "Incidents keep filing through the ordinary feedback pipeline only once the lane resumes." },
    ],
    recommendation: "Fix the cause, then resume the lane",
    headDedup: "independent",
    consequence: "The SRE lane stays paused: no runbook acts and no incident is filed from it.",
  };
}
/** Wraps a fired retro, and auto-triage, in the same restricted light-sweep ticker dispatch already uses. Either is an
 * unbounded await, so without a ticker the whole reconciliation went dark for its duration — measured 22.0 and 21.0
 * minutes across the two retro firings, zero dispositions in either window (W1-T276). Only the light pass is ticked
 * here, never full dispatch: the retro already spends a real run. Forensics: docs/forensics/daemon.md. */
async function sweepLightDuringRetro(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  run: () => Promise<void>,
  diskHeadroomLatch: { escalated: boolean },
  sweepRetrigger?: SweepRetrigger,
): Promise<void> {
  const ticker = startInFlightTicker(deps, pollIntervalMs, log, "retro", diskHeadroomLatch, sweepRetrigger);
  try {
    await run();
  } finally {
    await ticker.stop();
  }
}

/** The in-flight ticker — the one thing that runs while the daemon is blocked on unbounded awaited
 * work, and the only writer of the liveness row.
 *
 * Why a liveness row: every other daemon-prefixed step is written when a tick closes, so a daemon
 * inside a long dispatch was byte-identical to a dead one. Measured over 898 iterations, the gap to
 * the next daemon-prefixed row runs p50 2.4m and p90 39.5m. Both liveness readers select on the
 * PREFIX, so one row corrects the console, the health route and the off-machine heartbeat at once.
 *
 * Traps, all load-bearing: the row carries the poll interval because the console reads that field off
 * the winning line; it is logged before the light pass, so a pass that hangs cannot suppress it; and
 * the start condition stays coupled to the light-pass hook, because eight suites count waits as their
 * idle proxy. Disk headroom rides this same row (W1-T1082), and a supplied retrigger lets this ticker
 * re-fire the full pass on its own cadence (W1-T1272). Forensics: docs/forensics/daemon.md. */
/** W1-T2981 — ONE in-flight ticker at a time, process-wide. Before the retro was detached only one
 *  rung could be blocked at once, so overlap was impossible by construction. A detached retro keeps
 *  its ticker while the tick proceeds into dispatch, which starts its own — and two tickers each run
 *  `sweepLight` on the poll cadence, doubling GitHub calls exactly when the fleet is busiest. This
 *  repo has already lost 90 minutes to a secondary rate limit, so unrelated contenders receive an
 *  inert stub. A same-tick dispatch is different: it takes over the retro runner atomically, without
 *  overlapping a light pass, and the retro handle loses stop authority. */
interface InFlightTickerOwner {
  active: boolean;
  generation: number;
  phase: "dispatch" | "retro" | "sweep";
  headroomSampler?: { lastSampleMs: number; clock: Clock; policy: HeadroomPolicy; enforced: boolean };
  /** Read per tick, so a dispatch taking over a background sweep's runner also takes its retrigger (W1-T4998). */
  sweepRetrigger?: SweepRetrigger;
  onTick?: () => void | Promise<void>;
  /** W1-T4998: a background sweep still holding the runner a dispatch took over. Whichever of the two
   *  stops first leaves it to the other, so a pass that outlives the dispatch keeps its heartbeat. */
  sweepHold?: Pick<InFlightTickerOwner, "generation" | "headroomSampler" | "sweepRetrigger">;
  /** W1-T5343: how many dispatch lanes are still in flight. Absent (retro, sweep) reads as none, and so does
   *  the reader a sweep hold keeps after its dispatch ended: that dispatch's pool had already drained to 0. */
  lanesInFlight?: () => number;
  ticker?: Promise<void>;
  stop(generation: number): Promise<void>;
}

let inFlightTickerOwner: InFlightTickerOwner | undefined;
/** W1-T5343: the ONE review-only pass a paused phase ticker may have running (the W1-T4732 slot
 *  rule with one slot). Process-wide, so a ticker that stops and a later one cannot hold two. */
let pausedReviewPass: Promise<void> | undefined;
/** Process-wide, so a generation handed back to a sweep's hold is never issued to a later holder. */
let inFlightTickerGenerations = 0;

/** The most stale the account-headroom reading may be before the in-flight ticker takes its own. The
 * governor sampled on the loop whose duration it was meant to bound: the reading is written once per
 * iteration, after the pass carrying the largest spender, so sampling rate was inversely coupled to
 * spend. Measured 2026-09-01, gaps run median 158s but p95 4,400s and max 21,586s, and in one
 * 58-minute window the account went from 30% used to exhausted while the governor held its last
 * value. The cadence already existed and disk headroom already rode it. 300s bounds staleness rather
 * than setting a rate, so on a healthy fleet this fires never: BACKSTOP, not the primary control.
 * Policy data (rule 2). Forensics: docs/forensics/daemon.md. */
export const HEADROOM_SAMPLE_MAX_AGE_MS = 300_000;

function startInFlightTicker(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  phase: "dispatch" | "retro" | "sweep",
  diskHeadroomLatch: { escalated: boolean },
  sweepRetrigger?: SweepRetrigger,
  // The last account-headroom sample's wall clock, shared with the main loop so the two samplers
  // cannot double-read. Optional and trailing, so every existing call site is unchanged (W1-T2565).
  headroomSampler?: { lastSampleMs: number; clock: Clock; policy: HeadroomPolicy; enforced: boolean },
): { stop: () => Promise<void> } {
  const onTick = phase === "dispatch" ? sweepRetrigger?.onDispatchTick : undefined;
  const lanesInFlight = phase === "dispatch" ? sweepRetrigger?.lanesInFlight : undefined;
  if (!deps.sweepLight && !onTick) return { stop: async () => {} };
  // W1-T3181: dispatch takes over a same-tick retro's ONE runner. Incrementing the generation makes
  // the retro's eventual stop inert, so it cannot turn off the dispatch clock after the handoff.
  // W1-T4998: the same takeover applies to a background full sweep's runner.
  if (inFlightTickerOwner) {
    if (phase !== "dispatch" || inFlightTickerOwner.phase === "dispatch") return { stop: async () => {} };
    if (inFlightTickerOwner.phase === "sweep") {
      const { generation: held, headroomSampler: heldSampler, sweepRetrigger: heldRetrigger } = inFlightTickerOwner;
      inFlightTickerOwner.sweepHold = { generation: held, headroomSampler: heldSampler, sweepRetrigger: heldRetrigger };
    }
    inFlightTickerOwner.phase = "dispatch";
    inFlightTickerOwner.headroomSampler = headroomSampler;
    inFlightTickerOwner.sweepRetrigger = sweepRetrigger;
    inFlightTickerOwner.onTick = onTick;
    inFlightTickerOwner.lanesInFlight = lanesInFlight;
    const generation = (inFlightTickerOwner.generation = ++inFlightTickerGenerations);
    const owner = inFlightTickerOwner;
    return { stop: () => owner.stop(generation) };
  }
  const owner: InFlightTickerOwner = {
    active: true,
    generation: ++inFlightTickerGenerations,
    phase,
    headroomSampler,
    sweepRetrigger,
    onTick,
    lanesInFlight,
    stop: async (generation) => {
      if (inFlightTickerOwner !== owner) return;
      const hold = owner.sweepHold;
      if (hold && generation === hold.generation && generation !== owner.generation) {
        owner.sweepHold = undefined; // the pass settled first: the dispatch's stop now ends the runner
        return;
      }
      if (owner.generation !== generation) return;
      if (hold) {
        // The dispatch ended first: the runner returns to the pass still running, with its own stop.
        owner.sweepHold = undefined;
        owner.phase = "sweep";
        owner.generation = hold.generation;
        owner.headroomSampler = hold.headroomSampler;
        owner.sweepRetrigger = hold.sweepRetrigger;
        owner.onTick = undefined;
        return;
      }
      owner.active = false;
      // Release the global slot THE INSTANT this stop is accepted, never deferred until the
      // ticker's own loop notices `active = false` and its outstanding iteration finishes. A
      // deferred release was tried and reverted (W1-T2744's own review-clock test caught it): the
      // very next phase transition (an abandoned sweep's dispatch ticker, or the interphase clock)
      // runs essentially back-to-back with this stop, reads the slot as still occupied, and is
      // silently no-op'd for that whole phase -- no heartbeat, no light pass, nothing to release a
      // runOne that is itself waiting on that light pass. A light pass is best-effort and may
      // outlive the full sweep it rode; AWAITING it here turns the sweep's wall-clock bound into
      // an unbounded wait, which is the other half of the same defect this stop must not
      // reintroduce.
      inFlightTickerOwner = undefined;
      // The now-orphaned ticker cannot start a SECOND iteration on its own: `while (owner.active)`
      // and the post-sleep `if (!owner.active) break` both already read false, so at most the one
      // call already in flight (if any) is left to finish, tracked here only so its eventual
      // failure is logged rather than becoming an unhandled rejection.
      if (owner.ticker) {
        void owner.ticker.catch((e) => {
          log("daemon.in_flight_ticker.failed", { phase: owner.phase, error: String((e as Error)?.message ?? e) });
        });
      }
    },
  };
  inFlightTickerOwner = owner;
  // Reads through the Clock port (W1-T2897) rather than the `() => Date` shape directly, so every
  // projection this function needs — millis, Date, ISO — comes from one adapted instant.
  const daemonClock = clockFromDateFn(deps.now);
  // A wake edge is consumed when it shortens a wait, but its durable marker is not claimed until the
  // gate accepts a pass. Retain that intent across a hold or an older still-settling pass, and retry
  // once per ordinary cadence, never as a zero-delay loop.
  let eventWakePending = false;
  owner.ticker = deps.sweepLight || onTick
    ? (async () => {
        while (owner.active) {
          // Dispatch and retro can hold the loop for tens of minutes, so let an event wake this wait only
          // when the ticker owns the retrigger. The nested ticker inside a full pass stays on the ordinary
          // clock, so an event arriving then remains pending for one later accepted pass (W1-T2568).
          const tickDueAtMs = daemonClock.now() + pollIntervalMs;
          const waitResult = await (owner.sweepRetrigger ? (deps.sleepUntilSweepWake ?? deps.sleep) : deps.sleep)(pollIntervalMs);
          const lastStepBeforeBlock = deps.lastStepBeforeBlock?.();
          reportTickLag(deps,
            { phase: owner.phase, dueAtMs: tickDueAtMs, observedAtMs: daemonClock.now(), intervalMs: pollIntervalMs, lastStepBeforeBlock,
              ...takeSyncSpawn(deps, "ticker") },
            log,
          );
          if (waitResult === "wake") eventWakePending = true;
          if (!owner.active) break;
          if (owner.onTick) await new Promise<void>((resolve) => setImmediate(resolve));
          if (!owner.active) break;
          const ticked = owner.onTick?.();
          if (ticked) {
            await ticked;
            if (!owner.active) break;
          }
          // The acknowledgement gap (W1-T1065 part iv). The pause row is written only inside the branch that acts
          // on a hold, so a hold created mid-drain was invisible: no row distinguished "seen, draining to
          // completion" from "not seen at all", and the operator escalated to a container stop. A re-check here
          // can never abort the batch already in flight; it only makes the two cases distinguishable.
          const holdSeen = owner.phase === "dispatch" ? Boolean(deps.checkPause?.()) : undefined;
          // Pre-judged by the CLI wiring against the same definition `rmd doctor` reports, so this pure
          // module never re-derives the boundary. A reading back at OK re-arms the latch, so a genuinely new
          // episode escalates again (W1-T1082).
          const diskHeadroom = deps.readDiskHeadroom?.();
          if (diskHeadroom?.verdict === "OK") diskHeadroomLatch.escalated = false;
          log("daemon.alive", {
            ...deps.readLoopTelemetry?.(),
            ...aliveMemorySample(deps, daemonClock.now()),
            phase: owner.phase,
            poll_interval_ms: pollIntervalMs,
            // W1-T2744: bounded cardinality on the existing heartbeat, never a promise-poll row.
            // This distinguishes a live review clock plus settling fix from the measured wedge.
            detached_sweep_actions: detachedSweepActionCount(),
            ...(holdSeen !== undefined ? { pause_seen: holdSeen } : {}),
            ...(diskHeadroom?.freeBytes !== undefined ? { disk_free_bytes: diskHeadroom.freeBytes } : {}),
          });
          startMemoryReadAfterRow(deps, log);
          // W1-T7093: the reservation tree must be refreshed by the real recurring heartbeat,
          // not merely by worker start/release calls. Best-effort, after the liveness row so a
          // slow or failed ledger walk cannot erase this tick's heartbeat.
          if (deps.sweepHostMemoryReservations) {
            try {
              deps.sweepHostMemoryReservations();
            } catch (e) {
              log("daemon.host_memory_reservation_sweep.error", { error: String((e as Error)?.message ?? e) });
            }
          }
          // W1-T3378: a `review-PR*` worktree a SIGKILL stranded is never revisited by anything
          // in-process (materializeReviewWorktree/withMaterializedWorktree's teardown are both
          // `finally`-only), so this out-of-process sweep is what actually reclaims it. Best-
          // effort — a thrown sweep is caught and logged, never allowed to take the tick down.
          if (deps.sweepStrandedReviewWorktrees) {
            try {
              deps.sweepStrandedReviewWorktrees();
            } catch (e) {
              log("daemon.review_worktree_sweep.error", { error: String((e as Error)?.message ?? e) });
            }
          }
          // W1-T3528: the sweep above reaps whole `review-PR*` trees; this one reaps regenerable
          // build output INSIDE trees that must be kept, which no rung could express before. It
          // no-ops entirely while the swept filesystem has headroom. Same best-effort contract.
          if (deps.sweepReclaimableArtifacts) {
            try {
              deps.sweepReclaimableArtifacts();
            } catch (e) {
              log("daemon.disk_artifact_sweep.error", { error: String((e as Error)?.message ?? e) });
            }
          }
          // Sample account headroom once the last reading has gone stale. Placed after the liveness write on purpose:
          // this tick's heartbeat is already on the ledger before the probe is awaited, so a slow probe can delay the
          // next heartbeat but never swallow this one. Telemetry, not enforcement — a reading taken here cannot abort
          // work in flight, and the main loop remains the single place that decides to idle (W1-T2565).
          if (owner.headroomSampler && deps.readUsage) {
            const nowMs = owner.headroomSampler.clock.now();
            if (nowMs - owner.headroomSampler.lastSampleMs >= HEADROOM_SAMPLE_MAX_AGE_MS) {
              owner.headroomSampler.lastSampleMs = nowMs;
              try {
                const snap = await deps.readUsage();
                const reading = snap ? resolveHeadroomWindows(snap, new Date(nowMs), owner.headroomSampler.policy)[0] : undefined;
                if (reading) {
                  log("daemon.headroom", {
                    phase: owner.phase,
                    window: reading.window,
                    percent_used: reading.percentUsed,
                    limit_pct: reading.limitPct,
                    resets_at: reading.resetsAtDisplay,
                    enforced: owner.headroomSampler.enforced,
                    over_ceiling: reading.percentUsed >= reading.limitPct,
                    poll_interval_ms: pollIntervalMs,
                    source: "in-flight",
                  });
                }
              } catch {
                // An unreadable probe is an absent sample, never a fabricated one. The main loop's
                // consecutive-unreadable counter is deliberately not touched here: this sampler must not be able to
                // push the governor into degraded mode on its own.
              }
            }
          }
          // UNREADABLE (`freeBytes === undefined`) NEVER ESCALATES — an absent read is not
          // evidence of a full disk, and treating it as one would page an operator over a
          // transient `statfs` blip rather than an actual breach (design (ii)/(iv)).
          if (diskHeadroom?.freeBytes !== undefined && diskHeadroom.verdict !== "OK" && !diskHeadroomLatch.escalated) {
            diskHeadroomLatch.escalated = true;
            try {
              await deps.onDiskHeadroomBreach?.({
                freeBytes: diskHeadroom.freeBytes,
                verdict: diskHeadroom.verdict,
                ts: daemonClock.iso(),
              });
            } catch (e) {
              log("daemon.escalation.failed", { error: String((e as Error)?.message ?? e) });
            }
          }
          // The retrigger fires the full reconciliation — never the light pass — when the interval has elapsed
          // or an event woke this wait. Why: without it a boot whose phase held the loop for its measured mean
          // of 38.5 minutes got one full pass for that whole span (W1-T1272). Holds are read here on every
          // tick, so an operator's halt withholds a new pass but can never abort the phase's own running work;
          // the elapsed budget keeps accruing while held (W1-T2519). Forensics: docs/forensics/daemon.md.
          const sweepRetrigger = owner.sweepRetrigger;
          if (sweepRetrigger && deps.sweep) {
            const nowMs = daemonClock.now();
            const last = sweepRetrigger.state.lastRunAtMs;
            const trigger = eventWakePending ? "github-event" : "interval";
            if (eventWakePending || last === undefined || nowMs - last >= sweepRetrigger.intervalMs) {
              const halt = deps.checkStop?.() ?? deps.checkPause?.();
              if (halt) {
                log("daemon.sweep.retrigger_held", { phase: owner.phase, detail: halt, trigger });
              } else if (sweepRetrigger.slot.busy()) {
                // W1-T5366: one full pass at a time; a decline leaves `lastRunAtMs` and the wake pending.
                log("daemon.sweep.skipped_concurrent", { phase: owner.phase, trigger, reason: "a full pass is already in flight" });
              } else {
                sweepRetrigger.state.lastRunAtMs = nowMs;
                log("daemon.sweep.retriggered", {
                  phase: owner.phase,
                  trigger,
                  poll_interval_ms: pollIntervalMs,
                  interval_ms: sweepRetrigger.intervalMs,
                });
                // W1-T5366: started, never awaited, so a pass that overruns cannot hold this tick's light pass.
                sweepRetrigger.slot.adopt(runGatedSweep(deps, pollIntervalMs, sweepRetrigger.sweepWallClockBoundMs, log, diskHeadroomLatch, undefined,
                  sweepRetrigger.liveness, undefined, sweepRetrigger.latchedAdmission));
                eventWakePending = false;
              }
            }
          }
          // W1-T4191: the light pass can admit fix and review workers, so an operator PAUSE withholds the
          // ORDINARY pass while the batch drains. Withheld, never aborted: work already in flight finishes.
          // The main loop owns STOP; this clock must keep serving an already admitted retro until it settles.
          const lightHalt = deps.checkPause?.();
          const admit = owner.sweepRetrigger?.latchedAdmission?.();
          if (lightHalt) {
            // W1-T5343: a pause stops new work, never the judging of finished work (W1-T4429 design iii), and
            // 11 dispatch-phase pauses once held ~210 min with 0 reviews. So run ONE review-only pass at a time,
            // which closes the fix rung, requeue and update-branch W1-T4191 needed closed, and only while a
            // lane is in flight, except during a recycle: any new review stretches its drain. STOP wins.
            // `daemon.sweep_light.held` keeps meaning "nothing ran" and names which guard held it.
            const stopped = deps.checkStop?.();
            const heldBy = stopped
              ? "stop"
              : isRecyclePauseDetail(lightHalt)
                ? "recycle_pause"
                : !deps.sweepLight
                  ? "no_light_pass"
                  : pausedReviewPass
                    ? "review_in_flight"
                    : (owner.lanesInFlight?.() ?? 0) === 0
                      ? "no_lane"
                      : undefined;
            if (heldBy) {
              log("daemon.sweep_light.held", { phase: owner.phase, detail: stopped ?? lightHalt, reason: heldBy });
              continue;
            }
            log("daemon.sweep_light.review_only", { phase: owner.phase, detail: lightHalt });
            const pass = (async () => {
              try {
                await deps.sweepLight!(admit ? { reviewOnly: true, scope: "pause", admit } : { reviewOnly: true, scope: "pause" });
              } catch (e) {
                log("daemon.sweep_light.failed", { phase: owner.phase, review_only: true, error: String((e as Error)?.message ?? e) });
              }
            })();
            pausedReviewPass = pass;
            void pass.finally(() => {
              if (pausedReviewPass === pass) pausedReviewPass = undefined;
            });
            continue;
          }
          try {
            await (admit ? deps.sweepLight?.({ reviewOnly: false, admit }) : deps.sweepLight?.());
          } catch (e) {
            log("daemon.sweep_light.failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      })()
    : undefined;
  const generation = owner.generation;
  return { stop: () => owner.stop(generation) };
}

/** The shared config the dispatch and retro call sites pass so they can also re-fire the full
 *  reconciliation on a cadence, not only the light pass. `state` is one mutable ref threaded from
 *  `runDaemon` into every call site — never a fresh object per call, which would make each phase
 *  re-derive "elapsed since last pass" from its own private zero (W1-T1272). */
interface SweepRetrigger {
  onDispatchTick?: () => void | Promise<void>;
  /** W1-T5343: the dispatch phase's live lane count, set per dispatch like `onDispatchTick` and read only there. */
  lanesInFlight?: () => number;
  /** `DaemonOpts.sweepWallClockBoundMs`'s learner: the SAME learned bound the top-of-iteration call uses (W1-T9563). */
  sweepWallClockBoundMs: SweepBoundLearner;
  /** `DaemonOpts.sweepRetriggerIntervalMs` (resolved), the minimum gap between two retriggers. */
  intervalMs: number;
  /** SHARED across every call site — see this interface's own doc. */
  state: { lastRunAtMs: number | undefined };
  /** The same {@link SweepLiveness} the top-of-iteration calls hold. Carried here because the
   *  retrigger is a second route into a concurrent pass that the wall-clock bound does not cover:
   *  measured, the last two pre-fix draft batches were 20m27s apart, this interval rather than the
   *  bound. Optional, so a caller that predates it is unchanged. */
  liveness?: SweepLiveness;
  /** W1-T5366: the main loop's ONE `backgroundSweep` slot. A retrigger starts only when `busy()` is false
   *  and hands its unawaited pass to `adopt`, which feeds the completed-pass queue the loop reads. */
  slot: { busy: () => boolean; adopt: (pass: Promise<SweepCycleOutcome | undefined>) => void };
  /** W1-T9808: the restart's admission predicate while one is latched, else undefined. */
  latchedAdmission?: () => RestartAdmission | undefined;
}

/** The gate itself, extracted so the bound and the light-pass ticker apply identically at every call
 * site: the once-per-iteration call, the stale-freshness call, and a mid-flight retrigger. A second
 * inlined copy is how they could silently drift, and behaviour is byte-identical to the inline block
 * it replaced (W1-T1272). The pass also receives a continuation callback that re-reads STOP and PAUSE.
 * The bound no longer closes it (W1-T9563 reverses W1-T2584): an abandoned pass is healthy-slow, and
 * SweepLiveness plus `reviewAdmissionBound` already bound overlap. Callers must check the hook is defined. */
/** The one piece of state that makes "one pass at a time" true (W1-T2582). `inFlight` is set when a
 * pass starts and cleared when its promise SETTLES — deliberately not when the wall-clock bound stops
 * awaiting it, because the bound stops waiting and never stops the work, and every re-entry the fleet
 * observed landed in that window. Exclusion, not cancellation: an abandoned pass may hold a live
 * worker or a half-written cache, so it runs to completion and the next declines to start. Forensics: docs/forensics/daemon.md. */
export interface SweepLiveness {
  /** True while a `deps.sweep()` promise is still executing, INCLUDING after its await was
   *  abandoned by the wall-clock bound. */
  inFlight: boolean;
  /** W1-T8170: successful completion, including a pass that settled after its wait bound. */
  lastCompletedAtMs?: number;
}

async function runGatedSweep(
  deps: DaemonDeps,
  pollIntervalMs: number,
  sweepBound: SweepBoundLearner,
  log: (step: string, extra?: Record<string, unknown>) => void,
  diskHeadroomLatch: { escalated: boolean },
  // Threaded to the pass's own ticker. This is the phase that motivated the sampler: it carries the
  // largest spender, and the measured 58-minute blind window was a pass running long while the
  // account went from 30% used to exhausted. Optional and trailing (W1-T2565).
  headroomSampler?: { lastSampleMs: number; clock: Clock; policy: HeadroomPolicy; enforced: boolean },
  // The shared liveness flag. Optional and trailing, so every existing caller behaves exactly as
  // before, which is what keeps the W1-T1044 bound tests meaningful (W1-T2582).
  liveness?: SweepLiveness,
  // W1-T5804: a pass run BECAUSE of a recycle PAUSE holds worker admission on the live STOP/PAUSE
  // read even where `deps.workerAdmissionHold` is unwired, so it can never start a fix worker.
  recyclePause?: true,
  // W1-T9808: a pass after a restart latched asks the predicate per review and per fix admission.
  latchedAdmission?: () => RestartAdmission | undefined,
): Promise<SweepCycleOutcome | undefined> {
  // Decline, do not duplicate. Checked before the ticker starts, so a declined pass costs nothing at
  // all. This one gate closes both routes into a concurrent pass, because all three call sites pass
  // through it — including the retrigger, which the bound alone does not cover (W1-T2582).
  if (liveness?.inFlight) {
    log("daemon.sweep.skipped_concurrent", { reason: "a previous sweep pass is still executing" });
    return undefined;
  }
  // Claim a durable event wake only after the liveness gate accepts this pass. A marker received after an earlier
  // pass was abandoned-but-still-running belongs to the later pass that actually starts (W1-T2656).
  deps.acknowledgeSweepWake?.();
  if (liveness) liveness.inFlight = true;
  const stopSweepTicker = startInFlightTicker(deps, pollIntervalMs, log, "sweep", diskHeadroomLatch, undefined, headroomSampler).stop;
  // W1-T3618: the pass's own outcome, captured ONLY when it genuinely settles inside the race below —
  // an abandoned pass's eventual value arrives after this function has already returned to its caller
  // and must never be attributed to a LATER tick's cycle.
  let outcome: SweepCycleOutcome | undefined;
  try {
    const bound = learnedSweepBound(sweepBound);
    if (sweepBound.seededFrom) log("daemon.sweep.seeded", { samples: bound.samples, source: sweepBound.seededFrom });
    sweepBound.seededFrom = undefined;
    log("daemon.sweep.started", { bound_ms: bound.boundMs, bound_basis: bound.basis, samples: bound.samples });
    const continueReviewAdmissions = (() => deps.checkStop?.() === undefined && deps.checkPause?.() === undefined &&
      latchedAdmission?.()?.("review", "full-sweep") !== false) as ReviewAdmissionGate;
    const workerAdmissionHold = (kind?: "review"): string | undefined => {
      const hold = deps.workerAdmissionHold?.() ?? (recyclePause ? resolveFleetControlHold(deps) : undefined);
      if (!hold) return kind === undefined && latchedAdmission?.()?.("fix-dispatch", "full-sweep") === false
        ? "restart latched: a fix round would outlast the time left in the restart's drain" : undefined;
      const reason = `fleet ${hold.control} hold: ${hold.detail}`;
      log("daemon.admission_held", { surface: "full-sweep", control: hold.control, detail: hold.detail, reason });
      return reason;
    };
    continueReviewAdmissions.workerAdmissionHold = workerAdmissionHold;
    const startedAtMs = Date.now();
    const elapsedSinceStart = (): number => Date.now() - startedAtMs;
    let abandoned = false;
    const sweepPromise: Promise<SweepCycleOutcome | void | undefined> = Promise.resolve().then(() => deps.sweep!(continueReviewAdmissions));
    // Cleared on settle, never on abandon. Attaching this to the pass promise itself, rather than to the
    // `finally` below, which runs when the await ends, is what keeps the flag true through the
    // abandon-to-settle window every observed re-entry landed in. `then(onOk, onErr)` rather than
    // `finally`, so this derived promise can never become an unhandled rejection of its own.
    void sweepPromise.then(() => {
      if (liveness) {
        liveness.inFlight = false;
        liveness.lastCompletedAtMs = clockFromDateFn(deps.now).now();
      }
      const elapsedMs = elapsedSinceStart();
      recordSettledSweep(sweepBound, elapsedMs); // W1-T9563: a pass past its bound is still a healthy sample
      log("daemon.sweep.settled", { elapsed_ms: elapsedMs, abandoned, bound_ms: bound.boundMs, bound_basis: bound.basis });
    }, () => { if (liveness) liveness.inFlight = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const boundTimer = new Promise<"abandoned">((resolve) => {
      timer = setTimeout(() => resolve("abandoned"), bound.boundMs);
    });
    try {
      const winner = await Promise.race([sweepPromise, boundTimer]);
      if (winner === "abandoned") {
        abandoned = true;
        const elapsedMs = elapsedSinceStart();
        log("daemon.sweep.abandoned", { elapsed_ms: elapsedMs, bound_ms: bound.boundMs, bound_basis: bound.basis, samples: bound.samples });
        // Never leave the real pass's eventual outcome unhandled — it may resolve or throw well after this
        // call has moved on, which the reconciler's shared mutex is what makes safe.
        sweepPromise.catch((e) => {
          log("daemon.sweep.failed", { error: String((e as Error)?.message ?? e), after_abandon: true });
        });
      } else {
        outcome = winner ?? undefined;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    log("daemon.sweep.failed", { error: String((e as Error)?.message ?? e) });
  } finally {
    await stopSweepTicker();
  }
  return outcome;
}

/** The spawn-infra backoff ceiling (policy data, rule 2): consecutive failures double the poll interval up to this
 * cap, rather than hammering a dispatch that is failing for an infrastructure reason nobody has fixed yet. */
export const DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS = 30 * 60_000;

/** The cross-task hold ceiling for a closed API usage window (W1-T2517). The defect: a closed window
 *  was re-discovered per task at a full spawn each, because per-task retry state is keyed by task id
 *  and a new id always arrived with a fresh budget. The discriminator is therefore consecutive across
 *  DIFFERENT task ids, so a single flaky task retrying can never read as a fleet-wide outage, and it
 *  never touches block reasoning. BACKSTOP. Forensics: docs/forensics/daemon.md. */
export const DEFAULT_MAX_API_WINDOW_HOLD_MS = 30 * 60_000;

/** Below this streak, holding dispatch would be a new way to stall over noise — see
 *  {@link reasonAboutApiWindow} for why the floor is 2, not 1. */
export const API_WINDOW_HOLD_STREAK_FLOOR = 2;

/** Cross-task `blocked_transient` streak state — see {@link reasonAboutApiWindow}'s doc. */
export interface ApiWindowHoldState {
  /** Consecutive `blocked_transient` verdicts across DIFFERENT task ids. */
  streak: number;
  /** The task id the streak last advanced on; `undefined` once the streak is at its floor. */
  lastTaskId: string | undefined;
}

export const INITIAL_API_WINDOW_HOLD_STATE: ApiWindowHoldState = { streak: 0, lastTaskId: undefined };

export interface ApiWindowHoldDisposition {
  /** The state to thread into the next call. */
  state: ApiWindowHoldState;
  /** ms to hold dispatch this tick; 0 below {@link API_WINDOW_HOLD_STREAK_FLOOR}. */
  holdMs: number;
}

/** Pure decision: given the running cross-task streak and this dispatch's own task id and verdict,
 *  how long, if at all, should the next dispatch be held? See
 *  {@link DEFAULT_MAX_API_WINDOW_HOLD_MS} for the rationale; this is its computation. */
export function reasonAboutApiWindow(
  state: ApiWindowHoldState,
  taskId: string,
  verdict: RunResult["verdict"],
  pollIntervalMs: number,
  maxHoldMs: number = DEFAULT_MAX_API_WINDOW_HOLD_MS,
): ApiWindowHoldDisposition {
  // A real verdict resets to the floor: this dispatch reached a decisive outcome, so whatever streak
  // of ambiguous refusals preceded it is over, one way or another. W1-T4662: `handed_off` (a
  // healthy freshness yield leaving its PR open for the next daemon lifetime) is one such real
  // verdict — it never advances or extends this streak, only a genuine, repeated API failure does.
  if (verdict !== "blocked_transient") return { state: INITIAL_API_WINDOW_HOLD_STATE, holdMs: 0 };
  const streak = taskId === state.lastTaskId ? state.streak : state.streak + 1;
  const nextState: ApiWindowHoldState = { streak, lastTaskId: taskId };
  if (streak < API_WINDOW_HOLD_STREAK_FLOOR) return { state: nextState, holdMs: 0 };
  const holdMs = Math.min(pollIntervalMs * 2 ** (streak - API_WINDOW_HOLD_STREAK_FLOOR), maxHoldMs);
  return { state: nextState, holdMs };
}

/** The boot-rate invariant (W1-T215, recon T2-AC2). Two different root causes have already produced a relaunch loop,
 * and both were caught only because a human read boot timestamps. A third is likely, since any uncaught throw in the
 * poll loop produces the identical shape, so this detects the SHAPE rather than any one known trigger. A pure
 * function over already-extracted timestamps (Rule 18). Forensics: docs/forensics/daemon.md. */
export interface CrashLoopWindow {
  /** The rolling window's width, in ms. */
  windowMs: number;
  /** STRICTLY MORE than this many boots inside `windowMs` is a breach. */
  maxBoots: number;
}

/** Default: more than 5 boots inside any rolling 10-minute window, sized against the two observed
 *  incidents with headroom for a legitimate handful of restarts during commissioning, which this must
 *  not trip on. Falsifier: test/daemon-crashloop.test.ts. An invariant that cries wolf gets muted. */
export const DEFAULT_CRASHLOOP_WINDOW: CrashLoopWindow = { windowMs: 10 * 60_000, maxBoots: 5 };

/** The breach verdict, carrying its own evidence — the densest window's boot timestamps and the threshold breached —
 * so surfacing it never sends a human back to raw ledger timestamps, which is the exact labour this replaces. */
export interface CrashLoopVerdict {
  breached: boolean;
  /** The densest `windowMs`-wide run of boots found, oldest first. */
  windowBoots: string[];
  windowMs: number;
  maxBoots: number;
}

/** One boot timestamp, optionally carrying why the boot immediately before it ended — never why this one did. Why:
 * with a bare timestamp array, a deliberate freshness self-restart and a real crash were the identical event, and six
 * routine restarts breach the window like six crashes. A bare string still reads as a record with no reason, and only
 * an explicit freshness reason is excluded (W1-T2450). Forensics: docs/forensics/daemon.md. */
export interface DaemonBootTimestamp {
  ts: string;
  priorExitReason?: "freshness" | "unknown";
}

/** Find the densest window of boots and compare its size against the threshold. Unparseable timestamps are dropped
 * rather than thrown on, following the ledger's own torn-line discipline, so one malformed line never takes the
 * invariant down. It detects the shape only, except a boot explicitly labeled a freshness restart, which is excluded
 * from the count and the evidence. Quadratic in the boot count, which is fine: callers pass a bounded recent tail. */
export function detectDaemonCrashLoop(
  bootTimestamps: ReadonlyArray<string | DaemonBootTimestamp>,
  window: CrashLoopWindow = DEFAULT_CRASHLOOP_WINDOW,
): CrashLoopVerdict {
  const records = bootTimestamps.map((b) => (typeof b === "string" ? { ts: b } : b));
  const parsed = records
    .filter((r) => r.priorExitReason !== "freshness")
    .map((r) => ({ raw: r.ts, ms: Date.parse(r.ts) }))
    .filter((p) => Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms);

  let densest: { raw: string; ms: number }[] = [];
  for (const anchor of parsed) {
    const windowStart = anchor.ms - window.windowMs;
    const inWindow = parsed.filter((p) => p.ms > windowStart && p.ms <= anchor.ms);
    if (inWindow.length > densest.length) densest = inWindow;
  }

  return {
    breached: densest.length > window.maxBoots,
    windowBoots: densest.map((p) => p.raw),
    windowMs: window.windowMs,
    maxBoots: window.maxBoots,
  };
}

/** W1-T9754: the environment switch that starts the spawn helper at boot. Its default, off, is an operator decision. */
export const SPAWN_HELPER_SWITCH = "RMD_SPAWN_HELPER";

/** The daemon's startup routine (W1-T12b): the clean-env boot assertion, run once before the scheduler loop starts.
 * Takes the log sink and the env as injectable inputs, so it is provable in-process with a fake env and no real
 * launchd load. Every optional dependency below follows one shape: injected rather than imported, because this module
 * never touches the filesystem; run once here; logged either way, so the step's own pass or fail is part of the boot
 * record; and omitted means no step and behaviour unchanged. A failure is logged and the boot continues — the T197
 * doctrine, that the daemon sleeps through problems. Forensics: docs/forensics/daemon.md. */
export async function daemonBoot(
  log: (step: string, extra?: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env,
  sweepTmp?: () => { removed: string[]; kept: string[] },
  sweepLocks?: () => { reaped: string[]; kept: string[]; live: string[]; unverifiableForeignHost: string[] },
  unlockWorkerKeychain?: () => { keychainPath: string; provisioned: boolean; unlocked: true },
  crashLoopCheck?: {
    /** Prior boot timestamps, re-derived from the ledger by the caller — this module never touches the
     *  filesystem. Must not include this boot's own timestamp; `daemonBoot` appends it. */
    priorBoots: () => string[];
    /** Override the default window/threshold (POLICY DATA, rule 2). */
    window?: CrashLoopWindow;
    /** This boot's own timestamp, defaulting to the real wall clock. Tests inject a fixed instant so
     *  the check is provable without a wall-clock wait (Rule 18). */
    now?: () => string;
    /** Called only on breach, with the evidence attached. The real command escalates, so a loop opens a
     *  needs-human issue instead of waiting for someone to read raw timestamps. */
    onBreach: (verdict: CrashLoopVerdict) => void;
  },
  resolveClaudeBin?: () => string,
  /** True iff config.overflow === "api_key" (§9): the daemon deliberately drains
   * on API credits. Threaded so the daemon.boot canary reports the SAME billing
   * mode its workers will actually bill, not just whether the key is in its env. */
  allowApiKey = false,
  /** The boot-time half of the orphan sweep: it terminates strays from ended runs and ledgers them.
   *  Logged either way, naming the killed and left-alone counts. The per-kill ledger line is the
   *  injected function's own job; this step only summarizes (W1-T117). */
  sweepOrphanWorkers?: () => OrphanSweepReport,
  /** The sha of the code this process loaded, resolved by the caller at boot. Recorded so the deploy
   *  supervisor compares the running code against the checkout rather than the checkout against origin,
   *  which is consumed by anyone who pulls first and left the daemon running stale code silently. */
  bootHeadSha?: string,
  /** The boot-time half of the feedback-landing backstop, so a pre-existing stranded entry is picked
   *  up when the daemon comes up rather than only on its next per-poll pass. Awaited, so its plan-PR
   *  preflight runs off the loop (W1-T9695). Appended last so no positional caller shifts (W1-T530 part ii). */
  sweepFeedbackLanding?: () => Promise<LandFeedbackResult> | LandFeedbackResult,
  /** The runtime reading the boot assertion now also carries. Defaults to this process's own values so a real boot
   * needs no caller change; a test overrides it to prove drift without a real foreign-account install (W1-T991). */
  nodeRuntime: { execPath: string; version: string } = { execPath: process.execPath, version: process.version },
  /** The repo's declared node pin, read by the caller — this module never touches the filesystem.
   *  Omitted means no version-pin comparison; the roots check still runs. */
  declaredNodeVersion?: string,
  /** The canonical checkout's history horizon, measured by the caller because this module never touches
   *  the filesystem. Why: a shallow clone breaks every history read silently — log searches, follows and
   *  merge-base checks all stay plausible over a truncated corpus — and nothing asked (W1-T2332). */
  checkoutDepth?: { shallow: boolean; commitCount: number },
): Promise<BootAssertion> {
  const assertion = assertCleanBoot(env, allowApiKey, nodeRuntime, declaredNodeVersion);
  log("daemon.boot", {
    env_clean: assertion.env_clean,
    billing_mode: assertion.billing_mode,
    node_path: assertion.node_path,
    node_version: assertion.node_version,
    ...(assertion.node_drift ? { node_drift: assertion.node_drift } : {}),
    ...(bootHeadSha ? { head_sha: bootHeadSha } : {}),
    ...(checkoutDepth ? { checkout_shallow: checkoutDepth.shallow, checkout_commit_count: checkoutDepth.commitCount } : {}),
  });
  // W1-T9754: the spawn helper starts here, while this process is still small, so a later routed spawn forks from
  // it and not from a 1.5-2 GB daemon. Whether it starts is the operator's switch, off unless set to "on".
  if (env[SPAWN_HELPER_SWITCH] === "on") {
    const helper = startSpawnHelper({ log });
    installSpawnHelper(helper);
    log("daemon.spawn_helper", { started: true, pid: helper.pid, switch: SPAWN_HELPER_SWITCH });
  }
  // The boot-rate invariant: the shape-not-cause check. Logged either way, so the invariant's own
  // pass or fail is part of the boot record, not only its breaches (W1-T215).
  if (crashLoopCheck) {
    // Adapted through the Clock port (W1-T2897): the field keeps its legacy `() => string` shape
    // (tests inject a fixed ISO instant directly), read here through `clockFromIsoFn`.
    const nowIso = clockFromIsoFn(crashLoopCheck.now).iso();
    const verdict = detectDaemonCrashLoop(
      [...crashLoopCheck.priorBoots(), nowIso],
      crashLoopCheck.window ?? DEFAULT_CRASHLOOP_WINDOW,
    );
    log("daemon.crashloop_check", {
      breached: verdict.breached,
      boot_count: verdict.windowBoots.length,
      window_ms: verdict.windowMs,
      max_boots: verdict.maxBoots,
    });
    if (verdict.breached) crashLoopCheck.onBreach(verdict);
  }
  // The boot-time worker-keychain unlock, explicit and ledgered, so the credential store comes up as
  // a named boot step rather than as a side effect of unlocking the operator's login keychain. A
  // failure is ledgered with its credential-named class and the boot continues: each spawn re-runs
  // the rung and fails credential-named at the spawn boundary, never as a $0 mystery (W1-T235).
  if (unlockWorkerKeychain) {
    try {
      const kc = unlockWorkerKeychain();
      log("daemon.worker_keychain", {
        keychain_path: kc.keychainPath,
        provisioned: kc.provisioned,
        unlocked: kc.unlocked,
      });
    } catch (err) {
      log("daemon.worker_keychain", {
        unlocked: false,
        error_class: (err as { reasonClass?: string })?.reasonClass ?? "unknown",
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  if (sweepTmp) {
    const swept = sweepTmp();
    log("daemon.tmp_sweep", { removed: swept.removed.length, kept: swept.kept.length });
  }
  // Stale in-flight locks (R-35). Purely an observability fix: lock acquisition already steals a dead
  // holder's lock, so nothing here unblocks dispatch. It exists because a stale lock is otherwise only
  // cleared by the next acquire of that same task, and a circuit-broken task is never re-dispatched,
  // so its lock lingers indefinitely and reads as live work.
  if (sweepLocks) {
    const swept = sweepLocks();
    // `kept` collapsed a confirmed-live holder and an unverifiable-foreign-host one into one count. A
    // container replacement strands the latter forever, so both are logged alongside the total and
    // permanently-stuck debris stays legible rather than indistinguishable from healthy work (W1-T461).
    log("daemon.lock_sweep", {
      reaped: swept.reaped.length,
      kept: swept.kept.length,
      live: swept.live.length,
      unverifiable_foreign_host: swept.unverifiableForeignHost.length,
    });
  }
  // Resolve and log the real toolchain binary once at boot. A refusal is logged, never thrown onward:
  // the boot continues (T197, W1-T113 part i).
  if (resolveClaudeBin) {
    try {
      const path = resolveClaudeBin();
      log("daemon.claude_bin", { blocked: false, path });
    } catch (err) {
      log("daemon.claude_bin", {
        blocked: true,
        error_class: (err as { reasonClass?: string })?.reasonClass ?? "unknown",
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  // The boot-time half of the orphan sweep. A failure is logged, never thrown onward: the boot
  // continues rather than dying over a process-listing hiccup (W1-T117 part ii).
  if (sweepOrphanWorkers) {
    try {
      const report = sweepOrphanWorkers();
      log("daemon.orphan_sweep", { killed: report.killed.length, left_alone: report.leftAlone.length });
    } catch (err) {
      log("daemon.orphan_sweep", { error: String((err as Error)?.message ?? err) });
    }
  }
  // The boot-time half of the feedback-landing sweep. A failure is logged, never thrown onward: the
  // boot continues rather than dying over a git or GitHub hiccup (W1-T530 part ii).
  if (sweepFeedbackLanding) {
    try {
      const result = await sweepFeedbackLanding();
      log("daemon.feedback_landing_sweep", {
        landed: result.landed,
        pushed: result.pushed ?? false,
        file_count: result.files.length,
      });
    } catch (err) {
      log("daemon.feedback_landing_sweep", { error: String((err as Error)?.message ?? err) });
    }
  }
  return assertion;
}

/** The per-dispatch governor gate now lives in dispatch-governor.ts and is re-exported here unchanged.
 *  Why it moved: `runDrainLanes` must call the same function per lane, but daemon.ts already imports
 *  from drain.ts, so drain.ts importing it from here would close an import cycle. The alternative was
 *  a second copy of the predicate, the defect this repo has paid for twice (W1-T342). Forensics: docs/forensics/daemon.md. */
export { checkDispatchGovernors, type DispatchGovernorVerdict } from "./dispatch-governor.js";

/** The daemon's scheduler loop. Deterministic; no model decisions. Each tick: check the two operator holds, check
 * headroom, pick the next runnable in DAG order (reusing drain.ts's own selector), run it, then reason about the
 * verdict (W1-T46). Block reasoning has four outcomes: a transient retries with no strike, an independent failure is
 * flagged and skipped, a fixable blocker gets a bounded fix attempt (W1-T174), and a genuine blocker escalates once
 * and parks until its PR ownership materially changes. Idling is an in-process state, never a process exit.
 * Forensics: docs/forensics/daemon.md. */
/** The saved-planning pump's handle. `stop()` refuses every further handoff but never interrupts the active one;
 *  `settled()` resolves when that one has finished, and `activeOperation()` names it while it runs. */
export interface ImprovementActionPump {
  stop(): void;
  settled(): Promise<void>;
  isBusy(): boolean;
  activeOperation(): string | undefined;
}

/** Runs saved planning requests serially without blocking dispatch or interrupting an active child. */
export function startImprovementActionPump(
  deps: Pick<DaemonDeps, "pendingImprovementActions" | "handOffImprovementAction" | "checkStop" | "checkPause">,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): ImprovementActionPump {
  const pending = deps.pendingImprovementActions, run = deps.handOffImprovementAction;
  if (!pending || !run) return { stop() {}, settled: async () => {}, isBusy: () => false, activeOperation: () => undefined };
  let stopped = false, pass: Promise<void> | undefined, active: string | undefined;
  const tick = (): void => {
    if (stopped || pass) return;
    pass = (async () => {
      if (resolveFleetControlHold(deps)) return;
      for await (const target of pending()) {
        if (stopped || resolveFleetControlHold(deps)) break;
        log("improvement.action_started", { operation_id: target.operationId });
        active = target.operationId;
        try {
          const result = await run(target);
          log("improvement.action_handoff_settled", { operation_id: target.operationId, result });
        } catch (error) {
          log("improvement.action_handoff_failed", { operation_id: target.operationId, error: String(error) });
        } finally {
          active = undefined;
        }
      }
    })().catch(error => { log("improvement.action_read_failed", { error: String(error) }); }).finally(() => { pass = undefined; });
  };
  const timer = setInterval(tick, Math.max(1, intervalMs)); timer.unref?.(); tick();
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    settled: async () => { await pass; },
    isBusy: () => pass !== undefined,
    activeOperation: () => active,
  };
}

/** What a clean STOP's bounded wait left running: the active handoff's operation, or the queue read that precedes one. */
interface AbandonedImprovementPass { operation_id: string | null; phase: "handoff" | "discovery" }

/** A clean STOP waits for the stopped pump's pass, bounded like the in-flight review drain. Returns what was still
 *  running at the bound, or `undefined` when nothing was running or it settled within the bound. */
async function drainImprovementActionHandoff(pump: ImprovementActionPump, boundMs: number): Promise<AbandonedImprovementPass | undefined> {
  if (!pump.isBusy()) return undefined;
  let settled = false;
  const work = pump.settled().then(() => { settled = true; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, boundMs)); });
  try {
    await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
  }
  if (settled) return undefined;
  const operation = pump.activeOperation();
  return { operation_id: operation ?? null, phase: operation === undefined ? "discovery" : "handoff" };
}

/**
 * W1-T4077 — THE CONSOLE'S "REVIEW NOW" / "FIX NOW", RUN ON THEIR OWN TIMER.
 *
 * These requests used to be read once per main-loop iteration and AWAITED there. Measured 2026-09-22: one
 * iteration began at 19:33 and the next after 20:16, so a nudge could wait ~43 minutes, and a fix nudge then held
 * dispatch for the length of a fix round. A timer fires during awaited work, so this pump starts a request within one
 * interval whatever the loop is doing, and never awaits it: each request runs detached, at most once at a time per
 * (action, PR). The marker is cleared when its run settles, exactly as before, so an unfinished request survives a
 * restart and is picked up again.
 */
export function startPrActionPump(
  deps: Pick<DaemonDeps, "pendingPrActions" | "runPrAction" | "clearPrAction">,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void; settled: () => Promise<void>; isBusy: () => boolean } {
  const pending = deps.pendingPrActions;
  const run = deps.runPrAction;
  if (!pending || !run) return { stop: () => {}, settled: async () => {}, isBusy: () => false };
  const running = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const tick = (): void => {
    let requests: ReturnType<typeof pending>;
    try {
      requests = pending();
    } catch (error) {
      log("console.pr_action_read_failed", { error: String((error as Error)?.message ?? error) });
      return;
    }
    for (const request of requests) {
      const key = `${request.action}-${request.prNumber}`;
      if (running.has(key)) continue;
      running.add(key);
      const fields = {
        action: request.action,
        pr_number: request.prNumber,
        origin: request.origin,
        requested_at: request.requestedAt,
        ...(request.operator ? { operator: request.operator } : {}),
      };
      log("console.pr_action_started", fields);
      const settled: Promise<void> = (async () => {
        try {
          const result = await run(request);
          log(result.outcome === "completed" ? "console.pr_action_completed" : "console.pr_action_refused", {
            ...fields,
            ...(result.detail ? { detail: result.detail } : {}),
          });
        } catch (error) {
          log("console.pr_action_failed", { ...fields, error: String((error as Error)?.message ?? error) });
        } finally {
          deps.clearPrAction?.(request.action, request.prNumber);
          running.delete(key);
        }
      })();
      inFlight.add(settled);
      void settled.finally(() => inFlight.delete(settled));
    }
  };
  const timer = setInterval(tick, Math.max(1, intervalMs));
  timer.unref?.();
  tick();
  return {
    stop: () => clearInterval(timer),
    isBusy: () => inFlight.size > 0,
    settled: async () => {
      await Promise.all([...inFlight]);
    },
  };
}

/** The newest triage PR this ledger saw opened for `feedbackId` (#10265); the guard's live read decides if it is still open. */
export function triagePrOpenedInLedger(lines: readonly string[] | undefined, feedbackId: string): number | undefined {
  const owned = `"task_id":"TRIAGE-${feedbackId}"`;
  for (let at = (lines?.length ?? 0) - 1; at >= 0; at -= 1) {
    const line = lines![at]!;
    if (!line.includes(owned) || !line.includes('"step":"pr.opened"')) continue;
    const number = /"pr_url":"[^"]*\/pull\/(\d+)"/.exec(line)?.[1];
    if (number !== undefined) return Number(number);
  }
  return undefined;
}

/** W1-T4416: a lane pool. Each task runs on its own lane; a lane that settles while a sibling is still
 *  in flight may take `refill`'s next task, appended to `tasks`. Resolves, never rejects, once every lane
 *  settles, with outcomes indexed like `tasks`. The first wave is invoked synchronously, as the batch was.
 *  W1-T5805: in the legacy four-argument path, a rejected promised refill ends only that lane.
 *  Opt-in admission/onStarted callers receive a separate fault, after all actual workers drain. */
export type LanePoolOutcome<T, R> = {
  settled: PromiseSettledResult<R>[];
  fault?: { task: T; lane: number; phase: "admit" | "onStarted" | "refill"; reason: unknown };
  /** A caller phase failed, not a synthetic task/worker. Mutually exclusive with fault: first wins. */
  externalFault?: { phase: string; reason: unknown };
};

export type LanePoolControl<R = unknown> = {
  close?: (reason: unknown, phase?: string) => void;
  occupied?: ReadonlyMap<string | object, Promise<R>>;
  detach?: (isChild: (id: string) => boolean) => void;
};

export function runLanePool<T extends { id: string }, R>(
  tasks: T[],
  run: (id: string, task: T) => Promise<R>,
  refill: (lane: number, finished: T, outcome: PromiseSettledResult<R>) => T | undefined | Promise<T | undefined>,
  lanes?: { inFlight: number },
  admit?: undefined,
): Promise<PromiseSettledResult<R>[]>;
export function runLanePool<T extends { id: string }, R>(
  tasks: T[],
  run: (id: string, task: T) => Promise<R>,
  refill: (lane: number, finished: T, outcome: PromiseSettledResult<R>) => T | undefined | Promise<T | undefined>,
  lanes: { inFlight: number } | undefined,
  admit: (task: T, lane: number, isRefill: boolean) => boolean,
  onStarted?: (task: T, lane: number, isRefill: boolean) => void,
): Promise<LanePoolOutcome<T, R>>;
export function runLanePool<T extends { id: string }, R>(
  tasks: T[],
  run: (id: string, task: T) => Promise<R>,
  refill: (lane: number, finished: T, outcome: PromiseSettledResult<R>) => T | undefined | Promise<T | undefined>,
  lanes: { inFlight: number } | undefined,
  admit: ((task: T, lane: number, isRefill: boolean) => boolean) | undefined,
  onStarted: (task: T, lane: number, isRefill: boolean) => void,
): Promise<LanePoolOutcome<T, R>>;
export function runLanePool<T extends { id: string }, R>(
  tasks: T[],
  run: (id: string, task: T) => Promise<R>,
  refill: (lane: number, finished: T, outcome: PromiseSettledResult<R>) => T | undefined | Promise<T | undefined>,
  lanes: { inFlight: number } | undefined,
  admit: ((task: T, lane: number, isRefill: boolean) => boolean) | undefined,
  onStarted: ((task: T, lane: number, isRefill: boolean) => void) | undefined,
  control: LanePoolControl<R>,
): Promise<LanePoolOutcome<T, R>>;
export function runLanePool<T extends { id: string }, R>(
  tasks: T[],
  run: (id: string, task: T) => Promise<R>,
  refill: (lane: number, finished: T, outcome: PromiseSettledResult<R>) => T | undefined | Promise<T | undefined>,
  // W1-T5343: a live view of the count, read by the phase ticker. Optional.
  lanes: { inFlight: number } = { inFlight: 0 },
  // Opt-in path: false starts no work; a throw closes starts and is returned separately from workers.
  admit?: (task: T, lane: number, isRefill: boolean) => boolean,
  // Synchronous, but only AFTER the pool owns the worker promise and its settlement handlers.
  onStarted?: (task: T, lane: number, isRefill: boolean) => void,
  // Installed synchronously, before the first wave. Closes starts, never cancels real workers.
  control?: LanePoolControl<R>,
): Promise<PromiseSettledResult<R>[] | LanePoolOutcome<T, R>> {
  if (admit || onStarted || control) {
    const initial = tasks.splice(0);
    const settled: PromiseSettledResult<R>[] = [];
    let fault: LanePoolOutcome<T, R>["fault"];
    let externalFault: LanePoolOutcome<T, R>["externalFault"];
    let active = 0, refilling = 0, initializing = true;
    const owned = new Map<number, string>();
    let detaching = false;
    let detachable: ((id: string) => boolean) | undefined;
    return new Promise<LanePoolOutcome<T, R>>((resolve) => {
      const finishIfIdle = (): void => {
        if (!initializing && active === 0 && refilling === 0) resolve({ settled,
          ...(fault ? { fault } : {}), ...(externalFault ? { externalFault } : {}) });
      };
      const fail = (task: T, lane: number, phase: NonNullable<typeof fault>["phase"], reason: unknown): void => {
        // Presence, never truthiness of reason: undefined/null/false are still genuine thrown values.
        if (externalFault === undefined) fault ??= { task, lane, phase, reason };
        // Proposals are not workers. Retire their wait, but leave both late handlers attached below.
        refilling = 0;
        finishIfIdle();
      };
      if (control) control.close = (reason, phase = "external") => {
        if (fault === undefined) externalFault ??= { phase, reason };
        refilling = 0;
        finishIfIdle();
      };
      if (control) control.detach = (isChild) => {
        detachable = isChild;
        if ([...owned.values()].some((id) => !isChild(id))) return;
        detaching = true;
        refilling = 0;
        for (const [i, id] of owned) if (isChild(id)) {
          owned.delete(i);
          active--;
          lanes.inFlight--;
        }
        finishIfIdle();
      };
      const finish = (i: number, lane: number, outcome: PromiseSettledResult<R>): void => {
        if (!owned.delete(i)) return; // Released children settle on the next daemon.
        settled[i] = outcome;
        active--;
        lanes.inFlight--;
        if (detachable) control!.detach!(detachable);
        if (detaching || fault || externalFault || active + refilling === 0) return finishIfIdle();
        let next: T | undefined | Promise<T | undefined>;
        try { next = refill(lane, tasks[i], outcome); }
        catch (reason) { /* Retain the producer failure in the pool's first-fault envelope. */ return fail(tasks[i], lane, "refill", reason); }
        if (!(next instanceof Promise)) return take(lane, next, true);
        if (!fault && !externalFault) refilling++;
        // Keep the promised handoff: admission observes changes AFTER the producer resolves.
        void next.then(
          (value): PromiseSettledResult<T | undefined> => ({ status: "fulfilled", value }),
          (reason: unknown): PromiseSettledResult<T | undefined> => ({ status: "rejected", reason }),
        ).then((proposal) => {
          if (detaching || fault || externalFault) return; // no late start or decrement of the retired proposal count
          refilling--;
          if (proposal.status === "rejected") return fail(tasks[i], lane, "refill", proposal.reason);
          take(lane, proposal.value, true);
        });
        if (fault || externalFault) finishIfIdle();
      };
      const take = (lane: number, task: T | undefined, isRefill: boolean): void => {
        if (detaching || fault || externalFault || task === undefined) return finishIfIdle();
        const occupied = (control?.occupied?.get(task) ?? control?.occupied?.get(task.id));
        try { if (!occupied && admit && !admit(task, lane, isRefill)) return finishIfIdle(); }
        catch (reason) { /* Retain the admission failure in the pool's first-fault envelope. */ return fail(task, lane, "admit", reason); }
        if (fault || externalFault) return finishIfIdle();
        const i = tasks.push(task) - 1;
        active++;
        owned.set(i, task.id);
        lanes.inFlight++;
        // The executor invokes run synchronously and owns its promise (or synchronous rejection).
        // Attach settlement BEFORE another admission or any fallible onStarted bookkeeping.
        const worker = occupied ?? new Promise<R>((done) => done(run(task.id, task)));
        void worker.then(
          (value) => finish(i, lane, { status: "fulfilled", value }),
          (reason: unknown) => finish(i, lane, { status: "rejected", reason }),
        );
        try { onStarted?.(task, lane, isRefill); }
        catch (reason) { /* Retain telemetry failure after owning the actual worker. */ fail(task, lane, "onStarted", reason); }
      };
      for (let lane = 0; lane < initial.length && !fault && !externalFault; lane++) take(lane, initial[lane], false);
      initializing = false;
      finishIfIdle();
    });
  }
  // The unwired four-argument API and its refill-failure behaviour stay unchanged.
  const settled: PromiseSettledResult<R>[] = [];
  const firstWave = tasks.map((task, lane) => ({ lane, promise: run(task.id, task) }));
  let refilling = 0;
  return new Promise((resolve) => {
    if (tasks.length === 0) resolve(settled);
    const take = (lane: number, next: T | undefined): void => {
      if (next) {
        tasks.push(next);
        start(tasks.length - 1, lane, (async () => run(next.id, next))());
      }
      if (lanes.inFlight + refilling === 0) resolve(settled);
    };
    const start = (i: number, lane: number, p: Promise<R>): void => {
      lanes.inFlight++;
      p.then(
        (value): PromiseSettledResult<R> => ({ status: "fulfilled", value }),
        (reason: unknown): PromiseSettledResult<R> => ({ status: "rejected", reason }),
      ).then((outcome) => {
        settled[i] = outcome;
        lanes.inFlight--;
        const next = lanes.inFlight + refilling > 0 ? refill(lane, tasks[i], outcome) : undefined;
        if (!(next instanceof Promise)) return take(lane, next);
        refilling++;
        void next.catch(() => /* a failed refill ends only its own lane, as a held one does */ undefined).then((t) => {
          refilling--;
          take(lane, t);
        });
      });
    };
    firstWave.forEach(({ lane, promise }, i) => start(i, lane, promise));
  });
}

export async function runDaemon(
  plan: Plan,
  deps: DaemonDeps,
  opts: DaemonOpts = {},
): Promise<DaemonSummary> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // W1-T1044: see DaemonOpts.sweepWallClockBoundMs's own doc — POLICY DATA (rule 2), threaded
  // by the real `rmd daemon` entry, defaulted here for a direct/test caller that omits it.
  const sweepWallClockBoundMs = opts.sweepWallClockBoundMs ?? DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS;
  const freshnessMinLifetimeMs = opts.freshnessMinLifetimeMs ?? FRESHNESS_MIN_LIFETIME_MS;
  const sweepBound: SweepBoundLearner = { fallbackMs: sweepWallClockBoundMs, settledMs: [] }; // W1-T9563, seeded at boot
  // One mutable ref for when a full pass last actually ran, shared by every call site below — see {@link
  // SweepRetrigger} for why a shared reference, not a fresh object per site, is load-bearing. It starts undefined so
  // the first pass of this process's life runs unconditionally (W1-T1272). One liveness flag for this daemon's whole
  // life, shared by every route; per-process scope is the correct scope (W1-T2582).
  const sweepLiveness: SweepLiveness = { inFlight: false };
  // W1-T4998 — the tick's full pass runs in the BACKGROUND, so admission never waits behind it (a pass
  // measured 12.5 min on 2026-09-30). `backgroundSweep` is the outstanding `runGatedSweep` call, cleared
  // the moment it returns; each completed pass is queued once and consumed, in order, by the next tick.
  let backgroundSweep: Promise<void> | undefined;
  let repositoryMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let dueRungsTimer: ReturnType<typeof setInterval> | undefined;
  let dueRungsStopped = false;
  let repositoryMaintenanceStopped = false;
  let repositoryMaintenanceQueueBusy = false;
  let repositoryMaintenanceLaneCount = () => 0;
  // W1-T4945 — this lifetime's freshness pressure, and when it first read stale; see `decideFreshness`.
  let freshnessPressure: DeployRestartPressureState = { total: 0, scoredShas: [] };
  let staleSinceMs: number | undefined;
  let lastAdvanceSha: string | undefined;
  let lastAdvanceAtMs: number | undefined;
  let advancesCoalesced = 0;
  let freshnessHeld = false;
  const dirtyBlockedShas = new Set<string>();
  const completedSweeps: Array<{ outcome: SweepCycleOutcome | undefined; durationMs: number }> = [];
  let latestSweepOutcome: SweepCycleOutcome | undefined;
  let staleReviewerAction: StaleReviewerRecurrenceAction = { kind: "silent" };
  const sweepRetriggerState: { lastRunAtMs: number | undefined } = { lastRunAtMs: undefined };
  const sweepRetrigger: SweepRetrigger = {
    sweepWallClockBoundMs: sweepBound,
    intervalMs: opts.sweepRetriggerIntervalMs ?? DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS,
    state: sweepRetriggerState,
    liveness: sweepLiveness,
    latchedAdmission: () => latchedAdmission(),
    slot: {
      busy: () => backgroundSweep !== undefined || sweepLiveness.inFlight,
      adopt: (started) => {
        const startedAtMs = daemonClock.now();
        const pass = started.then((outcome) => {
          completedSweeps.push({ outcome, durationMs: Math.max(0, daemonClock.now() - startedAtMs) });
          if (backgroundSweep === pass) backgroundSweep = undefined;
          openBootGate("first_pass");
        });
        backgroundSweep = pass;
      },
    },
  };
  const emitLog: (step: string, extra?: Record<string, unknown>) => void = deps.log ?? (() => {});
  type SettlementReporting = {
    report: typeof emitLog;
    faults: Array<{ phase: string; reason: unknown }>;
  };
  const reportingFaultDetail = (reason: unknown): string => {
    if (reason === null) return "null";
    if (typeof reason !== "object" && typeof reason !== "function") return String(reason);
    try {
      // Do not invoke a thrown object's message getter or custom string conversion.
      const message = Object.getOwnPropertyDescriptor(reason, "message");
      return message && "value" in message && typeof message.value === "string"
        ? message.value : "[non-string reporting failure]";
    } catch {
      // The original reason stays in the named reporting-fault channel; detail is explicitly unknown.
      return "[uninspectable reporting failure]";
    }
  };
  // W1-T4837: idle build-lane minute accounting. The daemon's own log stream is observed rather than a flag
  // threaded through every decline, so a hold written by any layer names the cause of the tick it lands in.
  const idleLaneClock = clockFromDateFn(deps.now);
  let idleLaneAccount = newIdleLaneAccount(idleLaneClock.now());
  let idleLaneTickCause: IdleLaneCause | undefined;
  let idleLaneTickHold: IdleLaneHold | undefined;
  let idleLaneDispatchable = 0;
  // W1-T8235: the lanes this daemon fills — the figure the refill path sizes its pool by.
  const idleLaneCapacity = Math.max(1, opts.laneCount ?? 1);
  let livenessPulse: ReturnType<typeof startLivenessPulse> | undefined;
  const noteLog: typeof emitLog = (step, fields) => {
    const cause = idleLaneCauseForStep(step, fields);
    if (cause !== undefined) {
      idleLaneTickCause = cause;
      idleLaneTickHold = cause === "pause" || cause === "operator_pause" || cause === "recycle_drain"
        ? pauseHoldRecord(fields) : cause === "memory" ? {
          reason: step === "daemon.queue_governor"
            ? `${fields?.pressure_tier} (${fields?.pressure_binding}): ${fields?.pressure_available_mib} MiB available, floor ${fields?.pressure_floor_mib} MiB`
            : String(fields?.reason),
        } : undefined;
    }
    livenessPulse?.note(step);
  };
  // W1-T8235: the hold behind a pause-type cause as the PAUSE flag recorded it. The flag carries a setter pid and a
  // session id; it records no actor yet (W1-T7839 adds verified actor evidence), so none is invented here.
  const pauseHoldRecord = (fields: Record<string, unknown> | undefined): IdleLaneHold => {
    const detail = fields?.detail ?? fields?.reason;
    const owner = deps.checkPauseHold?.()?.owner;
    return {
      ...(typeof detail === "string" ? { reason: detail } : owner?.reason !== undefined ? { reason: owner.reason } : {}),
      ...(owner ? { pid: owner.pid } : {}),
      ...(owner?.sessionId !== undefined ? { session_id: owner.sessionId } : {}),
    };
  };
  const resetIdleLaneTick = (): void => {
    idleLaneTickCause = undefined;
    idleLaneTickHold = undefined;
  };
  const log: typeof emitLog = (step, fields) => {
    noteLog(step, fields);
    emitLog(step, fields);
  };
  const createSettlementReporting = (): SettlementReporting => {
    const faults: SettlementReporting["faults"] = [];
    return { faults, report: (step, fields) => {
      noteLog(step, fields);
      try { emitLog(step, fields); }
      catch (reason) { faults.push({ phase: `report.${step}`, reason: reason }); }
    } };
  };
  // One sample per tick outcome: what the lanes are doing and why they are not doing more. `dispatchable`
  // is refreshed only on ticks that ran selection; a tick that never reached selection (a pause) reuses the
  // last known count rather than guessing. One `lane.idle_summary` row per window.
  // W1-T8235: `busyLanes` is the lanes IN FLIGHT, not the tick's admitted count, and the sample is taken at every lane
  // change too (a lane frees, a refill starts, a refill is held or parked), not once per dispatching tick.
  // `closeWindow: false` (a lane-change sample, taken inside the pool's refill decision) accounts and reports the change
  // but leaves the hourly summary to the tick-level sample: a refusing sink there is contained as a phase fault, whereas
  // inside a lane decision it would be a pool fault, and a failed emit (the account is rolled after it) would repeat.
  const sampleIdleLane = (busyLanes: number, selectionRan: boolean, dispatchable?: number, closeWindow = true): void => {
    if (dispatchable !== undefined) idleLaneDispatchable = dispatchable;
    const atMs = idleLaneClock.now();
    const before = idleLaneAccount.state;
    idleLaneAccount = accountIdleLaneMinutes(idleLaneAccount, {
      atMs,
      busyLanes,
      dispatchable: idleLaneDispatchable,
      cause: idleLaneTickCause,
      selectionRan,
      capacity: idleLaneCapacity,
      ...(idleLaneTickHold ? { hold: idleLaneTickHold } : {}),
    });
    // W1-T8235: one row when the (cause, idle slots, hold) triple changes, never one per tick.
    const after = idleLaneAccount.state;
    if (idleLaneStateChanged(before, after)) {
      emitLog("lane.idle_changed", {
        at_ms: atMs,
        cause: after.cause,
        idle_slots: after.idleSlots,
        capacity: idleLaneCapacity,
        dispatchable: after.dispatchable,
        hold: after.hold,
      });
    }
    if (closeWindow && atMs - idleLaneAccount.windowStartMs >= IDLE_LANE_SUMMARY_WINDOW_MS) {
      emitLog("lane.idle_summary", { ...summarizeIdleLaneAccount(idleLaneAccount, atMs) });
      idleLaneAccount = rollIdleLaneWindow(idleLaneAccount, atMs);
    }
  };
  // W1-T4939: every exit (operator stop, freshness restart, error, max) passes through `summary`, and the
  // daemon restarts on merges long before most hourly windows close, so the open window is written out as a
  // partial row rather than lost with the process. A window with no idle minute writes nothing: a restart
  // must not add a row of zeros to the ledger. The account is rolled, so a second call cannot double-count.
  const flushIdleLaneWindow = (report: typeof emitLog = emitLog): void => {
    const atMs = idleLaneClock.now();
    const row = summarizeIdleLaneAccount(idleLaneAccount, atMs);
    idleLaneAccount = rollIdleLaneWindow(idleLaneAccount, atMs);
    if (row.idle_minutes > 0) report("lane.idle_summary", { ...row, partial: true });
  };
  // Shared by both governor call sites below, so the two cannot silently drift into different field
  // names for the same verdict (W1-T342).
  const logDispatchGovernorDefer = (verdict: DispatchGovernorVerdict, tick: number): void => {
    if (verdict.kind === "cost") {
      log("daemon.cost_governor", {
        tick,
        observed_day_cost_usd: verdict.result.observedDayCostUsd,
        daily_cost_ceiling_usd: verdict.result.ceilingUsd,
        poll_interval_ms: pollIntervalMs,
      });
    } else if (verdict.kind === "queue") {
      log("daemon.queue_governor", {
        tick,
        observed_open_count: verdict.result.observedOpenCount,
        wip_limit: verdict.result.wipLimit,
        held_by: verdict.result.measuredBound === 0 && verdict.result.pressure ? "memory" : "wip",
        measured_bound: verdict.result.measuredBound,
        pressure_tier: verdict.result.pressure?.tier,
        pressure_binding: verdict.result.pressure?.binding,
        pressure_available_mib: verdict.result.pressure?.availableMib,
        pressure_floor_mib: verdict.result.pressure?.floorMib,
        pressure_host_available_mib: verdict.result.pressure?.hostAvailableMib,
        ...reclaimLedgerFields(verdict.result.pressure?.reclaim),
        // W1-T4465 design (iii): the owned/foreign split, the tier, and the trailing flow this
        // verdict was decided against, so a held daemon's own ledger names WHY it is held and
        // which way the queue is moving — never just a bare count-vs-limit pair.
        observed_foreign_count: verdict.result.observedForeignCount,
        tier: verdict.result.tier,
        trailing_merged_count: verdict.result.trailingMergedCount,
        trailing_opened_count: verdict.result.trailingOpenedCount,
        base_wip_limit: verdict.result.baseWipLimit ?? verdict.result.wipLimit,
        stuck_owned_count: verdict.result.stuckOwnedCount ?? 0,
        headroom_fraction: verdict.result.headroomFraction ?? null,
        poll_interval_ms: pollIntervalMs,
      });
    } else if (verdict.kind === "memory") {
      // A discriminant on the shared verdict union, added only to keep this exhaustive branch
      // type-checking. No production caller supplies a memory governor yet, so this branch is unreached
      // today; it exists so a future wiring task finds the log shape already correct (W1-T1038).
      log("daemon.memory_governor", {
        tick,
        observed_available_mib: verdict.result.observedAvailableMib,
        memory_floor_mib: verdict.result.floorMib,
        poll_interval_ms: pollIntervalMs,
      });
    } else if (verdict.kind === "memory_unreadable") {
      log("daemon.memory_unreadable", { tick, ...governorDeferPayload(verdict), poll_interval_ms: pollIntervalMs });
    } else if (verdict.kind === "quiet_hours") {
      log("daemon.quiet_hours", {
        tick,
        quiet_hours: true,
        ...(verdict.result.detail ? { detail: verdict.result.detail } : {}),
        poll_interval_ms: pollIntervalMs,
      });
    } else {
      log("daemon.governor_check_failed", {
        tick,
        source: verdict.source,
        error: verdict.error,
        poll_interval_ms: pollIntervalMs,
        note: "governor observation unreadable — failing closed, admitting no further dispatch this batch",
      });
    }
  };
  const attempted: string[] = [];
  const merged: string[] = [];
  // The snapshot the reload at the top of the loop writes into and the governor consultation reads
  // from, never reassigned elsewhere, so a read and the tick's decision always agree. Tick 1
  // populates it before the governor is consulted in that same tick (W1-T331).
  let dailyCostCeilingUsd: number | undefined;
  let costUsd = 0;
  let ticks = 0;
  const memoryGovernor = deps.memoryGovernor ?? createDaemonMemoryGovernor({});
  // W1-T2965 — cycles this LIFETIME has entered past both operator holds and the freshness read.
  // Not `ticks`: those are incremented on many completion paths, and the deferral below must be
  // bounded by the loop's own control flow. Incremented BELOW the freshness read, so paused
  // heartbeats — which `continue` before reaching it — cannot spend a starved process's one cycle.
  let cyclesEntered = 0;
  /** Last emitted idle-reason signature — see the cadence note at the idle rung. */
  let lastIdleSignature: string | undefined;
  // Per-task transient retry state, threaded across ticks for the same task id. Dropped once a task's
  // disposition is no longer a transient retry (W1-T46).
  const blockRetryStates = new Map<string, RetryState>();
  // A worker's fresh projection can prove a merge after this daemon selected from an older one.
  // Hold that id until this daemon's own projection catches up; a stale read must not re-dispatch it.
  const pendingMergedCredit = new Set<string>();
  // A genuine blocker is a queue-subtree state, not a process-lifetime failure (W1-T3122). The task
  // itself is excluded below; because it remains unmerged, the existing dependency predicate keeps
  // every descendant behind `unmet-deps` while unrelated work continues. This is intentionally
  // daemon-lifetime state: sweeps keep owning the open PR, and a restart may safely reconstruct the
  // same fact from the status projection rather than introducing another durable queue.
  const parkedBlockers = new Map<string, { prUrl?: string; dependents: string[] }>();
  let landedClaimSweepInFlight = false;
  // Library fallback for callers that do not wire the status projection: independent failures are
  // still recorded in the ledger, but the same in-process loop must not re-spend on the id before a
  // projection reader has a chance to observe that row. Not a Task mutation, so plan reloads cannot
  // erase it.
  const independentFailureBlocksThisRun = new Set<string>();
  // W1-T4597: an ENVIRONMENTAL block (containment probe, isolation preflight, transient, git fetch) is
  // held in process only until its cooldown, then the projection decides, so one long-lived daemon can
  // still re-offer it; a restart on new code clears this map anyway.
  const environmentalBlocksThisRun = new Map<string, number>();
  // A zero-cost `blocked_illformed` verdict is a pre-dispatch admission refusal, not a durable
  // independent failure. Exclude its unchanged task contract only for this process, so it cannot
  // spin on the same immutable plan; a changed contract deliberately clears the entry below and is
  // admitted through the normal lint path again. The serialised Task is local scheduling state, not
  // a ledger identity: the historical refusal stays visible without surviving a correction.
  const illformedAdmissionBlocksThisRun = new Map<string, string>();
  // A task can become non-runnable after this process loaded its selector snapshot but before its
  // worker reaches the current-plan admission gate. Keep that expected freshness race out of the
  // fatal-error path, and keep the stale snapshot from immediately offering the same id again.
  const invalidatedAdmissionsThisRun = new Set<string>();
  // The cross-task counterpart to the map above — content-keyed on whether the last transient verdict
  // was a different task id, never on one task's own retry budget (W1-T2517).
  let apiWindowHoldState: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  // Circuit-breaker escalation dedup. This loop is persistent, so without it a task that stays tripped
  // would be re-escalated on every idle poll for as long as the daemon runs. This set bounds the
  // CALLBACK to the first observation of each task id this run; the predicate itself is still
  // consulted, and still excludes the task, every tick (P29(ii)).
  const circuitEscalated = new Set<string>();
  // W1-T10348: each (task, reason) a released task was filtered under, so a stable filter is named once per process.
  const releasedFilteredNamed = new Set<string>();
  const pauseHoldGovernorStates = new Map<string, PauseHoldGovernorState>();
  // W1-T4685: this run's own repeated-observation tracker — never a module-level singleton, so two
  // unrelated `runDaemon` calls in the same test process never share rows. Alongside (never instead
  // of) the existing per-tick `daemon.pause` row: readers already keyed on that step's cadence for
  // liveness (fleet-liveness.ts's `HEARTBEAT_STEPS`) and for pause-duration counting keep working
  // unchanged, while a reader that wants "how many identical ticks" can read this row's `count`
  // instead of counting `daemon.pause` lines (design (iii)).
  const gateObservations = createGateObservationState();
  const GATE_OBSERVATION_HEARTBEAT_MS = 5 * 60_000;
  // W1-T4025: lifetime pressure is a sensor. Keep one task per tick for the asynchronous judge;
  // no judge/proposal failure can change eligibility or hold a healthy sibling lane.
  const lifetimePressureTasks = new Map<string, Task>();
  const lifetimePressureObserved = new Set<string>();
  const flushLifetimePressure = async (report: typeof emitLog = log): Promise<void> => {
    if (lifetimePressureTasks.size === 0 || deps.onLifetimePressure === undefined) return;
    const tasks = [...lifetimePressureTasks.values()];
    lifetimePressureTasks.clear();
    try {
      await deps.onLifetimePressure(tasks);
    } catch (error) {
      report("dispatch.lifetime_pressure.failed", {
        tasks: tasks.map((task) => task.id),
        error: String((error as Error)?.message ?? error),
      });
    }
  };
  // Spawn-infra escalation dedup, content-keyed on the failure's own reason text rather than task id:
  // the vanished-binary class blocks dispatch identically for every task, so task-id keying would
  // re-escalate once per distinct task hitting the same cause (W1-T113 part iii).
  const toolchainEscalated = new Set<string>();
  // CONSECUTIVE spawn-infra failures — backs the backoff below; reset by any
  // runOne call that does NOT throw this class (success or an unrelated verdict).
  let consecutiveSpawnInfraFailures = 0;
  // The GitHub-transport counterpart to the spawn-infra streak. A worker can finish useful work,
  // push a PR, and then lose its post-run rollup read; that must slow dispatch without exiting the
  // scheduler that owns every review and repair lane (W1-T3165).
  let consecutiveDispatchTransportFailures = 0;
  // Headroom reserve escalation dedup — the same per-episode bound as the breaker above. A sustained
  // breach is read fresh every tick, so without this the hook would fire on every idle poll. Cleared
  // the moment a read reports the window back under the reserve (P34 (c), W1-T249).
  let headroomReserveEscalated = false;
  const fleetAccountEpisode = createFleetAccountEpisode();
  // Disk headroom escalation dedup, threaded rather than redeclared into every ticker below so all three phases share
  // one latch for this run: a breach first observed mid-dispatch must not re-escalate the moment another phase
  // observes the same unresolved reading. Held as a mutable object because the ticker is a free function called fresh
  // per phase, and a closed-over boolean would reset every call (W1-T1082).
  const diskHeadroomLatch: { escalated: boolean } = { escalated: false };
  // Quota exhaustion escalation dedup, kept per bucket rather than as one flag: each bucket is read and escalates
  // independently, so one exhaustion must never suppress the other in the same hour (W1-T372).
  const quotaExhaustedEscalated: Record<"core" | "graphql", boolean> = { core: false, graphql: false };
  // Queue starvation escalation dedup — the same per-episode bound. The census is re-derived fresh
  // every idle tick, so without this the hook would fire on every poll for as long as the queue stays
  // starved. Cleared the moment a tick is not starved.
  let starvationEscalated = false;
  // Stale-reviewer-code recurrence (W1-T3691) — reconstructed from the ledger at boot (see
  // `priorStaleReviewerRecurrenceState`'s own doc) so a restart already requested for a sha
  // survives the very process replacement it caused (design v); updated once per tick below from
  // that tick's own `sweepCycleOutcome.reviewerCodeStale` reading.
  const bootLedgerLines = deps.readLedgerLines?.() ?? [];
  const measuredRuns: MeasuredRun[] = [];
  const runLengths = dispatchRunHistory(bootLedgerLines, measuredRuns);
  // W1-T8514: the measured run lengths behind a priority reservation's backfill release. The lane clock is the
  // current dispatch phase's, bound once that phase exists; before it, no task is in flight.
  let laneElapsedMs: (taskId: string) => number | undefined = () => undefined;
  const priorityBackfill: PriorityBackfillEstimates = {
    runLengthsMs: (taskId) => measuredRuns.filter((r) => r.taskId === taskId).map((r) => r.ms),
    fleetRunLengthsMs: () => measuredRuns.map((r) => r.ms),
    elapsedMs: (taskId) => laneElapsedMs(taskId),
  };
  const logPriorityDeferral = (d: PriorityDeferral): void => {
    log("dispatch.deferred_for_priority", { task: d.task.id, priority: d.task.priority ?? null, waiting_task: d.waiting.id,
      waiting_priority: d.waiting.priority ?? null, holders: d.holders, paths: d.paths,
      expected_duration_ms: d.expectedDurationMs ?? null, expected_start_ms: d.expectedStartMs ?? null });
  };
  const logPriorityRelease = (r: PriorityReservationRelease): void => {
    log("dispatch.priority_reservation_released", { task: r.task.id, waiting_task: r.waiting.id, reason: r.reason });
  };
  const passedOverStates = new Map<string, string>();
  const observePassedOver = (site: "tick" | "lane-refill"): NonNullable<NextRunnableOpts["onPassedOver"]> => (task, detail) => {
    const key = passedOverStateKey(detail);
    if (passedOverStates.get(task.id) === key) return;
    log("dispatch.passed_over", { task: task.id, priority: task.priority ?? null, site,
      passed_for: detail.passedFor, holders: detail.holders });
    passedOverStates.set(task.id, key);
  };
  const forgetPassedOver = (current: Plan, collected: readonly Task[] = []): void => {
    for (const task of collected) passedOverStates.delete(task.id);
    for (const id of passedOverStates.keys()) if (!current.byId.has(id)) passedOverStates.delete(id);
  };
  // W1-T8235: the gap since the previous process's last idle record is charged to `restart` (this process's first
  // sample ends it), at the idle slots that record left.
  idleLaneAccount = chargeRestartGap(idleLaneAccount, lastIdleLaneRecord(bootLedgerLines));
  let restartHistoryLines: readonly string[] = bootLedgerLines;
  let sweepSeedSource: "ledger_union" | "live_ledger" = deps.readRestartHistory ? "ledger_union" : "live_ledger";
  try { restartHistoryLines = deps.readRestartHistory?.() ?? bootLedgerLines; }
  catch (error) {
    restartHistoryLines = [];
    sweepSeedSource = "live_ledger";
    log("daemon.restart_history_unreadable", { error: String((error as Error)?.message ?? error) });
  }
  // W1-T9632: the union holds the live file too, so ONE source seeds the learner and no live row counts twice.
  for (const ms of settledSweepDurations(sweepSeedSource === "ledger_union" ? restartHistoryLines : bootLedgerLines)) recordSettledSweep(sweepBound, ms);
  sweepBound.seededFrom = sweepSeedSource;
  const resumableHandoffs = pendingWorkerBoundaryHandoffs(bootLedgerLines);
  // W1-T8676: a settled run may have written or consumed its task's receipt; re-fold that task's rows so the next
  // pass's run-branch guard reads it. A failed read keeps the entry it had.
  const refreshResumableHandoff = (taskId: string, report: typeof emitLog): void => {
    if (!deps.readLedgerLines) return;
    let rows: readonly string[];
    try {
      rows = deps.readLedgerLines();
    } catch (error) {
      report("daemon.handoff_receipt_refresh_failed", { task_id: taskId, error: String((error as Error)?.message ?? error) });
      return;
    }
    const needle = JSON.stringify(taskId);
    const receipt = pendingWorkerBoundaryHandoffs(rows.filter((raw) => raw.includes(needle))).get(taskId);
    if (receipt) resumableHandoffs.set(taskId, receipt);
    else resumableHandoffs.delete(taskId);
  };
  // W1-T8676: the blocking runs whose release this process already ledgered, beside the projection's receipt.
  const ledgeredIndependentBlockReleases = new Set<string>();
  for (const [taskId, receipt] of handoffReceiptsToCarry(bootLedgerLines)) {
    log(HANDOFF_RECEIPT_STEP, { task_id: taskId, branch: receipt.branch, head_sha: receipt.headSha, carried: true });
  }
  let staleReviewerRecurrence: StaleReviewerRecurrenceState | undefined = priorStaleReviewerRecurrenceState(bootLedgerLines);
  const staleBodyReported = new Set<string>();
  // W1-T5344: per-task delivery-failure parks, rebuilt from the ledger so a restart does not reset
  // them; consulted by the dispatch filter's independent-failure hold below.
  const laneDeliveryParks = priorLaneDeliveryParks(bootLedgerLines);
  // W1-T9680: one probe per credential refusal, shared by its lane's refill and the settle loop.
  const credentialProbes = new WeakMap<object, Promise<FleetCredentialProbe>>();
  const fleetCredentialFor = (err: object): Promise<FleetCredentialProbe> => {
    let probe = credentialProbes.get(err);
    if (probe === undefined) {
      const ask = deps.probeFleetPushCredential ?? (async (): Promise<FleetCredentialProbe> => ({ state: "unreadable", detail: "no fleet credential probe is wired" }));
      probe = ask().catch((error: unknown): FleetCredentialProbe => ({ state: "unreadable", detail: String((error as Error)?.message ?? error) }));
      credentialProbes.set(err, probe);
    }
    return probe;
  };
  // Needs-human escalation dedup for the same recurrence, keyed on sha so a sustained pin notifies
  // once rather than once per tick, mirroring `starvationEscalated`'s own discipline.
  let staleReviewerNeedsHumanSha: string | undefined;
  const maxSpawnInfraBackoffMs = opts.maxSpawnInfraBackoffMs ?? DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS;
  const maxApiWindowHoldMs = opts.maxApiWindowHoldMs ?? DEFAULT_MAX_API_WINDOW_HOLD_MS;
  // Bounded degraded mode: recon R-7 measured the usage read unreadable about 78% of the time, so
  // this counts CONSECUTIVE misses rather than treating any single one as decisive.
  let consecutiveUnreadable = 0;
  // The park clock. Set when a park begins, cleared whenever it ends — by a readable probe or by the
  // ceiling forcing. Clearing on a force is what re-arms the ceiling: a valve that opened once and
  // stayed open would let a blind fleet dispatch unbounded.
  let parkedSinceMs: number | undefined;
  // Once per park, not once per tick: the loop polls every 60s, so a per-tick escalation is a pager.
  let parkCeilingEscalated = false;
  // Seeded from the ledger so the once-per-string bound survives a restart, then maintained
  // in-process for the life of this daemon.
  const reportedUnrecognisedResets = new Set<string>(deps.priorUnrecognisedResets ?? []);
  const headroomPolicy = opts.headroomPolicy ?? buildDefaultHeadroomPolicy(opts.headroomLimitPct);
  // The headroom governor switch (ruling fb-1784894405468-a4153e). Library default true; the live
  // entry passes the host posture resolved from config or env, also default true.
  const headroomEnabled = opts.headroomEnabled ?? true;
  // The Clock port (W1-T2897): `deps.now` keeps its legacy `() => Date` shape (many tests inject
  // it directly), adapted here once for every reading this loop needs.
  const daemonClock: Clock = clockFromDateFn(deps.now);
  // W1-T8883: the heap-ceiling shadow learns from live heap samples kept across boots (7 days) and ledgers the ceiling
  // it would propose, at start and hourly. REPORT ONLY: the ceiling in force is unchanged. Needs the state directory.
  const heapShadowStateDir = deps.fleetLane?.stateDir ?? deps.plainBackfill?.stateDir;
  const heapShadow = heapShadowStateDir === undefined || !deps.readMemoryTelemetry ? undefined : createHeapShadow({
    path: heapSamplePath(heapShadowStateDir),
    clock: daemonClock,
    ...deps.heapShadowSeams,
    onPersistError: (reason) => emitLog("daemon.heap_samples_persist_failed", { reason }),
    onProposal: (proposal) => log("daemon.heap_ceiling_shadow", { basis: "hourly", ...proposal }),
  });
  if (heapShadow) {
    installHeapShadow(heapShadow);
    try {
      log("daemon.heap_ceiling_shadow", {
        basis: "learned", ...heapShadow.propose(), ...(heapShadow.loadError === undefined ? {} : { samples_unread: heapShadow.loadError }),
      });
    } catch (e) {
      log("daemon.heap_ceiling_shadow_failed", { reason: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
  // W1-T4390: the SRE governor's port — injected, else over the fleet lane's state root (see DaemonDeps.sreGovernor).
  const sreFallbackRoot = deps.fleetLane;
  const sreGovernor: SreGovernorEnforcer | undefined =
    deps.sreGovernor ?? (sreFallbackRoot ? daemonSreGovernorEnforcer({ ledgerPath: sreFallbackRoot.ledgerPath, laneOffPath: sreLaneOffPath(sreFallbackRoot.stateDir) }) : undefined);
  // One sampler state shared by the main loop and every in-flight ticker, so the two can never
  // double-read and staleness is measured against whichever read last. Seeded to 0 so the first long
  // phase after boot samples immediately (W1-T2565).
  const headroomSampler = { lastSampleMs: 0, clock: daemonClock, policy: headroomPolicy, enforced: headroomEnabled };
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? DEFAULT_UNREADABLE_DEGRADED_LIMIT;
  const parkCeilingMs = opts.headroomParkCeilingMs ?? HEADROOM_PARK_CEILING_MS;
  // Top-level waits are interruptible, as are phase-ticker waits that own a retrigger. Light and
  // pass ticker waits stay on the plain clock, so they cannot consume an event without reconciling it
  // through the ordinary gated full pass (W1-T2568).
  const sleepUntilSweepWake = deps.sleepUntilSweepWake ?? deps.sleep;
  // Resolved once, for this process's whole lifetime: `DaemonOpts` is the frozen-at-boot configuration. Floored at 1,
  // never 0, so a misconfigured lane count can never silently mean "dispatch nothing"; the budget helper floors its
  // own input the same way, so a value below 1 clamps up here rather than producing two disagreeing floors (W1-T343).
  const laneCount = Math.max(1, opts.laneCount ?? 1);
  // W1-T9097 (ADR 0007 C): the lane target, re-read at most once per poll interval and ledgered on each reading.
  // Shadow changes nothing; enforce caps NEW admissions only, so a running lane is never stopped by a lower target.
  const laneGovernorPorts = laneCount < 2 ? undefined
    : deps.laneGovernor ?? (deps.fleetLane ? defaultLaneGovernorPorts(deps.fleetLane.stateDir) : undefined);
  let laneGovernorMode: LaneGovernorMode = "shadow";
  try { if (laneGovernorPorts) laneGovernorMode = laneGovernorPorts.mode(); }
  catch (error) {
    // An unreadable mode never enforces: the governor stays in shadow and the row names why.
    log(LANE_TARGET_STEP, { mode: "shadow", mode_unread: error instanceof Error ? error.message : String(error) });
  }
  let laneTargetReading: { atMs: number; result: LaneTarget } | undefined;
  /** The lanes new admissions may fill: the governor's target under enforce, otherwise unbounded. */
  const enforcedLaneTarget = (inFlight: number, wipBound: number | undefined): number => {
    if (!laneGovernorPorts) return Infinity;
    const nowMs = daemonClock.now();
    if (!laneTargetReading || nowMs - laneTargetReading.atMs >= pollIntervalMs) {
      let memory: LaneMemoryReading | { unread: string };
      try { memory = laneGovernorPorts.read(); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        memory = { unread: reason };
      }
      const result = laneTarget({ previous: laneTargetReading?.result.next, inFlight, memory, wipBound, cpuCount: laneGovernorPorts.cpuCount() });
      laneTargetReading = { atMs: nowMs, result };
      log(LANE_TARGET_STEP, laneTargetPayload(result, { mode: laneGovernorMode, fixed: laneCount, inFlight }));
    }
    return laneGovernorMode === "enforce" ? laneTargetReading.result.target : Infinity;
  };

  // W1-T4077: stopped by `summary`, which every exit path of this function returns through.
  const prActionPumpRef: { stop: () => void; isBusy: () => boolean } = { stop: () => {}, isBusy: () => false };
  const improvementActionPumpRef: ImprovementActionPump = {
    stop: () => {}, settled: async () => {}, isBusy: () => false, activeOperation: () => undefined,
  };
  // W1-T4087: its own timer, so a main loop busy for many minutes never delays a plain message.
  const plainBackfill = deps.plainBackfill ? startPlainBackfill(deps.plainBackfill, pollIntervalMs, log) : undefined;
  const recommendationBackfill = deps.recommendationBackfill ? startRecommendationBackfill(deps.recommendationBackfill, pollIntervalMs, log) : undefined;
  // W1-T4089: the fleet's own findings, filed at the pace the fleet merges work.
  const fleetLaneDeps = deps.fleetLane;
  const fleetLane = fleetLaneDeps ? startFleetLane(() => triageFleetLaneAsync(fleetLaneDeps), pollIntervalMs, log) : undefined;
  // W1-T4088: the same pattern — an operator's reply is answered within a poll interval.
  const inboxResponder = deps.inboxResponder ? startInboxResponder(deps.inboxResponder, pollIntervalMs, log) : undefined;
  const gardenerRef: { stop: () => void } = { stop: () => {} };
  // W1-T5803 — ONE pause review clock spans consecutive paused ticks, so its interval accrues across
  // them. A per-tick clock restarted its interval every tick and stop() won the race: live 2026-10-05,
  // 33 paused ticks ran one pass. Stopped by the first unpaused tick, and by `summary` on every exit.
  const pauseReview: { clock?: InterphaseReviewClock; reported: number } = { reported: 0 };
  const reportPauseReviewPasses = (passes: number, report: typeof emitLog = log): void => {
    if (passes > pauseReview.reported) report("daemon.pause.review_passes", { tick: ticks, passes: passes - pauseReview.reported });
    pauseReview.reported = passes;
  };
  const stopPauseReviewClock = async (report: typeof emitLog = log): Promise<void> => {
    const clock = pauseReview.clock;
    if (!clock) return;
    pauseReview.clock = undefined;
    reportPauseReviewPasses((await clock.stop()).passes, report);
    pauseReview.reported = 0;
  };
  let ownedServicesClosed = false;
  const closeOwnedServices = async (report: typeof emitLog = log): Promise<void> => {
    if (ownedServicesClosed) return;
    ownedServicesClosed = true;
    repositoryMaintenanceStopped = true;
    dueRungsStopped = true;
    if (dueRungsTimer) clearInterval(dueRungsTimer);
    if (repositoryMaintenanceTimer) clearInterval(repositoryMaintenanceTimer);
    clearTimeout(bootGateTimer);
    bootGateTrigger ??= "exited";
    if (heapShadow) {
      try { heapShadow.flush(); } catch { /* Reason: report-only samples; a failed flush loses at most one persist gap. */ }
      if (installedHeapShadow() === heapShadow) installHeapShadow(undefined);
    }
    const failures: unknown[] = [];
    try { if (pauseReview.clock) await stopPauseReviewClock(report); }
    catch (reason) { /* Retained in the cleanup AggregateError, after every other stop is attempted. */ failures.push(reason); }
    for (const stop of [
      () => prActionPumpRef.stop(), () => improvementActionPumpRef.stop(), () => plainBackfill?.stop(), () => recommendationBackfill?.stop(), () => fleetLane?.stop(),
      () => inboxResponder?.stop(), () => gardenerRef.stop(), () => livenessPulse?.stop(),
    ]) {
      try { stop(); }
      catch (reason) { /* Retained in the cleanup AggregateError, never converted into successful closure. */ failures.push(reason); }
    }
    // Attempt every owned cleanup once; semantic cleanup failures remain caller-visible.
    for (const child of children.values()) child.detach?.();
    if (failures.length) throw new AggregateError(failures, "owned daemon cleanup failed");
  };
  const summary = async (stopReason: DaemonStopReason, stopDetail?: string, reporting: SettlementReporting = createSettlementReporting()): Promise<DaemonSummary> => {
    const report = reporting.report;
    await closeOwnedServices(report);
    if (stopReason === "stopped") {
      if (backgroundSweep) await backgroundSweep;
      // The pump is stopped above, so no new handoff starts; the active one finishes within the review bound.
      const [abandonedPass, abandonedReviews] = await Promise.all([
        drainImprovementActionHandoff(improvementActionPumpRef, sweepWallClockBoundMs),
        drainInFlightReviews({ boundMs: sweepWallClockBoundMs }),
      ]);
      if (abandonedPass) {
        // Never a clean settle: the exit row and the summary both name what the bound left running.
        report("improvement.action_handoff_abandoned", { ...abandonedPass, bound_ms: sweepWallClockBoundMs });
        const what = abandonedPass.operation_id === null ? "saved-action queue read" : `handoff ${abandonedPass.operation_id}`;
        stopDetail = [stopDetail, `improvement ${what} still running at the ${sweepWallClockBoundMs} ms stop bound`].filter(Boolean).join("; ");
      }
      if (abandonedReviews > 0 || abandonedPass) report("daemon.stop_drain.completed", {
        abandoned_in_flight_reviews: abandonedReviews, bound_ms: sweepWallClockBoundMs,
        ...(abandonedPass ? { abandoned_improvement_pass: abandonedPass } : {}),
      });
    }
    flushIdleLaneWindow(report);
    const s: DaemonSummary = { attempted, merged, stopReason, stopDetail, costUsd, ticks };
    // W1-T9321 design 4: a process that opened its boot gate and exited without one gated cadence run is the
    // 2026-10-13 outage's shape; the exit row names it, so a repeat is one grep away. Only a boot that gated something.
    report("daemon.summary", { ...s, ...(bootGateHolds ? {
      gated_cadence_runs: gatedCadenceRuns,
      gate_opened_without_cadence: bootGateOpenedAtMs !== undefined && gatedCadenceRuns === 0,
    } : {}) });
    if (reporting.faults.length) {
      s.reportingFaults = reporting.faults.map(({ phase, reason }) => ({ phase, detail: reportingFaultDetail(reason) }));
      // A hard operator STOP must stay a clean stop, not invite a supervisor restart.
      // Its separate reportingFaults still explicitly refuse delivered-report assurance.
      if (stopReason !== "stopped") s.stopReason = "error";
      s.stopDetail = [stopDetail, ...s.reportingFaults.map(({ phase, detail }) => `${phase}: ${detail}`)].filter(Boolean).join("; ");
    }
    return s;
  };
  if (deps.livenessPulse) livenessPulse = startLivenessPulse(pollIntervalMs, idleLaneClock, log,
    (sample) => reportTickLag(deps, { ...sample, lastStepBeforeBlock: deps.lastStepBeforeBlock?.(),
      ...takeSyncSpawn(deps, "pulse") }, log));
  const prActionPump = startPrActionPump(deps, pollIntervalMs, log);
  prActionPumpRef.stop = prActionPump.stop;
  prActionPumpRef.isBusy = prActionPump.isBusy;
  Object.assign(improvementActionPumpRef, startImprovementActionPump(deps, pollIntervalMs, log));
  // W1-T5720 — THE BOOT GATE. Tick 1 runs a light pass at once, then holds its cadences until the first full
  // pass returns or the BACKSTOP passes (10-05: first `sweep.pass` 6.7-15.8 min after `daemon.boot`). It holds
  // only what is wired: with nothing to defer, tick 1's admission keeps W1-T4998's no-wait contract.
  const adoptedChildren = deps.adoptRunChildren ? deps.adoptRunChildren() : [];
  const children = new Map<string, AdoptedRunChild>(adoptedChildren.map((child) => [child.runId, child]));
  let childMode = deps.adoptRunChildren !== undefined;
  const childTaskIds = (): string[] => [...children.values()].map((child) => child.taskId);
  const hasChildTask = (id: string): boolean => childTaskIds().includes(id);
  // W1-T10000: a run waiting for its child's admission is out-of-process work too; the restart abandons it.
  const pendingChildren = new Map<string, RunChildPending & { sinceMs: number }>();
  const outOfProcess = (id: string): boolean => hasChildTask(id) || pendingChildren.has(id);
  const bootGateBoundMs = opts.bootCadenceGateBoundMs ?? BOOT_CADENCE_GATE_BOUND_MS;
  const bootGateStartedAtMs = daemonClock.now();
  const bootGateHolds = deps.sweep !== undefined && ((deps.gardens?.length ?? 0) > 0 || BOOT_GATED_CADENCES.some((k) => deps[k]));
  let bootGateTrigger: string | undefined = bootGateHolds ? undefined : "nothing_to_defer";
  // W1-T9072 — THE GATE HOLDS CADENCES, NEVER DISPATCH. Tick 1's selection reads only what the boot itself loads:
  // the tick's own `refreshMerged` builds the projection `isOpenPr`, `isCreditIndeterminate`, `openPrCount` and
  // `readQueueAdmission` read; the run-branch listing is its own per-tick read; the dispatch claim is taken inside
  // `runOne`. The two inputs the first full pass produces fail safe without it: no `planOnlyRunBranchReceipts` means
  // every pushed run branch still blocks, and no `reviewerCodeStale` means no stale-reviewer restart. So no input is
  // gated, and dispatch waits on nothing. The deferral rows are written once, on the first gated tick.
  let bootGateOpenedAtMs: number | undefined = bootGateHolds ? undefined : bootGateStartedAtMs;
  let bootCadencesDeferred = false;
  // W1-T9225 — TICK 1 STARTS THE BOOT REVIEW PASS AND NEVER AWAITS IT. Dispatch reads nothing that pass produces
  // (its effects are statuses, arms and ledger rows), and its review workers and tick 1's lanes share the existing
  // worker budget and memory admission, as on every later tick. Only the gated cadences wait for it: they run once the
  // gate is open AND this pass has settled, so W1-T5720's order (reviews before the cadences) still holds.
  let bootReviewStarted = false;
  let bootReviewInFlight = false;
  // W1-T9321 — THE GATE OPENING STARTS THE CADENCES. W1-T9072 left them, and the W1-T7690 due timer that drives them,
  // to the first iteration top after the gate opens; tick 1 waits for its lanes, and from 2026-10-13T14:24Z every core
  // process was replaced before tick 2 came, so none ran. The timer now starts the moment the gate is open AND the boot
  // review pass has settled, whichever is last. Assigned once the timer exists; until then the iteration top starts it.
  let releaseGatedCadences = (): void => {};
  const gatedCadencesReleased = (): boolean => bootGateTrigger !== undefined && !bootReviewInFlight;
  // How many gated cadence runs this process started, for the exit row (W1-T9321 design 4).
  let gatedCadenceRuns = 0;
  const deferredGardens = bootGateHolds ? (deps.gardens ?? []) : [];
  type BootWait = "first_full_pass" | "boot_review_pass";
  const bootWaitReason = (waitsFor: readonly BootWait[]): string =>
    waitsFor.length > 1 ? "first full pass and boot review pass have not settled"
      : waitsFor[0] === "boot_review_pass" ? "boot review pass has not settled" : "first full pass has not settled";
  const deferBootCadence = (cadence: string, waitsFor: readonly BootWait[] = ["first_full_pass"]): void =>
    log("daemon.boot_gate.deferred", { cadence, reason: bootWaitReason(waitsFor), waits_for: waitsFor, bound_ms: bootGateBoundMs });
  const gardens = [
    ...(deps.knowledgeGardener ? [startGarden(knowledgeGardenSpec({ ...deps.knowledgeGardener, prState: undefined }), deps.knowledgeGardener, pollIntervalMs)] : []),
    ...(bootGateHolds ? [] : (deps.gardens ?? [])).map((start) => start(pollIntervalMs)),
  ];
  gardenerRef.stop = () => {
    const failures: unknown[] = [];
    for (const garden of gardens) {
      try { garden.stop(); }
      catch (reason) { /* Every garden still gets its stop; all failures propagate in the AggregateError. */ failures.push(reason); }
    }
    if (failures.length) throw new AggregateError(failures, "owned garden cleanup failed");
  };
  if (deferredGardens.length > 0) deferBootCadence("gardens");
  const openBootGate = (trigger: string): void => {
    if (bootGateTrigger !== undefined) return;
    bootGateTrigger = trigger;
    bootGateOpenedAtMs = daemonClock.now();
    clearTimeout(bootGateTimer);
    log("daemon.boot_gate.opened", {
      trigger, waited_ms: Math.max(0, daemonClock.now() - bootGateStartedAtMs), bound_ms: bootGateBoundMs,
      pass_in_flight: sweepLiveness.inFlight,
    });
    gardens.push(...deferredGardens.map((start) => start(pollIntervalMs)));
    releaseGatedCadences();
  };
  // Unref'd: while the gate is closed the first pass's own bound timer keeps the process alive.
  const bootGateTimer = bootGateHolds ? setTimeout(() => openBootGate("backstop"), bootGateBoundMs).unref() : undefined;
  // W1-T9072 — ONE ROW PER BOOT: how long this process took to reach its first dispatch, and whether the gate was
  // open by then. Written at the first lane start, or at the first selection that admits nothing.
  const bootAtIso = daemonClock.iso();
  let bootFirstSelectionAtMs: number | undefined;
  let bootFirstDispatchWritten = false;
  const noteBootFirstDispatch = (outcome: { startedAtMs: number; admitted: number } | { heldReason: string }): void => {
    if (bootFirstDispatchWritten) return;
    bootFirstDispatchWritten = true;
    const sinceBoot = (atMs: number | undefined): number | null => (atMs === undefined ? null : Math.max(0, atMs - bootGateStartedAtMs));
    log("daemon.boot_first_dispatch", {
      boot_at: bootAtIso,
      gate_open_ms: sinceBoot(bootGateOpenedAtMs),
      first_selection_ms: sinceBoot(bootFirstSelectionAtMs),
      ...("heldReason" in outcome
        ? { first_run_start_ms: null, admitted_count: 0, held_reason: outcome.heldReason }
        : { first_run_start_ms: sinceBoot(outcome.startedAtMs), admitted_count: outcome.admitted }),
    });
  };

  // W1-T9631 — a restart toward the target the boot checkout could not reach would boot into the same refusal and
  // loop, so that reading is not stale (one row per tick); once main moves past it, the reading passes untouched.
  const checkoutBlockedTarget = (deps.bootCheckoutBlocked ?? process.env.RMD_BOOT_CHECKOUT_BLOCKED)?.trim() || undefined;
  let freshnessBlockedCycle = -1;
  const gateBlockedCheckout = (freshness: DaemonFreshness): DaemonFreshness => {
    if (!freshness.stale || freshness.newSha !== checkoutBlockedTarget) return freshness;
    if (freshnessBlockedCycle !== cyclesEntered) {
      freshnessBlockedCycle = cyclesEntered;
      log("daemon.freshness_blocked", { old_sha: freshness.oldSha, new_sha: freshness.newSha, reason: "boot_checkout_blocked" });
    }
    return { stale: false };
  };
  const checkFreshness = deps.checkFreshness && checkoutBlockedTarget
    ? (): DaemonFreshness | Promise<DaemonFreshness> => {
        const read = deps.checkFreshness!();
        return isPendingFreshness(read) ? read.then(gateBlockedCheckout) : gateBlockedCheckout(read);
      }
    : deps.checkFreshness;

  // W1-T3756 — an ordinary false result used to erase the distinction between a current daemon and
  // one that could not inspect itself. Log the adapter's four decision arms at the consumer, where
  // every tick sees the same answer it acts on. Injected legacy callers may omit `notStale`; only
  // the real adapter is the production evidence producer, so an absent annotation remains silent.
  const logNotStaleFreshness = (freshness: DaemonFreshness | undefined): void => {
    if (!freshness || freshness.stale || !freshness.notStale) return;
    const outcome = freshness.notStale;
    let pressureEvidence: Record<string, unknown> = {};
    if (outcome.arm === "dirty" && outcome.behind && outcome.newSha) {
      const nowMs = daemonClock.now();
      observeFreshnessAdvance(outcome.newSha, nowMs);
      const { decision, withheldEvidence } = scoreFreshness(outcome.changes, nowMs);
      pressureEvidence = { behind: true, stale_since_ms: staleSinceMs, weight: decision.weight,
        age_pressure: decision.agePressure, pressure: decision.pressure, ...withheldEvidence };
      if (decision.pressure >= DEPLOY_RESTART_SCORE_THRESHOLD.value && !dirtyBlockedShas.has(outcome.newSha)) {
        dirtyBlockedShas.add(outcome.newSha);
        log("daemon.freshness_blocked_dirty", { old_sha: outcome.oldSha, new_sha: outcome.newSha,
          dirty_paths: outcome.dirty_paths, ...pressureEvidence });
      }
    }
    log("daemon.freshness_not_stale", {
      arm: outcome.arm,
      ...(outcome.arm === "unassessed" ? { service_status: outcome.serviceStatus } : {}),
      ...(outcome.arm === "unassessed" && outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.arm === "dirty" && outcome.oldSha ? { old_sha: outcome.oldSha } : {}),
      ...(outcome.arm === "dirty" && outcome.newSha ? { new_sha: outcome.newSha } : {}),
      ...(outcome.arm === "dirty" && outcome.dirty_paths ? { dirty_paths: outcome.dirty_paths } : {}),
      ...pressureEvidence,
      ...(outcome.arm === "immaterial" ? { old_sha: outcome.oldSha, new_sha: outcome.newSha } : {}),
      // W1-T9092: which list judged the advance, and how much of it lay outside the process closure (or why unread).
      ...(outcome.arm === "immaterial" && outcome.basis ? { basis: outcome.basis } : {}),
      ...(outcome.arm === "immaterial" && outcome.outsideClosure !== undefined ? { outside_closure: outcome.outsideClosure } : {}),
      ...(outcome.arm === "immaterial" && outcome.closureUnreadable ? { closure_unreadable: outcome.closureUnreadable } : {}),
    });
  };

  // W1-T6093: remember observations at both the first-cycle guard and the shared decision boundary.
  const observeFreshnessAdvance = (newSha: string, nowMs: number, heldSinceMs?: number): void => {
    staleSinceMs = Math.min(staleSinceMs ?? nowMs, heldSinceMs ?? nowMs);
    if (newSha !== lastAdvanceSha) {
      lastAdvanceSha = newSha;
      lastAdvanceAtMs = nowMs;
      advancesCoalesced++;
    }
  };

  const scoreFreshness = (changes: readonly DeployWorthChange[] | undefined, nowMs: number, siblingInFlight = false) => {
    const staleAtMs = staleSinceMs!;
    const busy =
      siblingInFlight ||
      backgroundSweep !== undefined || sweepLiveness.inFlight || detachedSweepActionCount() > 0 || inFlightReviewCount() > 0;
    // W1-T5476: a review withheld for stale reviewer code is the lag itself stalling the review lane. An
    // unreadable ledger is named on the row and leaves the count absent: unknown, never a zero.
    const withheld = deps.readLedgerLines ? withheldReviewsSince(deps.readLedgerLines, staleAtMs) : undefined;
    const withheldReviews = withheld?.kind === "counted" ? withheld.withheld : undefined;
    const withheldEvidence =
      withheld === undefined
        ? {}
        : withheld.kind === "unreadable"
          ? { withheld_reviews_error: withheld.error }
          : {
              withheld_reviews: withheld.withheld,
              // W1-T5530: reported, never weighed — see withheldReviewsSince's decision.
              withheld_unreadable: withheld.unreadable,
              ...(withheld.unparseable > 0 ? { withheld_reviews_unparseable: withheld.unparseable } : {}),
            };
    const decision = decideFreshnessRestart({ changes, busy, staleSinceMs: staleAtMs, nowMs, state: freshnessPressure, withheldReviews });
    freshnessPressure = decision.state;
    return { decision, busy, withheldEvidence };
  };

  // W1-T4945/W1-T6093: score the advance, then coalesce change-driven restarts within bounded staleness.
  let freshnessDecidedAtMs: number | undefined;
  const freshnessPhases: { decision_to_latch?: number; lanes?: number; pre_exit_pass?: number; drain?: number } = {};
  const decideFreshness = (freshness: Extract<DaemonFreshness, { stale: true }>, siblingInFlight = false): "restart" | "defer" => {
    const nowMs = daemonClock.now();
    observeFreshnessAdvance(freshness.newSha, nowMs, freshness.staleSinceMs);
    const staleAtMs = staleSinceMs!;
    const { decision, busy, withheldEvidence } = scoreFreshness(freshness.changes, nowMs, siblingInFlight);
    // OPERATOR RULING 2026-10-17: this lifetime began when the loop did (the boot gate's start); every release but the
    // fast paths waits until it is FRESHNESS_MIN_LIFETIME_MS old. Both rows carry it, so the hold is measurable.
    const coalesced = coalesceFreshnessRestart({
      decision, newSha: freshness.newSha, lastAdvanceAtMs: lastAdvanceAtMs!,
      staleSinceMs: staleAtMs, nowMs, window: FRESHNESS_COALESCE_WINDOW_MS, installInputsChanged: changesInstallInputs(freshness.changes),
      lifetimeStartedAtMs: bootGateStartedAtMs, minLifetimeMs: freshnessMinLifetimeMs,
    });
    const lifetimeEvidence = {
      lifetime_ms: Math.max(0, nowMs - bootGateStartedAtMs), min_lifetime_ms: freshnessMinLifetimeMs,
      ...(coalesced.reason === MIN_LIFETIME_HOLD ? { held_by: MIN_LIFETIME_HOLD } : {}),
    };
    const action = coalesced.action === "hold" ? "defer" : coalesced.action;
    if (action === "restart") freshnessDecidedAtMs ??= nowMs;
    const released = ["window_quiet", "upper_age", INSTALL_INPUTS_RELEASE].includes(coalesced.reason);
    if (coalesced.action === "hold" || freshnessHeld || released) {
      log("daemon.freshness_coalesced", {
        action: coalesced.action,
        new_sha: freshness.newSha,
        held_ms: Math.max(0, nowMs - staleAtMs),
        advances_coalesced: advancesCoalesced,
        window_ms: FRESHNESS_COALESCE_WINDOW_MS.value,
        window_reason: FRESHNESS_COALESCE_WINDOW_MS.reason,
        window_ends_at_ms: coalesced.windowEndsAtMs,
        reason: coalesced.reason,
        ...lifetimeEvidence,
      });
    }
    freshnessHeld = coalesced.action === "hold";
    log(FRESHNESS_DECISION_STEP, {
      action,
      busy,
      weight: decision.weight,
      age_pressure: decision.agePressure,
      pressure: decision.pressure,
      reason: coalesced.action === "hold" || released ? coalesced.reason : decision.reason,
      old_sha: freshness.oldSha,
      new_sha: freshness.newSha,
      ...withheldEvidence,
      ...lifetimeEvidence,
    });
    return action;
  };

  // The drain every restart takes before it returns: live fix workers and in-flight reviews finish (bounded),
  // best-effort cadences and CI waits are released to be re-derived after restart. Shared by the freshness exit
  // and the memory-pressure exit so neither restart can kill work the other would have waited for.
  // W1-T8172 — THE RESTART DRAIN STARTS WHEN THE RESTART LATCHES. 2026-10-15 the latch came at 18:29:00, the drain at
  // 18:59:45; it ran 1,217,693 ms against a 559,000 ms bound and abandoned the 4 reviews its clock admitted at 19:17.
  // What is in flight at the dispatch latch is the drain's from then: the lane wait is its wait, its bound runs from the
  // latch, and the exit waits only on what has not settled. Work admitted after the latch keeps the exit's own bound.
  type WaitedOn = Omit<RestartDrainInventoryEntry, "settled"> & {
    admitted?: "before_latch" | "after_latch"; settled_after_ms?: number; abandoned?: true; released?: true;
  };
  // Settlement is observed at the latch, not reconstructed from whatever remains at exit.
  const observeDrain = (startedAtMs: number, latchAtMs?: number) => {
    const items = new Map<Promise<void>, WaitedOn>();
    const watch = ({ settled, ...item }: RestartDrainInventoryEntry): void => {
      if (items.has(settled)) {
        const row = items.get(settled)!;
        row.phase = item.phase;
        delete row.released;
        return;
      }
      const row: WaitedOn = { ...item, ...(latchAtMs === undefined ? {} : {
        admitted: item.admitted_at_ms <= latchAtMs ? "before_latch" as const : "after_latch" as const,
      }) };
      items.set(settled, row);
      void settled.then(() => { row.settled_after_ms = Math.max(0, daemonClock.now() - startedAtMs); });
    };
    const snapshot = (completed = false): WaitedOn[] => {
      const waiting = completed ? new Set(restartDrainInventory().map(item => item.settled)) : undefined;
      return [...items].map(([work, row]) => ({ ...row, ...(completed && !row.released && row.settled_after_ms === undefined
        ? waiting!.has(work) ? { abandoned: true as const } : { released: true as const } : {}) }));
    };
    const release = (work: Promise<void>, phase: string): void => {
      const row = items.get(work);
      if (row) {
        row.phase = phase;
        row.released = true;
      }
    };
    return { watch, snapshot, release };
  };
  type LatchDrain = { latchAtMs: number; reviews: ReadonlySet<Promise<void>>; detached: number; started: boolean;
    observation: ReturnType<typeof observeDrain>; done?: true };
  let latchDrain: LatchDrain | undefined;
  // W1-T9808 — A LATCHED RESTART ADMITS NO WORK ITS DRAIN WOULD ABANDON. 2026-10-15 fixes for W1-T9113 and W1-T7699
  // started at 19:02 inside the 18:59:45 drain and were abandoned at its bound. From the latch to the exit, every
  // surface that admits a review or a fix asks this, per admission: does the kind's measured length fit the time left?
  type RestartWindow = { deadlineMs: number; lengths: { review?: number; "fix-dispatch"?: number }; held: number };
  let restartWindow: RestartWindow | undefined;
  const restartAdmission: RestartAdmission = (kind, surface, candidateMs) => {
    const lengthMs = kind === "dispatch-refill" ? candidateMs : restartWindow?.lengths[kind];
    if (restartWindow === undefined || lengthMs === undefined) return true;
    const leftMs = restartWindow.deadlineMs - daemonClock.now();
    if (leftMs > lengthMs) return true;
    if (surface === undefined) return false;
    restartWindow.held++;
    log("daemon.admission_held", { surface, kind, reason: "restart latched", time_left_ms: Math.max(0, leftMs), measured_length_ms: lengthMs });
    return false;
  };
  const latchedAdmission = (): RestartAdmission | undefined => restartWindow && restartAdmission;
  const beginLatchDrain = (latchAtMs: number): void => {
    if (latchDrain?.latchAtMs === latchAtMs) return;
    const lengths = measuredReviewLength();
    restartWindow = { deadlineMs: latchAtMs + sweepWallClockBoundMs, lengths: { review: lengths.ms, "fix-dispatch": lengths.fixMs }, held: 0 };
    const reviews = new Set(inFlightReviewRunsNow());
    const detached = detachedSweepActionCount();
    const observation = observeDrain(latchAtMs, latchAtMs);
    for (const item of restartDrainInventory()) observation.watch(item);
    if (freshnessDecidedAtMs !== undefined) freshnessPhases.decision_to_latch = Math.max(0, latchAtMs - freshnessDecidedAtMs);
    latchDrain = { latchAtMs, reviews, detached, observation, started: reviews.size > 0 || detached > 0 };
    if (latchDrain.started) log("daemon.freshness_drain.started", { started_at: "latch", latched_at: fixedClock(latchAtMs).iso(),
      detached_sweep_actions: detached, in_flight_reviews: reviews.size, waited_on: observation.snapshot() });
  };
  // W1-T8172 design 2: the drain's clock admits a pass only while the time left exceeds the measured review length.
  const measuredReviewLength = (): { ms?: number; fixMs?: number; source: "measured" | "measured_memo" | "no_history" | "unreadable" } => {
    try {
      const lines = deps.readLedgerLines?.() ?? [];
      const ms = medianReviewRunMs(lines);
      const fixMs = medianFixRoundMs(lines);
      if (ms !== undefined) return { ms, fixMs, source: "measured" };
      const memoMs = deps.readReviewMedianMs?.();
      return typeof memoMs === "number" && Number.isFinite(memoMs) && memoMs > 0
        ? { ms: memoMs, fixMs, source: "measured_memo" } : { fixMs, source: "no_history" };
    } catch (error) {
      // An unreadable timing input is no history: the clock admits as before W1-T8172, and the completion row says why.
      return { source: "unreadable" };
    }
  };

  // The drain every restart takes before it returns: live fix workers and in-flight reviews finish (bounded),
  // best-effort cadences and CI waits are released to be re-derived after restart. Shared by the freshness exit
  // and the memory-pressure exit so neither restart can kill work the other would have waited for.
  const drainBeforeRestart = async (stepPrefix: "daemon.freshness_drain" | "daemon.memory_drain", latchAtMs?: number): Promise<void> => {
    const fromLatch = stepPrefix === "daemon.freshness_drain" && latchAtMs !== undefined &&
      latchDrain?.latchAtMs === latchAtMs && !latchDrain.done ? latchDrain : undefined;
    if (fromLatch) fromLatch.done = true;
    const exitAtMs = daemonClock.now();
    const observation = fromLatch?.observation ?? observeDrain(exitAtMs, latchAtMs);
    for (const item of restartDrainInventory()) observation.watch(item);
    const detachedAtFreshness = detachedSweepActionCount();
    // A light pass's review sat in no registry the drain waited on, so the exit killed it mid-judgement.
    const reviewsAtExit = inFlightReviewRunsNow();
    const reviewsAtFreshness = reviewsAtExit.length;
    const latchStarted = fromLatch?.started === true ? fromLatch : undefined;
    if (detachedAtFreshness > 0 || reviewsAtFreshness > 0 || latchStarted) {
      const drainStartedAtMs = latchStarted ? latchStarted.latchAtMs : exitAtMs;
      const latchFields = fromLatch ? { started_at: fromLatch.started ? "latch" : "exit", latched_at: fixedClock(fromLatch.latchAtMs).iso() }
        : stepPrefix === "daemon.freshness_drain" ? { started_at: "exit" } : {};
      if (!latchStarted) log(`${stepPrefix}.started`, {
        ...latchFields,
        detached_sweep_actions: detachedAtFreshness,
        in_flight_reviews: reviewsAtFreshness,
        waited_on: observation.snapshot(),
      });
      // Bounds: what the latch saw has had the wait since the latch; anything newer gets the exit's whole bound.
      const latchLeftMs = fromLatch ? Math.max(0, fromLatch.latchAtMs + sweepWallClockBoundMs - exitAtMs) : sweepWallClockBoundMs;
      const seen = new Set(reviewsAtExit);
      const settled = new Set<Promise<void>>();
      const watch = (reviews: Iterable<Promise<void>>): void => {
        for (const review of reviews) { seen.add(review); void review.then(() => settled.add(review)); }
      };
      watch(reviewsAtExit);
      const afterLatch = (): Promise<void>[] => fromLatch ? [...seen].filter((review) => !fromLatch.reviews.has(review)) : [];
      const reviewBoundMs = afterLatch().length > 0 ? sweepWallClockBoundMs : latchLeftMs;
      let detachedBoundMs = latchLeftMs;
      if (fromLatch && detachedAtFreshness > 0) {
        const sinceLatchMs = exitAtMs - fromLatch.latchAtMs;
        const live = await drainDetachedSweepActions({ boundMs: 0 });
        if (live.some((action) => action.ageMs < sinceLatchMs)) detachedBoundMs = sweepWallClockBoundMs;
      }
      const deadlineMs = exitAtMs + Math.max(reviewBoundMs, detachedBoundMs);
      const reviewLength = stepPrefix === "daemon.freshness_drain" ? measuredReviewLength() : undefined;
      // W1-T4053 — REVIEWS KEEP FLOWING THROUGH THE DRAIN. With the clock stopped, 42 drains in three days
      // held 327 minutes with no review admitted. A review-only clock runs BESIDE the drain, never inside it
      // (W1-T2744), and its stop awaits a pass already posting, exactly as the drain awaits a detached fix.
      // Only a detached action earns that clock: a drain for reviews alone admits nothing new.
      if (reviewLength) restartWindow = { deadlineMs, lengths: { review: reviewLength.ms, "fix-dispatch": reviewLength.fixMs }, held: restartWindow?.held ?? 0 };
      const drainReviewClock =
        detachedAtFreshness > 0 ? startInterphaseReviewClock(deps, pollIntervalMs, log, "drain", latchedAdmission()) : undefined;
      let abandoned: Awaited<ReturnType<typeof drainDetachedSweepActions>>;
      let abandonedReviews: number;
      let reviewPasses = 0;
      let reviewPassesHeld = 0;
      try {
        [abandoned, abandonedReviews] = await Promise.all([
          drainDetachedSweepActions({
            boundMs: detachedBoundMs,
            freshness: true,
            onWait: observation.watch,
            onRelease: (action, work) => {
              observation.release(work, action.phase);
              log("daemon.detached_action_released", {
                action_kind: action.actionKind, task_id: action.taskId,
                age_ms: action.ageMs, phase: action.phase, reason: action.reason,
              });
            },
          }),
          drainInFlightReviews({ boundMs: reviewBoundMs, onWait: observation.watch }),
        ]);
      } finally {
        const stopped = drainReviewClock ? await drainReviewClock.stop() : undefined;
        reviewPasses = stopped?.passes ?? 0;
        reviewPassesHeld = stopped?.held ?? 0;
      }
      if (drainReviewClock) {
        watch(inFlightReviewRunsNow());
        abandonedReviews = await drainInFlightReviews({ boundMs: Math.max(0, deadlineMs - daemonClock.now()), onWait: observation.watch });
      }
      for (const action of abandoned) {
        const release = await abandonDetachedSweepAction(action);
        log("daemon.detached_action_abandoned", {
          ...release,
          action_kind: action.actionKind,
          task_id: action.taskId,
          age_ms: action.ageMs,
          bound_ms: sweepWallClockBoundMs,
        });
      }
      const nowMs = daemonClock.now();
      log(`${stepPrefix}.completed`, {
        ...latchFields,
        waited_on: observation.snapshot(true),
        detached_sweep_actions: latchStarted ? latchStarted.detached : detachedAtFreshness,
        remaining_detached_sweep_actions: detachedSweepActionCount(),
        abandoned_detached_sweep_actions: abandoned.length,
        in_flight_reviews: latchStarted ? latchStarted.reviews.size : reviewsAtFreshness,
        abandoned_in_flight_reviews: abandonedReviews,
        review_passes: reviewPasses,
        duration_ms: Math.max(0, nowMs - drainStartedAtMs),
        ...(stepPrefix === "daemon.freshness_drain" ? {
          in_flight_reviews_at_exit: reviewsAtFreshness,
          exit_wait_ms: Math.max(0, nowMs - exitAtMs),
          exit_bound_ms: Math.max(reviewBoundMs, detachedBoundMs),
          review_passes_held: reviewPassesHeld,
          review_length_ms: reviewLength?.ms ?? null,
          review_length_source: reviewLength?.source,
          admissions_held_after_latch: restartWindow?.held ?? 0,
        } : {}),
        ...(fromLatch ? {
          admitted_after_latch: afterLatch().length,
          abandoned_admitted_after_latch: afterLatch().filter((review) => !settled.has(review)).length,
        } : {}),
      });
    }
    if (stepPrefix === "daemon.freshness_drain") {
      freshnessPhases.drain = (freshnessPhases.drain ?? 0) + Math.max(0, daemonClock.now() - exitAtMs);
    }
  };

  // One stale-exit path for both freshness boundaries. Both must preserve the same install, bounded pass, named
  // ledger and stale summary contract; duplicating that sequence would let them drift (W1-T2845).
  type FreshnessPass = "skipped_ran_since_latch" | "awaited_in_flight" | "ran";
  let preparedFreshnessExit: Promise<FreshnessPass> | undefined;
  const prepareFreshnessExit = async (
    freshness: Extract<DaemonFreshness, { stale: true }>,
    dispatchLatchAtMs?: number,
  ): Promise<FreshnessPass> => {
    // Install BEFORE the loop stops for restart, never after, so the relaunched process inherits deps
    // matching the new sha rather than the stale tree this process is still running (W1-T151).
    if (freshness.installNeeded) {
      deps.runInstall?.();
    }
    // A pass completed during the dispatch latch already reached the full sweep (W1-T8170/W1-T1272).
    // A running pass is still awaited within its bound; other freshness exits keep their pass.
    let preExitPass: FreshnessPass = "ran";
    const passStartedAtMs = daemonClock.now();
    if (backgroundSweep) {
      preExitPass = "awaited_in_flight";
      await backgroundSweep;
    } else if (dispatchLatchAtMs !== undefined && sweepLiveness.lastCompletedAtMs !== undefined &&
      sweepLiveness.lastCompletedAtMs > dispatchLatchAtMs) {
      preExitPass = "skipped_ran_since_latch";
    } else if (deps.sweep) {
      sweepRetriggerState.lastRunAtMs = daemonClock.now();
      await runGatedSweep(deps, pollIntervalMs, sweepBound, log, diskHeadroomLatch, headroomSampler, sweepLiveness, undefined, latchedAdmission);
    }
    if (preExitPass === "awaited_in_flight" || (preExitPass === "ran" && deps.sweep)) {
      freshnessPhases.pre_exit_pass = Math.max(0, daemonClock.now() - passStartedAtMs);
    }
    // W1-T5721: protect live fix workers; cadences and CI waits are re-derived after restart.
    // The caller stops its interphase clock before the final pass (W1-T2865).
    await drainBeforeRestart("daemon.freshness_drain", dispatchLatchAtMs);
    return preExitPass;
  };
  const stopForFreshness = async (
    freshness: Extract<DaemonFreshness, { stale: true }>, dispatchLatchAtMs?: number,
  ): Promise<DaemonSummary> => {
    const preExitPass = await (preparedFreshnessExit ?? prepareFreshnessExit(freshness, dispatchLatchAtMs));
    const detail =
      `origin/main advanced ${freshness.oldSha.slice(0, 7)}..${freshness.newSha.slice(0, 7)} ` +
      `past this process's boot sha`;
    log("daemon.freshness_exit", { children_left_running: [...children.values()].map((child) => child.runId),
      phases_ms: { ...freshnessPhases, ...(freshnessDecidedAtMs === undefined ? {} : {
        total: Math.max(0, daemonClock.now() - freshnessDecidedAtMs),
      }) } });
    log("daemon_selfrestart_for_freshness", { old_sha: freshness.oldSha, new_sha: freshness.newSha, pre_exit_pass: preExitPass });
    return summary("stale", detail);
  };

  // One per-task block-reasoning processor, shared by the single-task tick and the multi-lane batch, so how a solo
  // dispatch's result is judged cannot fork from how one lane's is judged. Extracted verbatim from the earlier loop
  // body. The plan value is a parameter, never closed over, because the binding is rebound every tick; and it
  // returns a disposition so a caller can finish every sibling's bookkeeping before parking the affected subtree.
  // Forensics: docs/forensics/daemon.md.
  const processDispatchResult = async (
    planForBatch: Plan,
    task: Task,
    result: RunResult,
    isMerged: MergedSet,
    report: typeof emitLog = log,
  ): Promise<
    | { kind: "merged" }
    | { kind: "continue" }
    | { kind: "genuine_blocker"; detail: string; dependents: string[] }
  > => {
    refreshResumableHandoff(task.id, report);
    if (result.verdict === "task_already_merged") {
      // This verdict is a positive merge observation by run-task, even though the run opened no PR.
      // Refresh before the next selection and retain a local hold if the daemon's projection lags.
      blockRetryStates.delete(task.id);
      let creditVisible = false;
      let refreshError: string | undefined;
      try {
        creditVisible = (deps.refreshMergedAsync ? await deps.refreshMergedAsync(planForBatch) : deps.refreshMerged(planForBatch))(task.id);
      } catch (error) {
        refreshError = String((error as Error)?.message ?? error);
        report("daemon.merge_credit_refresh_failed", { task: task.id, error: refreshError });
      }
      if (creditVisible) {
        pendingMergedCredit.delete(task.id);
        merged.push(task.id);
      } else {
        pendingMergedCredit.add(task.id);
      }
      // The refusal row was written by this exact worker run. A prior merge observation is
      // present only when the matching PR's merge is also in the live ledger; never invent lag.
      let rawRows: readonly string[] = [];
      let evidenceError: string | undefined;
      try {
        rawRows = deps.readLedgerLines?.() ?? [];
      } catch (error) {
        evidenceError = String((error as Error)?.message ?? error);
        report("daemon.merge_credit_evidence_failed", { task: task.id, error: evidenceError });
      }
      const rows = rawRows.flatMap((raw) => {
        try { return [JSON.parse(raw) as Record<string, unknown>]; }
        catch (error) {
          report("daemon.merge_credit_evidence_invalid", { task: task.id, error: String((error as Error)?.message ?? error) });
          return [];
        }
      });
      const refusal = rows.findLast((row) => row.step === "dispatch.refused_already_merged" &&
        row.run_id === result.runId && row.task_id === task.id);
      const prUrl = result.prUrl ?? (typeof refusal?.pr_url === "string" ? refusal.pr_url : undefined);
      const owner = prUrl !== undefined ? rows.findLast((row) => row.task_id === task.id && row.pr_url === prUrl &&
        row.step === "pr.opened") : undefined;
      const merge = owner && rows.findLast((row) => row.step === "pr.merged" && row.run_id === owner.run_id);
      const refusedAt = typeof refusal?.ts === "string" ? Date.parse(refusal.ts) : NaN;
      const mergedAt = typeof merge?.ts === "string" ? Date.parse(merge.ts) : NaN;
      report("daemon.merge_credit_correction", {
        task: task.id,
        run_id: result.runId,
        pr_url: prUrl ?? null,
        merge_observation_lag_ms: Number.isFinite(refusedAt) && Number.isFinite(mergedAt) && refusedAt >= mergedAt
          ? refusedAt - mergedAt : null,
        credit_visible: creditVisible,
        ...(refreshError ? { refresh_error: refreshError } : {}),
        ...(evidenceError ? { evidence_error: evidenceError } : {}),
      });
      return { kind: creditVisible ? "merged" : "continue" };
    }
    // The verdict describes how THIS RUN ended, not whether the pull request is merged: a PR that
    // merges gate-side after the run stopped leaves the result unmerged even though the task is done.
    // The tick's already-resolved merged projection — never a second lookup — answers the question
    // block reasoning is actually trying to ask (W1-T976).
    if (!result.merged && isMerged(task.id)) {
      merged.push(task.id);
      return { kind: "merged" };
    }
    if (!result.merged) {
      // W1-T3979: live ownership is a scheduling deferral even when the task has dependents.
      if (result.verdict === "blocked_inflight") {
        // A scheduling deferral must not replenish previously spent failure attempts.
        report("daemon.block.inflight_contention", {
          task: task.id,
          verdict: result.verdict,
          run_id: result.runId,
        });
        return { kind: "continue" };
      }
      // Block reasoning: reuse the transient/strike taxonomy and the plan's DAG instead of halting on any
      // non-merged verdict (W1-T46, superseding blunt stop-on-block).
      const state = blockRetryStates.get(task.id) ?? INITIAL_RETRY_STATE;
      const disposition = reasonAboutBlock(planForBatch, task.id, result.verdict, state);
      if (disposition.kind === "already_merged") {
        throw new Error("task_already_merged must take the merge-credit correction path");
      }

      if (disposition.kind === "awaiting_merge") {
        blockRetryStates.delete(task.id);
        report("daemon.block.awaiting_merge", {
          task: task.id,
          verdict: result.verdict,
          pr_url: result.prUrl,
        });
        return { kind: "continue" };
      }
      if (disposition.kind === "retry_transient") {
        // Transient: no strike. Selection naturally retries the same task next tick, since it is still
        // unmerged and its deps are unchanged, so no separate re-dispatch mechanism is needed.
        blockRetryStates.set(task.id, disposition.state);
        report("daemon.block.transient_retry", {
          task: task.id,
          verdict: result.verdict,
          transient_retries: disposition.state.transientRetries,
        });
        return { kind: "continue" };
      }
      if (disposition.kind === "fixable_blocker" && deps.dispatchFix) {
        // Drain and reconciler parity: the same evidence the reconciler routes to the fix rung gets a
        // bounded fix attempt here too, before halting. Strike-capped by the same primitive every strike in
        // this module uses, never a separate unbounded loop — exhausting the bound falls through to a
        // genuine blocker on a later tick rather than fix-looping forever (W1-T174, W1-T168).
        blockRetryStates.set(task.id, disposition.state);
        report("daemon.block.fixable_dispatch", {
          task: task.id,
          verdict: result.verdict,
          dependents: disposition.dependents,
          strikes: disposition.state.strikes,
        });
        await deps.dispatchFix({ task, result, dependents: disposition.dependents });
        return { kind: "continue" };
      }

      blockRetryStates.delete(task.id); // resolved one way or another below

      if (disposition.kind === "independent_failure") {
        if (result.verdict === "blocked_illformed") {
          illformedAdmissionBlocksThisRun.set(task.id, JSON.stringify(task));
          report("daemon.block.illformed_admission", {
            task: task.id,
            verdict: result.verdict,
            run_id: result.runId,
          });
          return { kind: "continue" };
        }
        // Independent failure: nothing in the plan transitively depends on this task, so skipping it cannot
        // leave a dependent building on a gap. Record the block in the ledger, so a plan reload or daemon
        // restart derives the same skip instead of trusting this tick's Task object.
        const refusal = result as HarnessCommitRefusalResult;
        const harnessCommitRefused = refusal.harnessCommitRefused === true && result.verdict === "no_pr";
        const environmental = !harnessCommitRefused && isEnvironmentalBlock(result.verdict, undefined);
        if (environmental) environmentalBlocksThisRun.set(task.id, daemonClock.now());
        else if (!harnessCommitRefused) independentFailureBlocksThisRun.add(task.id);
        report("dispatch.blocked_independent", {
          task_id: task.id,
          task: task.id,
          verdict: result.verdict,
          pr_url: result.prUrl,
          run_id: result.runId,
          ...(environmental ? { environmental: true } : {}),
          ...(harnessCommitRefused
            ? {
                harness_commit_refused: true,
                terminal_class: "harness_commit_refused",
                reason: refusal.harnessCommitRefusalReason,
              }
            : {}),
        });
        if (harnessCommitRefused) {
          report("dispatch.harness_commit_retry", {
            task_id: task.id,
            task: task.id,
            original_run_id: result.runId,
            original_verdict: result.verdict,
            original_refusal: "harness_commit_refused",
            harness_commit_refused: true,
          });
        }
        report("daemon.block.independent_failure", {
          task: task.id,
          verdict: result.verdict,
          pr_url: result.prUrl,
        });
        return { kind: "continue" };
      }

      // Genuine blocker: real downstream work transitively needs this task merged, so "never continue into
      // the gap" is absolute. Escalate once, then let the caller park this task while its unmerged state
      // continues to dependency-gate every descendant. Reached by a genuine blocker, by a fixable one whose
      // strike bound is exhausted, and by a fixable one with no fix rung wired (W1-T174, W1-T3122).
      report("daemon.blocked", {
        task: task.id,
        verdict: result.verdict,
        pr_url: result.prUrl,
        dependents: disposition.dependents,
      });
      if (deps.escalateBlock) {
        await deps.escalateBlock({ task, result, dependents: disposition.dependents });
      }
      return {
        kind: "genuine_blocker",
        detail: `${task.id} → ${result.verdict}${result.prUrl ? ` (${result.prUrl})` : ""} — blocks ${disposition.dependents.join(", ")}`,
        dependents: disposition.dependents,
      };
    }
    merged.push(task.id);
    return { kind: "merged" };
  };

  let activeRetroCrossingKey: string | undefined;

  const holdWorkerAdmission = (surface: string): (FleetControlHold & { reason: string }) | undefined => {
    const hold = deps.workerAdmissionHold?.();
    if (!hold) return undefined;
    const reason = `fleet ${hold.control} hold: ${hold.detail}`;
    log("daemon.admission_held", { surface, control: hold.control, detail: hold.detail, reason });
    return { ...hold, reason };
  };

  // W1-T5344: is this task inside its delivery-failure park? A revised shard (a new pre-dispatch
  // contract revision) clears the park — the operator's fix is the one thing worth retrying at once.
  // A merge needs no arm here: the already-merged filter runs before this hold is ever consulted.
  const laneDeliveryParked = (taskId: string): boolean => {
    const park = laneDeliveryParks.get(taskId);
    if (park === undefined) return false;
    const current = plan.byId.get(taskId);
    if (current !== undefined && park.revision !== undefined && preDispatchContractRevision(current) !== park.revision) {
      laneDeliveryParks.delete(taskId);
      log("daemon.lane_park_cleared", { task: taskId, reason: "shard revised", consecutive: park.consecutive });
      return false;
    }
    return daemonClock.now() < park.parkedUntilMs;
  };

  // Shared by the top of tick and a lane refill (W1-T4416).
  const reloadPlanBinding = async (): Promise<void> => {
    if (!deps.reloadPlan) return;
    try {
      // W1-T7743: awaited, so the production reloader's git runs off the loop; a sync fake resolves at once.
      const fresh = await deps.reloadPlan();
      if (fresh) {
        plan = fresh;
        forgetPassedOver(fresh);
        deps.onPlanReload?.(fresh);
        log("daemon.plan_reloaded", { tasks: fresh.tasks.length });
      }
    } catch (e) {
      log("daemon.plan_reload_failed", { reason: e instanceof Error ? e.message : String(e) });
    }
  };

  let repositoryMaintenancePending = false;
  const repositoryMaintenanceTick = (): void => {
    if (!deps.repositoryMaintenance || repositoryMaintenancePending) return;
    repositoryMaintenancePending = true;
    // Give admission its turn before even the count-objects survey starts.
    const work = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      if (repositoryMaintenanceStopped) return;
      return deps.repositoryMaintenance!({ queueBusy: repositoryMaintenanceQueueBusy,
        activeLanes: inFlightReviewCount() + detachedSweepActionCount() + repositoryMaintenanceLaneCount() +
          (backgroundSweep !== undefined || sweepLiveness.inFlight ? 1 : 0),
        disk: "unknown",
      });
    }).catch((error) => {
      log("repository_maintenance.fail", { reason: String(error), outcome: "fail" });
    }).finally(() => { repositoryMaintenancePending = false; });
    void work;
  };
  const scheduleRepositoryMaintenance = (queueBusy: boolean, lanes = () => 0): void => {
    repositoryMaintenanceQueueBusy = queueBusy;
    repositoryMaintenanceLaneCount = lanes;
    if (!deps.repositoryMaintenance || repositoryMaintenanceTimer) return;
    repositoryMaintenanceTick();
    repositoryMaintenanceTimer = setInterval(repositoryMaintenanceTick, pollIntervalMs);
  };

  // W1-T7690: an independent timer prevents due rungs waiting behind dispatch (18+ minutes observed 2026-10-10).
  // The outer call order stays intact; timer and cycle share one single-flight slot per rung.
  let ledgerCompactionDecision: LedgerCompactionDecision | undefined;
  type RungSteps<R> = Generator<unknown, R, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Yielded promises preserve outer-cycle await timing; the independent timer drives the same steps. */
  const driveRungSteps = async <R>(steps: RungSteps<R>): Promise<R> => {
    let value: unknown;
    let error: unknown;
    let threw = false;
    for (;;) {
      const step = threw ? steps.throw(error) : steps.next(value);
      if (step.done) return step.value;
      try {
        value = await step.value;
        threw = false;
      } catch (e) {
        log("daemon.due_rungs.step_rejected", { error: String((e as Error)?.message ?? e) });
        error = e;
        threw = true;
      }
    }
  };
  /** One rung's single-flight slot. `begin` is the outer cycle's claim; `start` is the timer's. */
  const rungFlight = <R>(rungSteps: () => RungSteps<R>, idle: R) => {
    let current: Promise<R> | undefined;
    const steps = (): RungSteps<R> => (gatedCadenceRuns++, rungSteps());
    return {
      steps,
      joined: (): Promise<R> | undefined => current,
      begin: (): ((result?: R) => void) => {
        let done!: (result: R) => void;
        const slot = new Promise<R>((resolve) => { done = resolve; });
        current = slot;
        return (result = idle) => { if (current === slot) current = undefined; done(result); };
      },
      start: (): Promise<R> => {
        if (current) return current;
        const run = driveRungSteps(steps());
        current = run;
        const clear = (): void => { if (current === run) current = undefined; };
        run.then(clear, clear);
        return run;
      },
    };
  };
  const readOnlyRungs = rungFlight(function* (): RungSteps<void> {
    // Measurement is once-per-iteration, policy-bounded, and best-effort; it never gates dispatch (W1-T1259).
    if (deps.checkMeasurementCadence) {
      let decision: MeasurementCadenceDecision | undefined;
      try {
        decision = deps.checkMeasurementCadence();
      } catch (e) {
        log("measurement_cadence.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      const cadenceChild = deps.measurementCadenceChild;
      if (cadenceChild && !detachedActionInFlight("measurement-cadence") && (decision?.fire || cadenceChild.pending())) {
        startMeasurementCadenceChild(cadenceChild, decision?.fire === true, decision?.reason, log);
      } else if (decision?.fire) {
        // W1-T4034: detach this best-effort result so review admission keeps running; an 8m38s leg
        // once stalled a 21.5m iteration. Match the guarded `ci-learning` pattern below.
        if ((deps.runMeasurementCadence || cadenceChild) && detachedActionInFlight("measurement-cadence")) {
          log("measurement_cadence.already_detached", {
            reason: decision.reason,
            refusal: "measurement-cadence action already in flight",
            flow: "the cadence runs detached so the sweep keeps its turn",
          });
        } else {
          log("measurement_cadence.fired", { reason: decision.reason });
          if (deps.runMeasurementCadence) {
            try {
              const work = deps.runMeasurementCadence();
              detachSweepAction(
                work
                  .then((result) => {
                    // Derive the row from result keys; hand-enumeration dropped three fields (W1-T2502).
                    log("measurement_cadence.ran", buildMeasurementCadenceRow(result));
                  })
                  .catch((e) => {
                    log("measurement_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
                  }),
                { actionKind: "measurement-cadence", taskId: "DAEMON" },
              );
              log("measurement_cadence.detached", {
                reason: decision.reason,
                flow: "the cadence runs detached so the sweep keeps its turn",
              });
            } catch (e) {
              // A SYNCHRONOUS throw from the hook itself, before any promise exists to detach.
              log("measurement_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
            }
          }
        }
      } else if (decision) {
        log("measurement_cadence.skipped", { reason: decision.reason });
      }
    }

    // Digest cadence has its own policy row and marker (W1-T2277).
    if (deps.checkDigestCadence) {
      let digestDecision: MeasurementCadenceDecision | undefined;
      try {
        digestDecision = deps.checkDigestCadence();
      } catch (e) {
        log("digest_cadence.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (digestDecision?.fire) {
        log("digest_cadence.fired", { reason: digestDecision.reason });
        if (deps.runDigestCadence) {
          try {
            const result = (yield deps.runDigestCadence()) as Awaited<ReturnType<NonNullable<typeof deps.runDigestCadence>>>;
            log("digest_cadence.ran", { channel: result.channelName, delivered: result.delivered });
          } catch (e) {
            log("digest_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      } else if (digestDecision) {
        log("digest_cadence.skipped", { reason: digestDecision.reason });
      }
    }

    // W1-T3368: bounded, best-effort corpus-pressure repair; sizing is in `ledger-compaction-rung.ts`.
    // Preserve the reason from the firing decision; never re-derive it here.
    ledgerCompactionDecision = undefined;
    if (deps.checkLedgerCompaction) {
      try {
        ledgerCompactionDecision = deps.checkLedgerCompaction();
      } catch (e) {
        log("ledger_compaction.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (ledgerCompactionDecision?.fire) {
        log("ledger_compaction.fired", { reason: ledgerCompactionDecision.reason });
        if (deps.runLedgerCompaction) {
          try {
            const outcome = (yield deps.runLedgerCompaction()) as Awaited<ReturnType<NonNullable<typeof deps.runLedgerCompaction>>>;
            if (outcome === undefined) {
              // No eligible archive is a result, not a failure; keep it distinct from a broken run.
              log("ledger_compaction.nothing_eligible", { reason: ledgerCompactionDecision.reason });
            } else {
              log("ledger_compaction.ran", {
                reason: ledgerCompactionDecision.reason,
                source_count: outcome.sourceCount,
                rows_written: outcome.rowsWritten,
                duplicates_collapsed: outcome.duplicatesCollapsed,
                archive_name: outcome.archiveName,
              });
            }
          } catch (e) {
            log("ledger_compaction.run_failed", {
              reason: ledgerCompactionDecision.reason,
              error: String((e as Error)?.message ?? e),
            });
          }
        }
      } else if (ledgerCompactionDecision) {
        log("ledger_compaction.skipped", { reason: ledgerCompactionDecision.reason });
      }
    }

    if (deps.checkBenchmarkCohort) {
      let due = false;
      try { due = deps.checkBenchmarkCohort(); }
      catch (e) { log("benchmark_cohort.check_failed", { error: String((e as Error)?.message ?? e) }); }
      if (due && deps.runBenchmarkCohortPass) {
        if (detachedActionInFlight("benchmark-cohort")) {
          log("benchmark_cohort.already_detached");
        } else {
          try {
            const work = deps.runBenchmarkCohortPass();
            detachSweepAction(work.then((result) => {
              log("benchmark_cohort.ran", {
                state: result.state,
                scanned_sources: result.scannedSources,
                pending_sources: result.pendingSources,
                tail_pending_bytes: result.tailPendingBytes ?? 0,
                reason: result.snapshot.reason,
                source_bytes: result.snapshot.pressure.sourceBytes,
                checkpoint_bytes: result.checkpointBytes,
                dimension_cardinality: result.snapshot.pressure.dimensionCardinality,
                rebuilt_partitions: result.snapshot.pressure.rebuiltPartitions,
              });
            }).catch((e) => {
              log("benchmark_cohort.run_failed", { error: String((e as Error)?.message ?? e) });
            }), { actionKind: "benchmark-cohort", taskId: "DAEMON" });
            log("benchmark_cohort.detached");
          } catch (e) {
            log("benchmark_cohort.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      }
    }

    // W1-T3997: detached CI learning cannot block reconciliation; its registry bounds abandonment.
    if (deps.checkCiLearningCadence) {
      let ciLearningDecision: MeasurementCadenceDecision | undefined;
      try {
        ciLearningDecision = deps.checkCiLearningCadence();
      } catch (e) {
        log("ci_learning_cadence.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (ciLearningDecision?.fire) {
        if (deps.runCiLearningCadence && detachedActionInFlight("ci-learning")) {
          log("ci_learning_cadence.already_detached", {
            reason: ciLearningDecision.reason,
            refusal: "ci-learning action already in flight",
          });
        } else {
          log("ci_learning_cadence.fired", { reason: ciLearningDecision.reason });
          if (deps.runCiLearningCadence) {
            const reason = ciLearningDecision.reason;
            try {
              const work = deps.runCiLearningCadence();
              detachSweepAction(
                work
                  .then((result) => {
                    // The UNREADABLE count rides the row: a partial window must never read as a clean one (P48).
                    log("ci_learning_cadence.ran", {
                      status: result.status,
                      window_complete: result.windowComplete ?? true,
                      unreadable_prs: result.unreadablePrCount ?? 0,
                      drafts: result.draftCount,
                      excluded: result.excludedCount,
                      unreadable: result.unreadableCount,
                      filed: result.filedCount,
                      skipped: result.skippedCount,
                      refused: result.refusedCount,
                      lesson_recurrences: result.lessonRecurrences,
                    });
                  })
                  .catch((e) => {
                    log("ci_learning_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
                  }),
                { actionKind: "ci-learning", taskId: "DAEMON" },
              );
              log("ci_learning_cadence.detached", { reason });
            } catch (e) {
              // Preserve best-effort behavior if an injected runner throws before returning a promise.
              log("ci_learning_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
            }
          }
        }
      } else if (ciLearningDecision) {
        log("ci_learning_cadence.skipped", { reason: ciLearningDecision.reason });
      }
    }

    // Board review has its own policy row/marker; log fires and skips because board-review.ts has no log hook
    // (W1-T2304). Retired IDs accompany either outcome (W1-T2464); see docs/forensics/daemon.md.
    if (deps.checkBoardReview) {
      let boardDecision: (BoardReviewCadenceDecision & { retiredProposalIds?: string[] }) | undefined;
      try {
        yield deps.prefetchBoardReview?.();
        boardDecision = deps.checkBoardReview();
      } catch (e) {
        log("board_review.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (boardDecision?.fire) {
        log("board_review.fired", { reason: boardDecision.reason, retiredProposalIds: boardDecision.retiredProposalIds ?? [] });
        if (deps.runBoardReview) {
          try {
            const report = (yield deps.runBoardReview()) as Awaited<ReturnType<NonNullable<typeof deps.runBoardReview>>>;
            log("board_review.ran", {
              oldestOpenAgeHours: report.oldestOpenAgeHours,
              redCount: report.redCount,
              unhandledEscalationCount: report.unhandledEscalationCount,
              itemsConsidered: report.itemsConsidered,
              proposals: report.proposalIds.length,
              proposalIds: report.proposalIds,
              retired: (boardDecision.retiredProposalIds ?? []).length,
              retiredProposalIds: boardDecision.retiredProposalIds ?? [],
            });
          } catch (e) {
            log("board_review.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      } else if (boardDecision) {
        log("board_review.skipped", { reason: boardDecision.reason, retiredProposalIds: boardDecision.retiredProposalIds ?? [] });
      }
    }
  }, undefined);
  /** Resolves true when a fleet-control hold says the tick must not go on (the old `continue`). */
  const intakeRungs = rungFlight(function* (): RungSteps<boolean> {
    // Intake rungs can poll, write, draft, or dispatch; gate them behind tick-wide spending governors.
    // Best-effort failures cost one ledger row, then the tick continues.
    if (deps.checkIntakeRungs) {
      let decisions: readonly IntakeRungDecision[] | undefined;
      try {
        decisions = deps.checkIntakeRungs();
      } catch (e) {
        log("intake_cadence.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      for (const decision of decisions ?? []) {
        if (decision.fire) {
          const hold = holdWorkerAdmission("intake");
          if (hold) {
            log("intake_cadence.held", { rung: decision.rung, reason: hold.reason });
            return true;
          }
          log("intake_cadence.fired", { rung: decision.rung, reason: decision.reason });
          if (decision.rung === "codeqlQuality" && (deps.opportunityOutcomes || deps.knowledgeGardener)) {
            try {
              const outcomePorts = deps.opportunityOutcomes ?? ((yield openOpportunityOutcomePorts({ ...deps.knowledgeGardener!, prState: undefined })) as Awaited<ReturnType<typeof openOpportunityOutcomePorts>>);
              const outcomes = (yield reconcileOpportunityOutcomesAsync(outcomePorts)) as Awaited<ReturnType<typeof reconcileOpportunityOutcomesAsync>>;
              log("opportunity_outcomes.reconciled", { outcomes });
            } catch (error) {
              log("opportunity_outcomes.failed", { reason: String(error) });
            }
          }
          if (decision.rung === "codeqlQuality" && (deps.opportunityIntake || deps.knowledgeGardener)) {
            try {
              const intakePorts = deps.opportunityIntake ?? ((yield openOpportunityIntakePorts({ ...deps.knowledgeGardener!, prState: undefined })) as Awaited<ReturnType<typeof openOpportunityIntakePorts>>);
              const result = (yield runOpportunityIntake(intakePorts)) as Awaited<ReturnType<typeof runOpportunityIntake>>;
              log("opportunity_intake.ran", { ...result, rung: decision.rung });
            } catch (error) {
              log("opportunity_intake.failed", { reason: String(error) });
            }
          } else if (deps.runIntakeRung) {
            try {
              log("intake_cadence.ran", (yield deps.runIntakeRung(decision)) as Awaited<ReturnType<NonNullable<typeof deps.runIntakeRung>>>);
            } catch (e) {
              log("intake_cadence.run_failed", { rung: decision.rung, error: String((e as Error)?.message ?? e) });
            }
          }
        } else {
          log("intake_cadence.skipped", { rung: decision.rung, reason: decision.reason });
        }
      }
    }
    return false;
  }, false);
  const wipeTestRung = rungFlight(function* (): RungSteps<boolean> {
    // Wipe-test is policy-gated and spends like retro/auto-triage; its own marker prevents sibling throttling.
    // The pair core records measurements; this rung records fired/skipped/refused clock evidence (W1-T2659).
    if (deps.checkWipeTestCadence) {
      let decision: WipeTestCadenceDecision | undefined;
      try {
        decision = deps.checkWipeTestCadence();
      } catch (e) {
        log("wipetest.cadence.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (decision?.fire) {
        const hold = holdWorkerAdmission("wipe-test");
        if (hold) {
          log("wipetest.cadence.held", { reason: hold.reason, seq: decision.seq, subject: decision.subject.id, ...wipeTestCadenceEvidenceFields(decision) });
          return true;
        }
        log("wipetest.cadence.fired", {
          reason: decision.reason,
          seq: decision.seq,
          subject: decision.subject.id,
          selected_shards: decision.subject.selectedShards ?? [],
          factor: decision.factor,
          ...wipeTestCadenceEvidenceFields(decision),
        });
        if (deps.runWipeTestCadence) {
          try {
            const result = (yield deps.runWipeTestCadence(decision)) as Awaited<ReturnType<NonNullable<typeof deps.runWipeTestCadence>>>;
            if (result.status === "refused") {
              log("wipetest.cadence.refused", {
                reason: result.reason ?? "wipe-test cadence refused",
                seq: result.seq,
                subject: result.subject.id,
                factor: result.factor,
              });
            }
          } catch (e) {
            log("wipetest.cadence.refused", {
              reason: String((e as Error)?.message ?? e),
              seq: decision.seq,
              subject: decision.subject.id,
              factor: decision.factor,
            });
          }
        }
      } else if (decision) {
        // The evidence read's cost rides on the row, so the fleet can see a repeat check read only what is new.
        log("wipetest.cadence.skipped", { reason: decision.reason, ...wipeTestCadenceEvidenceFields(decision) });
      }
    }
    return false;
  }, false);
  /** W1-T9321 — a tick-top cadence's single-flight slot, and the run a gated tick OWES it. A tick that skips the
   *  cadence behind the boot gate records the debt (with the arguments that tick would have passed); the due timer,
   *  which starts once the gate is open and the boot review has settled, pays it once beside the still-running tick.
   *  Any run, from either path, settles the debt, so a cadence still runs at most once per tick, as at an iteration
   *  top: the debt exists only because a boot's tick 1 can outlive its process, and tick 2 then never comes. */
  const cadenceFlight = <A extends unknown[], R>(body: (...args: A) => Promise<R>) => {
    let current: Promise<R> | undefined;
    let debt: A | undefined;
    return {
      owe: (...args: A): void => { debt = args; },
      owed: (): A | undefined => debt,
      run: (...args: A): Promise<R> => {
        if (current) return current;
        debt = undefined;
        gatedCadenceRuns++;
        const run = body(...args);
        current = run;
        const clear = (): void => { if (current === run) current = undefined; };
        run.then(clear, clear);
        return run;
      },
    };
  };
  const tickSweepsWired = deps.sweepOrphans !== undefined || deps.sweepFeedbackLanding !== undefined || deps.checkGithubPosture !== undefined;
  const tickSweeps = cadenceFlight(async (): Promise<void> => {
    // Orphan sweep, on the same once-per-iteration cadence as the reconciler above; boot already runs it
    // once. Best-effort: a process-listing hiccup costs one logged tick (W1-T117 part ii).
    if (deps.sweepOrphans) {
      try {
        const report = await deps.sweepOrphans();
        log("daemon.orphan_sweep", { killed: report.killed.length, left_alone: report.leftAlone.length });
      } catch (e) {
        log("daemon.orphan_sweep.failed", { error: String((e as Error)?.message ?? e) });
      }
    }

    // Feedback-landing sweep, on the same once-per-iteration cadence; boot already runs it once. This is
    // the per-poll half, so an entry captured or failed to land BETWEEN polls is still found within one
    // cycle. Best-effort (W1-T530 part ii).
    if (deps.sweepFeedbackLanding) {
      try {
        const result = await deps.sweepFeedbackLanding();
        log("daemon.feedback_landing_sweep", {
          landed: result.landed,
          pushed: result.pushed ?? false,
          file_count: result.files.length,
        });
      } catch (e) {
        log("daemon.feedback_landing_sweep.failed", { error: String((e as Error)?.message ?? e) });
      }
    }

    // GitHub-side posture drift check, on the same once-per-iteration cadence. The hook throttles the actual read to
    // at most once a day, so most ticks cost nothing. A non-empty return is LEDGERED — never gated, never a continue,
    // never consulted by any governor — so a posture finding can never halt a dispatch or fail a check (W1-T1040).
    if (deps.checkGithubPosture) {
      try {
        const findings = await deps.checkGithubPosture();
        for (const finding of findings) {
          log("github_posture.finding", { capability: finding.capability, kind: finding.kind, cost: finding.cost });
        }
      } catch (e) {
        log("github_posture.check_failed", { error: String((e as Error)?.message ?? e) });
      }
    }
  });
  const retroCompanions = deps.checkRetroTrigger as (RetroCheckCompanions & object) | undefined;
  const retroGate: RetroCheckCompanions = {
    projectRetroReadCost: deps.projectRetroReadCost ?? retroCompanions?.projectRetroReadCost,
    readRetroHistory: deps.readRetroHistory ?? retroCompanions?.readRetroHistory,
  };
  let retroDeferral: RetroDeferralEpisode | undefined;
  /** W1-T9119: a deferral that outlasts the retro's own learned interval says so, once per episode. */
  const noteRetroDeferral = async (reasonClass: string, reason: string): Promise<void> => {
    const nowMs = daemonClock.now();
    const prior = retroDeferral?.reasonClass === reasonClass ? retroDeferral : undefined;
    const episode: RetroDeferralEpisode = prior ?? { reasonClass, firstAtMs: nowMs, lastAtMs: nowMs, observations: 0, gapsMs: [], named: false };
    if (prior) episode.gapsMs.push(nowMs - episode.lastAtMs);
    episode.lastAtMs = nowMs;
    episode.observations++;
    retroDeferral = episode;
    if (episode.named || !retroGate.readRetroHistory || episode.gapsMs.length === 0) return;
    try {
      const history = await retroGate.readRetroHistory();
      const at = [...history.retroTriggeredAtMs].sort((a, b) => a - b).slice(-(RETRO_INTERVAL_SAMPLE + 1));
      const retroGaps = at.slice(1).map((ms, i) => ms - at[i]!);
      const expectedMs = at.length >= 2 ? medianOf(retroGaps)! : history.fallbackIntervalMs;
      const observationGapMs = medianOf([...episode.gapsMs]) ?? 0;
      const needed = observationGapMs > 0 ? Math.ceil(expectedMs / observationGapMs) : Number.POSITIVE_INFINITY;
      if (episode.named || nowMs - episode.firstAtMs <= expectedMs || episode.observations < needed) return;
      episode.named = true;
      log("daemon.retro_trigger.deferral_persisting", {
        reason,
        reason_class: reasonClass,
        first_deferred_at: fixedClock(episode.firstAtMs).iso(),
        observations: episode.observations,
        expected_interval_ms: expectedMs,
        last_retro_at: at.length > 0 ? fixedClock(at[at.length - 1]!).iso() : null,
      });
    } catch (e) {
      log("daemon.retro_trigger.deferral_persisting_unread", { error: String((e as Error)?.message ?? e) });
    }
  };
  /** W1-T9119: the check's own read cost against the heap's measured headroom; a deferral's reason, else undefined.
   *  A projection that cannot be made is ledgered and does not defer: the check then reads as it always did. */
  const retroReadDeferral = async (): Promise<{ reason: string; fields: Record<string, number> } | undefined> => {
    if (!retroGate.projectRetroReadCost) return undefined;
    let projection: RetroReadProjection;
    try {
      projection = await retroGate.projectRetroReadCost();
    } catch (e) {
      log("daemon.retro_trigger.projection_failed", { error: String((e as Error)?.message ?? e) });
      return undefined;
    }
    const heap = deps.heapStatistics?.() ?? v8HeapStatistics();
    const headroom = Math.max(0, heap.heap_size_limit - heap.used_heap_size);
    if (projection.projectedBytes <= headroom) return undefined;
    return {
      reason: `retro read projects ${Math.round(projection.projectedBytes / 1e6)} MB decompressed (${projection.undigested} of ${projection.rotations} rotation(s) hold no digest) against ${Math.round(headroom / 1e6)} MB heap headroom`,
      fields: {
        projected_bytes: projection.projectedBytes, heap_headroom_bytes: headroom, heap_used_bytes: heap.used_heap_size,
        heap_limit_bytes: heap.heap_size_limit, rotations: projection.rotations, undigested_rotations: projection.undigested,
      },
    };
  };
  /** Resolves true when a fleet-control hold says the tick must not go on (the old `continue`). */
  const retroCadence = cadenceFlight(async (): Promise<boolean> => {
    const deferral = await retroReadDeferral();
    if (deferral) {
      log("daemon.retro_trigger.deferred_ledger_pressure", { reason: deferral.reason, reason_class: "read_cost_over_heap_headroom", ...deferral.fields });
      await noteRetroDeferral("read_cost_over_heap_headroom", deferral.reason);
    } else {
      retroDeferral = undefined;
      let decision: RetroTriggerDecision | undefined;
      try {
        decision = await deps.checkRetroTrigger!();
      } catch (e) {
        log("daemon.retro_trigger.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      // W1-T2981 — the REFUSAL is decided BEFORE `retro_triggered` is written, so that row keeps
      // naming an actual fire. With the retro detached the loop keeps ticking while it runs, and the
      // trigger legitimately still reads `fire` on the next tick because the marker has not advanced
      // yet; logging first turned ONE retro into two `retro_triggered` rows and would have made every
      // later count of "how often did the retro fire" wrong by the number of ticks it spanned.
      if (decision === undefined || decision.fire === false) {
        activeRetroCrossingKey = undefined;
      } else if (decision.fire && deps.runRetroTrigger && detachedActionInFlight("retro")) {
        log("daemon.retro_trigger.already_detached", { reason: decision.reason });
      } else if (decision?.fire) {
        const hold = holdWorkerAdmission("retro");
        if (hold) {
          log("daemon.retro_trigger.held", { reason: hold.reason });
          return true;
        }
        const crossingKey = retroTriggerCrossingKey(decision);
        if (activeRetroCrossingKey === crossingKey) {
          log("daemon.retro_trigger.crossing_already_fired", { reason: decision.reason });
        } else {
          activeRetroCrossingKey = crossingKey;
          retroDeferral = undefined;
          log("retro_triggered", {
            reason: decision.reason,
            merges_since_marker: decision.mergesSinceMarker,
            // Infinity (the marker-absent case) is not JSON-representable — name it
            // explicitly rather than let JSON.stringify silently collapse it to null.
            days_since_marker: Number.isFinite(decision.daysSinceMarker) ? decision.daysSinceMarker : "unbounded",
          });
          if (deps.runRetroTrigger) {
            // DETACHED, NOT AWAITED (W1-T2981). This await was unbounded and sits ABOVE the dispatch
            // pick, so a fired retro held the whole tick: MEASURED 2026-09-06, the daemon logged
            // `retro_triggered` and then never wrote `daemon.idle` or any dispatch row again, while the
            // light sweep kept reviewing and merging — every liveness signal green, nothing built. With
            // the marker 3.7 days / 446 merges behind and RETRO_MAX_RUNS_PER_PASS at 40, ~11 such ticks.
            // A retro gates nothing: it SPENDS (hence its place below headroom) but no rung downstream
            // reads its result. It goes on the registry the sweep's fix dispatches use, which
            // `stopForFreshness` already drains, so a restart still lets a running retro finish.
            // NO `sweepLightDuringRetro` HERE, deliberately: it starts a second "retro" ticker while the
            // tick proceeds into dispatch, which starts its own — the overlap the clock handoff prevents.
            {
              detachSweepAction(
                sweepLightDuringRetro(
                  deps,
                  pollIntervalMs,
                  log,
                  () => deps.runRetroTrigger!(decision),
                  diskHeadroomLatch,
                  sweepRetrigger,
                ).catch((e) => {
                  log("daemon.retro_trigger.run_failed", { error: String((e as Error)?.message ?? e) });
                }),
                { actionKind: "retro", taskId: "DAEMON" },
              );
              log("daemon.retro_trigger.detached", { reason: decision.reason });
            }
          }
        }
      }
    }
    return false;
  });
  /** Resolves true when a fleet-control hold says the tick must not go on (the old `continue`). */
  const autoTriageCadence = cadenceFlight(async (signals: { deferralPending: boolean; dispatchCount: number; laneBudget: number }): Promise<boolean> => {
    let decision: AutoTriageDecision | undefined;
    try {
      decision = await deps.checkAutoTriage!(signals);
    } catch (e) {
      log("auto_triage.check_failed", { error: String((e as Error)?.message ?? e) });
    }
    if (decision?.fire) {
      // In-flight guard: the same shape as the task lane's pair above, keyed on feedback id. The decision
      // only knows the entry's own status and cannot see an already-open PR carrying this id's provenance,
      // so that read happens here, right before the fire it would otherwise duplicate (W1-T300).
      // #10265: that read is a once-per-boot snapshot, blind to a triage PR opened since; this boot's `pr.opened` row is not.
      const openPrNumber = deps.isFeedbackOpenPr?.(decision.feedbackId) ??
        triagePrOpenedInLedger(deps.readLedgerLines?.(), decision.feedbackId);
      let inFlight = openPrNumber !== undefined;
      let inFlightReason = "an open triage PR already carries this feedback id's provenance";
      if (inFlight && openPrNumber !== undefined) {
        // The confirming-read discipline, applied verbatim: a cached open can be stale, so a fresh read
        // stands the guard down rather than parking the entry forever on yesterday's snapshot (W1-T177).
        const liveState = deps.readFeedbackLiveState?.(decision.feedbackId, openPrNumber);
        // #10265: a MERGED triage already moved the entry on main; this checkout is just behind.
        const mainStatus = liveState === "MERGED" ? deps.readFeedbackStatusOnMain?.(decision.feedbackId) : undefined;
        if (mainStatus !== undefined && mainStatus !== "new") {
          inFlightReason = `its triage PR merged and origin/main holds the entry at status: ${mainStatus} — this checkout is behind`;
        } else if (liveState !== undefined && liveState !== "OPEN") {
          inFlight = false;
          log("auto_triage.stood_down", {
            feedback: decision.feedbackId,
            pr_number: openPrNumber,
            state: liveState,
            reason: "cached in-flight read was stale",
          });
        }
      }
      if (inFlight) {
        // A ledgered refusal naming the id and the open PR number: a silent skip here is indistinguishable
        // from the starvation this rung is about.
        log("auto_triage.skipped_inflight", {
          feedback: decision.feedbackId,
          pr_number: openPrNumber,
          reason: inFlightReason,
        });
      } else {
        const hold = holdWorkerAdmission("auto-triage");
        if (hold) {
          log("auto_triage.held", { feedback: decision.feedbackId, reason: hold.reason });
          return true;
        }
        if (deps.runAutoTriage) {
          const fired = decision;
          // W1-T2986 — DETACHED, exactly as W1-T2981 detached the retro beside it. This rung sits
          // between the dispatch-set computation and the idle branch and used to `await` an
          // unbounded run wrapped in a light-sweep ticker, so a fired triage held the whole tick
          // and dispatch was never reached — the shape that took the fleet down for two days, with
          // the ticker keeping every liveness signal green throughout. MEASURED across the ledger
          // union: 185 `auto_triage.fired` against 1241 `auto_triage.skipped`, so roughly one tick
          // in eight would have stalled on it once the retro stopped doing so first.
          //
          // Triage gates nothing: it spends, which is why it stays below the headroom rung, but no
          // rung downstream reads its result. It goes on the same registry the sweep's fix
          // dispatches and the retro use, which `stopForFreshness` drains, so a restart still lets
          // a running triage finish. A second concurrent triage is refused and the refusal named.
          if (detachedActionInFlight("auto-triage")) {
            log("auto_triage.already_detached", { feedback: fired.feedbackId, reason: fired.reason });
          } else {
            log("auto_triage.fired", { feedback: fired.feedbackId, reason: fired.reason });
            detachSweepAction(
              sweepLightDuringRetro(
                deps,
                pollIntervalMs,
                log,
                () => deps.runAutoTriage!(fired.feedbackId),
                diskHeadroomLatch,
                sweepRetrigger,
              ).catch((e) => {
                log("auto_triage.run_failed", {
                  feedback: fired.feedbackId,
                  error: String((e as Error)?.message ?? e),
                });
              }),
              { actionKind: "auto-triage", taskId: "DAEMON" },
            );
            log("auto_triage.detached", { feedback: fired.feedbackId });
          }
        } else {
          log("auto_triage.fired", { feedback: decision.feedbackId, reason: decision.reason });
        }
      }
    } else if (decision) {
      log("auto_triage.skipped", { reason: decision.reason });
    }
    return false;
  });
  // Timer starts spending rungs only after this cycle passes headroom, cost, and WIP governors.
  let spendGatesOpen = false;
  /** W1-T9321: the debts a gated tick left. The sweeps read nothing the rungs decide; the retro and auto-triage spend,
   *  so they wait for the spend gates, and the retro follows this firing's read-only rungs, whose compaction decision
   *  carries the ledger-pressure deferral it honours. */
  const payOwedCadences = (readOnly: Promise<unknown>): Promise<unknown>[] => {
    const paid: Promise<unknown>[] = [];
    if (tickSweeps.owed()) paid.push(tickSweeps.run());
    if (spendGatesOpen && retroCadence.owed()) {
      paid.push(readOnly.then(() => (spendGatesOpen && retroCadence.owed() ? retroCadence.run() : undefined)));
    }
    const triageDebt = autoTriageCadence.owed();
    if (spendGatesOpen && triageDebt) paid.push(autoTriageCadence.run(...triageDebt));
    return paid;
  };
  const dueRungsTick = (): void => {
    if (dueRungsStopped) return;
    const looks: Promise<unknown>[] = [readOnlyRungs.start()];
    if (spendGatesOpen) looks.push(intakeRungs.start(), wipeTestRung.start());
    looks.push(...payOwedCadences(looks[0]!));
    void Promise.all(looks).catch((e) => {
      log("daemon.due_rungs.failed", { error: String((e as Error)?.message ?? e) });
    });
  };
  const startDueRungsTimer = (): void => {
    if (dueRungsTimer || dueRungsStopped) return;
    dueRungsTimer = setInterval(dueRungsTick, Math.max(1, pollIntervalMs));
    dueRungsTimer.unref();
  };
  releaseGatedCadences = (): void => { if (gatedCadencesReleased()) startDueRungsTimer(); };

  const tickMemory = { sampled: false };
  for (;;) {
    // The liveness tick: the one row this loop writes unconditionally, every iteration, on every path below.
    // Every other daemon-prefixed step is either boot-time and one-shot, or confined to the three windows the
    // in-flight ticker runs in. Measured: the prefix went silent for 102.5 minutes on 2026-08-23 while the
    // daemon stayed alive, and the freshness judges read a false FAIL. Placed as literally the first statement
    // of the loop body so no branch below can skip it (W1-T1274). W1-T7126: it carries the memory sample when
    // no row has within one poll interval; a throwing sampler rides it as mem_telemetry, never escapes it.
    log("daemon.tick", { poll_interval_ms: pollIntervalMs, ...tickMemorySample(deps, daemonClock.now(), pollIntervalMs, tickMemory) });
    if (tickMemory.sampled) startMemoryReadAfterRow(deps, log);
    const tickStartedAtMs = daemonClock.now();
    resetIdleLaneTick();
    spendGatesOpen = false;

    if (opts.max !== undefined && attempted.length >= opts.max) {
      return summary("max_reached", `${opts.max} task(s)`);
    }

    // Fleet control: checked first, every tick, so a hard STOP wins any race against PAUSE and against
    // picking up the next task. Neither check can interrupt a task already running (W1-T11).
    const stopped = deps.checkStop?.();
    if (stopped) {
      log("daemon.stop", { detail: stopped });
      return summary("stopped", stopped);
    }

    // W1-T4390: the SRE governor, from a DIFFERENT loop than the lane it polices — so a wedged lane,
    // or one that skips its own check, is still paused. Before PAUSE, so a hold still stops the lane.
    if (sreGovernor) {
      try {
        const quiet = deps.checkQuietHours?.();
        const controls = { pause: deps.checkPause?.(), quietHours: quiet ? (quiet.detail ?? "quiet hours") : undefined };
        stepSreGovernor(sreGovernor, controls, log, daemonClock.now());
      } catch (e) {
        log("sre.governor.failed", { reason: String((e as Error)?.message ?? e) });
      }
    }

    // W1-T3335 — LEAVE BEFORE V8 THROWS YOU OUT. Measured 2026-09-10: this process reached
    // 8,188 MB and died on "Ineffective mark-compacts near heap limit" after 184-197 SECONDS,
    // 21 times, so a pass that needs longer than three minutes could never finish and the queue
    // moved only in whatever fragments fit between aborts. An abort is the worst possible exit:
    // in-flight work is lost, nothing is ledgered, and exit 134 is a crash, so the entrypoint
    // adds its 120s throttle on top — roughly 40% of every cycle spent asleep.
    //
    // THE THRESHOLD IS A FRACTION OF V8'S OWN REPORTED LIMIT, never a megabyte literal: the cap
    // is set by NODE_OPTIONS and would silently drift out of agreement with any number written
    // here. This is NOT a bound on how much the daemon may use — it is the point at which
    // restarting is cheaper than continuing, and it fires only between ticks, where there is
    // nothing to lose.
    //
    // IT DOES NOT FIX THE LEAK and must not be read as fixing it. The growth is still there and
    // still unexplained; this only stops it costing a crash and 120 seconds each time.
    //
    // 2026-10-10: the V8 fraction never fired (75% of 8.4 GB of one isolate, at 4.5 GB RSS + 3 GB swap).
    // The governor (daemon-memory-policy.ts) judges RSS+swap against the cgroup budget: tighten first,
    // restart only past the tightest factor. The V8 fraction stays as the backstop with no budget.
    const memoryStep = reclaimBeforeMemoryRestart(memoryGovernor.step(), memoryGovernor, log);
    if (memoryStep.futileRestart) log("daemon.memory_restart_futile", memoryStep.futileRestart);
    if (memoryStep.changed || memoryStep.initialReading) {
      log("daemon.memory_pressure", {
        initial_reading: memoryStep.initialReading,
        baseline: memoryStep.baseline,
        tier: memoryStep.tier,
        previous_tier: memoryStep.previousTier,
        share: memoryStep.share,
        heap_growing_percent: memoryStep.heapGrowingPercent,
        rss_bytes: memoryStep.reading.rss_bytes,
        swap_bytes: memoryStep.reading.swap_bytes,
        budget_bytes: memoryStep.reading.budget_bytes,
        budget_source: memoryStep.reading.budget_source,
      });
    }
    const heapStats = deps.heapStatistics?.() ?? v8HeapStatistics();
    const heapPressure = memoryStep.tier === "restart" ? memoryStep.detail : heapPressureDetail(heapStats);
    if (heapPressure !== undefined) {
      const memoryDecisionAtMs = daemonClock.now();
      log("daemon.heap_pressure_exit", {
        basis: memoryStep.tier === "restart" ? "cgroup_share" : "v8_limit",
        ...(memoryStep.tier === "restart" ? { baseline: memoryStep.baseline } : {}),
        used_heap_size: heapStats.used_heap_size,
        heap_size_limit: heapStats.heap_size_limit,
        threshold: HEAP_PRESSURE_RESTART_FRACTION,
        ...(memoryStep.tier === "restart" ? { share: memoryStep.share, budget_bytes: memoryStep.reading.budget_bytes } : {}),
        ticks,
      });
      // The same bounded drain a freshness restart takes: live fix workers and reviews finish first.
      const memoryDrainStartedAtMs = daemonClock.now();
      await drainBeforeRestart("daemon.memory_drain");
      const memoryExitAtMs = daemonClock.now();
      log("daemon.memory_exit", { phases_ms: { drain: Math.max(0, memoryExitAtMs - memoryDrainStartedAtMs),
        total: Math.max(0, memoryExitAtMs - memoryDecisionAtMs) } });
      return summary("heap_pressure", heapPressure);
    }

    // Plan freshness. The plan arrives as a parameter and was never reassigned, so a task filed after this boot began
    // was invisible to every dispatch decision for the boot's lifetime — measured, the median gap between a task
    // landing on origin/main and the daemon next booting is 106 minutes (impl-FZ). Position is the safety argument:
    // after the stop check, so a halted fleet does no I/O, and before any dispatch decision reads the plan. A throw
    // is caught and ledgered, never fatal. Forensics: docs/forensics/daemon.md.
    if (deps.reloadPlan) await reloadPlanBinding();
    // One snapshot per admission (W1-T340, W1-T4416; MASTER-PLAN §4B). The plan binding is mutable and reassigned by the
    // reload above, so code closing over the NAME reads whatever the most recent reload produced. That is invisible
    // at one lane and stops being invisible the moment a batch holds more than one: a lane's later reasoning would be
    // silently re-judged against a blob it never saw. Reassignment rebinds the name and never mutates the object, so
    // the fix is a value capture, bound once here. Forensics: docs/forensics/daemon.md.
    const planForBatch = plan;
    // Daily cost ceiling freshness, mirroring the plan reload above: same placement, same "a throw is caught and
    // ledgered, never fatal" contract. Unlike the plan reload, a failed read deliberately does not touch the snapshot
    // — leaving it at its last known-good value, rather than resetting it, is the correct degrade (W1-T331).
    if (deps.reloadDailyCostCeilingUsd) {
      try {
        dailyCostCeilingUsd = deps.reloadDailyCostCeilingUsd();
      } catch (e) {
        log("daemon.cost_ceiling_reload_failed", { reason: e instanceof Error ? e.message : String(e) });
      }
    }
    // PAUSE is checked before self-freshness, because a deliberate operator hold must win against a restart decision,
    // exactly as STOP does. Why: with PAUSE below the freshness exit, a paused daemon on a checkout that never
    // fast-forwards returned stale every tick and was relaunched into the same flag — the 2026-08-17 relaunch storm
    // (W1-T936). PAUSE is an in-process idle, never an exit. Forensics: docs/forensics/daemon.md.
    const paused = deps.checkPause?.();
    if (paused) {
      ticks++;
      log("daemon.pause", { tick: ticks, detail: paused, poll_interval_ms: pollIntervalMs });
      sampleIdleLane(0, false);
      // W1-T4685: the SAME observation, tracked as one row instead of one line per tick — see
      // `gateObservations`'s own comment above for why this sits BESIDE the line above it, not in
      // place of it.
      observeGate(
        gateObservations,
        { lane: "daemon", gate: "pause", condition: { detail: paused }, heartbeatMs: GATE_OBSERVATION_HEARTBEAT_MS, clock: daemonClock },
        log,
      );
      // W1-T5804: a recycle's own PAUSE holds only worker-spawning work. Dispatch stays withheld (this
      // branch `continue`s) and the full pass runs on its normal cadence with review and fix admission
      // closed by the PAUSE, so a reviewed green PR is still armed and merged while the recycle waits
      // on in-flight workers. Every other PAUSE reason keeps its full meaning: no pass at all.
      if (isRecyclePauseDetail(paused)) {
        log("daemon.admission_held", { surface: "dispatch", control: "PAUSE", detail: paused, reason: `fleet PAUSE hold: ${paused}` });
        if (deps.sweep && !backgroundSweep) {
          sweepRetriggerState.lastRunAtMs = daemonClock.now();
          sweepRetrigger.slot.adopt(
            runGatedSweep(deps, pollIntervalMs, sweepBound, log, diskHeadroomLatch, headroomSampler, sweepLiveness, true),
          );
        }
      }
      // W1-T4429 (ii): govern a structured hold's tier; (iii): reviews keep flowing beside the sleep.
      const pauseHold = deps.checkPauseHold?.();
      if (pauseHold) {
        const holdState = pauseHoldGovernorStates.get(pauseHold.holdId) ?? { lastTier: undefined };
        pauseHoldGovernorStates.set(pauseHold.holdId, holdState);
        await stepPauseHoldGovernor(pauseHold, holdState, deps, log);
      }
      const pauseReviewClock = (pauseReview.clock ??= startInterphaseReviewClock(deps, pollIntervalMs, log, "pause"));
      let slept: Awaited<ReturnType<typeof sleepUntilSweepWake>>;
      try {
        slept = await sleepUntilSweepWake(pollIntervalMs);
      } catch (e) {
        await stopPauseReviewClock();
        throw e;
      }
      // W1-T5803: `wake()` resolves only its FIRST waiter, often this sleep — hand the event to the clock.
      if (slept === "wake") pauseReviewClock.handWake();
      reportPauseReviewPasses(pauseReviewClock.passCount());
      continue;
    }
    // Guarded, never a bare await: an unpaused tick must not gain a microtask turn (W1-T343 lanes).
    if (pauseReview.clock) await stopPauseReviewClock();
    // Self-freshness, checked directly after both operator holds and before headroom and dispatch, so
    // origin/main advancing past this process's boot sha is noticed on the very next tick where the
    // daemon is neither stopped nor paused. Never interrupts in-flight work (W1-T126, W1-T936).
    const freshnessRead = checkFreshness?.();
    const freshness = isPendingFreshness(freshnessRead) ? await freshnessRead : freshnessRead;
    logNotStaleFreshness(freshness);
    if (freshness?.stale) {
      // FORWARD PROGRESS OUTRANKS FRESHNESS FOR THE FIRST CYCLE, AND ONLY THE FIRST (W1-T2965).
      // This exit sits ABOVE the sweep and dispatch, so W1-T2960's admission-gate deferral is
      // unreachable on a lifetime that reads stale here first. When the daemon's own merges advance
      // main faster than a container boots that is self-sustaining: 33 consecutive lifetimes ended
      // `idle ticks: 0` and the fleet dispatched nothing for two days, while the bounded sweep
      // `stopForFreshness` runs on its way out kept every liveness signal green. A process that
      // completes no cycle makes no progress however fresh the code it would restart onto is, so it
      // gets exactly one. Not a timer or backoff — those need sizing against a moving merge rate
      // (W1-T312, W1-T380, W1-T382). One-shot: the three-clocks guard (W1-T126) fires at the next
      // tick boundary, and the operator holds above still outrank it (W1-T936).
      if (cyclesEntered === 0) {
        observeFreshnessAdvance(freshness.newSha, daemonClock.now(), freshness.staleSinceMs);
        log("daemon.freshness_deferred", {
          old_sha: freshness.oldSha,
          new_sha: freshness.newSha,
          phase: "pre_cycle",
        });
      } else if (decideFreshness(freshness) === "restart") {
        return stopForFreshness(freshness);
      }
    }
    cyclesEntered++;

    // Console "drain now", consumed once at the top of a cycle. Its whole effect is "run one dispatch
    // cycle immediately", which this loop body already is, so consuming and ledgering it is the action.
    // The holds above still win: a drain request never overrides a deliberate hold.
    if (deps.consumeDrainNow) {
      const drain = deps.consumeDrainNow();
      if (drain) log("console.drain_consumed", { origin: drain.origin });
    }

    const isMerged = deps.refreshMergedAsync ? await deps.refreshMergedAsync(planForBatch) : deps.refreshMerged(planForBatch);
    for (const taskId of pendingMergedCredit) {
      if (!isMerged(taskId)) continue;
      pendingMergedCredit.delete(taskId);
      merged.push(taskId);
      log("daemon.merge_credit_visible", { task: taskId });
    }

    // Reconcile the daemon-lifetime parks from the SAME cached projection dispatch uses below. A
    // credited merge is conclusive. A confirmed absence of an open PR is conclusive only when both
    // ownership readers are wired and the credit read is readable; omitted or indeterminate evidence
    // preserves the park fail-closed. A timer alone never buys the identical blocked head again.
    for (const [taskId, park] of parkedBlockers) {
      let reason: "merged" | "no-open-pr" | undefined;
      if (isMerged(taskId)) {
        reason = "merged";
      } else if (
        deps.isOpenPr !== undefined &&
        deps.isCreditIndeterminate !== undefined &&
        !deps.isCreditIndeterminate(taskId) &&
        deps.isOpenPr(taskId) === undefined
      ) {
        reason = "no-open-pr";
      }
      if (!reason) continue;
      parkedBlockers.delete(taskId);
      log("daemon.block.rearmed", { task: taskId, pr_url: park.prUrl, reason });
    }

    // W1-T8616: a merged task's dispatch claim is released here, from the cycle's own `isMerged`.
    if (deps.releaseLandedClaims && !landedClaimSweepInFlight) {
      landedClaimSweepInFlight = true;
      void deps
        .releaseLandedClaims(isMerged)
        .catch((e) => log("dispatch.claim_sweep_failed", { surface: "tick-sweep", error: String((e as Error)?.message ?? e).slice(0, 300) }))
        .finally(() => {
          landedClaimSweepInFlight = false;
        });
    }

    // Admit the restricted boot review BEFORE a phase ticker can wake during the scheduler turns below.
    // Start, don't await: a slow review must not serialize the background full sweep, or dispatch, behind it.
    if (bootGateTrigger === undefined && !bootReviewStarted) {
      bootReviewStarted = true;
      bootReviewInFlight = true;
      void (async () => {
        try {
          await deps.sweepLight?.({ reviewOnly: true, scope: "boot" });
        } catch (e) {
          log("daemon.sweep_light.failed", { phase: "boot", error: String((e as Error)?.message ?? e) });
        } finally {
          bootReviewInFlight = false;
          releaseGatedCadences();
        }
      })();
    }

    // The level-triggered PR-pipeline reconciler, once per iteration: re-derive every open PR's disposition
    // and take its gated action, alongside dispatch rather than instead of it (W1-T77, ratifies P22).
    // Best-effort in code, not just prose: this loop's only try/catch wraps the dispatch below, so an
    // unreachable GitHub used to propagate out of the process (W1-T513). Forensics: docs/forensics/daemon.md.
    // W1-T4998: STARTED here and never awaited; a call still outstanding from an earlier tick is left
    // to finish, and a pass abandoned by its bound is declined by the gate's own liveness check. The
    // turn first lets a call already returning (an abandonment mid-`finally`) clear itself.
    if (deps.sweep) await new Promise<void>((resolve) => setImmediate(resolve));
    if (deps.sweep && !backgroundSweep) {
      sweepRetriggerState.lastRunAtMs = daemonClock.now();
      sweepRetrigger.slot.adopt(runGatedSweep(deps, pollIntervalMs, sweepBound, log, diskHeadroomLatch, headroomSampler, sweepLiveness));
    }
    // One scheduler turn, so a pass that settles at once is read by the tick that started it.
    if (deps.sweep) await new Promise<void>((resolve) => setImmediate(resolve));
    // W1-T3618: the MOST RECENT COMPLETED pass feeds the pre-admission re-check below. W1-T3691: its
    // recurrence verdict is computed once per completed pass — never once per tick, which would count one
    // stale reading as a streak — and consulted by both the idle branch and that re-check, so the two can
    // never disagree. Does NOT itself commit `restartRequested`; see `requestStaleReviewerRestart`.
    const passesThisTick = deps.sweep ? completedSweeps.splice(0) : [{ outcome: undefined, durationMs: 0 }];
    let sweepMsThisTick: number | null = null;
    for (const completed of passesThisTick) {
      if (deps.sweep) sweepMsThisTick = completed.durationMs;
      latestSweepOutcome = completed.outcome;
      const staleReviewerObservation: StaleReviewerSkipObservation | undefined = completed.outcome?.reviewerCodeStale
        ? { codeSha: completed.outcome.reviewerCodeStale.oldSha, originMainSha: completed.outcome.reviewerCodeStale.newSha }
        : undefined;
      const staleReviewerVerdict = trackStaleReviewerSkipRecurrence(staleReviewerObservation, staleReviewerRecurrence);
      staleReviewerRecurrence = staleReviewerVerdict.state;
      staleReviewerAction = staleReviewerVerdict.action;
      if (staleReviewerAction.kind === "held") {
        // (design iii) visible before it is acted on: a repeat below the restart streak still
        // renders, so the operator can read the cause without tailing the ledger.
        log("review.stale_reviewer_held", {
          code_sha: staleReviewerAction.codeSha,
          origin_main_sha: staleReviewerAction.originMainSha,
          streak: staleReviewerAction.streak,
          description: renderHeldReviewQueueBlocker({
            kind: "held_review_queue",
            codeSha: staleReviewerAction.codeSha,
            originMainSha: staleReviewerAction.originMainSha,
            prNumbers: staleReviewerObservation?.prNumbers ?? [],
            streak: staleReviewerAction.streak,
          }),
        });
      } else if (staleReviewerAction.kind === "needs_human" && staleReviewerNeedsHumanSha !== staleReviewerAction.codeSha) {
        staleReviewerNeedsHumanSha = staleReviewerAction.codeSha;
        log("review.stale_reviewer_needs_human", {
          code_sha: staleReviewerAction.codeSha,
          origin_main_sha: staleReviewerAction.originMainSha,
          reason: staleReviewerAction.reason,
        });
        // Same backstop discipline as `onStarvation`'s own catch: a failed notification costs one
        // logged line, never the daemon's liveness.
        try {
          await deps.onStaleReviewerNeedsHuman?.({
            codeSha: staleReviewerAction.codeSha,
            originMainSha: staleReviewerAction.originMainSha,
            reason: staleReviewerAction.reason,
          });
        } catch (e) {
          log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
        }
      }
    }
    // W1-T9124: a body edited with no push leaves the head-keyed status on a stale verdict; the sweep queues the
    // re-review, and the daemon makes any still-unjudged input visible once per head+digest.
    for (const stale of staleBodyFindingsForTick(latestSweepOutcome?.reviewInputViews, deps.readLedgerLines)) {
      const staleKey = `${stale.prUrl}@${stale.headSha}@${stale.currentDigest}`;
      if (staleBodyReported.has(staleKey)) continue;
      staleBodyReported.add(staleKey);
      log("review.stale_body_pending", {
        pr_number: stale.prNumber, head_sha: stale.headSha, review_input_digest: stale.currentDigest,
        reviewed_input_digest: stale.reviewedDigest, queued: stale.queued,
      });
    }
    const sweepCycleOutcome = latestSweepOutcome;
    const tickStaleReviewerAction = staleReviewerAction;
    // Marks `restartRequested` and ledgers `review.stale_reviewer_restart_requested` — the marker
    // `priorStaleReviewerRecurrenceState` reads back at a future boot — ONLY when a caller below
    // actually reaches this, i.e. only when the restart is genuinely about to be requested. Calling
    // this to merely COMPUTE whether this tick is stale (as opposed to acting on it) would mark a
    // restart that never happened, corrupting the very falsifier design (v) exists to hold.
    const requestStaleReviewerRestart = (): Extract<DaemonFreshness, { stale: true }> | undefined => {
      if (tickStaleReviewerAction.kind !== "restart" || tickStaleReviewerAction.originMainSha === checkoutBlockedTarget) return undefined;
      staleReviewerRecurrence = staleReviewerRecurrence
        ? { ...staleReviewerRecurrence, restartRequested: true }
        : staleReviewerRecurrence;
      log("review.stale_reviewer_restart_requested", {
        code_sha: tickStaleReviewerAction.codeSha,
        origin_main_sha: tickStaleReviewerAction.originMainSha,
        streak: tickStaleReviewerAction.streak,
      });
      return { stale: true, oldSha: tickStaleReviewerAction.codeSha, newSha: tickStaleReviewerAction.originMainSha };
    };

    // The clock that spans the former gap. It stays live across the reconciliation rungs below and is
    // stopped before a phase ticker or an idle wait takes ownership of the clock (W1-T2852). W1-T4998: a
    // background pass's own ticker already runs the light pass, so the clock starts only when no such
    // runner holds the slot, and the two restricted passes still never overlap.
    const backgroundSweepOwnsTheTicker = (): boolean => inFlightTickerOwner?.phase === "sweep";
    let interphaseReviewClock: InterphaseReviewClock | undefined = backgroundSweepOwnsTheTicker()
      ? undefined
      : startInterphaseReviewClock(deps, pollIntervalMs, log);
    let interphaseEventWakeSeen = false;
    const stopInterphaseReviewClock = async (): Promise<boolean> => {
      const clock = interphaseReviewClock;
      interphaseReviewClock = undefined;
      if (clock) {
        const stoppedClock = await clock.stop();
        interphaseEventWakeSeen ||= stoppedClock.eventWakeSeen;
      }
      return interphaseEventWakeSeen;
    };
    const restartInterphaseReviewClock = (): void => {
      if (!interphaseReviewClock && !backgroundSweepOwnsTheTicker()) {
        interphaseReviewClock = startInterphaseReviewClock(deps, pollIntervalMs, log);
      }
    };

    // W1-T7734 — THE IDLE SLEEP IS NOT BLIND WHILE A POST-REVIEW PR WAITS. The clock above stops before this
    // sleep (it would overlap the passes below), so the sleep itself runs the light pass, at a cadence
    // derived from observed review duration and head churn rather than once per poll interval.
    // The final chunk ends the sleep, because the next tick's full pass is the pass that follows it.
    const sleepIdleWithReviewDemand = async (): Promise<void> => {
      let demand: ReturnType<NonNullable<DaemonDeps["readIdleReviewDemand"]>>;
      try {
        demand = deps.sweepLight ? deps.readIdleReviewDemand?.() : undefined;
      } catch (e) {
        log("daemon.idle_light_pass.demand_unreadable", { error: String((e as Error)?.message ?? e) });
        demand = undefined;
      }
      if (!demand || !(demand.eligible > 0) || demand.cadenceMs === undefined || !(demand.cadenceMs < pollIntervalMs)) {
        await sleepUntilSweepWake(pollIntervalMs);
        return;
      }
      let remainingMs = pollIntervalMs;
      let passes = 0;
      let cadenceMs: number = demand.cadenceMs;
      while (remainingMs > 0) {
        const chunkMs = Math.min(cadenceMs, remainingMs);
        const slept = await sleepUntilSweepWake(chunkMs);
        remainingMs -= chunkMs;
        if (slept === "wake" || remainingMs <= 0) return;
        if (deps.checkStop?.() || deps.checkPause?.()) return;
        passes += 1;
        log("daemon.idle_light_pass", {
          eligible: demand.eligible, cadence_ms: cadenceMs, median_review_ms: demand.medianReviewMs,
          pushes_per_pr_hour: demand.pushesPerPrHour, poll_interval_ms: pollIntervalMs, pass: passes,
        });
        try {
          await deps.sweepLight!({ reviewOnly: true, scope: "idle" });
        } catch (e) {
          log("daemon.sweep_light.failed", { phase: "idle", error: String((e as Error)?.message ?? e) });
        }
        const next = deps.readIdleReviewDemand?.();
        if (!next || !(next.eligible > 0)) {
          // The demand cleared: nothing waits any more, so the rest of the sleep is the ordinary one.
          await sleepUntilSweepWake(remainingMs);
          return;
        }
        demand = next;
        cadenceMs = next.cadenceMs ?? cadenceMs;
      }
    };

    // W1-T9072: while the gate is closed this tick skips the gated cadences and goes on to dispatch. They run at
    // the first iteration top after it opens, so never beside a lane this tick starts. The deferral rows hold
    // cadences, not lanes, so they leave this tick's idle-slot cause as it was.
    // W1-T9225: the boot review pass holds them the same way, skipped and never awaited, and the rows written on the
    // first held tick name which of the two waits each cadence is held for.
    const bootWaitsFor: BootWait[] = [
      ...(bootGateTrigger === undefined ? ["first_full_pass" as const] : []),
      ...(bootReviewInFlight ? ["boot_review_pass" as const] : []),
    ];
    if (bootWaitsFor.length > 0 && !bootCadencesDeferred) {
      bootCadencesDeferred = true;
      const [idleCause, idleHold] = [idleLaneTickCause, idleLaneTickHold];
      for (const cadence of BOOT_GATED_CADENCES) if (deps[cadence]) deferBootCadence(cadence, bootWaitsFor);
      [idleLaneTickCause, idleLaneTickHold] = [idleCause, idleHold];
    }
    const cadencesThisTick = bootWaitsFor.length === 0;
    if (cadencesThisTick) startDueRungsTimer();
    const cadencesStartedAtMs = daemonClock.now();
    // W1-T9321: the three per-iteration sweeps (orphan, feedback landing, GitHub posture) share one slot,
    // `tickSweeps`; a tick that skips them behind the boot gate owes them to the due timer.
    if (cadencesThisTick) await tickSweeps.run();
    else if (tickSweepsWired) tickSweeps.owe();

    if (cadencesThisTick) {
      const running = readOnlyRungs.joined();
      if (running) await running;
      else {
        const release = readOnlyRungs.begin();
        let outcome: Awaited<ReturnType<typeof readOnlyRungs.start>> | undefined;
        try {
          const steps = readOnlyRungs.steps();
          let value: unknown;
          let error: unknown;
          let threw = false;
          for (;;) {
            const step = threw ? steps.throw(error) : steps.next(value);
            if (step.done) { outcome = step.value; break; }
            try { value = await step.value; threw = false; } catch (e) { log("daemon.due_rungs.step_rejected", { error: String((e as Error)?.message ?? e) }); error = e; threw = true; }
          }
        } finally {
          release(outcome);
        }
        outcome;
      }
    }
    const msInCadences = Math.max(0, daemonClock.now() - cadencesStartedAtMs);
    // W1-T4998: one row per tick that reaches the admission decision, so its latency reads off the ledger.
    const logTickPhases = (): void => {
      log("daemon.tick_phases", {
        ms_to_admission: Math.max(0, daemonClock.now() - tickStartedAtMs),
        ms_in_sweep: sweepMsThisTick,
        ms_in_cadences: msInCadences,
        sweep_in_flight: sweepLiveness.inFlight,
      });
    };

    // Headroom: never hammer a nearly-exhausted pool. An at-or-near-limit reading gates new spawns
    // without halting the loop, because a supervisor restart-loops on any exit and exiting here would
    // relaunch into the same reading every poll. So this is an in-process idle state, identical in shape
    // to "nothing runnable" below. The usage read happens fresh every tick, so a real reset is picked up
    // automatically with no wake-at-reset timer. The ceiling itself is time-aware.
    if (deps.readUsage) {
      // The authoritative per-tick read stamps the shared sampler, so an in-flight ticker starting straight
      // after it waits out the full staleness bound instead of re-probing seconds later. Stamped before
      // the guard below because an unreadable read is still an attempt (W1-T2565).
      headroomSampler.lastSampleMs = daemonClock.now();
      const snap = await deps.readUsage();
      if (snap) {
        // A GOOD read clears the degraded-mode counter — only CONSECUTIVE
        // misses count toward escalation, not a lifetime total.
        consecutiveUnreadable = 0;
        // …and ends any park episode with it: the governor can see again, so the ceiling has
        // nothing left to bound and a LATER park starts its clock fresh.
        parkedSinceMs = undefined;
        parkCeilingEscalated = false;
        const windows = resolveHeadroomWindows(snap, daemonClock.date(), headroomPolicy, (window, raw) => {
            // Once per window, not per distinct string. The loop polls every 60s, so a per-tick emission would write
            // about 1,440 identical lines a day. Keying on the raw string stopped bounding anything once the upstream
            // emitted microsecond-precision timestamps: measured 1:1 fired-to-distinct on two independent ledgers.
            // The set is seeded from the ledger, so the bound holds across a restart (W1-T482).
            if (reportedUnrecognisedResets.has(window)) return;
            reportedUnrecognisedResets.add(window);
            // Carry the string: the whole value is knowing WHAT could not be parsed. A coarser key must not mean
            // a lost sample, so the one line this window emits still carries a representative raw value.
            log("daemon.usage_reset_unrecognised", {
              window,
              raw: raw.slice(0, UNRECOGNISED_RESET_MAX_LEN),
              truncated: raw.length > UNRECOGNISED_RESET_MAX_LEN,
            });
          });
        const over = windows.find((w) => w.percentUsed >= w.limitPct) ?? null;
        // A breach episode escalates at most once. Cleared here unconditionally, whether or not the governor
        // is enforcing, so a later breach is treated as a fresh episode (P34 (c), W1-T249).
        if (!over) headroomReserveEscalated = false;
        // Enforcement (the W1-T197 curve, unchanged): an at-or-over-limit reading is an in-process idle
        // heartbeat while over, never a stop, and resumes on its own once the window resets. The counter
        // advances before the heartbeat, so the line carries this idle tick's own number.
        const enforcingIdle = headroomEnabled && over !== null;
        if (enforcingIdle) ticks++;
        // One heartbeat per tick, in every enforcement posture. The log used to sit inside the over-ceiling
        // branch when enforcing and inside the else when disabled, with no else on the inner test — so the
        // posture an operator is most likely to be in, governor armed and usage under the ceiling, logged
        // nothing at all. Measured: no headroom line at all after the governor was armed on 2026-07-31.
        // Nothing about enforcement moved, only the under-ceiling silence. Forensics: docs/forensics/daemon.md.
        const reading = over ?? windows[0];
        // W1-T10381: whose usage this row measured, and whether the host login has moved off it.
        let fleetAccount: string | undefined;
        let fleetDivergence: FleetAccountDivergence | undefined;
        if (deps.readFleetAccounts) {
          let pair: FleetAccountPair | undefined;
          try {
            pair = deps.readFleetAccounts();
          } catch (e) {
            log("daemon.fleet_account.unreadable", { error: String((e as Error)?.message ?? e) });
          }
          fleetAccount = redactedAccountLabel(pair?.store);
          fleetDivergence = fleetAccountEpisode.observe(
            pair,
            over ? { window: over.window, percentUsed: over.percentUsed, limitPct: over.limitPct } : null,
            daemonClock.now(),
          );
        }
        if (reading) {
          log("daemon.headroom", {
            ...(enforcingIdle ? { tick: ticks } : {}),
            ...(fleetAccount !== undefined ? { account: fleetAccount } : {}),
            window: reading.window,
            percent_used: reading.percentUsed,
            limit_pct: reading.limitPct,
            resets_at: reading.resetsAtDisplay,
            enforced: headroomEnabled,
            over_ceiling: over !== null,
            poll_interval_ms: pollIntervalMs,
            ...(headroomEnabled
              ? {}
              : { note: "headroom governor disabled (ruling a4153e) — telemetry only, dispatch not gated" }),
          });
        }
        if (fleetDivergence) {
          const row = fleetDivergence;
          log("daemon.fleet_account_diverged", {
            store_account: row.storeAccount,
            host_account: row.hostAccount,
            window: row.window,
            store_percent_used: row.storePercentUsed,
            host_percent_used: row.hostPercentUsed,
            limit_pct: row.limitPct,
            remedy: row.remedy,
          });
          try {
            await deps.onFleetAccountDivergence?.(fleetDivergence);
          } catch (e) {
            log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
          }
        }
        if (enforcingIdle) {
          // Notify once per episode. Dispatch is already paused by this same branch, so the hook is a pure
          // notification. A failure costs one logged line, never the daemon's liveness (P34 (c), W1-T249).
          if (!headroomReserveEscalated) {
            headroomReserveEscalated = true;
            try {
              await deps.onHeadroomBreach?.({
                window: over!.window,
                percentUsed: over!.percentUsed,
                limitPct: over!.limitPct,
                resetsAt: over!.resetsAtDisplay,
              });
            } catch (e) {
              log("daemon.escalation.failed", { error: String((e as Error)?.message ?? e) });
            }
          }
          if (await stopInterphaseReviewClock()) continue;
          await sleepUntilSweepWake(pollIntervalMs);
          continue;
        }
        // GOVERNOR DISABLED (operator ruling fb-1784894405468-a4153e) or simply
        // UNDER the ceiling: no `continue` — dispatch proceeds regardless of burn.
      } else if (headroomEnabled) {
        // Unreadable: cannot-read-the-budget must never render as proceed-as-if-unlimited, the fail-open
        // polarity at the spending layer. This is an explicit, bounded policy rather than an implicit
        // fall-through: recon R-7 measured the read unavailable about 78% of the time, so dispatch is still
        // permitted within the allowance and always logged distinctly. Past the allowance, the daemon idles in
        // process until a read succeeds again. Forensics: docs/forensics/daemon.md.
        consecutiveUnreadable++;
        const parkGate = evaluateHeadroomPark(
          consecutiveUnreadable,
          unreadableDegradedLimit,
          parkedSinceMs,
          daemonClock.now(),
          parkCeilingMs,
        );
        if (parkGate.parked && parkedSinceMs === undefined) parkedSinceMs = daemonClock.now();
        if (parkGate.parked && !parkGate.forced) {
          ticks++;
          log("daemon.headroom.degraded", {
            tick: ticks,
            consecutive_unreadable: consecutiveUnreadable,
            degraded_limit: unreadableDegradedLimit,
            poll_interval_ms: pollIntervalMs,
            parked_ms: parkGate.waitedMs,
            park_ceiling_ms: parkCeilingMs,
            note: "usage unreadable beyond the bounded allowance — idling, not dispatching",
          });
          if (await stopInterphaseReviewClock()) continue;
          await sleepUntilSweepWake(pollIntervalMs);
          continue;
        }
        if (parkGate.forced) {
          // The ceiling fired. Dispatch proceeds with the governor still blind, and the row says so plainly:
          // forcing deliberately accepts the risk the bound exists to prevent rather than pretending the read
          // succeeded. One tick, not a mode — clearing the clock here re-arms the ceiling, so exposure is
          // bounded at one blind dispatch per ceiling.
          log("daemon.headroom.park_ceiling_forced", {
            tick: ticks,
            consecutive_unreadable: consecutiveUnreadable,
            degraded_limit: unreadableDegradedLimit,
            parked_ms: parkGate.waitedMs,
            park_ceiling_ms: parkCeilingMs,
            note:
              "usage unreadable past the park ceiling — dispatching BLIND for one tick and re-arming; " +
              "the spend bound this bypasses is deliberately accepted, not satisfied",
          });
          if (!parkCeilingEscalated) {
            parkCeilingEscalated = true;
            // Same backstop discipline as `onCircuitBreak`/`onHeadroomBreach`: a failed
            // notification costs one logged line, never the daemon's liveness.
            try {
              await deps.onHeadroomParkCeiling?.({
                consecutiveUnreadable,
                parkedMs: parkGate.waitedMs,
                ceilingMs: parkCeilingMs,
              });
            } catch (e) {
              log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
            }
          }
          parkedSinceMs = undefined;
        }
        log("daemon.headroom.unavailable", {
          consecutive_unreadable: consecutiveUnreadable,
          degraded_limit: unreadableDegradedLimit,
          note: "usage unreadable — bounded degraded-mode allowance, still dispatching",
        });
      } else {
        // Unreadable while the governor is disabled (ruling a4153e clause 4): an unreadable read is absent
        // telemetry, never a hold. Reset the counter so a later enable starts clean.
        consecutiveUnreadable = 0;
      }
    }

    // Quota, beside the headroom block above on the same tick, never a new cadence. Both buckets are read
    // together and recorded independently every tick a read succeeds, so an exhaustion of either is
    // visible on the ledger without anyone requesting the health page. Observe and surface only:
    // dispatch is never paused on a bucket's account (W1-T372).
    if (deps.readGhQuota) {
      const quota = deps.readGhQuota();
      // W1-T10271: the read cadence the floor was sized by, measured rather than inferred from quota
      // deltas. Taken once per poll and carried on the first row written, so a sum never double counts.
      let cadence: GhReadCadenceTally | undefined = (deps.takeGhReadCadence ?? takeGhReadCadenceTally)();
      for (const bucket of ["core", "graphql"] as const) {
        const reading = quota[bucket];
        if (!reading) continue;
        log("daemon.quota", {
          bucket,
          remaining: reading.remaining,
          resets_at: reading.resetsAt,
          poll_interval_ms: pollIntervalMs,
          ...cadence,
        });
        cadence = undefined;
        // A state transition, not a value check: an exhausted bucket stays exhausted every tick until it
        // resets, so alerting on the raw value would re-fire up to once a minute for an hour. The latch fires
        // only on the tick a bucket first reads exhausted, and clears the instant it reads positive.
        if (reading.remaining > 0) {
          quotaExhaustedEscalated[bucket] = false;
          continue;
        }
        if (quotaExhaustedEscalated[bucket]) continue;
        quotaExhaustedEscalated[bucket] = true;
        try {
          await deps.onQuotaExhausted?.({ bucket, remaining: reading.remaining, resetsAt: reading.resetsAt });
        } catch (e) {
          log("daemon.escalation.failed", { error: String((e as Error)?.message ?? e) });
        }
      }
    }

    // The daily cost ceiling and the WIP ceiling: both global gates, not per-task ones, so they are checked
    // directly here, after headroom and before the retro and auto-triage rungs, because each of those also
    // spawns a real run. A deferral is an in-process idle heartbeat (W1-T317, W1-T321). This is the
    // tick-wide gate, not the per-dispatch gate a multi-lane batch needs — see the second consultation
    // immediately before the dispatch below (W1-T342). Forensics: docs/forensics/daemon.md.
    const tickGovernor = checkDispatchGovernors(deps, dailyCostCeilingUsd);
    // The reading behind that admission sizes this tick's lanes, so the budget cannot refuse what the
    // governor's adaptive bound just admitted (2026-10-10: admitted at 14, sized to 0 against 10).
    const tickQueueAdmission = deps.readQueueAdmission?.();
    if (tickGovernor) {
      logTickPhases();
      ticks++;
      logDispatchGovernorDefer(tickGovernor, ticks);
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }

    spendGatesOpen = true;
    let intakeHeld = false;
    if (cadencesThisTick) {
      const running = intakeRungs.joined();
      if (running) intakeHeld = await running;
      else {
        const release = intakeRungs.begin();
        let outcome: Awaited<ReturnType<typeof intakeRungs.start>> | undefined;
        try {
          const steps = intakeRungs.steps();
          let value: unknown;
          let error: unknown;
          let threw = false;
          for (;;) {
            const step = threw ? steps.throw(error) : steps.next(value);
            if (step.done) { outcome = step.value; break; }
            try { value = await step.value; threw = false; } catch (e) { log("daemon.due_rungs.step_rejected", { error: String((e as Error)?.message ?? e) }); error = e; threw = true; }
          }
        } finally {
          release(outcome);
        }
        intakeHeld = outcome;
      }
    }
    if (intakeHeld) continue;

    // Retro cadence trigger, evaluated once per tick after headroom — an automated retro spawns a real run,
    // the same class of spend headroom exists to gate — and before the dispatch pick. There is deliberately
    // no wait-and-continue: the gates above exist to REFUSE a dispatch, but the retro gates nothing and
    // only delayed reaching dispatch by a full poll interval (W1-T2265). Forensics: docs/forensics/daemon.md.
    // W1-T9321: one slot, `retroCadence`, so the due timer can pay a gated tick's owed run; a hold still ends the tick.
    if (cadencesThisTick && deps.checkRetroTrigger) {
      if (await retroCadence.run()) continue;
    } else if (deps.checkRetroTrigger) retroCadence.owe();

    let wipeTestHeld = false;
    if (cadencesThisTick) {
      const running = wipeTestRung.joined();
      if (running) wipeTestHeld = await running;
      else {
        const release = wipeTestRung.begin();
        let outcome: Awaited<ReturnType<typeof wipeTestRung.start>> | undefined;
        try {
          const steps = wipeTestRung.steps();
          let value: unknown;
          let error: unknown;
          let threw = false;
          for (;;) {
            const step = threw ? steps.throw(error) : steps.next(value);
            if (step.done) { outcome = step.value; break; }
            try { value = await step.value; threw = false; } catch (e) { log("daemon.due_rungs.step_rejected", { error: String((e as Error)?.message ?? e) }); error = e; threw = true; }
          }
        } finally {
          release(outcome);
        }
        wipeTestHeld = outcome;
      }
    }
    if (wipeTestHeld) continue;

    // Console "run" kick: a queued-row Run dispatches that task by id this cycle, ahead of the ordinary
    // ordering but still through the normal gate. A kicked id that is unknown, already merged, or refused
    // by {@link assertRunnable} is cleared and its named reason ledgered, never silently dropped. The
    // first runnable kick becomes this cycle's task; others wait (fb-1784988460437-9daa9b).
    const mergedTask: MergedResolver = (t) => isMerged(t.id);
    // W1-T10348: the released set, resolved ONCE per tick by the resolver every admission site shares
    // (ledger rows plus operator-releases.json), and handed to the kick, the tick selection and the refill.
    const tickReleases = resolveReleases(deps, planForBatch);
    if (tickReleases.durableUnreadable !== undefined || tickReleases.ledgerUnreadable !== undefined) {
      log("dispatch.releases_unreadable", {
        ...(tickReleases.ledgerUnreadable !== undefined ? { ledger_error: tickReleases.ledgerUnreadable } : {}),
        ...(tickReleases.durableUnreadable !== undefined ? { durable_error: tickReleases.durableUnreadable } : {}),
      });
    }
    let forcedNext: Task | undefined;
    let forcedKick: DaemonKick | undefined;
    if (deps.pendingKicks) {
      for (const kick of deps.pendingKicks()) {
        const refuse = (reason: string) => {
          deps.clearKick?.(kick.taskId, kick.repo);
          log("console.kick_refused", { task: kick.taskId, origin: kick.origin, reason, ...kickRepoField(kick) });
        };
        const task = planForBatch.byId.get(kick.taskId);
        if (!task) { refuse("unknown task id"); continue; }
        if (isMerged(kick.taskId) || pendingMergedCredit.has(kick.taskId)) { refuse("already merged — stale kick"); continue; }
        if (deps.isCreditIndeterminate?.(kick.taskId)) {
          log("console.kick_held", { task: kick.taskId, origin: kick.origin, reason: "open PR ownership unreadable", ...kickRepoField(kick) });
          continue;
        }
        const openPr = deps.isOpenPr?.(kick.taskId);
        if (openPr !== undefined) { refuse(`already has open PR #${openPr} — existing repair owner retains the task`); continue; }
        try {
          // W1-T3216: a console kick for an operator-RELEASED verify:human task must be admitted
          // here too, or the release works from the drain and is refused from the console.
          assertRunnable(planForBatch, task, mergedTask, tickReleases.ids);
        } catch (e) {
          refuse(e instanceof PlanError ? e.message : String((e as Error)?.message ?? e));
          continue;
        }
        // A reservation/governor deferral is not a serviced kick. Clear only at accepted start.
        forcedKick = kick;
        forcedNext = task;
        break;
      }
    }

    // W1-T10799: a managed target with no daemon of its own runs ONE bounded job here, in the lane this daemon
    // reserves for it. Core's own kick has priority, a busy lane or a zero enforced lane target defers the job
    // explicitly, and a second request in the same tick defers behind the first: this adds no capacity.
    if (!forcedNext && deps.pendingTargetJobs && deps.runTargetJob) {
      let pending: Array<DaemonKick & { repo: string }>;
      try { pending = deps.pendingTargetJobs(); }
      catch (error) {
        log("target_job.unknown", { reason: `durable jobs unreadable: ${String(error)}` });
        ticks++;
        await sleepUntilSweepWake(pollIntervalMs);
        continue;
      }
      const [job, ...waiting] = pending;
      if (job) {
        const laneTarget = enforcedLaneTarget(children.size, tickQueueAdmission?.wipLimit);
        const wipBudget = laneDispatchBudget({ laneCount, wipLimit: opts.wipLimit, openPrCount: deps.openPrCount?.(), queueAdmission: tickQueueAdmission });
        if (children.size > 0 || laneTarget < 1 || wipBudget < 1) {
          log("target_job.capacity_deferred", { task: job.taskId, origin: job.origin, repo: job.repo, in_flight: children.size });
        } else {
          for (const other of waiting) log("target_job.capacity_deferred", { task: other.taskId, origin: other.origin, repo: other.repo, reason: "lane reserved by another job" });
          let closed = false;
          try { closed = ["ended", "refused"].includes((await deps.runTargetJob(job, deps)).state); }
          catch (e) { log("target_job.error", { task: job.taskId, origin: job.origin, repo: job.repo, error: String((e as Error)?.message ?? e) }); }
          if (closed) continue;
        }
        // Held, resumed or deferred: the marker stays, and the loop paces itself rather than re-reading it at once.
        ticks++;
        await sleepUntilSweepWake(pollIntervalMs);
        continue;
      }
    }

    // W1-T4077: console PR actions are no longer read here — `startPrActionPump` runs them on their own timer,
    // detached, so a long iteration can neither delay a nudge nor be held by one.

    // Why the daemon is idle. The four eligibility conditions used to decline silently, so a ten-hour
    // idle emitted about 390 bare idle lines and zero dispatch rows: the record could not distinguish
    // "starved of work" from "everything filtered". Nothing about what is eligible changes.
    const idleReasons = tallyDispatchFilters();
    // W1-T8676: every release the latch projects leaves its row, once per blocking run.
    const independentBlockReleasesThisPass = deps.independentBlockReleases?.() ?? new Map<string, IndependentBlockRelease>();
    for (const [taskId, release] of independentBlockReleasesThisPass) {
      if (release.receiptRecorded || ledgeredIndependentBlockReleases.has(release.blockingRunId)) continue;
      ledgeredIndependentBlockReleases.add(release.blockingRunId);
      log(INDEPENDENT_BLOCK_RELEASED_STEP, {
        task_id: taskId, blocking_run_id: release.blockingRunId, blocked_at: release.blockedAt, evidence: release.evidence,
        evidence_at: release.recoveredAt ?? release.mergedAt ?? null, latch_count: release.latchCount, backoff_ms: release.backoffMs,
        ...(release.mergedTaskId ? { merged_task_id: release.mergedTaskId } : {}),
        ...(release.provider ? { provider: release.provider, recovered_task_id: release.recoveredTaskId, recovered_step: release.recoveredStep } : {}),
      });
    }
    let terminalPreDispatchRefusalRevisions: ReadonlyMap<string, string> = new Map();
    try {
      terminalPreDispatchRefusalRevisions = deps.readTerminalPreDispatchRefusalRevisions?.() ?? terminalPreDispatchRefusalRevisions;
    } catch (e) {
      log("dispatch.held_pre_dispatch_refusal_unreadable", { error: String((e as Error)?.message ?? e) });
    }
    // Eligibility ledgers a circuit-broken decline through its own callback, never the filter tally, so
    // it is collected here per tick and the census below can name it alongside the other buckets.
    const circuitBrokenThisTick: string[] = [];
    // One branch sweep per tick, resolved before the options object so the closure below is a
    // set-membership test rather than a round trip per candidate (W1-T916). A failed read refuses
    // nothing, the direction a guard on whether work starts at all must fail.
      const readRunBranchesFor = (site: "tick" | "lane-refill", fallback: string | undefined) =>
        readRunBranchListing(deps.readPushedRunBranches, (error) => {
          log("dispatch.run_branch_read_failed", { site, error: String((error as Error)?.message ?? error) });
          return fallback;
        });
      const tickRunBranchRead = readRunBranchesFor("tick", undefined);
      const tickRunBranchListing = tickRunBranchRead instanceof Promise ? await tickRunBranchRead : tickRunBranchRead;
      // W1-T4002 — the most recent completed full sweep already proved these (W1-T4998); see
      // `SweepCycleOutcome.planOnlyRunBranchReceipts`'s doc for why no second GitHub read happens.
      const planOnlyReceiptsThisTick: readonly PlanOnlyRunBranchReceipt[] = sweepCycleOutcome?.planOnlyRunBranchReceipts ?? [];
      const runBranchStateThisTick = runBranchStateFrom(
        tickRunBranchListing, withRequeueReceipts(deps.readOrphanRunBranchEvidence?.(), deps.readLedgerLines), resumableHandoffs,
        lazyClosedUnmerged(deps.readClosedRunBranchPrs),
      );
      const dispatchOpts: NextRunnableOpts = {
      onPassedOver: observePassedOver("tick"),
      priorityBackfill,
      onDeferredForPriority: logPriorityDeferral,
      onPriorityReservationReleased: logPriorityRelease,
      dispatchValueContext: deps.buildDispatchValueContext?.(planForBatch, isMerged),
      beginSelectionPass: deps.beginSelectionPass,
      isOpenPr: deps.isOpenPr,
      // A run the harness yielded before its PR is walked ahead of fresh starts, so a yield never costs its queue place.
      resumableTaskIds: new Set(resumableHandoffs.keys()),
      // A parked blocker is excluded before the open-PR check, so the existing idle census names it
      // as `continued-this-pass`. Its descendants remain excluded independently by `unmet-deps`.
      excludeIds: new Set([
        ...parkedBlockers.keys(),
        ...pendingMergedCredit,
        ...invalidatedAdmissionsThisRun,
        ...[...illformedAdmissionBlocksThisRun].flatMap(([taskId, fingerprint]) => {
          const currentTask = planForBatch.byId.get(taskId);
          if (currentTask && JSON.stringify(currentTask) === fingerprint) return [taskId];
          // A reload with a changed contract is precisely the signal that turns an immutable-plan
          // refusal into a fresh admission attempt. Dropping an absent task keeps this process-local
          // map bounded when a plan removes work.
          illformedAdmissionBlocksThisRun.delete(taskId);
          return [];
        }),
      ]),
      // The daemon's own target, threaded to the gate. The refusal it enables is counted by the row that
      // already carries every other decline — no new step and no new signal (W1-T988).
      targetRepo: deps.targetRepo,
      isCreditIndeterminate: deps.isCreditIndeterminate,
      // Forwarded into the tick's own opts, exactly as drain.ts forwards them. They are consulted after
      // eligibility and before returning, so this cannot change what this tick dispatches (W1-T2397).
      openSiblingBuildFor: deps.openSiblingBuildFor,
      onOpenSiblingBuild: deps.onOpenSiblingBuild,
      // The same map handed to the partition call below, so the pack step and the real partition can never
      // disagree about a candidate's effective scope (W1-T2286).
      observedByTask: deps.observedByTask,
      // The argument W1-T534 declared and nothing supplied — see `DrainDeps` for why the reader is
      // injected and the parse hoisted (W1-T916).
      ...runBranchDispatchOpts(runBranchStateThisTick, planOnlyReceiptsThisTick, log),
      onFiltered: releasedFilteredLogger(tickReleases, releasedFilteredNamed, idleReasons.onFiltered, log),
      // W1-T10348: the daemon's selector never had a released set, so every released verify:human task
      // was filed under verify-not-auto. The lane refill inherits it through its spread of this literal.
      releasedIds: tickReleases.ids,
      // In-flight: a legible skip on console and ledger; the daemon keeps polling rather than treating an
      // open PR as a block (W1-T80).
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
      // Wrap the injected reader so a failed or indeterminate live read is ledgered here, distinct from an
      // un-wired site that never calls it. It still resolves the same either way, so the fail-open contract
      // is unchanged (W1-T177).
      readLiveState: deps.readLiveState
        ? (taskId, prNumber) => {
            const state = deps.readLiveState!(taskId, prNumber);
            if (state === undefined) log("dispatch.live_state_indeterminate", { task: taskId, pr_number: prNumber });
            return state;
          }
        : undefined,
      // The cached in-flight snapshot was stale, so this task is not actually blocked. Ledgered distinctly,
      // naming the freshly observed terminal state (W1-T177).
      onStoodDown: (t, prNumber, state) =>
        log("dispatch.stood_down", { task: t.id, pr_number: prNumber, state, reason: "cached in-flight read was stale" }),
      isIndeterminate: deps.isIndeterminate,
      // Indeterminate: a legible ledger line every tick it is consulted. The daemon keeps polling
      // everything else rather than halting (W1-T119).
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id, ...deps.breakerDetail?.(t.id) });
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      // Circuit breaker: a legible ledger line every tick it is consulted, but the escalation hook fires at most once
      // per task id for this run. The daemon keeps polling everything else rather than halting the loop (P29(ii)).
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id, ...deps.breakerDetail?.(t.id) });
        circuitBrokenThisTick.push(t.id);
        if (!circuitEscalated.has(t.id)) {
          circuitEscalated.add(t.id);
          // The injected hook opens a GitHub issue. It fires during task SELECTION, outside the dispatch
          // try/catch below, so an unreachable GitHub used to kill the daemon here. The notification is a
          // backstop; failing to send it must never outrank staying alive to do the work.
          try {
            deps.onCircuitBreak?.(t);
          } catch (e) {
            log("daemon.escalation.failed", { task: t.id, error: String((e as Error)?.message ?? e) });
          }
        }
      },
      isLifetimeCapExceeded: deps.isLifetimeCapExceeded,
      // W1-T4025: the legacy callback remains telemetry-compatible, while the adaptive route is
      // collected separately and flushed only after this tick's selection/dispatch settles.
      onLifetimeCapExceeded: (t) => {
        log("dispatch.lifetime_pressure", { task: t.id });
        if (!lifetimePressureObserved.has(t.id)) {
          lifetimePressureObserved.add(t.id);
          try {
            deps.onLifetimeCapExceeded?.(t);
          } catch (e) {
            log("daemon.escalation.failed", { task: t.id, error: String((e as Error)?.message ?? e) });
          }
        }
      },
      onLifetimePressure: (t) => lifetimePressureTasks.set(t.id, t),
      isIndependentFailureBlocked: (taskId) => {
        if (deps.categorizedRefusalRejoinFor?.(taskId)) independentFailureBlocksThisRun.delete(taskId);
        // W1-T8676: a worker-error hold defers to the ledger's provider release, so this process cannot outlast it.
        if (independentBlockReleasesThisPass.get(taskId)?.evidence === "provider_recovered") independentFailureBlocksThisRun.delete(taskId);
        const environmentalAt = environmentalBlocksThisRun.get(taskId);
        const heldInProcess =
          independentFailureBlocksThisRun.has(taskId) ||
          (environmentalAt !== undefined && daemonClock.now() - environmentalAt < ENVIRONMENTAL_BLOCK_COOLDOWN_MS);
        return heldInProcess || laneDeliveryParked(taskId) || deps.isIndependentFailureBlocked?.(taskId) === true;
      },
      isTerminalPreDispatchRefusalHeld: (task) =>
        terminalPreDispatchRefusalRevisions.get(task.id) === preDispatchContractRevision(task),
    };

    // The dispatch set, adopting drain.ts's lane machinery rather than a second implementation. A console
    // kick always dispatches alone, bypassing candidate selection: it already ran the gauntlet eligibility
    // exists to apply. Otherwise the candidate walk applies the exact same eligibility chain the
    // single-task selector does, and at one lane the same single task is returned via the same walk, firing
    // the same callbacks in the same order (W1-T343). Forensics: docs/forensics/daemon.md.
    const occupiedChildren = new Map<Task, RunChildHandle>();
    const occupiedTasks: Task[] = [...children.values()].map((child) => {
      const task: Task = { ...(planForBatch.tasks.find((task) => task.id === child.taskId) ?? {
        id: child.taskId, title: child.taskId, repo: deps.targetRepo ?? "remudero", type: "implement", verify: "auto",
        risk: "low", attempts: 0, depends_on: [], status: "queued",
      }) };
      occupiedChildren.set(task, child);
      return task;
    });
    let dispatchSet: Task[];
    let tickEligible: Task[] = [];
    let tickContext: DispatchValueContext | undefined = dispatchOpts.dispatchValueContext;
    // Hoisted here because the partition is scoped to the else branch below while the rung now runs
    // outside the idle branch. Zero means nothing was deferred this tick; the forced path leaves it zero,
    // which is correct — an operator-forced dispatch is not evidence of a collision.
    let deferredPairings = 0;
    // Hoisted for the same reason. Left at 0 on the forced path: an operator-forced dispatch is not
    // evidence of spare capacity.
    let laneBudget = 0;
    bootFirstSelectionAtMs ??= daemonClock.now();
    if (forcedNext) {
      dispatchSet = hasChildTask(forcedNext.id) || occupiedTasks.length >= laneCount ? [] : [forcedNext];
      tickEligible = [...dispatchSet];
    } else {
      const wipBudget = laneCount <= 1
        ? laneCount
        : laneDispatchBudget({ laneCount, wipLimit: opts.wipLimit, openPrCount: deps.openPrCount?.(), queueAdmission: tickQueueAdmission });
      const tickLaneTarget = enforcedLaneTarget(occupiedTasks.length, tickQueueAdmission?.wipLimit);
      const budget = Math.max(0, Math.min(wipBudget, tickLaneTarget) - occupiedTasks.length);
      if (laneCount >= 2 && budget <= 0) {
        // Mirrors `runDrainLanes`' own WIP-deferred row: runnable work may exist, held back by the governor
        // rather than absent, which is distinct from an ordinary idle tick. Never reached at one lane.
        // W1-T9097: a zero the enforced lane target produced (the WIP budget had room) is named as the target's.
        const targetHeld = wipBudget > occupiedTasks.length;
        log(targetHeld ? "dispatch.lane_target_held" : "dispatch.wip_deferred", {
          lane_count: laneCount,
          ...(targetHeld ? { target: tickLaneTarget, in_flight: occupiedTasks.length } : {}),
          wip_limit: opts.wipLimit ?? null,
          observed_open_count: deps.openPrCount?.() ?? null,
          ...wipDeferredAdmissionFields(tickQueueAdmission),
        });
      }
      const selection = captureDispatchFrontier(planForBatch, {
        ...dispatchOpts, excludeIds: new Set([...(dispatchOpts.excludeIds ?? []), ...childTaskIds()]), inFlight: occupiedTasks,
      });
      const candidates = runnableCandidates(planForBatch, isMerged, budget, selection.opts);
      forgetPassedOver(planForBatch, candidates);
      tickEligible = selection.eligible;
      tickContext = selection.context;
      // Passed explicitly rather than relying on the partition's own default parameter — see
      // `DaemonDeps.observedByTask` (W1-T2286).
      const partition = partitionByFileOverlap([...occupiedTasks, ...candidates], deps.observedByTask ?? NO_OBSERVED_SCOPE);
      for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
      deferredPairings = partition.serialized.length;
      laneBudget = budget;
      dispatchSet = partition.dispatch.filter((task) => !hasChildTask(task.id));
    }
    logTickPhases();

    // The auto-triage rung runs BEFORE the idle branch (operator ruling, reversing W1-T469). The starved
    // state is the idle state, and the gate W1-T469 served was circular: a deferral needs two eligible tasks
    // to collide, so the rung that CREATES work could only fire when work already existed. Measured on a
    // starved daemon: about 87 feedback entries unread, thirteen hours. The accepted cost is a skipped row
    // per held tick, each naming which bound held. Forensics: docs/forensics/daemon.md.
    // W1-T9321: one slot, `autoTriageCadence`; a gated tick owes it this tick's census for the due timer to pay.
    const autoTriageSignals = { deferralPending: deferredPairings > 0, dispatchCount: dispatchSet.length, laneBudget };
    if (cadencesThisTick && deps.checkAutoTriage) {
      if (await autoTriageCadence.run(autoTriageSignals)) continue;
    } else if (deps.checkAutoTriage) autoTriageCadence.owe(autoTriageSignals);

    dispatchSet.unshift(...occupiedTasks);
    if (dispatchSet.length === 0) {
      noteBootFirstDispatch({ heldReason: "nothing_runnable" });
      scheduleRepositoryMaintenance(false);
      // Unlike drain.ts, where nothing runnable is a terminal stop, the daemon is persistent: new work can
      // land later, so it paces itself with the injected clock and keeps polling.
      await flushLifetimePressure();
      ticks++;
      log("daemon.idle", { tick: ticks, poll_interval_ms: pollIntervalMs });
      {
        // Dispatchable = queued and unmerged, less what eligibility filtered for a reason other than "already
        // merged" (which `isMerged` already removed). An estimate: it can only over-count, never hide work.
        const filteredTally = idleReasons.snapshot();
        const filtered = (Object.keys(filteredTally) as Array<keyof typeof filteredTally>).reduce(
          (n, r) => (r === "already-merged" ? n : n + filteredTally[r].count),
          0,
        );
        const queuedUnmerged = planForBatch.tasks.filter((t) => t.status === "queued" && !isMerged(t.id)).length;
        sampleIdleLane(0, true, Math.max(0, queuedUnmerged - filtered));
      }
      // Cadence: on change, not every tick. The idle row still fires every poll and is byte-compatible with
      // before. The reasons ride a separate step, emitted only when the picture actually changes — logging
      // the tally on all ~390 ticks would be 390 identical lines that bury the one that matters.
      const idleSignature = idleReasons.signature();
      if (idleSignature !== lastIdleSignature) {
        lastIdleSignature = idleSignature;
        log("daemon.idle_reasons", { tick: ticks, ...idleReasons.snapshot() });
      }

      // Queue starvation. A queue that has run OUT of dispatchable work was indistinguishable in the ledger
      // from one quietly healthy between tasks: both emitted only an idle row. Starved means zero dispatchable
      // and at least one task filtered by a recoverable class. Already-merged, verify-not-auto and retired are
      // excluded, because counting any of them would report "nothing left to do" as starvation; they stay
      // named on the census rather than dropped (W1-T2474). Forensics: docs/forensics/daemon.md.
      const idleTally = idleReasons.snapshot();
      const starvationCensus: StarvationCensus = {
        circuitBroken: bucketFromIds(circuitBrokenThisTick),
        blocked: idleTally.blocked,
        unmetDeps: idleTally["unmet-deps"],
        retired: idleTally.retired,
      };
      const starved =
        starvationCensus.circuitBroken.count > 0 ||
        starvationCensus.blocked.count > 0 ||
        starvationCensus.unmetDeps.count > 0;
      if (starved) {
        if (!starvationEscalated) {
          starvationEscalated = true;
          // Same backstop discipline as the other escalation hooks: a failed notification costs one logged
          // line, never the daemon's liveness.
          try {
            await deps.onStarvation?.(starvationCensus);
          } catch (e) {
            log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
          }
        }
      } else {
        // Nothing recoverable is blocking this tick — re-arm, so a later starvation episode escalates again
        // rather than staying silenced for the rest of this process's life.
        const wasEscalated = starvationEscalated;
        starvationEscalated = false;
        if (wasEscalated) {
          // Same backstop discipline as the `onStarvation` catch above: a failed notification
          // costs one logged line, never the daemon's liveness.
          try {
            await deps.onStarvationCleared?.({ reason: "no-recoverable-blockers" });
          } catch (e) {
            log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
          }
        }
      }

      // W1-T3618: this IS the idle branch — nothing was selected this tick, so ending the cycle
      // here trades away no forward progress and never reaches the dispatch-preserving deferral
      // below (which exists for the opposite case: a batch WAS selected). Checked here, rather
      // than only at the pre-admission boundary below, because that boundary is unreachable from
      // an idle tick (this branch always `continue`s first) — without this, a sweep's own
      // mid-pass discovery on an otherwise-idle daemon would be silently dropped every tick
      // instead of ever ending the cycle, and the entrypoint's re-sync would never run.
      // W1-T3691: gated on SUSTAINED recurrence (`staleReviewerAction.kind === "restart"`), not on
      // any single stale reading — a first sighting is ordinary and must change nothing (design iv).
      const staleReviewerIdleFreshness = requestStaleReviewerRestart();
      if (staleReviewerIdleFreshness) {
        await stopInterphaseReviewClock();
        return stopForFreshness(staleReviewerIdleFreshness);
      }
      // The ordinary zero-dispatch state also includes queue holds, failed credit reads, released
      // human tasks, and in-flight PR work. None is proof of an exhausted queue. The strict gate
      // below requires a complete PR observation and no structurally unblocked task.
      // Only a supervised dedicated instance takes this exit: the self-hosting daemon's other
      // cadences can generate work without a plan edit or a new PR.
      if (deps.idleStarvedSupervised && !sweepLiveness.inFlight && deps.confirmedOpenPrCount && deps.isCreditIndeterminate && deps.readLedgerLines) {
        try {
          const openCount = deps.confirmedOpenPrCount();
          if (openCount === 0 && !deps.pendingKicks?.().length && !deps.pendingPrActions?.().length) {
            const released = tickReleases.ids;
            const hasUnblockedTask = planForBatch.tasks.some((task) => {
              if (deps.isCreditIndeterminate!(task.id)) throw new Error(`credit unreadable: ${task.id}`);
              if (isMerged(task.id)) return false;
              try {
                assertRunnable(planForBatch, task, (dep) => isMerged(dep.id), released);
                return true;
              } catch (e) {
                if (e instanceof TaskAdmissionError) return false;
                throw e;
              }
            });
            if (!hasUnblockedTask && !(await stopInterphaseReviewClock()) &&
              !prActionPumpRef.isBusy() && !improvementActionPumpRef.isBusy() && (!plainBackfill || !plainBackfill.isBusy()) && (!recommendationBackfill || !recommendationBackfill.isBusy()) &&
              (!inboxResponder || !inboxResponder.isBusy()) &&
              !deps.pendingKicks?.().length && !deps.pendingPrActions?.().length) {
              log("daemon.idle_starved.enter", { repo: deps.targetRepo, open_prs: 0, plan_tasks: planForBatch.tasks.length });
              return summary("idle_starved", "confirmed empty PR board and no unblocked task");
            }
          }
        } catch (e) {
          log("daemon.idle_starved.unassessed", { reason: String((e as Error)?.message ?? e) });
        }
      }
      if (await stopInterphaseReviewClock()) continue;
      await sleepIdleWithReviewDemand();
      continue;
    }

    // A dispatchable task ends any starvation episode — re-arm so a LATER one escalates again.
    const starvationWasEscalated = starvationEscalated;
    starvationEscalated = false;
    if (starvationWasEscalated) {
      // Same backstop discipline as the `onStarvation` catch above: a failed notification costs
      // one logged line, never the daemon's liveness.
      try {
        await deps.onStarvationCleared?.({ reason: "dispatchable-task", taskId: dispatchSet[0]?.id });
      } catch (e) {
        log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
      }
    }

    // Re-check both operator holds immediately before admission. The top-of-tick reads happen once, but the
    // freshness check, the full reconciliation, both sweeps and the usage read all sit awaited and unbounded
    // between that read and here — measured, a hold created 4.5 minutes after the top-of-tick read still
    // dispatched (W1-T1065). Nothing has been admitted yet, so a hold observed here defers the whole
    // dispatch set and can never abort a lane already running. Forensics: docs/forensics/daemon.md.
    const workerHold = holdWorkerAdmission("dispatch");
    if (workerHold?.control === "STOP") {
      await stopInterphaseReviewClock();
      log("daemon.stop", { detail: workerHold.detail });
      return summary("stopped", workerHold.detail);
    }
    if (workerHold?.control === "PAUSE") {
      await stopInterphaseReviewClock();
      ticks++;
      log("daemon.pause", {
        tick: ticks,
        detail: workerHold.detail,
        poll_interval_ms: pollIntervalMs,
        recheck: true,
      });
      sampleIdleLane(0, false);
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }
    const restopped = deps.checkStop?.();
    if (restopped) {
      await stopInterphaseReviewClock();
      log("daemon.stop", { detail: restopped });
      return summary("stopped", restopped);
    }
    const repaused = deps.checkPause?.();
    if (repaused) {
      await stopInterphaseReviewClock();
      ticks++;
      log("daemon.pause", {
        tick: ticks,
        detail: repaused,
        poll_interval_ms: pollIntervalMs,
        recheck: true,
      });
      sampleIdleLane(0, false);
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }

    // Awaited reconciliation rungs (incl. auto-merge) can make the top-of-tick freshness result stale
    // before admission; re-read here, after both operator controls. Exit only if nothing was selected —
    // an unconditional exit fires on the tick's own auto-merge and starves dispatch (W1-T2960).
    //
    // W1-T3618: a mid-pass reviewer-code freshness discovery reaches this SAME check — never a second,
    // independently-gated exit — because `deps.checkFreshness` (this process's own boot sha vs
    // origin/main) and the sweep's reviewer-code read answer the same underlying question by a
    // different route, and only one of the two can ever have run this tick's sweep in time to see it.
    // Self-freshness wins when both are stale (it already carries `installNeeded`); the sweep's
    // reading is used only when self-freshness itself did not already fire.
    // W1-T3691: the reviewer-code half is gated on sustained recurrence — `reviewerCodeStale`
    // below is undefined outside `staleReviewerAction.kind === "restart"`, so a first sighting or
    // a held repeat changes nothing about this re-check. The `restartRequested` commit itself
    // happens ONLY from the idle branch's own `requestStaleReviewerRestart()` call above: reaching
    // this line at all already proves `dispatchSet.length > 0` (the idle branch above is
    // exhaustive — every path through it `continue`s or `return`s — so a tick that reached here
    // never took it), which makes this branch's own `dispatchSet.length === 0` conjunct always
    // false. `reviewerCodeStale` is still computed here because `refetchedFreshness` (and the
    // `daemon.freshness_deferred` log below, which IS reached) reads it.
    const selfFreshnessRead = checkFreshness?.();
    const freshnessReadsAsync = isPendingFreshness(selfFreshnessRead);
    const selfFreshness = isPendingFreshness(selfFreshnessRead) ? await selfFreshnessRead : selfFreshnessRead;
    logNotStaleFreshness(selfFreshness);
    const reviewerCodeStale = tickStaleReviewerAction.kind === "restart" ? sweepCycleOutcome?.reviewerCodeStale : undefined;
    const refetchedFreshness: DaemonFreshness | undefined =
      selfFreshness?.stale || !reviewerCodeStale
        ? selfFreshness
        : { stale: true, oldSha: reviewerCodeStale.oldSha, newSha: reviewerCodeStale.newSha };
    if (refetchedFreshness?.stale && dispatchSet.length === 0) {
      // This is the only freshness boundary reached while the interphase review clock exists. Close
      // admission before the shared final pass; do not move the drain into the clock itself, where W1-T2744
      // proved it can freeze ordinary phase transitions (W1-T2865). The drain runs its own review-only clock
      // beside it (W1-T4053).
      await stopInterphaseReviewClock();
      return stopForFreshness(refetchedFreshness);
    }
    if (refetchedFreshness?.stale) {
      log("daemon.freshness_deferred", {
        old_sha: refetchedFreshness.oldSha,
        new_sha: refetchedFreshness.newSha,
        admitting: dispatchSet.length,
      });
    }

    // The per-lane governor gate, adopted verbatim from `runDrainLanes`. A sequential loop taking its own
    // fresh reading per candidate — never one reading admitting the whole batch — so a ceiling crossed
    // between lanes refuses the later one without touching the earlier: the break stops ADMITTING and
    // never revokes a lane already admitted. At one candidate this runs exactly once (W1-T342, W1-T343).
    const admitted: Task[] = [];
    let deferredVerdict: DispatchGovernorVerdict | undefined;
    for (const t of dispatchSet) {
      if (hasChildTask(t.id)) { admitted.push(t); continue; }
      const verdict = checkDispatchGovernors(deps, dailyCostCeilingUsd);
      if (verdict) {
        deferredVerdict = verdict;
        if (dispatchSet.length > 1) {
          // A distinct step from the batch-sizing row above, which fires before any candidate is selected: this
          // is a governor refusing admission mid-batch, after some lanes already got in. Never logged at one
          // lane, where a solo deferral has its own line below.
          log("dispatch.lane_governed", {
            task: t.id,
            admitted: admitted.length,
            of: dispatchSet.length,
            lane_count: laneCount,
          });
        }
        break;
      }
      admitted.push(t);
    }
    if (admitted.length === 0) {
      noteBootFirstDispatch({ heldReason: `governor:${deferredVerdict!.kind}` });
      await flushLifetimePressure();
      ticks++;
      logDispatchGovernorDefer(deferredVerdict!, ticks);
      sampleIdleLane(0, true, dispatchSet.length);
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }

    // The light-sweep ticker: while admitted lanes are unbounded and in flight, tick the restricted light
    // pass on the same injected clock idle polling uses, so a PR that goes green-but-review-absent
    // mid-batch re-posts within one poll interval instead of sitting invisible until every lane returns
    // (W1-T254). Cleared once every lane settles, on every exit path, and never aborted mid-call. It also
    // emits this dispatch's liveness rows — see {@link startInFlightTicker}.
        // W1-T2984 — STOP THE CLOCK, BUT NEVER THROW AWAY AN ADMITTED BATCH. This read
        // `if (await stopInterphaseReviewClock()) continue;`, so a GitHub event wake consumed
        // anywhere in this tick discarded work ALREADY selected and already logged
        // `daemon.iteration` — before `runOne` was ever called. MEASURED 2026-09-06: two
        // consecutive ticks logged `dispatch.concurrent_set [W1-T2655, W1-T2673]` and
        // `daemon.iteration` for both, then `cost: notional $0.0000`, no `run.start`, and no
        // worktree for either task. `github.wake.accepted` fired 77 times in five minutes, so a
        // wake lands in essentially every tick and dispatch starves while looking healthy.
        // Same shape as W1-T2960's freshness re-check and W1-T2981's retro rung: an interrupt
        // evaluated AFTER selection, discarding the selection. The clock is still stopped — the
        // ticker below must own it — but the batch is dispatched and the wake is honoured at the
        // NEXT tick boundary. Every worker is cut a fresh worktree from origin/main HEAD anyway.
        const interphaseWakeSeen = await stopInterphaseReviewClock();
        if (interphaseWakeSeen) log("daemon.dispatch.wake_deferred", { tasks: admitted.map((t) => t.id) });
    // Concurrent dispatch: settle-all, never fail-fast, so a sibling lane's rejection can never abort another lane
    // in flight, and every lane's outcome is recorded before this tick decides anything (W1-T343). W1-T4416: a lane
    // that frees while a sibling runs refills from a FRESH read through the same gates; one lane never refills.
    const dispatchPhaseStartedAtMs = daemonClock.now();
    // Freeze the estimate for this phase: its own slow run cannot inflate its comparison population.
    const refillBoundMs = runLengths.samples > 0 ? runLengths.totalMs / runLengths.samples : DISPATCH_PHASE_REFILL_BOUND_MS;
    const measuredRefillBound = runLengths.samples > 0;
    log("dispatch.refill_bound", { bound_ms: refillBoundMs, samples: runLengths.samples,
      source: measuredRefillBound ? "observed_runs" : "no_history_fallback" });
    const snapshots: Array<{ plan: Plan; isMerged: MergedSet }> = [];
    // Prepared before admission; not an accepted attempt or an in-flight ownership slot.
    const preparedStartTimes = new Map<string, number>();
    const passIds = new Set<string>();
    const inFlightTasks = new Set<Task>();
    const refillAdmissions = new WeakMap<Task, {
      snapshot: { plan: Plan; isMerged: MergedSet }; finishedTaskId: string;
      eligible: Task[]; context: DispatchValueContext | undefined;
    }>();
    // A promised handoff owns only its proposal, never an attempt or active-worker slot.
    // Other freed lanes must not choose its ID/scope before the pool accepts it.
    const refillProposals = new Set<Task>();
    let newBuildHeld = false;
    let refillClosed: string | undefined;
    // W1-T9089 (ADR 0007 A.10): a restart decided mid-phase is no latch. A child run keeps running for the next boot to
    // adopt, a refill is taken only when it runs as a child, and an in-process lane is awaited, never asked to yield.
    let restartDecided: Extract<DaemonFreshness, { stale: true }> | undefined;
    const restartWait = { decidedAtMs: 0 };
    const laneStartedAtMs = new Map<string, number>();
    laneElapsedMs = (taskId) => {
      const startedAt = laneStartedAtMs.get(taskId);
      return startedAt === undefined ? undefined : Math.max(0, daemonClock.now() - startedAt);
    };
    const admittedAfterRestart = new Set<string>();
    const slowLane = (t: Task): boolean => measuredRefillBound && daemonClock.now() - laneStartedAtMs.get(t.id)! > refillBoundMs;
    // Re-read at every decision, never latched: a refilled sibling can outlive the measured length AFTER a lane freed.
    const phaseBoundHolds = (): boolean => !restartDecided && daemonClock.now() - dispatchPhaseStartedAtMs > refillBoundMs &&
      ![...inFlightTasks].some(slowLane);
    let releaseChildren: (() => void) | undefined;
    const decideRestart = (freshness: Extract<DaemonFreshness, { stale: true }>): void => {
      if (!restartDecided) {
        restartDecided = freshness;
        restartWait.decidedAtMs = daemonClock.now();
        beginLatchDrain(restartWait.decidedAtMs);
      }
      if (childMode) releaseChildren?.();
    };
    // W1-T9924: whether a refill runs as an adoptable child; unwired, it reads false.
    const runsAsChild = (t: Task): boolean => deps.refillRunsAsChild?.(t) === true;
    // W1-T5282: a lane's refill is synchronous and cannot await a fetch, so with an awaited reader it reads the
    // latest reading settled since this tick began: the admission read above, then each dispatch tick's.
    let settledFreshness = selfFreshness;
    // 2026-10-10 19:38: both freed lanes were held for good while the lane that later held the phase was 5 min old.
    // A measured bound parks such a lane instead; a dispatch tick or a sibling's finish re-decides it.
    const parkedLanes: Array<{ lane: number; finished: Task; wake: (next: Promise<Task | undefined>) => void }> = [];
    const governorParked = new Map<number, string>();
    const wakeParkedLanes = (): void => {
      if (inFlightTasks.size > 0 && !refillClosed && phaseBoundHolds()) return;
      const waking = parkedLanes.splice(0, parkedLanes.length);
      // Deferred: a throwing decision reaches the pool's fault outcome, never strands an owned sibling.
      for (const { lane, finished, wake } of waking) wake(Promise.resolve().then(() => decideRefill(lane, finished)));
    };
    // W1-T10000: a run whose child did not start is in-process work again. One admitted as a child after the restart was
    // decided would hold the exit it skipped, so it ends its lane instead; any other run stays in-process and is awaited.
    const judgeChildFallback = (task: Task, fallbackReason: string): boolean => {
      pendingChildren.delete(task.id);
      if (!restartDecided || !admittedAfterRestart.has(task.id)) return true;
      log("daemon.admission_held", { surface: "dispatch-refill", kind: "dispatch-refill", reason: "restart decided",
        task: task.id, runs_as_child: true, fallback_reason: fallbackReason });
      return false;
    };
    // W1-T8235: a lane change is a sample. The hold that emptied the slot is whichever step this lane's decision wrote.
    const sampleLaneChange = (): void => sampleIdleLane(inFlightTasks.size, true, undefined, false);
    const refillLane = (lane: number, finished: Task, outcome: PromiseSettledResult<RunResult>): Task | undefined | Promise<Task | undefined> => {
      inFlightTasks.delete(finished);
      pendingChildren.delete(finished.id);
      const child = batchChildren.get(finished);
      if (child) children.delete(child.runId);
      resetIdleLaneTick();
      if (outcome.status === "rejected") {
        // W1-T5083: a lane-local rejection (the settle loop logs it and the pass continues) never closes refill.
        const outsideKill = runChildOutsideKill(outcome.reason);
        // W1-T10001: a child lost to a container stop or OOM kill ends only its lane, and its task is offered again.
        if (outsideKill !== undefined) passIds.delete(finished.id);
        if (outsideKill === undefined && !(outcome.reason instanceof TaskAdmissionError) && !refillLaneLocalRejection(outcome.reason)) {
          // W1-T9680: a credential refusal closes refill only once the fleet credential probe does not read alive.
          if (laneCredentialRefusal(outcome.reason) !== undefined) {
            return fleetCredentialFor(outcome.reason as object).then((probe) => {
              if (probe.state !== "alive") refillClosed ??= "a lane rejected";
              const decision = decideRefill(lane, finished);
              wakeParkedLanes();
              return decision;
            });
          }
          refillClosed ??= "a lane rejected";
        }
      }
      // W1-T4662: `handed_off` (a healthy freshness yield) deliberately does NOT match here — only
      // a genuine, repeated `blocked_transient` API failure closes this lane's refill.
      else if (outcome.value.verdict === "blocked_transient") refillClosed ??= "blocked_transient";
      const decision = decideRefill(lane, finished);
      wakeParkedLanes();
      return decision;
    };
    const decideRefill = (lane: number, finished: Task): Task | undefined | Promise<Task | undefined> => {
      const phaseAgeMs = daemonClock.now() - dispatchPhaseStartedAtMs;
      const phaseBound = !refillClosed && phaseBoundHolds() ? "phase bound" : undefined;
      // With no history no sibling can ever read slow, so parking could only end as a hold: hold now (W1-T5761).
      if (phaseBound && measuredRefillBound && inFlightTasks.size > 0) {
        log("dispatch.lane_parked", { lane, finished_task: finished.id, reason: phaseBound, phase_age_ms: phaseAgeMs,
          refill_bound_ms: refillBoundMs, waiting_on: [...inFlightTasks].map((t) => t.id) });
        sampleLaneChange();
        governorParked.delete(lane);
        return new Promise<Task | undefined>((wake) => parkedLanes.push({ lane, finished, wake }));
      }
      const governed = refillClosed || phaseBound ? undefined : checkDispatchGovernors(deps, dailyCostCeilingUsd);
      const memoryPressure = governed?.kind === "queue" && governed.result.measuredBound === 0
        ? governed.result.pressure : undefined;
      const governorReason = memoryPressure
        ? `governor: memory ${memoryPressure.tier} (${memoryPressure.binding}): ${memoryPressure.availableMib} MiB available, floor ${memoryPressure.floorMib} MiB`
        : governed ? `governor: ${governed.kind}` : undefined;
      const stopped = deps.checkStop?.();
      const paused = deps.checkPause?.();
      // W1-T5083: the same restart decision the top of tick asks; a sibling in flight makes it busy.
      const freshness = refillClosed || phaseBound ? undefined : freshnessReadsAsync ? settledFreshness : (checkFreshness?.() as DaemonFreshness | undefined);
      if (!freshnessReadsAsync) logNotStaleFreshness(freshness);
      const freshnessAction = freshness?.stale ? decideFreshness(freshness, true) : undefined;
      // W1-T9089: a restart decided here holds only the refills that would not run as a child.
      if (freshnessAction === "restart" && freshness?.stale) decideRestart(freshness);
      let reason =
        refillClosed ??
        phaseBound ??
        (opts.max !== undefined && attempted.length >= opts.max ? "max reached" : undefined) ??
        holdWorkerAdmission("lane-refill")?.reason ??
        (stopped ? `stop: ${stopped}` : undefined) ??
        (paused ? `pause: ${paused}` : undefined) ??
        governorReason ??
        (enforcedLaneTarget(inFlightTasks.size, deps.readQueueAdmission?.()?.wipLimit) <= inFlightTasks.size ? "lane target" : undefined);
      // 2026-10-12 09:00: one container-short WIP reading held lane 2 for good while two siblings ran on past the hour.
      // A governor reading is re-taken each tick, so a lane it holds parks; one row per lane and reason, not per tick.
      if (governed && reason !== undefined && reason === governorReason && inFlightTasks.size > 0) {
        if (governorParked.get(lane) !== reason) log("dispatch.lane_parked", { lane, finished_task: finished.id, reason,
          phase_age_ms: phaseAgeMs, waiting_on: [...inFlightTasks].map((t) => t.id) });
        sampleLaneChange();
        governorParked.set(lane, reason);
        return new Promise<Task | undefined>((wake) => parkedLanes.push({ lane, finished, wake }));
      }
      governorParked.delete(lane);
      // W1-T5805: the refill decides on its OWN branch read, never the tick's: a branch pushed since the
      // tick began must refuse its task here. A failed read decides on the tick-start reading instead.
      const chooseRefill = (runBranchListing: string | undefined): Task | undefined | Promise<Task | undefined> => {
        let next: Task | undefined;
        let heldForRestart = false;
        const refillDeferrals: PriorityDeferral[] = [];
        let nextSnapshot: { plan: Plan; isMerged: MergedSet } | undefined;
        let refillEligible: Task[] = [];
        let refillContext: DispatchValueContext | undefined;
        const decide = (snapshot: { plan: Plan; isMerged: MergedSet }): void => {
          const budget = laneDispatchBudget({
            laneCount, wipLimit: opts.wipLimit, openPrCount: deps.openPrCount?.(), queueAdmission: deps.readQueueAdmission?.(),
          });
          const runBranchState = runBranchStateFrom(
            runBranchListing, withRequeueReceipts(deps.readOrphanRunBranchEvidence?.(), deps.readLedgerLines), resumableHandoffs,
            lazyClosedUnmerged(deps.readClosedRunBranchPrs),
          );
          const selection = captureDispatchFrontier(snapshot.plan, {
            ...dispatchOpts,
            ...runBranchDispatchOpts(runBranchState, planOnlyReceiptsThisTick, log),
            dispatchValueContext: deps.buildDispatchValueContext?.(snapshot.plan, snapshot.isMerged),
            // Re-read at each refill: a lane that settled since the tick began may have written or spent a receipt.
            resumableTaskIds: new Set(resumableHandoffs.keys()),
            excludeIds: new Set([...(dispatchOpts.excludeIds ?? []), ...pendingMergedCredit, ...passIds,
              ...[...refillProposals].map((proposal) => proposal.id)]),
            // W1-T8502: pack the pool disjoint from the occupied lanes too, so a head they block cannot crowd out the rest.
            inFlight: [...inFlightTasks, ...refillProposals],
            onPassedOver: observePassedOver("lane-refill"),
            onDeferredForPriority: (d) => { refillDeferrals.push(d); logPriorityDeferral(d); },
          });
          const pool = runnableCandidates(snapshot.plan, snapshot.isMerged, budget > inFlightTasks.size ? laneCount : 0, selection.opts);
          forgetPassedOver(snapshot.plan, pool);
          refillEligible = selection.eligible;
          refillContext = selection.context;
          const fits = partitionByFileOverlap([...inFlightTasks, ...refillProposals, ...pool], deps.observedByTask ?? NO_OBSERVED_SCOPE);
          // The same row the tick path writes, for pool tasks only: an occupied lane's own deferral is not a refill's.
          const poolIds = new Set(pool.map((t) => t.id));
          for (const d of fits.serialized) if (poolIds.has(d.task)) log("dispatch.serialized", serializedLedgerPayload(d));
          const candidates = fits.dispatch.filter((t) => !inFlightTasks.has(t) && !refillProposals.has(t));
          if (restartDecided && !refillClosed) {
            next = candidates.find(runsAsChild);
            heldForRestart = !next && candidates.length > 0;
          } else next = candidates[0];
          if (next) nextSnapshot = snapshot;
        };
        const readFailed = (e: unknown): void => {
          reason = `refill read failed: ${String((e as Error)?.message ?? e)}`;
        };
        const conclude = (): Task | undefined | Promise<Task | undefined> => {
          // W1-T6274: the reads above are awaited; a restart, stop or pause decided meanwhile still holds the lane.
          if (next) {
            const latched = refillClosed ?? (restartDecided && !runsAsChild(next) ? "stale code" : undefined) ??
              (deps.checkStop?.() ? "stop" : undefined) ?? (deps.checkPause?.() ? "pause" : undefined);
            if (latched !== undefined) {
              reason = `${latched} (decided while the refill read was in flight)`;
              next = undefined;
            }
          }
          if (!next) {
            log("dispatch.lane_refill_held", {
              lane,
              finished_task: finished.id,
              reason: reason ?? (heldForRestart ? "stale code: no candidate runs as a child" : refillDeferrals.length > 0
                ? `priority reservation: ${refillDeferrals.map((d) => `${d.task.id} deferred for waiting ${d.waiting.id}`).join(", ")}`
                : "no disjoint runnable task within the lane budget"),
              ...(reason === "phase bound" ? { phase_age_ms: phaseAgeMs, ...(measuredRefillBound ? { refill_bound_ms: refillBoundMs } : {}) } : {}),
              ...(freshnessAction ? { freshness_action: freshnessAction } : {}),
            });
            sampleLaneChange();
            return undefined;
          }
          // A promised refill still crosses the pool's handoff before it actually starts. No
          // attempt/snapshot/overlap slot is committed here. Give concurrent decisions distinct keys.
          const candidate = { ...next };
          refillAdmissions.set(candidate, { snapshot: nextSnapshot!, finishedTaskId: finished.id,
            eligible: refillEligible, context: refillContext });
          refillProposals.add(candidate);
          return candidate;
        };
        const decideFromPlan = (): Task | undefined | Promise<Task | undefined> => {
          try {
            const refillPlan = plan;
            // W1-T5846: with the async port wired the merged set is read through it, never `refreshMerged`, whose
            // stale-generation fallback (W1-T5762) is a synchronous live read on the event loop. Only a deps
            // object that supplies no async port keeps the synchronous read, and its refill stays synchronous.
            if (deps.refreshMergedAsync) {
              return deps.refreshMergedAsync(refillPlan).then(
                (isMerged) => {
                  try { decide({ plan: refillPlan, isMerged }); } catch (e) { /* the failure is carried as the held reason */ readFailed(e); }
                  return conclude();
                },
                (e) => { readFailed(e); return conclude(); },
              );
            }
            decide({ plan: refillPlan, isMerged: deps.refreshMerged(refillPlan) });
          } catch (e) {
            // the failure is carried as the held reason, logged by `dispatch.lane_refill_held`
            readFailed(e);
          }
          return conclude();
        };
        if (reason !== undefined) return conclude();
        // W1-T7743: the reload is awaited (its git runs off the loop); a deps object with no reloader stays synchronous.
        return deps.reloadPlan ? reloadPlanBinding().then(decideFromPlan) : decideFromPlan();
      };
      const runBranchRead = reason === undefined ? readRunBranchesFor("lane-refill", tickRunBranchListing) : undefined;
      return runBranchRead instanceof Promise ? runBranchRead.then(chooseRefill) : chooseRefill(runBranchRead);
    };
    // W1-T5308: a restart decided while lanes run is read on the dispatch tick; it releases child lanes, never yields one.
    const actOnDispatchFreshness = (freshness: DaemonFreshness): void => {
      settledFreshness = freshness;
      logNotStaleFreshness(freshness);
      if (freshness.stale && decideFreshness(freshness, true) === "restart") decideRestart(freshness);
      wakeParkedLanes();
    };
    const onDispatchTick = checkFreshness || (deps.reloadPlan && deps.sweepLight) ? (): void | Promise<void> => {
      wakeParkedLanes();
      if (inFlightTasks.size === 0 || deps.checkPause?.()) return;
      // The light sweep reads this live binding; admitted workers retain their captured planForBatch.
      const reload = (): void | Promise<void> => deps.reloadPlan ? reloadPlanBinding() : undefined;
      if (restartDecided || !checkFreshness) return reload();
      const read = checkFreshness();
      if (!isPendingFreshness(read)) {
        actOnDispatchFreshness(read);
        return reload();
      }
      // Refresh after the freshness fetch, so a newly observed origin/main also updates review contracts.
      return read.then((freshness) => {
        if (!restartDecided && inFlightTasks.size > 0) actOnDispatchFreshness(freshness);
      }).then(reload);
    } : undefined;
    sweepRetrigger.onDispatchTick = onDispatchTick;
    const lanes = { inFlight: 0 };
    sweepRetrigger.lanesInFlight = () => lanes.inFlight;
    const stopTicker = startInFlightTicker(deps, pollIntervalMs, log, "dispatch", diskHeadroomLatch, sweepRetrigger, headroomSampler).stop;
    const admitAtStart = (task: Task, lane: number, isRefill: boolean): boolean => {
      const refill = isRefill ? refillAdmissions.get(task) : undefined;
      if (isRefill) {
        refillProposals.delete(task);
        // Concurrent proposals cannot spend the same task, overlap, max or WIP slot at handoff.
        // A throwing reader/logger is a pool fault, not a success-shaped refusal.
        const budget = laneDispatchBudget({
          laneCount, wipLimit: opts.wipLimit, openPrCount: deps.openPrCount?.(), queueAdmission: deps.readQueueAdmission?.(),
        });
        const reason = refillClosed ??
          (restartDecided && !runsAsChild(task) ? "stale code" : undefined) ??
          (deps.checkStop?.() ? "stop" : undefined) ?? (deps.checkPause?.() ? "pause" : undefined) ??
          (!refill ? "missing refill snapshot" : undefined) ??
          (passIds.has(task.id) ? "already dispatched this phase" : undefined) ??
          (opts.max !== undefined && attempted.length >= opts.max ? "max reached" : undefined) ??
          (budget <= inFlightTasks.size ? "lane budget" : undefined) ??
          (enforcedLaneTarget(inFlightTasks.size, deps.readQueueAdmission?.()?.wipLimit) <= inFlightTasks.size ? "lane target" : undefined) ??
          (!partitionByFileOverlap([...inFlightTasks, task], deps.observedByTask ?? NO_OBSERVED_SCOPE).dispatch.includes(task)
            ? "file overlap at start" : undefined);
        if (reason !== undefined) {
          log("dispatch.lane_refill_held", { lane, finished_task: refill?.finishedTaskId, reason });
          sampleLaneChange();
          return false;
        }
      }
      const rejoin = deps.categorizedRefusalRejoinFor?.(task.id);
      if (rejoin && !rejoin.receiptRecorded) {
        // A corrected refusal's durable RE-OFFER reason precedes run.start. It is not an
        // accepted attempt: only a later real run.start spends this source's opportunity.
        // Avoid writing for an already-held task, then re-read AFTER the fallible receipt.
        const beforeReceipt = checkNewBuildReservation(deps, task);
        if (beforeReceipt) {
          newBuildHeld = true;
          const fields = { task: task.id, lane, ...newBuildReservationPayload(beforeReceipt) };
          log("dispatch.new_build_held", fields);
          if (isRefill) log("dispatch.lane_refill_held", { ...fields, finished_task: refill!.finishedTaskId });
          if (isRefill) sampleLaneChange();
          return false;
        }
        log("dispatch.harness_commit_retry", {
          task_id: task.id,
          original_run_id: rejoin.sourceRunId,
          original_verdict: "no_pr",
          original_refusal: "categorized_worker_refusal",
          refused_contract_revision: rejoin.refusedContractRevision,
          contract_revision: rejoin.contractRevision,
          reason: "categorized refusal contract changed",
          admission_stage: "contract_reoffer",
        });
      }
      const startedAtMs = daemonClock.now();
      // Last admission read: no await or fallible logging between this decision and runOne.
      const reservation = checkNewBuildReservation(deps, task);
      if (reservation) {
        newBuildHeld = true;
        const fields = { task: task.id, lane, ...newBuildReservationPayload(reservation) };
        log("dispatch.new_build_held", fields);
        if (isRefill) log("dispatch.lane_refill_held", { ...fields, finished_task: refill!.finishedTaskId });
        if (isRefill) sampleLaneChange();
        return false;
      }
      preparedStartTimes.set(task.id, startedAtMs);
      return true;
    };
    const onStarted = (task: Task, lane: number, isRefill: boolean): void => {
      const refill = isRefill ? refillAdmissions.get(task) : undefined;
      // Commit ALL accepted-only accounting before any external callback can throw. The pool
      // already owns this worker, so even a failed log/clearKick cannot erase an actual attempt.
      snapshots.push(refill?.snapshot ?? { plan: planForBatch, isMerged });
      passIds.add(task.id);
      inFlightTasks.add(task);
      const startedAtMs = preparedStartTimes.get(task.id) ?? daemonClock.now();
      if (restartDecided) admittedAfterRestart.add(task.id);
      laneStartedAtMs.set(task.id, startedAtMs);
      if (poolControl.occupied?.has(task)) return;
      attempted.push(task.id);
      noteBootFirstDispatch({ startedAtMs: daemonClock.now(), admitted: admitted.length });
      if (forcedKick?.taskId === task.id) {
        const kick = forcedKick;
        deps.clearKick?.(task.id, kick.repo);
        forcedKick = undefined;
        log("console.kick_dispatched", { task: task.id, origin: kick.origin, ...kickRepoField(kick) });
      }
      if (isRefill) log("dispatch.lane_refilled", { lane, finished_task: refill!.finishedTaskId, next_task: task.id,
        ...(restartDecided ? { restart_decided: true } : {}) });
      if (isRefill) log("dispatch.pick_scored", dispatchPickPayload(task, "lane-refill", refill!.eligible, refill!.context,
        [task], [...inFlightTasks].filter(t => t !== task), deps.observedByTask ?? NO_OBSERVED_SCOPE));
      log("daemon.iteration", { task: task.id, attempted: attempted.length, max: opts.max ?? null,
        ...(resumableHandoffs.has(task.id) ? { resumes_handoff: resumableHandoffs.get(task.id)!.branch } : {}) });
      // The first wave is sampled once, by the tick (below): a refill is the lane change.
      if (isRefill) sampleLaneChange();
    };
    const batchChildren = new Map(occupiedChildren);
    const poolControl: LanePoolControl<RunResult> = { occupied: new Map([...occupiedChildren].map(([task, child]) => [task, child.settled])) };
    let childDrain: Promise<void> | undefined;
    let childDrainDone = false;
    releaseChildren = () => {
      preparedFreshnessExit ??= prepareFreshnessExit(restartDecided!, restartWait.decidedAtMs);
      childDrain ??= preparedFreshnessExit.then(async () => {
        await stopTicker();
        await drainBeforeRestart("daemon.freshness_drain");
        childDrainDone = true;
        poolControl.detach?.(outOfProcess);
      }).catch((reason: unknown) => {
        phaseFaults.push({ phase: "freshness_drain", reason: reason });
        childDrainDone = true;
        poolControl.close?.(reason, "freshness_drain");
        poolControl.detach?.(outOfProcess);
      });
    };
    // Only these named phase boundaries are contained. Other logging keeps its existing contract.
    const phaseFaults: Array<{ phase: string; reason: unknown }> = [];
    const admittedWork = runLanePool(admitted, (id, task) => {
      const startedAtMs = preparedStartTimes.get(id)!;
      // Preserve the current worker-boundary handoff; a reservation never preempts it.
      return deps.runOne(id, { onChild: (child) => {
        childMode = true;
        children.set(child.runId, { ...child, taskId: id });
        batchChildren.set(task, child);
        pendingChildren.delete(id);
        if (restartDecided) releaseChildren?.();
        if (childDrainDone) poolControl.detach?.(outOfProcess);
      }, onChildPending: (pending) => {
        childMode = true;
        pendingChildren.set(id, { ...pending, sinceMs: daemonClock.now() });
        if (restartDecided) releaseChildren?.();
        if (childDrainDone) poolControl.detach?.(outOfProcess);
      }, mayRunInProcess: (reason) => judgeChildFallback(task, reason) }).then((outcome) => {
        const length = daemonClock.now() - startedAtMs;
        if (length > 0) { runLengths.totalMs += length; runLengths.samples++; measuredRuns.push({ taskId: id, ms: length }); }
        return outcome;
      });
    }, refillLane, lanes, admitAtStart, onStarted, poolControl);
    let poolOutcome: LanePoolOutcome<Task, RunResult>;
    try {
      let phase = "dispatch.concurrent_set";
      try {
        const tickStarted = admitted.filter(t => !occupiedChildren.has(t));
        for (const task of tickStarted) log("dispatch.pick_scored", dispatchPickPayload(task, "tick", tickEligible,
          tickContext, tickStarted, occupiedTasks, deps.observedByTask ?? NO_OBSERVED_SCOPE));
        if (dispatchSet.length > 1 && admitted.length > 0) {
          log("dispatch.concurrent_set", { tasks: admitted.map((t) => t.id), lane_count: laneCount });
        }
        phase = "dispatch.sample_idle_lane";
        sampleIdleLane(lanes.inFlight, true, dispatchSet.length);
        phase = "dispatch.repository_maintenance";
        scheduleRepositoryMaintenance(true, () => lanes.inFlight);
      } catch (reason) {
        phaseFaults.push({ phase, reason });
        // Retire proposals immediately, while keeping every actual worker and its handlers.
        poolControl.close!(reason, phase);
      } finally {
        // Even a phase-level logging failure cannot abandon promises the pool already owns.
        poolOutcome = await admittedWork;
        // W1-T9089: the lanes phase is the wait from a mid-phase decision until the pool settled or detached its children.
        if (restartDecided) freshnessPhases.lanes = Math.max(0, daemonClock.now() - restartWait.decidedAtMs);
        // W1-T10000: the pool released every run waiting for its child's admission; the restart abandons each wait.
        const abandoning = [...pendingChildren.values()];
        pendingChildren.clear();
        await Promise.allSettled(abandoning.map((pending) => pending.abort()));
      }
      try { log("dispatch.settled_set", settledSetPayload(admitted, poolOutcome.settled, laneCount)); }
      catch (reason) { phaseFaults.push({ phase: "dispatch.settled_set", reason: reason }); }
    } finally {
      repositoryMaintenanceQueueBusy = false;
      await stopTicker();
    }
    const reporting = createSettlementReporting();
    try {
    const settled = poolOutcome.settled;
    await flushLifetimePressure(reporting.report);
    if (!childMode || !restartDecided) restartInterphaseReviewClock();
    if (admitted.length === 0 && newBuildHeld && poolOutcome.fault === undefined && phaseFaults.length === 0) {
      // Persistent hold is an in-process, paced NEW-build deferral, never a failure/STOP.
      // A new tick owns a new clock. Retire this one before continuing, preserving
      // any event wake instead of leaving its runner live after the hold releases.
      if (await stopInterphaseReviewClock()) continue;
      ticks++;
      sampleIdleLane(0, true, dispatchSet.length);
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }
    // Lanes are back to empty here; whatever holds them empty from now on is named by the next tick's sample,
    // and an interval nothing names is reported as unknown rather than absorbed.
    resetIdleLaneTick();
    try { sampleIdleLane(0, false); }
    catch (reason) { phaseFaults.push({ phase: "dispatch.sample_idle_lane", reason: reason }); }

    // Classify every lane's settlement before this tick decides anything, mirroring `runDrainLanes`.
    // A positively transient gh transport failure and a spawn-infra failure degrade into their bounded
    // backoffs; every other throw stays fatal. A normal settlement enters the existing block reasoning.
    let fatalError: { taskId: string; message: string } | undefined;
    let spawnInfraSeenThisTick = false;
    let dispatchTransportSeenThisTick = false;
    const toProcess: Array<{ task: Task; result: RunResult; snapshot: (typeof snapshots)[number] }> = [];
    const classifyRejection = async (t: Task, err: unknown, phase?: NonNullable<typeof poolOutcome.fault>["phase"]): Promise<{ taskId: string; message: string } | undefined> => {
        // Only reporting throws are contained; the original classification still governs.
        if (err instanceof TaskAdmissionError) {
          invalidatedAdmissionsThisRun.add(t.id);
          const rawReason = String(err.message).replace(/[\r\n\t]+/g, " ");
          const reason = rawReason.length <= 240 ? rawReason : `${rawReason.slice(0, 239)}…`;
          reporting.report("daemon.admission_stood_down", { task: t.id, reason });
          return;
        }
        // W1-T10001: an outside kill took the child, not the contract; it ends this lane only and the pass goes on.
        const outsideKill = runChildOutsideKill(err);
        if (outsideKill !== undefined) {
          reporting.report("daemon.lane_lost", { task: t.id, loss: outsideKill, reason: String((err as Error).message).slice(0, 240) });
          return;
        }
        const transientTransport = transientGhDispatchFailure(err);
        const spawnInfra = isSpawnInfraBlocked(err);
        // W1-T4466: a failed GitHub READ inside one lane ends only that lane — named and logged,
        // the PASS continues — instead of reaching `fatalError` below. Checked only once transient/
        // spawn-infra are ruled out, so it never shadows their own richer handling (backoff,
        // escalation) — e.g. the SAME check-runs endpoint failing on a RATE LIMIT still takes the
        // transient path's bounded backoff, not this one. Scoped to the KNOWN read endpoints the
        // rationale's two pass-ending errors actually named (`commits/<sha>/check-runs`,
        // `commits/<sha>/status`) rather than "no --method", which would also swallow the bare
        // `gh api repos/.../pulls` auth/rate-limit fixtures the fatal path already covers
        // (test/daemon.test.ts "W1-T3165 ... remain fatal"). A WRITE failure — a create, a merge, a
        // comment — keeps today's fatal behaviour unchanged (design iii).
        const ghRead = !spawnInfra && transientTransport === undefined ? ghLaneReadFailure(err) : undefined;
        // W1-T5344: ONE TASK'S DELIVERY FAILURE ENDS ITS LANE, NOT THE DAEMON. A spawned command's
        // `Command failed: ` (a pre-push or commit-hook refusal, a PR-create 422 — the shape
        // PER_TASK_FAILURE_RE already called per-task at exit) or a PrOpenRefusedError ended the whole
        // process: 53 avoidable boots in 8 days, the same task re-dispatched by each next boot. Checked
        // after the transient/spawn-infra/read arms so it never shadows their richer handling; an
        // unprefixed throw (rmd's own TypeError) still reaches `fatalError` and still exits 1.
        const delivery =
          !spawnInfra && transientTransport === undefined && ghRead === undefined ? laneDeliveryFailure(err) : undefined;
        const parkLane = (failureClass: string, firstLine: string, extra: Record<string, unknown> = {}): void => {
          const prior = laneDeliveryParks.get(t.id);
          const revision = preDispatchContractRevision(t);
          const consecutive = prior !== undefined && prior.revision === revision ? prior.consecutive + 1 : 1;
          const backoffMs = laneDeliveryBackoffMs(consecutive);
          const parkedUntilMs = daemonClock.now() + backoffMs;
          laneDeliveryParks.set(t.id, { consecutive, parkedUntilMs, revision });
          reporting.report("daemon.lane_failed", {
            task: t.id,
            class: failureClass,
            error: firstLine,
            consecutive,
            backoff_ms: backoffMs,
            parked_until_ms: parkedUntilMs,
            revision,
            ...extra,
          });
        };
        if (delivery !== undefined) {
          parkLane(delivery.failureClass, delivery.firstLine);
          return;
        }
        // W1-T9680: one lane's credential refusal stops the daemon only when the fleet credential probe agrees.
        const credential =
          !spawnInfra && transientTransport === undefined && ghRead === undefined ? laneCredentialRefusal(err) : undefined;
        if (credential !== undefined) {
          const probe = await fleetCredentialFor(err as object);
          if (probe.state === "alive") {
            parkLane("push_credential_missing", credential.firstLine, { stderr: credential.stderr, fleet_credential: probe.state });
            return;
          }
          const message = String((err as Error)?.message ?? err);
          const named = `${message}\nfleet credential probe: ${probe.state} (${probe.detail})`;
          return { taskId: t.id, message: phase ? `${phase}: ${named}` : named };
        }
        if (!spawnInfra && transientTransport === undefined && ghRead === undefined) {
          // First observed wins the summary detail, mirroring `runDrainLanes`' identical choice. Every other
          // already-settled lane is still classified and processed before this tick returns.
          const message = String((err as Error)?.message ?? err);
          return { taskId: t.id, message: phase ? `${phase}: ${message}` : message };
        }
        if (ghRead !== undefined) {
          reporting.report("daemon.gh_read_failed", { task: t.id, error: ghRead.detail });
          return;
        }
        if (transientTransport !== undefined) {
          dispatchTransportSeenThisTick = true;
          reporting.report("daemon.dispatch_transport_deferred", {
            task: t.id,
            consecutive: consecutiveDispatchTransportFailures + 1,
            error: transientTransport.detail,
          });
          return;
        }
        // Degrade, do not die: a spawn-infrastructure failure is never a fatal crash. The pre-fix shape was
        // error, process exit, supervisor restart, the identical failure again — five consecutive polls, zero
        // escalations, zero backoff. Escalate once per distinct cause, and count once per TICK rather than per
        // lane, so a batch where two lanes hit the same outage backs off like one bad tick (W1-T113 part iii).
        spawnInfraSeenThisTick = true;
        const reason = (err as Error).message;
        reporting.report("daemon.spawn_infra_blocked", { task: t.id, reason, consecutive: consecutiveSpawnInfraFailures + 1 });
        if (!toolchainEscalated.has(reason)) {
          toolchainEscalated.add(reason);
          try {
            await deps.onSpawnInfraBlocked?.({ task: t, reason });
          } catch (escErr) {
            reporting.report("daemon.escalation.failed", { task: t.id, error: String((escErr as Error)?.message ?? escErr) });
          }
        }
    };
    for (let i = 0; i < admitted.length; i++) {
      const t = admitted[i];
      const outcome = settled[i];
      if (!outcome) continue; // A detached child still owns its run, with no fabricated settlement.
      const child = batchChildren.get(t);
      if (child) children.delete(child.runId);
      if (outcome.status === "rejected") {
        const failure = await classifyRejection(t, outcome.reason);
        batchChildren.get(t)?.acknowledge?.(outcome);
        fatalError ??= failure;
        continue;
      }
      const result = outcome.value;
      costUsd += result.costUsd;
      laneDeliveryParks.delete(t.id); // W1-T5344: a settled run ends this task's delivery-failure streak
      toProcess.push({ task: t, result, snapshot: snapshots[i] });
    }
    if (poolOutcome.fault !== undefined) {
      const { task, lane, phase, reason } = poolOutcome.fault;
      try { log("dispatch.pool_failed", { task: task.id, lane, phase, error: String((reason as Error)?.message ?? reason) }); }
      catch (logReason) { phaseFaults.push({ phase: "dispatch.pool_failed", reason: logReason }); }
      // No synthetic task/settlement/attempt: only the original fault enters caller classification.
      const failure = await classifyRejection(task, reason, phase);
      fatalError ??= failure;
    }

    if (fatalError && poolOutcome.fault === undefined && phaseFaults.length === 0 && reporting.faults.length === 0) {
      await stopInterphaseReviewClock();
      return summary("error", `${fatalError.taskId}: ${fatalError.message}`, reporting);
    }

    // A successful lane — including one returning a non-spawn-infra blocked verdict — clears the backoff
    // streak, exactly as the lone dispatch always did.
    if (toProcess.length > 0) {
      consecutiveSpawnInfraFailures = 0;
      consecutiveDispatchTransportFailures = 0;
    }

    // Block reasoning, per lane. Every genuine blocker is parked only after all admitted siblings
    // settle, so one blocked subtree can neither abort useful work already in flight nor restart the
    // persistent scheduler. A library caller that omitted the ownership projection cannot safely
    // reconcile a park, so it retains the defensive terminal result; the real daemon wiring always
    // supplies `isOpenPr` from the same status projection as `refreshMerged`.
    let blockedDetail: string | undefined;
    // Updated alongside block reasoning, never inside it — a pure additional observation over the same per-lane loop.
    // Lane order is the settlement order fixed above, so a batch is walked deterministically (W1-T2517).
    let apiWindowHoldMs = 0;
    for (const { task, result, snapshot } of toProcess) {
      const apiWindowDisposition = reasonAboutApiWindow(apiWindowHoldState, task.id, result.verdict, pollIntervalMs, maxApiWindowHoldMs);
      apiWindowHoldState = apiWindowDisposition.state;
      apiWindowHoldMs = apiWindowDisposition.holdMs;
      const outcome = await processDispatchResult(snapshot.plan, task, result, snapshot.isMerged, reporting.report);
      batchChildren.get(task)?.acknowledge?.({ status: "fulfilled", value: result });
      if (outcome.kind === "genuine_blocker") {
        if (deps.isOpenPr === undefined || deps.isCreditIndeterminate === undefined) {
          blockedDetail ??= outcome.detail;
        } else {
          parkedBlockers.set(task.id, { prUrl: result.prUrl, dependents: outcome.dependents });
          reporting.report("daemon.block.parked", {
            task: task.id,
            verdict: result.verdict,
            pr_url: result.prUrl,
            dependent_count: outcome.dependents.length,
            dependents: outcome.dependents,
          });
        }
      }
    }
    if (fatalError || phaseFaults.length > 0 || reporting.faults.length > 0) {
      // A pool fault closes starts, but genuine workers still earn their result/cost/merge credit.
      // Preserve original classification/detail; named logging faults remain separate secondary facts.
      const detail = [
        ...(fatalError ? [`${fatalError.taskId}: ${fatalError.message}`] : []),
        ...phaseFaults.map(({ phase, reason }) => `${phase}: ${String((reason as Error)?.message ?? reason)}`),
      ].join("; ");
      await stopInterphaseReviewClock();
      return summary("error", detail, reporting);
    }
    if (blockedDetail !== undefined) {
      await stopInterphaseReviewClock();
      return summary("blocked", blockedDetail, reporting);
    }

    if (restartDecided && !deps.checkStop?.() && !deps.checkPause?.()) {
      await stopInterphaseReviewClock();
      return stopForFreshness(restartDecided, restartWait.decidedAtMs);
    }
    restartWindow = undefined;

    if (apiWindowHoldMs > 0) {
      // Consecutive different-task transient refusals at or above the floor: hold dispatch rather than let
      // the next tick pay another full spawn to rediscover the identical closed window. Visible by design —
      // never a silent idle — so one row names the reason, the streak and the instant dispatch resumes.
      ticks++;
      const resumesAtMs = daemonClock.now() + apiWindowHoldMs;
      log("daemon.api_window_hold", {
        tick: ticks,
        hold_ms: apiWindowHoldMs,
        consecutive_different_tasks: apiWindowHoldState.streak,
        reason: "consecutive blocked_transient refusals across different tasks — the API usage window looks closed; holding dispatch instead of re-discovering it per task",
        resumes_at: new Date(resumesAtMs).toISOString(),
      });
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(apiWindowHoldMs);
    }

    if (spawnInfraSeenThisTick && toProcess.length === 0) {
      // The whole tick was spawn-infra trouble and nothing else progressed, so back off exactly as the lone
      // dispatch always did. A tick that mixes spawn-infra with real progress does not back off: the
      // toolchain evidently still works for at least one lane.
      ticks++;
      consecutiveSpawnInfraFailures++;
      const backoffMs = Math.min(pollIntervalMs * 2 ** (consecutiveSpawnInfraFailures - 1), maxSpawnInfraBackoffMs);
      log("daemon.spawn_infra_backoff", { tick: ticks, backoff_ms: backoffMs, consecutive: consecutiveSpawnInfraFailures });
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(backoffMs);
    }

    if (dispatchTransportSeenThisTick && !spawnInfraSeenThisTick && toProcess.length === 0) {
      ticks++;
      consecutiveDispatchTransportFailures++;
      const backoffMs = Math.min(
        pollIntervalMs * 2 ** (consecutiveDispatchTransportFailures - 1),
        maxApiWindowHoldMs,
      );
      log("daemon.dispatch_transport_backoff", {
        tick: ticks,
        backoff_ms: backoffMs,
        consecutive: consecutiveDispatchTransportFailures,
        reason: "transient gh transport refusal after worker dispatch — holding in process",
      });
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(backoffMs);
    }

    await stopInterphaseReviewClock();
    } catch (reason) {
      // Semantic failures still propagate after independently attempting both owned finalizers.
      const cleanupFaults: unknown[] = [];
      try { await stopInterphaseReviewClock(); }
      catch (cleanupReason) { /* Caller receives the original failure plus this named cleanup failure. */ cleanupFaults.push(cleanupReason); }
      try { await closeOwnedServices(reporting.report); }
      catch (cleanupReason) { /* Caller receives the original failure plus this named cleanup failure. */ cleanupFaults.push(cleanupReason); }
      if (cleanupFaults.length) throw new AggregateError([reason, ...cleanupFaults], "post-settlement reconciliation and cleanup failed");
      throw reason;
    }
  }
}

// ── crash recovery (W1-T12c) ────────────────────────────────────────────────
//
// A daemon killed mid-task can leave an orphaned local run behind: a git worktree and its run branch
// that no live process owns any more. Discovering that debris is the CLI wiring's job; this pure
// module only reasons about the parsed result. The one question it must answer per orphan is whether
// GitHub knows about work this task already did, because a dead local process is not authoritative
// and re-running blindly would spawn a second worker on an open PR. Forensics: docs/forensics/daemon.md.

/** A local run a crashed process left behind, as found by the CLI wiring's worktree walk and parsed
 *  by {@link parseOrphanedBranch}. */
export interface OrphanedRun {
  taskId: string;
  runId: string;
  branch: string;
  worktreePath: string;
}

/** `resume`: GitHub already has a live PR for this task — do not respawn. `clean`: no surviving GitHub artifact (or
 * the task is already merged) — the local worktree/branch is stale debris, safe to discard. */
export type RecoveryAction = "resume" | "clean";

export interface RecoveredTask extends OrphanedRun {
  action: RecoveryAction;
  detail: string;
  prUrl?: string;
}

/** Parse a run branch name back into its task and run id. Splits at the LAST hyphen, because task ids
 *  may themselves contain hyphens, and only accepts the split when the trailing segment is all digits.
 *  Anything else — a retro or review run's branch, which is not task-scoped — returns null. */
export function parseOrphanedBranch(branch: string, worktreePath: string): OrphanedRun | null {
  if (!branch.startsWith("run-")) return null;
  const rest = branch.slice("run-".length);
  const i = rest.lastIndexOf("-");
  if (i <= 0 || i === rest.length - 1) return null;
  const taskId = rest.slice(0, i);
  const epochMs = rest.slice(i + 1);
  if (!/^\d+$/.test(epochMs)) return null;
  if (taskId === "RETRO" || /^review-PR\d+$/.test(taskId)) return null; // not task-scoped
  return { taskId, runId: `${taskId}-${epochMs}`, branch, worktreePath };
}

/** Reconstruct one orphan's fate from its task's GitHub-derived projection, mapping it onto a recovery
 *  verb. An open PR means resume: GitHub, not the dead local process, is the task's true state, and the
 *  worktree is left untouched because it is the tree behind that PR. Merged, closed without merging, or
 *  no evidence at all means clean, and an unmerged task is left for the next tick. Forensics: docs/forensics/daemon.md. */
export function reconstructOrphan(
  orphan: OrphanedRun,
  deriveTaskStatus: (taskId: string) => StatusProjection,
): RecoveredTask {
  const projection = deriveTaskStatus(orphan.taskId);
  // A running status no longer implies a PR exists: the projection also reports it for a ledger-in- flight run that
  // has not opened a PR yet. Only an actual open PR is resumable. The guard is a no-op for every pre-existing running
  // case, which always carried a URL, and correctly falls through to clean for the new no-PR-yet case (W1-T155).
  if (projection.status === "running" && projection.prUrl) {
    return {
      ...orphan,
      action: "resume",
      prUrl: projection.prUrl,
      detail: `${orphan.taskId}: an open PR already exists (${projection.prUrl}) — resuming from GitHub state, not respawning`,
    };
  }
  const why = projection.merged
    ? `already merged (${projection.prUrl})`
    : projection.status === "blocked"
      ? `its PR was closed without merging (${projection.prUrl})`
      : "no surviving GitHub artifact — the crash happened before a PR existed";
  return {
    ...orphan,
    action: "clean",
    prUrl: projection.prUrl,
    detail: `${orphan.taskId}: ${why} — orphaned worktree/branch is stale debris, safe to discard`,
  };
}

/**
 * W1-T10799 — A MANAGED TARGET WITH NO DAEMON OF ITS OWN runs its one reviewed frontier task as ONE bounded
 * job the CORE daemon owns. The narrow exception to {@link taskTargetsRepo}'s single-target guard: one job, one
 * task, one lane, ended at that one dispatch's terminal verdict. It never makes the daemon a multi-repo
 * scheduler, and it reuses the maintained drain, so every admission gate the drain applies still decides.
 *
 * PURE: every read and write is a seam the caller wires (the durable record, the registry, the plan sync, the
 * dispatch claim, the drain's own deps), so this module keeps its no-filesystem contract.
 */
export interface BoundedTargetJobKick { taskId: string; origin: string; repo: string }
export interface BoundedTargetJobPorts {
  readJob: (origin: string) => TargetJobRead;
  writeJob: (record: TargetJobRecord) => void;
  admit: (repo: string) => TargetJobAdmission;
  /** The target clone's plan, synced from origin/main through the existing plan-sync refusal. */
  syncPlan: (owner: string, repo: string) => Promise<{ plan: Plan } | { error: string }>;
  /** Whether the target's dispatch claim for the task is held; `undefined` is an unreadable remote, never "free". */
  claimHeld: (taskId: string, repo: string) => Promise<boolean | undefined>;
  /** The native receipts the CORE ledger holds for this job's origin (`readTargetExecution`). */
  execution: (record: TargetJobRecord) => { state: string };
  /** The maintained drain. `onDispatch` runs immediately before the drain's one `runOne` and may throw to refuse it. */
  drain: (plan: Plan, opts: DrainOpts, onDispatch: () => void) => Promise<DrainSummary>;
  clearKick: (taskId: string, repo: string) => void;
  log: (step: string, extra?: Record<string, unknown>) => void;
  nowIso: () => string;
}
/** `ended`/`refused` close the job and its marker; `held` and `resumed` keep both for a later tick. */
export type BoundedTargetJobOutcome =
  | { state: "ended" | "refused"; reason: string; replayed: boolean }
  | { state: "held" | "resumed"; reason: string };

/** The drain stop reasons that mean the core daemon's own governors declined, not that the task is unrunnable. */
const CAPACITY_STOPS: ReadonlySet<StopReason> = new Set<StopReason>([
  "headroom_exhausted", "headroom_degraded", "cost_governor_deferred", "queue_governor_deferred", "memory_governor_deferred",
  "quiet_hours_deferred", "new_build_deferred", "wip_deferred", "stopped", "paused",
]);

export async function runBoundedTargetJob(kick: BoundedTargetJobKick, deps: BoundedTargetJobPorts, baseOpts: DrainOpts = {}): Promise<BoundedTargetJobOutcome> {
  const { taskId, origin, repo } = kick;
  const fields = { task: taskId, origin, repo };
  const base = (status: TargetJobStatus, prior?: TargetJobRecord, extra: Partial<TargetJobRecord> = {}): TargetJobRecord =>
    ({ origin, taskId, repo, attempts: prior?.attempts ?? 0, ...extra, status, updatedAt: deps.nowIso() });
  const held = (reason: string, step = "target_job.held"): BoundedTargetJobOutcome => { deps.log(step, { ...fields, reason }); return { state: "held", reason }; };
  const close = (record: TargetJobRecord, reason: string, replayed: boolean): BoundedTargetJobOutcome => {
    if (!replayed) deps.writeJob({ ...record, reason });
    deps.clearKick(taskId, repo);
    return { state: record.status as "ended" | "refused", reason, replayed };
  };
  const refuse = (prior: TargetJobRecord | undefined, reason: string): BoundedTargetJobOutcome => {
    deps.log("console.kick_refused", { ...fields, reason });
    return close(base("refused", prior), reason, false);
  };

  const read = deps.readJob(origin);
  if (read.state === "unreadable") return held("job record unreadable", "target_job.unknown");
  const prior = read.state === "found" ? read.record : undefined;
  if (prior && (prior.taskId !== taskId || prior.repo.toLowerCase() !== repo.toLowerCase())) return held("job identity conflicts with request", "target_job.unknown");
  // A closed job is reported, never re-run: the same origin never spends twice.
  if (prior && (prior.status === "ended" || prior.status === "refused")) {
    deps.log("target_job.replayed", { ...fields, status: prior.status });
    return close(prior, prior.reason ?? prior.status, true);
  }

  const admission = deps.admit(repo);
  if (admission.state === "unreadable") return held("registry or managed set unreadable", "target_job.unknown");
  if (admission.state === "not_enrolled") return refuse(prior, "target is not an enrolled managed repository");
  if (admission.state === "own_instance") return refuse(prior, `${admission.instance} drives this repository; its own kick path owns the task`);
  if (prior?.owner && prior.owner.toLowerCase() !== admission.owner.toLowerCase()) return held("verified target owner changed", "target_job.unknown");

  if (prior?.status === "admitted") {
    // A restart or a lost response: recover from the durable record, the native receipts and the dispatch claim.
    const seen = deps.execution(prior);
    if (seen.state === "ended") return close({ ...prior, status: "ended", updatedAt: deps.nowIso() }, "terminal verdict recorded", false);
    const claim = await deps.claimHeld(taskId, repo);
    if (seen.state === "unknown") return held("native execution receipts unreadable", "target_job.unknown");
    if (claim !== false || seen.state === "running") {
      if (prior.reason !== "resumed") {
        // `updatedAt` stays the dispatch time: the native receipts are correlated from it.
        deps.writeJob({ ...prior, reason: "resumed" });
        deps.log("target_job.resumed", { ...fields, claim: claim === undefined ? "unknown" : "held", execution: seen.state });
      }
      return { state: "resumed", reason: `dispatch already landed (${seen.state})` };
    }
    return held(`previous dispatch unresolved (${seen.state}); claim absent`, "target_job.unknown");
  }

  const synced = await deps.syncPlan(admission.owner, repo);
  if ("error" in synced) return held(`target plan not synced: ${synced.error}`, "target_job.plan_unreadable");
  const task = synced.plan.tasks.find((t) => t.id === taskId);
  if (!task) return refuse(prior, "unknown task id");
  if (task.repo.toLowerCase() !== repo.toLowerCase()) return refuse(prior, "task repository conflicts with verified target");
  const identity = { owner: admission.owner, planRevision: planSha(synced.plan.tasks) };

  // One task, depth 1, max 1, one lane: the job can never re-enter the target plan's other tasks.
  const opts = applyCuratedSelection({ ...baseOpts, laneCount: 1, wipLimit: 1 }, { taskIds: [taskId], depth: 1 });
  let dispatched = false;
  let summary: DrainSummary;
  try {
    summary = await deps.drain(synced.plan, opts, () => {
      // Durable BEFORE the spend, and the receipt only when the drain really starts the run.
      if (dispatched) throw new Error("bounded job already dispatched");
      deps.writeJob(base("admitted", prior, { ...identity, attempts: (prior?.attempts ?? 0) + 1 }));
      dispatched = true;
      deps.log("console.kick_dispatched", fields);
    });
  } catch (error) {
    // A drain that threw is a failed read of the world, never a terminal verdict: the job stays open and its marker stays.
    return held(`drain failed${dispatched ? " after dispatch" : ""}: ${String((error as Error)?.message ?? error)}`, "target_job.error");
  }
  if (dispatched) {
    if (summary.stopReason === "error") return held("dispatch outcome unresolved", "target_job.unknown");
    deps.log("target_job.ended", { ...fields, stop_reason: summary.stopReason });
    return close(base("ended", { ...(prior ?? base("queued")), attempts: (prior?.attempts ?? 0) + 1 }, { ...identity, stopReason: summary.stopReason }), summary.stopReason, false);
  }
  if (CAPACITY_STOPS.has(summary.stopReason) || summary.stopReason === "error") {
    return held(`${summary.stopReason}${summary.stopDetail ? `: ${summary.stopDetail}` : ""}`, "target_job.capacity_deferred");
  }
  return refuse(prior, `drain found the task not runnable (${summary.stopReason})`);
}
