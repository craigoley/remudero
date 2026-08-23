#!/usr/bin/env bash
# serve-container — create (or replace) the `remudero-serve` container: the operator console's
# only deployment on this fleet.
#
# WHY THIS EXISTS. The console at console.remudero.com was REACHABLE and NOTHING IN THIS REPO
# RECORDED HOW. The container was launched by hand; its shape survived only in the running
# container's own `docker inspect` output, which is lost the moment anyone runs `docker rm`. The
# one written trace was a doc comment in `resolveServeHosts` (src/lib/serve.ts) that names this
# container as a thing that exists — "`remudero-serve` closes the measured defect by SETTING
# `RMD_SERVE_HOST=0.0.0.0` and `RMD_SERVE_NETWORK=container` in its own launch config" — while no
# launch config existed anywhere. This file is that launch config. Its sibling
# `deploy/recycle-container.sh` does the same job for `remudero-daemon`, and the two are
# deliberately separate scripts because they replace separate containers (see below).
#
# THE TWO NON-OBVIOUS PARTS. Neither is discoverable from the container's flags alone, and getting
# either wrong produces a console that starts cleanly and answers nobody:
#
#   1. THE WILDCARD IS PERMITTED BY THE ENV VAR AND SELECTED BY THE FLAG — BOTH ARE REQUIRED.
#      `assertBindableHost` (src/lib/serve.ts, W1-T915) refuses `0.0.0.0` outright unless
#      `RMD_SERVE_NETWORK=container` is set, and setting that variable does NOT itself choose the
#      wildcard: with it set and no `--host`, `resolveServeHosts` still returns loopback, because
#      its default is unchanged, containerized or not ("exposure must be typed, never inherited").
#      So `-e RMD_SERVE_NETWORK=container` PERMITS and `--host 0.0.0.0` SELECTS, and a launch
#      carrying only one of the two is either refused at boot or binds loopback and is unreachable
#      from the tunnel. Loopback is the wrong bind here for a reason that has nothing to do with
#      trust: a sibling container reaches this one over its address INSIDE the container network
#      namespace, never over its loopback, so `127.0.0.1` answers no one but the container itself.
#
#   2. THE CONTAINER MUST BE ON THE SAME DOCKER NETWORK AS THE TUNNEL, BECAUSE THE TUNNEL RESOLVES
#      IT BY NAME. cloudflared's ingress rule for console.remudero.com points at
#      `http://remudero-serve:4317` — a NAME, resolved by Docker's embedded DNS, which only
#      answers for containers that share a user-defined network. `rmd-net` is that network. A
#      console on the default bridge has an address and no name, so the tunnel fails to resolve it
#      and the public hostname 502s while the container looks perfectly healthy from the host.
#      This is also why nothing here publishes a port: `-p` is not how the console is reached, and
#      adding one would put a bearer-token-guarded write surface on every network the HOST joins,
#      which is exactly the exposure W1-T915's refusal exists to prevent.
#
# WHY IT IS A SEPARATE CONTAINER FROM THE DAEMON, AND NOT A SECOND PROCESS INSIDE IT. The daemon
# container restarts itself constantly by design: `deploy/entrypoint.sh` relaunches on exit code 75
# (freshness) in-container, so docker's own restart budget is not spent. MEASURED on this host from
# the live container's log: 25 freshness restarts on 2026-08-22 and 25 on 2026-08-21, median gap
# ~39 minutes and the shortest 3. A serve process sharing that container would die on every one of
# them, so the console would be down for a few seconds several dozen times a day and would go down
# permanently whenever a restart wedged — precisely when an operator most needs the board. Separate
# containers also mean separate restart policies, and they carry different ones on purpose:
# `unless-stopped` here (a console that stops answering must come back, and there is no budget to
# exhaust) against the daemon's `on-failure:5`.
#
# NEVER RUN THIS FROM INSIDE THE IMAGE. `deploy/Dockerfile` COPYs the whole repo into `/app`, so
# this file lands inside the container like every other tracked path; that copy is incidental and
# must never be the invocation path. Section 1 refuses outright if it finds itself inside one.
#
# PLAIN BASH AND DOCKER, deliberately — the same discipline as `deploy/recycle-container.sh`,
# `deploy/host-update.sh` and `deploy/verify-image.sh`. It runs on a host that may have no node, no
# `rmd` and no checkout, and it must keep working when the thing it is inspecting is broken. An
# `rmd` verb cannot fill this role: every verb runs `checkCliFreshness` (src/lib/self-sync.ts),
# which fast-forwards the very checkout this container bind-mounts.
#
# THE TOKEN IS NEVER PRINTED, NEVER WRITTEN TO DISK, AND NEVER PUT IN ARGV. `-e GH_TOKEN` is passed
# by NAME, not as `-e GH_TOKEN=<value>`: docker reads the value out of this script's own
# environment, so it never appears in the process table where any user on the host can read it with
# `ps`. That is also what makes `--dry-run` safe to paste into a chat window.
#
# USAGE
#   ./deploy/serve-container.sh                    # create it; refuses if one already exists
#   ./deploy/serve-container.sh --replace          # stop + rm the existing one first
#   ./deploy/serve-container.sh --dry-run          # print the docker run, change nothing
#   TAG=<sha> ./deploy/serve-container.sh          # pin a build instead of :latest
#   RMD_STATE_DIR=/path ./deploy/serve-container.sh    # if the bind mount is not the daemon's
set -euo pipefail

