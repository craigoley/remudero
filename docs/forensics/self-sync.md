# self-sync.ts forensics

Measured forensics, incidents and design arguments removed from `src/lib/self-sync.ts` when its
comments were compacted to the plain-language standard. The code keeps a short pointer at each
site — a `// Why:` line, a task id, or a PR number; the full record is here.

Every block below is reproduced verbatim from the source at the base commit (5c5e21aae988, the
`origin/main` head this compaction started from). Only the comment markers (`/**`, ` * `, `//`)
were stripped; no wording was changed. Each heading names the symbol the block explained, and the
line range is the range at the base commit.

## Contents

- [Imports](#imports) — base lines 3-16
- [Module header](#module-header) — base lines 19-72
- [SelfSyncDeps.log](#selfsyncdepslog) — base lines 104-122
- [SelfSyncResult (the worktree state)](#selfsyncresult-the-worktree-state) — base lines 131-140
- [alreadySelfSynced](#alreadyselfsynced) — base lines 171-192
- [the worktree detection block](#the-worktree-detection-block) — base lines 244-276
- [the dirty-tree scope check](#the-dirty-tree-scope-check) — base lines 296-341
- [the W1-T445 branch guard](#the-w1-t445-branch-guard) — base lines 368-407
- [currentBranch](#currentbranch) — base lines 422-435
- [checkServiceFreshness (module doc)](#checkservicefreshness-module-doc) — base lines 478-501
- [checkServiceFreshness (the -uno alignment)](#checkservicefreshness-the--uno-alignment) — base lines 526-552
- [daemonFreshnessFromService](#daemonfreshnessfromservice) — base lines 558-601

## Imports

Removed from `src/lib/self-sync.ts` lines 3-16 at the base commit (the two import-adjacent
comments, kept together here).

```text
TYPE-ONLY, so this stays a one-way dependency at runtime: the import is erased, daemon.ts
imports nothing from here, and lib/daemon.ts's "never touches the filesystem" purity is
untouched by a module that shells out to git.

W1-T446: A RUNTIME IMPORT, DELIBERATELY, NOT TYPE-ONLY -- `treeFfSafe` is the predicate
itself, not a shape. `deployer.ts` already exports it pure or side-effect-free (inputs in,
result out) and there is NO import cycle back to this module. REUSING IT RATHER THAN
RE-DERIVING A SECOND INTERSECTING PREDICATE is the point: two hand-maintained intersections
of dirty-vs-incoming would be a second spelling of the same idea, the one option the task's
design doc rejects outright. The honest cost, paid deliberately: `deployer.ts` also pulls in
`node:fs`, `node:path`, `fleet-control.js` and `ledger.js`, and this module loads at CLI entry
for EVERY verb, so this does widen the startup graph of the whole CLI -- the alternative
(moving `treeFfSafe` to a smaller shared home) would touch `deployer.ts`, which is outside
this task's declared file scope.
```

## Module header

Removed from `src/lib/self-sync.ts` lines 19-72 at the base commit.

```text
CLI self-freshness at entry (W1-T79) — the "stale-binary" class.

LIVE INCIDENT (2026-07-16, operator-reported): `rmd correct` existed on `main` (#138) but
the operator's invocation printed the OLD usage and exited — `run-task` had just built the
feature from a FRESH origin/main worktree while the CLI the operator was actually running
predated its own merge. W1-T60 made rmd self-sync the PLAN (dispatch always reads
`origin/main`'s blob, never a local checkout — see {@link syncPlanFromOrigin} in
../run-task.ts). Nothing self-synced the CODE. The operator should never be the freshness
mechanism — "rmd should be managing git for me" is the requirement, verbatim. This module is
the CODE half of that pair.

CONTRACT (mirrors W1-T60's shape, one rung earlier — before ANY command dispatches):
  - UP-TO-DATE (local HEAD === origin/main): zero output, zero mutation, zero added latency
    beyond the fetch already being performed.
  - CLEAN + BEHIND, and a fast-forward is possible: `git merge --ff-only origin/main` (the
    fetch already happened, so this is local-only — no second network round trip), print ONE
    line (`### rmd self-sync: <old>..<new>`), then invoke the caller's `reexec()` — the
    freshly pulled code must be what actually runs; a pulled-but-stale PROCESS is the same
    bug wearing a fix, since the already-loaded module graph in this process is unaffected by
    a merge that happens after it was imported.
  - DIRTY, or CLEAN-but-DIVERGED (not a fast-forward): NEVER mutate the working tree or
    local branches. Refuse with the exact remedy (`git pull --ff-only`, run by the operator)
    and a non-"proceed" result so the caller exits non-zero — the control surface never falls
    through on staleness (the bad-input doctrine this codebase already applies to unknown
    commands/args applies equally to a stale binary).
  - The LOOP GUARD: {@link SELF_SYNC_GUARD_ENV} set to `"1"` in the environment skips the
    WHOLE check (not even a fetch) and returns immediately. A real re-exec sets this on the
    child's env before replaying the invocation, so the freshly-execed process cannot
    recurse into another sync attempt no matter what it finds (even a second, unrelated
    staleness would just run once-stale rather than loop).

DEGRADED-ON-FETCH-FAILURE, BY DESIGN (read before "fixing" this to fail closed): this is a
best-effort UX freshness check bolted onto EVERY subcommand's entry, not the fail-closed
PLAN-dispatch gate `syncPlanOrRefuse`/`GitFetchError` already enforce for run-task/drain/
daemon (that gate is unchanged by this module and still refuses a plan dispatch on a hard
fetch failure unless `--allow-stale`). Refusing to run `rmd anything` just because the
network hiccuped once would make the operator's own machine the single point of failure for
commands (e.g. `rmd --help`, `rmd wipe-test`) that have nothing to do with git dispatch — so
a fetch or rev-parse failure here degrades to "can't tell, don't block the command" rather
than refusing. This is a deliberate, asymmetric choice from the fail-closed PLAN gate; it is
recorded here so it reads as a decision, not an oversight.

DAEMON NOTE (per the design doc, verbatim): this covers CLI/daemon STARTUP only — the one
moment a fresh process decides what code to run. A long-RUNNING daemon process's in-process
staleness (code that was fresh at boot but origin/main has since moved on, while the process
keeps running against its already-loaded module graph) is the WS-2 self-updater's separate
remit (see the daemon-freshness sibling task, which explicitly shares this module's
freshness PREDICATE rather than duplicating it, but owns its own restart-under-
SuccessfulExit=false semantics and thundering-herd concerns) — out of scope here.

NOT TOUCHED: `src/lib/deployer.ts`'s daemon self-deploy/supervisor mechanism is a distinct,
already-shipped system; this module does not read, write, or otherwise interact with it.
```

## SelfSyncDeps.log

Removed from `src/lib/self-sync.ts` lines 104-122 at the base commit.

```text
W1-T486: one ledger-shaped line per DISTINCT refusal reason per process (at most three
calls per invocation, in practice one) — the same `log?: (step, extra?) => void` shape
already used by `ArmDeps`/`DiagnoseThenRetryDeps`/etc., no-op by default so every existing
caller and fake keeps working unchanged.

Before this, `dirty`/`diverged`/`off-main` were stderr-only: nobody could say how often one
refusal reason fires versus another (the question W1-T446's ruling is blocked on). Carries
`reason` and the two shas already in the `warn()` message; for `reason: "dirty"` ALSO a
`count` of dirty paths -- NEVER the paths themselves, which are content a ledger row must
not carry (a dirty tree can hold customer/credential material).

Deliberately NOT wired to a real ledger here: `self-sync.ts` imports no config/ledger
today, and acquiring one via `loadConfig()` would pull in `resolveClaudeBin()`, which
throws where no claude binary exists -- exactly the "runs anywhere" hazard `ci-parity.ts`
exists to catch. A caller that already holds a ledger handle wires this sink; this module
never acquires one itself.
```

## SelfSyncResult (the worktree state)

Removed from `src/lib/self-sync.ts` lines 131-140 at the base commit.

```text
W1-T452: this repoDir is a LINKED WORKTREE, so self-sync declines to refuse OR to mutate.

A DISTINCT STATE RATHER THAN `guarded`, deliberately. `guarded`'s own doc says it skips
EVERYTHING, "not even a fetch" — returning it from a point AFTER the fetch has already run
would make that doc false, and the loop-guard meaning is worth keeping unambiguous. Only one
consumer branches on this type at all (`freshness.status === "refused"` in `run-task.ts`'s
gate), so a new arm costs nothing and reads honestly at every call site.
```

## alreadySelfSynced

Removed from `src/lib/self-sync.ts` lines 171-192 at the base commit.

```text
Is THIS process already a self-sync re-exec child?

THE GUARD MUST BE READ FROM WHERE {@link defaultReexec} WRITES IT. `defaultReexec` spawns the
child with {@link SELF_SYNC_GUARD_ENV} in the CHILD PROCESS'S ENVIRONMENT — it has no way to
reach into whatever object that child's caller will later hand to {@link checkCliFreshness}.
Reading only the injected `env` argument therefore misses the guard entirely whenever the
caller passes anything other than `process.env`, and re-entrancy is a property of the PROCESS,
not of one call's argument.

MEASURED (#2237, six killed runners across four attempts of `ci` AND `coverage-ratchet`): a
caller passing a literal `{}` never saw the guard, so each re-exec child re-ran the same code
path, called `reexec()` again, and blocked in `spawnSync` forever — an unbounded chain of full
`node --test` processes. The log signature was 507 `### rmd self-sync:` emissions with ZERO
tests completing, against a green-run control of 0. `isCiEnv({})` is false for the same reason,
so CI's own short-circuit could not stop it either.

The injected argument still WINS when it carries the guard, so a test can force the guarded
branch with a plain object exactly as before; this only ADDS the process-level channel that a
spawn can actually cross. Note the deliberate consequence: exporting `RMD_SELF_SYNC_DONE=1`
into a shell and running the suite there guards every call — which is what that variable means.
```

## the worktree detection block

Removed from `src/lib/self-sync.ts` lines 244-276 at the base commit.

```text
W1-T452: A LINKED WORKTREE IS SUPPOSED TO HAVE DIVERGED — THAT IS WHAT A BRANCH IS.

A worktree sits on `run-<taskId>-<epochMs>`, so from its FIRST COMMIT it is no longer an
ancestor of origin/main and the `diverged` refusal below fires. `main()` turns any `refused`
into `process.exit(1)`, so every subsequent verb died IN THE PLACE THE WORKER WAS TOLD TO WORK.
MEASURED: fourteen of the last fifteen implement runs relocated to the daemon's live checkout to
run `check-proof`, `preflight --ci-parity`, `review` and `gh pr create` — and their commits
landed there as collateral, which is the actual damage.

IT MUST CLEAR *BOTH* REFUSALS, and that is why this sits above `dirty` rather than beside the
divergence test. A worktree trips `diverged` once it has a commit, but a worktree that is merely
BEHIND and still fast-forwardable falls through to W1-T445's `off-main` refusal instead — same
exit 1, different reason. Clearing only `diverged` would leave the worker refused for the other
one and look like the fix had failed. It also skips `dirty`, which a worktree mid-task always is.

PLACED AFTER THE FETCH ON PURPOSE: the fetch has already run by here, so a verb that wanted
origin refreshed still gets it. Only the REFUSALS and the ff-merge are skipped — and the merge
must never run here anyway, which is precisely what W1-T445 established.

DETECTION IS GIT'S OWN DEFINITION OF A LINKED WORKTREE: `--git-dir` differs from
`--git-common-dir`. MEASURED at ab85e661 on all four shapes — linked worktree
(`…/.git/worktrees/<name>` vs `…/.git`) => true; main checkout (`.git` vs `.git`) => false;
a SUBDIR of the main checkout => false; a directory with no `.git` => throws.

THE PATHS MUST BE RESOLVED BEFORE COMPARING AND THE RAW STRINGS MUST NOT BE. From a subdir git
answers `--git-dir` ABSOLUTE and `--git-common-dir` RELATIVE (`/…/.git` vs `../.git`) — string-
different, same directory. A raw comparison would classify the operator's own checkout as a
worktree and relax the guard exactly where it protects a human, which is strictly worse than the
defect it fixes.

A THROW IS CAUGHT AND FALLS THROUGH, never propagates: with no `.git` at all this function
already returns `degraded` from the fetch above, and that path must keep working — `/app` in the
container image has no `.git`, and this must not start throwing where it used to degrade.
```

## the dirty-tree scope check

Removed from `src/lib/self-sync.ts` lines 296-341 at the base commit (three separate comments
inside and around the `porcelainRaw` block, kept together here as one incident record).

```text
W1-T446: THE CONDITION THIS REFUSES ON IS NOT THE HAZARD IT NAMES. An unscoped
porcelain check refuses on ANY dirty path, even one the incoming fast-forward would never
touch (a stray untracked directory is not a hazard to a merge that never writes it). Scope
it to the same predicate `treeFfSafe` already uses for the deploy supervisor: intersect the
dirty paths against the paths the fast-forward would actually write. The diff is read
LOCALLY -- `fetch` already ran above, so `git diff --name-only HEAD..origin/main` costs no
second network round trip.

PORCELAIN PARSING MATCHES `deployer.ts`'s `dirtyFiles()` byte-for-byte (`XY path`, slice
past the two-char status + one space, off the RAW per-line string) -- not a second
spelling of that parse either.

`sameAsIncoming` is deliberately OMITTED: the lossless byte-identical discard is a strictly
larger, tree-MUTATING change (design (iv)) not needed to fix the observed incident, so every
path that overlaps the incoming diff here is treated as a real conflict, never silently
discarded.

Dirty, but NOTHING dirty overlaps the incoming diff -- e.g. an untracked scratch file, or a
modified tracked file the fast-forward never touches. Not the hazard the guard exists to
catch; fall through to the remaining checks exactly as a clean tree would.
```

## the W1-T445 branch guard

Removed from `src/lib/self-sync.ts` lines 368-407 at the base commit.

```text
W1-T445: THE REF THIS WOULD MOVE MUST BE `main`, and until this check existed nothing asked.
The three refusals above protect the WORKING TREE and the HISTORY; none of them protects the
REF. `repoDir` is `resolveRepoRoot(argv, process.cwd())` -- the toplevel of wherever the verb
was invoked -- so inside a worktree this function was handed that worktree and would advance
ITS branch. Observed: a session cut `run-W1-T445-…` at 14:47, ran one unguarded verb at 14:52,
and the reflog recorded `merge origin/main: Fast-forward` on that branch before its first
commit. Nothing was lost, but the base it was measuring against moved mid-task.

WHY THE BRANCH AND NOT "AM I THE INSTALL": that question cannot be answered from inside this
process. `bin/rmd` execs `$DIR/src/run-task.ts` relative to ITSELF, so a worktree's own
`./bin/rmd` loads that worktree's `src/` and `import.meta.url` resolves there too -- every
checkout believes it is the install. The branch is the property that is actually legible, and
it matches the scope the CI guard above already states in prose: an interactive-operator
convenience for the operator's own `main` checkout.

A DETACHED HEAD REFUSES TOO, DELIBERATELY. It moves no branch ref, so nothing is "lost" -- but
this repo cuts `git checkout --detach origin/main` constantly to run a BASE-side full glob, and
silently advancing that HEAD would turn a base-vs-head comparison into head-vs-head. That is a
wrong ANSWER rather than a lost ref, which is worse.

PLACED HERE, AFTER the divergence check, ON PURPOSE: it speaks only in the case that would
otherwise have mutated. A branch check earlier would print a refusal on every verb run from a
worktree that happens to be behind, which is most of them, and noise on a healthy path is how a
real warning stops being read.
```

## currentBranch

Removed from `src/lib/self-sync.ts` lines 422-435 at the base commit.

```text
The branch HEAD points at, or `undefined` for a detached HEAD.

`git symbolic-ref --short -q HEAD` is the read that answers this WITHOUT guessing, and the
alternative was rejected on MEASURED behaviour rather than taste: on a detached HEAD
`rev-parse --abbrev-ref HEAD` prints the literal string `HEAD` (verified), so it reports a
plausible branch NAME for a state that has no branch at all. `symbolic-ref -q` exits 1 there
and prints nothing, which is the difference this function is built on; `-q` also keeps the
detached case off stderr.

W1-T119 SHAPE: a git failure and a detached HEAD both land in the catch and both return
`undefined`, which is correct HERE only because the caller treats "not provably on main" as
REFUSE — the fail-closed direction. A reader that fails to answer must never license the mutation.
```

## checkServiceFreshness (module doc)

Removed from `src/lib/self-sync.ts` lines 478-501 at the base commit.

```text
A LONG-RUNNING SERVICE's freshness ASSESSMENT (`rmd daemon`, `rmd serve`) — W1-T255.

Unlike {@link checkCliFreshness} (the interactive-operator path that ff-syncs+re-execs on
clean+behind and REFUSES with exit-1 on dirty/diverged), a long-running service must NEVER
exit-1 on tree state and NEVER self-re-exec:
  - DIRT NEVER BLOCKS A SERVICE. The daemon writes into its OWN working tree (DECISIONS.md
    decision records, feedback captures, `state/` runtime exhaust), so a dirty tree is its
    normal steady state — the #707-aftermath incident was checkCliFreshness's dirty-refusal
    crash-looping the daemon on every launchd restart. Dirty => report it, run anyway.
  - BEHIND ORIGIN is the DEPLOY SUPERVISOR's remit (WS-2, {@link ../lib/deployer}), not a
    per-CLI-entry re-exec (which would thundering-herd every service). Behind => report it,
    run the stale code, leave catch-up to the supervisor.
  - GENUINE CORRUPTION (an unreadable/unparseable plan) is NOT this check's job — it still
    fails loudly downstream in loadPlan. Freshness never manufactures a refusal from it.

This ASSESSES ONLY (no mutation, no re-exec, no refusal); the caller ledgers
`daemon.tree_dirty` / `daemon.stale_code` and proceeds. A fetch/rev-parse failure degrades to
"can't tell" — still run (a service is never blocked by a network hiccup).
```

## checkServiceFreshness (the -uno alignment)

Removed from `src/lib/self-sync.ts` lines 526-552 at the base commit.

```text
dirty and behind are INDEPENDENT facts (a tree can be both) — the caller ledgers each.
`-uno` — TRACKED MODIFICATIONS ONLY, and this MATCHES `deploy/entrypoint.sh` EXACTLY, which is
the whole point rather than a tidy-up. This value now drives a RESTART DECISION (#1706 wires it
through `daemonFreshnessFromService` to the daemon's freshness guard), and the thing that must
succeed after that guard fires is the entrypoint's sync. That script tests
`git status --porcelain -uno` and refuses on any TRACKED modification, so a guard counting
UNTRACKED files was strictly stricter than the step it gates: one stray untracked path
suppressed a restart the entrypoint would have serviced happily. Not hypothetical here — an
untracked `.claude/` blocked the operator's self-sync TWICE in one day before it was ignored.

ALIGNING DOWN IS SAFE IN THE ONLY DIRECTION THAT MATTERS: it can only ever PERMIT restarts the
entrypoint can complete, never permit one it would refuse. The opposite alignment — an
INTERSECTING predicate, as `treeFfSafe` uses — would be actively wrong here, and deliberately
so: `treeFfSafe` governs the MINI's deploy supervisor, while the script that must succeed after
a stale exit on AZURE is `entrypoint.sh`, which refuses on ANY tracked modification, unscoped,
and says so in its own refusal text. An intersecting guard would report stale on a tree the
entrypoint then refuses to sync — same sha, same staleness, exit again: the relaunch storm
`DaemonStopReason`'s doc says must never reach an exit. That divergence is DECLARED, not
accidental, so this aligns with the entrypoint and NOT with the deployer.

`checkCliFreshness` above now intersects its dirty check against the INCOMING diff (W1-T446)
rather than against `-uno`/tracked-only, and for a DIFFERENT reason than the alignment
argued above: it must still refuse a tracked OR untracked path the fast-forward would
actually overwrite, which `-uno` alone would silently miss. This assessing sibling stays on
`-uno`, unscoped by the incoming diff, on purpose: it aligns with `entrypoint.sh`'s own
tracked-only, unintersected check for the reason above, and that alignment is orthogonal to
W1-T446's fix to the OTHER function's refusal.
```

## daemonFreshnessFromService

Removed from `src/lib/self-sync.ts` lines 558-601 at the base commit.

```text
{@link ServiceFreshness} → {@link DaemonFreshness}: the ADAPTER that finally supplies
`DaemonDeps.checkFreshness` (daemon.ts). W1-T126 shipped the consumer in 2026; its only
writers were ever test fakes, so `deps.checkFreshness?.()` was `undefined` on every
production boot and the stale self-restart has NEVER fired — measured on the Azure daemon's
own ledger, 0 `daemon_selfrestart_for_freshness` rows in 6,838.

WHY THIS PREDICATE AND NOT {@link checkCliFreshness}, which the W1-T126 doc gestured at.
checkCliFreshness cannot answer the question AT ALL on a container, for two independent
reasons, and the first is fatal rather than merely undesirable:
  1. IT REFUSES. `deploy/entrypoint.sh` boots the daemon with `git checkout --detach`, so
     the checkout is on a DETACHED HEAD (verified on the live container). W1-T445's branch
     guard refuses exactly that — `{ status: "refused", reason: "off-main" }` — a result
     with no sha pair and no `stale` field, which does not fit `DaemonFreshness` in any
     direction. The mutation objection below is almost secondary to this one.
  2. IT MUTATES. It ff-merges and re-execs. A daemon must never re-exec itself (that is the
     supervisor's job) and must never move a ref as a side effect of ASKING a question.
checkServiceFreshness is the sibling built for exactly this caller: read-only, fetch-then-
compare, works detached because it compares SHAs rather than branch names, and degrades to
"can't tell" on a network hiccup. Nothing here needs to fetch the code — the entrypoint
already clones-or-fast-forwards on every boot, so the daemon's whole job is to DETECT and
exit non-zero; `daemonExitCode("stale")` is 1 and docker's `--restart=on-failure` (launchd's
`KeepAlive{SuccessfulExit:false}` on the mini) does the rest.

EVERY NON-`assessed` STATUS IS `{ stale: false }`, deliberately. `guarded` (a CI job, or
`RMD_SELF_SYNC_DONE=1`) and `degraded` (fetch failed) both mean "I could not tell", and the
fail-safe direction for a restart trigger is NOT to restart — the W1-T255 doctrine that a
service is never blocked, or here bounced, by a network hiccup.

AND A DIRTY TREE IS NOT STALE, which is the one clause that is not a straight translation.
`behind` alone would be a RESTART LOOP: entrypoint.sh REFUSES to sync a tree with tracked
modifications ("REFUSING to sync: the work tree has uncommitted changes"), so the restarted
container comes back on the SAME old sha, reads the same staleness, and exits again — the
relaunch storm `DaemonStopReason`'s own doc says must never be allowed to reach an exit
(the 2026-07-22 `paused` incident, ~10s apart until bootout). Restarting is only correct
when a restart can actually CLEAR the condition, and on a dirty tree it provably cannot.
The staleness is still recorded: `serviceFreshnessGate` (run-task.ts) ledgers
`daemon.stale_code`/`daemon.tree_dirty` from this same predicate at boot.

`installNeeded` is deliberately never set, so `DaemonDeps.runInstall` stays unwired. It
would be redundant: the restart re-enters `serviceFreshnessGate`, which already calls
`ensureInstallFresh(repoDir)` on every `rmd daemon` boot — the install-then-restart ordering
W1-T151 asks for, already satisfied one layer up, on the path a restart is guaranteed to take.
```
