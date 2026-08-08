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
echo
echo "verify-image: checks inside ${AFTER}"
set +e
docker run --rm --entrypoint /bin/sh "${REF}" -c '
  fail=0
  # `if out="$(cmd)"` tests CMD, which piping into head would not: a pipeline reports the LAST
  # stage, so `cmd | head` returns head status and a missing binary would read as a pass. The
  # first line is taken afterwards, from the captured text, never from a pipe in the test.
  check() {
    label="$1"; shift
    if out="$("$@" 2>&1)"; then
      printf "  PASS  %-22s %s\n" "$label" "$(printf "%s" "$out" | head -1)"
    else
      printf "  FAIL  %-22s (%s)\n" "$label" "$(printf "%s" "$out" | head -1)"
      fail=1
    fi
  }
  check "claude"    claude --version
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

  # THE RUNTIME USER. `claude` refuses --permission-mode bypassPermissions as uid 0, and the
  # refusal is a bare exit 1 with stderr swallowed, so this is worth failing loudly and early.
  uid="$(id -u)"
  if [ "$uid" = "0" ]; then
    printf "  FAIL  %-22s (running as root — claude refuses bypassPermissions as uid 0)\n" "runtime user"
    fail=1
  else
    printf "  PASS  %-22s uid=%s %s\n" "runtime user" "$uid" "$(id -un 2>/dev/null)"
  fi

  # CACHE OWNERSHIP. Root-owned caches under HOME are what made a non-root `npm ci` die on EACCES.
  # Writability is the property that actually matters, so test that rather than parsing an owner.
  for c in "${HOME}/.npm" "${HOME}/.cache"; do
    if [ ! -e "$c" ]; then
      printf "  PASS  %-22s %s absent (nothing to own)\n" "cache writable" "$c"
    elif [ -w "$c" ]; then
      printf "  PASS  %-22s %s\n" "cache writable" "$c"
    else
      printf "  FAIL  %-22s (%s not writable by uid %s — a non-root npm ci will EACCES)\n" "cache writable" "$c" "$uid"
      fail=1
    fi
  done

  exit $fail
'
RC=$?
set -e

echo
if [ "${RC}" -eq 0 ]; then
  echo "verify-image: OK — every check passed on ${AFTER}"
else
  echo "verify-image: FAILURES above, on ${AFTER}" >&2
  echo "  This digest was pulled during THIS run, so a stale image is not the explanation." >&2
fi
exit "${RC}"
