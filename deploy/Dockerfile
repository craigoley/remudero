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

# W1-T2770: PINNED TO THE EXACT `.nvmrc` VERSION, NOT THE FLOATING `node:22-bookworm-slim` TAG.
# `scripts/coverage-merge-ratchet.mjs` reaches into `internal/test_runner/coverage` (Node's own
# built-in test coverage internals, `--expose-internals`), and its `assertPinnedNodeVersion`
# throws on ANY string mismatch against `.nvmrc` — so a base tag that resolved to `node:22.23.2`
# turned `test/merge-lcov.test.ts`'s six coverage-merge-CLI tests red with no code change on
# either side (MEASURED against `# tests 13224 # pass 13217 # fail 6`, W1-T2769's gate run).
# The tag arrived through an unrelated rebuild, silently — the floating `22` slot moved and no
# file in this repo did — which is the whole reason this pin exists.
#
# WHY NOT A DIGEST. A digest is stronger (it pins every apt-layer patch too) but this repo has
# no digest-renewal process today; an unrenewed digest quietly rots the base's security-patch
# surface, trading a loud version mismatch for a quiet unpatched-base failure. The exact version
# tag still floats within patch-level rebuilds of `node:22.22.3-bookworm-slim`, which is the
# residual risk — smaller than a digest's unmaintained-freeze risk, and made loud by W1-T2770's
# `ci-parity.ts` cluster whenever it happens (the `appliesTo` fires on any drift from
# `.nvmrc`, not only the specific 22.22.3 -> 22.23.2 direction that caused today's outage).
#
# UPDATING THE PIN. Bump both this tag AND `.nvmrc` in the same commit; the cluster's
# self-expiry then re-arms itself around the new pin the moment the image lands.
FROM node:22.22.3-bookworm-slim

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
#   tests on, and nothing here has been run against it.
# DECIDED: DO NOT SWAP. The full argument now lives with the browser layer below, because the
# decisive fact turned out to be about PATHS rather than versions — that base RELOCATES the browser
# cache behind an environment variable, which is precisely the defect being fixed there.
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

# ── REQ 14: SHIP NO npm CACHE AT ALL — AND WHY REQ 10 ABOVE IS THE CAUSE ─────────────────────
# MEASURED ON THE PUBLISHED IMAGE (digest 255b65bd, built from #1482 + #1483): `/home/node/.npm`
# ships PARTIALLY root-owned — the directory itself is node-owned, entries inside it are not — and
# the entrypoint bootstrap install then dies on EACCES as the runtime user.
#
# THE CAUSE IS THE LINE DIRECTLY ABOVE, WHICH IS WORTH SAYING PLAINLY. `ENV HOME=/home/node` is set
# for the WHOLE BUILD, and every layer up to `USER node` runs as ROOT. npm resolves its cache to
# `$HOME/.npm`, so from here down root does not write into ROOT's home — it writes into the RUNTIME
# USER's home. REQ 10 is still correct and stays where it is (it must precede the browser layer, or
# the browsers land somewhere the worker cannot reach), but it hands root a home that is not its
# own, and this requirement is the other half of that trade.
#
# WHICH LAYER RECREATES IT, established from the layer order rather than assumed. Three layers
# below run npm or npx as root: the browser install, the global `claude` install, and `npm ci` at
# /app. The first two are REPAIRED by `RUN chown -R node:node /home/node` (REQ 11) — but `npm ci`
# runs AFTER that chown, so it is the one that recreates root-owned entries inside a directory the
# chown has already made node-owned. That is exactly the "partially" in the symptom: a node-owned
# top level with root-owned content-addressed entries under `_cacache`.
#
# REPRODUCED OUTSIDE DOCKER, since no agent container has a docker daemon. A cache populated by uid
# 1000 and then written to by root reports `distinct owners: root ubuntu`, top dir `ubuntu`, and
# 170 root-owned entries inside; a subsequent uid-1000 install fails with
# `npm error code EACCES / syscall mkdir / path .../_cacache/index-v5/f2/8d`, and npm even names the
# condition itself: "Your cache folder contains root-owned files".
#
# THE FIX IS TO SHIP NO CACHE, NOT TO RE-CHOWN ONE. A chown after `npm ci` would fix the ownership
# and still leave the artefact, and an artefact that only has to be owned correctly is one a future
# layer can silently break again. An npm cache in an image is dead weight in any case: it is a
# download accelerator for installs that already happened. So every root npm/npx layer below points
# its cache at a throwaway path and deletes it IN THE SAME RUN, which means `/home/node/.npm` is
# never created in any layer and there is no ownership question to get wrong. The runtime user then
# creates it fresh, as itself, on the first bootstrap install.
#
# MEASURED that this actually redirects everything, for both verbs, with HOME left completely empty
# afterwards: `npm_config_cache=<dir> npm install` and `npm_config_cache=<dir> npx --yes <pkg>` put
# `_cacache`, `_logs`, `_update-notifier-last-checked` and (for npx) `_npx` under <dir>, and `find`
# over HOME returns HOME alone.
#
# WHY NOT SIMPLY RUN `npm ci` AS `node`, which was the other candidate fix. It would need /app made
# node-owned first, and it fixes only the ownership of a cache it would still SHIP — the other two
# root layers write one regardless, and being node-owned does not make hundreds of megabytes of
# download cache worth carrying. One mechanism applied to all three layers is smaller than two
# mechanisms applied to one each, and it removes the artefact instead of relabelling it.
#
# THE BUILD ASSERTS THIS RATHER THAN TRUSTING IT — see the check at the end of the `npm ci` layer.
# Same discipline as `claude --version` and `bwrap --version`: a future layer that reintroduces the
# cache fails the build on the build fleet, loudly, instead of shipping an image whose only symptom
# is that the bootstrap install cannot run.

