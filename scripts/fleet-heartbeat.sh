#!/usr/bin/env bash
# fleet-heartbeat — the mini says "I am still here", on a cadence, to somewhere off the mini.
#
# THE GAP THIS CLOSES. Every off-machine write this fleet makes is ACTIVITY-CONDITIONAL: a branch
# push when a run produces code, a PR comment when a review posts, `gh issue create` when
# something escalates. Nothing leaves the machine on a cadence. So during a genuinely quiet
# period a healthy fleet and a dead one are BYTE-IDENTICAL from outside the machine, and the
# operator learns nothing — for hours, or until he happens to try. This script is the missing
# signal; .github/workflows/fleet-heartbeat-watch.yml is the thing that notices its absence.
#
# ── THE REPORTER MUST NOT DEPEND ON THE THING IT REPORTS ON ────────────────────────────────────
# This is PLAIN BASH AND GIT. Not an `rmd` verb, not node, not tsx, and it must stay that way.
# `bin/rmd` is nine lines of bash ending in `exec "$DIR/node_modules/.bin/tsx" …`, so an emptied
# `node_modules` kills EVERY verb and the launchd supervisor while the already-running daemon
# keeps serving from resident memory — the fleet looks alive and cannot restart. That happened
# twice in one week. A heartbeat written as a verb dies in exactly that state, and its silence is
# then indistinguishable from a power cut. Written in bash it survives, and beats with a payload
# that NAMES the failure. Adding a node/tsx dependency here silently re-opens that hole.
#
# ── THE PAYLOAD CARRIES DAEMON LIVENESS, NOT MERELY ITS OWN EXISTENCE ─────────────────────────
# A beat that only proves the cron fired is a GREEN LIGHT ON A DEAD FLEET, which is worse than no
# light at all. So each beat carries the daemon's own last-poll timestamp, read from the ledger.
#
# WHY THE `daemon.` PREFIX AND NOT ANY SINGLE STEP. This mirrors `deriveLastPoll`
# (src/lib/daemon-health.ts) deliberately, rather than inventing a second liveness rule that
# could disagree with the console's. That function's own header records the finding: `runDaemon`
# (src/lib/daemon.ts) has NO single ledger step that fires unconditionally every tick —
# `daemon.pause`, `daemon.headroom`, `daemon.idle` and `daemon.iteration` each fire on a
# DIFFERENT branch — but every branch that does not exit the process logs at least one
# `daemon.`-prefixed line before its next tick. The MAX `ts` over the prefix is therefore a real,
# always-advancing signal. DO NOT add a new unconditional log call to get one; the signal exists.
# Like `deriveLastPoll`, this takes the MAX rather than the last line — ISO-8601 UTC sorts
# lexicographically, so `sort | tail -1` is a true max and never assumes ledger append order.
#
# ROTATION CANNOT CORRUPT THIS, and nobody should have to rediscover that. `rotateLedger`
# (src/lib/ledger.ts) keeps only MAX_RETAINED_LINES_PER_STEP = 200 newest lines PER STEP and
# gzips the rest into `state/ledger.<ts>.ndjson.gz`. A heartbeat reads the MOST RECENT
# `daemon.`-prefixed line, never a COUNT, so it is indifferent to how many older ones were
# archived — unlike `priorActionsFromLedger`'s ABSENT_REPUSH_CAP, which counts and therefore had
# to join DECISION_RELEVANT_LEDGER_STEPS. This reads one line. It needs no registry entry.
#
# ── TRANSPORT: A FORCE-PUSHED ROOT COMMIT ON A DEDICATED BRANCH ───────────────────────────────
# No new credential. The fleet pushes branches continuously, and `writeDaemonPlist`
# (src/lib/launchd.ts) sets HOME in the unit's closed PATH+HOME allowlist, which is why `git` and
# `gh` work unattended. Readable from a phone as a branch's last-commit time and subject line.
#
# NOT a gist (outside the repo, needs token scope beyond `github.token`, so the watcher could not
# read it). NOT an issue body (every edit notifies, and it collides with the needs-human lane the
# watcher itself delivers into). NOT `repository_dispatch` (also needs a token beyond
# `github.token`, with no advantage over a branch).
#
# THE WORKING TREE IS NEVER TOUCHED. This uses git PLUMBING only — hash-object, mktree,
# commit-tree — so there is no `git add`, no index write, no branch switch, and no checkout
# mutation. That is load-bearing: `checkCliFreshness` (src/lib/self-sync.ts) refuses verbs on a
# dirty checkout, and the operator checkout is the one the launchd daemon loads its code from. A
# heartbeat that dirtied it would break the fleet it exists to watch.
#
# EACH BEAT IS A FRESH ROOT COMMIT (no parent) force-pushed over the branch, so the branch is
# always exactly one commit and never grows. The superseded objects become unreachable and are
# collected by git's ordinary `gc --auto`; nothing here needs to prune them.
#
# ── EXIT CODES ────────────────────────────────────────────────────────────────────────────────
# 0 = the beat was published (whatever it SAID about the fleet's health — a beat reporting a dead
#     daemon is a SUCCESSFUL beat; the verdict travels in the payload, not the exit code).
# 1 = the beat could not be published. Nothing off-machine changed, and the watcher will
#     eventually see the silence. This is the only failure mode this script has.
#
# ── INSTALLING IT ON THE MINI ─────────────────────────────────────────────────────────────────
# Every five minutes, from the operator checkout, e.g. a launchd agent with
# StartInterval 300 and ProgramArguments [<checkout>/scripts/fleet-heartbeat.sh], or a crontab
# line `*/5 * * * * <checkout>/scripts/fleet-heartbeat.sh >/dev/null 2>&1`. It needs no
# arguments. The watcher's staleness threshold is derived from that five-minute interval — see
# STALE_AFTER_MINUTES in .github/workflows/fleet-heartbeat-watch.yml before changing the cadence.
#
# ── INSTALLING IT ON A CONTAINER HOST (W1-T483) ───────────────────────────────────────────────
# The Azure host runs the fleet as docker containers and has NO launchd. A host `crontab` line is
# the install surface, and it is the same one this script's own header already documents:
#
#   */5 * * * * RMD_ROOT=<state-root> RMD_HEARTBEAT_BRANCH=heartbeat-<host> \
#               <checkout>/scripts/fleet-heartbeat.sh >/dev/null 2>&1
#
# THE REPORTER MUST NOT RUN INSIDE THE THING IT REPORTS ON, and on a container host that stops
# being a philosophical point and becomes the whole defect. A beat scheduled INSIDE
# `remudero-daemon` dies at the same instant the daemon does, so the one condition it exists to
# report is the one it can never report — and the container also reads "Up N minutes" while the
# daemon process is gone (the entrypoint shell and its restart-throttle `sleep` keep it alive), so
# the container's own status cannot stand in either. A SIDECAR container is closer but still wrong
# twice over: it would need the docker socket mounted to read the restart budget below, which is a
# privilege escalation for a reporter, and it is itself a container that can be stopped by the same
# hand or the same host problem. A HOST cron entry has neither objection: it survives every
# container, it already has docker, and it is plain bash and git — which is the one constraint this
# script may never trade away (see the header above: an emptied `node_modules` kills every `rmd`
# verb while the resident daemon keeps serving, and a beat written as a verb goes silent in exactly
# that state).
#
# ── ONE BRANCH PER HOST. TWO HOSTS ON ONE BRANCH IS THE DEFECT, NOT A TIDINESS ISSUE ──────────
# Each beat is a FORCE-PUSHED PARENTLESS COMMIT, so a branch holds exactly one beat and no history.
# Two hosts beating to the same branch therefore OVERWRITE each other, and the watcher — which
# measures `now - last commit` on that branch — reads the freshest of them. A healthy host then
# masks a dead one completely: measured 2026-08-14, the Azure fleet was down 2h56m while this
# branch kept reporting `daemon live`, truthfully, about the mini. So SET
# `RMD_HEARTBEAT_BRANCH` PER HOST and list every branch in the watcher's `HEARTBEAT_BRANCHES`.
# The default is left at `heartbeat` so an already-installed host keeps beating where it does.
#
# Overrides, all optional: RMD_ROOT (config.root), RMD_HEARTBEAT_BRANCH, RMD_HEARTBEAT_REMOTE,
# RMD_HEARTBEAT_CONTAINER (the container whose restart budget to read; `none` to skip).

