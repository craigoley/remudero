import { appendLedger } from "./ledger.js";
import { readLedgerLines } from "./status.js";
import { cappedOverrideFromLedger, decideAutoMergeArm, postedArmFactsFromLedger } from "./review.js";
import type { ArmDecision, CriterionVerdict } from "./review.js";
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
 * Every open PR gets EXACTLY ONE of seven dispositions and its gated action:
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
 *   - BLOCKED-FIXABLE  — EITHER (a) a required check is red — the blocked_ci shape,
 *                        the #170 fix (W1-T100), BROADENED by W1-T138 (the
 *                        #303/#305/#292/#315 fix) to fire regardless of the review
 *                        verdict sitting beside it (a review can post, then a
 *                        slower required check settle red; a fix strike's own
 *                        push can newly break one) — and strikes left -> dispatch
 *                        the W1-T76 fix rung in ci-log mode (W1-T94), carrying the
 *                        failing check names + log tails, CHECKED FIRST, before a
 *                        review verdict is ever classified as the block; OR (b) —
 *                        only once checks are NOT red — a failing review with
 *                        actionable unmet criteria and strikes left -> dispatch
 *                        the SAME rung (reused, not reimplemented) carrying the
 *                        FULL unmet set at once. FIX FIRST, ask after exhaustion: a
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
 *   - WAIT             — (W1-T114, the 30-issue predicate-storm fix) required
 *                        checks pending/queued AND the newest check's start is
 *                        younger than a staleness ceiling (policy-as-data,
 *                        {@link SweepPolicy.pendingCeilingMinutes}) -> no action
 *                        this pass, a ledgered wait line, re-derived fresh next
 *                        sweep. Pending is TIME, not ambiguity — escalating on it
 *                        manufactured alert fatigue at machine speed (~24 of 30
 *                        live needs-human issues, 2026-07-19, were exactly this
 *                        shape). Ceiling EXCEEDED -> stale-pending, the SAME
 *                        blocked-ambiguous escalate path below, its reason naming
 *                        the elapsed minutes and the ceiling — a check stuck past
 *                        the ceiling IS ambiguity.
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

/** One of the dispositions every open PR is reconciled into. */
export type Disposition =
  | "mergeable"
  | "blocked-fixable"
  | "stale"
  | "blocked-ambiguous"
  | "dep-review"
  | "post-review"
  | "conflicted"
  | "wait";

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
 * GitHub's own `mergeStateStatus`, simplified to what the sweep needs (W1-T106,
 * the #170 DIRTY strand): a stuck PR sat review-PASS, all-checks-SUCCESS, and
 * unmergeable for hours at `mergeStateStatus` DIRTY — invisible to every
 * disposition rule because conflict state was not an {@link OpenPrView} input at
 * all. `"dirty"` is a real merge conflict; `"behind"` is deliberately OUT OF
 * SCOPE (design note iv) — auto-merge already handles a behind-but-clean PR on
 * its own. `"unknown"` is the fail-closed default for anything else (BLOCKED,
 * DRAFT, HAS_HOOKS, UNSTABLE, an unrecognized value, or an unreadable read) —
 * never manufactured into a false "clean".
 */
export type MergeState = "clean" | "dirty" | "behind" | "unknown";

/**
 * One conflicting file's line-delta on EACH side since the merge-base — the
 * deterministic signal {@link isPureConcurrentAddition} classifies on. Counting
 * only DELETIONS (never additions) is deliberate: two sides that both only
 * ADD content can conflict textually (e.g. both appended an entry to the same
 * list) yet resolve safely to their union; a side that DELETED something is
 * the case the rung must never silently clobber (rationale: "union is
 * resolution, not clobber").
 */
export interface ConflictFileDiff {
  path: string;
  /** Lines this PR's OWN branch removed in this file since the merge-base. */
  oursDeleted: number;
  /** Lines the target branch (origin/main) removed in this file since the merge-base. */
  theirsDeleted: number;
}

/**
 * The merge-conflict fix mode's ONLY input (W1-T94's mode table gains
 * merge-conflict, design note iii): the conflicting file list plus BOTH
 * sides' log since the merge-base, so the dispatched fix worker can perform
 * the SAME hand-resolution procedure the #170 incident demonstrated — merge
 * (never rebase-force), union ONLY where the diffs below show pure
 * concurrent addition, refuse into escalate otherwise.
 */
export interface MergeConflictEvidence {
  files: ConflictFileDiff[];
  /** `git log <merge-base>..<branch>` on this PR's own head, one line per commit. */
  oursLog: string;
  /** `git log <merge-base>..origin/main`, the same shape for the target side. */
  theirsLog: string;
}

/**
 * PURE, DETERMINISTIC classification (rule 2 — never an LLM judgment call) of
 * whether a merge conflict is safe to auto-resolve toward the union of both
 * sides: every conflicting file must show ZERO deletions on BOTH sides since
 * the merge-base. A single deleted line on either side — or no file evidence
 * at all (an unreadable/uncaptured diff) — fails CLOSED to `false`: a wrong
 * auto-resolution is worse than a strand (design note iii, verbatim).
 */
export function isPureConcurrentAddition(files: readonly ConflictFileDiff[]): boolean {
  return files.length > 0 && files.every((f) => f.oursDeleted === 0 && f.theirsDeleted === 0);
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
  /**
   * W1-T121 QUEUE GOVERNOR (the 23-open-PR incident) — a WIP limit on
   * DISPATCH ONLY: at or above this many open PRs, dispatch of NEW tasks is
   * deferred; drainage (sweep/heal/arm/merge, at ANY depth) is never gated.
   * A ROW in this table, not a constant near a call site — see
   * {@link checkQueueGovernor}, this policy's consumer.
   */
  wipLimit: number;
  /**
   * W1-T172 PARALLEL DISPATCH (P19, DECISIONS.md 2026-07-21) — the number of
   * concurrent dispatch LANES a drain pass may fill, bounded by `wipLimit`
   * above (the governor is the CEILING; lanes only raise the RATE it fills,
   * never the bound). A ROW in THIS SAME table — one threshold home, never a
   * second — see `laneDispatchBudget` (drain.ts), this row's consumer.
   * Started at 2 deliberately: the WS-2 concurrent-keychain question is
   * unvalidated and per-repo merge serialization is server-side auto-merge
   * rather than a queue of our own. Raising N is a policy-data row edit, not
   * a code change — the point of holding it here rather than as a constant.
   */
  dispatchLanes: number;
  /**
   * W1-T148 COST GOVERNOR (the $206/60-run W1-T1 spin-loop incident) — a DAILY
   * spend ceiling, in notional USD, on DISPATCH ONLY: at or over this many
   * ledgered dollars spent so far TODAY, NEW dispatch is deferred; drainage
   * (sweep/heal/arm/merge, at ANY depth) is never gated by it — a half-finished
   * PR must still merge, a block must still escalate, and stranding in-flight
   * work to save money is a worse failure than the spend itself. A ROW in this
   * table (rule 2, policy-as-data), never a constant near a dispatch call site
   * — see {@link checkCostGovernor}, this policy's consumer. Distinct from
   * `budget_usd`/`DEFAULT_BUDGET_USD` (run-task.ts), the PER-RUN hard cap on a
   * single worker spawn: this is the CROSS-RUN, daily total the per-run cap
   * cannot see (60 runs each safely under their own per-run cap is exactly how
   * the $206 incident accumulated).
   */
  dailyCostCeilingUsd: number;
  /**
   * W1-T114 (the 30-issue predicate-storm fix) — the STALENESS CEILING for the
   * WAIT disposition: required checks pending/queued with the newest check's
   * start younger than this many minutes -> wait, no action; at or beyond it
   * -> stale-pending, the escalate path. A ROW in this table (rule 2,
   * policy-as-data), not a constant buried in the predicate — a fixture proves
   * this by lowering the seeded ceiling and flipping a wait to an escalate with
   * ZERO code changes. Default generous enough for the slowest required check
   * to register and settle (an hour) — a check still pending PAST that IS
   * ambiguity, not merely in-flight.
   */
  pendingCeilingMinutes: number;
}

/**
 * The default policy — 14-day stale window, 2 fix strikes (mirrors
 * fixStrikeCap), 10-PR WIP limit, 2 dispatch lanes (W1-T172, start N=2),
 * 60-minute pending ceiling, $150/day cost ceiling. The $150 default is a
 * SAFE, fail-closed guess (rule 2: an absent policy value falls back to a
 * bounded default, never unbounded spend) — well under the $206/60-run W1-T1
 * incident it exists to catch, while generous enough that ordinary
 * single-day operation (well under DEFAULT_BUDGET_USD's $100 per-run cap,
 * run once or twice) does not trip it by accident.
 */
