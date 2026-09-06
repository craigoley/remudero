# recovery-drill.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/recovery-drill.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol or exercise it explained. The file itself keeps a one-line
`// Why:` pointer wherever the history mattered.

Line numbers below are positions in `scripts/recovery-drill.mjs` at the merge base of the
compaction PR.

## The file header

Removed from lines 3-128.

WHY. The deploy rollback (lib/deployer.ts's `runDeployCycle`) ran 0-for-7 the first time it
mattered, after 130 successful deploys never needed it (2026-08-05, seven consecutive
`deploy.unhealthy_rollback` ledger rows, the fleet down 53 minutes). Every static instrument this
repo has — SHIPS-UNWIRED ("does anything call this?"), W1-T365's proof rule ("does production
decline to use it?"), coverage itself ("did a test run this line?") — answered YES the whole time.
"This branch has never executed in production" is a RUNTIME FACT ABOUT PRODUCTION, not a property
of any changeset, so no static proof rule reaches it. Only running the code, on a cadence, closes
the gap — the same reasoning `clock-sweep.mjs` already establishes for wall-clock drift, followed
here rather than re-invented.

THE POPULATION (established from source, not copied from a note). A path qualifies when it (a)
exists to recover from a failure, (b) is not exercised by the ordinary success path, and (c) has an
observable outcome that can be asserted. All four confirmed against every clause:

  1. DEPLOY ROLLBACK — lib/deployer.ts `runDeployCycle`'s unhealthy-rollback branch.
     (a) restores a known-good sha after a bad deploy fails its health check.
     (b) the ordinary success path never calls `resetHard` at all.
     (c) the resulting git HEAD, independently re-read with `git rev-parse` — never merely
         trusted from the function's own return value.
  2. DISPATCH CIRCUIT BREAKER RESET — lib/status.ts `evaluateDispatchBreaker`'s reset-on-
     forward-progress branch (`dispatchesWithoutNewOwnedPr` zeroing on a `pr.opened` line).
     (a) un-sticks a task the breaker parked after repeated no-op dispatches, once real
         progress resumes.
     (b) the steady state (a task dispatched once or twice) never approaches the breaker at
         all, let alone its reset.
     (c) the tri-state verdict (`tripped`/`clear`/`indeterminate`), re-derived fresh from a
         real ledger file on disk.
  3. STALE-LOCK RECLAIM — lib/fs-race-safe.ts `reclaimStaleLock`, whose own comment records
     an ext4 inode-reuse TOCTOU it had to close.
     (a) clears a lock abandoned by a dead holder so a later acquirer is not wedged forever.
     (b) a live process's own lock is never reclaimed by the ordinary path — only a genuinely
         dead holder's is, which is rare by construction.
     (c) the lock file's real on-disk presence/absence after the call, independently checked.
  4. WORKER KEYCHAIN RE-PROVISION — lib/worker-home.ts `ensureWorkerKeychain`'s provisioning
     branch (absent / identity-changed / credential-expired).
     (a) restores a headless spawn's ability to authenticate after the copied credential goes
         stale, without which every spawn on the host fails "Not logged in" at $0.
     (b) the steady-state read (present, identity-matching, unexpired store) is the path
         nearly every call takes, and never touches provisioning at all.
     (c) `provisioned`/`reason` in the returned summary, plus the store file's real presence.

No candidate fails (c) — none is dropped from this drill.

THE POPULATION WIDENED (W1-T938): four RECOVERY paths were never the whole claim — a fleet also
survives on its GUARDS, the refusals and degrades that never let a fault become an incident in the
first place, and none of those had ever run on a cadence either, only in the incidents that
discovered them. So this instrument's honest name is no longer "recovery paths" — it is THE PATHS
THAT CARRY A FLEET PAST A FAILURE, recovery and guard alike, and the five entries below join the
table on the SAME (a)/(b)/(c) qualification, never a second scheduler or a second drill:

  5. SPAWN PREFLIGHT HUSK — worker.ts `resolveClaudeExecutable`'s executability probe (W1-T901).
     (a) refuses cleanly, naming the EACCES reason, rather than crashing deep inside the SDK's
         own spawn on a `claude` binary that exists but cannot run.
     (b) the ordinary success path never probes a candidate that fails to execute at all.
     (c) the thrown `ClaudeToolchainBlockedError`'s `searched[].cause.code` — independently
         readable from the refusal itself, never re-derived.
  6. TORN LEDGER TAIL -> INDETERMINATE — status.ts `evaluateDispatchBreakerDetailed`'s
     count-REGRESSION branch (W1-T206), distinct from path 2's reset (see that exerciser's own
     doc for why this is not a second copy of the same coverage).
     (a) refuses to trust a freshly-computed count that fell with nothing in the ledger to
         explain it, rather than reporting a false `"clear"` off a torn read.
     (b) the ordinary success path only ever sees a count that holds or grows.
     (c) the tri-state `"indeterminate"` verdict, re-derived fresh from a real ledger file torn
         on disk mid-line.
  7. GITHUB GATEWAY DEGRADE — status.ts `deriveStatus`'s W1-T119 fork: a genuinely failed
     GitHub read must say the read could not decide, never a confirmed "no PR".
     (a) marks the projection `indeterminate` with a named `unavailableReason`, rather than
         silently rendering a gateway outage as ordinary absence.
     (b) the ordinary success path never sets `readFailed()`.
     (c) `indeterminate`/`unavailableReason`/`source`, read straight off the returned
         projection.
  8. DIRTY DAEMON TREE PROCEEDS — run-task.ts `serviceFreshnessGate` + self-sync.ts
     `checkServiceFreshness` (W1-T255): the opposite of a recovery path, on purpose — the
     service must LEDGER `daemon.tree_dirty` and keep running, never refuse.
     (a) exists to survive the daemon's own uncommitted runtime exhaust without crash-looping
         on every launchd restart (the #707 aftermath).
     (b) the ordinary clean-tree success path never writes `daemon.tree_dirty` at all.
     (c) the ledger line, independently re-read off disk, plus whether the call returned
         (proceeded) or threw (refused).
  9. ORPHAN SWEEP SIGKILL — worker-containment.ts `sweepOrphanWorkers` (W1-T117), driven
     against a REAL spawned-then-SIGKILLed child, never a mocked process.
     (a) terminates a stray survivor of an ended run so it cannot run unbounded past it.
     (b) the ordinary success path never reaches an ended run's stray child at all.
     (c) the pid's real liveness, independently re-polled with `isPidAlive` — never merely
         trusted from the report's own `killed` list.

SIGKILL MID-RUN's live/unattended twin (the crash-loop detector reacting to a daemon that itself
got killed) is NOT built here — `detectDaemonCrashLoop` is already a pure function over
`daemon.boot` timestamps with its own ledger-only wiring proof (test/daemon-crashloop-wiring.
test.ts), so a real kill adds no coverage there, and the unattended live version is W1-T147's,
not this one's.