# NOT `set -e`, deliberately. Every probe below is BEST-EFFORT and a probe that cannot answer is
# itself diagnostic — "the ledger is unreadable" is a finding, not a reason to abort the beat.
# `-e` would turn the most alarming states this script exists to report into silence.
set -uo pipefail

# Resolve the install directory the same way bin/rmd does, symlink chain included, so this script
# and the verb it reports on can never disagree about which checkout they mean.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$LINK_DIR/$SOURCE"
done
INSTALL_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

BRANCH="${RMD_HEARTBEAT_BRANCH:-heartbeat}"
REMOTE="${RMD_HEARTBEAT_REMOTE:-origin}"
PAYLOAD_FILE="heartbeat.txt"

# ── config.root ───────────────────────────────────────────────────────────────────────────────
# `configPath()` (src/lib/config.ts) is ~/.config/remudero/config.json and `root` defaults to
# ~/Remudero there; `ledgerPathFor(config)` (src/run-task.ts) is join(root, "state",
# "ledger.ndjson"). Read with grep rather than a JSON parser on purpose: jq is not guaranteed
# present, and this script may not reach for node. A malformed or absent config falls back to the
# same default the TypeScript uses, and says so in the payload rather than failing.
CONFIG_FILE="${HOME}/.config/remudero/config.json"
ROOT_SOURCE="default"
RMD_ROOT="${RMD_ROOT:-}"
if [ -n "$RMD_ROOT" ]; then
  ROOT_SOURCE="env"
elif [ -r "$CONFIG_FILE" ]; then
  RMD_ROOT="$(grep -o '"root"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" 2>/dev/null | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -n "$RMD_ROOT" ] && ROOT_SOURCE="config"
fi
[ -n "$RMD_ROOT" ] || RMD_ROOT="${HOME}/Remudero"
LEDGER="${RMD_ROOT}/state/ledger.ndjson"
STATE_FILE="${RMD_ROOT}/state/heartbeat-last.txt"

