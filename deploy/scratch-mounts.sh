#!/usr/bin/env bash
# scratch-mounts — bind the REBUILDABLE, I/O-heavy paths of a Remudero container to the host's
# ephemeral local NVMe (/mnt/scratch) instead of the data disk (/mnt/rmd).
#
# WHY. MEASURED 2026-10-01: the data disk, a 128 GB StandardSSD capped near 500 IOPS, sat at 85-93%
# utilisation under real load, mostly small reads from worker tests and git in worktrees (the daemon
# alone read 34.6 MB per 20 s). /mnt/scratch, a 440 GB local NVMe, sat at about 1%. Everything moved
# here can be rebuilt: worktrees are re-created per run, tmp is scratch by definition, coverage is
# re-measured, and the read model rebuilds itself from the ledger on an empty directory (~40 s).
# NOTHING AUTHORITATIVE MOVES: the ledger, repos, lanes, plan state, the read-model switch file and
# every other state file stay on the data disk, so a rollback loses nothing.
#
# WHAT MOVES (host source under ${RMD_SCRATCH_ROOT}/rmd/<state-dir name>/ -> container path):
#   worktrees          -> /home/node/Remudero/worktrees
#   tmp                -> /home/node/Remudero/tmp           (settings files handed to workers)
#   remudero-coverage  -> /home/node/Remudero/.remudero-coverage
#   read-model         -> /home/node/rmd-scratch/read-model  (RMD_READ_MODEL_DB_DIR maps state/ there)
#   containers/<name>/tmp -> /tmp                           (emptied at each launch, as a new
#                                                            container's own /tmp always was)
#
# SHIPS DARK. Nothing binds until the operator turns it on, in the same window as the Phase 3
# `serve-container.sh --replace` (docs/operator-guide.md "Scratch-disk mounts"):
#   on   RMD_SCRATCH=on, or the switch file ${RMD_SCRATCH_SWITCH} exists
#   off  RMD_SCRATCH=off, or no switch file: every launch is exactly today's
# An unmounted or unwritable scratch root is never an error: the launch proceeds without these
# binds and says why. Scratch is EPHEMERAL (a deallocate wipes it), so each launch records the
# directories it bound in <state-dir>/.scratch-mounts, and `--restore` (docker.service's
# ExecStartPre, installed by deploy/install-container-runtime-mount-order.sh) re-creates them with
# that file's owner before docker restarts any container. That drop-in orders docker After= and
# Wants= rmd-scratch.service, never RequiresMountsFor=/mnt/scratch: a script mounts that disk, not a
# mount unit, so at boot the directive would order docker after nothing. RMD_SCRATCH_STATE_DIRS names
# the other instances' state dirs for it; RMD_SCRATCH_LIB_PATH (default /usr/local/bin/
# rmd-scratch-mounts, written only on a real host) is where it installs this file.
#
# USAGE
#   . deploy/scratch-mounts.sh; scratch_plan <state-dir> <container>; scratch_prepare; scratch_fresh_tmp
#   deploy/scratch-mounts.sh --restore <state-dir>...      # as root, at docker start
#
# TEST SEAMS (production defaults shown)
#   RMD_SCRATCH_ROOT         /mnt/scratch
#   RMD_SCRATCH_SWITCH       /etc/remudero/scratch-mounts.on
#   RMD_SCRATCH_MOUNTS_FILE  /proc/mounts   (the root must be its own mount, not a bare directory)

SCRATCH_STATE_DEST="/home/node/Remudero"
SCRATCH_READ_MODEL_DEST="/home/node/rmd-scratch/read-model"
SCRATCH_MANIFEST_NAME=".scratch-mounts"

scratch_root() { printf '%s' "${RMD_SCRATCH_ROOT:-/mnt/scratch}"; }

# True when the scratch root is itself a mounted filesystem: a bare directory at that path sits on
# the 29 GB OS disk, and worktrees there would fill it.
scratch_root_is_mounted() {
  local root mounts mnt
  root="$(scratch_root)"
  mounts="${RMD_SCRATCH_MOUNTS_FILE:-/proc/mounts}"
  [ -r "${mounts}" ] || return 1
  while IFS=' ' read -r _ mnt _; do
    [ "${mnt}" = "${root}" ] && return 0
  done < "${mounts}"
  return 1
}

scratch_enabled() {
  case "${RMD_SCRATCH:-auto}" in
    on) return 0 ;;
    off) return 1 ;;
    *) [ -e "${RMD_SCRATCH_SWITCH:-/etc/remudero/scratch-mounts.on}" ] ;;
  esac
}

