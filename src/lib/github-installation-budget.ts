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
  /** Admit and count a transport read as one atomic operation across the daemon's threads. */
  claimRead(): InstallationBudgetAdmit;
  /** A refusal, either ours (`admit` said no) or GitHub's (a rate-limit error). Adds at most one row per window. */
  noteThrottle(reason: "share" | "reserve" | "refused"): void;
  /** The allowance of the latest reading, or undefined when there is no limit. */
  allowance(): number | undefined;
  /** Drain throttle evidence recorded by any thread sharing this budget. */
  takeThrottleRows(): GithubBudgetThrottledRow[];
}

/** The throttle-row windows kept for de-duplication; older windows are dropped. */
const KEPT_WINDOWS = 8;

/** Shared with the daemon's read worker through its existing input. All fields are guarded by slot 0. */
export function createInstallationBudgetState(): SharedArrayBuffer {
  return new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * (ROW_START + ROW_FIELDS * MAX_PENDING_ROWS));
}

const enum Slot {
  Lock, Remaining, Limit, Reset, Reads, PendingCount, WindowCursor,
}

const WINDOW_START = Slot.WindowCursor + 1;
const ROW_START = WINDOW_START + KEPT_WINDOWS;
const ROW_FIELDS = 6;
// BACKSTOP: over forty days without a daemon drain must refuse visibly rather than discard evidence.
const MAX_PENDING_ROWS = 1024;

function withState<T>(state: BigInt64Array, fn: () => T): T {
  while (Atomics.compareExchange(state, Slot.Lock, 0n, 1n) !== 0n) { /* short critical section */ }
  try { return fn(); } finally { Atomics.store(state, Slot.Lock, 0n); }
}