# ── portable time helpers ─────────────────────────────────────────────────────────────────────
# The beat runs on macOS (BSD date); the watcher that reads it runs on ubuntu-latest (GNU date).
# Try GNU first, fall back to BSD, and return empty rather than a wrong number if neither parses —
# an unparseable timestamp must read as UNKNOWN, never as age zero, which would look healthy.
epoch_of() {
  local iso="$1" out
  [ -n "$iso" ] || return 0
  if out=$(date -u -d "$iso" +%s 2>/dev/null); then printf '%s' "$out"; return 0; fi
  # BSD `date -j -f` cannot read fractional seconds or the trailing Z, so both are stripped.
  local trimmed="${iso%Z}"
  trimmed="${trimmed%.*}"
  if out=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$trimmed" +%s 2>/dev/null); then printf '%s' "$out"; return 0; fi
  return 0
}

human_age() {
  local s="$1"
  if [ -z "$s" ]; then printf 'unknown'; return 0; fi
  if [ "$s" -lt 60 ]; then printf '%ds' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%dm' "$((s / 60))"
  else printf '%dh%dm' "$((s / 3600))" "$(((s % 3600) / 60))"; fi
}

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_EPOCH="$(date -u +%s)"

# ── probe: is the CLI usable at all? ──────────────────────────────────────────────────────────
# One stat plus one count. This names the failure that has now happened twice — an emptied
# node_modules under a running daemon — and it is the single most valuable field in the payload,
# because it is the one state a heartbeat written as an `rmd` verb could never report.
TSX_PATH="${INSTALL_DIR}/node_modules/.bin/tsx"
if [ -x "$TSX_PATH" ]; then TSX_PRESENT="yes"; else TSX_PRESENT="no"; fi
if [ -d "${INSTALL_DIR}/node_modules" ]; then
  # `-A`, because the entries that matter most here are dotted: `.bin` (which holds tsx) and
  # `.package-lock.json`. A plain `ls -1` reports an emptied-but-for-dotfiles directory as 0.
  NODE_MODULES_ENTRIES="$(ls -1A "${INSTALL_DIR}/node_modules" 2>/dev/null | wc -l | tr -d ' ')"
else
  NODE_MODULES_ENTRIES="0"
fi
if [ "$TSX_PRESENT" = "yes" ]; then
  RMD_VERDICT="ok"
elif [ "$NODE_MODULES_ENTRIES" = "0" ]; then
  RMD_VERDICT="BROKEN: node_modules is empty — every rmd verb and the launchd supervisor are dead"
else
  RMD_VERDICT="BROKEN: node_modules/.bin/tsx is missing — every rmd verb is dead"
fi

# ── probe: daemon liveness, the max ts over the `daemon.` prefix ──────────────────────────────
DAEMON_LAST_TS=""
DAEMON_LAST_STEP=""
DAEMON_BOOT_TS=""
DAEMON_BOOT_SHA=""
LEDGER_STATE="ok"
if [ ! -r "$LEDGER" ]; then
  LEDGER_STATE="unreadable — no ledger at ${LEDGER}"
