#!/usr/bin/env bash
# rmd-host-cleanup — the Azure host's ROOT-DISK janitor (W1-T4770).
#
# WHY IT EXISTS. `deploy/host-update.sh --reclaim-only` prunes Docker on /mnt/rmd and freed 0 B on /
# for weeks while logging success; root reached 99% and ENOSPC'd a `docker exec`. This script sweeps
# what actually fills /: temp scratch roots, finished agent worktrees under ~/*/.claude/worktrees
# and explicitly configured roots, big idle scratch files, and agent transcripts (ARCHIVED to
# /mnt/rmd, never deleted).

# !! PROVENANCE — READ BEFORE `install-host-units.sh --install` !!
# This file was written from the task record's account of the host's script (W1-T4770 rationale),
# NOT copied byte-for-byte from the host: the host copy was not reachable when this was authored.
# The five safety rules below are implemented as stated there. Every default marked [UNVERIFIED]
# is an assumption that an operator must reconcile with `ssh remudero cat ~/rmd-host-cleanup.sh`
# (diff it against this file) before installing, or the installer will replace the operator's
# chosen values. The installer saves the file it replaces as <path>.pre-t4770 for that reason.

# THE SAFETY RULES (each is pinned by test/host-root-disk-janitor.test.ts)
#   1. idle      — nothing under a path written within IDLE_MINUTES is touched (is_idle); an
#                  incomplete filesystem walk is UNKNOWN and keeps the path
#   2. not open  — no process holds the path (is_open, ONE `lsof -Fn` snapshot per pass)
#   3. worktrees — locked, recent, open, dirty, or unreadable trees are always kept. Linked trees
#                  are removed through Git; standalone scratch clones only at their exact approved
#                  child path. Any unpublished clean HEAD is bundled to a separate archive first.
#                  Unknown ignored data is kept; only node_modules and coverage are disposable.
#                  A scratch unit kept for a repository reason still loses those two trees
#                  (prune_scratch_caches) once it is idle, unheld and unmounted.
#                  Git metadata itself is excluded from recency checks because Git refreshes it.
#   4. archive   — transcripts are moved, never deleted; refused when the archive root shares a
#                  filesystem with /; only the archive itself ages out, after ARCHIVE_DAYS
#   5. DRY_RUN=1 changes nothing; a pass that leaves ANY watched filesystem past its mark exits
#      non-zero, naming each one (W1-T5548, pinned by
#      test/the-host-janitor-alarms-on-every-watched-filesystem.test.ts; `/` used to be the only alarm)

# Every decision is logged: `KEEP <path>: <reason>` / `REMOVE <path>` / `ARCHIVE <path>` /
# `PRUNE <path>: <bytes> bytes, ...` / `REFUSE <what>: <reason>`, then a summary `rmd-host-cleanup: / 57% -> 57% (-4 MB reclaimed this
# pass)` that scripts/fleet-heartbeat.sh-style readers parse. Then one line per watched DEVICE —
# `rmd-host-cleanup: fs <mount> (<device>) <pct>% used, <free> free, mark <pct>%[/<free>]`, or
# `rmd-host-cleanup: fs <path> unknown (df unreadable), mark ...` — and a `rmd-host-cleanup: FAIL
# <mount> is at ...` line for each device past its mark. Neither carries the summary's `->`.

# CRON. The schedule and log path live in ONE place: deploy/install-host-units.sh
# (CLEANUP_CRON_SCHEDULE / RMD_CLEANUP_LOG). Nothing here schedules itself.

# OVERRIDES. Thresholds: IDLE_MINUTES HIGH_WATER ARCHIVE_DAYS DRY_RUN. Roots and probes, so a test
# drives a fixture tree instead of the real /tmp and /mnt/rmd, on Linux or macOS:
#   RMD_CLEANUP_HOME            the home whose ~/*/.claude/{worktrees,projects} are swept
#   RMD_CLEANUP_WORKTREE_ROOTS  colon-separated roots whose immediate Git worktrees are swept
#   RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS  exact checkout paths excluded from those scans
#   RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT  durable location for unpublished clean HEAD bundles
#   RMD_CLEANUP_COVERAGE_PATHS   colon-separated exact regenerable coverage cache paths
#   RMD_CLEANUP_TMP_ROOTS       colon-separated scratch roots
#   RMD_CLEANUP_TMP_GLOBS       space-separated basename globs swept directly under those roots
#   RMD_CLEANUP_BIG_MB          size (MB) at which an idle file under a scratch root is swept
#   RMD_CLEANUP_ARCHIVE_ROOT    where transcripts go
#   RMD_CLEANUP_ROOT_FS         the filesystem being protected (default /)
#   RMD_CLEANUP_DF              command taking a path and printing `df -Pk`-shaped output for the
#                               filesystem holding it (default `df -Pk`)
#   RMD_CLEANUP_WATCH_FS        space-separated `<path>:<pct>[/<min free>]` marks, one per watched
#                               filesystem (<min free> is KB, or N with a K/M/G/T suffix). Default:
#                               `/mnt/rmd:85 /mnt/scratch:90/40G` when RMD_CLEANUP_ROOT_FS is `/`,
#                               otherwise none. RMD_CLEANUP_ROOT_FS:HIGH_WATER is added whenever the
#                               list omits the root. A path that does not exist is skipped; paths
#                               on one device (`df` column 1) are judged once, at the strictest of
#                               each part of their marks. An unreadable df reads `unknown`, which is
#                               neither full nor empty and does not fail the pass.
#   RMD_CLEANUP_FSID            command taking a path and printing its filesystem id
#   RMD_CLEANUP_LSOF            the lsof command (must accept -Fn and print n<path> lines)
#   RMD_CLEANUP_CONTAINER_MAP   host_prefix:container_prefix — a held container-side name also counts
#   RMD_CLEANUP_NO_FETCH=1      do not `git fetch` before judging a worktree saved
#   RMD_CLEANUP_WATCH_ROOTS     roots scanned for WATCH: lines (files >= WATCH_MB, never removed)
#   RMD_CLEANUP_ONLY_TMP=1      run the guarded temporary-root and scratch sweeps
#   RMD_CLEANUP_SCRATCH_ROOTS   colon-separated roots whose immediate scratch units are swept;
#                               setting it is the explicit opt-in for a non-root pass
#   RMD_CLEANUP_SCRATCH_PARENTS colon-separated parents kept while judging each child separately
#   RMD_CLEANUP_ROOT_SCRATCH_ROOTS / RMD_CLEANUP_ROOT_SCRATCH_PARENTS  the defaults of the two
#                               above for a ROOT pass (/mnt/scratch, /mnt/scratch/o). A non-root
#                               pass defaults to NO scratch roots: judging a scratch unit idle
#                               needs root's lsof view of every user's open files.
#   RMD_CLEANUP_UID             the identity the pass decides as (default `id -u`)
#   RMD_CLEANUP_RUNUSER         runs the one repo-writing Git call (fetch) as the repo's owner
#   RMD_CLEANUP_SCRATCH_IDLE_MINUTES  minimum payload inactivity (default 720)
#   RMD_CLEANUP_DOCKER          command for the running-container mount snapshot
#   RMD_CLEANUP_LOCK_FILE       shared whole-pass flock file (default: beside this script, which
#                               both the root and the user cron run, so one path serves both)
#   RMD_CLEANUP_FLOCK           flock command (tests may simulate an unavailable lock)
set -uo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-360}"      # 6 h, as requested by the operator
HIGH_WATER="${HIGH_WATER:-85}"           # [UNVERIFIED] percent of / at which a pass fails
ARCHIVE_DAYS="${ARCHIVE_DAYS:-30}"       # [UNVERIFIED] archive retention
DRY_RUN="${DRY_RUN:-0}"

