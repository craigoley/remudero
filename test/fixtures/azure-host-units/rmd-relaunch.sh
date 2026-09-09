#!/usr/bin/env bash
# Canonical daemon (re)launch for the Azure fleet host.
#
# DERIVED FROM deploy/host-update.sh --print-daemon-run, which is the single source of truth for
# this invocation. Re-derive rather than hand-edit when the deploy scripts change:
#   cd ~/rmd-state2/repos/remudero
#   RMD_#
# HEAP CEILING (2026-09-05). The daemon died SIX times in eight hours with
# `FATAL ERROR: Ineffective mark-compacts near heap limit` at ~2046 MB -- V8's default old-space
# cap -- while the host had 7.0 GB free and the container had NO memory limit. Five of those exits
# spent docker's `on-failure:5` budget and the fleet then stayed down for three hours with PRs
# piling up green and unreviewed. The trigger is the retro rung, whose scope grows monotonically
# (63 -> 68 runs across those eight hours), so this ceiling is reached sooner each day.
#
# 2026-09-05 RESIZE: host went 4 vCPU / 7.9 GB -> 8 vCPU / 32 GB, so this went 4096 -> 8192. The
# retro marker has been frozen at 2026-09-03 since the ratchet began (W1-T2875): every attempt
# re-scopes from that instant over a window that only grows, so a bigger ceiling is what gives one
# attempt a chance to FINISH and advance the marker, breaking the loop. If it still aborts, the
# ratchet is the cause and no ceiling fixes it.
# The old sizing note, kept because the reasoning still applies at any host size:
# 4096 MB left roughly 3 GB for workers and the OS on a 7.9 GB host. RAISING THE CEILING ONLY
# BUYS TIME: the growing retro scope is the actual defect and is filed separately.
#   RMD_STATE_DIR=/home/craigoleyagent/rmd-state2 bash deploy/host-update.sh --print-daemon-run
#
# TWO THINGS THE PRINTED FORM WILL NOT TELL YOU, both measured 2026-09-05:
#
# 1. RMD_STATE_DIR MUST BE SET. host-update.sh defaults to /home/craigoleyagent/rmd-state, which on
#    this host holds NO ledger -- the live fleet is on rmd-state2. The script warns about it, and
#    the warning is easy to scroll past. Mounting the default would point the daemon at a dead
#    volume and land PAUSE/STOP where nothing reads them.
#
# 2. THIS HOST AUTHENTICATES AS A GITHUB APP, NOT WITH GH_TOKEN. The printed form passes
#    -e GH_TOKEN; the running daemon has no such variable and refreshes an installation token from
#    the GH_APP_* trio instead. Passing an empty GH_TOKEN is harmless but carries no credential.
#
# RESTART POLICY IS on-failure:5 ON PURPOSE -- DO NOT "FIX" IT TO unless-stopped.
# daemonExitCode maps 'stopped' and 'max_reached' to exit 0, so a deliberate stop is a ZERO exit.
# Under unless-stopped docker would restart it, the daemon would re-read state/STOP, exit 0 again,
# and the STOP lever would become a restart loop that never stops anything. Nonzero exits (notably
# 'stale', which must restart to pick up merged code) still restart, capped at 5 and rate-limited
# by RMD_RESTART_THROTTLE_S inside deploy/entrypoint.sh.
#
# Reboot survival is therefore NOT docker's job here -- it is rmd-fleet.service, which runs this
# script once at boot after docker and after the three data-disk mounts.
set -euo pipefail

STATE_DIR=/home/craigoleyagent/rmd-state2
IMAGE=synthwatcholey0620.azurecr.io/remudero:latest
BOOT=0
[ "${1:-}" = "--boot" ] && BOOT=1

# THE STOP LEVER OUTRANKS THIS SCRIPT, including at boot. Without this check a reboot would silently
# undo a deliberate stop -- the one thing an operator setting STOP is entitled to rely on.
if [ -e "$STATE_DIR/state/STOP" ]; then
  echo "rmd-relaunch: state/STOP present -- refusing to start the daemon. rm it to resume."
  exit 0
fi

# Idempotent: a daemon that is already up is left strictly alone. Restarting a healthy daemon kills
# every in-flight worker, which is real spend.
if [ -n "$(docker ps -q -f name='^remudero-daemon$' 2>/dev/null)" ]; then
  echo "rmd-relaunch: remudero-daemon already running -- nothing to do."
  exit 0
fi

# The mounts are nofail, so they can legitimately be absent. Starting the daemon against an
# unmounted state root is the 2026-09-05 fleet-wipe failure mode; refuse instead.
for m in /mnt/rmd "$STATE_DIR"; do
  if ! findmnt -no TARGET "$m" >/dev/null 2>&1 && [ "$m" = /mnt/rmd ]; then
    echo "rmd-relaunch: FATAL -- $m is not mounted. Refusing to start against the bare OS disk." >&2
    exit 1
  fi
done
if [ ! -s "$STATE_DIR/state/ledger.ndjson" ]; then
  echo "rmd-relaunch: FATAL -- $STATE_DIR/state/ledger.ndjson missing or empty; wrong volume?" >&2
  exit 1
fi

# A REVIVAL MUST LEAVE A TRACE, OR AUTO-RECOVERY HIDES THE THING IT RECOVERS FROM.
# The watchdog reaches this line only when the daemon was NOT running, i.e. docker had given up or
# never started it. If that happens repeatedly the fleet looks healthy from outside -- each beat is
# fresh, each daemon is young -- while it is in fact crash-looping every few minutes. Recreating the
# container also RESETS docker's RestartCount to 0, so the beat's restart-budget field cannot see it
# either. This append-only log is the only record that a revival happened at all.
REVIVAL_LOG=/home/craigoleyagent/rmd-revivals.log
{
  printf '%s revive boot=%s prev_status=%s prev_exit=%s prev_restarts=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BOOT" \
    "$(docker inspect remudero-daemon --format '{{.State.Status}}' 2>/dev/null || echo none)" \
    "$(docker inspect remudero-daemon --format '{{.State.ExitCode}}' 2>/dev/null || echo none)" \
    "$(docker inspect remudero-daemon --format '{{.RestartCount}}' 2>/dev/null || echo none)"
} >> "$REVIVAL_LOG" 2>/dev/null || true

docker rm -f remudero-daemon >/dev/null 2>&1 || true

docker run -d --name remudero-daemon \
  --restart=on-failure:5 \
  --cap-drop ALL \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  --user 1000:1000 \
  -e GH_APP_ID=4648213 \
  -e GH_APP_INSTALLATION_ID=155256285 \
  -e GH_APP_PRIVATE_KEY_PATH=/home/node/.claude/rmd-app.pem \
  -e NODE_OPTIONS=--max-old-space-size=8192 \
  -e RMD_RESTART_THROTTLE_S=120 \
  -e RMD_FRESHNESS_RESTART_MAX=100 \
  -v /home/craigoleyagent/.codex:/home/node/.codex \
  -v /home/craigoleyagent/.config/remudero-container:/home/node/.config/remudero \
  -v "$STATE_DIR":/home/node/Remudero \
  -v /home/craigoleyagent/.claude:/home/node/.claude \
  "$IMAGE" \
  ./bin/rmd daemon --repo remudero --allow-self-target

echo "rmd-relaunch: started remudero-daemon (boot=$BOOT)"
