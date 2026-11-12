# shellcheck shell=bash
# rmd-entrypoint, second stage: the loop that starts the daemon, records its exit and restarts it.
#
# W1-T12240: deploy/entrypoint.sh sources this file after its first checkout sync, so every
# function and variable of the first part is in scope here. It reads this copy from the checkout,
# or the image copy at /usr/local/lib/rmd/ when the checkout copy cannot run. A change here is live
# after the next freshness restart, with no image and no recycle.
# Why: docs/forensics/entrypoint.md#the-second-stage.

log "restart throttle: a NON-ZERO exit will sleep ${RESTART_THROTTLE_S}s before exiting, so docker restarts at that rate"

# Duplicated from `DAEMON_EXIT_STALE` (src/lib/daemon.ts) — this script runs before any node
# process exists, so it cannot import the constant. test/entrypoint-boot.test.ts greps both this
# and the two below out of the file and asserts they equal the exported constants, so a drift is a
# red test, never a silent mis-route.
DAEMON_EXIT_STALE=75

# Duplicated from `DAEMON_EXIT_BLOCKED`, same reason and same falsifier as above.
DAEMON_EXIT_BLOCKED=76
# Duplicated from `DAEMON_EXIT_ENVIRONMENTAL`, same reason and same falsifier as above.
DAEMON_EXIT_ENVIRONMENTAL=77
DAEMON_EXIT_IDLE_STARVED=78
# 100, not the original 20: MEASURED 2026-08-18 merge rates (median 63/day) spend a budget of 20
# inside a single day, after which a routine freshness exit falls through and spends the crash
# budget instead — the exact conflation this whole block exists to undo. Worst case is
# FRESHNESS_RESTART_MAX x FRESHNESS_RESTART_PAUSE_S (500s), and every restart re-runs `sync_tree`'s
# real fetch, a cost accepted deliberately for the headroom.
# Why: docs/forensics/entrypoint.md#why-freshness_restart_max-is-100-measured-2026-08-18.
FRESHNESS_RESTART_MAX="${RMD_FRESHNESS_RESTART_MAX:-100}"
case "$FRESHNESS_RESTART_MAX" in
  '' | *[!0-9]*)
    log "RMD_FRESHNESS_RESTART_MAX is not a whole number — ignoring it and using 100"
    FRESHNESS_RESTART_MAX=100
    ;;
esac

# The freshness retry gets its own short pause, separate from the crash throttle above: a
# freshness restart is not the boot-failing-the-same-way shape that throttle exists to slow (see
# docs/forensics/entrypoint.md#the-restart-rate-limit--why-the-container-needs-one-at-all), and
# sleeping the full crash throttle here bought nothing but idle time. The bound is replaced, not
# removed — still capped at `FRESHNESS_RESTART_MAX` attempts.
FRESHNESS_RESTART_PAUSE_S="${RMD_FRESHNESS_RESTART_PAUSE_S:-5}"
case "$FRESHNESS_RESTART_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_FRESHNESS_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 5"
    FRESHNESS_RESTART_PAUSE_S=5
    ;;
esac

# ── W1-T2537: the blocked retry, the other half of the freshness loop ────────────────────────
# Invariant: a `blocked` stop is a COMPLETED drain pass, not a crash — charging it to docker's
# `on-failure:N` anyway left the container down for 46+ minutes after a pass that had actually
# dispatched three tasks (MEASURED 2026-08-30). The loop is self-sustaining: a red board is what
# produces blocked passes, so the crash budget empties fastest exactly when draining is needed most.
# The cap mirrors FRESHNESS_RESTART_MAX; the pause is the daemon's own DEFAULT_POLL_INTERVAL_MS
# (60s) — "check back once a minute while nothing is runnable" is what a blocked board is.
# Why: docs/forensics/entrypoint.md#the-blocked-retry--the-other-half-of-the-freshness-loop-w1-t2537.
BLOCKED_RESTART_MAX="${RMD_BLOCKED_RESTART_MAX:-100}"
case "$BLOCKED_RESTART_MAX" in
  '' | *[!0-9]*)
    log "RMD_BLOCKED_RESTART_MAX is not a whole number — ignoring it and using 100"
    BLOCKED_RESTART_MAX=100
    ;;
