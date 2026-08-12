#!/usr/bin/env bash
# host-update — reclaim disk on the container host, then pull the current image.
#
# WHY THIS EXISTS, MEASURED ON THE AZURE VM 2026-08-08: the host ran out of disk MID-PULL, at 27G
# of 29G used, with ~20GB of docker images and a stopped container holding 4.9GB. A manual
# `docker system prune -af` reclaimed 9.5GB. That will recur on a schedule nobody sets: every ACR
# build produces a new image, the old ones are never removed, and the SAME 29GB disk also carries
# the fleet's state. So the operator needs one command, runnable from a phone, that reclaims what
# is safe and lands the host on the current image.
#
# ── THE ORDER IS RECLAIM-THEN-PULL, AND THAT IS THE WHOLE DESIGN ─────────────────────────────
# The obvious order is pull-then-prune, and it is WRONG here for two independent reasons.
#   1. It is the exact failure being fixed. The disk filled DURING a pull, because the pull needed
#      room the old images were holding. Reclaiming first is what makes the pull fit.
#   2. `docker image prune -a` removes every image no CONTAINER references — and a freshly pulled
#      image with nothing running from it has no container. Pull-then-prune therefore deletes the
#      image it just spent minutes downloading. That is not a hypothetical; it is what `-a` means.
# The cost of this order is a real window: between the prune and the pull the host has NO image. It
# is bounded deliberately — the registry login happens FIRST, before anything is destroyed, so the
# overwhelmingly likely failure (an expired ACR token) is caught while the old image is still
# there. A network failure after that point leaves the host imageless and needing a re-run. That
# residual risk is accepted, and named here rather than discovered.
#
# ── IT WILL NOT TOUCH THE STATE VOLUME, AND MUST NOT GROW A FEATURE THAT DOES ────────────────
# The state directory is a host BIND MOUNT holding the LEDGER, which is irreplaceable: roughly 63%
# of `run.start` history exists ONLY inside its gzipped rotations, and `rotateLedger` keeps just
# the newest 200 lines per step in the live file — so the archives are not a backup of anything,
# they ARE the record. It also holds inflight run locks and `service-tokens.json`, regenerating
# which invalidates a bookmarked console URL.
#
# `docker volume prune` cannot reach a bind mount, so nothing here is a near miss. This paragraph
# is not about docker semantics; it is a standing instruction to whoever edits this file next:
# DO NOT ADD STATE CLEANING HERE. Not a ledger rotation, not an archive expiry, not a worktree
# reaper (see the recommendation at the foot of this file), not "just the old ones". A disk-space
# script that can delete evidence is one bad predicate away from destroying the only copy, and the
# blast radius is the whole fleet's history. The one thing this script does with the state
# directory is MEASURE it, read-only, so the operator can see where the space actually went.
#
# ── PLAIN BASH AND DOCKER, deliberately — the same discipline as deploy/verify-image.sh, which is
# this script's sibling. It runs on a host that may have no node, no rmd and no checkout, and it
# must keep working when the thing it is inspecting is broken. It also assumes NOTHING about being
# root: the operator's user is in the `docker` group, so there is no `sudo` anywhere in here, and a
# docker permission failure is reported as such rather than retried with privilege.
#
# USAGE
#   ./deploy/host-update.sh                    # reclaim, then pull :latest
#   ./deploy/host-update.sh --dry-run          # report only — reclaims nothing, pulls nothing
#   ./deploy/host-update.sh --print-daemon-run # PRINT the daemon-mode invocation and exit; starts
#                                              # nothing, and touches docker not at all
#   ./deploy/host-update.sh --tag <sha>        # a specific tag instead of :latest
#   REGISTRY=... IMAGE=... ./deploy/host-update.sh          # retarget without editing this file
#   RMD_STATE_DIR=/path ./deploy/host-update.sh            # if the bind mount is not ~/rmd-state

set -euo pipefail

REGISTRY="${REGISTRY:-synthwatcholey0620}"
IMAGE="${IMAGE:-remudero}"
TAG="${TAG:-latest}"
DRY_RUN=0
PRINT_DAEMON_RUN=0

