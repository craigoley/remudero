#!/usr/bin/env bash
# recycle-container — replace the running remudero-daemon container with a freshly pulled image.
#
# WHY THIS EXISTS. Until now the recycle was seven steps that lived only in chat, and skipping any
# ONE of them took the fleet down TWICE in one day:
#   - A recycle that did not clear `state/drain.lock` left it holding a dead container's pid/host.
#     Every boot of the replacement printed "a drain/daemon is already running", exited 1 (not the
#     freshness code, 75), and spent docker's `--restart=on-failure:5` budget to `count=5 exited`.
#     A human had to read the lock, confirm the container was gone, and delete it by hand.
#   - A SECOND recycle, run without pausing first, found three workers mid-run. Killing them would
#     have lost the work and stranded their `state/inflight/*.lock` files.
#   - A `docker pull` failed with "authentication required" and the recycle SILENTLY relaunched the
#     cached image under the same tag — the operator believed he had the new build and did not.
#
# So THE REFUSALS BELOW ARE THE DELIVERABLE, not the happy path. Four of them, each closing one of
# the failures above:
#   1. NO GH_TOKEN CAPTURED -> REFUSE BEFORE TOUCHING ANYTHING. It exists only in the running
#      container's environment (`-e GH_TOKEN=...`, never written to disk — see deploy/entrypoint.sh)
#      and is unrecoverable afterwards without an operator, so this is the FIRST check in the file,
#      ahead of even the pull.
#   2. WORKERS STILL RUNNING PAST A BOUNDED WAIT -> REFUSE, AND REMOVE THE PAUSE ON THE WAY OUT. A
#      refusal that leaves the fleet paused forever is a second outage on top of the first.
#   3. `docker pull` NON-ZERO -> REFUSE. NEVER FALL THROUGH TO A START. This is the exact 2026-08-18
#      incident: a failed pull must never be followed by `docker run` on whatever is already cached.
#   4. THE STARTED CONTAINER'S IMAGE ID DOES NOT MATCH THE DIGEST JUST PULLED -> report it as a
#      FAILED RECYCLE, not a successful one. A container that started is not proof it started on the
#      image this run just obtained.
#
# THE ORDER IS LOAD-BEARING, and each constraint has a different reason (see the numbered sections
# below): the token must be captured before `docker rm` because it cannot be recovered after; the
# pause must go on before the wait, or the wait watches a fleet still admitting work; and it must
# come OFF before the start, because the new container reads the SAME bind mount and would
# otherwise come up paused — the marker is a file in shared state, not process state.
#
# NEVER RUN THIS FROM INSIDE THE IMAGE. `deploy/Dockerfile` COPYs the whole repo into `/app`, so
# this file lands inside the container like every other tracked path — that copy is incidental and
# must never be the invocation path. A recycle executed inside the container it removes cannot
# outlive `docker rm`; this file is not baked to a `PATH` location (unlike `deploy/entrypoint.sh`,
# the one script that IS), and section 1 below refuses outright if it ever finds itself running
# inside one.
#
# THE LOCK IS PRINTED, NEVER DECIDED (section 2). Every lock under `state/` that would block a boot
# is displayed in full — holder pid, host, startedAt — and this script does not delete it and does
# not judge it. That is not a temporary gap waiting on more code: `isHolderStale`'s container branch
# (src/lib/fs-race-safe.ts, W1-T978) answers "was this an earlier container of THIS cell" only from
# INSIDE a container (`defaultInContainer` reads `/.dockerenv`, which is absent on the host by
# construction) — so a host-side script can never safely decide a lock's staleness, on this sha or
# any future one. The daemon reclaims a foreign container-shaped holder on its own next boot; this
# script only ever reads and reports.
#
# PLAIN BASH AND DOCKER, deliberately — the same discipline as deploy/verify-image.sh and
# deploy/host-update.sh, this script's siblings. It runs on a host that may have no node, no rmd and
# no checkout, and it must keep working when the thing it is inspecting is broken. An `rmd` verb
# cannot fill this role: every verb runs `checkCliFreshness` (src/lib/self-sync.ts), which
# fast-forwards THIS checkout before doing its own work — the very checkout the daemon bind-mounts
# and the recycle is about to replace.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO. It does not reclaim disk (`deploy/host-update.sh` owns
# that, unchanged, run separately when disk is tight) and it does not run the full toolchain probe
# (`deploy/verify-image.sh` owns that; run it after a successful recycle for the deeper check). This
# file's only job is replacing the one named container safely, with the four refusals above.
#
# USAGE
#   ./deploy/recycle-container.sh                  # recycle onto :latest
#   ./deploy/recycle-container.sh --tag <sha>       # a specific tag instead of :latest
#   REGISTRY=... IMAGE=... ./deploy/recycle-container.sh     # retarget without editing this file
#   RMD_STATE_DIR=/path ./deploy/recycle-container.sh        # if the bind mount is not ~/rmd-state
#   RMD_RECYCLE_WAIT_S=300 ./deploy/recycle-container.sh      # widen the bounded wait for workers
#   ./deploy/recycle-container.sh --first-boot                # RMD_STATE_DIR is a genuinely fresh
#                                                               # host with no checkout yet (W1-T2555)

set -euo pipefail

