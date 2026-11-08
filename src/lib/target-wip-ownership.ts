/**
 * A managed target's open-PR ownership, read so one refused read never ends the daemon.
 *
 * 2026-11-07: #17144 made the daemon's synchronous GitHub pacer refuse a due wait instead of sleeping
 * (W1-T11458). The managed-target board read then came back empty at every boot, `openPrOwnership`
 * threw "target WIP unreadable", and the throw escaped `runDaemon`: core exited 1 every 2-3 minutes.
 * An unreadable result counts as unbounded, so the WIP budget and queue governor hold new dispatch
 * until a fresh read succeeds. A target's last good count is retained only as diagnostic history;
 * it never admits work. Reviews, sweeps and already-admitted children keep running.
 */

export interface TargetWipCounts {
  owned: number;
  foreign: number;
}

export interface TargetWipReading {
  counts: TargetWipCounts;
  source: "fresh" | "unreadable";
  lastKnownCounts?: TargetWipCounts;
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
    return {
      counts: { owned: Number.POSITIVE_INFINITY, foreign: 0 },
      source: "unreadable",
      ...(known ? { lastKnownCounts: known } : {}),
    };
  };
}
