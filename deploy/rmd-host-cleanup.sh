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
#   2. not open  — no process holds the path (is_open, refreshed before workspace removal)
#   3. worktrees — locked, recent, open, dirty, or unreadable trees are always kept. Linked trees
#                  are removed through Git; standalone scratch clones only at their exact approved
#                  child path. Unpublished or unverifiable work stays IN PLACE, even when an
#                  archive could be made. Fresh remote refs, not task trailers, prove publication.
#                  Unknown ignored data is kept; only node_modules and coverage are disposable.
#                  Dirty/ignored-only holds may lose regenerable caches after all safety checks;
#                  unpublished, locked, lending and unreadable repositories keep their caches too.
#                  Git metadata itself is excluded from recency checks because Git refreshes it.
#                  tsx's transpile cache (`tsx-*` directly under a tmp root) is a protected UNIT —
#                  the directory itself is never removed — but its stale FILES are (prune_tsx_cache).
#   4. archive   — transcripts are moved, never deleted; refused when the archive root shares a
#                  filesystem with /; only the archive itself ages out, after ARCHIVE_DAYS; archived
#                  and preserved copies of unpublished work after RETAIN_DAYS (ruling 2026-10-23)
#   5. DRY_RUN=1 (or RMD_CLEANUP_DRY_RUN=1) writes nothing anywhere; a pass that leaves ANY watched filesystem past its mark exits
#      non-zero, naming each one (W1-T5548, pinned by
#      test/the-host-janitor-alarms-on-every-watched-filesystem.test.ts; `/` used to be the only alarm)

# The 2026-10-23 phases (deploy/mac/JANITOR.md) log `reclaim-total <phase> <root>`; the root pass runs retention only.

# Every decision is logged: `KEEP <path>: <reason>` / `REMOVE <path>` / `ARCHIVE <path>` /
# `PRUNE <path>: <bytes> bytes, ...` / `REFUSE <what>: <reason>`, then a summary `rmd-host-cleanup: / 57% -> 57% (-4 MB reclaimed this
# pass)` that scripts/fleet-heartbeat.sh-style readers parse. Then one line per watched DEVICE —
# `rmd-host-cleanup: fs <mount> (<device>) <pct>% used, <free> free, mark <pct>%[/<free>]`, or
# `rmd-host-cleanup: fs <path> unknown (df unreadable), mark ...` — and a `rmd-host-cleanup: FAIL
# <mount> is at ...` line for each device past its mark. Neither carries the summary's `->`.

# CRON. The schedule and log path live in ONE place: deploy/install-host-units.sh
# (CLEANUP_CRON_SCHEDULE / RMD_CLEANUP_LOG). Nothing here schedules itself.

# RETENTION is six hours at every disk pressure tier (W1-T8863), as on the Mac. Scratch-unit
# idleness and the tsx cache follow that window unless pinned longer. Pins under six hours are
# logged as CLAMP and raised to six hours; watched filesystem alarms still use their own marks.

# OVERRIDES. Thresholds: IDLE_MINUTES (pins the idle window; empty = six hours)
# HIGH_WATER ARCHIVE_DAYS DRY_RUN. Roots and probes, so a test
# drives a fixture tree instead of the real /tmp and /mnt/rmd, on Linux or macOS:
#   RMD_CLEANUP_HOME            the home whose ~/*/.claude/{worktrees,projects} are swept
#   RMD_CLEANUP_WORKTREE_ROOTS  colon-separated roots whose immediate Git worktrees are swept
#   RMD_CLEANUP_LIVE_CHECKOUTS  live checkouts kept while judging only untracked immediate clones
#   RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS  exact checkout paths excluded from those scans
#                               (plus each ${RMD_SCRATCH_ROOT:-/mnt/scratch}/rmd/*/remudero|serve-repo, W1-T9617)
#   RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT  durable location for unpublished clean HEAD bundles
#   RMD_CLEANUP_COVERAGE_PATHS   colon-separated exact regenerable coverage cache paths
#   RMD_CLEANUP_TMP_ROOTS       colon-separated scratch roots
#   RMD_CLEANUP_TMP_GLOBS       space-separated basename globs swept directly under those roots
#   RMD_CLEANUP_BIG_MB          size (MB) at which an idle file under a scratch root is swept
#   RMD_CLEANUP_TSX_MAX_AGE_HOURS  pins the age (h; under 6 is clamped to 6) past which a file
#                               inside a `tsx-*` cache directly under a tmp root is pruned
#                               (default: the idle window)
#   RMD_CLEANUP_ARCHIVE_ROOT    where transcripts go (default <state disk>/host/archive)
#   RMD_CLEANUP_STATE_DISK, RMD_SCRATCH_ROOT  the data disks (/mnt/rmd, /mnt/scratch); setting the first selects the host layout
#   RMD_CLEANUP_{RETAIN_DAYS,RETAIN_ROOTS,PRESERVE_ROOTS,PRESERVE_ROOT,MAX_UNTRACKED_MB,PUBLISHED_REMOTES,DUMP_ROOTS,
#     DUMP_RESUMABLE_ROOTS,DUMP_MIN_MB,DUMP_RETAIN_DAYS}  the 2026-10-23 phases; their defaults are set below
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
#   RMD_CLEANUP_NO_FETCH       legacy no-op: publication never fetches objects
#   RMD_CLEANUP_WATCH_ROOTS     roots scanned for WATCH: lines (files >= WATCH_MB, never removed)
#   RMD_CLEANUP_ONLY_TMP=1      run the guarded temporary-root and scratch sweeps
#   RMD_CLEANUP_SCRATCH_ROOTS   colon-separated roots whose immediate scratch units are swept;
#                               setting it is the explicit opt-in for a non-root pass
#   RMD_CLEANUP_SCRATCH_PARENTS colon-separated parents kept while judging each child separately
#   RMD_CLEANUP_ROOT_SCRATCH_ROOTS / RMD_CLEANUP_ROOT_SCRATCH_PARENTS  the defaults of the two
#                               above for a ROOT pass (/mnt/scratch, /mnt/scratch/o). A non-root
#                               pass defaults to NO scratch roots: judging a scratch unit idle
#                               needs root's lsof view of every user's open files.
#   RMD_CLEANUP_STATE_PARENTS   colon-separated STATE-DISK parents (W1-T5707): scratch parents whose
#                               top level also holds live state. Default /mnt/rmd on a root `/`
#                               pass, otherwise none. A child on STATE_DENY, a symlink, a mount
#                               point, or one holding a configured janitor path is kept and logged;
#                               any other child goes through the scratch-unit guards and archive.
#                               A parent sharing a filesystem with RMD_CLEANUP_ROOT_FS (the disk is
#                               not mounted) is not swept at all.
#   RMD_CLEANUP_UID             the identity the pass decides as (default `id -u`)
#   RMD_CLEANUP_SCRATCH_IDLE_MINUTES  pins scratch-unit payload inactivity (default: the idle
#                               window; under 360 is clamped to 360)
#   RMD_CLEANUP_NESTED_COVERAGE_ROOTS  colon-separated roots walked (depth <= 6, same device, no
#                               symlinks) for `rmd-c-<12 hex>` coverage scratch at ANY depth
#                               (W1-T5708). Default: the tmp roots, scratch roots and parents, plus
#                               /mnt/rmd on a `/` pass. Reaped when idle and no lock holds it.
#   RMD_CLEANUP_COVERAGE_LOCK_DIR  where `rmd-c-<hash>.lock` lives (default /tmp)
#   RMD_CLEANUP_DOCKER          command for the running-container mount snapshot
#   RMD_CLEANUP_LOCK_FILE       shared whole-pass flock file (default: beside this script, which
#                               both the root and the user cron run, so one path serves both)
#   RMD_CLEANUP_FLOCK           flock command (tests may simulate an unavailable lock)
set -uo pipefail
SEED_GUARD_DIR=$(cd "$(dirname -- "${BASH_SOURCE[0]:-}")" && pwd)
if [ -f "$SEED_GUARD_DIR/dependency-seed-guard.sh" ]; then
  # shellcheck source=deploy/dependency-seed-guard.sh
  source "$SEED_GUARD_DIR/dependency-seed-guard.sh"
else
  rmd_dependency_seed_risk() { echo 'dependency seed guard unavailable'; return 0; }
fi
if [ -f "$SEED_GUARD_DIR/workspace-retirement-guard.sh" ]; then
  # shellcheck source=deploy/workspace-retirement-guard.sh
  source "$SEED_GUARD_DIR/workspace-retirement-guard.sh"
else
  echo 'rmd-host-cleanup: REFUSE workspace retirement guard unavailable' >&2; exit 2
fi

FLOOR_MINUTES=360                        # 6 h: the protective floor for anything that could be live work
IDLE_MINUTES="${IDLE_MINUTES:-}"         # empty: six hours (retention_window)
HIGH_WATER="${HIGH_WATER:-85}"           # [UNVERIFIED] percent of / at which a pass fails
ARCHIVE_DAYS="${ARCHIVE_DAYS:-30}"       # [UNVERIFIED] transcript archive retention
DRY_RUN_RAW="${DRY_RUN:-0}"; DRY_RUN_ALIAS="${RMD_CLEANUP_DRY_RUN:-0}"
DRY_RUN=0
if [ "$DRY_RUN_RAW" = 1 ] || [ "$DRY_RUN_ALIAS" = 1 ]; then DRY_RUN=1; fi

CLEAN_HOME="${RMD_CLEANUP_HOME:-${HOME:-/}}"
STATE_DISK="${RMD_CLEANUP_STATE_DISK:-/mnt/rmd}"
SCRATCH_DISK="${RMD_SCRATCH_ROOT:-/mnt/scratch}"
WORKTREE_ROOTS="${RMD_CLEANUP_WORKTREE_ROOTS-/mnt/scratch/worktrees}"  # 2026-10-01 coordinator: $HOME trees are live checkouts (rmd-mint, rmd-op); never swept
LIVE_CHECKOUTS="${RMD_CLEANUP_LIVE_CHECKOUTS-$CLEAN_HOME/rmd-mint:$CLEAN_HOME/rmd-op}"
PROTECTED_WORKTREE_ROOTS="${RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS-$CLEAN_HOME/rmd-serve-repo}"
# W1-T9617: with the hot checkouts on scratch (deploy/scratch-mounts.sh), each daemon's own checkout
# and serve's code dir live at <scratch>/rmd/<key>/remudero and .../serve-repo. They are live
# checkouts, so each one present is protected exactly like rmd-serve-repo, whatever the list says.
for scratch_checkout in "${RMD_SCRATCH_ROOT:-/mnt/scratch}"/rmd/*/remudero "${RMD_SCRATCH_ROOT:-/mnt/scratch}"/rmd/*/serve-repo; do
  [ -d "$scratch_checkout" ] && [ ! -L "$scratch_checkout" ] || continue
  PROTECTED_WORKTREE_ROOTS="${PROTECTED_WORKTREE_ROOTS:+$PROTECTED_WORKTREE_ROOTS:}$scratch_checkout"
done
WORKTREE_ARCHIVE_ROOT="${RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT:-$STATE_DISK/host-cleanup-worktree-archive}"
COVERAGE_PATHS="${RMD_CLEANUP_COVERAGE_PATHS-$CLEAN_HOME/.remudero-coverage}"
TMP_ROOTS="${RMD_CLEANUP_TMP_ROOTS-/tmp}"                                # [UNVERIFIED]
TMP_GLOBS="${RMD_CLEANUP_TMP_GLOBS-claude-* rmd-* remudero-* tmp.*}"     # [UNVERIFIED]
BIG_MB="${RMD_CLEANUP_BIG_MB:-200}"                                      # [UNVERIFIED]
TSX_MAX_AGE_HOURS="${RMD_CLEANUP_TSX_MAX_AGE_HOURS:-}"  # empty: the idle window
ARCHIVE_ROOT="${RMD_CLEANUP_ARCHIVE_ROOT:-$STATE_DISK/host/archive}"
ROOT_FS="${RMD_CLEANUP_ROOT_FS:-/}"
DF_CMD="${RMD_CLEANUP_DF:-df -Pk}"
if [ -n "${RMD_CLEANUP_WATCH_FS+x}" ]; then WATCH_FS="$RMD_CLEANUP_WATCH_FS"
elif [ "$ROOT_FS" = / ]; then WATCH_FS="/mnt/rmd:85 /mnt/scratch:90/40G"  # the Azure host's state + swap disks
else WATCH_FS=""; fi  # a relocated root (a fixture, another layout) does not inherit the host's mounts
FSID_CMD="${RMD_CLEANUP_FSID:-}"
# Elevate only system lsof; account views can hide root readers behind exit-zero Permission denied.
if [ -n "${RMD_CLEANUP_LSOF:-}" ]; then LSOF_CMD="$RMD_CLEANUP_LSOF"
elif [ "$(id -u)" = 0 ]; then LSOF_CMD=lsof
else LSOF_CMD="sudo -n -- /usr/bin/lsof"; fi
FIND_CMD="${RMD_CLEANUP_FIND:-find}"
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
# The state disk's top level is judged child by child; these names are never reaped (W1-T5707).
STATE_DENY="agent-claude agent-codex archive containerd docker host host-cleanup-archive \
host-cleanup-worktree-archive lost+found remudero-console-state remudero-site-state site-state state2 tmp"
if [ -n "${RMD_CLEANUP_STATE_PARENTS+x}" ]; then STATE_PARENTS="$RMD_CLEANUP_STATE_PARENTS"
elif [ "$RUN_UID" = 0 ] && [ "$ROOT_FS" = / ]; then STATE_PARENTS=/mnt/rmd
else STATE_PARENTS=""; fi  # a fixture root or a blind (non-root lsof) pass never inherits the host disk
if [ -n "${RMD_CLEANUP_NESTED_COVERAGE_ROOTS+x}" ]; then NESTED_COVERAGE_ROOTS="$RMD_CLEANUP_NESTED_COVERAGE_ROOTS"
else
  NESTED_COVERAGE_ROOTS="$TMP_ROOTS:$SCRATCH_ROOTS:$SCRATCH_PARENTS"
  [ "$ROOT_FS" = / ] && NESTED_COVERAGE_ROOTS="$NESTED_COVERAGE_ROOTS:/mnt/rmd"
fi
COVERAGE_LOCK_DIR="${RMD_CLEANUP_COVERAGE_LOCK_DIR:-/tmp}"
SCRATCH_IDLE_MINUTES="${RMD_CLEANUP_SCRATCH_IDLE_MINUTES:-}"  # empty: the idle window
DOCKER_CMD="${RMD_CLEANUP_DOCKER:-docker}"