export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  staleDays: 14,
  strikeCap: 2,
  clarify: DEFAULT_CLARIFY_POLICY,
  wipLimit: 10,
  dispatchLanes: 2,
  dailyCostCeilingUsd: 150,
  pendingCeilingMinutes: 60,
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
  /**
   * W1-T114: ISO-8601 timestamp of the NEWEST required check's start on this
   * head — the WAIT disposition's only time input, populated when
   * `checksState === "pending"` (undefined/unparseable otherwise, including
   * when the real gateway has not been wired to surface it yet). Absent ⇒ the
   * WAIT/stale-pending rows never match (fail toward the pre-existing
   * catch-all escalate, never a silent indefinite wait on state we can't date).
   */
  checksPendingSince?: string;
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
  /** Head ref starts with `dependabot/` — routed to the W1-T54 dep-review lane
   * (its own deterministic judge), NEVER the fix rung (which would push commits
   * onto a Dependabot branch) and never the clarification rung. */
  isDependabot?: boolean;
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
   * GitHub's own merge-conflict state, simplified (W1-T106, the #170 DIRTY
   * strand) — see {@link MergeState}'s own doc. `undefined`/`"unknown"` never
   * disposition CONFLICTED (fail-closed): only an OBSERVED `"dirty"` does.
   */
  mergeState?: MergeState;
  /**
   * The merge-conflict fix mode's input — the conflicting file list + both
   * sides' log since merge-base (W1-T94's new mode, design note iii).
   * Populated when `mergeState === "dirty"`; `undefined` otherwise (mirrors
   * how `ciFailures` is populated only when `checksState === "red"`).
   */
  mergeConflict?: MergeConflictEvidence;
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
 * The blocked_ci shape (the #170 fix, W1-T100; BROADENED by W1-T138, the
 * #303/#305/#292/#315 fix): a required check is red — the failing signal IS
 * the CI log, never a reviewer verdict, and it takes PRECEDENCE over any
 * review verdict sitting beside it, because GitHub will not merge past a red
 * required check no matter what the review says. W1-T100 originally required
 * `reviewState === "none"` too (only "no review has posted at all" counted),
 * but that is provably too narrow: a review can post (success OR failure)
 * and a required check can STILL be, or subsequently go, red — (1)
 * `ciGateFromRollup` (the live gate `waitForCiGreen` polls) only waits for a
 * check literally named `ci` plus "nothing red YET"; a slower required check
 * (commitlint, CodeQL, osv) can still be pending when it fires green and let
 * review run BEFORE that slower check settles red; (2) a fix-rung strike's
 * OWN commit can newly break a required check (a too-long commit header trips
 * commitlint; an edited regex trips CodeQL) while leaving a STALE review
 * verdict computed before that push sitting in the rollup. Both produced the
 * live incident this fix closes: `unmetCriteria`-shaped (reviewer-unmet)
 * dispatches burned every strike re-litigating a review verdict while the
 * ACTUAL merge-blocking check sat untouched, then escalated as "blocked_review
 * fix rung exhausted" naming criteria instead of the check. EXPORTED (not
 * just shared across this table's own rows) so every OTHER caller that needs
 * the same classification — `routeFix`'s strike-cap-honored escalate check
 * and its evidence-shape selection, `runSweep`'s evidence-shape selection,
 * `runFixRung`'s own mid-rung mode re-check — imports this ONE definition
 * rather than hand-copying the check, which would silently drift the moment
 * this predicate is refined again.
 */
export function isBlockedCi(pr: OpenPrView): boolean {
  return pr.checksState === "red";
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
  /**
   * Observed-state predicate over the PR + the tunable {@link SweepPolicy}
   * thresholds. `now` (W1-T114) is the same sweep-pass clock {@link ageDays}
   * was derived from — threaded so the WAIT/stale-pending rows can derive the
   * PENDING age from {@link OpenPrView.checksPendingSince} without a second,
   * independently-sourced clock.
   */
  readonly when: (pr: OpenPrView, policy: SweepPolicy, ageDays: number, now: number) => boolean;
  readonly reason: (pr: OpenPrView, policy: SweepPolicy, ageDays: number, now: number) => string;
}

/**
 * W1-T114: how many minutes the newest required check has been pending on
 * this head, or undefined when there is nothing to date — no
 * `checksPendingSince` at all (the real gateway not yet wired, or checks
 * aren't pending), or an unparseable timestamp. PURE, fail-toward-undefined:
 * never guesses an age it cannot support from observed state.
 */
function pendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  if (!pr.checksPendingSince) return undefined;
  const parsed = Date.parse(pr.checksPendingSince);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
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
 *      blocked_ci shape (checks red) — ci-log strikes share the SAME counter and
 *      cap as review strikes, one ladder, one exhaustion route (design note iv).
 *      Ordered ahead of row 5 below so an exhausted blocked_ci PR escalates
 *      rather than re-matching the positive fixable row forever.
 *   5. blocked_ci (W1-T100, the #170 fix; BROADENED by W1-T138, the
 *      #303/#305/#292/#315 fix): a required check is red, strikes left (row 4
 *      above already routed the exhausted case) -> blocked-fixable, dispatching
 *      the SAME W1-T76 rung in ci-log mode (W1-T94) — failing check names + log
 *      tails, never a reviewer verdict. ORDERED BEFORE rows 6/7 (review-shaped)
 *      DELIBERATELY (the W1-T138 fix): a red required check is checked FIRST,
 *      before ever classifying a block as reviewer-unmet — GitHub will not merge
 *      past a red required check no matter what the review says, and a review
 *      verdict sitting beside a red check may be STALE (computed before the
 *      push that broke the check, or before a slower required check settled) —
 *      so it is never the right thing to re-litigate first. This also means a PR
 *      can be BOTH checks-red AND review-failing at once; ci-log wins, and once
 *      the check goes green a fresh review runs and rows 6/7 take over from
 *      there if IT still fails. FIX FIRST: this PR reaches the question rung
 *      (row 11) only by exhausting the ladder through row 4, never straight here.
 *   6. FAILING + actionable unmet criteria, strikes left -> blocked-fixable (fix rung).
 *      Only reached with checks NOT red (row 5 above already claimed that case).
 *   7. FAILING + no actionable criteria (contradictory)  -> blocked-ambiguous (escalate).
 *   7.5. CONFLICTED (W1-T106, the #170 DIRTY strand): `mergeState === "dirty"`
 *      — ABOVE mergeable, so a conflicting PR is NEVER armed no matter how
 *      green. Two rows, in order: (a) a PURE-concurrent-addition conflict
 *      (isPureConcurrentAddition) -> `conflicted`, dispatching the W1-T94
 *      merge-conflict fix mode; (b) anything else dirty (a deletion-involved
 *      or unclassifiable conflict) -> `blocked-ambiguous`, REFUSING
 *      auto-resolution and escalating instead — never a wrong clobber.
 *   8. CI GREEN + REVIEW SUCCESS (POSITIVE match only)   -> mergeable (arm).
 *   9. WAIT (W1-T114, the 30-issue predicate-storm fix): checks pending AND a
 *      datable, in-window newest-check-start (policy.pendingCeilingMinutes) ->
 *      wait — no action, ledgered, re-derived next sweep. Never reached when
 *      the review is FAILING (rows 4/6/7 above already claimed that) or checks
 *      are red (row 5 above). Undated pending (no `checksPendingSince`, e.g.
 *      the gateway not yet wired) never matches — falls through to row 11.
 *  10. STALE-PENDING (W1-T114): same predicate as row 9 but the ceiling is MET
 *      or EXCEEDED -> blocked-ambiguous, the SAME escalate path row 11 uses,
 *      reason naming the elapsed minutes and the ceiling — a check stuck past
 *      the ceiling IS ambiguity, unlike merely in-flight (row 9).
 *  11. TERMINAL catch-all (the #161 fix, W1-T93): anything not positively
 *      mergeable, not already failure-shaped, not the blocked_ci shape above,
 *      and not a DATABLE pending state (rows 9/10) — e.g. checks pending with
 *      no check-start to date, or review still pending with checks green/none
 *      already routed elsewhere — lands here: blocked-ambiguous (the
 *      CLARIFICATION-QUESTION rung, W1-T78), naming the observed checks/review
 *      state. The catch-all is the LEAST permissive disposition, never the
 *      most permissive one; mergeable is ONLY ever positively matched (row 8),
 *      never a fallback.
 *
 * Stale/superseded rows precede the failing/mergeable rows so tightening the
 * stale threshold flips an otherwise-mergeable PR to a close. Row 3 (answered)
 * precedes row 4 (strikes exhausted) so an answer's extended allowance actually
 * overrides exhaustion; rows 4-7 (blocked_ci / review FAILING) precede row 8 so
 * a CI-green-but-review-failing (or checks-red) PR still routes to fix/escalate,
 * not mergeable. Rows 9/10 (wait / stale-pending) are ordered AFTER every
 * failure/success row and BEFORE the row-11 catch-all so a genuinely-red or
 * review-failing PR never gets stranded waiting, and a datable pending PR is
 * never left to the catch-all's generic reason once W1-T114's ceiling can
 * speak to it directly.
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
    // W1-T54's dep lane, ROUTED (the 2026-07-22 #533/#534 stall): before this
    // row the sweep had NO Dependabot branch at all, so dep PRs sat ungated
    // until an operator ran `rmd dep-review` by hand — and the failure rows
    // below would misroute them (a ci-log fix rung must never push commits
    // onto a Dependabot branch). The lane itself holds on red checks and
    // escalates majors, so routing is safe in every checks/review state;
    // superseded/stale above still close first.
    disposition: "dep-review",
    when: (pr) => pr.isDependabot === true,
    reason: (pr) => `dependabot PR — dep-review lane (checks ${pr.checksState}, review ${pr.reviewState})`,
  },
  {
    // W1-T78: an operator's answer to a clarification question RE-ARMS the fix
    // rung — but only within its own (config-policy) strike allowance, never
    // unconditionally, so a bad answer still eventually escalates rather than
    // looping forever. W1-T100: generalized to the blocked_ci shape too (via
    // the SAME `isBlockedCi` row 4/5 share) — without this, a strike-exhausted
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
    // review AND a blocked_ci PR (checks red) — off the SAME strike counter/cap
    // (design note iv: one ladder, one exhaustion route).
    disposition: "blocked-ambiguous",
    when: (pr, policy) => (pr.reviewState === "failure" || isBlockedCi(pr)) && pr.priorStrikes >= policy.strikeCap,
    reason: (pr, policy) => `fix strikes exhausted (${pr.priorStrikes}/${policy.strikeCap}) — escalating`,
  },
  {
    // W1-T100 (the #170 fix); BROADENED + PROMOTED ahead of the review-failing
    // rows by W1-T138 (the #303/#305/#292/#315 fix — see the table doc above):
    // blocked_ci is POSITIVELY fixable — never the terminal catch-all's
    // escalate, and never re-litigated as a review-unmet block just because a
    // (possibly stale) review verdict also sits on this head. The exhausted
    // case already matched row 4 above (this row is ordered after it), so only
    // a non-exhausted checks-red PR reaches here — fix FIRST, ask only after
    // exhaustion.
    disposition: "blocked-fixable",
    when: (pr) => isBlockedCi(pr),
    reason: (pr, policy) => `required checks red — ci-log fix, strike ${pr.priorStrikes + 1}/${policy.strikeCap}`,
  },
  {
    // Reached only when checks are NOT red (row 5 above already claimed that
    // case) — a pure review-shaped block.
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
    // W1-T106 (the #170 DIRTY strand): CONFLICTED is a POSITIVE disposition,
    // ABOVE mergeable — a dirty PR is NEVER armed no matter how green its
    // checks or how successful its review (the #170 live incident: review
    // PASS, all checks SUCCESS, auto-merge armed, yet stuck DIRTY for hours).
    // Ordered here (after the review-failure rows, before mergeable) — none
    // of rows 3-7 above reference `mergeState`, so this placement changes
    // nothing about their precedence; it only guarantees row 8 (mergeable)
    // never sees a dirty PR. Deterministically fixable (rule 2, never an LLM
    // judgment call) ONLY when {@link isPureConcurrentAddition} clears every
    // conflicting file — both sides purely ADDED, neither deleted anything
    // the other still relies on. The deletion-involved / no-evidence-captured
    // case falls through to the very next row, never here.
    disposition: "conflicted",
    when: (pr) => pr.mergeState === "dirty" && isPureConcurrentAddition(pr.mergeConflict?.files ?? []),
    reason: (pr) =>
      `merge conflict (mergeState dirty) — pure concurrent addition on ` +
      `${(pr.mergeConflict?.files ?? []).map((f) => f.path).join(", ")} — dispatching the merge-conflict fix mode`,
  },
  {
    // W1-T106: the OTHER half of the same #170 strand — a dirty PR whose
    // conflict involves a DELETION on either side (or whose file evidence
    // could not be captured at all) is NEVER auto-resolved: "a wrong
    // auto-resolution is worse than a strand" (design note iii, verbatim).
    // REFUSE into escalate — the SAME blocked-ambiguous disposition/rung
    // every other ambiguous block already routes through (never a
    // reimplementation), naming the conflicting files so the operator does
    // not have to go re-derive them by hand.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.mergeState === "dirty",
    reason: (pr) => {
      const files = (pr.mergeConflict?.files ?? []).map((f) => f.path);
      return (
        `merge conflict (mergeState dirty) involves a deletion (or no file evidence was captured) — ` +
        `never auto-resolved — files: ${files.length > 0 ? files.join(", ") : "none captured"} — escalating`
      );
    },
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
    // POST-REVIEW ROUTING (the 2026-07-22 #584 stall): a checks-GREEN PR whose
    // remudero-review was never posted at all previously fell to the terminal
    // catch-all below and ESCALATED ("checks green, review none") — a hand-
    // opened PR could sit fully green forever with a needs-human issue as its
    // only disposition, because nothing ever invoked the review lane on it.
    // Route it to the SAME reviewCommand the operator verb runs (dedup per
    // head, like dep-review): the posted verdict then drives the NEXT pass —
    // success -> mergeable/arm, failure -> the fix/escalate rows. A PR with no
    // criteria (no trailer, no Acceptance block) posts FAIL fail-closed, which
    // is a LEGIBLE gate state rather than a clarification escalation.
    // Dependabot PRs never reach here (their own row above); checks-pending
    // stays with rows 9/10 below (W1-T114) when datable, the catch-all
    // otherwise (review-before-green is not the lane's order).
    disposition: "post-review",
    when: (pr) => pr.checksState === "green" && pr.reviewState === "none",
    reason: (pr) => `checks green, review never posted — running the review lane on #${pr.prNumber}`,
  },
  {
    // WAIT (W1-T114, the 30-issue predicate-storm fix, LIVE INCIDENT
    // 2026-07-19: ~24 of 30 open needs-human issues were exactly this shape —
    // "checks pending, review success — escalating"). Never reached with a
    // FAILING review or red checks (rows 4-7 above already claimed those) —
    // only checks-pending survives to here. Requires a DATABLE age
    // (`checksPendingSince` present and parseable); undated pending falls
    // through to row 11's catch-all unchanged (the pre-W1-T114 behavior, for
    // callers that haven't wired the timestamp yet).
    disposition: "wait",
    when: (pr, policy, _ageDays, now) => {
      if (pr.checksState !== "pending") return false;
      const mins = pendingAgeMinutes(pr, now);
      return mins !== undefined && mins < policy.pendingCeilingMinutes;
    },
    reason: (pr, policy, _ageDays, now) =>
      `checks pending ${Math.floor(pendingAgeMinutes(pr, now) ?? 0)}m (< ${policy.pendingCeilingMinutes}m ceiling) — waiting, re-deriving next sweep`,
  },
  {
    // STALE-PENDING (W1-T114): the SAME datable-pending shape as row 9 above,
    // but the ceiling is met or exceeded — a check stuck this long IS
    // ambiguity, not merely in-flight. Disposition is blocked-ambiguous, the
    // SAME escalate path row 11 uses (ledger dedup, clarification-question
    // rendering, escalate() dispatch — nothing new to wire), with the elapsed
    // minutes and the ceiling both named in the reason.
    disposition: "blocked-ambiguous",
    when: (pr, policy, _ageDays, now) => {
      if (pr.checksState !== "pending") return false;
      const mins = pendingAgeMinutes(pr, now);
      return mins !== undefined && mins >= policy.pendingCeilingMinutes;
    },
    reason: (pr, policy, _ageDays, now) =>
      `stale-pending — checks pending ${Math.floor(pendingAgeMinutes(pr, now) ?? 0)}m (>= ${policy.pendingCeilingMinutes}m ceiling) — escalating`,
  },
  {
    // TERMINAL rule (matches unconditionally) — the LEAST permissive disposition
    // (the #161 fix, W1-T93), not the most permissive one. A checks-red PR is
    // the blocked_ci shape and is caught by row 5 above (W1-T100/W1-T138); a
    // DATABLE checks-pending PR is caught by row 9/10 above (W1-T114) — neither
    // ever lands here. Anything ELSE not positively mergeable and not
    // failure-shaped (e.g. checks/review still pending with no datable
    // check-start) matches no earlier rule and no longer falls through to
    // mergeable by default: it lands here and ESCALATES, naming the observed
    // state, so it is never silent and never armed.
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
  const rule = DISPOSITION_RULES.find((r) => r.when(pr, policy, ageDays, now));
  if (!rule) {
    // UNREACHABLE — the terminal row matches unconditionally. This guards the
    // no-disposition=none invariant against a future table edit that drops it.
    // The safe fallback is the LEAST permissive disposition — escalate, never arm.
    return { disposition: "blocked-ambiguous", reason: "default (no rule matched) — escalating" };
  }
  return { disposition: rule.disposition, reason: rule.reason(pr, policy, ageDays, now) };
}

/**
 * ARMING PARITY WITH THE RUN FLOW — the fix for the gap run-task.ts named in its
 * own capped-refusal comment ("`sweep.ts`'s independent 'checks green + review
 * success -> mergeable' reconciliation does not yet consult `capped`/an
 * override — a PR this refuses stays OPEN and UNARMED, but a later sweep poll
 * could still arm it via that separate path").
 *
 * LIVE INSTANCE (2026-07-28): PR #800's verdict carried `capped: true` at
 * `proof_exec 0/5` — five `exec_error` proofs, nothing executed. The run flow
 * refused it. This reconciler armed it at 17:48:57Z and GitHub merged it 35
 * seconds later, unattended, with zero acceptance proofs ever executed.
 *
 * NOT A SECOND IMPLEMENTATION — that duplication is exactly how the two paths
 * drifted apart. This delegates to {@link decideAutoMergeArm}, the SAME pure
 * predicate `runTask`'s arming path calls, so the W1-T205 carve-out it already
 * encodes travels with it: a `planOnly` CAPPED verdict is STRUCTURALLY capped
 * (a plan PR files or amends a task; it has no code to run a proof against) and
 * STILL ARMS, with no operator override, or every retro/triage/plan/approve PR
 * in the system would stall. The one shape this takes away is the one the run
 * flow already refuses: capped, not plan-only, no ledgered operator override.
 *
 * `tddStrict` is passed `false` because W1-T229 removed it from the GATE — it
 * survives on {@link decideAutoMergeArm}'s signature purely for
 * `resolveAutoMergeArm`'s override-provenance bookkeeping, and never changes
 * which verdicts arm. The override is recovered head-bound from the SAME
 * `automerge.capped_override_granted` ledger line `runTask` reads
 * ({@link cappedOverrideFromLedger}), so an operator who unblocks a PR by hand
 * unblocks it for BOTH paths, not just the one they happened to be looking at.
 *
 * FAIL-OPEN ON ABSENT EVIDENCE (see {@link postedArmFactsFromLedger}): a head
 * with no recoverable ledgered verdict arms exactly as it did before this
 * function existed. Refusal requires positively observing `capped: true,
 * plan_only: false` for THIS head.
 */
export function decideSweepArm(pr: OpenPrView, ledgerLines: ReadonlyArray<Record<string, unknown>>): ArmDecision {
  const facts = postedArmFactsFromLedger(ledgerLines, pr.taskId, pr.headSha);
  if (!facts) {
    return { arm: true, reason: "no ledgered verdict recoverable for this head — arming as before (no evidence to refuse on)" };
  }
  const override =
    facts.capped && pr.taskId ? cappedOverrideFromLedger(ledgerLines, pr.taskId, pr.headSha) : undefined;
  return decideAutoMergeArm({ state: "success", capped: facts.capped, planOnly: facts.planOnly }, false, override);
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
 * a checks-red PR's dispatch carries ci-log input instead of an always-empty
 * unmet array. Exactly one field is meaningful per disposition (mirrors
 * run-task.ts's `FixEvidence`, the fix rung's own mode-input shape):
 * `unmetCriteria` for a failing review with checks NOT red (blocked-fixable
 * via review, W1-T76 unchanged), `ciFailures` for a checks-red PR — REGARDLESS
 * of what the review verdict beside it says, even a failing one (blocked-fixable
 * via ci-log, W1-T94/W1-T100, broadened by W1-T138 — see {@link isBlockedCi}).
 */
export interface FixDispatchEvidence {
  unmetCriteria: CriterionVerdict[];
  ciFailures?: CiFailure[];
  /** W1-T106: the merge-conflict fix mode's input — populated for a `conflicted` dispatch only. */
  mergeConflict?: MergeConflictEvidence;
}

/**
 * TERMINAL-STATE PREDICATE (W1-T177) — the ONE definition every spending site
 * (a fix-rung strike, a sweep disposition, the exhaustion escalation, the
 * cold-dispatch pre-flight) and the operator verb (`routeFix`) share, so a
 * merged/closed PR is refused IDENTICALLY everywhere rather than via
 * independently-hardcoded copies that drift (the #388/#398 fixture: the
 * interactive `rmd fix` path had this check inline; the unattended
 * sweep/rung/escalate paths did not, and spent a strike + a needs-human issue
 * + a fresh sweep rung on an already-merged PR within seven minutes). Only
 * `"OPEN"` carries a live block; anything else — MERGED, CLOSED, or an
 * unresolved/missing state — returns a human-legible stand-down reason.
 *
 * This function classifies a SUCCESSFULLY-READ state string ONLY. It is
 * never asked to guess about a failed/indeterminate read — every call site
 * that reads state live is responsible for its OWN fail-open direction (an
 * unreadable state must never be treated as terminal; see each site's
 * `ok:false` handling) before ever calling this predicate.
 */
export function terminalStateReason(state: string | undefined): string | undefined {
  if (state === "OPEN") return undefined;
  return `state is ${state ?? "UNKNOWN"} (only an OPEN PR carries a live block)`;
}

/**
 * One fresh, live read of a PR's GitHub state (W1-T177). `ok:false` marks a
 * genuinely FAILED or INDETERMINATE read (network/auth/rate-limit) — the
 * caller must treat that exactly as if no check ran at all, never as
 * terminal. `state` is present only when `ok`.
 */
export interface LiveStateResult {
  ok: boolean;
  state?: string;
}

/** Injected effects — the real command wires arm/close/fix/escalate; tests fake them. */
export interface SweepDeps {
  /** Arm GitHub auto-merge (armAutoMerge). Idempotent at the GitHub level. */
  arm: (pr: OpenPrView) => void | Promise<void>;
  /** Close a superseded/abandoned PR with a stated reason. */
  close: (pr: OpenPrView, reason: string) => void | Promise<void>;
  /**
   * Invoke the W1-T54 dep-review lane on a Dependabot PR and return its
   * DECISION ("arm" | "hold" | "escalate" | "refuse") so the disposed ledger
   * line records the outcome and dedup can distinguish TERMINAL outcomes
   * (arm/escalate/refuse — never re-run for the same head, or a major would
   * open a fresh escalation issue every poll) from "hold" (re-run next sweep:
   * a red check can go green on the SAME sha). Optional — omitted, the
   * disposition is ledgered with a stand-down note and nothing runs.
   */
  depReview?: (pr: OpenPrView) => string | void | Promise<string | void>;
  /**
   * Invoke the review lane (reviewCommand) on a checks-green PR whose
   * remudero-review was never posted (the post-review disposition). Posted
   * verdicts are per-head, so dedup is unconditional per `pr@head` — a fresh
   * push mints a new head and re-routes naturally. Optional — omitted, the
   * disposition is ledgered with a stand-down note and nothing runs.
   */
  postReview?: (pr: OpenPrView) => void | Promise<void>;
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
  /**
   * W1-T177: an OPTIONAL fresh re-read of ONE PR's live GitHub state,
   * consulted immediately before a blocked-fixable disposition actually
   * spends a fix-rung strike — never the `openPrs` snapshot this whole sweep
   * pass started from (`buildOpenPrViews`'s ONE `gh pr list` at sweep start,
   * run-task.ts), which may already be stale by the time a later PR in the
   * SAME pass is reached (the #388 fixture: merged mid-sweep, dispatched
   * anyway). Omitted, or a failed/indeterminate read (`ok:false`), behaves
   * EXACTLY as before this check existed — dispatch proceeds; standing down
   * fires ONLY on a positive, freshly-observed terminal reading.
   */
  readLiveState?: (pr: OpenPrView) => LiveStateResult | Promise<LiveStateResult>;
  /**
   * W1-T254 (the #707 fix's LIGHT-SWEEP restriction): when supplied, gates
   * which disposition's action is allowed to actually fire THIS pass — a
   * disposition failing the predicate stands down with
   * "deferred to full sweep (light pass)" instead of running (still
   * ledgered every pass, never silently skipped). Omitted ⇒ every
   * disposition acts, unchanged from before this existed. The daemon's
   * restricted light-sweep ticker (running CONCURRENTLY with an in-flight
   * `runOne`) wires `d => d === "post-review"` — only the deterministic,
   * sha-pinned, mutex-serialized re-post is safe to run alongside a task;
   * dispatchFix/close/escalate/depReview/arm stay strictly single-threaded,
   * standing down here until the NEXT full sweep picks them up.
   */
  actionable?: (d: Disposition) => boolean;
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
  /**
   * W1-T254: set when this PR's gated action THREW — `acted` is false, but
   * this is distinct from dedup/dry-run/stand-down: the action was
   * attempted and failed, named here rather than propagating out of
   * `runSweep` and aborting the rest of the pass.
   */
  actionError?: string;
}

/** The whole sweep's outcome — counts per disposition + the per-PR actions. */
export interface SweepSummary {
  /** Total open PRs reconciled. */
  total: number;
  /** How many PRs landed in each disposition (every PR is counted exactly once). */
  byDisposition: Record<Disposition, number>;
  /** How many gated effects actually fired (deduped ones are excluded). */
  actionsTaken: number;
  /**
   * W1-T99: how many gated effects were ATTEMPTED and THREW — distinct from
   * `actionsTaken` (succeeded) and from PRs that never attempted (deduped/dry-run/
   * stood-down). Each one also has its own `sweep.action_failed` ledger line and
   * this PR's `actions[].actionError`; this is the pass-level count a caller reads
   * at a glance without re-deriving it from `actions`.
   */
  actionsFailed: number;
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
  /** `pr@head` keys whose dep-review reached a TERMINAL outcome (arm/escalate/refuse). */
  depReviewed: Set<string>;
  /**
   * `taskId@head` keys with an actual OUTCOME for that head — a posted
   * `review.posted` verdict OR an explicit `review.post_refused` refusal
   * (W1-T254). NOT keyed off `sweep.disposed acted:true` like every other
   * set here: an `acted:true` post-review dispose only proves the LANE WAS
   * INVOKED, never that it reached a verdict (e.g. `postReviewStatusGuarded`
   * can refuse internally without throwing) — keying dedup on the attempt
   * used to suppress the SAME head forever after a single no-op invocation
   * (a latent sibling of the #707 bug). Both ledger steps carry `head_sha`;
   * a posted verdict ALSO flips the PR's live `reviewState` away from
   * "none" on the next `buildOpenPrViews` read, so the row stops matching
   * the post-review disposition rule at all — this set exists mainly to
   * dedup a REFUSAL, which does not change GitHub's status and would
   * otherwise re-route to post-review, and re-invoke, every single pass.
   */
  postReviewed: Set<string>;
}

function priorActionsFromLedger(lines: Array<Record<string, unknown>>): PriorActions {
  const armed = new Set<number>();
  const fixed = new Set<string>();
  const closed = new Set<number>();
  const escalated = new Set<number>();
  const depReviewed = new Set<string>();
  const postReviewed = new Set<string>();
  for (const line of lines) {
    // W1-T254: OUTCOME-KEYED, off the review lane's OWN ledger lines — never
    // `sweep.disposed`. See PriorActions.postReviewed's doc.
    if (line.step === "review.posted" || line.step === "review.post_refused") {
      if (typeof line.task_id === "string" && typeof line.head_sha === "string") {
        postReviewed.add(`${line.task_id}@${line.head_sha}`);
      }
      continue;
    }
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const pr = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (pr === undefined) continue;
    switch (line.disposition) {
      case "mergeable":
        armed.add(pr);
        break;
      case "blocked-fixable":
      // W1-T106: a `conflicted` dispatch is the SAME "spend a fix-rung
      // strike, re-earned by a new head sha" shape as blocked-fixable —
      // dedup off the SAME set, never a second, independently-tracked one.
      case "conflicted":
        fixed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        break;
      case "stale":
        closed.add(pr);
        break;
      case "blocked-ambiguous":
        escalated.add(pr);
        break;
      case "dep-review":
        // Only a TERMINAL outcome dedups; a "hold" must re-run next sweep so a
        // same-sha red check going green is picked up (see SweepDeps.depReview).
        if (line.dep_review_outcome !== "hold") {
          depReviewed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        }
        break;
      // "post-review" deliberately absent here (W1-T254): see the
      // `review.posted`/`review.post_refused` branch above.
    }
  }
  return { armed, fixed, closed, escalated, depReviewed, postReviewed };
}

const ZERO_COUNTS = (): Record<Disposition, number> => ({
  mergeable: 0,
  "blocked-fixable": 0,
  "dep-review": 0,
  "post-review": 0,
  stale: 0,
  "blocked-ambiguous": 0,
  conflicted: 0,
  wait: 0,
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
  // is byte-identical) — the level-triggered idempotence mechanism. The SAME
  // read also feeds {@link decideSweepArm}'s head-bound verdict/override
  // recovery, so arming parity costs this pass no extra ledger read.
  const ledgerLines = readLedger(deps.ledgerPath);
  const prior = priorActionsFromLedger(ledgerLines);

  const byDisposition = ZERO_COUNTS();
  const actions: SweepAction[] = [];
  let actionsTaken = 0;
  // W1-T99: counted distinctly from actionsTaken/noneCount so a caller can tell
  // "nothing to do" from "something threw" at a glance — see renderSweepSummary.
  let actionsFailed = 0;
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
      case "conflicted": // W1-T106: same dedup set as blocked-fixable — see priorActionsFromLedger.
        alreadyDone = prior.fixed.has(`${pr.prNumber}@${pr.headSha}`);
        break;
      case "stale":
        alreadyDone = prior.closed.has(pr.prNumber);
        break;
      case "blocked-ambiguous":
        alreadyDone = prior.escalated.has(pr.prNumber);
        break;
      case "dep-review":
        alreadyDone = prior.depReviewed.has(`${pr.prNumber}@${pr.headSha}`);
        break;
      case "post-review":
        // W1-T254: OUTCOME-keyed — see PriorActions.postReviewed's doc. Keyed
        // by taskId (never prNumber — review.posted/review.post_refused carry
        // no PR number, only the taskId the review lane itself resolved,
        // matching `lastPostedReviewStatusFromLedger`'s established key).
        alreadyDone = prior.postReviewed.has(`${pr.taskId ?? ""}@${pr.headSha}`);
        break;
      case "wait":
        // W1-T114: WAIT never gates an effect — there is nothing to dispatch,
        // only time to let pass. Forcing `alreadyDone` true (rather than
        // adding a no-op case to the action switch below) keeps `acted`
        // false unconditionally, so the ledger line always reads
        // `acted:false` — a wait is re-derived and re-ledgered every pass,
        // never counted as an action taken.
        alreadyDone = true;
        break;
      default:
        alreadyDone = false;
    }

    let acted = !alreadyDone && !deps.dryRun;
    // The dep-review lane's decision for THIS pass (dep-review disposition only)
    // — ledgered so priorActionsFromLedger can tell terminal from hold.
    let depReviewOutcome: string | undefined;
    // W1-T177: set ONLY when the terminal-state check below stood the
    // blocked-fixable dispatch down — distinct from `alreadyDone` (dedup)
    // and from `deps.dryRun` (preview), so the disposed line can name WHY
    // `acted` is false without conflating the three.
    let standDownReason: string | undefined;
    // W1-T254 — PER-PR THROW CONTAINMENT: a thrown action used to propagate
    // straight out of `runSweep` as one un-attributed `sweep.error`, aborting
    // the WHOLE pass (every later PR in `openPrs` went unreconciled this
    // poll). Named here and ledgered on THIS PR's own `sweep.disposed` line
    // below instead — the loop always reaches the next PR.
    let actionError: string | undefined;

    if (acted) {
      // W1-T254 — LIGHT-SWEEP RESTRICTION: `actionable` defaults to
      // "everything" (SweepDeps.actionable is optional), so `rmd sweep` and
      // the daemon's per-iteration full sweep are unchanged. The daemon's
      // restricted light-sweep ticker (running CONCURRENTLY with an
      // in-flight `runOne`) passes `d => d === "post-review"` so only that
      // deterministic, sha-pinned, mutex-serialized re-post ever runs
      // alongside a task — every other lane stands down here, re-derived
      // and re-attempted (never dropped) on the very next full sweep.
      if (deps.actionable && !deps.actionable(disposition)) {
        acted = false;
        standDownReason = "deferred to full sweep (light pass)";
      } else {
        try {
          switch (disposition) {
            case "mergeable": {
              // ARMING PARITY (see decideSweepArm): the run flow's own capped
              // refusal is worthless while this independent path arms the same
              // verdict seconds later (PR #800). Stand down instead of arming —
              // `acted:false` keeps this PR out of `prior.armed`, so the next
              // pass re-derives it fresh and arms the moment executed proof (or
              // a ledgered operator override) lands. No escalation, no strike,
              // no retry: the refusal is a NON-action, named on the ledger line.
              const armDecision = decideSweepArm(pr, ledgerLines);
              if (!armDecision.arm) {
                acted = false;
                standDownReason = armDecision.reason;
                break;
              }
              await deps.arm(pr);
              break;
            }
            case "blocked-fixable": {
              // W1-T177 — TERMINAL-STATE CHECK AT THE SPENDING SITE: re-read this
              // PR's state FRESH, right before a fix-rung strike is actually
              // spent, never the `openPrs` snapshot this whole sweep pass started
              // from. Optional dep; omitted or an indeterminate read (`ok:false`)
              // behaves exactly as before — dispatch proceeds (fail OPEN, never
              // fail-closed-to-stand-down; see `readLiveState`'s own doc).
              const live = await deps.readLiveState?.(pr);
              let terminal: string | undefined;
              if (live) {
                if (live.ok) {
                  terminal = terminalStateReason(live.state);
                } else {
                  // FAIL OPEN, ledgered: the read failed/was indeterminate — this
                  // must never be treated as terminal (that would silently halt
                  // every blocked-fixable dispatch on a gh outage). Proceed to
                  // dispatchFix exactly as before this check existed; the failed
                  // read is still legible on the ledger.
                  log("sweep.dispose.indeterminate", { pr_number: pr.prNumber });
                }
              }
              if (terminal) {
                acted = false;
                standDownReason = terminal;
                break;
              }
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
            }
            case "conflicted": {
              // W1-T106: the SAME terminal-state pre-flight (W1-T177) as
              // blocked-fixable — never spend a merge-conflict fix strike on
              // a PR that went terminal since this sweep pass's snapshot.
              const live = await deps.readLiveState?.(pr);
              let terminal: string | undefined;
              if (live) {
                if (live.ok) {
                  terminal = terminalStateReason(live.state);
                } else {
                  log("sweep.dispose.indeterminate", { pr_number: pr.prNumber });
                }
              }
              if (terminal) {
                acted = false;
                standDownReason = terminal;
                break;
              }
              // The DISPOSITION_RULES "conflicted" row already gated this on
              // isPureConcurrentAddition — dispatch carries the merge-conflict
              // evidence, never a mix with ci-log/reviewer-unmet shapes.
              await deps.dispatchFix(pr, { unmetCriteria: [], mergeConflict: pr.mergeConflict });
              break;
            }
            case "stale":
              await deps.close(pr, reason);
              break;
            case "blocked-ambiguous":
              await deps.escalate(pr, reason, question!);
              break;
            case "dep-review":
              if (deps.depReview) {
                depReviewOutcome = (await deps.depReview(pr)) ?? "unknown";
              } else {
                acted = false;
                standDownReason = "no depReview dep wired — dependabot PR left for the operator lane";
              }
              break;
            case "post-review":
              if (deps.postReview) {
                await deps.postReview(pr);
              } else {
                acted = false;
                standDownReason = "no postReview dep wired — ungated PR left for the operator lane";
              }
              break;
          }
        } catch (e) {
          acted = false;
          actionError = String((e as Error)?.message ?? e);
          // W1-T99 — the canonical crash this task fixes (2026-07-17: the first live
          // BLOCKED-class escalation's `gh issue create` threw on a missing label and
          // took the WHOLE reconciler down with it). This PR's own `sweep.disposed`
          // line below already carries `action_error`; this is a SEPARATE, distinctly
          // named step so a failed action is grep-able on its own, never buried inside
          // the per-pass disposed record. Reached only when !deps.dryRun (acted is
          // gated on that above), so a preview run still leaves no trace.
          appendLine(deps.ledgerPath, {
            run_id: deps.runId,
            task_id: pr.taskId ?? "SWEEP",
            step: "sweep.action_failed",
            pr_number: pr.prNumber,
            pr_url: pr.prUrl,
            disposition,
            error: actionError,
          });
        }
      }
      if (acted) actionsTaken++;
      else if (actionError) actionsFailed++;
    }

    if (standDownReason) {
      // The site the TASK names ("a sweep disposition"), naming the state —
      // never silent: a caller diffing the ledger sees exactly why a
      // blocked-fixable disposition spent nothing this pass.
      log("sweep.dispose.not_open", { pr_number: pr.prNumber, reason: standDownReason });
    }

    actions.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      taskId: pr.taskId,
      disposition,
      reason,
      acted,
      question,
      ...(actionError ? { actionError } : {}),
    });

    log("sweep.dispose", {
      pr_number: pr.prNumber,
      disposition,
      acted,
      reason,
      deduped: alreadyDone,
      ...(actionError ? { action_error: actionError } : {}),
      // W1-T254: the exact ambiguity that misread a dry-run line as a daemon
      // action during the #707 diagnosis — THIS line (unlike the ledgered
      // `sweep.disposed` below) fires unconditionally through the injected
      // `log`, which the real wiring persists to the SAME ledger regardless
      // of `--dry-run`. Tagged so a preview pass is never mistaken for one.
      ...(deps.dryRun ? { dry_run: true } : {}),
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
        ...(depReviewOutcome ? { dep_review_outcome: depReviewOutcome } : {}),
        ...(actionError ? { action_error: actionError } : {}),
        ...(standDownReason ? { stand_down_reason: standDownReason } : {}),
        ...(question ? { question: question.question } : {}),
      });
    }
  }

  const summary: SweepSummary = {
    total: openPrs.length,
    byDisposition,
    actionsTaken,
    actionsFailed,
    actions,
    noneCount,
  };
  log("sweep.summary", {
    ...summary.byDisposition,
    total: summary.total,
    actions_taken: actionsTaken,
    actions_failed: actionsFailed,
  });
  return summary;
}

