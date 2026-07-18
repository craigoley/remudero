import { appendLedger } from "./ledger.js";
import { readLedgerLines } from "./status.js";
import type { CriterionVerdict } from "./review.js";
import type { QuestionEntry } from "./worker.js";

/**
 * lib/sweep.ts — the level-triggered PR-pipeline reconciler (W1-T77, ratifies
 * P22 core).
 *
 * The pipeline was EDGE-TRIGGERED: a verdict fired once (from a live run) and if
 * its consumer was missing the PR stranded open-and-orphaned (#111/#113/#123 sat
 * open for a whole session). This reconciler is LEVEL-TRIGGERED, like
 * Kubernetes/Prow-tide: each daemon poll + on-demand `rmd sweep` re-derives EVERY
 * open PR's disposition FRESH from observed state and takes the one gated action.
 * It is the third policy-gated ACT lane (§5D): dep lane (W1-T54) · alert lane
 * (P20) · this PR-pipeline reconciler.
 *
 * DETERMINISTIC, POLICY-AS-DATA (rule 2): the disposition predicate is a pure
 * function of observed PR state + an exported {@link SweepPolicy} table — NEVER an
 * LLM classification, never a magic number buried in an if-branch. Every threshold
 * a test might flip lives in the policy object so a fixture can override it.
 *
 * Every open PR gets EXACTLY ONE of four dispositions and its gated action:
 *   - MERGEABLE        — POSITIVELY matched only: required checks green AND review
 *                        success -> arm auto-merge (per-repo merge SERIALIZATION
 *                        slots are a future WS-2 task and deliberately NOT built
 *                        here — today we just ARM, honoring P22's capture
 *                        ADDENDUM). Never inferred from the mere ABSENCE of a
 *                        failure — see BLOCKED-AMBIGUOUS's terminal row below (the
 *                        #161 fix, W1-T93): a CI-red PR whose review was SKIPPED
 *                        matches no failure rule either, and used to fall through
 *                        to this row's old unconditional catch-all, arming a PR
 *                        GitHub's required-CI gate would then stall FOREVER —
 *                        never fixed, never escalated, invisible.
 *   - BLOCKED-FIXABLE  — EITHER (a) a failing review with actionable unmet criteria
 *                        and strikes left -> dispatch the W1-T76 fix rung (reused,
 *                        not reimplemented) carrying the FULL unmet set at once; OR
 *                        (b) required checks red with NO review posted yet — the
 *                        blocked_ci shape, the #170 fix (W1-T100) — and strikes
 *                        left -> dispatch the SAME rung in ci-log mode (W1-T94),
 *                        carrying the failing check names + log tails instead of a
 *                        reviewer verdict. FIX FIRST, ask after exhaustion: a
 *                        checks-red PR reaches the question rung only THROUGH the
 *                        strike ladder below, never straight there.
 *   - STALE/SUPERSEDED — a newer PR credits the same task, or no activity in N days
 *                        -> close with a stated reason (the #111/#113 manual chore).
 *   - BLOCKED-AMBIGUOUS— fix strikes exhausted (shared ladder — review AND ci-log
 *                        strikes count against the SAME cap, one exhaustion route),
 *                        contradictory criteria, OR the TERMINAL catch-all (anything
 *                        not positively mergeable, not failure-shaped, and not the
 *                        blocked_ci shape above — e.g. checks still pending with no
 *                        review) -> the CLARIFICATION-QUESTION rung (W1-T78, ratifies
 *                        P22's new rung): {@link renderClarificationQuestion} renders
 *                        a SPECIFIC, decidable operator question from ledger ground
 *                        truth (never a generic needs-human), which the real wiring
 *                        (run-task.ts's `buildSweepEffects`) logs to the §2 question
 *                        backlog AND opens via W1-T8's `escalate()` as the
 *                        notification transport — so it is never silent and never
 *                        armed.
 *
 * SCOPING (honest): HUNG workers are EXPLICITLY DEFERRED to a future WS-2 task.
 * Worker liveness is RUN-state, not PR-state, and this sweep's domain is PR state
 * ONLY — it does not attempt to detect or reap hung workers.
 *
 * INVARIANTS:
 *   - No open PR ends a sweep with disposition=none — {@link deriveDisposition} is
 *     TOTAL over its input.
 *   - IDEMPOTENCE (the level-triggered core): dispositions are re-derived fresh
 *     every sweep, but ACTIONS are deduped against what is already true — a second
 *     sweep over UNCHANGED observed state dispatches NO new actions. Dedup is keyed
 *     on the shared ledger (persists across sweeps even when the input fixtures are
 *     byte-identical): a prior `sweep.disposed` line that recorded `acted: true`
 *     suppresses the same action. Fix dispatch is additionally keyed on the head sha
 *     so a NEW push (state changed) legitimately re-earns a strike, up to the cap.
 *   - Every disposition produces one `sweep.disposed` ledger line via appendLedger.
 *
 * All external effects (arm / dispatch-fix / close / escalate, and reading the
 * ledger for prior actions) are INJECTED — this module never calls `gh`/git/network
 * directly, mirroring how runFixRung/escalate are structured.
 */

/** One of the four dispositions every open PR is reconciled into. */
export type Disposition = "mergeable" | "blocked-fixable" | "stale" | "blocked-ambiguous";

