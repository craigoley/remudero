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
#   RMD_GH_APP_PRIVATE_KEY_HOST_PATH                   optional explicit read-only file mount
#   RMD_UNIT_DIR RMD_BIN_DIR RMD_LAUNCHER_PATH RMD_REVIVAL_LOG
#   RMD_CLEANUP_PATH RMD_CLEANUP_LOG RMD_CRONTAB_CMD   (W1-T4770: root-disk janitor + cron)
#   RMD_TMP_SWEEP_PATH RMD_TMP_SWEEP_CRON_PATH          (W1-T5036: guarded hourly temp sweep)
#   RMD_LEGACY_USER_UNIT_DIR RMD_HOST_KERNEL            (W1-T5518: legacy user janitor is drift)
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

# W1-T4863 — THE CREDENTIAL HAS ONE OWNER. Every instance gets its OWN writable claude_dir (D-11:
# nothing mutable shared), so transcripts, settings and token refreshes of three daemons no longer
# land in one directory. The subscription credential is the one thing that must still be shared, and
# it is shared READ-ONLY: the `primary: true` instance's claude_dir holds the one writable copy (the
# one refresher); every other instance bind-mounts that file :ro over its own directory. The owner is
# read from the registry's existing `primary` marker, so no new field is added (both shell readers
# refuse fields they do not know). Prints nothing when no live row is primary.
registry_primary_claude_dir() {
  awk '
    function flush() { if (prim && !ret && dir != "" && out == "") out = dir }
    { sub(/[[:space:]]+#.*/, "") }
    /^[[:space:]]*$/ { next }
    $0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { flush(); dir = ""; prim = 0; ret = 0; next }
    $0 ~ /^    claude_dir:/ { v = $0; sub(/^    claude_dir:[[:space:]]*/, "", v); gsub(/^"|"$/, "", v); dir = v }
    $0 ~ /^    primary:[[:space:]]*true/ { prim = 1 }
    $0 ~ /^    retired:[[:space:]]*true/ { ret = 1 }
    END { flush(); if (out != "") print out }
  ' "$1"
}

# The launcher's credential lines. Empty for the owner (its own claude_dir already holds the one
# writable credential); a non-owner refuses when the owner's file is absent, because docker would
# otherwise create a DIRECTORY at the mount source and the daemon would boot unauthenticated.
render_credential_mount() {
  [ -n "$CREDENTIAL_READONLY_SOURCE" ] || return 0
  cat <<EOF
if [ ! -f ${CREDENTIAL_READONLY_SOURCE} ]; then
  echo "rmd-relaunch: REFUSING — the credential owner's file ${CREDENTIAL_READONLY_SOURCE} is missing." >&2
  exit 1
fi
CREDENTIAL_ARGS=(-v ${CREDENTIAL_READONLY_SOURCE}:/home/node/.claude/.credentials.json:ro)
EOF
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
GH_APP_KEY_HOST_V="${RMD_GH_APP_PRIVATE_KEY_HOST_PATH:-}"
CLAUDE_DIR="${RMD_CLAUDE_DIR:-/home/${SERVICE_USER}/.claude}"
CODEX_DIR="${RMD_CODEX_DIR:-/home/${SERVICE_USER}/.codex}"
CONTAINER_CONFIG_DIR="${RMD_CONTAINER_CONFIG_DIR:-/home/${SERVICE_USER}/.config/remudero-container}"
CASH_SECRET_DIR="${RMD_CASH_SECRET_DIR:-/home/${SERVICE_USER}/.local/share/remudero/secrets}"
UNIT_DIR="${RMD_UNIT_DIR:-/etc/systemd/system}"
BIN_DIR="${RMD_BIN_DIR:-/usr/local/bin}"
LAUNCHER="${RMD_LAUNCHER_PATH:-/home/${SERVICE_USER}/rmd-relaunch.sh}"
REVIVAL_LOG="${RMD_REVIVAL_LOG:-/home/${SERVICE_USER}/rmd-revivals.log}"
SERVICE_UNIT_NAME="rmd-fleet.service"
WATCHDOG_SERVICE_NAME="rmd-fleet-watchdog.service"
WATCHDOG_TIMER_NAME="rmd-fleet-watchdog.timer"
REGISTRY_FILE="${RMD_INSTANCE_REGISTRY:-}"
# W1-T4863: empty = no registry names an owner, so nothing is overlaid read-only.
CREDENTIAL_OWNER_DIR=""
CREDENTIAL_READONLY_SOURCE=""

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
      gh_app_private_key_host_path) GH_APP_KEY_HOST_V="$value" ;;
      claude_dir) claude_dir="$value" ;;
      codex_dir) codex_dir="$value" ;;
      container_config_dir) container_config_dir="$value" ;;
      # W1-T4227: the fleet registry's project layer, read by `rmd serve`'s GET /v1/registry.
      project|github_repo|retired|primary) : ;;
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
  CREDENTIAL_OWNER_DIR="$(registry_primary_claude_dir "$REGISTRY_FILE")"
fi

# REFUSE RATHER THAN GUESS. Same posture `--print-daemon-run` takes when it cannot find a ledger:
# a wrong state root is silent, and lands PAUSE/STOP where nothing reads them.
for pair in "STATE_DIR:$STATE_DIR" "IMAGE:$IMAGE" "SERVICE_USER:$SERVICE_USER" "MAX_OLD_SPACE_MB:$MAX_OLD_SPACE_MB" "CONTAINER_NAME:$CONTAINER_NAME" "DAEMON_REPO:$DAEMON_REPO"; do
  name="${pair%%:*}"; val="${pair#*:}"
  [ -n "$val" ] || { echo "install-host-units: FATAL — ${name} resolved to empty; pass RMD_${name}." >&2; exit 2; }
