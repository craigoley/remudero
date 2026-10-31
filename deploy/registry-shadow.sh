#!/usr/bin/env bash
# Explicit private qualification only. No exports, mounts, schedulers or effect gates.
registry_shadow_session=""
registry_shadow_pin="${registry_shadow_pin:-}"
registry_shadow_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
registry_shadow_args=()

# A known child without this argv grammar keeps its original arguments. This probes one
# trusted script's bounded header, never executes an old reader as a capability probe.
registry_shadow_supports() {
  [ -r "$1" ] && head -n 256 "$1" | grep -F -- '--selected-registry-shadow)' >/dev/null
}

registry_shadow_call() (
  local observer_pid deadline_pid observer_status=0
  # Keep job control local to this subshell: each job has a private process group.
  # The five-second deadline kills the observer AND its inherited-pipe children,
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
      exec ${observer_user[@]+"${observer_user[@]}"} node --import "$registry_shadow_root/node_modules/tsx/dist/loader.mjs" \
        "$registry_shadow_root/src/lib/child-entry-argv.ts" --selected-registry-shadow "$registry_shadow_root" --shadow \
        --session "$registry_shadow_session" "$@"
    ) &
    observer_pid=$!
    (sleep 5; kill -KILL -- "-$observer_pid" 2>/dev/null || :) >/dev/null 2>&1 &
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
