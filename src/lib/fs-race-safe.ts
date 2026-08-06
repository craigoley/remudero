import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";

/**
 * The `js/file-system-race`-safe idiom this repo has now shipped for a state file that is
 * created ONCE and read on every later call (config.ts's `loadConfig`, worker-home.ts's
 * `ensureWorkerKeychain`, and — via this shared helper — serve.ts's `resolveServiceTokens`).
 * CodeQL alerts #15/#16 (round 1), #24 (round 2), #71 (round 3), and #60/#61 (round 4, this
 * task) all trace back to the SAME check-then-act shape at a different call site:
 * `existsSync`-then-write on create, or a bare `readFileSync(path, ...)` re-checking the path
 * string on the fallback read. Folding create-or-read into ONE shared helper means a future
 * "first boot writes a state file" site reuses tested code instead of open-coding a fifth copy.
 *
 * Attempts an exclusive `O_CREAT|O_EXCL` ("wx") open at `path` in ONE syscall — no separate
 * existence check that a second process could race between check and write. On success, the
 * open file descriptor is handed back (`created: true`) so the CALLER writes its own freshly
 * generated content through that SAME descriptor — never a path re-open, so there is no window
 * where a later syscall could re-resolve `path` to something else. The caller owns closing it.
 *
 * On EEXIST — the file already exists, whether a concurrent first-provisioner won the race or
 * this is simply the second-and-later boot — this reads it back through a FRESH read descriptor
 * (`openSync(path, "r")` + `readFileSync(fd, ...)`), never `existsSync`-then-`readFileSync(path,
 * ...)`. Reading through the descriptor rather than re-checking the path is what the CodeQL
 * query's own recommendation asks for on the READ itself.
 *
 * BUT THE FALLBACK READ DOES RE-RESOLVE THE PATH, and an earlier revision of this header claimed
 * otherwise. `openSync(path, "r")` resolves `path` by name a second time, so the sequence
 * "`wx` proved it exists" → "open it" is a genuine check-then-act window: a peer that unlinks in
 * between made this helper throw ENOENT out of the very function meant to make the sequence
 * safe. CodeQL flagged exactly that (alert #84, `js/file-system-race`, on the fallback read) and
 * it was RIGHT. {@link createOrReadExclusive} therefore RETRIES rather than asserting the window
 * away — see its body. The flag is answered with code, not with a dismissal.
 *
 * Any other open error (e.g. `EISDIR` from a misconfigured path) propagates unchanged — it is
 * never swallowed as if it were a benign race.
 */
export type CreateOrReadResult = { created: true; fd: number } | { created: false; raw: string };

/**
 * Attempts before giving up on the create/read flip-flop below. Each iteration requires a
 * CONCURRENT writer to have both created and unlinked the file since our previous syscall, so
 * two attempts already covers any realistic interleaving; the bound exists so a pathological
 * peer (a loop that unlinks the file continuously) surfaces its own ENOENT rather than
 * spinning this process forever.
 */
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
  // THE TWO SYSCALLS ARE INDIVIDUALLY ATOMIC BUT NOT ATOMIC TOGETHER, so the flip-flop is
  // retried rather than assumed away. `wx` failing EEXIST proves the file existed AT THAT
  // INSTANT; it does not prove it still exists when the fallback read opens it. If a peer
  // unlinks in that window the read raises ENOENT — which the previous shape let escape as a
  // crash from a helper whose whole purpose is to make this sequence safe. Looping turns that
  // window into "someone else's file went away, so try to become the creator ourselves",
  // which is the only correct answer and the reason CodeQL's js/file-system-race flag on the
  // fallback read is answerable with code rather than with a dismissal.
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
      // ENOENT here is precisely the check-then-act window: it existed for the `wx`, and was
      // gone by the read. Retry — on the next pass we are very likely the creator.
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

/**
 * Read a file's contents, or `undefined` if it doesn't exist — a single `readFileSync` guarded
 * by a catch on `ENOENT`, NOT a separate `existsSync` check-then-read (the latter is the same
 * `js/file-system-race` TOCTOU shape as the create side: a second process can create or delete
 * the file between the check and the read). This is the ONE shared helper for "read this state
 * file if it happens to exist yet" call sites — relocated here from `src/run-task.ts`, which had
 * it as a private function, so future callers reuse it instead of open-coding another private
 * copy (a second one had already appeared, independently, in `src/lib/panel-graph.ts`).
 */
