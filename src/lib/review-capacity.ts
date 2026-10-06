/**
 * Adaptive review admission for W1-T2853.
 *
 * This module owns decisions only. It cannot spawn, cancel, or signal a worker. The committed
 * review width remains the degraded-reading baseline; lane three must be earned from a sustained
 * healthy window, while direct pressure sheds only future admissions.
 */
import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { readProviderRoutingStatus, type ProviderRoutingStatus } from "./provider-routing-status.js";

export function initialReviewCapacityState(baseWidth: number): ReviewCapacityState {
  return { effectiveWidth: Math.max(1, Math.trunc(baseWidth)), healthySamples: 0 };
}

export interface ReviewCapacityPolicy {
  hostWorkerBudget: number;
  workerMemoryReserveMib: number;
  healthyWindowSamples: number;
  sampleCadenceMs: number;
  telemetryCadenceMs: number;
  cpuPsiLowPct: number;
  cpuPsiHighPct: number;
  memoryPsiLowPct: number;
  memoryPsiHighPct: number;
  providerAllowancePct: number;
  settlementWindowMs: number;
  unhealthySettlementThreshold: number;
  minHealthySettlements: number;
  latencyExpansionRatio: number;
}

export interface ReviewProviderCapacityObservation {
  fresh: boolean;
  readable: boolean;
  headroomPct?: number;
  reservePct?: number;
  ageMs?: number;
  /** A fresh, explicit provider-capacity refusal. Missing/stale telemetry is not a refusal. */
  refused?: boolean;
  /** The router's 60 s cache had lapsed, but the reading was recent enough to be judged fresh by
   *  {@link REVIEW_PROVIDER_READING_MAX_AGE_MS}. Diagnostic only: nothing branches on it. */
  cacheLapsed?: boolean;
}

export interface ReviewSettlementObservation {
  successes: number;
  failures: number;
  timeouts: number;
  /** Median wall time of the completed reviews in the long baseline window, EXCLUDING the recent
   *  set — so the baseline cannot chase the very samples it is compared against. */
  baselineLatencyMs?: number;
  /** Median wall time of the last {@link REVIEW_LATENCY_RECENT_SAMPLES} completions. */
  recentLatencyMs?: number;
  recentLatencySamples?: number;
  baselineLatencySamples?: number;
  /** The slowest recent review. Diagnostic only: the median above is what decides. */
  recentLatencyMaxMs?: number;
  /** The same two medians per review-size unit (1 + executed proofs). Present only when enough
   *  reviews on both sides carry a size; it can only EXCUSE a raw expansion, never create one. */
  baselineLatencyPerUnitMs?: number;
  recentLatencyPerUnitMs?: number;
}

export interface ReviewCapacityObservation {
  nowMs: number;
  queueDepth: number;
  activeWorkers: number;
  memAvailableMib?: number;
  cpuPsiSomeAvg10Pct?: number;
  /** W1-T2985 — PSI `full`: the starvation signal the CPU shed decides on. */
  cpuPsiFullAvg10Pct?: number;
  memoryPsiSomeAvg10Pct?: number;
  /** 1-minute load average and core count: attribution only (`pressureSource`), never a gate. */
  hostLoad1?: number;
  hostCpuCount?: number;
  provider: ReviewProviderCapacityObservation;
  settlements: ReviewSettlementObservation;
}

export interface ReviewCapacityState {
  effectiveWidth: number;
  healthySamples: number;
  lastHealthySampleAtMs?: number;
  lastTelemetryAtMs?: number;
  lastTelemetrySignature?: string;
}

export interface ReviewCapacityBounds {
  baseWidth: number;
  minWidth: number;
  maxWidth: number;
}

export type ReviewCapacityReason =
  | "cpu-pressure"
  | "memory-pressure"
  | "memory-reserve"
  | "provider-refused"
  | "review-unhealthy"
  | "review-latency-expanded"
  /** Reviews ran slow, but host PSI is at or below both low watermarks right now: latency is a
   *  LAGGING symptom, so it blocks the lane above base and cannot shed below base. */
  | "review-latency-uncorroborated"
  | "telemetry-unavailable"
  /** W1-T2987 — host telemetry read fine; only the PROVIDER snapshot was absent or stale. Distinct
   *  from `telemetry-unavailable`, which means the host itself could not be read. */
  | "provider-telemetry-unavailable"
  | "backlog-not-sustained"
  | "host-worker-budget"
  | "provider-headroom"
  | "review-history-insufficient"
  | "healthy-window";

