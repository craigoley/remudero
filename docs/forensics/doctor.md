# doctor.ts forensics

The measured forensics, incident narratives and design arguments removed from `src/lib/doctor.ts`
when its comments were compacted to the plain-language standard. Every block below is the removed
text verbatim, marker characters stripped and nothing else changed. Headings name the symbol the
text explained; the code keeps a one-line `// Why:` pointer where the history mattered. Base
revision: origin/main at c185258e295d83d32371612edc2c39bde5d0fd4e; the line numbers below are that
revision's.

## Module header

### Base lines 7-35 — W1-T1047 — `rmd doctor`: ONE local…

W1-T1047 — `rmd doctor`: ONE local, read-only command that answers "is the fleet healthy" and
returns an exit code that means something.

THREE CONSTRAINTS, EACH FROM A MEASURED FAILURE, EACH A REFUSAL RATHER THAN A PREFERENCE:
 - CLI-SIDE, NOT CONSOLE. `remudero-serve` was `Exited (137)` for over a day by operator
   decision. A check living behind `buildDaemonHealthRoute` is useless when the web service is
   the thing that broke.
 - NO NETWORK. The shared API budget was exhausted ten times in two days and the operator was
   locked out of his own repository for ninety minutes. A check that calls GitHub fails on
   exactly the condition it exists to report. Every reader below touches the ledger, `state/`,
   `plan/`, `/proc` or `ps` — nothing calls `gh`.
 - NO HEALTHY DAEMON REQUIRED. Nothing here awaits a tick, takes a lock, or writes a byte. A
   DOWN DAEMON IS NOT AN ERROR CONDITION, IT IS THE DIAGNOSIS: no process, no recent ledger row
   and no lock is a complete, printable answer, and the exit code says FAIL without the command
   itself failing.

READ-ONLY, AND `--fix` IS REFUSED RATHER THAN UNIMPLEMENTED. Every repair path already has an
owner — #2251 for the container recycle, W1-T1036 for the git lock, W1-T978 for `drain.lock` —
and a SECOND ACTOR MUTATING STATE A LIVE DAEMON DEPENDS ON is the hazard this repo has already
measured. `doctorCommand` rejects the flag by name and says who owns the repair.

WHY THE DECIDERS ARE PURE AND SEPARATE FROM THE READERS. Every `judge*` function below takes
already-measured numbers and returns a verdict; every reader does I/O and no judging. That split
is not tidiness — a refusal arm reachable only through a real `/proc` read or a real `ps` call is
a line no test can cover, and `diff-coverage` blocks a diff whose added lines have no covering
test. Each arm is therefore reachable by calling one pure function with one set of numbers, and
each has a paired positive control in `test/doctor.test.ts`.

## Check

### Base lines 39-44 — One check's result. `measured` and…

One check's result. `measured` and `threshold` are BOTH required and both human-readable,
because the output contract is that no check ever prints a bare verdict — the same discipline
`boundDerivation` already applies to the queue-head stall bound. A verdict with no number beside
it is what makes a health command cry wolf.

## DOCTOR_USAGE_EXIT

### Base lines 63-67 — 0 / 1 / 2 by worst verdict…

0 / 1 / 2 by worst verdict. DELIBERATELY DISTINCT FROM `statusCommand`'s bad-argument 2: a
doctor arg error exits 64 (`EX_USAGE`), so a cron reading exit 2 always means "a check FAILED"
and never "you typed the flag wrong".

## judgeLedgerFreshness

### Base lines 97-113 — LEDGER FRESHNESS — the single best…

LEDGER FRESHNESS — the single best liveness signal, and the reason is structural: `docker logs`
narrates ACTIONS and goes silent between them, so a quiet log is ambiguous. FAIL past the bound
rather than WARN, because a stale ledger is the daemon being gone.

