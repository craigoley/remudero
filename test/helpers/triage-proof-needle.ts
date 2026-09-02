/**
 * THE ONE place that knows what "the discriminating contract" of `triageAcceptanceProof` looks
 * like as SOURCE TEXT, and how to remove it.
 *
 * WHY THIS EXISTS (W1-T2587). `test/triage-proof-dialect.test.ts`'s W1-T963 mutation check used to
 * search `src/lib/triage.ts` for the ENTIRE return statement, byte-for-byte —
 * `"  return \`grep: status: ${status} in ${feedbackEntryRepoPath(feedbackId)}\`;\n"`, leading
 * indentation and trailing semicolon included. That is the committed file formatted EXACTLY as it
 * happens to be formatted today, which makes the checked-out file a second, incidental reader of
 * its own literal layout. Stryker's mutation harness is exactly such a second reader: inside its
 * sandbox `src/lib/triage.ts` is INSTRUMENTED — every mutable expression, including this template
 * literal, gets wrapped in a generated conditional (`return cond ? mutant : original;`) — so the
 * exact multi-token STATEMENT text is gone even though the literal's own text is untouched. The
 * old needle then matched zero times, and the sanity assertion that guarded it (`0 !== 1`) aborted
 * the mutation-testing dry run with `ConfigError: There were failed tests in the initial test run`.
 *
 * THE FIX: search for the CONTRACT the statement stands in for — the template literal EXPRESSION
 * itself, `` `grep: status: ${status} in ${feedbackEntryRepoPath(feedbackId)}` `` — not the
 * `return` statement that wraps it. An instrumenter rewrites the STATEMENT around a mutable
 * expression; it does not need to (and Stryker does not) reformat the untouched expression's own
 * text, so the expression still appears exactly once, whatever wraps it.
 */
export const TRIAGE_PROOF_NEEDLE = "`grep: status: ${status} in ${feedbackEntryRepoPath(feedbackId)}`";

/** The same expression with the ONE thing that makes it destination-specific removed. */
export const TRIAGE_PROOF_MUTATED_NEEDLE =
  "`grep: status: in ${feedbackEntryRepoPath(feedbackId)}`" +
  " /* W1-T963 MUTATION: destination-state interpolation removed */";

export type TriageProofMutation = {
  /** How many times {@link TRIAGE_PROOF_NEEDLE} occurs in `source` — callers assert this is 1. */
  matchCount: number;
  /** `source` with the ONE occurrence of the needle replaced by the mutated needle. */
  mutated: string;
};

/**
 * Locate {@link TRIAGE_PROOF_NEEDLE} in `source` and produce the mutated copy, WITHOUT asserting
 * anything itself — callers own the assertions so their failure messages stay theirs (W1-T963
 * design note (vii)). Works whether `source` is the plain checked-out file or an instrumented copy
 * that wraps the needle in extra scaffolding, because it never looks past the needle's own text.
 */
export function mutateTriageProofSource(source: string): TriageProofMutation {
  const matchCount = source.split(TRIAGE_PROOF_NEEDLE).length - 1;
  const mutated = source.replace(TRIAGE_PROOF_NEEDLE, TRIAGE_PROOF_MUTATED_NEEDLE);
  return { matchCount, mutated };
}
