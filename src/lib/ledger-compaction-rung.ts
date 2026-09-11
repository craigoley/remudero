/**
 * W1-T3368 — THE FLEET COMPACTS ITS OWN LEDGER, so the archive corpus never reaches the size that
 * kills the daemon.
 *
 * THE INCIDENT THIS REMOVES RATHER THAN DETECTS. On 2026-09-10 the fleet daemon OOM-crash-looped
 * for eight hours — 66 restarts, exit 134, zero builds dispatched — because `resolveLedgerUnion`
 * decompressed a 4.0 GB corpus (959 gzip rotations) against an 8 GB heap. The cure shipped SIX
 * MINUTES after the first abort: `db5d5f0ba feat(ledger): expose bounded archive compaction (#4950)`
 * merged 13:28:45Z against a first OOM at 13:22:36Z. Nothing ran it. A human eventually ran 14
 * bounded passes by hand — 959 rotations to 347, 4.02 GB to 1.73 GB, ~4.2 MILLION duplicate rows
 * collapsed — and the daemon came back.
 *
 * An incident whose cure was already written and merged should never have reached a human at all.
 */

/**
 * PRESSURE, NOT A TIMER, AND THAT IS THE WHOLE DESIGN. A timer compacts a healthy corpus for
 * nothing and still arrives late on a bad day. This rung fires on the quantity that actually
 * predicts the abort — how many archives a union read must open — so it is SILENT on a small corpus
 * and self-regulating on a growing one. MEASURED: 959 archives was fatal, 347 is the post-compaction
 * healthy state, and the host accrues 8-14 NEW archives PER HOUR (~240/day) because the live ledger
 * hits its 4 MiB rotation ceiling roughly every six minutes. One bounded pass retires 49 archives
 * (50 sources merged into 1), so holding the corpus near the trigger needs about five fires a day —
 * far inside any plausible daemon cadence.
 *
 * IT MEASURES COMPRESSED BYTES AND FILE COUNT, NEVER THE EXPANDED SIZE. Expanding 1.73 GB to learn
 * whether expanding it is expensive is the defect, not the measurement. `stat` per file is free.
 *
 * THE CONTRACT IT CHANGES, NAMED. `rmd ledger-compact`'s own help said it "never runs from
 * rotateLedger or a daemon cadence". Operator-only was the right posture for a NEW primitive with a
 * destructive-looking step; it is the wrong steady state for a corpus growing 240 archives a day,
 * and the eight-hour outage is what the wrong steady state cost. That help text is updated in the
 * same diff — a contract whose code disagrees with its own description is the exact defect class
 * this session kept finding. STILL NOT A ROTATION DEPENDENCY: `rotateLedger` does not call this, so
 * a compaction fault can never block a write.
 */

/** What a union read would have to open. Both are cheap: a `readdir` and a `stat` per archive. */
export interface LedgerCorpusPressure {
  /** Number of `ledger.*.ndjson[.gz]` rotations on disk. The driver — every one is a file to open. */
  archiveCount: number;
  /** Their total size ON DISK (compressed), never expanded. */
  archiveBytes: number;
}

/** When to fire. Both bounds are OR-ed: either a corpus too wide to open cheaply or too large to
 *  hold is reason enough. */
export interface LedgerCompactionTrigger {
  maxArchives: number;
  maxArchiveBytes: number;
  /** Minimum gap between fires, so a tick loop cannot spend the whole cycle compacting. */
  minIntervalMs: number;
}

/**
 * DEFAULTS, DERIVED FROM THE OUTAGE RATHER THAN PICKED.
 *
 * `maxArchives: 400` sits between the 347 the corpus holds when healthy and the 959 that aborted
 * the daemon — comfortably clear of fatal, close enough to healthy that the rung actually runs
 * instead of waiting for a crisis. `maxArchiveBytes: 700 MiB` is the second axis for a corpus that
 * is few-but-huge, sized above the 508 MB the fatal 959 archives occupied on disk so it is a
 * backstop rather than the primary trigger. `minIntervalMs: 30 min` yields up to ~48 fires a day
 * against the ~5 needed to hold steady at +240 archives/day, so the bound is headroom, not a brake.
 */
