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
# (deploy/mac/install-tmp-reclaim.sh). It NEVER deletes:
#   - anything with a file modified inside the age window (so a running session is safe);
#   - Claude Code's own session dirs and macOS's own entries;
#   - a git checkout with uncommitted changes, with commits its HEAD has on no remote, or that git
#     cannot read at all (a worktree whose parent clone is gone): "cannot tell" is never "clean".
#
# THE AGE WINDOW FOLLOWS DISK PRESSURE, not one fixed number: 2 days with a quarter of the disk
# free, tightening with the square of the shortfall toward a 2-hour floor as free space runs out.
set -u
shopt -s nullglob

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
ROOT="${RMD_RECLAIM_ROOT:-/private/tmp}"
REPORT="${RMD_RECLAIM_REPORT:-$HOME/Library/Logs/remudero/tmp-reclaim-kept.txt}"
ME=$(id -un)
if [ "$(uname)" = Darwin ]; then owner() { stat -f %Su "$1"; }; else owner() { stat -c %U "$1"; }; fi
FLOOR_MIN=120
CEIL_MIN=2880

# Free space as a whole percentage of the volume holding ROOT (overridable for tests).
if [ -n "${RMD_RECLAIM_FREE_PCT:-}" ]; then
  FREE_PCT=$RMD_RECLAIM_FREE_PCT
else
  read -r total avail < <(df -k "$ROOT" | awk 'NR==2 {print $2, $4}')
  FREE_PCT=$(( avail * 100 / total ))
fi
f=$(( FREE_PCT > 25 ? 25 : FREE_PCT ))
AGE_MIN=$(( FLOOR_MIN + (CEIL_MIN - FLOOR_MIN) * f * f / 625 ))

cd "$ROOT" || exit 1
del_k=0; del_n=0; keep=(); keep_old=()
for p in ./* ./.[!.]*; do
  e=${p#./}
  [ -e "./$e" ] || continue
  [ "$(owner "./$e")" = "$ME" ] || continue
  case "$e" in claude-*|com.apple.*|launchd*|powerlog|.X*|.font-unix|.ICE-unix) continue;; esac
  # Recent activity ANYWHERE inside, not just the top-level mtime, keeps the entry.
  [ -n "$(find "./$e" -mmin -"$AGE_MIN" -print -quit 2>/dev/null)" ] && continue
  if [ -e "./$e/.git" ]; then
    if ! dirty=$(git -C "./$e" status --porcelain 2>/dev/null) ||
       ! unpushed=$(git -C "./$e" log HEAD --not --remotes --oneline 2>/dev/null); then
      keep+=("$e (unreadable by git)"); continue
    fi
    if [ -n "$dirty" ] || [ -n "$unpushed" ]; then
      keep+=("$e")
      [ -z "$(find "./$e" -maxdepth 0 -mtime -7 2>/dev/null)" ] && keep_old+=("$e")
      continue
    fi
  fi
  k=$(du -xsk "./$e" 2>/dev/null | cut -f1)
  del_k=$(( del_k + ${k:-0} )); del_n=$(( del_n + 1 ))
  [ $APPLY = 1 ] && rm -rf "./$e"
done

[ $APPLY = 1 ] && verb="Deleted" || verb="Would delete"
printf '%s %s: %d entries, %d MB (free %d%%, age window %d min); kept %d checkout(s) with work\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verb" "$del_n" $(( del_k / 1024 )) "$FREE_PCT" "$AGE_MIN" "${#keep[@]}"

# Kept checkouts older than a week are the part only a person can clear: list them where they can be read.
if [ $APPLY = 1 ]; then
  mkdir -p "$(dirname "$REPORT")"
  {
    echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) — $ROOT checkouts kept for uncommitted or unpushed work, older than 7 days"
    for e in ${keep_old[@]+"${keep_old[@]}"}; do echo "$ROOT/$e"; done
  } > "$REPORT"
fi