NEVER TOUCHES A LIVE FLEET. Every exercise below runs against fixtures created fresh under
`os.tmpdir()` and torn down immediately after: a throwaway git repo pair (never the daemon's real
checkout) for the deploy rollback AND the dirty-tree-proceeds entry, a throwaway ledger file for
the circuit breaker AND the torn-ledger entry, a throwaway lock file for the stale-lock reclaim, a
throwaway keychain store + a FAKE `security(1)` runner (never the real binary, never the operator's
real login keychain) for the worker keychain, a real non-executable husk binary under a throwaway
`$HOME` for the spawn preflight, a hand-built fake `GitHub` gateway for the degrade path, and a real
throwaway child process (killed with a real `SIGKILL`, never a live daemon worker) for the orphan
sweep. `launchctl`/`security`/network calls that would touch the real host are always faked; git,
the filesystem, and the process table, which the fixture itself owns, are always real — "a rollback
covered only by tests that inject their own git seam proves the bookkeeping and not the recovery"
is this task's own rationale, so the git/fs/process half here is never mocked.

DISCRIMINATES, ON PURPOSE (the falsifier this whole instrument exists to satisfy). Each exercise
runs TWICE per path: once against a HEALTHY fixture (the recovery precondition holds and every
dependency works) and once against a SABOTAGED one (the precondition holds but a real dependency
the recovery needs is broken — a security command failing, a torn ledger read, a staleness judgment
answering wrong, no known-good sha ever having been observed). A path only reports PASS when the
healthy run reports healthy AND the sabotaged run reports unhealthy. A drill that reported "healthy"
regardless of input would be a false clean — worse than no drill, because it reads as coverage that
does not exist.

