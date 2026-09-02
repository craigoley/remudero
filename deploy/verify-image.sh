#!/usr/bin/env bash
# verify-image — pull the published image and PROVE the toolchain is actually in it.
#
# WHY THIS EXISTS, AND IT IS NOT CONVENIENCE. Verifying by hand produced a confidently wrong
# answer on 2026-08-08. Two commands were run back to back; the FIRST failed with a registry
# authentication error, so nothing new came down, and the SECOND then ran the STALE LOCAL image
# from a previous build and reported `exec: "claude": executable file not found in $PATH`. That
# reads exactly like "the fix did not work". It was not the fix — it was an image the machine had
# never replaced, being asked a question about a change it predates. Meanwhile the build log for
# that very tag shows the version probe printing successfully.
#
# So the ONE rule this script exists to enforce: NEVER REPORT A VERDICT ON AN IMAGE YOU HAVE NOT
# CONFIRMED YOU JUST OBTAINED. Every step that could leave a stale image in place is fatal here,
# and the digest actually under test is printed with every result so a wrong answer cannot look
# like a right one.
#
# PLAIN BASH AND DOCKER, deliberately — the same discipline as scripts/fleet-heartbeat.sh. This
# runs on a host that may have no node, no rmd and no checkout, and it must keep working when the
# thing it is inspecting is broken.
#
# USAGE
#   ./deploy/verify-image.sh                          # pull :latest and check it
#   ./deploy/verify-image.sh --tag <sha>              # a specific tag instead of :latest
#   ./deploy/verify-image.sh --expect sha256:<digest> # ALSO assert it is exactly the build's image
#   REGISTRY=... IMAGE=... ./deploy/verify-image.sh    # retarget without editing this file
#
# The --expect form is the strongest available check and costs one paste: the ACR build workflow
# prints the pushed digest, and passing it here proves the artifact under test is the artifact
# that build produced, rather than something merely present under the same tag.

set -euo pipefail

REGISTRY="${REGISTRY:-synthwatcholey0620}"
IMAGE="${IMAGE:-remudero}"
TAG="${TAG:-latest}"
EXPECT_DIGEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)      TAG="${2:?--tag needs a value}"; shift 2 ;;
    --expect)   EXPECT_DIGEST="${2:?--expect needs a sha256:... digest}"; shift 2 ;;
    --registry) REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --image)    IMAGE="${2:?--image needs a value}"; shift 2 ;;
    -h|--help)  sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "verify-image: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

REF="${REGISTRY}.azurecr.io/${IMAGE}:${TAG}"
echo "verify-image: target ${REF}"

# ── 1. AUTHENTICATE FIRST, AND FAIL LOUDLY ───────────────────────────────────────────────────
# An unauthenticated pull against ACR fails with "authentication required", which is easy to
# scroll past when a second command follows it. Doing the login here, as its own fatal step,
# means the run stops at the real cause instead of proceeding to interrogate a stale image.
if command -v az >/dev/null 2>&1; then
  echo "verify-image: az acr login -n ${REGISTRY}"
  if ! az acr login -n "${REGISTRY}" >/dev/null; then
    echo "verify-image: FAILED to authenticate to ${REGISTRY}." >&2
    echo "  If this is a fresh shell, 'az login' first. The pull cannot succeed without this," >&2
    echo "  and a stale local image would otherwise answer in the new image's place." >&2
    exit 1
  fi
else
  echo "verify-image: the Azure CLI is NOT installed on this host." >&2
  echo "  Either install it and re-run, or authenticate docker by hand before running this:" >&2
  echo "    docker login ${REGISTRY}.azurecr.io" >&2
  echo "  REFUSING to continue — an unauthenticated pull leaves the OLD image in place and the" >&2
  echo "  checks below would silently describe that one instead." >&2
  exit 1
fi

# ── 2. RECORD WHAT WAS HERE BEFORE, SO "DID IT ACTUALLY CHANGE" IS ANSWERABLE ────────────────
digest_of() {
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$1" 2>/dev/null || true
}
BEFORE="$(digest_of "${REF}")"
[ -n "${BEFORE}" ] && echo "verify-image: local before pull: ${BEFORE}" || echo "verify-image: no local copy before pull"

# ── 3. PULL. A FAILURE HERE IS FATAL — that is the whole point. ──────────────────────────────
echo "verify-image: docker pull ${REF}"
docker pull "${REF}"

AFTER="$(digest_of "${REF}")"
if [ -z "${AFTER}" ]; then
  echo "verify-image: pulled, but could not read a repo digest back. Refusing to certify." >&2
  exit 1
fi
echo "verify-image: digest under test: ${AFTER}"
if [ "${BEFORE}" = "${AFTER}" ] && [ -n "${BEFORE}" ]; then
  echo "verify-image: NOTE — the digest did not change; this host was already on this image."
  echo "               That is fine on a re-run, but if you expected a NEW build, the tag was"
  echo "               not moved by it and the results below describe the OLDER image."
fi

# ── 4. OPTIONAL: assert it is EXACTLY the image a named build produced. ──────────────────────
if [ -n "${EXPECT_DIGEST}" ]; then
  if ! printf '%s' "${AFTER}" | grep -qF -- "${EXPECT_DIGEST}"; then
    echo "verify-image: DIGEST MISMATCH." >&2
    echo "  expected to contain: ${EXPECT_DIGEST}" >&2
    echo "  actually under test: ${AFTER}" >&2
    echo "  The tag does not point at the build you named. Everything below would be about a" >&2
    echo "  different image, so nothing is checked." >&2
    exit 1
  fi
  echo "verify-image: digest matches the expected build."
fi

