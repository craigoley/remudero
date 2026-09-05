# Remudero worker/daemon image — Linux (impl-EC).
#
# Azure builds this image: `.github/workflows/acr-build.yml` runs it as an ACR Task, so no local
# docker daemon is needed. It is a baked path — a merge here changes nothing at runtime until an
# operator dispatches that workflow (CLAUDE.md, "CI and merging").
#
# Each layer states the invariant it holds and the trap that earned it. The measured forensics —
# incidents, rejected alternatives, and every REQ number's evidence — live in
# docs/deploy-image-forensics.md, one heading per instruction. REQ numbers are cited by name from
# deploy/entrypoint.sh, deploy/host-update.sh, deploy/verify-image.sh and test/; keep them.

# Pin Node to the exact `.nvmrc` version, never the floating `node:22-bookworm-slim` tag.
# `assertPinnedNodeVersion` (scripts/coverage-merge-ratchet.mjs) throws on any string mismatch, so
# a moved floating tag reddened six merge-lcov tests with no change in this repo (W1-T2770).
# Bump this tag and `.nvmrc` in one commit. Falsifier:
# test/merge-lcov-node-drift-cluster-and-image-pin.test.ts reads this line against `.nvmrc`.
# Why, and why not a digest: docs/deploy-image-forensics.md, "FROM node:22.22.3-bookworm-slim".
FROM node:22.22.3-bookworm-slim

# ── REQ 1: an init that reaps ────────────────────────────────────────────────────────────────
# tini must be PID 1. `spawnDetachedGroup` (src/lib/worker-containment.ts) spawns detached, so each
# worker is its own process group and every run leaks zombies without an init.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

# ── REQ 2: gh must be present ────────────────────────────────────────────────────────────────
# Without gh, `rmd review` dies at `Error: spawnSync gh ENOENT` before it parses any criterion.
# Installed from the release tarball because the apt keyring fetch returned an empty file through
# this environment's proxy. Falsifier: the `gh --version` below proves the install in-layer.
ARG GH_VERSION=2.63.2
RUN curl -sSL -o /tmp/gh.tgz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && tar xzf /tmp/gh.tgz -C /tmp \
 && install -m755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64" \
 && gh --version

# ── REQ 3: no `security`, no `launchctl` ─────────────────────────────────────────────────────
# Neither binary is installed, deliberately. Both callers of `ensureWorkerKeychain` are darwin-gated
# and no launchd verb is on the daemon's boot path; a Linux boot reaching either must fail loudly.

# ── REQ 6: the browser preflight needs browsers baked at build time ──────────────────────────
# `rmd review` installs the pinned Playwright browsers, and that install fails behind a restricted
# network. They are therefore baked, downstream of the lockfile COPY — see REQ 15 below. The
# Playwright base image was considered twice and declined both times.
#
# ── REQ 10: HOME must be set here, or the state mount is silently ignored ────────────────────
# `loadConfig` (src/lib/config.ts) derives `root` from `os.homedir()`, which reads $HOME first, and
# Docker does not consult /etc/passwd for a `--user` override. So an unset HOME sends every ledger
# line, lock and token to `/Remudero` while the mounted volume stays empty and nothing errors.
# This ENV must stay above the browser layer, or the browsers land where no worker looks.
# Why: docs/deploy-image-forensics.md, "REQ 6" and "ENV HOME=/home/node — REQ 10".
ENV HOME=/home/node

# ── REQ 14: ship no npm cache at all ─────────────────────────────────────────────────────────
# No layer may leave `/home/node/.npm` behind. The ENV above applies to the whole build and every
# layer up to `USER node` runs as root, so root's npm cache lands in the runtime user's home; the
# published image shipped one partially root-owned and the bootstrap install hit EACCES. Each root
# npm layer below therefore uses a throwaway `npm_config_cache` and deletes it in the same RUN.
# Falsifier: the `npm ci` layer asserts that path is absent and fails the build if one reappears.
# Why (the measured image was #1482 + #1483): docs/deploy-image-forensics.md, "REQ 14".

