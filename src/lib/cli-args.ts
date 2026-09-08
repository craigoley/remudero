/**
 * ARGUMENT-PARSING PLUMBING — pure functions of their own arguments, moved verbatim out of
 * `src/run-task.ts`: `unknownArgError` (W1-T2260) and `flagValue` (W1-T2888). Neither depends
 * on the `COMMANDS` registry or anything else `run-task.ts`-local, unlike `commandSyntax`
 * (stays there — it looks up the registry that IS the CLI's identity). `run-task.ts` re-imports
 * both under their original names; `src/lib/report-commands.ts`'s moved report verbs use
 * `flagValue` too.
 */

/**
 * Strict arg check for a FLAGS-ONLY subcommand: return an error string for the FIRST
 * unrecognized token, else null. `valueFlags` consume the following token as their value.
 * This is what makes a SPAWNING command fail loud on junk instead of draining — `rmd daemon
 * install --dry-run` silently ran the daemon because `install`/`--dry-run` were ignored.
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

/** `--flag value` lookup over a raw argv tail; undefined if the flag is absent. */
export function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}
