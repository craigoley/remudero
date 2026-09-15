#!/usr/bin/env bash
# runtime-env-vars — the ONE declared list of environment variable NAMES the `remudero-daemon`
# container carries at runtime. Read by `deploy/recycle-container.sh` (which captures each one's
# value off the LIVE container before replacing it, and refuses if the container carries a runtime
# variable this list does not name) and by `deploy/host-update.sh --print-daemon-run` (which prints
# a passthrough for every name here so an operator's shell can supply it).
#
# W1-T1069: BEFORE THIS FILE EXISTED, BOTH SCRIPTS RETYPED THIS LIST BY HAND, AND DROVE APART. A
# recycle run against the live fleet would have captured `GH_TOKEN` and retyped
# `RMD_RESTART_THROTTLE_S` from the OPERATOR'S OWN SHELL (not even the container), and silently
# dropped `RMD_FRESHNESS_RESTART_MAX`, `GH_APP_ID`, `GH_APP_INSTALLATION_ID` and
# `GH_APP_PRIVATE_KEY_PATH` — four of six. The consequence was silent by design:
# `startInstallationTokenRefresh` (src/lib/github-app.ts) treats an unconfigured host as
# byte-identical to one that never had the feature, so the fleet would have reverted to the
# shared-pool PAT with NOTHING anywhere recording that it had. `GH_APP_*` landed in #2294, one day
# after the GH_TOKEN-survives-a-recycle rule was written (#2190) — the list was never a declared
# rule, it was one script's local knowledge of what existed the day it was written.
#
# THIS IS A NAME LIST, NEVER A VALUE. Nothing declared here may hold a token, a key, or a path to
# one — see deploy/recycle-container.sh's own header on why GH_TOKEN is never written to disk
# (deliberately; deploy/entrypoint.sh). Adding a name here means only "a recycle must carry this
# variable across a container replacement, not retype it"; it says nothing about the value, and
# neither consuming script ever writes one to disk.
#
# SOURCED, NOT EXECUTED. Both `deploy/recycle-container.sh` and `deploy/host-update.sh` source this
# file and carry an inline fallback copy of the SAME array for the one case where sourcing cannot
# reach it: a test fixture that copies a single script into an isolated directory to drive it alone
# (several existing MUTANT fixtures in this repo's test suite do exactly that). That fallback is
# dead code in every real deploy, where this file always ships alongside its two readers, and
# test/recycle-container.test.ts asserts all three copies of the list — this one and each script's
# fallback — never disagree, so the fallback cannot go stale unnoticed either.
#
# W1-T3603 ADDED RMD_OPENWEIGHT_API_KEY, the open-weight adapter's credential —
# OPENWEIGHT_API_KEY_ENV in src/lib/worker-provider.ts. It was declared BEFORE the name was ever
# placed on a container, which is the only reason it cost nothing: deploy/recycle-container.sh's
# drift check refuses outright — exit 1, nothing touched — on any runtime name this list does not
# carry, and it fires on EVERY later recycle, the supervisor's own included. W1-T1069, W1-T2932
# and W1-T3454 were each found AFTER their name was already live on a container. The value itself
# reaches the daemon from the operator's own shell via the W1-T2553 capture fallback, so this stays
# a NAME, exactly as the header above requires.
#
# NOTHING BUT NAMES MAY GO INSIDE THE ARRAY BELOW — not even a comment. test/recycle-container.test.ts
# reads it by whitespace-splitting everything between the parentheses, so a comment line inside the
# array is parsed as a run of variable names and the three-copy agreement check fails with a
# baffling diff. Rationale belongs here, above the array. Learned by breaking it.
# ORDER IS NOT SIGNIFICANT — this is read as a set.
RMD_DAEMON_RUNTIME_ENV_VARS=(
  GH_TOKEN
  RMD_RESTART_THROTTLE_S
  RMD_FRESHNESS_RESTART_MAX
  GH_APP_ID
  GH_APP_INSTALLATION_ID
  GH_APP_PRIVATE_KEY_PATH
  RMD_GIT_AUTHOR_NAME
  RMD_GIT_AUTHOR_EMAIL
  NODE_OPTIONS
  RMD_OPENWEIGHT_API_KEY
)

# W1-T1222: the console's own runtime names, read by `resolveServeHosts` in src/lib/serve.ts, NOT
# by the daemon — a separate list rather than folded into the one above because
# `deploy/recycle-container.sh` only ever recycles `remudero-daemon`, and `RMD_DAEMON_RUNTIME_ENV_VARS`
# is what that script's "did the running container carry a name this list does not?" refusal
# checks. `deploy/host-update.sh --print-daemon-run` reads these names so its printed
# `remudero-serve` invocation has something declared to pass through, rather than inventing the
# two spellings inline where they could drift from what src/lib/serve.ts actually reads.
RMD_SERVE_RUNTIME_ENV_VARS=(
  RMD_SERVE_HOST
  RMD_SERVE_NETWORK
  RMD_GITHUB_WEBHOOK_SECRET_FILE
)
