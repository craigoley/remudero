/**
 * lib/status-board.ts — `rmd status` (W1-T279 half 1 + W1-T280 half 2, MASTER-PLAN §7/§5D).
 *
 * ONE READ MODEL, TWO RENDERERS. {@link buildStatusBoard} returns a plain data object
 * ({@link StatusBoardModel}); the text renderer ({@link renderStatusBoardText}) and `--json`
 * (a bare `JSON.stringify` of the same model, run-task.ts's `statusCommand`) both project THAT
 * — no second derivation, so the console's future Now tab (fb-1784770111145-cf7c24) can never
 * disagree with the terminal (the W1-T262 one-coherent-story discipline, applied to this
 * surface).
 *
 * TWO HALVES, ONE MODEL. LIVENESS/LATCHES/LAST CYCLE (W1-T279) are LOCAL TRUTH ONLY,
 * OFFLINE-SAFE — the filesystem, the ledger, or a launchd process query injected by the
 * caller, never a blocking network call; the `origin/main` comparison is a LOCAL
 * `git rev-parse` (no `git fetch`). BLOCKERS BY CLASS/QUEUE HEAD/INBOX/HEADROOM (W1-T280) are
 * DERIVED — some still ledger/plan-local (the dispatch circuit breaker, headroom telemetry),
 * others need a live merge-state read (QUEUE HEAD's dispatch eligibility, INBOX's dep-merged
 * predicate, and — since W1-T306 — BLOCKERS' own `blocked_pr` class: a PR the ledger once
 * disposed as blocked is re-checked against live GitHub state every render, never printed on
 * the ledger's word alone), which go through the SAME batched {@link GitHub} gateway every
 * other command already reads through. GITHUB IS
 * DECORATION, NEVER A GATE (see {@link StatusBoardDeps.github}): a gateway failure — or none
 * configured at all — degrades ONLY the sections/rows that actually needed it to a stated
 * `unknownReason`, never a throw, never a silently-empty section indistinguishable from
 * "nothing to report". Where a fact cannot be resolved (a pid unreadable, `origin/main`
 * unresolvable, no `daemon.boot` line yet, no headroom telemetry yet) the model carries an
 * explicit `"unknown"` / absent field, never a zero or a healthy-looking default rendered as
 * fact (the W1-T262 honesty rule: an unknown that LOOKS healthy is exactly the ~17h
 * DEPLOY_FAILED-invisible failure this task exists to retire).
 *
 * RENDERS, NEVER SENSES. Every fact this module reports is already written down somewhere —
 * fleet-control.ts's STOP/PAUSE/QUIET_HOURS flags, deployer.ts's DEPLOY_FAILED/DEPLOY_AUTO
 * markers, inflight-lock.ts's per-task locks, fleet-control.ts's pending kicks/drain-now
 * markers, daemon.ts's own `daemon.boot`/`daemon.summary`/`daemon.headroom` ledger lines +
 * `detectDaemonCrashLoop`, status.ts's dispatch-circuit-breaker/GitHub-projection signals,
 * sweep.ts's already-named PR disposition/reason (the W1-T186 named-reason doctrine — this
 * module RENDERS that vocabulary and mints none of its own), and config.ts's headroom-governor
 * switch. This module reads and assembles; it invents no new sensor.
 *
 * NEXT ACTION TABLES are POLICY AS DATA (rule 2): each section's `nextAction` is picked by
 * scanning an ordered list of `{applies, action}` rules and taking the FIRST match — a new
 * condition is a new table row, never a new branch buried in a renderer. No rule matches, no
 * line: a board that always prints advice trains the operator to skip it.
 */

import { execFileSync } from "node:child_process";
import { isQueueDispatchRunStart } from "./ledger.js";
// Imported as the module's DEFAULT export (a plain, mutable object), not as named bindings
// (`import { existsSync } from "node:fs"`) — the same load-bearing reason status.ts's own header
// comment documents: ESM named-export bindings off `node:fs` are non-configurable, so a test
// spying via `node:test`'s `mock.method` cannot intercept a call already bound to a named import
// at load time. Calling `fs.existsSync(...)` as a property access AT CALL TIME (never
// destructured to a local const) keeps every call a live lookup on this same mutable object, so
// a TOCTOU-race test (a marker present at `existsSync` but gone by `statSync`) can actually
// simulate it.
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

/** `"daemon"`/`"serve"` are RESIDENT (launchd `KeepAlive`) — `running` means "is the process up
 *  right now", and a `false` between events genuinely means dead. `"deploy-supervisor"` is an
 *  INTERVAL job (launchd `StartInterval`, W1-T… supervisor plist): launchd spawns ONE
 *  `rmd deploy-run`, it runs for well under a second, and exits — `running: false` is its
 *  NORMAL resting state between ticks, not a symptom. A binary running/not-running render
 *  can't tell those two "false" cases apart; {@link ServiceKind} lets the caller pick the right
 *  question for each row. */
export type ServiceKind = "resident" | "interval";

export function serviceKind(service: ServiceName): ServiceKind {
  return service === "deploy-supervisor" ? "interval" : "resident";
}

/** One LIVENESS row. `bootedAt`/`bootedAgeMs`/`headSha` are populated ONLY for `"daemon"` — the
 *  only service that logs a `daemon.boot` heartbeat to the ledger today (W1-T126); `serve`
 *  carries none of the three, which the text renderer shows as "unknown", never a fabricated
 *  zero. `tickAt`/`tickAgeMs`/`tickStep`/`lastExitCode`/`overdueThresholdMs` are populated ONLY
 *  for `"deploy-supervisor"` — recency comes from the ledger (every `rmd deploy-run` cycle logs
 *  a `deploy.*` line, even a same-head no-op logs `deploy.skip`; see deployer.ts's
 *  `runDeployCycle` — exactly parallel to `daemon.boot` for the daemon, no new sensor invented,
 *  per this module's own RENDERS-NEVER-SENSES rule); `lastExitCode` comes from the CLI layer's
 *  own `launchctl list <label>` read (its `Status` column — see run-task.ts's `queryService`),
 *  the same fact the W1-T301 rationale used by hand (`launchctl list` showing `LAST EXIT 0`) —
 *  never re-derived by guessing from the ledger step name. */
export interface ServiceLivenessRow {
  service: ServiceName;
  running: boolean;
  pid: number | null;
  /**
   * False iff the LAUNCHD SENSOR ITSELF could not be asked at all — `launchctl` absent
   * (ENOENT — every non-macOS host, W1-T2450) — as opposed to launchctl running and giving a
   * real "not loaded"/"no tick" answer. Defaults to `true` (the old, sensor-implicit
   * behaviour) when the caller's `queryService` doesn't report it, so every pre-existing
   * caller keeps reading exactly as before. `false` is the ONE bit `running: false` alone
   * could never carry: "I have no sensor here" vs "the answer is no" (recon rationale Q1) —
   * see {@link livenessState}, which reads it BEFORE falling into the resident/interval
   * running-vs-stopped logic below, so an absent sensor renders `"unknown"`, never a
   * confidently wrong `"stopped"`.
   */
  sensed?: boolean;
  bootedAt?: string;
  bootedAgeMs?: number;
  headSha?: string;
  /** Timestamp of the most recent `deploy.*` ledger line ("deploy-supervisor" only). */
  tickAt?: string;
  /** `now - tickAt`, clamped to >= 0 ("deploy-supervisor" only). */
  tickAgeMs?: number;
  /** The latest tick's ledger step name, e.g. `"deploy.skip"` / `"deploy.ok"` — informational
   *  only; failure is judged by {@link ServiceLivenessRow.lastExitCode}, not this. */
  tickStep?: string;
  /** `launchctl list`'s `Status` column for the job's last completed run — `0` healthy, nonzero
   *  a real exit failure, `undefined` unknown (never bootstrapped, or the query failed). */
  lastExitCode?: number;
  /** How stale `tickAgeMs` may get before this row reads `"overdue"` instead of `"idle"` —
   *  resolved from the INSTALLED unit's own `StartInterval` (never a hardcoded restatement of
   *  it — a plist edit must not silently desync this threshold); falls back to {@link
   *  SUPERVISOR_TICK_OVERDUE_MS} when the installed interval can't be read. */
  overdueThresholdMs?: number;
}

/** The liveness states a service can be in, replacing the old binary running/not-running
 *  render that made a healthy idle-between-ticks supervisor and a genuinely dead one print the
 *  identical "not running" line (the bug W1-T301 exists to retire). Resident services only
 *  ever report `"running"`/`"stopped"`/`"unknown"`; interval services add `"idle"` (mid-tick or
 *  fresh since its last tick) and `"overdue"` (no tick recently enough, or its last exit was
 *  nonzero). `"unknown"` (W1-T2450) is neither: it means the launchd sensor itself could not be
 *  asked (no `launchctl` on this host) — a stated "I don't know", never a fabricated `"stopped"`
 *  that happens to share `running: false` with a real one. */
export type LivenessState = "running" | "stopped" | "idle" | "overdue" | "unknown";

/** Fallback for {@link ServiceLivenessRow.overdueThresholdMs} when the installed unit's own
 *  `StartInterval` could not be read — 3x the supervisor plist's own default pace ({@link
 *  DEFAULT_SUPERVISOR_INTERVAL_S}), so one or two missed/slow ticks (a busy idle-gate retry, a
 *  slow health-check) don't false-positive; a supervisor gone genuinely quiet does. */
export const SUPERVISOR_TICK_OVERDUE_MS = DEFAULT_SUPERVISOR_INTERVAL_S * 3 * 1000;

/** Classify one row into its {@link LivenessState} — pure function of the row alone (every
 *  input, including its own overdue threshold, already lives on it), so the text renderer and
 *  `--json` consumers, and the LIVENESS next-action table, all derive the identical state from
 *  the identical facts. */
export function livenessState(row: ServiceLivenessRow): LivenessState {
  if (row.running) return "running";
  // W1-T2450: an absent sensor is read BEFORE the resident/interval split below — it applies
  // to both kinds identically (a daemon row and a deploy-supervisor row share the same
  // launchd sensor, recon rationale Q1's ROW 3 "inherits row 1's sensor"), and it must win
  // over every downstream inference (lastExitCode/tickAgeMs are equally untrustworthy when
  // the sensor that would have populated them never answered).
  if (row.sensed === false) return "unknown";
  if (serviceKind(row.service) === "resident") return "stopped";
  // interval: a nonzero last exit is a real failure regardless of how fresh it was, and no
  // tick ever observed reads as overdue too — never a healthy-looking "idle" for a supervisor
  // the ledger/launchd has never heard from.
  if (row.lastExitCode !== undefined && row.lastExitCode !== 0) return "overdue";
  const overdueMs = row.overdueThresholdMs ?? SUPERVISOR_TICK_OVERDUE_MS;
  if (row.tickAgeMs === undefined || row.tickAgeMs > overdueMs) return "overdue";
  return "idle";
}

/** The running daemon's boot sha vs a LOCAL (no-fetch) read of `origin/main` — reuses W1-T126's
 *  own `sameCommit` equality (deployer.ts), never a second comparison. `"unknown"` when either
 *  side could not be resolved (no `daemon.boot` line yet, or `origin/main` unreadable offline). */
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
  /**
   * Why this latch's RECORD is still worth showing while its INSTRUCTION no longer applies —
   * present only on a latch whose condition has been overtaken by events.
   *
   * TODAY THIS IS `DEPLOY_FAILED` AND ONLY IT. Nothing ever unlinks `state/DEPLOY_FAILED`
   * (deployer.ts writes it at two failure sites; `unlinkSync` there touches only the deploy
   * marker and the idle-deferred clock), so the alert is permanent until an operator removes the
   * file by hand — and its next action kept saying "re-deploy once fixed" long after origin/main
   * had moved past the head that failed. Measured on the mini: a latch 1h52m old naming
   * `86f3955`, by then an ancestor of both the running sha and origin/main, on a clean checkout.
   *
   * THE RECORD IS KEPT DELIBERATELY. A deploy that failed is a fact; the defect is the advice
   * attached to it. This is #1639's shape for LAST CLOSED CYCLE applied one block down: keep the
   * row, drop the instruction, say why.
   */
  superseded?: string;
}

export interface LatchesSection {
  rows: LatchRow[];
  nextAction?: string;
}

/** The newest `daemon.summary` ledger line, read back loosely (never re-typed against
 *  `DaemonSummary`'s strict `DaemonStopReason` union — a future stop reason this board doesn't
 *  yet know about must still render, not vanish). */
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
  /**
   * The newest `daemon.*` ledger activity STRICTLY AFTER this cycle closed, when there is any —
   * evidence the loop kept working since. A cycle only CLOSES when the loop stops, so a healthy
   * daemon writes no summary at all and this block would otherwise pin to the last abnormal stop
   * and imply it was current. MEASURED across all 524 `daemon.summary` rows: 312 `blocked`, 131
   * `error`, 56 `headroom_exhausted`, 23 `paused`, 1 `stopped`, 1 `max_reached` — NOT ONE says
   * "completed normally", because that row does not exist.
   */
  supersededByTs?: string;
  /** Age of {@link supersededByTs}, for the renderer. */
  supersededAgeMs?: number;
  nextAction?: string;
}

