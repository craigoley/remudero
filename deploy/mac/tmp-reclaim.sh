#!/bin/bash
# deploy/mac/tmp-reclaim.sh — reclaim session scratch from /private/tmp on the operator Mac.
#
# WHY: on 2026-09-23 the Mac filled to 0 bytes free. 33 GB of /private/tmp was checkouts and scratch
# that interactive sessions made (remudero-*, wt-*, pr*-fix, ...) and never removed. lib/tmp.ts only
# sweeps rmd's own `rmd-*` dirs, and this Mac rarely reboots, so nothing else ever cleared them.
#
#   deploy/mac/tmp-reclaim.sh            # dry run: what would go, and how much
#   deploy/mac/tmp-reclaim.sh --apply    # delete it (what the scheduled job runs)
#
# It only touches entries OWNED BY THE ACCOUNT RUNNING IT, so each Mac account schedules its own copy
# (deploy/mac/install-tmp-reclaim.sh). It NEVER deletes recent paths, Claude/macOS names, symlinks,
# mixed-owner paths, Git checkouts/worktrees, scheduled log/lock files, or paths with process/CWD/open
# use or an incomplete safety scan. Those paths are recorded for review instead of silently skipped.
#
# THE AGE WINDOW FOLLOWS DISK PRESSURE IN TIERS (retention_window): 48 h with 30% or more of the
# disk free, 24 h at 20-29%, 12 h at 15-19%, and 6 h below 15% or when free space cannot be read.
# Six hours is the floor, never a target: session scratch reaped mid-session was a real failure, so
# no tier and no override goes under it. Each pass re-reads free space, so the window widens again
# on its own once the disk recovers. Age alone is not enough: ownership, process/CWD/open-file,
# symlink, and Git checks below fail closed.
set -u
shopt -s nullglob

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
ROOT="${RMD_RECLAIM_ROOT:-/private/tmp}"
REPORT="${RMD_RECLAIM_REPORT:-$HOME/Library/Logs/remudero/tmp-reclaim-kept.txt}"
ME=$(id -un)
if [ "$(uname)" = Darwin ]; then owner() { stat -f %Su "$1"; }; else owner() { stat -c %U "$1"; }; fi
# The disk counts as full at MARK_PCT used; the tier is chosen by how far below that mark it sits.
MARK_PCT=90

# retention_window <points below the mark> — the age window in minutes. Tiered, never under six
# hours. Twin of retention_window in deploy/rmd-host-cleanup.sh: change the two together.
retention_window() {
  local headroom="$1"
  if [ "$headroom" -ge 20 ]; then echo 2880
  elif [ "$headroom" -ge 10 ]; then echo 1440
  elif [ "$headroom" -ge 5 ]; then echo 720
  else echo 360
  fi
}

# Free space as a whole percentage of the volume holding ROOT (overridable for tests). An unreadable
# df is not "plenty of room": it takes the six-hour floor tier.
if [ -n "${RMD_RECLAIM_FREE_PCT:-}" ]; then
  FREE_PCT=$RMD_RECLAIM_FREE_PCT
else
  read -r total avail < <(df -k "$ROOT" 2>/dev/null | awk 'NR==2 {print $2, $4}')
  case "${total:-x}${avail:-x}" in
    *[!0-9]*) FREE_PCT=unknown ;;
    *) if [ "$total" -gt 0 ]; then FREE_PCT=$(( avail * 100 / total )); else FREE_PCT=unknown; fi ;;
  esac
fi
case "$FREE_PCT" in
  ""|*[!0-9]*) FREE_PCT=unknown; AGE_MIN=$(retention_window 0) ;;
  *) AGE_MIN=$(retention_window $(( MARK_PCT - (100 - FREE_PCT) ))) ;;
