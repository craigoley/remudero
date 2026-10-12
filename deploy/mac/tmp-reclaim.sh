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
# The age window is always six hours, regardless of free space. Each account runs its own hourly
# sweep; ownership, process/CWD/open-file, symlink, and Git checks below still fail closed. Old
# regular log files are eligible too, except when the current crontab schedules that path or any
# safety check is uncertain.
set -u
shopt -s nullglob

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
ROOT="${RMD_RECLAIM_ROOT:-/private/tmp}"
SESSION_ROOT="${RMD_RECLAIM_SESSION_ROOT:-$HOME/Remudero/.session-scratch}"
REPORT="${RMD_RECLAIM_REPORT:-$HOME/Library/Logs/remudero/tmp-reclaim-kept.txt}"
ME=$(id -un)
if [ "$(uname)" = Darwin ]; then owner() { stat -f %Su "$1"; }; else owner() { stat -c %U "$1"; }; fi
AGE_MIN=360

# Preserve log paths used by recurring jobs. If the crontab cannot be read, fail closed for logs.
CRON_READ_OK=0
CRON_TEXT=""
if command -v crontab >/dev/null 2>&1; then
  CRON_OUTPUT=$(crontab -l 2>&1); CRON_STATUS=$?
  if [ "$CRON_STATUS" -eq 0 ]; then
    CRON_TEXT="$CRON_OUTPUT"; CRON_READ_OK=1
  elif printf '%s\n' "$CRON_OUTPUT" | grep -F 'no crontab for' >/dev/null 2>&1; then
    CRON_READ_OK=1
  fi
fi

# Free space is reported for context only; it never changes the fixed six-hour age window.
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
  ""|*[!0-9]*) FREE_PCT=unknown ;;
  *) : ;;
esac
BEFORE_AVAIL_KB=$(df -k "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
# tsx's transpile cache is regenerable, so it follows the same fixed six-hour window.
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
del_k=0; del_n=0; risky=(); risky_n=0
session_del_k=0; session_del_n=0

report_risk() {
  local reason="$1" path="$2"
  risky+=("$reason | $path")
  risky_n=$((risky_n + 1))
  printf 'KEEP RISKY (%s): %s\n' "$reason" "$path"
}

# Return a reason when the path is scheduled output or scheduling status is uncertain.
scheduled_log_risk() {
  local path="$1" alias
  case "$path" in /*) ;; *) path="$ROOT_REAL/${path#./}" ;; esac
  [ "$CRON_READ_OK" = 1 ] || { echo 'crontab unavailable; scheduled-log status unknown'; return 0; }
  case "$CRON_TEXT" in
    *"$path"*) echo 'scheduled log path referenced by crontab'; return 0 ;;
  esac
  if [ "$ROOT_REAL" = /private/tmp ]; then
    alias="/tmp/${path##*/}"
    case "$CRON_TEXT" in
      *"$alias"*) echo 'scheduled /tmp log path referenced by crontab'; return 0 ;;
    esac
  fi
  return 1
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
    *.log)
      [ -f "$path" ] || { echo 'log-like path is not a regular file'; return 0; }
      if found=$(scheduled_log_risk "$path"); then echo "$found"; return 0; fi
      ;;
    *.lock|*.pid|*.sock) echo 'coordination file may be reused'; return 0 ;;
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
      *.log)
        if why=$(scheduled_log_risk "$abs"); then report_risk "$why" "$abs"; continue; fi
        ;;
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

process_tmp_entry() {
  local path="$1" old_check old_status why k
  [ -e "$path" ] || return 0
  # TSX is a regenerable per-file cache, handled separately; never remove its root.
  case "${path##*/}" in tsx-*) prune_tsx_cache "$path"; return 0;; esac
  old_check=$(find "$path" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); old_status=$?
  if [ "$old_status" -ne 0 ]; then report_risk 'age scan unavailable' "$ROOT_REAL/${path#./}"; return 0; fi
  if [ -n "$old_check" ]; then
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      prune_old_tree_files "$path"
    fi
    return 0
  fi
  why=$(artifact_risk "$path")
  if [ -n "$why" ]; then report_risk "$why" "$ROOT_REAL/${path#./}"; return 0; fi
  # Recheck age and every risk gate immediately before deletion.
  if [ "$APPLY" = 1 ]; then
    old_check=$(find "$path" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); old_status=$?
    if [ "$old_status" -ne 0 ]; then report_risk 'age recheck unavailable' "$ROOT_REAL/${path#./}"; return 0; fi
    [ -z "$old_check" ] || return 0
    why=$(artifact_risk "$path")
    if [ -n "$why" ]; then report_risk "$why" "$ROOT_REAL/${path#./}"; return 0; fi
  fi
  k=$(du -xsk "$path" 2>/dev/null | cut -f1)
  if [ -z "$k" ]; then report_risk 'size scan unavailable' "$ROOT_REAL/${path#./}"; return 0; fi
  del_k=$(( del_k + ${k:-0} )); del_n=$(( del_n + 1 ))
  if [ "$APPLY" = 1 ]; then
    if ! rm -rf "$path"; then report_risk 'delete failed/incomplete' "$ROOT_REAL/${path#./}"; fi
  else
    printf 'WOULD DELETE %s (%s KiB)\n' "$ROOT_REAL/${path#./}" "$k"
  fi
}