// ── BLOCKERS BY CLASS (W1-T280) — each class in its OWN vocabulary, never a generic "blocked"
// bucket (design fence: the board mints no blocker taxonomy that named-reason/breaker signals
// don't already carry) ──────────────────────────────────────────────────────────────────────

/** The streak dispatch-circuit-breaker (status.ts's `isDispatchBreakerTripped`) tripped for
 *  this task — the SAME ledger signal drain.ts/daemon.ts already gate dispatch on, re-read
 *  here, never re-implemented. `resetNote` states the breaker's OWN reset condition (a fresh
 *  owned PR resets the streak to 0) — the only "ETA" this ledger-derived signal actually
 *  carries; there is no time-based reset to compute. */
export interface CircuitBrokenBlocker {
  kind: "circuit_broken";
  taskId: string;
  dispatchCount: number;
  maxDispatches: number;
  resetNote: string;
}

/** This task's most recent dispatch was flagged INDETERMINATE (the ledger's own
 *  `dispatch.indeterminate` line — daemon.ts/drain.ts's existing `isIndeterminate` gate,
 *  itself either a GitHub-read failure or a ledger-count regression) — a PURE ledger read, so
 *  it renders regardless of GitHub reachability (the daemon already ledgers this; "visible to
 *  nobody without a ledger dig" is the falsifier this class exists to retire). `ghWindowNote`
 *  is ENRICHED, opportunistically, with the classified GitHub failure reason (status.ts's
 *  `StatusProjection.unavailableReason`, from the SAME batched `projectPlan` pass QUEUE
 *  HEAD/INBOX read) when a reachable gateway confirms the read is STILL indeterminate right
 *  now; otherwise it names the ledger fact alone — either way, "the gateway could not decide"
 *  never reads as "the task is broken". */
export interface IndeterminateBlocker {
  kind: "indeterminate";
  taskId: string;
  ghWindowNote: string;
}

/** An open PR the sweep reconciler (sweep.ts's `runSweep`) already disposed into a non-
 *  progressing class — RENDERS the vocabulary its own `sweep.disposed` ledger line already
 *  minted (the W1-T186 named-reason doctrine), never a second taxonomy. `reason` reads
 *  "reason not named" — never a blank — when the ledger line itself carries none. */
export interface BlockedPrBlocker {
  kind: "blocked_pr";
  taskId?: string;
  prNumber: number;
  prUrl?: string;
  disposition: string;
  reason: string;
}

/** A plan-declared `status: "blocked"` task carrying a `retirement` ruling (W1-T1287) — renders
 *  the vocabulary the PLAN ITSELF already supplies, never a taxonomy this board mints (the same
 *  design fence named above: "each class in its OWN vocabulary … that named-reason/breaker
 *  signals don't already carry"). A blocked task WITHOUT `retirement` renders no row here at
 *  all — exactly as before this field existed (the 41-of-43 dependency-stalled records this
 *  field exists to leave alone). */
export interface RetiredBlocker {
  kind: "retired";
  taskId: string;
  reason: string;
}

export type BlockerRow = CircuitBrokenBlocker | IndeterminateBlocker | BlockedPrBlocker | RetiredBlocker;

/** `circuit_broken` and `indeterminate` are PURE ledger reads — ALWAYS present in full
 *  regardless of GitHub reachability (GitHub only ever ENRICHES `indeterminate`'s note, never
 *  gates its presence). `blocked_pr` (W1-T306) is DIFFERENT: it is a claim about NOW, so its
 *  rows are re-derived against live GitHub merge state every render — never the raw ledger
 *  replay `sweep.disposed` alone would give. See status-board.ts's own header doc: GitHub is
 *  decoration, never a gate — but decoration for `blocked_pr` means "unverified", not
 *  "present the ledger's stale opinion anyway". */
export interface BlockersSection {
  rows: BlockerRow[];
  /** Set (W1-T306 design (4)) ONLY when the ledger holds at least one `sweep.disposed`
   *  "not progressing" line whose live GitHub state could NOT be checked this cycle (no
   *  gateway configured, or the gateway read itself failed — W1-T309: NOT gated on `plan`,
   *  this class needs none) — those entries are withheld from `rows` entirely rather than
   *  printed as if their disposition were still current. Absent whenever every candidate WAS
   *  checked (whatever the outcome), or there was nothing to check at all. */
  blockedPrsUnverifiedReason?: string;
  nextAction?: string;
}

// ── QUEUE HEAD (W1-T280) — the next dispatchables, with the four-re-dispatch falsifier named
// as a per-row flag (attempt count + observed per-cycle cost). BINDS THE DISPATCHER'S OWN
// `hasPushedRunBranch` PREDICATE (W1-T1205): `rows` is exactly `runnableCandidates`'s eligible
// set for the SAME options the real dispatcher applies, and a task excluded for having a run
// branch already on origin is named in `refused` rather than vanishing with no trace beyond a
// `dispatch.skipped` ledger row ────────────────────────────────────────────────────────────────

export interface QueueHeadRow {
  taskId: string;
  title: string;
  /** status.ts's `dispatchesWithoutNewOwnedPr` — the SAME streak count the circuit breaker
   *  itself trips on, so this row's number and BLOCKERS' `circuit_broken` class can never
   *  disagree about what "close to tripping" means. */
  attempts: number;
  /** True once `attempts` is at or near the streak breaker's threshold — the four-re-dispatch
   *  incident (07-24) becomes a line the operator reads in one second, before the fifth
   *  dispatch trips the breaker and forces an escalation. */
  perpetual: boolean;
  /** The most recent costed run's `cost_usd` (task-card.ts's `taskCardRuns`) — present only
   *  when `perpetual` is true, so repeated spend cannot stay invisible. */
  observedPerCycleCostUsd?: number;
}

/**
 * W1-T1205: one task `runnableCandidates` (drain.ts) — the SAME selector {@link QueueHeadRow}s
 * above are built from — REFUSED, with the reason it refused for, so the row is named on this
 * surface rather than vanishing from it with no trace beyond a ledger row (design (ii): "show
 * both and label them"). Deliberately scoped to `"run-branch-already-pushed"` only (see {@link
 * QueueHeadSection.refused}'s own doc for why the other {@link DispatchFilterReason}s are not
 * duplicated here) — `reason` still carries the full union type so a caller can render it
 * without a second enum, but this section's own derivation never pushes anything else onto it.
 */
export interface QueueHeadRefusedRow {
  taskId: string;
  title: string;
  /**
   * W1-T2415: the {@link DispatchFilterReason} union PLUS `"circuit-broken"` — widened HERE and
   * nowhere else, deliberately. A seventh arm on the union itself would move `IdleReasonTally`
   * (a `Record` over it), `tallyDispatchFilters`'s own literal, and every consumer that switches
   * on it — and it would contradict that union's own doc, which says the circuit "already
   * ledgers itself through its own dedicated `onXxx` callback". This takes the doc at its word:
   * the breaker reaches this surface through `onCircuitBreak`, exactly as `runDaemon`
   * (daemon.ts) already collects ids for `StarvationCensus` with `circuitBrokenThisTick`, and
   * only this section's own row type learns the extra literal.
   */
  reason: DispatchFilterReason | "circuit-broken";
  /**
   * Present ONLY on a `"circuit-broken"` row (W1-T2415). status.ts's
   * `dispatchesWithoutNewOwnedPr` at derivation time, the bound it was compared against, and the
   * breaker's OWN reset condition — the same three facts {@link CircuitBrokenBlocker} already
   * carries, re-derived through the same helpers rather than re-worded, so BLOCKERS and QUEUE
   * HEAD can never disagree about one task. Absent on every other reason: a
   * `run-branch-already-pushed` row is byte-identical to what it was before this task.
   */
  dispatchCount?: number;
  maxDispatches?: number;
  resetNote?: string;
}

export interface QueueHeadSection {
  rows: QueueHeadRow[];
  /**
   * W1-T1205 (rationale (2)/(3)): tasks the dispatcher's OWN eligibility chain
   * (`isDispatchEligible`, drain.ts) refuses for a reason this board can now name — never a
   * second, silent list. Before this task `hasPushedRunBranch` was not part of the predicate set
   * {@link deriveQueueHead} bound, so `rows` could (and, measured live, did) advertise tasks
   * dispatch would refuse; this closes exactly that gap by binding the SAME `hasPushedRunBranch`
   * predicate the real dispatcher applies and naming what it excludes, rather than only widening
   * `rows` silently.
   *
   * SCOPED TO `"run-branch-already-pushed"`, NOT EVERY {@link DispatchFilterReason} — deliberate,
   * not an oversight (design's own NOT-IN-SCOPE discipline): `"already-merged"` is DONE, not
   * refused; `"verify-not-auto"` is PERMANENTLY parked and already has its own surface (W1-T507's
   * console panel, cited not re-filed); `"blocked"`/`"unmet-deps"`/`"continued-this-pass"` were
   * never part of THIS defect's measured symptom (rationale (2)'s empty-intersection reproduction
   * was entirely `hasPushedRunBranch`-driven) and widening the surface to them is a different,
   * unfiled change. Empty when nothing was excluded for this reason — never a placeholder row.
   * Capped at {@link IDLE_REASON_ID_CAP} entries (drain.ts's OWN bound for exactly this "how many
   * ids to name" question, reused rather than a second constant) — see {@link
   * QueueHeadSection.refusedTruncated} for the count this drops.
   */
  refused: QueueHeadRefusedRow[];
  /** How many `"run-branch-already-pushed"` exclusions {@link refused} could not name because it
   *  hit {@link IDLE_REASON_ID_CAP} — `0` when nothing was dropped. A count, never a silent cap:
   *  the same "say how many, even when you can't say which" discipline `IdleReasonBucket.truncated`
   *  (drain.ts) already applies to this exact question. */
  refusedTruncated: number;
  /** Present when dispatch eligibility (merge state) could not be resolved — no reachable
   *  GitHub gateway, so nothing here would be trustworthy enough to print as "next up". */
  unknownReason?: string;
  /**
   * W1-T450: `rows` naming ELIGIBLE candidates renders identically whether they are about to
   * dispatch or have been sitting untouched for an hour — a daemon failing every pass looks
   * calm. Present ONLY when `rows` is non-empty AND the newest `run.start` already read (across
   * ANY task, not just these candidates) is older than {@link QueueHeadStall.boundMs}.
   *
   * SILENT, NOT JUST ABSENT, IN THE OTHER TWO CASES. An EMPTY queue never gets a `stall` —
   * `nothing dispatchable` is the honest idle state this defect is not (design (i)). An
   * UNREADABLE cadence — no ledger, no parseable `run.start`, or fewer than two dispatches ever
   * recorded to learn a gap from — also never gets one: an unknown answer must not render as a
   * finding (design (iv)).
   */
  stall?: QueueHeadStall;
  nextAction?: string;
}

/**
 * Names both halves of the stall (design (i)): how many candidates, and how long since anything
 * dispatched. NOT A GATE (design (ii)) — this only ever backs a rendered line and a next
 * action; nothing reading it may block or refuse a dispatch.
 */
export interface QueueHeadStall {
  /** `rows.length` at render time — repeated here so the rendered line is self-contained. */
  candidateCount: number;
  /** `now - lastDispatchTs`, clamped to >= 0. */
  sinceMs: number;
  /** The newest `run.start` line's own `ts`, across every task — task-id-agnostic like {@link
   *  distinctDispatchedTaskIds}: "nothing dispatched" means no task anywhere, not just one of
   *  today's candidates. */
  lastDispatchTs: string;
  /** The staleness bound THIS HOST'S OWN observed dispatch cadence licenses (design (iii)) —
   *  never a guessed round figure. See {@link boundDerivation} for how it was computed. */
  boundMs: number;
  /** States the derivation beside the constant, so an operator never has to trust a bare number. */
  boundDerivation: string;
}

// ── INBOX (W1-T280) — ready/not-ready COUNTS from inbox.ts's own InboxState; `rmd inbox`
// remains the detail surface, this board only summarizes ─────────────────────────────────────

