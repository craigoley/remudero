#!/usr/bin/env bash
# memory-high-tuner — a self-tuning memory.high for one fleet daemon container, run by the watchdog
# tick (deploy/install-host-units.sh's rmd-relaunch) once per healthy tick.
#
#   deploy/memory-high-tuner.sh --container <name> --state-dir <config.root>
#
# WHY: the fixed memory.high from deploy/resource-policy.sh (#10371) evicted hot files that were then
# re-read from the 500-IOPS /mnt/rmd disk (#10451) while the host had GBs free. Measured 2026-10-09:
# console's file refaults equalled its /mnt/rmd reads (see the PR that added this file).
#
# Tiered, never a fixed ceiling:
#   GROW    throttled AND refaulting AND the host calm: + the refaulted volume in quanta, bounded by
#           half the host's headroom above two reserves, and under 95% of the container's memory.max.
#   HOLD    headroom thin (MemAvailable under two reserves) with nothing else wrong.
#   SHRINK  host pressure (thin headroom plus rising swap-in, a PSI full stall or global reclaim; or
#           MemAvailable under one reserve): the container furthest above its policy gives back a
#           quantum; under severe pressure every one gives back half its excess. NEVER below policy.
#   RESTORE the learned value after a revive from policy or a reverted write.
# The learned value lives in <state>/memory-high-tuned-<container>.json: resource-policy.sh starts the
# next recycle from it and the W1-T4267 drift check accepts it. Every adjustment appends a
# host.memory_high.adjusted ledger row. NEVER FATAL: an unreadable input holds and says why.

MHT_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./resource-policy.sh
. "${MHT_SELF_DIR}/resource-policy.sh"

RMD_MEMORY_HIGH_STEP_MIB="${RMD_MEMORY_HIGH_STEP_MIB:-256}" # the quantum every step is rounded to
RMD_CGROUP_ROOT="${RMD_CGROUP_ROOT:-/sys/fs/cgroup}"
RMD_VMSTAT_PATH="${RMD_VMSTAT_PATH:-/proc/vmstat}"
RMD_HOST_PSI_MEMORY_PATH="${RMD_HOST_PSI_MEMORY_PATH:-/proc/pressure/memory}"
RMD_MEMORY_HIGH_SUDO="${RMD_MEMORY_HIGH_SUDO:-sudo -n}"

mht_step() { local s="${RMD_MEMORY_HIGH_STEP_MIB}"; [ "${s}" -gt 0 ] 2>/dev/null || s=1; printf '%s' "${s}"; }
mht_round_up() { local q; q="$(mht_step)"; printf '%s' $(((($1) + q - 1) / q * q)); }
mht_round_down() { local q; q="$(mht_step)"; printf '%s' $((($1) / q * q)); }

# ── the host's pressure tier ───────────────────────────────────────────────────────────────────────
# Inputs (MiB, or counts per interval; PSI as hundredths of a percent):
#   MH_AVAIL_MIB MH_RESERVE_MIB MH_ALLOCSTALL MH_SWAPIN_RATE MH_PREV_SWAPIN_RATE MH_PSI_FULL10
# Sets MH_TIER (0 calm, 1 watch, 2 pressure, 3 severe) and MH_TIER_WHY.
#
# MEASURED 2026-10-09: the host swapped 0.6-2.8 GB per 2-3 min while MemAvailable sat at 6-11 GB —
# that swap was the containers' own limits reclaiming, and root PSI counts memory.high throttling as
# stall. So swap-in, PSI and global reclaim are pressure only while MemAvailable is actually thin;
# alone they are the very squeeze this tuner exists to relieve.
memory_high_pressure_tier() {
  local reserve="${MH_RESERVE_MIB}" avail="${MH_AVAIL_MIB}" corroborated=0 why=""
  MH_TIER=0 MH_TIER_WHY="calm: MemAvailable ${avail} MiB is over two ${reserve} MiB host reserves"
  [ "${avail}" -lt $((2 * reserve)) ] || return 0
  if [ "${MH_SWAPIN_RATE:-0}" -gt 0 ] && [ "${MH_SWAPIN_RATE:-0}" -gt "${MH_PREV_SWAPIN_RATE:-0}" ]; then
    corroborated=$((corroborated + 1)); why="${why}, swap-in rising (${MH_PREV_SWAPIN_RATE:-0} -> ${MH_SWAPIN_RATE} KiB/s)"
  fi
  if [ "${MH_PSI_FULL10:-0}" -gt 0 ]; then
    corroborated=$((corroborated + 1)); why="${why}, PSI memory full avg10 ${MH_PSI_FULL10}/100 %"
  fi
  if [ "${MH_ALLOCSTALL:-0}" -gt 0 ]; then
    corroborated=$((corroborated + 1)); why="${why}, ${MH_ALLOCSTALL} global direct reclaim stalls"
  fi
  if [ "${avail}" -lt "${reserve}" ]; then
    MH_TIER=$((corroborated > 0 ? 3 : 2))
    MH_TIER_WHY="MemAvailable ${avail} MiB under the ${reserve} MiB host reserve${why}"
  else
    MH_TIER=$((corroborated >= 2 ? 3 : 1 + corroborated))
    MH_TIER_WHY="MemAvailable ${avail} MiB under two ${reserve} MiB host reserves${why}"
  fi
}

