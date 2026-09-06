/**
 * lib/status-board.ts — `rmd status` (W1-T279, W1-T280; MASTER-PLAN §7/§5D).
 *
 * ONE READ MODEL, TWO RENDERERS. {@link buildStatusBoard} returns {@link StatusBoardModel}; the text
 * renderer and `--json` (a bare `JSON.stringify` of that model) both project it, so the console's Now
 * tab can never disagree with the terminal. FALSIFIER: test/status-board.test.ts.
 *
 * OFFLINE-SAFE LOCAL HALF. Liveness, latches and last cycle read the filesystem, the ledger, or an
 * injected process query. The `origin/main` comparison is a local `git rev-parse`, never a fetch.
 *
 * GITHUB IS DECORATION, NEVER A GATE ({@link StatusBoardDeps.github}). Blockers, queue head and
 * inbox read live merge state through one batched gateway. A gateway failure degrades only the rows
 * that needed it to a stated `unknownReason` — never a throw, never a silently empty section. An
 * unresolvable fact renders `"unknown"`, never a healthy-looking zero.
 *
 * RENDERS, NEVER SENSES. Every fact here is already written down by fleet-control.ts, deployer.ts,
 * inflight-lock.ts, daemon.ts, status.ts, sweep.ts or config.ts. This module assembles; it invents no
 * sensor and mints no vocabulary those signals do not already carry.
 *
 * NEXT ACTION TABLES ARE POLICY AS DATA (rule 2). Each section's `nextAction` is the FIRST match in
 * an ordered `{applies, action}` list, so a new condition is a row and never a buried branch. No
 * rule matches, no line: a board that always prints advice trains the operator to skip it.
 */
// Why: the incidents and measured counts behind these rules — docs/forensics/status-board.md

import { execFileSync } from "node:child_process";
import { isQueueDispatchRunStart } from "./ledger.js";
// Imported as the DEFAULT export and read as `fs.existsSync(...)` at call time, never destructured. ESM named bindings
// off `node:fs` are non-configurable, so a spy cannot intercept a call bound at load time; a live lookup it can.
// Why: the TOCTOU-race test — docs/forensics/status-board.md
import fs from "node:fs";
import { join } from "node:path";
import {
  detectDaemonCrashLoop,
  DEFAULT_CRASHLOOP_WINDOW,
  type CrashLoopVerdict,
  type CrashLoopWindow,
  type DaemonBootTimestamp,
} from "./daemon.js";
import { COST_ANOMALY_STEP } from "./cost-anomaly.js";
import { IMAGE_DRIFT_STEP } from "./image-drift.js";
import { TOKEN_REFRESHED_STEP, TOKEN_REFRESH_FAILED_STEP } from "./github-app.js";
import {
  aggregateCacheHitTotals,
  aggregateLearningsInjection,
  cacheHitRatio,
  formatCacheHitFigure,
  type CacheHitGrain,
  type CacheHitTotals,
  type LearningsInjectionTotals,
} from "./digest.js";
import { deployAutoPath, deployFailedAlertPath, sameCommit } from "./deployer.js";
import { dispatchClaimRef } from "./dispatch-claim.js";
import {
  checkOperatorMessage,
  type OperatorMessage,
  type OperatorMessageCheckResult,
  type OperatorMessagePart,
} from "./operator-message.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { IDLE_REASON_ID_CAP, runBranchTaskIds, runnableCandidates, type DispatchFilterReason, type MergedSet } from "./drain.js";
import {
  drainNowFilePath,
  pauseFilePath,
  pendingKicks,
  quietHoursFilePath,
  readSharedPause,
  realSharedPauseGitDeps,
  sharedPauseRef,
  stopFilePath,
  type SharedPauseRead,
} from "./fleet-control.js";
import { readInflightLock } from "./inflight-lock.js";
import { classifyGlobalArtifactRefusal } from "./learnings.js";
import { DEFAULT_SUPERVISOR_INTERVAL_S } from "./launchd.js";
import {
  classifyProposal,
  gitGrepAnchorTrue,
  isRatifiedInLedger,
  parseDraftCache,
  parseProposalRegistry,
  refusalReason,
  type DraftCache,
  type EvidenceAnchor,
  type InboxClassification,
  type Proposal,
  type ReadinessContext,
} from "./inbox.js";
import { loadPlan, type MergedResolver, type Plan, type RetirementReason } from "./plan.js";
import { automergeHoldFromLedger, type AutomergeHold } from "./review.js";
import {
  DEFAULT_MAX_TASK_DISPATCHES,
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  projectPlan,
  readLedgerLines,
  type DeriveDeps,
  type GhFailureReason,
  type GitHub,
  type LedgerReader,
  type StatusProjection,
  readLedgerUnionBounded,
} from "./status.js";
import { taskCardRuns } from "./task-card.js";
import { colourEnabled, paint, sectionRule } from "./tty.js";

// ── The model ────────────────────────────────────────────────────────────────────────────────

export type ServiceName = "daemon" | "serve" | "deploy-supervisor";

/** `"daemon"`/`"serve"` are RESIDENT (launchd `KeepAlive`), so `running: false` means dead. For the INTERVAL
 *  `"deploy-supervisor"` it is also normal rest between ticks, which a binary render cannot tell apart (W1-T301). */
export type ServiceKind = "resident" | "interval";

export function serviceKind(service: ServiceName): ServiceKind {
  return service === "deploy-supervisor" ? "interval" : "resident";
}

/** One LIVENESS row. `bootedAt`/`bootedAgeMs`/`headSha` are `"daemon"`-only — the one service logging a `daemon.boot`
 *  heartbeat (W1-T126); `serve` shows "unknown", never a fabricated zero.
 *  `tickAt`/`tickAgeMs`/`tickStep`/`lastExitCode`/`overdueThresholdMs` are `"deploy-supervisor"`-only. */
export interface ServiceLivenessRow {
  service: ServiceName;
  running: boolean;
  pid: number | null;
  /** False iff the LAUNCHD SENSOR ITSELF could not be asked — `launchctl` absent (W1-T2450) — not launchctl answering
   *  "not loaded". Defaults to `true`. {@link livenessState} reads it FIRST, so an absent sensor renders `"unknown"`,
   *  never a wrong `"stopped"`. */
  sensed?: boolean;
  bootedAt?: string;
  bootedAgeMs?: number;
  headSha?: string;
  /** Timestamp of the most recent `deploy.*` ledger line ("deploy-supervisor" only). */
  tickAt?: string;
  /** `now - tickAt`, clamped to >= 0 ("deploy-supervisor" only). */
  tickAgeMs?: number;
  /** The latest tick's ledger step name, e.g. `"deploy.skip"` / `"deploy.ok"` — informational only; failure is judged
   *  by {@link ServiceLivenessRow.lastExitCode}, not this. */
  tickStep?: string;
  /** `launchctl list`'s `Status` column for the job's last completed run — `0` healthy, nonzero a real exit failure,
   *  `undefined` unknown (never bootstrapped, or the query failed). */
  lastExitCode?: number;
  /** How stale `tickAgeMs` may get before this row reads `"overdue"` — resolved from the INSTALLED unit's own
   *  `StartInterval`, never a restated constant, so a plist edit cannot desync it. Falls back to {@link
   *  SUPERVISOR_TICK_OVERDUE_MS}. */
  overdueThresholdMs?: number;
}

/** The states a row can be in. Resident services report `"running"`/`"stopped"`/`"unknown"`; interval services add
 *  `"idle"` and `"overdue"`. `"unknown"` (W1-T2450) means the sensor could not be asked at all, never a fabricated
 *  `"stopped"`. */
export type LivenessState = "running" | "stopped" | "idle" | "overdue" | "unknown";

/** Fallback for {@link ServiceLivenessRow.overdueThresholdMs} when the installed unit's `StartInterval` cannot be read
 *  — 3x the plist's default pace, so one or two slow ticks do not false-positive and a quiet supervisor does. */
export const SUPERVISOR_TICK_OVERDUE_MS = DEFAULT_SUPERVISOR_INTERVAL_S * 3 * 1000;

/** Classify one row into its {@link LivenessState}. A pure function of the row alone — its own overdue threshold
 *  included — so the renderer, `--json` and the LIVENESS table derive one state from identical facts. */
export function livenessState(row: ServiceLivenessRow): LivenessState {
  if (row.running) return "running";
  // W1-T2450: an absent sensor is read BEFORE the resident/interval split below. Both kinds share one launchd sensor,
  // and it must win over every downstream inference that sensor never fed.
  if (row.sensed === false) return "unknown";
  if (serviceKind(row.service) === "resident") return "stopped";
  // Interval: a nonzero last exit is a real failure however fresh it was, and no tick ever observed reads as overdue
  // too — never a healthy "idle" for a supervisor nothing has heard from.
  if (row.lastExitCode !== undefined && row.lastExitCode !== 0) return "overdue";
  const overdueMs = row.overdueThresholdMs ?? SUPERVISOR_TICK_OVERDUE_MS;
  if (row.tickAgeMs === undefined || row.tickAgeMs > overdueMs) return "overdue";
  return "idle";
}

/** The running daemon's boot sha against a LOCAL (no-fetch) read of `origin/main`, through W1-T126's own `sameCommit`
 *  (deployer.ts) and never a second comparison. `"unknown"` when either side could not be resolved. */
export type StaleFlag = { status: "unknown" } | { status: "fresh" } | { status: "stale"; headSha: string; originSha: string };

export interface LivenessSection {
  services: ServiceLivenessRow[];
  headVsOriginMain: StaleFlag;
  crashLoop: CrashLoopVerdict;
  nextAction?: string;
}

/** One active LATCH — only PRESENT markers become a row (an absent marker is not news). */
export interface LatchRow {
  name: string;
  ageMs?: number;
  consequence: string;
  /** Why this latch's RECORD is worth showing while its INSTRUCTION no longer applies. Today `DEPLOY_FAILED` and only
   *  it: nothing unlinks the marker, so the alert is permanent and its advice named a head origin/main had passed. Why:
   *  the measured stale latch and #1639's shape — docs/forensics/status-board.md */
  superseded?: string;
}

export interface LatchesSection {
  rows: LatchRow[];
  nextAction?: string;
}

/** The newest `daemon.summary` ledger line, read back loosely (never re-typed against `DaemonSummary`'s strict
 *  `DaemonStopReason` union — a future stop reason this board doesn't yet know about must still render, not vanish). */
export interface LastCycleSummary {
  attempted: string[];
  merged: string[];
  stopReason: string;
  stopDetail?: string;
  costUsd: number;
  ticks: number;
}

export interface LastCycleSection {
  found: boolean;
  summary?: LastCycleSummary;
  ts?: string;
  ageMs?: number;
  /** The newest `daemon.*` activity STRICTLY AFTER this cycle closed — evidence the loop kept working. A cycle CLOSES
   *  only when the loop stops, so this would otherwise pin to the last abnormal stop. Why: the 524-summary census —
   *  docs/forensics/status-board.md */
  supersededByTs?: string;
  /** Age of {@link supersededByTs}, for the renderer. */
  supersededAgeMs?: number;
  nextAction?: string;
}

// ── BLOCKERS BY CLASS (W1-T280) — each class in its OWN vocabulary, never a generic "blocked"
// bucket: the board mints no taxonomy the named-reason and breaker signals do not already carry ──

/** The streak dispatch-circuit-breaker (status.ts's `isDispatchBreakerTripped`) tripped for this task — the SAME signal
 *  drain.ts and daemon.ts gate on, never re-implemented. `resetNote` names its own reset, a fresh owned PR; there is no
 *  timed reset. */
export interface CircuitBrokenBlocker {
  kind: "circuit_broken";
  taskId: string;
  dispatchCount: number;
  maxDispatches: number;
  resetNote: string;
}

/** This task's last dispatch was flagged INDETERMINATE (the ledger's `dispatch.indeterminate` line) — a PURE ledger
 *  read, rendered whatever GitHub does. `ghWindowNote` is enriched with the classified failure reason when a reachable
 *  gateway confirms it is STILL indeterminate; "the gateway could not decide" never reads as "the task is broken". */
export interface IndeterminateBlocker {
  kind: "indeterminate";
  taskId: string;
  ghWindowNote: string;
}

/** An open PR sweep.ts's `runSweep` already disposed into a non-progressing class — RENDERS the vocabulary its
 *  `sweep.disposed` line minted (W1-T186). `reason` reads "reason not named", never a blank. */
export interface BlockedPrBlocker {
  kind: "blocked_pr";
  taskId?: string;
  prNumber: number;
  prUrl?: string;
  disposition: string;
  reason: string;
}

/** A plan-declared `status: "blocked"` task carrying a `retirement` ruling (W1-T1287) — the PLAN's vocabulary, never
 *  one this board mints. Without it there is no row. FALSIFIER: test/retirement-reaches-its-reader.test.ts */
export interface RetiredBlocker {
  kind: "retired";
  taskId: string;
  reason: string;
}

export type BlockerRow = CircuitBrokenBlocker | IndeterminateBlocker | BlockedPrBlocker | RetiredBlocker;

/** `circuit_broken` and `indeterminate` are PURE ledger reads, always present in full. `blocked_pr` (W1-T306) is a
 *  claim about NOW, re-derived against live merge state every render, never replayed from `sweep.disposed`. Why:
 *  decoration means "unverified" here — docs/forensics/status-board.md */
export interface BlockersSection {
  rows: BlockerRow[];
  /** Set ONLY when the ledger holds a `sweep.disposed` "not progressing" line whose live GitHub state could NOT be
   *  checked this cycle (W1-T306 design (4); W1-T309: not gated on `plan`). Those entries are withheld rather than
   *  printed as current. */
  blockedPrsUnverifiedReason?: string;
  nextAction?: string;
}

// ── QUEUE HEAD (W1-T280) — the next dispatchables, each carrying its attempt count and observed
// per-cycle cost. BINDS THE DISPATCHER'S OWN `hasPushedRunBranch` PREDICATE (W1-T1205), so a task
// dispatch would refuse is named in `refused` rather than vanishing from this surface ───────────

export interface QueueHeadRow {
  taskId: string;
  title: string;
  /** status.ts's `dispatchesWithoutNewOwnedPr` — the SAME streak count the circuit breaker itself trips on, so this
   *  row's number and BLOCKERS' `circuit_broken` class can never disagree about what "close to tripping" means. */
  attempts: number;
  /** True once `attempts` is at or near the streak breaker's threshold, so a perpetual-attempt task is read in one
   *  second, before the next dispatch trips it. Why: the four-re-dispatch incident — docs/forensics/status-board.md */
  perpetual: boolean;
  /** The most recent costed run's `cost_usd` (task-card.ts's `taskCardRuns`) — present only when `perpetual` is true,
   *  so repeated spend cannot stay invisible. */
  observedPerCycleCostUsd?: number;
}

/** One task `runnableCandidates` (drain.ts) REFUSED, with its reason, so the row is named here rather than vanishing
 *  with no trace beyond a ledger row. `reason` carries the full union; this derivation pushes only two literals onto
 *  it. */
export interface QueueHeadRefusedRow {
  taskId: string;
  title: string;
  /** W1-T2415: the {@link DispatchFilterReason} union PLUS `"circuit-broken"`, widened HERE and nowhere else — the
   *  breaker arrives through `onCircuitBreak`. Why: what a seventh union arm would have moved —
   *  docs/forensics/status-board.md */
  reason: DispatchFilterReason | "circuit-broken";
  /** Present ONLY on a `"circuit-broken"` row (W1-T2415): dispatch count, the bound compared against, and the breaker's
   *  own reset condition — {@link CircuitBrokenBlocker}'s three facts through the same helpers, so the surfaces cannot
   *  disagree. */
  dispatchCount?: number;
  maxDispatches?: number;
  resetNote?: string;
}