# ── THE BROWSERS WERE INSTALLED AND STILL UNREACHABLE. THE PATH WAS THE BUG. ─────────────────
# MEASURED on the published image: `ls ~/.cache/ms-playwright` is EMPTY, and five browser suites
# fail, so `rmd preflight --ci-parity` never goes green. One self-hosting run spent over 90 minutes
# cycling preflight (test-with-retry reruns the whole suite) and leaked a stranded `rmd serve` per
# attempt.
#
# THE OBSERVATION IS RIGHT AND THE OBVIOUS CONCLUSION IS WRONG. The browsers ARE in the image — the
# ACR build log shows Chromium, the headless shell and FFmpeg downloading into `/opt/pw-browsers`.
# They were unreachable because reaching them required an environment variable that the fleet
# deliberately destroys: `ALLOWLIST` (src/lib/env.ts) is PATH, HOME, TMPDIR, LANG, USER and the
# Claude token — and NOTHING ELSE survives into a spawned worker. `PLAYWRIGHT_BROWSERS_PATH` is not
# on it, so inside a worker `playwrightCacheRoot` (src/lib/review.ts) falls through its override
# branch to the platform default, `$HOME/.cache/ms-playwright` — the very path measured empty.
# Re-running the installer would have changed nothing; it would have refilled a directory nobody
# was looking in.
#
# SO THE FIX IS TO INSTALL WHERE THE DEFAULT ALREADY POINTS, and to set no variable at all. HOME is
# set ABOVE this layer for exactly that reason, so the install lands in `/home/node/.cache/
# ms-playwright`, which is what `playwrightCacheRoot` computes with an empty environment. Nothing
# then has to be propagated, which is the only arrangement the allowlist cannot break.
#
# AND THIS RETIRES THE BASE-IMAGE SWAP ON ITS OWN MERITS. `mcr.microsoft.com/playwright:v1.62.1-noble`
# sets `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` (read from its config blob), so it would reproduce
# this exact defect at a different path — a relocated cache reachable only through a stripped
# variable. It also carries `ARG NODE_VERSION=24`, a major bump from the node 22 this repo tests
# on. The swap fixes nothing here and costs a runtime change; declined on both counts.
#
# THE INSTALL ITSELF MOVED, AND THE REASON IS A SECOND, DIFFERENT DEFECT — see REQ 15 below the
# `COPY package.json package-lock.json` line. In short: this layer ran a BARE `npx --yes playwright`,
# which resolves whatever version the registry currently serves, NOT the one this repo pins. It
# cannot do better from here, because at this point in the file there is no `/app` and no lockfile
# to pin against. Installing browsers is now downstream of the lockfile COPY for exactly that
# reason; nothing is installed at this layer.

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
#
# `npm_config_cache` + `rm -rf` in the same RUN is REQ 14. This layer is the one the earlier note in
# REQ 11 blamed for the shipped root-owned cache; it does create one, but the chown below repairs it,
# so it was never the layer that survived to the image. It is fixed here anyway — the throwaway cache
# also stops the chown having to rewrite the whole tree into a second layer.
RUN npm_config_cache=/tmp/npm-build-cache \
      npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && rm -rf /tmp/npm-build-cache \
 && claude --version

# ── THE CODEX CLI — OPT-IN SECOND SUBSCRIPTION, BAKED BUT DORMANT BY DEFAULT ─────────────────
# `workerProviders.enabled` defaults to [`claude`], so installing this binary cannot reroute a
# single existing worker. A host opts in only after mounting an authenticated CODEX_HOME and adding
# `codex` to that list. Pinning makes the image reproducible; the app-server capacity contract and
# exec JSONL adapter are verified against this exact release in src/lib/worker-provider.ts tests.
ARG CODEX_VERSION=0.152.0
RUN npm_config_cache=/tmp/npm-build-cache \
      npm install -g "@openai/codex@${CODEX_VERSION}" \
 && rm -rf /tmp/npm-build-cache \
 && codex --version