# ── the decision ───────────────────────────────────────────────────────────────────────────────────
# Inputs (MiB unless named): MH_LIVE_MIB (live memory.high), MH_POLICY_MIB (resource-policy.sh's value,
# the floor), MH_MAX_MIB (memory.max; empty = none), MH_LEARNED_MIB (recorded; empty = none),
# MH_HIGH_EVENTS (memory.events high delta), MH_REFAULT_MIB (file refaults this interval, per 5 min),
# MH_FURTHEST (1 when this container is the furthest above its policy among the daemon containers),
# plus the tier inputs above. Sets MH_ACTION (grow|shrink|restore|floor|hold), MH_TARGET_MIB, MH_REASON.
memory_high_decide() {
  local live="${MH_LIVE_MIB}" policy="${MH_POLICY_MIB}" cap="" headroom room step target excess
  memory_high_pressure_tier
  MH_ACTION=hold MH_TARGET_MIB="${live}" MH_REASON=""
  [ -n "${MH_MAX_MIB:-}" ] && cap=$((MH_MAX_MIB * RMD_MEMORY_HIGH_MAX_PCT / 100))
  # Policy floor first, whatever the host says: a value under the policy is someone else's mistake.
  if [ "${live}" -lt "${policy}" ]; then
    MH_ACTION=floor MH_TARGET_MIB="${policy}"
    MH_REASON="live ${live} MiB is under the policy's ${policy} MiB; the policy is the floor"
    return 0
  fi
  headroom=$((MH_AVAIL_MIB - 2 * MH_RESERVE_MIB))
  room="$(mht_round_down $((headroom / 2)))"
  if [ "${MH_TIER}" -ge 2 ]; then
    excess=$((live - policy))
    if [ "${excess}" -le 0 ]; then
      MH_REASON="tier ${MH_TIER} (${MH_TIER_WHY}); already at the policy's ${policy} MiB"
      return 0
    fi
    if [ "${MH_TIER}" -ge 3 ]; then
      step="$(mht_round_up $(((excess + 1) / 2)))"
    elif [ "${MH_FURTHEST:-0}" = 1 ]; then
      step="$(mht_step)"
    else
      MH_REASON="tier 2 (${MH_TIER_WHY}); another container is further above its policy and gives back first"
      return 0
    fi
    target=$((live - step)); [ "${target}" -ge "${policy}" ] || target="${policy}"
    MH_ACTION=shrink MH_TARGET_MIB="${target}"
    MH_REASON="tier ${MH_TIER} (${MH_TIER_WHY}); ${excess} MiB above the policy's ${policy} MiB"
    return 0
  fi
  if [ "${MH_TIER}" -eq 1 ]; then
    MH_REASON="tier 1 (${MH_TIER_WHY}); holding"
    return 0
  fi
  if [ -n "${MH_LEARNED_MIB:-}" ] && [ "${MH_LEARNED_MIB}" -gt "${live}" ]; then
    target="${MH_LEARNED_MIB}"
    [ "${room}" -gt 0 ] || { MH_REASON="calm, but no headroom to restore the learned ${MH_LEARNED_MIB} MiB"; return 0; }
    [ "${target}" -le $((live + room)) ] || target=$((live + room))
    [ -z "${cap}" ] || [ "${target}" -le "${cap}" ] || target="${cap}"
    if [ "${target}" -gt "${live}" ]; then
      MH_ACTION=restore MH_TARGET_MIB="${target}"
      MH_REASON="live ${live} MiB is under the learned ${MH_LEARNED_MIB} MiB (a revive from policy, or a reverted write); ${MH_TIER_WHY}"
      return 0
    fi
  fi
  if [ "${MH_HIGH_EVENTS:-0}" -le 0 ] || [ "${MH_REFAULT_MIB:-0}" -le 0 ]; then
    MH_REASON="no squeeze: ${MH_HIGH_EVENTS:-0} high events, ${MH_REFAULT_MIB:-0} MiB file refaults per 5 min"
    return 0
  fi
  if [ "${room}" -le 0 ]; then
    MH_REASON="throttled and refaulting, but half the headroom above two reserves rounds to nothing (MemAvailable ${MH_AVAIL_MIB} MiB)"
    return 0
  fi
  step="$(mht_round_up "${MH_REFAULT_MIB}")"
  [ "${step}" -le "${room}" ] || step="${room}"
  target=$((live + step))
  [ -z "${cap}" ] || [ "${target}" -le "${cap}" ] || target="${cap}"
  if [ "${target}" -le "${live}" ]; then
    MH_REASON="throttled and refaulting, but already at ${RMD_MEMORY_HIGH_MAX_PCT}% of memory.max (${cap} MiB)"
    return 0
  fi
  MH_ACTION=grow MH_TARGET_MIB="${target}"
  MH_REASON="${MH_HIGH_EVENTS} high events and ${MH_REFAULT_MIB} MiB of file refaults per 5 min; step bounded by half the ${headroom} MiB headroom above two reserves"
}

