#!/usr/bin/env bash
# edge-heal — recreate remudero-serve and cloudflared when they are ABSENT, and roll a cloudflared
# that is off its PIN. The watchdog revives the daemons; nothing else recreated these two, so a
# Docker data-root on wiped scratch left the console dark. The core launcher
# (deploy/install-host-units.sh) calls this at the end of every clean tick. A present serve, and a
# present tunnel already on its pin, are left alone: one `docker container inspect` each.
#
# W1-T10844 -- THE TUNNEL FOLLOWS A PINNED IMAGE WITH NO GAP. `:latest` named whatever the host
# pulled once, and `--no-autoupdate` kept it there: 2026.8.3 survived seven weeks past Cloudflare's
# 2026.10.2 eMudhra floor. The image is now the one `FROM` line of deploy/cloudflared/Dockerfile
# (never built; Dependabot bumps it). A present tunnel off that pin is rolled REPLICA-FIRST: pull,
# run `cloudflared-next` on the same token, wait for its 4 `Registered tunnel connection` lines,
# replace the main and wait the same way, then remove the replica. A replica that never registers
# is removed with the main untouched; a main that fails leaves the replica serving. A failed roll
# exits 3 (the launcher raises the `tunnel-roll-failed` host alert on exactly that status) and is
# not retried for RMD_TUNNEL_ROLL_BACKOFF_S (1 h), so a broken pin cannot churn replicas per tick.
#
# The tunnel token is never in argv or env: cloudflared reads a read-only mounted file via
# `tunnel run --token-file` (cloudflared >= 2025.4.0). The image runs as uid 65532, so:
#   sudo install -d -m 0755 /etc/remudero
#   sudo install -m 0400 -o 65532 -g 65532 /dev/stdin /etc/remudero/cloudflared-token   # paste, ^D
#
# USAGE
#   deploy/edge-heal.sh                        # heal (the watchdog's call)
#   deploy/edge-heal.sh --migrate-cloudflared  # one-off: replace the live cloudflared with the token-file shape
# EXIT 0 healed (stdout names `tunnel on pin` when it is) | 1 a heal step failed | 3 a tunnel roll failed or is held
set -uo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_NAME="${RMD_SERVE_CONTAINER:-remudero-serve}"
TUNNEL_NAME="${RMD_TUNNEL_CONTAINER:-cloudflared}"
REPLICA_NAME="${TUNNEL_NAME}-next"
NETWORK="${RMD_SERVE_DOCKER_NETWORK:-rmd-net}"
PIN_FILE="${RMD_CLOUDFLARED_PIN_FILE:-${SCRIPT_ROOT}/deploy/cloudflared/Dockerfile}"
# Cloudflare's eMudhra notice (2026-10-26): older builds trust eight weak-key intermediates.
PIN_FLOOR="2026.10.2"
TUNNEL_IMAGE=""
TOKEN_FILE="${RMD_CLOUDFLARED_TOKEN_FILE:-/etc/remudero/cloudflared-token}"
TOKEN_DEST="/etc/cloudflared/token"
SERVE_SCRIPT="${RMD_SERVE_CONTAINER_SCRIPT:-${SCRIPT_ROOT}/deploy/serve-container.sh}"
# bound kind: physical -- 2026.10.x registered 4 connections in ~5 s on the live host (2026-10-27).
REGISTER_TIMEOUT_S="${RMD_TUNNEL_REGISTER_TIMEOUT_S:-120}"
REGISTER_POLL_S="${RMD_TUNNEL_REGISTER_POLL_S:-2}"
# bound kind: policy -- one roll attempt per hour, against a 5-minute tick.
ROLL_BACKOFF_S="${RMD_TUNNEL_ROLL_BACKOFF_S:-3600}"
ROLL_STAMP="${RMD_TUNNEL_ROLL_STAMP:-${RMD_STATE_DIR:-${HOME:-/root}/rmd-state}/state/tunnel-roll-failed}"
ROLL_FAILED=3

exists() { docker container inspect "$1" >/dev/null 2>&1; }