# The HOST side of the state bind mount. The CONTAINER side is /home/node/Remudero (config.root
# derives from HOME — see REQ 10 in deploy/Dockerfile), and the measured invocation binds
# ~/rmd-state to it. Only ever read.
STATE_DIR="${RMD_STATE_DIR:-${HOME:-/root}/rmd-state}"
# The container-side path, used to RECOGNISE a fleet container by what it has mounted. This is the
# check that catches a container started from a locally-tagged image such as `rmd-local:latest`,
# whose name contains nothing this script would otherwise match.
STATE_MOUNT_DEST="/home/node/Remudero"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)      TAG="${2:?--tag needs a value}"; shift 2 ;;
    --registry) REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --image)    IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --print-daemon-run) PRINT_DAEMON_RUN=1; shift ;;
    -h|--help)  sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "host-update: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

REPO_REF="${REGISTRY}.azurecr.io/${IMAGE}"
REF="${REPO_REF}:${TAG}"

# ── --print-daemon-run: PRINT THE INVOCATION, RUN NOTHING ────────────────────────────────────
# This branch exists so the daemon-mode command lives somewhere an operator can find it, rather
# than in a chat message. IT DELIBERATELY STARTS NOTHING and exits before this script touches
# docker at all — no pull, no prune, no `docker info`. Copy what it prints, read the caveats, and
# decide; the script will not decide for you.
#
# THE DAEMON IS NOT READY TO RUN UNATTENDED, and the reason is stated here rather than left in a
# report nobody opens: launchd's 60s ThrottleInterval has no docker equivalent, so a crash loop
# cycles far faster in a container than the floor this repo earned from a measured restart storm.
# The daemon's own crash-loop detector survives a restart but only opens a needs-human issue, which
# is not a bound when nobody is reading. The full recon was written under `state/`, which is
# GITIGNORED and does not survive the container that wrote it — so REQ 5 in deploy/Dockerfile
# carries the conclusions instead, and this block carries the command.
if [ "${PRINT_DAEMON_RUN}" -eq 1 ]; then
  cat <<PRINTED
host-update: DAEMON-MODE INVOCATION — printed only. Nothing has been started and nothing was run.

  # THE DAEMON. --restart=on-failure matches launchd KeepAlive{SuccessfulExit:false}: exit 0 means
  # a deliberate stop (daemonExitCode maps 'stopped' and 'max_reached' to 0) and must NOT restart;
  # nonzero includes 'stale', which REQUIRES the restart to pick up merged code (W1-T126).
  #
  # RATE AND COUNT ARE TWO DIFFERENT BOUNDS, AND BOTH ARE SET HERE. \`--restart=on-failure:5\` caps
  # the COUNT; docker has no rate control at all, which is why deploy/entrypoint.sh grew
  # RMD_RESTART_THROTTLE_S — launchd's ThrottleInterval counterpart, a sleep BEFORE the non-zero
  # exit so docker's own restart is what gets rate-limited (an in-container retry loop would re-run
  # against the same tree and 'stale' would never clear). Exit 0 is never throttled, so a STOP
  # still stops immediately. It is passed through from THIS SHELL's environment below.
  #
  # THERE IS DELIBERATELY NO DEFAULT VALUE HERE, and that is a finding rather than an omission.
  # A throttle shorter than the time from container start to first useful dispatch just burns a
  # restart; longer than necessary just idles the fleet. NOBODY HAS MEASURED THAT INTERVAL — no
  # daemon has ever run in a container (zero \`daemon.*\` lines in the Azure instance's ledger), so
  # any constant written here would be a guess that hardens into a fact nobody revisits. Unset, the
  # entrypoint resolves \`\${RMD_RESTART_THROTTLE_S:-0}\` to 0 and behaves exactly as it does today.
  # Set it from ONE supervised boot: time container start → first \`dispatch.*\` ledger line, and
  # use that. Until then, running with it unset is the honest state, not a broken one.
  docker run -d --name remudero-daemon \\
    --restart=on-failure:5 \\
    --privileged \\
    --user 1000:1000 \\
    -e GH_TOKEN="\$GH_TOKEN" -e CLAUDE_CODE_OAUTH_TOKEN="\$CLAUDE_CODE_OAUTH_TOKEN" \\
    -e RMD_RESTART_THROTTLE_S="\${RMD_RESTART_THROTTLE_S:-}" \\
    -v ${STATE_DIR}:${STATE_MOUNT_DEST} \\
    ${REF} \\
    ./bin/rmd daemon

  # THE CONSOLE, IF WANTED, IS A SEPARATE CONTAINER WITH A DIFFERENT POLICY. serve returns 0 on a
  # clean shutdown and must come back from EVERY exit, so it takes unless-stopped, not on-failure.
  # launchd.ts records daemon-independence as a requirement: stopping the fleet must never blind
  # the operator, which is why this is not folded into the container above.
  docker run -d --name remudero-serve \\
    --restart=unless-stopped \\
    --user 1000:1000 \\
    -v ${STATE_DIR}:${STATE_MOUNT_DEST} \\
    ${REF} \\
    ./bin/rmd serve

  # STOPPING IT FROM OUTSIDE — no exec, no console, works from a phone. Both are plain files under
  # the state root, which is the host side of the bind mount above.
  #   PAUSE  (soft) new dispatch halts within the poll, in-flight work finishes, container keeps
  #          running. Persistent until cleared.
  touch ${STATE_DIR}/state/PAUSE     # and: rm ${STATE_DIR}/state/PAUSE  to resume
  #   STOP   (hard) the daemon exits 0, so --restart=on-failure does NOT restart it and the
  #          container stays down. The flag auto-consumes, so it cannot block a future start.
  touch ${STATE_DIR}/state/STOP

  # VERIFY THE MOUNT rather than trusting ${STATE_DIR} above — the source directory has changed once
  # already, and a PAUSE written to the wrong path is a lever that silently does nothing:
  docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{end}}' remudero-daemon

  # THE DEPLOY SUPERVISOR HAS NO CONTAINER EQUIVALENT AND NEEDS NONE. Its two jobs are getting new
  # code onto the machine and restarting the daemon onto it; here the entrypoint clones or
  # fast-forwards on every boot, and this script's own pull replaces the image wholesale.