esac
BEFORE_AVAIL_KB=$(df -k "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
# tsx's transpile cache is regenerable, so it follows the same window.
TSX_AGE_MIN=$AGE_MIN
LSOF_CMD="${RMD_RECLAIM_LSOF:-$(command -v lsof 2>/dev/null || printf '/usr/sbin/lsof')}"
if [ -n "${TMPDIR:-}" ]; then
  TSX_TMP_ROOT="${TMPDIR%/}"
elif [ "$(uname)" = Darwin ]; then
  TSX_TMP_ROOT="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || printf '/tmp')"
else
  TSX_TMP_ROOT="/tmp"
fi
TSX_PRUNED_N=0; TSX_SKIPPED=0
del_k=0; del_n=0; risky=()

report_risk() {
  local reason="$1" path="$2"
  risky+=("$reason | $path")
  printf 'KEEP RISKY (%s): %s\n' "$reason" "$path"
}

# Return success when activity is found or cannot be ruled out. Process args
# catch explicit paths; CWD and descriptor scans catch relative/open use.
path_is_live_or_unknown() {
  local path="$1" ps_text cwd_text open_text status alt cwd_target
  # lsof and ps print absolute paths, so a ROOT-relative "./entry" is matched by its real path.
  case "$path" in /*) ;; *) path="$ROOT_REAL/${path#./}" ;; esac
  if ! ps_text=$(ps -A -ww -o command= 2>/dev/null); then
    echo 'process list unavailable'; return 0
  fi
  if printf '%s\n' "$ps_text" | grep -F -- "$path" >/dev/null; then
    echo 'process command references path'; return 0
  fi
  if [ "$ROOT_REAL" = /private/tmp ]; then
    alt="/tmp/${path##*/}"
    if printf '%s\n' "$ps_text" | grep -F -- "$alt" >/dev/null; then
      echo 'process command references /tmp alias'; return 0
    fi
  fi
  if ! command -v "$LSOF_CMD" >/dev/null 2>&1; then
    echo 'lsof unavailable'; return 0
  fi
  if [ -d "$path" ]; then
    cwd_target="$path"
  elif [ "${path%/*}" != "$ROOT_REAL" ]; then
    cwd_target="${path%/*}"
  else
    # The sweeper itself is cwd=$ROOT while scanning top-level files.
    cwd_target="$path"
  fi
  cwd_text=$("$LSOF_CMD" -nP -a -d cwd -Fn 2>&1); status=$?
  if [ "$status" -ne 0 ]; then
    echo 'cwd scan unavailable'; return 0
  fi
  if printf '%s\n' "$cwd_text" | awk -v p="$cwd_target" '/^n/ { x=substr($0,2); if (x==p || index(x,p "/")==1) found=1 } END { exit !found }'; then
    echo 'process working directory is inside path'; return 0
  fi
  if [ "$ROOT_REAL" = /private/tmp ] && printf '%s\n' "$cwd_text" | awk -v p="/tmp/${cwd_target##*/}" '/^n/ { x=substr($0,2); if (x==p || index(x,p "/")==1) found=1 } END { exit !found }'; then
    echo 'process working directory uses /tmp alias'; return 0
  fi
  if [ -d "$path" ]; then
    open_text=$("$LSOF_CMD" -nP -Fn +D "$path" 2>&1); status=$?
  else
    open_text=$("$LSOF_CMD" -nP -Fn "$path" 2>&1); status=$?
  fi
  if [ -n "$open_text" ] || [ "$status" -gt 1 ]; then
    echo 'open file or lsof scan uncertain'; return 0
  fi
  return 1
}

# Print a reason and return success if a path must be retained.
artifact_risk() {
  local path="$1" found status owner_name structure_only="${2:-0}"
  [ ! -L "$path" ] || { echo 'symbolic link'; return 0; }
  owner_name=$(owner "$path" 2>/dev/null)
  [ "$owner_name" = "$ME" ] || { echo "owned by ${owner_name:-unknown}"; return 0; }
  found=$(find "$path" -xdev ! -user "$ME" -print -quit 2>/dev/null); status=$?
  [ "$status" -eq 0 ] || { echo 'ownership scan unavailable'; return 0; }
  [ -z "$found" ] || { echo "contains foreign-owned content: $found"; return 0; }
  found=$(find "$path" -xdev -type l -print -quit 2>/dev/null); status=$?
  [ "$status" -eq 0 ] || { echo 'symlink scan unavailable'; return 0; }
  [ -z "$found" ] || { echo "contains symlink: $found"; return 0; }
  found=$(find "$path" -xdev -name .git -print -quit 2>/dev/null); status=$?
  [ "$status" -eq 0 ] || { echo 'Git metadata scan unavailable'; return 0; }
  [ -z "$found" ] || { echo "Git checkout/worktree: $found"; return 0; }
  case "${path##*/}" in
    claude-*|com.apple.*|launchd*|powerlog|.X*|.font-unix|.ICE-unix) echo 'protected Claude/macOS temp name'; return 0 ;;
    .env|.env.*|*password*|*secret*|*token*|*credential*|*keychain*|*.pem|*.p12|*.pfx|*.keytab|id_rsa*|id_ed25519*) echo 'credential-like filename'; return 0 ;;
    *.log|*.lock|*.pid|*.sock) echo 'log or coordination file may be scheduled/reused'; return 0 ;;
  esac
  [ "$structure_only" = 1 ] && return 1
  path_is_live_or_unknown "$path" && return 0
  return 1
}