done
case "$MAX_OLD_SPACE_MB" in ''|*[!0-9]*) echo "install-host-units: FATAL — RMD_NODE_MAX_OLD_SPACE_MB must be an integer, got '${MAX_OLD_SPACE_MB}'." >&2; exit 2 ;; esac
case "$STATE_DIR" in /*) : ;; *) echo "install-host-units: FATAL — RMD_STATE_DIR must be absolute, got '${STATE_DIR}'." >&2; exit 2 ;; esac

# The install root installs only what main holds: a hand edit there went live unmerged on 2026-10-01
# and blocked deploy-run. No optional locks, so a sudo run never writes a root-owned index.
if [ "$MODE" = "install" ] && [ -d "${STATE_DIR}/daemon-install" ] && \
   [ "$(cd "${SCRIPT_DIR}/.." && pwd -P)" = "$(cd "${STATE_DIR}/daemon-install" && pwd -P)" ]; then
  if ! local_edits="$(GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -C "${SCRIPT_DIR}/.." status --porcelain 2>&1)"; then
    local_edits="git status failed: ${local_edits}"
  fi
  if [ -n "$local_edits" ]; then
    echo "install-host-units: FATAL -- the install root ${STATE_DIR}/daemon-install has local edits; it installs only what origin/main holds:" >&2
    printf '%s\n' "$local_edits" | sed 's/^/  /' >&2
    echo "  Land the change as a PR; rmd deploy-run fast-forwards this checkout and installs it." >&2
    exit 2
  fi
fi
case "$CONTAINER_NAME" in *[!a-zA-Z0-9_.-]*|"") echo "install-host-units: FATAL -- container name must be Docker-safe, got '${CONTAINER_NAME}'." >&2; exit 2 ;; esac
case "$SERVICE_UNIT_NAME" in *.service) : ;; *) echo "install-host-units: FATAL -- service_name must end in .service, got '${SERVICE_UNIT_NAME}'." >&2; exit 2 ;; esac
case "$WATCHDOG_SERVICE_NAME" in *.service) : ;; *) echo "install-host-units: FATAL -- watchdog_service_name must end in .service, got '${WATCHDOG_SERVICE_NAME}'." >&2; exit 2 ;; esac
case "$WATCHDOG_TIMER_NAME" in *.timer) : ;; *) echo "install-host-units: FATAL -- watchdog_timer_name must end in .timer, got '${WATCHDOG_TIMER_NAME}'." >&2; exit 2 ;; esac
require_abs_path "launcher_path" "$LAUNCHER"
require_abs_path "revival_log" "$REVIVAL_LOG"
require_abs_path "claude_dir" "$CLAUDE_DIR"
if [ -n "$CREDENTIAL_OWNER_DIR" ]; then
  require_abs_path "primary claude_dir" "$CREDENTIAL_OWNER_DIR"
  [ "$CREDENTIAL_OWNER_DIR" = "$CLAUDE_DIR" ] || CREDENTIAL_READONLY_SOURCE="${CREDENTIAL_OWNER_DIR}/.credentials.json"
fi
require_abs_path "codex_dir" "$CODEX_DIR"
require_abs_path "container_config_dir" "$CONTAINER_CONFIG_DIR"
require_abs_path "cash_secret_dir" "$CASH_SECRET_DIR"
CASH_SECRET_DIR_SHELL="$(printf '%q' "$CASH_SECRET_DIR")"
if [ -n "$GH_APP_KEY_HOST_V" ]; then
  . "$SCRIPT_DIR/app-private-key-mount.sh"
  app_private_key_mount_args "$GH_APP_KEY_HOST_V" "$GH_APP_KEY_V" || exit 2
fi
GH_APP_KEY_SHELL="$(printf '%q' "$GH_APP_KEY_V")"

render_app_private_key_mount() {
  [ -n "$GH_APP_KEY_HOST_V" ] || return 0
  cat "$SCRIPT_DIR/app-private-key-mount.sh"
  printf '\napp_private_key_mount_args %q %q || exit 1\n' "$GH_APP_KEY_HOST_V" "$GH_APP_KEY_V"
}

# Insert literal shell into the rendered launcher. The outer launcher heredoc is expanded by the
# installer, so writing dollar signs directly there would read the installer's environment instead
# of the daemon host's environment at boot.
render_cash_boot_secrets() {
  cat <<'CASH_BOOT_SECRETS'
# A host reboot must recover the same cash credentials as a recycle. Data files are mode 0600;
# their values stay in this process's environment and never enter docker's argv or a unit file.
read_cash_boot_secret() {
  local path="$1" mode value
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  if mode="$(stat -c '%a' "$path" 2>/dev/null)"; then :
  elif mode="$(stat -f '%Lp' "$path" 2>/dev/null)"; then :
  else mode=""; fi
  [ "$mode" = 600 ] || return 1
  value="$(awk 'NF { count++; last=$0 } END { if (count == 1) print last; else exit 1 }' "$path" 2>/dev/null)" || return 1
  value="${value%$'\r'}"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

if [ -z "${RMD_OPENWEIGHT_API_KEY:-}" ]; then
  RMD_OPENWEIGHT_API_KEY="$(read_cash_boot_secret "${RMD_OPENWEIGHT_API_KEY_PATH:-$CASH_SECRET_DIR/openweight-api-key}")" ||
    echo "rmd-relaunch: cash API key unavailable; subscription work remains available" >&2
fi
if [ -z "${RMD_FOUNDRY_CLAUDE_API_KEY:-}" ]; then
  RMD_FOUNDRY_CLAUDE_API_KEY="$(read_cash_boot_secret "${RMD_FOUNDRY_CLAUDE_API_KEY_PATH:-$CASH_SECRET_DIR/foundry-claude-api-key}")" ||
    echo "rmd-relaunch: Foundry key unavailable; cash Opus remains unavailable" >&2
fi
if [ -z "${RMD_FOUNDRY_CLAUDE_ENDPOINT:-}" ]; then
  RMD_FOUNDRY_CLAUDE_ENDPOINT="$(read_cash_boot_secret "${RMD_FOUNDRY_CLAUDE_ENDPOINT_PATH:-$CASH_SECRET_DIR/foundry-claude-endpoint}")" ||
    echo "rmd-relaunch: Foundry endpoint unavailable; cash Opus remains unavailable" >&2
fi
export RMD_OPENWEIGHT_API_KEY RMD_FOUNDRY_CLAUDE_API_KEY RMD_FOUNDRY_CLAUDE_ENDPOINT
CASH_BOOT_SECRETS
}

# Literal shell keeps the installer's environment out of the watchdog's preflight.
render_deploy_code_refresh() {
  cat <<'DEPLOY_CODE_REFRESH'
deploy_code_idle() {
  local container="$1" processes dir locks match_status
  if ! processes="$(docker top "$container" -eo pid,args 2>/dev/null)" || [ -z "$processes" ]; then
    echo "rmd-relaunch: deploy code -- worker probe unreadable; deferring." >&2
    return 1
  fi
  if printf '%s\n' "$processes" | grep -E 'claude .*--output-format|codex .*exec' >/dev/null; then
    echo "rmd-relaunch: deploy code -- active workers; deferring." >&2
    DEPLOY_CODE_BUSY=1
    return 1
  else
    match_status=$?
    if [ "$match_status" -ne 1 ]; then
      echo "rmd-relaunch: deploy code -- worker probe unreadable (matcher failed); deferring." >&2
      return 1
    fi
  fi
  for dir in "$STATE_DIR/state/inflight" "$STATE_DIR/worktrees"; do
    # Missing lock directories mean no locks; an unreadable existing path is unknown.
    if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then continue; fi
    if [ ! -d "$dir" ] || ! locks="$(find "$dir" -maxdepth 1 -name '*.lock' -print 2>/dev/null)"; then
      echo "rmd-relaunch: deploy code -- lock probe unreadable at $dir; deferring." >&2
      return 1
    fi
    if [ -n "$locks" ]; then
      echo "rmd-relaunch: deploy code -- active locks at $dir; deferring." >&2
      DEPLOY_CODE_BUSY=1
      return 1
    fi
  done
}

deploy_code_clean() {
  local code="$STATE_DIR/remudero" edits
  if [ ! -e "$code/.git" ]; then
    echo "rmd-relaunch: deploy code -- checkout missing; deferring." >&2
    return 1
  fi
  if ! edits="$(GIT_OPTIONAL_LOCKS=0 git -C "$code" status --porcelain --untracked-files=all 2>/dev/null)"; then
    echo "rmd-relaunch: deploy code -- status unreadable; deferring." >&2
    return 1
  fi
  if [ -n "$edits" ]; then
    echo "rmd-relaunch: deploy code -- local edits; deferring without discarding them." >&2
    return 1
  fi
}

refresh_deploy_code() {
  local container="$1" code="$STATE_DIR/remudero" install_head
  DEPLOY_CODE_BUSY=0
  deploy_code_idle "$container" || return 1
  deploy_code_clean || return 1
  if ! git -C "$code" fetch --quiet origin main 2>/dev/null; then
    echo "rmd-relaunch: deploy code -- fetch failed; deferring." >&2
    return 1
  fi
  if ! git -C "$code" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    echo "rmd-relaunch: deploy code -- checkout diverged or ancestry unreadable; deferring." >&2
    return 1
  fi
  if ! install_head="$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null)" || [ -z "$install_head" ] ||
     ! git -C "$code" merge-base --is-ancestor "$install_head" origin/main 2>/dev/null; then
    echo "rmd-relaunch: deploy code -- install checkout ancestry unreadable or ahead of origin/main; deferring." >&2
    return 1
  fi
  # The daemon normally boots detached. An ff-only merge advances that HEAD without switching
  # branches, resetting, cleaning, or restarting its already-loaded process.
  deploy_code_idle "$container" || return 1
  deploy_code_clean || return 1
  if ! git -C "$code" merge --ff-only --quiet origin/main 2>/dev/null; then
    echo "rmd-relaunch: deploy code -- fast-forward failed; deferring." >&2
    return 1
  fi
  deploy_code_idle "$container" && deploy_code_clean
}

# W1-T6282 -- THE CODE THAT DECIDES AND PERFORMS A DEPLOY: deploy/, the rmd entrypoint, and
# src/lib/deployer.ts with every local module it imports (test/a-busy-primary-reaches-its-image-
# recycle.test.ts walks that import graph and fails when a module is missing here).
DEPLOY_LOGIC_PATHS=(deploy/ bin/ src/lib/deployer.ts src/lib/action-reconciliation.ts
  src/lib/baked-runtime-inputs.ts src/lib/clock.ts src/lib/config-schema.ts src/lib/config.ts
  src/lib/deploy-judge.ts src/lib/drain-lock.ts src/lib/errors.ts src/lib/fleet-control.ts
  src/lib/fs-race-safe.ts src/lib/ledger-carry.ts src/lib/ledger-path.ts src/lib/ledger-union.ts
  src/lib/ledger.ts src/lib/live-write-guard.ts src/lib/log-rotation.ts src/lib/plan-scope.ts
  src/lib/producer-identity.ts src/lib/repo-layout.ts src/lib/worker-containment.ts)

# W1-T6249 -- A REFRESH DEFERRED ONLY ON ACTIVE WORK STILL ASKS deploy-run. Busy ticks ended at
# `|| exit 0` before deploy-run, so core's image recycle starved for hours on 2026-10-07; deploy-run
# now hands a busy recycle to recycle-container.sh's own pause-and-drain. Only workers or locks
# qualify -- an unreadable probe, a dirty tree, or a daemon tree older than the install head's
# DEPLOY LOGIC defers. W1-T6282: whole-HEAD ancestry was a moving target on a busy repo (the
# install head moved on every merge, so the tree stayed one merge behind for 80+ min); only the
# deploy-logic paths must match, which keeps W1-T4917's "deploy code never older than it deploys".
deploy_code_busy_handoff() {
  local code="$STATE_DIR/remudero" install_head daemon_head rc=0
  [ "${DEPLOY_CODE_BUSY:-0}" = 1 ] || return 1
  deploy_code_clean || return 1
  if ! install_head="$(GIT_OPTIONAL_LOCKS=0 git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null)" || [ -z "$install_head" ] ||
     ! daemon_head="$(GIT_OPTIONAL_LOCKS=0 git -C "$code" rev-parse HEAD 2>/dev/null)" || [ -z "$daemon_head" ]; then
    echo "rmd-relaunch: deploy code -- busy, and a head is unreadable; deferring." >&2
    return 1
  fi
  if GIT_OPTIONAL_LOCKS=0 git -C "$code" merge-base --is-ancestor "$install_head" "$daemon_head" 2>/dev/null; then
    echo "rmd-relaunch: deploy code -- busy; daemon tree ${daemon_head} contains install head ${install_head}, asking deploy-run anyway."
    return 0
  fi
  # Objects only: the busy tree's HEAD and files are untouched, exactly like the daemon's own fetch.
  GIT_OPTIONAL_LOCKS=0 git -C "$code" fetch --quiet origin main 2>/dev/null || true
  GIT_OPTIONAL_LOCKS=0 git -C "$code" diff --quiet "$daemon_head" "$install_head" -- "${DEPLOY_LOGIC_PATHS[@]}" 2>/dev/null || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "rmd-relaunch: deploy code -- busy, and daemon tree ${daemon_head} lacks install head ${install_head}'s deploy logic (${DEPLOY_LOGIC_PATHS[*]}); deferring." >&2
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "rmd-relaunch: deploy code -- busy, and daemon tree ${daemon_head} vs install head ${install_head}: deploy logic unreadable (git diff exit ${rc}); deferring." >&2
    return 1
  fi
  echo "rmd-relaunch: deploy code -- busy; daemon tree ${daemon_head} carries install head ${install_head}'s deploy logic, asking deploy-run anyway."
}
DEPLOY_CODE_REFRESH
}

# W1-T5688 — the launcher's ACTION LADDER on W1-T5687's `rmd progress-watchdog` verdict. Literal
# shell (a quoted heredoc), so nothing in it is expanded at render time.
render_progress_watchdog_ladder() {
  cat <<'PROGRESS_WATCHDOG_LADDER'
# W1-T5688 — ACT ON THE PROGRESS VERDICT, NOT ONLY ON A STOPPED CONTAINER. On 2026-10-03 this tick
# revived 14 times into one crash (each prev_restarts=5) and named CRASH LOOP 3h44m in, in a marker
# nothing reads; a wedged-but-running daemon was never acted on at all, because the healthy arm's
# `refresh_deploy_code || exit 0` ended every tick that had workers in flight. Four rungs:
#   capture-diagnostics -- the verb wrote the bundle; this appends one revival-log line naming it.
#   recycle             -- deploy/recycle-container.sh, at most once per WATCHDOG_RECYCLE_GAP_S. A
#                          refusal is logged with its reason and retried on a later tick only.
#   hold-revive         -- the revive arm starts nothing until origin/main's sha or the image id
#                          differs from the one recorded when the loop was named. The hold OUTLIVES
#                          the verdict's 15-minute window: a held daemon writes no boots, so the
#                          verdict would otherwise lapse and revive the same input every ~20 min.
#   none / unreadable   -- everything below runs exactly as before this task.
WATCHDOG_RECYCLE_GAP_S=1800
WATCHDOG_RECYCLE_AT="$STATE_DIR/state/watchdog-recycle-at"
WATCHDOG_HOLD="$STATE_DIR/state/watchdog-hold-revive"
PROGRESS_VERDICT=""
PROGRESS_STATE=""
PROGRESS_ACTION=""

watchdog_stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# A string field of the verdict's one-line JSON (JSON.stringify writes no spaces).
verdict_field() {
  printf '%s\n' "$PROGRESS_VERDICT" | sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' | head -n 1
}

# RMD_SELF_SYNC_DONE=1 skips checkCliFreshness, which would fetch and fast-forward the tree the
# workers run on -- the very mutation refresh_deploy_code's idle gate exists to withhold.
read_progress_verdict() {
  local rmd="$STATE_DIR/remudero/bin/rmd" out tmo=()
  PROGRESS_VERDICT=""; PROGRESS_STATE=""; PROGRESS_ACTION=""
  [ -x "$rmd" ] || return 0
  command -v timeout >/dev/null 2>&1 && tmo=(timeout 120)
  if ! out="$(cd "$STATE_DIR/remudero" && RMD_SELF_SYNC_DONE=1 ${tmo[@]+"${tmo[@]}"} "$rmd" progress-watchdog --json --state-root "$STATE_DIR/state" 2>/dev/null)"; then
    echo "rmd-relaunch: progress-watchdog -- verdict unreadable; acting as before." >&2
    return 0
  fi
  PROGRESS_VERDICT="$(printf '%s\n' "$out" | grep -E '^\{' | tail -n 1 || true)"
  PROGRESS_STATE="$(verdict_field state)"
  PROGRESS_ACTION="$(verdict_field action)"
  echo "rmd-relaunch: progress-watchdog -- ${PROGRESS_STATE:-UNKNOWN} action=${PROGRESS_ACTION:-none}"
}

note_progress_verdict() {
  [ "$PROGRESS_ACTION" = "capture-diagnostics" ] || return 0
  local dir; dir="$(verdict_field dir)"
  printf '%s watchdog-verdict state=%s action=%s bundle=%s\n' "$(watchdog_stamp)" "$PROGRESS_STATE" \
    "$PROGRESS_ACTION" "${dir:-skipped}" >> "$REVIVAL_LOG" 2>/dev/null || true
}

# Returns 0 only when it RAN recycle-container.sh, so the caller ends the tick on one action.
recycle_on_verdict() {
  local container="$1" now last out rc script="$CHECKOUT/deploy/recycle-container.sh" result reason args=() envs=() age
  [ "$PROGRESS_ACTION" = "recycle" ] || return 1
  now="$(date -u +%s)"
  last="$(cat "$WATCHDOG_RECYCLE_AT" 2>/dev/null || true)"
  case "$last" in ''|*[!0-9]*) last="" ;; esac
  if [ -n "$last" ] && [ "$((now - last))" -lt "$WATCHDOG_RECYCLE_GAP_S" ]; then
    echo "rmd-relaunch: progress-watchdog -- a recycle ran $((now - last))s ago; at most one per ${WATCHDOG_RECYCLE_GAP_S}s."
    return 1
  fi
  # STAMPED BEFORE THE ATTEMPT: a refusal is retried on a later tick, never in this one. W1-T6598:
  # and STAMPED AGAIN WHEN IT ENDS, ok or refused, so the gap runs from the end -- a drain wait
  # longer than WATCHDOG_RECYCLE_GAP_S must not leave the just-booted generation unprotected.
  mkdir -p "$STATE_DIR/state" 2>/dev/null || true
  printf '%s\n' "$now" > "$WATCHDOG_RECYCLE_AT" 2>/dev/null || true
  [ -n "$INSTANCE_NAME" ] && args=(--instance "$INSTANCE_NAME")
  [ -n "$INSTANCE_REGISTRY" ] && envs=(RMD_INSTANCE_REGISTRY="$INSTANCE_REGISTRY")
  # W1-T6597: the verdict rides along, so the recycle may prove a FROZEN daemon owns what blocks it.
  age="$(printf '%s\n' "$PROGRESS_VERDICT" | sed -n 's/.*"progressAgeMs":\([0-9]*\).*/\1/p' | head -n 1)"
  envs+=(RMD_RECYCLE_VERDICT="${PROGRESS_STATE} progressAgeMs=${age:-unknown}")
  echo "rmd-relaunch: progress-watchdog -- ${PROGRESS_STATE}; recycling $container via $script."
  if [ ! -f "$script" ]; then
    out="recycle-container.sh missing at $script"; rc=127
  elif out="$(env ${envs[@]+"${envs[@]}"} RMD_STATE_DIR="$STATE_DIR" RMD_DAEMON_CONTAINER="$container" \
      bash "$script" ${args[@]+"${args[@]}"} 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then result=ok; reason=replaced; else
    result=refused
    reason="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1 | tr -s '[:space:]' ' ' || true)"
  fi
  # W1-T6598: the END stamp -- WATCHDOG_RECYCLE_GAP_S now runs from when this attempt finished.
  date -u +%s > "$WATCHDOG_RECYCLE_AT" 2>/dev/null || true
  printf '%s watchdog-recycle result=%s rc=%s reason=%s\n' "$(watchdog_stamp)" "$result" "$rc" "${reason:-none}" \
    >> "$REVIVAL_LOG" 2>/dev/null || true
  return 0
}

