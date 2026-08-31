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

# ── W1-T1054: A DAEMON-WRITTEN UNTRACKED FILE CAN COLLIDE WITH ITSELF, BY CONSTRUCTION ────────
# `feedbackDir` (src/lib/feedback.ts) writes `plan/feedback/**` INTO THIS SAME WORKING TREE, and
# `landFeedback` (src/lib/feedback-landing.ts) lands that identical content upstream as a gated PR
# but never deletes the local copy once it has landed — every `rmSync` in that module targets a
# scratch dir, none touches the entry. So the next boot's checkout lands on a commit that ADDS the
# very path the daemon already wrote locally, byte-for-byte, and the tracked-only dirty guard above
# (deliberately, see its own comment) does not see it — this is the collision `checkout_target`'s
# CHECKOUT FAILED message already names as "a common cause". It is guaranteed by the daemon's own
# routine work, not a race, and it is safe to clear in exactly the one case it can PROVE redundant.
#
# THE PREDICATE, CITED RATHER THAN RE-DERIVED. `treeFfSafe` (src/lib/deployer.ts) intersects dirty
# paths against the INCOMING diff and only conflicts on the overlap; `rmd sync` (W1-T907) already
# classifies a local path as provably lossless when its bytes equal the origin blob at that path.
# This is that same predicate, in bash, at boot: an untracked path is removable ONLY IF the incoming
# target ADDS that same path AND the local bytes are IDENTICAL to the incoming blob there. Anything
# else — untracked and not in the incoming diff, or in it with different content — is left alone, so
# the checkout below fails exactly as it always has and the operator sees the same diagnosis.
#
# BYTES, NOT TEXT. Comparing content requires reading it into a shell string, which mangles binary
# data and trailing newlines. `git hash-object` on the local path against the incoming blob's own sha
# compares bytes exactly, through git's own hashing, with no string handling in this script at all.
#
# UNREADABLE MEANS REFUSE, NOT "TREAT AS SAFE". `git rev-parse "$target:$path"` resolves the blob sha
# from the TREE object alone — it does not need the blob's content to be present locally, so it can
# succeed even when the object itself is missing or corrupt (a partial fetch, a damaged store). Only
# `git cat-file -e` actually opens the object, so that is the read this function trusts before
# calling anything redundant. When it fails, the path is NOT provably safe and stays in place —
# fail-closed, matching the tracked-only guard's own posture.
#
# EVERY CLEARED PATH IS NAMED, ALWAYS. Removing an untracked file is how uncommitted real work
# disappears if the predicate is ever wrong, so nothing here removes a path without first logging
# which one and why — the log must show what was discarded even on a boot that then succeeds.
#
# NOT IN SCOPE (see plan/tasks.d/W1-T1054-*.yaml): relocating the daemon's feedback write, which has
# a reader and would silently drop unlanded filings; teaching `landFeedback` to clean up after
# itself, a real and separate candidate; detecting the outage this caused (W1-T1047, already filed);
# and the restart budget above, which is correct as it stands.
clear_redundant_untracked() {
  local target="$1" path blob local_sha
  while IFS= read -r -d '' path; do
    blob="$(git -C "$TREE" rev-parse --verify --quiet "${target}:${path}" 2>/dev/null)" || continue
    if ! git -C "$TREE" cat-file -e "$blob" 2>/dev/null; then
      log "  leaving untracked '$path' in place: cannot read the incoming blob at that path, so it is not provably redundant"
      continue
    fi
    local_sha="$(git -C "$TREE" hash-object -- "$path" 2>/dev/null)" || continue
    if [ "$local_sha" = "$blob" ]; then
      log "  clearing untracked '$path': the incoming commit adds this exact path with identical bytes"
      rm -f -- "$TREE/$path"
    else
      log "  leaving untracked '$path' in place: the incoming commit adds this path but with DIFFERENT bytes"
    fi
  done < <(git -C "$TREE" ls-files --others --exclude-standard -z)
}

