#!/usr/bin/env bash
# install-container-runtime-mount-order — close the third path of the Azure reboot-survivability
# defect (W1-T2856): make BOTH containerd.service and docker.service wait for the Remudero state
# bind mount, not only for their own data roots.
#
# THE INCIDENT THIS CLOSES. On the 2026-09-05 Azure reboot, `docker.service` started before
# `/mnt/rmd` and its bind mounts were available; Docker loaded an empty root and no Remudero
# container was there to restart. A same-day emergency host edit installed matching
# `containerd.service.d`/`docker.service.d` drop-ins with `RequiresMountsFor=/mnt/rmd
# /var/lib/containerd`, and a later reboot proved that runtime-root ordering worked: both mounts
# and containerd started before Docker. The LIVE STATE bind mount (named by RMD_STATE_DIR) was
# never added to either service's dependency set. Per systemd.mount(5) (v255), a `nofail` mount is
# only WANTED, never ordered before the local-filesystem target — so an auto-restarted container
# can still resolve `-v "$RMD_STATE_DIR":...` against the un-mounted OS-disk directory before the
# real bind mount lands. Those emergency files are also untracked machine state: a rebuilt VM or
# another fleet host starts without them.
#
# THE FIX IS ONE MORE `RequiresMountsFor=` ROW PER SERVICE, IN THIS REPOSITORY'S OWN DROP-INS.
# systemd.unit(5) (v255) says `RequiresMountsFor=` adds both `Requires=` and `After=` for every
# listed path, and a unit's dependencies are the UNION of every drop-in that sets it — so this
# script never touches, reads for merging, or removes either emergency (or any other
# administrator) drop-in file. It writes its own two files, under its own name, and lets systemd
# union them with whatever else is already there.
#
# THE TWO SERVICES NEED DIFFERENT ROWS.
#   containerd.service requires the DATA MOUNT BACKING `/var/lib/containerd` plus
#     `/var/lib/containerd` itself. The data mount is RESOLVED, not hardcoded: this script reads
#     the live mount table (default /proc/mounts, override RMD_PROC_MOUNTS_FILE) for the bind
#     source behind `/var/lib/containerd` (matching the documented fstab layout, "Attaching a data
#     disk to the container host" in docs/operator-guide.md), then finds the real filesystem mount
#     enclosing that source. containerd carries no Remudero state requirement — it never opens the
#     state bind mount.
#   docker.service requires the resolved Docker data root (`docker info --format
#     '{{.DockerRootDir}}'`, same call as deploy/host-update.sh), `/var/lib/containerd`, AND the
#     explicit Remudero state directory.
#
# TWO EXPLICIT MODES, NEITHER OF WHICH TOUCHES DOCKER, CONTAINERD, OR A CONTAINER.
#   (check, default) Compare EACH service's EFFECTIVE `RequiresMountsFor` (via `systemctl show`)
#     against its own required paths. Writes nothing, reloads nothing, requires no privilege.
#     Names the service AND every missing path for that service.
#   (--install) Requires root. Validates RMD_STATE_DIR, renders BOTH drop-ins, writes each
#     atomically (mktemp + same-directory rename), runs `systemctl daemon-reload` exactly ONCE,
#     then re-runs the SAME two checks to prove both writes took effect. It never runs `systemctl
#     start/stop/restart/reload docker.service` or `containerd.service`, and never runs a `docker`
#     subcommand beyond the read-only `docker info` used to resolve the Docker root, or any
#     containerd client command (`ctr`/`nerdctl`) at all. Lifecycle timing (when either runtime
#     restarts, when a reboot is taken) remains the operator's decision — see
#     docs/operator-guide.md.
#
# RMD_STATE_DIR HAS NO DEFAULT, DELIBERATELY. deploy/host-update.sh and deploy/recycle-container.sh
# fall back to `${HOME:-/root}/rmd-state` because a missing container mount there merely warns.
# Here a wrong path is silently WRONG for the rest of this host's life — reviving that default
# would let an unset variable render a drop-in that "protects" a path nothing ever writes to. So
# RMD_STATE_DIR must be set, absolute, must already exist, and must already be its own mount point
# before ANYTHING is written — an unset, relative, absent or unmounted value is refused first, in
# both modes, before the host is touched.
#
# USAGE
#   ./deploy/install-container-runtime-mount-order.sh                 # check mode; exit 0/1
#   RMD_STATE_DIR=/mnt/rmd/state2 ./deploy/install-container-runtime-mount-order.sh --install
#
# TEST SEAMS (production defaults shown; a real host never sets these)
#   RMD_DOCKER_DROPIN_DIR     default /etc/systemd/system/docker.service.d
#   RMD_CONTAINERD_DROPIN_DIR default /etc/systemd/system/containerd.service.d
#   RMD_CONTAINERD_ROOT       default /var/lib/containerd
#   RMD_PROC_MOUNTS_FILE      default /proc/mounts