# "sha=<origin/main> digest=<image id>" -- the two inputs a revive starts from; unreadable = unknown.
revive_input() {
  local code="$STATE_DIR/remudero" sha digest
  git -C "$code" fetch --quiet origin main >/dev/null 2>&1 || true
  sha="$(git -C "$code" rev-parse --verify --quiet origin/main 2>/dev/null || true)"
  digest="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
  printf 'sha=%s digest=%s\n' "${sha:-unknown}" "${digest:-unknown}"
}

# An input moved only when BOTH readings are known and differ: an unreadable one is no evidence.
revive_input_changed() {
  local was="$1" now="$2" key a b
  for key in sha digest; do
    a="$(printf '%s\n' "$was" | sed -n 's/.*'"$key"'=\([^ ]*\).*/\1/p')"
    b="$(printf '%s\n' "$now" | sed -n 's/.*'"$key"'=\([^ ]*\).*/\1/p')"
    if [ -n "$a" ] && [ -n "$b" ] && [ "$a" != unknown ] && [ "$b" != unknown ] && [ "$a" != "$b" ]; then return 0; fi
  done
  return 1
}

# The last ledger step of each of the newest $1 daemon boots (run_ids that wrote daemon.paths).
last_steps_before_exit() {
  tail -n 5000 "$STATE_DIR/state/ledger.ndjson" 2>/dev/null | awk -v n="${1:-0}" '
    {
      rid = ""; st = ""
      if (match($0, /"run_id":"[^"]*"/)) rid = substr($0, RSTART + 10, RLENGTH - 11)
      if (match($0, /"step":"[^"]*"/)) st = substr($0, RSTART + 8, RLENGTH - 9)
      if (rid == "" || st == "") next
      if (st == "daemon.paths" && !(rid in seen)) { seen[rid] = 1; order[++k] = rid }
      if (rid in seen) last[rid] = st
    }
    END {
      out = ""; from = k - n + 1; if (from < 1) from = 1
      for (i = from; i <= k; i++) out = out (out == "" ? "" : ",") last[order[i]]
      print out
    }' || true
}

# Returns 0 when the revive must NOT happen this tick.
hold_revive_on_verdict() {
  local was now fb steps line
  if [ ! -f "$WATCHDOG_HOLD" ]; then
    [ "$PROGRESS_ACTION" = "hold-revive" ] || return 1
    now="$(revive_input)"
    fb="$(printf '%s\n' "$PROGRESS_VERDICT" | sed -n 's/.*"failedBoots15m":\([0-9]*\).*/\1/p')"
    steps="$(last_steps_before_exit "${fb:-0}")"
    line="$(watchdog_stamp) crash-loop-hold failed_boots=${fb:-unknown} last_steps=${steps:-unknown} $now"
    mkdir -p "$STATE_DIR/state" 2>/dev/null || true
    printf '%s\n' "$now" > "$WATCHDOG_HOLD" 2>/dev/null || true
    printf '%s\n' "$line" >> "$REVIVAL_LOG" 2>/dev/null || true
    printf '%s\n' "$line" > "$STATE_DIR/state/DAEMON_CRASH_LOOP" 2>/dev/null || true
    echo "rmd-relaunch: CRASH LOOP -- not reviving into the same input ($now). It revives when origin/main or the image changes; rm $WATCHDOG_HOLD to revive anyway." >&2
    return 0
  fi
  was="$(cat "$WATCHDOG_HOLD" 2>/dev/null || true)"
  now="$(revive_input)"
  if revive_input_changed "$was" "$now"; then
    rm -f "$WATCHDOG_HOLD" 2>/dev/null || true
    printf '%s crash-loop-release %s was %s\n' "$(watchdog_stamp)" "$now" "$was" >> "$REVIVAL_LOG" 2>/dev/null || true
    echo "rmd-relaunch: CRASH LOOP hold released -- input changed ($was -> $now); reviving."
    return 1
  fi
  echo "rmd-relaunch: CRASH LOOP hold -- input unchanged ($now); not reviving." >&2
  return 0
}
PROGRESS_WATCHDOG_LADDER
}

# tsx caches every transpile under os.tmpdir()/tsx-<uid> and has no cache-dir setting. This
# launcher's ticks run bin/rmd (tsx) on the HOST: under systemd TMPDIR is unset, so the cache sat
# in /tmp on the 29 GB root disk -- 2.7 GB on 2026-10-06, ~2 GB/day of fresh entries. Move it to
# the local scratch disk only when that is a mounted filesystem (a bare /mnt/scratch directory IS
# the root disk); otherwise, or with TMPDIR already set, leave the default. A cache only: the
# janitor's /mnt/scratch/tmp root prunes stale tsx entries there too. Literal shell, not expanded.
render_host_tmpdir() {
  cat <<'HOST_TMPDIR'
host_tmpdir_on_scratch() {
  local root mounts mnt dir
  [ -z "${TMPDIR:-}" ] || return 0
  root="${RMD_SCRATCH_ROOT:-/mnt/scratch}"
  mounts="${RMD_SCRATCH_MOUNTS_FILE:-/proc/mounts}"
  [ -r "$mounts" ] || return 0
  while IFS=' ' read -r _ mnt _; do
    [ "$mnt" = "$root" ] || continue
    dir="$root/tmp"
    # Sticky and world-writable like /tmp. `|| true`: the launcher runs under set -e.
    if [ ! -d "$dir" ]; then { mkdir -p "$dir" && chmod 1777 "$dir"; } 2>/dev/null || true; fi
    if [ -d "$dir" ] && [ -w "$dir" ]; then export TMPDIR="$dir"; fi
    return 0
  done < "$mounts"
  return 0
}
host_tmpdir_on_scratch
HOST_TMPDIR
}

render_watchdog_tick_snapshot() {
  cat <<'WATCHDOG_TICK_SNAPSHOT'
# W1-T6361: cache only successful healthy ticks; unreadable probes always take the full path.
WATCHDOG_SNAPSHOT="$STATE_DIR/state/watchdog-tick-snapshot"
WATCHDOG_PROBE_OK=0
WATCHDOG_VERDICT_READ=0
WATCHDOG_UNCHANGED_TICKS=0
WATCHDOG_REMOTE=""
WATCHDOG_INSTALL=""
WATCHDOG_CONTAINER=""
WATCHDOG_LEDGER_MTIME=""

watchdog_healthy() {
  [ "$PROGRESS_ACTION" = none ] || return 1
  case "$PROGRESS_STATE" in PROGRESSING|IDLE) return 0 ;; *) return 1 ;; esac
}

