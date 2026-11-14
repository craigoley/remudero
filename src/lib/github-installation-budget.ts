/**
 * W1-T12553 — one GitHub App installation, shared by several daemon instances and by hand runs.
 *
 * Each process paces itself alone (`createGhCallPacer`), so together the core, console and site
 * daemons spent the installation's hourly limit every hour on 2026-11-13. This budget gives each
 * consumer a share of what is left: from the latest `x-ratelimit-*` reading, an instance may read
 * floor((remaining - write reserve) / consumers) times before the reset. The share is not a fixed
 * cap. Each newer reading gives a new allowance, so it follows the live remaining count, and it
 * shrinks as the other consumers spend.
 *
 * INVARIANT writes-keep-their-reserve: the budget only delays reads. No write calls `admit()`, and
 * reads stop while the remaining count is at or below the write reserve.
 *
 * Pure apart from its clock. It imports neither the ledger nor config: `github-transport.ts` sits
 * below the ledger and holds the one process-wide budget, and the daemon writes the throttle rows.
 */
import { clockFromMillisFn, type Clock } from "./clock.js";

/** The share of the installation's limit that reads never spend, so merges, reviews and comments still land. */
export const GITHUB_WRITE_RESERVE_FRACTION = 0.1;

export const GITHUB_BUDGET_THROTTLED_STEP = "github.budget.throttled";

/** The budget counts the `core` REST resource only; graphql and search have their own limits. */
const BUDGET_RESOURCE = "core";

export interface InstallationBudgetReading {
  remaining: number;
  limit: number;
  /** Epoch seconds, as GitHub sends `x-ratelimit-reset`. */
  reset: number;
  resource: string;
}

export type InstallationBudgetAdmit =
  | { ok: true }
  | {
    ok: false;
    /** Epoch seconds: the reset of the reading that refused. */
    waitUntil: number;
    reason: "share" | "reserve";
    reading: InstallationBudgetReading;
    allowance: number;
    reads: number;
  };

export interface GithubBudgetThrottledRow {
  step: typeof GITHUB_BUDGET_THROTTLED_STEP;
  instance: string;
  reason: "share" | "reserve" | "refused";
  remaining?: number;
  limit?: number;
  /** ISO time of the reset, when a reading gave one. */
  reset?: string;
  allowance?: number;
  consumers: number;
}

export interface InstallationBudget {
  /** The number of consumers that share the installation; undefined means no allowance limit. */
  readonly consumers: number | undefined;
  /** Keep a reading from a response's rate-limit headers. A partial reading or another resource is ignored. */
  record(reading: { remaining?: number; limit?: number; reset?: number; resource?: string }): void;
  /** Whether a read may go now. Never called for a write. */
  admit(): InstallationBudgetAdmit;
  /** Count one read against the allowance of the latest reading. */
  noteRead(): void;
  /** A refusal, either ours (`admit` said no) or GitHub's (a rate-limit error). Adds at most one row per window. */
  noteThrottle(reason: "share" | "reserve" | "refused"): void;
  /** The allowance of the latest reading, or undefined when there is no limit. */
  allowance(): number | undefined;
}

/** The throttle-row windows kept for de-duplication; older windows are dropped. */
const KEPT_WINDOWS = 8;

export function createInstallationBudget(opts: {
  consumers: number | undefined;
  instance?: string;
  writeReserveFraction?: number;
  clock: Clock;
  /** Where each throttle row goes: the daemon writes it to the ledger. */
  onThrottle?: (row: GithubBudgetThrottledRow) => void;
}): InstallationBudget {
  const consumers = opts.consumers !== undefined && Number.isInteger(opts.consumers) && opts.consumers > 0
    ? opts.consumers : undefined;
  const reserveFraction = opts.writeReserveFraction ?? GITHUB_WRITE_RESERVE_FRACTION;
  const instance = opts.instance ?? "unknown";
  let latest: InstallationBudgetReading | undefined;
  let reads = 0;
  const windows: string[] = [];

  const current = (): InstallationBudgetReading | undefined => {
    if (latest === undefined) return undefined;
    // A reading whose reset has passed says nothing about the new window.
    return latest.reset * 1000 > opts.clock.now() ? latest : undefined;
  };
  const reserveOf = (reading: InstallationBudgetReading): number => Math.ceil(reading.limit * reserveFraction);
  const allowanceOf = (reading: InstallationBudgetReading, shares: number): number =>
    Math.max(0, Math.floor((reading.remaining - reserveOf(reading)) / shares));

  return {
    consumers,
    record(reading) {
      const { remaining, limit, reset, resource } = reading;
      if (remaining === undefined || limit === undefined || reset === undefined) return;
      if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(reset) || limit <= 0) return;
      if ((resource ?? BUDGET_RESOURCE) !== BUDGET_RESOURCE) return;
      latest = { remaining, limit, reset, resource: resource ?? BUDGET_RESOURCE };
      reads = 0;
    },
    admit() {
      const reading = current();
      if (consumers === undefined || reading === undefined) return { ok: true };
      const allowance = allowanceOf(reading, consumers);
      if (reading.remaining <= reserveOf(reading)) {
        return { ok: false, waitUntil: reading.reset, reason: "reserve", reading, allowance, reads };
      }
      if (reads >= allowance) return { ok: false, waitUntil: reading.reset, reason: "share", reading, allowance, reads };
      return { ok: true };
    },
    noteRead() {
      if (consumers !== undefined && current() !== undefined) reads += 1;
    },
    noteThrottle(reason) {
      if (consumers === undefined) return;
      const reading = current();
      const window = `${reason === "refused" ? "refused" : "throttled"}:${reading?.reset ?? "unknown"}`;
      if (windows.includes(window)) return;
      windows.push(window);
      if (windows.length > KEPT_WINDOWS) windows.shift();
      const row: GithubBudgetThrottledRow = {
        step: GITHUB_BUDGET_THROTTLED_STEP,
        instance,
        reason,
        consumers,
        ...(reading === undefined ? {} : {
          remaining: reading.remaining,
          limit: reading.limit,
          reset: clockFromMillisFn(() => reading.reset * 1000).iso(),
          allowance: allowanceOf(reading, consumers),
        }),
      };
      opts.onThrottle?.(row);
    },
    allowance() {
      const reading = current();
      return consumers === undefined || reading === undefined ? undefined : allowanceOf(reading, consumers);
    },
  };
}
