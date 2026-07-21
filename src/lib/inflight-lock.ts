import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defaultIsPidAlive } from "./drain-lock.js";

/**
 * PER-TASK IN-FLIGHT LOCK (DIAGNOSIS.md, diag/drain-sequential-await).
 *
 * The proven root cause was TWO concurrent `rmd drain` processes both selecting the
 * still-unmerged W1-T7 and running it. A drain-only lock (PR #50) stops two drains —
 * but this guard is deliberately MORE GENERAL: it keys the lock on the TASK id, so no
 * two runs of the SAME task can overlap NO MATTER what launched them — two drains, or
 * a manual `rmd run-task <id>` beside a running drain. That is the case a drain-only
 * lock cannot cover.
 *
 * The drain LOOP itself is correct (drain.ts:167 awaits each run) and is NOT touched.
 */

export interface InflightLockInfo {
  pid: number;
  run_id: string;
  host: string;
  startedAt: string;
}

export class InflightLockError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly holder: InflightLockInfo,
  ) {
    super(
      `task ${taskId} is already running (pid ${holder.pid}, run ${holder.run_id} on ${holder.host}, ` +
        `started ${holder.startedAt}); refusing to start a second run of the same task`,
    );
    this.name = "InflightLockError";
  }
}

/** `<inflightDir>/<taskId>.lock` — one lock file per task id. */
export function inflightLockPath(inflightDir: string, taskId: string): string {
  return join(inflightDir, `${taskId}.lock`);
}

export function readInflightLock(inflightDir: string, taskId: string): InflightLockInfo | null {
  try {
    const o = JSON.parse(readFileSync(inflightLockPath(inflightDir, taskId), "utf8"));
    if (typeof o?.pid === "number" && typeof o?.run_id === "string") return o as InflightLockInfo;
    return null;
  } catch {
    return null; // missing, unreadable, or garbage → no valid holder
  }
}

export interface AcquireInflightOpts {
  run_id: string;
  /** Override recorded identity (tests). pid/host/startedAt default to this process. */
  info?: Partial<Omit<InflightLockInfo, "run_id">>;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
}

export interface InflightLockHandle {
  readonly path: string;
  readonly info: InflightLockInfo;
  /** Remove the lock. Idempotent — safe from a finally AND a signal handler. */
  release(): void;
}

/**
 * Acquire the in-flight lock for `taskId`, or throw {@link InflightLockError} if a LIVE
 * run of the same task holds it. A stale lock (holder pid dead, or the file is
 * unreadable/garbage) is reclaimed. Creation is atomic (`O_EXCL`) so two racing
 * acquirers of the same task cannot both win.
 */
export function acquireInflightLock(
  inflightDir: string,
  taskId: string,
  opts: AcquireInflightOpts,
): InflightLockHandle {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const info: InflightLockInfo = {
    pid: opts.info?.pid ?? process.pid,
    run_id: opts.run_id,
    host: opts.info?.host ?? hostname(),
    startedAt: opts.info?.startedAt ?? new Date().toISOString(),
  };
  const lockPath = inflightLockPath(inflightDir, taskId);
  mkdirSync(inflightDir, { recursive: true });

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // create-or-fail; no TOCTOU gap
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readInflightLock(inflightDir, taskId);
      if (held && isAlive(held.pid)) throw new InflightLockError(taskId, held);
      try {
        unlinkSync(lockPath); // stale (dead pid / garbage) → clear and re-create
      } catch {
        // another actor cleared it concurrently; retry the create
      }
    }
  }

  let released = false;
  return {
    path: lockPath,
    info,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — idempotent
      }
    },
  };
}

/** Run `fn` holding the task's in-flight lock; release on EVERY exit (return OR throw). */
export function withInflightLock<T>(
  inflightDir: string,
  taskId: string,
  fn: (handle: InflightLockHandle) => T,
  opts: AcquireInflightOpts,
): T {
  const handle = acquireInflightLock(inflightDir, taskId, opts);
  try {
    return fn(handle);
  } finally {
    handle.release();
  }
}

/** What one boot-time lock sweep removed and left alone. */
export interface InflightSweepResult {
  /** Task ids whose lock was removed because its holder pid is gone. */
  reaped: string[];
  /** Task ids whose lock was left because its holder is still alive. */
  kept: string[];
}

/**
 * REAP LOCKS WHOSE HOLDER IS GONE (recon R-35), once at daemon boot.
 *
 * This is an OBSERVABILITY fix, not a liveness one, and the distinction matters enough to state:
 * {@link acquireInflightLock} ALREADY steals a dead holder's lock (it unlinks and re-creates on
 * EEXIST when the pid is dead), so a stale lock has never blocked dispatch and this sweep does not
 * unblock anything.
 *
 * What it fixes is that a stale lock is only ever cleared by the NEXT acquire of that same task —
 * so a task that is never dispatched again never clears. A circuit-broken task is exactly that
 * case, and its lock therefore lingers forever, reading as live work in every view that lists the
 * in-flight directory. Observed 2026-07-21: `W1-T1.lock` held pid 65304, dead since 2026-07-19,
 * still present two days later because the circuit breaker means W1-T1 is never re-dispatched.
 *
 * A lock whose file cannot be parsed is treated as reapable: an unreadable lock names no live
 * holder, and leaving it would preserve exactly the misleading state this exists to remove.
 */
export function sweepStaleInflightLocks(
  inflightDir: string,
  opts: { isPidAlive?: (pid: number) => boolean } = {},
): InflightSweepResult {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const result: InflightSweepResult = { reaped: [], kept: [] };
  if (!existsSync(inflightDir)) return result;

  for (const entry of readdirSync(inflightDir)) {
    if (!entry.endsWith(".lock")) continue;
    const taskId = entry.slice(0, -".lock".length);
    const held = readInflightLock(inflightDir, taskId);
    if (held && isAlive(held.pid)) {
      result.kept.push(taskId);
      continue;
    }
    try {
      unlinkSync(inflightLockPath(inflightDir, taskId));
      result.reaped.push(taskId);
    } catch {
      // Raced with a real acquire, or removed by another actor between the read and the
      // unlink. Either way the lock is no longer ours to reason about — leave it counted
      // as kept rather than claiming a reap that did not happen.
      result.kept.push(taskId);
    }
  }
  return result;
}
