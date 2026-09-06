# deployer.ts forensics

Measured incidents, design arguments and rejected alternatives removed from `src/lib/deployer.ts`
when its comments were compacted to the plain-language standard (docs/comment-standard.md).
Nothing was cut: each section below is the file's own prose, verbatim, under a heading naming the
symbol or block it explained. The file itself keeps a one-line `// Why:` pointer wherever the
history mattered.

Every block below is reproduced from the source at the base commit
(49e429e305c662712b2ee5d653613357a2e03c40, the `origin/main` head this compaction started from).
Only the comment markers (`/**`, ` * `, `//`) were stripped; no wording was changed. Line numbers
are positions in `src/lib/deployer.ts` at that commit.

## Contents

- [The file header](#the-file-header) — lines 1-29
- [TriggerInputs.lastFailedKind](#triggerinputslastfailedkind) — lines 52-60
- [TriggerInputs.daemonAlive](#triggerinputsdaemonalive) — lines 62-66
- [TriggerInputs.stopPresent](#triggerinputsstoppresent) — lines 68-73
- [TriggerInputs.runningHead](#triggerinputsrunninghead) — lines 74-80
- [Decision.satisfied](#decisionsatisfied) — lines 86-95
- [decideDeployTrigger](#decidedeploytrigger) — lines 114-132
- [decideDeployTrigger (liveness)](#decidedeploytrigger-liveness) — lines 139-157
- [IdleProbe.unreadable](#idleprobeunreadable) — lines 191-206
- [daemonIsIdle — UNKNOWN IS NOT IDLE](#daemonisidle--unknown-is-not-idle) — lines 215-218
- [pgrepFailureMeansZero](#pgrepfailuremeanszero) — lines 223-230
- [lockReadFailureMeansZero](#lockreadfailuremeanszero) — lines 235-241
- [DEPLOY_IDLE_DEFER_CEILING_MS](#deploy_idle_defer_ceiling_ms) — lines 246-276
- [evaluateIdleGate](#evaluateidlegate) — lines 291-303
- [treeFfSafe](#treeffsafe) — lines 355-373
- [countLedgerBootsAfter](#countledgerbootsafter) — lines 404-413
- [readLatestBootSha](#readlatestbootsha) — lines 428-433
- [readLastGoodBootSha](#readlastgoodbootsha) — lines 448-478
- [restartConsole (and the misplaced runDeployCycle doc above it)](#restartconsole) — lines 617-647
- [runDeployCycle — the up-to-date skip (W1-T1239)](#rundeploycycle--the-up-to-date-skip-w1-t1239) — lines 693-700
- [runDeployCycle — the lossless discard](#rundeploycycle--the-lossless-discard) — lines 724-727
- [runDeployCycle — the deferral-ceiling idle gate](#rundeploycycle--the-deferral-ceiling-idle-gate) — lines 733-736
- [runDeployCycle — the forced-ceiling log](#rundeploycycle--the-forced-ceiling-log) — lines 754-758
- [runDeployCycle — the re-check race](#rundeploycycle--the-re-check-race) — lines 765-769
- [runDeployCycle — the dry-run deferral bug](#rundeploycycle--the-dry-run-deferral-bug) — lines 794-807
- [runDeployCycle — clearing the deferral before kickstart](#rundeploycycle--clearing-the-deferral-before-kickstart) — lines 813-817
- [runDeployCycle — the rollback anchor](#rundeploycycle--the-rollback-anchor) — lines 842-851
- [runDeployCycle — the rollback anchor field](#rundeploycycle--the-rollback-anchor-field) — lines 861-863
- [DeployDeps — the deferral-ceiling fields](#deploydeps--the-deferral-ceiling-fields) — lines 559-564
- [DeployDeps — the console-restart fields](#deploydeps--the-console-restart-fields) — lines 573-577
- [realDeployDeps (module doc, orphaned above buildDeployLogger)](#realdeploydeps-module-doc) — lines 936-943
- [buildDeployLogger](#builddeploylogger) — lines 945-964

## The file header

Removed from lines 1-29.

```text
lib/deployer.ts — the OUT-OF-PROCESS deploy supervisor's decision core.

WHY THIS EXISTS. The daemon runs `tsx src/…` loaded once at start and dispatches
IN-PROCESS (daemon.ts awaits runTask), so a merged fix on origin/main is INERT
until a full restart — and `KeepAlive{SuccessfulExit:false}` makes a clean
self-restart impossible. Rather than drag the daemon into self-restart mechanics
it handles badly, a SEPARATE launchd job runs this supervisor: it fast-forwards
the daemon's own checkout and `launchctl kickstart -k`s the daemon — the exact
manual redeploy, automated, with the daemon itself NEVER modified.

GOVERNANCE (why the defaults are conservative):
 - HUMAN-GATED by default: deploy only when an operator set a marker (`rmd deploy`
   → state/DEPLOY_REQUESTED) AND the install is behind origin/main. Craig gates
   MERGES today; auto-deploy-on-every-merge would silently collapse that gate, so
   it is an explicit opt-in (`auto`) and only ever runs behind the health check.
 - IDLE-GATED restart: the restart is the dangerous half (in-process dispatch ⇒ a
   mid-task restart SIGKILLs the worker — the #559/#581 orphan class). The pull is
   safe anytime; the kickstart runs ONLY at a verified idle gap, re-checked in the
   same breath as the kickstart to close the poll race.
 - HEALTH-CHECK + ROLLBACK: a bad merge CI didn't catch must degrade to "last-good
   daemon running + alert", never a restart-storm. After kickstart the supervisor
   confirms a healthy boot; on crash-loop it rolls the checkout back to the prior
   HEAD, restores the known-good daemon, and alerts.

Every side effect (git, launchctl, process probes, clock, fs) is injected via
{@link DeployDeps} so the whole sequence is unit-testable WITHOUT touching the
live daemon, and the real kickstart is additionally gated behind `dryRun`.
```

## TriggerInputs.lastFailedKind

Removed from lines 52-60.

```text
WHY that head failed, so the skip message states the real cause. Two very different failures
write `lastFailedHead`, and until this existed the skip line hardcoded the health-check
wording for both — so a deploy stuck on a dirty tree reported "failed health-check + rolled
back" when no health-check had run and nothing had been rolled back. That sends the next
diagnosis at the wrong subsystem entirely; it cost a live investigation on 2026-08-02, where
the true cause sat in `state/DEPLOY_FAILED` the whole time. Undefined for records written
before this shipped — rendered as "reason not recorded", never guessed.
```

## TriggerInputs.daemonAlive

Removed from lines 62-66.

```text
Is the daemon process actually alive? `undefined` ⇒ not observed, and the trigger then neither
restarts on liveness nor claims the daemon is running. Only an explicit `false` can trigger the
liveness restart, so a caller that cannot probe degrades to exactly today's behaviour.
```

## TriggerInputs.stopPresent

Removed from lines 68-73.

```text
Is a STOP marker set? `undefined` ⇒ unknown, treated as PRESENT (fail-safe) — see
{@link decideDeployTrigger}. A deliberately halted fleet must never be restarted into its own
refusal.
```

## TriggerInputs.runningHead

Removed from lines 74-80.

```text
The sha the DAEMON PROCESS IS ACTUALLY EXECUTING, captured at ITS boot from the code it
loaded — never re-read from the checkout at comparison time (that always matches, which is
the bug this field exists to fix). `undefined` when no daemon has recorded one yet, i.e. the
running daemon booted before this shipped; see {@link decideDeployTrigger} for the polarity.
```

## Decision.satisfied

Removed from lines 86-95.

```text
Set ONLY on the `up-to-date` skip (never re-derived from `reason` — the two up-to-date
wordings at `:157-158` differ by exactly this fact, and string-matching English is the shape
that breaks the next time the sentence is edited). `true` iff the checkout already matches
origin/main AND the running daemon's liveness was OBSERVED alive: a request satisfied by that
fleet state is done and safe to consume. Liveness unobserved (`false` or `undefined`) leaves
this `undefined` — a dead-or-unknown daemon under, say, a STOP marker must not have an
operator's request silently discarded out from under it; see runDeployCycle's skip branch.
```

## decideDeployTrigger

Removed from lines 114-132.

```text
Deploy IFF a trigger is present AND the fleet is not already running the checkout's code.

THE DEFECT THIS FIXES: this used to compare the CHECKOUT against origin only, so anything that
fast-forwarded the checkout first — an operator `git pull`, an agent's pull, or rmd's own
self-sync — consumed the trigger and the restart never happened. The daemon then ran stale code
against a current checkout indefinitely, silently (observed live 2026-08-01: checkout ff'd to
a0d96a9 at 21:44:29, 12 consecutive "no-op: up-to-date" cycles, console still on 3f6a1d1).

So there are now TWO independent reasons to act, and either suffices:
  BEHIND       — the checkout itself is behind origin/main (needs fast-forward + restart).
  RUNNING STALE — the checkout is current but the running daemon is not on it (restart only).

UNKNOWN running sha ⇒ treated as STALE (fail-EAGER). A daemon that booted before this shipped
records nothing, and fail-safe would mean the fix could never take effect until something else
restarted the daemon — which is precisely the gap being closed. Fail-eager costs exactly ONE
extra restart, taken at an idle gap the gate already enforces, and it is self-correcting: that
restart records a sha, and every later cycle compares cleanly.
```

## decideDeployTrigger (liveness)

Removed from lines 139-157.

```text
LIVENESS, CHECKED BEFORE THE SHA SHORT-CIRCUIT — because that short-circuit is exactly what
hides a corpse. Everything below this point reasons only about SHAS, and a dead daemon's last
recorded boot sha still equals the checkout, so the `up-to-date` branch would report
"daemon running it" forever over a process that exited. That clause was an ASSUMPTION with
nothing behind it (recon-GF).

THE PATH THIS CLOSES — the reversible stop. `daemonExitCode` (lib/daemon.ts) maps `stopped`
and `max_reached` to 0, and the daemon's KeepAlive is `{SuccessfulExit: false}`, so a clean
exit is NOT restarted by launchd. That is correct while a STOP marker is present. But when the
operator REMOVES the marker, nothing brings the daemon back: launchd will not (the exit was
successful) and the trigger would not (the shas still match). The fleet stays silently dead
while this very function reports health every 120 seconds.

GATED ON `stopPresent`, and that gate is the whole safety argument. Restarting a daemon whose
STOP marker is still down would relaunch it straight back into the same refusal — a relaunch
storm, the class this repo has already paid for twice (~86s headroom, ~10s on 2026-07-22).
`stopPresent === undefined` means the caller could not read the marker; that is treated as
PRESENT (fail-safe), because guessing "no STOP" is what starts the storm.
```

## IdleProbe.unreadable

Removed from lines 191-206.

```text
The signals whose READ FAILED, named — never folded into the counts above.

THIS REPO'S OWN LAW, stated in `buildShellRoute`: "A read failure degrades to UNKNOWN, never
to zero." Every one of the three reads below used to catch into `0`, and all three of those
zeros feed {@link daemonIsIdle}, whose TRUE answer is the gate that lets a deploy kickstart
the daemon. A probe that cannot see the daemon must not be able to report that the daemon is
quiet.

OPTIONAL and ABSENT-MEANS-EVERYTHING-WAS-READ, so every existing {@link IdleProbe} literal is
unchanged and a genuinely idle fleet still reads idle byte-identically. The spelling follows
the house one — `listMergedHeadBranches` returns null for a FAILED read and `[]` for
genuinely-none — applied to three signals at once, which is why it names them rather than
being a bare boolean: the ledger line should say WHICH read failed.
```

## daemonIsIdle — UNKNOWN IS NOT IDLE

Removed from lines 215-218.

```text
UNKNOWN IS NOT IDLE. Deferring costs a bounded delay — {@link DEPLOY_IDLE_DEFER_CEILING_MS}
forces the deploy through after 30 minutes and LEDGERS it as forced, so an unreadable signal
can never wedge the fleet. Deploying into a live daemon costs a SIGKILLed worker. Those are
not symmetric, and the ceiling is what makes the safe direction affordable.
```

## pgrepFailureMeansZero

Removed from lines 223-230.

```text
Does this `pgrep` failure mean "nothing matched" — a TRUE zero — or "the read did not happen"?

`pgrep` documents exit 1 as no-processes-matched, and the original catch cited exactly that.
What it also swallowed: exit 127 / ENOENT, which is the binary being ABSENT — the state this
image shipped in until `ps`/`pgrep` were added — and pgrep's own fatal exits (2 = syntax, 3 =
fatal). Those are reads that produced no answer, and calling them zero workers is the defect.
```

## lockReadFailureMeansZero

Removed from lines 235-241.

```text
Does this `readdirSync` failure mean the directory genuinely holds no locks?

ENOENT does: a lock directory that has never been created holds no locks, and reporting zero is
correct. EACCES, ENOTDIR, EIO and EMFILE do not — the directory may be full of locks nobody
could count.
```

## DEPLOY_IDLE_DEFER_CEILING_MS

Removed from lines 246-276.

```text
W1-T341 — THE CEILING. `daemonIsIdle` conjoins GLOBAL fleet counters, so more concurrent
lanes make a common quiet window rarer without bounding how long the deploy path may keep
skipping while it waits for one. At N=1 that was tolerable (the daemon is idle roughly 60%
of the time — 20 consecutive dispatch gaps of 45-90 minutes against ~25-minute runs), so a
quiet window always arrived on its own; parallelism spends exactly that slack, so the same
gate that was merely slow at N=1 can defer indefinitely once lanes are dense.

30 MINUTES: comfortably above a typical single-lane run (~25 minutes, the operator's own
measurement), so the ceiling essentially never interrupts a lane finishing on its own
schedule — while staying a full order of magnitude below the "wait for ALL lanes to go
quiet" behaviour this replaces, so a merged fix is bounded to roughly one run's worth of
latency instead of an unbounded one. Too short would abort real work mid-run for no gain
(the pull is already safe and inert; only the RESTART is dangerous); too long reproduces
today's defect exactly.

A forced deploy is not free: the kickstart SIGKILLs whatever is still running (the daemon
dispatches IN-PROCESS — see this file's banner), and that is only survivable because of a
mechanism this task does NOT add: daemon.ts's boot-time crash-recovery pass
(`reconstructState`/`reconstructOrphan`, W1-T12c) runs unconditionally on every daemon boot,
resumes any orphaned run that already has an open PR, and safely re-dispatches (via
`nextRunnable`) anything that does not — so the abandoned run is re-dispatched, never
silently lost. Silently losing paid work would be unacceptable; this ceiling is only correct
BECAUSE that recovery path already exists and runs on every boot, kickstart included.

THE CONDITION AT N>1 IS UNCHANGED — this is a deliberate, minimal-scope choice: `daemonIsIdle`
still means "every lane is quiet" (lane-scoped thresholds are W1-T343's concern, out of scope
here). The bound alone carries the N>1 case: at any lane count the deploy still fires within
`ceilingMs` even if the fleet is never fully quiet, at the cost of a forced restart under
those (rare, bounded) circumstances instead of a lane-aware quiet check.
```

## evaluateIdleGate

Removed from lines 291-303.

```text
{@link daemonIsIdle} WITH a ceiling (W1-T341's falsifier, both directions):
 - a fleet that NEVER goes idle still gets `proceed: true` once `waitedMs >= ceilingMs`
   (`forced: true`) — the unbounded-wait defect this replaces.
 - a fleet that goes idle BEFORE the ceiling proceeds immediately (`forced: false`) — the
   ceiling is a maximum wait, never a delay imposed on every deploy.

`deferredSinceMs === undefined` (no deferral tracked yet — including a caller that never
wires {@link DeployDeps.deferredSince}/`setDeferredSince`) reads as a FRESH deferral:
`waitedMs = 0`, which can never alone reach the ceiling. A caller that does not wire
persistence therefore cannot be regressed into a surprise forced deploy — it degrades to
exactly today's unbounded wait, never the other direction.
```

## treeFfSafe

Removed from lines 355-373.

```text
Fast-forward is safe IFF no locally-modified file is ALSO in the incoming diff *with different
content*. A benign local mod the ff doesn't touch (e.g. DECISIONS.md) is preserved; a genuinely
divergent file would abort git, so we abort + alert first and NEVER force/reset the checkout.

THE DEADLOCK THIS FIXES (observed live 2026-08-02, and once before on 2026-07-31). The daemon
writes into its OWN checkout — `plan/feedback/*.yaml` alert-intake records are its exhaust. A
filing PR then commits that same exhaust to main. Now the fast-forward wants to create paths the
daemon has already written locally, git refuses to clobber them, and the deploy aborts — so the
daemon's own output blocks it from pulling the commit that CONTAINS that output. Each abort
re-arms the never-retry latch, and the install sticks until an operator intervenes by hand. It
stuck for five commits and roughly two hours before anyone noticed, because the only symptom is
a fleet that quietly stops building.

The resolution is not to force: it is to notice that a local file identical to the incoming blob
is not a conflict at all. Byte-identity is the whole safety argument — discarding such a file
cannot lose information, because the very next operation writes those same bytes back. Anything
that differs by even one byte still aborts, untouched.
```

## countLedgerBootsAfter

Removed from lines 404-413.

```text
Count `daemon.boot` ledger lines timestamped strictly after `sinceMs`. Extracted as a
standalone, exported, pure-over-the-file function (W1-T244) so a test can assert this
reads IDENTICALLY before and after a ledger rotation — the false-negative that rolled
back a healthy 7abe870 deploy at 00:19Z (feedback fb-1784769525147-13afc6) was exactly
this read silently going to zero because `daemon.boot` wasn't retained across rotation;
see `DECISION_RELEVANT_LEDGER_STEPS`'s companion health-window retention in ledger.ts.
A raw substring/regex scan, not JSON.parse + `.step ===` — matches this file's own
pre-existing read shape, kept unchanged by this extraction. Absent ledger ⇒ 0 boots.
```

## readLatestBootSha

Removed from lines 428-433.

```text
The `head_sha` on the MOST RECENT `daemon.boot` line — the sha the running daemon loaded at its
boot. Scans forward and keeps the last hit, because the ledger is append-only so the last boot
line is the current process's. `undefined` when no boot line carries one (a daemon that booted
before this field shipped), which {@link decideDeployTrigger} treats as stale.
```

## readLastGoodBootSha

Removed from lines 448-478.

```text
The newest `daemon.boot` `head_sha` that is NOT `excludeSha` — a sha this daemon is OBSERVED to
have booted on, for {@link runDeployCycle}'s rollback target.

WHY THIS EXISTS, measured: the rollback used to reset to `deps.installHead()` read at the top of
the cycle. That is not a known-good sha, it is just *whatever the checkout currently points at*,
and the checkout is mutable shared state with a second writer — `checkCliFreshness`
(lib/self-sync.ts) fast-forwards the install to origin/main at the entry of EVERY `rmd`
subcommand except daemon/serve/deploy-run, and logs nothing when it does. So a broken head that
merged could be pulled into the install by any unrelated `rmd` invocation BEFORE the deploy cycle
ran; `fromHead` then already WAS the broken head, and the rollback reset to the thing it was
rolling back from. Observed 2026-08-05: seven consecutive `deploy.unhealthy_rollback` rows each
recording `rolling_back_to == failed == a8e11cb`, the daemon down 53 minutes, recovered only when
an unrelated fix commit merged.

A boot line is the strongest evidence available that a sha is runnable: the daemon reached its
own logging. A head that cannot boot never writes one, which is exactly why the broken sha is
absent from this scan and the last healthy one is not. `excludeSha` guards the one case where the
failed sha DID write a boot line before dying (a daemon that starts, logs, then crashes).

`undefined` when nothing qualifies — no ledger, no boot line carrying `head_sha` (they predate
that field), or every candidate is `excludeSha`. Callers MUST fall back rather than treat
`undefined` as "roll back to nothing"; see {@link runDeployCycle}'s rollback branch.

ROTATION: `daemon.boot` is retained by `isHealthOrDeployStep`/`HEALTH_STEP_RETENTION_WINDOW_MS`
(lib/ledger.ts) for 15 minutes, comfortably longer than a deploy cycle's kickstart-to-health
window, but a last-good boot older than that can be archived out of the live file. That degrades
to `undefined` and therefore to the previous behaviour — never to a worse target. Deliberately
reads the live ledger ONLY, matching `readLatestBootSha`/`countLedgerBootsAfter` above: this runs
on a 120-second supervisor cycle and must not walk ~665 rotations.
```

## restartConsole

Removed from lines 617-647 (the misplaced doc comment at 617-621 sat directly above this one in
the source, describing `runDeployCycle` even though `restartConsole` — declared earlier in the
file — comes first; both are reproduced here together).

```text
Run ONE supervisor cycle. Safe to call on an interval: it no-ops unless a trigger
is present AND the install is behind AND the daemon is idle; it restarts only at a
verified idle gap; and it self-heals a bad deploy via rollback. Never throws for a
routine no-op — only a genuinely broken injected dep would propagate.

---

Restart the console AFTER a deploy has been verified healthy, and ledger the outcome.

WHY HERE AND NOWHERE EARLIER — this ordering is the whole safety argument:

 1. TRAP 1 (shared node_modules). `rmd daemon` AND `rmd serve` both run
    `serviceFreshnessGate` (run-task.ts, the `cmd === "daemon" || cmd === "serve"` branch),
    whose last line is `ensureInstallFresh` — a real `npm ci` when the lockfile hash moved.
    One node_modules is shared by both, with no lock, and emptying it under a running
    service is exactly what crash-looped this host once already. The gate runs at command
    dispatch, BEFORE the daemon's own `daemon.boot` heartbeat (daemon.ts). `assessBootHealth`
    refuses to call a deploy healthy without observing that heartbeat. So by the time we get
    here, the daemon's install has provably finished — the restarts cannot overlap. This is
    ordering, not luck, and `deploy-cycle-console.test.ts` asserts the sequence.
 2. Never restart the console onto code that is about to be rolled back. The rollback path
    resets the tree and re-kickstarts the DAEMON; a console started before the health verdict
    would be left running the reverted-away code with nothing to restart it.

A CONSOLE FAILURE DOES NOT ROLL BACK MAIN, deliberately. The daemon — the thing that does the
work — is healthy on the new code; reverting it because a display surface did not come back
would trade a working fleet for a working page. The serve job carries unconditional
`KeepAlive` with a 60s ThrottleInterval, so launchd keeps trying on its own. What this owes
the operator is not a rollback but NOISE: a loud ledger line and an alert that does NOT poison
the failed-HEAD marker (see {@link DeployDeps.alertConsoleOnly}).
```

## runDeployCycle — the up-to-date skip (W1-T1239)

Removed from lines 693-700.

```text
W1-T1239: the `up-to-date` skip is the one outcome no later tick will ever revisit — a
request it satisfies must be CONSUMED here (via the existing clearMarker(), never a new
writer) or it strands as a level trigger that pre-authorises the next deploy (decideDeployTrigger
:161, `markerPresent` — above the auto-mode arms). Every OTHER skip (dirty tree, not-idle,
dry-run — none of which reach this branch; and the human-gated/already-failed skips below,
which never see a marker here because :161 already claimed it) must leave the marker exactly
as it found it, which is why this is gated on `decision.satisfied`, DATA from
decideDeployTrigger, rather than re-derived by matching `reason` text.
```

## runDeployCycle — the lossless discard

Removed from lines 724-727.

```text
Lossless unblock: these overlap the incoming diff but already hold exactly the bytes the ff
would write, so dropping them cannot lose anything — and NOT dropping them deadlocks the
daemon against its own exhaust (see treeFfSafe). Logged by name: a silent discard would be
indistinguishable from the force-reset this deliberately is not.
```

## runDeployCycle — the deferral-ceiling idle gate

Removed from lines 733-736.

```text
Idle gate, WITH A DEFERRAL CEILING (W1-T341) — the pull is safe anytime, but hold if a
task is in flight so we don't pull-then-fail-to-restart repeatedly UNLESS the deferral has
outlasted `ceilingMs`, in which case we proceed anyway rather than defer indefinitely. See
evaluateIdleGate / DEPLOY_IDLE_DEFER_CEILING_MS for the falsifier both directions cover.
```

## runDeployCycle — the forced-ceiling log

Removed from lines 754-758.

```text
Not a quiet fleet — the ceiling fired. Honest about what that costs: the kickstart below
(once we get there) SIGKILLs any in-flight worker; see DEPLOY_IDLE_DEFER_CEILING_MS's doc
for why that is survivable (daemon.ts's boot-time crash-recovery pass, W1-T12c).
```

## runDeployCycle — the re-check race

Removed from lines 765-769.

```text
RE-CHECK idle in the same breath as the kickstart (poll-race mitigation): a task
may have dispatched since the pre-pull check. The pull is already on disk but
INERT (daemon still on old code), so aborting here is safe — retry the restart
next tick. Same persisted clock: it is one continuous deferral regardless of which
check catches it.
```

## runDeployCycle — the dry-run deferral bug

Removed from lines 794-807.

```text
W1-T380: A DEFERRAL EPISODE IS ENDED ONLY BY A CYCLE THAT ACTUALLY RESTARTS, so this branch
returns with the persisted clock INTACT and the next real cycle inherits the accumulated wait.
The clear used to sit ABOVE this check, under the comment "the deferral episode is over either
way" — but a dry-run never reaches `deps.kickstart()`, so a dry-run that won the race to the
ceiling ended the episode and delivered nothing. Observed 2026-08-05T22:43:42Z: forced at
waited_ms 1843684, pulled, logged `deploy.dry_run`, and 16s later `deploy.not_idle waited_ms=0`
— the clock reset with the daemon still on its old sha, and a merged PR sat undelivered for
over an hour while a second episode climbed from zero. THE CEILING WORKED; this branch threw
its result away while consuming the entitlement that would have forced the next one.
Same shape as the `!gate2.proceed` return above (`pulledPendingRestart`), and for the same
reason: pulled, not restarted, so the episode is still open. The pull itself is deliberately
unchanged — "the pull is already safe and inert; only the RESTART is dangerous".
`retained_wait_ms` is on the row because `would_kickstart: true` alone reads as success while a
delivery was dropped; a reader must be able to see the episode is still open.
```

## runDeployCycle — clearing the deferral before kickstart

Removed from lines 813-817.

```text
Genuinely idle, or the ceiling carried it — and THIS cycle is restarting, so the episode ends.
Kept ABOVE `deps.kickstart()` deliberately: a real cycle must clear unconditionally, or the
clock never resets and every later tick forces a SIGKILL restart into `reconstructOrphan`, a
path never exercised in production. That overcorrection is what this task's second criterion
locks, against the PERSISTED value rather than a spy on the call.
```

## runDeployCycle — the rollback anchor

Removed from lines 842-851.

```text
ROLLBACK — restore a head the daemon is OBSERVED to have booted on, alert, never leave a
crash-looping daemon live.

The target is NOT `fromHead`. `fromHead` is `installHead()` read at the top of this cycle, and
the install checkout has a second, unlogged writer — `checkCliFreshness` (lib/self-sync.ts)
fast-forwards it at the entry of nearly every `rmd` subcommand. When that happens between a bad
head merging and this cycle running, `fromHead` IS the bad head and `resetHard(fromHead)`
restores the failure. That is not hypothetical: 2026-08-05 logged seven consecutive rollbacks
with `rolling_back_to == failed`, and the fleet stayed down 53 minutes because none of them
moved the tree. See {@link readLastGoodBootSha}.

`fromHead` remains the fallback when no booted sha is known (no ledger, boot lines predating
`head_sha`, or rotation aged the last good one out): the previous behaviour, never worse.
```

## runDeployCycle — the rollback anchor field

Removed from lines 861-863.

```text
Distinguishes a rollback aimed by observed evidence from one that fell back to the install's
own head — the latter is the shape that silently did nothing, so it must be legible in the
ledger rather than inferred from two shas happening to match.
```

## DeployDeps — the deferral-ceiling fields

Removed from lines 559-564.

```text
── DEFERRAL CEILING (W1-T341) ───────────────────────────────────────────────
`runDeployCycle` runs as a fresh launchd one-shot every ~120s (see this file's banner) —
no in-memory continuity across cycles — so bounding the idle-gate wait needs its OWN
persisted "since when has this deploy been deferred" clock. All three are OPTIONAL: a
caller that omits them degrades to `waitedMs` always reading 0 (see {@link evaluateIdleGate}),
i.e. exactly today's unbounded wait — never the other direction.
```

## DeployDeps — the console-restart fields

Removed from lines 573-577.

```text
── CONSOLE RESTART (the gap impl-BW/impl-BX both reported) ────────────────────
`rmd serve` loads its code ONCE via tsx, so the running console keeps executing
whatever was on disk when it last started. The console was commissioned 2026-07-29
and served that code through every merge for two days — including a GraphQL board
fetch that had already been fixed on main — until the operator restarted it by hand.
```

## realDeployDeps (module doc)

Removed from lines 936-943. In the base commit this comment sat directly above
`buildDeployLogger` (a code-churn artifact — the orphaned-prose shape docs/comment-standard.md's
own worked examples describe), even though its content describes `realDeployDeps`, declared
further down; the compacted replacement was moved to sit directly above `realDeployDeps`.

```text
Wire {@link runDeployCycle}'s side effects to the real world (every subprocess via
one injectable `execFile`, every file op via node:fs against `stateRoot`, so the
whole adapter is unit-testable without a real daemon/git/launchctl). The one
non-obvious bit is health: after kickstart we watch the ledger for `daemon.boot`
heartbeats newer than the kickstart instant — exactly ONE means a clean boot;
SEVERAL in the window means KeepAlive is restart-storming a broken daemon
(crashCount = extra boots). Absent-and-none means it never came up.
```

## buildDeployLogger

Removed from lines 945-964.

```text
The deploy cycle's logger — stdout AND the ledger (impl-EP).

`deployer.ts` already emits `deploy.abort_dirty_tree` with the conflicting paths named, and
`ledger.ts`'s HEALTH_RELEVANT_LEDGER_STEP_PREFIXES already retains every `deploy.*` step through
rotation. But this logger only ever wrote to `console.log`, so all of it landed in
`supervisor.out.log` and NONE of it in the ledger — which is why 107 dirty-tree aborts left ZERO
ledger rows across 663 rotations, and much of why the defect survived eleven days and six
investigations. `ledgerPath` was already being passed to `realDeployDeps` and simply unused here.

NOTHING IS ADDED TO `DECISION_RELEVANT_LEDGER_STEPS`: membership there is for steps a DECISION
consults, and `sweep.absent_repush` is the cautionary case — sitting in that set while occurring
zero times. `deploy.*` is already covered by `ledger.ts`'s health-window PREFIX rule, which is the
correct retention for an observability step.

BEST-EFFORT: a deploy must never fail because its own logging could not write.

Extracted rather than inlined so it is directly testable — a closure inside `deployRunCommand`
cannot be reached without running a real deploy cycle.
```
