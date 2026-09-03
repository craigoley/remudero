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
#   RMD_CLAUDE_JSON_PATH=/path ./deploy/serve-container.sh   # if ~/.claude.json is not the host's
#   RMD_GITHUB_WEBHOOK_SECRET_PATH=/path ./deploy/serve-container.sh   # arm POST /v1/hooks/github
#
# W1-T2434: THE ACCOUNT FILE, MOUNTED READ-ONLY AND WIRED THROUGH THE SEAM W1-T997 ALREADY BUILT.
# `readAccountUsageFile` (src/lib/account-usage.ts) reads `~/.claude.json` for the console's
# ACCOUNT strip — email/uuid/org plus the cached usage windows. Under this container's own
# `HOME=/home/node` that path has never existed: nothing here mounted it, so every request read
# `unreadable` and the strip named no account at all, even though the identical file sits, fresh,
# on the host that launches this script (the same host `remudero-daemon` reads its credentials
# from — see `deploy/recycle-container.sh`'s `CRED_DIR`). `resolveAccountFilePath`/
# `RMD_ACCOUNT_FILE_PATH` (serve.ts, W1-T997) were built for exactly this and were never supplied
# by any deploy artifact (producer-completeness.ts's runtime-adoption audit named this gap
# directly). MOUNTED READ-ONLY, never read-write: unlike the daemon's credential directory (which
# self-refreshes and must stay writable), nothing in this container ever needs to write
# `.claude.json`, and CONTAINMENT is unaffected either way — `readAccountUsageFile` already
# projects out only six scalar fields and the parsed object never escapes that function. ABSENT IS
# NOT REFUSED: a host with no `.claude.json` yet starts and serves exactly as before this task,
# with the ACCOUNT strip reading "unknown" rather than the console failing to boot over a
# telemetry-only reading.
#
# W1-T2568: THE GITHUB WEBHOOK SECRET, MOUNTED READ-ONLY, SERVE ONLY, NEVER PRINTED (design vii).
# `src/lib/github-event-wake.ts`'s `POST /v1/hooks/github` verifies GitHub's `X-Hub-Signature-256`
# against a secret this script mounts read-only from the host — the SAME "mounted read-only when
# present, never refused when absent" shape section 4c above already uses for the account file,
# because the two failure modes are identical: a host that has not (yet) provisioned the file must
# still boot and serve exactly as before this task, with the webhook route shipping dark (a named
# `webhook_not_configured` refusal, never a boot failure). MOUNTED INTO THIS CONTAINER ONLY —
# `remudero-daemon` (recycle-container.sh) and every worker/task container never receive it: the
# daemon consumes the WAKE MARKER the shared state mount already carries, never the secret itself,
# and a worker has no legitimate reason to hold a credential that authenticates GitHub TO this
# fleet rather than this fleet to GitHub.
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
# W1-T2434: the host-side account file and where it lands in the container — see the header note
# above. Derived from `${HOME}` the same way `recycle-container.sh`'s `CRED_DIR` derives the
# daemon's credential directory, so both containers agree on whose `.claude.json` is authoritative
# without either retyping the other's default.
CLAUDE_JSON_PATH="${RMD_CLAUDE_JSON_PATH:-${HOME:-/root}/.claude.json}"
CLAUDE_JSON_MOUNT_DEST="/home/node/.claude.json"
# W1-T2568: the GitHub webhook secret — see the header note above. No default host path (unlike
# CLAUDE_JSON_PATH's `~/.claude.json` guess): a webhook secret has no conventional dotfile
# location, so this is opt-in ONLY, via an explicit RMD_GITHUB_WEBHOOK_SECRET_PATH — an empty
# value here is the "not yet provisioned" state, checked the same way CLAUDE_JSON_PATH's `-f`
# test is below.
GITHUB_WEBHOOK_SECRET_PATH="${RMD_GITHUB_WEBHOOK_SECRET_PATH:-}"
GITHUB_WEBHOOK_SECRET_MOUNT_DEST="/home/node/.rmd-github-webhook-secret"
# W1-T2778: one file, never the daemon's whole credential directory. The host-side source is
# resolved after GH_APP_* capture because a captured value names the daemon container's namespace.
APP_PRIVATE_KEY_MOUNT_DEST="/home/node/.rmd-github-app-private-key.pem"
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

