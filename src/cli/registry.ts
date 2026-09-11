/**
 * W1-T2893 — decomposition step 10. Before this file existed, `src/run-task.ts`'s `COMMANDS`
 * array (still defined there, W1-T47's single source of truth for `rmd --help`) described the
 * CLI while `main()` dispatched it through its OWN flat if-ladder over `cmd` — 77 branches, one
 * per verb, none of them reading `COMMANDS` to decide anything. A verb could be listed in
 * `COMMANDS` and never actually dispatched (or vice versa) and nothing but a source-text-scanning
 * test (test/help-registry.test.ts) would ever notice, because the two surfaces were maintained
 * BY HAND in parallel, not derived from one structure.
 *
 * THE FIX: a verb's registry entry now CARRIES its own handler ({@link RegisteredCommand}), and
 * {@link dispatchCommand} is the ONE place that resolves a verb name to that handler and invokes
 * it. `main()` in run-task.ts builds the handler table (every handler still lives there — this
 * step changes WHO dispatches, not where every handler's logic lives, per the task record) and
 * calls `dispatchCommand`, so the flat if-ladder is gone: a verb missing its handler is a
 * {@link buildRegistry} throw at module load (loud, immediate), not a silent gap a human has to
 * notice by reading two lists side by side.
 *
 * Deliberately zero-import from `../run-task.js`: this file is the leaf, `run-task.ts` depends on
 * it, never the reverse — a dispatcher that imported the thing it dispatches for would be a
 * circular dependency for no reason, since every fact this file needs (the verb name, the parsed
 * args, and a function to call) is supplied by the caller at call time.
 */

/**
 * One CLI verb's help metadata — the fields `rmd --help` (top-level summary line) and
 * `rmd <cmd> --help` (full detail) render. Moved here from `src/run-task.ts` (W1-T47's original
 * home for this type); `scripts/rmd-help.mjs` still source-scans `src/run-task.ts`'s `COMMANDS`
 * array directly (so the no-SDK-load `rmd --help` path is unaffected by this move — that array's
 * literal data stays put, only the shared TYPE moved), and run-task.ts imports this type back.
 */
export interface CommandSpec {
  /** Exact token matched against argv[2] by {@link dispatchCommand}. */
  readonly name: string;
  /**
   * Invocation shape ("rmd <name> ..."), no trailing description — what `rmd --help` and
   * `rmd <cmd> --help` render on the usage line, and what a command's inline error hints quote
   * verbatim. Stored directly (W1-T2480) instead of recovered at read time from a combined
   * string by a separator regex: an entry that forgets a separator has nothing to forget,
   * because this field was never anything but the invocation shape.
   */
  readonly syntax: string;
  /**
   * One short line (<= SUMMARY_CHAR_CAP characters) printed per command by the top-level
   * `rmd --help` listing (W1-T2480). A genuinely separate, hand-authored sentence — never a
   * truncation or a preview of `detail` — so the top-level list stays short without silently
   * dropping any of the prose `detail` carries in full.
   */
  readonly summary: string;
  /**
   * Full prose: flag semantics, exit-code tables, PR citations — everything that makes this
   * registry the trustworthy record it is. Printed in full by `rmd <cmd> --help` and rendered
   * verbatim into docs/cli-reference.md; never abbreviated or dropped for the top-level listing.
   */
  readonly detail: string;
}

/**
 * A verb's handler: receives argv AFTER the verb token itself (what run-task.ts calls `rest` —
 * `["--allow-stale"]` for `rmd run-task W1-T1 --allow-stale`, `arg` recoverable as `rest[0]`) and
 * returns the PROCESS EXIT CODE, or a promise of one. Never calls `process.exit` itself — that
 * stays the caller's process-boundary concern (main()'s own contract per the task record), so a
 * handler is plain, synchronously testable logic all the way down.
 */
export interface CommandHandler {
  (rest: string[]): number | Promise<number>;
}

// A CommandSpec paired with the handler that runs when it is dispatched.
export interface RegisteredCommand extends CommandSpec {
  readonly handler: CommandHandler;
}

// The unrecognized-verb exit code, matching the flat if-ladder's old fallthrough.
export const UNKNOWN_COMMAND_EXIT_CODE = 2;

/**
 * Joins plain {@link CommandSpec} metadata (the `COMMANDS` array — unchanged content, still
 * `rmd --help`'s single source of truth) with the handler table a caller builds for its own
 * verbs, producing the array {@link dispatchCommand} actually dispatches against.
 *
 * THROWS if a spec has no matching handler — registry/dispatch drifting apart is now a crash at
 * module load (the first `rmd` invocation of any kind), not a silent gap only a source-scanning
 * test would catch; the SAME failure shape `commandSpec()` (run-task.ts) already uses for the
 * sibling case of an unregistered spec name.
 */
export function buildRegistry(
  specs: readonly CommandSpec[],
  handlers: ReadonlyMap<string, CommandHandler>,
): readonly RegisteredCommand[] {
  return specs.map((spec) => {
    const handler = handlers.get(spec.name);
    if (!handler) {
      throw new Error(
        `buildRegistry: COMMANDS entry "${spec.name}" has no registered handler — registry/dispatch are out of sync`,
      );
    }
    return { ...spec, handler };
  });
}

/**
 * Resolves `cmd` against `registry` and invokes its handler with `rest`, returning the exit code
 * to give `process.exit` — this IS the dispatcher the task record asks for: the one place a verb
 * name turns into a function call, instead of a 300-line flat if-ladder duplicating `COMMANDS`'
 * verb list by hand in `main()`.
 *
 * An unmatched `cmd` (truly unknown, OR a known verb whose handler itself decided the invocation
 * doesn't qualify — e.g. a required positional arg is missing, same as today's `cmd === "x" &&
 * arg` guard) prints `usage` and returns {@link UNKNOWN_COMMAND_EXIT_CODE}, byte-identical to the
 * text and exit code `main()`'s old fallthrough produced.
 */
export async function dispatchCommand(
  cmd: string | undefined,
  rest: string[],
  registry: readonly RegisteredCommand[],
  usage: string,
): Promise<number> {
  const entry = cmd === undefined ? undefined : registry.find((c) => c.name === cmd);
  if (!entry) {
    console.error(usage);
    return UNKNOWN_COMMAND_EXIT_CODE;
  }
  return await entry.handler(rest);
}
