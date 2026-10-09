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

# ── ONE BUDGET, NOT ONE CEILING PER CONTAINER (2026-10-09) ────────────────────────────────────────
# MEASURED 2026-10-09 on the 15.6 GiB fleet host: each of the three build daemons carried memory.max
# 8.6 GiB + 4 GiB swap (each sized as "host - serve reserve - overhead" in isolation), serve 7.5 GiB —
# about 33 GiB of ceilings over 15.6 GiB of RAM, none with memory.high. Committed memory 17 GB, swap
# churn 600-2,300 pages/s (3.9 TiB in / 6.4 TiB out since boot), the core container at its limit
# 5,270 times in 47 min, 23 OOM kills since boot. A ceiling that only bites after the host is
# already swapping is no boundary at all.
#
# NOW every instance's share is carved from ONE budget: host MemTotal minus RMD_HOST_RESERVE_MIB,
# split by RMD_MEMORY_WEIGHTS, so the memory.max values sum to no more than RAM - reserve. Each gets
# a memory.high at RMD_MEMORY_HIGH_PCT of its max — the kernel throttles and reclaims the container
# there, gradually, before memory.max ever OOM-kills — and a swap allowance that is its weighted
# share of RMD_SWAP_BUDGET_PCT of the budget, not a flat 4 GiB each. serve is IN the budget, stopped
# or not, so starting it never oversubscribes the daemons' shares.
#
# memory.high HAS NO `docker run` FLAG. It rides as the OCI annotation
# org.systemd.property.MemoryHigh, which runc's systemd cgroup driver (the fleet host runs Docker 29
# with the systemd driver and runc 1.3) passes to the container's transient scope unit as the
# systemd MemoryHigh property, and systemd writes memory.high. Docker keeps it in
# HostConfig.Annotations, which is where the W1-T4267 drift check reads it back. On a cgroupfs-driver
# host the annotation is inert, and the launchers' post-start probe says so.

RMD_HOST_RESERVE_MIB="${RMD_HOST_RESERVE_MIB:-${RMD_HOST_OVERHEAD_MIB:-2048}}" # OS, cloudflared, sshd, the small daemons
# container=weight. Core runs parallel tsc/test workers (3.0-3.5 GB each) over a 2.7-4.5 GB main;
# serve 4.2-6.1 GB; console 1.1-1.5 GB; site ~1 GB (all observed 2026-10-09).
RMD_MEMORY_WEIGHTS="${RMD_MEMORY_WEIGHTS:-remudero-daemon=9 remudero-serve=7 remudero-console-daemon=3 remudero-site-daemon=2}"
RMD_MEMORY_WEIGHT_UNLISTED="${RMD_MEMORY_WEIGHT_UNLISTED:-2}" # a container not in the list is sized as one more instance
RMD_MEMORY_HIGH_PCT="${RMD_MEMORY_HIGH_PCT:-85}"
RMD_SWAP_BUDGET_PCT="${RMD_SWAP_BUDGET_PCT:-50}"
RMD_MIN_MEMORY_BUDGET_MIB="${RMD_MIN_MEMORY_BUDGET_MIB:-${RMD_MIN_BUILD_CEILING_MIB:-4096}}"
RMD_SERVE_MEMORY_RESERVE_MIB="${RMD_SERVE_MEMORY_RESERVE_MIB:-5120}" # memory.low; never above serve's memory.high
RMD_SERVE_MEMORY_LIMIT_MIB="${RMD_SERVE_MEMORY_LIMIT_MIB:-}"         # empty = serve's budget share; 0 = no ceiling; N = override
RMD_SERVE_SWAP_MIB="${RMD_SERVE_SWAP_MIB:-1024}"                     # swap with an explicit RMD_SERVE_MEMORY_LIMIT_MIB only
RMD_SERVE_CPUS="${RMD_SERVE_CPUS:-}"                                 # empty = no CPU quota, weight only
RMD_SERVE_CPU_SHARES="${RMD_SERVE_CPU_SHARES:-4096}"
RMD_BUILD_CPU_SHARES="${RMD_BUILD_CPU_SHARES:-512}"
RMD_SERVE_CONTAINER_NAME="${RMD_SERVE_CONTAINER_NAME:-remudero-serve}"
RMD_BUILD_CONTAINER_NAME="${RMD_BUILD_CONTAINER_NAME:-remudero-daemon}"

RESOURCE_POLICY_NOTE=""