# ── reading the live system ──────────────────────────────────────────────────────────────────────
mht_stat() { awk -v k="$1" '$1 == k { print $2; found = 1 } END { exit found ? 0 : 1 }' "$2" 2>/dev/null; }
mht_meminfo_mib() { awk -v k="$1:" '$1 == k { printf "%d", $2 / 1024; found = 1 } END { exit found ? 0 : 1 }' "${RMD_MEMINFO_PATH:-/proc/meminfo}" 2>/dev/null; }
mht_bytes_mib() { case "$1" in ''|max|*[!0-9]*) return 1 ;; esac; printf '%s' $(($1 / 1048576)); }

# The cgroup directory of container id $1 (systemd driver first, then cgroupfs).
mht_cgroup_dir() {
  local d
  for d in "${RMD_CGROUP_ROOT}/system.slice/docker-$1.scope" "${RMD_CGROUP_ROOT}/docker/$1"; do
    [ -r "${d}/memory.high" ] && { printf '%s' "${d}"; return 0; }
  done
  return 1
}

# The policy value (the floor) for container $1, from the same file the launchers apply.
mht_policy_mib() {
  resource_policy_build_args "$1" >/dev/null 2>&1
  [ -n "${RP_HIGH_POLICY:-}" ] || return 1
  printf '%s' "${RP_HIGH_POLICY}"
}

mht_json_escape() { printf '%s' "$1" | tr -d '"\\' | tr '\n\t' '  '; }

mht_record() {
  local file="$1" container="$2" high="$3" policy="$4" reason="$5" tmp
  tmp="${file}.tmp.$$"
  printf '{"container":"%s","high_mib":%s,"policy_mib":%s,"updated_at":"%s","reason":"%s"}\n' \
    "${container}" "${high}" "${policy}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(mht_json_escape "${reason}")" > "${tmp}" &&
    mv -f "${tmp}" "${file}"
}

mht_ledger() {
  local ledger="$1" container="$2" action="$3" before="$4" after="$5" policy="$6" tier="$7" path="$8" reason="$9"
  printf '{"ts":"%s","run_id":"HOST-MEMORY-HIGH","task_id":"HOST","step":"host.memory_high.adjusted","lane":"host","container":"%s","action":"%s","before_mib":%s,"after_mib":%s,"policy_mib":%s,"tier":%s,"write":"%s","reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${container}" "${action}" "${before}" "${after}" "${policy}" "${tier}" "${path}" \
    "$(mht_json_escape "${reason}")" >> "${ledger}"
}