set -euo pipefail

DROPIN_FILENAME="20-remudero-mount-order.conf"
DOCKER_DROPIN_DIR="${RMD_DOCKER_DROPIN_DIR:-/etc/systemd/system/docker.service.d}"
CONTAINERD_DROPIN_DIR="${RMD_CONTAINERD_DROPIN_DIR:-/etc/systemd/system/containerd.service.d}"
CONTAINERD_ROOT="${RMD_CONTAINERD_ROOT:-/var/lib/containerd}"
MOUNTS_FILE="${RMD_PROC_MOUNTS_FILE:-/proc/mounts}"

MODE="check"
case "${1:-}" in
  "") ;;
  --install) MODE="install" ;;
  --check) MODE="check" ;;
  *)
    echo "install-container-runtime-mount-order: unrecognised argument '${1}' (expected --install or --check)" >&2
    exit 1
    ;;
esac

# ── is a path its OWN mount point, not merely a directory that exists ───────────────────────────
is_mount_point() {
  local path="$1"
  [ -r "${MOUNTS_FILE}" ] || return 1
  local mnt
  while IFS=' ' read -r _ mnt _; do
    [ "${mnt}" = "${path}" ] && return 0
  done < "${MOUNTS_FILE}"
  return 1
}

# ── the real filesystem mount most specifically enclosing an absolute path ──────────────────────
enclosing_mount_point() {
  local path="$1" best="" mnt
  [ -r "${MOUNTS_FILE}" ] || { printf '%s' "${path}"; return 0; }
  while IFS=' ' read -r _ mnt _; do
    case "${path}" in
      "${mnt}"|"${mnt}"/*)
        [ "${#mnt}" -gt "${#best}" ] && best="${mnt}"
        ;;
    esac
  done < "${MOUNTS_FILE}"
  [ -n "${best}" ] || best="${path}"
  printf '%s' "${best}"
}

# ── the literal source path of the mount line whose TARGET is exactly $1 (empty if none) ────────
bind_source_for() {
  local target="$1" src mnt
  [ -r "${MOUNTS_FILE}" ] || return 0
  while IFS=' ' read -r src mnt _; do
    if [ "${mnt}" = "${target}" ]; then
      printf '%s' "${src}"
      return 0
    fi
  done < "${MOUNTS_FILE}"
  return 0
}

# ── the data-disk mount BACKING /var/lib/containerd — the fstab shape docs/operator-guide.md
# documents is `/mnt/rmd/containerd /var/lib/containerd none bind,nofail 0 0`, so the mount that
# must be up before Docker or containerd can trust that path is the one enclosing the BIND
# SOURCE, not the bind target itself. Falls back to the mount enclosing CONTAINERD_ROOT directly
# when it is not itself a bind mount (e.g. a single-disk host). ─────────────────────────────────
resolve_data_mount() {
  local bind_source
  bind_source="$(bind_source_for "${CONTAINERD_ROOT}")"
  case "${bind_source}" in
    /*) DATA_MOUNT="$(enclosing_mount_point "$(dirname "${bind_source}")")" ;;
    *) DATA_MOUNT="$(enclosing_mount_point "${CONTAINERD_ROOT}")" ;;
  esac
}

# ── W1-T2856 criterion 5: unset, relative, absent or unmounted RMD_STATE_DIR is refused before
# the host is changed. Runs in BOTH modes: check mode cannot name a missing mount it was never
# given, and install mode must never reach either write with a value this wrong. ────────────────
validate_state_dir() {
  if [ -z "${RMD_STATE_DIR:-}" ]; then
    echo "install-container-runtime-mount-order: REFUSING — RMD_STATE_DIR is not set." >&2
    echo "  Set it to the absolute, already-mounted Remudero state directory and re-run." >&2
    exit 1
  fi
  case "${RMD_STATE_DIR}" in
    /*) ;;
    *)
      echo "install-container-runtime-mount-order: REFUSING — RMD_STATE_DIR must be an absolute path, got '${RMD_STATE_DIR}'." >&2
      exit 1
      ;;
  esac
  if [ ! -d "${RMD_STATE_DIR}" ]; then
    echo "install-container-runtime-mount-order: REFUSING — RMD_STATE_DIR does not exist: ${RMD_STATE_DIR}" >&2
    exit 1
  fi
  if ! is_mount_point "${RMD_STATE_DIR}"; then
    echo "install-container-runtime-mount-order: REFUSING — RMD_STATE_DIR is not itself a mount point" >&2
    echo "  (the bind mount is not active yet): ${RMD_STATE_DIR}" >&2
    echo "  Mount it first; a directory that merely exists on the OS disk is exactly the failure" >&2
    echo "  class this installer exists to prevent." >&2
    exit 1
  fi
}

# ── the resolved Docker data root — same call, same fallback, as deploy/host-update.sh ─────────
resolve_docker_root() {
  local err_file
  err_file="$(mktemp "${TMPDIR:-/tmp}/rmd-install-container-runtime-mount-order-docker-err.XXXXXX")"
  if ! DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>"${err_file}")"; then
    echo "install-container-runtime-mount-order: docker is not answering; cannot resolve the Docker data root." >&2
    sed 's/^/  /' "${err_file}" >&2 || true
    rm -f "${err_file}"
    exit 1
  fi
  rm -f "${err_file}"
  [ -n "${DOCKER_ROOT}" ] || DOCKER_ROOT=/var/lib/docker
}

require_root() {
  local uid
  uid="$(id -u)"
  if [ "${uid}" != "0" ]; then
    echo "install-container-runtime-mount-order: --install requires root (running as uid ${uid})." >&2
    exit 1
  fi
}

render_containerd_dropin() {
  cat <<EOF
# Managed by deploy/install-container-runtime-mount-order.sh (W1-T2856) — DO NOT HAND-EDIT.
# Regenerate with: deploy/install-container-runtime-mount-order.sh --install
#
# This repository-owned drop-in requires ONLY the data-disk mount backing /var/lib/containerd and
# /var/lib/containerd itself. It intentionally does not replace, merge with or remove any other
# containerd.service.d drop-in: systemd unions RequiresMountsFor= across every drop-in for a unit.
[Unit]
RequiresMountsFor=${DATA_MOUNT} ${CONTAINERD_ROOT}
EOF
}

render_docker_dropin() {
  cat <<EOF
# Managed by deploy/install-container-runtime-mount-order.sh (W1-T2856) — DO NOT HAND-EDIT.
# Regenerate with: RMD_STATE_DIR=${RMD_STATE_DIR} deploy/install-container-runtime-mount-order.sh --install
#
# This repository-owned drop-in requires ONLY the Docker data root, the containerd root and the
# explicit Remudero state bind mount. It intentionally does not replace, merge with or remove any
# other docker.service.d drop-in (e.g. an emergency or administrator file): systemd unions
# RequiresMountsFor= across every drop-in for a unit, so this row and any other row both apply.
[Unit]
RequiresMountsFor=${DOCKER_ROOT} ${CONTAINERD_ROOT} ${RMD_STATE_DIR}
EOF
}

# ── write $2's stdout to $1 atomically: render into a same-directory temp file, then rename ─────
atomic_write() {
  local target="$1" renderer="$2" dir tmp
  dir="$(dirname "${target}")"
  mkdir -p "${dir}"
  tmp="$(mktemp "${dir}/.$(basename "${target}").XXXXXX")"
  "${renderer}" > "${tmp}"
  chmod 0644 "${tmp}"
  mv -f "${tmp}" "${target}"
}

# ── W1-T2856 criteria 1-3, 7: compare the EFFECTIVE dependency set for ONE service, never the
# file on disk, so a stale or partial drop-in is caught by what systemd actually resolved. Names
# the SERVICE alongside every missing path (criterion 2). ───────────────────────────────────────
check_service() {
  local service="$1"
  shift
  local required=("$@")
  local raw
  raw="$(systemctl show "${service}" --property=RequiresMountsFor 2>/dev/null || true)"
  raw="${raw#RequiresMountsFor=}"
  local missing=()
  local path
  for path in "${required[@]}"; do
    case " ${raw} " in
      *" ${path} "*) ;;
      *) missing+=("${path}") ;;
    esac
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "install-container-runtime-mount-order: MISSING from ${service}'s effective RequiresMountsFor:" >&2
    for path in "${missing[@]}"; do
      echo "  - ${service}: ${path}" >&2
    done
    echo "  ${service} effective value: ${raw:-<empty>}" >&2
    return 1
  fi
  echo "install-container-runtime-mount-order: ${service} effective RequiresMountsFor covers all required paths: ${raw}"
  return 0
}

check_all() {
  local status=0
  check_service containerd.service "${DATA_MOUNT}" "${CONTAINERD_ROOT}" || status=1
  check_service docker.service "${DOCKER_ROOT}" "${CONTAINERD_ROOT}" "${RMD_STATE_DIR}" || status=1
  return "${status}"
}

validate_state_dir
resolve_docker_root
resolve_data_mount

if [ "${MODE}" = "install" ]; then
  require_root
  atomic_write "${CONTAINERD_DROPIN_DIR}/${DROPIN_FILENAME}" render_containerd_dropin
  atomic_write "${DOCKER_DROPIN_DIR}/${DROPIN_FILENAME}" render_docker_dropin
  echo "install-container-runtime-mount-order: wrote ${CONTAINERD_DROPIN_DIR}/${DROPIN_FILENAME} and ${DOCKER_DROPIN_DIR}/${DROPIN_FILENAME}"
  systemctl daemon-reload
  echo "install-container-runtime-mount-order: ran systemctl daemon-reload"
  check_all
  exit $?
fi

check_all
exit $?
