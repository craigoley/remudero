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
# W1-T6160: a complete RMD_GIT_AUTHOR_* pair is the container's declared author, so it is written even
# over an identity HOME already holds, then read back; a write/read error or mismatch stops the boot.
# A partial pair or none keeps the configured-identity/default behaviour below.
if [ -n "${RMD_GIT_AUTHOR_NAME:-}" ] && [ -n "${RMD_GIT_AUTHOR_EMAIL:-}" ]; then
  git config --global --replace-all user.name "${RMD_GIT_AUTHOR_NAME}" \
    || die "git identity: FAILED to write user.name to the global config (\$HOME/.gitconfig) — refusing to boot on an unapplied author"
  git config --global --replace-all user.email "${RMD_GIT_AUTHOR_EMAIL}" \
    || die "git identity: FAILED to write user.email to the global config (\$HOME/.gitconfig) — refusing to boot on an unapplied author"
  applied_name="$(git -C / config --global --get user.name 2>/dev/null)" \
    || die "git identity: FAILED to read user.name back from the global config — refusing to boot on an unverified author"
  applied_email="$(git -C / config --global --get user.email 2>/dev/null)" \
    || die "git identity: FAILED to read user.email back from the global config — refusing to boot on an unverified author"
  if [ "${applied_name}" != "${RMD_GIT_AUTHOR_NAME}" ] || [ "${applied_email}" != "${RMD_GIT_AUTHOR_EMAIL}" ]; then
    die "git identity: the global config does not hold the RMD_GIT_AUTHOR_* pair after writing it — refusing to boot on a mismatched author"
  fi
  log "git identity: ${applied_name} <${applied_email}> (explicit RMD_GIT_AUTHOR_NAME/RMD_GIT_AUTHOR_EMAIL pair, authoritative)"
elif git -C / config --get user.email >/dev/null 2>&1 && git -C / config --get user.name >/dev/null 2>&1; then
  log "git identity: already configured ($(git -C / config --get user.name) <$(git -C / config --get user.email)>) — left alone"
else
  # Under App auth the fallback is the fleet App's bot identity, which GitHub and Vercel map to an account;
  # remudero-worker maps to none, so Vercel blocked every fleet preview once RMD_GIT_AUTHOR_* went missing
  # (site #189, console #2030/#2032, 2026-10-08). Same identity as src/lib/feedback-landing.ts.
  if [ -n "${GH_APP_ID:-}" ]; then
    default_author_name="remudero-fleet[bot]"
    default_author_email="318611788+remudero-fleet[bot]@users.noreply.github.com"
  else
    default_author_name="remudero-worker"
    default_author_email="remudero-worker@users.noreply.github.com"
  fi
  git config --global --replace-all user.name "${RMD_GIT_AUTHOR_NAME:-$default_author_name}"
  git config --global --replace-all user.email "${RMD_GIT_AUTHOR_EMAIL:-$default_author_email}"
  # `git -C /` here too, for the reason the guard above uses it: a bare `git config --get` resolves
  # local config, so from inside a repository this would report THAT repo's identity, not the
  # global one just written. Why: docs/forensics/entrypoint.md#git-identity--the-report-vs-write-asymmetry.
  log "git identity: $(git -C / config --get user.name) <$(git -C / config --get user.email)> (override with RMD_GIT_AUTHOR_NAME/RMD_GIT_AUTHOR_EMAIL)"
fi