/**
 * One failing required CI check's name + the tail of its log — the W1-T94
 * ci-log fix mode's ONLY input. Defined HERE (not in run-task.ts, which
 * imports it) because {@link OpenPrView} carries it and run-task.ts already
 * imports OpenPrView from this module — the reverse import would be circular.
 */
export interface CiFailure {
  name: string;
  logTail: string;
}

/**
 * W1-T78 policy (policy-as-data, rule 2 — never hardcoded): how many strikes a
 * fix-rung RE-DISPATCH gets once an operator answers a clarification
 * question. Nested inside {@link SweepPolicy} — the SAME config object every
 * `runSweep` caller already threads — rather than a second, separately-sourced
 * policy object.
 */
export interface ClarifyPolicy {
  /** true (default): the answer resets the counter to a FRESH strikeCap. false: exactly one bounded extra strike. */
  resetStrikeCounterOnAnswer: boolean;
}

/** The default clarify policy — an answer earns a fresh full strikeCap. */
export const DEFAULT_CLARIFY_POLICY: ClarifyPolicy = { resetStrikeCounterOnAnswer: true };

/**
 * Tunable thresholds as DATA (rule 2) — never inlined constants in the predicate.
 * A test overrides these to prove policy is data (acceptance 3): tightening
 * `staleDays` flips a fixture PR's disposition with zero sweep-code changes.
 */
export interface SweepPolicy {
  /** No activity in >= this many days ⇒ the PR is abandoned -> close. */
  staleDays: number;
  /** Max fix-rung strikes before a failing review escalates instead of fixing. */
  strikeCap: number;
  /** W1-T78: re-dispatch strike-cap policy once an operator answers a clarification question. */
  clarify: ClarifyPolicy;
}

/** The default policy — 14-day stale window, 2 fix strikes (mirrors fixStrikeCap). */
export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  staleDays: 14,
  strikeCap: 2,
  clarify: DEFAULT_CLARIFY_POLICY,
};

/**
 * One open PR's OBSERVED state, as the sweep sees it — the input to the pure
 * predicate. The real gateway builds this from `gh pr list --state open --json …`
 * + the review/CI derivation status.ts already does; tests inject fixtures.
 */
export interface OpenPrView {
  prNumber: number;
  prUrl: string;
  /** The task this PR credits (its `Remudero-Task:` trailer), if resolved. */
  taskId?: string;
  /** Rolled-up remudero-review state on the head. */
  reviewState: "success" | "failure" | "pending" | "none";
  /** Rolled-up required-checks state on the head. */
  checksState: "green" | "red" | "pending" | "none";
  /** The unmet acceptance criteria from a failing review ([] otherwise). */
  unmetCriteria: CriterionVerdict[];
  /** Fix-rung strikes ALREADY attempted for this PR (from the ledger). */
  priorStrikes: number;
  /** A NEWER open PR crediting the same task supersedes this one. */
  supersededBy?: number;
  /** ISO-8601 timestamp of the PR's last activity (for the stale window). */
  lastActivityAt: string;
  /** The head commit sha — keys fix-dispatch idempotence (a new push re-earns a strike). */
  headSha: string;
  /** Observed: is GitHub auto-merge already armed on this PR? */
  autoMergeArmed: boolean;
  /** The failing review's one-line summary (context for fix/escalate). */
  reviewSummary?: string;
  /**
   * Failing required-check name+log-tail evidence — the W1-T94 ci-log fix
   * mode's input (W1-T100, the #170 fix). Populated when `checksState ===
   * "red"`; `[]`/undefined when checks aren't red or no failing-check detail
   * could be captured (the fix prompt then degrades to "no detail captured",
   * `renderFixPrompt`, never a crash).
   */
  ciFailures?: CiFailure[];
  /**
   * What each recorded fix-rung strike TRIED for this PR's task, ledger
   * ground truth only (W1-T78) — the clarification-question rung's "what the
   * fix worker tried per strike" input. `[]`/undefined when no strike is
   * recorded (e.g. the terminal catch-all, which never dispatched a fix).
   */
  strikeHistory?: StrikeAttempt[];
  /**
   * An operator's answer to a PRIOR clarification question (W1-T78), if one
   * has been recorded for this PR and not yet consumed. Its `constraint`
   * feeds the NEXT fix-rung dispatch verbatim (never a silent guess); routes
   * this PR to `blocked-fixable` instead of `blocked-ambiguous` even with
   * strikes at cap (a new, config-driven strike allowance — see
   * {@link ClarifyPolicy}/{@link strikeCapForAnswer}), so the answer actually
   * re-arms the rung rather than immediately re-exhausting it.
   *
   * SCOPE (honest, mirrors how W1-T77 shipped BLOCKED-AMBIGUOUS's interim
   * escalate() route for THIS task to upgrade): this field, its
   * DISPOSITION_RULES row, and `dispatchFix`'s constraint/strikeCap threading
   * are the full MECHANISM, wired end-to-end and unit-tested — but nothing in
   * `run-task.ts` populates it yet (`buildOpenPrViews`/`fixCommand` never set
   * it). Recording an operator's answer against a specific question — a
   * CLI/control-panel PRODUCER for this field — is a future task; until it
   * lands, `pendingAnswer` is always `undefined` in the real gateway, so every
   * BLOCKED-AMBIGUOUS PR keeps asking (never silently re-arms itself).
   */
  pendingAnswer?: { constraint: string; resetStrikeCounter?: boolean };
}

