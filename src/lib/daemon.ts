/**
 * lib/daemon.ts — the daemon's scheduler-loop CORE (W1-T12a).
 *
 * W1-T12 (Daemonize) was split along the machine/human boundary (DIAGNOSIS.md,
 * Rule 16): this is the headless, unit-testable LOGIC half. Launchd unit
 * generation is W1-T12b (lib/launchd.ts); crash-recovery's resume/clean split
 * is W1-T12c (`reconstructOrphan`, below — its batch driver `reconstructState`
 * was retired, W1-T361: superseded by runRecoverability in src/run-task.ts, which
 * performs the same split read straight from the live ledger); actually loading
 * the plist on a real session, an overnight drain, and a live kill-and-recover
 * are the verify:human commissioning steps of W1-T12d — none of that is here.
 *
 * `rmd drain` (drain.ts) is a bounded, one-shot pass a human kicks off by hand:
 * DAG-select → dispatch → repeat, until `--max`/`--until`/a block/no more work.
 * This is that SAME machinery — `nextRunnable`, the fleet-control gates (W1-T11
 * STOP/PAUSE), the HeadroomTracker (W1-T4) — reused wholesale, never
 * reimplemented, wired into a PERSISTENT loop instead of a bounded one: where
 * drain.ts's `no_runnable` is a terminal stop, this loop PACES itself with an
 * injected clock and keeps polling — new work can land later (a plan edit
 * merges, a dependency's PR lands out of band), and being there when it does is
 * the entire point of a daemon.
 *
 * Blocks are no longer blunt stop-on-block (W1-T46, superseding v1): each
 * non-merged verdict is REASONED about via `block-reason.ts`'s
 * `reasonAboutBlock` — transient (retry, no strike), independent-failure (skip
 * only that task, flag it, keep draining everything else), or genuine blocker
 * (halt + escalate — never continue into the gap). See `runDaemon`, below.
 *
 * Single-instance + per-task locking (drain-lock.ts / inflight-lock.ts) are
 * real side effects the CLI wiring (run-task.ts) owns, exactly as `rmd drain`
 * already does — this pure module never touches the filesystem.
 */

import type { AutoTriageDecision, AutoTriageCensus } from "./auto-triage.js";
import type { RunResult } from "./run-result.js";
import { assertCleanBoot, type BootAssertion } from "./env.js";
import { INITIAL_RETRY_STATE, reasonAboutBlock, type RetryState } from "./block-reason.js";
import {
  nextRunnable,
  runnableCandidates,
  laneDispatchBudget,
  type MergedSet,
  type NextRunnableOpts,
  type OpenPrCheck,
  tallyDispatchFilters,
  type IdleReasonBucket,
  IDLE_REASON_ID_CAP,
} from "./drain.js";
// W1-T343 (ADOPT DRAIN'S LANE MACHINERY, NEVER A SECOND IMPLEMENTATION): the SAME pure
// overlap partition `runDrainLanes` (drain.ts) already composes with `runnableCandidates`/
// `laneDispatchBudget` above — reused here verbatim rather than re-derived.
import { partitionByFileOverlap, serializedLedgerPayload, settledSetPayload } from "./dispatch-overlap.js";
import { HEADROOM_LIMIT_PCT, RESET_UNKNOWN, UNREADABLE_DEGRADED_LIMIT } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
// W1-T372: TYPE ONLY (erased at build — no runtime edge added to daemon-health.ts, which
// already imports a VALUE from this module; a value import here would be a real cycle, a
// type-only one is not). See daemon-health.ts's `readGhRateLimitBuckets` for the reader this
// shape belongs to — this pure module never shells `gh` itself, exactly as it never touches
// the filesystem (this file's own header).
import type { GhRateLimitBuckets } from "./daemon-health.js";
import type { CostGovernorResult, QueueGovernorResult } from "./sweep.js";
// VALUE import (W1-T342's gate moved to its own pure module so drain.ts can share it — see that
// module's header for why neither daemon.ts nor sweep.ts could host it). Pure, no filesystem.
import { checkDispatchGovernors, type DispatchGovernorVerdict } from "./dispatch-governor.js";
import { assertRunnable, PlanError, type MergedResolver, type Plan, type Task } from "./plan.js";
import type { StatusProjection } from "./status.js";
// Type-only (erased at build, same discipline as StatusProjection above) — W1-T160's
// retro cadence trigger decision shape, defined once in retro.ts (evaluateRetroTrigger)
// and reused here so DaemonDeps.checkRetroTrigger/runRetroTrigger never re-declare it.
import type { RetroTriggerDecision } from "./retro.js";
// Type-only (erased at build) — this module stays a PURE module at RUNTIME
// (see the file header: "never touches the filesystem"); `OrphanSweepReport`
// only shapes the `sweepOrphanWorkers`/`sweepOrphans` injection points below,
// the same discipline `RunResult`/`StatusProjection` above already follow.
import type { OrphanSweepReport } from "./worker-containment.js";

/**
 * Reason the scheduler loop returned — every terminal state is one of these.
 *
 * `headroom_exhausted` is deliberately ABSENT: unlike `rmd drain` (a bounded
 * one-shot run, where headroom exhaustion is a terminal stop, see drain.ts's
 * own `StopReason`), the daemon is a PERSISTENT loop under launchd KeepAlive —
 * returning here at all ends the process, and KeepAlive relaunches it
 * (SuccessfulExit:false reads ANY exit, zero or not, as worth restarting on
 * this unit), so a headroom-exhausted reading used to restart-loop the daemon
 * roughly once per idle poll until the window reset. Headroom overage is now
 * an IN-PROCESS idle state handled inline in the loop below (same shape as
 * "nothing runnable"): it sleeps and re-polls via the injected clock, logging
 * a `daemon.headroom` heartbeat each tick, and never returns while still over
 * the limit.
 *
 * `paused` is ABSENT for exactly the same reason (the 2026-07-22 relaunch
 * storm): PAUSE is a drain-and-hold, an awaiting-resume state with a KNOWN
 * clearing condition (`rmd resume` deletes the flag) — returning it exited
 * the process nonzero, KeepAlive relaunched (~10s throttle), and the fresh
 * boot re-read the same flag and exited again, storming until bootout. A
 * paused daemon now idles IN-PROCESS (a `daemon.pause` heartbeat per tick,
 * re-polling the flag via the injected clock), so `rmd resume` takes effect
 * on the next tick of the SAME process — no relaunch involved.
 *
 * `stale` (W1-T126, DAEMON SELF-FRESHNESS) is the OPPOSITE polarity from
 * `headroom_exhausted`/`paused` above, deliberately: those two must never reach a
 * process exit (an awaiting-state relaunched by KeepAlive just re-reads the identical
 * condition and exits again — a storm). Staleness is not an awaiting-state; it is a
 * REQUEST to exit, because launchd's `KeepAlive{SuccessfulExit:false}` is the only
 * mechanism that can get a long-running daemon off code it loaded once at boot and
 * onto a fix merged since (the five-manual-cycles-in-a-weekend problem this task
 * fixes). So `stale` DOES reach {@link daemonExitCode} as a real stop reason, and maps
 * to a nonzero exit — see that function's doc.
 */
export type DaemonStopReason = "stopped" | "blocked" | "max_reached" | "error" | "stale";

/**
 * Default idle-poll pace: check back once a minute while nothing is runnable.
 *
 * W1-T253 (P37 CONSUMERS): every OTHER collected constant this task rewires reads its
 * default via `policy.ts`'s `loadDefaultPolicy` (a self-locating, memoized `readFileSync`).
 * THIS module cannot do that — see the file header: "this pure module never touches the
 * filesystem" (Rule 16's headless/live split; `runDaemon` must stay callable thousands of
 * times against an injected clock in a unit test with zero real I/O). So this literal
 * STAYS — it is the fs-free safety net for a direct/test caller that supplies no
 * `pollIntervalMs` at all — and the actual `rmd daemon` CLI entry (`daemonCommand`,
 * run-task.ts) is the one that loads `plan/policy.yaml`'s `pollIntervalMs` and threads it
 * into `DaemonOpts.pollIntervalMs` EXPLICITLY on every real invocation, so this constant is
 * provably dead for the operating path (test/policy-consumers.test.ts). Mirrors the
 * `buildDefaultHeadroomPolicy` curve just below, same reasoning.
 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * The pure stop-reason → process-exit-code mapping (operator ruling,
 * 2026-07-21: "VERIFY from source how DaemonStopReason reaches the process
 * exit today... the deliverable is the pure stop-reason-to-exit-code
 * mapping"). Extracted so it is unit-testable with NO process spawn (Rule
 * 18): `rmd daemon`'s CLI wiring (run-task.ts) calls this instead of inlining
 * the ternary, so the mapping a supervisor's restart decision depends on
 * lives in one place, provable without launchd.
 *
 * `stopped`/`max_reached` are the only exits meaning "this was deliberate,
 * nothing to see" ⇒ 0. Every other reason — `blocked`, `error`, and `stale`
 * (W1-T126) — is nonzero so a supervisor (or launchd's KeepAlive, W1-T12b)
 * restarts. `stale` WANTS exactly that restart (it is how a long-running
 * daemon gets off a stale boot sha and onto code merged since — see
 * `DaemonStopReason`'s doc), unlike `blocked`/`error`, which merely tolerate
 * it. This is exactly why neither headroom exhaustion NOR pause can be
 * allowed to reach this function as a `DaemonStopReason` at all (see that
 * type's doc, above): each would either wrongly map to 0 (silence —
 * permanently dead until a manual reload) or wrongly map to 1 (a relaunch
 * storm — ~86s for headroom, ~10s for the 2026-07-22 paused storm) — both
 * wrong, because an awaiting-state is neither a clean stop nor a crash. Both
 * are handled entirely inside the loop below instead, and never become
 * return values.
 */
export function daemonExitCode(stopReason: DaemonStopReason): number {
  return stopReason === "stopped" || stopReason === "max_reached" ? 0 : 1;
}

/**
 * One rung of the headroom ceiling's time-to-reset curve (operator ruling,
 * 2026-07-21, "ENCODE AS POLICY DATA, not code constants" — rule 2). Ordered
 * narrowest-`maxHoursToReset`-first; {@link resolveHeadroomLimitPct} picks the
 * first rung whose bound covers the observed hours-to-reset for a window.
 */
export interface HeadroomPolicyRule {
  /** This rung applies when hours-to-reset is <= this bound. */
  maxHoursToReset: number;
  /** The ceiling (percent used) that binds under this rung. */
  limitPct: number;
}

/** A time-to-reset → ceiling curve, DATA rather than a single constant. */
export type HeadroomPolicy = HeadroomPolicyRule[];

/**
 * DEFAULT policy (operator ruling, 2026-07-21, the fixture: on Monday
 * 2026-07-20 the fleet parked 22:22–00:00 EDT, 56 consecutive
 * `headroom_exhausted` stops over ~98 minutes, protecting 95%-exhausted
 * headroom that EXPIRED at the midnight reset regardless): inside the
 * window's FINAL DAY (<=24h to reset) the ceiling relaxes to 100% — nothing
 * is gained by refusing to spend headroom that is destroyed unused at reset;
 * every other day it holds at `holdLimitPct` (the operator reserve, default
 * {@link HEADROOM_LIMIT_PCT}). A caller supplies a wholly different curve via
 * `DaemonOpts.headroomPolicy` without touching this source (see
 * `resolveHeadroomLimitPct`).
 *
 * W1-T253 (P37 CONSUMERS): this curve mirrors `plan/policy.yaml`'s `headroom.curve` (which
 * this task's substrate, W1-T252, lifted FROM here) but stays a literal IN THIS FUNCTION —
 * see {@link DEFAULT_POLL_INTERVAL_MS}'s doc, immediately above, for why: this module never
 * touches the filesystem, and `loadDefaultPolicy` does. `daemonCommand` (run-task.ts) is the
 * real `rmd daemon` entry point; it loads the policy's curve and threads it in as
 * `DaemonOpts.headroomPolicy` on every real invocation, so a policy edit to the curve moves
 * the LIVE daemon with zero code change even though this literal stays put as the fs-free
 * fallback for a direct/test caller.
 */
export function buildDefaultHeadroomPolicy(holdLimitPct: number = HEADROOM_LIMIT_PCT): HeadroomPolicy {
  return [
    { maxHoursToReset: 24, limitPct: 100 },
    { maxHoursToReset: Infinity, limitPct: holdLimitPct },
  ];
}

/**
 * Resolve the ceiling that binds for a window `hoursToReset` away, under
 * `policy` (default {@link buildDefaultHeadroomPolicy}'s curve). `null`/
 * non-finite hours-to-reset (the reset text didn't parse, see
 * `parseResetInstant`) resolves to the LAST (widest) rung — uncertainty is
 * NEVER read as "we must be in the final day"; the ceiling only ever relaxes
 * on a CONFIRMED close reset, never on a parse failure.
 */
export function resolveHeadroomLimitPct(hoursToReset: number | null, policy: HeadroomPolicy = buildDefaultHeadroomPolicy()): number {
  // A reset already in the PAST is UPSTREAM LAG, not "the reset is imminent" — and a negative
  // `hoursToReset` would satisfy `<= 24` and select the LAXER rung. This clause makes that
  // impossible.
  //
  // HONEST SCOPE, because the comment that used to justify a number in this subsystem was itself
  // wrong and that is how the wrong number persisted: THIS IS HARDENING, NOT A LIVE BUG FIX. The
  // sole production caller (below, ~line 348) derives `hoursToReset` from
  // `parseResetInstant(w.resetsAt, now)` with the SAME `now`, and that function's contract is "the
  // nearest instant AT OR AFTER now" — every branch rolls forward (+24h / +1 year). Probed across
  // 20 shapes spanning both sides of `now`, it never returned a past instant, so today this branch
  // is unreachable and the change is behaviour-neutral.
  //
  // recon-FH reported 36 of 2368 `daemon.headroom` lines carrying a `resets_at` behind their own
  // `ts` and inferred the ceiling had been relaxed. That inference was WRONG: those lines are a
  // DISPLAY artifact — `resetsAtDisplay` is computed at `now` and written to a line stamped later —
  // and the ceiling never received a negative number.
  //
  // It is kept because the guarantee lives in a DIFFERENT function. Any future caller that computes
  // `hoursToReset` from a cached instant, or any relaxation of the roll-forward, would silently
  // reach the lax rung at the spending boundary. Past-dated and unknown-shaped are the same
  // epistemic state — we do not know when the reset is — so they take the same strict fallback.
  //
  // The +1-year roll in `parseResetInstant` is DELIBERATELY untouched: confusing to a reader, but it
  // selects the STRICTER rung, and fixing it properly needs a notion of window cadence this
  // function does not have.
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

/**
 * Best-effort parse of a free-form `/usage` `resets_at` string into an
 * absolute instant, resolved as the nearest instant AT OR AFTER `now` (a
 * window's `/usage`-reported reset is never already in the past). Returns
 * `null` when the text doesn't match a recognized `/usage` shape — callers
 * MUST treat `null` conservatively (never as "confirmed close"), never throw:
 * this is display/policy plumbing, not a fail-closed boundary in its own
 * right (the numeric percent check stays the real safety gate).
 *
 * Recognized shapes — every one actually observed from `/usage` (this task's
 * rationale + test/headroom.test.ts's WS0 fixture):
 *   `"<Mon> <D>, <H>(:<MM>)?(am|pm)"`     e.g. "Jul 14, 8:00pm"
 *   `"<Mon> <D> at <H>(:<MM>)?(am|pm)"`   e.g. "Jul 21 at 12am"
 *   `"<H>(:<MM>)?(am|pm)"`                e.g. "3pm"
 *   `"<weekday name or abbrev>"`          e.g. "Mon", "Monday"
 */
/** Ledger lines are read by humans and by rotation; a pathological upstream string must not be
 *  able to write an unbounded one. 200 chars is far longer than any observed reset clause. */
const UNRECOGNISED_RESET_MAX_LEN = 200;

/**
 * Every reset string a previous process already announced — the ledger-derived seed for
 * {@link DaemonDeps.priorUnrecognisedResets}. Mirrors `priorEscalatedAlertIds` /
 * `priorReconciledAlertFeedbackIds` exactly: the step this reads is the step the loop writes, so
 * the ledger is the store and no new state file exists. Exported for the caller that owns the
 * ledger read (run-task.ts) — daemon.ts itself never touches the filesystem.
 */
export function priorUnrecognisedResetStrings(lines: ReadonlyArray<Record<string, unknown>>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.step === "daemon.usage_reset_unrecognised" && typeof l.raw === "string") out.add(l.raw);
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
    if (candidate.getTime() < now.getTime()) candidate = new Date(candidate.getTime() + 24 * 3_600_000);
    return candidate;
  }

  const weekday = /^(sun(day)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?)$/i.exec(text);
  if (weekday) {
    const target = WEEKDAY_ABBRS.indexOf(text.slice(0, 3).toLowerCase());
    if (target === -1) return null;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    let deltaDays = (target - startOfToday.getDay() + 7) % 7;
    // A bare weekday matching TODAY, with no time of day given, is read as
    // NEXT week's occurrence, not "already underway" — the conservative
    // (larger hours-to-reset, never-relax-on-ambiguity) reading.
    if (deltaDays === 0) deltaDays = 7;
    return new Date(startOfToday.getTime() + deltaDays * 24 * 3_600_000);
  }

  return null;
}