else
  # `appendLedger` (src/lib/ledger.ts) serialises `{ ts, ...line }`, so every record begins
  # literally `{"ts":"…"` with no whitespace — that anchor is why one sed extracts the timestamp
  # unambiguously without a JSON parser. A torn or differently-shaped line simply does not match
  # and is skipped, which reads as UNKNOWN rather than as a wrong age.
  DAEMON_LAST_TS="$(grep '"step":"daemon\.' "$LEDGER" 2>/dev/null \
    | sed -n 's/^{"ts":"\([^"]*\)".*/\1/p' | sort | tail -n 1)"
  if [ -n "$DAEMON_LAST_TS" ]; then
    DAEMON_LAST_STEP="$(grep -F "\"ts\":\"${DAEMON_LAST_TS}\"" "$LEDGER" 2>/dev/null \
      | grep -o '"step":"daemon\.[^"]*"' | tail -n 1 | cut -d'"' -f4)"
  fi
  BOOT_LINE="$(grep -F '"step":"daemon.boot"' "$LEDGER" 2>/dev/null | tail -n 1)"
  if [ -n "$BOOT_LINE" ]; then
    DAEMON_BOOT_TS="$(printf '%s' "$BOOT_LINE" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    DAEMON_BOOT_SHA="$(printf '%s' "$BOOT_LINE" | grep -o '"head_sha":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  fi
fi

DAEMON_LAST_EPOCH="$(epoch_of "$DAEMON_LAST_TS")"
DAEMON_AGE_S=""
if [ -n "$DAEMON_LAST_EPOCH" ]; then DAEMON_AGE_S="$((NOW_EPOCH - DAEMON_LAST_EPOCH))"; fi
BOOT_EPOCH="$(epoch_of "$DAEMON_BOOT_TS")"
BOOT_AGE_S=""
if [ -n "$BOOT_EPOCH" ]; then BOOT_AGE_S="$((NOW_EPOCH - BOOT_EPOCH))"; fi

# The daemon's own poll interval is DEFAULT_POLL_INTERVAL_MS (src/lib/daemon.ts); a poll older
# than several intervals is stale however healthy the machine underneath it looks. Ten minutes is
# generous against that default and against a tick that blocked on a slow GitHub read.
DAEMON_STALE_AFTER_S=600
if [ -z "$DAEMON_AGE_S" ]; then
  DAEMON_VERDICT="unknown — no daemon.* line in the ledger"
elif [ "$DAEMON_AGE_S" -le "$DAEMON_STALE_AFTER_S" ]; then
  DAEMON_VERDICT="live"
else
  DAEMON_VERDICT="STALE — last poll $(human_age "$DAEMON_AGE_S") ago"
fi

# ── probe: deploy-supervisor liveness, the max ts over the `deploy.` prefix (W1-T2349) ───────────
# THE GAP THIS CLOSES. The daemon probe above answers "is the daemon alive"; nothing until now
# answered "is the thing that ADVANCES the daemon's code alive" — the deploy-supervisor went
# 7h26m overdue on the mini with nothing off-host reporting it, because every other beat field
# (daemon liveness, the install verdict, the restart budget, three shas) can read perfectly
# healthy while the deploy cycle itself has stopped ticking.
#
# WHY THIS MIRRORS THE `daemon.` PROBE ABOVE, STEP FOR STEP. `runDeployCycle`
# (src/lib/deployer.ts) has no single ledger step that fires unconditionally either —
# `deploy.skip` on a same-head no-op, `deploy.not_idle` / `deploy.idle_ceiling_forced` while the
# idle gate defers, `deploy.abort_dirty_tree`, `deploy.pulled`, `deploy.dry_run`,
# `deploy.kickstart` -> `deploy.ok` / `deploy.unhealthy_rollback` on a real cycle — but RE-READING
# THAT FUNCTION TOP TO BOTTOM (2026-08-27), every `return` in it is preceded by a `deps.log("deploy…")`
# call on the same branch, so every tick logs at least one `deploy.`-prefixed line before the next.
# That includes a DEFERRED tick: `deploy.not_idle` fires every time the idle gate holds, so the
# 30-minute `DEPLOY_IDLE_DEFER_CEILING_MS` (src/lib/deployer.ts) bounds how long a deploy can be
# HELD, never how long the ledger can go quiet, and does not enter the threshold below. The MAX ts
# over the prefix is therefore the same always-advancing signal the `daemon.` probe already reads,
# over the supervisor's own ledger writes rather than the daemon's.
#
# THE FIELD NAMES MIRROR `daemon_*` ONE-FOR-ONE, WITH ONE DELIBERATE DIFFERENCE. Same
# `sort | tail -n 1` idiom, same `epoch_of`/`human_age` reuse, same never-touch-a-new-file
# discipline. But an ABSENT reading here does NOT reuse the `daemon_last_age_s=unknown` shape:
# it follows `restart_count`/`image_build_sha` instead and OMITS `supervisor_last_age_s` from the
# payload entirely rather than writing the string "unknown" into a numeric-shaped field — the
# same absent-never-reassuring law, applied consistently.
#
# A HOST WITH NO `deploy.` LINE EVER IS NOT A DEFECT IN THIS PROBE. The container host (W1-T483)
# advances its tree from `deploy/entrypoint.sh` under docker, with no launchd and no
# deploy-supervisor unit, so its ledger may legitimately carry zero `deploy.` lines forever. This
# probe cannot and does not decide "never installed" vs "went quiet" — it publishes the same
# `supervisor_verdict=unknown` either way, with the reason in `supervisor_source`, and leaves the
# never-present-is-silent judgment to the watcher, which sees every beat over time and a branch
# list that already knows which hosts run a deploy-supervisor at all.
SUPERVISOR_LAST_TS=""
SUPERVISOR_LAST_STEP=""
SUPERVISOR_SOURCE="ledger"
if [ ! -r "$LEDGER" ]; then
  SUPERVISOR_SOURCE="unreadable — no ledger at ${LEDGER}"
else
  SUPERVISOR_LAST_TS="$(grep '"step":"deploy\.' "$LEDGER" 2>/dev/null \
    | sed -n 's/^{"ts":"\([^"]*\)".*/\1/p' | sort | tail -n 1)"
  if [ -n "$SUPERVISOR_LAST_TS" ]; then
    SUPERVISOR_LAST_STEP="$(grep -F "\"ts\":\"${SUPERVISOR_LAST_TS}\"" "$LEDGER" 2>/dev/null \
      | grep -o '"step":"deploy\.[^"]*"' | tail -n 1 | cut -d'"' -f4)"
  else
    SUPERVISOR_SOURCE="no deploy.* line in the ledger — this host may never run a deploy-supervisor cycle (the container host advances via deploy/entrypoint.sh instead, W1-T483)"
  fi
fi

SUPERVISOR_LAST_EPOCH="$(epoch_of "$SUPERVISOR_LAST_TS")"
SUPERVISOR_AGE_S=""
if [ -n "$SUPERVISOR_LAST_EPOCH" ]; then SUPERVISOR_AGE_S="$((NOW_EPOCH - SUPERVISOR_LAST_EPOCH))"; fi

