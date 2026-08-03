import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { classifyFailure } from "./classify.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { reclaimStaleLock } from "./fs-race-safe.js";
import { appendLedger } from "./ledger.js";
import { isInPlanScope } from "./plan-architect.js";
import { visibleCriteria, type AcceptanceCriterion } from "./plan.js";
import { loadDefaultPolicy } from "./policy.js";
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
 *   executed_stale — (W1-T273) a `grep:` proof matched on the head, but the
 *                     SAME pattern ALSO matches the PR's MERGE-BASE — i.e. it
 *                     would have exited 0 before the task's work ever landed,
 *                     so it discriminates nothing (W1-T267's fifth criterion,
 *                     verbatim: `workerKeychainPaths` matched two unrelated
 *                     hits on the pre-work commit and was recorded as
 *                     substantiated regardless). A DOWNGRADE, not a failure —
 *                     see {@link preexistingProofHits}'s doc — it withdraws
 *                     the proof's positive override and falls back to the
 *                     keyword floor verbatim, exactly like `exec_error`
 *                     degrades, but recorded under its own name because the
 *                     cause is a proof-authoring gap, not an environment
 *                     hiccup. `unit test:` proofs never produce this outcome
 *                     (design, explicitly out of scope — a forward-
 *                     referencing test path legitimately matches nothing
 *                     before the work and everything after).
 */
/**
 * WHY a criterion produced no executed outcome. Diagnostic only — it never affects `met`, `state`,
 * the keyword floor, or whether a verdict is capped. It exists so a CAPPED `0/N` says WHICH KIND it
 * is instead of collapsing four different causes into one reassuring green.
 */
export type ProofSkipReason = "no-dialect" | "prose-no-match" | "exec-error" | "no-exec-context";

export type ProofExecOutcome =
  | "executed_pass"
  | "executed_fail"
  | "not_executable"
  | "exec_error"
  | "executed_stale";

/** One criterion's verdict against its stated proof. */
export interface CriterionVerdict {
  claim: string;
  proof: string;
  met: boolean;
  reason: string;
  /** See {@link ProofExecOutcome}. Always present — `not_executable` is the safe
   * default when the proof is prose, or no PR-head checkout was supplied. */
  proof_exec: ProofExecOutcome;
  /** See {@link ProofSkipReason}. Absent when the proof executed. */
  proof_skip?: ProofSkipReason;
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
  /**
   * W1-T166: copied verbatim from the judged {@link AcceptanceCriterion.holdout}.
   * `judgeReview`'s `state`/`floorState` fold a holdout criterion in exactly like
   * any other (the reviewer judges visible AND holdout); this flag exists so a
   * CALLER can still tell the two apart — {@link visibleCriteria} reads it to keep
   * a holdout criterion's claim/proof text out of every worker-facing surface
   * (the fix rung's unmet-criteria block, the `review.posted` ledger's
   * `unmet_criteria`/`reasons`, the posted commit-status description), while the
   * PASS/FAIL verdict itself never depends on which surface reads it.
   */
  holdout?: boolean;
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
   * (W1-T273) A checkout of the PR's MERGE-BASE — the commit the PR branched
   * from, BEFORE the task's own work landed. Optional and independent of
   * `headCheckoutDir`'s own presence: the caller reaches it with one
   * `git merge-base` over a checkout the review already has (no new gateway,
   * no new network call — design doc, plan/tasks.d/W1-T273-*.yaml). Consulted
   * ONLY to test a `grep:` proof's pattern for non-discrimination (see
   * {@link preexistingProofHits}); absent ⇒ that check never runs and every
   * grep proof that passes on the head is `executed_pass` exactly as it was
   * before this task — byte-identical to every caller/fixture that predates it.
   */
  baseCheckoutDir?: string;
  /**
   * Injected proof executor. Real callers omit this — {@link execWhitelistedProof}
   * (the real, whitelist-bounded shell-out) is the default. Tests inject a fake so
   * override/degrade semantics are proven without touching the filesystem or a
   * shell (acceptance: "unit test over an injected executor"). Also the executor
   * {@link preexistingProofHits} reuses against `baseCheckoutDir` — the SAME
   * function, just a different `cwd`, so an injected fake needs no special-casing
   * to cover both.
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
  /**
   * W1-T58 (ratifies P3 via P8/RETRO-1784058021334, Standing rule 15 — "a worker
   * may never [edit its own criteria]"): true when the diff ITSELF adds a
   * `satisfied_by:` line or removes an existing criterion field (`claim:`/
   * `proof:`/`satisfied_by:`) in `plan/tasks.yaml` — see {@link
   * checkSatisfiedByGuard}, the same diff-derived predicate — while ALSO
   * touching something outside `plan/**` (`!planOnly`; the only Architect-vs-
   * worker signal this pure function has — a worker's own task diff is never
   * plan-only in this codebase, only `rmd plan` produces one, and that path
   * never reaches this field's consequence — see run-task.ts's `runFixRung`).
   * FORCES `state`/`floorState` to `"failure"` exactly like `testTheater`: the
   * tampering itself is the violation, independent of whether any NAMED
   * criterion mechanically passes (a worker could edit `plan/tasks.yaml` to
   * match its diff and still have every original criterion read "met"). Never
   * suppressible by {@link applyVerdictStability} (folded into `floorState`
   * too) — this is a deterministic diff fact, not a semantic reviewer opinion.
   * A genuine Architect correction (plan-only) never trips it.
   */
  criteriaTampered?: boolean;
  /**
   * W1-T274: claims the body ({@link ReviewEvidence.report}) makes about its
   * OWN changeset that are FALSE against the diff it actually shipped — see
   * {@link bodyContradictsDiff} for the exact recognised shapes (a stated
   * file count, a "no src/"/"plan-only"/"data-only" absence claim, a named
   * file in an "exactly N files: …" enumeration) and why anything outside
   * them is silence, never a verdict. `[]` when the body makes no such claim,
   * OR makes one this check cannot decide (criterion: "a body making no
   * changeset claim is neither passed nor failed by this check"). Non-empty
   * FORCES `state`/`floorState` to `"failure"` exactly like `testTheater`/
   * `criteriaTampered`: a body that contradicts its own diff is a false
   * statement the gate is being asked to merge on, not a legibility problem —
   * it fails the review, with the contradiction NAMED (see {@link
   * failSummary}), because an unexplained red is the shape that gets
   * overridden. Structural (diff+report-derived), never a semantic reviewer
   * opinion, so — like `criteriaTampered` — never suppressible by {@link
   * applyVerdictStability}. Optional so every OTHER `ReviewVerdict` literal in
   * the codebase (run-task.ts's ledger-reconstructed seed verdicts, every
   * fixture that predates this task) needs no update; only {@link
   * judgeReview} populates it.
   */
  changesetContradictions?: ChangesetClaimContradiction[];
  /**
   * W1-T297 (Standing rule 25 — INSTRUMENT CHANGES RIDE ALONE): true when the
   * diff changes at least one measurement-instrument path ({@link
   * INSTRUMENT_SURFACE} — a CI workflow's measurement wiring, a ratchet/
   * coverage script, a recorded baseline, or the mutation-scope config) AND
   * at least one src/ PRODUCT path (`test/` excluded — see {@link
   * isProductPath}) IN THE SAME PR. "the instrument is right" and "the code
   * is right" are two independently falsifiable claims; a diff that ships
   * both proves neither, because the code's own falsifiers were graded by
   * the very version of the instrument that shipped beside them (the
   * #585/#586 arc this task's rationale documents: a coverage flag, a
   * diff-coverage carve-out, and a re-captured baseline all rode inside
   * ordinary fix-rung strikes). FORCES `state`/`floorState` to `"failure"`
   * exactly like `criteriaTampered`/`changesetContradictions`: this is a
   * structural, diff-derived fact, never a semantic reviewer opinion, so —
   * like them — never suppressible by {@link applyVerdictStability}. An
   * instrument-only PR (even one carrying its own `test/` fixture, or a
   * `docs/` update) is the SANCTIONED shape and reads `false`; so does a
   * src-only, plan-only, or docs-only PR. See {@link
   * detectInstrumentEntanglement} for the pure predicate this folds in.
   */
  instrumentEntangled?: boolean;
  /**
   * The observed evidence behind a `true` {@link instrumentEntangled} —
   * the instrument paths found and the src/ product paths beside them
   * (W1-T186 emitter discipline: never a bare "entangled" with nothing
   * named). `undefined` whenever `instrumentEntangled` is `false`/absent.
   */
  instrumentEntanglementPaths?: { instrumentPaths: string[]; srcPaths: string[] };
  /**
   * W1-T166 (the reward-hacking measurement): visible-pass-rate minus
   * holdout-pass-rate, over this verdict's own criteria — `(visible criteria
   * met / visible criteria count) − (holdout criteria met / holdout criteria
   * count)`. A worker that can see (and so can optimize toward) only the
   * visible criteria is expected to pass them at a higher rate than the
   * holdout ones it never saw; a large positive gap is the SIGNAL SpecBench
   * names (reward-hacking against the visible test suite). `null` when the
   * gap is not MEASURABLE — no holdout criteria were declared (nothing to
   * compare against) or no visible criteria were declared (no baseline rate).
   * Never forces `state` — this is a MEASUREMENT ledgered per run
   * (`reward_hacking_gap`, run-task.ts), not itself a pass/fail gate. Optional
   * (mirrors `floorState`'s doc) so every OTHER `ReviewVerdict` literal in the
   * codebase (ledger-reconstructed placeholders in run-task.ts/sweep.ts, and
   * every fixture that predates this field) needs no update; only
   * {@link judgeReview} populates it — treat absent identically to `null`.
   */
  rewardHackingGap?: number | null;
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
 *
 * W1-T219 (recon R-13(i)): was 0.34 — echoing barely a THIRD of a proof's
 * distinctive tokens read as "responsive", which a report can hit by accident
 * (shared vocabulary with the claim) with no real engagement with the proof at
 * all. Raised to a genuine MAJORITY: a report must echo more than half of a
 * proof's distinctive keywords to count as substantiating it.
 */
const MIN_COVERAGE = 0.6;

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
//   (3) `grep: <pattern> in <path>` — a leading `grep:` label, the pattern
//       free text, followed by `in <path>` (a trailing token that looks like a
//       path — contains `/` or `.`, no whitespace), a FILE or a DIRECTORY
//       (searched recursively either way). REQUIRED (W1-T219, recon R-13(iii)):
//       no `in <path>` clause is not_executable, never a repo-wide default
//       search — a pattern matching one incidental line ANYWHERE is not
//       evidence for a SPECIFIC criterion, and `executed_pass` OVERRIDES
//       keyword coverage, so an unscoped match used to certify on nothing more
//       than accidental vocabulary overlap. A literal `*` in the path is
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
/** W1-T277: the third house dialect — `demonstration: <what the operator must
 * do>` — is the honest OPPOSITE of `grep:`/`unit test:`: it names a proof the
 * harness DECLINES to check, on the record, rather than one it mechanically
 * runs. {@link parseWhitelistedProof} always refuses it (null, by
 * construction — there is nothing to execute); legality is a `verify:human`-
 * only restriction enforced by task-linter.ts, never here (review.ts has no
 * opinion on a task's `verify` field). */
const DIALECT_DEMO_RE = /^demonstration:\s*(.+)$/i;

/**
 * A markdown code span WRAPPING the whole string: N backticks, the body, then the SAME N backticks.
 * The `\1` backreference is what makes this safe — it only ever removes a matched pair at the two
 * ENDS, so an interior backtick (a `grep:` pattern searching for a template literal, say) is never
 * touched. `[\s\S]` rather than `.` so a multi-line span is handled; the inner `\s*` absorbs the
 * padding of the `` ` grep: … ` `` form CommonMark allows.
 */