CLEAN_HOME="${RMD_CLEANUP_HOME:-${HOME:-/}}"
WORKTREE_ROOTS="${RMD_CLEANUP_WORKTREE_ROOTS-/mnt/scratch/worktrees}"  # 2026-10-01 coordinator: $HOME trees are live checkouts (rmd-mint, rmd-op); never swept
PROTECTED_WORKTREE_ROOTS="${RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS-$CLEAN_HOME/rmd-serve-repo}"
WORKTREE_ARCHIVE_ROOT="${RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT:-/mnt/rmd/host-cleanup-worktree-archive}"
COVERAGE_PATHS="${RMD_CLEANUP_COVERAGE_PATHS-$CLEAN_HOME/.remudero-coverage}"
TMP_ROOTS="${RMD_CLEANUP_TMP_ROOTS-/tmp}"                                # [UNVERIFIED]
TMP_GLOBS="${RMD_CLEANUP_TMP_GLOBS-claude-* rmd-* remudero-* tmp.*}"     # [UNVERIFIED]
BIG_MB="${RMD_CLEANUP_BIG_MB:-200}"                                      # [UNVERIFIED]
ARCHIVE_ROOT="${RMD_CLEANUP_ARCHIVE_ROOT:-/mnt/rmd/host-cleanup-archive}" # [UNVERIFIED]
ROOT_FS="${RMD_CLEANUP_ROOT_FS:-/}"
DF_CMD="${RMD_CLEANUP_DF:-df -Pk}"
if [ -n "${RMD_CLEANUP_WATCH_FS+x}" ]; then WATCH_FS="$RMD_CLEANUP_WATCH_FS"
elif [ "$ROOT_FS" = / ]; then WATCH_FS="/mnt/rmd:85 /mnt/scratch:90/40G"  # the Azure host's state + swap disks
else WATCH_FS=""; fi  # a relocated root (a fixture, another layout) does not inherit the host's mounts
FSID_CMD="${RMD_CLEANUP_FSID:-}"
LSOF_CMD="${RMD_CLEANUP_LSOF:-lsof}"
CONTAINER_MAP="${RMD_CLEANUP_CONTAINER_MAP:-}"
WATCH_ROOTS="${RMD_CLEANUP_WATCH_ROOTS-$CLEAN_HOME/.codex $CLEAN_HOME/.claude}"
WATCH_MB="${RMD_CLEANUP_WATCH_MB:-500}"
ONLY_TMP="${RMD_CLEANUP_ONLY_TMP:-0}"
RUN_UID="${RMD_CLEANUP_UID:-$(id -u)}"
if [ "$RUN_UID" = 0 ]; then
  SCRATCH_ROOTS="${RMD_CLEANUP_SCRATCH_ROOTS-${RMD_CLEANUP_ROOT_SCRATCH_ROOTS-/mnt/scratch}}"
  SCRATCH_PARENTS="${RMD_CLEANUP_SCRATCH_PARENTS-${RMD_CLEANUP_ROOT_SCRATCH_PARENTS-/mnt/scratch/o}}"
else
  # A non-root lsof cannot see another user's (or a container's root) open files, so it cannot
  # prove a scratch unit is unheld. Only an explicit RMD_CLEANUP_SCRATCH_ROOTS opts a user pass in.
  SCRATCH_ROOTS="${RMD_CLEANUP_SCRATCH_ROOTS-}"
  SCRATCH_PARENTS="${RMD_CLEANUP_SCRATCH_PARENTS-}"
fi
RUNUSER_CMD="${RMD_CLEANUP_RUNUSER:-runuser}"
SCRATCH_IDLE_MINUTES="${RMD_CLEANUP_SCRATCH_IDLE_MINUTES:-720}"
DOCKER_CMD="${RMD_CLEANUP_DOCKER:-docker}"
# Not /tmp: a root-created 0644 lock there could not be opened for write by the user cron, and
# with fs.protected_regular=2 root cannot O_CREAT-open a user's file in a sticky directory either.
if ! SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"; then
  echo "rmd-host-cleanup: FATAL cannot resolve the script directory for the lock" >&2; exit 2
fi
LOCK_FILE="${RMD_CLEANUP_LOCK_FILE:-$SCRIPT_DIR/rmd-host-cleanup.lock}"
FLOCK_CMD="${RMD_CLEANUP_FLOCK:-flock}"