/** One-line human render of a sweep summary, for both callers' console output. */
export function renderSweepSummary(s: SweepSummary): string {
  const b = s.byDisposition;
  return (
    `sweep: ${s.total} open PR(s) · ${s.actionsTaken} action(s) taken · ` +
    `mergeable ${b.mergeable} · blocked-fixable ${b["blocked-fixable"]} · conflicted ${b.conflicted} · ` +
    `stale ${b.stale} · blocked-ambiguous ${b["blocked-ambiguous"]}` +
    (s.actionsFailed > 0 ? ` · ⚠️ ${s.actionsFailed} action(s) FAILED (see sweep.action_failed)` : "") +
    (s.noneCount > 0 ? ` · ⚠️ ${s.noneCount} UNDISPOSED (invariant violated)` : "")
  );
}

// ────────────────────────────────────────────────────────────────────────────
// W1-T121 — the QUEUE GOVERNOR (the 23-open-PR incident). No backpressure
// existed anywhere in the pipeline, so authoring rate converted DIRECTLY into
// queue depth with nothing to arrest it. Little's law is the argument:
// throughput comes from BOUNDING WIP, not from pushing harder on intake.
//
// CORROBORATION, the governor's thesis run by hand: with the dispatcher DOWN
// and only the sweep loop running, the queue drained 23 -> 14 open PRs in a
// single pass window; and with dispatch halted again, the remaining ten
// drained to ZERO. Drainage is demonstrably healthy while intake is zero —
// the two halves are separable IN PRACTICE, which is exactly what makes a
// DISPATCH-ONLY throttle safe rather than a stall.
//
// ASYMMETRY IS THE WHOLE DESIGN: {@link checkQueueGovernor} is a pure
// predicate its caller consults ONLY on the NEW-task dispatch path (e.g.
// drain.ts's `nextRunnable` / the daemon poll loop) — it is NEVER consulted
// by `runSweep` above, which arms/fixes/closes/escalates already-open PRs at
// ANY depth, ungated. A governor that also throttled drainage would deepen
// the very queue it exists to bound.
// ────────────────────────────────────────────────────────────────────────────