# ── 4b. GH_APP_* — OPTIONAL, CAPTURED THE SAME WAY, NEVER REFUSED (W1-T2269) ────────────────────
# `src/lib/github-app.ts`'s `startInstallationTokenRefresh` lets the console mint its OWN
# installation tokens in-process, straight from GitHub's token-exchange endpoint — it never asks
# the daemon for one (a design constraint: a renewal path that reached INTO the daemon would make
# the console's `--restart=unless-stopped` lifetime depend on the daemon's, exactly what these two
# containers are split apart to avoid — see this file's own "WHY IT IS A SEPARATE CONTAINER" note
# above). Captured the SAME way GH_TOKEN is above — prefer this shell's own, else whatever the
# live daemon container's environment carries — because that IS how the running console holds
# these three today: inherited from whoever's shell happened to launch it, never from a committed
# script. This closes that: any launch through THIS script now carries them the same way GH_TOKEN
# always has, rather than only when the launching operator's shell happened to.
#
# ABSENT IS NOT REFUSED, on any of the three — mirrors `startInstallationTokenRefresh`'s own
# contract exactly: a console with none of them set starts and serves precisely as it did before
# this task, `GH_TOKEN` (whatever it holds at spawn) keeps authenticating every `gh`/`git` call,
# and the operator sees an explicit "static (no renewal configured)" chip on the board rather than
# a silent behaviour change. W1-T2778 resolves the configured path to one readable HOST file and
# mounts only that file below. If it cannot, the launch still degrades the same graceful way:
# `refreshInstallationToken` reports "private key unreadable", ledgers it, and leaves `GH_TOKEN`
# exactly as it found it — never a boot failure, never a masked one either (see the board chip).
for VAR_NAME in GH_APP_ID GH_APP_INSTALLATION_ID GH_APP_PRIVATE_KEY_PATH; do
  CURRENT="${!VAR_NAME:-}"
  if [ -n "${CURRENT}" ]; then
    export "${VAR_NAME}"
    echo "serve-container: ${VAR_NAME} from the invoking shell (value never printed, never written to disk)"
  elif [ -n "${DAEMON_STATE_DIR}" ]; then
    CAPTURED="$(docker inspect "${DAEMON_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
      | sed -n "s/^${VAR_NAME}=//p" | head -1 || true)"
    if [ -n "${CAPTURED}" ]; then
      printf -v "${VAR_NAME}" '%s' "${CAPTURED}"
      export "${VAR_NAME}"
      echo "serve-container: ${VAR_NAME} captured from ${DAEMON_CONTAINER} (value never printed, never written to disk)"
    fi
    unset CAPTURED
  fi
done
unset CURRENT VAR_NAME

