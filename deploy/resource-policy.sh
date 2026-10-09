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
RMD_SERVE_MEMORY_LIMIT_MIB="${RMD_SERVE_MEMORY_LIMIT_MIB:-7680}"     # 0 = no hard limit; see resource_policy_serve_args
RMD_SERVE_SWAP_MIB="${RMD_SERVE_SWAP_MIB:-1024}"
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
# ~5 GB before #10349; console ~1.5 GB; site ~1 GB.
RMD_MEMORY_HIGH_FLOORS="${RMD_MEMORY_HIGH_FLOORS:-remudero-daemon=8192 remudero-serve=5632 remudero-console-daemon=2048 remudero-site-daemon=1536}"
RMD_MEMORY_WEIGHT_UNLISTED="${RMD_MEMORY_WEIGHT_UNLISTED:-2}"
RMD_MEMORY_HIGH_MAX_PCT="${RMD_MEMORY_HIGH_MAX_PCT:-95}" # a high never reaches its own memory.max

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
  RP_HIGH="" RP_HIGH_NOTE=""
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

# serve gets protected memory (memory.low), a high CPU weight, and a hard memory ceiling that
# bounds a leak rather than squeezing the working set. W1-T4102 left serve unlimited ("an
# OOM-killed console backend is worse than a slow one"); the 2026-09-30 architecture ruling
# (DECISIONS) reverses that: serve grew from 1.0-1.2 GiB to 2.2-3.6 GiB in a week with nothing
# bounding it. 5 GiB is 1.4x the highest reading (3.64 GiB, page cache included, under a
# 40-route probe) and 2x the highest process RSS (2.5 GB). At the ceiling the kernel first drops
# serve's own page cache, then swaps up to RMD_SERVE_SWAP_MIB, and only then kills; the container
# restarts itself. No CPU quota by default: the weight already wins contention, and a quota would
# slow serve's cold reads on an idle host. RMD_SERVE_CPUS adds one without a code change.
resource_policy_serve_args() {
  RESOURCE_POLICY_SERVE_ARGS=(
    "--memory-reservation=${RMD_SERVE_MEMORY_RESERVE_MIB}m"
    "--cpu-shares=${RMD_SERVE_CPU_SHARES}"
  )
  RESOURCE_POLICY_NOTE="serve: memory.low ${RMD_SERVE_MEMORY_RESERVE_MIB} MiB, cpu-shares ${RMD_SERVE_CPU_SHARES}"
  if [ "${RMD_SERVE_MEMORY_LIMIT_MIB}" -gt "${RMD_SERVE_MEMORY_RESERVE_MIB}" ]; then
    RESOURCE_POLICY_SERVE_ARGS+=("--memory=${RMD_SERVE_MEMORY_LIMIT_MIB}m" "--memory-swap=$((RMD_SERVE_MEMORY_LIMIT_MIB + RMD_SERVE_SWAP_MIB))m")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, memory ceiling ${RMD_SERVE_MEMORY_LIMIT_MIB} MiB (+${RMD_SERVE_SWAP_MIB} MiB swap)"
  else
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, NO memory ceiling — RMD_SERVE_MEMORY_LIMIT_MIB ${RMD_SERVE_MEMORY_LIMIT_MIB} is not above the ${RMD_SERVE_MEMORY_RESERVE_MIB} MiB reserve"
  fi
  local serve_max=""
  [ "${RMD_SERVE_MEMORY_LIMIT_MIB}" -gt "${RMD_SERVE_MEMORY_RESERVE_MIB}" ] && serve_max="${RMD_SERVE_MEMORY_LIMIT_MIB}"
  resource_policy_memory_high "${RMD_SERVE_CONTAINER_NAME:-remudero-serve}" "${serve_max}"
  RESOURCE_POLICY_SERVE_HIGH_MIB="${RP_HIGH}"
  [ -n "${RP_HIGH}" ] && RESOURCE_POLICY_SERVE_ARGS+=("$(resource_policy_memory_high_arg "${RP_HIGH}")")
  RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, ${RP_HIGH_NOTE}"
  if [ -n "${RMD_SERVE_CPUS}" ]; then
    RESOURCE_POLICY_SERVE_ARGS+=("--cpus=${RMD_SERVE_CPUS}")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, cpus ${RMD_SERVE_CPUS}"
  fi
}

# A build daemon gets a low CPU weight and a memory ceiling that leaves serve's reserve and the
# host's overhead free. At the ceiling it swaps its own pages, then the kernel OOM-kills inside
# THAT container (its largest process, a test runner) — never serve.
# $1 names the container (default the core daemon): its memory.high is its own share, not a shared one.
resource_policy_build_args() {
  RESOURCE_POLICY_BUILD_ARGS=("--cpu-shares=${RMD_BUILD_CPU_SHARES}")
  local total ceiling container="${1:-remudero-daemon}"
  RP_HIGH=""
  if ! total="$(resource_policy_mem_total_mib)" || [ -z "${total}" ]; then
    RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; NO memory ceiling — host MemTotal unreadable at ${RMD_MEMINFO_PATH:-/proc/meminfo}"
    return 0
  fi
  ceiling=$((total - RMD_SERVE_MEMORY_RESERVE_MIB - RMD_HOST_OVERHEAD_MIB))
  if [ "${ceiling}" -lt "${RMD_MIN_BUILD_CEILING_MIB}" ]; then
    RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; NO memory ceiling — host ${total} MiB leaves ${ceiling} MiB after the ${RMD_SERVE_MEMORY_RESERVE_MIB} MiB serve reserve and ${RMD_HOST_OVERHEAD_MIB} MiB overhead, under the ${RMD_MIN_BUILD_CEILING_MIB} MiB floor"
    return 0
  fi
  RESOURCE_POLICY_BUILD_ARGS+=("--memory=${ceiling}m" "--memory-swap=$((ceiling + RMD_BUILD_SWAP_MIB))m")
  RESOURCE_POLICY_NOTE="build: cpu-shares ${RMD_BUILD_CPU_SHARES}; memory ceiling ${ceiling} MiB (+${RMD_BUILD_SWAP_MIB} MiB swap) = host ${total} MiB - serve reserve ${RMD_SERVE_MEMORY_RESERVE_MIB} MiB - overhead ${RMD_HOST_OVERHEAD_MIB} MiB"
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