# THE THRESHOLD IS DERIVED AND GENEROUS (design note v). The installed supervisor unit's
# `StartInterval` is `DEFAULT_SUPERVISOR_INTERVAL_S = 120` (src/lib/launchd.ts) — every tick runs
# ONE `rmd deploy-run`, i.e. one `runDeployCycle`, i.e. at least one `deploy.*` log line, whether
# or not that cycle actually deployed anything. This carries a GENEROUS CONSTANT rather than
# shelling `rmd status` or parsing the installed plist — the beat may not shell an `rmd` verb (see
# this script's own header) and a plist path is host-specific and absent entirely on the container
# host. 1200s is 10x the 120s interval, the SAME multiple `DAEMON_STALE_AFTER_S` already uses
# against `DEFAULT_POLL_INTERVAL_MS` (600s / 60s) above, and against the 7h26m (26760s) failure
# that filed this task, a 1200s bound still catches it more than 20x over.
SUPERVISOR_STALE_AFTER_S=1200
if [ -z "$SUPERVISOR_AGE_S" ]; then
  SUPERVISOR_VERDICT="unknown"
elif [ "$SUPERVISOR_AGE_S" -le "$SUPERVISOR_STALE_AFTER_S" ]; then
  SUPERVISOR_VERDICT="live"
else
  SUPERVISOR_VERDICT="STALE — last deploy cycle $(human_age "$SUPERVISOR_AGE_S") ago"
fi

# ── probe: cheap diagnostics ──────────────────────────────────────────────────────────────────
# `df -Pk` is the POSIX-portable form and reports 1K blocks on both macOS and Linux, so this one
# expression is correct on the mini and on any future host. `readDiskFreeBytes`
# (src/lib/daemon-health.ts) computes the same headroom from statfs for the console's widget.
DISK_FREE_KB="$(df -Pk "$RMD_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
[ -n "$DISK_FREE_KB" ] || DISK_FREE_KB="unknown"

# W1-T2767: PER-DEVICE, BECAUSE THE ONE NUMBER ABOVE HAS NEVER ONCE MEASURED THE DISK THAT FILLS.
#
# On 2026-09-02 the 29G OS disk hit 100% and the host ran wedged ~25h. `disk_free_kb` read ~102GB
# green throughout, and correctly: `RMD_ROOT` is a MOUNT of the 126G data disk (dev 66310) while
# `/` is dev 66306. Three instruments shared that blind spot — this beat, `readDiskHeadroom`
# (config.root, W1-T2757) and `host-update.sh --reclaim-only` (prunes the docker root, prints
# `df /`, W1-T2758) — so the pattern, not any one of them, is the finding.
#
# WHY THE HOST SIDE HAS TO PUBLISH THIS. The daemon runs INSIDE a container whose `/` is a docker
# overlay on the data disk; host `/` reaches it only via the `.claude`/`.codex` bind mounts, i.e.
# incidentally, because those happen to live under /home. An in-container enumeration that reads
# green today would go silently blind the moment those binds moved. The beat runs on the host and
# can name the host's own root directly, so this is the reading that cannot be undermined.
#
# DEDUPED BY DEVICE, NOT BY PATH: `df -Pk` column 1 is the backing device, so two paths on one
# filesystem collapse to one row instead of double-reporting the same free space. Every value is
# `unknown` rather than 0 when unreadable — an unreadable filesystem is never reported as a full
# one, matching `readDiskFreeBytes`'s own fail-soft discipline.
df_field() { df -Pk "$1" 2>/dev/null | awk -v c="$2" 'NR==2 {print $c}'; }
ROOT_FS_FREE_KB="$(df_field / 4)"; [ -n "$ROOT_FS_FREE_KB" ] || ROOT_FS_FREE_KB="unknown"
ROOT_FS_DEVICE="$(df_field / 1)";  [ -n "$ROOT_FS_DEVICE" ]  || ROOT_FS_DEVICE="unknown"
STATE_FS_DEVICE="$(df_field "$RMD_ROOT" 1)"; [ -n "$STATE_FS_DEVICE" ] || STATE_FS_DEVICE="unknown"

# The smallest READABLE headroom across the distinct devices — the number a reader should alarm on,
# since any one of them filling halts the fleet. `unknown` only when nothing was readable; a single
# unreadable device never drags a readable minimum to `unknown`, and never invents a 0.
DISK_MIN_FREE_KB="unknown"
for _kb in "$DISK_FREE_KB" "$ROOT_FS_FREE_KB"; do
  case "$_kb" in ''|*[!0-9]*) continue ;; esac
  case "$DISK_MIN_FREE_KB" in
    unknown) DISK_MIN_FREE_KB="$_kb" ;;
    *) [ "$_kb" -lt "$DISK_MIN_FREE_KB" ] && DISK_MIN_FREE_KB="$_kb" ;;
  esac
done

LEDGER_BYTES="unknown"
if [ -r "$LEDGER" ]; then
  LEDGER_BYTES="$(wc -c < "$LEDGER" 2>/dev/null | tr -d ' ')"
fi

INSTALL_SHA="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null)"
[ -n "$INSTALL_SHA" ] || INSTALL_SHA="unknown"