# ── W1-T12293: the Claude account file survives a container recreate ─────────────────────────
# deploy/recycle-container.sh mounts the host file read-only at the side path. Copy it in only when
# ~/.claude.json is missing or holds no login; never replace one that does. Never print the content.
account_file_holds_login() {
  node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(j && typeof j.oauthAccount === "object" && j.oauthAccount !== null ? 0 : 1) } catch { process.exit(1) }' "$1" 2>/dev/null
}
seed_claude_account_file() {
  local target="${HOME}/.claude.json" side="${HOME}/.rmd-claude-account.json" case_name="it was missing" tmp=""
  if [ ! -f "${side}" ]; then log "claude account file: no host copy at ${side}; ${target} left as it is"; return 0; fi
  if [ -e "${target}" ] && [ ! -f "${target}" ]; then log "claude account file: NOT seeded — ${target} is not a regular file"; return 0; fi
  if [ -f "${target}" ]; then
    if account_file_holds_login "${target}"; then log "claude account file: kept ${target} (it holds a login)"; return 0; fi
    case_name="it held no login"
  fi
  if ! account_file_holds_login "${side}"; then log "claude account file: NOT seeded — the host copy holds no login"; return 0; fi
  if tmp="$(mktemp "${HOME}/.claude.json.rmd-seed.XXXXXX")" && cp "${side}" "${tmp}" && chmod 0600 "${tmp}" && mv -f "${tmp}" "${target}"; then
    log "claude account file: seeded from the host copy (${case_name})"
  else
    [ -z "${tmp}" ] || rm -f "${tmp}"
    log "claude account file: NOT seeded — the copy to ${target} failed"
  fi
}
seed_claude_account_file

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
# object, so a pin still means exactly what it says. Nothing here is silenced: a refused checkout is
# a named STALE BOOT on a sync (W1-T9631, below) and dies on the clone path, never a quiet HEAD.
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

# ── W1-T1054 / W1-T9623: an untracked file at a path the incoming commit ADDS ─────────────────
# The daemon writes `plan/feedback/**` into this tree and lands it upstream, so the checkout can add
# a path that is untracked here. Identical bytes (`git hash-object` vs the incoming blob) are cleared;
# DIFFERENT bytes are moved to state/recovered-untracked/<stamp>/<path> and ledgered, never left to
# refuse every boot (2026-10-15: 45 such files, 2 h 6 m down). An unreadable blob or a failed move is
# left in place, and the checkout refuses as before. Falsifier: test/entrypoint-boot.test.ts's
# "entrypoint:" and "W1-T9623:" cases. Why: docs/forensics/entrypoint.md#clear_redundant_untracked--w1-t1054.
RECOVERED_UNTRACKED_ROOT="$CONFIG_ROOT/state/recovered-untracked"
MOVED_ASIDE_DIR=""

json_escape() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "${s//$'\n'/\\n}" | tr -d '\000-\010\013\014\016-\037'
}

move_untracked_aside() {
  local path="$1" local_sha="$2" blob="$3" dest
  if [ -z "$MOVED_ASIDE_DIR" ]; then
    MOVED_ASIDE_DIR="$RECOVERED_UNTRACKED_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  dest="$MOVED_ASIDE_DIR/$path"
  if ! mkdir -p -- "$(dirname -- "$dest")" || ! mv -- "$TREE/$path" "$dest"; then
    log "  leaving untracked '$path' in place: the incoming commit adds this path with DIFFERENT bytes, and moving it aside to $dest failed"
    return 0
  fi
  log "  moved untracked '$path' aside to $dest: the incoming commit adds this path with DIFFERENT bytes, which would refuse every checkout; the local bytes are kept there"
  [ -d "$(dirname -- "$LEDGER_FILE")" ] || return 0
  printf '{"ts":"%s","run_id":"ENTRYPOINT-%s","task_id":"DAEMON","step":"entrypoint.untracked_moved_aside","lane":"daemon","path":"%s","moved_to":"%s","local_blob":"%s","incoming_blob":"%s","reason":"the incoming commit adds this untracked path with different bytes, so git checkout would refuse every boot"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$$" "$(json_escape "$path")" "$(json_escape "$dest")" "$local_sha" "$blob" \
    >> "$LEDGER_FILE" || log "  (the ledger line for '$path' could not be written; this log line stands)"
  return 0
}

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
      move_untracked_aside "$path" "$local_sha" "$blob"
    fi
  done < <(git -C "$TREE" ls-files --others --exclude-standard -z)
}