LOUD WHEN IT CANNOT RUN. A drill whose fixture setup itself fails (e.g. no `git` on PATH) reports
UNREACHABLE, rendered and counted distinctly from a drill that ran and found the path unhealthy —
"no output" must never be the success signal, and "ran and failed" must never be confused with
"could not even try".

NOT A REQUIRED CHECK, AND NOT A PR TRIGGER — see `.github/workflows/recovery-drill.yml`'s own
header for the polarity argument (mirrors clock-sweep.yml/mutation-nightly.yml).

## `withFixtureDir` — the reapable prefix (W1-T2773)

Removed from lines 159-161.

W1-T2773: normalize the variable prefix to the reapable RMD_TMP_PREFIX form so the boot sweep in
src/lib/tmp.ts's sweepStaleTempDirs can reclaim a dir this drill leaves behind on SIGKILL — the
exact defect W1-T2773's lint rule refuses at callsite authoring time.

## `exerciseStaleLockReclaim` (fs-race-safe.ts)

Removed from lines 182-189.

A dead holder's lock, real bytes on a real filesystem. `isStale` is the one seam every real caller
(inflight-lock.ts, drain-lock.ts, review.ts, worker-home.ts) supplies for itself, usually backed by
a pid-liveness check — SABOTAGED here by making it misjudge a genuinely dead holder as live (the
real fault class: pid reuse, or `process.kill` throwing EPERM and being read as "alive"), which is
exactly the shape that would leave a crashed holder's lock wedged forever.

## `exerciseCircuitBreakerReset` (status.ts)

Removed from lines 207-214.

Trip the real breaker with five real `run.start` ledger lines, then record real forward progress
(`pr.opened`), all via the real `appendLedger`/`evaluateDispatchBreaker` against a real ledger file
on disk — never an in-memory stand-in for the ledger. SABOTAGED by injecting a `ledgerFs` whose read
is torn (drops the trailing line) — the exact W1-T206 rotation-truncation class this module's own
doc names — so the reset's evidence never reaches the breaker.

## `exerciseCircuitBreakerReset` — `opts.maxDispatches`

Removed from lines 223-226.

`opts.maxDispatches` defaults to evaluateDispatchBreaker's own DEFAULT_MAX_TASK_DISPATCHES (5) —
the five run.start lines above always trip it in real use. A test can override this to exercise the
"fixture didn't trip" guard below deterministically, without that guard ever firing in the drill's
own real, unopinionated call.

## `exerciseCircuitBreakerReset` — the torn read

Removed from lines 242-243.

Torn read: drops the last (non-empty) line — the pr.opened line this reset depends on — simulating
a rotation caught mid-write. Real reads (mode "healthy") see it.

## `exerciseDeployRollback` (deployer.ts)

Removed from lines 260-272.

A throwaway origin + install checkout pair, built with REAL `git` — never the daemon's real
checkout, never a mocked git seam. HEALTHY: install is cloned while origin still points at the good
commit, a real `daemon.boot` ledger line records that sha as observed-runnable, then origin moves to
a bad commit — the ordinary "behind, then unhealthy, then roll back" shape. `runDeployCycle`
fast-forwards install with a real `git merge --ff-only`, and its rollback branch restores the good
sha with a real `git reset --hard`. SABOTAGED: reproduces the actual 2026-08-05 incident this task's
rationale names — install is ALREADY on the bad sha (a second, unlogged writer got there first) and
NO boot line for any good sha was ever recorded, so the rollback's anchor (`readLastGoodBootSha`)
has nothing to return and falls back to `fromHead` — which is the bad sha itself.
`launchctl`/health-polling are always faked (never the real daemon); only the git/fs half — the
part that was undertested — is real.

## `exerciseDeployRollback` — the sabotaged install state

Removed from lines 302-303.

sabotaged: install stays at the clone's tip, badSha — already fast-forwarded, as if a second writer
beat this cycle to it (the observed 2026-08-05 shape).