# Write memory.high = $3 bytes for unit $1 / cgroup dir $2; sets MHT_WRITE_PATH. Read back, always.
# Through `systemctl set-property --runtime <scope>` first: runc's systemd driver gives the scope its
# limits as unit properties (read 2026-10-09: the console scope holds MemoryHigh, MemoryMax and
# MemorySwapMax), so systemd re-applies ITS value whenever it re-realizes the cgroup, and a bare file
# write would silently revert to the policy value. The /run drop-in dies with the scope. The cgroup
# file is the fallback only where set-property fails (a cgroupfs-driver host).
mht_apply() {
  local unit="$1" cg="$2" bytes="$3" live
  MHT_WRITE_PATH=""
  # shellcheck disable=SC2086 # RMD_MEMORY_HIGH_SUDO is a command prefix ("sudo -n")
  if [ -n "${unit}" ] && ${RMD_MEMORY_HIGH_SUDO} systemctl set-property --runtime "${unit}" "MemoryHigh=${bytes}" >/dev/null 2>&1; then
    MHT_WRITE_PATH=systemd
  elif printf '%s\n' "${bytes}" | ${RMD_MEMORY_HIGH_SUDO} tee "${cg}/memory.high" >/dev/null 2>&1; then
    MHT_WRITE_PATH=cgroupfs
  else
    return 1
  fi
  live="$(cat "${cg}/memory.high" 2>/dev/null)"
  [ "${live}" = "${bytes}" ]
}

