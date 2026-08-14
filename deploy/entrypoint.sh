#!/usr/bin/env bash
# rmd-entrypoint — give the container a REAL WORK TREE before it runs anything.
#
# WHY. The image carries a source SNAPSHOT at /app with no `.git`, and three separate diagnoses on
# Azure turned out to be that one fact: `rmd status` warns the cwd is not inside a git work tree,
# `resolveOwnerRepo` throws because `git config --get remote.origin.url` fails, the deployer has
# nothing to fast-forward and `checkCliFreshness` has nothing to freshen. The operator worked round
# it by cloning into the volume by hand — and that clone went stale (branched one commit behind
# origin, producing a scope-guard refusal three phases into a run), lost its node_modules, and
# needed its remote set with a token by hand. This script is the automation of the workaround, with
# the failure modes it hit closed.
#
# WHAT IT DOES NOT DO. It does not decide when to reinstall dependencies, and it does not sync a
# dirty tree. Both already have owners in this codebase and duplicating them would be worse than
# leaving them alone — see the notes at each step.
#
# SKIPPING IT. `RMD_SKIP_BOOTSTRAP=1` runs the command with no clone, no fetch and no install. That
# is the right mode for probing the image itself (`deploy/verify-image.sh` bypasses this script
# entirely by overriding the entrypoint, so its checks are unaffected either way).

set -euo pipefail