/** The disposition derived for one PR, plus a stated human reason. */
export interface DispositionResult {
  disposition: Disposition;
  reason: string;
}

/**
 * One PR status-check-rollup entry, structurally — a CheckRun or StatusContext
 * as `gh pr list/view --json statusCheckRollup` reports it. Kept minimal (name
 * ONLY the fields {@link checksStateFromRollup} reads) so this deterministic
 * core never depends on run-task.ts's richer `RollupCheck` wiring shape —
 * that type is structurally assignable here without an import.
 */
export interface RollupCheckEntry {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/**
 * Conclusions GitHub's OWN branch-protection merge-eligibility treats as
 * SATISFYING a required check (W1-T103, the #170 stuck-ambiguous fix): a
 * required check that reports SKIPPED or NEUTRAL still counts as green — only
 * a genuinely unresolved/incomplete check (anything not in this set and not a
 * failure below) holds checksState at "pending".
 */
const REQUIRED_CHECK_OK = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/** Conclusions that veto a required check outright — checksState goes "red". */
const REQUIRED_CHECK_FAIL = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/**
 * Aggregate ONLY the REQUIRED contexts into the sweep's checksState (W1-T103,
 * the #170 stuck-ambiguous fix). `requiredContexts` is branch protection's OWN
 * list — read once per repo by the real gateway (status.ts's
 * `ghRequiredStatusCheckContexts`) and threaded in here, never hardcoded
 * (rule 2, policy-as-data) — matched against each rollup entry's `name` or
 * `context`.
 *
 * LIVE INCIDENT this fixes (#170 post-heal): the pre-fix derivation scanned
 * EVERY reported check with no required/non-required distinction, so a single
 * SKIPPED non-required context (e.g. a path-filtered or schedule-only
 * workflow's stub run) held checksState at "pending" forever even when every
 * REQUIRED context was green and GitHub itself would happily merge the PR —
 * the sweep just couldn't see it, and dispositioned it blocked-ambiguous on
 * every pass. Non-required contexts are still carried in the raw rollup for
 * OTHER consumers (fetchCiFailures' evidence) but never vote on checksState
 * here.
 *
 * `requiredContexts` empty/undefined (e.g. the branch-protection API was
 * unreadable) degrades to the PRE-FIX conservative behavior — every reported
 * context counts, AND only SUCCESS satisfies one (the SKIPPED/NEUTRAL
 * leniency above is itself part of THIS fix, so it does not apply when we
 * can't confirm which contexts are actually required) — fail-closed: an
 * unreadable protection rule must never manufacture a false green.
 */
export function checksStateFromRollup(
  rollup: RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
): OpenPrView["checksState"] {
  const all = rollup ?? [];
  if (all.length === 0) return "none";
  const required = new Set(requiredContexts ?? []);
  const knownRequired = required.size > 0;
  const gate = knownRequired ? all.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? "")) : all;
  // Required contexts are configured but none has registered on this head yet
  // (e.g. the workflow hasn't started) — waiting, not "no checks at all".
  if (gate.length === 0) return knownRequired ? "pending" : "none";
  const ok = knownRequired ? REQUIRED_CHECK_OK : new Set(["SUCCESS"]);
  let anyPending = false;
  for (const c of gate) {
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (REQUIRED_CHECK_FAIL.has(s)) return "red";
    if (!ok.has(s)) anyPending = true;
  }
  return anyPending ? "pending" : "green";
}

const MS_PER_DAY = 86_400_000;

/**
 * The blocked_ci shape (the #170 fix, W1-T100): required checks are red and NO
 * review has been posted yet — the failing signal IS the CI log, never a
 * reviewer verdict (a review only runs once CI is green). EXPORTED (not just
 * shared across this table's own rows) so every OTHER caller that needs the
 * same classification — `routeFix`'s strike-cap-honored escalate check and its
 * evidence-shape selection, `runSweep`'s evidence-shape selection — imports
 * this ONE definition rather than hand-copying the two-field check, which
 * would silently drift the moment this predicate is refined.
 */
export function isBlockedCi(pr: OpenPrView): boolean {
  return pr.checksState === "red" && pr.reviewState === "none";
}

/**
 * One row of the POLICY-AS-DATA table (rule 2): a mapping from an observed
 * PR-state predicate to the disposition it produces, plus the stated reason.
 * The disposition SELECTION lives in {@link DISPOSITION_RULES} — a data
 * structure, never imperative if/else branches — exactly the shape the dep lane
 * (W1-T54, `MANIFEST_PATTERNS`) and alert lane express their policy in. Adding,
 * removing, or reordering a disposition is a TABLE edit, never a code branch.
 */
interface DispositionRule {
  readonly disposition: Disposition;
  /** Observed-state predicate over the PR + the tunable {@link SweepPolicy} thresholds. */
  readonly when: (pr: OpenPrView, policy: SweepPolicy, ageDays: number) => boolean;
  readonly reason: (pr: OpenPrView, policy: SweepPolicy, ageDays: number) => string;
}

