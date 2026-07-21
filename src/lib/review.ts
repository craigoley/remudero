import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCriterion } from "./plan.js";

/**
 * The JUDGE (MASTER-PLAN §12 rule 4 / rule 3B; task W1-T1C).
 *
 * Standing rule 4: green checks are NOT evidence. `ci` proves the code typechecks
 * and its tests pass; it says nothing about whether the task's ACCEPTANCE CRITERIA
 * were met. This module is the second half of the merge contract: after ci goes
 * green a FRESH-context REVIEW worker (never the implementer's session; read-only
 * tools + gh) verdicts each criterion against its stated PROOF and posts a commit
 * status `remudero-review`.
 *
 * THE VERDICT LOGIC IS A PURE FUNCTION ({@link judgeReview}) so the falsifier —
 * "does the reviewer actually FAIL a test-passing-but-acceptance-ignoring diff?"
 * — is a UNIT FIXTURE, proven before any live gate depends on it. The pure layer
 * is the mechanical FLOOR: it catches the failure modes that need no LLM (a proof
 * never pasted into the report; tests that assert nothing). A semantic verdict
 * from the LLM reviewer may only DOWNGRADE a criterion to failure, never rescue an
 * unpasted proof — proof must be pasted, not vibed.
 *
 * This module NEVER edits code and exposes no write path: the reviewer is
 * read-only + gh by construction (acceptance #3). It does NOT touch branch
 * protection — remudero-review is POSTED here but made REQUIRED by W1-T1D.
 */

/** The commit-status context string the merge gate keys on. Never change casually. */
export const REVIEW_CONTEXT = "remudero-review";

/** A commit-status state. GitHub statuses also allow `pending`/`error`; the gate uses these two. */
export type ReviewState = "success" | "failure";

/**
 * Observed outcome of executing a criterion's proof against the PR head (W1-T65,
 * ratifies P15). Recorded per-criterion on {@link CriterionVerdict} and surfaced on
 * the `review.posted` ledger line + console summary (run-task.ts) so an OBSERVED
 * verdict is legible vs a KEYWORD one:
 *   executed_pass  — the proof's whitelisted test/grep ran and passed/matched on
 *                     the head. MEETS the criterion regardless of report keywords
 *                     (kills the #100 false-block: repo-state truth, unclaimed).
 *   executed_fail  — it ran and FAILED / found no match. OVERRIDES any keyword
 *                     coverage (kills the W1-T51 false-pass: a claim the repo
 *                     state refutes never merges on prose alone).
 *   not_executable — the proof is free prose (or no head checkout dir was given).
 *                     The keyword floor is UNCHANGED — this is the default for
 *                     every caller that predates this task.
 *   exec_error     — the whitelisted check threw or timed out. DEGRADES to the
 *                     keyword floor verdict computed alongside it, verbatim —
 *                     an environment hiccup must never silently hard-fail or
 *                     stall the fleet (Standing rule: no absent-check deadlock).
 */
export type ProofExecOutcome = "executed_pass" | "executed_fail" | "not_executable" | "exec_error";

/** One criterion's verdict against its stated proof. */
export interface CriterionVerdict {
  claim: string;
  proof: string;
  met: boolean;
  reason: string;
  /** See {@link ProofExecOutcome}. Always present — `not_executable` is the safe
   * default when the proof is prose, or no PR-head checkout was supplied. */
  proof_exec: ProofExecOutcome;
  /**
   * W1-T178 (verdict stability): `met` as computed by the mechanical/executed
   * floor, BEFORE any semantic downgrade is applied — the DETERMINISTIC part of
   * this criterion's verdict. Equal to `met` whenever semantic review didn't
   * force a downgrade. Populated by {@link judgeCriterion}; optional so every
   * OTHER `CriterionVerdict` literal in the codebase (ledger-reconstructed
   * placeholders in run-task.ts/sweep.ts, which never carry a semantic layer to
   * begin with) needs no update — {@link applyVerdictStability} falls back to
   * `met` when it is absent.
   */
  floorMet?: boolean;
}

/** The evidence the JUDGE reads: the PR diff, the implement REPORT, optional LLM verdicts. */
export interface ReviewEvidence {
  /** The unified PR diff (as `gh pr diff` / `git diff` would produce). */
  diff: string;
  /** The implement worker's REPORT text (where proofs are pasted). */
  report: string;
  /**
   * Optional per-criterion semantic verdicts from the fresh LLM reviewer,
   * index-aligned to the criteria list. `false` FORCES that criterion to fail;
   * `true`/`undefined` defer to the mechanical floor. Semantic can only
   * downgrade — it can never upgrade an unpasted proof to a pass.
   */
  semantic?: (boolean | undefined)[];
  /**
   * The checkout dir whitelisted proofs execute in — MUST be the PR HEAD sha (the
   * runner's own worktree when judging its own run; a fresh checkout fetched at
   * the head sha on the `rmd review` path). NEVER the operator's working checkout
   * (HEAD DISCIPLINE, W1-T65 design). Absent ⇒ proof execution is skipped for
   * every criterion (`proof_exec` is `not_executable` throughout) — the keyword
   * floor is byte-identical to pre-W1-T65 behavior, which is what every caller
   * that predates this task (and every fixture below) gets by default.
   */
  headCheckoutDir?: string;
  /**
   * Injected proof executor. Real callers omit this — {@link execWhitelistedProof}
   * (the real, whitelist-bounded shell-out) is the default. Tests inject a fake so
   * override/degrade semantics are proven without touching the filesystem or a
   * shell (acceptance: "unit test over an injected executor").
   */
  execProof?: ProofExecutor;
}

/** The rolled-up review verdict — exactly what {@link postReviewStatus} posts. */
export interface ReviewVerdict {
  state: ReviewState;
  criteria: CriterionVerdict[];
  /** True when the diff adds tests that assert nothing (a global fail signal). */
  testTheater: boolean;
  /** One-line human summary, safe to use as the commit-status description. */
  summary: string;
  /**
   * W1-T72 (W1-T65 follow-up — LEGIBILITY, not a blocking-behavior change): true
   * when NOTHING was observed on the PR head (no criterion's `proof_exec` is
   * `executed_pass`/`executed_fail`) while at least one non-`satisfied_by` proof
   * was WRITTEN in the house dialect (`grep: …` / `unit test: …` —
   * {@link isDialectPrefixed}) — i.e. a proof authored to be mechanically
   * checked never actually got checked, and the binding verdict fell back to
   * the blind keyword floor on EVERY criterion. `state`/`met` are UNCHANGED
   * either way — the keyword floor remains the binding fallback exactly as
   * W1-T65 shipped it. Whether a degraded floor should HOLD a risk:high PR is
   * the operator's doctrine call, explicitly out of scope here.
   */
  floorDegraded: boolean;
  /**
   * W1-T178 (verdict stability): the rolled-up `state` as if NO semantic verdict
   * had been supplied at all — every criterion judged on `floorMet` (falling
   * back to `met` where `floorMet` is absent) plus the same `testTheater`/empty-
   * criteria rules `state` itself uses. This is the DETERMINISTIC anchor
   * {@link applyVerdictStability} consults: a semantic-only downgrade (this
   * failing while `floorState` still passes) is noise a re-review of an
   * unchanged, previously-PASSING head may not act on alone. Optional so every
   * other `ReviewVerdict` literal in the codebase (the fix rung's ledger-
   * reconstructed seed verdicts, run-task.ts) needs no update; only
   * {@link judgeReview} populates it, which is the only producer
   * `applyVerdictStability` is ever fed.
   */
  floorState?: ReviewState;
  /**
   * W1-T185 (closes a W1-T128 gap — MASTER-PLAN rule 22 fixture (iii): a PASS at
   * `proof_exec: 0/5`, directly beneath its own FLOOR DEGRADED banner, over a
   * diff satisfying one criterion in five with zero tests on a `tdd: strict`
   * task). True whenever the judged review's `proof_exec` set is ENTIRELY
   * `not_executable`/`exec_error` across every criterion that could have
   * attempted execution (`satisfied_by` criteria excluded — an Architect
   * override deliberately never attempts execution, which is not a capping
   * concern) — i.e. NOTHING was OBSERVED anywhere in this review. Computed
   * UNCONDITIONALLY, independent of `state`: it is a fact about what ran, not a
   * verdict on its own.
   *
   * CAPPED IS NOT FAIL (design, load-bearing): `capped` never forces `state` to
   * `"failure"` — mapping capped to failure would red every PR the moment one
   * proof is unparseable, halting the fleet, which is a worse failure than the
   * uncertified PASS it replaces (it would punish authors for a dialect gap
   * rather than surfacing it). What `capped` DOES change is the RENDERING: a
   * capped `state: "success"` never uses {@link passSummary}'s wording — never
   * "substantiated", never "no test theater" — because neither claim was
   * measured; see {@link cappedSummary}. It is a CLAIM either way; `capped`
   * says so honestly instead of dressing it as certified.
   *
   * The one place `capped` IS consequential: {@link decideAutoMergeArm} refuses
   * to arm auto-merge on a `capped` verdict for a task whose `principles` are
   * `{tdd: strict}`, unless an explicit, ledgered {@link CappedOverride} is
   * supplied — a separate decision layer from this verdict's own `state`, so a
   * capped verdict can still post as a non-blocking commit status (criterion 3)
   * while the ARMING path still refuses it (criterion 2). A non-tdd:strict task
   * is unaffected either way. Distinct from `floorDegraded` (W1-T72,
   * legibility-only, gated on a DIALECT-PREFIXED proof specifically): `capped`
   * fires on ANY zero-executed verdict, dialect-prefixed or not.
   */
  capped: boolean;
  /**
   * W1-T185 (closes the second W1-T128 gap): true when this verdict was judged
   * with NO `headCheckoutDir` — i.e. proof execution was never attempted for
   * ANY criterion, so `state` rests entirely on the keyword floor (+ optional
   * semantic downgrade). This is the case today for `rmd review`'s manual-PR
   * escape hatch (the operator's working checkout is never used as a PR-head
   * substitute — HEAD DISCIPLINE, W1-T65). Surfaced on the posted commit-status
   * summary, the ledger `review.posted` line, and the console `say()` output
   * (run-task.ts) so a keyword-only PASS is never mistaken for an OBSERVED one.
   * Purely a LEGIBILITY signal, like `floorDegraded` — it does not itself force
   * `state`, since a `not_executable`-only floor is the long-standing, correct
   * behavior for every criterion whose proof is free prose.
   */
  keywordOnly: boolean;
}

// ── Tokenisation (deterministic, dependency-free) ──────────────────────────

/** Generic words that carry no proof-specific signal — excluded from keywords. */
const STOPWORDS = new Set([
  "shows",
  "show",
  "with",
  "real",
  "that",
  "this",
  "used",
  "over",
  "into",
  "from",
  "each",
  "their",
  "than",
  "then",
  "them",
  "were",
  "will",
  "have",
  "has",
  "the",
  "and",
  "for",
  "are",
  "was",
  "not",
  "any",
  "per",
]);

