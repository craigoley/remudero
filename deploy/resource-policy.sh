#!/usr/bin/env bash
# resource-policy — how much of the fleet host each container may take. Sourced by
# deploy/serve-container.sh (the console backend) and deploy/recycle-container.sh (every build
# daemon instance), so the two launchers can never disagree about the split.
#
# W1-T4102. MEASURED 2026-09-23: one fix-rung worker ran four coverage suites in parallel inside
# remudero-daemon (~28 test processes at 250 MB-1 GB each) on a 15.6 GiB host. No container had a
# memory or CPU policy, so the kernel reclaimed whatever was idle — remudero-serve, between console
# reads — and serve's event loop stalled 1-20 s. Every console tab timed out at its 5 s budget.
#
# THE CONTAINER'S CGROUP IS THE ONLY BOUNDARY THAT HOLDS WHATEVER A WORKER TYPES. Proven on the
# fleet host with a throwaway container before this file existed: --memory-reservation lands as
# cgroup v2 memory.low, --cpu-shares 4096 as cpu.weight 303 and 512 as 59, --memory and
# --memory-swap as memory.max and memory.swap.max. Two cheaper levers were measured as no-ops and
# are deliberately absent: --blkio-weight (every host disk runs the `none`/mq-deadline scheduler,
# where io.weight does nothing) and a test-concurrency cap in NODE_OPTIONS (Node 22 refuses it).
#
# SOURCED, NOT EXECUTED. Each function fills one array and RESOURCE_POLICY_NOTE, which names the
# inputs it used so a launch log shows why a ceiling was or was not applied. A host whose memory
# cannot be read gets the CPU weights and no memory ceiling — a guessed ceiling could OOM a daemon
# that was fine — and the note says so.

RMD_SERVE_MEMORY_RESERVE_MIB="${RMD_SERVE_MEMORY_RESERVE_MIB:-5120}" # active gen peaks 4.95 GiB (2026-10-02)
RMD_HOST_OVERHEAD_MIB="${RMD_HOST_OVERHEAD_MIB:-2048}"               # OS, cloudflared, the small daemons
RMD_BUILD_SWAP_MIB="${RMD_BUILD_SWAP_MIB:-4096}"                     # a build container pages its OWN memory
RMD_MIN_BUILD_CEILING_MIB="${RMD_MIN_BUILD_CEILING_MIB:-2048}"
RMD_SERVE_MEMORY_LIMIT_MIB="${RMD_SERVE_MEMORY_LIMIT_MIB:-}"         # empty = the shared budget; set = operator override (0 = none)
RMD_SERVE_SWAP_MIB="${RMD_SERVE_SWAP_MIB:-2048}"                     # operator ruling 2026-10-19 (was 1024: 95% full)
RMD_SERVE_CPUS="${RMD_SERVE_CPUS:-}"                                 # empty = no CPU quota, weight only
RMD_SERVE_CPU_SHARES="${RMD_SERVE_CPU_SHARES:-4096}"
RMD_BUILD_CPU_SHARES="${RMD_BUILD_CPU_SHARES:-512}"

# ── memory.high: A SOFT CEILING SIZED FROM ONE HOST BUDGET (2026-10-09) ─────────────────────────
# OBSERVED 2026-10-09 on the 15.6 GiB fleet host: three build daemons at memory.max 8.6 GiB + 4 GiB
# swap each and serve at 7.5 GiB — about 33 GiB of hard ceilings over 15.6 GiB of RAM, with NO
# memory.high, so nothing pushed back until the host was already swapping (600-2,300 pages/s, 23 OOM
# kills since boot). Operator ruling: SOFT LIMITS ONLY — memory.max and swap above stay exactly as
# they were; only memory.high is added, where the kernel throttles and reclaims a container
# gradually instead of killing anything.
#
# Each container's memory.high is its RMD_MEMORY_WEIGHTS share of one budget (MemTotal -
# RMD_HOST_RESERVE_MIB), raised to its RMD_MEMORY_HIGH_FLOORS entry when the share would sit below
# that instance's observed working set, and held under its own memory.max. On a host big enough for
# the working sets the weighted shares win and the highs sum to the budget; on the 15.6 GiB host
# they do not fit (the working sets alone exceed the budget), so the floors win and the launch log
# says so. Docker has no memory.high flag: it rides as the OCI annotation
# org.systemd.property.MemoryHigh, which runc's systemd cgroup driver hands to the container's scope
# unit; Docker keeps it in HostConfig.Annotations, where the W1-T4267 drift check reads it back.
RMD_HOST_RESERVE_MIB="${RMD_HOST_RESERVE_MIB:-${RMD_HOST_OVERHEAD_MIB}}"
RMD_MEMORY_WEIGHTS="${RMD_MEMORY_WEIGHTS:-remudero-daemon=16 remudero-serve=10 remudero-console-daemon=3 remudero-site-daemon=2}"
# Observed steady working sets plus headroom (MiB): core 4.5 GB main + one 3.5 GB tsc run; serve
# ~5 GB before #10349; console ~1.5 GB; site ~1 GB. SITE IS SIZED BY ITS RESTART LINE, NOT ITS
# WORKING SET (2026-10-15): the daemon's memory governor restarts at daemonMemory.restartShare 0.5
# of memory.high, and an idle site boot is charged 769-942 MiB rss+swap (189 heap_pressure exits,
# 10-14 08:38Z to 10-15 10:28Z). At 1536 the line was 768 MiB, so it restarted in a loop doing no
# work; 2304 puts it at 1152 MiB (#11971).
RMD_MEMORY_HIGH_FLOORS="${RMD_MEMORY_HIGH_FLOORS:-remudero-daemon=8192 remudero-serve=5632 remudero-console-daemon=2048 remudero-site-daemon=2304}"
RMD_MEMORY_WEIGHT_UNLISTED="${RMD_MEMORY_WEIGHT_UNLISTED:-2}"
RMD_MEMORY_HIGH_MAX_PCT="${RMD_MEMORY_HIGH_MAX_PCT:-95}" # a high never reaches its own memory.max

