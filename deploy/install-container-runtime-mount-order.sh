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
# TRAP: a `nofail` mount is only WANTED, never ordered before local-fs.target (systemd.mount(5)).
# Why: the 2026-09-05 Azure reboot (W1-T2856, PR #4021) and the 2026-10-08 move of both runtime
# roots to /mnt/scratch; both in docs/forensics/install-container-runtime-mount-order.md.
# FALSIFIER: test/container-runtime-mount-order-install.test.ts.
# USAGE
#   ./deploy/install-container-runtime-mount-order.sh                 # check mode; exit 0/1
#   RMD_STATE_DIR=/mnt/rmd/state2 ./deploy/install-container-runtime-mount-order.sh --install
#   RMD_RUNTIME_ON_SCRATCH=1 … [--install]: runtime roots on /mnt/scratch; --uninstall-scratch-runtime
#
# TEST SEAMS, each defaulting to the real host path assigned below (a real host sets none):
#   RMD_{DOCKER,CONTAINERD}_DROPIN_DIR RMD_CONTAINERD_ROOT RMD_PROC_MOUNTS{,INFO}_FILE RMD_SYSTEMD_UNIT_DIR
#   RMD_FSTAB_FILE RMD_DOCKER_DAEMON_JSON RMD_SCRATCH_ROOT

set -euo pipefail

DROPIN_FILENAME="20-remudero-mount-order.conf"
DOCKER_DROPIN_DIR="${RMD_DOCKER_DROPIN_DIR:-/etc/systemd/system/docker.service.d}"
CONTAINERD_DROPIN_DIR="${RMD_CONTAINERD_DROPIN_DIR:-/etc/systemd/system/containerd.service.d}"
CONTAINERD_ROOT="${RMD_CONTAINERD_ROOT:-/var/lib/containerd}"
MOUNTS_FILE="${RMD_PROC_MOUNTS_FILE:-/proc/mounts}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
SCRATCH_LIB_PATH="${RMD_SCRATCH_LIB_PATH:-/usr/local/bin/rmd-scratch-mounts}"
MOUNTINFO_FILE="${RMD_PROC_MOUNTINFO_FILE:-/proc/self/mountinfo}"
UNIT_DIR="${RMD_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
FSTAB_FILE="${RMD_FSTAB_FILE:-/etc/fstab}"
DAEMON_JSON="${RMD_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"
SCRATCH_ROOT="${RMD_SCRATCH_ROOT:-/mnt/scratch}"
SCRATCH_CONTAINERD="${SCRATCH_ROOT}/containerd"
SCRATCH_DOCKER="${SCRATCH_ROOT}/docker"
GUARD_FILENAME="15-remudero-scratch-runtime.conf"
SCRATCH_DIRS_DROPIN="${UNIT_DIR}/rmd-scratch.service.d/20-remudero-runtime-dirs.conf"
MOUNT_UNIT_PATH="${CONTAINERD_ROOT#/}"
MOUNT_UNIT="${MOUNT_UNIT_PATH//\//-}.mount"
ON_SCRATCH=0
SCRATCH_FLAG=""
[ "${RMD_RUNTIME_ON_SCRATCH:-0}" = "1" ] && { ON_SCRATCH=1; SCRATCH_FLAG="RMD_RUNTIME_ON_SCRATCH=1 "; }

MODE="check"
case "${1:-}" in
  "") ;;
  --install) MODE="install" ;;
  --check) MODE="check" ;;
  --uninstall-scratch-runtime) MODE="uninstall" ;;
  *)
    echo "install-container-runtime-mount-order: unrecognised argument '${1}' (expected --install, --check or --uninstall-scratch-runtime)" >&2
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