/**
 * Round an instant to the nearest hour. `/usage` has been observed to phrase
 * the SAME intended reset moment two different ways a minute apart across
 * consecutive boots ("Jul 21 at 12am" vs "Jul 20 at 11:59pm" — this task's
 * SECOND, smaller defect) — sub-hour jitter like that has no operational
 * meaning for a 5-hour session window or a weekly cap, so rounding it away
 * is what makes {@link formatResetInstant} render the two identically.
 */
export function canonicalizeResetInstant(d: Date): Date {
  const hourMs = 3_600_000;
  return new Date(Math.round(d.getTime() / hourMs) * hourMs);
}

/**
 * Canonical, deterministic rendering of a resolved reset instant — a fixed
 * UTC ISO string, so the SAME underlying instant renders IDENTICALLY on
 * every boot no matter how `/usage`'s own free-form text happened to phrase
 * it (the defect above). Used for logging/display; the raw `/usage` string
 * (`UsageWindow.resetsAt`) is untouched everywhere else in the codebase.
 */
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

/**
 * The daemon's OWN per-window headroom resolution — deliberately NOT `headroom.ts`'s
 * exported `headroomExhausted` (still used unchanged by `rmd drain`, which stays on
 * the flat `HEADROOM_LIMIT_PCT` ceiling; a human-invoked bounded drain is not this
 * task's concern and touching it is out of scope). Applies the TIME-AWARE ceiling
 * (see {@link HeadroomPolicy}) PER WINDOW — each window's own hours-to-reset resolves
 * ITS OWN limit, since the 5-hour session window and a weekly cap reset on entirely
 * different clocks — and returns every window MOST-BURNED FIRST. The caller reads
 * `[0]` for the burn telemetry line and `.find(w => w.percentUsed >= w.limitPct)` for
 * the enforcement decision (the governor ON path), so both share ONE resolution.
 */
