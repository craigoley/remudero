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

# ── THE DECLARED RUNTIME VARIABLE NAMES — ONE LIST, READ HERE AND BY recycle-container.sh (W1-T1069)
# `deploy/runtime-env-vars.sh` is the single source of truth for which environment variable NAMES
# the daemon container carries at runtime; see that file's header for the full rationale, and
# deploy/recycle-container.sh's own copy of this block for how it uses the list to capture values
# off a live container. This script has no container to capture FROM (design iii: `--print-daemon-run`
# may legitimately run on a fresh host), so it only reads the NAMES, to keep the `-e` passthroughs
# below from being retyped by hand — the exact way this list drifted before W1-T1069. The inline
# fallback fires ONLY when this script has been copied away from its sibling (a test fixture does
# this on purpose); test/recycle-container.test.ts asserts this fallback, recycle-container.sh's
# own fallback, deploy/runtime-env-vars.sh's real array, and the `-e` names actually printed below
# never disagree, so neither the fallback nor the static passthrough block below can go stale
# unnoticed.
RMD_DAEMON_RUNTIME_ENV_VARS=(GH_TOKEN RMD_RESTART_THROTTLE_S RMD_FRESHNESS_RESTART_MAX GH_APP_ID GH_APP_INSTALLATION_ID GH_APP_PRIVATE_KEY_PATH)
RUNTIME_ENV_VARS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/runtime-env-vars.sh" || true
if [ -n "${RUNTIME_ENV_VARS_FILE:-}" ] && [ -f "${RUNTIME_ENV_VARS_FILE}" ]; then
  # shellcheck source=./runtime-env-vars.sh
  source "${RUNTIME_ENV_VARS_FILE}"
fi

REGISTRY="${REGISTRY:-synthwatcholey0620}"
IMAGE="${IMAGE:-remudero}"
TAG="${TAG:-latest}"
DRY_RUN=0
PRINT_DAEMON_RUN=0

