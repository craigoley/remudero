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
    /** W1-T4024 — every subscription window the daemon last observed, per provider. */
    accounts: LiveProviderAccounts;
  };
}

/**
 * W1-T4024 — ONE SUBSCRIPTION WINDOW, AS THE DAEMON LAST OBSERVED IT. `usedPercent` and
 * `remainingPercent` are ABSENT, never 0 or 100, when the reading carried no finite figure: a
 * missing number drawn as "empty" or "full" is the reading this repo has already paid for (W1-T3755).
 */
export interface LiveProviderWindow {
  name: string;
  usedPercent?: number;
  remainingPercent?: number;
  /** ISO instant the window refills. A numeric `resetsAt` is omitted rather than guessed at, because
   *  the capacity readers do not agree on seconds versus milliseconds. */
  resetsAt?: string;
}

export interface LiveProviderAccount {
  provider: string;
  /** Present only when the snapshot carried one. Codex readings carry none today; it is never invented. */
  accountLabel?: string;
  readable: boolean;
  reason?: string;
  windows: LiveProviderWindow[];
}

export interface LiveProviderAccounts {
  state: LiveMetric["state"];
  asOf?: string;
  reason?: string;
  accounts: LiveProviderAccount[];
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
    provider?: string;
    accountLabel?: string;
    readable?: boolean;
    reason?: "capacity-unreadable" | "authentication-unavailable" | "capacity-unavailable";
    windows?: Array<{ name?: string; usedPercent?: number; resetsAt?: string | number }>;
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
      accounts: { state: "not-probed", reason: "no process-owned provider snapshot is available", accounts: [] },
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
  metrics.provider.accounts = providerAccounts(input.provider);
  return metrics;
}

/**
 * W1-T4024 — EVERY PROVIDER'S WINDOWS, NOT THE SELECTED PROVIDER'S TIGHTEST ONE.
 *
 * `allowance.remaining` answers one question — how much room does the lane the router just picked
 * have — and returns `selected.tightestRemainingPercent`. Measured 2026-09-22 against the live
 * snapshot it read 58 (claude's weekly window) while codex sat at 70% used; codex appeared nowhere,
 * so the console overstated headroom and named no lane. That scalar is unchanged here because routing
 * and existing consumers read it. This adds the per-provider view beside it, projected from the SAME
 * already-captured snapshot: no provider probe and no credential read.
 */
function providerAccounts(snapshot: LiveProviderSnapshot | undefined): LiveProviderAccounts {
  if (!snapshot || snapshot.state === "not-probed" || snapshot.freshness === "not-probed") {
    return {
      state: "not-probed",
      ...(snapshot?.observedAt ? { asOf: snapshot.observedAt } : {}),
      reason: snapshot ? "provider capacity was not probed" : "no process-owned provider snapshot is available",
      accounts: [],
    };
  }
  const accounts: LiveProviderAccount[] = [];
  for (const entry of snapshot.providers ?? []) {
    const provider = typeof entry.provider === "string" && entry.provider.length > 0 ? entry.provider : undefined;
    if (!provider) continue;
    const windows: LiveProviderWindow[] = [];
    for (const window of entry.windows ?? []) {
      const name = typeof window.name === "string" && window.name.length > 0 ? window.name : undefined;
      if (!name) continue;
      const resetsAt = typeof window.resetsAt === "string" && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : undefined;
      windows.push({
        name,
        ...(finite(window.usedPercent) ? { usedPercent: window.usedPercent, remainingPercent: Math.max(0, 100 - window.usedPercent) } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
    accounts.push({
      provider,
      ...(typeof entry.accountLabel === "string" && entry.accountLabel.length > 0 ? { accountLabel: entry.accountLabel } : {}),
      readable: entry.readable === true,
      ...(entry.reason ? { reason: entry.reason } : {}),
      windows,
    });
  }
  const unreadable = snapshot.state === "unknown" || snapshot.freshness === "unknown";
  const state: LiveMetric["state"] = snapshot.freshness === "stale" ? "stale" : unreadable ? "unreadable" : "observed";
  return {
    state,
    ...(snapshot.observedAt ? { asOf: snapshot.observedAt } : {}),
    ...(state === "stale" ? { reason: "provider snapshot exceeded its freshness bound" } : {}),
    ...(state === "unreadable" ? { reason: providerReason(snapshot) ?? "provider snapshot is unreadable" } : {}),
    accounts,
  };
}

export default adaptLiveAnalyticsMetrics;
