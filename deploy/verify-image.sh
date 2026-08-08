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

  exit $fail
'
RC=$?
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

echo
if [ "${RC}" -eq 0 ]; then
  echo "verify-image: OK — every check passed on ${AFTER}"
else
  echo "verify-image: FAILURES above, on ${AFTER}" >&2
  echo "  This digest was pulled during THIS run, so a stale image is not the explanation." >&2
fi
exit "${RC}"
