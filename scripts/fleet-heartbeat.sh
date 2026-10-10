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

# heartbeat-mini is retired. Keep the historical branch readable for incident evidence, but make
# every stale cron/launchd installation a hard no-op before it reads state or invokes git. This is
# intentionally here, rather than only in the installer or watcher: the scheduler is the defect
# surface, and an old scheduler must not be able to publish again after a code update.
if [ "$BRANCH" = "heartbeat-mini" ]; then
  echo "fleet-heartbeat: heartbeat-mini is retired; no write performed." >&2
  exit 0
fi

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

# ── ONE BEAT AT A TIME (W1-T3627) ─────────────────────────────────────────────────────────────
# MEASURED 2026-09-15, on a fleet that was down 75 minutes: this script is the only zgrep caller
# in the tree, it scans LEDGER_UNION_GLOB twice, and on the Azure host that union is 359 files and
# 271 MB. One scan is 7.2s on an idle box — a 2.4% duty cycle at the 5-minute cron cadence, and
# entirely fine. THE COST IS NOT THE DEFECT; THE FEEDBACK LOOP IS. Once anything slows the host a
# scan passes five minutes, cron fires regardless, and two concurrent scans are slower than one,
# so the next overlaps too. The process table at the collapse held 56 CONCURRENT zgreps — roughly
# 28 instances alive at once, none of them finishing — with load 221 on 8 cores and available
# memory FLAT at 0.9 GiB for an hour. Flat, not sawtoothing, because nothing ever completed and
# released.
#
# THE GUARD IS IN THE SCRIPT, SO IT SURVIVES A HOST RE-PROVISION AND COVERS EVERY INVOCATION.
# Not in the crontab: a `flock` in the cron line works, but the crontab is hand-maintained host
# state that no repo file provisions, so a fresh host build (a re-provision) loses it, and it
# protects only that one caller anyway. Guarding the script instead means the guard ships with the
# repo and covers every invocation however it is scheduled — cron, a systemd timer, an operator
# running it by hand.
#
# -n, NEVER -w: a late beat must SKIP, not queue. Queuing is what stacking is.
#
# flock is an FD LOCK, released by the kernel when the holder exits, so a lock FILE left on disk
# never wedges a later beat and there is no stale-lock recovery to get wrong.
#
# RE-ENTRANCY IS READ FROM THE ENVIRONMENT, because `exec` replaces this process and the child has
# no other way to know it already holds the lock. Without the guard this would exec itself forever.
if [ -z "${RMD_HEARTBEAT_LOCK_HELD:-}" ]; then
  HEARTBEAT_LOCK="${RMD_ROOT}/state/heartbeat.lock"
  mkdir -p "${RMD_ROOT}/state" 2>/dev/null || true
  # FAIL OPEN ON A HOST WITHOUT flock (macOS ships none): an unguarded beat is the behaviour that
  # existed before this block, whereas refusing to beat at all would delete the signal entirely.
  if command -v flock >/dev/null 2>&1; then
    export RMD_HEARTBEAT_LOCK_HELD=1
    exec flock -n "$HEARTBEAT_LOCK" "$0" "$@"
  fi
fi

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
# W1-T494: initialised HERE, above the readability guard, so an unreadable ledger publishes
# "unknown" rather than leaving the field unset — the same law the restart/build-sha probes state:
# DEGRADE TO ABSENT, NEVER TO A LITERAL THAT READS AS HEALTHY.
STALE_PIN_SHA=""
STALE_PIN_NEW_SHA=""
STALE_PIN_TS=""
STALE_PIN_VERDICT="unknown — no readable ledger"
TREE_DIRTY="unknown"
STALE_LINE=""
DIRTY_LINE=""
BOOT_EPOCH_FOR_PIN=""
LEDGER_STATE="ok"
if [ ! -r "$LEDGER" ]; then
  LEDGER_STATE="unreadable — no ledger at ${LEDGER}"
