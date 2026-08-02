import { readFileSync } from "node:fs";

/**
 * W1-T286 (CodeQL alerts #60 `src/lib/config.ts:402`, #61 `src/lib/serve.ts:3940`, both
 * `js/file-system-race`): both flagged sites were, per the code-scanning API, already
 * `state: dismissed` / `dismissed_reason: false positive` before this task started — the
 * SAME exclusive-create (`wx`) + EEXIST-fallback-read-by-descriptor idiom this repo has
 * shipped three times before (W1-T67, alert #24, alert #71) was already in place at both
 * lines, and this task's re-analysis simply re-flagged the same reviewed-and-dismissed
 * shape again (a re-scan re-flags previously-dismissed alerts at unchanged code —
 * dismissal doesn't retroactively suppress future scans). A human dismissed both again,
 * `false positive`, same rationale as every prior round: the `wx` attempt IS the race
 * guard, and the EEXIST fallback reads through a FRESH descriptor (`openSync(path, "r")`
 * + `readFileSync(fd, ...)`) rather than `existsSync`-then-`readFileSync(path, ...)`,
 * which is exactly what the query's own recommendation asks for.
 *
 * An earlier draft of this fix ALSO folded that create-or-read shape into a shared
 * `createOrReadExclusive` helper here, reasoning that config.ts and serve.ts open-coding
 * the identical shape twice was worth deduplicating. That draft made CI go RED: CodeQL's
 * new-alert-in-diff check keys off (file, line), not code shape, so relocating the exact
 * same dismissed pattern to a brand-new file/line produced a genuinely NEW, un-dismissed
 * alert on `fs-race-safe.ts` itself — worse than the two it was meant to retire. The
 * create-or-read shape was reverted back to config.ts/serve.ts's own dismissed locations
 * (byte-identical to what a human already reviewed), and this file keeps ONLY the piece
 * that was never itself flagged: the catch-ENOENT optional-read shape below, independently
 * open-coded in run-task.ts (moved here) and panel-graph.ts (left as-is; a follow-up, not
 * this task's scope, could point it at this shared copy too).
 */

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
