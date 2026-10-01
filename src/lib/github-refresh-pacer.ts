// Keeps GitHub facts warm with no viewer, paced by the quota that remains (operator ruling
// 2026-09-30, amending W1-T154's zero-viewer gate; see DECISIONS.md).
//
// The pace has no hard threshold. Each term is derived from a measured input:
//   - freshness: refresh so the facts settle again one walk before the target runs out (the
//     next walk may take as long as the last), and twice as often while a reader is active;
//   - quota: per bucket a refresh spends from, take a share of the sustainable rate equal to
//     the headroom fraction, so the interval grows with the square of the shrinking headroom
//     and passes the reset (a pause) when one refresh costs more than that share allows;
//   - secondary: a rate-limited refresh backs off on the transport's own refusal floor,
//     doubling per consecutive refusal.
// The module owns no GitHub call. Serve runs it, or the read-model worker does when switches.json
// reads `"github": "worker"` (read-model-worker.ts hands exactly one of them the gateway).
import { DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS, type GhRateLimitReading } from "./github-transport.js";
import { systemClock, type Clock } from "./clock.js";
import type { SseRoute } from "./service.js";

/** What one bucket was charged by a refresh, with the latest metered reading of that bucket. */
export interface RefreshSpend {
  resource: string;
  calls: number;
  reading?: GhRateLimitReading;
}

/** One settled refresh. `seq` grows by one per settle, so a caller counts each refresh once. */
export interface WarmRefreshOutcome {
  seq: number;
  settledAtMs: number;
  durationMs: number;
  spend: RefreshSpend[];
  rateLimited: boolean;
  failed: boolean;
}

export interface WarmRefreshTelemetry {
  inFlight: boolean;
  last?: WarmRefreshOutcome;
}

export type RefreshPaceReason = "first" | "freshness" | "quota" | "exhausted" | "secondary";

export interface RefreshPace {
  delayMs: number;
  intervalMs: number;
  paused: boolean;
  reason: RefreshPaceReason;
  headroom?: number;
}

export function readerActivity(nowMs: number, targetFreshnessMs: number, subscribers: number, lastReadAtMs: number | undefined): number {
  if (subscribers > 0) return 1;
  if (lastReadAtMs === undefined) return 0;
  return Math.exp(-Math.max(0, nowMs - lastReadAtMs) / Math.max(1, targetFreshnessMs));
}

export function refreshPace(input: {
  nowMs: number;
  targetFreshnessMs: number;
  anchorMs?: number;
  last?: Pick<WarmRefreshOutcome, "durationMs" | "rateLimited" | "spend">;
  readerActivity: number;
  consecutiveRateLimited: number;
}): RefreshPace {
  if (input.anchorMs === undefined || !input.last) return { delayMs: 0, intervalMs: 0, paused: false, reason: "first" };
  const speed = 1 + Math.min(1, Math.max(0, input.readerActivity));
  let intervalMs = Math.max(0, input.targetFreshnessMs - 2 * input.last.durationMs) / speed;
  let reason: RefreshPaceReason = "freshness";
  let paused = false;
  let headroom: number | undefined;
  for (const spend of input.last.spend) {
    const r = spend.reading;
    if (spend.calls <= 0 || r?.remaining === undefined || !r.limit || r.reset === undefined) continue;
    const resetInMs = r.reset * 1000 - input.nowMs;
    if (resetInMs <= 0) continue;
    const fraction = Math.max(0, r.remaining) / r.limit;
    headroom = Math.min(headroom ?? 1, fraction);
    const untilResetMs = r.reset * 1000 - input.anchorMs;
    const quotaMs = r.remaining <= 0 ? Infinity : (spend.calls * resetInMs) / (Math.min(1, fraction * speed) * r.remaining);
    if (quotaMs >= resetInMs) {
      paused = true;
      reason = r.remaining <= 0 ? "exhausted" : "quota";
      intervalMs = Math.max(intervalMs, untilResetMs);
    } else if (!paused && quotaMs > intervalMs) {
      intervalMs = quotaMs;
      reason = "quota";
    }
  }
  if (input.last.rateLimited && input.consecutiveRateLimited > 0) {
    const backoffMs = DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS * 2 ** (input.consecutiveRateLimited - 1);
    if (backoffMs > intervalMs) {
      intervalMs = backoffMs;
      reason = "secondary";
    }
  }
  return { delayMs: Math.max(0, input.anchorMs + intervalMs - input.nowMs), intervalMs, paused, reason, headroom };
}

/** The rollup is one ledger row per window, counted, never one row per call. */
export const KEEP_WARM_ROLLUP_MS = 60 * 60 * 1000;

interface KeepWarmCounts {
  refreshes: number;
  calls: number;
  failed: number;
  rate_limited: number;
  reader_activity_sum: number;
  paused_checks: number;
  min_headroom?: number;
  calls_by_resource: Record<string, number>;
}

function emptyCounts(): KeepWarmCounts {
  return { refreshes: 0, calls: 0, failed: 0, rate_limited: 0, reader_activity_sum: 0, paused_checks: 0, calls_by_resource: {} };
}

