#!/usr/bin/env bash
# install-host-units — put the systemd units and launcher that make a VM a FLEET HOST under source
# control, so a second instance is provisioned rather than reconstructed from memory.
#
# THE GAP THIS CLOSES (W1-T2877). Everything below was installed BY HAND on the Azure host during
# the 2026-09-05 incidents and existed in no tracked file. A second instance provisioned from this
# repo therefore came up without reboot survival, without crash recovery, without a heap ceiling and
# without a heartbeat — and, because a host with no beat branch is SILENT BY DESIGN in
# fleet-heartbeat-watch.yml, an unmonitored instance looked exactly like a monitored healthy one.
#
# WHY A TRACKED INSTALLER BEATS A GOOD HAND FIX, MEASURED RATHER THAN ASSERTED. W1-T2856 did this
# for the container-runtime mount ordering. Running THAT installer against the same host whose
# drop-ins had been written by hand found two required paths the hand fix had missed: Docker's real
# data root (resolved from `docker info --format '{{.DockerRootDir}}'`, which is /mnt/rmd/docker
# here and NOT the assumed /var/lib/docker) and the device backing the containerd root. The hand fix
# was careful and still wrong; the tested one was not.
#
# ── WHAT THIS INSTALLS, AND THE FAILURE EACH ONE ANSWERS ──────────────────────────────────────────
#   rmd-relaunch.sh            the canonical daemon launcher. Derived from
#                              `deploy/host-update.sh --print-daemon-run`, which stays the source of
#                              truth for the invocation itself.
#   rmd-fleet.service          reboot survival. The daemon runs `--restart=on-failure:5` ON PURPOSE
#                              so a clean STOP (exit 0) is not undone by docker; that also means
#                              docker will NOT bring it back after a reboot, so this unit does.
#   rmd-fleet-watchdog.*       crash recovery. `on-failure:5` is a COUNT, NOT A RATE. On 2026-09-05
#                              six heap aborts exhausted it, docker stopped trying, and the fleet sat
#                              dead for three hours while PRs piled up green and unreviewed.
#   rmd-reap-stray.*           a leaked ad-hoc container spawned 158 nested daemons and held ~90% of
#                              a core; load hit 9.5 and sshd could not complete a handshake.
#
# THE LAUNCHER'S FOUR GUARDS ARE LOAD-BEARING AND A PORT THAT DROPS ANY OF THEM IS WORSE THAN NONE:
#   * refuses when state/STOP exists            — no timer or boot unit may undo a deliberate stop
#   * refuses when the state root is unmounted  — the 2026-09-05 fleet-wipe failure mode
#   * idempotent (no-op on a live daemon)       — a 5-minute timer must never disturb live workers
#   * appends a revival record                  — recreating the container RESETS docker's
#                                                 RestartCount, so without this, auto-recovery hides
#                                                 the very crash loop it is recovering from
#
# HOST-SPECIFIC VALUES ARE INPUTS, NOT CONSTANTS, AND AN UNRESOLVABLE ONE IS REFUSED RATHER THAN
# GUESSED. Defaults describe the current Azure host; a second instance overrides them. Guessing a
# state root is how PAUSE and STOP end up written where nothing reads them.
#
# USAGE
#   deploy/install-host-units.sh              # CHECK (default): report drift, change nothing, exit 1 if any
#   deploy/install-host-units.sh --instance site
#   sudo deploy/install-host-units.sh --install
#
# OVERRIDES (all optional; the *_DIR ones exist so the test suite can run this against a temp tree)
#   RMD_STATE_DIR RMD_IMAGE RMD_SERVICE_USER RMD_NODE_MAX_OLD_SPACE_MB
#   RMD_GH_APP_ID RMD_GH_APP_INSTALLATION_ID RMD_GH_APP_PRIVATE_KEY_PATH
#   RMD_UNIT_DIR RMD_BIN_DIR RMD_LAUNCHER_PATH RMD_REVIVAL_LOG
set -euo pipefail

MODE="check"
INSTANCE_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) MODE="install"; shift ;;
    --check) MODE="check"; shift ;;
    --instance) INSTANCE_NAME="${2:?--instance needs a value}"; shift 2 ;;
    --help) sed -n '1,72p' "$0"; exit 0 ;;
    *) echo "install-host-units: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
DEFAULT_INSTANCE_REGISTRY="${SCRIPT_DIR%/deploy}/.remudero/daemon-instances.yaml"

validate_instance_name() {
  case "$1" in
    ""|*[!a-zA-Z0-9_-]*)
      echo "install-host-units: FATAL -- invalid instance name '$1'." >&2
      echo "  Use only letters, digits, '_' and '-'." >&2
      exit 2
      ;;
  esac
}

read_instance_registry() {
  local registry_file="$1" want="$2"
  awk -v want="$want" '
    {
      sub(/[[:space:]]+#.*/, "")
    }
    /^[[:space:]]*$/ { next }
    $0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      name=$1
      sub(/:$/, "", name)
      current=name
      next
    }
    current == want && $0 ~ /^    [A-Za-z_]+:[[:space:]]*/ {
      key=$1
      sub(/:$/, "", key)
      value=$0
      sub(/^    [A-Za-z_]+:[[:space:]]*/, "", value)
      gsub(/^"|"$/, "", value)
      print key "=" value
    }
  ' "$registry_file"
}