export interface QueueHeadSection {
  rows: QueueHeadRow[];
  /** Tasks the dispatcher's OWN eligibility chain (`isDispatchEligible`, drain.ts) refuses for a reason this board can
   *  name (W1-T1205) — never a second, silent list, and bound to the SAME `hasPushedRunBranch` predicate so `rows`
   *  cannot advertise a task dispatch would refuse. Capped at {@link IDLE_REASON_ID_CAP}. Why: why the other reasons
   *  are not duplicated — docs/forensics/status-board.md */
  refused: QueueHeadRefusedRow[];
  /** How many `"run-branch-already-pushed"` exclusions {@link refused} could not name because it hit {@link
   *  IDLE_REASON_ID_CAP} — `0` when none dropped. A count, never a silent cap, as drain.ts's
   *  `IdleReasonBucket.truncated` already does. */
  refusedTruncated: number;
  /** Present when dispatch eligibility (merge state) could not be resolved — no reachable GitHub gateway, so nothing
   *  here would be trustworthy enough to print as "next up". */
  unknownReason?: string;
  /** W1-T450: eligible candidates render identically whether about to dispatch or untouched for an hour, so a daemon
   *  failing every pass looks calm. Present ONLY when `rows` is non-empty AND the newest `run.start` is older than
   *  {@link QueueHeadStall.boundMs}; an empty queue is honest idle and an unreadable cadence is an unknown, so both
   *  stay silent. */
  stall?: QueueHeadStall;
  nextAction?: string;
}

/** Names both halves of the stall: how many candidates, and how long since anything dispatched. NOT A GATE — this only
 *  ever backs a rendered line and a next action; nothing reading it may block or refuse a dispatch. */
export interface QueueHeadStall {
  /** `rows.length` at render time — repeated here so the rendered line is self-contained. */
  candidateCount: number;
  /** `now - lastDispatchTs`, clamped to >= 0. */
  sinceMs: number;
  /** The newest `run.start` line's own `ts`, across every task — task-id-agnostic like {@link
   *  distinctDispatchedTaskIds}: "nothing dispatched" means no task anywhere, not just one of today's candidates. */
  lastDispatchTs: string;
  /** The staleness bound THIS HOST'S OWN observed dispatch cadence licenses (design (iii)) — never a guessed round
   *  figure. See {@link boundDerivation} for how it was computed. */
  boundMs: number;
  /** States the derivation beside the constant, so an operator never has to trust a bare number. */
  boundDerivation: string;
}

// ── INBOX (W1-T280) — ready/not-ready COUNTS from inbox.ts's own InboxState; `rmd inbox`
// remains the detail surface, this board only summarizes ─────────────────────────────────────

export interface InboxSection {
  readyCount: number;
  notReadyCount: number;
  /** inbox.ts's `refusalReason` for the FIRST not-ready proposal only (registry order) — the board summarizes, it does
   *  not replace `rmd inbox`. */
  headNotReadyReason?: string;
  /** Present when classification could not be resolved — no reachable GitHub gateway for the dep-merged predicate, or
   *  no plan/tasks.yaml to resolve dependency ids against. */
  unknownReason?: string;
  nextAction?: string;
}

// ── HEADROOM (W1-T280) — the newest `daemon.headroom` telemetry line PLUS enforcement on/off
// from the SAME switch the daemon reads ────────────────────────────────────────────────────────

export interface HeadroomTelemetry {
  window: string;
  percentUsed: number;
  limitPct: number;
  resetsAt?: string;
  /** The daemon's own "governor disabled — telemetry only" note (config.ts ruling fb-1784894405468-a4153e), carried
   *  verbatim when the ledger line has one. */
  note?: string;
}

export interface HeadroomSection {
  found: boolean;
  telemetry?: HeadroomTelemetry;
  ts?: string;
  ageMs?: number;
  /** config.ts's `resolveHeadroomEnabled` — the SAME switch the daemon reads, never a second derivation. Present
   *  unconditionally: this is a LOCAL config read, never gated on GitHub. */
  enforced: boolean;
  /** The newest `daemon.headroom.degraded` line in the window — the governor saying it CANNOT READ usage and has
   *  stopped dispatching. Without it `found: false` covers both "not ticked yet" and a permanent park. Why: why one
   *  line suffices and survives rotation — docs/forensics/status-board.md */
  degraded?: HeadroomDegraded;
  nextAction?: string;
}

/** The governor's "I cannot read usage" signal, read off the newest `daemon.headroom.degraded`. */
export interface HeadroomDegraded {
  /** `consecutive_unreadable` — how many consecutive probe misses at that tick. */
  consecutiveUnreadable?: number;
  /** `poll_interval_ms` — the tick spacing, so duration is derivable without more lines. */
  pollIntervalMs?: number;
  /** That line's own `ts`. */
  ts?: string;
  /** `nowMs - ts`, when both parse — how stale the blindness report itself is. */
  ageMs?: number;
}

/** W1-T929: the cache-hit ratio per run and per task class over the SAME ledger window every other section opened, via
 *  digest.ts's {@link aggregateCacheHitTotals}. ONE traversal, so board and digest cannot disagree on which lines
 *  count. */
export interface CacheHitSection {
  found: boolean;
  totals?: CacheHitTotals;
}

/** W1-T940: learnings-injection drop pressure over the SAME ledger window, via digest.ts's {@link
 *  aggregateLearningsInjection} — ONE traversal. `found: false` renders explicit absence, never a fabricated `dropped:
 *  0`. */
export interface LearningsInjectionSection {
  found: boolean;
  totals?: LearningsInjectionTotals;
}

/** W1-T931 COST-ANOMALY SENTINEL — one un-dismissed `cost.anomaly` row (cost-anomaly.ts's `recordCostAnomalies`): a run
 *  costing more than `multiplier` times its task CLASS's median. REPORTS ONLY, per the header's own rule. */
export interface CostAnomalyRow {
  runId: string;
  taskId: string;
  taskClass: string;
  costUsd: number;
  medianCostUsd: number;
  multiplier: number;
  sampleSize: number;
  /** The `cost.anomaly` ledger line's own `ts`, when present. */
  ts?: string;
}

/** W1-T1021 IMAGE DRIFT — the newest un-dismissed `daemon.image_drift` row: a baked path changed on `main` AFTER the
 *  running image was built, so no mount-side restart can pick it up. Names both shas. */
export interface ImageDriftRow {
  buildSha: string;
  bakedSha: string;
  /** The `daemon.image_drift` ledger line's own `ts`, when present. */
  ts?: string;
}

/** W1-T1000003 — a merge hold engaged by an OPERATOR (review.ts's `automergeHoldFromLedger`). NOT a blocker: a hold is
 *  the operator's own standing refusal, so it renders in the escalation surface and is never re-derived from check or
 *  review fields. */
export interface MergeHeldRow {
  /** Absent for a FLEET-scoped hold (no `pr_number` on the ledger row) — applies to every open request, not one.
   *  Present for a PR-scoped hold, naming the held request. */
  prNumber?: number;
  /** Opportunistic enrichment from the same `automerge.hold_engaged` row's `task_id`, "latest wins" — never the fact
   *  deciding whether the hold stands ({@link automergeHoldFromLedger} alone). Absent for a fleet-scoped hold. */
  taskId?: string;
  /** Who engaged the hold — {@link AutomergeHold.by}, carried through unchanged. */
  by: string;
  /** Why — {@link AutomergeHold.reason}, carried through unchanged; never a reason this board invents from a check or
   *  review field. */
  reason: string;
}

/** THE FLEET IS RUNNING ON THE FALLBACK TOKEN RIGHT NOW — the newest `github_app.token_refresh_failed` is newer than
 *  the newest `github_app.token_refreshed`, so `refreshInstallationToken` left `process.env.GH_TOKEN` as found and
 *  every `gh` spawn since bills the PERSONAL token. A CURRENT-STATE read: a failure followed by a success is the system
 *  working. */
export interface TokenFallbackRow {
  /** Why the last exchange failed, verbatim off the row (`exchange timed out`, `exchange rejected: 403`, …). */
  reason: string;
  /** When that failure was recorded. */
  ts?: string;
  /** When the last SUCCESSFUL refresh was, if there has ever been one — absent means never. */
  lastOkTs?: string;
}

/** W1-T2392: one merged BUILD naming a task in its own prose that no credit surface claimed. WARN, NEVER CREDIT — a
 *  task credited wrongly is never built at all, worse than one credited late; this row changes no disposition. */
export interface UncreditedBuildRow {
  /** The task whose build merged uncredited. */
  taskId: string;
  /** The merged PR that names it in prose. */
  prNumber: number;
  prUrl: string;
  /** Which prose surface carried the id — a reader told "title" for a body-named build looks in the wrong half of it.
   *  Why: measured, 14 of 19 name it in the BODY only — docs/forensics/status-board.md */
  namedIn: "title" | "body";
}

/** NEEDS ME — the board's own escalation surface, distinct from `rmd serve`'s HTML "Needs me" panel, which is
 *  task-escalation-driven. A future sentinel is a new field here, not a new section. */
export interface NeedsMeSection {
  costAnomaly: CostAnomalyRow[];
  imageDrift?: ImageDriftRow;
  /** W1-T1000003: currently-standing operator merge holds — empty (never `undefined`) when none stand, so the quiet
   *  case renders no row at all (design (iii)). */
  mergeHeld: MergeHeldRow[];
  /** W1-T2392: merged builds no credit surface claimed. EMPTY (never `undefined`) when none. Why: measured, 84 of 103
   *  recent builds ARE credited — docs/forensics/status-board.md */
  uncreditedBuilds: UncreditedBuildRow[];
  /** The standing App-token fallback, if one stands — absent when the last refresh succeeded, so a healthy fleet
   *  renders no row. */
  tokenFallback?: TokenFallbackRow;
}

export interface StatusBoardModel {
  generatedAt: string;
  liveness: LivenessSection;
  latches: LatchesSection;
  lastCycle: LastCycleSection;
  blockers: BlockersSection;
  queueHead: QueueHeadSection;
  inbox: InboxSection;
  headroom: HeadroomSection;
  cacheHit: CacheHitSection;
  learningsInjection: LearningsInjectionSection;
  needsMe: NeedsMeSection;
}

// ── Deps ─────────────────────────────────────────────────────────────────────────────────────

export interface StatusBoardDeps {
  /** Per-service running/pid, plus the last run's exit code for `"deploy-supervisor"`. `launchctl` lives at the CLI
   *  layer (Rule 16), so this is required with no default in lib/. `lastExitCode` is `undefined` when unknown, never a
   *  fabricated `0`; `sensed` (W1-T2450) is `false` iff `launchctl` could not be invoked at all. */
  queryService: (service: ServiceName) => { running: boolean; pid: number | null; lastExitCode?: number; sensed?: boolean };
  /** The checkout to compare against `origin/main` (the daemon's own repoRoot). */
  repoDir: string;
  /** The deploy-supervisor's OWN installed `StartInterval` (seconds), read from the unit on disk so an install-time
   *  override cannot desync the overdue threshold. Defaults to {@link DEFAULT_SUPERVISOR_INTERVAL_S}: no plist read, no
   *  throw, from lib/. */
  resolveSupervisorIntervalS?: () => number | undefined;
  /** Ledger reader; defaults to status.ts's real `readLedgerLines`. */
  readLedger?: LedgerReader;
  /** LOCAL (no-fetch) resolution of `origin/main`'s sha — offline-safe by construction. Defaults to `git rev-parse
   *  origin/main` in `repoDir`; returns `undefined`, never throws, when it cannot be resolved. */
  resolveOriginMainSha?: (repoDir: string) => string | undefined;
  /** Clock; defaults to `Date.now`. Injectable so a test can assert an exact age. */
  now?: () => number;
  /** Crash-loop window/threshold; defaults to daemon.ts's `DEFAULT_CRASHLOOP_WINDOW`. */
  crashLoopWindow?: CrashLoopWindow;
  /** Pid-liveness probe for inflight-lock rows; defaults to drain-lock.ts's real check. */
  isPidAlive?: (pid: number) => boolean;

  // ── W1-T280 (DERIVED half) ────────────────────────────────────────────────────────────────

  /** Local (offline) `plan/tasks.yaml` read — the DAG QUEUE HEAD and INBOX resolve against. `undefined`, never a throw,
   *  when unreadable, degrading those two to a stated `unknownReason`. BLOCKERS needs no plan at all. */
  plan?: Plan;
  /** The batched GitHub gateway (status.ts's `buildBatchedGithub`) backing QUEUE HEAD's eligibility and INBOX's
   *  dep-merged predicate — read ONCE per render, never per row. Omitted or failing degrades exactly those two to a
   *  stated `unknownReason`; every other section is unaffected. */
  github?: GitHub;
  /** Local (no-network) evidence-anchor grep for INBOX; defaults to inbox.ts's `gitGrepAnchorTrue(repoDir,
   *  "origin/main", anchor)`. */
  grepAnchorTrue?: (anchor: EvidenceAnchor) => boolean;
  /** `state/inbox-proposals.json` reader; defaults to the real file under `root`, parsed by inbox.ts's own
   *  fail-soft-to-empty `parseProposalRegistry`. */
  readProposalRegistry?: () => Proposal[];
  /** `state/inbox-drafts.json` reader; defaults to the real file under `root`, parsed by inbox.ts's own
   *  fail-soft-to-empty `parseDraftCache`. */
  readDraftCache?: () => DraftCache;
  /** The headroom-governor switch (config.ts's `resolveHeadroomEnabled`) — a config read, injected like `queryService`
   *  rather than re-derived in lib/ (Rule 16). Omitted falls back to the product default (`true`), never a fabricated
   *  "off". */
  resolveHeadroomEnabled?: () => boolean;
  /** Max rows QUEUE HEAD and BLOCKERS' blocked-PR class each show; defaults to 5. */
  queueHeadLimit?: number;
  /** W1-T1205: raw `git ls-remote --heads origin 'run-*'` output, parsed by drain.ts's {@link runBranchTaskIds} into
   *  the SAME `hasPushedRunBranch` predicate the dispatcher binds; QUEUE HEAD needs its own reader because this is a
   *  separate, unbatched call site. Live, no-fetch, git PROTOCOL. Returns `""`, never throws. */
  readPushedRunBranches?: (repoDir: string) => string;
  /** W1-T2264: read of the fleet-wide shared PAUSE hold (`sharedPauseRef`) — a git ref the file-sourced latch loop
   *  cannot see. Exactly ONE `git ls-remote`, never `checkSharedPause`, whose local-first fold would duplicate the
   *  local PAUSE row. Returns `"unreachable"`, never `"absent"`, when origin cannot be reached. */
  readSharedPauseState?: (repoDir: string) => SharedPauseRead;
  /** W1-T2270: read of every held per-task dispatch claim (`refs/rmd-dispatch/<taskId>`), the namespace STATIC_LATCHES
   *  cannot see. `decideDispatchClaimRelease` refuses a timed expiry because a stranded claim is "a visible ref an
   *  operator can drop"; this read makes that true. ONE `git ls-remote`; `{status: "unreachable"}` is never "no claim
   *  held". */
  readDispatchClaims?: (repoDir: string) => DispatchClaimsRead;
}

// ── origin/main (local, no fetch) ───────────────────────────────────────────────────────────

