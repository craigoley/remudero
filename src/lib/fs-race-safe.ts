import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

// Why: the four CodeQL rounds this helper closed — docs/forensics/fs-race-safe.md#module-header.
/**
 * The `js/file-system-race`-safe idiom for a state file created ONCE and read on every later call
 * — config.ts's `loadConfig`, worker-home.ts's `ensureWorkerKeychain`, and, via this helper,
 * serve.ts's `resolveServiceTokens`. {@link createOrReadExclusive} opens with `O_CREAT|O_EXCL` in
 * one syscall — no separate existence check a peer could race between. Success hands back the
 * descriptor so the caller writes through it directly; EEXIST reads the file back through a
 * fresh descriptor, never `existsSync`-then-`readFileSync(path, ...)`.
 * FALSIFIER: test/fs-race-alerts.test.ts.
 */
export type CreateOrReadResult = { created: true; fd: number } | { created: false; raw: string };

/** Attempts before giving up on the create/read flip-flop below. Two already covers any realistic
 *  interleaving — a retry needs a peer to have both created and unlinked the file since our last
 *  syscall — so this only stops a pathological peer from spinning this process forever. */
const CREATE_OR_READ_ATTEMPTS = 3;

/** The three syscalls this helper makes, injectable so a test can drive the check-then-act
 *  WINDOW deterministically. Appended LAST so no positional caller shifts. */
export interface FsRaceSyscalls {
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  closeSync: typeof closeSync;
}

export function createOrReadExclusive(
  path: string,
  mode: number,
  fsImpl: FsRaceSyscalls = { openSync, readFileSync, closeSync },
): CreateOrReadResult {
  // Why: a two-syscall create-then-read isn't atomic together — this retry answers the CodeQL
  // alert on that window rather than asserting it away (alert #84; docs/forensics/fs-race-safe.md).
  for (let attempt = 1; ; attempt++) {
    let fd: number | undefined;
    try {
      fd = fsImpl.openSync(path, "wx", mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd !== undefined) {
      return { created: true, fd };
    }
    let readFd: number;
    try {
      readFd = fsImpl.openSync(path, "r");
    } catch (err) {
      // ENOENT here is the check-then-act window: it existed for the `wx`, gone by the read.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= CREATE_OR_READ_ATTEMPTS) throw err;
      continue;
    }
    try {
      return { created: false, raw: fsImpl.readFileSync(readFd, "utf8") as string };
    } finally {
      fsImpl.closeSync(readFd);
    }
  }
}

/** Reads a file's contents, or `undefined` if it doesn't exist — one `readFileSync` guarded by a
 *  catch on `ENOENT`, never a separate `existsSync` check (the create side's own TOCTOU shape).
 *  Why: replaces separate private copies in run-task.ts and panel-graph.ts —
 *  docs/forensics/fs-race-safe.md#readfileifexists. */
export function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "ENOENT") return undefined;
    throw e;
  }
}

// ── reclaimStaleLock: the shared "read a dead-holder lock and clear it" idiom ──
// Why: the double-reclaim race four call sites once duplicated — docs/forensics/fs-race-safe.md#reclaimstalelock-banner.