else
  # `appendLedger` (src/lib/ledger.ts) serialises `{ ts, ...line }`, so every record begins
  # literally `{"ts":"…"` with no whitespace — that anchor is why one sed extracts the timestamp
  # unambiguously without a JSON parser. A torn or differently-shaped line simply does not match
  # and is skipped, which reads as UNKNOWN rather than as a wrong age.
  # ── THE UNION, NOT THE LIVE FILE (W1-T3227) ─────────────────────────────────────────────────
  # The live ledger STRUCTURALLY CANNOT answer "when did the daemon last poll", and reading it
  # alone produced a five-day-old false STALE on a running fleet. rotateLedger keeps only
  # DECISION_RELEVANT steps (`daemon.poll` and `daemon.sweep.*` are not among them, so they are
  # archived as noise on every rotation) and then bounds the health-windowed ones — `daemon.boot`
  # included — to HEALTH_STEP_RETENTION_WINDOW_MS, fifteen minutes. What survives indefinitely is
  # the handful of daemon ESCALATION steps, so after any rotation the newest `daemon.*` line in
  # the live file is whichever escalation last fired, however old.
  #
  # MEASURED 2026-09-09 on heartbeat-azure: the 05:08 beat read `STALE — last poll 2h34m ago` and
  # the 10:05 beat read `STALE — last poll 123h34m ago`. The last poll moved BACKWARD five days in
  # five hours, which no elapsed time can do; a rotation in between had dropped the recent daemon
  # lines and left `daemon.headroom_reserve.escalated` from Sept 4 as the newest survivor. The
  # watch workflow escalated #4782 on that reading.
  #
  # So this reads all THREE forms, which is CLAUDE.md's standing rule for any ledger question:
  # `state/ledger.ndjson`, the plain rotations, and the gzipped ones. `zgrep` reads plain input
  # transparently, so the fix is the GLOB, never the tool. A form that matches nothing contributes
  # nothing; the union is still whatever the other forms hold.
  LEDGER_UNION_GLOB="${RMD_ROOT}/state/ledger.ndjson ${RMD_ROOT}/state/ledger.*.ndjson ${RMD_ROOT}/state/ledger.*.ndjson.gz"
  ledger_union_grep() {
    # shellcheck disable=SC2086 — the glob is intentional; unmatched patterns fall through and fail
    # into /dev/null per form, which is exactly "this form contributes nothing".
    zgrep -h "$1" $LEDGER_UNION_GLOB 2>/dev/null
  }
  DAEMON_LAST_TS="$(ledger_union_grep '"step":"daemon\.' \
    | sed -n 's/^{"ts":"\([^"]*\)".*/\1/p' | sort | tail -n 1)"
  if [ -n "$DAEMON_LAST_TS" ]; then
    DAEMON_LAST_STEP="$(ledger_union_grep "\"ts\":\"${DAEMON_LAST_TS}\"" \
      | grep -o '"step":"daemon\.[^"]*"' | tail -n 1 | cut -d'"' -f4)"
  fi
  BOOT_LINE="$(ledger_union_grep '"step":"daemon.boot"' | tail -n 1)"
  if [ -n "$BOOT_LINE" ]; then
    DAEMON_BOOT_TS="$(printf '%s' "$BOOT_LINE" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    DAEMON_BOOT_SHA="$(printf '%s' "$BOOT_LINE" | grep -o '"head_sha":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  fi

  # ── probe: the STALE PIN (W1-T494) ───────────────────────────────────────────────────────────
  # THE DAEMON ALREADY WRITES THIS DOWN AND NOTHING READS IT. `daemonFreshnessFromService`
  # (src/lib/self-sync.ts) declines to restart on a DIRTY tree, and that guard is CORRECT — a
  # restart would come back on the same sha, read the same staleness and exit again, which is a
  # crash loop. So the daemon stays up, correctly, running old code, and logs `daemon.stale_code`
  # (carrying BOTH old_sha and new_sha) plus `daemon.tree_dirty`. Neither step appears in any
  # scripts/ or .github/ file, so the condition was invisible from off-host: on the commissioning
  # host `daemon_boot_head_sha` and `install_head_sha` AGREED while both were ten commits behind,
  # because the install itself is what failed to advance. Comparing those two can never catch it.
  #
  # NO FETCH, AND NO rev-list. Both shas are already in the row, so the distance needs no network
  # call and no git plumbing — this reads a file the beat already opens, once more.
  #
  # NOT ADDED TO DECISION_RELEVANT_LEDGER_STEPS, deliberately: `rotateLedger` retains the 200
  # newest lines PER STEP, and this reads the MOST RECENT matching line rather than a COUNT, so
  # archiving cannot change the answer. `ABSENT_REPUSH_CAP` counts and therefore did have to join
  # that list; this does not.
  STALE_LINE="$(grep -F '"step":"daemon.stale_code"' "$LEDGER" 2>/dev/null | tail -n 1)"
  DIRTY_LINE="$(grep -F '"step":"daemon.tree_dirty"' "$LEDGER" 2>/dev/null | tail -n 1)"
  if [ -n "$STALE_LINE" ]; then
    STALE_PIN_TS="$(printf '%s' "$STALE_LINE" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    STALE_PIN_SHA="$(printf '%s' "$STALE_LINE" | grep -o '"old_sha":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    STALE_PIN_NEW_SHA="$(printf '%s' "$STALE_LINE" | grep -o '"new_sha":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  fi
  # A row OLDER than the current boot describes a previous incarnation and must not be reported as
  # the running one — the beat's whole purpose here is to say what THIS process is pinned to.
  STALE_EPOCH="$(epoch_of "$STALE_PIN_TS")"
  DIRTY_TS="$(printf '%s' "$DIRTY_LINE" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  DIRTY_EPOCH="$(epoch_of "$DIRTY_TS")"
  BOOT_EPOCH_FOR_PIN="$(epoch_of "$DAEMON_BOOT_TS")"
  if [ -n "$STALE_EPOCH" ] && [ -n "$BOOT_EPOCH_FOR_PIN" ] && [ "$STALE_EPOCH" -ge "$BOOT_EPOCH_FOR_PIN" ]; then
    STALE_PIN_VERDICT="STALE: running ${STALE_PIN_SHA:-unknown}, origin advanced to ${STALE_PIN_NEW_SHA:-unknown}"
  elif [ -n "$DAEMON_BOOT_TS" ]; then
    STALE_PIN_VERDICT="ok"
  else
    STALE_PIN_VERDICT="unknown — no daemon.boot line to date the pin against"
  fi
  if [ -n "$DIRTY_EPOCH" ] && [ -n "$BOOT_EPOCH_FOR_PIN" ] && [ "$DIRTY_EPOCH" -ge "$BOOT_EPOCH_FOR_PIN" ]; then
    TREE_DIRTY="yes"
  elif [ -n "$DAEMON_BOOT_TS" ]; then
    TREE_DIRTY="no"
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

DISPATCH_LAST_TS=""
DISPATCH_BLOCK_REASON="none"
if [ -f "$LEDGER" ]; then
  DISPATCH_LINE="$(grep -F '"step":"run.start"' "$LEDGER" 2>/dev/null | grep -F '"lane":"run-task"' | tail -n 1)"
  if [ -n "$DISPATCH_LINE" ]; then
    DISPATCH_LAST_TS="$(printf '%s' "$DISPATCH_LINE" | grep -o '"ts":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  fi
  BLOCK_LINE="$(grep -E '"step":"(daemon_selfrestart_for_freshness|daemon\.pause|dispatch\.skipped)"' "$LEDGER" 2>/dev/null | tail -n 1)"
  if [ -n "$BLOCK_LINE" ]; then
    BLOCK_STEP="$(printf '%s' "$BLOCK_LINE" | grep -o '"step":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    BLOCK_WHY="$(printf '%s' "$BLOCK_LINE" | grep -o '"reason":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    DISPATCH_BLOCK_REASON="${BLOCK_STEP}${BLOCK_WHY:+:${BLOCK_WHY}}"
  fi
fi

DISPATCH_LAST_EPOCH="$(epoch_of "$DISPATCH_LAST_TS")"
DISPATCH_AGE_S=""
if [ -n "$DISPATCH_LAST_EPOCH" ]; then DISPATCH_AGE_S="$((NOW_EPOCH - DISPATCH_LAST_EPOCH))"; fi

DISPATCH_STALLED_AFTER_S=21600
if [ "$DAEMON_LAST_STEP" = "daemon.idle_starved.pulse" ] && [ -n "$DAEMON_AGE_S" ] && [ "$DAEMON_AGE_S" -le "$DAEMON_STALE_AFTER_S" ]; then
  DISPATCH_VERDICT="idle_starved — no open PRs or auto-build tasks at last admission"
elif [ -z "$DISPATCH_AGE_S" ]; then
  DISPATCH_VERDICT="unknown"
elif [ "$DISPATCH_AGE_S" -le "$DISPATCH_STALLED_AFTER_S" ]; then
  DISPATCH_VERDICT="building"
else
  DISPATCH_VERDICT="STALLED — last build dispatch $(human_age "$DISPATCH_AGE_S") ago; last block: ${DISPATCH_BLOCK_REASON}"
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

# W1-T5549: THE SCRATCH FILESYSTEM, W1-T2767's REMAINING BLIND SPOT. /mnt/scratch is a third device
# holding every fleet worktree, gate workspace, the read-model, tmp and the 24 GB swapfile; it sat
# at 87-89% on 2026-10-03 while the two readings above stayed green. A full scratch disk halts
# builds AND swap, so it is folded into the minimum like the others.
#
# `RMD_SCRATCH_ROOT` names it (default /mnt/scratch). A host without one publishes `absent` — a
# known state, not a failed read — and folds nothing. A scratch path that exists but cannot be read
# (or answers junk) is `unknown`, which never drags a readable minimum to `unknown` or to 0.
# DEDUPED BY DEVICE: a scratch path on `/` or on the state disk is free space ALREADY counted, so
# its reading is published but not folded a second time. An `unknown` device matches nothing, so a
# numeric reading behind one is still folded — a minimum stays safe either way.
SCRATCH_ROOT="${RMD_SCRATCH_ROOT:-/mnt/scratch}"
if [ -d "$SCRATCH_ROOT" ]; then
  SCRATCH_FS_FREE_KB="$(df_field "$SCRATCH_ROOT" 4)"
  case "$SCRATCH_FS_FREE_KB" in ''|*[!0-9]*) SCRATCH_FS_FREE_KB="unknown" ;; esac
  SCRATCH_FS_DEVICE="$(df_field "$SCRATCH_ROOT" 1)"; [ -n "$SCRATCH_FS_DEVICE" ] || SCRATCH_FS_DEVICE="unknown"
else
  SCRATCH_FS_FREE_KB="absent"; SCRATCH_FS_DEVICE="absent"
fi
SCRATCH_FS_SHARED="no"
if [ "$SCRATCH_FS_DEVICE" != "unknown" ] && { [ "$SCRATCH_FS_DEVICE" = "$ROOT_FS_DEVICE" ] || [ "$SCRATCH_FS_DEVICE" = "$STATE_FS_DEVICE" ]; }; then
  SCRATCH_FS_SHARED="yes"
fi
if [ "$SCRATCH_FS_SHARED" = "no" ]; then
  case "$SCRATCH_FS_FREE_KB" in
    ''|*[!0-9]*) ;;
    *) case "$DISK_MIN_FREE_KB" in
         unknown) DISK_MIN_FREE_KB="$SCRATCH_FS_FREE_KB" ;;
         *) [ "$SCRATCH_FS_FREE_KB" -lt "$DISK_MIN_FREE_KB" ] && DISK_MIN_FREE_KB="$SCRATCH_FS_FREE_KB" ;;
       esac ;;
  esac
fi

# ── probe: swap, inodes, total size, the janitor's last result, consumer sizes (W1-T4804) ──────
# WHY: every host resource this fleet loses (disk, swap, inodes) was seen only AFTER it ran out.
# The gardener (src/lib/host-resource-gardener.ts) fits a trend over these beats, so each value is
# a plain number or the literal `unknown` — NEVER an invented 0. `unknown` swap is not "no swap".
# Numeric check shared by every field below: digits only, else unknown.
num_or_unknown() { case "$1" in ''|*[!0-9]*) printf 'unknown' ;; *) printf '%s' "$1" ;; esac; }

ROOT_FS_TOTAL_KB="$(num_or_unknown "$(df_field / 2)")"

# Free inodes on `/`: the column is found by its HEADER (`IFree` on Linux, `ifree` on macOS) because
# the column position differs between the two. A filesystem that reports no inode table (`-`) is
# `unknown`.
inodes_free() {
  local out
  out="$(df -Pi / 2>/dev/null | awk 'NR==1 {for (i=1;i<=NF;i++) if (tolower($i)=="ifree") c=i} NR==2 && c {print $c}')"
  case "$out" in ''|*[!0-9]*) out="$(df -i / 2>/dev/null | awk 'NR==1 {for (i=1;i<=NF;i++) if (tolower($i)=="ifree") c=i} NR==2 && c {print $c}')" ;; esac
  num_or_unknown "$out"
}
ROOT_FS_INODES_FREE="$(inodes_free)"