resource_policy_mem_total_mib() {
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; found = 1 } END { exit found ? 0 : 1 }' \
    "${RMD_MEMINFO_PATH:-/proc/meminfo}" 2>/dev/null
}

# The weight RMD_MEMORY_WEIGHTS gives container $1, or empty when it is not listed.
resource_policy_weight_of() {
  local entry
  for entry in ${RMD_MEMORY_WEIGHTS}; do
    if [ "${entry%%=*}" = "$1" ]; then
      printf '%s' "${entry#*=}"
      return 0
    fi
  done
  return 1
}

# Container $1's share of the host budget. Sets RP_TOTAL RP_BUDGET RP_WEIGHT RP_WEIGHT_SUM RP_MAX
# RP_HIGH RP_SWAP (MiB). Returns 1 with RESOURCE_POLICY_NOTE naming why when no ceiling may be set:
# an unreadable MemTotal (a guessed ceiling could OOM a daemon that was fine) or a budget under
# RMD_MIN_MEMORY_BUDGET_MIB (a ceiling that small would be useless rather than protective).
resource_policy_budget() {
  local container="$1" entry w
  RP_TOTAL="" RP_BUDGET="" RP_WEIGHT="" RP_WEIGHT_SUM=0 RP_MAX="" RP_HIGH="" RP_SWAP="" RP_UNLISTED=0
  if ! RP_TOTAL="$(resource_policy_mem_total_mib)" || [ -z "${RP_TOTAL}" ]; then
    RESOURCE_POLICY_NOTE="NO memory ceiling — host MemTotal unreadable at ${RMD_MEMINFO_PATH:-/proc/meminfo}"
    return 1
  fi
  RP_BUDGET=$((RP_TOTAL - RMD_HOST_RESERVE_MIB))
  if [ "${RP_BUDGET}" -lt "${RMD_MIN_MEMORY_BUDGET_MIB}" ]; then
    RESOURCE_POLICY_NOTE="NO memory ceiling — host ${RP_TOTAL} MiB leaves a ${RP_BUDGET} MiB budget after the ${RMD_HOST_RESERVE_MIB} MiB host reserve, under the ${RMD_MIN_MEMORY_BUDGET_MIB} MiB floor"
    return 1
  fi
  for entry in ${RMD_MEMORY_WEIGHTS}; do
    w="${entry#*=}"
    RP_WEIGHT_SUM=$((RP_WEIGHT_SUM + w))
  done
  if ! RP_WEIGHT="$(resource_policy_weight_of "${container}")"; then
    RP_WEIGHT="${RMD_MEMORY_WEIGHT_UNLISTED}"
    RP_WEIGHT_SUM=$((RP_WEIGHT_SUM + RP_WEIGHT))
    RP_UNLISTED=1
  fi
  RP_MAX=$((RP_BUDGET * RP_WEIGHT / RP_WEIGHT_SUM))
  RP_HIGH=$((RP_MAX * RMD_MEMORY_HIGH_PCT / 100))
  RP_SWAP=$((RP_BUDGET * RMD_SWAP_BUDGET_PCT / 100 * RP_WEIGHT / RP_WEIGHT_SUM))
  return 0
}

# The docker run argument that sets memory.high to $1 MiB (see the header: an OCI annotation).
resource_policy_memory_high_arg() {
  printf -- '--annotation=org.systemd.property.MemoryHigh=uint64 %s' "$(($1 * 1024 * 1024))"
}

resource_policy_budget_note() {
  local unlisted=""
  [ "${RP_UNLISTED}" -eq 1 ] && unlisted=" (NOT in RMD_MEMORY_WEIGHTS — sized as one more instance)"
  printf 'memory.max %s MiB, memory.high %s MiB (%s%%), swap %s MiB = weight %s/%s%s of a %s MiB budget (host %s MiB - reserve %s MiB)' \
    "${RP_MAX}" "${RP_HIGH}" "${RMD_MEMORY_HIGH_PCT}" "${RP_SWAP}" "${RP_WEIGHT}" "${RP_WEIGHT_SUM}" "${unlisted}" \
    "${RP_BUDGET}" "${RP_TOTAL}" "${RMD_HOST_RESERVE_MIB}"
}

