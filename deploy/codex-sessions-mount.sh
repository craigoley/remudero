#!/usr/bin/env bash
# codex-sessions-mount — bind an instance's Codex sessions from the persistent data disk (W1-T9071).
#
# Every daemon container binds the host's ~/.codex, whose sessions/ grew ~565 MB a day on the root
# disk. The login and the Codex databases in ~/.codex are shared by every instance, so only
# sessions/ moves, and only for an instance whose own stopped-window copy
# (deploy/recycle-actions/codex-sessions-to-data-disk.sh) succeeded: that copy writes
# <state-dir>/codex-sessions.ready naming the destination. Until then this plans nothing, so a
# reboot or watchdog relaunch never hides sessions the instance still needs.
#
# Sourced by every launcher (recycle-container.sh, host-update.sh --print-daemon-run, the rendered
# rmd-relaunch) so the three agree. Changes nothing on disk.
# USAGE  . codex-sessions-mount.sh; codex_sessions_plan <state-dir>
# SETS   CODEX_SESSIONS_ARGS (docker run arguments, empty when not ready), CODEX_SESSIONS_SRC,
#        CODEX_SESSIONS_NOTE. Returns 1 when nothing is planned.

CODEX_SESSIONS_DEST="/home/node/.codex/sessions"
CODEX_SESSIONS_READY_NAME="codex-sessions.ready"

codex_sessions_plan() {
  local state_dir="$1" ready src
  CODEX_SESSIONS_ARGS=()
  CODEX_SESSIONS_SRC=""
  ready="${state_dir}/${CODEX_SESSIONS_READY_NAME}"
  if [ ! -r "${ready}" ]; then
    CODEX_SESSIONS_NOTE="not moved (no ${CODEX_SESSIONS_READY_NAME}): Codex sessions stay in the Codex home"
    return 1
  fi
  src="$(head -n 1 "${ready}")"
  case "${src}" in
    /*) ;;
    *) CODEX_SESSIONS_NOTE="NOT USED — ${ready} names no absolute directory"; return 1 ;;
  esac
  if [ ! -d "${src}" ]; then
    CODEX_SESSIONS_NOTE="NOT USED — ${src} (from ${ready}) is missing; Codex sessions stay in the Codex home"
    return 1
  fi
  CODEX_SESSIONS_SRC="${src}"
  CODEX_SESSIONS_ARGS=(-v "${src}:${CODEX_SESSIONS_DEST}")
  CODEX_SESSIONS_NOTE="from ${src}"
  return 0
}