# Swap. Linux reads /proc/meminfo; macOS reads `sysctl vm.swapusage` ("total = 7168.00M  used =
# 5427.25M  free = ..."). Both seams are overridable (RMD_MEMINFO, RMD_SYSCTL) so the tests can
# drive the unreadable case on any host.
SWAP_USED_KB="unknown"; SWAP_TOTAL_KB="unknown"
MEMINFO="${RMD_MEMINFO:-/proc/meminfo}"
SYSCTL_BIN="${RMD_SYSCTL:-sysctl}"
if [ -r "$MEMINFO" ]; then
  _swap_total="$(awk '/^SwapTotal:/ {print $2}' "$MEMINFO" 2>/dev/null)"
  _swap_free="$(awk '/^SwapFree:/ {print $2}' "$MEMINFO" 2>/dev/null)"
  case "${_swap_total}${_swap_free}" in
    ''|*[!0-9]*) : ;;
    *)
      if [ -n "$_swap_total" ] && [ -n "$_swap_free" ] && [ "$_swap_free" -le "$_swap_total" ]; then
        SWAP_TOTAL_KB="$_swap_total"; SWAP_USED_KB="$((_swap_total - _swap_free))"
      fi ;;
  esac
elif command -v "$SYSCTL_BIN" >/dev/null 2>&1; then
  _swap_pair="$("$SYSCTL_BIN" -n vm.swapusage 2>/dev/null | awk '
    function kb(v,   n, u) { n = v + 0; u = substr(v, length(v)); if (u == "G") return n * 1048576; if (u == "M") return n * 1024; if (u == "K") return n; return -1 }
    { for (i = 1; i <= NF; i++) { if ($i == "total") t = $(i + 2); if ($i == "used") u2 = $(i + 2) } }
    END { a = kb(t); b = kb(u2); if (t != "" && u2 != "" && a >= 0 && b >= 0) printf "%d %d", a, b }')"
  if [ -n "$_swap_pair" ]; then SWAP_TOTAL_KB="${_swap_pair% *}"; SWAP_USED_KB="${_swap_pair#* }"; fi
fi

# The latest janitor result, from the newest of the logs named in RMD_JANITOR_LOGS (colon-separated
# paths or globs; default: the Azure host's cron log and the Mac's per-account logs). Two shapes:
#   rmd-host-cleanup: / 57% -> 57% (-4 MB reclaimed this pass)      (Azure; before/after are %)
#   janitor (<user>): freed ~0 GB; free space 25 GB -> 10 GB         (Mac)
# A line that matches neither publishes `unknown` — a pass that reclaimed nothing is `0GB`, and an
# unparseable line is never that. The timestamp is the log file's mtime: each pass appends, so it
# is the moment of the last pass.
JANITOR_LOGS="${RMD_JANITOR_LOGS:-${HOME}/host-cleanup.log:/tmp/remudero-janitor-*.log}"
JANITOR_LOG="none"; JANITOR_TS="unknown"; JANITOR_BEFORE="unknown"; JANITOR_AFTER="unknown"; JANITOR_FREED="unknown"
_janitor_files="$(printf '%s\n' "$JANITOR_LOGS" | tr ':' '\n' | while IFS= read -r _pat; do for _f in $_pat; do [ -f "$_f" ] && printf '%s\n' "$_f"; done; done)"
if [ -n "$_janitor_files" ]; then
  _newest="$(printf '%s\n' "$_janitor_files" | while IFS= read -r _f; do printf '%s\t%s\n' "$(stat -c %Y "$_f" 2>/dev/null || stat -f %m "$_f" 2>/dev/null || printf 0)" "$_f"; done | sort -rn | head -n 1)"
  _tab="$(printf '\t')"
  _newest_file="${_newest#*"$_tab"}"; _newest_epoch="${_newest%%"$_tab"*}"
  JANITOR_LOG="$_newest_file"
  _jline="$(grep -E '(rmd-host-cleanup: |janitor \().*->' "$_newest_file" 2>/dev/null | grep -v 'WATCH' | tail -n 1)"
  _jparsed="$(printf '%s\n' "$_jline" | sed -nE \
    -e 's#.*rmd-host-cleanup: [^ ]+ ([0-9]+)% -> ([0-9]+)% [(][-+~]?([0-9.]+) ?([KMGT]?B) reclaimed.*#\1% \2% \3\4#p' \
    -e 's#.*janitor [(][^)]*[)]: freed ~?([0-9.]+) ?([KMGT]?B); free space ([0-9.]+) ?([KMGT]?B) -> ([0-9.]+) ?([KMGT]?B).*#\3\4 \5\6 \1\2#p' | head -n 1)"
  if [ -n "$_jparsed" ]; then
    JANITOR_BEFORE="${_jparsed%% *}"; _jrest="${_jparsed#* }"; JANITOR_AFTER="${_jrest%% *}"; JANITOR_FREED="${_jrest#* }"
    case "$_newest_epoch" in ''|*[!0-9]*|0) : ;; *)
      JANITOR_TS="$(date -u -d "@${_newest_epoch}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "${_newest_epoch}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')" ;;
    esac
  fi
fi

# Sizes (`du -sk`) of the known consumers, every Nth beat only (RMD_CONSUMER_EVERY, default 6) —
# `du` over a worktrees root is not free. Failed scheduled reads publish unknown, never 0.
# The gardener attributes a falling disk to whichever of these grows fastest.
CONSUMER_EVERY="${RMD_CONSUMER_EVERY:-6}"
case "$CONSUMER_EVERY" in ''|*[!0-9]*|0) CONSUMER_EVERY=6 ;; esac
BEAT_N_FILE="${RMD_ROOT}/state/heartbeat-count.txt"
BEAT_N=0
if [ -r "$BEAT_N_FILE" ]; then BEAT_N="$(head -n 1 "$BEAT_N_FILE" 2>/dev/null)"; fi
case "$BEAT_N" in ''|*[!0-9]*) BEAT_N=0 ;; esac
CONSUMER_LINES=""
# A whole filesystem's root reads its used KB from statfs: `du -sk /mnt/rmd` walked every inode at
# the data disk's IOPS cap for minutes (2026-10-09). A bind of a subdirectory still walks.
mount_root_used_kb() {
  [ "$(findmnt -n -o FSROOT -M "$1" 2>/dev/null)" = "/" ] || return 1
  df_field "$1" 3
}
# ionice -c3 is kept for hosts whose block scheduler is BFQ. It is a NO-OP under `none` and
# `mq-deadline` (the Azure host's nvme0n1 reads `[none] mq-deadline`), so it never protects that disk:
# the adaptive schedule below is what keeps the walk off a busy data disk.
du_idle() {
  if command -v ionice >/dev/null 2>&1; then ionice -c3 -t nice -n 19 du -sk "$1"; else nice -n 19 du -sk "$1"; fi
}
consumer_kb() {
  local name="$1" total=0 seen=0 failed=0 p kb device devices="" paths=""
  shift
  for p in "$@"; do
    case "$p" in *'*'*) continue ;; esac
    case "
$paths
" in *"
$p
"*) continue ;; esac
    paths="${paths}
${p}"
    seen=1
    if kb="$(mount_root_used_kb "$p")" && [[ "$kb" =~ ^[0-9]+$ ]]; then
      total=$((total + kb))
    elif kb="$(du_idle "$p" 2>/dev/null | awk 'NR==1 {print $1}')"; then
      case "$kb" in ''|*[!0-9]*) failed=1 ;; *) total=$((total + kb)) ;; esac
    else
      failed=1
    fi
    device="$(df_field "$p" 1)"; [ -n "$device" ] || device="unknown"
    devices="${devices}
${device}"
  done
  if [ "$seen" = 0 ] || [ "$failed" = 1 ]; then total="unknown"; fi
  if [ -z "$devices" ] || [[ "$devices" = *unknown* ]]; then
    devices="unknown"
  else
    devices="$(printf '%s\n' "$devices" | sed '/^$/d' | sort -u | paste -sd, -)"
  fi
  CONSUMER_LINES="${CONSUMER_LINES}
consumer_${name}_kb=${total}
consumer_${name}_device=${devices}"
  return 0
}

