// BRE metacharacter scan for `grep:` proofs, split out of task-linter.ts so the check-proof child
// loads it without the linter and its plan/review import graph.

/** BRE metacharacters whose presence can make a pattern NEVER match its literal
 *  text — the silent-false-FAIL class. Blocking; measured retrofit 0. */
const BRE_BLOCKING_METACHARS: ReadonlyArray<string> = ["[", "*", "^", "$"];

/** BRE metacharacters that do NOT silently strand a proof under the executor's own matcher, so they
 *  warn rather than block — for opposite reasons. `.` only WIDENS a match, so the proof still finds
 *  its own text. `?` is LITERAL in a BRE and a QUANTIFIER in an ERE: the executor passes no `-E`, so
 *  a bare `?` works today but any ERE-defaulting grep reports a clean zero. See {@link
 *  SINGLE_LITERAL_CLASS_CHARS} for why the remedy is `[?]`. */
const BRE_WARNING_METACHARS: ReadonlyArray<string> = [".", "?"];

/** Characters for which `[X]` — a bracket holding exactly this one character — is the SANCTIONED
 *  literal escape, exempt from `[`'s blocking rule; without it the linter would forbid the only
 *  portable remedy for the fragility it warns about. `\X` IS NOT AN ALTERNATIVE, since `\?` is a
 *  quantifier in GNU BRE and a literal in an ERE. MEASURED under both `grep` and `grep -E`. `^` is
 *  DELIBERATELY EXCLUDED, since `[^]` opens a NEGATED class; a multi-character class stays
 *  blocked. Why: PR #1071. */
const SINGLE_LITERAL_CLASS_CHARS: ReadonlyArray<string> = ["?", ".", "*", "+", "$", "(", ")", "{", "}", "|", "[", "]"];

/** Characters that become a BRE construct when a backslash precedes them — grouping, intervals, and
 *  GNU's optional-quantifier; `\.`-style escapes are NOT here, being literals. THE TRAP `?` NAMES:
 *  the escape an author reaches for to make `?` literal is precisely the form that stops being
 *  literal, since `\?` is a quantifier in a GNU BRE. Blocking is still right, because `[?]` is
 *  literal under both engines, and retrofit measured ZERO affected proofs.
 *  Why: docs/forensics/task-linter.md#bre_construct_after_backslash. */
export const BRE_CONSTRUCT_AFTER_BACKSLASH: ReadonlyArray<string> = ["(", ")", "{", "}", "?"];

/** The unescaped BRE metacharacters in `pattern`, split by severity. It walks the string rather
 *  than regex-matching it: the one thing that must be exactly right is which characters an escape
 *  consumes, and expressing that as a regex over a regex is how this class of bug is born. */
export function breMetacharsIn(pattern: string): { blocking: string[]; warning: string[] } {
  const blocking: string[] = [];
  const warning: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        blocking.push("\\"); // a dangling escape is undefined behaviour across implementations
        break;
      }
      if (BRE_CONSTRUCT_AFTER_BACKSLASH.includes(next)) blocking.push("\\" + next);
      i++; // the escape consumes its next char — `\.` is a LITERAL dot, legitimate
      continue;
    }
    // `[X]` — one metacharacter, immediately closed — is the sanctioned literal form. Consume all
    // three characters so the bracket does not block AND the character inside is not separately
    // scored: `[?]` must be silent, not a warning about the very `?` it escapes. Anything else
    // starting with `[` falls through to the blocking arm.
    if (ch === "[" && pattern[i + 2] === "]" && SINGLE_LITERAL_CLASS_CHARS.includes(pattern[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (BRE_BLOCKING_METACHARS.includes(ch)) blocking.push(ch);
    else if (BRE_WARNING_METACHARS.includes(ch)) warning.push(ch);
  }
  return { blocking: [...new Set(blocking)], warning: [...new Set(warning)] };
}
