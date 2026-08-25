/**
 * ARGUMENT-PARSING PLUMBING — `unknownArgError`, moved verbatim out of `src/run-task.ts`
 * (W1-T2260). A MOVE, NOT A REDESIGN: the declaration below is byte-identical to the one it
 * replaces, no signature changed, and `run-task.ts` re-imports it under its original name so
 * its ~44 call sites read exactly as before.
 *
 * WHY THIS ONE MOVES ALONE. Of the four locally-declared CLI symbols the branch-reaper
 * extraction (`src/lib/branch-reaper.ts`) stopped short of, `unknownArgError` is the only one
 * that depends on nothing else declared in `run-task.ts` — it is a pure function of its own
 * arguments. Its sibling stays anchored in `run-task.ts`: it looks up a command's usage line in
 * the registry that IS the CLI's identity, and moving it would drag that registry lookup along,
 * which is a redesign this task does not make.
 */

/**
 * Strict arg check for a FLAGS-ONLY subcommand: return an error string for the FIRST
 * unrecognized token (a bare positional, or a `--flag` not in `valueFlags`/`boolFlags`),
 * else null. `valueFlags` consume the following token as their value. This is what makes a
 * SPAWNING command fail loud on junk instead of draining — `rmd daemon install --dry-run`
 * silently ran the daemon (draining W1-T15) because `install`/`--dry-run` were ignored.
 */
export function unknownArgError(
  command: string,
  rest: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): string | null {
  const vf = new Set(valueFlags);
  const bf = new Set(boolFlags);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (bf.has(tok)) continue;
    if (vf.has(tok)) {
      i++; // skip its value
      continue;
    }
    return `rmd ${command}: unexpected argument '${tok}' — see \`rmd --help\``;
  }
  return null;
}