log() { printf 'rmd-entrypoint: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# ── GIT IDENTITY IS NOT PART OF THE BOOTSTRAP, SO IT MUST NOT BE SKIPPED WITH IT ─────────────
# THIS BLOCK USED TO SIT BELOW THE SKIP, AND THE SKIP `exec`s — it never returns. So
# `RMD_SKIP_BOOTSTRAP=1` left the container with NO identity at all, and MEASURED on the published
# image that is exactly what verify-image.sh's uid-1000 commit probe hit:
# `fatal: unable to auto-detect email address (got 'node@<container>.(none)')`.
#
# WHICH SIDE WAS WRONG, since the probe could equally have been retargeted. Three reasons it is
# this file:
#   1. The skip's OWN log line enumerates what it skips — "no clone, no fetch, no install". An
#      identity is none of those three. It was filed inside a block whose stated scope excludes it.
#   2. The skip is this script's DOCUMENTED RECOVERY PATH: two failure messages below tell an
#      operator to re-run with RMD_SKIP_BOOTSTRAP=1 to inspect a broken tree by hand. Someone
#      salvaging uncommitted work is precisely who needs to be able to commit, and that was the one
#      path with no identity.
#   3. It costs two local `git config` calls — no network, no token, no clone — so making it
#      unconditional keeps the verifier's check token-free and runnable on every verification,
#      rather than only when credentials happen to be around.
# The honest counter-argument, recorded rather than buried: a WORKER never sets
# RMD_SKIP_BOOTSTRAP=1, and on the normal path this write already happened BEFORE the clone. So
# production was never broken, and the probe's "every worker commits NOTHING" wording overstates
# what it measured. That is a defect in the message, not a reason to leave the recovery path unable
# to commit.
#
# `mkdir -p` first: `git config --global` writes $HOME/.gitconfig and FAILS OUTRIGHT if HOME does
# not exist (the same trap recorded further down).
mkdir -p "${HOME:?HOME must be set — git config --global writes \$HOME/.gitconfig and cannot without it}"
if git -C / config --get user.email >/dev/null 2>&1 && git -C / config --get user.name >/dev/null 2>&1; then
  log "git identity: already configured ($(git -C / config --get user.name) <$(git -C / config --get user.email)>) — left alone"
else
  git config --global --replace-all user.name "${RMD_GIT_AUTHOR_NAME:-remudero-worker}"
  git config --global --replace-all user.email "${RMD_GIT_AUTHOR_EMAIL:-remudero-worker@users.noreply.github.com}"
  # `git -C /` HERE TOO, for the same reason the guard above uses it — and it was missed the first
  # time. A bare `git config --get` resolves LOCAL config, so when the cwd happens to be inside a
  # repository this line reports THAT repository's identity rather than the global one just written.
  # MEASURED by a test booting from a checkout: it wrote `remudero-worker` and then announced
  # `Claude <noreply@anthropic.com>`, the checkout's own committer. The write was always correct;
  # the REPORT was not, which is the worse half — a boot log that names an identity the commits will
  # not use is how you diagnose the wrong thing for an hour.
  log "git identity: $(git -C / config --get user.name) <$(git -C / config --get user.email)> (override with RMD_GIT_AUTHOR_NAME/RMD_GIT_AUTHOR_EMAIL)"
fi

if [ "${RMD_SKIP_BOOTSTRAP:-}" = "1" ]; then
  log "RMD_SKIP_BOOTSTRAP=1 — no clone, no fetch, no install (the identity above is already written)"
  exec "$@"
fi

REPO_URL="${RMD_REPO_URL:-https://github.com/craigoley/remudero.git}"

# ── THE PIN, AND WHAT IT RECOVERS ────────────────────────────────────────────────────────────
# Cloning at startup breaks the property the image digest used to carry: today a digest names
# exactly what will run, and a container that clones runs whatever the ref held at boot. RMD_REF is
# how that is recovered — it takes a branch, a tag or a full commit sha, so an operator who needs
# "run exactly this code again" pins a sha and gets it back.
#
# THE DEFAULT IS `main` RATHER THAN A PINNED SHA, and that is a deliberate trade rather than
# laziness. A sha default would have to be edited into this file and rebuilt to move, which is the
# very rebuild-to-change-code cost this whole change exists to remove; and a stale default is worse
# than no default, because it silently runs old code while looking pinned. `main` is what a fleet
# host is supposed to be on — the mini's own self-sync fast-forwards to origin/main — so the
# default matches the fleet and the pin is there when reproducibility matters more than currency.
REF="${RMD_REF:-main}"

# config.root is `$HOME/Remudero` (loadConfig, src/lib/config.ts), and the fleet's own checkout sits
# beside the state it manages. Deriving both from HOME rather than hardcoding keeps this consistent
# with the image's ENV HOME and with the volume the operator mounts.
: "${HOME:?HOME must be set — config.root derives from it and an unset HOME sends state to /}"
CONFIG_ROOT="$HOME/Remudero"
TREE="$CONFIG_ROOT/remudero"

# ── CREDENTIALS: A HELPER, NOT A TOKEN ON DISK ───────────────────────────────────────────────
# MEASURED: `gh auth setup-git` REFUSES with only GH_TOKEN set — "You are not logged into any
# GitHub hosts" — so the obvious one-liner is not available.
#
# The two forms that DO work both write the token to disk: a token-bearing remote URL puts it in
# the clone's .git/config, which lives in the mounted volume and therefore OUTLIVES the container;
# a `url.insteadOf` rewrite puts it in a gitconfig. Both also go stale the moment the token rotates,
# and a stale token baked into a remote is a confusing failure.
#
# A credential helper avoids both: the token is read from the environment AT CALL TIME, so it is
# never written anywhere, and rotation is just a new `-e GH_TOKEN`. The helper is stored with
# `$GH_TOKEN` UNEXPANDED — single-quoted here so this shell does not substitute it — and git's own
# shell expands it when it runs. The remote URL stays clean.
# `git config --global` writes $HOME/.gitconfig and FAILS OUTRIGHT if HOME does not exist —
# "could not lock config file". The image creates /home/node, so this only bites a container
# started with a HOME that was never made; creating it costs nothing and removes a boot failure
# whose message says nothing about the real cause. Found by running this script, not by reading it.
mkdir -p "$HOME"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global credential.helper \
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
  log "git credentials: helper reads GH_TOKEN at call time (not written to disk)"
else
  log "GH_TOKEN is not set — a private fetch or clone will fail"
fi

# ── THE COMMIT IDENTITY. WITHOUT IT A WORKER WRITES FILES AND COMMITS NOTHING. ────────────────
# MEASURED on the published image, as uid 1000 with this entrypoint bypassed:
#   git config --global --list
#   → fatal: unable to read config file '/home/node/.gitconfig': No such file or directory
# and from a real `preflight --ci-parity` in a container:
#   Author identity unknown
#   fatal: unable to auto-detect email address (got 'node@817837271c3e.(none)')
#
# GIT CANNOT AUTO-DETECT HERE, and the `.(none)` in that message is exactly why: git will fall back
# to `user@host` only when the hostname looks fully qualified. A container's hostname is a bare
# container id, so the fallback is refused and `git commit` fails outright.
#
# THIS IS THE SAME ASYMMETRY AS THE gh CREDENTIAL AND PLAYWRIGHT_BROWSERS_PATH — a FILE that exists
# on the operator's Mac and simply does not exist here. `WORKER_HOME_SYMLINKS` (src/lib/worker-home.ts)
# grants `.gitconfig` into every per-run worker HOME with the reason recorded verbatim as "git author
# identity for commits the worker makes", and `materializeWorkerHome` SKIPS a grant whose source is
# absent. So on darwin the worker inherits the operator's identity and in a container it silently
# inherits nothing. Writing $HOME/.gitconfig here is what makes that existing grant resolve — no
# change to src/ is needed, and both the worker AND the orchestrator's own commit sites
# (plan-architect, plan-pr-emitter, orientation, the triage/approve paths, none of which passes
# `-c user.name`) are covered by the one write.
#
# WHY THE ENTRYPOINT AND NOT THE IMAGE. The identity that 63 of 64 merged `Remudero-Task:` commits
# actually carry is `Craig Oley <craigoley@gmail.com>` — the OPERATOR'S OWN, straight out of their
# `~/.gitconfig`. That is a person, and a person does not belong baked into a published image: it is
# not the fleet's to assert, it changes, and the image is shared. So the identity is configurable
# here, defaulting to a purpose-scoped bot in the same shape this repo already uses twice
# (`rmd-feedback-bridge@users.noreply.github.com` in src/lib/feedback-landing.ts, and
# `${GIT_AUTHOR_NAME:-remudero-heartbeat}` in scripts/fleet-heartbeat.sh — defaulted but
# overridable). TO KEEP HISTORY CONSISTENT WITH THOSE 63 COMMITS, run the container with
# `-e RMD_GIT_AUTHOR_NAME='Craig Oley' -e RMD_GIT_AUTHOR_EMAIL=craigoley@gmail.com`.
#
# `--replace-all` rather than a bare set, so a re-boot onto an existing volume cannot accumulate
# duplicate keys; and the values are only written when git does not already resolve one, so an
# operator who mounted their own gitconfig keeps it.
# `git -C /` ON THE PROBE, and it is load-bearing rather than tidy. A bare `git config --get`
# resolves LOCAL config too, so if this script's cwd happens to sit inside a repository, that
# repository's own `.git/config` can answer the question — and the worker does not commit there, it
# commits in a worktree under $HOME/Remudero. Probing from `/`, which is not a repository, restricts
# the answer to the system and global scopes, i.e. exactly the ones a commit anywhere in this
# container would inherit. (Found by running this block, not by reading it: the first draft reported
# "already configured" off the checkout's own local config.) A SYSTEM identity still satisfies it —
# that is deliberate, since one would make commits work without this write.
#
# THE WRITE ITSELF NOW RUNS ABOVE THE RMD_SKIP_BOOTSTRAP BLOCK, not here — everything above this
# line is WHY the identity exists and what it must be; the argument for WHERE it runs is at the top
# of this file. It moved because the skip block `exec`s and never returns, so the skip path had no
# identity at all, which is what the published image's uid-1000 commit probe measured. Nothing about
# the normal path changed: this write already happened before the clone, and still does.

# ── RESOLVING THE REF: A BRANCH MEANS THE TIP AT BOOT, A SHA MEANS EXACTLY THAT ──────────────
# MEASURED ON AZURE 2026-08-08, AND REPRODUCED HERE AGAINST A REAL GIT ORIGIN. A boot printed
# "Your branch is behind 'origin/main' by 3 commits, and can be fast-forwarded" and then
# "checkout: 354f20c" — the OLDER sha — and reported a successful boot. The next dispatch then
# branched from stale code, which is W1-T405's scenario arriving one layer upstream.
#
# THE CAUSE WAS A TWO-PART COMPOUND, AND NEITHER HALF IS OBVIOUS FROM READING THE OLD CODE.
#   1. `git checkout --detach main` RESOLVES THE LOCAL BRANCH, AND `git fetch` NEVER MOVES IT.
#      The default fetch refspec updates `refs/remotes/origin/*` only, so after the initial clone
#      the local `main` is frozen at the clone-time sha forever. Detaching onto it therefore walks
#      HEAD BACKWARD on every single boot — measured: a tree already correctly at the newest commit
#      was moved back to the clone-time sha before anything tried to bring it forward again.
#   2. THE ONLY THING THAT CLIMBED BACK UP WAS SILENCED. `git merge --ff-only origin/$REF
#      2>/dev/null || true` discarded both the error text and the exit code, so any failure left
#      HEAD at the regressed sha and the boot still printed a clean "checkout:" line. Reproduced by
#      giving the tree an untracked file that an incoming commit also adds — the tracked-only dirty
#      guard above correctly sees a CLEAN tree, git refuses to overwrite the untracked file, and the
#      container silently regressed from a good sha to the clone-time one. Once there it stays
#      there: every later boot repeats the same walk-back and the same silent failure, so the
#      container is pinned at its first-ever checkout while reporting success each time. That is the
#      identical shape this script already fixed once, when counting untracked files as dirt made
#      boot 2 refuse to sync forever.
#
# SO THE REF IS RESOLVED ONCE, HERE, AND CHECKED OUT IN ONE STEP. `origin/$REF` is tried FIRST, so
# a BRANCH name means "the tip as of the fetch that just ran" — which is what a user passing `main`
# expects and what the old code was already trying to reach, less reliably, via the merge. Anything
# that is not a branch on the remote — a sha, a tag — has no `refs/remotes/origin/<x>` and falls
# through to the exact form, so a pin still means exactly what it says. That distinction is the
# whole point of RMD_REF and it now holds in both directions.
#
# NOTHING IS SILENCED. A checkout that cannot proceed DIES, loudly, rather than continuing on
# whatever HEAD happened to be. Proceeding is the expensive direction: it costs a full run against
# stale code and then a scope-guard refusal whose message names a different cause.
resolve_target() {
  # A branch on the remote — the freshly-fetched tip.
  if git -C "$TREE" rev-parse --verify --quiet "refs/remotes/origin/$REF^{commit}"; then return 0; fi
  # Otherwise an exact object: a sha, a tag, anything else git can name.
  if git -C "$TREE" rev-parse --verify --quiet "$REF^{commit}"; then return 0; fi
  return 1
}

checkout_target() {
  TARGET="$(resolve_target)" || die "ref not found: $REF (tried origin/$REF, then $REF as an exact object)"
  if ! out="$(git -C "$TREE" checkout --detach "$TARGET" 2>&1)"; then
    log "CHECKOUT FAILED — refusing to run on whatever HEAD happens to be:"
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    log "  A common cause is an UNTRACKED file at a path an incoming commit also adds: the"
    log "  tracked-only dirty guard sees a clean tree, and git will not overwrite it. Remove the"
    log "  file, or start with RMD_SKIP_BOOTSTRAP=1 to inspect the tree by hand."
    die "cannot check out $REF ($TARGET)"
  fi
}

# ── CLONE, OR SYNC WHAT IS ALREADY THERE ─────────────────────────────────────────────────────
if [ ! -e "$TREE/.git" ]; then
  log "no work tree at $TREE — cloning $REPO_URL"
  mkdir -p "$CONFIG_ROOT"
  git clone "$REPO_URL" "$TREE" || die "clone failed — check GH_TOKEN and RMD_REPO_URL"
  checkout_target
else
  log "work tree present at $TREE"
  git -C "$TREE" fetch --prune origin || log "fetch FAILED — continuing on the tree as it stands"

  # ── THE DIRTY-TREE RULE IS THE DEPLOYER'S, NOT A NEW ONE ───────────────────────────────────
  # `decideDeploy` (src/lib/deployer.ts) guards its fast-forward with a clean-tree check whose
  # comment is explicit: "abort (never force) on a conflicting dirty tree", reported as
  # `dirty-tree-conflict`. Uncommitted work is never discarded to make a sync succeed.
  #
  # THIS TEST IS STRICTLY MORE CONSERVATIVE THAN THAT ONE, and the difference is worth stating
  # rather than implying parity. `treeFfSafe` intersects the dirty files with the INCOMING files
  # and only conflicts on the overlap, so it tolerates local edits the fast-forward would not
  # touch. Reproducing that in shell would mean reimplementing it, badly, in the one place where
  # being wrong destroys uncommitted work — so this refuses on ANY dirt. It errs toward leaving
  # the tree alone, which is the safe direction, and it says so rather than silently skipping.
  #
  # `-uno` — TRACKED MODIFICATIONS ONLY, and this is load-bearing rather than a tidy-up. Plain
  # `--porcelain` also lists UNTRACKED files, and the first boot creates one immediately by
  # installing node_modules. Measured: with untracked files counted, the second boot refused to
  # sync and every boot after it would have done the same — a container permanently pinned to
  # whatever it first cloned, reporting a reason that sounds like the operator left work behind.
  # Untracked files also cannot conflict with a fast-forward, which is what `treeFfSafe` is
  # actually about: LOCALLY-MODIFIED files. This matches that intent and removes the trap.
  if [ -n "$(git -C "$TREE" status --porcelain -uno)" ]; then
    log "REFUSING to sync: the work tree has uncommitted changes."
    log "  Nothing has been discarded and nothing was fetched into the checkout."
    log "  This is deliberately stricter than the deployer, which conflicts only on files the"
    log "  fast-forward would touch. Commit or stash, or run with RMD_SKIP_BOOTSTRAP=1."
  else
    # ONE STEP, NOT CHECKOUT-THEN-MERGE. The old pair walked HEAD down to the frozen local branch
    # and then relied on a silenced `merge --ff-only` to climb back — see the resolver above for the
    # measured regression that produced. There is no merge here because there is nothing to merge:
    # the target IS the freshly-fetched tip, so a single detach lands on it directly.
    checkout_target
  fi
fi

# RECORD WHAT ACTUALLY RUNS. The point of the pin is lost if the resolved commit is not observable,
# so print it unconditionally — this line is what makes "which code ran" answerable after the fact,
# and it is the closest thing to the digest guarantee the snapshot used to give.
log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"

# ── THE BOOTSTRAP INSTALL, AND ONLY THAT ─────────────────────────────────────────────────────
# `ensureInstallFresh` (src/run-task.ts) ALREADY solves "should I reinstall": it hashes
# package.json + package-lock.json, compares against `.rmd-install-hash` written inside
# node_modules by the last successful install, and its own doc states a matching hash is "a total
# no-op — no redundant install, ever". Two call sites already wire it. Re-deciding that here would
# duplicate a mechanism that is better than anything this script could compute.
#
# BUT IT CANNOT BOOTSTRAP ITSELF. `bin/rmd` ends in `exec "$DIR/node_modules/.bin/tsx"`, so on a
# fresh clone with no node_modules there is no way to REACH ensureInstallFresh — every verb dies at
# "Cannot find package 'tsx'", which is exactly the failure that killed the hand-made clone. So the
# only install this script owes is the first one, conditioned on tsx being absent rather than on
# anything about freshness. After that, rmd's own hash decides, as it does on every other host.
#
# This also answers the sharing question the wrong way round on purpose: the clone gets its OWN
# node_modules. REQ 4 in the Dockerfile records that one shared install emptied under a running
# daemon twice in a week, and /app's install belongs to /app's lockfile, not to this checkout's.
if [ ! -x "$TREE/node_modules/.bin/tsx" ]; then
  log "no node_modules/.bin/tsx — running the bootstrap install (rmd's own freshness check takes over after this)"
  ( cd "$TREE" && npm ci ) || die "npm ci failed in $TREE"
else
  log "node_modules present — leaving install freshness to ensureInstallFresh"
fi

cd "$TREE"

# ── RESTART RATE LIMIT: THE CONTAINER COUNTERPART OF launchd's ThrottleInterval ───────────────
# `generateLaunchdPlist` (src/lib/launchd.ts) gives the mini `KeepAlive {SuccessfulExit: false}`
# plus `ThrottleInterval` (plan/policy.yaml's `launchd.throttleIntervalS`, 60). Docker's
# `--restart=on-failure:N` caps the COUNT, not the RATE — so the container half of that pair is
# missing, and the measured precedent is a duplicate task id making the plan unreadable and
# crash-looping the daemon at ~5 restarts/minute.
#
# THIS SLEEPS BEFORE EXITING; IT DOES NOT LOOP. That inversion is the whole design, and the reason
# is `stale`. A daemon that finds itself on superseded code stops with DaemonStopReason `stale`,
# which daemon.ts's own comment calls the path that "WANTS exactly that restart (it is how a
# long-running daemon reaches merged code)". The clone/fetch/checkout above runs ONCE, before this
# line — so an in-container retry loop would re-run the daemon against the SAME tree forever and
# `stale` would never clear. Only a CONTAINER restart re-enters this script and re-fetches.
# Sleeping before exit therefore keeps docker's restart as the mechanism and merely rate-limits it.
#
# IT ALSO LEAVES `--restart=on-failure:N` INTACT, which an internal loop would render inert: the
# container still exits non-zero once per attempt, so N still counts attempts and still parks the
# container after N. Rate here, count there — the two compose instead of overriding each other.
#
# EXIT 0 IS NEVER THROTTLED. `daemonExitCode` maps stopped/max_reached to 0, and a `STOP` file
# yields `stopped` — so an operator stopping the fleet from the host gets an immediate clean exit
# and `on-failure` leaves the container down. Sleeping there would delay a requested stop by a
# minute for no reason.
#
# NEITHER IS EXIT 1, AS OF W1-T490. `daemonExitCode` used to send `blocked`, `error` AND `stale`
# through this same branch as a bare, undifferentiated nonzero — so a routine, one-per-merge
# freshness restart paid the SAME crash-storm sleep as an actual crash, purely because this script
# had no way to tell them apart. It now does: `stale` maps to exit 1 and `blocked`/`error` map to
# `CRASH_EXIT_CODE` (2, src/lib/daemon.ts) — DISTINCT codes, and `$rc` is the only channel this
# script has to read that distinction (the docker experiment behind this task established the
# restart POLICY itself never reads the value, only zero/non-zero, so acting on it has to happen
# here). A `stale` exit already WANTS the restart it is about to get — it is how a long-running
# daemon gets off superseded code (see this section's own note on `stale`, above) — and it is not
# the crash-loop-storm scenario (design (ii) in this task's shard: 5 boots and 3 lock collisions in
# 150 seconds) the throttle exists to slow down. So it is treated exactly like exit 0: immediate,
# unthrottled — `--restart=on-failure:N` still counts the attempt (this does not touch N, and
# cannot: see the shard's rationale for why no in-container mechanism can), it just does not ALSO
# pay a sleep a healthy restart never needed. A genuine crash or block (anything else nonzero)
# keeps the exact throttle behavior this script already had.
#
# THE INTERVAL COMES FROM THE ENVIRONMENT, NEVER FROM THE REPO. plan/policy.yaml is read by
# `generateLaunchdPlist` at PLIST-GENERATION time and baked into static XML; launchd never reads
# the repo at crash time. Reading it here instead would need the plan loadable at exactly the
# moment an unloadable plan is what is crashing the daemon — the measured incident. So the value
# is supplied at `docker run` and read from the environment, which is the same bake-it-once shape.
#
# OPT-IN, so the default path is byte-for-byte what it was: unset, this script still `exec`s.
# That matters because `exec "$@"` serves every container invocation, not just the daemon, and a
# one-shot verb must not acquire a minute of latency on a non-zero exit.
RESTART_THROTTLE_S="${RMD_RESTART_THROTTLE_S:-0}"
case "$RESTART_THROTTLE_S" in
  '' | *[!0-9]*)
    log "RMD_RESTART_THROTTLE_S is not a whole number of seconds — ignoring it and exec'ing normally"
    RESTART_THROTTLE_S=0
    ;;