# ── the mount BACKING /var/lib/containerd's bind source, else the one enclosing the root itself ─
resolve_data_mount() {
  local backing_mount=""
  # /proc/mounts names the device for a bind; mountinfo retains its filesystem root (W1-T6494).
  if [ -r "${MOUNTINFO_FILE}" ]; then
    backing_mount="$(awk -v target="${CONTAINERD_ROOT}" '
      { dev[NR] = $3; root[NR] = $4; mount[NR] = $5 }
      $5 == target { target_dev = $3; target_root = $4 }
      END {
        if (target_dev == "") exit
        for (i = 1; i <= NR; i++) {
          if (dev[i] != target_dev || mount[i] == target) continue
          if (root[i] != "/" && target_root != root[i] && index(target_root, root[i] "/") != 1) continue
          if (length(root[i]) > best_root ||
              (length(root[i]) == best_root && length(mount[i]) < length(best))) {
            best = mount[i]; best_root = length(root[i])
          }
        }
        printf "%s", best
      }
    ' "${MOUNTINFO_FILE}")"
  fi
  DATA_MOUNT="${backing_mount:-$(enclosing_mount_point "${CONTAINERD_ROOT}")}"
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
# Regenerate with: ${SCRATCH_FLAG}deploy/install-container-runtime-mount-order.sh --install
#
# This repository-owned drop-in requires ONLY the data-disk mount backing /var/lib/containerd and
# /var/lib/containerd itself. It intentionally does not replace, merge with or remove any other
# containerd.service.d drop-in: systemd unions RequiresMountsFor= across every drop-in for a unit.
[Unit]
RequiresMountsFor=${DATA_MOUNT:+${DATA_MOUNT} }${CONTAINERD_ROOT}
EOF
}

render_docker_dropin() {
  cat <<EOF
# Managed by deploy/install-container-runtime-mount-order.sh (W1-T2856) — DO NOT HAND-EDIT.
# Regenerate with: ${SCRATCH_FLAG}RMD_STATE_DIR=${RMD_STATE_DIR} deploy/install-container-runtime-mount-order.sh --install
#
# This repository-owned drop-in requires ONLY the Docker data root, the containerd root and the
# explicit Remudero state bind mount. It intentionally does not replace, merge with or remove any
# other docker.service.d drop-in (e.g. an emergency or administrator file): systemd unions
# RequiresMountsFor= across every drop-in for a unit, so this row and any other row both apply.
[Unit]
RequiresMountsFor=${DOCKER_ROOT} ${CONTAINERD_ROOT} ${RMD_STATE_DIR}
After=rmd-scratch.service
Wants=rmd-scratch.service

[Service]
ExecStartPre=-/bin/bash ${SCRATCH_LIB_PATH} --restore ${RMD_STATE_DIR}${RMD_SCRATCH_STATE_DIRS:+ ${RMD_SCRATCH_STATE_DIRS}}
EOF
}

render_scratch_lib() { cat "${SCRIPT_DIR}/scratch-mounts.sh"; }

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
  check_service containerd.service ${DATA_MOUNT:+"${DATA_MOUNT}"} "${CONTAINERD_ROOT}" || status=1
  check_service docker.service "${DOCKER_ROOT}" "${CONTAINERD_ROOT}" "${RMD_STATE_DIR}" || status=1
  return "${status}"
}