## `exerciseDeployRollback` — the sabotaged ledger

Removed from line 312.

sabotaged: no boot line recorded for ANY sha — nothing for the rollback to anchor to.

## `exerciseKeychainReprovision` (worker-home.ts)

Removed from lines 362-370.

A throwaway keychain store under a fixture directory, provisioned through a FAKE `security(1)`
runner — never the real binary, never the operator's real login keychain (`loginKeychainPath`
points at a path that does not exist). HEALTHY: the fake runner answers every `security` call as a
real login keychain read + provision would. SABOTAGED: `add-generic-password` — the step that
actually writes the copied credential — throws, exactly as the real command does on a
permissions/interaction failure; `ensureWorkerKeychain` must surface that as a named
`WorkerKeychainError`, never a silent "provisioned: true".

## `exerciseKeychainReprovision` — `opts.faultStep`

Removed from lines 372-376.

`opts.faultStep` names WHICH security(1) call fails in sabotaged mode — defaults to
`add-generic-password` (the step that actually writes the copied credential; the drill's own real,
unopinionated call). A test can point this at `find-generic-password` instead to exercise the
"surfaced, but not the reason class this drill expects" branch below, which the default fault never
reaches.

## `exerciseKeychainReprovision` — the fault-step classification

Removed from lines 384-387.