PRINTED
  exit 0
fi

echo "host-update: target ${REF}"
[ "${DRY_RUN}" -eq 1 ] && echo "host-update: DRY RUN — nothing will be reclaimed and nothing pulled"

# ── 0. DOCKER MUST ANSWER, AND A PERMISSION FAILURE IS ITS OWN MESSAGE ───────────────────────
# `docker info` failing means one of two very different things, and the raw error buries which.
if ! DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/tmp/host-update-docker.err)"; then
  echo "host-update: docker is not answering." >&2
  sed 's/^/  /' /tmp/host-update-docker.err >&2 || true
  if grep -qi 'permission denied' /tmp/host-update-docker.err 2>/dev/null; then
    echo "  This is a PERMISSIONS failure, not a broken daemon. The operator user must be in the" >&2
    echo "  docker group: 'sudo usermod -aG docker \$USER', then log out and back in." >&2
    echo "  This script deliberately does not re-run itself under sudo." >&2
  else
    echo "  Check the daemon is up: 'systemctl status docker'." >&2
  fi
  exit 1
fi
[ -n "${DOCKER_ROOT}" ] || DOCKER_ROOT=/var/lib/docker
echo "host-update: docker data root ${DOCKER_ROOT}"

# ── 1. REFUSE WHILE A FLEET CONTAINER IS UP ──────────────────────────────────────────────────
# THIS IS THE MOST IMPORTANT REFUSAL IN THE FILE. `docker container prune` removes STOPPED
# containers only, but the images and build cache a running container depends on are a different
# question, and a reclaim run against a live dispatch is how a worktree gets discarded MID-IMPLEMENT
# — hours of work and real money, with the symptom appearing much later as an inexplicably empty
# tree. This operator has already lost two runs tonight to unrelated causes; a third to a disk
# script would be self-inflicted.
#
# DETECTION IS BY IMAGE NAME **OR** STATE MOUNT, and both halves are needed:
#   - the image test catches anything run from this registry, including old tags;
#   - the MOUNT test catches a container run from a locally-built tag (the measured runs used
#     `rmd-local:latest`), which no name test would match.
# Nothing here matches by container NAME: the measured invocations are ad-hoc `docker run --rm`
# with no --name at all, so a name filter would find nothing and report a false all-clear.
#
# THE REFUSAL IS DELIBERATELY BROAD. From outside the container, a `serve` process and a container
# hosting a mid-dispatch worker look identical — same image, same mount. Refusing on both is the
# only fail-direction that cannot destroy work, and stopping a serve container costs a restart.
fleet_containers() {
  ids="$(docker ps -q 2>/dev/null || true)"
  [ -n "${ids}" ] || return 0
  for id in ${ids}; do
    info="$(docker inspect --format \
      '{{.Name}}|{{.Config.Image}}|{{range .Mounts}}{{.Destination}} {{end}}' "${id}" 2>/dev/null || true)"
    case "${info}" in
      *"${IMAGE}"*|*"${STATE_MOUNT_DEST}"*) printf '%s %s\n' "${id}" "${info}" ;;
    esac
  done
}
LIVE="$(fleet_containers)"
if [ -n "${LIVE}" ]; then
  echo "host-update: REFUSING — a fleet container is RUNNING." >&2
  printf '%s\n' "${LIVE}" | sed 's/^/  /' >&2
  echo "  Reclaiming under a live run risks discarding a worktree mid-implement, which costs the" >&2
  echo "  whole run and shows up later as an empty tree rather than as an error here." >&2
  echo "  Stop it first ('docker stop <id>'), then re-run. Nothing has been changed." >&2
  # THE DILEMMA THIS REFUSAL USED TO CREATE, and the answer to it. An operator with an
  # eight-minute `preflight --ci-parity` in that container faced a choice between keeping a result
  # he could not read and reclaiming disk — the run's only artifact was a terminal buffer, and
  # `docker rm` takes `docker logs` with it. `preflightCommand` now writes its verdict to
  # coverage/preflight-summary.json inside the checkout, which lives on the mounted state volume,
  # so the result survives the container. Say so here rather than leaving it to be rediscovered.
  echo "  If that container is running a preflight, its verdict is written to" >&2
  echo "    <state-volume>/remudero/coverage/preflight-summary.json" >&2
  echo "  and SURVIVES removal — you do not have to choose between the result and the disk." >&2
  exit 1