export interface InboxSection {
  readyCount: number;
  notReadyCount: number;
  /** inbox.ts's `refusalReason` for the FIRST not-ready proposal only (registry order) — the
   *  board summarizes, it does not replace `rmd inbox`. */
  headNotReadyReason?: string;
  /** Present when classification could not be resolved — no reachable GitHub gateway for the
   *  dep-merged predicate, or no plan/tasks.yaml to resolve dependency ids against. */
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
  /** The daemon's own "governor disabled — telemetry only" note (config.ts ruling
   *  fb-1784894405468-a4153e), carried verbatim when the ledger line has one. */
  note?: string;
}

export interface HeadroomSection {
  found: boolean;
  telemetry?: HeadroomTelemetry;
  ts?: string;
  ageMs?: number;
  /** config.ts's `resolveHeadroomEnabled` — the SAME switch the daemon reads, never a second
   *  derivation. Present unconditionally: this is a LOCAL config read, never gated on GitHub. */
  enforced: boolean;
  /**
   * The newest `daemon.headroom.degraded` line, when one is in the window — the governor
   * announcing that it CANNOT READ usage and has stopped dispatching (daemon.ts's park:
   * `consecutiveUnreadable > unreadableDegradedLimit` ⇒ log, sleep, `continue`).
   *
   * WHY THIS FIELD EXISTS. Without it `found` is false in two completely different states —
   * "no daemon has ticked yet" and "a daemon is ticking and will never produce a
   * `daemon.headroom` row" — and {@link HEADROOM_NEXT_ACTIONS}' first rung reported the
   * reassuring one for both: "it appears after the daemon's first tick". A permanent park
   * rendered as an in-progress start-up. The two are distinguishable from the ledger and
   * always were: the parked daemon writes `daemon.headroom.degraded` every tick while blind.
   *
   * THE LINE CARRIES ITS OWN DURATION, which is why one line is enough and no history is
   * needed: `consecutive_unreadable` × `poll_interval_ms` states how long the blindness has
   * lasted (ledger.ts's own note records observed counters of 4..42 at 60 000 ms). That also
   * survives rotation — `daemon.headroom.degraded` is in {@link RENDER_RELEVANT_LEDGER_STEPS}
   * with a 30-minute window, and while blind it re-fires every tick (median gap 2.32 min), so
   * a live episode always has a line inside the window.
   */
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

/**
 * W1-T929: the cache-hit ratio (feedback fb-1785237559155-feef92, MASTER-PLAN §8A), per run and
 * per task class, over the SAME read ledger window {@link buildStatusBoard}'s other sections
 * already opened — `found: false` when nothing in that window carries usable cache-token data
 * yet (mirrors digest.ts's `DigestSummary.cacheHit` soft-compose discard, design note (iv)).
 * `totals` is digest.ts's own {@link CacheHitTotals}, computed by its {@link
 * aggregateCacheHitTotals}: ONE traversal, so `rmd status` and the daily digest can never
 * disagree on WHICH lines count.
 */
export interface CacheHitSection {
  found: boolean;
  totals?: CacheHitTotals;
}

/**
 * W1-T940: LEARNINGS INJECTION DROP PRESSURE (feedback fb-1785237596465-45d06d, MASTER-PLAN
 * §8A) — the SAME read ledger window {@link buildStatusBoard}'s other sections already opened,
 * aggregated by digest.ts's {@link aggregateLearningsInjection}: ONE traversal, so `rmd status`
 * can never disagree with the digest on which `learnings.injected` rows count. `found: false`
 * when the window carries no `learnings.injected` rows at all (design note (iv) — a spawn-free
 * window renders explicit absence, never a fabricated `dropped: 0`).
 */
export interface LearningsInjectionSection {
  found: boolean;
  totals?: LearningsInjectionTotals;
}

/**
 * W1-T931 COST-ANOMALY SENTINEL (fb-1785237559155-feef92, item 4) — one un-dismissed
 * `cost.anomaly` ledger row (`src/lib/cost-anomaly.ts`'s `recordCostAnomalies`, hung off
 * `src/lib/sweep.ts`'s `runSweep`): a run that cost more than `multiplier` times its own task
 * CLASS's median, over a class with at least the policy's minimum sample count. Names every fact
 * the task's own acceptance criterion asks for — the run, its class, its cost, and the median it
 * exceeded — and NOTHING more: this row REPORTS ONLY (design note v), the same "renders, never
 * senses, never acts" discipline this module's own header states for every other section.
 */
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

/**
 * W1-T1021 IMAGE DRIFT — the newest un-dismissed `daemon.image_drift` ledger row
 * (`src/lib/image-drift.ts`'s `checkImageDrift`, ledgered by `serviceFreshnessGate` in
 * `src/run-task.ts` beside `daemon.tree_dirty`/`daemon.stale_code`): a baked path
 * (`deploy/entrypoint.sh` or `deploy/Dockerfile`) changed on `main` AFTER the running
 * container's own image was built, so the image cannot pick it up on a mount-side freshness
 * restart the way `src/`/`test/`/`node_modules` do. Names the two shas a human needs to judge
 * it — the image's own build sha and the baked commit it is missing.
 */
export interface ImageDriftRow {
  buildSha: string;
  bakedSha: string;
  /** The `daemon.image_drift` ledger line's own `ts`, when present. */
  ts?: string;
}

/**
 * W1-T1000003 — A MERGE HOLD ENGAGED BY AN OPERATOR (review.ts's `automergeHoldFromLedger`,
 * written by W1-T1000002's `automerge.hold_engaged`/`automerge.hold_released` ledger rows).
 * NOT a blocker (design fence (ii) of the task record): a blocker is something ELSE stopping
 * progress the operator would want fixed; a hold is the operator's OWN standing refusal to let
 * anything merge, so it renders here, in the escalation surface, never re-derived from check or
 * review fields — see {@link deriveMergeHeld}'s own doc for the reader it consumes verbatim.
 */
export interface MergeHeldRow {
  /** Absent for a FLEET-scoped hold (no `pr_number` on the ledger row) — applies to every open
   *  request, not one. Present for a PR-scoped hold, naming the held request. */
  prNumber?: number;
  /** Opportunistic enrichment from the SAME `automerge.hold_engaged` row's own `task_id`
   *  field — "latest wins", never the fact that decides whether the hold is still standing
   *  (that is {@link automergeHoldFromLedger} alone, exactly as sweep.ts's `alreadyDone` and
   *  run-task.ts's `attemptArm` already consult it). Absent when the row never carried one, or
   *  for a fleet-scoped hold with no single task to name. */
  taskId?: string;
  /** Who engaged the hold — {@link AutomergeHold.by}, carried through unchanged. */
  by: string;
  /** Why — {@link AutomergeHold.reason}, carried through unchanged; never a reason this board
   *  invents from a check or review field. */
  reason: string;
}

/**
 * NEEDS ME — the board's own escalation surface (distinct from `rmd serve`'s HTML "Needs me"
 * panel, which is task-escalation-driven; design note (viii) scopes this task to EXACTLY the
 * console surfaces `rmd status` text and `--json` project, "the whole surface here"). Today
 * carries the cost-anomaly rows W1-T931 shipped plus W1-T1021's image-drift finding plus
 * W1-T1000003's merge-hold rows; a future sentinel is a new field here, not a new section.
 */
/**
 * THE FLEET IS RUNNING ON THE FALLBACK TOKEN RIGHT NOW — the newest `github_app.token_refresh_failed`
 * is newer than the newest `github_app.token_refreshed` (or there has never been a success), so
 * `refreshInstallationToken` left `process.env.GH_TOKEN` exactly as it found it and every `gh` spawn
 * since is billing the PERSONAL token's buckets instead of the installation's.
 *
 * DELIBERATELY A CURRENT-STATE READ, NOT A COUNT OF HISTORICAL FAILURES. The exchange retries on the
 * `REFRESH_MARGIN_MS` cadence, so an isolated failure followed by a success is the system working and
 * must render nothing; only a failure that is still the LAST word means the fallback is standing.
 * Same "latest wins" comparison {@link ImageDriftRow} already gets from `isNewer`.
 */
export interface TokenFallbackRow {
  /** Why the last exchange failed, verbatim off the row (`exchange timed out`, `exchange rejected: 403`, …). */
  reason: string;
  /** When that failure was recorded. */
  ts?: string;
  /** When the last SUCCESSFUL refresh was, if there has ever been one — absent means never. */
  lastOkTs?: string;
}

/**
 * W1-T2392: one merged BUILD that names a task in its own prose and that no credit surface
 * claimed — `StatusProjection.uncreditedBuild`, carried through verbatim rather than re-derived.
 *
 * WARN, NEVER CREDIT. `uncreditedBuildWarning` (status.ts) deliberately does not credit from prose:
 * a task credited wrongly is never built at all, which is strictly worse than one credited late.
 * This row is a REPORT of that warning and changes no disposition — the projection it reads is the
 * same object every other consumer sees, and nothing here writes back to it.
 */
export interface UncreditedBuildRow {
  /** The task whose build merged uncredited. */
  taskId: string;
  /** The merged PR that names it in prose. */
  prNumber: number;
  prUrl: string;
  /** Which prose surface carried the id — measured at head, 14 of 19 name it in the BODY only,
   *  so an operator told "title" for a body-named build would look in the wrong place. */
  namedIn: "title" | "body";
}

export interface NeedsMeSection {
  costAnomaly: CostAnomalyRow[];
  imageDrift?: ImageDriftRow;
  /** W1-T1000003: currently-standing operator merge holds — empty (never `undefined`) when
   *  none stand, so the quiet case renders no row at all (design (iii)). */
  mergeHeld: MergeHeldRow[];
  /** W1-T2392: merged builds no credit surface claimed. EMPTY (never `undefined`) when none —
   *  same quiet-case discipline as `mergeHeld` above, so the common board renders no row at all.
   *  MEASURED at head: 84 of 103 recent builds ARE credited, so quiet is the common case. */
  uncreditedBuilds: UncreditedBuildRow[];
  /** The standing App-token fallback, if one stands — absent when the last refresh succeeded, so a
   *  healthy fleet renders no row. */
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
  /**
   * Per-service running/pid(+ for `"deploy-supervisor"`, its last completed run's exit code).
   * `launchctl print`/`launchctl list` live at the CLI layer (run-task.ts's own
   * `queryLaunchdServiceSensed`/`queryLaunchdListStatusSensed` + `DAEMON_LABEL`/`SERVE_LABEL`/
   * `SUPERVISOR_LABEL`) — this module never shells to launchd itself (Rule 16: lib/ stays a thin,
   * injectable seam over that). Required; no default exists inside lib/. `lastExitCode` is
   * `undefined` when unknown (never bootstrapped, or the query failed) — the caller must not
   * fabricate a healthy-looking `0`. `sensed` (W1-T2450) is `false` iff `launchctl` itself could
   * not be invoked at all (ENOENT — no launchd on this host); omitted/`true` reads exactly as
   * before this field existed — see {@link ServiceLivenessRow.sensed}.
   */
  queryService: (service: ServiceName) => { running: boolean; pid: number | null; lastExitCode?: number; sensed?: boolean };
  /** The checkout to compare against `origin/main` (the daemon's own repoRoot). */
  repoDir: string;
  /**
   * The deploy-supervisor's OWN installed `StartInterval` (seconds), read from the unit actually
   * on disk — never a restated constant, so a `--interval` override at install time can't silently
   * desync this module's overdue threshold from it. Defaults to {@link DEFAULT_SUPERVISOR_INTERVAL_S}
   * when omitted or the installed unit can't be read (never a plist read, never a throw, from lib/).
   */
  resolveSupervisorIntervalS?: () => number | undefined;
  /** Ledger reader; defaults to status.ts's real `readLedgerLines`. */
  readLedger?: LedgerReader;
  /** LOCAL (no-fetch) resolution of `origin/main`'s sha — offline-safe by construction. Defaults
   *  to `git rev-parse origin/main` in `repoDir`; returns `undefined` (never throws) when it
   *  cannot be resolved (no git, not a repo, no such ref, network-off has no bearing since this
   *  never fetches). */
  resolveOriginMainSha?: (repoDir: string) => string | undefined;
  /** Clock; defaults to `Date.now`. Injectable so a test can assert an exact age. */
  now?: () => number;
  /** Crash-loop window/threshold; defaults to daemon.ts's `DEFAULT_CRASHLOOP_WINDOW`. */
  crashLoopWindow?: CrashLoopWindow;
  /** Pid-liveness probe for inflight-lock rows; defaults to drain-lock.ts's real check. */
  isPidAlive?: (pid: number) => boolean;

  // ── W1-T280 (DERIVED half) ────────────────────────────────────────────────────────────────