# Codex's workspace-write sandbox deliberately permits reads outside the checkout. The daemon
# mounts both subscriptions plus operator state into this container, so the model-driven shell
# needs a second, administrator-owned read boundary. Codex 0.152.0 reads this system requirements
# path before every run; root ownership and mode 0444 keep uid 1000 from weakening the policy.
RUN install -d -m 755 /etc/codex
COPY --chown=root:root deploy/codex-requirements.toml /etc/codex/requirements.toml
RUN chmod 0444 /etc/codex/requirements.toml \
 && test "$(stat -c '%u:%g:%a' /etc/codex/requirements.toml)" = "0:0:444" \
 && grep -F '"/home/node/.codex/auth.json"' /etc/codex/requirements.toml >/dev/null \
 && grep -F '"/home/node/Remudero/state"' /etc/codex/requirements.toml >/dev/null

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
      bubblewrap socat procps lsof jq \
 && rm -rf /var/lib/apt/lists/* \
 && bwrap --version \
 && socat -V >/dev/null \
 && ps -eo pid= >/dev/null \
 && pgrep --version >/dev/null \
 && lsof -v >/dev/null 2>&1 \
 && jq --version >/dev/null
# NOTE the `>/dev/null` above rather than `| head -1`: `A && B | C` parses as `A && (B | C)` and a
# pipeline's status is its LAST stage, so `socat -V | head -1` would return head's zero even with
# socat absent — the check would pass for a missing binary. Written that way first, caught here.
#
# PROCESS INSPECTION (procps, lsof) — MEASURED ABSENT FROM THE PUBLISHED IMAGE as uid 1000 with the
# entrypoint bypassed: `ps`, `lsof`, `pgrep`, `pkill`, `top` and `free` all MISS, and a direct
# `spawnSync ps` reports ENOENT. `kill` and `df` are shell builtins/coreutils and were already fine.
#
# WHY IT MATTERS: the sweeps that shell these binaries do not fail — they report SUCCESS on an empty
# result, which is this repo's recurring "zero is overloaded" shape. `defaultListCandidates`
# (lib/worker-containment.ts) catches and returns [], so `sweepOrphanWorkers` finds no candidates,
# kills nothing, and reports a clean sweep. `listProcessGroupMembers` catches and returns [], so a
# group kill reports zero survivors. `probeIdle` (lib/deployer.ts) catches and sets `workers = 0`,
# so the fleet reads as IDLE. `defaultGetProcessStartTime` (lib/fs-race-safe.ts) catches and returns
# null, which SILENTLY DISABLES `isHolderStale`'s third rung — the start-time comparison that is the
# only defence against a container PID namespace recycling a low pid. That last one is the subtle
# case: the syscall-based `isPidAlive` keeps working, so liveness LOOKS healthy while its corrective
# rung is gone.
#
# NOT EVERY CALLER IS BROKEN THE SAME WAY, and the difference is worth keeping: `defaultOpenFileCount`
# (lib/clone-reaper.ts) FAILS CLOSED by design — with `lsof` absent it returns 1 ("something holds
# it"), so the clone reaper reclaims nothing rather than deleting something live. Safe, still a
# no-op sweep.
#
# `jq` IS THE SAME CLASS ONE BINARY OVER, and its failure mode is louder rather than silent — which
# is the only reason it went 14 tests before anyone looked. MEASURED on this image at `3a5c677`, a
# full `test/**/*.test.ts` glob gave 16 failures, and 14 of them are `jq: command not found` with
# exit 127. THE TESTS ARE NOT AT FAULT AND MUST NOT BE REWRITTEN: `test/ci-gate-dedupe.test.ts`,
# `test/ci-gate-reaggregate.test.ts` and `test/ci-gate-transport-retry.test.ts` extract the REAL
# bash+jq script out of `.github/workflows/ci-gate.yml` and run it — "never re-typed here", as all
# three say — so the dependency belongs to the WORKFLOW, which legitimately uses jq because it runs
# on `ubuntu-latest`. Rewriting those seven jq calls to `node -e` would change a product artifact to
# suit a host, and would break the property that makes the suite worth having.
#
# THIS IS NOT IN TENSION WITH `deploy/host-update.sh`, WHICH DELIBERATELY AVOIDS jq. That script's
# comment scopes its own reason precisely — it "is documented to run on a host with no node, no rmd
# and no checkout, and jq is not present on the measured host either". That is the OPERATOR'S BARE
# HOST, a deliberately minimal environment this image is not. The repo's position is "the bootstrap
# script assumes nothing", not "jq is unwelcome"; `.github/workflows/ci-gate.yml` shells it seven
# times.
#
# Cost is 1152 KB installed (399 KB to fetch) for `jq` plus its `libjq1`/`libonig5` dependencies.
#
# WHAT IS INSTALLED AND WHY: `procps` for `ps` (four call sites) and `pgrep` (one); `lsof` for three.
# `pkill`, `top` and `free` have ZERO callers — `pkill` appears only as a string in
# `CLAUDE_CODE_TOOL_WRAPPERS` (lib/isolation.ts), not a call — and are installed only because procps
# bundles them. Cost is 1800 KB + 475 KB installed (707 KB + 247 KB to fetch) on a 4+ GB image.
#
# VERIFIED IN-LAYER by RUNNING each binary, not by `command -v`: presence on disk is not
# executability, and this file has been corrected before for exactly that class of check.


# ── REQ 11: HAND /home/node TO THE RUNTIME USER, AND RUN AS THAT USER ────────────────────────
# TWO MEASURED DEFECTS, ONE CAUSE: every layer above runs as root, and root writing under HOME
# leaves root-owned caches behind.
#
#   `/home/node/.npm` IS ROOT-OWNED — the global `claude` install (REQ 7) populated npm's cache as
#   root, so a later non-root `npm ci` inside the container dies on EACCES against it. Observed.
#   THAT ATTRIBUTION IS WRONG AND THE SYMPTOM OUTLIVED THIS FIX. The chown below does repair what
#   REQ 7 wrote; what it cannot repair is the `npm ci` layer that runs AFTER it, which is why the
#   image built from this change still shipped a PARTIALLY root-owned cache — node-owned at the top,
#   root-owned inside. Corrected in place rather than deleted, because the shape of the mistake is
#   the useful part: a `chown -R` is only as good as its position, and naming the wrong layer made
#   the defect look fixed. REQ 14 removes the artefact instead of re-owning it.
#
#   THE IMAGE DEFAULTS TO ROOT, and `claude` REFUSES `--permission-mode bypassPermissions` when it
#   is uid 0. That refusal is a bare exit 1 with stderr swallowed, which cost an hour to diagnose
#   and is why every run so far has had to pass `--user 1000:1000` by hand. An image whose only
#   correct invocation requires a flag nobody is told about is not a runnable image.
#
# The chown also covers `/home/node/.cache/ms-playwright`, written by root in the browser layer.
# That is now its ONLY remaining job: with REQ 14 in force no layer writes `/home/node/.npm` at all,
# so this line no longer has a cache to re-own and no longer duplicates one into a fresh layer.
# It must still come AFTER the last root-writing layer or it fixes a directory that is about to be
# rewritten — and with the cache gone, the browser install is the last such layer.
#
# `USER node` then makes the correct invocation the DEFAULT rather than a flag. `--user 1000:1000`
# stays valid and identical — the node user in this base is uid 1000 — so nothing that works today
# stops working; it simply stops being mandatory. Root is still reachable with `--user 0:0` for the
# rare case that wants it.
RUN chown -R node:node /home/node

WORKDIR /app
# `--chown` rather than a later `chown -R /app`: the recursive form would duplicate the whole tree
# into a second layer. This costs nothing and leaves the COPIED FILES owned by the runtime user.
#
# IT DOES NOT MAKE AN IN-CONTAINER `npm ci` AT /app POSSIBLE, which this comment used to claim.
# `--chown` only touches what the COPY writes: `/app` itself is created by `WORKDIR` as root, and
# `/app/node_modules` is written by the root `npm ci` below, so both ship root-owned and a runtime
# user cannot install into them. REPORTED, NOT FIXED HERE — nothing runs an install at /app. The
# entrypoint installs into the CLONE under `$HOME/Remudero/remudero`, which the runtime user does
# own, and REQ 4 is explicit that the two trees must not share a `node_modules`. Correcting the
# claim rather than acting on it, because acting on it would widen this change to a second concern.
COPY --chown=node:node package.json package-lock.json ./

# ── REQ 15: THE BROWSER BUILD NUMBER MUST FOLLOW THE LOCKFILE, NOT THE BUILD DATE ────────────
# MEASURED in a container: a full-glob run produced 51 FAILURES, ALL ONE CAUSE — Playwright looked
# for `chromium_headless_shell-1234` and the image carried `chromium_headless_shell-1194`. So the
# browsers were installed (that was the previous defect, and the path fix above is unchanged and
# still right) but at the WRONG BUILD.
#
# NEITHER NUMBER IS WRITTEN DOWN ANYWHERE, AND THAT IS THE POINT. Nothing in `src/` or `test/`
# hardcodes a revision: `requiredChromiumDirs` (src/lib/review.ts) parses the revision out of the
# INSTALLED Playwright's own `browsers.json` and derives the directory names from it, applying
# Playwright's `-`→`_` on-disk convention. The `-1234` occurrences in the tree are one doc comment
# and one test FIXTURE constant, neither of which the runtime consults. So the expectation follows
# the lockfile by construction and the repo side is correct — 1234 is simply what
# `playwright-core@1.62.1`, which `package-lock.json` pins, declares.
#
# THE IMAGE IS THE SIDE THAT DRIFTED. The old layer ran `npx --yes playwright install`, and a bare
# `npx` resolves whatever the registry serves at BUILD TIME — a version this repo never asked for.
# 1194 is OLDER than 1234, so the observed image was built against a Playwright predating the pin;
# the direction does not matter, because a build number tied to the calendar rather than the
# lockfile is wrong in both.
#
# WHY IT IS NOT COSMETIC: `rmd preflight --ci-parity` shells the full suite, so 51 failures mean no
# worker can ever reach a green preflight — the condition that had one run cycling preflight for
# over 90 minutes and stranding an `rmd serve` per attempt. `ensureBrowsers` (src/lib/review.ts)
# self-heals a missing build, but it runs only ahead of a `test` proof inside review; the browser
# suites launch Chromium directly and get no such rung.
#
# THE FIX IS TO PIN, AND THE PIN IS READ RATHER THAN TYPED. `PW_VERSION` is resolved from
# `/app/package-lock.json` — COPYed on the line directly above, which is the whole reason this
# layer lives here instead of where the old one did. A literal version here would be a second
# source of truth that drifts silently; there is exactly one, and it is the lockfile.
#
# WHY NOT `./node_modules/.bin/playwright`, which would be the obvious way to "use the repo's own
# Playwright": `playwright` is a devDependency, and the REQ 4 layer below prefers `npm ci
# --omit=dev`, so `/app/node_modules` may legitimately carry no Playwright at all. Resolving the
# version from the lockfile and fetching THAT gets the identical build number without depending on
# which dependency set the image happens to bake.
#
# LAYER CACHING FALLS OUT CORRECTLY AND IS NOT A COINCIDENCE. This layer's cache key is the
# lockfile COPY above it, so the browsers are re-fetched when and only when the pin moves — which
# is exactly when the build number must change.
#
# `/opt/pw-pin` IS THE PROVENANCE RECORD, and it exists so the verifier can ask a question it
# otherwise cannot: the version actually used, and the `browsers.json` that version declares.
# Without it a verifier can only re-read whatever is installed and agree with itself.
#
# `npm_config_cache` + `rm -rf` in the same RUN is REQ 14, unchanged; the REQ 14 assertion in the
# layer below still runs AFTER this one, so it continues to guard this layer's npm usage too. The
# explicit `chown` is required because `chown -R node:node /home/node` (REQ 11) is ABOVE this line,
# so the cache this writes would otherwise ship root-owned.
#
# THE CHOWN TARGETS `/home/node/.cache`, NOT `/home/node/.cache/ms-playwright`, AND THAT ONE WORD IS
# THE WHOLE OF THE SECOND DEFECT. `playwright install` runs as root and creates BOTH directories,
# because REQ 11's chown is above this layer and `.cache` did not exist when it ran. Chowning only
# the child repaired what the install WROTE and left the directory it CREATED alone. MEASURED on the
# published image:
#     drwxr-xr-x 3 root root  /home/node/.cache
#     drwxr-xr-x 6 node node  /home/node/.cache/ms-playwright
# Contents readable, parent unwritable — so anything creating a NEW entry under `.cache` fails as
# uid 1000, which is every tool that caches under XDG defaults. Same shape as REQ 14's root-owned
# `.npm`: a repair aimed one level too deep.
RUN set -eu; \
    PW_VERSION="$(node -p "require('/app/package-lock.json').packages['node_modules/playwright-core'].version")"; \
    echo "REQ 15: package-lock.json pins playwright-core@${PW_VERSION} — installing browsers for THAT version"; \
    export npm_config_cache=/tmp/npm-build-cache; \
    npm install --no-save --no-audit --no-fund --prefix /tmp/pw-pin "playwright@${PW_VERSION}"; \
    mkdir -p /opt/pw-pin; \
    cp /tmp/pw-pin/node_modules/playwright-core/browsers.json /opt/pw-pin/browsers.json; \
    printf '%s\n' "${PW_VERSION}" > /opt/pw-pin/version; \
    /tmp/pw-pin/node_modules/.bin/playwright install --with-deps chromium; \
    rm -rf /tmp/pw-pin /tmp/npm-build-cache; \
    chown -R node:node /home/node/.cache /opt/pw-pin; \
    node -e ' \
      const {readFileSync, existsSync} = require("fs"); \
      const j = JSON.parse(readFileSync("/opt/pw-pin/browsers.json", "utf8")); \
      const want = (j.browsers || []) \
        .filter((b) => b.installByDefault === true && (b.name === "chromium" || b.name === "chromium-headless-shell")) \
        .map((b) => `${b.name.replace(/-/g, "_")}-${b.revision}`); \
      if (!want.length) { console.error("BUILD ASSERTION FAILED (REQ 15): browsers.json named no default Chromium build."); process.exit(1); } \
      const root = "/home/node/.cache/ms-playwright"; \
      require("fs").writeFileSync("/opt/pw-pin/required-dirs", want.join("\n") + "\n"); \
      const missing = want.filter((d) => !existsSync(`${root}/${d}/INSTALLATION_COMPLETE`)); \
      if (missing.length) { \
        console.error("BUILD ASSERTION FAILED (REQ 15): the pinned Playwright wants " + want.join(", ")); \
        console.error("  but these are not COMPLETE under " + root + ": " + missing.join(", ")); \
        console.error("  Shipping this image reproduces the 51-failure suite and no worker reaches a green preflight."); \
        process.exit(1); \
      } \
      console.log("REQ 15 OK: " + want.join(", ") + " installed under " + root); \
    '

