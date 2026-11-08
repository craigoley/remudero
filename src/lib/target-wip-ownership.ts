/**
 * A managed target's open-PR ownership, read so one refused read never ends the daemon.
 *
 * 2026-11-07: #17144 made the daemon's synchronous GitHub pacer refuse a due wait instead of sleeping
 * (W1-T11458). The managed-target board read then came back empty at every boot, `openPrOwnership`
 * threw "target WIP unreadable", and the throw escaped `runDaemon`: core exited 1 every 2-3 minutes.
 * A refused read now reuses that target's last good count. With no good count yet, the target counts
 * as unbounded, so the WIP budget and the queue governor hold dispatch for that pass and the next
 * pass reads again. Reviews and sweeps never depend on this count, so they keep running.
 */

export interface TargetWipCounts {
  owned: number;
  foreign: number;
}

export interface TargetWipReading {
  counts: TargetWipCounts;
  source: "fresh" | "last-known" | "unreadable";
}

/** Per-target memory of the last good count, kept for the life of one daemon process. */
export function createTargetWipMemory(): (repo: string, observe: () => TargetWipCounts | undefined) => TargetWipReading {
  const last = new Map<string, TargetWipCounts>();
  return (repo, observe) => {
    const key = repo.toLowerCase();
    let fresh: TargetWipCounts | undefined;
    try {
      fresh = observe();
    } catch {
      // A throw is the same unreadable answer as an empty read; the reason is logged by the caller.
      fresh = undefined;
    }
    if (fresh) {
      last.set(key, fresh);
      return { counts: fresh, source: "fresh" };
    }
    const known = last.get(key);
    if (known) return { counts: known, source: "last-known" };
    return { counts: { owned: Number.POSITIVE_INFINITY, foreign: 0 }, source: "unreadable" };
  };
}