live_consumer_path() {
  local path="$1" destination="$2" source
  source="$(printf '%s\n' "$CONSUMER_MOUNTS" | awk -F '\t' -v p="$path" -v d="$destination" '$2==p || $2==d {print $1; exit}')"
  case "$source" in /*) printf '%s' "$source" ;; *) printf '%s' "$path" ;; esac
}
# The walk is due only when the consumers' disks have MOVED: the summed used KB of their distinct
# filesystems (statfs, no walk) drifted from the last walk by more than twice the observed beat-to-beat
# noise, which decays by a quarter each scheduled beat so a one-off swing does not suppress walks for
# long. A falling disk drifts every beat and keeps walking; a quiet one stops paying a multi-minute
# metadata walk at the data disk's IOPS cap (2026-10-09: 94% util ~470 r/s for ~1 min per walk).
# No state, an unreadable signature or a walk older than the backstop always walks.
CONSUMER_STATE_FILE="${RMD_ROOT}/state/consumer-probe.state"
CONSUMER_BACKSTOP_S="${RMD_CONSUMER_BACKSTOP_S:-21600}"
case "$CONSUMER_BACKSTOP_S" in ''|*[!0-9]*) CONSUMER_BACKSTOP_S=21600 ;; esac
consumer_state() { awk -F= -v k="$1" '$1==k {print $2; exit}' "$CONSUMER_STATE_FILE" 2>/dev/null; }
consumer_signature_kb() {
  local root line device used seen="" total=0 any=0
  for root in "$RMD_ROOT" "$HOME" "${TMPDIR:-/tmp}" /mnt/rmd /var/lib/containerd /var/lib/docker; do
    line="$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $1, $3}')" || continue
    device="${line%% *}"; used="${line##* }"
    [ -n "$device" ] && [[ "$used" =~ ^[0-9]+$ ]] || continue
    case " $seen " in *" $device "*) continue ;; esac
    seen="$seen $device"; total=$((total + used)); any=1
  done
  [ "$any" = 1 ] && printf '%s' "$total"
}
CONSUMER_PROBE=""
if [ $((BEAT_N % CONSUMER_EVERY)) -eq 0 ]; then
  CONSUMER_NOW_S="$(date +%s)"
  CONSUMER_USED_KB="$(consumer_signature_kb)"
  WALK_USED_KB="$(consumer_state walk_used_kb)"; WALK_EPOCH="$(consumer_state walk_epoch)"
  PREV_USED_KB="$(consumer_state prev_used_kb)"; NOISE_KB="$(consumer_state noise_kb)"
  CONSUMER_PROBE="walked"
  if [[ "$CONSUMER_USED_KB" =~ ^[0-9]+$ ]] && [[ "$WALK_USED_KB" =~ ^[0-9]+$ ]] && [[ "$WALK_EPOCH" =~ ^[0-9]+$ ]] \
    && [[ "$PREV_USED_KB" =~ ^[0-9]+$ ]] && [[ "$NOISE_KB" =~ ^[0-9]+$ ]]; then
    step=$((CONSUMER_USED_KB - PREV_USED_KB)); step=${step#-}
    decayed=$((NOISE_KB * 3 / 4)); NOISE_KB=$(( step > decayed ? step : decayed ))
    drift=$((CONSUMER_USED_KB - WALK_USED_KB)); drift=${drift#-}
    if [ "$drift" -le $((2 * NOISE_KB)) ] && [ $((CONSUMER_NOW_S - WALK_EPOCH)) -lt "$CONSUMER_BACKSTOP_S" ]; then
      CONSUMER_PROBE="unchanged"
    fi
  else
    NOISE_KB=0
  fi
fi
if [ "$CONSUMER_PROBE" = "walked" ]; then
  CONSUMER_RUNTIME="${RMD_HEARTBEAT_DOCKER:-docker}"
  CONSUMER_MOUNTS="$("$CONSUMER_RUNTIME" inspect "${RMD_HEARTBEAT_CONTAINER:-remudero-daemon}" \
    --format '{{range .Mounts}}{{printf "%s\t%s\n" .Source .Destination}}{{end}}' 2>/dev/null)" || CONSUMER_MOUNTS=""
  LIVE_TMP="$(live_consumer_path "${RMD_ROOT}/tmp" /home/node/Remudero/tmp)"
  consumer_kb worktrees "$(live_consumer_path "${RMD_ROOT}/worktrees" /home/node/Remudero/worktrees)"
  consumer_kb state "${RMD_ROOT}/state"
  if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
    DOCKER_ROOT="$("$CONSUMER_RUNTIME" info --format '{{.DockerRootDir}}' 2>/dev/null)" || DOCKER_ROOT=""
    case "$DOCKER_ROOT" in /*) : ;; *)
      DOCKER_ROOT="$(grep -o '"data-root"[[:space:]]*:[[:space:]]*"[^"]*"' \
        "${RMD_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}" 2>/dev/null | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')" ;;
    esac
    case "$DOCKER_ROOT" in /*) : ;; *) DOCKER_ROOT=/var/lib/docker ;; esac
    consumer_kb docker "$DOCKER_ROOT"
    consumer_kb containerd /var/lib/containerd
    consumer_kb rmd_tmp /mnt/rmd/tmp
    consumer_kb rmd /mnt/rmd
  fi
  CONSUMER_TMP="${TMPDIR:-/tmp}"
  LIVE_SYSTEM_TMP="$(live_consumer_path "$CONSUMER_TMP" /tmp)"
  consumer_kb scratch "$CONSUMER_TMP"/claude* "$LIVE_SYSTEM_TMP"/claude* "$LIVE_TMP"
  consumer_kb coverage "$CONSUMER_TMP"/rmd-c-* "$LIVE_SYSTEM_TMP"/rmd-c-* /mnt/rmd/tmp/rmd-c-* "$LIVE_TMP"/rmd-c-* \
    "$(live_consumer_path "${RMD_ROOT}/.remudero-coverage" /home/node/Remudero/.remudero-coverage)" \
    "$(live_consumer_path "${RMD_ROOT}/repos/.remudero-coverage" /home/node/Remudero/repos/.remudero-coverage)"
  consumer_kb transcripts "${HOME}/.claude/projects" "${HOME}/.codex"
  consumer_kb npm_cache "${HOME}/.npm"
  WALK_USED_KB="$CONSUMER_USED_KB"; WALK_EPOCH="$CONSUMER_NOW_S"
fi
if [ -n "$CONSUMER_PROBE" ]; then
  CONSUMER_LINES="${CONSUMER_LINES}
consumer_walk_state=${CONSUMER_PROBE}
consumer_walk_signature=${CONSUMER_USED_KB:-unknown}"
  if [ "${RMD_HEARTBEAT_DRY_RUN:-}" != "1" ] || [ "${RMD_CONSUMER_STATE_WRITE:-}" = "1" ]; then
    mkdir -p "$(dirname "$CONSUMER_STATE_FILE")" 2>/dev/null && printf 'walk_used_kb=%s\nwalk_epoch=%s\nprev_used_kb=%s\nnoise_kb=%s\n' \
      "${WALK_USED_KB:-}" "${WALK_EPOCH:-}" "${CONSUMER_USED_KB:-}" "${NOISE_KB:-0}" > "$CONSUMER_STATE_FILE" 2>/dev/null
  fi
fi
# The pacing counter advances on every real beat, published or not: advanced only after a confirmed
# push, a failing push left it on a measuring beat and every 5-minute beat re-walked the disks.
if [ "${RMD_HEARTBEAT_DRY_RUN:-}" != "1" ]; then
  mkdir -p "$(dirname "$BEAT_N_FILE")" 2>/dev/null && printf '%s\n' "$((BEAT_N + 1))" > "$BEAT_N_FILE" 2>/dev/null
fi

# ── probe: block-device pressure, as deltas between beats ──────────────────────────────────────
# WHY: on 2026-10-09 the daemon's checkout, node_modules, state and ledger sat on /mnt/rmd, a
# StandardSSD E10 data disk (500 IOPS, no host caching). It ran at 42% util on average with 100 ms
# await, and peaked at 90% and 190 ms. NOTHING in the fleet could see this. `sar` saw it, and only
# when someone thought to ssh in and run it. Free space (above) says nothing about a disk that is
# full of WAITING. So the beat publishes each backing device's own util, await and tps. The
# host-resource gardener (src/lib/host-resource-gardener.ts) tiers a sustained saturation into an
# incident and then an escalation, and names the cgroups that read the most.
#
# DELTAS BETWEEN BEATS: /proc/diskstats and cgroup io.stat are counters since boot. Each beat
# keeps its raw counters in state/heartbeat-io.txt, and the next beat divides the difference by the
# real elapsed seconds. So every number is an average over the beat interval, and the interval is
# published too. A first beat, a counter that went backwards (a reboot, or a container's new
# cgroup) and an unreadable file all publish `unknown` or nothing. None of them publishes a 0.
#
# WHICH DEVICES: the whole disks behind `/`, config.root, the scratch root and every bind mount of
# each running `remudero-*daemon` container. A partition is folded into its disk, because the IOPS
# cap and the cgroup io.stat key both belong to the disk. A path on a non-block filesystem
# (overlay, tmpfs) maps to no device and is skipped.
#
# READ-ONLY AND CHEAP: a handful of small procfs/sysfs reads, one `docker ps`, one `docker inspect`
# and one `findmnt` per distinct path. Nothing walks a filesystem.
#
# Seams for the fixtures: RMD_DISKSTATS, RMD_SYS_DEV_BLOCK, RMD_CGROUP_ROOT.
IO_DISKSTATS="${RMD_DISKSTATS:-/proc/diskstats}"
IO_SYS_DEV_BLOCK="${RMD_SYS_DEV_BLOCK:-/sys/dev/block}"
IO_CGROUP_ROOT="${RMD_CGROUP_ROOT:-/sys/fs/cgroup}"
IO_STATE_FILE="${RMD_ROOT}/state/heartbeat-io.txt"
IO_LINES=""
if [ -r "$IO_DISKSTATS" ] && command -v findmnt >/dev/null 2>&1; then
  IO_RUNTIME="${RMD_HEARTBEAT_DOCKER:-docker}"
  IO_CONTAINERS="$("$IO_RUNTIME" ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null)" || IO_CONTAINERS=""
  IO_DAEMONS="$(printf '%s\n' "$IO_CONTAINERS" | awk 'NF == 2 && $2 ~ /^remudero-.*daemon$/ {print $2}')"
  IO_ROLE_PATHS="$(printf 'root\t/\nstate\t%s\nscratch\t%s\n' "$RMD_ROOT" "$SCRATCH_ROOT")"
  if [ -n "$IO_DAEMONS" ]; then
    # shellcheck disable=SC2086 # one argument per container name, by design
    _io_mounts="$("$IO_RUNTIME" inspect $IO_DAEMONS --format '{{range .Mounts}}{{printf "%s\n" .Source}}{{end}}' 2>/dev/null)" || _io_mounts=""
    IO_ROLE_PATHS="${IO_ROLE_PATHS}
$(printf '%s\n' "$_io_mounts" | awk 'NF && !seen[$0]++ {print "daemon\t" $0}')"
  fi
  # path -> whole-disk major:minor, one `findmnt` per distinct path.
  IO_DEV_ROLES=""
  _tab="$(printf '\t')"
  while IFS="$_tab" read -r _role _path; do
    [ -n "$_path" ] || continue
    _mm="$(findmnt -n -o MAJ:MIN -T "$_path" 2>/dev/null | head -n 1 | tr -d ' ')"
    case "$_mm" in *:*) : ;; *) continue ;; esac
    [ -e "$IO_SYS_DEV_BLOCK/$_mm" ] || continue
    if [ -e "$IO_SYS_DEV_BLOCK/$_mm/partition" ]; then
      _mm="$(cd -P "$IO_SYS_DEV_BLOCK/$_mm/.." 2>/dev/null && cat dev 2>/dev/null | tr -d ' ')"
      case "$_mm" in *:*) : ;; *) continue ;; esac
    fi
    IO_DEV_ROLES="${IO_DEV_ROLES}${_mm} ${_role}
"
  done <<EOF_IO_PATHS
$IO_ROLE_PATHS
EOF_IO_PATHS

  if [ -n "$IO_DEV_ROLES" ]; then
    _io_now="$(mktemp "${TMPDIR:-/tmp}/rmd-heartbeat-io.XXXXXX" 2>/dev/null)" || _io_now=""
  else
    _io_now=""
  fi
  if [ -n "$_io_now" ]; then
    {
      printf 'epoch %s\n' "$NOW_EPOCH"
      printf '%s' "$IO_DEV_ROLES" | awk 'NF == 2 {print "role", $1, $2}'
      # disk <mm> <name> <reads> <writes> <read ms> <write ms> <io ticks ms>
      printf '%s' "$IO_DEV_ROLES" | awk -v f="$IO_DISKSTATS" '
        NF == 2 { want[$1] = 1 }
        END { while ((getline line < f) > 0) { n = split(line, a, " "); if (n >= 13 && ((a[1] ":" a[2]) in want)) print "disk", a[1] ":" a[2], a[3], a[4], a[8], a[7], a[11], a[13] } }'
      # cg <cgroup dir> <label> <mm> <rbytes> <wbytes> <rios> <wios>
      for _io_stat in "$IO_CGROUP_ROOT"/*.slice/*/io.stat "$IO_CGROUP_ROOT"/*.scope/io.stat; do
        [ -r "$_io_stat" ] || continue
        _io_dir="$(basename "$(dirname "$_io_stat")")"
        _io_label="$_io_dir"
        case "$_io_dir" in
          docker-*.scope)
            _io_id="${_io_dir#docker-}"; _io_id="${_io_id%.scope}"
            _io_name="$(printf '%s\n' "$IO_CONTAINERS" | awk -v id="$_io_id" '$1 == id {print $2; exit}')"
            if [ -n "$_io_name" ]; then _io_label="$_io_name"; else _io_label="docker-$(printf '%s' "$_io_id" | cut -c1-12)"; fi ;;
        esac
        _io_label="$(printf '%s' "$_io_label" | tr -c 'A-Za-z0-9_.-' '_')"
        awk -v dir="$_io_dir" -v label="$_io_label" '
          { rb = wb = ri = wi = ""
            for (i = 2; i <= NF; i++) { split($i, kv, "="); if (kv[1] == "rbytes") rb = kv[2]; else if (kv[1] == "wbytes") wb = kv[2]; else if (kv[1] == "rios") ri = kv[2]; else if (kv[1] == "wios") wi = kv[2] }
            if (rb != "" && wb != "" && ri != "" && wi != "") print "cg", dir, label, $1, rb, wb, ri, wi }' "$_io_stat" 2>/dev/null
      done
    } > "$_io_now"

    IO_PREV="$IO_STATE_FILE"; [ -r "$IO_PREV" ] || IO_PREV=/dev/null
    # One pass over (previous, current). Rates: util = busy ms / elapsed ms, await = (read ms +
    # write ms) / completed ios, tps = completed ios / s. Top readers by read bytes per device.
    _io_rows="$(awk -v daemons=" $(printf '%s' "$IO_DAEMONS" | tr '\n' ' ') " '
      function r1(x) { return sprintf("%.1f", x) }
      FILENAME == ARGV[1] {
        if ($1 == "epoch") pe = $2
        else if ($1 == "disk") { pr[$2] = $4; pw[$2] = $5; prm[$2] = $6; pwm[$2] = $7; pt[$2] = $8 }
        else if ($1 == "cg") { k = $2 SUBSEP $4; prb[k] = $5; pwb[k] = $6; pri[k] = $7; pwi[k] = $8; pseen[k] = 1 }
        next
      }
      $1 == "epoch" { ce = $2; dt = (pe != "" && ce > pe) ? ce - pe : 0; next }
      $1 == "role" { if (!((($2) SUBSEP ($3)) in rs)) { rs[$2 SUBSEP $3] = 1; roles[$2] = (roles[$2] == "" ? $3 : roles[$2] "," $3) }; next }
      $1 == "disk" {
        name[$2] = $3; devs = (devs == "" ? $3 : devs "," $3)
        print "L", "io_" $3 "_roles=" roles[$2]
        dr = $4 - pr[$2]; dw = $5 - pw[$2]; dms = ($6 - prm[$2]) + ($7 - pwm[$2]); dtk = $8 - pt[$2]
        if (dt > 0 && ($2 in pt) && dr >= 0 && dw >= 0 && dms >= 0 && dtk >= 0) {
          u = dtk / (dt * 10); if (u > 100) u = 100
          ios = dr + dw
          print "L", "io_" $3 "_util_pct=" sprintf("%d", u + 0.5)
          print "L", "io_" $3 "_await_ms=" (ios > 0 ? r1(dms / ios) : "0.0")
          print "L", "io_" $3 "_tps=" r1(ios / dt)
        } else {
          print "L", "io_" $3 "_util_pct=unknown"
        }
        next
      }
      $1 == "cg" {
        k = $2 SUBSEP $4
        if (dt <= 0 || !(k in pseen) || !($4 in name)) next
        drb = $5 - prb[k]; dwb = $6 - pwb[k]; dri = $7 - pri[k]; dwi = $8 - pwi[k]
        if (drb < 0 || dwb < 0 || dri < 0 || dwi < 0) next
        if (drb > 0) print "R", name[$4], $3, sprintf("%d", drb / dt + 0.5), r1(dri / dt)
        if (index(daemons, " " $3 " ") > 0)
          print "L", "io_cg_" $3 "_" name[$4] "=rbps=" sprintf("%d", drb / dt + 0.5) " wbps=" sprintf("%d", dwb / dt + 0.5) " riops=" r1(dri / dt) " wiops=" r1(dwi / dt)
        next
      }
      END {
        print "L", "io_devices=" devs
        print "L", "io_interval_s=" (dt > 0 ? dt : "unknown")
      }' "$IO_PREV" "$_io_now" 2>/dev/null)"
    IO_LINES="$(printf '%s\n' "$_io_rows" | awk '$1 == "L" {sub(/^L /, ""); print}')"
    _io_readers="$(printf '%s\n' "$_io_rows" | awk '$1 == "R"' | sort -k4,4nr | awk '
      { if (++n[$2] <= 5) top[$2] = (top[$2] == "" ? "" : top[$2] ",") $3 ":" $4 ":" $5 }
      END { for (d in top) print "io_" d "_readers=" top[d] }' | sort)"
    [ -n "$_io_readers" ] && IO_LINES="${IO_LINES}
${_io_readers}"
    if [ "${RMD_HEARTBEAT_DRY_RUN:-}" != "1" ]; then
      mkdir -p "$(dirname "$IO_STATE_FILE")" 2>/dev/null && mv -f "$_io_now" "$IO_STATE_FILE" 2>/dev/null
    fi
    rm -f "$_io_now" 2>/dev/null
  fi
fi
[ -n "$IO_LINES" ] || IO_LINES="io_source=unreadable"

# ── probe: each daemon container's memory.high and the tuner's last word (deltas between beats) ──
# WHY: deploy/memory-high-tuner.sh (#10486) moves each daemon's memory.high, visible until now only in
# archived ledger rows and the launcher journal. On 2026-10-10 core sat AT its ceiling (8379 MiB = 95%
# of its 8820 MiB memory.max) still refaulting ~1 GB of page cache per 5 min. Per daemon container:
#   mem_<c>_high_mib / _max_mib       the live cgroup memory.high and memory.max (`max` = no limit)
#   mem_<c>_policy_high_mib           the policy floor: the tuner's recorded policy_mib, else the
#                                     launch annotation (no learned value existed at launch), with
#                                     mem_<c>_policy_source naming which
#   mem_<c>_current_mib / _anon_mib / _file_mib    memory.current and memory.stat anon / file
#   mem_<c>_high_events_delta         memory.events `high` over the beat (mem_interval_s)
#   mem_<c>_refault_file_pages_delta  memory.stat workingset_refault_file over the beat (pages)
#   mem_<c>_tuner_action/_reason/_ts  the tuner's last adjustment, from <its instance's state_dir,
#                                     as the launchers resolve the registry>/state/memory-high-tuned-<c>.json,
#                                     else that ledger's row; `none` only when live high is not above policy.
# A first beat, a recycled container (new cgroup, counters from zero) or a counter that went
# backwards publishes `unknown` for the deltas; any unreadable file publishes `unknown`. Never 0.
#
# READ-ONLY AND CHEAP: one `docker ps`, one `docker inspect`, a few small cgroup files per container
# and one bounded tail of the ledger. Nothing walks a filesystem.
#
# Seams for the fixtures: RMD_CGROUP_ROOT, RMD_HEARTBEAT_DOCKER, RMD_INSTANCE_REGISTRY.
MEM_REGISTRY="${RMD_INSTANCE_REGISTRY:-${INSTALL_DIR}/.remudero/daemon-instances.yaml}"
MEM_CGROUP_ROOT="${RMD_CGROUP_ROOT:-/sys/fs/cgroup}"
MEM_STATE_FILE="${RMD_ROOT}/state/heartbeat-mem.txt"
MEM_LINES=""
MEM_RUNTIME="${RMD_HEARTBEAT_DOCKER:-docker}"
MEM_CONTAINERS="$("$MEM_RUNTIME" ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null | awk 'NF == 2 && $2 ~ /^remudero-.*daemon$/')" || MEM_CONTAINERS=""
if [ -n "$MEM_CONTAINERS" ]; then
  # name -> the MemoryHigh annotation the launcher started it with ("uint64 <bytes>").
  # shellcheck disable=SC2046 # one argument per container name, by design
  MEM_ANNOTATIONS="$("$MEM_RUNTIME" inspect $(printf '%s\n' "$MEM_CONTAINERS" | awk '{print $2}') \
    --format '{{.Name}} {{index .HostConfig.Annotations "org.systemd.property.MemoryHigh"}}' 2>/dev/null)" || MEM_ANNOTATIONS=""
  MEM_STATE_DIRS="$(awk '{ sub(/[[:space:]]+#.*/, "") } /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { if (c != "" && d != "") print c, d; c = d = ""; next }
    /^    container_name:/ { c = $2; gsub(/"/, "", c) } /^    state_dir:/ { d = $2; gsub(/"/, "", d) }
    END { if (c != "" && d != "") print c, d }' "$MEM_REGISTRY" 2>/dev/null)" # container_name state_dir, recycle-container.sh's grammar
  MEM_PREV_EPOCH=""; MEM_PREV=""
  if [ -r "$MEM_STATE_FILE" ]; then
    MEM_PREV_EPOCH="$(awk '$1 == "epoch" {print $2; exit}' "$MEM_STATE_FILE" 2>/dev/null)"
    MEM_PREV="$(awk '$1 == "cg"' "$MEM_STATE_FILE" 2>/dev/null)"
  fi
  MEM_DT=""
  case "$MEM_PREV_EPOCH" in ''|*[!0-9]*) : ;; *) [ "$NOW_EPOCH" -gt "$MEM_PREV_EPOCH" ] && MEM_DT=$((NOW_EPOCH - MEM_PREV_EPOCH)) ;; esac
  MEM_SNAPSHOT="epoch ${NOW_EPOCH}"
  mem_mib() { case "$1" in max) printf 'max' ;; ''|*[!0-9]*) printf 'unknown' ;; *) printf '%s' $(($1 / 1048576)) ;; esac; }
  mem_num() { case "$1" in ''|*[!0-9]*) printf 'unknown' ;; *) printf '%s' "$1" ;; esac; }
  mem_one_line() { printf '%s' "$1" | tr '\n\r' '  ' | cut -c1-400; }
  while read -r _mem_id _mem_name; do
    [ -n "$_mem_name" ] || continue
    _mem_cg=""
    for _d in "$MEM_CGROUP_ROOT/system.slice/docker-${_mem_id}.scope" "$MEM_CGROUP_ROOT/docker/${_mem_id}"; do
      [ -r "$_d/memory.high" ] && { _mem_cg="$_d"; break; }
    done
    _mem_high=""; _mem_max=""; _mem_cur=""; _mem_anon=""; _mem_file=""; _mem_ev=""; _mem_rf=""
    if [ -n "$_mem_cg" ]; then
      _mem_high="$(cat "$_mem_cg/memory.high" 2>/dev/null)"
      _mem_max="$(cat "$_mem_cg/memory.max" 2>/dev/null)"
      _mem_cur="$(cat "$_mem_cg/memory.current" 2>/dev/null)"
      _mem_ev="$(awk '$1 == "high" {print $2; exit}' "$_mem_cg/memory.events" 2>/dev/null)"
      read -r _mem_anon _mem_file _mem_rf <<EOF_MEM_STAT