case "$IDLE_MINUTES$HIGH_WATER$ARCHIVE_DAYS$BIG_MB$SCRATCH_IDLE_MINUTES" in
  ""|*[!0-9]*) echo "rmd-host-cleanup: FATAL thresholds must be non-negative integers" >&2; exit 2 ;;
esac
case "$ONLY_TMP" in
  0|1) ;;
  *) echo "rmd-host-cleanup: FATAL RMD_CLEANUP_ONLY_TMP must be 0 or 1" >&2; exit 2 ;;
esac

# The watch list, parsed once and refused whole before the lock: a typo must not silently unwatch a
# disk. W_* are parallel arrays (bash 3.2 on macOS has no associative arrays).
W_PATH=(); W_PCT=(); W_FREE_KB=(); W_FREE_TXT=(); root_watched=0
for entry in $WATCH_FS; do
  w_path="${entry%:*}"; w_mark="${entry##*:}"; w_pct="${w_mark%%/*}"; w_free=""
  case "$w_mark" in */*) w_free="${w_mark#*/}" ;; esac
  case "$entry" in *:*) ;; *) w_path="" ;; esac
  case "$w_pct" in ""|*[!0-9]*) w_path="" ;; esac
  case "$w_free" in "") ;; *[!0-9KMGT]*|[KMGT]*|*[KMGT]?*) w_path="" ;; esac
  if [ -z "$w_path" ] || [ "${w_pct:-0}" -gt 100 ] 2>/dev/null; then
    echo "rmd-host-cleanup: FATAL RMD_CLEANUP_WATCH_FS entry '$entry' is not <path>:<pct>[/<min free>]" >&2; exit 2
  fi
  w_kb="${w_free%[KMGT]}"; w_kb=$(( 10#${w_kb:-0} )); w_pct=$(( 10#$w_pct ))
  case "$w_free" in
    *M) w_kb=$(( w_kb * 1024 )) ;; *G) w_kb=$(( w_kb * 1048576 )) ;; *T) w_kb=$(( w_kb * 1073741824 )) ;;
  esac
  [ "$w_path" = "$ROOT_FS" ] && root_watched=1
  W_PATH+=("$w_path"); W_PCT+=("$w_pct"); W_FREE_KB+=("$w_kb"); W_FREE_TXT+=("$w_free")
done
if [ "$root_watched" = 0 ]; then
  # ${a[@]+...}: bash before 4.4 calls an empty array unbound under `set -u`
  W_PATH=("$ROOT_FS" ${W_PATH[@]+"${W_PATH[@]}"}); W_PCT=("$HIGH_WATER" ${W_PCT[@]+"${W_PCT[@]}"})
  W_FREE_KB=(0 ${W_FREE_KB[@]+"${W_FREE_KB[@]}"}); W_FREE_TXT=("" ${W_FREE_TXT[@]+"${W_FREE_TXT[@]}"})
fi

log() { printf '%s\n' "$*"; }

# The lock is created once (O_EXCL, so never through a symlink) and then opened READ-ONLY: flock
# needs no write access, so whichever identity created it, any mode the other can read works, and
# an open without O_CREAT is outside fs.protected_regular entirely.
( set -C; umask 022; : > "$LOCK_FILE" ) 2>/dev/null
if [ -L "$LOCK_FILE" ] || ! exec 9<"$LOCK_FILE"; then
  log "REFUSE: cannot acquire janitor lock $LOCK_FILE"; exit 2
fi
$FLOCK_CMD -n -E 73 9
lock_status=$?
case "$lock_status" in
  0) ;;
  73) log "KEEP pass: another janitor pass holds the lock"; exit 0 ;;
  *) log "REFUSE: cannot acquire janitor lock $LOCK_FILE"; exit 2 ;;
esac

# Every mutation goes through here, so DRY_RUN=1 has exactly one place to hold.
act() {
  if [ "$DRY_RUN" = 1 ]; then log "DRYRUN would: $*"; return 0; fi
  "$@"
}

# root_pct / root_avail_kb from one df snapshot.
df_field() { $DF_CMD "$ROOT_FS" 2>/dev/null | awk -v f="$1" 'NR==2 { gsub("%","",$5); print (f=="pct" ? $5 : $4) }'; }

# ── rule 1 ──
is_idle() {
  local recent
  [ -e "$1" ] || return 1
  if ! recent="$(find "$1" -mmin "-$IDLE_MINUTES" -print -quit 2>/dev/null)"; then
    return 2 # incomplete activity walk is UNKNOWN; callers must keep
  fi
  [ -z "$recent" ]
}

# Git refreshes .git/index during status/fetch; that administrative write is not user activity.
# The tree must still have no recent payload writes anywhere outside its .git metadata.
is_worktree_idle() {
  local recent
  [ -e "$1" ] || return 1
  if ! recent="$(find "$1" -name .git -prune -o -mmin "-$IDLE_MINUTES" -print -quit 2>/dev/null)"; then
    return 2
  fi
  [ -z "$recent" ]
}

# ── rule 2 ── ONE snapshot; a held path, or anything under it, is open.
OPEN_SNAPSHOT=""
OPEN_OK=1
snapshot_open() {
  local out
  if ! out="$($LSOF_CMD -Fn 2>/dev/null)" && [ -z "$out" ]; then
    # An lsof that failed and printed nothing tells us NOTHING; treating that as "nothing is open"
    # is the failure this rule exists to prevent. Fail closed: keep everything.
    OPEN_OK=0
    return
  fi
  OPEN_SNAPSHOT="$(printf '%s\n' "$out" | sed -n 's/^n//p')"
}
is_open() {
  local p="$1" alt="" hp cp
  [ "$OPEN_OK" = 1 ] || return 0
  if [ -n "$CONTAINER_MAP" ]; then
    hp="${CONTAINER_MAP%%:*}"; cp="${CONTAINER_MAP#*:}"
    case "$p" in "$hp"*) alt="$cp${p#"$hp"}" ;; esac
  fi
  printf '%s\n' "$OPEN_SNAPSHOT" | awk -v p="$p" -v a="$alt" '
    $0 == p || index($0, p "/") == 1 { found = 1 }
    a != "" && ($0 == a || index($0, a "/") == 1) { found = 1 }
    END { exit found ? 0 : 1 }'
}
is_protected_worktree() {
  local target="$1" protected
  while IFS= read -r protected; do
    [ -n "$protected" ] && [ "$target" = "$protected" ] && return 0
  done < <(printf '%s\n' "$PROTECTED_WORKTREE_ROOTS" | tr ':' '\n')
  return 1
}