W1-T1274 — "`daemon.`-prefixed rows do not stop while the daemon lives" WAS ASSERTED HERE AND
WAS FALSE: MEASURED, the prefix went silent for 102.5 minutes on 2026-08-23 while the daemon
stayed alive and productive across the gap, because the only RECURRING `daemon.`-prefixed
emitter (`daemon.alive`, a ticker) only runs inside three windows (retro, full sweep, dispatch
settling) — every stretch of the loop outside those three wrote nothing with this prefix at
all. What makes the sentence true now is `daemon.ts`'s `runDaemon` loop: it writes an
UNCONDITIONAL `daemon.tick` row as the literal first statement of every iteration, on every
path (idle, paused, dispatching, sweeping, or returning early at this very check) — so the
corpus below (still every `daemon.`-prefixed row, never narrowed to `daemon.tick` alone or to a
`run_id`, per rationale (7)/(8)) is never silent for longer than about one poll interval while
the loop is turning, regardless of which ticker window happens to be open.

## judgeDiskHeadroom

### Base lines 136-141 — DISK HEADROOM. The thresholds are…

DISK HEADROOM. The thresholds are the measured incident, not round numbers: this host reached
55MiB free with a live daemon on it, and at that point ordinary commands failed to write their
own stdout. FAIL is set an order of magnitude above where that happened so the warning arrives
with time to act, and WARN above that again.

## judgeMemory

### Base lines 154-161 — MEMORY AND SWAP — the one genuinely…

MEMORY AND SWAP — the one genuinely new reader in the list, and it reads `/proc/meminfo`,
NEVER THE CGROUP LIMIT. This container is unlimited, so `memory.max` reads the literal string
`max` and would report unbounded headroom on a host that had already frozen. The measured freeze
was ~4% available with ZERO swap, and because a reclaim livelock never arms the OOM killer,
nothing was logged and no other signal existed — which is why swap being absent is part of the
judgement rather than a footnote.

## judgeDispatchStall

### Base lines 183-188 — ELIGIBLE POOL VERSUS DISPATCH AGE…

ELIGIBLE POOL VERSUS DISPATCH AGE. The bound is NOT a guessed round figure — it comes from this
host's own observed dispatch cadence, and the caller passes both it and the derivation string so
the printed threshold explains itself. A non-empty eligible pool sitting past that bound is the
shape that renders identically to a healthy queue in `rmd status`, which is the defect.

## judgeRepairStall

### Base lines 205-225 — W1-T1209 — REPAIR-RUNG STALL…

W1-T1209 — REPAIR-RUNG STALL. `fix.dispatch` read ZERO for twenty-one hours on 2026-08-22 while
the sweep kept disposing open pull requests `blocked-fixable` every pass — ten dispatches threw,
`dispatchFix` swallowed its own throw and recorded `acted: true`, and that seeded the fix-rung
dedup gate that then stood down every retry. Nothing anywhere said the repair rung was down; a
human found it by reading the board.

THE FAULT IS A CONJUNCTION, EXACTLY LIKE `judgeDispatchStall`, AND FOR THE SAME REASON: a
gap in `fix.dispatch` only means something when the sweep chose `blocked-fixable` in the SAME
window. An empty repair queue is the healthy state, and an arm that cries wolf on a quiet board
trains the operator to ignore the one instrument that would have caught the real outage.

THE BOUND IS A CALLER-SUPPLIED, DERIVED NUMBER — NEVER A CONSTANT HERE. Exactly like
`judgeDispatchStall`, this function never guesses a ceiling; it prints whatever bound and
derivation string the caller measured from this host's own `fix.dispatch` cadence, which is the
constraint design note (ii) of this task states as a refusal, not a preference (see W1-T1099's
sibling arm, whose printed threshold once disagreed with its own predicate).

REPORT ONLY. This arm dispatches nothing, clears no gate and escalates nothing — the contention
(W1-T1129), the swallow (W1-T1127) and the light-hook suppression are each separately owned.

## judgeDispatchStarvation

### Base lines 250-263 — DISPATCH LIVENESS — a READER for…

DISPATCH LIVENESS — a READER for a field that is emitted and read by nothing. `daemon.alive`
carries `phase`, and a window with no `dispatch` phase among it — WHATEVER the other phases
are, not only a hardcoded `sweep` — is a daemon that is awake but never dispatching. WARN, not
FAIL: a genuinely empty queue produces the same shape, so this is a prompt to look, not a
verdict on its own. CALLERS MUST PASS ONLY THE CURRENT RUN'S PHASES (see
`readCurrentRunAlivePhases`) — this function trusts its input and does not itself filter
by `run_id` (W1-T1099).