$(awk '$1 == "anon" {a = $2} $1 == "file" {f = $2} $1 == "workingset_refault_file" {r = $2}
       END {print (a == "" ? "-" : a), (f == "" ? "-" : f), (r == "" ? "-" : r)}' "$_mem_cg/memory.stat" 2>/dev/null)
EOF_MEM_STAT
    fi
    _mem_ev="$(mem_num "$_mem_ev")"; _mem_rf="$(mem_num "$_mem_rf")"
    MEM_LINES="${MEM_LINES}
mem_${_mem_name}_high_mib=$(mem_mib "$_mem_high")
mem_${_mem_name}_max_mib=$(mem_mib "$_mem_max")
mem_${_mem_name}_current_mib=$(mem_mib "$_mem_cur")
mem_${_mem_name}_anon_mib=$(mem_mib "$_mem_anon")
mem_${_mem_name}_file_mib=$(mem_mib "$_mem_file")"
    # Deltas only against the SAME container id: a recycle starts its counters from zero.
    _mem_dev="unknown"; _mem_drf="unknown"
    _mem_prev_line="$(printf '%s\n' "$MEM_PREV" | awk -v n="$_mem_name" -v id="$_mem_id" '$2 == n && $3 == id {print; exit}')"
    if [ -n "$MEM_DT" ] && [ -n "$_mem_prev_line" ]; then
      read -r _ _ _ _mem_pev _mem_prf <<EOF_MEM_PREV
$_mem_prev_line
EOF_MEM_PREV
      if [ "$_mem_ev" != unknown ] && [ "$(mem_num "$_mem_pev")" != unknown ] && [ "$_mem_ev" -ge "$_mem_pev" ]; then _mem_dev=$((_mem_ev - _mem_pev)); fi
      if [ "$_mem_rf" != unknown ] && [ "$(mem_num "$_mem_prf")" != unknown ] && [ "$_mem_rf" -ge "$_mem_prf" ]; then _mem_drf=$((_mem_rf - _mem_prf)); fi
    fi
    [ "$_mem_ev" != unknown ] && [ "$_mem_rf" != unknown ] && MEM_SNAPSHOT="${MEM_SNAPSHOT}
cg ${_mem_name} ${_mem_id} ${_mem_ev} ${_mem_rf}"
    # The tuner's word: its state file first (written with every adjustment), else the latest ledger row.
    _mem_root="$(printf '%s\n' "$MEM_STATE_DIRS" | awk -v n="$_mem_name" '$1 == n {print $2; exit}')"
    _mem_tuned="${_mem_root:-$RMD_ROOT}/state/memory-high-tuned-${_mem_name}.json"
    _mem_ledger="${_mem_root:-$RMD_ROOT}/state/ledger.ndjson"
    _mem_policy="unknown"; _mem_policy_src="unknown"; _mem_act="none"; _mem_why="none"; _mem_ts="none"
    if [ -r "$_mem_tuned" ] && grep -q "\"container\":\"${_mem_name}\"" "$_mem_tuned" 2>/dev/null; then
      _mem_policy="$(mem_num "$(sed -n 's/.*"policy_mib":\([0-9][0-9]*\).*/\1/p' "$_mem_tuned" 2>/dev/null | head -n 1)")"
      [ "$_mem_policy" = unknown ] || _mem_policy_src="tuned_state"
      _mem_ts="$(sed -n 's/.*"updated_at":"\([^"]*\)".*/\1/p' "$_mem_tuned" 2>/dev/null | head -n 1)"
      _mem_why="$(sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' "$_mem_tuned" 2>/dev/null | head -n 1)"
      # mht_record writes the reason as "<action>: <why>".
      case "$_mem_why" in grow:*|shrink:*|restore:*|floor:*) _mem_act="${_mem_why%%:*}"; _mem_why="${_mem_why#*: }" ;; *) _mem_act="unknown" ;; esac
    elif [ -r "$_mem_ledger" ]; then
      _mem_row="$(tail -c 4000000 "$_mem_ledger" 2>/dev/null | grep -F '"step":"host.memory_high.adjusted"' | grep -F "\"container\":\"${_mem_name}\"" | tail -n 1)"
      if [ -n "$_mem_row" ]; then
        _mem_act="$(printf '%s' "$_mem_row" | sed -n 's/.*"action":"\([a-z]*\)".*/\1/p')"; [ -n "$_mem_act" ] || _mem_act="unknown"
        _mem_ts="$(printf '%s' "$_mem_row" | sed -n 's/^{"ts":"\([^"]*\)".*/\1/p')"
        _mem_why="$(printf '%s' "$_mem_row" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p')"
        _mem_policy="$(mem_num "$(printf '%s' "$_mem_row" | sed -n 's/.*"policy_mib":\([0-9][0-9]*\).*/\1/p')")"
        [ "$_mem_policy" = unknown ] || _mem_policy_src="ledger"
      fi
    fi
    if [ "$_mem_policy" = unknown ]; then
      # Never tuned: the launcher started it at the policy value, which rides as its annotation.
      _mem_ann="$(printf '%s\n' "$MEM_ANNOTATIONS" | awk -v n="/${_mem_name}" '$1 == n && $NF ~ /^[0-9]+$/ {print $NF; exit}')"
      if [ -n "$_mem_ann" ]; then _mem_policy="$(mem_mib "$_mem_ann")"; _mem_policy_src="launch_annotation"; fi
    fi
    _mem_live="$(mem_mib "$_mem_high")"
    if [ "$_mem_act" = none ] && { [ "$_mem_policy" = unknown ] || [ "$_mem_live" = unknown ] || [ "$_mem_live" = max ] || [ "$_mem_live" -gt "$_mem_policy" ] 2>/dev/null; }; then
      _mem_act="unknown"; _mem_why="unknown"; _mem_ts="unknown" # above policy (or unmeasured) with no record found
    fi
    MEM_LINES="${MEM_LINES}
mem_${_mem_name}_policy_high_mib=${_mem_policy}
mem_${_mem_name}_policy_source=${_mem_policy_src}
mem_${_mem_name}_high_events_delta=${_mem_dev}
mem_${_mem_name}_refault_file_pages_delta=${_mem_drf}
mem_${_mem_name}_tuner_action=${_mem_act}
mem_${_mem_name}_tuner_ts=${_mem_ts:-unknown}
mem_${_mem_name}_tuner_reason=$(mem_one_line "${_mem_why:-unknown}")"
  done <<EOF_MEM_CONTAINERS
$MEM_CONTAINERS
EOF_MEM_CONTAINERS
  MEM_LINES="mem_containers=$(printf '%s\n' "$MEM_CONTAINERS" | awk '{print $2}' | paste -sd, -)
mem_interval_s=${MEM_DT:-unknown}${MEM_LINES}"
  if [ "${RMD_HEARTBEAT_DRY_RUN:-}" != "1" ]; then
    mkdir -p "$(dirname "$MEM_STATE_FILE")" 2>/dev/null && printf '%s\n' "$MEM_SNAPSHOT" > "${MEM_STATE_FILE}.tmp.$$" 2>/dev/null &&
      mv -f "${MEM_STATE_FILE}.tmp.$$" "$MEM_STATE_FILE" 2>/dev/null
  fi
fi
[ -n "$MEM_LINES" ] || MEM_LINES="mem_source=unreadable"

LEDGER_BYTES="unknown"
if [ -r "$LEDGER" ]; then
  LEDGER_BYTES="$(wc -c < "$LEDGER" 2>/dev/null | tr -d ' ')"
fi

INSTALL_SHA="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null)"
[ -n "$INSTALL_SHA" ] || INSTALL_SHA="unknown"

# ── probe: the container restart budget (W1-T483) ─────────────────────────────────────────────
# THIS WAS PUBLISHED AS AN EARLY WARNING ONLY, UNTIL W1-T3411. Docker's `--restart=on-failure:N`
# caps the COUNT of automatic restarts for a container instance, and nothing restores it: measured
# on this host with three throwaway containers, a container that ran healthily for twenty
# seconds — and one that ran for two full minutes, twice — still reached the cap and stayed
# exited. Every non-zero exit spends one, and `daemonExitCode` (src/lib/daemon.ts) returns
# non-zero for a routine freshness restart as well as for a crash, so a HEALTHY, MERGING fleet
# empties the budget as fast as it merges. When it empties the container stops for good and
# nothing brings it back.
# W1-T3411: A STOPPED-BUT-NOT-REMOVED CONTAINER IS STILL INSPECTABLE, SO THE READ SURVIVES THE
# STOP TOO. The original note here claimed the budget could never be reported once the container
# was down, on the theory that "there is nothing left to inspect" — false: `docker` does not
# remove a container's own record on exit (only `docker rm` does that, or `--rm`, which Docker
# refuses to combine with a restart policy at all), so `RestartCount` and `.State.Status` both
# keep answering for an exited container exactly as they did for a running one. What is genuinely
# true is that THIS SCRIPT reads them from the HOST (see the file header), never from inside the
# container, which is what makes the reading independent of whatever state the daemon is in.
# `restart_verdict` below is the reader this task adds: `ok` while under budget, `AT_LIMIT` when
# the count has reached the cap but the container is still `running` (one more non-zero exit away
# from stranded), `STOPPED_RETRY_EXHAUSTED` once it is both at cap AND no longer running — the
# fleet-down case with no ledger row and no process left to write one — and `unlimited`/`unknown`
# for an uncapped policy or a failed read, exactly mirroring the numeric fields' own cases below.
# AND IT DEGRADES TO ABSENT, NEVER TO ZERO. A `restart_count=0` means "the whole budget is
# untouched" — the most reassuring value in the field's range — so a read that FAILED must never
# produce it. On a host with no docker, or where the inspect fails, the numeric fields are OMITTED
# ENTIRELY and only `restart_source` is written, carrying the reason. This is the law this repo has
# corrected seven times, applied to a field whose failure direction is unusually dangerous.
# `restart_verdict` cannot be omitted the same way — a MISSING field is a worse UI than a wrong
# one for something meant to be read at a glance — so it degrades to the WORD `unknown` instead,
# which reads as "no reading", never as "ok".
RESTART_CONTAINER="${RMD_HEARTBEAT_CONTAINER:-remudero-daemon}"
# The runtime is a NAME, not a hardcoded call, for two reasons that are not about testing: a host
# may keep it off the default PATH, and a podman-based host answers the identical `inspect
# --format` contract. Overriding it to a path that does not exist is also the only honest way to
# exercise the no-runtime branch, since `command -v docker` would otherwise find the real one.
RESTART_RUNTIME="${RMD_HEARTBEAT_DOCKER:-docker}"
RESTART_COUNT=""
RESTART_MAX=""
RESTART_POLICY=""
RESTART_VERDICT="unknown"
if [ "$RESTART_CONTAINER" = "none" ]; then
  RESTART_SOURCE="skipped — RMD_HEARTBEAT_CONTAINER=none"
  RESTART_VERDICT="skipped"
elif ! command -v "$RESTART_RUNTIME" >/dev/null 2>&1; then
  RESTART_SOURCE="unavailable — no ${RESTART_RUNTIME} on this host"
else
  RESTART_RAW="$("$RESTART_RUNTIME" inspect "$RESTART_CONTAINER" \
    --format '{{.RestartCount}} {{.HostConfig.RestartPolicy.MaximumRetryCount}} {{.HostConfig.RestartPolicy.Name}} {{.State.Status}}' \
    2>/dev/null)"
  if [ -z "$RESTART_RAW" ]; then
    RESTART_SOURCE="unavailable — ${RESTART_RUNTIME} inspect ${RESTART_CONTAINER} returned nothing"
  else
    read -r RESTART_COUNT RESTART_MAX RESTART_POLICY RESTART_STATE <<<"$RESTART_RAW"
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
        # means — so an uncapped policy says so in words, and the verdict agrees with it.
        if [ "$RESTART_POLICY" != "on-failure" ] || [ "$RESTART_MAX" = "0" ]; then
          RESTART_VERDICT="unlimited"
          RESTART_MAX="unlimited"
        elif [ "$RESTART_COUNT" -ge "$RESTART_MAX" ]; then
          # AT OR OVER THE CAP. `.State.Status` is the only remaining thing that tells "still up,
          # one crash from stranded" apart from "already down, and Docker will not try again" —
          # the silent-fleet-retirement case this task exists for. A status that came back empty
          # or unrecognised is treated as NOT running, same absent-never-reassuring law as above:
          # the alarming reading is the safe default, never the reassuring one.
          if [ "$RESTART_STATE" = "running" ]; then
            RESTART_VERDICT="AT_LIMIT"
          else
            RESTART_VERDICT="STOPPED_RETRY_EXHAUSTED"
          fi
        else
          RESTART_VERDICT="ok"
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

# W1-T5319: read the refresh receipt without requiring node or jq on a damaged host.
acr_login_field() {
  printf '%s\n' "$ACR_LOGIN_RECEIPT" |
    sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" |
    awk '{
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "\\") {
          c = substr($0, ++i, 1)
          if (c ~ /^[nrtbf]$/) c = " "
        }
        printf "%s", c
      }
      print ""
    }' | head -n 1
}
ACR_LOGIN_RESULT=unavailable
ACR_LOGIN_TS=""
ACR_LOGIN_REASON="the Azure CLI is not installed on this host"
ACR_LOGIN_REGISTRY=""
if command -v az >/dev/null 2>&1; then
  ACR_LOGIN_RECEIPT="$(cat "${RMD_ROOT}/state/acr-login.json" 2>/dev/null)"
  ACR_LOGIN_RESULT="$(acr_login_field result)"
  case "$ACR_LOGIN_RESULT" in
    ok|failed|unavailable)
      ACR_LOGIN_TS="$(acr_login_field ts)"
      ACR_LOGIN_REASON="$(acr_login_field reason)"
      ACR_LOGIN_REGISTRY="$(acr_login_field registry)"
      ;;
    *) ACR_LOGIN_RESULT=unknown; ACR_LOGIN_REASON="no readable registry refresh result" ;;
  esac
