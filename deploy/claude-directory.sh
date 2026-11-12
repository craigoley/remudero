#!/usr/bin/env bash
# One host credential-directory derivation for the daemon and serve launchers.
claude_host_directory() {
  printf '%s\n' "${RMD_CLAUDE_DIR:-${HOME:-/root}/.claude}"
}
# W1-T12293: the CLI's account file sits beside that directory, so it is the same path plus `.json`.
claude_host_account_file() {
  local directory
  directory="$(claude_host_directory)" || return
  printf '%s\n' "${RMD_CLAUDE_JSON_PATH:-${directory%/}.json}"
}
