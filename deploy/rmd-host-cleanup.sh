#!/usr/bin/env bash
# rmd-host-cleanup — the Azure host's ROOT-DISK janitor (W1-T4770).
#
# WHY IT EXISTS. `deploy/host-update.sh --reclaim-only` prunes Docker on /mnt/rmd and freed 0 B on /
# for weeks while logging success; root reached 99% and ENOSPC'd a `docker exec`. This script sweeps
# what actually fills /: temp scratch roots, finished agent worktrees under ~/*/.claude/worktrees,
# big idle scratch files, and agent transcripts (ARCHIVED to /mnt/rmd, never deleted).

# !! PROVENANCE — READ BEFORE `install-host-units.sh --install` !!
# This file was written from the task record's account of the host's script (W1-T4770 rationale),
# NOT copied byte-for-byte from the host: the host copy was not reachable when this was authored.
# The five safety rules below are implemented as stated there. Every default marked [UNVERIFIED]
# is an assumption that an operator must reconcile with `ssh remudero cat ~/rmd-host-cleanup.sh`
# (diff it against this file) before installing, or the installer will replace the operator's
# chosen values. The installer saves the file it replaces as <path>.pre-t4770 for that reason.

# THE SAFETY RULES (each is pinned by test/host-root-disk-janitor.test.ts)
#   1. idle      — nothing under a path written within IDLE_MINUTES is touched (is_idle)
#   2. not open  — no process holds the path (is_open, ONE `lsof -Fn` snapshot per pass)
#   3. worktrees — removed only when CLEAN (`git status --porcelain` empty) AND SAVED: HEAD is on a
#                  remote branch, or its run-<id>-<digits> branch's task has a `Remudero-Task: <id>`
#                  commit on origin/main
#   4. archive   — transcripts are moved, never deleted; refused when the archive root shares a
#                  filesystem with /; only the archive itself ages out, after ARCHIVE_DAYS
#   5. DRY_RUN=1 changes nothing; a pass that leaves / at or above HIGH_WATER exits non-zero

# Every decision is logged: `KEEP <path>: <reason>` / `REMOVE <path>` / `ARCHIVE <path>` /
# `REFUSE <what>: <reason>`, then a summary `rmd-host-cleanup: / 57% -> 57% (-4 MB reclaimed this
# pass)` that scripts/fleet-heartbeat.sh-style readers parse.

# CRON. The schedule and log path live in ONE place: deploy/install-host-units.sh
# (CLEANUP_CRON_SCHEDULE / RMD_CLEANUP_LOG). Nothing here schedules itself.

# OVERRIDES. Thresholds: IDLE_MINUTES HIGH_WATER ARCHIVE_DAYS DRY_RUN. Roots and probes, so a test
# drives a fixture tree instead of the real /tmp and /mnt/rmd, on Linux or macOS:
#   RMD_CLEANUP_HOME            the home whose ~/*/.claude/{worktrees,projects} are swept
#   RMD_CLEANUP_TMP_ROOTS       colon-separated scratch roots
#   RMD_CLEANUP_TMP_GLOBS       space-separated basename globs swept directly under those roots
#   RMD_CLEANUP_BIG_MB          size (MB) at which an idle file under a scratch root is swept
#   RMD_CLEANUP_ARCHIVE_ROOT    where transcripts go
#   RMD_CLEANUP_ROOT_FS         the filesystem being protected (default /)
#   RMD_CLEANUP_DF              command printing `df -Pk`-shaped output for the root filesystem
#   RMD_CLEANUP_FSID            command taking a path and printing its filesystem id
#   RMD_CLEANUP_LSOF            the lsof command (must accept -Fn and print n<path> lines)
#   RMD_CLEANUP_CONTAINER_MAP   host_prefix:container_prefix — a held container-side name also counts
#   RMD_CLEANUP_NO_FETCH=1      do not `git fetch` before judging a worktree saved
#   RMD_CLEANUP_WATCH_ROOTS     roots scanned for WATCH: lines (files >= WATCH_MB, never removed)
set -uo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-720}"      # 12 h, as stated by the operator
HIGH_WATER="${HIGH_WATER:-85}"           # [UNVERIFIED] percent of / at which a pass fails
ARCHIVE_DAYS="${ARCHIVE_DAYS:-30}"       # [UNVERIFIED] archive retention
DRY_RUN="${DRY_RUN:-0}"

CLEAN_HOME="${RMD_CLEANUP_HOME:-${HOME:-/}}"
TMP_ROOTS="${RMD_CLEANUP_TMP_ROOTS-/tmp}"                                # [UNVERIFIED]
TMP_GLOBS="${RMD_CLEANUP_TMP_GLOBS-claude-* rmd-* remudero-* tmp.*}"     # [UNVERIFIED]
BIG_MB="${RMD_CLEANUP_BIG_MB:-200}"                                      # [UNVERIFIED]
ARCHIVE_ROOT="${RMD_CLEANUP_ARCHIVE_ROOT:-/mnt/rmd/host-cleanup-archive}" # [UNVERIFIED]
ROOT_FS="${RMD_CLEANUP_ROOT_FS:-/}"
DF_CMD="${RMD_CLEANUP_DF:-df -Pk $ROOT_FS}"
FSID_CMD="${RMD_CLEANUP_FSID:-}"
LSOF_CMD="${RMD_CLEANUP_LSOF:-lsof}"
CONTAINER_MAP="${RMD_CLEANUP_CONTAINER_MAP:-}"
WATCH_ROOTS="${RMD_CLEANUP_WATCH_ROOTS-$CLEAN_HOME/.codex $CLEAN_HOME/.claude}"
WATCH_MB="${RMD_CLEANUP_WATCH_MB:-500}"