function defaultResolveOriginMainSha(repoDir: string): string | undefined {
  try {
    const sha = execFileSync("git", ["-C", repoDir, "rev-parse", "origin/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Real default for {@link StatusBoardDeps.readPushedRunBranches} — see that field's own doc. */
function defaultReadPushedRunBranches(repoDir: string): string {
  try {
    return execFileSync("git", ["-C", repoDir, "ls-remote", "--heads", "origin", "run-*"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return "";
  }
}

/** Real default for {@link StatusBoardDeps.readSharedPauseState}. GUARDED ON `.git` EXISTING FIRST, so a `repoDir` that
 *  is not a checkout reads `"absent"`; a real checkout that cannot reach `origin` still reads `"unreachable"`. */
function defaultReadSharedPauseState(repoDir: string): SharedPauseRead {
  if (!fs.existsSync(join(repoDir, ".git"))) return "absent";
  return readSharedPause(realSharedPauseGitDeps(repoDir));
}

/** W1-T2270: every held `refs/rmd-dispatch/<taskId>` claim via exactly ONE `git ls-remote` — {@link
 *  defaultReadSharedPauseState}'s cost profile over a namespace. `"unreachable"` on a nonzero exit: a failed read is
 *  never `"clear"`. `holder` is the anchor's own sha, never a second round trip to decode the pid and host. */
export type DispatchClaimsRead =
  | { readonly status: "clear" }
  | { readonly status: "held"; readonly claims: ReadonlyArray<{ readonly taskId: string; readonly holder: string }> }
  | { readonly status: "unreachable" };

/** Every `refs/rmd-dispatch/<taskId>` line off the `ls-remote`, parsed the same split-on-tab way {@link
 *  runBranchTaskIds} parses its own sweep — a malformed or unrelated line is skipped rather than thrown. */
function parseDispatchClaimLsRemote(output: string): ReadonlyArray<{ taskId: string; holder: string }> {
  const prefix = dispatchClaimRef(""); // "refs/rmd-dispatch/" — the SAME builder the reserver uses
  const out: Array<{ taskId: string; holder: string }> = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !ref.startsWith(prefix)) continue;
    const taskId = ref.slice(prefix.length);
    if (taskId) out.push({ taskId, holder: sha });
  }
  return out;
}

/** Real default for {@link StatusBoardDeps.readDispatchClaims}. Guarded on `.git` existing first, like {@link
 *  defaultReadSharedPauseState}: no repo here means no remote could exist to be unreachable. */
function defaultReadDispatchClaims(repoDir: string): DispatchClaimsRead {
  if (!fs.existsSync(join(repoDir, ".git"))) return { status: "clear" };
  let stdout: string;
  try {
    stdout = execFileSync("git", ["-C", repoDir, "ls-remote", "origin", `${dispatchClaimRef("")}*`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return { status: "unreachable" };
  }
  const claims = parseDispatchClaimLsRemote(stdout);
  return claims.length ? { status: "held", claims } : { status: "clear" };
}

// ── Ledger derivation ────────────────────────────────────────────────────────────────────────

interface BootInfo {
  ts?: string;
  headSha?: string;
  /** Every `daemon.boot` line ({@link detectDaemonCrashLoop} sorts internally), each carrying why the boot before it
   *  ended (W1-T2450). One preceded by a `daemon.summary` with `stopReason: "stale"` was a FRESHNESS restart, tagged so
   *  routine restarts are told from crashes. */
  allBoots: DaemonBootTimestamp[];
}

function deriveDaemonBoots(lines: ReadonlyArray<Record<string, unknown>>): BootInfo {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestHeadSha: string | undefined;
  // W1-T2450: every `daemon.summary` line's `ts`/`stopReason`, gathered in the SAME pass and paired to each boot by
  // nearest-preceding timestamp, never input order — a rotation union is not guaranteed chronological.
  const summaries: { ms: number; stopReason?: string }[] = [];
  const bootLines: { ts: string; ms: number; headSha?: string }[] = [];
  for (const line of lines) {
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (line.step === "daemon.summary") {
      if (Number.isFinite(parsed)) summaries.push({ ms: parsed, stopReason: typeof line.stopReason === "string" ? line.stopReason : undefined });
      continue;
    }
    if (line.step !== "daemon.boot") continue;
    if (ts) bootLines.push({ ts, ms: parsed, headSha: typeof line.head_sha === "string" ? line.head_sha : undefined });
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestHeadSha = typeof line.head_sha === "string" ? line.head_sha : undefined;
  }
  summaries.sort((a, b) => a.ms - b.ms);
  const allBoots: DaemonBootTimestamp[] = bootLines.map((boot) => {
    if (!Number.isFinite(boot.ms)) return { ts: boot.ts };
    let nearest: { ms: number; stopReason?: string } | undefined;
    for (const s of summaries) {
      if (s.ms >= boot.ms) break; // summaries is ascending: the first non-earlier one ends the search
      nearest = s;
    }
    return nearest?.stopReason === "stale" ? { ts: boot.ts, priorExitReason: "freshness" } : { ts: boot.ts };
  });
  return { ts: bestTs, headSha: bestHeadSha, allBoots };
}

/** The newest `daemon.*` activity strictly after `sinceTs` — prefix-matched exactly as `deriveLastPoll`
 *  (daemon-health.ts) matches, NEVER on a step name. Why: the ten hours LAST CYCLE stayed pinned —
 *  docs/forensics/status-board.md */
function newestDaemonActivityAfter(
  lines: ReadonlyArray<Record<string, unknown>>,
  sinceTs: string | undefined,
): string | undefined {
  if (!sinceTs) return undefined;
  const since = Date.parse(sinceTs);
  if (!Number.isFinite(since)) return undefined;
  let bestTs: string | undefined;
  let best = -Infinity;
  for (const line of lines) {
    const step = typeof line.step === "string" ? line.step : undefined;
    if (!step || !step.startsWith("daemon.")) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed <= since || parsed < best) continue;
    best = parsed;
    bestTs = ts;
  }
  return bestTs;
}

function deriveLastCycle(lines: ReadonlyArray<Record<string, unknown>>): { ts?: string; summary?: LastCycleSummary } {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestSummary: LastCycleSummary | undefined;
  for (const line of lines) {
    if (line.step !== "daemon.summary") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestSummary = {
      attempted: Array.isArray(line.attempted) ? (line.attempted as unknown[]).filter((x): x is string => typeof x === "string") : [],
      merged: Array.isArray(line.merged) ? (line.merged as unknown[]).filter((x): x is string => typeof x === "string") : [],
      stopReason: typeof line.stopReason === "string" ? line.stopReason : "unknown",
      stopDetail: typeof line.stopDetail === "string" ? line.stopDetail : undefined,
      costUsd: typeof line.costUsd === "number" ? line.costUsd : 0,
      ticks: typeof line.ticks === "number" ? line.ticks : 0,
    };
  }
  return { ts: bestTs, summary: bestSummary };
}

interface SupervisorTick {
  ts?: string;
  step?: string;
}

/** The latest `deploy.*` ledger line — every `rmd deploy-run` cycle logs exactly one, so this is the supervisor's
 *  recency heartbeat, read as {@link deriveDaemonBoots} reads the daemon's. Failure comes from `launchctl list`'s exit
 *  code, never a step name. */
function deriveSupervisorTick(lines: ReadonlyArray<Record<string, unknown>>): SupervisorTick {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestStep: string | undefined;
  for (const line of lines) {
    const step = typeof line.step === "string" ? line.step : undefined;
    if (!step || !step.startsWith("deploy.")) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestStep = step;
  }
  return { ts: bestTs, step: bestStep };
}

// ── LATCHES table (DATA — a marker added later is a row, not a branch) ─────────────────────────

function readJsonMarker(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // absent, or present-but-unparseable — either way, no extra detail to show
  }
}

/** AGE for a marker file: prefer its own `requestedAt`/`at` JSON field; fall back to the file's mtime (e.g.
 *  DEPLOY_AUTO, a bare touch file with no JSON body at all). */
function markerAgeMs(path: string, json: Record<string, unknown> | null, nowMs: number): number | undefined {
  const iso = typeof json?.requestedAt === "string" ? json.requestedAt : typeof json?.at === "string" ? json.at : undefined;
  const parsed = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(parsed)) return Math.max(0, nowMs - parsed);
  try {
    return Math.max(0, nowMs - fs.statSync(path).mtimeMs);
  } catch {
    return undefined;
  }
}

interface StaticLatchDef {
  name: string;
  path: (root: string) => string;
  consequence: (json: Record<string, unknown> | null) => string;
  /** Optional: why this latch's instruction no longer applies — see {@link LatchRow.superseded}. */
  superseded?: (json: Record<string, unknown> | null, originMainSha?: string) => string | undefined;
}

/** What a DEPLOY_FAILED latch actually MEANS, branched on the `kind` the deployer wrote. THE TWO KINDS MUST NOT SHARE A
 *  SENTENCE: the dirty-tree arm returns before `pullFf`, so nothing is pulled or reset, and only the health-check arm
 *  rolls back. An unrecognised `kind` renders NEITHER — asserting one of two incompatible facts on no evidence is the
 *  defect. The deployer's message is appended VERBATIM on every arm. */
export function deployFailedConsequence(json: Record<string, unknown> | null): string {
  const kind = typeof json?.kind === "string" ? json.kind : undefined;
  const failedHead = typeof json?.failedHead === "string" ? json.failedHead.slice(0, 12) : undefined;
  const rawMessage = typeof json?.message === "string" ? json.message : undefined;
  // The old default asserted a health-check failure, which is the same unfounded claim one level down — a message-less
  // alert says only that a deploy failed.
  const message = rawMessage ?? "no message recorded";
  const detail = `(${message}${failedHead ? `; failed head ${failedHead}` : ""})`;

  if (kind === "dirty-tree-conflict") {
    return (
      `the fast-forward was REFUSED and nothing was deployed — the checkout was NOT pulled or reset ` +
      `and the daemon is still on the head it already had; the named files are uncommitted local ` +
      `changes in the install checkout ${detail}`
    );
  }
  if (kind === "health-check-rollback") {
    return `the checkout was rolled back — the daemon is running the PRIOR head ${detail}`;
  }
  return (
    `a deploy failed and the alert does not record WHICH kind — it may have been rolled back or ` +
    `refused before pulling; check the deploy.* ledger rows rather than assuming either ${detail}`
  );
}

/** Ordered by operational urgency — also the order rows render in (most-actionable first). */
const STATIC_LATCHES: readonly StaticLatchDef[] = [
  {
    name: "DEPLOY_FAILED",
    path: deployFailedAlertPath,
    consequence: (json) => deployFailedConsequence(json),
    // THE DEPLOYER'S OWN RETRY TEST, REUSED RATHER THAN RESTATED. `decideDeployTrigger` refuses an auto-retry only
    // while `originMain === lastFailedHead`, so past that head the supervisor retries by itself. One `sameCommit` call:
    // advice and machinery cannot disagree.
    superseded: (json, originMainSha) => {
      const failedHead = typeof json?.failedHead === "string" ? json.failedHead : undefined;
      if (!failedHead || !originMainSha) return undefined; // cannot tell ⇒ the instruction stands
      if (sameCommit(originMainSha, failedHead)) return undefined; // still the head to deploy
      return `origin/main has moved past the failed head — the supervisor retries on its own; nothing to re-deploy`;
    },
  },
  {
    name: "STOP",
    path: stopFilePath,
    consequence: (json) => {
      const reason = typeof json?.reason === "string" ? json.reason : undefined;
      return (
        `the running drain/daemon halts within one tick${reason ? ` (${reason})` : ""}` +
        ` — one-shot, auto-clears when that run ends`
      );
    },
  },
  {
    name: "PAUSE",
    path: pauseFilePath,
    consequence: (json) => {
      const reason = typeof json?.reason === "string" ? json.reason : undefined;
      return `no new task spawns until \`rmd resume\`${reason ? ` (${reason})` : ""} — any in-flight task still completes`;
    },
  },
  {
    name: "QUIET_HOURS",
    path: quietHoursFilePath,
    consequence: () => "quiet-hours preference is set (an optional throttle a future scheduler consumer reads)",
  },
  {
    name: "DEPLOY_AUTO",
    path: deployAutoPath,
    consequence: () => "the supervisor auto-deploys any new origin/main HEAD once health-checked, without a manual `rmd deploy`",
  },
];

function buildLatchRows(
  root: string,
  nowMs: number,
  isPidAlive: (pid: number) => boolean,
  // A pre-bound thunk (the caller has already closed over `deps.repoDir`), mirroring `isPidAlive` above, so a test can
  // inject any three-way answer without needing a real repo checkout.
  readSharedPauseState: () => SharedPauseRead,
  // APPENDED LAST and optional, so no positional caller shifts. `undefined` (origin/main unresolvable) claims NO
  // supersession and the instruction stands — an unreadable answer must never silence a real failure.
  originMainSha?: string,
  // W1-T2270: same pre-bound-thunk shape and same appended-last convention as above. Omitted reads as `{status:
  // "clear"}`, matching a repo that has never taken a dispatch claim.
  readDispatchClaims: () => DispatchClaimsRead = () => ({ status: "clear" }),
  // W1-T2446: same appended-last convention — the merge credit the held-claim row's text asserted away rather than
  // consulted. It only stops that row claiming "no landed work observed" for a merged task. Omitted reads as `() =>
  // false`.
  isMerged: MergedSet = () => false,
): LatchRow[] {
  const rows: LatchRow[] = [];

  for (const def of STATIC_LATCHES) {
    const path = def.path(root);
    if (!fs.existsSync(path)) continue;
    const json = readJsonMarker(path);
    rows.push({
      name: def.name,
      ageMs: markerAgeMs(path, json, nowMs),
      consequence: def.consequence(json),
      superseded: def.superseded?.(json, originMainSha),
    });
  }

  // Shared cross-host PAUSE hold (W1-T2264) — `refs/rmd-pause/hold`, a git ref every row above is blind to, read via
  // ONE `ls-remote`. DEDUP, LOCAL FIRST: `rmd pause` writes the local flag AND pushes this ref, so a self-paused host
  // would show its hold twice.
  if (!rows.some((r) => r.name === "PAUSE")) {
    const sharedPause = readSharedPauseState();
    if (sharedPause === "held") {
      rows.push({
        name: "SHARED_PAUSE",
        consequence:
          `no new task spawns fleet-wide until \`rmd resume\` clears ${sharedPauseRef()} — ` +
          "any in-flight task still completes",
      });
    } else if (sharedPause === "unreachable") {
      // FAIL SOFT, NEVER SILENT AND NEVER "CLEAR" (Q3): an unreachable remote is scored as `readSharedPause` scores it
      // for dispatch — held, not absent — but this row says which state it saw rather than asserting a hold it cannot
      // confirm.
      rows.push({
        name: "SHARED_PAUSE",
        consequence:
          `cannot reach origin to read ${sharedPauseRef()} — holding rather than dispatching ` +
          "optimistically (an unreachable remote is never read as clear)",
      });
    }
  }

  // Per-task dispatch claims (W1-T2270) — `refs/rmd-dispatch/<taskId>`, a namespace STATIC_LATCHES cannot see.
  // `decideDispatchClaimRelease` leaves another lane's claim to an OPERATOR because cross-host liveness is undecidable;
  // this row makes it findable.
  const dispatchClaims = readDispatchClaims();
  if (dispatchClaims.status === "held") {
    for (const { taskId, holder } of dispatchClaims.claims) {
      // W1-T2446: "with no landed work observed" was asserted UNCONDITIONALLY, so for a task whose work HAD landed the
      // board kept saying it had not. `isMerged` is the SAME projection this render already built; the drop stays the
      // operator's.
      rows.push({
        name: `dispatch-claim:${taskId}`,
        consequence: isMerged(taskId)
          ? `${taskId}'s dispatch claim ${dispatchClaimRef(taskId)} is held (holder ${holder}) — ${taskId} ` +
            `is credited MERGED, so this claim is stale, not live-guarded work: drop it with ` +
            `git push origin :${dispatchClaimRef(taskId)}`
          : `${taskId}'s dispatch claim ${dispatchClaimRef(taskId)} is held (holder ${holder}) with no ` +
            `landed work observed — a new dispatch of ${taskId} is refused until an operator drops it: ` +
            `git push origin :${dispatchClaimRef(taskId)}`,
      });
    }
  } else if (dispatchClaims.status === "unreachable") {
    // UNDETERMINED, NEVER "NO CLAIM HELD" (Q3's own fail-closed direction, applied here): a failed read must not
    // silently render as a clear fleet — it names what it could not tell.
    rows.push({
      name: "DISPATCH_CLAIMS",
      consequence:
        `cannot reach origin to read held dispatch claims (${dispatchClaimRef("")}*) — undetermined, ` +
        "not clear: a task may be silently stranded on another lane's unreleased claim and this board " +
        "cannot yet tell which",
    });
  }

  // Inflight locks — one row per LIVE lock (a dead-pid lock is stale debris, not an active latch — mirrors
  // run-task.ts's own liveInflightRuns definition of "in flight").
  const inflightDir = join(root, "state", "inflight");
  try {
    for (const entry of fs.readdirSync(inflightDir)) {
      if (!entry.endsWith(".lock")) continue;
      const taskId = entry.slice(0, -".lock".length);
      const info = readInflightLock(inflightDir, taskId);
      if (!info || !isPidAlive(info.pid)) continue;
      const parsed = Date.parse(info.startedAt);
      rows.push({
        name: `inflight:${taskId}`,
        ageMs: Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined,
        consequence: `a run of ${taskId} is in flight (pid ${info.pid}, run ${info.run_id}) — a second dispatch of the same task is refused until this releases`,
      });
    }
  } catch {
    // no state/inflight dir yet — nothing in flight
  }

  // Pending kicks — the console's "Run now" marker, one per queued task id.
  for (const kick of pendingKicks(root)) {
    const parsed = Date.parse(kick.requestedAt);
    rows.push({
      name: `kick:${kick.taskId}`,
      ageMs: Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined,
      consequence: `${kick.taskId} will be dispatched at the daemon's next poll, if runnable`,
    });
  }

  // drain-now — PEEK ONLY, never consume (consuming is exclusively the daemon's own job; a status read must never have
  // the side effect of erasing the very request it reports).
  const drainNowPath = drainNowFilePath(root);
  if (fs.existsSync(drainNowPath)) {
    const json = readJsonMarker(drainNowPath);
    rows.push({
      name: "drain-now",
      ageMs: markerAgeMs(drainNowPath, json, nowMs),
      consequence: "the daemon runs one dispatch cycle immediately at its next poll",
    });
  }

  return rows;
}

// ── NEXT ACTION tables (policy as data — rule 2) ────────────────────────────────────────────────

interface NextActionRule<TCtx> {
  applies: (ctx: TCtx) => boolean;
  action: (ctx: TCtx) => string;
}

function pickNextAction<TCtx>(rules: readonly NextActionRule<TCtx>[], ctx: TCtx): string | undefined {
  for (const rule of rules) {
    if (rule.applies(ctx)) return rule.action(ctx);
  }
  return undefined;
}

interface LivenessCtx {
  services: ServiceLivenessRow[];
  headVsOriginMain: StaleFlag;
  crashLoop: CrashLoopVerdict;
}

const LIVENESS_NEXT_ACTIONS: readonly NextActionRule<LivenessCtx>[] = [
  {
    // Incident (b): a crash-loop must read as a named condition, never "queue not processing".
    applies: (ctx) => ctx.crashLoop.breached,
    action: (ctx) =>
      `crash-loop: ${ctx.crashLoop.windowBoots.length} boots in the last ${Math.round(ctx.crashLoop.windowMs / 60_000)}m — investigate the boot cause before restarting anything`,
  },
  {
    applies: (ctx) => ctx.headVsOriginMain.status === "stale",
    action: (ctx) => {
      const s = ctx.headVsOriginMain as { status: "stale"; headSha: string; originSha: string };
      return (
        `the daemon is running stale code (${s.headSha.slice(0, 12)} vs origin/main ${s.originSha.slice(0, 12)})` +
        ` — \`rmd deploy\` to fast-forward + restart at the next idle gap`
      );
    },
  },
  {
    // W1-T2450: a daemon row reading `"unknown"` must never be advised on as a `"stopped"` one — `rmd up` is nonsense
    // for a process this panel never asked about. Checked BEFORE the `"stopped"` rule so the unknown case wins.
    applies: (ctx) => {
      const row = ctx.services.find((s) => s.service === "daemon");
      return row !== undefined && livenessState(row) === "unknown";
    },
    action: () =>
      "no launchd sensor on this host (`launchctl` unavailable) — daemon/deploy-supervisor " +
      "liveness cannot be read here; confirm with `ps` instead",
  },
  {
    applies: (ctx) => {
      const row = ctx.services.find((s) => s.service === "daemon");
      return row !== undefined && livenessState(row) === "stopped";
    },
    action: () => "the daemon is not running — `rmd up` (or `rmd daemon ...`) to resume the fleet",
  },
  {
    // deploy-supervisor is a periodic one-shot: `running: false` between ticks is its NORMAL rest state, so this fires
    // only once a tick is actually overdue or failing.
    applies: (ctx) => {
      const row = ctx.services.find((s) => s.service === "deploy-supervisor");
      return row !== undefined && livenessState(row) === "overdue";
    },
    action: (ctx) => {
      const row = ctx.services.find((s) => s.service === "deploy-supervisor")!;
      return row.lastExitCode !== undefined && row.lastExitCode !== 0
        ? `deploy-supervisor's last run exited ${row.lastExitCode} — check state/logs/supervisor.err.log`
        : "deploy-supervisor has missed its interval — check it is loaded (`launchctl print gui/$UID/com.remudero.supervisor`) and state/logs/supervisor.err.log";
    },
  },
];

const LATCHES_NEXT_ACTIONS: readonly NextActionRule<LatchesSection>[] = [
  {
    // Incident (a): DEPLOY_FAILED must never sit invisible again. `!r.superseded` IS THE FIX — a row whose failed head
    // origin/main has passed needs no action, so the row stays and the instruction goes.
    applies: (ctx) => ctx.rows.some((r) => r.name === "DEPLOY_FAILED" && !r.superseded),
    action: () => "inspect state/DEPLOY_FAILED and re-deploy once fixed (`rmd deploy`)",
  },
  {
    applies: (ctx) => ctx.rows.some((r) => r.name === "STOP"),
    action: () => "STOP is set — no action needed unless unexpected; it auto-clears when the halted run ends",
  },
  {
    // W1-T2264: this row can be a hold ANOTHER host set, so — unlike PAUSE below — it never names the releasing action.
    // The row's own consequence already names the ref and the remedy.
    applies: (ctx) => ctx.rows.some((r) => r.name === "SHARED_PAUSE"),
    action: () => "a cross-host hold may be affecting dispatch beyond this host — see the SHARED_PAUSE row above before assuming it is local",
  },
  {
    // W1-T2270: same reasoning as SHARED_PAUSE above — never names the releasing action itself, and this covers both
    // the confirmed-held rows and the single unreachable-remote row.
    applies: (ctx) => ctx.rows.some((r) => r.name.startsWith("dispatch-claim:") || r.name === "DISPATCH_CLAIMS"),
    action: () =>
      "a per-task dispatch claim may be stranding a task on another lane — see the dispatch-claim row(s) above for the ref and holder to drop",
  },
  {
    applies: (ctx) => ctx.rows.some((r) => r.name === "PAUSE"),
    action: () => "no new work will dispatch — `rmd resume` when ready to continue",
  },
];

const LAST_CYCLE_NEXT_ACTIONS: readonly NextActionRule<LastCycleSection>[] = [
  {
    applies: (ctx) => ctx.found && ctx.summary?.stopReason === "blocked" && !ctx.supersededByTs,
    action: (ctx) => `the last cycle stopped BLOCKED${ctx.summary?.stopDetail ? ` — ${ctx.summary.stopDetail}` : ""} — resolve the blocking task before the next cycle`,
  },
  {
    applies: (ctx) => ctx.found && ctx.summary?.stopReason === "error" && !ctx.supersededByTs,
    action: (ctx) => `the last cycle stopped on an unexpected ERROR${ctx.summary?.stopDetail ? ` — ${ctx.summary.stopDetail}` : ""} — check the ledger around this run`,
  },
];

// ── W1-T280 helpers — plan/GitHub read (once) ───────────────────────────────────────────────

function tryLoadDefaultPlan(repoDir: string): Plan | undefined {
  try {
    return loadPlan(join(repoDir, "plan", "tasks.yaml"));
  } catch {
    return undefined; // no tasks.yaml at repoDir (offline checkout, test fixture, ...) — never a throw
  }
}

function readTextFileIfExists(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** ONE batched projection pass over the whole plan (status.ts's `projectPlan`, which fetches GitHub once and shares it)
 *  — the single remote read backing QUEUE HEAD's eligibility, INBOX's dep-merged predicate and BLOCKERS'
 *  `indeterminate` class. Returns a stated `unknownReason` instead: never a throw, never a per-row fetch. */
function projectPlanOnce(
  plan: Plan | undefined,
  github: GitHub | undefined,
  ledgerPath: string,
  lines: Array<Record<string, unknown>>,
  now: () => number,
): { projections?: Map<string, StatusProjection>; unknownReason?: string } {
  if (!plan) return { unknownReason: "plan/tasks.yaml is unreadable — dispatch eligibility cannot be resolved" };
  if (!github) return { unknownReason: "no GitHub gateway configured for this read" };
  const deriveDeps: DeriveDeps = { ledgerPath, github, readLedger: () => lines, now };
  let projections: Map<string, StatusProjection> | undefined;
  try {
    projections = projectPlan(plan, deriveDeps);
  } catch (e) {
    return { unknownReason: `GitHub projection failed unexpectedly (${String((e as Error)?.message ?? e)})` };
  }
  if (github.readFailed?.()) {
    const reason = github.readFailureReason?.() ?? "unknown";
    return { unknownReason: `GitHub gateway unreachable (${reason})` };
  }
  return { projections };
}

// ── BLOCKERS BY CLASS derivation ────────────────────────────────────────────────────────────

/** Every distinct task id the ledger has EVER dispatched, from its own `run.start` history — no plan needed here.
 *  W1-T2335: {@link deriveCircuitBrokenBlockers} consults the plan separately; this enumeration is unaffected. */
function distinctDispatchedTaskIds(lines: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    // W1-T2383 rank 3: QUEUE dispatches only. A triage or retro `run.start` names an id no dispatch will ever take —
    // see `isQueueDispatchRunStart`'s own doc for the two ids this measurably spared.
    if (isQueueDispatchRunStart(line) && typeof line.task_id === "string") ids.add(line.task_id);
  }
  return [...ids];
}

/** Every `run.start` line's own `ts`, oldest first — the SAME scan {@link distinctDispatchedTaskIds} makes, keeping the
 *  timestamps it discards. An unparseable row is skipped rather than allowed to corrupt a derived cadence. */
function dispatchRunStarts(lines: Array<Record<string, unknown>>): Array<{ ts: string; parsed: number }> {
  const out: Array<{ ts: string; parsed: number }> = [];
  for (const line of lines) {
    // W1-T2383 rank 3: QUEUE dispatches only — this cadence's own doc calls the bound "the longest observed gap between
    // DISPATCHES", and a lane run is not one.
    if (!isQueueDispatchRunStart(line)) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts !== undefined ? Date.parse(ts) : NaN;
    if (ts !== undefined && Number.isFinite(parsed)) out.push({ ts, parsed });
  }
  out.sort((a, b) => a.parsed - b.parsed);
  return out;
}

/** How much this module multiplies the longest OBSERVED inter-dispatch gap to get the QUEUE HEAD staleness bound — the
 *  factor {@link SUPERVISOR_TICK_OVERDUE_MS} already applies. 3x the worst gap this host produced beats a guessed round
 *  figure. */
const QUEUE_HEAD_STALL_MULTIPLIER = 3;

interface DispatchCadence {
  /** The newest `run.start` seen, when any was — present even with only one ever recorded. */
  newestTs?: string;
  /** Present only once at least TWO dispatches have been observed and they didn't all land at the same instant — with
   *  fewer, there is no gap to learn a cadence from at all. */
  boundMs?: number;
  boundDerivation?: string;
}

/** Derives the QUEUE HEAD staleness bound from THIS HOST'S OWN `run.start` history, never a constant. Fewer than two
 *  dispatches, or all at one instant, leaves it undefined. W1-T1047: EXPORTED for `rmd doctor`. */
export function deriveDispatchCadence(lines: Array<Record<string, unknown>>): DispatchCadence {
  const dispatches = dispatchRunStarts(lines);
  if (dispatches.length === 0) return {};
  const newest = dispatches[dispatches.length - 1]!;
  if (dispatches.length < 2) return { newestTs: newest.ts };
  let maxGapMs = 0;
  for (let i = 1; i < dispatches.length; i++) {
    maxGapMs = Math.max(maxGapMs, dispatches[i]!.parsed - dispatches[i - 1]!.parsed);
  }
  if (maxGapMs <= 0) return { newestTs: newest.ts }; // every dispatch at the same instant — no gap to learn from
  return {
    newestTs: newest.ts,
    boundMs: maxGapMs * QUEUE_HEAD_STALL_MULTIPLIER,
    boundDerivation: `${QUEUE_HEAD_STALL_MULTIPLIER}x the longest observed gap between dispatches on this host (${formatAgeMs(maxGapMs)} over ${dispatches.length} run.start rows)`,
  };
}

/** W1-T2415: ONE wording for the breaker's own reset condition, shared by the BLOCKERS class and the QUEUE HEAD refusal
 *  row. Extracted rather than copied — two surfaces describing one breaker in two sentences is how they drift. */
function circuitBreakerResetNote(taskId: string, dispatchCount: number): string {
  return `resets only on a fresh owned PR for ${taskId} — ${dispatchCount}/${DEFAULT_MAX_TASK_DISPATCHES} dispatches since the last one`;
}

/** W1-T2335: skips a task `isDispatchEligible` (drain.ts) already refuses two guards earlier — plan-declared `status:
 *  "blocked"`, and a task the projection credits MERGED. Neither input changes a dispatch decision, so the row returns
 *  the moment the task is dispatchable. W1-T2383: EXPORTED so the queue-dispatch guard is provable. */
export function deriveCircuitBrokenBlockers(
  lines: Array<Record<string, unknown>>,
  plan: Plan | undefined,
  projections: Map<string, StatusProjection> | undefined,
): CircuitBrokenBlocker[] {
  const out: CircuitBrokenBlocker[] = [];
  for (const taskId of distinctDispatchedTaskIds(lines)) {
    if (!isDispatchBreakerTripped(lines, taskId)) continue;
    const planTask = plan?.tasks.find((t) => t.id === taskId);
    if (planTask?.status === "blocked") continue; // dispatch will never take it — plan already excludes it
    if (projections?.get(taskId)?.merged) continue; // landed since — no longer news (mirrors deriveIndeterminateBlockers)
    const dispatchCount = dispatchesWithoutNewOwnedPr(lines, taskId);
    out.push({
      kind: "circuit_broken",
      taskId,
      dispatchCount,
      maxDispatches: DEFAULT_MAX_TASK_DISPATCHES,
      resetNote: circuitBreakerResetNote(taskId, dispatchCount),
    });
  }
  return out;
}

/** The newest `dispatch.indeterminate` line per task id — a PURE ledger read, never gated on GitHub. Skips a task the
 *  projection confirms MERGED. `ghWindowNote` is enriched when the projection agrees it is still indeterminate, never
 *  blank. */
function deriveIndeterminateBlockers(
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
): IndeterminateBlocker[] {
  const out: IndeterminateBlocker[] = [];
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.step !== "dispatch.indeterminate" || typeof line.task_id !== "string") continue;
    const taskId = line.task_id;
    if (seen.has(taskId)) continue; // only the NEWEST occurrence per task
    seen.add(taskId);
    if (projections?.get(taskId)?.merged) continue; // landed since — no longer news
    const p = projections?.get(taskId);
    const ghWindowNote =
      p?.indeterminate && p.unavailableReason
        ? `the GitHub read could not decide (${p.unavailableReason}${p.githubUnobservableSince ? `, unobservable since ${p.githubUnobservableSince}` : ""}) — a gateway window, not a claim that the task itself is broken`
        : "flagged indeterminate at its last dispatch attempt (ledger: dispatch.indeterminate) — a gateway/ledger window, not a claim that the task itself is broken";
    out.push({ kind: "indeterminate", taskId, ghWindowNote });
  }
  return out;
}

/** sweep.ts's `runSweep` dispositions meaning "not progressing" — the vocabulary sweep.ts minted (W1-T186), never a
 *  second taxonomy. `"mergeable"`/`"post-review"`/`"dep-review"`/`"wait"` are in-progress states, not blockers. */
const BLOCKED_PR_DISPOSITIONS: ReadonlySet<string> = new Set(["blocked-fixable", "blocked-ambiguous", "conflicted", "stale"]);

/** The newest `sweep.disposed` line per PR number, filtered to the not-progressing dispositions — a PURE ledger read
 *  with no live-state opinion. Callers re-derive it against live state, or use the raw count only to say what they
 *  withheld. */
function rawBlockedPrCandidates(lines: Array<Record<string, unknown>>): BlockedPrBlocker[] {
  const latestByPr = new Map<number, Record<string, unknown>>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed") continue;
    if (typeof line.pr_number !== "number") continue;
    latestByPr.set(line.pr_number, line);
  }
  const rows: BlockedPrBlocker[] = [];
  for (const [prNumber, line] of latestByPr) {
    const disposition = typeof line.disposition === "string" ? line.disposition : undefined;
    if (!disposition || !BLOCKED_PR_DISPOSITIONS.has(disposition)) continue;
    const taskId = typeof line.task_id === "string" && line.task_id !== "SWEEP" ? line.task_id : undefined;
    const reason = typeof line.reason === "string" && line.reason.trim().length > 0 ? line.reason : "reason not named";
    rows.push({
      kind: "blocked_pr",
      taskId,
      prNumber,
      prUrl: typeof line.pr_url === "string" ? line.pr_url : undefined,
      disposition,
      reason,
    });
  }
  rows.sort((a, b) => {
    const tsA = typeof latestByPr.get(a.prNumber)?.ts === "string" ? (latestByPr.get(a.prNumber)!.ts as string) : "";
    const tsB = typeof latestByPr.get(b.prNumber)?.ts === "string" ? (latestByPr.get(b.prNumber)!.ts as string) : "";
    return tsB.localeCompare(tsA); // newest-disposed first
  });
  return rows;
}

/** {@link rawBlockedPrCandidates} RE-DERIVED against LIVE GitHub state (W1-T306 design (2): merge state is the
 *  authority) — a DIRECT `github.prByRef(row.prNumber)` on each candidate's OWN PR number, never a task's {@link
 *  StatusProjection}, which needs no plan and so honours {@link StatusBoardDeps.plan}'s claim. Called only once
 *  `github` is confirmed reachable. Why: the W1-T309 multi-dispatch seam — docs/forensics/status-board.md */
function deriveBlockedPrBlockers(candidates: BlockedPrBlocker[], github: GitHub, limit: number): BlockedPrBlocker[] {
  const isSettled = (prNumber: number): boolean => {
    const pr = github.prByRef(prNumber);
    return pr !== null && (pr.state.toUpperCase() === "MERGED" || pr.state.toUpperCase() === "CLOSED");
  };
  return candidates.filter((row) => !isSettled(row.prNumber)).slice(0, limit);
}

/** Human-readable label per {@link RetirementReason} — the plan's enum value doubles as the identifier, but the board
 *  renders this prose beside it so W1-T1287 acceptance 4 reads as a sentence, not a bare token. */
const RETIREMENT_REASON_LABELS: Record<RetirementReason, string> = {
  retired: "retired by operator ruling",
  closed: "closed unbuilt — resolved without being built",
  withdrawn: "withdrawn by the operator",
};

/** Plan-declared `status: "blocked"` tasks carrying a `retirement` ruling (W1-T1287) — a PURE plan read. Every other
 *  blocked task contributes no row, unchanged from before this field; Q3(ix) pins that in both directions. */
function deriveRetiredBlockers(plan: Plan | undefined): RetiredBlocker[] {
  if (!plan) return [];
  const out: RetiredBlocker[] = [];
  for (const t of plan.tasks) {
    if (t.status !== "blocked" || t.retirement === undefined) continue;
    out.push({ kind: "retired", taskId: t.id, reason: RETIREMENT_REASON_LABELS[t.retirement] });
  }
  return out;
}

function deriveBlockers(
  plan: Plan | undefined,
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  github: GitHub | undefined,
  limit: number,
): BlockersSection {
  const circuitBroken = deriveCircuitBrokenBlockers(lines, plan, projections);
  const indeterminate = deriveIndeterminateBlockers(lines, projections);
  const retired = deriveRetiredBlockers(plan);
  let blockedPrs: BlockedPrBlocker[] = [];
  let blockedPrsUnverifiedReason: string | undefined;
  const raw = rawBlockedPrCandidates(lines);
  if (raw.length > 0) {
    // W1-T309: gated on `github` alone, never on `projections`/`plan` — a missing plan must not withhold this class
    // when GitHub is perfectly reachable, since it needs no plan at all.
    if (github && !github.readFailed?.()) {
      // Live GitHub state IS reachable this cycle: re-derive against it, exactly as design (2).
      blockedPrs = deriveBlockedPrBlockers(raw, github, limit);
    } else {
      // W1-T306 design (4), DEGRADE HONESTLY: merge state cannot be read this cycle, and printing the raw ledger
      // dispositions would replay HISTORY as CURRENT. Withhold the class and say so.
      const reason = !github ? "no GitHub gateway configured for this read" : (github.readFailureReason?.() ?? "unknown");
      blockedPrsUnverifiedReason = `${raw.length} blocked-PR ledger ${raw.length === 1 ? "entry" : "entries"} could not be checked against live GitHub state (${reason}) — withheld rather than replay possibly-stale history as current`;
    }
  }
  const rows: BlockerRow[] = [...circuitBroken, ...indeterminate, ...blockedPrs, ...retired];
  const section: BlockersSection = { rows, blockedPrsUnverifiedReason };
  section.nextAction = pickNextAction(BLOCKERS_NEXT_ACTIONS, section);
  return section;
}

const BLOCKERS_NEXT_ACTIONS: readonly NextActionRule<BlockersSection>[] = [
  {
    applies: (ctx) => ctx.rows.some((r): r is CircuitBrokenBlocker => r.kind === "circuit_broken"),
    action: (ctx) => {
      const r = ctx.rows.find((row): row is CircuitBrokenBlocker => row.kind === "circuit_broken")!;
      return `${r.taskId}'s dispatch circuit is broken — ${r.resetNote}; investigate before it re-dispatches again`;
    },
  },
  {
    applies: (ctx) => ctx.rows.some((r): r is BlockedPrBlocker => r.kind === "blocked_pr"),
    action: (ctx) => {
      const r = ctx.rows.find((row): row is BlockedPrBlocker => row.kind === "blocked_pr")!;
      return `PR #${r.prNumber} is blocked (${r.disposition}): ${r.reason}`;
    },
  },
  {
    applies: (ctx) => ctx.rows.some((r): r is IndeterminateBlocker => r.kind === "indeterminate"),
    action: (ctx) => {
      const r = ctx.rows.find((row): row is IndeterminateBlocker => row.kind === "indeterminate")!;
      return `${r.taskId}'s GitHub read is indeterminate — ${r.ghWindowNote}`;
    },
  },
  {
    applies: (ctx) => ctx.blockedPrsUnverifiedReason !== undefined,
    action: (ctx) => `blocked-PR ledger entries are unverified — ${ctx.blockedPrsUnverifiedReason}`,
  },
];

// ── QUEUE HEAD derivation ────────────────────────────────────────────────────────────────────

/** One dispatch away from the streak breaker's own threshold — "at or near" per the design's own wording, so a
 *  perpetual-attempt task is flagged BEFORE it trips and forces an escalation, not only after. */
const PERPETUAL_ATTEMPT_THRESHOLD = DEFAULT_MAX_TASK_DISPATCHES - 1;

/** W1-T1047: EXPORTED so `rmd doctor` can call it with a LOCALLY-derived merged set. The `!projections ||
 *  ghUnknownReason` bail below is why a network outage blanks the stall check; doctor supplies local projections
 *  instead. */
export function deriveQueueHead(
  plan: Plan | undefined,
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  ghUnknownReason: string | undefined,
  limit: number,
  nowMs: number,
  // W1-T1205: OPTIONAL and TRAILING, so every existing caller — doctorCommand's deliberately network-free call among
  // them — keeps its byte-identical no-exclusion behaviour. `buildStatusBoard` supplies the one real reader.
  hasPushedRunBranch?: (taskId: string) => boolean,
): QueueHeadSection {
  if (!plan || !projections || ghUnknownReason) {
    const section: QueueHeadSection = {
      rows: [],
      refused: [],
      refusedTruncated: 0,
      unknownReason: ghUnknownReason ?? "plan/tasks.yaml is unreadable",
    };
    section.nextAction = pickNextAction(QUEUE_HEAD_NEXT_ACTIONS, section);
    return section;
  }
  const isMerged: MergedSet = (id) => projections.get(id)?.merged === true;
  const isIndeterminate = (id: string) => projections.get(id)?.indeterminate === true;
  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(lines, id);
  // W1-T1205 (design (i)): binds the SAME `hasPushedRunBranch` predicate the real dispatcher applies, so this
  // selector's eligible set can never drift wider than the dispatcher's own. `refused` names the exclusion rather than
  // letting the task vanish, capped exactly as `tallyDispatchFilters`'s buckets are.
  const refused: QueueHeadRefusedRow[] = [];
  let refusedTotal = 0;
  // ONE cap and ONE counter for every reason that reaches this list, so W1-T1205's `IDLE_REASON_ID_CAP` bound and its
  // `refusedTruncated` count keep meaning what they meant when only one reason could reach it.
  const pushRefused = (row: QueueHeadRefusedRow): void => {
    refusedTotal++;
    if (refused.length < IDLE_REASON_ID_CAP) refused.push(row);
  };
  const candidates = runnableCandidates(plan, isMerged, limit, {
    isIndeterminate,
    isCircuitTripped,
    hasPushedRunBranch,
    // W1-T2415: THE CALLBACK THIS FUNCTION ALREADY HAD AND NEVER SUPPLIED. A tripped task was always removed from
    // `rows`, but the one surface built to EXPLAIN a refusal could not name it. Observation only — the eligible set is
    // byte-identical.
    onCircuitBreak: (task) => {
      const dispatchCount = dispatchesWithoutNewOwnedPr(lines, task.id);
      pushRefused({
        taskId: task.id,
        title: task.title,
        reason: "circuit-broken",
        dispatchCount,
        maxDispatches: DEFAULT_MAX_TASK_DISPATCHES,
        // The SAME wording `deriveCircuitBrokenBlockers` renders, so the two surfaces cannot drift into two
        // descriptions of one breaker.
        resetNote: circuitBreakerResetNote(task.id, dispatchCount),
      });
    },
    onFiltered: (task, reason) => {
      // Scoped to this one reason — see `QueueHeadSection.refused`'s own doc for why the other `DispatchFilterReason`s
      // are deliberately not duplicated onto this surface.
      if (reason !== "run-branch-already-pushed") return;
      pushRefused({ taskId: task.id, title: task.title, reason });
    },
  });
  const refusedTruncated = Math.max(0, refusedTotal - refused.length);
  const rows: QueueHeadRow[] = candidates.map((t) => {
    const attempts = dispatchesWithoutNewOwnedPr(lines, t.id);
    const perpetual = attempts >= PERPETUAL_ATTEMPT_THRESHOLD;
    const row: QueueHeadRow = { taskId: t.id, title: t.title, attempts, perpetual };
    if (perpetual) {
      const runs = taskCardRuns(lines as Array<Record<string, unknown>>, t.id);
      const lastCosted = [...runs].reverse().find((r) => r.costUsd !== undefined);
      if (lastCosted) row.observedPerCycleCostUsd = lastCosted.costUsd;
    }
    return row;
  });
  const section: QueueHeadSection = { rows, refused, refusedTruncated };
  // W1-T450: candidates present AND no run.start newer than the observed-cadence bound is a stall. Never computed when
  // `rows` is empty, so the honest "nothing dispatchable" state cannot grow a stall it does not deserve.
  if (rows.length > 0) {
    const cadence = deriveDispatchCadence(lines);
    const lastDispatchParsed = cadence.newestTs !== undefined ? Date.parse(cadence.newestTs) : NaN;
    if (cadence.boundMs !== undefined && cadence.boundDerivation !== undefined && Number.isFinite(lastDispatchParsed)) {
      const sinceMs = Math.max(0, nowMs - lastDispatchParsed);
      if (sinceMs > cadence.boundMs) {
        section.stall = {
          candidateCount: rows.length,
          sinceMs,
          lastDispatchTs: cadence.newestTs!,
          boundMs: cadence.boundMs,
          boundDerivation: cadence.boundDerivation,
        };
      }
    }
  }
  section.nextAction = pickNextAction(QUEUE_HEAD_NEXT_ACTIONS, section);
  return section;
}

const QUEUE_HEAD_NEXT_ACTIONS: readonly NextActionRule<QueueHeadSection>[] = [
  { applies: (ctx) => ctx.unknownReason !== undefined, action: (ctx) => `queue head is unknown — ${ctx.unknownReason}` },
  {
    // W1-T450: eligible work sitting with ZERO dispatches for longer than this host's own observed cadence licenses —
    // the "a daemon failing every pass looks calm" falsifier. NOT A GATE: this rule only ever picks a line to print.
    applies: (ctx) => ctx.stall !== undefined,
    action: (ctx) => {
      const s = ctx.stall!;
      return (
        `${s.candidateCount} candidate(s) eligible but nothing has dispatched in ${formatAgeMs(s.sinceMs)}` +
        ` (bound ${formatAgeMs(s.boundMs)} — ${s.boundDerivation}) — confirm the daemon is actually ticking,` +
        ` not just running, before assuming these are about to dispatch`
      );
    },
  },
  {
    applies: (ctx) => ctx.rows.some((r) => r.perpetual),
    action: (ctx) => {
      const r = ctx.rows.find((row) => row.perpetual)!;
      const cost = r.observedPerCycleCostUsd !== undefined ? `~$${r.observedPerCycleCostUsd.toFixed(2)}/cycle` : "an unknown per-cycle cost";
      return `${r.taskId} has re-dispatched ${r.attempts} times with nothing new merged (${cost}) — investigate before it trips the circuit breaker`;
    },
  },
  {
    // W1-T1205 (rationale (4)): PERMANENT, not transient — GitHub deletes a head branch on MERGE but not on CLOSE, so
    // one left after an unmerged close never clears. W1-T2415: SCOPED, after handing run-branch advice to a breaker
    // refusal.
    applies: (ctx) => ctx.refused.some((r) => r.reason === "run-branch-already-pushed"),
    action: (ctx) => {
      const branchRefused = ctx.refused.filter((r) => r.reason === "run-branch-already-pushed");
      const r = branchRefused[0]!;
      const additional = branchRefused.length - 1 + ctx.refusedTruncated;
      const more = additional > 0 ? ` (+${additional} more)` : "";
      return `${r.taskId}${more} has a run branch already pushed to origin — dispatch will refuse it until that branch is gone (see \`rmd reap-branches\`)`;
    },
  },
  {
    // W1-T2415: LAST, so it never displaces a rule above — the breaker is a standing state, not a stall or a
    // re-dispatch burning spend now. Names the reset condition, because nothing here resets a breaker.
    applies: (ctx) => ctx.refused.some((r) => r.reason === "circuit-broken"),
    action: (ctx) => {
      const broken = ctx.refused.filter((r) => r.reason === "circuit-broken");
      const r = broken[0]!;
      const more = broken.length > 1 ? ` (+${broken.length - 1} more)` : "";
      return `${r.taskId}${more} is refused by the dispatch circuit breaker — ${r.resetNote ?? "it resets only on a fresh owned PR"}`;
    },
  },
];

/** EXPORTED for test only, as {@link renderQueueHeadBlock} already is. W1-T2637: lets a test prove both rules above stay reason-scoped for a `refused` reason the derivation cannot produce today; `deriveQueueHead`'s own scope guard is unchanged. */ export function pickQueueHeadNextAction(section: QueueHeadSection): string | undefined { return pickNextAction(QUEUE_HEAD_NEXT_ACTIONS, section); }

// ── INBOX derivation ─────────────────────────────────────────────────────────────────────────

function deriveInbox(
  plan: Plan | undefined,
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  ghUnknownReason: string | undefined,
  readProposalRegistry: () => Proposal[],
  readDraftCache: () => DraftCache,
  grepAnchorTrue: (a: EvidenceAnchor) => boolean,
): InboxSection {
  if (!plan || !projections || ghUnknownReason) {
    const section: InboxSection = { readyCount: 0, notReadyCount: 0, unknownReason: ghUnknownReason ?? "plan/tasks.yaml is unreadable" };
    section.nextAction = pickNextAction(INBOX_NEXT_ACTIONS, section);
    return section;
  }
  const proposals = readProposalRegistry();
  const drafts = readDraftCache();
  // W1-T510: `projections` carries one entry per `plan.tasks` — the SAME `plan` — so an id absent from it is absent
  // from `plan.byId`, which fails via `unmetDependencies`'s `!d` branch first. `=== true` is never an
  // absent-as-unmerged conflation.
  const isMerged: MergedResolver = (t) => projections.get(t.id)?.merged === true;
  const depsUnobservable = (taskId: string): GhFailureReason | undefined => {
    const p = projections.get(taskId);
    return p?.indeterminate === true ? (p.unavailableReason ?? "unknown") : undefined;
  };
  const ctx: ReadinessContext = {
    plan,
    isMerged,
    depsUnobservable,
    grepAnchorTrue,
    openProposalIds: new Set(proposals.map((p) => p.id)),
    isRatified: (id) => isRatifiedInLedger(lines, id),
  };
  const classifications: InboxClassification[] = proposals.map((p) => classifyProposal(p, drafts[p.id], ctx));
  const readyCount = classifications.filter((c) => c.state === "ready").length;
  const notReadyCount = classifications.length - readyCount;
  const headNotReady = classifications.find((c) => c.state !== "ready");
  const section: InboxSection = {
    readyCount,
    notReadyCount,
    headNotReadyReason: headNotReady ? refusalReason(headNotReady) : undefined,
  };
  section.nextAction = pickNextAction(INBOX_NEXT_ACTIONS, section);
  return section;
}

const INBOX_NEXT_ACTIONS: readonly NextActionRule<InboxSection>[] = [
  { applies: (ctx) => ctx.unknownReason !== undefined, action: (ctx) => `inbox readiness is unknown — ${ctx.unknownReason}` },
  { applies: (ctx) => ctx.readyCount > 0, action: (ctx) => `${ctx.readyCount} proposal(s) ready — \`rmd approve <id>\`` },
  {
    applies: (ctx) => ctx.notReadyCount > 0 && ctx.headNotReadyReason !== undefined,
    action: (ctx) => `next proposal not ready: ${ctx.headNotReadyReason}`,
  },
];

// ── HEADROOM derivation ──────────────────────────────────────────────────────────────────────

function deriveHeadroomLatest(lines: Array<Record<string, unknown>>): { ts?: string; telemetry?: HeadroomTelemetry } {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let best: HeadroomTelemetry | undefined;
  for (const line of lines) {
    if (line.step !== "daemon.headroom") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    best = {
      window: typeof line.window === "string" ? line.window : "unknown window",
      percentUsed: typeof line.percent_used === "number" ? line.percent_used : 0,
      limitPct: typeof line.limit_pct === "number" ? line.limit_pct : 0,
      resetsAt: typeof line.resets_at === "string" ? line.resets_at : undefined,
      note: typeof line.note === "string" ? line.note : undefined,
    };
  }
  return { ts: bestTs, telemetry: best };
}

/** The newest `daemon.headroom.degraded` line — the blind-governor signal. Same max-by-parsed-`ts` shape as {@link
 *  deriveHeadroomLatest}: an exact match on the dotted CHILD step, never its parent, and parsed timestamps, never
 *  ledger order. */
function deriveHeadroomDegraded(
  lines: Array<Record<string, unknown>>,
  nowMs: number,
): HeadroomDegraded | undefined {
  let bestParsed = -Infinity;
  let best: HeadroomDegraded | undefined;
  for (const line of lines) {
    if (line.step !== "daemon.headroom.degraded") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    best = {
      consecutiveUnreadable: typeof line.consecutive_unreadable === "number" ? line.consecutive_unreadable : undefined,
      pollIntervalMs: typeof line.poll_interval_ms === "number" ? line.poll_interval_ms : undefined,
      ts,
      ageMs: Math.max(0, nowMs - parsed),
    };
  }
  return best;
}

function deriveHeadroom(lines: Array<Record<string, unknown>>, nowMs: number, enforced: boolean): HeadroomSection {
  const { ts, telemetry } = deriveHeadroomLatest(lines);
  const tsParsed = ts ? Date.parse(ts) : NaN;
  const section: HeadroomSection = {
    found: telemetry !== undefined,
    telemetry,
    ts,
    ageMs: Number.isFinite(tsParsed) ? Math.max(0, nowMs - tsParsed) : undefined,
    enforced,
    degraded: deriveHeadroomDegraded(lines, nowMs),
  };
  section.nextAction = pickNextAction(HEADROOM_NEXT_ACTIONS, section);
  return section;
}

/** The two `automerge.hold_*` ledger steps {@link deriveMergeHeld} reads. */
const AUTOMERGE_HOLD_ENGAGED_STEP = "automerge.hold_engaged";
const AUTOMERGE_HOLD_RELEASED_STEP = "automerge.hold_released";

/** No real GitHub PR is numbered this — used ONLY to ask {@link automergeHoldFromLedger} whether a FLEET-scoped hold
 *  (no `pr_number`) stands, since a PR-scoped row can never match a number that does not exist. */
const MERGE_HELD_FLEET_SENTINEL_PR = -1;

/** W1-T1000003: the newest `automerge.hold_engaged` row's `task_id`, scoped as {@link automergeHoldFromLedger} scopes.
 *  ENRICHMENT ONLY — whether the hold still stands is that reader's decision alone. */
function latestHoldTaskId(lines: ReadonlyArray<Record<string, unknown>>, prNumber: number): string | undefined {
  let taskId: string | undefined;
  for (const l of lines) {
    if (l.step !== AUTOMERGE_HOLD_ENGAGED_STEP) continue;
    const scopedToThisPr = typeof l.pr_number !== "number" || l.pr_number === prNumber;
    if (!scopedToThisPr) continue;
    if (typeof l.task_id === "string" && l.task_id) taskId = l.task_id;
  }
  return taskId;
}

/** W1-T1000003 — the hold row(s) this board renders, keyed on {@link automergeHoldFromLedger} ALONE, never re-derived
 *  from check or review fields. One row per PR a hold ever named, present only while still held; a fleet-wide hold
 *  renders one row naming no PR. */
function deriveMergeHeld(lines: ReadonlyArray<Record<string, unknown>>): MergeHeldRow[] {
  const prNumbers = new Set<number>();
  for (const l of lines) {
    if (l.step !== AUTOMERGE_HOLD_ENGAGED_STEP && l.step !== AUTOMERGE_HOLD_RELEASED_STEP) continue;
    if (typeof l.pr_number === "number") prNumbers.add(l.pr_number);
  }
  const rows: MergeHeldRow[] = [];
  for (const prNumber of [...prNumbers].sort((a, b) => a - b)) {
    const hold = automergeHoldFromLedger(lines, prNumber);
    if (!hold) continue;
    rows.push({ prNumber, taskId: latestHoldTaskId(lines, prNumber), by: hold.by, reason: hold.reason });
  }
  if (prNumbers.size === 0) {
    // No PR-scoped hold row was ever recorded, so a currently-standing hold can only be fleet-scoped. A real PR number
    // always accompanies a PR-scoped row, so a sentinel no PR is ever numbered can only match a fleet-wide row.
    const fleetHold = automergeHoldFromLedger(lines, MERGE_HELD_FLEET_SENTINEL_PR);
    if (fleetHold) rows.push({ by: fleetHold.by, reason: fleetHold.reason });
  }
  return rows;
}

function deriveNeedsMe(
  lines: ReadonlyArray<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
): NeedsMeSection {
  // W1-T931: this board's read of `cost.anomaly` rows — never a re-derivation of the detector's math, which lives in
  // cost-anomaly.ts. DEDUPED BY `run_id`, LAST ONE WINS.
  // Why: the concurrent-write risk — docs/forensics/status-board.md
  const byRunId = new Map<string, CostAnomalyRow>();
  for (const l of lines) {
    if (l.step !== COST_ANOMALY_STEP) continue;
    const runId = typeof l.run_id === "string" ? l.run_id : undefined;
    if (!runId) continue;
    const ts = typeof l.ts === "string" ? l.ts : undefined;
    const existing = byRunId.get(runId);
    if (existing && !isNewer(ts, existing.ts)) continue;
    byRunId.set(runId, {
      runId,
      taskId: typeof l.task_id === "string" ? l.task_id : "?",
      taskClass: typeof l.task_class === "string" ? l.task_class : "unknown",
      costUsd: typeof l.cost_usd === "number" ? l.cost_usd : 0,
      medianCostUsd: typeof l.median_cost_usd === "number" ? l.median_cost_usd : 0,
      multiplier: typeof l.multiplier === "number" ? l.multiplier : 0,
      sampleSize: typeof l.sample_size === "number" ? l.sample_size : 0,
      ts,
    });
  }
  const costAnomaly = [...byRunId.values()].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

  // W1-T1021: the NEWEST `daemon.image_drift` line, the same "latest wins" read `isNewer` gives above — a drift finding
  // is a point-in-time comparison, so an older row never outranks a fresher.
  let imageDrift: ImageDriftRow | undefined;
  for (const l of lines) {
    if (l.step !== IMAGE_DRIFT_STEP) continue;
    const buildSha = typeof l.build_sha === "string" ? l.build_sha : undefined;
    const bakedSha = typeof l.baked_sha === "string" ? l.baked_sha : undefined;
    if (!buildSha || !bakedSha) continue;
    const ts = typeof l.ts === "string" ? l.ts : undefined;
    if (imageDrift && !isNewer(ts, imageDrift.ts)) continue;
    imageDrift = { buildSha, bakedSha, ts };
  }

  // THE STANDING APP-TOKEN FALLBACK. Two "latest wins" scans over the SAME `lines`, compared: the fallback stands iff
  // the newest failure is newer than the newest success. `isNewer` gives the never-succeeded case for free.
  let lastFail: { reason: string; ts?: string } | undefined;
  let lastOkTs: string | undefined;
  for (const l of lines) {
    const ts = typeof l.ts === "string" ? l.ts : undefined;
    if (l.step === TOKEN_REFRESH_FAILED_STEP) {
      if (lastFail && !isNewer(ts, lastFail.ts)) continue;
      lastFail = { reason: typeof l.reason === "string" ? l.reason : "unstated", ts };
    } else if (l.step === TOKEN_REFRESHED_STEP) {
      if (lastOkTs && !isNewer(ts, lastOkTs)) continue;
      lastOkTs = ts;
    }
  }
  const tokenFallback =
    lastFail && isNewer(lastFail.ts, lastOkTs)
      ? { reason: lastFail.reason, ...(lastFail.ts ? { ts: lastFail.ts } : {}), ...(lastOkTs ? { lastOkTs } : {}) }
      : undefined;

  // W1-T1000003: currently-standing operator merge holds — a pure re-read of the SAME hold reader sweep.ts and
  // run-task.ts already consult, never a second gateway or ledger pass.
  const mergeHeld = deriveMergeHeld(lines);

  // W1-T2392: READ, never re-derive. `deriveStatus` already decided this per task and put it on the projection; this
  // walks the SAME map, so no second plan pass. Sorted by task id so the block is stable between renders.
  const uncreditedBuilds: UncreditedBuildRow[] = [];
  for (const [taskId, p] of projections ?? []) {
    const w = p.uncreditedBuild;
    if (!w) continue;
    uncreditedBuilds.push({ taskId, prNumber: w.prNumber, prUrl: w.prUrl, namedIn: w.namedIn });
  }
  uncreditedBuilds.sort((a, b) => a.taskId.localeCompare(b.taskId));

  return { costAnomaly, imageDrift, mergeHeld, uncreditedBuilds, ...(tokenFallback ? { tokenFallback } : {}) };
}

/** Is `a` strictly newer than `b`, by PARSED timestamp? An absent or unparseable `b` — no successful read ever recorded
 *  — makes `a` newer, which is the parked-since-boot case. An absent `a` is never newer. */
function isNewer(a: string | undefined, b: string | undefined): boolean {
  const pa = a ? Date.parse(a) : NaN;
  if (!Number.isFinite(pa)) return false;
  const pb = b ? Date.parse(b) : NaN;
  return !Number.isFinite(pb) || pa > pb;
}

/** `consecutive_unreadable` × `poll_interval_ms`, rendered — how long the governor has been blind. Omitted when either
 *  field is absent: a duration guessed from one would be a fabricated number on a stalled-fleet surface. */
function blindForClause(d: HeadroomDegraded): string {
  if (typeof d.consecutiveUnreadable !== "number" || typeof d.pollIntervalMs !== "number") return "";
  const mins = Math.round((d.consecutiveUnreadable * d.pollIntervalMs) / 60_000);
  return ` — blind for about ${mins}m (${d.consecutiveUnreadable} consecutive unreadable probes)`;
}

const HEADROOM_NEXT_ACTIONS: readonly NextActionRule<HeadroomSection>[] = [
// ABOVE `!ctx.found`, AND THAT ORDER IS THE FIX. A parked daemon writes no `daemon.headroom` row ever, so it lands in
// `!found` beside one that has simply not ticked, and the rung below reported the reassuring case for both.
  {
  // ONLY WHEN THE BLINDNESS IS THE LATEST WORD. A successful probe resumes dispatch, but the 30-minute window often
  // still holds the old degraded line, so firing on presence alone would call a RECOVERED governor blind.
    applies: (ctx) => ctx.degraded !== undefined && isNewer(ctx.degraded.ts, ctx.ts),
    action: (ctx) =>
      `headroom governor is BLIND — usage unreadable beyond its allowance, so the daemon is idling and dispatching NOTHING` +
      `${blindForClause(ctx.degraded!)}. It does not recover on its own until a probe succeeds; ` +
      `check the usage probe, or set \`headroom.enabled: false\` to proceed on absent telemetry`,
  },
  { applies: (ctx) => !ctx.found, action: () => "no headroom telemetry yet — it appears after the daemon's first tick" },
  { applies: (ctx) => !ctx.enforced, action: () => "headroom governor is OFF — telemetry only, dispatch is never throttled on it" },
  {
    applies: (ctx) => ctx.found && ctx.enforced && (ctx.telemetry?.percentUsed ?? 0) >= (ctx.telemetry?.limitPct ?? 100),
    action: (ctx) => `headroom at/over its ${ctx.telemetry?.limitPct}% ceiling — dispatch is throttled until ${ctx.telemetry?.resetsAt ?? "the next reset"}`,
  },
];

// ── buildStatusBoard — the ONE read model ───────────────────────────────────────────────────────

export function buildStatusBoard(root: string, ledgerPath: string, deps: StatusBoardDeps): StatusBoardModel {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  // THE BOARD MUST READ ROTATIONS, NOT ONE FILE. `readLedgerLines` opens one path and `rotateLedger` sheds a step
  // COMPLETELY when it is in no retention set. The predicate names only the three steps measured as shed; every rung
  // takes the NEWEST row.
  // Why: 0 live `daemon.summary` rows against 524 in rotations — docs/forensics/status-board.md
  const readLedger =
    deps.readLedger ??
    ((ledgerPath: string) =>
      readLedgerUnionBounded(ledgerPath, {
        satisfied: (stepsSeen) =>
          stepsSeen.has("daemon.summary") &&
          stepsSeen.has("daemon.headroom.degraded") &&
          stepsSeen.has("dispatch.indeterminate"),
      }));
  const resolveOriginMainSha = deps.resolveOriginMainSha ?? defaultResolveOriginMainSha;
  const crashLoopWindow = deps.crashLoopWindow ?? DEFAULT_CRASHLOOP_WINDOW;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const readSharedPauseState = deps.readSharedPauseState ?? defaultReadSharedPauseState;
  const readDispatchClaims = deps.readDispatchClaims ?? defaultReadDispatchClaims;

  const lines = readLedger(ledgerPath);
  const boots = deriveDaemonBoots(lines);
  const lastCycleRaw = deriveLastCycle(lines);
  const supervisorTick = deriveSupervisorTick(lines);

  // ── LIVENESS ──
  const services: ServiceLivenessRow[] = (["daemon", "serve", "deploy-supervisor"] as const).map((service) => {
    const q = deps.queryService(service);
    // W1-T2450: `sensed` defaults to `true` when the caller does not report it — the old, sensor-implicit behaviour —
    // so every deps bundle predating this field reads exactly as before.
    const row: ServiceLivenessRow = { service, running: q.running, pid: q.pid, sensed: q.sensed ?? true };
    if (service === "daemon") {
      row.bootedAt = boots.ts;
      const parsed = boots.ts ? Date.parse(boots.ts) : NaN;
      row.bootedAgeMs = Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined;
      row.headSha = boots.headSha;
    } else if (service === "deploy-supervisor") {
      row.tickAt = supervisorTick.ts;
      const parsed = supervisorTick.ts ? Date.parse(supervisorTick.ts) : NaN;
      row.tickAgeMs = Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined;
      row.tickStep = supervisorTick.step;
      row.lastExitCode = q.lastExitCode;
      const intervalS = deps.resolveSupervisorIntervalS?.() ?? DEFAULT_SUPERVISOR_INTERVAL_S;
      row.overdueThresholdMs = intervalS * 3 * 1000;
    }
    return row;
  });

  // "the sha the LIVE process booted at" presupposes a live process — a stopped daemon has no running HEAD to compare,
  // however recent its last boot. Gated on `running`, so this never reports fresh or stale for a daemon that is down.
  const daemonRow = services.find((s) => s.service === "daemon")!;
  // HOISTED out of the `running` branch below — one resolution, two consumers. LATCHES needs origin/main to judge a
  // DEPLOY_FAILED alert, independently of whether a daemon is up; resolving twice would be two git calls for one fact.
  const originSha = resolveOriginMainSha(deps.repoDir);
  let headVsOriginMain: StaleFlag = { status: "unknown" };
  if (daemonRow.running && boots.headSha && originSha) {
    headVsOriginMain = sameCommit(boots.headSha, originSha) ? { status: "fresh" } : { status: "stale", headSha: boots.headSha, originSha };
  }

  const crashLoop = detectDaemonCrashLoop(boots.allBoots, crashLoopWindow);

  const livenessCtx: LivenessCtx = { services, headVsOriginMain, crashLoop };
  const liveness: LivenessSection = {
    services,
    headVsOriginMain,
    crashLoop,
    nextAction: pickNextAction(LIVENESS_NEXT_ACTIONS, livenessCtx),
  };

  // W1-T2446: HOISTED from the derived-half block below — LATCHES needs the merge-credit projection the other sections
  // build, to correct the held dispatch-claim row's text. It reads only values already in scope.
  const plan = deps.plan ?? tryLoadDefaultPlan(deps.repoDir);
  const { projections, unknownReason: ghUnknownReason } = projectPlanOnce(plan, deps.github, ledgerPath, lines, now);
  const isMerged: MergedSet = (id) => projections?.get(id)?.merged === true;

  // ── LATCHES ──
  const rows = buildLatchRows(root, nowMs, isPidAlive, () => readSharedPauseState(deps.repoDir), originSha, () =>
    readDispatchClaims(deps.repoDir), isMerged,
  );
  const latchesSection: LatchesSection = { rows, nextAction: undefined };
  latchesSection.nextAction = pickNextAction(LATCHES_NEXT_ACTIONS, latchesSection);

  // ── LAST CYCLE ──
  const lastCycleTsParsed = lastCycleRaw.ts ? Date.parse(lastCycleRaw.ts) : NaN;
  const lastCycle: LastCycleSection = {
    found: lastCycleRaw.summary !== undefined,
    summary: lastCycleRaw.summary,
    ts: lastCycleRaw.ts,
    ageMs: Number.isFinite(lastCycleTsParsed) ? Math.max(0, nowMs - lastCycleTsParsed) : undefined,
  };
  // W1-T279 follow-up: has the daemon done anything SINCE this cycle closed? If so the cycle is history, and telling
  // the operator to investigate it competes with the live blockers below.
  lastCycle.supersededByTs = newestDaemonActivityAfter(lines, lastCycle.ts);
  const supersededParsed = lastCycle.supersededByTs ? Date.parse(lastCycle.supersededByTs) : NaN;
  lastCycle.supersededAgeMs = Number.isFinite(supersededParsed) ? Math.max(0, nowMs - supersededParsed) : undefined;
  lastCycle.nextAction = pickNextAction(LAST_CYCLE_NEXT_ACTIONS, lastCycle);

  // ── W1-T280 (DERIVED half) ── `plan`/`projections`/`ghUnknownReason` are now hoisted above,
  // ahead of LATCHES (W1-T2446) — this section reuses them, never re-derives them.
  const queueHeadLimit = deps.queueHeadLimit ?? 5;

  const blockers = deriveBlockers(plan, lines, projections, deps.github, queueHeadLimit);
  // W1-T1205: the SAME `hasPushedRunBranch` predicate the real dispatcher binds, read here rather than shared with it —
  // this is its own, unbatched call site. ONE sweep per render, never one per candidate.
  const readPushedRunBranches = deps.readPushedRunBranches ?? defaultReadPushedRunBranches;
  const pushedRunBranchIds = runBranchTaskIds(readPushedRunBranches(deps.repoDir));
  const queueHead = deriveQueueHead(plan, lines, projections, ghUnknownReason, queueHeadLimit, nowMs, (id) =>
    pushedRunBranchIds.has(id),
  );
  const grepAnchorTrue = deps.grepAnchorTrue ?? ((a: EvidenceAnchor) => gitGrepAnchorTrue(deps.repoDir, "origin/main", a));
  const readProposalRegistry =
    deps.readProposalRegistry ?? (() => parseProposalRegistry(readTextFileIfExists(join(root, "state", "inbox-proposals.json"))));
  const readDraftCache = deps.readDraftCache ?? (() => parseDraftCache(readTextFileIfExists(join(root, "state", "inbox-drafts.json"))));
  const inbox = deriveInbox(plan, lines, projections, ghUnknownReason, readProposalRegistry, readDraftCache, grepAnchorTrue);
  const headroom = deriveHeadroom(lines, nowMs, (deps.resolveHeadroomEnabled ?? (() => true))());

  // ── W1-T929: CACHE HIT — same `lines` window every other section above already read, one
  // extra traversal (digest.ts's aggregateCacheHitTotals), no second ledger read. ──────────────
  const cacheHitTotals = aggregateCacheHitTotals(lines);
  const cacheHit: CacheHitSection = { found: cacheHitTotals !== undefined, totals: cacheHitTotals };

  // ── W1-T940: LEARNINGS INJECTION — the same `lines` window every section above already read, one
  // extra traversal (digest.ts's aggregateLearningsInjection), no second ledger read. ─────────────
  const learningsInjectionTotals = aggregateLearningsInjection(lines);
  const learningsInjection: LearningsInjectionSection = {
    found: learningsInjectionTotals !== undefined,
    totals: learningsInjectionTotals,
  };

  // ── W1-T931: NEEDS ME — same `lines` window every other section above already read, one
  // extra pure fold (deriveNeedsMe), no second ledger read. ──────────────────────────────────
  const needsMe = deriveNeedsMe(lines, projections);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    liveness,
    latches: latchesSection,
    lastCycle,
    blockers,
    queueHead,
    inbox,
    headroom,
    cacheHit,
    learningsInjection,
    needsMe,
  };
}