export interface ReviewCapacityEvidence {
  queueDepth: number;
  effectiveWidth: number;
  minWidth: number;
  baseWidth: number;
  maxWidth: number;
  activeWorkers: number;
  healthySamples: number;
  memAvailableMib?: number;
  cpuPsiSomeAvg10Pct?: number;
  /** W1-T2985 — PSI `full`: the starvation signal the CPU shed decides on. */
  cpuPsiFullAvg10Pct?: number;
  /** W1-T3031 — which of the three host readings `hostTelemetryAvailable` conjoins were
   *  non-finite at decision time. EMPTY when telemetry was complete. Diagnostic only: nothing
   *  branches on this. */
  absentHostReadings: readonly string[];
  memoryPsiSomeAvg10Pct?: number;
  providerFresh: boolean;
  /** True when `providerFresh` was judged on the daemon's cadence after the router cache lapsed. */
  providerCacheLapsed: boolean;
  providerReadable: boolean;
  providerHeadroomPct?: number;
  providerReservePct?: number;
  providerStatusAgeMs?: number;
  reviewSuccesses: number;
  reviewFailures: number;
  reviewTimeouts: number;
  reviewBaselineLatencyMs?: number;
  reviewRecentLatencyMs?: number;
  reviewRecentLatencySamples?: number;
  reviewBaselineLatencySamples?: number;
  reviewRecentLatencyMaxMs?: number;
  reviewBaselineLatencyPerUnitMs?: number;
  reviewRecentLatencyPerUnitMs?: number;
  /** The ratio the latency arm judged: min(raw, per-unit) when per-unit is known. */
  reviewLatencyRatio?: number;
  hostLoad1?: number;
  hostCpuCount?: number;
  /** Which class of load a pressure-type decision is attributed to; undefined when none fired. */
  pressureSource?: ReviewPressureSource;
}

/** `fleet-budget`: fleet workers fill the host worker budget. `host-load`: the load average exceeds
 *  cores plus one runnable per fleet worker — load the fleet's own count does not explain (e.g. an
 *  operator's coverage run). `fleet-load`: the load is within that. `unknown`: no load reading. */
export type ReviewPressureSource = "fleet-budget" | "host-load" | "fleet-load" | "unknown";

const PRESSURE_REASONS: ReadonlySet<ReviewCapacityReason> = new Set([
  "cpu-pressure",
  "memory-pressure",
  "memory-reserve",
  "review-latency-expanded",
  "review-latency-uncorroborated",
  "host-worker-budget",
]);

/** Attribution only. Nothing branches on it: the host is shed whoever loads it. */
export function reviewPressureSource(
  observation: Pick<ReviewCapacityObservation, "activeWorkers" | "hostLoad1" | "hostCpuCount">,
  hostWorkerBudget: number,
): ReviewPressureSource {
  const active = Math.max(0, Math.trunc(observation.activeWorkers));
  if (active >= hostWorkerBudget) return "fleet-budget";
  if (!finite(observation.hostLoad1) || !finite(observation.hostCpuCount)) return "unknown";
  return observation.hostLoad1 > observation.hostCpuCount + active ? "host-load" : "fleet-load";
}

/** The latency ratio the governor judges, or undefined when there is no verdict to give. Raw and
 *  per-unit medians must BOTH have expanded: size can explain a slow window away, never invent one. */
export function reviewLatencyRatio(settlements: ReviewSettlementObservation): number | undefined {
  const { baselineLatencyMs, recentLatencyMs, baselineLatencyPerUnitMs, recentLatencyPerUnitMs } = settlements;
  if (!finite(baselineLatencyMs) || !finite(recentLatencyMs) || baselineLatencyMs <= 0) return undefined;
  const raw = recentLatencyMs / baselineLatencyMs;
  if (!finite(baselineLatencyPerUnitMs) || !finite(recentLatencyPerUnitMs) || baselineLatencyPerUnitMs <= 0) {
    return raw;
  }
  return Math.min(raw, recentLatencyPerUnitMs / baselineLatencyPerUnitMs);
}

export interface ReviewCapacityDecision {
  effectiveWidth: number;
  reason: ReviewCapacityReason;
  shouldLog: boolean;
  evidence: ReviewCapacityEvidence;
}