# ── 5. THE CHECKS, RUN INSIDE THE IMAGE ──────────────────────────────────────────────────────
# `--entrypoint /bin/sh` bypasses tini for the probe only; the image's own ENTRYPOINT is
# unchanged and untested by this, which is correct — this asks "is the toolchain present", not
# "does the daemon boot". Each check reports independently and none aborts the others, so one
# missing tool does not hide the state of the rest.
#
# THE OVERRIDE IS ALSO WHAT MAKES THESE CHECKS POSSIBLE AT ALL, and that is worth knowing for
# ad-hoc diagnosis too. The image's entrypoint clones a work tree BEFORE running any command, so a
# plain `docker run <image> ls -la /home/node/.npm` needs GH_TOKEN and network and can fail before
# it reaches `ls`. To ask a question about the image's contents by hand, step around it the same way
# this does — `--entrypoint bash --user 1000:1000` — or go through it with `-e RMD_SKIP_BOOTSTRAP=1`.
#
# NOTE what is NOT overridden: the USER. The probe runs as the image's runtime user, and the cache
# ownership check below is only meaningful because of that.
#
# ── NO APOSTROPHE MAY APPEAR BELOW, INCLUDING IN A COMMENT ───────────────────────────────────
# Every probe in this file is ONE single-quoted `-c` argument, so the first `'` inside it ENDS the
# argument. MEASURED on the published image: the word `version's` in a comment truncated this probe
# from 194 lines to 76, handed docker two stray positional arguments, and left everything after the
# apostrophe running ON THE HOST. Three results were then false — `playwright pin` and `bootstrap
# entrypoint` FAILED because the HOST has no /opt/pw-pin and no /usr/local/bin/rmd-entrypoint, and
# `runtime user` PASSED reporting the host operator's own username. `bash -n` stayed CLEAN
# throughout, because the stray quotes re-balanced; the file was never syntactically broken, only
# addressed to the wrong machine. The host also EXECUTED a backtick pair from that same comment.
# test/verify-image-probes.test.ts now enforces delivery, since reading for this has failed twice.
# THE DECLARED PIN, read HOST-SIDE so the probe stays one clean single-quoted argument.
# deploy/Dockerfile is the single place this repo declares which CLI its workers run, and
# src/lib/env.ts parseDeclaredClaudeVersion reads THE SAME LINE at runtime - one declaration, two
# consumers, nothing to keep in sync. Empty when the file is absent (this script is documented to
# run on a host with no checkout), and empty means the probe reports UNKNOWN rather than a verdict.
EXPECT_CLAUDE_VERSION="$(sed -n 's/^[[:space:]]*ARG[[:space:]]\{1,\}CLAUDE_CODE_VERSION[[:space:]]*=[[:space:]]*"\{0,1\}\([^"[:space:]#]\{1,\}\).*/\1/p' "$(dirname "$0")/Dockerfile" 2>/dev/null | head -1)"
EXPECT_CODEX_VERSION="$(sed -n 's/^[[:space:]]*ARG[[:space:]]\{1,\}CODEX_VERSION[[:space:]]*=[[:space:]]*"\{0,1\}\([^"[:space:]#]\{1,\}\).*/\1/p' "$(dirname "$0")/Dockerfile" 2>/dev/null | head -1)"
if [ -n "${EXPECT_CLAUDE_VERSION}" ]; then
  echo "verify-image: deploy/Dockerfile declares claude ${EXPECT_CLAUDE_VERSION}"
else
  echo "verify-image: no CLAUDE_CODE_VERSION found in deploy/Dockerfile - version VALUE will not be compared"
fi
if [ -n "${EXPECT_CODEX_VERSION}" ]; then
  echo "verify-image: deploy/Dockerfile declares codex ${EXPECT_CODEX_VERSION}"
else
  echo "verify-image: no CODEX_VERSION found in deploy/Dockerfile - version VALUE will not be compared"
fi

# THE BUILD SHA, read HOST-SIDE from the image LABEL so the in-image probe below can compare it
# against the FILE. Two carriers, one ARG (deploy/Dockerfile REQ 15): the label is what a host-side
# tool reads without starting a container, the file is what an agent INSIDE a running container can
# read with no docker at all. They are written from the same build-arg, so disagreement is a
# malformed image and nothing else - which is the only thing this probe fails on.
#
# `docker inspect` renders an absent label as the literal `<no value>`, and an image built before
# REQ 15 landed has no label at all. Both normalise to EMPTY here, and empty means the probe
# reports UNKNOWN rather than a verdict - the same rule the CLAUDE_CODE_VERSION read above follows.
LABEL_BUILD_SHA="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${REF}" 2>/dev/null || true)"
[ "${LABEL_BUILD_SHA}" = "<no value>" ] && LABEL_BUILD_SHA=""
if [ -n "${LABEL_BUILD_SHA}" ]; then
  echo "verify-image: image LABEL declares build sha ${LABEL_BUILD_SHA}"
else
  echo "verify-image: no org.opencontainers.image.revision label - build sha will not be compared"
fi

echo
echo "verify-image: checks inside ${AFTER}"
set +e
docker run --rm -e EXPECT_CLAUDE_VERSION="${EXPECT_CLAUDE_VERSION}" -e EXPECT_CODEX_VERSION="${EXPECT_CODEX_VERSION}" -e EXPECT_BUILD_SHA="${LABEL_BUILD_SHA}" --entrypoint /bin/sh "${REF}" -c '
  fail=0
  # W1-T2571: infrastructure faults are counted SEPARATELY from product failures so the two can
  # be told apart in the summary; both still exit non-zero (see `exit` at the end of this probe).
  infra=0
  # `if out="$(cmd)"` tests CMD, which piping into head would not: a pipeline reports the LAST
  # stage, so `cmd | head` returns head status and a missing binary would read as a pass. The
  # first line is taken afterwards, from the captured text, never from a pipe in the test.
  # W1-T2571: A CHECK THAT COULD NOT RUN IS NOT A CHECK THAT FAILED, and this file already states
  # the rule two screens up — on an absent version pin it "reports UNKNOWN rather than a verdict",
  # because "a read that did not happen must never render as a match". That rule was applied only
  # to the PASS direction. A command the HOST could not run is the same class in the FAIL
  # direction: it must not render as the thing the label names being broken.
  #
  # MEASURED 2026-09-01, host disk at 100%: one run produced THREE confident, specific, WRONG
  # diagnoses — the sharpest being "every worker in this image writes files and commits NOTHING",
  # a precise claim about containment and git wiring. Every one was `no space left on device`. The
  # image was fine, and the next operator moves were aimed at the product while the disk went
  # unexamined. A DIAGNOSTIC THAT IS CONFIDENTLY WRONG IS WORSE THAN ONE THAT ERRORS, because its
  # output is specific enough to act on.
  #
  # ⚠ NO APOSTROPHES ANYWHERE IN THIS PROBE, INCLUDING COMMENTS. This whole block is a
  # single-quoted `sh -c` payload: one apostrophe closes the string, and every word after it
  # becomes a stray argv entry to docker. `bash -n` stays CLEAN when that happens because the
  # quotes merely re-balance — the first draft of this very comment did it, and only
  # test/verify-image-probes.test.ts caught it.
  #
  # NARROW BY CONSTRUCTION. Only signatures that CANNOT be produced by the image being wrong count
  # — a full disk, a read-only filesystem, an exhausted fd/process table. Anything else stays a
  # product FAIL, because widening this would silence the failures the script exists to catch.
  infra_fault() {
    case "$1" in
      *"No space left on device"*|*"no space left on device"*) return 0 ;;
      *"Read-only file system"*|*"read-only file system"*)     return 0 ;;
      *"Too many open files"*|*"too many open files"*)         return 0 ;;
      *"Cannot allocate memory"*|*"cannot allocate memory"*)   return 0 ;;
      *"Resource temporarily unavailable"*)                    return 0 ;;
    esac
    return 1
  }
  check() {
    label="$1"; shift
    if out="$("$@" 2>&1)"; then
      printf "  PASS  %-22s %s\n" "$label" "$(printf "%s" "$out" | head -1)"
    elif infra_fault "$out"; then
      # THE THIRD STATE CHANGES THE DIAGNOSIS AND NEVER THE DISPOSITION: `infra=1` still exits
      # non-zero below, so an unverifiable image is never reported as a verified one. What changes
      # is that the label is named as UNVERIFIED rather than accused.
      printf "  INFRA %-22s (could not run: %s)\n" "$label" "$(printf "%s" "$out" | head -1)"
      infra=1
    else
      printf "  FAIL  %-22s (%s)\n" "$label" "$(printf "%s" "$out" | head -1)"
      fail=1
    fi
  }
  check "claude"    claude --version
  check "codex"     codex --version
  # BEGIN claude-version-value
  # `check` above passes on EXIT STATUS: it proves a claude binary exists and runs, and says
  # NOTHING about which one. That is the vacuous shape this file has been corrected for six times,
  # and a binary of the wrong version is exactly the failure it would certify green - the image
  # pins the CLI against the SDK version in package-lock.json, and an unpaired combination is
  # untested. So compare the VALUE against the pin the Dockerfile declares.
  # THREE STATES. An absent expectation is UNKNOWN and prints WARN without failing, because a read
  # that did not happen must never render as a match - the same rule src/lib/env.ts readBinaryPin
  # follows. Only a REAL disagreement fails.
  got_claude="$(claude --version 2>&1 | head -1 | cut -d" " -f1)"
  if [ -z "${EXPECT_CLAUDE_VERSION:-}" ]; then
    printf "  WARN  %-22s installed %s, no declared pin to compare against\n" "claude version" "${got_claude}"
  elif [ "${got_claude}" = "${EXPECT_CLAUDE_VERSION}" ]; then
    printf "  PASS  %-22s %s matches the declared pin\n" "claude version" "${got_claude}"
  else
    printf "  FAIL  %-22s image has %s but deploy/Dockerfile declares %s\n" "claude version" "${got_claude}" "${EXPECT_CLAUDE_VERSION}"
    fail=1
  fi
  # END claude-version-value
  # BEGIN codex-version-value
  got_codex="$(codex --version 2>&1 | head -1 | awk "{print \$2}")"
  if [ -z "${EXPECT_CODEX_VERSION:-}" ]; then
    printf "  WARN  %-22s installed %s, no declared pin to compare against\n" "codex version" "${got_codex}"
  elif [ "${got_codex}" = "${EXPECT_CODEX_VERSION}" ]; then
    printf "  PASS  %-22s %s matches the declared pin\n" "codex version" "${got_codex}"
  else
    printf "  FAIL  %-22s image has %s but deploy/Dockerfile declares %s\n" "codex version" "${got_codex}" "${EXPECT_CODEX_VERSION}"
    fail=1
  fi
  # END codex-version-value
  # BEGIN image-build-sha
  # WHAT THIS ANSWERS, and why nothing answered it before: the published image ran 108 commits
  # behind origin/main and no artifact anywhere carried its build commit, so dating it needed an
  # MD5 fingerprint of the baked entrypoint against git history. deploy/Dockerfile REQ 15 now bakes
  # the sha twice - a LABEL for host-side readers and /etc/rmd-build-sha for readers INSIDE a
  # running container - and this compares the two.
  #
  # IT READS THE FILE, DELIBERATELY, NOT THE LABEL. The file is the carrier that answers the
  # question where it actually gets asked: inside a container, by something with no docker CLI and
  # no host access. A probe that read the label would certify a path nobody can use and would pass
  # happily on an image whose file was never written.
  #
  # STALENESS IS NOT A FAILURE HERE, AND THAT IS DELIBERATE. An old image is OLD, not WRONG, and
  # this repo has four measured cases of a bound firing on a healthy condition. So the sha is
  # REPORTED, never compared against origin/main: the failure being fixed was that nobody could
  # ASK, not that nobody compared. The one thing that IS failed is the two carriers disagreeing,
  # which is never a healthy state - it means one was written and the other was not.
  #
  # THREE STATES, same discipline as the version check above. An absent file or an absent label is
  # UNKNOWN and warns without failing, because the CURRENTLY PUBLISHED image has neither and a
  # check that failed on that would fire on a healthy condition the day it landed.
  got_sha="$(cat /etc/rmd-build-sha 2>/dev/null | head -1)"
  if [ -z "${got_sha:-}" ] || [ "${got_sha:-}" = "unknown" ]; then
    printf "  WARN  %-22s image carries no build sha (built before REQ 15, or with no --build-arg)\n" "image build sha"
  elif [ -z "${EXPECT_BUILD_SHA:-}" ]; then
    printf "  WARN  %-22s %s in the image, no label to compare against\n" "image build sha" "${got_sha}"
  elif [ "${got_sha}" = "${EXPECT_BUILD_SHA}" ]; then
    printf "  PASS  %-22s %s (label and /etc/rmd-build-sha agree)\n" "image build sha" "${got_sha}"
  else
    printf "  FAIL  %-22s /etc/rmd-build-sha says %s but the label says %s\n" "image build sha" "${got_sha}" "${EXPECT_BUILD_SHA}"
    fail=1
  fi
  # END image-build-sha
  check "node"      node --version
  check "gh"        gh --version
  check "git"       git --version
  # bwrap and socat are the Linux sandbox. validateWorkerSettings refuses to run a worker unless
  # sandbox.enabled AND sandbox.failIfUnavailable are both true, so a missing one of these does
  # not degrade the run - it refuses it, later and less legibly than a missing claude binary.
  # `bwrap --version` here only proves the BINARY is present; whether the kernel lets it create
  # namespaces depends on run-time flags this probe does not pass (see REQ 9 in the Dockerfile).
  check "bwrap"     bwrap --version
  check "socat"     socat -V
  # RMD_SELF_SYNC_DONE=1 is REQUIRED, not tidiness: checkCliFreshness runs `git merge --ff-only
  # origin/main` before the verb, so there are no read-only rmd verbs — `--help` would try to
  # fast-forward the checkout baked into this image, over the network, from a probe.
  check "rmd"       env RMD_SELF_SYNC_DONE=1 ./bin/rmd --help

  # THE BROWSER CHECK RESOLVES ITS PATH THE WAY THE CODE DOES, and that is the whole point of it.
  # This probe previously hardcoded /opt/pw-browsers — the path the image INSTALLED to — so it
  # reported PASS on an image whose browser suites could not run, because the code looks somewhere
  # else. Checking where the installer WROTE proves the installer ran; checking where the CONSUMER
  # READS proves the browsers are usable. Only the second is worth reporting.
  #
  # IT DELIBERATELY IGNORES PLAYWRIGHT_BROWSERS_PATH, and that is not an oversight. Honouring the
  # override would make this probe agree with the broken image: this shell HAS the image env, so it
  # would resolve to the relocated cache and report PASS, while a worker resolves somewhere else and
  # fails. The allowlist in src/lib/env.ts carries PATH, HOME, TMPDIR, LANG, USER and the Claude
  # token and nothing more, so a worker NEVER sees that variable. The only path worth asking about
  # is therefore the one a stripped environment computes: the linux default under HOME.
  #
  # INSTALLATION_COMPLETE is the marker because it is exactly what the isInstalled helper in
  # review.ts tests. A directory that exists is not an installed browser.
  worker_root="${HOME:-/root}/.cache/ms-playwright"
  installed=""
  for d in "$worker_root"/*/; do
    [ -f "${d}INSTALLATION_COMPLETE" ] && installed="$installed $(basename "$d")"
  done
  if [ -n "$installed" ]; then
    printf "  PASS  %-22s %s ->%s\n" "playwright browsers" "$worker_root" "$installed"
  else
    fail=1
    printf "  FAIL  %-22s no INSTALLATION_COMPLETE under %s\n" "playwright browsers" "$worker_root"
    printf "        %-22s  the five browser suites cannot pass, so preflight --ci-parity never goes\n" ""
    printf "        %-22s  green and test-with-retry reruns the suite until the turn budget dies\n" ""
    # Name the relocation explicitly when it is the cause: it is the difference between "install
    # the browsers" and "install them where the consumer looks", and those are not the same fix.
    relocated="${PLAYWRIGHT_BROWSERS_PATH:-}"
    case "$relocated" in ""|0) relocated="" ;; esac
    if [ -n "$relocated" ] && [ -d "$relocated" ] && [ -n "$(ls -A "$relocated" 2>/dev/null)" ]; then
      printf "        %-22s  BUT they ARE present at %s, reachable only via PLAYWRIGHT_BROWSERS_PATH,\n" "" "$relocated"
      printf "        %-22s  which the worker env strips. Relocate the install, do not repeat it.\n" ""
    fi
  fi

  # ── THE VERSION, NOT JUST THE PRESENCE (REQ 15) ────────────────────────────────────────────
  # THE CHECK ABOVE PASSES ON A BROKEN IMAGE, and that is why this one exists. It accepts ANY
  # directory carrying the marker, so an image holding `chromium_headless_shell-1194` while the
  # pinned Playwright wants `-1234` reports PASS — which is exactly what shipped: browsers present,
  # 51 suite failures, no worker ever reaching a green preflight. Presence and correctness are two
  # claims and the old check only ever tested the first.
  #
  # `/opt/pw-pin` is written by the REQ 15 build layer: the version it resolved from the lockfile,
  # and the directory names declared by the browsers.json shipped with that version.
  #
  # THE DISCRIMINATING ASSERTION IS THE VERSION COMPARISON, not the directory listing. Re-deriving
  # the wanted dirs from whatever is installed would agree with itself on any image; comparing the
  # version the BUILD used against the version the SHIPPED lockfile pins is the only step here that
  # can catch a browser layer built against a different Playwright than the repo declares.
  #
  # `node -p` with the paths passed through the ENVIRONMENT is deliberate: this whole probe is a
  # single-quoted -c argument, so a literal single quote cannot appear anywhere inside it, and
  # `require("...")` with an inline path would need one.
  PKGLOCK=/app/package-lock.json
  PWKEY=node_modules/playwright-core
  export PKGLOCK PWKEY
  pin_ver="$(cat /opt/pw-pin/version 2>/dev/null)" || pin_ver=""
  lock_ver="$(node -p "require(process.env.PKGLOCK).packages[process.env.PWKEY].version" 2>/dev/null)" || lock_ver=""
  if [ -z "$pin_ver" ]; then
    fail=1
    printf "  FAIL  %-22s /opt/pw-pin/version absent — image predates the REQ 15 pinned install\n" "playwright pin"
    printf "        %-22s  the browser build number is whatever the registry served at build time\n" ""
  elif [ -z "$lock_ver" ]; then
    fail=1
    printf "  FAIL  %-22s could not read playwright-core version from %s\n" "playwright pin" "$PKGLOCK"
  elif [ "$pin_ver" != "$lock_ver" ]; then
    fail=1
    printf "  FAIL  %-22s browsers built for playwright-core@%s, lockfile pins @%s\n" "playwright pin" "$pin_ver" "$lock_ver"
    printf "        %-22s  REBUILD. A stale browser layer is the 51-failure suite.\n" ""
  else
    # Only now is a directory listing worth anything: the version is right, so the names this
    # asserts are the names the suite will look for.
    missing=""
    while IFS= read -r want_dir; do
      [ -n "$want_dir" ] || continue
      [ -f "$worker_root/$want_dir/INSTALLATION_COMPLETE" ] || missing="$missing $want_dir"
    done < /opt/pw-pin/required-dirs
    if [ -n "$missing" ]; then
      fail=1
      printf "  FAIL  %-22s playwright-core@%s wants%s — not COMPLETE under %s\n" "playwright pin" "$pin_ver" "$missing" "$worker_root"
    else
      printf "  PASS  %-22s playwright-core@%s, builds match the lockfile\n" "playwright pin" "$pin_ver"
    fi
  fi

  # THE RUNTIME USER. `claude` refuses --permission-mode bypassPermissions as uid 0, and the
  # refusal is a bare exit 1 with stderr swallowed, so this is worth failing loudly and early.
  uid="$(id -u)"
  if [ "$uid" = "0" ]; then
    printf "  FAIL  %-22s (running as root — claude refuses bypassPermissions as uid 0)\n" "runtime user"
    fail=1
  else
    printf "  PASS  %-22s uid=%s %s\n" "runtime user" "$uid" "$(id -un 2>/dev/null)"
  fi

  # CACHE OWNERSHIP, AND THIS CHECK USED TO BE VACUOUS IN EXACTLY THE WAY THE BROWSER CHECK WAS.
  # It tested `[ -w "$c" ]` on the TOP DIRECTORY only. The image ships /home/node/.npm with a
  # node-owned top level and root-owned entries INSIDE it, because `chown -R node:node /home/node`
  # runs BEFORE the root `npm ci` that repopulates the cache. MEASURED on a reproduction of that
  # state: the old one-line test printed PASS, and a real install by the same uid then failed with
  # `npm error code EACCES / syscall mkdir / .../_cacache/index-v5/f2/8d`. A check that passes on
  # the broken image is worse than no check, so this one descends.
  #
  # TWO PROPERTIES ARE LOAD-BEARING AND BOTH ARE STATED RATHER THAN ASSUMED.
  #   RECURSIVE — `find ! -writable` reaches the entries the top-level test cannot see.
  #   RUN AS THE RUNTIME USER — uid 0 can write anything, so as root this check CANNOT fail and
  #   would certify the broken image. This probe inherits the image USER (node, uid 1000), which is
  #   what makes the result mean something; if that ever stops being true the check says so and
  #   reports nothing rather than reporting a pass it did not earn.
  if [ "$uid" = "0" ]; then
    printf "  NOTE  %-22s NOT CHECKED as uid 0 — root can write anything, so this cannot fail\n" "cache ownership"
    printf "        %-22s  re-run with --user 1000:1000 for a result that means something\n" ""
  else
    for c in "${HOME}/.npm" "${HOME}/.cache"; do
      if [ ! -e "$c" ]; then
        # For .npm this is the DESIRED state, not merely an acceptable one: the image ships no npm
        # cache at all, so the runtime user creates it as itself on the first bootstrap install.
        printf "  PASS  %-22s %s absent (nothing shipped, so nothing to own)\n" "cache ownership" "$c"
        continue
      fi
      blockers="$(find "$c" ! -writable 2>/dev/null)"
      n="$(printf "%s" "$blockers" | grep -c . || true)"
      if [ "$n" = "0" ]; then
        printf "  PASS  %-22s %s writable throughout by uid %s\n" "cache ownership" "$c" "$uid"
      else
        fail=1
        printf "  FAIL  %-22s %s has %s entries NOT writable by uid %s\n" "cache ownership" "$c" "$n" "$uid"
        printf "        %-22s  a bootstrap install will die on EACCES against them, and npm names\n" ""
        printf "        %-22s  the condition itself: your cache folder contains root-owned files\n" ""
        printf "%s\n" "$blockers" | head -3 | sed "s/^/          /"
      fi
    done
    # The npm cache is asserted ABSENT rather than merely writable. A writable one still works, but
    # it means a build layer put it back and the REQ 14 build assertion did not stop it, so it is
    # worth naming as a finding even when nothing is broken yet.
    if [ -e "${HOME}/.npm" ]; then
      printf "  NOTE  %-22s %s/.npm exists — the build asserts it should not (REQ 14)\n" "npm cache shipped" "$HOME"
    fi
  fi

  # THE BOOTSTRAP ENTRYPOINT. The image clones a real work tree at startup because the snapshot at
  # /app has no .git; if this file is missing or not executable the container falls back to running
  # the snapshot, which is the arrangement that made three separate diagnoses blame the wrong
  # checkout. Presence and the exec bit are what this probe can prove; whether the clone SUCCEEDS
  # needs a token and is the operator check below.
  if [ -x /usr/local/bin/rmd-entrypoint ]; then
    printf "  PASS  %-22s /usr/local/bin/rmd-entrypoint\n" "bootstrap entrypoint"
  else
    printf "  FAIL  %-22s (missing or not executable — the container would run the /app snapshot)\n" "bootstrap entrypoint"
    fail=1
  fi

  # THE SNAPSHOT IS EXPECTED TO HAVE NO .git, and saying so keeps the reason for the clone visible.
  # If this ever starts reporting a work tree, the upload path changed and the whole bootstrap may
  # be reconsiderable - that is a finding, not a failure, so it does not set the fail flag.
  if [ -e /app/.git ]; then
    printf "  NOTE  %-22s /app IS a work tree — the premise behind the startup clone has changed\n" "snapshot"
  else
    printf "  PASS  %-22s /app has no .git, as expected (hence the startup clone)\n" "snapshot"
  fi

  # W1-T2571: an unverifiable run must NEVER read as a verified one, so infra exits non-zero too.
  # The disposition is unchanged; only the diagnosis above distinguishes them.
  if [ "$infra" -ne 0 ]; then
    printf "  ----  %-22s the checks above marked INFRA could not run — this image is UNVERIFIED,\n" ""
    printf "        %-22s  not verified-and-broken. Fix the host fault and re-run before reading\n" ""
    printf "        %-22s  any verdict above as a statement about the image.\n" ""
    [ "$fail" -ne 0 ] || exit 2
  fi
  exit $fail
'
RC=$?
# W1-T2571: exit 2 from the checks probe means "could not run", not "ran and failed" — carried out
# here so the summary at the foot of this script can say UNVERIFIED rather than accusing the image.
# Any other non-zero stays an ordinary failure.
if [ "$RC" -eq 2 ]; then UNVERIFIED=1; RC=1; fi
set -e

# ── 6. THE ENTRYPOINT ITSELF, EXERCISED RATHER THAN INSPECTED ────────────────────────────────
# The probe above deliberately overrides the entrypoint, so it proves nothing about whether the
# entrypoint RUNS. This one goes through it for real, with the bootstrap skipped so no credentials
# are needed: it proves tini still starts, the script is reached, and `exec "$@"` hands off to the
# command. A broken entrypoint makes every invocation fail, so it is worth one extra container.
echo
echo "verify-image: entrypoint exec path (bootstrap skipped — no token needed)"
if out="$(docker run --rm -e RMD_SKIP_BOOTSTRAP=1 "${REF}" \
           sh -c 'echo entrypoint-reached' 2>&1)"; then
  if printf '%s' "$out" | grep -q 'entrypoint-reached'; then
    echo "  PASS  entrypoint runs and execs the command"
  else
    echo "  FAIL  entrypoint ran but the command did not execute:" >&2
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    RC=1
  fi
else
  echo "  FAIL  the entrypoint did not start:" >&2
  printf '%s\n' "$out" | sed 's/^/        /' >&2
  RC=1
fi

# ── 6b. A COMMIT ACTUALLY SUCCEEDS AS uid 1000 ───────────────────────────────────────────────
# ASSERTS THE OUTCOME, NOT THE CONFIG, and that distinction is the whole point of this check.
# `git config --get user.email` returning something proves nothing: an EMPTY value is a legal
# config entry and git still refuses the commit ("empty ident name not allowed"). The only
# question worth asking is whether a commit lands, so this makes one.
#
# THE DEFECT IT CATCHES, measured on the published image: no /home/node/.gitconfig exists at all,
# and a real container run died with "Author identity unknown" and "unable to auto-detect email
# address", the auto-detected value being node-at-container-id with no domain. A worker in that
# image writes files, tries to commit, and is refused — which is indistinguishable from a worker
# that did nothing.
#
# (Those two lines carried a backtick pair spanning a line break in the first draft, which made
# BOTH `sh -n` and `bash -n` fail on this file. Caught by running the linter, not by reading it —
# the same lesson section 7 records about its own two vacuous drafts.)
#
# THREE THINGS MAKE THIS NON-VACUOUS, each of which a lazier version would get wrong:
#   1. IT GOES THROUGH THE ENTRYPOINT (no `--entrypoint` override), because the entrypoint is what
#      writes the identity. The section-5 probe deliberately bypasses it and would correctly find
#      nothing. `RMD_SKIP_BOOTSTRAP=1` keeps it token-free and offline.
#   2. IT SETS NO `GIT_AUTHOR_*`/`GIT_COMMITTER_*` ENV. Section 7's probe does set them — correctly,
#      for its own purpose — and doing so here would supply the very identity under test and pass on
#      a broken image. This one must inherit whatever the image and entrypoint provide, and nothing
#      else.
#   3. IT RUNS AS uid 1000 EXPLICITLY. The image already declares `USER node`, but a check that
#      passed as root on a broken image is exactly how a previous defect shipped, so the runtime
#      user is pinned here rather than assumed.
echo
echo "verify-image: a commit succeeds as uid 1000 (through the entrypoint, no GIT_* env)"
set +e
out="$(docker run --rm -e RMD_SKIP_BOOTSTRAP=1 --user 1000:1000 "${REF}" sh -c '
  set -e
  d=$(mktemp -d)
  cd "$d"
  git init -q -b main .
  echo probe > f.txt
  git add f.txt
  git commit -qm "identity probe"
  git log -1 --format="COMMITTED-AS %an <%ae>"
' 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '^COMMITTED-AS .* <.*@.*>$'; then
  printf "  PASS  %-22s %s\n" "commit identity" "$(printf '%s' "$out" | grep '^COMMITTED-AS ' | sed 's/^COMMITTED-AS //')"
else
  RC=1
  printf "  FAIL  %-22s a commit could NOT be made as uid 1000\n" "commit identity"
  printf "        %-22s  every worker in this image writes files and commits NOTHING — the run ends\n" ""
  printf "        %-22s  with zero commits and reads as a silent no-op, not as a failure.\n" ""
  printf "        %-22s  Set RMD_GIT_AUTHOR_NAME/RMD_GIT_AUTHOR_EMAIL, or rebuild with an entrypoint\n" ""
  printf "        %-22s  that writes \$HOME/.gitconfig (deploy/entrypoint.sh).\n" ""
  printf '%s\n' "$out" | sed 's/^/        /' >&2
fi

# ── 7. THE BOOTSTRAP LANDS ON THE TIP — DRIVEN AGAINST A THROWAWAY ORIGIN, OFFLINE ───────────
# THE CHECK THAT WOULD HAVE CAUGHT THE 2026-08-08 STALE-CHECKOUT DEFECT. A boot reported
# "can be fast-forwarded" and then checked out the OLDER sha, so the next dispatch branched from
# stale code — and every later boot repeated it, pinning the container at its first-ever checkout
# while printing a clean line each time.
#
# TWO EARLIER DRAFTS OF THIS CHECK WERE VACUOUS, AND BOTH WERE CAUGHT BY RUNNING THEM AGAINST THE
# BROKEN ENTRYPOINT RATHER THAN BY READING THEM. Recorded because the same mistake has now been made
# three times in this file, and the lesson is the method, not the instance.
#   DRAFT 1 — boot twice against the REAL repository and assert HEAD equals the remote tip. The
#   defect only shows when the remote MOVES between two boots on one volume, and a verifier cannot
#   make craigoley/remudero gain a commit on cue. A check that can only fail on someone else's
#   timing is not a check.
#   DRAFT 2 — manufacture the origin locally so the remote definitely moves. MEASURED: this passes
#   on the BROKEN entrypoint. Its walk-back-then-merge does reach the tip whenever the merge
#   succeeds, which in a clean tree it does. Asserting the happy-path outcome cannot discriminate,
#   because both versions produce it.
#
# WHAT ACTUALLY DISCRIMINATES IS THE FAILURE THE OPERATOR HIT: an UNTRACKED file at a path an
# incoming commit also adds. The tracked-only dirty guard correctly calls that tree clean, git
# refuses to overwrite the file, and the old code — which silenced the only step that moved HEAD
# forward — left the container on a stale sha and reported a normal boot. Phase 3 below is that
# scenario, and it is the one assertion here that fails on the broken image. Phases 2 and 4 are
# honest regression guards for the happy path and the sha pin; they are NOT the discriminator and
# are not claimed to be.
#
# The origin is MANUFACTURED INSIDE THE CONTAINER, so this needs NO token, NO network and NO
# registry — everything happens on a throwaway path in a throwaway container, and it runs on every
# verification rather than only when credentials are around.
#
# The scratch repo commits a dummy `node_modules/.bin/tsx` so the entrypoint takes its
# "node_modules present" branch and skips the bootstrap install; this section is testing the
# CHECKOUT resolution, and an npm run would only add a network dependency it does not need.
echo
echo "verify-image: bootstrap currency (offline, against a throwaway origin — no token needed)"
set +e
out="$(docker run --rm --entrypoint /bin/sh "${REF}" -c '
  set -e
  export GIT_AUTHOR_NAME=v GIT_AUTHOR_EMAIL=v@v GIT_COMMITTER_NAME=v GIT_COMMITTER_EMAIL=v@v
  root=$(mktemp -d)
  origin="$root/origin"
  export HOME="$root/home"
  mkdir -p "$origin" "$HOME"
  git init -q -b main "$origin"
  cd "$origin"
  mkdir -p node_modules/.bin
  printf "#!/bin/sh\n" > node_modules/.bin/tsx
  chmod +x node_modules/.bin/tsx
  echo one > f.txt
  git add -A && git commit -qm c1
  # BOOT 1 — clones. Runs the real entrypoint, not a reimplementation of it.
  RMD_REPO_URL="$origin" RMD_REF=main /usr/local/bin/rmd-entrypoint true >/dev/null 2>&1
  # THE REMOTE MOVES. This is the step the real-repository version of this check cannot arrange.
  cd "$origin"
  echo two > f.txt
  git add -A && git commit -qm c2
  # BOOT 2 — must land on the NEW commit, not walk back to the frozen local branch.
  RMD_REPO_URL="$origin" RMD_REF=main /usr/local/bin/rmd-entrypoint true >/dev/null 2>&1
  tree="$HOME/Remudero/remudero"
  head=$(git -C "$tree" rev-parse HEAD)
  tip=$(git -C "$tree" rev-parse origin/main)
  if [ "$head" = "$tip" ]; then printf "CURRENT %s\n" "$head"; else printf "STALE head=%s tip=%s\n" "$head" "$tip"; fi

  # PHASE 3 — THE DISCRIMINATOR. An untracked file at a path the incoming commit also adds. A boot
  # here must either advance or REFUSE LOUDLY; what it must never do is stay on the old sha and
  # report success, because the next dispatch then branches from stale code.
  cd "$origin"
  echo upstream > collide.txt
  git add -A && git commit -qm c3
  echo local > "$tree/collide.txt"
  if RMD_REPO_URL="$origin" RMD_REF=main /usr/local/bin/rmd-entrypoint true >/dev/null 2>&1; then
    after=$(git -C "$tree" rev-parse HEAD)
    if [ "$after" = "$(git -C "$tree" rev-parse origin/main)" ]; then
      printf "COLLIDE-ADVANCED %s\n" "$after"
    else
      printf "COLLIDE-SILENT-STALE head=%s tip=%s\n" "$after" "$(git -C "$tree" rev-parse origin/main)"
    fi
  else
    printf "COLLIDE-REFUSED\n"
  fi
  rm -f "$tree/collide.txt"

  # PHASE 4 — A SHA REF MUST STILL PIN EXACTLY: the other half of what RMD_REF means, and the half
  # a fix that simply always took the tip would silently break.
  first=$(git -C "$tree" rev-parse "origin/main~1")
  RMD_REPO_URL="$origin" RMD_REF="$first" /usr/local/bin/rmd-entrypoint true >/dev/null 2>&1
  pinned=$(git -C "$tree" rev-parse HEAD)
  if [ "$pinned" = "$first" ]; then printf "PINNED %s\n" "$pinned"; else printf "UNPINNED got=%s want=%s\n" "$pinned" "$first"; fi
' 2>&1)"
BOOT_RC=$?
set -e
if [ "${BOOT_RC}" -ne 0 ]; then
  echo "  FAIL  the bootstrap-currency probe did not complete:" >&2
  printf '%s\n' "$out" | sed 's/^/        /' >&2
  RC=1
else
  if printf '%s' "$out" | grep -q '^CURRENT '; then
    echo "  PASS  a second boot lands on the moved remote tip, not the frozen local branch"
  else
    echo "  FAIL  the second boot did NOT land on the remote tip — a dispatch would branch from stale code:" >&2
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    RC=1
  fi
  # THE DISCRIMINATING ASSERTION. Advancing and refusing are both correct; only staying stale while
  # reporting success is a failure, and that is precisely what the broken entrypoint did.
  if printf '%s' "$out" | grep -qE '^COLLIDE-(ADVANCED|REFUSED)'; then
    echo "  PASS  an untracked-file collision either advances or refuses loudly — never silently stale"
  else
    echo "  FAIL  a boot stayed on the old sha and reported success — the next dispatch branches stale:" >&2
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    RC=1
  fi
  if printf '%s' "$out" | grep -q '^PINNED '; then
    echo "  PASS  a sha ref still pins exactly, so RMD_REF keeps both meanings"
  else
    echo "  FAIL  a sha ref did NOT pin exactly:" >&2
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    RC=1
  fi
fi

# ── PROCESS-INSPECTION BINARIES, EXECUTABLE AS UID 1000 ─────────────────────────────────────
#
# MEASURED ABSENT on the published image: ps, lsof, pgrep, pkill, top and free all MISS as uid 1000
# with the entrypoint bypassed, and `spawnSync ps` reports ENOENT. Nothing failed loudly — the
# sweeps that shell them catch and return an empty result, so an absent binary reads as "nothing to
# reap" and the sweep reports success.
#
# EXECUTED, NOT MERELY PRESENT. This file has been corrected five times for vacuous checks, so this
# one RUNS each binary as the runtime user rather than testing `-x` or `command -v`: a file can be
# on PATH and on disk and still be unrunnable for uid 1000. `--user 1000:1000` is the whole point —
# a root probe would pass on an image the runtime user cannot use.
#
# `pkill`, `top` and `free` are NOT asserted. They have zero callers in src/ and scripts/ (`pkill`
# appears only as a string in CLAUDE_CODE_TOOL_WRAPPERS, lib/isolation.ts), so requiring them would
# be asserting more than the fleet needs. They ride along with procps either way.
echo
echo "verify-image: process-inspection binaries run as uid 1000 (ps/pgrep for the sweeps, lsof for the reapers)"
set +e
out="$(docker run --rm --entrypoint /bin/sh --user 1000:1000 "${REF}" -c '
  fail=0
  # Each binary is INVOKED. Exit codes verified against Debian bookworm: `ps -eo pid=` is 0,
  # `pgrep --version` is 0, `lsof -v` is 0. A bare `pgrep <pattern>` would be 1 on no match, which
  # is why the version form is used for that one — a "no match" must not read as "missing".
  ps -eo pid= >/dev/null 2>&1     || { echo "MISS ps";     fail=1; }
  pgrep --version >/dev/null 2>&1 || { echo "MISS pgrep";  fail=1; }
  lsof -v >/dev/null 2>&1         || { echo "MISS lsof";   fail=1; }
  # jq is not process inspection; it is the ci-gate workflow script the three ci-gate suites
  # extract and RUN. Absent, they exit 127 and 14 tests fail — measured on this image.
  jq --version >/dev/null 2>&1    || { echo "MISS jq";     fail=1; }
  [ "$fail" -eq 0 ] && echo ALL_RUNNABLE
' 2>&1)"
set -e
if printf '%s\n' "${out}" | grep -q '^ALL_RUNNABLE$'; then
  echo "  OK    ps, pgrep, lsof and jq all executed as uid 1000"
else
  echo "  FAIL  a shelled binary is missing or unrunnable as uid 1000:" >&2
  printf '%s\n' "${out}" | sed 's/^/        /' >&2
  echo "        ps/pgrep/lsof fail SILENTLY: every sweep that shells one reports SUCCESS on an" >&2
  echo "        empty result, so this is what that looks like when it is not checked. jq fails" >&2
  echo "        LOUDLY instead - exit 127 in the ci-gate script the ci-gate suites run - which is" >&2
  echo "        why it cost 14 red tests rather than a silent no-op. Both belong in this probe." >&2
  RC=1
fi

echo
if [ "${RC}" -eq 0 ]; then
  echo "verify-image: OK — every check passed on ${AFTER}"
elif [ "${UNVERIFIED:-0}" -ne 0 ]; then
  # W1-T2571: the third state. Still non-zero, still refuses to certify — but it does NOT tell the
  # operator the image is broken, because nothing here established that. The 2026-09-01 run said
  # "every worker in this image writes files and commits NOTHING" when the true cause was a full
  # disk; that sentence is the one this branch exists to stop being printed.
  echo "verify-image: UNVERIFIED on ${AFTER} — one or more checks COULD NOT RUN (see INFRA above)" >&2
  echo "  This is a fault on the HOST running this script, not a finding about the image." >&2
  echo "  Nothing above should be read as a statement about the image until it is re-run clean." >&2
else
  echo "verify-image: FAILURES above, on ${AFTER}" >&2
  echo "  This digest was pulled during THIS run, so a stale image is not the explanation." >&2
fi
exit "${RC}"
