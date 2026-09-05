/**
 * Adaptive review admission for W1-T2853.
 *
 * This module owns decisions only. It cannot spawn, cancel, or signal a worker. The committed
 * review width remains the degraded-reading baseline; lane three must be earned from a sustained
 * healthy window, while direct pressure sheds only future admissions.
 */
import { readFileSync } from "node:fs";
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
}

export interface ReviewSettlementObservation {
  successes: number;
  failures: number;
  timeouts: number;
  baselineLatencyMs?: number;
  recentLatencyMs?: number;
}

export interface ReviewCapacityObservation {
  nowMs: number;
  queueDepth: number;
  activeWorkers: number;
  memAvailableMib?: number;
  cpuPsiSomeAvg10Pct?: number;
  memoryPsiSomeAvg10Pct?: number;
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
  | "telemetry-unavailable"
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
  memoryPsiSomeAvg10Pct?: number;
  providerFresh: boolean;
  providerReadable: boolean;
  providerHeadroomPct?: number;
  providerReservePct?: number;
  providerStatusAgeMs?: number;
  reviewSuccesses: number;
  reviewFailures: number;
  reviewTimeouts: number;
  reviewBaselineLatencyMs?: number;
  reviewRecentLatencyMs?: number;
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

/** Pure AIMD-like controller: additive recovery after hysteresis, one-lane decrease on pressure. */
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

  const latencyExpanded =
    finite(observation.settlements.baselineLatencyMs) &&
    finite(observation.settlements.recentLatencyMs) &&
    observation.settlements.baselineLatencyMs > 0 &&
    observation.settlements.recentLatencyMs / observation.settlements.baselineLatencyMs >= policy.latencyExpansionRatio;

  if (finite(observation.cpuPsiSomeAvg10Pct) && observation.cpuPsiSomeAvg10Pct >= policy.cpuPsiHighPct) {
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
  } else if (latencyExpanded) {
    directPressure("review-latency-expanded");
  } else if (observation.activeWorkers + effectiveWidth > policy.hostWorkerBudget) {
    directPressure("host-worker-budget");
  } else {
    const telemetryAvailable =
      finite(observation.memAvailableMib) &&
      finite(observation.cpuPsiSomeAvg10Pct) &&
      finite(observation.memoryPsiSomeAvg10Pct) &&
      observation.provider.fresh &&
      observation.provider.readable &&
      finite(observation.provider.headroomPct) &&
      finite(observation.provider.reservePct);

    if (!telemetryAvailable) {
      effectiveWidth = Math.min(effectiveWidth, baseWidth);
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "telemetry-unavailable";
    } else if (observation.queueDepth <= effectiveWidth) {
      effectiveWidth = Math.min(effectiveWidth, baseWidth);
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "backlog-not-sustained";
    } else if (observation.activeWorkers + Math.min(maxWidth, effectiveWidth + 1) > policy.hostWorkerBudget) {
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
      reason = "host-worker-budget";
    } else if (
      observation.cpuPsiSomeAvg10Pct! > policy.cpuPsiLowPct ||
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
      reason = "provider-headroom";
    } else if (observation.settlements.successes < policy.minHealthySettlements) {
      healthySamples = 0;
      lastHealthySampleAtMs = undefined;
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
    ...(finite(observation.memoryPsiSomeAvg10Pct) ? { memoryPsiSomeAvg10Pct: observation.memoryPsiSomeAvg10Pct } : {}),
    providerFresh: observation.provider.fresh,
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

export function readReviewHostObservation(
  read: (path: string, encoding: BufferEncoding) => string = readFileSync,
): Pick<ReviewCapacityObservation, "memAvailableMib" | "cpuPsiSomeAvg10Pct" | "memoryPsiSomeAvg10Pct"> {
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
  return {
    ...(mem ? { memAvailableMib: parseMemAvailableMib(mem) } : {}),
    ...(cpuPressure ? { cpuPsiSomeAvg10Pct: parsePsiSomeAvg10(cpuPressure) } : {}),
    ...(memoryPressure ? { memoryPsiSomeAvg10Pct: parsePsiSomeAvg10(memoryPressure) } : {}),
  };
}

export function reviewProviderObservation(status: ProviderRoutingStatus, nowMs: number): ReviewProviderCapacityObservation {
  const observedMs = status.observedAt ? Date.parse(status.observedAt) : Number.NaN;
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : undefined;
  const fresh = status.freshness === "fresh";
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
  };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle];
}

/** Fold the bounded recent reviewer outcome window already present in the sweep's ledger read. */
export function summarizeReviewSettlements(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  windowMs: number,
): ReviewSettlementObservation {
  const cutoff = nowMs - windowMs;
  const attempts = new Map<string, number>();
  const latencies: number[] = [];
  let successes = 0;
  let failures = 0;
  let timeouts = 0;
  const recent = lines
    .map((line) => ({ line, tsMs: typeof line.ts === "string" ? Date.parse(line.ts) : Number.NaN }))
    .filter(({ tsMs }) => Number.isFinite(tsMs) && tsMs >= cutoff && tsMs <= nowMs)
    .sort((a, b) => a.tsMs - b.tsMs);
  for (const { line, tsMs } of recent) {
    const key = `${String(line.pr_number ?? "")}:${String(line.head_sha ?? "")}`;
    if (line.step === "sweep.post_review.attempt") {
      attempts.set(key, tsMs);
    } else if (line.step === "sweep.post_review.done") {
      successes += 1;
      const startedAt = attempts.get(key);
      if (startedAt !== undefined && tsMs >= startedAt) latencies.push(tsMs - startedAt);
      attempts.delete(key);
    } else if (line.step === "sweep.post_review.failed") {
      failures += 1;
      if (/timeout|timed out|abandon/i.test(String(line.error ?? ""))) timeouts += 1;
      attempts.delete(key);
    }
  }
  const half = Math.floor(latencies.length / 2);
  return {
    successes,
    failures,
    timeouts,
    ...(latencies.length >= 4
      ? { baselineLatencyMs: median(latencies.slice(0, half)), recentLatencyMs: median(latencies.slice(half)) }
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
      provider_fresh: result.decision.evidence.providerFresh,
      provider_readable: result.decision.evidence.providerReadable,
      provider_headroom_pct: result.decision.evidence.providerHeadroomPct ?? null,
      provider_reserve_pct: result.decision.evidence.providerReservePct ?? null,
      provider_status_age_ms: result.decision.evidence.providerStatusAgeMs ?? null,
      review_successes: result.decision.evidence.reviewSuccesses,
      review_failures: result.decision.evidence.reviewFailures,
      review_timeouts: result.decision.evidence.reviewTimeouts,
      review_baseline_latency_ms: result.decision.evidence.reviewBaselineLatencyMs ?? null,
      review_recent_latency_ms: result.decision.evidence.reviewRecentLatencyMs ?? null,
    });
  }
  return result.decision.effectiveWidth;
}