# ── probe: the container restart budget (W1-T483) ─────────────────────────────────────────────
# THIS IS AN EARLY WARNING, NOT A DETECTOR, AND THE DISTINCTION IS THE WHOLE POINT. Docker's
# `--restart=on-failure:N` caps the COUNT of automatic restarts for a container instance, and
# nothing restores it: measured on this host with three throwaway containers, a container that ran
# healthily for twenty seconds — and one that ran for two full minutes, twice — still reached the
# cap and stayed exited. Every non-zero exit spends one, and `daemonExitCode` (src/lib/daemon.ts)
# returns non-zero for a routine freshness restart as well as for a crash, so a HEALTHY, MERGING
# fleet empties the budget as fast as it merges. When it empties the container stops for good and
# nothing brings it back. Publishing the count while the fleet is still up is what turns that from
# a post-mortem into a warning.
# WHAT THIS CAN NEVER DO: report the budget once the container is already down — there is nothing
# left to inspect. THE DETECTOR IS THE BEAT'S ABSENCE, which the watcher already reads. This field
# only buys the operator the interval BEFORE the stop.
# AND IT DEGRADES TO ABSENT, NEVER TO ZERO. A `restart_count=0` means "the whole budget is
# untouched" — the most reassuring value in the field's range — so a read that FAILED must never
# produce it. On a host with no docker, or where the inspect fails, the numeric fields are OMITTED
# ENTIRELY and only `restart_source` is written, carrying the reason. This is the law this repo has
# corrected seven times, applied to a field whose failure direction is unusually dangerous.
RESTART_CONTAINER="${RMD_HEARTBEAT_CONTAINER:-remudero-daemon}"
# The runtime is a NAME, not a hardcoded call, for two reasons that are not about testing: a host
# may keep it off the default PATH, and a podman-based host answers the identical `inspect
# --format` contract. Overriding it to a path that does not exist is also the only honest way to
# exercise the no-runtime branch, since `command -v docker` would otherwise find the real one.
RESTART_RUNTIME="${RMD_HEARTBEAT_DOCKER:-docker}"
RESTART_COUNT=""
RESTART_MAX=""
RESTART_POLICY=""
if [ "$RESTART_CONTAINER" = "none" ]; then
  RESTART_SOURCE="skipped — RMD_HEARTBEAT_CONTAINER=none"
elif ! command -v "$RESTART_RUNTIME" >/dev/null 2>&1; then
  RESTART_SOURCE="unavailable — no ${RESTART_RUNTIME} on this host"
else
  RESTART_RAW="$("$RESTART_RUNTIME" inspect "$RESTART_CONTAINER" \
    --format '{{.RestartCount}} {{.HostConfig.RestartPolicy.MaximumRetryCount}} {{.HostConfig.RestartPolicy.Name}}' \
    2>/dev/null)"
  if [ -z "$RESTART_RAW" ]; then
    RESTART_SOURCE="unavailable — ${RESTART_RUNTIME} inspect ${RESTART_CONTAINER} returned nothing"
  else
    read -r RESTART_COUNT RESTART_MAX RESTART_POLICY <<<"$RESTART_RAW"
    # A non-numeric count is a parse failure, not a reading. Clearing BOTH numbers here is what
    # keeps the absent-never-zero rule true for a malformed answer as well as for a missing one.
    case "${RESTART_COUNT:-}" in
      '' | *[!0-9]*)
        RESTART_COUNT=""
        RESTART_MAX=""
        RESTART_SOURCE="unavailable — ${RESTART_RUNTIME} inspect ${RESTART_CONTAINER} gave no numeric RestartCount"
        ;;
      *)
        RESTART_SOURCE="${RESTART_RUNTIME} inspect ${RESTART_CONTAINER}"
        # `MaximumRetryCount` is 0 for every policy that does not cap, and for `on-failure` with no
        # `:N`. Rendering that 0 verbatim would read as "no restarts left" — the opposite of what it
        # means — so an uncapped policy says so in words.
        if [ "$RESTART_POLICY" != "on-failure" ] || [ "$RESTART_MAX" = "0" ]; then
          RESTART_MAX="unlimited"
        fi
        ;;
    esac
  fi
fi

# ── probe: the IMAGE build sha (W1-T496) ───────────────────────────────────────────────────────
# THE THIRD SHA, AND IT IS NOT A COPY OF THE OTHER TWO. `daemon_boot_head_sha` (the boot ledger
# line) and `install_head_sha` (`git rev-parse` on INSTALL_DIR) both read the MOUNTED checkout —
# W1-T494 files the case where the two agreed while both were stale, because a mount-side sha
# cannot see anything baked. `deploy/Dockerfile` bakes a DIFFERENT sha into the IMAGE at build
# time, twice over — a `LABEL org.opencontainers.image.revision` and a plain file,
# `/etc/rmd-build-sha` (0444). Reading the file over `docker exec` is what makes a merged change
# to a baked path (`deploy/entrypoint.sh`, an apt binary in `deploy/Dockerfile`) distinguishable
# from a shipped one WITHOUT shelling into the host — see CLAUDE.md for which half of a diff that
# is. Reuses `RESTART_CONTAINER`/`RESTART_RUNTIME` from the probe above: it is the same daemon
# container, and a second env var to name it again would answer a question this repo already
# answered once.
# DEGRADES TO ABSENT, NEVER TO A LITERAL THAT READS AS HEALTHY — same law as RESTART_COUNT above.
# THIS MATTERS HERE SPECIFICALLY: the Dockerfile's own `ARG RMD_BUILD_SHA=unknown` means an image
# built without the build arg writes the literal string `unknown` to the file, and a heartbeat
# that published that verbatim would look like a real, if odd, sha rather than an absent reading.
# A build sha is git-hex, so anything else — `unknown` included — is rejected here, not printed.
IMAGE_BUILD_SHA=""
if [ "$RESTART_CONTAINER" = "none" ]; then
  IMAGE_BUILD_SHA_SOURCE="skipped — RMD_HEARTBEAT_CONTAINER=none"