checkout_target() {
  TARGET="$(resolve_target)" || die "ref not found: $REF (tried origin/$REF, then $REF as an exact object)"
  clear_redundant_untracked "$TARGET"
  if ! out="$(git -C "$TREE" checkout --detach "$TARGET" 2>&1)"; then
    log "CHECKOUT FAILED — refusing to run on whatever HEAD happens to be:"
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    log "  A common cause is an UNTRACKED file at a path an incoming commit also adds: the"
    log "  tracked-only dirty guard sees a clean tree, and git will not overwrite it. Remove the"
    log "  file, or start with RMD_SKIP_BOOTSTRAP=1 to inspect the tree by hand."
    die "cannot check out $REF ($TARGET)"
  fi
}

# ── THE BOOT FETCH RETRIES A TRANSIENT REF LOCK, BOUNDED, AND ONLY A LOCK (W1-T2501) ─────────
# MEASURED (operator-log#cannot-lock-ref-2026-08-30): the boot fetch failed to lock THREE refs in
# one call — `refs/remotes/origin/main`, `heartbeat-mini` and a feature branch — the signature of
# another git process holding them, not of corruption; the holder finishes. The old code made
# exactly ONE attempt, logged one line and carried on: the daemon booted on the stale tree that
# produced, and the advisory id mint two commands later read a corpus four ids behind.
#
# THE RETRY KEYS ON THE LOCK, NEVER ON FAILURE GENERALLY — a narrower claim than "retry transient
# failures". `cannot lock ref` / `unable to update local ref` is git's own wording for exactly this
# case: another process held the ref when this one reached for it. A network failure or an auth
# failure is NOT this case, must NOT be retried into a longer boot, and keeps today's single-attempt,
# fail-open behaviour untouched below.
#
# BOUNDED, AND FAILING OPEN STILL SURVIVES. `FETCH_LOCK_RETRY_MAX` caps the attempts and
# `FETCH_LOCK_RETRY_PAUSE_S` is the backoff between them, so a boot can never wait on this
# indefinitely. An exhausted retry does not die — the neighbouring housekeeping step's own principle
# holds here too: a boot must not refuse to start because origin was briefly unreachable — it is
# reported as a NAMED STALE BOOT (grep `STALE BOOT`) instead of one line among many, so an exhausted
# retry is at least as visible as the daemon's own freshness vocabulary.
FETCH_LOCK_RETRY_MAX="${RMD_FETCH_LOCK_RETRY_MAX:-5}"
case "$FETCH_LOCK_RETRY_MAX" in
  '' | *[!0-9]*)
    log "RMD_FETCH_LOCK_RETRY_MAX is not a whole number — ignoring it and using 5"
    FETCH_LOCK_RETRY_MAX=5
    ;;
esac

FETCH_LOCK_RETRY_PAUSE_S="${RMD_FETCH_LOCK_RETRY_PAUSE_S:-2}"
case "$FETCH_LOCK_RETRY_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_FETCH_LOCK_RETRY_PAUSE_S is not a whole number of seconds — ignoring it and using 2"
    FETCH_LOCK_RETRY_PAUSE_S=2
    ;;
esac