# One decision per path: keep-with-reason, or remove.
sweep_path() {
  local p="$1" idle_status
  is_idle "$p"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $p: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $p: activity probe failed (unknown)"; return ;;
  esac
  if is_open "$p"; then log "KEEP $p: held open by a process"; return; fi
  log "REMOVE $p"
  act rm -rf -- "$p"
}

# ── rule 3 ──
# Every Git call against a swept repository. The root pass reads repos the operator owns, and Git
# refuses those ("detected dubious ownership") unless safe.directory names them; it is scoped to
# THIS repo's physical top (what Git compares against), never '*'. These calls only read the repo
# (status runs with GIT_OPTIONAL_LOCKS=0) or remove it, so root creates no files inside it.
rgit() {
  local repo="$1" top
  shift
  top="$(cd -P -- "$repo" 2>/dev/null && pwd -P)" || return 128
  git -c safe.directory="$top" -C "$repo" "$@"
}
# The one call that WRITES into a repo is fetch (objects, refs, FETCH_HEAD). Run as root it would
# leave root-owned files in the operator's .git that break their next fetch, so a root pass runs it
# as the repo's owner, whose Git needs no exception.
repo_fetch() {
  local repo="$1" uid owner
  shift
  uid="$(stat -c %u -- "$repo" 2>/dev/null || stat -f %u -- "$repo" 2>/dev/null)" || return 1
  if [ "$RUN_UID" != 0 ] || [ "$uid" = "$RUN_UID" ]; then rgit "$repo" fetch "$@"; return; fi
  owner="$(stat -c %U -- "$repo" 2>/dev/null || stat -f %Su -- "$repo" 2>/dev/null)" || return 1
  case "$owner" in ""|*[!A-Za-z0-9._-]*) return 1 ;; esac
  (cd -- "$repo" && $RUNUSER_CMD -u "$owner" -- git -C "$repo" fetch "$@")
}
worktree_clean() {
  local status
  status="$(GIT_OPTIONAL_LOCKS=0 rgit "$1" status --porcelain 2>/dev/null)" || return 2
  [ -z "$status" ]
}
worktree_ignored_safe() {
  local status unknown
  status="$(GIT_OPTIONAL_LOCKS=0 rgit "$1" status --porcelain --ignored=matching 2>/dev/null)" || return 2
  unknown="$(printf '%s\n' "$status" | awk '
    substr($0, 1, 2) == "!!" {
      path=substr($0, 4); sub(/\/$/, "", path)
      if (path != "node_modules" && path != "coverage") print path
    }
  ')" || return 2
  [ -z "$unknown" ]
}
worktree_saved() {
  local wt="$1" head br id
  head="$(rgit "$wt" rev-parse HEAD 2>/dev/null)" || return 1
  [ -n "$(rgit "$wt" branch -r --contains "$head" 2>/dev/null)" ] && return 0
  br="$(rgit "$wt" symbolic-ref --short -q HEAD 2>/dev/null)" || return 1
  case "$br" in
    run-*-[0-9]*)
      id="${br#run-}"; id="${id%-*}"
      case "$id" in ""|*[!A-Za-z0-9._-]*) return 1 ;; esac
      rgit "$wt" log origin/main --fixed-strings --grep="Remudero-Task: $id" -n 1 --format=%H 2>/dev/null | grep -q . && return 0
      ;;
  esac
  return 1
}
archive_worktree_head() {
  local wt="$1" head="$2" archive="$WORKTREE_ARCHIVE_ROOT" name bundle tmp probe archive_fsid root_fsid
  local mode="${3:-head}" refs="$head HEAD" tag="" source="$ROOT_FS"
  if [ "$mode" = branches ]; then
    refs="$(rgit "$wt" for-each-ref --format='%(objectname) %(refname)' refs/heads)" || return 1
    refs="$(printf '%s\n%s\n' "$head HEAD" "$refs")"
    tag="-$(printf '%s\n' "$refs" | cksum | awk '{print $1}')"
    source="$wt"
  fi
  case "$archive" in "$wt"|"$wt"/*) return 1 ;; esac
  name="$(basename "$wt" | tr -c 'A-Za-z0-9._-' '-')"
  name="${name%-}"
  bundle="$archive/${name}-${head}${tag}.bundle"
  if [ "$mode" = branches ]; then
    probe="$archive"
    while [ ! -e "$probe" ] && [ "$probe" != / ]; do probe="$(dirname "$probe")"; done
    archive_fsid="$(fs_id "$probe")"; root_fsid="$(fs_id "$source")"
    [ -n "$archive_fsid" ] && [ -n "$root_fsid" ] && [ "$archive_fsid" != "$root_fsid" ] || return 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    log "ARCHIVE-WORKTREE $wt HEAD=$head -> $bundle"
    return 0
  fi
  mkdir -p "$archive" || return 1
  [ -d "$archive" ] && [ ! -L "$archive" ] || return 1
  if [ -e "$bundle" ]; then
    verify_worktree_bundle "$wt" "$bundle" "$refs" || return 1
    log "ARCHIVE-WORKTREE existing verified bundle $bundle"
    return 0
  fi
  probe="$archive"
  while [ ! -e "$probe" ] && [ "$probe" != "/" ] && [ "$probe" != "." ]; do probe="$(dirname "$probe")"; done
  archive_fsid="$(fs_id "$probe")"
  root_fsid="$(fs_id "$source")"
  [ -n "$archive_fsid" ] && [ -n "$root_fsid" ] && [ "$archive_fsid" != "$root_fsid" ] || return 1
  tmp="${bundle}.tmp.$$"
  [ ! -e "$tmp" ] || return 1
  local -a bundle_refs=(HEAD)
  [ "$mode" = branches ] && bundle_refs+=(--branches)
  if ! rgit "$wt" bundle create "$tmp" "${bundle_refs[@]}" >/dev/null 2>&1 || \
     ! verify_worktree_bundle "$wt" "$tmp" "$refs"; then
    rm -f -- "$tmp"
    return 1
  fi
  if ! mv -- "$tmp" "$bundle"; then
    rm -f -- "$tmp"
    return 1
  fi
  log "ARCHIVE-WORKTREE $wt HEAD=$head -> $bundle"
}
verify_worktree_bundle() {
  local wt="$1" bundle="$2" refs="$3" heads ref
  rgit "$wt" bundle verify "$bundle" >/dev/null 2>&1 || return 1
  heads="$(rgit "$wt" bundle list-heads "$bundle" 2>/dev/null)" || return 1
  while IFS= read -r ref; do
    [ -z "$ref" ] || printf '%s\n' "$heads" | grep -Fxq -- "$ref" || return 1
  done <<< "$refs"
}
sweep_worktree() {
  local wt="$1" gitdir idle_status kind head
  [ -d "$wt" ] && [ ! -L "$wt" ] || { log "KEEP $wt: not a regular directory"; return; }
  if [ -d "$wt/.git" ] && [ ! -L "$wt/.git" ]; then kind="standalone clone"
  elif [ -f "$wt/.git" ] && [ ! -L "$wt/.git" ]; then kind="linked worktree"
  else log "KEEP $wt: Git metadata is missing or has an unexpected type"; return
  fi
  if ! gitdir="$(rgit "$wt" rev-parse --absolute-git-dir 2>/dev/null)" || [ ! -d "$gitdir" ]; then
    log "KEEP $wt: Git metadata is unreadable or missing"; return
  fi
  if [ -f "$gitdir/locked" ]; then log "KEEP $wt: Git worktree is locked"; return; fi
  is_worktree_idle "$wt"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $wt: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $wt: activity probe failed (unknown)"; return ;;
  esac
  if is_open "$wt"; then log "KEEP $wt: held open by a process"; return; fi
  worktree_clean "$wt"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $wt: uncommitted changes"; return ;;
    *) log "KEEP $wt: Git status failed (unknown)"; return ;;
  esac
  worktree_ignored_safe "$wt"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $wt: ignored data includes paths beyond node_modules/coverage"; return ;;
    *) log "KEEP $wt: ignored-data scan failed (unknown)"; return ;;
  esac
  if [ "$DRY_RUN" != 1 ] && [ "${RMD_CLEANUP_NO_FETCH:-0}" != 1 ]; then
    repo_fetch "$wt" --quiet origin 2>/dev/null || true
  fi
  head="$(rgit "$wt" rev-parse HEAD 2>/dev/null)" || { log "KEEP $wt: HEAD is unreadable"; return; }
  if ! worktree_saved "$wt" && ! archive_worktree_head "$wt" "$head"; then
    log "KEEP $wt: unpublished HEAD could not be archived safely"; return
  fi
  log "REMOVE $wt ($kind)"
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$kind" = "standalone clone" ]; then log "DRYRUN would: rm -rf -- $wt"
    else log "DRYRUN would: git worktree remove $wt"; fi
    return
  fi
  if [ "$kind" = "standalone clone" ]; then
    if ! rm -rf -- "$wt"; then log "KEEP $wt: standalone clone removal failed"; fi
  elif ! rgit "$wt" worktree remove -- "$wt" 2>/dev/null; then
    log "KEEP $wt: git worktree remove failed; no recursive filesystem fallback"
  fi
}

# ── rule 4 ──
fs_id() {
  if [ -n "$FSID_CMD" ]; then $FSID_CMD "$1"
  else stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null; fi
}

DOCKER_OK=1
DOCKER_MOUNTS=""
snapshot_docker() {
  local ids id mounts
  if ! ids="$($DOCKER_CMD ps -q 2>/dev/null)"; then DOCKER_OK=0; return; fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! mounts="$($DOCKER_CMD inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$id" 2>/dev/null)"; then
      DOCKER_OK=0; return
    fi
    DOCKER_MOUNTS="$(printf '%s\n%s' "$DOCKER_MOUNTS" "$mounts")"
  done <<< "$ids"
}
is_docker_mount() {
  local p="$1" mount
  while IFS= read -r mount; do
    [ -n "$mount" ] || continue
    case "$mount" in "$p"|"$p"/*) return 0 ;; esac
    case "$p" in "$mount"|"${mount%/}"/*) return 0 ;; esac
  done <<< "$DOCKER_MOUNTS"
  return 1
}
# A parent directly under a scratch root is met twice (as a unit, then as a parent): log it once.
PARENTS_LOGGED=":"
keep_parent() {
  case "$PARENTS_LOGGED" in *":$1:"*) return ;; esac
  PARENTS_LOGGED="$PARENTS_LOGGED$1:"
  log "KEEP $1: workspace parent root"
}
scratch_guard() {
  local p="$1" protected parent
  case "${p##*/}" in
    swapfile|lost+found|rmd|worktrees|tmp|npm-cache|node-compile-cache|node-v*-linux-x64*|tsx-*|.remudero-coverage|state)
      log "KEEP $p: protected scratch name"; return 1 ;;
  esac
  if [ -L "$p" ]; then log "KEEP $p: symbolic link"; return 1; fi
  if [ -e "$p/.rmd-scratch-keep" ] || [ -L "$p/.rmd-scratch-keep" ]; then
    log "KEEP $p: scratch keep marker"; return 1
  fi
  while IFS= read -r parent; do
    [ -n "$parent" ] || continue
    parent="${parent%/}"
    case "$parent" in "$p"|"$p"/*) keep_parent "$p"; return 1 ;; esac
  done < <(printf '%s\n' "$SCRATCH_PARENTS" | tr ':' '\n')
  if is_protected_worktree "$p"; then log "KEEP $p: protected by janitor configuration"; return 1; fi
  while IFS= read -r protected; do
    [ -n "$protected" ] || continue
    case "$protected" in "$p"/*) log "KEEP $p: protected by janitor configuration"; return 1 ;; esac
    case "$p" in "$protected"/*) log "KEEP $p: protected by janitor configuration"; return 1 ;; esac
  done < <(printf '%s\n' "$PROTECTED_WORKTREE_ROOTS" | tr ':' '\n')
  return 0
}
scratch_repo_check() {
  local repo="$1" gitdir raw parent status
  if [ -L "$repo/.git" ]; then SCRATCH_REASON="Git metadata has an unexpected type"; return 1; fi
  if ! gitdir="$(rgit "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || [ ! -d "$gitdir" ]; then
    if [ -f "$repo/.git" ]; then
      raw="$(sed -n 's/^gitdir: //p' "$repo/.git")"
      case "$raw" in /*) ;; *) raw="$repo/$raw" ;; esac
      case "$raw" in
        */.git/worktrees/*)
          parent="${raw%/.git/worktrees/*}"
          if [ ! -e "$raw" ] && [ ! -e "$parent" ]; then return 0; fi ;;
      esac
    fi
    SCRATCH_REASON="Git metadata is unreadable or missing"; return 1
  fi
  if [ -f "$gitdir/locked" ]; then SCRATCH_REASON="Git worktree is locked"; return 1; fi
  worktree_clean "$repo"; status=$?
  if [ "$status" != 0 ]; then
    if [ "$status" = 1 ]; then SCRATCH_REASON="uncommitted changes"
    else SCRATCH_REASON="Git status failed (unknown)"; fi
    return 1
  fi
  worktree_ignored_safe "$repo"; status=$?
  if [ "$status" != 0 ]; then
    SCRATCH_REASON="ignored data includes paths beyond node_modules/coverage, or scan failed"; return 1
  fi
  SCRATCH_LIVE_REPOS+=("$repo")
}
scratch_repo_saved() {
  local repo="$1" refs head
  worktree_saved "$repo" || return 1
  refs="$(rgit "$repo" for-each-ref --format='%(objectname)' refs/heads)" || return 1
  while IFS= read -r head; do
    [ -n "$head" ] || continue
    [ -n "$(rgit "$repo" branch -r --contains "$head" 2>/dev/null)" ] || return 1
  done <<< "$refs"
}
archive_scratch_bundle() {
  local f="$1" archive="$WORKTREE_ARCHIVE_ROOT/scratch" probe dest a b digest
  case "$archive" in "$f"|"$f"/*) return 1 ;; esac
  probe="$archive"
  while [ ! -e "$probe" ] && [ "$probe" != / ]; do probe="$(dirname "$probe")"; done
  a="$(fs_id "$probe")"; b="$(fs_id "$f")"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ] || return 1
  digest="$(cksum < "$f")" || return 1
  digest="${digest%% *}"
  dest="$archive/${f##*/}-$digest.bundle"
  log "ARCHIVE $f -> $dest"
  [ "$DRY_RUN" = 1 ] && return 0
  act mkdir -p -- "$archive" || return 1
  [ ! -L "$archive" ] || return 1
  if [ -e "$dest" ]; then cmp -s -- "$f" "$dest" || return 1
  else
    act cp -p -- "$f" "$dest" || return 1
    cmp -s -- "$f" "$dest" || return 1
  fi
  act rm -f -- "$f"
}
# W1-T5547. A unit kept for a REPOSITORY reason (dirty, an ignored path beyond the disposable two,
# unreadable metadata, an unsaved branch or bundle with nowhere safe to go) has already passed the
# idle, lsof and docker-mount checks, so its regenerable trees go even though the unit stays: each
# repository's top-level node_modules/ and coverage/, by exact name, never through a symlink, only
# while Git confirms the tree is ignored and tracks nothing in it, and never one holding a *.bundle
# or a nested .git (the bundle rescue above reads coverage/). A locked worktree is an explicit hold.
PRUNED_COUNT=0
PRUNED_BYTES=0
keep_scratch_for_repo() {
  local p="$1" reason="$2" entries="$3" entry repo name tree found tracked bytes
  log "KEEP $p: $reason"
  case "$reason" in "Git worktree is locked"*) return ;; esac
  while IFS= read -r entry; do
    case "$entry" in */.git) repo="${entry%/.git}" ;; *) continue ;; esac
    case "${repo#"$p"}/" in */node_modules/*|*/coverage/*) continue ;; esac
    [ -d "$repo" ] && [ ! -L "$repo" ] && [ ! -L "$entry" ] || continue
    for name in node_modules coverage; do
      tree="$repo/$name"
      [ -e "$tree" ] || [ -L "$tree" ] || continue
      if [ -L "$tree" ] || [ ! -d "$tree" ]; then log "KEEP $tree: not a regular directory"; continue; fi
      if ! rgit "$repo" check-ignore -q -- "$name" 2>/dev/null || \
         ! tracked="$(rgit "$repo" ls-files -- "$name" 2>/dev/null)" || [ -n "$tracked" ]; then
        log "KEEP $tree: Git does not confirm it is ignored and untracked"; continue
      fi
      if ! found="$(find "$tree" \( -name .git -o -name '*.bundle' \) -print -quit 2>/dev/null)"; then
        log "KEEP $tree: content scan failed (unknown)"; continue
      fi
      if [ -n "$found" ]; then log "KEEP $tree: holds a bundle or repository ($found)"; continue; fi
      bytes="$(du -sk -- "$tree" 2>/dev/null | awk '{print $1 * 1024}')"
      log "PRUNE $tree: ${bytes:-unknown} bytes, unit kept for $reason"
      if act rm -rf -- "$tree"; then
        PRUNED_COUNT=$((PRUNED_COUNT + 1)); PRUNED_BYTES=$((PRUNED_BYTES + ${bytes:-0}))
      fi
    done
  done <<< "$entries"
}
sweep_scratch_unit() {
  local p="$1" status entries entry repo head bundles bytes
  local IDLE_MINUTES="$SCRATCH_IDLE_MINUTES" SCRATCH_REASON=""
  local -a SCRATCH_LIVE_REPOS=()
  scratch_guard "$p" || return
  is_worktree_idle "$p"; status=$?
  case "$status" in
    0) ;;
    1) log "KEEP $p: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $p: activity probe failed (unknown)"; return ;;
  esac
  if is_open "$p"; then log "KEEP $p: held open by a process"; return; fi
  if [ "$DOCKER_OK" != 1 ]; then log "KEEP $p: docker probe failed (unknown)"; return; fi
  if is_docker_mount "$p"; then log "KEEP $p: running container mount"; return; fi
  if ! entries="$(find "$p" -maxdepth 4 -name .git -prune -print 2>/dev/null)"; then
    log "KEEP $p: repository scan failed (unknown)"; return
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in */.git) repo="${entry%/.git}" ;; *) log "KEEP $p: unreadable repository path"; return ;; esac
    if ! scratch_repo_check "$repo"; then keep_scratch_for_repo "$p" "$SCRATCH_REASON ($repo)" "$entries"; return; fi
  done <<< "$entries"
  # Validate the whole unit before archiving or removing any of its repositories (W1-T5513).
  for repo in "${SCRATCH_LIVE_REPOS[@]}"; do
    if [ "$DRY_RUN" != 1 ] && [ "${RMD_CLEANUP_NO_FETCH:-0}" != 1 ]; then
      if ! repo_fetch "$repo" --quiet --all 2>/dev/null; then
        keep_scratch_for_repo "$p" "Git fetch failed (unknown)" "$entries"; return
      fi
    fi
    head="$(rgit "$repo" rev-parse HEAD 2>/dev/null)" || { keep_scratch_for_repo "$p" "HEAD is unreadable" "$entries"; return; }
    if ! scratch_repo_saved "$repo"; then
      if ! WORKTREE_ARCHIVE_ROOT="$WORKTREE_ARCHIVE_ROOT/scratch" archive_worktree_head "$repo" "$head" branches; then
        keep_scratch_for_repo "$p" "local branches could not be archived safely" "$entries"; return
      fi
    fi
  done
  if ! bundles="$(find "$p" -name .git -prune -o -type f -name '*.bundle' -print 2>/dev/null)"; then
    log "KEEP $p: bundle scan failed (unknown)"; return
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if ! archive_scratch_bundle "$entry"; then keep_scratch_for_repo "$p" "bundle could not be archived safely" "$entries"; return; fi
  done <<< "$bundles"
  for repo in "${SCRATCH_LIVE_REPOS[@]}"; do
    if [ -f "$repo/.git" ]; then
      log "REMOVE $repo (linked worktree)"
      if ! act rgit "$repo" worktree remove -- "$repo"; then
        log "KEEP $p: git worktree remove failed; no recursive filesystem fallback"; return
      fi
    fi
  done
  bytes="$(du -sk -- "$p" 2>/dev/null | awk '{print $1 * 1024}')"
  log "REMOVE $p"
  [ "$DRY_RUN" = 1 ] && log "DRYRUN would reclaim ${bytes:-unknown} bytes from $p"
  act rm -rf -- "$p"
}
sweep_scratch_root() {
  local root="$1" unit
  root="${root%/}"
  [ -d "$root" ] && [ ! -L "$root" ] || return
  for unit in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [ -e "$unit" ] || [ -L "$unit" ] || continue
    sweep_scratch_unit "$unit"
  done
}
ARCHIVE_OK=0
check_archive_root() {
  local a b probe="$ARCHIVE_ROOT"
  # The archive root may not exist yet: judge the nearest existing ancestor.
  while [ ! -e "$probe" ] && [ "$probe" != "/" ] && [ "$probe" != "." ]; do probe="$(dirname "$probe")"; done
  a="$(fs_id "$probe")"; b="$(fs_id "$ROOT_FS")"
  if [ -z "$a" ] || [ -z "$b" ]; then
    log "REFUSE archive: cannot determine filesystem of $ARCHIVE_ROOT or $ROOT_FS"; return
  fi
  if [ "$a" = "$b" ]; then
    log "REFUSE archive: $ARCHIVE_ROOT is on the same filesystem as $ROOT_FS — moving there frees nothing"; return
  fi
  ARCHIVE_OK=1
}
archive_transcript() {
  local f="$1" rel dest idle_status
  is_idle "$f"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $f: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $f: activity probe failed (unknown)"; return ;;
  esac
  if is_open "$f"; then log "KEEP $f: held open by a process"; return; fi
  rel="${f#"$CLEAN_HOME"/}"; dest="$ARCHIVE_ROOT/$rel"
  log "ARCHIVE $f -> $dest"
  if [ "$DRY_RUN" = 1 ]; then log "DRYRUN would: move $f to $dest"; return; fi
  mkdir -p "$(dirname "$dest")" && cp -p -- "$f" "$dest" && rm -f -- "$f"
}