esac

ENVIRONMENTAL_RESTART_MAX="${RMD_ENVIRONMENTAL_RESTART_MAX:-100}"
case "$ENVIRONMENTAL_RESTART_MAX" in
  ''|*[!0-9]*)
    log "RMD_ENVIRONMENTAL_RESTART_MAX is not a whole number — ignoring it and using 100"
    ENVIRONMENTAL_RESTART_MAX=100
    ;;
esac
# WHY 300s AND NOT 60s: unlike a blocked pass, waiting is the ENTIRE remedy here. A GitHub primary
# rate limit resets on the hour and a secondary limit has held this account for ~90 minutes, so
# retrying a minute later just spends another refusal. Five minutes is short enough that a brief
# 5xx clears quickly and long enough that a real lockout is waited out rather than hammered.
ENVIRONMENTAL_RESTART_PAUSE_S="${RMD_ENVIRONMENTAL_RESTART_PAUSE_S:-300}"
case "$ENVIRONMENTAL_RESTART_PAUSE_S" in
  ''|*[!0-9]*)
    log "RMD_ENVIRONMENTAL_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 300"
    ENVIRONMENTAL_RESTART_PAUSE_S=300
    ;;
esac
BLOCKED_RESTART_PAUSE_S="${RMD_BLOCKED_RESTART_PAUSE_S:-60}"
case "$BLOCKED_RESTART_PAUSE_S" in
  '' | *[!0-9]*)
    log "RMD_BLOCKED_RESTART_PAUSE_S is not a whole number of seconds — ignoring it and using 60"
    BLOCKED_RESTART_PAUSE_S=60
    ;;
esac

