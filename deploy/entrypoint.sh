#!/usr/bin/env bash
# rmd-entrypoint — give the container a real git work tree before it runs anything.
#
# The image ships a source snapshot at /app with no `.git`, which used to break `rmd status`,
# `resolveOwnerRepo`, and the deployer's freshness check. This script clones or fetches into the
# mounted state volume instead, so the container always runs inside a real checkout.
#
# It deliberately does NOT decide when to reinstall dependencies or sync a dirty tree — both have
# owners elsewhere in this codebase (see the notes at each step).
#
# `RMD_SKIP_BOOTSTRAP=1` runs "$@" with no clone, no fetch and no install — for probing the image
# itself. `deploy/verify-image.sh` bypasses this script entirely, so it is unaffected either way.
# Why: the workaround this automates — docs/forensics/entrypoint.md#the-file-header.

set -euo pipefail

log() { printf 'rmd-entrypoint: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# ── Git identity runs before the skip, on purpose ────────────────────────────────────────────
# Invariant: this write must happen even under RMD_SKIP_BOOTSTRAP=1, because the skip below `exec`s
# and never returns — an identity written after it would never run. The skip is this script's
# documented recovery path (an operator inspecting a broken tree by hand), and that path needs to
# be able to commit too. The write is two local `git config` calls, so making it unconditional costs
# nothing and needs no network or token.
# Trap: this block used to sit below the skip, so RMD_SKIP_BOOTSTRAP=1 left the container with no
# identity at all — verify-image.sh's uid-1000 commit probe hit
# `fatal: unable to auto-detect email address`. Why: docs/forensics/entrypoint.md#git-identity--why-it-runs-before-the-skip.
#
# `mkdir -p` first: `git config --global` writes $HOME/.gitconfig and fails outright if HOME does
# not exist (the same trap recorded further down).
mkdir -p "${HOME:?HOME must be set — git config --global writes \$HOME/.gitconfig and cannot without it}"
if git -C / config --get user.email >/dev/null 2>&1 && git -C / config --get user.name >/dev/null 2>&1; then
  log "git identity: already configured ($(git -C / config --get user.name) <$(git -C / config --get user.email)>) — left alone"
else
  git config --global --replace-all user.name "${RMD_GIT_AUTHOR_NAME:-remudero-worker}"
  git config --global --replace-all user.email "${RMD_GIT_AUTHOR_EMAIL:-remudero-worker@users.noreply.github.com}"
  # `git -C /` here too, for the reason the guard above uses it: a bare `git config --get` resolves
  # local config, so from inside a repository this would report THAT repo's identity, not the
  # global one just written. Why: docs/forensics/entrypoint.md#git-identity--the-report-vs-write-asymmetry.
  log "git identity: $(git -C / config --get user.name) <$(git -C / config --get user.email)> (override with RMD_GIT_AUTHOR_NAME/RMD_GIT_AUTHOR_EMAIL)"
fi

if [ "${RMD_SKIP_BOOTSTRAP:-}" = "1" ]; then
  log "RMD_SKIP_BOOTSTRAP=1 — no clone, no fetch, no install (the identity above is already written)"
  exec "$@"
fi

REPO_URL="${RMD_REPO_URL:-https://github.com/craigoley/remudero.git}"

# RMD_REF recovers what a cloning container loses: the image digest no longer names exactly what
# runs, so a branch, tag or sha here lets an operator pin "run exactly this code again". Default is
# `main`, not a pinned sha — a sha default would need a rebuild to move, and a stale one silently
# runs old code while looking pinned. Why: docs/forensics/entrypoint.md#ref--the-pin-and-what-it-recovers.
REF="${RMD_REF:-main}"

# config.root is `$HOME/Remudero` (loadConfig, src/lib/config.ts); deriving both from HOME keeps
# this consistent with the image's ENV HOME and the volume the operator mounts.
: "${HOME:?HOME must be set — config.root derives from it and an unset HOME sends state to /}"
CONFIG_ROOT="$HOME/Remudero"
TREE="$CONFIG_ROOT/remudero"

# ── A credential helper, not a token on disk ─────────────────────────────────────────────────
# `gh auth setup-git` refuses with only GH_TOKEN set, and a token-bearing remote URL or gitconfig
# rewrite both write the token to disk and go stale on rotation. A helper reads $GH_TOKEN at call
# time instead — stored single-quoted so THIS shell never expands it — so nothing is ever written
# and rotation is just a new `-e GH_TOKEN`. Why: docs/forensics/entrypoint.md#credentials--a-helper-not-a-token-on-disk.
mkdir -p "$HOME"

# Installed UNCONDITIONALLY (W1-T2552), even with GH_TOKEN empty — the helper reads the variable
# when git actually calls it, not at boot, and an empty password is exactly what an unauthenticated
# push would send anyway. A prior `-n "$GH_TOKEN"` gate skipped installing it whenever the boot env
# carried an empty token (the deliberate default since W1-T2311), so every push died unreachable
# while reads kept working. Why: docs/forensics/entrypoint.md#credentials--installed-unconditionally-w1-t2552.
git config --global credential.helper \
  '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
log "git credentials: helper installed; reads GH_TOKEN at call time (not written to disk)"
if [ -z "${GH_TOKEN:-}" ]; then
  log "GH_TOKEN is empty at boot — expected under App auth; the daemon mints one into its own env"
fi

# ── The commit identity: without it a worker writes files and commits nothing ─────────────────
# Invariant: git cannot auto-detect an identity here — a container's hostname is a bare id, never
# fully qualified, so git's own `user@host` fallback is refused and `git commit` fails outright.
# Writing $HOME/.gitconfig is what makes an existing grant (`WORKER_HOME_SYMLINKS`,
# src/lib/worker-home.ts) resolve for every worker and orchestrator commit site in a container,
# exactly as it already does for a darwin host inheriting the operator's own identity.
#
# Configurable rather than baked into the image, because the identity most merged commits actually
# carry is the operator's own person — not the fleet's to assert, and not something a shared image
# should hold. It defaults to a purpose-scoped bot, in the same overridable shape this repo already
# uses for `rmd-feedback-bridge` and `fleet-heartbeat.sh`. `--replace-all` avoids duplicate keys on
# a re-boot, and the values are written only when git does not already resolve one.
#
# `git -C /` on the probe is load-bearing: a bare `git config --get` would resolve local config if
# this script's cwd sat inside a repository, when the worker actually commits under $HOME/Remudero.
# The write itself runs above the RMD_SKIP_BOOTSTRAP block, not here — see that block's own note.
# Why: docs/forensics/entrypoint.md#the-commit-identity--why-it-must-exist-and-why-it-lives-here.

# ── Resolving REF: a branch means the tip at boot, a sha means exactly that ──────────────────
# Invariant: `origin/$REF` is tried first, so a branch name means "the tip as of the fetch that
# just ran"; anything without a matching remote ref — a sha, a tag — falls through to the exact
# object, so a pin still means exactly what it says. Nothing here is silenced: a checkout that
# cannot proceed dies loudly rather than continuing on whatever HEAD happened to be.
# Trap: the old code checked out the LOCAL branch (frozen at clone time — fetch never moves it)
# and relied on a silenced `merge --ff-only` to climb back up, which regressed HEAD to the
# clone-time sha whenever the merge failed and stayed there on every later boot.
# Why: docs/forensics/entrypoint.md#resolving-ref--a-branch-means-the-tip-at-boot-a-sha-means-exactly-that.
resolve_target() {
  # A branch on the remote — the freshly-fetched tip.
  if git -C "$TREE" rev-parse --verify --quiet "refs/remotes/origin/$REF^{commit}"; then return 0; fi
  # Otherwise an exact object: a sha, a tag, anything else git can name.
  if git -C "$TREE" rev-parse --verify --quiet "$REF^{commit}"; then return 0; fi
  return 1
}

# ── W1-T1054: clear an untracked file only when it is provably redundant ──────────────────────
# Trap: the daemon writes `plan/feedback/**` into this same tree and later lands identical content
# upstream without deleting the local copy, so the next checkout can add a path that already exists
# here byte-for-byte — the tracked-only dirty guard does not see it, and `checkout_target` fails.
# Invariant: a path is cleared only if the incoming target adds that exact path AND the local bytes
# equal the incoming blob (`git hash-object`, byte comparison — never a shell string, which mangles
# binary data). An unreadable incoming blob (`git cat-file -e` fails) is treated as NOT safe, fail-
# closed like the dirty guard itself. Every cleared path is logged by name before removal.
# Falsifier: test/entrypoint-boot.test.ts's five "entrypoint:" cases for this predicate.
# Why: docs/forensics/entrypoint.md#clear_redundant_untracked--w1-t1054.
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

# ── The boot fetch retries a transient ref lock, bounded, and only a lock (W1-T2501) ─────────
# Invariant: the retry keys on the LOCK, never on failure generally — `cannot lock ref` / `unable
# to update local ref` is git's own wording for another process holding the ref, which clears on
# its own. A network or auth failure is not this case and keeps today's single-attempt, fail-open
# behaviour. Bounded by FETCH_LOCK_RETRY_MAX/FETCH_LOCK_RETRY_PAUSE_S; an exhausted retry does not
# die — it is reported as a named "STALE BOOT" so it stays as visible as an ordinary failure.
# Why: docs/forensics/entrypoint.md#boot_fetch--the-ref-lock-retry-w1-t2501.
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

# Retries only a ref-lock failure, up to FETCH_LOCK_RETRY_MAX times. Returns 0 on first or later
# success. Returns non-zero, having logged the git error, when the failure is not a lock (one
# attempt only) or retries are exhausted (FETCH_LOCK_EXHAUSTED=1, so the caller names a stale boot).
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

# Fetch, guard, checkout — a function (W1-T490) so the freshness-restart loop at the foot of this
# script can re-run it: a daemon that stopped `stale` must come back on the code that made it
# stale, and this is the only thing in the container that advances the tree.
sync_tree() {
  log "work tree present at $TREE"

  # ── Drop dead worktree registrations, before the fetch ────────────────────────────
  # Invariant: NOT the fetch's own `--prune` (that drops remote-tracking refs) — this drops
  # `.git/worktrees/` admin records whose checkout directory no longer exists. The bind-
  # mounted checkout accumulates the HOST's own registrations, pointing at host paths that
  # never existed in the container.
  # Trap: `git gc` aborts its whole repack on one unreadable registered worktree HEAD, then
  # writes `.git/gc.log`, which makes git decline every later automatic cleanup — and gc does
  # not expire a registration on its own for months. Pruning here, before the fetch that can
  # trigger an automatic gc, is what stops that. Non-fatal (`worktree prune` exits 128 outside
  # a repo): logged, never blocks the boot. This does not clear an existing gc.log — see below.
  # Why: docs/forensics/entrypoint.md#sync_tree--pruning-dead-worktree-registrations-before-the-fetch.
  git -C "$TREE" worktree prune || log "worktree prune FAILED — continuing (housekeeping never blocks the boot)"

  if ! boot_fetch; then
    if [ "$FETCH_LOCK_EXHAUSTED" -eq 1 ]; then
      log "STALE BOOT: fetch FAILED after $FETCH_LOCK_RETRY_MAX attempt(s), still ref-locked — continuing on the tree as it stands"
    else
      log "fetch FAILED — continuing on the tree as it stands"
    fi
  fi

  # A stuck repo stays stuck, deliberately: `worktree prune` removes the cause, not an existing
  # `.git/gc.log`, because this script cannot tell a stale log from one a maintenance run is
  # still writing. It reports the file and leaves clearing it to an operator.
  # Why: docs/forensics/entrypoint.md#sync_tree--reporting-a-stuck-gclog-rather-than-clearing-it.
  if [ -f "$TREE/.git/gc.log" ]; then
    log "NOTE: $TREE/.git/gc.log exists — git is declining AUTOMATIC cleanup until it is removed."
    log "  The stale registrations above are pruned, so the cause is gone, but the log is not"
    log "  cleared here: it belongs to whatever wrote it. To recover, with no lane running:"
    log "    rm -f $TREE/.git/gc.log && git -C $TREE gc --prune=now"
  fi

  # ── The dirty-tree rule is the deployer's, not a new one ──────────────────────────
  # Invariant: `decideDeploy` (src/lib/deployer.ts) never discards uncommitted work to force a
  # sync. This check is stricter than that one — it refuses on ANY tracked dirt rather than
  # reimplementing `treeFfSafe`'s overlap-only conflict in shell, which errs toward leaving the
  # tree alone.
  # Trap: `-uno` is load-bearing, not tidy — plain `--porcelain` also lists untracked files, and
  # the first boot creates one immediately (node_modules), which would refuse every sync after it
  # forever. Untracked files cannot conflict with a fast-forward, so excluding them matches what
  # this check is actually for. Why: docs/forensics/entrypoint.md#sync_tree--the-dirty-tree-rule-is-the-deployers-not-a-new-one.
  if [ -n "$(git -C "$TREE" status --porcelain -uno)" ]; then
    log "REFUSING to sync: the work tree has uncommitted changes."
    log "  Nothing has been discarded and nothing was fetched into the checkout."
    log "  This is deliberately stricter than the deployer, which conflicts only on files the"
    log "  fast-forward would touch. Commit or stash, or run with RMD_SKIP_BOOTSTRAP=1."
  else
    # One step, not checkout-then-merge: the target IS the freshly-fetched tip (see the resolver
    # above), so a single detach lands on it directly — no merge to silently fail.
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

# Print the resolved commit unconditionally — the pin is worthless if "which code ran" cannot be
# answered after the fact.
log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"

# ── The bootstrap install, and only that ─────────────────────────────────────────────────────
# Invariant: `ensureInstallFresh` (src/run-task.ts) already decides "should I reinstall" for every
# later run, so this script owes only the FIRST install — it cannot reach that check itself, since
# `bin/rmd` needs `node_modules/.bin/tsx` to run at all. Conditioned on tsx being absent, not on
# freshness. The clone gets its OWN node_modules, deliberately not shared with /app's (Dockerfile
# REQ 4). Why: docs/forensics/entrypoint.md#the-bootstrap-install-and-only-that.
if [ ! -x "$TREE/node_modules/.bin/tsx" ]; then
  log "no node_modules/.bin/tsx — running the bootstrap install (rmd's own freshness check takes over after this)"
  ( cd "$TREE" && npm ci ) || die "npm ci failed in $TREE"
else
  log "node_modules present — leaving install freshness to ensureInstallFresh"
fi

cd "$TREE"

# ── The restart rate limit: the container counterpart of launchd's ThrottleInterval ───────────
# Invariant: docker's `--restart=on-failure:N` caps the restart COUNT, never the RATE, so this
# sleeps before a non-zero exit to rate-limit it. Since W1-T490 it also LOOPS in-container, but
# only for `DAEMON_EXIT_STALE`: `sync_tree` is a function now, so the loop can re-run the fetch and
# checkout on each retry, and staleness clears exactly as a container restart would clear it. Every
# other non-zero exit still falls straight through to the sleep and the exit — an unconditional
# loop would delete docker's crash-loop bound entirely, which this narrow re-entry does not.
# Trap: `stale` used to share exit code 1 with a real crash, so a routine freshness restart (far
# more frequent than a crash) spent the same finite `on-failure` budget — measured cost, a 2h56m
# outage. Splitting the code is what lets a healthy, frequently-restarting fleet avoid spending a
# crash-loop budget it was never meant to touch.
# Exit 0 is never throttled: an operator-requested stop must not acquire extra latency.
# The interval is supplied at `docker run`, never read from the repo — reading it here would need
# the plan loadable at exactly the moment an unloadable plan is what is crashing the daemon.
# Opt-in: unset, this script still `exec`s, so a one-shot verb pays no latency on a non-zero exit.
# Why: docs/forensics/entrypoint.md#the-restart-rate-limit--why-the-container-needs-one-at-all.
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

# Duplicated from `DAEMON_EXIT_STALE` (src/lib/daemon.ts) — this script runs before any node
# process exists, so it cannot import the constant. test/entrypoint-boot.test.ts greps both this
# and the two below out of the file and asserts they equal the exported constants, so a drift is a
# red test, never a silent mis-route.
DAEMON_EXIT_STALE=75

# Duplicated from `DAEMON_EXIT_BLOCKED`, same reason and same falsifier as above.
DAEMON_EXIT_BLOCKED=76
# Duplicated from `DAEMON_EXIT_ENVIRONMENTAL`, same reason and same falsifier as above.
DAEMON_EXIT_ENVIRONMENTAL=77
# 100, not the original 20: MEASURED 2026-08-18 merge rates (median 63/day) spend a budget of 20
# inside a single day, after which a routine freshness exit falls through and spends the crash
# budget instead — the exact conflation this whole block exists to undo. Worst case is
# FRESHNESS_RESTART_MAX x FRESHNESS_RESTART_PAUSE_S (500s), and every restart re-runs `sync_tree`'s
# real fetch, a cost accepted deliberately for the headroom.
# Why: docs/forensics/entrypoint.md#why-freshness_restart_max-is-100-measured-2026-08-18.
FRESHNESS_RESTART_MAX="${RMD_FRESHNESS_RESTART_MAX:-100}"
case "$FRESHNESS_RESTART_MAX" in
  '' | *[!0-9]*)
    log "RMD_FRESHNESS_RESTART_MAX is not a whole number — ignoring it and using 100"
    FRESHNESS_RESTART_MAX=100
    ;;
esac

# The freshness retry gets its own short pause, separate from the crash throttle above: a
# freshness restart is not the boot-failing-the-same-way shape that throttle exists to slow (see
# docs/forensics/entrypoint.md#the-restart-rate-limit--why-the-container-needs-one-at-all), and
# sleeping the full crash throttle here bought nothing but idle time. The bound is replaced, not
# removed — still capped at `FRESHNESS_RESTART_MAX` attempts.
FRESHNESS_RESTART_PAUSE_S="${RMD_FRESHNESS_RESTART_PAUSE_S:-5}"
case "$FRESHNESS_RESTART_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_FRESHNESS_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 5"
    FRESHNESS_RESTART_PAUSE_S=5
    ;;
esac

# ── W1-T2537: the blocked retry, the other half of the freshness loop ────────────────────────
# Invariant: a `blocked` stop is a COMPLETED drain pass, not a crash — charging it to docker's
# `on-failure:N` anyway left the container down for 46+ minutes after a pass that had actually
# dispatched three tasks (MEASURED 2026-08-30). The loop is self-sustaining: a red board is what
# produces blocked passes, so the crash budget empties fastest exactly when draining is needed most.
# The cap mirrors FRESHNESS_RESTART_MAX; the pause is the daemon's own DEFAULT_POLL_INTERVAL_MS
# (60s) — "check back once a minute while nothing is runnable" is what a blocked board is.
# Why: docs/forensics/entrypoint.md#the-blocked-retry--the-other-half-of-the-freshness-loop-w1-t2537.
BLOCKED_RESTART_MAX="${RMD_BLOCKED_RESTART_MAX:-100}"
case "$BLOCKED_RESTART_MAX" in
  '' | *[!0-9]*)
    log "RMD_BLOCKED_RESTART_MAX is not a whole number — ignoring it and using 100"
    BLOCKED_RESTART_MAX=100
    ;;