# The HOST side of the state bind mount. The CONTAINER side is /home/node/Remudero (config.root
# derives from HOME — see REQ 10 in deploy/Dockerfile), and the measured invocation binds
# ~/rmd-state to it. Only ever read.
STATE_DIR="${RMD_STATE_DIR:-${HOME:-/root}/rmd-state}"
# The HOST side of the CREDENTIAL bind mount, derived the same way STATE_DIR is rather than
# hardcoded to one operator's home. MEASURED 2026-08-13, on the first containerised daemon: the
# printed invocation mounted NO credential at all, and the worker preflight refused every spawn —
# "refusing to spawn a credential-dead worker" — taking the retro, containment and triage with it.
#
# IT MUST BE THE DIRECTORY AND IT MUST BE WRITABLE, and that is the subtlest of the four defects
# found that night. The credential SELF-REFRESHES on an 8-hour cycle and is rewritten IN PLACE:
# measured to the millisecond, mtime 01:05:38.540 against expiresAt 09:05:38.322, exactly 8.0 hours.
# A `:ro` mount of the FILE therefore ages out silently — the CLI cannot write the new token back —
# and `assertWorkerCredentialFile`'s own comment names the assumption that breaks: "An EXPIRED token
# is reported and allowed through: there is nothing to re-provision from on this platform, the CLI
# maintains its own refresh." Mount the directory read-write and the refresh works.
CRED_DIR="${RMD_CLAUDE_DIR:-${HOME:-/root}/.claude}"
# The container-side path the credential must land on: `config.root` derives from HOME (Dockerfile
# REQ 10), so the worker home's `.claude` symlink grant resolves to exactly this.
CRED_MOUNT_DEST="/home/node/.claude"
# Codex subscription OAuth state. The CLI is baked into the image but provider routing stays
# disabled until config opts in; mounting the state here lets that opt-in survive replacement.
CODEX_DIR="${RMD_CODEX_DIR:-${HOME:-/root}/.codex}"
CODEX_MOUNT_DEST="/home/node/.codex"
# The repo `rmd daemon` drains. It REFUSES without `--repo` (usage dump, exit 2), which is how a
# containerised boot burned four restarts before anyone read the exit code — `daemon-plist` bakes
# the same flag for the launchd path, and the printed invocation must not be weaker.
DAEMON_REPO="${RMD_DAEMON_REPO:-remudero}"
# The container-side path, used to RECOGNISE a fleet container by what it has mounted. This is the
# check that catches a container started from a locally-tagged image such as `rmd-local:latest`,
# whose name contains nothing this script would otherwise match.
STATE_MOUNT_DEST="/home/node/Remudero"
# W1-T1222: the console's port, PUBLISHED ON THE HOST'S LOOPBACK ONLY (see the serve block below —
# never 0.0.0.0). Matches src/lib/serve.ts's DEFAULT_SERVE_PORT so the shipped dashboard's
# `?daemon=` default (http://localhost:4317) keeps resolving out of the box.
SERVE_PORT="${RMD_SERVE_PORT:-4317}"

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
  CODEX_MOUNT_LINE=""
  if [ -d "${CODEX_DIR}" ]; then
    printf -v CODEX_MOUNT_LINE '    -v %s:%s \\\n' "${CODEX_DIR}" "${CODEX_MOUNT_DEST}"
    echo "host-update: Codex home present — the printed daemon mounts ${CODEX_DIR}."
  else
    echo "host-update: NOTE — no Codex home at ${CODEX_DIR}; the printed daemon stays Claude-only." >&2
    echo "  Authenticate it first or set RMD_CODEX_DIR; no empty root-owned bind directory will be created." >&2
  fi
  # ── THE PRINTED PATH IS CHECKED BEFORE IT IS PRINTED ───────────────────────────────────────
  # MEASURED 2026-08-12, and this is the failure being fixed: on the Azure host `${HOME}/rmd-state`
  # holds a ledger that STOPS ON AUG 8 (100,330 bytes) while `${HOME}/rmd-state2` is live
  # (492,406 bytes, Aug 12) — every drain this week ran `-v ~/rmd-state2:/home/node/Remudero`. The
  # volume moved and this default did not, so the block below printed a mount, a PAUSE lever and a
  # STOP lever all pointing at an abandoned directory. The script already warns three lines later
  # that "a PAUSE written to the wrong path is a lever that silently does nothing"; it just never
  # checked its own.
  #
  # WHY A CHECK AND NOT A NEW LITERAL. Editing `rmd-state` to `rmd-state2` fixes today and goes
  # stale the next time the volume moves — which the comment below records has already happened
  # ONCE. The derivation is not the bug; printing an UNVERIFIED path is. So: state what was
  # derived, prove it holds a ledger, and when it does not, name the siblings that do. This is
  # also the ONLY code path in this script that did not check — `${STATE_DIR}` is validated later
  # for the disk measurement (`if [ -d "${STATE_DIR}" ]`), just never here.
  #
  # IT NEVER PICKS FOR YOU AND NEVER REFUSES. Silently mounting a different volume than the one
  # printed last week is its own hazard, and a fresh host provisioning a fleet legitimately has no
  # ledger yet — refusing there would be a bound firing on a healthy condition. Three states, the
  # same discipline `verify-image.sh` uses for the CLI pin: PASS names the evidence, UNKNOWN says
  # so without a verdict, and only a real disagreement is loud.
  # PRESENCE IS NOT THE SIGNAL — FRESHNESS IS. The abandoned volume DOES hold a ledger; that is
  # precisely why nobody noticed. `rmd-state/state/ledger.ndjson` is 100,330 bytes and stops on
  # Aug 8, while `rmd-state2`'s is 492,406 bytes and was written Aug 12. A check that asked only
  # "is there a ledger here" answers YES on the dead volume and stays silent — the same
  # readable-but-not-current shape this repo has been caught by before. So the derived path is
  # compared against its siblings, and a sibling written MORE RECENTLY is the finding.
  state_ledger="${STATE_DIR}/state/ledger.ndjson"
  describe_ledger() { # path -> "N bytes, YYYY-MM-DD HH:MM"
    printf '%s bytes, %s' "$(wc -c <"$1" | tr -d ' ')" "$(date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || echo 'mtime unknown')"
  }
  # Siblings are only ever REPORTED, never chosen: silently mounting a different volume than the
  # one printed last week is its own hazard. `${STATE_DIR}*` catches the rmd-state -> rmd-state2
  # shape that actually happened without hardcoding either name.
  newer_sibling=""
  for cand in "${STATE_DIR}"*; do
    [ "${cand}" = "${STATE_DIR}" ] && continue
    cand_ledger="${cand}/state/ledger.ndjson"
    [ -s "${cand_ledger}" ] || continue
    if [ ! -s "${state_ledger}" ] || [ "${cand_ledger}" -nt "${state_ledger}" ]; then
      newer_sibling="${cand_ledger}"
    fi
  done

  if [ -n "${newer_sibling}" ]; then
    if [ -s "${state_ledger}" ]; then
      echo "host-update: WARNING — ${state_ledger} ($(describe_ledger "${state_ledger}")) is STALER than a sibling." >&2
    else
      echo "host-update: WARNING — ${STATE_DIR} holds no ledger at state/ledger.ndjson." >&2
    fi
    echo "  more recently written: ${newer_sibling} ($(describe_ledger "${newer_sibling}"))" >&2
    echo "  THE MOUNT AND BOTH LEVERS BELOW POINT AT ${STATE_DIR}. If that is the wrong volume, the" >&2
    echo "  PAUSE and STOP files land where nothing reads them and silently do nothing." >&2
    echo "  Re-run with the volume you mean: RMD_STATE_DIR=<path> $0 --print-daemon-run" >&2
  elif [ -s "${state_ledger}" ]; then
    echo "host-update: state volume OK — ${state_ledger} ($(describe_ledger "${state_ledger}")), newest of its siblings"
  else
    # No ledger anywhere under this prefix. Expected while provisioning a host, so it is a NOTE
    # rather than a warning — refusing here would be a bound firing on a healthy condition.
    echo "host-update: NOTE — no ledger under ${STATE_DIR} or its siblings; expected on a fresh host." >&2
  fi

  # ── THE CREDENTIAL IS CHECKED THE SAME WAY, AND EXPIRY IS THE CHECK THAT MATTERS ────────────
  # Three states, same discipline as the state volume above: absent, present-but-expired, and OK.
  # EXPIRY EARNS ITS PLACE because it is the failure that cost four container restarts to find —
  # a mounted, readable, genuine credential whose token had aged out reads as fully healthy to
  # every other check. `assertWorkerCredentialFile` deliberately lets an expired token through
  # (the CLI is expected to refresh it), so nothing downstream complains either; the probe just
  # reports `rate_limits_available: false` and the governor goes blind.
  #
  # `expiresAt` is epoch MILLISECONDS. Extracted with grep/cut rather than jq or node: this script
  # is documented to run on a host with no node, no rmd and no checkout, and jq is not present on
  # the measured host either.
  cred_file="${CRED_DIR}/.credentials.json"
  if [ ! -r "${cred_file}" ]; then
    echo "host-update: WARNING — no readable credential at ${cred_file}." >&2
    echo "  The worker preflight REFUSES every spawn without one (\"credential-dead worker\"), which" >&2
    echo "  also takes down the retro, containment and triage rungs. Point at the right home with:" >&2
    echo "  RMD_CLAUDE_DIR=<path> $0 --print-daemon-run" >&2
  else
    cred_exp="$(grep -ao '"expiresAt":[0-9]*' "${cred_file}" 2>/dev/null | head -1 | cut -d: -f2)"
    cred_now="$(( $(date +%s) * 1000 ))"
    if [ -z "${cred_exp}" ]; then
      # A credential with no stated expiry is NOT a failure — a bare token legitimately carries
      # none. Say so rather than inventing a verdict either way.
      echo "host-update: NOTE — ${cred_file} states no expiresAt; freshness not checkable." >&2
    elif [ "${cred_exp}" -le "${cred_now}" ]; then
      echo "host-update: WARNING — the credential at ${cred_file} EXPIRED $(( (cred_now - cred_exp) / 60000 )) minute(s) ago." >&2
      echo "  It will still authenticate enough to pass the worker preflight, so nothing downstream" >&2
      echo "  will complain — but the headroom probe returns rate_limits_available:false and the" >&2
      echo "  governor runs blind. The CLI refreshes this file IN PLACE, so mount the DIRECTORY" >&2
      echo "  read-write (as printed below); a :ro or single-FILE mount can never be refreshed." >&2
    else
      echo "host-update: credential OK — ${cred_file}, valid for $(( (cred_exp - cred_now) / 60000 )) more minute(s)"
    fi
  fi
  echo
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
  # restart; longer than necessary just idles the fleet. This block used to say NOBODY HAD MEASURED
  # THAT INTERVAL, because no daemon had ever run in a container. ONE HAS NOW, and the supervised
  # boot this comment asked for was taken on the Azure instance at 2026-08-13T06:04Z:
  #   06:04:17.1  entrypoint fetch + \`checkout --detach\` complete (.git/packed-refs, .git/HEAD)
  #   06:04:18.3  first \`daemon.*\` ledger row — the process is up 1.2s after the checkout
  #   06:04:29.2  \`daemon.start\` — the 10.9s gap is ONE call, \`board_gateway.fetch_bytes\`
  #               (26,680,472 bytes over 14 REST calls); it is the whole of boot cost
  #   06:05:45.3  first \`run.start\` (W1-T404) — the first tick sweeps and idles, so useful
  #               dispatch lands one poll interval later
  # CONTAINER START → FIRST USEFUL DISPATCH IS ~88s, and 73-88s across the four boots in that
  # ledger that dispatched at all. So a throttle BELOW ~90s cannot save a restart, and the
  # provisional 300s currently set on the running container is ~3.4x above the measurement.
  #
  # THE NUMBER IS NOT THE WHOLE ANSWER, THOUGH, AND THE REST ARGUES AGAINST 0 RATHER THAN FOR IT.
  # \`stale\` exits NON-ZERO, so once \`DaemonDeps.checkFreshness\` is wired every freshness
  # self-restart pays this sleep too. Measured on origin/main over 14 days: 645 commits, and after
  # absorbing those a restart would already cover, 13-30 restarts/day (worst day 20-61) depending
  # on how much of the day the daemon spends inside a dispatch — measured at 18.2%, p50 28.3 min.
  # At 300s that is 1.4-3.2h/day of deliberate downtime. At 0s it is 19-44 min/day, but the densest
  # 10-minute window then holds 4 boots against \`DEFAULT_CRASHLOOP_WINDOW\`'s maxBoots of 5 — one
  # boot of margin before W1-T215's invariant escalates a needs-human issue on a HEALTHY fleet.
  # A value near the measurement (~90-120s) keeps both bounds comfortable; that is the recommendation
  # this block now carries, and the operator still sets it, because \`--restart=on-failure:5\`'s own
  # count cap is the other half and only they can watch it. Unset, the entrypoint resolves
  # \`\${RMD_RESTART_THROTTLE_S:-0}\` to 0 and behaves exactly as it does today.
  # THE CREDENTIAL IS A DIRECTORY MOUNT, READ-WRITE, AND NOT AN ENV TOKEN. A bare
  # CLAUDE_CODE_OAUTH_TOKEN authenticates but carries NO PLAN CONTEXT: measured A/B, same account,
  # same binary — with the credential FILE, subscription_type "max" and rate_limits_available true;
  # with the token alone, subscription_type null and rate_limits null. The SDK's own doc names that
  # bucket ("false for API key, Bedrock, Vertex, or missing profile scope"), so the governor cannot
  # read headroom at all. Mount the directory READ-WRITE: the token self-refreshes on an 8-hour
  # cycle and is rewritten in place, so :ro or a single-FILE mount ages out silently.
  #
  # --repo IS REQUIRED. \`rmd daemon\` refuses without it (usage dump, exit 2) and the restart
  # throttle then sleeps before exiting, so the failure looks like a hang. --allow-self-target is
  # printed BECAUSE THIS FLEET DRAINS ITS OWN SOURCE REPO, and it is the consent record W1-T109
  # exists to capture: if you are pointing this at a DIFFERENT repo, delete the flag rather than
  # carrying it by habit. Read this line before you paste it.
  #
  # NO LONGER \`--privileged\` (W1-T508). MEASURED on this host in throwaway containers: bubblewrap's
  # nested user+mount namespace needs settable seccomp, settable AppArmor and an unmasked /proc — not
  # a capability — so \`--cap-drop ALL\` plus the three \`--security-opt\` relaxations below pass the
  # fleet's own containment preflight (\`defaultExecutor\`, src/lib/containment.ts) IDENTICALLY to
  # \`--privileged\`, while emptying the bounding capability set (41 -> 0) and removing all 16 host
  # block devices \`--privileged\` exposes, \`nvme0n1p1\` (the host root disk) among them. This is NOT
  # a sandboxed container — seccomp and AppArmor are both off for the whole thing — it is fewer
  # capabilities and no device access. See deploy/Dockerfile's REQ 9 comment for the full doctrine.
  # THIS ONLY CHANGES THE PRINTED TEXT: the operator re-runs \`docker run\` by hand to apply it.
  #
  # RMD_FRESHNESS_RESTART_MAX AND THE THREE GH_APP_* VARIABLES (W1-T1069). All four are declared in
  # deploy/runtime-env-vars.sh alongside GH_TOKEN and RMD_RESTART_THROTTLE_S above — this printed
  # invocation carries a passthrough for EVERY declared name now, not just the two that existed when
  # this block was first written. GH_APP_ID, GH_APP_INSTALLATION_ID and GH_APP_PRIVATE_KEY_PATH
  # configure src/lib/github-app.ts's installation-token refresh; leaving any one of them unset is
  # not an error — startInstallationTokenRefresh treats an unconfigured host as deliberately
  # byte-identical to one that never had the feature (see that file) — but a printed command that
  # silently omitted them handed an operator a recipe for the exact silent-drop outage this closes.
  docker run -d --name remudero-daemon \\
    --restart=on-failure:5 \\
    --cap-drop ALL \\
    --security-opt seccomp=unconfined \\
    --security-opt apparmor=unconfined \\
    --security-opt systempaths=unconfined \\
    --user 1000:1000 \\
    -e GH_TOKEN="\$GH_TOKEN" \\
    -e RMD_RESTART_THROTTLE_S="\${RMD_RESTART_THROTTLE_S:-}" \\
    -e RMD_FRESHNESS_RESTART_MAX="\${RMD_FRESHNESS_RESTART_MAX:-}" \\
    -e GH_APP_ID="\${GH_APP_ID:-}" \\
    -e GH_APP_INSTALLATION_ID="\${GH_APP_INSTALLATION_ID:-}" \\
    -e GH_APP_PRIVATE_KEY_PATH="\${GH_APP_PRIVATE_KEY_PATH:-}" \\
