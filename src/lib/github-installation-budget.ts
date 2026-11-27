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

/** GitHub's documented REST secondary limit: 900 points a minute, and a GET costs 1 point. */
const GITHUB_REST_SECONDARY_POINTS_PER_MINUTE = 900;
/** GitHub's primary rate-limit window: the reset is one hour after the window starts. */
const GITHUB_PRIMARY_WINDOW_MS = 3_600_000;

/**
 * W1-T13786 — the gap between this process's reads, in whole milliseconds. It is the larger of the
 * secondary spacing (every instance keeps the installation under 900 reads a minute) and the
 * budget spacing (the spendable budget spread over the time to the reset, at least the equal share).
 * With no current reading, or nothing spendable, it is the secondary spacing; the admission refuses those reads.
 */
export function ghBudgetReadGapMs(input: {
  reading: InstallationBudgetReading | undefined;
  nowMs: number;
  shares: number;
  instances: number;
  ownWindowReads: number;
  reserveFraction: number;
}): number {
  const { reading, nowMs } = input;
  const secondaryMs = 60_000 * Math.max(1, input.instances) / GITHUB_REST_SECONDARY_POINTS_PER_MINUTE;
  const resetMs = reading === undefined ? 0 : reading.reset * 1000;
  const spendable = reading === undefined ? 0 : reading.remaining - Math.ceil(reading.limit * input.reserveFraction);
  if (reading === undefined || resetMs <= nowMs || spendable <= 0) return Math.ceil(secondaryMs);
  const toResetMs = resetMs - nowMs;
  const sinceWindowStartMs = nowMs - (resetMs - GITHUB_PRIMARY_WINDOW_MS);
  const othersPerMs = sinceWindowStartMs <= 0 ? 0
    : Math.max(0, reading.limit - reading.remaining - input.ownWindowReads) / sinceWindowStartMs;
  const perMs = Math.max(spendable / toResetMs / Math.max(1, input.shares), spendable / toResetMs - othersPerMs);
  return Math.ceil(Math.max(secondaryMs, 1 / perMs));
}

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

/** What a worker thread needs to join a shared budget: plain data that a structured clone keeps shared. */
export interface InstallationBudgetThreadInput {
  state: SharedArrayBuffer;
  consumers: number;
  instance: string;
  /** W1-T12820: the longest wait for a reset; a worker thread stands down past it, as the daemon does. */
  maxWaitMs?: number;
  /** W1-T13786: the daemon instances on the installation, for the secondary spacing. */
  instances?: number;
}

/** A refused admission: what {@link InstallationBudget.resetWaitMs} is asked about. */
export type InstallationBudgetRefusal = Extract<InstallationBudgetAdmit, { ok: false }>;

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
  /** W1-T14892: take back one claimed read whose answer was a 304, which GitHub does not count. */
  refundRead?(): void;
  /** Deduplicate each window, preserving a later GitHub refusal even after its throttle was drained. */
  noteThrottle(reason: "share" | "reserve" | "refused"): void;
  /** The allowance of the latest reading, or undefined when there is no limit. */
  allowance(): number | undefined;
  /** Drain throttle evidence recorded by any thread sharing this budget. */
  takeThrottleRows(): GithubBudgetThrottledRow[];
  /** W1-T12555: the state a worker thread joins; undefined for an unconfigured or unshared budget. */
  threadInput(): InstallationBudgetThreadInput | undefined;
  /**
   * W1-T12820: how long a refused read waits for its reset: at least 1 ms, or undefined when the reset is
   * further away than the wait bound, so the read stands down and the caller's pass goes on without it.
   * With no bound the wait is the whole reset window, as before.
   */
  resetWaitMs(refusal: InstallationBudgetRefusal): number | undefined;
  /** W1-T13786: the gap between this process's reads now, from the latest reading and its own window reads. */
  readGapMs(): number;
}

/** The throttle-row windows kept for de-duplication; older windows are dropped. */
const KEPT_WINDOWS = 8;

/** Shared with the daemon's read worker through its existing input. All fields are guarded by slot 0. */
export function createInstallationBudgetState(): SharedArrayBuffer {
  return new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * (ROW_START + ROW_FIELDS * MAX_PENDING_ROWS));
}

const enum Slot {
  Lock, Remaining, Limit, Reset, Reads, PendingCount, WindowReads, WindowReset, WindowCursor,
}

const WINDOW_START = Slot.WindowCursor + 1;
const WINDOW_FIELDS = 2;
const ROW_START = WINDOW_START + KEPT_WINDOWS * WINDOW_FIELDS;
const ROW_FIELDS = 6;
// BACKSTOP: over forty days without a daemon drain must refuse visibly rather than discard evidence.
const MAX_PENDING_ROWS = 1024;