function clampedWidth(value: number, bounds: ReviewCapacityBounds): number {
  const min = Math.max(1, Math.trunc(bounds.minWidth));
  const max = Math.max(min, Math.trunc(bounds.maxWidth));
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** W1-T3031 — the names of whichever host readings are non-finite, in the fixed order
 *  `hostTelemetryAvailable` conjoins them. PURE, and deliberately NOT derived from that boolean:
 *  the whole defect being fixed is that one bit stood for three conditions.
 *
 *  ⚠ DIAGNOSTIC ONLY, AND THAT BOUNDARY IS THE POINT. Nothing branches on this list. It does not
 *  change `hostTelemetryAvailable`, which PSI metric gates capacity, or any width. Whether the
 *  widener should gate on cpu `full` — which the kernel documents as not meaningful at the root
 *  cgroup on some configurations — rather than `some` is a live question this makes ANSWERABLE and
 *  leaves to the operator; answering it here would be a policy change wearing an observability
 *  label. Why: 441 of 753 capacity decisions shed for a telemetry reason (measured 2026-09-07). */
export function absentHostReadings(
  observation: Pick<ReviewCapacityObservation, "memAvailableMib" | "cpuPsiFullAvg10Pct" | "memoryPsiSomeAvg10Pct">,
): readonly string[] {
  const absent: string[] = [];
  if (!finite(observation.memAvailableMib)) absent.push("mem_available_mib");
  if (!finite(observation.cpuPsiFullAvg10Pct)) absent.push("cpu_psi_full_avg10_pct");
  if (!finite(observation.memoryPsiSomeAvg10Pct)) absent.push("memory_psi_some_avg10_pct");
  return absent;
}

/** Pure controller. Direct host pressure sheds one lane per sample; sustained, PSI-corroborated
 *  review latency sheds PROPORTIONALLY to its expansion; once PSI is back at or below both low
 *  watermarks a shed width returns to base in ONE sample (the PSI band between low and high is the
 *  hysteresis). Lanes above base are still earned one at a time by a sustained healthy window. */
export function selectAdaptiveReviewWidth(
  prior: ReviewCapacityState,
  policy: ReviewCapacityPolicy,
  observation: ReviewCapacityObservation,
  bounds: ReviewCapacityBounds,
): { state: ReviewCapacityState; decision: ReviewCapacityDecision } {
  const minWidth = clampedWidth(bounds.minWidth, bounds);
  const maxWidth = clampedWidth(bounds.maxWidth, bounds);
  const baseWidth = clampedWidth(bounds.baseWidth, bounds);
  let effectiveWidth = clampedWidth(prior.effectiveWidth, bounds);
  let healthySamples = Math.max(0, Math.trunc(prior.healthySamples));
  let lastHealthySampleAtMs = prior.lastHealthySampleAtMs;
  let reason: ReviewCapacityReason = "backlog-not-sustained";

  const directPressure = (nextReason: ReviewCapacityReason): void => {
    effectiveWidth = Math.max(minWidth, effectiveWidth - 1);
    healthySamples = 0;
    lastHealthySampleAtMs = undefined;
    reason = nextReason;
  };

  const latencyRatio = reviewLatencyRatio(observation.settlements);
  const latencyExpanded = latencyRatio !== undefined && latencyRatio >= policy.latencyExpansionRatio;
  // 2026-10-06 — PSI AT OR BELOW BOTH LOW WATERMARKS, and only when both readings exist: an unread
  // PSI never counts as calm. This is the recovery condition and the latency arm's corroboration.
  const psiCalm =
    finite(observation.cpuPsiFullAvg10Pct) &&
    finite(observation.memoryPsiSomeAvg10Pct) &&
    observation.cpuPsiFullAvg10Pct <= policy.cpuPsiLowPct &&
    observation.memoryPsiSomeAvg10Pct <= policy.memoryPsiLowPct;
  // Back to base in one sample, never past what the host worker budget leaves room for, and never
  // above base: lanes above it stay earned by the healthy window below.
  const restoreBase = (): void => {
    if (!psiCalm || effectiveWidth >= baseWidth) return;
    const room = Math.trunc(policy.hostWorkerBudget) - Math.max(0, Math.trunc(observation.activeWorkers));
    effectiveWidth = Math.max(effectiveWidth, Math.min(baseWidth, room));
  };

  // W1-T2985 — DECIDE ON `full`, REPORT `some`. This read `cpuPsiSomeAvg10Pct >= cpuPsiHighPct`.
  // MEASURED on the fleet 2026-09-06, two builds and a retro running healthily: cpu `some
  // avg10=80.57` against a shed threshold of 20 and a recovery threshold of 5. Review width was
  // therefore pinned at the floor of 1 permanently and `healthySamples` reset to 0 on every sample,
  // so it could never recover — while cpu `full avg10` was 0.00, 23 GiB was free and
  // `active_workers` was 0. A bound that fires on a healthy condition is this repo's recurring
  // defect (W1-T312, W1-T380, W1-T382); here the number was not mis-sized, the SIGNAL was wrong.
  // `some` still rides along in the decision row below, where it is diagnosis rather than input.
  if (finite(observation.cpuPsiFullAvg10Pct) && observation.cpuPsiFullAvg10Pct >= policy.cpuPsiHighPct) {
    directPressure("cpu-pressure");
  } else if (
    finite(observation.memoryPsiSomeAvg10Pct) &&
    observation.memoryPsiSomeAvg10Pct >= policy.memoryPsiHighPct
  ) {
    directPressure("memory-pressure");
  } else if (finite(observation.memAvailableMib) && observation.memAvailableMib < policy.workerMemoryReserveMib) {
    directPressure("memory-reserve");
  } else if (observation.provider.fresh && observation.provider.refused === true) {
    directPressure("provider-refused");
  } else if (
    observation.settlements.failures >= policy.unhealthySettlementThreshold ||
    observation.settlements.timeouts >= policy.unhealthySettlementThreshold
  ) {
    directPressure("review-unhealthy");
  } else if (latencyExpanded && !psiCalm) {
    // MEASURED 2026-10-06 (Azure, base 4): this arm stepped 4 -> 3 -> 2 -> 1 on three samples
    // whose cpu `full` PSI read 2.18, 0.31 and 0; the third fired on reviews that had run long
    // during a load spike already gone, and recovery then took 30+ min. Latency is a lagging
    // symptom, so it sheds only while PSI still shows pressure, and PROPORTIONALLY: the target
    // is base * ratio / observed, at least one lane under base, and a sustained expansion holds
    // there instead of ratcheting a lane per sample.
    const target = Math.floor((baseWidth * policy.latencyExpansionRatio) / latencyRatio!);
    effectiveWidth = Math.min(effectiveWidth, Math.max(minWidth, Math.min(baseWidth - 1, target)));
    healthySamples = 0;
    lastHealthySampleAtMs = undefined;
    reason = "review-latency-expanded";
  } else if (observation.activeWorkers + effectiveWidth > policy.hostWorkerBudget) {
    directPressure("host-worker-budget");
  } else {
    // W1-T2987 — THE TWO TELEMETRY SOURCES ARE SEPARATE, BECAUSE THEIR ABSENCES MEAN DIFFERENT
    // THINGS. Host readings come from files that always exist; provider readings come from
    // `provider-routing-status.json`, which carries `freshUntil = observedAt + 60s` and is rewritten
    // only when a WORKER SPAWNS. During a long build nothing spawns, so it expires a minute in and
    // stays expired — and review widening then depends on a signal that only the work whose absence
    // makes widening matter can refresh. MEASURED across the ledger union: `telemetry-unavailable`
    // is the LARGEST shed reason at 347 of 670 rows, ahead of cpu-pressure's 111, with
    // `effective_width` at the floor in 310 samples against 289 at base — while the rows themselves
    // show host telemetry perfectly readable (`cpu_psi 3.16`, `mem_available_mib 26516`).
    // W1-T3031: the SAME three readings `hostTelemetryAvailable` conjoins, named individually so
    // the row can say WHICH one was absent. Derived from the observation, never from the boolean —
    // a list computed off `hostTelemetryAvailable` could only ever say "all" or "none".
    const absentReadings = absentHostReadings(observation);
    const hostTelemetryAvailable =
      finite(observation.memAvailableMib) &&
      finite(observation.cpuPsiFullAvg10Pct) &&
      finite(observation.memoryPsiSomeAvg10Pct);
    const providerTelemetryAvailable =
      observation.provider.fresh &&
      observation.provider.readable &&
      finite(observation.provider.headroomPct) &&
      finite(observation.provider.reservePct);

    if (!hostTelemetryAvailable) {
      // Unchanged: with the host unreadable nothing can be authorised, and a prior shed stands.
      effectiveWidth = Math.min(effectiveWidth, baseWidth);
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "telemetry-unavailable";
    } else if (latencyExpanded) {
      // Reached only with PSI calm (the shedding arm above took every other case).
      effectiveWidth = Math.min(effectiveWidth, baseWidth);
      restoreBase();
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "review-latency-uncorroborated";
    } else if (!providerTelemetryAvailable) {
      // HOST TELEMETRY ALONE AUTHORISES THE BASE WIDTH; the provider gates only the lane ABOVE it,
      // which policy already calls "temporary capacity earned by a sustained healthy window". The
      // old branch ran `Math.min(effectiveWidth, baseWidth)` here, and from the floor that is
      // `min(1, 2) = 1` — so a width shed for any reason could never climb back while the provider
      // snapshot was quiet, which is most of the time. Recovery stays ADDITIVE, one lane per sample,
      // and never exceeds base on this path. A provider that genuinely REFUSES is unaffected: that
      // is `directPressure("provider-refused")` above, which sheds before this branch is reached.
      effectiveWidth = Math.min(effectiveWidth + 1, baseWidth);
      restoreBase();
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "provider-telemetry-unavailable";
    } else if (observation.queueDepth <= effectiveWidth) {
      effectiveWidth = Math.min(effectiveWidth, baseWidth);
      restoreBase();
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "backlog-not-sustained";
    } else if (observation.activeWorkers + Math.min(maxWidth, effectiveWidth + 1) > policy.hostWorkerBudget) {
      restoreBase();
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "host-worker-budget";
    } else if (
      observation.cpuPsiFullAvg10Pct! > policy.cpuPsiLowPct ||
      observation.memoryPsiSomeAvg10Pct! > policy.memoryPsiLowPct
    ) {
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "backlog-not-sustained";
    } else if (
      observation.provider.headroomPct! < observation.provider.reservePct! + policy.providerAllowancePct
    ) {
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      restoreBase();
      reason = "provider-headroom";
    } else if (observation.settlements.successes < policy.minHealthySettlements) {
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      restoreBase();
      reason = "review-history-insufficient";
    } else {
      const sampleDue =
        lastHealthySampleAtMs === undefined || observation.nowMs - lastHealthySampleAtMs >= policy.sampleCadenceMs;
      if (sampleDue) {
        healthySamples = Math.min(policy.healthyWindowSamples, healthySamples + 1);
        lastHealthySampleAtMs = observation.nowMs;
      }
      if (healthySamples >= policy.healthyWindowSamples && effectiveWidth < maxWidth) {
        effectiveWidth += 1;
      }
      restoreBase();
      reason = "healthy-window";
    }
  }

  const evidence: ReviewCapacityEvidence = {
    queueDepth: Math.max(0, Math.trunc(observation.queueDepth)),
    effectiveWidth,
    minWidth,
    baseWidth,
    maxWidth,
    activeWorkers: Math.max(0, Math.trunc(observation.activeWorkers)),
    healthySamples,
    ...(finite(observation.memAvailableMib) ? { memAvailableMib: observation.memAvailableMib } : {}),
    ...(finite(observation.cpuPsiSomeAvg10Pct) ? { cpuPsiSomeAvg10Pct: observation.cpuPsiSomeAvg10Pct } : {}),
    ...(finite(observation.cpuPsiFullAvg10Pct) ? { cpuPsiFullAvg10Pct: observation.cpuPsiFullAvg10Pct } : {}),
    ...(finite(observation.memoryPsiSomeAvg10Pct) ? { memoryPsiSomeAvg10Pct: observation.memoryPsiSomeAvg10Pct } : {}),
    // W1-T3031: EMPTY on the healthy path (design iii), so a reader can filter on it directly
    // rather than having to distinguish "complete" from "not recorded".
    absentHostReadings: absentHostReadings(observation),
    providerFresh: observation.provider.fresh,
    providerCacheLapsed: observation.provider.cacheLapsed === true,
    providerReadable: observation.provider.readable,
    ...(finite(observation.provider.headroomPct) ? { providerHeadroomPct: observation.provider.headroomPct } : {}),
    ...(finite(observation.provider.reservePct) ? { providerReservePct: observation.provider.reservePct } : {}),
    ...(finite(observation.provider.ageMs) ? { providerStatusAgeMs: observation.provider.ageMs } : {}),
    reviewSuccesses: observation.settlements.successes,
    reviewFailures: observation.settlements.failures,
    reviewTimeouts: observation.settlements.timeouts,
    ...(finite(observation.settlements.baselineLatencyMs)
      ? { reviewBaselineLatencyMs: observation.settlements.baselineLatencyMs }
      : {}),
    ...(finite(observation.settlements.recentLatencyMs)
      ? { reviewRecentLatencyMs: observation.settlements.recentLatencyMs }
      : {}),
    ...(finite(observation.settlements.recentLatencySamples)
      ? { reviewRecentLatencySamples: observation.settlements.recentLatencySamples }
      : {}),
    ...(finite(observation.settlements.baselineLatencySamples)
      ? { reviewBaselineLatencySamples: observation.settlements.baselineLatencySamples }
      : {}),
    ...(finite(observation.settlements.recentLatencyMaxMs)
      ? { reviewRecentLatencyMaxMs: observation.settlements.recentLatencyMaxMs }
      : {}),
    ...(finite(observation.settlements.baselineLatencyPerUnitMs)
      ? { reviewBaselineLatencyPerUnitMs: observation.settlements.baselineLatencyPerUnitMs }
      : {}),
    ...(finite(observation.settlements.recentLatencyPerUnitMs)
      ? { reviewRecentLatencyPerUnitMs: observation.settlements.recentLatencyPerUnitMs }
      : {}),
    ...(latencyRatio !== undefined ? { reviewLatencyRatio: latencyRatio } : {}),
    ...(finite(observation.hostLoad1) ? { hostLoad1: observation.hostLoad1 } : {}),
    ...(finite(observation.hostCpuCount) ? { hostCpuCount: observation.hostCpuCount } : {}),
    ...(PRESSURE_REASONS.has(reason)
      ? { pressureSource: reviewPressureSource(observation, policy.hostWorkerBudget) }
      : {}),
  };
  const signature = `${effectiveWidth}:${reason}`;
  const shouldLog =
    prior.lastTelemetrySignature !== signature ||
    prior.lastTelemetryAtMs === undefined ||
    observation.nowMs - prior.lastTelemetryAtMs >= policy.telemetryCadenceMs;
  const state: ReviewCapacityState = {
    effectiveWidth,
    healthySamples,
    ...(lastHealthySampleAtMs !== undefined ? { lastHealthySampleAtMs } : {}),
    lastTelemetrySignature: signature,
    lastTelemetryAtMs: shouldLog ? observation.nowMs : prior.lastTelemetryAtMs,
  };
  return { state, decision: { effectiveWidth, reason, shouldLog, evidence } };
}

function parseMemAvailableMib(raw: string): number | undefined {
  const match = /^MemAvailable:\s*(\d+)\s*kB\s*$/m.exec(raw);
  return match ? Number(match[1]) / 1024 : undefined;
}

function parsePsiSomeAvg10(raw: string): number | undefined {
  const match = /^some\s+[^\n]*\bavg10=(\d+(?:\.\d+)?)\b/m.exec(raw);
  return match ? Number(match[1]) : undefined;
}

/** W1-T2985 — the FULL line. PSI `some` means "at least one task waited"; PSI `full` means "every
 *  non-idle task was stalled". On a box with more runnable threads than cores `some` is high by
 *  construction and says nothing about whether throughput is impaired, which is why it cannot
 *  decide admission. `full` is the starvation signal. MEASURED on the fleet 2026-09-06 while two
 *  builds and a retro ran healthily: cpu `some avg10=80.57`, cpu `full avg10=0.00`. */
function parsePsiFullAvg10(raw: string): number | undefined {
  const match = /^full\s+[^\n]*\bavg10=(\d+(?:\.\d+)?)\b/m.exec(raw);
  return match ? Number(match[1]) : undefined;
}

export function readReviewHostObservation(
  read: (path: string, encoding: BufferEncoding) => string = readFileSync,
  hostLoad: () => { load1: number; cpuCount: number } = () => ({ load1: loadavg()[0]!, cpuCount: cpus().length }),
): Pick<
  ReviewCapacityObservation,
  "memAvailableMib" | "cpuPsiSomeAvg10Pct" | "cpuPsiFullAvg10Pct" | "memoryPsiSomeAvg10Pct" | "hostLoad1" | "hostCpuCount"
> {
  const safeRead = (path: string): string | undefined => {
    try {
      return read(path, "utf8");
    } catch {
      // Optional telemetry read: absence/failure is carried as undefined and cannot authorise scale-up.
      return undefined;
    }
  };
  const mem = safeRead("/proc/meminfo");
  const cpuPressure = safeRead("/sys/fs/cgroup/cpu.pressure") ?? safeRead("/proc/pressure/cpu");
  const memoryPressure = safeRead("/sys/fs/cgroup/memory.pressure") ?? safeRead("/proc/pressure/memory");
  const { load1, cpuCount } = hostLoad();
  return {
    // Attribution only: a non-finite or zero reading is dropped and the source reads `unknown`.
    ...(finite(load1) ? { hostLoad1: load1 } : {}),
    ...(finite(cpuCount) && cpuCount > 0 ? { hostCpuCount: cpuCount } : {}),
    ...(mem ? { memAvailableMib: parseMemAvailableMib(mem) } : {}),
    ...(cpuPressure ? { cpuPsiSomeAvg10Pct: parsePsiSomeAvg10(cpuPressure) } : {}),
    ...(cpuPressure ? { cpuPsiFullAvg10Pct: parsePsiFullAvg10(cpuPressure) } : {}),
    ...(memoryPressure ? { memoryPsiSomeAvg10Pct: parsePsiSomeAvg10(memoryPressure) } : {}),
  };
}

/** How old a provider-routing reading may be before the review widener stops trusting it: three of
 *  the daemon's own headroom sampling intervals (`3 * HEADROOM_SAMPLE_MAX_AGE_MS`, src/lib/daemon.ts;
 *  a test pins the equality, since importing daemon.ts here would close an import ring). It is the
 *  bound #9370 gave analytics for the same file. The snapshot's `freshUntil` (observedAt + 60 s) is
 *  the ROUTER's cache validity, and the file is rewritten only when a worker spawns, so between
 *  spawns it lapses a minute in. MEASURED 2026-10-05/06: `provider-telemetry-unavailable` was the
 *  commonest `review.capacity` reason (142 of 316 rows) at provider_status_age_ms ~500-800 s, so
 *  the lane above base could almost never be earned. KIND: PRIMARY CONTROL — every sample consults
 *  it to decide whether a lapsed reading may authorise the lane above base. */
export const REVIEW_PROVIDER_READING_MAX_AGE_MS = 900_000;

export function reviewProviderObservation(status: ProviderRoutingStatus, nowMs: number): ReviewProviderCapacityObservation {
  const observedMs = status.observedAt ? Date.parse(status.observedAt) : Number.NaN;
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : undefined;
  // A lapsed BLOCKED reading stays untrusted, exactly as before: a refusal sheds only while the
  // router's own cache vouches for it, and an old refusal must not quietly authorise anything.
  const cacheLapsed =
    status.freshness === "stale" &&
    status.state !== "blocked" &&
    ageMs !== undefined &&
    ageMs <= REVIEW_PROVIDER_READING_MAX_AGE_MS;
  const fresh = status.freshness === "fresh" || cacheLapsed;
  if (!fresh) return { fresh: false, readable: false, ...(ageMs !== undefined ? { ageMs } : {}) };
  const reservePct = status.reservePercent;
  const readable = (status.providers ?? []).filter((provider) => provider.readable && provider.windows.length > 0);
  const headrooms = readable.map((provider) =>
    Math.min(...provider.windows.map((window) => 100 - window.usedPercent)),
  );
  return {
    fresh: true,
    readable: headrooms.length > 0,
    ...(headrooms.length > 0 ? { headroomPct: Math.max(...headrooms) } : {}),
    ...(finite(reservePct) ? { reservePct } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(status.state === "blocked" ? { refused: true } : {}),
    ...(cacheLapsed ? { cacheLapsed: true } : {}),
  };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle];
}

/** How many of the most recent completed reviews the latency verdict takes its median over, and
 *  the fewest either side of the comparison may hold before a verdict is given at all. A median of
 *  three cannot be moved by one review: MEASURED 2026-10-06, a single 21-minute review (PR #9702)
 *  among ~2-4 minute ones read as `recent 1,276 s` against `baseline 223 s` because the old fold
 *  took the median of TWO samples, i.e. their mean. KIND: PRIMARY CONTROL — every sample's latency
 *  verdict is the median of this many reviews. */
export const REVIEW_LATENCY_RECENT_SAMPLES = 5;
/** KIND: BACKSTOP — fewer samples than this on either side means no latency verdict at all. */
export const REVIEW_LATENCY_MIN_SAMPLES = 3;
/** The baseline looks back this many settlement windows (6 x 30 min = 3 h on the fleet), so it moves
 *  slowly: MEASURED 2026-10-06 the old in-window baseline drifted 92 s -> 223 s in 26 minutes.
 *  KIND: PRIMARY CONTROL — it sizes the population every latency verdict is compared against. */
export const REVIEW_LATENCY_BASELINE_WINDOWS = 6;

/** A review's size unit: 1 for the reviewer pass plus one per proof it executed, read from the
 *  `review.posted` row the review run already writes. Undefined when the row is absent. */
function reviewSizeUnits(line: Record<string, unknown>): number | undefined {
  if (!Array.isArray(line.proof_exec)) return undefined;
  return 1 + line.proof_exec.filter((entry) => typeof entry === "string" && entry.startsWith("executed")).length;
}

interface CompletedReview {
  latencyMs: number;
  units?: number;
}

/** The median per size unit over `reviews`, or undefined when too few carry a size. */
function medianPerUnit(reviews: readonly CompletedReview[]): number | undefined {
  const sized = reviews.filter((review) => review.units !== undefined);
  if (sized.length < REVIEW_LATENCY_MIN_SAMPLES) return undefined;
  return median(sized.map((review) => review.latencyMs / review.units!));
}

/** Fold the reviewer outcome window already present in the sweep's ledger read. Successes, failures
 *  and timeouts count the settlement window; latency compares the median of the last
 *  {@link REVIEW_LATENCY_RECENT_SAMPLES} completions with the median of the OTHER completions in a
 *  window {@link REVIEW_LATENCY_BASELINE_WINDOWS} times longer. */
export function summarizeReviewSettlements(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  windowMs: number,
): ReviewSettlementObservation {
  const cutoff = nowMs - windowMs;
  const baselineCutoff = nowMs - windowMs * REVIEW_LATENCY_BASELINE_WINDOWS;
  const attempts = new Map<string, number>();
  const unitsBySha = new Map<string, number>();
  const completed: Array<CompletedReview & { tsMs: number }> = [];
  let successes = 0;
  let failures = 0;
  let timeouts = 0;
  const recent = lines
    .map((line) => ({ line, tsMs: typeof line.ts === "string" ? Date.parse(line.ts) : Number.NaN }))
    .filter(({ tsMs }) => Number.isFinite(tsMs) && tsMs >= baselineCutoff && tsMs <= nowMs)
    .sort((a, b) => a.tsMs - b.tsMs);
  for (const { line, tsMs } of recent) {
    const key = `${String(line.pr_number ?? "")}:${String(line.head_sha ?? "")}`;
    const inWindow = tsMs >= cutoff;
    if (line.step === "sweep.post_review.attempt") {
      attempts.set(key, tsMs);
    } else if (line.step === "review.posted") {
      const units = reviewSizeUnits(line);
      if (units !== undefined && typeof line.head_sha === "string") unitsBySha.set(line.head_sha, units);
    } else if (line.step === "sweep.post_review.done") {
      if (inWindow) successes += 1;
      const startedAt = attempts.get(key);
      if (startedAt !== undefined && tsMs >= startedAt) {
        const units = typeof line.head_sha === "string" ? unitsBySha.get(line.head_sha) : undefined;
        completed.push({ latencyMs: tsMs - startedAt, tsMs, ...(units !== undefined ? { units } : {}) });
      }
      attempts.delete(key);
    } else if (line.step === "sweep.post_review.failed") {
      if (inWindow) {
        failures += 1;
        if (/timeout|timed out|abandon/i.test(String(line.error ?? ""))) timeouts += 1;
      }
      attempts.delete(key);
    }
  }
  // The recent set is drawn from the settlement window only: a slow spell that has stopped
  // completing reviews must not keep speaking for the present.
  const recentSet = completed.filter((review) => review.tsMs >= cutoff).slice(-REVIEW_LATENCY_RECENT_SAMPLES);
  const baselineSet = completed.slice(0, completed.length - recentSet.length);
  const verdict = recentSet.length >= REVIEW_LATENCY_MIN_SAMPLES && baselineSet.length >= REVIEW_LATENCY_MIN_SAMPLES;
  const baselinePerUnit = verdict ? medianPerUnit(baselineSet) : undefined;
  const recentPerUnit = verdict ? medianPerUnit(recentSet) : undefined;
  return {
    successes,
    failures,
    timeouts,
    ...(verdict
      ? {
          baselineLatencyMs: median(baselineSet.map((review) => review.latencyMs)),
          recentLatencyMs: median(recentSet.map((review) => review.latencyMs)),
          recentLatencySamples: recentSet.length,
          baselineLatencySamples: baselineSet.length,
          recentLatencyMaxMs: Math.max(...recentSet.map((review) => review.latencyMs)),
        }
      : {}),
    ...(baselinePerUnit !== undefined && recentPerUnit !== undefined
      ? { baselineLatencyPerUnitMs: baselinePerUnit, recentLatencyPerUnitMs: recentPerUnit }
      : {}),
  };
}

const runtimeStates = new Map<string, ReviewCapacityState>();

export interface RuntimeReviewCapacityInput extends ReviewCapacityBounds {
  root: string;
  queueDepth: number;
  activeWorkers: number;
  nowMs: number;
  ledgerLines: ReadonlyArray<Record<string, unknown>>;
  policy: ReviewCapacityPolicy;
  log: (step: string, extra?: Record<string, unknown>) => void;
}

/** Production adapter. It reads only local host files and the age-bounded provider snapshot. */
export function selectRuntimeReviewWidth(input: RuntimeReviewCapacityInput): number {
  const prior = runtimeStates.get(input.root) ?? initialReviewCapacityState(input.baseWidth);
  const providerStatus = readProviderRoutingStatus(input.root, { now: () => input.nowMs });
  const observation: ReviewCapacityObservation = {
    nowMs: input.nowMs,
    queueDepth: input.queueDepth,
    activeWorkers: input.activeWorkers,
    ...readReviewHostObservation(),
    provider: reviewProviderObservation(providerStatus, input.nowMs),
    settlements: summarizeReviewSettlements(input.ledgerLines, input.nowMs, input.policy.settlementWindowMs),
  };
  const result = selectAdaptiveReviewWidth(prior, input.policy, observation, input);
  runtimeStates.set(input.root, result.state);
  if (result.decision.shouldLog) {
    input.log("review.capacity", {
      reason: result.decision.reason,
      queue_depth: result.decision.evidence.queueDepth,
      effective_width: result.decision.evidence.effectiveWidth,
      min_width: result.decision.evidence.minWidth,
      base_width: result.decision.evidence.baseWidth,
      max_width: result.decision.evidence.maxWidth,
      active_workers: result.decision.evidence.activeWorkers,
      healthy_samples: result.decision.evidence.healthySamples,
      mem_available_mib: result.decision.evidence.memAvailableMib ?? null,
      cpu_psi_some_avg10_pct: result.decision.evidence.cpuPsiSomeAvg10Pct ?? null,
      memory_psi_some_avg10_pct: result.decision.evidence.memoryPsiSomeAvg10Pct ?? null,
      // W1-T3031 — THE FIELD THE DECISION ACTUALLY GATES ON. `hostTelemetryAvailable` requires
      // `cpuPsiFullAvg10Pct` to be finite, and until this line the row recorded only the `some`
      // metric — so the largest shed reason in the fleet (`telemetry-unavailable`, 349 of 753
      // decisions measured 2026-09-07) could not be diagnosed from its own row. `some` is KEPT
      // beside it: the `cpu-pressure` arm still consults it, and dropping it would trade one blind
      // spot for another.
      cpu_psi_full_avg10_pct: result.decision.evidence.cpuPsiFullAvg10Pct ?? null,
      // Which host readings were non-finite. Empty whenever telemetry was complete.
      telemetry_absent: result.decision.evidence.absentHostReadings,
      provider_fresh: result.decision.evidence.providerFresh,
      provider_cache_lapsed: result.decision.evidence.providerCacheLapsed,
      provider_readable: result.decision.evidence.providerReadable,
      provider_headroom_pct: result.decision.evidence.providerHeadroomPct ?? null,
      provider_reserve_pct: result.decision.evidence.providerReservePct ?? null,
      provider_status_age_ms: result.decision.evidence.providerStatusAgeMs ?? null,
      review_successes: result.decision.evidence.reviewSuccesses,
      review_failures: result.decision.evidence.reviewFailures,
      review_timeouts: result.decision.evidence.reviewTimeouts,
      review_baseline_latency_ms: result.decision.evidence.reviewBaselineLatencyMs ?? null,
      review_recent_latency_ms: result.decision.evidence.reviewRecentLatencyMs ?? null,
      // 2026-10-06 — the robust latency verdict's own inputs, so a host reading can prove it.
      review_recent_latency_samples: result.decision.evidence.reviewRecentLatencySamples ?? null,
      review_baseline_latency_samples: result.decision.evidence.reviewBaselineLatencySamples ?? null,
      review_recent_latency_max_ms: result.decision.evidence.reviewRecentLatencyMaxMs ?? null,
      review_baseline_latency_per_unit_ms: result.decision.evidence.reviewBaselineLatencyPerUnitMs ?? null,
      review_recent_latency_per_unit_ms: result.decision.evidence.reviewRecentLatencyPerUnitMs ?? null,
      review_latency_ratio: result.decision.evidence.reviewLatencyRatio ?? null,
      host_load1: result.decision.evidence.hostLoad1 ?? null,
      host_cpu_count: result.decision.evidence.hostCpuCount ?? null,
      pressure_source: result.decision.evidence.pressureSource ?? null,
    });
  }
  return result.decision.effectiveWidth;
}