# ── the daemons' memory flags: OPERATOR RULING 2026-10-19 (#12982) ──────────────────────────────
# Every daemon (core, site, console and serve) and every node process it starts. OBSERVED offline on
# 2026-10-19 (logs-8864/mempress-eff-bench-matrix*.jsonl; a serve-shaped main plus four workers):
# --max-semi-space-size=16 cut busy RSS from 1.41-1.65 GB to 1.02-1.12 GB at an unchanged wall time,
# and new_space from 128 to 32 MiB; glibc arena_max 2 with a 128 KiB trim threshold cut the memory
# still held after the workers exit by 20-25%. The node flag rides NODE_OPTIONS, which V8 applies to
# the whole process (worker threads included) and which every child inherits: the daemon removes
# only its heap ceiling from it (src/lib/daemon-memory-policy.ts withoutHeapCeiling). GLIBC_TUNABLES
# rides the launch arguments below, so the launcher, a recycle, its smoke and serve all carry it.
# ROLLBACK LEVER: empty either value. An empty flag list still removes a carried semi-space flag at
# the next launch, and an empty tuning adds no GLIBC_TUNABLES. Do not revert the recycle's acceptance
# of GLIBC_TUNABLES (deploy/recycle-container.sh) while a running container still carries it.
RESOURCE_POLICY_NODE_MEMORY_FLAGS="--max-semi-space-size=16"
RESOURCE_POLICY_GLIBC_TUNABLES="glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072"

# The `-e GLIBC_TUNABLES=...` launch arguments, in RP_GLIBC_ARGS; none when the tuning is empty.
resource_policy_glibc_args() {
  RP_GLIBC_ARGS=()
  [ -z "${RESOURCE_POLICY_GLIBC_TUNABLES}" ] || RP_GLIBC_ARGS=(-e "GLIBC_TUNABLES=${RESOURCE_POLICY_GLIBC_TUNABLES}")
}

# NODE_OPTIONS $1 with the ruled memory flags: every earlier semi-space flag removed (`=N` and the
# two-word form, either spelling), every other word kept in order, the ruled flags last.
resource_policy_node_options() {
  local words=() word out="" skip_next=0
  read -r -a words <<<"${1:-}"
  for word in "${words[@]+"${words[@]}"}"; do
    if [ "${skip_next}" -eq 1 ]; then
      skip_next=0
      case "${word}" in '' | *[!0-9]*) : ;; *) continue ;; esac
    fi
    case "${word}" in
      --max[-_]semi[-_]space[-_]size) skip_next=1; continue ;;
      --max[-_]semi[-_]space[-_]size=*) continue ;;
    esac
    out="${out:+${out} }${word}"
  done
  if [ -n "${out}" ] && [ -n "${RESOURCE_POLICY_NODE_MEMORY_FLAGS}" ]; then out="${out} "; fi
  printf '%s' "${out}${RESOURCE_POLICY_NODE_MEMORY_FLAGS}"
}

RESOURCE_POLICY_NOTE=""

resource_policy_mem_total_mib() {
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; found = 1 } END { exit found ? 0 : 1 }' \
    "${RMD_MEMINFO_PATH:-/proc/meminfo}" 2>/dev/null
}

# `name=value` lookup in a space-separated list ($2); empty and status 1 when $1 is absent.
resource_policy_lookup() {
  local entry
  for entry in $2; do
    if [ "${entry%%=*}" = "$1" ]; then
      printf '%s' "${entry#*=}"
      return 0
    fi
  done
  return 1
}