/** {@link checkQueueGovernor}'s verdict for one dispatch-path consultation. */
export interface QueueGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new PR this pass. */
  deferred: boolean;
  /** The open-PR count the decision was made against. */
  observedOpenCount: number;
  /** The policy limit consulted (`policy.wipLimit`, carried for the ledger line). */
  wipLimit: number;
}

/**
 * The queue governor's pure predicate (design (ii)): at or above
 * `policy.wipLimit` open PRs, NEW dispatch is deferred; below it, dispatch
 * proceeds normally. THRESHOLDS ARE POLICY DATA (rule 2) — `policy.wipLimit`
 * is the ONLY thing that moves this decision; there is no second, ad-hoc
 * constant anywhere near a real dispatch call site. Never call this from
 * `runSweep` or any of its deps (arm/dispatchFix/close/escalate) — see the
 * asymmetry note above.
 */
export function checkQueueGovernor(
  openPrCount: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): QueueGovernorResult {
  return {
    deferred: openPrCount >= policy.wipLimit,
    observedOpenCount: openPrCount,
    wipLimit: policy.wipLimit,
  };
}

/**
 * A throttled pass is NOT silent (design (iv)): the real dispatch path calls
 * this exactly when {@link checkQueueGovernor} returns `deferred: true`,
 * writing one `dispatch_deferred_wip` ledger line carrying the observed open
 * count — so a quiet daemon (nothing runnable) stays distinguishable from a
 * THROTTLED one (runnable work exists, held back by the governor).
 */