watchdog_save_snapshot() {
  local tmp
  [ "$WATCHDOG_PROBE_OK" = 1 ] && watchdog_healthy || return 0
  [ ! -e "$STATE_DIR/state/DEPLOY_REQUESTED" ] || return 0
  [ -n "$WATCHDOG_LEDGER_MTIME" ] || return 0
  mkdir -p "$STATE_DIR/state" 2>/dev/null || return 0
  tmp="$(mktemp "$WATCHDOG_SNAPSHOT.XXXXXX")" || return 0
  if (umask 077; printf 'v1|%s|%s|%s|%s|%s|%s\n' "$WATCHDOG_REMOTE" "$WATCHDOG_INSTALL" \
      "$WATCHDOG_CONTAINER" "$PROGRESS_STATE" "$WATCHDOG_LEDGER_MTIME" "$WATCHDOG_UNCHANGED_TICKS" > "$tmp") &&
     mv -f "$tmp" "$WATCHDOG_SNAPSHOT"; then :
  else rm -f "$tmp" 2>/dev/null || true; fi
}

watchdog_unchanged_tick() {
  local container="$1" remote ref extra record version sha head identity verdict mtime ticks
  WATCHDOG_PROBE_OK=0
  [ ! -e "$STATE_DIR/state/DEPLOY_REQUESTED" ] || return 1
  if ! remote="$(git -C "$CHECKOUT" ls-remote --exit-code origin refs/heads/main 2>/dev/null)"; then return 1; fi
  read -r WATCHDOG_REMOTE ref extra <<< "$remote"
  [ "$ref" = refs/heads/main ] && [ -z "$extra" ] || return 1
  case "$WATCHDOG_REMOTE" in ''|*[!0-9a-f]*) return 1 ;; esac
  if ! WATCHDOG_INSTALL="$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null)"; then return 1; fi
  case "$WATCHDOG_INSTALL" in ''|*[!0-9a-f]*) return 1 ;; esac
  if ! WATCHDOG_CONTAINER="$(docker inspect "$container" --format '{{.Id}} {{.State.Status}} {{.RestartCount}} {{.State.StartedAt}}' 2>/dev/null)"; then return 1; fi
  case "$WATCHDOG_CONTAINER" in *' running '*) : ;; *) return 1 ;; esac
  WATCHDOG_LEDGER_MTIME="$(stat -c '%Y' "$STATE_DIR/state/ledger.ndjson" 2>/dev/null || true)"
  case "$WATCHDOG_LEDGER_MTIME" in ''|*[!0-9]*) WATCHDOG_LEDGER_MTIME="" ;; esac
  WATCHDOG_PROBE_OK=1
  record="$(cat "$WATCHDOG_SNAPSHOT" 2>/dev/null)" || return 1
  case "$record" in *$'\n'*) return 1 ;; esac
  IFS='|' read -r version sha head identity verdict mtime ticks extra <<< "$record"
  [ "$version" = v1 ] && [ -z "$extra" ] && [ "$sha" = "$WATCHDOG_REMOTE" ] &&
    [ "$head" = "$WATCHDOG_INSTALL" ] && [ "$identity" = "$WATCHDOG_CONTAINER" ] || return 1
  case "$verdict" in PROGRESSING|IDLE) : ;; *) return 1 ;; esac
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  case "$ticks" in 0|1|2) : ;; *) return 1 ;; esac
  PROGRESS_STATE="$verdict"; PROGRESS_ACTION=none
  WATCHDOG_UNCHANGED_TICKS=$((ticks + 1))
  # Ledger pulses can advance during a stalled sweep: read the real verdict at least every 15 min.
  if [ "$WATCHDOG_UNCHANGED_TICKS" -ge 3 ] || [ -z "$WATCHDOG_LEDGER_MTIME" ] ||
     [ "$WATCHDOG_LEDGER_MTIME" -le "$mtime" ]; then
    read_progress_verdict
    WATCHDOG_VERDICT_READ=1
    WATCHDOG_UNCHANGED_TICKS=0
    watchdog_healthy || return 1
  fi
  watchdog_save_snapshot
  echo "rmd-relaunch: $container unchanged and healthy -- skipping checkout and deploy work."
  return 0
}
WATCHDOG_TICK_SNAPSHOT
}

# Core only: recreate an ABSENT remudero-serve/cloudflared (deploy/edge-heal.sh). On EXIT, so every
# clean tick path reaches it and serve-container.sh can read the App env off a just-revived daemon.
render_edge_heal() {
  case "${INSTANCE_NAME:-core}" in core) : ;; *) return 0 ;; esac
  cat <<'EDGE_HEAL'
edge_heal_on_exit() {
  local rc=$?
  if [ "$rc" -eq 0 ] && [ -x "$CHECKOUT/deploy/edge-heal.sh" ]; then
    RMD_STATE_DIR="$STATE_DIR" "$CHECKOUT/deploy/edge-heal.sh" ||
      echo "rmd-relaunch: edge heal incomplete; the next tick re-asks." >&2
  fi
  return "$rc"
}
trap edge_heal_on_exit EXIT
EDGE_HEAL
}

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
CASH_SECRET_DIR=${CASH_SECRET_DIR_SHELL}
# W1-T3269 — the checkout this host converges FROM, and the heap the installer requires. Rendered
# in rather than re-derived, so the converge below uses the same inputs this file was rendered with.
# W1-T3604 — daemon freshness sync detaches ${STATE_DIR}/remudero; worker exhaust keeps it dirty.
# Using it for convergence caused 464 refusals in 7 days; the install tree stays clean and on main.
# ${STATE_DIR}/daemon-install matches src/lib/install-root.ts's resolveInstallRoot default:
# config.installRoot falls back to config.root plus "daemon-install"; STATE_DIR is config.root here.
# Re-read that resolver if the default moves; this shell renderer cannot import TypeScript.
# W1-T2953 — avoid backticks and dollar-paren here: this unquoted heredoc executes them.
CHECKOUT=${STATE_DIR}/daemon-install
UNITS_HEAP_MB=${MAX_OLD_SPACE_MB}
INSTANCE_NAME=${INSTANCE_NAME:-}
INSTANCE_REGISTRY=${REGISTRY_FILE:-}
BOOT=0
[ "\${1:-}" = "--boot" ] && BOOT=1

