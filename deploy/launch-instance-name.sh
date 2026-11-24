#!/usr/bin/env bash
# launch-instance-name.sh — sourced by deploy/recycle-container.sh and deploy/install-host-units.sh.
#
# rmd_launch_instance_name --registry <file> --container <name> --state-dir <dir>
#
# Prints the name of the ONE registry row whose container_name equals <name> and whose state_dir
# equals <dir> (a trailing slash is ignored). Prints nothing, and returns 0, when the registry is
# absent or unreadable, when no row or more than one row matches both columns, or when the name
# is not a valid instance name. The row grammar is the one list_instance_names reads: a name is a
# 2-space-indented key, a field is a 4-space-indented key. It needs no node.
rmd_launch_instance_name() {
  local registry="" container="" state_dir="" name=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --registry) registry="${2-}" ;;
      --container) container="${2-}" ;;
      --state-dir) state_dir="${2-}" ;;
      *) return 0 ;;
    esac
    [ "$#" -ge 2 ] || return 0
    shift 2
  done
  [ -n "$registry" ] && [ -n "$container" ] && [ -n "$state_dir" ] || return 0
  [ -f "$registry" ] && [ -r "$registry" ] || return 0
  name="$(RMD_LAUNCH_WANT_CONTAINER="$container" RMD_LAUNCH_WANT_STATE_DIR="$state_dir" awk '
    function bare(p) { while (length(p) > 1 && substr(p, length(p)) == "/") p = substr(p, 1, length(p) - 1); return p }
    function settle() {
      if (current != "" && row_container == ENVIRON["RMD_LAUNCH_WANT_CONTAINER"] && row_state != "" &&
          bare(row_state) == bare(ENVIRON["RMD_LAUNCH_WANT_STATE_DIR"])) { matches++; found = current }
    }
    { sub(/[[:space:]]+#.*/, "") }
    /^[[:space:]]*$/ { next }
    $0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      settle()
      current = $1; sub(/:$/, "", current); row_container = ""; row_state = ""
      next
    }
    current != "" && $0 ~ /^    [A-Za-z_]+:[[:space:]]*/ {
      key = $1; sub(/:$/, "", key)
      value = $0; sub(/^    [A-Za-z_]+:[[:space:]]*/, "", value); sub(/[[:space:]]+$/, "", value); gsub(/^"|"$/, "", value)
      if (key == "container_name") row_container = value
      else if (key == "state_dir") row_state = value
    }
    END { settle(); if (matches == 1) print found }
  ' "$registry" 2>/dev/null)" || return 0
  case "$name" in
    ""|*[!a-zA-Z0-9_-]*) return 0 ;;
  esac
  printf '%s\n' "$name"
}