export function logQueueGovernorDeferral(
  result: QueueGovernorResult,
  appendLine: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void,
  ledgerPath: string,
  runId: string,
): void {
  appendLine(ledgerPath, {
    run_id: runId,
    task_id: "GOVERNOR",
    step: "dispatch_deferred_wip",
    observed_open_count: result.observedOpenCount,
    wip_limit: result.wipLimit,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// W1-T148 — the COST GOVERNOR (the $206/60-run W1-T1 spin-loop incident). A
// spin loop burned ~$206 over ~60 runs with no DAILY ceiling anywhere — every
// individual run stayed safely under its own per-run `budget_usd` cap
// (run-task.ts's `DEFAULT_BUDGET_USD`), so that per-run backstop never fired;
// nothing was watching the CROSS-RUN total. Pairs with W1-T130's
// CANNOT-OBSERVE-MEANS-WAIT polarity — the same "when in doubt, WAIT not
// spend" doctrine, here applied to budget rather than observability, and the
// architectural TWIN of the W1-T121 queue governor just above: a WIP limit
// bounds intake by COUNT, this bounds intake by DOLLARS. Same asymmetry, same
// reason: {@link checkCostGovernor} is a pure predicate its caller consults
// ONLY on the NEW-task dispatch path — it is NEVER consulted by `runSweep`
// above, which arms/fixes/closes/escalates already-open PRs at ANY day-cost,
// ungated. A governor that also throttled drainage would strand in-flight
// work to save money — a worse failure than the spend itself (a half-finished
// PR must still merge, a block must still escalate).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sums ONE ledgered dollar figure per RUN (keyed by `run_id`), for every run
 * with at least one ledger line whose `ts` falls within `[windowStartMs,
 * windowEndMs)`, then totals those per-run figures — a window's ledgered
 * cost. {@link deriveDayCostUsd}/{@link deriveWeekCostUsd} (W1-T159) are both
 * this ONE reduction over a different window, never a separately reimplemented
 * scan — "if both need the same ledger reduction, factor it once" (W1-T184's
 * queue_note, filed against exactly this pairing).
 *
 * PER-RUN, NOT PER-LINE (avoids double-counting): a run's `verdict` line (or,
 * absent one — e.g. a run still in flight — its first `cost_usd`-bearing
 * line) already carries that run's RUNNING TOTAL cost, the same "running
 * total, not incremental" fact board.ts's `liveRunSpend` documents for
 * `budget.warning`/`verdict` lines. Summing every `cost_usd`-bearing line
 * for a run (verdict AND its own implement.done/fix.done contributors) would
 * count that run's spend twice over; taking exactly one figure per run_id —
 * mirroring retro.ts's `gatherRuns` costLine precedent (verdict line
 * preferred, else the first cost_usd line seen) — does not.
 *
 * A line with no `ts` string, an unparseable `ts`, or a `ts` outside the
 * window, is excluded; a run whose only in-window lines carry no `cost_usd`
 * contributes 0.
 */
export function deriveWindowCostUsd(
  lines: ReadonlyArray<Record<string, unknown>>,
  windowStartMs: number,
  windowEndMs: number,
): number {
  const byRun = new Map<string, Record<string, unknown>[]>();
  for (const line of lines) {
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < windowStartMs || parsed >= windowEndMs) continue;
    const runId = typeof line.run_id === "string" ? line.run_id : undefined;
    if (!runId) continue;
    const bucket = byRun.get(runId);
    if (bucket) bucket.push(line);
    else byRun.set(runId, [line]);
  }
  let total = 0;
  for (const runLines of byRun.values()) {
    const verdictLine = runLines.find((l) => l.step === "verdict");
    const costLine = verdictLine ?? runLines.find((l) => typeof l.cost_usd === "number");
    if (costLine && typeof costLine.cost_usd === "number") total += costLine.cost_usd;
  }
  return total;
}