# Attempts the boot fetch, retrying ONLY a ref-lock failure, up to FETCH_LOCK_RETRY_MAX times with
# FETCH_LOCK_RETRY_PAUSE_S between attempts. Returns 0 the moment a fetch succeeds — including a
# first-try success, which makes no additional call and prints nothing about retrying. Returns
# non-zero, having already logged the underlying git error, when either the failure is not a ref
# lock (one attempt only, FETCH_LOCK_EXHAUSTED left 0 so the caller keeps today's plain message) or
# the retries are exhausted (FETCH_LOCK_EXHAUSTED set to 1, so the caller can name it a stale boot).
boot_fetch() {
  fetch_attempt=1
  FETCH_LOCK_EXHAUSTED=0
  while :; do
    if fetch_out="$(git -C "$TREE" fetch --prune origin 2>&1)"; then
      if [ "$fetch_attempt" -gt 1 ]; then
        log "fetch: succeeded on retry $fetch_attempt/$FETCH_LOCK_RETRY_MAX — the ref lock cleared"
      fi
      return 0
    fi
    if ! printf '%s' "$fetch_out" | grep -qiE 'cannot lock ref|unable to update local ref'; then
      printf '%s\n' "$fetch_out" | sed 's/^/  /' >&2
      return 1
    fi
    if [ "$fetch_attempt" -ge "$FETCH_LOCK_RETRY_MAX" ]; then
      printf '%s\n' "$fetch_out" | sed 's/^/  /' >&2
      FETCH_LOCK_EXHAUSTED=1
      return 1
    fi
    log "fetch: another process holds a ref lock (attempt $fetch_attempt/$FETCH_LOCK_RETRY_MAX) — retrying in ${FETCH_LOCK_RETRY_PAUSE_S}s"
    sleep "$FETCH_LOCK_RETRY_PAUSE_S"
    fetch_attempt=$((fetch_attempt + 1))
  done
}

# FETCH, GUARD, CHECKOUT — EXTRACTED SO IT CAN RUN MORE THAN ONCE (W1-T490).
# The body is byte-for-byte what the `else` branch below used to hold inline; only its location
# moved. It is a function now because the freshness-restart block at the foot of this script has to
# re-run it: a daemon that stopped `stale` must come back on the code that made it stale, and the
# fetch+checkout is the only thing in this container that advances the tree. That is exactly the
# objection the restart-throttle block below used to raise against looping in-container ("the
# clone/fetch/checkout above runs ONCE, before this line"), and extracting this is what retires it.
sync_tree() {
  log "work tree present at $TREE"

  # ── DROP WORKTREE REGISTRATIONS WHOSE DIRECTORY IS GONE, BEFORE THE FETCH ─────────
  # NOT the same "prune" as the fetch below. `fetch --prune` drops remote-tracking REFS;
  # this drops WORKTREE ADMIN RECORDS under `.git/worktrees/` whose checkout directory no
  # longer exists. The two are unrelated and neither does the other's job.
  #
  # WHY THIS CONTAINER ACCUMULATES THEM. The checkout is a bind mount shared with the host,
  # so `.git/worktrees/` carries registrations the HOST created, pointing at host paths that
  # have never existed in here. Measured 2026-08-24T00:40Z inside `remudero-daemon`: 22 such
  # registrations, every one under `/home/craigoleyagent/work/`.
  #
  # WHY IT IS LOAD-BEARING RATHER THAN TIDY. `git gc` reads each registered worktree's HEAD.
  # One unreadable HEAD aborts the whole repack — reproduced: `fatal: bad object
  # worktrees/<name>/HEAD`, `fatal: failed to run repack`, exit 128. When the abort happens
  # under AUTOMATIC gc it writes `.git/gc.log`, and git then declines every later automatic
  # cleanup while that file exists ("Automatic cleanup will not be performed until the file is
  # removed"). The daemon's checkout had not been packed since 2026-08-21: 6,059 loose objects,
  # 65.80 MiB loose, 50.94 MiB packed — 0 / 0 / 18.31 MiB once the registrations went.
  #
  # AND `git gc` DOES NOT CLEAR THEM ITSELF: `gc.worktreePruneExpire` defaults to three months,
  # so a registration stale for minutes is still consulted, and still aborts the repack.
  #
  # BEFORE THE FETCH, DELIBERATELY. The fetch is the first thing here that can trigger an
  # automatic gc, so pruning first is what stops that gc tripping over a dead registration and
  # writing the `gc.log` that silences every cleanup after it. Placing it inside `sync_tree`
  # covers BOTH call sites — the boot path and the freshness restart below — in one line.
  #
  # A REGISTRATION THIS BOOT CREATES IS NOT PRUNED THIS BOOT, AND MUST NOT BE. Lanes start
  # after this runs; their worktrees are live, and `prune` removes only records whose directory
  # is ABSENT ("gitdir file points to non-existent location") — verified: a live worktree keeps
  # both its registration and its files, and no worktree's contents are ever deleted by prune.
  # A registration created during this boot is therefore cleared at the NEXT restart, which is
  # the only moment it is safe to clear.
  #
  # NON-FATAL, AND THAT IS NOT DEFENSIVE PADDING: `git worktree prune` exits 0 on an already
  # clean repo but 128 when the cwd is not a repository at all, and a boot must not die on a
  # housekeeping step. Failure is logged and the sequence continues.
  #
  # THIS DOES NOT CLEAR AN EXISTING `gc.log`, and deliberately so — see the note beside the
  # log line below.
  git -C "$TREE" worktree prune || log "worktree prune FAILED — continuing (housekeeping never blocks the boot)"

  if ! boot_fetch; then
    if [ "$FETCH_LOCK_EXHAUSTED" -eq 1 ]; then
      log "STALE BOOT: fetch FAILED after $FETCH_LOCK_RETRY_MAX attempt(s), still ref-locked — continuing on the tree as it stands"
    else
      log "fetch FAILED — continuing on the tree as it stands"
    fi
  fi

  # A REPO ALREADY STUCK STAYS STUCK, AND THE ENTRYPOINT SAYS SO RATHER THAN FIXING IT.
  # `worktree prune` removes the CAUSE; it does not remove `.git/gc.log`, which is the thing
  # actually suppressing automatic cleanup — verified directly: a planted gc.log survives a
  # prune untouched. Clearing a gc.log this script did not write would be deleting another
  # process's only record of why its repack failed, on a checkout shared with the host, with no
  # way from in here to tell a stale log from one written seconds ago by a maintenance run that
  # is still going. So this reports it and leaves the decision to an operator, who can clear it
  # and repack when no lane is running:  rm -f .git/gc.log && git gc --prune=now
  if [ -f "$TREE/.git/gc.log" ]; then
    log "NOTE: $TREE/.git/gc.log exists — git is declining AUTOMATIC cleanup until it is removed."
    log "  The stale registrations above are pruned, so the cause is gone, but the log is not"
    log "  cleared here: it belongs to whatever wrote it. To recover, with no lane running:"
    log "    rm -f $TREE/.git/gc.log && git -C $TREE gc --prune=now"
  fi

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
}

