#!/bin/bash
# deploy/mac/install-seed-open-files.sh — run root's open-file scan of dependency seed stores every
# five minutes (deploy/DEPENDENCY-SEEDS.md). Run once with sudo, naming each store to scan:
#   sudo bash deploy/mac/install-seed-open-files.sh "/Users/agent/Library/Application Support/Remudero/dependencies"
# The script and job are root-owned; the job runs no account-owned code. Re-run to update.
set -euo pipefail
LABEL=com.remudero.seed-open-files
LIBEXEC="/Library/Application Support/Remudero/libexec"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
HERE=$(cd "$(dirname "$0")" && pwd)
print_only=0
[ "${1:-}" = --print-plist ] && { print_only=1; shift; }
[ "$#" -ge 1 ] || { printf 'usage: %s [--print-plist] SEED_ROOT [SEED_ROOT ...]\n' "$0" >&2; exit 2; }
for root in "$@"; do
  case "$root" in /*) ;; *) printf 'seed root must be absolute: %s\n' "$root" >&2; exit 2 ;; esac
done
plist() {
  python3 -I - "$LABEL" "$LIBEXEC/seed-open-files.py" "$@" <<'PY'
import plistlib, sys
label, script, *roots = sys.argv[1:]
sys.stdout.buffer.write(plistlib.dumps({
    "Label": label, "ProgramArguments": ["/usr/bin/python3", "-I", script, *roots],
    "StartInterval": 300, "RunAtLoad": True, "UserName": "root",
    "StandardErrorPath": "/var/log/remudero-seed-open-files.log"}))
PY
}
if [ "$print_only" = 1 ]; then plist "$@"; exit 0; fi
[ "$(id -u)" = 0 ] || { printf 'run with sudo: the scan and its job must be root-owned\n' >&2; exit 2; }
install -d -o root -g wheel -m 0755 "/Library/Application Support/Remudero" "$LIBEXEC"
install -o root -g wheel -m 0755 "$HERE/seed-open-files.py" "$LIBEXEC/seed-open-files.py"
plist "$@" > "$PLIST.tmp.$$"
chown root:wheel "$PLIST.tmp.$$"; chmod 0644 "$PLIST.tmp.$$"; mv -f "$PLIST.tmp.$$" "$PLIST"
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
printf 'installed %s: every 5 minutes for %s store(s)\n' "$LABEL" "$#"