fi
echo "host-update: no fleet container running"

# ── 2. AUTHENTICATE BEFORE DESTROYING ANYTHING ───────────────────────────────────────────────
# ACR tokens are short-lived and the pull failed with "authentication required" once today. Doing
# the login HERE — before the reclaim — is what bounds the imageless window described in the header:
# the likeliest failure is caught while the old image is still on disk.
if [ "${DRY_RUN}" -eq 0 ]; then
  if command -v az >/dev/null 2>&1; then
    echo "host-update: az acr login -n ${REGISTRY}"
    if ! az acr login -n "${REGISTRY}" >/dev/null; then
      echo "host-update: FAILED to authenticate to ${REGISTRY}." >&2
      echo "  ACR access tokens expire; this is the expected failure after a while away." >&2
      echo "    az login && az acr login -n ${REGISTRY}" >&2
      echo "  NOTHING has been reclaimed — the login runs before the prune for exactly this reason." >&2
      exit 1
    fi
  else
    echo "host-update: the Azure CLI is NOT installed on this host." >&2
    echo "  Authenticate docker by hand and re-run:" >&2
    echo "    docker login ${REGISTRY}.azurecr.io" >&2
    echo "  REFUSING to continue — an unauthenticated pull after a reclaim would leave this host" >&2
    echo "  with no image at all." >&2
    exit 1
  fi
fi

# ── 3. MEASURE BEFORE ────────────────────────────────────────────────────────────────────────
free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
human_kb() { awk -v k="${1:-0}" 'BEGIN{ split("KB MB GB TB",u," "); i=1; while(k>=1024 && i<4){k/=1024;i++} printf "%.1f%s", k, u[i] }'; }
digest_of() {
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$1" 2>/dev/null || true
}
# PRESENCE IS A DIFFERENT QUESTION FROM REGISTRY IDENTITY, and conflating them is a measured defect.
# `digest_of` reads `RepoDigests`, which is EMPTY for an image that was never pulled from a registry
# — a locally built tag, or one loaded from a file. So "the digest is empty" was being read as "the
# host had no image", and after the reclaim removed a perfectly real local image the run reported
# `FIRST PULL` for something byte-identical to what it had just deleted. That reads as progress when
# nothing changed, which is the exact class of false verdict this script exists to remove.
#
# The image ID answers presence and nothing else, and it is captured HERE — before the reclaim —
# alongside the digest, so the distinction costs no new information, only the asking.
id_of() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