# ── CLONE, OR SYNC WHAT IS ALREADY THERE ─────────────────────────────────────────────────────
if [ ! -e "$TREE/.git" ]; then
  log "no work tree at $TREE — cloning $REPO_URL"
  mkdir -p "$CONFIG_ROOT"
  git clone "$REPO_URL" "$TREE" || die "clone failed — check GH_TOKEN and RMD_REPO_URL"
  checkout_target
else
  sync_tree
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
# THIS SLEEPS BEFORE EXITING, AND — SINCE W1-T490 — LOOPS FOR EXACTLY ONE CASE. The original text
# here rejected looping outright, on two grounds. The FIRST no longer holds and the SECOND still
# does, so the block below honours the second and retires the first.
#
#   RETIRED: "The clone/fetch/checkout above runs ONCE, before this line — so an in-container retry
#   loop would re-run the daemon against the SAME tree forever and `stale` would never clear." That
#   was true only of a loop around `"$@"`. The bootstrap is now the `sync_tree` FUNCTION above, so
#   the loop below re-runs the fetch and the checkout before every retry and staleness clears
#   exactly as a container restart would clear it.
#
#   STILL BINDING: "IT ALSO LEAVES `--restart=on-failure:N` INTACT, which an internal loop would
#   render inert: the container still exits non-zero once per attempt, so N still counts attempts."
#   A container that never exits is never counted, so an unconditional loop would delete the
#   crash-loop bound entirely. THE LOOP BELOW IS THEREFORE NARROW: it re-enters ONLY on
#   `DAEMON_EXIT_STALE`, and every other non-zero exit still falls straight through to the sleep and
#   the exit, so a crash is counted by docker exactly as it was.
#
# ── WHY `stale` HAD TO BE SEPARATED AT ALL ───────────────────────────────────────────────────
# `daemonExitCode` (src/lib/daemon.ts) used to map `blocked`, `error` AND `stale` onto 1, and
# docker's `on-failure:N` counts every non-zero exit against N. MEASURED (Azure, 2026-08-14): the
# policy cannot read the code — `exit 1` and `exit 42` both parked at `RestartCount=2` under
# `on-failure:2` — and health never refunds the budget: containers exiting after 0s, 20s and 120s of
# clean work all parked permanently, the only observed reset being a manual `docker start`. So a
# freshness restart, which happens ONCE PER MERGE (14 rows in 24 hours), spent the same finite budget
# as a crash, and a healthy merging fleet exhausted `on-failure:5` in roughly half a day. The
# measured cost was a 2h56m outage — 90% of that day's downtime — that only a human ended.
#
# THE FIX IS NOT A POLICY CHANGE. `--restart=on-failure:5` is on the operator's `docker run` and is
# deliberately left alone: an unbounded `always`/`unless-stopped` would have spun forever on the
# MEASURED lock storm of 2026-08-13 22:23:40–22:26:10 (5 boots, 3 exits and 3 "a drain/daemon is
# already running" collisions in 150 seconds, arriving 13–17s apart). The bound is wanted. What
# changes is only WHICH exits are charged to it.
#
# THE FRESHNESS LOOP IS ITSELF BOUNDED, so nothing here is unbounded in either direction. It retries
# at most `RMD_FRESHNESS_RESTART_MAX` times (default 100) and sleeps `FRESHNESS_RESTART_PAUSE_S`
# between attempts — NOT the crash throttle. That clause read "the SAME throttle" until 2026-08-18
# and had been wrong since the separate pause was introduced in the block below; the two statements
# contradicted each other in one file. A pathological restart-storm is still rate-limited and falls through
# to a real exit, handing the container back to docker's count. Rate here, count there, still — the
# only difference is that routine freshness no longer spends the count.
#
# EXIT 0 IS NEVER THROTTLED. `daemonExitCode` maps stopped/max_reached to 0, and a `STOP` file
# yields `stopped` — so an operator stopping the fleet from the host gets an immediate clean exit
# and `on-failure` leaves the container down. Sleeping there would delay a requested stop by a
# minute for no reason.
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