${CODEX_MOUNT_LINE}    -v ${STATE_DIR}:${STATE_MOUNT_DEST} \\
    -v ${CRED_DIR}:${CRED_MOUNT_DEST} \\
    ${REF} \\
    ./bin/rmd daemon --repo ${DAEMON_REPO} --allow-self-target

  # THE CONSOLE, IF WANTED, IS A SEPARATE CONTAINER WITH A DIFFERENT POLICY. serve returns 0 on a
  # clean shutdown and must come back from EVERY exit, so it takes unless-stopped, not on-failure.
  # launchd.ts records daemon-independence as a requirement: stopping the fleet must never blind
  # the operator, which is why this is not folded into the container above.
  #
  # W1-T1222: THE PUBLISH AND THE BIND HOST, TOGETHER, ARE WHAT GIVE THIS CONTAINER AN ADDRESS.
  # Before this block, remudero-serve ran with no -p and no RMD_SERVE_HOST, so
  # src/lib/serve.ts's DEFAULT_SERVE_HOST (127.0.0.1) bound loopback INSIDE the container's own
  # network namespace — reachable from nothing outside it, Docker's -p NAT included, so seven
  # merged console features arrived on a surface with no address.
  #
  # -p BINDS THE HOST'S loopback, never 0.0.0.0 — assertBindableHost's refusal (R-5) is deliberate
  # and this does not widen it; a published port is still an operator act, same as it always was.
  # RMD_SERVE_HOST=0.0.0.0 and RMD_SERVE_NETWORK=container are the pair resolveServeHosts (that
  # same file) requires TOGETHER before it accepts a wildcard bind — the one carve-out W1-T915
  # shipped, and it opens only the container's own namespace, never the host's other networks or
  # the public internet on its own (co-locating the Cloudflare tunnel client, or another -p, stay
  # separate operator acts). RMD_SERVE_HOST keeps its own default here rather than a fixed value so
  # an operator can still override it to a tailnet address instead (see resolveServeHosts's own
  # doc); RMD_SERVE_NETWORK is the container-namespace declaration itself and is not a value an
  # operator has any reason to change, but stays a passthrough rather than a literal so a copy of
  # this line never drifts from what src/lib/serve.ts actually reads.
  docker run -d --name remudero-serve \\
    --restart=unless-stopped \\
    --user 1000:1000 \\
    -p 127.0.0.1:${SERVE_PORT}:${SERVE_PORT} \\
    -e RMD_SERVE_HOST="\${RMD_SERVE_HOST:-0.0.0.0}" \\
    -e RMD_SERVE_NETWORK="\${RMD_SERVE_NETWORK:-container}" \\
    -v ${STATE_DIR}:${STATE_MOUNT_DEST} \\
    ${REF} \\
    ./bin/rmd serve

  # W1-T2568: this printed block carries no secret-file mount at all (it never has — neither the
  # GH_APP_* passthrough nor the account file was ever threaded back here; both landed straight
  # in deploy/serve-container.sh, the REAL production launcher). The signed GitHub-event wake's
  # optional secret
  # (RMD_GITHUB_WEBHOOK_SECRET_PATH -> RMD_GITHUB_WEBHOOK_SECRET_FILE) is armed by THAT script,
  # not this printed one — see deploy/serve-container.sh and docs/operator-guide.md's webhook
  # commissioning section. Copy-pasting the block above still boots a console; it just ships the
  # webhook route dark (a named refusal, never a boot failure) until commissioned the real way.

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
