import { isDemonstrationProof, isDialectPrefixed, parseAcceptanceBlock, parseWhitelistedProof } from "./review.js";

// W1-T8625: the `grep:` rules, true of the executor whoever writes the proof, worded ONCE and spread into both
// grammars below.
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
 * The acceptance-proof dialect, as prompt text — the ONE copy both task-filing lanes (`rmd triage`, `rmd plan`) read.
 * A task's `proof:` values are EXECUTED at review (`parseWhitelistedProof`) and lint-gated by CI's changed-tasks
 * `rmd lint-plan` before that, so a newly filed task whose proofs do not parse cannot merge. Neither prompt stated the
 * grammar: auto-triage spent $1.48 on PR #1102 (W1-T286) and lint-plan failed it with SIX blocking violations on proofs
 * the worker wrote — two free prose, two `grep:` with no `in <path>`. One shared const, because two copies drift.
 * test/proof-grammar.test.ts lifts every example proof FROM THIS TEXT through the real parser and metacharacter linter.
 * KEEP IT SHORT: only BLOCKING lint rules earned a line (`lintTask`'s `ok` ignores `warn`), so the call-site rule and
 * the unescaped-`.` case are omitted on purpose.
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
 * W1-T8625 — the PR-BODY sibling, for a worker writing the body of the PR that carries its own change (alert-fix;
 * W1-T8572 main repair next). Not the filing grammar as it stands: that one teaches YAML `proof:` lines and the
 * whole-file `unit test:` form, and a test file already passing on main passes at base too, so proof-discrimination
 * fails (#11096). W1-T8625's test lifts each `- <claim> | ...` example bullet from the prompt and parses it; keep one
 * per line, with nothing after its proof.
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
 * W1-T8625 — a PR body's Acceptance proofs the reviewer will NOT execute, in block order (`[]` when all execute or
 * there is no block). The ONE helper every lane checking a body it opened uses (W1-T8572 reuses it), with
 * plan-proposals.ts's falsifier test: `parseWhitelistedProof(...) === null` alone misses dialect-less prose naming a
 * test path, which its W1-T65 legacy bare-path match accepts. It parses the body itself, because
 * `acceptanceAuthorTimeCheck`'s trailer arm returns before it reads the block.
 */
export function inertAcceptanceProofs(body: string): string[] {
  return parseAcceptanceBlock(body)
    .map((c) => c.proof ?? "")
    .filter((p) => !isDialectPrefixed(p) || isDemonstrationProof(p) || parseWhitelistedProof(p) === null);
}
