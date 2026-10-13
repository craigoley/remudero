#!/usr/bin/env bash
# recycle-actions — one-shot, reviewed steps a recycle runs for its own instance (W1-T9071).
#
# WHY. Some host changes are safe only while an instance's container is gone: moving data its
# container binds, for one. A recycle already opens that window, between `docker rm` and `docker run`,
# so an operator ENABLES a step once and the next recycle, whenever it comes, does it. Nobody has to
# remember to be there.
#
# INVARIANTS:
#   - only reviewed code runs: deploy/recycle-actions/<name>.sh. A marker is a NAME, never code.
#   - a marker runs once: done/ or failed/ receives it, with a receipt line in the log.
#   - an action NEVER fails the recycle. It is bounded, and whatever it returns the recycle carries
#     on with the configuration it would have used anyway.
# Falsifier: test/a-recycle-runs-its-pending-actions-in-the-stopped-window.test.ts.
#
# USAGE  . recycle-actions.sh; recycle_actions_run <stopped|post-start> <state-dir>
# ENABLE mkdir -p <state-dir>/recycle-actions/pending && touch <state-dir>/recycle-actions/pending/<name>
# SEAMS  RMD_RECYCLE_ACTIONS_DIR (deploy/recycle-actions next to this file), RMD_RECYCLE_ACTION_TIMEOUT_S (900).

RECYCLE_ACTIONS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

recycle_actions_dir() { printf '%s' "${RMD_RECYCLE_ACTIONS_DIR:-${RECYCLE_ACTIONS_LIB_DIR}/recycle-actions}"; }

# The phase a reviewed action declares on a `# phase: <name>` line; empty when it declares none.
recycle_action_phase() {
  sed -n 's/^# phase: *\([a-z-]*\) *$/\1/p' "$1" | head -n 1
}

# Run every pending action of <phase> for the instance whose state dir is <state-dir>. Always returns 0.
recycle_actions_run() {
  local phase="$1" state_dir="$2" root pending marker name script declared stamp rc reason log timeout_s
  root="${state_dir}/recycle-actions"
  pending="${root}/pending"
  [ -d "${pending}" ] || return 0
  log="${root}/log"
  timeout_s="${RMD_RECYCLE_ACTION_TIMEOUT_S:-900}"
  mkdir -p "${root}/done" "${root}/failed" 2>/dev/null || true
  for marker in "${pending}"/*; do
    [ -f "${marker}" ] || continue
    name="$(basename "${marker}")"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    case "${name}" in
      *[!a-z0-9-]*|"")
        reason="malformed action name"; rc=2 ;;
      *)
        script="$(recycle_actions_dir)/${name}.sh"
        if [ ! -f "${script}" ]; then
          reason="no reviewed script deploy/recycle-actions/${name}.sh"; rc=2
        else
          declared="$(recycle_action_phase "${script}")"
          # Another phase's action waits for that phase; it is not this phase's failure.
          [ "${declared}" = "${phase}" ] || { [ -n "${declared}" ] && continue; }
          if [ -z "${declared}" ]; then
            reason="the script declares no '# phase:' line"; rc=2
          else
            echo "recycle-actions: ${phase}: running ${name} (bounded ${timeout_s}s)"
            # The caller's own codex dir and container name reach the action; nothing else of its state does.
            if command -v timeout >/dev/null 2>&1; then
              RECYCLE_ACTION_STATE_DIR="${state_dir}" RECYCLE_ACTION_PHASE="${phase}" \
                RECYCLE_ACTION_CODEX_DIR="${CODEX_DIR:-}" RECYCLE_ACTION_CONTAINER="${CONTAINER_NAME:-}" \
                timeout "${timeout_s}" bash "${script}" "${state_dir}" >> "${log}" 2>&1
            else
              # A host with no `timeout` (stock macOS) runs the action unbounded and says so.
              echo "recycle-actions: ${phase}: no timeout(1) on this host; ${name} runs unbounded"
              RECYCLE_ACTION_STATE_DIR="${state_dir}" RECYCLE_ACTION_PHASE="${phase}" \
                RECYCLE_ACTION_CODEX_DIR="${CODEX_DIR:-}" RECYCLE_ACTION_CONTAINER="${CONTAINER_NAME:-}" \
                bash "${script}" "${state_dir}" >> "${log}" 2>&1
            fi
            rc=$?
            if [ "${rc}" -eq 0 ]; then reason="ok"
            elif [ "${rc}" -eq 124 ]; then reason="timed out after ${timeout_s}s"
            else reason="exited ${rc}"
            fi
          fi
        fi ;;
    esac
    if [ "${rc}" -eq 0 ]; then
      mv -f "${marker}" "${root}/done/${name}.${stamp}" 2>/dev/null || true
      echo "recycle-actions: ${phase}: ${name} DONE"
    else
      mv -f "${marker}" "${root}/failed/${name}.${stamp}" 2>/dev/null || true
      echo "recycle-actions: ${phase}: ${name} FAILED (${reason}) — the recycle continues without it" >&2
    fi
    printf '%s phase=%s action=%s rc=%s reason=%s\n' "${stamp}" "${phase}" "${name}" "${rc}" "${reason}" >> "${log}" 2>/dev/null || true
  done
  return 0
}
