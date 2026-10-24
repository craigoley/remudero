#!/usr/bin/env bash
# One host credential-directory derivation for the daemon and serve launchers.
claude_host_directory() {
  printf '%s\n' "${RMD_CLAUDE_DIR:-${HOME:-/root}/.claude}"
}