/**
 * Tokenise for keyword matching, NORMALISING identifier casing + separators so a
 * criterion and its proof compare case- and separator-insensitively:
 * `maxTurns` ≡ `max_turns` ≡ `max-turns`. camelCase is split into words BEFORE
 * lowercasing (otherwise `maxTurns`→`maxturns` never matches `max_turns`→`max`,
 * `turns`) — a real reviewer weakness that false-blocked PR #42 (W1-T5). This is a
 * FLOOR hardening; the deeper fix is observing repo state (W1-T3F), not keywords.
 */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase: maxTurns → max Turns
    .toLowerCase()
    .split(/[^a-z0-9]+/) // splits on _, -, space, punctuation alike
    .filter(Boolean);
}

/**
 * Distinctive keywords of a proof: tokens ≥4 chars, not stopwords, not bare
 * numbers. Placeholders like `<sha>` reduce to `sha` (len 3) and drop out, so a
 * proof's template noise does not pollute the responsiveness check.
 */
function proofKeywords(proof: string): string[] {
  return [
    ...new Set(
      tokenize(proof).filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  ];
}

/**
 * Fraction of a proof's distinctive keywords the report must echo before we
 * treat the proof as "responsively addressed". A missing/unpasted/non-responsive
 * proof scores near zero; a report that pastes the proof scores near one. This is
 * a FLOOR, not a semantic judge — the LLM reviewer does the real judging on top.
 */
const MIN_COVERAGE = 0.34;

// ── Test-theater detection over a unified diff ─────────────────────────────

/** True once we are inside an added test file (per `+++ b/…test…` headers). */
function isTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || /\.spec\./.test(path);
}

const ASSERTION_RE = /\b(assert|expect|should)\b|\.(is|ok|equal|deepEqual|match|throws|rejects)\(/;
const NOOP_ASSERTION_RE =
  /assert(\.\w+)?\(\s*true\s*[),]|assert\.equal\(\s*true\s*,\s*true|expect\(\s*true\s*\)/;

/**
 * Detect test theater: added test code that asserts nothing (or asserts a
 * tautology). Scans only ADDED lines inside test files. Returns false when the
 * diff touches no test file (nothing to judge) or when a real assertion is added.
 */
export function detectTestTheater(diff: string): boolean {
  let inTestFile = false;
  const addedTestLines: string[] = [];
  for (const line of diff.split("\n")) {
    // File headers (`+++ b/path`) precede their `+`-prefixed body lines.
    if (line.startsWith("+++ ")) {
      const path = line.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      inTestFile = isTestPath(path);
      continue;
    }
    if (line.startsWith("diff --git")) {
      // A `diff --git a/x b/y` header names both paths; use the `b/` side.
      const m = line.match(/\sb\/(\S+)\s*$/);
      inTestFile = m ? isTestPath(m[1]) : false;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (inTestFile && line.startsWith("+")) addedTestLines.push(line.slice(1));
  }
  if (addedTestLines.length === 0) return false;
  if (addedTestLines.some((l) => NOOP_ASSERTION_RE.test(l))) return true;
  const hasRealAssertion = addedTestLines.some((l) => ASSERTION_RE.test(l));
  return !hasRealAssertion;
}

// ── Whitelisted proof execution (W1-T65, ratifies P15; grammar widened W1-T72) ──
//
// Lifts W1-T3F's whitelisted-proof execution — previously only the ADVISORY
// fresh-context reviewer's own judgment (buildReviewPrompt below tells the LLM to
// check out the head and run a proof's test/grep itself) — INTO this deterministic
// FLOOR, so the gate observes repo state whether or not that LLM reviewer ever
// completes. Two ORIGINAL strict shapes (W1-T65):
//   (1) a named TEST FILE path (`test/**/*.test.ts` or `.spec.*`), run via the
//       project's own test runner (`node --test --import tsx <path>`, exactly the
//       package.json `test` script scoped to one file);
//   (2) a literal, BACKTICK-FENCED `grep ...` command (e.g. `` `grep -n foo bar.ts` ``)
//       — fenced so a proof must be UNAMBIGUOUS to qualify; unfenced prose like
//       "grep of src shows X" is NOT this shape and stays on the keyword floor.
// PLUS the HOUSE DIALECT (W1-T72 — coverage: W1-T67/#123 and #125 both showed
// proof_exec 0/N because the acceptance proofs are actually written this way, not
// as fenced commands or bare paths):
//   (3) `grep: <pattern> [in <path>]` — a leading `grep:` label, the pattern
//       free text, optionally followed by `in <path>` (a trailing token that
//       looks like a path — contains `/` or `.`, no whitespace), a FILE or a
//       DIRECTORY (searched recursively either way). No `in` clause ⇒ search
//       recursively from the checkout root, excluding `plan/` (where a
//       proof's own text lives verbatim — an unscoped search would trivially
//       self-match), `.git/`, `node_modules/`. A literal `*` in the path is
//       refused (not_executable): execFile never shells out, so nothing
//       expands a glob — a wildcard target can never resolve to a real file.
//   (4) `unit test: <file-or-test-name>` — a leading `unit test:` label, then
//       EITHER a literal test-file path (shape (1), reused verbatim) OR a bare
//       TEST NAME, run via `node --test --import tsx --test-name-pattern <name>
//       test/**/*.test.ts` (the SAME file glob the project's own `test` script
//       uses) — the whole suite, filtered.
// ALL FOUR are executed via execFile (never a shell), so proof TEXT can never
// inject shell metacharacters into a command line. The two LEGACY strict shapes
// ((1)/(2)) still refuse outright on `; & \` $ < >` or a newline as belt-and-braces
// (they are rare, and both are already unambiguous/fenced). The two HOUSE-DIALECT
// shapes ((3)/(4)) do NOT apply that blanket blocklist (W1-T128 — THE DEAD PROOF
// FLOOR): a dialect body is ordinary architect PROSE, and prose routinely contains
// a semicolon — that single character was refusing 158 of 269 dialect proofs
// measured live in this plan (101 of 126 at the 2026-07-19 baseline), none of them
// an actual injection risk, because execFile takes `args` as an array and never
// hands the string to a shell to interpret. A dialect body is refused ONLY for a
// hazard that survives execFile: path traversal (`..`) or a literal glob (`*`) in
// a grep TARGET, both still checked in {@link parseDialectGrep}. Anything that
// doesn't match any shape is not_executable — the keyword floor stands alone,
// unchanged, and (W1-T72, legibility) is flagged `floorDegraded` when it was
// written to be runnable (see {@link isDialectPrefixed}) but nothing on the
// review ended up executed.

/** A proof shape the floor is willing to mechanically execute. */
export interface WhitelistedProof {
  kind: "test" | "grep";
  /** argv[0] — passed to execFile, never a shell. */
  command: string;
  /** argv[1..] — proof text is never concatenated into a shell string. */
  args: string[];
  /** Human-legible label for reasons (the matched path, or the fenced command). */
  label: string;
  /**
   * W1-T72: true when `kind==="test"` was compiled from a bare TEST NAME (house
   * dialect `unit test: <name>`, not a literal file path) — i.e. `args`
   * includes `--test-name-pattern`. {@link execWhitelistedProof} uses this to
   * guard a node quirk: `--test-name-pattern` with ZERO matches still exits 0
   * (every file's own wrapper "passes" trivially even though nothing inside it
   * ran) — a named test that does not exist on the PR head must count as FAIL
   * (the proof named something the head does not observably contain, exactly
   * the existing "grep with no match" class), never a silent pass.
   */
  nameFiltered?: boolean;
}

const TEST_PATH_RE = /\btest\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/;
const TEST_PATH_EXACT_RE = /^test\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GREP_FENCE_RE = /`(grep\s+[^`]+)`/;
const UNSAFE_FENCE_CHARS_RE = /[;&`$<>\n]/;
/** The house-dialect PREFIXES a proof is WRITTEN in when it is meant to be
 * mechanically checked (W1-T72). Matched against the proof's leading text only
 * — a dialect label is how a proof STARTS, never something incidentally
 * mentioned mid-sentence. */
const DIALECT_GREP_RE = /^grep:\s*(.+)$/i;
const DIALECT_TEST_RE = /^unit test:\s*(.+)$/i;
/** The project's own `test` script glob (package.json) — reused verbatim so a
 * name-filtered run scopes to exactly the suite `npm test` would run. */
const TEST_GLOB = "test/**/*.test.ts";

/**
 * True when a proof's TEXT is written in the house dialect — i.e. it was
 * WRITTEN to be mechanically executed, independent of whether
 * {@link parseWhitelistedProof} actually accepted it (an unsafe/unparseable
 * dialect body still returns null from that function). Used ONLY for the
 * `floorDegraded` legibility signal (W1-T72) — never affects execution.
 */
export function isDialectPrefixed(proof: string): boolean {
  const trimmed = proof.trim();
  return DIALECT_GREP_RE.test(trimmed) || DIALECT_TEST_RE.test(trimmed);
}

/**
 * Split a `grep:` dialect body into its pattern + optional path. The path is
 * the trailing token after the LAST `\s+in\s+` boundary that itself looks like
 * a path/glob (contains `/`, `.`, or `*`, no whitespace) — this keeps
 * multi-word patterns like "wx flag present" intact while still correctly
 * splitting "... in src/lib/config.ts". No such boundary ⇒ the whole body is
 * the pattern and the search defaults to recursive from the checkout root.
 */