/** `[start, end)` of `now`'s UTC calendar day, in epoch ms — the day-cost window boundary,
 *  factored out so {@link deriveDayCostUsd} and a "merged today" tally (lib/glance.ts, W1-T159)
 *  agree on exactly what "today" means, rather than each computing its own midnight. */
export function utcDayWindowMs(now: number): [start: number, end: number] {
  const day = new Date(now).toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return [start, start + 24 * 60 * 60 * 1000];
}

/** `[start, end)` of the CURRENT UTC ISO week (Monday 00:00 UTC through the following Monday
 *  00:00 UTC) containing `now`, in epoch ms — the week-to-date spend window (W1-T159). */
export function utcWeekWindowMs(now: number): [start: number, end: number] {
  const [dayStart] = utcDayWindowMs(now);
  const dayOfWeek = new Date(dayStart).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const weekStart = dayStart - daysSinceMonday * 24 * 60 * 60 * 1000;
  return [weekStart, weekStart + 7 * 24 * 60 * 60 * 1000];
}

/**
 * The day's ledgered cost — `now`'s UTC calendar day, per-run (see
 * {@link deriveWindowCostUsd} for the shared reduction). BEHAVIOR UNCHANGED from
 * this function's pre-W1-T159 form: same window (today's UTC calendar day), same
 * per-run/verdict-preferred reduction — {@link checkCostGovernor}'s existing call
 * site sees byte-identical results.
 */
export function deriveDayCostUsd(lines: ReadonlyArray<Record<string, unknown>>, now: number): number {
  const [start, end] = utcDayWindowMs(now);
  return deriveWindowCostUsd(lines, start, end);
}

/**
 * The WEEK-TO-DATE ledgered cost (W1-T159): the current UTC ISO week (Monday 00:00 UTC through
 * `now`'s week), same per-run reduction as {@link deriveDayCostUsd}. The GLANCE strip's own
 * falsifier is exactly why this exists beside the day figure: "a daily-only figure cannot answer
 * whether today is normal — ~2.54 USD burned post-merge looked unremarkable in isolation and is
 * only legible against a weekly baseline" (plan/tasks.yaml, this task's amended criterion).
 */
export function deriveWeekCostUsd(lines: ReadonlyArray<Record<string, unknown>>, now: number): number {
  const [start, end] = utcWeekWindowMs(now);
  return deriveWindowCostUsd(lines, start, end);
}

/** {@link checkCostGovernor}'s verdict for one dispatch-path consultation. */
export interface CostGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new run this pass. */
  deferred: boolean;
  /** The day's ledgered cost (notional USD) the decision was made against. */
  observedDayCostUsd: number;
  /** The policy ceiling consulted (`policy.dailyCostCeilingUsd`, carried for the ledger line). */
  ceilingUsd: number;
}

/**
 * The cost governor's pure predicate: at or over `policy.dailyCostCeilingUsd`
 * ledgered dollars spent today, NEW dispatch is deferred; below it, dispatch
 * proceeds normally. THRESHOLDS ARE POLICY DATA (rule 2) —
 * `policy.dailyCostCeilingUsd` is the ONLY thing that moves this decision.
 * Never call this from `runSweep` or any of its deps (arm/dispatchFix/close/
 * escalate) — see the asymmetry note above.
 */
export function checkCostGovernor(
  dayCostUsd: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): CostGovernorResult {
  return {
    deferred: dayCostUsd >= policy.dailyCostCeilingUsd,
    observedDayCostUsd: dayCostUsd,
    ceilingUsd: policy.dailyCostCeilingUsd,
  };
}

/**
 * A throttled pass is NOT silent: the real dispatch path calls this exactly
 * when {@link checkCostGovernor} returns `deferred: true`, writing one
 * `dispatch_deferred_budget` ledger line naming the day-cost + ceiling — so a
 * quiet daemon (nothing runnable) stays distinguishable from a
 * BUDGET-THROTTLED one (runnable work exists, held back by the governor).
 */