BEFORE_DIGEST="$(digest_of "${REF}")"
BEFORE_ID="$(id_of "${REF}")"
BEFORE_FREE="$(free_kb "${DOCKER_ROOT}")"
echo
echo "host-update: BEFORE"
if [ -n "${BEFORE_DIGEST}" ]; then echo "  image on host   ${BEFORE_DIGEST}"; else echo "  image on host   (none for ${REF})"; fi
echo "  free on ${DOCKER_ROOT}   $(human_kb "${BEFORE_FREE}")"
echo "  docker usage:"
# CAPTURE, THEN PRINT — never `cmd | sed || fallback`. A pipeline reports its LAST stage, so the
# `||` would be testing sed, which always succeeds, and the fallback could never fire. This is the
# same trap recorded against the socat probe in deploy/Dockerfile and the check() helper in
# deploy/verify-image.sh; it is written this way in all three places on purpose.
if usage="$(docker system df 2>&1)"; then printf '%s\n' "${usage}" | sed 's/^/    /'
else echo "    (docker system df unavailable)"; fi

# THE STATE DIRECTORY IS MEASURED, NEVER TOUCHED. This is here because `docker system df` answers
# only for docker, and on this host the state volume is the other half of the 29GB. An operator
# seeing "docker reclaimed 9.5GB and the disk is still full" needs this number to know why.
if [ -d "${STATE_DIR}" ]; then
  echo "  state volume (READ ONLY, never reclaimed by this script):"
  # Captured for the same reason as above: `du | sed || echo` would test sed and never fall back.
  # `-x` keeps it on one filesystem so a nested mount cannot turn this into a whole-disk walk, and
  # the timeout bounds a tree that can hold several worktrees plus their node_modules.
  if command -v timeout >/dev/null 2>&1; then du_out="$(timeout 60 du -sxh "${STATE_DIR}" 2>&1)" && du_rc=0 || du_rc=$?
  else du_out="$(du -sxh "${STATE_DIR}" 2>&1)" && du_rc=0 || du_rc=$?; fi
  if [ "${du_rc}" -eq 0 ]; then printf '%s\n' "${du_out}" | sed 's/^/    /'
  else echo "    ${STATE_DIR} (size not measured — large tree or unreadable; not an error)"; fi
else
  echo "  state volume:   ${STATE_DIR} does not exist on this host"
fi

# ── 4. RECLAIM ───────────────────────────────────────────────────────────────────────────────
# TARGETED PRUNES, NOT `docker system prune -af`, and the difference is worth stating because the
# brief is right that `-a` is easy to run without understanding its scope.
#   `docker system prune`      removes stopped containers, dangling images, unused networks and
#                              build cache. It does NOT remove volumes unless --volumes is added,
#                              and it can never remove a BIND MOUNT under any flag.
#   `docker system prune -a`   ADDS every image not referenced by a container — which is where the
#                              ~20GB lives, and also why the pull must come afterwards.
# The three commands below are that same scope, split so each line's blast radius is legible and so
# `--volumes` cannot be added by accident to a combined command later. Volume pruning is absent on
# purpose and there is no flag here to enable it.
#
# ORDER WITHIN THE RECLAIM: containers first. A stopped container holds its own writable layer (the
# measured one held 4.9GB) AND keeps its image referenced, so removing containers first is what
# makes the image prune able to reach anything.
if [ "${DRY_RUN}" -eq 1 ]; then
  echo
  echo "host-update: DRY RUN — would run, in this order:"
  echo "    docker container prune -f"
  echo "    docker image prune -af"
  echo "    docker builder prune -af"
  echo "    docker pull ${REF}"
  echo "  The RECLAIMABLE column in 'docker system df' above is docker's own estimate of what those"
  echo "  would free. No volume prune, ever. ${STATE_DIR} is MEASURED above and never written to,"
  echo "  moved or removed — by this branch or any other."
else
  echo
  echo "host-update: reclaiming (stopped containers, unused images, build cache)"
  # `|| true` on each: a prune failure is NON-FATAL on purpose. Its error text still prints (2>&1
  # is inside the pipe), and the free-space delta below reports what was actually recovered, so a
  # partial reclaim is visible rather than silent. Aborting here would skip the pull and leave the
  # host on an old image because a cache prune complained — the wrong failure direction, since the
  # pull is the part the operator came for.
  docker container prune -f 2>&1 | sed 's/^/  /' || true
  docker image     prune -af 2>&1 | tail -1 | sed 's/^/  /' || true
  docker builder   prune -af 2>&1 | tail -1 | sed 's/^/  /' || true
fi