# Session scratch is a separate, narrower policy: remove only complete direct-child directories
# whose every item is older than six hours. Loose files are deliberately left alone. The same
# ownership, symlink, Git, credential, scheduled-log, process/CWD/open-file checks still apply.
session_scratch_risk() {
  local path="$1" found status log_file why
  why=$(artifact_risk "$path")
  [ -z "$why" ] || { echo "$why"; return 0; }
  found=$(find "$path" -xdev ! -type d ! -type f -print -quit 2>/dev/null); status=$?
  [ "$status" -eq 0 ] || { echo 'session scratch file-type scan unavailable'; return 0; }
  [ -z "$found" ] || { echo "special file: $found"; return 0; }
  found=$(find "$path" -xdev -type f \( -name '.env' -o -name '.env.*' -o -iname '*password*' -o -iname '*secret*' -o -iname '*token*' -o -iname '*credential*' -o -iname '*keychain*' -o -iname '*.pem' -o -iname '*.p12' -o -iname '*.pfx' -o -iname '*.keytab' -o -name 'id_rsa*' -o -name 'id_ed25519*' \) -print -quit 2>/dev/null); status=$?
  [ "$status" -eq 0 ] || { echo 'session scratch sensitive-name scan unavailable'; return 0; }
  [ -z "$found" ] || { echo "credential-like filename: $found"; return 0; }
  while IFS= read -r -d '' log_file; do
    if why=$(scheduled_log_risk "$log_file"); then echo "$why"; return 0; fi
  done < <(find "$path" -xdev -type f -name '*.log' -print0 2>/dev/null)
  return 1
}

process_session_scratch_dir() {
  local path="$1" recent status why k resolved
  [ -d "$path" ] || return 0
  if [ -L "$path" ]; then report_risk 'session scratch directory is a symlink' "$path"; return 0; fi
  resolved=$(cd "$path" 2>/dev/null && pwd -P)
  if [ -z "$resolved" ] || [ "$resolved" != "$path" ]; then
    report_risk 'session scratch path changed or could not be resolved' "$path"; return 0
  fi
  recent=$(find "$path" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); status=$?
  if [ "$status" -ne 0 ]; then report_risk 'session scratch age scan unavailable' "$path"; return 0; fi
  if [ -n "$recent" ]; then report_risk 'recent content inside session scratch directory' "$path"; return 0; fi
  why=$(session_scratch_risk "$path")
  if [ -n "$why" ]; then report_risk "$why" "$path"; return 0; fi
  k=$(du -xsk "$path" 2>/dev/null | cut -f1)
  if [ -z "$k" ]; then report_risk 'session scratch size scan unavailable' "$path"; return 0; fi
  if [ "$APPLY" = 1 ]; then
    recent=$(find "$path" -xdev -mmin -"$AGE_MIN" -print -quit 2>/dev/null); status=$?
    if [ "$status" -ne 0 ]; then report_risk 'session scratch age recheck unavailable' "$path"; return 0; fi
    [ -z "$recent" ] || { report_risk 'recent content appeared before session scratch deletion' "$path"; return 0; }
    why=$(session_scratch_risk "$path")
    if [ -n "$why" ]; then report_risk "$why" "$path"; return 0; fi
    if ! rm -rf -- "$path"; then report_risk 'session scratch delete failed/incomplete' "$path"; return 0; fi
    printf 'deleted old session scratch directory (%s KiB): %s\n' "$k" "$path"
  else
    printf 'WOULD DELETE old session scratch directory %s (%s KiB)\n' "$path" "$k"
  fi
  session_del_k=$((session_del_k + k)); session_del_n=$((session_del_n + 1))
}