try_checkout_target() {
  CHECKOUT_ERROR=""
  if ! TARGET="$(resolve_target)"; then
    TARGET=""
    CHECKOUT_DIE="ref not found: $REF (tried origin/$REF, then $REF as an exact object)"
    CHECKOUT_ERROR="$CHECKOUT_DIE"
    return 1
  fi
  clear_redundant_untracked "$TARGET"
  if ! out="$(git -C "$TREE" checkout --detach "$TARGET" 2>&1)"; then
    log "CHECKOUT FAILED toward $REF ($TARGET):"
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    log "  A common cause is an UNTRACKED file at a path an incoming commit also adds: the"
    log "  tracked-only dirty guard sees a clean tree, and git will not overwrite it. Remove the"
    log "  file, or start with RMD_SKIP_BOOTSTRAP=1 to inspect the tree by hand."
    CHECKOUT_DIE="cannot check out $REF ($TARGET)"
    CHECKOUT_ERROR="$out"
    return 1
  fi
}

checkout_target() {
  try_checkout_target || die "$CHECKOUT_DIE"
}

# ── W1-T9631: a sync whose checkout refuses runs HEAD (the tree that last booted, if tracked-clean) as a STALE BOOT ──
# Exiting was a crash loop no revive fixes (2026-10-15: 25 in 2 h 7 m). It logs, ledgers, spools an escalation, and exports RMD_BOOT_CHECKOUT_BLOCKED
# so the daemon won't restart into it; recovery withdraws/closes it; the clone path still dies. Falsifier: test/a-boot-that-cannot-advance-runs-the-tree-that-last-booted.test.ts.
STALE_BOOT_SPOOL_NAME="escalate-entrypoint-stale-boot.json"

