import { closeSync, openSync, readFileSync } from "node:fs";

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