# A fresh file must not keep unrelated old files in the same scratch folder
# forever. Keep the directory itself, but assess old regular files individually.
prune_old_tree_files() {
  local tree="$1" file status recent owner_name why file_dir abs k old_candidate
  old_candidate=$(find "$tree" -xdev -type f -mmin "+$AGE_MIN" -print -quit 2>/dev/null); status=$?
  if [ "$status" -ne 0 ]; then report_risk 'nested age scan unavailable' "$ROOT_REAL/${tree#./}"; return 0; fi
  [ -n "$old_candidate" ] || return 0
  why=$(artifact_risk "$tree" 1)
  if [ -n "$why" ]; then report_risk "$why" "$ROOT_REAL/${tree#./}"; return 0; fi
  while IFS= read -r -d '' file; do
    recent=$(find "$file" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); status=$?
    if [ "$status" -ne 0 ]; then report_risk 'nested age recheck unavailable' "$ROOT_REAL/${file#./}"; continue; fi
    [ -z "$recent" ] || continue
    owner_name=$(owner "$file" 2>/dev/null)
    if [ "$owner_name" != "$ME" ]; then report_risk "nested file owned by ${owner_name:-unknown}" "$ROOT_REAL/${file#./}"; continue; fi
    file_dir=$(cd "$(dirname "$file")" 2>/dev/null && pwd -P)
    [ -n "$file_dir" ] || { report_risk 'nested path could not be resolved' "$ROOT_REAL/${file#./}"; continue; }
    abs="$file_dir/${file##*/}"
    case "${file##*/}" in
      .env|.env.*|*password*|*secret*|*token*|*credential*|*keychain*|*.pem|*.p12|*.pfx|*.keytab|id_rsa*|id_ed25519*) report_risk 'credential-like filename' "$abs"; continue ;;
    esac
    if why=$(path_is_live_or_unknown "$abs"); then report_risk "$why" "$abs"; continue; fi
    case "${file##*/}" in
      *.log) report_risk 'historical log retained for diagnostics' "$abs"; continue ;;
      *.lock|*.pid|*.sock) report_risk 'nested coordination file may be in use' "$abs"; continue ;;
    esac
    k=$(du -xsk "$abs" 2>/dev/null | cut -f1)
    [ -n "$k" ] || { report_risk 'nested size scan unavailable' "$abs"; continue; }
    if [ "$APPLY" = 1 ]; then
      recent=$(find "$abs" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); status=$?
      if [ "$status" -ne 0 ]; then report_risk 'nested age recheck unavailable' "$abs"; continue; fi
      [ -z "$recent" ] || continue
      if why=$(path_is_live_or_unknown "$abs"); then report_risk "$why" "$abs"; continue; fi
      if ! rm -f -- "$abs"; then report_risk 'nested file delete failed' "$abs"; continue; fi
      echo "deleted old nested file: $abs"
    else
      printf 'WOULD DELETE nested file %s (%s KiB)\n' "$abs" "$k"
    fi
    del_k=$((del_k + ${k:-0})); del_n=$((del_n + 1))
  done < <(find "$tree" -xdev -type f -user "$ME" -mmin "+$AGE_MIN" -print0 2>/dev/null)
}

# TSX caches are write-once compiled files. Keep the cache directory itself;
# prune only regular, account-owned entries older than the age window. An open-file scan
# fails closed so an active compiler's cache is not disturbed.
prune_tsx_cache() {
  local dir="$1" files owner_name count active
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 0
  owner_name=$(owner "$dir" 2>/dev/null)
  if [ "$owner_name" != "$ME" ]; then
    TSX_SKIPPED=$((TSX_SKIPPED+1)); report_risk "TSX cache owned by ${owner_name:-unknown}" "$dir"; return 0
  fi
  if ! files=$(find "$dir" -xdev -type f -user "$ME" -mmin "+$TSX_AGE_MIN" -print 2>/dev/null); then
    TSX_SKIPPED=$((TSX_SKIPPED+1)); report_risk 'TSX cache age scan unverified' "$dir"; return 0
  fi
  [ -n "$files" ] || return 0
  count=$(printf '%s\n' "$files" | awk 'END {print NR+0}')
  if active=$(path_is_live_or_unknown "$(cd "$dir" 2>/dev/null && pwd -P)"); then
    TSX_SKIPPED=$((TSX_SKIPPED+1)); report_risk "TSX cache $active" "$dir"; return 0
  fi
  if [ "$APPLY" = 1 ]; then
    # Recheck liveness immediately before the batched age/owner-filtered delete.
    if active=$(path_is_live_or_unknown "$(cd "$dir" 2>/dev/null && pwd -P)"); then
      TSX_SKIPPED=$((TSX_SKIPPED+1)); report_risk "TSX cache $active" "$dir"; return 0
    fi
    if ! find "$dir" -xdev -type f -user "$ME" -mmin "+$TSX_AGE_MIN" -exec rm -f -- {} +; then
      TSX_SKIPPED=$((TSX_SKIPPED+1)); report_risk 'TSX cache prune incomplete' "$dir"; return 0
    fi
    TSX_PRUNED_N=$((TSX_PRUNED_N+count))
    echo "pruned tsx cache files=$count (older than $TSX_AGE_MIN min): $dir"
  else
    TSX_PRUNED_N=$((TSX_PRUNED_N+count))
    echo "would prune tsx cache files=$count (older than $TSX_AGE_MIN min): $dir"
  fi
}