/** A file's on-disk identity at the moment it was read — `dev`+`ino` from `fstat` on the
 *  descriptor used for that read. Two of these being equal proves "this is still exactly the
 *  inode I read", which is what {@link reclaimStaleLock} conditions its delete on. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface ReclaimStaleLockSyscalls extends FsRaceSyscalls {
  fstatSync: typeof fstatSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
}

const defaultReclaimSyscalls: ReclaimStaleLockSyscalls = {
  openSync,
  readFileSync,
  closeSync,
  fstatSync,
  statSync,
  unlinkSync,
};

export type ReclaimStaleLockResult<Holder> =
  | { outcome: "missing" }
  | { outcome: "live"; holder: Holder }
  | { outcome: "reclaimed" }
  | { outcome: "lost" };

export interface ReclaimStaleLockOpts<Holder> {
  /** Parse raw lock file contents into a holder record, or `null` for missing/garbage (treated
   *  the same as "no valid holder" everywhere this is called). */
  parseHolder: (raw: string) => Holder | null;
  /** True when `holder` names a dead process — safe to reclaim. */
  isStale: (holder: Holder) => boolean;
  /** Called whenever a reclaim could NOT complete — another reclaimer won the race, or the lock
   *  vanished. Defaults to `console.error`, so this stops being silent. Never throws itself. */
  onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
  /** Called with the lock's path and full raw bytes immediately BEFORE the unlink that clears
   *  it, never after (W1-T1067 design (v)): erasing the only evidence of a judgment without
   *  recording it first is unauditable exactly when it matters most. Defaults to
   *  `console.error`. Never throws itself. */
  onReclaim?: (detail: { lockPath: string; raw: string }) => void;
  /** TEST-ONLY seam, invoked once the holder is judged stale but before the delete-time identity
   *  check runs — a test uses it to run a second reclaimer's whole flow first, so the identity
   *  check below must then find the file changed and refuse to delete it. */
  beforeDelete?: () => void;
}

function defaultOnLostReclaim(detail: { lockPath: string; reason: string }): void {
  console.error(`[reclaimStaleLock] ${detail.lockPath}: ${detail.reason}`);
}

function defaultOnReclaim(detail: { lockPath: string; raw: string }): void {
  console.error(`[reclaimStaleLock] ${detail.lockPath}: reclaiming stale holder before unlink: ${detail.raw}`);
}

// Why: the identity-plus-bytes design, the inode-reuse window it still leaves open, and the
// print-before-clear rule — docs/forensics/fs-race-safe.md#reclaimstalelock (W1-T1067 design (v)).
/**
 * Reclaims `lockPath` only when the holder read from it is confirmed stale AND the file is still
 * the exact bytes+inode read at that moment — the shared primitive behind every "read a lock, and
 * if its holder is dead, clear it" call site: {@link import("./inflight-lock.js").acquireInflightLock},
 * {@link import("./drain-lock.js").acquireDrainLock}, {@link import("./review.js").acquireReviewStatusLock},
 * and the boot sweep {@link import("./inflight-lock.js").sweepStaleInflightLocks}. The delete is
 * conditioned on identity, not the path string: `{dev, ino}` is captured from the same descriptor
 * the stale read used, then re-checked by a fresh `stat`+read right before the unlink. A mismatch
 * in dev, ino, or the raw bytes means another actor already reclaimed or recreated the lock, so
 * this call backs off with `{outcome: "lost"}` instead of deleting whatever is there now; the
 * caller's own acquire loop simply retries from the top. `stat`-then-`unlink` is still two
 * syscalls, not one atomic one — a brand-new file landing on this exact path with the SAME
 * `(dev, ino)` in that narrow window remains possible, though far narrower than the unconditional
 * delete this replaces.
 * FALSIFIER: test/lock-reclaim-race.test.ts, test/drain-lock-restart-reclaim.test.ts.
 */