# ── THE DECLARED RUNTIME VARIABLE NAMES — ONE LIST, READ HERE AND BY host-update.sh (W1-T1069) ──
# `deploy/runtime-env-vars.sh` is the single source of truth for which environment variable NAMES
# the daemon container carries at runtime; see that file's header for the full rationale. Sourced,
# not retyped: before it existed, this script's `docker run` and host-update.sh's
# `--print-daemon-run` each named the runtime variables by hand and drifted apart — a recycle would
# have silently dropped four of the six the day GH_APP_* was added. The inline fallback array below
# fires ONLY when this script has been copied away from its sibling (a test fixture does this on
# purpose, to drive a single script in isolation); test/recycle-container.test.ts asserts this
# fallback, host-update.sh's own fallback, and deploy/runtime-env-vars.sh's real array never
# disagree, so the fallback cannot silently go stale either.
RMD_DAEMON_RUNTIME_ENV_VARS=(GH_TOKEN RMD_RESTART_THROTTLE_S RMD_FRESHNESS_RESTART_MAX GH_APP_ID GH_APP_INSTALLATION_ID GH_APP_PRIVATE_KEY_PATH)
RUNTIME_ENV_VARS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/runtime-env-vars.sh" || true
if [ -n "${RUNTIME_ENV_VARS_FILE:-}" ] && [ -f "${RUNTIME_ENV_VARS_FILE}" ]; then
  # shellcheck source=./runtime-env-vars.sh
  source "${RUNTIME_ENV_VARS_FILE}"
fi

REGISTRY="${REGISTRY:-synthwatcholey0620}"
IMAGE="${IMAGE:-remudero}"
TAG="${TAG:-latest}"
CONTAINER_NAME="${RMD_DAEMON_CONTAINER:-remudero-daemon}"

# The HOST side of the state bind mount — same derivation and same default as deploy/host-update.sh,
# so the two scripts agree on where the fleet's locks and control flags actually live.
STATE_DIR="${RMD_STATE_DIR:-${HOME:-/root}/rmd-state}"
# W1-T2555: HOW STATE_DIR WAS RESOLVED, NAMED — every refusal below that mentions STATE_DIR says
# both the resolved path AND whether it came from an explicit RMD_STATE_DIR or the bare default, so
# an operator reading the refusal never has to re-derive it by hand.
if [ -n "${RMD_STATE_DIR:-}" ]; then
  STATE_DIR_RESOLUTION="RMD_STATE_DIR=${RMD_STATE_DIR}"
else
  STATE_DIR_RESOLUTION="the default \${HOME:-/root}/rmd-state (HOME=${HOME:-<unset>})"
fi
STATE_MOUNT_DEST="/home/node/Remudero"
CRED_DIR="${RMD_CLAUDE_DIR:-${HOME:-/root}/.claude}"
CRED_MOUNT_DEST="/home/node/.claude"
DAEMON_REPO="${RMD_DAEMON_REPO:-remudero}"

DRAIN_LOCK="${STATE_DIR}/state/drain.lock"
INFLIGHT_DIR="${STATE_DIR}/state/inflight"
PAUSE_FILE="${STATE_DIR}/state/PAUSE"

# How long to wait for in-flight workers before refusing, and how often to re-check while waiting.
# Bounded deliberately: an unbounded wait is a hang with no visible cause, and the whole point of a
# BOUNDED wait is that it can time out and refuse rather than block a recycle forever.
WAIT_SECONDS="${RMD_RECYCLE_WAIT_S:-120}"
POLL_INTERVAL_S="${RMD_RECYCLE_POLL_S:-5}"

# THE AGE ABOVE WHICH A LANE-LESS WORKER IS TREATED AS HUNG RATHER THAN BUSY (W1-T1046).
#
# DERIVED FROM THE OBSERVED DISTRIBUTION, NOT PICKED. Over 115 `implement.done` rows carrying
# `worker_duration_ms`, a legitimate implement runs 19.3 min median, 36.0 p90, 46.7 p95 and 98.5 max.
# 7200s is 22% clear of the LARGEST run ever observed and roughly 3.3x p90, so ZERO of those 115
# would have tripped it — checked directly, not inferred from the percentiles. The hang this closes
# ran 149 minutes, comfortably past it. A number that would have killed a legitimate worker is a
# worse bug than the deadlock it fixes, so the margin is deliberately lopsided: raise this rather
# than lower it, and re-derive from `implement.done` before you do.
HUNG_WORKER_AGE_S="${RMD_RECYCLE_HUNG_AGE_S:-7200}"

# Where the "what this recycle actually did" record goes. The ledger is append-only NDJSON that the
# daemon already owns and every other post-hoc reconstruction reads, and it survives the container
# this script is about to remove because it lives on the bind mount. One line, appended, never
# rewritten — this script does not read it back and does not depend on it existing.
LEDGER_FILE="${STATE_DIR}/state/ledger.ndjson"

# W1-T2555: THE OPERATOR'S OWN WORD THAT THIS IS A FRESH HOST, NEVER INFERRED. Defaults from the
# env var so a fleet-automation caller can pass it without editing an argv list; --first-boot is the
# same opt-in for an interactive operator. Either form is read identically below — see section 1.5.
FIRST_BOOT="${RMD_RECYCLE_FIRST_BOOT:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)         TAG="${2:?--tag needs a value}"; shift 2 ;;
    --registry)    REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --image)       IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --container)   CONTAINER_NAME="${2:?--container needs a value}"; shift 2 ;;
    --first-boot)  FIRST_BOOT=1; shift ;;
    -h|--help)     sed -n '1,72p' "$0"; exit 0 ;;
    *) echo "recycle-container: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

REF="${REGISTRY}.azurecr.io/${IMAGE}:${TAG}"
echo "recycle-container: container ${CONTAINER_NAME}, target image ${REF}"

