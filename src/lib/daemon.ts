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
import type { MeasurementCadenceDecision, MeasurementCadenceRunResult } from "./measurement-cadence.js";
import { buildMeasurementCadenceRow } from "./measurement-cadence.js";
import type { BoardReviewCadenceDecision, BoardReviewReport } from "./board-review.js";
import type { DigestCadenceRunResult } from "./digest.js";
import type { RunResult } from "./run-result.js";
import { assertCleanBoot, type BootAssertion } from "./env.js";
import { classifyFailure } from "./classify.js";
import { INITIAL_RETRY_STATE, reasonAboutBlock, type RetryState } from "./block-reason.js";
import {
  nextRunnable,
  runnableCandidates,
  laneDispatchBudget,
  type MergedSet,
  type NextRunnableOpts,
  runBranchTaskIds,
  type OpenPrCheck,
  tallyDispatchFilters,
  type IdleReasonBucket,
  IDLE_REASON_ID_CAP,
} from "./drain.js";
// Why: drain.ts already owns the overlap partition, so it is reused rather than re-derived (W1-T343).
import {
  NO_OBSERVED_SCOPE,
  partitionByFileOverlap,
  serializedLedgerPayload,
  settledSetPayload,
  type ObservedScopeByTask,
} from "./dispatch-overlap.js";
import { DEPLOY_IDLE_DEFER_CEILING_MS } from "./deployer.js";
import { HEADROOM_LIMIT_PCT, RESET_UNKNOWN, UNREADABLE_DEGRADED_LIMIT } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
// Type-only, so no runtime edge is added to daemon-health.ts, which already imports a value from
// here; a value import would close a real cycle. This module never shells GitHub itself (W1-T372).
import type { GhRateLimitBuckets } from "./daemon-health.js";
import type { CostGovernorResult, QueueGovernorResult } from "./sweep.js";
// A value import, unlike the type-only line above. Safe: sweep.ts imports nothing from this
// module, so this edge closes no cycle (W1-T2744).
import { detachedSweepActionCount, drainDetachedSweepActions } from "./sweep.js";
// VALUE import (W1-T342's gate moved to its own pure module so drain.ts can share it — see that
// module's header for why neither daemon.ts nor sweep.ts could host it). Pure, no filesystem.
import { checkDispatchGovernors, type DispatchGovernorVerdict } from "./dispatch-governor.js";
import { assertRunnable, PlanError, type MergedResolver, type Plan, type Task } from "./plan.js";
import type { StatusProjection } from "./status.js";
// Type-only: retro.ts owns this shape, so the two hooks below never re-declare it (W1-T160).
import type { RetroTriggerDecision } from "./retro.js";
// Type-only, keeping this module free of a runtime dependency on worker-containment.ts.
import type { OrphanSweepReport } from "./worker-containment.js";
// Type-only — shapes the feedback-landing injection points below (W1-T530).
import type { LandFeedbackResult } from "./feedback-landing.js";
// Type-only — github-posture.ts owns this shape; the real read lives in run-task.ts (W1-T1040).
import type { GithubPostureFinding } from "./github-posture.js";

/** Reason the scheduler loop returned. Every terminal state is one of these. `headroom_exhausted` and `paused` are
 * deliberately absent: both are awaiting-states whose exit the supervisor would relaunch straight back into, so both
 * idle in process instead (W1-T197; 2026-07-22). `stale` has the opposite polarity — it is a request to exit, because
 * a supervisor restart is the only way a long-running daemon gets off the code it loaded at boot (W1-T126). */
export type DaemonStopReason = "stopped" | "blocked" | "max_reached" | "error" | "stale";

/** Default idle-poll pace: check back once a minute while nothing is runnable. The literal stays
 *  here because this module never touches the filesystem; `daemonCommand` threads the policy value
 *  on every real invocation, so this is provably dead for the operating path (W1-T253). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Default wall-clock bound on the full reconciliation pass, mirroring `plan/policy.yaml`'s
 *  `sweepWallClockBoundMs` row, which carries the healthy-versus-hung derivation. Same fs-free
 *  fallback reasoning as {@link DEFAULT_POLL_INTERVAL_MS} above (W1-T1044). */
export const DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS = 559_000;

/** Default minimum gap between two full passes started by the in-flight ticker's retrigger; it never
 *  throttles the once-per-iteration call. Why: without a retrigger, a boot whose phase held the loop
 *  for its measured mean of 38.5 minutes got one full pass for that whole span (W1-T1272). Trap:
 *  this interval is itself a route into a concurrent pass that the wall-clock bound does not cover,
 *  so {@link SweepLiveness} excludes the duplicate (W1-T2582). Forensics: docs/forensics/daemon.md. */
export const DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS = 20 * 60_000;

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

/** The pure stop-reason to exit-code mapping, extracted so it is unit-testable with no process spawn
 *  (operator ruling, 2026-07-21; Rule 18). Deliberate exits map to 0; every other reason is non-zero
 *  so a supervisor restarts. Trap: neither headroom exhaustion nor pause may reach this function —
 *  each would map to silence or to a relaunch storm (see {@link DaemonStopReason}). Why `stale` has
 *  its own code: docker counts every non-zero exit and cannot read the value, so routine restarts
 *  spent the crash budget and a 2h56m outage followed (W1-T490). Forensics: docs/forensics/daemon.md. */
export function daemonExitCode(stopReason: DaemonStopReason): number {
  if (stopReason === "stopped" || stopReason === "max_reached") return 0;
  if (stopReason === "stale") return DAEMON_EXIT_STALE;
  // `error` deliberately falls through to 1 below, so a genuine crash stays countable against
  // docker's on-failure budget exactly as it always was (W1-T2537).
  if (stopReason === "blocked") return DAEMON_EXIT_BLOCKED;
  return 1;
}

/** The exit code for a whole summary, which is what the real call site has and what
 *  {@link daemonExitCode} deliberately cannot see: the stop detail. A second function rather than a
 *  second parameter, because point-free callers would otherwise be handed an array index as a stop
 *  detail. Fail-closed: anything not positively transient stays `error` (W1-T2546). Forensics: docs/forensics/daemon.md. */
export function daemonExitCodeForSummary(summary: Pick<DaemonSummary, "stopReason" | "stopDetail">): number {
  if (summary.stopReason !== "error") return daemonExitCode(summary.stopReason);
  const detail = summary.stopDetail;
  if (detail !== undefined && classifyFailure({ text: detail }) === "transient") return DAEMON_EXIT_ENVIRONMENTAL;
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
   * exit condition parked the daemon up to 165 minutes (W1-T1044). */
  sweepWallClockBoundMs?: number;
  /** The minimum gap in ms between two retriggers fired while an in-flight ticker holds the loop.
   *  Distinct from the bound above, which limits how long any one pass may run; this limits how
   *  often a new one may start. Never consulted by the once-per-iteration call (W1-T1272). */
  sweepRetriggerIntervalMs?: number;
}

/** The result of comparing this process's own boot sha against origin/main (W1-T126). `stale` carries the sha pair, so
 * the caller and the ledger line it drives name exactly what advanced. `installNeeded` means the pull also changed
 * the manifest or lockfile, so the install runs before the loop stops for restart, never after, and a stale
 * dependency tree never survives into the relaunched process (W1-T151). */
export type DaemonFreshness =
  | { stale: false }
  | { stale: true; oldSha: string; newSha: string; installNeeded?: boolean };

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

