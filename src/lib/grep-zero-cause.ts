/**
 * W1-T1224 — WHY a `grep:` proof read zero hits.
 *
 * `checkProofCommand` (src/run-task.ts) runs a `grep:` proof's pattern EXACTLY ONCE, against the
 * whole named file, and reports `hits: 0` plus a STATIC BRE-metacharacter note on every non-pass —
 * the same note whether or not the pattern actually carries a metacharacter. That means three
 * genuinely different situations read byte-identical to the filer:
 *
 *   1. LINE-SEAM  — the phrase IS in the file, verbatim, but a YAML fold or a wrapped markdown
 *      paragraph put a newline in the middle of it. `grep` is line-based, so this can NEVER match,
 *      no matter how long the filer waits for "the work" to land (#1336).
 *   2. CASE-ONLY  — the phrase is in the file with different capitalisation. `grep` (no `-i`) is
 *      case-sensitive, so this too can NEVER match as written (also hit live in #1336).
 *   3. ABSENT     — the phrase is not in the file in ANY form. THIS is the legitimate forward
 *      reference — "not written yet" — and is the only one of the three that a filer should ever
 *      leave alone waiting for the work to land.
 *
 * `classifyGrepZeroHit` is the probe that tells these apart. It is called by `checkProofCommand`
 * ONLY after the real executor (`execWhitelistedProof`, src/lib/review.ts) has already run the
 * pattern through the real `grep` and read zero hits — this module never re-derives that verdict,
 * it only explains it.
 *
 * PURE ON PURPOSE: no `fs`, no `child_process`, no hidden read. It takes the pattern and the
 * file's own text and returns a value from a closed set — testable against fixtures with nothing
 * to mock, and reusable by a second caller (W1-T1225's filing-time lint) without either caller
 * teaching it how to read a file.
 *
 * SAME MATCHER, NOT A SECOND ONE (design (ii)). `checkProofCommand`'s `grep:` proofs spawn plain
 * `grep -arn -- <pattern> <path>` — no `-F`, no `-E` — a BASIC REGULAR EXPRESSION. Every probe
 * below runs the pattern through {@link breRegExp}, the SAME BRE-emulating translator, so a
 * pattern containing `.`, `*`, `[`, `^` or `$` is matched as the regex it actually is, never as a
 * fixed string — the exact defect family (#1071) this repo already tracks for the checker
 * disagreeing with the thing that actually runs. COST (design (v)): every probe here is a string
 * operation over text the caller already has; nothing here spawns a process.
 */

/** The closed set {@link classifyGrepZeroHit} returns. `matched` exists for the classifier's own
 *  correctness/testability (a fixture can assert a genuine hit is never misreported as a cause) —
 *  the real wiring only ever calls this after the executor's own `grep` already read zero hits. */
export type GrepZeroCause = "matched" | "line-seam" | "case-only" | "absent";

/** BRE constructs that a backslash opens — grouping and intervals. The SAME two-character set
 *  `breMetacharsIn` (src/lib/task-linter.ts) already uses for the lint side of this same defect
 *  family; kept in sync by being the only place either module special-cases an escape. */
const BRE_CONSTRUCT_AFTER_BACKSLASH = new Set(["(", ")", "{", "}"]);

/** BRE metacharacters that mean the same thing, unescaped, in a JS `RegExp` — pass through as-is. */
const BRE_PASSTHROUGH_METACHARS = new Set([".", "*", "^", "$", "["]);

/** Characters this repo's grep (measured: BSD grep 2.6.0-FreeBSD ∪ ugrep 7.5.0, see
 *  task-linter.ts's own measurement) treats as LITERAL unless escaped, but which are regex
 *  metacharacters in JS — escape them so an unescaped `(foo)` in a proof pattern means the four
 *  literal characters it means to `grep`, not a capture group. */
const JS_METACHAR_LITERAL_IN_BRE = new Set(["(", ")", "{", "}", "+", "?", "|"]);

/**
 * Translate a `grep:` proof's BASIC REGULAR EXPRESSION pattern into an equivalent JS `RegExp`
 * source string. Walks the string rather than doing anything regex-over-regex, for the same
 * reason `breMetacharsIn` does: the one thing that must be exactly right is which characters an
 * escape consumes.
 */
function breSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        // A dangling escape. Undefined behaviour in a real BRE too; treat it as a literal
        // backslash rather than let `new RegExp` throw on a trailing `\`.
        out += "\\\\";
        break;
      }
      out += BRE_CONSTRUCT_AFTER_BACKSLASH.has(next) ? next : "\\" + next;
      i++; // the escape consumes its next char
      continue;
    }
    if (BRE_PASSTHROUGH_METACHARS.has(ch)) {
      out += ch;
      continue;
    }
    if (JS_METACHAR_LITERAL_IN_BRE.has(ch)) {
      out += "\\" + ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Compile `pattern` as a BRE-emulating `RegExp`, or `undefined` if the translated source is not
 *  a syntactically valid JS regex (an edge case a real grep would itself refuse to run — this
 *  classifier is only ever fed a pattern the real executor already ran successfully). */
function breRegExp(pattern: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(breSource(pattern), flags);
  } catch {
    return undefined;
  }
}

/** Collapse a newline plus any run of the following indentation (spaces/tabs) into a single
 *  space — undoes exactly the seam a YAML fold or a wrapped markdown paragraph introduces, and
 *  nothing else: a blank line (paragraph break) still collapses to one space, same as any other
 *  seam, because a `grep:` proof pattern is never expected to span a real paragraph break either. */
function whitespaceNormalised(fileText: string): string {
  return fileText.replace(/\n[ \t]*/g, " ");
}

/**
 * WHY a `grep:` proof over `pattern` read zero hits against `fileText`, derived rather than
 * guessed. See the module doc comment for what each cause means and why it's the caller's job
 * (not this function's) to have already confirmed the real `grep` found nothing.
 *
 * ORDER, STATED (design (ii) requires it be stated, not left to argument order):
 * `line-seam` is checked BEFORE `case-only`. A phrase that both wraps across a line AND differs
 * in case is reported as `line-seam`, never `case-only` — wrapping is decidable from the file's
 * own bytes alone and is the more specific, more actionable fact; a filer who un-wraps it may
 * still need to fix a case mismatch, but that is now visible on the (still zero-hit) re-check
 * rather than being reported as two separate causes on the same pass.
 */
export function classifyGrepZeroHit(pattern: string, fileText: string): GrepZeroCause {
  const lines = fileText.split("\n");
  const caseSensitive = breRegExp(pattern, "");
  const caseInsensitive = breRegExp(pattern, "i");

  if (caseSensitive) {
    for (const line of lines) {
      if (caseSensitive.test(line)) return "matched";
    }
    if (caseSensitive.test(whitespaceNormalised(fileText))) return "line-seam";
  }

  if (caseInsensitive) {
    for (const line of lines) {
      if (caseInsensitive.test(line)) return "case-only";
    }
  }

  return "absent";
}