# ── REQ 4: node_modules PER CONTAINER, NEVER SHARED ──────────────────────────────────────────
# The shared-symlink arrangement is what let one install empty node_modules under a running daemon
# TWICE in one week. Baking it into the image layer makes it per-container by construction — there
# is nothing to share. run-task.ts already stores its install hash INSIDE node_modules and notes it
# is "naturally invalidated if node_modules is ever wiped wholesale", so the code already treats
# this directory as disposable. Do NOT mount a volume over /app/node_modules.
#
# THIS IS THE LAYER THAT SHIPPED THE ROOT-OWNED CACHE (REQ 14). It runs as root, and it runs AFTER
# `chown -R node:node /home/node`, so before this change it wrote root-owned entries into a cache
# the chown had just handed to the runtime user — leaving the top level node-owned and the contents
# not, which is why an ownership check on the DIRECTORY reported everything was fine.
#
# The assertion below is the point of the layer as much as the install is. It runs after the last
# root npm invocation in the file, so it fails the build on the build fleet if any layer above
# reintroduces the cache, rather than shipping an image whose only symptom is that the entrypoint
# bootstrap install cannot run. `ls -la` is there so the failure names what appeared, not just that
# something did.
RUN export npm_config_cache=/tmp/npm-build-cache \
 && { npm ci --omit=dev || npm ci; } \
 && rm -rf /tmp/npm-build-cache \
 && { [ ! -e /home/node/.npm ] || { \
        echo "BUILD ASSERTION FAILED (REQ 14): /home/node/.npm exists after the last root npm layer."; \
        echo "  A build layer wrote an npm cache into the runtime user HOME. It will ship partially"; \
        echo "  root-owned and the entrypoint bootstrap install will EACCES as uid 1000."; \
        ls -la /home/node/.npm; exit 1; }; } \
 && { [ ! -e /home/node/.cache ] || [ -z "$(find /home/node/.cache ! -user node -print -quit)" ] || { \
        echo "BUILD ASSERTION FAILED (REQ 14b): /home/node/.cache holds an entry not owned by node."; \
        echo "  A root layer created or repopulated it after REQ 11's chown. The published image"; \
        echo "  shipped exactly this: a root-owned .cache DIRECTORY with node-owned contents, so"; \
        echo "  reads worked and creating any NEW entry failed as uid 1000."; \
        echo "  Fix the layer that wrote it by chowning the DIRECTORY, not only what it wrote inside."; \
        find /home/node/.cache ! -user node -exec ls -ld {} + | head -5; exit 1; }; }