# ── 2026-10-23 phases. Host defaults apply only on the host layout: a fixture never inherits the disks.
RETAIN_DAYS="${RMD_CLEANUP_RETAIN_DAYS:-7}"
PRESERVE_ROOT="${RMD_CLEANUP_PRESERVE_ROOT:-$SCRATCH_DISK/host-cleanup-preserved}"
MAX_UNTRACKED_MB="${RMD_CLEANUP_MAX_UNTRACKED_MB:-50}"
DUMP_MIN_MB="${RMD_CLEANUP_DUMP_MIN_MB:-5}"
DUMP_RETAIN_DAYS="${RMD_CLEANUP_DUMP_RETAIN_DAYS:-14}"
PUBLISHED_REMOTES="${RMD_CLEANUP_PUBLISHED_REMOTES-https://github.com/craigoley/ git@github.com:craigoley/ ssh://git@github.com/craigoley/}"
HOST_LAYOUT=0
if [ "$ROOT_FS" = / ] || [ -n "${RMD_CLEANUP_STATE_DISK+x}" ]; then HOST_LAYOUT=1; fi
if [ -n "${RMD_CLEANUP_RETAIN_ROOTS+x}" ]; then RETAIN_ROOTS="$RMD_CLEANUP_RETAIN_ROOTS"
elif [ "$HOST_LAYOUT" = 1 ]; then RETAIN_ROOTS="$WORKTREE_ARCHIVE_ROOT:$STATE_DISK/archive:$STATE_DISK/host-cleanup-archive"
else RETAIN_ROOTS=""; fi
if [ -n "${RMD_CLEANUP_PRESERVE_ROOTS+x}" ]; then PRESERVE_ROOTS="$RMD_CLEANUP_PRESERVE_ROOTS"
elif [ "$HOST_LAYOUT" = 1 ]; then
  PRESERVE_ROOTS="$WORKTREE_ROOTS:$SCRATCH_DISK:$SCRATCH_DISK/o:$SCRATCH_DISK/tmp:$SCRATCH_DISK/rmd-work-tmp:$STATE_DISK/tmp:$CLEAN_HOME/rmd-state2/tmp:$TMP_ROOTS"
else PRESERVE_ROOTS=""; fi
DUMP_ROOTS="${RMD_CLEANUP_DUMP_ROOTS-$PRESERVE_ROOTS}"
# Operator ruling 2026-10-23 (an active session's namespace with recorded holds): see ruling_retire.
if [ -n "${RMD_CLEANUP_RULING_NAMESPACES+x}" ]; then RULING_NAMESPACES="$RMD_CLEANUP_RULING_NAMESPACES"
elif [ "$HOST_LAYOUT" = 1 ]; then RULING_NAMESPACES="$SCRATCH_DISK/rmd-qa-namespace.ulkfFP"
else RULING_NAMESPACES=""; fi
if [ -n "${RMD_CLEANUP_DUMP_RESUMABLE_ROOTS+x}" ]; then DUMP_RESUMABLE_ROOTS="$RMD_CLEANUP_DUMP_RESUMABLE_ROOTS"
elif [ "$HOST_LAYOUT" = 1 ]; then DUMP_RESUMABLE_ROOTS="$STATE_DISK/agent-codex/sessions"  # Codex may resume these
else DUMP_RESUMABLE_ROOTS=""; fi
# Not /tmp: a root-created 0644 lock there could not be opened for write by the user cron, and
# with fs.protected_regular=2 root cannot O_CREAT-open a user's file in a sticky directory either.
if ! SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]:-}")" && pwd -P)"; then
  echo "rmd-host-cleanup: FATAL cannot resolve the script directory for the lock" >&2; exit 2
fi
LOCK_FILE="${RMD_CLEANUP_LOCK_FILE:-$SCRIPT_DIR/rmd-host-cleanup.lock}"
FLOCK_CMD="${RMD_CLEANUP_FLOCK:-flock}"

case "$HIGH_WATER$ARCHIVE_DAYS$BIG_MB$MAX_UNTRACKED_MB$DUMP_MIN_MB" in
  ""|*[!0-9]*) echo "rmd-host-cleanup: FATAL thresholds must be non-negative integers" >&2; exit 2 ;;
esac
case "$DRY_RUN_RAW:$DRY_RUN_ALIAS" in
  [01]:[01]) ;;
  *) echo "rmd-host-cleanup: FATAL DRY_RUN and RMD_CLEANUP_DRY_RUN must each be 0 or 1" >&2; exit 2 ;;
esac
for retain in "$RETAIN_DAYS" "$DUMP_RETAIN_DAYS"; do
  case "$retain" in
    ""|*[!0-9]*|0|0*) echo "rmd-host-cleanup: FATAL retention days must be positive integers" >&2; exit 2 ;;
  esac
done
# A pinned window must be a number (a typo is refused, not guessed at); how SMALL it is is not
# refused here, it is clamped to the floor below.
case "$IDLE_MINUTES$SCRATCH_IDLE_MINUTES" in
  *[!0-9]*) echo "rmd-host-cleanup: FATAL thresholds must be non-negative integers" >&2; exit 2 ;;
esac
case "$TSX_MAX_AGE_HOURS" in
  "") ;;
  *[!0-9]*|0|0*) echo "rmd-host-cleanup: FATAL RMD_CLEANUP_TSX_MAX_AGE_HOURS must be a positive integer" >&2; exit 2 ;;
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
  case "$w_pct" in ""|*[!0-9]*|????*) w_path="" ;; esac
  case "$w_free" in "") ;; *[!0-9KMGT]*|[KMGT]*|*[KMGT]?*) w_path="" ;; esac
  w_kb="${w_free%[KMGT]}"
  case "$w_kb" in ????????????????*) w_path="" ;; esac
  if [ -z "$w_path" ] || [ "${w_pct:-0}" -gt 100 ] 2>/dev/null; then
    echo "rmd-host-cleanup: FATAL RMD_CLEANUP_WATCH_FS entry '$entry' is not <path>:<pct>[/<min free>]" >&2; exit 2
  fi
  w_kb=$(( 10#${w_kb:-0} )); w_pct=$(( 10#$w_pct ))
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

# The durable audit log (W1-T8861): every REMOVE / ARCHIVE / PRUNE decision is appended here whatever
# stdout is redirected to, so a pass run outside the cron's redirect still leaves a trace. One line:
# ISO time, uid, DRY_RUN, pid, then the decision as logged (action, path, reason).
AUDIT_LOG="${RMD_CLEANUP_AUDIT_LOG:-$CLEAN_HOME/.local/state/remudero/janitor-audit.log}"
DECISION_LOG="${RMD_CLEANUP_DECISION_LOG:-$CLEAN_HOME/.local/state/remudero/janitor-decisions.tsv}"
# A dry run writes nothing anywhere: no receipt, no audit line, no lock file (operator 2026-10-23).
if [ "$DRY_RUN" = 1 ]; then DECISION_LOG=/dev/null
else mkdir -p "$(dirname "$DECISION_LOG")" && : >> "$DECISION_LOG" || exit 2; fi
audit_writable() {
  mkdir -p -- "$(dirname -- "$AUDIT_LOG")" 2>/dev/null && : >> "$AUDIT_LOG" 2>/dev/null
}
audit_append() {
  [ "$DRY_RUN" != 1 ] || return 0
  printf '%s uid=%s dry_run=%s pid=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_UID" "$DRY_RUN" "$$" "$*" \
    >> "$AUDIT_LOG" 2>/dev/null
}
log() {
  rmd_decision_record "$DECISION_LOG" "$*" || { echo 'REFUSE decision log unwritable' >&2; exit 2; }
  printf '%s\n' "$*"
  case "$*" in
    "REMOVE "*|"ARCHIVE "*|"ARCHIVE-WORKTREE "*|"PRUNE "*|"PRESERVE "*) audit_append "$*" || true ;;
  esac
}

# retention_window <points below the mark> — six hours regardless of disk pressure (W1-T8863).
retention_window() {
  echo "$FLOOR_MINUTES"
}
fmt_minutes() { if [ $(( $1 % 60 )) = 0 ]; then printf '%s h' "$(( $1 / 60 ))"; else printf '%s min' "$1"; fi; }

TALLY_KEYS=(); TALLY_BYTES=(); TALLY_COUNT=(); TALLY_N=0
du_bytes() { du -sk -- "$1" 2>/dev/null | awk 'NR == 1 { print $1 * 1024 }'; }
tally() {
  local key="$1" bytes="${2:-0}" i=0
  case "$bytes" in ""|*[!0-9]*) bytes=0 ;; esac
  while [ "$i" -lt "$TALLY_N" ]; do
    if [ "${TALLY_KEYS[$i]}" = "$key" ]; then
      TALLY_BYTES[i]=$(( TALLY_BYTES[i] + bytes )); TALLY_COUNT[i]=$(( TALLY_COUNT[i] + 1 )); return
    fi
    i=$(( i + 1 ))
  done
  TALLY_KEYS[TALLY_N]="$key"; TALLY_BYTES[TALLY_N]="$bytes"; TALLY_COUNT[TALLY_N]=1; TALLY_N=$(( TALLY_N + 1 ))
}
print_tallies() {
  local i=0 verb="reclaimed"
  [ "$DRY_RUN" = 1 ] && verb="would reclaim"
  [ "$TALLY_N" -gt 0 ] || { log "rmd-host-cleanup: reclaim-total: nothing to reclaim in any root this pass"; return; }
  while [ "$i" -lt "$TALLY_N" ]; do
    log "rmd-host-cleanup: reclaim-total ${TALLY_KEYS[$i]}: $verb $(( TALLY_BYTES[i] / 1048576 )) MB (${TALLY_BYTES[$i]} bytes) in ${TALLY_COUNT[$i]} entries"
    i=$(( i + 1 ))
  done
}

# The lock is created once (O_EXCL, so never through a symlink) and then opened READ-ONLY: flock
# needs no write access, so whichever identity created it, any mode the other can read works, and
# an open without O_CREAT is outside fs.protected_regular entirely.
[ "$DRY_RUN" = 1 ] || ( set -C; umask 022; : > "$LOCK_FILE" ) 2>/dev/null
if [ "$DRY_RUN" = 1 ] && [ ! -e "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ]; then
  log "rmd-host-cleanup: dry run without the pass lock ($LOCK_FILE is absent and a dry run creates nothing)"
else
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
fi

# Every mutation goes through here, so DRY_RUN=1 has exactly one place to hold.
act() {
  if [ "$DRY_RUN" = 1 ]; then log "DRYRUN would: $*"; return 0; fi
  # A destructive step with no audit trail is refused, not done silently (W1-T8861).
  case "$1" in
    rm) audit_writable || { log "KEEP $*: audit log unwritable ($AUDIT_LOG)"; return 1; } ;;
  esac
  "$@"
}

# root_pct / root_avail_kb from one df snapshot.
df_field() { $DF_CMD "$ROOT_FS" 2>/dev/null | awk -v f="$1" 'NR==2 { gsub("%","",$5); print (f=="pct" ? $5 : $4) }'; }

# ── rule 1 ──
is_idle() {
  local recent
  [ -e "$1" ] || return 1
  if ! recent="$($FIND_CMD "$1" \( -mmin "-$IDLE_MINUTES" -o -cmin "-$IDLE_MINUTES" \) -print -quit 2>/dev/null)"; then
    return 2 # incomplete activity walk is UNKNOWN; callers must keep
  fi
  [ -z "$recent" ]
}

# Git refreshes .git/index during status/fetch; that administrative write is not user activity.
# The tree must still have no recent payload writes anywhere outside its .git metadata.
is_worktree_idle() {
  local recent
  [ -e "$1" ] || return 1
  if ! recent="$($FIND_CMD "$1" -name .git -prune -o \( -mmin "-$IDLE_MINUTES" -o -cmin "-$IDLE_MINUTES" \) -print -quit 2>/dev/null)"; then
    return 2
  fi
  [ -z "$recent" ]
}

# ── rule 2 ── ONE snapshot; a held path, or anything under it, is open.
OPEN_SNAPSHOT=""
PROCESS_SNAPSHOT=""
OPEN_OK=1
OPEN_FAILURE="lsof failed"
snapshot_open() {
  local out
  OPEN_OK=1; OPEN_FAILURE="lsof failed"
  PROCESS_SNAPSHOT=$(ps -axww -o command= 2>/dev/null) || {
    OPEN_OK=0; OPEN_FAILURE="process snapshot failed"; return
  }
  if ! out="$($LSOF_CMD -Fn 2>/dev/null)"; then
    OPEN_OK=0
    return
  fi
  case "$out" in
    *"Permission denied"*)
      OPEN_OK=0; OPEN_FAILURE="lsof returned incomplete visibility (Permission denied)"; return ;;
  esac
  OPEN_SNAPSHOT="$(printf '%s\n' "$out" | sed -n 's/^n//p')"
}
is_open() {
  local p="$1" alt="" hp cp
  [ "$OPEN_OK" = 1 ] || return 0
  case "$PROCESS_SNAPSHOT" in *"$p"*) return 0 ;; esac
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
  done < <(printf '%s\n%s\n' "$PROTECTED_WORKTREE_ROOTS" "$LIVE_CHECKOUTS" | tr ':' '\n' | sed 's:/*$::')
  return 1
}

# One decision per path: keep-with-reason, or remove.
sweep_path() {
  local p="$1" idle_status seed_reason entries bytes
  keep_container_path "$p" && return
  # Generic temp globs must not bypass Git safety for a checkout or a unit
  # containing one. Incomplete walks are not permission to remove a tree.
  if [ -d "$p" ] && [ ! -L "$p" ]; then
    bare_repository_scan "$p"; idle_status=$?
    case "$idle_status" in
      1) log "KEEP $p: bare repository; Git history retained"; return ;;
      2) log "KEEP $p: repository scan failed (unknown)"; return ;;
    esac
    entries=$(find "$p" \( -name node_modules -o -name .git \) -prune -a -name .git -print 2>/dev/null) || {
      log "KEEP $p: repository scan failed (unknown)"; return;
    }
    if [ -n "$entries" ]; then sweep_scratch_unit "$p"; return; fi
  fi
  is_idle "$p"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $p: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $p: activity probe failed (unknown)"; return ;;
  esac
  if seed_reason=$(rmd_dependency_seed_risk "$p"); then log "KEEP $p: $seed_reason"; return; fi
  if is_open "$p"; then log "KEEP $p: held open by a process"; return; fi
  bytes="$(du_bytes "$p")"
  log "REMOVE $p"
  act rm -rf -- "$p" && tally "sweep ${p%/*}" "$bytes"
}

bare_repository_scan() {
  local root="$1" heads entry parent
  heads=$(find "$root" \( -name .git -o -name node_modules \) -prune -o -type f -name HEAD -print 2>/dev/null) || return 2
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    parent=${entry%/HEAD}
    if [ -d "$parent/objects" ] && [ -d "$parent/refs" ]; then return 1; fi
  done <<< "$heads"
}

