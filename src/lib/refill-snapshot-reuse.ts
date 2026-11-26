/**
 * lib/refill-snapshot-reuse.ts — W1-T14893: a lane refill reuses the tick read published moments ago.
 *
 * Each lane refill used to await a full tick read before choosing work, while the tick loop had published
 * one moments earlier. A refill now reuses that published snapshot when it is younger than the measured
 * median interval between the tick's own reads and no GitHub wake since says a pull request closed. Serve keeps
 * the newest such wake apart from the coalesced wake marker, so a later delivery cannot hide it. Any other case reads afresh, exactly as before.
 *
 * INVARIANT unchanged-guards: reuse only chooses which merged set the refill selects against. The dispatch
 * claim, open-PR and pushed-run-branch checks still run on every candidate, so a merge the snapshot missed
 * is still refused before a run starts.
 */
import type { Clock } from "./clock.js";

/** A GitHub wake the daemon observed: its event, its action and when serve received it. */
export interface RefillWake {
  deliveryId?: string;
  event: string;
  action?: string;
  atMs: number;
}

export type RefillReadReason = "fresh" | "no-snapshot" | "no-interval" | "stale" | "merge-wake";

export interface RefillReadDecision {
  decision: "reuse" | "read";
  reason: RefillReadReason;
  snapshotAgeMs?: number;
}

/**
 * A wake that can change what is merged: a pull request that closed. A push to a run branch needs no wake here:
 * the pushed-run-branch check refuses that candidate before a run starts.
 */
export function isMergeWake(wake: Pick<RefillWake, "event" | "action">): boolean {
  return wake.event === "pull_request" && wake.action === "closed";
}

/**
 * "reuse" when the published snapshot is younger than the measured median tick read interval and no
 * merge wake arrived after it; "read" otherwise. A missing snapshot or interval always reads.
 */
export function decideRefillRead(input: {
  snapshotAtMs: number | undefined;
  nowMs: number;
  wakesSince: readonly RefillWake[];
  readIntervalMs: number | undefined;
}): RefillReadDecision {
  const { snapshotAtMs, nowMs, wakesSince, readIntervalMs } = input;
  if (snapshotAtMs === undefined) return { decision: "read", reason: "no-snapshot" };
  const snapshotAgeMs = Math.max(0, nowMs - snapshotAtMs);
  if (readIntervalMs === undefined || !(readIntervalMs > 0)) return { decision: "read", reason: "no-interval", snapshotAgeMs };
  if (wakesSince.some((wake) => wake.atMs >= snapshotAtMs && isMergeWake(wake))) {
    return { decision: "read", reason: "merge-wake", snapshotAgeMs };
  }
  if (snapshotAgeMs >= readIntervalMs) return { decision: "read", reason: "stale", snapshotAgeMs };
  return { decision: "reuse", reason: "fresh", snapshotAgeMs };
}

/** The median gap between successive settled reads, or undefined with fewer than two. */
export function medianReadIntervalMs(settledAtMs: readonly number[]): number | undefined {
  const gaps: number[] = [];
  for (let i = 1; i < settledAtMs.length; i++) {
    const gap = settledAtMs[i]! - settledAtMs[i - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return undefined;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/** BACKSTOP: how many recent tick reads and wakes the refill reader keeps; the median needs only a handful. */
export const REFILL_READ_HISTORY = 32;

/** A wake marker as serve writes it (lib/github-event-wake.ts SweepWakeMarker), or nothing. */
type WakeMarkerLike = { deliveryId?: string; event: string; action?: string; receivedAtIso: string } | undefined;

/**
 * The refill's merged-set reader. `read` is the full tick read; `published` is the last snapshot the tick
 * published (its read start and the ids it projected as merged). The tick's own reads feed `observeRead`,
 * and every wake marker the daemon sees feeds `observeWake`.
 */
export function createRefillReader<M>(options: {
  read: (plan: M) => Promise<(id: string) => boolean>;
  published: () => { atMs: number; merged: ReadonlySet<string> } | undefined;
  clock: Clock;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** The decision the reader consults; the production refresher passes {@link decideRefillRead}. */
  decide?: typeof decideRefillRead;
}): {
  refill: (plan: M) => Promise<(id: string) => boolean>;
  observeRead: (settledAtMs: number) => void;
  observeWake: (marker: WakeMarkerLike) => void;
  readIntervalMs: () => number | undefined;
} {
  const reads: number[] = [];
  const wakes: RefillWake[] = [];
  const keep = <T>(list: T[]) => { if (list.length > REFILL_READ_HISTORY) list.splice(0, list.length - REFILL_READ_HISTORY); };
  const readIntervalMs = () => medianReadIntervalMs(reads);
  const observeWake = (marker: WakeMarkerLike) => {
    if (!marker) return;
    const atMs = Date.parse(marker.receivedAtIso);
    if (!Number.isFinite(atMs)) return;
    if (marker.deliveryId !== undefined && wakes.some((wake) => wake.deliveryId === marker.deliveryId)) return;
    wakes.push({ deliveryId: marker.deliveryId, event: marker.event, action: marker.action, atMs });
    keep(wakes);
  };
  // A read the refill itself starts publishes too; only the tick's own reads set the interval.
  let refillReadsInFlight = 0;
  return {
    observeRead: (settledAtMs) => {
      if (refillReadsInFlight > 0) return;
      reads.push(settledAtMs);
      keep(reads);
    },
    observeWake,
    readIntervalMs,
    refill: async (plan) => {
      const snapshot = options.published();
      const intervalMs = readIntervalMs();
      const decided = (options.decide ?? decideRefillRead)({ snapshotAtMs: snapshot?.atMs, nowMs: options.clock.now(), wakesSince: wakes, readIntervalMs: intervalMs });
      options.log("dispatch.refill_read", { decision: decided.decision, reason: decided.reason,
        snapshot_age_ms: decided.snapshotAgeMs ?? null, read_interval_ms: intervalMs ?? null });
      if (decided.decision === "reuse" && snapshot) {
        const merged = snapshot.merged;
        return (id) => merged.has(id);
      }
      refillReadsInFlight++;
      try {
        return await options.read(plan);
      } finally {
        refillReadsInFlight--;
      }
    },
  };
}