$(render_host_tmpdir)

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

$(render_edge_heal)

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
  tracked_changes=\$(git -C "\$CHECKOUT" status --porcelain --untracked-files=no 2>/dev/null || true)
  refusal_since="\$STATE_DIR/state/units-converge-refused-since"
  refusal_alerted="\$STATE_DIR/state/units-converge-refusal-alerted"
  if [ -n "\$tracked_changes" ]; then
    echo "rmd-relaunch: units -- checkout is DIRTY (tracked changes); not converging (an unreviewed tree must never become root config): \$tracked_changes"
    # W1-T4076 -- the stamp's directory is NOT guaranteed to exist. A redirection into a missing
    # directory fails in the SHELL, before the command runs, so the trailing \`2>/dev/null || true\`
    # never sees it and the error leaks to the launcher's own stderr on every tick.
    mkdir -p "\$STATE_DIR/state" 2>/dev/null || true
    if [ ! -f "\$refusal_since" ]; then
      date -u +%s > "\$refusal_since" 2>/dev/null || true
      rm -f "\$refusal_alerted" 2>/dev/null || true
    fi
    refused_at=\$(cat "\$refusal_since" 2>/dev/null || echo "")
    now=\$(date -u +%s 2>/dev/null || echo "")
    case "\$refused_at:\$now" in *[!0-9:]*) : ;; *)
      if [ -n "\$refused_at" ] && [ -n "\$now" ] && [ "\$((now - refused_at))" -ge 21600 ] && [ ! -e "\$refusal_alerted" ]; then
        echo "rmd-relaunch: ALERT host unit convergence has been refused for at least 6 hours; tracked paths: \$tracked_changes" >&2
        : > "\$refusal_alerted" 2>/dev/null || true
      fi
    ;; esac
    return 0
  fi
  rm -f "\$refusal_since" "\$refusal_alerted" 2>/dev/null || true

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
  # fetched-but-unmerged, and the check below would refuse it on every tick forever. FETCH, THEN
  # FF-ONLY MERGE, as the service user -- never a reset, a rebase or a clean. BOTH ARE BEST-EFFORT:
  # a fetch that cannot reach origin (offline tick, no remote configured) must never newly refuse a
  # checkout the OLD comparison below would have accepted, so its failure falls straight through to
  # that same, already-tested comparison rather than returning here. A fetch that DOES succeed but
  # whose merge is refused is a real, named divergence and returns here rather than falling through
  # silently -- that is the one failure this step must still surface on its own.
  if git -C "\$CHECKOUT" fetch --quiet origin main 2>/dev/null; then
    if ! git -C "\$CHECKOUT" merge --ff-only --quiet origin/main 2>/dev/null; then
      echo "rmd-relaunch: units -- checkout DIVERGED from origin/main (fast-forward refused); not converging." >&2
      return 0
    fi
  fi

  # CHECK BEFORE INSTALL, ALWAYS. The steady state is a silent no-op, which is what makes a converge
  # event rare enough to be worth a record. This is also the FALLBACK comparison for a tick whose
  # fetch above could not run at all: it names the same checkout-is-stale condition the fetch exists
  # to close, rather than a new one.
  head_sha=\$(git -C "\$CHECKOUT" rev-parse HEAD 2>/dev/null || echo unknown)
  main_sha=\$(git -C "\$CHECKOUT" rev-parse origin/main 2>/dev/null || echo unknown)
  if [ "\$head_sha" = unknown ] || [ "\$head_sha" != "\$main_sha" ]; then
    echo "rmd-relaunch: units -- checkout is not at origin/main (\$head_sha vs \$main_sha); not converging."
    return 0
  fi
  INSTALLER_ENV=(RMD_NODE_MAX_OLD_SPACE_MB="\$UNITS_HEAP_MB")
  if [ -n "\$INSTANCE_NAME" ]; then
    INSTALLER_ENV=(RMD_INSTANCE_REGISTRY="\$INSTANCE_REGISTRY")
    if units_check=\$(env "\${INSTALLER_ENV[@]}" "\$CHECKOUT/deploy/install-host-units.sh" --instance "\$INSTANCE_NAME" 2>/dev/null); then
      return 0
    fi
  elif units_check=\$(env "\${INSTALLER_ENV[@]}" "\$CHECKOUT/deploy/install-host-units.sh" 2>/dev/null); then
    return 0
  fi

  # W1-T5518 -- --install never retires a LEGACY user unit, so LEGACY-only drift is named, not
  # reinstalled on every tick. MISSING or DRIFTED lines beside it still converge.
  case "\$units_check" in
    *"install-host-units: MISSING "*|*"install-host-units: DRIFTED "*) : ;;
    *"install-host-units: LEGACY "*)
      echo "rmd-relaunch: units -- only LEGACY drift, which --install never retires; not converging:" >&2
      printf '%s\\n' "\$units_check" | grep -F -e 'LEGACY' -e 'retire it' >&2 || true
      return 0
      ;;
  esac

  # Elevation is REQUIRED and never prompted for: the tick runs as the service user while the unit
  # dir is root-owned. No sudo, no converge -- reported, never fatal.
  if ! sudo -n true 2>/dev/null; then
    echo "rmd-relaunch: units -- DRIFTED but cannot elevate (sudo -n refused); leaving them alone." >&2
    return 0
  fi

  echo "rmd-relaunch: units DRIFTED at \$head_sha -- converging."
  install_ok=0
  if [ -n "\$INSTANCE_NAME" ]; then
    if sudo -n env "\${INSTALLER_ENV[@]}" "\$CHECKOUT/deploy/install-host-units.sh" --install --instance "\$INSTANCE_NAME"; then
      install_ok=1
    fi
  elif sudo -n env "\${INSTALLER_ENV[@]}" "\$CHECKOUT/deploy/install-host-units.sh" --install; then
    install_ok=1
  fi
  if [ "\$install_ok" -eq 1 ]; then
    printf '%s units-converged sha=%s\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$head_sha" >> "\$REVIVAL_LOG" 2>/dev/null || true
  else
    echo "rmd-relaunch: units -- converge FAILED; the next tick re-asks." >&2
  fi
  return 0
}

$(render_deploy_code_refresh)

$(render_progress_watchdog_ladder)

$(render_watchdog_tick_snapshot)

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
  # 2026-10-09 -- A SELF-TUNING memory.high. deploy/memory-high-tuner.sh grows this container's
  # memory.high while it is throttled and refaulting its page cache with host headroom, and gives it
  # back under host pressure, never below the policy. BEFORE the unchanged-tick exit: memory pressure
  # moves while the code does not. Bounded, and never fatal to the tick.
  if [ "\$BOOT" -eq 0 ] && [ -f "\$CHECKOUT/deploy/memory-high-tuner.sh" ]; then
    MHT_TMO=(); command -v timeout >/dev/null 2>&1 && MHT_TMO=(timeout 60)
    \${MHT_TMO[@]+"\${MHT_TMO[@]}"} bash "\$CHECKOUT/deploy/memory-high-tuner.sh" \\
      --container '${CONTAINER_NAME}' --state-dir "\$STATE_DIR" || true
  fi
  if [ "\$BOOT" -eq 0 ] && watchdog_unchanged_tick '${CONTAINER_NAME}'; then exit 0; fi
  rm -f "\$WATCHDOG_SNAPSHOT" 2>/dev/null || true
  WATCHDOG_UNCHANGED_TICKS=0
  # CONVERGENCE IS LAST AND ONLY WHEN HEALTHY. A DOWN host needs reviving, not tidying, so nothing
  # here runs before the revive decision; boot is excluded because a host coming up is the worst
  # moment to rewrite its units -- the rule W1-T3245 applied to the recycle decision.
  [ "\$BOOT" -eq 0 ] && converge_host_units
  if [ "\$BOOT" -eq 0 ] && [ -x "\$STATE_DIR/remudero/bin/rmd" ]; then
    # W1-T5688: THE VERDICT IS READ BEFORE refresh_deploy_code, whose \`|| exit 0\` ends every tick
    # with workers in flight -- exactly the ticks a wedged daemon produces.
    [ "\$WATCHDOG_VERDICT_READ" = 1 ] || read_progress_verdict
    [ "\$PROGRESS_STATE" = CRASH_LOOP ] || rm -f "\$WATCHDOG_HOLD" 2>/dev/null || true
    note_progress_verdict
    if recycle_on_verdict '${CONTAINER_NAME}'; then exit 0; fi
    # W1-T4917: load current deploy code only after a verified idle fast-forward. Running from
    # daemon-install conflates the invoking checkout with the tree deploy-run acts on.
    # Refresh the source CLI before loading it; standalone executable entrypoints own their
    # runtime and retain the supervisor invocation without requiring a source checkout.
    if [ -f "\$STATE_DIR/remudero/src/run-task.ts" ]; then
      refresh_deploy_code '${CONTAINER_NAME}' || deploy_code_busy_handoff || exit 0
    fi
    echo "rmd-relaunch: ${CONTAINER_NAME} healthy -- asking the supervisor whether a RECYCLE is due."
    # W1-T4267: deploy-run reads resourcePolicyDrift for THIS container (named at install time --
    # the rendered launcher has no CONTAINER_NAME of its own) against the build policy it recycles with.
    if watchdog_deploy_out="\$(cd "\$STATE_DIR/remudero" && \\
      RMD_RESOURCE_POLICY_CONTAINER='${CONTAINER_NAME}' RMD_RESOURCE_POLICY_ROLE=build \\
      "\$STATE_DIR/remudero/bin/rmd" deploy-run --image-drift-only --state-root "\$STATE_DIR")"; then
      printf '%s\\n' "\$watchdog_deploy_out"
      # Exit zero also means deferred: cache only the supervisor's confirmed up-to-date result.
      case "\$watchdog_deploy_out" in *'### rmd deploy-run — no-op: up-to-date ('*)
        WATCHDOG_INSTALL="\$(git -C "\$CHECKOUT" rev-parse HEAD 2>/dev/null || true)"
        [ "\$WATCHDOG_INSTALL" != "\$WATCHDOG_REMOTE" ] || watchdog_save_snapshot
        ;;
      esac
    else
      printf '%s\\n' "\$watchdog_deploy_out"
      echo "rmd-relaunch: deploy-run reported a problem; the daemon is untouched and the next tick re-asks." >&2
    fi
  else
    echo "rmd-relaunch: ${CONTAINER_NAME} already running -- nothing to do."
  fi
  exit 0
