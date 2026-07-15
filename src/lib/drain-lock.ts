import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/**
 * Single-instance guard for `rmd drain`.
 *
 * ROOT CAUSE this addresses (DIAGNOSIS.md, diag/drain-concurrency): two `rmd drain`
 * processes ran concurrently — nothing stopped a second invocation — and, because
 * task readiness is re-derived from GitHub each iteration, BOTH independently selected
 * the still-unmerged W1-T7 and launched workers. A lockfile makes "two drains at once"
 * impossible. The drain LOOP itself is correct (it awaits each run) and is NOT touched.
 */

export interface DrainLockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export class DrainLockError extends Error {
  constructor(public readonly holder: DrainLockInfo) {
    super(
      `another drain is already running (pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}); ` +
        `refusing to start a second drain`,
    );
    this.name = "DrainLockError";
  }
}

/**
 * Default liveness probe: `kill(pid, 0)` sends no signal but errors if the pid does
 * not exist. EPERM means the process EXISTS but is owned by another user — still alive.
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AcquireDrainLockOpts {
  /** Override the recorded holder identity (tests). Defaults to this process. */
  info?: Partial<DrainLockInfo>;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
}

export interface DrainLockHandle {
  readonly path: string;
  readonly info: DrainLockInfo;
  /** Remove the lock. Idempotent — safe to call from a finally AND a signal handler. */
  release(): void;
}

export function readDrainLock(lockPath: string): DrainLockInfo | null {
  try {
    const o = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof o?.pid === "number") return o as DrainLockInfo;
    return null;
  } catch {
    return null; // missing, unreadable, or garbage → treat as "no valid holder"
  }
}

/**
 * Acquire the drain lock or throw {@link DrainLockError} if a LIVE drain holds it.
 * A stale lock (holder pid dead, or the file is unreadable/garbage) is reclaimed.
 * Creation is atomic (`O_EXCL`), so two racing acquirers cannot both win.
 */
export function acquireDrainLock(lockPath: string, opts: AcquireDrainLockOpts = {}): DrainLockHandle {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const info: DrainLockInfo = {
    pid: opts.info?.pid ?? process.pid,
    host: opts.info?.host ?? hostname(),
    startedAt: opts.info?.startedAt ?? new Date().toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      // O_EXCL: create-or-fail. Winner writes its identity; there is no TOCTOU gap.
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A lock already exists. If its holder is alive, refuse. If stale, reclaim + retry.
      const held = readDrainLock(lockPath);
      if (held && isAlive(held.pid)) throw new DrainLockError(held);
      try {
        unlinkSync(lockPath); // stale (dead pid / garbage) → clear and loop to re-create
      } catch {
        // another actor may have cleared it concurrently; retry the create
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

/** Run `fn` while holding the drain lock; release on EVERY exit (return OR throw). */
export function withDrainLock<T>(
  lockPath: string,
  fn: (handle: DrainLockHandle) => T,
  opts?: AcquireDrainLockOpts,
): T {
  const handle = acquireDrainLock(lockPath, opts);
  try {
    return fn(handle);
  } finally {
    handle.release();
  }
}
