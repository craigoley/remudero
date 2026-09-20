/**
 * The live half of `/v1/analytics`.
 *
 * This adapter only projects snapshots that another process-owned reader has already captured.
 * It never probes a provider, reads a credential, refreshes a queue, or writes routing policy.
 * Missing and unusable sources remain explicit; a missing number is never rewritten as zero.
 */

export interface LiveMetric {
  state: "observed" | "stale" | "unavailable" | "unreadable" | "unauthorized" | "not-probed" | "not-collected";
  value?: number;
  asOf?: string;
  reason?: string;
}

export interface LiveNotCollected {
  state: "not-collected";
  reason: string;
}

export interface LiveAnalyticsMetrics {
  queue: {
    pending: LiveMetric;
    trend: LiveNotCollected;
  };
  provider: {
    allowance: {
      remaining: LiveMetric;
      trend: LiveNotCollected;
    };
  };
}

export interface LiveStatusSnapshot {
  generated_at?: string;
  github_unreachable?: boolean;
  counts?: { queued?: number };
}

export interface LiveProviderSnapshot {
  state?: "unknown" | "not-probed" | "selected" | "blocked";
  freshness?: "fresh" | "stale" | "unknown" | "not-probed";
  reason?: string;
  observedAt?: string;
  selected?: { tightestRemainingPercent?: number };
  providers?: Array<{
    readable?: boolean;
    reason?: "capacity-unreadable" | "authentication-unavailable" | "capacity-unavailable";
    windows?: Array<{ usedPercent?: number }>;
  }>;
}

const NOT_COLLECTED_TREND: LiveNotCollected = {
  state: "not-collected",
  reason: "live-only signal; historical queue and provider trends are not collected",
};

export function emptyLiveAnalyticsMetrics(): LiveAnalyticsMetrics {
  return {
    queue: {
      pending: { state: "not-collected", reason: "no process-owned status snapshot is available" },
      trend: { ...NOT_COLLECTED_TREND },
    },
    provider: {
      allowance: {
        remaining: { state: "not-probed", reason: "no process-owned provider snapshot is available" },
        trend: { ...NOT_COLLECTED_TREND },
      },
    },
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function providerRemaining(snapshot: LiveProviderSnapshot): number | undefined {
  if (finite(snapshot.selected?.tightestRemainingPercent)) return snapshot.selected!.tightestRemainingPercent;
  const remaining = (snapshot.providers ?? [])
    .flatMap((provider) => (provider.windows ?? []).map((window) => (finite(window.usedPercent) ? 100 - window.usedPercent : undefined)))
    .filter((value): value is number => value !== undefined);
  return remaining.length > 0 ? Math.min(...remaining) : undefined;
}

function providerReason(snapshot: LiveProviderSnapshot): string | undefined {
  if (snapshot.reason) return snapshot.reason;
  const row = (snapshot.providers ?? []).find((candidate) => candidate.readable === false || candidate.reason);
  if (row?.reason === "authentication-unavailable") return "unauthorized";
  if (row?.reason === "capacity-unavailable") return "unavailable";
  if (row?.reason === "capacity-unreadable") return "unreadable";
  return undefined;
}

/**
 * Project already-captured process state into the top-level fields the console consumes.
 * `status` and `provider` are values, not readers, so calling this function is side-effect-free.
 */
export function adaptLiveAnalyticsMetrics(input: {
  status?: LiveStatusSnapshot;
  provider?: LiveProviderSnapshot;
} = {}): LiveAnalyticsMetrics {
  const metrics = emptyLiveAnalyticsMetrics();
  const status = input.status;
  if (status?.github_unreachable) {
    metrics.queue.pending = { state: "unavailable", asOf: status.generated_at, reason: "status snapshot could not read GitHub" };
  } else if (finite(status?.counts?.queued)) {
    metrics.queue.pending = { state: "observed", value: status.counts!.queued, asOf: status.generated_at };
  } else if (status) {
    metrics.queue.pending = { state: "unreadable", asOf: status.generated_at, reason: "status snapshot has no queued count" };
  }

  const provider = input.provider;
  if (!provider || provider.state === "not-probed" || provider.freshness === "not-probed") {
    metrics.provider.allowance.remaining = {
      state: "not-probed",
      asOf: provider?.observedAt,
      reason: provider ? "provider capacity was not probed" : "no process-owned provider snapshot is available",
    };
  } else if (provider.state === "unknown" || provider.freshness === "unknown") {
    const reason = providerReason(provider);
    const state = reason === "unauthorized" ? "unauthorized" : reason === "unavailable" ? "unavailable" : "unreadable";
    metrics.provider.allowance.remaining = { state, asOf: provider.observedAt, ...(reason ? { reason } : {}) };
  } else if (provider.freshness === "stale") {
    metrics.provider.allowance.remaining = { state: "stale", asOf: provider.observedAt, reason: "provider snapshot exceeded its freshness bound" };
  } else {
    const remaining = providerRemaining(provider);
    if (remaining === undefined) {
      const reason = providerReason(provider);
      const state = reason === "unauthorized" ? "unauthorized" : reason === "unavailable" ? "unavailable" : "unreadable";
      metrics.provider.allowance.remaining = { state, asOf: provider.observedAt, ...(reason ? { reason } : {}) };
    } else {
      metrics.provider.allowance.remaining = { state: "observed", value: remaining, asOf: provider.observedAt };
    }
  }
  return metrics;
}

export default adaptLiveAnalyticsMetrics;