const WRAPPING_CODE_SPAN_RE = /^(`+)\s*([\s\S]*?)\s*\1$/;

/** Unwrap a whole-string code span, once. Returns the input unchanged when it is not wrapped. */
function stripCodeSpan(s: string): string {
  const m = s.match(WRAPPING_CODE_SPAN_RE);
  return m ? m[2].trim() : s;
}

/** Does this text already lead with a dialect label? Used to keep the bare form on its fast path. */
function matchesDialectPrefix(s: string): boolean {
  return DIALECT_TEST_RE.test(s) || DIALECT_GREP_RE.test(s) || DIALECT_DEMO_RE.test(s);
}
/** The project's own `test` script glob (package.json) — reused verbatim so a
 * name-filtered run scopes to exactly the suite `npm test` would run. */
const TEST_GLOB = "test/**/*.test.ts";

/**
 * True when a proof's TEXT is written in a recognised house dialect — either
 * meant to be mechanically executed (`grep:`/`unit test:`, W1-T72) or an
 * honest, on-the-record declaration that no execution will ever occur
 * (`demonstration:`, W1-T277) — independent of whether
 * {@link parseWhitelistedProof} actually accepted it (an unsafe/unparseable
 * dialect body, or a `demonstration:` body which is never executable by
 * construction, still returns null from that function). Used ONLY for the
 * `floorDegraded` legibility signal (W1-T72) — never affects execution.
 */
export function isDialectPrefixed(proof: string): boolean {
  const trimmed = proof.trim();
  return DIALECT_GREP_RE.test(trimmed) || DIALECT_TEST_RE.test(trimmed) || DIALECT_DEMO_RE.test(trimmed);
}

/**
 * True when a proof's TEXT is written in the `demonstration:` dialect
 * (W1-T277) — the single source of truth task-linter.ts imports rather than
 * redeclaring {@link DIALECT_DEMO_RE} itself, so the verify:human-only
 * legality restriction it enforces can never drift from what review.ts
 * actually recognises as this dialect.
 */
export function isDemonstrationProof(proof: string): boolean {
  return DIALECT_DEMO_RE.test(proof.trim());
}

/** Sentence-level punctuation a bare test-name title would not carry: a
 * comma, colon, semicolon, parenthetical aside, an em/en dash, or an
 * ellipsis. Any one of these marks a body as PROSE, not a plain title. */
const PROSE_PUNCTUATION_RE = /[,;:()]|--|—|–|\.\.\./;
/** Above this length a body reads as a description, not a plausible bare
 * test title, regardless of punctuation (a title this long is prose). */
const BARE_TEST_NAME_MAX_LEN = 60;

/**
 * Deterministic predicate (W1-T161, #349/W1-T149): does a name-filtered
 * `unit test:` proof BODY read as a long PROSE DESCRIPTION of behavior — the
 * house convention — rather than a short, bare TEST-NAME-shaped string?
 * {@link judgeCriterion} uses this ONLY to interpret a ZERO-MATCH outcome:
 *   - prose shape     -> `not_executable` (keyword floor stands, floorDegraded)
 *   - bare-name shape -> `executed_fail` (W1-T72's test-theater guard, PRESERVED)
 *
 * LIVE INCIDENT this fixes: #349/W1-T149's own proof read "a seeded task
 * dispatched N times with no new owned PR trips the per-task circuit breaker
 * at N+1 — exactly one needs-human escalation naming the loop, and zero
 * further dispatches (the W1-T29 x10 spin shape)" — a prose paraphrase of a
 * REAL, PASSING test titled "P29(ii) the W1-T29 x10 spin shape: …", worded
 * completely differently. `--test-name-pattern` matched zero tests on that
 * paraphrase, and the pre-fix rule minted an `executed_fail`, hard-blocking a
 * green-code PR until a human re-reviewed it by hand.
 *
 * A pure length/punctuation shape check over the body text — no model call,
 * so the same body always classifies the same way (acceptance #3). Threshold
 * picked from this repo's own convention: a bare, fabricated test-theater
 * title is written to LOOK like a real short title (one plain clause, no
 * internal punctuation), while a genuine prose description — like the #349
 * fixture above — routinely carries a comma/colon/dash/ellipsis/parenthetical
 * and/or runs well past a plausible title's length.
 */
export function looksLikeProseDescription(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length > BARE_TEST_NAME_MAX_LEN) return true;
  return PROSE_PUNCTUATION_RE.test(trimmed);
}

/**
 * Split a `grep:` dialect body into its pattern + optional path. The path is
 * the trailing token after the LAST `\s+in\s+` boundary that itself looks like
 * a path/glob (contains `/`, `.`, or `*`, no whitespace) — this keeps
 * multi-word patterns like "wx flag present" intact while still correctly
 * splitting "... in src/lib/config.ts". No such boundary ⇒ the body carries no
 * TARGET at all and {@link parseDialectGrep} refuses it (W1-T219, below).
 */
const DIALECT_GREP_PATH_RE = /^(.*?)\s+in\s+(\S*[./*]\S*)$/i;

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
  // W1-T219 (recon R-13(iii)): a `grep:` proof with NO `in <path>` clause used
  // to default to a recursive, whole-repo search — a pattern matching one
  // incidental line ANYWHERE certified the criterion (`executed_pass`
  // positively overrides keyword coverage), which is not evidence for a
  // SPECIFIC criterion. Rather than weaken that override (which is what makes
  // real observation trustworthy at all — see W1-T65/#100), require an
  // explicit target: no path ⇒ refuse (null), leaving the proof on the
  // keyword floor instead of mechanically executing an unscoped match.
  if (path === undefined) return null;
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
  // "-a" (treat binary as text) makes the verdict INDEPENDENT OF THE HOST'S GREP. Without it a
  // target carrying a raw NUL byte is judged "binary" and the two implementations DISAGREE —
  // MEASURED on this host against the same file and pattern: BSD grep 2.6.0-FreeBSD exits 0 with
  // "Binary file … matches", ugrep 7.5.0 exits 1 with no output. So `grep: export function
  // callSiteViolations in src/lib/task-linter.ts` (PR #1071) passes or fails according to which
  // binary the review host happens to resolve, which is not a proof. With "-a" both exit 0 and
  // print the matching line. Exactly 2 of this repo's 96 source files carry a NUL byte, and
  // task-linter.ts — the file this very check lives in — is one of them.
  //
  // DOWNSIDE, bounded: "-a" can only widen. It cannot invent a match — the pattern's bytes must
  // still occur in the file — and it changes nothing for a NUL-free target (verified). The one
  // new possibility is a genuinely binary target whose bytes happen to contain the pattern, which
  // requires the proof's author to have named a binary path explicitly. Note this is not even a
  // widening relative to BSD grep, which already reported exit 0 for that file; it is ugrep that
  // was silently reporting "no match", and "-a" removes the disagreement rather than adding
  // matches.
  return { kind: "grep", command: "grep", args: ["-arn", "--", pattern, path], label: `${pattern} in ${path}` };
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
/**
 * WHY this verdict is capped, as one short token for the ledger line and the posted status.
 *
 * A CAPPED `0/N` is four different situations wearing one face: proofs that never parsed, proofs
 * that parsed and named nothing, proofs whose execution errored, and a run that never had a checkout
 * to execute against. Telling them apart from the outside cost a full recon once (the markdown
 * code-span defect, PR #1037 0/4 and PR #1057 0/6); this makes the next one a one-line read.
 *
 * PURE and DIAGNOSTIC. It reads the verdicts it is given and returns a label — it never affects
 * `met`, `state`, the keyword floor, or whether the verdict is capped. Returns `undefined` when
 * nothing was capped, so the field is simply absent on a healthy verdict.
 */
export function cappedReason(
  criteria: ReadonlyArray<Pick<CriterionVerdict, "proof_exec" | "proof_skip">>,
): string | undefined {
  const skipped = criteria.filter((c) => c.proof_skip !== undefined);
  if (skipped.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const c of skipped) counts.set(c.proof_skip!, (counts.get(c.proof_skip!) ?? 0) + 1);
  // Deterministic: highest count first, then alphabetically, so the same verdict always renders the
  // same string (a ledger field that reorders itself is not comparable across runs).
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason}:${n}`)
    .join(",");
}

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
  // A dialect proof wrapped in a markdown CODE SPAN is the same proof. `parseAcceptanceBlock`
  // extracts the bullet text verbatim, so an author who writes `` `grep: x in y` `` (rendering
  // identically to "grep: x in y" in every GitHub view) reached the matchers below with a leading
  // backtick, failed both, and fell through to `not_executable` — a CAPPED 0/N verdict on work
  // whose proofs are perfect. Measured: PR #1037 parsed 0/4 and PR #1057 0/6 this way, while
  // PR #1038's unwrapped proofs parsed 8/8.
  //
  // WHY THE STRIP IS A FALLBACK AND NOT AN ENTRY-POINT NORMALISATION. `GREP_FENCE_RE` (the legacy
  // W1-T65 shape, below) matches ``​`grep -rn x y`​`` and REQUIRES its backticks — stripping them up
  // front, here or in `parseAcceptanceBlock`, silently converts that proof to `null`. So the bare
  // text is tried first and the unwrapped text only if it fails, leaving every other consumer of
  // the extracted string — the claim text, `plan-pr-emitter`'s emptiness check, the legacy shapes —
  // reading exactly what the author wrote.
  const dialectSource = matchesDialectPrefix(trimmed) ? trimmed : stripCodeSpan(trimmed);
  const dialectTest = dialectSource.match(DIALECT_TEST_RE);
  if (dialectTest) return parseTestTarget(dialectTest[1]);
  const dialectGrep = dialectSource.match(DIALECT_GREP_RE);
  if (dialectGrep) return parseDialectGrep(dialectGrep[1]);
  // W1-T277: `demonstration:` is never executable, by construction — it names
  // an operator action, not an artifact this process can observe. Refuse
  // (null) rather than falling through to a legacy shape below; task-linter.ts
  // is what decides whether that null is a defect (verify:auto) or the whole
  // point (verify:human) — review.ts has no `verify` field to consult here.
  if (DIALECT_DEMO_RE.test(dialectSource)) return null;

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
// W1-T253 (P37 CONSUMERS) SUPERSEDES the exported literal this used to be: #916 exported
// `DEFAULT_PROOF_TIMEOUT_MS` so test/policy.test.ts's drift lock could compare the policy row
// against the literal. With the literal gone that comparison is impossible AND unnecessary —
// drift is structurally unreachable once the code reads the policy. policy.test.ts drops that
// one assertion (the other eight literals still exist and keep theirs); the stronger property
// is asserted in test/policy-consumers.test.ts.
//
// W1-T253 (P37 CONSUMERS): this is now a POLICY READ (plan/policy.yaml's `proofTimeoutMs`),
// never a source literal — the 60s above is DATA now, floored at load (policy.ts's
// `numberField`, min 60000 — the "30000 regression" the substrate refuses to accept), so a
// retune is a reviewed plan PR, not a code edit. `loadDefaultPolicy` self-locates
// plan/policy.yaml from this module's own install location (never cwd), so this default
// resolves identically no matter what directory `execWhitelistedProof` is called from.
function defaultProofTimeoutMs(): number {
  return loadDefaultPolicy().values.proofTimeoutMs;
}
const npmCiPrimed = new Set<string>();
/** Process-wide latch for {@link ensureBrowsersOnce} — see its doc comment for why
 * this is NOT keyed by cwd the way {@link npmCiPrimed} is. */
let browserPreflightDone = false;

/** The ONE process spawn a proof execution performs — the test/grep run itself.
 * Injectable so a test can prove, by COUNTING, that a fast-failed proof never
 * spawns the runner at all; timing that would only prove it was quick. */
export type ProofSpawner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => string;

/** Production {@link ProofSpawner}: no shell, stdout captured, hard timeout. */
const defaultProofSpawner: ProofSpawner = (command, args, cwd, timeoutMs) =>
  execFileSync(command, args as string[], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    encoding: "utf8",
  });

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
 * The Chromium builds a `test` proof needs on THIS host, derived from the pinned
 * Playwright's own `browsers.json` — the same source `npx playwright install`
 * reads, so the two can never disagree about which revision is wanted.
 *
 * WHY THIS EXISTS (live incident, 2026-07-29, PR #892). `ci` runs
 * `npx playwright install --with-deps chromium` before EVERY test job
 * (.github/workflows/ci.yml). The review host runs it NEVER — its browser cache
 * is only ever populated by hand. So when #863 bumped `playwright` 1.61.1 →
 * 1.62.0, the wanted Chromium revision moved 1228 → 1234, the review host still
 * had only 1228, and every `chromium.launch()` in `test/serve.*.test.ts` died
 * with `Executable doesn't exist at …/chromium_headless_shell-1234/…`. Because a
 * whole-file `test` proof's verdict IS its exit code (see
 * {@link execWhitelistedProof}), that host-environment breakage was posted as
 * `executed_fail` — "proof executed and FAILED on the PR head" — on code that
 * `ci` was passing. W1-T202 burned FIVE identical FAIL rounds on it and its
 * author shipped two mitigations for a race that did not exist. This preflight
 * removes the asymmetry at its source: the review host installs what `ci`
 * installs, before it judges.
 *
 * Scoped to the Chromium family on purpose — `chromium` is the only browser this
 * repo's suites ever launch, and the only one `ci` installs. `ffmpeg` (also
 * pulled in by an `install chromium`) is deliberately NOT required here: it backs
 * video capture, which no proof uses, so demanding it would trigger a pointless
 * 180MB re-install on a cache that can already launch every test we have.
 *
 * The `-` → `_` rewrite is Playwright's own on-disk convention:
 * `chromium-headless-shell` rev 1234 lives in `chromium_headless_shell-1234`,
 * while `chromium` rev 1234 lives in `chromium-1234`.
 */
export function requiredChromiumDirs(browsersJsonText: string): string[] {
  const parsed = JSON.parse(browsersJsonText) as { browsers?: { name?: string; revision?: string | number; installByDefault?: boolean }[] };
  const wanted = [];
  for (const b of parsed.browsers ?? []) {
    if (b.installByDefault !== true) continue; // tip-of-tree channels are opt-in; never auto-fetch one
    if (b.name !== "chromium" && b.name !== "chromium-headless-shell") continue;
    if (b.revision === undefined) continue;
    wanted.push(`${b.name.replace(/-/g, "_")}-${b.revision}`);
  }
  return wanted;
}

/** Everything {@link ensureBrowsers} touches outside itself, injected so the
 * decision logic is provable without a filesystem, a network fetch, or a 180MB
 * download. */
export interface BrowserPreflightDeps {
  /** The pinned Playwright's `browsers.json`, or null when it could not be read
   * (no `node_modules` yet, a truncated install) — NOT evidence of anything. */
  browsersJsonText: string | null;
  /** True when `<cacheRoot>/<dir>` holds a COMPLETE install. Playwright writes an
   * `INSTALLATION_COMPLETE` marker last, so a half-extracted directory that would
   * fail to launch reads as absent here rather than as present. */
  isInstalled: (dir: string) => boolean;
  /** Fetch the missing builds (production: `npx playwright install chromium`). */
  install: () => void;
  log?: (msg: string) => void;
}

/**
 * Mirror `ci`'s browser-install step on the review host, ONCE per process, before
 * the first `test` proof runs. See {@link requiredChromiumDirs} for the incident
 * this closes.
 *
 * Best-effort by the same doctrine as {@link ensureDeps}: this never throws and
 * never decides a verdict. If the install fails or the manifest is unreadable,
 * the proof still runs and still reports whatever it reports — a preflight that
 * could itself fail a criterion would just relocate the false-FAIL problem it
 * exists to remove. What it returns is a FACT about what happened, so callers and
 * tests can assert on it:
 *   - `"ok"`          — every wanted build was already present; nothing spawned.
 *   - `"installed"`   — builds were missing and the install ran to completion.
 *   - `"failed"`      — builds were missing and the install threw.
 *   - `"unreadable"`  — the manifest could not be read, so "wanted" is unknown.
 */
export function ensureBrowsers(deps: BrowserPreflightDeps): "ok" | "installed" | "failed" | "unreadable" {
  if (deps.browsersJsonText === null) return "unreadable";
  let required: string[];
  try {
    required = requiredChromiumDirs(deps.browsersJsonText);
  } catch {
    return "unreadable"; // malformed manifest — same "we cannot know" class as an unreadable one
  }
  const missing = required.filter((dir) => !deps.isInstalled(dir));
  if (missing.length === 0) return "ok";
  deps.log?.(`(browser preflight: installing Chromium for the pinned Playwright — missing ${missing.join(", ")})`);
  try {
    deps.install();
  } catch (e) {
    deps.log?.(`(browser preflight: install FAILED — ${String((e as Error)?.message ?? e)}; browser proofs may report exec_error)`);
    return "failed";
  }
  return "installed";
}