# ── The browsers were installed and unreachable; the path was the bug ────────────────────────
# Install the browsers where the platform default already points, and set no variable at all.
# `ALLOWLIST` (src/lib/env.ts) strips `PLAYWRIGHT_BROWSERS_PATH`, so `playwrightCacheRoot`
# (src/lib/review.ts) falls back to `$HOME/.cache/ms-playwright` inside every worker.
# Why: docs/deploy-image-forensics.md, "The browser layer — installed, and still unreachable".

# ── REQ 7: the Claude Code CLI — without it no worker can spawn ──────────────────────────────
# `claude` must be on PATH. `resolveClaudeExecutable` (src/lib/worker.ts) throws
# `ClaudeToolchainBlockedError` when it finds none, so every worker spawn fails before it starts.
# Baked, not mounted: a container depending on a binary it does not carry is not self-sufficient.
# Pinned to the CLI half of the `@anthropic-ai/claude-agent-sdk` pair package-lock.json resolves.
# `DISABLE_AUTOUPDATER=1` is image-wide, wider than `buildWorkerEnv`'s per-worker grant, so no
# operator exec can rewrite the pinned binary. Falsifier: `claude --version` below proves npm's
# global bin is on PATH, in-layer. deploy/verify-image.sh and `checkBinaryPin` read the ARG below.
# Why: docs/deploy-image-forensics.md, "ARG CLAUDE_CODE_VERSION … and the global claude install".
ARG CLAUDE_CODE_VERSION=2.1.220
ENV DISABLE_AUTOUPDATER=1
# The throwaway `npm_config_cache` below is REQ 14; REQ 11's chown no longer has to repair it.
RUN npm_config_cache=/tmp/npm-build-cache \
      npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && rm -rf /tmp/npm-build-cache \
 && claude --version

# ── The Codex CLI — an opt-in second subscription, baked but dormant ─────────────────────────
# Installing this binary reroutes nothing: `workerProviders.enabled` defaults to [`claude`]. A host
# opts in by mounting an authenticated CODEX_HOME and adding `codex` to that list.
ARG CODEX_VERSION=0.152.0
RUN npm_config_cache=/tmp/npm-build-cache \
      npm install -g "@openai/codex@${CODEX_VERSION}" \
 && rm -rf /tmp/npm-build-cache \
 && codex --version

# Codex's workspace-write sandbox permits reads outside the checkout, and this container mounts two
# subscriptions plus operator state. Root ownership and mode 0444 keep uid 1000 from weakening the
# deny-read boundary. Falsifier: the `stat` and two `grep -F` checks below fail the build on drift.
RUN install -d -m 755 /etc/codex
COPY --chown=root:root deploy/codex-requirements.toml /etc/codex/requirements.toml
RUN chmod 0444 /etc/codex/requirements.toml \
 && test "$(stat -c '%u:%g:%a' /etc/codex/requirements.toml)" = "0:0:444" \
 && grep -F '"/home/node/.codex/auth.json"' /etc/codex/requirements.toml >/dev/null \
 && grep -F '"/home/node/Remudero/state"' /etc/codex/requirements.toml >/dev/null