COPY --chown=node:node . .

# ── REQ 15: THE IMAGE MUST BE ABLE TO SAY WHICH COMMIT BUILT IT ──────────────────────────────
# MEASURED, and this is what the omission cost. The published image ran 108 commits behind
# origin/main and nothing anywhere said so; dating it required MD5-FINGERPRINTING the baked
# `/usr/local/bin/rmd-entrypoint` against every commit that ever touched `deploy/entrypoint.sh`.
# That is how a merged, tested `RMD_RESTART_THROTTLE_S` sat absent from the running image while
# four tests passed on it.
#
# WHY A FILE AND NOT ONLY A LABEL. A `LABEL` is read with `docker inspect`, which needs the docker
# CLI and the host — and the question ("what is this image?") is asked from INSIDE a running
# container, by an agent that has neither. `az acr build` also strips `.git` from the uploaded
# context, so `/app` carries no git metadata and there is no other in-image answer. A plain
# world-readable file is the only form that answers it where it is actually asked:
#   $ cat /etc/rmd-build-sha
# The LABEL is kept as well, because it is what a registry/host-side tool reads without starting
# a container at all — the two serve different askers, and `deploy/verify-image.sh` compares them
# precisely BECAUSE they are written from one ARG and must never disagree.
#
# `unknown` IS THE DEFAULT AND MUST STAY ONE. A build that supplies no `--build-arg` (a local
# `docker build`, or any build predating this layer) yields the literal `unknown`, and every
# consumer treats that as UNREADABLE rather than as a match — the same three-state discipline
# `src/lib/env.ts` readBinaryPin and this file's CLAUDE_CODE_VERSION check already follow. It is
# NOT an error: the currently published image has neither the label nor the file, and a check that
# failed on that would fire on a healthy condition the moment it landed.
#
# PLACED HERE, immediately below the source COPY that already invalidates on every commit and
# above only USER/ENTRYPOINT/CMD, so a per-commit ARG rebuilds nothing that was not rebuilding
# anyway. It must also precede `USER node`: /etc is root-owned, and this RUN needs to write it.
ARG RMD_BUILD_SHA=unknown
LABEL org.opencontainers.image.revision="${RMD_BUILD_SHA}"
RUN printf '%s\n' "${RMD_BUILD_SHA}" > /etc/rmd-build-sha && chmod 0444 /etc/rmd-build-sha