/** Production {@link ensureBrowsers} wiring, memoised per process — the browser
 * cache is HOST-global (not per-checkout like `node_modules`), so one check per
 * review process covers every proof it goes on to run. */
function ensureBrowsersOnce(cwd: string): void {
  if (browserPreflightDone) return;
  browserPreflightDone = true; // attempted regardless of outcome — never retry-storm a download
  const manifest = join(cwd, "node_modules", "playwright-core", "browsers.json");
  ensureBrowsers({
    browsersJsonText: existsSync(manifest) ? readFileSync(manifest, "utf8") : null,
    isInstalled: (dir) => existsSync(join(playwrightCacheRoot(), dir, "INSTALLATION_COMPLETE")),
    install: () => installPinnedChromium(cwd),
    log: (m) => console.log(m),
  });
}

/** The checkout's OWN Playwright CLI entry. Deliberately not `npx playwright`:
 * `npx` resolves a name, and on a cache miss will happily FETCH a different
 * Playwright than the one pinned in this checkout — which would install a browser
 * revision the tests do not want, i.e. the exact drift this preflight exists to
 * end. Running the pinned CLI with the already-running `node` binary pins both
 * halves. */
export function pinnedPlaywrightCli(cwd: string): string {
  return join(cwd, "node_modules", "playwright", "cli.js");
}

// diff-cov: process-boundary — the irreducible browser download. A unit test cannot execute a
// 180MB fetch; the argv it builds is asserted by pinnedPlaywrightCli's own tests, and every
// decision about WHETHER to call this lives in ensureBrowsers, which is fully covered.
function installPinnedChromium(cwd: string): void {
  execFileSync(process.execPath, [pinnedPlaywrightCli(cwd), "install", "chromium"], {
    cwd,
    stdio: "pipe",
    timeout: 600_000,
  });
}

/**
 * Where Playwright keeps its browser builds. `PLAYWRIGHT_BROWSERS_PATH` wins when
 * set to a real path (it is how CI images relocate the cache); the literal `"0"`
 * means "inside node_modules" and is NOT a directory, so it falls through to the
 * platform default exactly as Playwright's own resolution does.
 */
export function playwrightCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override !== undefined && override !== "" && override !== "0") return override;
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  return join(home, ".cache", "ms-playwright");
}

/**
 * The three genuinely different answers to "which test file(s) could this
 * name-filtered proof's raw name live in?" — kept distinct because two of them
 * used to collapse into the same empty array, and acting on that ambiguity is
 * how a reviewer ends up accusing a plan author of naming a test that does not
 * exist when the truth is only that WE COULD NOT LOOK.
 *   - `resolved`  — grep found ≥1 candidate file. Narrow the run to just those.
 *   - `absent`    — a readable, non-empty test corpus was searched (proven by the
 *                   control probe in {@link resolveNameFilteredCandidates}) and
 *                   the name is in no test file, and no interpolated title could
 *                   plausibly render to it either. Positive evidence of absence;
 *                   safe to conclude `no-match` WITHOUT spawning the runner.
 *   - `unresolvable` — the lookup itself could not be trusted (grep missing,
 *                   `test/` absent or empty, the checkout never materialised, or
 *                   a template-literal title makes a fixed-string search
 *                   inconclusive). NOT evidence of anything: falls back to the
 *                   unchanged full-glob invocation.
 */
export type NameFilterResolution =
  | { status: "resolved"; files: string[] }
  | { status: "absent" }
  | { status: "unresolvable"; reason: string };

/** ERE matching a test declaration whose title is a TEMPLATE LITERAL carrying at
 * least one interpolation — the shape a fixed-string search structurally cannot
 * find, because the title that ends up in the TAP stream never appears verbatim
 * in the source. */
const INTERPOLATED_TITLE_RE = "(test|it|describe)\\(`[^`]*\\$\\{";

/** Shortest static run of a template title we will treat as identifying. Short
 * fragments (`" "`, `"'s "`, `": "`) appear in almost any prose and would make
 * every absent test look ambiguous, which would disable the fast path entirely. */
const MIN_STATIC_CHUNK_LEN = 12;

/** The literal (non-interpolated) runs of a template-literal test title, as seen
 * on one line of source: everything between the line's first and last backtick,
 * split on `${…}` holes. These are the ONLY substrings of the rendered title a
 * `grep -F` could ever have matched, so they are what we compare a proof's raw
 * name against when deciding whether an interpolated title might be its home. */
export function interpolatedTitleStaticChunks(sourceLine: string): string[] {
  const first = sourceLine.indexOf("`");
  const last = sourceLine.lastIndexOf("`");
  if (first < 0 || last <= first) return [];
  return sourceLine
    .slice(first + 1, last)
    .split(/\$\{[^}]*\}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= MIN_STATIC_CHUNK_LEN);
}

/**
 * Could `rawName` be the RENDERED title of some test declared with an
 * interpolated template literal? {@link resolveNameFilteredCandidates}'s
 * `grep -F` cannot see such a title (the source holds `${…}`, the TAP stream
 * holds the substituted value), so a zero-candidate result over a repo that
 * declares them is not automatically evidence of absence.
 *
 * Answers "maybe" only on positive evidence: some interpolated declaration has a
 * static chunk of real length that the proof's name actually contains. A repo
 * with no interpolated titles at all answers a confident "no" — that is the
 * common case and it keeps the fast path live. Only called once the corpus probe
 * has already established that the search itself is trustworthy.
 */
