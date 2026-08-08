# Remudero worker/daemon image — Linux (impl-EC).
#
# BUILT? YES, NOW — this header used to read "BUILT? NO" and that is no longer true. The image is
# built by `.github/workflows/acr-build.yml` as an ACR Task on Azure's build fleet (no local docker
# daemon anywhere, which is why it works from environments that have none), and the result has been
# pulled and run on an Azure VM. `./bin/rmd --help` renders there. So layer ordering is no longer
# unverified — it builds — and the CONTENTS remain measured, step by step, as annotated below.
#
# What that first real run also established is REQ 7: the image had no `claude` binary, so no worker
# could spawn. That is fixed below. UNVERIFIED until the next build runs and someone execs
# `claude --version` in the result.
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
#   AGAINST — the node version is NO LONGER UNMEASURED, and the measurement settles it against the
#   swap. That image's own config blob (read from MCR's registry API, amd64 manifest) carries
#   `ARG NODE_VERSION=24`. Node 24 satisfies `node >= 22.22.3` numerically, so the engines range was
#   never the real objection — but it is a MAJOR version jump from the node 22 this repo builds and
#   tests on, and nothing here has been run against it. It also ships
#   `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, contradicting the path set below.
# DECIDED: DO NOT SWAP, and the deciding fact is not the node version at all — the install layer
# below ALREADY WORKS. It was enabled before the first build and that build succeeded on the ACR
# fleet, so the browsers are in the image today. Swapping the base would trade a working, measured
# arrangement for an unmeasured node major bump and a browser-path mismatch, buying nothing. The
# alternative stays recorded because it is real; it is not currently worth taking.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx --yes playwright install --with-deps chromium

# ── REQ 7: THE CLAUDE CODE CLI — WITHOUT IT NO WORKER CAN SPAWN ──────────────────────────────
# MEASURED on the first real image built from this file and run on an Azure VM: `./bin/rmd --help`
# renders, so the image is otherwise sound — but `claude` is not on PATH. `resolveClaudeExecutable`
# (src/lib/worker.ts) searches, in order, an env override, a live `which claude`, then
# `~/.npm-global/bin/claude` and `~/.local/bin/claude` (its CLAUDE_EXECUTABLE_LOCATIONS table). With
# none of them present it throws `ClaudeToolchainBlockedError`, classed as infrastructure rather than
# a task defect. That is a clean refusal and a total one: every worker spawn fails before it starts.
#
# BAKED, NOT MOUNTED. Mounting a host install is what the Mac mini effectively does, and it is the
# same shape as the shared `node_modules` symlink that was emptied under a running daemon twice in
# one week (REQ 4). A container that depends on a binary it does not contain is not self-sufficient,
# and a mount reintroduces precisely the shared-mutable-tree failure this image exists to leave
# behind.
#
# PINNED, and to THIS version for two independent reasons that agree:
#   1. `@anthropic-ai/claude-code` publishes a `stable` dist-tag distinct from `latest`, and this is
#      what it resolves to.
#   2. The CLI and `@anthropic-ai/claude-agent-sdk` ship in LOCKSTEP — 2.1.N alongside 0.3.N for
#      every recent N. package-lock.json resolves the SDK to 0.3.220, so 2.1.220 is the CLI half of
#      the pair this repo already depends on.
# An unpinned `@latest` would let the image change under us between builds — the same class of
# failure as an auto-updater rewriting a binary mid-run, which src/lib/env.ts's DISABLE_AUTOUPDATER
# grant records having been observed on this fleet.
#
# DISABLE_AUTOUPDATER=1 IS SET IMAGE-WIDE, deliberately wider than the runtime's own grant.
# `buildWorkerEnv` (src/lib/env.ts) adds it to every WORKER child, but a `claude` invoked any other
# way in this container — an operator exec, a manual preflight — is not a worker child and would be
# free to rewrite the pinned binary underneath the running fleet. In an image the pin IS the version
# policy: updating means rebuilding, which is the whole point of baking it.
#
# This does not invent a new mechanism; it makes an existing one quiet. `checkBinaryPin`
# (src/lib/env.ts, W1-T236) already compares the version recorded at config time against the version
# observed at preflight, and LEDGERS drift rather than failing, so a deliberate operator update stays
# possible. In a container with a pinned install and no autoupdater those two readings should be
# identical for the life of the image — so a drift report from inside this image is a real signal
# that something rewrote the binary, not the routine occurrence it is on the shared-install host.
#
# The `claude --version` below is not decoration. It is the build-time PROOF that npm's global bin
# directory is on PATH in this base. If it is not, the build fails HERE — loudly, on the build fleet
# — rather than shipping an image whose only symptom is that no worker can ever spawn.
ARG CLAUDE_CODE_VERSION=2.1.220
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version

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