# THE RUNTIME USER, set as late as possible so every install above still had root.
USER node

# ── REQ 5: THE RESTART POLICY IS NOT SET HERE ────────────────────────────────────────────────
# It cannot be: `--restart` is a run-time flag, and the daemon and serve need DIFFERENT policies.
#   daemon → `--restart=on-failure`   (launchd `KeepAlive={SuccessfulExit:false}`)
#   serve  → `--restart=unless-stopped` (launchd `KeepAlive=<true/>`, unconditional)
# Using `always`/`unless-stopped` for the DAEMON would turn a deliberate clean stop into a crash
# loop, because exit(0) is how the daemon is stopped on purpose.
#
# THE MAPPING IS NOW VERIFIED FROM SOURCE RATHER THAN ASSERTED, and it is exact.
# `daemonExitCode` (src/lib/daemon.ts) is the whole rule: `stopped` and `max_reached` return 0 —
# "the only exits meaning this was deliberate, nothing to see" — and `blocked`, `error` and `stale`
# return nonzero. Under `SuccessfulExit: false` a zero exit counts as successful and launchd leaves
# the job DOWN; `--restart=on-failure` restarts only on nonzero. Same predicate, so the port holds.
# The independent confirmation is in launchd.ts's SERVE section, which contrasts the two directly:
# `rmd serve` returns 0 on a clean shutdown, and under `SuccessfulExit: false` that would leave the
# console down exactly when someone SIGTERM'd it — which is why serve gets UNCONDITIONAL KeepAlive.
# The two policies are genuinely different and must not be collapsed onto one container.
#
# `stale` REQUIRES THE RESTART, it does not merely tolerate it. `DaemonStopReason`'s doc calls
# staleness "a REQUEST to exit, because launchd's KeepAlive{SuccessfulExit:false} is the only
# mechanism that can get a long-running daemon off code it loaded once at boot and onto a fix merged
# since" (W1-T126). Drop the restart policy and the daemon loses its self-update path.
#
# TWO STATES MUST NEVER REACH AN EXIT, AND THIS IMAGE INHERITS THAT FOR FREE. `headroom_exhausted`
# and `paused` are deliberately absent from `DaemonStopReason`: returning `paused` used to exit,
# launchd relaunched, the fresh boot re-read the same flag and exited again — the 2026-07-22
# relaunch storm. Both are now in-process idle states that re-poll via the injected clock. That is a
# property of the daemon's own loop, not of the supervisor, so no container flag can break it.
#
# ── THE PART THAT DOES *NOT* PORT, AND IT IS THE REASON THE DAEMON IS NOT RUN HERE YET ───────
# `ThrottleInterval` (60s, plan/policy.yaml `launchd.throttleIntervalS`) has NO docker analogue.
# docker's `--restart=on-failure` backs off exponentially from roughly 100ms; there is no flag that
# sets a floor. So a crash loop in a container cycles hundreds of times faster than the 60s floor
# this repo earned from a measured 438-boots-in-two-days storm. `--restart=on-failure:N` caps the
# COUNT, which launchd cannot do — but a count is not a rate.
#
# The daemon's own crash-loop detector DOES survive a container restart (its `priorBoots` are
# re-derived from the ledger, and `daemon.boot`'s 15-minute health retention comfortably exceeds the
# detector's 10-minute window) — but it only ESCALATES, opening a needs-human issue. Unattended,
# that is a bound in name. The full argument was written to state/recon-container-supervision.md,
# which is GITIGNORED (`state/` is derived, append-only) and therefore does NOT survive the
# container that wrote it — so its load-bearing conclusions are recorded HERE instead of behind a
# citation that will not resolve. Two of them:
#
#   THE DEPLOY SUPERVISOR JOB IS REDUNDANT IN THIS IMAGE. `com.remudero.supervisor` is NOT KeepAlive
#   — it is a periodic one-shot running `rmd deploy-run` every 120s, whose two jobs are getting new
#   code onto the machine and externally kickstarting the daemon onto it. Here deploy/entrypoint.sh
#   clones or fast-forwards on every boot, and deploy/host-update.sh replaces the image wholesale.
#   Nothing needs porting; that is a third of the supervision problem that simply disappears.
#
#   THE OPERATOR'S OFF SWITCH ALREADY WORKS FROM OUTSIDE, and it is the strongest result of that
#   recon. `fleet-control.ts` resolves `<root>/state/PAUSE` and `<root>/state/STOP`, and `root` is
#   `$HOME/Remudero` — the bind mount. Writing PAUSE halts new dispatch within the poll while
#   in-flight work finishes, and the daemon idles IN PROCESS rather than exiting. Writing STOP
#   yields the `stopped` reason, exit 0, so `--restart=on-failure` leaves the container DOWN; the
#   flag auto-consumes, so it can never block a future start. No exec and no console needed.
#
# NOTE A CONTRADICTION IN THE SOURCE, flagged rather than edited from here: `DaemonStopReason`'s doc
# contains the parenthetical "SuccessfulExit:false reads ANY exit, zero or not, as worth restarting
# on this unit". That is the opposite of `daemonExitCode`'s own doc and of launchd.ts's serve
# section. Two of the three readings agree; the parenthetical is the outlier and is not needed by
# the argument around it. It matters here because a container's restart flag gets chosen from
# exactly these comments.
#
# NOTHING IN THIS IMAGE STARTS A DAEMON. `CMD` is still `./bin/rmd status`, the entrypoint runs the
# clone bootstrap and then the command it was given, and no restart policy is applied anywhere.
# `deploy/host-update.sh --print-daemon-run` prints the invocation an operator WOULD use, and runs
# nothing.