export function createInstallationBudget(opts: {
  consumers: number | undefined;
  instance?: string;
  writeReserveFraction?: number;
  clock: Clock;
  /** Where each throttle row goes: the daemon writes it to the ledger. */
  onThrottle?: (row: GithubBudgetThrottledRow) => void;
  sharedState?: SharedArrayBuffer;
}): InstallationBudget {
  const consumers = opts.consumers !== undefined && Number.isInteger(opts.consumers) && opts.consumers > 0
    ? opts.consumers : undefined;
  const reserveFraction = opts.writeReserveFraction ?? GITHUB_WRITE_RESERVE_FRACTION;
  const instance = opts.instance ?? "unknown";
  let latest: InstallationBudgetReading | undefined;
  let reads = 0;
  const windows: string[] = [];
  const pending: GithubBudgetThrottledRow[] = [];
  const shared = opts.sharedState === undefined ? undefined : new BigInt64Array(opts.sharedState);

  const snapshot = (): { reading: InstallationBudgetReading | undefined; reads: number } => {
    if (shared === undefined) return { reading: latest, reads };
    return withState(shared, () => ({
      reading: shared[Slot.Limit] > 0n ? {
        remaining: Number(shared[Slot.Remaining]), limit: Number(shared[Slot.Limit]),
        reset: Number(shared[Slot.Reset]), resource: BUDGET_RESOURCE,
      } : undefined,
      reads: Number(shared[Slot.Reads]),
    }));
  };

  const current = (): InstallationBudgetReading | undefined => {
    const reading = snapshot().reading;
    if (reading === undefined) return undefined;
    // A reading whose reset has passed says nothing about the new window.
    return reading.reset * 1000 > opts.clock.now() ? reading : undefined;
  };
  const reserveOf = (reading: InstallationBudgetReading): number => Math.ceil(reading.limit * reserveFraction);
  const allowanceOf = (reading: InstallationBudgetReading, shares: number): number =>
    Math.max(0, Math.floor((reading.remaining - reserveOf(reading)) / shares));
  const decision = (reading: InstallationBudgetReading | undefined, spent: number): InstallationBudgetAdmit => {
    if (consumers === undefined || reading === undefined || reading.reset * 1000 <= opts.clock.now()) return { ok: true };
    const allowance = allowanceOf(reading, consumers);
    if (reading.remaining <= reserveOf(reading)) {
      return { ok: false, waitUntil: reading.reset, reason: "reserve", reading, allowance, reads: spent };
    }
    if (spent >= allowance) return { ok: false, waitUntil: reading.reset, reason: "share", reading, allowance, reads: spent };
    return { ok: true };
  };

  return {
    consumers,
    record(reading) {
      const { remaining, limit, reset, resource } = reading;
      if (remaining === undefined || limit === undefined || reset === undefined) return;
      if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(reset) || limit <= 0) return;
      if ((resource ?? BUDGET_RESOURCE) !== BUDGET_RESOURCE) return;
      if (shared === undefined) {
        latest = { remaining, limit, reset, resource: resource ?? BUDGET_RESOURCE };
        reads = 0;
      } else withState(shared, () => {
        shared[Slot.Remaining] = BigInt(Math.trunc(remaining));
        shared[Slot.Limit] = BigInt(Math.trunc(limit));
        shared[Slot.Reset] = BigInt(Math.trunc(reset));
        shared[Slot.Reads] = 0n;
      });
    },
    admit() {
      const state = snapshot();
      return decision(state.reading, state.reads);
    },
    noteRead() {
      if (consumers !== undefined && current() !== undefined) {
        if (shared === undefined) reads += 1;
        else Atomics.add(shared, Slot.Reads, 1n);
      }
    },
    claimRead() {
      if (shared === undefined) {
        const admitted = decision(latest, reads);
        if (admitted.ok && consumers !== undefined && current() !== undefined) reads += 1;
        return admitted;
      }
      return withState(shared, () => {
        const reading = shared[Slot.Limit] > 0n ? {
          remaining: Number(shared[Slot.Remaining]), limit: Number(shared[Slot.Limit]),
          reset: Number(shared[Slot.Reset]), resource: BUDGET_RESOURCE,
        } : undefined;
        const admitted = decision(reading, Number(shared[Slot.Reads]));
        if (admitted.ok && consumers !== undefined && reading !== undefined && reading.reset * 1000 > opts.clock.now()) {
          shared[Slot.Reads] += 1n;
        }
        return admitted;
      });
    },
    noteThrottle(reason) {
      if (consumers === undefined) return;
      const reading = current();
      const window = `${reading?.reset ?? "unknown"}`;
      if (shared === undefined) {
        const existing = pending.find(row => row.reset === (reading === undefined ? undefined : clockFromMillisFn(() => reading.reset * 1000).iso()));
        if (existing !== undefined) {
          if (reason === "refused") existing.reason = reason;
          return;
        }
        if (windows.includes(window)) return;
        windows.push(window);
        if (windows.length > KEPT_WINDOWS) windows.shift();
      } else {
        const newRow = withState(shared, () => {
          const key = BigInt(reading?.reset ?? -1);
          const count = Number(shared[Slot.PendingCount]);
          for (let i = 0; i < count; i++) {
            const offset = ROW_START + i * ROW_FIELDS;
            if (shared[offset] !== key) continue;
            if (reason === "refused") shared[offset + 1] = 3n;
            return false;
          }
          for (let i = 0; i < Math.min(KEPT_WINDOWS, Number(shared[Slot.WindowCursor])); i++) {
            if (shared[WINDOW_START + i] === key) return false;
          }
          if (count === MAX_PENDING_ROWS) throw new RangeError("installation budget throttle queue must be drained");
          const offset = ROW_START + count * ROW_FIELDS;
          shared.set([
            key, BigInt(reason === "share" ? 1 : reason === "reserve" ? 2 : 3),
            BigInt(reading?.remaining ?? -1), BigInt(reading?.limit ?? -1),
            BigInt(reading === undefined ? -1 : allowanceOf(reading, consumers)), BigInt(consumers),
          ], offset);
          shared[Slot.PendingCount] += 1n;
          shared[WINDOW_START + Number(shared[Slot.WindowCursor] % BigInt(KEPT_WINDOWS))] = key;
          shared[Slot.WindowCursor] += 1n;
          return true;
        });
        if (!newRow) return;
      }
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
      if (shared === undefined) pending.push(row);
      opts.onThrottle?.(row);
    },
    allowance() {
      const reading = current();
      return consumers === undefined || reading === undefined ? undefined : allowanceOf(reading, consumers);
    },
    takeThrottleRows() {
      if (shared === undefined) return pending.splice(0);
      return withState(shared, () => {
        const rows: GithubBudgetThrottledRow[] = [];
        for (let i = 0; i < Number(shared[Slot.PendingCount]); i++) {
          const offset = ROW_START + i * ROW_FIELDS;
          const [reset, reason, remaining, limit, allowance, shares] = Array.from(shared.slice(offset, offset + ROW_FIELDS), Number);
          rows.push({
            step: GITHUB_BUDGET_THROTTLED_STEP, instance,
            reason: reason === 1 ? "share" : reason === 2 ? "reserve" : "refused",
            consumers: shares,
            ...(remaining < 0 ? {} : {
              remaining, limit, reset: clockFromMillisFn(() => reset * 1000).iso(), allowance,
            }),
          });
        }
        shared[Slot.PendingCount] = 0n;
        return rows;
      });
    },
  };
}