/**
 * THE POLICY TABLE — the ordered rules mapping observed PR-state -> disposition.
 * Precedence is table order (first match wins); the terminal rule matches
 * unconditionally, so a disposition is ALWAYS produced (the no-disposition=none
 * invariant is structural, not a branch). Because the mapping is DATA, a test —
 * or a future policy edit — flips a disposition by changing a threshold in
 * {@link SweepPolicy} or a row here, with ZERO change to {@link deriveDisposition}
 * (acceptance 3):
 *
 *   1. SUPERSEDED  — a newer PR credits the same task: close regardless of review.
 *   2. STALE       — no activity in >= policy.staleDays: abandoned, close.
 *   3. ANSWERED (W1-T78) — an operator answered a clarification question AND the
 *      answer-extended strike allowance is not itself exhausted -> blocked-fixable
 *      (re-dispatch WITH the answer as an added constraint), even when the
 *      ORIGINAL strikeCap was already hit — this is what makes an answer actually
 *      re-arm the rung instead of landing straight back on row 4's escalate.
 *   4. FAILING + strikes exhausted (>= cap)              -> blocked-ambiguous (escalate).
 *      GENERALIZED (W1-T100, the #170 fix): "strikes exhausted" also covers the
 *      blocked_ci shape (checks red, no review yet) — ci-log strikes share the
 *      SAME counter and cap as review strikes, one ladder, one exhaustion route
 *      (design note iv). Ordered ahead of row 6b below so an exhausted blocked_ci
 *      PR escalates rather than re-matching the positive fixable row forever.
 *   5. FAILING + actionable unmet criteria, strikes left -> blocked-fixable (fix rung).
 *   6. FAILING + no actionable criteria (contradictory)  -> blocked-ambiguous (escalate).
 *   6b. blocked_ci (W1-T100, the #170 fix): checks red, NO review posted yet,
 *      strikes left (row 4 above already routed the exhausted case) ->
 *      blocked-fixable, dispatching the SAME W1-T76 rung in ci-log mode
 *      (W1-T94) — failing check names + log tails, never a reviewer verdict.
 *      FIX FIRST: this PR reaches the question rung (row 8) only by exhausting
 *      the ladder through row 4, never straight from here.
 *   7. CI GREEN + REVIEW SUCCESS (POSITIVE match only)   -> mergeable (arm).
 *   8. TERMINAL catch-all (the #161 fix, W1-T93): anything not positively
 *      mergeable, not already failure-shaped, and not the blocked_ci shape
 *      above (e.g. checks still pending, review still pending) ->
 *      blocked-ambiguous (the CLARIFICATION-QUESTION rung, W1-T78), naming the
 *      observed checks/review state. The catch-all is the LEAST permissive
 *      disposition, never the most permissive one; mergeable is ONLY ever
 *      positively matched (row 7), never a fallback.
 *
 * Stale/superseded rows precede the failing/mergeable rows so tightening the
 * stale threshold flips an otherwise-mergeable PR to a close. Row 3 (answered)
 * precedes row 4 (strikes exhausted) so an answer's extended allowance actually
 * overrides exhaustion; rows 4-6b (review FAILING / blocked_ci) precede row 7 so
 * a CI-green-but-review-failing (or checks-red) PR still routes to fix/escalate,
 * not mergeable.
 */
