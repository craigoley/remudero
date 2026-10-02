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

RESOURCE_POLICY_NOTE=""

resource_policy_mem_total_mib() {
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; found = 1 } END { exit found ? 0 : 1 }' \
    "${RMD_MEMINFO_PATH:-/proc/meminfo}" 2>/dev/null
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
  if [ -n "${RMD_SERVE_CPUS}" ]; then
    RESOURCE_POLICY_SERVE_ARGS+=("--cpus=${RMD_SERVE_CPUS}")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, cpus ${RMD_SERVE_CPUS}"
  fi
}

# A build daemon gets a low CPU weight and a memory ceiling that leaves serve's reserve and the
# host's overhead free. At the ceiling it swaps its own pages, then the kernel OOM-kills inside
# THAT container (its largest process, a test runner) — never serve.
resource_policy_build_args() {
  RESOURCE_POLICY_BUILD_ARGS=("--cpu-shares=${RMD_BUILD_CPU_SHARES}")
  local total ceiling
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
}
