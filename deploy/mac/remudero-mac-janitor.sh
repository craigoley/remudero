#!/bin/bash
# Shared scheduler entry point: code is shared, account data and locks are not.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
janitor="${REMUDERO_MAC_JANITOR_BIN:-$here/remudero-mac/remudero-janitor.sh}"
if [ "$#" -gt 1 ] || [ ! -x "$janitor" ]; then
  printf 'remudero-mac-janitor: target unavailable or arguments invalid: %s\n' "$janitor" >&2
  exit 2
fi
case "${1:-}" in
  ""|--apply) exec "$janitor" --apply ;;
  --dry-run) exec "$janitor" --dry-run ;;
  *) printf 'usage: remudero-mac-janitor.sh [--dry-run|--apply]\n' >&2; exit 2 ;;
esac
