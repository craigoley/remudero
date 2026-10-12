# shellcheck shell=bash
# THE HOST IMAGE-RECYCLE LOCK, SOURCED BY deploy/host-update.sh (2026-10-10).
#
# deploy/recycle-container.sh (#10582) holds a host-wide lock from before its `docker pull` until
# it exits, so pull → smoke → swap → reclaim is one critical section across every instance on the
# host. That closed the race in which one instance's `docker image prune -af` deleted another's
# pulled-but-unswapped image (core's recycle at 04:44Z: `No such image`, a PAUSE held for nothing).
#
# The nightly `host-update.sh --reclaim-only` cron runs the SAME `docker image prune -a` and took no
# lock, so it reopened that race once a night. These functions speak the recycle script's protocol
# EXACTLY — same default path, `mkdir` atomicity, `<pid> <who>` holder line, a dead holder reclaimed
# by `kill -0`, never by age — so the two scripts exclude each other.
#
# FALSIFIER: drop the acquire around host-update's image prune and a held lock no longer stops it.

rmd_host_recycle_lock_path() {
  printf '%s' "${RMD_RECYCLE_HOST_LOCK:-${HOME}/.local/state/remudero/recycle-container.lock}"
}

# rmd_take_host_recycle_lock <lock> <who> <wait_s> <poll_s>
# Returns 0 once taken, 1 if another live holder still has it after <wait_s>. Prints one line per wait.
rmd_take_host_recycle_lock() {
  local lock="$1" who="$2" wait_s="$3" poll_s="$4" waited=0 line pid holder
  mkdir -p "$(dirname "${lock}")"
  while :; do
    if mkdir "${lock}" 2>/dev/null; then
      printf '%s %s\n' "$$" "${who}" > "${lock}/holder"
      return 0
    fi
    line="$(cat "${lock}/holder" 2>/dev/null || true)"
    pid="${line%% *}"
    holder="${line#* }"
    case "${pid}" in ''|*[!0-9]*) pid="" ;; esac
    if [ -n "${pid}" ] && ! kill -0 "${pid}" 2>/dev/null; then
      echo "  host recycle lock held by DEAD pid ${pid} (${holder}) — reclaiming it"
      rm -f "${lock}/holder" 2>/dev/null
      rmdir "${lock}" 2>/dev/null || true
      continue
    fi
    if [ "${waited}" -ge "${wait_s}" ]; then
      RMD_HOST_RECYCLE_LOCK_HOLDER="${holder:-unknown} (pid ${pid:-unknown})"
      return 1
    fi
    echo "  deploy.recycle_waiting — ${holder:-another instance} (pid ${pid:-unknown}) holds the host recycle lock; waited ${waited}s"
    sleep "${poll_s}"
    waited=$((waited + poll_s))
  done
}

rmd_release_host_recycle_lock() {
  rm -f "$1/holder" 2>/dev/null
  rmdir "$1" 2>/dev/null
  return 0
}
