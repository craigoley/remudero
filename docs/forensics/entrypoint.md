# entrypoint.sh comment forensics

The measured incidents, rejected alternatives and design arguments that were removed from
`deploy/entrypoint.sh` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the script's own prose,
verbatim, under a heading naming the step it explained. The script itself keeps a one-line `# Why:`
pointer wherever the history mattered.

`deploy/entrypoint.sh` is a **baked** path: it is copied into the image as
`/usr/local/bin/rmd-entrypoint`, so a merge here ships nothing at runtime until an operator
rebuilds the image (CLAUDE.md, "CI and merging").

Line numbers below are positions in `deploy/entrypoint.sh` at the merge base of the compaction PR.

## The file header

Removed from lines 2-19.

WHY. The image carries a source SNAPSHOT at /app with no `.git`, and three separate diagnoses on
Azure turned out to be that one fact: `rmd status` warns the cwd is not inside a git work tree,
`resolveOwnerRepo` throws because `git config --get remote.origin.url` fails, the deployer has
nothing to fast-forward and `checkCliFreshness` has nothing to freshen. The operator worked round
it by cloning into the volume by hand — and that clone went stale (branched one commit behind
origin, producing a scope-guard refusal three phases into a run), lost its node_modules, and
needed its remote set with a token by hand. This script is the automation of the workaround, with
the failure modes it hit closed.

WHAT IT DOES NOT DO. It does not decide when to reinstall dependencies, and it does not sync a
dirty tree. Both already have owners in this codebase and duplicating them would be worse than
leaving them alone — see the notes at each step.

SKIPPING IT. `RMD_SKIP_BOOTSTRAP=1` runs the command with no clone, no fetch and no install. That
is the right mode for probing the image itself (`deploy/verify-image.sh` bypasses this script
entirely by overriding the entrypoint, so its checks are unaffected either way).

## Git identity — why it runs before the skip

Removed from lines 26-50.

GIT IDENTITY IS NOT PART OF THE BOOTSTRAP, SO IT MUST NOT BE SKIPPED WITH IT. THIS BLOCK USED TO
SIT BELOW THE SKIP, AND THE SKIP `exec`s — it never returns. So `RMD_SKIP_BOOTSTRAP=1` left the
container with NO identity at all, and MEASURED on the published image that is exactly what
verify-image.sh's uid-1000 commit probe hit:
`fatal: unable to auto-detect email address (got 'node@<container>.(none)')`.

WHICH SIDE WAS WRONG, since the probe could equally have been retargeted. Three reasons it is this
file:
  1. The skip's OWN log line enumerates what it skips — "no clone, no fetch, no install". An
     identity is none of those three. It was filed inside a block whose stated scope excludes it.
  2. The skip is this script's DOCUMENTED RECOVERY PATH: two failure messages below tell an
     operator to re-run with RMD_SKIP_BOOTSTRAP=1 to inspect a broken tree by hand. Someone
     salvaging uncommitted work is precisely who needs to be able to commit, and that was the one
     path with no identity.
  3. It costs two local `git config` calls — no network, no token, no clone — so making it
     unconditional keeps the verifier's check token-free and runnable on every verification,
     rather than only when credentials happen to be around.
The honest counter-argument, recorded rather than buried: a WORKER never sets
RMD_SKIP_BOOTSTRAP=1, and on the normal path this write already happened BEFORE the clone. So
production was never broken, and the probe's "every worker commits NOTHING" wording overstates
what it measured. That is a defect in the message, not a reason to leave the recovery path unable
to commit.

`mkdir -p` first: `git config --global` writes $HOME/.gitconfig and FAILS OUTRIGHT if HOME does
not exist (the same trap recorded further down).

## Git identity — the report-vs-write asymmetry

Removed from lines 57-63.

`git -C /` HERE TOO, for the same reason the guard above uses it — and it was missed the first
time. A bare `git config --get` resolves LOCAL config, so when the cwd happens to be inside a
repository this line reports THAT repository's identity rather than the global one just written.
MEASURED by a test booting from a checkout: it wrote `remudero-worker` and then announced
`Claude <noreply@anthropic.com>`, the checkout's own committer. The write was always correct; the
REPORT was not, which is the worse half — a boot log that names an identity the commits will not
use is how you diagnose the wrong thing for an hour.

## `REF` — the pin, and what it recovers

Removed from lines 74-85.

Cloning at startup breaks the property the image digest used to carry: today a digest names
exactly what will run, and a container that clones runs whatever the ref held at boot. RMD_REF is
how that is recovered — it takes a branch, a tag or a full commit sha, so an operator who needs
"run exactly this code again" pins a sha and gets it back.