fi

rm -f "\$WATCHDOG_SNAPSHOT" 2>/dev/null || true

# REFUSE AGAINST AN UNMOUNTED STATE ROOT -- the 2026-09-05 fleet-wipe failure mode.
if ! findmnt -no TARGET /mnt/rmd >/dev/null 2>&1; then
  echo "rmd-relaunch: FATAL -- /mnt/rmd is not mounted. Refusing to start against the bare OS disk." >&2
  exit 1
fi
if [ ! -s "\$STATE_DIR/state/ledger.ndjson" ]; then
  echo "rmd-relaunch: FATAL -- \$STATE_DIR/state/ledger.ndjson missing or empty; wrong volume?" >&2
  exit 1
fi

# W1-T5688 — HOLD, DON'T SPEND A BOOT ON AN UNCHANGED INPUT. Before the revival record, so a held
# tick writes no revive line and the count below only sees boots that actually happened.
read_progress_verdict
note_progress_verdict
if hold_revive_on_verdict; then exit 0; fi

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

$(render_cash_boot_secrets)

APP_PRIVATE_KEY_ARGS=()
$(render_app_private_key_mount)

docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1 || true

# W1-T6110 -- THE CHECKOUT'S PLAN FIRST. The installed copy changes only at --install, so a bind
# merged since then reached the deploy tick's drift reading (which reads the checkout) but not this
# relaunch; the copy stays as the fallback for a host whose checkout is missing.
SCRATCH_ARGS=()
SCRATCH_LIB="\$CHECKOUT/deploy/scratch-mounts.sh"
[ -r "\$SCRATCH_LIB" ] || SCRATCH_LIB=${BIN_DIR}/rmd-scratch-mounts
if [ -r "\$SCRATCH_LIB" ]; then
  . "\$SCRATCH_LIB"
  echo "rmd-relaunch: scratch plan from \$SCRATCH_LIB"
  if scratch_plan "\$STATE_DIR" ${CONTAINER_NAME} && scratch_prepare; then scratch_fresh_tmp; fi
  echo "rmd-relaunch: scratch mounts \$SCRATCH_NOTE"
fi

CREDENTIAL_ARGS=()
$(render_credential_mount)

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
  -e GH_APP_PRIVATE_KEY_PATH=${GH_APP_KEY_SHELL} \\
  -e NODE_OPTIONS=--max-old-space-size=${MAX_OLD_SPACE_MB} \\
  -e RMD_RESTART_THROTTLE_S=120 \\
  -e RMD_FRESHNESS_RESTART_MAX=100 \\
  -e RMD_OPENWEIGHT_API_KEY \\
  -e RMD_FOUNDRY_CLAUDE_API_KEY \\
  -e RMD_FOUNDRY_CLAUDE_ENDPOINT \\
  -v ${CODEX_DIR}:/home/node/.codex \\
  -v ${CONTAINER_CONFIG_DIR}:/home/node/.config/remudero \\
  -v "\$STATE_DIR":/home/node/Remudero \\
  -v ${CLAUDE_DIR}:/home/node/.claude \\
  "\${APP_PRIVATE_KEY_ARGS[@]+"\${APP_PRIVATE_KEY_ARGS[@]}"}" \\
  "\${CREDENTIAL_ARGS[@]+"\${CREDENTIAL_ARGS[@]}"}" \\
  "\${SCRATCH_ARGS[@]+"\${SCRATCH_ARGS[@]}"}" \\
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

render_acr_login_bin() { cat "${SCRIPT_DIR}/acr-login.sh"; }

render_acr_login_service() {
  local registry="${REGISTRY:-${IMAGE%%/*}}"
  registry="${registry%.azurecr.io}"
  cat <<EOF
[Unit]
Description=Refresh the host's Azure Container Registry login
After=docker.service network-online.target
RequiresMountsFor=${STATE_DIR}

[Service]
Type=oneshot
User=${SERVICE_USER}
Group=${SERVICE_USER}
Environment=RMD_ROOT=${STATE_DIR}
Environment=REGISTRY=${registry}
ExecStart=${BIN_DIR}/acr-login.sh --refresh
TimeoutStartSec=5min
EOF
}

