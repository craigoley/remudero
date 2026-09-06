import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
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
  /** Called with the lock's own path and full raw bytes IMMEDIATELY BEFORE the unlink that
   *  clears it — never after (design (v), W1-T1067: "it must not clear a lock without printing
   *  it first"). A judgment that removes the only evidence of what it judged, without setting
   *  that evidence down anywhere first, is unauditable exactly when it matters most — a
   *  reclaim that turns out to have been wrong. Defaults to `console.error`, the same
   *  visible-trace precedent {@link defaultOnLostReclaim} already sets for a LOST reclaim, now
   *  extended to a SUCCESSFUL one. Never throws itself. */
  onReclaim?: (detail: { lockPath: string; raw: string }) => void;
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

function defaultOnReclaim(detail: { lockPath: string; raw: string }): void {
  console.error(`[reclaimStaleLock] ${detail.lockPath}: reclaiming stale holder before unlink: ${detail.raw}`);
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
 *
 * PRINTS THE LOCK IN FULL BEFORE REMOVING IT (W1-T1067 design (v), the same print-before-clear
 * discipline W1-T1036's `.git/config.lock` reclaimer already follows): {@link
 * ReclaimStaleLockOpts.onReclaim} runs with the lock's path and exact bytes right before the
 * unlink, so a reclaim is never judged silently — every caller gets this for free, since it is a
 * property of the shared primitive rather than of any one call site.
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

  // PRINT BEFORE CLEARING (design (v)): the only copy of what this call judged is about to be
  // unlinked, so it is set down here, before the syscall that would otherwise remove it
  // unrecorded — never after, when a crash between the two would leave nothing to explain the
  // judgment at all.
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
  /** W1-T978. True when THIS process is running inside a container — Docker's own `/.dockerenv`
   *  marker, the same signal `resolveHostPole` (host-parity.ts) is keyed on, established prior
   *  art for "container-aware" in this codebase. Defaults to {@link defaultInContainer}.
   *  Injectable so a test can simulate the condition without a real container. See rung 1's own
   *  doc for why this exists: `os.hostname()` inside a container is the CONTAINER id, so it is
   *  useless as a per-machine identity there — every replacement mints a new one. */
  inContainer?: () => boolean;
}

/** A live pid's start time is trusted to within this many ms of the lock's own `startedAt`
 *  before the gap counts as reuse rather than probe noise. `ps -o etime=` only has whole-second
 *  resolution, while `startedAt` is an ISO timestamp with milliseconds — NOT a clock-skew
 *  allowance (the host check already refuses to compare start times across hosts at all). */
const STALE_START_TOLERANCE_MS = 2000;

/** Docker's own container id shape: a lowercase-hex string, 64 characters (the full id) or 12
 *  (the short form — the SAME length `os.hostname()` actually returns inside a container;
 *  MEASURED against the outage this fixes, `5efb86ede91b` and `eae16667008a`, both 12). Used by
 *  {@link isHolderStale}'s rung 1 to require that a mismatched `held.host`, while this process is
 *  containerised, is actually SHAPED like a container id before treating it as this cell's own
 *  prior history — an arbitrary or human-named `host` (`"boxA"`, a hand-built test fixture) must
 *  stay exactly as unverifiable in a container as it always was off one. */
function looksLikeContainerId(host: string): boolean {
  return /^[0-9a-f]{12}$/.test(host) || /^[0-9a-f]{64}$/.test(host);
}