THE DEFAULT IS `main` RATHER THAN A PINNED SHA, and that is a deliberate trade rather than
laziness. A sha default would have to be edited into this file and rebuilt to move, which is the
very rebuild-to-change-code cost this whole change exists to remove; and a stale default is worse
than no default, because it silently runs old code while looking pinned. `main` is what a fleet
host is supposed to be on — the mini's own self-sync fast-forwards to origin/main — so the default
matches the fleet and the pin is there when reproducibility matters more than currency.

## `CONFIG_ROOT` / `TREE`

Removed from lines 88-90.

config.root is `$HOME/Remudero` (loadConfig, src/lib/config.ts), and the fleet's own checkout sits
beside the state it manages. Deriving both from HOME rather than hardcoding keeps this consistent
with the image's ENV HOME and with the volume the operator mounts.

## Credentials — a helper, not a token on disk

Removed from lines 95-111.

MEASURED: `gh auth setup-git` REFUSES with only GH_TOKEN set — "You are not logged into any GitHub
hosts" — so the obvious one-liner is not available.

The two forms that DO work both write the token to disk: a token-bearing remote URL puts it in the
clone's .git/config, which lives in the mounted volume and therefore OUTLIVES the container; a
`url.insteadOf` rewrite puts it in a gitconfig. Both also go stale the moment the token rotates,
and a stale token baked into a remote is a confusing failure.

A credential helper avoids both: the token is read from the environment AT CALL TIME, so it is
never written anywhere, and rotation is just a new `-e GH_TOKEN`. The helper is stored with
`$GH_TOKEN` UNEXPANDED — single-quoted here so this shell does not substitute it — and git's own
shell expands it when it runs. The remote URL stays clean.

`git config --global` writes $HOME/.gitconfig and FAILS OUTRIGHT if HOME does not exist — "could
not lock config file". The image creates /home/node, so this only bites a container started with a
HOME that was never made; creating it costs nothing and removes a boot failure whose message says
nothing about the real cause. Found by running this script, not by reading it.

## Credentials — installed unconditionally (W1-T2552)

Removed from lines 114-129.