# The pin, or a named refusal. RMD_CLOUDFLARED_IMAGE overrides the file outright.
resolve_pin() {
  if [ -n "${RMD_CLOUDFLARED_IMAGE:-}" ]; then TUNNEL_IMAGE="${RMD_CLOUDFLARED_IMAGE}"; return 0; fi
  local froms ref ver
  if [ ! -r "${PIN_FILE}" ]; then
    echo "edge-heal: REFUSING ${TUNNEL_NAME} -- pin file ${PIN_FILE} is missing; nothing created or replaced." >&2
    return 1
  fi
  froms="$(grep -E '^[[:space:]]*FROM[[:space:]]' "${PIN_FILE}" || true)"
  ref="$(printf '%s\n' "${froms}" | sed -nE 's#^[[:space:]]*FROM[[:space:]]+(cloudflare/cloudflared:[0-9]{4}\.[0-9]{1,2}\.[0-9]+@sha256:[0-9a-f]{64})[[:space:]]*$#\1#p')"
  if [ "$(printf '%s\n' "${froms}" | grep -c .)" -ne 1 ] || [ -z "${ref}" ]; then
    echo "edge-heal: REFUSING ${TUNNEL_NAME} -- ${PIN_FILE} needs exactly one 'FROM cloudflare/cloudflared:<YYYY.M.P>@sha256:<64 hex>' line; nothing created or replaced." >&2
    return 1
  fi
  ver="${ref#cloudflare/cloudflared:}"; ver="${ver%@*}"
  if [ "$(printf '%s\n%s\n' "${PIN_FLOOR}" "${ver}" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" != "${PIN_FLOOR}" ]; then
    echo "edge-heal: REFUSING ${TUNNEL_NAME} -- pin ${ver} is below the ${PIN_FLOOR} security floor; nothing created or replaced." >&2
    return 1
  fi
  TUNNEL_IMAGE="${ref}"
}

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

# $1: the container name (default the main tunnel).
run_tunnel() {
  docker run -d --name "${1:-${TUNNEL_NAME}}" --restart=unless-stopped --network "${NETWORK}" \
    -v "${TOKEN_FILE}:${TOKEN_DEST}:ro" \
    "${TUNNEL_IMAGE}" tunnel --no-autoupdate run --token-file "${TOKEN_DEST}" >/dev/null
}

# The image is distroless (no exec probe): readiness is 4 `Registered tunnel connection` log lines.
registered() {
  local n
  n="$(docker logs "$1" 2>&1 | grep -c 'Registered tunnel connection')"
  [ "${n:-0}" -ge 4 ]
}

wait_registered() {
  local deadline=$(( $(date +%s) + REGISTER_TIMEOUT_S ))
  until registered "$1"; do
    [ "$(date +%s)" -lt "${deadline}" ] || return 1
    sleep "${REGISTER_POLL_S}"
  done
}

# One failed roll: stamp it (the backoff), name it on stdout for the launcher, exit status 3.
roll_failed() {
  mkdir -p "$(dirname "${ROLL_STAMP}")" 2>/dev/null && date +%s > "${ROLL_STAMP}" 2>/dev/null ||
    echo "edge-heal: could not write the roll backoff stamp ${ROLL_STAMP}" >&2
  echo "edge-heal: tunnel roll failed -- $1"
  echo "edge-heal: ${TUNNEL_NAME} roll FAILED -- $1" >&2
  return "${ROLL_FAILED}"
}

on_pin() {
  rm -f "${ROLL_STAMP}" 2>/dev/null || true
  echo "edge-heal: tunnel on pin ${TUNNEL_IMAGE}"
}

