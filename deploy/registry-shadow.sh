#!/usr/bin/env bash
# Explicit private qualification only. No exports, mounts, schedulers or effect gates.
registry_shadow_session=""
registry_shadow_pin="${registry_shadow_pin:-}"
registry_shadow_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
registry_shadow_args=()
# Host directories a consumer bind-mounts into UID-1000 workers. A consumer adds its actual roots
# (registry_shadow_mount_root) once it has computed them; the observer refuses a session inside any.
registry_shadow_mounted_roots=()
# BACKSTOP, not pacing: a healthy observer exits in well under a second, so this bounds only a hung one.
# Five seconds killed healthy cold starts on the CPU-saturated fleet host (#15638's review, 2026-11-03).
registry_shadow_deadline_s="${RMD_REGISTRY_SHADOW_DEADLINE_S:-20}"
case "$registry_shadow_deadline_s" in ''|*[!0-9]*|0) registry_shadow_deadline_s=20 ;; esac

# A known child without this argv grammar keeps its original arguments. This reads one trusted
# script, never executes an old reader as a capability probe. The whole file is read, not a fixed
# head: W1-T10573's shared guards pushed recycle-container.sh's case from line 104 to 387, past the
# old 256-line window, so the maintained recycler read as an old child and lost its observations.
# BACKSTOP, not a window: an unexpectedly huge file is refused rather than read.
registry_shadow_supports() {
  [ -f "$1" ] && [ -r "$1" ] || return 1
  [ "$(wc -c < "$1")" -le 4194304 ] || return 1
  grep -F -- '--selected-registry-shadow)' "$1" >/dev/null && grep -F -- '--selected-registry-pin)' "$1" >/dev/null
}

registry_shadow_mount_root() {
  local root
  for root in "$@"; do
    case "$root" in /*) registry_shadow_mounted_roots+=("$root") ;; esac
  done
}

# Maintained launch arrays express scratch binds as -v source:destination. Record their actual
# sources, including plans derived before an environment/default changes, without changing the plan.
registry_shadow_mount_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -v|--volume)
        shift
        [ "$#" -gt 0 ] || return 0
        registry_shadow_mount_root "${1%%:*}" ;;
    esac
    shift
  done
}

# Use the maintained readiness reader in a subshell so qualification never changes the launch arrays.
registry_shadow_codex_mount_root() {
  local source
  if source="$(
    . "$1" && { codex_sessions_plan "$2" || :; } && printf '%s' "$CODEX_SESSIONS_SRC"
  )" 2>/dev/null; then
    registry_shadow_mount_root "$source"
  else
    printf '%s\n' 'instance_registry.shell_shadow_unrecorded' >&2 || :
    return 1
  fi
}

# Design constraint 3: the private session must never sit in a directory a fleet launcher mounts into
# workers. These are the roots every consumer derives its mounts from, from the same variables and
# HOME defaults (recycle-container.sh, host-update.sh, serve-container.sh, install-host-units.sh),
# so the check holds at capture, before a consumer has computed its own list.
registry_shadow_root_args() {
  local home="${HOME:-/root}" root
  for root in "${RMD_STATE_DIR:-}" "${DAEMON_STATE_DIR:-}" "${INSTANCE_STATE_DIR:-}" "${RMD_CLAUDE_DIR:-}" \
    "${RMD_CODEX_DIR:-}" "${RMD_CONTAINER_CONFIG_DIR:-}" "${RMD_SERVE_REPO_DIR:-}" "${SERVE_GENS_DIR_OVERRIDE:-}" \
    "${RMD_SCRATCH_ROOT:-/mnt/scratch}" \
    "$home/rmd-state" "$home/rmd-state2" "$home/.claude" "$home/.codex" "$home/.config/remudero-container" \
    "$home/rmd-serve-repo" "$home/rmd-serve-gens" ${registry_shadow_mounted_roots[@]+"${registry_shadow_mounted_roots[@]}"}; do
    case "$root" in /*) printf '%s\0' --mounted-root "$root" ;; esac
  done
}

registry_shadow_call() (
  local observer_pid deadline_pid observer_status=0
  # Keep job control local to this subshell: each job has a private process group.
  # The deadline kills the observer AND its inherited-pipe children,
  # including a child-entry process stalled before capture or during observation.
  {
    set -m
    (
      local observer_user=()
      # sudo's caller owns the private session. Run only the observer back as that
      # caller; the installer and all legacy effects retain their elevated identity.
      # The observer still checks both owners itself, with no root ownership exemption.
      if [ "$(id -u)" = 0 ]; then
        case "${SUDO_UID:-}" in
          ''|0|*[!0-9]*) ;;
          *) observer_user=(sudo -n -u "#${SUDO_UID}" -- env)
            if [ "${RMD_INSTANCE_REGISTRY+x}" = x ]; then
              observer_user+=("RMD_INSTANCE_REGISTRY=$RMD_INSTANCE_REGISTRY")
            fi ;;
        esac
      fi
      local root_args=() arg
      while IFS= read -r -d '' arg; do root_args+=("$arg"); done < <(registry_shadow_root_args)
      exec ${observer_user[@]+"${observer_user[@]}"} node --import "$registry_shadow_root/node_modules/tsx/dist/loader.mjs" \
        "$registry_shadow_root/src/lib/child-entry-argv.ts" --selected-registry-shadow "$registry_shadow_root" --shadow \
        --session "$registry_shadow_session" ${root_args[@]+"${root_args[@]}"} "$@"
    ) &
    observer_pid=$!
    (sleep "$registry_shadow_deadline_s"; kill -KILL -- "-$observer_pid" 2>/dev/null || :) >/dev/null 2>&1 &
    deadline_pid=$!
    wait "$observer_pid" || observer_status=$?
    kill -KILL -- "-$deadline_pid" 2>/dev/null || :
    wait "$deadline_pid" 2>/dev/null || :
  } 2>/dev/null
  if [ "$observer_status" -ne 0 ]; then
    printf '%s\n' 'instance_registry.shell_shadow_unrecorded' >&2 || :
  fi
  return 0
)

registry_shadow_start() {
  registry_shadow_args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --selected-registry-shadow)
        registry_shadow_session="${2:-}"
        if [ "$#" -ge 2 ]; then shift 2; else shift; fi ;;
      *) registry_shadow_args+=("$1"); shift ;;
    esac
  done
  if [ -n "$registry_shadow_session" ] && [ -z "$registry_shadow_pin" ]; then
    registry_shadow_pin="$(registry_shadow_call --capture)"
  fi
}

registry_shadow_observe() {
  [ -n "$registry_shadow_session" ] || return 0
  registry_shadow_call --pin "$registry_shadow_pin" --consumer "$1" --instance "${2:-}" --repository "${3:-}" \
    --namespace "${4:-host}" --identity "${5:-}" >/dev/null
}
