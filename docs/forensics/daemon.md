# daemon.ts forensics

Measured forensics, incidents and design arguments removed from `src/lib/daemon.ts` when its comments were compacted to the plain-language standard. The code keeps a short pointer at each site — a `// Why:` line, a task id, or a PR number; the full record is here.

Every block below is reproduced verbatim from the source at the base commit. Only the comment markers (`/**`, ` * `, `//`) were stripped; no wording was changed. Each heading names the symbol the block explained, and the line range is the range at the base commit.

## Contents

- [Module header](#module-header) — base lines 1-32
- [DaemonStopReason](#daemonstopreason) — base lines 103-136
- [DEFAULT_POLL_INTERVAL_MS](#defaultpollintervalms) — base lines 139-153
- [DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS](#defaultsweepwallclockboundms) — base lines 156-164
- [DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS](#defaultsweepretriggerintervalms) — base lines 167-206
- [DAEMON_EXIT_STALE](#daemonexitstale) — base lines 209-228
- [DAEMON_EXIT_BLOCKED](#daemonexitblocked) — base lines 231-262
- [DAEMON_EXIT_ENVIRONMENTAL](#daemonexitenvironmental) — base lines 265-289
- [daemonExitCode](#daemonexitcode) — base lines 292-344
- [daemonExitCodeForSummary](#daemonexitcodeforsummary) — base lines 355-377
- [buildDefaultHeadroomPolicy](#builddefaultheadroompolicy) — base lines 401-421
- [resolveHeadroomLimitPct](#resolveheadroomlimitpct) — base lines 429-436
- [resolveHeadroomLimitPct (the past-dated guard)](#resolveheadroomlimitpct-the-past-dated-guard) — base lines 438-462
- [UNRECOGNISED_RESET_MAX_LEN](#unrecognisedresetmaxlen) — base lines 479-501
- [priorUnrecognisedResetStrings](#priorunrecognisedresetstrings) — base lines 504-517
- [canonicalizeResetInstant](#canonicalizeresetinstant) — base lines 587-594
- [resolveHeadroomWindows](#resolveheadroomwindows) — base lines 621-631
- [instant](#instant) — base lines 654-662
- [DEFAULT_UNREADABLE_DEGRADED_LIMIT](#defaultunreadabledegradedlimit) — base lines 684-700
- [evaluateHeadroomPark](#evaluateheadroompark) — base lines 722-736
- [headroomEnabled](#headroomenabled) — base lines 757-769
- [headroomLimitPct](#headroomlimitpct) — base lines 771-778
- [maxApiWindowHoldMs](#maxapiwindowholdms) — base lines 806-813
- [DaemonOpts.laneCount](#daemonoptslanecount) — base lines 815-832
- [wipLimit](#wiplimit) — base lines 834-846
- [sweepWallClockBoundMs](#sweepwallclockboundms) — base lines 848-858
- [sweepRetriggerIntervalMs](#sweepretriggerintervalms) — base lines 860-870
- [DaemonFreshness](#daemonfreshness) — base lines 874-888
- [StarvationCensus](#starvationcensus) — base lines 893-911
- [StarvationClearedInfo](#starvationclearedinfo) — base lines 919-926
- [decideAlertPoll](#decidealertpoll) — base lines 950-969
- [reloadPlan](#reloadplan) — base lines 1001-1010
- [targetRepo](#targetrepo) — base lines 1029-1037
- [openSiblingBuildFor](#opensiblingbuildfor) — base lines 1039-1050
- [isCircuitTripped](#iscircuittripped) — base lines 1061-1068
- [observedByTask](#observedbytask) — base lines 1078-1087
- [breakerDetail](#breakerdetail) — base lines 1089-1096
- [DaemonDeps.checkCostGovernor](#daemondepscheckcostgovernor) — base lines 1116-1142
- [reloadDailyCostCeilingUsd](#reloaddailycostceilingusd) — base lines 1144-1161
- [checkQueueGovernor](#checkqueuegovernor) — base lines 1163-1183
- [openPrCount](#openprcount) — base lines 1197-1204
- [readUsage](#readusage) — base lines 1206-1213
- [priorUnrecognisedResets](#priorunrecognisedresets) — base lines 1215-1222
- [onHeadroomBreach](#onheadroombreach) — base lines 1224-1243
- [readGhQuota](#readghquota) — base lines 1262-1271
- [onQuotaExhausted](#onquotaexhausted) — base lines 1273-1290
- [readDiskHeadroom](#readdiskheadroom) — base lines 1292-1305
- [onDiskHeadroomBreach](#ondiskheadroombreach) — base lines 1307-1324
- [onStarvation](#onstarvation) — base lines 1326-1340
- [onStarvationCleared](#onstarvationcleared) — base lines 1342-1362
- [DaemonDeps.checkFreshness](#daemondepscheckfreshness) — base lines 1378-1407
- [runInstall](#runinstall) — base lines 1409-1419
- [pendingKicks](#pendingkicks) — base lines 1421-1428
- [now](#now) — base lines 1458-1466
- [sweep](#sweep) — base lines 1470-1478
- [sweepOrphans](#sweeporphans) — base lines 1486-1495
- [sweepFeedbackLanding](#sweepfeedbacklanding) — base lines 1497-1509
- [checkGithubPosture](#checkgithubposture) — base lines 1511-1522
- [checkMeasurementCadence](#checkmeasurementcadence) — base lines 1524-1531
- [runMeasurementCadence](#runmeasurementcadence) — base lines 1533-1541
- [checkDigestCadence](#checkdigestcadence) — base lines 1543-1551
- [DaemonDeps.checkBoardReview](#daemondepscheckboardreview) — base lines 1561-1581
- [checkRetroTrigger](#checkretrotrigger) — base lines 1591-1601
- [runRetroTrigger](#runretrotrigger) — base lines 1603-1612
- [isFeedbackOpenPr](#isfeedbackopenpr) — base lines 1626-1634
- [DaemonDeps.sweepLight](#daemondepssweeplight) — base lines 1644-1665
- [escalateBlock](#escalateblock) — base lines 1667-1675
- [dispatchFix](#dispatchfix) — base lines 1677-1688
- [onSpawnInfraBlocked](#onspawninfrablocked) — base lines 1690-1702
- [isSpawnInfraBlocked](#isspawninfrablocked) — base lines 1706-1714
- [INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS](#interphasereviewclockstopboundms) — base lines 1719-1727
- [startInterphaseReviewClock](#startinterphasereviewclock) — base lines 1736-1749
- [sweepLightDuringRetro](#sweeplightduringretro) — base lines 1803-1828
- [startInFlightTicker](#startinflightticker) — base lines 1845-1906
- [HEADROOM_SAMPLE_MAX_AGE_MS](#headroomsamplemaxagems) — base lines 1907-1945
- [holdSeen](#holdseen) — base lines 1976-1986
- [headroomSampler](#headroomsampler) — base lines 2004-2015
- [the full-sweep retrigger](#the-full-sweep-retrigger) — base lines 2059-2092
- [SweepRetrigger](#sweepretrigger) — base lines 2138-2145
- [runGatedSweep and SweepLiveness](#rungatedsweep-and-sweepliveness) — base lines 2161-2197
- [DEFAULT_MAX_API_WINDOW_HOLD_MS](#defaultmaxapiwindowholdms) — base lines 2288-2327
- [CrashLoopWindow](#crashloopwindow) — base lines 2376-2394
- [DEFAULT_CRASHLOOP_WINDOW](#defaultcrashloopwindow) — base lines 2402-2409
- [DaemonBootTimestamp](#daemonboottimestamp) — base lines 2426-2440
- [detectDaemonCrashLoop](#detectdaemoncrashloop) — base lines 2446-2459
- [daemonBoot](#daemonboot) — base lines 2486-2528
- [sweepOrphanWorkers](#sweeporphanworkers) — base lines 2564-2574
- [bootHeadSha](#bootheadsha) — base lines 2576-2583
- [sweepFeedbackLanding (2)](#sweepfeedbacklanding-2) — base lines 2585-2595
- [daemonBoot checkoutDepth](#daemonboot-checkoutdepth) — base lines 2611-2625
- [unlockWorkerKeychain](#unlockworkerkeychain) — base lines 2656-2663
- [checkDispatchGovernors](#checkdispatchgovernors) — base lines 2748-2761
- [function](#function) — base lines 2764-2778
- [sweepLiveness](#sweepliveness) — base lines 2788-2796
- [circuitEscalated](#circuitescalated) — base lines 2870-2878
- [headroomReserveEscalated](#headroomreserveescalated) — base lines 2893-2900
- [diskHeadroomLatch](#diskheadroomlatch) — base lines 2902-2911
- [processDispatchResult](#processdispatchresult) — base lines 3027-3044
- [result](#result) — base lines 3051-3058
- [blockRetryStates](#blockretrystates) — base lines 3083-3092
- [log](#log) — base lines 3120-3128
- [the liveness tick](#the-liveness-tick) — base lines 3148-3159
- [plan freshness](#plan-freshness) — base lines 3177-3193
- [planForBatch](#planforbatch) — base lines 3205-3223
- [deps](#deps) — base lines 3225-3232
- [PAUSE before self-freshness](#pause-before-self-freshness) — base lines 3240-3254
- [the top-of-iteration full pass](#the-top-of-iteration-full-pass) — base lines 3285-3320
- [deps (2)](#deps-2) — base lines 3388-3395
- [deps (3)](#deps-3) — base lines 3407-3415
- [the board-review block](#the-board-review-block) — base lines 3472-3488
- [the headroom block](#the-headroom-block) — base lines 3520-3532
- [reportedUnrecognisedResets](#reportedunrecognisedresets) — base lines 3550-3558
- [the unconditional headroom heartbeat](#the-unconditional-headroom-heartbeat) — base lines 3584-3605
- [the unreadable-usage branch](#the-unreadable-usage-branch) — base lines 3648-3661
- [log (2)](#log-2) — base lines 3687-3694
- [the tick-wide governor gate](#the-tick-wide-governor-gate) — base lines 3772-3792
- [the retro cadence trigger](#the-retro-cadence-trigger) — base lines 3802-3820
- [the dispatch set](#the-dispatch-set) — base lines 4007-4025
- [the auto-triage rung's placement](#the-auto-triage-rungs-placement) — base lines 4064-4087
- [the starvation predicate](#the-starvation-predicate) — base lines 4180-4196
- [the pre-admission STOP and PAUSE re-check](#the-pre-admission-stop-and-pause-re-check) — base lines 4254-4269
- [admitted](#admitted) — base lines 4304-4312
- [await](#await) — base lines 4353-4363
- [spawnInfraSeenThisTick](#spawninfraseenthistick) — base lines 4404-4411
- [crash recovery](#crash-recovery) — base lines 4502-4523
- [parseOrphanedBranch](#parseorphanedbranch) — base lines 4545-4552
- [reconstructOrphan](#reconstructorphan) — base lines 4565-4580

## Module header

Removed from `src/lib/daemon.ts` lines 1-32 at the base commit.

```text
lib/daemon.ts — the daemon's scheduler-loop CORE (W1-T12a).

W1-T12 (Daemonize) was split along the machine/human boundary (DIAGNOSIS.md,
Rule 16): this is the headless, unit-testable LOGIC half. Launchd unit
generation is W1-T12b (lib/launchd.ts); crash-recovery's resume/clean split
is W1-T12c (`reconstructOrphan`, below — its batch driver `reconstructState`
was retired, W1-T361: superseded by runRecoverability in src/run-task.ts, which
performs the same split read straight from the live ledger); actually loading
the plist on a real session, an overnight drain, and a live kill-and-recover
are the verify:human commissioning steps of W1-T12d — none of that is here.

`rmd drain` (drain.ts) is a bounded, one-shot pass a human kicks off by hand:
DAG-select → dispatch → repeat, until `--max`/`--until`/a block/no more work.
This is that SAME machinery — `nextRunnable`, the fleet-control gates (W1-T11
STOP/PAUSE), the HeadroomTracker (W1-T4) — reused wholesale, never
reimplemented, wired into a PERSISTENT loop instead of a bounded one: where
drain.ts's `no_runnable` is a terminal stop, this loop PACES itself with an
injected clock and keeps polling — new work can land later (a plan edit
merges, a dependency's PR lands out of band), and being there when it does is
the entire point of a daemon.

Blocks are no longer blunt stop-on-block (W1-T46, superseding v1): each
non-merged verdict is REASONED about via `block-reason.ts`'s
`reasonAboutBlock` — transient (retry, no strike), independent-failure (skip
only that task, flag it, keep draining everything else), or genuine blocker
(halt + escalate — never continue into the gap). See `runDaemon`, below.

Single-instance + per-task locking (drain-lock.ts / inflight-lock.ts) are
real side effects the CLI wiring (run-task.ts) owns, exactly as `rmd drain`
already does — this pure module never touches the filesystem.
```

## DaemonStopReason

Removed from `src/lib/daemon.ts` lines 103-136 at the base commit.

```text
Reason the scheduler loop returned — every terminal state is one of these.

`headroom_exhausted` is deliberately ABSENT: unlike `rmd drain` (a bounded
one-shot run, where headroom exhaustion is a terminal stop, see drain.ts's
own `StopReason`), the daemon is a PERSISTENT loop under launchd KeepAlive —
returning here at all ends the process, and KeepAlive relaunches it
(SuccessfulExit:false reads ANY exit, zero or not, as worth restarting on
this unit), so a headroom-exhausted reading used to restart-loop the daemon
roughly once per idle poll until the window reset. Headroom overage is now
an IN-PROCESS idle state handled inline in the loop below (same shape as
"nothing runnable"): it sleeps and re-polls via the injected clock, logging
a `daemon.headroom` heartbeat each tick, and never returns while still over
the limit.

`paused` is ABSENT for exactly the same reason (the 2026-07-22 relaunch
storm): PAUSE is a drain-and-hold, an awaiting-resume state with a KNOWN
clearing condition (`rmd resume` deletes the flag) — returning it exited
the process nonzero, KeepAlive relaunched (~10s throttle), and the fresh
boot re-read the same flag and exited again, storming until bootout. A
paused daemon now idles IN-PROCESS (a `daemon.pause` heartbeat per tick,
re-polling the flag via the injected clock), so `rmd resume` takes effect
on the next tick of the SAME process — no relaunch involved.

`stale` (W1-T126, DAEMON SELF-FRESHNESS) is the OPPOSITE polarity from
`headroom_exhausted`/`paused` above, deliberately: those two must never reach a
process exit (an awaiting-state relaunched by KeepAlive just re-reads the identical
condition and exits again — a storm). Staleness is not an awaiting-state; it is a
REQUEST to exit, because launchd's `KeepAlive{SuccessfulExit:false}` is the only
mechanism that can get a long-running daemon off code it loaded once at boot and
onto a fix merged since (the five-manual-cycles-in-a-weekend problem this task
fixes). So `stale` DOES reach {@link daemonExitCode} as a real stop reason, and maps
to a nonzero exit — see that function's doc.
```

## DEFAULT_POLL_INTERVAL_MS

Removed from `src/lib/daemon.ts` lines 139-153 at the base commit.

```text
Default idle-poll pace: check back once a minute while nothing is runnable.

W1-T253 (P37 CONSUMERS): every OTHER collected constant this task rewires reads its
default via `policy.ts`'s `loadDefaultPolicy` (a self-locating, memoized `readFileSync`).
THIS module cannot do that — see the file header: "this pure module never touches the
filesystem" (Rule 16's headless/live split; `runDaemon` must stay callable thousands of
times against an injected clock in a unit test with zero real I/O). So this literal
STAYS — it is the fs-free safety net for a direct/test caller that supplies no
`pollIntervalMs` at all — and the actual `rmd daemon` CLI entry (`daemonCommand`,
run-task.ts) is the one that loads `plan/policy.yaml`'s `pollIntervalMs` and threads it
into `DaemonOpts.pollIntervalMs` EXPLICITLY on every real invocation, so this constant is
provably dead for the operating path (test/policy-consumers.test.ts). Mirrors the
`buildDefaultHeadroomPolicy` curve just below, same reasoning.
```

## DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS

Removed from `src/lib/daemon.ts` lines 156-164 at the base commit.

```text
W1-T1044 (A SWEEP TICK HAS NO WALL-CLOCK BOUND): the DEFAULT bound on `await deps.sweep()`
below — mirrors plan/policy.yaml's `sweepWallClockBoundMs` row (net-new; the measured
healthy-vs-hung derivation lives in that file's comment). Same fs-free-safety-net reasoning
as {@link DEFAULT_POLL_INTERVAL_MS} immediately above: this pure module cannot load
`plan/policy.yaml` itself, so this literal is the default for a direct/test caller that
supplies no `DaemonOpts.sweepWallClockBoundMs`; the real `rmd daemon` entry
(`daemonCommand`, run-task.ts) threads `policy.values.sweepWallClockBoundMs` explicitly.
```

## DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS

Removed from `src/lib/daemon.ts` lines 167-206 at the base commit.

```text
W1-T1272 (THE FULL SWEEP IS UNREACHABLE AFTER A BOOT'S FIRST ITERATION): the DEFAULT minimum
gap, in ms, between two full-sweep runs triggered by the RETRIGGER below (never the
once-per-iteration call at the top of the loop, which this bound does not throttle). Without
a re-trigger, `deps.sweep()` only ran once at the top of an iteration and the loop's own
freshness exit — the ONLY other thing that starts a full sweep (task rationale (2)) — fires
only when origin/main has already moved past this process's boot sha, so a boot whose
dispatch/retro holds the loop for its own measured mean of 38.5 minutes got exactly one full
sweep for that whole span. 20 minutes gives ~3 passes an hour, which task design (i) prices at
a p90-cost of about 67 seconds an hour (under 4%) — cheap enough that FREQUENCY, not
concurrency, is the right lever; this constant raises how often the gate is reached.

⚠ W1-T2569 CORRECTION — THE CLAUSE THAT USED TO FOLLOW HERE WAS FALSE. It read "never how many
run at once (see `sweep still runs one at a time`, the same mutex-serialized `deps.sweep()`
every other call site already awaits sequentially)". SWEEPS DO OVERLAP, and not because of this
constant: {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS} immediately above stops AWAITING
`deps.sweep()` at 559s and does NOT CANCEL it, so any sweep whose work exceeds that bound keeps
running detached while the next iteration starts another. "Awaits sequentially" describes the
call sites; it does not describe the lifetimes. MEASURED 2026-09-01: six consecutive
batch/abandon alternations in the inbox-draft rung, `elapsed_ms: 559000` against
`bound_ms: 559000`, costing $123.30 in duplicated Architect spawns.

⚠ W1-T2582 UPDATE — THE PROPERTY IS TRUE AGAIN, BUT FOR A DIFFERENT REASON THAN THIS COMMENT
ONCE GAVE. It is NOT "the same mutex-serialized deps.sweep() every other call site already
awaits sequentially" — that was never what serialized anything. It is {@link SweepLiveness}:
`runGatedSweep` now DECLINES to start a pass while a previous one is still executing, a flag set
on start and cleared on SETTLE rather than on abandon. The bound still fires and still stops
awaiting; the abandoned pass still runs to completion untouched; only the duplicate is refused.
THE RETRIGGER IS COVERED BY THE SAME FLAG — it was a SECOND route in, and one the bound never
touched: measured, the last two pre-fix draft batches were 20m27s apart, this interval, not 559s.

THE CLASS THAT WAS. Every sweep-borne rung whose work can exceed 559s used to be re-entrant by
this mechanism; drafting was merely the one that spent per re-entry ($123.30 in duplicated
Architect spawns, measured 2026-09-01). The inbox-draft rung ALSO holds its own O_EXCL lock
(run-task.ts, W1-T2569) and keeps it: that lock additionally excludes `rmd inbox` and survives a
restart, neither of which an in-process flag can do. Same fs-free-safety-net
reasoning as {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS} immediately above: this pure module
cannot load `plan/policy.yaml` itself, so this literal is the default for a direct/test caller
that supplies no `DaemonOpts.sweepRetriggerIntervalMs`.
```

## DAEMON_EXIT_STALE

Removed from `src/lib/daemon.ts` lines 209-228 at the base commit.

```text
The exit code a FRESHNESS self-restart uses, distinct from a crash's 1 (W1-T490).

75 is `EX_TEMPFAIL` from sysexits(3) — "temporary failure, the user is invited to
retry" — which is precisely what a `stale` stop is: nothing is wrong, the process
simply needs to come back on newer code. Any nonzero value would work for docker
(it reads only zero/nonzero); a conventional one is chosen so an operator reading
`docker inspect --format '{{.State.ExitCode}}'` by hand gets a meaning rather than
a magic number.

THE VALUE IS DUPLICATED IN `deploy/entrypoint.sh`, DELIBERATELY, AND A TEST PINS
THE PAIR. The entrypoint cannot import this module: it runs at the exact moment
the daemon has failed, and its own restart-throttle block already records why it
refuses to depend on the repo being loadable then ("Reading it here instead would
need the plan loadable at exactly the moment an unloadable plan is what is
crashing the daemon — the measured incident"). A shell literal that silently
drifts from this constant would reinstate the whole defect while every unit test
stayed green, so `test/entrypoint-boot.test.ts` greps the script for this number
and fails if the two disagree.
```

## DAEMON_EXIT_BLOCKED

Removed from `src/lib/daemon.ts` lines 231-262 at the base commit.

```text
W1-T2537 — THE `blocked` EXIT CODE, THE OTHER HALF OF W1-T490.

W1-T490 separated `stale` from 1 because docker's `--restart=on-failure:N` counts every
non-zero exit against N and cannot read the value, so a ROUTINE outcome spent the same finite
budget as a crash. It then wrote that "`blocked` and `error` keep 1 precisely so that a crash
remains countable" — and that is where this defect lived. `error` IS a crash and keeps 1.
`blocked` is the daemon COMPLETING a drain pass and reporting that a task is blocked.

MEASURED 2026-08-30: a pass dispatched three tasks, opened three PRs and posted five review
verdicts, then exited 1 because one of them ended `blocked_ci`. The container sat
`Exited (1)` for 46+ minutes with nothing draining the board. The loop is self-sustaining: a
red board is exactly what PRODUCES blocked passes, so the restart budget is spent fastest
precisely when the fleet is most needed, and once spent nothing drains — which keeps the board
red. On a green board `blocked` is rare and none of this is visible.

THE FREQUENCY ARGUMENT RUNS THE OTHER WAY FROM W1-T490's. Freshness restarts were one per
merge (14 in 24 hours) and that was already enough to exhaust `on-failure:5` in half a day.
A blocked pass is one per PASS on a red board.

AS WITH `stale`, THIS FUNCTION ONLY MAKES THE CASE DISTINGUISHABLE; the accounting is
`deploy/entrypoint.sh`'s. And as with `stale`, this is strictly a refinement WITHIN non-zero:
launchd's `KeepAlive{SuccessfulExit:false}` and a bare `--restart=on-failure` with no
entrypoint support both still restart exactly as they did. An entrypoint that predates this
constant — the BAKED half of the split, inert until an image rebuild — sees an unrecognised
non-zero code and falls through to the same sleep-and-exit it uses today, so merging this
ahead of the rebuild changes nothing rather than regressing anything.

THE DAEMON'S STOP-ON-BLOCK DOCTRINE IS UNTOUCHED. `runDrainLanes`' stop-on-block-at-pass-
granularity is deliberate and stays; only how that halt is classified at the process boundary
changes, which is the one thing a supervisor can see.
```

## DAEMON_EXIT_ENVIRONMENTAL

Removed from `src/lib/daemon.ts` lines 265-289 at the base commit.

```text
W1-T2546 — A PASS KILLED BY AN ENVIRONMENTAL REFUSAL, which is a THIRD thing that is not a
crash. Same argument {@link DAEMON_EXIT_BLOCKED} already won for `blocked`, one category over.

OBSERVED 2026-08-31 18:42-18:44 UTC in the operator's own daemon log: two PRs (#3428, #3429)
had already been opened successfully and the run died READING ONE BACK —
`Command failed: gh api repos/.../pulls/3428 ... API rate limit exceeded ... (HTTP 403)`. That
surfaced as `stopReason: "error"`, mapped to 1, and docker's `on-failure` counted the restart.
Nothing about the tree, the plan or the code was wrong; the correct response was to WAIT, which
is exactly what this container already knows how to do for the other two non-crash codes.

WHY IT MATTERS BEYOND TIDINESS: this account's GraphQL budget is exhausted routinely, and a
90-minute secondary-limit lockout has already happened once. During such a window EVERY pass
can die this way, so the crash budget drains at the rate the limiter refuses — and once it is
gone the fleet is dead with a red board and no failing check to explain it.

THE DECISION IS DELEGATED, NEVER RE-DERIVED HERE. {@link daemonExitCode} asks
`classifyFailure` — the repo's ONE failure classifier, which already reads rate-limit
backpressure, 5xx, transport faults and runner loss as `"transient"` — rather than carrying a
fourth copy of those signatures. So a reworded provider message is a one-place fix, and this
code can never disagree with the classifier the retry path already trusts.

FAIL-CLOSED IN THE SAFE DIRECTION: anything the classifier does not positively call transient
stays `error` ⇒ 1 and is counted, so this can only ever NARROW what counts as a crash.
```

## daemonExitCode

Removed from `src/lib/daemon.ts` lines 292-344 at the base commit.

```text
The pure stop-reason → process-exit-code mapping (operator ruling,
2026-07-21: "VERIFY from source how DaemonStopReason reaches the process
exit today... the deliverable is the pure stop-reason-to-exit-code
mapping"). Extracted so it is unit-testable with NO process spawn (Rule
18): `rmd daemon`'s CLI wiring (run-task.ts) calls this instead of inlining
the ternary, so the mapping a supervisor's restart decision depends on
lives in one place, provable without launchd.

`stopped`/`max_reached` are the only exits meaning "this was deliberate,
nothing to see" ⇒ 0. Every other reason — `blocked`, `error`, and `stale`
(W1-T126) — is nonzero so a supervisor (or launchd's KeepAlive, W1-T12b)
restarts. `stale` WANTS exactly that restart (it is how a long-running
daemon gets off a stale boot sha and onto code merged since — see
`DaemonStopReason`'s doc), unlike `blocked`/`error`, which merely tolerate
it. This is exactly why neither headroom exhaustion NOR pause can be
allowed to reach this function as a `DaemonStopReason` at all (see that
type's doc, above): each would either wrongly map to 0 (silence —
permanently dead until a manual reload) or wrongly map to 1 (a relaunch
storm — ~86s for headroom, ~10s for the 2026-07-22 paused storm) — both
wrong, because an awaiting-state is neither a clean stop nor a crash. Both
are handled entirely inside the loop below instead, and never become
return values.

── W1-T490: `stale` NOW CARRIES ITS OWN CODE, BECAUSE THE CALLER THAT NEEDS TO
TELL IT APART CANNOT SEE ANYTHING ELSE ──────────────────────────────────────

The mapping above collapsed FIVE reasons onto two codes, so `blocked`, `error`
and `stale` were indistinguishable at the process boundary. That is fine for
launchd — `KeepAlive{SuccessfulExit:false}` restarts on any nonzero and wants
to — but it is NOT fine for the container, where the restart budget is finite:
docker's `--restart=on-failure:N` counts every nonzero exit against N and
MEASURED (Azure, 2026-08-14, docker 29.1.3) cannot read the value at all —
`exit 1` and `exit 42` both parked at `RestartCount=2` on `on-failure:2`,
while `exit 0` did not restart. So a routine freshness restart — one per merge,
14 in 24 hours — spent the same budget as a crash, and no amount of healthy
running refunded it (three containers exiting after 0s, 20s and 120s of clean
work all parked permanently). The measured consequence was a 2h56m outage that
only a human ended.

SINCE DOCKER CANNOT READ THE CODE, THE ENTRYPOINT READS IT INSTEAD. This
function's job is only to make the two cases DISTINGUISHABLE; the accounting
is `deploy/entrypoint.sh`'s (see its freshness-restart block, which re-runs the
bootstrap so the staleness actually clears, and still exits for a real crash so
`on-failure:N` keeps bounding a crash loop). {@link DAEMON_EXIT_STALE} is the
one name both halves share.

NOTHING ELSE CHANGES POLARITY. `stale` stays NONZERO, so launchd's KeepAlive and
a bare `--restart=on-failure` with no entrypoint support both still restart
exactly as they did — this is strictly a refinement WITHIN nonzero, not a move
across the zero boundary. `blocked` and `error` keep 1 precisely so that a
crash remains countable.
```

## daemonExitCodeForSummary

Removed from `src/lib/daemon.ts` lines 355-377 at the base commit.

```text
W1-T2546 — the exit code for a WHOLE SUMMARY, which is what the real `rmd daemon` call site
has and what {@link daemonExitCode} above deliberately cannot see: the stop DETAIL.

A SECOND FUNCTION RATHER THAN A SECOND PARAMETER, on purpose. `daemonExitCode` is the pure
reason -> code map and has callers that pass it point-free (`reasons.map(daemonExitCode)`);
widening its signature would silently hand those callers an array index as a stop detail. Every
non-`error` reason is delegated to it unchanged, so the two can never disagree about the three
codes it already owns.

WHAT THE DETAIL IS, AND WHY IT IS TEXT. `runDaemon` builds it as `${taskId}: ${message}` from
a fatal error it has ALREADY stringified (`String((err as Error)?.message ?? err)`), so by the
time any exit code is computed there is no status object, no headers and no endpoint left to
read — the text is genuinely all there is. Rather than hand-roll a fourth copy of the rate-limit
signatures, this asks {@link classifyFailure}, the repo's ONE failure classifier, which already
reads rate-limit backpressure, 5xx, transport faults and runner loss as `"transient"`. So the
decision here can never disagree with the classifier the retry path already trusts, a reworded
provider message is a one-place fix, and this is not a rate-limit special case: any refusal that
classifier already calls environmental gets the same treatment.

FAIL-CLOSED: a summary with no detail, or one the classifier does not POSITIVELY call transient,
stays `error` -> 1 and is counted. This can only ever narrow what counts as a crash.
```

## buildDefaultHeadroomPolicy

Removed from `src/lib/daemon.ts` lines 401-421 at the base commit.

```text
DEFAULT policy (operator ruling, 2026-07-21, the fixture: on Monday
2026-07-20 the fleet parked 22:22–00:00 EDT, 56 consecutive
`headroom_exhausted` stops over ~98 minutes, protecting 95%-exhausted
headroom that EXPIRED at the midnight reset regardless): inside the
window's FINAL DAY (<=24h to reset) the ceiling relaxes to 100% — nothing
is gained by refusing to spend headroom that is destroyed unused at reset;
every other day it holds at `holdLimitPct` (the operator reserve, default
{@link HEADROOM_LIMIT_PCT}). A caller supplies a wholly different curve via
`DaemonOpts.headroomPolicy` without touching this source (see
`resolveHeadroomLimitPct`).

W1-T253 (P37 CONSUMERS): this curve mirrors `plan/policy.yaml`'s `headroom.curve` (which
this task's substrate, W1-T252, lifted FROM here) but stays a literal IN THIS FUNCTION —
see {@link DEFAULT_POLL_INTERVAL_MS}'s doc, immediately above, for why: this module never
touches the filesystem, and `loadDefaultPolicy` does. `daemonCommand` (run-task.ts) is the
real `rmd daemon` entry point; it loads the policy's curve and threads it in as
`DaemonOpts.headroomPolicy` on every real invocation, so a policy edit to the curve moves
the LIVE daemon with zero code change even though this literal stays put as the fs-free
fallback for a direct/test caller.
```

## resolveHeadroomLimitPct

Removed from `src/lib/daemon.ts` lines 429-436 at the base commit.

```text
Resolve the ceiling that binds for a window `hoursToReset` away, under
`policy` (default {@link buildDefaultHeadroomPolicy}'s curve). `null`/
non-finite hours-to-reset (the reset text didn't parse, see
`parseResetInstant`) resolves to the LAST (widest) rung — uncertainty is
NEVER read as "we must be in the final day"; the ceiling only ever relaxes
on a CONFIRMED close reset, never on a parse failure.
```

## resolveHeadroomLimitPct (the past-dated guard)

Removed from `src/lib/daemon.ts` lines 438-462 at the base commit.

```text
A reset already in the PAST is UPSTREAM LAG, not "the reset is imminent" — and a negative
`hoursToReset` would satisfy `<= 24` and select the LAXER rung. This clause makes that
impossible.

HONEST SCOPE, because the comment that used to justify a number in this subsystem was itself
wrong and that is how the wrong number persisted: THIS IS HARDENING, NOT A LIVE BUG FIX. The
sole production caller (below, ~line 348) derives `hoursToReset` from
`parseResetInstant(w.resetsAt, now)` with the SAME `now`, and that function's contract is "the
nearest instant AT OR AFTER now" — every branch rolls forward (next-day wall-clock / +1 year).
Probed across 20 shapes spanning both sides of `now`, it never returned a past instant, so
today this branch is unreachable and the change is behaviour-neutral.

recon-FH reported 36 of 2368 `daemon.headroom` lines carrying a `resets_at` behind their own
`ts` and inferred the ceiling had been relaxed. That inference was WRONG: those lines are a
DISPLAY artifact — `resetsAtDisplay` is computed at `now` and written to a line stamped later —
and the ceiling never received a negative number.

It is kept because the guarantee lives in a DIFFERENT function. Any future caller that computes
`hoursToReset` from a cached instant, or any relaxation of the roll-forward, would silently
reach the lax rung at the spending boundary. Past-dated and unknown-shaped are the same
epistemic state — we do not know when the reset is — so they take the same strict fallback.

The +1-year roll in `parseResetInstant` is DELIBERATELY untouched: confusing to a reader, but it
selects the STRICTER rung, and fixing it properly needs a notion of window cadence this
function does not have.
```

## UNRECOGNISED_RESET_MAX_LEN

Removed from `src/lib/daemon.ts` lines 479-501 at the base commit.

```text
Best-effort parse of a free-form `/usage` `resets_at` string into an
absolute instant, resolved as the nearest instant AT OR AFTER `now` (a
window's `/usage`-reported reset is never already in the past). Returns
`null` when the text doesn't match a recognized `/usage` shape — callers
MUST treat `null` conservatively (never as "confirmed close"), never throw:
this is display/policy plumbing, not a fail-closed boundary in its own
right (the numeric percent check stays the real safety gate).

Recognized shapes — every one actually observed from `/usage` (this task's
rationale + test/headroom.test.ts's WS0 fixture):
  `"<Mon> <D>, <H>(:<MM>)?(am|pm)"`     e.g. "Jul 14, 8:00pm"
  `"<Mon> <D> at <H>(:<MM>)?(am|pm)"`   e.g. "Jul 21 at 12am"
  `"<H>(:<MM>)?(am|pm)"`                e.g. "3pm"
  `"<weekday name or abbrev>"`          e.g. "Mon", "Monday"
  `"<ISO-8601 with offset>"`            e.g. "2026-08-13T03:19:59.748109+00:00"
The upstream started emitting the ISO form on 2026-08-12 (W1-T482's rationale) IN ADDITION TO,
never instead of, the human forms above — this branch is additive: every human shape that
matched before still matches, exactly as it did, because none of those regexes accept a `T`
date-time separator or a numeric-offset/`Z` suffix.

Ledger lines are read by humans and by rotation; a pathological upstream string must not be
 able to write an unbounded one. 200 chars is far longer than any observed reset clause. */
```

## priorUnrecognisedResetStrings

Removed from `src/lib/daemon.ts` lines 504-517 at the base commit.

```text
Every WINDOW a previous process already announced an unrecognised reset for — the
ledger-derived seed for {@link DaemonDeps.priorUnrecognisedResets}. Mirrors
`priorEscalatedAlertIds` / `priorReconciledAlertFeedbackIds` exactly: the step this reads is the
step the loop writes, so the ledger is the store and no new state file exists. Exported for the
caller that owns the ledger read (run-task.ts) — daemon.ts itself never touches the filesystem.

Keyed on `window`, NOT `raw` (W1-T482): the emitter used to dedupe on the whole raw string, which
a microsecond-precision ISO reset defeats outright — every tick produces a string no previous
tick produced, so the bound never actually bound anything (measured: 56-for-56 and 335-for-335
fired, zero suppressed, on two independent ledgers). `window` is a small, fixed set (`session
(5h)` plus one `weekly (<label>)` per model) so it bounds the SAME way the old key was documented
to, but actually holds under a raw value that drifts every tick.
```

## canonicalizeResetInstant

Removed from `src/lib/daemon.ts` lines 587-594 at the base commit.

```text
Round an instant to the nearest hour. `/usage` has been observed to phrase
the SAME intended reset moment two different ways a minute apart across
consecutive boots ("Jul 21 at 12am" vs "Jul 20 at 11:59pm" — this task's
SECOND, smaller defect) — sub-hour jitter like that has no operational
meaning for a 5-hour session window or a weekly cap, so rounding it away
is what makes {@link formatResetInstant} render the two identically.
```

## resolveHeadroomWindows

Removed from `src/lib/daemon.ts` lines 621-631 at the base commit.

```text
The daemon's OWN per-window headroom resolution — deliberately NOT `headroom.ts`'s
exported `headroomExhausted` (still used unchanged by `rmd drain`, which stays on
the flat `HEADROOM_LIMIT_PCT` ceiling; a human-invoked bounded drain is not this
task's concern and touching it is out of scope). Applies the TIME-AWARE ceiling
(see {@link HeadroomPolicy}) PER WINDOW — each window's own hours-to-reset resolves
ITS OWN limit, since the 5-hour session window and a weekly cap reset on entirely
different clocks — and returns every window MOST-BURNED FIRST. The caller reads
`[0]` for the burn telemetry line and `.find(w => w.percentUsed >= w.limitPct)` for
the enforcement decision (the governor ON path), so both share ONE resolution.
```

## instant

Removed from `src/lib/daemon.ts` lines 654-662 at the base commit.

```text
THREE STATES, not two, and the ceiling treats the last two identically ON PURPOSE:
  (a) reset present and parseable  -> a real hoursToReset; the time-aware curve applies.
  (b) reset present but unparseable -> null (parseResetInstant's own contract).
  (c) reset ABSENT entirely         -> null, WITHOUT calling parseResetInstant at all.
`resolveHeadroomLimitPct(null, …)` returns the LAST (WIDEST) rung — the strict 95%
reserve — never the relaxed 100% final-day rung. Its own doc: "uncertainty is NEVER read
as 'we must be in the final day'; the ceiling only ever relaxes on a CONFIRMED close
reset." So a window whose reset we do not know is held to the STRICTER ceiling, which is
the fail-closed direction at the spending boundary. Absent is explicit here, not accidental.
```

## DEFAULT_UNREADABLE_DEGRADED_LIMIT

Removed from `src/lib/daemon.ts` lines 684-700 at the base commit.

```text
Default: escalate to the SAME in-process idle heartbeat as a confirmed
headroom breach after this many CONSECUTIVE unreadable `/usage` reads. A
single blip (or a handful) is a transient read failure, not evidence the
budget is exhausted — but an unreadable budget that dispatches FOREVER is
the fail-open polarity at the spending layer (the #157/#143-adjacent
cannot-observe-rendered-as-permissive family: the gateway returning `[]`,
W1-T181; the projection regressing to `queued`, W1-T179). Recon R-7 found
the real read is unavailable ~78% of the time in the live ledger, so an
unconditional fail-closed-on-first-miss would halt the fleet most of the
time — hence a BOUNDED allowance, not an immediate halt.

W1-T290: this literal now RESOLVES TO, rather than merely matches, {@link
UNREADABLE_DEGRADED_LIMIT} (headroom.ts) — the drain's identical bounded-degraded
ceiling reads that SAME export, so the two consumers cannot drift apart the way two
independent `= 3` literals could. This name and this module's own default/override
option (`DaemonOpts.unreadableDegradedLimit`) are UNCHANGED — only where the number
comes from moved. */
```

## evaluateHeadroomPark

Removed from `src/lib/daemon.ts` lines 722-736 at the base commit.

```text
The park WITH a ceiling — the counterpart of {@link evaluateIdleGate}, same shape on purpose.

THE DEFECT IT CLOSES: the degraded branch had no ceiling, no escalation and no exit of its
own. Its only way out was a probe that RECOVERS, so a probe that cannot recover parks the
fleet permanently about four minutes after boot — alive, ticking (`ticks++` happens inside the
park), fresh boot sha, every liveness indicator healthy. That is not hypothetical: a real
`.claude` DIRECTORY occupying the worker-home symlink slot made the usage probe fail 33 times
out of 33, and re-materialisation never healed it.

`parkedSinceMs === undefined` reads as a FRESH park (`waitedMs = 0`), which alone can never
reach the ceiling — so a caller that does not track the clock degrades to exactly the old
unbounded park, never into a surprise forced dispatch. Same fail-direction discipline
{@link evaluateIdleGate} documents for its own optional persistence.
```

## headroomEnabled

Removed from `src/lib/daemon.ts` lines 757-769 at the base commit.

```text
The headroom governor switch (operator ruling fb-1784894405468-a4153e). When
false, headroom is still READ and LEDGERED every cycle (a `daemon.headroom`
telemetry line, `enforced: false`) but NEVER gates dispatch — no `percent_used`
condition idles the loop, and an unreadable read is absent telemetry, never a
hold. When true, the existing time-aware curve enforces unchanged (idle while
over, bounded degraded-mode on unreadable). Defaults to **true** here so the
library's long-standing behaviour and its tests are unchanged; the live
`rmd daemon` entry resolves the host posture from config/env via
{@link resolveHeadroomEnabled} — which, since the 2026-07-25 ruling, also
defaults **true**, so an unconfigured install and this library now agree — and
passes it explicitly. This host opts OUT via config `headroom.enabled: false`.
```

## headroomLimitPct

Removed from `src/lib/daemon.ts` lines 771-778 at the base commit.

```text
≥ this % on any window, on a day the ceiling HOLDS ⇒ in-process idle
(default {@link HEADROOM_LIMIT_PCT}). Ignored when `headroomPolicy` is
also supplied — that curve wins outright. Threading this through still
builds a full {@link HeadroomPolicy} via {@link buildDefaultHeadroomPolicy}
(relax on the final day, hold at this value otherwise) rather than a flat
ceiling — see the TIME-AWARE design above.
```

## maxApiWindowHoldMs

Removed from `src/lib/daemon.ts` lines 806-813 at the base commit.

```text
W1-T2517: the cross-task API-window-hold ceiling in ms (default
{@link DEFAULT_MAX_API_WINDOW_HOLD_MS}) — the SAME doubling-capped shape
`maxSpawnInfraBackoffMs` uses just above, for a different signal: consecutive
`blocked_transient` verdicts across DIFFERENT task ids (see
{@link reasonAboutApiWindow}'s own doc for why task identity is the discriminator).
POLICY DATA (rule 2), retunable without a source change.
```

## DaemonOpts.laneCount

Removed from `src/lib/daemon.ts` lines 815-832 at the base commit.

```text
W1-T343 (ADOPT DRAIN'S EXISTING LANE MACHINERY, NEVER A SECOND IMPLEMENTATION): the
width this tick's dispatch batch may hold — `SweepPolicy.dispatchLanes` (POLICY DATA,
rule 2; ONE threshold home, the same row `rmd drain` already reads), resolved by the
real command and threaded straight through, never re-derived here.

SHIP DARK. Default 1 (also the floor — a value below 1 is clamped up to 1, never down
to 0). At 1 (or omitted), the tick below computes a dispatch set of AT MOST one task via
`runnableCandidates(plan, isMerged, 1, …)`, which returns the SAME task {@link
nextRunnable} would — see that function's own doc: both apply the identical
`isDispatchEligible` chain, in the identical `dispatchOrder` walk, stopping at the same
point — and a one-or-zero-element candidate list can never collide with itself under
`partitionByFileOverlap` (nothing is yet placed to overlap against). So this tick's
OBSERVABLE behaviour — which task dispatches, which callbacks fire, which ledger lines
are written — is BYTE-IDENTICAL to before this parameter existed. That equivalence is
the safety property that lets this merge before an operator has decided to run two; W1-
T344 owns raising the policy row that actually flips it.
```

## wipLimit

Removed from `src/lib/daemon.ts` lines 834-846 at the base commit.

```text
`SweepPolicy.wipLimit` (W1-T121) — threaded through ONLY to SIZE a `laneCount >= 2`
batch, via {@link laneDispatchBudget} (drain.ts), exactly as `runDrainLanes` already
does. Distinct from `DaemonDeps.checkQueueGovernor` above: that gate STOPS new dispatch
outright for the whole tick when at/over the ceiling (unchanged by this field); this is
the finer-grained "how many of `laneCount` lanes still fit under it right now" input —
without it a >=2-lane batch could admit more concurrent dispatches than the remaining
WIP headroom, overshooting the ceiling by up to `laneCount - 1` before the NEXT tick's
`checkQueueGovernor` catches it. Never consulted when `laneCount <= 1` (or
`deps.openPrCount` is omitted) — the single-lane tick's budget is `1`, unconditionally,
which is exactly what preserves the byte-identical property `laneCount`'s own doc above
states.
```

## sweepWallClockBoundMs

Removed from `src/lib/daemon.ts` lines 848-858 at the base commit.

```text
W1-T1044 — the WALL-CLOCK BOUND (ms) on `await deps.sweep()`, below (default {@link
DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS}). POLICY DATA (rule 2): the real `rmd daemon` entry
threads `policy.values.sweepWallClockBoundMs` (src/lib/policy.ts) here, never a literal
at the call site. A sweep still in flight once this many REAL ms (a `setTimeout`,
independent of the injected `deps.sleep` cadence the in-flight ticker already owns — see
the call site's own comment for why a second consumer of that clock is avoided) have
elapsed is ABANDONED — the tick logs `daemon.sweep.abandoned` and returns control to the
loop rather than awaiting it forever (this repo's own measured incident: a fix-rung
worker's `until` shell loop with no exit condition parked the daemon up to 165 minutes).
```

## sweepRetriggerIntervalMs

Removed from `src/lib/daemon.ts` lines 860-870 at the base commit.

```text
W1-T1272 — the MINIMUM GAP (ms, default {@link DEFAULT_SWEEP_RETRIGGER_INTERVAL_MS}) between
two full-sweep RETRIGGERS fired while a "dispatch"/"retro" in-flight ticker holds the loop
(see {@link startInFlightTicker}'s own doc). Distinct from `sweepWallClockBoundMs` above,
which bounds how long any ONE sweep call is allowed to run — this bounds how OFTEN a new one
is allowed to start. Never consulted by the once-per-iteration call at the top of the loop,
which is unconditional whenever `deps.sweep` is supplied, exactly as before this field
existed. POLICY DATA (rule 2) in intent, though not yet threaded from `plan/policy.yaml` —
a direct/test caller (and the real `rmd daemon` entry, until a follow-up wires the policy
row) gets the default.
```

## DaemonFreshness

Removed from `src/lib/daemon.ts` lines 874-888 at the base commit.

```text
W1-T126 (DAEMON SELF-FRESHNESS): the result of comparing THIS process's own boot sha
against origin/main. `stale` carries the sha pair so the caller — and the ledger line
this drives, `daemon_selfrestart_for_freshness` — names exactly what advanced, the same
way `checkServiceFreshness`'s `behind` field does in self-sync.ts (the shared PREDICATE
this sibling check reuses rather than duplicating; see `DaemonDeps.checkFreshness`).

`installNeeded` (W1-T151, INSTALL FRESHNESS) is OPTIONAL — omitted/false behaves exactly
as before this field existed. `true` means the pull that produced `newSha` also changed
`package.json`/`package-lock.json` (or added a `workspaces` layout) relative to `oldSha`,
so `DaemonDeps.runInstall` runs BEFORE this loop stops for restart — never after — the
same install-then-restart ordering `serviceFreshnessGate`/`ensureInstallFresh` (run-task.ts)
apply at the operator's `rmd daemon`/`rmd serve` entry, so a stale `node_modules` never
survives into the freshly-restarted process either.
```

## StarvationCensus

Removed from `src/lib/daemon.ts` lines 893-911 at the base commit.

```text
QUEUE STARVATION census (recon oper#queue-starvation-2026-08-03): the RECOVERABLE-class
subset of an idle tick's dispatch-filter tally — the classes that could clear on their own
(a human resolves the block, a dependency merges, a fresh owned PR appears) without the
plan itself ever changing, as opposed to `already-merged` (the plan is DONE) or
`verify-not-auto` (permanently needs a human, waiting never helps). `circuitBroken` is
reported separately from `blocked`/`unmetDeps` because `isDispatchEligible` ledgers it
through its own `onCircuitBreak` callback rather than `tallyDispatchFilters`'s
`DispatchFilterReason` union — see drain.ts's doc on that split.

`retired` (W1-T2474) is carried here TOO, but is deliberately EXCLUDED from `blocked` and
from the `starved` verdict below: a `retired` task is a deliberate record that will never be
built (drain.ts's `"retired"` `DispatchFilterReason` split), the same "waiting never helps"
shape as `verify-not-auto`, not the dependency-stalled shape `blocked`/`unmetDeps`/
`circuitBroken` share. A queue whose only remaining blockers are retired is NOT starved —
nothing a human does clears it. Kept on the census (rather than dropped entirely) so the
count stays legible to a reader who wants to see it named, not silently absorbed into
`blocked` or vanished.
```

## StarvationClearedInfo

Removed from `src/lib/daemon.ts` lines 919-926 at the base commit.

```text
The CLEARED half of the starvation episode (this task): which of the two sites in `runDaemon`
below ended the episode, so `onStarvationCleared`'s wiring can close the escalation it opened
with a comment that says WHY rather than a bare "resolved". The two sites end an episode for
different reasons — see the comments at each site — and only one of them has a task to name:
a `dispatchable-task` clear has one (the task that just became eligible); a
`no-recoverable-blockers` clear does not (nothing dispatched — the blockers themselves cleared).
```

## decideAlertPoll

Removed from `src/lib/daemon.ts` lines 950-969 at the base commit.

```text
Injectable dependencies — the real command wires GitHub/run-task/usage/locks. */

W1-T462: should the daemon poll security alerts on THIS tick?

THE GAP WAS CADENCE, NOT CAPABILITY. `pollAlerts` (lib/ops.ts) already reads code-scanning,
Dependabot and secret-scanning alerts, folds open counts into the digest and escalates each NEW
critical/high exactly once — but MEASURED across all three ledger forms, `ops.alerts_polled` had
TWO rows in the entire corpus, both in archives from 2026-07-21 and 2026-08-02, and nothing
scheduled `opsCommand` at all: no daemon hook, no workflow, no launchd unit. Ten OSV advisories
accumulated until a human asked. The signal was produced and delivered; only the reader was missing.

SHAPED AFTER {@link decideAutoTriage} RATHER THAN INVENTING A FOURTH CLOCK — same marker-plus-
interval form, same idle gate, same fail-closed-on-corrupt-marker rule. This repo keeps re-filing
"a fourth spelling of how long since last time"; reusing the established shape is the point.

THE IDLE GATE IS NOT DECORATION. `decideAutoTriage` checks it for a reason: a poll shells three
`gh api` endpoints, and a dispatch tick is where the REST budget is already under pressure. It is
cheap (3 requests against a 5,000/hour budget measured at 4,834 remaining) but "cheap" is not
"free at the worst possible moment".
```

## reloadPlan

Removed from `src/lib/daemon.ts` lines 1001-1010 at the base commit.

```text
impl-FZ — re-read the plan from the SAME source the boot used, returning the fresh plan or
`null` when nothing changed. Optional: omitted ⇒ the plan stays frozen at boot, which is
exactly the pre-existing behaviour, so no existing caller changes.

The dep owns CHANGE DETECTION because the cheap signal is caller-specific: the real wiring
compares `git rev-parse origin/main:plan` (a tree sha, ~8ms) and only pays the ~60ms
`loadPlan` parse when that sha actually moved. Returning `null` on the unchanged path is what
keeps a 60-second poll from re-parsing a ~1MB monolith plus 45 shards for nothing.
```

## targetRepo

Removed from `src/lib/daemon.ts` lines 1029-1037 at the base commit.

```text
W1-T988 — the repo this daemon targets (`DaemonTarget.repo`, already resolved and already
ledgered as `daemon.target`'s own `repo:` field). Forwarded verbatim into the tick's
`NextRunnableOpts` so `isDispatchEligible` can refuse a task belonging to another repo.

OPTIONAL: omitted, the repo guard does not fire and every existing caller — including every
test that builds deps by hand — is byte-identical. A guard that defaults to refusing is the
shape that stops the fleet.
```

## openSiblingBuildFor

Removed from `src/lib/daemon.ts` lines 1039-1050 at the base commit.

```text
W1-T2397 — the open-sibling OBSERVATION's two halves, forwarded verbatim into this tick's
{@link NextRunnableOpts}; see those fields' own docs in drain.ts for the contract, and
run-task.ts's `openSiblingObservation` for the one factory both lanes build them from.

THIS IS THE LANE THAT DISPATCHES. Measured over the container's ledger union: `daemon.boot`
347 and `run.start` 558 against `drain.start` 16 — and the instance that motivated the task
(W1-T2387 dispatched while #3102 was open, producing #3109) came through here, not the drain.

NOT `isOpenPr`, and never to be folded into it: that would be the refusal W1-T2397 measured
and declined. Omitted ⇒ no observation, and dispatch is byte-identical to before they existed.
```

## isCircuitTripped

Removed from `src/lib/daemon.ts` lines 1061-1068 at the base commit.

```text
The per-task dispatch CIRCUIT BREAKER (MASTER-PLAN P29(ii)): true when a
task has been dispatched the policy-capped number of times with no new
owned PR since (status.ts's `isDispatchBreakerTripped`, re-derived from the
ledger each call — persists across daemon restarts, unlike this loop's own
in-memory `next.status = "blocked"` flip below). Optional — omitted,
dispatch behaves exactly as before this breaker existed.
```

## observedByTask

Removed from `src/lib/daemon.ts` lines 1078-1087 at the base commit.

```text
W1-T2286 — the same {@link ObservedScopeByTask} `DrainDeps.observedByTask` takes, for the
daemon's own dispatch path (W1-T343 reuses `runnableCandidates`/`partitionByFileOverlap`
rather than re-deriving them, and this dependency follows that reuse). Threaded to BOTH the
pack step (`dispatchOpts.observedByTask` below) and `partitionByFileOverlap`'s own direct
call in the dispatch-set branch below, so the two never disagree about a candidate's
effective scope — see `DrainDeps.observedByTask`'s own doc for the full contract. Optional —
omitted, both call sites fall back to `NO_OBSERVED_SCOPE` and dispatch is byte-identical to
before this dependency existed; no production caller supplies one yet.
```

## breakerDetail

Removed from `src/lib/daemon.ts` lines 1089-1096 at the base commit.

```text
WHAT THE BREAKER SAW for a task, supplied by the SAME memoised evaluation the
`isCircuitTripped`/`isIndeterminate` predicates answered from (run-task.ts's
`breakerGateFor().detailFor`) — never a second call to the predicate. Spread onto the
`dispatch.circuit_broken` / `dispatch.indeterminate` rows so a refusal records the count,
the bound and WHICH of the three outcomes was reached, instead of only that it fired.
Optional: a caller that omits it logs exactly the bare rows it logged before.
```

## DaemonDeps.checkCostGovernor

Removed from `src/lib/daemon.ts` lines 1116-1142 at the base commit.

```text
W1-T317 (wiring `checkCostGovernor`, sweep.ts): THE DAILY COST CEILING, re-derived from the
ledger each call — same freshness contract as `isCircuitTripped`/`isLifetimeCapExceeded`
above. UNLIKE those, this is NOT task-specific — one answer per tick, never keyed by taskId
— so it is consulted directly in the loop below, alongside `readUsage`'s headroom block,
rather than threaded through `nextRunnable`'s per-task chain. A defined return means "defer
— do not open a new run this tick", carrying the observed day-cost/ceiling that produced it;
`undefined` means proceed normally. UNLIKE drain.ts's bounded pass (which stops outright on
a deferral), this daemon is PERSISTENT: a deferral is an in-process idle heartbeat, the same
shape headroom's own `enforcingIdle` branch already uses, so the loop resumes on its own once
the observed day-cost drops back under the ceiling (spend ages out of the window, or the UTC
calendar day rolls over). The real wiring (run-task.ts) also LEDGERS the deferral itself
(`logCostGovernorDeferral`) before returning, so this loop never needs `ledgerPath`/`runId`
to report it. Optional — omitted, dispatch behaves exactly as before this governor existed.
Never consulted from `deps.sweep`/`deps.sweepLight` — drainage of already-open PRs is a
separate code path this predicate is never wired into (see `checkCostGovernor`'s own doc:
"stranding in-flight work to save money is a worse failure than the spend itself").

W1-T342: consulted a SECOND time — immediately before the actual dispatch (`runOne` below),
not only here at the top of the tick — via `checkDispatchGovernors`, which wraps this call
(and `checkQueueGovernor`'s) in a try/catch: a throw is now treated as a deferral (`kind:
"unreadable"`), never left to propagate and crash the loop the way a bare call used to. See
`checkDispatchGovernors`'s own doc for why a SECOND, freshly-taken reading matters once a
batch can hold more than one lane (W1-T343): a reading taken before lane 1 was admitted
cannot see lane 1's own (still in-flight, not yet ledgered) spend, so lane 2 needs its own
call, never lane 1's cached verdict.
```

## reloadDailyCostCeilingUsd

Removed from `src/lib/daemon.ts` lines 1144-1161 at the base commit.

```text
W1-T331 (closing the gap W1-T330's policy row alone left open): re-reads the SAME
repoRoot-scoped `plan/policy.yaml` `sweep.dailyCostCeilingUsd` row `reloadPlan` (above) reads
for the plan, returning the LIVE figure. Mirrors `reloadPlan`'s EXACT placement/contract in
the loop below — called once, at the TOP of the tick, before any dispatch decision, so
everything else in this tick sees ONE consistent ceiling and a file changing mid-tick cannot
produce two different answers within the same tick (the same argument `reloadPlan`'s own doc
gives, reused rather than re-derived). Optional — omitted, `checkCostGovernor` is consulted
with `undefined` and resolves its own (frozen-at-import) default exactly as before this task.

A throw here is caught by the loop, never here, and — UNLIKE `reloadPlan`, whose failure
just keeps the plan the loop already has — the loop holds the LAST KNOWN-GOOD ceiling rather
than discarding it to `undefined`: this value flows straight into `checkCostGovernor` above,
and `undefined` there reads as "no override, fall back to the shipped default," which could
SILENTLY WIDEN an operator-tightened live ceiling back to the frozen default the moment one
read glitches (a transient `plan/policy.yaml` read failure must never look like permission to
spend more, mirroring `reloadPlan`'s "degrade to what we already had, never fail open").
```

## checkQueueGovernor

Removed from `src/lib/daemon.ts` lines 1163-1183 at the base commit.

```text
W1-T321 (wiring `checkQueueGovernor`, sweep.ts, the W1-T121 23-open-PR incident): THE WIP
CEILING, re-derived from the current open-PR count each call — same freshness contract as
`checkCostGovernor` immediately above. UNLIKE `isCircuitTripped`/`isLifetimeCapExceeded`, this
is NOT task-specific — one answer per tick — so it is consulted directly in the loop below,
alongside `checkCostGovernor`, rather than threaded through `nextRunnable`'s per-task chain. A
defined return means "defer — do not open a new run this tick", carrying the observed open
count/limit that produced it; `undefined` means proceed normally. UNLIKE drain.ts's bounded
pass (which stops outright on a deferral), this daemon is PERSISTENT: a deferral is an
in-process idle heartbeat, the same shape `checkCostGovernor`'s own branch just above already
uses, so the loop resumes on its own once the observed open count drops back under the limit
(a PR merges/closes elsewhere). The real wiring (run-task.ts) also LEDGERS the deferral itself
(`logQueueGovernorDeferral`) before returning, so this loop never needs `ledgerPath`/`runId` to
report it. Optional — omitted, dispatch behaves exactly as before this governor existed. Never
consulted from `deps.sweep`/`deps.sweepLight` — drainage of already-open PRs is a separate code
path this predicate is never wired into (see `checkQueueGovernor`'s own asymmetry note).

W1-T342: see `checkCostGovernor`'s own W1-T342 paragraph immediately above — this predicate
is wrapped by the SAME `checkDispatchGovernors` seam, consulted a second time immediately
before dispatch, and fails closed on a throw exactly the same way.
```

## openPrCount

Removed from `src/lib/daemon.ts` lines 1197-1204 at the base commit.

```text
W1-T343: `laneDispatchBudget`'s other input (alongside `DaemonOpts.wipLimit`) — the
SAME `openPrCount` closure the real wiring already builds for `checkQueueGovernor`
(run-task.ts), never a second GitHub read path. Consulted ONLY when `laneCount >= 2`,
to size that batch exactly as `runDrainLanes` (drain.ts) already does. Optional —
omitted, a >=2-lane batch is bounded by `laneCount` alone (unbounded by the governor),
the same "un-wired site behaves as before" contract every optional guard here carries.
```

## readUsage

Removed from `src/lib/daemon.ts` lines 1206-1213 at the base commit.

```text
Read current /usage; `undefined` ⇒ unavailable (headroom check is skipped). */

W1-T417-adjacent (SDK usage source): MAY return a promise. Widened rather than made
`async`, so every existing SYNCHRONOUS supplier — the CLI probe and all 60 test fakes —
keeps working byte-for-byte; `await` on a non-promise is a no-op. The daemon needs this
because the contract-supported SDK reading is a control request on a streaming session,
which is inherently async.
```

## priorUnrecognisedResets

Removed from `src/lib/daemon.ts` lines 1215-1222 at the base commit.

```text
WINDOWS already reported by a previous process, read back off the ledger by whoever builds
these deps (run-task.ts). THE LEDGER IS THE DEDUP — the same idiom `priorEscalatedAlertIds` and
`priorReconciledAlertFeedbackIds` already use: a step written once and read back as the key,
never a new state file. Seeding from it is what makes the once-per-window bound survive a
restart; without it a daemon that reboots hourly would re-announce the same window on every
boot. Keyed on `window`, not the raw string (W1-T482) — see {@link priorUnrecognisedResetStrings}.
```

## onHeadroomBreach

Removed from `src/lib/daemon.ts` lines 1224-1243 at the base commit.

```text
P34 clause (c), W1-T249: called when a window first crosses the operator
reserve (a CONFIRMED, readable breach — never on the unreadable/degraded
path, which has its own bounded-allowance handling above). Fires AT MOST
ONCE per breach episode — the SAME "dedup while the condition holds, reset
once it clears" discipline `onCircuitBreak`'s caller applies, so a
sustained breach does not open a fresh notification every poll — and
dispatch is ALREADY paused (the in-process idle heartbeat this same check
drives) by the time this fires, so the hook is a pure notification, never
a dispatch decision itself. The real command wires escalate.ts's
`escalate()` (HARD_STOP class — "spend beyond cap" is exactly this
clause's shape on a subscription) naming the offending window/percent/
reset, with its OWN cross-boot ledger dedup keyed on `resetsAt` (mirroring
`escalateCircuitBreak`'s durable dedup, since this in-process flag alone
resets to empty on every daemon restart). Wrapped in the caller's own
try/catch (same discipline as `onCircuitBreak`/`onSpawnInfraBlocked`) so a
failed notification costs one logged line, never the daemon's liveness.
Optional — omitted, the breach still pauses dispatch exactly as before
this hook existed, it just opens no issue.
```

## readGhQuota

Removed from `src/lib/daemon.ts` lines 1262-1271 at the base commit.

```text
W1-T372: `gh api rate_limit`'s REST/core and GraphQL buckets, read fresh each tick —
`undefined` per bucket (or the whole call returning `{}`) means unreadable, never rendered
as an exhaustion (the same fail-soft-never-fabricated contract `readUsage` above already
carries). Consulted on the SAME per-tick cadence as `readUsage`'s headroom block,
immediately after it in `runDaemon` below — never a second cadence, and this is the ONLY
daemon-tick read of either bucket, so no second `gh api rate_limit` call is ever made per
tick. Optional — omitted, the quota tick is skipped exactly as `readUsage` omitted skips
the headroom block.
```

## onQuotaExhausted

Removed from `src/lib/daemon.ts` lines 1273-1290 at the base commit.

```text
W1-T372: called AT MOST ONCE per bucket per exhaustion episode, on the tick a bucket's OWN
`remaining` first crosses from having budget to having none — never on a bare
`remaining === 0` VALUE check, which would re-fire on every tick for up to an hour until
the bucket resets (see `runDaemon`'s own per-bucket latch, mirroring `onHeadroomBreach`'s
`headroomReserveEscalated` discipline exactly, just keyed per bucket so a core exhaustion
and a GraphQL exhaustion in the same hour never suppress each other).

UNLIKE `onHeadroomBreach`, this hook never pauses or idles dispatch — W1-T372 OBSERVES and
SURFACES a quota exhaustion, it does not govern one; no `continue` is taken on its account.
The real command wires escalate.ts's `escalate()` naming the bucket, with its OWN
cross-boot ledger dedup keyed on (bucket, resetsAt) — mirroring `escalateHeadroomReserve`'s
durable dedup, since this in-process latch alone resets to empty on every daemon restart.
Wrapped in the caller's own try/catch (same discipline as `onHeadroomBreach`/
`onCircuitBreak`) so a failed notification costs one logged line, never the daemon's
liveness. Optional — omitted, the exhaustion is still visible via the `daemon.quota` line
logged every tick a read succeeds, it just opens no issue.
```

## readDiskHeadroom

Removed from `src/lib/daemon.ts` lines 1292-1305 at the base commit.

```text
W1-T1082 (THE DAEMON NEVER READS ITS OWN FREE SPACE): real free disk space for THIS tick,
pre-judged against the SAME thresholds `rmd doctor`'s own `judgeDiskHeadroom` reports
against (doctor.ts) — read and judged in the CLI wiring (run-task.ts), never here, because
this module stays fs-free AND threshold-free (the file header's "never touches the
filesystem", extended to "never re-derives a threshold `rmd doctor` already owns" — a daemon
that alarmed at a different number than `rmd doctor` reports would be a contradiction an
operator has to adjudicate mid-incident). `freeBytes` is `undefined` (never a fake `0`) on
any read failure — `readDiskFreeBytes`'s own fail-soft contract (daemon-health.ts) — and
`runDaemon` below treats an undefined `freeBytes` as UNREADABLE, never as zero-bytes-free:
it is still recorded on the `daemon.alive` row when present, but it never escalates (see
`onDiskHeadroomBreach` below). Optional — omitted, `daemon.alive` simply carries no
`disk_free_bytes`, exactly as before this dep existed.
```

## onDiskHeadroomBreach

Removed from `src/lib/daemon.ts` lines 1307-1324 at the base commit.

```text
Called AT MOST ONCE per continuous disk-headroom breach episode — the tick a reading FIRST
crosses below WARN (2 GiB) or FAIL (512 MiB), cleared the instant a LATER reading is back at
OK (mirrors `onHeadroomBreach`'s own `headroomReserveEscalated` latch exactly — see
`runDaemon`'s `diskHeadroomLatch`, below). Escalates at WARN, not only FAIL: by FAIL, the
issue body, this hook's own dedup marker and the ledger row it lives on are all writes that
may themselves lose to the same ENOSPC this hook exists to report ahead of — the exact shape
`escalateCrashLoop`'s doc names ("a detector whose input can only be recorded by a write
that ENOSPC rejects is structurally incapable of being the FIRST signal; it is the
autopsy"). Never called for an unreadable read (`readDiskHeadroom`'s `freeBytes` absent) —
an unreadable disk is not evidence of a full one. Wrapped in the caller's own try/catch
(same discipline as `onHeadroomBreach`/`onQuotaExhausted`) so a failed notification costs
one logged line, never the daemon's liveness. The real command wires run-task.ts's
`escalateDiskHeadroomBreach`, with its OWN cross-boot ledger dedup — this in-process latch
alone resets to empty on every daemon restart, and disk pressure can itself crash-loop the
daemon. Optional — omitted, the breach is still visible via `daemon.alive`'s own
`disk_free_bytes` field, it just opens no issue.
```

## onStarvation

Removed from `src/lib/daemon.ts` lines 1326-1340 at the base commit.

```text
QUEUE STARVATION (recon oper#queue-starvation-2026-08-03): called on an idle tick whose
dispatch-filter census names at least one RECOVERABLE-class blocker — see {@link
StarvationCensus} and the predicate right above where this fires in the idle rung. Fires
AT MOST ONCE per starvation episode (the SAME "dedup while the condition holds, reset once
a dispatchable task ends it" discipline `onHeadroomBreach`/`onCircuitBreak` already apply),
and dispatch is already idle by the time this fires, so the hook is a pure notification,
never a dispatch decision. The real command wires escalate.ts's `escalate()` (via
run-task.ts's `escalateStarvation`) naming the census, with its OWN cross-boot ledger dedup
(mirroring `escalateCircuitBreak`'s durable dedup, since this in-process bound alone resets
to empty on every daemon restart — see `daemon.ts`'s `starvationEscalated`). Wrapped in the
caller's own try/catch (same discipline as `onCircuitBreak`/`onHeadroomBreach`) so a failed
notification costs one logged line, never the daemon's liveness. Optional — omitted, the
daemon still idles exactly as before this hook existed, it just opens no issue.
```

## onStarvationCleared

Removed from `src/lib/daemon.ts` lines 1342-1362 at the base commit.

```text
The CLEARED half of the transition `onStarvation` above only ever opens (this task):
`onStarvation` has no counterpart, so the two sites below that reset `starvationEscalated`
re-arm an in-process boolean and tell nothing outside the process — the escalation issue
`onStarvation` opened stays open forever, even once a human (or a later dispatch) has made
the condition moot. Mirrors `onStarvation` EXACTLY, never a second mechanism: optional on
`DaemonDeps`, wrapped in the SAME try/catch whose comment already reads "a failed
notification costs one logged line, never the daemon's liveness", and fired from the SAME
two sites that already own the transition.

Fires ON THE EDGE, never per tick — guarded on the flag it is clearing (`starvationEscalated`),
so a daemon that was never escalated stays silent (nothing to clear) and a long quiet
stretch of already-unstarved ticks closes nothing repeatedly (the SAME "dedup while the
condition holds, once per episode" discipline `onStarvation` itself applies, just for the
opposite edge). `info.reason` names WHICH of the two sites ended the episode — the daemon
says so in its own comments at each site — and `info.taskId` names the task where there is
one, so the real command (run-task.ts's `escalateStarvationCleared`) can close the issue
`escalateStarvation` opened with a comment that says why, not a bare "resolved". Optional —
omitted, the daemon still re-arms exactly as before this hook existed, it just closes no
issue.
```

## DaemonDeps.checkFreshness

Removed from `src/lib/daemon.ts` lines 1378-1407 at the base commit.

```text
W1-T126 (DAEMON SELF-FRESHNESS, filed from #271 holding-note item 7 — five manual
pull-and-reload cycles in a single weekend, because every merged pipeline fix was
invisible to the already-running daemon until a human noticed and cycled it by
hand). An OPTIONAL check, consulted once per tick with the SAME "between iterations
only" discipline as `checkStop`/`checkPause` immediately above — so it can NEVER
interrupt a `runOne` already in flight; in-flight work always reaches its verdict +
merge first (the identical drain-and-hold guarantee those two rely on).

`{ stale: false }` ⇒ this process's own boot sha is caught up with origin/main, no
action. `{ stale: true, oldSha, newSha }` ⇒ origin/main has advanced past it: the
loop stops with {@link DaemonStopReason} `"stale"` — a deliberate NONZERO exit (see
that type's doc for why this is the opposite polarity from headroom/pause) so
launchd's `KeepAlive{SuccessfulExit:false}` relaunches into the fresh code — and
ledgers `daemon_selfrestart_for_freshness` (never a bare generic stop line), so an
intentional self-restart is provably distinguishable from a crash under the
identical "any exit relaunches" semantics (see the BOOT-RATE INVARIANT doc above —
a crash-loop reader keys off THIS marker, not the raw exit code, to tell the two
apart).

This module stays PURE (see the file header: never touches git or the filesystem)
— the real command wires this to self-sync.ts's shared `checkServiceFreshness`
PREDICATE (the W1-T79/W1-T255 sibling this design explicitly reuses rather than
duplicating) evaluated against the sha recorded at THIS process's own boot, and
performs the actual `git merge --ff-only origin/main` pull as part of producing a
`stale` read — by the time this loop acts on it, the working tree is already at
`newSha`, so the freshly-relaunched process boots straight into it. Optional:
omitted ⇒ the loop never self-restarts for staleness, behavior unchanged from
before this check existed.
```

## runInstall

Removed from `src/lib/daemon.ts` lines 1409-1419 at the base commit.

```text
W1-T151 (INSTALL FRESHNESS). Consulted ONLY when `checkFreshness()` reports
`{ stale: true, installNeeded: true }` — runs BEFORE the loop stops for restart
(never after), so the process launchd relaunches into `newSha` also inherits a
`node_modules` that actually matches it, closing the same staleness class
{@link ensureInstallFresh} (run-task.ts) closes at the operator's `rmd daemon`/
`rmd serve` entry. This module stays PURE — the real command wires this to
`ensureInstallFresh(repoRoot)`'s real `npm ci`. Optional: omitted (or
`installNeeded` false/absent) ⇒ never called, behavior unchanged from before
this hook existed.
```

## pendingKicks

Removed from `src/lib/daemon.ts` lines 1421-1428 at the base commit.

```text
CONSOLE WRITE-ACTIONS (fb-1784988460437-9daa9b). PEEK the pending "Run this
queued task now" kick markers, oldest-first — PURE injection, no fs here (the
real command wires `pendingKicks(root)` from fleet-control.ts). The daemon
gates each through {@link assertRunnable} + the merged projection and clears it
with {@link DaemonDeps.clearKick} as it dispatches or refuses it, so a runnable
kick it can't service this cycle survives to the next.
```

## now

Removed from `src/lib/daemon.ts` lines 1458-1466 at the base commit.

```text
THE INJECTED WALL CLOCK (distinct from `sleep`'s pacing clock): read once
per headroom check to resolve each window's hours-to-reset against the
TIME-AWARE ceiling (see `HeadroomPolicy`). Optional — the real command
wires `() => new Date()`; omitted, defaults the same way, so existing
callers are unaffected. Tests inject a fake that a `sleep` fake can
advance, so "resumes once the window's own reset passes" is provable
without a real wall-clock wait.
```

## sweep

Removed from `src/lib/daemon.ts` lines 1470-1478 at the base commit.

```text
The level-triggered PR-pipeline reconciler (W1-T77, ratifies P22 core): the
SAME `runSweep` entry point `rmd sweep` invokes, wired here so it runs once
per poll iteration — every open PR is re-derived to a disposition and its
gated action taken, deduped for idempotence. Optional: omitted ⇒ the loop
behaves exactly as before the reconciler existed. Best-effort by contract
(the real wiring swallows its own errors) so a sweep hiccup never halts the
scheduler. Called alongside dispatch, NOT a replacement for it.
```

## sweepOrphans

Removed from `src/lib/daemon.ts` lines 1486-1495 at the base commit.

```text
W1-T117 orphan sweep (design part ii): the SAME `sweepOrphanWorkers`
entry point (worker-containment.ts) `daemonBoot`'s own
`sweepOrphanWorkers` param below runs once at boot, wired here so it
ALSO runs once per poll iteration — a stray from a run that ended
between polls (rather than only at the last boot) is still found within
one cycle. Optional: omitted ⇒ the loop behaves exactly as before this
sweep existed. Best-effort by the same contract as `sweep` above (own
try/catch, logged, never halts the loop).
```

## sweepFeedbackLanding

Removed from `src/lib/daemon.ts` lines 1497-1509 at the base commit.

```text
W1-T530 FEEDBACK-LANDING SWEEP (ratifies P22, the same argument `sweepOrphans` above
already applies to strays): the SAME `sweepFeedbackLanding` entry point
(feedback-landing.ts) `daemonBoot`'s own `sweepFeedbackLanding` param below runs once at
boot, wired here so it ALSO runs once per poll iteration — an entry captured while landing
was unavailable (offline, no `gh`, `gh pr create` refused), or on a host that never
captures again, is otherwise stranded off `origin/main` forever because `landFeedback`'s
only caller is `captureFeedback`. Idempotent by contract (a pass over already-landed state
pushes nothing — see `LandFeedbackResult.pushed`), so riding the daemon's own poll cadence
is safe. Optional: omitted ⇒ the loop behaves exactly as before this sweep existed.
Best-effort by the same contract as `sweep`/`sweepOrphans` above (own try/catch, logged,
never halts the loop).
```

## checkGithubPosture

Removed from `src/lib/daemon.ts` lines 1511-1522 at the base commit.

```text
W1-T1040: THE GITHUB-SIDE POSTURE DRIFT CHECK — reads whether the repo's GitHub-side
security capabilities (`security_and_analysis`, `enforce_admins`) are on, once a day at
most (github-posture.ts's own cadence gate), and returns only the findings that changed
since the recorded baseline (or the first read if none is recorded) — `[]` on every other
tick, including an unreadable read (never a false all-clear). Best-effort by the SAME
contract as `sweep`/`sweepOrphans`/`sweepFeedbackLanding` above: a throw costs one logged
tick, never the daemon's life, and a non-empty return NEVER halts dispatch, fails a check,
or changes a verdict — it is a ledger row for the operator, nothing more (see
github-posture.ts's module header for why this is deliberately not an `escalate()` call).
Optional: omitted ⇒ the loop behaves exactly as before this check existed.
```

## checkMeasurementCadence

Removed from `src/lib/daemon.ts` lines 1524-1531 at the base commit.

```text
W1-T1259: THE MEASUREMENT-CADENCE RUNG — decides whether `rule-efficacy`,
`verdict-calibration` and `autonomy-rate` (lib/measurement-cadence.ts's `decideMeasurementCadence`)
run THIS tick. Paced by its OWN policy-data bound (`minIntervalMinutes` + `maxPerDay`,
`plan/policy.yaml`'s `measurementCadence` row), never the raw poll interval — the same
marker-plus-interval-plus-cap shape `checkAutoTriage` uses. Optional: omitted ⇒ the loop
behaves exactly as before this rung existed (the three verbs stay operator-run only).
```

## runMeasurementCadence

Removed from `src/lib/daemon.ts` lines 1533-1541 at the base commit.

```text
W1-T1259: run all three measurement verbs once, returning a cadence-shaped summary this
loop logs (never inside the producer itself — same split `runAutoTriage`'s own disposition
logging uses). DEFAULT-OFF WRITE PATH: the summary's `ruleEfficacy.escalated` is true only
when `policy.measurementCadence.escalate` was ALSO on — the default cadence runs every verb
report-only, zero writes, and NEVER files a task or mints an id (Law 5) — see
lib/measurement-cadence.ts's module doc. Best-effort like `sweep`/`checkAutoTriage` above: a
throw costs one logged tick, never the daemon's life.
```

## checkDigestCadence

Removed from `src/lib/daemon.ts` lines 1543-1551 at the base commit.

```text
W1-T2277: THE DIGEST'S OWN CADENCE RUNG — decides whether the digest (lib/digest.ts's
`runDigestCadenceReport`) fires THIS tick. Paced by its OWN policy-data bound
(`minIntervalMinutes` + `maxPerDay`, `plan/policy.yaml`'s `digestCadence` row — a SEPARATE
row from `measurementCadence`'s, on a SEPARATE marker file, so the two can never drag each
other), reusing the SAME `decideMeasurementCadence` pure function `checkMeasurementCadence`
above does. Optional: omitted ⇒ the loop behaves exactly as before this rung existed (the
digest stays reachable only by an operator typing `rmd digest`).
```

## DaemonDeps.checkBoardReview

Removed from `src/lib/daemon.ts` lines 1561-1581 at the base commit.

```text
W1-T2304's board-review rung, wired. THE RUNG WHOSE UNIT IS THE WHOLE OPEN BOARD — "is the
board itself healthy" — rather than one PR, which is every other rung's unit.

ITS OWN policy row and ITS OWN marker file (`state/last-board-review.json`), on the same
check/run pair shape as `checkMeasurementCadence` and `checkDigestCadence` above, for the
same reason: three cadences that shared one bound could not be tuned independently.

THIS PAIR IS THE WHOLE POINT OF THE WIRING TASK. #2952 merged 385 lines of correct, tested
board-review code on 2026-08-26 at 13:54:59Z and it never fired once — zero `board_review`
rows all-time against 89 `measurement_cadence`, and no `state/last-board-review.json` on disk
beside five sibling markers — because nothing ever called it. `buildBoardReview` sat behind
`opts.boardReview ? … : undefined` in `runMeasurementCadenceReport` and no caller passed the
key. That is PR #1066's lesson for the third time; the producer at `daemonCommand`'s call
site is what makes it real, not this declaration.

W1-T2464: also carries `retiredProposalIds` — this hook's OWN reconciliation pass, which runs
on every call regardless of `fire` (see `reconcileBoardReviewReferents`'s header doc, and
`buildBoardReviewDaemonHooks`'s `check` closure that wires it in). Optional so a fixture
built against the pre-W1-T2464 shape (bare `{fire, reason}`) still satisfies the type.
```

## checkRetroTrigger

Removed from `src/lib/daemon.ts` lines 1591-1601 at the base commit.

```text
W1-T160: evaluate the retro cadence trigger this tick — fires on
merges-since-marker >= N OR days-since-marker >= D (policy data),
whichever crosses first (retro.ts's `evaluateRetroTrigger`, the pure
predicate this wraps against the real marker/ledger/GitHub read). Returns
`undefined` when there is nothing safe to evaluate this tick (a corrupt
marker, a degraded GitHub read) or a decision with `fire: false` — both
mean "do not fire this tick"; the loop only acts on `fire: true`.
Optional: omitted ⇒ the loop behaves exactly as before this feature
existed (the retro stays operator-run only).
```

## runRetroTrigger

Removed from `src/lib/daemon.ts` lines 1603-1612 at the base commit.

```text
W1-T160: run the automated retro once `checkRetroTrigger` fires. The real
wiring (run-task.ts's `daemonCommand`) threads the fired decision's
`mergesSinceMarker` into `retroCommand`'s `opts.automated` so the
INTEGRITY GATE (retro.ts's `checkRetroIntegrity`) can compare it against
the real gather's credited count and abort loudly (never write) on a
mismatch. Best-effort like `sweep`/`sweepOrphans` above — a throw here
costs one logged tick, never the daemon's life. Never called unless
`checkRetroTrigger` fires.
```

## isFeedbackOpenPr

Removed from `src/lib/daemon.ts` lines 1626-1634 at the base commit.

```text
W1-T300 (the #1184/#1185 duplicate-triage race): the auto-triage rung's OWN in-flight guard,
symmetric with `isOpenPr` above but keyed on FEEDBACK id rather than task id — a feedback
entry's `status` only advances when its triage PR MERGES (a committed file under
plan/feedback/), so between dispatch and merge `newFeedbackIdsOldestFirst` keeps returning the
same head and a slow CI round re-fires the identical entry. Returns the OPEN PR number that
already carries this id's `origin: feedback#<id>` provenance, or `undefined` when none is
open. Optional — omitted, auto-triage dispatch behaves exactly as before this guard existed.
```

## DaemonDeps.sweepLight

Removed from `src/lib/daemon.ts` lines 1644-1665 at the base commit.

```text
W1-T254 (the #707 fix) — the RESTRICTED LIGHT-SWEEP TICKER: `runOne` is
UNBOUNDED (a task can hold the daemon inside one call for a whole
session), and `deps.sweep` above only runs BETWEEN iterations — so a PR
that goes green-but-review-absent after the last full sweep sat
invisible for runOne's entire remaining duration (#707: swept 13:12,
entered `runOne`, never swept the new head again for the whole window —
unbounded latency, total invisibility until a manual `rmd review`).
When supplied, this ticks on the SAME injected clock as idle polling
(`pollIntervalMs` cadence, via `deps.sleep`) WHILE `runOne` is in
flight, and is cleared once `runOne` settles (resolved or thrown) —
never left running past it, never aborted mid-call either (a call
already in flight when `runOne` settles is allowed to finish). The real
wiring passes the SAME `runSweep` entry point as `sweep`, but restricted
via `SweepDeps.actionable` to ONLY the deterministic, sha-pinned,
mutex-serialized post-review re-post — every other lane
(dispatchFix/close/escalate/depReview/arm) must stay strictly
single-threaded, so it never runs from here. Own try/catch, like `sweep`
above (`daemon.sweep_light.failed`) — a ticker hiccup costs one logged
tick, never the daemon's liveness. Optional: omitted ⇒ the loop behaves
exactly as before this ticker existed.
```

## escalateBlock

Removed from `src/lib/daemon.ts` lines 1667-1675 at the base commit.

```text
W1-T46 block-reasoning: called exactly once, when a block classifies
GENUINE BLOCKER (`reasonAboutBlock` in block-reason.ts — one or more
tasks transitively depend on the blocked task). The real command wires
escalate.ts's `escalate()` (BLOCKED class, W1-T8's GitHub-issue
taxonomy) naming the dependents; tests inject a fake collecting the call.
Optional — omitted, a genuine blocker still HALTS the loop (never
silently continues), it just has no issue opened.
```

## dispatchFix

Removed from `src/lib/daemon.ts` lines 1677-1688 at the base commit.

```text
W1-T174 (drain/sweep PARITY): called for a FIXABLE genuine blocker
(`reasonAboutBlock`'s `fixable_blocker` disposition — one or more
dependents, but the verdict names actionable evidence, see block-
reason.ts's `verdictIsFixable`) BEFORE any halt+escalate. The real
command wires this to the SAME W1-T76 fix rung the W1-T77 sweep already
dispatches (`routeFix`/`dispatchFix` in run-task.ts), driven against
the task's own open PR. Optional — omitted (or once `reasonAboutBlock`'s
own strike bound is exhausted), a fixable block falls through to the
SAME `escalateBlock` halt a genuine blocker always got: the daemon
never silently stalls on a fixable block it has no rung wired to act on.
```

## onSpawnInfraBlocked

Removed from `src/lib/daemon.ts` lines 1690-1702 at the base commit.

```text
W1-T113 part (iii), DEGRADE DON'T DIE (the vanished-binary incident): called
AT MOST ONCE per distinct `reason` for the life of this daemon run — never
once per poll tick, never once per task — when `runOne` throws a spawn-
INFRASTRUCTURE error (worker.ts's `ClaudeToolchainBlockedError`, detected
duck-typed via `reasonClass === "blocked_toolchain"`, never an
`instanceof` import — this module stays decoupled from worker.ts). The
real command wires escalate.ts's `tryEscalate` (BLOCKED class, content-
keyed by `reason` — the W1-T104 discipline: an already-open toolchain
issue for the SAME cause suppresses a repeat) naming every searched path.
Optional — omitted, the loop still survives and backs off, it just opens
no issue.
```

## isSpawnInfraBlocked

Removed from `src/lib/daemon.ts` lines 1706-1714 at the base commit.

```text
Duck-typed classifier for a spawn-INFRASTRUCTURE failure (W1-T113: worker.ts's
`ClaudeToolchainBlockedError`, the vanished-binary class) — checked by a plain
string tag rather than `instanceof` so this module never imports worker.ts as
a value (it stays a PURE module, per this file's header: no fs, no exec, and
now no runtime dependency on the spawn layer either). Any OTHER throw from
`runOne` is still a genuine, unclassified error — this daemon must not learn
to swallow every possible crash, only the one named infrastructure class.
```

## INTERPHASE_REVIEW_CLOCK_STOP_BOUND_MS

Removed from `src/lib/daemon.ts` lines 1719-1727 at the base commit.

```text
BACKSTOP (W1-T2852) — maximum time the inter-phase review clock's stop may wait for an idle
clock sleep to
notice that its phase ended. `DaemonDeps.sleepUntilSweepWake` is intentionally a promise-only
seam (no cancellation handle), so waiting on the whole poll interval would add up to 60 seconds
to every transition into dispatch or idle. The clock therefore subdivides only its IN-PROCESS
wait into one-second quanta while retaining `pollIntervalMs` as the cadence that may start a
timer-driven light pass. No GitHub read or sweep runs on the quantum itself.
```

## startInterphaseReviewClock

Removed from `src/lib/daemon.ts` lines 1736-1749 at the base commit.

```text
W1-T2852 — the review-only clock for the part of a daemon iteration that previously had none:
after the full-sweep await returns and before the iteration reaches an existing retro/dispatch
ticker or an idle wait. It owns only `deps.sweepLight`, whose production hook is already
restricted to sha-pinned post-review work; no fix, merge, close, escalation or dispatch action
is introduced here.

Event edges and timer recovery share the existing injected clock. A wake observed while a pass
is active remains pending inside the wake signal and makes the next wait resolve immediately,
which serializes one coalesced follow-up instead of overlapping passes. STOP/PAUSE are read at
the last possible point, immediately before admission. A held wake stays pending locally until
one later quantum observes the hold clear. `stop()` flips `active` before awaiting the runner,
so it starts nothing new and still lets an already-started pass settle.
```

## sweepLightDuringRetro

Removed from `src/lib/daemon.ts` lines 1803-1828 at the base commit.

```text
W1-T276: wraps a fired retro's `runRetroTrigger` call with the SAME
restricted light-sweep ticker `runOne` already uses (W1-T254, lines
~1441-1462 below) — a fired retro is a bare, unbounded await too, and
without a ticker of its own the whole sweep goes dark for the retro's
entire duration (MEASURED over the live ledger: 22.0 and 21.0 minutes
across the two firings to date, zero sweep dispositions in either
window — the daemon looked healthy throughout because it WAS healthy;
it was simply busy). Same clock (`deps.sleep` on `pollIntervalMs`), same
`stopTicker` discipline: cleared on every exit path (`run` resolves OR
throws, via `finally`), and a `sweepLight()` call already in flight when
`run` settles is allowed to finish rather than aborted. Only the
RESTRICTED light sweep (`deps.sweepLight`) is ticked here, never full
dispatch — the retro itself already spends a real, budget-costing
Architect run, and a ticker that dispatches would turn one concurrent
spend into two. A `sweepLight` throw is caught and ledgered
(`daemon.sweep_light.failed`), never propagated — a ticker hiccup costs
one logged tick, never the retro's own outcome.

W1-T1272: `sweepRetrigger`, when supplied, is forwarded straight to `startInFlightTicker` —
this wrapper is used for BOTH the retro trigger and auto-triage call sites, and either can
hold the loop for the same order of minutes a long dispatch does (rationale: 22.0/21.0-minute
retro firings, measured), so the same re-trigger eligibility applies. Only `sweepLight` is
still ticked unconditionally on every poll — the retrigger fires strictly less often, on its
own longer interval.
```

## startInFlightTicker

Removed from `src/lib/daemon.ts` lines 1845-1906 at the base commit.

```text
THE IN-FLIGHT TICKER — the one thing that runs while the daemon is blocked on
unbounded awaited work, and the ONLY writer of `daemon.alive`.

WHY IT EMITS A LIVENESS ROW AND NOT MERELY A SWEEP. Every other `daemon.`-prefixed
step is written when a tick CLOSES, so before this row existed "the daemon is alive"
and "the daemon finished something recently" were ONE signal, and a daemon inside a
long dispatch was byte-identical to a dead one. That is this repo's own
cannot-observe-is-not-a-no distinction arriving as BUSY versus DEAD. MEASURED over the
unioned ledger (live + all 666 gzipped rotations, 898 `daemon.iteration` rows): the
window from a dispatch to the next `daemon.`-prefixed row has p50 2.4m, p75 21.2m,
p90 39.5m, p95 52.5m. So 36.5% of all dispatches exceeded `fleet-heartbeat.sh`'s
600s staleness threshold and 15.9% exceeded the console's 30-minute
{@link DEFAULT_LIVENESS_BOUND_MS} — both reporting a working fleet as stale or dead.

WHY `daemon.`-PREFIXED, AND WHY THAT IS THE WHOLE FIX. Both liveness readers select on
the PREFIX, not on a step name: `deriveLastPoll` (daemon-health.ts) takes the max `ts`
over `step.startsWith("daemon.")`, and `scripts/fleet-heartbeat.sh` greps
`"step":"daemon\.`. One row therefore corrects the console, the `GET /v1/daemon-health`
route and the off-machine heartbeat SIMULTANEOUSLY, with no threshold moved and no
second liveness rule invented — the specific way this repo has previously ended up with
two surfaces documented to agree while quietly disagreeing.

IT CARRIES `poll_interval_ms` BECAUSE `deriveLastPoll` READS THAT FIELD OFF THE WINNING
LINE. Omitting it would make this row win the max and then silently drop the console's
interval back to the injected default.

IT IS LOGGED BEFORE `sweepLight()`, NOT AFTER, and that ordering is load-bearing: the
row asserts "this loop is running NOW", which does not depend on the sweep's outcome. A
sweep that HANGS therefore yields one last row and then silence, so a genuinely wedged
daemon still goes stale on schedule — logging after the sweep would let a hung sweep
suppress the very signal that should report it.

THE START CONDITION IS UNCHANGED FROM W1-T254/W1-T276 — no `sweepLight`, no ticker —
and that was MEASURED, not assumed. Starting it unconditionally (so liveness could not
depend on an unrelated optional hook) added a `deps.sleep` call to every dispatch, and
eight suites across four files count sleeps as their IDLE proxy: a ticker sleeping
inside a dispatch forges evidence that the daemon idled. The coupling is therefore
accepted and made explicit rather than hidden: `sweepLight` is wired unconditionally in
production (`buildSweepLightHook`, run-task.ts) and that wiring already has its own
guard — run-task.test.ts's "daemonCommand: builds the real daemon deps (sweep +
sweepLight wiring)". A caller that omits the hook is a test, and gets no heartbeat
because it is running no dispatch worth reporting on.

W1-T1082 (THE DAEMON NEVER READS ITS OWN FREE SPACE): this row is ALSO where real disk
headroom rides — "no new step, no new row", the same discipline `holdSeen` above was added
under. `deps.readDiskHeadroom` is consulted on this SAME cadence (never a second clock — the
whole point of reusing this ticker rather than inventing one) and `disk_free_bytes` is
carried on the row ONLY when the read actually succeeded: an unreadable read is absent from
the row, never a fabricated `0` (`readDiskFreeBytes`'s own contract). Escalation
(`onDiskHeadroomBreach`) fires at most once per continuous breach episode via
`diskHeadroomLatch`, a reference SHARED across every phase/call of this function within one
`runDaemon` run (see that variable's own doc) — never a fresh latch per call, which would
re-escalate every time a NEW phase's ticker happened to start while the SAME breach was still
open.

W1-T1272 (THE RE-TRIGGER): `sweepRetrigger`, when supplied, lets THIS SAME ticker also
re-fire the FULL sweep (`deps.sweep`, never `sweepLight`) on its own cadence — see that
param's own doc below. Only the "dispatch"/"retro" call sites pass it; the "sweep" phase's
own ticker (started BY a full-sweep call, below) never does, so a retrigger can never
re-enter the sweep it exists to keep light while it runs.
```

## HEADROOM_SAMPLE_MAX_AGE_MS

Removed from `src/lib/daemon.ts` lines 1907-1945 at the base commit.

```text
W1-T2565: the MOST STALE the account-headroom reading may be before the in-flight ticker takes
one of its own.

THE GOVERNOR SAMPLED ON THE LOOP WHOSE DURATION IT WAS MEANT TO BOUND. `daemon.headroom` is
written once per `runOne` iteration, and the read sits AFTER `runGatedSweep` — the sweep that
carries the inbox-draft rung, the fleet's largest single spender. So the more a tick spent, the
longer until the next reading: sampling rate was inversely coupled to spend, which is exactly
backwards.

MEASURED 2026-09-01 over the three-form union: `daemon.headroom` gaps run median 158s but p95
4,400s and max 21,586s (SIX HOURS). In one 58-minute window (09:17:25 -> 10:15:26) the account
went from 30% used to exhausted with the governor holding its last value throughout — 472 of the
period's session-limit refusals resolve to that single stale 30% reading, and no
`usage.probe_failed` row was written either, so it was silent rather than loudly failing.

THE CADENCE ALREADY EXISTED AND ONE SIGNAL WAS ALREADY RIDING IT. {@link startInFlightTicker}
runs every `pollIntervalMs` for the whole of a long dispatch/retro/sweep phase and already reads
DISK headroom on that cadence, latch and all. MEASURED across that same 58-minute window: 43
ticker passes, 43 of them carrying `disk_free_bytes`, ZERO carrying an account reading. Nothing
had to be built to make sampling possible — the account signal simply was not wired to it.

AND THE PROBE IS FREE, so there is no cost argument for the sparse cadence: `openUsageProbeSession`
opens a control-only SDK session over `emptyUsagePrompt`, an async generator that yields NOTHING.
Zero of 2,069 headroom/probe rows in the union carry a cost, against 4,332 rows that do.

300s, not `pollIntervalMs`: this BOUNDS staleness rather than setting a rate. The main loop still
takes the authoritative per-tick reading and the enforcement decision; this only guarantees that
when a tick runs long, the gap between readings stays minutes rather than hours. A tick that
completes normally re-reads before this ever elapses, so on a healthy fleet it fires never.

BACKSTOP, not the primary control: the main loop's own per-tick read (and the enforcement
decision built on it) remains the thing that normally keeps readings fresh; this constant only
bounds how stale a reading may get when THAT primary control is running long, same as the four
CLAUDE.md-cited bounds this task's own rationale (above) traces the defect back to.

POLICY DATA (rule 2) — a literal here, the same disposition `UNREADABLE_DEGRADED_LIMIT`
(lib/headroom.ts) records for its own bound.
```

## holdSeen

Removed from `src/lib/daemon.ts` lines 1976-1986 at the base commit.

```text
THE ACKNOWLEDGEMENT GAP (W1-T1065 design part iv). `daemon.pause` is written only
inside the branch that ACTS on a hold (the top-of-tick idle, or the re-check above) —
so while an admitted batch drains (phase "dispatch"), an operator hold created mid-
drain was invisible: no row distinguished "hold seen, draining to completion" from
"hold not seen at all". That ambiguity is exactly what made the originating instance
read as a broken control — the operator waited, saw nothing, and escalated to
`docker stop`. Riding this field on the SAME `daemon.alive` row `startInFlightTicker`
already writes every poll interval (no new step, no new row) closes it: a re-check
here can NEVER abort the batch already in flight — the drain-and-hold guarantee is
untouched — but the operator can now tell "seen, waiting for this batch to settle"
from "not seen yet" without escalating.
```

## headroomSampler

Removed from `src/lib/daemon.ts` lines 2004-2015 at the base commit.

```text
W1-T2565: SAMPLE ACCOUNT HEADROOM WHEN THE LAST READING HAS GONE STALE. Placed AFTER
the `daemon.alive` write on purpose: this tick's liveness heartbeat is already on the
ledger before the probe is awaited, so a slow or hanging probe can delay the NEXT
heartbeat but can never swallow this one. Wrapped in its own try/catch and gated on
`readUsage` being wired at all, so an absent or throwing probe costs one skipped
sample, never the ticker — the identical best-effort discipline the disk read above
already follows.

TELEMETRY, NOT ENFORCEMENT — deliberately. A reading taken here cannot abort work
already in flight, and the main loop remains the single place that decides to idle.
What this changes is that the decision, the console and every `daemon.headroom`
consumer stop reading an hours-old number.
```

## the full-sweep retrigger

Removed from `src/lib/daemon.ts` lines 2059-2092 at the base commit.

```text
W1-T1272 (RE-TRIGGER, design part (ii)): fires the FULL sweep — never `sweepLight`
above — when `sweepRetriggerIntervalMs` has elapsed since it last actually ran OR a
GitHub event explicitly woke this dispatch/retro wait, regardless of how long this
phase has held the loop. Without this, a boot whose
dispatch/retro holds the loop for its measured mean of 38.5 minutes got exactly one
full sweep (the one at the top of the iteration that started it) for that whole
span — the freshness exit cannot help here, it is only consulted BETWEEN
iterations, and this phase never returns to the top until the in-flight work
settles. Awaited before this loop continues to its NEXT `sweepLight` tick, so the
full sweep this fires still runs strictly one at a time against every other call
site (the top-of-iteration call cannot run again until this ticker is stopped, and
`runSweep`'s own cross-call mutex, cited at the top-of-iteration call site's
comment, serializes any theoretical overlap besides).

W1-T2519 (THE REVIEW RUNG MUST HALT EXACTLY LIKE DISPATCH DOES): the retrigger above
is what makes the review rung's cadence independent of a slow lane — but "independent
of the lanes" must not mean "independent of the operator". `deps.checkStop`/
`deps.checkPause` already gate the once-per-iteration `deps.sweep()` call at the top
of this loop (a STOP/PAUSE read there is checked BEFORE that call is ever reached —
see `runDaemon`'s own STOP/PAUSE checks, above `runGatedSweep`'s top-of-iteration call
site). A hold requested WHILE this ticker is running previously had no equivalent: the
retrigger fired on its clock alone, so an operator's STOP/PAUSE stopped new dispatch
admission but left the review rung posting regardless — the exact "operator's halt
stops dispatch and leaves reviews running" failure this task exists to close. Reading
both here, on every tick this ticker runs (never only "dispatch" — a long "retro"
phase holds the loop the same way and threads the SAME `sweepRetrigger`), closes that
gap without adding a new latch: the pure predicates are read exactly as they already
are elsewhere in this file. A halt withholds only a NEW full sweep this ticker would
otherwise have started — it can NEVER abort the phase's own admitted/running work (the
drain-and-hold guarantee `checkStop`/`checkPause` already carry everywhere else in
this file is untouched: `runOne` is never touched by this ticker). `lastRunAtMs` is
deliberately NOT advanced when held — the elapsed-time budget keeps accruing while
halted, so the very next unhalted tick fires immediately rather than waiting out a
fresh interval on top of the hold.
```

## SweepRetrigger

Removed from `src/lib/daemon.ts` lines 2138-2145 at the base commit.

```text
W1-T1272 — the shared config `startInFlightTicker`'s "dispatch"/"retro" call sites pass so
they can ALSO re-fire the full sweep on a cadence, not only `sweepLight` (see that param's
own doc). `state` is ONE mutable ref, threaded from `runDaemon` into every call site (the
top-of-iteration sweep call and every ticker that accepts this config) — never a fresh object
per call, which would make each phase re-derive "elapsed since last sweep" from its own
private zero instead of the sweep's actual last run.
```

## runGatedSweep and SweepLiveness

Removed from `src/lib/daemon.ts` lines 2161-2197 at the base commit.

```text
W1-T1272 — THE GATE ITSELF, extracted so the bound (`DaemonOpts.sweepWallClockBoundMs`) and
the light-sweep ticker it runs under apply IDENTICALLY at every call site: the
once-per-iteration call, the stale-freshness "reach the gate before returning" call, and a
mid-flight retrigger (`SweepRetrigger`, above). A second, inlined copy at any of those sites
is exactly how the bound or the ticker shape could silently drift between them. Behaviour is
byte-identical to the single inline block this replaces: the SAME `Promise.race` against a
real `setTimeout` (never `deps.sleep` — see the original comment this carries forward), the
SAME `daemon.sweep.abandoned`/`daemon.sweep.failed` log shapes, and the SAME in-flight-ticker
wrapping (phase "sweep") so `sweepLight` keeps ticking while a full sweep runs. Callers are
W1-T2584 adds one boundary without changing abandonment itself: the sweep receives a synchronous
continuation callback that stays true while this gate is live and STOP/PAUSE are clear. The
timeout flips it before resolving the `"abandoned"` arm, so a still-settling sweep can finish
already-running reviewers but cannot admit another one after the daemon stopped awaiting it.
Callers are responsible for checking `deps.sweep` is defined before calling this
(mirrors the original `if (deps.sweep)` guard) — this function assumes it is.


W1-T2582: THE ONE PIECE OF STATE THAT MAKES "ONE SWEEP AT A TIME" TRUE.

`inFlight` is set when a `deps.sweep()` promise STARTS and cleared when that promise SETTLES —
deliberately NOT when {@link DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS} stops awaiting it. That
distinction is the whole task: the bound stops WAITING and never stops the WORK, so between the
abandon and the eventual settle there is a window in which the pass is still executing and
nothing said so. Every re-entry the fleet observed landed in that window.

EXCLUSION, NOT CANCELLATION — the shard's own conclusion, and the only option that is not worse
than the defect. An abandoned pass may hold a live worker, a lock, or a half-written cache;
killing it at 559s would destroy legitimate long runs and could leave state mid-write. So the
abandoned pass runs to completion untouched and the NEXT one declines to start.

IN-PROCESS BY DESIGN, AND THAT IS SUFFICIENT HERE. All three `runGatedSweep` call sites live in
ONE daemon loop in one process, so a closure flag closes every route into it. This is NOT the
cross-process case W1-T2569's file lock had to solve for the draft rung, which is also reachable
from `rmd inbox` and must survive a restart; conflating the two would put a filesystem lock on a
path that has no second process to exclude.
```

## DEFAULT_MAX_API_WINDOW_HOLD_MS

Removed from `src/lib/daemon.ts` lines 2288-2327 at the base commit.

```text
W1-T2517 (THE DISPATCH LOOP IS NEVER TOLD THE WINDOW CLOSED): `apiError` is produced 13
times across worker.ts/run-task.ts and reaches daemon.ts/drain.ts ZERO times, so a closed
usage window is re-discovered per task at a full spawn each — worker home, containment
preflight, isolation preflight, worktree — before run-task.ts's OWN worker-level retry loop
(classify.ts's MAX_TRANSIENT_RETRIES) finally gives up and returns a `blocked_transient`
verdict. `reasonAboutBlock`/`blockRetryStates` (above) already bound how many times the
SAME task id retries that verdict across ticks (W1-T46) — but `blockRetryStates` is keyed
by task id, so a NEW task id always arrives with a fresh budget and pays the full spawn to
rediscover the identical closed window. That is precisely the argument W1-T113 already made
for spawn-infra failures (see `toolchainEscalated`'s own doc): a cause that blocks dispatch
identically for every task needs a signal keyed on the CAUSE, never on task id.

THE DISCRIMINATOR IS CONSECUTIVE ACROSS DIFFERENT TASK IDS. One task ending
`blocked_transient` is noise — a blip, a bad envelope — indistinguishable from ordinary
per-task flake, so it holds nothing (`streak` stays below {@link API_WINDOW_HOLD_STREAK_FLOOR}).
The SAME task retrying (its own per-task backoff, W1-T2515's scope) never advances the streak
either — `taskId === state.lastTaskId` is a no-op here — so a single flaky task looping on its
own retries can never read as a fleet-wide outage. Two or more DIFFERENT task ids ending
`blocked_transient` back-to-back IS the signal: not several broken tasks, one broken window.

MIRRORS THE SPAWN-INFRA BACKOFF SHAPE (`DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS`, just above) —
doubling, capped, reset on any dispatch reaching a REAL (non-`blocked_transient`) verdict —
built, proven, policy-as-data. Deliberately does NOT require a parsed reset time (that is
W1-T2515's classifier work, `classify.ts`'s `detectUsageLimitRefusal`): a plain consecutive
count works with zero knowledge of when the window reopens, and composes with a reset time
arriving later without requiring it.

NEVER TOUCHES BLOCK-REASONING ITSELF. This function is a pure, ADDITIONAL observation layered
beside `reasonAboutBlock` — it never changes a disposition, never clears a strike, and a
task's own real failure (any verdict other than `blocked_transient`) both strikes/escalates
exactly as before AND resets this streak to its floor in the same step (see the `verdict !==
"blocked_transient"` branch below) — a build failure is never masked as a window.

KIND: BACKSTOP (`test/bound-kind-declared.test.ts`'s vocabulary, W1-T1266), not a primary
control — the streak floor above is what normally stops an ordinary blip from holding
anything at all, and most real windows resolve inside a few small doublings; this ceiling
exists only so a window closed unusually long cannot make the hold unbounded, exactly the
`DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS` cap just above does not bite on an ordinary spawn retry.
```

## CrashLoopWindow

Removed from `src/lib/daemon.ts` lines 2376-2394 at the base commit.

```text
THE BOOT-RATE INVARIANT (W1-T215, recon T2-AC2). Two DIFFERENT root causes
have already produced a daemon relaunch loop: W1-T197's headroom-exhausted
exit-1 (fixed by moving headroom overage to an in-process idle heartbeat —
see `DaemonStopReason`'s doc, above) and the uncaught-escalate-throw loop
fixed in #472 (`tryEscalate`'s doc, escalate.ts — observed 2026-07-21
04:02-04:13, one boot per minute). Both were caught only because a human
read `daemon.boot` ledger timestamps and noticed the gaps were ~60s —
nothing in the system observed its OWN boot rate. A third cause is likely
(any uncaught throw anywhere in the poll loop produces the identical
shape), so this detects the SHAPE — many boots in a short window, each
doing no work — rather than any one known trigger.

A PURE FUNCTION over already-extracted `daemon.boot` timestamps (Rule 18):
no ledger read, no clock, no process spawn — provable against a synthetic
boot history with nothing but arrays and dates (this module never touches
the filesystem, see the file header). The caller re-derives
`bootTimestamps` from the ledger's own `daemon.boot` lines.
```

## DEFAULT_CRASHLOOP_WINDOW

Removed from `src/lib/daemon.ts` lines 2402-2409 at the base commit.

```text
DEFAULT: more than 5 boots inside any rolling 10-minute window. Sized
against the two observed incidents (~one boot/minute — 10+ boots in 10
minutes) with headroom for a legitimate handful of restarts during
commissioning or config-change testing, which this must NOT trip on (the
false-positive falsifier, test/daemon-crashloop.test.ts) — an invariant
that cries wolf gets muted, and a muted invariant is worse than none.
```

## DaemonBootTimestamp

Removed from `src/lib/daemon.ts` lines 2426-2440 at the base commit.

```text
One `daemon.boot` timestamp, optionally carrying WHY THE BOOT IMMEDIATELY
BEFORE IT ended (never why this one did — a boot cannot know its own
future). W1-T2450 (recon rationale Q3): before this field existed,
{@link detectDaemonCrashLoop}'s entire input was a bare timestamp array, so
a freshness restart (a deliberate `exit 75` self-relaunch onto a newer
`origin/main` — W1-T126, `daemon_selfrestart_for_freshness`) and a real
crash were the identical event to it: six routine freshness restarts are
six boots, and six boots breach a `maxBoots: 5` window exactly like six
crashes would. A bare ISO string is still accepted everywhere this type
is — it reads as `{ ts }` with no reason, and an absent/`"unknown"` reason
counts toward the window exactly as it always has (never a blanket
amnesty for an unlabeled boot); only an EXPLICIT `"freshness"` is ever
excluded.
```

## detectDaemonCrashLoop

Removed from `src/lib/daemon.ts` lines 2446-2459 at the base commit.

```text
Find the densest `windowMs`-wide run of boots and compare its size against
`maxBoots`. Unparseable timestamps are dropped rather than thrown on — the
ledger's own torn-line discipline (ledger.ts) — so one malformed line never
takes the invariant itself down. Detects the SHAPE only: it does not care
WHY a boot happened, so the identical function catches a headroom-exit
loop, an escalate-throw loop, and whatever the next uncaught-throw cause
turns out to be — EXCEPT a boot explicitly labeled `priorExitReason:
"freshness"` (see {@link DaemonBootTimestamp}), which this now excludes
from both the density count and the returned evidence: it is the daemon
restarting itself on purpose, not a symptom. O(n²) in the boot count,
which is fine — callers pass a bounded recent tail of the ledger, never
its full history.
```

## daemonBoot

Removed from `src/lib/daemon.ts` lines 2486-2528 at the base commit.

```text
The daemon's startup routine (W1-T12b): the ANTHROPIC-clean-env boot
assertion, run ONCE before the scheduler loop starts. Takes the log sink and
the env to check as explicit, injectable inputs — same shape as the rest of
this module — so it is provable in-process from a unit test with a fake env,
with NO real launchd load involved (that live commissioning step is
W1-T12d). The launchd unit that execs `rmd daemon` is generated by
lib/launchd.ts; this is the belt-and-suspenders check the daemon process
itself runs at boot, regardless of how it was launched.

TEMP-DIR HYGIENE (W1-T115, the 26,711-dir ENOSPC incident): an optional
`sweepTmp` dependency, called once here if supplied and its count logged as
`daemon.tmp_sweep`. Injected rather than imported directly — same
discipline as the rest of this module (`this pure module never touches the
filesystem`, see the file header) — the real command wires
`lib/tmp.ts`'s `sweepStaleTempDirs`; tests inject a fake that counts calls
or seeds a fixed summary. Omitted ⇒ no sweep, behavior unchanged from
before W1-T115.

BOOT-RATE INVARIANT (W1-T215): an optional `crashLoopCheck` dependency,
consulted once here, logged as `daemon.crashloop_check` either way so the
check's OWN pass/fail is part of the boot record — a breach is surfaced via
`crashLoopCheck.onBreach`, called with the {@link CrashLoopVerdict}'s
evidence attached (the real command wires this to escalate.ts, e.g.
`tryEscalate`, so a loop opens a needs-human issue instead of waiting for a
human to notice the boot-timestamp gaps). Omitted ⇒ no check, behavior
unchanged from before W1-T215.

TOOLCHAIN RESOLUTION (W1-T113 part i, "log the resolved path once at daemon
boot"): an optional `resolveClaudeBin` dependency, called once here — the
real command wires worker.ts's `resolveClaudeExecutable` against its
shared, PER-PROCESS `claudeExecutableCache`, so this boot-time resolution
and every later `spawnWorker` call agree on the SAME answer, never a
second, possibly-different resolution. Logged as `daemon.claude_bin` either
way: success names the resolved `path`; a thrown
`ClaudeToolchainBlockedError` (duck-typed via `reasonClass`, same idiom as
`unlockWorkerKeychain`'s catch below) is logged with `blocked: true` and its
`error_class`, and BOOT CONTINUES — a fully-absent toolchain still fails
legibly the moment dispatch actually tries to spawn (this function's own
"the daemon sleeps through problems" doctrine, T197), it just never blocks
boot itself. Omitted ⇒ no resolution attempt here, behavior unchanged from
before W1-T113.
```

## sweepOrphanWorkers

Removed from `src/lib/daemon.ts` lines 2564-2574 at the base commit.

```text
W1-T117 orphan sweep (design part ii): "the orphan sweep terminates
strays from ended runs and ledgers them" — run once here, at boot,
mirroring `sweepTmp`/`sweepLocks` above (injected, logged either way as
`daemon.orphan_sweep` naming the killed/left-alone counts so the boot
record carries this sweep's own pass/fail, not only its strays). The
per-kill `worker_orphan_killed` ledger line is the injected function's
OWN job (`sweepOrphanWorkers`'s `ledger` dep, worker-containment.ts) —
this boot step only summarizes. Omitted ⇒ no sweep, behavior unchanged
from before W1-T117.
```

## bootHeadSha

Removed from `src/lib/daemon.ts` lines 2576-2583 at the base commit.

```text
The sha of the CODE THIS PROCESS LOADED, resolved by the caller at boot (`git rev-parse HEAD`
in the install it was launched from). Recorded on `daemon.boot` so the deploy supervisor can
compare the RUNNING code against the checkout instead of comparing the checkout against
origin — the latter is consumed by anyone who pulls first, which left the daemon running
stale code silently (see `decideDeployTrigger`). Appended LAST so no positional caller
shifts. Omitted ⇒ the field is absent, exactly as before, and the supervisor fails eager.
```

## sweepFeedbackLanding (2)

Removed from `src/lib/daemon.ts` lines 2585-2595 at the base commit.

```text
W1-T530 part (ii): "the level-triggered feedback-landing backstop runs once here, at boot,
mirroring `sweepOrphanWorkers` above" — run once here, logged either way as
`daemon.feedback_landing_sweep` naming whether it pushed and how many files, so a
pre-existing stranded entry (never seen by any capture in THIS process) is picked up the
moment the daemon comes up, not only on its next per-poll pass. The real command wires
`feedback-landing.ts`'s own `sweepFeedbackLanding`. Synchronous, like `sweepOrphanWorkers`
above (`landFeedback`'s own mechanism never awaits — see that module's header). Appended
LAST, after `bootHeadSha`, so no positional caller shifts. Omitted ⇒ no sweep at boot,
behavior unchanged from before W1-T530.
```

## daemonBoot checkoutDepth

Removed from `src/lib/daemon.ts` lines 2611-2625 at the base commit.

```text
W1-T2332: the canonical checkout's HISTORY HORIZON — `git rev-parse --is-shallow-repository`
and `git rev-list --count HEAD`, measured by the CALLER exactly where it already resolves
`bootHeadSha` above (`src/run-task.ts`, best-effort, in a try/catch), because this module
never touches the filesystem by its own header. Every sibling boot fact (env, node path, node
version, head sha) was already carried on this row and this one was not — a shallow clone
breaks every history read SILENTLY (`git log -S`, `--follow`, merge-base checks all stay
plausible over a truncated corpus) and nothing proactive asked. Recorded here, NOT ledgered
as a new row: the boot record is the boot record. A SHALLOW CHECKOUT MUST NOT HALT THE BOOT
(T197 doctrine, this function's own doctrine for the keychain rung above) — this only ever
adds fields to the existing `daemon.boot` line; `rmd doctor`'s `checkout-depth` arm
(`src/lib/doctor.ts`) is where the FAIL verdict lives. Appended LAST, after
`declaredNodeVersion`, per this function's own "no positional caller shifts" discipline.
Omitted ⇒ the fields are absent, exactly as before — never a guessed value.
```

## unlockWorkerKeychain

Removed from `src/lib/daemon.ts` lines 2656-2663 at the base commit.

```text
W1-T235 (WS-7 keychain-unlock gate): the boot-time worker-keychain unlock,
EXPLICIT AND LEDGERED — the fleet's credential store comes up unlocked as a
named boot step, never as a side effect of unlocking the operator's login
keychain. Injected like the sweeps above (the real command wires
worker-home.ts's ensureWorkerKeychain). A failure here is ledgered with its
credential-named class and the boot CONTINUES (T197 doctrine: the daemon
sleeps through problems) — each spawn re-runs the rung and fails
credential-named at the spawn boundary, never as a $0 containment mystery.
```

## checkDispatchGovernors

Removed from `src/lib/daemon.ts` lines 2748-2761 at the base commit.

```text
W1-T342's PER-DISPATCH GOVERNOR GATE now lives in sweep.ts, RE-EXPORTED here unchanged.

WHY IT MOVED. `runDrainLanes` (drain.ts) must call the SAME function per lane it admits — this
function's own doc says so in as many words ("W1-T343's loop must call THIS function again per
lane it admits, never hoist a single call above the loop"). But daemon.ts already imports
`nextRunnable` FROM drain.ts, so drain.ts importing it from here would close an import cycle.
sweep.ts is the only home that avoids that: it already owns `CostGovernorResult` and
`QueueGovernorResult`, it imports neither daemon nor drain, and BOTH already import it.

The alternative was a second copy of the predicate in drain.ts, which is the defect this repo
has paid for twice. Re-exported rather than relocated-and-rewired so every existing importer
(test/cost-governor.test.ts among them) keeps working byte-for-byte.
```

## function

Removed from `src/lib/daemon.ts` lines 2764-2778 at the base commit.

```text
The daemon's scheduler loop. Deterministic; no LLM decisions. Each tick:
check STOP → check PAUSE → check headroom → pick the next runnable (DAG
order, reusing drain.ts's `nextRunnable` — never reimplemented) → run it →
REASON about any non-merged verdict (W1-T46, superseding v1's blunt
stop-on-block): transient retries (no strike), an independent failure is
flagged + skipped while the rest of the drain continues, a FIXABLE genuine
blocker gets a bounded fix-rung attempt before halting (W1-T174, drain/
sweep parity), and a genuine blocker with no fixable signal (or an
exhausted fix attempt) halts + escalates. When nothing is runnable OR
headroom is exhausted, sleep
via the injected clock and poll again — the loop is PERSISTENT by default
(no `max`), unlike a bounded drain, and idling (for either reason) is an
in-process state, never a process exit.
```

## sweepLiveness

Removed from `src/lib/daemon.ts` lines 2788-2796 at the base commit.

```text
W1-T1272: ONE mutable ref for "when did a full sweep last actually run", shared by every
call site below (the once-per-iteration call, the stale-freshness call, and every
"dispatch"/"retro" ticker's retrigger) — see `SweepRetrigger`'s own doc for why a shared
reference, not a fresh object per call site, is load-bearing here. `lastRunAtMs` starts
`undefined`: the first sweep of this process's life runs unconditionally (unchanged from
before this task), never gated on an elapsed-time check against a run that never happened.
W1-T2582: ONE liveness flag for this daemon's whole life, shared by every `runGatedSweep`
route — the top-of-iteration calls and the in-flight ticker's retrigger alike. Per-process
scope is the correct scope: see {@link SweepLiveness}.
```

## circuitEscalated

Removed from `src/lib/daemon.ts` lines 2870-2878 at the base commit.

```text
CIRCUIT BREAKER ESCALATION DEDUP (P29(ii)): the daemon is a PERSISTENT
loop — `nextRunnable` is re-invoked on EVERY tick, forever, so without this
a task that stays tripped would be re-escalated on every idle poll for as
long as the daemon keeps running (unbounded, the very unbounded-noise
shape P29 exists to prevent). This Set bounds the CALLBACK to the
daemon's own first observation of each task id this run; `isCircuitTripped`
itself is still consulted (and still excludes the task from dispatch)
every tick — see drain.ts's `runDrain`, the identical fix for the bounded
one-shot loop.
```

## headroomReserveEscalated

Removed from `src/lib/daemon.ts` lines 2893-2900 at the base commit.

```text
HEADROOM RESERVE ESCALATION DEDUP (P34 clause (c), W1-T249): the SAME
per-episode bound `circuitEscalated` applies above — a sustained breach is
read fresh every tick (never a stop, see the HEADROOM comment below), so
without this the notification hook would fire on every idle poll for as
long as the window stays over the reserve. Cleared the moment a read
reports the window back under the reserve, so a LATER breach (a new
episode) escalates again rather than staying silenced for the rest of
this process's life.
```

## diskHeadroomLatch

Removed from `src/lib/daemon.ts` lines 2902-2911 at the base commit.

```text
DISK HEADROOM ESCALATION DEDUP (W1-T1082): the SAME per-episode-latch shape
`headroomReserveEscalated` applies just above, threaded (never redeclared) into every
`startInFlightTicker`/`sweepLightDuringRetro` call below so ALL THREE phases (dispatch,
sweep, retro) share the ONE latch for this daemon run — a breach first observed mid-dispatch
must not re-escalate the moment a sweep tick observes the same still-unresolved reading.
Cleared the instant a reading is back at OK, so a LATER breach (a genuinely new episode)
escalates again rather than staying silenced for the rest of this process's life. Held as a
mutable object, not a bare `let`, because `startInFlightTicker` is a free function called
fresh per phase — a plain closed-over boolean would reset every call; this object is the
SAME reference across all of them.
```

## processDispatchResult

Removed from `src/lib/daemon.ts` lines 3027-3044 at the base commit.

```text
W1-T343: ONE per-task block-reasoning processor, shared by the single-task tick
(`laneCount <= 1`) and the multi-lane batch (`laneCount >= 2`) below — the SAME "never a
second implementation" discipline this task applies to lane partitioning also applies to
judging a lane's verdict: a fork between "how a solo dispatch's result is judged" and "how
one lane's result in a batch is judged" is exactly the drift-prone duplication this task
exists to close. Extracted VERBATIM from the pre-W1-T343 single-task loop body — every log
line, field and ordering decision below is byte-identical to before this function existed,
just callable once per task instead of inlined once per tick. `planForBatch` is threaded in
as a parameter (never closed over) because it is rebound every tick (see its own doc above);
a closure captured once, above the loop, would freeze it at tick 1 forever.

Returns a disposition rather than returning out of the whole loop directly, so a caller
processing several lanes' results in one batch can finish EVERY sibling's own bookkeeping —
its retry-state update, its fix dispatch, its independent-failure flag, its merge — before
deciding whether to halt the daemon (LANE-LOCAL BLOCK SEMANTICS: see `runDrainLanes`' own
doc, drain.ts). At `laneCount <= 1` there is only ever one caller per tick, so this is a
provable no-op restructuring: same inputs, same log lines, same return value threaded
straight back into a `return summary("blocked", …)` exactly as before.
```

## result

Removed from `src/lib/daemon.ts` lines 3051-3058 at the base commit.

```text
W1-T976: `result.verdict` describes how THIS RUN ended, not whether the task's pull
request is merged — a PR that merges gate-side (GitHub's required-status contract)
AFTER the run stopped leaves `result.merged` false even though the task is done. The
tick's already-resolved merged projection (`isMerged`, threaded in from `deps.refreshMerged()`
— never a second GitHub lookup, see this function's own call site) answers the question
block-reasoning is actually trying to ask. A task the projection credits as merged takes
the SAME `{ kind: "merged" }` path a merged `result` always took; a genuinely unmerged task
reaches `reasonAboutBlock` exactly as before.
```

## blockRetryStates

Removed from `src/lib/daemon.ts` lines 3083-3092 at the base commit.

```text
W1-T174 (drain/sweep PARITY): the SAME blocked_ci/blocked_review
evidence the W1-T77 sweep routes to the W1-T76 fix rung gets a
bounded fix attempt here too, BEFORE halting — strike-capped by
`reasonAboutBlock` via the SAME classify.ts primitive every
strike in this module already uses (never a separate, unbounded
loop — the W1-T168 anti-regression guard: exhausting the bound
falls through to `genuine_blocker` on a LATER tick and escalates
for re-judgment, it does not fix-loop forever). Keep the retry
state threaded across ticks — dropped only once resolved
(merged, flagged, or escalated) below.
```

## log

Removed from `src/lib/daemon.ts` lines 3120-3128 at the base commit.

```text
GENUINE BLOCKER: real downstream work transitively needs this task
merged — "never continue into the gap" is absolute here. Halt and
escalate, exactly as v1's stop-on-block halted, but now the
dependents it protects are named. Reached by a `genuine_blocker`
disposition (no fixable signal at all, or a `fixable_blocker` whose
strike bound `reasonAboutBlock` already exhausted) AND by a
`fixable_blocker` with no `dispatchFix` wired (W1-T174: never a
silent stall on a fixable block this daemon has no rung to act on —
the SAME halt+escalate a genuine blocker always got).
```

## the liveness tick

Removed from `src/lib/daemon.ts` lines 3148-3159 at the base commit.

```text
LIVENESS TICK (W1-T1274). THE ONE ROW THIS LOOP WRITES UNCONDITIONALLY, EVERY ITERATION,
ON EVERY PATH BELOW — max_reached, stop, pause, a stale-freshness early return, idle, or a
full dispatch/sweep/retro pass. Every OTHER `daemon.`-prefixed step is either boot-time and
one-shot, or (`daemon.alive`, {@link startInFlightTicker}) confined to the three windows
that ticker actually runs in (retro/full-sweep/dispatch-settling) — so a stretch of the loop
outside all three (the inter-iteration `deps.sleep`, and every tick that returns early at
the freshness check before a ticker is ever started) wrote NO `daemon.`-prefixed row at all.
MEASURED: the `daemon.`-prefix went silent for 102.5 minutes on 2026-08-23 while the daemon
stayed alive, alternating exactly those short, ticker-less iterations back to back — the
false FAIL `judgeLedgerFreshness`/`deriveLastPoll` (doctor.ts, daemon-health.ts) read against
a two-minute bound. Placed as literally the first statement of the loop body, before even
`checkStop`, so it cannot be skipped by any branch below.
```

## plan freshness

Removed from `src/lib/daemon.ts` lines 3177-3193 at the base commit.

```text
PLAN FRESHNESS (impl-FZ). `plan` arrives as a parameter and, before this, was NEVER
reassigned — no `loadPlan`, no `syncPlan`, nothing — so a task filed after this boot began
was invisible to EVERY dispatch decision for the boot's lifetime. Measured on the real
ledger: the median gap between a task landing on origin/main and the daemon next booting is
106 minutes; 64% of filings waited over an hour, 40% over three. With auto-triage now filing
unattended, that is a task queue the running fleet cannot see.

PLACED HERE DELIBERATELY, and the position is the batch safety argument:
  - AFTER `checkStop`, so a deliberately halted fleet never does I/O to reload.
  - At the TOP of the tick, before any dispatch decision reads the plan.

The dep returns null when nothing changed, so the caller owns change detection and the
common case costs no parse. It must re-read from the SAME source the boot used
(origin/main, never the working tree) — a second source of truth here is the exact defect
this project has spent days unpicking. A throw is caught and ledgered, never fatal: a
transient git failure must degrade to "keep running on the plan we have", not take the
fleet down.
```

## planForBatch

Removed from `src/lib/daemon.ts` lines 3205-3223 at the base commit.

```text
ONE SNAPSHOT PER DISPATCH BATCH (W1-T340; MASTER-PLAN §4B; narrows W1-T326 blocker (2)).
`plan` above is a MUTABLE local binding — reassigned by the reload block on every tick it
fires — so a piece of code that closes over the NAME `plan` reads whatever the MOST RECENT
reload produced, not necessarily the value that was live when its own dispatch decision was
made. That distinction was invisible before this line existed: `runDaemon` picks and awaits
exactly one task per tick (N=1), so nothing ever ran between one reload and the next that
could observe the difference. It stops being invisible the moment a batch holds more than
one lane (W1-T343): lane A can be dispatched from this tick's plan, the tick can then reload
for lane B, and if lane A's OWN later reasoning (its post-hoc block judgment, an overlap
partition, a retry) reads the live `plan` binding instead of what it was dispatched under, it
is silently re-judged against a blob it never saw — no throw, no ledger line, two disagreeing
answers. `plan = fresh` reassigns the BINDING, never mutates the Plan object itself (JS
reference semantics), so the fix is a value capture, not a lock: `planForBatch` is bound ONCE,
right here, immediately after this tick's reload has settled, and is the ONLY plan value every
lane and every decision below — the kick check, `nextRunnable`'s selection,
`reasonAboutBlock`'s post-hoc judgment — may consult for the REST of this tick. `plan` itself
is free to be reassigned again on the NEXT tick; `planForBatch` never is. This holds at N=1 too
(a single-lane batch is a batch of one, and the discipline is identical), which is what makes
it landable and provable before any lane exists rather than speculative scaffolding.
```

## deps

Removed from `src/lib/daemon.ts` lines 3225-3232 at the base commit.

```text
DAILY COST CEILING FRESHNESS (W1-T331): mirrors `reloadPlan` immediately above — SAME
placement (top of the tick, before any dispatch decision, so everything below sees ONE
consistent ceiling), SAME "a throw is caught and ledgered, never fatal" contract. UNLIKE
`reloadPlan` (whose failure just keeps serving the plan already held), a failed read here
deliberately does NOT touch `dailyCostCeilingUsd` — see `DaemonDeps.reloadDailyCostCeilingUsd`'s
doc for why leaving it at its last known-good value, rather than resetting it to
`undefined`, is the correct degrade: `undefined` reaching `checkCostGovernor` reads as "no
live override," silently widening the ceiling back to the frozen shipped default.
```

## PAUSE before self-freshness

Removed from `src/lib/daemon.ts` lines 3240-3254 at the base commit.

```text
PAUSE (W1-T11) is checked BEFORE SELF-FRESHNESS (W1-T936) — a deliberate operator
hold must win against a restart decision, exactly like STOP already wins against it
above. Before this reorder PAUSE sat below the freshness exit: a paused daemon on a
checkout that never fast-forwards its own (nothing in the daemon's own boot moves its
ref) hit `return summary("stale", ...)` on every tick, exited nonzero, and launchd's
KeepAlive{SuccessfulExit:false} relaunched it straight back into the same PAUSE flag —
the 2026-08-17 relaunch storm, the same shape as the 2026-07-22 storm PAUSE's own
exit-vs-idle fix (below) already defends against, just arriving through the freshness
check instead of PAUSE's own return. PAUSE is an IN-PROCESS idle, never an exit: one
heartbeat per tick, sleep on the injected clock, re-poll — `rmd resume` deletes the
flag and the very next tick of this SAME process proceeds, at which point
SELF-FRESHNESS below fires immediately if origin/main moved while paused, so a stale
checkout is never dispatched against — a paused daemon dispatches nothing at all.
STOP (above) is still checked first, so a hard STOP still terminates a paused daemon
cleanly (exit 0) instead of idling forever.
```

## the top-of-iteration full pass

Removed from `src/lib/daemon.ts` lines 3285-3320 at the base commit.

```text
LEVEL-TRIGGERED PR-PIPELINE RECONCILER (W1-T77, ratifies P22 core): once
per iteration, re-derive every open PR's disposition and take its gated
action. Runs alongside dispatch (not instead of it): dispatch opens NEW
work, the sweep reconciles the OPEN PRs already in flight so none strands
open-and-orphaned (the #111/#113/#123 class). Best-effort by contract —
and now IN CODE, not just in this comment. The sweep reaches `gh` through
execFileSync, which THROWS on any nonzero exit (rate-limit, auth blip,
network partition). This loop's only try/catch wraps `runOne` (below), so
before this guard such a throw propagated out of the process; launchd's
KeepAlive{SuccessfulExit:false} reads the nonzero exit as a CRASH and
relaunches, which re-runs the same sweep and throws again. A reconciler
that cannot reach GitHub must cost the daemon one logged iteration, never
its life.

W1-T513 — THE THIRD TICKER CALL SITE. `deps.sweep()` (the full reconciler, over EVERY
open PR, sequentially) was the one remaining long tick occupant with no ticker of its
own: retro and dispatch (below) both already tick `sweepLight` while they run, so a
green, review-eligible PR still posted within one poll interval during either of those
— but a slow full sweep (a real `gh` walk over every open PR) starved the light pass for
its own entire duration, with no ticker running at all. Wrapping it here was UNSAFE
before this same task lifted {@link "./sweep.js".inFlightReviewKeys} out of `runSweep`
into a module-level, cross-call mutex: without that, this ticker's own `sweepLight()`
ticks would run CONCURRENTLY with `deps.sweep()`'s own `runSweep` walk and could both
decide to post a review for the same PR at once (the exact race
`test/daemon.test.ts`'s "TODAY's post-review dedup is a ledger READ, not a mutex"
fixture demonstrated). With that mutex now shared process-wide, the two concurrent
callers arbitrate the SAME `${taskId}@${headSha}` key correctly, so ticking here is safe
exactly like the retro/dispatch sites are. Same discipline as both: cleared on every
exit path via `finally`, a `sweepLight()` already in flight is allowed to finish rather
than aborted, and a ticker hiccup is ledgered (`daemon.sweep_light.failed`) but never
propagated.
W1-T1272: the bound/ticker logic formerly inlined here now lives in `runGatedSweep`,
shared with the "reach the gate before returning" call in the stale-freshness branch
above and with every ticker's retrigger (`SweepRetrigger`) — see that function's own doc.
`sweepRetriggerState.lastRunAtMs` is updated here too, so a retrigger's own elapsed-time
check (below, in `startInFlightTicker`) measures from whichever call actually ran last.
```

## deps (2)

Removed from `src/lib/daemon.ts` lines 3388-3395 at the base commit.

```text
GITHUB-SIDE POSTURE DRIFT CHECK (W1-T1040): runs alongside the sweeps above, on the SAME
"once per iteration" cadence — the hook itself throttles the actual read to at most once a
day (github-posture.ts's decideGithubPostureCheck), so most ticks return `[]` at no network
cost. Best-effort by the same contract as `sweep`/`sweepOrphans`/`sweepFeedbackLanding`
above: a throw costs one logged tick, never the daemon's liveness. A non-empty return is
LEDGERED — never gated, never a `continue`, never consulted by any governor below — so a
posture finding can never halt a dispatch or fail a check (task rationale (vii)). Optional:
omitted ⇒ the loop behaves exactly as before this check existed.
```

## deps (3)

Removed from `src/lib/daemon.ts` lines 3407-3415 at the base commit.

```text
MEASUREMENT CADENCE (W1-T1259): "is this system getting better" — `rule-efficacy`,
`verdict-calibration`, `autonomy-rate` — runs alongside the sweeps/posture check above, on
the SAME "once per iteration" cadence; `checkMeasurementCadence`'s own policy-data bound
throttles the actual run to at most `maxPerDay` times, at least `minIntervalMinutes` apart,
so most ticks decide `fire: false` at no cost. Best-effort by the SAME contract as
`checkGithubPosture` above: a throw costs one logged tick, never the daemon's life, and a
fired run NEVER gates dispatch, fails a check, or changes a verdict — it is a ledger row
for the operator, nothing more. Optional: omitted ⇒ the loop behaves exactly as before this
rung existed (the three verbs stay operator-run only).
```

## the board-review block

Removed from `src/lib/daemon.ts` lines 3472-3488 at the base commit.

```text
BOARD REVIEW (W1-T2304's design, wired here). The rung whose unit is the WHOLE OPEN BOARD.
Same shape and the same best-effort contract as the two cadences above, on its own policy
row and its own marker file.

THE LEDGER ROWS BELOW ARE PART OF THE FIX, NOT DECORATION. `board-review.ts` has no `log()`
hook of its own, so before this block a fire would have written no ledger row at all and
"did it run" was answerable only by the presence of a file nothing watches. These rows are
what the digest already sweeps into the inbox, and they are what makes a future
"has it fired" question a one-line ledger read instead of a recon.

W1-T2464: `checkBoardReview` also RECONCILES — every call, fired or not — retiring any
registry proposal whose referent PR has left the board it just read (see
`reconcileBoardReviewReferents`'s header doc, board-review.ts). `retiredProposalIds` is
logged on BOTH branches below, deliberately: reconciliation is bookkeeping tied to the
check, not to the fire, so a tick that retires rows but does not itself fire must still be
visible — a reconciliation nobody can see repeats this file's own history (the rung fired
five times before anyone noticed, because nothing surfaced its output).
```

## the headroom block

Removed from `src/lib/daemon.ts` lines 3520-3532 at the base commit.

```text
HEADROOM: never hammer a nearly-exhausted pool. An at/near-limit reading
gates new spawns WITHOUT halting the loop (see the DaemonStopReason doc
above — a launchd KeepAlive unit restart-loops on any exit, so exiting
here would just relaunch into the same exhausted reading every poll).
Instead this is an in-process idle state, identical in shape to
"nothing runnable" below: sleep via the injected clock, emit one
`daemon.headroom` heartbeat per tick naming the window/percent/reset,
and re-check next tick — until the window resets and headroom frees up
(readUsage() is called fresh every tick, so a real reset is picked up
automatically, no separate "wake up at resets_at" timer needed), or
STOP/PAUSE is honoured above. The ceiling itself is TIME-AWARE
(`headroomPolicy`, resolved once above): on a window's final day it
relaxes toward 100%, since anything unspent is destroyed at reset.
```

## reportedUnrecognisedResets

Removed from `src/lib/daemon.ts` lines 3550-3558 at the base commit.

```text
ONCE PER WINDOW, NOT PER DISTINCT STRING (W1-T482). The loop polls every 60s, so a
per-tick emission would write ~1,440 identical lines a day and bury the one thing
worth reading — which is exactly what keying on the raw string stopped preventing
once the upstream started emitting microsecond-precision ISO timestamps: every tick
produces a string no earlier tick produced, so a raw-keyed set never once matched and
the bound was inert (measured 1:1 fired-to-distinct on two independent ledgers).
`window` is the small, fixed set this was always meant to bound by. The set is seeded
from the ledger (DaemonDeps.priorUnrecognisedResets), so the bound holds across a
restart as well as within one process.
```

## the unconditional headroom heartbeat

Removed from `src/lib/daemon.ts` lines 3584-3605 at the base commit.

```text
─── ONE HEARTBEAT PER TICK, IN EVERY ENFORCEMENT POSTURE ───────────────
THE ASYMMETRY THIS FIXES. The log used to live inside `if (over)` on the
enforcing branch and inside the `else` on the disabled branch — with NO
`else` on the inner `if (over)`. So the one posture an operator is most
likely to be in — governor ARMED, usage comfortably UNDER the ceiling —
logged NOTHING AT ALL. The governor was armed on this host on 2026-07-31
and the ledger emitted no `daemon.headroom` line from that moment on; the
newest one anywhere (live file ∪ 661 rotations) was 14:59:05Z, `enforced:
false`, from BEFORE the switch. Any console panel reading this step would
have rendered permanently-frozen numbers and been believed — the
"tested, inert" shape this repo has already shipped twice.

So the heartbeat is now UNCONDITIONAL on a good read, and carries
`enforced` so a reader can tell an armed governor from telemetry-only.
`over ?? windows[0]` reproduces BOTH previous lines' window selection
exactly: the offending window when over, else the most-burned one
(`resolveHeadroomWindows` returns most-burned-first).

NOTHING ABOUT ENFORCEMENT MOVED. The idle-pause, the once-per-episode
`onHeadroomBreach`, and the `continue` all still happen, still only when
`headroomEnabled && over`, still after this line — see `enforcingIdle`.
Only the under-ceiling SILENCE changed.
```

## the unreadable-usage branch

Removed from `src/lib/daemon.ts` lines 3648-3661 at the base commit.

```text
UNREADABLE: cannot-read-the-budget must never render as
proceed-as-if-unlimited (the fail-open polarity at the spending
layer — the #157/#143-adjacent cannot-observe-rendered-as-permissive
family: the gateway returning `[]`, W1-T181; the projection
regressing to `queued`, W1-T179). This is now an EXPLICIT, tested,
BOUNDED policy rather than an implicit "continue regardless"
fall-through: a handful of consecutive misses is a transient read
failure (recon R-7: unreadable ~78% of the time in the live
ledger — an unconditional fail-closed-on-first-miss would halt the
fleet most of the time), so dispatch is still permitted WITHIN the
bounded allowance, always logged distinctly (never silently); once
the allowance is exceeded, the daemon escalates to the SAME
in-process idle heartbeat a confirmed breach uses, until a read
succeeds again.
```

## log (2)

Removed from `src/lib/daemon.ts` lines 3687-3694 at the base commit.

```text
THE CEILING FIRED. Dispatch proceeds this tick with the governor still blind, and the
row says so plainly: the bound being bypassed exists to stop the fleet spending
against an exhausted account, so forcing DELIBERATELY accepts that risk rather than
pretending the read succeeded. Mirrors `deploy.idle_ceiling_forced`.

ONE TICK, NOT A MODE. Clearing the clock here re-arms the ceiling, so the next park
waits the full period again — the exposure is bounded at one blind dispatch per
ceiling, never an unbounded blind run.
```

## the tick-wide governor gate

Removed from `src/lib/daemon.ts` lines 3772-3792 at the base commit.

```text
DAILY COST CEILING (W1-T317, wiring `checkCostGovernor`/sweep.ts) + QUEUE GOVERNOR / WIP
CEILING (W1-T321, wiring `checkQueueGovernor`/sweep.ts, the W1-T121 23-open-PR incident):
both global gates, not per-task ones, so — unlike `isCircuitTripped`/`isLifetimeCapExceeded`
below — they are checked directly here, right after headroom and before the retro trigger (a
fired retro spawns a real, budget-costing run too — same reasoning the retro trigger's own
comment already gives for running after headroom) and before the idle branch's auto-triage
rung (same reasoning again — auto-triage also spawns a real, budget-costing run). UNLIKE
drain.ts's bounded pass (which stops outright), this daemon is PERSISTENT: a deferral is an
in-process idle heartbeat, identical in shape to headroom's own `enforcingIdle` branch just
above, so the loop resumes automatically once the observed reading drops back under the
ceiling/limit.
W1-T331: threads THIS tick's own ceiling snapshot (reloaded above, top of tick) through —
never a fresh read here and never the frozen default unless the reload itself never
populated one.
W1-T342: this is the TICK-WIDE gate — it still runs exactly ONCE per tick, guarding
whichever ONE dispatch-shaped action (retro fire, auto-triage fire, or the normal task
dispatch below) this tick can still take, unchanged in effect from before this task. It is
NOT, by itself, the per-dispatch gate a multi-lane batch needs — see `checkDispatchGovernors`'s
own doc, and the SECOND consultation immediately before `runOne` below: this call alone
would let a second lane in one batch spend against a reading taken before the first lane's
own cost could show up in it.
```

## the retro cadence trigger

Removed from `src/lib/daemon.ts` lines 3802-3820 at the base commit.

```text
RETRO CADENCE TRIGGER (W1-T160): evaluated once per tick, AFTER headroom (an
automated retro spawns a real, budget-costing Architect run — the same class of
spend headroom exists to gate, so a fired retro under a near-exhausted pool waits
like any other dispatch would) and BEFORE the normal task-dispatch pick.
Best-effort: a caught error costs one logged tick, never the daemon's life (same
discipline as deps.sweep/deps.sweepOrphans above).

W1-T2265: NO `sleep(pollIntervalMs)`/`continue` here, DELIBERATELY, unlike the
pause/headroom/cost-and-queue-governor gates above. Those three exist to REFUSE a
dispatch and must keep their poll-and-retry shape (task rationale, "what must not
change"). The retro gates nothing — W1-T276's ruling that it stays BLOCKING (a bare
`await`, still wrapped in `sweepLightDuringRetro` so the light sweep keeps ticking
while it runs) is unchanged below — it only ever DELAYED reaching dispatch, by
costing a full poll interval before the next attempt even when this same tick's
`dispatchSet` (computed further down) would otherwise have had work to admit.
Falling through here — instead of restarting the loop — lets a tick that fires the
retro still reach dispatch selection/admission/`runOne` below, on the SAME tick,
with no invented reordering of the rungs still above this point (pause, freshness,
headroom, the cost/queue governor) and no change to any of their own gates.
```

## the dispatch set

Removed from `src/lib/daemon.ts` lines 4007-4025 at the base commit.

```text
W1-T343 — THE DISPATCH SET (ADOPTS drain.ts's LANE MACHINERY, NEVER A SECOND
IMPLEMENTATION). A console kick (`forcedNext`) always dispatches ALONE, bypassing
candidate selection entirely — it already ran the gauntlet (`assertRunnable`, above)
`isDispatchEligible` exists to apply, and folding a human's explicit "run this now" into
a concurrent batch alongside whatever the DAG scan would otherwise pick is a DIFFERENT
feature this task does not build.

Otherwise: `runnableCandidates(plan, isMerged, budget, dispatchOpts)` applies the EXACT
SAME `isDispatchEligible` chain `nextRunnable` does (the two are factored so they can
never drift — see drain.ts), and `partitionByFileOverlap` is the SAME pure predicate
`runDrainLanes` already composes it with (dispatch-overlap.ts) — neither is reimplemented
here. At `laneCount <= 1` (the SHIP-DARK default), `budget` is `1` UNCONDITIONALLY —
never sized by `wipLimit`/`openPrCount` — so `runnableCandidates` returns the SAME single
task `nextRunnable` would, via the SAME walk, firing the SAME callbacks in the SAME
order; and `partitionByFileOverlap` on a <=1-length list can never defer anything
(nothing is yet placed in `dispatch` to overlap against — see that function's own doc).
`dispatchSet` below is therefore BYTE-IDENTICAL, at `laneCount <= 1`, to `next` from
before this task, wrapped in an array — the safety property `DaemonOpts.laneCount`'s own
doc states.
```

## the auto-triage rung's placement

Removed from `src/lib/daemon.ts` lines 4064-4087 at the base commit.

```text
── AUTO-TRIAGE RUNG — RUNS BEFORE THE IDLE BRANCH (operator ruling, reversing W1-T469) ──
THE STARVED STATE IS THE IDLE STATE, WHICH IS WHY THIS MOVED AGAIN. W1-T469 placed this
AFTER the idle `continue` and justified it: a deferral implies a non-empty dispatch set, so
an idle tick could only ever reach "no deferral this pass". That reasoning was correct and
the GATE it served was circular — a deferral needs two eligible tasks to collide, so a fleet
with nothing eligible can never produce one, and the rung that CREATES work could only fire
when work already existed. MEASURED on a starved daemon: `auto_triage.skipped — no deferral
this pass` beside `dispatch.starvation.escalated — blocked: 5, unmet_deps: 3`, ~87 feedback
entries unread, thirteen hours.

So the second trigger — `dispatchCount < laneBudget`, the queue failing to fill free
capacity — is EXACTLY an idle-tick condition, and leaving the rung below the `continue`
would have shipped the new gate as dead code.

THE COST THIS ACCEPTS, STATED RATHER THAN DISCOVERED LATER. Running before the branch means
an idle tick now writes an `auto_triage.skipped` row whenever the interval or the cap holds
it: at a 60s poll and a 15m floor that is ~14 rows per fire, and `rotateLedger` retains
MAX_RETAINED_LINES_PER_STEP = 200 per step. That volume is the price of the rung reaching a
decision in the only state that needs it, and each row NAMES which bound held — which is
the diagnostic, not noise. If it proves too loud, dedupe on reason-change the way
`daemon.idle_reasons` already does above; do not solve it by moving this back down.
DEFAULT OFF and bounded by `minIntervalMinutes` + `maxPerDay` (lib/auto-triage.ts) — the
only two bounds left since W1-T475 deleted the adaptive curve. Best-effort in the retro's
idiom: a throw here costs one logged tick, never the daemon.
```

## the starvation predicate

Removed from `src/lib/daemon.ts` lines 4180-4196 at the base commit.

```text
── QUEUE STARVATION (recon oper#queue-starvation-2026-08-03) ──────────────
A FAILING run already escalates (`onCircuitBreak` above, once per tripped breaker) —
but until now a queue that has run OUT of dispatchable work was indistinguishable in
the ledger from a queue that is quietly healthy between tasks: both emitted only
`daemon.idle`. The census `idleReasons` already tallies is the data; this is the first
reader. STARVED := zero dispatchable (already true, this is the idle branch) AND at
least one task filtered by a RECOVERABLE class — circuit-broken, blocked, or
unmet-deps, each capable of clearing on its own without the plan changing.
`already-merged` and `verify-not-auto` are DELIBERATELY excluded: an all-merged plan
is DONE, not starved, and a verify:human task never becomes machine-dispatchable no
matter how long the daemon waits — counting either would misreport "nothing left to
do" or "everything needs a human anyway" as the SAME starvation this predicate exists
to name apart from. `retired` (W1-T2474) joins that same excluded set: a `blocked` task
carrying a retirement ruling is drain.ts's own record that it will never be built, so a
queue whose only remaining blockers are retired is DONE-BY-RULING, not starved — waiting
never helps it either. Named on the census below (never silently dropped) but never
counted toward `starved`.
```

## the pre-admission STOP and PAUSE re-check

Removed from `src/lib/daemon.ts` lines 4254-4269 at the base commit.

```text
RE-CHECK STOP/PAUSE IMMEDIATELY BEFORE ADMISSION (W1-T1065). `checkStop`/`checkPause`
above are each read EXACTLY ONCE, at the top of this tick — but `deps.checkFreshness`,
`await deps.sweep()` (the full reconciler over every open PR), `await deps.sweepOrphans()`,
`await deps.sweepFeedbackLanding()` and `await deps.readUsage()` all sit, awaited and
unbounded, between that read and here. MEASURED on the live ledger (this task's own
rationale): a `state/PAUSE` created 4.5 minutes after the top-of-tick read still dispatched
— the sweep-to-next-`daemon.iteration` gap runs p50 39.6s, p95 32.1m, max 64.5m, so the
top-of-tick read is stale by the time admission happens on any but the fastest ticks.
Re-reading the IDENTICAL deps here, immediately before this tick's batch is admitted,
closes that window without adding a new control: nothing has been admitted yet, so a hold
observed here defers the WHOLE `dispatchSet` computed above (discarded, never dispatched)
and returns to the top of the loop, where the ordinary stop/pause handling — including its
own sleep/heartbeat — takes over exactly as it would have on a top-of-tick read. This can
NEVER abort a lane already admitted or already running: `admitted` below is still empty at
this point, and `Promise.allSettled` (further down) is unreached — the drain-and-hold
guarantee for anything already in flight is completely untouched.
```

## admitted

Removed from `src/lib/daemon.ts` lines 4304-4312 at the base commit.

```text
W1-T342/W1-T343 — THE PER-LANE GOVERNOR GATE, adopted verbatim from `runDrainLanes`
(drain.ts, see its own doc). A SEQUENTIAL loop that takes its OWN fresh
`checkDispatchGovernors` reading per candidate — never one reading admitting the whole
batch — so a ceiling crossed between lane 1 and lane 2 refuses lane 2 without touching
lane 1 (`break` stops ADMITTING; it never revokes a lane already admitted). At
`dispatchSet.length === 1` (every `laneCount <= 1` tick) this loop runs exactly once,
taking exactly the one reading the pre-W1-T343 loop always took at this exact point in
the tick — the SAME provable no-op change in observable behaviour W1-T342 already
documented here, now discharged rather than merely promised.
```

## await

Removed from `src/lib/daemon.ts` lines 4353-4363 at the base commit.

```text
W1-T254 (the #707 fix) — LIGHT-SWEEP TICKER: while admitted lanes are
unbounded and in flight, tick the restricted light sweep on the SAME
injected clock/cadence idle polling uses, so a PR that goes
green-but-review-absent mid-batch re-posts within one poll interval
instead of sitting invisible until every lane finally returns. See
`DaemonDeps.sweepLight`'s doc for the full rationale.
Cleared once every admitted lane settles, on EVERY exit path (success, a fatal
throw, or a degraded spawn-infra throw) — never left running past it, and never
aborted mid-call (a sweepLight() already in flight is allowed to finish before
the ticker stops). It also emits this dispatch's `daemon.alive` liveness rows —
see {@link startInFlightTicker} for why that row exists and why it is prefixed.
```

## spawnInfraSeenThisTick

Removed from `src/lib/daemon.ts` lines 4404-4411 at the base commit.

```text
DEGRADE, DON'T DIE (W1-T113 part iii, the vanished-binary incident): a
spawn-INFRASTRUCTURE failure is never a fatal crash — the pre-fix shape
was error -> process exit -> launchd KeepAlive restart -> the identical
failure again, five consecutive polls, zero escalations, zero backoff.
Escalate ONCE per distinct cause (content-keyed, W1-T104 discipline) —
counted ONCE per TICK (not per lane) below, so a batch where two lanes hit
the SAME toolchain outage in the SAME tick backs off like one bad tick, not
two, preserving the backoff curve's "consecutive TICKS" meaning.
```

## crash recovery

Removed from `src/lib/daemon.ts` lines 4502-4523 at the base commit.

```text
── crash recovery (W1-T12c) ────────────────────────────────────────────────

A daemon killed mid-task (power loss, `kill -9`, a host reboot — the live
chaos drill is W1-T12d) can leave an ORPHANED local run behind: a
`git worktree` + its `run-<taskId>-<epochMs>` branch (worker.ts's
`runId = ${taskId}-${Date.now()}`, `branch = run-${runId}`) that no live
process owns anymore (its inflight-lock.ts pid is dead). Discovering that
debris is a real filesystem/`git worktree list` walk — the CLI wiring's job
(same boundary as worker.ts's `pruneStaleRuns`), and OUT of scope here; this
pure module only reasons about the parsed result.

The one question crash recovery must answer per orphan is: does GitHub know
about work this task already did? A dead local process is NOT authoritative
— an open PR may already exist (pushed right before the crash), and
blindly re-running the task from `nextRunnable` would spawn a SECOND worker
on top of it UNLESS the caller wires the `isOpenPr` in-flight guard (W1-T80,
the #143/#145 duplicate-build race) — belt-and-suspenders here: crash
recovery reasons about the orphan directly rather than depending on that
guard alone. So state is reconstructed from git (which task/run the orphan belonged to)
+ GitHub + the ledger (status.ts's `deriveStatus`, reused wholesale, never
reimplemented — same three-source precedence `rmd drain`/`rmd run-task`
already trust) — never from the dead process's local state.
```

## parseOrphanedBranch

Removed from `src/lib/daemon.ts` lines 4545-4552 at the base commit.

```text
Parse a `run-<taskId>-<epochMs>` branch name back into its task + run id.
Splits at the LAST `-` (task ids may themselves contain hyphens, e.g.
`W1-T12c`), only accepting the split when the trailing segment is all
digits (an epoch-ms timestamp) — anything else (a retro/review run's
branch, e.g. `run-RETRO-<epochMs>` or `run-review-PR9-<epochMs>`, which is
not task-scoped) is not an orphaned TASK run and returns null.
```

## reconstructOrphan

Removed from `src/lib/daemon.ts` lines 4565-4580 at the base commit.

```text
Reconstruct ONE orphan's fate from its task's GitHub-derived projection.
`deriveTaskStatus` is the caller's `status.ts` `deriveStatus`, scoped to
this task id — this function adds NO new GitHub/ledger logic, it only maps
the EXISTING precedence-derived projection onto a recovery verb:

  - status `running` (an OPEN PR) ⇒ "resume": GitHub, not the dead local
    process, is the task's true state. The orphaned worktree/branch is left
    untouched (not cleaned) — it is the original working tree behind that
    PR, in case anything downstream needs it.
  - `merged`, `blocked` (PR closed without merging), or no evidence at all
    ⇒ "clean": the task is either already done, or never produced a
    surviving GitHub artifact — either way the local worktree/branch is
    pure debris. When not merged, the task is left for `nextRunnable` to
    pick up fresh (a normal, from-scratch run) on the daemon's next tick.
```
