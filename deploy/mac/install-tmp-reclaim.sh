#!/bin/bash
# deploy/mac/install-tmp-reclaim.sh — schedule tmp-reclaim.sh hourly for the account running this.
#
# Run once per Mac account (each account owns its own /private/tmp scratch). Re-run to update: it
# copies the script to a stable path, so the job never depends on where a checkout lives, and it
# replaces its own crontab line rather than adding another.
#
# CRON, NOT launchd: a launchd user agent needs a logged-in GUI session, and an account used only over
# SSH never has one, so the job would silently never run. A user crontab runs either way.
#
# --code-only replaces the three files and nothing else: the crontab and the install-source
# record stay as they are. The scheduled refresh in tmp-reclaim.sh runs it from origin/main.
set -euo pipefail
CODE_ONLY=0
for option in "$@"; do
  case "$option" in --code-only) CODE_ONLY=1 ;;
    *) printf 'usage: %s [--code-only]\n' "$0" >&2; exit 2 ;;
  esac
done
HERE=$(cd "$(dirname "$0")" && pwd -P)
DEST="$HOME/Library/Application Support/remudero"
LOG="$HOME/Library/Logs/remudero/tmp-reclaim.log"
TAG="# remudero-tmp-reclaim"
# Validate the complete source set before replacing any installed file.
for file in "$HERE/../dependency-seed-guard.sh" "$HERE/tmp-reclaim.sh" "$HERE/cache-reclaim.py"; do
  [ -r "$file" ] || { printf 'missing maintained source: %s\n' "$file" >&2; exit 2; }
done
copy_code() {
  mkdir -p "$DEST"
  for pair in "../dependency-seed-guard.sh:dependency-seed-guard.sh" "tmp-reclaim.sh:tmp-reclaim.sh" "cache-reclaim.py:cache-reclaim.py"; do
    install -m 755 "$HERE/${pair%%:*}" "$DEST/${pair#*:}.tmp.$$"
    mv -f "$DEST/${pair#*:}.tmp.$$" "$DEST/${pair#*:}"
  done
}
if [ "$CODE_ONLY" = 1 ]; then
  copy_code
  echo "installed code for $(id -un) in $DEST; crontab unchanged"
  exit 0
fi
# Reading a crontab must succeed before any installed file or scheduled job is changed.
READ_STATUS=0
CURRENT=$(crontab -l 2>&1) || READ_STATUS=$?
if [ "$READ_STATUS" -ne 0 ]; then
  if [ "$READ_STATUS" -eq 1 ] && printf '%s\n' "$CURRENT" | grep -F 'no crontab for' >/dev/null; then CURRENT=""
  else printf 'crontab -l failed (exit %s): %s; nothing installed\n' "$READ_STATUS" "$CURRENT" >&2; exit 1; fi
fi
mkdir -p "$(dirname "$LOG")"
copy_code
LINE="17 * * * * /bin/bash \"$DEST/tmp-reclaim.sh\" --apply >> \"$LOG\" 2>&1 $TAG"
# Read the current table in full BEFORE writing, so the write can never truncate what is being read.
CURRENT=$(printf '%s\n' "$CURRENT" | awk -v tag="$TAG" 'index($0,tag)==0')
printf "%s\n%s\n" "$CURRENT" "$LINE" | sed "/^$/d" | crontab -
echo "installed for $(id -un): hourly at :17 -> $LOG"
# Written last: the checkout a scheduled refresh reads. A wider home-bin record in DEST is kept.
layout=application-support
! grep -qx 'layout=home-bin' "$DEST/install-source" 2>/dev/null || layout=home-bin
if common=$(unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR; cd "$HERE" && top=$(git rev-parse --show-toplevel 2>/dev/null) &&
  cd "$top" && gd=$(git rev-parse --git-common-dir 2>/dev/null) && cd "$gd" && pwd -P); then
  case "$common" in */.git) checkout=${common%/.git} ;; *) checkout=$common ;; esac
  origin=$(unset GIT_DIR GIT_WORK_TREE; git -C "$checkout" remote get-url origin 2>/dev/null) || origin=''
  printf 'checkout=%s\nlayout=%s\norigin=%s\n' "$checkout" "$layout" "$origin" > "$DEST/install-source.tmp.$$"
  mv -f "$DEST/install-source.tmp.$$" "$DEST/install-source"
  echo "recorded install-source: $checkout ($layout)"
else
  echo "no install-source written: $HERE is not in a Git checkout; scheduled refresh stays off"
fi
crontab -l | grep -- "$TAG"
