import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fixedClock } from "./clock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { sameHost } from "./host-identity.js";

/**
 * PER-TASK IN-FLIGHT LOCK (docs/archive/DIAGNOSIS.md, diag/drain-sequential-await).
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

/** Parse raw lock file contents into a holder record, or `null` for garbage/unshaped JSON
 *  (shared with {@link reclaimStaleLock}'s `parseHolder`, so the acquire loop and the
 *  read-only peek below apply the identical "what counts as a valid holder" rule). */
export function parseInflightLockInfo(raw: string): InflightLockInfo | null {
  try {
    const o = JSON.parse(raw);
    return typeof o?.pid === "number" && typeof o?.run_id === "string" ? (o as InflightLockInfo) : null;
  } catch {
    return null;
  }
}

export function readInflightLock(inflightDir: string, taskId: string): InflightLockInfo | null {
  try {
    return parseInflightLockInfo(readFileSync(inflightLockPath(inflightDir, taskId), "utf8"));
  } catch {
    return null; // missing, unreadable, or garbage → no valid holder
  }
}

export interface AcquireInflightOpts {
  /** reclaim:false refuses any existing inode without read/reclaim; info overrides identity (tests), with pid/host/startedAt defaulting to this process. */
  reclaim?: false;
  run_id: string;
  info?: Partial<Omit<InflightLockInfo, "run_id">>;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Injectable process-start-time probe, forwarded to {@link isHolderStale} (tests). Defaults
   *  to {@link import("./fs-race-safe.js").defaultGetProcessStartTime}. */
  getProcessStartTime?: (pid: number) => number | null;
  /** Called when a reclaim attempt loses the race (see {@link reclaimStaleLock}). Defaults
   *  to a `console.error` trace; tests override it to observe the event directly. */
  onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
  /** TEST-ONLY seam forwarded to {@link reclaimStaleLock}'s `beforeDelete` — lets a test
   *  force a second reclaimer's whole acquire to complete inside this call's reclaim
   *  window. Never set outside tests. */
  __beforeReclaimDelete?: () => void;
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
 * unreadable/garbage) is reclaimed via {@link reclaimStaleLock}. Creation is atomic
 * (`O_EXCL`), so two racing acquirers hitting the create fresh cannot both win it; the
 * RECLAIM of a stale holder is separately made safe by conditioning its delete on the
 * lock's on-disk identity, so two reclaimers of the SAME dead lock cannot both come away
 * believing they hold it either (W1-T289).
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
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || opts.reclaim === false) throw e;
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseInflightLockInfo,
        isStale: (held) => isHolderStale(held, { isPidAlive: isAlive, getProcessStartTime: opts.getProcessStartTime }),
        onLostReclaim: opts.onLostReclaim,
        beforeDelete: opts.__beforeReclaimDelete,
      });
      if (result.outcome === "live") throw new InflightLockError(taskId, result.holder);
      // "missing" | "reclaimed" | "lost" → loop back and retry the atomic create on
      // whatever is (or isn't) there now.
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
  /** Task ids whose lock was left alone for ANY reason other than a reap: a confirmed-live
   *  holder ({@link live}), an unverifiable foreign-host holder ({@link unverifiableForeignHost}),
   *  or the rare race outcomes `reclaimStaleLock` reports as "missing" (the file vanished between
   *  this sweep's readdir and its read) or "lost" (a real acquirer reclaimed it first) — neither of
   *  which carries a holder to classify. Superset of `live` + `unverifiableForeignHost`; kept for
   *  callers that only want the total non-reaped count. */
  kept: string[];
  /** Task ids whose lock was left because a real, SAME-HOST holder is confirmed alive —
   *  `reclaimStaleLock`'s "live" outcome with `holder.host` matching this host (or absent, the
   *  pre-W1-T368 shape). This is the ONLY bucket `isHolderStale` actually verified. */
  live: string[];
  /** Task ids whose lock was left because it names a DIFFERENT host than this one.
   *  `isHolderStale`'s rung 1 (W1-T396) refuses to reason about a foreign host's process table,
   *  so this lock's holder was NEVER established to be alive — only unreclaimable from here. A
   *  container replacement strands exactly these: nothing on the new container can ever verify
   *  or clear them, so collapsing this into {@link live} (as the sweep did before this field
   *  existed) reads a permanently-stuck lock as indistinguishable from healthy live work. */
  unverifiableForeignHost: string[];
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
 *
 * THE READ AND THE UNLINK GO THROUGH {@link reclaimStaleLock} (W1-T289): a real acquire can
 * land on the SAME task between this sweep's read and its unlink, reclaim the dead lock
 * itself, and write a fresh LIVE one — the old shape's unconditional unlink would then
 * delete that live lock. Conditioning the delete on the lock's on-disk identity means the
 * sweep detects that hand-off and leaves the fresh lock alone instead of reaping it.
 */