cd "$ROOT" || exit 1
ROOT_REAL=$(pwd -P)
for p in ./* ./.[!.]*; do
  e=${p#./}
  [ -e "./$e" ] || continue
  # Node tests often put many disposable trees and a large TSX cache under /private/tmp/rt.
  # Handle its immediate children independently so the TSX batch guard runs once per cache,
  # rather than recursively treating every generated file as a separate live-path query.
  if [ "$e" = rt ] && [ -d "$p" ] && [ ! -L "$p" ]; then
    for child in "$p"/* "$p"/.[!.]*; do
      [ -e "$child" ] || continue
      process_tmp_entry "$child"
    done
    continue
  fi
  process_tmp_entry "./$e"
done
TMP_REAL=$(cd "$TSX_TMP_ROOT" 2>/dev/null && pwd -P)
if [ -n "$TMP_REAL" ] && [ "$TMP_REAL" != "$ROOT_REAL" ]; then
  for p in "$TSX_TMP_ROOT"/tsx-*; do
    [ -d "$p" ] && [ ! -L "$p" ] && prune_tsx_cache "$p"
  done
fi

# The account-local Remudero session scratch root is opt-in by existence, never created here.
# Without a test override, insist on the canonical ~/Remudero/.session-scratch location and reject
# symlinked roots/parents so a path swap cannot redirect cleanup elsewhere.
if [ -e "$SESSION_ROOT" ] || [ -L "$SESSION_ROOT" ]; then
  session_root_ok=1
  if [ -L "$SESSION_ROOT" ] || [ ! -d "$SESSION_ROOT" ]; then
    report_risk 'session scratch root is not a real directory' "$SESSION_ROOT"; session_root_ok=0
  fi
  if [ "$session_root_ok" = 1 ] && [ -z "${RMD_RECLAIM_SESSION_ROOT+x}" ]; then
    home_real=$(cd "$HOME" 2>/dev/null && pwd -P)
    parent_real=$(cd "$HOME/Remudero" 2>/dev/null && pwd -P)
    parent_owner=$(owner "$parent_real" 2>/dev/null)
    if [ -L "$HOME/Remudero" ] || [ -z "$home_real" ] || [ "$parent_real" != "$home_real/Remudero" ] || [ "$parent_owner" != "$ME" ]; then
      report_risk 'Remudero session scratch parent is symlinked or unverified' "$SESSION_ROOT"; session_root_ok=0
    fi
  fi
  if [ "$session_root_ok" = 1 ]; then
    SESSION_ROOT_REAL=$(cd "$SESSION_ROOT" 2>/dev/null && pwd -P)
    if [ -z "$SESSION_ROOT_REAL" ] || [ "$(owner "$SESSION_ROOT_REAL" 2>/dev/null)" != "$ME" ] || { [ -z "${RMD_RECLAIM_SESSION_ROOT+x}" ] && [ "$SESSION_ROOT_REAL" != "$parent_real/.session-scratch" ]; }; then
      report_risk 'session scratch root owner/path unverified' "$SESSION_ROOT"; session_root_ok=0
    fi
  fi
  if [ "$session_root_ok" = 1 ] && { [ ! -r "$SESSION_ROOT_REAL" ] || [ ! -x "$SESSION_ROOT_REAL" ]; }; then
    report_risk 'session scratch root cannot be fully scanned' "$SESSION_ROOT"; session_root_ok=0
  fi
  if [ "$session_root_ok" = 1 ]; then
    ROOT_REAL="$SESSION_ROOT_REAL"
    while IFS= read -r -d '' p; do
      process_session_scratch_dir "$p"
    done < <(find "$SESSION_ROOT_REAL" -mindepth 1 -maxdepth 1 -type d -mmin "+$AGE_MIN" -print0 2>/dev/null)
  fi
fi
ROOT_REAL=$(cd "$ROOT" 2>/dev/null && pwd -P)
del_n=$((del_n + session_del_n)); del_k=$((del_k + session_del_k))
AFTER_AVAIL_KB=$(df -k "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
case "$BEFORE_AVAIL_KB:$AFTER_AVAIL_KB" in
  *[!0-9:]*|:*|*:) actual_delta="unknown" ;;
  *) actual_delta=$((AFTER_AVAIL_KB - BEFORE_AVAIL_KB)) ;;
esac

[ $APPLY = 1 ] && verb="Deleted" || verb="Would delete"
printf '%s %s: %d entries, %d MB (free %s%%, age window %d min); risky retained=%d\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verb" "$del_n" $(( del_k / 1024 )) "$FREE_PCT" "$AGE_MIN" "$risky_n"
printf 'tsx files %s: %d, skipped caches=%d; df avail %s -> %s KiB (delta %s KiB)\n' \
  "$([ "$APPLY" = 1 ] && printf 'pruned' || printf 'would-prune')" "$TSX_PRUNED_N" "$TSX_SKIPPED" "${BEFORE_AVAIL_KB:-unknown}" "${AFTER_AVAIL_KB:-unknown}" "$actual_delta"
printf 'session scratch dirs %s: %d, %d MB (root %s; age window %d min)\n' \
  "$([ "$APPLY" = 1 ] && printf 'deleted' || printf 'would-delete')" "$session_del_n" "$((session_del_k / 1024))" "$SESSION_ROOT" "$AGE_MIN"

if [ $APPLY = 1 ]; then
  mkdir -p "$(dirname "$REPORT")"
  {
    echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) — retained risky paths under $ROOT and $SESSION_ROOT (age may be unknown; otherwise older than the $AGE_MIN min window)"
    if [ "$risky_n" -gt 0 ]; then printf '%s\n' "${risky[@]}"; fi
  } > "$REPORT"
fi