# ── REQ 8: the sandbox binaries — bubblewrap and socat ───────────────────────────────────────
# These are not optional hardening. `validateWorkerSettings` (src/lib/settings.ts) throws unless
# `sandbox.enabled` and `sandbox.failIfUnavailable` are both true, so an image without them refuses
# rather than degrades. procps and lsof back the process sweeps: without them
# `defaultListCandidates`, `probeIdle` and `defaultGetProcessStartTime` each catch, return empty,
# and report a healthy-looking result. jq belongs to .github/workflows/ci-gate.yml, which three
# ci-gate suites extract and run verbatim. Verified in-layer for the same reason REQ 7 is: a
# missing sandbox binary should fail the build here, not a worker later.
# Why: docs/deploy-image-forensics.md, "RUN apt-get install … procps lsof jq — REQ 8".
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap socat procps lsof jq \
 && rm -rf /var/lib/apt/lists/* \
 && bwrap --version \
 && socat -V >/dev/null \
 && ps -eo pid= >/dev/null \
 && pgrep --version >/dev/null \
 && lsof -v >/dev/null 2>&1 \
 && jq --version >/dev/null
# The checks above use `>/dev/null` rather than `| head -1`: `A && B | C` parses as `A && (B | C)`
# and a pipeline's status is its last stage, so a piped check passes for a missing binary.


# ── REQ 11: hand /home/node to the runtime user, and run as that user ────────────────────────
# Every layer above runs as root, and root writing under HOME leaves root-owned caches behind, so
# this chown must stay below the last root-writing layer. `USER node` further down makes the
# correct invocation the default: the image used to default to root, and `claude` refuses
# `--permission-mode bypassPermissions` at uid 0 with a bare exit 1.
RUN chown -R node:node /home/node

WORKDIR /app
# `--chown` rather than a later `chown -R /app`, which would duplicate the whole tree into a second
# layer. It does not make an in-container `npm ci` at /app possible, and nothing installs there.
# The lockfile lands here so the browser layer below can read its Playwright pin from it.
COPY --chown=node:node package.json package-lock.json ./

# ── REQ 15: the browser build number must follow the lockfile, not the build date ────────────
# Resolve the Playwright version from `/app/package-lock.json`, COPYed above, and install browsers
# for that version. A bare `npx --yes playwright` resolves whatever the registry serves at build
# time; that shipped build 1194 against the pinned 1234 and produced 51 failures. Nothing hardcodes
# a revision — `requiredChromiumDirs` (src/lib/review.ts) derives the names from the installed
# browsers.json. The chown targets `/home/node/.cache`, not its `ms-playwright` child, because root
# creates both here. Falsifier: the node assertion ending this layer refuses an incomplete install.
# Why: docs/deploy-image-forensics.md, "The pinned Playwright browser install — REQ 15".
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

# ── REQ 4: node_modules per container, never shared ──────────────────────────────────────────
# Baking the install makes it per-container by construction; there is nothing to share. A shared
# symlink emptied node_modules under a running daemon twice in one week, so do not mount a volume
# over /app/node_modules. The two assertions below run after the last root npm invocation, so a
# layer above reintroducing a cache, or a `.cache` entry not owned by node, fails the build here.
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

# ── REQ 15: the image must be able to say which commit built it ──────────────────────────────
# A file, not only a label: the question is asked from inside a running container by an agent with
# no docker CLI, and `az acr build` strips `.git`. The LABEL stays for host-side readers, and
# deploy/verify-image.sh compares the two because one ARG writes both. `unknown` is the default and
# must stay one — every consumer reads it as unreadable, never as a match. This must precede
# `USER node`, since /etc is root-owned. Falsifier: test/image-drift.test.ts pins `unknown`.
# Why: docs/deploy-image-forensics.md, "ARG RMD_BUILD_SHA, the LABEL and /etc/rmd-build-sha".
ARG RMD_BUILD_SHA=unknown
LABEL org.opencontainers.image.revision="${RMD_BUILD_SHA}"
RUN printf '%s\n' "${RMD_BUILD_SHA}" > /etc/rmd-build-sha && chmod 0444 /etc/rmd-build-sha

# The runtime user, set as late as possible so every install above still had root.
USER node

# ── REQ 5: the restart policy is not set here ────────────────────────────────────────────────
# It cannot be. `--restart` is a run-time flag, and the daemon and serve need different policies:
#   daemon → `--restart=on-failure`     (launchd `KeepAlive={SuccessfulExit:false}`)
#   serve  → `--restart=unless-stopped` (launchd `KeepAlive=<true/>`, unconditional)
# `daemonExitCode` (src/lib/daemon.ts) is the whole rule: `stopped` and `max_reached` exit 0, and
# `blocked`, `error` and `stale` exit nonzero. Using `always` for the daemon turns a deliberate
# clean stop into a crash loop, and `stale` needs the restart — it is the self-update path.
# Nothing in this image starts a daemon: `CMD` is `./bin/rmd status`. What does not port is
# `ThrottleInterval` (60s), which has no docker analogue, so a container crash loop cycles far
# faster than the floor a measured 438-boot storm earned.
# Why (incl. the gitignored supervision recon): docs/deploy-image-forensics.md, "REQ 5".

# ── REQ 9: the sandbox's runtime permissions are not set here either ─────────────────────────
# Same category as REQ 5: these are `docker run` flags and an image cannot carry them. Recorded
# here because REQ 8 bakes bubblewrap, which without them fails in a way that reads as a
# containment defect rather than a missing flag.
# CONFINEMENT, NOT A CAPABILITY. bwrap needs settable seccomp, settable AppArmor and an unmasked
# /proc, so `--cap-drop ALL --security-opt seccomp=unconfined --security-opt apparmor=unconfined
# --security-opt systempaths=unconfined` reproduces `--privileged`'s pass on the containment
# preflight (`defaultExecutor`, src/lib/containment.ts), and dropping any one of the three fails.
# The container runs as non-root, so capabilities were never the mechanism; the prize is outside
# the sandbox — zero capabilities and zero host block devices, against all of both. This is not a
# claim the result is sandboxed: seccomp and AppArmor are off either way.
# The host must also set `kernel.apparmor_restrict_unprivileged_userns=0`, which Ubuntu 24.04 ships
# enabled and which blocks bubblewrap's nested user namespace; no image can set a host sysctl.
# Whether `apparmor=unconfined` subsumes it is assumed, not measured. Falsifier:
# test/entrypoint-boot.test.ts refuses the superseded capability-shaped wording here.
# Why: docs/deploy-image-forensics.md, "REQ 9 — the sandbox's runtime permissions".

# ── REQ 12: git credentials for the target clone, which is not the tree rmd runs from ────────
# The tree rmd works ON lives at `<config.root>/repos/<repo>`, and that remote needs credentials.
# `gh auth setup-git` refuses with only GH_TOKEN set, so the working forms are a token-bearing
# remote URL or a `url.insteadOf` rewrite. The image must not carry a credential.

# ── REQ 13: the /app snapshot is not a work tree ─────────────────────────────────────────────
# `/app` has no `.git`, so `rmd status` warns and the deployer cannot fast-forward. The container
# therefore clones at startup, in deploy/entrypoint.sh, and never falls back to the snapshot — two
# source trees in one container is what made a `tsx: No such file` diagnosis blame the wrong
# checkout. `RMD_REF` and the boot-time resolved commit recover the digest↔code identity. Keep the
# snapshot only as a known-good tree needing no network, which is what `CMD` uses.
# Why: docs/deploy-image-forensics.md, "REQ 13 — the /app snapshot is not a work tree".

# tini stays PID 1 (REQ 1) and the bootstrap runs after it, so `exec "$@"` leaves the real process
# as tini's child. The CMD text is unchanged but now runs inside the clone, not the snapshot.
# The entrypoint runs before any `docker run` command, probes included, so a question about the
# image's contents goes through the bootstrap unless it is stepped around, as verify-image.sh does:
#   docker run --rm --entrypoint bash --user 1000:1000 <image> -lc '<probe>'   # skip it entirely
#   docker run --rm -e RMD_SKIP_BOOTSTRAP=1 <image> <probe>                    # go through it, no clone
# Not fixed deliberately: a heuristic guessing which commands are diagnostic would fail expensively.
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/rmd-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/rmd-entrypoint"]
CMD ["./bin/rmd", "status"]