# ── 1. NEVER RUN FROM INSIDE THE IMAGE ───────────────────────────────────────────────────────────
# A recycle executed inside the container it is about to remove cannot outlive `docker rm` — this is
# the same host-vs-image boundary deploy/verify-image.sh and deploy/host-update.sh both stand on.
# The marker path is overridable (RMD_RECYCLE_DOCKERENV_PATH) for exactly one reason: this script's
# own test suite may itself run inside a container (a sandboxed CI runner, for instance), where the
# real /.dockerenv would trip this guard for a reason that has nothing to do with the script under
# test. Unset, this is byte-for-byte the real check.
DOCKERENV_PATH="${RMD_RECYCLE_DOCKERENV_PATH:-/.dockerenv}"
if [ -f "${DOCKERENV_PATH}" ]; then
  echo "recycle-container: REFUSING — this is running INSIDE a container." >&2
  echo "  This script recycles the container it runs from a HOST shell; running it from inside the" >&2
  echo "  image it is about to remove cannot outlive the 'docker rm' it would issue on itself." >&2
  exit 1
fi

# ── 1.5. STATE_DIR MUST ALREADY BE A CHECKOUT — OR THE OPERATOR MUST SAY THIS IS A FIRST BOOT ───
# W1-T2555: MEASURED 2026-09-01. STATE_DIR was never tested for existence, and `find` over a
# directory that is not there correctly returns nothing — so the "no blocking locks" line below
# printed the exact wording an idle fleet produces over a path that had never been opened, and
# `docker run -v "${STATE_DIR}:${STATE_MOUNT_DEST}"` would then have had DOCKER ITSELF create that
# empty directory and boot a daemon with no repo, no plan and no ledger. Only an unrelated
# `docker rm` race stopped that mount from happening on the fleet that measured this.
#
# THE PREDICATE IS "is this a checkout", never "is this the path an operator meant" — a typo'd or
# inherited-default STATE_DIR has neither of the two markers below; a genuine one always has both:
#   - STATE_DIR/state/          — the directory every lock, pause file and ledger line in this
#                                  script already reads and writes under STATE_DIR.
#   - STATE_DIR/remudero/.git   — the checkout deploy/entrypoint.sh clones into
#                                  ($CONFIG_ROOT/remudero, CONFIG_ROOT == this same STATE_DIR
#                                  mounted at ${STATE_MOUNT_DEST}), literal and hardcoded there too.
#
# THE FIRST-RUN CASE IS REAL: a genuinely fresh host has no state directory at all, and
# entrypoint.sh's own clone is what creates the checkout inside it — so a blanket refusal would make
# a first deploy impossible. FIRST_BOOT (RMD_RECYCLE_FIRST_BOOT=1 or --first-boot, above) is the
# operator's explicit word that this run IS that first boot. It is NEVER inferred from the directory
# being empty or absent — only this flag turns the refusal off.
STATE_DIR_CHECKOUT_MARKER="${STATE_DIR}/state"
STATE_DIR_REPO_MARKER="${STATE_DIR}/remudero/.git"
if [ "${FIRST_BOOT}" != "1" ]; then
  if [ ! -d "${STATE_DIR}" ] || [ ! -d "${STATE_DIR_CHECKOUT_MARKER}" ] || [ ! -e "${STATE_DIR_REPO_MARKER}" ]; then
    echo "recycle-container: REFUSING — STATE_DIR resolved to ${STATE_DIR} (${STATE_DIR_RESOLUTION})," >&2
    echo "  and this does not look like a real checkout:" >&2
    if [ -d "${STATE_DIR}" ]; then
      echo "    - the directory exists" >&2
    else
      echo "    - the directory does NOT exist" >&2
    fi
    if [ -d "${STATE_DIR_CHECKOUT_MARKER}" ]; then
      echo "    - ${STATE_DIR_CHECKOUT_MARKER} is present" >&2
    else
      echo "    - ${STATE_DIR_CHECKOUT_MARKER} is MISSING" >&2
    fi
    if [ -e "${STATE_DIR_REPO_MARKER}" ]; then
      echo "    - ${STATE_DIR_REPO_MARKER} is present" >&2
    else
      echo "    - ${STATE_DIR_REPO_MARKER} is MISSING" >&2
    fi
    echo "  Mounting this path would hand the daemon an EMPTY checkout — docker itself creates" >&2
    echo "  whatever directory this script does not refuse first (W1-T2555). NOTHING has been" >&2
    echo "  touched: no lock was read, no container was stopped or removed." >&2
    echo "  If this genuinely IS a first-ever boot on a fresh host, say so explicitly — this is" >&2
    echo "  never inferred from the directory being empty or absent:" >&2
    echo "    RMD_RECYCLE_FIRST_BOOT=1 $0 ...   (or: $0 --first-boot ...)" >&2
    echo "  Otherwise fix RMD_STATE_DIR to point at the real state directory and re-run." >&2
    exit 1
  fi
fi

