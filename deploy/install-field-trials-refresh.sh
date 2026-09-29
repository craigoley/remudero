#!/usr/bin/env bash
# Install a daily private Field Trials refresh for the fleet host's service account.
set -euo pipefail
MODE="${1:---check}"
case "$MODE" in --check|--install) :;; *) echo "usage: install-field-trials-refresh.sh [--check|--install]" >&2; exit 2;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/field-trials-refresh.sh"
DEST="$HOME/.local/bin/rmd-field-trials-refresh"
LOG="$HOME/.local/state/remudero/field-trials-refresh.log"
TAG='# remudero-field-trials-refresh'
LINE="17 4 * * * $DEST >> $LOG 2>&1 $TAG"

if [[ "$MODE" == --check ]]; then
  test -x "$DEST" && cmp -s "$SOURCE" "$DEST" || { echo "field-trials refresh script not installed at $DEST"; exit 1; }
  crontab -l 2>/dev/null | grep -Fx -- "$LINE" >/dev/null || { echo "field-trials daily cron absent or drifted"; exit 1; }
  echo "field-trials daily cron and script current"
  exit 0
fi

mkdir -p "$(dirname "$DEST")" "$(dirname "$LOG")"
chmod 700 "$(dirname "$LOG")"
install -m 700 "$SOURCE" "$DEST"
CURRENT="$(crontab -l 2>/dev/null | grep -vF -- "$TAG" || true)"
printf '%s\n%s\n' "$CURRENT" "$LINE" | sed '/^$/d' | crontab -
echo "installed daily private Field Trials refresh at 04:17 host time; log: $LOG"