export interface GithubKeepWarm {
  start(): void;
  stop(): void;
  noteRead(): void;
  gate(route: SseRoute): { route: SseRoute; stop: () => void; noteRead: () => void };
  pace(): RefreshPace;
}

export function createGithubKeepWarm(opts: {
  refresh: () => void;
  telemetry: () => WarmRefreshTelemetry | undefined;
  targetFreshnessMs: number;
  clock?: Clock;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  rollupMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}): GithubKeepWarm {
  const clock = opts.clock ?? systemClock;
  const setTimer = opts.setTimeout ?? setTimeout;
  const clearTimer = opts.clearTimeout ?? clearTimeout;
  const rollupMs = opts.rollupMs ?? KEEP_WARM_ROLLUP_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rollupTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let subscribers = 0;
  let lastReadAtMs: number | undefined;
  let lastSeq: number | undefined;
  let last: WarmRefreshOutcome | undefined;
  let requestedAtMs: number | undefined;
  let consecutiveRateLimited = 0;
  let counts = emptyCounts();
  let windowStart = clock.iso();

  const absorb = (): WarmRefreshTelemetry | undefined => {
    const t = opts.telemetry();
    const outcome = t?.last;
    if (outcome && outcome.seq !== lastSeq) {
      lastSeq = outcome.seq;
      last = outcome;
      consecutiveRateLimited = outcome.rateLimited ? consecutiveRateLimited + 1 : 0;
      counts.refreshes += 1;
      if (outcome.failed) counts.failed += 1;
      if (outcome.rateLimited) counts.rate_limited += 1;
      for (const spend of outcome.spend) {
        counts.calls += spend.calls;
        counts.calls_by_resource[spend.resource] = (counts.calls_by_resource[spend.resource] ?? 0) + spend.calls;
      }
    }
    return t;
  };

  const activity = (): number => readerActivity(clock.now(), opts.targetFreshnessMs, subscribers, lastReadAtMs);

  const pace = (): RefreshPace => {
    const anchors = [last?.settledAtMs, requestedAtMs].filter((v): v is number => v !== undefined);
    return refreshPace({
      nowMs: clock.now(),
      targetFreshnessMs: opts.targetFreshnessMs,
      anchorMs: anchors.length > 0 ? Math.max(...anchors) : undefined,
      last,
      readerActivity: activity(),
      consecutiveRateLimited,
    });
  };

  const schedule = (ms: number): void => {
    if (!running) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(tick, Math.max(0, ms));
    timer.unref?.();
  };

  function tick(): void {
    timer = undefined;
    const t = absorb();
    const walkMs = last?.durationMs || opts.targetFreshnessMs / 10;
    if (t?.inFlight) return schedule(walkMs);
    const p = pace();
    if (p.headroom !== undefined) counts.min_headroom = Math.min(counts.min_headroom ?? 1, p.headroom);
    if (p.paused) counts.paused_checks += 1;
    if (p.delayMs > 0) return schedule(p.delayMs);
    requestedAtMs = clock.now();
    counts.reader_activity_sum += activity();
    opts.refresh();
    schedule(walkMs);
  }

  const flush = (): void => {
    absorb();
    const end = clock.iso();
    if (counts.refreshes > 0 || counts.paused_checks > 0) {
      const p = pace();
      opts.log?.("github.keep_warm.rollup", {
        window_start: windowStart,
        window_end: end,
        ...counts,
        reader_activity_sum: Math.round(counts.reader_activity_sum * 100) / 100,
        interval_ms: Math.round(p.intervalMs),
        reason: p.reason,
      });
      counts = emptyCounts();
    }
    windowStart = end;
  };

  const scheduleRollup = (): void => {
    rollupTimer = setTimer(() => {
      flush();
      scheduleRollup();
    }, rollupMs);
    rollupTimer.unref?.();
  };

  const noteRead = (): void => {
    lastReadAtMs = clock.now();
    if (running) schedule(0);
  };

  const keepWarm: GithubKeepWarm = {
    start() {
      if (running) return;
      running = true;
      windowStart = clock.iso();
      // A walk the other keep-warm counted before a handover paces this one but is never counted twice.
      const held = opts.telemetry()?.last;
      if (held && held.seq !== lastSeq) {
        lastSeq = held.seq;
        last = held;
        if (held.rateLimited) consecutiveRateLimited = Math.max(1, consecutiveRateLimited);
      }
      schedule(0);
      scheduleRollup();
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== undefined) clearTimer(timer);
      if (rollupTimer !== undefined) clearTimer(rollupTimer);
      timer = undefined;
      rollupTimer = undefined;
      flush();
    },
    noteRead,
    pace,
    gate(route) {
      return {
        stop: () => keepWarm.stop(),
        noteRead,
        route: {
          ...route,
          subscribe: (send, req) => {
            const unsubscribe = route.subscribe(send, req);
            subscribers += 1;
            if (subscribers === 1 && running) schedule(0);
            let released = false;
            return () => {
              if (released) return;
              released = true;
              unsubscribe();
              subscribers -= 1;
            };
          },
        },
      };
    },
  };
  return keepWarm;
}