export const DISPOSITION_RULES: readonly DispositionRule[] = [
  {
    disposition: "stale",
    when: (pr) => pr.supersededBy != null,
    reason: (pr) => `superseded-by #${pr.supersededBy}`,
  },
  {
    disposition: "stale",
    when: (_pr, policy, ageDays) => ageDays >= policy.staleDays,
    reason: (_pr, policy, ageDays) =>
      `abandoned — no activity in ${Math.floor(ageDays)}d (>= ${policy.staleDays}d threshold)`,
  },
  {
    // W1-T78: an operator's answer to a clarification question RE-ARMS the fix
    // rung — but only within its own (config-policy) strike allowance, never
    // unconditionally, so a bad answer still eventually escalates rather than
    // looping forever. W1-T100: generalized to the blocked_ci shape too (via
    // the SAME `isBlockedCi` row 4/6b share) — without this, a strike-exhausted
    // blocked_ci PR could never be re-armed by an answer once `pendingAnswer`
    // production wiring lands, and would loop on the question rung forever.
    disposition: "blocked-fixable",
    when: (pr, policy) => {
      if (!pr.pendingAnswer) return false;
      const reviewShape = pr.reviewState === "failure" && pr.unmetCriteria.length > 0;
      if (!reviewShape && !isBlockedCi(pr)) return false;
      const clarify: ClarifyPolicy = {
        resetStrikeCounterOnAnswer: pr.pendingAnswer.resetStrikeCounter ?? policy.clarify.resetStrikeCounterOnAnswer,
      };
      // strikeCapForAnswer returns the ADDITIONAL strikes the answer grants (the
      // SAME number the real re-dispatch passes as runFixRung's own fresh
      // strikeCap, since runFixRung always counts a NEW call from 0) — so the
      // cumulative ceiling this answered PR gets is the ORIGINAL cap plus that
      // allowance, never an unconditional bypass of the ledger's running count.
      return pr.priorStrikes < policy.strikeCap + strikeCapForAnswer(policy.strikeCap, clarify);
    },
    reason: (pr) =>
      `operator answered the clarification question — re-dispatching the fix rung with the added constraint (strike ${pr.priorStrikes + 1})`,
  },
  {
    // W1-T100: the exhaustion check now covers BOTH failure shapes — a failing
    // review AND a blocked_ci PR (checks red, no review yet) — off the SAME
    // strike counter/cap (design note iv: one ladder, one exhaustion route).
    disposition: "blocked-ambiguous",
    when: (pr, policy) => (pr.reviewState === "failure" || isBlockedCi(pr)) && pr.priorStrikes >= policy.strikeCap,
    reason: (pr, policy) => `fix strikes exhausted (${pr.priorStrikes}/${policy.strikeCap}) — escalating`,
  },
  {
    disposition: "blocked-fixable",
    when: (pr) => pr.reviewState === "failure" && pr.unmetCriteria.length > 0,
    reason: (pr, policy) =>
      `${pr.unmetCriteria.length} unmet criteri${pr.unmetCriteria.length === 1 ? "on" : "a"} — strike ${pr.priorStrikes + 1}/${policy.strikeCap}`,
  },
  {
    disposition: "blocked-ambiguous",
    when: (pr) => pr.reviewState === "failure",
    reason: () => "review failing with no actionable unmet criteria (contradictory) — escalating",
  },
  {
    // W1-T100 (the #170 fix): blocked_ci is POSITIVELY fixable — never the
    // terminal catch-all's escalate. The exhausted case already matched row 4
    // above (this row is ordered after it), so only a non-exhausted checks-red/
    // review-none PR reaches here — fix FIRST, ask only after exhaustion.
    disposition: "blocked-fixable",
    when: (pr) => isBlockedCi(pr),
    reason: (pr, policy) =>
      `required checks red, no review posted yet — ci-log fix, strike ${pr.priorStrikes + 1}/${policy.strikeCap}`,
  },
  {
    // POSITIVE MATCH ONLY (the #161 fix, W1-T93): mergeable is NEVER inferred
    // from the mere absence of a failure — it requires required-checks green AND
    // review success, named explicitly (P22's own words: "required contexts
    // green, review success, unmerged").
    disposition: "mergeable",
    when: (pr) => pr.checksState === "green" && pr.reviewState === "success",
    reason: () => "review success, required checks green — arming auto-merge",
  },
  {
    // TERMINAL rule (matches unconditionally) — the LEAST permissive disposition
    // (the #161 fix, W1-T93), not the most permissive one. A checks-red PR with
    // NO review yet is the blocked_ci shape and is caught by row 6b above (W1-T100)
    // — never lands here. Anything ELSE not positively mergeable and not
    // failure-shaped (e.g. checks/review still pending) matches no earlier rule
    // and no longer falls through to mergeable by default: it lands here and
    // ESCALATES, naming the observed state, so it is never silent and never armed.
    disposition: "blocked-ambiguous",
    when: () => true,
    reason: (pr) =>
      `not positively mergeable — checks ${pr.checksState}, review ${pr.reviewState} — escalating`,
  },
];

/**
 * Derive ONE open PR's disposition from observed state + policy — PURE, TOTAL,
 * deterministic (rule 2: policy-as-data, never LLM-classified). This function
 * holds NO disposition branches: it computes the one derived scalar the table
 * needs (the PR's age in days) and returns the first {@link DISPOSITION_RULES}
 * row whose predicate matches. The mapping from state to disposition is entirely
 * in the data table.
 */
export function deriveDisposition(
  pr: OpenPrView,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
  now: number = Date.now(),
): DispositionResult {
  const parsed = Date.parse(pr.lastActivityAt);
  const ageDays = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : (now - parsed) / MS_PER_DAY;
  const rule = DISPOSITION_RULES.find((r) => r.when(pr, policy, ageDays));
  if (!rule) {
    // UNREACHABLE — the terminal row matches unconditionally. This guards the
    // no-disposition=none invariant against a future table edit that drops it.
    // The safe fallback is the LEAST permissive disposition — escalate, never arm.
    return { disposition: "blocked-ambiguous", reason: "default (no rule matched) — escalating" };
  }
  return { disposition: rule.disposition, reason: rule.reason(pr, policy, ageDays) };
}

// ────────────────────────────────────────────────────────────────────────────
// W1-T78 — the CLARIFICATION-QUESTION rung (ratifies P22's new rung): an
// ambiguous (BLOCKED-AMBIGUOUS) block yields a SPECIFIC, decidable operator
// question, never silence. `renderClarificationQuestion` is PURE and
// deterministic — it renders ONLY from what the sweep/ledger observed (the
// unmet criterion's claim/proof/reason already carried on {@link OpenPrView},
// plus the per-strike ledger history) and never invents a criterion or a
// resolution that was not itself observed. Emitted per the §2 QUESTION
// contract's shape ({@link toQuestionEntry}, matching worker.ts's
// `QuestionEntry`) — extended with the PR/run context and exactly two
// candidate resolutions a plain QUESTION does not carry — to the durable
// question backlog, with W1-T8's `escalate()` as the notification transport
// (both wired in run-task.ts's `buildSweepEffects`, the real gateway).
// ────────────────────────────────────────────────────────────────────────────

