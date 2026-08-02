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
 * ...)`. Reading through the descriptor rather than re-checking the path is exactly what the
 * CodeQL query's own recommendation asks for, and it is what makes alerts #60/#61 false
 * positives: the `wx` attempt IS the race guard, and the fallback read never re-derives
 * "does this path exist" from the path string a second time.
 *
 * Any other open error (e.g. `EISDIR` from a misconfigured path) propagates unchanged — it is
 * never swallowed as if it were a benign race.
 */
export type CreateOrReadResult = { created: true; fd: number } | { created: false; raw: string };

export function createOrReadExclusive(path: string, mode: number): CreateOrReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (fd !== undefined) {
    return { created: true, fd };
  }
  const readFd = openSync(path, "r");
  try {
    return { created: false, raw: readFileSync(readFd, "utf8") };
  } finally {
    closeSync(readFd);
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
