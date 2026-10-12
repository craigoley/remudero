import { isDemonstrationProof, isDialectPrefixed, parseAcceptanceBlock, parseWhitelistedProof } from "./review.js";

/**
 * The `grep:` dialect rules, worded once and spread into BOTH grammars below (W1-T8625). They are true of the reviewer's
 * executor whoever writes the proof — a filing worker or a worker opening a PR for its own change — so a second copy
 * would only drift.
 */
const GREP_PROOF_DIALECT_RULES: readonly string[] = [
  "  A `grep:` with no ` in <path>` clause is REFUSED, and the path may not contain `*` or `..`. The",
  "  pattern is a BASIC regex — `[ * ^ $` are refused; `(` and `)` are safe, so `someSymbol(` is the",
  "  idiomatic way to prove a call site.",
  "  A `grep:` that must MISS after your change reads executed_fail and fails the very PR that",
  "  satisfies it — restate it positively: grep the text your change ADDS, never what it removes.",
  "  A `grep:` PATTERN must never contain ` in ` — the parser splits on the LAST ` in ` before a",
  "  path-like token, so a pattern carrying those words mis-splits into a different pattern and path.",
];

/**
 * The acceptance-proof dialect, as prompt text — the ONE copy both task-filing lanes read.
 *
 * WHY THIS EXISTS. A task's `proof:` values are EXECUTED at review time (`parseWhitelistedProof`,
 * review.ts:781) and are lint-gated before that (`proofDialectViolations` /
 * `proofResolvabilityViolations`, task-linter.ts:529/646). CI runs `rmd lint-plan` in
 * changed-tasks-only mode, and a newly-filed task is by definition changed — so a task whose proofs
 * do not parse cannot merge, no matter how good the task is.
 *
 * Neither filing prompt stated that grammar. Measured on `src/lib/triage.ts` before this module
 * landed: ZERO occurrences of "proof", "unit test:", "grep:" or "dialect" in 561 lines. The real
 * cost, on a real paid run: the auto-triage rung fired at 01:00:33Z, spent $1.48, opened PR #1102
 * proposing W1-T286 — and `lint-plan` failed it with SIX blocking violations (four proof-dialect,
 * two proof-resolvability) on proofs the worker itself wrote. Four of its five proofs were
 * unexecutable: two free prose, two `grep:`-prefixed with no `in <path>` clause. A human hand-edited
 * four lines to unblock it, changing all four to `unit test: test/fs-race-alerts.test.ts`.
 *
 * WHY ONE SHARED CONST AND NOT A LINE IN EACH PROMPT. `rmd triage` and `rmd plan` both file new
 * tasks and both hit the identical gate, so the words are identical; two copies would drift, and the
 * drift would be invisible until the next $1.48 fire. test/proof-grammar.test.ts extracts every
 * example proof FROM THIS TEXT and runs it through the real parser and the real metacharacter
 * linter, so an example that stops parsing fails the build — see that file for what that does and
 * does not prove.
 *
 * KEEP IT SHORT. Every line here is read on every fire, by a worker that also has to hold the rest
 * of the prompt in mind. Only BLOCKING rules earned a line: `lintTask` returns
 * `ok: violations.every((v) => v.severity !== "block")` (task-linter.ts), so a `warn` cannot stall a
 * filing. Deliberately omitted for that reason: the call-site rule (`callSiteViolations`, default
 * `warn`) and the unescaped-`.` metacharacter case (`BRE_WARNING_METACHARS`, warn).
 */
export const ACCEPTANCE_PROOF_GRAMMAR: readonly string[] = [
  "  ACCEPTANCE PROOFS are EXECUTED by the reviewer, and CI's `rmd lint-plan` REFUSES free prose on",
  "  any task you touch — an unparseable proof means your own proposal cannot merge. Two forms only:",
  '    proof: "unit test: test/<name>.test.ts"   — runs that whole test file',
  '    proof: "grep: <pattern> in <path>"        — greps <pattern> in ONE real file or directory',
  "  DEFAULT TO THE WHOLE-FILE `unit test:` FORM. You are FILING work, so its test does not exist",
  "  yet: the path form parses NOW and executes that file once someone implements it, while a test",
  "  title you invent would match zero tests forever. The path need not exist yet.",
  ...GREP_PROOF_DIALECT_RULES,
];