# ── RMD_RUNTIME_ON_SCRATCH=1: both runtime roots on /mnt/scratch, neither starts without it ────
say() { echo "install-container-runtime-mount-order: $*"; }
fail() { echo "install-container-runtime-mount-order: $*" >&2; return 1; }
unit_prop() {
  local raw
  raw="$(systemctl show "$1" --property="$2" 2>/dev/null || true)"
  printf '%s' "${raw#"$2"=}"
}
fstab_binds_containerd_root() {
  [ -r "${FSTAB_FILE}" ] || return 1
  awk -v t="${CONTAINERD_ROOT}" '$1 !~ /^#/ && ($2 == t || $2 == t "/") { print; found = 1 } END { exit !found }' "${FSTAB_FILE}"
}
daemon_json_data_root() {
  [ -r "${DAEMON_JSON}" ] || return 0
  tr -d '\n' < "${DAEMON_JSON}" | sed -n 's/.*"data-root"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}
guard_line() {
  local paths="$1" what="$2" test="" p
  for p in ${paths}; do test="${test:+${test} && }mountpoint -q ${p}"; done
  printf "ExecStartPre=/bin/sh -c '%s || { echo \"rmd: not all of [%s] is mounted; refusing to start %s on the OS disk\" >&2; exit 1; }'\n" "${test}" "${paths}" "${what}"
}

render_mount_unit() {
  cat <<EOF
# Managed by deploy/install-container-runtime-mount-order.sh (RMD_RUNTIME_ON_SCRATCH=1) — DO NOT HAND-EDIT.
[Unit]
Description=containerd root on the local scratch disk (bind from ${SCRATCH_CONTAINERD})
DefaultDependencies=no
Requires=rmd-scratch.service
After=rmd-scratch.service
AssertPathIsMountPoint=${SCRATCH_ROOT}
Conflicts=umount.target
Before=umount.target

[Mount]
What=${SCRATCH_CONTAINERD}
Where=${CONTAINERD_ROOT}
Type=none
Options=bind
EOF
}
render_containerd_guard() { printf '[Service]\n'; guard_line "${SCRATCH_ROOT} ${CONTAINERD_ROOT}" containerd; }
render_docker_guard() { printf '[Service]\n'; guard_line "${SCRATCH_ROOT}" docker; }
render_scratch_dirs_dropin() {
  printf '[Service]\nExecStartPost=/bin/sh -c '\''if mountpoint -q %s; then install -d -m 0711 %s; fi'\''\n' "${SCRATCH_ROOT}" "${SCRATCH_CONTAINERD}"
}

# ── refused BEFORE any write: an fstab bind runs before rmd-scratch mounts the disk (the trap) ─
scratch_preconditions() {
  local ok=0 line root
  if line="$(fstab_binds_containerd_root)"; then
    fail "REFUSING — ${FSTAB_FILE} still mounts ${CONTAINERD_ROOT}; comment out this line first:" || true
    echo "  ${line}" >&2
    ok=1
  fi
  root="$(daemon_json_data_root)"
  if [ "${root}" != "${SCRATCH_DOCKER}" ]; then
    fail "REFUSING — ${DAEMON_JSON} data-root is '${root:-<unset>}'; set it to \"data-root\": \"${SCRATCH_DOCKER}\" (keep a backup)." || true
    ok=1
  fi
  is_mount_point "${SCRATCH_ROOT}" || { fail "REFUSING — ${SCRATCH_ROOT} is not a mount point; start rmd-scratch.service first." || true; ok=1; }
  [ -d "${SCRATCH_CONTAINERD}" ] || { fail "REFUSING — ${SCRATCH_CONTAINERD} does not exist; rsync /mnt/rmd/containerd there first." || true; ok=1; }
  [ "$(unit_prop rmd-scratch.service Type)" = "oneshot" ] || { fail "REFUSING — rmd-scratch.service is not Type=oneshot, so After= cannot wait for its mount." || true; ok=1; }
  return "${ok}"
}

# ── what systemd RESOLVED, never the files on disk; check mode adds the live mount and Docker. ─
check_scratch_static() {
  local status=0 svc
  scratch_preconditions || status=1
  [ "$(unit_prop "${MOUNT_UNIT}" What)" = "${SCRATCH_CONTAINERD}" ] || { fail "MISSING — ${MOUNT_UNIT} What= is not ${SCRATCH_CONTAINERD}" || true; status=1; }
  [ "$(unit_prop "${MOUNT_UNIT}" FragmentPath)" = "${UNIT_DIR}/${MOUNT_UNIT}" ] || { fail "MISSING — ${MOUNT_UNIT} is not loaded from ${UNIT_DIR}/${MOUNT_UNIT}" || true; status=1; }
  for svc in containerd.service docker.service; do
    if [[ "$(unit_prop "${svc}" ExecStartPre)" == *"mountpoint -q ${SCRATCH_ROOT}"* ]]; then
      say "${svc} refuses to start without ${SCRATCH_ROOT} mounted"
    else
      fail "MISSING — ${svc} has no ExecStartPre guard on ${SCRATCH_ROOT}" || true; status=1
    fi
  done
  [[ "$(unit_prop rmd-scratch.service ExecStartPost)" == *"${SCRATCH_CONTAINERD}"* ]] ||
    { fail "MISSING — rmd-scratch.service does not re-create ${SCRATCH_CONTAINERD}" || true; status=1; }
  return "${status}"
}
check_scratch_live() {
  local status=0 sdev sroot cdev croot
  [ "$(unit_prop "${MOUNT_UNIT}" ActiveState)" = "active" ] || { fail "NOT LIVE — ${MOUNT_UNIT} is not active" || true; status=1; }
  read -r sdev sroot <<<"$(awk -v m="${SCRATCH_ROOT}" '$5 == m { d = $3; r = $4 } END { print d, r }' "${MOUNTINFO_FILE}" 2>/dev/null)"
  read -r cdev croot <<<"$(awk -v m="${CONTAINERD_ROOT}" '$5 == m { d = $3; r = $4 } END { print d, r }' "${MOUNTINFO_FILE}" 2>/dev/null)"
  if [ -z "${sdev}" ] || [ "${cdev}" != "${sdev}" ] || [ "${croot}" != "${sroot%/}/containerd" ]; then
    fail "NOT LIVE — ${CONTAINERD_ROOT} is '${cdev:-unmounted} ${croot}', not ${SCRATCH_CONTAINERD} on ${SCRATCH_ROOT}'s device '${sdev:-unmounted}'" || true
    status=1
  fi
  resolve_docker_root
  [ "${DOCKER_ROOT}" = "${SCRATCH_DOCKER}" ] || { fail "NOT LIVE — DockerRootDir is ${DOCKER_ROOT}, not ${SCRATCH_DOCKER}" || true; status=1; }
  [ "${status}" -ne 0 ] || say "containerd and docker run from ${SCRATCH_ROOT}"
  return "${status}"
}

if [ "${MODE}" = "uninstall" ]; then
  require_root
  [ "$(unit_prop "${MOUNT_UNIT}" ActiveState)" != "active" ] || { fail "REFUSING — ${MOUNT_UNIT} is active; stop docker, containerd and ${MOUNT_UNIT} first."; exit 1; }
  rm -f "${UNIT_DIR}/${MOUNT_UNIT}" "${CONTAINERD_DROPIN_DIR}/${GUARD_FILENAME}" "${DOCKER_DROPIN_DIR}/${GUARD_FILENAME}" "${SCRATCH_DIRS_DROPIN}"
  systemctl daemon-reload
  say "removed ${MOUNT_UNIT}, both ${GUARD_FILENAME} guards and ${SCRATCH_DIRS_DROPIN}; ran systemctl daemon-reload"
  say "next: restore ${FSTAB_FILE} and ${DAEMON_JSON}, start containerd and docker, then re-run --install without RMD_RUNTIME_ON_SCRATCH"
  exit 0
fi

validate_state_dir
if [ "${ON_SCRATCH}" = "1" ]; then
  DOCKER_ROOT="${SCRATCH_DOCKER}"
  DATA_MOUNT=""
else
  resolve_docker_root
  resolve_data_mount
fi

if [ "${MODE}" = "install" ]; then
  require_root
  if [ "${ON_SCRATCH}" = "1" ]; then
    scratch_preconditions || exit 1
    atomic_write "${UNIT_DIR}/${MOUNT_UNIT}" render_mount_unit
    atomic_write "${CONTAINERD_DROPIN_DIR}/${GUARD_FILENAME}" render_containerd_guard
    atomic_write "${DOCKER_DROPIN_DIR}/${GUARD_FILENAME}" render_docker_guard
    atomic_write "${SCRATCH_DIRS_DROPIN}" render_scratch_dirs_dropin
    say "wrote ${UNIT_DIR}/${MOUNT_UNIT}, both ${GUARD_FILENAME} guards and ${SCRATCH_DIRS_DROPIN}"
  fi
  atomic_write "${CONTAINERD_DROPIN_DIR}/${DROPIN_FILENAME}" render_containerd_dropin
  atomic_write "${DOCKER_DROPIN_DIR}/${DROPIN_FILENAME}" render_docker_dropin
  if [ -n "${RMD_SCRATCH_LIB_PATH:-}" ] || [ "${DOCKER_DROPIN_DIR}" = "/etc/systemd/system/docker.service.d" ]; then
    atomic_write "${SCRATCH_LIB_PATH}" render_scratch_lib
    chmod 0755 "${SCRATCH_LIB_PATH}"
    echo "install-container-runtime-mount-order: wrote ${SCRATCH_LIB_PATH} (the scratch restore docker runs first)"
  fi
  echo "install-container-runtime-mount-order: wrote ${CONTAINERD_DROPIN_DIR}/${DROPIN_FILENAME} and ${DOCKER_DROPIN_DIR}/${DROPIN_FILENAME}"
  systemctl daemon-reload
  echo "install-container-runtime-mount-order: ran systemctl daemon-reload"
  status=0
  check_all || status=1
  if [ "${ON_SCRATCH}" = "1" ]; then check_scratch_static || status=1; fi
  exit "${status}"
fi

status=0
check_all || status=1
if [ "${ON_SCRATCH}" = "1" ]; then
  check_scratch_static || status=1
  check_scratch_live || status=1
fi
exit "${status}"