export function logCostGovernorDeferral(
  result: CostGovernorResult,
  appendLine: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void,
  ledgerPath: string,
  runId: string,
): void {
  appendLine(ledgerPath, {
    run_id: runId,
    task_id: "GOVERNOR",
    step: "dispatch_deferred_budget",
    observed_day_cost_usd: result.observedDayCostUsd,
    daily_cost_ceiling_usd: result.ceilingUsd,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// W1-T150 — the LEVEL-TRIGGERED CREDIT BACKFILL rung (ratifies P30, the
// identical P22 argument applied to the MERGE EVENT rather than open-PR
// pipeline state — MASTER-PLAN's "0 of 195 runs ledgered a merge while GitHub
// showed 28" fixture). A run's terminal `verdict` line is EDGE-TRIGGERED at
// run-end: a run that ends (blocked_ci, blocked, no_pr, …) before its OWNED PR
// merges never revisits the question, so the ledger's per-task credit can sit
// wrong forever even though GitHub's own state has since moved on. Every
// consumer that reads the `verdict` field directly rather than the
// GitHub-derived union (deriveStatus/status.ts already gets this right via
// its sibling-credit rung, MASTER-PLAN P29(i)/W1-T149) inherits the stale
// answer. This rung closes that gap the SAME way `runSweep` above closes the
// open-PR one: re-derive fresh every poll, act once, do nothing on a repeat
// pass over unchanged state.
// ────────────────────────────────────────────────────────────────────────────

/**
 * One task's observed merge-credit candidacy — the input to the credit
 * backfill rung. `merged` is the CALLER's ownership-asserted, trailer-anchored
 * verdict (reusing W1-T149's ownership rule via status.ts's `deriveStatus` —
 * this module never talks to GitHub directly, exactly like {@link OpenPrView}
 * above): true only when a MERGED PR is owned by this task's own
 * `run-<taskId>-*` branch and carries its anchored `Remudero-Task:` trailer
 * (any run of the task — sibling credit). `false` covers every other observed
 * state (open, closed, no owned PR at all) — the backfill must NEVER fire on
 * anything short of an observed merge (acceptance 3, the falsifier).
 */
export interface CreditCandidate {
  taskId: string;
  prNumber: number;
  prUrl: string;
  merged: boolean;
}

/** One task's credit-backfill outcome this pass. */
export interface CreditBackfillResult {
  taskId: string;
  prNumber: number;
  prUrl: string;
  /** True ⇒ a NEW `verdict.merged` correction was appended this pass. */
  corrected: boolean;
  /** True ⇒ the ledger already carried merge credit for this task (dedup). */
  alreadyCredited: boolean;
}

/** The whole credit-backfill pass's outcome. */
export interface CreditBackfillSummary {
  total: number;
  corrected: number;
  results: CreditBackfillResult[];
}

/**
 * Has this task's merge already been CREDITED on the ledger — either a live
 * run's own terminal `verdict: "merged"` line, or a PRIOR `verdict.merged`
 * backfill correction from this same rung (IDEMPOTENCE: acceptance 2 — a
 * second pass over unchanged state must see its own prior correction and
 * append nothing further)? Scoped to `task_id` only, never `run_id` — sibling
 * credit (P29(i)/W1-T149) means ANY run of this task recording a merge
 * counts, not only the run whose candidate is being reconciled this pass.
 */
function hasMergeCredit(lines: Array<Record<string, unknown>>, taskId: string): boolean {
  return lines.some(
    (l) => l.task_id === taskId && (l.step === "verdict.merged" || (l.step === "verdict" && l.verdict === "merged")),
  );
}

/**
 * THE CREDIT-BACKFILL RUNG (W1-T150). For every candidate whose OWNED PR is
 * `merged` but whose ledger carries no merge credit yet, append EXACTLY ONE
 * `verdict.merged` correction line naming the PR (acceptance 1). A candidate
 * whose PR is not merged is always a no-op (acceptance 3). A repeat pass over
 * unchanged state — including one that only sees THIS pass's own just-written
 * corrections — appends nothing further (acceptance 2): `alreadyCredited` is
 * (re-)computed per candidate against the ledger snapshot PLUS every
 * correction this same pass has already appended, so two candidates naming
 * the same task within one pass still credit exactly once.
 *
 * Mirrors {@link runSweep}'s shape deliberately (same injected ledger
 * reader/appender, same `dryRun` leaves-no-trace contract) so both rungs of
 * the one reconciler behave identically — but is a SEPARATE entry point: its
 * input domain (one credit candidate per TASK, sourced from `deriveStatus`)
 * is disjoint from `runSweep`'s (one {@link OpenPrView} per OPEN PR) — a
 * merged PR is no longer open and would never appear in `openPrs`.
 */
export async function runCreditBackfill(
  candidates: CreditCandidate[],
  deps: Pick<SweepDeps, "ledgerPath" | "runId" | "readLedger" | "appendLine" | "log" | "dryRun">,
): Promise<CreditBackfillSummary> {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const lines = readLedger(deps.ledgerPath);

  const results: CreditBackfillResult[] = [];
  let corrected = 0;

  for (const c of candidates) {
    const alreadyCredited = hasMergeCredit(lines, c.taskId);
    const shouldCorrect = c.merged && !alreadyCredited;
    const acted = shouldCorrect && !deps.dryRun;

    if (acted) {
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: c.taskId,
        step: "verdict.merged",
        verdict: "merged",
        pr_number: c.prNumber,
        pr_url: c.prUrl,
        source: "sweep.credit_backfill",
      });
      // Reflected into THIS pass's own snapshot (not just re-read from disk on
      // the NEXT sweep) so a second candidate naming the same task later in
      // this same array — e.g. a duplicate produced by the caller — is
      // credited exactly once, never twice, without waiting on a fresh poll.
      lines.push({ task_id: c.taskId, step: "verdict.merged" });
      corrected++;
    }

    // LOG ONLY WHAT WAS ACTED ON. This ran once per candidate per sweep, and the
    // daemon sweeps every poll, so a backfill that corrects nothing still wrote a
    // line per already-credited task forever — 5,209 no-op lines, all of them
    // `corrected: false`. The ledger is the provenance spine and its SIZE is the
    // read cost behind W1-T187's 310x projection regression; a per-poll restatement
    // of unchanged state buys nothing and is charged to every reader. The summary
    // line below still reports `total` on every pass, so the sweep's COVERAGE stays
    // observable even when its per-candidate detail is silent.
    if (acted) {
      log("sweep.credit_backfill", {
        task_id: c.taskId,
        pr_number: c.prNumber,
        pr_url: c.prUrl,
        corrected: acted,
        already_credited: alreadyCredited,
      });
    }

    results.push({ taskId: c.taskId, prNumber: c.prNumber, prUrl: c.prUrl, corrected: acted, alreadyCredited });
  }

  const summary: CreditBackfillSummary = { total: candidates.length, corrected, results };
  log("sweep.credit_backfill.summary", { total: summary.total, corrected: summary.corrected });
  return summary;
}

// ── ESCALATION-LIFECYCLE RECONCILER (fb-1784756088300-6a481e) ──────────────────
// The sweep RAISES needs-human issues (W1-T8) but nothing ever CLOSED them when the
// blocker resolved: 84% of open needs-human issues (26/31 on 2026-07-22) were stale —
// each referenced a fix PR that later merged through its normal gate. This is the missing
// third leg of the escalation lifecycle (creation W1-T8, dedup-at-creation W1-T195,
// CLOSURE here), and it rides the SAME sweep seam + same level-triggered doctrine as
// runCreditBackfill above: the CALLER re-derives each OPEN needs-human issue's referenced
// task via the #737/#741-corrected deriveStatus and hands the derivation here. A referent is
// TERMINAL — and the escalation auto-closes, naming the resolution — either because it MERGED
// (deriveStatus's `merged`, which also covers a task CREDITED via an operator correction, W1-T162)
// or because its PR CLOSED WITHOUT MERGING (deriveStatus's `prState`, e.g. superseded/abandoned —
// the sweep's own stale/superseded PR-close, W1-T77, is the common producer of this shape;
// W1-T162 closed this gap, which previously left a closed-but-unmerged referent reading as
// falsely "still live" forever). A still-LIVE referent (PR open/blocked-pending-fix, or a task
// with no PR yet) is left untouched; an INDETERMINATE derivation (W1-T119 — GitHub could not be
// read) is left untouched too, never closed on a read this pass could not trust. Bounded per
// cycle so a large backlog drains gradually rather than in a burst of `gh issue close` calls,
// and every close is ledgered.

/** How many stale escalations one reconcile pass may close — bounds the write burst so a
 *  large backlog (the observed 94-open shape) drains across several sweeps, never one. */
export const MAX_ESCALATION_CLOSES_PER_CYCLE = 20;

/** One open needs-human issue paired with its referenced task's CURRENT derived state. */
export interface EscalationReconcileCandidate {
  issueUrl: string;
  issueNumber?: number;
  taskId: string;
  /** The referent's state, derived by the caller via the #737/#741-corrected deriveStatus. */
  derived: {
    merged: boolean;
    /** W1-T162: the referenced PR CLOSED WITHOUT MERGING (deriveStatus's `prState`, raw
     *  "CLOSED") — a terminal, resolved-negative disposition (superseded/abandoned), distinct
     *  from an open/blocked-pending-fix PR that is still live. Mutually exclusive with `merged`. */
    closed?: boolean;
    /** W1-T119: the read that produced this derivation FAILED — treat as neither resolved nor live. */
    indeterminate?: boolean;
    prUrl?: string;
    prNumber?: number;
    source?: string;
  };
}

/** One issue's reconcile outcome this pass. */
export interface EscalationReconcileResult {
  issueUrl: string;
  taskId: string;
  outcome: "closed" | "left-live" | "left-indeterminate" | "deferred-cap" | "close-failed";
}

/** The whole reconcile pass's outcome. */
export interface EscalationReconcileSummary {
  total: number;
  closed: number;
  results: EscalationReconcileResult[];
}

export interface EscalationReconcileDeps {
  /** Close one issue, posting the citation comment. Wraps `gh issue close --comment` in prod. */
  closeIssue: (url: string, comment: string) => void;
  ledgerPath: string;
  runId: string;
  appendLine?: typeof appendLedger;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** dryRun leaves no trace (no `gh`, no ledger line) — mirrors runSweep/runCreditBackfill. */
  dryRun?: boolean;
  /** Bound on closes this cycle; defaults to {@link MAX_ESCALATION_CLOSES_PER_CYCLE}. */
  maxCloses?: number;
}

/**
 * The closing citation posted on a reconciled issue — NAMES THE RESOLUTION (the merged PR, or
 * the closed-without-merging PR that superseded/abandoned it) so the closure is legible, never
 * a silent disappearance. Pure + exported for a direct assertion.
 */
export function renderReconcileCloseComment(c: EscalationReconcileCandidate): string {
  const pr = c.derived.prNumber !== undefined ? `#${c.derived.prNumber}` : (c.derived.prUrl ?? "its PR");
  const link = c.derived.prUrl ? ` (${c.derived.prUrl})` : "";
  const via = c.derived.source ? ` — derived via \`${c.derived.source}\`` : "";
  const resolution = c.derived.merged
    ? `is now **merged**, resolved by ${pr}${link}${via}`
    : `is now **closed without merging** (${pr}${link}${via}) — superseded or abandoned, no longer a live blocker`;
  return [
    "Auto-closed by the escalation-lifecycle reconciler (fb-1784756088300-6a481e).",
    "",
    `The referenced task **${c.taskId}** ${resolution}. This escalation's blocker is gone.`,
    "",
    "_Level-triggered closure from GitHub-derived state (the #737/#741 derivation). If the decision this issue raised is still open, reopen it._",
  ].join("\n");
}

/**
 * Reconcile OPEN needs-human issues against their referent's CURRENT derived state. Separate
 * entry point mirroring {@link runCreditBackfill}: its input domain is one OPEN issue per
 * candidate (the caller lists them and derives each referent), disjoint from runSweep's OPEN
 * PRs. Best-effort, per-issue throw-contained: one failed `gh issue close` never strands the
 * rest (the W1-T99 lesson).
 */
export async function runEscalationReconcile(
  candidates: EscalationReconcileCandidate[],
  deps: EscalationReconcileDeps,
): Promise<EscalationReconcileSummary> {
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const maxCloses = deps.maxCloses ?? MAX_ESCALATION_CLOSES_PER_CYCLE;

  const results: EscalationReconcileResult[] = [];
  let closed = 0;

  for (const c of candidates) {
    // INDETERMINATE first (W1-T119): a derivation this pass could not trust is neither a close
    // NOR a confident "still live" — it simply waits for a readable pass.
    if (c.derived.indeterminate) {
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "left-indeterminate" });
      continue;
    }
    // STILL LIVE: the referent is neither merged nor closed-without-merging — leave the
    // escalation untouched (an open PR, or a task with no PR yet, is a live decision).
    if (!c.derived.merged && !c.derived.closed) {
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "left-live" });
      continue;
    }
    // RESOLVED (merged OR closed-without-merging). Bounded per cycle: once the cap is
    // reached, the rest drain on the next sweep.
    if (closed >= maxCloses) {
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "deferred-cap" });
      continue;
    }
    // dryRun leaves no trace but still previews (and counts toward the cap so the preview
    // matches a live cycle's bound) — mirrors runCreditBackfill's `acted = ... && !dryRun`.
    if (deps.dryRun) {
      closed++;
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "closed" });
      continue;
    }
    const comment = renderReconcileCloseComment(c);
    try {
      deps.closeIssue(c.issueUrl, comment);
    } catch (e) {
      // PER-ISSUE THROW CONTAINMENT (W1-T99): one failed close never strands the rest, and an
      // uncounted failure retries next cycle rather than consuming a cap slot forever.
      log("sweep.escalation_close_failed", {
        issue_url: c.issueUrl,
        task_id: c.taskId,
        error: String((e as Error)?.message ?? e),
      });
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "close-failed" });
      continue;
    }
    // W1-T162: name the resolution kind in the ledger too, not just the GitHub comment —
    // "merged" (or a task credited via correction) vs. "closed" (closed without merging).
    const resolution = c.derived.merged ? "merged" : "closed";
    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: c.taskId,
      step: "sweep.escalation_closed",
      issue_url: c.issueUrl,
      resolution,
      pr_url: c.derived.prUrl,
      pr_number: c.derived.prNumber,
      source: c.derived.source,
    });
    log("sweep.escalation_closed", {
      issue_url: c.issueUrl,
      task_id: c.taskId,
      resolution,
      pr_url: c.derived.prUrl,
      pr_number: c.derived.prNumber,
    });
    closed++;
    results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "closed" });
  }

  const summary: EscalationReconcileSummary = { total: candidates.length, closed, results };
  log("sweep.escalation_reconcile.summary", { total: summary.total, closed: summary.closed });
  return summary;
}

// ── POST-FIX RE-VERIFICATION RECONCILER (W1-T124) — the DRAINAGE-side
// complement to the W1-T121 queue governor above: the governor stops the
// queue GROWING, this rung stops it ROTTING. Filed from #271 holding-note
// item 5.
//
// THE INCIDENT, twice. The 14-PR pile, then a sharper 2026-07-19 instance: FOUR
// PRs (#265/#249/#245/#236) went red on `ci-gate: timed out waiting for
// required check(s) to complete: mutation-ratchet` while mutation-ratchet
// itself completed SUCCESS on those same heads moments later — the gate timed
// out on the ~13-minute Stryker tax W1-T108 later removed, the work was fine.
// Nothing re-examined the PRs the already-fixed cause had poisoned; all four
// needed a hand-pushed fresh head to clear. A red caused by infrastructure,
// whose cause is now merged, should not need a human to notice it.
//
// DESIGN (i): a failure-pattern -> fix-PR mapping held as DATA ({@link
// FixClass} rows in {@link DEFAULT_FIX_CLASSES}) — covering a new systemic
// fix is a ROW, never a branch in {@link runPostFixReverification} below,
// exactly how {@link DISPOSITION_RULES} keeps disposition itself out of
// deriveDisposition's control flow.
//
// DESIGN (iii): the re-drive must work against REAL ci-gate semantics. Until
// W1-T123 (already merged, a hard dependency of this task) deduped check-runs
// by NAME and evaluated only the latest attempt, a re-run in place could never
// clear a stale red — ci-gate itself, once it posts a terminal FAILURE/
// TIMED_OUT conclusion, would keep reading its OWN stale attempt forever. This
// module never talks to GitHub directly (mirrors every other rung in this
// file): HOW to re-drive — re-request the ci-gate check-run in place (the
// W1-T123 world this rung ships into) vs. push a refresh commit (the
// pre-W1-T123 fallback design note iii names) — is entirely the injected
// {@link PostFixReverificationDeps.redrive} effect's own decision, never this
// reconciler's.
//
// DESIGN (iv), STRIKE ACCOUNTING (load-bearing — see the task rationale: "self
// -healing is capped by the very counter it exists to relieve" otherwise). A
// re-verification pass itself never spends a strike (dedup below is keyed on
// the redrive, not on `dispatchFix`/the fix-rung ladder at all). And because
// this rung matches ONLY the PR's currently-recorded failure against a fixed
// class (acceptance 2's falsifier proves an unmatched PR is never touched),
// every strike a MATCHED PR carries into this pass was spent chasing that
// SAME now-fixed infrastructure artifact — so a successful redrive credits
// back the PR's full `priorStrikes` count when re-deriving its disposition,
// both ledgered (for a future external strike-ledger consumer to reconcile)
// and reflected LIVE in the disposition this pass returns (never deferred to
// a second pass just to prove the credit took effect).
// ────────────────────────────────────────────────────────────────────────────

