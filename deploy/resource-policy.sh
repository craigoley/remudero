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

RMD_SERVE_MEMORY_RESERVE_MIB="${RMD_SERVE_MEMORY_RESERVE_MIB:-1536}" # serve's measured RSS is 1.0-1.2 GiB
RMD_HOST_OVERHEAD_MIB="${RMD_HOST_OVERHEAD_MIB:-2048}"               # OS, cloudflared, the small daemons
RMD_BUILD_SWAP_MIB="${RMD_BUILD_SWAP_MIB:-4096}"                     # a build container pages its OWN memory
RMD_MIN_BUILD_CEILING_MIB="${RMD_MIN_BUILD_CEILING_MIB:-2048}"
RMD_SERVE_CPU_SHARES="${RMD_SERVE_CPU_SHARES:-4096}"
RMD_BUILD_CPU_SHARES="${RMD_BUILD_CPU_SHARES:-512}"

RESOURCE_POLICY_NOTE=""

resource_policy_mem_total_mib() {
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; found = 1 } END { exit found ? 0 : 1 }' \
    "${RMD_MEMINFO_PATH:-/proc/meminfo}" 2>/dev/null
}

# serve gets protected memory (memory.low) and a high CPU weight, and NO hard memory limit: an
# OOM-killed console backend is worse than a slow one.
resource_policy_serve_args() {
  RESOURCE_POLICY_SERVE_ARGS=(
    "--memory-reservation=${RMD_SERVE_MEMORY_RESERVE_MIB}m"
    "--cpu-shares=${RMD_SERVE_CPU_SHARES}"
  )
  RESOURCE_POLICY_NOTE="serve: memory.low ${RMD_SERVE_MEMORY_RESERVE_MIB} MiB, cpu-shares ${RMD_SERVE_CPU_SHARES}"
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