/**
 * One recorded fix-rung strike's outcome for a task, ledger ground truth ONLY
 * — "what the fix worker tried" (never inferred, never guessed). Derived from
 * `fix.dispatch`/`fix.review` ledger lines by run-task.ts's `deriveStrikeHistory`.
 */
export interface StrikeAttempt {
  strike: number;
  round: "resume" | "fresh";
  /** Unmet criteria count going INTO this strike. */
  unmetCount: number;
  /** Whether CI reached green after this strike (a review only runs once it does). */
  ciGreen: boolean;
  /** The review verdict AFTER this strike, if one ran. */
  reviewState?: "success" | "failure";
}

/** One of exactly two candidate resolutions the operator can pick between. */
export interface ClarificationResolution {
  label: string;
  detail: string;
}

/**
 * The rendered output of the CLARIFICATION-QUESTION rung for ONE
 * BLOCKED-AMBIGUOUS PR: the exact decision, both candidate resolutions, and
 * the run/PR context — never a generic needs-human.
 */
export interface ClarificationQuestion {
  taskId: string;
  prNumber: number;
  prUrl: string;
  /** The single, specific decision the operator must make. */
  question: string;
  /** The unmet criterion's claim text driving the block ("" for the contradictory/terminal rows — no single criterion to point at). */
  criterion: string;
  /** The reviewer's stated unmet reason, verbatim (or the disposition reason, when there is no single criterion). */
  reviewerRequirement: string;
  /** The acceptance criterion's own proof text — the spec the reviewer is judging against ("" when there is no single criterion). */
  specText: string;
  /** What each fix-rung strike tried and its outcome, ledger ground truth (§ StrikeAttempt). */
  strikeHistory: StrikeAttempt[];
  /** Exactly two candidate resolutions — never a silent guess, never more than two. */
  resolutions: readonly [ClarificationResolution, ClarificationResolution];
}

/**
 * Render ONE blocked-ambiguous PR's clarification question, deterministically,
 * from ledger ground truth ONLY: the task id, the unmet criterion (claim vs
 * the reviewer's stated requirement vs the spec's own proof text), and what
 * the fix worker already tried per strike. PURE — no guessing: when there is
 * no single unmet criterion to point at (the contradictory-criteria row or the
 * terminal catch-all), the question names the observed disposition `reason`
 * instead of inventing one, but it is NEVER silent either way.
 */
export function renderClarificationQuestion(
  pr: OpenPrView,
  reason: string,
  strikeHistory: StrikeAttempt[] = [],
): ClarificationQuestion {
  const primary = pr.unmetCriteria[0];
  const criterion = primary?.claim ?? "";
  const reviewerRequirement = primary?.reason ?? reason;
  const specText = primary?.proof ?? "";

  const tried = strikeHistory.length
    ? strikeHistory
        .map(
          (s) =>
            `strike ${s.strike} (${s.round}): ${s.unmetCount} unmet criteri${s.unmetCount === 1 ? "on" : "a"} going in, ` +
            `CI ${s.ciGreen ? "went green" : "did not go green"}` +
            (s.reviewState ? `, review came back ${s.reviewState}` : ""),
        )
        .join("; ")
    : "no fix-rung strike is recorded for this PR";

  const resolutions: readonly [ClarificationResolution, ClarificationResolution] = [
    {
      label: "re-dispatch-with-constraint",
      detail:
        "re-arm the W1-T76 fix rung on the same branch, carrying the operator's answer as an added " +
        "constraint on the next prompt (strike-counter reset is config policy).",
    },
    {
      label: "revise-spec",
      detail:
        "the acceptance criterion's own spec text is wrong or unattainable as written — file a task-edit " +
        "PROPOSAL (a plan-only PR); the rung itself never self-edits tasks.yaml (rule 15).",
    },
  ];

  // Shared by both branches below (single source of the "name both options"
  // suffix — editing the resolutions never requires editing this text twice).
  const decisionSuffix = `Which is right — (1) ${resolutions[0].label}: ${resolutions[0].detail}, or (2) ${resolutions[1].label}: ${resolutions[1].detail}`;

  const question = criterion
    ? `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): after ${strikeHistory.length} fix strike(s) — ${tried} — ` +
      `"${criterion}" is still unmet. The reviewer requires: "${reviewerRequirement}". The spec's own proof text says: ` +
      `"${specText}". ${decisionSuffix}`
    : `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): ${reason} — ${tried}. There is no single actionable unmet ` +
      `criterion to point at. ${decisionSuffix}`;

  return {
    taskId: pr.taskId ?? "UNKNOWN",
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    question,
    criterion,
    reviewerRequirement,
    specText,
    strikeHistory,
    resolutions,
  };
}

/**
 * Render a {@link ClarificationQuestion} into the §2 QUESTION contract's own
 * shape (worker.ts's `QuestionEntry`) for the durable question backlog —
 * `current_assumption` names what stays true while the PR is unanswered (it
 * never proceeds on a guess; it stays blocked), matching the contract's own
 * "the worker proceeds on this" framing.
 */
export function toQuestionEntry(q: ClarificationQuestion, ts: string): QuestionEntry {
  return {
    ts,
    task: q.taskId,
    question: q.question,
    current_assumption: `PR #${q.prNumber} (${q.prUrl}) stays BLOCKED-AMBIGUOUS — unmerged, no further fix strikes dispatched — until the operator answers.`,
    impact_if_wrong: "med",
  };
}