# ── Signal forwarding (W1-T1067): restore what `exec` gives for free ────────────────────────
# Invariant: once the throttle is non-zero, this shell runs the daemon as a SEPARATE backgrounded
# process rather than exec'ing it, so a signal tini sends no longer reaches the daemon unless this
# shell forwards it. Without the trap below, this shell's default TERM disposition is to die
# immediately, orphaning the daemon with nothing forwarded until docker's SIGKILL grace period —
# too late for its own handler to release `state/drain.lock` (measured on a live container: node
# had already been SIGKILLed with the lock still held).
# Trap: a handled TERM must exit 0, or `docker stop` never sticks. The daemon re-raises the signal
# against itself once its cleanup is done, so a clean stop still carries wait status 143 — which
# `on-failure` cannot tell from a crash, so an operator's stop silently comes back on its own
# (measured cost: ~24 minutes and ~$45 before anyone noticed). `signal_forwarded` is the fact this
# shell knows and `daemonExitCode` cannot: it is what received TERM/INT and chose to forward it,
# set only after a live child was actually signalled, never inferred from the exit code alone.
# Falsifier: the real exit code is captured inside the trap's own fresh `wait`, not by resuming the
# interrupted one — bash returns a pseudo-status >128 from an interrupted `wait`, which describes
# bash's own interruption, never the child's outcome.
# Why: docs/forensics/entrypoint.md#signal-forwarding--restoring-what-exec-gives-for-free-w1-t1067.
signal_forwarded=""
child_pid=""
child_rc=""
forward_signal() {
  sig="$1"
  if [ -n "$child_pid" ]; then
    log "received $sig — forwarding to pid $child_pid so it can release its locks before exiting"
    kill "-$sig" "$child_pid" 2>/dev/null || true
    child_rc=0
    wait "$child_pid" 2>/dev/null || child_rc=$?
    signal_forwarded=1
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

if [ "${1:-}" = "./bin/rmd" ] && [ "${2:-}" = "daemon" ]; then
  export RMD_IDLE_STARVED_SUPERVISED=1
fi

idle_starved_wait() {
  local repo_arg="" arg previous="" owner="" repo="" slug="" checkout="" base_sha="" origin_url="" probe_rc=0 probe_mode="" i marker since
  local pulse_started=0 remaining=0 cohort_rc=0
  for arg in "$@"; do
    if [ "$previous" = "--repo" ]; then repo_arg="$arg"; break; fi
    previous="$arg"
  done
  [ -n "$repo_arg" ] || return 2
  repo="${repo_arg##*/}"
  if [[ "$repo_arg" == */* ]]; then
    slug="$repo_arg"
  else
    origin_url="$(git -C "$TREE" remote get-url origin)" || return 2
    if [[ "$origin_url" =~ github\.com[:/]([A-Za-z0-9_.-]+)/[A-Za-z0-9_.-]+(\.git)?$ ]]; then
      owner="${BASH_REMATCH[1]}"
    else
      return 2
    fi
    slug="$owner/$repo"
  fi
  [[ "$slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 2
  checkout="$CONFIG_ROOT/repos/$repo"
  base_sha="$(git -C "$checkout" rev-parse --verify HEAD)" || return 2
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || return 2
  marker="$CONFIG_ROOT/state/idle-starved.marker"
  [ -f "$marker" ] || return 2
  IFS= read -r since < "$marker" || return 2
  [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]] || return 2
  log "idle_starved: $slug at $base_sha; probing the PR board every 300s and full state every 1800s with no model worker"
  while :; do
    i=0
    while [ "$i" -lt 6 ]; do
      printf '{"ts":"%s","run_id":"IDLE-%s","task_id":"DAEMON","step":"daemon.idle_starved.pulse","lane":"daemon","repo":"%s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${base_sha:0:12}" "$slug" >> "$CONFIG_ROOT/state/ledger.ndjson" || return 2
      [ ! -e "$CONFIG_ROOT/state/STOP" ] || { log "idle_starved: STOP requested"; return 0; }
      # Keep the private cohort checkpoint moving without a model worker. The maintenance
      # budget is part of this 300s pulse, not added to the PR wake/probe interval. A slow
      # or failed projection is logged and abandoned; it never changes the supervisor's flow.
      pulse_started="$(date +%s)"
      cohort_rc=0
      timeout -k 5s 120s node --import tsx "$TREE/src/lib/benchmark-cohort.ts" "$CONFIG_ROOT/state" &
      child_pid=$!
      wait "$child_pid" || cohort_rc=$?
      child_pid=""
      if [ -n "$signal_forwarded" ]; then return 0; fi
      [ "$cohort_rc" -eq 0 ] || log "idle_starved: benchmark cohort pass unavailable (exit $cohort_rc)"
      [ ! -e "$CONFIG_ROOT/state/STOP" ] || { log "idle_starved: STOP requested"; return 0; }
      remaining=$((300 - ($(date +%s) - pulse_started)))
      [ "$remaining" -gt 0 ] || remaining=1
      sleep "$remaining" &
      child_pid=$!
      probe_rc=0
      wait "$child_pid" || probe_rc=$?
      child_pid=""
      if [ -n "$signal_forwarded" ]; then return 0; fi
      [ "$probe_rc" -eq 0 ] || return 2
      i=$((i + 1))
      probe_mode=pr-board
      if [ "$i" -eq 6 ]; then probe_mode=full; fi
      probe_rc=0
      bash "$TREE/deploy/idle-starved-probe.sh" "$slug" "$checkout" "$base_sha" "$CONFIG_ROOT/state" "$since" "$marker" "$TREE" "$probe_mode" "$daemon_engine_sha" "$daemon_engine_observer" &
      child_pid=$!
      wait "$child_pid" || probe_rc=$?
      child_pid=""
      if [ -n "$signal_forwarded" ]; then return 0; fi
      if [ "$probe_rc" -ne 0 ]; then
        log "idle_starved: wake ($slug $probe_mode probe exit $probe_rc); resuming full daemon"
        if [ "$probe_rc" -eq 10 ]; then return 1; fi
        return 3
      fi
      if [ "$probe_mode" = full ]; then log "idle_starved: $slug remains empty"; fi
    done
  done
}

# Trap: the exit code must be captured from the SAME command that runs it — `if "$@"; then ...; fi;
# rc=$?` reads $? from the compound, which is 0 whenever the condition merely tested false, so a
# crashing daemon read as a success. Backgrounded, not foreground, so the trap above can react
# while it runs; `child_rc` starts empty every pass and only the trap sets it, so an unsignaled
# exit leaves `rc` exactly what the plain `wait` below produces.
freshness_restarts=0
blocked_restarts=0
environmental_restarts=0
# W1-T12240: a re-run after a changed checkout copy keeps the counts of the run before it.
case "${RMD_SUPERVISE_FRESHNESS_RESTARTS:-}" in ''|*[!0-9]*) ;; *) freshness_restarts="$RMD_SUPERVISE_FRESHNESS_RESTARTS" ;; esac
case "${RMD_SUPERVISE_BLOCKED_RESTARTS:-}" in ''|*[!0-9]*) ;; *) blocked_restarts="$RMD_SUPERVISE_BLOCKED_RESTARTS" ;; esac
case "${RMD_SUPERVISE_ENVIRONMENTAL_RESTARTS:-}" in ''|*[!0-9]*) ;; *) environmental_restarts="$RMD_SUPERVISE_ENVIRONMENTAL_RESTARTS" ;; esac
unset RMD_SUPERVISE_FRESHNESS_RESTARTS RMD_SUPERVISE_BLOCKED_RESTARTS RMD_SUPERVISE_ENVIRONMENTAL_RESTARTS
while :; do
  rc=0
  child_rc=""
  signal_forwarded=""
  # Establish the observation boundary BEFORE Node can decide to sleep. A control or human
  # approval arriving after that decision but before exit 78 must be newer than this marker.
  if [ "${RMD_IDLE_STARVED_SUPERVISED:-}" = "1" ]; then
    mkdir -p "$CONFIG_ROOT/state" || die "cannot prepare idle_starved state directory"
    date -u +%Y-%m-%dT%H:%M:%S.000Z > "$CONFIG_ROOT/state/idle-starved.marker" || die "cannot prepare idle_starved marker"
    # Capture before the daemon loads code, not after it exits into quiet mode:
    # a mounted checkout can advance during that run without refreshing the process.
    daemon_engine_sha="$(git -C "$TREE" rev-parse --verify HEAD 2>/dev/null)" || daemon_engine_sha=""
    daemon_engine_observer="$TREE"
    # Observe the separate host installation; a broken declaration must stay unreadable.
    if [ -e "$CONFIG_ROOT/daemon-install" ] || [ -L "$CONFIG_ROOT/daemon-install" ]; then
      daemon_engine_observer="$CONFIG_ROOT/daemon-install"
    fi
  fi
  SUPERVISE_DAEMON_STARTED=1
  if [ "$supervise_daemon" -eq 1 ]; then
    export REMUDERO_RUN_ID="DAEMON-$(date +%s%3N)-$$"
    mkdir -p "$CONFIG_ROOT/state"
    heap_line_path="$CONFIG_ROOT/state/.daemon-heap-line-$$"
    : > "$heap_line_path"
    stderr_end="RMD-STDERR-END-${REMUDERO_RUN_ID}-$$"
    exec 19> >(node --input-type=commonjs -e '
const fs = require("node:fs");
const { once } = require("node:events");
const [evidence, stop] = process.argv.slice(1);
const marker = Buffer.from(stop);
async function forwardLine(line) {
  const content = line[line.length - 1] === 10 ? line.subarray(0, -1) : line;
  if (content.equals(marker)) return false;
  if (/heap limit/i.test(content.toString("latin1"))) {
    fs.writeFileSync(evidence, Buffer.concat([content.subarray(0, 240), Buffer.from("\n")]));
  }
  if (!process.stdout.write(line)) await once(process.stdout, "drain");
  return true;
}
(async () => {
  let parts = [], size = 0;
  for await (const chunk of process.stdin) {
    let offset = 0, newline;
    while ((newline = chunk.indexOf(10, offset)) !== -1) {
      const piece = chunk.subarray(offset, newline + 1);
      const line = parts.length ? Buffer.concat([...parts, piece], size + piece.length) : piece;
      parts = [];
      size = 0;
      if (!await forwardLine(line)) return;
      offset = newline + 1;
    }
    if (offset < chunk.length) {
      const tail = chunk.subarray(offset);
      parts.push(tail);
      size += tail.length;
    }
  }
  if (size) await forwardLine(Buffer.concat(parts, size));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
    ' "$heap_line_path" "$stderr_end" >&2)
    daemon_stderr_pid=$!
    "$@" 2>&19 &
  else
    "$@" &
  fi
  child_pid=$!
  wait "$child_pid" || rc=$?
  if [ -n "$child_rc" ]; then
    rc=$child_rc
  fi
  child_pid=""

  if [ "$supervise_daemon" -eq 1 ]; then
    # End the observer explicitly: orphaned workers may still hold their inherited stderr open.
    printf '\n%s\n' "$stderr_end" >&19 || log "stderr observer already exited"
    exec 19>&-
    wait "$daemon_stderr_pid" || log "stderr observer failed; exit status is still recorded"
    if ! node --input-type=commonjs - "$CONFIG_ROOT/state/ledger.ndjson" "$REMUDERO_RUN_ID" "$rc" "$heap_line_path" "$signal_forwarded" <<'DAEMON_EXIT_EVIDENCE'
const fs = require('node:fs');
const [ledger, runId, code, heapPath, forwarded] = process.argv.slice(2);
const heapLine = fs.readFileSync(heapPath, 'utf8').trim();
fs.appendFileSync(ledger, JSON.stringify({
  ts: new Date().toISOString(), run_id: runId, task_id: 'DAEMON', step: 'daemon.process.exit',
  exit_code: Number(code), clean_exit: Boolean(forwarded) || Number(code) === 0 || Number(code) === 75,
  heap_limit_line: heapLine || null,
}) + '\n');
DAEMON_EXIT_EVIDENCE
    then log "could not persist daemon exit evidence (exit $rc)"; fi
    rm -f -- "$heap_line_path"
    unset REMUDERO_RUN_ID
  fi

  # W1-T2586: A SIGNAL THIS SHELL ITSELF FORWARDED OUTRANKS EVERY OTHER CLASSIFICATION BELOW.
  # `signal_forwarded` is set ONLY inside `forward_signal`, ONLY after TERM/INT was actually sent
  # to a live child — so reaching here with it set means an operator (or a supervisor's `docker
  # stop`) asked this container to shut down, the daemon was told, and it exited AS A RESULT,
  # whatever its raw wait status ($rc, typically 143 — 128+SIGTERM). That is what a graceful
  # operator stop means to every process supervisor: exit 0, and RIGHT NOW, never after the crash
  # throttle below. THE UNSIGNALED PATHS ARE ALL LEFT ALONE: this branch cannot fire without a
  # real forwarded signal, so a genuine crash (no signal, non-zero $rc) still falls through to
  # the non-zero handling further down and is still counted by docker exactly as before.
  if [ -n "$signal_forwarded" ]; then
    log "operator stop handled: $sig was forwarded and the daemon exited $rc as a result — reporting a CLEAN exit (0) so on-failure does not read a deliberate stop as a crash"
    exit 0
  fi

  if [ "$rc" -eq 0 ]; then
    log "exited 0 — not throttled (a STOP is a clean stop; --restart=on-failure leaves the container down)"
    exit 0
  fi

  if [ "$rc" -eq "$DAEMON_EXIT_IDLE_STARVED" ] && [ "${RMD_IDLE_STARVED_SUPERVISED:-}" = "1" ]; then
    idle_rc=0
    idle_starved_wait "$@" || idle_rc=$?
    rm -f -- "$CONFIG_ROOT/state/idle-starved.marker"
    if [ "$idle_rc" -eq 0 ]; then
      log "idle_starved: deliberate stop — exiting cleanly"
      exit 0
    fi
    if [ "$idle_rc" -eq 2 ]; then
      log "idle_starved: supervisor setup/clock failed; disabling quiet mode for this process and resuming normally"
      export RMD_IDLE_STARVED_SUPERVISED=0
    elif [ "$idle_rc" -eq 3 ]; then
      log "idle_starved: remote probe uncertain; daemon will re-evaluate and may return to quiet mode"
    fi
    sync_tree
    resolve_rmd_on_path
    continue
  fi

  # A `stale` stop is not a failure — the daemon wants exactly this restart, on code that has
  # since merged — so serving it here means docker never counts it, and the re-sync makes the
  # retry meaningful rather than a re-run of the same tree.
  if [ "$rc" -eq "$DAEMON_EXIT_STALE" ] && [ "$freshness_restarts" -lt "$FRESHNESS_RESTART_MAX" ]; then
    freshness_restarts=$((freshness_restarts + 1))
    log "exited $rc (freshness) — restart ${freshness_restarts}/${FRESHNESS_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  sleeping ${FRESHNESS_RESTART_PAUSE_S}s (not the ${RESTART_THROTTLE_S}s crash throttle) then re-running the fetch/checkout so the staleness actually clears"
    sleep "$FRESHNESS_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    resolve_rmd_on_path
    supervise_follow_checkout "$freshness_restarts" "$blocked_restarts" "$environmental_restarts"
    continue
  fi

  # W1-T2537 — the second case that does not spend the budget: a `blocked` stop is a pass that
  # ran to COMPLETION, so re-syncing first gives the next pass a genuinely different board. Past
  # the cap it falls through to the crash throttle, so the bound is replaced, never removed.
  if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ] && [ "$blocked_restarts" -lt "$BLOCKED_RESTART_MAX" ]; then
    blocked_restarts=$((blocked_restarts + 1))
    log "exited $rc (blocked) — restart ${blocked_restarts}/${BLOCKED_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  a blocked pass is a COMPLETED pass, not a crash; sleeping ${BLOCKED_RESTART_PAUSE_S}s then re-running the fetch/checkout so the next pass sees any merges"
    sleep "$BLOCKED_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    resolve_rmd_on_path
    supervise_follow_checkout "$freshness_restarts" "$blocked_restarts" "$environmental_restarts"
    continue
  fi

  # W1-T2546 — the third case that does not spend the budget: an environmental refusal (a GitHub
  # rate-limit 403, a 5xx, a transport fault) is not a crash, and waiting is the correct response.
  # During a lockout window every pass can die this way, draining the crash budget at the rate the
  # limiter refuses. Past the cap it falls through to the crash throttle, bound replaced not removed.
  # Why: docs/forensics/entrypoint.md#the-environmental-refusal-retry-arm-w1-t2546.
  if [ "$rc" -eq "$DAEMON_EXIT_ENVIRONMENTAL" ] && [ "$environmental_restarts" -lt "$ENVIRONMENTAL_RESTART_MAX" ]; then
    environmental_restarts=$((environmental_restarts + 1))
    log "exited $rc (environmental) — restart ${environmental_restarts}/${ENVIRONMENTAL_RESTART_MAX} IN-CONTAINER, so docker's on-failure budget is not spent"
    log "  an environmental refusal is not a crash; sleeping ${ENVIRONMENTAL_RESTART_PAUSE_S}s to let the limit reset, then re-running the fetch/checkout"
    sleep "$ENVIRONMENTAL_RESTART_PAUSE_S"
    sync_tree
    log "checkout: $(git -C "$TREE" rev-parse HEAD) ($REF)"
    resolve_rmd_on_path
    supervise_follow_checkout "$freshness_restarts" "$blocked_restarts" "$environmental_restarts"
    continue
  fi

  # Everything else exits, and is counted: a crash reaches here on its first attempt, so
  # `--restart=on-failure:N` still bounds a crash loop exactly as before this block existed.
  if [ "$rc" -eq "$DAEMON_EXIT_STALE" ]; then
    log "exited $rc (freshness) — but ${FRESHNESS_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  if [ "$rc" -eq "$DAEMON_EXIT_BLOCKED" ]; then
    log "exited $rc (blocked) — but ${BLOCKED_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  if [ "$rc" -eq "$DAEMON_EXIT_ENVIRONMENTAL" ]; then
    log "exited $rc (environmental) — but ${ENVIRONMENTAL_RESTART_MAX} in-container restarts are already spent, so this one goes to docker's count"
  fi
  log "exited $rc — sleeping ${RESTART_THROTTLE_S}s before exiting so the restart is rate-limited, not just counted"
  sleep "$RESTART_THROTTLE_S"
  exit "$rc"
done