require_abs_path() {
  local name="$1" value="$2"
  case "$value" in
    /*) : ;;
    *) echo "install-host-units: FATAL -- ${name} must be absolute for instance ${INSTANCE_NAME}, got '${value}'." >&2; exit 2 ;;
  esac
}

# `${VAR-default}` NOT `${VAR:-default}` — WITHOUT THE COLON, ON PURPOSE. The colon form
# substitutes the default for an EMPTY value as well as an unset one, so `RMD_STATE_DIR=` would
# silently fall back to this host's path on a machine that is not this host — the exact "guess a
# state root" failure the refusal below exists to prevent. Omitting the colon preserves an
# explicitly-empty override so it reaches that refusal and exits 2.
STATE_DIR="${RMD_STATE_DIR-/home/craigoleyagent/rmd-state2}"
IMAGE="${RMD_IMAGE-synthwatcholey0620.azurecr.io/remudero:latest}"
SERVICE_USER="${RMD_SERVICE_USER-craigoleyagent}"
CONTAINER_NAME="${RMD_DAEMON_CONTAINER-remudero-daemon}"
DAEMON_REPO="${RMD_DAEMON_REPO-remudero}"
# W1-T2953 — NO SILENT DEFAULT. This rendered 4096 when the variable was unset, while the live
# Azure host runs 8192; a `--install` would have DOWNGRADED the daemon's heap without a word, and
# the retro rung is the first thing an undersized heap kills. The value is now REQUIRED and
# validated, so omission is a named refusal rather than a quiet halving. It is deliberately NOT
# read back from the installed launcher: deriving the desired value from the current one makes
# drift self-ratifying, which is the whole failure this task exists to end.
MAX_OLD_SPACE_MB="${RMD_NODE_MAX_OLD_SPACE_MB-}"
if [ -z "$MAX_OLD_SPACE_MB" ] && [ -z "$INSTANCE_NAME" ]; then
  echo "install-host-units: FATAL — RMD_NODE_MAX_OLD_SPACE_MB is required and has no default." >&2
  echo "  It sizes the daemon's V8 heap. This host (32 GiB / 8 vCPU) runs 8192; a smaller host needs less." >&2
  echo "  Set it explicitly, e.g. RMD_NODE_MAX_OLD_SPACE_MB=8192 — never inferred from the installed unit." >&2
  exit 2
fi
GH_APP_ID_V="${RMD_GH_APP_ID:-4648213}"
GH_APP_INST_V="${RMD_GH_APP_INSTALLATION_ID:-155256285}"
GH_APP_KEY_V="${RMD_GH_APP_PRIVATE_KEY_PATH:-/home/node/.claude/rmd-app.pem}"
CLAUDE_DIR="${RMD_CLAUDE_DIR:-/home/${SERVICE_USER}/.claude}"
CODEX_DIR="${RMD_CODEX_DIR:-/home/${SERVICE_USER}/.codex}"
CONTAINER_CONFIG_DIR="${RMD_CONTAINER_CONFIG_DIR:-/home/${SERVICE_USER}/.config/remudero-container}"
UNIT_DIR="${RMD_UNIT_DIR:-/etc/systemd/system}"
BIN_DIR="${RMD_BIN_DIR:-/usr/local/bin}"
LAUNCHER="${RMD_LAUNCHER_PATH:-/home/${SERVICE_USER}/rmd-relaunch.sh}"
REVIVAL_LOG="${RMD_REVIVAL_LOG:-/home/${SERVICE_USER}/rmd-revivals.log}"
SERVICE_UNIT_NAME="rmd-fleet.service"
WATCHDOG_SERVICE_NAME="rmd-fleet-watchdog.service"
WATCHDOG_TIMER_NAME="rmd-fleet-watchdog.timer"
REGISTRY_FILE="${RMD_INSTANCE_REGISTRY:-}"

if [ -n "$INSTANCE_NAME" ]; then
  validate_instance_name "$INSTANCE_NAME"
  if [ -z "$REGISTRY_FILE" ]; then
    REGISTRY_FILE="$DEFAULT_INSTANCE_REGISTRY"
  fi
  if [ ! -r "$REGISTRY_FILE" ]; then
    echo "install-host-units: FATAL -- instance registry '${REGISTRY_FILE}' is not readable." >&2
    echo "  Pass RMD_INSTANCE_REGISTRY=/path/to/daemon-instances.yaml or omit --instance for the legacy core defaults." >&2
    exit 2
  fi
  record="$(read_instance_registry "$REGISTRY_FILE" "$INSTANCE_NAME")"
  if [ -z "$record" ]; then
    echo "install-host-units: FATAL -- instance '${INSTANCE_NAME}' is not declared in ${REGISTRY_FILE}." >&2
    exit 2
  fi
  repo=""; state_dir=""; container_name=""; service_user=""; image=""; max_old_space_mb=""
  service_name=""; watchdog_service_name=""; watchdog_timer_name=""; launcher_path=""; revival_log=""
  gh_app_id=""; gh_app_installation_id=""; gh_app_private_key_path=""
  claude_dir=""; codex_dir=""; container_config_dir=""
  while IFS='=' read -r key value; do
    case "$key" in
      repo) repo="$value" ;;
      state_dir) state_dir="$value" ;;
      container_name) container_name="$value" ;;
      service_user) service_user="$value" ;;
      image) image="$value" ;;
      max_old_space_mb) max_old_space_mb="$value" ;;
      service_name) service_name="$value" ;;
      watchdog_service_name) watchdog_service_name="$value" ;;
      watchdog_timer_name) watchdog_timer_name="$value" ;;
      launcher_path) launcher_path="$value" ;;
      revival_log) revival_log="$value" ;;
      gh_app_id) gh_app_id="$value" ;;
      gh_app_installation_id) gh_app_installation_id="$value" ;;
      gh_app_private_key_path) gh_app_private_key_path="$value" ;;
      claude_dir) claude_dir="$value" ;;
      codex_dir) codex_dir="$value" ;;
      container_config_dir) container_config_dir="$value" ;;
      *) echo "install-host-units: FATAL -- unknown field '${key}' in instance '${INSTANCE_NAME}'." >&2; exit 2 ;;
    esac
  done <<EOF
$record
EOF
  for pair in \
    "repo:$repo" "state_dir:$state_dir" "container_name:$container_name" "service_user:$service_user" \
    "image:$image" "max_old_space_mb:$max_old_space_mb" "service_name:$service_name" \
    "watchdog_service_name:$watchdog_service_name" "watchdog_timer_name:$watchdog_timer_name" \
    "launcher_path:$launcher_path" "revival_log:$revival_log" "gh_app_id:$gh_app_id" \
    "gh_app_installation_id:$gh_app_installation_id" "gh_app_private_key_path:$gh_app_private_key_path" \
    "claude_dir:$claude_dir" "codex_dir:$codex_dir" "container_config_dir:$container_config_dir"; do
    name="${pair%%:*}"; val="${pair#*:}"
    [ -n "$val" ] || { echo "install-host-units: FATAL -- instance '${INSTANCE_NAME}' missing required field '${name}'." >&2; exit 2; }
  done
  STATE_DIR="$state_dir"
  IMAGE="$image"
  SERVICE_USER="$service_user"
  CONTAINER_NAME="$container_name"
  DAEMON_REPO="$repo"
  MAX_OLD_SPACE_MB="$max_old_space_mb"
  GH_APP_ID_V="$gh_app_id"
  GH_APP_INST_V="$gh_app_installation_id"
  GH_APP_KEY_V="$gh_app_private_key_path"
  CLAUDE_DIR="$claude_dir"
  CODEX_DIR="$codex_dir"
  CONTAINER_CONFIG_DIR="$container_config_dir"
  LAUNCHER="$launcher_path"
  REVIVAL_LOG="$revival_log"
  SERVICE_UNIT_NAME="$service_name"
  WATCHDOG_SERVICE_NAME="$watchdog_service_name"
  WATCHDOG_TIMER_NAME="$watchdog_timer_name"
fi

# REFUSE RATHER THAN GUESS. Same posture `--print-daemon-run` takes when it cannot find a ledger:
# a wrong state root is silent, and lands PAUSE/STOP where nothing reads them.
for pair in "STATE_DIR:$STATE_DIR" "IMAGE:$IMAGE" "SERVICE_USER:$SERVICE_USER" "MAX_OLD_SPACE_MB:$MAX_OLD_SPACE_MB" "CONTAINER_NAME:$CONTAINER_NAME" "DAEMON_REPO:$DAEMON_REPO"; do
  name="${pair%%:*}"; val="${pair#*:}"
  [ -n "$val" ] || { echo "install-host-units: FATAL — ${name} resolved to empty; pass RMD_${name}." >&2; exit 2; }
done
case "$MAX_OLD_SPACE_MB" in ''|*[!0-9]*) echo "install-host-units: FATAL — RMD_NODE_MAX_OLD_SPACE_MB must be an integer, got '${MAX_OLD_SPACE_MB}'." >&2; exit 2 ;; esac
case "$STATE_DIR" in /*) : ;; *) echo "install-host-units: FATAL — RMD_STATE_DIR must be absolute, got '${STATE_DIR}'." >&2; exit 2 ;; esac
case "$CONTAINER_NAME" in *[!a-zA-Z0-9_.-]*|"") echo "install-host-units: FATAL -- container name must be Docker-safe, got '${CONTAINER_NAME}'." >&2; exit 2 ;; esac
case "$SERVICE_UNIT_NAME" in *.service) : ;; *) echo "install-host-units: FATAL -- service_name must end in .service, got '${SERVICE_UNIT_NAME}'." >&2; exit 2 ;; esac
case "$WATCHDOG_SERVICE_NAME" in *.service) : ;; *) echo "install-host-units: FATAL -- watchdog_service_name must end in .service, got '${WATCHDOG_SERVICE_NAME}'." >&2; exit 2 ;; esac
case "$WATCHDOG_TIMER_NAME" in *.timer) : ;; *) echo "install-host-units: FATAL -- watchdog_timer_name must end in .timer, got '${WATCHDOG_TIMER_NAME}'." >&2; exit 2 ;; esac
require_abs_path "launcher_path" "$LAUNCHER"
require_abs_path "revival_log" "$REVIVAL_LOG"
require_abs_path "claude_dir" "$CLAUDE_DIR"
require_abs_path "codex_dir" "$CODEX_DIR"
require_abs_path "container_config_dir" "$CONTAINER_CONFIG_DIR"

render_launcher() {
  cat <<EOF
#!/usr/bin/env bash
# Canonical daemon launcher. GENERATED by deploy/install-host-units.sh — edit that, not this.
# The invocation itself is derived from: deploy/host-update.sh --print-daemon-run
# (run it with RMD_STATE_DIR set; its default points at a volume that may hold no ledger).
set -euo pipefail
STATE_DIR=${STATE_DIR}
IMAGE=${IMAGE}
REVIVAL_LOG=${REVIVAL_LOG}
# W1-T3269 — the checkout this host converges FROM, and the heap the installer requires. Rendered
# in rather than re-derived, so the converge below uses the same inputs this file was rendered with.
CHECKOUT=${STATE_DIR}/remudero
UNITS_HEAP_MB=${MAX_OLD_SPACE_MB}
INSTANCE_NAME=${INSTANCE_NAME:-}
INSTANCE_REGISTRY=${REGISTRY_FILE:-}
BOOT=0
[ "\${1:-}" = "--boot" ] && BOOT=1

# W1-T3233 — THE REVIVAL LOG'S READER. The record below has been written since W1-T2877 and read by
# nothing. On 2026-09-09 a core.bare flag in the state checkout made entrypoint.sh exit 1, and this
# five-minute timer revived the container into the identical death ~90 times across 7h32m of total
# fleet downtime. docker's own --restart=on-failure:5 could not bound it, because recreating the
# container RESETS RestartCount -- the very fact the record exists to make visible.
#
# COUNTS AND ANNOUNCES: it never refuses to revive. The ninety revivals were wasted, not wrong: the
# same watchdog is what recovers a host from a transient, and a bound that gives up is strictly
# worse than the problem. Exit 0 is excluded because --restart=on-failure:5 is deliberate so a
# clean STOP is never undone -- a run of zeros is an operator stopping a healthy fleet.
CRASH_LOOP_RUN=5

# W1-T3268 — A RUN MUST BE CONTIGUOUS IN TIME, NOT ONLY IN THE FILE. MEASURED on this host at
# 2026-09-09T19:18Z the unbounded reader answered "88 1" while the daemon had been running 25
# minutes with RestartCount=0: those 88 were that morning's RESOLVED incident, newest record
# 10:15:01Z. The log is append-only for the host's life, so a resolved run stayed armed forever and
# the next ordinary exit-1 revival would have raised CRASH LOOP on a single transient.
# THE CEILING IS SIZED FROM THE CADENCE: the tick is 5 minutes, so live revivals are ~300s apart
# and the gap to the read was ~9 hours. 1800s sits an order of magnitude clear of both.
CRASH_LOOP_GAP_S=1800

# Seconds since the epoch for an ISO-8601 UTC stamp, computed ARITHMETICALLY: \`mktime\` is a gawk
# extension absent on other awks, where a missing function is a silent empty result, not an error.
CRASH_LOOP_EPOCH_AWK='
function epoch(ts,   y, mo, d, h, mi, s, yy, era, yoe, doy, doe, days) {
  y = substr(ts, 1, 4) + 0; mo = substr(ts, 6, 2) + 0; d = substr(ts, 9, 2) + 0
  h = substr(ts, 12, 2) + 0; mi = substr(ts, 15, 2) + 0; s = substr(ts, 18, 2) + 0
  if (y == 0) return -1
  yy = (mo <= 2) ? y - 1 : y
  era = int((yy >= 0 ? yy : yy - 399) / 400)
  yoe = yy - era * 400
  doy = int((153 * (mo + ((mo > 2) ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  days = era * 146097 + doe - 719468
  return days * 86400 + h * 3600 + mi * 60 + s
}
'

# Prints "<count> <exit>" for the trailing run of identical NON-ZERO prev_exit values in \$1, or
# nothing when there is no such run. Reads the log this same script appends to, so the format has
# exactly one definition. \$2 overrides "now" (epoch seconds) so the suite can pin the clock.
crash_loop_signature() {
  awk -v gap="\$CRASH_LOOP_GAP_S" -v now="\${2:-\$(date -u +%s)}" "\$CRASH_LOOP_EPOCH_AWK"'
    match(\$0, /prev_exit=[^ ]+/) {
      e = substr(\$0, RSTART + 10, RLENGTH - 10)
      t = epoch(\$1)
      # A gap wider than the ceiling ENDS the run even when the exit code repeats, so two separate
      # incidents sharing an exit code are never summed into one.
      if (e == last && t >= 0 && lastT >= 0 && t - lastT <= gap) { n += 1 } else { n = 1 }
      last = e; lastT = t
    }
    END {
      # And the run must be recent relative to NOW. A run that was dense nine hours ago and then
      # stopped is a resolved incident, which is the case measured on the live host.
      if (last != "" && last != "0" && last != "none" && lastT >= 0 && now - lastT <= gap) print n, last
    }
  ' "\$1" 2>/dev/null
}
# W1-T2953: the backticks here were UNESCAPED inside an unquoted heredoc, so bash EXECUTED this
# comment while rendering — printing a syntax error and substituting its empty output into the
# shipped launcher. \`--check-crash-loop <log>\` prints the signature and exits, touching nothing
# else. It exists so the
# suite can exercise this logic against a fixture without docker, a state root or a real host.
if [ "\${1:-}" = "--check-crash-loop" ]; then
  crash_loop_signature "\${2:-\$REVIVAL_LOG}"
  exit 0
fi

# W1-T3269 — CONVERGE THIS HOST'S OWN UNITS, THE THIRD QUESTION THIS TICK ALREADY ASKS.
#
# The installer had NO automatic caller -- referenced only by its own test, the operator guide and a
# size baseline -- so it converged when a person remembered. MEASURED 2026-09-09: check mode read
# DRIFTED against a checkout clean and exactly at origin/main. The code had shipped that morning;
# the rendered artifact had not. The tick already asks "is the daemon down" and, since W1-T3245,
# "is the image behind"; this is the same question about a third artifact class on the same cadence.
# THREE DECISION FUNCTIONS IN ONE TICK, NEVER ONE WEIGHTED SCORE -- the signals differ in frequency,
# cost and blast radius, so a weighted sum is dominated by the cheapest and most frequent.
# THE REFUSALS ARE THE DELIVERABLE: a five-minute timer holding root write access to systemd units
# is only safe because it declines in every case it cannot justify.
converge_host_units() {
  # A DIRTY OR OFF-MAIN CHECKOUT IS NEVER INSTALLED -- the whole safety argument. Without it a
  # worktree experiment becomes root systemd configuration on the next tick.
  [ -d "\$CHECKOUT/.git" ] || { echo "rmd-relaunch: units -- \$CHECKOUT is not a checkout; not converging."; return 0; }
  if [ -n "\$(git -C "\$CHECKOUT" status --porcelain 2>/dev/null)" ]; then
    echo "rmd-relaunch: units -- checkout is DIRTY; not converging (an unreviewed tree must never become root config)."
    return 0
  fi

  # W1-T3583 -- READABLE AND ON MAIN, BEFORE ANY UPDATE. A detached HEAD, a foreign branch or a
  # corrupted .git is named here and left alone; nothing below this point may switch, rebase or
  # reset it onto main -- only an ff-only merge of a checkout that is ALREADY on it.
  branch=\$(git -C "\$CHECKOUT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  if [ "\$branch" != "main" ]; then
    echo "rmd-relaunch: units -- checkout is unreadable or not on branch main (branch='\${branch:-none}'); not converging." >&2
    return 0
  fi

  # W1-T3583 -- ADVANCE THE ALREADY-TRUSTED CHECKOUT WITHOUT A DAEMON RESTART. runDeployCycle's own
  # fast-forward (deployer.ts's pullFf) runs only behind its restart-pressure decision, so a clean,
  # below-threshold installer-only change never reaches it -- this checkout would otherwise sit
  # fetched-but-unmerged, and the check below would refuse it on every tick forever. FETCH AND
  # FF-ONLY MERGE ONLY, as the service user -- never a reset, a rebase or a clean -- so a genuine
  # divergence is named here and never silently overwritten.
  if ! git -C "\$CHECKOUT" fetch --quiet origin main 2>/dev/null; then
    echo "rmd-relaunch: units -- fetch of origin/main FAILED; not converging." >&2
    return 0
  fi
  if ! git -C "\$CHECKOUT" merge --ff-only --quiet origin/main 2>/dev/null; then
    echo "rmd-relaunch: units -- checkout DIVERGED from origin/main (fast-forward refused); not converging." >&2
    return 0
  fi

  # CHECK BEFORE INSTALL, ALWAYS. The steady state is a silent no-op, which is what makes a converge
  # event rare enough to be worth a record.
  head_sha=\$(git -C "\$CHECKOUT" rev-parse HEAD 2>/dev/null || echo unknown)
  INSTALLER_ARGS=()
  INSTALLER_ENV=(RMD_NODE_MAX_OLD_SPACE_MB="\$UNITS_HEAP_MB")
  if [ -n "\$INSTANCE_NAME" ]; then
    INSTALLER_ARGS=(--instance "\$INSTANCE_NAME")
    INSTALLER_ENV=(RMD_INSTANCE_REGISTRY="\$INSTANCE_REGISTRY")
  fi
  if env "\${INSTALLER_ENV[@]}" "\$CHECKOUT/deploy/install-host-units.sh" "\${INSTALLER_ARGS[@]}" >/dev/null 2>&1; then
    return 0
  fi

  # Elevation is REQUIRED and never prompted for: the tick runs as the service user while the unit
  # dir is root-owned. No sudo, no converge -- reported, never fatal.
  if ! sudo -n true 2>/dev/null; then
    echo "rmd-relaunch: units -- DRIFTED but cannot elevate (sudo -n refused); leaving them alone." >&2
    return 0
  fi

  echo "rmd-relaunch: units DRIFTED at \$head_sha -- converging."
  if sudo -n env "\${INSTALLER_ENV[@]}" "\$CHECKOUT/deploy/install-host-units.sh" --install "\${INSTALLER_ARGS[@]}"; then
    printf '%s units-converged sha=%s\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$head_sha" >> "\$REVIVAL_LOG" 2>/dev/null || true
  else
    echo "rmd-relaunch: units -- converge FAILED; the next tick re-asks." >&2
  fi
  return 0
}

# THE STOP LEVER OUTRANKS THIS SCRIPT, INCLUDING AT BOOT AND FROM THE WATCHDOG.
if [ -e "\$STATE_DIR/state/STOP" ]; then
  echo "rmd-relaunch: state/STOP present -- refusing to start. rm it to resume."
  exit 0
fi

# IDEMPOTENT. A five-minute timer must never disturb a healthy daemon or its in-flight workers.
#
# W1-T3245 — AND THIS IS WHERE A RECYCLE IS CONSIDERED, IN THE SAME TICK. Reconciliation is
# LEVEL-TRIGGERED: this loop already reads observed state ("is the daemon running") and converges,
# so asking "is the image current" is the same loop asking a second question about the same desired
# state. A separate timer would be a second reconciler over one subject.
#
# TWO DECISIONS, NOT ONE SCORE, and only ONE of them belongs here:
#   RESTART (mount-side) is ALREADY HANDLED and is not this tick's business -- the daemon's own
#           freshness check exits 75 and the entrypoint re-fetches, tens of times a day, in seconds.
#           Acting on it here would put a second actor on the daemon's own job and race it.
#   RECYCLE (image-side) has no other actor: nothing INSIDE a container can replace the image it is
#           running on, and this script is the only thing outside it that runs on a cadence.
# The --image-drift-only flag is what makes the tick blind to the first and awake to the second.
#
# THE DECISION IS NOT MADE HERE. The deploy-run supervisor owns it: the idle gate (no worker, no
# in-flight task, bounded by DEPLOY_IDLE_DEFER_CEILING_MS), the drift reading, the health check and
# the rollback -- and it reaches deploy/recycle-container.sh, whose four refusals are the
# deliverable (no credential, workers still running, a failed pull, a digest mismatch). A tick with
# no drift does nothing at all, so this is DRIFT-driven and not clock-driven; the clock only sets
# how often the question is asked.
if [ -n "\$(docker ps -q -f name='^${CONTAINER_NAME}\$' 2>/dev/null)" ]; then
  # W1-T3268 -- THE FLAG'S ONLY PATH BACK. The arm that cleared DAEMON_CRASH_LOOP sat on the
  # revival path below, after this very return, so a host that recovered stopped reviving and never
  # reached it. This is the one place the script observes the daemon HEALTHY.
  rm -f "\$STATE_DIR/state/DAEMON_CRASH_LOOP" 2>/dev/null || true
  # CONVERGENCE IS LAST AND ONLY WHEN HEALTHY. A DOWN host needs reviving, not tidying, so nothing
  # here runs before the revive decision; boot is excluded because a host coming up is the worst
  # moment to rewrite its units -- the rule W1-T3245 applied to the recycle decision.
  [ "\$BOOT" -eq 0 ] && converge_host_units
  if [ "\$BOOT" -eq 0 ] && [ -x "\$STATE_DIR/remudero/bin/rmd" ]; then
    echo "rmd-relaunch: ${CONTAINER_NAME} healthy -- asking the supervisor whether a RECYCLE is due."
    "\$STATE_DIR/remudero/bin/rmd" deploy-run --image-drift-only || \\
      echo "rmd-relaunch: deploy-run reported a problem; the daemon is untouched and the next tick re-asks." >&2
  else
    echo "rmd-relaunch: ${CONTAINER_NAME} already running -- nothing to do."
  fi
  exit 0
fi

# REFUSE AGAINST AN UNMOUNTED STATE ROOT -- the 2026-09-05 fleet-wipe failure mode.
if ! findmnt -no TARGET /mnt/rmd >/dev/null 2>&1; then
  echo "rmd-relaunch: FATAL -- /mnt/rmd is not mounted. Refusing to start against the bare OS disk." >&2
  exit 1
fi
if [ ! -s "\$STATE_DIR/state/ledger.ndjson" ]; then
  echo "rmd-relaunch: FATAL -- \$STATE_DIR/state/ledger.ndjson missing or empty; wrong volume?" >&2
  exit 1
fi

# A REVIVAL MUST LEAVE A TRACE. Recreating the container RESETS docker's RestartCount, so without
# this record a crash loop is invisible: every beat is fresh and every daemon is young.
printf '%s revive boot=%s prev_status=%s prev_exit=%s prev_restarts=%s\n' \\
  "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$BOOT" \\
  "\$(docker inspect ${CONTAINER_NAME} --format '{{.State.Status}}' 2>/dev/null || echo none)" \\
  "\$(docker inspect ${CONTAINER_NAME} --format '{{.State.ExitCode}}' 2>/dev/null || echo none)" \\
  "\$(docker inspect ${CONTAINER_NAME} --format '{{.RestartCount}}' 2>/dev/null || echo none)" \\
  >> "\$REVIVAL_LOG" 2>/dev/null || true

# THE COUNT IS TAKEN AFTER the STOP refusal, the idempotence check and the mount checks, so none of
# their precedence changes. It writes a marker and a log line; the revive below happens regardless.
CRASH_LOOP_SIG="\$(crash_loop_signature "\$REVIVAL_LOG")"
CRASH_LOOP_N="\${CRASH_LOOP_SIG%% *}"
if [ -n "\$CRASH_LOOP_SIG" ] && [ "\$CRASH_LOOP_N" -ge "\$CRASH_LOOP_RUN" ] 2>/dev/null; then
  CRASH_LOOP_EXIT="\${CRASH_LOOP_SIG##* }"
  echo "rmd-relaunch: CRASH LOOP -- \$CRASH_LOOP_N consecutive revivals from exit \$CRASH_LOOP_EXIT. Reviving anyway; this needs a human." >&2
  printf '%s crash-loop count=%s exit=%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$CRASH_LOOP_N" "\$CRASH_LOOP_EXIT" \\
    >> "\$REVIVAL_LOG" 2>/dev/null || true
  printf '%s %s consecutive revivals from exit %s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$CRASH_LOOP_N" "\$CRASH_LOOP_EXIT" \\
    > "\$STATE_DIR/state/DAEMON_CRASH_LOOP" 2>/dev/null || true
else
  rm -f "\$STATE_DIR/state/DAEMON_CRASH_LOOP" 2>/dev/null || true
fi

docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1 || true

# --restart=on-failure:5 IS DELIBERATE: exit 0 is a STOP and must not be undone. Reboot survival is
# rmd-fleet.service; crash recovery past the budget is rmd-fleet-watchdog.timer.
# NODE_OPTIONS: without it V8 caps at ~2GB and the retro rung aborts at ~2046 MB on a 7.9GB host.
docker run -d --name ${CONTAINER_NAME} \\
  --restart=on-failure:5 \\
  --cap-drop ALL \\
  --security-opt seccomp=unconfined \\
  --security-opt apparmor=unconfined \\
  --security-opt systempaths=unconfined \\
  --user 1000:1000 \\
  -e GH_APP_ID=${GH_APP_ID_V} \\
  -e GH_APP_INSTALLATION_ID=${GH_APP_INST_V} \\
  -e GH_APP_PRIVATE_KEY_PATH=${GH_APP_KEY_V} \\
  -e NODE_OPTIONS=--max-old-space-size=${MAX_OLD_SPACE_MB} \\
  -e RMD_RESTART_THROTTLE_S=120 \\
  -e RMD_FRESHNESS_RESTART_MAX=100 \\
  -v ${CODEX_DIR}:/home/node/.codex \\
  -v ${CONTAINER_CONFIG_DIR}:/home/node/.config/remudero \\
  -v "\$STATE_DIR":/home/node/Remudero \\
  -v ${CLAUDE_DIR}:/home/node/.claude \\
  "\$IMAGE" \\
  ./bin/rmd daemon --repo ${DAEMON_REPO} --allow-self-target

echo "rmd-relaunch: started ${CONTAINER_NAME} (boot=\$BOOT)"
EOF
}

render_fleet_service() {
  cat <<EOF
[Unit]
Description=Remudero fleet daemon launcher (canonical invocation)
Documentation=https://github.com/craigoley/remudero
Requires=docker.service
After=docker.service network-online.target
# The daemon runs --restart=on-failure:5 so a DELIBERATE stop (exit 0) is not undone by docker.
# That also means docker will not bring it back after a clean reboot, so reboot survival is this
# unit's job. serve and cloudflared are unless-stopped and revive on their own.
RequiresMountsFor=/mnt/rmd /var/lib/containerd ${STATE_DIR}

[Service]
Type=oneshot
RemainAfterExit=yes
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${LAUNCHER} --boot
Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
EOF
}

render_watchdog_service() {
  cat <<EOF
[Unit]
Description=Remudero fleet watchdog (revive a daemon docker has given up on)
# --restart=on-failure:5 caps the COUNT, not the rate: once five failures are spent docker NEVER
# tries again. On 2026-09-05 six heap aborts exhausted it and the fleet sat dead for three hours.
# The script is idempotent and refuses on state/STOP, so this cannot resurrect a deliberate stop.
RequiresMountsFor=/mnt/rmd /var/lib/containerd ${STATE_DIR}
After=docker.service

[Service]
Type=oneshot
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${LAUNCHER}
EOF
}

render_watchdog_timer() {
  cat <<EOF
[Unit]
Description=Revive the Remudero daemon if docker has given up on it

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=${WATCHDOG_SERVICE_NAME}

[Install]
WantedBy=timers.target
EOF
}

render_reaper_bin() {
  cat <<'EOF'
#!/bin/bash
# Reap ad-hoc rmd-* containers that outlived any legitimate run.
# GENERATED by deploy/install-host-units.sh — edit that, not this.
#
# WHY: 2026-09-04 a hand-run `docker run --name rmd-preflight-...` (no --rm) finished its suite and
# then spawned 158 nested self-hosting daemons over 7 hours, holding ~90% of a core on a 4-CPU box.
# Load hit 9.5, sshd could not complete a handshake, and the forced reboot that followed exposed a
# second defect that wiped the fleet.
#
# SCOPE IS DELIBERATELY NARROW. Only names beginning `rmd-` are candidates: the ad-hoc/preflight
# namespace. The long-lived fleet (remudero-daemon, remudero-serve, cloudflared) can never match,
# so this cannot take the fleet down.
#
# THE AGE GATE IS SIZED FROM A MEASUREMENT. A real `preflight --ci-parity` on the fleet host
# measured 24m48s (4386 tests, 0 failures). 4h is ~10x that, so a healthy run is never at risk;
# the leaked one had run 10h.
set -u
THRESHOLD_S=$((4*60*60))
now=$(date +%s)
for name in $(docker ps --format "{{.Names}}" | grep "^rmd-" || true); do
  started=$(docker inspect "$name" --format "{{.State.StartedAt}}" 2>/dev/null) || continue
  s=$(date -d "$started" +%s 2>/dev/null) || continue
  age=$(( now - s ))
  if [ "$age" -gt "$THRESHOLD_S" ]; then
    logger -t rmd-reap "removing stray container $name (age ${age}s > ${THRESHOLD_S}s)"
    docker rm -f "$name" >/dev/null 2>&1 && logger -t rmd-reap "removed $name"
  fi
done
EOF
}

render_reaper_service() {
  cat <<EOF
[Unit]
Description=Reap ad-hoc rmd-* containers that outlived any legitimate run
# W1-T2953: both lines are live on Azure and neither was rendered. Without `After=docker.service`
# the sweep can run before the socket exists and reap nothing while reporting success; without the
# mount requirement it can run against an unmounted /mnt/rmd — the 2026-09-05 fleet-wipe surface.
After=docker.service
RequiresMountsFor=/mnt/rmd

[Service]
Type=oneshot
ExecStart=${BIN_DIR}/rmd-reap-stray-containers
EOF
}

render_reaper_timer() {
  cat <<'EOF'
[Unit]
Description=Hourly sweep for stray rmd-* containers

[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
# W1-T2953: live on Azure, absent from the renderer. Without it a sweep missed while the host was
# down is simply skipped — and a host that was down is exactly the one most likely to have leaked
# a container. A leaked ad-hoc container once spawned 158 nested daemons and held ~90% of a core.
# No `Unit=`: a .timer defaults to the same-basename .service, which is what the live unit relies
# on. Rendering it explicitly would be equivalent in effect and would read as DRIFT against the
# installed host, which is the one thing check mode must not do.
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

# W1-T2953 — CHECK COMPARES DIRECTIVES, INSTALL WRITES EVERYTHING.
#
# The comparison was byte-for-byte over files that are mostly PROSE. MEASURED 2026-09-06: six of
# seven artifacts read DRIFTED against Azure, and most of that was comment wording — the incident
# forensics were expanded by hand on the host and never returned to the renderer. One red check
# covering four real guard deletions and two paragraphs of prose is a check nobody can act on, and
# `--install` looked like the remedy while it would have DELETED the four real guards.
#
# A systemd unit's semantics ARE its directives; comments are documentation. So check compares the
# effective directive lines EXACTLY — every guard deletion is still caught, byte for byte in effect
# — and stops reporting prose as drift. INSTALL is unchanged and still writes the full rendered
# text, comments included, so the host keeps the documentation.
effective_directives() {
  printf '%s\n' "$1" | sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d'
}

# path : renderer : mode
UNITS="
${LAUNCHER}:render_launcher:0755
${UNIT_DIR}/${SERVICE_UNIT_NAME}:render_fleet_service:0644
${UNIT_DIR}/${WATCHDOG_SERVICE_NAME}:render_watchdog_service:0644
${UNIT_DIR}/${WATCHDOG_TIMER_NAME}:render_watchdog_timer:0644
"
if [ -z "$INSTANCE_NAME" ] || [ "$INSTANCE_NAME" = "core" ]; then
  UNITS="${UNITS}
${BIN_DIR}/rmd-reap-stray-containers:render_reaper_bin:0755
${UNIT_DIR}/rmd-reap-stray.service:render_reaper_service:0644
${UNIT_DIR}/rmd-reap-stray.timer:render_reaper_timer:0644
"
fi

drift=0
for row in $UNITS; do
  [ -n "$row" ] || continue
  path="${row%%:*}"; rest="${row#*:}"; fn="${rest%%:*}"; mode="${rest##*:}"
  want="$("$fn")"
  if [ "$MODE" = "check" ]; then
    if [ ! -e "$path" ]; then
      echo "install-host-units: MISSING $path"
      drift=$(( drift + 1 ))
    elif [ "$(effective_directives "$want")" != "$(effective_directives "$(cat "$path" 2>/dev/null)")" ]; then
      echo "install-host-units: DRIFTED $path (installed DIRECTIVES differ from what this repo renders)"
      drift=$(( drift + 1 ))
    else
      echo "install-host-units: ok      $path"
    fi
  else
    mkdir -p "$(dirname "$path")"
    tmp="${path}.tmp.$$"
    printf '%s\n' "$want" > "$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$path"                       # atomic: never a half-written unit
    echo "install-host-units: wrote   $path"
  fi
done

if [ "$MODE" = "check" ]; then
  if [ "$drift" -gt 0 ]; then
    echo "install-host-units: ${drift} unit(s) missing or drifted — re-run with --install (as root)." >&2
    exit 1
  fi
  echo "install-host-units: all units match this repo."
  exit 0
fi

# Only touch systemd when it is really systemd — the test suite renders into a temp tree.
if [ "$UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable "${SERVICE_UNIT_NAME}" >/dev/null
  systemctl enable --now "${WATCHDOG_TIMER_NAME}" >/dev/null
  if [ -z "$INSTANCE_NAME" ] || [ "$INSTANCE_NAME" = "core" ]; then
    systemctl enable --now rmd-reap-stray.timer >/dev/null
    echo "install-host-units: reloaded systemd and enabled ${SERVICE_UNIT_NAME}, ${WATCHDOG_TIMER_NAME}, rmd-reap-stray.timer"
  else
    echo "install-host-units: reloaded systemd and enabled ${SERVICE_UNIT_NAME}, ${WATCHDOG_TIMER_NAME}"
  fi
  echo "install-host-units: NOTE — the daemon itself was not started or stopped; run ${LAUNCHER} to bring it up."
fi