/**
 * The ADDITIONAL strikes an operator's clarification answer grants — PURE,
 * table-free (the policy has exactly one lever today; a second lever is a
 * field on {@link ClarifyPolicy}, never a branch here). Two uses, ONE number:
 * (1) it IS the fresh `strikeCap` the real re-dispatch passes to `runFixRung`
 * (which always counts a NEW call from 0), and (2) `DISPOSITION_RULES`' answer
 * row adds it to `policy.strikeCap` to get the cumulative ledger ceiling an
 * answered PR is allowed to reach before it escalates again — never an
 * unconditional bypass of the running strike count.
 */
export function strikeCapForAnswer(originalCap: number, policy: ClarifyPolicy = DEFAULT_CLARIFY_POLICY): number {
  return policy.resetStrikeCounterOnAnswer ? originalCap : 1;
}

/**
 * The block evidence `dispatchFix` carries — GENERALIZED (W1-T100, the #170
 * fix) from a bare reviewer-unmet array to the W1-T94 mode-evidence shape, so
 * a checks-red/review-none PR's dispatch carries ci-log input instead of an
 * always-empty unmet array. Exactly one field is meaningful per disposition
 * (mirrors run-task.ts's `FixEvidence`, the fix rung's own mode-input shape):
 * `unmetCriteria` for a failing review (blocked-fixable via review, W1-T76
 * unchanged), `ciFailures` for a checks-red/review-none PR (blocked-fixable
 * via ci-log, W1-T94/W1-T100).
 */
export interface FixDispatchEvidence {
  unmetCriteria: CriterionVerdict[];
  ciFailures?: CiFailure[];
}

/** Injected effects — the real command wires arm/close/fix/escalate; tests fake them. */
export interface SweepDeps {
  /** Arm GitHub auto-merge (armAutoMerge). Idempotent at the GitHub level. */
  arm: (pr: OpenPrView) => void | Promise<void>;
  /** Close a superseded/abandoned PR with a stated reason. */
  close: (pr: OpenPrView, reason: string) => void | Promise<void>;
  /**
   * Dispatch the W1-T76 fix rung carrying the mode-appropriate evidence at
   * once (W1-T94/W1-T100) — the FULL unmet set for a review-mode dispatch, or
   * ci-log evidence (failing check names + log tails) for a blocked_ci
   * dispatch. See {@link FixDispatchEvidence}.
   */
  dispatchFix: (pr: OpenPrView, evidence: FixDispatchEvidence) => void | Promise<void>;
  /**
   * Escalate a BLOCKED-AMBIGUOUS PR. `question` is the rung's rendered
   * {@link ClarificationQuestion} (W1-T78) — the real wiring logs it to the §2
   * question backlog AND uses W1-T8's `escalate()` as the notification
   * transport, carrying the SAME two candidate resolutions as its options.
   */
  escalate: (pr: OpenPrView, reason: string, question: ClarificationQuestion) => void | Promise<void>;
  /** Absolute path to state/ledger.ndjson — dedup source + sweep.disposed sink. */
  ledgerPath: string;
  /** The sweep's run id (e.g. SWEEP-<epochMs> / DAEMON-<epochMs>). */
  runId: string;
  /** Ledger reader (dedup); defaults to readLedgerLines. Injectable for tests. */
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  /** Ledger appender; defaults to appendLedger. Injectable for tests. */
  appendLine?: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void;
  /** Injected clock for the stale window (default Date.now). */
  now?: () => number;
  /** One console/ledger-adjacent line per disposition (optional). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /**
   * Preview only: derive dispositions, take NO effects, write NO ledger lines.
   * Returns the same summary shape so `rmd sweep --dry-run` can print the plan.
   */
  dryRun?: boolean;
}

/** What one PR's reconciliation did this sweep. */
export interface SweepAction {
  prNumber: number;
  prUrl: string;
  taskId?: string;
  disposition: Disposition;
  reason: string;
  /** True ⇒ the gated effect actually fired; false ⇒ deduped (already true). */
  acted: boolean;
  /** Set only for `blocked-ambiguous` (W1-T78) — the rendered clarification question. */
  question?: ClarificationQuestion;
}

/** The whole sweep's outcome — counts per disposition + the per-PR actions. */
export interface SweepSummary {
  /** Total open PRs reconciled. */
  total: number;
  /** How many PRs landed in each disposition (every PR is counted exactly once). */
  byDisposition: Record<Disposition, number>;
  /** How many gated effects actually fired (deduped ones are excluded). */
  actionsTaken: number;
  /** Per-PR detail, in input order. */
  actions: SweepAction[];
  /** INVARIANT proof: PRs that derived no disposition — MUST be 0. */
  noneCount: number;
}

/** Prior actions this ledger already recorded (acted:true), for idempotence dedup. */
interface PriorActions {
  armed: Set<number>;
  /** `${prNumber}@${headSha}` — fix dispatch is head-keyed. */
  fixed: Set<string>;
  closed: Set<number>;
  escalated: Set<number>;
}

