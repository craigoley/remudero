/**
 * W1-T2849 — RESOLVING A CITED SYMBOL'S DEFINITION, ON ANY `git grep` ENGINE.
 *
 * THE DEFECT THIS EXISTS FOR. The rule-15/16 citation gate built
 * `(export )?(function|const) <symbol>\b` and ran it through `git grep -lE`. On git 2.54.0 that
 * returns ZERO for a symbol that is plainly defined — `criterionFieldTampered`, declared in
 * `src/lib/review.ts` — so the gate reported "a citation that points at nothing" for every symbol
 * it checked. A gate that cannot tell a stale citation from any citation is broken OPEN.
 *
 * THE BOUNDARY IS THE GIT VERSION, WHICH IS ALSO WHY CI NEVER SAW IT. Measured 2026-09-07 over the
 * SAME tree, same commands:
 *
 *   engine                     `git grep -lE 'date' -- src/`   with a leading \b   system grep
 *   git 2.39.5 (container)                              110                   29           29
 *   git 2.54.0 (workstation)                            108                    0            —
 *
 * So `\b` was honoured, and stopped being. CLAUDE.md's clause (a) recorded the older reading
 * correctly and is not wrong about the tree it measured; it is wrong only as a standing promise.
 *
 * THE FIX IS TO DROP THE BOUNDARY, NOT TO PORT IT. The pattern already anchors on
 * `(function|const) ` to the left, and a declaration is followed by `(` or ` ` regardless, so the
 * boundary bought nothing. A word-bounded variant that happens to work on the author's git would
 * re-arm the same trap on the next engine.
 */
import { execFileSync } from "node:child_process";

/** The pattern the citation gate matches a definition with. NO word boundary, by construction —
 *  {@link WORD_BOUNDARY_RE} is what refuses one coming back. */
export function symbolDefinitionPattern(symbol: string): string {
  return `(export )?(function|const) ${symbol}`;
}

/** A `git grep` runner, injectable so a test can drive a SIMULATED engine — including one that
 *  drops `\b`, which is the failure this task exists for and which cannot be reproduced on every
 *  host. Returns matching paths; a non-match must return `[]`, never throw. */
export type GrepRunner = (pattern: string, pathspec: string) => string[];

export const gitGrepRunner = (repoRoot: string): GrepRunner => (pattern, pathspec) => {
  try {
    return execFileSync("git", ["grep", "-lE", pattern, "--", pathspec], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no match
  }
};

/** A symbol the corpus is KNOWN to define, used as the positive control below. Chosen because it
 *  is the very symbol whose disappearance exposed the defect. */
export const CONTROL_SYMBOL = "criterionFieldTampered";

export class BlindGrepError extends Error {
  constructor(readonly controlPattern: string) {
    super(
      `the citation gate's own query cannot see the corpus: the positive control ` +
        `${JSON.stringify(controlPattern)} matched nothing, so a zero for any other symbol is not a ` +
        `measurement. This is what a \\b-dropping git grep engine looks like (W1-T2849).`,
    );
    this.name = "BlindGrepError";
  }
}

/**
 * W1-T2849 design (ii) — THE GATE MUST FAIL LOUDLY WHEN ITS OWN QUERY CANNOT SEE THE CORPUS.
 * The repo's own positive-control doctrine, turned on the gate itself: before concluding "this
 * citation points at nothing", prove the query can match something it is known to match. A zero
 * with no control is not a measurement, and the un-fixed gate produced exactly that.
 */
export function resolveSymbolDefinitions(symbol: string, run: GrepRunner, pathspec = "src/"): string[] {
  const controlPattern = symbolDefinitionPattern(CONTROL_SYMBOL);
  if (run(controlPattern, pathspec).length === 0) throw new BlindGrepError(controlPattern);
  return run(symbolDefinitionPattern(symbol), pathspec);
}