# ── 5. PULL, AFTER THE SPACE EXISTS ──────────────────────────────────────────────────────────
PULL_RC=0
if [ "${DRY_RUN}" -eq 0 ]; then
  echo
  echo "host-update: docker pull ${REF}"
  # TWO SEPARATE TRAPS HERE, AND THE SECOND WAS FOUND BY RUNNING THIS BRANCH, NOT BY READING IT.
  #
  # 1. ${PIPESTATUS[0]}, NOT the pipeline's own status. `if ! docker pull | tee | sed` tests SED,
  #    which always succeeds, so a failed pull would read as a success and the run would go on to
  #    report an update it never made. tee is kept so a multi-GB pull still shows progress.
  #
  # 2. `set -o pipefail` + `set -e` KILLS THE SCRIPT HERE unless the pipeline is guarded. With
  #    pipefail the pipeline inherits docker's non-zero status, so an unguarded failing pull aborted
  #    the run before PULL_RC was ever assigned — no auth diagnosis, no AFTER section, just a bare
  #    exit 1 with a raw docker error above it. That is precisely the confusing failure this script
  #    exists to replace, so the guard is the point rather than a style choice.
  set +e
  docker pull "${REF}" 2>&1 | tee /tmp/host-update-pull.log | sed 's/^/  /'
  PULL_RC="${PIPESTATUS[0]}"
  set -e
  if grep -qiE 'authentication required|unauthorized|denied' /tmp/host-update-pull.log 2>/dev/null; then
    PULL_RC=1
    echo "host-update: the pull was REJECTED for authentication." >&2
    echo "  The ACR token expired between the login above and the pull, or the login did not take." >&2
    echo "    az login && az acr login -n ${REGISTRY} && $0" >&2
    echo "  THIS HOST MAY NOW HAVE NO IMAGE — the reclaim already ran. Re-run once authenticated." >&2
  fi
fi

# ── 6. MEASURE AFTER, AND SAY WHETHER ANYTHING ACTUALLY CHANGED ──────────────────────────────
AFTER_DIGEST="$(digest_of "${REF}")"
AFTER_ID="$(id_of "${REF}")"
AFTER_FREE="$(free_kb "${DOCKER_ROOT}")"
echo
echo "host-update: AFTER"
echo "  free on ${DOCKER_ROOT}   $(human_kb "${AFTER_FREE}")"
# THE df DELTA IS THE AUTHORITATIVE NUMBER, not the prunes' own "Total reclaimed space" lines. Those
# are per-command, human-formatted, and exclude anything the pull then consumed — so they can read
# as a large win on a host that ended up with LESS free space than it started with. This subtracts
# the pull, which is the number the operator actually needs.
if [ "${DRY_RUN}" -eq 1 ]; then
  : # a dry run changes nothing, so a "net change" line would be noise dressed as a measurement
elif [ -n "${BEFORE_FREE:-}" ] && [ -n "${AFTER_FREE:-}" ]; then
  DELTA=$((AFTER_FREE - BEFORE_FREE))
  if [ "${DELTA}" -ge 0 ]; then
    echo "  net change      +$(human_kb "${DELTA}") free (reclaim minus whatever the pull consumed)"
  else
    echo "  net change      -$(human_kb "$((0 - DELTA))") free — the pull was larger than the reclaim"
  fi
fi

echo "  image on host:"
if [ -z "${AFTER_DIGEST}" ] && [ "${DRY_RUN}" -eq 0 ]; then
  echo "    NONE — ${REF} is not present after this run." >&2
  PULL_RC=1
elif [ "${DRY_RUN}" -eq 1 ]; then
  echo "    unchanged (dry run)"
elif [ "${PULL_RC}" -ne 0 ]; then
  # A FAILED PULL MUST NOT BE REPORTED AS A TAG VERDICT. Found by driving this branch: with the
  # ordinary comparison, an auth-rejected pull printed "NO CHANGE — the tag did not move", which is
  # a claim about the REGISTRY that a pull which never completed cannot support. The digest is
  # unchanged because nothing was fetched, and that is a different fact with a different remedy.
  echo "    UNCHANGED, BUT THE PULL FAILED — this is the pre-existing image, not a verdict on the tag"
  echo "      ${AFTER_DIGEST}"
elif [ -z "${BEFORE_ID}" ]; then
  # GENUINELY FIRST — no image of any kind was on the host when this run started. `BEFORE_ID`, not
  # `BEFORE_DIGEST`, decides this: see `id_of`. Both were captured before the reclaim, so neither is
  # describing a state this script created.
  echo "    FIRST PULL   ${AFTER_DIGEST}"