# THE FRESHNESS EXIT CODE, DUPLICATED FROM `DAEMON_EXIT_STALE` (src/lib/daemon.ts) ON PURPOSE.
# This script cannot import that module: it runs at the exact moment the daemon has failed, and the
# note on the throttle interval above already records why nothing here may depend on the repo being
# loadable then. `test/entrypoint-boot.test.ts` greps this file for the constant and fails if the two
# ever drift, so the duplication is pinned rather than merely commented.
DAEMON_EXIT_STALE=75

# THE BLOCKED EXIT CODE, DUPLICATED FROM `DAEMON_EXIT_BLOCKED` (src/lib/daemon.ts) ON PURPOSE, for
# the same reason the line above duplicates its sibling: this script runs before any node process
# exists, so it cannot import the constant. `test/entrypoint-boot.test.ts` reads BOTH numbers out
# of this file and asserts they equal the exported constants, so a drift is a red test, not a
# silent mis-route.
DAEMON_EXIT_BLOCKED=76
# ── WHY 100, MEASURED 2026-08-18 (was 20, sized against a merge rate the fleet has outgrown) ──
# The note above sizes this budget from a freshness restart happening "ONCE PER MERGE (14 rows in
# 24 hours)". That rate is gone. MEASURED over the eight complete UTC days ending 2026-08-18, via
# the REST pulls API: 29, 41, 54, 58, 63, 71, 73, 86 merges per day — median 63 (4.5x the sizing
# assumption) and even the quietest day, 29, is 2.1x it. 56 merges landed in the US-Eastern day of
# 2026-08-17 alone. At 20 the budget is spent inside a single day, after which a ROUTINE freshness
# exit falls through and spends `--restart=on-failure:5` instead — re-creating the exact
# conflation of "stale" with "crash" that this whole block exists to undo.
#
# THE WORST CASE THIS NUMBER CREATES, STATED PLAINLY RATHER THAN LEFT TO BE DERIVED:
#   FRESHNESS_RESTART_MAX x FRESHNESS_RESTART_PAUSE_S = 100 x 5s = 500s (8m20s)
# of in-container ceiling before a freshness exit reaches docker's count. The multiplier is the
# PAUSE below, never `RESTART_THROTTLE_S` (120s in production) — the freshness path does not sleep
# the crash throttle, which is what the corrected sentence above now says.
#
# AND IT HAS A PRICE, NOT ONLY A CEILING. Every restart re-runs `sync_tree`, whose first act is a
# real `git fetch --prune origin`. 100 restarts is 100 fetches against the origin. That cost is
# accepted deliberately for the headroom; it is recorded here so the next person raising this number
# knows what they are buying and does not have to re-derive it from the loop body.
#
# WHY THE DEFAULT MOVED RATHER THAN THE OPERATOR KEEPING AN ENV VAR: 100 was being carried only as
# `-e RMD_FRESHNESS_RESTART_MAX=100` on `docker run`, so any container rebuilt without that flag
# silently reverted to 20 with nothing reporting the regression. A default that has to be
# re-supplied by hand on every rebuild is not a default.
FRESHNESS_RESTART_MAX="${RMD_FRESHNESS_RESTART_MAX:-100}"
case "$FRESHNESS_RESTART_MAX" in
  '' | *[!0-9]*)
    log "RMD_FRESHNESS_RESTART_MAX is not a whole number — ignoring it and using 100"
    FRESHNESS_RESTART_MAX=100
    ;;
