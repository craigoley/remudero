#!/usr/bin/env bash
# scratch-mounts — bind the REBUILDABLE, I/O-heavy paths of a Remudero container to the host's
# ephemeral local NVMe (/mnt/scratch) instead of the IOPS-capped data disk (/mnt/rmd).
# Why, what moves, the operator runbook and the rollback: docs/operator-guide.md "Scratch-disk mounts".
#
# INVARIANT: nothing authoritative moves. Only worktrees, the shared tmp, coverage scratch (the state
# root's and repos/'s), managed repos (re-cloned on demand), the read model's DB files, the
# per-spawn worker homes (made and reaped per spawn), each container's /tmp and the HOST-WIDE test
# slots (one dir for every container and the host, src/lib/test-slot.ts) are bound here;
# the ledger, lanes, plan and every state file, the read-model switch file included, stay put.
# DARK until RMD_SCRATCH=on or the switch file exists; an unmounted or unwritable scratch root makes
# the launch run exactly as before and say why. Falsifier: test/scratch-mounts.test.ts.
#
# A deallocate wipes scratch, so each launch records its dirs in <state-dir>/.scratch-mounts and
# `--restore` (docker.service's ExecStartPre, from install-container-runtime-mount-order.sh)
# re-creates them with that file's owner before docker restarts a container. That drop-in orders
# docker After=/Wants= rmd-scratch.service, never RequiresMountsFor=/mnt/scratch: a script mounts
# the disk, not a mount unit, so at boot that directive would order docker after nothing.
#
# W1-T9617 — THE HOT CHECKOUTS, behind their OWN switch (RMD_SCRATCH_CHECKOUTS, the file
# /etc/remudero/scratch-checkouts.on; both operator decisions, off by default). With it on, each
# build daemon's own checkout (<state-dir>/remudero, node_modules included) is bound from
# <scratch>/rmd/<key>/remudero, and serve's code dir defaults to <scratch>/rmd/<key>/serve-repo
# (serve-container.sh binds that one itself). An empty one is a re-clone: entrypoint.sh clones into
# it and runs npm ci. Off, every plan below is byte-identical to before, so no bind drifts on merge.
# The old copies stay on their disks as the rollback. Host readers of the checkout resolve it here.
#
# USAGE  . scratch-mounts.sh; scratch_plan <state-dir> <container>; scratch_prepare; scratch_fresh_tmp
#        scratch_daemon_checkout|scratch_live_checkout <state-dir> <container>; scratch_code_dir
#        scratch-mounts.sh --restore <state-dir>...                  (root, at docker start)
# SEAMS  RMD_SCRATCH_ROOT (/mnt/scratch), RMD_SCRATCH_SWITCH (/etc/remudero/scratch-mounts.on),
#        RMD_SCRATCH_CHECKOUTS_SWITCH (/etc/remudero/scratch-checkouts.on), RMD_CGROUP_ROOT
#        (/sys/fs/cgroup), RMD_SYS_DEV_BLOCK (/sys/dev/block),
#        RMD_SCRATCH_MOUNTS_FILE (/proc/mounts); the installer's RMD_SCRATCH_STATE_DIRS and
#        RMD_SCRATCH_LIB_PATH (/usr/local/bin/rmd-scratch-mounts, written only on a real host).

SCRATCH_STATE_DEST="/home/node/Remudero"
SCRATCH_CHECKOUT_DEST="${SCRATCH_STATE_DEST}/remudero"
SCRATCH_READ_MODEL_DEST="/home/node/rmd-scratch/read-model"
SCRATCH_WORKER_HOME_DEST="/home/node/rmd-scratch/worker-homes"
SCRATCH_TEST_SLOT_DEST="/home/node/rmd-scratch/test-slots"
SCRATCH_MANIFEST_NAME=".scratch-mounts"

scratch_root() { printf '%s' "${RMD_SCRATCH_ROOT:-/mnt/scratch}"; }