function priorActionsFromLedger(lines: Array<Record<string, unknown>>): PriorActions {
  const armed = new Set<number>();
  const fixed = new Set<string>();
  const closed = new Set<number>();
  const escalated = new Set<number>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const pr = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (pr === undefined) continue;
    switch (line.disposition) {
      case "mergeable":
        armed.add(pr);
        break;
      case "blocked-fixable":
        fixed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        break;
      case "stale":
        closed.add(pr);
        break;
      case "blocked-ambiguous":
        escalated.add(pr);
        break;
    }
  }
  return { armed, fixed, closed, escalated };
}

const ZERO_COUNTS = (): Record<Disposition, number> => ({
  mergeable: 0,
  "blocked-fixable": 0,
  stale: 0,
  "blocked-ambiguous": 0,
});

/**
 * THE SHARED ENTRY POINT (acceptance 4): BOTH `rmd sweep` and the daemon poll
 * loop call this ONE function. Re-derives every open PR's disposition fresh, takes
 * the ONE gated action per PR (deduped against prior actions for idempotence),
 * writes one `sweep.disposed` ledger line per PR, and returns a summary both
 * callers can log.
 */
export async function runSweep(
  openPrs: OpenPrView[],
  deps: SweepDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<SweepSummary> {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log ?? (() => {});

  // Dedup is keyed on the ledger (it persists across sweeps even when the input
  // is byte-identical) — the level-triggered idempotence mechanism.
  const prior = priorActionsFromLedger(readLedger(deps.ledgerPath));

  const byDisposition = ZERO_COUNTS();
  const actions: SweepAction[] = [];
  let actionsTaken = 0;
  let noneCount = 0;

  for (const pr of openPrs) {
    const { disposition, reason } = deriveDisposition(pr, policy, now);
    byDisposition[disposition]++;

    // W1-T78: render the clarification question up front for blocked-ambiguous
    // PRs — it is ledgered EVERY sweep (so an unanswered question stays
    // visible), even on a deduped sweep where `escalate` itself does not fire.
    const question =
      disposition === "blocked-ambiguous" ? renderClarificationQuestion(pr, reason, pr.strikeHistory ?? []) : undefined;

    // Is this action already true (deduped)? Keyed per disposition.
    let alreadyDone: boolean;
    switch (disposition) {
      case "mergeable":
        alreadyDone = pr.autoMergeArmed || prior.armed.has(pr.prNumber);
        break;
      case "blocked-fixable":
        alreadyDone = prior.fixed.has(`${pr.prNumber}@${pr.headSha}`);
        break;
      case "stale":
        alreadyDone = prior.closed.has(pr.prNumber);
        break;
      case "blocked-ambiguous":
        alreadyDone = prior.escalated.has(pr.prNumber);
        break;
      default:
        alreadyDone = false;
    }

    const acted = !alreadyDone && !deps.dryRun;

    if (acted) {
      switch (disposition) {
        case "mergeable":
          await deps.arm(pr);
          break;
        case "blocked-fixable":
          // W1-T100: the evidence shape follows the SAME `isBlockedCi`
          // predicate DISPOSITION_RULES routed on (never a second,
          // independently-hardcoded check) — a failing review carries the
          // unmet set (review mode), a blocked_ci PR carries ci-log evidence
          // instead (never a mix; see FixDispatchEvidence).
          await deps.dispatchFix(
            pr,
            isBlockedCi(pr)
              ? { unmetCriteria: [], ciFailures: pr.ciFailures ?? [] }
              : { unmetCriteria: pr.unmetCriteria },
          );
          break;
        case "stale":
          await deps.close(pr, reason);
          break;
        case "blocked-ambiguous":
          await deps.escalate(pr, reason, question!);
          break;
      }
      actionsTaken++;
    }

    actions.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      taskId: pr.taskId,
      disposition,
      reason,
      acted,
      question,
    });

    log("sweep.dispose", {
      pr_number: pr.prNumber,
      disposition,
      acted,
      reason,
      deduped: alreadyDone,
    });

    // One ledger line per disposition (the INVARIANT). Skipped under --dry-run —
    // a preview must leave no trace, so a real run afterward still acts. The
    // rendered question rides along whenever one exists (W1-T78) — an
    // UNANSWERED question stays ledgered on every subsequent sweep, even once
    // `acted` goes false (deduped: no repeat escalate()).
    if (!deps.dryRun) {
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: pr.taskId ?? "SWEEP",
        step: "sweep.disposed",
        pr_number: pr.prNumber,
        pr_url: pr.prUrl,
        disposition,
        acted,
        reason,
        head_sha: pr.headSha,
        ...(question ? { question: question.question } : {}),
      });
    }
  }

  const summary: SweepSummary = {
    total: openPrs.length,
    byDisposition,
    actionsTaken,
    actions,
    noneCount,
  };
  log("sweep.summary", { ...summary.byDisposition, total: summary.total, actions_taken: actionsTaken });
  return summary;
}

/** One-line human render of a sweep summary, for both callers' console output. */
export function renderSweepSummary(s: SweepSummary): string {
  const b = s.byDisposition;
  return (
    `sweep: ${s.total} open PR(s) · ${s.actionsTaken} action(s) taken · ` +
    `mergeable ${b.mergeable} · blocked-fixable ${b["blocked-fixable"]} · ` +
    `stale ${b.stale} · blocked-ambiguous ${b["blocked-ambiguous"]}` +
    (s.noneCount > 0 ? ` · ⚠️ ${s.noneCount} UNDISPOSED (invariant violated)` : "")
  );
}
