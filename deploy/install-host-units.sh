#!/usr/bin/env bash
# install-host-units — put the systemd units and launcher that make a VM a FLEET HOST under source
# control, so a second instance is provisioned rather than reconstructed from memory.
#
# THE GAP THIS CLOSES (W1-T2877). Everything below was installed BY HAND on the Azure host during
# the 2026-09-05 incidents and existed in no tracked file. A second instance provisioned from this
# repo therefore came up without reboot survival, without crash recovery, without a heap ceiling and
# without a heartbeat — and, because a host with no beat branch is SILENT BY DESIGN in
# fleet-heartbeat-watch.yml, an unmonitored instance looked exactly like a monitored healthy one.
#
# WHY A TRACKED INSTALLER BEATS A GOOD HAND FIX, MEASURED RATHER THAN ASSERTED. W1-T2856 did this
# for the container-runtime mount ordering. Running THAT installer against the same host whose
# drop-ins had been written by hand found two required paths the hand fix had missed: Docker's real
# data root (resolved from `docker info --format '{{.DockerRootDir}}'`, which is /mnt/rmd/docker
# here and NOT the assumed /var/lib/docker) and the device backing the containerd root. The hand fix
# was careful and still wrong; the tested one was not.
#
# ── WHAT THIS INSTALLS, AND THE FAILURE EACH ONE ANSWERS ──────────────────────────────────────────
#   rmd-relaunch.sh            the canonical daemon launcher. Derived from
#                              `deploy/host-update.sh --print-daemon-run`, which stays the source of
#                              truth for the invocation itself.
#   rmd-fleet.service          reboot survival. The daemon runs `--restart=on-failure:5` ON PURPOSE
#                              so a clean STOP (exit 0) is not undone by docker; that also means
#                              docker will NOT bring it back after a reboot, so this unit does.
#   rmd-fleet-watchdog.*       crash recovery. `on-failure:5` is a COUNT, NOT A RATE. On 2026-09-05
#                              six heap aborts exhausted it, docker stopped trying, and the fleet sat
#                              dead for three hours while PRs piled up green and unreviewed.
#   rmd-reap-stray.*           a leaked ad-hoc container spawned 158 nested daemons and held ~90% of
#                              a core; load hit 9.5 and sshd could not complete a handshake.
#
# THE LAUNCHER'S FOUR GUARDS ARE LOAD-BEARING AND A PORT THAT DROPS ANY OF THEM IS WORSE THAN NONE:
#   * refuses when state/STOP exists            — no timer or boot unit may undo a deliberate stop
#   * refuses when the state root is unmounted  — the 2026-09-05 fleet-wipe failure mode
#   * idempotent (no-op on a live daemon)       — a 5-minute timer must never disturb live workers
#   * appends a revival record                  — recreating the container RESETS docker's
#                                                 RestartCount, so without this, auto-recovery hides
#                                                 the very crash loop it is recovering from
#
# HOST-SPECIFIC VALUES ARE INPUTS, NOT CONSTANTS, AND AN UNRESOLVABLE ONE IS REFUSED RATHER THAN
# GUESSED. Defaults describe the current Azure host; a second instance overrides them. Guessing a
# state root is how PAUSE and STOP end up written where nothing reads them.
#
# USAGE
#   deploy/install-host-units.sh              # CHECK (default): report drift, change nothing, exit 1 if any
#   sudo deploy/install-host-units.sh --install
#
# OVERRIDES (all optional; the *_DIR ones exist so the test suite can run this against a temp tree)
#   RMD_STATE_DIR RMD_IMAGE RMD_SERVICE_USER RMD_NODE_MAX_OLD_SPACE_MB
#   RMD_GH_APP_ID RMD_GH_APP_INSTALLATION_ID RMD_GH_APP_PRIVATE_KEY_PATH
#   RMD_UNIT_DIR RMD_BIN_DIR RMD_LAUNCHER_PATH RMD_REVIVAL_LOG
set -euo pipefail

MODE="check"
[ "${1:-}" = "--install" ] && MODE="install"
[ "${1:-}" = "--help" ] && { sed -n '1,60p' "$0"; exit 0; }