spool_host() { hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' || :; }

stale_boot_spool() {
  local head="$1" dir="$STATE_DIR/escalation-spool" now first count=1 host detail tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  first="$now"
  host="$(spool_host)"
  mkdir -p "$dir" || { log "  (the stale-boot escalation could not be spooled: cannot create $dir)"; return 0; }
  if [ -f "$dir/$STALE_BOOT_SPOOL_NAME" ]; then
    first="$(sed -n 's/.*"firstAt":"\([^"]*\)".*/\1/p' "$dir/$STALE_BOOT_SPOOL_NAME")"
    count="$(sed -n 's/.*"count":\([0-9]*\).*/\1/p' "$dir/$STALE_BOOT_SPOOL_NAME")"
    count=$(( ${count:-0} + 1 ))
    [ -n "$first" ] || first="$now"
  fi
  detail="The daemon's boot checkout could not advance to $REF ($TARGET), so it is running HEAD $head, the tree that last booted, instead of exiting. It will not freshness-restart toward $TARGET; it retries once origin/main moves past it. Git said: $CHECKOUT_ERROR"
  tmp="$dir/.$STALE_BOOT_SPOOL_NAME.tmp-$$"
  printf '{"v":1,"key":"escalate-entrypoint-stale-boot","source":"entrypoint","host":"%s","firstAt":"%s","lastAt":"%s","count":%s,"headline":"entrypoint: STALE BOOT on %s, the boot checkout cannot reach %s","kind":"escalate","escalation":{"class":"BLOCKED","taskId":"DAEMON","summary":"daemon boot checkout cannot advance: running the tree that last booted (STALE BOOT)","detail":"%s","options":[{"label":"Fix the checkout","detail":"Remove what makes git refuse the checkout in the daemon tree (named in the detail); the next freshness restart lands on main."},{"label":"Leave it","detail":"The daemon keeps running the stale tree and retries once origin/main moves past the blocked target."}],"recommendation":"Fix the checkout"}}\n' \
    "${host:-unknown}" "$first" "$now" "$count" "${head:0:12}" "${TARGET:0:12}" "$(json_escape "$detail")" > "$tmp" \
    && mv -f -- "$tmp" "$dir/$STALE_BOOT_SPOOL_NAME" \
    || { rm -f -- "$tmp"; log "  (the stale-boot escalation could not be spooled; the log line and ledger row stand)"; }
  return 0
}

checkout_unblocked() {
  local dir="$STATE_DIR/escalation-spool" url now
  unset RMD_BOOT_CHECKOUT_BLOCKED
  rm -f -- "$dir/$STALE_BOOT_SPOOL_NAME"
  [ -f "$dir/delivered/$STALE_BOOT_SPOOL_NAME" ] || return 0
  url="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$dir/delivered/$STALE_BOOT_SPOOL_NAME")"
  [ -n "$url" ] || return 0
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '{"v":1,"key":"close-entrypoint-stale-boot","source":"entrypoint","host":"%s","firstAt":"%s","lastAt":"%s","count":1,"headline":"entrypoint: the boot checkout advanced again, closing the STALE BOOT issue","kind":"close","url":"%s","body":"The boot checkout reached %s again (HEAD %s), so the daemon is no longer running a stale tree."}\n' \
    "$(spool_host)" "$now" "$now" "$(json_escape "$url")" "$(json_escape "$REF")" "$(git -C "$TREE" rev-parse HEAD)" \
    > "$dir/close-entrypoint-stale-boot.json" || log "  (the stale-boot close could not be spooled)"
  return 0
}

stale_boot_on_head() {
  local head dirt
  head="$(git -C "$TREE" rev-parse --verify --quiet 'HEAD^{commit}')" \
    || die "$CHECKOUT_DIE — and HEAD does not resolve, so there is no tree that last booted to run"
  dirt="$(git -C "$TREE" status --porcelain --untracked-files=no)" \
    || die "$CHECKOUT_DIE — and git cannot read the tree's status, so it cannot be vouched for as the tree that last booted"
  [ -z "$dirt" ] \
    || die "$CHECKOUT_DIE — and the refused checkout left tracked changes, so the tree is no longer the one that last booted"
  log "STALE BOOT: CHECKOUT FAILED toward $REF (${TARGET:-unresolved}) — continuing on HEAD $head, the tree that last booted"
  log "  ($CHECKOUT_DIE.) Ledgered as entrypoint.stale_boot and escalated; the daemon will not freshness-restart toward the same target."
  if [ -n "$TARGET" ]; then
    export RMD_BOOT_CHECKOUT_BLOCKED="$TARGET"
  else
    unset RMD_BOOT_CHECKOUT_BLOCKED
  fi
  if mkdir -p "$STATE_DIR"; then
    printf '{"ts":"%s","run_id":"ENTRYPOINT-%s","task_id":"DAEMON","step":"entrypoint.stale_boot","lane":"daemon","head":"%s","target":"%s","ref":"%s","error":"%s","reason":"the boot checkout could not advance, so the daemon runs the tree that last booted instead of exiting"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$$" "$head" "$TARGET" "$(json_escape "$REF")" "$(json_escape "$CHECKOUT_ERROR")" \
      >> "$LEDGER_FILE" || log "  (the entrypoint.stale_boot ledger row could not be written; this log line stands)"
  fi
  stale_boot_spool "$head"
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
    if ! printf '%s' "$fetch_out" | grep -iE 'cannot lock ref|unable to update local ref' > /dev/null; then
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

  # ── REPAIR THE ONE CONTRADICTION THIS SCRIPT CAN PROVE (W1-T3228) ─────────────────────────────
  # The line above is a FILESYSTEM reading; every git command below asks a different question, and
  # when the two disagree this script used to fail with git's answer and report the filesystem's.
  #
  # MEASURED 2026-09-09 on the Azure host: `core.bare=true` was set on the daemon's checkout at
  # 02:37:36 while the tree was fully intact — 3,551 index entries, HEAD at a real commit, status
  # clean. git then refused every worktree operation ("fatal: this operation must be run in a work
  # tree"), so the checkout failed, this script exited 1 as it should, and `rmd daemon` NEVER RAN.
  # The fleet watchdog revived the container every five minutes for 7h32m, each attempt dying at
  # exactly this line, because a revive cannot fix the reason a thing dies. No daemon-side
  # self-repair could ever have reached it: the daemon is what failed to start.
  #
  # WHY THIS ONE IS SAFE TO REPAIR AND ALMOST NOTHING ELSE IS. A directory that HOLDS a populated
  # work tree while its own config declares the repo bare is not an ambiguous state to be
  # interpreted — it is a config that contradicts its own contents, and there is exactly one value
  # that reconciles them. The repair is a single boolean, reversible, and touches no object, ref or
  # file. It is NOT a licence to repair anything else here: every other failure below still refuses,
  # because "the tree is not what I expected" and "the config disagrees with the tree" are different
  # questions and only the second has one answer.
  #
  # THE REPAIR IS LOUD. A silent fix would hide a hook that is still rewriting this config on every
  # push (W1-T3224 is the mechanism, unmerged at the time of writing), so the line below is the
  # thing an operator greps for when asking why the flag came back.
  if [ "$(git -C "$TREE" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] && [ -d "$TREE/.git" ]; then
    log "REPAIRING: core.bare=true on a directory that holds a work tree — git would refuse every"
    log "  checkout below while this script reported the tree present. Unsetting it; nothing else is touched."
    log "  If this recurs, something is WRITING that flag: a hook child inheriting GIT_DIR is the known cause."
    git -C "$TREE" config --local core.bare false || log "  WARNING: could not unset core.bare — the checkout below will fail and say so"
  fi

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

  # Report only: the daemon cadence owns recovery after useful admission.
  if [ -f "$TREE/.git/gc.log" ]; then
    log "NOTE: $TREE/.git/gc.log exists — autonomous daemon maintenance will retry at a quiet boundary."
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
    if try_checkout_target; then
      checkout_unblocked
    else
      stale_boot_on_head
    fi
  fi
}

# ── W1-T3684: the PATH `rmd` resolves to becomes the tree this script just chose ─────────────
# Invariant: an operator's bare `rmd` and the daemon this script execs must load the SAME src/,
# never the `/app` snapshot the image bakes, which can sit arbitrarily many commits behind by the
# time anyone runs it. Prepending `$TREE/bin` to PATH makes any later lookup of the word `rmd`
# resolve there first.
# Trap: `bin/rmd` resolves its own package root from its OWN on-disk location, so a PATH hit on
# `/app/bin/rmd` stays pinned to `/app` no matter how it was found — `src/lib/image-drift.ts`
# (W1-T1021) rightly calls `/app` "inert", but that is false for its own `bin/rmd`.
# The fallback stays silent only under `RMD_SKIP_BOOTSTRAP=1`, where this function is never
# called (no tree exists yet). Every OTHER call site runs after a real checkout, so a live tree
# with no usable `bin/rmd` is a loud ERROR, never a silent fall back to code of unknown age.
# Falsifier: test/the-cli-on-path-resolves-to-the-live-tree.test.ts.
resolve_rmd_on_path() {
  if [ -x "$TREE/bin/rmd" ]; then
    PATH="$TREE/bin:$PATH"
    export PATH
    log "rmd on PATH -> $TREE/bin/rmd (tree $TREE, $(git -C "$TREE" rev-parse --short HEAD))"
  else
    die "live tree at $TREE has no usable bin/rmd (missing or not executable) — refusing to silently fall back to a snapshot of unknown age"
  fi
}

# ── W1-T4195: before the fetch and the daemon, refuse by name a mutable path this uid cannot write;
# never chown (a privileged repair is an operator act). Falsifier: test/a-root-owned-runtime-path-is-refused-at-boot.test.ts.
STATE_DIR="$CONFIG_ROOT/state"
LEDGER_FILE="$STATE_DIR/ledger.ndjson"

refuse_unwritable() {
  die "REFUSING TO START: $1 is not writable by uid $(id -u) ($(id -un 2>/dev/null || echo unknown)) — owner $(ls -ld "$1" 2>/dev/null | awk '{print $3}'). A host or privileged operation left it this way; an operator must restore ownership (e.g. chown -R <runtime uid> on it) and restart. This script never chowns on its own."
}

check_runtime_paths_writable() {
  local p first
  for p in "$STATE_DIR" "$LEDGER_FILE"; do
    if [ -e "$p" ] && [ ! -w "$p" ]; then refuse_unwritable "$p"; fi
  done
  [ -d "$TREE/.git" ] || return 0
  for p in refs logs worktrees; do
    [ -e "$TREE/.git/$p" ] || continue
    first="$(find "$TREE/.git/$p" ! -type l 2>/dev/null | while IFS= read -r x; do
      if [ ! -w "$x" ]; then printf '%s\n' "$x"; break; fi
    done || :)"
    [ -n "$first" ] || continue
    if [ "$p" = worktrees ] && [ "$first" != "$TREE/.git/worktrees" ]; then
      log "WARNING: $first is not writable by uid $(id -u) — owner $(ls -ld "$first" 2>/dev/null | awk '{print $3}'); only that worktree is affected, and git worktree prune cannot remove it"
      continue
    fi
    refuse_unwritable "$first"
  done
  return 0
}

check_runtime_paths_writable

# ── CLONE, OR SYNC WHAT IS ALREADY THERE ─────────────────────────────────────────────────────
# W1-T12240: a re-run from the second stage (below) comes straight after its own sync_tree.
if [ "${RMD_SUPERVISE_RESUME:-}" = "1" ]; then
  unset RMD_SUPERVISE_RESUME
  log "second stage re-run: the loop synced the checkout just before it, so no second sync"
elif [ ! -e "$TREE/.git" ]; then
  log "no work tree at $TREE — cloning $REPO_URL"
  mkdir -p "$CONFIG_ROOT"
  git clone "$REPO_URL" "$TREE" || die "clone failed — check GH_TOKEN and RMD_REPO_URL"
  checkout_target
else
  sync_tree
fi

# Print the resolved commit unconditionally — the pin is worthless if "which code ran" cannot be
# answered after the fact. `resolve_rmd_on_path` answers "which tree" right beside it.
log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
resolve_rmd_on_path

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

supervise_daemon=0
if [ "${1:-}" = "./bin/rmd" ] && [ "${2:-}" = "daemon" ]; then supervise_daemon=1; fi
if [ "$RESTART_THROTTLE_S" -eq 0 ] && [ "$supervise_daemon" -eq 0 ]; then
  exec "$@"
fi

# ── W1-T12240: the second stage, the supervise loop, is read from the checkout ────────────────
# The loop changes far more often than this file, and a fix to it used to need an image and a
# recycle. It is sourced, so it sees every function and variable above. The checkout copy runs when
# it is tracked, unmodified and `bash -n` accepts it; otherwise the image copy runs and one
# entrypoint.supervise_fallback row says why. A checkout copy that exits non-zero before it starts
# the daemon once is replaced by the image copy. Why: docs/forensics/entrypoint.md#the-second-stage.
SUPERVISE_REL="deploy/entrypoint-supervise.sh"
SUPERVISE_CHECKOUT_COPY="$TREE/$SUPERVISE_REL"
SUPERVISE_IMAGE_COPY="/usr/local/lib/rmd/entrypoint-supervise.sh"
ENTRYPOINT_SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
# Outside the image (this file run from a checkout) the copy beside this file is the image copy.
if [ -f "${ENTRYPOINT_SELF%/*}/entrypoint-supervise.sh" ]; then
  SUPERVISE_IMAGE_COPY="${ENTRYPOINT_SELF%/*}/entrypoint-supervise.sh"
fi
SUPERVISE_ARGS=("$@")
SUPERVISE_DAEMON_STARTED=0
# The checksum of a checkout copy that already failed before its first start; it is not re-run.
SUPERVISE_REFUSED_SUM="${RMD_SUPERVISE_REFUSED_SUM:-}"
unset RMD_SUPERVISE_REFUSED_SUM

supervise_sum() { if [ -f "$1" ] && [ -r "$1" ]; then sha256sum < "$1" | cut -d' ' -f1; fi; }

# Prints why the checkout copy must not run and returns 0; returns 1 when it may run.
supervise_refusal() {
  local syntax
  if [ ! -f "$SUPERVISE_CHECKOUT_COPY" ]; then echo "the checkout has no $SUPERVISE_REL"; return 0; fi
  if [ ! -r "$SUPERVISE_CHECKOUT_COPY" ]; then echo "$SUPERVISE_REL in the checkout is not readable"; return 0; fi
  if ! git -C "$TREE" ls-files --error-unmatch -- "$SUPERVISE_REL" > /dev/null 2>&1 \
    || ! git -C "$TREE" diff --quiet HEAD -- "$SUPERVISE_REL" 2>/dev/null; then
    echo "$SUPERVISE_REL in the checkout is untracked or has local changes"; return 0
  fi
  if ! syntax="$(bash -n "$SUPERVISE_CHECKOUT_COPY" 2>&1)"; then
    echo "bash -n refused $SUPERVISE_REL in the checkout: $(printf '%s' "$syntax" | head -n 1)"; return 0
  fi
  return 1
}

supervise_fallback() {
  log "second stage: running the image copy $SUPERVISE_IMAGE_COPY, because $1"
  mkdir -p "$STATE_DIR" && printf '{"ts":"%s","run_id":"ENTRYPOINT-%s","task_id":"DAEMON","step":"entrypoint.supervise_fallback","lane":"daemon","checkout_copy":"%s","image_copy":"%s","reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$$" "$(json_escape "$SUPERVISE_CHECKOUT_COPY")" "$(json_escape "$SUPERVISE_IMAGE_COPY")" "$(json_escape "$1")" \
    >> "$LEDGER_FILE" || log "  (the entrypoint.supervise_fallback row could not be written; this log line stands)"
}

# The loop calls this after each sync_tree for a freshness, blocked or environmental restart. A
# changed checkout copy that may run replaces the running one; the counters go in the environment.
supervise_follow_checkout() {
  local next refusal
  next="$(supervise_sum "$SUPERVISE_CHECKOUT_COPY")" || next=""
  if [ -z "$next" ] || [ "$next" = "$SUPERVISE_SUM" ] || [ "$next" = "$SUPERVISE_REFUSED_SUM" ]; then return 0; fi
  if refusal="$(supervise_refusal)"; then
    log "second stage: the checkout copy changed, but $refusal; the running copy stays"
    return 0
  fi
  log "second stage: the checkout copy changed (${SUPERVISE_SUM:0:12} -> ${next:0:12}); re-running with it, counters kept"
  export RMD_SUPERVISE_RESUME=1 RMD_SUPERVISE_FRESHNESS_RESTARTS="$1" RMD_SUPERVISE_BLOCKED_RESTARTS="$2" RMD_SUPERVISE_ENVIRONMENTAL_RESTARTS="$3"
  trap - EXIT
  exec bash "$ENTRYPOINT_SELF" "${SUPERVISE_ARGS[@]}"
}

supervise_on_exit() {
  local rc=$?
  if [ "$rc" -eq 0 ] || [ "$SUPERVISE_DAEMON_STARTED" -ne 0 ] || [ "$SUPERVISE_FILE" != "$SUPERVISE_CHECKOUT_COPY" ]; then return 0; fi
  trap - EXIT
  export RMD_SUPERVISE_RESUME=1 RMD_SUPERVISE_REFUSED_SUM="$SUPERVISE_SUM"
  export RMD_SUPERVISE_REFUSED="the checkout copy exited $rc before it started the daemon"
  exec bash "$ENTRYPOINT_SELF" "${SUPERVISE_ARGS[@]}"
}

SUPERVISE_FILE="$SUPERVISE_CHECKOUT_COPY"
if [ -n "${RMD_SUPERVISE_REFUSED:-}" ]; then
  SUPERVISE_FILE="$SUPERVISE_IMAGE_COPY"
  supervise_fallback "$RMD_SUPERVISE_REFUSED"
  unset RMD_SUPERVISE_REFUSED
elif supervise_reason="$(supervise_refusal)"; then
  SUPERVISE_FILE="$SUPERVISE_IMAGE_COPY"
  supervise_fallback "$supervise_reason"
fi
[ -r "$SUPERVISE_FILE" ] || die "second stage: the image copy $SUPERVISE_IMAGE_COPY is missing or unreadable too — nothing can supervise the daemon"
SUPERVISE_SUM="$(supervise_sum "$SUPERVISE_FILE")"
[ "$SUPERVISE_FILE" != "$SUPERVISE_CHECKOUT_COPY" ] || log "second stage: $SUPERVISE_CHECKOUT_COPY (${SUPERVISE_SUM:0:12})"
trap supervise_on_exit EXIT
# shellcheck source=deploy/entrypoint-supervise.sh
source "$SUPERVISE_FILE" "$@"