# A value captured from remudero-daemon names a path in THAT container's mount namespace. Passing
# it through unchanged was W1-T2778's measured defect: Serve had all three env names, no `.claude`
# mount, and therefore no readable key. Translate through the daemon's ACTUAL mounts rather than
# assuming where the operator keeps credentials on the host. Longest destination wins so a nested
# mount is never shadowed by a broader parent. Paths are metadata, not secret material; key CONTENT
# is never read here.
daemon_host_path_for() {
  local CONTAINER_PATH="$1"
  local BEST_SOURCE=""
  local BEST_DEST=""
  local SOURCE=""
  local DEST=""
  while IFS=$'\t' read -r SOURCE DEST; do
    [ -n "${SOURCE}" ] && [ -n "${DEST}" ] || continue
    case "${CONTAINER_PATH}" in
      "${DEST}"|"${DEST}"/*)
        if [ "${#DEST}" -gt "${#BEST_DEST}" ]; then
          BEST_SOURCE="${SOURCE}"
          BEST_DEST="${DEST}"
        fi
        ;;
    esac
  done < <(docker inspect "${DAEMON_CONTAINER}" --format '{{range .Mounts}}{{printf "%s\t%s\n" .Source .Destination}}{{end}}' 2>/dev/null || true)
  if [ -z "${BEST_DEST}" ]; then
    return 1
  fi
  printf '%s%s\n' "${BEST_SOURCE}" "${CONTAINER_PATH:${#BEST_DEST}}"
}

APP_PRIVATE_KEY_ARGS=()
APP_KEY_DECLARED="${GH_APP_PRIVATE_KEY_PATH:-}"
APP_KEY_HOST=""
if [ -n "${APP_KEY_DECLARED}" ]; then
  if [ -f "${APP_KEY_DECLARED}" ] && [ -s "${APP_KEY_DECLARED}" ] && [ -r "${APP_KEY_DECLARED}" ]; then
    APP_KEY_HOST="${APP_KEY_DECLARED}"
  elif [ -n "${DAEMON_STATE_DIR}" ]; then
    APP_KEY_HOST="$(daemon_host_path_for "${APP_KEY_DECLARED}" || true)"
  fi
  if [ -n "${APP_KEY_HOST}" ] && [ -f "${APP_KEY_HOST}" ] && [ -s "${APP_KEY_HOST}" ] && [ -r "${APP_KEY_HOST}" ]; then
    APP_PRIVATE_KEY_ARGS=(-v "${APP_KEY_HOST}:${APP_PRIVATE_KEY_MOUNT_DEST}:ro")
    GH_APP_PRIVATE_KEY_PATH="${APP_PRIVATE_KEY_MOUNT_DEST}"
    export GH_APP_PRIVATE_KEY_PATH
    echo "serve-container: GitHub App private key mounted as one read-only file (content never read or printed)"
  else
    APP_KEY_HOST=""
    echo "serve-container: NOTE — configured GitHub App private key is unreadable or cannot be resolved through ${DAEMON_CONTAINER}'s mounts." >&2
    echo "  Not a refusal: GH_TOKEN remains the fallback and the console reports the refresh failure." >&2
  fi
fi
unset APP_KEY_DECLARED APP_KEY_HOST

# ── 4c. THE ACCOUNT FILE — MOUNTED READ-ONLY WHEN PRESENT, NEVER REFUSED WHEN ABSENT (W1-T2434) ──
# See the header note for the defect this closes. `-f` (a regular file, not a directory) is the
# right test: `~/.claude.json` is a FILE beside `~/.claude/`, never the directory itself, and a
# host where the two got swapped should read as "absent" rather than mount the wrong thing.
ACCOUNT_FILE_ARGS=()
if [ -f "${CLAUDE_JSON_PATH}" ]; then
  ACCOUNT_FILE_ARGS=(-v "${CLAUDE_JSON_PATH}:${CLAUDE_JSON_MOUNT_DEST}:ro" -e "RMD_ACCOUNT_FILE_PATH=${CLAUDE_JSON_MOUNT_DEST}")
  echo "serve-container: account file ${CLAUDE_JSON_PATH} -> ${CLAUDE_JSON_MOUNT_DEST} (read-only)"
else
  echo "serve-container: NOTE — no account file at ${CLAUDE_JSON_PATH}; the ACCOUNT strip will read unknown." >&2
  echo "  Not a refusal: identity is telemetry, not a serving requirement. Set RMD_CLAUDE_JSON_PATH" >&2
  echo "  if the operator's ~/.claude.json lives somewhere else on this host." >&2
fi

# ── 4d. THE GITHUB WEBHOOK SECRET — MOUNTED READ-ONLY WHEN PRESENT, NEVER REFUSED WHEN ABSENT
# (W1-T2568) — see the header note. `-f`, matching the account-file check above: a regular file,
# never a directory. Reports PRESENCE only — the content is never echoed by this script, by
# `rmd serve`'s own boot banner, or by any ledger line `github-event-wake.ts` writes.
GITHUB_WEBHOOK_SECRET_ARGS=()
if [ -n "${GITHUB_WEBHOOK_SECRET_PATH}" ] && [ -f "${GITHUB_WEBHOOK_SECRET_PATH}" ]; then
  GITHUB_WEBHOOK_SECRET_ARGS=(-v "${GITHUB_WEBHOOK_SECRET_PATH}:${GITHUB_WEBHOOK_SECRET_MOUNT_DEST}:ro" -e "RMD_GITHUB_WEBHOOK_SECRET_FILE=${GITHUB_WEBHOOK_SECRET_MOUNT_DEST}")
  echo "serve-container: github webhook secret ${GITHUB_WEBHOOK_SECRET_PATH} -> ${GITHUB_WEBHOOK_SECRET_MOUNT_DEST} (read-only, content never printed)"
else
  echo "serve-container: NOTE — no github webhook secret mounted; POST /v1/hooks/github ships dark (webhook_not_configured)." >&2
  echo "  Not a refusal: the console starts and serves exactly as before this task. Set" >&2
  echo "  RMD_GITHUB_WEBHOOK_SECRET_PATH to a host file to arm the GitHub-event wake — see" >&2
  echo "  docs/operator-guide.md's webhook commissioning section." >&2
fi

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
  -e GH_APP_ID
  -e GH_APP_INSTALLATION_ID
  -e GH_APP_PRIVATE_KEY_PATH
  -e "RMD_SERVE_NETWORK=${SERVE_NETWORK_ENV_VALUE}"
  -v "${STATE_DIR}:${STATE_MOUNT_DEST}"
  # W1-T2778: same bash-3.2-safe optional-array form as the two optional mounts below. This is
  # exactly one regular, non-empty, host-readable key file and is always read-only.
  "${APP_PRIVATE_KEY_ARGS[@]+"${APP_PRIVATE_KEY_ARGS[@]}"}"
  # W1-T2434: the `[@]+"..."` form, not a bare `"${ACCOUNT_FILE_ARGS[@]}"`. Under `set -u` (line 1)
  # bash BEFORE 4.4 treats expanding an EMPTY array as an unbound variable and aborts the script —
  # MEASURED on bash 3.2.57, which is what `/usr/bin/env bash` resolves to on macOS: `EMPTY[@]:
  # unbound variable`, exit 1. That fires on exactly the ABSENT-account-file path this block's own
  # header promises is "not a refusal", so the bare form would refuse to launch the console on the
  # one host state it was written to tolerate. The production host is bash 5.2.21 (measured) where
  # either form works; this one works on both.
  "${ACCOUNT_FILE_ARGS[@]+"${ACCOUNT_FILE_ARGS[@]}"}"
  # W1-T2568: same bash-3.2-safe empty-array form as ACCOUNT_FILE_ARGS immediately above — see
  # that splice's own comment for why the bare `"${ARR[@]}"` form is unsafe under `set -u`.
  "${GITHUB_WEBHOOK_SECRET_ARGS[@]+"${GITHUB_WEBHOOK_SECRET_ARGS[@]}"}"
  "${REF}"
  ./bin/rmd serve --host "${SERVE_BIND_HOST}"
)

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "serve-container: --dry-run, nothing changed. The launch would be:"
  echo "  docker ${RUN_ARGS[*]}"
  echo "  (-e NAME passes the NAME only; each value is read from this script's own environment —"
  echo "   docker drops a name this script never set, so the three GH_APP_* names are optional.)"
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