REGISTRY="${REGISTRY:-synthwatcholey0620}"
IMAGE="${IMAGE:-remudero}"
TAG="${TAG:-latest}"
REF="${REGISTRY}.azurecr.io/${IMAGE}:${TAG}"

CONTAINER_NAME="${RMD_SERVE_CONTAINER:-remudero-serve}"
DAEMON_CONTAINER="${RMD_DAEMON_CONTAINER:-remudero-daemon}"
TUNNEL_CONTAINER="${RMD_TUNNEL_CONTAINER:-cloudflared}"
NETWORK="${RMD_SERVE_DOCKER_NETWORK:-rmd-net}"

STATE_MOUNT_DEST="/home/node/Remudero"
SERVE_PORT="${RMD_SERVE_PORT:-4317}"
# The pair from part 1 of the header. Both are named here, next to each other, so a future edit
# cannot drop one and leave a launch that boots and binds the wrong interface.
SERVE_BIND_HOST="0.0.0.0"
SERVE_NETWORK_ENV_VALUE="container"

BANNER_WAIT_S="${RMD_SERVE_BANNER_WAIT_S:-60}"
BANNER_POLL_S="${RMD_SERVE_BANNER_POLL_S:-3}"
DOCKERENV_PATH="${RMD_SERVE_DOCKERENV_PATH:-/.dockerenv}"

REPLACE=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --replace)   REPLACE=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --tag)       TAG="${2:?--tag needs a value}"; REF="${REGISTRY}.azurecr.io/${IMAGE}:${TAG}"; shift 2 ;;
    -h|--help)   sed -n '1,80p' "$0"; exit 0 ;;
    *)           echo "serve-container: unknown argument $1" >&2; exit 2 ;;
  esac
done

# ── 1. REFUSE TO RUN INSIDE A CONTAINER ─────────────────────────────────────────────────────────
# Same refusal, same reason, as recycle-container.sh section 1: this file is COPYed into the image
# incidentally and a run from in there would be operating on the docker socket of a host it cannot
# see, or on nothing at all.
if [ -f "${DOCKERENV_PATH}" ]; then
  echo "serve-container: REFUSING — this is running INSIDE a container (${DOCKERENV_PATH} exists)." >&2
  echo "  Run it from the host shell. deploy/Dockerfile copies this file in incidentally; that copy" >&2
  echo "  is never the invocation path." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "serve-container: REFUSING — no docker on PATH." >&2
  exit 1
fi

# ── 2. THE NETWORK MUST ALREADY EXIST, AND THIS SCRIPT DOES NOT CREATE IT ───────────────────────
# Part 2 of the header: name resolution is the whole mechanism, and it is a property of the
# network, not of this container. Creating one silently would produce a NEW empty network with the
# right name and the tunnel on the old one — a console that resolves nothing, reported as success.
if ! docker network inspect "${NETWORK}" >/dev/null 2>&1; then
  echo "serve-container: REFUSING — docker network ${NETWORK} does not exist." >&2
  echo "  The tunnel resolves this container BY NAME over that network; a console anywhere else is" >&2
  echo "  unreachable no matter how it binds. Create it deliberately, then re-run:" >&2
  echo "    docker network create ${NETWORK}" >&2
  exit 1
fi

