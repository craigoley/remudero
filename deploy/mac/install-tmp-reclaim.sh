#!/bin/bash
# deploy/mac/install-tmp-reclaim.sh — schedule tmp-reclaim.sh hourly for the account running this.
#
# Run once per Mac account (each account owns its own /private/tmp scratch). Re-run to update: it
# copies the script to a stable path, so the job never depends on where a checkout lives, and it
# replaces its own crontab line rather than adding another.
#
# CRON, NOT launchd: a launchd user agent needs a logged-in GUI session, and an account used only over
# SSH never has one, so the job would silently never run. A user crontab runs either way.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEST="$HOME/Library/Application Support/remudero"
LOG="$HOME/Library/Logs/remudero/tmp-reclaim.log"
TAG="# remudero-tmp-reclaim"
# Reading a crontab must succeed before any installed file or scheduled job is changed.
READ_STATUS=0
CURRENT=$(crontab -l 2>&1) || READ_STATUS=$?
if [ "$READ_STATUS" -ne 0 ]; then
  if [ "$READ_STATUS" -eq 1 ] && printf '%s\n' "$CURRENT" | grep -F 'no crontab for' >/dev/null; then CURRENT=""
  else printf 'crontab -l failed (exit %s): %s; nothing installed\n' "$READ_STATUS" "$CURRENT" >&2; exit 1; fi
fi
mkdir -p "$DEST" "$(dirname "$LOG")"
install -m 755 "$HERE/../dependency-seed-guard.sh" "$DEST/dependency-seed-guard.sh"
install -m 755 "$HERE/tmp-reclaim.sh" "$DEST/tmp-reclaim.sh"
install -m 755 "$HERE/cache-reclaim.py" "$DEST/cache-reclaim.py"
LINE="17 * * * * /bin/bash \"$DEST/tmp-reclaim.sh\" --apply >> \"$LOG\" 2>&1 $TAG"
# Read the current table in full BEFORE writing, so the write can never truncate what is being read.
CURRENT=$(printf '%s\n' "$CURRENT" | awk -v tag="$TAG" 'index($0,tag)==0')
printf "%s\n%s\n" "$CURRENT" "$LINE" | sed "/^$/d" | crontab -
echo "installed for $(id -un): hourly at :17 -> $LOG"
crontab -l | grep -- "$TAG"
