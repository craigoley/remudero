#!/usr/bin/env bash
# edge-heal — recreate remudero-serve and cloudflared when they are ABSENT. The watchdog revives the
# daemons; nothing else recreated these two, so a Docker data-root on wiped scratch left the console
# dark. The core launcher (deploy/install-host-units.sh) calls this at the end of every clean tick.
# Present (running or stopped) is left alone: one `docker container inspect` each, nothing more.
#
# The tunnel token is never in argv or env: cloudflared reads a read-only mounted file via
# `tunnel run --token-file` (cloudflared >= 2025.4.0). The image runs as uid 65532, so:
#   sudo install -d -m 0755 /etc/remudero
#   sudo install -m 0400 -o 65532 -g 65532 /dev/stdin /etc/remudero/cloudflared-token   # paste, ^D
#
# USAGE
#   deploy/edge-heal.sh                        # heal (the watchdog's call)
#   deploy/edge-heal.sh --migrate-cloudflared  # one-off: replace the live cloudflared with the token-file shape
set -uo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_NAME="${RMD_SERVE_CONTAINER:-remudero-serve}"
TUNNEL_NAME="${RMD_TUNNEL_CONTAINER:-cloudflared}"
NETWORK="${RMD_SERVE_DOCKER_NETWORK:-rmd-net}"
TUNNEL_IMAGE="${RMD_CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}"
TOKEN_FILE="${RMD_CLOUDFLARED_TOKEN_FILE:-/etc/remudero/cloudflared-token}"
TOKEN_DEST="/etc/cloudflared/token"
SERVE_SCRIPT="${RMD_SERVE_CONTAINER_SCRIPT:-${SCRIPT_ROOT}/deploy/serve-container.sh}"

exists() { docker container inspect "$1" >/dev/null 2>&1; }

# Created only with no tunnel alive: a fresh network beside a live tunnel leaves it on the old one.
ensure_network() {
  docker network inspect "${NETWORK}" >/dev/null 2>&1 && return 0
  if [ "${1:-}" = tunnel-alive ]; then
    echo "edge-heal: REFUSING -- ${NETWORK} is absent while ${TUNNEL_NAME} exists; not creating it." >&2
    return 1
  fi
  echo "edge-heal: creating docker network ${NETWORK}"
  docker network create "${NETWORK}" >/dev/null
}

# stat-only checks: the service user need not (and should not) be able to read the token.
token_file_ok() {
  [ -f "${TOKEN_FILE}" ] && [ -s "${TOKEN_FILE}" ] && return 0
  echo "edge-heal: REFUSING ${TUNNEL_NAME} -- token file ${TOKEN_FILE} is missing or empty; nothing created." >&2
  return 1
}

run_tunnel() {
  docker run -d --name "${TUNNEL_NAME}" --restart=unless-stopped --network "${NETWORK}" \
    -v "${TOKEN_FILE}:${TOKEN_DEST}:ro" \
    "${TUNNEL_IMAGE}" tunnel --no-autoupdate run --token-file "${TOKEN_DEST}" >/dev/null
}

heal_serve() {
  exists "${SERVE_NAME}" && return 0
  echo "edge-heal: ${SERVE_NAME} absent -- running serve-container.sh"
  local alive=""
  exists "${TUNNEL_NAME}" && alive=tunnel-alive
  ensure_network "${alive}" || return 1
  "${SERVE_SCRIPT}" || { echo "edge-heal: serve-container.sh failed; the next tick re-asks." >&2; return 1; }
}

heal_tunnel() {
  exists "${TUNNEL_NAME}" && return 0
  token_file_ok || return 1
  echo "edge-heal: ${TUNNEL_NAME} absent -- creating it from ${TOKEN_FILE}"
  ensure_network && run_tunnel || { echo "edge-heal: ${TUNNEL_NAME} create failed; the next tick re-asks." >&2; return 1; }
}

case "${1:-}" in
  "")
    rc=0
    heal_serve || rc=1
    heal_tunnel || rc=1
    exit "${rc}"
    ;;
  --migrate-cloudflared)
    token_file_ok || exit 1
    docker pull "${TUNNEL_IMAGE}" >/dev/null || { echo "edge-heal: pull ${TUNNEL_IMAGE} failed; ${TUNNEL_NAME} untouched." >&2; exit 1; }
    ensure_network || exit 1
    docker rm -f "${TUNNEL_NAME}" >/dev/null 2>&1 || true
    run_tunnel || { echo "edge-heal: ${TUNNEL_NAME} create failed -- the tunnel is DOWN; re-run this." >&2; exit 1; }
    echo "edge-heal: ${TUNNEL_NAME} recreated from ${TOKEN_FILE}"
    ;;
  *) echo "edge-heal: unknown argument $1" >&2; exit 2 ;;
esac