export function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "ENOENT") return undefined;
    throw e;
  }
}

// ── reclaimStaleLock: the ONE shared "read a dead-holder lock and clear it" idiom ──
//
// W1-T289. Four call sites (inflight-lock.ts, drain-lock.ts, review.ts's mutex, and the
// boot sweep in inflight-lock.ts) each did the same shape: read a lock, decide its holder
// is dead, then `unlinkSync(lockPath)` UNCONDITIONALLY. The create half of these locks is
// genuinely atomic (`O_EXCL`), but that unlink is a SEPARATE syscall conditioned on
// NOTHING — not on the file still being the same dead lock that was just read. Two
// reclaimers of one dead lock could both decide "stale"; the first to unlink+recreate wins
// a FRESH LIVE lock, and the second's unconditional unlink then deletes THAT, not the dead
// lock it actually judged — so both come away believing they hold it.

/** A file's on-disk identity at the moment it was read — `dev`+`ino` from `fstat` on the
 *  descriptor used for that read. Two of these being equal proves "this is still exactly
 *  the inode I read", which is what {@link reclaimStaleLock} conditions its delete on. */
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
  /** Parse raw lock file contents into a holder record, or `null` for missing/garbage
   *  (garbage is treated the same as "no valid holder" everywhere this is called). */
  parseHolder: (raw: string) => Holder | null;
  /** True when `holder` names a dead process — safe to reclaim. */
  isStale: (holder: Holder) => boolean;
  /** Called whenever a reclaim attempt could NOT complete: this call lost the race to
   *  another reclaimer (the identity check found the file already changed, or it vanished
   *  outright). Defaults to `console.error` — the same "leave a visible trace rather than
   *  swallow it" precedent `ledger.ts` uses for its own write failure — so the empty
   *  catches this primitive replaces stop being silent. Never throws itself. */
  onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
  /** TEST-ONLY seam: invoked once the read has judged the current holder stale, BEFORE the
   *  delete-time identity check runs — exactly the window the TOCTOU lived in. A test uses
   *  it to run a second reclaimer's ENTIRE flow to completion first (so it unlinks and
   *  recreates a fresh live lock), then lets this call proceed: its identity check must
   *  then find the path no longer matches what it read, and refuse to delete it. */
  beforeDelete?: () => void;
}

function defaultOnLostReclaim(detail: { lockPath: string; reason: string }): void {
  console.error(`[reclaimStaleLock] ${detail.lockPath}: ${detail.reason}`);
}

/**
 * Safely reclaim `lockPath` if, and only if, the holder read from it is confirmed stale
 * AND the file at `lockPath` is STILL the exact inode that read came from at the moment of
 * deletion. This is the shared primitive behind every "read a lock, and if its holder is
 * dead, clear it" call site: {@link import("./inflight-lock.js").acquireInflightLock},
 * {@link import("./drain-lock.js").acquireDrainLock},
 * {@link import("./review.js").acquireReviewStatusLock}, and the boot sweep
 * {@link import("./inflight-lock.js").sweepStaleInflightLocks}.
 *
 * THE FIX: the delete is conditioned on file IDENTITY, not merely on the path string. The
 * SAME descriptor opened to do the stale-holder READ is `fstat`'d, right after the read,
 * BEFORE it is closed — so the `{dev, ino}` captured is guaranteed to be the identity of
 * the EXACT bytes this call judged dead, never a separately re-resolved path. Immediately
 * before deleting, the path is `stat`'d fresh (by name, since we need to know what is
 * THERE NOW, not what our old descriptor still points to); the unlink proceeds ONLY if
 * `dev`+`ino` still match. If they don't — or the path is gone entirely —
 * another actor already reclaimed (or recreated) it, so this call backs off with
 * `{outcome: "lost"}` rather than deleting whatever is there now. The caller's own acquire
 * loop simply retries from the top, which re-reads the CURRENT state fresh.
 *
 * HONEST ABOUT THE REMAINING WINDOW: `stat`-then-`unlink` is still two syscalls, not one
 * indivisible one — POSIX `unlink(2)` has no compare-and-delete form. What remains is "a
 * brand-new, unrelated file lands on this exact path AND is assigned the SAME (dev, ino)
 * pair as what we just read, in between this call's final `stat` and its `unlink`" — inode
 * reuse within a handful of in-process syscalls. That is categorically narrower than the
 * bug this replaces, which was unconditional: ANY interleaving hit it, not only inode
 * reuse on an already-freed inode landing back on this path in a single-digit-syscall
 * window.
 */