W1-T2552: INSTALLED UNCONDITIONALLY. The helper's whole point is that it reads $GH_TOKEN AT CALL
TIME, so whether the variable holds anything AT BOOT says nothing about whether it will hold
something when git actually runs — and since W1-T2311 the boot env deliberately carries an EMPTY
GH_TOKEN, so the `-n` gate that stood here was false on every boot and the helper was NEVER
installed. The daemon then minted a perfectly good App installation token into its own
`process.env.GH_TOKEN` (github-app.ts's one seam), every git child inherited it, and git ignored
it because nothing told git that variable was a credential. MEASURED 2026-08-30: every ref-CAS
write died `fatal: could not read Username for 'https://github.com': No such device or address`,
which `classifyPushFailure` reports as "unreachable" — while reads kept working, because this repo
is public and an anonymous read needs no credential at all. That split (reads fine, writes dead) is
what made it read like a permissions problem for an hour.

INSTALLING IT WITH AN EMPTY GH_TOKEN IS SAFE AND IS THE POINT: the helper then answers with an
empty password, which is exactly what an unauthenticated push would have done anyway, and the
moment the App token lands in the environment the SAME helper starts answering with it. Nothing is
written to disk but the helper script itself, which contains `$GH_TOKEN` unexpanded.

## The commit identity — why it must exist, and why it lives here

Removed from lines 137-185.

MEASURED on the published image, as uid 1000 with this entrypoint bypassed:
  git config --global --list
  → fatal: unable to read config file '/home/node/.gitconfig': No such file or directory
and from a real `preflight --ci-parity` in a container:
  Author identity unknown
  fatal: unable to auto-detect email address (got 'node@817837271c3e.(none)')

GIT CANNOT AUTO-DETECT HERE, and the `.(none)` in that message is exactly why: git will fall back
to `user@host` only when the hostname looks fully qualified. A container's hostname is a bare
container id, so the fallback is refused and `git commit` fails outright.

THIS IS THE SAME ASYMMETRY AS THE gh CREDENTIAL AND PLAYWRIGHT_BROWSERS_PATH — a FILE that exists
on the operator's Mac and simply does not exist here. `WORKER_HOME_SYMLINKS` (src/lib/worker-home.ts)
grants `.gitconfig` into every per-run worker HOME with the reason recorded verbatim as "git author
identity for commits the worker makes", and `materializeWorkerHome` SKIPS a grant whose source is
absent. So on darwin the worker inherits the operator's identity and in a container it silently
inherits nothing. Writing $HOME/.gitconfig here is what makes that existing grant resolve — no
change to src/ is needed, and both the worker AND the orchestrator's own commit sites
(plan-architect, plan-pr-emitter, orientation, the triage/approve paths, none of which passes
`-c user.name`) are covered by the one write.

WHY THE ENTRYPOINT AND NOT THE IMAGE. The identity that 63 of 64 merged `Remudero-Task:` commits
actually carry is `Craig Oley <craigoley@gmail.com>` — the OPERATOR'S OWN, straight out of their
`~/.gitconfig`. That is a person, and a person does not belong baked into a published image: it is
not the fleet's to assert, it changes, and the image is shared. So the identity is configurable
here, defaulting to a purpose-scoped bot in the same shape this repo already uses twice
(`rmd-feedback-bridge@users.noreply.github.com` in src/lib/feedback-landing.ts, and
`${GIT_AUTHOR_NAME:-remudero-heartbeat}` in scripts/fleet-heartbeat.sh — defaulted but
overridable). TO KEEP HISTORY CONSISTENT WITH THOSE 63 COMMITS, run the container with
`-e RMD_GIT_AUTHOR_NAME='Craig Oley' -e RMD_GIT_AUTHOR_EMAIL=craigoley@gmail.com`.

`--replace-all` rather than a bare set, so a re-boot onto an existing volume cannot accumulate
duplicate keys; and the values are only written when git does not already resolve one, so an
operator who mounted their own gitconfig keeps it.

`git -C /` ON THE PROBE, and it is load-bearing rather than tidy. A bare `git config --get`
resolves LOCAL config too, so if this script's cwd happens to sit inside a repository, that
repository's own `.git/config` can answer the question — and the worker does not commit there, it
commits in a worktree under $HOME/Remudero. Probing from `/`, which is not a repository, restricts
the answer to the system and global scopes, i.e. exactly the ones a commit anywhere in this
container would inherit. (Found by running this block, not by reading it: the first draft reported
"already configured" off the checkout's own local config.) A SYSTEM identity still satisfies it —
that is deliberate, since one would make commits work without this write.

THE WRITE ITSELF NOW RUNS ABOVE THE RMD_SKIP_BOOTSTRAP BLOCK, not here — everything above this line
is WHY the identity exists and what it must be; the argument for WHERE it runs is at the top of
this file. It moved because the skip block `exec`s and never returns, so the skip path had no
identity at all, which is what the published image's uid-1000 commit probe measured. Nothing about
the normal path changed: this write already happened before the clone, and still does.

## Resolving `REF` — a branch means the tip at boot, a sha means exactly that

Removed from lines 187-219.

MEASURED ON AZURE 2026-08-08, AND REPRODUCED HERE AGAINST A REAL GIT ORIGIN. A boot printed "Your
branch is behind 'origin/main' by 3 commits, and can be fast-forwarded" and then "checkout:
354f20c" — the OLDER sha — and reported a successful boot. The next dispatch then branched from
stale code, which is W1-T405's scenario arriving one layer upstream.

THE CAUSE WAS A TWO-PART COMPOUND, AND NEITHER HALF IS OBVIOUS FROM READING THE OLD CODE.
  1. `git checkout --detach main` RESOLVES THE LOCAL BRANCH, AND `git fetch` NEVER MOVES IT. The
     default fetch refspec updates `refs/remotes/origin/*` only, so after the initial clone the
     local `main` is frozen at the clone-time sha forever. Detaching onto it therefore walks HEAD
     BACKWARD on every single boot — measured: a tree already correctly at the newest commit was
     moved back to the clone-time sha before anything tried to bring it forward again.
  2. THE ONLY THING THAT CLIMBED BACK UP WAS SILENCED. `git merge --ff-only origin/$REF
     2>/dev/null || true` discarded both the error text and the exit code, so any failure left
     HEAD at the regressed sha and the boot still printed a clean "checkout:" line. Reproduced by
     giving the tree an untracked file that an incoming commit also adds — the tracked-only dirty
     guard above correctly sees a CLEAN tree, git refuses to overwrite the untracked file, and the
     container silently regressed from a good sha to the clone-time one. Once there it stays there:
     every later boot repeats the same walk-back and the same silent failure, so the container is
     pinned at its first-ever checkout while reporting success each time. That is the identical
     shape this script already fixed once, when counting untracked files as dirt made boot 2 refuse
     to sync forever.

SO THE REF IS RESOLVED ONCE, HERE, AND CHECKED OUT IN ONE STEP. `origin/$REF` is tried FIRST, so a
BRANCH name means "the tip as of the fetch that just ran" — which is what a user passing `main`
expects and what the old code was already trying to reach, less reliably, via the merge. Anything
that is not a branch on the remote — a sha, a tag — has no `refs/remotes/origin/<x>` and falls
through to the exact form, so a pin still means exactly what it says. That distinction is the whole
point of RMD_REF and it now holds in both directions.

NOTHING IS SILENCED. A checkout that cannot proceed DIES, loudly, rather than continuing on
whatever HEAD happened to be. Proceeding is the expensive direction: it costs a full run against
stale code and then a scope-guard refusal whose message names a different cause.

## `clear_redundant_untracked` — W1-T1054

Removed from lines 228-264.

A DAEMON-WRITTEN UNTRACKED FILE CAN COLLIDE WITH ITSELF, BY CONSTRUCTION. `feedbackDir`
(src/lib/feedback.ts) writes `plan/feedback/**` INTO THIS SAME WORKING TREE, and `landFeedback`
(src/lib/feedback-landing.ts) lands that identical content upstream as a gated PR but never deletes
the local copy once it has landed — every `rmSync` in that module targets a scratch dir, none
touches the entry. So the next boot's checkout lands on a commit that ADDS the very path the daemon
already wrote locally, byte-for-byte, and the tracked-only dirty guard above (deliberately, see its
own comment) does not see it — this is the collision `checkout_target`'s CHECKOUT FAILED message
already names as "a common cause". It is guaranteed by the daemon's own routine work, not a race,
and it is safe to clear in exactly the one case it can PROVE redundant.

THE PREDICATE, CITED RATHER THAN RE-DERIVED. `treeFfSafe` (src/lib/deployer.ts) intersects dirty
paths against the INCOMING diff and only conflicts on the overlap; `rmd sync` (W1-T907) already
classifies a local path as provably lossless when its bytes equal the origin blob at that path.
This is that same predicate, in bash, at boot: an untracked path is removable ONLY IF the incoming
target ADDS that same path AND the local bytes are IDENTICAL to the incoming blob there. Anything
else — untracked and not in the incoming diff, or in it with different content — is left alone, so
the checkout below fails exactly as it always has and the operator sees the same diagnosis.

BYTES, NOT TEXT. Comparing content requires reading it into a shell string, which mangles binary
data and trailing newlines. `git hash-object` on the local path against the incoming blob's own sha
compares bytes exactly, through git's own hashing, with no string handling in this script at all.

UNREADABLE MEANS REFUSE, NOT "TREAT AS SAFE". `git rev-parse "$target:$path"` resolves the blob sha
from the TREE object alone — it does not need the blob's content to be present locally, so it can
succeed even when the object itself is missing or corrupt (a partial fetch, a damaged store). Only
`git cat-file -e` actually opens the object, so that is the read this function trusts before
calling anything redundant. When it fails, the path is NOT provably safe and stays in place —
fail-closed, matching the tracked-only guard's own posture.

EVERY CLEARED PATH IS NAMED, ALWAYS. Removing an untracked file is how uncommitted real work
disappears if the predicate is ever wrong, so nothing here removes a path without first logging
which one and why — the log must show what was discarded even on a boot that then succeeds.

NOT IN SCOPE (see plan/tasks.d/W1-T1054-*.yaml): relocating the daemon's feedback write, which has
a reader and would silently drop unlanded filings; teaching `landFeedback` to clean up after
itself, a real and separate candidate; detecting the outage this caused (W1-T1047, already filed);
and the restart budget above, which is correct as it stands.

## `boot_fetch` — the ref-lock retry (W1-T2501)

Removed from lines 296-314.

MEASURED (operator-log#cannot-lock-ref-2026-08-30): the boot fetch failed to lock THREE refs in one
call — `refs/remotes/origin/main`, `heartbeat-mini` and a feature branch — the signature of another
git process holding them, not of corruption; the holder finishes. The old code made exactly ONE
attempt, logged one line and carried on: the daemon booted on the stale tree that produced, and the
advisory id mint two commands later read a corpus four ids behind.

THE RETRY KEYS ON THE LOCK, NEVER ON FAILURE GENERALLY — a narrower claim than "retry transient
failures". `cannot lock ref` / `unable to update local ref` is git's own wording for exactly this
case: another process held the ref when this one reached for it. A network failure or an auth
failure is NOT this case, must NOT be retried into a longer boot, and keeps today's single-attempt,
fail-open behaviour untouched below.

BOUNDED, AND FAILING OPEN STILL SURVIVES. `FETCH_LOCK_RETRY_MAX` caps the attempts and
`FETCH_LOCK_RETRY_PAUSE_S` is the backoff between them, so a boot can never wait on this
indefinitely. An exhausted retry does not die — the neighbouring housekeeping step's own principle
holds here too: a boot must not refuse to start because origin was briefly unreachable — it is
reported as a NAMED STALE BOOT (grep `STALE BOOT`) instead of one line among many, so an exhausted
retry is at least as visible as the daemon's own freshness vocabulary.

## `sync_tree` — pruning dead worktree registrations before the fetch

Removed from lines 372-410.

NOT the same "prune" as the fetch below. `fetch --prune` drops remote-tracking REFS; this drops
WORKTREE ADMIN RECORDS under `.git/worktrees/` whose checkout directory no longer exists. The two
are unrelated and neither does the other's job.

WHY THIS CONTAINER ACCUMULATES THEM. The checkout is a bind mount shared with the host, so
`.git/worktrees/` carries registrations the HOST created, pointing at host paths that have never
existed in here. Measured 2026-08-24T00:40Z inside `remudero-daemon`: 22 such registrations, every
one under `/home/craigoleyagent/work/`.

WHY IT IS LOAD-BEARING RATHER THAN TIDY. `git gc` reads each registered worktree's HEAD. One
unreadable HEAD aborts the whole repack — reproduced: `fatal: bad object worktrees/<name>/HEAD`,
`fatal: failed to run repack`, exit 128. When the abort happens under AUTOMATIC gc it writes
`.git/gc.log`, and git then declines every later automatic cleanup while that file exists
("Automatic cleanup will not be performed until the file is removed"). The daemon's checkout had
not been packed since 2026-08-21: 6,059 loose objects, 65.80 MiB loose, 50.94 MiB packed — 0 / 0 /
18.31 MiB once the registrations went.

AND `git gc` DOES NOT CLEAR THEM ITSELF: `gc.worktreePruneExpire` defaults to three months, so a
registration stale for minutes is still consulted, and still aborts the repack.

BEFORE THE FETCH, DELIBERATELY. The fetch is the first thing here that can trigger an automatic gc,
so pruning first is what stops that gc tripping over a dead registration and writing the `gc.log`
that silences every cleanup after it. Placing it inside `sync_tree` covers BOTH call sites — the
boot path and the freshness restart below — in one line.

A REGISTRATION THIS BOOT CREATES IS NOT PRUNED THIS BOOT, AND MUST NOT BE. Lanes start after this
runs; their worktrees are live, and `prune` removes only records whose directory is ABSENT
("gitdir file points to non-existent location") — verified: a live worktree keeps both its
registration and its files, and no worktree's contents are ever deleted by prune. A registration
created during this boot is therefore cleared at the NEXT restart, which is the only moment it is
safe to clear.

NON-FATAL, AND THAT IS NOT DEFENSIVE PADDING: `git worktree prune` exits 0 on an already clean repo
but 128 when the cwd is not a repository at all, and a boot must not die on a housekeeping step.
Failure is logged and the sequence continues.

THIS DOES NOT CLEAR AN EXISTING `gc.log`, and deliberately so — see the note beside the log line
below.

## `sync_tree` — reporting a stuck `gc.log` rather than clearing it

Removed from lines 421-428.

A REPO ALREADY STUCK STAYS STUCK, AND THE ENTRYPOINT SAYS SO RATHER THAN FIXING IT. `worktree
prune` removes the CAUSE; it does not remove `.git/gc.log`, which is the thing actually suppressing
automatic cleanup — verified directly: a planted gc.log survives a prune untouched. Clearing a
gc.log this script did not write would be deleting another process's only record of why its repack
failed, on a checkout shared with the host, with no way from in here to tell a stale log from one
written seconds ago by a maintenance run that is still going. So this reports it and leaves the
decision to an operator, who can clear it and repack when no lane is running:
  rm -f .git/gc.log && git gc --prune=now

## `sync_tree` — the dirty-tree rule is the deployer's, not a new one

Removed from lines 436-454.

`decideDeploy` (src/lib/deployer.ts) guards its fast-forward with a clean-tree check whose comment
is explicit: "abort (never force) on a conflicting dirty tree", reported as `dirty-tree-conflict`.
Uncommitted work is never discarded to make a sync succeed.

THIS TEST IS STRICTLY MORE CONSERVATIVE THAN THAT ONE, and the difference is worth stating rather
than implying parity. `treeFfSafe` intersects the dirty files with the INCOMING files and only
conflicts on the overlap, so it tolerates local edits the fast-forward would not touch. Reproducing
that in shell would mean reimplementing it, badly, in the one place where being wrong destroys
uncommitted work — so this refuses on ANY dirt. It errs toward leaving the tree alone, which is the
safe direction, and it says so rather than silently skipping.

`-uno` — TRACKED MODIFICATIONS ONLY, and this is load-bearing rather than a tidy-up. Plain
`--porcelain` also lists UNTRACKED files, and the first boot creates one immediately by installing
node_modules. Measured: with untracked files counted, the second boot refused to sync and every
boot after it would have done the same — a container permanently pinned to whatever it first
cloned, reporting a reason that sounds like the operator left work behind. Untracked files also
cannot conflict with a fast-forward, which is what `treeFfSafe` is actually about: LOCALLY-MODIFIED
files. This matches that intent and removes the trap.

## `sync_tree` — one step, not checkout-then-merge

Removed from lines 461-464.

ONE STEP, NOT CHECKOUT-THEN-MERGE. The old pair walked HEAD down to the frozen local branch and
then relied on a silenced `merge --ff-only` to climb back — see the resolver above for the measured
regression that produced. There is no merge here because there is nothing to merge: the target IS
the freshly-fetched tip, so a single detach lands on it directly.

## The bootstrap install, and only that

Removed from lines 484-499.

`ensureInstallFresh` (src/run-task.ts) ALREADY solves "should I reinstall": it hashes package.json +
package-lock.json, compares against `.rmd-install-hash` written inside node_modules by the last
successful install, and its own doc states a matching hash is "a total no-op — no redundant
install, ever". Two call sites already wire it. Re-deciding that here would duplicate a mechanism
that is better than anything this script could compute.

BUT IT CANNOT BOOTSTRAP ITSELF. `bin/rmd` ends in `exec "$DIR/node_modules/.bin/tsx"`, so on a
fresh clone with no node_modules there is no way to REACH ensureInstallFresh — every verb dies at
"Cannot find package 'tsx'", which is exactly the failure that killed the hand-made clone. So the
only install this script owes is the first one, conditioned on tsx being absent rather than on
anything about freshness. After that, rmd's own hash decides, as it does on every other host.

This also answers the sharing question the wrong way round on purpose: the clone gets its OWN
node_modules. REQ 4 in the Dockerfile records that one shared install emptied under a running
daemon twice in a week, and /app's install belongs to /app's lockfile, not to this checkout's.

## The restart rate limit — why the container needs one at all

Removed from lines 509-570.

`generateLaunchdPlist` (src/lib/launchd.ts) gives the mini `KeepAlive {SuccessfulExit: false}` plus
`ThrottleInterval` (plan/policy.yaml's `launchd.throttleIntervalS`, 60). Docker's
`--restart=on-failure:N` caps the COUNT, not the RATE — so the container half of that pair is
missing, and the measured precedent is a duplicate task id making the plan unreadable and
crash-looping the daemon at ~5 restarts/minute.

THIS SLEEPS BEFORE EXITING, AND — SINCE W1-T490 — LOOPS FOR EXACTLY ONE CASE. The original text
here rejected looping outright, on two grounds. The FIRST no longer holds and the SECOND still
does, so the block below honours the second and retires the first.

  RETIRED: "The clone/fetch/checkout above runs ONCE, before this line — so an in-container retry
  loop would re-run the daemon against the SAME tree forever and `stale` would never clear." That
  was true only of a loop around `"$@"`. The bootstrap is now the `sync_tree` FUNCTION above, so the
  loop below re-runs the fetch and the checkout before every retry and staleness clears exactly as
  a container restart would clear it.

  STILL BINDING: "IT ALSO LEAVES `--restart=on-failure:N` INTACT, which an internal loop would
  render inert: the container still exits non-zero once per attempt, so N still counts attempts." A
  container that never exits is never counted, so an unconditional loop would delete the crash-loop
  bound entirely. THE LOOP BELOW IS THEREFORE NARROW: it re-enters ONLY on `DAEMON_EXIT_STALE`, and
  every other non-zero exit still falls straight through to the sleep and the exit, so a crash is
  counted by docker exactly as it was.

WHY `stale` HAD TO BE SEPARATED AT ALL. `daemonExitCode` (src/lib/daemon.ts) used to map `blocked`,
`error` AND `stale` onto 1, and docker's `on-failure:N` counts every non-zero exit against N.
MEASURED (Azure, 2026-08-14): the policy cannot read the code — `exit 1` and `exit 42` both parked
at `RestartCount=2` under `on-failure:2` — and health never refunds the budget: containers exiting
after 0s, 20s and 120s of clean work all parked permanently, the only observed reset being a manual
`docker start`. So a freshness restart, which happens ONCE PER MERGE (14 rows in 24 hours), spent
the same finite budget as a crash, and a healthy merging fleet exhausted `on-failure:5` in roughly
half a day. The measured cost was a 2h56m outage — 90% of that day's downtime — that only a human
ended.

THE FIX IS NOT A POLICY CHANGE. `--restart=on-failure:5` is on the operator's `docker run` and is
deliberately left alone: an unbounded `always`/`unless-stopped` would have spun forever on the
MEASURED lock storm of 2026-08-13 22:23:40–22:26:10 (5 boots, 3 exits and 3 "a drain/daemon is
already running" collisions in 150 seconds, arriving 13–17s apart). The bound is wanted. What
changes is only WHICH exits are charged to it.

THE FRESHNESS LOOP IS ITSELF BOUNDED, so nothing here is unbounded in either direction. It retries
at most `RMD_FRESHNESS_RESTART_MAX` times (default 100) and sleeps `FRESHNESS_RESTART_PAUSE_S`
between attempts — NOT the crash throttle. That clause read "the SAME throttle" until 2026-08-18
and had been wrong since the separate pause was introduced in the block below; the two statements
contradicted each other in one file. A pathological restart-storm is still rate-limited and falls
through to a real exit, handing the container back to docker's count. Rate here, count there, still
— the only difference is that routine freshness no longer spends the count.

EXIT 0 IS NEVER THROTTLED. `daemonExitCode` maps stopped/max_reached to 0, and a `STOP` file yields
`stopped` — so an operator stopping the fleet from the host gets an immediate clean exit and
`on-failure` leaves the container down. Sleeping there would delay a requested stop by a minute for
no reason.

THE INTERVAL COMES FROM THE ENVIRONMENT, NEVER FROM THE REPO. plan/policy.yaml is read by
`generateLaunchdPlist` at PLIST-GENERATION time and baked into static XML; launchd never reads the
repo at crash time. Reading it here instead would need the plan loadable at exactly the moment an
unloadable plan is what is crashing the daemon — the measured incident. So the value is supplied at
`docker run` and read from the environment, which is the same bake-it-once shape.

OPT-IN, so the default path is byte-for-byte what it was: unset, this script still `exec`s. That
matters because `exec "$@"` serves every container invocation, not just the daemon, and a one-shot
verb must not acquire a minute of latency on a non-zero exit.

## Why `FRESHNESS_RESTART_MAX` is 100 (measured 2026-08-18)

Removed from lines 601-624.

The note above sizes this budget from a freshness restart happening "ONCE PER MERGE (14 rows in 24
hours)". That rate is gone. MEASURED over the eight complete UTC days ending 2026-08-18, via the
REST pulls API: 29, 41, 54, 58, 63, 71, 73, 86 merges per day — median 63 (4.5x the sizing
assumption) and even the quietest day, 29, is 2.1x it. 56 merges landed in the US-Eastern day of
2026-08-17 alone. At 20 the budget is spent inside a single day, after which a ROUTINE freshness
exit falls through and spends `--restart=on-failure:5` instead — re-creating the exact conflation
of "stale" with "crash" that this whole block exists to undo.

THE WORST CASE THIS NUMBER CREATES, STATED PLAINLY RATHER THAN LEFT TO BE DERIVED:
  FRESHNESS_RESTART_MAX x FRESHNESS_RESTART_PAUSE_S = 100 x 5s = 500s (8m20s)
of in-container ceiling before a freshness exit reaches docker's count. The multiplier is the PAUSE
below, never `RESTART_THROTTLE_S` (120s in production) — the freshness path does not sleep the
crash throttle, which is what the corrected sentence above now says.

AND IT HAS A PRICE, NOT ONLY A CEILING. Every restart re-runs `sync_tree`, whose first act is a real
`git fetch --prune origin`. 100 restarts is 100 fetches against the origin. That cost is accepted
deliberately for the headroom; it is recorded here so the next person raising this number knows
what they are buying and does not have to re-derive it from the loop body.

WHY THE DEFAULT MOVED RATHER THAN THE OPERATOR KEEPING AN ENV VAR: 100 was being carried only as
`-e RMD_FRESHNESS_RESTART_MAX=100` on `docker run`, so any container rebuilt without that flag
silently reverted to 20 with nothing reporting the regression. A default that has to be re-supplied
by hand on every rebuild is not a default.

## The blocked retry — the other half of the freshness loop (W1-T2537)

Removed from lines 648-662.

A `blocked` stop is a COMPLETED drain pass reporting that a task is blocked — not a crash. It was
charged to docker's `on-failure:N` exactly as a crash was, and MEASURED 2026-08-30 that left the
container `Exited (1)` for 46+ minutes after a pass that had dispatched three tasks and opened
three PRs. The loop is self-sustaining: a red board is what PRODUCES blocked passes, so the budget
empties fastest when the fleet is most needed, and once empty nothing drains.

NEITHER NUMBER IS PICKED. The cap MIRRORS `FRESHNESS_RESTART_MAX` above — the same worst-case shape
already ratified for the sibling path, and the bound is what hands a pathological loop back to
docker's count instead of replacing a bound with nothing. The pause is the daemon's OWN
`DEFAULT_POLL_INTERVAL_MS` (60s, src/lib/daemon.ts), documented there as "check back once a minute
while nothing is runnable" — which is exactly what a blocked board is. Deliberately NOT the 5s
freshness pause (a blocked board needs CI wall-clock to change; a stale checkout does not) and NOT
the 120s crash throttle (that exists to slow a boot failing the same way, and this is a pass that
ran to completion).

## Signal forwarding — restoring what `exec` gives for free (W1-T1067)

Removed from lines 697-738.

`exec "$@"` above REPLACES this shell with the child, so the child inherits this pid directly and
every signal tini sends it arrives unmediated. Down here, once the throttle is non-zero, this shell
stays alive as tini's actual child and runs the daemon as a SEPARATE process below — so with no
trap, this shell's own default disposition to SIGTERM is to die immediately, which leaves the
daemon running, now ORPHANED, with nothing forwarded to it, until docker's grace period expires and
SIGKILLs it — too late for `run-task.ts`'s own SIGTERM handler ever to run and release
`state/drain.lock`. MEASURED on the live container (2026-08-20): the process tree under a 120s
throttle carried no node process at all, only this shell asleep in the crash throttle's `sleep`,
because the PREVIOUS restart's node had been SIGKILLed with the lock still held. Forwarding the
signal to the child and waiting for ITS real exit — never dying here first — is what restores
exactly the delivery `exec` gives for free.

THE REAL EXIT CODE IS CAPTURED INSIDE THE TRAP ITSELF, not by resuming the interrupted `wait`
below. Per bash's own documented `wait` semantics: when THIS shell is blocked in the `wait` builtin
and a signal for which a trap is set arrives, `wait` returns IMMEDIATELY with a pseudo-status
greater than 128, and the trap runs right after — so the value that first `wait` produces describes
bash's own interruption, never the child's actual outcome, and resuming that interrupted statement
is not a reliable place to read the child's real code from. The trap's OWN `wait "$child_pid"`
below is a FRESH call, issued once the forward has already been sent and no further signal is
pending, so it blocks for the child's genuine completion and records it in `child_rc` — which the
main loop then prefers over whatever the interrupted `wait` returned.

A HANDLED TERM MUST EXIT 0, OR THE STOP NEVER STICKS (W1-T2586). MEASURED 2026-09-01: `docker stop
remudero-daemon` forwards TERM here, the daemon releases its locks and dies, and the process it
dies AS still carries a non-zero code — the daemon re-raises the signal against itself once its own
cleanup is done (`daemonCommand`'s `onSignal`, src/run-task.ts), so a killed-by-SIGTERM wait status
is 128+15=143. `on-failure` cannot tell 143 from a crash, and the 120s throttle below THROTTLES the
relaunch rather than preventing it — so the operator sees `Exited`, believes the stop worked, and
the container comes back 27 minutes later on its own. A leak that `docker stop` was reached for
specifically to end then ran for a further 24 minutes and ~$45 before anyone noticed it was never
stopped.

`signal_forwarded` IS THE DISTINCTION `daemonExitCode` (src/lib/daemon.ts) CANNOT MAKE FROM INSIDE
THE CONTAINER. That function already maps a real `stopped` reason to exit 0; the defect is that a
SIGNAL-DRIVEN stop never reaches it as `stopped` — Node dies BY the re-raised signal, which has no
reason string at all, only a wait status. But this shell does not need the daemon's own
classification: it knows an operator/supervisor signal arrived, because IT is what received
TERM/INT and chose to forward it. That fact alone is what "handled deliberately" means here, and it
is set exactly once, only inside this handler, only after a live child was actually signalled —
never inferred from the resulting exit code, which is what would risk calling an UNRELATED crash a
clean stop.

## Capturing the child's exit code without losing it to a compound test

Removed from lines 755-766.

CAPTURE THE CODE IN THE SAME COMMAND THAT RUNS IT. `if "$@"; then ...; fi; rc=$?` reads $? from the
COMPOUND, which is 0 when the condition merely tested false — so a crashing daemon exited 0,
docker's `on-failure` saw a success, and the container stayed down through exactly the crash it is
meant to restart. Caught by the non-zero-direction test below, which asserted the propagated code
rather than only the sleep; the sleep and both log lines were already correct.

BACKGROUNDED, NOT FOREGROUND, so the trap above can react while it runs (a foreground `"$@"` leaves
this shell unable to run a trap until the command completes — precisely the delivery gap this block
exists to close). `child_rc` starts EMPTY every pass and is only ever set by the trap above, so an
ordinary, unsignaled exit leaves it empty and `rc` keeps exactly the value the plain `wait` below
already produced — byte-for-byte the prior behaviour on every path this block does not touch.

## The environmental-refusal retry arm (W1-T2546)

Removed from lines 831-838.

THE THIRD CASE THAT DOES NOT SPEND THE BUDGET. An environmental refusal (a GitHub rate-limit 403, a
5xx, a transport fault) is not a crash: nothing about the tree, the plan or the code is wrong, and
the correct response is to WAIT. MEASURED 2026-08-31: two PRs opened successfully, the pass died
reading one back on `API rate limit exceeded ... (HTTP 403)`, and docker counted the restart.
During a lockout window EVERY pass can die that way, so the crash budget drains at the rate the
limiter refuses and the fleet ends up dead with a red board and no failing check to explain it.
Past the cap it falls through to the crash throttle below, so the bound is REPLACED, never removed.

Note: the "W1-T2586: A SIGNAL THIS SHELL ITSELF FORWARDED OUTRANKS EVERY OTHER CLASSIFICATION
BELOW" comment immediately above the main loop's `if [ -n "$signal_forwarded" ]` check was **not**
compacted — `test/an-operator-stop-is-undone-by-the-restart-policy.test.ts`'s `mutate()` helper
matches that exact block (comment and code together) as a unique substring to build its mutant, so
it stays byte-identical to `origin/main`.