# ── 2. EVERY BLOCKING LOCK IS PRINTED IN FULL — NEVER DELETED, NEVER JUDGED ─────────────────────
# `state/drain.lock` and `state/inflight/*.lock` are read-only from here, always, regardless of what
# happens later in this run. A host-side process cannot decide whether a lock naming a now-gone
# container is stale (see the header note on isHolderStale/W1-T978), so the only honest thing this
# script can do is show the operator exactly what is recorded and let a human, or the daemon's own
# next boot, decide.
print_blocking_locks() {
  local any=0
  if [ -f "${DRAIN_LOCK}" ]; then
    any=1
    echo "recycle-container: ${DRAIN_LOCK} is PRESENT — printed in full, never deleted by this script:"
    sed 's/^/    /' "${DRAIN_LOCK}" 2>/dev/null || echo "    (unreadable)"
    echo "    A host-side script cannot tell whether the holder above names a container that is gone;"
    echo "    the daemon reclaims a foreign container-shaped holder on its OWN next boot (W1-T978)."
    echo "    This script does not act on that — read it, or let the next boot decide."
  fi
  if [ -d "${INFLIGHT_DIR}" ]; then
    for f in "${INFLIGHT_DIR}"/*.lock; do
      [ -e "${f}" ] || continue
      any=1
      echo "recycle-container: ${f} is PRESENT — printed, never deleted:"
      sed 's/^/    /' "${f}" 2>/dev/null || echo "    (unreadable)"
    done
  fi
  if [ "${any}" -eq 0 ]; then
    echo "recycle-container: no blocking locks under ${STATE_DIR}/state"
  fi
}
print_blocking_locks

# ── 3. CAPTURE EVERY DECLARED RUNTIME VARIABLE — BEFORE TOUCHING ANYTHING, NOT MERELY BEFORE
#      docker rm — AND REFUSE IF THE CONTAINER CARRIES ONE THIS RECYCLE DOES NOT DECLARE ─────────
# `deploy/entrypoint.sh` reads GH_TOKEN from the ENVIRONMENT at call time and writes it nowhere on
# disk, by design — so once the container that carries it is gone, an operator is the only way to
# get it back. That applies to every name in RMD_DAEMON_RUNTIME_ENV_VARS, not GH_TOKEN alone (it
# only ever named GH_TOKEN because GH_TOKEN was the only one that existed the day it was written —
# see deploy/runtime-env-vars.sh). This is the FIRST check that can refuse, ahead of even the pull,
# because a pull is reversible (re-run it) and a removed container's only copy of a runtime
# variable is not.
CONTAINER_EXISTS=0
declare -A CAPTURED=()
# W1-T2553: which source each captured value actually came from — "container", "shell" or
# "neither". Exists so the refusal below can NAME what it consulted rather than assert it; the old
# message claimed the shell had nothing without ever having read it.
declare -A CAPTURED_SOURCE=()

is_declared_runtime_var() {
  local needle="$1" candidate
  for candidate in "${RMD_DAEMON_RUNTIME_ENV_VARS[@]}"; do
    [ "${candidate}" = "${needle}" ] && return 0
  done
  return 1
}

if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  CONTAINER_EXISTS=1

  # The container's full runtime env, one NAME=VALUE per line. The `{{println}}` form emits a
  # trailing empty element (a real blind spot, named rather than assumed away — deploy/runtime-env-vars.sh
  # and W1-T1069's rationale), dropped here by the blank-line filter.
  CONTAINER_ENV_RAW="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  readarray -t CONTAINER_ENV_LINES < <(printf '%s\n' "${CONTAINER_ENV_RAW}" | sed '/^$/d')

  # The container's OWN image env — subtracted below to find what is genuinely runtime-set. Read via
  # `.Config.Image` (the reference this container was started FROM), never `.Image` (the resolved
  # digest section 7 below already owns, for a different comparison: proving the STARTED container
  # matches what THIS run just pulled).
  IMAGE_ENV_LINES=()
  IMAGE_ENV_KNOWN=0
  CONTAINER_IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  if [ -n "${CONTAINER_IMAGE_REF}" ]; then
    if IMAGE_ENV_RAW="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${CONTAINER_IMAGE_REF}" 2>/dev/null)"; then
      IMAGE_ENV_KNOWN=1
      readarray -t IMAGE_ENV_LINES < <(printf '%s\n' "${IMAGE_ENV_RAW}" | sed '/^$/d')
    fi
  fi

  # ── THE DRIFT CHECK: a runtime NAME this recycle does not declare REFUSES, and names it ────────
  # A variable is RUNTIME-SET when its NAME is absent from the image env, OR its VALUE differs from
  # the image's own — a runtime value that SHADOWS an image name (e.g. `-e HOME=/other`) is still
  # runtime-set even though the name matches, and a name-only diff would miss it. Comparing values
  # never prints one. Skipped, not assumed clean, when the image env itself could not be read.
  UNDECLARED_RUNTIME_VARS=""
  if [ "${IMAGE_ENV_KNOWN}" -eq 1 ]; then
    for line in "${CONTAINER_ENV_LINES[@]}"; do
      name="${line%%=*}"
      value="${line#*=}"
      [ -n "${name}" ] || continue
      image_has_name=0
      image_value=""
      for iline in "${IMAGE_ENV_LINES[@]}"; do
        case "${iline}" in
          "${name}="*) image_has_name=1; image_value="${iline#*=}" ;;
        esac
      done
      if [ "${image_has_name}" -eq 0 ] || [ "${value}" != "${image_value}" ]; then
        if ! is_declared_runtime_var "${name}"; then
          UNDECLARED_RUNTIME_VARS="${UNDECLARED_RUNTIME_VARS}${UNDECLARED_RUNTIME_VARS:+, }${name}"
        fi
      fi
    done
  else
    echo "recycle-container: NOTE — could not read ${CONTAINER_NAME}'s own image env; the undeclared-runtime-variable check is skipped this run." >&2
  fi

  if [ -n "${UNDECLARED_RUNTIME_VARS}" ]; then
    echo "recycle-container: REFUSING — ${CONTAINER_NAME} carries a runtime variable this recycle does not declare: ${UNDECLARED_RUNTIME_VARS}" >&2
    echo "  Add it to RMD_DAEMON_RUNTIME_ENV_VARS in deploy/runtime-env-vars.sh, or the recycle would" >&2
    echo "  silently drop it on the next replacement — the exact defect W1-T1069 closes. NOTHING has" >&2
    echo "  been touched." >&2
    exit 1
  fi

  # W1-T2553: FALL BACK TO THE SHELL WHEN THE CONTAINER'S VALUE IS EMPTY. This loop used to read
  # ONLY the container, and the shell fallback lived in the `else` branch below — reachable solely
  # when NO container exists. That was fine while containers were started carrying a token, and
  # became a permanent deadlock the moment W1-T2311 began creating them with `-e GH_TOKEN=` EMPTY
  # on purpose: `val` is then "" forever, the refusal below fires on every recycle after the first,
  # and exporting GH_TOKEN in the shell — the one remedy the refusal itself recommends — cannot
  # help, because nothing in this branch ever looks there. The same shape applies to every declared
  # runtime variable, GH_APP_* included, which is why the fallback is per-NAME rather than special
  # -cased to the token.
  #
  # PRECEDENCE IS DELIBERATE AND UNCHANGED IN THE ONLY CASE THAT MATTERED BEFORE: a NON-EMPTY
  # container value still wins, so a live container's own runtime value is never silently replaced
  # by a stale shell export. The shell is consulted only where the container offers nothing.
  # CAPTURED_SOURCE records which source each name actually came from, so the refusal below can
  # name what it consulted instead of asserting it.
  for name in "${RMD_DAEMON_RUNTIME_ENV_VARS[@]}"; do
    val=""
    for line in "${CONTAINER_ENV_LINES[@]}"; do
      case "${line}" in
        "${name}="*) val="${line#*=}" ;;
      esac
    done
    if [ -n "${val}" ]; then
      CAPTURED_SOURCE["${name}"]="container"
    else
      val="${!name-}"
      if [ -n "${val}" ]; then
        CAPTURED_SOURCE["${name}"]="shell"
      else
        CAPTURED_SOURCE["${name}"]="neither"
      fi
    fi
    CAPTURED["${name}"]="${val}"
  done
else
  # No container by this name yet (first-ever run on a fresh host) — the only place a declared
  # runtime variable can come from is this shell's own environment.
  for name in "${RMD_DAEMON_RUNTIME_ENV_VARS[@]}"; do
    CAPTURED["${name}"]="${!name-}"
    CAPTURED_SOURCE["${name}"]="$([ -n "${!name-}" ] && echo shell || echo neither)"
  done
fi

CAPTURED_TOKEN="${CAPTURED[GH_TOKEN]-}"
if [ -z "${CAPTURED_TOKEN}" ]; then
  # W1-T2553: NAME THE SOURCES ACTUALLY CONSULTED. The old wording asserted "and this shell has none
  # either" from the container branch, which had never read the shell at all — an unfalsifiable
  # claim in a refusal, and the reason an operator who DID export GH_TOKEN was told the export had
  # not worked. Both sources are now genuinely read above, and this names each one's own result.
  echo "recycle-container: REFUSING — no GH_TOKEN could be captured." >&2
  if [ "${CONTAINER_EXISTS}" -eq 1 ]; then
    echo "  Consulted ${CONTAINER_NAME}'s own environment: no GH_TOKEN (or empty)." >&2
    echo "  Consulted this shell: $([ -n "${GH_TOKEN-}" ] && echo "GH_TOKEN is set but empty" || echo "GH_TOKEN is not set")." >&2
    echo "  NOTHING has been touched — removing the container now would discard the only copy of a" >&2
    echo "  credential that is never written to disk (deploy/entrypoint.sh)." >&2
  else
    echo "  Consulted this shell (${CONTAINER_NAME} does not exist yet): $([ -n "${GH_TOKEN-}" ] && echo "GH_TOKEN is set but empty" || echo "GH_TOKEN is not set")." >&2
  fi
  echo "  Export GH_TOKEN in this shell and re-run." >&2
  exit 1
fi
echo "recycle-container: GH_TOKEN captured from ${CAPTURED_SOURCE[GH_TOKEN]-unknown}"

# ── W1-T2311: THE CAPTURE ABOVE IS READ, NEVER RE-BOOTED AS THE DAEMON'S OWN DEFAULT ────────────
# MEASURED 2026-08-26: `docker inspect` (above) reports only the STATIC config a container was
# started with — it never sees `refreshInstallationToken` (src/lib/github-app.ts) mutating
# `process.env.GH_TOKEN` inside the running daemon. So no matter how many times a daemon
# successfully refreshed onto an App-minted token, this capture always read back the ORIGINAL
# boot-time personal token, and every past recycle re-booted the NEXT container on that same
# standing PAT forever — the container's boot env carried the operator's own token as its
# DEFAULT credential, not as a fallback. The capture and its refusal above are UNCHANGED: an
# operator never silently loses the only copy of a token that is never written to disk. What
# changes is what happens to it below — it is no longer forwarded into the new container's own
# environment (see the RUN_ENV_ARGS loop), so the new daemon's default credential is no longer a
# personal token (remedy (a); see src/lib/github-app.ts's own W1-T2311 decision record for why
# remedy (b) — refusing rather than degrading — was not taken instead).
#
# THE OPERATOR READ PATH THIS DISPLACES, NAMED RATHER THAN LEFT IMPLICIT. An operator who needs a
# working `gh`/`git` inside the recycled container no longer gets one baked into its boot
# environment. Supply your OWN token per invocation instead — the fleet never holds it for you:
#   docker exec -e GH_TOKEN=<your own token> ${CONTAINER_NAME} gh ...
# `docker exec -e` sets the variable for that one exec'd process only; it never touches the
# container's own configured environment, so nothing is left standing for the next recycle to
# re-capture and re-propagate. This is the operator read path for interactive debugging.

# Names only, never values (same discipline as the line above) — the rest of the declared list that
# actually had something to carry across this recycle.
OTHER_CAPTURED_NAMES=""
for name in "${RMD_DAEMON_RUNTIME_ENV_VARS[@]}"; do
  [ "${name}" = "GH_TOKEN" ] && continue
  [ -n "${CAPTURED[${name}]-}" ] || continue
  OTHER_CAPTURED_NAMES="${OTHER_CAPTURED_NAMES}${OTHER_CAPTURED_NAMES:+, }${name}"
done
if [ -n "${OTHER_CAPTURED_NAMES}" ]; then
  echo "recycle-container: also carrying: ${OTHER_CAPTURED_NAMES} (names only — see deploy/runtime-env-vars.sh)"
else
  echo "recycle-container: no other declared runtime variable had a value to carry"
fi

# The full docker-run `-e` argument list, built from the declared names rather than retyped —
# EVERY declared name is passed (even when its captured value is empty), matching the shape
# RMD_RESTART_THROTTLE_S already had before this change and never re-passing anything the image
# itself already supplies (PATH, NODE_VERSION, ... are never in RMD_DAEMON_RUNTIME_ENV_VARS).
#
# GH_TOKEN IS THE ONE DECLARED NAME DELIBERATELY FORWARDED EMPTY (W1-T2311, see the note above).
# The NAME stays declared — a future runtime value would still be caught by the drift check above
# — but the VALUE just captured off the outgoing container is never handed to the incoming one, so
# the new daemon's default credential is no longer a personal token.
RUN_ENV_ARGS=()
for name in "${RMD_DAEMON_RUNTIME_ENV_VARS[@]}"; do
  if [ "${name}" = "GH_TOKEN" ]; then
    RUN_ENV_ARGS+=(-e "GH_TOKEN=")
  else
    RUN_ENV_ARGS+=(-e "${name}=${CAPTURED[${name}]-}")
  fi
done

# ── 4. AUTHENTICATE, THEN PULL — A FAILURE HERE REFUSES AND NEVER STARTS ANYTHING ────────────────
# THE 2026-08-18 INCIDENT THIS SECTION EXISTS TO CLOSE: a pull failed with "authentication required"
# and the recycle went on to `docker run` anyway, silently relaunching whatever was already cached
# under this tag. The operator believed he had the new build and did not. So a pull failure is fatal
# here, full stop — nothing below this section may ever run after it.
if command -v az >/dev/null 2>&1; then
  echo "recycle-container: az acr login -n ${REGISTRY}"
  if ! az acr login -n "${REGISTRY}" >/dev/null; then
    echo "recycle-container: REFUSING — FAILED to authenticate to ${REGISTRY}." >&2
    echo "  ${CONTAINER_NAME} is untouched. Run 'az login' if this is a fresh shell, then re-run." >&2
    exit 1
  fi
else
  echo "recycle-container: the Azure CLI is NOT installed on this host." >&2
  echo "  Authenticate docker by hand and re-run: docker login ${REGISTRY}.azurecr.io" >&2
  echo "  REFUSING — an unauthenticated pull would leave the OLD image in place and this script" >&2
  echo "  would go on to interrogate that one instead." >&2
  exit 1
fi

echo "recycle-container: docker pull ${REF}"
# ${PIPESTATUS[0]}, NOT the pipeline's own status — the same trap deploy/host-update.sh guards
# against: `docker pull | tee | sed` would report tee/sed's status, which is always 0, and a failed
# pull would read as a success. `set +e` around the pipeline is required because `set -o pipefail`
# would otherwise abort the script here, before PULL_RC is ever assigned.
set +e
docker pull "${REF}" 2>&1 | tee /tmp/recycle-container-pull.log | sed 's/^/  /'
PULL_RC="${PIPESTATUS[0]}"
set -e
if [ "${PULL_RC}" -ne 0 ] || grep -qiE 'authentication required|unauthorized|denied' /tmp/recycle-container-pull.log 2>/dev/null; then
  echo "recycle-container: REFUSING — the pull FAILED (exit ${PULL_RC})." >&2
  echo "  ${CONTAINER_NAME} is untouched and STILL RUNNING on its current image." >&2
  echo "  NOT starting anything — a fresh image was requested and not obtained, and the last known" >&2
  echo "  failure of this exact kind silently relaunched the STALE cached image instead." >&2
  exit 1
fi
PULLED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${REF}" 2>/dev/null || true)"
if [ -z "${PULLED_IMAGE_ID}" ]; then
  echo "recycle-container: REFUSING — pulled ${REF} but could not read an image id back." >&2
  echo "  ${CONTAINER_NAME} is untouched." >&2
  exit 1
fi
echo "recycle-container: pulled image id ${PULLED_IMAGE_ID}"

# ── 5. PAUSE, THEN WAIT (BOUNDED) FOR IN-FLIGHT WORKERS ─────────────────────────────────────────
# THE PAUSE MUST GO ON BEFORE THE WAIT, or the wait watches a fleet still admitting new work and can
# never converge on zero. THE OTHER 2026-08-18 INCIDENT THIS CLOSES: a recycle run without pausing
# first found three workers mid-run; killing them would have lost the work and stranded their
# `state/inflight/*.lock` files. If the wait times out, THE PAUSE COMES OFF ON THE WAY OUT — a
# refusal that leaves the fleet paused forever is a second outage stacked on the first.
mkdir -p "$(dirname "${PAUSE_FILE}")"
cat > "${PAUSE_FILE}" <<PAUSEJSON
{"reason":"container recycle (deploy/recycle-container.sh)","requestedAt":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)","pid":$$,"host":"$(hostname)"}
PAUSEJSON
echo "recycle-container: PAUSE engaged — new dispatch halts, in-flight work is allowed to finish"

# THE LOCK COUNT ALONE IS BLIND TO A WHOLE LANE, IN BOTH DIRECTIONS (W1-T1046).
#
# `state/inflight/*.lock` is taken by the DISPATCH lane only. The FIX RUNG runs inside the daemon's
# own sweep, consumes no lane and takes no lock: its worker is spawned with a settings file at
# `tmp/sweep-fix-settings-<task>-<epoch>.json` into a worktree named `sweep-<task>-<epoch>` (both
# `src/run-task.ts`), and the ledger shows the same split — every `worker.state` row carries a
# dispatch-lane run_id and none carries a sweep-shaped one, so a fix-rung worker is invisible to the
# ledger too. A lock-only wait therefore reads ZERO while such a worker is mid-run and proceeds to
# `docker rm` it, losing spend that was never recorded (a killed worker writes no `implement.done`).
# The same blindness cannot EXPLAIN a hang either, which is how a hand-rolled variant of this script
# that counted PROCESSES instead deadlocked for 1,420s against a worker that would never exit.
#
# SO BOTH SIGNALS ARE READ, AND THEY DECIDE DIFFERENT THINGS. Locks decide "a lane is occupied,
# never proceed"; processes decide "something is running that holds no lane, is it busy or hung".
# THE ASYMMETRY SETS THE DEFAULT: killing a live worker loses unrecorded spend, so anything this
# cannot positively classify as hung is waited for and then REFUSED, exactly as before.
worker_lines() {
  # `procps` is installed in the image (deploy/Dockerfile), so this is real ps, not the busybox
  # applet. A failure here yields NO lines, which reads as "no lane-less worker" — deliberately the
  # conservative direction for the *kill* decision, and harmless for the *wait* decision because the
  # lock count below is independent of it.
  docker exec "${CONTAINER_NAME}" ps -eo pid,etimes,args --no-headers 2>/dev/null \
    | grep -F -- 'claude --output-format' || true
}

waited=0
while :; do
  n=0
  if [ -d "${INFLIGHT_DIR}" ]; then
    n="$(find "${INFLIGHT_DIR}" -maxdepth 1 -name '*.lock' 2>/dev/null | wc -l | tr -d ' ')"
  fi

  # Lane-less workers, split by age. `busy` blocks the recycle exactly like a lock does; `hung` does
  # not, because it never will.
  lane_less_busy=0
  lane_less_hung=""
  while read -r wpid wage wargs; do
    [ -n "${wpid:-}" ] || continue
    case "${wargs}" in
      *sweep-fix-settings-*) : ;;
      *) lane_less_busy=$((lane_less_busy + 1)); continue ;;
    esac
    if [ "${wage}" -ge "${HUNG_WORKER_AGE_S}" ] 2>/dev/null; then
      lane_less_hung="${lane_less_hung}${wpid} ${wage}"$'\n'
    else
      lane_less_busy=$((lane_less_busy + 1))
    fi
  done <<WORKERS
$(worker_lines)
WORKERS

  if [ "${n}" -eq 0 ] && [ "${lane_less_busy}" -eq 0 ]; then
    # PRINT BEFORE CLEARING, ALWAYS — the standing rule, and the only reason the forensics that
    # produced this predicate were possible at all. A hung worker is reported in full BEFORE the
    # container carrying it is removed, because afterwards its `/proc` is gone for good.
    if [ -n "${lane_less_hung}" ]; then
      echo "recycle-container: proceeding PAST lane-less worker(s) judged hung (>= ${HUNG_WORKER_AGE_S}s, no inflight lock):" >&2
      printf '%s' "${lane_less_hung}" | while read -r hpid hage; do
        [ -n "${hpid:-}" ] || continue
        echo "  pid ${hpid}  age ${hage}s  predicate: fix-rung shape (sweep-fix-settings) AND age >= ${HUNG_WORKER_AGE_S}s AND zero inflight locks" >&2
        docker exec "${CONTAINER_NAME}" sh -c "tr '\\0' ' ' < /proc/${hpid}/cmdline 2>/dev/null; echo; readlink /proc/${hpid}/cwd 2>/dev/null" 2>/dev/null \
          | sed 's/^/    /' >&2 || true
        # ONE LINE PER WORKER, appended. Nothing is cleaned here: the processes die with the
        # container, and every mount-side leftover already has a daemon-side owner that fires on the
        # next boot — `reapStaleWorktrees` (src/lib/worker.ts) for the `sweep-*` worktree,
        # `sweepTmp` for `tmp/`, the worker-home sweep for `worker-home-*`. Duplicating them here
        # would put a second, host-side deleter on paths a live container may still be using.
        # `.git/config.lock` is W1-T1036's subject and is deliberately not touched.
        if [ -d "$(dirname "${LEDGER_FILE}")" ]; then
          printf '{"ts":"%s","run_id":"RECYCLE-%s","task_id":"RECYCLE","step":"recycle.hung_worker_passed","lane":"deploy","pid":%s,"age_s":%s,"age_bound_s":%s,"predicate":"fix-rung shape and over age bound and zero inflight locks","cleaned":"none — worktree/tmp/worker-home have daemon-side owners","host":"%s"}\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$$" "${hpid}" "${hage}" "${HUNG_WORKER_AGE_S}" "$(hostname)" >> "${LEDGER_FILE}" || true
        fi
      done
    fi
    echo "recycle-container: no in-flight workers — safe to proceed"
    break
  fi
  if [ "${waited}" -ge "${WAIT_SECONDS}" ]; then
    echo "recycle-container: REFUSING — ${n} lane-holding and ${lane_less_busy} lane-less worker(s) still in flight after ${WAIT_SECONDS}s." >&2
    if [ -d "${INFLIGHT_DIR}" ]; then
      for f in "${INFLIGHT_DIR}"/*.lock; do
        [ -e "${f}" ] || continue
        echo "  $(basename "${f}"):" >&2
        sed 's/^/    /' "${f}" 2>/dev/null >&2 || true
      done
    fi
    # A LANE-LESS WORKER UNDER THE AGE BOUND IS REPORTED AND STILL REFUSED. It holds no lock, so
    # nothing above names it, and before this change it was not merely unreported — it was invisible,
    # and the recycle removed the container out from under it.
    if [ "${lane_less_busy}" -gt 0 ]; then
      echo "  lane-less worker(s) under the ${HUNG_WORKER_AGE_S}s age bound — busy, not hung:" >&2
      worker_lines | sed 's/^/    /' >&2 || true
    fi
    echo "  ${CONTAINER_NAME} is untouched — killing it now would lose this work and strand these" >&2
    echo "  locks. Widen the wait with RMD_RECYCLE_WAIT_S, or re-run once these finish." >&2
    rm -f "${PAUSE_FILE}"
    echo "recycle-container: pause removed — the refusal above must not leave the fleet paused" >&2
    exit 1
  fi
  echo "recycle-container: ${n} lane-holding + ${lane_less_busy} lane-less worker(s) still in flight, waited ${waited}s/${WAIT_SECONDS}s — polling"
  sleep "${POLL_INTERVAL_S}"
  waited=$((waited + POLL_INTERVAL_S))
done

# ── 6. STOP + REMOVE THE OLD CONTAINER, CLEAR THE PAUSE, START THE NEW ONE ──────────────────────
# `docker stop` (not `-f`/`kill`) sends SIGTERM first, giving the daemon's own signal handler a
# chance to release the drain lock cleanly before this script ever removes the container — the
# graceful half of the fix for the 2026-08-18 drain-lock incident; section 2 above is the honest
# backstop for whatever that handler cannot reach.
#
# THE PAUSE MUST COME OFF BEFORE THE START, never after: the new container reads the SAME bind
# mount, so a pause left in place would make it come up paused with no dispatch — this marker is a
# file in shared state, not process state, and the new container has no memory of who set it.
if [ "${CONTAINER_EXISTS}" -eq 1 ]; then
  echo "recycle-container: docker stop ${CONTAINER_NAME}"
  docker stop "${CONTAINER_NAME}" >/dev/null
  echo "recycle-container: docker rm ${CONTAINER_NAME}"
  docker rm "${CONTAINER_NAME}" >/dev/null
else
  echo "recycle-container: no existing ${CONTAINER_NAME} to stop or remove"
fi

rm -f "${PAUSE_FILE}"
echo "recycle-container: pause cleared — the new container must not come up paused"

echo "recycle-container: docker run -d --name ${CONTAINER_NAME} ${REF}"
docker run -d --name "${CONTAINER_NAME}" \
  --restart=on-failure:5 \
  --cap-drop ALL \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  --user 1000:1000 \
  "${RUN_ENV_ARGS[@]}" \
  -v "${STATE_DIR}:${STATE_MOUNT_DEST}" \
  -v "${CRED_DIR}:${CRED_MOUNT_DEST}" \
  "${REF}" \
  ./bin/rmd daemon --repo "${DAEMON_REPO}" --allow-self-target >/dev/null

# ── 7. PROVE IT — THE STARTED CONTAINER'S IMAGE MUST BE THE DIGEST JUST PULLED ──────────────────
# `docker inspect --format '{{.Image}}'` against the id captured in section 4 is the only proof this
# recycle actually took: a container that STARTED is not evidence it started on the image this run
# just obtained. This is deploy/verify-image.sh's own rule applied to the running container rather
# than a probe container: never report a verdict on an image you have not confirmed you just got.
STARTED_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
if [ -z "${STARTED_IMAGE_ID}" ] || [ "${STARTED_IMAGE_ID}" != "${PULLED_IMAGE_ID}" ]; then
  echo "recycle-container: FAILED RECYCLE — ${CONTAINER_NAME} is running image ${STARTED_IMAGE_ID:-<none>}," >&2
  echo "  which does NOT match the digest this run pulled (${PULLED_IMAGE_ID})." >&2
  echo "  A container came up, but not on the image this run obtained — investigate before trusting it." >&2
  exit 1
fi

echo "recycle-container: OK — ${CONTAINER_NAME} recycled onto ${PULLED_IMAGE_ID}"
echo "  Next: ./deploy/verify-image.sh --expect ${PULLED_IMAGE_ID}   # the full toolchain probe"