# serve gets protected memory (memory.low), a high CPU weight, and its share of the host budget.
# W1-T4102 left serve unlimited; the 2026-09-30 architecture ruling (DECISIONS) bounded it, and the
# 2026-10-09 budget sizes that bound against the other instances rather than in isolation. A
# handoff's two generations (5.28 + 1.55 GB, measured 2026-10-02) now fit in memory + swap, not in
# RAM alone: the standby pages before anything is killed. memory.low is capped at memory.high — a
# protection above the point where serve reclaims itself would be meaningless. No CPU quota by
# default: the weight already wins contention. RMD_SERVE_CPUS adds one without a code change.
resource_policy_serve_args() {
  local reserve="${RMD_SERVE_MEMORY_RESERVE_MIB}" max="" high="" swap="" how=""
  RESOURCE_POLICY_SERVE_ARGS=()
  if [ -n "${RMD_SERVE_MEMORY_LIMIT_MIB}" ]; then
    if [ "${RMD_SERVE_MEMORY_LIMIT_MIB}" -gt "${reserve}" ]; then
      max="${RMD_SERVE_MEMORY_LIMIT_MIB}" swap="${RMD_SERVE_SWAP_MIB}"
      high=$((max * RMD_MEMORY_HIGH_PCT / 100))
      how="memory.max ${max} MiB, memory.high ${high} MiB (${RMD_MEMORY_HIGH_PCT}%), swap ${swap} MiB — RMD_SERVE_MEMORY_LIMIT_MIB override, OUTSIDE the host budget"
    else
      how="NO memory ceiling — RMD_SERVE_MEMORY_LIMIT_MIB ${RMD_SERVE_MEMORY_LIMIT_MIB} is not above the ${reserve} MiB reserve"
    fi
  elif resource_policy_budget "${RMD_SERVE_CONTAINER_NAME}"; then
    max="${RP_MAX}" high="${RP_HIGH}" swap="${RP_SWAP}"
    how="$(resource_policy_budget_note)"
  else
    how="${RESOURCE_POLICY_NOTE}"
  fi
  if [ -n "${high}" ] && [ "${reserve}" -gt "${high}" ]; then reserve="${high}"; fi
  RESOURCE_POLICY_SERVE_HIGH_MIB="${high}"
  RESOURCE_POLICY_SERVE_ARGS=(
    "--memory-reservation=${reserve}m"
    "--cpu-shares=${RMD_SERVE_CPU_SHARES}"
  )
  if [ -n "${max}" ]; then
    RESOURCE_POLICY_SERVE_ARGS+=("--memory=${max}m" "--memory-swap=$((max + swap))m" "$(resource_policy_memory_high_arg "${high}")")
  fi
  RESOURCE_POLICY_NOTE="serve: memory.low ${reserve} MiB, cpu-shares ${RMD_SERVE_CPU_SHARES}, ${how}"
  if [ -n "${RMD_SERVE_CPUS}" ]; then
    RESOURCE_POLICY_SERVE_ARGS+=("--cpus=${RMD_SERVE_CPUS}")
    RESOURCE_POLICY_NOTE="${RESOURCE_POLICY_NOTE}, cpus ${RMD_SERVE_CPUS}"
  fi
}

# A build daemon ($1, its container name; default the core daemon) gets a low CPU weight and its
# share of the host budget. Past memory.high the kernel reclaims and throttles the container; at
# memory.max it swaps its own pages up to its allowance, then OOM-kills inside THAT container (its
# largest process, a test runner) — never serve, and never a neighbour's share.
resource_policy_build_args() {
  local container="${1:-${RMD_BUILD_CONTAINER_NAME}}"
  RESOURCE_POLICY_BUILD_ARGS=("--cpu-shares=${RMD_BUILD_CPU_SHARES}")
  if ! resource_policy_budget "${container}"; then
    RESOURCE_POLICY_NOTE="build ${container}: cpu-shares ${RMD_BUILD_CPU_SHARES}; ${RESOURCE_POLICY_NOTE}"
    return 0
  fi
  RESOURCE_POLICY_BUILD_ARGS+=("--memory=${RP_MAX}m" "--memory-swap=$((RP_MAX + RP_SWAP))m" "$(resource_policy_memory_high_arg "${RP_HIGH}")")
  RESOURCE_POLICY_NOTE="build ${container}: cpu-shares ${RMD_BUILD_CPU_SHARES}; $(resource_policy_budget_note)"
}

# Post-start probe: what memory.high the kernel actually holds for running container $1 against the
# $2 MiB the policy asked for. Read-only and never fatal — it exists so a silently dropped
# annotation (a cgroupfs host, a runtime that ignores it) is named in the launch log, not assumed.
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