export const DEFAULT_LEDGER_COMPACTION_TRIGGER: LedgerCompactionTrigger = {
  maxArchives: 400,
  maxArchiveBytes: 700 * 1024 * 1024,
  minIntervalMs: 30 * 60_000,
};

export interface LedgerCompactionDecision {
  fire: boolean;
  /** Why, in the words the ledger line will carry. ALWAYS populated — a decision with no reason is
   *  the self-contradictory ledger row this repo has already been bitten by. */
  reason: string;
}

/**
 * Pure. Decide whether to compact on this tick.
 *
 * THE INTERVAL IS CHECKED FIRST AND DELIBERATELY, so a corpus that is over the bound and cannot yet
 * be worked says so — "over bound, waiting out the interval" is a different state from "under
 * bound", and collapsing them would make a rung that looks idle while it is actually throttled.
 */
export function decideLedgerCompaction(
  pressure: LedgerCorpusPressure,
  lastFiredAtMs: number | undefined,
  nowMs: number,
  trigger: LedgerCompactionTrigger = DEFAULT_LEDGER_COMPACTION_TRIGGER,
): LedgerCompactionDecision {
  const overCount = pressure.archiveCount > trigger.maxArchives;
  const overBytes = pressure.archiveBytes > trigger.maxArchiveBytes;
  if (!overCount && !overBytes) {
    return {
      fire: false,
      reason:
        `corpus under bound — ${pressure.archiveCount} archive(s) (max ${trigger.maxArchives}), ` +
        `${pressure.archiveBytes} bytes on disk (max ${trigger.maxArchiveBytes})`,
    };
  }

  const over = [
    overCount ? `${pressure.archiveCount} archive(s) > ${trigger.maxArchives}` : undefined,
    overBytes ? `${pressure.archiveBytes} bytes on disk > ${trigger.maxArchiveBytes}` : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join(" and ");

  if (lastFiredAtMs !== undefined) {
    const sinceMs = nowMs - lastFiredAtMs;
    // A marker stamped in the FUTURE is a clock problem, not a reason to compact in a loop. Treat it
    // as "just fired" — the conservative direction, since the cost of waiting is one interval and
    // the cost of looping is a daemon that compacts instead of building.
    if (sinceMs < trigger.minIntervalMs) {
      return {
        fire: false,
        reason:
          `over bound (${over}) but throttled — last compaction ${Math.max(0, Math.floor(sinceMs / 1000))}s ago, ` +
          `interval ${Math.floor(trigger.minIntervalMs / 1000)}s`,
      };
    }
  }

  return { fire: true, reason: `over bound — ${over}` };
}

/** What one bounded pass did, as the ledger should record it. */
export interface LedgerCompactionOutcome {
  sourceCount: number;
  rowsWritten: number;
  duplicatesCollapsed: number;
  archiveName: string;
}

/**
 * Read the corpus pressure from a state directory. Injected `readdir`/`sizeOf` so the decision above
 * is provable with no files on disk, and so a host whose state dir is unreadable yields a pressure
 * of ZERO — which reads as "under bound" and fires nothing. That direction is deliberate: an
 * unreadable corpus is a reason to stay out of the way, not to start deleting.
 */
export function readLedgerCorpusPressure(
  stateDir: string,
  deps: { readdir: (dir: string) => string[]; sizeOf: (path: string) => number },
): LedgerCorpusPressure {
  let names: string[];
  try {
    names = deps.readdir(stateDir);
  } catch {
    return { archiveCount: 0, archiveBytes: 0 };
  }
  // The rotation forms are BOTH shapes, plain and gzip — a glob naming one answers from the other
  // without saying so, which CLAUDE.md records as a measured zero this repo has already shipped.
  const rotations = names.filter((n) => /^ledger\..+\.ndjson(\.gz)?$/.test(n));
  let bytes = 0;
  for (const n of rotations) {
    try {
      bytes += deps.sizeOf(`${stateDir}/${n}`);
    } catch {
      // An archive that cannot be stat'd still COUNTS — it is a file a union read would try to open.
    }
  }
  return { archiveCount: rotations.length, archiveBytes: bytes };
}