render_acr_login_timer() {
  cat <<'EOF'
[Unit]
Description=Refresh the registry login before its token expires

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
AccuracySec=1min
Unit=rmd-acr-login.service

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

# W1-T2953 — CHECK COMPARES DIRECTIVES, INSTALL WRITES EVERYTHING. A byte-for-byte compare read six
# of seven artifacts DRIFTED against Azure on 2026-09-06, mostly comment wording, and `--install`
# looked like the remedy while it would have DELETED four real guards. A unit's semantics ARE its
# directives, so check compares effective directive lines EXACTLY (every guard deletion is still
# caught) and ignores prose; install still writes the full text, comments included.
effective_directives() {
  printf '%s\n' "$1" | sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d'
}

render_scratch_lib() { cat "${SCRIPT_DIR}/scratch-mounts.sh"; }

# path : renderer : mode
UNITS="
${LAUNCHER}:render_launcher:0755
${BIN_DIR}/rmd-scratch-mounts:render_scratch_lib:0755
${UNIT_DIR}/${SERVICE_UNIT_NAME}:render_fleet_service:0644
${UNIT_DIR}/${WATCHDOG_SERVICE_NAME}:render_watchdog_service:0644
${UNIT_DIR}/${WATCHDOG_TIMER_NAME}:render_watchdog_timer:0644
"
if [ -z "$INSTANCE_NAME" ] || [ "$INSTANCE_NAME" = "core" ]; then
  UNITS="${UNITS}
${BIN_DIR}/acr-login.sh:render_acr_login_bin:0755
${UNIT_DIR}/rmd-acr-login.service:render_acr_login_service:0644
${UNIT_DIR}/rmd-acr-login.timer:render_acr_login_timer:0644
${BIN_DIR}/rmd-reap-stray-containers:render_reaper_bin:0755
${UNIT_DIR}/rmd-reap-stray.service:render_reaper_service:0644
${UNIT_DIR}/rmd-reap-stray.timer:render_reaper_timer:0644
"
fi

host_apt() {
  if [ -n "${RMD_HOST_APT_CMD:-}" ]; then "${RMD_HOST_APT_CMD}" "$@"
  else "$@"; fi
}

converge_host_node() {
  local pin actual node_path major source source_text desired versions package after
  source="${RMD_NODESOURCE_PATH:-/etc/apt/sources.list.d/nodesource.sources}"
  node_path="$(command -v node || true)"
  actual="$(node --version 2>/dev/null || true)"
  actual="${actual#v}"
  actual="${actual:-unavailable}"
  if ! pin="$(cat "${SCRIPT_DIR%/deploy}/.nvmrc" 2>/dev/null)"; then
    echo "host-node: cannot read checkout .nvmrc; staying on ${actual}, retried next converge"
    return 0
  fi
  pin="${pin#v}"
  if ! printf '%s\n' "$pin" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "host-node: invalid .nvmrc pin '${pin}'; staying on ${actual}, retried next converge"
    return 0
  fi
  major="${pin%%.*}"
  if [ "$MODE" = check ]; then
    if [ "$actual" != "$pin" ]; then
      echo "install-host-units: DRIFTED host-node ${actual} != ${pin}"
      drift=$(( drift + 1 ))
    else
      echo "install-host-units: ok      host-node ${actual}"
    fi
    return 0
  fi
  if [ ! -f "$source" ] || [ "$node_path" != "${RMD_HOST_NODE_PATH:-/usr/bin/node}" ]; then
    echo "host-node: unmanaged node=${node_path:-missing} version=${actual} source=${source}; unchanged"
    return 0
  fi
  if ! source_text="$(cat "$source")"; then
    echo "host-node: cannot read ${source}; staying on ${actual}, retried next converge"
    return 0
  fi
  if ! printf '%s\n' "$source_text" | grep -Eq '^URIs:.*https?://deb\.nodesource\.com/node_[0-9]+\.x([/[:space:]]|$)'; then
    echo "host-node: unmanaged source=${source} node=${node_path} version=${actual}; unchanged"
    return 0
  fi
  if ! desired="$(printf '%s\n' "$source_text" | sed "/^URIs:/s|\(https\{0,1\}://deb\.nodesource\.com/node_\)[0-9][0-9]*\.x|\1${major}.x|g")"; then
    echo "host-node: cannot render ${source}; staying on ${actual}, retried next converge"
    return 0
  fi
  if [ "$desired" != "$source_text" ]; then
    if ! printf '%s\n' "$desired" > "$source"; then
      echo "host-node: cannot write ${source}; staying on ${actual}, retried next converge"
      return 0
    fi
    echo "host-node: source now node_${major}.x"
  elif [ "$actual" = "$pin" ]; then
    echo "host-node: in step ${actual}"
    return 0
  fi
  if ! host_apt apt-get update; then
    echo "host-node: apt-get update failed; staying on ${actual}, retried next converge"
    return 0
  fi
  if [ "$actual" = "$pin" ]; then return 0; fi
  package="${pin}-1nodesource1"
  if ! versions="$(host_apt apt-cache madison nodejs)"; then
    echo "host-node: apt-cache madison failed; staying on ${actual}, retried next converge"
    return 0
  fi
  if ! printf '%s\n' "$versions" | awk -F '|' -v want="$package" '
    { version=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", version); if (version == want) found=1 }
    END { exit !found }
  '; then
    echo "host-node: ${pin} not yet in node_${major}.x; staying on ${actual}, retried next converge"
    return 0
  fi
  if ! host_apt apt-get install -y "nodejs=${package}"; then
    echo "host-node: apt-get install failed for ${package}; staying on ${actual}, retried next converge"
    return 0
  fi
  after="$(node --version 2>/dev/null || true)"
  after="${after#v}"
  if [ "$after" = "$pin" ]; then
    echo "host-node: installed ${pin} (${package})"
  else
    echo "host-node: install returned success but node is still ${after:-unavailable} != ${pin}; retried next converge"
  fi
}

drift=0
converge_host_node
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

# W1-T4770 — the root-disk janitor and its crontab entry. Not a unit: a script COPIED from this repo
# plus one crontab line, so it sits outside the UNITS table and is compared byte for byte. The cron
# entry is REPLACED, never appended: every line running the script's path is dropped and one written.
# Managed only where real: default host layout (core instance) or an explicit RMD_CLEANUP_PATH, so
# test temp trees never touch a real home or crontab.
CLEANUP_CRON_SCHEDULE='7 */6 * * *'
CLEANUP_SRC="${SCRIPT_DIR}/rmd-host-cleanup.sh"
CLEANUP_PATH="${RMD_CLEANUP_PATH-}"
if [ -z "$CLEANUP_PATH" ] && [ "$UNIT_DIR" = "/etc/systemd/system" ] && { [ -z "$INSTANCE_NAME" ] || [ "$INSTANCE_NAME" = "core" ]; }; then
  CLEANUP_PATH="/home/${SERVICE_USER}/rmd-host-cleanup.sh"
fi
if [ -n "$CLEANUP_PATH" ]; then
  require_abs_path "RMD_CLEANUP_PATH" "$CLEANUP_PATH"
  TMP_SWEEP_SRC="${SCRIPT_DIR}/rmd-tmp-sweep.sh"
  TMP_SWEEP_PATH="${RMD_TMP_SWEEP_PATH-$(dirname "$CLEANUP_PATH")/rmd-tmp-sweep.sh}"
  TMP_SWEEP_CRON_PATH="${RMD_TMP_SWEEP_CRON_PATH-}"
  if [ -z "$TMP_SWEEP_CRON_PATH" ] && [ "$UNIT_DIR" = "/etc/systemd/system" ] && { [ -z "$INSTANCE_NAME" ] || [ "$INSTANCE_NAME" = "core" ]; }; then
    TMP_SWEEP_CRON_PATH="/etc/cron.d/rmd-tmp-sweep"
  fi
  require_abs_path "RMD_TMP_SWEEP_PATH" "$TMP_SWEEP_PATH"
  if [ -n "$TMP_SWEEP_CRON_PATH" ]; then
    require_abs_path "RMD_TMP_SWEEP_CRON_PATH" "$TMP_SWEEP_CRON_PATH"
    TMP_SWEEP_CRON_LINE="0 * * * * root RMD_HOST_CLEANUP_SCRIPT=${CLEANUP_PATH} ${TMP_SWEEP_PATH} >> ${RMD_CLEANUP_LOG:-$(dirname "$CLEANUP_PATH")/host-cleanup.log} 2>&1"
    TMP_SWEEP_CRON_CONTENT="$(printf 'SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n%s\n' "$TMP_SWEEP_CRON_LINE")"
  fi
  CLEANUP_LOG="${RMD_CLEANUP_LOG:-$(dirname "$CLEANUP_PATH")/host-cleanup.log}"
  CLEANUP_CRON_LINE="${CLEANUP_CRON_SCHEDULE} ${CLEANUP_PATH} >> ${CLEANUP_LOG} 2>&1"
  CRONTAB_CMD="${RMD_CRONTAB_CMD-crontab}"

  crontab_read() {
    if [ -z "${RMD_CRONTAB_CMD+x}" ] && [ "$(id -u)" = 0 ]; then "$CRONTAB_CMD" -u "$SERVICE_USER" -l 2>/dev/null || true
    else "$CRONTAB_CMD" -l 2>/dev/null || true; fi
  }
  crontab_write() {
    if [ -z "${RMD_CRONTAB_CMD+x}" ] && [ "$(id -u)" = 0 ]; then "$CRONTAB_CMD" -u "$SERVICE_USER" -
    else "$CRONTAB_CMD" -; fi
  }
  cron_lines_for_janitor() { printf '%s\n' "$1" | grep -F -- "$CLEANUP_PATH" || true; }
  cron_without_janitor() { printf '%s\n' "$1" | grep -F -v -- "$CLEANUP_PATH" || true; }

  if [ ! -r "$CLEANUP_SRC" ]; then
    echo "install-host-units: FATAL -- ${CLEANUP_SRC} is missing; the janitor cannot be installed." >&2
    exit 2
  fi
  if [ ! -r "$TMP_SWEEP_SRC" ]; then
    echo "install-host-units: FATAL -- ${TMP_SWEEP_SRC} is missing; the temp sweep cannot be installed." >&2
    exit 2
  fi
  current_cron="$(crontab_read)"
  janitor_cron="$(cron_lines_for_janitor "$current_cron")"
  if [ "$MODE" = "check" ]; then
    if [ ! -e "$CLEANUP_PATH" ]; then
      echo "install-host-units: MISSING $CLEANUP_PATH"; drift=$(( drift + 1 ))
    elif ! cmp -s "$CLEANUP_SRC" "$CLEANUP_PATH"; then
      echo "install-host-units: DRIFTED $CLEANUP_PATH (differs from deploy/rmd-host-cleanup.sh)"; drift=$(( drift + 1 ))
    else
      echo "install-host-units: ok      $CLEANUP_PATH"
    fi
    if [ -z "$janitor_cron" ]; then
      echo "install-host-units: MISSING crontab entry for $CLEANUP_PATH"; drift=$(( drift + 1 ))
    elif [ "$janitor_cron" != "$CLEANUP_CRON_LINE" ]; then
      echo "install-host-units: DRIFTED crontab entry for $CLEANUP_PATH (want exactly: $CLEANUP_CRON_LINE)"; drift=$(( drift + 1 ))
    else
      echo "install-host-units: ok      crontab entry for $CLEANUP_PATH"
    fi
    if [ ! -e "$TMP_SWEEP_PATH" ]; then
      echo "install-host-units: MISSING $TMP_SWEEP_PATH"; drift=$(( drift + 1 ))
    elif ! cmp -s "$TMP_SWEEP_SRC" "$TMP_SWEEP_PATH"; then
      echo "install-host-units: DRIFTED $TMP_SWEEP_PATH (differs from deploy/rmd-tmp-sweep.sh)"; drift=$(( drift + 1 ))
    else
      echo "install-host-units: ok      $TMP_SWEEP_PATH"
    fi
    if [ -n "$TMP_SWEEP_CRON_PATH" ]; then
      current_tmp_sweep_cron="$(cat "$TMP_SWEEP_CRON_PATH" 2>/dev/null || true)"
      if [ ! -e "$TMP_SWEEP_CRON_PATH" ]; then
        echo "install-host-units: MISSING $TMP_SWEEP_CRON_PATH"; drift=$(( drift + 1 ))
      elif [ "$current_tmp_sweep_cron" != "$TMP_SWEEP_CRON_CONTENT" ]; then
        echo "install-host-units: DRIFTED $TMP_SWEEP_CRON_PATH (hourly 6-hour guarded temp sweep differs)"; drift=$(( drift + 1 ))
      else
        echo "install-host-units: ok      $TMP_SWEEP_CRON_PATH"
      fi
    fi
  else
    mkdir -p "$(dirname "$CLEANUP_PATH")"
    # keep the differing hand-installed host copy once: adoption must not destroy its values
    if [ -e "$CLEANUP_PATH" ] && ! cmp -s "$CLEANUP_SRC" "$CLEANUP_PATH" && [ ! -e "${CLEANUP_PATH}.pre-t4770" ]; then
      cp -p "$CLEANUP_PATH" "${CLEANUP_PATH}.pre-t4770"
      echo "install-host-units: saved   ${CLEANUP_PATH}.pre-t4770 (the previous host copy)"
    fi
    tmp="${CLEANUP_PATH}.tmp.$$"
    cp "$CLEANUP_SRC" "$tmp"
    chmod 0755 "$tmp"
    mv -f "$tmp" "$CLEANUP_PATH"
    echo "install-host-units: wrote   $CLEANUP_PATH"
    mkdir -p "$(dirname "$TMP_SWEEP_PATH")"
    if [ -e "$TMP_SWEEP_PATH" ] && ! cmp -s "$TMP_SWEEP_SRC" "$TMP_SWEEP_PATH" && [ ! -e "${TMP_SWEEP_PATH}.pre-6h-sweep" ]; then
      cp -p "$TMP_SWEEP_PATH" "${TMP_SWEEP_PATH}.pre-6h-sweep"
      echo "install-host-units: saved   ${TMP_SWEEP_PATH}.pre-6h-sweep (the previous temp sweep wrapper)"
    fi
    tmp="${TMP_SWEEP_PATH}.tmp.$$"
    cp "$TMP_SWEEP_SRC" "$tmp"
    chmod 0755 "$tmp"
    mv -f "$tmp" "$TMP_SWEEP_PATH"
    echo "install-host-units: wrote   $TMP_SWEEP_PATH"
    if [ -n "$TMP_SWEEP_CRON_PATH" ]; then
      mkdir -p "$(dirname "$TMP_SWEEP_CRON_PATH")"
      current_tmp_sweep_cron="$(cat "$TMP_SWEEP_CRON_PATH" 2>/dev/null || true)"
      if [ -e "$TMP_SWEEP_CRON_PATH" ] && [ "$current_tmp_sweep_cron" != "$TMP_SWEEP_CRON_CONTENT" ] && [ ! -e "${TMP_SWEEP_CRON_PATH}.pre-6h-sweep" ]; then
        cp -p "$TMP_SWEEP_CRON_PATH" "${TMP_SWEEP_CRON_PATH}.pre-6h-sweep"
        echo "install-host-units: saved   ${TMP_SWEEP_CRON_PATH}.pre-6h-sweep (the previous temp sweep schedule)"
      fi
      tmp="${TMP_SWEEP_CRON_PATH}.tmp.$$"
      printf '%s\n' "$TMP_SWEEP_CRON_CONTENT" > "$tmp"
      chmod 0644 "$tmp"
      mv -f "$tmp" "$TMP_SWEEP_CRON_PATH"
      echo "install-host-units: wrote   $TMP_SWEEP_CRON_PATH"
    fi
    rest_cron="$(cron_without_janitor "$current_cron")"
    if [ -n "$rest_cron" ]; then
      printf '%s\n%s\n' "$rest_cron" "$CLEANUP_CRON_LINE" | crontab_write
    else
      printf '%s\n' "$CLEANUP_CRON_LINE" | crontab_write
    fi
    echo "install-host-units: wrote   crontab entry: $CLEANUP_CRON_LINE"
  fi
fi

# The session slice cap (2026-10-09). The operator capped user-<uid>.slice by hand, and a rebuilt host
# would come up without it. deploy/resource-policy.sh sizes the cap from this host's RAM; see the
# note there. MemoryHigh only, never MemoryMax, so a session is throttled and never killed. It is
# WRITTEN ONLY WHEN ITS DIRECTIVES DIFFER: a current file, even the hand-written one, is left
# untouched. It is managed in the default/core layout only, and only when the service user's uid
# resolves. An unresolvable uid or MemTotal is reported and skipped; it is never guessed.
SESSION_SLICE_DROPIN=""
SESSION_SLICE_WANT=""
SESSION_SLICE_WRITTEN=0
if [ -z "$INSTANCE_NAME" ] || [ "$INSTANCE_NAME" = "core" ]; then
  # shellcheck source=deploy/resource-policy.sh
  . "${SCRIPT_DIR}/resource-policy.sh"
  SESSION_UID="${RMD_SERVICE_UID:-$(id -u "$SERVICE_USER" 2>/dev/null || true)}"
  case "$SESSION_UID" in
    ''|*[!0-9]*) echo "install-host-units: skipped session slice cap -- no uid for service user '${SERVICE_USER}'" ;;
    *)
      SESSION_SLICE_DROPIN="${UNIT_DIR}/user-${SESSION_UID}.slice.d/50-rmd-cap.conf"
      resource_policy_session_slice # sets RP_SESSION_* here; the render below runs in a subshell
      SESSION_SLICE_WANT="$(resource_policy_session_slice_dropin)"
      if [ -z "$SESSION_SLICE_WANT" ]; then
        echo "install-host-units: skipped session slice cap -- ${RP_SESSION_NOTE}"
        SESSION_SLICE_DROPIN=""
      fi ;;
  esac
fi
if [ -n "$SESSION_SLICE_DROPIN" ]; then
  if [ -e "$SESSION_SLICE_DROPIN" ] && [ "$(effective_directives "$SESSION_SLICE_WANT")" = "$(effective_directives "$(cat "$SESSION_SLICE_DROPIN" 2>/dev/null)")" ]; then
    echo "install-host-units: ok      $SESSION_SLICE_DROPIN"
  elif [ "$MODE" = "check" ]; then
    if [ -e "$SESSION_SLICE_DROPIN" ]; then
      echo "install-host-units: DRIFTED $SESSION_SLICE_DROPIN (want: $(effective_directives "$SESSION_SLICE_WANT" | grep -v '^\[' | paste -sd' ' -))"
    else
      echo "install-host-units: MISSING $SESSION_SLICE_DROPIN"
    fi
    drift=$(( drift + 1 ))
  else
    mkdir -p "$(dirname "$SESSION_SLICE_DROPIN")"
    tmp="${SESSION_SLICE_DROPIN}.tmp.$$"
    printf '%s\n' "$SESSION_SLICE_WANT" > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$SESSION_SLICE_DROPIN"
    SESSION_SLICE_WRITTEN=1
    echo "install-host-units: wrote   $SESSION_SLICE_DROPIN (${RP_SESSION_NOTE})"
  fi
fi

# W1-T5518 — the retired host-only user janitor (in no repo; 569 false EMERGENCY runs) is drift while
# its unit files remain. Report only; a real home is read only in the real host layout or via override.
LEGACY_JANITOR_TIMER="azure-remudero-janitor.timer"
LEGACY_JANITOR_SERVICE="azure-remudero-janitor.service"
HOST_KERNEL="${RMD_HOST_KERNEL:-$(uname -s 2>/dev/null || echo unknown)}"
LEGACY_USER_UNIT_DIR="${RMD_LEGACY_USER_UNIT_DIR-}"
if [ -z "$LEGACY_USER_UNIT_DIR" ] && [ "$UNIT_DIR" = "/etc/systemd/system" ]; then
  LEGACY_USER_UNIT_DIR="/home/${SERVICE_USER}/.config/systemd/user"
fi
legacy=0
if [ "$HOST_KERNEL" = "Linux" ] && [ -n "$LEGACY_USER_UNIT_DIR" ]; then
  for legacy_path in "${LEGACY_USER_UNIT_DIR}/${LEGACY_JANITOR_TIMER}" "${LEGACY_USER_UNIT_DIR}/${LEGACY_JANITOR_SERVICE}" \
                     "${LEGACY_USER_UNIT_DIR}"/*.wants/"${LEGACY_JANITOR_TIMER}"; do
    if [ -e "$legacy_path" ] || [ -L "$legacy_path" ]; then
      echo "install-host-units: LEGACY $legacy_path (the retired host-only user janitor; --install never edits a user unit)"
      legacy=$(( legacy + 1 ))
    fi
  done
  if [ "$legacy" -gt 0 ]; then
    echo "install-host-units: retire it as ${SERVICE_USER}: systemctl --user disable --now ${LEGACY_JANITOR_TIMER} && rm -f ${LEGACY_USER_UNIT_DIR}/${LEGACY_JANITOR_TIMER} ${LEGACY_USER_UNIT_DIR}/${LEGACY_JANITOR_SERVICE} && systemctl --user daemon-reload"
    if [ "$MODE" = "check" ]; then drift=$(( drift + legacy )); fi
  fi
fi

if [ "$MODE" = "check" ]; then
  if [ "$drift" -gt 0 ]; then
    echo "install-host-units: ${drift} unit(s) missing or drifted — re-run with --install (as root)." >&2
    if [ "$legacy" -gt 0 ]; then
      echo "install-host-units: ${legacy} of them LEGACY — --install does not retire those; run the retire command above as ${SERVICE_USER}." >&2
    fi
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
    systemctl enable --now rmd-acr-login.timer >/dev/null
    systemctl enable --now rmd-reap-stray.timer >/dev/null
    echo "install-host-units: reloaded systemd and enabled ${SERVICE_UNIT_NAME}, ${WATCHDOG_TIMER_NAME}, rmd-reap-stray.timer"
  else
    echo "install-host-units: reloaded systemd and enabled ${SERVICE_UNIT_NAME}, ${WATCHDOG_TIMER_NAME}"
  fi
  echo "install-host-units: NOTE — the daemon itself was not started or stopped; run ${LAUNCHER} to bring it up."
fi

# A rewritten slice drop-in takes effect at the daemon-reload above. Confirm it from what systemd
# holds. If systemd still holds the old value, apply the same values at runtime so the cap is live
# now and not only after the next reboot.
if [ "$SESSION_SLICE_WRITTEN" = 1 ] && [ "$UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
  session_slice="user-${SESSION_UID}.slice"
  live_high="$(systemctl show "$session_slice" -p MemoryHigh --value 2>/dev/null || true)"
  if [ "$live_high" = "$((RP_SESSION_HIGH_MIB * 1024 * 1024))" ]; then
    echo "install-host-units: ${session_slice} MemoryHigh confirmed live at ${RP_SESSION_HIGH_MIB} MiB"
  elif systemctl set-property --runtime "$session_slice" "MemoryHigh=${RP_SESSION_HIGH_MIB}M" "CPUWeight=${RMD_SESSION_CPU_WEIGHT}" 2>/dev/null; then
    echo "install-host-units: ${session_slice} read MemoryHigh=${live_high:-unknown} after the reload; applied ${RP_SESSION_HIGH_MIB} MiB at runtime"
  else
    echo "install-host-units: WARNING ${session_slice} MemoryHigh reads ${live_high:-unknown}, not ${RP_SESSION_HIGH_MIB} MiB; the file takes effect at the next boot" >&2
  fi
fi
