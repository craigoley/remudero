#!/bin/bash
# Install maintained account-aware code only; do not change cron/launchd jobs.
set -euo pipefail
src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
dest="${REMUDERO_JANITOR_INSTALL_DIR:-$HOME/bin}"
mkdir -p "$dest"
for name in workspace-retirement-guard.sh dependency-seed-guard.sh; do
  install -m 0755 "$src/../$name" "$dest/$name.tmp.$$"
  mv -f "$dest/$name.tmp.$$" "$dest/$name"
done
target="$dest/remudero-janitor.sh"
if [ -f "$target" ] && ! cmp -s "$src/remudero-janitor.sh" "$target"; then
  cp -p "$target" "$target.pre-install-$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 0755 "$src/remudero-janitor.sh" "$target.tmp.$$"
mv -f "$target.tmp.$$" "$target"
printf 'Installed %s; schedules unchanged. Run with --dry-run first.\n' "$target"