esac

if [ "$RESTART_THROTTLE_S" -eq 0 ]; then
  exec "$@"
fi

log "restart throttle: a NON-ZERO exit will sleep ${RESTART_THROTTLE_S}s before exiting, so docker restarts at that rate"
# CAPTURE THE CODE IN THE SAME COMMAND THAT RUNS IT. `if "$@"; then ...; fi; rc=$?` reads $? from
# the COMPOUND, which is 0 when the condition merely tested false — so a crashing daemon exited 0,
# docker's `on-failure` saw a success, and the container stayed down through exactly the crash it
# is meant to restart. Caught by the non-zero-direction test below, which asserted the propagated
# code rather than only the sleep; the sleep and both log lines were already correct.
rc=0
"$@" || rc=$?
if [ "$rc" -eq 0 ]; then
  log "exited 0 — not throttled (a STOP is a clean stop; --restart=on-failure leaves the container down)"
  exit 0
fi
if [ "$rc" -eq 1 ]; then
  log "exited 1 — a freshness self-restart (stale), not throttled: it already wants the immediate restart"
  exit 1
fi
log "exited $rc — sleeping ${RESTART_THROTTLE_S}s before exiting so the restart is rate-limited, not just counted"
sleep "$RESTART_THROTTLE_S"
exit "$rc"