/**
 * Is `held` stale — safe to reclaim, sweep, or treat as not-running — rather than a genuinely
 * live holder? The ONE predicate every `reclaimStaleLock` caller and `deriveStatus`'s own
 * inflight-lock disjunct now share (previously each kept its own copy of the weaker
 * pid-only check).
 *
 * THREE RUNGS, in order, each ANSWERING what it can and DEFERRING what it can't:
 *   1. `held.host` names a DIFFERENT host than this one ⇒ NOT stale, whatever the local
 *      process table says — UNLESS this process is running inside a CONTAINER, in which case
 *      a mismatch means something else entirely. See "W1-T978" below. A pid is only ever
 *      meaningful on the host that assigned it, so every probe below answers a question about
 *      OUR machine that says nothing about the recorded holder. Unresolvable from here ⇒ never
 *      reap (the same direction of caution `reclaimStaleLock`'s own "lost" outcome already takes).
 *
 *      W1-T978 — A REPLACED CONTAINER COULD NEVER RECLAIM ITS OWN LOCK, because `os.hostname()`
 *      inside a container IS THE CONTAINER ID: Docker mints a new one on every replacement, so
 *      `held.host` (written by the PREVIOUS container) never again equals `myHost` (this one's),
 *      even though nothing genuinely foreign ever touched the lock. MEASURED during a live outage
 *      (2026-08-18): `state/drain.lock` held `{"pid":46,"host":"5efb86ede91b",...}`; container
 *      `5efb86ede91b` no longer existed; the replacement was `eae16667008a`; rung 1 compared the
 *      two, found them different, and refused to boot — forever, since the comparison can only
 *      ever fail again the same way.
 *
 *      THE DISCRIMINATOR IS TWO-PART, DELIBERATELY, NOT "AM I IN A CONTAINER" ALONE. `state/`
 *      (wherever this lock lives) is a bind mount: nothing OTHER than a process on THIS machine
 *      could ever have written to it, so once we know we are running IN a container, a `host`
 *      mismatch CAN mean "an earlier container of this same cell" — but "am I in a container"
 *      says nothing about whether `held.host` is actually a container id at all. `host` is a
 *      free-form field: a lock that genuinely predates containerisation, a hand-edited fixture,
 *      or a future writer on a differently-shaped identity could all put an ARBITRARY string
 *      there, and none of those is "an earlier me" merely because this process happens to be
 *      containerised today. So the second half checks that `held.host` is actually SHAPED like
 *      what `os.hostname()` returns inside a container — {@link looksLikeContainerId}, Docker's
 *      own hex id format — before treating the mismatch as this cell's own history. Only BOTH
 *      together clear the bar: a foreign, human-named, or synthetic `host` stays exactly as
 *      unverifiable in a container as it always was off one.
 *
 *      ONLY THEN is the lock treated as stale directly, WITHOUT consulting rungs 2/3. That
 *      omission is deliberate, not an oversight: a container has its OWN PID NAMESPACE, and pids
 *      restart from 1 (measured: the abandoned lock's pid 46 came back as pid 49 in the
 *      replacement) — so the recorded pid is exactly as likely to collide with a live, UNRELATED
 *      local process as to look cleanly dead, and trusting that collision in EITHER direction is
 *      answering a question the new namespace cannot answer.
 *
 *      On a real (non-containerised) machine, or on any `host` that is not container-id-shaped,
 *      none of this applies and rung 1 behaves exactly as it always has — the discriminator only
 *      ever WIDENS what a container can reclaim of ITS OWN prior identities, never what a bare
 *      machine can, and never a foreign host that merely happens to be read from inside a
 *      container.
 *
 *      W1-T396 MOVED THIS RUNG, and the order is the correctness property. It previously sat
 *      BELOW the pid probe, where it could only ever be reached when a foreign pid number
 *      happened to collide with a live LOCAL process — it guarded the coincidence and not the
 *      case it was written for. The ordinary cross-host reading is that the foreign pid is
 *      ABSENT here, so the pid rung answered "dead ⇒ stale" and the lock was RECLAIMED while
 *      its real holder was still running: two workers on one task, with no error on either
 *      side. Note the shape rather than only the fix — a guard ordered behind a check that
 *      claims its case first is this repo's second instance in two days (W1-T394 is the same
 *      defect in the sweep's rung table).
 *   2. `held.pid` is dead ⇒ stale. The common case, and the ONLY thing that recovers a killed
 *      run: `run-task.ts`'s SIGINT/SIGTERM handlers release the DRAIN lock only, never a
 *      per-task inflight lock, so a signalled run strands its inflight lock and an uncatchable
 *      kill strands both. Reclamation must stay reachable for every same-host holder.
 *   3. `held.pid` is alive on OUR host: compare its ACTUAL start time against `held.startedAt`.
 *      A pid reused by a new process necessarily starts AFTER the original holder wrote the
 *      lock (the original had to be running, and write the file, before it could die and free
 *      the number) — so "this pid started later than the lock claims" is exactly the reuse
 *      signal, decidable without waiting for a real wrap. If the start time can't be determined
 *      (probe failure — the pid could have died in the gap between rungs 1 and 3, `ps` missing,
 *      unparseable output), that is NOT evidence of staleness, so this rung defers too.
 *
 * HONEST ABOUT THE REMAINING WINDOW: this is still a REASON TO BELIEVE the holder is alive,
 * never proof. A cross-host lock is trusted with no verification at all (rung 1), and a
 * same-host reused pid that starts within `STALE_START_TOLERANCE_MS` of the original is
 * indistinguishable from the original (rung 3's whole-second `ps` resolution).
 *
 * AND HONEST ABOUT WHAT RUNG 1 NOW COSTS, since it is reached far more often than before: on a
 * REAL (non-containerised) machine, a foreign-host lock is unreclaimable by this process in
 * EVERY case, not just when its pid collides locally. That is the correct direction — the
 * alternative is stealing a live holder's task — but it makes `host`'s STABILITY load-bearing
 * there. It is written as `os.hostname()` by every acquire path (`inflight-lock`, `drain-lock`,
 * `review`, `task-id-reservation`) and compared against the same `os.hostname()` default here,
 * so the two agree by construction. A bare-metal/VM machine whose hostname CHANGES between
 * acquire and reclaim would still see its own older locks as foreign and therefore permanently
 * unreclaimable, recoverable only by deleting the lock file. Recording a stable per-machine
 * identity instead of a hostname would remove that exposure; it is deliberately not done here
 * because it changes what four writers RECORD rather than how this predicate READS, which is a
 * different concern and a different changeset.
 *
 * W1-T978 NARROWS THIS COST TO NON-CONTAINERS ONLY. Inside a container the analogous exposure —
 * `host` changing on every restart — is exactly the defect this task fixes, and rung 1's new
 * container branch answers it directly rather than accepting it the way the paragraph above
 * accepts it for a real machine.
 */