/**
 * W1-T8625 — THE PR-BODY SIBLING of {@link ACCEPTANCE_PROOF_GRAMMAR}, for a worker that writes the PR body for the change
 * it makes in the SAME PR (the alert-fix lane today; W1-T8572's main-repair lane next).
 *
 * WHY NOT THE FILING GRAMMAR AS IT STANDS. That one is framed for FILING ("its test does not exist yet", "DEFAULT TO THE
 * WHOLE-FILE `unit test:` FORM") and shows YAML `proof: "..."` lines. A PR body's block is `- <claim> | <proof>` bullets
 * with the bare proof after the pipe, and a whole-file `unit test:` on a file that already passes on main passes at base
 * too — W1-T362 grades that stale, so proof-discrimination still fails. Main-repair PR #11096 carried prose proofs and
 * failed exactly there. The `grep:` rules are shared verbatim ({@link GREP_PROOF_DIALECT_RULES}).
 *
 * test/an-alert-fix-pr-carries-proofs-the-reviewer-can-execute.test.ts lifts each `- <claim> | ...` example bullet OUT
 * OF THE PROMPT TEXT, fills its placeholders and runs it through `parseAcceptanceBlock` and `parseWhitelistedProof`, so an
 * example that stops parsing fails the build. Keep each example bullet on its own line with nothing after the proof.
 */
export const PR_BODY_ACCEPTANCE_GRAMMAR: readonly string[] = [
  "  ACCEPTANCE PROOFS are EXECUTED by the reviewer. A proof with no dialect is prose, and prose caps",
  "  the verdict, so the PR cannot merge without an operator. Under the `Acceptance:` header write",
  "  `- <claim> | <proof>` bullets, CONTIGUOUS, ONE PER PHYSICAL LINE — never wrap a claim or a proof",
  "  onto a second line. Write the bare proof right after the `|`: no `proof:` label, no quotes, no",
  "  backticks. Two forms only:",
  "    - <claim> | unit test: <exact title of a test this change adds>",
  "    - <claim> | grep: <pattern> in <path>",
  "  Each proof must FAIL on the PR's base and PASS on its head. A test file that already passes on",
  "  main proves nothing, so name the exact title of a test you ADD, never a whole test file, and",
  "  never prose that names a path: `test/x.test.ts passes` is prose, not a proof.",
  ...GREP_PROOF_DIALECT_RULES,
];

/**
 * W1-T8625 — the proofs in a PR body's Acceptance block that the reviewer will NOT execute, in block order; `[]` when
 * every proof executes or the body has no block. ONE pure helper, shared by every lane that checks a body it opened
 * (the alert-fix dispatcher; W1-T8572 reuses it for main repair) so the lanes cannot disagree on what "inert" means.
 *
 * A proof is inert when `!isDialectPrefixed(p) || isDemonstrationProof(p) || parseWhitelistedProof(p) === null` — the
 * falsifier test `plan-proposals.ts` already applies. `parseWhitelistedProof(...) === null` ALONE is not enough: its
 * W1-T65 legacy bare-path match ACCEPTS dialect-less prose that names a test path (`test/x.test.ts passes`), the shape
 * #11096 carried. Parses the body itself rather than trusting `acceptanceAuthorTimeCheck`, whose trailer arm returns
 * `ok` before it reads the block.
 */
export function inertAcceptanceProofs(body: string): string[] {
  return parseAcceptanceBlock(body)
    .map((c) => c.proof ?? "")
    .filter((p) => !isDialectPrefixed(p) || isDemonstrationProof(p) || parseWhitelistedProof(p) === null);
}
