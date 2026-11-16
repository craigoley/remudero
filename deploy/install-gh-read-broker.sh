#!/usr/bin/env bash
# W1-T12072: install the GitHub read broker (`rmd gh-broker serve`) as a systemd USER service on a Linux
# host, from the repo, so a deleted unit or launcher is restored from source rather than rebuilt by hand.
# Writes two files under the account's own config directory and holds no credential:
#   <config>/remudero/gh-broker-start.sh                       the launcher
#   <config>/systemd/user/remudero-gh-read-broker.service      the unit
# --check (default) reports each missing or changed file and exits 1; --install writes what differs
# (a second run changes nothing), then daemon-reload, enable and start. The Mac installer is
# deploy/mac/install-gh-read-broker.sh.
# usage: install-gh-read-broker.sh [--check|--install] [--checkout /abs/path/to/checkout]
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="--check"
CHECKOUT="$(dirname "$HERE")"
usage() { echo "usage: install-gh-read-broker.sh [--check|--install] [--checkout /abs/path/to/checkout]" >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--install) MODE="$1"; shift;;
    --checkout) [[ $# -ge 2 && -n "$2" ]] || usage; CHECKOUT="$2"; shift 2;;
    *) usage;;
  esac
done
case "$CHECKOUT" in /*) :;; *) echo "the checkout path must be absolute: $CHECKOUT" >&2; exit 2;; esac
# The path is written into a unit and a shell script unquoted-safe: refuse anything but plain path characters.
if [[ "$CHECKOUT" =~ [^A-Za-z0-9_./@+:-] ]]; then
  echo "the checkout path holds a character this installer will not write into a unit: $CHECKOUT" >&2
  exit 2
fi
[[ -x "$CHECKOUT/bin/rmd" ]] || { echo "not executable: $CHECKOUT/bin/rmd" >&2; exit 2; }

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
LAUNCHER="$CONFIG/remudero/gh-broker-start.sh"
UNIT="$CONFIG/systemd/user/remudero-gh-read-broker.service"
SERVICE="remudero-gh-read-broker.service"

LAUNCHER_BODY="#!/usr/bin/env bash
# Starts the GitHub read broker from the checkout. Installed by deploy/install-gh-read-broker.sh (W1-T12072).
set -euo pipefail
cd $CHECKOUT
exec ./bin/rmd gh-broker serve"
UNIT_BODY="[Unit]
Description=Remudero GitHub read broker (rmd gh-broker serve)
# Installed by deploy/install-gh-read-broker.sh (W1-T12072).

[Service]
Type=simple
WorkingDirectory=$CHECKOUT
ExecStart=$LAUNCHER
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target"

# differs <file> <body>: true when the file is missing or its bytes are not exactly the body plus a newline.
differs() { [[ ! -f "$1" ]] || ! printf '%s\n' "$2" | cmp -s - "$1"; }

if [[ "$MODE" == --check ]]; then
  drift=0
  if [[ ! -f "$LAUNCHER" ]]; then echo "missing: $LAUNCHER"; drift=1
  elif differs "$LAUNCHER" "$LAUNCHER_BODY"; then echo "changed: $LAUNCHER"; drift=1; fi
  if [[ ! -f "$UNIT" ]]; then echo "missing: $UNIT"; drift=1
  elif differs "$UNIT" "$UNIT_BODY"; then echo "changed: $UNIT"; drift=1; fi
  if [[ "$drift" -ne 0 ]]; then exit 1; fi
  echo "the read broker launcher and unit are current"
  exit 0
fi

# write_if_changed <file> <body> <mode>: atomic replace, only when the content differs.
write_if_changed() {
  if differs "$1" "$2"; then
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" > "$1.tmp.$$"
    chmod "$3" "$1.tmp.$$"
    mv -f "$1.tmp.$$" "$1"
    echo "wrote: $1"
    return 0
  fi
  echo "unchanged: $1"
  return 1
}
changed=0
write_if_changed "$LAUNCHER" "$LAUNCHER_BODY" 700 && changed=1 || true
write_if_changed "$UNIT" "$UNIT_BODY" 644 && changed=1 || true
systemctl --user daemon-reload
systemctl --user enable "$SERVICE"
if [[ "$changed" -eq 1 ]]; then systemctl --user restart "$SERVICE"; else systemctl --user start "$SERVICE"; fi
echo "installed $SERVICE from $CHECKOUT; check it with: $CHECKOUT/bin/rmd gh-broker status"