# ── 3. THE STATE MOUNT MUST BE THE DAEMON'S, NOT A LOOKALIKE ────────────────────────────────────
# The console renders the fleet it can READ. Pointed at a different tree it comes up healthy and
# shows a different fleet's board — the hardest failure here to see, because nothing errors. So the
# source of truth is the LIVE daemon container's own mount, read off it rather than retyped; an
# explicit RMD_STATE_DIR must AGREE with it when a daemon exists, and only stands alone when no
# daemon does (a first-run host, where there is nothing to disagree with).
DAEMON_STATE_DIR=""
if docker inspect "${DAEMON_CONTAINER}" >/dev/null 2>&1; then
  DAEMON_STATE_DIR="$(docker inspect "${DAEMON_CONTAINER}" \
    --format "{{range .Mounts}}{{if eq .Destination \"${STATE_MOUNT_DEST}\"}}{{.Source}}{{end}}{{end}}" 2>/dev/null || true)"
fi
STATE_DIR="${RMD_STATE_DIR:-${DAEMON_STATE_DIR:-${HOME:-/root}/rmd-state}}"

if [ -n "${DAEMON_STATE_DIR}" ] && [ "${STATE_DIR}" != "${DAEMON_STATE_DIR}" ]; then
  echo "serve-container: REFUSING — the state mount disagrees with the running daemon." >&2
  echo "  ${DAEMON_CONTAINER} mounts: ${DAEMON_STATE_DIR}" >&2
  echo "  this run would mount:      ${STATE_DIR}" >&2
  echo "  A console on a different tree renders a different fleet and reports no error at all." >&2
  exit 1
fi
if [ ! -d "${STATE_DIR}" ]; then
  echo "serve-container: REFUSING — state dir ${STATE_DIR} does not exist." >&2
  echo "  Set RMD_STATE_DIR to the tree the fleet actually uses." >&2
  exit 1
fi

# ── 4. GH_TOKEN — CAPTURED, NEVER RETYPED, NEVER PRINTED ────────────────────────────────────────
# The console reads GitHub for the board. The token exists only in an environment: this shell's, or
# the live daemon container's (deploy/entrypoint.sh deliberately never writes it to disk). Prefer
# the shell's, fall back to the daemon's, refuse if neither has one — a console launched without it
# starts and then fails every read, which reads as "GitHub is down" rather than "no credential".
GH_TOKEN_SOURCE="the invoking shell"
if [ -z "${GH_TOKEN:-}" ] && [ -n "${DAEMON_STATE_DIR}" ]; then
  CAPTURED="$(docker inspect "${DAEMON_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^GH_TOKEN=//p' | head -1 || true)"
  if [ -n "${CAPTURED}" ]; then
    GH_TOKEN="${CAPTURED}"
    GH_TOKEN_SOURCE="captured from ${DAEMON_CONTAINER}"
  fi
  unset CAPTURED
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "serve-container: REFUSING — no GH_TOKEN in this shell and none capturable from ${DAEMON_CONTAINER}." >&2
  echo "  Supply it for this invocation only:  GH_TOKEN=<token> $0" >&2
  exit 1
fi
export GH_TOKEN
echo "serve-container: GH_TOKEN ${GH_TOKEN_SOURCE} (value never printed, never written to disk)"

# ── 5. AN EXISTING CONTAINER IS NEVER SILENTLY REPLACED ─────────────────────────────────────────
# Replacing the console is a deliberate act: it is frequently the only surface an operator has on a
# fleet they are away from, and this script is also the natural thing to re-run "just to check".
#
# --dry-run is exempt from the refusal, not from the report: a dry run must stay runnable on the
# host that already HAS a console — that is the host you want to inspect the launch on — so it
# prints what a real run would do AND that a real run would refuse. A --dry-run that exits 1
# because the thing it is describing exists teaches an operator to stop using it.
CONTAINER_EXISTS=0
if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  CONTAINER_EXISTS=1
fi
if [ "${CONTAINER_EXISTS}" -eq 1 ] && [ "${REPLACE}" -ne 1 ] && [ "${DRY_RUN}" -ne 1 ]; then
  echo "serve-container: REFUSING — ${CONTAINER_NAME} already exists." >&2
  echo "  Re-run with --replace to stop and remove it first. Nothing has been changed." >&2
  exit 1
fi

RUN_ARGS=(
  run -d --name "${CONTAINER_NAME}"
  --restart=unless-stopped
  --network "${NETWORK}"
  --user 1000:1000
  -e GH_TOKEN
  -e "RMD_SERVE_NETWORK=${SERVE_NETWORK_ENV_VALUE}"
  -v "${STATE_DIR}:${STATE_MOUNT_DEST}"
  "${REF}"
  ./bin/rmd serve --host "${SERVE_BIND_HOST}"
)

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "serve-container: --dry-run, nothing changed. The launch would be:"
  echo "  docker ${RUN_ARGS[*]}"
  echo "  (-e GH_TOKEN passes the NAME; the value is read from this script's environment.)"
  if [ "${CONTAINER_EXISTS}" -eq 1 ] && [ "${REPLACE}" -ne 1 ]; then
    echo "  NOTE: ${CONTAINER_NAME} already exists — a real run would REFUSE without --replace."
  fi
  exit 0
fi

if [ "${CONTAINER_EXISTS}" -eq 1 ]; then
  echo "serve-container: docker stop ${CONTAINER_NAME}"
  docker stop "${CONTAINER_NAME}" >/dev/null
  echo "serve-container: docker rm ${CONTAINER_NAME}"
  docker rm "${CONTAINER_NAME}" >/dev/null
fi

echo "serve-container: docker run -d --name ${CONTAINER_NAME} ${REF}"
docker "${RUN_ARGS[@]}" >/dev/null

# ── 6. PROVE THE THREE THINGS THAT ACTUALLY DECIDE REACHABILITY ─────────────────────────────────
# A container that started is not a console that answers. Each check below is one of the ways this
# deployment has silently failed to be reachable, checked directly rather than assumed.
FAIL=0

RUNNING="$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo false)"
if [ "${RUNNING}" != "true" ]; then
  echo "serve-container: FAILED — ${CONTAINER_NAME} is not running." >&2
  FAIL=1
fi

ON_NET="$(docker inspect --format "{{if index .NetworkSettings.Networks \"${NETWORK}\"}}yes{{end}}" "${CONTAINER_NAME}" 2>/dev/null || true)"
if [ "${ON_NET}" != "yes" ]; then
  echo "serve-container: FAILED — ${CONTAINER_NAME} is not attached to ${NETWORK}, so the tunnel cannot resolve its name." >&2
  FAIL=1
fi

# THE BANNER IS MATCHED, NEVER ECHOED. `rmd serve`'s startup banner prints the console URL WITH the
# read token in the query string; this greps for the bind line and prints only its own verdict. The
# operator guide's own rule — a token that reached a terminal transcript is compromised and must be
# rotated — applies to this script as much as to a human.
BANNER_RE="listening on http://${SERVE_BIND_HOST}:${SERVE_PORT}"
waited=0
BANNER_SEEN=0
while [ "${waited}" -lt "${BANNER_WAIT_S}" ]; do
  if docker logs "${CONTAINER_NAME}" 2>&1 | grep -qF "${BANNER_RE}"; then
    BANNER_SEEN=1
    break
  fi
  sleep "${BANNER_POLL_S}"
  waited=$((waited + BANNER_POLL_S))
done
if [ "${BANNER_SEEN}" -eq 1 ]; then
  echo "serve-container: bound ${SERVE_BIND_HOST}:${SERVE_PORT} (banner matched, not printed — it carries the read token)"
else
  echo "serve-container: FAILED — no \"${BANNER_RE}\" in the log after ${BANNER_WAIT_S}s." >&2
  echo "  Read the log yourself, and treat anything you see there as exposed:  docker logs ${CONTAINER_NAME}" >&2
  FAIL=1
fi

# The tunnel is reported, never managed. cloudflared is configured remotely (it runs from a tunnel
# token, so its ingress rules live in Cloudflare, not in a file on this host); all this script can
# check locally is the half that IS local — that both ends share the network the name is resolved on.
if ! docker network inspect "${NETWORK}" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -qw "${TUNNEL_CONTAINER}"; then
  echo "serve-container: WARNING — ${TUNNEL_CONTAINER} is not on ${NETWORK}." >&2
  echo "  The console is up, but the public hostname will not resolve it until the tunnel joins:" >&2
  echo "    docker network connect ${NETWORK} ${TUNNEL_CONTAINER}" >&2
fi

if [ "${FAIL}" -ne 0 ]; then
  exit 1
fi

echo "serve-container: OK — ${CONTAINER_NAME} on ${NETWORK}, state ${STATE_DIR}, image ${REF}"
echo "  The console URL carries the read token; read it from the log or from"
echo "  ${STATE_DIR}/state/service-tokens.json (0600) rather than pasting it anywhere."