esac

ENVIRONMENTAL_RESTART_MAX="${RMD_ENVIRONMENTAL_RESTART_MAX:-100}"
case "$ENVIRONMENTAL_RESTART_MAX" in
  ''|*[!0-9]*)
    log "RMD_ENVIRONMENTAL_RESTART_MAX is not a whole number — ignoring it and using 100"
    ENVIRONMENTAL_RESTART_MAX=100
    ;;
esac
# WHY 300s AND NOT 60s: unlike a blocked pass, waiting is the ENTIRE remedy here. A GitHub primary
# rate limit resets on the hour and a secondary limit has held this account for ~90 minutes, so
# retrying a minute later just spends another refusal. Five minutes is short enough that a brief
# 5xx clears quickly and long enough that a real lockout is waited out rather than hammered.
ENVIRONMENTAL_RESTART_PAUSE_S="${RMD_ENVIRONMENTAL_RESTART_PAUSE_S:-300}"
case "$ENVIRONMENTAL_RESTART_PAUSE_S" in
  ''|*[!0-9]*)
    log "RMD_ENVIRONMENTAL_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 300"
    ENVIRONMENTAL_RESTART_PAUSE_S=300
    ;;
esac
BLOCKED_RESTART_PAUSE_S="${RMD_BLOCKED_RESTART_PAUSE_S:-60}"
case "$BLOCKED_RESTART_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_BLOCKED_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 60"
    BLOCKED_RESTART_PAUSE_S=60
    ;;