const DIALECT_GREP_PATH_RE = /^(.*?)\s+in\s+(\S*[./*]\S*)$/i;

/**
 * Directories excluded from the NO-PATH recursive default (`grep: <pattern>`
 * with no `in <path>` clause). `plan/` is the load-bearing one: it is where
 * every acceptance PROOF's own text lives verbatim (plan/tasks.yaml), so an
 * unscoped repo-root search would trivially self-match a proof's own
 * description string and report `executed_pass` regardless of whether the
 * claimed property holds anywhere in actual code — the false-pass class this
 * whole floor exists to prevent. `.git`/`node_modules` are excluded because
 * they carry no source signal and only cost time on a large checkout.
 */
const GREP_DEFAULT_EXCLUDES = ["--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=plan"];

function parseDialectGrep(body: string): WhitelistedProof | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const withPath = trimmed.match(DIALECT_GREP_PATH_RE);
  const pattern = (withPath ? withPath[1] : trimmed).trim();
  const path = withPath ? withPath[2] : undefined;
  // W1-T128: no shell-metacharacter check on `pattern` — it becomes a single
  // argv element passed to execFile (never a shell), so `; & \` $ < >` are inert
  // here, and refusing prose for containing one was exactly the defect this
  // task fixes (see the module comment above). `--` (below) already stops a
  // pattern from being read as a grep FLAG regardless of its content.
  if (!pattern) return null;
  if (path !== undefined) {
    // The grep TARGET is the one place a real hazard survives execFile: path
    // traversal out of the checkout, still refused.
    if (path.includes("..")) return null;
    // No shell here (execFile) ⇒ no glob expansion — a literal '*' target can
    // never resolve to a real file and would always exit non-zero, silently
    // manufacturing a spurious executed_fail. Refuse rather than run it.
    if (path.includes("*")) return null;
    // "-r" is a no-op on a plain FILE target (confirmed: `grep -rn pat
    // file.ts` behaves identically to `grep -n pat file.ts`) and is what
    // makes a DIRECTORY target work at all — always pass it so "in <path>"
    // covers a file OR a directory without a second branch.
    return { kind: "grep", command: "grep", args: ["-rn", "--", pattern, path], label: `${pattern} in ${path}` };
  }
  return {
    kind: "grep",
    command: "grep",
    args: ["-rn", ...GREP_DEFAULT_EXCLUDES, "--", pattern, "."],
    label: pattern,
  };
}

/**
 * Compile a `unit test:` dialect body — either a literal test-file path (reuses
 * the exact-file shape verbatim) or a bare TEST NAME (name-filtered across the
 * whole suite glob).
 */
function parseTestTarget(body: string): WhitelistedProof | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (TEST_PATH_EXACT_RE.test(trimmed)) {
    if (trimmed.includes("..")) return null; // no path traversal out of the checkout
    return { kind: "test", command: "node", args: ["--test", "--import", "tsx", trimmed], label: trimmed };
  }
  // W1-T128: no shell-metacharacter check on a bare TEST NAME — it becomes the
  // single `--test-name-pattern` argv value passed to execFile (never a shell),
  // so `; & \` $ < >` are inert here too, and this branch names no file, so
  // there is no traversal/glob surface to guard either (see the module comment
  // above). A test name is ordinary prose and routinely contains a semicolon —
  // refusing it there was the single biggest cause of the dead proof floor.
  //
  // W1-T112 round-3 fix: `--test-name-pattern` compiles its argument as a REGEX
  // (`new RegExp(pattern)`), not a literal-substring match. A dialect proof is
  // ordinary architect prose describing a test's own title, and titles routinely
  // echo real syntax verbatim — e.g. "ProgramArguments end [rmd, digest]" — where
  // `[rmd, digest]` is an unescaped CHARACTER CLASS to the regex engine (matches
  // exactly one of the letters r/m/d/i/g/e/s/t or `, `), which can never match the
  // literal bracketed text it was quoting. That silently manufactures a FAIL for a
  // test that genuinely passed and is titled EXACTLY per the proof (empirically
  // confirmed live: `[rmd, digest]` in a proof never matches `[rmd, digest]` in a
  // title). Escaping regex metacharacters here makes the match what the dialect
  // was always meant to mean — "find the test named exactly this" — a literal
  // substring search, while remaining regex-CAPABLE for any proof author who
  // deliberately wants pattern semantics (rare, and not the common case this
  // dialect exists for).
  return {
    kind: "test",
    command: "node",
    args: ["--test", "--import", "tsx", "--test-name-pattern", escapeRegExp(trimmed), TEST_GLOB],
    label: trimmed,
    nameFiltered: true,
  };
}

/** Tokenise a fenced shell-like command, honoring simple `"…"` / `'…'` quoting. No
 * escape sequences (a proof needing one is simply not whitelisted — fine). */
function tokenizeFenced(s: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/**
 * Parse a proof for a whitelisted, mechanically-executable shape. Returns `null`
 * for free prose (or an unsafe/unwhitelisted shape) — the caller then defers
 * entirely to the keyword floor, never attempting execution.
 */
export function parseWhitelistedProof(proof: string): WhitelistedProof | null {
  // House dialect (W1-T72) checked FIRST and EXCLUSIVELY: a proof WRITTEN with
  // a dialect label is handled ONLY by its own parser — success or refuse
  // (null) — and NEVER falls through to a legacy shape below. Falling through
  // would let a dialect body that fails ITS OWN safety check (or that names a
  // pattern which happens to contain a `test/*.test.ts`-shaped substring) get
  // silently reinterpreted via an unrelated legacy match over the same raw
  // text — e.g. `grep: TODO in test/foo.test.ts` must run the GREP, never get
  // swallowed by the legacy unanchored TEST_PATH_RE below into "run that whole
  // test file instead" (a different check than the one actually written).
  const trimmed = proof.trim();
  const dialectTest = trimmed.match(DIALECT_TEST_RE);
  if (dialectTest) return parseTestTarget(dialectTest[1]);
  const dialectGrep = trimmed.match(DIALECT_GREP_RE);
  if (dialectGrep) return parseDialectGrep(dialectGrep[1]);

  // Legacy strict shapes (W1-T65) — only reached when the proof carries no
  // dialect label at all.
  const testMatch = proof.match(TEST_PATH_RE);
  if (testMatch) {
    const path = testMatch[0];
    if (path.includes("..")) return null; // no path traversal out of the checkout
    return { kind: "test", command: "node", args: ["--test", "--import", "tsx", path], label: path };
  }

  const grepMatch = proof.match(GREP_FENCE_RE);
  if (grepMatch) {
    const fenced = grepMatch[1];
    if (UNSAFE_FENCE_CHARS_RE.test(fenced)) return null; // shell metacharacters ⇒ refuse, not sanitize
    const tokens = tokenizeFenced(fenced);
    if (tokens[0] !== "grep" || tokens.length < 2) return null;
    return { kind: "grep", command: "grep", args: tokens.slice(1), label: fenced };
  }
  return null;
}

/** Executes a {@link WhitelistedProof}'s argv and reports whether it passed —
 * injectable so unit tests fake pass/fail/throw without touching the filesystem. */
export type ProofExecutor = (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail";

// W1-T112 round-4: 30s was observed live truncating a name-filtered proof's WHOLE-suite
// run before it ever reached the named test's file (see nameFilteredOutcome's doc
// comment) — widened for headroom. The truncation-detection fix above is the actual
// correctness guarantee; this just reduces how often it needs to engage.
const DEFAULT_PROOF_TIMEOUT_MS = 60_000;
const npmCiPrimed = new Set<string>();

/** `npm ci` a fresh checkout ONCE before its first test proof (design: "fresh
 * worktrees have no node_modules"). Best-effort: a failed/skipped install is never
 * a silent hard-fail here — the test command below will itself fail to run, which
 * surfaces as exec_error on that criterion, never a false pass. */
function ensureDeps(cwd: string): void {
  if (npmCiPrimed.has(cwd)) return;
  npmCiPrimed.add(cwd); // mark attempted regardless of outcome — never retry-storm a cwd
  if (!existsSync(join(cwd, "package.json")) || existsSync(join(cwd, "node_modules"))) return;
  try {
    execFileSync("npm", ["ci"], { cwd, stdio: "pipe", timeout: 120_000 });
  } catch {
    /* best-effort priming; see doc comment above */
  }
}

/**
 * The REAL proof executor (production default): run a {@link WhitelistedProof}'s
 * argv, no shell, in `cwd`, with a HARD per-proof timeout — a hanging test must
 * never stall the required check into the absent-check deadlock class. Returns
 * `"pass"` on a clean exit 0; `"fail"` on ANY clean nonzero exit — a failing test,
 * a grep that found no match (exit 1), AND a grep given a since-renamed/missing
 * path (exit 2) all count as "fail": the proof named something the PR head does
 * not observably contain, which is the criterion genuinely unmet, not an
 * environment hiccup. THROWS only when the process never ran to a clean exit at
 * all (a timeout kill, a spawn error like the command itself missing) so the
 * caller surfaces `exec_error` — a timeout must never be misjudged as an
 * observed "fail".
 *
 * NAME-FILTERED PROOFS ARE THE ONE EXCEPTION to "the exit code is the verdict"
 * (W1-T178, round 2): a bare TEST NAME compiles to `--test-name-pattern` over
 * the WHOLE suite glob (`test/**\/*.test.ts`, {@link TEST_GLOB}), so the exit
 * code reflects EVERY file in that glob, not just the one named test a
 * criterion cares about. FIXTURE, hit live implementing this very task:
 * `test/serve.find.test.ts` runs its file-scope `after` (`browser.close()`)
 * even on a pattern that matched none of ITS tests — `before` is skipped, so
 * `browser` is never assigned and `after` throws — which turns the ENTIRE
 * glob's exit code nonzero. On the old "any nonzero exit ⇒ fail" rule that
 * silently failed every OTHER criterion's name-filtered proof in the SAME
 * review, even though the test each of them actually named had passed —
 * observably, all four of this task's own falsifier tests. So for a
 * name-filtered proof, the verdict is read from {@link nameFilteredOutcome}
 * parsing the TAP stream for the matched test's OWN result line, never from
 * the process exit code — on both the success path and a thrown
 * nonzero-exit's attached stdout.
 */
export function execWhitelistedProof(
  whitelisted: WhitelistedProof,
  cwd: string,
  timeoutMs = DEFAULT_PROOF_TIMEOUT_MS,
): "pass" | "fail" {
  if (whitelisted.kind === "test") ensureDeps(cwd);
  try {
    const stdout = execFileSync(whitelisted.command, whitelisted.args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      encoding: "utf8",
    });
    if (whitelisted.nameFiltered) return nameFilteredOutcome(stdout);
    return "pass";
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null; stdout?: string | Buffer | null };
    if (typeof err.status !== "number") throw err; // killed by signal (timeout) / spawn error (ENOENT, …) ⇒ exec_error
    // A clean nonzero exit. For a name-filtered proof this does NOT necessarily
    // mean OUR named test failed (see the doc comment above) — read the TAP
    // stream node still attaches to the error rather than trusting the code.
    if (whitelisted.nameFiltered) {
      const stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
      return nameFilteredOutcome(stdout);
    }
    return "fail"; // a single-file/grep proof's own nonzero exit is a genuine fail
  }
}

/** A file's own trivial TAP wrapper line (`ok N - test/foo.test.ts`) reporting
 * itself when NONE of its internal tests matched `--test-name-pattern` — not a
 * real match, whichever way it reports. */
function isFileWrapperResultName(name: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name.trim());
}

/** `(not )?ok <n> - <name>` — a node TAP result line, possibly indented for a
 * nested subtest. Captures the pass/fail marker and the reported name. */
const TAP_RESULT_LINE_RE = /^\s*(ok|not ok) \d+ - (.+?)\s*$/;

/** The node test runner's own trailing summary block (`# tests N`, `# pass N`,
 * …, `# duration_ms N`) is written ONCE, after every file in the glob has
 * finished — it is the one reliable signal that a `--test-name-pattern` run
 * over {@link TEST_GLOB} ran to genuine completion rather than being cut off
 * mid-suite by {@link execWhitelistedProof}'s own timeout kill. */
function hasFinalSummary(stdout: string): boolean {
  return /^# duration_ms\b/m.test(stdout);
}