ZERO ROWS IS NOT THE SAME AS "TOO FEW TO JUDGE": a live daemon that has entered no rung this
run writes no `daemon.alive` row at all (the ticker wraps a rung's body, not the tick), so an
empty window means the arm has no evidence either way and must say so — OK would be a
false-green one level below the run-boundary defect this task also fixes (W1-T1099 design iii).

## SWEEP_LIVENESS_STEPS

### Base lines 291-322 — W1-T1236 — SWEEP LIVENESS…

W1-T1236 — SWEEP LIVENESS. `sweep.pass` (`src/lib/sweep.ts`, "PER-PASS HEARTBEAT, WRITTEN
BEFORE THE LOOP") is written before `runSweep`'s per-PR loop runs, exactly so a pass that throws
mid-loop still leaves a row — and nothing read it. `sweep.pass` appeared nowhere in this file,
`ledger.ts`, `status.ts`, `status-board.ts` or `ops.ts` before this arm; every plan reference to
it is a human reading the ledger by hand, which is precisely the discovery latency this closes.
The measured incident is `sweep.ts`'s own doc comment: a 23.5-minute gap in `sweep.summary` on
2026-08-05 that CONTAINS four `sweep.disposed` rows — passes were starting and dying mid-loop,
and PR #1348 opened and closed entirely inside the blind window.

TWO FAULTS, ONE ARM, BOTH DERIVED OFF ROWS THAT ALREADY EXIST — never a new emit, a pass id, or
a correlation between rows (that would drag in `sweep.ts`, which is W1-T1238's file):
 (a) PASSES NOT STARTING — the newest `sweep.pass` is older than a bound DERIVED from this
     host's own observed `sweep.pass` cadence, exactly like `judgeDispatchStall`'s
     `boundDerivation`: never a guessed round figure.
 (b) PASSES STARTING AND NOT FINISHING, the case the row was positioned for — the newest
     `sweep.pass` has no `sweep.summary` AT OR AFTER its own timestamp, paired BY TIME ORDER.

ZERO ROWS IS WARN, NEVER OK AND NEVER FAIL — `judgeDispatchStarvation`'s own precedent
verbatim: a fleet that has never swept, a freshly-rotated ledger, and a sweep blind for longer
than the retention window all present as zero `sweep.pass` rows, and a false-green OK here
reproduces the exact 2026-08-05 window nobody noticed. THE STALE-BOUND AND NO-SUMMARY FAULTS ARE
ALSO WARN, NEVER FAIL, on W1-T1209's own reasoning: doctor OBSERVES, and any automatic
remediation of a blind sweep is a separate decision this arm does not make.

THE BOUNDARY MARKER IS WHAT MAKES W1-T1237 POSSIBLE. `SWEEP_LIVENESS_STEPS` names every
ledger step this arm reads in ONE exported Set, read through `.has(step)` in
`readSweepPassSummaryTimestamps` rather than two loose string comparisons — mirroring `board.ts`'s
`OPERATOR_ACTION_STEPS` for the identical reason `test/ledger-render-retention.test.ts` records:
a blanket `.step ===` scan of this file would sweep up every unrelated step it already compares
(`daemon.alive`, `fix.dispatch`, ...) and demand retention for all of them.

## SWEEP_STALL_MULTIPLIER

### Base lines 325-329 — How much this arm multiplies the…

How much this arm multiplies the longest OBSERVED gap between `sweep.pass` rows by to derive
its staleness bound — the identical multiplier and reasoning `status-board.ts`'s
`QUEUE_HEAD_STALL_MULTIPLIER` already applies to `run.start` dispatch cadence. Re-derived here
rather than imported: that constant keys on a different step, and this task's design confines
every new input to a fold over `doctor.ts`'s own already-injected `ledgerLines`.

## readSweepPassSummaryTimestamps

### Base lines 332-337 — `sweep.pass`/`sweep.summary` timestamps…

`sweep.pass`/`sweep.summary` timestamps (parsed ms, oldest-order not required), read through
`SWEEP_LIVENESS_STEPS` — the ONLY place in this file either string literal appears. A line
with no parseable `ts` is skipped rather than corrupting the derived cadence, the same
discipline `status-board.ts`'s `deriveDispatchCadence` already applies to `run.start`.

## judgeSweepLiveness

### Base lines 352-357 — REPORT ONLY, exactly like every…

REPORT ONLY, exactly like every sibling arm above: this function returns a `Check` and
nothing else — no dispatch, no gate clear, no restart. Calling it twice with the same inputs
yields a byte-identical result, the same purity-as-proof-of-no-action shape `judgeRepairStall`'s
own test relies on.

## judgeLockDivergence

### Base lines 422-431 — LOCK VERSUS PROCESS DIVERGENCE…

LOCK VERSUS PROCESS DIVERGENCE. An inflight lock whose pid is gone is a run that died without
releasing. WARN and report only — W1-T978 owns `drain.lock` reclamation and #2251 owns the
recycle; doctor names the divergence and stops.

AN UNREADABLE DIR IS NOT AN EMPTY ONE, and conflating them is a FAIL-OPEN in a health check:
a permissions fault that HIDES every lock would otherwise read as "0 locks, all healthy". An
absent dir genuinely is zero locks (a fleet that has never dispatched), so only that case is
silently fine; anything else reports that lock state is UNKNOWN.

## classifyReadFailure

### Base lines 450-456 — Classify a filesystem read failure…

Classify a filesystem read failure into "genuinely absent" versus "could not be read".

EXTRACTED AND PURE so both arms are reachable from a test without arranging a real EACCES. This
is the same class of defect a sibling task found today: `spawnSync` returns `status: null` on a
signalled child and the classifier read it as success. The shape here is a `catch` that cannot
tell ENOENT from EPERM and answers "nothing there" to both.

## judgeLaneLessWorkers

### Base lines 464-469 — LANE-LESS WORKERS. The threshold is…

LANE-LESS WORKERS. The threshold is #2251's `HUNG_WORKER_AGE_S`, REUSED rather than re-derived
and deliberately NOT lowered — that PR states its own derivation and this task must not
second-guess it. Reuse here means reusing the number and its reasoning; the matcher itself lives
in shell, which is a cost named up front rather than discovered.

## judgeCheckoutDepth

### Base lines 499-520 — CHECKOUT DEPTH (W1-T2332)…

CHECKOUT DEPTH (W1-T2332). A shallow canonical checkout breaks every history read SILENTLY —
`git log -S`, `--follow`, merge-base checks all stay plausible while computed over a fraction
of the corpus (`docs/operator-guide.md`'s own measurement: a 120-commit clone answered ZERO
deletions for a file deleted before its horizon, with the "does this query return rows" control
passing loudly). The only prior detector in the fleet was `defaultMergeEvidenceLog` /
`defaultVerdictCalibrationGitLog` REFUSING BY NAME — an earned, correct guard that only speaks
when a linter that happens to need history runs. This arm asks the question when nobody needed
an answer.

REPORT ONLY, LIKE `git-locks` ABOVE. `git fetch --unshallow` is the remedy this arm NAMES,
never runs — an automatic unshallow at boot is exactly the second-actor-mutating-state hazard
`rmd doctor --fix` is refused by name over.

shallow ⇒ FAIL, naming the reachable commit count and the remedy command. FAIL rather than WARN
is deliberate: the fault is invisible by construction and the remedy is one command.
unreadable (no git, not a repository, a throw — the caller passes `undefined`) ⇒ WARN
"unreadable", NEVER OK: a read that FAILED reporting as a read that SAID NO is the class
W1-T472 design (v) names and this repo has now measured eight times.
full ⇒ OK, still naming the commit count so the horizon is legible even when it is fine — the
operator-guide's own prescription, applied where a reader already looks.

## WorktreeBaseState

### Base lines 549-568 — W1-T2627 — THE WORKTREE BASE RECORD…

W1-T2627 — THE WORKTREE BASE RECORD, READ FOR THE FIRST TIME. `recordWorktreeBase` (worker.ts)
writes `<worktree>.base` on every `worktreeAdd`, `removeWorktreeBase` deletes it on teardown,
and until this arm `readWorktreeBase` had ZERO production callers — the one fact that answers
"is this worktree's HEAD the commit it was cut from" was written and discarded, never consulted.
The incident that named this task: a follow-up run asked that exact question from first
principles because there was nowhere to read the answer.

FOUR STATES, NOT A BOOLEAN, and only ONE is a finding:
  - `at-base`      — HEAD equals the recorded base. Ordinary: a fresh worktree before its own
                      first commit sits here, and this is the state that produced the incident —
                      it must render as unremarkable.
  - `own-commits`  — HEAD descends from the recorded base. Ordinary: the run's own work.
  - `unrelated`    — HEAD does NOT descend from its recorded base. The ONLY state worth a look.
  - `base-unknown` — no record, an unreadable HEAD, or a failed ancestry read. NEVER promoted to
                      `unrelated` — the fail-safe direction this repo has already fixed twice on
                      the read path (W1-T119 throttled-is-not-absent, W1-T130
                      cannot-observe-means-wait): "I could not look" must not render as
                      "this worktree is contaminated".

## classifyWorktreeBase

### Base lines 571-577 — PURE. The ancestry read is an…

PURE. The ancestry read is an INJECTED SEAM (`isAncestor`) exactly so this classifier is
testable without a real git repository — the same no-I/O contract every other `judge*` function
in this file already keeps. `isAncestor` returning `undefined` (the read itself failed, e.g. no
git or an unreadable object) resolves to `base-unknown`, on the identical fail-safe direction as
an absent `base` or unreadable `head`.

## WorktreeBaseRow

### Base lines 590-595 — One live run's already-classified…

One live run's already-classified worktree-base reading. `taskId` is the id the run's BRANCH
claims — read via `taskIdFromRunBranch` (status.ts) by the I/O shell, reused rather than a
fourth inline `run-<taskId>-<epochMs>` regex — never the lock-file task id, so a mismatch between
what a branch claims and what a lock file says is legible instead of silently reconciled.

## judgeWorktreeBases

### Base lines 602-612 — ONE LINE PER LIVE RUN, carrying…

ONE LINE PER LIVE RUN, carrying the branch-claimed task id beside the head classification — the
whole remedy the incident needed: "the branch says W1-T2461 and HEAD is at-base" legible at a
glance instead of reconstructed from first principles.

REPORT ONLY, like every sibling arm in this file: nothing here reaps, moves or refuses a
worktree on the strength of this classification. `at-base`, `own-commits` and `base-unknown`
are NOT findings and never move the verdict above OK; `unrelated` is the only state that does
(WARN, never FAIL — this arm observes, it does not escalate to the daemon-is-down severity of
e.g. `judgeLedgerFreshness`).

## judgePauseHonoured

### Base lines 634-648 — PAUSE HELD WHILE DISPATCH CONTINUES…

PAUSE HELD WHILE DISPATCH CONTINUES. Earned on 2026-08-20: the operator held a pause for
fourteen minutes with no acknowledgement and reasonably concluded the control was dead. The
underlying tick defect is filed as W1-T1065 (#2298) and is CITED, NOT FIXED here — doctor
reports "PAUSED, N minutes, last dispatch M minutes ago" and nothing more, because a health
command that repairs the control it is diagnosing is the second-actor hazard again.

A dispatch NEWER than the pause means the pause was not honoured: its age exceeds the
dispatch's, so the dispatch happened after the flag went down.

## judgeNodeVersionPin

### Base lines 659-679 — R-49 (docs/audits/recon-2026-09-05.md)…

R-49 (docs/audits/recon-2026-09-05.md) — NODE VERSION PIN. `.nvmrc`, `package.json#engines`
(`>=22.22.3`) and `deploy/Dockerfile` all pin an exact Node version, but `npm ci` only WARNS
(EBADENGINE) on a mismatch and lets a stale install through — MEASURED at f7ceb86: this
container runs 22.22.2 against a 22.22.3 pin and `npm ci` succeeds. The only thing that actually
REFUSES on the drift is `assertPinnedNodeVersion` (`scripts/coverage-merge-ratchet.mjs`)
throwing inside `test/merge-lcov.test.ts` — a random test failure, nowhere near where an
operator could act on it. The operator explicitly ruled against `engine-strict` in `.npmrc`: it
would refuse `npm ci` on every machine not on the exact patch version, agent containers
included. This arm is the surface that reports the drift where an operator actually looks.

WARN, NEVER FAIL — a running node one patch off the declared pin is not the "daemon is down"
severity `judgeLedgerFreshness`/`judgeCheckoutDepth` reserve FAIL for; it is a drift
worth a look, the same tier `judgeMemory`'s WARN band already uses. An unreadable `.nvmrc`
is WARN "unreadable", NEVER OK — the same fail-safe direction `judgeCheckoutDepth` already
applies to its own unreadable case: a read that FAILED must never render as a read that SAID
"matches" (W1-T472 design (v), measured eight times in this file's own history).

PURE — takes both versions already measured, exactly like every sibling judge* function above;
the reader below does the one filesystem touch.

## readLedgerAgeMs

### Base lines 754-765 — Newest `daemon.`-prefixed row age…

Newest `daemon.`-prefixed row age, via the already-exported `deriveLastPoll`. Since
W1-T1274, `runDaemon`'s loop (`daemon.ts`) writes an unconditional `daemon.tick` row into this
SAME prefix on every iteration, so the age this returns no longer depends on which of the three
`daemon.alive` ticker windows (retro/full-sweep/dispatch-settling) happens to be open.

Two missed polls is the bound: one missed poll is ordinary jitter, two is a pattern.

## newestDaemonRunId

### Base lines 777-786 — The `run_id` of the newest…

The `run_id` of the newest `daemon.`-prefixed ledger line, by parsed `ts` — the SAME
winning-row rule `deriveLastPoll` already applies for ledger freshness, re-applied here
only to read that row's `run_id` rather than its `ts`. Every `daemon.`-prefixed line already
carries `run_id`, so no new ledger FIELD is needed here — but W1-T1274 DOES add a new emitter
(`daemon.tick`, into this same `daemon.`-prefixed corpus, `daemon.ts`), and deliberately moves
this function's predicate in lockstep with `readLedgerAgeMs`'s: both stay keyed on the
full `daemon.`-prefix (never narrowed to `daemon.tick` alone, never widened to a bare `run_id` —
W1-T1274 rationale (7)/(8)), so the two checks can never disagree about which run is current.

## readCurrentRunAlivePhases

### Base lines 802-808 — `daemon.alive` phases belonging ONLY…

`daemon.alive` phases belonging ONLY to the current daemon run, oldest→newest —
`readAlivePhases`'s rows filtered to `newestDaemonRunId`. A replaced run's rows
(a daemon that stopped cleanly and was superseded) are never read as if they belonged to the
run that is live now — that was the second defect W1-T1099 fixes: judging a dead run's phases
as the fleet's current liveness.

## DoctorInputs

### Base lines 883-913 — field docs for repairDisposedCount…

`repairDisposedCount` — W1-T1209 — repair-rung stall. Candidates disposed `blocked-fixable` in
the derived window; defaults to 0 (no evidence of a fault) for callers that do not yet supply a
real count, which is the fail-closed-toward-quiet direction design note (iii) requires: an arm
that cannot see the disposals must never invent a FAIL.

`checkoutDepth` — W1-T2332 — the canonical checkout's history horizon, measured by the caller
(this module never touches the filesystem, per the file header). `undefined` means the read
failed — `judgeCheckoutDepth` reports that as unreadable, never as a healthy full checkout.

`worktreeBases` — W1-T2627 — one entry per LIVE in-flight run, already read and classified by
the caller (this module never touches the filesystem or git, per the file header). Defaults to
`[]`, which `judgeWorktreeBases` reads as "0 live worktree(s)" — never a finding.

`runningNodeVersion` — R-49 — the running interpreter's own version (`process.versions.node`),
measured by the caller exactly like `nowMs` above: this module reads no ambient global state
itself.

`nvmrcVersion` — R-49 — `.nvmrc`'s declared pin, already read by the caller via
`readNvmrcVersion`. `undefined` means the read failed — `judgeNodeVersionPin` reports that as
unreadable, never as a healthy match.