# `${VAR-default}` NOT `${VAR:-default}` — WITHOUT THE COLON, ON PURPOSE. The colon form
# substitutes the default for an EMPTY value as well as an unset one, so `RMD_STATE_DIR=` would
# silently fall back to this host's path on a machine that is not this host — the exact "guess a
# state root" failure the refusal below exists to prevent. Omitting the colon preserves an
# explicitly-empty override so it reaches that refusal and exits 2.
STATE_DIR="${RMD_STATE_DIR-/home/craigoleyagent/rmd-state2}"
IMAGE="${RMD_IMAGE-synthwatcholey0620.azurecr.io/remudero:latest}"
SERVICE_USER="${RMD_SERVICE_USER-craigoleyagent}"
MAX_OLD_SPACE_MB="${RMD_NODE_MAX_OLD_SPACE_MB-4096}"
GH_APP_ID_V="${RMD_GH_APP_ID:-4648213}"
GH_APP_INST_V="${RMD_GH_APP_INSTALLATION_ID:-155256285}"
GH_APP_KEY_V="${RMD_GH_APP_PRIVATE_KEY_PATH:-/home/node/.claude/rmd-app.pem}"
UNIT_DIR="${RMD_UNIT_DIR:-/etc/systemd/system}"
BIN_DIR="${RMD_BIN_DIR:-/usr/local/bin}"
LAUNCHER="${RMD_LAUNCHER_PATH:-/home/${SERVICE_USER}/rmd-relaunch.sh}"
REVIVAL_LOG="${RMD_REVIVAL_LOG:-/home/${SERVICE_USER}/rmd-revivals.log}"

# REFUSE RATHER THAN GUESS. Same posture `--print-daemon-run` takes when it cannot find a ledger:
# a wrong state root is silent, and lands PAUSE/STOP where nothing reads them.
for pair in "STATE_DIR:$STATE_DIR" "IMAGE:$IMAGE" "SERVICE_USER:$SERVICE_USER" "MAX_OLD_SPACE_MB:$MAX_OLD_SPACE_MB"; do
  name="${pair%%:*}"; val="${pair#*:}"
  [ -n "$val" ] || { echo "install-host-units: FATAL — ${name} resolved to empty; pass RMD_${name}." >&2; exit 2; }
