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
// W1-T343 (ADOPT DRAIN'S LANE MACHINERY, NEVER A SECOND IMPLEMENTATION): the SAME pure
// overlap partition `runDrainLanes` (drain.ts) already composes with `runnableCandidates`/
// `laneDispatchBudget` above — reused here verbatim rather than re-derived.
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
// W1-T372: TYPE ONLY (erased at build — no runtime edge added to daemon-health.ts, which
// already imports a VALUE from this module; a value import here would be a real cycle, a
// type-only one is not). See daemon-health.ts's `readGhRateLimitBuckets` for the reader this
// shape belongs to — this pure module never shells `gh` itself, exactly as it never touches
// the filesystem (this file's own header).
import type { GhRateLimitBuckets } from "./daemon-health.js";
import type { CostGovernorResult, QueueGovernorResult } from "./sweep.js";
// W1-T2379: a VALUE import, unlike the type-only line above. Safe: `sweep.ts` imports nothing
// from this module, so this edge closes no cycle (contrast the daemon-health note above, where a
// value import WOULD). See `drainDetachedSweepActions`' own doc for what it drains and why.
import { drainDetachedSweepActions } from "./sweep.js";
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
// Type-only (erased at build) — same discipline as OrphanSweepReport above.
// `LandFeedbackResult` only shapes the `sweepFeedbackLanding` boot param and
// `DaemonDeps.sweepFeedbackLanding` injection points below (W1-T530).
import type { LandFeedbackResult } from "./feedback-landing.js";
// Type-only (erased at build) — W1-T1040's GitHub-side posture drift finding shape, defined once
// in github-posture.ts and reused here so DaemonDeps.checkGithubPosture never re-declares it.
// This module stays a PURE, filesystem-free module at runtime (file header) — the real read +
// baseline diff live in run-task.ts's wiring, exactly like checkRetroTrigger/checkAutoTriage.
import type { GithubPostureFinding } from "./github-posture.js";

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
 * W1-T1044 (A SWEEP TICK HAS NO WALL-CLOCK BOUND): the DEFAULT bound on `await deps.sweep()`
 * below — mirrors plan/policy.yaml's `sweepWallClockBoundMs` row (net-new; the measured
 * healthy-vs-hung derivation lives in that file's comment). Same fs-free-safety-net reasoning
 * as {@link DEFAULT_POLL_INTERVAL_MS} immediately above: this pure module cannot load
 * `plan/policy.yaml` itself, so this literal is the default for a direct/test caller that
 * supplies no `DaemonOpts.sweepWallClockBoundMs`; the real `rmd daemon` entry
 * (`daemonCommand`, run-task.ts) threads `policy.values.sweepWallClockBoundMs` explicitly.
 */
export const DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS = 559_000;

/**
 * W1-T1272 (THE FULL SWEEP IS UNREACHABLE AFTER A BOOT'S FIRST ITERATION): the DEFAULT minimum
 * gap, in ms, between two full-sweep runs triggered by the RETRIGGER below (never the
 * once-per-iteration call at the top of the loop, which this bound does not throttle). Without
 * a re-trigger, `deps.sweep()` only ran once at the top of an iteration and the loop's own
 * freshness exit — the ONLY other thing that starts a full sweep (task rationale (2)) — fires
 * only when origin/main has already moved past this process's boot sha, so a boot whose
 * dispatch/retro holds the loop for its own measured mean of 38.5 minutes got exactly one full
 * sweep for that whole span. 20 minutes gives ~3 passes an hour, which task design (i) prices at
 * a p90-cost of about 67 seconds an hour (under 4%) — cheap enough that FREQUENCY, not
 * concurrency, is the right lever; this constant raises how often the gate is reached.
 *
 * ⚠ W1-T2569 CORRECTION — THE CLAUSE THAT USED TO FOLLOW HERE WAS FALSE. It read "never how many
 * run at once (see `sweep still runs one at a time`, the same mutex-serialized `deps.sweep()`
 * every other call site already awaits sequentially)". SWEEPS DO OVERLAP, and not because of this
 * constant: {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS} immediately above stops AWAITING
 * `deps.sweep()` at 559s and does NOT CANCEL it, so any sweep whose work exceeds that bound keeps
 * running detached while the next iteration starts another. "Awaits sequentially" describes the
 * call sites; it does not describe the lifetimes. MEASURED 2026-09-01: six consecutive
 * batch/abandon alternations in the inbox-draft rung, `elapsed_ms: 559000` against
 * `bound_ms: 559000`, costing $123.30 in duplicated Architect spawns.
 *
 * ⚠ W1-T2582 UPDATE — THE PROPERTY IS TRUE AGAIN, BUT FOR A DIFFERENT REASON THAN THIS COMMENT
 * ONCE GAVE. It is NOT "the same mutex-serialized deps.sweep() every other call site already
 * awaits sequentially" — that was never what serialized anything. It is {@link SweepLiveness}:
 * `runGatedSweep` now DECLINES to start a pass while a previous one is still executing, a flag set
 * on start and cleared on SETTLE rather than on abandon. The bound still fires and still stops
 * awaiting; the abandoned pass still runs to completion untouched; only the duplicate is refused.
 * THE RETRIGGER IS COVERED BY THE SAME FLAG — it was a SECOND route in, and one the bound never
 * touched: measured, the last two pre-fix draft batches were 20m27s apart, this interval, not 559s.
 *
 * THE CLASS THAT WAS. Every sweep-borne rung whose work can exceed 559s used to be re-entrant by
 * this mechanism; drafting was merely the one that spent per re-entry ($123.30 in duplicated
 * Architect spawns, measured 2026-09-01). The inbox-draft rung ALSO holds its own O_EXCL lock
 * (run-task.ts, W1-T2569) and keeps it: that lock additionally excludes `rmd inbox` and survives a
 * restart, neither of which an in-process flag can do. Same fs-free-safety-net
 * reasoning as {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS} immediately above: this pure module
 * cannot load `plan/policy.yaml` itself, so this literal is the default for a direct/test caller
 * that supplies no `DaemonOpts.sweepRetriggerIntervalMs`.
 */
export const DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS = 20 * 60_000;

/**
 * The exit code a FRESHNESS self-restart uses, distinct from a crash's 1 (W1-T490).
 *
 * 75 is `EX_TEMPFAIL` from sysexits(3) — "temporary failure, the user is invited to
 * retry" — which is precisely what a `stale` stop is: nothing is wrong, the process
 * simply needs to come back on newer code. Any nonzero value would work for docker
 * (it reads only zero/nonzero); a conventional one is chosen so an operator reading
 * `docker inspect --format '{{.State.ExitCode}}'` by hand gets a meaning rather than
 * a magic number.
 *
 * THE VALUE IS DUPLICATED IN `deploy/entrypoint.sh`, DELIBERATELY, AND A TEST PINS
 * THE PAIR. The entrypoint cannot import this module: it runs at the exact moment
 * the daemon has failed, and its own restart-throttle block already records why it
 * refuses to depend on the repo being loadable then ("Reading it here instead would
 * need the plan loadable at exactly the moment an unloadable plan is what is
 * crashing the daemon — the measured incident"). A shell literal that silently
 * drifts from this constant would reinstate the whole defect while every unit test
 * stayed green, so `test/entrypoint-boot.test.ts` greps the script for this number
 * and fails if the two disagree.
 */
export const DAEMON_EXIT_STALE = 75;

/**
 * W1-T2537 — THE `blocked` EXIT CODE, THE OTHER HALF OF W1-T490.
 *
 * W1-T490 separated `stale` from 1 because docker's `--restart=on-failure:N` counts every
 * non-zero exit against N and cannot read the value, so a ROUTINE outcome spent the same finite
 * budget as a crash. It then wrote that "`blocked` and `error` keep 1 precisely so that a crash
 * remains countable" — and that is where this defect lived. `error` IS a crash and keeps 1.
 * `blocked` is the daemon COMPLETING a drain pass and reporting that a task is blocked.
 *
 * MEASURED 2026-08-30: a pass dispatched three tasks, opened three PRs and posted five review
 * verdicts, then exited 1 because one of them ended `blocked_ci`. The container sat
 * `Exited (1)` for 46+ minutes with nothing draining the board. The loop is self-sustaining: a
 * red board is exactly what PRODUCES blocked passes, so the restart budget is spent fastest
 * precisely when the fleet is most needed, and once spent nothing drains — which keeps the board
 * red. On a green board `blocked` is rare and none of this is visible.
 *
 * THE FREQUENCY ARGUMENT RUNS THE OTHER WAY FROM W1-T490's. Freshness restarts were one per
 * merge (14 in 24 hours) and that was already enough to exhaust `on-failure:5` in half a day.
 * A blocked pass is one per PASS on a red board.
 *
 * AS WITH `stale`, THIS FUNCTION ONLY MAKES THE CASE DISTINGUISHABLE; the accounting is
 * `deploy/entrypoint.sh`'s. And as with `stale`, this is strictly a refinement WITHIN non-zero:
 * launchd's `KeepAlive{SuccessfulExit:false}` and a bare `--restart=on-failure` with no
 * entrypoint support both still restart exactly as they did. An entrypoint that predates this
 * constant — the BAKED half of the split, inert until an image rebuild — sees an unrecognised
 * non-zero code and falls through to the same sleep-and-exit it uses today, so merging this
 * ahead of the rebuild changes nothing rather than regressing anything.
 *
 * THE DAEMON'S STOP-ON-BLOCK DOCTRINE IS UNTOUCHED. `runDrainLanes`' stop-on-block-at-pass-
 * granularity is deliberate and stays; only how that halt is classified at the process boundary
 * changes, which is the one thing a supervisor can see.
 */
export const DAEMON_EXIT_BLOCKED = 76;

/**
 * W1-T2546 — A PASS KILLED BY AN ENVIRONMENTAL REFUSAL, which is a THIRD thing that is not a
 * crash. Same argument {@link DAEMON_EXIT_BLOCKED} already won for `blocked`, one category over.
 *
 * OBSERVED 2026-08-31 18:42-18:44 UTC in the operator's own daemon log: two PRs (#3428, #3429)
 * had already been opened successfully and the run died READING ONE BACK —
 * `Command failed: gh api repos/.../pulls/3428 ... API rate limit exceeded ... (HTTP 403)`. That
 * surfaced as `stopReason: "error"`, mapped to 1, and docker's `on-failure` counted the restart.
 * Nothing about the tree, the plan or the code was wrong; the correct response was to WAIT, which
 * is exactly what this container already knows how to do for the other two non-crash codes.
 *
 * WHY IT MATTERS BEYOND TIDINESS: this account's GraphQL budget is exhausted routinely, and a
 * 90-minute secondary-limit lockout has already happened once. During such a window EVERY pass
 * can die this way, so the crash budget drains at the rate the limiter refuses — and once it is
 * gone the fleet is dead with a red board and no failing check to explain it.
 *
 * THE DECISION IS DELEGATED, NEVER RE-DERIVED HERE. {@link daemonExitCode} asks
 * `classifyFailure` — the repo's ONE failure classifier, which already reads rate-limit
 * backpressure, 5xx, transport faults and runner loss as `"transient"` — rather than carrying a
 * fourth copy of those signatures. So a reworded provider message is a one-place fix, and this
 * code can never disagree with the classifier the retry path already trusts.
 *
 * FAIL-CLOSED IN THE SAFE DIRECTION: anything the classifier does not positively call transient
 * stays `error` ⇒ 1 and is counted, so this can only ever NARROW what counts as a crash.
 */
export const DAEMON_EXIT_ENVIRONMENTAL = 77;

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
 *
 * ── W1-T490: `stale` NOW CARRIES ITS OWN CODE, BECAUSE THE CALLER THAT NEEDS TO
 * TELL IT APART CANNOT SEE ANYTHING ELSE ──────────────────────────────────────
 *
 * The mapping above collapsed FIVE reasons onto two codes, so `blocked`, `error`
 * and `stale` were indistinguishable at the process boundary. That is fine for
 * launchd — `KeepAlive{SuccessfulExit:false}` restarts on any nonzero and wants
 * to — but it is NOT fine for the container, where the restart budget is finite:
 * docker's `--restart=on-failure:N` counts every nonzero exit against N and
 * MEASURED (Azure, 2026-08-14, docker 29.1.3) cannot read the value at all —
 * `exit 1` and `exit 42` both parked at `RestartCount=2` on `on-failure:2`,
 * while `exit 0` did not restart. So a routine freshness restart — one per merge,
 * 14 in 24 hours — spent the same budget as a crash, and no amount of healthy
 * running refunded it (three containers exiting after 0s, 20s and 120s of clean
 * work all parked permanently). The measured consequence was a 2h56m outage that
 * only a human ended.
 *
 * SINCE DOCKER CANNOT READ THE CODE, THE ENTRYPOINT READS IT INSTEAD. This
 * function's job is only to make the two cases DISTINGUISHABLE; the accounting
 * is `deploy/entrypoint.sh`'s (see its freshness-restart block, which re-runs the
 * bootstrap so the staleness actually clears, and still exits for a real crash so
 * `on-failure:N` keeps bounding a crash loop). {@link DAEMON_EXIT_STALE} is the
 * one name both halves share.
 *
 * NOTHING ELSE CHANGES POLARITY. `stale` stays NONZERO, so launchd's KeepAlive and
 * a bare `--restart=on-failure` with no entrypoint support both still restart
 * exactly as they did — this is strictly a refinement WITHIN nonzero, not a move
 * across the zero boundary. `blocked` and `error` keep 1 precisely so that a
 * crash remains countable.
 */
