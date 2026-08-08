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

# ── REQ 8: THE SANDBOX BINARIES — bubblewrap AND socat ───────────────────────────────────────
# These are NOT optional hardening. `validateWorkerSettings` (src/lib/settings.ts) THROWS unless
# `sandbox.enabled === true` AND `sandbox.failIfUnavailable === true`, with the messages "workers
# are never unsandboxed" and "never silently run unsandboxed". `bwrapPath` and `socatPath` are keys
# of the SDK's own SandboxSettingsSchema, pinned in that same file — bubblewrap IS the Linux
# filesystem/process sandbox and socat IS its network side.
#
# So an image without these does not degrade, it REFUSES: `failIfUnavailable` is the whole point.
# That is the same shape as the missing `claude` binary — a total, clean failure — arriving one
# step later and reading as a containment problem rather than a packaging one.
#
# MEASURED: the first working run on the VM had to `apt-get install -y bubblewrap socat` at RUN
# time, inside the container, before it could start a task. Baking them makes that unnecessary,
# and removes a chain of consequences with it: the runtime apt fetch (which needs network and a
# working mirror at the worst possible moment), the `--user 0:0` that existed ONLY so apt could
# run, and the `su node` that starting as root then forced.
#
# That `su` is not free, and its cost is instructive. Preserving the credential across it needs
# `--preserve-environment`, which then keeps ROOT's `HOME` — so the command must also set HOME by
# hand or the worker looks in the wrong home for its config and credentials. Two coupled
# workarounds, both downstream of installing packages at run time.
#
# A CORRECTION TO A CLAIM MADE HERE FIRST: starting as `--user node` does NOT get the right HOME
# "from /etc/passwd for free". Docker does not consult /etc/passwd for a `--user` override at all.
# That is why REQ 10 sets HOME in the image — which is the actual fix, and makes the flag
# unnecessary rather than merely moving it.
#
# Verified in-layer for the same reason REQ 7 is: a missing sandbox binary should fail the build
# here, not a worker later.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap socat \
 && rm -rf /var/lib/apt/lists/* \
 && bwrap --version \
 && socat -V >/dev/null
# NOTE the `>/dev/null` above rather than `| head -1`: `A && B | C` parses as `A && (B | C)` and a
# pipeline's status is its LAST stage, so `socat -V | head -1` would return head's zero even with
# socat absent — the check would pass for a missing binary. Written that way first, caught here.

# ── REQ 10: HOME MUST BE SET IN THE IMAGE, OR THE STATE MOUNT IS SILENTLY IGNORED ────────────
# MEASURED, and this is the quietest failure in the file. `loadConfig` (src/lib/config.ts) derives
# `root` as `join(homedir(), "Remudero")`, and `configPath()` is `join(homedir(), ".config", ...)`.
# Node's `os.homedir()` returns `$HOME` when it is set and only falls back to the passwd entry when
# it is NOT. Docker does not derive HOME from /etc/passwd for a `--user` override — it uses the
# image's ENV or defaults to `/`. So with HOME unset here, a `--user 1000:1000` run gets `HOME=/`,
# `config.root` becomes `/Remudero`, and a `-v ...:/home/node/Remudero` mount IS NEVER TOUCHED:
# every ledger line, lock and token goes to a container-local path and disappears with `--rm`.
# Verified by evaluation: HOME=/ resolves homedir() to `/` and root to `/Remudero`.
#
# Nothing errors in that state. The run looks normal and the volume stays empty, which is why this
# is set here rather than left to a flag the caller must remember. Passing `-e HOME=/home/node`
# anyway is harmless and belt-and-braces; NOT passing it is now also correct.
ENV HOME=/home/node

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

# ── REQ 9: THE SANDBOX'S RUNTIME PERMISSIONS ARE NOT SET HERE EITHER ─────────────────────────
# Same category as REQ 5: these are `docker run` flags and an image cannot carry them. Recorded
# here because REQ 8 installs bubblewrap, and bubblewrap without them fails at run time in a way
# that reads as a containment defect rather than a missing flag.
#
# bwrap creates user and mount namespaces, which Docker's DEFAULT seccomp and AppArmor profiles
# restrict, and socat's network sandbox wants to configure interfaces. The invocation measured
# working on the VM passes:
#   --cap-add SYS_ADMIN --cap-add NET_ADMIN
#   --security-opt apparmor=unconfined --security-opt seccomp=unconfined
#
# TREAT THAT AS THE MEASURED-WORKING SET, NOT THE MINIMAL ONE. It was arrived at by getting a run
# to work, and no one has since removed one flag at a time to find which are actually load-bearing
# — so it is very likely wider than necessary, and TWO added capabilities, one of which is
# SYS_ADMIN, is a large grant to hand a container on the strength of "the run succeeded".
# Narrowing it is real work and wants its own measurement; until someone does that, this comment
# should not pretend the set is tight. NET_ADMIN was added to this list after a first draft
# recorded only SYS_ADMIN — the working command had moved on, which is exactly why the set is
# transcribed from a run rather than reasoned about.
#
# NOTE ALSO: this image sets no `USER`, so it runs as root by default. With REQ 8 baked in there
# is no longer any reason to start as root — nothing needs apt at run time — so prefer
# `--user node`, which drops the `su`, its `--preserve-environment`, and the manual
# `export HOME=/home/node` that `--preserve-environment` makes necessary (it keeps ROOT's HOME).
# Pass CLAUDE_CODE_OAUTH_TOKEN with `-e` and let the process inherit it; keep the surrounding
# `bash -c` single-quoted so the value is never interpolated into a command string.
#
# THE STATE MOUNT MUST THEN BE WRITABLE BY THAT UID. `-v ~/rmd-state:/home/node/Remudero` is the
# measured mount, and under `--user node` the host directory has to be owned by node's uid (1000
# in this base) rather than by root. UNVERIFIED — the `--user node` form has not been run.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./bin/rmd", "status"]