export function reclaimStaleLock<Holder>(
  lockPath: string,
  opts: ReclaimStaleLockOpts<Holder>,
  fsImpl: ReclaimStaleLockSyscalls = defaultReclaimSyscalls,
): ReclaimStaleLockResult<Holder> {
  const onLostReclaim = opts.onLostReclaim ?? defaultOnLostReclaim;
  const onReclaim = opts.onReclaim ?? defaultOnReclaim;

  let readFd: number;
  try {
    readFd = fsImpl.openSync(lockPath, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "missing" };
    throw e;
  }
  let raw: string;
  let readIdentity: FileIdentity;
  try {
    raw = fsImpl.readFileSync(readFd, "utf8") as string;
    const st = fsImpl.fstatSync(readFd); // same fd as the read above — no re-resolve window
    readIdentity = { dev: st.dev, ino: st.ino };
  } finally {
    fsImpl.closeSync(readFd);
  }

  const holder = opts.parseHolder(raw);
  if (holder !== null && !opts.isStale(holder)) {
    return { outcome: "live", holder };
  }

  // Stale or unparseable — either way reclaimable. TEST SEAM: let a test run a second
  // reclaimer's whole flow here, before this call's own identity check.
  opts.beforeDelete?.();

  // Why: dev+ino alone doesn't close this race — measured ext4 inode reuse — so the bytes
  // comparison below is what actually detects a same-inode swap (docs/forensics/fs-race-safe.md).
  let deleteIdentity: FileIdentity;
  let deleteRaw: string;
  try {
    const st = fsImpl.statSync(lockPath);
    deleteIdentity = { dev: st.dev, ino: st.ino };
    const delFd = fsImpl.openSync(lockPath, "r");
    try {
      deleteRaw = fsImpl.readFileSync(delFd, "utf8") as string;
    } finally {
      fsImpl.closeSync(delFd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    onLostReclaim({ lockPath, reason: "lock vanished between the stale read and the delete-time identity check" });
    return { outcome: "lost" };
  }

  if (deleteIdentity.dev !== readIdentity.dev || deleteIdentity.ino !== readIdentity.ino || deleteRaw !== raw) {
    onLostReclaim({
      lockPath,
      reason:
        "the file at this path changed identity since the stale read — another actor already reclaimed or " +
        "recreated it; refusing to delete what is there now",
    });
    return { outcome: "lost" };
  }

  // Print before clearing (design (v)): the only copy of what was judged is set down here,
  // before the syscall that would otherwise remove it unrecorded.
  onReclaim({ lockPath, raw: deleteRaw });

  try {
    fsImpl.unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    onLostReclaim({ lockPath, reason: "lock vanished between the identity check and the unlink" });
    return { outcome: "lost" };
  }
  return { outcome: "reclaimed" };
}

// ── isHolderStale: the one predicate for "does this lock still name a real holder?" ──
// Why: the pid-reuse and cross-host incidents behind each rung — docs/forensics/fs-race-safe.md#isholderstale-banner.

/** The identity a lock file already records for its holder — the subset every consumer's parsed
 *  holder type (`InflightLockInfo`, `DrainLockInfo`, ...) structurally satisfies. */
export interface HolderIdentity {
  pid: number;
  /** `os.hostname()` of the process that wrote the lock, when the holder shape records one.
   *  Absent ⇒ the host check below is skipped (pre-W1-T368 behaviour). */
  host?: string;
  /** ISO timestamp the holder wrote at creation. Absent ⇒ the start-time check below is skipped
   *  (pre-W1-T368 behaviour). */
  startedAt?: string;
}

export interface IsHolderStaleOpts {
  /** True when `held.pid` names a process that exists RIGHT NOW — says nothing about whether it
   *  is the process that wrote the lock. Required: every call site already has one. */
  isPidAlive: (pid: number) => boolean;
  /** Epoch ms `held.pid` actually started, or `null` when indeterminate. Defaults to
   *  {@link defaultGetProcessStartTime}. */
  getProcessStartTime?: (pid: number) => number | null;
  /** This host's own identity, compared against `held.host`. Defaults to `os.hostname()`;
   *  injectable so a test can simulate a different host without controlling the real machine. */
  hostname?: () => string;
  /** True when THIS process runs inside a container — the same `/.dockerenv` marker
   *  `resolveHostPole` (host-parity.ts) keys on (W1-T978). Defaults to {@link defaultInContainer};
   *  see {@link isHolderStale}'s own doc for why this matters. */
  inContainer?: () => boolean;
}

/** A live pid's start time is trusted to within this many ms of the lock's own `startedAt`
 *  before the gap counts as reuse rather than probe noise — `ps -o etime=` only has whole-second
 *  resolution, while `startedAt` carries milliseconds. */
const STALE_START_TOLERANCE_MS = 2000;

/** True when `host` is shaped like a Docker container id (12 or 64 lowercase hex chars) — the
 *  same shape `os.hostname()` returns inside a container. Guards rung 1 below from treating an
 *  arbitrary or human-named host as "an earlier boot of this cell" merely because this process
 *  happens to be containerized.
 *  Why: the outage this shape check closes — docs/forensics/fs-race-safe.md#lookslikecontainerid
 *  (W1-T978). */
function looksLikeContainerId(host: string): boolean {
  return /^[0-9a-f]{12}$/.test(host) || /^[0-9a-f]{64}$/.test(host);
}

// Why: the container-restart incident and the pid-reuse ordering bug each rung below fixes —
// docs/forensics/fs-race-safe.md#isholderstale (W1-T396, W1-T978, W1-T1067).
/**
 * Is `held` stale — safe to reclaim, sweep, or treat as not-running — or a genuinely live
 * holder? The one predicate every {@link reclaimStaleLock} caller and `deriveStatus`'s own
 * inflight-lock check share, checked in three rungs, each answering what it can and deferring
 * what it can't rather than guessing: (1) Host — a `held.host` naming a different host is never
 * stale, since a pid means nothing off the host that assigned it, UNLESS this process is
 * containerized and `held.host` is shaped like a container id, in which case it names an earlier
 * boot of this same cell. (2) Boot — a `held.startedAt` older than this container's own boot
 * (pid 1's start time) is dead by construction: no process from an earlier boot exists in this
 * boot's pid namespace. (3) Pid — dead ⇒ stale; alive ⇒ an actual start time later than
 * `held.startedAt` means the pid number was reused by a different process. Rung order is
 * load-bearing (W1-T396): a foreign pid must never fall through to rungs 2/3, which reason only
 * about this host's own process table.
 * FALSIFIER: test/lock-holder-identity.test.ts, test/stale-lock-host-ordering.test.ts,
 * test/a-lock-whose-container-is-gone-is-reclaimed-not-waited-on.test.ts, test/drain-lock-restart-reclaim.test.ts.
 */
export function isHolderStale(held: HolderIdentity, opts: IsHolderStaleOpts): boolean {
  // Rung 1 — host, first (W1-T396): a foreign pid answers a question our own process table
  // was never asked. A container restart replaces the host id, not necessarily the holder.
  if (held.host !== undefined) {
    const myHost = (opts.hostname ?? hostname)();
    if (held.host !== myHost) {
      const inContainer = (opts.inContainer ?? defaultInContainer)();
      return inContainer && looksLikeContainerId(held.host);
    }
  }

  // Boot rung (W1-T1067), between rungs 1 and 2: a lock older than this container's own boot
  // is dead by construction — a fresh pid namespace starts from 1, so its recorded pid could
  // otherwise alias a live, unrelated process in the new boot.
  if (held.startedAt !== undefined) {
    const getStart = opts.getProcessStartTime ?? defaultGetProcessStartTime;
    const bootTime = getStart(1); // pid 1 is this container's own boot clock
    if (bootTime !== null) {
      const lockStart = Date.parse(held.startedAt);
      if (!Number.isNaN(lockStart) && lockStart < bootTime - STALE_START_TOLERANCE_MS) {
        return true; // this lock predates the boot it would have to be running in
      }
    }
  }

  if (!opts.isPidAlive(held.pid)) return true; // rung 2

  if (held.startedAt !== undefined) {
    const getStart = opts.getProcessStartTime ?? defaultGetProcessStartTime;
    const liveStart = getStart(held.pid);
    if (liveStart !== null) {
      const lockStart = Date.parse(held.startedAt);
      if (!Number.isNaN(lockStart) && liveStart - lockStart > STALE_START_TOLERANCE_MS) {
        return true; // rung 3: this pid started AFTER the lock — a different, newer process
      }
    }
  }

  return false;
}

/** The one syscall {@link defaultGetProcessStartTime} makes, injectable so a test can drive its
 *  parsing/error handling without a real subprocess (mirrors {@link FsRaceSyscalls}). */
export interface ProcessStartTimeSyscalls {
  execFileSync: typeof execFileSync;
}

const defaultProcessStartTimeSyscalls: ProcessStartTimeSyscalls = { execFileSync };

/** `ps -o etime=`'s `[[DD-]HH:]MM:SS` elapsed-time format, in ms — or `null` for anything that
 *  doesn't match (never thrown: an unrecognized shape is indeterminate, not an error). */
function parseEtimeToMs(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const minutes = parseInt(m[3], 10);
  const seconds = parseInt(m[4], 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Default {@link IsHolderStaleOpts.getProcessStartTime}: shells to `ps -o etime=`, the one
 *  process-age mechanism both this repo's platforms (BSD `ps` on macOS, GNU `ps` in CI) support.
 *  Returns `null` — indeterminate, NOT "dead" — for a pid `ps` can't find or output it can't
 *  parse; {@link isHolderStale} already treats `null` as no evidence either way.
 *  Why: why elapsed time was chosen over wall-clock start time — docs/forensics/fs-race-safe.md#defaultgetprocessstarttime. */
export function defaultGetProcessStartTime(
  pid: number,
  sysImpl: ProcessStartTimeSyscalls = defaultProcessStartTimeSyscalls,
): number | null {
  let raw: string;
  try {
    raw = sysImpl.execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }) as string;
  } catch {
    return null;
  }
  const elapsedMs = parseEtimeToMs(raw);
  return elapsedMs === null ? null : Date.now() - elapsedMs;
}

/** The one syscall {@link defaultInContainer} makes, injectable so a test can drive it without a
 *  real container (mirrors {@link FsRaceSyscalls} and {@link ProcessStartTimeSyscalls}). */
export interface ContainerProbeSyscalls {
  existsSync: typeof existsSync;
}

const defaultContainerProbeSyscalls: ContainerProbeSyscalls = { existsSync };

/** Default {@link IsHolderStaleOpts.inContainer}: checks for `/.dockerenv`, Docker's own
 *  container marker — the same signal `resolveHostPole` (host-parity.ts) keys on. */
export function defaultInContainer(sysImpl: ContainerProbeSyscalls = defaultContainerProbeSyscalls): boolean {
  return sysImpl.existsSync("/.dockerenv");
}

// ── W1-T2899: one atomic write ───────────────────────────────────────────────
//
// MEASURED at 5c5e21aa: six private copies of this (ledger.ts, four under onboard/,
// github-event-wake.ts) and no export from the module that owns the lock primitives. The
// deployer's markers used none of them — a bare writeFileSync, so a marker torn by a crash
// mid-write is read by the next boot as corrupt or empty deploy state.
//
// FALSIFIER: test/write-atomic.test.ts.

/**
 * The syscalls {@link writeAtomic} makes. Injectable so a caller with its own fs seam — the
 * onboard phases' FsDeps — keeps the spy its own tests assert on.
 *
 * ONLY THE DEFAULT IO FSYNCS, and that is a real difference rather than a detail: flushing needs
 * a descriptor, which a `writeFileSync`-shaped seam does not have. An injected seam is atomic BY
 * RENAME but not durable across a power loss. Callers needing durability take the default.
 */
export interface WriteAtomicIo {
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  /** `mode` is the stage's creation mode; only the default io can honour one. */
  writeFileSync: (path: string, content: string | Buffer, mode?: number) => void;
  renameSync: (from: string, to: string) => void;
  /**
   * Removes a stage that will not be renamed. OPTIONAL, and its absence is stated rather than
   * faked: a three-syscall seam cannot remove anything, and a `() => {}` would type as a cleanup
   * that runs while doing nothing. Absent, the stage is left behind exactly as the private copies
   * this replaced left it.
   */
  rmSync?: (path: string, opts: { force: true }) => void;
}

/** The three syscalls every injected fs seam in this repo already has — the onboard phases'
 *  `OnboardFsDeps`/`ReconFsDeps`/`SessionFsDeps`/`SynthesizeFsDeps` are each a superset. */
export interface WriteAtomicSeam {
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  writeFileSync: (path: string, content: string) => void;
  renameSync: (from: string, to: string) => void;
}

/** Adapts an injected seam to {@link WriteAtomicIo} so a caller that must keep its own spy still
 *  writes through the one primitive — otherwise each such caller open-codes the adapter, which is
 *  the duplication this task removes. Buffer content is encoded utf8 because a string-only seam
 *  has nowhere to put bytes; every caller of this adapter writes text. No `rmSync`: see above. */
export function writeAtomicIoFrom(seam: WriteAtomicSeam): WriteAtomicIo {
  return {
    mkdirSync: (path, opts) => seam.mkdirSync(path, opts),
    writeFileSync: (path, content, mode) => {
      // REFUSED, never silently dropped: a mode is a security property (github-event-wake's
      // replay state is 0o600) and a seam that cannot set one must say so, not write 0o644.
      if (mode !== undefined) throw new Error("writeAtomicIoFrom: an injected seam cannot set a file mode");
      seam.writeFileSync(path, typeof content === "string" ? content : content.toString("utf8"));
    },
    renameSync: (from, to) => seam.renameSync(from, to),
  };
}

/** The syscalls the default io makes, injectable for the same reason {@link FsRaceSyscalls} is: a
 *  SHORT `writeSync` cannot be provoked through the real syscall on a regular file, so the arm that
 *  catches one is unreachable — and therefore untested — unless something can stand in for it. */
export interface WriteAtomicSyscalls {
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
}

/** The default io over `sys`: open the stage, write it whole, flush, close. A short write THROWS
 *  rather than logging — the copy this replaces only `console.error`d one, which leaves a truncated
 *  stage to be renamed over the real file, the exact tear the primitive exists to prevent. */
export function realWriteAtomicIoOver(sys: WriteAtomicSyscalls): WriteAtomicIo {
  return {
    mkdirSync: (path, opts) => sys.mkdirSync(path, opts),
    writeFileSync: (path, content, mode) => {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      const fd = mode === undefined ? sys.openSync(path, "w") : sys.openSync(path, "w", mode);
      try {
        const written = sys.writeSync(fd, buf, 0, buf.length);
        if (written !== buf.length) {
          throw new Error(`writeAtomic: short write staging ${path} (${written}/${buf.length} bytes)`);
        }
        sys.fsyncSync(fd);
      } finally {
        sys.closeSync(fd); // the fd is released even on the short-write throw
      }
    },
    renameSync: (from, to) => sys.renameSync(from, to),
    rmSync: (path, opts) => sys.rmSync(path, opts),
  };
}

/** The real syscalls, flushing before rename. */
export const realWriteAtomicIo: WriteAtomicIo = realWriteAtomicIoOver({
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
});

/**
 * Write `content` to `path` atomically: stage in the SAME directory, then rename. Same directory
 * because rename is only atomic within one filesystem — every copy this replaces assumed that
 * without saying it.
 *
 * `beforeRename` is the ledger rotation's check-then-act window (it re-stats the live file and
 * withdraws if the path no longer holds the snapshot it staged from). Returning false removes the
 * stage, leaves the original untouched, and returns false.
 *
 * `mode` is applied to the STAGE, which the rename then carries onto the destination — the only
 * order that never leaves a secret readable, even briefly, at the final path.
 */
export function writeAtomic(
  path: string,
  content: string | Buffer,
  opts: { io?: WriteAtomicIo; beforeRename?: () => boolean; tmpTag?: string; mode?: number } = {},
): boolean {
  const io = opts.io ?? realWriteAtomicIo;
  io.mkdirSync(dirname(path), { recursive: true });
  const tag = opts.tmpTag ?? "tmp";
  const tmpPath = `${path}.${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    io.writeFileSync(tmpPath, content, opts.mode);
    if (opts.beforeRename && !opts.beforeRename()) {
      io.rmSync?.(tmpPath, { force: true }); // withdraw the stage; leave nothing behind
      return false;
    }
    io.renameSync(tmpPath, path);
    return true;
  } catch (error) {
    // Lifted from writeSweepWakeMarkerAtomic, the one copy that had it. The cleanup's own
    // failure is swallowed (the temp may never have been created) so the ORIGINAL error is
    // what propagates; losing that would be a regression for that caller.
    try {
      io.rmSync?.(tmpPath, { force: true });
    } catch {
      // preserve the original error
    }
    throw error;
  }
}