export function daemonExitCode(stopReason: DaemonStopReason): number {
  if (stopReason === "stopped" || stopReason === "max_reached") return 0;
  if (stopReason === "stale") return DAEMON_EXIT_STALE;
  // W1-T2537: `blocked` is a COMPLETED pass reporting news, not a crash — see
  // {@link DAEMON_EXIT_BLOCKED}. `error` deliberately falls through to 1 below, so a genuine
  // crash stays countable against docker's on-failure budget exactly as it always was.
  if (stopReason === "blocked") return DAEMON_EXIT_BLOCKED;
  return 1;
}

/**
 * W1-T2546 — the exit code for a WHOLE SUMMARY, which is what the real `rmd daemon` call site
 * has and what {@link daemonExitCode} above deliberately cannot see: the stop DETAIL.
 *
 * A SECOND FUNCTION RATHER THAN A SECOND PARAMETER, on purpose. `daemonExitCode` is the pure
 * reason -> code map and has callers that pass it point-free (`reasons.map(daemonExitCode)`);
 * widening its signature would silently hand those callers an array index as a stop detail. Every
 * non-`error` reason is delegated to it unchanged, so the two can never disagree about the three
 * codes it already owns.
 *
 * WHAT THE DETAIL IS, AND WHY IT IS TEXT. `runDaemon` builds it as `${taskId}: ${message}` from
 * a fatal error it has ALREADY stringified (`String((err as Error)?.message ?? err)`), so by the
 * time any exit code is computed there is no status object, no headers and no endpoint left to
 * read — the text is genuinely all there is. Rather than hand-roll a fourth copy of the rate-limit
 * signatures, this asks {@link classifyFailure}, the repo's ONE failure classifier, which already
 * reads rate-limit backpressure, 5xx, transport faults and runner loss as `"transient"`. So the
 * decision here can never disagree with the classifier the retry path already trusts, a reworded
 * provider message is a one-place fix, and this is not a rate-limit special case: any refusal that
 * classifier already calls environmental gets the same treatment.
 *
 * FAIL-CLOSED: a summary with no detail, or one the classifier does not POSITIVELY call transient,
 * stays `error` -> 1 and is counted. This can only ever narrow what counts as a crash.
 */