/**
 * Read a name-filtered `--test-name-pattern` run's TAP stdout for the verdict
 * of the REAL (non-file-wrapper) subtest(s) it actually matched, independent
 * of the overall process exit code (see {@link execWhitelistedProof}'s doc
 * comment for why the exit code alone is not trustworthy here).
 *   - zero real matches, run genuinely completed ⇒ "fail" (W1-T72 guard: a
 *     named test that does not exist on the PR head is unmet, never a silent
 *     pass via the trivial "0 children ⇒ ok" wrapper every non-matching file
 *     reports).
 *   - zero real matches, run was CUT SHORT before its trailing summary ⇒
 *     THROWS (W1-T112 round-4 fix). {@link TEST_GLOB} scopes a name-filtered
 *     proof to the WHOLE suite (100+ files, several driving a real headless
 *     browser), so {@link execWhitelistedProof}'s 30s timeout can fire before
 *     node ever reaches the one file the named test lives in — confirmed live
 *     against this exact repo: a timeout-killed run of this command reliably
 *     reports zero final-summary lines, i.e. genuinely never finished. On the
 *     old rule that truncation read identically to "test not found", ANY
 *     criterion whose test happened to sit late enough in the glob's
 *     (filesystem-order-dependent, not alphabetically guaranteed) discovery
 *     order intermittently failed for a test that demonstrably passes in
 *     isolation — the exact flap observed live on this PR's own head commit
 *     (fail → pass → fail, unchanged code). A truncated run is inconclusive,
 *     not evidence of absence: the caller's catch degrades it to exec_error
 *     (the keyword floor), never a manufactured FAIL.
 *   - at least one real match, none reporting `not ok` ⇒ "pass" (found before
 *     any truncation — real, positive evidence, kept even if the run was cut
 *     short afterward elsewhere in the glob).
 *   - at least one real match reporting `not ok` ⇒ "fail" — the named test
 *     genuinely failed, not merely swept up in unrelated collateral noise.
 * Collateral `not ok`/hookFailed lines from files the pattern never matched
 * (their names ARE file-wrapper names) are ignored entirely — they are not
 * evidence about the ONE test this proof named.
 */
export function nameFilteredOutcome(stdout: string): "pass" | "fail" {
  let matched = false;
  let anyRealFailure = false;
  for (const line of stdout.split("\n")) {
    const m = TAP_RESULT_LINE_RE.exec(line);
    if (!m) continue;
    if (isFileWrapperResultName(m[2])) continue; // a file's own trivial wrapper, not a real match
    matched = true;
    if (m[1] === "not ok") anyRealFailure = true;
  }
  if (!matched) {
    if (!hasFinalSummary(stdout)) {
      throw new Error(
        "name-filtered proof run was truncated before its trailing summary (proof timeout) — " +
          "inconclusive, not evidence the named test is missing",
      );
    }
    return "fail";
  }
  return anyRealFailure ? "fail" : "pass";
}

// ── The pure JUDGE ─────────────────────────────────────────────────────────

/** PR-head checkout a criterion's proof may be executed against (W1-T65). */
export interface ProofExecContext {
  cwd: string;
  exec?: ProofExecutor;
}

/** Verdict one criterion against its proof, given the report + optional semantic. */
export function judgeCriterion(
  criterion: AcceptanceCriterion,
  reportTokens: Set<string>,
  semantic?: boolean,
  execCtx?: ProofExecContext,
): CriterionVerdict {
  const base = { claim: criterion.claim, proof: criterion.proof };

  // ARCHITECT-ONLY `satisfied_by`: a criterion already satisfied by an EARLIER PR is
  // MET, cited to that PR. The reviewer judges diff+report, never repo state, so
  // without this an earlier-PR criterion is permanently unsatisfiable by a later PR.
  // (Setting this is a human/Architect act in a plan PR — never a worker's own edit.)
  if (criterion.satisfied_by) {
    return {
      ...base,
      met: true,
      reason: `satisfied by ${criterion.satisfied_by} (prior merge)`,
      proof_exec: "not_executable",
    };
  }

  const kws = proofKeywords(criterion.proof);

  // Mechanical floor: is the proof responsively pasted into the report?
  let met: boolean;
  let reason: string;
  if (kws.length === 0) {
    // A proof with no distinctive anchors cannot be mechanically checked; defer
    // entirely to the semantic layer (fail closed only if the reviewer says so).
    met = true;
    reason = "no mechanical anchors in proof; deferred to reviewer judgment";
  } else {
    const covered = kws.filter((k) => reportTokens.has(k));
    const coverage = covered.length / kws.length;
    if (coverage < MIN_COVERAGE) {
      met = false;
      reason = `proof unmet: report does not substantiate it (matched ${covered.length}/${kws.length} proof keywords)`;
    } else {
      met = true;
      reason = `proof substantiated in report (matched ${covered.length}/${kws.length} proof keywords)`;
    }
  }

  // WHITELISTED PROOF EXECUTION (W1-T65 — lifts W1-T3F's observation into the
  // FLOOR): when a PR-head checkout dir is given AND the proof names an executable
  // check, RUN it and let the OBSERVED result override the keyword floor above in
  // BOTH directions:
  //   executed_pass ⇒ MET, even if the report never claimed it (kills #100).
  //   executed_fail ⇒ UNMET, even if the report keyword-claimed it (kills W1-T51).
  // exec_error DEGRADES to the keyword floor computed above, verbatim — never a
  // silent hard-fail, never a stall.
  let proofExec: ProofExecOutcome = "not_executable";
  if (execCtx) {
    const whitelisted = parseWhitelistedProof(criterion.proof);
    if (whitelisted) {
      const exec = execCtx.exec ?? execWhitelistedProof;
      try {
        const outcome = exec(whitelisted, execCtx.cwd);
        if (outcome === "pass") {
          proofExec = "executed_pass";
          met = true;
          reason = `proof executed and PASSED on the PR head (${whitelisted.kind}: ${whitelisted.label})`;
        } else {
          proofExec = "executed_fail";
          met = false;
          reason = `proof executed and FAILED on the PR head (${whitelisted.kind}: ${whitelisted.label}) — overrides any keyword coverage`;
        }
      } catch {
        proofExec = "exec_error"; // met/reason stay EXACTLY the keyword-floor verdict above
      }
    }
  }

  // W1-T178 (verdict stability): capture the DETERMINISTIC floor's own verdict
  // — mechanical keyword coverage, overridden by whitelisted execution where
  // applicable — BEFORE the semantic layer below gets a chance to downgrade it.
  const floorMet = met;

  // Semantic can only DOWNGRADE: an explicit `false` fails the criterion even if
  // it was mechanically substantiated (or executed-pass); it can never rescue an
  // unpasted / executed-fail proof.
  if (semantic === false && met) {
    met = false;
    reason = "reviewer judged the proof non-responsive (semantic downgrade)";
  }

  return { ...base, met, reason, proof_exec: proofExec, floorMet };
}

/**
 * The pure verdict function (acceptance #2). Given the acceptance criteria and
 * the evidence (diff + report [+ optional semantic verdicts]), roll up a single
 * `remudero-review` state. FAIL-CLOSED: empty criteria, any unmet criterion, or
 * test theater all yield `failure`.
 */
export function judgeReview(
  criteria: AcceptanceCriterion[],
  evidence: ReviewEvidence,
): ReviewVerdict {
  const reportTokens = new Set(tokenize(evidence.report));
  // Absent headCheckoutDir ⇒ execCtx is undefined ⇒ every criterion is
  // not_executable and the keyword floor is byte-identical to pre-W1-T65 —
  // exactly what every fixture/caller that predates this task still gets.
  const execCtx: ProofExecContext | undefined = evidence.headCheckoutDir
    ? { cwd: evidence.headCheckoutDir, exec: evidence.execProof }
    : undefined;
  const verdicts = criteria.map((c, i) =>
    judgeCriterion(c, reportTokens, evidence.semantic?.[i], execCtx),
  );
  const testTheater = detectTestTheater(evidence.diff);

  const unmet = verdicts.filter((v) => !v.met);
  const noCriteria = criteria.length === 0;
  const state: ReviewState = noCriteria || unmet.length > 0 || testTheater ? "failure" : "success";

  // W1-T178 (verdict stability): the SAME rollup, but ignoring semantic entirely
  // — every criterion judged on its `floorMet` (mechanical/executed, pre-
  // downgrade). `testTheater`/`noCriteria` are structural (diff-derived), never
  // semantic, so they bind the floor exactly as they bind `state`. This is the
  // anchor a re-review of an unchanged head checks before trusting a downgrade.
  const floorUnmet = verdicts.filter((v) => !(v.floorMet ?? v.met));
  const floorState: ReviewState =
    noCriteria || floorUnmet.length > 0 || testTheater ? "failure" : "success";

  // W1-T72 (W1-T65 follow-up, legibility): nothing was OBSERVED on the PR head
  // anywhere in this review, yet at least one proof was WRITTEN to be runnable
  // (house dialect) — the binding verdict fell back to the blind keyword floor
  // on EVERY criterion, not because the proofs were legitimately prose. A
  // `satisfied_by` criterion is excluded: it never attempts execution BY
  // DESIGN (an Architect override), which is not a keyword-floor fallback.
  const executedCount = verdicts.filter(
    (v) => v.proof_exec === "executed_pass" || v.proof_exec === "executed_fail",
  ).length;
  const floorDegraded =
    executedCount === 0 && criteria.some((c) => !c.satisfied_by && isDialectPrefixed(c.proof));

  // W1-T185 (closes a W1-T128 gap — MASTER-PLAN rule 22 fixture (iii)): CAPPED
  // is a FACT about what ran, computed UNCONDITIONALLY — never gated on
  // `state`, never forcing it either (CAPPED IS NOT FAIL, criterion 3; see
  // {@link ReviewVerdict.capped}'s doc). `satisfied_by`-only criteria are
  // excluded from the "could have executed" set (an Architect override that
  // deliberately never attempts execution is not a capping concern); a review
  // with no executable criteria at all is never capped (nothing to observe).
  const executableCriteria = criteria.filter((c) => !c.satisfied_by);
  const capped = executableCriteria.length > 0 && executedCount === 0;

  // W1-T185 (closes the second W1-T128 gap): this verdict never attempted
  // execution for ANY criterion (no `headCheckoutDir` was given at all) — the
  // case today when `rmd review`'s worktree materialization fails or is
  // skipped (the operator's working checkout is never substituted — HEAD
  // DISCIPLINE, W1-T65). Purely legibility: `state` is unaffected here (a
  // `not_executable`-only floor is the correct, long-standing behavior for
  // free-prose proofs), but the posted status/ledger/console must say so
  // plainly rather than let a keyword-only PASS read as an observed one.
  const keywordOnly = execCtx === undefined;

  // A capped `state: "success"` NEVER uses passSummary's "substantiated"/"no
  // test theater" wording (criterion 1) — neither claim was measured. A
  // capped `state: "failure"` already renders via failSummary, which carries
  // its own specific unmet-criterion reason and never those two phrases
  // either, so no extra branch is needed there.
  const summary =
    state === "success"
      ? capped
        ? cappedSummary(verdicts.length, keywordOnly)
        : passSummary(verdicts.length, keywordOnly)
      : failSummary(unmet.map((v) => v.claim), testTheater, noCriteria);

  return { state, criteria: verdicts, testTheater, summary, floorDegraded, floorState, capped, keywordOnly };
}