esac

# THE FRESHNESS RETRY GETS ITS OWN, SHORT PAUSE — SEPARATE FROM THE CRASH THROTTLE ABOVE. A
# freshness restart is one per merge, with a real fetch and checkout between attempts; it is not
# the shape the crash throttle exists to slow (the measured 2026-08-13 lock storm, same boot
# failing the same way 13-17s apart). Sleeping the FULL `RESTART_THROTTLE_S` (120s in production)
# before every in-container re-sync bought nothing but idle time. THE BOUND IS REPLACED, NOT
# REMOVED: the loop above is still capped at `FRESHNESS_RESTART_MAX` attempts, so worst case is
# now `FRESHNESS_RESTART_MAX` x `FRESHNESS_RESTART_PAUSE_S` instead of x `RESTART_THROTTLE_S`.
FRESHNESS_RESTART_PAUSE_S="${RMD_FRESHNESS_RESTART_PAUSE_S:-5}"
case "$FRESHNESS_RESTART_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_FRESHNESS_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 5"
    FRESHNESS_RESTART_PAUSE_S=5
    ;;
esac

# ── W1-T2537: THE BLOCKED RETRY, THE OTHER HALF OF THE FRESHNESS LOOP ────────────────────────
# A `blocked` stop is a COMPLETED drain pass reporting that a task is blocked — not a crash. It
# was charged to docker's `on-failure:N` exactly as a crash was, and MEASURED 2026-08-30 that
# left the container `Exited (1)` for 46+ minutes after a pass that had dispatched three tasks and
# opened three PRs. The loop is self-sustaining: a red board is what PRODUCES blocked passes, so
# the budget empties fastest when the fleet is most needed, and once empty nothing drains.
#
# NEITHER NUMBER IS PICKED. The cap MIRRORS `FRESHNESS_RESTART_MAX` above — the same worst-case
# shape already ratified for the sibling path, and the bound is what hands a pathological loop
# back to docker's count instead of replacing a bound with nothing. The pause is the daemon's OWN
# `DEFAULT_POLL_INTERVAL_MS` (60s, src/lib/daemon.ts), documented there as "check back once a
# minute while nothing is runnable" — which is exactly what a blocked board is. Deliberately NOT
# the 5s freshness pause (a blocked board needs CI wall-clock to change; a stale checkout does
# not) and NOT the 120s crash throttle (that exists to slow a boot failing the same way, and this
# is a pass that ran to completion).
BLOCKED_RESTART_MAX="${RMD_BLOCKED_RESTART_MAX:-100}"
case "$BLOCKED_RESTART_MAX" in
  '' | *[!0-9]*)
    log "RMD_BLOCKED_RESTART_MAX is not a whole number — ignoring it and using 100"
    BLOCKED_RESTART_MAX=100
    ;;
