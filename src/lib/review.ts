import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { defaultIsPidAlive } from "./drain-lock.js";
import { appendLedger } from "./ledger.js";
import { isInPlanScope } from "./plan-architect.js";
import type { AcceptanceCriterion } from "./plan.js";
import { readLedgerLines } from "./status.js";

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
   * to arm auto-merge on ANY `capped` verdict (W1-T229 — regardless of the
   * task's `principles`; a prior version of this gate exempted every
   * non-tdd:strict task, which made prose the DEFAULT merge floor, since
   * `{tdd: strict}` is opt-in), unless an explicit, ledgered
   * {@link CappedOverride} is supplied — a separate decision layer from this
   * verdict's own `state`, so a capped verdict can still post as a
   * non-blocking commit status (criterion 3) while the ARMING path still
   * refuses it (criterion 2). Distinct from `floorDegraded` (W1-T72,
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
  /**
   * W1-T205 (the operator's standing rider on W1-T229's raised floor): true when
   * the diff touches ONLY plan-scope files (`plan/**`/`MASTER-PLAN.md` —
   * {@link isInPlanScope}, the SAME predicate `rmd plan`'s PROPOSED-outcome check
   * and the W1-T136 filing-PR emitter already use) and at least one file. A
   * plan-only PR files or amends a task; it never carries the code the task
   * describes, so it has NO executable proof to run — it is STRUCTURALLY and
   * PERMANENTLY `capped`, not degraded. FAILS CLOSED: an empty diff, or a diff
   * mixing even one src/test/other file into an otherwise plan-only change, is
   * NOT plan-only — the dangerous shape is a code change smuggled into a plan PR
   * to inherit the exemption below, so ambiguity resolves toward the full floor.
   *
   * The one place `planOnly` is consequential: {@link decideAutoMergeArm} treats
   * a `planOnly` CAPPED verdict as armable without an operator override — the
   * carve-out is an exemption from PROOF EXECUTION only, never from `state`
   * itself (a plan-only PR whose criteria are genuinely unmet still fails like
   * any other), and never from the deterministic gates that already bind a plan
   * PR (lint-plan, the emitter's own structural checks, plan-index regeneration,
   * commitlint). It also changes the RENDERING of a capped success (see
   * {@link planOnlySummary}) so the posted status reads as deterministically
   * gated rather than as proof-executed — never overstating what was checked.
   */
  planOnly: boolean;
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

/** Executes a {@link WhitelistedProof}'s argv and reports the outcome —
 * injectable so unit tests fake pass/fail/no-match/throw without touching the filesystem.
 * `"no-match"` (name-filtered proofs only): the run completed but ZERO tests matched the
 * pattern — the named test does not exist. That is NOT a failing test; the caller degrades
 * it to `not_executable` (the keyword floor), never a false `executed_fail`. */
export type ProofExecutor = (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";

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
 * W1-T227: resolve the CANDIDATE test file(s) a name-filtered proof's raw name
 * could actually live in, so {@link execWhitelistedProof} can scope its `node
 * --test` invocation to just those files instead of blindly compiling
 * `--test-name-pattern` across the WHOLE suite glob ({@link TEST_GLOB}). Node
 * still LOADS every file in a glob before filtering by name regardless of how
 * few match — MEASURED live on a scratch clone of main: a narrowed run of one
 * proof against its own file alone completes in 0.2s; the full-glob load is
 * ~22s against a 60s timeout, leaving too little headroom on a machine already
 * running workers (the exact defect this task exists to close — the same
 * unchanged proof coins `executed_pass` on an idle host and `exec_error` on a
 * loaded one).
 *
 * Fixed-string (`grep -F`), never a regex: a name-filtered proof's raw name is
 * ordinary architect prose, not a pattern — the same reasoning
 * {@link parseTestTarget}'s `escapeRegExp` already applies to the
 * `--test-name-pattern` argument itself, applied here to the search that finds
 * candidate files.
 *
 * Best-effort: any grep failure (no match, `test/` absent, grep itself
 * missing, …) degrades to an EMPTY candidate list — {@link narrowNameFilteredArgs}
 * treats that identically to "genuinely zero candidates" and falls back to the
 * unchanged (full-glob) invocation, so a resolution hiccup can only cost the
 * optimisation, never turn into a false verdict.
 */
export function resolveNameFilteredCandidates(cwd: string, rawName: string): string[] {
  try {
    const stdout = execFileSync("grep", ["-rl", "-F", "--include=*.test.ts", "--", rawName, "test"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * W1-T227's command builder: given a name-filtered proof's already-compiled
 * `baseArgs` (from {@link parseTestTarget}, trailing with {@link TEST_GLOB})
 * and the candidate file(s) {@link resolveNameFilteredCandidates} found, swap
 * the full glob for just those candidates. ZERO candidates CHANGES NOTHING —
 * returns `baseArgs` verbatim, still globbed — because narrowing is an
 * optimisation of the executed path, never a new way for a genuinely-absent
 * test to pass: {@link nameFilteredOutcome}'s existing zero-match ⇒ "fail"
 * path fires identically either way (a wider search finding nothing is exactly
 * as conclusive as a narrower one).
 */
export function narrowNameFilteredArgs(baseArgs: readonly string[], candidateFiles: readonly string[]): string[] {
  if (candidateFiles.length === 0) return [...baseArgs];
  return [...baseArgs.filter((a) => a !== TEST_GLOB), ...candidateFiles];
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
): "pass" | "fail" | "no-match" {
  if (whitelisted.kind === "test") ensureDeps(cwd);
  // W1-T227: a name-filtered proof's `args` (from parseTestTarget) still carry
  // the FULL suite glob — resolve the actual candidate file(s) now, against
  // the real PR-head checkout, and narrow to just those before ever spawning
  // node. Not folded into parseWhitelistedProof itself: that function is a
  // pure parse with no `cwd`, and the candidate set can only be known against
  // a real checkout.
  const args = whitelisted.nameFiltered
    ? narrowNameFilteredArgs(whitelisted.args, resolveNameFilteredCandidates(cwd, whitelisted.label))
    : whitelisted.args;
  try {
    const stdout = execFileSync(whitelisted.command, args, {
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
export function nameFilteredOutcome(stdout: string): "pass" | "fail" | "no-match" {
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
    // ZERO tests matched the pattern and the run COMPLETED (a trailing summary is present, so
    // this is not a timeout). The named test does not exist — a proof-authoring mismatch, NOT a
    // failing test. Returning "fail" here (the pre-fix shape) minted a false `executed_fail` that
    // HARD-BLOCKED PRs whose real tests pass under a different name — #466/W1-T183 sat blocked a
    // day+ on exactly this. Report the distinct "no-match" so the caller degrades to the keyword
    // floor with a legible reason, never a false test failure.
    return "no-match";
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
        } else if (outcome === "no-match") {
          // ZERO tests matched the proof's name pattern (the run completed — see
          // nameFilteredOutcome). The named test does not exist: a proof-authoring mismatch,
          // NOT a failing test. Degrade to `not_executable` (the keyword floor stands as
          // computed above — `met`/`reason` from mechanical coverage), and ANNOTATE why, so an
          // author sees "names no matching test" rather than a misleading "executed and FAILED".
          proofExec = "not_executable";
          reason = `${reason} — NOTE: proof names no matching test (0 tests matched '${whitelisted.label}'); not executed, keyword floor applied`;
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

  // W1-T205: PLAN-ONLY CLASSIFICATION. Reuses the review path's OWN existing
  // diff-walker (`changedFiles(walkDiff(...))` — the same one {@link
  // checkOneConcern} already uses to name a diff's changed files) plus
  // plan-architect's own plan-scope predicate ({@link isInPlanScope} — the SAME
  // guard `rmd plan`'s PROPOSED-outcome check and the W1-T136 filing-PR emitter
  // use) rather than inventing a third, divergent notion of "plan-only". FAILS
  // CLOSED: an empty diff, or one touching even a single file outside
  // `plan/**`/`MASTER-PLAN.md`, is NOT plan-only — see {@link
  // ReviewVerdict.planOnly}'s doc for why that direction is load-bearing.
  const diffFiles = changedFiles(walkDiff(evidence.diff));
  const planOnly = diffFiles.length > 0 && diffFiles.every(isInPlanScope);

  // A capped `state: "success"` NEVER uses passSummary's "substantiated"/"no
  // test theater" wording (criterion 1) — neither claim was measured. A
  // capped `state: "failure"` already renders via failSummary, which carries
  // its own specific unmet-criterion reason and never those two phrases
  // either, so no extra branch is needed there. A capped PLAN-ONLY success
  // renders via {@link planOnlySummary} instead of {@link cappedSummary} — see
  // {@link ReviewVerdict.planOnly}'s doc (W1-T205): "0 proofs executed" is not
  // a degradation for a PR with nothing executable to point at, so the status
  // must read as deterministically gated, never as an uncertified claim.
  const summary =
    state === "success"
      ? capped
        ? planOnly
          ? planOnlySummary(verdicts.length)
          : cappedSummary(verdicts.length, keywordOnly)
        : passSummary(verdicts.length, keywordOnly)
      : failSummary(unmet.map((v) => v.claim), testTheater, noCriteria);

  return {
    state,
    criteria: verdicts,
    testTheater,
    summary,
    floorDegraded,
    floorState,
    capped,
    keywordOnly,
    planOnly,
  };
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

/** The PLAN-ONLY status-description text (W1-T205) — posted in place of {@link
 * cappedSummary} whenever a capped success's diff is plan-only (see {@link
 * ReviewVerdict.planOnly}). Deliberately never says "CAPPED" or "not certified":
 * those words read as something going wrong, and for a plan-only PR nothing
 * did — filing or amending a task has no code to run a proof against, so "0
 * proofs executed" is its permanent, correct shape, not a degradation. Names
 * what actually gated the PR (lint-plan + the W1-T136 plan-PR emitter's own
 * structural checks + plan-index regeneration) so an operator reading the
 * status is told the truth either way (standing rule 22: state the verdict
 * honestly, claimed versus evidenced) — never that a proof executed, but also
 * never that this PR's honest structural shape is a failure mode. */
function planOnlySummary(criteriaCount: number): string {
  return (
    `remudero-review: PASS — plan-only PR (${criteriaCount} criteria), gated deterministically ` +
    `(lint-plan + the plan-PR emitter + plan-index checks); no proof execution attempted, ` +
    `by design (W1-T205)`
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
    `never evidence). This refuses to arm auto-merge (see decideAutoMergeArm) until proof ` +
    `executes or an operator grants an explicit, ledgered override.`
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
 * An explicit, human-granted exception to "a CAPPED verdict cannot arm
 * auto-merge" (design: "an override is a decision someone made, and it must
 * be attributable"). Never inferred, never anonymous — `by` names WHO.
 * Granted via `rmd review <pr> --override-capped-by/
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
 * - W1-T229: A CAPPED verdict (zero proofs executed) refuses to arm
 *   UNCONDITIONALLY, regardless of `tddStrict` — a prior version of this
 *   function armed any capped, non-tdd:strict PR exactly as if it were an
 *   ordinary PASS, which made "declare tdd:strict" the ONLY thing standing
 *   between zero executed proof and an unattended merge, and tdd:strict is
 *   not the default. `tddStrict` is retained purely for override-provenance
 *   bookkeeping ({@link resolveAutoMergeArm}), never for gating.
 * - W1-T205 (the operator's standing rider on W1-T229): a `planOnly` CAPPED
 *   verdict arms WITHOUT needing an override. Checked BEFORE the override
 *   branch so a plan-only PR's arm reason always names the carve-out, never
 *   an override that was never actually consulted (also why {@link
 *   resolveAutoMergeArm} excludes `planOnly` from its override-ledgering
 *   condition — logging "override used" for a decision an override never
 *   drove would misattribute it). Plan-only PRs are STRUCTURALLY capped —
 *   filing or amending a task has no code to run a proof against — so
 *   "capped never arms without an override" would block every retro, approve
 *   and filing PR forever; this is an exemption from PROOF EXECUTION only,
 *   never from `state` (an unmet plan-only PR still refuses above).
 * - An override permits arming, on any other capped verdict. Whether the
 *   caller actually LEDGERS that override is {@link resolveAutoMergeArm}'s
 *   job, not this pure predicate's — keeping this function side-effect-free
 *   is what makes "refuses without an override; permits with one" a single
 *   unit fixture (acceptance criterion 2), independent of ledger/CLI
 *   plumbing.
 */
export function decideAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  tddStrict: boolean,
  override?: CappedOverride,
): ArmDecision {
  if (verdict.state !== "success") {
    return { arm: false, reason: "remudero-review is not success" };
  }
  if (!verdict.capped) {
    return { arm: true, reason: "verdict is a full PASS" };
  }
  if (verdict.planOnly) {
    return {
      arm: true,
      reason:
        "plan-only PR — structurally has no executable proof (filing/amending a task, not implementing " +
        "one); gated deterministically by lint-plan + the plan-PR emitter + plan-index checks, not by " +
        "proof execution (W1-T205 carve-out on the W1-T229 floor)",
    };
  }
  if (override) {
    return { arm: true, reason: `CAPPED override granted by ${override.by}: ${override.reason}` };
  }
  return {
    arm: false,
    reason:
      "CAPPED verdict (zero proofs executed) — refuses to arm auto-merge without executed proof " +
      "or an explicit, ledgered operator override",
  };
}

/**
 * The auto-merge arming path, WITH its ledger side effect (W1-T185, criterion
 * 2's "writes an attributable ledger line naming the overrider"). Wraps
 * {@link decideAutoMergeArm}: when arming succeeds ONLY because an override
 * was supplied for a genuinely capped verdict (W1-T229: any capped verdict,
 * not just a tdd:strict one), this logs `automerge.capped_override_used`
 * naming who — an override that arms silently is exactly the #411 hazard
 * this task closes (auto-merge armed unattended, no human reading the diff).
 * `log` is injected so the whole contract — refuse without an override, arm +
 * LEDGER with one — is a single unit fixture; `run-task.ts`'s `runTaskBody`
 * is the real caller.
 */
export function resolveAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  tddStrict: boolean,
  override: CappedOverride | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
): ArmDecision {
  const decision = decideAutoMergeArm(verdict, tddStrict, override);
  // W1-T205: excludes `planOnly` — decideAutoMergeArm checks the carve-out BEFORE the
  // override branch, so a planOnly arm never actually consulted `override` even when one
  // happens to be present; logging "override used" here would misattribute the decision.
  if (decision.arm && override && verdict.capped && !verdict.planOnly) {
    log("automerge.capped_override_used", { by: override.by, reason: override.reason });
  }
  return decision;
}

// ── Status-provenance gate (W1-T203 — THE FORGE ATTACK) ─────────────────────
//
// Today `gh` runs OUTSIDE the sandbox with the operator's own ambient
// credential (recon R-3/R-6), and that credential is the ONLY thing on the
// machine that can post a commit status — so any identity that can shell out
// to `gh` (including a worker) can post its own `remudero-review=success` and
// satisfy its own merge gate. This section closes the read-back half: at ARM
// TIME, whoever is about to trust a live `remudero-review` status must first
// ask GitHub WHO posted it (the commit-status API's `creator.login`, which
// GitHub attributes from the authenticating credential — a worker cannot make
// this say anything but its own identity, unlike the state/description/context
// fields, which are just request payload). The credential half (a dedicated
// identity {@link postReviewStatus} authenticates as, which workers never
// hold) and the deny-floor half (hooks/deny-floor.sh refusing a worker's own
// status-POST attempt) are the other two parts of the same property.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Env var naming the GitHub login the dedicated `remudero-review` reviewer
 * identity authenticates as (a fine-grained PAT or GitHub App installation
 * token's own login/slug — e.g. `remudero-reviewer[bot]`). Read by the
 * orchestrator ONLY (never shipped to a worker's environment — the same
 * containment property `~/.config/remudero/**` already gets in
 * `settings/worker.json`'s deny-list); {@link resolveReviewProvenance}'s
 * caller supplies it explicitly so the pure function never reaches into
 * `process.env` itself.
 */
export const REVIEWER_IDENTITY_ENV = "REMUDERO_REVIEWER_LOGIN";

/**
 * Env var naming the dedicated reviewer identity's own credential.
 * {@link postReviewStatus} uses it (as `GH_TOKEN`, overriding whatever `gh`
 * would otherwise resolve from the ambient environment) when set, so the
 * ONE status that must carry unforgeable provenance is posted by an identity
 * distinct from the operator/worker credential every other `gh` call on the
 * machine shares. Unset ⇒ `postReviewStatus` falls back to ambient `gh` auth,
 * byte-identical to pre-W1-T203 behavior — the same bootstrap-ordering
 * doctrine `docs/review-gate.md` already documents for `ci-gate`: a
 * provenance gate armed before the dedicated identity exists would deadlock
 * every merge, so this ships DARK until an operator provisions the identity
 * and sets both env vars.
 */
export const REVIEWER_TOKEN_ENV = "REMUDERO_REVIEWER_TOKEN";

/**
 * One fetched `remudero-review` commit-status entry — the two fields
 * {@link resolveReviewProvenance} needs off GitHub's "get the combined status
 * for a ref" response (`.statuses[]`, already deduped to the latest post per
 * context by GitHub itself). `undefined` means no status has ever been posted
 * under this context for the sha in question.
 */
export interface ReviewStatusEntry {
  state: ReviewState;
  /**
   * GitHub's `creator.login` for this status — the one field a poster cannot
   * spoof (server-attributed from the authenticating credential, never from
   * the request body). `undefined` only if GitHub's response is itself
   * malformed/incomplete; treated the same as a mismatched login (untrusted).
   */
  posterLogin?: string;
}

/**
 * THE PROVENANCE GATE (acceptance criteria 1-3). Resolve what a fetched
 * `remudero-review` status ACTUALLY proves, gated on WHO posted it:
 *
 * - No status at all → `"absent"`.
 * - A status posted by anyone OTHER than `trustedLogin` → `"absent"` —
 *   REGARDLESS of its `state`. This is deliberate and covers BOTH forge
 *   directions: an untrusted `success` must not rescue a merge a genuine
 *   review would have failed (criterion 1), and an untrusted `failure` must
 *   not BLOCK a merge a genuine review would have passed (criterion 2) — the
 *   design's "treat a forged verdict as absent, never as a fail": mapping a
 *   hostile poster's `failure` to a real failure converts the forge vector
 *   into a denial-of-service vector, which is worse (an attacker can already
 *   forge `success`; letting them ALSO forge `failure` costs the operator a
 *   legitimate merge instead of only a hostile one).
 * - A status posted by `trustedLogin` → its own `state`, unchanged — the
 *   autonomous merge path is byte-identical to pre-W1-T203 for every
 *   non-forged PR (criterion 3).
 *
 * Pure and case-insensitive on the login compare (GitHub logins are
 * case-insensitive for uniqueness, so a byte-exact compare would be a false
 * mismatch waiting to happen).
 */
export function resolveReviewProvenance(
  entry: ReviewStatusEntry | undefined,
  trustedLogin: string,
): ReviewState | "absent" {
  if (!entry) return "absent";
  if (!entry.posterLogin || entry.posterLogin.trim().toLowerCase() !== trustedLogin.trim().toLowerCase()) {
    return "absent";
  }
  return entry.state;
}

/**
 * The "at arm time" half of the property (acceptance criteria 1-3): whatever
 * a caller computed in-process, THIS is what decides whether the LIVE status
 * on GitHub — read back and filtered by who posted it — still says a genuine
 * reviewer passed the PR. Deliberately narrow and orthogonal to
 * {@link decideAutoMergeArm}'s capped/override layer (which reasons about a
 * verdict computed BEFORE anything could have been posted, and is unaffected
 * by this gate): this function only ever answers "is the CURRENTLY-LIVE
 * remudero-review, filtered by provenance, a success" — a caller arms only
 * when BOTH this AND {@link decideAutoMergeArm} say yes.
 *
 * An absent/untrusted resolution refuses with a reason that never says
 * "failure" — {@link decideAutoMergeArm}'s "not success" wording is reserved
 * for a GENUINE failing review, so a forged or missing status is never
 * confused with one in a log line or an escalation (criterion 2: a hostile or
 * buggy poster's `failure` is exactly as inert here as its `success` would
 * be — neither can move this decision off "wait for a real one").
 */
export function decideAutoMergeArmAtSha(entry: ReviewStatusEntry | undefined, trustedLogin: string): ArmDecision {
  const resolved = resolveReviewProvenance(entry, trustedLogin);
  if (resolved === "success") {
    return {
      arm: true,
      reason: `remudero-review=success at this sha, posted by the trusted reviewer identity ('${trustedLogin}')`,
    };
  }
  if (resolved === "failure") {
    return { arm: false, reason: "remudero-review is not success" };
  }
  return {
    arm: false,
    reason: entry
      ? `remudero-review at this sha was posted by '${entry.posterLogin ?? "unknown"}', not the trusted ` +
        `reviewer identity ('${trustedLogin}') — treated as ABSENT, not as a failure, so a forged or ` +
        `mistaken poster can never itself block a merge a genuine reviewer would pass`
      : "no remudero-review status found for this sha — treated as ABSENT, arming withheld",
  };
}

// ── THE LEDGER-KEYED ARM DECISION (W1-T230 — THE STATUS CHANNEL PROVED DECORATIVE) ──
//
// #449's incident: the `remudero-review` commit status took SEVEN contradictory
// writes on one sha (including a keyword-only CAPPED success overwriting an
// executed failure), with one write 85 SECONDS AFTER the PR merged. GitHub's
// commit-status API is a mutable, last-write-wins channel that anything holding
// `gh` can post to — the W1-T203 provenance gate above closes one forge vector,
// but it is DARK in production (REVIEWER_IDENTITY_ENV is unset), so today the
// channel is exactly as trusted as before W1-T203 shipped. The house doctrine
// already answers this in the other direction: task status derives from GitHub
// rather than tasks.yaml because the yaml field proved decorative. Here the fix
// runs the other way — the arm decision derives from the orchestrator's OWN
// ledgered verdict because the status channel proved decorative AND writable,
// strictly worse than decorative. The status stays posted (branch protection,
// display) but from here on it is never an INPUT to this decision.
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE ARM DECISION (W1-T230). Given the most recent `review.posted` verdict
 * this orchestrator itself ledgered for a task ({@link priorReviewVerdictFromLedger})
 * and the CURRENT live head sha, decide whether to arm auto-merge. Pure — the
 * whole point is that a fresh process can re-derive this identically from
 * nothing but the ledger + the live head, never from in-process memory
 * (acceptance criterion 3: a resumed pass arms from the prior pass's ledgered
 * verdict, with no in-memory state).
 *
 * - No record at all → refuse. FAIL CLOSED: a head with no ledgered verdict is
 *   left unarmed, the same shape as "no verdict yet" (acceptance criterion 1 —
 *   a forged/live-only `remudero-review` success with no ledger backing must
 *   arm nothing).
 * - A record for a DIFFERENT sha → refuse. This is the sha binding that makes
 *   push-invalidates-review real at the decision layer, not only at display
 *   (acceptance criterion 4): a verdict ledgered before a subsequent push must
 *   never arm the new head.
 * - A record for THIS sha whose state isn't "success" → refuse (a genuine
 *   ledgered failure blocks exactly as before).
 * - A record for THIS sha that is "success" → arm — regardless of whatever the
 *   live status channel currently says, including a stubbed-unavailable read
 *   (acceptance criterion 2).
 */
export function decideArmFromLedgerVerdict(prior: PriorReviewVerdict | undefined, headSha: string): ArmDecision {
  if (!prior) {
    return {
      arm: false,
      reason: "no ledgered review.posted verdict found for this task — arming withheld (W1-T230, fail closed)",
    };
  }
  if (prior.headSha !== headSha) {
    return {
      arm: false,
      reason:
        `ledgered verdict is for a different head (${prior.headSha.slice(0, 7)}), not the current head ` +
        `(${headSha.slice(0, 7)}) — a push after the verdict was posted must not arm the new head (W1-T230)`,
    };
  }
  if (prior.state !== "success") {
    return { arm: false, reason: "the ledgered verdict for this exact head is not success (W1-T230)" };
  }
  return {
    arm: true,
    reason: `ledgered review.posted verdict for this exact head (${headSha.slice(0, 7)}) is success (W1-T230)`,
  };
}

/**
 * Recover the most recent `automerge.capped_override_granted` ledger line for
 * `taskId`, "last one wins" — the SAME scanning idiom {@link
 * priorReviewVerdictFromLedger} and every other precedence helper in this
 * codebase already use. Written by `rmd review <pr>
 * --override-capped-by/--override-capped-reason` (run-task.ts); consulted by
 * the arming path ({@link decideAutoMergeArm}) before refusing a CAPPED
 * verdict.
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
 * and the implement REPORT, and verdicts each criterion against its proof. It
 * does NOT post the `remudero-review` commit status itself — the deny-floor
 * (W1-T203) refuses any `gh api -X POST .../statuses/...` call from a worker,
 * so the reviewer only emits `REVIEW_VERDICT` lines and the ORCHESTRATOR posts
 * the authoritative status after folding them in (see reviewerVerdictContract,
 * parseReviewerVerdicts). It is told NEVER to edit code — and the runner spawns
 * it with a read-only settings profile, so this is belt-and-braces.
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
    `Do NOT post the \`${REVIEW_CONTEXT}\` commit status yourself — a worker`,
    `\`gh api -X POST .../statuses/...\` call is refused by the deny-floor`,
    `(W1-T203); it would simply fail. Instead, emit your per-criterion`,
    `REVIEW_VERDICT lines (below) and the ORCHESTRATOR will post the`,
    `authoritative status on sha ${input.headSha} after folding them in.`,
    ``,
    `End with a REPORT: the per-criterion verdicts and your reasoning for each.`,
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
    `MACHINE-READABLE OUTPUT (required — this is what the orchestrator posts`,
    `the status from, since you do not post it yourself): emit`,
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
 *
 * W1-T203 (i): when {@link REVIEWER_TOKEN_ENV} is set, this `gh` invocation
 * authenticates as the dedicated reviewer identity (`GH_TOKEN` overrides
 * whatever `gh` would otherwise pick up from ambient auth) rather than
 * whatever credential the operator/workers share — the one thing that makes
 * {@link resolveReviewProvenance}'s login compare meaningful at arm time.
 * Unset ⇒ falls back to ambient `gh` auth, byte-identical to before this
 * task (see the env var's own doc comment for the bootstrap-ordering
 * rationale). The token itself never reaches this function via an argument —
 * only via the orchestrator's OWN process env, which a worker's sandboxed
 * env/HOME cannot read (`settings/worker.json` already denies
 * `~/.config/remudero/**`).
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
  const reviewerToken = process.env[REVIEWER_TOKEN_ENV];
  const env = reviewerToken ? { ...process.env, GH_TOKEN: reviewerToken, GITHUB_TOKEN: reviewerToken } : process.env;
  execFileSync("gh", args, { stdio: "pipe", env });
}

// ── W1-T228: the status CHANNEL is last-write-wins across uncoordinated
// posters ────────────────────────────────────────────────────────────────
//
// GROUND TRUTH this hardens (plan/tasks.yaml W1-T228): PR 449 head 833561d
// took SEVEN `remudero-review` writes in one day. An EXECUTED verdict (2/6
// proofs run, FAILED) at 18:02:31 was overwritten by a KEYWORD-ONLY CAPPED
// success (0/6 executed) at 18:10:42 — weaker evidence clobbered stronger
// evidence on an IDENTICAL sha. A THIRD write landed at 18:16:20, ~85s AFTER
// the PR merged at 18:14:55 — the channel accepted a write against a closed
// lifecycle. W1-T230 already took the ARM decision off this channel onto the
// orchestrator's own ledger; this hardens the CHANNEL itself, regardless of
// the arm path, because the posted status is what branch protection reads,
// what the board renders, and what an operator opens a PR to see.
//
// ONE POST SITE enforces THREE RULES — {@link postReviewStatusGuarded} is the
// only call path `run-task.ts` uses from here on (the raw {@link
// postReviewStatus} above becomes an internal implementation detail + the
// injectable "real poster" in tests):
//   (i)   PRECEDENCE — a keyword-only/CAPPED verdict (no criterion's proof
//         actually EXECUTED) never overwrites an executed-evidence verdict
//         for the SAME sha. Executed may overwrite executed (a later real
//         run supersedes an earlier one) — {@link decideReviewStatusPost}.
//   (ii)  LIFECYCLE — no status writes to a merged or closed PR. Refused,
//         and the refusal is ledgered (never silently dropped).
//   (iii) SERIALIZATION — per task (== per PR; every real caller already
//         keys its `review.posted` ledger lines by task id), via the SAME
//         O_EXCL create-or-fail primitive drain-lock.ts/inflight-lock.ts use
//         ({@link acquireReviewStatusLock}) — adapted from a SINGLETON GUARD
//         (refuse a second concurrent holder) to a MUTEX (wait for the
//         holder, then proceed): the drain/inflight locks guard a whole RUN;
//         this guards one short read-decide-write critical section.
// READ BEFORE WRITE, HONESTLY: precedence needs the CURRENT posted state, so
// {@link postReviewStatusGuarded} reads the ledger and the live PR lifecycle
// AFTER acquiring the lock, never before — a read taken before the lock is
// exactly the TOCTOU gap the lock exists to close.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Whether ANY criterion's proof actually EXECUTED on this sha ("executed"),
 * or the verdict rests entirely on the ABSENCE of that evidence
 * ("no_evidence" — keyword-only and CAPPED are both this tier: neither ever
 * observed the repo state). Evidence outranks its absence, one-directionally
 * — see {@link decideReviewStatusPost}.
 */
export type ReviewEvidenceStrength = "executed" | "no_evidence";

export function reviewEvidenceStrength(
  criteria: ReadonlyArray<Pick<CriterionVerdict, "proof_exec">>,
): ReviewEvidenceStrength {
  const executed = criteria.some((c) => c.proof_exec === "executed_pass" || c.proof_exec === "executed_fail");
  return executed ? "executed" : "no_evidence";
}

/**
 * The most recent `review.posted` line's sha/state/evidence for `taskId` —
 * {@link decideReviewStatusPost}'s `prior` argument. Deliberately separate
 * from {@link PriorReviewVerdict} (the W1-T178/W1-T230 shape): those
 * consumers never needed evidence strength, and giving this task its own
 * type keeps their contracts untouched. Same "last one wins" scan idiom as
 * {@link priorReviewVerdictFromLedger} and `unmetFromLedger` (run-task.ts) —
 * `evidence` is derived from the SAME `proof_exec` array `run-task.ts`
 * already ledgers on every `review.posted` line (no new ledger field).
 */
export interface PostedReviewStatusRecord {
  headSha: string;
  state: ReviewState;
  evidence: ReviewEvidenceStrength;
}

export function lastPostedReviewStatusFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): PostedReviewStatusRecord | undefined {
  let prior: PostedReviewStatusRecord | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string") continue;
    if (line.state !== "success" && line.state !== "failure") continue;
    const proofExec: unknown[] = Array.isArray(line.proof_exec) ? (line.proof_exec as unknown[]) : [];
    const executed = proofExec.some((p) => p === "executed_pass" || p === "executed_fail");
    prior = { headSha: line.head_sha, state: line.state, evidence: executed ? "executed" : "no_evidence" };
  }
  return prior;
}

/**
 * The CURRENT PR lifecycle {@link decideReviewStatusPost}'s LIFECYCLE rule
 * checks against — fetched FRESH (never a snapshot from before ci/the
 * reviewer spawn ran) by {@link postReviewStatusGuarded}.
 */
export interface PrLifecycleState {
  merged: boolean;
  closed: boolean;
}

/**
 * Real fetcher: shells to `gh` (untested by unit — it shells out, same as
 * {@link postReviewStatus}'s own `gh api` call) — {@link
 * postReviewStatusGuarded}'s default; tests inject a fake instead.
 */
export function fetchPrLifecycle(prUrl: string): PrLifecycleState {
  const out = execFileSync("gh", ["pr", "view", prUrl, "--json", "state"], { encoding: "utf8" });
  const state = String((JSON.parse(out) as { state?: string }).state ?? "").toUpperCase();
  return { merged: state === "MERGED", closed: state === "CLOSED" };
}

/** One posting attempt {@link decideReviewStatusPost} judges. */
export interface ReviewStatusPostAttempt {
  headSha: string;
  state: ReviewState;
  evidence: ReviewEvidenceStrength;
}

export type ReviewStatusDecision = { post: true } | { post: false; reason: string };

/**
 * THE PURE W1-T228 GATE — the falsifier this task exists to prove is a unit
 * fixture, exactly like {@link judgeReview}/{@link decideArmFromLedgerVerdict}.
 * Order matters: LIFECYCLE is checked FIRST — a merged/closed PR refuses
 * regardless of precedence, since arguing about which verdict is "stronger"
 * on a PR nobody can act on anymore is moot.
 */
export function decideReviewStatusPost(
  attempt: ReviewStatusPostAttempt,
  prior: PostedReviewStatusRecord | undefined,
  lifecycle: PrLifecycleState,
): ReviewStatusDecision {
  if (lifecycle.merged || lifecycle.closed) {
    return {
      post: false,
      reason:
        `PR is already ${lifecycle.merged ? "merged" : "closed"} — refusing to post remudero-review against ` +
        `a closed lifecycle (W1-T228 lifecycle rule)`,
    };
  }
  if (
    prior !== undefined &&
    prior.headSha === attempt.headSha &&
    prior.evidence === "executed" &&
    attempt.evidence === "no_evidence"
  ) {
    return {
      post: false,
      reason:
        `refusing to overwrite an executed-evidence ${prior.state} verdict for ${attempt.headSha.slice(0, 7)} ` +
        `with a keyword-only/CAPPED verdict (W1-T228 precedence: evidence outranks its absence)`,
    };
  }
  return { post: true };
}

// ── W1-T228 serialization: an O_EXCL MUTEX (not a singleton guard) ────────

export interface ReviewStatusLockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export class ReviewStatusLockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: ReviewStatusLockInfo,
  ) {
    super(
      `timed out waiting for the review-status lock ${lockPath} (held by pid ${holder.pid} on ` +
        `${holder.host}, since ${holder.startedAt})`,
    );
    this.name = "ReviewStatusLockTimeoutError";
  }
}

function readReviewStatusLock(lockPath: string): ReviewStatusLockInfo | null {
  try {
    const o = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof o?.pid === "number") return o as ReviewStatusLockInfo;
    return null;
  } catch {
    return null; // missing, unreadable, or garbage → treat as "no valid holder"
  }
}

function reviewStatusLockDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AcquireReviewStatusLockOpts {
  /** Override the recorded holder identity (tests). Defaults to this process. */
  info?: Partial<ReviewStatusLockInfo>;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Poll cadence while a LIVE holder blocks acquisition (tests speed this up). */
  retryMs?: number;
  /** Give up and throw {@link ReviewStatusLockTimeoutError} after this long. */
  timeoutMs?: number;
}

export interface ReviewStatusLockHandle {
  readonly path: string;
  /** Remove the lock. Idempotent — safe to call from a finally. */
  release(): void;
}

/**
 * Acquire the per-task review-status MUTEX — the SAME O_EXCL create-or-fail
 * primitive {@link import("./drain-lock.js").acquireDrainLock}/{@link
 * import("./inflight-lock.js").acquireInflightLock} use (creation is atomic,
 * so two racing acquirers cannot both win; a stale lock — holder pid dead, or
 * the file unreadable/garbage — is reclaimed), adapted from a SINGLETON
 * GUARD to a MUTEX: where those THROW immediately when a live holder is
 * found, this WAITS (bounded by `timeoutMs`) and retries — the callers here
 * are N uncoordinated posters that must all eventually run their own
 * read-decide-write, never a second run of the same long-lived task that
 * should simply refuse to start.
 */
export async function acquireReviewStatusLock(
  lockPath: string,
  opts: AcquireReviewStatusLockOpts = {},
): Promise<ReviewStatusLockHandle> {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const retryMs = opts.retryMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const info: ReviewStatusLockInfo = {
    pid: opts.info?.pid ?? process.pid,
    host: opts.info?.host ?? hostname(),
    startedAt: opts.info?.startedAt ?? new Date().toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // O_EXCL: create-or-fail. Winner writes its identity; there is no TOCTOU gap.
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readReviewStatusLock(lockPath);
      if (held && isAlive(held.pid)) {
        if (Date.now() >= deadline) throw new ReviewStatusLockTimeoutError(lockPath, held);
        await reviewStatusLockDelay(retryMs); // MUTEX: wait + retry, never throw on a live holder
        continue;
      }
      try {
        unlinkSync(lockPath); // stale (dead pid / garbage) → clear and loop to re-create
      } catch {
        // another actor may have cleared it concurrently; retry the create
      }
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — idempotent
      }
    },
  };
}

// ── W1-T228: the single guarded post site ─────────────────────────────────

export interface PostReviewStatusGuardedOpts {
  owner: string;
  repo: string;
  sha: string;
  state: ReviewState;
  description?: string;
  /** The PR the lock/ledger key off — every real caller already keys its
   * `review.posted` ledger lines by this same id (the task id, or the
   * `dep-review-PR<n>`/`PR-<n>` synthetic ids `run-task.ts` falls back to). */
  taskId: string;
  evidence: ReviewEvidenceStrength;
  ledgerPath: string;
  runId: string;
  /**
   * Fresh lifecycle read for THIS attempt — real callers pass
   * `() => fetchPrLifecycle(prUrl)`; tests inject a fake. Called INSIDE the
   * lock, never before (see the module doc comment above).
   */
  fetchLifecycle: () => PrLifecycleState;
  /** Injected raw poster (tests). Defaults to {@link postReviewStatus}. */
  post?: (o: { owner: string; repo: string; sha: string; state: ReviewState; description?: string }) => void;
  lockOpts?: AcquireReviewStatusLockOpts;
}

export interface PostReviewStatusGuardedResult {
  posted: boolean;
  /** Present only when `posted` is false — see {@link decideReviewStatusPost}. */
  reason?: string;
}

/**
 * THE single call path for posting `remudero-review` from here on (W1-T228).
 * Acquires the per-task lock, reads the ledger + live PR lifecycle FRESH
 * (inside the lock — read-before-write, honestly racy without it), decides
 * via the pure {@link decideReviewStatusPost}, and either posts (delegating
 * to the raw {@link postReviewStatus}) or refuses — EVERY attempt is
 * ledgered, including refusals (`review.post_refused`), so a refused write
 * leaves a trace instead of the same silent blindness this task fixes.
 */
export async function postReviewStatusGuarded(
  opts: PostReviewStatusGuardedOpts,
): Promise<PostReviewStatusGuardedResult> {
  const post = opts.post ?? postReviewStatus;
  const lockDir = join(dirname(opts.ledgerPath), "review-status-locks");
  const lockPath = join(lockDir, `${opts.taskId}.lock`);
  const handle = await acquireReviewStatusLock(lockPath, opts.lockOpts);
  try {
    // READ BEFORE WRITE, INSIDE THE LOCK — a read taken before acquiring the
    // lock would leave open exactly the TOCTOU gap the lock exists to close.
    const prior = lastPostedReviewStatusFromLedger(readLedgerLines(opts.ledgerPath), opts.taskId);
    const lifecycle = opts.fetchLifecycle();
    const decision = decideReviewStatusPost(
      { headSha: opts.sha, state: opts.state, evidence: opts.evidence },
      prior,
      lifecycle,
    );
    if (!decision.post) {
      appendLedger(opts.ledgerPath, {
        run_id: opts.runId,
        task_id: opts.taskId,
        step: "review.post_refused",
        head_sha: opts.sha,
        attempted_state: opts.state,
        evidence: opts.evidence,
        reason: decision.reason,
      });
      return { posted: false, reason: decision.reason };
    }
    post({ owner: opts.owner, repo: opts.repo, sha: opts.sha, state: opts.state, description: opts.description });
    return { posted: true };
  } finally {
    handle.release();
  }
}