# ── REQ 9: THE SANDBOX'S RUNTIME PERMISSIONS ARE NOT SET HERE EITHER ─────────────────────────
# Same category as REQ 5: these are `docker run` flags and an image cannot carry them. Recorded
# here because REQ 8 installs bubblewrap, and bubblewrap without them fails at run time in a way
# that reads as a containment defect rather than a missing flag.
#
# bwrap creates user and mount namespaces, which Docker's DEFAULT seccomp and AppArmor profiles
# restrict. TWO things are required, and only one of them is the container's business.
#
# 1. CONFINEMENT, NOT A CAPABILITY — `--privileged` WAS NEVER GRANTING ONE. This corrects what
#    this comment said in three earlier drafts: first `--cap-add SYS_ADMIN --cap-add NET_ADMIN`,
#    then `--privileged` itself, both read as the working set because a capability-shaped fix
#    hides a confinement-shaped cause. MEASURED (W1-T508, 2026-08-15, throwaway containers, an
#    eleven-row bwrap matrix, three repeats): the image runs as non-root `node`, so `CapEff` reads
#    `0000000000000000` under EVERY flag combination tried, `--privileged` included — capabilities
#    were never the mechanism. What bwrap actually needs is settable seccomp, settable AppArmor,
#    and an unmasked `/proc`, and `--cap-drop ALL --security-opt seccomp=unconfined
#    --security-opt apparmor=unconfined --security-opt systempaths=unconfined` reproduces
#    `--privileged`'s pass on the fleet's own containment preflight (`defaultExecutor`,
#    src/lib/containment.ts) IDENTICALLY, while dropping any ONE of the three relaxations fails —
#    all three are load-bearing, none is decorative. The prize is what `--privileged` grants
#    OUTSIDE the sandbox rather than inside it: the full 41-capability bounding set and all 16 host
#    block devices, `nvme0n1p1` (the host root filesystem) among them, versus zero and zero for
#    the narrow form. THIS IS NOT A CLAIM THE RESULT IS SANDBOXED — seccomp and AppArmor are both
#    OFF for the whole container either way — the defensible claim is fewer capabilities and no
#    device access.
#
# 2. `kernel.apparmor_restrict_unprivileged_userns=0` ON THE HOST. Ubuntu 24.04 ships it ENABLED
#    and it blocks bubblewrap's nested user namespace. MEASURED both ways: with it OFF, bwrap works
#    with no setuid binary at all; with it ON, even setuid bwrap fails at `apply-seccomp`, because
#    a nested userns is capability-restricted. This is a HOST sysctl and no image can set it — it
#    is written here because nothing else in the system will tell anyone, and the failure it
#    produces looks like a broken sandbox rather than a host setting. Whether
#    `--security-opt apparmor=unconfined` subsumes this sysctl is ASSUMED, NOT MEASURED — nobody
#    has flipped it back to Ubuntu's default (1) on this host and re-run the matrix.
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

# ── REQ 12: GIT CREDENTIALS FOR THE TARGET CLONE — WHICH IS NOT THE TREE rmd RUNS FROM ───────
# Easy to get wrong because there are TWO trees. The tree rmd executes from is one thing; the tree
# it does work ON lives at `<config.root>/repos/<repo>`, and it is that remote which needs
# credentials to fetch and push.
#
# MEASURED: `gh auth setup-git` REFUSES with only `GH_TOKEN` in the environment — "You are not
# logged into any GitHub hosts" — so the obvious one-liner does not work. The working forms are a
# token-bearing remote URL, or a `url.insteadOf` rewrite in the container's git config. Either is
# the caller's job; the image cannot carry a credential and must not try.