export function daemonExitCodeForSummary(summary: Pick<DaemonSummary, "stopReason" | "stopDetail">): number {
  if (summary.stopReason !== "error") return daemonExitCode(summary.stopReason);
  const detail = summary.stopDetail;
  if (detail !== undefined && classifyFailure({ text: detail }) === "transient") return DAEMON_EXIT_ENVIRONMENTAL;
  return daemonExitCode(summary.stopReason);
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
 *   `"<ISO-8601 with offset>"`            e.g. "2026-08-13T03:19:59.748109+00:00"
 * The upstream started emitting the ISO form on 2026-08-12 (W1-T482's rationale) IN ADDITION TO,
 * never instead of, the human forms above — this branch is additive: every human shape that
 * matched before still matches, exactly as it did, because none of those regexes accept a `T`
 * date-time separator or a numeric-offset/`Z` suffix.
 */
/** Ledger lines are read by humans and by rotation; a pathological upstream string must not be
 *  able to write an unbounded one. 200 chars is far longer than any observed reset clause. */
const UNRECOGNISED_RESET_MAX_LEN = 200;

/**
 * Every WINDOW a previous process already announced an unrecognised reset for — the
 * ledger-derived seed for {@link DaemonDeps.priorUnrecognisedResets}. Mirrors
 * `priorEscalatedAlertIds` / `priorReconciledAlertFeedbackIds` exactly: the step this reads is the
 * step the loop writes, so the ledger is the store and no new state file exists. Exported for the
 * caller that owns the ledger read (run-task.ts) — daemon.ts itself never touches the filesystem.
 *
 * Keyed on `window`, NOT `raw` (W1-T482): the emitter used to dedupe on the whole raw string, which
 * a microsecond-precision ISO reset defeats outright — every tick produces a string no previous
 * tick produced, so the bound never actually bound anything (measured: 56-for-56 and 335-for-335
 * fired, zero suppressed, on two independent ledgers). `window` is a small, fixed set (`session
 * (5h)` plus one `weekly (<label>)` per model) so it bounds the SAME way the old key was documented
 * to, but actually holds under a raw value that drifts every tick.
 */
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

  // ISO-8601 with an explicit offset or `Z` — the shape `/usage` switched to on 2026-08-12
  // (`2026-08-13T03:19:59.748109+00:00`). Matched by a STRICT shape check first, not handed
  // straight to `Date.parse`/`new Date()`: those accept a wide, engine-dependent grab-bag of
  // non-ISO strings too (including some of the human forms above, ambiguously), and this
  // function's `null` contract is load-bearing for the conservative fallback in
  // `resolveHeadroomLimitPct` — a loose accidental match must never look like a confirmed parse.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (iso) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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

/**
 * THE PARK CEILING. RESOLVES TO {@link DEPLOY_IDLE_DEFER_CEILING_MS} rather than re-spelling
 * `30 * 60_000`, for exactly the reason the constant immediately above resolves rather than
 * matches: two independent literals drift, one shared export cannot. The deploy supervisor
 * already settled this argument — a fleet that never goes idle still gets through after thirty
 * minutes, ledgered as forced — and this is that idea applied to the headroom park.
 */
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

/**
 * The park WITH a ceiling — the counterpart of {@link evaluateIdleGate}, same shape on purpose.
 *
 * THE DEFECT IT CLOSES: the degraded branch had no ceiling, no escalation and no exit of its
 * own. Its only way out was a probe that RECOVERS, so a probe that cannot recover parks the
 * fleet permanently about four minutes after boot — alive, ticking (`ticks++` happens inside the
 * park), fresh boot sha, every liveness indicator healthy. That is not hypothetical: a real
 * `.claude` DIRECTORY occupying the worker-home symlink slot made the usage probe fail 33 times
 * out of 33, and re-materialisation never healed it.
 *
 * `parkedSinceMs === undefined` reads as a FRESH park (`waitedMs = 0`), which alone can never
 * reach the ceiling — so a caller that does not track the clock degrades to exactly the old
 * unbounded park, never into a surprise forced dispatch. Same fail-direction discipline
 * {@link evaluateIdleGate} documents for its own optional persistence.
 */
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
   * How long the governor may stay PARKED (unreadable beyond the allowance) before dispatching
   * blind for one tick. Defaults to {@link HEADROOM_PARK_CEILING_MS}. Injectable so the park is
   * reachable in a test without a real thirty-minute wait — the same reason the deploy
   * supervisor's own ceiling is a parameter.
   */
  headroomParkCeilingMs?: number;
  /**
   * W1-T113: the spawn-infra backoff ceiling in ms (default
   * {@link DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS}) — consecutive failures double
   * `pollIntervalMs` up to this cap. POLICY DATA (rule 2), retunable without a
   * source change.
   */
  maxSpawnInfraBackoffMs?: number;
  /**
   * W1-T2517: the cross-task API-window-hold ceiling in ms (default
   * {@link DEFAULT_MAX_API_WINDOW_HOLD_MS}) — the SAME doubling-capped shape
   * `maxSpawnInfraBackoffMs` uses just above, for a different signal: consecutive
   * `blocked_transient` verdicts across DIFFERENT task ids (see
   * {@link reasonAboutApiWindow}'s own doc for why task identity is the discriminator).
   * POLICY DATA (rule 2), retunable without a source change.
   */
  maxApiWindowHoldMs?: number;
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
  /**
   * W1-T1044 — the WALL-CLOCK BOUND (ms) on `await deps.sweep()`, below (default {@link
   * DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}). POLICY DATA (rule 2): the real `rmd daemon` entry
   * threads `policy.values.sweepWallClockBoundMs` (src/lib/policy.ts) here, never a literal
   * at the call site. A sweep still in flight once this many REAL ms (a `setTimeout`,
   * independent of the injected `deps.sleep` cadence the in-flight ticker already owns — see
   * the call site's own comment for why a second consumer of that clock is avoided) have
   * elapsed is ABANDONED — the tick logs `daemon.sweep.abandoned` and returns control to the
   * loop rather than awaiting it forever (this repo's own measured incident: a fix-rung
   * worker's `until` shell loop with no exit condition parked the daemon up to 165 minutes).
   */
  sweepWallClockBoundMs?: number;
  /**
   * W1-T1272 — the MINIMUM GAP (ms, default {@link DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS}) between
   * two full-sweep RETRIGGERS fired while a "dispatch"/"retro" in-flight ticker holds the loop
   * (see {@link startInFlightTicker}'s own doc). Distinct from `sweepWallClockBoundMs` above,
   * which bounds how long any ONE sweep call is allowed to run — this bounds how OFTEN a new one
   * is allowed to start. Never consulted by the once-per-iteration call at the top of the loop,
   * which is unconditional whenever `deps.sweep` is supplied, exactly as before this field
   * existed. POLICY DATA (rule 2) in intent, though not yet threaded from `plan/policy.yaml` —
   * a direct/test caller (and the real `rmd daemon` entry, until a follow-up wires the policy
   * row) gets the default.
   */
  sweepRetriggerIntervalMs?: number;
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
 *
 * `retired` (W1-T2474) is carried here TOO, but is deliberately EXCLUDED from `blocked` and
 * from the `starved` verdict below: a `retired` task is a deliberate record that will never be
 * built (drain.ts's `"retired"` `DispatchFilterReason` split), the same "waiting never helps"
 * shape as `verify-not-auto`, not the dependency-stalled shape `blocked`/`unmetDeps`/
 * `circuitBroken` share. A queue whose only remaining blockers are retired is NOT starved —
 * nothing a human does clears it. Kept on the census (rather than dropped entirely) so the
 * count stays legible to a reader who wants to see it named, not silently absorbed into
 * `blocked` or vanished.
 */
export interface StarvationCensus {
  circuitBroken: IdleReasonBucket;
  blocked: IdleReasonBucket;
  unmetDeps: IdleReasonBucket;
  retired: IdleReasonBucket;
}

/**
 * The CLEARED half of the starvation episode (this task): which of the two sites in `runDaemon`
 * below ended the episode, so `onStarvationCleared`'s wiring can close the escalation it opened
 * with a comment that says WHY rather than a bare "resolved". The two sites end an episode for
 * different reasons — see the comments at each site — and only one of them has a task to name:
 * a `dispatchable-task` clear has one (the task that just became eligible); a
 * `no-recoverable-blockers` clear does not (nothing dispatched — the blockers themselves cleared).
 */
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
/**
 * W1-T462: should the daemon poll security alerts on THIS tick?
 *
 * THE GAP WAS CADENCE, NOT CAPABILITY. `pollAlerts` (lib/ops.ts) already reads code-scanning,
 * Dependabot and secret-scanning alerts, folds open counts into the digest and escalates each NEW
 * critical/high exactly once — but MEASURED across all three ledger forms, `ops.alerts_polled` had
 * TWO rows in the entire corpus, both in archives from 2026-07-21 and 2026-08-02, and nothing
 * scheduled `opsCommand` at all: no daemon hook, no workflow, no launchd unit. Ten OSV advisories
 * accumulated until a human asked. The signal was produced and delivered; only the reader was missing.
 *
 * SHAPED AFTER {@link decideAutoTriage} RATHER THAN INVENTING A FOURTH CLOCK — same marker-plus-
 * interval form, same idle gate, same fail-closed-on-corrupt-marker rule. This repo keeps re-filing
 * "a fourth spelling of how long since last time"; reusing the established shape is the point.
 *
 * THE IDLE GATE IS NOT DECORATION. `decideAutoTriage` checks it for a reason: a poll shells three
 * `gh api` endpoints, and a dispatch tick is where the REST budget is already under pressure. It is
 * cheap (3 requests against a 5,000/hour budget measured at 4,834 remaining) but "cheap" is not
 * "free at the worst possible moment".
 */
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
  // A marker we cannot parse FAILS CLOSED, exactly as decideAutoTriage does on a corrupt marker:
  // firing on an unreadable timestamp would poll every tick, which is the noise this gate exists
  // to prevent.
  if (Number.isNaN(last)) return { fire: false, reason: "last poll timestamp unreadable — failing closed" };
  const sinceMin = (i.now.getTime() - last) / 60_000;
  if (sinceMin < i.minIntervalMinutes) {
    return { fire: false, reason: `polled ${sinceMin.toFixed(1)}m ago — under the ${i.minIntervalMinutes}m interval` };
  }
  return { fire: true, reason: `last poll ${sinceMin.toFixed(1)}m ago — interval elapsed` };
}

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
   * W1-T2397 — the open-sibling OBSERVATION's two halves, forwarded verbatim into this tick's
   * {@link NextRunnableOpts}; see those fields' own docs in drain.ts for the contract, and
   * run-task.ts's `openSiblingObservation` for the one factory both lanes build them from.
   *
   * THIS IS THE LANE THAT DISPATCHES. Measured over the container's ledger union: `daemon.boot`
   * 347 and `run.start` 558 against `drain.start` 16 — and the instance that motivated the task
   * (W1-T2387 dispatched while #3102 was open, producing #3109) came through here, not the drain.
   *
   * NOT `isOpenPr`, and never to be folded into it: that would be the refusal W1-T2397 measured
   * and declined. Omitted ⇒ no observation, and dispatch is byte-identical to before they existed.
   */
  openSiblingBuildFor?: NextRunnableOpts["openSiblingBuildFor"];
  onOpenSiblingBuild?: NextRunnableOpts["onOpenSiblingBuild"];
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
   * W1-T916 — the same supplier `DrainDeps` takes, for the daemon's own dispatch path. Raw
   * `git ls-remote --heads origin 'run-*'` output, read ONCE PER TICK and parsed by
   * `runBranchTaskIds` (drain.ts). Injected for the same reason it is there: this module reads its
   * world through deps, and the raw-output shape makes one-sweep-per-tick the only form that
   * type-checks. Optional — omitted, dispatch behaves exactly as before this existed.
   */
  readPushedRunBranches?: () => string;
  /**
   * W1-T2286 — the same {@link ObservedScopeByTask} `DrainDeps.observedByTask` takes, for the
   * daemon's own dispatch path (W1-T343 reuses `runnableCandidates`/`partitionByFileOverlap`
   * rather than re-deriving them, and this dependency follows that reuse). Threaded to BOTH the
   * pack step (`dispatchOpts.observedByTask` below) and `partitionByFileOverlap`'s own direct
   * call in the dispatch-set branch below, so the two never disagree about a candidate's
   * effective scope — see `DrainDeps.observedByTask`'s own doc for the full contract. Optional —
   * omitted, both call sites fall back to `NO_OBSERVED_SCOPE` and dispatch is byte-identical to
   * before this dependency existed; no production caller supplies one yet.
   */
  observedByTask?: ObservedScopeByTask;
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
  /**
   * W1-T417-adjacent (SDK usage source): MAY return a promise. Widened rather than made
   * `async`, so every existing SYNCHRONOUS supplier — the CLI probe and all 60 test fakes —
   * keeps working byte-for-byte; `await` on a non-promise is a no-op. The daemon needs this
   * because the contract-supported SDK reading is a control request on a streaming session,
   * which is inherently async.
   */
  readUsage?: () => UsageSnapshot | undefined | Promise<UsageSnapshot | undefined>;
  /**
   * WINDOWS already reported by a previous process, read back off the ledger by whoever builds
   * these deps (run-task.ts). THE LEDGER IS THE DEDUP — the same idiom `priorEscalatedAlertIds` and
   * `priorReconciledAlertFeedbackIds` already use: a step written once and read back as the key,
   * never a new state file. Seeding from it is what makes the once-per-window bound survive a
   * restart; without it a daemon that reboots hourly would re-announce the same window on every
   * boot. Keyed on `window`, not the raw string (W1-T482) — see {@link priorUnrecognisedResetStrings}.
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
   * Called AT MOST ONCE PER PARK, on the tick the park ceiling forces a blind dispatch — never
   * per tick, which at a 60s poll would be a pager. Re-armed when the park ends, so a LATER park
   * escalates again rather than staying silenced for this process's life (the same in-process
   * discipline `onStarvation`'s `starvationEscalated` guard uses, and for the same reason).
   * Optional — omitted, the ceiling still forces and still ledgers, it just opens no issue.
   */
  onHeadroomParkCeiling?: (info: {
    consecutiveUnreadable: number;
    parkedMs: number;
    ceilingMs: number;
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
   * W1-T1082 (THE DAEMON NEVER READS ITS OWN FREE SPACE): real free disk space for THIS tick,
   * pre-judged against the SAME thresholds `rmd doctor`'s own `judgeDiskHeadroom` reports
   * against (doctor.ts) — read and judged in the CLI wiring (run-task.ts), never here, because
   * this module stays fs-free AND threshold-free (the file header's "never touches the
   * filesystem", extended to "never re-derives a threshold `rmd doctor` already owns" — a daemon
   * that alarmed at a different number than `rmd doctor` reports would be a contradiction an
   * operator has to adjudicate mid-incident). `freeBytes` is `undefined` (never a fake `0`) on
   * any read failure — `readDiskFreeBytes`'s own fail-soft contract (daemon-health.ts) — and
   * `runDaemon` below treats an undefined `freeBytes` as UNREADABLE, never as zero-bytes-free:
   * it is still recorded on the `daemon.alive` row when present, but it never escalates (see
   * `onDiskHeadroomBreach` below). Optional — omitted, `daemon.alive` simply carries no
   * `disk_free_bytes`, exactly as before this dep existed.
   */
  readDiskHeadroom?: () => { freeBytes?: number; verdict: "OK" | "WARN" | "FAIL" };
  /**
   * Called AT MOST ONCE per continuous disk-headroom breach episode — the tick a reading FIRST
   * crosses below WARN (2 GiB) or FAIL (512 MiB), cleared the instant a LATER reading is back at
   * OK (mirrors `onHeadroomBreach`'s own `headroomReserveEscalated` latch exactly — see
   * `runDaemon`'s `diskHeadroomLatch`, below). Escalates at WARN, not only FAIL: by FAIL, the
   * issue body, this hook's own dedup marker and the ledger row it lives on are all writes that
   * may themselves lose to the same ENOSPC this hook exists to report ahead of — the exact shape
   * `escalateCrashLoop`'s doc names ("a detector whose input can only be recorded by a write
   * that ENOSPC rejects is structurally incapable of being the FIRST signal; it is the
   * autopsy"). Never called for an unreadable read (`readDiskHeadroom`'s `freeBytes` absent) —
   * an unreadable disk is not evidence of a full one. Wrapped in the caller's own try/catch
   * (same discipline as `onHeadroomBreach`/`onQuotaExhausted`) so a failed notification costs
   * one logged line, never the daemon's liveness. The real command wires run-task.ts's
   * `escalateDiskHeadroomBreach`, with its OWN cross-boot ledger dedup — this in-process latch
   * alone resets to empty on every daemon restart, and disk pressure can itself crash-loop the
   * daemon. Optional — omitted, the breach is still visible via `daemon.alive`'s own
   * `disk_free_bytes` field, it just opens no issue.
   */
  onDiskHeadroomBreach?: (info: { freeBytes: number; verdict: "WARN" | "FAIL"; ts: string }) => void | Promise<void>;
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
   * The CLEARED half of the transition `onStarvation` above only ever opens (this task):
   * `onStarvation` has no counterpart, so the two sites below that reset `starvationEscalated`
   * re-arm an in-process boolean and tell nothing outside the process — the escalation issue
   * `onStarvation` opened stays open forever, even once a human (or a later dispatch) has made
   * the condition moot. Mirrors `onStarvation` EXACTLY, never a second mechanism: optional on
   * `DaemonDeps`, wrapped in the SAME try/catch whose comment already reads "a failed
   * notification costs one logged line, never the daemon's liveness", and fired from the SAME
   * two sites that already own the transition.
   *
   * Fires ON THE EDGE, never per tick — guarded on the flag it is clearing (`starvationEscalated`),
   * so a daemon that was never escalated stays silent (nothing to clear) and a long quiet
   * stretch of already-unstarved ticks closes nothing repeatedly (the SAME "dedup while the
   * condition holds, once per episode" discipline `onStarvation` itself applies, just for the
   * opposite edge). `info.reason` names WHICH of the two sites ended the episode — the daemon
   * says so in its own comments at each site — and `info.taskId` names the task where there is
   * one, so the real command (run-task.ts's `escalateStarvationCleared`) can close the issue
   * `escalateStarvation` opened with a comment that says why, not a bare "resolved". Optional —
   * omitted, the daemon still re-arms exactly as before this hook existed, it just closes no
   * issue.
   */
  onStarvationCleared?: (info: StarvationClearedInfo) => void | Promise<void>;
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
   * W1-T462: run ONE security-alert poll. Best-effort by the same contract as `sweep` above — a
   * throw costs the daemon one logged tick, never its life. Returns the ISO of the poll so the
   * caller can persist it as the interval marker.
   */
  alertPoll?: () => Promise<string | undefined> | string | undefined;
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
   * W1-T530 FEEDBACK-LANDING SWEEP (ratifies P22, the same argument `sweepOrphans` above
   * already applies to strays): the SAME `sweepFeedbackLanding` entry point
   * (feedback-landing.ts) `daemonBoot`'s own `sweepFeedbackLanding` param below runs once at
   * boot, wired here so it ALSO runs once per poll iteration — an entry captured while landing
   * was unavailable (offline, no `gh`, `gh pr create` refused), or on a host that never
   * captures again, is otherwise stranded off `origin/main` forever because `landFeedback`'s
   * only caller is `captureFeedback`. Idempotent by contract (a pass over already-landed state
   * pushes nothing — see `LandFeedbackResult.pushed`), so riding the daemon's own poll cadence
   * is safe. Optional: omitted ⇒ the loop behaves exactly as before this sweep existed.
   * Best-effort by the same contract as `sweep`/`sweepOrphans` above (own try/catch, logged,
   * never halts the loop).
   */
  sweepFeedbackLanding?: () => Promise<LandFeedbackResult> | LandFeedbackResult;
  /**
   * W1-T1040: THE GITHUB-SIDE POSTURE DRIFT CHECK — reads whether the repo's GitHub-side
   * security capabilities (`security_and_analysis`, `enforce_admins`) are on, once a day at
   * most (github-posture.ts's own cadence gate), and returns only the findings that changed
   * since the recorded baseline (or the first read if none is recorded) — `[]` on every other
   * tick, including an unreadable read (never a false all-clear). Best-effort by the SAME
   * contract as `sweep`/`sweepOrphans`/`sweepFeedbackLanding` above: a throw costs one logged
   * tick, never the daemon's life, and a non-empty return NEVER halts dispatch, fails a check,
   * or changes a verdict — it is a ledger row for the operator, nothing more (see
   * github-posture.ts's module header for why this is deliberately not an `escalate()` call).
   * Optional: omitted ⇒ the loop behaves exactly as before this check existed.
   */
  checkGithubPosture?: () => Promise<GithubPostureFinding[]> | GithubPostureFinding[];
  /**
   * W1-T1259: THE MEASUREMENT-CADENCE RUNG — decides whether `rule-efficacy`,
   * `verdict-calibration` and `autonomy-rate` (lib/measurement-cadence.ts's `decideMeasurementCadence`)
   * run THIS tick. Paced by its OWN policy-data bound (`minIntervalMinutes` + `maxPerDay`,
   * `plan/policy.yaml`'s `measurementCadence` row), never the raw poll interval — the same
   * marker-plus-interval-plus-cap shape `checkAutoTriage` uses. Optional: omitted ⇒ the loop
   * behaves exactly as before this rung existed (the three verbs stay operator-run only).
   */
  checkMeasurementCadence?: () => MeasurementCadenceDecision;
  /**
   * W1-T1259: run all three measurement verbs once, returning a cadence-shaped summary this
   * loop logs (never inside the producer itself — same split `runAutoTriage`'s own disposition
   * logging uses). DEFAULT-OFF WRITE PATH: the summary's `ruleEfficacy.escalated` is true only
   * when `policy.measurementCadence.escalate` was ALSO on — the default cadence runs every verb
   * report-only, zero writes, and NEVER files a task or mints an id (Law 5) — see
   * lib/measurement-cadence.ts's module doc. Best-effort like `sweep`/`checkAutoTriage` above: a
   * throw costs one logged tick, never the daemon's life.
   */
  runMeasurementCadence?: () => Promise<MeasurementCadenceRunResult>;
  /**
   * W1-T2277: THE DIGEST'S OWN CADENCE RUNG — decides whether the digest (lib/digest.ts's
   * `runDigestCadenceReport`) fires THIS tick. Paced by its OWN policy-data bound
   * (`minIntervalMinutes` + `maxPerDay`, `plan/policy.yaml`'s `digestCadence` row — a SEPARATE
   * row from `measurementCadence`'s, on a SEPARATE marker file, so the two can never drag each
   * other), reusing the SAME `decideMeasurementCadence` pure function `checkMeasurementCadence`
   * above does. Optional: omitted ⇒ the loop behaves exactly as before this rung existed (the
   * digest stays reachable only by an operator typing `rmd digest`).
   */
  checkDigestCadence?: () => MeasurementCadenceDecision;
  /**
   * W1-T2277: build and deliver one digest, returning what got sent — never inside the producer
   * itself (same split `runMeasurementCadence`'s own disposition logging uses). NEVER FILES A
   * TASK, NEVER MINTS AN ID, NEVER SPAWNS A WORKER (Law 5) — see lib/digest.ts's
   * `runDigestCadenceReport` doc. Best-effort like `runMeasurementCadence` above: a throw costs
   * one logged tick, never the daemon's life.
   */
  runDigestCadence?: () => Promise<DigestCadenceRunResult>;
  /**
   * W1-T2304's board-review rung, wired. THE RUNG WHOSE UNIT IS THE WHOLE OPEN BOARD — "is the
   * board itself healthy" — rather than one PR, which is every other rung's unit.
   *
   * ITS OWN policy row and ITS OWN marker file (`state/last-board-review.json`), on the same
   * check/run pair shape as `checkMeasurementCadence` and `checkDigestCadence` above, for the
   * same reason: three cadences that shared one bound could not be tuned independently.
   *
   * THIS PAIR IS THE WHOLE POINT OF THE WIRING TASK. #2952 merged 385 lines of correct, tested
   * board-review code on 2026-08-26 at 13:54:59Z and it never fired once — zero `board_review`
   * rows all-time against 89 `measurement_cadence`, and no `state/last-board-review.json` on disk
   * beside five sibling markers — because nothing ever called it. `buildBoardReview` sat behind
   * `opts.boardReview ? … : undefined` in `runMeasurementCadenceReport` and no caller passed the
   * key. That is PR #1066's lesson for the third time; the producer at `daemonCommand`'s call
   * site is what makes it real, not this declaration.
   *
   * W1-T2464: also carries `retiredProposalIds` — this hook's OWN reconciliation pass, which runs
   * on every call regardless of `fire` (see `reconcileBoardReviewReferents`'s header doc, and
   * `buildBoardReviewDaemonHooks`'s `check` closure that wires it in). Optional so a fixture
   * built against the pre-W1-T2464 shape (bare `{fire, reason}`) still satisfies the type.
   */
  checkBoardReview?: () => BoardReviewCadenceDecision & { retiredProposalIds?: string[] };
  /**
   * Runs one board-review tick. READ-ONLY BY CONSTRUCTION: it writes one report artifact and
   * drafts registry proposals, and nothing else — it does not push, merge, mint or file, and
   * Rule 15 stands. Best-effort by the SAME contract as the two cadences above: a throw costs one
   * logged tick, never the daemon's life, and a fired review NEVER gates dispatch, fails a check
   * or changes a verdict.
   */
  runBoardReview?: () => Promise<BoardReviewReport>;
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
  checkAutoTriage?: (signals: {
    deferralPending: boolean;
    dispatchCount: number;
    laneBudget: number;
  }) => AutoTriageDecision;
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
 *
 * W1-T1272: `sweepRetrigger`, when supplied, is forwarded straight to `startInFlightTicker` —
 * this wrapper is used for BOTH the retro trigger and auto-triage call sites, and either can
 * hold the loop for the same order of minutes a long dispatch does (rationale: 22.0/21.0-minute
 * retro firings, measured), so the same re-trigger eligibility applies. Only `sweepLight` is
 * still ticked unconditionally on every poll — the retrigger fires strictly less often, on its
 * own longer interval.
 */
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
 *
 * W1-T1082 (THE DAEMON NEVER READS ITS OWN FREE SPACE): this row is ALSO where real disk
 * headroom rides — "no new step, no new row", the same discipline `holdSeen` above was added
 * under. `deps.readDiskHeadroom` is consulted on this SAME cadence (never a second clock — the
 * whole point of reusing this ticker rather than inventing one) and `disk_free_bytes` is
 * carried on the row ONLY when the read actually succeeded: an unreadable read is absent from
 * the row, never a fabricated `0` (`readDiskFreeBytes`'s own contract). Escalation
 * (`onDiskHeadroomBreach`) fires at most once per continuous breach episode via
 * `diskHeadroomLatch`, a reference SHARED across every phase/call of this function within one
 * `runDaemon` run (see that variable's own doc) — never a fresh latch per call, which would
 * re-escalate every time a NEW phase's ticker happened to start while the SAME breach was still
 * open.
 *
 * W1-T1272 (THE RE-TRIGGER): `sweepRetrigger`, when supplied, lets THIS SAME ticker also
 * re-fire the FULL sweep (`deps.sweep`, never `sweepLight`) on its own cadence — see that
 * param's own doc below. Only the "dispatch"/"retro" call sites pass it; the "sweep" phase's
 * own ticker (started BY a full-sweep call, below) never does, so a retrigger can never
 * re-enter the sweep it exists to keep light while it runs.
 */
/**
 * W1-T2565: the MOST STALE the account-headroom reading may be before the in-flight ticker takes
 * one of its own.
 *
 * THE GOVERNOR SAMPLED ON THE LOOP WHOSE DURATION IT WAS MEANT TO BOUND. `daemon.headroom` is
 * written once per `runOne` iteration, and the read sits AFTER `runGatedSweep` — the sweep that
 * carries the inbox-draft rung, the fleet's largest single spender. So the more a tick spent, the
 * longer until the next reading: sampling rate was inversely coupled to spend, which is exactly
 * backwards.
 *
 * MEASURED 2026-09-01 over the three-form union: `daemon.headroom` gaps run median 158s but p95
 * 4,400s and max 21,586s (SIX HOURS). In one 58-minute window (09:17:25 -> 10:15:26) the account
 * went from 30% used to exhausted with the governor holding its last value throughout — 472 of the
 * period's session-limit refusals resolve to that single stale 30% reading, and no
 * `usage.probe_failed` row was written either, so it was silent rather than loudly failing.
 *
 * THE CADENCE ALREADY EXISTED AND ONE SIGNAL WAS ALREADY RIDING IT. {@link startInFlightTicker}
 * runs every `pollIntervalMs` for the whole of a long dispatch/retro/sweep phase and already reads
 * DISK headroom on that cadence, latch and all. MEASURED across that same 58-minute window: 43
 * ticker passes, 43 of them carrying `disk_free_bytes`, ZERO carrying an account reading. Nothing
 * had to be built to make sampling possible — the account signal simply was not wired to it.
 *
 * AND THE PROBE IS FREE, so there is no cost argument for the sparse cadence: `openUsageProbeSession`
 * opens a control-only SDK session over `emptyUsagePrompt`, an async generator that yields NOTHING.
 * Zero of 2,069 headroom/probe rows in the union carry a cost, against 4,332 rows that do.
 *
 * 300s, not `pollIntervalMs`: this BOUNDS staleness rather than setting a rate. The main loop still
 * takes the authoritative per-tick reading and the enforcement decision; this only guarantees that
 * when a tick runs long, the gap between readings stays minutes rather than hours. A tick that
 * completes normally re-reads before this ever elapses, so on a healthy fleet it fires never.
 *
 * BACKSTOP, not the primary control: the main loop's own per-tick read (and the enforcement
 * decision built on it) remains the thing that normally keeps readings fresh; this constant only
 * bounds how stale a reading may get when THAT primary control is running long, same as the four
 * CLAUDE.md-cited bounds this task's own rationale (above) traces the defect back to.
 *
 * POLICY DATA (rule 2) — a literal here, the same disposition `UNREADABLE_DEGRADED_LIMIT`
 * (lib/headroom.ts) records for its own bound.
 */
export const HEADROOM_SAMPLE_MAX_AGE_MS = 300_000;

function startInFlightTicker(
  deps: DaemonDeps,
  pollIntervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  phase: "dispatch" | "retro" | "sweep",
  diskHeadroomLatch: { escalated: boolean },
  sweepRetrigger?: SweepRetrigger,
  // W1-T2565: the LAST account-headroom sample's wall clock, shared with the main loop so the two
  // samplers cannot double-read. Optional and trailing, so every existing call site (tests
  // included) is unchanged and simply gets no in-flight sampling.
  headroomSampler?: { lastSampleMs: number; now: () => number; policy: HeadroomPolicy; enforced: boolean },
): { stop: () => Promise<void> } {
  let active = true;
  const ticker = deps.sweepLight
    ? (async () => {
        while (active) {
          await deps.sleep(pollIntervalMs);
          if (!active) break;
          // THE ACKNOWLEDGEMENT GAP (W1-T1065 design part iv). `daemon.pause` is written only
          // inside the branch that ACTS on a hold (the top-of-tick idle, or the re-check above) —
          // so while an admitted batch drains (phase "dispatch"), an operator hold created mid-
          // drain was invisible: no row distinguished "hold seen, draining to completion" from
          // "hold not seen at all". That ambiguity is exactly what made the originating instance
          // read as a broken control — the operator waited, saw nothing, and escalated to
          // `docker stop`. Riding this field on the SAME `daemon.alive` row `startInFlightTicker`
          // already writes every poll interval (no new step, no new row) closes it: a re-check
          // here can NEVER abort the batch already in flight — the drain-and-hold guarantee is
          // untouched — but the operator can now tell "seen, waiting for this batch to settle"
          // from "not seen yet" without escalating.
          const holdSeen = phase === "dispatch" ? Boolean(deps.checkPause?.()) : undefined;
          // W1-T1082: pre-judged by the CLI wiring (run-task.ts's `judgeDiskHeadroom`, the SAME
          // definition `rmd doctor` reports against) — this pure module never re-derives the
          // WARN/FAIL boundary. A reading back at OK re-arms the latch so a LATER breach (a
          // genuinely new episode) escalates again rather than staying silenced for this
          // process's life — the same clearing discipline `headroomReserveEscalated` applies.
          const diskHeadroom = deps.readDiskHeadroom?.();
          if (diskHeadroom?.verdict === "OK") diskHeadroomLatch.escalated = false;
          log("daemon.alive", {
            phase,
            poll_interval_ms: pollIntervalMs,
            ...(holdSeen !== undefined ? { pause_seen: holdSeen } : {}),
            ...(diskHeadroom?.freeBytes !== undefined ? { disk_free_bytes: diskHeadroom.freeBytes } : {}),
          });
          // W1-T2565: SAMPLE ACCOUNT HEADROOM WHEN THE LAST READING HAS GONE STALE. Placed AFTER
          // the `daemon.alive` write on purpose: this tick's liveness heartbeat is already on the
          // ledger before the probe is awaited, so a slow or hanging probe can delay the NEXT
          // heartbeat but can never swallow this one. Wrapped in its own try/catch and gated on
          // `readUsage` being wired at all, so an absent or throwing probe costs one skipped
          // sample, never the ticker — the identical best-effort discipline the disk read above
          // already follows.
          //
          // TELEMETRY, NOT ENFORCEMENT — deliberately. A reading taken here cannot abort work
          // already in flight, and the main loop remains the single place that decides to idle.
          // What this changes is that the decision, the console and every `daemon.headroom`
          // consumer stop reading an hours-old number.
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
                // An unreadable probe is an ABSENT sample, never a fabricated one — the same
                // fail-soft contract `readUsage`'s own callers keep. The main loop's consecutive-
                // unreadable counter is deliberately NOT touched from here: this sampler must not
                // be able to push the governor into degraded mode on its own.
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
          // W1-T1272 (RE-TRIGGER, design part (ii)): fires the FULL sweep — never `sweepLight`
          // above — when `sweepRetriggerIntervalMs` has elapsed since it last actually ran,
          // ANYWHERE (the top-of-iteration call or a prior retrigger), regardless of how long
          // this "dispatch"/"retro" phase has held the loop. Without this, a boot whose
          // dispatch/retro holds the loop for its measured mean of 38.5 minutes got exactly one
          // full sweep (the one at the top of the iteration that started it) for that whole
          // span — the freshness exit cannot help here, it is only consulted BETWEEN
          // iterations, and this phase never returns to the top until the in-flight work
          // settles. Awaited before this loop continues to its NEXT `sweepLight` tick, so the
          // full sweep this fires still runs strictly one at a time against every other call
          // site (the top-of-iteration call cannot run again until this ticker is stopped, and
          // `runSweep`'s own cross-call mutex, cited at the top-of-iteration call site's
          // comment, serializes any theoretical overlap besides).
          //
          // W1-T2519 (THE REVIEW RUNG MUST HALT EXACTLY LIKE DISPATCH DOES): the retrigger above
          // is what makes the review rung's cadence independent of a slow lane — but "independent
          // of the lanes" must not mean "independent of the operator". `deps.checkStop`/
          // `deps.checkPause` already gate the once-per-iteration `deps.sweep()` call at the top
          // of this loop (a STOP/PAUSE read there is checked BEFORE that call is ever reached —
          // see `runDaemon`'s own STOP/PAUSE checks, above `runGatedSweep`'s top-of-iteration call
          // site). A hold requested WHILE this ticker is running previously had no equivalent: the
          // retrigger fired on its clock alone, so an operator's STOP/PAUSE stopped new dispatch
          // admission but left the review rung posting regardless — the exact "operator's halt
          // stops dispatch and leaves reviews running" failure this task exists to close. Reading
          // both here, on every tick this ticker runs (never only "dispatch" — a long "retro"
          // phase holds the loop the same way and threads the SAME `sweepRetrigger`), closes that
          // gap without adding a new latch: the pure predicates are read exactly as they already
          // are elsewhere in this file. A halt withholds only a NEW full sweep this ticker would
          // otherwise have started — it can NEVER abort the phase's own admitted/running work (the
          // drain-and-hold guarantee `checkStop`/`checkPause` already carry everywhere else in
          // this file is untouched: `runOne` is never touched by this ticker). `lastRunAtMs` is
          // deliberately NOT advanced when held — the elapsed-time budget keeps accruing while
          // halted, so the very next unhalted tick fires immediately rather than waiting out a
          // fresh interval on top of the hold.
          if (sweepRetrigger && deps.sweep) {
            const nowMs = (deps.now ?? (() => new Date()))().getTime();
            const last = sweepRetrigger.state.lastRunAtMs;
            if (last === undefined || nowMs - last >= sweepRetrigger.intervalMs) {
              const halt = deps.checkStop?.() ?? deps.checkPause?.();
              if (halt) {
                log("daemon.sweep.retrigger_held", { phase, detail: halt });
              } else {
                sweepRetrigger.state.lastRunAtMs = nowMs;
                log("daemon.sweep.retriggered", {
                  phase,
                  poll_interval_ms: pollIntervalMs,
                  interval_ms: sweepRetrigger.intervalMs,
                });
                await runGatedSweep(deps, pollIntervalMs, sweepRetrigger.sweepWallClockBoundMs, log, diskHeadroomLatch, undefined, sweepRetrigger.liveness);
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
  // Cleared on EVERY exit path by the caller; a `sweepLight()` already in flight is
  // allowed to finish rather than aborted (unchanged from W1-T254).
  return {
    stop: async () => {
      active = false;
      if (ticker) await ticker;
      // W1-T2379: the tick no longer awaits the fix rung's CI wait (`SweepDeps.detachFixWait`),
      // so awaiting `ticker` alone would return while a dispatch this ticker started was still
      // settling. Draining here preserves the property this `stop()` has always had —
      // "a `sweepLight()` already in flight is allowed to finish rather than aborted" (W1-T254)
      // — for the half of that work that now lives outside the pass. Resolves immediately when
      // nothing is detached, which is every caller that never ran a light pass.
      await drainDetachedSweepActions();
    },
  };
}

/**
 * W1-T1272 — the shared config `startInFlightTicker`'s "dispatch"/"retro" call sites pass so
 * they can ALSO re-fire the full sweep on a cadence, not only `sweepLight` (see that param's
 * own doc). `state` is ONE mutable ref, threaded from `runDaemon` into every call site (the
 * top-of-iteration sweep call and every ticker that accepts this config) — never a fresh object
 * per call, which would make each phase re-derive "elapsed since last sweep" from its own
 * private zero instead of the sweep's actual last run.
 */
interface SweepRetrigger {
  /** Mirrors `DaemonOpts.sweepWallClockBoundMs` — the SAME bound the top-of-iteration call uses. */
  sweepWallClockBoundMs: number;
  /** `DaemonOpts.sweepRetriggerIntervalMs` (resolved), the minimum gap between two retriggers. */
  intervalMs: number;
  /** SHARED across every call site — see this interface's own doc. */
  state: { lastRunAtMs: number | undefined };
  /** W1-T2582: the SAME {@link SweepLiveness} the top-of-iteration calls hold. Carried here
   *  because the retrigger is a SECOND route into a concurrent pass and the wall-clock bound
   *  alone does not cover it — measured: the last two pre-fix draft batches were 20m27s apart,
   *  the retrigger interval, not the 559s bound. Optional so a direct/test caller that predates
   *  this is unchanged. */
  liveness?: SweepLiveness;
}

/**
 * W1-T1272 — THE GATE ITSELF, extracted so the bound (`DaemonOpts.sweepWallClockBoundMs`) and
 * the light-sweep ticker it runs under apply IDENTICALLY at every call site: the
 * once-per-iteration call, the stale-freshness "reach the gate before returning" call, and a
 * mid-flight retrigger (`SweepRetrigger`, above). A second, inlined copy at any of those sites
 * is exactly how the bound or the ticker shape could silently drift between them. Behaviour is
 * byte-identical to the single inline block this replaces: the SAME `Promise.race` against a
 * real `setTimeout` (never `deps.sleep` — see the original comment this carries forward), the
 * SAME `daemon.sweep.abandoned`/`daemon.sweep.failed` log shapes, and the SAME in-flight-ticker
 * wrapping (phase "sweep") so `sweepLight` keeps ticking while a full sweep runs. Callers are
 * responsible for checking `deps.sweep` is defined before calling this
 * (mirrors the original `if (deps.sweep)` guard) — this function assumes it is.
 */
/**
 * W1-T2582: THE ONE PIECE OF STATE THAT MAKES "ONE SWEEP AT A TIME" TRUE.
 *
 * `inFlight` is set when a `deps.sweep()` promise STARTS and cleared when that promise SETTLES —
 * deliberately NOT when {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS} stops awaiting it. That
 * distinction is the whole task: the bound stops WAITING and never stops the WORK, so between the
 * abandon and the eventual settle there is a window in which the pass is still executing and
 * nothing said so. Every re-entry the fleet observed landed in that window.
 *
 * EXCLUSION, NOT CANCELLATION — the shard's own conclusion, and the only option that is not worse
 * than the defect. An abandoned pass may hold a live worker, a lock, or a half-written cache;
 * killing it at 559s would destroy legitimate long runs and could leave state mid-write. So the
 * abandoned pass runs to completion untouched and the NEXT one declines to start.
 *
 * IN-PROCESS BY DESIGN, AND THAT IS SUFFICIENT HERE. All three `runGatedSweep` call sites live in
 * ONE daemon loop in one process, so a closure flag closes every route into it. This is NOT the
 * cross-process case W1-T2569's file lock had to solve for the draft rung, which is also reachable
 * from `rmd inbox` and must survive a restart; conflating the two would put a filesystem lock on a
 * path that has no second process to exclude.
 */
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
  // W1-T2565: threaded to the sweep's OWN ticker. THE SWEEP IS THE PHASE THAT MOTIVATED THIS —
  // it carries the inbox-draft rung, and the measured 58-minute headroom blind window was a sweep
  // running long while the account went from 30% used to exhausted. Optional and trailing so every
  // existing caller and test is unchanged.
  headroomSampler?: { lastSampleMs: number; now: () => number; policy: HeadroomPolicy; enforced: boolean },
  // W1-T2582: the shared liveness flag. Optional and trailing so every existing caller and test is
  // unchanged — omitted, this function behaves exactly as it did before, which is what keeps the
  // W1-T1044 bound tests meaningful.
  liveness?: SweepLiveness,
): Promise<void> {
  // ── W1-T2582: DECLINE, DO NOT DUPLICATE ────────────────────────────────────────────────────
  // Checked BEFORE the ticker starts, so a declined pass costs nothing at all — no ticker, no
  // `deps.sweep()` call, no worker. This ONE gate closes BOTH routes into a concurrent pass,
  // because all three `runGatedSweep` call sites pass through it: the two top-of-iteration calls
  // AND `startInFlightTicker`'s retrigger, which is a second entry route the bound alone does not
  // cover (measured: the last two pre-fix draft batches were 20m27s apart — the retrigger interval,
  // not the 559s bound).
  if (liveness?.inFlight) {
    log("daemon.sweep.skipped_concurrent", { reason: "a previous sweep pass is still executing" });
    return;
  }
  if (liveness) liveness.inFlight = true;
  const stopSweepTicker = startInFlightTicker(deps, pollIntervalMs, log, "sweep", diskHeadroomLatch, undefined, headroomSampler).stop;
  try {
    const sweepPromise: Promise<void | undefined> = Promise.resolve().then(() => deps.sweep!());
    // W1-T2582: CLEARED ON SETTLE, NEVER ON ABANDON. Attaching this to `sweepPromise` itself —
    // rather than to the `finally` below, which runs when the AWAIT ends — is what keeps the flag
    // true through the abandon-to-settle window that every observed re-entry landed in.
    // `then(onOk, onErr)` rather than `finally`: it handles a rejection here, so this derived
    // promise can never become an unhandled rejection of its own (the real failure is still
    // reported by the `catch` in the abandoned branch below, and by the outer `catch`).
    if (liveness) void sweepPromise.then(() => { liveness.inFlight = false; }, () => { liveness.inFlight = false; });
    const startedAtMs = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"abandoned">((resolve) => {
      timer = setTimeout(() => resolve("abandoned"), sweepWallClockBoundMs);
    });
    try {
      const winner = await Promise.race([sweepPromise, bound]);
      if (winner === "abandoned") {
        const elapsedMs = Date.now() - startedAtMs;
        log("daemon.sweep.abandoned", { elapsed_ms: elapsedMs, bound_ms: sweepWallClockBoundMs });
        // Never leave the real sweep's eventual outcome unhandled — it may still resolve or
        // throw well after this call has moved on (the mutex `runSweep` shares across concurrent
        // calls, cited at the call sites, is what makes that safe).
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

/**
 * The spawn-infra backoff ceiling (POLICY DATA, rule 2): consecutive failures
 * double `pollIntervalMs` up to this cap rather than hammering a dispatch that
 * is failing for an infrastructure reason nobody has fixed yet — see the
 * backoff computation in `runDaemon`, below.
 */
export const DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS = 30 * 60_000;

/**
 * W1-T2517 (THE DISPATCH LOOP IS NEVER TOLD THE WINDOW CLOSED): `apiError` is produced 13
 * times across worker.ts/run-task.ts and reaches daemon.ts/drain.ts ZERO times, so a closed
 * usage window is re-discovered per task at a full spawn each — worker home, containment
 * preflight, isolation preflight, worktree — before run-task.ts's OWN worker-level retry loop
 * (classify.ts's MAX_TRANSIENT_RETRIES) finally gives up and returns a `blocked_transient`
 * verdict. `reasonAboutBlock`/`blockRetryStates` (above) already bound how many times the
 * SAME task id retries that verdict across ticks (W1-T46) — but `blockRetryStates` is keyed
 * by task id, so a NEW task id always arrives with a fresh budget and pays the full spawn to
 * rediscover the identical closed window. That is precisely the argument W1-T113 already made
 * for spawn-infra failures (see `toolchainEscalated`'s own doc): a cause that blocks dispatch
 * identically for every task needs a signal keyed on the CAUSE, never on task id.
 *
 * THE DISCRIMINATOR IS CONSECUTIVE ACROSS DIFFERENT TASK IDS. One task ending
 * `blocked_transient` is noise — a blip, a bad envelope — indistinguishable from ordinary
 * per-task flake, so it holds nothing (`streak` stays below {@link API_WINDOW_HOLD_STREAK_FLOOR}).
 * The SAME task retrying (its own per-task backoff, W1-T2515's scope) never advances the streak
 * either — `taskId === state.lastTaskId` is a no-op here — so a single flaky task looping on its
 * own retries can never read as a fleet-wide outage. Two or more DIFFERENT task ids ending
 * `blocked_transient` back-to-back IS the signal: not several broken tasks, one broken window.
 *
 * MIRRORS THE SPAWN-INFRA BACKOFF SHAPE (`DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS`, just above) —
 * doubling, capped, reset on any dispatch reaching a REAL (non-`blocked_transient`) verdict —
 * built, proven, policy-as-data. Deliberately does NOT require a parsed reset time (that is
 * W1-T2515's classifier work, `classify.ts`'s `detectUsageLimitRefusal`): a plain consecutive
 * count works with zero knowledge of when the window reopens, and composes with a reset time
 * arriving later without requiring it.
 *
 * NEVER TOUCHES BLOCK-REASONING ITSELF. This function is a pure, ADDITIONAL observation layered
 * beside `reasonAboutBlock` — it never changes a disposition, never clears a strike, and a
 * task's own real failure (any verdict other than `blocked_transient`) both strikes/escalates
 * exactly as before AND resets this streak to its floor in the same step (see the `verdict !==
 * "blocked_transient"` branch below) — a build failure is never masked as a window.
 *
 * KIND: BACKSTOP (`test/bound-kind-declared.test.ts`'s vocabulary, W1-T1266), not a primary
 * control — the streak floor above is what normally stops an ordinary blip from holding
 * anything at all, and most real windows resolve inside a few small doublings; this ceiling
 * exists only so a window closed unusually long cannot make the hold unbounded, exactly the
 * `DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS` cap just above does not bite on an ordinary spawn retry.
 */
export const DEFAULT_MAX_API_WINDOW_HOLD_MS = 30 * 60_000;

/**
 * Below this streak, holding dispatch would be a new way to stall over noise — see
 * {@link reasonAboutApiWindow}'s doc for why the floor is 2, not 1.
 */
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

/**
 * Pure decision: given the running cross-task streak and this dispatch's own task id + verdict,
 * how long (if at all) should the NEXT dispatch be held? See this constant block's own doc,
 * above, for the full rationale — this is its computation.
 */
export function reasonAboutApiWindow(
  state: ApiWindowHoldState,
  taskId: string,
  verdict: RunResult["verdict"],
  pollIntervalMs: number,
  maxHoldMs: number = DEFAULT_MAX_API_WINDOW_HOLD_MS,
): ApiWindowHoldDisposition {
  // A REAL verdict (anything but `blocked_transient`) resets to the floor — this dispatch
  // reached a decisive outcome, so whatever streak of ambiguous refusals preceded it is
  // over, one way or another.
  if (verdict !== "blocked_transient") return { state: INITIAL_API_WINDOW_HOLD_STATE, holdMs: 0 };
  const streak = taskId === state.lastTaskId ? state.streak : state.streak + 1;
  const nextState: ApiWindowHoldState = { streak, lastTaskId: taskId };
  if (streak < API_WINDOW_HOLD_STREAK_FLOOR) return { state: nextState, holdMs: 0 };
  const holdMs = Math.min(pollIntervalMs * 2 ** (streak - API_WINDOW_HOLD_STREAK_FLOOR), maxHoldMs);
  return { state: nextState, holdMs };
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
 * One `daemon.boot` timestamp, optionally carrying WHY THE BOOT IMMEDIATELY
 * BEFORE IT ended (never why this one did — a boot cannot know its own
 * future). W1-T2450 (recon rationale Q3): before this field existed,
 * {@link detectDaemonCrashLoop}'s entire input was a bare timestamp array, so
 * a freshness restart (a deliberate `exit 75` self-relaunch onto a newer
 * `origin/main` — W1-T126, `daemon_selfrestart_for_freshness`) and a real
 * crash were the identical event to it: six routine freshness restarts are
 * six boots, and six boots breach a `maxBoots: 5` window exactly like six
 * crashes would. A bare ISO string is still accepted everywhere this type
 * is — it reads as `{ ts }` with no reason, and an absent/`"unknown"` reason
 * counts toward the window exactly as it always has (never a blanket
 * amnesty for an unlabeled boot); only an EXPLICIT `"freshness"` is ever
 * excluded.
 */
export interface DaemonBootTimestamp {
  ts: string;
  priorExitReason?: "freshness" | "unknown";
}

/**
 * Find the densest `windowMs`-wide run of boots and compare its size against
 * `maxBoots`. Unparseable timestamps are dropped rather than thrown on — the
 * ledger's own torn-line discipline (ledger.ts) — so one malformed line never
 * takes the invariant itself down. Detects the SHAPE only: it does not care
 * WHY a boot happened, so the identical function catches a headroom-exit
 * loop, an escalate-throw loop, and whatever the next uncaught-throw cause
 * turns out to be — EXCEPT a boot explicitly labeled `priorExitReason:
 * "freshness"` (see {@link DaemonBootTimestamp}), which this now excludes
 * from both the density count and the returned evidence: it is the daemon
 * restarting itself on purpose, not a symptom. O(n²) in the boot count,
 * which is fine — callers pass a bounded recent tail of the ledger, never
 * its full history.
 */
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
  sweepLocks?: () => { reaped: string[]; kept: string[]; live: string[]; unverifiableForeignHost: string[] },
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
  /**
   * W1-T530 part (ii): "the level-triggered feedback-landing backstop runs once here, at boot,
   * mirroring `sweepOrphanWorkers` above" — run once here, logged either way as
   * `daemon.feedback_landing_sweep` naming whether it pushed and how many files, so a
   * pre-existing stranded entry (never seen by any capture in THIS process) is picked up the
   * moment the daemon comes up, not only on its next per-poll pass. The real command wires
   * `feedback-landing.ts`'s own `sweepFeedbackLanding`. Synchronous, like `sweepOrphanWorkers`
   * above (`landFeedback`'s own mechanism never awaits — see that module's header). Appended
   * LAST, after `bootHeadSha`, so no positional caller shifts. Omitted ⇒ no sweep at boot,
   * behavior unchanged from before W1-T530.
   */
  sweepFeedbackLanding?: () => LandFeedbackResult,
  /**
   * W1-T991: the runtime reading `assertCleanBoot`'s `BootAssertion` now also carries —
   * defaults to THIS process's own `process.execPath`/`process.version` so a real boot
   * needs no caller change at all; a test overrides it to prove drift without a real
   * foreign-account install. Appended after `sweepFeedbackLanding` per this function's own
   * "no positional caller shifts" discipline.
   */
  nodeRuntime: { execPath: string; version: string } = { execPath: process.execPath, version: process.version },
  /**
   * The repo's declared node pin (`.nvmrc` content, trimmed), read by the CALLER before
   * invoking `daemonBoot` — this module never touches the filesystem (see file header).
   * Omitted ⇒ no version-pin comparison is made; the own-account-roots check still runs.
   */
  declaredNodeVersion?: string,
  /**
   * W1-T2332: the canonical checkout's HISTORY HORIZON — `git rev-parse --is-shallow-repository`
   * and `git rev-list --count HEAD`, measured by the CALLER exactly where it already resolves
   * `bootHeadSha` above (`src/run-task.ts`, best-effort, in a try/catch), because this module
   * never touches the filesystem by its own header. Every sibling boot fact (env, node path, node
   * version, head sha) was already carried on this row and this one was not — a shallow clone
   * breaks every history read SILENTLY (`git log -S`, `--follow`, merge-base checks all stay
   * plausible over a truncated corpus) and nothing proactive asked. Recorded here, NOT ledgered
   * as a new row: the boot record is the boot record. A SHALLOW CHECKOUT MUST NOT HALT THE BOOT
   * (T197 doctrine, this function's own doctrine for the keychain rung above) — this only ever
   * adds fields to the existing `daemon.boot` line; `rmd doctor`'s `checkout-depth` arm
   * (`src/lib/doctor.ts`) is where the FAIL verdict lives. Appended LAST, after
   * `declaredNodeVersion`, per this function's own "no positional caller shifts" discipline.
   * Omitted ⇒ the fields are absent, exactly as before — never a guessed value.
   */
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
    // `kept` collapsed a confirmed-live holder and an unverifiable-foreign-host one into a
    // single count (W1-T461): a container replacement strands the latter forever (isHolderStale
    // rung 1, W1-T396, never reaps a foreign host), so `live`/`unverifiable_foreign_host` are
    // logged alongside the total so that permanently-stuck debris is legible on this boot line,
    // not indistinguishable from healthy live work.
    log("daemon.lock_sweep", {
      reaped: swept.reaped.length,
      kept: swept.kept.length,
      live: swept.live.length,
      unverifiable_foreign_host: swept.unverifiableForeignHost.length,
    });
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
  // W1-T530 part (ii): the boot-time half of the feedback-landing sweep — see this param's own
  // doc, above. A sweep failure is logged, never thrown onward — boot continues (T197: the
  // daemon sleeps through problems, never dies over a `git`/`gh` hiccup).
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
  // W1-T1044: see DaemonOpts.sweepWallClockBoundMs's own doc — POLICY DATA (rule 2), threaded
  // by the real `rmd daemon` entry, defaulted here for a direct/test caller that omits it.
  const sweepWallClockBoundMs = opts.sweepWallClockBoundMs ?? DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS;
  // W1-T1272: ONE mutable ref for "when did a full sweep last actually run", shared by every
  // call site below (the once-per-iteration call, the stale-freshness call, and every
  // "dispatch"/"retro" ticker's retrigger) — see `SweepRetrigger`'s own doc for why a shared
  // reference, not a fresh object per call site, is load-bearing here. `lastRunAtMs` starts
  // `undefined`: the first sweep of this process's life runs unconditionally (unchanged from
  // before this task), never gated on an elapsed-time check against a run that never happened.
  // W1-T2582: ONE liveness flag for this daemon's whole life, shared by every `runGatedSweep`
  // route — the top-of-iteration calls and the in-flight ticker's retrigger alike. Per-process
  // scope is the correct scope: see {@link SweepLiveness}.
  const sweepLiveness: SweepLiveness = { inFlight: false };
  const sweepRetriggerState: { lastRunAtMs: number | undefined } = { lastRunAtMs: undefined };
  const sweepRetrigger: SweepRetrigger = {
    sweepWallClockBoundMs,
    intervalMs: opts.sweepRetriggerIntervalMs ?? DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS,
    state: sweepRetriggerState,
    liveness: sweepLiveness,
  };
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
    } else if (verdict.kind === "memory") {
      // W1-T1038: a new discriminant on the shared `DispatchGovernorVerdict` union — added here
      // ONLY to keep this exhaustive-by-construction branch type-checking (`verdict.source`/
      // `verdict.error` below are NOT members of the "memory" arm). No production caller
      // currently supplies `DaemonDeps.checkMemoryGovernor` (that wiring is out of THIS task's
      // declared `files:`), so this branch is unreached today — it exists so a future wiring
      // task finds the log shape already correct rather than a type error.
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
  // W1-T2517: the CROSS-task counterpart to `blockRetryStates` just above — content-keyed on
  // "was the LAST blocked_transient a different task id", never on one task's own retry budget,
  // for the same W1-T113 reason `toolchainEscalated` is content-keyed rather than task-keyed
  // (see `reasonAboutApiWindow`'s own doc). Threaded across ticks for the life of this daemon run.
  let apiWindowHoldState: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
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
  // DISK HEADROOM ESCALATION DEDUP (W1-T1082): the SAME per-episode-latch shape
  // `headroomReserveEscalated` applies just above, threaded (never redeclared) into every
  // `startInFlightTicker`/`sweepLightDuringRetro` call below so ALL THREE phases (dispatch,
  // sweep, retro) share the ONE latch for this daemon run — a breach first observed mid-dispatch
  // must not re-escalate the moment a sweep tick observes the same still-unresolved reading.
  // Cleared the instant a reading is back at OK, so a LATER breach (a genuinely new episode)
  // escalates again rather than staying silenced for the rest of this process's life. Held as a
  // mutable object, not a bare `let`, because `startInFlightTicker` is a free function called
  // fresh per phase — a plain closed-over boolean would reset every call; this object is the
  // SAME reference across all of them.
  const diskHeadroomLatch: { escalated: boolean } = { escalated: false };
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
  const maxApiWindowHoldMs = opts.maxApiWindowHoldMs ?? DEFAULT_MAX_API_WINDOW_HOLD_MS;
  // BOUNDED DEGRADED MODE (recon R-7: the live ledger shows /usage unreadable
  // ~78% of the time — an unconditional fail-closed-on-first-miss would halt
  // the fleet most of the time, so this counts CONSECUTIVE misses instead of
  // treating any single one as decisive). Reset to zero by any successful
  // read; escalates to the in-process idle heartbeat once it exceeds
  // `unreadableDegradedLimit` — see the headroom check below.
  let consecutiveUnreadable = 0;
  // THE PARK CLOCK. Set on the tick a park BEGINS, cleared whenever the park ends — by a
  // readable probe OR by the ceiling forcing. Clearing on a FORCE is what re-arms the ceiling:
  // a valve that opened once and stayed open would let a blind fleet dispatch unbounded after
  // minute thirty, which is a different and worse failure than the park it replaces.
  let parkedSinceMs: number | undefined;
  // Once per PARK, not once per tick — the same in-process discipline `starvationEscalated`
  // below uses, and for the same reason: the loop polls every 60s, so a per-tick escalation is
  // a pager. Re-armed wherever the park clock is.
  let parkCeilingEscalated = false;
  // Seeded from the ledger so the once-per-string bound survives a restart, then maintained
  // in-process for the life of this daemon.
  const reportedUnrecognisedResets = new Set<string>(deps.priorUnrecognisedResets ?? []);
  const headroomPolicy = opts.headroomPolicy ?? buildDefaultHeadroomPolicy(opts.headroomLimitPct);
  // The headroom governor switch (ruling fb-1784894405468-a4153e). Library default
  // TRUE (existing enforcement + tests unchanged); the live `rmd daemon` entry
  // passes the host posture resolved from config/env — also default TRUE since the
  // 2026-07-25 ruling, with this host opting out via `headroom.enabled: false`.
  const headroomEnabled = opts.headroomEnabled ?? true;
  // W1-T2565: ONE sampler state shared by the main loop and every in-flight ticker, so the two can
  // never double-read and the staleness bound is measured against whichever of them read last.
  // Seeded to 0 so the first long phase after boot samples immediately rather than waiting out
  // HEADROOM_SAMPLE_MAX_AGE_MS on a governor that has never read at all.
  const headroomSampler = { lastSampleMs: 0, now: () => now().getTime(), policy: headroomPolicy, enforced: headroomEnabled };
  const unreadableDegradedLimit = opts.unreadableDegradedLimit ?? DEFAULT_UNREADABLE_DEGRADED_LIMIT;
  const parkCeilingMs = opts.headroomParkCeilingMs ?? HEADROOM_PARK_CEILING_MS;
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
    isMerged: MergedSet,
  ): Promise<{ kind: "merged" } | { kind: "continue" } | { kind: "genuine_blocker"; detail: string }> => {
    // W1-T976: `result.verdict` describes how THIS RUN ended, not whether the task's pull
    // request is merged — a PR that merges gate-side (GitHub's required-status contract)
    // AFTER the run stopped leaves `result.merged` false even though the task is done. The
    // tick's already-resolved merged projection (`isMerged`, threaded in from `deps.refreshMerged()`
    // — never a second GitHub lookup, see this function's own call site) answers the question
    // block-reasoning is actually trying to ask. A task the projection credits as merged takes
    // the SAME `{ kind: "merged" }` path a merged `result` always took; a genuinely unmerged task
    // reaches `reasonAboutBlock` exactly as before.
    if (!result.merged && isMerged(task.id)) {
      merged.push(task.id);
      return { kind: "merged" };
    }
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
    // LIVENESS TICK (W1-T1274). THE ONE ROW THIS LOOP WRITES UNCONDITIONALLY, EVERY ITERATION,
    // ON EVERY PATH BELOW — max_reached, stop, pause, a stale-freshness early return, idle, or a
    // full dispatch/sweep/retro pass. Every OTHER `daemon.`-prefixed step is either boot-time and
    // one-shot, or (`daemon.alive`, {@link startInFlightTicker}) confined to the three windows
    // that ticker actually runs in (retro/full-sweep/dispatch-settling) — so a stretch of the loop
    // outside all three (the inter-iteration `deps.sleep`, and every tick that returns early at
    // the freshness check before a ticker is ever started) wrote NO `daemon.`-prefixed row at all.
    // MEASURED: the `daemon.`-prefix went silent for 102.5 minutes on 2026-08-23 while the daemon
    // stayed alive, alternating exactly those short, ticker-less iterations back to back — the
    // false FAIL `judgeLedgerFreshness`/`deriveLastPoll` (doctor.ts, daemon-health.ts) read against
    // a two-minute bound. Placed as literally the first statement of the loop body, before even
    // `checkStop`, so it cannot be skipped by any branch below.
    log("daemon.tick", { poll_interval_ms: pollIntervalMs });

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
    // PAUSE (W1-T11) is checked BEFORE SELF-FRESHNESS (W1-T936) — a deliberate operator
    // hold must win against a restart decision, exactly like STOP already wins against it
    // above. Before this reorder PAUSE sat below the freshness exit: a paused daemon on a
    // checkout that never fast-forwards its own (nothing in the daemon's own boot moves its
    // ref) hit `return summary("stale", ...)` on every tick, exited nonzero, and launchd's
    // KeepAlive{SuccessfulExit:false} relaunched it straight back into the same PAUSE flag —
    // the 2026-08-17 relaunch storm, the same shape as the 2026-07-22 storm PAUSE's own
    // exit-vs-idle fix (below) already defends against, just arriving through the freshness
    // check instead of PAUSE's own return. PAUSE is an IN-PROCESS idle, never an exit: one
    // heartbeat per tick, sleep on the injected clock, re-poll — `rmd resume` deletes the
    // flag and the very next tick of this SAME process proceeds, at which point
    // SELF-FRESHNESS below fires immediately if origin/main moved while paused, so a stale
    // checkout is never dispatched against — a paused daemon dispatches nothing at all.
    // STOP (above) is still checked first, so a hard STOP still terminates a paused daemon
    // cleanly (exit 0) instead of idling forever.
    const paused = deps.checkPause?.();
    if (paused) {
      ticks++;
      log("daemon.pause", { tick: ticks, detail: paused, poll_interval_ms: pollIntervalMs });
      await deps.sleep(pollIntervalMs);
      continue;
    }
    // SELF-FRESHNESS (W1-T126): checked directly after STOP and PAUSE (W1-T936) — both are
    // deliberate operator holds and both now win outright against a restart decision — and
    // before headroom/dispatch, so origin/main advancing past this process's own boot sha is
    // noticed on the very next tick where the daemon is neither stopped nor paused. Never
    // interrupts in-flight work: like `checkStop`/`checkPause`, this is only consulted
    // between iterations. See `DaemonDeps.checkFreshness`'s doc for the full contract.
    const freshness = deps.checkFreshness?.();
    if (freshness?.stale) {
      // W1-T151: install BEFORE the loop stops for restart — never after — so the
      // freshly-relaunched process (booting at newSha) inherits deps that already
      // match it, not the stale node_modules this tick's own process is still running.
      if (freshness.installNeeded) {
        deps.runInstall?.();
      }
      // W1-T1272 (THE FULL SWEEP IS UNREACHABLE AFTER A BOOT'S FIRST ITERATION, design part
      // (ii), "the ordering"): REACH THE GATE BEFORE RETURNING. Before this, a stale verdict
      // returned from `runDaemon` sixty-four lines above the loop's only `deps.sweep!()` call
      // (below), so origin/main advancing past this process's boot sha — which the fleet's own
      // throughput causes routinely — closed the ONE thing that starts a full sweep before it
      // could ever fire again this boot. Never widens what the sweep may decide (design (v)):
      // this is the SAME `deps.sweep` call, under the SAME wall-clock bound and light-sweep
      // ticker, that the non-stale path below already runs — just also reached from here. The
      // stale verdict is never suppressed by running it: `return summary("stale", ...)` below
      // still fires unconditionally afterward (design (iii): the restart stays).
      if (deps.sweep) {
        sweepRetriggerState.lastRunAtMs = now().getTime();
        await runGatedSweep(deps, pollIntervalMs, sweepWallClockBoundMs, log, diskHeadroomLatch, headroomSampler, sweepLiveness);
      }
      const detail =
        `origin/main advanced ${freshness.oldSha.slice(0, 7)}..${freshness.newSha.slice(0, 7)} ` +
        `past this process's boot sha`;
      log("daemon_selfrestart_for_freshness", { old_sha: freshness.oldSha, new_sha: freshness.newSha });
      return summary("stale", detail);
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
    //
    // W1-T513 — THE THIRD TICKER CALL SITE. `deps.sweep()` (the full reconciler, over EVERY
    // open PR, sequentially) was the one remaining long tick occupant with no ticker of its
    // own: retro and dispatch (below) both already tick `sweepLight` while they run, so a
    // green, review-eligible PR still posted within one poll interval during either of those
    // — but a slow full sweep (a real `gh` walk over every open PR) starved the light pass for
    // its own entire duration, with no ticker running at all. Wrapping it here was UNSAFE
    // before this same task lifted {@link "./sweep.js".inFlightReviewKeys} out of `runSweep`
    // into a module-level, cross-call mutex: without that, this ticker's own `sweepLight()`
    // ticks would run CONCURRENTLY with `deps.sweep()`'s own `runSweep` walk and could both
    // decide to post a review for the same PR at once (the exact race
    // `test/daemon.test.ts`'s "TODAY's post-review dedup is a ledger READ, not a mutex"
    // fixture demonstrated). With that mutex now shared process-wide, the two concurrent
    // callers arbitrate the SAME `${taskId}@${headSha}` key correctly, so ticking here is safe
    // exactly like the retro/dispatch sites are. Same discipline as both: cleared on every
    // exit path via `finally`, a `sweepLight()` already in flight is allowed to finish rather
    // than aborted, and a ticker hiccup is ledgered (`daemon.sweep_light.failed`) but never
    // propagated.
    // W1-T1272: the bound/ticker logic formerly inlined here now lives in `runGatedSweep`,
    // shared with the "reach the gate before returning" call in the stale-freshness branch
    // above and with every ticker's retrigger (`SweepRetrigger`) — see that function's own doc.
    // `sweepRetriggerState.lastRunAtMs` is updated here too, so a retrigger's own elapsed-time
    // check (below, in `startInFlightTicker`) measures from whichever call actually ran last.
    if (deps.sweep) {
      sweepRetriggerState.lastRunAtMs = now().getTime();
      await runGatedSweep(deps, pollIntervalMs, sweepWallClockBoundMs, log, diskHeadroomLatch, headroomSampler, sweepLiveness);
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

    // FEEDBACK-LANDING SWEEP (W1-T530 design part ii): runs alongside the orphan sweep above,
    // on the SAME "once per iteration" cadence — daemon BOOT already runs it once (see
    // `daemonBoot`'s own `sweepFeedbackLanding` param, above); this is the "each poll" half, so
    // an entry captured (or a landing attempt that failed) BETWEEN polls — not only stranded
    // before the last boot — is still found within one cycle. Best-effort by the same contract
    // as `deps.sweepOrphans`: a `git`/`gh` hiccup costs one logged tick, never the daemon's
    // liveness. Optional — omitted, the loop behaves exactly as before this sweep existed.
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

    // GITHUB-SIDE POSTURE DRIFT CHECK (W1-T1040): runs alongside the sweeps above, on the SAME
    // "once per iteration" cadence — the hook itself throttles the actual read to at most once a
    // day (github-posture.ts's decideGithubPostureCheck), so most ticks return `[]` at no network
    // cost. Best-effort by the same contract as `sweep`/`sweepOrphans`/`sweepFeedbackLanding`
    // above: a throw costs one logged tick, never the daemon's liveness. A non-empty return is
    // LEDGERED — never gated, never a `continue`, never consulted by any governor below — so a
    // posture finding can never halt a dispatch or fail a check (task rationale (vii)). Optional:
    // omitted ⇒ the loop behaves exactly as before this check existed.
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

    // MEASUREMENT CADENCE (W1-T1259): "is this system getting better" — `rule-efficacy`,
    // `verdict-calibration`, `autonomy-rate` — runs alongside the sweeps/posture check above, on
    // the SAME "once per iteration" cadence; `checkMeasurementCadence`'s own policy-data bound
    // throttles the actual run to at most `maxPerDay` times, at least `minIntervalMinutes` apart,
    // so most ticks decide `fire: false` at no cost. Best-effort by the SAME contract as
    // `checkGithubPosture` above: a throw costs one logged tick, never the daemon's life, and a
    // fired run NEVER gates dispatch, fails a check, or changes a verdict — it is a ledger row
    // for the operator, nothing more. Optional: omitted ⇒ the loop behaves exactly as before this
    // rung existed (the three verbs stay operator-run only).
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
            // W1-T2502: the row is DERIVED from `result`'s own keys (see
            // `buildMeasurementCadenceRow`'s own doc, measurement-cadence.ts) rather than
            // hand-enumerated here — a hand-enumerated row silently drops every member added
            // after it (that is exactly how `adoptionReport`, and independently
            // `proofDebtReport`/`proofDebtMint`, reached zero occurrences in this file).
            log("measurement_cadence.ran", buildMeasurementCadenceRow(result));
          } catch (e) {
            log("measurement_cadence.run_failed", { error: String((e as Error)?.message ?? e) });
          }
        }
      } else if (decision) {
        log("measurement_cadence.skipped", { reason: decision.reason });
      }
    }

    // DIGEST CADENCE (W1-T2277): "the digest fires on its own cadence from the daemon loop
    // rather than only when a verb is typed" — SEPARATE from the measurement-cadence block just
    // above (its own policy row, its own marker file, see `DaemonDeps.checkDigestCadence`'s
    // doc), on the SAME "once per iteration" tick discipline. Best-effort by the SAME contract
    // as `checkMeasurementCadence` above: a throw costs one logged tick, never the daemon's
    // life, and a fired digest NEVER gates dispatch, fails a check, or changes a verdict.
    // Optional: omitted ⇒ the loop behaves exactly as before this rung existed.
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

    // BOARD REVIEW (W1-T2304's design, wired here). The rung whose unit is the WHOLE OPEN BOARD.
    // Same shape and the same best-effort contract as the two cadences above, on its own policy
    // row and its own marker file.
    //
    // THE LEDGER ROWS BELOW ARE PART OF THE FIX, NOT DECORATION. `board-review.ts` has no `log()`
    // hook of its own, so before this block a fire would have written no ledger row at all and
    // "did it run" was answerable only by the presence of a file nothing watches. These rows are
    // what the digest already sweeps into the inbox, and they are what makes a future
    // "has it fired" question a one-line ledger read instead of a recon.
    //
    // W1-T2464: `checkBoardReview` also RECONCILES — every call, fired or not — retiring any
    // registry proposal whose referent PR has left the board it just read (see
    // `reconcileBoardReviewReferents`'s header doc, board-review.ts). `retiredProposalIds` is
    // logged on BOTH branches below, deliberately: reconciliation is bookkeeping tied to the
    // check, not to the fire, so a tick that retires rows but does not itself fire must still be
    // visible — a reconciliation nobody can see repeats this file's own history (the rung fired
    // five times before anyone noticed, because nothing surfaced its output).
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
      // W1-T2565: the authoritative per-tick read STAMPS the shared sampler, so an in-flight
      // ticker starting immediately after it waits out the full staleness bound instead of
      // re-probing seconds later. Stamped before the `if (snap)` guard because an UNREADABLE read
      // is still an attempt — leaving it unstamped would let a failing probe be retried by the
      // ticker on every single pass.
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
            // ONCE PER WINDOW, NOT PER DISTINCT STRING (W1-T482). The loop polls every 60s, so a
            // per-tick emission would write ~1,440 identical lines a day and bury the one thing
            // worth reading — which is exactly what keying on the raw string stopped preventing
            // once the upstream started emitting microsecond-precision ISO timestamps: every tick
            // produces a string no earlier tick produced, so a raw-keyed set never once matched and
            // the bound was inert (measured 1:1 fired-to-distinct on two independent ledgers).
            // `window` is the small, fixed set this was always meant to bound by. The set is seeded
            // from the ledger (DaemonDeps.priorUnrecognisedResets), so the bound holds across a
            // restart as well as within one process.
            if (reportedUnrecognisedResets.has(window)) return;
            reportedUnrecognisedResets.add(window);
            // CARRY THE STRING — the whole value is knowing WHAT could not be parsed. A line
            // saying only "parse failed" would have saved nobody the three-hour outage. A coarser
            // key must not mean a lost sample, so the one line this window DOES emit still carries
            // a representative raw value, even though later drift on this window won't re-fire.
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
          await deps.sleep(pollIntervalMs);
          continue;
        }
        if (parkGate.forced) {
          // THE CEILING FIRED. Dispatch proceeds this tick with the governor still blind, and the
          // row says so plainly: the bound being bypassed exists to stop the fleet spending
          // against an exhausted account, so forcing DELIBERATELY accepts that risk rather than
          // pretending the read succeeded. Mirrors `deploy.idle_ceiling_forced`.
          //
          // ONE TICK, NOT A MODE. Clearing the clock here re-arms the ceiling, so the next park
          // waits the full period again — the exposure is bounded at one blind dispatch per
          // ceiling, never an unbounded blind run.
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
    // like any other dispatch would) and BEFORE the normal task-dispatch pick.
    // Best-effort: a caught error costs one logged tick, never the daemon's life (same
    // discipline as deps.sweep/deps.sweepOrphans above).
    //
    // W1-T2265: NO `sleep(pollIntervalMs)`/`continue` here, DELIBERATELY, unlike the
    // pause/headroom/cost-and-queue-governor gates above. Those three exist to REFUSE a
    // dispatch and must keep their poll-and-retry shape (task rationale, "what must not
    // change"). The retro gates nothing — W1-T276's ruling that it stays BLOCKING (a bare
    // `await`, still wrapped in `sweepLightDuringRetro` so the light sweep keeps ticking
    // while it runs) is unchanged below — it only ever DELAYED reaching dispatch, by
    // costing a full poll interval before the next attempt even when this same tick's
    // `dispatchSet` (computed further down) would otherwise have had work to admit.
    // Falling through here — instead of restarting the loop — lets a tick that fires the
    // retro still reach dispatch selection/admission/`runOne` below, on the SAME tick,
    // with no invented reordering of the rungs still above this point (pause, freshness,
    // headroom, the cost/queue governor) and no change to any of their own gates.
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
          }
        }
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
    // W1-T916 — ONE SWEEP PER TICK, resolved before the options object so the closure below is a
      // set-membership test rather than a round trip per candidate.
      const pushedRunBranches = deps.readPushedRunBranches
        ? runBranchTaskIds(deps.readPushedRunBranches())
        : undefined;
      const dispatchOpts: NextRunnableOpts = {
      isOpenPr: deps.isOpenPr,
      // W1-T2397: forwarded into the tick's own opts, exactly as drain.ts forwards them at both of
      // its `skipOpts` sites. `nextRunnable` consults them AFTER eligibility and BEFORE returning,
      // so this cannot change what this tick dispatches.
      openSiblingBuildFor: deps.openSiblingBuildFor,
      onOpenSiblingBuild: deps.onOpenSiblingBuild,
      // W1-T2286: the SAME map handed to `partitionByFileOverlap`'s own direct call below — see
      // `DaemonDeps.observedByTask`'s own doc for why the pack step and the real partition must
      // never disagree.
      observedByTask: deps.observedByTask,
      // W1-T916: the argument W1-T534 declared and nothing supplied — see DrainDeps'
      // `readPushedRunBranches` for why the reader is injected and the parse hoisted.
      ...(pushedRunBranches
        ? {
            hasPushedRunBranch: (id: string) => pushedRunBranches.has(id),
            // Rides the EXISTING `dispatch.skipped` row with its own reason — no new step, and
            // deliberately not `dispatch.stood_down`, which has three emitters and no reader.
            onSkipRunBranch: (t: Task) =>
              log("dispatch.skipped", { task: t.id, reason: "run-branch-already-pushed" }),
          }
        : {}),
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
    // W1-T469 — THE RULING'S GATE, hoisted here because `partition` is scoped to the else-branch
    // below while the rung now runs OUTSIDE the idle branch. Zero means the partitioner deferred
    // nothing this tick; the forced-next path leaves it zero, which is correct (an operator-forced
    // dispatch is not evidence that the queue collided).
    let deferredPairings = 0;
    // W1-T469 follow-up: HOISTED for the same reason `deferredPairings` was — the rung reads it
    // outside this branch. Left at 0 on the forced-next path: an operator-forced dispatch is not
    // evidence of spare capacity, and 0 makes `dispatchCount < laneBudget` false there.
    let laneBudget = 0;
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
      // W1-T2286: `deps.observedByTask` passed EXPLICITLY (`?? NO_OBSERVED_SCOPE`) rather than
      // omitted, so this call site no longer relies on `partitionByFileOverlap`'s own default
      // parameter — see `DaemonDeps.observedByTask`'s own doc.
      const partition = partitionByFileOverlap(candidates, deps.observedByTask ?? NO_OBSERVED_SCOPE);
      for (const d of partition.serialized) log("dispatch.serialized", serializedLedgerPayload(d));
      deferredPairings = partition.serialized.length;
      laneBudget = budget;
      dispatchSet = partition.dispatch;
    }

    // ── AUTO-TRIAGE RUNG — RUNS BEFORE THE IDLE BRANCH (operator ruling, reversing W1-T469) ──
    // THE STARVED STATE IS THE IDLE STATE, WHICH IS WHY THIS MOVED AGAIN. W1-T469 placed this
    // AFTER the idle `continue` and justified it: a deferral implies a non-empty dispatch set, so
    // an idle tick could only ever reach "no deferral this pass". That reasoning was correct and
    // the GATE it served was circular — a deferral needs two eligible tasks to collide, so a fleet
    // with nothing eligible can never produce one, and the rung that CREATES work could only fire
    // when work already existed. MEASURED on a starved daemon: `auto_triage.skipped — no deferral
    // this pass` beside `dispatch.starvation.escalated — blocked: 5, unmet_deps: 3`, ~87 feedback
    // entries unread, thirteen hours.
    //
    // So the second trigger — `dispatchCount < laneBudget`, the queue failing to fill free
    // capacity — is EXACTLY an idle-tick condition, and leaving the rung below the `continue`
    // would have shipped the new gate as dead code.
    //
    // THE COST THIS ACCEPTS, STATED RATHER THAN DISCOVERED LATER. Running before the branch means
    // an idle tick now writes an `auto_triage.skipped` row whenever the interval or the cap holds
    // it: at a 60s poll and a 15m floor that is ~14 rows per fire, and `rotateLedger` retains
    // MAX_RETAINED_LINES_PER_STEP = 200 per step. That volume is the price of the rung reaching a
    // decision in the only state that needs it, and each row NAMES which bound held — which is
    // the diagnostic, not noise. If it proves too loud, dedupe on reason-change the way
    // `daemon.idle_reasons` already does above; do not solve it by moving this back down.
    // DEFAULT OFF and bounded by `minIntervalMinutes` + `maxPerDay` (lib/auto-triage.ts) — the
    // only two bounds left since W1-T475 deleted the adaptive curve. Best-effort in the retro's
    // idiom: a throw here costs one logged tick, never the daemon.
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
            }
          }
        }
      } else if (decision) {
        log("auto_triage.skipped", { reason: decision.reason });
      }
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
      // to name apart from. `retired` (W1-T2474) joins that same excluded set: a `blocked` task
      // carrying a retirement ruling is drain.ts's own record that it will never be built, so a
      // queue whose only remaining blockers are retired is DONE-BY-RULING, not starved — waiting
      // never helps it either. Named on the census below (never silently dropped) but never
      // counted toward `starved`.
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


      await deps.sleep(pollIntervalMs);
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

    // RE-CHECK STOP/PAUSE IMMEDIATELY BEFORE ADMISSION (W1-T1065). `checkStop`/`checkPause`
    // above are each read EXACTLY ONCE, at the top of this tick — but `deps.checkFreshness`,
    // `await deps.sweep()` (the full reconciler over every open PR), `await deps.sweepOrphans()`,
    // `await deps.sweepFeedbackLanding()` and `await deps.readUsage()` all sit, awaited and
    // unbounded, between that read and here. MEASURED on the live ledger (this task's own
    // rationale): a `state/PAUSE` created 4.5 minutes after the top-of-tick read still dispatched
    // — the sweep-to-next-`daemon.iteration` gap runs p50 39.6s, p95 32.1m, max 64.5m, so the
    // top-of-tick read is stale by the time admission happens on any but the fastest ticks.
    // Re-reading the IDENTICAL deps here, immediately before this tick's batch is admitted,
    // closes that window without adding a new control: nothing has been admitted yet, so a hold
    // observed here defers the WHOLE `dispatchSet` computed above (discarded, never dispatched)
    // and returns to the top of the loop, where the ordinary stop/pause handling — including its
    // own sleep/heartbeat — takes over exactly as it would have on a top-of-tick read. This can
    // NEVER abort a lane already admitted or already running: `admitted` below is still empty at
    // this point, and `Promise.allSettled` (further down) is unreached — the drain-and-hold
    // guarantee for anything already in flight is completely untouched.
    const restopped = deps.checkStop?.();
    if (restopped) {
      log("daemon.stop", { detail: restopped });
      return summary("stopped", restopped);
    }
    const repaused = deps.checkPause?.();
    if (repaused) {
      ticks++;
      log("daemon.pause", {
        tick: ticks,
        detail: repaused,
        poll_interval_ms: pollIntervalMs,
        recheck: true,
      });
      await deps.sleep(pollIntervalMs);
      continue;
    }

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
    const stopTicker = startInFlightTicker(deps, pollIntervalMs, log, "dispatch", diskHeadroomLatch, sweepRetrigger, headroomSampler).stop;

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
    // W1-T2517: updated ALONGSIDE block-reasoning, never inside it — a pure additional
    // observation over the SAME per-lane loop (see `reasonAboutApiWindow`'s doc). Lane order
    // is the settlement order already fixed above, so a batch is walked deterministically.
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
      return summary("blocked", blockedDetail);
    }

    if (apiWindowHoldMs > 0) {
      // CONSECUTIVE DIFFERENT-task-id `blocked_transient` refusals (>= API_WINDOW_HOLD_STREAK_FLOOR):
      // hold dispatch rather than let the next tick immediately pay another full spawn (worker
      // home, containment preflight, isolation preflight, worktree) to rediscover the identical
      // closed window. VISIBLE by design (rationale: "never a silent idle that reads as a healthy
      // queue") — one ledger row naming the reason, the streak that triggered it, and the
      // wall-clock instant dispatch resumes.
      ticks++;
      const resumesAtMs = now().getTime() + apiWindowHoldMs;
      log("daemon.api_window_hold", {
        tick: ticks,
        hold_ms: apiWindowHoldMs,
        consecutive_different_tasks: apiWindowHoldState.streak,
        reason: "consecutive blocked_transient refusals across different tasks — the API usage window looks closed; holding dispatch instead of re-discovering it per task",
        resumes_at: new Date(resumesAtMs).toISOString(),
      });
      await deps.sleep(apiWindowHoldMs);
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