esac

BLOCKED_RESTART_PAUSE_S="${RMD_BLOCKED_RESTART_PAUSE_S:-60}"
case "$BLOCKED_RESTART_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_BLOCKED_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 60"
    BLOCKED_RESTART_PAUSE_S=60
    ;;
esac

# ── SIGNAL FORWARDING (W1-T1067) — RESTORE WHAT `exec` GIVES FOR FREE ───────────────────────
# `exec "$@"` above REPLACES this shell with the child, so the child inherits this pid directly
# and every signal tini sends it arrives unmediated. Down here, once the throttle is non-zero,
# this shell stays alive as tini's actual child and runs the daemon as a SEPARATE process below —
# so with no trap, this shell's own default disposition to SIGTERM is to die immediately, which
# leaves the daemon running, now ORPHANED, with nothing forwarded to it, until docker's grace
# period expires and SIGKILLs it — too late for `run-task.ts`'s own SIGTERM handler ever to run
# and release `state/drain.lock`. MEASURED on the live container (2026-08-20): the process tree
# under a 120s throttle carried no node process at all, only this shell asleep in the crash
# throttle's `sleep`, because the PREVIOUS restart's node had been SIGKILLed with the lock still
# held. Forwarding the signal to the child and waiting for ITS real exit — never dying here first
# — is what restores exactly the delivery `exec` gives for free.
#
# THE REAL EXIT CODE IS CAPTURED INSIDE THE TRAP ITSELF, not by resuming the interrupted `wait`
# below. Per bash's own documented `wait` semantics: when THIS shell is blocked in the `wait`
# builtin and a signal for which a trap is set arrives, `wait` returns IMMEDIATELY with a
# pseudo-status greater than 128, and the trap runs right after — so the value that first `wait`
# produces describes bash's own interruption, never the child's actual outcome, and resuming that
# interrupted statement is not a reliable place to read the child's real code from. The trap's OWN
# `wait "$child_pid"` below is a FRESH call, issued once the forward has already been sent and no
# further signal is pending, so it blocks for the child's genuine completion and records it in
# `child_rc` — which the main loop then prefers over whatever the interrupted `wait` returned.
child_pid=""
child_rc=""
forward_signal() {
  sig="$1"
  if [ -n "$child_pid" ]; then
    log "received $sig — forwarding to pid $child_pid so it can release its locks before exiting"
    kill "-$sig" "$child_pid" 2>/dev/null || true
    child_rc=0
    wait "$child_pid" 2>/dev/null || child_rc=$?
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

# CAPTURE THE CODE IN THE SAME COMMAND THAT RUNS IT. `if "$@"; then ...; fi; rc=$?` reads $? from
# the COMPOUND, which is 0 when the condition merely tested false — so a crashing daemon exited 0,
# docker's `on-failure` saw a success, and the container stayed down through exactly the crash it
# is meant to restart. Caught by the non-zero-direction test below, which asserted the propagated
# code rather than only the sleep; the sleep and both log lines were already correct.
#
# BACKGROUNDED, NOT FOREGROUND, so the trap above can react while it runs (a foreground `"$@"`
# leaves this shell unable to run a trap until the command completes — precisely the delivery gap
# this block exists to close). `child_rc` starts EMPTY every pass and is only ever set by the trap
# above, so an ordinary, unsignaled exit leaves it empty and `rc` keeps exactly the value the plain
# `wait` below already produced — byte-for-byte the prior behaviour on every path this block does
# not touch.
freshness_restarts=0
blocked_restarts=0
while :; do
  rc=0
  child_rc=""
  "$@" &
  child_pid=$!
  wait "$child_pid" || rc=$?
  if [ -n "$child_rc" ]; then
    rc=$child_rc
  fi
  child_pid=""

  if [ "$rc" -eq 0 ]; then
    log "exited 0 — not throttled (a STOP is a clean stop; --restart=on-failure leaves the container down)"
    exit 0
  fi

  # THE ONE CASE THAT DOES NOT SPEND THE BUDGET. A `stale` stop is not a failure: the daemon is
  # asking to come back on code that has since merged, and daemon.ts calls it the path that "WANTS
  # exactly that restart". Serving it here means the container never exits, so docker never counts
  # it — while the re-sync below makes the retry meaningful rather than a re-run of the same tree.
  if [ "$rc" -eq "$DAEMON_EXIT_STALE" ] && [ "$freshness_restarts" -lt "$FRESHNESS_RESTART_MAX" ]; then
    freshness_restarts=$((freshness_restarts + 1))
    log "exited $rc (freshness) — restart ${freshness_restarts}/${FRESHNESS_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  sleeping ${FRESHNESS_RESTART_PAUSE_S}s (not the ${RESTART_THROTTLE_S}s crash throttle) then re-running the fetch/checkout so the staleness actually clears"
    sleep "$FRESHNESS_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    continue
  fi

  # W1-T2537 — THE SECOND CASE THAT DOES NOT SPEND THE BUDGET, and for the same reason: a
  # `blocked` stop is a pass that RAN TO COMPLETION and found a task blocked. Re-syncing first is
  # not decoration — PRs may have merged while that pass ran, so the next pass genuinely has a
  # different board to work, which is what makes the retry meaningful rather than a re-run of the
  # same tree. Past the cap it falls through to the crash throttle below, so the bound is
  # REPLACED, never removed.
  if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ] && [ "$blocked_restarts" -lt "$BLOCKED_RESTART_MAX" ]; then
    blocked_restarts=$((blocked_restarts + 1))
    log "exited $rc (blocked) — restart ${blocked_restarts}/${BLOCKED_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  a blocked pass is a COMPLETED pass, not a crash; sleeping ${BLOCKED_RESTART_PAUSE_S}s then re-running the fetch/checkout so the next pass sees any merges"
    sleep "$BLOCKED_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    continue
  fi

  # EVERYTHING ELSE EXITS, AND IS COUNTED. A crash (`error` ⇒ 1) reaches here on its first
  # attempt, so `--restart=on-failure:N` bounds a crash loop exactly as it did before this block
  # existed. A freshness storm reaches here only after exhausting the loop above, which is what
  # keeps the in-container path from replacing a bound with nothing.
  if [ "$rc" -eq "$DAEMON_EXIT_STALE" ]; then
    log "exited $rc (freshness) — but ${FRESHNESS_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ]; then
    log "exited $rc (blocked) — but ${BLOCKED_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  log "exited $rc — sleeping ${RESTART_THROTTLE_S}s before exiting so the restart is rate-limited, not just counted"
  sleep "$RESTART_THROTTLE_S"
  exit "$rc"
done
