/**
 * lib/daemon.ts — the daemon's scheduler-loop CORE (W1-T12a).
 *
 * W1-T12 (Daemonize) was split along the machine/human boundary (DIAGNOSIS.md,
 * Rule 16): this is the headless, unit-testable LOGIC half. Launchd unit
 * generation is W1-T12b (lib/launchd.ts); crash-recovery reconstruction is
 * W1-T12c (`reconstructState`, below); actually loading the plist on a real
 * session, an overnight drain, and a live kill-and-recover are the
 * verify:human commissioning steps of W1-T12d — none of that is here.
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

import type { RunResult } from "./run-result.js";
import { assertCleanBoot, type BootAssertion } from "./env.js";
import { INITIAL_RETRY_STATE, reasonAboutBlock, type RetryState } from "./block-reason.js";
import { nextRunnable, type MergedSet, type OpenPrCheck } from "./drain.js";
import { HEADROOM_LIMIT_PCT } from "./headroom.js";
import type { UsageSnapshot } from "./headroom.js";
import type { Plan, Task } from "./plan.js";
import type { StatusProjection } from "./status.js";

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
 */
export type DaemonStopReason = "stopped" | "blocked" | "max_reached" | "error";

/** Default idle-poll pace: check back once a minute while nothing is runnable. */
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
 * nothing to see" ⇒ 0. Every other reason — `blocked` and `error` — is
 * nonzero so a supervisor (or launchd's KeepAlive, W1-T12b) restarts. This
 * is exactly why neither headroom exhaustion NOR pause can be allowed to
 * reach this function as a `DaemonStopReason` at all (see that type's doc,
 * above): each would either wrongly map to 0 (silence — permanently dead
 * until a manual reload) or wrongly map to 1 (a relaunch storm — ~86s for
 * headroom, ~10s for the 2026-07-22 paused storm) — both wrong, because an
 * awaiting-state is neither a clean stop nor a crash. Both are handled
 * entirely inside the loop below instead, and never become return values.
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
  if (hoursToReset === null || !Number.isFinite(hoursToReset)) {
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
 * The daemon's OWN headroom check — deliberately NOT `headroom.ts`'s exported
 * `headroomExhausted` (still used unchanged by `rmd drain`, which stays on
 * the flat `HEADROOM_LIMIT_PCT` ceiling; a human-invoked bounded drain is not
 * this task's concern and touching it is out of scope). This version applies
 * the TIME-AWARE ceiling (see {@link HeadroomPolicy}) PER WINDOW — each
 * window's own hours-to-reset resolves ITS OWN limit, since the 5-hour
 * session window and a weekly cap reset on entirely different clocks.
 */
function daemonHeadroomExhausted(snap: UsageSnapshot, now: Date, policy: HeadroomPolicy): ResolvedWindow | null {
  const windows: Array<{ window: string; percentUsed: number; resetsAt: string }> = [
    { window: "session (5h)", percentUsed: snap.session.percentUsed, resetsAt: snap.session.resetsAt },
    ...snap.weekly.map((w) => ({ window: `weekly (${w.label})`, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
  ];
  const resolved: ResolvedWindow[] = windows.map((w) => {
    const instant = parseResetInstant(w.resetsAt, now);
    const hoursToReset = instant ? (instant.getTime() - now.getTime()) / 3_600_000 : null;
    return {
      ...w,
      resetsAtDisplay: instant ? formatResetInstant(instant) : w.resetsAt,
      limitPct: resolveHeadroomLimitPct(hoursToReset, policy),
    };
  });
  const over = resolved.filter((w) => w.percentUsed >= w.limitPct).sort((a, b) => b.percentUsed - a.percentUsed);
  return over[0] ?? null;
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
 * time — hence a BOUNDED allowance, not an immediate halt. */
export const DEFAULT_UNREADABLE_DEGRADED_LIMIT = 3;

export interface DaemonOpts {
  /**
   * Optional iteration cap (a bounded supervised run, or a test). Absent ⇒
   * unbounded — the real daemon runs until STOP, a block, or headroom.
   */
  max?: number;
  /** Idle-poll pace in ms when nothing is currently runnable (default {@link DEFAULT_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
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
   * Called once per task whose circuit breaker trips this tick — the real
   * command escalates ONE (deduped) needs-human issue naming the loop, mirroring
   * `escalateBlock` below.
   */
  onCircuitBreak?: (task: Task) => void;
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
  /** Read current /usage; `undefined` ⇒ unavailable (headroom check is skipped). */
  readUsage?: () => UsageSnapshot | undefined;
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
}

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
): BootAssertion {
  const assertion = assertCleanBoot(env);
  log("daemon.boot", { env_clean: assertion.env_clean, billing_mode: assertion.billing_mode });
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
  return assertion;
}

/**
 * The daemon's scheduler loop. Deterministic; no LLM decisions. Each tick:
 * check STOP → check PAUSE → check headroom → pick the next runnable (DAG
 * order, reusing drain.ts's `nextRunnable` — never reimplemented) → run it →
 * REASON about any non-merged verdict (W1-T46, superseding v1's blunt
 * stop-on-block): transient retries (no strike), an independent failure is
 * flagged + skipped while the rest of the drain continues, a genuine blocker
 * halts + escalates. When nothing is runnable OR headroom is exhausted, sleep
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
  const attempted: string[] = [];
  const merged: string[] = [];
  let costUsd = 0;
  let ticks = 0;
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
  // BOUNDED DEGRADED MODE (recon R-7: the live ledger shows /usage unreadable
  // ~78% of the time — an unconditional fail-closed-on-first-miss would halt
  // the fleet most of the time, so this counts CONSECUTIVE misses instead of
  // treating any single one as decisive). Reset to zero by any successful
  // read; escalates to the in-process idle heartbeat once it exceeds
  // `unreadableDegradedLimit` — see the headroom check below.
  let consecutiveUnreadable = 0;
  const headroomPolicy = opts.headroomPolicy ?? buildDefaultHeadroomPolicy(opts.headroomLimitPct);
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? DEFAULT_UNREADABLE_DEGRADED_LIMIT;
  const now = deps.now ?? (() => new Date());

  const summary = (stopReason: DaemonStopReason, stopDetail?: string): DaemonSummary => {
    const s: DaemonSummary = { attempted, merged, stopReason, stopDetail, costUsd, ticks };
    log("daemon.summary", { ...s });
    return s;
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
        const over = daemonHeadroomExhausted(snap, now(), headroomPolicy);
        if (over) {
          ticks++;
          log("daemon.headroom", {
            tick: ticks,
            window: over.window,
            percent_used: over.percentUsed,
            limit_pct: over.limitPct,
            resets_at: over.resetsAtDisplay,
            poll_interval_ms: pollIntervalMs,
          });
          await deps.sleep(pollIntervalMs);
          continue;
        }
      } else {
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
      }
    }

    const next = nextRunnable(plan, isMerged, {
      isOpenPr: deps.isOpenPr,
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
        log("dispatch.indeterminate", { task: t.id });
        deps.onIndeterminate?.(t);
      },
      isCircuitTripped: deps.isCircuitTripped,
      // CIRCUIT BREAKER (P29(ii)): a legible ledger line every tick it is
      // consulted — but the caller's own escalation hook fires AT MOST ONCE
      // per task id for this daemon run (`circuitEscalated`, above) — the
      // daemon keeps polling everything else rather than halting the whole
      // loop, and never re-escalates a task it already escalated.
      onCircuitBreak: (t) => {
        log("dispatch.circuit_broken", { task: t.id });
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
    });
    if (!next) {
      // UNLIKE drain.ts (where `no_runnable` is a terminal stop): the daemon is
      // PERSISTENT — new work can land later, so it paces itself with the
      // injected clock and keeps polling rather than exiting.
      ticks++;
      log("daemon.idle", { tick: ticks, poll_interval_ms: pollIntervalMs });
      await deps.sleep(pollIntervalMs);
      continue;
    }

    log("daemon.iteration", { task: next.id, attempted: attempted.length + 1, max: opts.max ?? null });
    attempted.push(next.id);

    // W1-T254 (the #707 fix) — LIGHT-SWEEP TICKER: while THIS `runOne` is
    // unbounded and in flight, tick the restricted light sweep on the SAME
    // injected clock/cadence idle polling uses, so a PR that goes
    // green-but-review-absent mid-run re-posts within one poll interval
    // instead of sitting invisible until runOne finally returns. See
    // `DaemonDeps.sweepLight`'s doc for the full rationale.
    let tickerActive = true;
    const ticker = deps.sweepLight
      ? (async () => {
          while (tickerActive) {
            await deps.sleep(pollIntervalMs);
            if (!tickerActive) break;
            try {
              await deps.sweepLight!();
            } catch (e) {
              log("daemon.sweep_light.failed", { error: String((e as Error)?.message ?? e) });
            }
          }
        })()
      : undefined;

    let result: RunResult;
    try {
      result = await deps.runOne(next.id);
    } catch (e) {
      tickerActive = false;
      if (ticker) await ticker;
      return summary("error", `${next.id}: ${String((e as Error)?.message ?? e)}`);
    }
    // Cleared once runOne settles — never left running past it, and never
    // aborted mid-call (a sweepLight() already in flight is allowed to
    // finish before the ticker stops).
    tickerActive = false;
    if (ticker) await ticker;
    costUsd += result.costUsd;

    if (!result.merged) {
      // BLOCK-REASONING (W1-T46, supersedes v1's blunt stop-on-block): reuse
      // W1-T7's transient/strike taxonomy + the plan's DAG (block-reason.ts)
      // instead of halting on ANY non-merged verdict.
      const state = blockRetryStates.get(next.id) ?? INITIAL_RETRY_STATE;
      const disposition = reasonAboutBlock(plan, next.id, result.verdict, state);

      if (disposition.kind === "retry_transient") {
        // TRANSIENT: no strike. `nextRunnable` naturally retries the SAME
        // task next tick (it is still un-merged and its deps are unchanged) —
        // no separate re-dispatch mechanism needed.
        blockRetryStates.set(next.id, disposition.state);
        log("daemon.block.transient_retry", {
          task: next.id,
          verdict: result.verdict,
          transient_retries: disposition.state.transientRetries,
        });
        continue;
      }
      blockRetryStates.delete(next.id); // resolved one way or another below

      if (disposition.kind === "independent_failure") {
        // INDEPENDENT-FAILURE: nothing in the plan transitively depends on
        // this task, so skipping it cannot leave a dependent building on a
        // gap. Flag it — flip the in-memory `status` so `nextRunnable` never
        // reconsiders it this run — and keep draining everything else.
        next.status = "blocked";
        log("daemon.block.independent_failure", {
          task: next.id,
          verdict: result.verdict,
          pr_url: result.prUrl,
        });
        continue;
      }

      // GENUINE BLOCKER: real downstream work transitively needs this task
      // merged — "never continue into the gap" is absolute here. Halt and
      // escalate, exactly as v1's stop-on-block halted, but now the
      // dependents it protects are named.
      log("daemon.blocked", {
        task: next.id,
        verdict: result.verdict,
        pr_url: result.prUrl,
        dependents: disposition.dependents,
      });
      if (deps.escalateBlock) {
        await deps.escalateBlock({ task: next, result, dependents: disposition.dependents });
      }
      return summary(
        "blocked",
        `${next.id} → ${result.verdict}${result.prUrl ? ` (${result.prUrl})` : ""} — blocks ${disposition.dependents.join(", ")}`,
      );
    }
    merged.push(next.id);
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

/**
 * The daemon's boot-time recovery pass (W1-T12c): reconstruct every orphaned
 * local run's fate, in order, logging one `daemon.recover` ledger line each.
 * Pure over its injected `deriveTaskStatus` — no filesystem, no git, no
 * GitHub call lives in this module (same discipline as the rest of daemon.ts);
 * the CLI wiring supplies the orphan list (a `git worktree list` walk) and a
 * `status.ts`-backed `deriveTaskStatus`, and owns the actual worktree/branch
 * cleanup that `action: "clean"` recommends.
 */
export function reconstructState(
  orphans: OrphanedRun[],
  deriveTaskStatus: (taskId: string) => StatusProjection,
  log?: (step: string, extra?: Record<string, unknown>) => void,
): RecoveredTask[] {
  return orphans.map((orphan) => {
    const recovered = reconstructOrphan(orphan, deriveTaskStatus);
    log?.("daemon.recover", {
      task: recovered.taskId,
      run_id: recovered.runId,
      action: recovered.action,
      detail: recovered.detail,
    });
    return recovered;
  });
}