export function reclaimStaleLock<Holder>(
  lockPath: string,
  opts: ReclaimStaleLockOpts<Holder>,
  fsImpl: ReclaimStaleLockSyscalls = defaultReclaimSyscalls,
): ReclaimStaleLockResult<Holder> {
  const onLostReclaim = opts.onLostReclaim ?? defaultOnLostReclaim;

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

  // Stale (dead pid) or garbage/unparseable — either way, reclaimable. TEST SEAM: let a
  // test run a second reclaimer's whole flow here, before this call's identity check.
  opts.beforeDelete?.();

  // IDENTITY IS `dev`+`ino` **AND THE BYTES** — dev+ino ALONE DOES NOT CLOSE THIS RACE.
  // Measured on ext4 (this repo's CI and Linux hosts): unlink followed immediately by a create
  // in the same directory REUSES the just-freed inode — a probe writing, unlinking and
  // rewriting one path read `ino=1957993` both times. So in the exact scenario this function
  // exists for (reclaimer A unlinks and recreates before B reaches its delete), B's dev+ino
  // check matches and B deletes A's LIVE lock: the TOCTOU, still open, with a check in front
  // of it that looks like a fix. The lock's own bytes carry the holder (a pid), so a
  // replacement writes different content; comparing them detects the swap that the inode
  // number cannot. Read through a single fd, like the stale read above, so the content and
  // the identity describe the same open file rather than two path re-resolutions.
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

  try {
    fsImpl.unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    onLostReclaim({ lockPath, reason: "lock vanished between the identity check and the unlink" });
    return { outcome: "lost" };
  }
  return { outcome: "reclaimed" };
}

// ── isHolderStale: THE ONE PREDICATE for "does this lock still name a real holder?" ──
//
// W1-T368. A bare `!isAlive(held.pid)` (the `isStale` every `reclaimStaleLock` call site
// used before this) answers "is SOME process currently using this number", never "is it the
// SAME process that wrote the lock". The pid space wraps (measured on the fleet host:
// kern.maxproc 4000, kern.maxprocperuid 2666), so a dead holder's number gets reissued in the
// ordinary course of things — and when that happens the recycled pid reads as LIVE forever,
// which both refuses every future acquire of the task it names (acquireInflightLock throws)
// and renders a dead run as RUNNING on the console (deriveStatus's third disjunct). Neither
// other field the lock already carries was ever compared: `host` not at all, `startedAt` never
// against anything.

/** The identity a lock file already records for its holder — the subset every consumer's
 *  parsed holder type (`InflightLockInfo`, `DrainLockInfo`, ...) structurally satisfies. */
export interface HolderIdentity {
  pid: number;
  /** `os.hostname()` of the process that wrote the lock, when the caller's holder shape
   *  records one. Absent ⇒ the host check below is skipped (pre-W1-T368 behaviour). */
  host?: string;
  /** ISO timestamp the holder wrote when it created the lock. Absent ⇒ the start-time check
   *  below is skipped (pre-W1-T368 behaviour). */
  startedAt?: string;
}

export interface IsHolderStaleOpts {
  /** True when `held.pid` names a process that exists RIGHT NOW — says nothing about whether
   *  it is the process that wrote the lock. Required: every call site already has one (its own
   *  `defaultIsPidAlive` or an injected test double). */
  isPidAlive: (pid: number) => boolean;
  /** Epoch ms `held.pid` actually started, or `null` when indeterminate (probe failed, `held.pid`
   *  is already dead, platform mechanism unavailable). Defaults to {@link defaultGetProcessStartTime}. */
  getProcessStartTime?: (pid: number) => number | null;
  /** This host's own identity, for comparison against `held.host`. Defaults to `os.hostname()`;
   *  injectable so a test can simulate "the lock names a different host" without controlling the
   *  real machine name. */
  hostname?: () => string;
}