fi

BACKUP_RECEIPT="${RMD_STATE_SNAPSHOT_RECEIPT:-${XDG_STATE_HOME:-$HOME/.local/state}/remudero/state-snapshot.receipt}"
BACKUP_VERDICT="unknown — no snapshot receipt"
BACKUP_TS=""
BACKUP_OFFHOST=unknown
BACKUP_RESULT=""
BACKUP_REASON=""
if [ -f "$BACKUP_RECEIPT" ]; then
  if BACKUP_CONTENT="$(cat "$BACKUP_RECEIPT" 2>/dev/null)"; then
    while IFS='=' read -r backup_key backup_value; do
      case "$backup_key" in
        result) BACKUP_RESULT="$backup_value" ;;
        ts) BACKUP_TS="$backup_value" ;;
        offhost) BACKUP_OFFHOST="$backup_value" ;;
        reason) BACKUP_REASON="$backup_value" ;;
      esac
    done <<<"$BACKUP_CONTENT"
  fi
  BACKUP_VERDICT="unknown — unreadable snapshot receipt"
  BACKUP_EPOCH="$(epoch_of "$BACKUP_TS")"
  case "$BACKUP_RESULT:$BACKUP_OFFHOST" in
    ok:ok|ok:not-configured|failed:ok|failed:failed|failed:not-configured)
      if [ -n "$BACKUP_EPOCH" ] && [ "$BACKUP_EPOCH" -le "$NOW_EPOCH" ]; then
        BACKUP_AGE_S=$((NOW_EPOCH - BACKUP_EPOCH))
        if [ "$BACKUP_AGE_S" -gt 93600 ]; then
          BACKUP_VERDICT="STALE — last nightly snapshot run $(human_age "$BACKUP_AGE_S") ago"
        elif [ "$BACKUP_RESULT" = failed ]; then
          BACKUP_VERDICT="FAILED: ${BACKUP_REASON:-nightly snapshot failed without a reason}"
        else
          BACKUP_VERDICT=ok
        fi
      fi
      ;;
  esac