/** The exact PASS status-description text, shared by {@link judgeReview} and a
 * verdict-stability suppression ({@link applyVerdictStability}) so a suppressed
 * downgrade posts a summary byte-identical to a review that passed outright —
 * never a "success" state paired with failure-shaped prose. `keywordOnly`
 * (W1-T185) appends an explicit "(keyword-only)" tag so a PASS with no proof
 * ever executed is never mistaken for an OBSERVED one — e.g. on the commit
 * status GitHub renders for `rmd review`'s manual-PR path. {@link
 * applyVerdictStability} passes the SUPPRESSED verdict's own `keywordOnly`
 * through unchanged, so a re-review that was keyword-only stays labeled that
 * way even when its semantic downgrade is suppressed back to success. */
function passSummary(criteriaCount: number, keywordOnly = false): string {
  return (
    `remudero-review: PASS — ${criteriaCount} criteria substantiated, no test theater` +
    (keywordOnly ? " (keyword-only: no proof was executed on the PR head)" : "")
  );
}

/** The CAPPED status-description text (W1-T185) — posted whenever a verdict
 * that would otherwise render as a clean PASS observed zero proof executions.
 * Deliberately contains neither "substantiated" nor "no test theater"
 * (criterion 1's falsifier, verbatim: PR #411 posted PASS text at
 * `proof_exec: 0/5` directly beneath its own FLOOR DEGRADED banner) — CAPPED
 * means "not certified", never "rejected" (criterion 3: this is still a
 * `state: "success"` commit status, never a red check). `keywordOnly`
 * (W1-T185, gap 2) appends the same explicit tag {@link passSummary} does, so
 * a materialization-failure fallback names BOTH facts in one description
 * (criterion 5). */
function cappedSummary(criteriaCount: number, keywordOnly = false): string {
  return (
    `remudero-review: CAPPED — 0/${criteriaCount} proofs executed; not certified ` +
    `(a keyword match is a claim, not evidence)` +
    (keywordOnly ? " (keyword-only: no proof was executed on the PR head)" : "")
  );
}

// ── VERDICT STABILITY (W1-T178) ─────────────────────────────────────────────
//
// FIXTURE this fixes: PR #388 posted remudero-review=success at 20:28:27Z then
// =failure at 20:30:47Z against the IDENTICAL head sha 1fbea36…, no new commit
// in between. The second (wrong) verdict burned fix-rung strike 2 and drove
// escalation #395 a second later — the flip was the PROXIMATE CAUSE of the
// strike-out, not a cosmetic flap.
//
// RULE: a re-review of an UNCHANGED head sha whose deterministic FLOOR still
// passes may not render a verdict WORSE than its predecessor. The semantic
// lane's downgrade on that input is noise — nothing changed for it to have
// newly observed. A legitimate downgrade always cites NEW INFORMATION: a
// changed head sha, or the mechanical floor itself failing — either bypasses
// this rule entirely and the computed verdict posts unmodified.
//
// ASYMMETRIC BY DESIGN — do not "fix" this into a general sha-pinned-verdict
// rule; see W1-T102. Only a SUCCESS→failure transition on an unchanged sha is
// suppressed. A failure→success transition (an UPGRADE) always posts as
// computed, which is exactly the path W1-T102 opened for body-only fixes to be
// recognised. Pinning symmetrically would re-create the #177 stale-status
// exhaustion T102 fixed.
// ────────────────────────────────────────────────────────────────────────────

/** The most recent `review.posted` verdict recovered from the ledger for a PR
 * — {@link applyVerdictStability}'s `prior` argument. */
export interface PriorReviewVerdict {
  headSha: string;
  state: ReviewState;
}

/** Result of applying the W1-T178 verdict-stability rule to a freshly computed verdict. */
export interface VerdictStabilityResult {
  /** The verdict to actually POST — identical to `computed` unless a downgrade was suppressed. */
  verdict: ReviewVerdict;
  /** True when a semantic-lane downgrade on unchanged input was suppressed this call. */
  suppressed: boolean;
}

/**
 * Recover the most recent `review.posted` verdict for `taskId` from ledger
 * lines, "last one wins" — the SAME scanning idiom `unmetFromLedger`
 * (run-task.ts) and every other precedence helper in this codebase already
 * use, applied to the same `review.posted` line that carries `head_sha` +
 * `state`. No new storage: the ledger already records every posted verdict.
 */
export function priorReviewVerdictFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): PriorReviewVerdict | undefined {
  let prior: PriorReviewVerdict | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string") continue;
    if (line.state !== "success" && line.state !== "failure") continue;
    prior = { headSha: line.head_sha, state: line.state };
  }
  return prior;
}

/**
 * Apply the W1-T178 verdict-stability rule (see block comment above) to a
 * freshly `judgeReview`-computed verdict. Pure — the falsifier this exists to
 * prove is a unit fixture, exactly like `judgeReview` itself.
 */
export function applyVerdictStability(
  computed: ReviewVerdict,
  headSha: string,
  prior: PriorReviewVerdict | undefined,
): VerdictStabilityResult {
  const floorState = computed.floorState ?? computed.state; // no floor info ⇒ never suppress
  const isUnchangedSemanticDowngrade =
    prior !== undefined &&
    prior.headSha === headSha &&
    prior.state === "success" &&
    computed.state === "failure" &&
    floorState === "success";
  if (!isUnchangedSemanticDowngrade) return { verdict: computed, suppressed: false };

  // The floor passed ⇒ every criterion's floorMet is true; rebuild the criteria
  // list off the floor result so the posted verdict stays internally consistent
  // (a "success" state whose criteria all read met, not a success sitting next
  // to a criteria array that still shows a semantic "unmet").
  const criteria = computed.criteria.map((c) => {
    const floorMet = c.floorMet ?? c.met;
    return c.met === floorMet
      ? c
      : {
          ...c,
          met: floorMet,
          reason:
            `${c.reason} — semantic downgrade suppressed: deterministic floor still passes on ` +
            `unchanged head ${headSha.slice(0, 7)} (verdict-stability, W1-T178)`,
        };
  });
  return {
    verdict: {
      ...computed,
      state: "success",
      criteria,
      summary: passSummary(criteria.length, computed.keywordOnly),
    },
    suppressed: true,
  };
}

/**
 * The LOUD console annotation for a degraded floor (W1-T72, design (i)) —
 * printed once per review when {@link ReviewVerdict.floorDegraded} is true.
 * `criteriaCount` is the total number of criteria judged (the "N" in "0/N").
 * Pure + exported so the exact text is a unit-testable falsifier, independent
 * of the console call site (run-task.ts).
 */
export function floorDegradedAnnotation(criteriaCount: number): string {
  return (
    `FLOOR DEGRADED: 0/${criteriaCount} proofs executed; keyword floor was binding — ` +
    `a dialect-prefixed proof ('grep: …' / 'unit test: …') was written to be runnable ` +
    `but nothing was observed on the PR head.`
  );
}

/**
 * True when a task's `principles` field (plan/tasks.yaml `principles: {tdd:
 * strict}`) declares `tdd: strict`. The ONLY input {@link judgeReview} consults
 * to decide whether a zero-executed verdict is CAPPED (W1-T185) — a task that
 * never declared tdd:strict never gets capped, because it never claimed
 * executed proof was mandatory in the first place.
 */
export function isTddStrict(principles?: Record<string, unknown>): boolean {
  return principles?.tdd === "strict";
}

/**
 * The LOUD console annotation for a CAPPED verdict (W1-T185) — printed once per
 * review when {@link ReviewVerdict.capped} is true. Mirrors
 * {@link floorDegradedAnnotation}: pure + exported so the exact text is a
 * unit-testable falsifier, independent of the console call site (run-task.ts).
 */
export function cappedAnnotation(criteriaCount: number): string {
  return (
    `CAPPED: 0/${criteriaCount} proofs executed — not certified (a keyword match is a claim, ` +
    `never evidence). On a tdd:strict task this refuses to arm auto-merge (see decideAutoMergeArm) ` +
    `until proof executes or an operator grants an explicit, ledgered override.`
  );
}

// ── THE AUTO-MERGE ARMING PATH (W1-T185, closes gap 1's criteria 2-3) ───────
//
// GAP: `judgeReview`'s `state`/`capped` alone cannot express "cannot arm
// unattended" without ALSO reddening every PR the moment a proof is
// unparseable (criterion 3 forbids exactly that). So arming is a SEPARATE
// decision layer, consulted by the CALLER right before it would otherwise
// call `armAutoMerge` — never folded into `state`/`floorState`.
// ────────────────────────────────────────────────────────────────────────────

/**
 * An explicit, human-granted exception to "a CAPPED verdict on a tdd:strict
 * task cannot arm auto-merge" (design: "an override is a decision someone
 * made, and it must be attributable"). Never inferred, never anonymous — `by`
 * names WHO. Granted via `rmd review <pr> --override-capped-by/
 * --override-capped-reason` (run-task.ts) and recovered from the ledger by
 * {@link cappedOverrideFromLedger}.
 */
export interface CappedOverride {
  by: string;
  reason: string;
}

/** The auto-merge arming path's decision (W1-T185). */
export interface ArmDecision {
  arm: boolean;
  reason: string;
}

/**
 * Decide whether the auto-merge arming path may proceed, given a freshly
 * computed review verdict, whether the task under review declares
 * `principles: {tdd: strict}`, and an optional operator override. Pure.
 *
 * - `state !== "success"` → refuse. The ordinary required-check gate;
 *   unrelated to capping (a genuinely failing review was ALWAYS refused).
 * - CAPPED IS NOT FAIL (criterion 3): a capped verdict never refuses arming on
 *   its own. Only on a `tdd: strict` task, and only absent an override, does
 *   capping refuse — a non-tdd:strict PR arms exactly as if this were an
 *   ordinary PASS.
 * - An override permits arming. Whether the caller actually LEDGERS that
 *   override is {@link resolveAutoMergeArm}'s job, not this pure predicate's —
 *   keeping this function side-effect-free is what makes "refuses without an
 *   override; permits with one" a single unit fixture (acceptance criterion
 *   2), independent of ledger/CLI plumbing.
 */
export function decideAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped">,
  tddStrict: boolean,
  override?: CappedOverride,
): ArmDecision {
  if (verdict.state !== "success") {
    return { arm: false, reason: "remudero-review is not success" };
  }
  if (!verdict.capped || !tddStrict) {
    return {
      arm: true,
      reason: verdict.capped ? "capped, but the task is not tdd:strict" : "verdict is a full PASS",
    };
  }
  if (override) {
    return { arm: true, reason: `CAPPED override granted by ${override.by}: ${override.reason}` };
  }
  return {
    arm: false,
    reason:
      "CAPPED verdict (zero proofs executed) on a tdd:strict task — refuses to arm auto-merge " +
      "without executed proof or an explicit, ledgered operator override",
  };
}

/**
 * The auto-merge arming path, WITH its ledger side effect (W1-T185, criterion
 * 2's "writes an attributable ledger line naming the overrider"). Wraps
 * {@link decideAutoMergeArm}: when arming succeeds ONLY because an override
 * was supplied for a genuinely capped, tdd:strict verdict, this logs
 * `automerge.capped_override_used` naming who — an override that arms
 * silently is exactly the #411 hazard this task closes (auto-merge armed
 * unattended, no human reading the diff). `log` is injected so the whole
 * contract — refuse without an override, arm + LEDGER with one — is a single
 * unit fixture; `run-task.ts`'s `runTaskBody` is the real caller.
 */