# A present tunnel off its pin ($1 = its image), rolled replica-first so the console never darkens.
roll_tunnel() {
  local stamped
  stamped="$(cat "${ROLL_STAMP}" 2>/dev/null || true)"
  case "${stamped}" in
    '' | *[!0-9]*) : ;;
    *)
      if [ $(( $(date +%s) - stamped )) -lt "${ROLL_BACKOFF_S}" ]; then
        echo "edge-heal: tunnel roll failed -- held: ${TUNNEL_NAME} runs $1, not the pin, and the last roll failed under ${ROLL_BACKOFF_S}s ago"
        echo "edge-heal: ${TUNNEL_NAME} is off its pin; roll HELD after a failed roll (${ROLL_STAMP})" >&2
        return "${ROLL_FAILED}"
      fi
      ;;
  esac
  token_file_ok || { echo "edge-heal: tunnel roll failed -- token file ${TOKEN_FILE} is missing or empty"; return "${ROLL_FAILED}"; }
  echo "edge-heal: ${TUNNEL_NAME} runs $1, not the pin ${TUNNEL_IMAGE} -- rolling replica-first"
  docker pull "${TUNNEL_IMAGE}" >/dev/null || { roll_failed "pull ${TUNNEL_IMAGE} failed; ${TUNNEL_NAME} untouched"; return; }
  docker rm -f "${REPLICA_NAME}" >/dev/null 2>&1 || true
  if ! run_tunnel "${REPLICA_NAME}" || ! wait_registered "${REPLICA_NAME}"; then
    docker rm -f "${REPLICA_NAME}" >/dev/null 2>&1 || true
    roll_failed "replica ${REPLICA_NAME} never registered within ${REGISTER_TIMEOUT_S}s; removed it, ${TUNNEL_NAME} untouched"
    return
  fi
  docker rm -f "${TUNNEL_NAME}" >/dev/null 2>&1 || true
  if ! run_tunnel "${TUNNEL_NAME}" || ! wait_registered "${TUNNEL_NAME}"; then
    roll_failed "the new ${TUNNEL_NAME} never registered within ${REGISTER_TIMEOUT_S}s; ${REPLICA_NAME} left serving"
    return
  fi
  docker rm -f "${REPLICA_NAME}" >/dev/null 2>&1 || true
  echo "edge-heal: ${TUNNEL_NAME} rolled to ${TUNNEL_IMAGE}"
  on_pin
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
  resolve_pin || return 1
  # ONE inspect answers both names: the main's image, and whether a replica is left over.
  local seen main present replica
  seen="$(docker container inspect --format '{{.Name}} {{.Config.Image}}' "${TUNNEL_NAME}" "${REPLICA_NAME}" 2>/dev/null || true)"
  main="$(printf '%s\n' "${seen}" | sed -n "s#^/${TUNNEL_NAME} ##p")"
  present="$(printf '%s\n' "${seen}" | grep -c "^/${TUNNEL_NAME} ")"
  replica="$(printf '%s\n' "${seen}" | grep -c "^/${REPLICA_NAME} ")"
  if [ "${present}" -gt 0 ]; then
    [ "${main}" = "${TUNNEL_IMAGE}" ] || { roll_tunnel "${main}"; return; }
    if [ "${replica}" -gt 0 ]; then
      registered "${TUNNEL_NAME}" || {
        echo "edge-heal: tunnel roll failed -- ${TUNNEL_NAME} is on its pin but not registered; ${REPLICA_NAME} left serving"
        return "${ROLL_FAILED}"
      }
      echo "edge-heal: ${TUNNEL_NAME} is registered on its pin -- removing the leftover ${REPLICA_NAME}"
      docker rm -f "${REPLICA_NAME}" >/dev/null 2>&1 || true
    fi
    on_pin
    return 0
  fi
  token_file_ok || return 1
  echo "edge-heal: ${TUNNEL_NAME} absent -- creating it from ${TOKEN_FILE}"
  ensure_network && run_tunnel || { echo "edge-heal: ${TUNNEL_NAME} create failed; the next tick re-asks." >&2; return 1; }
}

case "${1:-}" in
  "")
    rc=0
    heal_serve || rc=1
    heal_tunnel
    trc=$?
    [ "${trc}" -eq 0 ] || rc="${trc}"
    exit "${rc}"
    ;;
  --migrate-cloudflared)
    resolve_pin || exit 1
    token_file_ok || exit 1
    docker pull "${TUNNEL_IMAGE}" >/dev/null || { echo "edge-heal: pull ${TUNNEL_IMAGE} failed; ${TUNNEL_NAME} untouched." >&2; exit 1; }
    ensure_network || exit 1
    docker rm -f "${TUNNEL_NAME}" >/dev/null 2>&1 || true
    run_tunnel || { echo "edge-heal: ${TUNNEL_NAME} create failed -- the tunnel is DOWN; re-run this." >&2; exit 1; }
    echo "edge-heal: ${TUNNEL_NAME} recreated from ${TOKEN_FILE}"
    ;;
  *) echo "edge-heal: unknown argument $1" >&2; exit 2 ;;
esac