export function isHolderStale(held: HolderIdentity, opts: IsHolderStaleOpts): boolean {
  // RUNG 1 — HOST FIRST, and the order is the whole point (W1-T396). Every rung below
  // reasons about THIS machine's process table, which describes the recorded holder only
  // when the recorded holder ran here. Asking any of them about a foreign pid answers a
  // question nobody posed.
  if (held.host !== undefined) {
    const myHost = (opts.hostname ?? hostname)();
    if (held.host !== myHost) {
      // W1-T978: a mismatch on a real machine is still unverifiable and never reaped. A
      // mismatch INSIDE A CONTAINER, on a `host` actually SHAPED like a container id, can only
      // be an earlier container of this same bind-mounted cell (see the doc above) — reclaimed
      // directly, never via the pid/startedAt rungs below, which a fresh pid namespace cannot
      // answer meaningfully either way. A `host` that is not container-id-shaped stays exactly
      // as unverifiable as it always was — the shape check is what keeps an arbitrary or
      // human-named foreign host from being swept in just because THIS process is containerised.
      const inContainer = (opts.inContainer ?? defaultInContainer)();
      return inContainer && looksLikeContainerId(held.host);
    }
  }

  // THE BOOT RUNG (W1-T1067) — sits here, between rung 1 and rung 2, and answers a question
  // neither of them can: a `docker restart` REUSES the container, so `held.host` above reads
  // UNCHANGED (rung 1 falls through rather than firing) — but the restart mints a FRESH pid
  // namespace, so `held.pid` can coincidentally alias a live, unrelated process in the new boot,
  // one whose own start time gives rung 3 below nothing to compare against the ORIGINAL holder
  // (that comparison is about the number's CURRENT occupant, not about whether the boot the lock
  // was written in still exists at all). A lock whose `startedAt` PREDATES this container's own
  // boot was written by a process of an EARLIER boot and is dead by construction, whatever pid
  // it names — no live process from a prior boot can be running in this one's pid namespace.
  //
  // PID 1 IS THIS CONTAINER'S OWN BOOT CLOCK, so its start time IS the container's boot time —
  // read through the SAME `getProcessStartTime` probe rung 3 already uses (the same `ps -o
  // etime=` route, MEASURED available in the live container via `ps -o etimes= -p 1`), so this
  // costs no new syscall and no new dependency. Skipped entirely when `startedAt` is absent
  // (pre-W1-T368 shape) or the probe is indeterminate — exactly rung 3's own "no evidence either
  // way" discipline, never inventing staleness from a probe that couldn't answer.
  //
  // CONSERVATIVE IN THE RIGHT DIRECTION (design note iii): it can only ever reclaim a lock OLDER
  // than this boot. A genuinely concurrent second daemon in THIS container necessarily started
  // AFTER pid 1, so its lock's `startedAt` is always later than boot time and this rung never
  // touches it — the single-instance mutex this lock exists to be is never weakened by it.
  //
  // ONLY REACHED WHEN RUNG 1 DID NOT ALREADY DECIDE: a genuinely foreign host already returned
  // above, so this rung only ever runs against `held.host === myHost` or an absent `host` —
  // never against a lock this process has no business judging at all.
  if (held.startedAt !== undefined) {
    const getStart = opts.getProcessStartTime ?? defaultGetProcessStartTime;
    const bootTime = getStart(1);
    if (bootTime !== null) {
      const lockStart = Date.parse(held.startedAt);
      // The tolerance guards the same whole-second `ps -o etime=` rounding rung 3 already
      // accounts for: a lock legitimately written moments after THIS boot must not be swept
      // merely because the boot-time estimate rounded a little late.
      if (!Number.isNaN(lockStart) && lockStart < bootTime - STALE_START_TOLERANCE_MS) {
        return true; // the boot rung: this lock predates the container it would have to run in
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

/** The one syscall {@link defaultInContainer} makes, injectable so a test can drive it without a
 *  real container (mirrors {@link FsRaceSyscalls} and {@link ProcessStartTimeSyscalls}). */
export interface ContainerProbeSyscalls {
  existsSync: typeof existsSync;
}

const defaultContainerProbeSyscalls: ContainerProbeSyscalls = { existsSync };

/**
 * Default {@link IsHolderStaleOpts.inContainer}: `/.dockerenv`, Docker's own container marker —
 * the SAME signal `resolveHostPole` (host-parity.ts) is keyed on and the SAME path
 * `scripts/host-parity.ts` passes it (`existsSync("/.dockerenv")`), so this is established prior
 * art rather than a new detection strategy. Unlike `resolveHostPole`, which takes the marker as
 * an INJECTED boolean because that module has NO imports at all and values purity above
 * everything, this module already imports `node:fs` for the syscalls above it in this file, so a
 * defaulted probe here costs nothing this module was not already paying (W1-T978 design note v).
 */
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