export function resolveAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped">,
  tddStrict: boolean,
  override: CappedOverride | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
): ArmDecision {
  const decision = decideAutoMergeArm(verdict, tddStrict, override);
  if (decision.arm && override && tddStrict && verdict.capped) {
    log("automerge.capped_override_used", { by: override.by, reason: override.reason });
  }
  return decision;
}

/**
 * Recover the most recent `automerge.capped_override_granted` ledger line for
 * `taskId`, "last one wins" — the SAME scanning idiom {@link
 * priorReviewVerdictFromLedger} and every other precedence helper in this
 * codebase already use. Written by `rmd review <pr>
 * --override-capped-by/--override-capped-reason` (run-task.ts); consulted by
 * the arming path ({@link decideAutoMergeArm}) before refusing a CAPPED
 * tdd:strict verdict.
 */
export function cappedOverrideFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): CappedOverride | undefined {
  let found: CappedOverride | undefined;
  for (const line of lines) {
    if (line.step !== "automerge.capped_override_granted" || line.task_id !== taskId) continue;
    if (typeof line.by !== "string" || typeof line.reason !== "string") continue;
    found = { by: line.by, reason: line.reason };
  }
  return found;
}

/**
 * The LOUD console annotation for a keyword-only verdict (W1-T185 — closes the
 * second W1-T128 gap) — printed once per review when {@link
 * ReviewVerdict.keywordOnly} is true and the verdict was NOT already capped
 * (a capped verdict's own annotation already says nothing was executed; this
 * would be redundant). Mirrors {@link floorDegradedAnnotation}.
 */
export function keywordOnlyAnnotation(): string {
  return (
    `KEYWORD-ONLY: no PR-head checkout was given, so no proof was executed for any ` +
    `criterion — this verdict rests entirely on keyword coverage (+ optional semantic ` +
    `downgrade), never on OBSERVED repo state.`
  );
}

/**
 * The `capped`/`keywordOnly` facts the `review.posted` ledger line records
 * (W1-T185, criterion 5: "when materialization is impossible the verdict is
 * EXPLICITLY marked keyword-only, in both the posted status and the ledger —
 * silent keyword-only posting is unreachable"). Pure + exported so run-task.ts's
 * `log("review.posted", …)` call and a unit test both read the SAME two fields
 * off the SAME verdict, rather than the ledger line risking a hand-copied
 * projection that could silently drift from what {@link cappedSummary}/
 * {@link passSummary} actually rendered on the posted status.
 */
export function reviewLedgerLegibilityFields(
  verdict: Pick<ReviewVerdict, "capped" | "keywordOnly">,
): { capped: boolean; keyword_only: boolean } {
  return { capped: verdict.capped, keyword_only: verdict.keywordOnly };
}

/** Max length of a GitHub commit-status description (postReviewStatus also truncates). */
const STATUS_DESC_MAX = 140;
const FAIL_PREFIX = "remudero-review: FAIL — ";

/**
 * Build a failure summary that TEACHES: it NAMES the first unmet criterion (not
 * just a count — the W1-T2/PR #18 refusal said "1 criterion/criteria unmet" and
 * cost a human round-trip to work out WHICH). The first unmet claim is included in
 * full or truncated with an ellipsis, plus `(+N more)` when others are unmet, kept
 * within the status-description length limit. The full unmet list lives in the
 * ledger `review.posted` line and the PR review comment (run-task.ts).
 */
export function failSummary(
  unmetClaims: string[],
  testTheater: boolean,
  noCriteria: boolean,
): string {
  if (noCriteria) return `${FAIL_PREFIX}no acceptance criteria to judge (fail closed)`;
  if (unmetClaims.length === 0) return `${FAIL_PREFIX}test theater: added tests assert nothing`;
  const more = unmetClaims.length > 1 ? ` (+${unmetClaims.length - 1} more)` : "";
  const theater = testTheater ? "; test theater" : "";
  const budget = Math.max(24, STATUS_DESC_MAX - (FAIL_PREFIX.length + "unmet: ".length + more.length + theater.length));
  const first = unmetClaims[0];
  const claim = first.length > budget ? `${first.slice(0, budget - 1).trimEnd()}…` : first;
  return `${FAIL_PREFIX}unmet: ${claim}${more}${theater}`;
}

// ── The fresh-context reviewer prompt (read-only + gh, never edits) ─────────

export interface ReviewPromptInput {
  task: { id: string; acceptance?: AcceptanceCriterion[] };
  prUrl: string;
  owner: string;
  repo: string;
  headSha: string;
}

/**
 * Render the prompt for a FRESH-context REVIEW worker (acceptance #1/#3). The
 * worker is read-only + gh: it reads the PR diff, the task's acceptance criteria,
 * and the implement REPORT, verdicts each criterion against its proof, and posts
 * the `remudero-review` commit status. It is told NEVER to edit code — and the
 * runner spawns it with a read-only settings profile, so this is belt-and-braces.
 *
 * The reviewer verifies against REPO STATE, not diff+report alone: when a proof
 * names an EXECUTABLE check (a test to run, a grep/command over the source), the
 * reviewer CHECKS OUT the PR head and RUNS that check, verdicting on the OBSERVED
 * result — the report's word that a test passes or a grep matches is not proof it
 * does. Running tests/greps against the checked-out head is read-only in spirit:
 * it never edits the PR's code and never changes the head sha it judges.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const criteria = (input.task.acceptance ?? [])
    .map((c, i) => `  ${i + 1}. CLAIM: ${c.claim}\n     PROOF: ${c.proof}`)
    .join("\n");
  const post = (state: ReviewState) =>
    `gh api -X POST repos/${input.owner}/${input.repo}/statuses/${input.headSha} ` +
    `-f context=${REVIEW_CONTEXT} -f state=${state} -f description="<one line>"`;

  return [
    `You are a REVIEW worker with FRESH context — you are NOT the implementer and`,
    `have none of their session. You are READ-ONLY: you may inspect the repo and`,
    `use \`gh\`, but you must NEVER edit, modify, or write any code or file. The PR`,
    `head sha must be unchanged by your review. Running the PR's tests or grepping`,
    `its source to verify a proof is allowed and expected — that is inspection, not`,
    `editing — as long as you never change the code or the head sha.`,
    ``,
    `TASK UNDER REVIEW: ${input.task.id}`,
    `PR: ${input.prUrl}`,
    ``,
    `Do this:`,
    `1. Read the PR diff:            gh pr diff ${input.prUrl}`,
    `2. Read the implement REPORT (the PR body / last worker message).`,
    `3. CHECK OUT the PR head so you can verify against REPO STATE, not just take`,
    `   the report's word. In a THROWAWAY directory (never the runner's cwd), and`,
    `   without changing the PR head sha (${input.headSha}):`,
    `     gh pr checkout ${input.prUrl}   # or: git fetch origin ${input.headSha} && git checkout ${input.headSha}`,
    `4. For EACH acceptance criterion below, verdict its stated PROOF. When the`,
    `   proof names an EXECUTABLE check — a test (RUN it), a grep/command over the`,
    `   source — RUN that check against the checked-out PR head and verdict on the`,
    `   OBSERVED result (repo state), NOT merely on whether the REPORT pasted it. A`,
    `   proof that is missing, unpasted, or non-responsive = FAILURE; a proof whose`,
    `   test FAILS, or whose grep/command does not match on the PR head, = FAILURE.`,
    `   Test theater (assertions that assert nothing) = FAILURE.`,
    ``,
    `ACCEPTANCE CRITERIA:`,
    criteria || "  (none stated — treat as FAILURE: nothing to verify)",
    ``,
    `Then post the commit status on the PR head sha (${input.headSha}):`,
    `  on PASS:  ${post("success")}`,
    `  on FAIL:  ${post("failure")}`,
    ``,
    `This does NOT touch branch protection — you only POST the ${REVIEW_CONTEXT}`,
    `status; whether it is REQUIRED is a separate concern. End with a REPORT: the`,
    `per-criterion verdicts, the state you posted, and the sha.`,
  ].join("\n");
}

/**
 * Machine-readable verdict contract appended to the fresh reviewer's prompt so
 * its per-criterion judgment can be folded into the deterministic verdict as a
 * SEMANTIC downgrade (never an upgrade — {@link judgeReview}). The reviewer emits
 * one `REVIEW_VERDICT <n>: PASS|FAIL` line per criterion. This is advisory: the
 * mechanical floor is the binding gate (Standing rules 2/4/12), so a reviewer
 * that emits nothing parseable simply leaves the floor untouched — never a stall,
 * never a deadlock.
 */