memory_high_tune() {
  local container="" state_root=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --container) container="$2"; shift 2 ;;
      --state-dir) state_root="$2"; shift 2 ;;
      *) echo "memory-high-tuner: unknown argument $1" >&2; return 2 ;;
    esac
  done
  [ -n "${container}" ] && [ -n "${state_root}" ] || { echo "memory-high-tuner: --container and --state-dir are required" >&2; return 2; }
  local state="${state_root}/state" id cg unit now high_b max_b events refault pswpin stall psi_full avail
  local sample prev v pts pid pev prf psw pst prate rate interval others name oid ocg olive opol x
  # shellcheck disable=SC2034 # read by resource-policy.sh's resource_policy_tuned_file
  STATE_DIR="${state_root}"
  mkdir -p "${state}" 2>/dev/null || true
  id="$(docker inspect --format '{{.Id}}' "${container}" 2>/dev/null)" && [ -n "${id}" ] ||
    { echo "memory-high-tuner: ${container} — hold: no running container"; return 0; }
  cg="$(mht_cgroup_dir "${id}")" || { echo "memory-high-tuner: ${container} — hold: cgroup of ${id:0:12} unreadable"; return 0; }
  case "${cg}" in *.scope) unit="${cg##*/}" ;; *) unit="" ;; esac
  now="$(date -u +%s)"
  high_b="$(cat "${cg}/memory.high" 2>/dev/null)"
  max_b="$(cat "${cg}/memory.max" 2>/dev/null)"
  events="$(mht_stat high "${cg}/memory.events")"
  refault="$(mht_stat workingset_refault_file "${cg}/memory.stat")"
  pswpin="$(mht_stat pswpin "${RMD_VMSTAT_PATH}")"
  stall="$(awk '$1 ~ /^allocstall_/ { s += $2; found = 1 } END { if (found) print s; exit found ? 0 : 1 }' "${RMD_VMSTAT_PATH}" 2>/dev/null)"
  psi_full="$(awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) { split($i, a, "="); printf "%d", a[2] * 100 } }' "${RMD_HOST_PSI_MEMORY_PATH}" 2>/dev/null)"
  avail="$(mht_meminfo_mib MemAvailable)"
  MH_LIVE_MIB="$(mht_bytes_mib "${high_b}")" || { echo "memory-high-tuner: ${container} — hold: memory.high is '${high_b}', not a policy value"; return 0; }
  MH_MAX_MIB="$(mht_bytes_mib "${max_b}")" || MH_MAX_MIB=""
  MH_POLICY_MIB="$(mht_policy_mib "${container}")" || { echo "memory-high-tuner: ${container} — hold: no policy memory.high (${RP_HIGH_NOTE:-unreadable})"; return 0; }
  MH_LEARNED_MIB="$(resource_policy_tuned_high "${container}")" || MH_LEARNED_MIB=""
  for v in "${events}" "${refault}" "${pswpin}" "${stall}" "${avail}"; do
    case "${v}" in ''|*[!0-9]*) echo "memory-high-tuner: ${container} — hold: a counter is unreadable"; return 0 ;; esac
  done
  # The previous sample: deltas only within the SAME container (a recycle resets its counters).
  sample="${state}/memory-high-sample-${container}.txt"
  prev="$(cat "${sample}" 2>/dev/null)"
  read -r v pts pid pev prf psw pst prate <<< "${prev}"
  for x in "${pts}" "${pev}" "${prf}" "${psw}" "${pst}" "${prate}"; do
    case "${x}" in ''|*[!0-9]*) v="" ;; esac
  done
  interval=0; [ "${v}" = v1 ] && interval=$((now - pts))
  rate=0; [ "${interval}" -gt 0 ] && [ "${psw}" -le "${pswpin}" ] && rate=$(((pswpin - psw) * 4 / interval))
  printf 'v1 %s %s %s %s %s %s %s\n' "${now}" "${id}" "${events}" "${refault}" "${pswpin}" "${stall}" "${rate}" \
    > "${sample}.tmp.$$" 2>/dev/null && mv -f "${sample}.tmp.$$" "${sample}" 2>/dev/null
  if [ "${v}" != v1 ] || [ "${pid}" != "${id}" ] || [ "${interval}" -le 0 ] || [ "${pev}" -gt "${events}" ] || [ "${prf}" -gt "${refault}" ]; then
    echo "memory-high-tuner: ${container} — hold: first sample of ${id:0:12}; deltas next tick (memory.high ${MH_LIVE_MIB} MiB)"
    return 0
  fi
  MH_HIGH_EVENTS=$((events - pev))
  MH_REFAULT_MIB=$(((refault - prf) * 4 * 300 / 1024 / interval))
  MH_SWAPIN_RATE="${rate}" MH_PREV_SWAPIN_RATE="${prate}"
  MH_ALLOCSTALL=$((stall - pst)); [ "${MH_ALLOCSTALL}" -ge 0 ] || MH_ALLOCSTALL=0
  MH_PSI_FULL10="${psi_full:-0}" MH_AVAIL_MIB="${avail}" MH_RESERVE_MIB="${RMD_HOST_RESERVE_MIB}"
  # Which daemon container is furthest above its policy? Only a shrink asks.
  MH_FURTHEST=1
  others="$(docker ps --format '{{.Names}} {{.Id}}' 2>/dev/null)"
  while read -r name oid; do
    case "${name}" in remudero-*daemon) : ;; *) continue ;; esac
    [ "${name}" != "${container}" ] || continue
    ocg="$(mht_cgroup_dir "${oid}")" || continue
    olive="$(mht_bytes_mib "$(cat "${ocg}/memory.high" 2>/dev/null)")" || continue
    opol="$(mht_policy_mib "${name}")" || continue
    [ $((olive - opol)) -gt $((MH_LIVE_MIB - MH_POLICY_MIB)) ] && MH_FURTHEST=0
  done <<< "${others}"
  memory_high_decide
  if [ "${MH_ACTION}" = hold ]; then
    echo "memory-high-tuner: ${container} — hold at ${MH_LIVE_MIB} MiB (policy ${MH_POLICY_MIB}): ${MH_REASON}"
    return 0
  fi
  if ! mht_apply "${unit}" "${cg}" $((MH_TARGET_MIB * 1048576)); then
    echo "memory-high-tuner: ${container} — ${MH_ACTION} ${MH_LIVE_MIB} -> ${MH_TARGET_MIB} MiB FAILED (write ${MHT_WRITE_PATH:-refused}; memory.high reads $(cat "${cg}/memory.high" 2>/dev/null)); the next tick re-asks" >&2
    return 0
  fi
  mht_record "$(resource_policy_tuned_file "${container}")" "${container}" "${MH_TARGET_MIB}" "${MH_POLICY_MIB}" "${MH_ACTION}: ${MH_REASON}" || true
  mht_ledger "${state}/ledger.ndjson" "${container}" "${MH_ACTION}" "${MH_LIVE_MIB}" "${MH_TARGET_MIB}" "${MH_POLICY_MIB}" "${MH_TIER}" "${MHT_WRITE_PATH}" "${MH_REASON}" || true
  echo "memory-high-tuner: ${container} — ${MH_ACTION} ${MH_LIVE_MIB} -> ${MH_TARGET_MIB} MiB via ${MHT_WRITE_PATH} (policy ${MH_POLICY_MIB}): ${MH_REASON}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  memory_high_tune "$@"
fi