export interface DaemonDeps {
  /** Re-read the plan from the same source the boot used, returning the fresh plan or `null` when
   *  nothing changed; omitted means the plan stays frozen at boot. The dep owns change detection
   *  because the cheap signal is caller-specific: a plan tree sha costs ~8ms, the parse ~60ms (impl-FZ). */
  reloadPlan?: () => Plan | null;
  /** Fresh merged predicate each call (re-derived from GitHub between iterations). */
  refreshMerged: () => MergedSet;
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
  /** Raw pushed-run-branch listing, read once per tick and parsed by `runBranchTaskIds`. Injected
   *  for the same reason it is on `DrainDeps`: this module reads its world through deps, and the
   *  raw-output shape makes one sweep per tick the only form that type checks (W1-T916). */
  readPushedRunBranches?: () => string;
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
   * W1-T316 (wiring W1-T271's own predicate): THE LIFETIME DISPATCH CAP (status.ts's `isLifetimeDispatchCapExceeded`,
   * ledger-derived — `run.start` lines counted across the task's WHOLE history, never reset by a `pr.opened` line,
   * unlike `isCircuitTripped`'s own count). Optional — omitted, dispatch behaves exactly as before this cap existed. */
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /** 
   * Called once per task excluded because its lifetime dispatch cap is exceeded — mirrors `onCircuitBreak`'s
   * legibility contract, so this exclusion is never a silent skip. */
  onLifetimeCapExceeded?: (task: Task) => void;
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
  /** True when a task's own read is indeterminate — a genuine read failure rather than a clean
   *  absence of evidence — re-derived from the same projection. Optional (W1-T119). */
  isIndeterminate?: (taskId: string) => boolean;
  /** Called once per task excluded because its own read is indeterminate. */
  onIndeterminate?: (task: Task) => void;
  /** Run ONE task through the existing run-task path (default = runTask). */
  runOne: (taskId: string) => Promise<RunResult>;
  /** `laneDispatchBudget`'s other input: the same open-PR-count closure the real wiring already
   *  builds for `checkQueueGovernor`, never a second read path. Consulted only at two or more lanes.
   *  Optional — omitted, a wide batch is bounded by `laneCount` alone (W1-T343). */
  openPrCount?: () => number;
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
  /** Fleet control: a defined return means a hard STOP is in effect, and the string is the ledger
   *  and summary detail. Checked first, every tick, so it takes precedence over PAUSE and wins the
   *  race if both flags are set (W1-T11, MASTER-PLAN §4A/§4B). */
  checkStop?: () => string | undefined;
  /** Fleet control: a defined return means a graceful PAUSE, a drain-and-hold. Checked between
   *  iterations only, after the current dispatch has resolved, so in-flight work always runs to full
   *  completion before a pause is honoured (W1-T11). */
  checkPause?: () => string | undefined;
  /** An optional check, consulted once per tick with the same between-iterations-only discipline as the
   *  operator holds, so it can never interrupt work already in flight. A stale result stops the loop with a
   *  deliberate non-zero exit and ledgers `daemon_selfrestart_for_freshness`, which is what a crash-loop
   *  reader keys off rather than the exit code. Why: five manual pull-and-reload cycles in one weekend,
   *  because merged fixes were invisible to the running daemon (W1-T126). Forensics: docs/forensics/daemon.md. */
  checkFreshness?: () => DaemonFreshness;
  /** Consulted only when freshness reports an install is needed. Runs before the loop stops for
   *  restart, never after, so the relaunched process inherits a dependency tree matching `newSha`.
   *  This module stays pure; the real command wires the install (W1-T151). */
  runInstall?: () => void;
  /** Peek the pending "run this queued task now" kick markers, oldest first — a pure injection, no filesystem here.
   * The daemon gates each through {@link assertRunnable} and the merged projection and clears it as it dispatches or
   * refuses it, so a runnable kick it cannot service this cycle survives to the next (fb-1784988460437-9daa9b). */
  pendingKicks?: () => Array<{ taskId: string; origin: string }>;
  /** Delete one kick marker (consumed-once) after the daemon dispatches or refuses it. */
  clearKick?: (taskId: string) => void;
  /** Read and delete the "drain now" marker, consumed once; a defined return means the operator
   *  asked for one immediate dispatch cycle. */
  consumeDrainNow?: () => { origin: string } | null;
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
   *  action. Best-effort, and called alongside dispatch, never instead of it (W1-T77, ratifies P22). */
  sweep?: (continueReviewAdmissions?: () => boolean) => Promise<void> | void;
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
  /** The digest's own cadence rung. Its own policy row on its own marker file, separate from the measurement row so
   * the two can never drag each other, while reusing the same pure decision function. Optional (W1-T2277). */
  checkDigestCadence?: () => MeasurementCadenceDecision;
  /** Build and deliver one digest, returning what got sent — never inside the producer itself. Never
   *  files a task, mints an id or spawns a worker (Law 5). Best-effort (W1-T2277). */
  runDigestCadence?: () => Promise<DigestCadenceRunResult>;
  /** The board-review rung, wired. Its unit is the whole open board rather than one PR, and it has its own policy row
   * and marker file so three cadences sharing one bound cannot drag each other. Why the check-and-run pair matters:
   * #2952 merged 385 tested lines and the rung never fired once, because nothing called it. It also carries retired
   * proposal ids, reconciled on every call (W1-T2304, W1-T2464). */
  checkBoardReview?: () => BoardReviewCadenceDecision & { retiredProposalIds?: string[] };
  /** Runs one board-review tick. Read-only by construction: it writes one report artifact and drafts
   *  registry proposals, and nothing else — it does not push, merge, mint or file, and Rule 15
   *  stands. Best-effort, and a fired review never gates dispatch or changes a verdict. */
  runBoardReview?: () => Promise<BoardReviewReport>;
  /** Evaluate the retro cadence trigger this tick. Fires on merges-since-marker or days-since-marker, whichever
   * crosses first (policy data). An undefined return means there is nothing safe to evaluate — a corrupt marker, a
   * degraded read — and the loop only acts on an explicit fire. Optional (W1-T160). */
  checkRetroTrigger?: () => RetroTriggerDecision | undefined;
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
  }) => AutoTriageDecision;
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
  /** The restricted light-sweep ticker. Dispatch is unbounded and the full reconciler only runs between
   *  iterations, so a PR that went green-but-review-absent sat invisible for the dispatch's whole
   *  remaining duration — #707 swept at 13:12 and never swept the new head again (W1-T254). Trap: the
   *  real wiring restricts it to the sha-pinned, mutex-serialized post-review re-post only; every other
   *  lane must stay single-threaded and never runs from here. Forensics: docs/forensics/daemon.md. */
  sweepLight?: () => Promise<void> | void;
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

/** Duck-typed classifier for a spawn-infrastructure failure, checked by a plain string tag rather than `instanceof` so
 * this module never imports worker.ts as a value. Any other throw is still a genuine, unclassified error: this daemon
 * must not learn to swallow every crash, only the one named infrastructure class (W1-T113). */
function isSpawnInfraBlocked(err: unknown): err is { reasonClass: "blocked_toolchain"; message: string } {
  return typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";
}

/** BACKSTOP — the maximum time the inter-phase review clock's stop may wait for an idle wait to notice its phase
 * ended. The wait seam is deliberately promise-only with no cancellation handle, so waiting out the whole poll
 * interval would add up to 60 seconds to every phase transition. The clock therefore subdivides only its in-process
 * wait into one-second quanta, while the poll interval stays the cadence that may start a light pass. No read or
 * reconciliation runs on the quantum itself (W1-T2852). */
export const INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS = 1_000;

interface InterphaseReviewClock {
  /** Stops new admission, lets an already-started pass settle, and reports whether this clock
   * consumed an event edge that the ordinary full-sweep gate still needs to reconcile. */
  stop(): Promise<{ eventWakeSeen: boolean }>;
}

/** The review-only clock for the part of an iteration that previously had none: after the full
 *  reconciliation await returns and before a phase ticker or an idle wait takes over. It owns only
 *  the light pass, so no fix, merge, close, escalation or dispatch action is introduced here. A wake
 *  observed during an active pass stays pending and makes the next wait resolve immediately, which
 *  serializes one coalesced follow-up instead of overlapping passes (W1-T2852). Forensics: docs/forensics/daemon.md. */