fmt_kb() { if [ "$1" -ge 1048576 ]; then printf '%sG' "$(( $1 / 1048576 ))"; else printf '%sM' "$(( $1 / 1024 ))"; fi; }
mark_text() { printf '%s%%' "$1"; [ -z "$2" ] || printf '/%s' "$2"; }

# One line per watched device, then a FAIL line for each device at or above its percent or below
# its minimum free space. Paths sharing a device merge into one entry holding the strictest of each
# part (lowest percent, largest minimum free). Sets FS_FAILED.
judge_filesystems() {
  local i j n=0 row dev avail pct mount fails=""
  local D_DEV=() D_MOUNT=() D_PCT=() D_AVAIL=() D_MPCT=() D_MKB=() D_MTXT=()
  FS_FAILED=0
  for i in "${!W_PATH[@]}"; do
    [ -e "${W_PATH[$i]}" ] || continue
    row="$($DF_CMD "${W_PATH[$i]}" 2>/dev/null | awk 'NR==2 { gsub("%","",$5); print $1, $5, $4, $6 }')"
    read -r dev pct avail mount <<<"$row"
    case "${pct:-x}${avail:-x}" in *[!0-9]*)
      log "rmd-host-cleanup: fs ${W_PATH[$i]} unknown (df unreadable), mark $(mark_text "${W_PCT[$i]}" "${W_FREE_TXT[$i]}")"
      continue ;;
    esac
    for (( j = 0; j < n; j++ )); do [ "${D_DEV[$j]}" = "$dev" ] && break; done
    if [ "$j" = "$n" ]; then
      D_DEV[n]="$dev"; D_MOUNT[n]="${mount:-${W_PATH[$i]}}"; D_PCT[n]="$pct"; D_AVAIL[n]="$avail"
      D_MPCT[n]="${W_PCT[$i]}"; D_MKB[n]="${W_FREE_KB[$i]}"; D_MTXT[n]="${W_FREE_TXT[$i]}"; n=$(( n + 1 ))
    else
      [ "${W_PCT[$i]}" -lt "${D_MPCT[$j]}" ] && D_MPCT[j]="${W_PCT[$i]}"
      if [ "${W_FREE_KB[$i]}" -gt "${D_MKB[$j]}" ]; then D_MKB[j]="${W_FREE_KB[$i]}"; D_MTXT[j]="${W_FREE_TXT[$i]}"; fi
    fi
  done
  for (( j = 0; j < n; j++ )); do
    log "rmd-host-cleanup: fs ${D_MOUNT[$j]} (${D_DEV[$j]}) ${D_PCT[$j]}% used, $(fmt_kb "${D_AVAIL[$j]}") free, mark $(mark_text "${D_MPCT[$j]}" "${D_MTXT[$j]}")"
    if [ "${D_PCT[$j]}" -ge "${D_MPCT[$j]}" ] || [ "${D_AVAIL[$j]}" -lt "${D_MKB[$j]}" ]; then
      fails="${fails}rmd-host-cleanup: FAIL ${D_MOUNT[$j]} is at ${D_PCT[$j]}% with $(fmt_kb "${D_AVAIL[$j]}") free (${D_DEV[$j]}), past its mark $(mark_text "${D_MPCT[$j]}" "${D_MTXT[$j]}")