case "$IDLE_MINUTES$HIGH_WATER$ARCHIVE_DAYS$BIG_MB" in
  ""|*[!0-9]*) echo "rmd-host-cleanup: FATAL thresholds must be non-negative integers" >&2; exit 2 ;;
esac

log() { printf '%s\n' "$*"; }

# Every mutation goes through here, so DRY_RUN=1 has exactly one place to hold.
act() {
  if [ "$DRY_RUN" = 1 ]; then log "DRYRUN would: $*"; return 0; fi
  "$@"
}

# root_pct / root_avail_kb from one df snapshot.
df_field() { $DF_CMD 2>/dev/null | awk -v f="$1" 'NR==2 { gsub("%","",$5); print (f=="pct" ? $5 : $4) }'; }

# ── rule 1 ──
is_idle() {
  [ -e "$1" ] || return 1
  [ -z "$(find "$1" -mmin "-$IDLE_MINUTES" -print -quit 2>/dev/null)" ]
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

# One decision per path: keep-with-reason, or remove.
sweep_path() {
  local p="$1"
  if ! is_idle "$p"; then log "KEEP $p: written within ${IDLE_MINUTES} min"; return; fi
  if is_open "$p"; then log "KEEP $p: held open by a process"; return; fi
  log "REMOVE $p"
  act rm -rf -- "$p"
}

# ── rule 3 ──
worktree_dirty() { [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; }
worktree_saved() {
  local wt="$1" head br id
  head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || return 1
  [ -n "$(git -C "$wt" branch -r --contains "$head" 2>/dev/null)" ] && return 0
  br="$(git -C "$wt" symbolic-ref --short -q HEAD 2>/dev/null)" || return 1
  case "$br" in
    run-*-[0-9]*)
      id="${br#run-}"; id="${id%-*}"
      case "$id" in ""|*[!A-Za-z0-9._-]*) return 1 ;; esac
      git -C "$wt" log origin/main --fixed-strings --grep="Remudero-Task: $id" -n 1 --format=%H 2>/dev/null | grep -q . && return 0
      ;;
  esac
  return 1
}
sweep_worktree() {
  local wt="$1"
  [ -e "$wt/.git" ] || { log "KEEP $wt: not a git worktree"; return; }
  if ! is_idle "$wt"; then log "KEEP $wt: written within ${IDLE_MINUTES} min"; return; fi
  if is_open "$wt"; then log "KEEP $wt: held open by a process"; return; fi
  if worktree_dirty "$wt"; then log "KEEP $wt: uncommitted changes"; return; fi
  if [ "$DRY_RUN" != 1 ] && [ "${RMD_CLEANUP_NO_FETCH:-0}" != 1 ]; then
    git -C "$wt" fetch --quiet origin 2>/dev/null || true
  fi
  if ! worktree_saved "$wt"; then log "KEEP $wt: HEAD not on a remote branch and its task is not on origin/main"; return; fi
  log "REMOVE $wt"
  if [ "$DRY_RUN" = 1 ]; then log "DRYRUN would: git worktree remove $wt"; return; fi
  git -C "$wt" worktree remove "$wt" 2>/dev/null || rm -rf -- "$wt"
}

# ── rule 4 ──
fs_id() {
  if [ -n "$FSID_CMD" ]; then $FSID_CMD "$1"
  else stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null; fi
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
  local f="$1" rel dest
  if ! is_idle "$f"; then log "KEEP $f: written within ${IDLE_MINUTES} min"; return; fi
  if is_open "$f"; then log "KEEP $f: held open by a process"; return; fi
  rel="${f#"$CLEAN_HOME"/}"; dest="$ARCHIVE_ROOT/$rel"
  log "ARCHIVE $f -> $dest"
  if [ "$DRY_RUN" = 1 ]; then log "DRYRUN would: move $f to $dest"; return; fi
  mkdir -p "$(dirname "$dest")" && cp -p -- "$f" "$dest" && rm -f -- "$f"
}

# ── the pass ──
before_pct="$(df_field pct)"; before_avail="$(df_field avail)"
before_pct="${before_pct:-0}"; before_avail="${before_avail:-0}"
snapshot_open
[ "$OPEN_OK" = 1 ] || log "REFUSE sweeps: lsof failed — keeping everything (fail closed)"

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

for wt in "$CLEAN_HOME"/*/.claude/worktrees/*; do
  [ -d "$wt" ] && sweep_worktree "$wt"
done

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

after_pct="$(df_field pct)"; after_avail="$(df_field avail)"
after_pct="${after_pct:-0}"; after_avail="${after_avail:-0}"
log "rmd-host-cleanup: / ${before_pct}% -> ${after_pct}% ($(( (after_avail - before_avail) / 1024 )) MB reclaimed this pass)"
[ "$DRY_RUN" = 1 ] && log "rmd-host-cleanup: DRY_RUN=1 — nothing was changed"

if [ "$after_pct" -ge "$HIGH_WATER" ]; then
  log "rmd-host-cleanup: FAIL / is at ${after_pct}%, at or above HIGH_WATER=${HIGH_WATER}%"
  exit 1
fi
exit 0