export function sweepStaleInflightLocks(
  inflightDir: string,
  opts: {
    isPidAlive?: (pid: number) => boolean;
    /** Injectable process-start-time probe, forwarded to {@link isHolderStale} (tests). */
    getProcessStartTime?: (pid: number) => number | null;
    onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
    /** TEST-ONLY seam forwarded to {@link reclaimStaleLock}'s `beforeDelete`. */
    __beforeReclaimDelete?: () => void;
    /** This host's own identity — forwarded to {@link isHolderStale} (so its rung-1 host
     *  comparison and this sweep's `live`/`unverifiableForeignHost` classification always agree)
     *  and used directly below. Defaults to `os.hostname()`; injectable so a test can simulate a
     *  foreign host without controlling the real machine name (mirrors
     *  {@link import("./fs-race-safe.js").IsHolderStaleOpts.hostname}). */
    hostname?: () => string;
  } = {},
): InflightSweepResult {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const myHost = (opts.hostname ?? hostname)();
  const result: InflightSweepResult = { reaped: [], kept: [], live: [], unverifiableForeignHost: [] };
  if (!existsSync(inflightDir)) return result;

  for (const entry of readdirSync(inflightDir)) {
    if (!entry.endsWith(".lock")) continue;
    const taskId = entry.slice(0, -".lock".length);
    const lockPath = inflightLockPath(inflightDir, taskId);
    const reclaim = reclaimStaleLock(lockPath, {
      parseHolder: parseInflightLockInfo,
      isStale: (held) =>
        isHolderStale(held, {
          isPidAlive: isAlive,
          getProcessStartTime: opts.getProcessStartTime,
          hostname: opts.hostname,
        }),
      onLostReclaim: opts.onLostReclaim,
      beforeDelete: opts.__beforeReclaimDelete,
    });
    if (reclaim.outcome === "reclaimed") {
      result.reaped.push(taskId);
      continue;
    }
    // "live" (a real holder — split below), "missing" (already gone), or "lost" (raced with a
    // real acquire that reclaimed it first) — none of these is a reap this sweep performed, so
    // count it as kept rather than claiming one that did not happen.
    result.kept.push(taskId);
    if (reclaim.outcome === "live") {
      // Mirror isHolderStale's rung 1 EXACTLY (same `myHost`, same "absent host ⇒ skip the
      // check" reading) so the split can never disagree with the predicate that already decided
      // this lock was not reaped: a foreign host is UNVERIFIABLE, not confirmed alive.
      if (reclaim.holder.host !== undefined && !sameHost(reclaim.holder.host, myHost)) {
        result.unverifiableForeignHost.push(taskId);
      } else {
        result.live.push(taskId);
      }
    }
    // "missing"/"lost" carry no holder to classify — counted in `kept` only, as before.
  }
  return result;
}

/** The step the daemon writes for a host-written lock whose run is silent past the measured bound (W1-T12316). */
export const HOST_LOCK_SILENT_STEP = "daemon.inflight_host_lock_silent";

/** W1-T12316: a lock a host process wrote. Its pid is in the host's pid table, which a container
 *  cannot read, so only host-side code may test it. A container id is never one. */
export function isHostWrittenLock(lock: Pick<InflightLockInfo, "host">, myHost: string = hostname()): boolean {
  if (typeof lock.host !== "string" || sameHost(lock.host, myHost)) return false;
  return !/^(?:[0-9a-f]{12}|[0-9a-f]{64})$/.test(lock.host);
}

export interface HostLockSilence {
  /** The time of the newest row of the lock's run, or the lock's `startedAt` when the run wrote none. */
  newestRowTs?: string;
  silentMs: number;
  /** The longest closed quiet gap in the rows; absent with no closed gap. */
  boundMs?: number;
  boundSource: "observed_quiet_gaps" | "no_history";
  boundSamples: number;
  /** True only when a measured bound exists and the run is silent past it. */
  silent: boolean;
}

/** W1-T12316: how long the lock's run has been silent, against the longest closed quiet gap of any
 *  run in `rows`. A statistic of the data, never a fixed time: with no closed gap nothing is silent. */
export function hostLockSilence(lock: InflightLockInfo, rows: ReadonlyArray<Record<string, unknown>>, nowMs: number): HostLockSilence {
  const byRun = new Map<string, number[]>();
  for (const row of rows) {
    if (row.step === HOST_LOCK_SILENT_STEP || typeof row.run_id !== "string" || typeof row.ts !== "string") continue;
    const ms = Date.parse(row.ts);
    if (!Number.isFinite(ms)) continue;
    const list = byRun.get(row.run_id);
    if (list) list.push(ms);
    else byRun.set(row.run_id, [ms]);
  }
  let boundMs: number | undefined;
  let boundSamples = 0;
  for (const list of byRun.values()) {
    list.sort((a, b) => a - b);
    for (let i = 1; i < list.length; i++) {
      const gap = list[i]! - list[i - 1]!;
      boundSamples += 1;
      if (boundMs === undefined || gap > boundMs) boundMs = gap;
    }
  }
  const own = byRun.get(lock.run_id);
  const started = Date.parse(lock.startedAt);
  const newestMs = own && own.length > 0 ? own[own.length - 1]! : started;
  const silentMs = Number.isFinite(newestMs) ? Math.max(0, nowMs - newestMs) : 0;
  const newestRowTs = own && own.length > 0 ? fixedClock(newestMs).iso() : Number.isFinite(started) ? lock.startedAt : undefined;
  return {
    newestRowTs,
    silentMs,
    boundMs,
    boundSource: boundMs === undefined ? "no_history" : "observed_quiet_gaps",
    boundSamples,
    silent: boundMs !== undefined && boundMs > 0 && newestRowTs !== undefined && silentMs > boundMs,
  };
}