/**
 * One failure-pattern -> fix-PR class mapping ROW (design note i): DATA, not
 * code. `matchesFailure` is a PURE predicate over the SAME {@link OpenPrView}
 * shape every other rung in this file reads — never an LLM classification
 * (rule 2) — mirroring how {@link DISPOSITION_RULES}' own rows carry a
 * predicate function as their "data": the mapping lives in this table, not in
 * `runPostFixReverification`'s control flow, so covering a new systemic fix
 * never touches the reconciler itself.
 */
export interface FixClass {
  /** Stable id for ledger lines, dedup keys, and test fixtures — never reused across rows. */
  id: string;
  /** The merged PR whose fix resolves this class — named in every reason/ledger line. */
  fixPrNumber: number;
  /** Human description, carried into ledger lines for an operator reading the trail. */
  description: string;
  /** Does this PR's OBSERVED, currently-recorded failure match this class? */
  matchesFailure: (pr: OpenPrView) => boolean;
}

/**
 * The 2026-07-19 regression fixture's own class (acceptance 4): `ci-gate`
 * itself times out waiting for a required check that had, or would shortly
 * have, actually succeeded on the SAME head — the W1-T123 dedupe-by-name fix
 * is what makes a re-drive of this class able to clear at all (design note
 * iii). Matches on the failing check's recorded name AND its log tail,
 * never on checksState alone — a genuinely red mutation-ratchet (an actual
 * mutation survivor, not a gate timeout) must never match this class.
 */
export const CI_GATE_TIMEOUT_FIX_CLASS: FixClass = {
  id: "ci-gate-required-check-timeout",
  fixPrNumber: 820, // W1-T123 — "fix(ci-gate): dedupe check-runs by name, evaluate only latest attempt"
  description:
    "ci-gate timed out waiting for a required check that had already (or was about to have) succeeded " +
    "on the same head — a stale check-run attempt read instead of the latest one, not a real defect",
  matchesFailure: (pr) =>
    (pr.ciFailures ?? []).some(
      (f) => f.name === "ci-gate" && /timed out waiting for required check\(s\)/i.test(f.logTail),
    ),
};

/** The live class table this reconciler consults by default — a new systemic fix is a row appended
 *  here (design note i), never a change to {@link runPostFixReverification}. */
export const DEFAULT_FIX_CLASSES: readonly FixClass[] = [CI_GATE_TIMEOUT_FIX_CLASS];

/**
 * The injected redrive effect's outcome. `fresh`, when present, is a brand
 * new {@link OpenPrView} read AFTER the redrive settled — this reconciler
 * never invents one and never re-uses the STALE pre-redrive view to derive a
 * disposition (that would just re-observe the same stale red it set out to
 * clear). Absent `fresh` ⇒ the redrive was dispatched but no settled read is
 * available yet (e.g. the re-run is still in flight): this pass records the
 * redrive (so it is never repeated) and stops there — the PR's disposition is
 * re-derived by the NEXT ordinary sweep once GitHub's own state has caught up.
 */
export interface RedriveResult {
  fresh?: OpenPrView;
}

/** Injected effects for {@link runPostFixReverification} — mirrors {@link runCreditBackfill}/
 *  {@link runEscalationReconcile}'s shape (same ledger reader/appender, same dry-run-leaves-no-
 *  trace contract) so all three reconciler rungs in this file behave identically to their callers. */
export interface PostFixReverificationDeps {
  /**
   * Re-drive the PR's matched required check for the given class (design
   * note iii) — re-request the ci-gate check-run in place, or push a refresh
   * commit, entirely the effect's own decision; this module never calls
   * `gh`/git directly.
   */
  redrive: (pr: OpenPrView, fixClass: FixClass) => RedriveResult | Promise<RedriveResult>;
  ledgerPath: string;
  runId: string;
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  appendLine?: typeof appendLedger;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Preview only: derive matches, take no effects, write no ledger lines. */
  dryRun?: boolean;
}

/** One PR's outcome this pass. */
export interface PostFixReverificationResult {
  prNumber: number;
  taskId?: string;
  outcome: "redriven" | "unmatched" | "already-redriven" | "redrive-failed";
  fixClassId?: string;
  /** Present only when outcome === "redriven" AND the redrive returned a fresh, settled view
   *  (design note ii — "re-dispose on the fresh result"). */
  disposition?: Disposition;
  /** Present only when outcome === "redriven" — the strikes credited back this pass (design iv). */
  strikesCredited?: number;
}

/** The whole reconciliation pass's outcome. */
export interface PostFixReverificationSummary {
  total: number;
  redriven: number;
  results: PostFixReverificationResult[];
}

/**
 * THE POST-FIX RE-VERIFICATION RUNG (W1-T124, acceptance 1/2/3/4). For every
 * open PR whose CURRENTLY-recorded failure matches a {@link FixClass} row
 * whose `fixPrNumber` is in `mergedFixPrNumbers` (the caller's own merged-PR
 * read — this module never talks to GitHub, exactly like {@link
 * CreditCandidate.merged} above): re-drive its matched check EXACTLY ONCE
 * (deduped on the ledger, keyed by `pr@headSha@class` — a NEW push legitimately
 * re-earns a redrive, mirroring how fix-dispatch dedup is head-keyed in {@link
 * runSweep}), and — when the redrive returns a settled fresh view — re-derive
 * its disposition with strikes credited back to zero (design note iv).
 *
 * A PR whose failure does NOT match any merged class is entirely untouched:
 * no redrive call, no ledger line, `outcome: "unmatched"` (acceptance 2's
 * falsifier — proves the mapping does real work rather than blanket-rerunning
 * every open PR).
 */
export async function runPostFixReverification(
  openPrs: OpenPrView[],
  mergedFixPrNumbers: ReadonlySet<number>,
  deps: PostFixReverificationDeps,
  classes: readonly FixClass[] = DEFAULT_FIX_CLASSES,
): Promise<PostFixReverificationSummary> {
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const lines = readLedger(deps.ledgerPath);

  const results: PostFixReverificationResult[] = [];
  let redriven = 0;

  for (const pr of openPrs) {
    const cls = classes.find((c) => mergedFixPrNumbers.has(c.fixPrNumber) && c.matchesFailure(pr));
    if (!cls) {
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "unmatched" });
      continue;
    }

    // Head-keyed dedup (mirrors runSweep's fix-dispatch dedup): a NEW push
    // legitimately re-earns a redrive even for the same class, but a repeat
    // pass over the SAME unchanged head never re-drives twice (acceptance 1:
    // "re-driven exactly once").
    const redriveKey = `${pr.prNumber}@${pr.headSha}@${cls.id}`;
    const already = lines.some((l) => l.step === "sweep.post_fix_redriven" && l.redrive_key === redriveKey);
    if (already) {
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "already-redriven", fixClassId: cls.id });
      continue;
    }

    if (deps.dryRun) {
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "redriven", fixClassId: cls.id });
      redriven++;
      continue;
    }

    let redrive: RedriveResult;
    try {
      redrive = await deps.redrive(pr, cls);
    } catch (e) {
      // PER-PR THROW CONTAINMENT (the W1-T99 lesson, mirrored from
      // runEscalationReconcile above): one failed redrive never strands the
      // rest of this pass, and — since nothing is ledgered on failure — it
      // retries on the very next sweep rather than being silently dropped.
      log("sweep.post_fix_redrive_failed", {
        pr_number: pr.prNumber,
        fix_class: cls.id,
        error: String((e as Error)?.message ?? e),
      });
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "redrive-failed", fixClassId: cls.id });
      continue;
    }

    // Design note iv: captured from the PRE-redrive view, never from
    // `redrive.fresh` (whose ledger read may already reflect THIS pass's own
    // no-strike redrive) — the full count this PR carried in is what gets
    // credited back.
    const creditedStrikes = pr.priorStrikes;

    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: pr.taskId ?? "SWEEP",
      step: "sweep.post_fix_redriven",
      pr_number: pr.prNumber,
      pr_url: pr.prUrl,
      redrive_key: redriveKey,
      fix_class: cls.id,
      fix_pr_number: cls.fixPrNumber,
      credited_strikes: creditedStrikes,
    });
    // Reflected into THIS pass's own snapshot (mirrors runCreditBackfill) so a
    // duplicate candidate for the same head within one pass redrives once.
    lines.push({ step: "sweep.post_fix_redriven", redrive_key: redriveKey });
    redriven++;

    let disposition: Disposition | undefined;
    if (redrive.fresh) {
      // Re-dispose on the fresh, settled result (design note ii) — with
      // strikes credited to zero (design note iv): the ONLY defect this rung
      // ever matches against is the now-fixed class (acceptance 2 proves an
      // unmatched PR is never touched at all), so every strike a MATCHED PR
      // carried in was spent chasing that same infrastructure artifact.
      const dispositionView: OpenPrView = { ...redrive.fresh, priorStrikes: 0 };
      disposition = deriveDisposition(dispositionView).disposition;
    }

    log("sweep.post_fix_redriven", {
      pr_number: pr.prNumber,
      fix_class: cls.id,
      fix_pr_number: cls.fixPrNumber,
      credited_strikes: creditedStrikes,
      disposition,
    });

    results.push({
      prNumber: pr.prNumber,
      taskId: pr.taskId,
      outcome: "redriven",
      fixClassId: cls.id,
      disposition,
      strikesCredited: creditedStrikes,
    });
  }

  const summary: PostFixReverificationSummary = { total: openPrs.length, redriven, results };
  log("sweep.post_fix_reverification.summary", { total: summary.total, redriven: summary.redriven });
  return summary;
}