export function reviewerVerdictContract(count: number): string {
  return [
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to posting the status): emit`,
    `EXACTLY one line per criterion, in this form and nothing else on the line:`,
    `  REVIEW_VERDICT <n>: PASS   (proof is responsive and substantiated)`,
    `  REVIEW_VERDICT <n>: FAIL   (proof missing, unpasted, or non-responsive)`,
    `for n = 1..${count}. These are folded into the deterministic verdict and may`,
    `only DOWNGRADE a criterion to failure, never rescue an unpasted proof.`,
  ].join("\n");
}

/**
 * Parse the reviewer's `REVIEW_VERDICT <n>: PASS|FAIL` lines into a semantic
 * array index-aligned to the criteria (length `count`). `FAIL` ⇒ `false` (forces
 * that criterion to fail); `PASS`/absent ⇒ `undefined` (defer to the mechanical
 * floor). Advisory + downgrade-only, so an unparseable reviewer output yields an
 * all-`undefined` array — the floor stands alone, fail-closed. Case-insensitive;
 * tolerant of surrounding prose.
 */
export function parseReviewerVerdicts(text: string, count: number): (boolean | undefined)[] {
  const semantic: (boolean | undefined)[] = new Array(count).fill(undefined);
  const re = /REVIEW_VERDICT\s+(\d+)\s*:\s*(PASS|FAIL)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]) - 1;
    if (n < 0 || n >= count) continue;
    // Only ever record a downgrade; a PASS leaves the floor to decide.
    if (m[2].toUpperCase() === "FAIL") semantic[n] = false;
  }
  return semantic;
}

// ── Acceptance criteria from a PR body (manual plan/doc PRs) ───────────────

/**
 * Parse an `Acceptance:` block out of a PR body, for manual plan/doc PRs that
 * carry no task id. The block is a header line — `Acceptance:` (optionally as
 * markdown `**Acceptance:**` or `## Acceptance`) — followed by bullet lines, each
 * `- <claim> | <proof>` (the `|` separates claim from proof). Parsing stops at the
 * first blank line or non-bullet line after the bullets begin.
 *
 * Returns `[]` when there is no block — and an empty criteria list FAILS CLOSED in
 * {@link judgeReview} (nothing to judge is never a pass). A manual PR that wants to
 * merge must therefore STATE what it is claiming and how it is proven; silence is
 * a failure, not a bypass.
 */
export function parseAcceptanceBlock(body: string): AcceptanceCriterion[] {
  const lines = (body ?? "").split("\n");
  const criteria: AcceptanceCriterion[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // Header: "Acceptance:", "**Acceptance:**", "## Acceptance", "Acceptance criteria:".
    if (!inBlock) {
      if (/^\s*#{0,6}\s*\**\s*acceptance(\s+criteria)?\b\s*\**\s*:?\s*\**\s*$/i.test(line)) {
        inBlock = true;
      }
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (bullet) {
      const item = bullet[1].trim();
      const pipe = item.indexOf("|");
      const claim = (pipe >= 0 ? item.slice(0, pipe) : item).trim();
      const proof = pipe >= 0 ? item.slice(pipe + 1).trim() : "";
      if (claim) criteria.push({ claim, proof });
      continue;
    }
    // A blank line before any bullet is tolerated (header, then a gap, then bullets);
    // once bullets have begun, any blank or non-bullet line ends the block.
    if (line.trim() === "" && criteria.length === 0) continue;
    break;
  }
  return criteria;
}

// ── The reviewer RUBRIC (MASTER-PLAN §5 layer 2 — advisory judgment) ────────
/**
 * Layer 2 of the three-tier gate stack: a set of deterministic JUDGMENT items the
 * reviewer runs over a PR's (diff, report). It ADVISES — the GitHub-enforced gate
 * (layer 1) decides (Standing rule 3B) — so each item is a PURE predicate whose
 * falsifier is a unit fixture, never an LLM call. The four items are, verbatim
 * from §5 layer 2:
 *   1. ONE CONCERN per PR
 *   2. ALL CALLERS AUDITED (partial-fix drift — a change that fixes one call site
 *      and orphans the rest)
 *   3. TEST THEATER (assertions that assert nothing)
 *   4. REFACTOR-PHASE HONESTY (a "refactor" that changes behavior)
 * plus a fifth item, DOCS AWARENESS (§12A — the anti-rot mechanism, W1-T30): a
 * diff changing user-visible behavior (CLI surface, config, gate, verdicts) must
 * update `docs/` OR state why not in the REPORT — this is the Tier-B half of
 * "docs are not evidence unless CI proves they match the code"; Tier A (generated
 * docs, byte-equality in CI) is a separate, later mechanism (W1-T47/T48).
 * plus a sixth item, TROUBLESHOOTING COVERAGE (§12A Tier B, W1-T50): a diff that
 * ADDS a new `operator_impact: true` entry to `learnings/failures.yaml` must also
 * touch `docs/troubleshooting.md` with that entry's id, OR state why not in the
 * REPORT — the same awareness-layer pattern as DOCS AWARENESS, narrowed to the
 * failures corpus so an operator-impacting incident always gets a symptom/cause/
 * fix write-up, not just an internal learning.
 * plus the GUARD: no worker-authored `satisfied_by` (a diff that ADDS a
 * `satisfied_by` line to plan/tasks.yaml FAILS unless the PR is plan-only AND
 * human-authored — `satisfied_by` is Architect-only; a worker adding it to its own
 * blocking criterion is editing the criteria to match the diff, Standing rule 15).
 *
 * These are COARSE, diff-scoped heuristics by design: they advise, they do not
 * decide, and they never edit. Each is independently exported so its fixture can
 * falsify it in isolation.
 */

/** The stable key of one rubric judgment item (used in verdicts + summaries). */
export type RubricKey =
  | "one-concern"
  | "callers-audited"
  | "test-theater"
  | "refactor-honesty"
  | "docs-awareness"
  | "troubleshooting-coverage"
  | "satisfied-by-guard";

/** One rubric item's verdict over a (diff, report). */
export interface RubricItemResult {
  key: RubricKey;
  pass: boolean;
  reason: string;
}

/** PR-level facts the satisfied_by guard needs (unknowable from the diff alone). */
export interface RubricPrMeta {
  /** The PR touches ONLY plan/docs (no product code) — an Architect plan PR. */
  planOnly?: boolean;
  /** The PR is authored by a human/Architect, not a worker session. */
  humanAuthored?: boolean;
}

/** Everything the rubric judges: the diff, the implement report, and PR-level facts. */
export interface RubricInput extends RubricPrMeta {
  diff: string;
  report?: string;
}

/** The rolled-up rubric verdict — all items plus the guard. */
export interface RubricResult {
  items: RubricItemResult[];
  failures: RubricItemResult[];
  pass: boolean;
}

// One classified line of a unified diff.
interface DiffLine {
  file: string;
  kind: "add" | "del" | "ctx";
  text: string;
}

/** Walk a unified diff into classified (file, kind, text) lines. Dependency-free. */
function walkDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/\sb\/(\S+)\s*$/);
      file = m ? m[1] : "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) out.push({ file, kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ file, kind: "del", text: raw.slice(1) });
    else out.push({ file, kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return out;
}

// ── Item 1: ONE CONCERN per PR ─────────────────────────────────────────────

/**
 * The concern a changed file belongs to, keyed by its source STEM: `src/lib/foo.ts`
 * and its co-located `test/foo.test.ts` are the SAME concern (`foo`). Non-source
 * files (docs, plan, config) carry no concern and return null.
 */
function concernStem(path: string): string | null {
  const isSource = /^src\//.test(path) || /(^|\/)test(s)?\//.test(path) || /\.(test|spec)\./.test(path);
  if (!isSource) return null;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

/** Distinct files with at least one changed (add/del) line. */
function changedFiles(lines: DiffLine[]): string[] {
  const files = new Set<string>();
  for (const l of lines) {
    if ((l.kind === "add" || l.kind === "del") && l.file && l.file !== "/dev/null") files.add(l.file);
  }
  return [...files];
}

/**
 * ONE CONCERN: a PR should cluster around a single source module. Two or more
 * distinct product/test STEMS is the partial-fix-drift smell of a multi-concern PR.
 */
export function checkOneConcern(diff: string): RubricItemResult {
  const stems = new Set<string>();
  for (const f of changedFiles(walkDiff(diff))) {
    const s = concernStem(f);
    if (s) stems.add(s);
  }
  if (stems.size > 1) {
    return {
      key: "one-concern",
      pass: false,
      reason: `PR spans ${stems.size} concerns (${[...stems].sort().join(", ")}); one concern per PR — split it`,
    };
  }
  return {
    key: "one-concern",
    pass: true,
    reason: stems.size === 1 ? `single concern (${[...stems][0]})` : "no product-source change to concern-check",
  };
}

// ── Item 2: ALL CALLERS AUDITED (partial-fix drift) ────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count top-level (comma-separated) items in an argument/parameter string. */
function countTopLevel(inner: string): number {
  const s = inner.trim();
  if (s === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/** Parse a single-line function/arrow definition into its name + parameter count. */
function parseDef(line: string): { name: string; params: number } | null {
  let m = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
  if (m) return { name: m[1], params: countTopLevel(m[2]) };
  m = line.match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
  if (m) return { name: m[1], params: countTopLevel(m[2]) };
  return null;
}

/** Count the args at the FIRST call `name(...)` on a line, or null if not called. */
function callArgCount(line: string, name: string): number | null {
  const m = line.match(new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`));
  if (m?.index === undefined) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") {
      depth--;
      if (depth === 0) return countTopLevel(line.slice(open + 1, i));
    }
  }
  return null; // unterminated call on this line — cannot judge arity
}

/**
 * ALL CALLERS AUDITED: when a function's definition GAINS a parameter in the diff,
 * every call site must be updated too. A call left on an UNCHANGED (context) line
 * with the old (too-few) arity is an orphaned sibling — partial-fix drift.
 */
export function checkCallersAudited(diff: string): RubricItemResult {
  const lines = walkDiff(diff);
  const removedDefs = new Map<string, number>();
  const addedDefs = new Map<string, number>();
  for (const l of lines) {
    const d = parseDef(l.text);
    if (!d) continue;
    if (l.kind === "del") removedDefs.set(d.name, d.params);
    else if (l.kind === "add") addedDefs.set(d.name, d.params);
  }
  const gained = [...addedDefs].filter(([n, p]) => {
    const old = removedDefs.get(n);
    return old !== undefined && p > old;
  });
  for (const [name, need] of gained) {
    for (const l of lines) {
      if (l.kind !== "ctx") continue; // an unchanged caller = one the diff did not audit
      if (parseDef(l.text)?.name === name) continue; // the definition line itself is not a call
      const args = callArgCount(l.text, name);
      if (args !== null && args < need) {
        return {
          key: "callers-audited",
          pass: false,
          reason: `partial-fix drift: ${name}() gained a parameter but an unaudited caller still passes ${args} arg(s)`,
        };
      }
    }
  }
  return {
    key: "callers-audited",
    pass: true,
    reason: gained.length ? "every call site updated to the new signature" : "no signature change to audit",
  };
}

// ── Item 3: TEST THEATER ───────────────────────────────────────────────────

/** TEST THEATER as a rubric item — wraps {@link detectTestTheater}. */
export function checkTestTheater(diff: string): RubricItemResult {
  const theater = detectTestTheater(diff);
  return {
    key: "test-theater",
    pass: !theater,
    reason: theater ? "test theater: added tests assert nothing" : "no test theater detected",
  };
}

// ── Item 4: REFACTOR-PHASE HONESTY ─────────────────────────────────────────

// Lines that carry behavior: control flow, returns/throws, comparisons, boolean logic.
const BEHAVIOR_RE = /\breturn\b|\bif\s*\(|\belse\b|\bthrow\b|\bswitch\b|\bwhile\s*\(|\bfor\s*\(|[!=<>]==?|&&|\|\|/;

function isCommentOrBlank(text: string): boolean {
  const s = text.trim();
  return s === "" || s.startsWith("//") || s.startsWith("*") || s.startsWith("/*");
}

/**
 * REFACTOR-PHASE HONESTY: if the change is LABELLED a refactor (the report says so)
 * it must not change behavior. A pure refactor MOVES behavior-bearing lines verbatim
 * — every ADDED behavior line also appears (trimmed) among the REMOVED ones. A behavior
 * line that is added with no matching removal is net-new logic: dishonest for a refactor.
 */
export function checkRefactorHonesty(diff: string, report?: string): RubricItemResult {
  const labelled = /\brefactor/i.test(report ?? "");
  if (!labelled) return { key: "refactor-honesty", pass: true, reason: "change is not labelled a refactor" };
  const removed = new Set<string>();
  const added: string[] = [];
  for (const l of walkDiff(diff)) {
    if (isTestPath(l.file) || isCommentOrBlank(l.text) || !BEHAVIOR_RE.test(l.text)) continue;
    if (l.kind === "del") removed.add(l.text.trim());
    else if (l.kind === "add") added.push(l.text.trim());
  }
  const novel = added.find((a) => !removed.has(a));
  if (novel) {
    return {
      key: "refactor-honesty",
      pass: false,
      reason: `labelled a refactor but changes behavior (new logic: ${novel.slice(0, 60)})`,
    };
  }
  return { key: "refactor-honesty", pass: true, reason: "labelled a refactor; no behavior-bearing line changed" };
}

// ── Item 5: DOCS AWARENESS (§12A anti-rot mechanism, W1-T30) ───────────────

/**
 * Modules that constitute "user-visible behavior" in the §12A sense — CLI
 * surface, config, gate, or verdicts. Diff-scoped path heuristic, same spirit
 * as {@link concernStem}: coarse, not a semantic understanding of the change.
 */
const USER_VISIBLE_SURFACE_RE = new RegExp(
  [
    "^bin/", // the CLI entry point
    "^src/run-task\\.ts$", // CLI dispatcher / orchestrator
    "^src/spike\\.ts$", // CLI entry (spike mode)
    "^src/lib/(config|settings|mounts)\\.ts$", // config surface
    "^src/lib/(review|task-linter)\\.ts$", // gate surface
    "^src/lib/(run-result|status|ledger|flight-judge)\\.ts$", // verdict surface
  ].join("|"),
);

/** True when a changed path is anywhere under a `docs/` directory. */
function isDocsPath(path: string): boolean {
  return /(^|\/)docs\//.test(path);
}

/**
 * A reason the report STATES for why no doc update accompanies a surface
 * change — the report's own words, not inferred. Requires the "no doc(s)
 * change/update" phrase to be followed by an actual reason (a `because`/`:`/
 * dash then more text) — a bare "no docs update" with nothing after it has not
 * stated why, so it does not count as an excuse.
 */
const STATED_REASON_RE = /\bno\s+docs?\s+(?:change|update)\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/**
 * DOCS AWARENESS: a diff touching a CLI/config/gate/verdict surface must also
 * touch `docs/`, or the report must state why not. Silence is a fail — exactly
 * the drift the awareness layer exists to catch (a behavior-changing diff with
 * no doc update and no stated reason).
 */
export function checkDocsAwareness(diff: string, report?: string): RubricItemResult {
  const files = changedFiles(walkDiff(diff));
  const surfaceTouched = files.filter((f) => USER_VISIBLE_SURFACE_RE.test(f));
  if (surfaceTouched.length === 0) {
    return { key: "docs-awareness", pass: true, reason: "no CLI/config/gate/verdict surface changed" };
  }
  if (files.some(isDocsPath)) {
    return {
      key: "docs-awareness",
      pass: true,
      reason: `docs/ updated alongside surface change (${surfaceTouched.join(", ")})`,
    };
  }
  if (STATED_REASON_RE.test(report ?? "")) {
    return { key: "docs-awareness", pass: true, reason: "report states why no doc update was needed" };
  }
  return {
    key: "docs-awareness",
    pass: false,
    reason: `user-visible surface changed (${surfaceTouched.join(", ")}) with no docs/ update and no stated reason`,
  };
}

// ── Item 6: TROUBLESHOOTING COVERAGE (§12A Tier B, W1-T50) ─────────────────

const FAILURES_LEARNINGS_PATH = "learnings/failures.yaml";
const TROUBLESHOOTING_DOC_PATH = "docs/troubleshooting.md";

/** One `- id: <id>` list-item start line in a learnings shard. */
const LEARNING_ID_LINE_RE = /^-\s*id:\s*(\S+)\s*$/;

/**
 * The ids of entries NEWLY ADDED (not merely edited) to `learnings/failures.yaml`
 * that carry `operator_impact: true`. "Newly added" is diff-scoped exactly like
 * {@link checkCallersAudited}'s add/del pairing: a `- id: <id>` line that appears
 * only on an ADD line (never as an unchanged context line, and never on a DEL
 * line) starts a brand-new entry; a field added to an EXISTING entry leaves the
 * `- id:` line itself on a context line. Each new entry's span runs from its
 * `- id:` add-line to the next `- id:` add-line (or end of the file's lines).
 */
function newOperatorImpactfulFailureIds(lines: DiffLine[]): string[] {
  const failureLines = lines.filter((l) => l.file === FAILURES_LEARNINGS_PATH);
  const ids: string[] = [];
  let current: { id: string; operatorImpact: boolean } | null = null;
  const flush = () => {
    if (current?.operatorImpact) ids.push(current.id);
    current = null;
  };
  for (const l of failureLines) {
    if (l.kind !== "add") continue;
    const idMatch = l.text.match(LEARNING_ID_LINE_RE);
    if (idMatch) {
      flush();
      current = { id: idMatch[1], operatorImpact: false };
      continue;
    }
    if (current && /^\s*operator_impact:\s*true\s*$/.test(l.text)) {
      current.operatorImpact = true;
    }
  }
  flush();
  return ids;
}

/**
 * A reason the report STATES for why a new operator-impacting failure has no
 * troubleshooting entry — same shape as {@link STATED_REASON_RE}, scoped to this
 * item's own excuse phrase so the two items' excuses can't be confused for each
 * other.
 */
const TROUBLESHOOTING_STATED_REASON_RE =
  /\bno\s+troubleshooting\s+entry\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/**
 * TROUBLESHOOTING COVERAGE: a diff that adds a new `operator_impact: true` entry
 * to `learnings/failures.yaml` must also touch `docs/troubleshooting.md` naming
 * that entry's id, or the report must state why not. Mirrors DOCS AWARENESS
 * (Item 5) one level narrower: the failures corpus specifically, so an
 * operator-visible incident always gets a symptom/cause/fix write-up.
 */
export function checkTroubleshootingCoverage(diff: string, report?: string): RubricItemResult {
  const lines = walkDiff(diff);
  const newIds = newOperatorImpactfulFailureIds(lines);
  if (newIds.length === 0) {
    return {
      key: "troubleshooting-coverage",
      pass: true,
      reason: "no new operator_impact:true entry added to learnings/failures.yaml",
    };
  }
  const docsLines = lines.filter((l) => l.file === TROUBLESHOOTING_DOC_PATH && l.kind === "add");
  const missing = newIds.filter((id) => !docsLines.some((l) => l.text.includes(id)));
  if (missing.length === 0) {
    return {
      key: "troubleshooting-coverage",
      pass: true,
      reason: `docs/troubleshooting.md updated for ${newIds.join(", ")}`,
    };
  }
  if (TROUBLESHOOTING_STATED_REASON_RE.test(report ?? "")) {
    return {
      key: "troubleshooting-coverage",
      pass: true,
      reason: "report states why no troubleshooting entry was needed",
    };
  }
  return {
    key: "troubleshooting-coverage",
    pass: false,
    reason: `new operator-impacting failure(s) with no docs/troubleshooting.md entry and no stated reason: ${missing.join(", ")}`,
  };
}

// ── The GUARD: no worker-authored satisfied_by ─────────────────────────────

/**
 * THE SATISFIED_BY GUARD: `satisfied_by` is Architect-only (plan.ts / Standing rule
 * 15). A diff that ADDS a `satisfied_by:` line to plan/tasks.yaml FAILS unless the PR
 * is plan-only AND human-authored — a worker adding it to its own blocking criterion
 * is "editing the criteria to match the diff", a failed task, not a merge.
 */
export function checkSatisfiedByGuard(diff: string, meta: RubricPrMeta = {}): RubricItemResult {
  const adds = walkDiff(diff).filter(
    (l) => l.kind === "add" && /(^|\/)plan\/tasks\.yaml$/.test(l.file) && /^\s*satisfied_by\s*:/.test(l.text),
  );
  if (adds.length === 0) {
    return { key: "satisfied-by-guard", pass: true, reason: "no satisfied_by added to plan/tasks.yaml" };
  }
  if (meta.planOnly && meta.humanAuthored) {
    return {
      key: "satisfied-by-guard",
      pass: true,
      reason: "satisfied_by added in a plan-only, human-authored PR (Architect-only — allowed)",
    };
  }
  return {
    key: "satisfied-by-guard",
    pass: false,
    reason:
      "worker-authored satisfied_by: adding it to plan/tasks.yaml outside a plan-only human PR is editing the criteria to match the diff (Standing rule 15)",
  };
}

/**
 * Run the full rubric — the four §5 layer-2 judgment items plus DOCS AWARENESS,
 * TROUBLESHOOTING COVERAGE, and the satisfied_by guard — over a (diff, report)
 * and PR-level facts. ADVISORY: `pass` rolls up all items, but the binding gate
 * is layer 1. `failures` names exactly which items tripped.
 */
export function judgeRubric(input: RubricInput): RubricResult {
  const items: RubricItemResult[] = [
    checkOneConcern(input.diff),
    checkCallersAudited(input.diff),
    checkTestTheater(input.diff),
    checkRefactorHonesty(input.diff, input.report),
    checkDocsAwareness(input.diff, input.report),
    checkTroubleshootingCoverage(input.diff, input.report),
    checkSatisfiedByGuard(input.diff, { planOnly: input.planOnly, humanAuthored: input.humanAuthored }),
  ];
  const failures = items.filter((i) => !i.pass);
  return { items, failures, pass: failures.length === 0 };
}

// ── reviewer_outcome (W1-T63/P10-a — the reviewer stops walling silently) ──

/**
 * The observable OUTCOME of the fresh advisory reviewer spawn, surfaced on the
 * `review.posted` ledger line and the console review summary. Before this, a
 * floor-only PASS (the LLM reviewer walled `error_max_turns` on an undeclared
 * `maxTurns: 12` cap, or was never spawned at all) was byte-identical in the
 * ledger to a review the reviewer actually COMPLETED — an operator could not
 * tell "remudero-review=success, verified" from "remudero-review=success,
 * mechanical floor only" (P10-a). `judgeReview`'s binding verdict is unaffected
 * either way (Standing rules 2/4/12); this is purely a LEGIBILITY signal.
 */
export function reviewerOutcome(opts: {
  /** false when spawnReviewer===false or there were no criteria to judge — the
   * reviewer was never dispatched, by design, not by failure. */
  attempted: boolean;
  /** The reviewer WorkerResult.subtype, when a spawn actually ran to a terminal
   * state ("success" | "error_max_turns" | …). */
  subtype?: string;
  /** true when the spawn itself THREW (e.g. before yielding any result) —
   * distinct from a subtype, since there is none to report. */
  spawnError?: boolean;
}): string {
  if (!opts.attempted) return "not_attempted";
  if (opts.spawnError) return "spawn_error";
  return opts.subtype ?? "unknown";
}

// ── gh poster (runs outside the sandbox; TLS fails under Seatbelt) ──────────

/**
 * Post the `remudero-review` commit status to a PR head sha. Thin wrapper over
 * the exact `gh api` call from the design; mirrors the other gh helpers in
 * lib/worker.ts (untested by unit — it shells out). WRITE-scoped to a commit
 * STATUS only; it can never edit code.
 */
export function postReviewStatus(opts: {
  owner: string;
  repo: string;
  sha: string;
  state: ReviewState;
  description?: string;
}): void {
  const args = [
    "api",
    "-X",
    "POST",
    `repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}`,
    "-f",
    `context=${REVIEW_CONTEXT}`,
    "-f",
    `state=${opts.state}`,
  ];
  if (opts.description) args.push("-f", `description=${opts.description.slice(0, 140)}`);
  execFileSync("gh", args, { stdio: "pipe" });
}