/** A live pid's start time is trusted to within this many ms of the lock's own `startedAt`
 *  before the gap counts as reuse rather than probe noise. `ps -o etime=` only has whole-second
 *  resolution, while `startedAt` is an ISO timestamp with milliseconds — NOT a clock-skew
 *  allowance (the host check already refuses to compare start times across hosts at all). */
const STALE_START_TOLERANCE_MS = 2000;

/**
 * Is `held` stale — safe to reclaim, sweep, or treat as not-running — rather than a genuinely
 * live holder? The ONE predicate every `reclaimStaleLock` caller and `deriveStatus`'s own
 * inflight-lock disjunct now share (previously each kept its own copy of the weaker
 * pid-only check).
 *
 * THREE RUNGS, in order, each ANSWERING what it can and DEFERRING what it can't:
 *   1. `held.pid` is dead ⇒ stale. Unchanged from before this task — the common case.
 *   2. `held.pid` is alive, but `held.host` names a DIFFERENT host than this one: a pid is only
 *      ever meaningful on the host that assigned it, so `isPidAlive`'s answer describes an
 *      unrelated number in OUR process table, not the recorded holder's. Unresolvable from
 *      here ⇒ NOT judged stale (never reap a lock this process cannot actually verify —
 *      the same direction of caution `reclaimStaleLock`'s own "lost" outcome already takes).
 *   3. `held.pid` is alive on OUR host: compare its ACTUAL start time against `held.startedAt`.
 *      A pid reused by a new process necessarily starts AFTER the original holder wrote the
 *      lock (the original had to be running, and write the file, before it could die and free
 *      the number) — so "this pid started later than the lock claims" is exactly the reuse
 *      signal, decidable without waiting for a real wrap. If the start time can't be determined
 *      (probe failure — the pid could have died in the gap between rungs 1 and 3, `ps` missing,
 *      unparseable output), that is NOT evidence of staleness, so this rung defers too.
 *
 * HONEST ABOUT THE REMAINING WINDOW: this is still a REASON TO BELIEVE the holder is alive,
 * never proof. A cross-host lock is trusted with no verification at all (rung 2), and a
 * same-host reused pid that starts within `STALE_START_TOLERANCE_MS` of the original is
 * indistinguishable from the original (rung 3's whole-second `ps` resolution).
 */
export function isHolderStale(held: HolderIdentity, opts: IsHolderStaleOpts): boolean {
  if (!opts.isPidAlive(held.pid)) return true;

  if (held.host !== undefined) {
    const myHost = (opts.hostname ?? hostname)();
    if (held.host !== myHost) return false; // rung 2: unverifiable from here, so not stale
  }

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

/** The one syscall {@link defaultGetProcessStartTime} makes, injectable so a test can drive
 *  its parsing/error handling without a real subprocess (mirrors {@link FsRaceSyscalls}). */
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

/**
 * Default {@link IsHolderStaleOpts.getProcessStartTime}: shells out to `ps -o etime=`, whose
 * `[[DD-]HH:]MM:SS` elapsed-time column is the ONE process-age mechanism common to this repo's
 * two real platforms — verified directly rather than assumed: BSD `ps` (macOS, the dev host)
 * and GNU `ps` (`ubuntu-latest`, this repo's CI) both accept `-o etime=`, while GNU-only
 * `etimes`/`lstart` formatting differs enough between the two that elapsed time (this process's
 * age, computed against `Date.now()`) was chosen over wall-clock start time (which would need
 * locale-safe parsing of BSD's `lstart` string) to stay portable. Returns `null` — indeterminate,
 * NOT "dead" — for a pid `ps` can't find, a `ps` binary that isn't on PATH, or output this
 * doesn't recognize; {@link isHolderStale} already treats `null` as "no evidence either way".
 */
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