"
      FS_FAILED=1
    fi
  done
  [ -z "$fails" ] || printf '%s' "$fails"
}

# ── the pass ──
before_pct="$(df_field pct)"; before_avail="$(df_field avail)"
before_pct="${before_pct:-0}"; before_avail="${before_avail:-0}"
snapshot_open
[ "$OPEN_OK" = 1 ] || log "REFUSE sweeps: lsof failed — keeping everything (fail closed)"

if [ -n "$SCRATCH_ROOTS$SCRATCH_PARENTS" ]; then snapshot_docker; fi
while IFS= read -r root; do
  [ -n "$root" ] && sweep_scratch_root "$root"
done < <(printf '%s\n' "$SCRATCH_ROOTS" | tr ':' '\n')
while IFS= read -r parent; do
  [ -n "$parent" ] && [ -d "$parent" ] || continue
  parent="${parent%/}"
  keep_parent "$parent"
  if [ -e "$parent/.rmd-scratch-keep" ] || [ -L "$parent" ]; then
    log "KEEP $parent: scratch keep marker or symbolic link"; continue
  fi
  sweep_scratch_root "$parent"
done < <(printf '%s\n' "$SCRATCH_PARENTS" | tr ':' '\n')

for root in $(printf '%s' "$TMP_ROOTS" | tr ':' ' '); do
  [ -d "$root" ] || continue
  for g in $TMP_GLOBS; do
    for p in "$root"/$g; do [ -e "$p" ] && sweep_path "$p"; done
  done
  # big idle scratch files that sit inside a root rather than directly under it
  find "$root" -maxdepth 3 -type f -size "+${BIG_MB}M" 2>/dev/null | while IFS= read -r f; do
    [ -e "$f" ] && sweep_path "$f"
  done