# ── REQ 13: THE /app SNAPSHOT IS NOT A WORK TREE, AND THAT IS A REAL LIMIT ───────────────────
# MEASURED: `/app` has NO `.git`, so `rmd status` warns "cwd is not inside a git work tree", the
# deployer cannot fast-forward, and every code change needs an ACR rebuild. Note this is NOT
# `.dockerignore`'s doing — that file deliberately keeps `.git` (see its own comment: `resolveOwnerRepo`
# shells `git config --get remote.origin.url` at runtime). The stripping happens in the upload path,
# which is ASSUMED rather than proven from here: `az acr build` packs the working directory itself.
# Whatever the mechanism, the OUTCOME is measured and the snapshot cannot be relied on to be a repo.
#
# SO: SHOULD THE CONTAINER CLONE AT STARTUP INSTEAD OF CARRYING A SNAPSHOT? Argued rather than
# assumed, because the operator already hit both failure modes — a snapshot that is not a work tree,
# and a hand-clone that went stale and produced a scope-guard refusal three phases into a run.
#
# FOR THE CLONE, and these are not small: a real work tree has real remotes, so `resolveOwnerRepo`
# and `resolveRepoRoot` answer correctly instead of falling back; `checkCliFreshness` can actually
# `git merge --ff-only origin/main`, which is the mechanism by which every other host stays current;
# and new commits arrive by `git pull` in seconds rather than by a ~3-minute rebuild-and-repush.
# The snapshot cannot be made to do any of these, because the thing it is missing is the repository.
#
# AGAINST THE CLONE, and the honest cost is higher than it first looks:
#   - IT BREAKS THE DIGEST↔CODE IDENTITY. Today "image sha256:… ran" pins exactly which source ran.
#     A clone-at-startup runs whatever `main` was at container start, so the image digest stops
#     answering "what code was this". For a fleet whose entire discipline is evidence, that is a
#     genuine loss and it should not be waved through.
#   - IT NEEDS ITS OWN `npm ci`. The baked `node_modules` belongs to `/app` and matches the baked
#     lockfile. A cloned tree at a different commit may need different dependencies, and REQ 4 is
#     explicit that sharing one `node_modules` between trees is what emptied the install twice. So
#     the clone pays an install on startup — network, time, and a failure mode at the worst moment.
#   - IT NEEDS CREDENTIALS BEFORE IT CAN DO ANYTHING (REQ 12), moving a failure from mid-run to
#     start-up. That is an improvement in legibility, but it is still a new dependency at boot.
#
# RECOMMENDATION: CLONE, and accept the costs — but pin the clone to a commit and RECORD it, which
# recovers most of what the digest gave. A container that cannot fast-forward itself is a container
# that needs a rebuild to take a one-line fix, and the fleet's whole shape assumes self-sync works.
# The snapshot's remaining purpose is genuine but narrow: it is a known-good tree that needs no
# network and no credentials, which makes it the right thing for `CMD ["./bin/rmd", "status"]` and
# for any smoke test of the image itself. Keep it for that; do not run work from it.
#
# NOW IMPLEMENTED, in deploy/entrypoint.sh — the deferral above has been taken up. Each of the four
# costs named there is answered rather than rediscovered, and two of them turned out to be smaller
# than they looked because this codebase already owns the mechanism:
#
#   DIGEST↔CODE IDENTITY — recovered by `RMD_REF`, which accepts a branch, tag or sha, and by the
#   entrypoint printing the RESOLVED commit on every boot. The default is `main` rather than a
#   pinned sha, because a sha default can only be moved by editing this file and rebuilding, which
#   is the exact cost being removed, and a stale default runs old code while looking pinned.
#
#   ITS OWN `npm ci` — mostly already solved. `ensureInstallFresh` (src/run-task.ts) hashes the two
#   install inputs against a marker inside node_modules and its own doc says a matching hash is "a
#   total no-op — no redundant install, ever". The entrypoint therefore installs on ONE condition
#   only: `node_modules/.bin/tsx` is missing. That is the bootstrap `bin/rmd` cannot perform for
#   itself, since it execs tsx to run at all.
#
#   CREDENTIALS AT BOOT — a credential helper reading GH_TOKEN at call time, so no token is written
#   to the volume. `gh auth setup-git` was measured refusing with only GH_TOKEN set.
#
#   RESTART — fetch and fast-forward when clean, REFUSE when dirty, following the deployer's
#   "abort (never force) on a conflicting dirty tree". Deliberately stricter than that guard, and
#   the entrypoint says so rather than implying parity.
#
# THE /app SNAPSHOT STAYS, FOR NOW, AND THE ENTRYPOINT NEVER FALLS BACK TO IT. Two source trees in
# one container is a real hazard — a stale /app that still answers `bin/rmd` is precisely the shape
# that made a `tsx: No such file` diagnosis blame the wrong checkout — so the entrypoint `cd`s into
# the clone and FAILS LOUDLY if the clone cannot be made, rather than quietly running the snapshot.
# Removing /app is a separate change and should be argued on its own: it is still the only tree that
# needs no network and no credentials, which is what makes it usable for smoking the image itself.
# REPORTED, NOT DECIDED HERE, as the brief asked.

# ENTRYPOINT keeps tini as PID 1 (REQ 1 — the reaper) and inserts the bootstrap after it, so the
# clone happens before any command and `exec "$@"` leaves the real process as tini's child. The CMD
# is unchanged in text but now runs INSIDE THE CLONE rather than the snapshot, which is the point.
#
# ── REPORTED, NOT FIXED: THE ENTRYPOINT RUNS BEFORE ANY `docker run` COMMAND, INCLUDING PROBES ───
# A consequence rather than a defect, but it costs real time when the image is being diagnosed, so
# it is written down here. `docker run <image> ls -la /home/node/.npm` does NOT list a directory: it
# clones the repository first, which needs GH_TOKEN and network, and a failure there aborts before
# the command is ever reached. Every question about the image's CONTENTS is therefore answered
# through the bootstrap unless it is deliberately stepped around. The two ways to step around it,
# both already used by deploy/verify-image.sh:
#   docker run --rm --entrypoint bash --user 1000:1000 <image> -lc '<probe>'   # skip it entirely
#   docker run --rm -e RMD_SKIP_BOOTSTRAP=1 <image> <probe>                    # go through it, no clone
#
# NOT FIXED DELIBERATELY. The obvious fix — have the entrypoint recognise "diagnostic-looking"
# commands and skip the bootstrap for them — is a heuristic that guesses the caller's intent, and it
# fails in the expensive direction: a real task that happened to match the heuristic would run
# against a stale or absent work tree, which is the exact failure the bootstrap exists to remove.
# An explicit flag the operator passes is the right shape; it just needs to be documented, which is
# what this note is.
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/rmd-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/rmd-entrypoint"]
CMD ["./bin/rmd", "status"]