# ── rule 3 ──
# Every Git call against a swept repository. The root pass reads repos the operator owns, and Git
# refuses those ("detected dubious ownership") unless safe.directory names them; it is scoped to
# THIS repo's physical top (what Git compares against), never '*'. These calls only read the repo
# (status runs with GIT_OPTIONAL_LOCKS=0) or remove it, so root creates no files inside it.
rgit() {
  rmd_retirement_git "$@"
}
worktree_clean() {
  local status
  status="$(GIT_OPTIONAL_LOCKS=0 rgit "$1" status --porcelain 2>/dev/null)" || return 2
  [ -z "$status" ]
}
git_head_idle() {
  local repo="$1" head_file
  head_file=$(rgit "$repo" rev-parse --path-format=absolute --git-path HEAD 2>/dev/null) || return 2
  is_idle "$head_file"
}
worktree_ignored_safe() {
  local status unknown tree found
  status="$(GIT_OPTIONAL_LOCKS=0 rgit "$1" status --porcelain --ignored=matching 2>/dev/null)" || return 2
  unknown="$(printf '%s\n' "$status" | awk '
    substr($0, 1, 2) == "!!" {
      path=substr($0, 4); sub(/\/$/, "", path)
      if (path != "node_modules" && path != "coverage") print path
    }
  ')" || return 2
  [ -z "$unknown" ] || return 1
  for tree in "$1/node_modules" "$1/coverage"; do
    [ -d "$tree" ] && [ ! -L "$tree" ] || continue
    found=$(find "$tree" -name .git -print -quit 2>/dev/null) || return 2
    [ -z "$found" ] || return 1
  done
}
worktree_saved() {
  rmd_workspace_published "$1" head "${2:-0}"
}
# Every ref of a clone outside refs/remotes, as "<object> <refname>" lines (heads, tags, stash, ...).
local_refs() {
  local out
  out="$(rgit "$1" for-each-ref --format='%(objectname) %(refname)')" || return 1
  printf '%s\n' "$out" | awk 'NF && $2 !~ /^refs\/remotes\//'
}
# A clone's non-remote refs that no remote-tracking branch contains: one refname per line. Returns
# non-zero when the refs cannot be read at all (unknown reads as unsaved).
clone_unsaved_refs() {
  local wt="$1" refs obj name
  refs="$(local_refs "$wt")" || return 1
  while read -r obj name; do
    [ -n "$obj" ] || continue
    rmd_commit_published "$wt" "$obj" || printf '%s\n' "$name"
  done <<< "$refs"
}
# The first live linked worktree whose git dir is this clone's: its `gitdir` file names the
# worktree's .git file, and the directory holding it still exists.
clone_live_worktree() {
  local gitdir="$1" entry target
  for entry in "$gitdir"/worktrees/*/; do
    [ -d "$entry" ] || continue
    if [ ! -r "${entry}gitdir" ]; then printf '%s\n' "${entry%/} (gitdir unreadable)"; return 0; fi
    target="$(head -n 1 -- "${entry}gitdir" 2>/dev/null)"
    [ -n "$target" ] || { printf '%s\n' "${entry%/} (gitdir empty)"; return 0; }
    # Missing linked worktrees can still own unpublished detached HEAD/reflog
    # history. Do not discard their metadata by removing the lender clone.
    printf '%s\n' "$(dirname -- "$target")"; return 0
  done
  return 1
}
sweep_worktree() {
  local wt="$1" gitdir idle_status kind head hosted unsaved orphaned=0 seed_reason bytes
  if seed_reason=$(rmd_dependency_seed_risk "$wt"); then log "KEEP $wt: $seed_reason"; return; fi
  [ -d "$wt" ] && [ ! -L "$wt" ] || { log "KEEP $wt: not a regular directory"; return; }
  if [ -d "$wt/.git" ] && [ ! -L "$wt/.git" ]; then kind="standalone clone"
  elif [ -f "$wt/.git" ] && [ ! -L "$wt/.git" ]; then kind="linked worktree"
  else log "KEEP $wt: Git metadata is missing or has an unexpected type"; return
  fi
  if ! gitdir="$(rgit "$wt" rev-parse --absolute-git-dir 2>/dev/null)" || [ ! -d "$gitdir" ]; then
    if [ "$kind" = "linked worktree" ]; then orphaned=1
    else log "KEEP $wt: Git metadata is unreadable or missing"; return; fi
  fi
  if [ "$orphaned" = 0 ] && [ -f "$gitdir/locked" ]; then log "KEEP $wt: Git worktree is locked"; return; fi
  if [ "$orphaned" = 0 ] && ! git_head_idle "$wt"; then log "KEEP $wt: recent or unverified Git HEAD activity"; return; fi
  is_worktree_idle "$wt"; idle_status=$?
  case "$idle_status" in
    0) ;;
    1) log "KEEP $wt: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $wt: activity probe failed (unknown)"; return ;;
  esac
  if is_open "$wt"; then log "KEEP $wt: held open by a process"; return; fi
  if [ "$DOCKER_OK" != 1 ]; then log "KEEP $wt: Docker mount snapshot failed (unknown)"; return; fi
  if is_docker_mount "$wt"; then log "KEEP $wt: Docker mount ($DOCKER_PATH_REASON)"; return; fi
  if [ "$orphaned" = 1 ]; then
    log "KEEP $wt: Git metadata is unreadable or missing; cannot prove published work"
    return
  fi
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
  head="$(rgit "$wt" rev-parse HEAD 2>/dev/null)" || { log "KEEP $wt: HEAD is unreadable"; return; }
  if ! worktree_saved "$wt"; then log "KEEP $wt: $RMD_PUB_REASON HEAD=$head"; return; fi
  if [ "$kind" = "standalone clone" ]; then
    if ! rmd_remote_outside_retirement "$wt" "$wt"; then log "KEEP $wt: remote publication lender is inside removal unit or unverified"; return; fi
    # A clone is the git dir of every linked worktree built on it, and holds every local ref: judging
    # it by HEAD alone deleted a clone hosting 33 worktrees (W1-T8861).
    if hosted="$(clone_live_worktree "$gitdir")"; then
      log "KEEP $wt: hosts linked worktree $hosted"; return
    fi
    if ! unsaved="$(clone_unsaved_refs "$wt")"; then
      log "KEEP $wt: refs are unreadable (unknown)"; return
    fi
    if [ -n "$unsaved" ]; then
      log "KEEP $wt: not-proven-published refs (${unsaved//$'\n'/ })"; return
    fi
    if ! lender_check "$wt"; then log "KEEP $wt: $SCRATCH_REASON"; return; fi
  fi
  if [ "$DRY_RUN" != 1 ]; then
    snapshot_open; snapshot_docker
    if ! is_worktree_idle "$wt" || is_open "$wt" || [ "$DOCKER_OK" != 1 ] || is_docker_mount "$wt" ||
       ! worktree_clean "$wt" || ! worktree_ignored_safe "$wt" || ! git_head_idle "$wt" ||
       [ "$(rgit "$wt" rev-parse HEAD 2>/dev/null)" != "$head" ] || ! worktree_saved "$wt" 1; then
      log "KEEP $wt: changed, active or not-proven-published before remove"; return
    fi
    if [ -f "$gitdir/locked" ]; then log "KEEP $wt: Git worktree is locked"; return; fi
    if [ "$kind" = "standalone clone" ]; then
      if clone_live_worktree "$gitdir" >/dev/null || ! rmd_workspace_published "$wt" all || ! lender_check "$wt"; then
        log "KEEP $wt: refs, linked worktree or lender changed before remove"; return
      fi
    fi
  fi
  if [ "$DRY_RUN" != 1 ] && ! audit_writable; then log "KEEP $wt: audit log unwritable ($AUDIT_LOG)"; return; fi
  bytes="$(du_bytes "$wt")"
  log "REMOVE $wt ($kind)"
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$kind" = "standalone clone" ]; then log "DRYRUN would: rm -rf -- $wt"
    else log "DRYRUN would: git worktree remove $wt"; fi
    tally "sweep ${wt%/*}" "$bytes"
    return
  fi
  if [ "$kind" = "standalone clone" ]; then
    if ! rm -rf -- "$wt"; then log "KEEP $wt: standalone clone removal failed"; else tally "sweep ${wt%/*}" "$bytes"; fi
  elif ! rgit "$wt" worktree remove -- "$wt" 2>/dev/null; then
    log "KEEP $wt: git worktree remove failed; no recursive filesystem fallback"
  else
    tally "sweep ${wt%/*}" "$bytes"
  fi
}

sweep_live_checkout() {
  local checkout="${1%/}" wt child status top
  [ -d "$checkout/.git" ] || [ -f "$checkout/.git" ] || return
  [ ! -L "$checkout" ] && [ ! -L "$checkout/.git" ] || return
  top="$(rgit "$checkout" rev-parse --show-toplevel 2>/dev/null)" || return
  [ "$top" = "$(cd -P -- "$checkout" && pwd -P)" ] || return
  for wt in "$checkout"/* "$checkout"/.[!.]* "$checkout"/..?*; do
    [ -d "$wt/.git" ] && [ ! -L "$wt" ] && [ ! -L "$wt/.git" ] || continue
    child="${wt##*/}"
    rgit "$checkout" ls-files --error-unmatch -- "$child/" >/dev/null 2>&1; status=$?
    [ "$status" = 1 ] || continue
    rgit "$checkout" ls-files --error-unmatch -- "$child" >/dev/null 2>&1; status=$?
    # Only Git's explicit no-match is a candidate; errors and tracked paths stay untouched.
    [ "$status" = 1 ] || continue
    if is_protected_worktree "$wt"; then log "KEEP $wt: protected by janitor configuration"
    else sweep_worktree "$wt"; fi
  done
}

# ── rule 4 ──
fs_id() {
  if [ -n "$FSID_CMD" ]; then $FSID_CMD "$1"
  else stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null; fi
}