# A TEST PROCESS NEVER RESOLVES THE HOST'S REAL SCRATCH ROOT. W1-T5631's dead switch lives in the
# suite's --import setup, so a run without it (a bare `node --import tsx --test <file>` on the host)
# still read the real switch and mkdir'd ~70 fixture state dirs (recycle-state-*, state-root, ...)
# under /mnt/scratch/rmd. Hand-built child envs lose NODE_TEST_CONTEXT, so temporary state paths
# also require an explicit root. An rmd-* ancestor identifies a fixture outside the OS temp root;
# the state dir's own name is excluded (real instances include rmd-state2 and rmd-site-state).
scratch_root_refused() {
  [ -z "${RMD_SCRATCH_ROOT:-}" ] || return 1
  [ -z "${NODE_TEST_CONTEXT:-}" ] || return 0
  local state_dir="${1:-}" temp_root
  state_dir="${state_dir%/}"
  [ -n "${state_dir}" ] || return 1
  if [ -d "${state_dir}" ]; then
    state_dir="$(cd "${state_dir}" && pwd -P)" || return 0
  fi
  for temp_root in /tmp /var/tmp /private/tmp /var/folders /private/var/folders "${TMPDIR:-}" "${TMP:-}" "${TEMP:-}"; do
    [ -n "${temp_root}" ] || continue
    temp_root="${temp_root%/}"
    case "${state_dir}" in "${temp_root}"|"${temp_root}/"*) return 0 ;; esac
  done
  case "${state_dir}" in */rmd-*/*) return 0 ;; esac
  return 1
}
SCRATCH_REFUSED_NOTE="NOT USED — a test process (NODE_TEST_CONTEXT) or temporary state dir never uses the host's /mnt/scratch; set RMD_SCRATCH_ROOT"

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

# ONE directory for the whole host, not per state dir: every container and the host operator's own
# runs (test-slot.ts resolves /mnt/scratch/rmd/test-slots) must see the same slot files.
scratch_test_slot_dir() { printf '%s/rmd/test-slots' "$(scratch_root)"; }

# Every container user and the host operator reclaim each other's slot records, so the directory is
# 0777 and NOT sticky (a sticky bit would stop one uid unlinking another's dead record). Never fatal.
scratch_open_test_slots() {
  local dir="$1"
  [ "${dir}" = "$(scratch_test_slot_dir)" ] || return 0
  chmod 0777 "${dir}" 2>/dev/null || true
  return 0
}

scratch_enabled() {
  case "${RMD_SCRATCH:-auto}" in
    on) return 0 ;;
    off) return 1 ;;
    *) [ -e "${RMD_SCRATCH_SWITCH:-/etc/remudero/scratch-mounts.on}" ] ;;
  esac
}

# W1-T9617: the hot checkouts' own switch. It only ever adds to a scratch plan that is already on.
# Like the scratch root (W1-T5631), a test process never reads the host's real switch file.
scratch_checkouts_enabled() {
  case "${RMD_SCRATCH_CHECKOUTS:-auto}" in
    on) return 0 ;;
    off) return 1 ;;
  esac
  [ -z "${NODE_TEST_CONTEXT:-}" ] || [ -n "${RMD_SCRATCH_CHECKOUTS_SWITCH:-}" ] || return 1
  [ -e "${RMD_SCRATCH_CHECKOUTS_SWITCH:-/etc/remudero/scratch-checkouts.on}" ]
}

# Serve's code dir is its own checkout (serve-container.sh binds it); a build daemon's is the
# shared <state-dir>/remudero. `remudero-serve` is the only serve container the fleet names.
scratch_is_serve() { case "$1" in *-serve) return 0 ;; esac; return 1; }

# Sets SCRATCH_BASE (<scratch>/rmd/<key>), or SCRATCH_NOTE and returns 1 when the scratch binds are
# off or cannot be used for this state dir and container. Reads nothing but the switch and mounts.
scratch_base_for() {
  local state_dir="$1" container="$2" key
  SCRATCH_BASE=""
  if ! scratch_enabled; then
    SCRATCH_NOTE="off (RMD_SCRATCH=${RMD_SCRATCH:-auto}, no ${RMD_SCRATCH_SWITCH:-/etc/remudero/scratch-mounts.on}): worktrees, tmp, coverage, repos and the read model stay on the state disk"
    return 1
  fi
  if scratch_root_refused "${state_dir}"; then
    SCRATCH_NOTE="${SCRATCH_REFUSED_NOTE}"
    return 1
  fi
  if ! scratch_root_is_mounted; then
    SCRATCH_NOTE="NOT USED — $(scratch_root) is not a mounted filesystem; launching with everything on the state disk"
    return 1
  fi
  key="$(basename "${state_dir}" | tr -c 'A-Za-z0-9_.\n-' '_')"
  case "${key}" in ""|.|..) SCRATCH_NOTE="NOT USED — state dir ${state_dir} has no usable name"; return 1 ;; esac
  case "${container}" in ""|*[!A-Za-z0-9_.-]*) SCRATCH_NOTE="NOT USED — container name '${container}' is not Docker-safe"; return 1 ;; esac
  SCRATCH_BASE="$(scratch_root)/rmd/${key}"
}

# Prints the scratch placement of <container>'s code checkout and returns 0 when the hot checkouts
# move (both switches on, scratch usable); prints nothing and returns 1 otherwise.
scratch_code_dir() {
  scratch_checkouts_enabled && scratch_base_for "$1" "$2" || return 1
  if scratch_is_serve "$2"; then printf '%s/serve-repo\n' "${SCRATCH_BASE}"; else printf '%s/remudero\n' "${SCRATCH_BASE}"; fi
}

# The checkout a build daemon's NEXT launch binds: on scratch when the switch moves it, else the
# literal <state-dir>/remudero. The recycle's repo marker and shared-checkout guard read this one.
scratch_daemon_checkout() {
  scratch_code_dir "$1" "${2:-remudero-daemon}" || printf '%s/remudero\n' "${1%/}"
}

# The checkout the RUNNING <container> binds at /home/node/Remudero/remudero — what a host tick that
# runs bin/rmd, fast-forwards or reads edits must use. A container that binds none there reads the
# state dir's own copy; one docker cannot inspect falls back to the planned placement. Switching the
# placement therefore moves no host reader before the recycle that moves the container itself.
scratch_live_checkout() {
  local state_dir="$1" container="$2" mounts src dest found=""
  if mounts="$(docker inspect --format '{{range .Mounts}}{{.Destination}}{{"\t"}}{{.Source}}{{"\n"}}{{end}}' "${container}" 2>/dev/null)"; then
    while IFS='	' read -r dest src; do
      [ "${dest}" = "${SCRATCH_CHECKOUT_DEST}" ] && [ -n "${src}" ] && found="${src}"
    done <<EOF
${mounts}
EOF
    printf '%s\n' "${found:-${state_dir%/}/remudero}"
    return 0
  fi
  scratch_daemon_checkout "${state_dir}" "${container}"
}

# Sets SCRATCH_ARGS (docker run arguments), SCRATCH_BINDS (host<TAB>container per line),
# SCRATCH_DIRS (host dirs to create), SCRATCH_CONTAINER_TMP and SCRATCH_NOTE. Returns 1, with
# SCRATCH_ARGS empty, when the binds are off or cannot be used. Changes nothing on disk.
scratch_plan() {
  local state_dir="$1" container="$2" base checkout_bind="" code_dir=""
  SCRATCH_ARGS=()
  SCRATCH_BINDS=""
  SCRATCH_DIRS=()
  SCRATCH_CONTAINER_TMP=""
  SCRATCH_CODE_DIR=""
  SCRATCH_STATE_DIR="${state_dir}"
  scratch_base_for "${state_dir}" "${container}" || return 1
  base="${SCRATCH_BASE}"
  # W1-T9617: a build daemon's checkout is one more bind; serve's code dir is only recorded (and
  # created) here, because serve-container.sh binds it at that same path itself.
  if code_dir="$(scratch_code_dir "${state_dir}" "${container}")"; then
    SCRATCH_CODE_DIR="${code_dir}"
    if scratch_is_serve "${container}"; then SCRATCH_DIRS+=("${code_dir}"); else checkout_bind="${code_dir}	${SCRATCH_CHECKOUT_DEST}
"; fi
  fi
  SCRATCH_CONTAINER_TMP="${base}/containers/${container}/tmp"
  SCRATCH_BINDS="${checkout_bind}${base}/worktrees	${SCRATCH_STATE_DEST}/worktrees
${base}/tmp	${SCRATCH_STATE_DEST}/tmp
${base}/remudero-coverage	${SCRATCH_STATE_DEST}/.remudero-coverage
${base}/repos	${SCRATCH_STATE_DEST}/repos
${base}/repos-coverage	${SCRATCH_STATE_DEST}/repos/.remudero-coverage
${base}/read-model	${SCRATCH_READ_MODEL_DEST}
${base}/worker-homes	${SCRATCH_WORKER_HOME_DEST}
${SCRATCH_CONTAINER_TMP}	/tmp
$(scratch_test_slot_dir)	${SCRATCH_TEST_SLOT_DEST}"
  local src dest
  while IFS='	' read -r src dest; do
    SCRATCH_DIRS+=("${src}")
    SCRATCH_ARGS+=(-v "${src}:${dest}")
  done <<EOF
${SCRATCH_BINDS}
EOF
  SCRATCH_ARGS+=(-e "RMD_READ_MODEL_DB_DIR=${SCRATCH_STATE_DEST}/state:${SCRATCH_READ_MODEL_DEST}")
  SCRATCH_ARGS+=(-e "RMD_WORKER_HOME_DIR=${SCRATCH_STATE_DEST}:${SCRATCH_WORKER_HOME_DEST}")
  SCRATCH_ARGS+=(-e "RMD_TEST_SLOT_DIR=${SCRATCH_TEST_SLOT_DEST}")
  SCRATCH_NOTE="on — worktrees, tmp, coverage, repos, the read model, worker homes and /tmp under ${base}; test slots shared at $(scratch_test_slot_dir)"
  [ -z "${SCRATCH_CODE_DIR}" ] || SCRATCH_NOTE="${SCRATCH_NOTE}; the code checkout at ${SCRATCH_CODE_DIR} (scratch-checkouts on)"
  return 0
}

# Creates the planned directories and records them in <state-dir>/.scratch-mounts (the boot-time
# restore's list). On any failure the plan is dropped, so the caller launches without the binds.
scratch_prepare() {
  [ "${#SCRATCH_ARGS[@]}" -gt 0 ] || return 1
  local dir manifest tmp
  for dir in "${SCRATCH_DIRS[@]}"; do
    if [ "${dir}" = "$(scratch_test_slot_dir)" ]; then
      # Shared with other uids: one it cannot write degrades only the slot (test-slot.ts names
      # slot_unavailable), never the launch's other binds.
      mkdir -p "${dir}" 2>/dev/null || true
      scratch_open_test_slots "${dir}"
      { [ -d "${dir}" ] && [ -w "${dir}" ]; } || SCRATCH_NOTE="${SCRATCH_NOTE}; WARNING: ${dir} is not a writable directory, so test runs here go unslotted"
      continue
    fi
    if ! mkdir -p "${dir}" 2>/dev/null || [ ! -w "${dir}" ]; then
      SCRATCH_NOTE="NOT USED — could not create a writable ${dir}; launching with everything on the state disk"
      SCRATCH_ARGS=()
      return 1
    fi
  done
  # Docker would create a missing mount point on the state disk as root, and a rollback would then
  # leave e.g. repos/.remudero-coverage unwritable to the fleet. Make each one ours first.
  local src dest
  while IFS='	' read -r src dest; do
    case "${dest}" in "${SCRATCH_STATE_DEST}/"*) mkdir -p "${SCRATCH_STATE_DIR}/${dest#"${SCRATCH_STATE_DEST}/"}" 2>/dev/null || true ;; esac
  done <<EOF
${SCRATCH_BINDS}
EOF
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

# ── W1-T9617: THE PLACEMENT PROVES ITSELF ──────────────────────────────────────────────────────
# Each recycle with the scratch plan on appends a recycle.checkout_placement row: where its checkout
# sits, whether it starts cold (no .git yet: a re-clone), and what the OUTGOING container read
# from each whole disk over its life (cgroup io.stat, cumulative, with its age). Rows written before
# the switch flips measure the data-disk generation and rows after it the scratch one, so reads/s
# per disk is rios / outgoing_age_s on each side. A cold row's rebuild time is the gap from its ts
# to that container's first daemon.boot row. Every read here is best-effort and never fails a launch.

# The whole disk holding <path> (nvme0n1 for a partition on it); nothing when unreadable.
scratch_disk_of() {
  local mm sys="${RMD_SYS_DEV_BLOCK:-/sys/dev/block}" uevent
  mm="$(stat -c '%Hd:%Ld' "$1" 2>/dev/null)" || return 1
  uevent="${sys}/${mm}/uevent"
  [ ! -e "${sys}/${mm}/partition" ] || uevent="${sys}/${mm}/../uevent"
  sed -n 's/^DEVNAME=//p' "${uevent}" 2>/dev/null | head -n 1
}

# `"outgoing_age_s":N,"outgoing_reads":{"<disk>":{"rios":N,"rbytes":N},...}` for <container>, read
# before it stops. Returns 1 and prints nothing when docker, its cgroup or io.stat is unreadable.
scratch_outgoing_reads() {
  local sys="${RMD_SYS_DEV_BLOCK:-/sys/dev/block}" cgroot="${RMD_CGROUP_ROOT:-/sys/fs/cgroup}"
  local inspect id started cg="" d mm rest kv rios rbytes name reads="" start age=null
  inspect="$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$1" 2>/dev/null)" || return 1
  id="${inspect%% *}"
  started="${inspect#* }"
  case "${id}" in ""|*[!0-9a-f]*) return 1 ;; esac
  for d in "${cgroot}/system.slice/docker-${id}.scope" "${cgroot}/docker/${id}"; do
    if [ -r "${d}/io.stat" ]; then cg="${d}"; break; fi
  done
  [ -n "${cg}" ] || return 1
  while read -r mm rest; do
    rios=""
    rbytes=""
    for kv in ${rest}; do
      case "${kv}" in rios=*) rios="${kv#rios=}" ;; rbytes=*) rbytes="${kv#rbytes=}" ;; esac
    done
    case "${rios}" in ""|*[!0-9]*) continue ;; esac
    case "${rbytes}" in ""|*[!0-9]*) continue ;; esac
    name="$(sed -n 's/^DEVNAME=//p' "${sys}/${mm}/uevent" 2>/dev/null | head -n 1)"
    case "${name}" in ""|*[!A-Za-z0-9_.-]*) name="${mm}" ;; esac
    reads="${reads}${reads:+,}\"${name}\":{\"rios\":${rios},\"rbytes\":${rbytes}}"
  done < "${cg}/io.stat"
  if start="$(date -u -d "${started}" +%s 2>/dev/null)" && [ "${start}" -le "$(date -u +%s)" ]; then
    age=$(($(date -u +%s) - start))
  fi
  printf '"outgoing_age_s":%s,"outgoing_reads":{%s}' "${age}" "${reads}"
}

# Appends one recycle.checkout_placement row to <ledger> for <container>, whose launch binds the
# checkout <checkout>; <cold> is true when that checkout held no .git before the launch, and
# <outgoing> is scratch_outgoing_reads' text (empty when unread). Never fails the caller.
scratch_placement_row() {
  local ledger="$1" container="$2" checkout="$3" cold="$4" outgoing="$5" placement=state-disk disk switch=off
  [ -d "$(dirname "${ledger}")" ] || return 0
  case "${checkout}" in "$(scratch_root)/rmd/"*) placement=scratch ;; esac
  disk="$(scratch_disk_of "${checkout}" 2>/dev/null || true)"
  case "${disk}" in ""|*[!A-Za-z0-9_.:-]*) disk=null ;; *) disk="\"${disk}\"" ;; esac
  case "${cold}" in true|false) ;; *) cold=null ;; esac
  ! scratch_checkouts_enabled || switch=on
  printf '{"ts":"%s","run_id":"RECYCLE-%s","task_id":"RECYCLE","step":"recycle.checkout_placement","lane":"deploy","container":"%s","placement":"%s","checkout":"%s","checkout_disk":%s,"cold":%s,"checkouts_switch":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$$" "${container}" "${placement}" "$(printf '%s' "${checkout}" | tr -d '"\\')" \
    "${disk}" "${cold}" "${switch}" "${outgoing:+,${outgoing}}" >> "${ledger}" 2>/dev/null || true
  return 0
}

# Root, at docker start: re-create every directory a launch recorded, owned by whoever owns that
# launch's record. Only under the scratch root, and only when it is mounted. Never fails docker.
scratch_restore() {
  local state_dir manifest owner dir path
  if scratch_root_refused; then
    echo "scratch-mounts: ${SCRATCH_REFUSED_NOTE}; nothing restored"
    return 0
  fi
  if ! scratch_root_is_mounted; then
    echo "scratch-mounts: $(scratch_root) is not mounted; nothing restored"
    return 0
  fi
  for state_dir in "$@"; do
    if scratch_root_refused "${state_dir}"; then
      echo "scratch-mounts: ${SCRATCH_REFUSED_NOTE}; nothing restored for ${state_dir}"
      continue
    fi
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
      scratch_open_test_slots "${dir}"
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
