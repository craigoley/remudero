import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";

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

  let deleteIdentity: FileIdentity;
  try {
    const st = fsImpl.statSync(lockPath);
    deleteIdentity = { dev: st.dev, ino: st.ino };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    onLostReclaim({ lockPath, reason: "lock vanished between the stale read and the delete-time identity check" });
    return { outcome: "lost" };
  }

  if (deleteIdentity.dev !== readIdentity.dev || deleteIdentity.ino !== readIdentity.ino) {
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
