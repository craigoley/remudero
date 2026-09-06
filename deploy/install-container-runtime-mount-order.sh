#!/usr/bin/env bash
# install-container-runtime-mount-order — makes containerd.service and docker.service wait for
# their own runtime-data mounts; docker.service also waits for the Remudero state bind mount
# (RMD_STATE_DIR, which has no default and is refused if unset, relative, absent, or unmounted).
# Check mode (default) reports gaps and changes nothing; --install renders two repository-owned
# systemd drop-ins and reloads once.
#
# INVARIANT: each service's EFFECTIVE `RequiresMountsFor` (via `systemctl show`, never the
# drop-in file on disk) lists its own runtime root; docker's also lists RMD_STATE_DIR. systemd
# unions RequiresMountsFor= across every drop-in for a unit, so this script only writes its own
# two files and never edits, merges with, or removes another drop-in.
#
# TRAP: per systemd.mount(5), a `nofail` mount is only WANTED, never ordered before the
# local-filesystem target — a bind mount existing does not make a service wait for it.
# Why: closes the third path of the 2026-09-05 Azure reboot defect (W1-T2856, PR #4021); full
# incident in docs/forensics/install-container-runtime-mount-order.md.
# FALSIFIER: test/container-runtime-mount-order-install.test.ts.
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

# ── the mount BACKING /var/lib/containerd (the fstab shape docs/operator-guide.md documents),
# not the bind target itself — the bind source's own enclosing mount is what must be up first.
# Falls back to the mount enclosing CONTAINERD_ROOT directly when it is not itself a bind mount. ─
resolve_data_mount() {
  local bind_source
  bind_source="$(bind_source_for "${CONTAINERD_ROOT}")"
  case "${bind_source}" in
    /*) DATA_MOUNT="$(enclosing_mount_point "$(dirname "${bind_source}")")" ;;
    *) DATA_MOUNT="$(enclosing_mount_point "${CONTAINERD_ROOT}")" ;;
  esac
}

# ── W1-T2856 criterion 5: refuses an unset, relative, absent, or unmounted RMD_STATE_DIR before
# the host changes, in both modes — check mode cannot name a mount it was never given. ──────────
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

# ── W1-T2856 criteria 1-3, 7: compares the EFFECTIVE dependency set, never the file on disk, so
# a stale or partial drop-in is caught, and names the service and every missing path (criterion 2). ─
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