elif ! command -v "$RESTART_RUNTIME" >/dev/null 2>&1; then
  IMAGE_BUILD_SHA_SOURCE="unavailable — no ${RESTART_RUNTIME} on this host"
else
  IMAGE_BUILD_SHA_RAW="$("$RESTART_RUNTIME" exec "$RESTART_CONTAINER" cat /etc/rmd-build-sha 2>/dev/null | tr -d '[:space:]')"
  case "$IMAGE_BUILD_SHA_RAW" in
    '')
      IMAGE_BUILD_SHA_SOURCE="unavailable — ${RESTART_RUNTIME} exec ${RESTART_CONTAINER} cat /etc/rmd-build-sha returned nothing"
      ;;
    *[!0-9a-fA-F]*)
      IMAGE_BUILD_SHA_SOURCE="unavailable — ${RESTART_RUNTIME} exec ${RESTART_CONTAINER} cat /etc/rmd-build-sha gave a non-sha value"
      ;;
    *)
      IMAGE_BUILD_SHA="$IMAGE_BUILD_SHA_RAW"
      IMAGE_BUILD_SHA_SOURCE="${RESTART_RUNTIME} exec ${RESTART_CONTAINER} cat /etc/rmd-build-sha"
      ;;
  esac
fi

# ── probe: is automatic gc disabled by a stale .git/gc.log? (W1-T2529) ───────────────────────────
# WHAT THIS CLOSES. git writes `.git/gc.log` when a background `gc --auto` fails, and REFUSES to
# attempt another auto-gc for as long as that file exists — the condition is self-sustaining,
# because the loose objects that made gc fail keep accumulating and gc never runs again to clear
# them. On the fleet host this clone is written by every worker worktree, every prune and every
# fetch, so the object count only goes one way. The ONLY existing signal is a warning
# `git worktree add` prints to STDERR, interleaved with worker output, that the daemon neither
# parses nor publishes.
#
# THIS IS THE SIGNAL, NOT THE CLEANUP. Checking whether the file exists, and reading its own first
# line as the reason, is a one-line existence-and-read probe — the SAME kind of "checkable from
# the beat rather than by shelling in" fact `image_build_sha` (W1-T496) already publishes above.
# NOTHING HERE RUNS `git gc` OR `git prune`, and this probe never shells `git` at all: reading a
# path on disk is enough, and running gc/prune unattended on a live clone several worktrees are
# writing is an operator act with real risk that stays out of scope for a reporter.
#
# THE REASON IS READ, NEVER GUESSED. `gc_disabled_reason` is git's own first line from the file —
# not a fixed string this script made up — so an operator reads the actual root cause git recorded
# without opening a shell on the host. A healthy clone (no gc.log) reports `gc_verdict=ok` and
# `gc_disabled_reason=none`, so the field is never a constant regardless of clone state.
GC_LOG="${INSTALL_DIR}/.git/gc.log"
if [ -e "$GC_LOG" ]; then
  GC_VERDICT="DISABLED — .git/gc.log is present, automatic gc will not run until it is removed"
  GC_DISABLED_REASON="$(head -n 1 "$GC_LOG" 2>/dev/null)"
  [ -n "$GC_DISABLED_REASON" ] || GC_DISABLED_REASON="(gc.log exists but is empty)"
else
  GC_VERDICT="ok"
  GC_DISABLED_REASON="none"
fi

# The gap the MACHINE observed since its own last successful beat. This is what makes the
# watcher's threshold refinable later against a measured distribution instead of intuition — a
# force-pushed single-commit branch keeps no history of its own to measure.
PREV_BEAT_TS=""
if [ -r "$STATE_FILE" ]; then PREV_BEAT_TS="$(head -n 1 "$STATE_FILE" 2>/dev/null)"; fi
PREV_EPOCH="$(epoch_of "$PREV_BEAT_TS")"
SINCE_PREV_S=""
if [ -n "$PREV_EPOCH" ]; then SINCE_PREV_S="$((NOW_EPOCH - PREV_EPOCH))"; fi

# ── the payload ───────────────────────────────────────────────────────────────────────────────
# `key=value`, one per line: greppable, phone-readable, and parseable by the watcher with no jq.
PAYLOAD="$(cat <<EOF
beat_ts=${NOW_ISO}
beat_host=$(hostname 2>/dev/null || printf 'unknown')
daemon_verdict=${DAEMON_VERDICT}
daemon_last_ts=${DAEMON_LAST_TS:-none}
daemon_last_step=${DAEMON_LAST_STEP:-none}
daemon_last_age_s=${DAEMON_AGE_S:-unknown}
daemon_boot_ts=${DAEMON_BOOT_TS:-none}
daemon_boot_age_s=${BOOT_AGE_S:-unknown}
daemon_boot_head_sha=${DAEMON_BOOT_SHA:-none}
supervisor_verdict=${SUPERVISOR_VERDICT}
supervisor_last_ts=${SUPERVISOR_LAST_TS:-none}
supervisor_last_step=${SUPERVISOR_LAST_STEP:-none}
supervisor_source=${SUPERVISOR_SOURCE}
rmd_verdict=${RMD_VERDICT}
tsx_present=${TSX_PRESENT}
node_modules_entries=${NODE_MODULES_ENTRIES}
install_dir=${INSTALL_DIR}
install_head_sha=${INSTALL_SHA}
gc_verdict=${GC_VERDICT}
gc_disabled_reason=${GC_DISABLED_REASON}
config_root=${RMD_ROOT}
config_root_source=${ROOT_SOURCE}
ledger_state=${LEDGER_STATE}
ledger_bytes=${LEDGER_BYTES}
disk_free_kb=${DISK_FREE_KB}
state_fs_device=${STATE_FS_DEVICE}
state_fs_free_kb=${DISK_FREE_KB}
root_fs_device=${ROOT_FS_DEVICE}
root_fs_free_kb=${ROOT_FS_FREE_KB}
disk_min_free_kb=${DISK_MIN_FREE_KB}
prev_beat_ts=${PREV_BEAT_TS:-none}
since_prev_beat_s=${SINCE_PREV_S:-unknown}
restart_source=${RESTART_SOURCE}
image_build_sha_source=${IMAGE_BUILD_SHA_SOURCE}
EOF
)"