DOCKER_OK=1
DOCKER_MOUNTS=""
container_path_identity() {
  stat -Lc '%d:%i' -- "$1" 2>/dev/null || stat -Lf '%d:%i' -- "$1" 2>/dev/null
}
snapshot_docker() {
  local ids id mounts mount identity
  DOCKER_IDENTITIES="|"; DOCKER_PATH_REASON="Docker mount snapshot failed"
  if ! ids="$($DOCKER_CMD ps -q 2>/dev/null)"; then DOCKER_OK=0; return; fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! mounts="$($DOCKER_CMD inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$id" 2>/dev/null)"; then
      DOCKER_OK=0; return
    fi
    DOCKER_MOUNTS="$(printf '%s\n%s' "$DOCKER_MOUNTS" "$mounts")"
    while IFS= read -r mount; do
      [ -n "$mount" ] || continue
      if ! identity="$(container_path_identity "$mount")"; then
        DOCKER_OK=0; DOCKER_PATH_REASON="Docker mount identity unreadable"; return
      fi
      case "$DOCKER_IDENTITIES" in *"|$identity|"*) ;; *) DOCKER_IDENTITIES="$DOCKER_IDENTITIES$identity|" ;; esac
    done <<< "$mounts"
  done <<< "$ids"
}
keep_container_path() {
  local p="$1"
  if [ "$DOCKER_OK" != 1 ]; then log "KEEP $p: $DOCKER_PATH_REASON (fail closed)"; return 0; fi
  if is_docker_mount "$p"; then log "KEEP $p: $DOCKER_PATH_REASON"; return 0; fi
  return 1
}
is_docker_mount() {
  local p="$1" mount cursor identity
  [ "$DOCKER_OK" = 1 ] || return 0
  DOCKER_PATH_REASON="running container mount"
  while IFS= read -r mount; do
    [ -n "$mount" ] || continue
    case "$mount" in "$p"|"$p"/*) return 0 ;; esac
    case "$p" in "$mount"|"${mount%/}"/*) return 0 ;; esac
  done <<< "$DOCKER_MOUNTS"
  [ "${DOCKER_IDENTITIES:-|}" != "|" ] || return 1
  case "$p" in /*) ;; *) DOCKER_PATH_REASON="Docker mount path is not absolute (fail closed)"; return 0 ;; esac
  cursor="$p"
  while :; do
    if [ -e "$cursor" ] || [ -L "$cursor" ]; then
      if ! identity="$(container_path_identity "$cursor")"; then
        DOCKER_PATH_REASON="Docker mount identity unreadable (fail closed)"; return 0
      fi
      case "$DOCKER_IDENTITIES" in
        *"|$identity|"*) DOCKER_PATH_REASON="running container mount through filesystem identity"; return 0 ;;
      esac
    fi
    [ "$cursor" = / ] && break
    cursor="${cursor%/*}"; [ -n "$cursor" ] || cursor=/
  done
  return 1
}
# A parent directly under a scratch root is met twice (as a unit, then as a parent): log it once.
PARENTS_LOGGED=":"
keep_parent() {
  case "$PARENTS_LOGGED" in *":$1:"*) return ;; esac
  PARENTS_LOGGED="$PARENTS_LOGGED$1:"
  log "KEEP $1: workspace parent root"
}
# A keep marker whose first line is `keep-until: YYYY-MM-DD` (or JSON "until") lapses after that UTC date.
MARKERS_SEEN="|"; TODAY_UTC="$(date -u +%Y-%m-%d)"
keep_marker() {   # keep_marker <folder> [quiet]: true while its marker is in force
  local m="$1/.rmd-scratch-keep" text until seen=0 mtime
  [ -e "$m" ] || [ -L "$m" ] || return 1
  if [ -L "$m" ] || [ ! -f "$m" ]; then return 0; fi
  text="$(head -c 4096 -- "$m" 2>/dev/null)"
  until="$(printf '%s\n' "$text" | sed -n -E '1s/^keep-until:[[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p')"
  [ -n "$until" ] || until="$(printf '%s' "$text" | tr '\n' ' ' | sed -n -E 's/.*"until"[[:space:]]*:[[:space:]]*"([0-9]{4}-[0-9]{2}-[0-9]{2})".*/\1/p')"
  [ "${2:-}" = quiet ] && seen=1
  case "$MARKERS_SEEN" in *"|$m|"*) seen=1 ;; *) [ "$seen" = 1 ] || MARKERS_SEEN="$MARKERS_SEEN$m|" ;; esac
  if [ -n "$until" ]; then
    if [[ "$until" < "$TODAY_UTC" ]]; then
      [ "$seen" = 1 ] || log "KEEP-EXPIRED $m: keep-until $until has passed; the folder is judged normally"
      return 1
    fi
    return 0
  fi
  if [ "$seen" = 0 ]; then
    mtime="$(file_sig "$m")"; mtime="${mtime##* }"
    log "MARKER $m: honoured with no machine-readable expiry, $(( ( $(date +%s) - ${mtime:-0} ) / 86400 )) days old"
  fi
  return 0
}
ruling_namespace() {   # true when $1 is, or is inside, a namespace under an operator ruling
  local n
  while IFS= read -r n; do
    n="${n%/}"; [ -n "$n" ] || continue
    case "$1" in "$n"|"$n"/*) return 0 ;; esac
  done < <(printf '%s\n' "$RULING_NAMESPACES" | tr ':' '\n')
  return 1
}
scratch_guard() {
  local p="$1" protected parent
  case "${p##*/}" in
    swapfile|lost+found|rmd|worktrees|tmp|npm-cache|node-compile-cache|node-v*-linux-x64*|tsx-*|.remudero-coverage|state|docker|containerd)
      log "KEEP $p: protected scratch name"; return 1 ;;
  esac
  if [ -L "$p" ]; then log "KEEP $p: symbolic link"; return 1; fi
  if keep_marker "$p"; then
    log "KEEP $p: scratch keep marker"; return 1
  fi
  if ruling_namespace "$p"; then log "KEEP $p: operator ruling 2026-10-23 (retired only by the service-user pass)"; return 1; fi
  # The preserve-then-retire copies sit on the scratch disk; only retention may expire them.
  case "$PRESERVE_ROOT" in "$p"|"$p"/*) log "KEEP $p: holds the janitor's preserve root $PRESERVE_ROOT"; return 1 ;; esac
  while IFS= read -r parent; do
    [ -n "$parent" ] || continue
    parent="${parent%/}"
    case "$parent" in "$p"|"$p"/*) keep_parent "$p"; return 1 ;; esac
  done < <(printf '%s\n%s\n' "$SCRATCH_PARENTS" "$STATE_PARENTS" | tr ':' '\n')
  if is_protected_worktree "$p"; then log "KEEP $p: protected by janitor configuration"; return 1; fi
  while IFS= read -r protected; do
    [ -n "$protected" ] || continue
    case "$protected" in "$p"/*) log "KEEP $p: protected by janitor configuration"; return 1 ;; esac
    case "$p" in "$protected"/*) log "KEEP $p: protected by janitor configuration"; return 1 ;; esac
  done < <(printf '%s\n' "$PROTECTED_WORKTREE_ROOTS" | tr ':' '\n')
  return 0
}
scratch_repo_check() {
  local repo="$1" gitdir status
  if [ -L "$repo/.git" ]; then SCRATCH_REASON="Git metadata has an unexpected type"; return 1; fi
  if ! gitdir="$(rgit "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || [ ! -d "$gitdir" ]; then
    SCRATCH_REASON="Git metadata is unreadable or missing"; return 1
  fi
  if [ -f "$gitdir/locked" ]; then SCRATCH_REASON="Git worktree is locked"; return 1; fi
  if ! git_head_idle "$repo"; then SCRATCH_REASON="recent or unverified Git HEAD activity"; return 1; fi
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
  local scope=head
  [ -d "$1/.git" ] && scope=all
  rmd_workspace_published "$1" "$scope" "${2:-0}"
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
  # Leave the original until the enclosing unit's final age/liveness checks.
  # Removing it now would refresh its parent and defeat the six-hour proof.
  return 0
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
  local p="$1" reason="$2" entries="$3" entry repo name tree found tracked bytes scope
  log "KEEP $p: $reason"
  case "$reason" in
    *not-proven-published*|*publication-unverified*|*Git\ metadata*|*Git\ status\ failed*|*Git\ HEAD\ activity*|*locked*|*lends*|*borrow*) return ;;
  esac
  while IFS= read -r entry; do
    case "$entry" in */.git) repo="${entry%/.git}" ;; *) continue ;; esac
    case "${repo#"$p"}/" in */node_modules/*|*/coverage/*) continue ;; esac
    [ -d "$repo" ] && [ ! -L "$repo" ] && [ ! -L "$entry" ] || continue
    scope="head"; [ -d "$repo/.git" ] && scope="all"
    if ! rmd_workspace_published "$repo" "$scope"; then log "KEEP $repo: $RMD_PUB_REASON; caches retained too"; continue; fi
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
      if [ "$DRY_RUN" != 1 ]; then snapshot_open; snapshot_docker; fi
      if ! is_idle "$tree" || is_open "$tree" || [ "$DOCKER_OK" != 1 ] || is_docker_mount "$tree"; then
        log "KEEP $tree: recent, active or unverified cache"; continue
      fi
      bytes="$(du -sk -- "$tree" 2>/dev/null | awk '{print $1 * 1024}')"
      log "PRUNE $tree: ${bytes:-unknown} bytes, unit kept for $reason"
      if act rm -rf -- "$tree"; then
        PRUNED_COUNT=$((PRUNED_COUNT + 1)); PRUNED_BYTES=$((PRUNED_BYTES + ${bytes:-0}))
        tally "prune ${p%/*}" "$bytes"
      fi
    done
  done <<< "$entries"
}
# tsx's transpile cache, os.tmpdir()/tsx-<uid>. Measured 2026-10-06: /tmp/tsx-1000 at 2.7 GB on the
# 29 GB root disk (root at 91%). scratch_guard keeps `tsx-*` whole — removing the directory under a
# running build is never right — and nothing pruned INSIDE it. tsx (4.x) writes flat, write-once
# files and treats a missing one as a cache miss (recompile, rewrite), so a stale FILE is safely
# disposable while the directory stays. Only regular files older than TSX_MAX_AGE_MINUTES go, then
# empty subdirectories equally old (never the cache directory itself). find runs with -P (the
# default: no symlink is followed, and -type f never matches one) and -xdev (no other filesystem
# is entered). No per-file lsof check: tsx reads an entry and closes it, and unlinking a file a
# reader still holds frees nothing until it closes — but an lsof that failed still keeps everything.
TSX_PRUNED_COUNT=0
TSX_PRUNED_BYTES=0
prune_tsx_cache() {
  local dir="$1" minutes stats count bytes
  minutes="$TSX_MAX_AGE_MINUTES"
  keep_container_path "$dir" && return
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then log "KEEP $dir: not a regular directory"; return; fi
  if [ "$OPEN_OK" != 1 ]; then log "KEEP $dir: $OPEN_FAILURE (fail closed)"; return; fi
  if ! stats="$(find "$dir" -xdev -type f -mmin "+$minutes" -exec du -k {} + 2>/dev/null \
       | awk '{ n++; kb += $1 } END { printf "%d %d", n, kb * 1024 }')"; then
    log "KEEP $dir: tsx cache scan failed (unknown)"; return
  fi
  count="${stats%% *}"; bytes="${stats##* }"
  if [ "${count:-0}" -gt 0 ]; then
    log "PRUNE $dir: ${bytes} bytes, ${count} tsx cache files older than $(fmt_minutes "$TSX_MAX_AGE_MINUTES")"
    if act find "$dir" -xdev -type f -mmin "+$minutes" -delete; then
      TSX_PRUNED_COUNT=$((TSX_PRUNED_COUNT + count)); TSX_PRUNED_BYTES=$((TSX_PRUNED_BYTES + bytes))
      tally "tsx $dir" "$bytes"
    fi
  fi
  if [ -n "$(find "$dir" -xdev -mindepth 1 -type d -empty -mmin "+$minutes" -print -quit 2>/dev/null)" ]; then
    act find "$dir" -xdev -mindepth 1 -depth -type d -empty -mmin "+$minutes" -delete
  fi
  log "KEEP $dir: tsx cache directory (entries newer than $(fmt_minutes "$TSX_MAX_AGE_MINUTES") stay)"
}

# W1-T5634. A unit another unit borrows objects from (objects/info/alternates) is kept: removing it
# left /mnt/scratch/g and h unable to read HEAD. ONE bounded scan per pass, only inside the configured
# roots: find -maxdepth 8 (a unit's repos sit at depth <= 4, as the repository scan below), no link
# followed, node_modules and object fan-out pruned, at most 64 lines read per file. A target outside
# the roots is only tested for existence, never opened. A failed scan keeps every unit it reaches.
ALTERNATES_OK=1
ALTERNATES=""  # "<alternates file><TAB><lexically normalized target>" lines
normalize_path() {
  printf '%s\n' "$1" | awk -F/ '{
    n = 0
    for (i = 1; i <= NF; i++) {
      if ($i == "" || $i == ".") continue
      if ($i == "..") { if (n > 0) n--; continue }
      s[++n] = $i
    }
    out = ""; for (i = 1; i <= n; i++) out = out "/" s[i]
    print (out == "" ? "/" : out)
  }'
}
# find into SCAN_OUT, each refused folder into SCAN_DENIED; only a non-refusal error fails (one foreign folder must not fail all).
scan_find() {
  local out line rc other=0
  SCAN_OUT=""; SCAN_DENIED=""
  out="$(LC_ALL=C $FIND_CMD "$@" 2>&1 </dev/null)"; rc=$?
  while IFS= read -r line; do
    case "$line" in
      "") ;;
      /*) SCAN_OUT="$SCAN_OUT$line
" ;;
      "find: "*": Permission denied")
        line="${line#find: }"; line="${line%: Permission denied}"; line="${line#\'}"; line="${line%\'}"
        SCAN_DENIED="$SCAN_DENIED$line
" ;;
      *) other=1 ;;
    esac
  done <<< "$out"
  [ "$rc" = 0 ] || { [ "$other" = 0 ] && [ -n "$SCAN_DENIED" ]; }
}
denied_inside() {
  local d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$d" in "$2"|"$2"/*) printf '%s\n' "$d"; return 0 ;; esac
  done <<< "$1"
  return 1
}
ALTERNATES_DENIED=""
snapshot_alternates() {
  local root files file lines line target
  while IFS= read -r root; do
    root="${root%/}"
    [ -n "$root" ] && [ -d "$root" ] && [ ! -L "$root" ] || continue
    if ! scan_find "$root" -maxdepth 8 \( -name node_modules -o -path '*/objects/[0-9a-f][0-9a-f]' \
        -o -path '*/objects/pack' \) -prune -o -type f -path '*/objects/info/alternates' -print; then
      ALTERNATES_OK=0; return
    fi
    files="$SCAN_OUT"; ALTERNATES_DENIED="$ALTERNATES_DENIED$SCAN_DENIED"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      lines="$(head -n 64 -- "$file" 2>/dev/null)" || { ALTERNATES_OK=0; return; }
      while IFS= read -r line; do
        case "$line" in ""|"#"*) continue ;; /*) target="$line" ;; *) target="${file%/info/alternates}/$line" ;; esac
        ALTERNATES="$ALTERNATES$file	$(normalize_path "$target")
"
      done <<< "$lines"
    done <<< "$files"
  done < <(printf '%s\n%s\n%s\n%s\n%s\n' "$SCRATCH_ROOTS" "$SCRATCH_PARENTS" "$WORKTREE_ROOTS" "$LIVE_CHECKOUTS" "$TMP_ROOTS" | tr ':' '\n'
             # the preserve-then-retire phase judges these too, so their borrowers count (full pass only)
             [ "$ONLY_TMP" = 1 ] || printf '%s\n' "$PRESERVE_ROOTS" | tr ':' '\n'
             state_units)
}
# Sets SCRATCH_REASON and fails when unit $1 must stay: it borrows from a store that is gone, or a
# borrower outside it still names it. A borrower removed earlier in this pass no longer holds it.
lender_check() {
  local p="$1" pp file target borrower borrowers=""
  if [ "$ALTERNATES_OK" != 1 ]; then SCRATCH_REASON="alternates scan failed (unknown)"; return 1; fi
  if file="$(denied_inside "$ALTERNATES_DENIED" "$p")"; then SCRATCH_REASON="alternates scan refused at $file (unknown)"; return 1; fi
  pp="$(cd -P -- "$p" 2>/dev/null && pwd -P)" || pp="$p"
  while IFS='	' read -r file target; do
    [ -n "$file" ] || continue
    case "$file" in
      "$p"/*) [ -d "$target" ] || { SCRATCH_REASON="borrows from missing $target"; return 1; } ;;
      *) case "$target" in
           "$p"|"$p"/*|"$pp"|"$pp"/*)
             [ -f "$file" ] || continue
             borrower="${file%/objects/info/alternates}"; borrower="${borrower%/.git}"
             case ", $borrowers, " in *", $borrower, "*) ;; *) borrowers="$borrowers${borrowers:+, }$borrower" ;; esac ;;
         esac ;;
    esac
  done <<< "$ALTERNATES"
  [ -z "$borrowers" ] || { SCRATCH_REASON="lends objects to $borrowers"; return 1; }
}
sweep_scratch_unit() {
  local p="$1" status entries entry repo head bundles bytes seed_reason gitdir hosted
  local IDLE_MINUTES="$SCRATCH_IDLE_MINUTES" SCRATCH_REASON=""
  # Empty when the unit holds no repository: healthy, and it still passes every check below.
  # ${a[@]+...} because Bash before 4.4 calls an empty array unbound under `set -u` (W1-T6594).
  local -a SCRATCH_LIVE_REPOS=()
  scratch_guard "$p" || return
  is_worktree_idle "$p"; status=$?
  case "$status" in
    0) ;;
    1) log "KEEP $p: written within ${IDLE_MINUTES} min"; return ;;
    *) log "KEEP $p: activity probe failed (unknown)"; return ;;
  esac
  if seed_reason=$(rmd_dependency_seed_risk "$p"); then log "KEEP $p: $seed_reason"; return; fi
  if is_open "$p"; then log "KEEP $p: held open by a process"; return; fi
  if [ "$DOCKER_OK" != 1 ]; then log "KEEP $p: docker probe failed (unknown)"; return; fi
  if is_docker_mount "$p"; then log "KEEP $p: $DOCKER_PATH_REASON"; return; fi
  if [ -d "$p" ]; then
    bare_repository_scan "$p"; status=$?
    case "$status" in
      1) log "KEEP $p: bare repository; Git history retained"; return ;;
      2) log "KEEP $p: repository scan failed (unknown)"; return ;;
    esac
  fi
  if ! entries="$(find "$p" -name node_modules -prune -o -name .git -prune -print 2>/dev/null)"; then
    log "KEEP $p: repository scan failed (unknown)"; return
  fi
  if ! lender_check "$p"; then keep_scratch_for_repo "$p" "$SCRATCH_REASON" "$entries"; return; fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in */.git) repo="${entry%/.git}" ;; *) log "KEEP $p: unreadable repository path"; return ;; esac
    if ! scratch_repo_check "$repo"; then keep_scratch_for_repo "$p" "$SCRATCH_REASON ($repo)" "$entries"; return; fi
    if [ -d "$repo/.git" ]; then
      gitdir=$(rgit "$repo" rev-parse --absolute-git-dir 2>/dev/null) || { log "KEEP $p: Git metadata unreadable"; return; }
      if hosted=$(clone_live_worktree "$gitdir"); then
        log "KEEP $p: hosts linked worktree $hosted; lender retained"; return
      fi
    fi
  done <<< "$entries"
  # Validate the whole unit before removing any of its repositories. Missing
  # metadata and unpublished work stay in place, even if an archive is possible.
  for repo in ${SCRATCH_LIVE_REPOS[@]+"${SCRATCH_LIVE_REPOS[@]}"}; do
    if ! rmd_remote_outside_retirement "$repo" "$p"; then
      log "KEEP $p: remote publication lender is inside removal unit or unverified ($repo)"; return
    fi
    head="$(rgit "$repo" rev-parse HEAD 2>/dev/null)" || { keep_scratch_for_repo "$p" "HEAD is unreadable" "$entries"; return; }
    if ! scratch_repo_saved "$repo"; then
      keep_scratch_for_repo "$p" "$RMD_PUB_REASON ($repo HEAD=$head)" "$entries"; return
    fi
  done
  if ! bundles="$(find "$p" -name .git -prune -o -type f -name '*.bundle' -print 2>/dev/null)"; then
    log "KEEP $p: bundle scan failed (unknown)"; return
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if ! archive_scratch_bundle "$entry"; then keep_scratch_for_repo "$p" "bundle could not be archived safely" "$entries"; return; fi
  done <<< "$bundles"
  if [ "$DRY_RUN" != 1 ]; then
    snapshot_open; snapshot_docker
    if ! is_worktree_idle "$p" || is_open "$p" || [ "$DOCKER_OK" != 1 ] || is_docker_mount "$p" || ! lender_check "$p"; then
      log "KEEP $p: changed or active before remove"; return
    fi
    SCRATCH_LIVE_REPOS=()
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      repo="${entry%/.git}"
      if ! scratch_repo_check "$repo" || ! scratch_repo_saved "$repo" 1; then
        log "KEEP $p: Git state changed or not-proven-published before remove ($repo)"; return
      fi
    done <<< "$entries"
  fi
  for repo in ${SCRATCH_LIVE_REPOS[@]+"${SCRATCH_LIVE_REPOS[@]}"}; do
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
  act rm -rf -- "$p" && tally "sweep ${p%/*}" "$bytes"
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
# ── W1-T5707: the state disk's top level ──
# Fails with STATE_REASON when child $1 of state parent $2 must stay whatever its idleness.
state_child_guard() {
  local p="$1" parent="$2" a b configured
  case " $STATE_DENY " in *" ${p##*/} "*) STATE_REASON="state-disk deny-list"; return 1 ;; esac
  if [ -L "$p" ]; then STATE_REASON="symbolic link"; return 1; fi
  a="$(fs_id "$p")"; b="$(fs_id "$parent")"
  if [ -z "$a" ] || [ -z "$b" ]; then STATE_REASON="filesystem probe failed (unknown)"; return 1; fi
  if [ "$a" != "$b" ]; then STATE_REASON="mount point"; return 1; fi
  if command -v mountpoint >/dev/null 2>&1 && mountpoint -q -- "$p" 2>/dev/null; then
    STATE_REASON="mount point"; return 1
  fi
  while IFS= read -r configured; do
    configured="${configured%/}"
    [ -n "$configured" ] || continue
    case "$configured" in "$p"|"$p"/*) STATE_REASON="holds janitor path $configured"; return 1 ;; esac
  done < <(printf '%s\n' "$ARCHIVE_ROOT" "$WORKTREE_ARCHIVE_ROOT" "$TMP_ROOTS" "$SCRATCH_ROOTS" \
             "$SCRATCH_PARENTS" "$WORKTREE_ROOTS" "$COVERAGE_LOCK_DIR" "$LOCK_FILE" "$PRESERVE_ROOT" \
             "$RETAIN_ROOTS" | tr ':' '\n')
}
# Fails with STATE_REASON when state parent $1 is the root disk's own directory (disk not mounted).
state_parent_ok() {
  local a b
  a="$(fs_id "$1")"; b="$(fs_id "$ROOT_FS")"
  if [ -z "$a" ] || [ -z "$b" ]; then STATE_REASON="filesystem probe failed (unknown)"; return 1; fi
  [ "$a" != "$b" ] || { STATE_REASON="on the same filesystem as $ROOT_FS (state disk not mounted)"; return 1; }
}
# The children a pass may judge, one per line: the alternates scan walks these, never docker/.
state_units() {
  local parent unit STATE_REASON
  while IFS= read -r parent; do
    parent="${parent%/}"
    [ -n "$parent" ] && [ -d "$parent" ] && [ ! -L "$parent" ] && ! keep_marker "$parent" quiet || continue
    state_parent_ok "$parent" || continue
    for unit in "$parent"/* "$parent"/.[!.]* "$parent"/..?*; do
      { [ -e "$unit" ] || [ -L "$unit" ]; } && state_child_guard "$unit" "$parent" && printf '%s\n' "$unit"
    done
  done < <(printf '%s\n' "$STATE_PARENTS" | tr ':' '\n')
}
sweep_state_parent() {
  local parent="${1%/}" unit STATE_REASON=""
  [ -d "$parent" ] || return
  keep_parent "$parent"
  if keep_marker "$parent" || [ -L "$parent" ]; then
    log "KEEP $parent: scratch keep marker or symbolic link"; return
  fi
  if ! state_parent_ok "$parent"; then log "KEEP $parent: $STATE_REASON"; return; fi
  for unit in "$parent"/* "$parent"/.[!.]* "$parent"/..?*; do
    [ -e "$unit" ] || [ -L "$unit" ] || continue
    if state_child_guard "$unit" "$parent"; then sweep_scratch_unit "$unit"; else log "KEEP $unit: $STATE_REASON"; fi
  done
}
# ── W1-T5708: coverage scratch nested at any depth ──
# `coverageScratchDir` is `<tmpdir>/rmd-c-<12 hex>` and its gate lock is `/tmp/rmd-c-<hash>.lock`
# (a directory whose holder.json records pid and host). A SIGKILLed run leaves the scratch behind,
# and one nested in an ad-hoc checkout's tmp is never reclaimed by a later run of the same repo.
# Returns 0 when nothing holds the scratch; otherwise 1 with LOCK_REASON saying why.
coverage_lock_free() {
  local lock="$COVERAGE_LOCK_DIR/${1##*/}.lock" holder pid host
  LOCK_REASON=""
  [ -e "$lock" ] || [ -L "$lock" ] || return 0
  holder="$lock/holder.json"
  if [ -L "$lock" ] || [ ! -f "$holder" ]; then LOCK_REASON="its lock $lock is present with no holder record"; return 1; fi
  pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$holder" 2>/dev/null | head -n 1)"
  host="$(sed -n 's/.*"host":"\([^"]*\)".*/\1/p' "$holder" 2>/dev/null | head -n 1)"
  if [ -z "$pid" ] || [ -z "$host" ]; then LOCK_REASON="its lock $lock has an unattributed holder"; return 1; fi
  if [ "$host" != "$(hostname 2>/dev/null)" ]; then LOCK_REASON="its lock $lock is held from host $host"; return 1; fi
  if kill -0 "$pid" 2>/dev/null || [ -e "/proc/$pid" ] || ps -p "$pid" >/dev/null 2>&1; then
    LOCK_REASON="its lock $lock is held by live pid $pid"; return 1
  fi
  return 0
}
NESTED_COVERAGE_SEEN=""
sweep_nested_coverage() {
  local root="${1%/}" p idle_status bytes LOCK_REASON
  local IDLE_MINUTES="$SCRATCH_IDLE_MINUTES"
  [ -d "$root" ] && [ ! -L "$root" ] || return
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [[ "${p##*/}" =~ ^rmd-c-[0-9a-f]{12}$ ]] || continue
    ruling_namespace "$p" && continue
    case "$NESTED_COVERAGE_SEEN" in *"|$p|"*) continue ;; esac
    NESTED_COVERAGE_SEEN="$NESTED_COVERAGE_SEEN|$p|"
    keep_container_path "$p" && continue
    [ -d "$p" ] && [ ! -L "$p" ] || continue
    is_idle "$p"; idle_status=$?
    case "$idle_status" in
      0) ;;
      1) log "KEEP $p: written within ${IDLE_MINUTES} min"; continue ;;
      *) log "KEEP $p: activity probe failed (unknown)"; continue ;;
    esac
    if ! coverage_lock_free "$p"; then log "KEEP $p: $LOCK_REASON"; continue; fi
    if is_open "$p"; then log "KEEP $p: held open by a process"; continue; fi
    bytes="$(du -sk -- "$p" 2>/dev/null | awk '{print $1 * 1024}')"
    log "REMOVE $p: nested coverage scratch with no lock, ${bytes:-unknown} bytes"
    act rm -rf -- "$p" && tally "coverage $root" "$bytes"
  done < <(find "$root" -xdev -maxdepth 6 \( -name .git -o -name node_modules -o -name docker -o -name containerd \) -prune -o \
             -type d -name 'rmd-c-*' -print -prune 2>/dev/null)
}
ARCHIVE_OK=0
check_archive_root() {
  local a b probe="$ARCHIVE_ROOT"
  ARCHIVE_OK=0
  keep_container_path "$ARCHIVE_ROOT" && return
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
  keep_container_path "$f" && return
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

# ── preserve-then-retire (operator 2026-10-23): the Mac preserve-retire.py design on this janitor's
# own guards; holds, copy format and restore steps are in deploy/mac/JANITOR.md.
PRESERVE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PRESERVE_SKIP_DIRS="node_modules coverage dist .turbo .next"
PRESERVE_RETIRED=0; PRESERVE_HELD=0
owner_uid() { stat -c %u -- "$1" 2>/dev/null || stat -f %u -- "$1" 2>/dev/null; }
url_without_credentials() { printf '%s\n' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#'; }
remote_published() {
  local url prefix
  url="$(url_without_credentials "$1")"
  for prefix in $PUBLISHED_REMOTES; do case "$url" in "$prefix"*) return 0 ;; esac; done
  return 1
}
preserve_hold() {
  PRESERVE_HELD=$(( PRESERVE_HELD + 1 ))
  log "KEEP $1: preserve-then-retire hold: $2"
}
RULING_CHILD=""
preserve_skip() {
  local p="$1" other
  [ "$p" = "$RULING_CHILD" ] && return 1
  ruling_namespace "$p" && [ -z "$RULING_CHILD" ] && return 0
  case "${p##*/}" in
    swapfile|lost+found|worktrees|tmp|npm-cache|node-compile-cache|node-v*-linux-x64*|tsx-*|.remudero-coverage|state|docker|containerd|host-cleanup-validation-bundles-*|.incoming-*) return 0 ;;
  esac
  while IFS= read -r other; do
    other="${other%/}"
    [ -n "$other" ] || continue
    case "$other" in "$p"|"$p"/*) return 0 ;; esac
  done < <(printf '%s\n' "$PRESERVE_ROOTS" "$PRESERVE_ROOT" "$ARCHIVE_ROOT" "$WORKTREE_ARCHIVE_ROOT" "$RETAIN_ROOTS" \
             "$COVERAGE_PATHS" "$LOCK_FILE" | tr ':' '\n')
  return 1
}
preserve_oversized() {
  local repo="$1" files f rel
  files="$(find "$repo" \( -name .git -o -name node_modules -o -name coverage -o -name dist -o -name .turbo -o -name .next \) -prune \
             -o -type f -size "+${MAX_UNTRACKED_MB}M" -print 2>/dev/null)" || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rel="${f#"$repo"/}"
    rgit "$repo" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 || { printf '%s\n' "$rel"; return 0; }
  done <<< "$files"
}
preserve_exclusions() {
  local repo="$1" unit="$2" url
  url="$(rgit "$repo" remote get-url origin 2>/dev/null)" || return 0
  remote_published "$url" || return 0
  rmd_remote_outside_retirement "$repo" "$unit" || return 0
  if rmd_publication_snapshot "$repo"; then
    printf '%s\n' "$RMD_PUB_REFS" | awk '$2 ~ /^refs\/(heads|tags)\// { print $1 "^{commit}" }' |
      rgit "$repo" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null |
      awk '$2 == "commit" { print "^" $1 }' | sort -u
    return 0
  fi
  return 0
}
preserve_write() {
  local repo="$1" unit="$2" work="$3" head="$4" final="$5" branch excl count objects r name url remotes_text="" skip
  local -a revs=() tar_excludes=()
  branch="$(rgit "$repo" symbolic-ref -q --short HEAD 2>/dev/null)" || branch="(detached)"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    url="$(rgit "$repo" remote get-url "$name" 2>/dev/null)" || { PRESERVE_REASON="remote-url-unreadable"; return 1; }
    remotes_text="$remotes_text  $name $(url_without_credentials "$url")
"
  done < <(rgit "$repo" remote 2>/dev/null)
  excl="$(preserve_exclusions "$repo" "$unit")"
  rgit "$repo" for-each-ref --format='%(objectname) %(refname)' > "$work/refs.txt" 2>/dev/null || { PRESERVE_REASON="refs-unreadable"; return 1; }
  PRESERVED_REFS_HASH="$(rgit "$repo" hash-object --stdin < "$work/refs.txt")" || { PRESERVE_REASON="refs-hash-failed"; return 1; }
  revs=(--all HEAD "$head")
  while read -r r name; do [ -n "$r" ] && revs+=("$r"); done < "$work/refs.txt"
  while IFS= read -r r; do [ -n "$r" ] && revs+=("$r"); done <<< "$excl"
  count="$(rgit "$repo" rev-list --count "${revs[@]}" 2>/dev/null)" || { PRESERVE_REASON="history-unrecoverable (rev-list failed)"; return 1; }
  objects="$(rgit "$repo" rev-list --objects --no-object-names "${revs[@]}" 2>/dev/null | wc -l)" || { PRESERVE_REASON="objects-unrecoverable (rev-list failed)"; return 1; }
  if [ "${objects:-0}" -gt 0 ]; then
    rgit "$repo" bundle create "$work/unpublished.bundle" "${revs[@]}" >/dev/null 2>&1 </dev/null || { PRESERVE_REASON="bundle-create-failed"; return 1; }
    rgit "$repo" bundle verify "$work/unpublished.bundle" >/dev/null 2>&1 </dev/null || { PRESERVE_REASON="bundle-unverified"; return 1; }
  fi
  rgit "$repo" diff --binary HEAD > "$work/uncommitted.patch" 2>/dev/null || { PRESERVE_REASON="diff-failed"; return 1; }
  [ -s "$work/uncommitted.patch" ] || rm -f -- "$work/uncommitted.patch"
  for skip in $PRESERVE_SKIP_DIRS; do tar_excludes+=("-x" "$skip"); done
  rgit "$repo" ls-files -z --others "${tar_excludes[@]}" > "$work/.untracked" 2>/dev/null || { PRESERVE_REASON="untracked-listing-failed"; return 1; }
  if [ -s "$work/.untracked" ]; then
    tar_excludes=(--exclude=.git)
    for skip in $PRESERVE_SKIP_DIRS; do tar_excludes+=("--exclude=$skip"); done
    if ! ( cd -- "$repo" && tar -czf "$work/untracked.tar.gz" "${tar_excludes[@]}" --null -T "$work/.untracked" ) </dev/null >/dev/null 2>&1 ||
       ! tar -tzf "$work/untracked.tar.gz" </dev/null >/dev/null 2>&1; then
      PRESERVE_REASON="untracked-tarball-failed"; return 1
    fi
  fi
  rm -f -- "$work/.untracked"
  {
    printf 'Preserved by the Azure host janitor (deploy/rmd-host-cleanup.sh, preserve-then-retire).\n'
    printf 'path:   %s\nunit:   %s\nhead:   %s  branch: %s\npreserved_at: %s\n' "$repo" "$unit" "$head" "$branch" "$PRESERVE_STAMP"
    printf 'commits not on a published remote: %s\nobjects not on a published remote: %s\nremotes:\n%s' "$count" "$objects" "$remotes_text"
    printf 'expires: %s days after preservation (operator ruling 2026-10-23)\n\nRestore:\n' "$RETAIN_DAYS"
    printf '  git clone <upstream URL from remotes above> <dir> && cd <dir>\n'
    printf '  git bundle unbundle %s/unpublished.bundle   # if present; restores every unpublished ref object\n' "$final"
    printf '  # refs.txt lists every original ref: git update-ref <ref> <sha> recreates the ones you want\n'
    printf '  git checkout %s\n  git apply --binary %s/uncommitted.patch   # if present\n  tar -xzf %s/untracked.tar.gz              # if present\n' "$head" "$final" "$final"
  } > "$work/MANIFEST.txt" || { PRESERVE_REASON="manifest-write-failed"; return 1; }
}
preserve_repo() {
  local repo="$1" unit="$2" head big name final work
  PRESERVE_REASON=""; PRESERVED_DIR=""; PRESERVED_HEAD=""; PRESERVED_REFS_HASH=""
  if ! head="$(rgit "$repo" rev-parse --verify HEAD 2>/dev/null)" || ! rgit "$repo" cat-file -e 'HEAD^{tree}' 2>/dev/null; then
    PRESERVE_REASON="history-unrecoverable (HEAD unreadable)"; return 1
  fi
  if ! big="$(preserve_oversized "$repo")"; then PRESERVE_REASON="untracked-file scan failed (unknown)"; return 1; fi
  if [ -n "$big" ]; then PRESERVE_REASON="untracked-file-over-${MAX_UNTRACKED_MB}MB ($big)"; return 1; fi
  if ! rgit "$repo" remote >/dev/null 2>&1; then PRESERVE_REASON="remotes-unreadable"; return 1; fi
  name="${repo#/}"; name="${name//\//__}@$PRESERVE_STAMP"
  final="$PRESERVE_ROOT/$name"
  PRESERVED_HEAD="$head"
  if [ "$DRY_RUN" = 1 ]; then PRESERVED_DIR="$final"; log "DRYRUN would: preserve $repo to $final"; return 0; fi
  if [ -e "$final" ] || [ -L "$final" ]; then PRESERVE_REASON="preserve copy $final already exists"; return 1; fi
  work="$PRESERVE_ROOT/.incoming-$name"
  if ! mkdir -m 700 -- "$work" 2>/dev/null; then PRESERVE_REASON="cannot create $work"; return 1; fi
  if ! preserve_write "$repo" "$unit" "$work" "$head" "$final" || ! mv -- "$work" "$final"; then
    rm -rf -- "$work"; PRESERVE_REASON="${PRESERVE_REASON:-preserve-move-failed}"; return 1
  fi
  PRESERVED_DIR="$final"
  log "PRESERVE $repo: copied to $final (HEAD=$head)"
}
PRESERVE_MARK_PCT=""; PRESERVE_MARK_KB=0
preserve_root_mark() {
  local i dev pdev
  pdev="$($DF_CMD "$PRESERVE_ROOT" 2>/dev/null | awk 'NR==2 { print $1 }')"
  [ -n "$pdev" ] || return 0
  for i in "${!W_PATH[@]}"; do
    [ -e "${W_PATH[$i]}" ] || continue
    dev="$($DF_CMD "${W_PATH[$i]}" 2>/dev/null | awk 'NR==2 { print $1 }')"
    [ "$dev" = "$pdev" ] || continue
    if [ -z "$PRESERVE_MARK_PCT" ] || [ "${W_PCT[$i]}" -lt "$PRESERVE_MARK_PCT" ]; then PRESERVE_MARK_PCT="${W_PCT[$i]}"; fi
    [ "${W_FREE_KB[$i]}" -gt "$PRESERVE_MARK_KB" ] && PRESERVE_MARK_KB="${W_FREE_KB[$i]}"
  done
}
preserve_root_has_room() {
  local row pct avail
  [ -n "$PRESERVE_MARK_PCT" ] || return 0
  row="$($DF_CMD "$PRESERVE_ROOT" 2>/dev/null | awk 'NR==2 { gsub("%","",$5); print $5, $4 }')"
  read -r pct avail <<< "$row"
  case "${pct:-x}${avail:-x}" in *[!0-9]*) return 1 ;; esac
  [ "$pct" -lt "$PRESERVE_MARK_PCT" ] && [ "$avail" -ge "$PRESERVE_MARK_KB" ]
}
docker_mount_inside() {
  local p="$1" mount
  while IFS= read -r mount; do
    mount="${mount%/}"
    [ -n "$mount" ] || continue
    case "$mount" in "$p"/*) return 0 ;; esac
  done <<< "$DOCKER_MOUNTS"
  return 1
}
unit_bundles() {
  local p="$1" files f
  scan_find "$p" \( -name node_modules -o -name .git \) -prune -o -type f -name '*.bundle' -print || return 1
  files="$SCAN_OUT"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    dump_in_repo "$f" "$p" || printf '%s\n' "$f"
  done <<< "$files"
}
preserve_bundles() {
  local p="$1" list="$2" name final work f
  PRESERVE_REASON=""; PRESERVED_DIR=""
  name="${p#/}"; name="${name//\//__}@$PRESERVE_STAMP"; final="$PRESERVE_ROOT/$name.bundles"
  if [ "$DRY_RUN" = 1 ]; then PRESERVED_DIR="$final"; log "DRYRUN would: copy the loose bundles of $p to $final"; return 0; fi
  if [ -e "$final" ] || [ -L "$final" ]; then PRESERVE_REASON="preserve copy $final already exists"; return 1; fi
  work="$PRESERVE_ROOT/.incoming-$name.bundles"
  mkdir -m 700 -- "$work" 2>/dev/null || { PRESERVE_REASON="cannot create $work"; return 1; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    mkdir -p -- "$work/$(dirname -- "${f#"$p"/}")" && cp -p -- "$f" "$work/${f#"$p"/}" && cmp -s -- "$f" "$work/${f#"$p"/}" ||
      { rm -rf -- "$work"; PRESERVE_REASON="bundle copy failed ($f)"; return 1; }
  done <<< "$list"
  printf 'Loose bundles of %s, preserved %s by the Azure host janitor; restore with git fetch <bundle> or git clone <bundle>.\nexpires: %s days after preservation (operator ruling 2026-10-23)\n' \
    "$p" "$PRESERVE_STAMP" "$RETAIN_DAYS" > "$work/MANIFEST.txt" && mv -- "$work" "$final" ||
    { rm -rf -- "$work"; PRESERVE_REASON="bundle manifest failed"; return 1; }
  PRESERVED_DIR="$final"
  log "PRESERVE $p: loose bundles copied to $final"
}
# A repository is judged whole; a folder held only by something inside it is descended, each child
# judged on its own, and stays while any child does (operator 2026-10-23).
preserve_unit() {
  local p="$1" entries bundles status uid found seed_reason entry repo gitdir reg target i bytes copies="" pp
  local is_repo=0 descend="" protected denied
  local IDLE_MINUTES="$SCRATCH_IDLE_MINUTES" SCRATCH_REASON=""
  local -a repos=() heads=() ref_hashes=()
  [ -d "$p" ] && [ ! -L "$p" ] || return 0
  preserve_skip "$p" && return 0
  scan_find "$p" -name node_modules -prune -o -name .git -prune -print; status=$?
  entries="$SCAN_OUT"; denied="$SCAN_DENIED"
  bundles="$(unit_bundles "$p")" || status=1
  [ -n "$entries$bundles" ] || return 0   # no repository and no bundle: the other sweeps own it
  uid="$(owner_uid "$p")"
  if [ "$uid" != "$RUN_UID" ]; then preserve_hold "$p" "foreign owner (uid ${uid:-unknown}, pass uid $RUN_UID)"; return; fi
  if [ "$status" != 0 ]; then preserve_hold "$p" "repository scan failed (unknown)"; return; fi
  if keep_marker "$p"; then preserve_hold "$p" "scratch keep marker"; return; fi
  if is_protected_worktree "$p"; then preserve_hold "$p" "protected by janitor configuration"; return; fi
  { [ -e "$p/.git" ] || [ -L "$p/.git" ]; } && is_repo=1
  [ -z "$denied" ] || descend="unreadable path inside ($(printf '%s\n' "$denied" | head -n 1))"
  if [ -f "$p/HEAD" ] && [ -d "$p/objects" ] && [ -d "$p/refs" ]; then preserve_hold "$p" "bare repository; Git history retained"; return; fi
  while IFS= read -r protected; do
    protected="${protected%/}"
    [ -n "$protected" ] || continue
    case "$protected" in
      "$p"/*/*) descend="${descend:-holds protected checkout $protected}" ;;
      "$p"/*) preserve_hold "$p" "holds protected checkout $protected"; return ;;
    esac
  done < <(printf '%s\n%s\n' "$PROTECTED_WORKTREE_ROOTS" "$LIVE_CHECKOUTS" | tr ':' '\n')
  if seed_reason=$(rmd_dependency_seed_risk "$p"); then
    case "$seed_reason" in contains*) descend="${descend:-$seed_reason}" ;; *) preserve_hold "$p" "$seed_reason"; return ;; esac
  fi
  if scan_find "$p" ! -user "$RUN_UID" -print -quit; then found="$(printf '%s\n' "$SCAN_OUT" | head -n 1)"
  else found=""; descend="${descend:-ownership scan failed (unknown)}"; fi
  [ -z "$found" ] || descend="${descend:-foreign owner (holds $found)}"
  if [ -z "$descend" ]; then
    is_worktree_idle "$p"; status=$?
    case "$status" in
      0) ;;
      1) descend="written within ${IDLE_MINUTES} min" ;;
      *) descend="activity probe failed (unknown)" ;;
    esac
  fi
  [ -n "$descend" ] || ! is_open "$p" || descend="held open by a process"
  if [ "$DOCKER_OK" != 1 ]; then preserve_hold "$p" "Docker mount snapshot failed (unknown)"; return; fi
  if docker_mount_inside "$p"; then descend="${descend:-holds the mount of a running container}"
  elif is_docker_mount "$p"; then log "KEEP $p: Docker mount ($DOCKER_PATH_REASON)"; return; fi
  if [ -z "$descend" ]; then
    bare_repository_scan "$p"; status=$?
    case "$status" in
      1) descend="holds a bare repository" ;;
      2) descend="repository scan failed (unknown)" ;;
    esac
  fi
  if [ -z "$descend" ] && ! lender_check "$p"; then descend="$SCRATCH_REASON"; fi
  if [ -z "$descend" ] && ! link_lender_check "$p"; then descend="$SCRATCH_REASON"; LINK_LENDERS+=("$p"); fi
  if [ -z "$descend" ]; then
    pp="$(cd -P -- "$p" 2>/dev/null && pwd -P)" || pp="$p"
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      case "$entry" in */.git) repo="${entry%/.git}" ;; *) descend="unreadable repository path"; break ;; esac
      if [ -L "$entry" ]; then descend="Git metadata has an unexpected type ($repo)"; break; fi
      if ! gitdir="$(rgit "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || [ ! -d "$gitdir" ]; then
        descend="history-unrecoverable: Git metadata is unreadable or missing ($repo)"; break
      fi
      if [ -f "$gitdir/locked" ]; then descend="Git worktree is locked ($repo)"; break; fi
      if ! git_head_idle "$repo"; then descend="recent or unverified Git HEAD activity ($repo)"; break; fi
      if [ -d "$repo/.git" ]; then
        for reg in "$gitdir"/worktrees/*/; do
          [ -d "$reg" ] || continue
          target="$(head -n 1 -- "${reg}gitdir" 2>/dev/null)" || { descend="linked worktree registration unreadable (${reg%/})"; break 2; }
          target="${target%/.git}"
          case "$target" in "$p"/*|"$pp"/*) ;; *) descend="hosts linked worktree ${target:-${reg%/}} outside the unit"; break 2 ;; esac
        done
      fi
      repos+=("$repo")
    done <<< "$entries"
  fi
  if [ -n "$descend" ]; then
    if [ "$is_repo" = 1 ]; then
      case "$descend" in
        written\ within*|held\ open*|recent\ or\ unverified*) log "KEEP $p: $descend" ;;
        *) preserve_hold "$p" "$descend" ;;
      esac
      return
    fi
    log "KEEP $p: folder of units kept ($descend); each child judged on its own"
    local child
    for child in "$p"/* "$p"/.[!.]* "$p"/..?*; do
      { [ -e "$child" ] || [ -L "$child" ]; } || continue
      preserve_unit "$child"
    done
    return
  fi
  for repo in ${repos[@]+"${repos[@]}"}; do
    if [ "$DRY_RUN" != 1 ] && ! preserve_root_has_room; then
      preserve_hold "$p" "preserve root $PRESERVE_ROOT is past its watched mark"; return
    fi
    if ! preserve_repo "$repo" "$p"; then preserve_hold "$p" "$PRESERVE_REASON ($repo)"; return; fi
    heads+=("$PRESERVED_HEAD"); ref_hashes+=("$PRESERVED_REFS_HASH"); copies="$copies${copies:+ }$PRESERVED_DIR"
  done
  if [ -n "$bundles" ]; then
    if [ "$DRY_RUN" != 1 ] && ! preserve_root_has_room; then
      preserve_hold "$p" "preserve root $PRESERVE_ROOT is past its watched mark"; return
    fi
    if ! preserve_bundles "$p" "$bundles"; then preserve_hold "$p" "$PRESERVE_REASON"; return; fi
    copies="$copies${copies:+ }$PRESERVED_DIR"
  fi
  bytes="$(du_bytes "$p")"
  if [ "$DRY_RUN" = 1 ]; then
    log "DRYRUN would: retire $p after preserving ${#repos[@]} repositories (${bytes:-unknown} bytes)"
    tally "preserve-retire ${p%/*}" "$bytes"
    return
  fi
  snapshot_open; snapshot_docker
  if ! is_worktree_idle "$p" || is_open "$p" || [ "$DOCKER_OK" != 1 ] || is_docker_mount "$p" || ! lender_check "$p" ||
     ! link_lender_check "$p"; then
    preserve_hold "$p" "changed or active before retire (copies kept: $copies)"; return
  fi
  i=0
  for repo in ${repos[@]+"${repos[@]}"}; do
    gitdir="$(rgit "$repo" rev-parse --absolute-git-dir 2>/dev/null)" || { preserve_hold "$p" "Git metadata changed before retire ($repo)"; return; }
    if [ -f "$gitdir/locked" ] || ! git_head_idle "$repo" || [ "$(rgit "$repo" rev-parse --verify HEAD 2>/dev/null)" != "${heads[$i]}" ]; then
      preserve_hold "$p" "HEAD moved or worktree locked before retire ($repo; copies kept: $copies)"; return
    fi
    if ! found="$(rgit "$repo" for-each-ref --format='%(objectname) %(refname)' 2>/dev/null | rgit "$repo" hash-object --stdin)" || [ "$found" != "${ref_hashes[$i]}" ]; then
      preserve_hold "$p" "Git refs moved or became unreadable before retire ($repo; copies kept: $copies)"; return
    fi
    i=$(( i + 1 ))
  done
  if ! audit_writable; then preserve_hold "$p" "audit log unwritable ($AUDIT_LOG)"; return; fi
  log "REMOVE $p: preserved then retired (${bytes:-unknown} bytes; copies: $copies)"
  # A linked worktree of a repository outside the unit (a live checkout's) leaves through its owner's Git.
  for repo in ${repos[@]+"${repos[@]}"}; do
    [ -f "$repo/.git" ] || continue
    gitdir="$(rgit "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || continue
    case "$gitdir" in "$p"/*|"$pp"/*) continue ;; esac
    if [ "${gitdir##*/}" = .git ] && rgit "${gitdir%/.git}" worktree remove --force -- "$repo" 2>/dev/null; then
      rgit "${gitdir%/.git}" worktree prune 2>/dev/null || true
    elif [ "${gitdir##*/}" = .git ] || ! rgit "$repo" worktree remove --force -- "$repo" 2>/dev/null; then
      preserve_hold "$p" "git worktree remove failed; no recursive filesystem fallback (copies kept: $copies)"; return
    fi
  done
  if [ -e "$p" ] && ! rm -rf -- "$p"; then preserve_hold "$p" "unit removal failed (copies kept: $copies)"; return; fi
  PRESERVE_RETIRED=$(( PRESERVE_RETIRED + 1 ))
  tally "preserve-retire ${p%/*}" "$bytes"
}
# A unit a symlink outside it points into (a linked-to node_modules) is a lender; links are never followed.
LINKS=""; LINKS_OK=1; LINK_LENDERS=(); LINKS_DENIED=""
snapshot_links() {
  local root link target out
  LINKS=""; LINKS_OK=1; LINKS_DENIED=""
  while IFS= read -r root; do
    root="${root%/}"
    [ -n "$root" ] && [ -d "$root" ] && [ ! -L "$root" ] || continue
    scan_find "$root" -xdev \( -name .git -o \( -name node_modules -type d \) \) -prune -o -type l -print || { LINKS_OK=0; return; }
    out="$SCAN_OUT"; LINKS_DENIED="$LINKS_DENIED$SCAN_DENIED"
    while IFS= read -r link; do
      [ -n "$link" ] || continue
      target="$(readlink -- "$link" 2>/dev/null)" || continue
      case "$target" in /*) ;; *) target="${link%/*}/$target" ;; esac
      LINKS="$LINKS$link	$(normalize_path "$target")
"
    done <<< "$out"
  done < <(printf '%s\n%s\n' "$PRESERVE_ROOTS" "$LIVE_CHECKOUTS" | tr ':' '\n' | awk 'NF && !seen[$0]++')
}
link_lender_check() {   # fails with SCRATCH_REASON when a live link outside unit $1 points into it
  local p="$1" pp link target borrowers=""
  if [ "$LINKS_OK" != 1 ]; then SCRATCH_REASON="symlink scan failed (unknown)"; return 1; fi
  if link="$(denied_inside "$LINKS_DENIED" "$p")"; then SCRATCH_REASON="symlink scan refused at $link (unknown)"; return 1; fi
  pp="$(cd -P -- "$p" 2>/dev/null && pwd -P)" || pp="$p"
  while IFS='	' read -r link target; do
    [ -n "$link" ] || continue
    case "$link" in "$p"/*|"$pp"/*) continue ;; esac
    case "$target" in "$p"|"$p"/*|"$pp"|"$pp"/*) [ -L "$link" ] && borrowers="$borrowers${borrowers:+, }$link" ;; esac
  done <<< "$LINKS"
  [ -z "$borrowers" ] || { SCRATCH_REASON="lends files to symlinks $borrowers"; return 1; }
}
ruling_remove_plain() {
  local c="$1" n="$2" status bytes seed_reason
  local IDLE_MINUTES="$SCRATCH_IDLE_MINUTES"
  if keep_marker "$c"; then preserve_hold "$c" "scratch keep marker"; return; fi
  if ! scan_find "$c" ! -user "$RUN_UID" -print -quit || [ -n "$SCAN_OUT$SCAN_DENIED" ]; then
    preserve_hold "$c" "foreign-owned or unreadable content"; return
  fi
  if seed_reason=$(rmd_dependency_seed_risk "$c"); then preserve_hold "$c" "$seed_reason"; return; fi
  is_worktree_idle "$c"; status=$?
  case "$status" in
    0) ;;
    1) log "KEEP $c: written within ${IDLE_MINUTES} min"; return ;;
    *) preserve_hold "$c" "activity probe failed (unknown)"; return ;;
  esac
  if is_open "$c"; then log "KEEP $c: held open by a process"; return; fi
  if [ "$DOCKER_OK" != 1 ] || is_docker_mount "$c"; then preserve_hold "$c" "Docker mount or snapshot failed ($DOCKER_PATH_REASON)"; return; fi
  bytes="$(du_bytes "$c")"
  log "REMOVE $c: idle scratch retired under the operator ruling of 2026-10-23"
  act rm -rf -- "$c" && tally "ruling $n" "$bytes"
}
ruling_retire() {
  local n c
  while IFS= read -r n; do
    n="${n%/}"
    [ -n "$n" ] && [ -d "$n" ] && [ ! -L "$n" ] || continue
    log "MARKER-RULING $n: operator 2026-10-23: retire idle operator/wt-* worktrees and top-level tmp, tmp-*, t3.*; keep everything else (an active operator session whose plan records holds)"
    for c in "$n"/operator/wt-* "$n"/tmp "$n"/tmp-* "$n"/t3.*; do
      [ -d "$c" ] && [ ! -L "$c" ] || continue
      RULING_CHILD="$c"
      if scan_find "$c" -name node_modules -prune -o \( -name .git -o -name '*.bundle' \) -print -quit && [ -z "$SCAN_OUT" ]; then
        ruling_remove_plain "$c" "$n"
      else
        preserve_unit "$c"
      fi
      RULING_CHILD=""
    done
  done < <(printf '%s\n' "$RULING_NAMESPACES" | tr ':' '\n' | awk 'NF && !seen[$0]++')
}
preserve_then_retire() {
  local root unit retired_before lender
  [ -n "$PRESERVE_ROOTS" ] || return 0
  if [ -L "$PRESERVE_ROOT" ]; then log "REFUSE preserve-then-retire: $PRESERVE_ROOT is a symbolic link"; return; fi
  if [ "$OPEN_OK" != 1 ]; then log "REFUSE preserve-then-retire: $OPEN_FAILURE — keeping everything (fail closed)"; return; fi
  if [ "$DRY_RUN" != 1 ]; then
    if ! mkdir -p -- "$PRESERVE_ROOT" 2>/dev/null || ! chmod 700 "$PRESERVE_ROOT" 2>/dev/null; then
      log "REFUSE preserve-then-retire: cannot create $PRESERVE_ROOT"; return
    fi
    preserve_root_mark
  fi
  log "rmd-host-cleanup: preserve-then-retire over ${PRESERVE_ROOTS} into $PRESERVE_ROOT (copies expire after $RETAIN_DAYS days)"
  snapshot_links
  retired_before="$PRESERVE_RETIRED"
  while IFS= read -r root; do
    root="${root%/}"
    [ -n "$root" ] && [ -d "$root" ] && [ ! -L "$root" ] || continue
    for unit in "$root"/* "$root"/.[!.]* "$root"/..?*; do
      { [ -e "$unit" ] || [ -L "$unit" ]; } || continue
      preserve_unit "$unit"
    done
  done < <(printf '%s\n' "$PRESERVE_ROOTS" | tr ':' '\n' | awk 'NF && !seen[$0]++')
  ruling_retire
  while [ "${#LINK_LENDERS[@]}" -gt 0 ] && [ "$PRESERVE_RETIRED" != "$retired_before" ]; do
    retired_before="$PRESERVE_RETIRED"
    set -- "${LINK_LENDERS[@]}"; LINK_LENDERS=()
    for lender in "$@"; do
      if ruling_namespace "$lender"; then RULING_CHILD="$lender"; fi
      preserve_unit "$lender"; RULING_CHILD=""
    done
  done
  log "rmd-host-cleanup: preserve-then-retire retired $PRESERVE_RETIRED units, held $PRESERVE_HELD"
}

# ── dump housekeeping (the Mac rule, JANITOR.md). A resumable root (Codex sessions) is compressed to
# `.zst`, which Codex resumes (it cannot resume `.gz`), and is never deleted from.
DUMP_COMPRESSED=0; DUMP_EXPIRED=0
dump_in_repo() {   # true when an ancestor of file $1, up to root $2, is a repository
  local d="${1%/*}" stop="$2"
  while :; do
    if [ -e "$d/.git" ] || { [ -f "$d/HEAD" ] && [ -d "$d/objects" ] && [ -d "$d/refs" ]; }; then return 0; fi
    [ "$d" = "$stop" ] && return 1
    case "$d" in "$stop"/*) d="${d%/*}" ;; *) return 0 ;; esac
  done
}
file_sig() { stat -c '%s %Y' -- "$1" 2>/dev/null || stat -f '%z %m' -- "$1" 2>/dev/null; }
dump_pack() { if [ "$1" = zst ]; then zstd -q -3 -c -- "$2"; else gzip -6 -c -- "$2"; fi; }
dump_unpack() { if [ "$1" = zst ]; then zstd -q -dc -- "$2"; else gzip -dc -- "$2"; fi; }
compress_dump() {   # compress_dump <file> <root> <gz|zst>
  local f="$1" root="$2" ext="$3" tmp="$1.$3.incoming" before after mode orig packed tool=gzip
  [ "$ext" = zst ] && tool=zstd
  if [ -e "$tmp" ] || [ -L "$tmp" ] || [ -e "$f.gz" ] || [ -L "$f.gz" ] || [ -e "$f.zst" ] || [ -L "$f.zst" ]; then
    log "KEEP $f: a compressed copy is already beside it"; return
  fi
  if ! command -v "$tool" >/dev/null 2>&1; then log "KEEP $f: $tool unavailable"; return; fi
  orig="$(wc -c < "$f" | tr -d ' ')"
  if [ "$DRY_RUN" = 1 ]; then
    log "DRYRUN would: $tool $f (${orig} bytes; idle dump)"; tally "dumps-$tool $root" "$orig"; return
  fi
  before="$(file_sig "$f")" || { log "KEEP $f: stat failed (unknown)"; return; }
  if ! dump_pack "$ext" "$f" > "$tmp" 2>/dev/null </dev/null || ! dump_unpack "$ext" "$tmp" 2>/dev/null </dev/null | cmp -s - "$f"; then
    rm -f -- "$tmp"; log "KEEP $f: compression read-back failed"; return
  fi
  after="$(file_sig "$f")"
  if [ "$before" != "$after" ]; then rm -f -- "$tmp"; log "KEEP $f: changed while compressing"; return; fi
  mode="$(stat -c %a -- "$f" 2>/dev/null || stat -f %Lp -- "$f" 2>/dev/null)" && chmod "$mode" "$tmp" 2>/dev/null
  if ! touch -r "$f" -- "$tmp" 2>/dev/null || ! audit_writable || ! mv -n -- "$tmp" "$f.$ext" 2>/dev/null || [ -e "$tmp" ]; then
    rm -f -- "$tmp"; log "KEEP $f: could not place $f.$ext"; return
  fi
  packed="$(wc -c < "$f.$ext" | tr -d ' ')"
  log "PRUNE $f: $(( orig - packed )) bytes, compressed beside itself as $f.$ext after a full read-back"
  { mkdir -p -- "$(dirname -- "$DUMP_RECEIPT")" && printf '%s\t%s\n' "$f.$ext" "$packed" >> "$DUMP_RECEIPT"; } 2>/dev/null ||
    log "KEEP $f.$ext: compression receipt unwritable; this copy will not expire"
  if rm -f -- "$f"; then DUMP_COMPRESSED=$(( DUMP_COMPRESSED + 1 )); tally "dumps-$tool $root" "$(( orig - packed ))"; fi
}
# A dump is a file of at least DUMP_MIN_MB, never inside a repository or an installed package/toolchain tree.
dump_excluded() {   # dump_excluded <file> <root>
  local d="${1%/*}" stop="$2" x
  while :; do
    if [ -e "$d/.git" ] || [ -e "$d/pyvenv.cfg" ] || { [ -f "$d/HEAD" ] && [ -d "$d/objects" ] && [ -d "$d/refs" ]; }; then return 0; fi
    case "${d##*/}" in docker|containerd|node_modules|site-packages|dist-packages|*.dist-info|*.egg-info|.cargo|.rustup|.venv|venv) return 0 ;; esac
    case "$d/" in */lib/python[0-9]*/*|*/pkg/mod/*) return 0 ;; esac
    for x in "$d"/lib/python[0-9]*; do [ -d "$x" ] && return 0; done
    [ "$d" = "$stop" ] && return 1
    case "$d" in "$stop"/*) d="${d%/*}" ;; *) return 0 ;; esac
  done
}
DUMP_RECEIPT="${RMD_CLEANUP_DUMP_RECEIPT:-$CLEAN_HOME/.local/state/remudero/janitor-compressed.tsv}"
dump_receipted() { [ -f "$DUMP_RECEIPT" ] && grep -qxF -- "$1$(printf '\t')$(wc -c < "$1" | tr -d ' ')" "$DUMP_RECEIPT" 2>/dev/null; }
dump_walk() {   # dump_walk <root> <unit> <resumable 0|1>
  local root="$1" unit="$2" only="$3" f bytes idle_m="$IDLE_MINUTES" keep_m=$(( DUMP_RETAIN_DAYS * 1440 ))
  local min_c=$(( DUMP_MIN_MB * 1048576 - 1 ))
  local -a plain=(-name "*.json") packed=(-name "*.json.gz" -o -name "*.json.zst")
  local -a prune=(\( -name docker -o -name containerd -o -name node_modules -o -name .git -o -name site-packages -o -name dist-packages -o -name .venv -o -name venv
                     -o -name '*.dist-info' -o -name '*.egg-info' -o -name .cargo -o -name .rustup -o -path '*/lib/python[0-9]*'
                     -o -path '*/pkg/mod' \) -prune)
  local s
  for s in jsonl ndjson log lcov info; do
    plain+=(-o -name "*.$s"); packed+=(-o -name "*.$s.gz" -o -name "*.$s.zst")
  done
  if [ "$only" != 1 ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ -f "$f" ] && [ ! -L "$f" ] || continue
      keep_container_path "$f" && continue
      dump_excluded "$f" "$root" && continue
      [ "$(owner_uid "$f")" = "$RUN_UID" ] || continue
      case "$f" in *.gz|*.zst) dump_receipted "$f" || continue ;; esac
      if is_open "$f"; then log "KEEP $f: held open by a process"; continue; fi
      bytes="$(du_bytes "$f")"
      log "REMOVE $f: dump unchanged ${DUMP_RETAIN_DAYS} days"
      if act rm -f -- "$f"; then DUMP_EXPIRED=$(( DUMP_EXPIRED + 1 )); tally "dumps-expire $root" "$bytes"; fi
    done < <($FIND_CMD "$unit" -xdev "${prune[@]}" -o -type f \( \( \( "${plain[@]}" \) -size "+${min_c}c" \) -o \( "${packed[@]}" \) \) \
               ! -mmin "-$idle_m" ! -cmin "-$idle_m" -mmin "+$keep_m" -print 2>/dev/null)
  fi
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$f" ] && [ ! -L "$f" ] || continue
    keep_container_path "$f" && continue
    dump_excluded "$f" "$root" && continue
    [ "$(owner_uid "$f")" = "$RUN_UID" ] || continue
    if is_open "$f"; then log "KEEP $f: held open by a process"; continue; fi
    if [ "$only" = 1 ]; then compress_dump "$f" "$root" zst; else compress_dump "$f" "$root" gz; fi
  done < <($FIND_CMD "$unit" -xdev "${prune[@]}" -o -type f \( "${plain[@]}" \) \
             ! -mmin "-$idle_m" ! -cmin "-$idle_m" -size "+${min_c}c" -print 2>/dev/null)
}
dump_housekeeping() {
  local root unit
  [ -n "$DUMP_ROOTS$DUMP_RESUMABLE_ROOTS" ] || return 0
  if [ "$OPEN_OK" != 1 ]; then log "REFUSE dump housekeeping: $OPEN_FAILURE — keeping everything (fail closed)"; return; fi
  while IFS= read -r root; do
    root="${root%/}"
    [ -n "$root" ] && [ -d "$root" ] && [ ! -L "$root" ] || continue
    for unit in "$root"/* "$root"/.[!.]* "$root"/..?*; do
      { [ -e "$unit" ] && [ ! -L "$unit" ]; } || continue
      preserve_skip "$unit" && continue
      [ "$(owner_uid "$unit")" = "$RUN_UID" ] || continue
      ! keep_marker "$unit" || continue
      is_protected_worktree "$unit" && continue
      dump_walk "$root" "$unit" 0
    done
  done < <(printf '%s\n' "$DUMP_ROOTS" | tr ':' '\n' | awk 'NF && !seen[$0]++')
  while IFS= read -r root; do
    root="${root%/}"
    [ -n "$root" ] && [ -d "$root" ] && [ ! -L "$root" ] || continue
    [ "$(owner_uid "$root")" = "$RUN_UID" ] || { log "KEEP $root: resumable dump root is not the pass identity's own"; continue; }
    dump_walk "$root" "$root" 1
  done < <(printf '%s\n' "$DUMP_RESUMABLE_ROOTS" | tr ':' '\n' | awk 'NF && !seen[$0]++')
  log "rmd-host-cleanup: dump housekeeping compressed $DUMP_COMPRESSED and expired $DUMP_EXPIRED dumps"
}

# ── retention (ruling 2026-10-23): each top-level file, or entry inside a top-level folder, of an
# archive root expires once unchanged (mtime and ctime) for RETAIN_DAYS; roots reaching live data are refused.
retain_root_ok() {
  local r="$1" c cs
  case "$r" in /*) ;; *) RETAIN_REASON="not an absolute path"; return 1 ;; esac
  [ "$r" != / ] || { RETAIN_REASON="is /"; return 1; }
  case "$r/" in */host-cleanup-validation-bundles-*) RETAIN_REASON="a live validation-bundles tree"; return 1 ;; esac
  if [ -L "$r" ] || [ ! -d "$r" ]; then RETAIN_REASON="not a regular directory"; return 1; fi
  for c in "$STATE_DISK" "$SCRATCH_DISK" "$CLEAN_HOME" "$ROOT_FS" /tmp "$PRESERVE_ROOTS"; do
    while IFS= read -r cs; do
      [ -n "$cs" ] || continue
      cs="${cs%/}/"
      case "$cs" in "$r/"|"$r/"*) RETAIN_REASON="contains $cs"; return 1 ;; esac
    done < <(printf '%s\n' "$c" | tr ':' '\n')
  done
}
expire_entry() {   # expire_entry <entry> <days> <tally key> <why>
  local e="$1" days="$2" key="$3" why="$4" m recent bytes
  keep_container_path "$e" && return
  [ -e "$e" ] && [ ! -L "$e" ] || return 0
  case "${e##*/}" in host-cleanup-validation-bundles-*) return 0 ;; esac
  m=$(( days * 1440 ))
  if ! recent="$($FIND_CMD "$e" \( -mmin "-$m" -o -cmin "-$m" \) -print -quit 2>/dev/null)"; then
    log "KEEP $e: age probe failed (unknown)"; return 0
  fi
  [ -z "$recent" ] || return 0
  if is_open "$e"; then log "KEEP $e: held open by a process"; return 0; fi
  bytes="$(du_bytes "$e")"
  log "REMOVE $e: $why"
  if act rm -rf -- "$e"; then tally "$key" "$bytes"; else log "KEEP $e: removal failed"; fi
}
expire_dated_root() {
  local root="${1%/}" e c RETAIN_REASON="" why="archived copy unchanged ${RETAIN_DAYS} days (operator ruling 2026-10-23)"
  [ -e "$root" ] || return 0
  if ! retain_root_ok "$root"; then log "REFUSE retention $root: $RETAIN_REASON"; return; fi
  for e in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [ -e "$e" ] && [ ! -L "$e" ] || continue
    case "${e##*/}" in host-cleanup-validation-bundles-*) continue ;; esac
    keep_container_path "$e" && continue
    if [ -d "$e" ]; then
      if [ "$RUN_UID" != 0 ] && [ ! -w "$e" ]; then log "KEEP $e: its expired entries are the root pass's (folder not writable by uid $RUN_UID)"; continue; fi
      for c in "$e"/* "$e"/.[!.]* "$e"/..?*; do
        [ -e "$c" ] && [ ! -L "$c" ] || continue
        expire_entry "$c" "$RETAIN_DAYS" "retention $root" "$why"
      done
      if [ -r "$e" ] && [ -z "$(ls -A -- "$e" 2>/dev/null)" ] && is_idle "$e"; then
        log "REMOVE $e: emptied archive folder"; act rmdir -- "$e"
      fi
    else
      if [ "$RUN_UID" != 0 ] && [ ! -w "$root" ]; then log "KEEP $e: expired entries here are the root pass's"; continue; fi
      expire_entry "$e" "$RETAIN_DAYS" "retention $root" "$why"
    fi
  done
}
expire_preserved_copies() {
  local e
  [ -d "$PRESERVE_ROOT" ] && [ ! -L "$PRESERVE_ROOT" ] || return 0
  for e in "$PRESERVE_ROOT"/*@[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z "$PRESERVE_ROOT"/.incoming-*; do
    [ -d "$e" ] && [ ! -L "$e" ] || continue
    keep_container_path "$e" && continue
    [ "$(owner_uid "$e")" = "$RUN_UID" ] || continue   # only copies this identity made
    case "${e##*/}" in
      .incoming-*)   # an interrupted copy never counted as one; it goes once idle
        if is_idle "$e" && ! is_open "$e"; then log "REMOVE $e: interrupted preservation"; act rm -rf -- "$e"; fi ;;
      *) expire_entry "$e" "$RETAIN_DAYS" "retention $PRESERVE_ROOT" "preserved copy older than ${RETAIN_DAYS} days (operator ruling 2026-10-23)" ;;
    esac
  done
}
retention() {
  local root
  while IFS= read -r root; do
    [ -n "$root" ] && expire_dated_root "$root"
  done < <(printf '%s\n' "$RETAIN_ROOTS" | tr ':' '\n' | awk 'NF && !seen[$0]++')
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

# The tightest watched filesystem picks the tier: TIER_HEADROOM points below its mark (0 when it is
# past its minimum free space), TIER_WHY saying which one. No readable filesystem is the floor.
# RMD_CLEANUP_ROOT_FS reuses the pass's own "before" reading rather than asking df again.
TIER_HEADROOM=""; TIER_WHY="no watched filesystem readable"
for i in "${!W_PATH[@]}"; do
  [ -e "${W_PATH[$i]}" ] || continue
  if [ "${W_PATH[$i]}" = "$ROOT_FS" ]; then
    t_pct="$before_pct"; t_avail="$before_avail"
  else
    t_row="$($DF_CMD "${W_PATH[$i]}" 2>/dev/null | awk 'NR==2 { gsub("%","",$5); print $5, $4 }')"
    t_pct=""; t_avail=""; read -r t_pct t_avail <<<"$t_row"
  fi
  case "${t_pct:-x}${t_avail:-x}" in *[!0-9]*) continue ;; esac
  t_head=$(( W_PCT[i] - 10#$t_pct ))
  if [ "$(( 10#$t_avail ))" -lt "${W_FREE_KB[$i]}" ] && [ "$t_head" -gt 0 ]; then t_head=0; fi
  if [ -z "$TIER_HEADROOM" ] || [ "$t_head" -lt "$TIER_HEADROOM" ]; then
    TIER_HEADROOM="$t_head"
    TIER_WHY="${W_PATH[$i]} ${t_pct}% used, mark $(printf '%s%%' "${W_PCT[$i]}")${W_FREE_TXT[$i]:+/${W_FREE_TXT[$i]}}"
  fi
done
TIER_MINUTES="$(retention_window "${TIER_HEADROOM:-0}")"

# pin_window <name> <shown value> <minutes> — sets PINNED to a pinned window, raised to the floor
# (and logged as CLAMP) when it is under it.
pin_window() {
  PINNED=$(( 10#$3 ))
  if [ "$PINNED" -lt "$FLOOR_MINUTES" ]; then
    log "CLAMP $1=$2: under the six-hour floor; using $(fmt_minutes "$FLOOR_MINUTES")"
    PINNED="$FLOOR_MINUTES"
  fi
}
if [ -n "$IDLE_MINUTES" ]; then
  pin_window IDLE_MINUTES "$IDLE_MINUTES min" "$IDLE_MINUTES"; IDLE_MINUTES="$PINNED"; IDLE_SOURCE="pinned by IDLE_MINUTES"
else
  IDLE_MINUTES="$TIER_MINUTES"; IDLE_SOURCE="tiered: tightest is $TIER_WHY"
fi
if [ -n "$SCRATCH_IDLE_MINUTES" ]; then
  pin_window RMD_CLEANUP_SCRATCH_IDLE_MINUTES "$SCRATCH_IDLE_MINUTES min" "$SCRATCH_IDLE_MINUTES"; SCRATCH_IDLE_MINUTES="$PINNED"
else
  SCRATCH_IDLE_MINUTES="$IDLE_MINUTES"
fi
if [ -n "$TSX_MAX_AGE_HOURS" ]; then
  pin_window RMD_CLEANUP_TSX_MAX_AGE_HOURS "$TSX_MAX_AGE_HOURS h" "$(( 10#$TSX_MAX_AGE_HOURS * 60 ))"; TSX_MAX_AGE_MINUTES="$PINNED"
else
  TSX_MAX_AGE_MINUTES="$IDLE_MINUTES"
fi
log "rmd-host-cleanup: retention idle $(fmt_minutes "$IDLE_MINUTES"), scratch $(fmt_minutes "$SCRATCH_IDLE_MINUTES"), tsx $(fmt_minutes "$TSX_MAX_AGE_MINUTES") ($IDLE_SOURCE)"

snapshot_open
[ "$OPEN_OK" = 1 ] || log "REFUSE sweeps: $OPEN_FAILURE — keeping everything (fail closed)"

snapshot_docker
snapshot_alternates
while IFS= read -r root; do
  [ -n "$root" ] && sweep_scratch_root "$root"
done < <(printf '%s\n' "$SCRATCH_ROOTS" | tr ':' '\n')
while IFS= read -r parent; do
  [ -n "$parent" ] && [ -d "$parent" ] || continue
  parent="${parent%/}"
  keep_parent "$parent"
  if keep_marker "$parent" || [ -L "$parent" ]; then
    log "KEEP $parent: scratch keep marker or symbolic link"; continue
  fi
  sweep_scratch_root "$parent"
done < <(printf '%s\n' "$SCRATCH_PARENTS" | tr ':' '\n')
while IFS= read -r parent; do
  [ -n "$parent" ] && sweep_state_parent "$parent"
done < <(printf '%s\n' "$STATE_PARENTS" | tr ':' '\n')

for root in $(printf '%s' "$TMP_ROOTS" | tr ':' ' '); do
  [ -d "$root" ] || continue
  for g in $TMP_GLOBS; do
    for p in "$root"/$g; do [ -e "$p" ] && sweep_path "$p"; done
  done
  for p in "$root"/tsx-*; do
    { [ -e "$p" ] || [ -L "$p" ]; } && prune_tsx_cache "$p"
  done
  # big idle scratch files that sit inside a root rather than directly under it
  while IFS= read -r f; do
    [ -e "$f" ] && sweep_path "$f"
  done < <(find "$root" -maxdepth 3 -type f -size "+${BIG_MB}M" 2>/dev/null)
done

while IFS= read -r root; do
  [ -n "$root" ] && sweep_nested_coverage "$root"
done < <(printf '%s\n' "$NESTED_COVERAGE_ROOTS" | tr ':' '\n')

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

  while IFS= read -r checkout; do
    [ -n "$checkout" ] && sweep_live_checkout "$checkout"
  done < <(printf '%s\n' "$LIVE_CHECKOUTS" | tr ':' '\n')

  preserve_then_retire
  dump_housekeeping

  check_archive_root
  if [ "$ARCHIVE_OK" = 1 ]; then
    for f in "$CLEAN_HOME"/*/.claude/projects/*/*.jsonl; do
      [ -f "$f" ] && archive_transcript "$f"
    done
    if [ -d "$ARCHIVE_ROOT" ] && [ ! -L "$ARCHIVE_ROOT" ]; then
      while IFS= read -r old; do
        [ -n "$old" ] || continue
        keep_container_path "$old" && continue
        bytes="$(du_bytes "$old")"
        log "REMOVE $old: archive older than ${ARCHIVE_DAYS} days"
        act rm -f -- "$old" && tally "archive-expire $ARCHIVE_ROOT" "$bytes"
      done < <(find "$ARCHIVE_ROOT" -type f -mtime "+$ARCHIVE_DAYS" 2>/dev/null)
      if [ -n "$(find "$ARCHIVE_ROOT" -mindepth 1 -type d -empty -mmin "+$IDLE_MINUTES" -print -quit 2>/dev/null)" ]; then
        log "REMOVE $ARCHIVE_ROOT/*: empty transcript folders idle $(fmt_minutes "$IDLE_MINUTES")"
        act find "$ARCHIVE_ROOT" -mindepth 1 -depth -type d -empty -mmin "+$IDLE_MINUTES" -delete
      fi
    fi
  fi
  expire_preserved_copies

  for wr in $WATCH_ROOTS; do
    [ -d "$wr" ] || continue
    find "$wr" -maxdepth 3 -type f -size "+${WATCH_MB}M" 2>/dev/null | while IFS= read -r f; do
      log "WATCH: $f is over ${WATCH_MB} MB"
    done
  done
else
  log "rmd-host-cleanup: temporary-roots-only mode"
fi
retention

if [ "$PRUNED_COUNT" -gt 0 ]; then
  log "rmd-host-cleanup: pruned $PRUNED_COUNT regenerable trees from kept scratch units ($PRUNED_BYTES bytes)"
fi
if [ "$TSX_PRUNED_COUNT" -gt 0 ]; then
  log "rmd-host-cleanup: pruned $TSX_PRUNED_COUNT stale tsx cache files ($TSX_PRUNED_BYTES bytes)"
fi
after_pct="$(df_field pct)"; after_avail="$(df_field avail)"
reclaimed=""
case "${before_pct:-x}${before_avail:-x}${after_pct:-x}${after_avail:-x}" in
  *[!0-9]*) ;;
  *) reclaimed=" ($(( (10#$after_avail - 10#$before_avail) / 1024 )) MB reclaimed this pass)" ;;
esac
case "$before_pct" in ""|*[!0-9]*) before_pct=unknown ;; *) before_pct="${before_pct}%" ;; esac
case "$after_pct" in ""|*[!0-9]*) after_pct=unknown ;; *) after_pct="${after_pct}%" ;; esac
log "rmd-host-cleanup: / ${before_pct} -> ${after_pct}${reclaimed}"
[ "$DRY_RUN" = 1 ] && log "rmd-host-cleanup: DRY_RUN=1 — nothing was changed"

print_tallies
rmd_decision_summary "$DECISION_LOG"
if [ "$DRY_RUN" = 1 ]; then log "rmd-host-cleanup: decision-report none (a dry run writes no receipt)"
else log "rmd-host-cleanup: decision-report $DECISION_LOG"; fi
judge_filesystems
[ "$FS_FAILED" = 0 ] || exit 1
exit 0