done

while IFS= read -r coverage; do
  [ -n "$coverage" ] && [ -e "$coverage" ] && sweep_path "$coverage"
done < <(printf '%s\n' "$COVERAGE_PATHS" | tr ':' '\n')

if [ "$ONLY_TMP" != 1 ]; then
  for wt in "$CLEAN_HOME"/*/.claude/worktrees/*; do
    [ -d "$wt" ] || continue
    if is_protected_worktree "$wt"; then log "KEEP $wt: protected by janitor configuration"
    else sweep_worktree "$wt"; fi
  done

  while IFS= read -r root; do
    [ -n "$root" ] && [ -d "$root" ] || continue
    for wt in "$root"/*; do
      [ -d "$wt" ] || continue
      if is_protected_worktree "$wt"; then log "KEEP $wt: protected by janitor configuration"
      else sweep_worktree "$wt"; fi
    done
  done < <(printf '%s\n' "$WORKTREE_ROOTS" | tr ':' '\n')

  check_archive_root
  if [ "$ARCHIVE_OK" = 1 ]; then
    for f in "$CLEAN_HOME"/*/.claude/projects/*/*.jsonl; do
      [ -f "$f" ] && archive_transcript "$f"
    done
    if [ -d "$ARCHIVE_ROOT" ]; then
      find "$ARCHIVE_ROOT" -type f -mtime "+$ARCHIVE_DAYS" 2>/dev/null | while IFS= read -r old; do
        log "REMOVE $old: archive older than ${ARCHIVE_DAYS} days"
        act rm -f -- "$old"
      done
    fi
  fi

  for wr in $WATCH_ROOTS; do
    [ -d "$wr" ] || continue
    find "$wr" -maxdepth 3 -type f -size "+${WATCH_MB}M" 2>/dev/null | while IFS= read -r f; do
      log "WATCH: $f is over ${WATCH_MB} MB"
    done
  done
else
  log "rmd-host-cleanup: temporary-roots-only mode"
fi

if [ "$PRUNED_COUNT" -gt 0 ]; then
  log "rmd-host-cleanup: pruned $PRUNED_COUNT regenerable trees from kept scratch units ($PRUNED_BYTES bytes)"
fi
after_pct="$(df_field pct)"; after_avail="$(df_field avail)"
after_pct="${after_pct:-0}"; after_avail="${after_avail:-0}"
log "rmd-host-cleanup: / ${before_pct}% -> ${after_pct}% ($(( (after_avail - before_avail) / 1024 )) MB reclaimed this pass)"
[ "$DRY_RUN" = 1 ] && log "rmd-host-cleanup: DRY_RUN=1 — nothing was changed"

judge_filesystems
[ "$FS_FAILED" = 0 ] || exit 1
exit 0