`find-generic-password` failing classifies as a LOCKED login keychain (a different named reason
than the default fault's `provision-failed`) — worker-home.ts's own `classifyLoginReadError` keys
on this exact phrase. Any other fault step keeps the default `add-generic-password` write-failure
wording (-> `provision-failed`).

## `exerciseKeychainReprovision` — "healthy" means the goal was reached

Removed from lines 417-422.

"healthy" means the SAME thing in both modes, matching every other path in this file: did the
recovery actually accomplish its goal (a provisioned, working store) — never "was a failure
detected". Under sabotage the goal is genuinely unreachable, so `succeeded` is false there by
construction; what the detail line calls out is WHETHER that unreachability was surfaced loudly (a
named `WorkerKeychainError`) or silently (any other outcome) — silent would be a second, worse
defect layered on top of the sabotage itself.

## `exerciseSpawnPreflightHusk` (worker.ts)

Removed from lines 444-457.

A real non-executable `claude` husk — the exact shape test/toolchain-refusal-errno.test.ts already
builds (a real file, mode 0o644, no exec bit, regardless of umask) — pointed at as the ONLY
resolvable candidate via `resolveClaudeExecutable`'s own injectable `locations`/`which` deps (env
override and PATH both silenced so the fixture's husk is the sole candidate).
`resolveClaudeExecutable`'s real `canExecute` probe is a genuine `execFileSync(path, ["--version"])`
spawn (W1-T901): a non-executable file makes the OS itself refuse `execve` with `EACCES`, caught and
named. HEALTHY: the real probe names `EACCES` on the thrown `ClaudeToolchainBlockedError`'s
`searched[].cause.code`, distinguishing this husk from a binary that runs and crashes. SABOTAGED:
`canExecute` swapped for the pre-W1-T901 `catch { return false }` shape — swallows the errno into a
bare `false` — so the guard still refuses (the husk genuinely cannot run either way) but the
refusal's reason class is lost, rendering a husk and a crasher indistinguishably, exactly the
regression W1-T901 was filed to end.

## `exerciseSpawnPreflightHusk` — `opts.locations`

Removed from lines 477-483.

`opts.locations` is a fault-injection escape hatch (mirrors keychain-reprovision's own
`opts.faultStep`) — the real RECOVERY_PATHS call site never passes it, so the drill's own scheduled
run always exercises the genuine husk-vs-crasher distinction below. A test uses it to make a
candidate's own `resolve` throw a RAW error, proving the "threw, but not the expected
ClaudeToolchainBlockedError" branch is reported unhealthy rather than crashing the whole drill —
distinct from the husk refusal itself, which always throws the named class.

## `exerciseTornLedgerIndeterminate` (status.ts evaluateDispatchBreakerDetailed)

Removed from lines 504-520.

W1-T206's count-REGRESSION branch specifically (`evaluateDispatchBreakerDetailed`,
status.ts:1540-1543) — checked against duplication with path 2 above (design's own requirement) and
found DISTINCT, not a second copy: `exerciseCircuitBreakerReset`'s sabotage only ever drops the
ledger's trailing `pr.opened` line, which never lowers `freshCount` below the cache's prior
observation (it stays at the same tripped count), so that entry only ever proves "a torn read never
falsely clears an already-tripped breaker" — the literal `"indeterminate"` verdict is never produced
there. This entry drives the OTHER branch: a real ledger file torn on disk mid-line (a genuine
crash-mid-write shape — see ledger.ts's own `appendLedger` doc), whose freshly-computed count
REGRESSES below a real prior observation with no `pr.opened` in the fresh read to explain the drop.
HEALTHY: the real (default) `ledgerFs` reads the genuinely shorter file and correctly reports
`"indeterminate"` — DO NOT ACT, never a false `"clear"`. SABOTAGED: a `ledgerFs` whose read never
observed the tear (a stale-reader class fault: it always returns the pre-tear bytes) so the
regression the real bytes on disk would show is masked from the evaluator and the count never drops
— the read silently missing the torn line, exactly the seam-misjudgment this entry exists to catch.

## `exerciseTornLedgerIndeterminate` — `opts.maxDispatches`

Removed from lines 522-526.

`opts.maxDispatches` defaults to evaluateDispatchBreaker's own DEFAULT_MAX_TASK_DISPATCHES (5) — the
seven run.start lines below always trip it in real use. A test can override this to exercise the
"fixture didn't first observe a tripped baseline" guard below deterministically, mirroring
exerciseCircuitBreakerReset's own opts.maxDispatches escape hatch, without that guard ever firing in
the drill's own real, unopinionated call.

## `exerciseTornLedgerIndeterminate` — tearing the ledger

Removed from lines 540-542.

Tear the ledger's real last line ON DISK — a genuine crash-mid-write shape, never a
reimplementation of the guard's own torn-line detection (readLedgerLines' real JSON.parse catch
does that work, exactly as it would for a real crash).

## `exerciseGithubGatewayDegrade` (status.ts deriveStatus)

Removed from lines 573-583.

A hand-built `GitHub` gateway (the same fixture idiom test/status-blockers-live.test.ts already
uses) fed straight into `deriveStatus` — never a real `gh` call. HEALTHY: the gateway genuinely
reports the read failed (`readFailed() => true`, `readFailureReason() => "transport"`, the 500
class), and `deriveStatus` must mark the projection `indeterminate` with that NAMED reason rather
than resolve it as a confirmed "no PR" (W1-T119). SABOTAGED: the identical underlying outage arrives
dressed as success — `readFailed() => false` with every lookup answering empty — so the read never
surfaces as failed at all; the fault is the gateway failure "arriving as an empty-but-successful
result", exactly the incident shape this guard exists to prevent (an outage silently rendered as "no
PR" fact).

## `exerciseGithubGatewayDegrade` — the false clean

Removed from lines 610-612.

sabotaged: must be caught — a projection that renders the disguised outage as an ordinary,
confirmed "no PR" (queued, source none, no indeterminate flag) is exactly the false clean this
drill exists to notice.

## `exerciseDirtyTreeProceeds` (run-task.ts serviceFreshnessGate, self-sync.ts)

Removed from lines 620-636.

A throwaway git checkout, one TRACKED file dirtied (the exact `-uno`-scoped shape
`checkServiceFreshness` counts — test/self-sync.test.ts's own fixture idiom), driven through the
REAL `serviceFreshnessGate`. This is a GUARD's opposite shape on purpose: the invariant is not
"refuse", it is "never refuse" — a service crash-looping on its own uncommitted runtime exhaust was
the #707 aftermath (self-sync.ts's own doc). HEALTHY: the real (unoverridden)
`checkServiceFreshness` sees the genuine dirt, the gate LEDGERS `daemon.tree_dirty` (re-read off
disk, never merely trusted from a non-throw), and — because the call returns rather than throwing —
PROCEEDS. SABOTAGED: `checkServiceFreshness` swapped for a fixture that answers the way a regressed
predicate would if it "refused" instead of assessing (throws) — a refusal here is exactly the
nonzero exit `KeepAlive{SuccessfulExit:false}` turns into a crash loop, and this entry's job is to
prove that regression would be caught, not silently pass.

SCOPE FENCE: this entry owns ONE tracked-dirt shape exercised on a cadence; it does not rebuild
W1-T924/W1-T925/W1-T926's operator-dirt topology/table and never edits
scripts/operator-dirt-drill.mjs.

## `exerciseDirtyTreeProceeds` — `ensureInstallFresh` stubbed

Removed from lines 665-668.

`ensureInstallFresh` is a DIFFERENT W1-T151 concern (real npm install freshness) this entry is not
about — stubbed out (in BOTH modes) so the fixture stays git-and-fs-only, like every other exercise
in this file, and never shells out to a real `npm ci` against a bare fixture checkout with no
package.json.

## `exerciseDirtyTreeProceeds` — the injected refusal

Removed from lines 703-704.

sabotaged: the injected refusal MUST be caught (a refused service is the crash-loop shape the
daemon's freshness gate exists to avoid producing).

## `awaitProcessGroupGoneSync` — why `ps`, not `kill(pid, 0)`

Removed from lines 711-721.

Synchronous poll for a real pid's death — `sweepOrphanWorkers`'s exercisers below never trust the
report alone, so this re-checks the OS directly, bounded, never a fixed sleep.

Deliberately `listProcessGroupMembers` (a real `ps` scan, ZOMBIE-EXCLUDING per its own doc) rather
than `isPidAlive` (`kill(pid, 0)`): `kill(pid, 0)` still succeeds against a zombie — exited, but not
yet reaped — and reaping is Node's OWN async SIGCHLD handling, which a SYNCHRONOUS `Atomics.wait`
busy-loop starves by construction (this drill's exercise functions are sync, matching the
orchestrator's un-awaited `p.exercise(mode)` call). Polling via `ps` sidesteps that deadlock
entirely: a zombie already reads as gone.

## `exerciseOrphanSweepSigkill` (worker-containment.ts sweepOrphanWorkers)

Removed from lines 731-743.

A REAL throwaway child process (`sleep 300`, detached so its own pid is its own process-group
leader — the shape `killProcessGroup`'s `-pid` signal targets), attributed as belonging to an ENDED
run via seeded (never `ps`-scanned) `listCandidates`/`readMarkers` — `ps` output parsing is not this
entry's fault surface, real termination is. HEALTHY: the real `killProcessGroup` sends a real
`SIGKILL`; the report names the pid killed AND the process group is independently re-polled empty
via a real `ps` scan — never merely trusted from the report's own `killed` list. SABOTAGED: `kill`
swapped for a no-op — the sweep's attribution logic still runs and still LEDGERS
`worker_orphan_killed` as if termination happened, but the real process survives: a false clean,
exactly the shape this entry exists to catch (a sweep that reports success without actually ending
the stray). The real child is unconditionally reaped in a `finally`, regardless of mode, so a
sabotaged run never leaks a live process past this drill.

## `exerciseOrphanSweepSigkill` — `opts.spawn`

Removed from lines 747-751.

`opts.spawn` is a fault-injection escape hatch (mirrors the husk entry's own `opts.locations`) —
the real RECOVERY_PATHS call site never passes it, so the drill's own scheduled run always spawns a
genuine throwaway child. A test uses it to make the spawn itself throw, proving the "could not spawn
a real throwaway child" UNREACHABLE branch is reported rather than crashing the whole drill —
distinct from the husk refusal itself, which always throws the named class.

## `runDrill` — the pass rule

Removed from lines 844-850.

Drill every path, twice each (healthy + sabotaged), and classify. A path PASSES only when it both
ran healthy-and-reported-healthy AND ran sabotaged-and-reported-unhealthy — anything else (either
run couldn't even execute, or the sabotaged run wasn't caught) is NOT a pass. Pure and total over
whatever `paths` it is given, so it is directly unit-testable with synthetic exercisers, never only
through the four real ones.

## `renderReport` — the UNREACHABLE branch

Removed from lines 876-877.

LOUD AND DISTINCT: never rendered as "FAIL" — a drill that could not run says so, rather than
reading as a recovery path that ran and was found broken.