esac

# ── Signal forwarding (W1-T1067): restore what `exec` gives for free ────────────────────────
# Invariant: once the throttle is non-zero, this shell runs the daemon as a SEPARATE backgrounded
# process rather than exec'ing it, so a signal tini sends no longer reaches the daemon unless this
# shell forwards it. Without the trap below, this shell's default TERM disposition is to die
# immediately, orphaning the daemon with nothing forwarded until docker's SIGKILL grace period —
# too late for its own handler to release `state/drain.lock` (measured on a live container: node
# had already been SIGKILLed with the lock still held).
# Trap: a handled TERM must exit 0, or `docker stop` never sticks. The daemon re-raises the signal
# against itself once its cleanup is done, so a clean stop still carries wait status 143 — which
# `on-failure` cannot tell from a crash, so an operator's stop silently comes back on its own
# (measured cost: ~24 minutes and ~$45 before anyone noticed). `signal_forwarded` is the fact this
# shell knows and `daemonExitCode` cannot: it is what received TERM/INT and chose to forward it,
# set only after a live child was actually signalled, never inferred from the exit code alone.
# Falsifier: the real exit code is captured inside the trap's own fresh `wait`, not by resuming the
# interrupted one — bash returns a pseudo-status >128 from an interrupted `wait`, which describes
# bash's own interruption, never the child's outcome.
# Why: docs/forensics/entrypoint.md#signal-forwarding--restoring-what-exec-gives-for-free-w1-t1067.
signal_forwarded=""
child_pid=""
child_rc=""
forward_signal() {
  sig="$1"
  if [ -n "$child_pid" ]; then
    log "received $sig — forwarding to pid $child_pid so it can release its locks before exiting"
    kill "-$sig" "$child_pid" 2>/dev/null || true
    child_rc=0
    wait "$child_pid" 2>/dev/null || child_rc=$?
    signal_forwarded=1
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

# Trap: the exit code must be captured from the SAME command that runs it — `if "$@"; then ...; fi;
# rc=$?` reads $? from the compound, which is 0 whenever the condition merely tested false, so a
# crashing daemon read as a success. Backgrounded, not foreground, so the trap above can react
# while it runs; `child_rc` starts empty every pass and only the trap sets it, so an unsignaled
# exit leaves `rc` exactly what the plain `wait` below produces.
freshness_restarts=0
blocked_restarts=0
environmental_restarts=0
while :; do
  rc=0
  child_rc=""
  signal_forwarded=""
  "$@" &
  child_pid=$!
  wait "$child_pid" || rc=$?
  if [ -n "$child_rc" ]; then
    rc=$child_rc
  fi
  child_pid=""

  # W1-T2586: A SIGNAL THIS SHELL ITSELF FORWARDED OUTRANKS EVERY OTHER CLASSIFICATION BELOW.
  # `signal_forwarded` is set ONLY inside `forward_signal`, ONLY after TERM/INT was actually sent
  # to a live child — so reaching here with it set means an operator (or a supervisor's `docker
  # stop`) asked this container to shut down, the daemon was told, and it exited AS A RESULT,
  # whatever its raw wait status ($rc, typically 143 — 128+SIGTERM). That is what a graceful
  # operator stop means to every process supervisor: exit 0, and RIGHT NOW, never after the crash
  # throttle below. THE UNSIGNALED PATHS ARE ALL LEFT ALONE: this branch cannot fire without a
  # real forwarded signal, so a genuine crash (no signal, non-zero $rc) still falls through to
  # the non-zero handling further down and is still counted by docker exactly as before.
  if [ -n "$signal_forwarded" ]; then
    log "operator stop handled: $sig was forwarded and the daemon exited $rc as a result — reporting a CLEAN exit (0) so on-failure does not read a deliberate stop as a crash"
    exit 0
  fi

  if [ "$rc" -eq 0 ]; then
    log "exited 0 — not throttled (a STOP is a clean stop; --restart=on-failure leaves the container down)"
    exit 0
  fi

  # A `stale` stop is not a failure — the daemon wants exactly this restart, on code that has
  # since merged — so serving it here means docker never counts it, and the re-sync makes the
  # retry meaningful rather than a re-run of the same tree.
  if [ "$rc" -eq "$DAEMON_EXIT_STALE" ] && [ "$freshness_restarts" -lt "$FRESHNESS_RESTART_MAX" ]; then
    freshness_restarts=$((freshness_restarts + 1))
    log "exited $rc (freshness) — restart ${freshness_restarts}/${FRESHNESS_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  sleeping ${FRESHNESS_RESTART_PAUSE_S}s (not the ${RESTART_THROTTLE_S}s crash throttle) then re-running the fetch/checkout so the staleness actually clears"
    sleep "$FRESHNESS_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    continue
  fi

  # W1-T2537 — the second case that does not spend the budget: a `blocked` stop is a pass that
  # ran to COMPLETION, so re-syncing first gives the next pass a genuinely different board. Past
  # the cap it falls through to the crash throttle, so the bound is replaced, never removed.
  if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ] && [ "$blocked_restarts" -lt "$BLOCKED_RESTART_MAX" ]; then
    blocked_restarts=$((blocked_restarts + 1))
    log "exited $rc (blocked) — restart ${blocked_restarts}/${BLOCKED_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  a blocked pass is a COMPLETED pass, not a crash; sleeping ${BLOCKED_RESTART_PAUSE_S}s then re-running the fetch/checkout so the next pass sees any merges"
    sleep "$BLOCKED_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    continue
  fi

  # W1-T2546 — the third case that does not spend the budget: an environmental refusal (a GitHub
  # rate-limit 403, a 5xx, a transport fault) is not a crash, and waiting is the correct response.
  # During a lockout window every pass can die this way, draining the crash budget at the rate the
  # limiter refuses. Past the cap it falls through to the crash throttle, bound replaced not removed.
  # Why: docs/forensics/entrypoint.md#the-environmental-refusal-retry-arm-w1-t2546.
  if [ "$rc" -eq "$DAEMON_EXIT_ENVIRONMENTAL" ] && [ "$environmental_restarts" -lt "$ENVIRONMENTAL_RESTART_MAX" ]; then
    environmental_restarts=$((environmental_restarts + 1))
    log "exited $rc (environmental) — restart ${environmental_restarts}/${ENVIRONMENTAL_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  an environmental refusal is not a crash; sleeping ${ENVIRONMENTAL_RESTART_PAUSE_S}s to let the limit reset, then re-running the fetch/checkout"
    sleep "$ENVIRONMENTAL_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    continue
  fi

  # Everything else exits, and is counted: a crash reaches here on its first attempt, so
  # `--restart=on-failure:N` still bounds a crash loop exactly as before this block existed.
  if [ "$rc" -eq "$DAEMON_EXIT_STALE" ]; then
    log "exited $rc (freshness) — but ${FRESHNESS_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ]; then
    log "exited $rc (blocked) — but ${BLOCKED_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  if [ "$rc" -eq "$DAEMON_EXIT_ENVIRONMENTAL" ]; then
    log "exited $rc (environmental) — but ${ENVIRONMENTAL_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  log "exited $rc — sleeping ${RESTART_THROTTLE_S}s before exiting so the restart is rate-limited, not just counted"
  sleep "$RESTART_THROTTLE_S"
  exit "$rc"
done