function startInterphaseReviewClock(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): InterphaseReviewClock {
  let active = true;
  let eventWakeSeen = false;
  let eventWakePending = false;
  let elapsedMs = 0;
  const wait = deps.sleepUntilSweepWake;
  const quantumMs = Math.max(1, Math.min(pollIntervalMs, INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS));
  // This clock exists to consume the durable event signal, and must not synthesize it over the
  // legacy plain wait seam, which cannot be interrupted at a phase boundary. Production always wires
  // the interruptible form; omission retains the exact earlier call cadence.
  const runner = deps.sweepLight && wait
    ? (async () => {
        while (active) {
          const result = await wait(quantumMs);
          if (result === "wake") {
            eventWakeSeen = true;
            eventWakePending = true;
          } else {
            elapsedMs += quantumMs;
          }
          if (!active) break;
          if (!eventWakePending && elapsedMs < pollIntervalMs) continue;

          const halt = deps.checkStop?.() ?? deps.checkPause?.();
          if (halt) continue;

          const trigger = eventWakePending ? "github-event" : "interval";
          eventWakePending = false;
          elapsedMs = 0;
          try {
            await deps.sweepLight!();
            if (trigger === "github-event") log("daemon.review_clock.wake_consumed", { trigger });
          } catch (e) {
            log("daemon.sweep_light.failed", { phase: "interphase", error: String((e as Error)?.message ?? e) });
          }
        }
      })()
    : undefined;

  return {
    stop: async () => {
      active = false;
      if (runner) await runner;
      return { eventWakeSeen };
    },
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
  headroomSampler?: { lastSampleMs: number; now: () => number; policy: HeadroomPolicy; enforced: boolean },
): { stop: () => Promise<void> } {
  let active = true;
  // A wake edge is consumed when it shortens a wait, but its durable marker is not claimed until the
  // gate accepts a pass. Retain that intent across a hold or an older still-settling pass, and retry
  // once per ordinary cadence, never as a zero-delay loop.
  let eventWakePending = false;
  const ticker = deps.sweepLight
    ? (async () => {
        while (active) {
          // Dispatch and retro can hold the loop for tens of minutes, so let an event wake this wait only
          // when the ticker owns the retrigger. The nested ticker inside a full pass stays on the ordinary
          // clock, so an event arriving then remains pending for one later accepted pass (W1-T2568).
          const waitResult = await (sweepRetrigger ? (deps.sleepUntilSweepWake ?? deps.sleep) : deps.sleep)(pollIntervalMs);
          if (waitResult === "wake") eventWakePending = true;
          if (!active) break;
          // The acknowledgement gap (W1-T1065 part iv). The pause row is written only inside the branch that acts
          // on a hold, so a hold created mid-drain was invisible: no row distinguished "seen, draining to
          // completion" from "not seen at all", and the operator escalated to a container stop. A re-check here
          // can never abort the batch already in flight; it only makes the two cases distinguishable.
          const holdSeen = phase === "dispatch" ? Boolean(deps.checkPause?.()) : undefined;
          // Pre-judged by the CLI wiring against the same definition `rmd doctor` reports, so this pure
          // module never re-derives the boundary. A reading back at OK re-arms the latch, so a genuinely new
          // episode escalates again (W1-T1082).
          const diskHeadroom = deps.readDiskHeadroom?.();
          if (diskHeadroom?.verdict === "OK") diskHeadroomLatch.escalated = false;
          log("daemon.alive", {
            phase,
            poll_interval_ms: pollIntervalMs,
            // W1-T2744: bounded cardinality on the existing heartbeat, never a promise-poll row.
            // This distinguishes a live review clock plus settling fix from the measured wedge.
            detached_sweep_actions: detachedSweepActionCount(),
            ...(holdSeen !== undefined ? { pause_seen: holdSeen } : {}),
            ...(diskHeadroom?.freeBytes !== undefined ? { disk_free_bytes: diskHeadroom.freeBytes } : {}),
          });
          // Sample account headroom once the last reading has gone stale. Placed after the liveness write on purpose:
          // this tick's heartbeat is already on the ledger before the probe is awaited, so a slow probe can delay the
          // next heartbeat but never swallow this one. Telemetry, not enforcement — a reading taken here cannot abort
          // work in flight, and the main loop remains the single place that decides to idle (W1-T2565).
          if (headroomSampler && deps.readUsage) {
            const nowMs = headroomSampler.now();
            if (nowMs - headroomSampler.lastSampleMs >= HEADROOM_SAMPLE_MAX_AGE_MS) {
              headroomSampler.lastSampleMs = nowMs;
              try {
                const snap = await deps.readUsage();
                const reading = snap ? resolveHeadroomWindows(snap, new Date(nowMs), headroomSampler.policy)[0] : undefined;
                if (reading) {
                  log("daemon.headroom", {
                    phase,
                    window: reading.window,
                    percent_used: reading.percentUsed,
                    limit_pct: reading.limitPct,
                    resets_at: reading.resetsAtDisplay,
                    enforced: headroomSampler.enforced,
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
                ts: (deps.now ?? (() => new Date()))().toISOString(),
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
          if (sweepRetrigger && deps.sweep) {
            const nowMs = (deps.now ?? (() => new Date()))().getTime();
            const last = sweepRetrigger.state.lastRunAtMs;
            const trigger = eventWakePending ? "github-event" : "interval";
            if (eventWakePending || last === undefined || nowMs - last >= sweepRetrigger.intervalMs) {
              const halt = deps.checkStop?.() ?? deps.checkPause?.();
              if (halt) {
                log("daemon.sweep.retrigger_held", { phase, detail: halt, trigger });
              } else {
                const accepted = sweepRetrigger.liveness?.inFlight !== true;
                sweepRetrigger.state.lastRunAtMs = nowMs;
                log("daemon.sweep.retriggered", {
                  phase,
                  trigger,
                  poll_interval_ms: pollIntervalMs,
                  interval_ms: sweepRetrigger.intervalMs,
                });
                await runGatedSweep(deps, pollIntervalMs, sweepRetrigger.sweepWallClockBoundMs, log, diskHeadroomLatch, undefined, sweepRetrigger.liveness);
                if (accepted) eventWakePending = false;
              }
            }
          }
          try {
            await deps.sweepLight!();
          } catch (e) {
            log("daemon.sweep_light.failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      })()
    : undefined;
  // Cleared on every exit path by the caller; a light pass already in flight is allowed to finish
  // rather than aborted (W1-T254).
  return {
    stop: async () => {
      active = false;
      if (ticker) await ticker;
      // Stop owns this clock, not every process-global action a light pass ever detached. sweep.ts
      // retains each fix until it settles; awaiting that registry here turned the full-pass bound into an
      // unbounded phase exit. Awaiting the ticker still lets its current pass finish (W1-T2744).
    },
  };
}

/** The shared config the dispatch and retro call sites pass so they can also re-fire the full
 *  reconciliation on a cadence, not only the light pass. `state` is one mutable ref threaded from
 *  `runDaemon` into every call site — never a fresh object per call, which would make each phase
 *  re-derive "elapsed since last pass" from its own private zero (W1-T1272). */
interface SweepRetrigger {
  /** Mirrors `DaemonOpts.sweepWallClockBoundMs` — the SAME bound the top-of-iteration call uses. */
  sweepWallClockBoundMs: number;
  /** `DaemonOpts.sweepRetriggerIntervalMs` (resolved), the minimum gap between two retriggers. */
  intervalMs: number;
  /** SHARED across every call site — see this interface's own doc. */
  state: { lastRunAtMs: number | undefined };
  /** The same {@link SweepLiveness} the top-of-iteration calls hold. Carried here because the
   *  retrigger is a second route into a concurrent pass that the wall-clock bound does not cover:
   *  measured, the last two pre-fix draft batches were 20m27s apart, this interval rather than the
   *  bound. Optional, so a caller that predates it is unchanged. */
  liveness?: SweepLiveness;
}

/** The gate itself, extracted so the bound and the light-pass ticker apply identically at every call
 * site: the once-per-iteration call, the stale-freshness call, and a mid-flight retrigger. A second
 * inlined copy is how they could silently drift, and behaviour is byte-identical to the inline block
 * it replaced (W1-T1272). The pass also receives a continuation callback that the timeout flips
 * before resolving the abandoned arm, so a still-settling pass finishes running reviewers but admits
 * no more (W1-T2584). Callers must check the hook is defined; this assumes it is. */
/** The one piece of state that makes "one pass at a time" true (W1-T2582). `inFlight` is set when a
 * pass starts and cleared when its promise SETTLES — deliberately not when the wall-clock bound stops
 * awaiting it, because the bound stops waiting and never stops the work, and every re-entry the fleet
 * observed landed in that window. Exclusion, not cancellation: an abandoned pass may hold a live
 * worker or a half-written cache, so it runs to completion and the next declines to start. Forensics: docs/forensics/daemon.md. */
export interface SweepLiveness {
  /** True while a `deps.sweep()` promise is still executing, INCLUDING after its await was
   *  abandoned by the wall-clock bound. */
  inFlight: boolean;
}

async function runGatedSweep(
  deps: DaemonDeps,
  pollIntervalMs: number,
  sweepWallClockBoundMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  diskHeadroomLatch: { escalated: boolean },
  // Threaded to the pass's own ticker. This is the phase that motivated the sampler: it carries the
  // largest spender, and the measured 58-minute blind window was a pass running long while the
  // account went from 30% used to exhausted. Optional and trailing (W1-T2565).
  headroomSampler?: { lastSampleMs: number; now: () => number; policy: HeadroomPolicy; enforced: boolean },
  // The shared liveness flag. Optional and trailing, so every existing caller behaves exactly as
  // before, which is what keeps the W1-T1044 bound tests meaningful (W1-T2582).
  liveness?: SweepLiveness,
): Promise<void> {
  // Decline, do not duplicate. Checked before the ticker starts, so a declined pass costs nothing at
  // all. This one gate closes both routes into a concurrent pass, because all three call sites pass
  // through it — including the retrigger, which the bound alone does not cover (W1-T2582).
  if (liveness?.inFlight) {
    log("daemon.sweep.skipped_concurrent", { reason: "a previous sweep pass is still executing" });
    return;
  }
  // Claim a durable event wake only after the liveness gate accepts this pass. A marker received after an earlier
  // pass was abandoned-but-still-running belongs to the later pass that actually starts (W1-T2656).
  deps.acknowledgeSweepWake?.();
  if (liveness) liveness.inFlight = true;
  const stopSweepTicker = startInFlightTicker(deps, pollIntervalMs, log, "sweep", diskHeadroomLatch, undefined, headroomSampler).stop;
  try {
    let reviewAdmissionsOpen = true;
    const continueReviewAdmissions = (): boolean =>
      reviewAdmissionsOpen && deps.checkStop?.() === undefined && deps.checkPause?.() === undefined;
    const sweepPromise: Promise<void | undefined> = Promise.resolve().then(() => deps.sweep!(continueReviewAdmissions));
    // Cleared on settle, never on abandon. Attaching this to the pass promise itself, rather than to the
    // `finally` below, which runs when the await ends, is what keeps the flag true through the
    // abandon-to-settle window every observed re-entry landed in. `then(onOk, onErr)` rather than
    // `finally`, so this derived promise can never become an unhandled rejection of its own.
    if (liveness) void sweepPromise.then(() => { liveness.inFlight = false; }, () => { liveness.inFlight = false; });
    const startedAtMs = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"abandoned">((resolve) => {
      timer = setTimeout(() => {
        reviewAdmissionsOpen = false;
        resolve("abandoned");
      }, sweepWallClockBoundMs);
    });
    try {
      const winner = await Promise.race([sweepPromise, bound]);
      if (winner === "abandoned") {
        const elapsedMs = Date.now() - startedAtMs;
        log("daemon.sweep.abandoned", { elapsed_ms: elapsedMs, bound_ms: sweepWallClockBoundMs });
        // Never leave the real pass's eventual outcome unhandled — it may resolve or throw well after this
        // call has moved on, which the reconciler's shared mutex is what makes safe.
        sweepPromise.catch((e) => {
          log("daemon.sweep.failed", { error: String((e as Error)?.message ?? e), after_abandon: true });
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    log("daemon.sweep.failed", { error: String((e as Error)?.message ?? e) });
  } finally {
    await stopSweepTicker();
  }
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
  // of ambiguous refusals preceded it is over, one way or another.
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

/** The daemon's startup routine (W1-T12b): the clean-env boot assertion, run once before the scheduler loop starts.
 * Takes the log sink and the env as injectable inputs, so it is provable in-process with a fake env and no real
 * launchd load. Every optional dependency below follows one shape: injected rather than imported, because this module
 * never touches the filesystem; run once here; logged either way, so the step's own pass or fail is part of the boot
 * record; and omitted means no step and behaviour unchanged. A failure is logged and the boot continues — the T197
 * doctrine, that the daemon sleeps through problems. Forensics: docs/forensics/daemon.md. */
export function daemonBoot(
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
   *  up when the daemon comes up rather than only on its next per-poll pass. Synchronous, like the
   *  orphan sweep above. Appended last so no positional caller shifts (W1-T530 part ii). */
  sweepFeedbackLanding?: () => LandFeedbackResult,
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
): BootAssertion {
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
  // The boot-rate invariant: the shape-not-cause check. Logged either way, so the invariant's own
  // pass or fail is part of the boot record, not only its breaches (W1-T215).
  if (crashLoopCheck) {
    const nowIso = (crashLoopCheck.now ?? (() => new Date().toISOString()))();
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
      const result = sweepFeedbackLanding();
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
 * flagged and skipped, a fixable blocker gets a bounded fix attempt (W1-T174), and a genuine blocker halts and
 * escalates. Idling is an in-process state, never a process exit. Forensics: docs/forensics/daemon.md. */
export async function runDaemon(
  plan: Plan,
  deps: DaemonDeps,
  opts: DaemonOpts = {},
): Promise<DaemonSummary> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // W1-T1044: see DaemonOpts.sweepWallClockBoundMs's own doc — POLICY DATA (rule 2), threaded
  // by the real `rmd daemon` entry, defaulted here for a direct/test caller that omits it.
  const sweepWallClockBoundMs = opts.sweepWallClockBoundMs ?? DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS;
  // One mutable ref for when a full pass last actually ran, shared by every call site below — see {@link
  // SweepRetrigger} for why a shared reference, not a fresh object per site, is load-bearing. It starts undefined so
  // the first pass of this process's life runs unconditionally (W1-T1272). One liveness flag for this daemon's whole
  // life, shared by every route; per-process scope is the correct scope (W1-T2582).
  const sweepLiveness: SweepLiveness = { inFlight: false };
  const sweepRetriggerState: { lastRunAtMs: number | undefined } = { lastRunAtMs: undefined };
  const sweepRetrigger: SweepRetrigger = {
    sweepWallClockBoundMs,
    intervalMs: opts.sweepRetriggerIntervalMs ?? DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS,
    state: sweepRetriggerState,
    liveness: sweepLiveness,
  };
  const log = deps.log ?? (() => {});
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
  /** Last emitted idle-reason signature — see the cadence note at the idle rung. */
  let lastIdleSignature: string | undefined;
  // Per-task transient retry state, threaded across ticks for the same task id. Dropped once a task's
  // disposition is no longer a transient retry (W1-T46).
  const blockRetryStates = new Map<string, RetryState>();
  // The cross-task counterpart to the map above — content-keyed on whether the last transient verdict
  // was a different task id, never on one task's own retry budget (W1-T2517).
  let apiWindowHoldState: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  // Circuit-breaker escalation dedup. This loop is persistent, so without it a task that stays tripped
  // would be re-escalated on every idle poll for as long as the daemon runs. This set bounds the
  // CALLBACK to the first observation of each task id this run; the predicate itself is still
  // consulted, and still excludes the task, every tick (P29(ii)).
  const circuitEscalated = new Set<string>();
  // Same per-run escalation-dedup contract, for the lifetime cap (W1-T316/W1-T271) — the
  // predicate itself is still consulted (and still excludes the task) every tick.
  const lifetimeCapEscalated = new Set<string>();
  // Spawn-infra escalation dedup, content-keyed on the failure's own reason text rather than task id:
  // the vanished-binary class blocks dispatch identically for every task, so task-id keying would
  // re-escalate once per distinct task hitting the same cause (W1-T113 part iii).
  const toolchainEscalated = new Set<string>();
  // CONSECUTIVE spawn-infra failures — backs the backoff below; reset by any
  // runOne call that does NOT throw this class (success or an unrelated verdict).
  let consecutiveSpawnInfraFailures = 0;
  // Headroom reserve escalation dedup — the same per-episode bound as the breaker above. A sustained
  // breach is read fresh every tick, so without this the hook would fire on every idle poll. Cleared
  // the moment a read reports the window back under the reserve (P34 (c), W1-T249).
  let headroomReserveEscalated = false;
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
  // One sampler state shared by the main loop and every in-flight ticker, so the two can never
  // double-read and staleness is measured against whichever read last. Seeded to 0 so the first long
  // phase after boot samples immediately (W1-T2565).
  const headroomSampler = { lastSampleMs: 0, now: () => now().getTime(), policy: headroomPolicy, enforced: headroomEnabled };
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? DEFAULT_UNREADABLE_DEGRADED_LIMIT;
  const parkCeilingMs = opts.headroomParkCeilingMs ?? HEADROOM_PARK_CEILING_MS;
  const now = deps.now ?? (() => new Date());
  // Top-level waits are interruptible, as are phase-ticker waits that own a retrigger. Light and
  // pass ticker waits stay on the plain clock, so they cannot consume an event without reconciling it
  // through the ordinary gated full pass (W1-T2568).
  const sleepUntilSweepWake = deps.sleepUntilSweepWake ?? deps.sleep;
  // Resolved once, for this process's whole lifetime: `DaemonOpts` is the frozen-at-boot configuration. Floored at 1,
  // never 0, so a misconfigured lane count can never silently mean "dispatch nothing"; the budget helper floors its
  // own input the same way, so a value below 1 clamps up here rather than producing two disagreeing floors (W1-T343).
  const laneCount = Math.max(1, opts.laneCount ?? 1);

  const summary = (stopReason: DaemonStopReason, stopDetail?: string): DaemonSummary => {
    const s: DaemonSummary = { attempted, merged, stopReason, stopDetail, costUsd, ticks };
    log("daemon.summary", { ...s });
    return s;
  };

  // One stale-exit path for both freshness boundaries. Both must preserve the same install, bounded pass, named
  // ledger and stale summary contract; duplicating that sequence would let them drift (W1-T2845).
  const stopForFreshness = async (
    freshness: Extract<DaemonFreshness, { stale: true }>,
  ): Promise<DaemonSummary> => {
    // Install BEFORE the loop stops for restart, never after, so the relaunched process inherits deps
    // matching the new sha rather than the stale tree this process is still running (W1-T151).
    if (freshness.installNeeded) {
      deps.runInstall?.();
    }
    // Every stale exit reaches the same bounded full-pass gate before returning. The restart is never
    // suppressed by the pass, and no second implementation is introduced (W1-T1272).
    if (deps.sweep) {
      sweepRetriggerState.lastRunAtMs = now().getTime();
      await runGatedSweep(deps, pollIntervalMs, sweepWallClockBoundMs, log, diskHeadroomLatch, headroomSampler, sweepLiveness);
    }
    // A freshness restart is the process-lifetime boundary the detached-action registry was built for.
    // The final pass above may have admitted a fix and detached only its long CI wait; returning before
    // that settles lets the entrypoint replace this process and kill a useful worker. The caller stops
    // its interphase clock before entering here, so nothing races in behind the drain (W1-T2865).
    const detachedAtFreshness = detachedSweepActionCount();
    if (detachedAtFreshness > 0) {
      const drainStartedAtMs = now().getTime();
      log("daemon.freshness_drain.started", { detached_sweep_actions: detachedAtFreshness });
      await drainDetachedSweepActions();
      log("daemon.freshness_drain.completed", {
        detached_sweep_actions: detachedAtFreshness,
        remaining_detached_sweep_actions: detachedSweepActionCount(),
        duration_ms: Math.max(0, now().getTime() - drainStartedAtMs),
      });
    }
    const detail =
      `origin/main advanced ${freshness.oldSha.slice(0, 7)}..${freshness.newSha.slice(0, 7)} ` +
      `past this process's boot sha`;
    log("daemon_selfrestart_for_freshness", { old_sha: freshness.oldSha, new_sha: freshness.newSha });
    return summary("stale", detail);
  };

  // One per-task block-reasoning processor, shared by the single-task tick and the multi-lane batch, so how a solo
  // dispatch's result is judged cannot fork from how one lane's is judged. Extracted verbatim from the earlier loop
  // body: every log line, field and ordering decision is byte-identical. The plan value is a parameter, never closed
  // over, because the binding is rebound every tick; and it returns a disposition so a caller can finish every
  // sibling's bookkeeping before halting. Forensics: docs/forensics/daemon.md.
  const processDispatchResult = async (
    planForBatch: Plan,
    task: Task,
    result: RunResult,
    isMerged: MergedSet,
  ): Promise<{ kind: "merged" } | { kind: "continue" } | { kind: "genuine_blocker"; detail: string }> => {
    // The verdict describes how THIS RUN ended, not whether the pull request is merged: a PR that
    // merges gate-side after the run stopped leaves the result unmerged even though the task is done.
    // The tick's already-resolved merged projection — never a second lookup — answers the question
    // block reasoning is actually trying to ask (W1-T976).
    if (!result.merged && isMerged(task.id)) {
      merged.push(task.id);
      return { kind: "merged" };
    }
    if (!result.merged) {
      // Block reasoning: reuse the transient/strike taxonomy and the plan's DAG instead of halting on any
      // non-merged verdict (W1-T46, superseding blunt stop-on-block).
      const state = blockRetryStates.get(task.id) ?? INITIAL_RETRY_STATE;
      const disposition = reasonAboutBlock(planForBatch, task.id, result.verdict, state);

      if (disposition.kind === "retry_transient") {
        // Transient: no strike. Selection naturally retries the same task next tick, since it is still
        // unmerged and its deps are unchanged, so no separate re-dispatch mechanism is needed.
        blockRetryStates.set(task.id, disposition.state);
        log("daemon.block.transient_retry", {
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
        log("daemon.block.fixable_dispatch", {
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
        // Independent failure: nothing in the plan transitively depends on this task, so skipping it cannot
        // leave a dependent building on a gap. Flag it, so selection never reconsiders it this run, and
        // keep draining everything else.
        task.status = "blocked";
        log("daemon.block.independent_failure", {
          task: task.id,
          verdict: result.verdict,
          pr_url: result.prUrl,
        });
        return { kind: "continue" };
      }

      // Genuine blocker: real downstream work transitively needs this task merged, so "never continue into
      // the gap" is absolute. Halt and escalate, exactly as stop-on-block halted, but with the dependents
      // named. Reached by a genuine blocker, by a fixable one whose strike bound is exhausted, and by a
      // fixable one with no fix rung wired (W1-T174).
      log("daemon.blocked", {
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
      };
    }
    merged.push(task.id);
    return { kind: "merged" };
  };

  for (;;) {
    // The liveness tick: the one row this loop writes unconditionally, every iteration, on every path below.
    // Every other daemon-prefixed step is either boot-time and one-shot, or confined to the three windows the
    // in-flight ticker runs in. Measured: the prefix went silent for 102.5 minutes on 2026-08-23 while the
    // daemon stayed alive, and the freshness judges read a false FAIL. Placed as literally the first statement
    // of the loop body so no branch below can skip it (W1-T1274).
    log("daemon.tick", { poll_interval_ms: pollIntervalMs });

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

    // Plan freshness. The plan arrives as a parameter and was never reassigned, so a task filed after this boot began
    // was invisible to every dispatch decision for the boot's lifetime — measured, the median gap between a task
    // landing on origin/main and the daemon next booting is 106 minutes (impl-FZ). Position is the safety argument:
    // after the stop check, so a halted fleet does no I/O, and before any dispatch decision reads the plan. A throw
    // is caught and ledgered, never fatal. Forensics: docs/forensics/daemon.md.
    if (deps.reloadPlan) {
      try {
        const fresh = deps.reloadPlan();
        if (fresh) {
          plan = fresh;
          log("daemon.plan_reloaded", { tasks: fresh.tasks.length });
        }
      } catch (e) {
        log("daemon.plan_reload_failed", { reason: e instanceof Error ? e.message : String(e) });
      }
    }
    // One snapshot per dispatch batch (W1-T340; MASTER-PLAN §4B). The plan binding is mutable and reassigned by the
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
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }
    // Self-freshness, checked directly after both operator holds and before headroom and dispatch, so
    // origin/main advancing past this process's boot sha is noticed on the very next tick where the
    // daemon is neither stopped nor paused. Never interrupts in-flight work (W1-T126, W1-T936).
    const freshness = deps.checkFreshness?.();
    if (freshness?.stale) {
      return stopForFreshness(freshness);
    }

    // Console "drain now", consumed once at the top of a cycle. Its whole effect is "run one dispatch
    // cycle immediately", which this loop body already is, so consuming and ledgering it is the action.
    // The holds above still win: a drain request never overrides a deliberate hold.
    if (deps.consumeDrainNow) {
      const drain = deps.consumeDrainNow();
      if (drain) log("console.drain_consumed", { origin: drain.origin });
    }

    const isMerged = deps.refreshMerged();

    // The level-triggered PR-pipeline reconciler, once per iteration: re-derive every open PR's disposition
    // and take its gated action, alongside dispatch rather than instead of it (W1-T77, ratifies P22).
    // Best-effort in code, not just prose: this loop's only try/catch wraps the dispatch below, so an
    // unreachable GitHub used to propagate out of the process (W1-T513). Forensics: docs/forensics/daemon.md.
    if (deps.sweep) {
      sweepRetriggerState.lastRunAtMs = now().getTime();
      await runGatedSweep(deps, pollIntervalMs, sweepWallClockBoundMs, log, diskHeadroomLatch, headroomSampler, sweepLiveness);
    }

    // The clock that spans the former gap. The full pass above owns its own ticker, so this starts only
    // after that await returns and the two restricted passes never overlap by construction. It stays
    // live across the reconciliation rungs below and is stopped before a phase ticker or an idle wait
    // takes ownership of the clock (W1-T2852).
    let interphaseReviewClock: InterphaseReviewClock | undefined = startInterphaseReviewClock(
      deps,
      pollIntervalMs,
      log,
    );
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
      if (!interphaseReviewClock) {
        interphaseReviewClock = startInterphaseReviewClock(deps, pollIntervalMs, log);
      }
    };

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

    // Measurement cadence: "is this system getting better". Same once-per-iteration cadence; the check's
    // own policy-data bound throttles the actual run, so most ticks decide not to fire at no cost.
    // Best-effort, and a fired run never gates dispatch, fails a check or changes a verdict (W1-T1259).
    if (deps.checkMeasurementCadence) {
      let decision: MeasurementCadenceDecision | undefined;
      try {
        decision = deps.checkMeasurementCadence();
      } catch (e) {
        log("measurement_cadence.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (decision?.fire) {
        log("measurement_cadence.fired", { reason: decision.reason });
        if (deps.runMeasurementCadence) {
          try {
            const result = await deps.runMeasurementCadence();
            // The row is DERIVED from the result's own keys rather than hand-enumerated here, because a
            // hand-enumerated row silently drops every member added after it — which is how three fields reached
            // zero occurrences in this file (W1-T2502).
            log("measurement_cadence.ran", buildMeasurementCadenceRow(result));
          } catch (e) {
            log("measurement_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      } else if (decision) {
        log("measurement_cadence.skipped", { reason: decision.reason });
      }
    }

    // Digest cadence, separate from the measurement block above: its own policy row, its own marker
    // file, the same tick discipline and the same best-effort contract (W1-T2277).
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
            const result = await deps.runDigestCadence();
            log("digest_cadence.ran", { channel: result.channelName, delivered: result.delivered });
          } catch (e) {
            log("digest_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      } else if (digestDecision) {
        log("digest_cadence.skipped", { reason: digestDecision.reason });
      }
    }

    // Board review: the rung whose unit is the whole open board. Same shape and best-effort contract as the
    // two cadences above, on its own policy row and marker file. The ledger rows below are part of the fix:
    // board-review.ts has no log hook of its own, so before this block a fire wrote no row at all
    // (W1-T2304). Retired ids are logged on BOTH branches, because reconciliation is tied to the check, not
    // to the fire (W1-T2464). Forensics: docs/forensics/daemon.md.
    if (deps.checkBoardReview) {
      let boardDecision: (BoardReviewCadenceDecision & { retiredProposalIds?: string[] }) | undefined;
      try {
        boardDecision = deps.checkBoardReview();
      } catch (e) {
        log("board_review.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (boardDecision?.fire) {
        log("board_review.fired", { reason: boardDecision.reason, retiredProposalIds: boardDecision.retiredProposalIds ?? [] });
        if (deps.runBoardReview) {
          try {
            const report = await deps.runBoardReview();
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

    // Headroom: never hammer a nearly-exhausted pool. An at-or-near-limit reading gates new spawns
    // without halting the loop, because a supervisor restart-loops on any exit and exiting here would
    // relaunch into the same reading every poll. So this is an in-process idle state, identical in shape
    // to "nothing runnable" below. The usage read happens fresh every tick, so a real reset is picked up
    // automatically with no wake-at-reset timer. The ceiling itself is time-aware.
    if (deps.readUsage) {
      // The authoritative per-tick read stamps the shared sampler, so an in-flight ticker starting straight
      // after it waits out the full staleness bound instead of re-probing seconds later. Stamped before
      // the guard below because an unreadable read is still an attempt (W1-T2565).
      headroomSampler.lastSampleMs = now().getTime();
      const snap = await deps.readUsage();
      if (snap) {
        // A GOOD read clears the degraded-mode counter — only CONSECUTIVE
        // misses count toward escalation, not a lifetime total.
        consecutiveUnreadable = 0;
        // …and ends any park episode with it: the governor can see again, so the ceiling has
        // nothing left to bound and a LATER park starts its clock fresh.
        parkedSinceMs = undefined;
        parkCeilingEscalated = false;
        const windows = resolveHeadroomWindows(snap, now(), headroomPolicy, (window, raw) => {
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
        if (reading) {
          log("daemon.headroom", {
            ...(enforcingIdle ? { tick: ticks } : {}),
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
          now().getTime(),
          parkCeilingMs,
        );
        if (parkGate.parked && parkedSinceMs === undefined) parkedSinceMs = now().getTime();
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
      for (const bucket of ["core", "graphql"] as const) {
        const reading = quota[bucket];
        if (!reading) continue;
        log("daemon.quota", {
          bucket,
          remaining: reading.remaining,
          resets_at: reading.resetsAt,
          poll_interval_ms: pollIntervalMs,
        });
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
    if (tickGovernor) {
      ticks++;
      logDispatchGovernorDefer(tickGovernor, ticks);
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }

    // Retro cadence trigger, evaluated once per tick after headroom — an automated retro spawns a real run,
    // the same class of spend headroom exists to gate — and before the dispatch pick. There is deliberately
    // no wait-and-continue: the gates above exist to REFUSE a dispatch, but the retro gates nothing and
    // only delayed reaching dispatch by a full poll interval (W1-T2265). Forensics: docs/forensics/daemon.md.
    if (deps.checkRetroTrigger) {
      let decision: RetroTriggerDecision | undefined;
      try {
        decision = deps.checkRetroTrigger();
      } catch (e) {
        log("daemon.retro_trigger.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (decision?.fire) {
        log("retro_triggered", {
          reason: decision.reason,
          merges_since_marker: decision.mergesSinceMarker,
          // Infinity (the marker-absent case) is not JSON-representable — name it
          // explicitly rather than let JSON.stringify silently collapse it to null.
          days_since_marker: Number.isFinite(decision.daysSinceMarker) ? decision.daysSinceMarker : "unbounded",
        });
        if (deps.runRetroTrigger) {
          // The retro already owns the established liveness/retrigger ticker. Hand clock
          // ownership over without overlap; an event consumed by the inter-phase clock returns
          // to the ordinary top-of-iteration full sweep before admitting this optional spend.
          if (await stopInterphaseReviewClock()) continue;
          try {
            // The retro's own await is unbounded, like the dispatch below, so it is wrapped in the same
            // light-sweep ticker and reconciliation keeps dispositioning PRs while it runs (W1-T276).
            await sweepLightDuringRetro(
              deps,
              pollIntervalMs,
              log,
              () => deps.runRetroTrigger!(decision),
              diskHeadroomLatch,
              sweepRetrigger,
            );
          } catch (e) {
            log("daemon.retro_trigger.run_failed", { error: String((e as Error)?.message ?? e) });
          } finally {
            restartInterphaseReviewClock();
          }
        }
      }
    }

    // Console "run" kick: a queued-row Run dispatches that task by id this cycle, ahead of the ordinary
    // ordering but still through the normal gate. A kicked id that is unknown, already merged, or refused
    // by {@link assertRunnable} is cleared and its named reason ledgered, never silently dropped. The
    // first runnable kick becomes this cycle's task; others wait (fb-1784988460437-9daa9b).
    const mergedTask: MergedResolver = (t) => isMerged(t.id);
    let forcedNext: Task | undefined;
    if (deps.pendingKicks) {
      for (const kick of deps.pendingKicks()) {
        const refuse = (reason: string) => {
          deps.clearKick?.(kick.taskId);
          log("console.kick_refused", { task: kick.taskId, origin: kick.origin, reason });
        };
        const task = planForBatch.byId.get(kick.taskId);
        if (!task) { refuse("unknown task id"); continue; }
        if (isMerged(kick.taskId)) { refuse("already merged — stale kick"); continue; }
        try {
          assertRunnable(planForBatch, task, mergedTask);
        } catch (e) {
          refuse(e instanceof PlanError ? e.message : String((e as Error)?.message ?? e));
          continue;
        }
        deps.clearKick?.(kick.taskId);
        log("console.kick_dispatched", { task: kick.taskId, origin: kick.origin });
        forcedNext = task;
        break;
      }
    }

    // Why the daemon is idle. The four eligibility conditions used to decline silently, so a ten-hour
    // idle emitted about 390 bare idle lines and zero dispatch rows: the record could not distinguish
    // "starved of work" from "everything filtered". Nothing about what is eligible changes.
    const idleReasons = tallyDispatchFilters();
    // Eligibility ledgers a circuit-broken decline through its own callback, never the filter tally, so
    // it is collected here per tick and the census below can name it alongside the other buckets.
    const circuitBrokenThisTick: string[] = [];
    // One branch sweep per tick, resolved before the options object so the closure below is a
    // set-membership test rather than a round trip per candidate (W1-T916).
      const pushedRunBranches = deps.readPushedRunBranches
        ? runBranchTaskIds(deps.readPushedRunBranches())
        : undefined;
      const dispatchOpts: NextRunnableOpts = {
      isOpenPr: deps.isOpenPr,
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
      ...(pushedRunBranches
        ? {
            hasPushedRunBranch: (id: string) => pushedRunBranches.has(id),
            // Rides the existing skip row with its own reason: no new step, and deliberately not the stood-down
            // row, which has three emitters and no reader.
            onSkipRunBranch: (t: Task) =>
              log("dispatch.skipped", { task: t.id, reason: "run-branch-already-pushed" }),
          }
        : {}),
      onFiltered: idleReasons.onFiltered,
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
      // Lifetime dispatch cap: a legible ledger line every tick it is consulted, with the escalation hook
      // bounded to once per task id for this run, mirroring the breaker above (W1-T316, W1-T271).
      onLifetimeCapExceeded: (t) => {
        log("dispatch.lifetime_capped", { task: t.id });
        if (!lifetimeCapEscalated.has(t.id)) {
          lifetimeCapEscalated.add(t.id);
          try {
            deps.onLifetimeCapExceeded?.(t);
          } catch (e) {
            log("daemon.escalation.failed", { task: t.id, error: String((e as Error)?.message ?? e) });
          }
        }
      },
    };

    // The dispatch set, adopting drain.ts's lane machinery rather than a second implementation. A console
    // kick always dispatches alone, bypassing candidate selection: it already ran the gauntlet eligibility
    // exists to apply. Otherwise the candidate walk applies the exact same eligibility chain the
    // single-task selector does, and at one lane the same single task is returned via the same walk, firing
    // the same callbacks in the same order (W1-T343). Forensics: docs/forensics/daemon.md.
    let dispatchSet: Task[];
    // Hoisted here because the partition is scoped to the else branch below while the rung now runs
    // outside the idle branch. Zero means nothing was deferred this tick; the forced path leaves it zero,
    // which is correct — an operator-forced dispatch is not evidence of a collision.
    let deferredPairings = 0;
    // Hoisted for the same reason. Left at 0 on the forced path: an operator-forced dispatch is not
    // evidence of spare capacity.
    let laneBudget = 0;
    if (forcedNext) {
      dispatchSet = [forcedNext];
    } else {
      const budget =
        laneCount <= 1
          ? laneCount
          : laneDispatchBudget({ laneCount, wipLimit: opts.wipLimit, openPrCount: deps.openPrCount?.() });
      if (laneCount >= 2 && budget <= 0) {
        // Mirrors `runDrainLanes`' own WIP-deferred row: runnable work may exist, held back by the governor
        // rather than absent, which is distinct from an ordinary idle tick. Never reached at one lane.
        log("dispatch.wip_deferred", {
          lane_count: laneCount,
          wip_limit: opts.wipLimit ?? null,
          observed_open_count: deps.openPrCount?.() ?? null,
        });
      }
      const candidates = runnableCandidates(planForBatch, isMerged, budget, dispatchOpts);
      // Passed explicitly rather than relying on the partition's own default parameter — see
      // `DaemonDeps.observedByTask` (W1-T2286).
      const partition = partitionByFileOverlap(candidates, deps.observedByTask ?? NO_OBSERVED_SCOPE);
      for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
      deferredPairings = partition.serialized.length;
      laneBudget = budget;
      dispatchSet = partition.dispatch;
    }

    // The auto-triage rung runs BEFORE the idle branch (operator ruling, reversing W1-T469). The starved
    // state is the idle state, and the gate W1-T469 served was circular: a deferral needs two eligible tasks
    // to collide, so the rung that CREATES work could only fire when work already existed. Measured on a
    // starved daemon: about 87 feedback entries unread, thirteen hours. The accepted cost is a skipped row
    // per held tick, each naming which bound held. Forensics: docs/forensics/daemon.md.
    if (deps.checkAutoTriage) {
      let decision: AutoTriageDecision | undefined;
      try {
        decision = deps.checkAutoTriage({
            deferralPending: deferredPairings > 0,
            dispatchCount: dispatchSet.length,
            laneBudget,
          });
      } catch (e) {
        log("auto_triage.check_failed", { error: String((e as Error)?.message ?? e) });
      }
      if (decision?.fire) {
        // In-flight guard: the same shape as the task lane's pair above, keyed on feedback id. The decision
        // only knows the entry's own status and cannot see an already-open PR carrying this id's provenance,
        // so that read happens here, right before the fire it would otherwise duplicate (W1-T300).
        const openPrNumber = deps.isFeedbackOpenPr?.(decision.feedbackId);
        let inFlight = openPrNumber !== undefined;
        if (inFlight && openPrNumber !== undefined) {
          // The confirming-read discipline, applied verbatim: a cached open can be stale, so a fresh read
          // stands the guard down rather than parking the entry forever on yesterday's snapshot (W1-T177).
          const liveState = deps.readFeedbackLiveState?.(decision.feedbackId, openPrNumber);
          if (liveState !== undefined && liveState !== "OPEN") {
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
            reason: "an open triage PR already carries this feedback id's provenance",
          });
        } else {
          log("auto_triage.fired", { feedback: decision.feedbackId, reason: decision.reason });
          if (deps.runAutoTriage) {
            const fired = decision;
            if (await stopInterphaseReviewClock()) continue;
            try {
              // The same wrapper, reused verbatim. Triage holds for minutes after opening its PR and this loop is
              // single-threaded, so an unwrapped await would black out every reconciliation for that duration.
              await sweepLightDuringRetro(
                deps,
                pollIntervalMs,
                log,
                () => deps.runAutoTriage!(fired.feedbackId),
                diskHeadroomLatch,
                sweepRetrigger,
              );
            } catch (e) {
              log("auto_triage.run_failed", {
                feedback: fired.feedbackId,
                error: String((e as Error)?.message ?? e),
              });
            } finally {
              restartInterphaseReviewClock();
            }
          }
        }
      } else if (decision) {
        log("auto_triage.skipped", { reason: decision.reason });
      }
    }

    if (dispatchSet.length === 0) {
      // Unlike drain.ts, where nothing runnable is a terminal stop, the daemon is persistent: new work can
      // land later, so it paces itself with the injected clock and keeps polling.
      ticks++;
      log("daemon.idle", { tick: ticks, poll_interval_ms: pollIntervalMs });
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

      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(pollIntervalMs);
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
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }

    // Awaited reconciliation rungs can make the top-of-tick freshness result obsolete before admission.
    // Re-read at the same safe boundary the hold re-check established, after both operator controls so
    // their priority stays exact, and before anything is admitted (W1-T2845).
    const refetchedFreshness = deps.checkFreshness?.();
    if (refetchedFreshness?.stale) {
      // This is the only freshness boundary reached while the interphase review clock exists. Close
      // admission before the shared final-pass and drain path; do not move the drain into the clock itself,
      // where W1-T2744 proved it can freeze ordinary phase transitions (W1-T2865).
      await stopInterphaseReviewClock();
      return stopForFreshness(refetchedFreshness);
    }

    // The per-lane governor gate, adopted verbatim from `runDrainLanes`. A sequential loop taking its own
    // fresh reading per candidate — never one reading admitting the whole batch — so a ceiling crossed
    // between lanes refuses the later one without touching the earlier: the break stops ADMITTING and
    // never revokes a lane already admitted. At one candidate this runs exactly once (W1-T342, W1-T343).
    const admitted: Task[] = [];
    let deferredVerdict: DispatchGovernorVerdict | undefined;
    for (const t of dispatchSet) {
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
      ticks++;
      logDispatchGovernorDefer(deferredVerdict!, ticks);
      if (await stopInterphaseReviewClock()) continue;
      await sleepUntilSweepWake(pollIntervalMs);
      continue;
    }

    if (dispatchSet.length > 1) {
      // Mirrors `runDrainLanes`' concurrent-set row — the evidence trail P19's banked rung 2 needs. Never
      // fires at one lane.
      log("dispatch.concurrent_set", { tasks: admitted.map((t) => t.id), lane_count: laneCount });
    }
    for (const t of admitted) {
      log("daemon.iteration", { task: t.id, attempted: attempted.length + 1, max: opts.max ?? null });
      attempted.push(t.id);
    }

    // The light-sweep ticker: while admitted lanes are unbounded and in flight, tick the restricted light
    // pass on the same injected clock idle polling uses, so a PR that goes green-but-review-absent
    // mid-batch re-posts within one poll interval instead of sitting invisible until every lane returns
    // (W1-T254). Cleared once every lane settles, on every exit path, and never aborted mid-call. It also
    // emits this dispatch's liveness rows — see {@link startInFlightTicker}.
    if (await stopInterphaseReviewClock()) continue;
    const stopTicker = startInFlightTicker(deps, pollIntervalMs, log, "dispatch", diskHeadroomLatch, sweepRetrigger, headroomSampler).stop;

    // Concurrent dispatch, mirroring `runDrainLanes`: settle-all, never fail-fast, so a sibling lane's rejection can
    // never abort another lane already in flight, and every lane's outcome is recorded before this tick decides
    // anything. At one lane this settles on the same schedule a bare await inside a try/catch would (W1-T343).
    const settled = await Promise.allSettled(admitted.map((t) => deps.runOne(t.id)));
    // The settled counterpart to the concurrent-set row. Emitted BEFORE the ticker stop and the
    // classification loop, because that loop's fatal path returns and the stop is itself awaited work that
    // could throw, so anything later would be lost in exactly the failure cases this row reports.
    log("dispatch.settled_set", settledSetPayload(admitted, settled, laneCount));
    await stopTicker();
    restartInterphaseReviewClock();

    // Classify every lane's settlement before this tick decides anything, mirroring `runDrainLanes`. A
    // genuine, non-spawn-infra throw is fatal for the whole daemon, exactly as it always was for a lone
    // dispatch; a spawn-infra throw degrades into backoff; a normal settlement is queued for the same
    // block reasoning every dispatch has always gone through.
    let fatalError: { taskId: string; message: string } | undefined;
    let spawnInfraSeenThisTick = false;
    const toProcess: Array<{ task: Task; result: RunResult }> = [];
    for (let i = 0; i < admitted.length; i++) {
      const t = admitted[i];
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        const err = outcome.reason;
        if (!isSpawnInfraBlocked(err)) {
          // First observed wins the summary detail, mirroring `runDrainLanes`' identical choice. Every other
          // already-settled lane is still classified and processed before this tick returns.
          if (!fatalError) fatalError = { taskId: t.id, message: String((err as Error)?.message ?? err) };
          continue;
        }
        // Degrade, do not die: a spawn-infrastructure failure is never a fatal crash. The pre-fix shape was
        // error, process exit, supervisor restart, the identical failure again — five consecutive polls, zero
        // escalations, zero backoff. Escalate once per distinct cause, and count once per TICK rather than per
        // lane, so a batch where two lanes hit the same outage backs off like one bad tick (W1-T113 part iii).
        spawnInfraSeenThisTick = true;
        const reason = err.message;
        log("daemon.spawn_infra_blocked", { task: t.id, reason, consecutive: consecutiveSpawnInfraFailures + 1 });
        if (!toolchainEscalated.has(reason)) {
          toolchainEscalated.add(reason);
          try {
            await deps.onSpawnInfraBlocked?.({ task: t, reason });
          } catch (escErr) {
            log("daemon.escalation.failed", { task: t.id, error: String((escErr as Error)?.message ?? escErr) });
          }
        }
        continue;
      }
      const result = outcome.value;
      costUsd += result.costUsd;
      toProcess.push({ task: t, result });
    }

    if (fatalError) {
      await stopInterphaseReviewClock();
      return summary("error", `${fatalError.taskId}: ${fatalError.message}`);
    }

    // A successful lane — including one returning a non-spawn-infra blocked verdict — clears the backoff
    // streak, exactly as the lone dispatch always did.
    if (toProcess.length > 0) consecutiveSpawnInfraFailures = 0;

    // Block reasoning, per lane. First observed genuine blocker wins the summary detail, mirroring the
    // fatal-error choice above and `runDrainLanes`' stop-on-block-at-pass-granularity doctrine, but every
    // lane's own bookkeeping still runs.
    let blockedDetail: string | undefined;
    // Updated alongside block reasoning, never inside it — a pure additional observation over the same per-lane loop.
    // Lane order is the settlement order fixed above, so a batch is walked deterministically (W1-T2517).
    let apiWindowHoldMs = 0;
    for (const { task, result } of toProcess) {
      const apiWindowDisposition = reasonAboutApiWindow(apiWindowHoldState, task.id, result.verdict, pollIntervalMs, maxApiWindowHoldMs);
      apiWindowHoldState = apiWindowDisposition.state;
      apiWindowHoldMs = apiWindowDisposition.holdMs;
      const outcome = await processDispatchResult(planForBatch, task, result, isMerged);
      if (outcome.kind === "genuine_blocker" && blockedDetail === undefined) {
        blockedDetail = outcome.detail;
      }
    }
    if (blockedDetail !== undefined) {
      await stopInterphaseReviewClock();
      return summary("blocked", blockedDetail);
    }

    if (apiWindowHoldMs > 0) {
      // Consecutive different-task transient refusals at or above the floor: hold dispatch rather than let
      // the next tick pay another full spawn to rediscover the identical closed window. Visible by design —
      // never a silent idle — so one row names the reason, the streak and the instant dispatch resumes.
      ticks++;
      const resumesAtMs = now().getTime() + apiWindowHoldMs;
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

    await stopInterphaseReviewClock();
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