# Container $1's memory.high in MiB under memory.max $2 (MiB; empty = none). Sets RP_HIGH (empty when
# MemTotal is unreadable) and RP_HIGH_NOTE naming the arithmetic.
resource_policy_memory_high() {
  local container="$1" max="$2" total budget weight sum=0 entry share floor
  RP_HIGH="" RP_HIGH_NOTE="" RP_HIGH_POLICY="" RP_HIGH_LEARNED=""
  if ! total="$(resource_policy_mem_total_mib)" || [ -z "${total}" ]; then
    RP_HIGH_NOTE="NO memory.high — host MemTotal unreadable"
    return 0
  fi
  budget=$((total - RMD_HOST_RESERVE_MIB))
  for entry in ${RMD_MEMORY_WEIGHTS}; do sum=$((sum + ${entry#*=})); done
  if ! weight="$(resource_policy_lookup "${container}" "${RMD_MEMORY_WEIGHTS}")"; then
    weight="${RMD_MEMORY_WEIGHT_UNLISTED}"
    sum=$((sum + weight))
  fi
  share=$((budget * weight / sum))
  RP_HIGH="${share}"
  RP_HIGH_NOTE="memory.high ${share} MiB = weight ${weight}/${sum} of a ${budget} MiB budget (host ${total} - reserve ${RMD_HOST_RESERVE_MIB})"
  if floor="$(resource_policy_lookup "${container}" "${RMD_MEMORY_HIGH_FLOORS}")" && [ "${floor}" -gt "${share}" ]; then
    RP_HIGH="${floor}"
    RP_HIGH_NOTE="memory.high ${floor} MiB = the working-set floor; the weight ${weight}/${sum} share of the ${budget} MiB budget (host ${total} - reserve ${RMD_HOST_RESERVE_MIB}) is only ${share} MiB"
  fi
  if [ -n "${max}" ] && [ "${RP_HIGH}" -ge $((max * RMD_MEMORY_HIGH_MAX_PCT / 100)) ]; then
    RP_HIGH=$((max * RMD_MEMORY_HIGH_MAX_PCT / 100))
    RP_HIGH_NOTE="${RP_HIGH_NOTE}, held at ${RMD_MEMORY_HIGH_MAX_PCT}% of memory.max = ${RP_HIGH} MiB"
  fi
  if [ "${RP_HIGH}" -le 0 ]; then RP_HIGH="" RP_HIGH_NOTE="NO memory.high — ${RP_HIGH_NOTE}"; fi
  # The policy's own value, before any learned one: the tuner never goes below it, and the drift check
  # treats anything between it and the learned value as current.
  RP_HIGH_POLICY="${RP_HIGH}" RP_HIGH_LEARNED=""
  local tuned
  [ -n "${RP_HIGH}" ] && tuned="$(resource_policy_tuned_high "${container}")" && RP_HIGH_LEARNED="${tuned}"
  if [ -n "${RP_HIGH_LEARNED}" ] && [ "${tuned}" -gt "${RP_HIGH}" ]; then
    if [ -n "${max}" ] && [ "${tuned}" -gt $((max * RMD_MEMORY_HIGH_MAX_PCT / 100)) ]; then
      tuned=$((max * RMD_MEMORY_HIGH_MAX_PCT / 100))
    fi
    RP_HIGH_NOTE="${RP_HIGH_NOTE}; started at the learned ${tuned} MiB (deploy/memory-high-tuner.sh) over the policy's ${RP_HIGH} MiB"
    RP_HIGH="${tuned}"
  fi
  return 0
}

# ── the learned memory.high (deploy/memory-high-tuner.sh, 2026-10-09) ─────────────────────────────
# The watchdog tick raises a container's memory.high at runtime while it is throttled and refaulting
# its page cache with host headroom, and lowers it toward the policy value under host pressure. It
# records the value in <state>/memory-high-tuned-<container>.json, so a recycle starts from the
# learned value instead of throwing it away. The value only ever RAISES the policy's: a learned value
# below the policy (a policy that grew since) is ignored here.
#
# Where it lives: $2 (a <state root>/state directory) when given, else RMD_MEMORY_HIGH_TUNED_DIR, else
# the caller's STATE_DIR/state. Every instance's tuner records under ITS OWN state root, so a peer's
# record is found through resource_policy_instance_state_dir, not through the caller's root.
resource_policy_tuned_file() {
  local dir="${2:-${RMD_MEMORY_HIGH_TUNED_DIR:-}}"
  [ -n "${dir}" ] || { [ -n "${STATE_DIR:-}" ] && dir="${STATE_DIR}/state"; }
  [ -n "${dir}" ] || return 1
  printf '%s/memory-high-tuned-%s.json' "${dir}" "$1"
}

# <state_dir>/state of the instance whose container_name is $1, as the instance registry declares it
# (RMD_INSTANCE_REGISTRY, else this checkout's .remudero/daemon-instances.yaml; the same grammar as
# recycle-container.sh). An active selection (W1-T10573) is a registry file in the same grammar, so the
# answer is the same whichever meaning RMD_INSTANCE_REGISTRY carries (W1-T11276). Serve has no registry
# row: the primary instance's watchdog tunes it, so serve's records live under the `primary: true` row's
# root. A retired row is skipped. Status 1 when there is no registry, no such instance, a relative
# state_dir, or no <state_dir>/state directory here. RMD_MEMORY_HIGH_TUNED_DIR pins one shared directory
# instead, so it also turns this lookup off. With RMD_INSTANCE_REGISTRY unset, RMD_RESOURCE_POLICY_REGISTRY
# names the registry for this lookup alone: the rendered watchdog hands its installed registry that way to
# each call that reaches here (tuner, revival, deploy-run's drift read, edge heal), because those callers
# read RMD_INSTANCE_REGISTRY as an active selection (W1-T10573).
resource_policy_instance_state_dir() {
  local registry root
  [ -z "${RMD_MEMORY_HIGH_TUNED_DIR:-}" ] || return 1
  if [ "${RMD_INSTANCE_REGISTRY+x}" = x ]; then
    registry="${RMD_INSTANCE_REGISTRY}" # set but empty: no registry
  elif [ -n "${RMD_RESOURCE_POLICY_REGISTRY:-}" ]; then
    registry="${RMD_RESOURCE_POLICY_REGISTRY}"
  else
    registry="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)/.remudero/daemon-instances.yaml"
  fi
  [ -n "${registry}" ] && [ -r "${registry}" ] || return 1
  root="$(awk -v want="$1" -v serve="${RMD_SERVE_CONTAINER_NAME:-remudero-serve}" '
    function flush() {
      if (row && r != "true" && d != "") {
        if (c == want && !found) { print d; found = 1 }
        if (p == "true" && primary == "") primary = d
      }
      row = 0
    }
    { sub(/[[:space:]]+#.*/, "") }
    /^[^ ]/ { flush(); next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { flush(); row = 1; c = d = p = r = ""; next }
    row && /^    container_name:/ { c = $2; gsub(/"/, "", c) }
    row && /^    state_dir:/ { d = $2; gsub(/"/, "", d) }
    row && /^    primary:/ { p = $2; gsub(/"/, "", p) }
    row && /^    retired:/ { r = $2; gsub(/"/, "", r) }
    END { flush(); if (!found && want == serve && primary != "") print primary }' "${registry}" 2>/dev/null | head -n 1)" || return 1
  case "${root}" in /*) : ;; *) return 1 ;; esac
  [ -d "${root}/state" ] || return 1
  printf '%s/state' "${root}"
}

# The learned memory.high of container $1 in MiB (read from directory $2 when given); status 1 when
# none is recorded or it is unreadable.
resource_policy_tuned_high() {
  local file value
  file="$(resource_policy_tuned_file "$1" "${2:-}")" || return 1
  [ -r "${file}" ] || return 1
  grep -q "\"container\":\"$1\"" "${file}" 2>/dev/null || return 1
  value="$(sed -n 's/.*"high_mib":\([0-9][0-9]*\).*/\1/p' "${file}" 2>/dev/null | head -n 1)"
  [ -n "${value}" ] && [ "${value}" -gt 0 ] || return 1
  printf '%s' "${value}"
}

# ── memory.max: ONE SHARED HOST BUDGET (operator ruling R1, 2026-10-27, W1-T11130) ──────────────
# OBSERVED 2026-10-27 on the 32 GiB host: every build daemon got memory.max total - 5120 - 2048, so
# core, console and site held 24.3 GiB EACH, and serve held a fixed 7,680 MiB. Together that is
# far over the host. R1 supersedes 10-10's "never raise memory.max": each fleet container's
# memory.max is the host's MemTotal less RMD_HOST_RESERVE_MIB less the sum of the OTHER fleet
# containers' learned peaks. Any one of them can then reach its limit while the rest sit at their
# peaks, and the host still holds. The fleet is the RMD_MEMORY_WEIGHTS list. A learned peak is the
# larger of the cgroup memory.peak recorded in <state>/memory-peak-<container>.json (written by
# resource_policy_record_peak below, on every call and so every tuner tick) and the learned
# memory.high in <state>/memory-high-tuned-<container>.json. A container with neither counts its
# RMD_MEMORY_HIGH_FLOORS entry. Both files are read again at every call, so every recycle and every
# W1-T4267 drift check sees the current split: a container that grows takes only measured slack.
# WHERE THE PEERS' RECORDS ARE: each instance's tuner writes under its OWN state root (the registry's
# state_dir: core rmd-state2, site rmd-site-state, console /mnt/rmd/...), so a recycle in one instance
# reads every peer's two files from that peer's root (resource_policy_instance_state_dir), and the
# caller's own STATE_DIR/state too (serve is no registry instance); the larger value wins.
# THE FORMULA WHEN IT COVERS THE CONTAINER'S OWN PEAK; TODAY'S LIMIT WHEN IT DOES NOT (operator rulings
# 2026-11-03 and 2026-11-04, AskUserQuestion on #16468). The container's OWN peak is its learned peak as
# above, or its RMD_MEMORY_HIGH_FLOORS entry when nothing is learned yet (criterion 2). When the formula
# is at least that peak, memory.max is the formula. When it is below it, the host is OVERCOMMITTED: the
# others' peaks plus this one exceed the budget. Then the container keeps the LARGER of its own peak and
# the memory.max it already runs with, read from its running container's cgroup (the same docker id ->
# scope lookup the peak writer uses), or its own peak when no container runs. So while overcommitted no
# limit is lowered below today's and none below measured need. Pinning at the peak alone was measured
# against the live host and rejected: on 2026-11-04 every container would have sat at exactly its
# historical peak (core 24,918 -> 17,027 MiB) with no room to learn a higher one. A running memory.max of
# "max" is a real no-ceiling, kept as such and named in the note. An unreadable running limit keeps the
# own peak, and the note says it could not be read. Each recompute while overcommitted appends one
# host.memory_max.overcommitted ledger row (container, formula_mib, own_peak_mib, deficit_mib = own peak
# - formula, kept_mib) beside the tuner's rows; a repeat of the same row is not appended again. Once the
# peaks fit, the formula governs and the limits shrink to it. The only other exception is an unreadable
# MemTotal, where there is no budget to share and the caller keeps today's arithmetic. Whenever the
# formula holds, its invariant is per container: its limit plus the other containers' peaks equals the
# budget, so any one container at its limit beside the rest at their peaks fits the host. The four limits
# are NOT disjoint shares and are not meant to sum to the host.

# Where container $1's recorded cgroup memory.peak lives: beside memory-high-tuned-<container>.json
# (in directory $2 when given).
resource_policy_peak_file() {
  local file
  file="$(resource_policy_tuned_file "$1" "${2:-}")" || return 1
  printf '%s/memory-peak-%s.json' "${file%/*}" "$1"
}

# THE WRITER of memory-peak-<container>.json (W1-T11130). Reads the running container $1's cgroup
# memory.peak (the same docker id -> RMD_CGROUP_ROOT scope lookup the tuner uses) and keeps the
# LARGER of it and what is already recorded, as {"container","peak_mib"}. memory.peak restarts at
# zero with every new container, so the record is a high-water mark across recycles; deleting the
# file forgets it. Every call to resource_policy_shared_memory_max records each fleet container
# first, and deploy/memory-high-tuner.sh reaches it on every healthy tick through its policy read, so
# the record advances each tick and at every recycle and drift check. Best effort and never fatal:
# a container that is not running, a cgroup without memory.peak or a state dir that cannot be
# written leaves the record as it was.
resource_policy_record_peak() {
  local container="$1" file id cg raw live old tmp dir=""
  command -v docker >/dev/null 2>&1 || return 0
  # The record goes beside the container's OWN tuner record when the registry names its state root and
  # that root is writable here; otherwise beside the caller's.
  if dir="$(resource_policy_instance_state_dir "${container}")" && [ -w "${dir}" ]; then : ; else dir=""; fi
  file="$(resource_policy_peak_file "${container}" "${dir}")" || return 0
  [ -d "${file%/*}" ] || return 0
  id="$(docker inspect --format '{{.Id}}' "${container}" 2>/dev/null)" || return 0
  case "${id}" in '' | *[!0-9a-f]*) return 0 ;; esac
  for cg in "${RMD_CGROUP_ROOT:-/sys/fs/cgroup}/system.slice/docker-${id}.scope" "${RMD_CGROUP_ROOT:-/sys/fs/cgroup}/docker/${id}"; do
    [ -r "${cg}/memory.peak" ] && break
    cg=""
  done
  [ -n "${cg}" ] || return 0
  raw="$(cat "${cg}/memory.peak" 2>/dev/null)" || return 0
  case "${raw}" in '' | *[!0-9]*) return 0 ;; esac
  live=$((raw / 1048576))
  [ "${live}" -gt 0 ] || return 0
  old="$(resource_policy_recorded_peak "${container}" "${dir}")" || old=""
  [ -z "${old}" ] || [ "${live}" -gt "${old}" ] || return 0
  tmp="${file}.tmp.$$"
  printf '{"container":"%s","peak_mib":%s}\n' "${container}" "${live}" > "${tmp}" 2>/dev/null && mv -f "${tmp}" "${file}" 2>/dev/null || rm -f "${tmp}" 2>/dev/null
  return 0
}

# The recorded cgroup memory.peak of container $1 in MiB (read from directory $2 when given); status 1
# when none is readable.
resource_policy_recorded_peak() {
  local file value
  file="$(resource_policy_peak_file "$1" "${2:-}")" || return 1
  [ -r "${file}" ] || return 1
  grep -q "\"container\":\"$1\"" "${file}" 2>/dev/null || return 1
  value="$(sed -n 's/.*"peak_mib":\([0-9][0-9]*\).*/\1/p' "${file}" 2>/dev/null | head -n 1)"
  [ -n "${value}" ] && [ "${value}" -gt 0 ] || return 1
  printf '%s' "${value}"
}

# The larger of reader $1 (resource_policy_recorded_peak or resource_policy_tuned_high) for container
# $2 over the caller's own state dir and the container's registry state root. Status 1 when neither
# holds a record.
resource_policy_largest_record() {
  local reader="$1" name="$2" best="" value dir peerdir dirs=("")
  if peerdir="$(resource_policy_instance_state_dir "${name}")"; then dirs+=("${peerdir}"); fi
  for dir in "${dirs[@]}"; do
    value="$("${reader}" "${name}" "${dir}")" || continue
    if [ -z "${best}" ] || [ "${value}" -gt "${best}" ]; then best="${value}"; fi
  done
  [ -n "${best}" ] || return 1
  printf '%s' "${best}"
}

# Container $1's learned peak in MiB. Sets RP_PEAK (empty when it has no record and no floor) and
# RP_PEAK_FROM, which names where the value came from.
resource_policy_learned_peak() {
  local peak high
  RP_PEAK="" RP_PEAK_FROM=""
  peak="$(resource_policy_largest_record resource_policy_recorded_peak "$1")" || peak=""
  high="$(resource_policy_largest_record resource_policy_tuned_high "$1")" || high=""
  if [ -n "${peak}" ] && { [ -z "${high}" ] || [ "${peak}" -ge "${high}" ]; }; then
    RP_PEAK="${peak}" RP_PEAK_FROM="memory.peak"
  elif [ -n "${high}" ]; then
    RP_PEAK="${high}" RP_PEAK_FROM="learned memory.high"
  elif RP_PEAK="$(resource_policy_lookup "$1" "${RMD_MEMORY_HIGH_FLOORS}")"; then
    RP_PEAK_FROM="floor, nothing learned"
  else
    RP_PEAK=""
  fi
}

# The memory.max container $1 runs with NOW, from its running container's cgroup: RP_RUNNING_MAX in MiB,
# or "unlimited" for a cgroup memory.max of "max". Status 1 when it is not running (no id, or no cgroup
# scope), status 2 when it runs but its memory.max cannot be read. Never fatal.
resource_policy_running_max() {
  local container="$1" id cg raw
  RP_RUNNING_MAX=""
  command -v docker >/dev/null 2>&1 || return 1
  id="$(docker inspect --format '{{.Id}}' "${container}" 2>/dev/null)" || return 1
  case "${id}" in '' | *[!0-9a-f]*) return 1 ;; esac
  for cg in "${RMD_CGROUP_ROOT:-/sys/fs/cgroup}/system.slice/docker-${id}.scope" "${RMD_CGROUP_ROOT:-/sys/fs/cgroup}/docker/${id}"; do
    [ -d "${cg}" ] && break
    cg=""
  done
  [ -n "${cg}" ] || return 1
  raw="$(cat "${cg}/memory.max" 2>/dev/null)" || return 2
  case "${raw}" in
    max) RP_RUNNING_MAX="unlimited" ;;
    '' | *[!0-9]*) return 2 ;;
    *) RP_RUNNING_MAX=$((raw / 1048576)) ;;
  esac
  return 0
}

# Appends one host.memory_max.overcommitted row for container $1 (formula $2, own peak $3, deficit $4,
# all MiB, and the limit it keeps, $5: MiB or "unlimited") beside the caller's tuner records. Skipped when the newest such row for the container
# already holds the same formula and peak; never fatal and silent when the ledger cannot be written.
resource_policy_overcommit_row() {
  local container="$1" formula="$2" peak="$3" deficit="$4" kept="$5" file dir last kept_json
  file="$(resource_policy_tuned_file "${container}")" || return 0
  dir="${file%/*}"
  [ -d "${dir}" ] || return 0
  case "${kept}" in unlimited) kept_json='"unlimited"' ;; *) kept_json="${kept}" ;; esac
  last="$(tail -n 400 "${dir}/ledger.ndjson" 2>/dev/null | grep "\"step\":\"host.memory_max.overcommitted\",.*\"container\":\"${container}\"" | tail -n 1)" || last=""
  case "${last}" in *"\"formula_mib\":${formula},\"own_peak_mib\":${peak},\"deficit_mib\":${deficit},\"kept_mib\":${kept_json}}"*) return 0 ;; esac
  printf '{"ts":"%s","run_id":"HOST-MEMORY-MAX","task_id":"HOST","step":"host.memory_max.overcommitted","lane":"host","container":"%s","formula_mib":%s,"own_peak_mib":%s,"deficit_mib":%s,"kept_mib":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${container}" "${formula}" "${peak}" "${deficit}" "${kept_json}" 2>/dev/null >> "${dir}/ledger.ndjson" || true
  return 0
}

# Container $1's memory.max in MiB: the shared-budget formula (host MemTotal - RMD_HOST_RESERVE_MIB - the
# sum of every OTHER fleet container's learned peak) when it covers $1's own peak (learned, else its
# floor); otherwise the larger of that own peak and the memory.max $1 runs with now. Sets RP_MAX (MiB),
# RP_MAX_UNLIMITED (1 when it keeps a running "max", RP_MAX then empty), RP_MAX_OWN (the container's own
# learned peak or floor; empty when it has neither), RP_MAX_FORMULA (the formula's
# own value, possibly small or negative), RP_MAX_DEFICIT (own peak - formula when overcommitted, else
# empty) and RP_MAX_NOTE, which names every term. Status 1 (RP_MAX empty, RP_MAX_UNLIMITED empty) only
# when MemTotal is unreadable: the caller keeps today's arithmetic.
resource_policy_shared_memory_max() {
  local container="$1" total budget others=0 entry name terms="" own="" own_from="" running_state kept kept_from
  RP_MAX="" RP_MAX_UNLIMITED="" RP_MAX_FORMULA="" RP_MAX_DEFICIT="" RP_MAX_NOTE="" RP_MAX_OWN=""
  if ! total="$(resource_policy_mem_total_mib)" || [ -z "${total}" ]; then
    RP_MAX_NOTE="host MemTotal unreadable at ${RMD_MEMINFO_PATH:-/proc/meminfo}"
    return 1
  fi
  budget=$((total - RMD_HOST_RESERVE_MIB))
  # Advance every fleet container's recorded memory.peak first, so the sum below is current.
  for entry in ${RMD_MEMORY_WEIGHTS}; do resource_policy_record_peak "${entry%%=*}"; done
  for entry in ${RMD_MEMORY_WEIGHTS}; do
    name="${entry%%=*}"
    [ "${name}" != "${container}" ] || continue
    resource_policy_learned_peak "${name}"
    [ -n "${RP_PEAK}" ] || continue
    others=$((others + RP_PEAK))
    terms="${terms} - ${name} ${RP_PEAK} (${RP_PEAK_FROM})"
  done
  # This container's OWN peak: what it learned, else its floor (criterion 2).
  resource_policy_learned_peak "${container}"
  own="${RP_PEAK}" own_from="${RP_PEAK_FROM}"
  RP_MAX_OWN="${own}"
  RP_MAX_FORMULA=$((budget - others))
  local formula_note="shared budget: host ${total} - reserve ${RMD_HOST_RESERVE_MIB}${terms}"
  if [ -z "${own}" ] || [ "${RP_MAX_FORMULA}" -ge "${own}" ]; then
    RP_MAX="${RP_MAX_FORMULA}"
    RP_MAX_NOTE="memory.max ${RP_MAX} MiB = ${formula_note}"
    return 0
  fi
  # OVERCOMMITTED: the formula is below this container's own peak. Keep today's limit, never below the peak.
  RP_MAX_DEFICIT=$((own - RP_MAX_FORMULA))
  kept="${own}" kept_from="its own peak ${own} (${own_from})"
  # The launchers run under `set -e`: a status test, never a bare call, so "not running" cannot abort them.
  if resource_policy_running_max "${container}"; then running_state=0; else running_state=$?; fi
  case "${running_state}" in
    0)
      if [ "${RP_RUNNING_MAX}" = unlimited ]; then
        kept="unlimited" kept_from="the no-ceiling (memory.max \"max\") it runs with now"
      elif [ "${RP_RUNNING_MAX}" -gt "${own}" ]; then
        kept="${RP_RUNNING_MAX}" kept_from="the ${RP_RUNNING_MAX} MiB it runs with now, above its own peak ${own} (${own_from})"
      else
        kept_from="its own peak ${own} (${own_from}), at or above the ${RP_RUNNING_MAX} MiB it runs with now"
      fi ;;
    1) kept_from="its own peak ${own} (${own_from}); no running container to keep a limit from" ;;
    *) kept_from="its own peak ${own} (${own_from}); the running container's memory.max could not be read" ;;
  esac
  if [ "${kept}" = unlimited ]; then
    RP_MAX="" RP_MAX_UNLIMITED=1
    RP_MAX_NOTE="NO memory ceiling kept — ${kept_from}: OVERCOMMITTED, the shared-budget formula ${RP_MAX_FORMULA} MiB is ${RP_MAX_DEFICIT} MiB under its own peak ${own}; formula: ${formula_note}"
  else
    RP_MAX="${kept}"
    RP_MAX_NOTE="memory.max ${RP_MAX} MiB kept = ${kept_from}: OVERCOMMITTED, the shared-budget formula ${RP_MAX_FORMULA} MiB is ${RP_MAX_DEFICIT} MiB under its own peak ${own}; formula: ${formula_note}"
  fi
  resource_policy_overcommit_row "${container}" "${RP_MAX_FORMULA}" "${own}" "${RP_MAX_DEFICIT}" "${kept}"
  return 0
}

# The docker run argument that sets memory.high to $1 MiB.
resource_policy_memory_high_arg() {
  printf -- '--annotation=org.systemd.property.MemoryHigh=uint64 %s' "$(($1 * 1024 * 1024))"
}

# Post-start probe: what memory.high the kernel actually holds for running container $1 against the
# $2 MiB the policy asked for. Read-only and never fatal — it names a silently dropped annotation.
resource_policy_probe_memory_high() {
  local container="$1" want_mib="$2" pid cg live
  [ -n "${want_mib}" ] || return 0
  pid="$(docker inspect --format '{{.State.Pid}}' "${container}" 2>/dev/null || true)"
  cg="$(awk -F: '$1 == "0" { print $3 }' "/proc/${pid:-0}/cgroup" 2>/dev/null || true)"
  live="$(cat "/sys/fs/cgroup${cg}/memory.high" 2>/dev/null || true)"
  if [ -z "${cg}" ] || [ -z "${live}" ]; then
    echo "resource policy: memory.high of ${container} UNREADABLE (pid ${pid:-?}) — cannot confirm the ${want_mib} MiB soft ceiling took"
  elif [ "${live}" = "$((want_mib * 1024 * 1024))" ]; then
    echo "resource policy: memory.high of ${container} confirmed live at ${want_mib} MiB (${cg})"
  else
    echo "resource policy: WARNING memory.high of ${container} reads ${live}, NOT the ${want_mib} MiB the policy set — the MemoryHigh annotation did not reach the cgroup (${cg})" >&2
  fi
}

# serve gets a high CPU weight and a hard memory ceiling that bounds a leak rather than squeezing
# the working set. NO memory.low (operator ruling 2026-10-19): --memory-reservation set serve's
# memory.low to 5 GiB, but system.slice holds memory.low=0, and the kernel limits a cgroup's
# effective low boundary by its ancestors' (Documentation/admin-guide/cgroup-v2.rst), so it
# protected nothing. RMD_SERVE_MEMORY_RESERVE_MIB stays only as the lowest ceiling serve may get;
# since W1-T11130 the shared budget above sizes every memory.max. W1-T4102 left serve unlimited
# ("an OOM-killed console backend is worse than a slow one"); the 2026-09-30 architecture ruling
# (DECISIONS) reverses that: serve grew from 1.0-1.2 GiB to 2.2-3.6 GiB in a week with nothing
# bounding it. 5 GiB is 1.4x the highest reading (3.64 GiB, page cache included, under a
# 40-route probe) and 2x the highest process RSS (2.5 GB). At the ceiling the kernel first drops
# serve's own page cache, then swaps up to RMD_SERVE_SWAP_MIB, and only then kills; the container
# restarts itself. No CPU quota by default: the weight already wins contention, and a quota would
# slow serve's cold reads on an idle host. RMD_SERVE_CPUS adds one without a code change.
# Serve has no other NODE_OPTIONS, so its whole value is the ruled memory flags.
resource_policy_serve_args() {
  local serve_node_options
  serve_node_options="$(resource_policy_node_options "")"
  resource_policy_glibc_args
  RESOURCE_POLICY_SERVE_ARGS=("--cpu-shares=${RMD_SERVE_CPU_SHARES}")
  [ -z "${serve_node_options}" ] || RESOURCE_POLICY_SERVE_ARGS+=(-e "NODE_OPTIONS=${serve_node_options}")
  RESOURCE_POLICY_SERVE_ARGS+=("${RP_GLIBC_ARGS[@]+"${RP_GLIBC_ARGS[@]}"}")
  RESOURCE_POLICY_NOTE="serve: cpu-shares ${RMD_SERVE_CPU_SHARES}, no memory.low, NODE_OPTIONS ${serve_node_options:-none}, GLIBC_TUNABLES ${RESOURCE_POLICY_GLIBC_TUNABLES:-none}"
  # W1-T11130: serve's memory.max is its share of the shared budget, like every build daemon's. An
  # explicit RMD_SERVE_MEMORY_LIMIT_MIB is an operator override and the note names it. Only a host
  # whose MemTotal is unreadable keeps today's fixed ceiling (#8569, 10-02).
  local serve_container="${RMD_SERVE_CONTAINER_NAME:-remudero-serve}" today=7680 limit from budgeted=""
  if [ -n "${RMD_SERVE_MEMORY_LIMIT_MIB}" ]; then
    limit="${RMD_SERVE_MEMORY_LIMIT_MIB}" from="operator override RMD_SERVE_MEMORY_LIMIT_MIB=${RMD_SERVE_MEMORY_LIMIT_MIB}"
  elif resource_policy_shared_memory_max "${serve_container}"; then
    limit="${RP_MAX:-0}" from="${RP_MAX_NOTE}" budgeted=1
  else
    limit="${today}" from="today's fixed ${today} MiB, ${RP_MAX_NOTE}"
  fi
  # A shared-budget limit is measured against serve's own peak (or floor): it governs at any size
  # above zero, even under the old reserve line. The reserve stands in only when serve has neither a
  # learned peak nor a floor, and still bounds the operator override and the unreadable-host value.
  local serve_max="" floor="${RMD_SERVE_MEMORY_RESERVE_MIB}"
  if [ -n "${budgeted}" ] && [ -n "${RP_MAX_OWN:-}" ]; then floor=0; fi
  if [ "${limit}" -gt "${floor}" ]; then
    serve_max="${limit}"
    RESOURCE_POLICY_SERVE_ARGS+=("--memory=${limit}m" "--memory-swap=$((limit + RMD_SERVE_SWAP_MIB))m")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, memory ceiling ${limit} MiB (+${RMD_SERVE_SWAP_MIB} MiB swap) from ${from}"
  elif [ -n "${RP_MAX_UNLIMITED:-}" ] && [ -z "${RMD_SERVE_MEMORY_LIMIT_MIB}" ]; then
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, ${from}"
  else
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, NO memory ceiling — ${limit} MiB (${from}) is not above the ${floor} MiB reserve"
  fi
  resource_policy_memory_high "${serve_container}" "${serve_max}"
  RESOURCE_POLICY_SERVE_HIGH_MIB="${RP_HIGH}"
  [ -n "${RP_HIGH}" ] && RESOURCE_POLICY_SERVE_ARGS+=("$(resource_policy_memory_high_arg "${RP_HIGH}")")
  RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, ${RP_HIGH_NOTE}"
  if [ -n "${RMD_SERVE_CPUS}" ]; then
    RESOURCE_POLICY_SERVE_ARGS+=("--cpus=${RMD_SERVE_CPUS}")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, cpus ${RMD_SERVE_CPUS}"
  fi
}

# A build daemon gets a low CPU weight and a memory ceiling from the shared budget, which leaves
# room for the other containers' peaks. At the ceiling it swaps its own pages, then the kernel
# OOM-kills inside THAT container (its largest process, a test runner) — never serve.
# $1 names the container (default the core daemon): its memory.high is its own share, not a shared one.
resource_policy_build_args() {
  resource_policy_glibc_args
  RESOURCE_POLICY_BUILD_ARGS=("--cpu-shares=${RMD_BUILD_CPU_SHARES}" "${RP_GLIBC_ARGS[@]+"${RP_GLIBC_ARGS[@]}"}")
  local total ceiling container="${1:-remudero-daemon}"
  # shellcheck disable=SC2034 # RP_HIGH_POLICY is read by the tuner and the drift check
  RP_HIGH="" RP_HIGH_POLICY="" RP_HIGH_LEARNED=""
  if ! total="$(resource_policy_mem_total_mib)" || [ -z "${total}" ]; then
    RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; NO memory ceiling — host MemTotal unreadable at ${RMD_MEMINFO_PATH:-/proc/meminfo}"
    return 0
  fi
  # W1-T11130: this container's memory.max from resource_policy_shared_memory_max: the formula, or today's
  # limit while the host is overcommitted. A kept "max" is no ceiling. A limit measured against the
  # container's own peak or floor governs at any size above zero, even under the build floor; the build
  # floor stands in only for a container with neither, whose formula under it is no ceiling. memory.high
  # is still sized then (it has no memory.max to stay under).
  resource_policy_shared_memory_max "${container}"
  if [ -n "${RP_MAX_UNLIMITED:-}" ]; then
    RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; ${RP_MAX_NOTE}"
    resource_policy_memory_high "${container}" ""
    [ -n "${RP_HIGH}" ] && RESOURCE_POLICY_BUILD_ARGS+=("$(resource_policy_memory_high_arg "${RP_HIGH}")")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}; ${container} ${RP_HIGH_NOTE}"
    return 0
  fi
  ceiling="${RP_MAX}"
  local build_floor="${RMD_MIN_BUILD_CEILING_MIB}"
  [ -z "${RP_MAX_OWN:-}" ] || build_floor=1
  if [ "${ceiling}" -lt "${build_floor}" ]; then
    RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; NO memory ceiling — ${RP_MAX_NOTE}, under the ${build_floor} MiB floor"
    resource_policy_memory_high "${container}" ""
    [ -n "${RP_HIGH}" ] && RESOURCE_POLICY_BUILD_ARGS+=("$(resource_policy_memory_high_arg "${RP_HIGH}")")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}; ${container} ${RP_HIGH_NOTE}"
    return 0
  fi
  RESOURCE_POLICY_BUILD_ARGS+=("--memory=${ceiling}m" "--memory-swap=$((ceiling + RMD_BUILD_SWAP_MIB))m")
  RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; memory ceiling ${ceiling} MiB (+${RMD_BUILD_SWAP_MIB} MiB swap), ${RP_MAX_NOTE}"
  resource_policy_memory_high "${container}" "${ceiling}"
  [ -n "${RP_HIGH}" ] && RESOURCE_POLICY_BUILD_ARGS+=("$(resource_policy_memory_high_arg "${RP_HIGH}")")
  RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}; ${container} ${RP_HIGH_NOTE}"
}

