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
  "  A `grep:` with no ` in <path>` clause is REFUSED, and the path may not contain `*` or `..`. The",
  "  pattern is a BASIC regex — `[ * ^ $` are refused; `(` and `)` are safe, so `someSymbol(` is the",
  "  idiomatic way to prove a call site.",
  "  A `grep:` that must MISS after your change reads executed_fail and fails the very PR that",
  "  satisfies it — restate it positively: grep the text your change ADDS, never what it removes.",
  "  A `grep:` PATTERN must never contain ` in ` — the parser splits on the LAST ` in ` before a",
  "  path-like token, so a pattern carrying those words mis-splits into a different pattern and path.",
];