# Same absent-never-zero shape as RESTART_COUNT/IMAGE_BUILD_SHA below: `supervisor_source` (in the
# heredoc above) is always present as the diagnosis, and `supervisor_last_age_s` is appended ONLY
# when a `deploy.` line was actually found and its ts parsed — so
# `field(payload, "supervisor_last_age_s") === undefined` is the honest signal that nothing was
# read, never a literal "unknown" sitting in a field a reader might coerce to a number.
if [ -n "$SUPERVISOR_AGE_S" ]; then
  PAYLOAD="${PAYLOAD}
supervisor_last_age_s=${SUPERVISOR_AGE_S}"
fi

# APPENDED, NOT INTERPOLATED WITH A SENTINEL — see the probe's own note above. `restart_source` is
# always present because it is a diagnosis and can never be misread as headroom; the two NUMBERS
# appear only when they were actually read, so `field(payload, "restart_count") === undefined` is
# the honest signal that nothing was measured.
if [ -n "$RESTART_COUNT" ]; then
  PAYLOAD="${PAYLOAD}
restart_container=${RESTART_CONTAINER}
restart_count=${RESTART_COUNT}
restart_max=${RESTART_MAX}
restart_policy=${RESTART_POLICY}"
fi

# Same shape as RESTART_COUNT immediately above: `image_build_sha_source` (in the heredoc) is
# always present as the diagnosis, and `image_build_sha` itself is appended ONLY on a successful,
# validated read — so `field(payload, "image_build_sha") === undefined` is the honest signal that
# nothing was published, never a healthy-looking placeholder.
if [ -n "$IMAGE_BUILD_SHA" ]; then
  PAYLOAD="${PAYLOAD}
image_build_sha=${IMAGE_BUILD_SHA}"
fi

# The subject line IS the phone-readable answer — it is what shows on the branch listing without
# opening anything. Both verdicts ride in it, because the two failures it separates (a dead
# daemon on a healthy host, a broken install on a healthy host) call for different responses.
SUBJECT="heartbeat ${NOW_ISO}: daemon ${DAEMON_VERDICT%% *} | rmd ${RMD_VERDICT%%:*}"

if [ "${RMD_HEARTBEAT_DRY_RUN:-}" = "1" ]; then
  printf '%s\n' "$SUBJECT"
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

# ── publish ───────────────────────────────────────────────────────────────────────────────────
# An explicit identity so an unattended run never dies on an unset user.name/user.email; these are
# process-scoped exports and change nothing in any config file.
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-remudero-heartbeat}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-heartbeat@remudero.invalid}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

fail() {
  printf 'fleet-heartbeat: BEAT NOT PUBLISHED — %s\n' "$1" >&2
  exit 1
}

blob="$(printf '%s\n' "$PAYLOAD" | git -C "$INSTALL_DIR" hash-object -w --stdin 2>/dev/null)" \
  || fail "could not write the payload blob"
[ -n "$blob" ] || fail "hash-object produced no object id"

tree="$(printf '100644 blob %s\t%s\n' "$blob" "$PAYLOAD_FILE" | git -C "$INSTALL_DIR" mktree 2>/dev/null)" \
  || fail "could not build the payload tree"
[ -n "$tree" ] || fail "mktree produced no tree id"

# No `-p`: a parentless root commit, so the force-push below replaces rather than extends.
commit="$(git -C "$INSTALL_DIR" commit-tree "$tree" -m "$SUBJECT" 2>/dev/null)" \
  || fail "could not build the beat commit"
[ -n "$commit" ] || fail "commit-tree produced no commit id"

git -C "$INSTALL_DIR" push --force "$REMOTE" "${commit}:refs/heads/${BRANCH}" >/dev/null 2>&1 \
  || fail "push to ${REMOTE}/${BRANCH} failed"

# Only after a CONFIRMED push, so `since_prev_beat_s` measures published beats rather than
# attempts. Best-effort: a state file that cannot be written must not fail a beat that landed.
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null && printf '%s\n' "$NOW_ISO" > "$STATE_FILE" 2>/dev/null

printf 'fleet-heartbeat: published %s to %s/%s — %s\n' "${commit:0:7}" "$REMOTE" "$BRANCH" "$SUBJECT"