# ── the host's own agent sessions: user-<uid>.slice (2026-10-09) ──────────────────────────────────
# OBSERVED 2026-10-09: user-1000.slice holds the operator's host agent sessions and the rmd-author-*
# work they start. It had no cap, peaked at 11.9 GiB on the 15.6 GiB host and, at CPUWeight 100,
# outranked every build daemon (59). The operator capped it by hand (CPUWeight=30, MemoryHigh=6G).
# A rebuilt host would lose that hand fix, so deploy/install-host-units.sh now renders it.
#
# SOFT ONLY: MemoryHigh, NEVER MemoryMax. At memory.high the kernel throttles and reclaims the
# slice's own pages. It never kills, so a session only slows down. The slice is one more weighted
# claimant on the same budget as the containers above: RMD_SESSION_MEMORY_WEIGHT against
# RMD_MEMORY_WEIGHTS. It is rounded to RMD_SESSION_HIGH_STEP_MIB so a MemTotal that moves by a few
# MiB across kernels never rewrites the file. The container shares are left as they are: memory.high
# is soft, and on this host their working-set floors already exceed the budget. CPUWeight 30 is about
# half a build daemon's measured 59, so a session yields to the fleet when both want the CPU.
RMD_SESSION_MEMORY_WEIGHT="${RMD_SESSION_MEMORY_WEIGHT:-24}"
RMD_SESSION_CPU_WEIGHT="${RMD_SESSION_CPU_WEIGHT:-30}"
RMD_SESSION_HIGH_STEP_MIB="${RMD_SESSION_HIGH_STEP_MIB:-256}"