done
case "$MAX_OLD_SPACE_MB" in ''|*[!0-9]*) echo "install-host-units: FATAL — RMD_NODE_MAX_OLD_SPACE_MB must be an integer, got '${MAX_OLD_SPACE_MB}'." >&2; exit 2 ;; esac
case "$STATE_DIR" in /*) : ;; *) echo "install-host-units: FATAL — RMD_STATE_DIR must be absolute, got '${STATE_DIR}'." >&2; exit 2 ;; esac

render_launcher() {
  cat <<EOF
#!/usr/bin/env bash
# Canonical daemon launcher. GENERATED by deploy/install-host-units.sh — edit that, not this.
# The invocation itself is derived from: deploy/host-update.sh --print-daemon-run
# (run it with RMD_STATE_DIR set; its default points at a volume that may hold no ledger).
set -euo pipefail
STATE_DIR=${STATE_DIR}
IMAGE=${IMAGE}
REVIVAL_LOG=${REVIVAL_LOG}
BOOT=0
[ "\${1:-}" = "--boot" ] && BOOT=1

# THE STOP LEVER OUTRANKS THIS SCRIPT, INCLUDING AT BOOT AND FROM THE WATCHDOG.
if [ -e "\$STATE_DIR/state/STOP" ]; then
  echo "rmd-relaunch: state/STOP present -- refusing to start. rm it to resume."
  exit 0
fi

# IDEMPOTENT. A five-minute timer must never disturb a healthy daemon or its in-flight workers.
if [ -n "\$(docker ps -q -f name='^remudero-daemon\$' 2>/dev/null)" ]; then
  echo "rmd-relaunch: remudero-daemon already running -- nothing to do."
  exit 0
fi

# REFUSE AGAINST AN UNMOUNTED STATE ROOT -- the 2026-09-05 fleet-wipe failure mode.
if ! findmnt -no TARGET /mnt/rmd >/dev/null 2>&1; then
  echo "rmd-relaunch: FATAL -- /mnt/rmd is not mounted. Refusing to start against the bare OS disk." >&2
  exit 1
fi
if [ ! -s "\$STATE_DIR/state/ledger.ndjson" ]; then
  echo "rmd-relaunch: FATAL -- \$STATE_DIR/state/ledger.ndjson missing or empty; wrong volume?" >&2
  exit 1
fi

# A REVIVAL MUST LEAVE A TRACE. Recreating the container RESETS docker's RestartCount, so without
# this record a crash loop is invisible: every beat is fresh and every daemon is young.
printf '%s revive boot=%s prev_status=%s prev_exit=%s prev_restarts=%s\n' \\
  "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$BOOT" \\
  "\$(docker inspect remudero-daemon --format '{{.State.Status}}' 2>/dev/null || echo none)" \\
  "\$(docker inspect remudero-daemon --format '{{.State.ExitCode}}' 2>/dev/null || echo none)" \\
  "\$(docker inspect remudero-daemon --format '{{.RestartCount}}' 2>/dev/null || echo none)" \\
  >> "\$REVIVAL_LOG" 2>/dev/null || true

docker rm -f remudero-daemon >/dev/null 2>&1 || true

# --restart=on-failure:5 IS DELIBERATE: exit 0 is a STOP and must not be undone. Reboot survival is
# rmd-fleet.service; crash recovery past the budget is rmd-fleet-watchdog.timer.
# NODE_OPTIONS: without it V8 caps at ~2GB and the retro rung aborts at ~2046 MB on a 7.9GB host.
docker run -d --name remudero-daemon \\
  --restart=on-failure:5 \\
  --cap-drop ALL \\
  --security-opt seccomp=unconfined \\
  --security-opt apparmor=unconfined \\
  --security-opt systempaths=unconfined \\
  --user 1000:1000 \\
  -e GH_APP_ID=${GH_APP_ID_V} \\
  -e GH_APP_INSTALLATION_ID=${GH_APP_INST_V} \\
  -e GH_APP_PRIVATE_KEY_PATH=${GH_APP_KEY_V} \\
  -e NODE_OPTIONS=--max-old-space-size=${MAX_OLD_SPACE_MB} \\
  -e RMD_RESTART_THROTTLE_S=120 \\
  -e RMD_FRESHNESS_RESTART_MAX=100 \\
  -v /home/${SERVICE_USER}/.codex:/home/node/.codex \\
  -v /home/${SERVICE_USER}/.config/remudero-container:/home/node/.config/remudero \\
  -v "\$STATE_DIR":/home/node/Remudero \\
  -v /home/${SERVICE_USER}/.claude:/home/node/.claude \\
  "\$IMAGE" \\
  ./bin/rmd daemon --repo remudero --allow-self-target

echo "rmd-relaunch: started remudero-daemon (boot=\$BOOT)"
EOF
}

render_fleet_service() {
  cat <<EOF
[Unit]
Description=Remudero fleet daemon launcher (canonical invocation)
Requires=docker.service
After=docker.service network-online.target
# The daemon runs --restart=on-failure:5 so a DELIBERATE stop (exit 0) is not undone by docker.
# That also means docker will not bring it back after a clean reboot, so reboot survival is this
# unit's job. serve and cloudflared are unless-stopped and revive on their own.
RequiresMountsFor=/mnt/rmd ${STATE_DIR}

[Service]
Type=oneshot
RemainAfterExit=yes
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${LAUNCHER} --boot
Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
EOF
}

render_watchdog_service() {
  cat <<EOF
[Unit]
Description=Remudero fleet watchdog (revive a daemon docker has given up on)
# --restart=on-failure:5 caps the COUNT, not the rate: once five failures are spent docker NEVER
# tries again. On 2026-09-05 six heap aborts exhausted it and the fleet sat dead for three hours.
# The script is idempotent and refuses on state/STOP, so this cannot resurrect a deliberate stop.
RequiresMountsFor=/mnt/rmd ${STATE_DIR}
After=docker.service

[Service]
Type=oneshot
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${LAUNCHER}
EOF
}

render_watchdog_timer() {
  cat <<'EOF'
[Unit]
Description=Revive the Remudero daemon if docker has given up on it

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=rmd-fleet-watchdog.service

[Install]
WantedBy=timers.target
EOF
}

render_reaper_bin() {
  cat <<'EOF'
#!/bin/bash
# Reap ad-hoc rmd-* containers that outlived any legitimate run.
# GENERATED by deploy/install-host-units.sh — edit that, not this.
#
# WHY: 2026-09-04 a hand-run `docker run --name rmd-preflight-...` (no --rm) finished its suite and
# then spawned 158 nested self-hosting daemons over 7 hours, holding ~90% of a core on a 4-CPU box.
# Load hit 9.5, sshd could not complete a handshake, and the forced reboot that followed exposed a
# second defect that wiped the fleet.
#
# SCOPE IS DELIBERATELY NARROW. Only names beginning `rmd-` are candidates: the ad-hoc/preflight
# namespace. The long-lived fleet (remudero-daemon, remudero-serve, cloudflared) can never match,
# so this cannot take the fleet down.
#
# THE AGE GATE IS SIZED FROM A MEASUREMENT. A real `preflight --ci-parity` on the fleet host
# measured 24m48s (4386 tests, 0 failures). 4h is ~10x that, so a healthy run is never at risk;
# the leaked one had run 10h.
set -u
THRESHOLD_S=$((4*60*60))
now=$(date +%s)
for name in $(docker ps --format "{{.Names}}" | grep "^rmd-" || true); do
  started=$(docker inspect "$name" --format "{{.State.StartedAt}}" 2>/dev/null) || continue
  s=$(date -d "$started" +%s 2>/dev/null) || continue
  age=$(( now - s ))
  if [ "$age" -gt "$THRESHOLD_S" ]; then
    logger -t rmd-reap "removing stray container $name (age ${age}s > ${THRESHOLD_S}s)"
    docker rm -f "$name" >/dev/null 2>&1 && logger -t rmd-reap "removed $name"
  fi
done
EOF
}

render_reaper_service() {
  cat <<EOF
[Unit]
Description=Reap stray ad-hoc rmd-* containers

[Service]
Type=oneshot
ExecStart=${BIN_DIR}/rmd-reap-stray-containers
EOF
}

render_reaper_timer() {
  cat <<'EOF'
[Unit]
Description=Hourly sweep for stray ad-hoc rmd-* containers

[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
Unit=rmd-reap-stray.service

[Install]
WantedBy=timers.target
EOF
}

# path : renderer : mode
UNITS="
${LAUNCHER}:render_launcher:0755
${BIN_DIR}/rmd-reap-stray-containers:render_reaper_bin:0755
${UNIT_DIR}/rmd-fleet.service:render_fleet_service:0644
${UNIT_DIR}/rmd-fleet-watchdog.service:render_watchdog_service:0644
${UNIT_DIR}/rmd-fleet-watchdog.timer:render_watchdog_timer:0644
${UNIT_DIR}/rmd-reap-stray.service:render_reaper_service:0644
${UNIT_DIR}/rmd-reap-stray.timer:render_reaper_timer:0644
"

drift=0
for row in $UNITS; do
  [ -n "$row" ] || continue
  path="${row%%:*}"; rest="${row#*:}"; fn="${rest%%:*}"; mode="${rest##*:}"
  want="$("$fn")"
  if [ "$MODE" = "check" ]; then
    if [ ! -e "$path" ]; then
      echo "install-host-units: MISSING $path"
      drift=$(( drift + 1 ))
    elif [ "$want" != "$(cat "$path" 2>/dev/null)" ]; then
      echo "install-host-units: DRIFTED $path (installed content differs from what this repo renders)"
      drift=$(( drift + 1 ))
    else
      echo "install-host-units: ok      $path"
    fi
  else
    mkdir -p "$(dirname "$path")"
    tmp="${path}.tmp.$$"
    printf '%s\n' "$want" > "$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$path"                       # atomic: never a half-written unit
    echo "install-host-units: wrote   $path"
  fi
done

if [ "$MODE" = "check" ]; then
  if [ "$drift" -gt 0 ]; then
    echo "install-host-units: ${drift} unit(s) missing or drifted — re-run with --install (as root)." >&2
    exit 1
  fi
  echo "install-host-units: all units match this repo."
  exit 0
fi

# Only touch systemd when it is really systemd — the test suite renders into a temp tree.
if [ "$UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable rmd-fleet.service >/dev/null
  systemctl enable --now rmd-fleet-watchdog.timer >/dev/null
  systemctl enable --now rmd-reap-stray.timer >/dev/null
  echo "install-host-units: reloaded systemd and enabled rmd-fleet.service, rmd-fleet-watchdog.timer, rmd-reap-stray.timer"
  echo "install-host-units: NOTE — the daemon itself was not started or stopped; run ${LAUNCHER} to bring it up."
fi