  /** Local (offline) `plan/tasks.yaml` read — the DAG source QUEUE HEAD and INBOX resolve
   *  against (and BLOCKERS' `indeterminate` class opportunistically enriches its note from,
   *  when reachable). Defaults to `loadPlan(join(repoDir, "plan", "tasks.yaml"))`; `undefined`
   *  (never a throw) when unreadable, degrading QUEUE HEAD/INBOX to a stated `unknownReason` —
   *  BLOCKERS is a pure ledger read and needs no plan at all, unaffected either way. */
  plan?: Plan;
  /**
   * The batched GitHub gateway (status.ts's `buildBatchedGithub`) backing every remote fact
   * QUEUE HEAD's dispatch eligibility and INBOX's dep-merged predicate read — read through ONCE
   * per render (`projectPlan`'s own batching), never per row. Omitted, or reporting
   * `readFailed()` after that one batched pass, degrades exactly those two sections to a
   * stated `unknownReason` — never a throw, never a fail-closed board. LIVENESS/LATCHES/LAST
   * CYCLE and BLOCKERS BY CLASS (a pure ledger read, always in full — GitHub only ever
   * ENRICHES its `indeterminate` class's note, never gates the row's presence) are UNAFFECTED
   * (GitHub is decoration, never a gate).
   */
  github?: GitHub;
  /** Local (no-network) evidence-anchor grep for INBOX; defaults to inbox.ts's
   *  `gitGrepAnchorTrue(repoDir, "origin/main", anchor)`. */
  grepAnchorTrue?: (anchor: EvidenceAnchor) => boolean;
  /** `state/inbox-proposals.json` reader; defaults to the real file under `root`, parsed by
   *  inbox.ts's own fail-soft-to-empty `parseProposalRegistry`. */
  readProposalRegistry?: () => Proposal[];
  /** `state/inbox-drafts.json` reader; defaults to the real file under `root`, parsed by
   *  inbox.ts's own fail-soft-to-empty `parseDraftCache`. */
  readDraftCache?: () => DraftCache;
  /**
   * The headroom-governor switch (config.ts's `resolveHeadroomEnabled(config)`) — a
   * config-file read, so injected exactly like `queryService` rather than re-derived inside
   * lib/ (Rule 16: this module stays a thin seam over the CLI layer's own config load). The
   * real wiring passes `() => resolveHeadroomEnabled(config)`, the SAME switch the daemon
   * itself reads every tick. Omitted falls back to the product default (`true`, governor ON)
   * rather than fabricating "off".
   */
  resolveHeadroomEnabled?: () => boolean;
  /** Max rows QUEUE HEAD and BLOCKERS' blocked-PR class each show; defaults to 5. */
  queueHeadLimit?: number;
  /**
   * W1-T1205: raw `git ls-remote --heads origin 'run-*'` output, parsed by drain.ts's {@link
   * runBranchTaskIds} into the SAME `hasPushedRunBranch` predicate the real dispatcher binds
   * (`DrainDeps.readPushedRunBranches`/`DaemonDeps.readPushedRunBranches`) — QUEUE HEAD needs its
   * OWN reader rather than sharing a closure with either, because it is a separate, unbatched
   * call site (design (i): "pass the SAME OPTIONS the dispatcher passes", not the same call).
   * Defaults to a real `git ls-remote` in `repoDir` (mirrors {@link resolveOriginMainSha}'s own
   * "lib/ shells git directly" precedent immediately below this field) — LIVE, no-fetch, git
   * PROTOCOL (never the REST/GraphQL budget), measured at 199 ms for 46 refs (drain.ts's own
   * doc). Returns `""` (never throws) when it cannot be read (no git, no remote, offline),
   * degrading `hasPushedRunBranch` to "nothing observed pushed" rather than blocking the board.
   */
  readPushedRunBranches?: (repoDir: string) => string;
  /**
   * W1-T2264: read of the fleet-wide shared PAUSE hold (fleet-control.ts's `sharedPauseRef`) — a
   * git ref that {@link buildLatchRows}'s STATIC_LATCHES loop cannot see, because every one of
   * those rows is sourced from `fs.existsSync` on a local path. Exactly ONE `git ls-remote`
   * (fleet-control.ts's `readSharedPause`) — matching the task's own cost bound: never the second
   * round trip `checkSharedPause`'s anchor lookup would cost, and never `checkSharedPause` itself,
   * whose "local first" fold would render the SAME hold this board's own local PAUSE row already
   * shows (see {@link buildLatchRows}'s dedup). Defaults to a real read via
   * `realSharedPauseGitDeps(repoDir)`. Returns `"unreachable"` (never throws) when origin cannot be
   * reached — the same fail-soft direction `readSharedPause` itself already keeps: an unreachable
   * remote is never read as `"absent"`.
   */
  readSharedPauseState?: (repoDir: string) => SharedPauseRead;
  /**
   * W1-T2270: read of every currently-held PER-TASK dispatch claim (dispatch-claim.ts's
   * `dispatchClaimRef`, `refs/rmd-dispatch/<taskId>`) — a git ref namespace {@link buildLatchRows}'s
   * STATIC_LATCHES loop cannot see for the same reason it could not see `refs/rmd-pause/hold`
   * before W1-T2264: every one of those rows is sourced from `fs.existsSync` on a local path.
   * `decideDispatchClaimRelease` refuses a time-based expiry on the stated ground that a stranded
   * claim is "a visible ref an operator can drop" — this is the read that makes it actually
   * visible, so that premise stops being false. Exactly ONE `git ls-remote` against the whole
   * namespace (never one round trip per task, and never the anchor decode a HOLDER's pid/host
   * would cost — see {@link DispatchClaimsRead}'s own doc). Defaults to a real read via
   * `defaultReadDispatchClaims`. Returns `{status: "unreachable"}` (never throws) when origin
   * cannot be reached — an unreachable remote is reported as UNDETERMINED, never as "no claim
   * held" and never as a specific task's claim (Q3's same fail-closed direction, applied here).
   */
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

/**
 * Real default for {@link StatusBoardDeps.readSharedPauseState} — see that field's own doc.
 *
 * GUARDED ON `.git` EXISTING FIRST (a synchronous, local, no-subprocess `fs.existsSync` — never a
 * second round trip, and never a second git invocation either), so a `repoDir` that is not a git
 * checkout at all (no remote could ever exist to be unreachable) reads as `"absent"` rather than
 * `"unreachable"`. This is NOT the same failure this function's OWN `readSharedPause` already
 * fails soft on: a checkout that IS real but cannot currently reach `origin` still reads
 * `"unreachable"` exactly as designed (Q3: an unreachable remote is never scored `"absent"`) —
 * this guard only keeps "there is no repo here" from being misread as "the remote is down".
 */
function defaultReadSharedPauseState(repoDir: string): SharedPauseRead {
  if (!fs.existsSync(join(repoDir, ".git"))) return "absent";
  return readSharedPause(realSharedPauseGitDeps(repoDir));
}

/**
 * W1-T2270: every currently-held `refs/rmd-dispatch/<taskId>` claim (dispatch-claim.ts), read via
 * exactly ONE `git ls-remote origin 'refs/rmd-dispatch/*'` — the same cost profile
 * {@link defaultReadSharedPauseState} already keeps for the singleton PAUSE ref, applied to a
 * NAMESPACE instead of one ref because a dispatch claim is per-task, not fleet-wide.
 *
 * `"unreachable"` on a nonzero exit — an unreadable remote is a FAILED READ, never scored
 * `"clear"` (the identical fail-closed direction {@link decideDispatchClaim} itself takes, and
 * {@link readSharedPause}'s own UNREACHABLE-MEANS-HELD precedent). `"clear"` on exit 0 with no
 * matching ref at all. `holder` is the anchor's own sha — never a second round trip to decode the
 * pid/host {@link gitDispatchClaimReserver}'s `mintAnchor` embeds in the commit message, mirroring
 * this file's OWN SHARED_PAUSE row (which also skips that second round trip) and reusing the exact
 * word `decideDispatchClaim`'s own refusal message already gives that sha: "holder".
 */
export type DispatchClaimsRead =
  | { readonly status: "clear" }
  | { readonly status: "held"; readonly claims: ReadonlyArray<{ readonly taskId: string; readonly holder: string }> }
  | { readonly status: "unreachable" };

/** Every `refs/rmd-dispatch/<taskId>` line off a `ls-remote origin 'refs/rmd-dispatch/*'`, parsed
 *  the same "split on tab, strip the known prefix" way {@link runBranchTaskIds} already parses its
 *  own wildcard sweep — a malformed or unrelated line is skipped rather than thrown. */
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

/** Real default for {@link StatusBoardDeps.readDispatchClaims} — see that field's own doc. Guarded
 *  on `.git` existing first, exactly like {@link defaultReadSharedPauseState}, for the identical
 *  reason: no repo here means no remote could ever exist to be unreachable. */
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
  /** Every `daemon.boot` line, oldest-or-newest order irrelevant ({@link detectDaemonCrashLoop}
   *  sorts internally), each carrying WHY THE BOOT BEFORE IT ended when the ledger says so
   *  (W1-T2450: recon rationale Q3 — see {@link DaemonBootTimestamp}). A boot immediately
   *  preceded by a `daemon.summary` line whose `stopReason` is `"stale"` was a FRESHNESS
   *  restart (`daemon_selfrestart_for_freshness`/W1-T126's `exit 75`), not a crash, and is
   *  tagged `priorExitReason: "freshness"` so the crash-loop check can tell six routine
   *  restarts from six real crashes without discarding either signal. */
  allBoots: DaemonBootTimestamp[];
}

function deriveDaemonBoots(lines: ReadonlyArray<Record<string, unknown>>): BootInfo {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestHeadSha: string | undefined;
  // W1-T2450: every `daemon.summary` line's own `ts`/`stopReason`, gathered in the SAME pass —
  // paired against each boot BELOW by nearest-preceding timestamp, never by input line order
  // (a rotation union is not guaranteed chronological), since exactly one summary (at most)
  // ever precedes any one boot: a daemon process logs one `daemon.boot` at start and, on the
  // ONE path that restarts itself (`return summary("stale", ...)` in the scheduler loop),
  // exactly one `daemon.summary` right before it exits.
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

/**
 * The newest `daemon.*` ledger activity strictly after `sinceTs` — prefix-matched exactly as
 * `deriveLastPoll` (daemon-health.ts) already matches, NEVER on a step name. That prefix is why
 * LIVENESS stayed correct through a ten-hour window in which LAST CYCLE was pinned to a stopped
 * cycle: the two derivations read the same ledger and only one of them tracked the daemon.
 */
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

/** The latest `deploy.*` ledger line — every `rmd deploy-run` cycle logs exactly one (see
 *  deployer.ts's `runDeployCycle`), so this is the deploy-supervisor's own recency heartbeat,
 *  read the same "scan for the newest line with this step-family, by parsed `ts`" way {@link
 *  deriveDaemonBoots}/{@link deriveLastCycle} already read the daemon's. Failure is judged
 *  separately, from the CLI layer's own `launchctl list` exit-code read (see `lastExitCode` on
 *  {@link ServiceLivenessRow}) — never guessed from a step name here. */
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

/** AGE for a marker file: prefer its own `requestedAt`/`at` JSON field; fall back to the file's
 *  mtime (e.g. DEPLOY_AUTO, a bare touch file with no JSON body at all). */
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

/** Ordered by operational urgency — also the order rows render in (most-actionable first). */
/**
 * What a DEPLOY_FAILED latch actually MEANS, branched on the `kind` the deployer already wrote.
 *
 * THE TWO KINDS DID DIFFERENT THINGS AND MUST NOT SHARE A SENTENCE. `DeployFailureKind`
 * (`deployer.ts`) is exactly `dirty-tree-conflict | health-check-rollback`, and `deps.resetHard` has
 * exactly ONE call site — the health-check arm of `runDeployCycle`, which resets and then
 * `kickstart`s. The dirty-tree arm returns immediately after `deps.alert`, BEFORE `pullFf` is
 * reached: nothing is pulled, nothing is reset, and the daemon is still on the head it already had.
 * Telling that operator the checkout "was rolled back" and is "running the PRIOR head" is false
 * twice over — there is no prior head for it to be on — and it sends the diagnosis toward a deploy
 * that ran when the real situation is uncommitted files in the install checkout.
 *
 * A MISSING OR UNRECOGNISED `kind` RENDERS NEITHER SENTENCE. Asserting one of two incompatible
 * facts on no evidence is the defect being fixed, not a fallback for it — so an alert file from an
 * older build degrades to naming what is known and explicitly withholding the rest. This mirrors
 * `realDeployDeps.lastFailedKind`, which already answers `undefined` for exactly this input and says
 * why in its own comment: "absent/legacy/corrupt ⇒ reason not recorded, never a guess".
 *
 * THE DEPLOYER'S MESSAGE IS APPENDED VERBATIM ON EVERY ARM. For a dirty-tree abort it carries the
 * conflicting paths as PROSE (`… conflict with the fast-forward: <paths>`) — that list is the single
 * most actionable thing on the row, it already reaches the operator today, and no rewrite of the
 * clause in front of it may drop or truncate it.
 */
export function deployFailedConsequence(json: Record<string, unknown> | null): string {
  const kind = typeof json?.kind === "string" ? json.kind : undefined;
  const failedHead = typeof json?.failedHead === "string" ? json.failedHead.slice(0, 12) : undefined;
  const rawMessage = typeof json?.message === "string" ? json.message : undefined;
  // The old default asserted a health-check failure, which is the same unfounded claim one level
  // down — a message-less alert says only that a deploy failed.
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

const STATIC_LATCHES: readonly StaticLatchDef[] = [
  {
    name: "DEPLOY_FAILED",
    path: deployFailedAlertPath,
    consequence: (json) => deployFailedConsequence(json),
    // THE DEPLOYER'S OWN RETRY TEST, REUSED RATHER THAN RESTATED. `decideDeployTrigger` refuses an
    // auto-retry only while `originMain === lastFailedHead` (its `alreadyFailed`), so the moment
    // origin/main moves past the failed head the supervisor WILL retry on its own and the operator
    // has nothing to do. Asking the same question here — through the same `sameCommit`, which is
    // already imported — means the advice and the machinery can never disagree about whether a
    // retry is pending. No git call, no ancestry walk: one sha comparison the board already holds.
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
  // A pre-bound thunk (the caller has already closed over `deps.repoDir`) — mirrors `isPidAlive`
  // just above: this function takes an already-resolved reader, never the raw deps field, so a
  // test can inject any three-way answer without needing a real repo checkout.
  readSharedPauseState: () => SharedPauseRead,
  // APPENDED LAST and optional, so no positional caller shifts. `undefined` (origin/main
  // unresolvable — an offline host, a missing remote) means NO supersession is claimed and the
  // instruction stands, which is the fail-closed direction: an unreadable answer must never
  // silence a real failure.
  originMainSha?: string,
  // W1-T2270: same pre-bound-thunk shape as `readSharedPauseState` just above, for the same
  // reason — a test injects any of the three outcomes without a real repo checkout. Optional and
  // appended last (Q1's own convention on this exact function) so no positional caller shifts;
  // omitted reads as `{status: "clear"}`, matching a repo that has never taken a dispatch claim.
  readDispatchClaims: () => DispatchClaimsRead = () => ({ status: "clear" }),
  // W1-T2446: SAME "appended last and optional" convention as the two thunks above — the merge
  // credit `readDispatchClaims`'s own row text asserted away rather than consulted. This board
  // "reads and reports, it never drops anything" (unchanged — no release call is added here);
  // it only stops the held-claim row from asserting "no landed work observed" for a task that
  // IS credited merged. Omitted reads as `() => false`, matching a repo/plan this render could
  // not project (today's behavior, byte-identical, for every caller that omits it).
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

  // Shared cross-host PAUSE hold (W1-T2264) — `refs/rmd-pause/hold`, a git ref every row above is
  // blind to, because every one of them is sourced from `fs.existsSync` on a local path. Read via
  // exactly ONE `ls-remote` (never a second round trip for attribution — that stays behind the
  // optional `ageMs`, which simply reads "unknown" here, same as an inflight/kick row with no
  // cheap age available).
  //
  // DEDUP, LOCAL FIRST (mirrors fleet-control.ts's OWN `checkSharedPause` precedence, design (i)
  // there): `rmd pause` on THIS host writes the local PAUSE flag AND best-effort pushes this same
  // ref, so a host that paused itself would otherwise render its own hold twice — once as the
  // PAUSE row above, once as this one. Skip the read entirely once a local PAUSE row already
  // rendered: cheaper (no network call at all) and correct (the local row already tells this
  // host's own story; a second host's hold, if one also stands, is that OTHER host's board to
  // show).
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
      // FAIL SOFT, NEVER SILENT AND NEVER "CLEAR" (Q3): an unreachable remote is scored exactly
      // like `readSharedPause` itself scores it for dispatch — held, not absent — but this row
      // says which of the three states it actually saw rather than asserting a hold it cannot
      // confirm.
      rows.push({
        name: "SHARED_PAUSE",
        consequence:
          `cannot reach origin to read ${sharedPauseRef()} — holding rather than dispatching ` +
          "optimistically (an unreachable remote is never read as clear)",
      });
    }
  }

  // Per-task dispatch claims (W1-T2270) — `refs/rmd-dispatch/<taskId>`, a git ref namespace
  // STATIC_LATCHES cannot see (file-only, same gap W1-T2264 closed for the singleton PAUSE ref).
  // `decideDispatchClaimRelease` leaves a claim held by another lane for an OPERATOR precisely
  // because cross-host liveness is not decidable — this row is what makes that claim actually
  // findable, never a fourth release arm: it reads and reports, it never drops anything.
  const dispatchClaims = readDispatchClaims();
  if (dispatchClaims.status === "held") {
    for (const { taskId, holder } of dispatchClaims.claims) {
      // W1-T2446: "WITH NO LANDED WORK OBSERVED" was asserted UNCONDITIONALLY for every held
      // claim — nothing on this path ever consulted merge credit, so for a task whose work HAD
      // landed (W1-T2424) the board kept saying it had not. `isMerged` is the SAME projection
      // `deriveQueueHead`/`deriveInbox` already build in this same render (`projections.get(id)
      // ?.merged === true`) — no new probe, no new read, threaded in rather than re-derived.
      // This ONLY corrects the sentence's truth value: it names the claim as stale rather than
      // asserting it is live, and still `git push origin :<ref>` — the OPERATOR arm, unchanged.
      // No drop is issued from here; this row still only reads and reports.
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
    // UNDETERMINED, NEVER "NO CLAIM HELD" (Q3's own fail-closed direction, applied here): a
    // failed read must not silently render as a clear fleet — it names what it could not tell.
    rows.push({
      name: "DISPATCH_CLAIMS",
      consequence:
        `cannot reach origin to read held dispatch claims (${dispatchClaimRef("")}*) — undetermined, ` +
        "not clear: a task may be silently stranded on another lane's unreleased claim and this board " +
        "cannot yet tell which",
    });
  }

  // Inflight locks — one row per LIVE lock (a dead-pid lock is stale debris, not an active
  // latch — mirrors run-task.ts's own liveInflightRuns definition of "in flight").
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

  // drain-now — PEEK ONLY, never consume (consuming is exclusively the daemon's own job;
  // a status read must never have the side effect of erasing the very request it reports).
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
    // W1-T2450: a daemon row reading `"unknown"` (no launchd sensor on this host — see
    // `livenessState`) must NEVER be advised on as a `"stopped"` one — `rmd up` is nonsense
    // advice for a process this panel never actually asked about. Checked BEFORE the
    // `"stopped"` rule below so the unknown case wins.
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
    // deploy-supervisor is a periodic one-shot: `running: false` between ticks is its NORMAL
    // rest state (see ServiceKind), so this only fires once a tick is actually overdue/failing —
    // never on the routine idle-between-ticks gap the binary render used to misreport.
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
    // Incident (a): DEPLOY_FAILED must never sit invisible again.
    // `!r.superseded` IS THE FIX. A DEPLOY_FAILED row whose head origin/main has moved past needs
    // no operator action — the supervisor retries by itself — so the row stays and the instruction
    // goes. A GENUINELY failed deploy (origin/main still ON the failed head) is unaffected.
    applies: (ctx) => ctx.rows.some((r) => r.name === "DEPLOY_FAILED" && !r.superseded),
    action: () => "inspect state/DEPLOY_FAILED and re-deploy once fixed (`rmd deploy`)",
  },
  {
    applies: (ctx) => ctx.rows.some((r) => r.name === "STOP"),
    action: () => "STOP is set — no action needed unless unexpected; it auto-clears when the halted run ends",
  },
  {
    // W1-T2264: this row can be a hold ANOTHER host set (or an unreadable answer about one), so —
    // unlike PAUSE below, set by whoever is reading this very board — this line never names the
    // releasing action itself; the row's own consequence (buildLatchRows) already names the ref
    // and the remedy verb for the confirmed-held case, and that is the more trustworthy place for
    // it to live for a hold this host did not necessarily set.
    applies: (ctx) => ctx.rows.some((r) => r.name === "SHARED_PAUSE"),
    action: () => "a cross-host hold may be affecting dispatch beyond this host — see the SHARED_PAUSE row above before assuming it is local",
  },
  {
    // W1-T2270: same reasoning as SHARED_PAUSE just above — never names the releasing action
    // itself (the row's own consequence already names the ref and the operator's drop command),
    // and this covers both the confirmed-held rows and the single unreachable-remote row.
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

/** ONE batched projection pass over the whole plan (status.ts's `projectPlan`, which itself
 *  fetches GitHub exactly once and shares it across every task) — the single remote read that
 *  backs QUEUE HEAD's dispatch eligibility, INBOX's dep-merged predicate, and BLOCKERS'
 *  `indeterminate` class. Returns `undefined` projections with a stated `unknownReason` when
 *  no plan or no reachable gateway backs this render — NEVER a throw, never a per-row fetch. */
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

/** Every distinct task id the ledger has EVER dispatched — enumerated from just the ledger's own
 *  `run.start` history (mirrors `dispatchesWithoutNewOwnedPr`'s own task-id-agnostic scan), no
 *  plan needed for THIS step. W1-T2335: {@link deriveCircuitBrokenBlockers} itself now consults
 *  the plan/projections it's given to skip a candidate dispatch will never take — see its own
 *  doc — but this enumeration is unaffected and still needs neither. */
function distinctDispatchedTaskIds(lines: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    // W1-T2383 rank 3: QUEUE dispatches only. A triage/retro `run.start` names an id no
    // dispatch will ever take, and `deriveCircuitBrokenBlockers` below does not filter to plan
    // tasks — see `isQueueDispatchRunStart`' own doc for the two ids this measurably spared.
    if (isQueueDispatchRunStart(line) && typeof line.task_id === "string") ids.add(line.task_id);
  }
  return [...ids];
}

/** Every `run.start` line's own `ts`, oldest first — the SAME task-id-agnostic scan {@link
 *  distinctDispatchedTaskIds} already makes over the identical step, kept rather than discarded
 *  (W1-T450's rationale: "it collects ids and DISCARDS the timestamps"). A line with no `ts`, or
 *  one that doesn't parse, is skipped rather than counted — an unreadable row must not corrupt a
 *  derived cadence. */
function dispatchRunStarts(lines: Array<Record<string, unknown>>): Array<{ ts: string; parsed: number }> {
  const out: Array<{ ts: string; parsed: number }> = [];
  for (const line of lines) {
    // W1-T2383 rank 3: QUEUE dispatches only — this cadence's own doc calls the bound "the
    // longest observed gap between DISPATCHES", and a lane run is not one.
    if (!isQueueDispatchRunStart(line)) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts !== undefined ? Date.parse(ts) : NaN;
    if (ts !== undefined && Number.isFinite(parsed)) out.push({ ts, parsed });
  }
  out.sort((a, b) => a.parsed - b.parsed);
  return out;
}

/** How much this module multiplies the longest OBSERVED inter-dispatch gap by to get the
 *  QUEUE-HEAD staleness bound (design (iii)) — mirrors this file's own precedent for the
 *  identical shape of problem: {@link SUPERVISOR_TICK_OVERDUE_MS} multiplies its installed
 *  interval by the same factor so one or two slow ticks don't false-positive. A fleet
 *  legitimately goes quiet during one long single run; 3x the worst gap this host has ever
 *  actually produced survives that without being talked into a round wall-clock guess. */
const QUEUE_HEAD_STALL_MULTIPLIER = 3;

interface DispatchCadence {
  /** The newest `run.start` seen, when any was — present even with only one ever recorded. */
  newestTs?: string;
  /** Present only once at least TWO dispatches have been observed and they didn't all land at
   *  the same instant — with fewer, there is no gap to learn a cadence from at all. */
  boundMs?: number;
  boundDerivation?: string;
}

/** Derives the QUEUE-HEAD staleness bound from THIS HOST'S OWN observed `run.start` history —
 *  never a hardcoded constant (design (iii); the whole risk this task names). Silent by
 *  construction on too little evidence: zero or one dispatch ever, or every dispatch landing at
 *  the identical instant, both leave `boundMs`/`boundDerivation` undefined rather than fabricate
 *  a number (design (iv), "unknown is not stalled"). */
/** W1-T1047: EXPORTED so `rmd doctor` can reuse this host's own observed cadence as the stall
 *  bound instead of reimplementing it against a guessed round figure. Behaviour unchanged. */
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

/** W1-T2335: skips a task `isDispatchEligible` (drain.ts) has ALREADY refused two guards before
 *  it ever reaches the breaker check — plan-declared `status: "blocked"` (:527, whether or not
 *  it carries W1-T1287's `retirement:`) and a task the batched projection already credits
 *  MERGED (:504), copying the identical skip {@link deriveIndeterminateBlockers} performs on
 *  the very next lines rather than inventing a second one. Neither `plan` nor `projections` is
 *  read to CHANGE any dispatch decision — `dispatchesWithoutNewOwnedPr`/`isDispatchBreakerTripped`
 *  stay untouched, so the row RETURNS byte-identical the moment the task's status returns to a
 *  dispatchable one. With no plan/no projections in hand (an unreadable plan or an unreachable
 *  GitHub gateway) this renders exactly as it does today — degrading toward today, never toward
 *  silence (design (iv)): the renderer cannot know a task is withdrawn without a plan to ask. */
// W1-T2383 rank 3: EXPORTED so the guard above (`isQueueDispatchRunStart` inside
// `distinctDispatchedTaskIds`) is provable against this fold's REAL output rather than asserted
// from source text — the same reason W1-T1047 exported `deriveDispatchCadence`. Behaviour
// unchanged; nothing outside a test calls it.
/** W1-T2415: ONE wording for the breaker's own reset condition, shared by the BLOCKERS class and
 *  the QUEUE HEAD refusal row. Extracted rather than copied — two surfaces describing one
 *  breaker in two sentences is how they drift. */
function circuitBreakerResetNote(taskId: string, dispatchCount: number): string {
  return `resets only on a fresh owned PR for ${taskId} — ${dispatchCount}/${DEFAULT_MAX_TASK_DISPATCHES} dispatches since the last one`;
}

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

/** The newest `dispatch.indeterminate {task}` ledger line per task id — a PURE ledger read
 *  (never gated on GitHub reachability). Skips a task the batched projection (when reachable)
 *  already confirms MERGED — landed work is no longer news, no matter what an older ledger
 *  line says. `ghWindowNote` is ENRICHED with the classified failure reason when that SAME
 *  projection confirms the task is STILL indeterminate right now; otherwise it names the
 *  ledger fact alone (never blank, never silently upgraded to "the task is broken"). */
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

/** sweep.ts's `runSweep` dispositions that mean "not progressing" — the SAME vocabulary
 *  sweep.ts already minted (W1-T186), never a second taxonomy. `"mergeable"`/`"post-review"`/
 *  `"dep-review"`/`"wait"` are ordinary in-progress states, not blockers. */
const BLOCKED_PR_DISPOSITIONS: ReadonlySet<string> = new Set(["blocked-fixable", "blocked-ambiguous", "conflicted", "stale"]);

/** The newest `sweep.disposed` line per PR number, filtered to the "not progressing"
 *  dispositions — a PURE ledger read with no live-state opinion at all (W1-T306's own
 *  design step (1): "establish where the list comes from before changing anything"). Every
 *  caller below either re-derives this against live GitHub state or, when that live read is
 *  itself unavailable, uses only this raw count to name what it is declining to print. */
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

/** `rawBlockedPrCandidates` RE-DERIVED against LIVE GitHub state (W1-T306 design (2): "a PR
 *  that is merged or closed is NOT a blocker … whatever the ledger still says about it; merge
 *  state is the authority") — via a DIRECT `github.prByRef(row.prNumber)` lookup on EACH
 *  candidate's OWN PR number, never through a task's derived {@link StatusProjection}.
 *
 *  W1-T309: the prior implementation matched against the batched `projectPlan` projections
 *  keyed by TASK id, which carry only that task's LATEST `pr.opened` line (status.ts's
 *  `lastPrOpened`, "last one wins" — see `deriveStatus` rung (a)). A task dispatched more than
 *  once opens a NEW PR each time; once a later dispatch opens PR #B, the task's projection
 *  resolves against #B only, and an EARLIER PR #A that sweep once disposed "blocked" becomes
 *  permanently unreachable through that projection — #A is never the task's "own" result and
 *  never lands in any projection's `prNumber` either, so live confirmation that #A later merged
 *  or was closed (abandoned) had nowhere to register. Every W1-T306 test happened to give each
 *  disposed PR number as the SAME number the owning task's single projection resolved to (via
 *  its lone `pr:` field or lone `pr.opened` line) — a shape multi-dispatch production tasks
 *  don't share, which is exactly the seam those passing tests never exercised. Querying the
 *  candidate's PR number directly needs no plan/projection at all, matching this module's own
 *  documented claim that BLOCKERS is unaffected by a missing plan (see {@link
 *  StatusBoardDeps.plan}'s doc) — a claim the projection-keyed implementation did not honor.
 *  ONLY called once the caller has already confirmed `github` is live and reachable this cycle
 *  — see `deriveBlockers`'s unverified branch for the "cannot be read" case. */
function deriveBlockedPrBlockers(candidates: BlockedPrBlocker[], github: GitHub, limit: number): BlockedPrBlocker[] {
  const isSettled = (prNumber: number): boolean => {
    const pr = github.prByRef(prNumber);
    return pr !== null && (pr.state.toUpperCase() === "MERGED" || pr.state.toUpperCase() === "CLOSED");
  };
  return candidates.filter((row) => !isSettled(row.prNumber)).slice(0, limit);
}

/** Human-readable label per {@link RetirementReason} — the plan record's own enum value doubles
 *  as the identifier, but the board renders THIS prose alongside it so "naming the recorded
 *  reason" (W1-T1287 acceptance 4) reads as an actual sentence, not a bare enum token. */
const RETIREMENT_REASON_LABELS: Record<RetirementReason, string> = {
  retired: "retired by operator ruling",
  closed: "closed unbuilt — resolved without being built",
  withdrawn: "withdrawn by the operator",
};

/** Plan-declared `status: "blocked"` tasks carrying a `retirement` ruling (W1-T1287) — a PURE
 *  plan read, no ledger/GitHub involved (mirrors `deriveQueueHead`'s own plan-only sections).
 *  Every other `blocked` task (no `retirement`) contributes no row here, unchanged from before
 *  this field existed — Q3(ix) of the task record pins that in both directions. */
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
    // W1-T309: gated on `github` alone, never on `projections`/`plan` — a missing/unreadable
    // plan must not withhold this class when GitHub itself is perfectly reachable (see
    // `deriveBlockedPrBlockers`'s own doc: this class needs no plan at all).
    if (github && !github.readFailed?.()) {
      // Live GitHub state IS reachable this cycle: re-derive against it, exactly as design (2).
      blockedPrs = deriveBlockedPrBlockers(raw, github, limit);
    } else {
      // W1-T306 design (4), DEGRADE HONESTLY: merge state cannot be read this cycle (no
      // gateway, or the gateway itself failed) — printing the raw ledger dispositions here
      // would be replaying HISTORY as CURRENT, exactly the failure this task exists to retire.
      // Withhold the class and say so, rather than silently falling back to the stale ledger read.
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

/** One dispatch away from the streak breaker's own threshold — "at or near" per the design's
 *  own wording, so a perpetual-attempt task is flagged BEFORE it trips and forces an
 *  escalation, not only after. */
const PERPETUAL_ATTEMPT_THRESHOLD = DEFAULT_MAX_TASK_DISPATCHES - 1;

/** W1-T1047: EXPORTED so `rmd doctor` can call it with a LOCALLY-derived merged set instead of
 *  the GitHub projections. The `!projections || ghUnknownReason` bail below is exactly why a
 *  network outage blanks the stall check in `rmd status`; doctor supplies local projections so the
 *  same code answers without a network read. Behaviour unchanged for existing callers. */
export function deriveQueueHead(
  plan: Plan | undefined,
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  ghUnknownReason: string | undefined,
  limit: number,
  nowMs: number,
  // W1-T1205: OPTIONAL and TRAILING, so every existing caller (doctorCommand's own
  // `deriveQueueHead` call, which deliberately stays network-free — see that command's header)
  // keeps compiling and keeps its byte-identical no-exclusion behaviour without passing this.
  // `buildStatusBoard` (below) is the one caller that supplies a real reader.
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
  // W1-T1205 (design (i)): binds the SAME `hasPushedRunBranch` predicate the real dispatcher
  // applies (drain.ts's `isDispatchEligible`), so this selector's eligible set can never again
  // drift wider than the dispatcher's own — the exact defect this task exists to close. `refused`
  // collects the named exclusion (design (ii): show both, label them) rather than letting the
  // task simply vanish from the candidate list with no trace here. `onFiltered` fires for every
  // matching task in the WHOLE plan (runnableCandidates walks it in full, unbounded by `limit` —
  // see that function's own doc), so this is capped exactly like `tallyDispatchFilters`'s own
  // buckets are, counting what it drops rather than growing without bound.
  const refused: QueueHeadRefusedRow[] = [];
  let refusedTotal = 0;
  // ONE cap and ONE counter for every reason that reaches this list, so W1-T1205's
  // `IDLE_REASON_ID_CAP` bound and its `refusedTruncated` count keep meaning what they meant
  // when only one reason could reach it.
  const pushRefused = (row: QueueHeadRefusedRow): void => {
    refusedTotal++;
    if (refused.length < IDLE_REASON_ID_CAP) refused.push(row);
  };
  const candidates = runnableCandidates(plan, isMerged, limit, {
    isIndeterminate,
    isCircuitTripped,
    hasPushedRunBranch,
    // W1-T2415: THE CALLBACK THIS FUNCTION ALREADY HAD AVAILABLE AND NEVER SUPPLIED. The
    // `isCircuitTripped` predicate above has always removed a tripped task from `rows`
    // (`isDispatchEligible` calls this hook and returns false — the task is
    // `isDispatchEligible === false` and never sorts), but with no `onCircuitBreak` passed, the
    // one surface built to EXPLAIN a refusal could not name it: it simply vanished, while the
    // sibling exclusion from this very same call got a `refused` row. Observation only — it
    // never gates, so the eligible set is byte-identical with or without it. Matches
    // `runDaemon`'s own `circuitBrokenThisTick` collection (daemon.ts), which exists for exactly
    // this reason: the `DispatchFilterReason` tally cannot express the breaker.
    onCircuitBreak: (task) => {
      const dispatchCount = dispatchesWithoutNewOwnedPr(lines, task.id);
      pushRefused({
        taskId: task.id,
        title: task.title,
        reason: "circuit-broken",
        dispatchCount,
        maxDispatches: DEFAULT_MAX_TASK_DISPATCHES,
        // The SAME wording `deriveCircuitBrokenBlockers` renders, so the two surfaces cannot
        // drift into two descriptions of one breaker.
        resetNote: circuitBreakerResetNote(task.id, dispatchCount),
      });
    },
    onFiltered: (task, reason) => {
      // Scoped to this one reason — see `QueueHeadSection.refused`'s own doc for why the other
      // `DispatchFilterReason`s are deliberately not duplicated onto this surface.
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
  // W1-T450: candidates present AND no run.start newer than the observed-cadence bound ⇒ a
  // stall — never computed at all when `rows` is empty, so the honest "nothing dispatchable"
  // idle state (design (i)) can never grow a stall it doesn't deserve.
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
    // W1-T450: eligible work sitting with ZERO dispatches for longer than this host's own
    // observed cadence licenses — the "a daemon failing every pass looks calm" falsifier.
    // NOT A GATE (design (ii)): this rule only ever picks a line to print; nothing here blocks
    // or refuses a dispatch.
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
    // W1-T1205 (rationale (4)): PERMANENT, not transient — GitHub deletes a PR's head branch on
    // MERGE but not on CLOSE, so a run branch left standing after an unmerged-close never clears
    // on its own. Named here so an operator sees it without grepping `dispatch.skipped` rows.
    // W1-T2415: SCOPED to its own reason. It used to fire on ANY refused row and hand out
    // run-branch advice, so a breaker refusal would have been given the wrong remedy.
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
    // W1-T2415: LAST, so it never displaces a rule above it — the breaker is a standing state an
    // operator can read at leisure, unlike a stall or a perpetual re-dispatch that is burning
    // spend right now. Names the reset condition rather than a remedy, because there is no
    // action to take beyond landing a PR for the task: nothing here resets a breaker.
    applies: (ctx) => ctx.refused.some((r) => r.reason === "circuit-broken"),
    action: (ctx) => {
      const broken = ctx.refused.filter((r) => r.reason === "circuit-broken");
      const r = broken[0]!;
      const more = broken.length > 1 ? ` (+${broken.length - 1} more)` : "";
      return `${r.taskId}${more} is refused by the dispatch circuit breaker — ${r.resetNote ?? "it resets only on a fresh owned PR"}`;
    },
  },
];

/** EXPORTED for test only (as {@link renderQueueHeadBlock} already is). W1-T2637: lets a test prove both rules above stay reason-scoped for a `refused` reason the derivation cannot produce today (the guard at :1935 is unchanged). */ export function pickQueueHeadNextAction(section: QueueHeadSection): string | undefined { return pickNextAction(QUEUE_HEAD_NEXT_ACTIONS, section); }

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
  // W1-T510: `projections` carries one entry per `plan.tasks` (projectPlan's own loop,
  // lib/status.ts) — the SAME `plan` passed in here — so an id genuinely absent from it is
  // also necessarily absent from `plan.byId`, which already fails via `unmetDependencies`'s
  // `!d` branch before `isMerged`/`depsUnobservable` are ever consulted; `=== true` below is
  // never an absent-as-unmerged conflation on a real dependency id. Mirrors `deriveQueueHead`'s
  // own `isMerged`/`isIndeterminate` pair (immediately above in this file) — the dispatch path's
  // template this readiness path now follows.
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

/**
 * The newest `daemon.headroom.degraded` line — the blind-governor signal. Same max-by-parsed-`ts`
 * shape as {@link deriveHeadroomLatest} immediately above, deliberately: an exact `Set.has` on the
 * step name (a dotted CHILD, never matched by its parent) and a comparison on PARSED timestamps,
 * never on ledger order.
 */
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

/**
 * W1-T931: this board's own read of `cost.anomaly` ledger rows — never a re-derivation of the
 * detector's own math (that lives entirely in `src/lib/cost-anomaly.ts`; this module only
 * RENDERS the vocabulary `sweep.ts` already ledgered, per this file's own header doctrine).
 *
 * DEDUPED BY `run_id`, LAST ONE WINS. `recordCostAnomalies`'s own idempotency (one row per run
 * id, proven at the unit level) assumes a single, sequential reader of a single ledger snapshot;
 * `runSweepLightPass` fans `runSweep` out across every open PR CONCURRENTLY (W1-T463), each with
 * its OWN ledger read, so two overlapping calls in the same tick can each observe the ledger
 * before the other's write lands and both append a `cost.anomaly` row for the same run. That is
 * a cosmetic duplicate-WRITE risk this board does not attempt to close (no new cross-call lock —
 * out of this task's scope), but a duplicate-READ risk this render trivially can: collapsing to
 * one row per run id here means an operator never sees the SAME run named twice in NEEDS ME
 * regardless of how many `cost.anomaly` lines it actually accumulated.
 */
const AUTOMERGE_HOLD_ENGAGED_STEP = "automerge.hold_engaged";
const AUTOMERGE_HOLD_RELEASED_STEP = "automerge.hold_released";

/** No real GitHub PR is ever numbered this — used ONLY to ask {@link automergeHoldFromLedger}
 *  "is a FLEET-scoped hold (no `pr_number`) currently standing", since a PR-scoped row can never
 *  match a PR number that does not exist. See {@link deriveMergeHeld}'s own doc. */
const MERGE_HELD_FLEET_SENTINEL_PR = -1;

/**
 * W1-T1000003: the newest `automerge.hold_engaged` row's own `task_id`, scoped exactly like
 * {@link automergeHoldFromLedger} itself (a fleet-scoped row carries no `pr_number` and applies
 * to every PR; a PR-scoped row applies only to its own). ENRICHMENT ONLY — this never decides
 * whether the hold still stands; that decision is `automergeHoldFromLedger`'s alone, called
 * unchanged in {@link deriveMergeHeld} just below.
 */
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

/**
 * W1-T1000003 — THE HOLD ROW(S) THIS BOARD RENDERS, KEYED ON review.ts's
 * {@link automergeHoldFromLedger} ALONE — never a second taxonomy re-derived from check or
 * review fields (design fence (ii) of the task record: "the board mints no blocker taxonomy of
 * its own", applied here to the escalation surface too). One row per PR number a hold row ever
 * named, present ONLY while `automergeHoldFromLedger` still reports that PR held; a released
 * hold clears on the very next call (design (iv) — no marker, no acknowledgement to keep in
 * sync). A hold engaged with NO `pr_number` at all (fleet-wide) and no PR-scoped row ever
 * recorded renders as exactly one row naming no PR — "every open request", not one.
 */
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
    // No PR-scoped hold row was ever recorded, so the ONLY way a currently-standing hold could
    // exist is fleet-scoped — a real PR number always accompanies a PR-scoped row, so a sentinel
    // that no PR is ever numbered can only ever match a fleet-wide row (see AutomergeHold's own
    // "scopedToThisPr" test: `typeof line.pr_number !== "number"`).
    const fleetHold = automergeHoldFromLedger(lines, MERGE_HELD_FLEET_SENTINEL_PR);
    if (fleetHold) rows.push({ by: fleetHold.by, reason: fleetHold.reason });
  }
  return rows;
}

function deriveNeedsMe(
  lines: ReadonlyArray<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
): NeedsMeSection {
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

  // W1-T1021: the NEWEST `daemon.image_drift` line, same "latest wins" read `isNewer` already
  // gives `deriveHeadroomDegraded` above — a drift finding is a point-in-time comparison against
  // the checkout's own current history, so an older row never outranks a fresher one.
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

  // THE STANDING APP-TOKEN FALLBACK. Two "latest wins" scans over the SAME `lines` already in
  // hand, compared against each other: the fallback stands iff the newest failure is newer than
  // the newest success. `isNewer`'s own contract does the never-succeeded case for free — an
  // absent success makes any dated failure newer — which is exactly the boot-on-fallback shape.
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

  // W1-T1000003: currently-standing operator merge holds — a pure re-read of the SAME hold
  // reader sweep.ts/run-task.ts already consult, never a second gateway or ledger pass (this
  // module already has `lines` in hand from the read `deriveNeedsMe`'s caller performed once).
  const mergeHeld = deriveMergeHeld(lines);

  // W1-T2392: READ, never re-derive. `deriveStatus` already decided this per task and put it on the
  // projection; this walks the SAME map the queue/blocker sections above were handed, so no second
  // plan pass and no second `changedFiles` call. Sorted by task id so the block is stable between
  // renders rather than following Map insertion order.
  const uncreditedBuilds: UncreditedBuildRow[] = [];
  for (const [taskId, p] of projections ?? []) {
    const w = p.uncreditedBuild;
    if (!w) continue;
    uncreditedBuilds.push({ taskId, prNumber: w.prNumber, prUrl: w.prUrl, namedIn: w.namedIn });
  }
  uncreditedBuilds.sort((a, b) => a.taskId.localeCompare(b.taskId));

  return { costAnomaly, imageDrift, mergeHeld, uncreditedBuilds, ...(tokenFallback ? { tokenFallback } : {}) };
}

/**
 * Is `a` strictly newer than `b`, by PARSED timestamp? An absent or unparseable `b` (no successful
 * read has EVER been recorded) makes `a` newer — that is the parked-since-boot case, the whole
 * point. An absent or unparseable `a` is never newer: an undatable blindness report cannot
 * outrank a dated healthy one.
 */
function isNewer(a: string | undefined, b: string | undefined): boolean {
  const pa = a ? Date.parse(a) : NaN;
  if (!Number.isFinite(pa)) return false;
  const pb = b ? Date.parse(b) : NaN;
  return !Number.isFinite(pb) || pa > pb;
}

/** `consecutive_unreadable` × `poll_interval_ms`, rendered — how long the governor has been blind.
 *  Omitted entirely when either field is absent: a duration guessed from one of the two would be
 *  a fabricated number on the one surface an operator consults about a stalled fleet. */
function blindForClause(d: HeadroomDegraded): string {
  if (typeof d.consecutiveUnreadable !== "number" || typeof d.pollIntervalMs !== "number") return "";
  const mins = Math.round((d.consecutiveUnreadable * d.pollIntervalMs) / 60_000);
  return ` — blind for about ${mins}m (${d.consecutiveUnreadable} consecutive unreadable probes)`;
}

const HEADROOM_NEXT_ACTIONS: readonly NextActionRule<HeadroomSection>[] = [
  // ABOVE `!ctx.found`, and that ORDER IS THE FIX. A parked daemon produces no `daemon.headroom`
  // row ever, so it lands in `!found` alongside a daemon that simply has not ticked yet — and the
  // rung below reported the reassuring one for both. This rung claims the case it can actually
  // prove: a `daemon.headroom.degraded` line means ticks HAVE happened and the governor is blind
  // and not dispatching. It is deliberately not gated on `ctx.found`: a park that begins after a
  // healthy period leaves a stale `daemon.headroom` row behind, and the blindness still outranks it.
  {
    // ONLY WHEN THE BLINDNESS IS THE LATEST WORD. A successful probe resets the daemon's
    // `consecutiveUnreadable` and resumes dispatch, but the 30-minute render window means the old
    // `daemon.headroom.degraded` line is often still present — so firing on its mere presence would
    // report a RECOVERED governor as blind. Four bounds in this repo have already fired on healthy
    // conditions; this compares parsed timestamps so a later `daemon.headroom` row wins.
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
  // W1: THE BOARD MUST READ ROTATIONS, NOT ONE FILE. `readLedgerLines` opens exactly one path, and
  // `rotateLedger` sheds a step COMPLETELY when it is in no retention set — MEASURED, `daemon.summary`
  // had 0 live rows against 524 in rotations, which is why LAST CLOSED CYCLE rendered
  // `no cycle recorded` on a host with 524 recorded cycles.
  //
  // THE PREDICATE NAMES ONLY THE STEPS THAT ARE ACTUALLY SHED. Six of the board's steps are present
  // in the live file, so they need no rotation at all; these three are the measured blind set, and
  // every rung reading them takes the NEWEST row rather than a count, so stopping early is exact
  // rather than approximate.
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
    // W1-T2450: `sensed` defaults to `true` when the caller doesn't report it — the old,
    // sensor-implicit behaviour — so every test/deps bundle that predates this field keeps
    // reading exactly as it always has.
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

  // "the sha the LIVE process booted at" presupposes a live process — a daemon that is not
  // currently running has no running HEAD to compare, no matter what its last recorded boot
  // said (that boot could be hours stale itself). Gated on `running`, not merely "has a
  // daemon.boot line ever", so this never reports fresh/stale for a daemon that isn't up.
  const daemonRow = services.find((s) => s.service === "daemon")!;
  // HOISTED out of the `running` branch below (one resolution, two consumers): LATCHES needs
  // origin/main to judge whether a DEPLOY_FAILED alert has been overtaken, and that question is
  // independent of whether a daemon happens to be up. Resolving it twice would be two git calls
  // for one fact; resolving it only when the daemon runs would leave the latch unjudgeable on a
  // stopped fleet, which is exactly when an operator reads `rmd status`.
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

  // W1-T2446: HOISTED from the "W1-T280 (DERIVED half)" block below — LATCHES now needs the
  // same merge-credit projection INBOX/QUEUE HEAD/BLOCKERS already build, to correct the held
  // dispatch-claim row's text (see `buildLatchRows`'s own doc). `projectPlanOnce` depends only
  // on `deps`/`ledgerPath`/`lines`/`now`, every one of which is already in scope this early —
  // moving its ONE batched GitHub read up costs nothing and is spent exactly once either way.
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
  // W1-T279 follow-up: has the daemon done anything SINCE this cycle closed? If so the cycle is
  // history, and telling the operator to investigate it competes with the live blockers below.
  lastCycle.supersededByTs = newestDaemonActivityAfter(lines, lastCycle.ts);
  const supersededParsed = lastCycle.supersededByTs ? Date.parse(lastCycle.supersededByTs) : NaN;
  lastCycle.supersededAgeMs = Number.isFinite(supersededParsed) ? Math.max(0, nowMs - supersededParsed) : undefined;
  lastCycle.nextAction = pickNextAction(LAST_CYCLE_NEXT_ACTIONS, lastCycle);

  // ── W1-T280 (DERIVED half) ── `plan`/`projections`/`ghUnknownReason` are now hoisted above,
  // ahead of LATCHES (W1-T2446) — this section reuses them, never re-derives them.
  const queueHeadLimit = deps.queueHeadLimit ?? 5;

  const blockers = deriveBlockers(plan, lines, projections, deps.github, queueHeadLimit);
  // W1-T1205: the SAME `hasPushedRunBranch` predicate the real dispatcher binds
  // (drain.ts/daemon.ts's own `readPushedRunBranches` + `runBranchTaskIds` pairing), read here
  // rather than shared with either — this is its own, unbatched call site (see
  // `StatusBoardDeps.readPushedRunBranches`'s own doc for why). ONE sweep per render, never one
  // per candidate.
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

  // ── W1-T940: LEARNINGS INJECTION — same `lines` window every other section above already
  // read, one extra traversal (digest.ts's aggregateLearningsInjection), no second ledger
  // read. ──────────────────────────────────────────────────────────────────────────────────
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

/** The width every one of the ten section rules below was already hand-typed at (measured,
 *  not assumed — see the task rationale's SURFACE 2 correction: all ten, one true width, never
 *  ten different ones). Pinned here rather than wired to `terminalWidth()` so this render stays
 *  exactly what it is today regardless of the real terminal's column count — a live-width
 *  divider is future work this task deliberately leaves alone (NOT IN SCOPE: no change to what
 *  the board SAYS, and byte-identical-when-off is the load-bearing constraint this pin keeps
 *  true even when colour IS on, since `sectionRule` itself never paints). */
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

/** Render one row's {@link LivenessState} — the THREE-way text the binary `running (pid …)` /
 *  `not running` render used to collapse an interval service's healthy idle-between-ticks rest
 *  and a genuinely dead one into the same "not running" line (the bug W1-T301 exists to fix).
 *  Resident services (`"daemon"`/`"serve"`) only ever hit the first two branches, unchanged
 *  from the prior render. */
/** `enabled` defaults to `false` (colour off) — see {@link renderLivenessBlock}'s own default
 *  for why: every EXISTING single-argument caller/test must keep getting today's plain text,
 *  unconditionally, never dependent on this process's own env/TTY at the moment it happens to
 *  run. Only `renderStatusBoardText` ever passes `true`. */
function renderLivenessState(s: ServiceLivenessRow, enabled = false): string {
  switch (livenessState(s)) {
    case "running":
      return paint.ok(`running (pid ${s.pid ?? "unknown"})`, enabled);
    case "stopped":
      return paint.bad("not running", enabled);
    case "unknown":
      // W1-T2450: names WHICH absence this is — "no sensor" here, vs the interval branch's own
      // "no tick observed yet" below, which only ever fires once a sensor DID answer.
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

/** `enabled` (colour on/off) defaults to `false` so every pre-existing test that calls this
 *  with one argument keeps getting exactly today's bytes — only `renderStatusBoardText` passes
 *  the real, env-derived flag. Colour here is the SAME "crash loop / starved queue / healthy
 *  idle" distinction the task exists to add: `paint` only ever WRAPS a word this function
 *  already printed, never replaces it (byte-identical-when-off is asserted directly). */
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
  // "LAST CLOSED CYCLE", not "LAST CYCLE": a cycle is only written when the loop STOPS, so this
  // row is always an ending and never the current state. The old header implied currency it
  // never had — observed pinned to a stopped cycle for ten hours while the daemon dispatched
  // and completed four tasks.
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

/** W1-T2637: a label table, exhaustive BY CONSTRUCTION — one wording per {@link QueueHeadRefusedRow.reason} member, keyed as a `Record` so the type-checker names any arm left without a sentence. Replaces the two-way ternary W1-T2415 already had to repair once; `deriveQueueHead`'s guard is unchanged, so only run-branch/breaker reach this table today, both byte-identical to before. */ const QUEUE_HEAD_REFUSAL_WORDING: Record<QueueHeadRefusedRow["reason"], (r: QueueHeadRefusedRow) => string> = {
  "circuit-broken": (r) => `dispatch circuit breaker tripped — ${r.resetNote ?? `${r.dispatchCount}/${r.maxDispatches} dispatches with no new owned PR`}`,
  "run-branch-already-pushed": () => "run branch already pushed to origin", "already-merged": () => "already merged", "verify-not-auto": () => "verify is not auto",
  blocked: () => "blocked", retired: () => "retired", "unmet-deps": () => "dependencies not yet met", "continued-this-pass": () => "continued this pass" };

/** EXPORTED for test only — the same visibility `deriveCircuitBrokenBlockers` already carries,
 *  so a test can assert what an operator actually READS rather than only the section object.
 *  Behaviour unchanged for every existing (single-argument) caller: `enabled` defaults to
 *  `false`, so colour is opt-in and only `renderStatusBoardText` ever passes `true` — see
 *  {@link renderLivenessBlock}'s own note. STALL/REFUSED are this task's "starved queue"
 *  example named verbatim in its own title. */
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
    // W1-T1205 (design (ii)): what dispatch is REFUSING, named — never silently absent from a list that only ever showed what it would take.
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

/** Render one {@link CacheHitTotals} grain map (`byRun`/`byClass`) as one line, e.g.
 *  `by run  : R1=83.3% (coverage 100%), R2=UNKNOWN (coverage 0%)` — sorted by key, deterministic.
 *  Formats via digest.ts's {@link formatCacheHitFigure} — the ONE formatting rule, shared rather
 *  than re-spelled here (design note (i)). */
function renderCacheHitGrains(grains: Record<string, CacheHitGrain>): string {
  return Object.keys(grains)
    .sort()
    .map((key) => `${key}=${formatCacheHitFigure(grains[key])}`)
    .join(", ");
}

/** Sum every {@link CacheHitGrain} in `byClass` into one board-wide total — `byClass` already
 *  partitions every call line in the window exactly once (including the "unknown" bucket), so
 *  summing it (rather than `byRun`) can never double-count a line. */
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
  // ONE board-wide figure, off the SAME `cacheHitRatio` arithmetic digest.ts exports (design
  // note (i), "ONE DERIVATION, TWO RENDERERS") — called directly here, not via a pre-rendered
  // string, so this total is provably the SAME formula as the digest's, applied to this board's
  // own combined-across-classes total rather than a second opinion of it.
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

/**
 * W1-T940 — the drop-pressure lines: `matched`/`dropped`/`rows` totals, every distinct
 * `budget_chars` value seen (design note (i): NOT averaged into one number, so a mid-window
 * constant change stays visible), and any `global_refused_reason` strings NAMED VERBATIM on
 * their own line, deduped with a count — never folded into `dropped` (design note (iii): a
 * refusal is a layer contributing ZERO entries, a drop is a ranked entry losing a tie). `found:
 * false` renders explicit absence rather than a fabricated `dropped: 0` (design note (iv)).
 *
 * W1-T1251 — `loadGlobalArtifact` (learnings.ts) returns SEVEN distinct failure reasons, of
 * which exactly ONE ("global artifact not found") is the ruled-on §6-DEFERRED-TRANSPORT state —
 * a designed, non-fatal absence nothing has provisioned yet — and six are REAL problems with an
 * artifact that DOES exist, including the hash-mismatch tamper signal. Printing every one of
 * them behind the single word `refused:` reports an expected absence and a hand-edited artifact
 * in the same vocabulary. `classifyGlobalArtifactRefusal` (learnings.ts, the ONE producer of
 * this discriminant) splits `globalRefusedReasons`' keys into the two lines below — the reason
 * TEXT itself is unchanged/verbatim either way, only which line it renders on differs, so this
 * reads apart from a genuine refusal without touching run-task.ts's per-row logging at all (no
 * new ledger field, no new I/O — see the task record's design note (iv)/(iii)). A tampered or
 * malformed artifact keeps the word `refused` and stays on the FIRST, prominent line exactly as
 * before; the designed absence moves to its own line, named as what it is.
 */
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

/** W1-T931 — one line per un-dismissed `cost.anomaly` row, naming the run, its class, its cost,
 *  and the median it exceeded (this task's own acceptance criterion, verbatim). W1-T1021 adds a
 *  second, independent row for an image-drift finding, naming both shas a human needs to judge
 *  it. `nothing needs you` only when NEITHER has anything to report, matching this module's
 *  "no rule matches, no line" doctrine elsewhere. */
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
  // W1-T2392: names the task, the PR and WHICH prose surface carried the id — a reader told only
  // "uncredited" has to go find the PR, and one told "title" for a body-named build looks in the
  // wrong half of it. Says what to do, because a warning nobody can act on is noise.
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

/** The text projection of {@link StatusBoardModel} — every field it prints comes off the model
 *  passed in, never a fresh read, so `--json` and the default text output can never disagree
 *  (they are the SAME derivation, rendered twice); this function is the ONLY thing this task
 *  changes about that projection, and the JSON path (`statusCommand`'s `--json`, a bare
 *  `JSON.stringify` of the same model) never calls it, so the JSON projection is untouched by
 *  anything below.
 *
 *  `opts.colourEnabled` defaults to {@link colourEnabled}'s real `process.env`/`process.stdout`
 *  read — the ONE call site in this module that reads either — so a real terminal run picks up
 *  `NO_COLOR`/`FORCE_COLOR`/its own TTY-ness automatically, while a test (or any other caller)
 *  can pin the flag explicitly instead of mutating global state. With colour disabled (the
 *  default in this suite's own non-TTY `node --test` processes, and always when forced) the
 *  output is BYTE-IDENTICAL to what this function rendered before this task — every `paint`
 *  call returns its input unchanged, and `sectionRule` never emits colour at all. */
// ── OPERATOR MESSAGE STANDARD — the board's presence projection (W1-T2806) ──────────────────
//
// docs/operator-message-standard.md is NORMATIVE and names `renderStatusBoardText` as its FIRST
// surface, on the reasoning that the board already carries a next-action slot. It did; nothing
// read it through the standard's own checker. `escalate.ts` was the only module that ever called
// {@link checkOperatorMessage}, so the surface an operator reads first was the surface the
// presence check never saw.
//
// WHAT THIS IS NOT. It is not a readability score, a length bound or a vocabulary rule — the
// standard forbids any of those being added in its name, because this repo cannot compute reader
// comprehension honestly. It checks PRESENCE of four slots and nothing else. It also does not
// certify that any board message is TRUE: the standard's own opening records a `NextActionRule`
// whose action slot is filled and whose sentence is false anyway.
//
// AND IT NEVER WITHHOLDS. `operator-message.ts` states the fallback is the hazard and fails toward
// DELIVERY. No row is hidden, reordered or truncated because its projection is incomplete; the
// board renders in full and one footer line records what was missing.

/** A board section as the presence check sees it: its label, and the slots it fills. */
export interface BoardSectionMessage {
  label: string;
  message: OperatorMessage;
}

/**
 * Project one rendered section onto the four presence slots, reading only what the board ALREADY
 * carries — the same discipline `toOperatorMessage` (escalate.ts) follows, so no section producer
 * is forced to change what it passes.
 *
 *  - `speaker` is the section label, always known.
 *  - `whatHappened` is the block's own rendered body (its lines after the section rule), which is
 *    where a section states its observed condition. Absent when the block rendered nothing.
 *  - `whatIsAsked` is `nextAction`, left UNDEFINED rather than nulled when no rule applied:
 *    `pickNextAction` returns `undefined` both when a section is healthy and when its table has a
 *    gap, and the standard's part (iv) is precisely about not reporting those as the same fact.
 *  - `consequenceOfInaction` has no board slot today, so it is absent by construction. That is the
 *    gap this projection exists to make visible rather than silently accept.
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

/**
 * {@link checkOperatorMessage}, best-effort — mirrors `escalate.ts`'s own safe wrapper. A checker
 * failure must never reach the operator as a broken board, so this returns `undefined` rather than
 * a fabricated verdict and the caller omits the section from the footer instead of guessing.
 */
function checkBoardSectionSafe(message: OperatorMessage): OperatorMessageCheckResult | undefined {
  try {
    return checkOperatorMessage(message);
  } catch {
    // Best-effort, and deliberately UNDEFINED rather than a synthesised "incomplete": a section the
    // checker could not read has not been observed to be missing anything, and reporting the two as
    // the same fact is exactly what part (iv) of the standard forbids. The section drops out of the
    // footer; the board itself still renders in full.
    return undefined;
  }
}

/**
 * ONE board-level footer naming which sections are structurally incomplete, or `undefined` when
 * every section conforms. Deliberately one line for the whole board rather than one per section:
 * the board is read at a glance, and today no section fills `consequenceOfInaction`, so a
 * per-section annotation would append a line to every block on every render for a fact that is
 * constant across them.
 */
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

/** `nextAction` off a section that may or may not declare one — the board's sections are separate
 *  interfaces and only some carry the slot. */
function sectionNextAction(section: unknown): string | undefined {
  if (section === null || typeof section !== "object") return undefined;
  const value = (section as { nextAction?: unknown }).nextAction;
  return typeof value === "string" ? value : undefined;
}

export function renderStatusBoardText(model: StatusBoardModel, opts: { colourEnabled?: boolean } = {}): string {
  const enabled = opts.colourEnabled ?? colourEnabled();
  // Each block is rendered into its own array so the presence projection can read what the reader
  // actually sees. The join below reproduces the previous concatenation line for line: the same
  // blocks in the same order, one blank line between each pair, none after the last.
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
  // The footer is the LAST thing appended and the only line this change can add. Every block above
  // is already in `lines` by the time it is computed, so a board is never withheld on a check.
  const footer = boardMessageFooter(
    blocks.map((block) => projectBoardSection(block.label, block.rendered, sectionNextAction(block.section))),
  );
  if (footer) lines.push("", footer);
  return lines.join("\n");
}