function withState<T>(state: BigInt64Array, fn: () => T): T {
  while (Atomics.compareExchange(state, Slot.Lock, 0n, 1n) !== 0n) { /* short critical section */ }
  try { return fn(); } finally { Atomics.store(state, Slot.Lock, 0n); }
}

/** W1-T12555: the budget a worker thread asks, on the same atomic state as the thread that started it. */
export function installationBudgetForThread(input: InstallationBudgetThreadInput, clock: Clock): InstallationBudget {
  return createInstallationBudget({
    consumers: input.consumers, instance: input.instance, clock, sharedState: input.state, maxWaitMs: input.maxWaitMs,
    instances: input.instances,
  });
}

export function createInstallationBudget(opts: {
  consumers: number | undefined;
  instance?: string;
  writeReserveFraction?: number;
  clock: Clock;
  /** Where each throttle row goes: the daemon writes it to the ledger. */
  onThrottle?: (row: GithubBudgetThrottledRow) => void;
  sharedState?: SharedArrayBuffer;
  /** W1-T12820: the longest a refused read waits for its reset; the daemon sets its poll interval. */
  maxWaitMs?: number;
  /** W1-T13786: the daemon instances on the installation (the registry's consumers); 1 when unset. */
  instances?: number;
}): InstallationBudget {
  const consumers = opts.consumers !== undefined && Number.isInteger(opts.consumers) && opts.consumers > 0
    ? opts.consumers : undefined;
  const instances = opts.instances !== undefined && Number.isInteger(opts.instances) && opts.instances > 0
    ? opts.instances : undefined;
  const maxWaitMs = opts.maxWaitMs !== undefined && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs >= 0
    ? opts.maxWaitMs : undefined;
  const reserveFraction = opts.writeReserveFraction ?? GITHUB_WRITE_RESERVE_FRACTION;
  const instance = opts.instance ?? "unknown";
  let latest: InstallationBudgetReading | undefined;
  let reads = 0;
  let windowReads = 0;
  let windowReset: number | undefined;
  const windows: Array<{ key: string; refused: boolean }> = [];
  const pending: GithubBudgetThrottledRow[] = [];
  const shared = opts.sharedState === undefined ? undefined : new BigInt64Array(opts.sharedState);

  const snapshot = (): { reading: InstallationBudgetReading | undefined; reads: number; windowReads: number } => {
    if (shared === undefined) return { reading: latest, reads, windowReads: windowReset === latest?.reset ? windowReads : 0 };
    return withState(shared, () => ({
      reading: shared[Slot.Limit] > 0n ? {
        remaining: Number(shared[Slot.Remaining]), limit: Number(shared[Slot.Limit]),
        reset: Number(shared[Slot.Reset]), resource: BUDGET_RESOURCE,
      } : undefined,
      reads: Number(shared[Slot.Reads]),
      windowReads: shared[Slot.WindowReset] === shared[Slot.Reset] ? Number(shared[Slot.WindowReads]) : 0,
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
        if (windowReset !== reset) {
          windowReset = reset;
          windowReads = 0;
        }
      } else withState(shared, () => {
        shared[Slot.Remaining] = BigInt(Math.trunc(remaining));
        shared[Slot.Limit] = BigInt(Math.trunc(limit));
        shared[Slot.Reset] = BigInt(Math.trunc(reset));
        shared[Slot.Reads] = 0n;
        if (shared[Slot.WindowReset] !== shared[Slot.Reset]) {
          shared[Slot.WindowReset] = shared[Slot.Reset];
          shared[Slot.WindowReads] = 0n;
        }
      });
    },
    admit() {
      const state = snapshot();
      return decision(state.reading, state.reads);
    },
    noteRead() {
      if (current() === undefined) return;
      if (shared === undefined) {
        windowReads += 1;
        if (consumers !== undefined) reads += 1;
      } else {
        Atomics.add(shared, Slot.WindowReads, 1n);
        if (consumers !== undefined) Atomics.add(shared, Slot.Reads, 1n);
      }
    },
    claimRead() {
      if (shared === undefined) {
        const admitted = decision(latest, reads);
        if (admitted.ok && current() !== undefined) {
          windowReads += 1;
          if (consumers !== undefined) reads += 1;
        }
        return admitted;
      }
      return withState(shared, () => {
        const reading = shared[Slot.Limit] > 0n ? {
          remaining: Number(shared[Slot.Remaining]), limit: Number(shared[Slot.Limit]),
          reset: Number(shared[Slot.Reset]), resource: BUDGET_RESOURCE,
        } : undefined;
        const admitted = decision(reading, Number(shared[Slot.Reads]));
        if (admitted.ok && reading !== undefined && reading.reset * 1000 > opts.clock.now()) {
          shared[Slot.WindowReads] += 1n;
          if (consumers !== undefined) shared[Slot.Reads] += 1n;
        }
        return admitted;
      });
    },
    refundRead() {
      if (shared === undefined) {
        if (windowReads > 0) windowReads -= 1;
        if (consumers !== undefined && reads > 0) reads -= 1;
        return;
      }
      withState(shared, () => {
        if (shared[Slot.WindowReads] > 0n) shared[Slot.WindowReads] -= 1n;
        if (consumers !== undefined && shared[Slot.Reads] > 0n) shared[Slot.Reads] -= 1n;
      });
    },
    noteThrottle(reason) {
      if (consumers === undefined) return;
      const reading = current();
      const window = `${reading?.reset ?? "unknown"}`;
      if (shared === undefined) {
        const existing = pending.find(row => row.reset === (reading === undefined ? undefined : clockFromMillisFn(() => reading.reset * 1000).iso()));
        let emitted = windows.find(entry => entry.key === window);
        if (existing === undefined && emitted !== undefined && (reason !== "refused" || emitted.refused)) return;
        if (emitted === undefined) {
          emitted = { key: window, refused: reason === "refused" || existing?.reason === "refused" };
          windows.push(emitted);
          if (windows.length > KEPT_WINDOWS) windows.shift();
        } else if (reason === "refused") emitted.refused = true;
        if (existing !== undefined) {
          if (reason === "refused") existing.reason = reason;
          return;
        }
      } else {
        const newRow = withState(shared, () => {
          const key = BigInt(reading?.reset ?? -1);
          const count = Number(shared[Slot.PendingCount]);
          let pendingOffset: number | undefined;
          for (let i = 0; i < count; i++) {
            const offset = ROW_START + i * ROW_FIELDS;
            if (shared[offset] === key) { pendingOffset = offset; break; }
          }
          let windowOffset: number | undefined;
          for (let i = 0; i < Math.min(KEPT_WINDOWS, Number(shared[Slot.WindowCursor])); i++) {
            const offset = WINDOW_START + i * WINDOW_FIELDS;
            if (shared[offset] === key) { windowOffset = offset; break; }
          }
          if (pendingOffset === undefined && windowOffset !== undefined &&
              (reason !== "refused" || shared[windowOffset + 1] === 1n)) return false;
          if (pendingOffset === undefined && count === MAX_PENDING_ROWS) throw new RangeError("installation budget throttle queue must be drained");
          if (windowOffset === undefined) {
            windowOffset = WINDOW_START + Number(shared[Slot.WindowCursor] % BigInt(KEPT_WINDOWS)) * WINDOW_FIELDS;
            shared[windowOffset] = key;
            shared[windowOffset + 1] = pendingOffset !== undefined && shared[pendingOffset + 1] === 3n ? 1n : 0n;
            shared[Slot.WindowCursor] += 1n;
          }
          if (reason === "refused") shared[windowOffset + 1] = 1n;
          if (pendingOffset !== undefined) {
            if (reason === "refused") shared[pendingOffset + 1] = 3n;
            return false;
          }
          const offset = ROW_START + count * ROW_FIELDS;
          shared.set([
            key, BigInt(reason === "share" ? 1 : reason === "reserve" ? 2 : 3),
            BigInt(reading?.remaining ?? -1), BigInt(reading?.limit ?? -1),
            BigInt(reading === undefined ? -1 : allowanceOf(reading, consumers)), BigInt(consumers),
          ], offset);
          shared[Slot.PendingCount] += 1n;
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
    threadInput() {
      return opts.sharedState === undefined || consumers === undefined
        ? undefined : {
          state: opts.sharedState, consumers, instance,
          ...(maxWaitMs === undefined ? {} : { maxWaitMs }), ...(instances === undefined ? {} : { instances }),
        };
    },
    resetWaitMs(refusal) {
      const waitMs = Math.max(1, refusal.waitUntil * 1000 - opts.clock.now());
      return maxWaitMs === undefined || waitMs <= maxWaitMs ? waitMs : undefined;
    },
    readGapMs() {
      const state = snapshot();
      const input = {
        reading: state.reading, nowMs: opts.clock.now(), shares: consumers ?? 1, instances: instances ?? 1,
        ownWindowReads: state.windowReads, reserveFraction,
      };
      const gapMs = ghBudgetReadGapMs(input);
      if (maxWaitMs === undefined) return gapMs;
      // W1-T12820: a gap past the wait bound would hold the read that the admission stands down at once.
      return Math.min(gapMs, Math.max(maxWaitMs, ghBudgetReadGapMs({ ...input, reading: undefined })));
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