// ── renderStatusBoardText — the TEXT renderer, projecting the SAME model `--json` emits ──────────

/** The width every one of the ten section rules below was already hand-typed at — measured, not assumed. Pinned rather
 *  than wired to `terminalWidth()`; `sectionRule` never paints, so byte-identical-when-off holds with colour on. */
const SECTION_RULE_WIDTH = 57;

function formatAgeMs(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

/** Render one row's {@link LivenessState} — the THREE-way text that replaced a binary render collapsing an interval
 *  service's healthy rest and a dead one into one "not running" line (W1-T301). `enabled` defaults to `false`. */
function renderLivenessState(s: ServiceLivenessRow, enabled = false): string {
  switch (livenessState(s)) {
    case "running":
      return paint.ok(`running (pid ${s.pid ?? "unknown"})`, enabled);
    case "stopped":
      return paint.bad("not running", enabled);
    case "unknown":
      // W1-T2450: names WHICH absence this is — "no sensor" here, vs the interval branch's own "no tick observed yet"
      // below, which only ever fires once a sensor DID answer.
      return paint.dim("unknown — no launchd sensor on this host (`launchctl` unavailable)", enabled);
    case "idle":
      return paint.ok(`idle — last tick ${s.tickAt ? `${formatAgeMs(s.tickAgeMs)} ago` : "unknown"} (${s.tickStep ?? "unknown"})`, enabled);
    case "overdue":
      return paint.bad(
        s.lastExitCode !== undefined && s.lastExitCode !== 0
          ? `overdue — last exit code ${s.lastExitCode}${s.tickAt ? ` (${formatAgeMs(s.tickAgeMs)} ago)` : ""}`
          : `overdue — ${s.tickAt ? `last tick ${formatAgeMs(s.tickAgeMs)} ago, no fresher one since` : "no tick observed yet"}`,
        enabled,
      );
  }
}

/** `enabled` (colour on/off) defaults to `false`, so pre-existing single-argument callers keep exactly today's bytes.
 *  `paint` only ever WRAPS a word this function already printed, and byte-identical-when-off is asserted directly. */
function renderLivenessBlock(l: LivenessSection, enabled = false): string[] {
  const out = [sectionRule("LIVENESS", SECTION_RULE_WIDTH)];
  for (const s of l.services) {
    const bootPart =
      s.service === "daemon" ? ` — boot ${s.bootedAt ? `${formatAgeMs(s.bootedAgeMs)} ago` : "unknown"} (${shortSha(s.headSha)})` : "";
    out.push(`${s.service.padEnd(16)}: ${renderLivenessState(s, enabled)}${bootPart}`);
  }
  const stale = l.headVsOriginMain;
  out.push(
    `head vs origin/main : ${
      stale.status === "unknown"
        ? paint.dim("unknown", enabled)
        : stale.status === "fresh"
          ? paint.ok("fresh", enabled)
          : paint.bad(`STALE (${shortSha(stale.headSha)} vs ${shortSha(stale.originSha)})`, enabled)
    }`,
  );
  out.push(
    `crash-loop           : ${
      l.crashLoop.breached
        ? paint.bad(`BREACHED (${l.crashLoop.windowBoots.length} boots in ${Math.round(l.crashLoop.windowMs / 60_000)}m)`, enabled)
        : paint.ok("clear", enabled)
    }`,
  );
  if (l.nextAction) out.push(`next action: ${l.nextAction}`);
  return out;
}

function renderLatchesBlock(latches: LatchesSection): string[] {
  const out = [sectionRule("LATCHES", SECTION_RULE_WIDTH)];
  if (!latches.rows.length) {
    out.push("no active latches");
  } else {
    for (const r of latches.rows) out.push(`${r.name}, ${formatAgeMs(r.ageMs)} — ${r.consequence}`);
  }
  if (latches.nextAction) out.push(`next action: ${latches.nextAction}`);
  return out;
}

function renderLastCycleBlock(lc: LastCycleSection): string[] {
  // "LAST CLOSED CYCLE", not "LAST CYCLE": a cycle is written only when the loop STOPS, so this row is always an
  // ending.
  // Why: the old header implied a currency it never had — docs/forensics/status-board.md
  const out = [sectionRule("LAST CLOSED CYCLE", SECTION_RULE_WIDTH)];
  if (!lc.found || !lc.summary) {
    out.push("no cycle recorded");
  } else {
    const s = lc.summary;
    out.push(`attempted : ${s.attempted.length ? s.attempted.join(", ") : "(none)"}`);
    out.push(`merged    : ${s.merged.length ? s.merged.join(", ") : "(none)"}`);
    out.push(`stopped   : ${s.stopReason}${s.stopDetail ? ` — ${s.stopDetail}` : ""}`);
    out.push(`cost      : notional $${s.costUsd.toFixed(4)}`);
    out.push(`ticks     : ${s.ticks}`);
    out.push(`closed    : ${formatAgeMs(lc.ageMs)} ago`);
    if (lc.supersededByTs) {
      out.push(`superseded: the daemon has run since — newest activity ${formatAgeMs(lc.supersededAgeMs)} ago`);
    }
  }
  if (lc.nextAction) out.push(`next action: ${lc.nextAction}`);
  return out;
}

function renderBlockersBlock(b: BlockersSection): string[] {
  const out = [sectionRule("BLOCKERS BY CLASS", SECTION_RULE_WIDTH)];
  const circuitBroken = b.rows.filter((r): r is CircuitBrokenBlocker => r.kind === "circuit_broken");
  const blockedPrs = b.rows.filter((r): r is BlockedPrBlocker => r.kind === "blocked_pr");
  const indeterminate = b.rows.filter((r): r is IndeterminateBlocker => r.kind === "indeterminate");
  const retired = b.rows.filter((r): r is RetiredBlocker => r.kind === "retired");
  if (
    circuitBroken.length === 0 &&
    blockedPrs.length === 0 &&
    indeterminate.length === 0 &&
    retired.length === 0 &&
    !b.blockedPrsUnverifiedReason
  ) {
    out.push("no blockers");
  }
  for (const r of circuitBroken) out.push(`circuit-broken : ${r.taskId} — ${r.resetNote}`);
  for (const r of blockedPrs) out.push(`blocked PR     : #${r.prNumber}${r.taskId ? ` (${r.taskId})` : ""} [${r.disposition}] — ${r.reason}`);
  for (const r of indeterminate) out.push(`indeterminate  : ${r.taskId} — ${r.ghWindowNote}`);
  for (const r of retired) out.push(`retired        : ${r.taskId} — ${r.reason}`);
  if (b.blockedPrsUnverifiedReason) out.push(`blocked PR     : unverified — ${b.blockedPrsUnverifiedReason}`);
  if (b.nextAction) out.push(`next action: ${b.nextAction}`);
  return out;
}

/** W1-T2637: a label table, exhaustive BY CONSTRUCTION — one wording per {@link QueueHeadRefusedRow.reason} member, keyed as a `Record` so the type-checker names any arm left without a sentence. Replaces a two-way ternary; only run-branch and breaker rows reach it today, both byte-identical to before. */ const QUEUE_HEAD_REFUSAL_WORDING: Record<QueueHeadRefusedRow["reason"], (r: QueueHeadRefusedRow) => string> = {
  "circuit-broken": (r) => `dispatch circuit breaker tripped — ${r.resetNote ?? `${r.dispatchCount}/${r.maxDispatches} dispatches with no new owned PR`}`,
  "run-branch-already-pushed": () => "run branch already pushed to origin", "already-merged": () => "already merged", "verify-not-auto": () => "verify is not auto",
  blocked: () => "blocked", retired: () => "retired", "unmet-deps": () => "dependencies not yet met", "continued-this-pass": () => "continued this pass",
  // W1-T988: this table is exhaustive BY CONSTRUCTION, so a new DispatchFilterReason must carry a wording here or the
  // type-checker refuses. Names the daemon's target so the row says WHY.
  "foreign-repo": () => "belongs to another repo than this daemon targets",
  // W1-T2675 — a BLIND SPOT, never a verdict: the merge credit could not be read, so the task is held rather than
  // rebuilt. The entry follows the comma directly, because the exhaustiveness test matches a key only after a brace or
  // a comma.
  "credit-indeterminate": () => "merge credit could not be read — held rather than rebuilt" };

/** EXPORTED for test only, the visibility `deriveCircuitBrokenBlockers` already carries, so a test can assert what an
 *  operator actually READS. `enabled` defaults to `false`, so colour is opt-in and only `renderStatusBoardText` passes
 *  `true`. */
export function renderQueueHeadBlock(q: QueueHeadSection, enabled = false): string[] {
  const out = [sectionRule("QUEUE HEAD", SECTION_RULE_WIDTH)];
  if (q.unknownReason) {
    out.push(`unknown — ${q.unknownReason}`);
  } else if (q.rows.length === 0 && q.refused.length === 0) {
    out.push(paint.dim("nothing dispatchable", enabled));
  } else {
    if (q.rows.length === 0) out.push(paint.dim("nothing dispatchable", enabled));
    for (const r of q.rows) {
      const cost = r.observedPerCycleCostUsd !== undefined ? `, ~$${r.observedPerCycleCostUsd.toFixed(4)}/cycle` : "";
      const flag = r.perpetual ? ` — PERPETUAL (attempts ${r.attempts}${cost})` : ` (attempts ${r.attempts})`;
      out.push(`${r.taskId} — ${r.title}${flag}`);
    }
    if (q.stall) {
      out.push(
        paint.warn(
          `STALL: ${q.stall.candidateCount} candidate(s), nothing dispatched in ${formatAgeMs(q.stall.sinceMs)}` +
            ` (bound ${formatAgeMs(q.stall.boundMs)} — ${q.stall.boundDerivation})`,
          enabled,
        ),
      );
    }
    // W1-T1205 (design (ii)): what dispatch is REFUSING, named — never silently absent from a list that only ever
    // showed what it would take.
    for (const r of q.refused) {
      const why = QUEUE_HEAD_REFUSAL_WORDING[r.reason](r); // W1-T2637: table lookup, was a two-way ternary
      out.push(paint.warn(`REFUSED: ${r.taskId} — ${r.title} (${why})`, enabled));
    }
    if (q.refusedTruncated > 0) {
      out.push(paint.warn(`REFUSED: (+${q.refusedTruncated} more not shown)`, enabled));
    }
  }
  if (q.nextAction) out.push(`next action: ${q.nextAction}`);
  return out;
}

function renderInboxBlock(i: InboxSection): string[] {
  const out = [sectionRule("INBOX", SECTION_RULE_WIDTH)];
  if (i.unknownReason) {
    out.push(`unknown — ${i.unknownReason}`);
  } else {
    out.push(`ready: ${i.readyCount}, not ready: ${i.notReadyCount}`);
    if (i.headNotReadyReason) out.push(`head not-ready reason: ${i.headNotReadyReason}`);
  }
  if (i.nextAction) out.push(`next action: ${i.nextAction}`);
  return out;
}

function renderHeadroomBlock(h: HeadroomSection): string[] {
  const out = [sectionRule("HEADROOM", SECTION_RULE_WIDTH)];
  out.push(`enforcement : ${h.enforced ? "ON" : "OFF"}`);
  if (!h.found || !h.telemetry) {
    out.push("no headroom telemetry yet");
  } else {
    const t = h.telemetry;
    out.push(`window      : ${t.window}`);
    out.push(`used        : ${t.percentUsed}% (limit ${t.limitPct}%)`);
    if (t.resetsAt) out.push(`resets at   : ${t.resetsAt}`);
    if (t.note) out.push(`note        : ${t.note}`);
    out.push(`age         : ${formatAgeMs(h.ageMs)} ago`);
  }
  if (h.nextAction) out.push(`next action: ${h.nextAction}`);
  return out;
}

/** Render one {@link CacheHitTotals} grain map (`byRun`/`byClass`) as one line, sorted by key. Formats via digest.ts's
 *  {@link formatCacheHitFigure} — the ONE formatting rule, shared rather than re-spelled here. */
function renderCacheHitGrains(grains: Record<string, CacheHitGrain>): string {
  return Object.keys(grains)
    .sort()
    .map((key) => `${key}=${formatCacheHitFigure(grains[key])}`)
    .join(", ");
}

/** Sum every {@link CacheHitGrain} in `byClass` into one board-wide total — `byClass` already partitions every call
 *  line in the window exactly once, so summing it rather than `byRun` can never double-count. */
function sumCacheHitGrains(byClass: Record<string, CacheHitGrain>): CacheHitGrain {
  return Object.values(byClass).reduce<CacheHitGrain>(
    (sum, g) => ({
      cacheRead: sum.cacheRead + g.cacheRead,
      input: sum.input + g.input,
      cacheCreation: sum.cacheCreation + g.cacheCreation,
      callLines: sum.callLines + g.callLines,
      coveredLines: sum.coveredLines + g.coveredLines,
    }),
    { cacheRead: 0, input: 0, cacheCreation: 0, callLines: 0, coveredLines: 0 },
  );
}

function renderCacheHitBlock(c: CacheHitSection): string[] {
  const out = [sectionRule("CACHE HIT", SECTION_RULE_WIDTH)];
  if (!c.found || !c.totals) {
    out.push("no cache-token data in this window");
    return out;
  }
  // ONE board-wide figure, off the SAME `cacheHitRatio` arithmetic digest.ts exports — called directly rather than via
  // a pre-rendered string, so this total is provably the digest's formula over this board's combined total.
  const overall = sumCacheHitGrains(c.totals.byClass);
  const overallRatio = cacheHitRatio(overall);
  const overallCoveragePct = overall.callLines > 0 ? Math.round((overall.coveredLines / overall.callLines) * 100) : 0;
  const overallFigure =
    overallRatio === undefined ? `UNKNOWN (coverage ${overallCoveragePct}%)` : `${(overallRatio * 100).toFixed(1)}% (coverage ${overallCoveragePct}%)`;
  out.push(`overall : ${overallFigure}`);
  out.push(`by run  : ${renderCacheHitGrains(c.totals.byRun)}`);
  out.push(`by class: ${renderCacheHitGrains(c.totals.byClass)}`);
  return out;
}

/** W1-T940 — the drop-pressure lines: `matched`/`dropped`/`rows`, every distinct `budget_chars` value seen (not
 *  averaged, so a mid-window change stays visible), and any `global_refused_reason` named VERBATIM, never folded into
 *  `dropped`. W1-T1251 — of `loadGlobalArtifact`'s seven failure reasons one is the ruled-on §6-deferred-transport
 *  absence and six are real problems including the tamper signal, so `classifyGlobalArtifactRefusal` splits them onto
 *  the two lines below. */
function renderLearningsInjectionBlock(s: LearningsInjectionSection): string[] {
  const out = [sectionRule("LEARNINGS INJECTION", SECTION_RULE_WIDTH)];
  if (!s.found || !s.totals) {
    out.push("no injection rows in this window");
    return out;
  }
  const t = s.totals;
  out.push(`matched: ${t.matched}  dropped: ${t.dropped}  rows: ${t.rows}`);
  out.push(`budget_chars: ${t.budgetChars.length ? t.budgetChars.join(", ") : "unknown"}`);
  const reasons = Object.keys(t.globalRefusedReasons).sort();
  const genuineRefusals = reasons.filter((r) => classifyGlobalArtifactRefusal(r) === "refused");
  const designedAbsences = reasons.filter((r) => classifyGlobalArtifactRefusal(r) === "absent");
  const renderReasons = (rs: string[]) => (rs.length ? rs.map((r) => `${r} (${t.globalRefusedReasons[r]})`).join(", ") : "none");
  out.push(`global artifact refused: ${renderReasons(genuineRefusals)}`);
  out.push(`global artifact deferred (§6 transport not yet provisioned): ${renderReasons(designedAbsences)}`);
  return out;
}

/** W1-T931 — one line per un-dismissed `cost.anomaly` row, naming the run, its class, its cost and the median exceeded.
 *  W1-T1021 adds an image-drift row naming both shas. `nothing needs you` only when NEITHER has anything to report. */
function renderNeedsMeBlock(n: NeedsMeSection): string[] {
  const out = [sectionRule("NEEDS ME", SECTION_RULE_WIDTH)];
  if (
    n.costAnomaly.length === 0 &&
    !n.imageDrift &&
    n.mergeHeld.length === 0 &&
    n.uncreditedBuilds.length === 0 &&
    !n.tokenFallback
  ) {
    out.push("nothing needs you");
    return out;
  }
  if (n.tokenFallback) {
    const since = n.tokenFallback.lastOkTs ? `last good refresh ${n.tokenFallback.lastOkTs}` : "no successful refresh on record";
    out.push(
      `token fallback : the App installation token refresh last FAILED (${n.tokenFallback.reason}) — ` +
        `GH_TOKEN was left as found, so gh calls are billing the personal token's buckets, not the ` +
        `installation's (${since})`,
    );
  }
  for (const r of n.mergeHeld) {
    const target = r.prNumber !== undefined ? `PR #${r.prNumber}${r.taskId ? ` (${r.taskId})` : ""}` : "the whole fleet";
    out.push(`merge held : ${target} — held by ${r.by}: ${r.reason}`);
  }
  // W1-T2392: names the task, the PR and WHICH prose surface carried the id, and says what to do — a warning nobody can
  // act on is noise.
  for (const r of n.uncreditedBuilds) {
    out.push(
      `uncredited build : ${r.taskId} — merged ${r.prUrl} (#${r.prNumber}) names it in the ${r.namedIn}, ` +
        `but no credit surface claimed it; the task stays dispatchable until a trailer or a run-${r.taskId}-<epochMs> head credits it`,
    );
  }
  for (const r of n.costAnomaly) {
    out.push(
      `cost.anomaly : ${r.taskId} (${r.runId}) [${r.taskClass}] $${r.costUsd.toFixed(2)} vs class median ` +
        `$${r.medianCostUsd.toFixed(2)} (>${r.multiplier}x, n=${r.sampleSize})`,
    );
  }
  if (n.imageDrift) {
    out.push(
      `image drift : running image built at ${n.imageDrift.buildSha} is missing a baked change at ` +
        `${n.imageDrift.bakedSha} (deploy/entrypoint.sh or deploy/Dockerfile) — dispatch a rebuild ` +
        `(.github/workflows/acr-build.yml, workflow_dispatch)`,
    );
  }
  return out;
}

// ── OPERATOR MESSAGE STANDARD — the board's presence projection (W1-T2806) ──────────────────────
// docs/operator-message-standard.md is NORMATIVE and names `renderStatusBoardText` as its FIRST surface. It checks
// PRESENCE of four slots and nothing else — never a readability, length or vocabulary metric, which the standard
// forbids being added in its name — and certifies no message TRUE. It never withholds: operator-message.ts fails toward
// DELIVERY, so no row is hidden, reordered or truncated and one footer line records what was missing.
// Why: the surface the presence check never saw — docs/forensics/status-board.md

/** A board section as the presence check sees it: its label, and the slots it fills. */
export interface BoardSectionMessage {
  label: string;
  message: OperatorMessage;
}

/** Project one rendered section onto the four presence slots, reading only what the board ALREADY carries.
 *  `whatHappened` is the block's rendered body, absent when it rendered nothing. `whatIsAsked` is `nextAction`, left
 *  UNDEFINED rather than nulled: a healthy section and a table with a gap both return `undefined`, and part (iv) is
 *  about not reporting those as one fact. `consequenceOfInaction` has no board slot today — the gap this makes visible.
 */
export function projectBoardSection(
  label: string,
  renderedLines: readonly string[],
  nextAction: string | undefined,
): BoardSectionMessage {
  const body = renderedLines.slice(1).filter((line) => line.trim().length > 0);
  return {
    label,
    message: {
      speaker: label,
      whatHappened: body.length > 0 ? body.join("\n") : undefined,
      whatIsAsked: nextAction,
      consequenceOfInaction: undefined,
    },
  };
}

/** {@link checkOperatorMessage}, best-effort — mirrors escalate.ts's own wrapper. A checker failure must never reach
 *  the operator as a broken board, so this returns `undefined` and the caller omits the section from the footer. */
function checkBoardSectionSafe(message: OperatorMessage): OperatorMessageCheckResult | undefined {
  try {
    return checkOperatorMessage(message);
  } catch {
    // Deliberately UNDEFINED rather than a synthesised "incomplete": a section the checker could not read has not been
    // observed to be missing anything, and reporting the two as one fact is what part (iv) forbids.
    return undefined;
  }
}

/** ONE board-level footer naming which sections are structurally incomplete, or `undefined` when every section
 *  conforms. One line for the whole board: no section fills `consequenceOfInaction`, a fact constant across them. */
export function boardMessageFooter(sections: readonly BoardSectionMessage[]): string | undefined {
  const incomplete: { label: string; missing: OperatorMessagePart[] }[] = [];
  for (const section of sections) {
    const result = checkBoardSectionSafe(section.message);
    if (result && !result.ok) incomplete.push({ label: section.label, missing: result.missing });
  }
  if (incomplete.length === 0) return undefined;
  const parts = [...new Set(incomplete.flatMap((row) => row.missing))].sort();
  return (
    `_operator-message: ${incomplete.length} of ${sections.length} section(s) incomplete — ` +
    `missing ${parts.join(", ")} (${incomplete.map((row) => row.label).join(", ")}). ` +
    `Rendered in full regardless; see docs/operator-message-standard.md._`
  );
}

/** {@link projectBoardSection} under the same guard the check already has (W1-T2826). The projection used to run one
 *  frame out, in the argument expression feeding {@link boardMessageFooter}, where nothing caught it — so a throw took
 *  the whole board down. Returns `undefined` for a section it could not project. */
function projectBoardSectionSafe(
  label: string,
  renderedLines: readonly string[],
  section: unknown,
): BoardSectionMessage | undefined {
  try {
    return projectBoardSection(label, renderedLines, sectionNextAction(section));
  } catch {
    // Swallowed for the reason the guard exists: the board is the deliverable and its own conformance projection must
    // not withhold it. Dropping the section keeps the footer's denominator honest.
    return undefined;
  }
}

/** `nextAction` off a section that may or may not declare one — the board's sections are separate interfaces and only
 *  some carry the slot. */
function sectionNextAction(section: unknown): string | undefined {
  if (section === null || typeof section !== "object") return undefined;
  const value = (section as { nextAction?: unknown }).nextAction;
  return typeof value === "string" ? value : undefined;
}

/** The text projection of {@link StatusBoardModel} — every field comes off the model passed in, never a fresh read, so
 *  `--json` and the text output cannot disagree; the JSON path never calls this. `opts.colourEnabled` defaults to
 *  {@link colourEnabled}'s real env/TTY read, the ONE call site in this module that reads either. With colour disabled
 *  the output is BYTE-IDENTICAL to the pre-colour render. */
export function renderStatusBoardText(model: StatusBoardModel, opts: { colourEnabled?: boolean } = {}): string {
  const enabled = opts.colourEnabled ?? colourEnabled();
  // Each block renders into its own array so the presence projection can read what the reader actually sees. The join
  // below reproduces the previous concatenation line for line.
  const blocks: { label: string; section: unknown; rendered: string[] }[] = [
    { label: "liveness", section: model.liveness, rendered: renderLivenessBlock(model.liveness, enabled) },
    { label: "latches", section: model.latches, rendered: renderLatchesBlock(model.latches) },
    { label: "last cycle", section: model.lastCycle, rendered: renderLastCycleBlock(model.lastCycle) },
    { label: "blockers", section: model.blockers, rendered: renderBlockersBlock(model.blockers) },
    { label: "queue head", section: model.queueHead, rendered: renderQueueHeadBlock(model.queueHead, enabled) },
    { label: "inbox", section: model.inbox, rendered: renderInboxBlock(model.inbox) },
    { label: "headroom", section: model.headroom, rendered: renderHeadroomBlock(model.headroom) },
    { label: "cache hit", section: model.cacheHit, rendered: renderCacheHitBlock(model.cacheHit) },
    {
      label: "learnings injection",
      section: model.learningsInjection,
      rendered: renderLearningsInjectionBlock(model.learningsInjection),
    },
    { label: "needs me", section: model.needsMe, rendered: renderNeedsMeBlock(model.needsMe) },
  ];
  const lines: string[] = [`### rmd status — ${model.generatedAt}`, ""];
  blocks.forEach((block, index) => {
    lines.push(...block.rendered);
    if (index < blocks.length - 1) lines.push("");
  });
  // The footer is the LAST thing appended and the only line this can add, so a board is never withheld on a check.
  // W1-T2826: the projection runs INSIDE the guard now; previously it ran here, where nothing caught it.
  const footer = boardMessageFooter(
    blocks
      .map((block) => projectBoardSectionSafe(block.label, block.rendered, block.section))
      .filter((section): section is BoardSectionMessage => section !== undefined),
  );
  if (footer) lines.push("", footer);
  return lines.join("\n");
}