function couldBeInterpolatedTitle(cwd: string, rawName: string): boolean {
  let stdout: string;
  try {
    stdout = execFileSync("grep", ["-rhE", "--include=*.test.ts", "--", INTERPOLATED_TITLE_RE, "test"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch {
    // Only reached AFTER the corpus probe in resolveNameFilteredCandidates has already
    // established that grep runs and the test tree is readable, so a throw here can only
    // be grep's "no lines matched" — this repo declares no interpolated titles. A real
    // answer ("no"), not a failed lookup.
    return false;
  }
  return stdout.split("\n").some((line) => interpolatedTitleStaticChunks(line).some((c) => rawName.includes(c)));
}

/** `grep -rl -F` over the checkout's test files, as a plain list — or `null` when
 * grep did not produce one (no match, no `test/` tree, grep missing, unreadable
 * files). Deliberately does NOT interpret the exit code: MEASURED on macOS
 * 2026-07-29, BSD grep exits 1 with EMPTY stderr both for "searched, found
 * nothing" AND for "the directory does not exist", so the exit code cannot carry
 * that distinction. {@link resolveNameFilteredCandidates} draws it with a control
 * probe instead. */
function grepFilesContaining(cwd: string, fixedPattern: string): string[] | null {
  try {
    const stdout = execFileSync("grep", ["-rl", "-F", "--include=*.test.ts", "--", fixedPattern, "test"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
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
 * Returns a {@link NameFilterResolution}, not a bare list, because "found
 * nothing" and "could not look" are different claims about the world and only
 * the first of them licenses the caller's fast path. The line between them is
 * drawn by a CONTROL PROBE, not by grep's exit code: an identical search for the
 * empty pattern, which matches every line of every file it can read. If that
 * probe comes back with at least one test file then grep runs, `test/` exists,
 * it is readable, and it is non-empty — so a zero-hit search of the same corpus
 * is a real observation. If the probe comes back empty or throws, we did not
 * look at anything and say so. (The exit code cannot do this job: MEASURED on
 * macOS 2026-07-29, BSD grep exits 1 with empty stderr for BOTH "searched, found
 * nothing" and "that directory does not exist" — an earlier revision of this
 * function trusted exit 2 for the latter and was falsified by its own test.)
 */
export function resolveNameFilteredCandidates(cwd: string, rawName: string): NameFilterResolution {
  const hits = grepFilesContaining(cwd, rawName);
  if (hits && hits.length > 0) return { status: "resolved", files: hits };
  // Zero hits. Everything below decides whether that is EVIDENCE or IGNORANCE.
  const corpus = grepFilesContaining(cwd, "");
  if (!corpus || corpus.length === 0)
    return { status: "unresolvable", reason: "no readable test corpus to search (grep, test/, or the checkout)" };
  // We could look, and did. Rule out the one thing a fixed-string search is
  // structurally blind to (TRAP 2): a title built from a template literal, which
  // never appears verbatim in the source that declares it.
  if (couldBeInterpolatedTitle(cwd, rawName))
    return { status: "unresolvable", reason: "an interpolated test title could render to this name" };
  return { status: "absent" };
}

/**
 * W1-T227's command builder: given a name-filtered proof's already-compiled
 * `baseArgs` (from {@link parseTestTarget}, trailing with {@link TEST_GLOB})
 * and the candidate file(s) {@link resolveNameFilteredCandidates} found, swap
 * the full glob for just those candidates. ZERO candidates returns `baseArgs`
 * verbatim, still globbed — reached ONLY for an `unresolvable` resolution,
 * where falling back to the unchanged (slow, possibly timing-out) full-glob run
 * is the honest thing to do because we have no evidence either way.
 *
 * Corrected 2026-07-29 (this file's own defect): the previous comment here
 * claimed zero candidates "CHANGES NOTHING" because "nameFilteredOutcome's
 * existing zero-match ⇒ 'fail' path fires identically either way (a wider
 * search finding nothing is exactly as conclusive as a narrower one)". BOTH
 * halves were false. Zero real matches on a COMPLETED run returns "no-match",
 * not "fail" (see {@link nameFilteredOutcome}), which the judge degrades to
 * `not_executable`. And the wider search does NOT finish: the full glob loads
 * every file including several that drive a real headless browser and hang
 * when the name filter matches none of their tests, so the run is killed at
 * the proof timeout and yields `exec_error` — no conclusion at all. That is
 * why {@link execWhitelistedProof} now decides `absent` BEFORE spawning
 * anything, and why only `unresolvable` still reaches this fallback.
 */
export function narrowNameFilteredArgs(baseArgs: readonly string[], candidateFiles: readonly string[]): string[] {
  if (candidateFiles.length === 0) return [...baseArgs];
  return [...baseArgs.filter((a) => a !== TEST_GLOB), ...candidateFiles];
}

/**
 * The REAL proof executor (production default): run a {@link WhitelistedProof}'s
 * argv, no shell, in `cwd`, with a HARD per-proof timeout — a hanging test must
 * never stall the required check into the absent-check deadlock class. Returns
 * `"pass"` on a clean exit 0; `"fail"` on a genuine clean nonzero exit — a
 * failing test, or a grep that LOOKED and found no match (exit 1): the proof
 * named something the PR head does not observably contain, which is the
 * criterion genuinely unmet, not an environment hiccup. THROWS when the
 * process never ran to a clean pass/fail exit at all — a timeout kill, a spawn
 * error like the command itself missing, so the caller surfaces `exec_error`
 * (a timeout must never be misjudged as an observed "fail") — AND (W1-T219,
 * recon R-13(iv)) when a `grep` proof exits 2: grep's own convention for
 * "could not look at all" (a since-renamed/missing target, a read error), as
 * opposed to exit 1's "looked and found nothing". Treating exit 2 as a genuine
 * FAIL false-blocked a criterion whose proof merely named a path that moved —
 * an environment/authoring problem, not evidence the criterion is unmet — so
 * it degrades to `exec_error` (the keyword floor) exactly like a thrown error.
 *
 * NAME-FILTERED PROOFS ARE THE ONE EXCEPTION to "the exit code is the verdict"
 * (W1-T178, round 2): a bare TEST NAME compiles to `--test-name-pattern` over
 * the WHOLE suite glob (`test/**\/*.test.ts`, {@link TEST_GLOB}), so the exit
 * code reflects EVERY file in that glob, not just the one named test a
 * criterion cares about. FIXTURE, hit live implementing this very task:
 * `test/serve.find.test.ts` runs its file-scope `after` (`browser.close()`)
 * even on a pattern that matched none of ITS tests, which turns the ENTIRE
 * glob's exit code nonzero.
 *
 * MECHANISM CORRECTED 2026-07-29, from live observation of that fixture. The
 * previous note here said "`before` is skipped, so `browser` is never
 * assigned". It is not skipped: `before` IS entered, `chromium.launch()` runs,
 * and a real `chrome-headless-shell` appears as a grandchild process. What
 * actually happens is a RACE — `after` fires at ~0.2ms, long before `launch()`
 * resolves, and throws on the still-undefined `browser`. Nothing ever closes
 * the browser that did launch, and its `--remote-debugging-pipe` holds the
 * event loop open, so the run does not merely exit nonzero: it HANGS until the
 * proof timeout kills it, leaking the browser. That is the cost this function's
 * fast path (below) exists to avoid, and it is why a zero-candidate name must
 * never be answered by running the glob "just to be sure".
 *
 * So for a name-filtered proof, the verdict is read from
 * {@link nameFilteredOutcome} parsing the TAP stream for the matched test's OWN
 * result line, never from the process exit code — on both the success path and
 * a thrown nonzero-exit's attached stdout.
 */
export function execWhitelistedProof(
  whitelisted: WhitelistedProof,
  cwd: string,
  timeoutMs = defaultProofTimeoutMs(),
  spawn: ProofSpawner = defaultProofSpawner,
): "pass" | "fail" | "no-match" {
  // W1-T227: a name-filtered proof's `args` (from parseTestTarget) still carry
  // the FULL suite glob — resolve the actual candidate file(s) now, against
  // the real PR-head checkout, and narrow to just those before ever spawning
  // node. Not folded into parseWhitelistedProof itself: that function is a
  // pure parse with no `cwd`, and the candidate set can only be known against
  // a real checkout.
  let args = whitelisted.args as readonly string[];
  if (whitelisted.nameFiltered) {
    const resolution = resolveNameFilteredCandidates(cwd, whitelisted.label);
    // FAIL FAST on positive evidence of absence: no test file contains this name
    // and no interpolated title could render to it, so the glob run's only possible
    // finding is zero matches — the same "no-match" this returns, except reached by
    // loading 168 files, hanging on the browser-driving ones until the timeout kills
    // them, leaking a chrome-headless-shell, and then reporting `exec_error` (no
    // conclusion at all) instead. `unresolvable` is NOT evidence and never lands
    // here: it falls through to the unchanged full-glob invocation below.
    if (resolution.status === "absent") return "no-match";
    args = narrowNameFilteredArgs(whitelisted.args, resolution.status === "resolved" ? resolution.files : []);
  }
  // AFTER the fast path on purpose: priming a checkout's node_modules is only
  // worth 120s of `npm ci` if we are actually going to run node. `ensureDeps` is
  // memoised per cwd, so a later proof in the same checkout still primes it.
  if (whitelisted.kind === "test") {
    ensureDeps(cwd);
    // Same "only when we are actually going to run node" placement as ensureDeps,
    // and for the same reason: a `grep` proof never launches a browser. See
    // requiredChromiumDirs for the false-FAIL incident this closes (PR #892).
    ensureBrowsersOnce(cwd);
  }
  try {
    const stdout = spawn(whitelisted.command, args, cwd, timeoutMs);
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
    // W1-T219 (recon R-13(iv)): grep exit 2 means it could not even LOOK (a
    // since-renamed/missing target, a permission/read error) — distinct from
    // exit 1's "looked, found nothing". Only the latter is genuine evidence of
    // absence; the former degrades to exec_error (the keyword floor) rather
    // than false-blocking on an environment/authoring problem.
    if (whitelisted.kind === "grep" && err.status === 2) throw err;
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
  /** (W1-T273) mirrors {@link ReviewEvidence.baseCheckoutDir} — the merge-base
   * checkout a `grep:` proof's pattern is re-run against to test for
   * non-discrimination. Absent ⇒ {@link preexistingProofHits} always reports
   * `false` and every grep proof that passes on `cwd` stays `executed_pass`. */
  baseCwd?: string;
}

/**
 * (W1-T273) Does a `grep:` proof's pattern ALSO match on the PR's MERGE-BASE —
 * i.e. would it have exited 0 before the task's own work ever landed? THE
 * LIVE DEFECT THIS CLOSES: W1-T267's fifth criterion carried
 * `grep: workerKeychainPaths in src/run-task.ts`; run against the commit
 * BEFORE #1026 implemented the task, that pattern already returned two hits
 * (an import line, an unrelated daemon rung) and exited 0 — the review
 * executed criterion 5 and recorded it `executed_pass` on completely unbuilt
 * work. A proof is supposed to discriminate between done and not-done; one
 * that ALSO matches the merge-base discriminates nothing, and `executed_pass`
 * POSITIVELY OVERRIDES the keyword floor, so a non-discriminating proof is
 * strictly worse than a prose one (it certifies with more confidence than the
 * floor it replaces, on strictly less evidence).
 *
 * ONLY `kind: "grep"` is checked — EXPLICITLY NOT `kind: "test"` (design,
 * load-bearing): a `unit test:` proof legitimately names a test file/name
 * that does not exist yet at the merge-base (that is the whole point of TDD —
 * the test is written FORWARD-referencing the work), so it is expected and
 * correct for such a proof to match nothing before the work and everything
 * after. Applying this rule there by analogy would flag every legitimate
 * forward-referencing test proof as "stale", which is exactly backwards.
 *
 * Returns `false` (never stale) whenever no `baseCwd` was supplied — this
 * check is purely additive and never runs, let alone downgrades anything, for
 * a caller that predates W1-T273's wiring — and whenever the base checkout
 * itself throws (an unreadable/absent merge-base checkout is an environment
 * gap, not a finding; degrades to "not stale" exactly like `exec_error`
 * degrades elsewhere in this module — never a silent hard-fail).
 */
/**
 * Materialise, into a throwaway directory, ONLY the base-revision blobs a review's `grep:` proofs
 * name — the cheap stand-in for a second checkout that {@link preexistingProofHits} needs.
 *
 * WHY NOT A SECOND WORKTREE (impl-GE). `preexistingProofHits` takes a directory and runs the SAME
 * `grep -arn -- <pattern> <path>` in it, so a full base checkout would work — but the reviewer
 * already pays for one `git worktree add` at the head, and a second doubles that plus the collision
 * surface its own comment warns about. Measured first: of 644 dialect proofs in the plan, **41 are
 * `grep:` and 599 are `unit test:`** — the guard applies to 6.4% of proofs, and only a `grep:` proof
 * can ever be judged stale (`preexistingProofHits` returns false for any other kind). Paying for a
 * whole checkout to serve 6.4% is the wrong trade; one `git show` per grep proof is not.
 *
 * A PATH ABSENT AT THE BASE IS SIMPLY NOT WRITTEN, which is the FORWARD-REFERENCE case and must not
 * be confused with staleness: a proof naming a file the branch creates correctly finds nothing here,
 * so `grep` reports no match and the proof is NOT flagged. "Did not exist before" and "already
 * matched before" are opposite conditions; only the second is the defect.
 *
 * Best-effort throughout: an unresolvable rev, an unreadable blob, or a write failure skips that one
 * path rather than throwing inside a review. A missing file degrades to "not stale", never to a
 * false positive.
 */
export function materialiseBaseProofBlobs(
  criteria: ReadonlyArray<{ proof?: string }>,
  baseRev: string,
  showBlob: (rev: string, repoRelPath: string) => string,
  writeBlob: (repoRelPath: string, contents: string) => void,
): number {
  let written = 0;
  const seen = new Set<string>();
  for (const c of criteria) {
    const parsed = c.proof ? parseWhitelistedProof(c.proof) : null;
    if (!parsed || parsed.kind !== "grep") continue;
    // The compiled argv is ["-arn", "--", <pattern>, <path>] — the path is the LAST element, taken
    // from the compiler rather than re-parsed from the proof text, so the two can never disagree.
    const repoRelPath = parsed.args[parsed.args.length - 1];
    if (!repoRelPath || seen.has(repoRelPath)) continue;
    seen.add(repoRelPath);
    try {
      writeBlob(repoRelPath, showBlob(baseRev, repoRelPath));
      written++;
    } catch {
      /* absent at base (forward reference) or unreadable — leave it out; grep then finds nothing */
    }
  }
  return written;
}

export function preexistingProofHits(
  whitelisted: WhitelistedProof,
  exec: ProofExecutor,
  baseCwd: string | undefined,
): boolean {
  if (whitelisted.kind !== "grep" || baseCwd === undefined) return false;
  try {
    return exec(whitelisted, baseCwd) === "pass";
  } catch {
    return false;
  }
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
      holdout: !!criterion.holdout,
    };
  }

  const kws = proofKeywords(criterion.proof);

  // Mechanical floor: is the proof responsively pasted into the report?
  let met: boolean;
  let reason: string;
  if (kws.length === 0) {
    // W1-T219 (recon R-13(ii)): was an UNCONDITIONAL met=true — a proof written
    // entirely in short/stopword/numeric tokens (no distinctive anchor at all)
    // auto-passed with no report engagement whatsoever, fail-OPEN and reachable
    // by any author (accidentally or not; PR #123 had none). This mechanical
    // floor cannot observe anything for such a proof, so — the same
    // cannot-observe-implies-do-not-act move this codebase already makes on the
    // read path (W1-T119's `indeterminate`) — it resolves to UNMET/INDETERMINATE,
    // never a free pass. Per the module's own law ("a semantic verdict may only
    // downgrade, never rescue an unpasted proof"), `semantic` cannot rescue this
    // either: real, WHITELISTED execution below (a `grep:`/`unit test:` dialect
    // match) is the only thing that can still flip this to executed_pass —
    // OBSERVED repo-state evidence, never vibes.
    met = false;
    reason =
      "proof unmet: INDETERMINATE — no mechanical anchors in proof text to check the report " +
      "against (a claim with nothing distinctive to verify is not evidence; requires an executable proof)";
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
  // W1-DH: WHY a criterion did not execute. `proof_exec: "not_executable"` alone conflates a proof
  // that never PARSED with one that parsed and named nothing — and a CAPPED 0/N verdict looked
  // identical either way, which is what made the code-span defect above cost a whole recon to find.
  let proofSkip: ProofSkipReason | undefined = execCtx ? "no-dialect" : "no-exec-context";
  if (execCtx) {
    const whitelisted = parseWhitelistedProof(criterion.proof);
    if (whitelisted) {
      proofSkip = undefined;
      const exec = execCtx.exec ?? execWhitelistedProof;
      try {
        const outcome = exec(whitelisted, execCtx.cwd);
        if (outcome === "pass") {
          if (preexistingProofHits(whitelisted, exec, execCtx.baseCwd)) {
            // W1-T273: the SAME pattern also matches the PR's MERGE-BASE — it
            // would have exited 0 before this task's work ever landed, so
            // its exit-0 here discriminates nothing. See
            // {@link preexistingProofHits}'s doc for the full design; `met`/
            // `reason` are LEFT UNTOUCHED (the keyword floor computed above
            // stands, verbatim) — the proof's positive override is withdrawn,
            // never converted into a failure.
            proofExec = "executed_stale";
            reason =
              `${reason} — NOTE: proof also matches the PR's merge-base ` +
              `(${whitelisted.kind}: ${whitelisted.label}); non-discriminating, ` +
              `positive override withdrawn, keyword floor applied`;
          } else {
            proofExec = "executed_pass";
            met = true;
            reason = `proof executed and PASSED on the PR head (${whitelisted.kind}: ${whitelisted.label})`;
          }
        } else if (outcome === "no-match") {
          // ZERO tests matched the proof's name pattern (the run completed — see
          // nameFilteredOutcome). W1-T161/#349: this is EITHER a proof-authoring
          // mismatch (the house convention writes a `unit test:` proof as PROSE
          // describing a test's behavior, not its literal name — see
          // looksLikeProseDescription's doc comment for the #349 fixture) OR
          // genuine test theater (a proof naming a specific, fabricated test).
          // The two are told apart by a deterministic shape check over the body,
          // never by re-running anything or calling a model.
          if (looksLikeProseDescription(whitelisted.label)) {
            // A prose paraphrase, not a bare name: NOT a failing test. Degrade to
            // `not_executable` (the keyword floor stands as computed above —
            // `met`/`reason` from mechanical coverage), and ANNOTATE why, so an
            // author sees "names no matching test" rather than a misleading
            // "executed and FAILED" — a false block on green, test-passing code.
            proofExec = "not_executable";
            proofSkip = "prose-no-match";
            reason = `${reason} — NOTE: proof names no matching test (0 tests matched '${whitelisted.label}'); not executed, keyword floor applied`;
          } else {
            // W1-T72's test-theater guard, PRESERVED: the body reads as a bare,
            // concrete test NAME (short, no sentence punctuation) rather than a
            // prose description, and it matches nothing on the PR head — a
            // fabricated test name is theater and must FAIL, never silently
            // degrade to the keyword floor.
            proofExec = "executed_fail";
            met = false;
            reason = `proof names a specific test that does not exist on the PR head (0 tests matched '${whitelisted.label}') — test theater, not executed`;
          }
        } else {
          proofExec = "executed_fail";
          met = false;
          reason = `proof executed and FAILED on the PR head (${whitelisted.kind}: ${whitelisted.label}) — overrides any keyword coverage`;
        }
      } catch {
        proofExec = "exec_error"; // met/reason stay EXACTLY the keyword-floor verdict above
        proofSkip = "exec-error";
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

  return { ...base, met, reason, proof_exec: proofExec, proof_skip: proofSkip, floorMet, holdout: !!criterion.holdout };
}

/** The slice of {@link Task} the merged-claim audit needs — just enough to name a
 *  finding without importing all of `plan.js`'s Task surface. Any object with these
 *  two fields (a real {@link Task}, or a test fixture) satisfies it. */
export interface AuditableMergedTask {
  id: string;
  acceptance?: ReadonlyArray<AcceptanceCriterion>;
}

/** One acceptance criterion of a MERGED task whose proof is in an executable
 *  dialect (`grep:` / `unit test:` / a legacy bare test path or fenced grep) but did
 *  NOT resolve to a runnable check, or resolved and did not pass — merge credit was
 *  given per TASK, so this is the gap {@link judgeReview} itself cannot see once the
 *  task is already merged and off its desk. */
export interface MergedClaimFinding {
  taskId: string;
  claim: string;
  proof: string;
  proofExec: ProofExecOutcome;
  /** Plain-language cause, independent of {@link CriterionVerdict.reason}'s keyword-floor
   *  phrasing — there is no PR report to score keyword coverage against here, only the
   *  proof's own execution outcome. */
  reason: string;
}

/** One acceptance criterion of a merged task whose proof carries NO whitelisted
 *  dialect at all (W1-T64's own two criteria are exactly this shape) — prose, and
 *  therefore structurally unauditable by this or any mechanical check. Reported in
 *  its OWN bucket so its size is legible; NEVER folded into {@link MergedClaimFinding}
 *  (that would misreport "unauditable" as "broken") and NEVER treated as passing
 *  (that would misreport "unauditable" as "verified") — design (4).
 */
export interface MergedClaimUncheckable {
  taskId: string;
  claim: string;
  proof: string;
}

/** The full report {@link auditMergedTaskClaims} returns — REPORT ONLY, per design (2):
 *  nothing here closes, reopens, or re-scores a task; it just makes the gap visible. */
export interface MergedClaimAuditReport {
  findings: MergedClaimFinding[];
  uncheckable: MergedClaimUncheckable[];
  tasksAudited: number;
  /** Criteria whose proof DID parse to a whitelisted dialect and were actually run —
   *  i.e. `findings.length` plus every executable criterion that passed cleanly. */
  executableClaimsChecked: number;
}

/** Plain-language cause for a {@link MergedClaimFinding}, read off the SAME
 *  {@link ProofExecOutcome}/{@link ProofSkipReason} pair {@link judgeCriterion} already
 *  computed — never a second, independently-worded classification that could disagree
 *  with the executor's own verdict.
 *
 *  NOTE on `"executed_stale"`: {@link auditMergedTaskClaims} calls {@link judgeCriterion}
 *  with an `execCtx` that never carries a `baseCwd` (there is no single, well-defined
 *  "PR base" for an already-merged task audited standalone against the current
 *  checkout — {@link preexistingProofHits}'s own doc says it always returns `false`,
 *  never stale, when `baseCwd` is absent). That makes `"executed_stale"` structurally
 *  unreachable through THIS caller, so it is intentionally folded into the same
 *  generic `default` wording below rather than carrying a dedicated, untestable case. */
function describeUnresolvedOrFailing(proofExec: ProofExecOutcome, proofSkip: ProofSkipReason | undefined): string {
  switch (proofExec) {
    case "executed_fail":
      return "proof executed and FAILED against the current checkout";
    case "exec_error":
      return "proof named a whitelisted check that failed to execute (timeout, spawn error, or missing target)";
    default:
      return proofSkip === "prose-no-match"
        ? "proof names a unit test that matches nothing on the current checkout (0 matches)"
        : "proof did not resolve to a passing, runnable check";
  }
}

/**
 * W1-T302: a CLAIM-LEVEL audit over MERGED tasks. Merge credit is derived per TASK
 * (deriveStatus/{@link projectPlan}), never per CRITERION, so a multi-claim task whose
 * PR satisfied only SOME of its acceptance criteria reads identically to one that
 * satisfied all of them — the gap W1-T64 fell into (its mount-budget claim shipped;
 * its `commitsAhead` guard claim's own status is invisible to every existing check
 * because that claim's proof is prose, not because anyone verified it either way).
 *
 * REUSES the reviewer's OWN parser+executor ({@link parseWhitelistedProof} via
 * {@link judgeCriterion}, the exact machinery `rmd check-proof` and the live gate both
 * run) rather than re-implementing a second matcher that could disagree with it
 * (design (1)). Called with an EMPTY report-token set and no semantic verdict: there
 * is no PR report to score keyword coverage against once a task is already merged —
 * only `verdict.proof_exec`/`proof_skip`, which `judgeCriterion` computes purely from
 * executing the proof, are read here; `verdict.met`/`reason` (keyword-floor artifacts
 * of a report that does not exist in this context) are deliberately ignored.
 *
 * An ARCHITECT-set `satisfied_by` criterion is skipped outright — it is already,
 * deliberately, credited to an earlier merge, never a hole this audit should surface.
 *
 * REPORT ONLY (design (2)): callers use this list to FILE follow-up tasks, never to
 * mechanically close or reopen the merged task itself — an unresolved proof is
 * frequently a stale proof, not missing work, and only a human can tell those apart.
 */
export function auditMergedTaskClaims(
  tasks: ReadonlyArray<AuditableMergedTask>,
  cwd: string,
  exec?: ProofExecutor,
): MergedClaimAuditReport {
  const findings: MergedClaimFinding[] = [];
  const uncheckable: MergedClaimUncheckable[] = [];
  let executableClaimsChecked = 0;
  const noReportTokens = new Set<string>();

  for (const task of tasks) {
    for (const criterion of task.acceptance ?? []) {
      if (criterion.satisfied_by) continue; // already credited to an earlier merge — not a hole.
      const verdict = judgeCriterion(criterion, noReportTokens, undefined, { cwd, exec });
      if (verdict.proof_skip === "no-dialect") {
        uncheckable.push({ taskId: task.id, claim: criterion.claim, proof: criterion.proof });
        continue;
      }
      executableClaimsChecked++;
      if (verdict.proof_exec !== "executed_pass") {
        findings.push({
          taskId: task.id,
          claim: criterion.claim,
          proof: criterion.proof,
          proofExec: verdict.proof_exec,
          reason: describeUnresolvedOrFailing(verdict.proof_exec, verdict.proof_skip),
        });
      }
    }
  }

  return { findings, uncheckable, tasksAudited: tasks.length, executableClaimsChecked };
}

/**
 * A body's own claim about its changeset that {@link bodyContradictsDiff}
 * proved false against the diff it actually shipped.
 */
export interface ChangesetClaimContradiction {
  /** The exact phrase from the report/body asserting the (false) claim. */
  claim: string;
  /** The diff's actual changed files that refute the claim. */
  files: string[];
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Parse "one" / "3" / "ten" into a number; undefined for anything else. */
function parseClaimedCount(word: string): number | undefined {
  const lower = word.toLowerCase();
  if (lower in WORD_NUMBERS) return WORD_NUMBERS[lower];
  return /^\d+$/.test(word) ? Number(word) : undefined;
}

/**
 * A path-SHAPED token: contains a `/` (directory) or a `.` (file extension) —
 * never a bare English word. This is the guard that keeps `bodyContradictsDiff`
 * silent on "no bugs"/"no issues"/"no regressions" (nothing to check a diff
 * against) while still catching "no src/"/"no docs/ORIENTATION.md".
 */
function looksLikePath(token: string): boolean {
  return /[./]/.test(token);
}

/** Words that mark a sentence as being ABOUT THE CHANGESET rather than about anything else a body
 *  might count files for. Kept as DATA so widening it is a one-line review, not a regex rewrite. */
const CHANGESET_CONTEXT_RE =
  /\b(?:diff|diffs|changed|changes|change|changeset|touch|touches|touched|modif\w*|edits?|edited|adds?|added|deletes?|deleted|removes?|removed|numstat|--stat|git\s+show|this\s+pr|the\s+pr)\b/i;

/**
 * Is the "exactly N files" match at `index` in a sentence ABOUT THE CHANGESET?
 *
 * Looks BACKWARD only, and only to the start of the current sentence — a changeset word in the
 * NEXT sentence says nothing about this claim, and scanning the whole body would re-create the
 * unanchored match this exists to prevent (every PR body says "changed" somewhere).
 */
export function claimsChangesetContext(report: string, index: number): boolean {
  const before = report.slice(0, index);
  // Sentence start: the last terminator, newline, or list-bullet before the claim.
  const start = Math.max(
    before.lastIndexOf(". "),
    before.lastIndexOf("\n"),
    before.lastIndexOf("! "),
    before.lastIndexOf("? "),
  );
  return CHANGESET_CONTEXT_RE.test(before.slice(start + 1));
}

/**
 * Is a `no <token>` claim ABOUT THE CHANGESET? `rest` is the report text immediately AFTER the
 * matched `no <token>`.
 *
 * WHY THIS IS NOT {@link claimsChangesetContext}. The obvious fix — reuse the helper #1077 built —
 * is wrong here, and measurably so. That helper looks BACKWARD, because a count claim carries its
 * context before it ("This PR changes exactly one file"). A `no <token>` claim carries it AFTER.
 * Measured against the real bodies:
 *
 *   #974  "Plan-only, no code touched | `git show --stat` lists three files"   backward ⇒ SILENT ✗
 *   #1025 `the body's own "data-only: no code" claim false`                     backward ⇒ SILENT ✗
 *   FP    "This change introduces no code duplication anywhere."                backward ⇒ FIRE   ✗
 *
 * Backward-looking would have broken BOTH preservation cases and still fired on the false positive,
 * because "This change introduces …" contains a changeset word while "Data-only: …" does not. The
 * direction is the whole point.
 *
 * THE RULE, in one sentence: a `no <token>` claim counts only when the TOKEN ENDS THE CLAIM — what
 * immediately follows is punctuation, end of line, or a changeset word — because an ordinary word
 * following the token makes the token a MODIFIER of that word ("no code DUPLICATION", "no src/
 * DIRECTORY convention") rather than the thing claimed absent.
 *
 * IT IS A HEURISTIC ABOUT ENGLISH COMPOUND NOUNS, and stating that plainly matters. "no code
 * changes" and "no code duplication" are grammatically identical; only the head noun differs, so
 * the classifier is the head-noun test and nothing deeper. It fails toward SILENCE — "no code was
 * changed" reads as a modifier and stays silent, a missed contradiction — which is the direction
 * this function's own doc demands: "ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A VERDICT … A
 * checker that guesses at natural language would be a worse tripwire than the gap it closes."
 * A missed contradiction costs one bad PR body; a false positive strands a correct PR indefinitely,
 * because a PR that files no task logs `sweep.fix.no_task` every tick and nothing ever retries it.
 *
 * Scoped to the SAME LINE (`[ \t]*`, never `\s*`): a word on the next line belongs to another
 * sentence and says nothing about this claim — the same reasoning that keeps
 * {@link claimsChangesetContext} inside its own sentence.
 */
export function noClaimIsAboutChangeset(rest: string): boolean {
  const next = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)/.exec(rest);
  if (!next) return true; // punctuation, end of line, or end of input — the token IS the claim
  return CHANGESET_CONTEXT_RE.test(next[1]);
}

/** Does `file` fall under the claimed-absent `path` (an exact file, or a directory prefix)? */
function fileUnderClaimedPath(file: string, path: string): boolean {
  const normalized = path.replace(/\/$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

/**
 * THE NARROW, FALSIFIABLE CHECK (W1-T274). Two PRs merged THIS WEEK on bodies
 * that contradicted their own diffs — #974 claimed "exactly one file:
 * MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md" over a 3-file
 * diff that DID touch docs/ORIENTATION.md (load-bearing: that file sits
 * outside {@link isInPlanScope} and cost the PR its planOnly carve-out);
 * #1025 claimed "data-only: no code" while reverting 6 src/ + 2 test/ files.
 * Both landed because `judgeReview` already held the parsed changeset
 * (`diffFiles`) and the body (`evidence.report`) in the same function and
 * compared neither against the other. This closes exactly that gap:
 *
 *   (a) a stated FILE COUNT ("exactly N files") that disagrees with
 *       `diffFiles.length`;
 *   (b) a claim that a path/directory is absent ("no src/", "no test/", a
 *       named file, "plan-only", "data-only") when `diffFiles` contains a
 *       member of it;
 *   (c) a file NAMED in an "exactly N files: a, b" enumeration that
 *       `diffFiles` does not actually contain.
 *
 * DELIBERATELY NOT general claim-verification: whether the diff is CORRECT,
 * or whether a claim about BEHAVIOUR (as opposed to the changeset itself)
 * holds, is out of scope. ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A
 * VERDICT — prose these patterns do not recognise returns `[]`, the exact
 * same shape as a body making no changeset claim at all. A checker that
 * guesses at natural language would be a worse tripwire than the gap it
 * closes.
 */
export function bodyContradictsDiff(report: string, diffFiles: string[]): ChangesetClaimContradiction[] {
  const out: ChangesetClaimContradiction[] = [];

  // (a) / (c): "exactly N files[: a, b, c]" — the count itself, and (when a
  // count is right but a named file is missing) the enumerated list.
  //
  // THE COUNT CLAIM MUST BE ABOUT THE CHANGESET (fixed after PR #1077). The bare pattern has no
  // SUBJECT: "exactly one file" reads identically whether the sentence is about the diff or about
  // something else entirely. LIVE FIXTURE — PR #1077 wrote "Each unit-test proof resolves to
  // exactly one file and matches exactly 1 test", a statement about PROOF CANDIDATE RESOLUTION,
  // and was posted `failure` over a 7-file diff. Its verdict recorded `proof_exec` 5/5
  // `executed_pass`, `unmet_criteria: []`, `test_theater: false`, `capped: false` — every
  // criterion substantiated, the PR blocked anyway, and no rung retried it.
  //
  // That is precisely the failure this function's own doc comment forbids: "ANYTHING THIS CANNOT
  // DECIDE IS SILENCE, NOT A VERDICT … A checker that guesses at natural language would be a
  // worse tripwire than the gap it closes." An unanchored count IS a guess at natural language.
  //
  // So a count claim now counts only when it is TIED TO THE CHANGESET, by either:
  //   (i)  an enumeration — "exactly one file: MASTER-PLAN.md" — which is unambiguous and is the
  //        shape #974 actually used (the PR this check was built for; still caught), or
  //   (ii) a changeset word in the run-up to the phrase ("changed", "touches", "diff", "modifies",
  //        "git show --stat listed …"), which is how a body states the claim in prose.
  // Anything else is silence, exactly as an unrecognised sentence already was.
  const countRe = /\bexactly\s+(\w+)\s+files?\b(?:\s*:\s*([^\s,]+(?:\s*,\s*[^\s,]+)*))?/gi;
  for (const m of report.matchAll(countRe)) {
    const claimed = parseClaimedCount(m[1]);
    if (claimed === undefined) continue;
    if (!m[2] && !claimsChangesetContext(report, m.index ?? 0)) continue;
    let contradicted = claimed !== diffFiles.length;
    if (!contradicted && m[2]) {
      // MARKDOWN QUOTING IS STRIPPED BEFORE THE COMPARISON. A body writes a path the way this
      // repo's own house style writes one — in backticks — so the enumeration items arrive as
      // "`src/lib/serve.ts`" while `diffFiles` holds bare paths. `includes` then fails on every
      // correctly-enumerated file and the PR is failed for a claim that is TRUE.
      //
      // LIVE FIXTURE (PR #1192, W1-T288): body said "This PR touches exactly 3 files:
      // `src/lib/panel-actions.ts`, `src/lib/serve.ts`, `test/control-status-daemon-liveness.test.ts`."
      // over a diff of exactly those three. Reported 1 contradiction; with backticks stripped
      // from the same body and the same diff, 0. Nothing else about the claim was wrong.
      //
      // WRAPPING PUNCTUATION COMES OFF FROM BOTH ENDS, AS A CLASS — not backticks then a full
      // stop. #1194 shipped exactly that narrower pair and it was incomplete: it handled
      // "…test.ts`." and NOT "…test.ts`)".
      //
      // SECOND LIVE FIXTURE (PR #1209, W1-T304): the enumeration was parenthesised, so the final
      // item arrived as "`test/review-failure-reason-ledgered.test.ts`)". The old cleanup stripped
      // `[.\s]+$` (no match — the last character is a paren), then backticks anchored at the ends
      // (no match — the last character is still a paren), leaving the item unchanged and the PR
      // failed for a claim that was TRUE. Reproduced against the installed build before this edit.
      //
      // A single character class from each end handles quoting and punctuation in either order,
      // which is what makes it robust to the next wrapper rather than to the two seen so far.
      // `looksLikePath` still requires a `.` or `/`, so an over-strip cannot invent a match.
      const named = m[2]
        .split(",")
        .map((s) =>
          s
            .trim()
            .replace(/^[`'"([\]]+/, "")
            .replace(/[`'")\].,;:\s]+$/, ""),
        )
        .filter(looksLikePath);
      contradicted = named.some((f) => !diffFiles.includes(f));
    }
    if (contradicted) out.push({ claim: m[0].trim(), files: [...diffFiles] });
  }

  // (b): "no <path>" claims, plus the "plan-only"/"data-only" house shorthands.
  const noPathRe = /\bno\s+([A-Za-z0-9_./-]+)/gi;
  for (const m of report.matchAll(noPathRe)) {
    const token = m[1].replace(/[,.\s]+$/, "");
    // ANCHOR (the sibling of #1077's, in the other direction — see noClaimIsAboutChangeset).
    // Predicate (b) was never anchored, and fired six times today on prose whose subject was not
    // the changeset: "This change introduces no code duplication anywhere" produced `claim: "no
    // code"` against any source-touching diff, in a repo that runs a jscpd duplication gate.
    if (!noClaimIsAboutChangeset(report.slice((m.index ?? 0) + m[0].length))) continue;
    let violators: string[];
    if (token.toLowerCase() === "code") {
      violators = diffFiles.filter((f) => f.startsWith("src/") || isTestPath(f));
    } else if (looksLikePath(token)) {
      violators = diffFiles.filter((f) => fileUnderClaimedPath(f, token));
    } else {
      continue; // "no bugs", "no issues" — not a changeset claim; stay silent
    }
    if (violators.length > 0) out.push({ claim: m[0].trim(), files: violators });
  }
  if (/\bplan-only\b/i.test(report)) {
    const violators = diffFiles.filter((f) => !isInPlanScope(f));
    if (violators.length > 0) out.push({ claim: "plan-only", files: violators });
  }
  if (/\bdata-only\b/i.test(report)) {
    const violators = diffFiles.filter((f) => f.startsWith("src/") || isTestPath(f));
    if (violators.length > 0) out.push({ claim: "data-only", files: violators });
  }

  return out;
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
    ? { cwd: evidence.headCheckoutDir, exec: evidence.execProof, baseCwd: evidence.baseCheckoutDir }
    : undefined;
  const verdicts = criteria.map((c, i) =>
    judgeCriterion(c, reportTokens, evidence.semantic?.[i], execCtx),
  );
  const testTheater = detectTestTheater(evidence.diff);

  // W1-T205's own planOnly, computed EARLY (moved up from below) so the W1-T58
  // guard right below it can consult it before `state` is rolled up.
  const diffFiles = changedFiles(walkDiff(evidence.diff));
  const planOnly = diffFiles.length > 0 && diffFiles.every(isInPlanScope);

  // W1-T58 (Standing rule 15 — RATIFIES P3): see {@link ReviewVerdict.criteriaTampered}'s
  // doc for the full design. `!planOnly` is the exemption — a genuine Architect
  // plan-only correction is never this function's business to fail.
  const criteriaTampered = !planOnly && criterionFieldTampered(evidence.diff);

  // W1-T274: see {@link ReviewVerdict.changesetContradictions}'s doc. A pure
  // comparison of two values already computed above (`evidence.report`,
  // `diffFiles`) — no new fetch, no new gateway.
  const changesetContradictions = bodyContradictsDiff(evidence.report, diffFiles);

  // W1-T297 (Standing rule 25): see {@link ReviewVerdict.instrumentEntangled}'s
  // doc. Reuses the SAME `diffFiles` every other structural check above
  // already computed — no new diff walk.
  const instrumentEntanglement = detectInstrumentEntanglement(diffFiles);
  const instrumentEntangled = instrumentEntanglement.entangled;

  const unmet = verdicts.filter((v) => !v.met);
  const noCriteria = criteria.length === 0;
  const state: ReviewState =
    noCriteria ||
    unmet.length > 0 ||
    testTheater ||
    criteriaTampered ||
    changesetContradictions.length > 0 ||
    instrumentEntangled
      ? "failure"
      : "success";

  // W1-T166: the reward-hacking measurement, over ALL criteria — visible AND
  // holdout fold into `state` identically above; this is a SEPARATE per-run
  // MEASUREMENT of the gap between them, never a gate. `null` when either side
  // has nothing to measure (no holdout criteria declared, or no visible ones).
  const visibleVerdicts = visibleCriteria(verdicts);
  const holdoutVerdicts = verdicts.filter((v) => v.holdout);
  const visiblePassRate = visibleVerdicts.length > 0 ? visibleVerdicts.filter((v) => v.met).length / visibleVerdicts.length : null;
  const holdoutPassRate = holdoutVerdicts.length > 0 ? holdoutVerdicts.filter((v) => v.met).length / holdoutVerdicts.length : null;
  const rewardHackingGap = visiblePassRate !== null && holdoutPassRate !== null ? visiblePassRate - holdoutPassRate : null;

  // W1-T178 (verdict stability): the SAME rollup, but ignoring semantic entirely
  // — every criterion judged on its `floorMet` (mechanical/executed, pre-
  // downgrade). `testTheater`/`noCriteria`/`criteriaTampered`/
  // `changesetContradictions` are all structural (diff-derived), never
  // semantic, so they bind the floor exactly as they bind `state` — a
  // criteriaTampered or changeset-contradiction failure can never be
  // suppressed by verdict stability (W1-T178), which only ever forgives a
  // SEMANTIC downgrade. This is the anchor a re-review of an unchanged head
  // checks before trusting a downgrade.
  const floorUnmet = verdicts.filter((v) => !(v.floorMet ?? v.met));
  const floorState: ReviewState =
    noCriteria ||
    floorUnmet.length > 0 ||
    testTheater ||
    criteriaTampered ||
    changesetContradictions.length > 0 ||
    instrumentEntangled
      ? "failure"
      : "success";

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

  // W1-T205: PLAN-ONLY CLASSIFICATION (`diffFiles`/`planOnly` — computed above,
  // ahead of `state`, so the W1-T58 guard could consult it). Reuses the review
  // path's OWN existing diff-walker (`changedFiles(walkDiff(...))` — the same
  // one {@link checkOneConcern} already uses to name a diff's changed files)
  // plus plan-architect's own plan-scope predicate ({@link isInPlanScope} — the
  // SAME guard `rmd plan`'s PROPOSED-outcome check and the W1-T136 filing-PR
  // emitter use) rather than inventing a third, divergent notion of "plan-only".
  // FAILS CLOSED: an empty diff, or one touching even a single file outside
  // `plan/**`/`MASTER-PLAN.md`, is NOT plan-only — see {@link
  // ReviewVerdict.planOnly}'s doc for why that direction is load-bearing.

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
      : failSummary(
          // W1-T166: only VISIBLE unmet claims name themselves in the posted
          // summary — a holdout claim never reaches this text (see failSummary's
          // own doc for why: it becomes the commit-status description AND the
          // ledger's failure text, both worker-`gh`-readable).
          visibleCriteria(unmet).map((v) => v.claim),
          testTheater,
          noCriteria,
          criteriaTampered,
          unmet.length - visibleCriteria(unmet).length,
          changesetContradictions,
          instrumentEntangled ? instrumentEntanglement : undefined,
        );

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
    criteriaTampered,
    changesetContradictions,
    instrumentEntangled,
    instrumentEntanglementPaths: instrumentEntangled
      ? { instrumentPaths: instrumentEntanglement.instrumentPaths, srcPaths: instrumentEntanglement.srcPaths }
      : undefined,
    rewardHackingGap,
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
 *
 * W1-T219 (recon R-14): `headSha` BINDS the override to the PR head it was
 * granted against. Before this field existed, the override was an
 * unauthenticated free string — `cappedOverrideFromLedger` matched on
 * `task_id` alone, "last one wins" over an append-only, unlocked ledger — so
 * one appended line armed auto-merge on a CAPPED verdict for ANY later head of
 * that task, including a different diff the operator never saw when they
 * granted it. `cappedOverrideFromLedger` now refuses to return an override
 * whose `headSha` does not match the verdict currently being judged, so a
 * stale or forged append cannot outlive the diff it was judged on. Optional on
 * this TYPE only so a caller that already holds a hand-attributed override
 * (e.g. {@link decideAutoMergeArm}'s own unit fixtures, which test the arming
 * decision in isolation from ledger recovery) needn't fabricate one — the
 * binding is actually ENFORCED at recovery time, in
 * {@link cappedOverrideFromLedger} itself.
 */
export interface CappedOverride {
  by: string;
  reason: string;
  headSha?: string;
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
 *
 * W1-T219 (recon R-14): HEAD-BOUND, mirroring {@link decideArmFromLedgerVerdict}'s
 * W1-T230 head-pinning above. `headSha` — the CURRENT verdict's head, supplied
 * by the caller — is now REQUIRED to match the granted line's own `head_sha`
 * exactly, or the line is skipped as if it were never there. Before this, the
 * override was scoped to `taskId` alone: on an append-only, unauthenticated
 * ledger, ANYTHING able to append one `automerge.capped_override_granted` line
 * armed auto-merge on a CAPPED verdict for every later head of that task —
 * including a push the operator granting the override never saw. A line
 * missing `head_sha` (a pre-W1-T219 grant) is likewise never matched: a
 * binding that cannot be verified is treated as absent, never as a pass.
 */
export function cappedOverrideFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  headSha: string,
): CappedOverride | undefined {
  let found: CappedOverride | undefined;
  for (const line of lines) {
    if (line.step !== "automerge.capped_override_granted" || line.task_id !== taskId) continue;
    if (typeof line.by !== "string" || typeof line.reason !== "string") continue;
    if (typeof line.head_sha !== "string" || line.head_sha !== headSha) continue;
    found = { by: line.by, reason: line.reason, headSha: line.head_sha };
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
 * W1-T304: the stable, COUNTABLE key naming WHICH structural path forced a
 * `state: "failure"` verdict. Before this, `review.posted` carried `state:
 * "failure"` with `reasons: []` whenever the failing path was NOT an unmet
 * named criterion (`bodyContradictsDiff`'s changeset-contradiction path, the
 * measured PR #1193 case: every criterion substantiated, every proof
 * executed and passed, yet the review still failed) — the reason existed
 * only inside the posted commit-status description (a 140-char field that
 * truncates it), so `grep -a` over the ledger for that failure class returns
 * ZERO and the predicate can never be counted, audited, or tuned.
 *
 * Mirrors {@link failSummary}'s own precedence exactly (both read the SAME
 * structural facts off the SAME verdict) so the class named here always
 * matches the prose {@link failSummary} would have rendered for this verdict
 * — never a second, divergent notion of "why this failed":
 *   - `no_criteria`            — {@link ReviewVerdict.criteria} is empty.
 *   - `criteria_tampered`      — {@link ReviewVerdict.criteriaTampered}.
 *   - `changeset_contradiction`— {@link ReviewVerdict.changesetContradictions}
 *                                 non-empty (the bodyContradictsDiff path).
 *   - `instrument_entangled`   — {@link ReviewVerdict.instrumentEntangled}.
 *   - `holdout_unmet`          — every VISIBLE criterion passed, but a
 *                                 reviewer-only holdout criterion did not.
 *   - `test_theater`           — every criterion passed, but added tests
 *                                 assert nothing.
 *   - `unmet_criteria`         — at least one visible named criterion failed
 *                                 (the ordinary case; already fully named via
 *                                 the ledger's own `unmet_criteria`/`reasons`
 *                                 arrays — this class exists so THAT path is
 *                                 counted by the same key space as every
 *                                 other one, not because it was gapped).
 * Returns `undefined` on a passing verdict — there is no failure to class.
 */
export function reviewFailureClass(
  verdict: Pick<ReviewVerdict, "criteriaTampered" | "changesetContradictions" | "instrumentEntangled"> & {
    criteria: ReadonlyArray<Pick<CriterionVerdict, "met" | "holdout">>;
  },
): "no_criteria" | "criteria_tampered" | "changeset_contradiction" | "instrument_entangled" | "holdout_unmet" | "test_theater" | "unmet_criteria" {
  if (verdict.criteria.length === 0) return "no_criteria";
  if (verdict.criteriaTampered) return "criteria_tampered";
  if ((verdict.changesetContradictions?.length ?? 0) > 0) return "changeset_contradiction";
  if (verdict.instrumentEntangled) return "instrument_entangled";
  const unmet = verdict.criteria.filter((c) => !c.met);
  const visibleUnmet = visibleCriteria(unmet);
  if (visibleUnmet.length > 0) return "unmet_criteria";
  // Neither structural fact above fired and no VISIBLE criterion is unmet, yet
  // `judgeReview` still folded this verdict to failure — the only two triggers
  // left in its OR-chain are a holdout-only miss or test theater.
  if (unmet.length > visibleUnmet.length) return "holdout_unmet";
  return "test_theater";
}

/**
 * The `capped`/`keywordOnly`/`planOnly` facts the `review.posted` ledger line
 * records (W1-T185, criterion 5: "when materialization is impossible the verdict
 * is EXPLICITLY marked keyword-only, in both the posted status and the ledger —
 * silent keyword-only posting is unreachable"). Pure + exported so run-task.ts's
 * `log("review.posted", …)` call and a unit test both read the SAME fields
 * off the SAME verdict, rather than the ledger line risking a hand-copied
 * projection that could silently drift from what {@link cappedSummary}/
 * {@link planOnlySummary}/{@link passSummary} actually rendered on the posted
 * status.
 *
 * `plan_only` joined the line so the LEDGER carries every input
 * {@link decideAutoMergeArm} needs — `capped` alone cannot distinguish the
 * structural, permanently-capped plan-only shape (which ARMS, W1-T205) from a
 * proof-failure capped verdict (which does not, W1-T229). {@link
 * postedArmFactsFromLedger} is the reader; `sweep.ts`'s reconciliation is why it
 * has to be on the ledger at all — that path never holds the verdict object,
 * only what was written down about it.
 *
 * W1-T304: `failure_class`/`failure_reason` ride alongside on any `state:
 * "failure"` verdict — the SAME `reviewFailureClass` key plus the verdict's
 * own `summary` (the FULL rendered failure text {@link failSummary} produced,
 * not the 140-char-truncated string the commit status itself is capped to —
 * `reviewPostedDescription`'s only further edit is appending a capped/degraded
 * suffix, which is already separately ledgered via `capped`/`capped_reason`/
 * `degraded_reason`, so `summary` alone is the full reason for THIS field).
 * Absent on a passing verdict, exactly like `capped_reason` — this is
 * PURELY for counting/audit (retro.ts-style mining of `review.posted`); no
 * DECISION in this codebase reads it, so it needs no entry in
 * `DECISION_RELEVANT_LEDGER_STEPS` (that set is keyed by ledger STEP name —
 * `"review.posted"` is already unconditionally retained — not by field).
 */
export function reviewLedgerLegibilityFields(
  verdict: Pick<ReviewVerdict, "capped" | "keywordOnly" | "planOnly"> &
    Partial<Pick<ReviewVerdict, "criteria" | "state" | "summary" | "criteriaTampered" | "changesetContradictions" | "instrumentEntangled">>,
): {
  capped: boolean;
  keyword_only: boolean;
  plan_only: boolean;
  capped_reason?: string;
  failure_class?: string;
  failure_reason?: string;
} {
  // `capped_reason` rides alongside `capped` rather than in its own line, so the ONE record that
  // says a verdict was capped also says why. Absent (never null/"") on an uncapped verdict, so the
  // existing ledger shape is byte-identical for every healthy review.
  const reason = verdict.capped && verdict.criteria ? cappedReason(verdict.criteria) : undefined;
  const failed = verdict.state === "failure" && verdict.criteria !== undefined && verdict.summary !== undefined;
  return {
    capped: verdict.capped,
    keyword_only: verdict.keywordOnly,
    plan_only: verdict.planOnly,
    ...(reason ? { capped_reason: reason } : {}),
    ...(failed
      ? {
          failure_class: reviewFailureClass({
            criteria: verdict.criteria!,
            criteriaTampered: verdict.criteriaTampered,
            changesetContradictions: verdict.changesetContradictions,
            instrumentEntangled: verdict.instrumentEntangled,
          }),
          failure_reason: verdict.summary!,
        }
      : {}),
  };
}

/**
 * The arming-relevant facts of the review verdict posted for ONE EXACT head —
 * {@link decideAutoMergeArm}'s `verdict` argument, recovered from the ledger by
 * a caller that never held the verdict object itself (`lib/sweep.ts`'s
 * independent "checks green + review success ⇒ arm" reconciliation). Same "last
 * one wins" scan idiom as {@link lastPostedReviewStatusFromLedger} and
 * {@link cappedOverrideFromLedger}; HEAD-BOUND for the same W1-T219/W1-T230
 * reason — a verdict judged against an older push says nothing about the head
 * about to be armed.
 *
 * TWO DIFFERENT ABSENCES, TWO DIFFERENT ANSWERS — this is the whole safety
 * argument, and the two cases are NOT symmetric:
 *
 *   (a) NO RECOVERABLE VERDICT AT ALL — no matching line, or one whose `capped`
 *       is not a boolean. Returns `undefined`: "no evidence". The caller arms
 *       exactly as it did before this function existed. A rotated ledger, a PR
 *       reviewed on another machine, or a verdict this ledger simply never saw
 *       must never strand a PR whose `remudero-review` status GitHub reports as
 *       success — that would be a fleet-wide stall triggered by log rotation.
 *
 *   (b) A VERDICT IS RECOVERABLE BUT `plan_only` IS ABSENT (a line written by a
 *       binary older than the field). `planOnly` reads FALSE — so a `capped`
 *       verdict from that era REFUSES. It is tempting to call this "unknown, so
 *       arm", but that reopens the exact hole for every pre-existing capped
 *       line, and the two outcomes are not equally bad: an unattended merge of
 *       a diff with zero executed proof is irreversible, while the cost of
 *       refusing is that the PR sits open and unarmed until someone runs
 *       `rmd review <n>` (which re-posts the verdict WITH `plan_only`, after
 *       which the W1-T205 carve-out applies normally). This mirrors sweep.ts's
 *       own standing ruling on the conflict rung: "a wrong auto-resolution is
 *       worse than a strand".
 *
 * The transitional exposure of (b) is bounded and was MEASURED before shipping:
 * a plan PR is armed at open by its own emitter (`armAutoMerge` directly,
 * bypassing this gate entirely — see review.test.ts's W1-T229 criterion-2
 * structural fixture), so it only reaches this decision at all when that at-open
 * arm failed; at the time this landed, zero open PRs carried a legacy capped
 * line for their current head.
 */
export interface PostedArmFacts {
  capped: boolean;
  planOnly: boolean;
}

export function postedArmFactsFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string | undefined,
  headSha: string | undefined,
): PostedArmFacts | undefined {
  if (!taskId || !headSha) return undefined;
  let facts: PostedArmFacts | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string" || line.head_sha !== headSha) continue;
    if (typeof line.capped !== "boolean") continue;
    // `plan_only` absent ⇒ false ⇒ a capped legacy verdict refuses. See (b) above.
    facts = { capped: line.capped, planOnly: line.plan_only === true };
  }
  return facts;
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
 *
 * `criteriaTampered` (W1-T58, Standing rule 15) takes priority over the
 * `unmetClaims.length === 0` test-theater fallback below it — a diff can trip
 * the rule-15 guard alone, with every NAMED criterion still reading "met" and
 * `testTheater` false, so that fallback's assumption ("empty unmet ⇒ it must be
 * test theater") no longer holds unconditionally.
 *
 * `unmetClaims` is caller-filtered to VISIBLE criteria only (W1-T166): this
 * summary becomes the posted commit-status description AND the `review.posted`
 * ledger's failure text, both reachable by the very worker a holdout criterion
 * must stay hidden from (a worker has full `gh` access and can trivially read
 * either). `hiddenUnmetCount` — the count of unmet HOLDOUT criteria the caller
 * deliberately left out of `unmetClaims` — is surfaced as a bare count so a
 * "visible-pass, holdout-fail" verdict (criterion 2) still reads as an honest,
 * actionable FAIL rather than a misleading "test theater"/empty-unmet fallback,
 * without ever naming which holdout criterion or what its claim/proof said.
 *
 * `changesetContradictions` (W1-T274) takes priority right after
 * `criteriaTampered` — both are diff/report-derived structural facts, not
 * semantic reviewer opinion, so both preempt the ordinary unmet-criteria text.
 * The message NAMES which claim was contradicted and which actual changed
 * files refute it (acceptance: "the failure names the contradicted claim and
 * the files that refute it") — an unexplained red is the shape that gets
 * overridden, so a bare "changeset contradiction" with no specifics would
 * defeat the point.
 *
 * `instrumentEntanglement` (W1-T297, Standing rule 25) takes priority right
 * after `changesetContradictions` — the same reasoning: a structural,
 * diff-derived fact that preempts the ordinary unmet-criteria text. The
 * message NAMES the instrument paths found and the src paths beside them
 * (W1-T186 emitter discipline) AND STATES THE RESOLUTION — split the PR (land
 * the instrument change alone, then rebase) or revert the instrument hunk —
 * because a rule that only refuses re-teaches nothing and gets worked around.
 */
export function failSummary(
  unmetClaims: string[],
  testTheater: boolean,
  noCriteria: boolean,
  criteriaTampered = false,
  hiddenUnmetCount = 0,
  changesetContradictions: ChangesetClaimContradiction[] = [],
  instrumentEntanglement?: { instrumentPaths: string[]; srcPaths: string[] },
): string {
  if (noCriteria) return `${FAIL_PREFIX}no acceptance criteria to judge (fail closed)`;
  if (criteriaTampered) {
    return `${FAIL_PREFIX}diff edits plan/tasks.yaml's own acceptance criteria — Standing rule 15 (a worker may never)`;
  }
  if (changesetContradictions.length > 0) {
    const first = changesetContradictions[0];
    const more = changesetContradictions.length > 1 ? ` (+${changesetContradictions.length - 1} more)` : "";
    const filesBudget = 3;
    const filesText =
      first.files.slice(0, filesBudget).join(", ") +
      (first.files.length > filesBudget ? `, +${first.files.length - filesBudget} more` : "");
    return `${FAIL_PREFIX}body contradicts its own diff: claimed "${first.claim}", actual changed files: ${filesText}${more}`;
  }
  if (instrumentEntanglement) {
    return (
      `${FAIL_PREFIX}entangled: instrument path(s) ${instrumentEntanglement.instrumentPaths.join(", ")} changed ` +
      `alongside src/ path(s) ${instrumentEntanglement.srcPaths.join(", ")} in the same PR — split it: land the ` +
      `instrument change in its own PR, then rebase this one onto it (or revert the instrument hunk here)`
    );
  }
  if (unmetClaims.length === 0 && hiddenUnmetCount > 0) {
    return (
      `${FAIL_PREFIX}${hiddenUnmetCount} holdout criteri${hiddenUnmetCount === 1 ? "on" : "a"} unmet ` +
      `(reviewer-only — not disclosed to the worker)${testTheater ? "; test theater" : ""}`
    );
  }
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

/** Strip a single layer of matching `"..."` or `'...'` quotes, if present. */
function stripQuotes(s: string): string {
  const m = s.match(/^(["'])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

/**
 * Parse an `Acceptance:` block out of a PR body, for manual plan/doc PRs that
 * carry no task id. The block is a header line — `Acceptance:` (optionally as
 * markdown `**Acceptance:**` or `## Acceptance`) — followed by bullet lines. Two
 * bullet shapes are recognized, both index-aligned one-per-criterion:
 *
 *   1. Single-line: `- <claim> | <proof>` (the `|` separates claim from proof; no
 *      `|` keeps the whole line as the claim with an empty proof).
 *   2. Multi-line (the house format actually emitted by plan/doc PRs, #277/#280):
 *      `- claim: "<claim>"` followed by an INDENTED, non-bullet `proof: "<proof>"`
 *      continuation line, which attaches to that same criterion rather than ending
 *      the block — so a body with N such pairs yields N criteria, not just the first.
 *
 * Parsing stops at the first line, after the bullets begin, that is neither a new
 * bullet nor a recognized continuation of the current one — a blank line, a new
 * heading, a trailer, or a resumed prose paragraph.
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
      let claim = (pipe >= 0 ? item.slice(0, pipe) : item).trim();
      const proof = pipe >= 0 ? item.slice(pipe + 1).trim() : "";
      // "- claim: <text>" form (no `|`): strip the label and any surrounding quotes.
      const claimLabel = claim.match(/^claim\s*:\s*(.*)$/i);
      if (claimLabel) claim = stripQuotes(claimLabel[1].trim());
      if (claim) criteria.push({ claim, proof });
      continue;
    }
    // An indented, non-bullet "proof:" line right under a "- claim: ..." bullet is a
    // CONTINUATION of that criterion, not a terminator — attach it and keep scanning
    // for further bullets instead of dropping every criterion after the first.
    if (criteria.length > 0 && /^\s+\S/.test(line)) {
      const proofLabel = line.trim().match(/^proof\s*:\s*(.*)$/i);
      const last = criteria[criteria.length - 1];
      if (proofLabel && !last.proof) {
        last.proof = stripQuotes(proofLabel[1].trim());
        continue;
      }
    }
    // A blank line before any bullet is tolerated (header, then a gap, then bullets);
    // once bullets have begun, any blank or unrecognized line ends the block.
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
 *
 * W1-T212 (recon R-15): a diff that edits WHAT a quality gate measures — a CI
 * workflow, a ratchet script, or a ratchet's recorded baseline/threshold — is
 * exactly as "user-visible" as editing the gate code itself: it can weaken the
 * measurement the gate is trusted to enforce, silently, with no reviewer
 * prompted to notice. Before this, `.github/workflows/`, `scripts/*-ratchet.mjs`,
 * every `scripts/*-baseline.json` floor, and `stryker.conf.json`'s mutation
 * scope were ALL outside this regex, so a PR lowering a coverage/mutation floor
 * or deleting a required check from `ci-gate.yml` cleared docs-awareness
 * silently (`no CLI/config/gate/verdict surface changed`).
 */
/**
 * The measurement-INSTRUMENT surface (W1-T297, Standing rule 25): paths a
 * diff can touch to change WHAT a CI gate measures, rather than what the gate
 * concludes about a change. ONE PATH SET, EXPORTED — {@link
 * USER_VISIBLE_SURFACE_RE}'s instrument arm (W1-T212's docs-awareness rung)
 * and {@link detectInstrumentEntanglement} (this task's BINDING isolation
 * gate) are both DERIVED FROM THIS constant so the two surfaces can never
 * drift apart into a second, hand-maintained copy. Membership verified
 * against the live tree at filing (2026-08-03 — verify again before trusting
 * it): `.github/workflows/` (CI measurement wiring), every
 * `scripts/*-ratchet.mjs` (ratchet gate scripts), `scripts/diff-coverage.mjs`
 * (coverage's own text-awareness carve-outs — the W1-T210 fixture this
 * task's rationale names), every `scripts/*-baseline.json` (recorded
 * floors/caps), `scripts/mutation-relevant-paths.json` (mutation-ratchet's
 * diff-scoping config), and `stryker.conf.json` (mutation scope/config).
 */
export const INSTRUMENT_SURFACE: readonly string[] = [
  "^\\.github/workflows/",
  "^scripts/[^/]*-ratchet\\.mjs$",
  "^scripts/diff-coverage\\.mjs$",
  "^scripts/[^/]*-baseline\\.json$",
  "^scripts/mutation-relevant-paths\\.json$",
  "^stryker\\.conf\\.json$",
];

const INSTRUMENT_SURFACE_RE = new RegExp(INSTRUMENT_SURFACE.join("|"));

const USER_VISIBLE_SURFACE_RE = new RegExp(
  [
    "^bin/", // the CLI entry point
    "^src/run-task\\.ts$", // CLI dispatcher / orchestrator
    "^src/spike\\.ts$", // CLI entry (spike mode)
    "^src/lib/(config|settings|mounts)\\.ts$", // config surface
    "^src/lib/(review|task-linter)\\.ts$", // gate surface
    "^src/lib/(run-result|status|ledger|flight-judge)\\.ts$", // verdict surface
    ...INSTRUMENT_SURFACE, // measurement-instrument surface (shared, see its own doc)
  ].join("|"),
);

/**
 * A "product" path for entanglement purposes (W1-T297): under `src/` and NOT
 * itself a test file. `test/` files must NOT count as the product half of an
 * entanglement — the design's own carve-out — or an instrument-only PR could
 * never carry the fixture that proves it (`test/diff-coverage.test.ts` is
 * exactly the file W1-T212 shipped for this purpose).
 */
function isProductPath(path: string): boolean {
  return path.startsWith("src/") && !isTestPath(path);
}

/**
 * INSTRUMENT ISOLATION (W1-T297, Standing rule 25): true when `diffFiles`
 * contains at least one {@link INSTRUMENT_SURFACE} path AND at least one
 * {@link isProductPath} src/ path — the ENTANGLEMENT predicate, not mere
 * instrument-touching. An instrument-only diff (optionally with its own
 * `test/` falsifier and/or a `docs/` update) is the sanctioned shape and
 * returns `entangled: false`; so does a src-only, plan-only, or docs-only
 * diff. `instrumentPaths`/`srcPaths` are the OBSERVED EVIDENCE named in the
 * failure text and the fix rung's escalation (W1-T186 emitter discipline).
 */
function detectInstrumentEntanglement(
  diffFiles: string[],
): { entangled: boolean; instrumentPaths: string[]; srcPaths: string[] } {
  const instrumentPaths = diffFiles.filter((f) => INSTRUMENT_SURFACE_RE.test(f));
  const srcPaths = diffFiles.filter(isProductPath);
  return { entangled: instrumentPaths.length > 0 && srcPaths.length > 0, instrumentPaths, srcPaths };
}

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

// ── The GUARD: no worker-authored criteria edit (rule 15) ──────────────────

/** plan/tasks.yaml lines belonging to a criterion's own field, of the given diff kind. */
function planTasksCriterionFieldLines(lines: DiffLine[], kind: "add" | "del"): DiffLine[] {
  return lines.filter(
    (l) => l.kind === kind && /(^|\/)plan\/tasks\.yaml$/.test(l.file) && /^\s*(claim|proof|satisfied_by)\s*:/.test(l.text),
  );
}

/**
 * RULE 15's shared diff-derived predicate (W1-T58, ratifies P3 via P8/
 * RETRO-1784058021334; originally W1-T3E's narrower `satisfied_by`-only check):
 * true when a diff either ADDS a `satisfied_by:` line, or REMOVES an existing
 * criterion field line (`claim:`/`proof:`/`satisfied_by:`), in `plan/tasks.yaml`.
 * A removed field line is present whether the field's TEXT changed (an edit) or
 * the whole criterion was deleted — both read as "the criteria no longer say
 * what the Architect wrote". Diff-derived ONLY: callers apply their OWN
 * exemption on top ({@link checkSatisfiedByGuard}: `planOnly && humanAuthored`;
 * {@link judgeReview}: `planOnly` alone — the one signal that pure function has).
 */
function criterionFieldTampered(diff: string): boolean {
  const lines = walkDiff(diff);
  const addedSatisfiedBy = planTasksCriterionFieldLines(lines, "add").some((l) =>
    /^\s*satisfied_by\s*:/.test(l.text),
  );
  const removedField = planTasksCriterionFieldLines(lines, "del").length > 0;
  return addedSatisfiedBy || removedField;
}

/**
 * THE RULE-15 GUARD: `satisfied_by` and criteria text are Architect-only
 * (plan.ts / Standing rule 15 — "a worker may never [correct a mis-specified
 * task]"). A diff that ADDS a `satisfied_by:` line, OR EDITS/REMOVES an
 * existing criterion's `claim:`/`proof:`/`satisfied_by:` field, in
 * `plan/tasks.yaml` FAILS unless the PR is plan-only AND human-authored — a
 * worker doing either to its own blocking criterion is "editing the criteria
 * to match the diff", a failed task, not a merge. W1-T58 broadens this from
 * W1-T3E's original add-only `satisfied_by` check to cover the full "edits its
 * criteria" shape the rule actually names.
 */
export function checkSatisfiedByGuard(diff: string, meta: RubricPrMeta = {}): RubricItemResult {
  if (!criterionFieldTampered(diff)) {
    return { key: "satisfied-by-guard", pass: true, reason: "no criterion field added or edited in plan/tasks.yaml" };
  }
  if (meta.planOnly && meta.humanAuthored) {
    return {
      key: "satisfied-by-guard",
      pass: true,
      reason: "criterion field added/edited in a plan-only, human-authored PR (Architect-only — allowed)",
    };
  }
  return {
    key: "satisfied-by-guard",
    pass: false,
    reason:
      "worker-authored edit to plan/tasks.yaml's acceptance criteria (an added satisfied_by, or an edited/removed " +
      "claim/proof/satisfied_by field) outside a plan-only human PR is editing the criteria to match the diff (Standing rule 15)",
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
/**
 * W1-T135: total attempts (first try + retries) before a TRANSIENT gh-status-post
 * error gives up — one initial attempt plus 3 retries, the same retry BOUND
 * classify.ts's {@link "./classify.js".MAX_TRANSIENT_RETRIES} uses for the
 * unrelated fix-rung attempt loop (independent counters, same "3 retries" policy
 * so the two don't drift apart for no reason).
 */
export const POST_REVIEW_STATUS_MAX_ATTEMPTS = 4;

/** Base delay (ms) for {@link postReviewStatus}'s exponential backoff between
 * retries — attempt N's wait is `POST_REVIEW_STATUS_BASE_DELAY_MS * 2**(N-1)`. */
export const POST_REVIEW_STATUS_BASE_DELAY_MS = 500;

/**
 * Injectable dependencies for {@link postReviewStatus}'s retry-with-backoff —
 * mirrors classify.ts's `DiagnoseThenRetryDeps` DI shape (optional, real
 * defaults; tests override to avoid a real `gh` spawn / real waiting).
 */
export interface PostReviewStatusRetryOpts {
  /** Total attempts before giving up on a TRANSIENT error. Default {@link POST_REVIEW_STATUS_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Backoff before the NEXT attempt, given the just-failed attempt number (1-based). Default: exponential off {@link POST_REVIEW_STATUS_BASE_DELAY_MS}. */
  backoffMs?: (failedAttempt: number) => number;
  /** Injectable sleep (tests skip real waiting). Default: a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable `gh` invocation — the "gh gateway" a unit test simulates without shelling out. Defaults to the real `execFileSync("gh", ...)` POST below. */
  exec?: (args: string[], env: NodeJS.ProcessEnv) => void;
}

/** Exported (not just internal) so a unit test can PATH-stub `gh` and drive
 * this exact real invocation directly — the same "temp-dir fake gh on PATH"
 * pattern `realArmDeps` tests already use in run-task.test.ts — rather than
 * only ever exercising it indirectly through {@link postReviewStatus}'s
 * injectable `exec`, which would leave this one-line real wrapper itself
 * permanently uncovered by the diff-coverage ratchet. */
export function execGhStatusPost(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("gh", args, { stdio: "pipe", env, encoding: "utf8" });
}

/** The text a thrown `gh`/execFileSync error carries — stderr first (that's
 * where `gh api`'s own "gh: <message> (HTTP <code>)" error lands), falling
 * back to stdout, then the Error's own message. Mirrors the stderr/stdout
 * extraction {@link execWhitelistedProof} already does for the same
 * execFileSync error shape. */
function ghErrorText(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer | null; stdout?: string | Buffer | null };
  const asString = (v: string | Buffer | null | undefined) => (typeof v === "string" ? v : (v?.toString("utf8") ?? ""));
  const message = e instanceof Error ? e.message : String(e);
  return [asString(err?.stderr), asString(err?.stdout), message].filter(Boolean).join("\n");
}

/**
 * W1-T135 (LIVE INCIDENT 2026-07-20): this used to be a bare `execFileSync`
 * with no error handling at all — a single transient 503 posting the status
 * threw and crashed run W1-T132-1784508142857 mid-fix-rung, the root cause of
 * escalation #283. Now: a TRANSIENT error ({@link classifyFailure} over the
 * `gh` error text — GitHub 5xx, network blips, rate-limit backpressure; the
 * SAME classifier the fix-rung retry loop uses, so "is this transient" never
 * drifts between the two call sites) is retried with exponential backoff, up
 * to {@link POST_REVIEW_STATUS_MAX_ATTEMPTS} attempts total. A PERMANENT error
 * (a 404/422, or any text `classifyFailure` doesn't recognize as transient —
 * fail-closed, same as classify.ts) is never retried; it throws on the first
 * attempt. Either way, once attempts are exhausted this function THROWS the
 * last error — it has no ledger access of its own, so "ledger-and-continue on
 * exhaustion" is {@link postReviewStatusGuarded}'s job (the sole caller in
 * production): it catches this throw, ledgers `review.post_failed`, and
 * returns `{posted:false}` instead of letting the exception crash the run.
 */
export async function postReviewStatus(
  opts: {
    owner: string;
    repo: string;
    sha: string;
    state: ReviewState;
    description?: string;
  },
  retryOpts: PostReviewStatusRetryOpts = {},
): Promise<void> {
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

  const maxAttempts = retryOpts.maxAttempts ?? POST_REVIEW_STATUS_MAX_ATTEMPTS;
  const backoffMs = retryOpts.backoffMs ?? ((failedAttempt) => POST_REVIEW_STATUS_BASE_DELAY_MS * 2 ** (failedAttempt - 1));
  const sleep = retryOpts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const exec = retryOpts.exec ?? execGhStatusPost;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      exec(args, env);
      return;
    } catch (e) {
      const transient = classifyFailure({ text: ghErrorText(e) }) === "transient";
      if (!transient || attempt >= maxAttempts) throw e; // permanent, or transient-but-exhausted: surface once
      await sleep(backoffMs(attempt));
    }
  }
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
// ONE POST SITE enforces FOUR RULES — {@link postReviewStatusGuarded} is the
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
//   (iv)  RESILIENCE (W1-T135) — {@link postReviewStatus} itself retries a
//         TRANSIENT gh error (5xx, network) with backoff; if it still throws
//         (retries exhausted, or a PERMANENT 4xx that was never retried),
//         this guarded site catches it, ledgers `review.post_failed` with
//         the would-be verdict, and returns `{posted:false}` — a status-post
//         hiccup degrades, it never crashes the run (the W1-T113 class,
//         applied here; LIVE INCIDENT: a bare 503 crashed run
//         W1-T132-1784508142857 mid-fix-rung, escalation #283).
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

/** Parse raw lock file contents into a holder record, or `null` for garbage/unshaped JSON
 *  (shared with {@link reclaimStaleLock}'s `parseHolder`). */
function parseReviewStatusLockInfo(raw: string): ReviewStatusLockInfo | null {
  try {
    const o = JSON.parse(raw);
    return typeof o?.pid === "number" ? (o as ReviewStatusLockInfo) : null;
  } catch {
    return null;
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
  /** Called when a reclaim attempt loses the race (see {@link reclaimStaleLock}). Defaults
   *  to a `console.error` trace; tests override it to observe the event directly. */
  onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
  /** TEST-ONLY seam forwarded to {@link reclaimStaleLock}'s `beforeDelete` — lets a test
   *  force a second reclaimer's whole acquire to complete inside this call's reclaim
   *  window. Never set outside tests. */
  __beforeReclaimDelete?: () => void;
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
 * so two racing acquirers hitting the create fresh cannot both win it; a stale
 * lock — holder pid dead, or the file unreadable/garbage — is reclaimed via
 * {@link reclaimStaleLock}, whose delete is conditioned on the lock's on-disk
 * identity, so two reclaimers of the SAME dead lock cannot both come away
 * believing they hold it either, W1-T289), adapted from a SINGLETON GUARD to a
 * MUTEX: where those THROW immediately when a live holder is found, this
 * WAITS (bounded by `timeoutMs`) and retries — the callers here are N
 * uncoordinated posters that must all eventually run their own
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
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseReviewStatusLockInfo,
        isStale: (held) => !isAlive(held.pid),
        onLostReclaim: opts.onLostReclaim,
        beforeDelete: opts.__beforeReclaimDelete,
      });
      if (result.outcome === "live") {
        if (Date.now() >= deadline) throw new ReviewStatusLockTimeoutError(lockPath, result.holder);
        await reviewStatusLockDelay(retryMs); // MUTEX: wait + retry, never throw on a live holder
        continue;
      }
      // "missing" | "reclaimed" | "lost" → loop back and retry the atomic create.
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
  /** Injected raw poster (tests). Defaults to {@link postReviewStatus} (which
   * already retries a TRANSIENT gh error internally — see the module doc
   * comment's rule (iv)). May return a Promise (the default does) or `void`
   * (existing sync test fakes keep working unchanged). */
  post?: (o: {
    owner: string;
    repo: string;
    sha: string;
    state: ReviewState;
    description?: string;
  }) => void | Promise<void>;
  lockOpts?: AcquireReviewStatusLockOpts;
}

export interface PostReviewStatusGuardedResult {
  posted: boolean;
  /** Present only when `posted` is false — either {@link decideReviewStatusPost}
   * refused the write (see `review.post_refused`), or the post itself failed
   * after retries/as a permanent error (see `review.post_failed`, W1-T135). */
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
 *
 * W1-T135: a post that still THROWS (transient retries exhausted inside
 * {@link postReviewStatus}, or a permanent error it never retried) is caught
 * HERE, never left to propagate — it is ledgered as `review.post_failed`
 * (carrying the verdict that could not be posted) and this function returns
 * `{posted:false}` like an ordinary refusal, so every caller's existing
 * `if (!posted.posted) { ... }` handling already degrades gracefully instead
 * of the whole run crashing (the LIVE INCIDENT this task exists to fix).
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
    try {
      await post({ owner: opts.owner, repo: opts.repo, sha: opts.sha, state: opts.state, description: opts.description });
    } catch (e) {
      // W1-T135 exhaustion path: ledger-and-continue, never crash the run.
      const message = e instanceof Error ? e.message : String(e);
      appendLedger(opts.ledgerPath, {
        run_id: opts.runId,
        task_id: opts.taskId,
        step: "review.post_failed",
        head_sha: opts.sha,
        attempted_state: opts.state,
        evidence: opts.evidence,
        description: opts.description,
        error: message,
      });
      return {
        posted: false,
        reason: `posting remudero-review failed and was not applied (see the review.post_failed ledger line): ${message}`,
      };
    }
    return { posted: true };
  } finally {
    handle.release();
  }
}
