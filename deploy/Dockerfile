# Remudero worker/daemon image — Linux (impl-EC).
#
# BUILT? NO. This file was authored and every step in it was executed individually on a Linux
# host, but the image itself was NOT built: the docker CLI is present and the daemon socket is
# absent (`dial unix /var/run/docker.sock: connect: no such file or directory`), with no
# podman/buildah/nerdctl fallback available. Each RUN below is annotated with the evidence from
# running it by hand. Treat the layer ordering as unverified; treat the CONTENTS as measured.
#
# FIVE REQUIREMENTS, each established rather than assumed — see the report in
# state/recon-container-build.md for the execution evidence behind each one.

FROM node:22-bookworm-slim

# ── REQ 1: AN INIT THAT REAPS ────────────────────────────────────────────────────────────────
# `spawnDetachedGroup` (src/lib/worker-containment.ts) spawns with `detached: true`, so every
# worker is its own process group. PID 1 does not reap by default, so without an init each run
# leaks zombies. tini is the smallest thing that fixes it; `docker run --init` is equivalent and
# is the fallback if this layer is dropped.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

# ── REQ 2: gh MUST BE PRESENT ────────────────────────────────────────────────────────────────
# MEASURED: without gh, `rmd review` dies at `Error: spawnSync gh ENOENT` and is the only verb
# that fails outright. With gh present the same command reaches criteria parsing and the browser
# preflight — a completely different, much later failure. 49 MB unpacked, 48 MB binary.
# Installed from the release tarball rather than the apt repo: the apt keyring fetch returned an
# empty file through this environment's proxy, and the tarball is one hop with no repo state.
ARG GH_VERSION=2.63.2
RUN curl -sSL -o /tmp/gh.tgz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && tar xzf /tmp/gh.tgz -C /tmp \
 && install -m755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64" \
 && gh --version

# ── REQ 3: NO `security`, NO `launchctl` ─────────────────────────────────────────────────────
# Nothing installed here provides either, deliberately. VERIFIED FROM SOURCE: `ensureWorkerKeychain`
# has exactly two call sites and BOTH are darwin-gated — `process.platform === "darwin"` in
# run-task.ts and `if (platform === "darwin")` in src/lib/worker.ts — and `security` is shelled
# only inside src/lib/worker-home.ts, reachable only through that gate. `launchctl` is shelled in
# run-task.ts's launchd verbs and in src/lib/deployer.ts; neither is on the daemon's boot path.
# If a Linux boot ever reaches either binary, it should fail loudly rather than find a stub.

# ── REQ 6 (NOT IN THE BRIEF — FOUND BY RUNNING `rmd review`) ─────────────────────────────────
# `rmd review` runs a browser preflight that installs the PINNED Playwright browsers, and in a
# network-restricted environment that install fails: `Download failed: server returned code 403
# body 'request rejected: host not permitted'. URL: https://cdn.playwright.dev`. The image must
# therefore bake the browsers at BUILD time (when the CDN is reachable) or the review verb
# degrades — its own message says "browser proofs may report exec_error". Kept as a separate,
# clearly-labelled layer so it can be dropped if review is not run in-container.
#
# NOW ENABLED, because the reason it was commented out does not apply to the build path this
# image is actually built on. `az acr build` (.github/workflows/acr-build.yml) runs the build as
# an ACR Task on Azure's fleet, where cdn.playwright.dev is reachable; the 403 recorded above was
# this repo's agent container refusing the host, not a property of the Dockerfile. If a future
# build environment cannot reach the CDN, comment this line again rather than letting the layer
# fail — `rmd review` degrades but everything else works.
#
# WHY NOT `mcr.microsoft.com/playwright:v1.62.1-noble`, which bakes the browsers into the base and
# is what craigoley/synthwatch's runner/Dockerfile does. Two facts, both measured, and they point
# opposite ways:
#   FOR — the tag EXISTS and matches exactly. This repo's package-lock resolves `playwright` and
#   `playwright-core` to 1.62.1, and `v1.62.1-noble` is published on MCR (confirmed against
#   mcr.microsoft.com/v2/playwright/tags/list). SynthWatch's own comment insists the base tag match
#   the npm dependency exactly, and here it would.
#   AGAINST — the node version inside that image is UNMEASURED, and package.json requires
#   `node >= 22.22.3`. Swapping the base trades a reachable-CDN assumption for an unverified
#   runtime-version assumption, and only one of those fails loudly at build time.
# So the base stays `node:22-bookworm-slim` and the browsers are installed. Revisit if the install
# layer proves slow or flaky — the alternative is real and is one line.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx --yes playwright install --with-deps chromium

WORKDIR /app
COPY package.json package-lock.json ./

# ── REQ 4: node_modules PER CONTAINER, NEVER SHARED ──────────────────────────────────────────
# The shared-symlink arrangement is what let one install empty node_modules under a running daemon
# TWICE in one week. Baking it into the image layer makes it per-container by construction — there
# is nothing to share. run-task.ts already stores its install hash INSIDE node_modules and notes it
# is "naturally invalidated if node_modules is ever wiped wholesale", so the code already treats
# this directory as disposable. Do NOT mount a volume over /app/node_modules.
RUN npm ci --omit=dev || npm ci

COPY . .

# ── REQ 5: THE RESTART POLICY IS NOT SET HERE ────────────────────────────────────────────────
# It cannot be: `--restart` is a run-time flag, and the daemon and serve need DIFFERENT policies.
#   daemon → `--restart=on-failure`   (launchd `KeepAlive={SuccessfulExit:false}`)
#   serve  → `--restart=unless-stopped` (launchd `KeepAlive=<true/>`, unconditional)
# Using `always`/`unless-stopped` for the DAEMON would turn a deliberate clean stop into a crash
# loop, because exit(0) is how the daemon is stopped on purpose. See the report for why systemd is
# the faithful counterpart and docker's `--restart` is not: `ThrottleInterval` (60s, from
# plan/policy.yaml `launchd.throttleIntervalS`) has an exact systemd analogue in `RestartSec=` and
# no exact docker one.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./bin/rmd", "status"]