# Sets SCRATCH_ARGS (docker run arguments), SCRATCH_BINDS (host<TAB>container per line),
# SCRATCH_DIRS (host dirs to create), SCRATCH_CONTAINER_TMP and SCRATCH_NOTE. Returns 1, with
# SCRATCH_ARGS empty, when the binds are off or cannot be used. Changes nothing on disk.
scratch_plan() {
  local state_dir="$1" container="$2" key base
  SCRATCH_ARGS=()
  SCRATCH_BINDS=""
  SCRATCH_DIRS=()
  SCRATCH_CONTAINER_TMP=""
  SCRATCH_STATE_DIR="${state_dir}"
  if ! scratch_enabled; then
    SCRATCH_NOTE="off (RMD_SCRATCH=${RMD_SCRATCH:-auto}, no ${RMD_SCRATCH_SWITCH:-/etc/remudero/scratch-mounts.on}): worktrees, tmp, coverage and the read model stay on the state disk"
    return 1
  fi
  if ! scratch_root_is_mounted; then
    SCRATCH_NOTE="NOT USED — $(scratch_root) is not a mounted filesystem; launching with everything on the state disk"
    return 1
  fi
  key="$(basename "${state_dir}" | tr -c 'A-Za-z0-9_.\n-' '_')"
  case "${key}" in ""|.|..) SCRATCH_NOTE="NOT USED — state dir ${state_dir} has no usable name"; return 1 ;; esac
  case "${container}" in ""|*[!A-Za-z0-9_.-]*) SCRATCH_NOTE="NOT USED — container name '${container}' is not Docker-safe"; return 1 ;; esac
  base="$(scratch_root)/rmd/${key}"
  SCRATCH_CONTAINER_TMP="${base}/containers/${container}/tmp"
  SCRATCH_BINDS="${base}/worktrees	${SCRATCH_STATE_DEST}/worktrees
${base}/tmp	${SCRATCH_STATE_DEST}/tmp
${base}/remudero-coverage	${SCRATCH_STATE_DEST}/.remudero-coverage
${base}/read-model	${SCRATCH_READ_MODEL_DEST}
${SCRATCH_CONTAINER_TMP}	/tmp"
  local src dest
  while IFS='	' read -r src dest; do
    SCRATCH_DIRS+=("${src}")
    SCRATCH_ARGS+=(-v "${src}:${dest}")
  done <<EOF
${SCRATCH_BINDS}
EOF
  SCRATCH_ARGS+=(-e "RMD_READ_MODEL_DB_DIR=${SCRATCH_STATE_DEST}/state:${SCRATCH_READ_MODEL_DEST}")
  SCRATCH_NOTE="on — worktrees, tmp, coverage, the read model and /tmp under ${base}"
  return 0
}

# Creates the planned directories and records them in <state-dir>/.scratch-mounts (the boot-time
# restore's list). On any failure the plan is dropped, so the caller launches without the binds.
scratch_prepare() {
  [ "${#SCRATCH_ARGS[@]}" -gt 0 ] || return 1
  local dir manifest tmp
  for dir in "${SCRATCH_DIRS[@]}"; do
    if ! mkdir -p "${dir}" 2>/dev/null || [ ! -w "${dir}" ]; then
      SCRATCH_NOTE="NOT USED — could not create a writable ${dir}; launching with everything on the state disk"
      SCRATCH_ARGS=()
      return 1
    fi
  done
  manifest="${SCRATCH_STATE_DIR}/${SCRATCH_MANIFEST_NAME}"
  tmp="${manifest}.tmp.$$"
  if { [ -r "${manifest}" ] && cat "${manifest}"; printf '%s\n' "${SCRATCH_DIRS[@]}"; } | sort -u > "${tmp}" 2>/dev/null; then
    mv -f "${tmp}" "${manifest}"
  else
    rm -f "${tmp}"
    SCRATCH_NOTE="${SCRATCH_NOTE}; WARNING: ${manifest} not written, so a deallocate needs this launch re-run"
  fi
  return 0
}

# A new container has always started with an empty /tmp; the scratch-backed one keeps that.
# Call it only after the old container is removed: it empties the directory that container used.
scratch_fresh_tmp() {
  [ "${#SCRATCH_ARGS[@]}" -gt 0 ] && [ -n "${SCRATCH_CONTAINER_TMP}" ] || return 0
  case "${SCRATCH_CONTAINER_TMP}" in
    "$(scratch_root)/rmd/"*/containers/*/tmp) ;;
    *) return 0 ;;
  esac
  # Never fatal: a launch must not die after the old container is gone; scratch_prepare made it.
  rm -rf "${SCRATCH_CONTAINER_TMP}" 2>/dev/null || true
  mkdir -p "${SCRATCH_CONTAINER_TMP}" 2>/dev/null || true
  return 0
}

# Root, at docker start: re-create every directory a launch recorded, owned by whoever owns that
# launch's record. Only under the scratch root, and only when it is mounted. Never fails docker.
scratch_restore() {
  local state_dir manifest owner dir path
  if ! scratch_root_is_mounted; then
    echo "scratch-mounts: $(scratch_root) is not mounted; nothing restored"
    return 0
  fi
  for state_dir in "$@"; do
    manifest="${state_dir}/${SCRATCH_MANIFEST_NAME}"
    [ -r "${manifest}" ] || { echo "scratch-mounts: no ${manifest}; nothing to restore for it"; continue; }
    owner="$(stat -c '%u:%g' "${manifest}" 2>/dev/null || stat -f '%u:%g' "${manifest}")"
    while IFS= read -r dir; do
      case "${dir}" in "$(scratch_root)/rmd/"*) ;; *) continue ;; esac
      case "${dir}" in *..*) continue ;; esac
      mkdir -p "${dir}" || continue
      path="${dir}"
      while [ "${path}" != "$(scratch_root)" ] && [ "${path}" != "/" ]; do
        chown "${owner}" "${path}" 2>/dev/null || true
        path="$(dirname "${path}")"
      done
      echo "scratch-mounts: restored ${dir}"
    done < "${manifest}"
  done
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  case "${1:-}" in
    --restore) shift; scratch_restore "$@" ;;
    *) echo "usage: $0 --restore <state-dir>..." >&2; exit 2 ;;
  esac
fi
