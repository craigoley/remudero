#!/usr/bin/env bash
# Explicit private qualification only. No exports, mounts, schedulers or effect gates.
registry_shadow_session=""
registry_shadow_pin="${registry_shadow_pin:-}"
registry_shadow_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
registry_shadow_args=()

# A known child without this argv grammar keeps its original arguments. This probes one
# trusted script's bounded header, never executes an old reader as a capability probe.
registry_shadow_supports() {
  [ -r "$1" ] && head -n 256 "$1" | grep -F -- '--selected-registry-shadow)' >/dev/null
}

registry_shadow_call() {
  node --import "$registry_shadow_root/node_modules/tsx/dist/loader.mjs" \
    "$registry_shadow_root/src/lib/child-entry-argv.ts" --selected-registry-shadow "$registry_shadow_root" --shadow \
    --session "$registry_shadow_session" "$@" 2>/dev/null ||
    printf '%s\n' 'instance_registry.shell_shadow_unrecorded' >&2 || :
  return 0
}

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