cd "$ROOT" || exit 1
ROOT_REAL=$(pwd -P)
for p in ./* ./.[!.]*; do
  e=${p#./}
  [ -e "./$e" ] || continue
  # TSX is a regenerable per-file cache, handled separately; never remove its root.
  case "$e" in tsx-*) prune_tsx_cache "./$e"; continue;; esac
  old_check=$(find "./$e" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); old_status=$?
  if [ "$old_status" -ne 0 ]; then report_risk 'age scan unavailable' "$ROOT_REAL/$e"; continue; fi
  if [ -n "$old_check" ]; then
    if [ -d "./$e" ] && [ ! -L "./$e" ]; then
      prune_old_tree_files "./$e"
    fi
    continue
  fi
  why=$(artifact_risk "./$e")
  if [ -n "$why" ]; then report_risk "$why" "$ROOT_REAL/$e"; continue; fi
  # Recheck age and every risk gate immediately before deletion.
  if [ "$APPLY" = 1 ]; then
    old_check=$(find "./$e" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); old_status=$?
    if [ "$old_status" -ne 0 ]; then report_risk 'age recheck unavailable' "$ROOT_REAL/$e"; continue; fi
    [ -z "$old_check" ] || continue
    why=$(artifact_risk "./$e")
    if [ -n "$why" ]; then report_risk "$why" "$ROOT_REAL/$e"; continue; fi
  fi
  k=$(du -xsk "./$e" 2>/dev/null | cut -f1)
  if [ -z "$k" ]; then report_risk 'size scan unavailable' "$ROOT_REAL/$e"; continue; fi
  del_k=$(( del_k + ${k:-0} )); del_n=$(( del_n + 1 ))
  if [ "$APPLY" = 1 ]; then
    if ! rm -rf "./$e"; then report_risk 'delete failed/incomplete' "$ROOT_REAL/$e"; fi
  else
    printf 'WOULD DELETE %s (%s KiB)\n' "$ROOT_REAL/$e" "$k"
  fi
done
TMP_REAL=$(cd "$TSX_TMP_ROOT" 2>/dev/null && pwd -P)
if [ -n "$TMP_REAL" ] && [ "$TMP_REAL" != "$ROOT_REAL" ]; then
  for p in "$TSX_TMP_ROOT"/tsx-*; do
    [ -d "$p" ] && [ ! -L "$p" ] && prune_tsx_cache "$p"
  done
fi
AFTER_AVAIL_KB=$(df -k "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
case "$BEFORE_AVAIL_KB:$AFTER_AVAIL_KB" in
  *[!0-9:]*|:*|*:) actual_delta="unknown" ;;
  *) actual_delta=$((AFTER_AVAIL_KB - BEFORE_AVAIL_KB)) ;;
esac

[ $APPLY = 1 ] && verb="Deleted" || verb="Would delete"
printf '%s %s: %d entries, %d MB (free %s%%, age window %d min); risky retained=%d\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verb" "$del_n" $(( del_k / 1024 )) "$FREE_PCT" "$AGE_MIN" "${#risky[@]}"
printf 'tsx files %s: %d, skipped caches=%d; df avail %s -> %s KiB (delta %s KiB)\n' \
  "$([ "$APPLY" = 1 ] && printf 'pruned' || printf 'would-prune')" "$TSX_PRUNED_N" "$TSX_SKIPPED" "${BEFORE_AVAIL_KB:-unknown}" "${AFTER_AVAIL_KB:-unknown}" "$actual_delta"

if [ $APPLY = 1 ]; then
  mkdir -p "$(dirname "$REPORT")"
  {
    echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) — $ROOT retained risky paths (age may be unknown; otherwise older than the $AGE_MIN min window)"
    printf '%s\n' "${risky[@]}"
  } > "$REPORT"
fi