# Sets RP_SESSION_HIGH_MIB (empty when MemTotal is unreadable) and RP_SESSION_NOTE.
resource_policy_session_slice() {
  local total budget sum=0 entry share step="${RMD_SESSION_HIGH_STEP_MIB}"
  RP_SESSION_HIGH_MIB="" RP_SESSION_NOTE=""
  if ! total="$(resource_policy_mem_total_mib)" || [ -z "${total}" ]; then
    RP_SESSION_NOTE="NO session cap — host MemTotal unreadable at ${RMD_MEMINFO_PATH:-/proc/meminfo}"
    return 0
  fi
  budget=$((total - RMD_HOST_RESERVE_MIB))
  for entry in ${RMD_MEMORY_WEIGHTS}; do sum=$((sum + ${entry#*=})); done
  sum=$((sum + RMD_SESSION_MEMORY_WEIGHT))
  share=$((budget * RMD_SESSION_MEMORY_WEIGHT / sum))
  [ "${step}" -gt 0 ] 2>/dev/null || step=1
  share=$(((share + step / 2) / step * step))
  if [ "${share}" -le 0 ]; then
    RP_SESSION_NOTE="NO session cap — weight ${RMD_SESSION_MEMORY_WEIGHT}/${sum} of a ${budget} MiB budget rounds to nothing"
    return 0
  fi
  RP_SESSION_HIGH_MIB="${share}"
  RP_SESSION_NOTE="session MemoryHigh ${share} MiB = weight ${RMD_SESSION_MEMORY_WEIGHT}/${sum} of a ${budget} MiB budget (host ${total} - reserve ${RMD_HOST_RESERVE_MIB}), CPUWeight ${RMD_SESSION_CPU_WEIGHT}"
}

# The systemd drop-in for user-<uid>.slice, or nothing when no cap can be sized.
resource_policy_session_slice_dropin() {
  resource_policy_session_slice
  [ -n "${RP_SESSION_HIGH_MIB}" ] || return 0
  local high="${RP_SESSION_HIGH_MIB}M"
  [ $((RP_SESSION_HIGH_MIB % 1024)) -eq 0 ] && high="$((RP_SESSION_HIGH_MIB / 1024))G"
  printf '# Rendered by deploy/install-host-units.sh from deploy/resource-policy.sh; edits are converged away.\n'
  printf '# %s\n' "${RP_SESSION_NOTE}"
  printf '[Slice]\nCPUWeight=%s\nMemoryHigh=%s\n' "${RMD_SESSION_CPU_WEIGHT}" "${high}"
}