elif [ -z "${BEFORE_DIGEST}" ]; then
  # THE HOST HAD AN IMAGE, IT JUST CARRIED NO REGISTRY DIGEST — a locally built tag, most often
  # `rmd-local:latest` from the measured runs. This is NOT a first pull, and saying so would be the
  # false-progress report this branch exists to prevent. The IDs still answer whether the bits moved.
  if [ "${BEFORE_ID}" = "${AFTER_ID}" ]; then
    echo "    RE-FETCHED, IDENTICAL — the host had a local image with no registry digest, and the"
    echo "    pull returned the same bits. Nothing changed; this was NOT a first pull."
    echo "      ${AFTER_DIGEST}"
  else
    echo "    REPLACED a local image that carried no registry digest (so no from/to digest pair exists)"
    echo "      local before  ${BEFORE_ID}"
    echo "      pulled now    ${AFTER_DIGEST}"
  fi
elif [ "${BEFORE_DIGEST}" = "${AFTER_DIGEST}" ]; then
  # A no-op pull must not read as a successful update. This is the same trap deploy/verify-image.sh
  # was built around: a command that appears to have done something, on an artefact that predates
  # the change being looked for.
  echo "    NO CHANGE    ${AFTER_DIGEST}"
  echo "    The tag did not move. If a build was expected to publish, it did not, and anything"
  echo "    verified against this host now describes the OLDER image."
else
  echo "    UPDATED"
  echo "      from  ${BEFORE_DIGEST}"
  echo "      to    ${AFTER_DIGEST}"
fi

echo
if [ "${PULL_RC}" -eq 0 ]; then
  echo "host-update: OK"
  [ "${DRY_RUN}" -eq 0 ] && echo "  Next: ./deploy/verify-image.sh --expect ${AFTER_DIGEST#*@}"
else
  echo "host-update: FAILED — see above." >&2
fi
exit "${PULL_RC}"

# ── RECOMMENDED, NOT BUILT: THE WORKTREE REAPER BELONGS IN THE FLEET, NOT IN THIS SCRIPT ─────
# The question was whether abandoned worktrees on the state volume should be reaped here. They
# should not, and the premise that nothing reaps them without a daemon is only half right.
#
# WHAT IS ACTUALLY TRUE AT THIS SHA. `reapStaleWorktrees` (src/lib/worker.ts) is wrapped by
# `runWorktreeReapRung`, which has TWO call sites in src/run-task.ts: the daemon's per-poll sweep
# hook AND `rmd sweep`, a real operator verb. So the reaper IS reachable without a daemon today.
#
# WHY THAT DOES NOT SOLVE IT. `rmd sweep` is not a disk verb. Its primary action is PR disposition —
# its own usage string says "mergeable->arm auto-merge" and "stale/superseded->close-with-reason".
# An operator running it to reclaim disk would ARM AUTO-MERGE on every mergeable open PR as a side
# effect. And the obvious dodge does not work either: the reap is guarded by `if (!dryRun)`, so
# `rmd sweep --dry-run` takes no reap at all. There is no reap-only path.
#
# WHY NOT REIMPLEMENT IT HERE. Because the predicate is the hard part and shell cannot express it.
# `reapStaleWorktrees` keeps a tree when a run lock names a LIVE pid, when its branch is live, or on
# recent activity, and it resolves each entry's parent repo from that entry's OWN `.git` gitdir
# pointer. A `.git` FILE marks a LINKED WORKTREE whose objects live in the parent clone, so `rm -rf`
# on one destroys work while leaving the admin record behind — which is exactly how an agent's
# working tree was destroyed twice on 2026-07-31, and why `clone-reaper.ts` requires a `.git`
# DIRECTORY before it will touch anything. A shell reaper on the state volume would be a second,
# worse implementation of a predicate that has already caused data loss once.
#
# RECOMMENDATION: A BOOT RUNG IN THE FLEET. `reapStaleClones` already has one in src/run-task.ts,
# which is the precedent and the right shape: in a one-shot container world every container start IS
# the cadence, so a boot rung fires exactly as often as work happens, needs no operator, and reuses
# the predicate that already knows about live pids and linked worktrees. That is a src/ change with
# its own tests and it needs its own shard — deliberately not folded in here, and not filed by this
# PR either.
#
# NOT RECOMMENDED IN EITHER PLACE: ledger deletion. The archives are the evidence base and roughly
# 63% of history exists only inside them. See the header.