function resolveHeadroomWindows(
  snap: UsageSnapshot,
  now: Date,
  policy: HeadroomPolicy,
  /**
   * Called for state (b) ONLY — a reset clause was PRESENT and `parseResetInstant` did not
   * recognise it. Appended LAST and optional, so no existing caller shifts. The emission lives at
   * the CALL SITE (the daemon loop wires this to `log`) rather than inside `parseResetInstant`,
   * because that parser's purity is why it is testable across shapes and why it must not learn
   * about ledgers.
   */
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
      // THREE STATES, not two, and the ceiling treats the last two identically ON PURPOSE:
      //   (a) reset present and parseable  -> a real hoursToReset; the time-aware curve applies.
      //   (b) reset present but unparseable -> null (parseResetInstant's own contract).
      //   (c) reset ABSENT entirely         -> null, WITHOUT calling parseResetInstant at all.
      // `resolveHeadroomLimitPct(null, …)` returns the LAST (WIDEST) rung — the strict 95%
      // reserve — never the relaxed 100% final-day rung. Its own doc: "uncertainty is NEVER read
      // as 'we must be in the final day'; the ceiling only ever relaxes on a CONFIRMED close
      // reset." So a window whose reset we do not know is held to the STRICTER ceiling, which is
      // the fail-closed direction at the spending boundary. Absent is explicit here, not accidental.
      const instant = w.resetsAt !== undefined ? parseResetInstant(w.resetsAt, now) : null;
        // STATE (b) ONLY — present-but-unrecognised. State (c), an ABSENT clause, is the CLI's
        // normal shape for a weekly line and must never fire this: recon-FH measured 184 legitimate
        // "unknown" sentinels against 56 raw passthroughs, so emitting on every null would be
        // ignored within a day. The two are separable exactly HERE, because this is the last place
        // that still knows whether `resetsAt` was present at all — four lines down it collapses
        // into the RESET_UNKNOWN sentinel and the distinction is gone for good.
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

/** Default: escalate to the SAME in-process idle heartbeat as a confirmed
 * headroom breach after this many CONSECUTIVE unreadable `/usage` reads. A
 * single blip (or a handful) is a transient read failure, not evidence the
 * budget is exhausted — but an unreadable budget that dispatches FOREVER is
 * the fail-open polarity at the spending layer (the #157/#143-adjacent
 * cannot-observe-rendered-as-permissive family: the gateway returning `[]`,
 * W1-T181; the projection regressing to `queued`, W1-T179). Recon R-7 found
 * the real read is unavailable ~78% of the time in the live ledger, so an
 * unconditional fail-closed-on-first-miss would halt the fleet most of the
 * time — hence a BOUNDED allowance, not an immediate halt.
 *
 * W1-T290: this literal now RESOLVES TO, rather than merely matches, {@link
 * UNREADABLE_DEGRADED_LIMIT} (headroom.ts) — the drain's identical bounded-degraded
 * ceiling reads that SAME export, so the two consumers cannot drift apart the way two
 * independent `= 3` literals could. This name and this module's own default/override
 * option (`DaemonOpts.unreadableDegradedLimit`) are UNCHANGED — only where the number
 * comes from moved. */
export const DEFAULT_UNREADABLE_DEGRADED_LIMIT = UNREADABLE_DEGRADED_LIMIT;

export interface DaemonOpts {
  /**
   * Optional iteration cap (a bounded supervised run, or a test). Absent ⇒
   * unbounded — the real daemon runs until STOP, a block, or headroom.
   */
  max?: number;
  /** Idle-poll pace in ms when nothing is currently runnable (default {@link DEFAULT_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /**
   * The headroom governor switch (operator ruling fb-1784894405468-a4153e). When
   * false, headroom is still READ and LEDGERED every cycle (a `daemon.headroom`
   * telemetry line, `enforced: false`) but NEVER gates dispatch — no `percent_used`
   * condition idles the loop, and an unreadable read is absent telemetry, never a
   * hold. When true, the existing time-aware curve enforces unchanged (idle while
   * over, bounded degraded-mode on unreadable). Defaults to **true** here so the
   * library's long-standing behaviour and its tests are unchanged; the live
   * `rmd daemon` entry resolves the host posture from config/env via
   * {@link resolveHeadroomEnabled} — which, since the 2026-07-25 ruling, also
   * defaults **true**, so an unconfigured install and this library now agree — and
   * passes it explicitly. This host opts OUT via config `headroom.enabled: false`.
   */
  headroomEnabled?: boolean;
  /**
   * ≥ this % on any window, on a day the ceiling HOLDS ⇒ in-process idle
   * (default {@link HEADROOM_LIMIT_PCT}). Ignored when `headroomPolicy` is
   * also supplied — that curve wins outright. Threading this through still
   * builds a full {@link HeadroomPolicy} via {@link buildDefaultHeadroomPolicy}
   * (relax on the final day, hold at this value otherwise) rather than a flat
   * ceiling — see the TIME-AWARE design above.
   */
  headroomLimitPct?: number;
  /**
   * The time-to-reset → ceiling curve (POLICY DATA, rule 2) — supply a wholly
   * different curve here to retune the reserve WITHOUT a source change.
   * Default: {@link buildDefaultHeadroomPolicy} seeded from `headroomLimitPct`.
   */
  headroomPolicy?: HeadroomPolicy;
  /**
   * CONSECUTIVE unreadable `/usage` reads allowed before the daemon escalates
   * to the in-process idle heartbeat (default {@link DEFAULT_UNREADABLE_DEGRADED_LIMIT}).
   * A single successful read resets the count to zero.
   */
  unreadableDegradedLimit?: number;
  /**
   * W1-T113: the spawn-infra backoff ceiling in ms (default
   * {@link DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS}) — consecutive failures double
   * `pollIntervalMs` up to this cap. POLICY DATA (rule 2), retunable without a
   * source change.
   */
  maxSpawnInfraBackoffMs?: number;
  /**
   * W1-T343 (ADOPT DRAIN'S EXISTING LANE MACHINERY, NEVER A SECOND IMPLEMENTATION): the
   * width this tick's dispatch batch may hold — `SweepPolicy.dispatchLanes` (POLICY DATA,
   * rule 2; ONE threshold home, the same row `rmd drain` already reads), resolved by the
   * real command and threaded straight through, never re-derived here.
   *
   * SHIP DARK. Default 1 (also the floor — a value below 1 is clamped up to 1, never down
   * to 0). At 1 (or omitted), the tick below computes a dispatch set of AT MOST one task via
   * `runnableCandidates(plan, isMerged, 1, …)`, which returns the SAME task {@link
   * nextRunnable} would — see that function's own doc: both apply the identical
   * `isDispatchEligible` chain, in the identical `dispatchOrder` walk, stopping at the same
   * point — and a one-or-zero-element candidate list can never collide with itself under
   * `partitionByFileOverlap` (nothing is yet placed to overlap against). So this tick's
   * OBSERVABLE behaviour — which task dispatches, which callbacks fire, which ledger lines
   * are written — is BYTE-IDENTICAL to before this parameter existed. That equivalence is
   * the safety property that lets this merge before an operator has decided to run two; W1-
   * T344 owns raising the policy row that actually flips it.
   */
  laneCount?: number;
  /**
   * `SweepPolicy.wipLimit` (W1-T121) — threaded through ONLY to SIZE a `laneCount >= 2`
   * batch, via {@link laneDispatchBudget} (drain.ts), exactly as `runDrainLanes` already
   * does. Distinct from `DaemonDeps.checkQueueGovernor` above: that gate STOPS new dispatch
   * outright for the whole tick when at/over the ceiling (unchanged by this field); this is
   * the finer-grained "how many of `laneCount` lanes still fit under it right now" input —
   * without it a >=2-lane batch could admit more concurrent dispatches than the remaining
   * WIP headroom, overshooting the ceiling by up to `laneCount - 1` before the NEXT tick's
   * `checkQueueGovernor` catches it. Never consulted when `laneCount <= 1` (or
   * `deps.openPrCount` is omitted) — the single-lane tick's budget is `1`, unconditionally,
   * which is exactly what preserves the byte-identical property `laneCount`'s own doc above
   * states.
   */
  wipLimit?: number;
}

/**
 * W1-T126 (DAEMON SELF-FRESHNESS): the result of comparing THIS process's own boot sha
 * against origin/main. `stale` carries the sha pair so the caller — and the ledger line
 * this drives, `daemon_selfrestart_for_freshness` — names exactly what advanced, the same
 * way `checkServiceFreshness`'s `behind` field does in self-sync.ts (the shared PREDICATE
 * this sibling check reuses rather than duplicating; see `DaemonDeps.checkFreshness`).
 *
 * `installNeeded` (W1-T151, INSTALL FRESHNESS) is OPTIONAL — omitted/false behaves exactly
 * as before this field existed. `true` means the pull that produced `newSha` also changed
 * `package.json`/`package-lock.json` (or added a `workspaces` layout) relative to `oldSha`,
 * so `DaemonDeps.runInstall` runs BEFORE this loop stops for restart — never after — the
 * same install-then-restart ordering `serviceFreshnessGate`/`ensureInstallFresh` (run-task.ts)
 * apply at the operator's `rmd daemon`/`rmd serve` entry, so a stale `node_modules` never
 * survives into the freshly-restarted process either.
 */
export type DaemonFreshness =
  | { stale: false }
  | { stale: true; oldSha: string; newSha: string; installNeeded?: boolean };

/**
 * QUEUE STARVATION census (recon oper#queue-starvation-2026-08-03): the RECOVERABLE-class
 * subset of an idle tick's dispatch-filter tally — the classes that could clear on their own
 * (a human resolves the block, a dependency merges, a fresh owned PR appears) without the
 * plan itself ever changing, as opposed to `already-merged` (the plan is DONE) or
 * `verify-not-auto` (permanently needs a human, waiting never helps). `circuitBroken` is
 * reported separately from `blocked`/`unmetDeps` because `isDispatchEligible` ledgers it
 * through its own `onCircuitBreak` callback rather than `tallyDispatchFilters`'s
 * `DispatchFilterReason` union — see drain.ts's doc on that split.
 */
export interface StarvationCensus {
  circuitBroken: IdleReasonBucket;
  blocked: IdleReasonBucket;
  unmetDeps: IdleReasonBucket;
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
export interface DaemonDeps {
  /**
   * impl-FZ — re-read the plan from the SAME source the boot used, returning the fresh plan or
   * `null` when nothing changed. Optional: omitted ⇒ the plan stays frozen at boot, which is
   * exactly the pre-existing behaviour, so no existing caller changes.
   *
   * The dep owns CHANGE DETECTION because the cheap signal is caller-specific: the real wiring
   * compares `git rev-parse origin/main:plan` (a tree sha, ~8ms) and only pays the ~60ms
   * `loadPlan` parse when that sha actually moved. Returning `null` on the unchanged path is what
   * keeps a 60-second poll from re-parsing a ~1MB monolith plus 45 shards for nothing.
   */
  reloadPlan?: () => Plan | null;
  /** Fresh merged predicate each call (re-derived from GitHub between iterations). */
  refreshMerged: () => MergedSet;
  /**
   * The in-flight guard (W1-T80, the #143/#145 duplicate-build race): the OPEN
   * PR number for a task, re-derived from the SAME projection `refreshMerged`
   * just built (never a second GitHub read path). Optional — omitted,
   * dispatch behaves exactly as before this guard existed.
   */
  isOpenPr?: OpenPrCheck;
  /**
   * W1-T177 (TERMINAL-STATE CHECK AT EVERY SPENDING SITE): an OPTIONAL fresh,
   * live re-read of ONE candidate in-flight PR's GitHub state, consulted ONLY
   * when `isOpenPr` reports a task in-flight — see drain.ts's
   * `NextRunnableOpts.readLiveState` for the full contract. Optional —
   * omitted, dispatch behaves exactly as before this check existed.
   */
  readLiveState?: (taskId: string, prNumber: number) => string | undefined;
  /**
   * The per-task dispatch CIRCUIT BREAKER (MASTER-PLAN P29(ii)): true when a
   * task has been dispatched the policy-capped number of times with no new
   * owned PR since (status.ts's `isDispatchBreakerTripped`, re-derived from the
   * ledger each call — persists across daemon restarts, unlike this loop's own
   * in-memory `next.status = "blocked"` flip below). Optional — omitted,
   * dispatch behaves exactly as before this breaker existed.
   */
  isCircuitTripped?: (taskId: string) => boolean;
  /**
   * WHAT THE BREAKER SAW for a task, supplied by the SAME memoised evaluation the
   * `isCircuitTripped`/`isIndeterminate` predicates answered from (run-task.ts's
   * `breakerGateFor().detailFor`) — never a second call to the predicate. Spread onto the
   * `dispatch.circuit_broken` / `dispatch.indeterminate` rows so a refusal records the count,
   * the bound and WHICH of the three outcomes was reached, instead of only that it fired.
   * Optional: a caller that omits it logs exactly the bare rows it logged before.
   */
  breakerDetail?: (taskId: string) => Record<string, unknown> | undefined;
  /**
   * Called once per task whose circuit breaker trips this tick — the real
   * command escalates ONE (deduped) needs-human issue naming the loop, mirroring
   * `escalateBlock` below.
   */
  onCircuitBreak?: (task: Task) => void;
  /**
   * W1-T316 (wiring W1-T271's own predicate): THE LIFETIME DISPATCH CAP (status.ts's
   * `isLifetimeDispatchCapExceeded`, ledger-derived — `run.start` lines counted across the
   * task's WHOLE history, never reset by a `pr.opened` line, unlike `isCircuitTripped`'s own
   * count). Optional — omitted, dispatch behaves exactly as before this cap existed.
   */
  isLifetimeCapExceeded?: (taskId: string) => boolean;
  /**
   * Called once per task excluded because its lifetime dispatch cap is exceeded — mirrors
   * `onCircuitBreak`'s legibility contract, so this exclusion is never a silent skip.
   */
  onLifetimeCapExceeded?: (task: Task) => void;
  /**
   * W1-T317 (wiring `checkCostGovernor`, sweep.ts): THE DAILY COST CEILING, re-derived from the
   * ledger each call — same freshness contract as `isCircuitTripped`/`isLifetimeCapExceeded`
   * above. UNLIKE those, this is NOT task-specific — one answer per tick, never keyed by taskId
   * — so it is consulted directly in the loop below, alongside `readUsage`'s headroom block,
   * rather than threaded through `nextRunnable`'s per-task chain. A defined return means "defer
   * — do not open a new run this tick", carrying the observed day-cost/ceiling that produced it;
   * `undefined` means proceed normally. UNLIKE drain.ts's bounded pass (which stops outright on
   * a deferral), this daemon is PERSISTENT: a deferral is an in-process idle heartbeat, the same
   * shape headroom's own `enforcingIdle` branch already uses, so the loop resumes on its own once
   * the observed day-cost drops back under the ceiling (spend ages out of the window, or the UTC
   * calendar day rolls over). The real wiring (run-task.ts) also LEDGERS the deferral itself
   * (`logCostGovernorDeferral`) before returning, so this loop never needs `ledgerPath`/`runId`
   * to report it. Optional — omitted, dispatch behaves exactly as before this governor existed.
   * Never consulted from `deps.sweep`/`deps.sweepLight` — drainage of already-open PRs is a
   * separate code path this predicate is never wired into (see `checkCostGovernor`'s own doc:
   * "stranding in-flight work to save money is a worse failure than the spend itself").
   *
   * W1-T342: consulted a SECOND time — immediately before the actual dispatch (`runOne` below),
   * not only here at the top of the tick — via `checkDispatchGovernors`, which wraps this call
   * (and `checkQueueGovernor`'s) in a try/catch: a throw is now treated as a deferral (`kind:
   * "unreadable"`), never left to propagate and crash the loop the way a bare call used to. See
   * `checkDispatchGovernors`'s own doc for why a SECOND, freshly-taken reading matters once a
   * batch can hold more than one lane (W1-T343): a reading taken before lane 1 was admitted
   * cannot see lane 1's own (still in-flight, not yet ledgered) spend, so lane 2 needs its own
   * call, never lane 1's cached verdict.
   */
  checkCostGovernor?: (dailyCostCeilingUsd?: number) => CostGovernorResult | undefined;
  /**
   * W1-T331 (closing the gap W1-T330's policy row alone left open): re-reads the SAME
   * repoRoot-scoped `plan/policy.yaml` `sweep.dailyCostCeilingUsd` row `reloadPlan` (above) reads
   * for the plan, returning the LIVE figure. Mirrors `reloadPlan`'s EXACT placement/contract in
   * the loop below — called once, at the TOP of the tick, before any dispatch decision, so
   * everything else in this tick sees ONE consistent ceiling and a file changing mid-tick cannot
   * produce two different answers within the same tick (the same argument `reloadPlan`'s own doc
   * gives, reused rather than re-derived). Optional — omitted, `checkCostGovernor` is consulted
   * with `undefined` and resolves its own (frozen-at-import) default exactly as before this task.
   *
   * A throw here is caught by the loop, never here, and — UNLIKE `reloadPlan`, whose failure
   * just keeps the plan the loop already has — the loop holds the LAST KNOWN-GOOD ceiling rather
   * than discarding it to `undefined`: this value flows straight into `checkCostGovernor` above,
   * and `undefined` there reads as "no override, fall back to the shipped default," which could
   * SILENTLY WIDEN an operator-tightened live ceiling back to the frozen default the moment one
   * read glitches (a transient `plan/policy.yaml` read failure must never look like permission to
   * spend more, mirroring `reloadPlan`'s "degrade to what we already had, never fail open").
   */
  reloadDailyCostCeilingUsd?: () => number;
  /**
   * W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): THE WIP
   * CEILING, re-derived from the current open-PR count each call — same freshness contract as
   * `checkCostGovernor` immediately above. UNLIKE `isCircuitTripped`/`isLifetimeCapExceeded`, this
   * is NOT task-specific — one answer per tick — so it is consulted directly in the loop below,
   * alongside `checkCostGovernor`, rather than threaded through `nextRunnable`'s per-task chain. A
   * defined return means "defer — do not open a new run this tick", carrying the observed open
   * count/limit that produced it; `undefined` means proceed normally. UNLIKE drain.ts's bounded
   * pass (which stops outright on a deferral), this daemon is PERSISTENT: a deferral is an
   * in-process idle heartbeat, the same shape `checkCostGovernor`'s own branch just above already
   * uses, so the loop resumes on its own once the observed open count drops back under the limit
   * (a PR merges/closes elsewhere). The real wiring (run-task.ts) also LEDGERS the deferral itself
   * (`logQueueGovernorDeferral`) before returning, so this loop never needs `ledgerPath`/`runId` to
   * report it. Optional — omitted, dispatch behaves exactly as before this governor existed. Never
   * consulted from `deps.sweep`/`deps.sweepLight` — drainage of already-open PRs is a separate code
   * path this predicate is never wired into (see `checkQueueGovernor`'s own asymmetry note).
   *
   * W1-T342: see `checkCostGovernor`'s own W1-T342 paragraph immediately above — this predicate
   * is wrapped by the SAME `checkDispatchGovernors` seam, consulted a second time immediately
   * before dispatch, and fails closed on a throw exactly the same way.
   */
  checkQueueGovernor?: () => QueueGovernorResult | undefined;
  /**
   * W1-T119: true when a task's own GitHub read is INDETERMINATE (a genuine
   * read failure — rate-limited, network error, auth failure — rather than a
   * clean "no evidence"), re-derived from the SAME projection `refreshMerged`
   * just built. Optional — omitted, dispatch behaves exactly as before this
   * guard existed.
   */
  isIndeterminate?: (taskId: string) => boolean;
  /** Called once per task excluded because its own read is indeterminate. */
  onIndeterminate?: (task: Task) => void;
  /** Run ONE task through the existing run-task path (default = runTask). */
  runOne: (taskId: string) => Promise<RunResult>;
  /**
   * W1-T343: `laneDispatchBudget`'s other input (alongside `DaemonOpts.wipLimit`) — the
   * SAME `openPrCount` closure the real wiring already builds for `checkQueueGovernor`
   * (run-task.ts), never a second GitHub read path. Consulted ONLY when `laneCount >= 2`,
   * to size that batch exactly as `runDrainLanes` (drain.ts) already does. Optional —
   * omitted, a >=2-lane batch is bounded by `laneCount` alone (unbounded by the governor),
   * the same "un-wired site behaves as before" contract every optional guard here carries.
   */
  openPrCount?: () => number;
  /** Read current /usage; `undefined` ⇒ unavailable (headroom check is skipped). */
  readUsage?: () => UsageSnapshot | undefined;
  /**
   * Reset strings ALREADY reported by a previous process, read back off the ledger by whoever
   * builds these deps (run-task.ts). THE LEDGER IS THE DEDUP — the same idiom
   * `priorEscalatedAlertIds` and `priorReconciledAlertFeedbackIds` already use: a step written once
   * and read back as the key, never a new state file. Seeding from it is what makes the
   * once-per-string bound survive a restart; without it a daemon that reboots hourly would
   * re-announce the same string on every boot.
   */
  priorUnrecognisedResets?: ReadonlySet<string>;
  /**
   * P34 clause (c), W1-T249: called when a window first crosses the operator
   * reserve (a CONFIRMED, readable breach — never on the unreadable/degraded
   * path, which has its own bounded-allowance handling above). Fires AT MOST
   * ONCE per breach episode — the SAME "dedup while the condition holds, reset
   * once it clears" discipline `onCircuitBreak`'s caller applies, so a
   * sustained breach does not open a fresh notification every poll — and
   * dispatch is ALREADY paused (the in-process idle heartbeat this same check
   * drives) by the time this fires, so the hook is a pure notification, never
   * a dispatch decision itself. The real command wires escalate.ts's
   * `escalate()` (HARD_STOP class — "spend beyond cap" is exactly this
   * clause's shape on a subscription) naming the offending window/percent/
   * reset, with its OWN cross-boot ledger dedup keyed on `resetsAt` (mirroring
   * `escalateCircuitBreak`'s durable dedup, since this in-process flag alone
   * resets to empty on every daemon restart). Wrapped in the caller's own
   * try/catch (same discipline as `onCircuitBreak`/`onSpawnInfraBlocked`) so a
   * failed notification costs one logged line, never the daemon's liveness.
   * Optional — omitted, the breach still pauses dispatch exactly as before
   * this hook existed, it just opens no issue.
   */
  onHeadroomBreach?: (info: {
    window: string;
    percentUsed: number;
    limitPct: number;
    resetsAt: string;
  }) => void | Promise<void>;
  /**
   * W1-T372: `gh api rate_limit`'s REST/core and GraphQL buckets, read fresh each tick —
   * `undefined` per bucket (or the whole call returning `{}`) means unreadable, never rendered
   * as an exhaustion (the same fail-soft-never-fabricated contract `readUsage` above already
   * carries). Consulted on the SAME per-tick cadence as `readUsage`'s headroom block,
   * immediately after it in `runDaemon` below — never a second cadence, and this is the ONLY
   * daemon-tick read of either bucket, so no second `gh api rate_limit` call is ever made per
   * tick. Optional — omitted, the quota tick is skipped exactly as `readUsage` omitted skips
   * the headroom block.
   */
  readGhQuota?: () => GhRateLimitBuckets;
  /**
   * W1-T372: called AT MOST ONCE per bucket per exhaustion episode, on the tick a bucket's OWN
   * `remaining` first crosses from having budget to having none — never on a bare
   * `remaining === 0` VALUE check, which would re-fire on every tick for up to an hour until
   * the bucket resets (see `runDaemon`'s own per-bucket latch, mirroring `onHeadroomBreach`'s
   * `headroomReserveEscalated` discipline exactly, just keyed per bucket so a core exhaustion
   * and a GraphQL exhaustion in the same hour never suppress each other).
   *
   * UNLIKE `onHeadroomBreach`, this hook never pauses or idles dispatch — W1-T372 OBSERVES and
   * SURFACES a quota exhaustion, it does not govern one; no `continue` is taken on its account.
   * The real command wires escalate.ts's `escalate()` naming the bucket, with its OWN
   * cross-boot ledger dedup keyed on (bucket, resetsAt) — mirroring `escalateHeadroomReserve`'s
   * durable dedup, since this in-process latch alone resets to empty on every daemon restart.
   * Wrapped in the caller's own try/catch (same discipline as `onHeadroomBreach`/
   * `onCircuitBreak`) so a failed notification costs one logged line, never the daemon's
   * liveness. Optional — omitted, the exhaustion is still visible via the `daemon.quota` line
   * logged every tick a read succeeds, it just opens no issue.
   */
  onQuotaExhausted?: (info: { bucket: "core" | "graphql"; remaining: number; resetsAt: string }) => void | Promise<void>;
  /**
   * QUEUE STARVATION (recon oper#queue-starvation-2026-08-03): called on an idle tick whose
   * dispatch-filter census names at least one RECOVERABLE-class blocker — see {@link
   * StarvationCensus} and the predicate right above where this fires in the idle rung. Fires
   * AT MOST ONCE per starvation episode (the SAME "dedup while the condition holds, reset once
   * a dispatchable task ends it" discipline `onHeadroomBreach`/`onCircuitBreak` already apply),
   * and dispatch is already idle by the time this fires, so the hook is a pure notification,
   * never a dispatch decision. The real command wires escalate.ts's `escalate()` (via
   * run-task.ts's `escalateStarvation`) naming the census, with its OWN cross-boot ledger dedup
   * (mirroring `escalateCircuitBreak`'s durable dedup, since this in-process bound alone resets
   * to empty on every daemon restart — see `daemon.ts`'s `starvationEscalated`). Wrapped in the
   * caller's own try/catch (same discipline as `onCircuitBreak`/`onHeadroomBreach`) so a failed
   * notification costs one logged line, never the daemon's liveness. Optional — omitted, the
   * daemon still idles exactly as before this hook existed, it just opens no issue.
   */
  onStarvation?: (census: StarvationCensus) => void | Promise<void>;
  /**
   * Fleet control (W1-T11, MASTER-PLAN §4A/§4B): a defined return ⇒ a hard STOP
   * is in effect, and the string is the ledger/summary detail. Checked FIRST,
   * every tick — before PAUSE, headroom, or picking the next task — so it takes
   * precedence over PAUSE and wins the race if both flags are set.
   */
  checkStop?: () => string | undefined;
  /**
   * Fleet control (W1-T11): a defined return ⇒ a graceful PAUSE (drain-and-hold)
   * is in effect. Checked between iterations only — AFTER the current `runOne`
   * has resolved — so an in-flight task always runs to full completion (verdict
   * + merge) before a pause is honoured; no new spawn follows.
   */
  checkPause?: () => string | undefined;
  /**
   * W1-T126 (DAEMON SELF-FRESHNESS, filed from #271 holding-note item 7 — five manual
   * pull-and-reload cycles in a single weekend, because every merged pipeline fix was
   * invisible to the already-running daemon until a human noticed and cycled it by
   * hand). An OPTIONAL check, consulted once per tick with the SAME "between iterations
   * only" discipline as `checkStop`/`checkPause` immediately above — so it can NEVER
   * interrupt a `runOne` already in flight; in-flight work always reaches its verdict +
   * merge first (the identical drain-and-hold guarantee those two rely on).
   *
   * `{ stale: false }` ⇒ this process's own boot sha is caught up with origin/main, no
   * action. `{ stale: true, oldSha, newSha }` ⇒ origin/main has advanced past it: the
   * loop stops with {@link DaemonStopReason} `"stale"` — a deliberate NONZERO exit (see
   * that type's doc for why this is the opposite polarity from headroom/pause) so
   * launchd's `KeepAlive{SuccessfulExit:false}` relaunches into the fresh code — and
   * ledgers `daemon_selfrestart_for_freshness` (never a bare generic stop line), so an
   * intentional self-restart is provably distinguishable from a crash under the
   * identical "any exit relaunches" semantics (see the BOOT-RATE INVARIANT doc above —
   * a crash-loop reader keys off THIS marker, not the raw exit code, to tell the two
   * apart).
   *
   * This module stays PURE (see the file header: never touches git or the filesystem)
   * — the real command wires this to self-sync.ts's shared `checkServiceFreshness`
   * PREDICATE (the W1-T79/W1-T255 sibling this design explicitly reuses rather than
   * duplicating) evaluated against the sha recorded at THIS process's own boot, and
   * performs the actual `git merge --ff-only origin/main` pull as part of producing a
   * `stale` read — by the time this loop acts on it, the working tree is already at
   * `newSha`, so the freshly-relaunched process boots straight into it. Optional:
   * omitted ⇒ the loop never self-restarts for staleness, behavior unchanged from
   * before this check existed.
   */
  checkFreshness?: () => DaemonFreshness;
  /**
   * W1-T151 (INSTALL FRESHNESS). Consulted ONLY when `checkFreshness()` reports
   * `{ stale: true, installNeeded: true }` — runs BEFORE the loop stops for restart
   * (never after), so the process launchd relaunches into `newSha` also inherits a
   * `node_modules` that actually matches it, closing the same staleness class
   * {@link ensureInstallFresh} (run-task.ts) closes at the operator's `rmd daemon`/
   * `rmd serve` entry. This module stays PURE — the real command wires this to
   * `ensureInstallFresh(repoRoot)`'s real `npm ci`. Optional: omitted (or
   * `installNeeded` false/absent) ⇒ never called, behavior unchanged from before
   * this hook existed.
   */
  runInstall?: () => void;
  /**
   * CONSOLE WRITE-ACTIONS (fb-1784988460437-9daa9b). PEEK the pending "Run this
   * queued task now" kick markers, oldest-first — PURE injection, no fs here (the
   * real command wires `pendingKicks(root)` from fleet-control.ts). The daemon
   * gates each through {@link assertRunnable} + the merged projection and clears it
   * with {@link DaemonDeps.clearKick} as it dispatches or refuses it, so a runnable
   * kick it can't service this cycle survives to the next.
   */
  pendingKicks?: () => Array<{ taskId: string; origin: string }>;
  /** Delete one kick marker (consumed-once) after the daemon dispatches or refuses it. */
  clearKick?: (taskId: string) => void;
  /**
   * READ + DELETE the "Drain now" marker (consumed-once); a defined return ⇒ the
   * operator asked for one immediate dispatch cycle. Ledgered `console.drain_consumed`.
   */
  consumeDrainNow?: () => { origin: string } | null;
  /**
   * The INJECTED CLOCK: paces idle polling when nothing is runnable yet. The
   * real command wires a real `setTimeout`-backed sleep; tests inject a fake
   * that resolves immediately (or counts calls) so the loop is provable without
   * a real wall-clock wait and without an actual overnight run.
   */
  sleep: (ms: number) => Promise<void>;
  /**
   * THE INJECTED WALL CLOCK (distinct from `sleep`'s pacing clock): read once
   * per headroom check to resolve each window's hours-to-reset against the
   * TIME-AWARE ceiling (see `HeadroomPolicy`). Optional — the real command
   * wires `() => new Date()`; omitted, defaults the same way, so existing
   * callers are unaffected. Tests inject a fake that a `sleep` fake can
   * advance, so "resumes once the window's own reset passes" is provable
   * without a real wall-clock wait.
   */
  now?: () => Date;
  /** One ledger line per tick/task/terminal reason (reuses run-task's ledger). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /**
   * The level-triggered PR-pipeline reconciler (W1-T77, ratifies P22 core): the
   * SAME `runSweep` entry point `rmd sweep` invokes, wired here so it runs once
   * per poll iteration — every open PR is re-derived to a disposition and its
   * gated action taken, deduped for idempotence. Optional: omitted ⇒ the loop
   * behaves exactly as before the reconciler existed. Best-effort by contract
   * (the real wiring swallows its own errors) so a sweep hiccup never halts the
   * scheduler. Called alongside dispatch, NOT a replacement for it.
   */
  sweep?: () => Promise<void> | void;
  /**
   * W1-T117 orphan sweep (design part ii): the SAME `sweepOrphanWorkers`
   * entry point (worker-containment.ts) `daemonBoot`'s own
   * `sweepOrphanWorkers` param below runs once at boot, wired here so it
   * ALSO runs once per poll iteration — a stray from a run that ended
   * between polls (rather than only at the last boot) is still found within
   * one cycle. Optional: omitted ⇒ the loop behaves exactly as before this
   * sweep existed. Best-effort by the same contract as `sweep` above (own
   * try/catch, logged, never halts the loop).
   */
  sweepOrphans?: () => Promise<OrphanSweepReport> | OrphanSweepReport;
  /**
   * W1-T160: evaluate the retro cadence trigger this tick — fires on
   * merges-since-marker >= N OR days-since-marker >= D (policy data),
   * whichever crosses first (retro.ts's `evaluateRetroTrigger`, the pure
   * predicate this wraps against the real marker/ledger/GitHub read). Returns
   * `undefined` when there is nothing safe to evaluate this tick (a corrupt
   * marker, a degraded GitHub read) or a decision with `fire: false` — both
   * mean "do not fire this tick"; the loop only acts on `fire: true`.
   * Optional: omitted ⇒ the loop behaves exactly as before this feature
   * existed (the retro stays operator-run only).
   */
  checkRetroTrigger?: () => RetroTriggerDecision | undefined;
  /**
   * W1-T160: run the automated retro once `checkRetroTrigger` fires. The real
   * wiring (run-task.ts's `daemonCommand`) threads the fired decision's
   * `mergesSinceMarker` into `retroCommand`'s `opts.automated` so the
   * INTEGRITY GATE (retro.ts's `checkRetroIntegrity`) can compare it against
   * the real gather's credited count and abort loudly (never write) on a
   * mismatch. Best-effort like `sweep`/`sweepOrphans` above — a throw here
   * costs one logged tick, never the daemon's life. Never called unless
   * `checkRetroTrigger` fires.
   */
  runRetroTrigger?: (decision: Extract<RetroTriggerDecision, { fire: true }>) => Promise<void>;
  /** impl-DJ: the auto-triage rung's decision hook — same injected shape as checkRetroTrigger, so
   *  the whole rung is unit-testable without a clock, a filesystem or a spend. W1-T318: the caller
   *  (below, in this file's idle branch) passes the runnable-depth census it already computed for
   *  `daemon.idle_reasons`/starvation this same tick — a hook that ignores the argument (every
   *  test predating the curve) still typechecks and behaves exactly as before. */
  checkAutoTriage?: (census?: AutoTriageCensus) => AutoTriageDecision;
  /** impl-DJ: run ONE triage for the decided entry. Awaited under the light-sweep ticker. */
  runAutoTriage?: (feedbackId: string) => Promise<void>;
  /**
   * W1-T300 (the #1184/#1185 duplicate-triage race): the auto-triage rung's OWN in-flight guard,
   * symmetric with `isOpenPr` above but keyed on FEEDBACK id rather than task id — a feedback
   * entry's `status` only advances when its triage PR MERGES (a committed file under
   * plan/feedback/), so between dispatch and merge `newFeedbackIdsOldestFirst` keeps returning the
   * same head and a slow CI round re-fires the identical entry. Returns the OPEN PR number that
   * already carries this id's `origin: feedback#<id>` provenance, or `undefined` when none is
   * open. Optional — omitted, auto-triage dispatch behaves exactly as before this guard existed.
   */
  isFeedbackOpenPr?: (feedbackId: string) => number | undefined;
  /**
   * W1-T300, mirroring `readLiveState`'s W1-T177 contract exactly: an OPTIONAL fresh, live re-read
   * of ONE candidate in-flight triage PR's GitHub state, consulted ONLY when `isFeedbackOpenPr`
   * reports one open — so a merged-or-closed-but-cached PR can never park a feedback entry
   * forever. `undefined` (unreadable/indeterminate) fails OPEN, same as the task lane. Optional —
   * omitted, dispatch behaves exactly as before this check existed.
   */
  readFeedbackLiveState?: (feedbackId: string, prNumber: number) => string | undefined;
  /**
   * W1-T254 (the #707 fix) — the RESTRICTED LIGHT-SWEEP TICKER: `runOne` is
   * UNBOUNDED (a task can hold the daemon inside one call for a whole
   * session), and `deps.sweep` above only runs BETWEEN iterations — so a PR
   * that goes green-but-review-absent after the last full sweep sat
   * invisible for runOne's entire remaining duration (#707: swept 13:12,
   * entered `runOne`, never swept the new head again for the whole window —
   * unbounded latency, total invisibility until a manual `rmd review`).
   * When supplied, this ticks on the SAME injected clock as idle polling
   * (`pollIntervalMs` cadence, via `deps.sleep`) WHILE `runOne` is in
   * flight, and is cleared once `runOne` settles (resolved or thrown) —
   * never left running past it, never aborted mid-call either (a call
   * already in flight when `runOne` settles is allowed to finish). The real
   * wiring passes the SAME `runSweep` entry point as `sweep`, but restricted
   * via `SweepDeps.actionable` to ONLY the deterministic, sha-pinned,
   * mutex-serialized post-review re-post — every other lane
   * (dispatchFix/close/escalate/depReview/arm) must stay strictly
   * single-threaded, so it never runs from here. Own try/catch, like `sweep`
   * above (`daemon.sweep_light.failed`) — a ticker hiccup costs one logged
   * tick, never the daemon's liveness. Optional: omitted ⇒ the loop behaves
   * exactly as before this ticker existed.
   */
  sweepLight?: () => Promise<void> | void;
  /**
   * W1-T46 block-reasoning: called exactly once, when a block classifies
   * GENUINE BLOCKER (`reasonAboutBlock` in block-reason.ts — one or more
   * tasks transitively depend on the blocked task). The real command wires
   * escalate.ts's `escalate()` (BLOCKED class, W1-T8's GitHub-issue
   * taxonomy) naming the dependents; tests inject a fake collecting the call.
   * Optional — omitted, a genuine blocker still HALTS the loop (never
   * silently continues), it just has no issue opened.
   */
  escalateBlock?: (info: { task: Task; result: RunResult; dependents: string[] }) => void | Promise<void>;
  /**
   * W1-T174 (drain/sweep PARITY): called for a FIXABLE genuine blocker
   * (`reasonAboutBlock`'s `fixable_blocker` disposition — one or more
   * dependents, but the verdict names actionable evidence, see block-
   * reason.ts's `verdictIsFixable`) BEFORE any halt+escalate. The real
   * command wires this to the SAME W1-T76 fix rung the W1-T77 sweep already
   * dispatches (`routeFix`/`dispatchFix` in run-task.ts), driven against
   * the task's own open PR. Optional — omitted (or once `reasonAboutBlock`'s
   * own strike bound is exhausted), a fixable block falls through to the
   * SAME `escalateBlock` halt a genuine blocker always got: the daemon
   * never silently stalls on a fixable block it has no rung wired to act on.
   */
  dispatchFix?: (info: { task: Task; result: RunResult; dependents: string[] }) => void | Promise<void>;
  /**
   * W1-T113 part (iii), DEGRADE DON'T DIE (the vanished-binary incident): called
   * AT MOST ONCE per distinct `reason` for the life of this daemon run — never
   * once per poll tick, never once per task — when `runOne` throws a spawn-
   * INFRASTRUCTURE error (worker.ts's `ClaudeToolchainBlockedError`, detected
   * duck-typed via `reasonClass === "blocked_toolchain"`, never an
   * `instanceof` import — this module stays decoupled from worker.ts). The
   * real command wires escalate.ts's `tryEscalate` (BLOCKED class, content-
   * keyed by `reason` — the W1-T104 discipline: an already-open toolchain
   * issue for the SAME cause suppresses a repeat) naming every searched path.
   * Optional — omitted, the loop still survives and backs off, it just opens
   * no issue.
   */
  onSpawnInfraBlocked?: (info: { task: Task; reason: string }) => void | Promise<void>;
}

/**
 * Duck-typed classifier for a spawn-INFRASTRUCTURE failure (W1-T113: worker.ts's
 * `ClaudeToolchainBlockedError`, the vanished-binary class) — checked by a plain
 * string tag rather than `instanceof` so this module never imports worker.ts as
 * a value (it stays a PURE module, per this file's header: no fs, no exec, and
 * now no runtime dependency on the spawn layer either). Any OTHER throw from
 * `runOne` is still a genuine, unclassified error — this daemon must not learn
 * to swallow every possible crash, only the one named infrastructure class.
 */
function isSpawnInfraBlocked(err: unknown): err is { reasonClass: "blocked_toolchain"; message: string } {
  return typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";
}

/**
 * W1-T276: wraps a fired retro's `runRetroTrigger` call with the SAME
 * restricted light-sweep ticker `runOne` already uses (W1-T254, lines
 * ~1441-1462 below) — a fired retro is a bare, unbounded await too, and
 * without a ticker of its own the whole sweep goes dark for the retro's
 * entire duration (MEASURED over the live ledger: 22.0 and 21.0 minutes
 * across the two firings to date, zero sweep dispositions in either
 * window — the daemon looked healthy throughout because it WAS healthy;
 * it was simply busy). Same clock (`deps.sleep` on `pollIntervalMs`), same
 * `stopTicker` discipline: cleared on every exit path (`run` resolves OR
 * throws, via `finally`), and a `sweepLight()` call already in flight when
 * `run` settles is allowed to finish rather than aborted. Only the
 * RESTRICTED light sweep (`deps.sweepLight`) is ticked here, never full
 * dispatch — the retro itself already spends a real, budget-costing
 * Architect run, and a ticker that dispatches would turn one concurrent
 * spend into two. A `sweepLight` throw is caught and ledgered
 * (`daemon.sweep_light.failed`), never propagated — a ticker hiccup costs
 * one logged tick, never the retro's own outcome.
 */
async function sweepLightDuringRetro(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  run: () => Promise<void>,
): Promise<void> {
  const ticker = startInFlightTicker(deps, pollIntervalMs, log, "retro");
  try {
    await run();
  } finally {
    await ticker.stop();
  }
}

/**
 * THE IN-FLIGHT TICKER — the one thing that runs while the daemon is blocked on
 * unbounded awaited work, and the ONLY writer of `daemon.alive`.
 *
 * WHY IT EMITS A LIVENESS ROW AND NOT MERELY A SWEEP. Every other `daemon.`-prefixed
 * step is written when a tick CLOSES, so before this row existed "the daemon is alive"
 * and "the daemon finished something recently" were ONE signal, and a daemon inside a
 * long dispatch was byte-identical to a dead one. That is this repo's own
 * cannot-observe-is-not-a-no distinction arriving as BUSY versus DEAD. MEASURED over the
 * unioned ledger (live + all 666 gzipped rotations, 898 `daemon.iteration` rows): the
 * window from a dispatch to the next `daemon.`-prefixed row has p50 2.4m, p75 21.2m,
 * p90 39.5m, p95 52.5m. So 36.5% of all dispatches exceeded `fleet-heartbeat.sh`'s
 * 600s staleness threshold and 15.9% exceeded the console's 30-minute
 * {@link DEFAULT_LIVENESS_BOUND_MS} — both reporting a working fleet as stale or dead.
 *
 * WHY `daemon.`-PREFIXED, AND WHY THAT IS THE WHOLE FIX. Both liveness readers select on
 * the PREFIX, not on a step name: `deriveLastPoll` (daemon-health.ts) takes the max `ts`
 * over `step.startsWith("daemon.")`, and `scripts/fleet-heartbeat.sh` greps
 * `"step":"daemon\.`. One row therefore corrects the console, the `GET /v1/daemon-health`
 * route and the off-machine heartbeat SIMULTANEOUSLY, with no threshold moved and no
 * second liveness rule invented — the specific way this repo has previously ended up with
 * two surfaces documented to agree while quietly disagreeing.
 *
 * IT CARRIES `poll_interval_ms` BECAUSE `deriveLastPoll` READS THAT FIELD OFF THE WINNING
 * LINE. Omitting it would make this row win the max and then silently drop the console's
 * interval back to the injected default.
 *
 * IT IS LOGGED BEFORE `sweepLight()`, NOT AFTER, and that ordering is load-bearing: the
 * row asserts "this loop is running NOW", which does not depend on the sweep's outcome. A
 * sweep that HANGS therefore yields one last row and then silence, so a genuinely wedged
 * daemon still goes stale on schedule — logging after the sweep would let a hung sweep
 * suppress the very signal that should report it.
 *
 * THE START CONDITION IS UNCHANGED FROM W1-T254/W1-T276 — no `sweepLight`, no ticker —
 * and that was MEASURED, not assumed. Starting it unconditionally (so liveness could not
 * depend on an unrelated optional hook) added a `deps.sleep` call to every dispatch, and
 * eight suites across four files count sleeps as their IDLE proxy: a ticker sleeping
 * inside a dispatch forges evidence that the daemon idled. The coupling is therefore
 * accepted and made explicit rather than hidden: `sweepLight` is wired unconditionally in
 * production (`buildSweepLightHook`, run-task.ts) and that wiring already has its own
 * guard — run-task.test.ts's "daemonCommand: builds the real daemon deps (sweep +
 * sweepLight wiring)". A caller that omits the hook is a test, and gets no heartbeat
 * because it is running no dispatch worth reporting on.
 */
function startInFlightTicker(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  phase: "dispatch" | "retro",
): { stop: () => Promise<void> } {
  let active = true;
  const ticker = deps.sweepLight
    ? (async () => {
        while (active) {
          await deps.sleep(pollIntervalMs);
          if (!active) break;
          log("daemon.alive", { phase, poll_interval_ms: pollIntervalMs });
          try {
            await deps.sweepLight!();
          } catch (e) {
            log("daemon.sweep_light.failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      })()
    : undefined;
  // Cleared on EVERY exit path by the caller; a `sweepLight()` already in flight is
  // allowed to finish rather than aborted (unchanged from W1-T254).
  return {
    stop: async () => {
      active = false;
      if (ticker) await ticker;
    },
  };
}

/**
 * The spawn-infra backoff ceiling (POLICY DATA, rule 2): consecutive failures
 * double `pollIntervalMs` up to this cap rather than hammering a dispatch that
 * is failing for an infrastructure reason nobody has fixed yet — see the
 * backoff computation in `runDaemon`, below.
 */
export const DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS = 30 * 60_000;

/**
 * THE BOOT-RATE INVARIANT (W1-T215, recon T2-AC2). Two DIFFERENT root causes
 * have already produced a daemon relaunch loop: W1-T197's headroom-exhausted
 * exit-1 (fixed by moving headroom overage to an in-process idle heartbeat —
 * see `DaemonStopReason`'s doc, above) and the uncaught-escalate-throw loop
 * fixed in #472 (`tryEscalate`'s doc, escalate.ts — observed 2026-07-21
 * 04:02-04:13, one boot per minute). Both were caught only because a human
 * read `daemon.boot` ledger timestamps and noticed the gaps were ~60s —
 * nothing in the system observed its OWN boot rate. A third cause is likely
 * (any uncaught throw anywhere in the poll loop produces the identical
 * shape), so this detects the SHAPE — many boots in a short window, each
 * doing no work — rather than any one known trigger.
 *
 * A PURE FUNCTION over already-extracted `daemon.boot` timestamps (Rule 18):
 * no ledger read, no clock, no process spawn — provable against a synthetic
 * boot history with nothing but arrays and dates (this module never touches
 * the filesystem, see the file header). The caller re-derives
 * `bootTimestamps` from the ledger's own `daemon.boot` lines.
 */
export interface CrashLoopWindow {
  /** The rolling window's width, in ms. */
  windowMs: number;
  /** STRICTLY MORE than this many boots inside `windowMs` is a breach. */
  maxBoots: number;
}

/**
 * DEFAULT: more than 5 boots inside any rolling 10-minute window. Sized
 * against the two observed incidents (~one boot/minute — 10+ boots in 10
 * minutes) with headroom for a legitimate handful of restarts during
 * commissioning or config-change testing, which this must NOT trip on (the
 * false-positive falsifier, test/daemon-crashloop.test.ts) — an invariant
 * that cries wolf gets muted, and a muted invariant is worse than none.
 */
export const DEFAULT_CRASHLOOP_WINDOW: CrashLoopWindow = { windowMs: 10 * 60_000, maxBoots: 5 };

/**
 * The breach verdict — carries its OWN evidence (the densest window's actual
 * boot timestamps + the threshold breached), so surfacing it never sends a
 * human back to raw ledger timestamps, which is the exact labour this
 * replaces.
 */
export interface CrashLoopVerdict {
  breached: boolean;
  /** The densest `windowMs`-wide run of boots found, oldest first. */
  windowBoots: string[];
  windowMs: number;
  maxBoots: number;
}

/**
 * Find the densest `windowMs`-wide run of boots and compare its size against
 * `maxBoots`. Unparseable timestamps are dropped rather than thrown on — the
 * ledger's own torn-line discipline (ledger.ts) — so one malformed line never
 * takes the invariant itself down. Detects the SHAPE only: it does not care
 * WHY a boot happened, so the identical function catches a headroom-exit
 * loop, an escalate-throw loop, and whatever the next uncaught-throw cause
 * turns out to be. O(n²) in the boot count, which is fine — callers pass a
 * bounded recent tail of the ledger, never its full history.
 */
export function detectDaemonCrashLoop(
  bootTimestamps: readonly string[],
  window: CrashLoopWindow = DEFAULT_CRASHLOOP_WINDOW,
): CrashLoopVerdict {
  const parsed = bootTimestamps
    .map((raw) => ({ raw, ms: Date.parse(raw) }))
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

/**
 * The daemon's startup routine (W1-T12b): the ANTHROPIC-clean-env boot
 * assertion, run ONCE before the scheduler loop starts. Takes the log sink and
 * the env to check as explicit, injectable inputs — same shape as the rest of
 * this module — so it is provable in-process from a unit test with a fake env,
 * with NO real launchd load involved (that live commissioning step is
 * W1-T12d). The launchd unit that execs `rmd daemon` is generated by
 * lib/launchd.ts; this is the belt-and-suspenders check the daemon process
 * itself runs at boot, regardless of how it was launched.
 *
 * TEMP-DIR HYGIENE (W1-T115, the 26,711-dir ENOSPC incident): an optional
 * `sweepTmp` dependency, called once here if supplied and its count logged as
 * `daemon.tmp_sweep`. Injected rather than imported directly — same
 * discipline as the rest of this module (`this pure module never touches the
 * filesystem`, see the file header) — the real command wires
 * `lib/tmp.ts`'s `sweepStaleTempDirs`; tests inject a fake that counts calls
 * or seeds a fixed summary. Omitted ⇒ no sweep, behavior unchanged from
 * before W1-T115.
 *
 * BOOT-RATE INVARIANT (W1-T215): an optional `crashLoopCheck` dependency,
 * consulted once here, logged as `daemon.crashloop_check` either way so the
 * check's OWN pass/fail is part of the boot record — a breach is surfaced via
 * `crashLoopCheck.onBreach`, called with the {@link CrashLoopVerdict}'s
 * evidence attached (the real command wires this to escalate.ts, e.g.
 * `tryEscalate`, so a loop opens a needs-human issue instead of waiting for a
 * human to notice the boot-timestamp gaps). Omitted ⇒ no check, behavior
 * unchanged from before W1-T215.
 *
 * TOOLCHAIN RESOLUTION (W1-T113 part i, "log the resolved path once at daemon
 * boot"): an optional `resolveClaudeBin` dependency, called once here — the
 * real command wires worker.ts's `resolveClaudeExecutable` against its
 * shared, PER-PROCESS `claudeExecutableCache`, so this boot-time resolution
 * and every later `spawnWorker` call agree on the SAME answer, never a
 * second, possibly-different resolution. Logged as `daemon.claude_bin` either
 * way: success names the resolved `path`; a thrown
 * `ClaudeToolchainBlockedError` (duck-typed via `reasonClass`, same idiom as
 * `unlockWorkerKeychain`'s catch below) is logged with `blocked: true` and its
 * `error_class`, and BOOT CONTINUES — a fully-absent toolchain still fails
 * legibly the moment dispatch actually tries to spawn (this function's own
 * "the daemon sleeps through problems" doctrine, T197), it just never blocks
 * boot itself. Omitted ⇒ no resolution attempt here, behavior unchanged from
 * before W1-T113.
 */
export function daemonBoot(
  log: (step: string, extra?: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env,
  sweepTmp?: () => { removed: string[]; kept: string[] },
  sweepLocks?: () => { reaped: string[]; kept: string[] },
  unlockWorkerKeychain?: () => { keychainPath: string; provisioned: boolean; unlocked: true },
  crashLoopCheck?: {
    /**
     * Prior `daemon.boot` timestamps (ISO strings), re-derived from the ledger
     * by the CALLER before invoking `daemonBoot` — this module never touches
     * the filesystem (see the file header). Must NOT include this boot's own
     * timestamp; `daemonBoot` appends it (via `now`) before checking.
     */
    priorBoots: () => string[];
    /** Override the default window/threshold (POLICY DATA, rule 2). */
    window?: CrashLoopWindow;
    /**
     * THIS boot's own timestamp — defaults to the real wall clock; tests
     * inject a fixed instant so the check is provable without a real
     * wall-clock wait (Rule 18), same discipline as `DaemonDeps.now`.
     */
    now?: () => string;
    /**
     * Called ONLY on breach, with the evidence attached. The real command
     * wires this to escalate.ts (e.g. `tryEscalate`) so a loop opens a
     * needs-human issue instead of waiting for a human to read raw
     * timestamps.
     */
    onBreach: (verdict: CrashLoopVerdict) => void;
  },
  resolveClaudeBin?: () => string,
  /** True iff config.overflow === "api_key" (§9): the daemon deliberately drains
   * on API credits. Threaded so the daemon.boot canary reports the SAME billing
   * mode its workers will actually bill, not just whether the key is in its env. */
  allowApiKey = false,
  /**
   * W1-T117 orphan sweep (design part ii): "the orphan sweep terminates
   * strays from ended runs and ledgers them" — run once here, at boot,
   * mirroring `sweepTmp`/`sweepLocks` above (injected, logged either way as
   * `daemon.orphan_sweep` naming the killed/left-alone counts so the boot
   * record carries this sweep's own pass/fail, not only its strays). The
   * per-kill `worker_orphan_killed` ledger line is the injected function's
   * OWN job (`sweepOrphanWorkers`'s `ledger` dep, worker-containment.ts) —
   * this boot step only summarizes. Omitted ⇒ no sweep, behavior unchanged
   * from before W1-T117.
   */
  sweepOrphanWorkers?: () => OrphanSweepReport,
  /**
   * The sha of the CODE THIS PROCESS LOADED, resolved by the caller at boot (`git rev-parse HEAD`
   * in the install it was launched from). Recorded on `daemon.boot` so the deploy supervisor can
   * compare the RUNNING code against the checkout instead of comparing the checkout against
   * origin — the latter is consumed by anyone who pulls first, which left the daemon running
   * stale code silently (see `decideDeployTrigger`). Appended LAST so no positional caller
   * shifts. Omitted ⇒ the field is absent, exactly as before, and the supervisor fails eager.
   */
  bootHeadSha?: string,
): BootAssertion {
  const assertion = assertCleanBoot(env, allowApiKey);
  log("daemon.boot", {
    env_clean: assertion.env_clean,
    billing_mode: assertion.billing_mode,
    ...(bootHeadSha ? { head_sha: bootHeadSha } : {}),
  });
  // BOOT-RATE INVARIANT (W1-T215): the SHAPE-not-cause check — see this
  // function's doc and detectDaemonCrashLoop's, above. Logged either way
  // (daemon.crashloop_check) so the invariant's own pass/fail is part of the
  // legible boot record, not only its breaches.
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
  // W1-T235 (WS-7 keychain-unlock gate): the boot-time worker-keychain unlock,
  // EXPLICIT AND LEDGERED — the fleet's credential store comes up unlocked as a
  // named boot step, never as a side effect of unlocking the operator's login
  // keychain. Injected like the sweeps above (the real command wires
  // worker-home.ts's ensureWorkerKeychain). A failure here is ledgered with its
  // credential-named class and the boot CONTINUES (T197 doctrine: the daemon
  // sleeps through problems) — each spawn re-runs the rung and fails
  // credential-named at the spawn boundary, never as a $0 containment mystery.
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
  // STALE IN-FLIGHT LOCKS (R-35). Mirrors the tmp sweep above: injected, once at boot, logged
  // by COUNT. Purely an observability fix — acquireInflightLock already steals a dead holder's
  // lock, so nothing here unblocks dispatch. It exists because a stale lock is otherwise only
  // cleared by the next acquire of that same task, and a circuit-broken task is never
  // re-dispatched, so its lock lingers indefinitely and reads as live work.
  if (sweepLocks) {
    const swept = sweepLocks();
    log("daemon.lock_sweep", { reaped: swept.reaped.length, kept: swept.kept.length });
  }
  // W1-T113 part (i): resolve — and log — the real `claude` binary ONCE at
  // boot, see this function's own doc above. A refusal here is logged, never
  // thrown onward — boot continues (T197: the daemon sleeps through problems).
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
  // W1-T117 part (ii): the boot-time half of the orphan sweep — see this
  // param's own doc, above. A sweep failure is logged, never thrown onward —
  // boot continues (T197: the daemon sleeps through problems, never dies
  // over a `ps`/kill hiccup).
  if (sweepOrphanWorkers) {
    try {
      const report = sweepOrphanWorkers();
      log("daemon.orphan_sweep", { killed: report.killed.length, left_alone: report.leftAlone.length });
    } catch (err) {
      log("daemon.orphan_sweep", { error: String((err as Error)?.message ?? err) });
    }
  }
  return assertion;
}

/**
 * W1-T342's PER-DISPATCH GOVERNOR GATE now lives in sweep.ts, RE-EXPORTED here unchanged.
 *
 * WHY IT MOVED. `runDrainLanes` (drain.ts) must call the SAME function per lane it admits — this
 * function's own doc says so in as many words ("W1-T343's loop must call THIS function again per
 * lane it admits, never hoist a single call above the loop"). But daemon.ts already imports
 * `nextRunnable` FROM drain.ts, so drain.ts importing it from here would close an import cycle.
 * sweep.ts is the only home that avoids that: it already owns `CostGovernorResult` and
 * `QueueGovernorResult`, it imports neither daemon nor drain, and BOTH already import it.
 *
 * The alternative was a second copy of the predicate in drain.ts, which is the defect this repo
 * has paid for twice. Re-exported rather than relocated-and-rewired so every existing importer
 * (test/cost-governor.test.ts among them) keeps working byte-for-byte.
 */
export { checkDispatchGovernors, type DispatchGovernorVerdict } from "./dispatch-governor.js";

/**
 * The daemon's scheduler loop. Deterministic; no LLM decisions. Each tick:
 * check STOP → check PAUSE → check headroom → pick the next runnable (DAG
 * order, reusing drain.ts's `nextRunnable` — never reimplemented) → run it →
 * REASON about any non-merged verdict (W1-T46, superseding v1's blunt
 * stop-on-block): transient retries (no strike), an independent failure is
 * flagged + skipped while the rest of the drain continues, a FIXABLE genuine
 * blocker gets a bounded fix-rung attempt before halting (W1-T174, drain/
 * sweep parity), and a genuine blocker with no fixable signal (or an
 * exhausted fix attempt) halts + escalates. When nothing is runnable OR
 * headroom is exhausted, sleep
 * via the injected clock and poll again — the loop is PERSISTENT by default
 * (no `max`), unlike a bounded drain, and idling (for either reason) is an
 * in-process state, never a process exit.
 */
export async function runDaemon(
  plan: Plan,
  deps: DaemonDeps,
  opts: DaemonOpts = {},
): Promise<DaemonSummary> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = deps.log ?? (() => {});
  // W1-T342: shared by BOTH `checkDispatchGovernors` call sites below (the tick-top one and the
  // per-dispatch one immediately before `runOne`) — same three log shapes either call site can
  // produce, so the two sites cannot silently drift into different field names for the same verdict.
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
  // W1-T331: THE SNAPSHOT `deps.reloadDailyCostCeilingUsd` (top of the loop, below) writes into
  // and `deps.checkCostGovernor` (the governor consultation, below) reads from — never reassigned
  // anywhere else, so a read and the tick's decision always agree. Starts `undefined`: on tick 1
  // this is populated by the reload BEFORE the governor is ever consulted in that SAME tick, so
  // there is no genuinely-unset window in practice; `checkCostGovernor`'s own default parameter
  // covers a caller that omits the reload dep entirely.
  let dailyCostCeilingUsd: number | undefined;
  let costUsd = 0;
  let ticks = 0;
  /** Last emitted idle-reason signature — see the cadence note at the idle rung. */
  let lastIdleSignature: string | undefined;
  // W1-T46: per-task TRANSIENT retry state, threaded across ticks for the
  // SAME task id — bounds `blocked_transient` retries via classify.ts's
  // MAX_TRANSIENT_RETRIES (reasonAboutBlock). Dropped once a task's
  // disposition is no longer `retry_transient` (merged, flagged, or escalated).
  const blockRetryStates = new Map<string, RetryState>();
  // CIRCUIT BREAKER ESCALATION DEDUP (P29(ii)): the daemon is a PERSISTENT
  // loop — `nextRunnable` is re-invoked on EVERY tick, forever, so without this
  // a task that stays tripped would be re-escalated on every idle poll for as
  // long as the daemon keeps running (unbounded, the very unbounded-noise
  // shape P29 exists to prevent). This Set bounds the CALLBACK to the
  // daemon's own first observation of each task id this run; `isCircuitTripped`
  // itself is still consulted (and still excludes the task from dispatch)
  // every tick — see drain.ts's `runDrain`, the identical fix for the bounded
  // one-shot loop.
  const circuitEscalated = new Set<string>();
  // Same per-run escalation-dedup contract, for the lifetime cap (W1-T316/W1-T271) — the
  // predicate itself is still consulted (and still excludes the task) every tick.
  const lifetimeCapEscalated = new Set<string>();
  // SPAWN-INFRA ESCALATION DEDUP (W1-T113 part iii, the W1-T104 discipline):
  // content-keyed on the failure's OWN `reason` text, never on task id — the
  // vanished-binary class blocks dispatch identically for every task, so
  // task-id keying would still re-escalate once per distinct task hitting the
  // SAME cause. Persists for the life of this daemon run, mirroring
  // `circuitEscalated`'s own bound above.
  const toolchainEscalated = new Set<string>();
  // CONSECUTIVE spawn-infra failures — backs the backoff below; reset by any
  // runOne call that does NOT throw this class (success or an unrelated verdict).
  let consecutiveSpawnInfraFailures = 0;
  // HEADROOM RESERVE ESCALATION DEDUP (P34 clause (c), W1-T249): the SAME
  // per-episode bound `circuitEscalated` applies above — a sustained breach is
  // read fresh every tick (never a stop, see the HEADROOM comment below), so
  // without this the notification hook would fire on every idle poll for as
  // long as the window stays over the reserve. Cleared the moment a read
  // reports the window back under the reserve, so a LATER breach (a new
  // episode) escalates again rather than staying silenced for the rest of
  // this process's life.
  let headroomReserveEscalated = false;
  // QUOTA EXHAUSTION ESCALATION DEDUP (W1-T372): the SAME per-episode-latch shape
  // `headroomReserveEscalated` applies just above, kept PER BUCKET (core, graphql) rather than
  // one flag — each bucket is read, records, and escalates independently (design (i)/(iv)), so
  // a core exhaustion must never suppress a GraphQL one in the same hour or vice versa. Cleared
  // the moment a bucket's own read reports positive remaining again, so a LATER exhaustion (a
  // new episode, after that bucket's own reset) escalates again rather than staying silenced
  // for the rest of this process's life.
  const quotaExhaustedEscalated: Record<"core" | "graphql", boolean> = { core: false, graphql: false };
  // QUEUE STARVATION ESCALATION DEDUP (recon oper#queue-starvation-2026-08-03): the SAME
  // per-episode bound `headroomReserveEscalated`/`circuitEscalated` apply above — the census is
  // re-derived fresh every idle tick, so without this the notification hook would fire on
  // every poll for as long as the queue stays starved. Cleared the moment a tick is NOT
  // starved (a dispatchable task appeared, or every remaining recoverable-class blocker
  // cleared), so a LATER episode escalates again rather than staying silenced for the rest of
  // this process's life.
  let starvationEscalated = false;
  const maxSpawnInfraBackoffMs = opts.maxSpawnInfraBackoffMs ?? DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS;
  // BOUNDED DEGRADED MODE (recon R-7: the live ledger shows /usage unreadable
  // ~78% of the time — an unconditional fail-closed-on-first-miss would halt
  // the fleet most of the time, so this counts CONSECUTIVE misses instead of
  // treating any single one as decisive). Reset to zero by any successful
  // read; escalates to the in-process idle heartbeat once it exceeds
  // `unreadableDegradedLimit` — see the headroom check below.
  let consecutiveUnreadable = 0;
  // Seeded from the ledger so the once-per-string bound survives a restart, then maintained
  // in-process for the life of this daemon.
  const reportedUnrecognisedResets = new Set<string>(deps.priorUnrecognisedResets ?? []);
  const headroomPolicy = opts.headroomPolicy ?? buildDefaultHeadroomPolicy(opts.headroomLimitPct);
  // The headroom governor switch (ruling fb-1784894405468-a4153e). Library default
  // TRUE (existing enforcement + tests unchanged); the live `rmd daemon` entry
  // passes the host posture resolved from config/env — also default TRUE since the
  // 2026-07-25 ruling, with this host opting out via `headroom.enabled: false`.
  const headroomEnabled = opts.headroomEnabled ?? true;
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? DEFAULT_UNREADABLE_DEGRADED_LIMIT;
  const now = deps.now ?? (() => new Date());
  // W1-T343: resolved ONCE, for this process's whole lifetime — `DaemonOpts` is the daemon's
  // frozen-at-boot configuration (see `wipLimit`'s own doc on why a running daemon does not
  // live-reload `sweep.dispatchLanes`; that gap is W1-T331's, deliberately not this task's).
  // Floored at 1, never 0: a misconfigured `laneCount: 0` must never mean "dispatch nothing"
  // silently — {@link laneDispatchBudget} already floors its OWN `laneCount` input this same
  // way, so a value below 1 clamps up here rather than producing two disagreeing floors.
  const laneCount = Math.max(1, opts.laneCount ?? 1);

  const summary = (stopReason: DaemonStopReason, stopDetail?: string): DaemonSummary => {
    const s: DaemonSummary = { attempted, merged, stopReason, stopDetail, costUsd, ticks };
    log("daemon.summary", { ...s });
    return s;
  };

  // W1-T343: ONE per-task block-reasoning processor, shared by the single-task tick
  // (`laneCount <= 1`) and the multi-lane batch (`laneCount >= 2`) below — the SAME "never a
  // second implementation" discipline this task applies to lane partitioning also applies to
  // judging a lane's verdict: a fork between "how a solo dispatch's result is judged" and "how
  // one lane's result in a batch is judged" is exactly the drift-prone duplication this task
  // exists to close. Extracted VERBATIM from the pre-W1-T343 single-task loop body — every log
  // line, field and ordering decision below is byte-identical to before this function existed,
  // just callable once per task instead of inlined once per tick. `planForBatch` is threaded in
  // as a parameter (never closed over) because it is rebound every tick (see its own doc above);
  // a closure captured once, above the loop, would freeze it at tick 1 forever.
  //
  // Returns a disposition rather than returning out of the whole loop directly, so a caller
  // processing several lanes' results in one batch can finish EVERY sibling's own bookkeeping —
  // its retry-state update, its fix dispatch, its independent-failure flag, its merge — before
  // deciding whether to halt the daemon (LANE-LOCAL BLOCK SEMANTICS: see `runDrainLanes`' own
  // doc, drain.ts). At `laneCount <= 1` there is only ever one caller per tick, so this is a
  // provable no-op restructuring: same inputs, same log lines, same return value threaded
  // straight back into a `return summary("blocked", …)` exactly as before.
  const processDispatchResult = async (
    planForBatch: Plan,
    task: Task,
    result: RunResult,
  ): Promise<{ kind: "merged" } | { kind: "continue" } | { kind: "genuine_blocker"; detail: string }> => {
    if (!result.merged) {
      // BLOCK-REASONING (W1-T46, supersedes v1's blunt stop-on-block): reuse
      // W1-T7's transient/strike taxonomy + the plan's DAG (block-reason.ts)
      // instead of halting on ANY non-merged verdict.
      const state = blockRetryStates.get(task.id) ?? INITIAL_RETRY_STATE;
      const disposition = reasonAboutBlock(planForBatch, task.id, result.verdict, state);

      if (disposition.kind === "retry_transient") {
        // TRANSIENT: no strike. `nextRunnable` naturally retries the SAME
        // task next tick (it is still un-merged and its deps are unchanged) —
        // no separate re-dispatch mechanism needed.
        blockRetryStates.set(task.id, disposition.state);
        log("daemon.block.transient_retry", {
          task: task.id,
          verdict: result.verdict,
          transient_retries: disposition.state.transientRetries,
        });
        return { kind: "continue" };
      }
      if (disposition.kind === "fixable_blocker" && deps.dispatchFix) {
        // W1-T174 (drain/sweep PARITY): the SAME blocked_ci/blocked_review
        // evidence the W1-T77 sweep routes to the W1-T76 fix rung gets a
        // bounded fix attempt here too, BEFORE halting — strike-capped by
        // `reasonAboutBlock` via the SAME classify.ts primitive every
        // strike in this module already uses (never a separate, unbounded
        // loop — the W1-T168 anti-regression guard: exhausting the bound
        // falls through to `genuine_blocker` on a LATER tick and escalates
        // for re-judgment, it does not fix-loop forever). Keep the retry
        // state threaded across ticks — dropped only once resolved
        // (merged, flagged, or escalated) below.
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
        // INDEPENDENT-FAILURE: nothing in the plan transitively depends on
        // this task, so skipping it cannot leave a dependent building on a
        // gap. Flag it — flip the in-memory `status` so `nextRunnable` never
        // reconsiders it this run — and keep draining everything else.
        task.status = "blocked";
        log("daemon.block.independent_failure", {
          task: task.id,
          verdict: result.verdict,
          pr_url: result.prUrl,
        });
        return { kind: "continue" };
      }

      // GENUINE BLOCKER: real downstream work transitively needs this task
      // merged — "never continue into the gap" is absolute here. Halt and
      // escalate, exactly as v1's stop-on-block halted, but now the
      // dependents it protects are named. Reached by a `genuine_blocker`
      // disposition (no fixable signal at all, or a `fixable_blocker` whose
      // strike bound `reasonAboutBlock` already exhausted) AND by a
      // `fixable_blocker` with no `dispatchFix` wired (W1-T174: never a
      // silent stall on a fixable block this daemon has no rung to act on —
      // the SAME halt+escalate a genuine blocker always got).
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
    if (opts.max !== undefined && attempted.length >= opts.max) {
      return summary("max_reached", `${opts.max} task(s)`);
    }

    // FLEET CONTROL (W1-T11): checked FIRST, every tick — a hard STOP wins any
    // race against PAUSE and against picking up the next task. Neither check
    // can ever interrupt a task that is already running: `runOne` below is
    // awaited to completion before the loop returns here, so an in-flight
    // task always reaches its verdict + merge (the drain-and-hold guarantee).
    const stopped = deps.checkStop?.();
    if (stopped) {
      log("daemon.stop", { detail: stopped });
      return summary("stopped", stopped);
    }

    // PLAN FRESHNESS (impl-FZ). `plan` arrives as a parameter and, before this, was NEVER
    // reassigned — no `loadPlan`, no `syncPlan`, nothing — so a task filed after this boot began
    // was invisible to EVERY dispatch decision for the boot's lifetime. Measured on the real
    // ledger: the median gap between a task landing on origin/main and the daemon next booting is
    // 106 minutes; 64% of filings waited over an hour, 40% over three. With auto-triage now filing
    // unattended, that is a task queue the running fleet cannot see.
    //
    // PLACED HERE DELIBERATELY, and the position is the batch safety argument:
    //   - AFTER `checkStop`, so a deliberately halted fleet never does I/O to reload.
    //   - At the TOP of the tick, before any dispatch decision reads the plan.
    //
    // The dep returns null when nothing changed, so the caller owns change detection and the
    // common case costs no parse. It must re-read from the SAME source the boot used
    // (origin/main, never the working tree) — a second source of truth here is the exact defect
    // this project has spent days unpicking. A throw is caught and ledgered, never fatal: a
    // transient git failure must degrade to "keep running on the plan we have", not take the
    // fleet down.
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
    // ONE SNAPSHOT PER DISPATCH BATCH (W1-T340; MASTER-PLAN §4B; narrows W1-T326 blocker (2)).
    // `plan` above is a MUTABLE local binding — reassigned by the reload block on every tick it
    // fires — so a piece of code that closes over the NAME `plan` reads whatever the MOST RECENT
    // reload produced, not necessarily the value that was live when its own dispatch decision was
    // made. That distinction was invisible before this line existed: `runDaemon` picks and awaits
    // exactly one task per tick (N=1), so nothing ever ran between one reload and the next that
    // could observe the difference. It stops being invisible the moment a batch holds more than
    // one lane (W1-T343): lane A can be dispatched from this tick's plan, the tick can then reload
    // for lane B, and if lane A's OWN later reasoning (its post-hoc block judgment, an overlap
    // partition, a retry) reads the live `plan` binding instead of what it was dispatched under, it
    // is silently re-judged against a blob it never saw — no throw, no ledger line, two disagreeing
    // answers. `plan = fresh` reassigns the BINDING, never mutates the Plan object itself (JS
    // reference semantics), so the fix is a value capture, not a lock: `planForBatch` is bound ONCE,
    // right here, immediately after this tick's reload has settled, and is the ONLY plan value every
    // lane and every decision below — the kick check, `nextRunnable`'s selection,
    // `reasonAboutBlock`'s post-hoc judgment — may consult for the REST of this tick. `plan` itself
    // is free to be reassigned again on the NEXT tick; `planForBatch` never is. This holds at N=1 too
    // (a single-lane batch is a batch of one, and the discipline is identical), which is what makes
    // it landable and provable before any lane exists rather than speculative scaffolding.
    const planForBatch = plan;
    // DAILY COST CEILING FRESHNESS (W1-T331): mirrors `reloadPlan` immediately above — SAME
    // placement (top of the tick, before any dispatch decision, so everything below sees ONE
    // consistent ceiling), SAME "a throw is caught and ledgered, never fatal" contract. UNLIKE
    // `reloadPlan` (whose failure just keeps serving the plan already held), a failed read here
    // deliberately does NOT touch `dailyCostCeilingUsd` — see `DaemonDeps.reloadDailyCostCeilingUsd`'s
    // doc for why leaving it at its last known-good value, rather than resetting it to
    // `undefined`, is the correct degrade: `undefined` reaching `checkCostGovernor` reads as "no
    // live override," silently widening the ceiling back to the frozen shipped default.
    if (deps.reloadDailyCostCeilingUsd) {
      try {
        dailyCostCeilingUsd = deps.reloadDailyCostCeilingUsd();
      } catch (e) {
        log("daemon.cost_ceiling_reload_failed", { reason: e instanceof Error ? e.message : String(e) });
      }
    }
    // SELF-FRESHNESS (W1-T126): checked directly after STOP — a hard STOP still wins
    // outright, a deliberately halted fleet never self-restarts for freshness — and
    // before PAUSE/headroom/dispatch, so origin/main advancing past this process's own
    // boot sha is noticed even while otherwise idle or paused. Never interrupts
    // in-flight work: like `checkStop`/`checkPause`, this is only consulted between
    // iterations. See `DaemonDeps.checkFreshness`'s doc for the full contract.
    const freshness = deps.checkFreshness?.();
    if (freshness?.stale) {
      // W1-T151: install BEFORE the loop stops for restart — never after — so the
      // freshly-relaunched process (booting at newSha) inherits deps that already
      // match it, not the stale node_modules this tick's own process is still running.
      if (freshness.installNeeded) {
        deps.runInstall?.();
      }
      const detail =
        `origin/main advanced ${freshness.oldSha.slice(0, 7)}..${freshness.newSha.slice(0, 7)} ` +
        `past this process's boot sha`;
      log("daemon_selfrestart_for_freshness", { old_sha: freshness.oldSha, new_sha: freshness.newSha });
      return summary("stale", detail);
    }
    // PAUSE is an IN-PROCESS idle, never an exit (the 2026-07-22 relaunch
    // storm: returning here exited nonzero, and KeepAlive{SuccessfulExit:false}
    // relaunched into the same flag every ~10s until bootout). Same shape as
    // the headroom idle below: one heartbeat per tick, sleep on the injected
    // clock, re-poll — `rmd resume` deletes the flag and the very next tick of
    // this SAME process proceeds. STOP (above) is deliberately checked FIRST,
    // so a hard STOP still terminates a paused daemon cleanly (exit 0).
    const paused = deps.checkPause?.();
    if (paused) {
      ticks++;
      log("daemon.pause", { tick: ticks, detail: paused, poll_interval_ms: pollIntervalMs });
      await deps.sleep(pollIntervalMs);
      continue;
    }

    // CONSOLE "DRAIN NOW" (fb-1784988460437-9daa9b): consumed-once at the top of a
    // cycle — its whole effect IS "run one dispatch cycle immediately", which this
    // loop body already is, so consuming + ledgering (naming the console as actor,
    // origin carried from the marker) is the action. STOP/PAUSE above still win; a
    // drain request never overrides a deliberate hold.
    if (deps.consumeDrainNow) {
      const drain = deps.consumeDrainNow();
      if (drain) log("console.drain_consumed", { origin: drain.origin });
    }

    const isMerged = deps.refreshMerged();

    // LEVEL-TRIGGERED PR-PIPELINE RECONCILER (W1-T77, ratifies P22 core): once
    // per iteration, re-derive every open PR's disposition and take its gated
    // action. Runs alongside dispatch (not instead of it): dispatch opens NEW
    // work, the sweep reconciles the OPEN PRs already in flight so none strands
    // open-and-orphaned (the #111/#113/#123 class). Best-effort by contract —
    // and now IN CODE, not just in this comment. The sweep reaches `gh` through
    // execFileSync, which THROWS on any nonzero exit (rate-limit, auth blip,
    // network partition). This loop's only try/catch wraps `runOne` (below), so
    // before this guard such a throw propagated out of the process; launchd's
    // KeepAlive{SuccessfulExit:false} reads the nonzero exit as a CRASH and
    // relaunches, which re-runs the same sweep and throws again. A reconciler
    // that cannot reach GitHub must cost the daemon one logged iteration, never
    // its life.
    if (deps.sweep) {
      try {
        await deps.sweep();
      } catch (e) {
        log("daemon.sweep.failed", { error: String((e as Error)?.message ?? e) });
      }
    }

    // ORPHAN SWEEP (W1-T117 design part ii): runs alongside the PR-pipeline
    // reconciler above, on the SAME "once per iteration" cadence — daemon
    // BOOT already runs it once (see `daemonBoot`'s own `sweepOrphanWorkers`
    // param, below); this is the "each poll" half. Best-effort by the same
    // contract as `deps.sweep`: a `ps`/kill hiccup costs one logged tick,
    // never the daemon's liveness. Optional — omitted, the loop behaves
    // exactly as before this sweep existed.
    if (deps.sweepOrphans) {
      try {
        const report = await deps.sweepOrphans();
        log("daemon.orphan_sweep", { killed: report.killed.length, left_alone: report.leftAlone.length });
      } catch (e) {
        log("daemon.orphan_sweep.failed", { error: String((e as Error)?.message ?? e) });
      }
    }

    // HEADROOM: never hammer a nearly-exhausted pool. An at/near-limit reading
    // gates new spawns WITHOUT halting the loop (see the DaemonStopReason doc
    // above — a launchd KeepAlive unit restart-loops on any exit, so exiting
    // here would just relaunch into the same exhausted reading every poll).
    // Instead this is an in-process idle state, identical in shape to
    // "nothing runnable" below: sleep via the injected clock, emit one
    // `daemon.headroom` heartbeat per tick naming the window/percent/reset,
    // and re-check next tick — until the window resets and headroom frees up
    // (readUsage() is called fresh every tick, so a real reset is picked up
    // automatically, no separate "wake up at resets_at" timer needed), or
    // STOP/PAUSE is honoured above. The ceiling itself is TIME-AWARE
    // (`headroomPolicy`, resolved once above): on a window's final day it
    // relaxes toward 100%, since anything unspent is destroyed at reset.
    if (deps.readUsage) {
      const snap = deps.readUsage();
      if (snap) {
        // A GOOD read clears the degraded-mode counter — only CONSECUTIVE
        // misses count toward escalation, not a lifetime total.
        consecutiveUnreadable = 0;
        const windows = resolveHeadroomWindows(snap, now(), headroomPolicy, (window, raw) => {
            // ONCE PER DISTINCT STRING, NOT PER TICK. The loop polls every 60s, so a per-tick
            // emission would write ~1,440 identical lines a day and bury the one thing worth
            // reading. The set is seeded from the ledger (DaemonDeps.priorUnrecognisedResets), so
            // the bound holds across a restart as well as within one process.
            if (reportedUnrecognisedResets.has(raw)) return;
            reportedUnrecognisedResets.add(raw);
            // CARRY THE STRING — the whole value is knowing WHAT could not be parsed. A line
            // saying only "parse failed" would have saved nobody the three-hour outage.
            log("daemon.usage_reset_unrecognised", {
              window,
              raw: raw.slice(0, UNRECOGNISED_RESET_MAX_LEN),
              truncated: raw.length > UNRECOGNISED_RESET_MAX_LEN,
            });
          });
        const over = windows.find((w) => w.percentUsed >= w.limitPct) ?? null;
        // P34 clause (c), W1-T249: a breach episode escalates AT MOST ONCE (see
        // `headroomReserveEscalated`'s doc above) — clearing here, unconditionally
        // (whether or not the governor is enforcing), so a LATER breach after this
        // one recovers is treated as a fresh episode rather than staying silenced.
        if (!over) headroomReserveEscalated = false;
        // ENFORCEMENT (W1-T197 curve, UNCHANGED): an at/over-limit reading is an
        // in-process idle heartbeat while over — never a stop (KeepAlive would
        // relaunch into the same reading). Resumes on its own once the window resets.
        // The counter advances BEFORE the heartbeat, exactly as it did, so the line
        // still carries this idle tick's own number.
        const enforcingIdle = headroomEnabled && over !== null;
        if (enforcingIdle) ticks++;
        // ─── ONE HEARTBEAT PER TICK, IN EVERY ENFORCEMENT POSTURE ───────────────
        // THE ASYMMETRY THIS FIXES. The log used to live inside `if (over)` on the
        // enforcing branch and inside the `else` on the disabled branch — with NO
        // `else` on the inner `if (over)`. So the one posture an operator is most
        // likely to be in — governor ARMED, usage comfortably UNDER the ceiling —
        // logged NOTHING AT ALL. The governor was armed on this host on 2026-07-31
        // and the ledger emitted no `daemon.headroom` line from that moment on; the
        // newest one anywhere (live file ∪ 661 rotations) was 14:59:05Z, `enforced:
        // false`, from BEFORE the switch. Any console panel reading this step would
        // have rendered permanently-frozen numbers and been believed — the
        // "tested, inert" shape this repo has already shipped twice.
        //
        // So the heartbeat is now UNCONDITIONAL on a good read, and carries
        // `enforced` so a reader can tell an armed governor from telemetry-only.
        // `over ?? windows[0]` reproduces BOTH previous lines' window selection
        // exactly: the offending window when over, else the most-burned one
        // (`resolveHeadroomWindows` returns most-burned-first).
        //
        // NOTHING ABOUT ENFORCEMENT MOVED. The idle-pause, the once-per-episode
        // `onHeadroomBreach`, and the `continue` all still happen, still only when
        // `headroomEnabled && over`, still after this line — see `enforcingIdle`.
        // Only the under-ceiling SILENCE changed.
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
          // P34 clause (c), W1-T249: notify ONCE per episode — dispatch is
          // ALREADY paused above (this same `continue`), so the hook is a pure
          // notification, never a dispatch decision. Failure here costs one
          // logged line, never the daemon's liveness (same discipline as
          // `onCircuitBreak`/`onSpawnInfraBlocked`).
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
          await deps.sleep(pollIntervalMs);
          continue;
        }
        // GOVERNOR DISABLED (operator ruling fb-1784894405468-a4153e) or simply
        // UNDER the ceiling: no `continue` — dispatch proceeds regardless of burn.
      } else if (headroomEnabled) {
        // UNREADABLE: cannot-read-the-budget must never render as
        // proceed-as-if-unlimited (the fail-open polarity at the spending
        // layer — the #157/#143-adjacent cannot-observe-rendered-as-permissive
        // family: the gateway returning `[]`, W1-T181; the projection
        // regressing to `queued`, W1-T179). This is now an EXPLICIT, tested,
        // BOUNDED policy rather than an implicit "continue regardless"
        // fall-through: a handful of consecutive misses is a transient read
        // failure (recon R-7: unreadable ~78% of the time in the live
        // ledger — an unconditional fail-closed-on-first-miss would halt the
        // fleet most of the time), so dispatch is still permitted WITHIN the
        // bounded allowance, always logged distinctly (never silently); once
        // the allowance is exceeded, the daemon escalates to the SAME
        // in-process idle heartbeat a confirmed breach uses, until a read
        // succeeds again.
        consecutiveUnreadable++;
        if (consecutiveUnreadable > unreadableDegradedLimit) {
          ticks++;
          log("daemon.headroom.degraded", {
            tick: ticks,
            consecutive_unreadable: consecutiveUnreadable,
            degraded_limit: unreadableDegradedLimit,
            poll_interval_ms: pollIntervalMs,
            note: "usage unreadable beyond the bounded allowance — idling, not dispatching",
          });
          await deps.sleep(pollIntervalMs);
          continue;
        }
        log("daemon.headroom.unavailable", {
          consecutive_unreadable: consecutiveUnreadable,
          degraded_limit: unreadableDegradedLimit,
          note: "usage unreadable — bounded degraded-mode allowance, still dispatching",
        });
      } else {
        // UNREADABLE while the governor is DISABLED (ruling a4153e clause 4): an
        // unreadable read is ABSENT TELEMETRY, never a hold — no degraded idle, no
        // escalation counter, no headroom line. Dispatch proceeds; reset the counter
        // so a later enable starts from a clean slate.
        consecutiveUnreadable = 0;
      }
    }

    // QUOTA (W1-T372): BESIDE `daemon.headroom` immediately above, on the SAME tick — never a
    // new cadence (design (ii)). Both `gh api rate_limit` buckets are read together
    // (`readGhQuota`'s own doc: one exec call, never two) and RECORDED INDEPENDENTLY every tick
    // a read succeeds, so an exhaustion of either bucket is visible on the ledger without
    // anyone requesting the pull-only `/v1/daemon-health` page. THIS IS OBSERVE-AND-SURFACE
    // ONLY (design (vii)): unlike headroom's own enforcement branch above, no `continue` is
    // taken here and dispatch is never paused on a bucket's account.
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
        // A STATE TRANSITION, NOT A VALUE CHECK (design (iii)): `remaining === 0` holds every
        // tick until the bucket's own reset, so alerting on the raw value would re-fire up to
        // once a minute for an hour. The latch fires the hook only on the tick this bucket
        // FIRST reads exhausted, and clears the instant it reads positive again — the same
        // discipline `headroomReserveEscalated` applies above, kept per bucket here.
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

    // DAILY COST CEILING (W1-T317, wiring `checkCostGovernor`/sweep.ts) + QUEUE GOVERNOR / WIP
    // CEILING (W1-T321, wiring `checkQueueGovernor`/sweep.ts, the W1-T121 23-open-PR incident):
    // both global gates, not per-task ones, so — unlike `isCircuitTripped`/`isLifetimeCapExceeded`
    // below — they are checked directly here, right after headroom and before the retro trigger (a
    // fired retro spawns a real, budget-costing run too — same reasoning the retro trigger's own
    // comment already gives for running after headroom) and before the idle branch's auto-triage
    // rung (same reasoning again — auto-triage also spawns a real, budget-costing run). UNLIKE
    // drain.ts's bounded pass (which stops outright), this daemon is PERSISTENT: a deferral is an
    // in-process idle heartbeat, identical in shape to headroom's own `enforcingIdle` branch just
    // above, so the loop resumes automatically once the observed reading drops back under the
    // ceiling/limit.
    // W1-T331: threads THIS tick's own ceiling snapshot (reloaded above, top of tick) through —
    // never a fresh read here and never the frozen default unless the reload itself never
    // populated one.
    // W1-T342: this is the TICK-WIDE gate — it still runs exactly ONCE per tick, guarding
    // whichever ONE dispatch-shaped action (retro fire, auto-triage fire, or the normal task
    // dispatch below) this tick can still take, unchanged in effect from before this task. It is
    // NOT, by itself, the per-dispatch gate a multi-lane batch needs — see `checkDispatchGovernors`'s
    // own doc, and the SECOND consultation immediately before `runOne` below: this call alone
    // would let a second lane in one batch spend against a reading taken before the first lane's
    // own cost could show up in it.
    const tickGovernor = checkDispatchGovernors(deps, dailyCostCeilingUsd);
    if (tickGovernor) {
      ticks++;
      logDispatchGovernorDefer(tickGovernor, ticks);
      await deps.sleep(pollIntervalMs);
      continue;
    }

    // RETRO CADENCE TRIGGER (W1-T160): evaluated once per tick, AFTER headroom (an
    // automated retro spawns a real, budget-costing Architect run — the same class of
    // spend headroom exists to gate, so a fired retro under a near-exhausted pool waits
    // like any other dispatch would) and BEFORE the normal task-dispatch pick, so a
    // fired retro this tick displaces dispatch for the tick rather than racing it.
    // Best-effort: a caught error costs one logged tick, never the daemon's life (same
    // discipline as deps.sweep/deps.sweepOrphans above).
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
          try {
            // W1-T276: the retro's own await is unbounded, just like `runOne`
            // below — wrap it in the SAME light-sweep ticker so the loop's
            // sweep keeps dispositioning PRs while the retro runs, instead
            // of going dark for the retro's whole duration.
            await sweepLightDuringRetro(deps, pollIntervalMs, log, () => deps.runRetroTrigger!(decision));
          } catch (e) {
            log("daemon.retro_trigger.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
        ticks++;
        await deps.sleep(pollIntervalMs);
        continue;
      }
    }

    // CONSOLE "RUN" KICK (fb-1784988460437-9daa9b): a queued-row Run dispatches THAT
    // task by id this cycle, ahead of nextRunnable's ordering — but still THROUGH the
    // normal gate. A kicked id that is unknown, already merged (the stale-marker
    // class), or refused by `assertRunnable` (verify:human / blocked / unmerged deps)
    // is CLEARED and its named reason LEDGERED (`console.kick_refused`), never silently
    // dropped, so the console surfaces it via the ledger stream. The first runnable
    // kick becomes this cycle's task; other runnable kicks wait for the next cycle.
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

    // WHY THE DAEMON IS IDLE. The four eligibility conditions used to decline silently, so a
    // ten-hour idle emitted ~390 bare `daemon.idle` lines and ZERO `dispatch.*` — the record could
    // not distinguish "starved of work" from "everything filtered". This tallies the declines as
    // the filter runs; nothing about what is eligible changes.
    const idleReasons = tallyDispatchFilters();
    // QUEUE STARVATION (recon oper#queue-starvation-2026-08-03): `isDispatchEligible` ledgers a
    // circuit-broken decline through its own `onCircuitBreak` callback, never through
    // `idleReasons`'s `DispatchFilterReason` tally (see drain.ts's doc) — collected here, per
    // tick, so the starvation census below can name it alongside `blocked`/`unmet-deps`.
    const circuitBrokenThisTick: string[] = [];
    const dispatchOpts: NextRunnableOpts = {
      isOpenPr: deps.isOpenPr,
      onFiltered: idleReasons.onFiltered,
      // IN-FLIGHT (W1-T80): a legible skip on console + ledger; the daemon
      // keeps polling rather than treating an open PR as a block.
      onSkip: (t, prNumber) => log("dispatch.skipped", { task: t.id, reason: "open-pr", pr_number: prNumber }),
      // W1-T177: wrap the injected reader so a FAILED/INDETERMINATE live read
      // (returns `undefined`) is LEDGERED here — distinct from an ordinary
      // un-wired site, which never calls this at all. Still resolves to
      // `undefined` either way, so nextRunnable's own fail-OPEN contract
      // (treat as still in-flight, skip it) is completely unchanged.
      readLiveState: deps.readLiveState
        ? (taskId, prNumber) => {
            const state = deps.readLiveState!(taskId, prNumber);
            if (state === undefined) log("dispatch.live_state_indeterminate", { task: taskId, pr_number: prNumber });
            return state;
          }
        : undefined,
      // W1-T177: the cached in-flight snapshot was stale — this task is NOT
      // actually blocked. Ledgered distinctly, naming the freshly observed
      // terminal state rather than the misleading "open-pr" reason.
      onStoodDown: (t, prNumber, state) =>
        log("dispatch.stood_down", { task: t.id, pr_number: prNumber, state, reason: "cached in-flight read was stale" }),
      isIndeterminate: deps.isIndeterminate,
      // INDETERMINATE (W1-T119): a legible ledger line every tick it is
      // consulted — the daemon keeps polling everything else rather than
      // halting, same discipline as `dispatch.skipped`/`dispatch.circuit_broken`.
      onIndeterminate: (t) => {
        log("dispatch.indeterminate", { task: t.id, ...deps.breakerDetail?.(t.id) });
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      // CIRCUIT BREAKER (P29(ii)): a legible ledger line every tick it is
      // consulted — but the caller's own escalation hook fires AT MOST ONCE
      // per task id for this daemon run (`circuitEscalated`, above) — the
      // daemon keeps polling everything else rather than halting the whole
      // loop, and never re-escalates a task it already escalated.
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id, ...deps.breakerDetail?.(t.id) });
        circuitBrokenThisTick.push(t.id);
        if (!circuitEscalated.has(t.id)) {
          circuitEscalated.add(t.id);
          // The injected hook opens a GitHub issue (escalateCircuitBreak ->
          // escalate -> `gh issue create`). It fires during task SELECTION,
          // outside the `runOne` try/catch below, so an unreachable `gh` used
          // to kill the daemon here. The notification is a backstop; failing to
          // send it must never outrank staying alive to do the work.
          try {
            deps.onCircuitBreak?.(t);
          } catch (e) {
            log("daemon.escalation.failed", { task: t.id, error: String((e as Error)?.message ?? e) });
          }
        }
      },
      isLifetimeCapExceeded: deps.isLifetimeCapExceeded,
      // LIFETIME DISPATCH CAP (W1-T316/W1-T271): a legible ledger line every tick it is
      // consulted — but the caller's own escalation hook fires AT MOST ONCE per task id for
      // this daemon run (`lifetimeCapEscalated`, above), mirroring `onCircuitBreak` immediately
      // above including its try/catch — a failed notification costs one logged line, never the
      // daemon's liveness.
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

    // W1-T343 — THE DISPATCH SET (ADOPTS drain.ts's LANE MACHINERY, NEVER A SECOND
    // IMPLEMENTATION). A console kick (`forcedNext`) always dispatches ALONE, bypassing
    // candidate selection entirely — it already ran the gauntlet (`assertRunnable`, above)
    // `isDispatchEligible` exists to apply, and folding a human's explicit "run this now" into
    // a concurrent batch alongside whatever the DAG scan would otherwise pick is a DIFFERENT
    // feature this task does not build.
    //
    // Otherwise: `runnableCandidates(plan, isMerged, budget, dispatchOpts)` applies the EXACT
    // SAME `isDispatchEligible` chain `nextRunnable` does (the two are factored so they can
    // never drift — see drain.ts), and `partitionByFileOverlap` is the SAME pure predicate
    // `runDrainLanes` already composes it with (dispatch-overlap.ts) — neither is reimplemented
    // here. At `laneCount <= 1` (the SHIP-DARK default), `budget` is `1` UNCONDITIONALLY —
    // never sized by `wipLimit`/`openPrCount` — so `runnableCandidates` returns the SAME single
    // task `nextRunnable` would, via the SAME walk, firing the SAME callbacks in the SAME
    // order; and `partitionByFileOverlap` on a <=1-length list can never defer anything
    // (nothing is yet placed in `dispatch` to overlap against — see that function's own doc).
    // `dispatchSet` below is therefore BYTE-IDENTICAL, at `laneCount <= 1`, to `next` from
    // before this task, wrapped in an array — the safety property `DaemonOpts.laneCount`'s own
    // doc states.
    let dispatchSet: Task[];
    if (forcedNext) {
      dispatchSet = [forcedNext];
    } else {
      const budget =
        laneCount <= 1
          ? laneCount
          : laneDispatchBudget({ laneCount, wipLimit: opts.wipLimit, openPrCount: deps.openPrCount?.() });
      if (laneCount >= 2 && budget <= 0) {
        // Mirrors `runDrainLanes`' `dispatch.wip_deferred` (drain.ts) — runnable work may well
        // exist, held back by the governor rather than absent, distinct from an ordinary idle
        // tick below. Never reached at `laneCount <= 1` (`budget` is `1` there, unconditionally).
        log("dispatch.wip_deferred", {
          lane_count: laneCount,
          wip_limit: opts.wipLimit ?? null,
          observed_open_count: deps.openPrCount?.() ?? null,
        });
      }
      const candidates = runnableCandidates(planForBatch, isMerged, budget, dispatchOpts);
      const partition = partitionByFileOverlap(candidates);
      for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
      dispatchSet = partition.dispatch;
    }

    if (dispatchSet.length === 0) {
      // UNLIKE drain.ts (where `no_runnable` is a terminal stop): the daemon is
      // PERSISTENT — new work can land later, so it paces itself with the
      // injected clock and keeps polling rather than exiting.
      ticks++;
      log("daemon.idle", { tick: ticks, poll_interval_ms: pollIntervalMs });
      // CADENCE: ON CHANGE, NOT EVERY TICK. `daemon.idle` still fires every poll and is byte-
      // compatible with before (anything parsing it is unaffected). The REASONS ride a separate
      // step emitted only when the picture actually changes -- the first idle after boot, then
      // whenever a bucket's membership differs. Logging the tally on all ~390 ticks would be 390
      // identical lines: noise that accelerates rotation and buries the one line that matters.
      const idleSignature = idleReasons.signature();
      if (idleSignature !== lastIdleSignature) {
        lastIdleSignature = idleSignature;
        log("daemon.idle_reasons", { tick: ticks, ...idleReasons.snapshot() });
      }

      // ── QUEUE STARVATION (recon oper#queue-starvation-2026-08-03) ──────────────
      // A FAILING run already escalates (`onCircuitBreak` above, once per tripped breaker) —
      // but until now a queue that has run OUT of dispatchable work was indistinguishable in
      // the ledger from a queue that is quietly healthy between tasks: both emitted only
      // `daemon.idle`. The census `idleReasons` already tallies is the data; this is the first
      // reader. STARVED := zero dispatchable (already true, this is the idle branch) AND at
      // least one task filtered by a RECOVERABLE class — circuit-broken, blocked, or
      // unmet-deps, each capable of clearing on its own without the plan changing.
      // `already-merged` and `verify-not-auto` are DELIBERATELY excluded: an all-merged plan
      // is DONE, not starved, and a verify:human task never becomes machine-dispatchable no
      // matter how long the daemon waits — counting either would misreport "nothing left to
      // do" or "everything needs a human anyway" as the SAME starvation this predicate exists
      // to name apart from.
      const idleTally = idleReasons.snapshot();
      // W1-T318: the auto-triage rung's cadence census, read off this SAME idleTally — never a
      // second derivation of runnable. `depth` is the recoverable backlog (blocked + unmet-deps,
      // same two buckets StarvationCensus reads just below); `allMerged` is true only when the
      // tally saw nothing BUT already-merged declines, i.e. the plan is DONE rather than starved
      // — see AutoTriageCensus's doc on why that must not read as "near-empty, go fast".
      const autoTriageCensus: AutoTriageCensus = {
        depth: idleTally.blocked.count + idleTally["unmet-deps"].count,
        allMerged:
          idleTally["already-merged"].count > 0 &&
          idleTally.blocked.count === 0 &&
          idleTally["unmet-deps"].count === 0 &&
          idleTally["verify-not-auto"].count === 0,
      };
      const starvationCensus: StarvationCensus = {
        circuitBroken: bucketFromIds(circuitBrokenThisTick),
        blocked: idleTally.blocked,
        unmetDeps: idleTally["unmet-deps"],
      };
      const starved =
        starvationCensus.circuitBroken.count > 0 ||
        starvationCensus.blocked.count > 0 ||
        starvationCensus.unmetDeps.count > 0;
      if (starved) {
        if (!starvationEscalated) {
          starvationEscalated = true;
          // Same backstop discipline as `onCircuitBreak`/`onHeadroomBreach` above: a failed
          // notification costs one logged line, never the daemon's liveness.
          try {
            await deps.onStarvation?.(starvationCensus);
          } catch (e) {
            log("daemon.escalation.failed", { task: "daemon", error: String((e as Error)?.message ?? e) });
          }
        }
      } else {
        // Nothing recoverable is blocking this tick — re-arm, so a LATER starvation episode
        // (new recoverable blockers, after this one cleared) escalates again rather than
        // staying silenced for the rest of this process's life.
        starvationEscalated = false;
      }

      // ── AUTO-TRIAGE RUNG (impl-DJ, recon-DC #2) ────────────────────────────────
      // The daemon's SECOND work-generating rung, and the first that fires on IDLE rather than on
      // CADENCE — recon-DC's critique of the retro is precisely that it "fires on cadence, not on
      // idle". Placed HERE, inside the idle branch, because this is the one point where "nothing
      // is dispatchable and nothing is in flight" is ALREADY known: the boolean is free, nothing
      // is recomputed, and an idle poll costs exactly what it cost before.
      //
      // DEFAULT OFF and triple-bounded (enabled / adaptive interval / maxPerDay — see
      // lib/auto-triage.ts). Best-effort in the retro's idiom: a throw here costs one logged
      // tick, never the daemon.
      if (deps.checkAutoTriage) {
        let decision: AutoTriageDecision | undefined;
        try {
          decision = deps.checkAutoTriage(autoTriageCensus);
        } catch (e) {
          log("auto_triage.check_failed", { error: String((e as Error)?.message ?? e) });
        }
        if (decision?.fire) {
          // IN-FLIGHT GUARD (W1-T300, the #1184/#1185 duplicate-triage race): the SAME shape as
          // the task lane's `isOpenPr`/`readLiveState` pair above, keyed on feedback id instead of
          // task id. `decideAutoTriage` only knows the entry's own `status: new` — it cannot see an
          // already-open PR carrying this id's `origin: feedback#<id>` provenance, so that read
          // happens here, right before the fire it would otherwise duplicate.
          const openPrNumber = deps.isFeedbackOpenPr?.(decision.feedbackId);
          let inFlight = openPrNumber !== undefined;
          if (inFlight && openPrNumber !== undefined) {
            // W1-T177's confirming-read discipline, applied verbatim: a cached OPEN can be stale
            // (merged/closed since), so a fresh read stands the guard down rather than parking the
            // entry forever on yesterday's snapshot.
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
            // LEDGERED refusal naming the id and the open PR number (design's clause 3) — a silent
            // skip here is indistinguishable from the starvation W1-T298 is about.
            log("auto_triage.skipped_inflight", {
              feedback: decision.feedbackId,
              pr_number: openPrNumber,
              reason: "an open triage PR already carries this feedback id's provenance",
            });
          } else {
            log("auto_triage.fired", { feedback: decision.feedbackId, reason: decision.reason });
            if (deps.runAutoTriage) {
              const fired = decision;
              try {
                // W1-T276's wrapper, reused verbatim. Triage holds for MINUTES after opening its PR
                // (a CI-polling tail) and this loop is single-threaded, so an unwrapped await would
                // black out every sweep for that whole duration — the exact defect W1-T276 fixed for
                // the retro. The ticker keeps dispositioning PRs while triage runs.
                await sweepLightDuringRetro(deps, pollIntervalMs, log, () => deps.runAutoTriage!(fired.feedbackId));
              } catch (e) {
                log("auto_triage.run_failed", {
                  feedback: fired.feedbackId,
                  error: String((e as Error)?.message ?? e),
                });
              }
            }
          }
        } else if (decision) {
          log("auto_triage.skipped", { reason: decision.reason });
        }
      }

      await deps.sleep(pollIntervalMs);
      continue;
    }

    // A dispatchable task ends any starvation episode — re-arm so a LATER one escalates again.
    starvationEscalated = false;

    // W1-T342/W1-T343 — THE PER-LANE GOVERNOR GATE, adopted verbatim from `runDrainLanes`
    // (drain.ts, see its own doc). A SEQUENTIAL loop that takes its OWN fresh
    // `checkDispatchGovernors` reading per candidate — never one reading admitting the whole
    // batch — so a ceiling crossed between lane 1 and lane 2 refuses lane 2 without touching
    // lane 1 (`break` stops ADMITTING; it never revokes a lane already admitted). At
    // `dispatchSet.length === 1` (every `laneCount <= 1` tick) this loop runs exactly once,
    // taking exactly the one reading the pre-W1-T343 loop always took at this exact point in
    // the tick — the SAME provable no-op change in observable behaviour W1-T342 already
    // documented here, now discharged rather than merely promised.
    const admitted: Task[] = [];
    let deferredVerdict: DispatchGovernorVerdict | undefined;
    for (const t of dispatchSet) {
      const verdict = checkDispatchGovernors(deps, dailyCostCeilingUsd);
      if (verdict) {
        deferredVerdict = verdict;
        if (dispatchSet.length > 1) {
          // A DISTINCT step from `dispatch.wip_deferred` above (a governor SIZING the batch
          // before any candidate was even selected): this is a governor refusing admission
          // MID-BATCH, after some lanes already got in. Never logged at `laneCount <= 1` — a
          // solo dispatch's deferral is `logDispatchGovernorDefer`'s line, unchanged, below.
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
      await deps.sleep(pollIntervalMs);
      continue;
    }

    if (dispatchSet.length > 1) {
      // Mirrors `runDrainLanes`' `dispatch.concurrent_set` — the evidence trail P19's banked
      // rung 2 needs. Never fires at `laneCount <= 1` (today's tick never had this line).
      log("dispatch.concurrent_set", { tasks: admitted.map((t) => t.id), lane_count: laneCount });
    }
    for (const t of admitted) {
      log("daemon.iteration", { task: t.id, attempted: attempted.length + 1, max: opts.max ?? null });
      attempted.push(t.id);
    }

    // W1-T254 (the #707 fix) — LIGHT-SWEEP TICKER: while admitted lanes are
    // unbounded and in flight, tick the restricted light sweep on the SAME
    // injected clock/cadence idle polling uses, so a PR that goes
    // green-but-review-absent mid-batch re-posts within one poll interval
    // instead of sitting invisible until every lane finally returns. See
    // `DaemonDeps.sweepLight`'s doc for the full rationale.
    // Cleared once every admitted lane settles, on EVERY exit path (success, a fatal
    // throw, or a degraded spawn-infra throw) — never left running past it, and never
    // aborted mid-call (a sweepLight() already in flight is allowed to finish before
    // the ticker stops). It also emits this dispatch's `daemon.alive` liveness rows —
    // see {@link startInFlightTicker} for why that row exists and why it is prefixed.
    const stopTicker = startInFlightTicker(deps, pollIntervalMs, log, "dispatch").stop;

    // CONCURRENT DISPATCH (W1-T343, mirrors `runDrainLanes` exactly): `allSettled`, never
    // `all` — a sibling lane's rejection must never abort another lane already in flight;
    // every lane's outcome is recorded below BEFORE this tick decides anything
    // (LANE-LOCAL BLOCK SEMANTICS). At `admitted.length === 1` this is
    // `Promise.allSettled([deps.runOne(next.id)])`, which settles on the exact same
    // schedule a bare `await deps.runOne(next.id)` inside a `try`/`catch` would — no
    // observable timing change from before this task.
    const settled = await Promise.allSettled(admitted.map((t) => deps.runOne(t.id)));
    // THE SETTLED COUNTERPART to `dispatch.concurrent_set` above. Emitted BEFORE `stopTicker()` and
    // before the classification loop: that loop's fatal-error path returns, and `stopTicker` is
    // itself awaited work that could throw, so anything later would be lost in precisely the
    // failure cases this row exists to report. `allSettled` never rejects. See `settledSetPayload`.
    log("dispatch.settled_set", settledSetPayload(admitted, settled, laneCount));
    await stopTicker();

    // CLASSIFY EVERY LANE'S SETTLEMENT before this tick decides anything — mirrors
    // `runDrainLanes`' own "every sibling's outcome is recorded before the pass decides"
    // discipline. A GENUINE (non-spawn-infra) throw is fatal for the whole daemon, exactly
    // as it always was for the lone dispatch; a spawn-infra throw degrades (backoff, never a
    // crash); a normal settlement is queued for the SAME block-reasoning every dispatch has
    // always gone through, via `processDispatchResult` above.
    let fatalError: { taskId: string; message: string } | undefined;
    let spawnInfraSeenThisTick = false;
    const toProcess: Array<{ task: Task; result: RunResult }> = [];
    for (let i = 0; i < admitted.length; i++) {
      const t = admitted[i];
      const outcome = settled[i];
      if (outcome.status === "rejected") {
        const err = outcome.reason;
        if (!isSpawnInfraBlocked(err)) {
          // First-observed wins the summary detail — mirrors `runDrainLanes`' identical choice
          // for `drain.lane_error`. Every OTHER already-settled lane is still classified and
          // (below) processed before this tick returns.
          if (!fatalError) fatalError = { taskId: t.id, message: String((err as Error)?.message ?? err) };
          continue;
        }
        // DEGRADE, DON'T DIE (W1-T113 part iii, the vanished-binary incident): a
        // spawn-INFRASTRUCTURE failure is never a fatal crash — the pre-fix shape
        // was error -> process exit -> launchd KeepAlive restart -> the identical
        // failure again, five consecutive polls, zero escalations, zero backoff.
        // Escalate ONCE per distinct cause (content-keyed, W1-T104 discipline) —
        // counted ONCE per TICK (not per lane) below, so a batch where two lanes hit
        // the SAME toolchain outage in the SAME tick backs off like one bad tick, not
        // two, preserving the backoff curve's "consecutive TICKS" meaning.
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
      return summary("error", `${fatalError.taskId}: ${fatalError.message}`);
    }

    // A successful (non-throwing) lane — including one that returns a non-spawn-infra
    // blocked verdict — clears the backoff streak, exactly as the lone dispatch always did.
    if (toProcess.length > 0) consecutiveSpawnInfraFailures = 0;

    // BLOCK-REASONING, PER LANE — `processDispatchResult` (defined above) is the SAME
    // function whether this tick held one lane or several; see its own doc for why it
    // returns a disposition instead of returning out of the loop directly. First-observed
    // genuine blocker wins the summary detail (mirrors `fatalError`'s choice above and
    // `runDrainLanes`' stop-on-block-at-pass-granularity doctrine) — but every lane's own
    // bookkeeping (retry state, fix dispatch, independent-failure flag, merge) still runs.
    let blockedDetail: string | undefined;
    for (const { task, result } of toProcess) {
      const outcome = await processDispatchResult(planForBatch, task, result);
      if (outcome.kind === "genuine_blocker" && blockedDetail === undefined) {
        blockedDetail = outcome.detail;
      }
    }
    if (blockedDetail !== undefined) {
      return summary("blocked", blockedDetail);
    }

    if (spawnInfraSeenThisTick && toProcess.length === 0) {
      // The WHOLE tick was spawn-infra trouble and nothing else progressed — back off
      // exactly as the lone dispatch always did. A tick that mixes spawn-infra with real
      // progress (`toProcess.length > 0`) does NOT back off: the toolchain evidently still
      // works for at least one lane, so the counter was already reset above and this tick
      // falls through to loop again immediately, same as an all-progress tick would.
      ticks++;
      consecutiveSpawnInfraFailures++;
      const backoffMs = Math.min(pollIntervalMs * 2 ** (consecutiveSpawnInfraFailures - 1), maxSpawnInfraBackoffMs);
      log("daemon.spawn_infra_backoff", { tick: ticks, backoff_ms: backoffMs, consecutive: consecutiveSpawnInfraFailures });
      await deps.sleep(backoffMs);
    }
  }
}

// ── crash recovery (W1-T12c) ────────────────────────────────────────────────
//
// A daemon killed mid-task (power loss, `kill -9`, a host reboot — the live
// chaos drill is W1-T12d) can leave an ORPHANED local run behind: a
// `git worktree` + its `run-<taskId>-<epochMs>` branch (worker.ts's
// `runId = ${taskId}-${Date.now()}`, `branch = run-${runId}`) that no live
// process owns anymore (its inflight-lock.ts pid is dead). Discovering that
// debris is a real filesystem/`git worktree list` walk — the CLI wiring's job
// (same boundary as worker.ts's `pruneStaleRuns`), and OUT of scope here; this
// pure module only reasons about the parsed result.
//
// The one question crash recovery must answer per orphan is: does GitHub know
// about work this task already did? A dead local process is NOT authoritative
// — an open PR may already exist (pushed right before the crash), and
// blindly re-running the task from `nextRunnable` would spawn a SECOND worker
// on top of it UNLESS the caller wires the `isOpenPr` in-flight guard (W1-T80,
// the #143/#145 duplicate-build race) — belt-and-suspenders here: crash
// recovery reasons about the orphan directly rather than depending on that
// guard alone. So state is reconstructed from git (which task/run the orphan belonged to)
// + GitHub + the ledger (status.ts's `deriveStatus`, reused wholesale, never
// reimplemented — same three-source precedence `rmd drain`/`rmd run-task`
// already trust) — never from the dead process's local state.

/** A local run a crashed process left behind, as found by `git worktree list`
 * (the CLI wiring's job) and parsed by {@link parseOrphanedBranch}. */
export interface OrphanedRun {
  taskId: string;
  runId: string;
  branch: string;
  worktreePath: string;
}

/** `resume`: GitHub already has a live PR for this task — do not respawn.
 *  `clean`: no surviving GitHub artifact (or the task is already merged) —
 *  the local worktree/branch is stale debris, safe to discard. */
export type RecoveryAction = "resume" | "clean";

export interface RecoveredTask extends OrphanedRun {
  action: RecoveryAction;
  detail: string;
  prUrl?: string;
}

/**
 * Parse a `run-<taskId>-<epochMs>` branch name back into its task + run id.
 * Splits at the LAST `-` (task ids may themselves contain hyphens, e.g.
 * `W1-T12c`), only accepting the split when the trailing segment is all
 * digits (an epoch-ms timestamp) — anything else (a retro/review run's
 * branch, e.g. `run-RETRO-<epochMs>` or `run-review-PR9-<epochMs>`, which is
 * not task-scoped) is not an orphaned TASK run and returns null.
 */
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

/**
 * Reconstruct ONE orphan's fate from its task's GitHub-derived projection.
 * `deriveTaskStatus` is the caller's `status.ts` `deriveStatus`, scoped to
 * this task id — this function adds NO new GitHub/ledger logic, it only maps
 * the EXISTING precedence-derived projection onto a recovery verb:
 *
 *   - status `running` (an OPEN PR) ⇒ "resume": GitHub, not the dead local
 *     process, is the task's true state. The orphaned worktree/branch is left
 *     untouched (not cleaned) — it is the original working tree behind that
 *     PR, in case anything downstream needs it.
 *   - `merged`, `blocked` (PR closed without merging), or no evidence at all
 *     ⇒ "clean": the task is either already done, or never produced a
 *     surviving GitHub artifact — either way the local worktree/branch is
 *     pure debris. When not merged, the task is left for `nextRunnable` to
 *     pick up fresh (a normal, from-scratch run) on the daemon's next tick.
 */
export function reconstructOrphan(
  orphan: OrphanedRun,
  deriveTaskStatus: (taskId: string) => StatusProjection,
): RecoveredTask {
  const projection = deriveTaskStatus(orphan.taskId);
  // W1-T155: `status: "running"` no longer implies a PR exists — deriveStatus now also
  // reports "running" for a ledger-in-flight run that has not opened a PR yet (recon/
  // implement phase). Only an actual OPEN PR is resumable; the `&& projection.prUrl`
  // guard is a no-op for every PRE-EXISTING "running" case (that always carried a
  // prUrl already) and correctly falls through to the "clean" branch below — the SAME
  // "no surviving GitHub artifact" outcome this orphan would have gotten pre-W1-T155 —
  // for the new no-PR-yet in-flight case.
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