fi

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
stale_pin_verdict=${STALE_PIN_VERDICT}
stale_pin_sha=${STALE_PIN_SHA:-none}
stale_pin_new_sha=${STALE_PIN_NEW_SHA:-none}
stale_pin_ts=${STALE_PIN_TS:-none}
tree_dirty=${TREE_DIRTY}
dispatch_verdict=${DISPATCH_VERDICT}
dispatch_last_ts=${DISPATCH_LAST_TS:-none}
dispatch_last_age_s=${DISPATCH_AGE_S:-unknown}
dispatch_block_reason=${DISPATCH_BLOCK_REASON}
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
scratch_fs_device=${SCRATCH_FS_DEVICE}
scratch_fs_free_kb=${SCRATCH_FS_FREE_KB}
disk_min_free_kb=${DISK_MIN_FREE_KB}
root_fs_total_kb=${ROOT_FS_TOTAL_KB}
root_fs_inodes_free=${ROOT_FS_INODES_FREE}
swap_used_kb=${SWAP_USED_KB}
swap_total_kb=${SWAP_TOTAL_KB}
janitor_log=${JANITOR_LOG}
janitor_last_ts=${JANITOR_TS}
janitor_last_before=${JANITOR_BEFORE}
janitor_last_after=${JANITOR_AFTER}
janitor_last_freed=${JANITOR_FREED}
prev_beat_ts=${PREV_BEAT_TS:-none}
since_prev_beat_s=${SINCE_PREV_S:-unknown}
restart_source=${RESTART_SOURCE}
restart_verdict=${RESTART_VERDICT}
image_build_sha_source=${IMAGE_BUILD_SHA_SOURCE}
acr_login_result=${ACR_LOGIN_RESULT}
acr_login_ts=${ACR_LOGIN_TS}
acr_login_reason=${ACR_LOGIN_REASON}
acr_login_registry=${ACR_LOGIN_REGISTRY}
backup_verdict=${BACKUP_VERDICT}
backup_ts=${BACKUP_TS}
backup_offhost=${BACKUP_OFFHOST}
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

# Consumer sizes are APPENDED, only when scheduled (every Nth beat): an absent `consumer_*_kb` means
# "not measured this beat", which a reader must never coerce to 0.
if [ -n "$CONSUMER_LINES" ]; then
  PAYLOAD="${PAYLOAD}${CONSUMER_LINES}"
fi

# Device pressure is APPENDED: absent device keys mean nothing was measured, never an idle disk.
PAYLOAD="${PAYLOAD}
${IO_LINES}"

# Memory is APPENDED the same way: absent mem_ keys mean nothing was measured, never an idle cgroup.
PAYLOAD="${PAYLOAD}
${MEM_LINES}"

# The subject line IS the phone-readable answer — it is what shows on the branch listing without
# opening anything. Both verdicts ride in it, because the two failures it separates (a dead
# daemon on a healthy host, a broken install on a healthy host) call for different responses.
SUBJECT="heartbeat ${NOW_ISO}: daemon ${DAEMON_VERDICT%% *} | build ${DISPATCH_VERDICT%% *} | rmd ${RMD_VERDICT%%:*}"

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
