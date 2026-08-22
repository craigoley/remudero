import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { appendLedger } from "./ledger.js";
import { readLedgerLines, readMergeCreditedTaskIds, taskIdFromRunBranch } from "./status.js";
import { installPolicyPath, loadDefaultPolicy, PolicyError } from "./policy.js";
import { loadDefaultCostAnomalyPolicy, recordCostAnomalies, type CostAnomalyPolicy } from "./cost-anomaly.js";
import {
  automergeHoldFromLedger,
  cappedOverrideFromLedger,
  decideAutoMergeArm,
  postedArmFactsFromLedger,
  REVIEW_CONTEXT,
} from "./review.js";
import type { ArmDecision, AutomergeHold, CriterionVerdict } from "./review.js";
import type { QuestionEntry } from "./worker.js";
import { FLEET_NOTICE_LABEL, NEEDS_HUMAN_LABEL, type AskType, type IssueGateway, type OpenIssue } from "./escalate.js";
import { GhPaceFloorStandDownError } from "./open-prs-rest.js";

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
 *                        contradictory criteria, a required check with zero observed
 *                        runs whose ONE deterministic post attempt already came back
 *                        refused (W1-T176 — see POST-REVIEW below for the FIRST-SEEN
 *                        case, which is deterministic-action, never this row), OR the
 *                        TERMINAL catch-all (anything not positively mergeable, not
 *                        failure-shaped, and not the blocked_ci shape above — e.g.
 *                        checks still pending with no review) -> the
 *                        CLARIFICATION-QUESTION rung (W1-T78, ratifies P22's new
 *                        rung): {@link renderClarificationQuestion} renders a
 *                        SPECIFIC, decidable operator question from ledger ground
 *                        truth (never a generic needs-human), which the real wiring
 *                        (run-task.ts's `buildSweepEffects`) logs to the §2 question
 *                        backlog AND opens via W1-T8's `escalate()` as the
 *                        notification transport — so it is never silent and never
 *                        armed.
 *   - POST-REVIEW      — (the 2026-07-22 #584 stall; W1-T176) required checks green,
 *                        remudero-review has ZERO observed check runs, and no prior
 *                        post attempt for this exact head was refused -> run the
 *                        review lane (the SAME deterministic `rmd review` an operator
 *                        would run) rather than asking. An absent required check is a
 *                        mechanically DECIDABLE state ("post it"), not ambiguity — the
 *                        #393/#391 fixture (2026-07-20): every other check SUCCESS,
 *                        remudero-review absent, escalated with two mis-framed
 *                        options while `rmd review` was the actual one-command
 *                        remedy. FAIL-CLOSED: at most one deterministic attempt per
 *                        head sha — a refused attempt routes the NEXT pass to
 *                        BLOCKED-AMBIGUOUS above instead of re-posting forever.
 *                        ORPHANED-BY-PUSH (W1-T225; the 2026-07-21 PRs #477/#484
 *                        jam): the SAME zero-observed-runs shape also arises when a
 *                        PR WAS reviewed on an earlier head and a later push left the
 *                        new head with no remudero-review status at all — the old
 *                        verdict is correctly bound to the sha it was posted against
 *                        (push-invalidates-review is never weakened here), but
 *                        nothing had ever re-dispatched the lane on the new head, so
 *                        the PR sat ABSENT — indistinguishable from a check that
 *                        simply hasn't run yet — and auto-merge waited forever.
 *                        `OpenPrView.reviewOrphanedByPush` distinguishes this from a
 *                        PR awaiting its FIRST review (the reason string differs;
 *                        the dispatch is identical: run the review lane, posting a
 *                        FRESH verdict, never the prior one carried forward). BOUNDED
 *                        (design note, "same discipline as CI re-runs"): once
 *                        `priorReviewOrphans` reaches `policy.reviewOrphanCap`, the
 *                        row above escalates for visibility — a PR that pushes
 *                        repeatedly (or whose re-review itself keeps failing to
 *                        stick) surfaces to an operator instead of looping silently.
 *                        W1-T1018 (operator ruling 2026-08-19): this is no longer a
 *                        PERMANENT wall — {@link reviewOrphanBackoffElapsed} lets the
 *                        row above yield back to THIS row once enough wall-clock time
 *                        has passed since the lane's last attempt, so a PR that heals
 *                        (a repaired base, a fixed contradiction) keeps getting
 *                        re-reviewed rather than being stranded green-and-silenced
 *                        forever (rationale (1)-(4), PR #2159).
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
 * W1-T920 — a THREE-VALUED finding (design note iii): "unreadable" is a distinct outcome, never
 * collapsed into "unique". Only `"superseded"` may ever gate a CLOSE — see
 * {@link OpenPrView.supersessionVerdict} and the `DISPOSITION_RULES` row it feeds. W1-T932:
 * `"unique"` gained a SECOND, narrower consumer — a different `DISPOSITION_RULES` row may read
 * it to let the bare-number `supersededBy` match YIELD (never to close anything itself; see that
 * row's own doc and {@link SweepPolicy.conceptCoexistenceEnabled}) — so "never acts" below now
 * describes `"indeterminate"` only, not `"unique"`.
 *
 *   - `"superseded"`  — another PR (open or merged) already covers this PR's task; evidence is
 *     REQUIRED (see {@link SupersessionEvidence}) — "superseded" alone is unauditable.
 *   - `"unique"`      — the trailer/diff read completed and found no supersession. Distinct from
 *     "indeterminate": this is a POSITIVE finding, not a default.
 *   - `"indeterminate"` — the read itself failed or was inconclusive (a trailer scan threw, a diff
 *     query errored, a merged-by-trailer lookup was rate-limited, or the diff read back EMPTY with
 *     no corpus control to trust — design note iv). NEVER acts on any disposition — named
 *     separately so a caller can tell "checked, none found" from "could not check", the same
 *     fail-open direction `readLiveState`'s `ok:false` already uses elsewhere in this module.
 */
export type SupersessionStatus = "superseded" | "unique" | "indeterminate";

/**
 * W1-T920 (design note iv) — the diff finding carries its OWN corpus control. A diff read that
 * comes back with zero hunks is indistinguishable, from the hunk count ALONE, from a diff read
 * that broke and returned nothing — the #1955 hand-diagnosis measured exactly this shape (131
 * lines, zero hunks, four symbols already on main). `rawLineCount` is the control: a verdict
 * built from a zero-length raw read must never claim `"superseded"` — see the DISPOSITION_RULES
 * row's own doc for how a detector is expected to enforce this before ever setting `status`.
 */
export interface SupersessionDiffFinding {
  /** Total diff lines the read observed, BEFORE any hunk matching — the corpus control. */
  rawLineCount: number;
  /** Hunks matched against symbols already present on the superseding PR/task. */
  matchedHunks: number;
}

/**
 * W1-T920 (design note v) — the evidence a `"superseded"` verdict NAMES, never a bare label.
 * This is what made the #1955 diagnosis checkable in one read: the superseding PR number, the
 * shared task id, and the diff finding with its own control, together in one place.
 */
export interface SupersessionEvidence {
  /** The PR (open or merged) whose work already covers this PR's task. */
  supersedingPrNumber: number;
  /** The plan task both PRs share — the trailer this verdict was matched on. */
  taskId: string;
  diff: SupersessionDiffFinding;
}

/**
 * W1-T920 — one open PR's supersession finding, read (never computed) by the disposition. See
 * {@link OpenPrView.supersessionVerdict}'s own doc for the honest scope note: the DETECTOR that
 * populates this is a separate, out-of-scope shard (this task's own design note, "WHAT MUST NOT
 * BE BUILT") — this type and the disposition row that reads it are the full wired MECHANISM,
 * unit-tested against caller-supplied verdicts, but nothing in the real gateway sets one yet.
 */
export interface SupersessionVerdict {
  status: SupersessionStatus;
  /** REQUIRED when `status === "superseded"`; absent otherwise. */
  evidence?: SupersessionEvidence;
  /** Human-legible explanation, always present — e.g. why a read came back indeterminate. */
  detail: string;
}

/**
 * One failing required CI check's name + the tail of its log — the W1-T94
 * ci-log fix mode's ONLY input. Defined HERE (not in run-task.ts, which
 * imports it) because {@link OpenPrView} carries it and run-task.ts already
 * imports OpenPrView from this module — the reverse import would be circular.
 */
export interface CiFailure {
  name: string;
  logTail: string;
  /**
   * The commit sha this check's failure is attributable to, when the read can identify one
   * (W1-T186, the #420 fixture: commitlint lints the whole base..head RANGE, so a required
   * check reported against the PR can be tripped by a commit that is NOT one of the PR's own —
   * #417's own three commits measured 92/90/76 chars while the 101-char header that actually
   * failed commitlint was `0e63429` on MAIN). `undefined` when the failure could not be
   * attributed to a specific sha — the ordinary case, where the check simply failed against the
   * PR's own head (`OpenPrView.headSha`), and the escalation names that instead.
   */
  sha?: string;
  /**
   * `true` when `sha` is OBSERVED to be outside this PR's own commit range — the #420 shape.
   * `undefined`/`false` otherwise, including when it is simply unknown: NEVER asserted without
   * positive evidence (fail toward "assume it's the PR's own", never invent an exoneration the
   * read cannot support).
   */
  outsidePrRange?: boolean;
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
   * W1-T325: this is now literally true — `plan/policy.yaml`'s `sweep.dispatchLanes`
   * row is the source of the default below (read via {@link loadDefaultPolicy}), not
   * a source literal. The relocation retunes nothing; the value stays 2.
   * W1-T473: USED TO ALSO be the review lane ceiling — `runSweep` consulted this SAME
   * field a second time (`Math.max(1, policy.dispatchLanes)`) to bound how many
   * `post-review` PRs it runs CONCURRENTLY in one pass, "honouring the same lane
   * number" dispatch uses rather than inventing a second, independently-tuned
   * ceiling. W1-T1049 (rationale (3)/(4)): that coupling silently pinned drainage's
   * OWN concurrency budget to a dispatch-only ruling — the operator's "stays at 3"
   * ruling on THIS field was never about review — and let the two ceilings ADD on
   * the host with nothing anywhere naming their sum. `runSweep` now reads {@link
   * SweepPolicy.reviewLanes} instead, a SIBLING field, never a second use of this
   * one. This field's own MEANING is unchanged and no longer shared — still only the
   * dispatch-lane count `daemon.ts`'s `laneCount` and `test/policy-consumers.test.ts`
   * read.
   */
  dispatchLanes: number;
  /**
   * W1-T1049 — THE REVIEW LANE'S OWN CONCURRENCY BUDGET (rationale (3)/(4)): bounds
   * how many `post-review` PRs `runSweep` runs CONCURRENTLY in one pass. Floored at 1
   * in `runSweep` exactly like `daemon.ts`'s `laneCount` floors `dispatchLanes` — a
   * misconfigured 0 must never silently mean "review nothing" (design (ii); the code
   * floor survives regardless of this field's own `min`). A CEILING, NEVER A TARGET
   * (design (iii)): only ever bounds the reviews THIS PASS already found eligible —
   * a pass with zero eligible reviews starts zero lanes no matter this number.
   *
   * Until this field existed, `runSweep` read {@link SweepPolicy.dispatchLanes}
   * above A SECOND TIME for this (W1-T473) — a coupling W1-T473's own design (ii)
   * named the cost of in advance ("silently couples two unrelated ceilings
   * forever") and which then bound: raising or lowering drainage's own budget meant
   * reopening a dispatch-only ruling, and the two ceilings ADDED on the host with
   * nothing naming their sum (measured: 3 dispatch lanes + 3 review lanes = 6
   * concurrent Claude workers on a host measured to fit about 4).
   *
   * DEFAULTS to `dispatchLanes`' own present value (3, read via {@link
   * loadReviewLanesPolicy} directly off `plan/policy.yaml`'s `sweep.reviewLanes`
   * row) — the split changes NO effective behavior by itself, only who controls the
   * number, and the flip is reversible AS DATA, never a src edit plus CI plus
   * deploy. Sourced OUTSIDE `src/lib/policy.ts`'s `PolicyValues`/
   * `loadDefaultPolicy` schema deliberately: this task's own declared `files:` is
   * `src/lib/sweep.ts` + `plan/policy.yaml` + one test file, and extending that
   * schema is a second concern this shard does not reopen (design (i): "ONE
   * CONCERN") — see {@link loadReviewLanesPolicy}'s own doc.
   */
  reviewLanes: number;
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
   * W1-T330: this is now literally true — `plan/policy.yaml`'s `sweep.dailyCostCeilingUsd`
   * row is the source of the default below (read via {@link loadDefaultPolicy}), not a
   * source literal. The relocation retunes nothing; the value stays whatever the row carries.
   */
  dailyCostCeilingUsd: number;
  /**
   * W1-T1038 (the 2026-08-19 host stall) — a DAILY-GOVERNOR TWIN of {@link dailyCostCeilingUsd}
   * immediately above, ONE FIELD APART BY DESIGN: same "policy-as-data, dispatch-only,
   * never gates drainage" shape, but the OPPOSITE fail direction on an unreadable observation —
   * see {@link checkMemoryGovernor}, this row's consumer, and `dispatch-governor.ts`'s
   * `checkDispatchGovernors`, which enforces that opposite direction at the composition point.
   * Below this many MiB of `/proc/meminfo`'s `MemAvailable`, NEW dispatch is deferred; at or
   * above it, dispatch proceeds. SHIPS AT 0 (`plan/policy.yaml`'s row) — inert, since
   * `MemAvailable` can never read below zero, until an operator raises it against a measured
   * figure this task's own rationale says does not exist yet.
   */
  memoryFloorMib: number;
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
  /**
   * How long an otherwise-mergeable PR may sit with a COMPLETELY EMPTY check rollup before the
   * ABSENT-check-suite remedy fires. This is the ABSENT-vs-PENDING discriminator's time half —
   * see {@link absentChecksRepushDecision} for why a time bound is required at all.
   */
  absentCeilingMinutes: number;
  /**
   * W1-T225 (the 2026-07-21 PRs #477/#484 jam) — the ESCALATION THRESHOLD for the
   * review-orphaned-by-push remedy: once a PR's `priorReviewOrphans` count
   * (prior DISTINCT REVIEWABLE DIFFS — W1-T1018 design (iv); see `priorReviewOrphans`'
   * own doc — that already spent one orphan re-review) reaches this cap, the sweep
   * escalates for visibility. A ROW in this table (rule 2, policy-as-data), never a
   * constant buried in the predicate. Set at the SAME default as `strikeCap` —
   * bounded enough to catch a genuinely looping push/re-review cycle, generous
   * enough that ordinary iteration (a handful of legitimate follow-up pushes) never
   * trips it by accident.
   *
   * W1-T1018 (operator ruling 2026-08-19 — "I don't really like the idea of a review
   * budget. We just need back off."): reaching this cap NO LONGER stops the sweep
   * re-dispatching the review lane permanently — that was the defect (rationale (1)-(4)):
   * a bound firing on a HEALTHY condition (a repaired base, checks green, diff sound)
   * walled a good PR off forever. See {@link reviewOrphanBackoffMinutes} for what
   * replaces the cessation: escalate AND keep going, never one instead of the other.
   */
  reviewOrphanCap: number;
  /**
   * W1-T1018 (design (i)/(ii)) — THE ELAPSED-TIME BACKOFF that replaces the old
   * permanent cessation `reviewOrphanCap` alone used to enforce. Once `priorReviewOrphans`
   * reaches `reviewOrphanCap` the sweep still escalates (visibility never goes away —
   * design's own words: "the cap's one genuine virtue is that it asks a human for
   * help"), but the review lane resumes dispatching once this many minutes have
   * elapsed since the lane's last real attempt ({@link OpenPrView.reviewOrphanLastAttemptAt}
   * — see {@link reviewOrphanBackoffElapsed}, the predicate this row feeds). KEYED TO
   * ELAPSED TIME, NEVER ATTEMPT COUNT (design note verbatim: "a delay keyed to the
   * number of attempts is a budget with pauses — it still exhausts monotonically and
   * still ends in permanent silence"). A ROW in this table (rule 2, policy-as-data).
   * NET-NEW, and deliberately NOT sourced from `plan/policy.yaml` (this task's own
   * declared file list is `src/lib/sweep.ts` + `src/run-task.ts` + the two test
   * files only) — a hardcoded literal in {@link DEFAULT_SWEEP_POLICY}, the same
   * choice `pendingCeilingMinutes` above already made.
   */
  reviewOrphanBackoffMinutes: number;
  /**
   * W1-T905 — "repair the instance, FILE THE CLASS" (fb-1784842083584-6cc22a, second half). A
   * classified surface (a `sweep.disposed` row's own `disposition`) that at least this many
   * DISTINCT PRs have been REPAIRED for (`acted: true`) inside {@link repairFilingWindowDays}
   * is due for exactly ONE `repair#<surface>` §7B feedback entry — see {@link dueRepairFilings},
   * this row's consumer. "One occurrence is a repair, a recurrence is a defect" (design note ii):
   * a threshold of 1 would file on the very first repair, which this row's own
   * `plan/policy.yaml` bound (min 2) forecloses.
   */
  repairFilingThreshold: number;
  /** W1-T905 — the RECURRENCE WINDOW (days) {@link repairFilingThreshold} counts distinct-PR
   *  repairs within. See {@link dueRepairFilings}. */
  repairFilingWindowDays: number;
  /**
   * W1-T920 — gates the SUPERSESSION disposition row in {@link DISPOSITION_RULES}: with this
   * `false` (the default), `OpenPrView.supersessionVerdict` is never consulted and the row never
   * matches, byte-for-byte today's behaviour, no matter what a verdict says. `true` lets a
   * `"superseded"` verdict (never a bare "unique"/"indeterminate" one, and never the PR's own
   * resemblance to another) close the PR. A ROW in this table, not a special-cased read outside
   * it (unlike `sweep.armSessionPrs`, which gates an ARM task-id resolution rather than a
   * disposition): this flag governs exactly the same kind of threshold `staleDays` already does
   * for the row immediately below it, so it lives beside it.
   */
  supersessionDisposalEnabled: boolean;
  /**
   * W1-T932 — gates whether a `"unique"` {@link SupersessionVerdict} may let the BARE-NUMBER
   * `stale` row in {@link DISPOSITION_RULES} YIELD, so a concept PR is not disposed stale merely
   * because a higher-numbered sibling concept is also open (the arithmetic in `run-task.ts`'s
   * `resolveOpenPrTaskId` sets `supersededBy` on EVERY lower-numbered peer sharing a task,
   * unconditionally — see this task's own rationale (1)). `false` (the default) preserves
   * today's behaviour byte-for-byte: the bare-number row matches on `supersededBy != null`
   * alone, no matter what any verdict says.
   *
   * DELIBERATELY A SEPARATE FLAG FROM {@link supersessionDisposalEnabled} immediately above, not
   * a second use of it: that flag governs whether a verdict may CLOSE a PR (row 0's own
   * `"superseded"` match); this one governs whether a verdict may SAVE one from row 1's
   * arithmetic instead. Two different blast radii — closing the wrong PR loses work outright,
   * while wrongly sparing one merely leaves an ordinary duplicate open a sweep pass longer — so
   * each gets its own row and its own gate (design note ii: "a guard that works for ordinary
   * duplicate PRs must keep working").
   *
   * Reads ONLY `pr.supersessionVerdict?.status === "unique"` — the verdict's own POSITIVE
   * "checked, found no supersession" finding (see {@link SupersessionStatus}'s own doc), never
   * `"indeterminate"` (an unreadable read is not a finding, design note iii) and never an absent
   * verdict. FAILS CLOSED: no verdict, or one whose `status` is not literally `"unique"`, leaves
   * the bare-number row matching exactly as it does today — an ordinary duplicate PR (which
   * carries no verdict at all) is still disposed stale by that row regardless of this flag.
   *
   * NET-NEW, and deliberately NOT sourced from `plan/policy.yaml` (unlike
   * `supersessionDisposalEnabled` above): this task's own declared file list is
   * `src/lib/sweep.ts` + `test/sweep.test.ts` only, so this default lives as a hardcoded literal
   * in {@link DEFAULT_SWEEP_POLICY} — mirrors how `pendingCeilingMinutes` (below) stays a
   * literal rather than a collected policy row.
   */
  conceptCoexistenceEnabled: boolean;
  /**
   * W1-T984 — GATES THE `conflicted` DISPOSITION ROW, MIRRORING `supersessionDisposalEnabled`
   * EXACTLY (a policy-as-data flag, default FALSE, that a row's `when` conjuncts on). Wiring a
   * real per-PR conflict-evidence producer (`hydrateMergeConflictEvidence`, lib/open-prs-rest.ts)
   * makes {@link OpenPrView.mergeConflict} populated for the first time in production — but
   * {@link isPureConcurrentAddition} counts DELETIONS ONLY, so it CANNOT distinguish a genuine
   * pure-concurrent-addition from an add/add collision (two sides adding the SAME PATH with
   * DIFFERENT content, where the merge-base has no version of the file at all, so both deletion
   * counts are structurally zero — see that predicate's own doc). Admitting on that untrusted
   * signal is a judgement call this task has no evidence to make (rationale (5)/(6)): the design
   * intends the dispatched fix worker to be the SECOND, semantic gate, but that refusal path has
   * never once been exercised, and the only two reconstructible admits on record are BOTH
   * semantic collisions. `false` (the default) keeps disposition byte-for-byte what it was before
   * evidence ever flowed: a dirty PR still falls to the `blocked-ambiguous` row beneath this one,
   * now naming the real conflicting paths instead of "none captured", but never auto-dispatched.
   * `true` is a LATER task's call (design note viii(b)), once the semantic predicate exists.
   *
   * NET-NEW, and deliberately NOT sourced from `plan/policy.yaml` — the same choice
   * `conceptCoexistenceEnabled` immediately above already made and recorded: a hardcoded literal
   * in {@link DEFAULT_SWEEP_POLICY}, which keeps `plan/policy.yaml` out of this task's `files:`.
   */
  mergeConflictAdmissionEnabled: boolean;
}

/**
 * The default policy — 14-day stale window, 2 fix strikes (mirrors
 * fixStrikeCap), 10-PR WIP limit, 2 dispatch lanes (W1-T172, start N=2),
 * 60-minute pending ceiling, $500/day cost ceiling. The default is a BOUNDED
 * fail-safe (rule 2: an absent policy value falls back to a bounded default,
 * never unbounded spend), RAISED from $150 to $500 on 2026-08-04 after the
 * governor fired in production for the first time — $152.28 observed against
 * the $150 ceiling, deferring every dispatch (`daemon.cost_governor` /
 * `dispatch_deferred_budget`, run DAEMON-1785853416568) — on a day whose spend
 * was roughly ten times the prior day's. The $150 figure predated any
 * measurement of a heavy day.
 *
 * THE TRADE-OFF IS DELIBERATE AND MUST NOT BE MISREAD: at $500 this ceiling
 * would NOT by itself have caught the $206/60-run W1-T1 incident, which the
 * $150 figure was chosen against. It remains a bound on RUNAWAY spend, not a
 * budget — the per-run `DEFAULT_BUDGET_USD` cap and the INDEPENDENT headroom
 * governor are the other two limits, and the headroom window was at 28% of a
 * 95% limit when this was raised, nowhere near binding.
 *
 * W1-T253 (P37 CONSUMERS): `staleDays`/`strikeCap`/`wipLimit` are three fields that task's
 * substrate (W1-T252) collected into `plan/policy.yaml` — read here via {@link
 * loadDefaultPolicy} (self-locates the policy file from its own install location, never cwd)
 * rather than a source literal, so a plan-reviewed policy edit retunes them with zero code
 * change. W1-T325 collects `dispatchLanes` the same way, closing the gap its own doc comment
 * (above) and W1-T170/W1-T172's merged task notes already described as a policy row while the
 * source still carried a literal. W1-T330 collects `dailyCostCeilingUsd` the same way — a
 * RELOCATION, not a retune (the value is unchanged at whatever plan/policy.yaml's row carries).
 * `pendingCeilingMinutes` is NOT a collected constant for this task and stays exactly as it was.
 * W1-T1049 collects `reviewLanes` similarly (a plan-data row a reviewed PR retunes with zero
 * code change) but DELIBERATELY NOT via {@link loadDefaultPolicy}/`POLICY_SWEEP` above — see
 * {@link loadReviewLanesPolicy}'s own doc for why this one field reads `plan/policy.yaml`
 * directly instead of through `src/lib/policy.ts`'s schema.
 *
 * W1-T331 — `dailyCostCeilingUsd` ON THIS OBJECT IS FROZEN AT IMPORT, DELIBERATELY UNCHANGED BY
 * THAT TASK: `loadDefaultPolicy()` below runs once, at module load, and this const is never
 * rebuilt afterward — a RUNNING daemon holds whatever value was current at its own boot no
 * matter how `plan/policy.yaml` changes later (W1-T330 put the ceiling IN the policy row; it did
 * not make a live process re-read that row). `checkCostGovernor`'s own doc, immediately below,
 * covers who reads the ceiling LIVE instead: `run-task.ts`'s `costGovernorGateFor` resolves a
 * per-consultation `dailyCostCeilingUsd` argument when the daemon's tick loop supplies one
 * (`daemon.ts`'s `runDaemon`, via the injected `reloadDailyCostCeilingUsd` dep, snapshotted once
 * per tick), falling back to THIS frozen default only when no live value is available (e.g. the
 * bounded `rmd drain` one-shot path, or a caller that never wires the reload dep at all). This
 * default therefore stays exactly what its name says — the SHIPPED default / degraded-read
 * fallback — never the live daemon's operative ceiling.
 */
const POLICY_SWEEP = loadDefaultPolicy().values.sweep;

/**
 * W1-T1049 — reads `plan/policy.yaml`'s `sweep.reviewLanes` row DIRECTLY, never through
 * `src/lib/policy.ts`'s `loadDefaultPolicy`/`PolicyValues` schema `POLICY_SWEEP` above goes
 * through. That module is deliberately NOT one of this task's declared `files:`
 * (`src/lib/sweep.ts` + `plan/policy.yaml` + `test/review-lane-budget.test.ts` only) —
 * registering a new field in its `PolicyValues` interface and `EXPECTED_ORIGIN_KIND` registry
 * is a second concern this shard does not reopen (design (i): "ONE CONCERN").
 *
 * Validated the SAME way `policy.ts`'s own (unexported) `numberField` validates every other
 * bounded numeric row — finite `value`/`min`/`max`, `min <= value <= max` — so a malformed row
 * fails LOUD at load, exactly like every other policy row in this repo, never a silent
 * fallback that could mask a bad edit (rule 2: an absent/malformed policy value is a refused
 * load, not unbounded or silently-default behavior). `installPolicyPath`/`PolicyError` are
 * both pre-existing exports of `policy.ts` — referencing them is not an edit to that file.
 */
export function validateReviewLanesRow(row: unknown): number {
  if (typeof row !== "object" || row === null) {
    throw new PolicyError(`policy.yaml: 'sweep.reviewLanes' must be a mapping with 'value'/'origin'/'min'/'max'.`);
  }
  const { value, min, max } = row as Record<string, unknown>;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolicyError(`policy.yaml: 'sweep.reviewLanes.value' must be a finite number, got ${JSON.stringify(value)}.`);
  }
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new PolicyError(
      `policy.yaml: 'sweep.reviewLanes' must carry numeric 'min' and 'max' bounds — finite ones ` +
        `(got min=${JSON.stringify(min)}, max=${JSON.stringify(max)}).`,
    );
  }
  if (min > max) {
    throw new PolicyError(`policy.yaml: 'sweep.reviewLanes' has min (${min}) > max (${max}) — an unsatisfiable bound.`);
  }
  if (value < min || value > max) {
    throw new PolicyError(
      `policy.yaml: 'sweep.reviewLanes.value' (${value}) is out of its declared bound [${min}, ${max}].`,
    );
  }
  return value;
}

/** Reads the row {@link validateReviewLanesRow} validates. Split from it so every refusal arm
 *  above is reachable from a test without a temp policy file on disk — the file read stays here,
 *  the decisions stay there. */
function loadReviewLanesPolicy(): number {
  const path = installPolicyPath();
  const raw = parseYaml(readFileSync(path, "utf8")) as { sweep?: { reviewLanes?: unknown } } | null;
  return validateReviewLanesRow(raw?.sweep?.reviewLanes);
}
const REVIEW_LANES_DEFAULT = loadReviewLanesPolicy();

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  staleDays: POLICY_SWEEP.staleDays,
  strikeCap: POLICY_SWEEP.strikeCap,
  clarify: DEFAULT_CLARIFY_POLICY,
  wipLimit: POLICY_SWEEP.wipLimit,
  dispatchLanes: POLICY_SWEEP.dispatchLanes,
  reviewLanes: REVIEW_LANES_DEFAULT,
  dailyCostCeilingUsd: POLICY_SWEEP.dailyCostCeilingUsd,
  // W1-T1038: collected off plan/policy.yaml's own row (POLICY_SWEEP, above), the same relocation
  // dailyCostCeilingUsd/wipLimit/dispatchLanes already made — never a source literal.
  memoryFloorMib: POLICY_SWEEP.memoryFloorMib,
  pendingCeilingMinutes: 60,
  // 10 minutes: an order of magnitude above the observed push->first-check-registers latency
  // (seconds), and far below the 7h45m #921 sat in its silent loop.
  absentCeilingMinutes: 10,
  reviewOrphanCap: 2,
  // W1-T1018: 2 hours — long enough that a genuine repair (a base fix, a contradiction fix, an
  // operator's own intervention) has real time to land before the lane retries again, short
  // enough that a PR which does heal is not left silent for a whole day waiting on it.
  reviewOrphanBackoffMinutes: 120,
  repairFilingThreshold: POLICY_SWEEP.repairFilingThreshold,
  repairFilingWindowDays: POLICY_SWEEP.repairFilingWindowDays,
  supersessionDisposalEnabled: POLICY_SWEEP.supersessionDisposal,
  // W1-T932: NOT sourced from plan/policy.yaml (see the field's own doc, above) — a hardcoded
  // literal, off, exactly like `pendingCeilingMinutes` above it in this same object.
  conceptCoexistenceEnabled: false,
  // W1-T984: NOT sourced from plan/policy.yaml (see the field's own doc, above) — a hardcoded
  // literal, off, the same choice `conceptCoexistenceEnabled` just above already made.
  mergeConflictAdmissionEnabled: false,
};

/**
 * W1-T923 — one GATE failure (never an unmet acceptance criterion — see
 * {@link OpenPrView.actionableGateFailures}'s own doc) whose remedy is a SINGLE,
 * unambiguous form, so the fix rung can act on it directly. `reason` is carried
 * VERBATIM from the ledger's structured `reasons` array (the SAME array
 * {@link CriterionVerdict.reason} is built from for an unmet criterion) — never
 * parsed out of `failure_reason` prose (design note vi: structured, or honestly
 * absent, never a regex over free text presented as robust).
 */
export interface ActionableGateFailure {
  reason: string;
}

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
  /**
   * W1-T913 — THE OWNERSHIP RECORD'S OTHER HALF (the ledger side lives in `lib/review.ts`'s
   * `review.pending_posted` line / {@link "./review.js".lastPendingReviewStatusFromLedger}): the
   * `ts` this run's `postReviewPending` posted its CURRENT-head pending at, when `reviewState ===
   * "pending"`. This is the staleness clock the post-review disposition row below needs — a naive
   * pending post would make `reviewState` read "pending" forever and the post-review row (which
   * used to key on `reviewState === "none"` alone) would never offer this head again, silently
   * stranding a PR whose owning run died mid-review. `undefined` when unreadable (rotation lost
   * the line, or the record belongs to a DIFFERENT head than the one currently observed) —
   * deliberately read as STALE, never as fresh, by {@link reviewPendingIsStale}: the safe
   * direction here is re-driving an already-finished review (idempotent — see
   * `postReviewPending`'s own no-op-per-head guard), never stranding one whose state we can't
   * date.
   */
  reviewPendingSince?: string;
  /**
   * The unmet acceptance criteria from a failing review ([] otherwise). W1-T456: for a
   * task-id-less PLAN-FILING PR (no `Remudero-Task:` trailer, #1527) `buildOpenPrViews` can
   * ALSO populate this from the ledger, keyed by the same synthetic `PR-<n>` id
   * `reviewCommand`/`escalationTaskIdFor` already use for every task-id-less review — see that
   * function's own doc. A non-empty list here is what lets row 6 below route a filing's REAL
   * failure to `blocked-fixable` (resolvable by the fix rung) instead of always falling to row
   * 7's escalate-only "criteria unrecoverable" — WITHOUT widening what `criteriaRecoverable`
   * (right below) means: that field stays keyed strictly to a resolved `taskId`, on purpose.
   */
  unmetCriteria: CriterionVerdict[];
  /**
   * W1-T440: true when a `Remudero-Task:` trailer resolved a task id, so `unmetCriteria`
   * above reflects an ACTUAL ledger read (`unmetFromLedger` was consulted — see
   * `buildOpenPrViews`); false when no trailer resolved, so `unmetCriteria` is `[]` BY
   * CONSTRUCTION and was never checked at all. Row 7 of {@link DISPOSITION_RULES} reads this
   * to say which empty a failing review with no unmet criteria actually is — a genuine
   * contradiction (criteria WERE checked and none came back unmet) versus an unrecoverable
   * one (there was no trailer to check them against). `undefined` (no producer has set it,
   * e.g. an older fixture) is treated the SAME as `true` — the pre-existing "contradictory"
   * wording — so this is additive, never a silent behavior change for an unset field.
   *
   * DELIBERATELY NOT WIDENED by W1-T456's filing-PR ledger read above: that read can populate
   * `unmetCriteria` for a task-id-less PR too, but this field still answers ONLY "did a
   * `Remudero-Task:` trailer resolve a task id" — test/openpr-taskid-resolver.test.ts locks a
   * plan-only filing PR to `criteriaRecoverable: false` regardless, so widening this field's
   * meaning would read as silently crediting an unattributed PR, which #1527 forbids.
   */
  criteriaRecoverable?: boolean;
  /**
   * W1-T923 — a SIBLING list to {@link unmetCriteria}, never a widening of it. The motivating
   * gap: PR #1991 failed review with `unmet_criteria: []` (every acceptance criterion passed,
   * 12/12 `executed_pass`) yet its `failure_reason` named the exact remedy — a GATE failure,
   * not an unmet criterion, so both `blocked-fixable` rows below (`unmetCriteria.length > 0` /
   * `isBlockedCi`) missed it and it fell to row 7's escalate-only "criteria unrecoverable/
   * contradictory", where NOTHING about the named remedy is ever read. This list is what a
   * gate failure's OWN structured remedy populates instead.
   *
   * ONE ENTRY PER GATE FAILURE WITH A SINGLE-FORM REMEDY ONLY (design note iv): a remedy that
   * offers a CHOICE between forms (#1991's own falsifier — the provenance check accepted either
   * `Chosen (RECOMMENDED, auto)` OR an operator-attribution line, crediting different authors) is
   * EXCLUDED from this list entirely, never included-but-flagged — a worker picking the wrong one
   * of several named options misattributes a ratified ruling, which is worse than asking a human.
   *
   * NEVER KEYED ON `failure_class` (design note v): PR #1991 is classed `test_theater` — the
   * class this design would otherwise treat as unautomatable — while its `failure_reason` names
   * two exact strings; keying on that field alone mis-sorts the very case this list exists for.
   * Whatever populates this list must key on the STRUCTURED presence of a single-form remedy,
   * never on which bucket the classifier sorted the failure into.
   *
   * `criteriaRecoverable` (immediately above) is DELIBERATELY untouched by this field's own
   * producer — a PR can carry `unmetCriteria: []`, `criteriaRecoverable: false` (no trailer to
   * resolve criteria from) AND a non-empty `actionableGateFailures` all at once; that combination
   * stays legible rather than being collapsed into one signal (design note i).
   *
   * `[]`/undefined when no gate failure named a single-form remedy — DISPOSITION_RULES' row 7
   * (blocked-ambiguous, "no actionable unmet criteria") stays byte-identical for every PR that
   * does not carry this list (design note iii).
   */
  actionableGateFailures?: ActionableGateFailure[];
  /** Fix-rung strikes ALREADY attempted for this PR (from the ledger). */
  priorStrikes: number;
  /** A NEWER open PR crediting the same task supersedes this one. */
  supersededBy?: number;
  /**
   * W1-T920 — a {@link SupersessionVerdict} for this PR, gated behind
   * `policy.supersessionDisposalEnabled` (default OFF) in `DISPOSITION_RULES`'s supersession row.
   * Distinct from {@link supersededBy} immediately above: that field is a bare NUMBER, matched
   * unconditionally (no policy gate) purely on "a newer open PR shares this task's trailer" — the
   * kind of IDENTITY match design note (ii) forbids relying on alone (the #1873/#1874 falsifier:
   * byte-identical titles and file lists, the better one decided by an ARGUED difference, never a
   * match). This field instead carries a REASON — evidence a detector is expected to have
   * verified before ever claiming `"superseded"` — and the rows it feeds read ONLY `status`,
   * never any of the PR's own fields, so two PRs identical in every OTHER respect are still
   * disposed however their OWN verdicts read.
   *
   * TWO CONSUMER ROWS as of W1-T932, not one: the original CLOSE row (`status === "superseded"`,
   * gated by `policy.supersessionDisposalEnabled`) and a second row that lets the bare-number
   * `supersededBy` row YIELD when `status === "unique"`, gated separately by
   * `policy.conceptCoexistenceEnabled` — see that field's own doc for why the gates are kept
   * apart.
   *
   * SCOPE (honest, mirrors how `pendingAnswer`/`isPlanFiling` shipped their mechanism ahead of
   * their producer): this field, {@link SupersessionVerdict}, and its `DISPOSITION_RULES` rows
   * are the full MECHANISM, wired end-to-end and unit-tested here — but nothing in `run-task.ts`
   * populates it yet. THE DETECTOR (a trailer scan + diff comparison, per design note (iv)'s
   * corpus-control requirement) is a SEPARATE, out-of-scope shard (this task's own design note,
   * "WHAT MUST NOT BE BUILT") — `supersessionVerdict` is therefore always `undefined` in the real
   * gateway today, so neither flag being ON changes anything in production until that detector
   * lands and wires a producer here. See `KNOWN_UNWIRED` (lib/producer-completeness.ts).
   */
  supersessionVerdict?: SupersessionVerdict;
  /** ISO-8601 timestamp of the PR's last activity (for the stale window). */
  lastActivityAt: string;
  /**
   * W1-T1201 — ISO-8601 timestamp of the PR's CREATION, read ONLY by {@link deriveDisposition}'s
   * age clamp: A PR CANNOT BE IDLE LONGER THAN IT HAS EXISTED, so the age fed to
   * `DISPOSITION_RULES` is the LESSER of "days since last activity" and "days since this
   * timestamp" — the incident this closes: eleven live PRs, hours old, were closed `abandoned —
   * no activity in 400d` by a shifted-clock test run, because `ageDays` (derived from
   * `lastActivityAt` alone) had no upper bound relative to the PR's own creation.
   *
   * OPTIONAL so every existing fixture and producer stays valid — absent or unparseable reads as
   * NO bound (today's pre-clamp arithmetic, unchanged), never as "just created", the same
   * fail-toward-today's-behaviour default this module gives every field a caller hasn't wired
   * yet (mirrors `checksPendingSince`/`supersessionVerdict` — see `KNOWN_UNWIRED`,
   * lib/producer-completeness.ts).
   */
  createdAt?: string;
  /** The head commit sha — keys fix-dispatch idempotence (a new push re-earns a strike). */
  headSha: string;
  /** The head BRANCH name. Needed by the ABSENT-check-suite remedy, which pushes an empty
   *  commit to this branch to mint a fresh head sha. Already fetched by the real gateway
   *  (`isDependabot` reads the same field); optional so every existing fixture stays valid. */
  headRefName?: string;
  /** Observed: is GitHub auto-merge already armed on this PR? */
  autoMergeArmed: boolean;
  /** Head ref starts with `dependabot/` — routed to the W1-T54 dep-review lane
   * (its own deterministic judge), NEVER the fix rung (which would push commits
   * onto a Dependabot branch) and never the clarification rung. */
  isDependabot?: boolean;
  /**
   * W1-T528: is this PR a DRAFT? The operator's hold, and — once GitHub's own auto-merge is
   * armed — the ONLY veto {@link selectUpdateBranchTarget} still has to check for itself
   * (a red/blocked/already-current PR is already excluded by {@link armedButStalled}'s own
   * two-fact filter, never re-checked here). `true` excludes a PR from that selection; unset
   * reads as "not a draft", the SAME fail-open default this module applies to every other
   * unread fact (e.g. an unread `mergeState`, {@link armedButStalled}'s own doc).
   *
   * PRODUCER WIRED: `mapRestPr` (lib/open-prs-rest.ts) carries GitHub's `draft` through as
   * `OpenPrRest.isDraft`, and `buildOpenPrViews` (run-task.ts) assigns it here, so the
   * exclusion below fires against the real gateway rather than only in unit tests. This
   * shipped one PR later than the mechanism: the original W1-T528 `files:` (Rule 19)
   * excluded `lib/open-prs-rest.ts`, which left the field with NO producer and failed
   * `test/producer-completeness.test.ts` — the standing check that stops an unwired tenth
   * field from landing silently. Wiring it was the smaller correction, because the field
   * guards an ACTION (this is the only thing standing between the update rung and a PR the
   * operator has deliberately put on hold), so allowlisting it in `KNOWN_UNWIRED` would have
   * shipped an inert safety exclusion.
   *
   * `draft` IS returned by the `/pulls` LIST endpoint — it is part of GitHub's
   * `pull-request-simple` schema, unlike {@link RestPullRow.merged}, whose absence from list
   * rows caused the 2026-07-31 merged-ness incident. `undefined` therefore means "GitHub
   * omitted it", not "not a draft"; the check below is `=== true`, so an absent field leaves
   * a PR eligible for update. That fail-open direction is deliberate and narrow: GitHub
   * refuses to arm auto-merge on a draft in the first place, and only ARMED PRs reach here,
   * so the exposure is an operator drafting an already-armed PR.
   */
  isDraft?: boolean;
  /**
   * W1-T196: true when this PR is a plan-FILING PR — one that introduces new
   * task(s) into `plan/tasks.yaml` and, per W1-T136 criterion 5, deliberately
   * carries NO `Remudero-Task:` trailer (lib/plan-pr-emitter.ts's correctness
   * rule: crediting a filing PR's own trailer would mark the task it just
   * filed DONE on merge, before it is ever built). A `taskId`-unresolved PR
   * with this true is a KNOWN, non-emergency attribution gap — the sweep
   * stands down instead of escalating a `[BLOCKED] UNKNOWN: PR #...` issue
   * with no operator-decidable question (the #440 fixture). MUST be a
   * POSITIVE signal read from the emitter's own output (e.g. the
   * `filingAcceptanceCriteria` claim text uniquely present in a filing PR's
   * body) — never inferred from the absent trailer alone (that would also
   * swallow a genuinely broken/missing trailer on an IMPLEMENTING PR, a real
   * defect worth surfacing) and never inferred from the diff touching only
   * `plan/**` (a hand-authored plan PR would misclassify).
   *
   * SCOPE (honest, mirrors how `pendingAnswer`/`reviewOrphanedByPush` shipped
   * their mechanism ahead of their producer): this field and the stand-down
   * it drives in `runSweep` are the full MECHANISM, wired end-to-end and
   * unit-tested here — but `run-task.ts`'s `buildOpenPrViews` does not
   * populate it yet. Until that producer wiring lands, this is always
   * `undefined` in the real gateway, so every unattributable PR keeps
   * escalating exactly as before this field existed (fail-open toward
   * surfacing, never silently swallowing a real defect by omission).
   */
  isPlanFiling?: boolean;
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
   * GitHub's OWN raw `mergeable` boolean, observed verbatim (W1-T186 — the #412/#413 fixture: a
   * PR reading `mergeable: false, mergeable_state: "dirty"` registers ZERO check runs BY
   * CONSTRUCTION, so an escalation that only ever had `checksState`/`reviewState` to read from
   * could not help but describe that as a checks/review problem). Carried ALONGSIDE the
   * already-simplified {@link mergeState} rather than replacing it — every existing
   * `mergeState === "dirty"` disposition row is unchanged — so the escalation renderer can name
   * the exact fact GitHub reported, not just the bucket it was sorted into. `undefined` when
   * unread, same fail-closed default as `mergeState`.
   */
  mergeable?: boolean;
  /**
   * GitHub's OWN raw `mergeable_state` string ("clean" | "dirty" | "blocked" | "behind" |
   * "unstable" | "unknown" | ...), observed verbatim (W1-T186, alongside {@link mergeable}
   * above) — the escalation names THIS exact reported value, never just the simplified
   * {@link MergeState} bucket it was derived into.
   */
  mergeableState?: string;
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
  /**
   * W1-T176 (the #393/#391 fixture): true when the ledger already carries a
   * `review.post_refused` outcome for THIS EXACT head (`taskId@headSha`) —
   * the deterministic `rmd review` post (the post-review disposition, row
   * below) was already attempted once for this push and DECLINED, so
   * GitHub's live rollup still shows zero check runs for the required
   * review context. Distinguishes a FIRST-SEEN zero-runs required check
   * (still routes to post-review — the deterministic-action lane, since an
   * absent required check is mechanically decidable: "post it") from a
   * SECOND absence at the SAME sha, which the discriminator below escalates
   * instead of retrying — `postReviewStatusGuarded`'s own guard never
   * self-retries a refusal, so a second poll observing this true means the
   * one deterministic remedy already ran its course for this exact push;
   * looping would just re-invoke a lane that has already declined once.
   * `review.post_failed` (a transient `gh` error, not a refusal) deliberately
   * does NOT set this — that case must keep retrying, never escalate on a
   * mere network hiccup. A NEW push mints a new head sha, so this reverts to
   * `false`/`undefined` and the PR re-earns one fresh deterministic attempt.
   * Populated by the real gateway (run-task.ts's `buildOpenPrViews`) from the
   * SAME ledger read it already does for `unmetCriteria`/`priorStrikes`;
   * `undefined` in any caller that hasn't wired it (e.g. `rmd fix`'s
   * single-PR build, which never reaches the post-review row at all) reads
   * as "no refusal recorded," never escalates by omission.
   */
  reviewPostRefused?: boolean;
  /**
   * W1-T176 (design boundary (ii)): true when THIS sweep pass could not read
   * branch protection's required-contexts list (`ghRequiredStatusCheckContexts`
   * returned `undefined`/empty — a missing rule, an unprivileged token, `gh`
   * itself unreachable). Gates the zero-runs discriminator rows (the row above
   * and the post-review row below) OFF: without a readable required-contexts
   * list we cannot POSITIVELY confirm remudero-review is even required on this
   * branch, so classifying its absence as a decidable "post it" action would be
   * assuming permissive on missing information — the one thing design boundary
   * (ii) forbids ("an unreadable gate must never be assumed permissive").
   * `undefined`/`false` (the default every existing caller/fixture implicitly
   * uses) behaves exactly as before this field existed — both rows apply
   * normally. `true` routes a checks-green/review-none PR past both rows to
   * the ordinary catch-all rows below, which still classify it
   * blocked-ambiguous (never silently mergeable) — the SAME escalate path,
   * never a new one.
   */
  requiredContextsUnreadable?: boolean;
  /**
   * W1-T225 (the 2026-07-21 PRs #477/#484 jam): true when the ledger already
   * carries a `review.posted` (or `review.post_refused`) outcome for THIS
   * task at an EARLIER head sha than {@link headSha} — i.e. this PR HAS been
   * reviewed before, just not on the head the sweep is looking at right now.
   * Distinguishes a PR whose review was ORPHANED BY A PUSH (reviewed once,
   * then silenced by a later commit) from one AWAITING ITS FIRST REVIEW ever
   * (`undefined`/`false` — every existing caller/fixture that hasn't wired
   * this reads exactly as before: the post-review row still dispatches, just
   * with the original "review never posted" reason). Only changes the REASON
   * string the post-review row states and gates the {@link priorReviewOrphans}
   * cap row above it — never the dispatch itself: either way the remedy is
   * "run the review lane and post a fresh verdict for this head," and a
   * verdict from an earlier, now-superseded head is NEVER copied forward
   * (push-invalidates-review is not weakened by this field).
   *
   * SCOPE (honest, mirrors how `pendingAnswer` shipped its mechanism ahead of
   * its producer): this field, its {@link DISPOSITION_RULES} rows, and the
   * reason-string branch are the full MECHANISM, wired end-to-end and
   * unit-tested here — but nothing in `run-task.ts` populates it yet
   * (`buildOpenPrViews` would derive it the SAME way it already derives
   * `reviewPostRefused`: scan the ledger for a prior `review.posted`/
   * `review.post_refused` line for this `taskId` at a head sha OTHER than
   * the current one). Until that wiring lands, this is always `undefined` in
   * the real gateway, so every orphaned-by-push PR still reaches post-review
   * (correctly — the dispatch never depended on this field) with the
   * "review never posted" reason rather than the more specific one; it never
   * silently misclassifies as ambiguous or mergeable.
   */
  reviewOrphanedByPush?: boolean;
  /**
   * W1-T225 — THE LOOP FALSIFIER: how many PRIOR heads for this task already
   * spent one review-orphaned-by-push re-dispatch (i.e. reached `post-review`
   * with {@link reviewOrphanedByPush} true on an earlier push). Mirrors
   * `priorStrikes`'s shape exactly — a running ledger-derived count, never a
   * per-pass toggle — so a PR that keeps getting pushed, or whose re-review
   * keeps failing to stick, cannot re-dispatch the review lane unboundedly:
   * once this reaches `policy.reviewOrphanCap` the sweep escalates instead of
   * retrying (see the cap row in {@link DISPOSITION_RULES}, ordered before
   * post-review). `undefined` reads as `0` — a caller that hasn't wired this
   * yet (e.g. `rmd fix`'s single-PR build, or `run-task.ts` before its own
   * follow-up wiring lands — see {@link reviewOrphanedByPush}'s SCOPE note)
   * behaves exactly as before this field existed: the cap never trips on
   * missing information, fail-open toward "keep re-reviewing," never
   * fail-closed toward "escalate a PR that was never actually looping." The
   * real gateway would derive this from the SAME ledger scan that derives
   * `reviewOrphanedByPush`, counting the distinct prior heads it found.
   *
   * W1-T1018 (design iv): the real gateway (`run-task.ts`'s `reviewOrphansFor`) now counts
   * DISTINCT REVIEWABLE DIFFS among those prior heads, not distinct pushed heads — two heads
   * whose PR-own diff (against `main`) is byte-identical (a base-repair merge, the remedy this
   * system itself prescribes on a base-recovered notice) count as ONE, never two, so housekeeping
   * never spends the same budget a genuine retry does.
   */
  priorReviewOrphans?: number;
  /**
   * W1-T1018 (design i/ii/iii) — WHEN the review-orphan lane last actually ATTEMPTED this PR: the
   * most recent `review.posted`/`review.post_refused` ledger timestamp among the heads
   * `priorReviewOrphans` scanned (ISO string), across EVERY attempt whether or not that head's
   * diff counted toward the budget — a housekeeping push still runs the lane and still advances
   * this clock, which is what keeps the elapsed-time backoff ({@link reviewOrphanBackoffElapsed})
   * from decaying into the permanent cap it replaces (design iii: "reset on a real signal
   * change"). `undefined` reads as "no attempt on record" — {@link reviewOrphanBackoffElapsed}
   * treats that as backoff NOT elapsed, the SAME fail-toward-escalating default every other field
   * on this SCOPE-lagged surface uses (e.g. `priorReviewOrphans` reading `undefined` as `0`): a
   * caller that hasn't wired this yet (every caller today) behaves exactly like the pre-W1-T1018
   * permanent cap until a real timestamp exists to back off from.
   */
  reviewOrphanLastAttemptAt?: string;
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
  /**
   * When this attempt started (W1-T457). gh's own JSON exporter (cli/cli's `export_pr.go`)
   * populates this for BOTH rollup node shapes — a CheckRun's own `startedAt`, and a
   * StatusContext's mapped from `createdAt` — so it is present on every entry the real gateway
   * reports, and is what {@link dedupeRollupByLatestAttempt} sorts on.
   */
  startedAt?: string;
}

/**
 * Conclusions GitHub's OWN branch-protection merge-eligibility treats as
 * SATISFYING a required check (W1-T103, the #170 stuck-ambiguous fix): a
 * required check that reports SKIPPED or NEUTRAL still counts as green — only
 * a genuinely unresolved/incomplete check (anything not in this set and not a
 * failure below) holds checksState at "pending".
 */
const REQUIRED_CHECK_OK = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Conclusions that veto a required check outright — checksState goes "red". EXPORTED (W1-T457)
 * so run-task.ts's `fetchCiFailures` — the failing-list PRODUCER — filters on the exact SAME set
 * this file's checksState PREDICATE vetoes on, rather than hand-copying a narrower one that can
 * silently drift out of agreement (the #1728 defect: `checksState` read "red" off a CANCELLED
 * entry this set includes, while `fetchCiFailures` filtered to FAILURE|ERROR only and reported
 * nothing — a red predicate with an empty evidence list, dispatching the ci-log fix rung against
 * nothing to fix).
 */
export const REQUIRED_CHECK_FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/**
 * Group rollup entries by check name (a CheckRun's `name`) or commit-status context (a
 * StatusContext's `context`) and keep ONLY the entry with the latest {@link RollupCheckEntry.startedAt}
 * — the SAME rule `.github/workflows/ci-gate.yml`'s own dedupe already applies one surface over
 * (W1-T123, test/ci-gate-dedupe.test.ts's #242 fixture: `group_by(name) | map(max_by(started_at))`),
 * copied here rather than reinvented (W1-T457's design note (i): "the fix is to give the sweep the
 * rule the gate already has, not to invent one").
 *
 * WHY THIS IS NEEDED, MEASURED (W1-T457, PR #1728's HEAD 94c97e33): a SHA accumulates one rollup
 * entry PER ATTEMPT, not one per check name — `statusCheckRollup` reported TWO `ci-gate` entries
 * on that one sha, `completed/cancelled` started 13:48:42 and `completed/success` started
 * 13:50:02. Without this dedupe, {@link checksStateFromRollup} saw the stale CANCELLED entry (a
 * member of {@link REQUIRED_CHECK_FAIL}) and read "red" FOREVER even though the check's own
 * newest attempt had already gone green — a superseded attempt could never be outvoted by its own
 * successor.
 *
 * An entry with no `startedAt` at all sorts as OLDER than any timestamped entry sharing its key,
 * and a tie (including two entries both missing it) keeps the LAST one encountered — this
 * function's contract is only that duplicates collapse to exactly one row per name/context, never
 * that array order carries meaning on its own.
 */
export function dedupeRollupByLatestAttempt<T extends RollupCheckEntry>(rollup: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const c of rollup) {
    const key = c.name ?? c.context ?? "";
    const prior = latest.get(key);
    if (!prior || (c.startedAt ?? "") >= (prior.startedAt ?? "")) latest.set(key, c);
  }
  return [...latest.values()];
}

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
 *
 * `remudero-review` is EXCLUDED from the gate unconditionally (W1-T394, the
 * PR #1441 blocked-routing fix) — even when it IS a required context and even
 * in the unreadable-protection fallback above. `statusCheckRollup` mixes CHECK
 * RUNS (a CI job's own verdict) with COMMIT STATUSES, and `remudero-review` is
 * posted as a commit status carrying the REVIEW verdict, not a check run — it
 * already has its own dedicated derivation ({@link reviewStateFromRollup} in
 * run-task.ts, surfaced as `OpenPrView.reviewState`). Counting it here too made
 * a red review indistinguishable from a red required CI check: `isBlockedCi`
 * (below) went true on a review failure alone, routing the PR to the ci-log fix
 * rung — which has no failing job to read — and made the review-shaped
 * DISPOSITION_RULES row (`reviewState === "failure"`) unreachable, since the
 * checks-red row is ordered ahead of it and claimed every review failure too.
 * Every OTHER commit status (there is no second one this codebase tracks
 * separately) still counts — this exclusion is specific to the ONE context
 * that already has its own signal, never a general check-run/commit-status
 * split (that split is NOT in scope here — see the task's design note).
 *
 * DEDUPED BY {@link dedupeRollupByLatestAttempt} BEFORE JUDGING (W1-T457): a SHA can carry more
 * than one rollup entry for the SAME check name (one per attempt), and only the LATEST attempt's
 * conclusion should vote — a SUPERSEDED entry (e.g. a CANCELLED run of a check whose later
 * attempt on the same sha went SUCCESS) must never permanently veto this function's answer. See
 * that function's own doc for the measured live incident this closes.
 */
export function checksStateFromRollup(
  rollup: RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
): OpenPrView["checksState"] {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  if (all.length === 0) return "none";
  const required = new Set(requiredContexts ?? []);
  const knownRequired = required.size > 0;
  // W1-T457: dedupe to ONE entry per check name/context — the LATEST attempt — before this
  // gate is judged. Dedup never changes gate.length's zero-ness (grouping only merges rows
  // that share a key, it cannot invent or drop a key entirely), so the "required but not yet
  // registered" distinction just below is unaffected by it.
  const gate = dedupeRollupByLatestAttempt(
    knownRequired ? all.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? "")) : all,
  );
  // Required contexts are configured but none has registered on this head yet
  // (e.g. the workflow hasn't started) — waiting, not "no checks at all".
  if (gate.length === 0) return knownRequired ? "pending" : "none";
  // ONE OK-SET, KNOWN CONTEXTS OR NOT (2026-08-13). This used to narrow to `new Set(["SUCCESS"])`
  // whenever the required list was unreadable — an asymmetry that landed in the SAME commit as
  // REQUIRED_CHECK_OK (#196/W1-T103) and, unlike its sibling, carried no stated reason. It has none
  // available: REQUIRED_CHECK_OK's own doc is a claim about GITHUB'S merge-eligibility semantics —
  // "a required check that reports SKIPPED or NEUTRAL still counts as green" — and those semantics
  // do not change because OUR token could not read branch protection.
  //
  // WHAT THE ASYMMETRY COST, measured live: `ghRequiredStatusCheckContexts` fails SOFT to undefined
  // on any error, and a container's PAT gets 403 "Resource not accessible by personal access token"
  // on the protection endpoint (the mini's token returns ["remudero-review","ci-gate"]). So every
  // sweep in a container took this branch, and `osv-scanner`'s NEUTRAL — present on essentially
  // every PR here — read as PENDING FOREVER, because NEUTRAL never becomes SUCCESS. Issue #1698
  // escalated PR #1692 with "checks pending 65m (>= 60m ceiling)" while nothing was running, and
  // `rmd status` showed #1699 at "checks pending 237m". That is the 57-unretirable-issues shape
  // (see pendingAgeMinutes' doc) recurring with the bound firing LATE rather than never.
  //
  // NOT WIDENED TO A NEW `unknown` checksState, deliberately: `OpenPrView["checksState"]` is a
  // four-member union read at 17 comparison sites in this file, and a fifth member every existing
  // row silently fails to match is precisely the false-predicate-falls-through-to-a-row-that-acts
  // shape that produced the 57 issues in the first place. Aligning the sets changes one expression
  // and leaves the vocabulary alone. A genuinely unresolved check is in NEITHER set and still holds
  // `pending`, which is the property the strict fallback was reaching for.
  const ok = REQUIRED_CHECK_OK;
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
 *
 * `pr.checksState` is `"red"` ONLY for a required CHECK RUN failure (W1-T394,
 * the PR #1441 fix) — {@link checksStateFromRollup} excludes the
 * `remudero-review` commit status from the gate that derives it, so a red
 * review alone can never make this true. A review failure is read off
 * `pr.reviewState` instead, by DISPOSITION_RULES' separate review-shaped row.
 * This keeps `isBlockedCi`'s own contract exactly as documented above ("a
 * required check is red — the failing signal IS the CI log") true by
 * construction, for every caller listed here.
 */
export function isBlockedCi(pr: OpenPrView): boolean {
  return pr.checksState === "red";
}

/**
 * W1-T923 (design note iv) — given the STRUCTURED `reasons` a gate failure's ledger row
 * carried, decide whether it names a SINGLE, unambiguous remedy. Exactly one reason is one
 * automatable form and is copied through VERBATIM (never re-derived); zero or TWO-OR-MORE
 * reasons are excluded entirely — a remedy offering a CHOICE between forms (the #1991
 * falsifier: the provenance check accepted `Chosen (RECOMMENDED, auto)` OR an
 * operator-attribution line, crediting different authors) must be EXCLUDED from the
 * actionable list, not merely flagged inside it, because a worker acting on the wrong one
 * of several named options misattributes a ratified ruling — the file where a false claim
 * does the most damage.
 *
 * PURE AND EXPORTED so the "single form vs a choice" predicate has its OWN direct test
 * coverage, never only indirectly through the wider routing pipeline —
 * `run-task.ts`'s `actionableGateFailuresFromLedger` is the ONLY caller, mapping the
 * ledger's raw `reasons` array through this before it ever reaches
 * {@link OpenPrView.actionableGateFailures}. Reads NOTHING about `failure_class` — it never
 * even sees it — so a judgement-classed row (`test_theater`, the class #1991 itself carries)
 * qualifies exactly the same as any other, by construction (design note v).
 */
export function actionableGateFailuresFromReasons(reasons: readonly string[]): ActionableGateFailure[] {
  return reasons.length === 1 ? [{ reason: reasons[0] }] : [];
}

/**
 * W1-T527 — WHY a PR is red, which {@link isBlockedCi} deliberately does not ask. Four causes
 * reached the identical `blocked-fixable` dispatch, and only ONE of them is the fix rung's
 * territory:
 *
 *   - `base-caused`   — the same required check failing on EVERY open PR this pass. A property of
 *                       origin/main, not of any diff. NO edit to any of those diffs would help.
 *   - `gate-conflict` — the review names an unsatisfiable condition (Standing rule 25
 *                       entanglement), which is explicitly NON-SUPPRESSIBLE, so no re-review can
 *                       soften it and no single patch can satisfy both gates.
 *   - `environment`   — a near-total failure ratio inside ONE check whose log tail repeats a
 *                       single message (the Playwright build-mismatch shape: 96 of 97 failures
 *                       carrying the same `browserType.launch` line).
 *   - `in-diff`       — the residue, and the fix rung's existing territory, unchanged.
 *
 * PRECEDENCE IS THE SHARD'S, NOT AN OPTIMISATION: base-caused is asked FIRST because it exonerates
 * every diff in the pass at once, so it must win over any per-PR reading of the same failure.
 *
 * PURE FOLD, NO I/O: every discriminator reads evidence the sweep ALREADY holds — `ciFailures`
 * (populated whenever `checksState === "red"`) and the whole `openPrs` array `runSweep` is handed.
 * On a day that reached 7,965 GitHub calls against a 5,000 ceiling, a classifier that cost a
 * network read per PR would not be worth having.
 */
export type RedCause = "base-caused" | "gate-conflict" | "environment" | "in-diff";

/**
 * The Standing rule 25 refusal text `renderReviewSummary` emits (`src/lib/review.ts`, the
 * `instrumentEntanglement` arm). Matched as TEXT because the structured
 * `ReviewVerdict.instrumentEntangled` boolean is not carried on {@link OpenPrView} — see
 * {@link namesUnsatisfiableGate}'s own doc for what that costs and why it is still safe.
 */
const UNSATISFIABLE_GATE_MARKER = /entangled: instrument path\(s\)/i;

/** A log tail shorter than this cannot establish a ratio — too few lines to be near-total. */
const ENVIRONMENT_MIN_TAIL_LINES = 4;
/** The share of log-tail lines that must be the SAME line before one message is "near-total". */
const ENVIRONMENT_REPEAT_RATIO = 0.9;

/**
 * The required check failing on EVERY open PR in this pass, or `undefined`.
 *
 * THE VACUITY GUARD IS THE LOAD-BEARING PART. With a single open PR, "failing on every open PR" is
 * trivially true of that PR's own failure, and a lone genuinely-broken diff would exonerate itself
 * and never be fixed. One PR is not a cross-PR measurement, so fewer than two returns `undefined`
 * — the same discipline as requiring a positive control before believing a query.
 *
 * A pass containing any PR that is NOT failing this check (green, pending, or failing something
 * else) yields `undefined`: a base outage reddens all of them, so a survivor is evidence AGAINST
 * the base being the cause. That is deliberately the conservative direction — it fails toward
 * dispatching the fix rung, never toward silently standing down.
 */
export function baseCausedCheckName(pr: OpenPrView, allPrs: readonly OpenPrView[]): string | undefined {
  const own = pr.ciFailures ?? [];
  if (own.length === 0) return undefined;
  if (allPrs.length < 2) return undefined;
  for (const failure of own) {
    const onEveryPr = allPrs.every((other) =>
      (other.ciFailures ?? []).some((candidate) => candidate.name === failure.name),
    );
    if (onEveryPr) return failure.name;
  }
  return undefined;
}

/**
 * True when the review named a condition no patch can satisfy (Standing rule 25 entanglement).
 *
 * READS BOTH CARRIERS BECAUSE ONE OF THEM IS CURRENTLY INERT, AND THAT IS WORTH STATING RATHER
 * THAN HIDING: `OpenPrView.reviewSummary` is hardwired to `undefined` at BOTH of its producer
 * sites in `src/run-task.ts`, so in a live sweep today only the `unmetCriteria` reason can carry
 * the marker. The summary arm is read anyway because the field is typed, populated in
 * reconstruction paths, and costs nothing — but this predicate is NOT the safety property.
 *
 * THE SAFETY PROPERTY IS STRUCTURAL, NOT DETECTIVE. A rule-25 refusal fails the `remudero-review`
 * COMMIT STATUS, and `checksStateFromRollup` excludes that context from `checksState` by
 * construction (W1-T394), so such a PR is review-red and never checks-red. Since the stand-down
 * below fires only on `ciFailures`-derived evidence, a gate conflict CANNOT be stood down even if
 * this predicate returns false. Detection changes the ledger's reason text; it does not change
 * whether the escalation survives.
 */
export function namesUnsatisfiableGate(pr: OpenPrView): boolean {
  if (pr.reviewSummary && UNSATISFIABLE_GATE_MARKER.test(pr.reviewSummary)) return true;
  return pr.unmetCriteria.some((criterion) => UNSATISFIABLE_GATE_MARKER.test(criterion.reason));
}

/**
 * The check whose log tail is one message repeated near-totally, or `undefined`.
 *
 * W1-T517's `findSiblingDisagreements` (`src/lib/host-parity.ts`) IS THE OTHER HALF OF THIS
 * DISCRIMINATOR AND IS DELIBERATELY NOT CALLED HERE — it requires BOTH poles (at least one
 * `success` and one `failure` on the same sha), and {@link OpenPrView} carries `ciFailures`, which
 * is failures-only and populated only when `checksState === "red"`. There is no success pole to
 * hand it. Feeding it would need the producer (`fetchCiFailures`, `src/run-task.ts`) to emit
 * passing runs too, and this task does not declare that file. Reimplementing its fold here is
 * exactly what its own doc forbids, so the ratio arm carries this class alone and the sibling arm
 * is named as available work rather than faked.
 */
export function environmentFaultCheckName(pr: OpenPrView): string | undefined {
  for (const failure of pr.ciFailures ?? []) {
    const lines = failure.logTail
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length < ENVIRONMENT_MIN_TAIL_LINES) continue;
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let mostRepeated = 0;
    for (const count of counts.values()) if (count > mostRepeated) mostRepeated = count;
    if (mostRepeated / lines.length >= ENVIRONMENT_REPEAT_RATIO) return failure.name;
  }
  return undefined;
}

/**
 * The pure fold itself — see {@link RedCause} for the four classes and why this order.
 */
export function classifyRedCause(pr: OpenPrView, allPrs: readonly OpenPrView[]): RedCause {
  if (baseCausedCheckName(pr, allPrs) !== undefined) return "base-caused";
  if (namesUnsatisfiableGate(pr)) return "gate-conflict";
  if (environmentFaultCheckName(pr) !== undefined) return "environment";
  return "in-diff";
}

/**
 * The two classes the fix rung cannot reach, and therefore the only two that change behaviour.
 *
 * `in-diff` dispatches exactly as before this task existed; `gate-conflict` refuses and escalates
 * exactly as before (design note iii: that path is already correct and stays byte-identical). A
 * stand-down leaves `acted:false`, and `priorActionsFromLedger` skips every row where
 * `line.acted !== true` — so no strike is spent and the PR is re-derived fresh next pass.
 */
export function redCauseStandsDown(cause: RedCause): boolean {
  return cause === "base-caused" || cause === "environment";
}

/**
 * The stand-down reason carried on the existing `sweep.disposed` line — NOT a new ledger step.
 * Design note (vi): `daemon.tree_dirty` and `daemon.stale_code` both fire with nothing reading
 * either, and `CiFailure.outsidePrRange` is narrated by `describeCiFailures` and never acted on.
 * This class is READ by the dispatch decision itself, which is what makes it an actor rather than
 * a fourth dead signal.
 */
export function describeRedCause(cause: RedCause, pr: OpenPrView, allPrs: readonly OpenPrView[]): string {
  if (cause === "base-caused") {
    const name = baseCausedCheckName(pr, allPrs) ?? "a required check";
    return `red cause: base-caused — ${name} is failing on all ${allPrs.length} open PRs this pass, so it is not this diff; no strike spent`;
  }
  const name = environmentFaultCheckName(pr) ?? "a required check";
  return `red cause: environment — ${name} repeats one message across its whole log tail, an environment fault rather than a diff defect; no strike spent`;
}

/**
 * The four named "why is this actually blocked" states an escalation must distinguish
 * (W1-T186) — never a single overloaded `checksState`/`reviewState` pair. Exactly one applies
 * (or none, for an ordinary review-failure/contradictory block, where these four facts say
 * nothing extra beyond the criterion itself):
 *
 *   - CONFLICTED: `mergeState`/`mergeable` observed dirty/false. The PR cannot merge regardless
 *     of any check's state — zero check runs here is EXPECTED (GitHub does not start checks on
 *     an unmergeable ref), never a checks/review signal. Action: merge main into the branch.
 *   - FAILING: a required check ran and CONCLUDED failure (`checksState === "red"`). Action:
 *     names the check — see {@link describeCiFailures}.
 *   - ABSENT: a required context has ZERO observed check runs on an otherwise-mergeable PR —
 *     either the whole rollup is empty (`checksState === "none"`) or, the W1-T176 shape,
 *     `remudero-review` specifically never posted while every OTHER required check is green
 *     (`checksState === "green" && reviewState === "none"`). Action: post/kick off the check.
 *   - PENDING: checks exist and are still running (`checksState === "pending"`). Action: wait
 *     (or, once a staleness ceiling is exceeded, escalate naming the elapsed time — the
 *     stale-pending row already does this via `reason`; this state still names the fact).
 *
 * CHECKED IN THIS ORDER, CONFLICTED FIRST: the #412/#413 live incident was PRECISELY a PR that
 * was both `checksState: "none"` (zero check runs) AND `mergeState: "dirty"` — reading "none"
 * before "dirty" would have mis-sorted it as ABSENT (post the check) when the check will NEVER
 * run until the conflict resolves. This is the split acceptance 3 requires: `checksState: "none"`
 * is no longer read as one fact meaning two different things.
 */
export type ObservedBlockerState = "CONFLICTED" | "FAILING" | "ABSENT" | "PENDING";

export function observedBlockerState(pr: OpenPrView): ObservedBlockerState | undefined {
  if (pr.mergeState === "dirty" || pr.mergeable === false) return "CONFLICTED";
  // CHECKED BEFORE reviewState, mirroring DISPOSITION_RULES row 4/5's own "ci-log wins"
  // precedence (a review verdict beside a red required check may be STALE — computed before the
  // push that broke it): FAILING fires regardless of what the review says.
  if (pr.checksState === "red") return "FAILING";
  // A failing REVIEW (checks not red) already names its own block via the criterion/contradictory
  // text — PENDING/ABSENT below would misframe that as "wait" or "post the check" when the
  // review verdict is the actual thing blocking merge.
  if (pr.reviewState === "failure") return undefined;
  if (pr.checksState === "pending") return "PENDING";
  if (pr.checksState === "none") return "ABSENT";
  // The W1-T176 shape: every OTHER required context is green, but remudero-review specifically
  // has zero observed runs — invisible to the branch above because overall checksState reads
  // "green", not "none" (only the one required context is absent).
  if (pr.checksState === "green" && pr.reviewState === "none") return "ABSENT";
  return undefined;
}

/** Why the ABSENT-check-suite remedy did or did not fire, so both outcomes are legible. */
export type AbsentRepushDecision =
  | { repush: true; reason: string }
  | { repush: false; reason: string };

/** How many empty-commit re-pushes ONE PR may earn before the remedy stands down and the
 *  ordinary escalation takes over. Mirrors `fixStrikeCap`'s role for the fix rung: a bound on
 *  a remedy that would otherwise retry forever on a PR GitHub simply never schedules. */
export const ABSENT_REPUSH_CAP = 1;

/**
 * THE ABSENT-CHECK-SUITE REMEDY'S DECISION (W1-T186 follow-up). Pure: every inch of evidence is
 * a parameter, so the three real cases below are fixtures rather than a live experiment.
 *
 * ── WHY A REMEDY AT ALL ─────────────────────────────────────────────────────────────────────
 * GitHub sometimes creates NO Actions check-suite for a pushed sha. Observed three times
 * (#921, #940, #966): only the `claude`/`vercel` app suites existed, zero Actions check-runs,
 * while ci.yml is unconditional and Actions was healthy on other branches at that same moment.
 * On #921 the sweep disposed `blocked-ambiguous` and escalated 244 times over 7h45m with
 * `acted:false` — the right diagnosis, no remedy, and (light-pass stand-down) not even an issue.
 * Pushing a fresh sha created 6 suites and 20 check-runs immediately, every time.
 *
 * ── THE DISCRIMINATOR: ABSENT vs PENDING ────────────────────────────────────────────────────
 * Re-pushing a PR whose checks merely have not STARTED yet would be destructive churn — it
 * cancels in-flight runs and resets the review. Two independent facts separate them, and BOTH
 * are required:
 *
 *   1. STRUCTURE. `checksStateFromRollup` already draws this line and we reuse it rather than
 *      re-deriving: a rollup with entries but no REQUIRED context registered yet returns
 *      "pending" (`gate.length === 0 && knownRequired`), and ONLY a COMPLETELY EMPTY rollup
 *      returns "none". So "the workflow is starting" normally reads PENDING, because the
 *      instant any context registers the rollup is non-empty. `checksState === "none"` means
 *      nothing at all registered — the missing-suite shape.
 *   2. TIME. The residual ambiguity is the seconds between the push and the FIRST context
 *      registering, during which the rollup is legitimately empty. `policy.absentCeilingMinutes`
 *      bounds it. The clock is `lastActivityAt` (the PR's `updatedAt`), which a push always
 *      advances; anything else that advances it (a comment) only makes the PR look YOUNGER and
 *      so makes this fire LESS — the error direction is toward doing nothing, never toward
 *      churn.
 *
 * The W1-T176 sub-shape of ABSENT — `checksState === "green" && reviewState === "none"`, where
 * every other required context is green and only `remudero-review` never posted — is
 * DELIBERATELY EXCLUDED. Its rollup is not empty and its remedy is to post the review (the
 * post-review lane already owns it); a re-push there would throw away a green CI run to fix a
 * missing status the sweep can post directly.
 *
 * ── WHY A PASSING REVIEW IS EXCLUDED ────────────────────────────────────────────────────────
 * `remudero-review` is posted PER HEAD SHA, so minting a new sha discards it and costs a full
 * review cycle. A PR that already carries a passing review is never re-pushed here, whatever
 * its checks say — that certification is the expensive artifact in this system.
 */
/**
 * W1-T1103 (design i): how many minutes since this PR's head was last pushed, or `undefined`
 * when the age cannot be read. Factored out of {@link absentChecksRepushDecision}'s own "time
 * half" (below) so the NOT-YET-SCHEDULED disposition row in {@link DISPOSITION_RULES} reads the
 * IDENTICAL clock rather than a second, independently-drifting computation of "how long has this
 * head sat with zero check runs" — the two questions ("re-push yet?" and "escalate yet?") are the
 * same question about the same evidence, and rationale (3)'s own point is that TIME is the one
 * discriminator a bare run-count cannot carry, so both readers must derive it identically.
 *
 * `pr.lastActivityAt` (the PR's `updatedAt`) is the same clock the sibling function has always
 * used: a push always advances it, and the fail direction on an unreadable value is `undefined`
 * (never a guessed age) — the caller decides what "cannot date" means for its own disposition.
 */
export function absentAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const pushedAt = Date.parse(pr.lastActivityAt);
  if (Number.isNaN(pushedAt)) return undefined;
  return (now - pushedAt) / 60_000;
}

export function absentChecksRepushDecision(
  pr: OpenPrView,
  policy: SweepPolicy,
  now: number,
  priorRepushes: { count: number; shas: ReadonlySet<string> },
): AbsentRepushDecision {
  if (observedBlockerState(pr) !== "ABSENT") {
    return { repush: false, reason: "not the ABSENT state" };
  }
  // Structure half — excludes the W1-T176 green+review-none sub-shape by construction.
  if (pr.checksState !== "none") {
    return {
      repush: false,
      reason: `ABSENT via the review-only shape (checksState=${pr.checksState}) — the post-review lane owns this, not a re-push`,
    };
  }
  // A certification already earned must never be thrown away to chase a check suite.
  if (pr.reviewState === "success") {
    return { repush: false, reason: "review already PASSED on this head — a re-push would discard the certification" };
  }
  if (!pr.headRefName) {
    return { repush: false, reason: "head branch name not observed — nothing to push to" };
  }
  // Time half.
  const ageMin = absentAgeMinutes(pr, now);
  if (ageMin === undefined) {
    return { repush: false, reason: "head age unreadable — never re-push on state we cannot date" };
  }
  if (ageMin < policy.absentCeilingMinutes) {
    return {
      repush: false,
      reason: `checks may still be starting (${ageMin.toFixed(1)}m < ${policy.absentCeilingMinutes}m ceiling) — waiting`,
    };
  }
  // Idempotence within a head: sha-keyed, the SAME shape `prior.fixed` uses and #968 gave
  // `prior.armed`. Without it a single stuck head would earn a fresh commit every pass.
  if (priorRepushes.shas.has(`${pr.prNumber}@${pr.headSha}`)) {
    return { repush: false, reason: `already re-pushed this head (${pr.headSha.slice(0, 7)})` };
  }
  // The BOUND, per PR rather than per head — a re-push MINTS a new sha, so a sha key alone
  // would license an unbounded chain of commits on a PR GitHub never schedules.
  if (priorRepushes.count >= ABSENT_REPUSH_CAP) {
    return {
      repush: false,
      reason: `ABSENT re-push cap reached (${priorRepushes.count}/${ABSENT_REPUSH_CAP}) — escalating instead`,
    };
  }
  return {
    repush: true,
    reason:
      `zero check runs on head ${pr.headSha.slice(0, 7)} after ${ageMin.toFixed(0)}m (ceiling ` +
      `${policy.absentCeilingMinutes}m) — GitHub created no check-suite; minting a fresh head sha`,
  };
}

/**
 * Name the FAILING check(s) + the sha each ran against (W1-T186) — "checks red" is not
 * actionable, "commitlint failed on 0e63429" is. Falls back to a generic sentence when no
 * per-check detail was captured (never silent, never a crash), and — the #420 fixture — says so
 * explicitly when a check's own sha is OBSERVED to sit outside this PR's own commit range.
 */
function describeCiFailures(pr: OpenPrView): string {
  const failures = pr.ciFailures ?? [];
  if (failures.length === 0) {
    return `a required check failed on head ${pr.headSha.slice(0, 7)} (no failing-check detail captured)`;
  }
  return failures
    .map((f) => {
      const sha = (f.sha ?? pr.headSha).slice(0, 7);
      const rangeNote = f.outsidePrRange
        ? " — NOT one of this PR's own commits; only present on the base branch"
        : "";
      return `${f.name} failed on ${sha}${rangeNote}`;
    })
    .join("; ");
}

/** The `mergeable`/`mergeableState` facts line every escalation carries when observed (W1-T186,
 *  acceptance 2) — "" when neither was read, so callers can omit it cleanly. */
function mergeableFactLine(pr: OpenPrView): string {
  if (pr.mergeable === undefined && pr.mergeableState === undefined) return "";
  return `observed mergeable=${pr.mergeable ?? "unknown"}, mergeableState=${pr.mergeableState ?? "unknown"}`;
}

/**
 * Render the named observed-blocker facts (W1-T186) that {@link renderClarificationQuestion}
 * prepends to every question — the operator sees WHICH of the four named states fired and the
 * facts that support it, not just a re-derived "checks X, review Y" summary. "" when
 * {@link observedBlockerState} found none of the four to name (an ordinary review-failure block),
 * so the caller falls back to the criterion/reason text alone, exactly as before this task.
 *
 * FALSIFIER-SHAPED CONSTRAINT: the CONFLICTED branch below must never contain the word "CI" or
 * the token "blocked_ci" — both are FALSE for a conflicted PR (GitHub never even started a check,
 * let alone failed one), and this codebase's own #412/#413 incident is exactly an escalation that
 * said "blocked_ci"/"checks pending" for a PR that was neither.
 */
function renderObservedFacts(pr: OpenPrView, state: ObservedBlockerState | undefined): string {
  const mergeableFact = mergeableFactLine(pr);
  const suffix = mergeableFact ? ` (${mergeableFact})` : "";
  switch (state) {
    case "CONFLICTED":
      return (
        `[CONFLICTED]${suffix} this PR cannot merge as observed; zero check runs here is EXPECTED ` +
        `(GitHub does not start checks on an unmergeable ref), not a signal that anything is blocked or ` +
        `pending review. Remedy: merge origin/main into the branch to resolve the conflict, then push to ` +
        `re-trigger checks.`
      );
    case "FAILING":
      return `[FAILING]${suffix} ${describeCiFailures(pr)}.`;
    case "ABSENT":
      return (
        `[ABSENT]${suffix} the required check has ZERO observed check runs on head ` +
        `${pr.headSha.slice(0, 7)} — it has not started at all, not merely running slowly.`
      );
    case "PENDING":
      return `[PENDING]${suffix} required checks are still running on head ${pr.headSha.slice(0, 7)}.`;
    default:
      return mergeableFact ? `(${mergeableFact})` : "";
  }
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
 * W1-T114: how many minutes checks have been pending on this head, or undefined when there is
 * genuinely nothing to date. PURE, fail-toward-undefined: never guesses an age it cannot support
 * from observed state.
 *
 * ─── WHY THIS HAS A FALLBACK, AND WHY THAT IS THE WHOLE FIX ──────────────────────────────────
 * W1-T114 shipped the WAIT/stale-pending rows reading `checksPendingSince`, and left an explicit
 * hatch for "callers that haven't wired the timestamp yet" (see the row comments below). **NOBODY
 * EVER WIRED IT.** Measured at `d63bee7`: `checksPendingSince` has six references in `src/`, all in
 * THIS file, and not one of them is a write — `buildOpenPrViews`, the real gateway, never sets it.
 *
 * So `pendingAgeMinutes` returned `undefined` on every real PR, both W1-T114 rows required
 * `mins !== undefined`, and EVERY pending PR fell through to the terminal catch-all and escalated.
 * That produced 57 open `needs-human` issues in one day, all titled
 * `… not positively mergeable — checks pending, review none — escalating`, including one for PR
 * #1038 whose checks went green and merged minutes later. The bound existed, was tested against
 * fixtures that supply the field, and was dead in production.
 *
 * THE FALLBACK IS THE SIBLING REMEDY'S OWN SOURCE, not a new invention. PR #977's ABSENT-checks
 * remedy solves the identical "how long has this been stuck" question for `checksState: "none"`
 * and dates it off `pr.lastActivityAt` (`decideAbsentRepush`, this file) — a field the real gateway
 * DOES populate (`run-task.ts`'s `lastActivityAt: pr.updatedAt`). Using the same source here makes
 * W1-T114's bound live with no gateway change, and keeps `checksPendingSince` as the strictly more
 * precise reading for any caller that later wires it.
 *
 * IT IS A CEILING ON *WAITING*, NOT A LICENCE TO IGNORE. Past `pendingCeilingMinutes` the
 * stale-pending row still escalates — W1-T78's purpose is preserved exactly; only the first hour of
 * a normal CI run stops being treated as ambiguity.
 *
 * PRECEDENCE IS DELIBERATE: the precise field wins when present, so wiring it later is a pure
 * upgrade and can never be masked by the coarser fallback.
 */
function pendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const raw = pr.checksPendingSince ?? pr.lastActivityAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
}

/**
 * W1-T913: how many minutes `remudero-review` has read PENDING (posted by this system itself,
 * {@link "./review.js".postReviewPending}) on this head, or undefined when there is nothing to
 * date. Mirrors {@link pendingAgeMinutes}'s own fallback discipline exactly: the precise field
 * ({@link OpenPrView.reviewPendingSince}, the ledger's own `ts` on the `review.pending_posted`
 * line) wins when present; `lastActivityAt` is the coarser stand-in otherwise (a field the real
 * gateway already populates for every PR), so a pending PR is never stranded merely because the
 * newer field's own producer lagged or a rotation ate its ledger line.
 */
function reviewPendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const raw = pr.reviewPendingSince ?? pr.lastActivityAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
}

/**
 * W1-T913 — THE STUCK-PENDING FALSIFIER'S PREDICATE (design (b)): is a currently-PENDING
 * `remudero-review` old enough that the sweep should stop trusting it as "already attended to"
 * and offer this head to the post-review lane again? Reuses `policy.pendingCeilingMinutes` — the
 * SAME ceiling `checksState === "pending"` already waits out (W1-T114) — rather than a second,
 * independently-tuned threshold: both questions are "how long is merely in-flight before it reads
 * as stuck", and one policy row answering both keeps them from drifting apart.
 *
 * UNDATED READS STALE — the OPPOSITE error direction from {@link absentChecksRepushDecision}'s
 * own "never re-push on state we cannot date" refusal: that remedy's caution exists because a
 * wrong re-push discards a real, in-flight check run. Re-offering this head to the post-review
 * lane risks no such loss — {@link "./review.js".postReviewPending}'s own idempotent-per-head
 * guard makes a redundant pending post a no-op, and a redundant `reviewCommand` re-run simply
 * re-posts the SAME terminal verdict once it judges. "a pending that no path can re-drive does
 * not ship" (the task's own design note) means the unreadable case must lean toward actionable,
 * never toward silently stranding a PR whose owning run died mid-review.
 */
function reviewPendingIsStale(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {
  const age = reviewPendingAgeMinutes(pr, now);
  return age === undefined || age >= policy.pendingCeilingMinutes;
}

/**
 * W1-T1018 (operator ruling 2026-08-19, "I don't really like the idea of a review budget. We just
 * need back off.") — design (i)/(ii)/(iii)'s ELAPSED-TIME BACKOFF, replacing the permanent
 * cessation the cap row used to enforce alone. Has ENOUGH WALL-CLOCK TIME passed since the
 * review-orphan lane's last real attempt on this PR ({@link OpenPrView.reviewOrphanLastAttemptAt}
 * — the most recent `review.posted`/`review.post_refused` ledger timestamp among the heads
 * `priorReviewOrphans` scanned; see `reviewOrphansFor`, run-task.ts) that the cap row below should
 * YIELD back to the ordinary post-review dispatch instead of escalating again?
 *
 * "ESCALATE AND KEEP GOING, NEVER ESCALATE INSTEAD OF GOING" (design ii): the cap still fires the
 * FIRST time `priorReviewOrphans` reaches `policy.reviewOrphanCap` (this reads `false` with no
 * attempt timestamp on record yet, so the cap row matches exactly as it always has). Once that
 * escalation's own attempt is on record and `policy.reviewOrphanBackoffMinutes` has elapsed with
 * no NEWER attempt superseding it, this flips `true` and the lane resumes — never a permanent
 * wall, only a paced one.
 *
 * THE RESET (design iii, "or the backoff decays into the cap it replaces"): `reviewOrphanLastAttemptAt`
 * is the max timestamp across EVERY review-lane attempt on this PR, whether or not that attempt's
 * head counted toward `priorReviewOrphans` (a diff-unchanged housekeeping push still reviews and
 * still advances the clock — see `reviewOrphansFor`'s design (iv) note). So the backoff clock
 * restarts on ANY real activity, never accumulating toward a slow-motion version of the old
 * unconditional cap.
 *
 * FAILS TOWARD ESCALATING, never toward silent retrying — this task's own risk note names that as
 * the dangerous direction ("retry forever, never escalate... is silent"). A missing or unparseable
 * timestamp (every caller that has not wired {@link OpenPrView.reviewOrphanLastAttemptAt} yet, e.g.
 * `rmd fix`'s single-PR build) reads `false` — byte-identical to today's permanent-cap behaviour
 * until a real attempt timestamp exists to back off from.
 */
export function reviewOrphanBackoffElapsed(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {
  if (!pr.reviewOrphanLastAttemptAt) return false;
  const last = Date.parse(pr.reviewOrphanLastAttemptAt);
  if (Number.isNaN(last)) return false;
  return now - last >= policy.reviewOrphanBackoffMinutes * 60_000;
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
 *   0. VERDICT-SUPERSEDED (W1-T920, DECISIONS.md #1987) — `policy.supersessionDisposalEnabled`
 *      is on AND `pr.supersessionVerdict.status === "superseded"` -> close, reason naming the
 *      verdict's own evidence (superseding PR + task id + diff finding). ORDERED FIRST, ahead of
 *      row 1's bare `supersededBy` match, because a REASON-bearing verdict is the more precise
 *      finding when both are present. Reads ONLY `status` — never the PR's own title/trailer/file
 *      list — so two PRs identical in every other respect are disposed however their OWN verdicts
 *      read (the #1873/#1874 falsifier design note (ii) names). DEFAULT OFF, and with no producer
 *      yet setting `supersessionVerdict` in the real gateway (a separate, out-of-scope detector
 *      shard), this row never matches in production regardless of the flag — see
 *      `OpenPrView.supersessionVerdict`'s own SCOPE note.
 *   1. SUPERSEDED  — a newer PR credits the same task: close regardless of review. W1-T932: this
 *      row now YIELDS (does not match) when `policy.conceptCoexistenceEnabled` is on AND this
 *      PR's OWN `supersessionVerdict.status` reads `"unique"` — a detector's POSITIVE finding
 *      that this PR is not actually superseded despite a higher-numbered peer sharing its task.
 *      `false` (the default) and any other verdict shape (absent, `"indeterminate"`, or a
 *      `"superseded"`/malformed one) leave this row matching exactly as before — an ordinary
 *      duplicate PR, which carries no verdict at all, is untouched by this clause and is still
 *      disposed stale here. See {@link SweepPolicy.conceptCoexistenceEnabled}'s own doc for why
 *      this is a SEPARATE gate from row 0's `supersessionDisposalEnabled`.
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
 *      Only reached with checks NOT red (row 5 above already claimed that case). W1-T923:
 *      ALSO matches a GATE failure (empty unmetCriteria) that named its own single-form
 *      remedy via {@link OpenPrView.actionableGateFailures} — a third disjunct, never a
 *      separate row (see that field's own doc for the #1991 motivating case).
 *   7. FAILING + no actionable criteria (contradictory)  -> blocked-ambiguous (escalate).
 *   7.5. CONFLICTED (W1-T106, the #170 DIRTY strand): `mergeState === "dirty"`
 *      — ABOVE mergeable, so a conflicting PR is NEVER armed no matter how
 *      green. Two rows, in order: (a) a PURE-concurrent-addition conflict
 *      (isPureConcurrentAddition) -> `conflicted`, dispatching the W1-T94
 *      merge-conflict fix mode; (b) anything else dirty (a deletion-involved
 *      or unclassifiable conflict) -> `blocked-ambiguous`, REFUSING
 *      auto-resolution and escalating instead — never a wrong clobber.
 *   8. CI GREEN + REVIEW SUCCESS (POSITIVE match only)   -> mergeable (arm).
 *   8.5. ZERO-RUNS REQUIRED CHECK / POST-REVIEW (W1-T176 discriminator + the
 *      2026-07-22 #584 stall): checks green, remudero-review has ZERO
 *      observed check runs -> DETERMINISTIC-ACTION on its FIRST sighting for
 *      this head sha: `post-review`, running the SAME `rmd review` an
 *      operator would run rather than asking — an absent required check is
 *      mechanically decidable (the #393/#391 fixture: every other check
 *      SUCCESS, remudero-review absent, escalated with two mis-framed
 *      options while `rmd review` was the one-command remedy). A SECOND
 *      absence at the SAME head sha — a prior deterministic attempt already
 *      came back REFUSED — is the one shape here that still escalates ->
 *      blocked-ambiguous, checked FIRST (ordered before the post-review row
 *      in the table) so a refused head never re-reaches the dispatch and
 *      loops; the FAIL-CLOSED boundary is "at most one attempt per head sha,"
 *      never zero and never unbounded.
 *   8.6. REVIEW ORPHANED BY A PUSH, BOUNDED (W1-T225; the 2026-07-21
 *      #477/#484 jam): the SAME zero-observed-runs shape, but this PR WAS
 *      reviewed on an earlier head (`OpenPrView.reviewOrphanedByPush`) — a
 *      later push left the new head silent rather than re-dispatching the
 *      lane, and ABSENT reads as "not yet run," never as a block, so
 *      auto-merge waited forever. Ordered BEFORE the post-review row (same
 *      dispatch, `post-review`, just a reason that names the orphaning
 *      rather than "review never posted," so an operator can tell the two
 *      shapes apart) and, when `priorReviewOrphans` has already reached
 *      `policy.reviewOrphanCap`, checked as its OWN row here (ordered before
 *      post-review) so a PR that keeps getting pushed — or whose re-review
 *      keeps failing to stick — escalates instead of re-dispatching forever;
 *      the fresh verdict this posts NEVER re-uses the prior one (invalidation
 *      is not weakened). W1-T1018 (operator ruling 2026-08-19 — "I don't
 *      really like the idea of a review budget. We just need back off."):
 *      reaching the cap no longer WALLS the PR off — it ALSO requires
 *      {@link reviewOrphanBackoffElapsed} to read `false` (i.e. not enough
 *      wall-clock time has passed since the last real attempt). Once the
 *      backoff interval elapses this row yields and the post-review row
 *      below dispatches again — escalate for visibility, AND keep retrying,
 *      never one instead of the other.
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
    // W1-T920 (DECISIONS.md #1987, the 2026-08-16 ruling) — ROUTED THROUGH THE EXISTING "stale"
    // disposition, never a new one: `runSweep`'s "stale" case already closes via `deps.close`
    // (the SAME effect W1-T921 already made reversible — no `--delete-branch`, see that call
    // site's own comment) and already writes ONE `sweep.disposed` ledger row (design note vii —
    // "no new ledger step without a named reader"). This is a NEW ROW, not a change to the
    // existing `supersededBy` row immediately below: that row matches on a bare NUMBER
    // (unconditional, no policy gate); this one matches on a REASON-bearing verdict, gated
    // behind `policy.supersessionDisposalEnabled` (default OFF), and reads NOTHING about the
    // PR itself besides `status` — never title, trailer, or file list (design note ii, the
    // #1873/#1874 falsifier). `"unique"` and `"indeterminate"` are BOTH inert here: an
    // unreadable verdict must never be treated as a finding (design note iii).
    disposition: "stale",
    when: (pr, policy) => policy.supersessionDisposalEnabled === true && pr.supersessionVerdict?.status === "superseded",
    // Guards `evidence` defensively (never a `!` assertion) even though `when` above already
    // requires `status === "superseded"`: a malformed verdict must degrade to a legible reason,
    // never throw and abort the whole sweep pass over one bad producer.
    reason: (pr) => {
      const ev = pr.supersessionVerdict?.evidence;
      if (!ev) return `superseded — but the verdict carried no evidence (${pr.supersessionVerdict?.detail ?? "malformed verdict"})`;
      return (
        `superseded by #${ev.supersedingPrNumber} (task ${ev.taskId}) — diff: ${ev.diff.matchedHunks} hunk(s) ` +
        `over ${ev.diff.rawLineCount} raw line(s) [corpus control]`
      );
    },
  },
  {
    // W1-T932 — LETS THIS ROW YIELD, NEVER DISABLES IT (design note ii: "a guard that works for
    // ordinary duplicate PRs must keep working"). An ordinary duplicate carries no
    // `supersessionVerdict` at all, so the added clause below is false for it and this row
    // matches exactly as it always has. Gated behind `conceptCoexistenceEnabled` — a SEPARATE
    // flag from row 0's `supersessionDisposalEnabled` (see that field's own doc: different
    // blast radii, one gate each). Reads ONLY `status === "unique"`, the verdict's own POSITIVE
    // "checked, not superseded" finding (see {@link SupersessionStatus}'s own doc) — never
    // `"indeterminate"` (an unreadable read is not a finding) and never an absent/malformed
    // verdict: fail CLOSED, today's arithmetic-only behaviour is the default in every other case.
    disposition: "stale",
    when: (pr, policy) =>
      pr.supersededBy != null &&
      !(policy.conceptCoexistenceEnabled === true && pr.supersessionVerdict?.status === "unique"),
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
    // W1-T186 (the #420 fixture): once checks are the reason strikes exhausted, NAME the check
    // + sha here too — not just in the rendered ClarificationQuestion — so the ledgered/summary
    // reason itself never reads as the generic, uninvestigable "fix strikes exhausted".
    reason: (pr, policy) =>
      isBlockedCi(pr)
        ? `fix strikes exhausted (${pr.priorStrikes}/${policy.strikeCap}) — ${describeCiFailures(pr)} — escalating`
        : `fix strikes exhausted (${pr.priorStrikes}/${policy.strikeCap}) — escalating`,
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
    // case) — a pure review-shaped block. Genuinely REACHABLE for a review
    // failure (W1-T394): `isBlockedCi`/`pr.checksState` never go true off a
    // red `remudero-review` alone (checksStateFromRollup excludes it from the
    // checks gate), so a checks-green PR whose review is failing lands here
    // instead of being claimed by row 5 above.
    //
    // W1-T923: a THIRD disjunct, never a new rule (design note iii) — a GATE failure (empty
    // `unmetCriteria`) that named its own single-form remedy routes here exactly like a
    // criterion failure does, via `actionableGateFailures` (see that field's own doc). This is
    // the ONLY change to this row: when `unmetCriteria` is non-empty the `when`/`reason` below
    // are byte-identical to before this task, and a PR that carries neither list still falls
    // through to row 7 unchanged.
    disposition: "blocked-fixable",
    when: (pr) => pr.reviewState === "failure" && (pr.unmetCriteria.length > 0 || (pr.actionableGateFailures?.length ?? 0) > 0),
    reason: (pr, policy) => {
      if (pr.unmetCriteria.length > 0) {
        return `${pr.unmetCriteria.length} unmet criteri${pr.unmetCriteria.length === 1 ? "on" : "a"} — strike ${pr.priorStrikes + 1}/${policy.strikeCap}`;
      }
      const n = pr.actionableGateFailures!.length;
      return `${n} actionable gate failure${n === 1 ? "" : "s"} (named remedy) — strike ${pr.priorStrikes + 1}/${policy.strikeCap}`;
    },
  },
  {
    // W1-T440: the SAME empty (`pr.unmetCriteria` is `[]`) has two distinct causes, and the
    // reason used to name the wrong one unconditionally. `criteriaRecoverable === false` is the
    // OBSERVED signal (set by `buildOpenPrViews`, run-task.ts) that no `Remudero-Task:` trailer
    // resolved a task id, so `unmetFromLedger` was never consulted — the criteria were never
    // RECOVERABLE, not contradicted. `criteriaRecoverable !== false` (true, or unset on an older
    // fixture) means a trailer DID resolve and the ledger genuinely came back with nothing unmet
    // — that arm keeps today's wording verbatim, byte-identical for every attributable PR.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.reviewState === "failure",
    reason: (pr) =>
      pr.criteriaRecoverable === false
        ? "review failing — criteria unrecoverable (no Remudero-Task: trailer to resolve them from) — escalating"
        : "review failing with no actionable unmet criteria (contradictory) — escalating",
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
    //
    // W1-T984: gated behind `policy.mergeConflictAdmissionEnabled` (default FALSE — see that
    // field's own doc) — the SAME shape row 0's `supersessionDisposalEnabled` conjunct already
    // uses. `hydrateMergeConflictEvidence` (lib/open-prs-rest.ts) now populates real evidence in
    // production for the first time, but `isPureConcurrentAddition` cannot tell a genuine
    // pure-concurrent-addition from an add/add collision (both score TRUE — rationale (5)), so
    // admitting on the predicate alone is a judgement call this task declines to make. With the
    // flag off, this row never matches no matter what evidence flows, and a dirty PR falls to the
    // very next row exactly as it always has.
    disposition: "conflicted",
    when: (pr, policy) =>
      policy.mergeConflictAdmissionEnabled === true && pr.mergeState === "dirty" && isPureConcurrentAddition(pr.mergeConflict?.files ?? []),
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
    //
    // W1-T984: with the row above gated off by default, THIS is the row every dirty PR reaches —
    // so the escalation naming the real conflicting paths AND each side's deletion count (not
    // just the path) is the user-visible fix this task delivers. `files: none captured` now means
    // exactly what it says (evidence genuinely could not be read) rather than "no producer ever
    // tried".
    disposition: "blocked-ambiguous",
    when: (pr) => pr.mergeState === "dirty",
    reason: (pr) => {
      const files = pr.mergeConflict?.files ?? [];
      const fileList = files.map((f) => `${f.path} (ours -${f.oursDeleted}, theirs -${f.theirsDeleted})`).join(", ");
      return (
        `merge conflict (mergeState dirty) involves a deletion (or no file evidence was captured) — ` +
        `never auto-resolved — files: ${files.length > 0 ? fileList : "none captured"} — escalating`
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
    // W1-T176 (the #393/#391 fixture): a required check with ZERO observed
    // runs is DETERMINISTIC-ACTION, not blocked-ambiguous — but only ONCE.
    // Ordered STRICTLY BEFORE the post-review row below so a PR whose
    // deterministic post already came back REFUSED for this exact head never
    // re-reaches that row's dispatch — the "post it" remedy already ran its
    // course; retrying would loop against a lane that has already declined.
    // This is the SAME blocked-ambiguous escalate path every other ambiguous
    // block uses (ledger dedup, clarification-question rendering, escalate()
    // dispatch — nothing new to wire), so an operator sees a genuine question
    // instead of the PR sitting silently deduped forever with no trace.
    disposition: "blocked-ambiguous",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.reviewState === "none" &&
      pr.reviewPostRefused === true &&
      pr.requiredContextsUnreadable !== true,
    reason: () =>
      "required check (remudero-review) has zero observed check runs and the one deterministic post " +
      "attempt for this head was refused — escalating rather than retrying indefinitely",
  },
  {
    // W1-T225 (the 2026-07-21 PRs #477/#484 jam) — THE LOOP FALSIFIER: a PR
    // whose review was orphaned by a push re-earns the review lane (the row
    // below), but not unboundedly. Ordered STRICTLY BEFORE that row so a PR
    // that has already spent `policy.reviewOrphanCap` orphan re-reviews never
    // re-reaches its dispatch — repeated pushes (or a re-review that itself
    // keeps failing to stick) must eventually ask an operator, the SAME
    // discipline the fix-rung strike ladder (row 4) and the CI re-run cap
    // (W1-T224) already hold elsewhere. `reviewOrphanedByPush !== true` (a PR
    // awaiting its FIRST review) never matches this row — only a PR that has
    // demonstrably been reviewed before can exhaust this cap.
    //
    // W1-T1018 (operator ruling 2026-08-19 — "we just need back off", not a budget): reaching the
    // cap is no longer a PERMANENT wall. `reviewOrphanBackoffElapsed` must ALSO read `false` for
    // this row to match — once `policy.reviewOrphanBackoffMinutes` has elapsed since the lane's
    // last real attempt with no resolution, this row yields and the post-review row below
    // dispatches again (design ii: "escalate AND keep going"). This ALSO fixes rationale (2)/(4):
    // `priorReviewOrphans` (run-task.ts's `reviewOrphansFor`) now counts DISTINCT REVIEWABLE
    // DIFFS among prior heads, not distinct pushed heads — a base-repair merge that leaves the
    // PR's own diff unchanged (the remedy this system itself prescribes) never spends this budget.
    disposition: "blocked-ambiguous",
    when: (pr, policy, _ageDays, now) =>
      pr.checksState === "green" &&
      pr.reviewState === "none" &&
      pr.reviewOrphanedByPush === true &&
      (pr.priorReviewOrphans ?? 0) >= policy.reviewOrphanCap &&
      pr.requiredContextsUnreadable !== true &&
      !reviewOrphanBackoffElapsed(pr, policy, now),
    reason: (pr, policy) =>
      `review orphaned by a push, again — the sweep has already re-reviewed this PR ${pr.priorReviewOrphans} ` +
      `time(s) (>= ${policy.reviewOrphanCap} cap) — escalating; re-reviewing again after ` +
      `${policy.reviewOrphanBackoffMinutes}m of backoff, never stopping outright`,
  },
  {
    // POST-REVIEW ROUTING (the 2026-07-22 #584 stall; NARROWED by W1-T176 —
    // see two rows above): a checks-GREEN PR whose remudero-review was never
    // posted at all previously fell to the terminal catch-all below and
    // ESCALATED ("checks green, review none") — a hand-opened PR could sit
    // fully green forever with a needs-human issue as its only disposition,
    // because nothing ever invoked the review lane on it, AND (W1-T176's own
    // fixture, #393/#391) an operator round-trip was spent on a decision the
    // machine could already make: an ABSENT required check is mechanically
    // decidable ("post it"), never ambiguous, on its FIRST sighting. Route it
    // to the SAME reviewCommand the operator verb runs (dedup per head, like
    // dep-review): the posted verdict then drives the NEXT pass — success ->
    // mergeable/arm, failure -> the fix/escalate rows. A PR with no criteria
    // (no trailer, no Acceptance block) posts FAIL fail-closed, which is a
    // LEGIBLE gate state rather than a clarification escalation. Dependabot
    // PRs never reach here (their own row above); checks-pending stays with
    // rows 9/10 below (W1-T114) when datable, the catch-all otherwise
    // (review-before-green is not the lane's order).
    //
    // W1-T225 (the 2026-07-21 PRs #477/#484 jam): the SAME row also carries a
    // PR whose review was ORPHANED BY A PUSH (reviewed on an earlier head,
    // silent on this one — the cap row immediately above already claimed the
    // bounded-out case) — the dispatch is identical (run the review lane,
    // posting a FRESH verdict; the prior verdict is NEVER carried forward),
    // only the stated reason differs, so an operator reading the ledger can
    // tell "never reviewed" from "orphaned by a push" apart at a glance.
    //
    // W1-T913 — THE STUCK-PENDING FALSIFIER: `reviewState === "pending"` also matches here, but
    // ONLY once {@link reviewPendingIsStale} says the pending has sat past `pendingCeilingMinutes`
    // (or its age is unreadable). This is design (b)'s load-bearing constraint: a naive pending
    // post would make `reviewStateFromRollup` return "pending" instead of "none" and this row
    // would never offer the head again, silently disabling the sweep's own re-post/re-drive lane
    // the moment a review's owning run died mid-flight. A FRESH pending (not yet stale) is
    // deliberately EXCLUDED here — the row immediately below claims that shape as `wait`, so an
    // in-flight review is never redundantly re-dispatched every sweep tick.
    disposition: "post-review",
    when: (pr, policy, _ageDays, now) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      (pr.reviewState === "none" || (pr.reviewState === "pending" && reviewPendingIsStale(pr, policy, now))),
    reason: (pr, policy, _ageDays, now) => {
      if (pr.reviewState === "pending") {
        const age = reviewPendingAgeMinutes(pr, now);
        return (
          `checks green, remudero-review pending ${age !== undefined ? `${Math.floor(age)}m` : "for an undated interval"} ` +
          `(>= ${policy.pendingCeilingMinutes}m ceiling, or unreadable) — treating the stuck pending as ` +
          `unattended and re-running the review lane on #${pr.prNumber}`
        );
      }
      return pr.reviewOrphanedByPush === true
        ? `checks green, review orphaned by a push (reviewed on an earlier head, silent on this one) — ` +
          `re-running the review lane on #${pr.prNumber}`
        : `checks green, review never posted — running the review lane on #${pr.prNumber}`;
    },
  },
  {
    // W1-T913: a FRESH (not-yet-stale) `remudero-review` pending — a review this system itself
    // already dispatched (`postReviewPending`, `lib/review.ts`) is genuinely IN FLIGHT. Ordered
    // STRICTLY AFTER the post-review row above so a STALE pending is claimed there first; anything
    // reaching this row has already failed that row's staleness check, i.e. is still within
    // `pendingCeilingMinutes`. Without this row a fresh pending would fall through to the terminal
    // catch-all below and ESCALATE every sweep tick for the entire duration of an ordinary review
    // — the exact green-at-a-glance defect this task fixes would be traded for an escalation storm
    // on every PR merely being reviewed, which is strictly worse than the silence it replaces.
    disposition: "wait",
    when: (pr) => pr.checksState === "green" && pr.reviewState === "pending",
    reason: (pr, policy, _ageDays, now) => {
      const age = reviewPendingAgeMinutes(pr, now);
      return (
        `checks green, remudero-review pending ${age !== undefined ? `${Math.floor(age)}m` : "0m"} ` +
        `(< ${policy.pendingCeilingMinutes}m ceiling) — a review is already in flight, waiting`
      );
    },
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
    // NOT-YET-SCHEDULED (W1-T1103, design i) — the THIRD reading of `checksState === "none"`
    // W1-T186's ABSENT/CONFLICTED split does not have. Rationale (1)/(3): a head seconds old
    // with zero check runs and a head hours old with zero runs are the SAME count and OPPOSITE
    // situations — a mergeable PR whose workflow simply has not been SCHEDULED yet is
    // indistinguishable from a genuinely-missing required check by run count alone, and every
    // prior row (CONFLICTED, mergeable, the W1-T176 refused-post row, the review-orphan-cap row,
    // post-review, the two green+pending rows, the two datable-pending rows) requires
    // `checksState` to be `"dirty"`-implying, `"green"`, or `"pending"` — none of them claim the
    // bare structural-empty shape, so a young `"none"` head reaches this row exactly as it always
    // fell through to the terminal catch-all below.
    //
    // THE DISCRIMINATOR IS THE SAME CLOCK `absentChecksRepushDecision` ALREADY OWNS (never a
    // second, guessed constant — rationale (1)'s own falsifier: "a bound that fires on a healthy
    // condition is this repo's recurring defect"). `policy.absentCeilingMinutes` is this repo's
    // own measured time-to-first-check-run, already load-bearing for the re-push remedy below —
    // reusing it here means the two questions ("re-push yet?" and "escalate yet?") answer off one
    // policy row, not two that could drift apart.
    //
    // UNDATED FAILS TOWARD ESCALATE, NOT WAIT (`absentAgeMinutes` returning `undefined` makes the
    // predicate below false) — the OPPOSITE polarity from a knowingly-young head, and the SAME
    // direction `absentChecksRepushDecision`'s own "never re-push on state we cannot date" refusal
    // already takes: an unreadable age is not evidence of youth, and treating it as YOUNG would
    // let a genuinely-broken check suite wait forever behind an unparseable timestamp.
    //
    // ABOVE THE CEILING, NOTHING CHANGES: the row does not match, the PR falls through to the
    // terminal catch-all exactly as before this task, and `runSweep`'s existing blocked-ambiguous
    // dispatch (the ABSENT re-push remedy, then escalate) is untouched — design (i)'s own words,
    // "above it the existing ABSENT path is unchanged."
    disposition: "wait",
    when: (pr, policy, _ageDays, now) => {
      if (pr.checksState !== "none") return false;
      const ageMin = absentAgeMinutes(pr, now);
      return ageMin !== undefined && ageMin < policy.absentCeilingMinutes;
    },
    reason: (pr, policy, _ageDays, now) =>
      `zero check runs on head ${pr.headSha.slice(0, 7)} but only ${(absentAgeMinutes(pr, now) ?? 0).toFixed(1)}m ` +
      `since the last push (< ${policy.absentCeilingMinutes}m ceiling) — not yet scheduled, not genuinely absent — waiting`,
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
 *
 * W1-T1201 (design i) — AGE IS CLAMPED TO THE PR'S OWN LIFETIME, HERE, ONCE, BEFORE ANY ROW
 * READS IT: `ageDays` is the LESSER of "days since last activity" and "days since
 * {@link OpenPrView.createdAt}", so every `DISPOSITION_RULES` row that reads the computed value
 * (today, only the bare `ageDays >= policy.staleDays` stale row) inherits the bound rather than
 * re-deriving it. `createdAt` absent or unparseable clamps to `+Infinity` (no bound) — today's
 * pre-clamp arithmetic, unchanged, the same fail-toward-existing-behaviour this module gives
 * every unwired field.
 *
 * THE CLAMP DOES NOT SILENTLY RESCUE (design iii): when it actually changes the outcome — the
 * raw activity age crosses the stale threshold but the clamped age does not — the returned
 * `reason` names the suppression explicitly, appended to whichever OTHER row's reason actually
 * fired, rather than reading identically to an ordinary non-stale disposition. A rescue nobody
 * can see is how a shifted clock stays invisible until it closes eleven PRs (this task's own
 * incident).
 */
export function deriveDisposition(
  pr: OpenPrView,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
  now: number = Date.now(),
): DispositionResult {
  const parsed = Date.parse(pr.lastActivityAt);
  const activityAgeDays = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : (now - parsed) / MS_PER_DAY;
  const createdParsed = pr.createdAt === undefined ? Number.NaN : Date.parse(pr.createdAt);
  const lifetimeAgeDays = Number.isNaN(createdParsed) ? Number.POSITIVE_INFINITY : (now - createdParsed) / MS_PER_DAY;
  const ageDays = Math.min(activityAgeDays, lifetimeAgeDays);
  const rule = DISPOSITION_RULES.find((r) => r.when(pr, policy, ageDays, now));
  if (!rule) {
    // UNREACHABLE — the terminal row matches unconditionally. This guards the
    // no-disposition=none invariant against a future table edit that drops it.
    // The safe fallback is the LEAST permissive disposition — escalate, never arm.
    return { disposition: "blocked-ambiguous", reason: "default (no rule matched) — escalating" };
  }
  const reason = rule.reason(pr, policy, ageDays, now);
  // W1-T1201 (design iii): the clamp above can only ever SUPPRESS the bare `ageDays >=
  // policy.staleDays` stale row — the only row that reads the computed scalar (this function's
  // own doc). When the raw (unclamped) activity age would have crossed that threshold but the
  // lifetime-clamped age does not, that suppression is a BROKEN-CLOCK SIGNAL, never a routine
  // non-event, so it is folded into whichever other row's reason actually fired.
  const clockSkewSuppressedStale =
    lifetimeAgeDays < activityAgeDays && activityAgeDays >= policy.staleDays && ageDays < policy.staleDays;
  if (!clockSkewSuppressedStale) return { disposition: rule.disposition, reason };
  return {
    disposition: rule.disposition,
    reason:
      `${reason} — AGE CLAMP (W1-T1201): raw activity age ${Math.floor(activityAgeDays)}d would cross the ` +
      `${policy.staleDays}d stale threshold, but this PR has existed only ${Math.floor(lifetimeAgeDays)}d ` +
      `(created ${pr.createdAt}) — a PR cannot be idle longer than it has existed, so stale was suppressed`,
  };
}

/**
 * W1-T983 — IS THIS OPEN PR'S DISPOSITION THE CAPPED-GREEN-REVIEW-ORPHAN SHAPE: the ONE
 * blocked-ambiguous disposition this task reclassifies to a reaching escalation tier, out of
 * every other blocked-ambiguous shape (merge conflicts, fix-rung strikes exhausted, stale
 * pending, the terminal catch-all, ...) which all keep the class they have today. PURE and
 * callable with no spawn and no GitHub — every input is a field {@link OpenPrView} already
 * carries plus {@link SweepPolicy.reviewOrphanCap}, mirrored EXACTLY off the SAME four
 * conditions the review-orphan-cap row of {@link DISPOSITION_RULES} above already reads
 * (`checksState`, `reviewState`, `reviewOrphanedByPush`, `priorReviewOrphans` against the cap,
 * `requiredContextsUnreadable`), never re-derived independently — so this predicate and that
 * row's `when` clause cannot drift apart.
 *
 * `run-task.ts`'s sweep-escalate closure (`buildSweepEffects`) is the sole reader: `true` here
 * is the only thing that moves ONE escalation off today's silent BLOCKED default. See that call
 * site's own doc for the measured ping-rate this narrow reclassification stays inside — the
 * cap fires ~1.7/day (rationale (3): five issues over three days), never the ~15.6/day BLOCKED
 * average a blanket tier change (reclassifying every blocked-ambiguous escalation) would
 * reinstate (rationale (4)).
 *
 * W1-T1018: DELIBERATELY still four conditions, no fifth `now`/backoff check added here. The
 * elapsed-time backoff ({@link reviewOrphanBackoffElapsed}) gates the DISPOSITION_RULES cap row
 * itself — a PR only ever REACHES this predicate (via the escalate closure) when that row already
 * matched at the SAME sweep pass's `deriveDisposition` call, which means backoff had already read
 * un-elapsed a moment earlier. Threading `now` through here too would only rewiden the surface the
 * signature-anchored mutation test below has to track, for no behavioural gain.
 */
export function isCappedReviewOrphanEscalation(pr: OpenPrView, policy: SweepPolicy): boolean {
  return (
    pr.checksState === "green" &&
    pr.reviewState === "none" &&
    pr.reviewOrphanedByPush === true &&
    (pr.priorReviewOrphans ?? 0) >= policy.reviewOrphanCap &&
    pr.requiredContextsUnreadable !== true
  );
}

/**
 * ARMING PARITY WITH THE RUN FLOW — the fix for the gap run-task.ts named in its own
 * capped-refusal comment ("`sweep.ts`'s independent 'checks green + review
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
 *
 * W1-T1028 — RECOVERS EVIDENCE FOR A HAND-FILED PR TOO, NOT JUST A PLAN TASK'S. Before this,
 * evidence recovery was keyed on `pr.taskId` RAW: a PR with no `Remudero-Task:` trailer (a
 * hand-filed PR, `pr.taskId === undefined`) made {@link postedArmFactsFromLedger} bail on its
 * own `!taskId` guard EVERY time, so this function always took the fail-open branch above —
 * arming was never actually REFUSED for a capped or irreversible hand-filed PR by this gate,
 * only by the run flow's OWN independent re-check downstream (`armAutoMerge`, run-task.ts),
 * which is the disagreement this task's rationale traces end to end: this gate says arm on
 * evidence it never looked for, the handoff refuses on evidence it never needed to look for
 * either, and the two only ever agreed by accident. The recovery key below is `pr.taskId ??
 * PR-<n>` — the SAME synthetic id the review lane already ledgers `review.posted` under for a
 * task-less PR ({@link "../run-task.js".escalationTaskIdFor}, `taskId ?? PR-<n>`, inlined here
 * rather than imported to keep this module free of a run-task.ts dependency) — so a hand-filed
 * PR that WAS reviewed is judged on the SAME head-bound verdict the run flow would find, and
 * one that was NEVER reviewed still takes the fail-open branch above, unchanged. This is what
 * makes the decision this function returns the head-bound one the handoff should carry, rather
 * than a blind pass for the entire population an absent task id used to hide from it.
 */
export function decideSweepArm(
  pr: OpenPrView,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  // W1-T1028 — appended LAST, the SAME idiom {@link decideAutoMergeArm}'s own `irreversible`
  // parameter already uses, so no positional caller shifts and today's behaviour is byte-for-
  // byte unchanged when omitted. `OpenPrView` gains no new field for this: the run flow's own
  // classification (`irreversibleSignalForWorktree`, run-task.ts) is worktree-bound and the
  // sweep's reconciliation pass has no worktree for an arbitrary open PR to classify from —
  // inventing an always-`undefined`-in-production field would only add an unproducible entry
  // to `OpenPrView` (see producer-completeness.test.ts) for no present caller to fill. A future
  // caller that DOES have a head-bound classification (a ledgered one, or a fresh worktree scan)
  // can supply it here without this function's signature changing again.
  irreversible?: boolean,
): ArmDecision {
  const armId = pr.taskId ?? `PR-${pr.prNumber}`;
  const facts = postedArmFactsFromLedger(ledgerLines, armId, pr.headSha);
  if (!facts) {
    return { arm: true, reason: "no ledgered verdict recoverable for this head — arming as before (no evidence to refuse on)" };
  }
  const override = facts.capped ? cappedOverrideFromLedger(ledgerLines, armId, pr.headSha) : undefined;
  return decideAutoMergeArm(
    { state: "success", capped: facts.capped, planOnly: facts.planOnly },
    false,
    override,
    irreversible,
  );
}

/** One armed-and-stalled PR: both facts that make it stalled, carried together. */
export interface ArmedStalledPr {
  prNumber: number;
  prUrl: string;
  /** The task this PR credits, when the gateway resolved one. */
  taskId?: string;
  /** The head the arm is pinned to — the sha a later verdict would be bound to. */
  headSha: string;
}

/**
 * W1-T528 — the terminal outcome of ONE `gh pr update-branch` request (design v: async, and this
 * shard does not pretend to settle every failure mode — only these three are established without
 * a live call against a real PR).
 *  - `"updated"`: GitHub ACCEPTED the request (the update itself completes asynchronously).
 *  - `"conflict"`: GitHub refused (a real merge conflict, or a diverged-not-merely-behind head) —
 *    reported on the ledger and never retried by this same call.
 *  - `"error"`: any other failure (network, auth, rate limit) — informational; a later pass's own
 *    fresh selection may try again, this call does not.
 */
export type UpdateBranchOutcome = "updated" | "conflict" | "error";

/**
 * W1-T520 — ARMED AND BEHIND, THE TWO FACTS NOTHING JOINED.
 *
 * The sweep already holds both halves per PR and never puts them together:
 * {@link OpenPrView.autoMergeArmed} says a PR has asked GitHub to merge it, and
 * {@link OpenPrView.mergeState} says its head is `behind` the base. Separately,
 * each is unremarkable. TOGETHER they describe a PR that has done everything it
 * can and stopped: it will not merge, nothing will retry it, and it is
 * indistinguishable in the ledger and on every surface from a PR still waiting
 * for CI.
 *
 * WHY THE DETECTOR AND NOT THE FIX. `allow_update_branch` OFFERS the update
 * button; it does not press it. Re-derived 2026-08-15: with that setting TRUE,
 * EIGHT OF NINE open PRs read `behind` and SEVEN of those were armed, unchanged
 * for hours. But this predicate is deliberately INERT about that — it reports
 * and does not act, because acting means minting a NEW HEAD, and a verdict is
 * sha-pinned (`priorActionsFromLedger` keys `postReviewed` on
 * `${taskId}@${headSha}`), so every update discards the verdict it was waiting
 * on. Clearing N that way costs N+(N-1)+…+1 reviews. The action half needs a
 * selection rule and its own ruling; this shard scopes it OUT.
 *
 * PURE, AND FAIL-QUIET. No I/O, no GitHub call: the caller supplies what it
 * already fetched, the shape every other decision in this module takes. A PR
 * whose `mergeState` was never read is `undefined` and yields nothing — an
 * unread fact is not a stall, the same fail-closed default `mergeState` carries
 * everywhere else in this file.
 *
 * THE QUIET CASE IS THE COMMON CASE AND IS FREE. Armed-and-current yields
 * nothing; behind-but-unarmed yields nothing. A detector that fired on either
 * would name every open PR every pass, which is the noise floor that makes an
 * advisory unreadable.
 */
export function armedButStalled(prs: readonly OpenPrView[]): ArmedStalledPr[] {
  const out: ArmedStalledPr[] = [];
  for (const pr of prs) {
    if (pr.autoMergeArmed !== true) continue;
    if (pr.mergeState !== "behind") continue;
    out.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
      headSha: pr.headSha,
    });
  }
  return out;
}

/**
 * W1-T528 — THE ACTION HALF OF W1-T520. SELECTS AT MOST ONE PR FROM {@link armedButStalled}'S
 * OWN SET, NEVER A SECOND PREDICATE COMPUTING THE SAME TWO FACTS (design note i).
 *
 * ONE PER PASS, OLDEST HEAD FIRST (design ii): updating mints a NEW head and a verdict is
 * sha-pinned (`priorActionsFromLedger` keys `postReviewed` on `${taskId}@${headSha}`), so every
 * update discards the verdict it was waiting on — updating the WHOLE stalled set each pass costs
 * N+(N-1)+…+1 reviews (observed: updating one put four others behind and the fleet re-updated
 * them itself). {@link oldestActivityFirst} is the SAME comparator {@link selectReviewAdmission}
 * (W1-T526) uses for its own disjoint population (design iii) — a loser this pass is strictly
 * older next pass, the only ranking that cannot starve a PR forever.
 *
 * TWO EXCLUSIONS ON TOP OF THE DETECTOR'S OWN TWO FACTS (design iv) — a red/blocked/
 * awaiting-human PR and an already-current PR need NO re-check here: an armed PR whose checks
 * are red cannot itself read `mergeState: "behind"`, and a current PR is not `"behind"` at all,
 * so both are already excluded by `armedButStalled` and re-testing either would be the second
 * predicate this design forbids.
 *  - A DRAFT ({@link OpenPrView.isDraft} `=== true`) — the operator's hold. NEVER touched.
 *  - AN IN-FLIGHT HEAD: {@link taskIdFromRunBranch} reads the task id a `run-<taskId>-<epochMs>`
 *    branch attributes to (the SAME extractor `projectPlan`, status.ts, already uses) and, when
 *    it names a task present in `inFlightTaskIds`, that PR is skipped — a live worker is still
 *    pushing to this exact head (the #1902 shape: a mid-pass push raced its own PR's
 *    `remudero-review`). Intended as `liveInflightRuns` (run-task.ts) — "in flight" here means
 *    exactly what it means everywhere else in the fleet (see that function's own doc), never a
 *    second, looser definition. A head that is not a run-branch at all (foreign/human-authored)
 *    can never match and is never excluded by this rule.
 */
export function selectUpdateBranchTarget(
  prs: readonly OpenPrView[],
  now: number,
  inFlightTaskIds: ReadonlySet<string> = new Set(),
  staleGateWorkflowsByPr: ReadonlyMap<number, readonly string[]> = new Map(),
  updatedForWorkflow: ReadonlySet<string> = new Set(),
): ArmedStalledPr | undefined {
  // W1-T1212 (design ii): the UNION of two disjoint-by-construction predicates, never a widening
  // of either — `armedButStalled` still answers "armed and behind" and nothing here re-derives
  // it. A PR named by both (should the two facts ever coincide) contributes ONE candidate: the
  // first writer wins, and which shape wins carries no meaning `oldestActivityFirst` reads below.
  const combined = new Map<number, ArmedStalledPr>();
  for (const c of [...armedButStalled(prs), ...redPrWithStaleGate(prs, staleGateWorkflowsByPr, updatedForWorkflow)]) {
    if (!combined.has(c.prNumber)) combined.set(c.prNumber, c);
  }
  const candidates = [...combined.values()];
  if (candidates.length === 0) return undefined;
  const byNumber = new Map<number, OpenPrView>(prs.map((pr) => [pr.prNumber, pr]));
  const eligible = candidates.filter((s) => {
    const view = byNumber.get(s.prNumber);
    if (!view) return false; // cannot happen — both predicates only derive from `prs` itself
    if (view.isDraft === true) return false;
    const runTaskId = taskIdFromRunBranch(view.headRefName);
    if (runTaskId !== undefined && inFlightTaskIds.has(runTaskId)) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;
  const eligibleViews = eligible.map((s) => byNumber.get(s.prNumber)!);
  const winnerView = oldestActivityFirst(eligibleViews, now);
  return eligible.find((s) => s.prNumber === winnerView?.prNumber);
}

/**
 * One PR {@link redPrWithStaleGate} selected — sibling to {@link ArmedStalledPr}, carrying the
 * ONE extra fact the caller needs: which failing check's workflow definition moved on main,
 * so the pair can be remembered (design note iv) and never re-selected for the same workflow.
 */
export interface StaleGatePr extends ArmedStalledPr {
  /** The currently-failing check whose workflow blob differs between this PR's merge ref and main. */
  staleWorkflow: string;
}

/**
 * W1-T1212 — A RED PR RUNS A FROZEN COPY OF THE VERY GATE THAT BLOCKS IT. `pull_request`
 * evaluates `refs/pull/<n>/merge`, whose base parent is pinned at the PR's last `synchronize` —
 * so a gate fixed on main (the #2477 shape: a filter added to `.github/workflows/ci-gate.yml`)
 * never reaches a PR sitting on an older merge ref, and the PR fails a check main would now pass.
 * `armedButStalled` cannot reach this population at all: a red PR is never armed (GitHub does not
 * merge-eligibility-arm a checks-red head), so it can never enter `armedButStalled`'s own
 * `autoMergeArmed === true` gate, and the loop this closes has no exit that does not involve a
 * human (rationale (2)).
 *
 * SIBLING TO `armedButStalled`, NEVER A WIDENING OF IT (design note ii): this predicate asks a
 * DIFFERENT question — "is this red PR's OWN failing gate stale" — over a population
 * `armedButStalled` structurally excludes. `selectUpdateBranchTarget` selects across the union of
 * both, one PR per pass, oldest head first, exactly as it already does for the armed-and-behind
 * set.
 *
 * THE DISCRIMINATOR IS EXACT (design note i), never "behind main" alone (rationale (4): with
 * `required_status_checks.strict` false, behind-ness alone would fire on essentially every open
 * PR and pay a rebase storm for nothing). `staleGateWorkflowsByPr` is the caller's own answer,
 * per PR, to "which of THIS head's currently-failing checks (a subset of {@link
 * OpenPrView.ciFailures}) are defined by a workflow file whose blob sha differs between the
 * merge ref and main right now" — a single contents read per file (run-task.ts wires the real
 * `gh api` read; this predicate stays pure and takes the answer as data, the same shape
 * `inFlightTaskIds` already takes for a fact only run-task.ts can fetch).
 *
 * REFUSED BY NAME (design note iv):
 *  - CONFLICTED (`mergeState === "dirty"` or `mergeable === false`) — resolving a conflict is
 *    judgement, and GitHub refuses an update-branch request against one anyway
 *    ({@link UpdateBranchOutcome} already carries `"conflict"` for exactly that). Never attempted
 *    here, however stale the PR's own gate copy is.
 *  - ALREADY UPDATED FOR THIS WORKFLOW — `updatedForWorkflow` carries every `${prNumber}:${name}`
 *    pair this lane has already requested an update for; a second request for the SAME pair is a
 *    no-op that still spends a head, so a PR whose only stale name(s) are all already-spent is
 *    skipped, never re-selected. A PR with an UNSPENT stale name is still eligible even if it
 *    also carries an already-spent one — `.find` below picks the first fresh name.
 *
 * The draft veto and the in-flight-head veto (design note v) are NOT re-checked here — they are
 * `selectUpdateBranchTarget`'s own job, applied to the union exactly once.
 */
export function redPrWithStaleGate(
  prs: readonly OpenPrView[],
  staleGateWorkflowsByPr: ReadonlyMap<number, readonly string[]>,
  updatedForWorkflow: ReadonlySet<string> = new Set(),
): StaleGatePr[] {
  const out: StaleGatePr[] = [];
  for (const pr of prs) {
    if (pr.checksState !== "red") continue;
    if (pr.mergeState === "dirty" || pr.mergeable === false) continue;
    const staleNames = staleGateWorkflowsByPr.get(pr.prNumber) ?? [];
    const fresh = staleNames.find((name) => !updatedForWorkflow.has(`${pr.prNumber}:${name}`));
    if (fresh === undefined) continue;
    out.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
      headSha: pr.headSha,
      staleWorkflow: fresh,
    });
  }
  return out;
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
  /**
   * W1-T186: which of {@link ObservedBlockerState}'s four named states this escalation
   * observed, or `undefined` when none applies (an ordinary review-failure/contradictory
   * block, where the criterion fields above already say everything there is to say).
   */
  observedState?: ObservedBlockerState;
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
            // W1-T186: "checks", never "CI" — this same sentence renders inside a CONFLICTED
            // escalation too (strike history predates a later-discovered conflict), and that
            // escalation must never contain the literal word "CI" (it never ran one).
            `checks ${s.ciGreen ? "went green" : "did not go green"}` +
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

  const baseQuestion = criterion
    ? `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): after ${strikeHistory.length} fix strike(s) — ${tried} — ` +
      `"${criterion}" is still unmet. The reviewer requires: "${reviewerRequirement}". The spec's own proof text says: ` +
      `"${specText}". ${decisionSuffix}`
    : `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): ${reason} — ${tried}. There is no single actionable unmet ` +
      `criterion to point at. ${decisionSuffix}`;

  // W1-T186: prepend the named observed-blocker facts (CONFLICTED/FAILING/ABSENT/PENDING, plus
  // the raw mergeable/mergeableState GitHub reported) EVERY escalation carries them when
  // observed — never only the criterion-shaped ones. "" when observedBlockerState found none of
  // the four to name AND no mergeable/mergeableState was read, so an ordinary review-failure
  // question renders byte-identical to before this task.
  const observedState = observedBlockerState(pr);
  const observedFacts = renderObservedFacts(pr, observedState);
  const question = observedFacts ? `${observedFacts} ${baseQuestion}` : baseQuestion;

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
    observedState,
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

/** The last line in `lines` matching `pred` — append-only files read oldest-first, so the
 *  last match is the NEWEST record. Shared by both halves of {@link operatorVerdictEvidence}. */
function lastMatching<T extends Record<string, unknown>>(lines: ReadonlyArray<T>, pred: (l: T) => boolean): T | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pred(lines[i])) return lines[i];
  }
  return undefined;
}

/**
 * W1-T435: the fix rung's OPERATOR-STEERED re-arm, producing the SAME {@link
 * OpenPrView.pendingAnswer} shape W1-T78 already wired end-to-end but never had a producer
 * for (see that field's own "SCOPE" doc) — routed through the identical `blocked-fixable`
 * DISPOSITION_RULES row and `strikeCapForAnswer` ceiling, never a second re-arm mechanism.
 * ONE evidence pass, TWO console-native sources, both local files (no GitHub read):
 *
 *   1. A `wrong`/`needs-follow-up` one-tap verdict (POST /v1/drain/feedback,
 *      lib/panel-actions.ts's `buildDrainFeedbackRoute`) carrying a STEERING NOTE — the
 *      `operator_feedback` ledger line's `note`, quoted VERBATIM (never paraphrased, matching
 *      `runFixRung`'s own `constraint` contract) with attribution, so the fix worker sees it
 *      as the operator's own words, not a synthesized instruction. A `good` verdict — praise —
 *      NEVER contributes: re-arming on praise would spin the rung forever on a PR nobody
 *      objected to (this task's second falsifier direction).
 *   2. An ANSWERED clarification (POST /v1/questions/answer, lib/panel-actions.ts's
 *      `buildAnswerQuestionRoute`, written to `plan/questions.ndjson` by worker.ts's
 *      `appendQuestionAnswer`) — the answer text, verbatim, exactly as W1-T78's mechanism
 *      always intended to consume it. A QUESTION with no matching answer line contributes
 *      nothing (this task's first falsifier direction's mirror: silence never re-arms either).
 *
 * Both sources key on `taskId` alone (never `drainRunId`/head sha) — the fix rung dispatches
 * per TASK, and an operator's verdict/answer is a judgment on the task's current attempt,
 * addressed by whichever strike comes next. `undefined` when neither source has anything —
 * the caller ({@link "../run-task.js".buildOpenPrViews}) then leaves `pendingAnswer` unset,
 * exactly as it always has for every PR this producer hasn't reached yet.
 */
export function operatorVerdictEvidence(
  taskId: string,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  questionLines: ReadonlyArray<Record<string, unknown>>,
): { constraint: string; resetStrikeCounter?: boolean } | undefined {
  const parts: string[] = [];

  const feedback = lastMatching(ledgerLines, (l) => l.step === "operator_feedback" && l.task_id === taskId);
  const verdict = typeof feedback?.verdict === "string" ? feedback.verdict : undefined;
  const note = typeof feedback?.note === "string" ? feedback.note : undefined;
  if ((verdict === "wrong" || verdict === "needs-follow-up") && note && note.trim() !== "") {
    parts.push(`Operator marked this run "${verdict}": ${note}`);
  }

  const answer = lastMatching(questionLines, (l) => typeof l.answer === "string" && l.task === taskId);
  if (answer && typeof answer.answer === "string" && answer.answer.trim() !== "") {
    parts.push(answer.answer);
  }

  return parts.length > 0 ? { constraint: parts.join("\n\n") } : undefined;
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

/**
 * The outcome names `armAutoMerge` returns (run-task.ts's `ArmOutcome`). Mirrored here rather
 * than imported to keep lib/sweep.ts free of a run-task.ts dependency; `armOutcomeArmed` below
 * is the single place that decides which of them count as having actually armed.
 */
export type ArmOutcomeName =
  | "no-task-id"
  | "head-unavailable"
  | "ledger-refused"
  | "armed"
  | "direct-merged"
  | "direct-merge-failed"
  | "arm-error-ignored"
  // W1-T947: `armAutoMergeAtOpen` refused because the diff is classified IRREVERSIBLE
  // (W1-T919) — mirrored here for the same reason every other member is, so `armOutcomeArmed`
  // (below) keeps type-checking against run-task.ts's `ArmOutcome` without importing it.
  | "irreversible-refused"
  // W1-T1000002: `attemptArm` refused because an operator hold stands over this PR — mirrored
  // here for the same reason `irreversible-refused` is: a deliberate refusal, never armed here
  // or later (until the hold is released, at which point a fresh pass re-derives whole).
  | "hold-refused";

/**
 * W1-T1117: `armFailureAction`'s (run-task.ts) return value, mirrored here rather than imported
 * for the same reason {@link ArmOutcomeName} already is — `lib/sweep.ts` stays free of a
 * run-task.ts dependency. `"direct-merge"` is deliberately absent: that class never reaches an
 * `"arm-error-ignored"` outcome (it takes the direct-merge fallback instead), so it can never be
 * the `failureClass` a caller attaches below.
 */
export type ArmFailureClass = "transient" | "retryable" | "unknown";

/**
 * W1-T1117: the richer shape `SweepDeps.arm` may return instead of the bare {@link
 * ArmOutcomeName} — the SAME "outcome ∪ richer object" widening run-task.ts's own
 * `ArmAttemptResult` already established for `armAutoMergeDetailed`, reused here rather than
 * reinvented. `failureClass` is populated ONLY alongside the `"arm-error-ignored"` outcome (see
 * the "mergeable" arm below for how it changes the dedup decision); every other outcome either
 * never attempted a merge (no failure to classify) or resolved to a different, already-distinct
 * outcome (`direct-merged` / `direct-merge-failed`), so this field carries nothing for them.
 */
export interface ArmAttemptOutcome {
  outcome: ArmOutcomeName;
  failureClass?: ArmFailureClass;
}

/**
 * TRUE only for outcomes that genuinely armed or merged.
 *
 *   armed          — `gh pr merge --auto` succeeded; auto-merge is registered.
 *   direct-merged  — GitHub refused `--auto` on an already-clean PR and the fallback merged it
 *                    outright. A success, though not an arm: the PR leaves `openPrs` next pass,
 *                    so nothing is left to retry.
 *
 * Every other outcome armed NOTHING:
 *   no-task-id / head-unavailable / ledger-refused  — returned before any arm was attempted.
 *   direct-merge-failed / arm-error-ignored         — the attempt was made and did not stick.
 *   irreversible-refused                            — a deliberate refusal (W1-T947), not a
 *                                                      failure; never armed here or later.
 * Whether a "not armed" outcome is RETRIED on a later pass is a separate question this function
 * does not answer — see the "mergeable" arm's own dedup logic below, which (W1-T1117) treats an
 * `"arm-error-ignored"` outcome carrying an `"unknown"` {@link ArmFailureClass} as terminal
 * (seeds the dedup, no retry) while every other non-armed outcome, including a `"transient"`/
 * `"retryable"`-classified `arm-error-ignored`, keeps re-deriving every pass exactly as before.
 */
export function armOutcomeArmed(outcome: ArmOutcomeName | void): boolean {
  // An `undefined` return is a fake/effect that predates this signature — treat it as armed,
  // which is exactly what the code assumed before, so no existing lane regresses.
  if (outcome === undefined) return true;
  return outcome === "armed" || outcome === "direct-merged";
}

/** Injected effects — the real command wires arm/close/fix/escalate; tests fake them. */
export interface SweepDeps {
  /**
   * Arm GitHub auto-merge (armAutoMerge). Idempotent at the GitHub level.
   *
   * RETURNS ITS OUTCOME. `armAutoMerge` does not throw — it returns one of seven
   * {@link ArmOutcomeName} values, five of which mean it armed NOTHING. The effect used to
   * discard that value and the sweep recorded `acted: true` regardless, which both hid the
   * refusal and (because `acted:true` seeds `prior.armed`) made it permanent: every later
   * pass logged `deduped: true, acted: false` and never retried. Observed live on PR #960 —
   * `acted=TRUE "arming auto-merge"` at 20:45:21, `deduped=true` at 21:14:07, and GitHub
   * reporting `auto_merge: null` with no `auto_merge_enabled` event ever.
   *
   * `void` remains valid so existing fakes that return nothing keep compiling; an undefined
   * return is treated as "armed" (the pre-existing assumption) rather than silently standing
   * down, so this change cannot make a working lane worse.
   *
   * W1-T1117: may also return the richer {@link ArmAttemptOutcome} — every existing fake
   * returning a bare {@link ArmOutcomeName} (or `void`) keeps compiling and behaving exactly as
   * before; only production wiring (`buildSweepEffects`, run-task.ts) attaches a `failureClass`.
   */
  arm: (
    pr: OpenPrView,
  ) => ArmOutcomeName | ArmAttemptOutcome | void | Promise<ArmOutcomeName | ArmAttemptOutcome | void>;
  /**
   * W1-T1000002 — WITHDRAW AN ARM THIS LANE DID NOT PLACE. Called ONLY when an operator hold
   * ({@link import("./review.js").automergeHoldFromLedger}) stands over a PR {@link
   * OpenPrView.autoMergeArmed} already reports armed — the converging half of the hold design:
   * a disarm alone is undone by the very next pass (the arming dedup reads GitHub's live armed
   * bit, which a disarm resets), so this fires EVERY pass the hold still stands and the PR still
   * reads armed, which is exactly as often as it takes, and zero times once GitHub's own bit
   * reads false. SAFE WHEN NOT ARMED — the real wiring is `disarmAutoMerge` (run-task.ts), which
   * never throws — so no extra probe per PR per pass is needed to learn whether an arm exists
   * before withdrawing it.
   *
   * Optional: omitted (every pre-existing fixture), a held-and-armed PR is still refused by
   * `alreadyDone` above (never re-armed BY THIS LANE) but nothing withdraws the STANDING arm —
   * never a silent regression for a fixture built before this task existed.
   */
  disarmAutoMerge?: (pr: OpenPrView, hold: AutomergeHold) => void | Promise<void>;
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
   *
   * W1-T473: MAY be invoked CONCURRENTLY with other PRs' calls to this same
   * function — `runSweep` no longer awaits one `postReview` before starting
   * the next. Concurrency is bounded (`policy.reviewLanes` — its own row as
   * of W1-T1049, no longer `policy.dispatchLanes`) and every concurrent call
   * is guaranteed a DISTINCT
   * `${taskId}@${headSha}` key — `runSweep` claims each key synchronously
   * before scheduling its call, so this function is never asked to run twice
   * for the same task+head at once. A caller wiring a real effect here (e.g.
   * spawning a reviewer worker) needs no locking of its own for THAT — it may
   * still want its own guard against unrelated concurrent posters (see
   * `postReviewStatusGuarded`'s `acquireReviewStatusLock`, which this dep's
   * real wiring already goes through).
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
   * sha-pinned re-post is safe to run alongside a task; dispatchFix/close/
   * escalate/depReview/arm stay strictly single-threaded, standing down
   * here until the NEXT full sweep picks them up. W1-T473: "mutex-serialized"
   * described the WHOLE pass being single-threaded — post-review calls
   * WITHIN one pass now run concurrently with each other too (bounded by
   * `policy.reviewLanes` as of W1-T1049 — its own row, no longer
   * `policy.dispatchLanes` — real per-`taskId@headSha` mutual exclusion —
   * see `runSweep`'s own doc), so it is no longer accurate to call this ONE
   * lane serialized; it is the one lane safe to run alongside `runOne`.
   */
  actionable?: (d: Disposition) => boolean;
  /**
   * THE ABSENT-CHECK-SUITE REMEDY (W1-T186 follow-up). Pushes an EMPTY commit to the PR's own
   * branch, minting a fresh head sha, and returns it. Optional: omitted (or absent, as in every
   * pre-existing fixture) the lane stands down exactly as it does today and the ordinary
   * escalation runs — never a silent no-op, the stand-down is named on the disposed line.
   */
  repushAbsent?: (pr: OpenPrView) => Promise<string | undefined>;
  /**
   * W1-T528 — press the update-branch button. Invoked AT MOST ONCE per pass, on the SINGLE PR
   * {@link selectUpdateBranchTarget} chose (never a loop, never a second attempt on the same
   * target THIS pass — see `runSweep`'s own wiring). Optional: omitted, the pass reports the
   * whole stalled set via `sweep.armed_stalled` exactly as before this existed and requests
   * nothing. A `"conflict"` outcome (GitHub 422) is REPORTED via a ledger line and never
   * retried by this call (design v) — whether a LATER pass tries the same or a different PR is
   * that pass's own fresh selection, not a retry loop here.
   */
  updateBranch?: (pr: ArmedStalledPr) => UpdateBranchOutcome | Promise<UpdateBranchOutcome>;
  /**
   * W1-T528: task ids with a LIVE in-flight run right now — intended as `liveInflightRuns`
   * (run-task.ts) mapped to its own `taskId` field. Consulted by {@link selectUpdateBranchTarget}
   * to skip a head a live worker is still pushing to. Omitted ⇒ empty set ⇒ no PR is excluded on
   * this axis, exactly as if every PR's worker had already finished.
   */
  inFlightTaskIds?: ReadonlySet<string>;
  /**
   * W1-T1212 — per red PR, the failing check names (a subset of that PR's own
   * {@link OpenPrView.ciFailures}) whose defining workflow file's blob sha differs between this
   * PR's OWN merge ref and main RIGHT NOW — the ONLY population {@link redPrWithStaleGate} draws
   * from. Intended as a per-pass `gh api` contents read (run-task.ts) — cheap and exact (that
   * predicate's own design note i), never re-derived from `checksState` alone, which is what let
   * a red PR spin forever behind a gate that had already moved on main (the #2434/#2477
   * incident this task closes). Omitted ⇒ empty map ⇒ no red PR is ever selected on this axis,
   * exactly as before this field existed.
   */
  staleGateWorkflowsByPr?: ReadonlyMap<number, readonly string[]>;
  /**
   * W1-T1212 (design note iv, "never fire twice on the same PR for the same workflow"): every
   * `${prNumber}:${workflowName}` pair this lane has ALREADY requested an update-branch for — an
   * update mints a new head, and a second request for the same stale pair is a no-op that still
   * spends one, so once fired the pair must be remembered and skipped. Intended as a ledger scan
   * over prior `sweep.update_branch.updated` rows' own `stale_workflow` field (run-task.ts) — the
   * SAME durable sink every other dedup in this module already reads, never a second store.
   * Omitted ⇒ empty set ⇒ every stale pair stays eligible, exactly as before this field existed.
   */
  updatedForWorkflow?: ReadonlySet<string>;
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
  /**
   * W1-T905 — "repair the instance, FILE THE CLASS" (fb-1784842083584-6cc22a, second half).
   * Best-effort capture of a §7B feedback entry for ONE classified surface {@link
   * dueRepairFilings} found due this pass. Optional: omitted, `runSweep` computes nothing and
   * files nothing — a pre-existing fixture with no knowledge of this dep keeps compiling and
   * behaving exactly as before this task. NEVER allowed to fail the pass that produced the
   * repairs it reports on: `runSweep` wraps every call in the SAME per-PR throw containment the
   * action switch already has (W1-T254) — a throw here is swallowed, the rest of the pass (and
   * every later PR in it) is untouched.
   *
   * The real wiring (`buildSweepEffects`, src/run-task.ts) is the ONE place this calls
   * `captureFeedback` (src/lib/feedback.ts) — and is ALSO where the dedup check lives: an
   * `existsSync` read on `feedbackEntryPath(root, filing.id)` before ever writing, mirroring
   * `src/lib/issues-intake.ts`'s own caller-side dedup for `fb-issue-<owner>-<repo>-<n>`. This
   * pure module never touches the filesystem itself (design note ix) — {@link dueRepairFilings}
   * recomputes fresh from ledger rows every call, with no memory of what was already filed; the
   * injected dep's own idempotent write is the entire "no second store" guarantee (design iii).
   */
  captureRepairFeedback?: (filing: RepairFilingCapture) => void | Promise<void>;
  /**
   * W1-T931 COST-ANOMALY SENTINEL — the `plan/policy.yaml` `costAnomaly.multiplier`/
   * `costAnomaly.minSamples` policy this pass consults (see `src/lib/cost-anomaly.ts`'s module
   * header for the full rationale). Optional: omitted, `runSweep` resolves
   * `loadDefaultCostAnomalyPolicy()` (memoized for the process lifetime, same "load once" shape
   * `loadDefaultPolicy` above already uses) — a test that wants a different multiplier/minSamples
   * without touching `plan/policy.yaml` on disk passes its own {@link CostAnomalyPolicy} here.
   */
  costAnomalyPolicy?: CostAnomalyPolicy;
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
  /** `<prNumber>@<headSha>` — sha-keyed like {@link PriorActions.fixed}, so a new head
   *  re-earns the arm attempt instead of being deduped forever on one prior success. */
  armed: Set<string>;
  /** `${prNumber}@${headSha}` — fix dispatch is head-keyed. */
  fixed: Set<string>;
  closed: Set<number>;
  /**
   * `pr@head` keys, exactly like `armed`/`fixed`/`depReviewed` above (W1-T514).
   * PR-number-only until this task, which let one `acted:true` blocked-ambiguous
   * line at head A dedup the SAME PR forever — including a genuinely NEW block at
   * a later head B, where `escalate()`'s own composite key (`headSha`, `cause` —
   * W1-T195) already knows how to open a fresh issue instead of appending to a
   * stale one. That transport-side fix was unreachable as long as this gate never
   * let a second head through. A new head must re-earn the attempt, same as every
   * sibling arm; the SAME head still dedupes (no per-push storm).
   */
  escalated: Set<string>;
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
  /**
   * W1-T970 — `${prNumber}@${headSha}` keys, built off the risk judge's OWN step
   * (`risk_judge.escalated`), the SAME shape `postReviewed` above takes off `review.posted`/
   * `review.post_refused`: a set built from another lane's own ledger line, never from
   * `sweep.disposed`. PR-NUMBER-KEYED, NOT TASK-ID-KEYED — deliberately unlike `postReviewed`:
   * the sibling sets `armed`/`fixed`/`escalated` already key on `pr_number`, the sweep has
   * `pr.prNumber` in hand at the lookup, and `runRiskJudge` (risk-judge.ts) now emits it, so
   * there is no `??` fallback anywhere on this path — the exact `${pr.taskId ?? ""}@${pr.headSha}`
   * collapse that shipped a matching-nothing row in #1931 has no equivalent here by construction.
   * A refusal expires on a NEW head sha (the key itself) or an explicit operator override
   * (`cappedOverrideFromLedger` — see the `mergeable` arm of `alreadyDone`'s switch below); it is
   * never cleared by time.
   *
   * W1-T1116: a MAP, not a Set, keyed identically — the VALUE is the escalation's own `issue_url`
   * (or `undefined` when an older row predates that field), read back by the `mergeable` arm so a
   * refused hold can name the SAME issue the sibling `risk_judge.escalated` row already points at,
   * rather than a reader having to find that row itself.
   */
  riskRefused: Map<string, string | undefined>;
  /**
   * ABSENT-check-suite re-push history, read from this module's OWN `sweep.absent_repush`
   * ledger step. TWO keys because one is not enough: `shas` (`<pr>@<oldHead>`) gives
   * same-head idempotence exactly like {@link PriorActions.fixed}, and `count` (per PR) is
   * the BOUND — a re-push mints a NEW sha, so a sha key alone would license an unbounded
   * chain of empty commits on a PR GitHub never schedules.
   */
  absentRepushes: Map<number, { count: number; shas: Set<string> }>;
}

/**
 * W1-T529 (iv) — WHAT EACH LANE'S STAND-DOWN COSTS, NAMED SO THE COST IS CHOSEN RATHER THAN
 * DISCOVERED, and carried verbatim into the PR's own `stand_down_reason` so a declined pass is
 * legible instead of looking idle.
 *
 * THIS TABLE NAMES A COST; IT DOES NOT DECIDE ANYTHING. By the time it is read the guarded call
 * has ALREADY been refused — {@link GhPaceFloorStandDownError} is thrown by `GhCallPacer.wait()`
 * BEFORE the call it guards ever runs (lib/open-prs-rest.ts's `paceGhEntry`, whose `wait()` sits
 * outside its own `try` precisely so this propagates un-rewrapped). So there is no "should this
 * lane stand down" branch to gate: the lane already did. A disposition missing from this table
 * still stands down, under the generic reason in {@link budgetFloorStandDown} — the table only
 * makes the specific cost sayable, which is what design (iv) asks for.
 */
const BUDGET_FLOOR_LANE_COST: Partial<Record<Disposition, string>> = {
  // Design (iv), verbatim: "A SKIPPED REVIEW leaves a GREEN PR UNMERGED — visible, recoverable
  // next pass." RECOVERABLE is the load-bearing half — see `budgetFloorStandDown`'s own doc for
  // the refusal key this deliberately does NOT write.
  "post-review": "a green PR is left unmerged this pass and re-derives next tick",
  // Design (iv), verbatim: "A SKIPPED FIX STRIKE MUST NOT CONSUME THE STRIKE."
  "blocked-fixable": "a fix dispatch is skipped and NO strike is spent",
  // Same lane, same dedup set (`fixed`) — W1-T106 folded `conflicted` into it, so it inherits
  // that guarantee rather than getting a second one.
  conflicted: "a conflict fix dispatch is skipped and NO strike is spent",
  // Arming is idempotent at the GitHub level, so a deferred arm loses nothing but a tick.
  mergeable: "an auto-merge arm is deferred one pass; arming is idempotent so nothing is lost",
  // An escalation not raised is strictly better than one raised twice; the PR stays open and is
  // re-derived whole next pass.
  "blocked-ambiguous": "an escalation is deferred; the PR stays open and is re-derived next pass",
  // The hold/terminal outcome is re-read from live state next pass, so nothing is carried.
  "dep-review": "a dependency review is deferred one pass and re-read from live state",
  // Closing a stale PR is the least urgent action the sweep takes.
  stale: "a stale-PR close is deferred one pass",
};

/**
 * W1-T529 (iv) — IS THIS THROW THE BUDGET FLOOR, AND WHAT DOES DECLINING THIS LANE COST? Returns
 * the `standDownReason` to record when it is, and `undefined` for every other throw — which stays
 * on the ordinary `actionError`/`sweep.action_failed` path, byte-for-byte unchanged.
 *
 * WHY THE TWO CLASSES MUST NOT SHARE A PATH. A stand-down is not a failed action: the call never
 * ran, nothing about THIS PR was observed, and nothing about it is known to be wrong. Routing it
 * through `actionError` would (a) count it in `actionsFailed`, and (b) in the post-review lane
 * write a `review.post_refused` row — and that row is not a diagnostic, it is a VERDICT.
 * {@link OpenPrView.reviewPostRefused}'s own doc says a second absence at the same sha is
 * escalated rather than retried, because "the one deterministic remedy already ran its course for
 * this exact push"; `reviewPostRefusedFor` (run-task.ts) keys it `taskId@headSha`, so a head
 * marked that way is never re-reviewed until a NEW PUSH mints a new sha. A PR that was merely
 * unaffordable for one tick would be deduped permanently and then escalated as ambiguous. That
 * same doc already draws exactly this line for the transient case: `review.post_failed` "does NOT
 * set this — that case must keep retrying, never escalate on a mere network hiccup." An exhausted
 * budget is that class, not the refusal class.
 *
 * AND NO SECOND NO-STRIKE MECHANISM (design (iv) in writing: "PRESERVE THAT EXISTING PROPERTY
 * RATHER THAN INVENT A SECOND MECHANISM"). Every caller sets `acted = false`, and that alone is
 * the guarantee: {@link priorActionsFromLedger} admits a `sweep.disposed` row into
 * `armed`/`fixed`/`escalated`/`closed`/`depReviewed` only when `line.acted === true`, so a
 * stood-down lane seeds no dedup key, spends no strike, and is re-derived whole next pass — the
 * property W1-T527 established, reused rather than reimplemented.
 */
function budgetFloorStandDown(e: unknown, disposition: Disposition): string | undefined {
  if (!(e instanceof GhPaceFloorStandDownError)) return undefined;
  const cost = BUDGET_FLOOR_LANE_COST[disposition] ?? "this lane's action is skipped and re-derives next tick";
  return `gh budget at or below the stand-down floor (${e.resource} at ${e.remaining}/${e.limit}) — ${cost}`;
}

function priorActionsFromLedger(lines: Array<Record<string, unknown>>): PriorActions {
  const armed = new Set<string>();
  const fixed = new Set<string>();
  const closed = new Set<number>();
  const escalated = new Set<string>();
  const depReviewed = new Set<string>();
  const postReviewed = new Set<string>();
  const riskRefused = new Map<string, string | undefined>();
  const absentRepushes = new Map<number, { count: number; shas: Set<string> }>();
  for (const line of lines) {
    // W1-T254: OUTCOME-KEYED, off the review lane's OWN ledger lines — never
    // `sweep.disposed`. See PriorActions.postReviewed's doc.
    if (line.step === "review.posted" || line.step === "review.post_refused") {
      if (typeof line.task_id === "string" && typeof line.head_sha === "string") {
        postReviewed.add(`${line.task_id}@${line.head_sha}`);
      }
      continue;
    }
    // W1-T970: OUTCOME-KEYED off the risk judge's OWN step, exactly like `postReviewed` above —
    // never `sweep.disposed`. PR-NUMBER-KEYED, NOT TASK-ID-KEYED (see PriorActions.riskRefused's
    // doc for why) — both fields are REQUIRED, no `??` fallback, so a pre-W1-T970 escalation row
    // (written before `runRiskJudge` emitted these fields) is never matched.
    if (line.step === "risk_judge.escalated") {
      if (typeof line.pr_number === "number" && typeof line.head_sha === "string") {
        // W1-T1116: carry `issue_url` along with the key — see PriorActions.riskRefused's own
        // doc for why this is a Map now, not a Set. `undefined` (not a `??` fallback) when an
        // older row predates the field, so the `mergeable` arm can tell "no issue to name" from
        // "row missing" without a sentinel string.
        riskRefused.set(`${line.pr_number}@${line.head_sha}`, typeof line.issue_url === "string" ? line.issue_url : undefined);
      }
      continue;
    }
    // Our own step, not `sweep.disposed` — the re-push is an action inside the
    // blocked-ambiguous lane, so the disposed line's own dedup keys cannot carry it.
    if (line.step === "sweep.absent_repush") {
      const n = typeof line.pr_number === "number" ? line.pr_number : undefined;
      if (n !== undefined) {
        const e = absentRepushes.get(n) ?? { count: 0, shas: new Set<string>() };
        e.count += 1;
        if (typeof line.old_head === "string") e.shas.add(`${n}@${line.old_head}`);
        absentRepushes.set(n, e);
      }
      continue;
    }
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const pr = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (pr === undefined) continue;
    switch (line.disposition) {
      case "mergeable":
        // SHA-KEYED, exactly like `fixed` below. Keyed by PR number alone this set had no
        // expiry: one `acted:true` line — including one recorded for an arm that never
        // happened — deduped that PR forever. A new head must re-earn the attempt.
        armed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
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
        // W1-T514: SHA-KEYED, exactly like `fixed`/`armed` above — a new head
        // must re-earn the attempt rather than being deduped by a stale one.
        escalated.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
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
  return { armed, fixed, closed, escalated, depReviewed, postReviewed, riskRefused, absentRepushes };
}

/**
 * W1-T1110 — HAS THE MOST RECENT `fix.dispatch` FOR THIS TASK ALREADY CONCLUDED WITHOUT LANDING
 * A NEW HEAD? `prior.fixed` (above) is keyed `pr@headSha` off `sweep.disposed` ROWS and records
 * only that a fix was DISPATCHED — an attempt, never an outcome (see that field's own doc). The
 * key clears on a new head, and the head only changes when a fix runs and PUSHES; a dispatch
 * whose worker demonstrably ran (spending a real strike — see `fix.dispatch`) and then ENDED —
 * review still failing, or CI never green — without landing a push leaves the key set and the
 * head unmoved, so every later pass reads `alreadyDone` and stands down FOREVER (rationale (4)).
 *
 * Reads exactly the two of design note (iii)'s three named steps that answer "concluded, and
 * did NOT succeed": a `fix.review` row with `state !== "success"` (a real review ran and still
 * failed), or a `fix.ci_not_green` row (CI never went green for that strike). The THIRD named
 * step, `fix.resolved`, is read too — but deliberately never counted as "stalled": it fires only
 * once `review.state === "success"`, i.e. a strike that genuinely landed a working push. Re-arming
 * on a resolved strike would risk a second, redundant dispatch on a task the rung already
 * finished; the caller's own sha-keyed `prior.fixed.has(pr@headSha)` check already retires that
 * head the moment GitHub reflects the new push, so nothing here needs to also flip it — a
 * dispatch that DID move the head must keep suppressing a second attempt (acceptance 3).
 *
 * TASK-ID KEYED, not head-sha keyed: none of these three steps carries a `head_sha` (they are
 * strike-scoped, logged by `runFixRung` per round — see run-task.ts's `deps.log("fix.review", …)`
 * / `deps.log("fix.ci_not_green", …)` / `deps.log("fix.resolved", …)` — never push-scoped), so
 * there is nothing else to key them by except the SAME `task_id` `fix.dispatch` already stamps on
 * every line it writes (W1-T78's `dispatchFix` fix — see `priorStrikesFor`'s own doc in
 * run-task.ts). Reading them without a sha is safe because every caller of this function already
 * guards on `prior.fixed.has(pr@headSha)` being true for the PR's CURRENT, live head — i.e. the
 * head has provably not moved since the dispatch that set that key, so any strike this task has
 * run since is necessarily against that SAME stuck head.
 *
 * Scoped to the MOST RECENT `fix.dispatch` only, by design: each `fix.dispatch` line resets the
 * verdict, so an EARLIER strike's stalled conclusion never re-arms a LATER, still-in-flight
 * strike on the same head — design (i)'s idempotence (two dispatches racing the same sha must
 * still not both spend a strike) survives unchanged.
 *
 * `undefined` taskId ⇒ `false`: a cold blocked-fixable dispatch with no resolvable task carries
 * no `task_id` to key against, and this must never throw or false-positive on nothing to read.
 *
 * W1-T1210 — A TASKID WITH NO `fix.dispatch` ROW OF ITS OWN IS THE SAME "CONCLUDED WITHOUT
 * LANDING A NEW HEAD" SHAPE, ONE STEP EARLIER. `dispatchFix` (sweep.ts's own caller) can throw
 * before `runFixRung` ever starts — `.git/config.lock` contention was the observed cause
 * (rationale, incident note) — and the `sweep.disposed` row that seeds `prior.fixed` gets
 * written with `acted: true` regardless (the swallow W1-T1127 closed GOING FORWARD, not
 * retroactively for rows it already wrote). Such a seed owns no `fix.dispatch` row at all — not
 * even the first line a real rung writes — so it can never produce a `fix.review`/
 * `fix.ci_not_green`/`fix.resolved` for this function to read, and the loop above leaves
 * `stalled` at its `false` initial value forever, exactly as if the rung were still healthily in
 * flight. It is not: nothing ever started. The absence of `fix.dispatch` itself — read from rows
 * already in the ledger, no new read, no state file, no clock (design (ii)/(v)) — is the
 * falsifier: a taskId that HAS a `fix.dispatch` row keeps the loop's existing verdict untouched
 * (acceptance: "a gate with an owning fix row still suppresses"); a taskId with NONE is treated
 * as stalled too (acceptance: "a gate with no owning fix row no longer suppresses"), so the
 * caller's `alreadyDone` clears and the next pass is eligible to re-derive — never itself a
 * dispatch (design (iv); the strike cap at the spending site, untouched, still bounds whatever
 * follows).
 */
function fixRungStalledWithoutNewHead(lines: Array<Record<string, unknown>>, taskId: string | undefined): boolean {
  if (!taskId) return false;
  let stalled = false;
  let dispatched = false;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "fix.dispatch") {
      dispatched = true;
      stalled = false;
    } else if (line.step === "fix.ci_not_green") {
      stalled = true;
    } else if (line.step === "fix.review") {
      stalled = line.state !== "success";
    } else if (line.step === "fix.resolved") {
      stalled = false;
    }
  }
  // W1-T1210: no owning `fix.dispatch` row at all ⇒ treated as stalled — see the doc above.
  return stalled || !dispatched;
}

// ── W1-T905 — "repair the instance, FILE THE CLASS" (fb-1784842083584-6cc22a, second half) ──
//
// A `sweep.disposed` row already NAMES a classified surface on its own `disposition` field
// every time the sweep repairs a PR (`DISPOSITION_RULES` above), but nothing ever rolls that
// classification up across PRs — a defect the fleet repairs fifteen times is rediscovered by
// hand fifteen times, the exact operator-archaeology channel §7B exists to close (rationale).
//
// THIS IS NOT A ROUTER, A LANE OR A RUNG (design note i): no new disposition, no new `when:`,
// no new repair verb. The ONE thing added is the bridge from a RECURRING classified surface to
// a §7B feedback entry — a pure fold ({@link dueRepairFilings}) over rows that already exist,
// plus one injected capture dep ({@link SweepDeps.captureRepairFeedback}).

/** The dispositions {@link priorActionsFromLedger}'s own switch above treats as an actual
 *  REPAIR verb having fired (`fixed`/`closed`/`escalated`) — `mergeable` (armed) is the HEALTHY
 *  outcome, not a defect, and `dep-review`/`post-review`/`wait` are ROUTING/no-op states with no
 *  repair verb of their own. Recurrence filing is scoped to exactly these four so a `mergeable`
 *  PR arming fifteen times (ordinary, healthy throughput) never floods the §7B inbox — the
 *  wrong-recurrence-key failure mode this task's own risk note names explicitly. */
const REPAIR_SURFACE_DISPOSITIONS: ReadonlySet<Disposition> = new Set(["blocked-fixable", "blocked-ambiguous", "stale", "conflicted"]);

/** One PR's own repair, as read off its `sweep.disposed` row — never invented (design v). */
export interface RepairFilingInstance {
  prNumber: number;
  prUrl: string;
  /** The ledgered disposition `reason` verbatim — for a CI-failure surface this already embeds
   *  the failing check name(s) + sha(s) `describeCiFailures` names, when observed. */
  reason: string;
  headSha: string;
  /** The `sweep.disposed` row's own ledgered timestamp (ISO-8601, stamped by `appendLedger`). */
  ts: string;
}

/** One classified surface due for exactly ONE `repair#<surface>` feedback entry this pass —
 *  {@link dueRepairFilings}'s output, and {@link SweepDeps.captureRepairFeedback}'s input via
 *  {@link renderRepairFilingRaw}/the `repair#<surface>` origin string `runSweep` builds from it. */
export interface RepairFilingRecurrence {
  surface: Disposition;
  threshold: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  /** Distinct PRs (by `prNumber`) repaired for `surface` inside the window — length >= threshold. */
  instances: RepairFilingInstance[];
  /** Deterministic — `fb-repair-<surface>-<window-bucket>` (mirrors `src/lib/issues-intake.ts`'s
   *  `fb-issue-<owner>-<repo>-<n>`): STABLE for the SAME surface across every pass inside the
   *  SAME window, so the real wiring's `existsSync` dedup (design iii) never re-files twice for
   *  one window, and a genuinely new window can file again once the pattern persists into it. */
  id: string;
}

/**
 * PURE fold over already-written `sweep.disposed` ledger rows (design vi — no new ledger row,
 * nothing new to read): for each {@link REPAIR_SURFACE_DISPOSITIONS} surface, counts the
 * DISTINCT PRs (`acted: true`) repaired for it inside the CURRENT policy window (an epoch-
 * anchored bucket of `policy.repairFilingWindowDays`, so the same window yields the same bucket
 * — and therefore the same {@link RepairFilingRecurrence.id} — on every call for as long as
 * `now` stays inside it). A surface reaching `policy.repairFilingThreshold` distinct PRs is
 * DUE — "fifteen PRs repaired for one surface must produce ONE entry, never fifteen, and a
 * single repair must produce NONE: one occurrence is a repair, a recurrence is a defect"
 * (design ii, verbatim). Counting DISTINCT PRs, not raw rows, is deliberate: a single PR stuck
 * on the same surface across many sweep passes (re-dispatched each time) must never inflate the
 * count on its own — recurrence is measured across the FLEET's PRs, never one PR's retry count.
 *
 * No I/O, no dedup memory of its own — recomputes fresh from `lines` every call. The caller
 * (`runSweep`) decides whether a returned candidate is ACTUALLY worth writing (via the injected
 * {@link SweepDeps.captureRepairFeedback}, whose real wiring is what performs the idempotent
 * write — see that field's own doc).
 */
export function dueRepairFilings(
  lines: ReadonlyArray<Record<string, unknown>>,
  now: number,
  policy: Pick<SweepPolicy, "repairFilingThreshold" | "repairFilingWindowDays">,
): RepairFilingRecurrence[] {
  const windowMs = policy.repairFilingWindowDays * 24 * 60 * 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  const windowStart = bucket * windowMs;
  const windowEnd = windowStart + windowMs;

  const bySurface = new Map<Disposition, Map<number, RepairFilingInstance>>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const surface = line.disposition as Disposition;
    if (!REPAIR_SURFACE_DISPOSITIONS.has(surface)) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs) || tsMs < windowStart || tsMs >= windowEnd) continue;
    const prNumber = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (prNumber === undefined) continue;
    const perPr = bySurface.get(surface) ?? new Map<number, RepairFilingInstance>();
    // Last-write-wins per PR (lines are read in ledger/append order) — a PR re-dispatched
    // several times this window is counted ONCE, carrying its MOST RECENT repair's evidence.
    perPr.set(prNumber, {
      prNumber,
      prUrl: typeof line.pr_url === "string" ? line.pr_url : "",
      reason: typeof line.reason === "string" ? line.reason : "(no reason captured)",
      headSha: typeof line.head_sha === "string" ? line.head_sha : "",
      ts,
    });
    bySurface.set(surface, perPr);
  }

  const due: RepairFilingRecurrence[] = [];
  for (const [surface, perPr] of bySurface) {
    const instances = [...perPr.values()].sort((a, b) => a.prNumber - b.prNumber);
    if (instances.length < policy.repairFilingThreshold) continue;
    due.push({
      surface,
      threshold: policy.repairFilingThreshold,
      windowDays: policy.repairFilingWindowDays,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      instances,
      id: `fb-repair-${surface}-${bucket}`,
    });
  }
  return due;
}

/** What {@link SweepDeps.captureRepairFeedback} is invoked with — the real wiring's exact
 *  `captureFeedback` arguments (id + origin + raw), decoupled from `src/lib/feedback.ts`'s own
 *  option shape so this module imports no effect from it (design ix). */
export interface RepairFilingCapture {
  id: string;
  /** `repair#<surface>` — built by `runSweep` from {@link RepairFilingRecurrence.surface}. */
  origin: string;
  raw: string;
}

/**
 * Render ONE due surface's evidence body (design v): the classified surface, the window/
 * threshold that triggered filing, and — per repaired PR — the PR number/url, head sha and the
 * disposition `reason` already ledgered for it (which, for a CI-failure surface, already names
 * the failing check(s) + sha(s) `describeCiFailures` captured). NEVER invents a cause: root
 * cause is explicitly stated as unobserved, since this fold only ever reports RECURRENCE.
 */
export function renderRepairFilingRaw(filing: RepairFilingRecurrence): string {
  const lines = filing.instances.map(
    (i) => `- PR #${i.prNumber} (${i.prUrl || "url not captured"}) at ${i.headSha ? i.headSha.slice(0, 7) : "sha not captured"}, ${i.ts}: ${i.reason}`,
  );
  return [
    `SWEEP REPAIR RECURRENCE: the "${filing.surface}" surface was repaired for ${filing.instances.length} distinct PRs ` +
      `between ${filing.windowStart} and ${filing.windowEnd} (threshold ${filing.threshold}, window ${filing.windowDays}d).`,
    "",
    "Root cause is UNOBSERVED — this is a recurrence report, not a diagnosis: the sweep classifies " +
      "and repairs the INSTANCE (each PR below), it does not investigate why the CLASS keeps recurring.",
    "",
    "EVIDENCE (read verbatim off each PR's own sweep.disposed ledger row, never invented):",
    ...lines,
  ].join("\n");
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
 * W1-T513 — THE CROSS-CALL REVIEW-KEY MUTEX. Before this task, `claimedReviewKeys` (below) was
 * declared FRESH INSIDE every `runSweep` call, so it only ever arbitrated between PRs handled by
 * that ONE call — real protection for `runSweepLightPass`'s own concurrent per-PR calls (W1-T473),
 * but no protection at all between two SEPARATE `runSweep` invocations running at the same time:
 * the daemon's full `deps.sweep()` walk racing a `sweepLight()` tick, or two overlapping light
 * passes fired from two different `startInFlightTicker` instances. `test/daemon.test.ts`'s own
 * "TODAY's post-review dedup is a ledger READ, not a mutex" fixture demonstrated the resulting
 * race directly: two concurrent `runSweep([pr], …)` calls over the identical PR both scheduled
 * `postReview` for it, because neither call's `Set` ever saw the other's claim.
 *
 * MODULE-SCOPED SO IT IS SHARED BY EVERY CALLER IN THE SAME PROCESS, WITHOUT NEW WIRING: `rmd
 * sweep`, the daemon's full-sweep hook, and its light-sweep hook (`buildSweepHook`/
 * `buildSweepLightHook`, `src/run-task.ts`) already build a FRESH `SweepDeps` object every call
 * but run in the SAME process — a module-level `Set` is therefore visible to all of them with no
 * change needed outside this file.
 *
 * NOT PROCESS-GLOBAL-FOREVER: a key is added the instant it is claimed (synchronously, no
 * `await` between the check and the add — unchanged from before this task) and REMOVED the
 * instant that claim's fate is decided, in `runSweep` below — either the scheduled `postReview`
 * call settles (success or failure) or the job stands down this pass (review budget exhausted).
 * A key never survives past the single in-flight attempt that claimed it, so a LEGITIMATE later
 * pass over the same still-unreviewed head is never permanently locked out — only a genuinely
 * CONCURRENT second claim for a key already in flight is refused.
 */
const inFlightReviewKeys = new Set<string>();

/**
 * THE SHARED ENTRY POINT (acceptance 4): BOTH `rmd sweep` and the daemon poll
 * loop call this ONE function. Re-derives every open PR's disposition fresh, takes
 * the ONE gated action per PR (deduped against prior actions for idempotence),
 * writes one `sweep.disposed` ledger line per PR, and returns a summary both
 * callers can log.
 *
 * W1-T473 — REVIEW CONCURRENCY: every disposition EXCEPT `post-review` still
 * runs exactly as before, one PR at a time, in `openPrs` order. `post-review`
 * PRs are instead collected and run in a SECOND, bounded-concurrency phase
 * after the walk — up to `Math.max(1, policy.reviewLanes)` `postReview`
 * calls in flight at once (the review lane's OWN budget as of W1-T1049 —
 * no longer `policy.dispatchLanes`), each against
 * a DISTINCT `${taskId}@${headSha}` key claimed synchronously during the walk
 * (real mutual exclusion the single-threaded walk used to supply for free —
 * see `PriorActions.postReviewed`'s doc). A review beyond budget stands down
 * this pass and is re-derived on the next one — a ceiling, never a target: a
 * pass with zero eligible reviews starts zero lanes. `summary.actions` still
 * comes back in `openPrs` order regardless of which phase finalized each PR.
 */
/**
 * W1-T1218 — THE REVIEW LANE'S ORDER, AS A PURE FUNCTION. Returns a NEW array ordered
 * OLDEST-FIRST, so `slice(0, reviewLanes)` hands the lanes to the entries that have waited
 * longest instead of to whichever ones the enumeration happened to list first.
 *
 * WHY THIS EXISTS. `runSweep` builds its pending set by `push` inside the per-PR walk, so
 * insertion order is enumeration order, and `openPrsRestArgs` asks for
 * `pulls?state=open&per_page=100` with no `sort` — GitHub answers `created:desc`. Cutting that by
 * position alone means the entries below the cut are the OLDEST ones, and "re-derived next pass"
 * re-derives the same set in the same order: while the queue is deeper than the budget, a PR
 * below the cut is deferred every pass, indefinitely. Sorting first makes that impossible by
 * construction — the oldest eligible review always takes a lane. The sibling enumeration in the
 * same module, `boardPrsRestArgs`, already states its order and calls it "LOAD-BEARING, not
 * cosmetic"; this was an omission on the other one, not a design.
 *
 * THE KEY IS `createdAt`, WITH `prNumber` AS BOTH TIEBREAK AND SUBSTITUTE. `createdAt` is already
 * carried on {@link OpenPrView} (W1-T1201) and needs no new read. It is OPTIONAL, and its own doc
 * forbids reading an absent value as "just created" — so an entry whose timestamp is missing or
 * unparseable orders by `prNumber`, which is always present and exactly monotone with creation.
 * That keeps the comparator TOTAL and the resulting order deterministic for every input.
 *
 * THE COST, NAMED RATHER THAN SOLD. Creation time is not the same as waiting time: a long-lived
 * PR whose head was pushed ninety seconds ago can take a lane ahead of a younger PR whose head
 * has waited hours, and both shapes exist on live data. Head PUSH time would be the better
 * waiting key and {@link OpenPrView} does not carry it — only `headSha` — so sorting on it needs
 * a new field and is a separate change. This is a fairness imperfection; it is not a starvation
 * one, because no entry can sit below the cut on every pass once the set is ordered.
 *
 * INERT WHEN THE QUEUE IS SHALLOW (W1-T476's stability argument, applied here): when every
 * pending entry gets a lane, ordering them changes no outcome at all.
 */
export function orderPendingReviews<T extends { pr: Pick<OpenPrView, "createdAt" | "prNumber"> }>(
  jobs: readonly T[],
): T[] {
  const createdMs = (job: T): number | undefined => {
    const raw = job.pr.createdAt;
    if (raw === undefined) return undefined;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  };
  return [...jobs].sort((a, b) => {
    const ta = createdMs(a);
    const tb = createdMs(b);
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    return a.pr.prNumber - b.pr.prNumber;
  });
}

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

  // ── W1-T931 COST-ANOMALY SENTINEL ───────────────────────────────────────────────────────────
  // Hung off THIS pass, not a new src/run-task.ts verdict call site (design note vi): `runSweep`
  // already read the whole ledger just above, and already runs on the daemon's cadence,
  // drainage included — exactly the "cost-governance path" `checkCostGovernor`/
  // `dailyCostCeilingUsd` already live on. Independent of `openPrs` (a zero-PR pass still checks
  // the ledger for a class median outlier), guarded by `!deps.dryRun` like every other ledger
  // write this module performs, and wrapped in the SAME per-pass throw containment the repair-
  // filing capture below uses — a detector failure must never fail the reconciliation pass it
  // shares a ledger read with. `recordCostAnomalies` itself is idempotent per run id (it reads
  // this SAME `ledgerLines` for already-ledgered `cost.anomaly` rows before writing any more) and
  // performs NO effect beyond that one ledger append — no dispatch, no merge, no worker control
  // (design note v).
  if (!deps.dryRun) {
    try {
      recordCostAnomalies(ledgerLines, deps.costAnomalyPolicy ?? loadDefaultCostAnomalyPolicy(), {
        ledgerPath: deps.ledgerPath,
        writeLedger: appendLine,
      });
    } catch (e) {
      log("sweep.cost_anomaly.error", { error: String((e as Error)?.message ?? e) });
    }
  }

  const byDisposition = ZERO_COUNTS();
  // Filled by INDEX, never pushed — post-review actions below are finalized
  // out of pass order (concurrently, in a second phase), so `actions[i]` is
  // the only way to keep the "in input order" invariant {@link
  // SweepSummary.actions}'s own doc promises while still letting reviews run
  // concurrently with each other.
  const actions: SweepAction[] = new Array(openPrs.length);
  // W1-T905: this pass's OWN newly-appended `sweep.disposed` rows, mirrored here as they are
  // written (never re-read from disk) so the repair-filing fold after the loop can see a
  // recurrence that crossed threshold WITHIN this very pass — `ledgerLines` above was read
  // before this pass's own writes and is never refreshed.
  const passDisposedRows: Array<Record<string, unknown>> = [];
  let actionsTaken = 0;
  // W1-T99: counted distinctly from actionsTaken/noneCount so a caller can tell
  // "nothing to do" from "something threw" at a glance — see renderSweepSummary.
  let actionsFailed = 0;
  let noneCount = 0;

  // ── W1-T473/W1-T513 — REVIEW CONCURRENCY BUDGET STATE ──────────────────────
  // `claimedReviewKeys` is the REAL mutual exclusion concurrency needs and
  // never had before W1-T473: `prior.postReviewed` (built once, above, from
  // the ledger) is a snapshot taken BEFORE this pass's own postReview calls
  // can write anything back — safe under a single-threaded walk (no second
  // reader exists between that read and a ledger write), unsafe the moment
  // two `post-review` PRs are handled at once. This set is consulted and
  // updated SYNCHRONOUSLY, in the loop below, before any `postReview` call is
  // even scheduled — no `await` ever separates a key's check from its claim,
  // so two PRs sharing a `${taskId}@${headSha}` key can never both schedule a
  // concurrent call for it.
  //
  // W1-T513: now the module-level {@link inFlightReviewKeys}, not a fresh
  // per-call `Set` — a fresh Set only ever arbitrated between PRs inside THIS
  // one call, never between two SEPARATE, genuinely concurrent `runSweep`
  // calls (the daemon's full sweep racing a light-pass tick, or two
  // overlapping light passes). Sharing the module-level Set closes that gap
  // with no change to this function's own claim/stand-down logic below —
  // only WHERE the Set lives moved, never HOW it is consulted.
  const claimedReviewKeys = inFlightReviewKeys;
  // Reviews eligible this pass, deferred out of the main walk so they can run
  // CONCURRENTLY with each other (bounded below), rather than one at a time
  // inside it — see `reviewLanes` after the loop.
  const pendingReviews: Array<{
    index: number;
    pr: OpenPrView;
    reason: string;
    question: ClarificationQuestion | undefined;
    // W1-T513: carried alongside the job so both release sites (deferred-to-next-pass,
    // below, and the runNow lane below that) can release the SAME key they claimed —
    // recomputing it from `pr` a second time would work too, but carrying it removes any
    // chance of the two computations drifting apart.
    reviewKey: string;
  }> = [];

  /**
   * The tail every disposition shares once its `acted`/`actionError`/
   * `standDownReason` are known — factored out so the main walk (synchronous
   * dispositions) and the concurrent review batch (below) ledger and log
   * IDENTICALLY. Unconditional counting (`actionsTaken`/`actionsFailed`)
   * matches the original inline placement exactly: a deduped/wait PR reaches
   * here with `acted:false` and no `actionError`, so neither counter moves.
   *
   * W1-T1061: `armOutcome` rides alongside `standDownReason` rather than only inside it —
   * `standDownReason` stays the human sentence (`"arm outcome: no-task-id"`), but a caller
   * counting outcomes from this lane no longer has to split that sentence on a colon to do
   * it; see `arm_outcome` on the ledgered `disposedLine` below.
   */
  function finalizeDisposition(
    index: number,
    pr: OpenPrView,
    disposition: Disposition,
    reason: string,
    question: ClarificationQuestion | undefined,
    acted: boolean,
    deduped: boolean,
    actionError: string | undefined,
    standDownReason: string | undefined,
    depReviewOutcome: string | undefined,
    armOutcome: ArmOutcomeName | undefined,
  ): void {
    if (standDownReason) {
      // The site the TASK names ("a sweep disposition"), naming the state —
      // never silent: a caller diffing the ledger sees exactly why a
      // blocked-fixable disposition spent nothing this pass.
      log("sweep.dispose.not_open", { pr_number: pr.prNumber, reason: standDownReason });
    }

    actions[index] = {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      taskId: pr.taskId,
      disposition,
      reason,
      acted,
      question,
      ...(actionError ? { actionError } : {}),
    };

    log("sweep.dispose", {
      pr_number: pr.prNumber,
      disposition,
      acted,
      reason,
      deduped,
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
      const disposedLine = {
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
        // W1-T1061: the FIELD sibling to `stand_down_reason`'s prose — present whenever
        // `deps.arm` returned a concrete outcome for THIS pr this pass (armed or not),
        // absent whenever no arm was even attempted (every other disposition, and a
        // mergeable PR that stood down before reaching `deps.arm` at all). This is the
        // same value `standDownReason`'s `arm outcome: ${armOutcome}` sentence names, so
        // the two can never drift apart — one write site, read twice.
        ...(armOutcome ? { arm_outcome: armOutcome } : {}),
        ...(question ? { question: question.question } : {}),
      };
      appendLine(deps.ledgerPath, disposedLine);
      // W1-T905: mirrored in-memory, with THIS PASS'S OWN `ts` (never re-read off disk — see
      // `passDisposedRows`'s own doc) — `appendLine`/`appendLedger` stamp their own write-time
      // `ts` on the real ledger line, which this never touches; the copy below exists solely so
      // `dueRepairFilings` can see a same-pass recurrence without a second ledger read.
      passDisposedRows.push({ ...disposedLine, ts: new Date(now).toISOString() });
    }

    if (acted) actionsTaken++;
    else if (actionError) actionsFailed++;
  }

  // ── PER-PASS HEARTBEAT, WRITTEN BEFORE THE LOOP ────────────────────────────────────────────
  // A BLIND SWEEP AND A QUIET FLEET ARE INDISTINGUISHABLE without this. `sweep.disposed` writes a
  // decision for every PR every tick, so its ABSENCE across a window is the only signal today —
  // and absence is exactly what a healthy quiet period looks like. Measured on 2026-08-05, a day
  // the daemon was continuously up: `sweep.disposed` had gaps of 66.3, 53.0 and 46.7 minutes that
  // were entirely healthy (nothing open to dispose), which is why no threshold over that step can
  // work.
  //
  // WHY `sweep.summary` IS NOT ALREADY THIS. It fires on an EMPTY pass (there is no early return
  // between here and it, and the ledger carries more summaries than disposeds), but it sits AFTER
  // the loop, so a pass that dies mid-way writes nothing at all. That is not hypothetical: the
  // 13:06:57 -> 13:30:28 window on 2026-08-05 is a 23.5-minute gap in `sweep.summary` that
  // CONTAINS four `sweep.disposed` rows — passes were starting and not finishing, and PR #1348
  // opened and closed entirely inside it. `deriveDisposition` runs at the top of each iteration,
  // OUTSIDE the per-action try/catch below, so a throw there escapes `runSweep` entirely.
  //
  // POSITION IS THE WHOLE POINT: written here, a pass that throws mid-loop still leaves this row,
  // so "started but never summarised" becomes a legible state instead of silence.
  //
  // `enumerated` is the count, not a bare pulse — a pass that enumerated 12 and summarised nothing
  // is a different failure from a pass that enumerated 0 and summarised cleanly, and only the count
  // separates them. It is deliberately the ONLY count here: how many were DISPOSITIONED cannot be
  // known before the loop runs, and `sweep.summary`'s own `total` already carries it for any pass
  // that completes. The pair — this row present, a summary absent — is the mid-pass-death signal.
  //
  // NOT REGISTERED in DECISION_RELEVANT_LEDGER_STEPS or RENDER_RELEVANT_LEDGER_STEPS, deliberately:
  // nothing reads it yet (the consumer is out of scope here, one concern), and the decision set is
  // the NEVER-ROTATED core, so registering an unread step there would keep it forever for no
  // reader. It rotates like any other diagnostic row until a consumer exists; the change that
  // builds that consumer registers it then, in the same PR, which is the discipline
  // `test/ledger-rotation.test.ts` enforces.

  log("sweep.pass", { enumerated: openPrs.length, dry_run: deps.dryRun === true });

  for (let prIndex = 0; prIndex < openPrs.length; prIndex++) {
    const pr = openPrs[prIndex];
    const { disposition, reason } = deriveDisposition(pr, policy, now);
    byDisposition[disposition]++;

    // W1-T196: a blocked-ambiguous PR that never resolved a task id is a
    // KNOWN, non-emergency state ONLY when it is POSITIVELY a plan-filing PR
    // (`isPlanFiling` — see its own doc comment) — a filing PR carries no
    // trailer BY DESIGN, so there is no task to ask about and no
    // operator-decidable question (the #440 fixture: "[BLOCKED] UNKNOWN: PR
    // #439 needs a clarification" — there is no clarification to give). An
    // unattributed PR that is NOT flagged plan-filing still escalates below,
    // unchanged: that is a genuine attribution defect (a missing/malformed
    // trailer on an IMPLEMENTING PR), not a designed gap, and stays surfaced.
    const unattributableFiling = disposition === "blocked-ambiguous" && !pr.taskId && pr.isPlanFiling === true;

    // W1-T78: render the clarification question up front for blocked-ambiguous
    // PRs — it is ledgered EVERY sweep (so an unanswered question stays
    // visible), even on a deduped sweep where `escalate` itself does not fire.
    // Skipped for an unattributable filing PR (above): there is no task-bound
    // question to render, only a stand-down.
    const question =
      disposition === "blocked-ambiguous" && !unattributableFiling
        ? renderClarificationQuestion(pr, reason, pr.strikeHistory ?? [])
        : undefined;

    // Is this action already true (deduped)? Keyed per disposition.
    let alreadyDone: boolean;
    // W1-T1000002: set ONLY by the "mergeable" case below, ONLY when an operator hold stands
    // over a PR GitHub ALREADY reports armed — the converging withdrawal fires unconditionally
    // (never gated on `acted`, which a held PR always has false) so a standing arm this lane did
    // not place is withdrawn on the very pass that observes it, not merely refused going forward.
    let holdToWithdraw: AutomergeHold | undefined;
    // W1-T1110: set ONLY by the "blocked-fixable"/"conflicted" case below, when a PRIOR
    // dispatch against this exact head is still deduping (`prior.fixed.has(...)` true AND its
    // rung has not stalled out — see `fixRungStalledWithoutNewHead`'s own doc). Named here, not
    // just silently stood down (rationale (5)): the light-pass arm one branch below already sets
    // `standDownReason` for its own stand-down, and this arm previously did not, which is the
    // defect two readers independently misread as an unwired action path.
    let dedupStandDownReason: string | undefined;
    switch (disposition) {
      case "mergeable": {
        // PREFER OBSERVED STATE: GitHub's own `autoMergeArmed` is the authority for
        // "already armed". The sweep's own memory is only a fallback, and now sha-keyed so a
        // new head re-earns the attempt rather than being deduped on a stale success.
        //
        // W1-T970: a head the risk judge escalated is refused HERE, in `alreadyDone`, NOT in
        // this rule's own `when` predicate and NOT in the merge path — see PriorActions.riskRefused's
        // doc. Marking it `alreadyDone` (rather than a distinct branch) gives it the SAME
        // non-action shape every other dedup in this switch already has: `acted:false`, no
        // escalation, no strike, re-derived whole next pass. It clears on a NEW head sha (the
        // key itself, checked first so a fresh head never pays for a stale override lookup) OR
        // an explicit operator override — reusing `cappedOverrideFromLedger` VERBATIM (the SAME
        // verb, the SAME head-bound read-back the CAPPED-verdict override already uses; design
        // (v) is explicit that this is not a second override vocabulary).
        const riskRefusedKey = `${pr.prNumber}@${pr.headSha}`;
        const refused =
          prior.riskRefused.has(riskRefusedKey) &&
          !(pr.taskId !== undefined && cappedOverrideFromLedger(ledgerLines, pr.taskId, pr.headSha) !== undefined);
        // W1-T1000002: A HOLD IS A LEDGERED REFUSAL, NOT A BARE DISARM — see review.ts's
        // `automergeHoldFromLedger` doc. Deliberately NEVER sha-keyed (unlike `refused` above):
        // a hold binds the PR, not any one head, so a push while held changes nothing here.
        // `acted:false` follows from `alreadyDone:true` exactly like `refused` — no dedup key is
        // seeded, so the pass re-derives whole the moment an operator releases it (design (iii)/
        // (vii): no separate resume path, the SAME property `refused`'s W1-T970 precedent gives).
        const hold = automergeHoldFromLedger(ledgerLines, pr.prNumber);
        if (hold && pr.autoMergeArmed === true) holdToWithdraw = hold;
        const armedByGitHub = pr.autoMergeArmed === true;
        const armedByPriorPass = !armedByGitHub && prior.armed.has(`${pr.prNumber}@${pr.headSha}`);
        alreadyDone = armedByGitHub || armedByPriorPass || refused || hold !== undefined;
        // W1-T1116: NAME WHICH DISJUNCT FIRED — this switch previously left every one of these
        // three silent (rationale (3)/(4)), the exact gap the "blocked-fixable"/"conflicted" arm
        // above (W1-T1110) already closed for its own dedup, and the ONLY reason two readers
        // misdiagnosed a correctly-held #2432 as a never-clearing dedup in one night (rationale
        // (5)). Order matches the `||` above: an operator reading the row learns the FIRST true
        // disjunct, exactly the one that actually short-circuited `alreadyDone`. W1-T1000002 adds
        // the hold as a fourth disjunct and a fourth reason, in the same order as the `||`.
        if (armedByGitHub) {
          dedupStandDownReason = "auto-merge already armed (observed on GitHub) — nothing to re-arm";
        } else if (armedByPriorPass) {
          dedupStandDownReason = `auto-merge already armed by a prior sweep pass at this head (${pr.headSha.slice(0, 7)})`;
        } else if (refused) {
          // Design (i): carry the SAME `issue_url` the sibling `risk_judge.escalated` row
          // already holds (rationale (2)/(7)) — the pointer exists one row away; this only
          // moves it to the row a reader reaches first. Never widens the override: naming the
          // escape is not taking it (design (v)).
          const issueUrl = prior.riskRefused.get(riskRefusedKey);
          dedupStandDownReason = issueUrl
            ? `risk judge escalated this head, no operator override recorded — see ${issueUrl}`
            : "risk judge escalated this head, no operator override recorded";
        } else if (hold !== undefined) {
          dedupStandDownReason = "an operator merge hold stands over this PR — refusing to arm until it is released";
        }
        break;
      }
      case "blocked-fixable":
      case "conflicted": {
        // W1-T106: same dedup set as blocked-fixable — see priorActionsFromLedger.
        const dispatchedThisHead = prior.fixed.has(`${pr.prNumber}@${pr.headSha}`);
        // W1-T1110 — RE-ARM A STALLED DISPATCH: `dispatchedThisHead` records only that a fix was
        // DISPATCHED against this head, never that it succeeded (rationale (3)). If the ledger
        // shows that dispatch's own rung already ENDED without landing a new head (a real review
        // still failing, or CI never green — `fixRungStalledWithoutNewHead`), treating it as
        // still "already done" would dedup this PR against a head nothing will ever move again
        // (rationale (4)) — so it does NOT suppress this pass; the strike cap (unchanged, design
        // (iv)) still bounds however many more attempts follow. A dispatch that instead resolved
        // (landed a working push) is never read as stalled, so it keeps suppressing a second
        // attempt on this same, now-stale head (acceptance 3).
        alreadyDone = dispatchedThisHead && !fixRungStalledWithoutNewHead(ledgerLines, pr.taskId);
        if (alreadyDone) {
          dedupStandDownReason =
            `fix already dispatched for this head (${pr.headSha.slice(0, 7)}) — awaiting its outcome ` +
            `before spending another strike`;
        }
        break;
      }
      case "stale":
        alreadyDone = prior.closed.has(pr.prNumber);
        break;
      case "blocked-ambiguous":
        // W1-T514: sha-keyed, exactly like every sibling arm above — a new
        // head re-earns its own escalation rather than being deduped by a
        // stale head's `acted:true` line forever.
        alreadyDone = prior.escalated.has(`${pr.prNumber}@${pr.headSha}`);
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
        // W1-T1116 (design iv) — the fourth silent guard: forcing `alreadyDone` true
        // unconditionally is BY DESIGN here (unlike the other three disjuncts, there is no
        // "refusal" to distinguish from), but the row still read `acted:false` with nothing
        // saying why. `reason` (destructured above from `deriveDisposition`) already narrates
        // exactly what is being waited on — reused verbatim rather than inventing a second
        // sentence that could drift from it.
        dedupStandDownReason = reason;
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
    // `acted` is false without conflating the three. W1-T1110: seeded from
    // `dedupStandDownReason` (set above, in the "blocked-fixable"/"conflicted" arm of the
    // `alreadyDone` switch) so a still-deduped fix dispatch NAMES ITSELF on this same field —
    // the light-pass arm's exact shape, one branch away — rather than standing down silently.
    let standDownReason: string | undefined = dedupStandDownReason;
    // W1-T1061: the FIELD twin of `standDownReason`'s prose, set ONLY when the "mergeable"
    // case below actually calls `deps.arm(pr)` and gets a concrete (non-void) outcome back —
    // every other disposition, and a mergeable PR that stands down in `decideSweepArm` before
    // ever reaching `deps.arm`, leaves this `undefined` so `finalizeDisposition` writes no
    // `arm_outcome` field at all (acceptance: "a disposal with no arm attempt carries no
    // outcome field").
    let armOutcome: ArmOutcomeName | undefined;
    // W1-T254 — PER-PR THROW CONTAINMENT: a thrown action used to propagate
    // straight out of `runSweep` as one un-attributed `sweep.error`, aborting
    // the WHOLE pass (every later PR in `openPrs` went unreconciled this
    // poll). Named here and ledgered on THIS PR's own `sweep.disposed` line
    // below instead — the loop always reaches the next PR.
    let actionError: string | undefined;
    // W1-T473: set true ONLY by the "post-review" case below when a real
    // `postReview` dep is wired and eligible to run — this PR's finalize call
    // is deferred to the bounded concurrent batch after the loop, never run
    // inline here.
    let deferredReview = false;

    if (acted) {
      // W1-T254 — LIGHT-SWEEP RESTRICTION: `actionable` defaults to
      // "everything" (SweepDeps.actionable is optional), so `rmd sweep` and
      // the daemon's per-iteration full sweep are unchanged. The daemon's
      // restricted light-sweep ticker (running CONCURRENTLY with an
      // in-flight `runOne`) passes `d => d === "post-review"` so only that
      // deterministic, sha-pinned re-post ever runs alongside a task —
      // every other lane stands down here, re-derived and re-attempted
      // (never dropped) on the very next full sweep. See `SweepDeps.actionable`'s
      // own doc for why "mutex-serialized" no longer describes this ONE lane
      // as of W1-T473.
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
              // READ THE OUTCOME. `armAutoMerge` does not throw — it RETURNS which of its
              // seven branches it took, and five of them armed nothing. Discarding it is what
              // let `acted:true` be recorded for a PR that was never armed.
              const armResult = await deps.arm(pr);
              // W1-T1117: `deps.arm` may return the bare `ArmOutcomeName` it always could, or the
              // richer `ArmAttemptOutcome` (outcome + failureClass) — unwrap to the outcome name
              // once, here, so every read below (including `armOutcome`/`armOutcomeArmed`, both
              // unchanged) stays on the plain string it already expected.
              const armOutcomeName = typeof armResult === "object" && armResult !== null ? armResult.outcome : armResult;
              // W1-T1061: capture the concrete outcome onto the OUTER `armOutcome` (read by
              // `finalizeDisposition` below) whenever one came back — a `void` return is the
              // legacy "treat as armed" shape `armOutcomeArmed` already special-cases, and it
              // names no real branch, so no field is written for it either.
              if (armOutcomeName !== undefined) armOutcome = armOutcomeName;
              if (!armOutcomeArmed(armOutcomeName)) {
                acted = false;
                // The refusal used to go only to `say` -> stdout -> daemon.out.log, leaving no
                // trace in the ledger where anyone looks. Name it on the disposed line.
                standDownReason = `arm outcome: ${String(armOutcomeName)}`;
                // W1-T1117 (design ii/iv): an `arm-error-ignored` outcome classified `"unknown"`
                // is the ONE non-armed outcome that must NOT retry — the classifier could not
                // decode the failure at all, so nothing says the SAME attempt will ever succeed
                // (unlike `"transient"`/`"retryable"`, which stay on the `acted:false` line just
                // set above, exactly as every arm-error-ignored outcome already behaved). This
                // reinstates the terminal (dedup-seeding) shape the plan record's rationale (1)
                // always intended for a genuinely non-retryable refusal — see this arm's own
                // `deps.arm` production wiring (run-task.ts's `buildSweepEffects`) for where
                // `failureClass` is actually populated.
                const failureClass = typeof armResult === "object" && armResult !== null ? armResult.failureClass : undefined;
                if (armOutcomeName === "arm-error-ignored" && failureClass === "unknown") {
                  acted = true;
                  standDownReason = undefined;
                }
              }
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
              // W1-T527 — CLASSIFY BEFORE SELECTING, because the strike is spent at
              // dispatch and cannot be refunded afterwards. `classifyRedCause` is a pure
              // fold over evidence already in hand (this PR's `ciFailures` plus the WHOLE
              // `openPrs` array this pass was handed), so it costs no GitHub call. Only
              // base-caused and environment stand down; `in-diff` and `gate-conflict` fall
              // through to the dispatch below exactly as they did before this existed.
              const redCause = classifyRedCause(pr, openPrs);
              if (redCauseStandsDown(redCause)) {
                acted = false;
                standDownReason = describeRedCause(redCause, pr, openPrs);
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
              // W1-T196: stand down instead of escalating `task: UNKNOWN` — see
              // `unattributableFiling`'s doc comment above. No `deps.escalate`
              // call, no issue, but NEVER silent: the stand-down reason names
              // both the PR and the unresolved attribution on this pass's
              // `sweep.disposed` ledger line below (the SAME trace discipline
              // `standDownReason` gives every other non-actionable disposition).
              const absentDecision = absentChecksRepushDecision(
                pr,
                policy,
                now,
                prior.absentRepushes.get(pr.prNumber) ?? { count: 0, shas: new Set<string>() },
              );
              if (!unattributableFiling && absentDecision.repush && deps.repushAbsent) {
                // THE REMEDY. Fires INSTEAD OF this pass's escalation — the escalation path
                // itself is unchanged, and the next pass re-derives from the new head: if the
                // fresh sha gets its suites the PR simply proceeds, and if it does not, the cap
                // in `absentChecksRepushDecision` routes it to the ordinary escalate below.
                const oldHead = pr.headSha;
                const newHead = await deps.repushAbsent(pr);
                // LEDGERED, because #968's lesson was that a fire-and-forget action nobody
                // records becomes invisible state: the PR, both shas, and the reason.
                // appendLine, NOT log(): `log` is an optional narration sink (a no-op when
                // unwired), but `priorActionsFromLedger` READS this step back to enforce the
                // bound — so it has to land in deps.ledgerPath, the same file and the same
                // mechanism `sweep.disposed` uses. Skipped under --dry-run for the same reason
                // that line is: a preview must leave no trace that changes a later real pass.
                if (!deps.dryRun) {
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: "sweep.absent_repush",
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    old_head: oldHead,
                    new_head: newHead ?? null,
                    reason: absentDecision.reason,
                  });
                }
                log("sweep.absent_repush", {
                  pr_number: pr.prNumber,
                  old_head: oldHead,
                  new_head: newHead ?? null,
                });
                // `acted` stays FALSE, and this is load-bearing rather than cosmetic. `acted:true`
                // on a blocked-ambiguous line is what feeds `prior.escalated`, so claiming it here
                // would tell every later pass "this PR was already escalated" — and the PR would
                // then never escalate at all, which is the very silent-forever failure this remedy
                // exists to end. The re-push is a DIFFERENT action with its own ledger line (the
                // one the bound reads); the disposition's own action did not fire, so it says so.
                acted = false;
                standDownReason = `ABSENT re-push fired instead of escalating this pass — ${absentDecision.reason}`;
              } else if (unattributableFiling) {
                acted = false;
                standDownReason =
                  `task id unresolved for PR #${pr.prNumber} (${pr.prUrl}) — a plan-filing PR carries no ` +
                  `Remudero-Task trailer by design (W1-T136 criterion 5); attribution failure on this class ` +
                  `is a known state, not an escalation`;
              } else {
                if (absentDecision.repush && !deps.repushAbsent) {
                  // The remedy WOULD have fired but no dep is wired — say so on the ledger line
                  // rather than escalating as if the ABSENT state were unrecognised.
                  standDownReason = `ABSENT re-push not wired — ${absentDecision.reason}`;
                }
                await deps.escalate(pr, reason, question!);
              }
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
                // W1-T473: NEVER await inline — that is exactly the "reviews
                // run one at a time" shape this task removes. This PR's own
                // key is claimed and it is queued into `pendingReviews`
                // immediately below (still inside this same synchronous
                // switch/try, before any `await` in this iteration), and the
                // actual call + finalize happen in the bounded concurrent
                // batch after the loop.
                deferredReview = true;
              } else {
                acted = false;
                standDownReason = "no postReview dep wired — ungated PR left for the operator lane";
              }
              break;
          }
        } catch (e) {
          acted = false;
          // W1-T529 (iv) — DEGRADE, DO NOT RETRY, AND DO NOT CALL IT A FAILURE. A budget floor
          // stand-down means the guarded call was refused BEFORE it ran, so this lane did not
          // fail — it declined. Recorded as a stand-down (this PR's own `sweep.disposed` line
          // carries `stand_down_reason`, the field every other non-actionable disposition
          // already uses) rather than as an `actionError`, so it neither counts in
          // `actionsFailed` nor writes the `sweep.action_failed` row below. `acted` is false
          // either way, which is the whole no-strike guarantee — see `budgetFloorStandDown`.
          const floorStandDown = budgetFloorStandDown(e, disposition);
          if (floorStandDown !== undefined) {
            standDownReason = floorStandDown;
          } else {
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
      }
    }

    // W1-T1000002 — CONVERGE: WITHDRAW WHAT THIS LANE DID NOT ARM. Runs regardless of `acted`
    // (a held PR always has `acted:false` from the dedup above, so the ordinary action switch
    // never reaches `deps.arm`) — a disarm alone is undone by the very next pass (the arming
    // dedup reads GitHub's OWN live armed bit), so the withdrawal must be issued on every pass
    // that still observes hold-stands-and-armed, not merely once. Safe when not armed and never
    // throws (see `SweepDeps.disarmAutoMerge`'s own doc), so this costs nothing on the common
    // quiet pass — `holdToWithdraw` is `undefined` for every disposition but a held, armed
    // "mergeable" one.
    if (holdToWithdraw && deps.disarmAutoMerge) {
      try {
        await deps.disarmAutoMerge(pr, holdToWithdraw);
        const withdrawalLine = {
          run_id: deps.runId,
          task_id: pr.taskId ?? "SWEEP",
          step: "automerge.hold_withdrawal",
          pr_number: pr.prNumber,
          pr_url: pr.prUrl,
          head_sha: pr.headSha,
          hold_by: holdToWithdraw.by,
          hold_reason: holdToWithdraw.reason,
        };
        log("automerge.hold_withdrawal", withdrawalLine);
        // Skipped under --dry-run, exactly like `finalizeDisposition`'s own `sweep.disposed`
        // row below — a preview must leave no trace.
        if (!deps.dryRun) appendLine(deps.ledgerPath, withdrawalLine);
      } catch (e) {
        log("sweep.hold_withdrawal_failed", {
          pr_number: pr.prNumber,
          error: String((e as Error)?.message ?? e),
        });
      }
    }

    if (deferredReview) {
      // W1-T473/W1-T513 — THE MUTEX: claim (or refuse) this PR's review key
      // SYNCHRONOUSLY, right here, with no `await` between the `has` check
      // and the `add` — that is the entire guarantee two PRs (or, since
      // W1-T513, two genuinely CONCURRENT `runSweep` calls anywhere in this
      // process) sharing a `${taskId}@${headSha}` key can never both queue a
      // concurrent `postReview` call for it. A duplicate stands down exactly
      // like any other dedup, never a crash or a silent drop. Released in
      // EXACTLY one of two places once this claim's fate is decided: the
      // `deferredToNextPass` loop below (budget exhausted, never scheduled)
      // or the `runNow` lane's own `finally` further down (scheduled and
      // settled) — never both, and never neither.
      const reviewKey = `${pr.taskId ?? ""}@${pr.headSha}`;
      if (claimedReviewKeys.has(reviewKey)) {
        finalizeDisposition(
          prIndex,
          pr,
          disposition,
          reason,
          question,
          false,
          true,
          undefined,
          `duplicate review key (${reviewKey}) already claimed this pass — see PriorActions.postReviewed's doc`,
          undefined,
          undefined,
        );
      } else {
        claimedReviewKeys.add(reviewKey);
        pendingReviews.push({ index: prIndex, pr, reason, question, reviewKey });
      }
      continue;
    }

    finalizeDisposition(
      prIndex,
      pr,
      disposition,
      reason,
      question,
      acted,
      alreadyDone,
      actionError,
      standDownReason,
      depReviewOutcome,
      armOutcome,
    );
  }

  // ── W1-T1049 — REVIEW CONCURRENCY BUDGET, NOW ITS OWN ───────────────────────
  // Reviews get their OWN lane ceiling (`policy.reviewLanes`) — no longer a
  // SECOND consultation of `policy.dispatchLanes` (W1-T473's original wiring).
  // That coupling silently pinned drainage's own concurrency budget to a
  // dispatch-only ruling and let the two ceilings ADD on the host with
  // nothing naming their sum (rationale (3)/(4)): `dispatchLanes` above keeps
  // its EXACT present meaning — still the field `daemon.ts`'s `laneCount` and
  // `test/policy-consumers.test.ts` read — this is a SIBLING row, never a
  // retune of it. Floored at 1 exactly like `daemon.ts`'s `laneCount` floors
  // `dispatchLanes` — a misconfigured `reviewLanes: 0` must never silently
  // mean "review nothing".
  //
  // A CEILING, NOT A TARGET: `reviewLanes` only ever bounds `pendingReviews`
  // — the reviews THIS PASS already found eligible, above. It never goes
  // looking for work: a pass with zero eligible reviews runs `Promise.all([])`
  // and starts zero lanes (acceptance 3).
  const reviewLanes = Math.max(1, policy.reviewLanes);
  // W1-T1218: ORDER BEFORE THE CUT. `pendingReviews` is built by `push` inside the per-PR walk
  // above, so its order IS the enumeration order, and `openPrsRestArgs` requests
  // `pulls?state=open&per_page=100` with no `sort` — GitHub answers newest-first. Slicing that by
  // position gave the lanes to the NEWEST entries and deferred the same oldest tail every pass,
  // for as long as the queue stayed deeper than the budget. {@link orderPendingReviews} is the
  // whole fix; nothing else in this lane changes.
  const orderedReviews = orderPendingReviews(pendingReviews);
  const runNow = orderedReviews.slice(0, reviewLanes);
  const deferredToNextPass = orderedReviews.slice(reviewLanes);

  // SKIP, NOT QUEUE OR BLOCK (design (iii)): a review beyond budget stands
  // down THIS pass, `acted:false`, with no new persisted state — its ledger
  // dedup key is untouched, so `deriveDisposition` reclassifies it
  // "post-review" again next pass, typically within one poll interval
  // (measured ~60s median). Queueing would survive past the pass that built
  // it; blocking would risk this tick outrunning its own interval.
  //
  // W1-T513: also RELEASES this job's `reviewKey` from the module-level
  // {@link inFlightReviewKeys} mutex — it was claimed above to keep two
  // callers from BOTH queueing it this pass, but it is never actually run
  // this pass, so holding the claim any longer would wrongly block a
  // legitimately concurrent NEXT pass (or a concurrent full sweep) from
  // picking it up.
  for (const job of deferredToNextPass) {
    claimedReviewKeys.delete(job.reviewKey);
    finalizeDisposition(
      job.index,
      job.pr,
      "post-review",
      job.reason,
      job.question,
      false,
      false,
      undefined,
      `review budget exhausted this pass (${reviewLanes} lane(s) in use) — re-derived next pass`,
      undefined,
      undefined,
    );
  }

  // BOUNDED CONCURRENCY: at most `reviewLanes` calls in flight, each against a
  // DISTINCT `taskId@headSha` key (mutual exclusion already enforced above,
  // synchronously, before any of these were queued) — so running them
  // together is safe, never a double-post race. `Promise.all`, not
  // `allSettled`: each job's own try/catch below already turns a throw into
  // `acted:false` + its own `sweep.action_failed` line, the SAME per-PR throw
  // containment (W1-T254) every other disposition gets — nothing here can
  // reject the outer promise.
  const postReview = deps.postReview;
  await Promise.all(
    runNow.map(async (job) => {
      let acted = true;
      let actionError: string | undefined;
      // W1-T529 (iv): set INSTEAD of `actionError` when the throw is a budget floor stand-down —
      // carried onto this PR's own `sweep.disposed` line as `stand_down_reason`, the same field
      // every other declined disposition already uses.
      let standDownReason: string | undefined;
      try {
        if (postReview) {
          try {
            await postReview(job.pr);
          } catch (e) {
            acted = false;
            // W1-T529 (iv) — THE ONE THROW THAT MUST NOT LEAVE A DEDUP KEY. Design (v) (the
            // `review.post_refused` arm below) is right about every ORDINARY throw: without a key
            // the attempt repeats every pass, unbounded. It is exactly wrong about this one.
            //
            // A floor stand-down says nothing about this PR — the guarded call never ran — while
            // `review.post_refused` is read by `reviewPostRefusedFor` (run-task.ts) as a VERDICT
            // that ESCALATES this head rather than retrying it, keyed `taskId@headSha` so only a
            // NEW PUSH ever clears it. Writing it here converts "unaffordable for one tick" into
            // "permanently refused, then escalated as blocked-ambiguous" — for a PR nothing ever
            // looked at. Design (iv) names the correct cost instead: "a green PR is left unmerged,
            // visible, recoverable next pass", and RECOVERABLE is only true if no key is written.
            // The precedent is already here: `review.post_failed` (a transient `gh` error)
            // deliberately does not set `reviewPostRefused` either — "never escalate on a mere
            // network hiccup" (OpenPrView.reviewPostRefused's own doc).
            //
            // AND THE REPEAT IS STILL BOUNDED, just not by a key. The pacer CONSUMES its trip on
            // the one call it refuses (`standDown` is cleared inside `wait()` before it throws,
            // lib/open-prs-rest.ts), so the very next guarded call is let through to re-derive
            // against a live reading and the floor cannot re-fire without a fresh sub-floor one.
            // What design (v) bounds is a throw that RECURS ON ITS OWN; this one cannot.
            const floorStandDown = budgetFloorStandDown(e, "post-review");
            if (floorStandDown !== undefined) {
              standDownReason = floorStandDown;
            } else {
              actionError = String((e as Error)?.message ?? e);
              appendLine(deps.ledgerPath, {
                run_id: deps.runId,
                task_id: job.pr.taskId ?? "SWEEP",
                step: "sweep.action_failed",
                pr_number: job.pr.prNumber,
                pr_url: job.pr.prUrl,
                disposition: "post-review",
                error: actionError,
              });
              // W1-T529 design (v) — THE MISSING DEDUP KEY. `sweep.action_failed` alone leaves
              // NO key `PriorActions.postReviewed` can see: that set is built ONLY from
              // `review.posted`/`review.post_refused` lines (see its own doc above), never from
              // `sweep.disposed`/`sweep.action_failed`. Without this, a thrown attempt —
              // including a guarded call standing down at the floor once one is wired ahead of
              // this call (lib/open-prs-rest.ts's `GhCallPacer`) — re-attempts THIS EXACT HEAD
              // every following pass, without bound: a floor bounds the RATE of calls but, on
              // its own, not the REPEAT of the attempt, and each retry against an exhausted
              // budget only deepens it. This records the SAME outcome shape
              // `postReviewStatusGuarded` (lib/review.ts) already writes for a graceful
              // refusal — recording the throw as an OUTCOME the existing dedup already reads,
              // never a second mechanism (design v's own "the honest shape"). `acted` stays
              // `false` above regardless, so this never touches the fix-strike lane's own
              // `acted:true`-gated dedup (design iv) — a different lane, a different set.
              appendLine(deps.ledgerPath, {
                run_id: deps.runId,
                // W1-T529 (v) — THE EMPTY STRING, NEVER THE "SWEEP" PLACEHOLDER, AND THE DIFFERENCE
                // IS THE WHOLE DEDUP. The consult site reads
                // `prior.postReviewed.has(`${pr.taskId ?? ""}@${pr.headSha}`)`, so a task-id-less PR
                // looks up `@<sha>`. Writing "SWEEP" here produced `SWEEP@<sha>`: a row that reads
                // correctly in the ledger, matches nothing, and left the attempt repeating every
                // pass — MEASURED against this file before the fix, 3 attempts across 3 passes for a
                // PR carrying no task id. The `sweep.action_failed` line above is diagnostic and may
                // keep its placeholder; this one is a KEY and must match its lookup exactly.
                task_id: job.pr.taskId ?? "",
                step: "review.post_refused",
                head_sha: job.pr.headSha,
                reason: `post-review attempt threw — standing down rather than retrying this head unbounded: ${actionError}`,
              });
            }
          }
        }
      } finally {
        // W1-T513: release `job.reviewKey` from the module-level {@link
        // inFlightReviewKeys} mutex the instant this attempt SETTLES —
        // success or failure alike, and BEFORE `finalizeDisposition`, which
        // only ledgers/logs and never gates a future pass. On success
        // `postReview` has already durably written the "reviewed" state a
        // later pass's own fresh ledger read will see (so it never even
        // reaches this claim again); on failure (W1-T529) the `review.post_refused`
        // line just above plays the same role — either way this pr@head will not
        // re-claim the SAME key next pass, so releasing it here costs nothing and
        // holding it any longer than the attempt itself would only block work,
        // never protect any.
        claimedReviewKeys.delete(job.reviewKey);
      }
      finalizeDisposition(
        job.index,
        job.pr,
        "post-review",
        job.reason,
        job.question,
        acted,
        false,
        actionError,
        standDownReason,
        undefined,
        undefined,
      );
    }),
  );

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
  // W1-T520 — the stall report. One line PER STALLED PR naming both facts, and NOTHING when the
  // set is empty, which is the common case: a quiet pass writes no row at all rather than a
  // `stalled: 0` heartbeat nobody reads. Emitted through `appendLine` (the same durable sink
  // `sweep.disposed` uses) rather than `log`, because `log` is an optional narration hook a caller
  // may leave unwired — see `deps.log`'s own contract. This still REPORTS the WHOLE set; W1-T528
  // (right below) is what ACTS, and only on one of them.
  for (const stalled of armedButStalled(openPrs)) {
    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: stalled.taskId ?? "SWEEP",
      step: "sweep.armed_stalled",
      pr_number: stalled.prNumber,
      pr_url: stalled.prUrl,
      head_sha: stalled.headSha,
      auto_merge_armed: true,
      merge_state: "behind",
    });
  }
  // W1-T528 — PRESS THE BUTTON. {@link selectUpdateBranchTarget} picks AT MOST ONE PR from the
  // set just reported — oldest head first, draft/in-flight excluded (see that function's own
  // doc) — and, when `deps.updateBranch` is wired, requests GitHub update it. Never a loop: one
  // call, whatever the outcome — a conflict is REPORTED and skipped, never retried by this same
  // pass (design v). `dryRun` leaves no trace, mirroring every other action in this module.
  if (!deps.dryRun && deps.updateBranch) {
    const target = selectUpdateBranchTarget(
      openPrs,
      now,
      deps.inFlightTaskIds ?? new Set(),
      deps.staleGateWorkflowsByPr ?? new Map(),
      deps.updatedForWorkflow ?? new Set(),
    );
    if (target) {
      // W1-T1212: a `StaleGatePr` (never `armedButStalled`'s own shape) carries the ONE extra
      // fact `deps.updatedForWorkflow`'s next read needs to remember this exact pair.
      const staleWorkflow = "staleWorkflow" in target ? (target as StaleGatePr).staleWorkflow : undefined;
      const staleWorkflowFields = staleWorkflow === undefined ? {} : { stale_workflow: staleWorkflow };
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: target.taskId ?? "SWEEP",
        step: "sweep.update_branch.attempted",
        pr_number: target.prNumber,
        pr_url: target.prUrl,
        head_sha: target.headSha,
        ...staleWorkflowFields,
      });
      try {
        const outcome = await deps.updateBranch(target);
        appendLine(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: target.taskId ?? "SWEEP",
          step: `sweep.update_branch.${outcome}`,
          pr_number: target.prNumber,
          pr_url: target.prUrl,
          head_sha: target.headSha,
          ...staleWorkflowFields,
        });
      } catch (e) {
        appendLine(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: target.taskId ?? "SWEEP",
          step: "sweep.update_branch.error",
          pr_number: target.prNumber,
          pr_url: target.prUrl,
          head_sha: target.headSha,
          error: String((e as Error)?.message ?? e),
          ...staleWorkflowFields,
        });
      }
    }
  }
  // W1-T905 — "repair the instance, FILE THE CLASS". A PURE fold ({@link dueRepairFilings}) over
  // this pass's own view of `sweep.disposed` (the ledger's prior rows PLUS this pass's own,
  // mirrored above) followed by AT MOST ONE best-effort capture per due surface. `dryRun` and an
  // unwired `captureRepairFeedback` both leave no trace, matching every other action in this
  // module. Wrapped in the SAME per-PR throw containment the action switch already has (W1-T254,
  // design viii): a capture/landing failure here must never fail the pass that produced the
  // repairs it reports on, and never touches any OTHER PR's disposition this pass or any later
  // one — the fold recomputes fresh from ledger state every call, with no memory of its own.
  if (!deps.dryRun && deps.captureRepairFeedback) {
    const due = dueRepairFilings([...ledgerLines, ...passDisposedRows], now, policy);
    for (const filing of due) {
      try {
        await deps.captureRepairFeedback({
          id: filing.id,
          origin: `repair#${filing.surface}`,
          raw: renderRepairFilingRaw(filing),
        });
      } catch (e) {
        log("sweep.repair_filing.error", { surface: filing.surface, id: filing.id, error: String((e as Error)?.message ?? e) });
      }
    }
  }
  return summary;
}

/**
 * W1-T463 — THE DIAGNOSIS FOR "a restricted light sweep ticks every 60s and a PR still sat
 * 21-green and unreviewed for ~15 minutes". `runSweep`'s own `for (const pr of openPrs)` loop
 * is SEQUENTIAL: every gated effect it fires is awaited before the next PR is even
 * dispositioned. The restricted light sweep (`buildSweepLightHook`, run-task.ts) exists so a
 * review can post WHILE a dispatch is in flight (`startInFlightTicker`, daemon.ts, ticks every
 * `pollIntervalMs`) — but it used to hand its WHOLE `openPrs` snapshot to `runSweep` as ONE
 * call, and `SweepDeps.postReview` (`buildSweepEffects`, run-task.ts) is not a cheap status
 * flip: it runs the real `reviewCommand`, which materializes a worktree and EXECUTES every
 * whitelisted proof for that PR (test/retro-sweep-ticker.test.ts pins the mechanism this
 * closes: `startInFlightTicker` does not schedule its NEXT `pollIntervalMs` sleep until
 * `sweepLight()` itself resolves, so the "every ~60s" promise only bounds when a pass STARTS,
 * never how long it runs). One slow-to-judge PR therefore blocked every OTHER
 * post-review-eligible PR queued behind it in the SAME pass — a fast, already-decided PR
 * ordered later in that tick's `buildOpenPrViews` snapshot silently missed its review by
 * however long the PRs ahead of it took, which is the observed ~15-minute shape.
 *
 * THE FIX IS SCOPED TO THIS ONE CALLER, NEVER `runSweep` ITSELF (which `rmd sweep` and the
 * daemon's full per-poll sweep still call, unchanged, over the whole array in one sequential
 * pass): every open PR gets its OWN `runSweep` call, all fired CONCURRENTLY. This is NOT a
 * second review lane (design (ii)/(iv) — no new mechanism, no new per-PR mutex to build): each
 * single-PR call still goes through the exact SAME dedup/disposition/ledger path `runSweep` has
 * always used, and no PR is ever handed to more than one of these concurrent calls, so there is
 * no race on any PR's own dedup key. The only cost is `readLedgerLines` now running once per
 * PR's own call rather than once for the whole batch — a few extra small, local file reads,
 * bounded by the open-PR count the light sweep already fetches every tick.
 *
 * AN EMPTY PASS STILL GETS EXACTLY ONE `runSweep` CALL. Mapping `openPrs` directly would call
 * `runSweep` zero times on a quiet tick, silently dropping the `sweep.pass`/`sweep.summary`
 * per-pass heartbeat `runSweep`'s own doc explains at length (a healthy quiet pass and a
 * blind/dead one must stay distinguishable) — see `test/run-task.test.ts`'s "runs the
 * restricted light sweep over an empty PR set" fixture, which pins exactly this.
 *
 * W1-T513 ADDENDUM: "no PR is ever handed to more than one of these concurrent calls" above is
 * true only WITHIN one `runSweepLightPass` invocation's own `openPrs.map` — it says nothing
 * about a SECOND, separately-fired call (another light pass tick, or the daemon's full
 * `deps.sweep()`) running at the same time over the SAME PR. That cross-call case is exactly
 * what {@link inFlightReviewKeys} now closes, module-wide, inside `runSweep` itself — this
 * function needed no change of its own to inherit that protection.
 */
export async function runSweepLightPass(
  openPrs: OpenPrView[],
  deps: SweepDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<SweepSummary[]> {
  if (openPrs.length === 0) return [await runSweep([], deps, policy)];
  // W1-T526 — THE QUEUE-ADMISSION RULE (see {@link selectReviewAdmission}'s own doc for the
  // full diagnosis and the starvation/holding falsifiers it exists to satisfy). At most ONE
  // open PR is admitted to `post-review` THIS pass; every other PR's own `deps.actionable` is
  // wrapped so a `post-review` disposition it would otherwise win stands down with the SAME
  // "deferred to full sweep (light pass)" reason every other gated disposition already gets
  // from this restricted caller — never a new reason string, never a new mechanism.
  const now = deps.now ? deps.now() : Date.now();
  const admitted = selectReviewAdmission(openPrs, policy, now);
  return Promise.all(
    openPrs.map((pr) => {
      const baseActionable = deps.actionable;
      const scopedDeps: SweepDeps =
        admitted?.prNumber === pr.prNumber
          ? deps
          : {
              ...deps,
              actionable: (d) => (d === "post-review" ? false : baseActionable ? baseActionable(d) : true),
            };
      return runSweep([pr], scopedDeps, policy);
    }),
  );
}

/**
 * W1-T526 — WHICH ONE OPEN PR, IF ANY, {@link runSweepLightPass} admits into `post-review` this
 * pass. Branch protection's `strict: true` means only ONE open PR can merge before every OTHER
 * one reads `behind`, and a `behind` PR's next push mints a NEW head sha — `postReviewed`
 * (`priorActionsFromLedger`, above) is sha-pinned, so that push throws away the very verdict
 * this lane just posted. Before this task `runSweepLightPass` fanned every post-review-eligible
 * PR out to its own concurrent `runSweep` call (design note, its own doc above), so a queue of N
 * such PRs cost N + (N-1) + … + 1 reviews to land N merges instead of N — quadratic in queue
 * depth, and the eight-open-PR incident this task fixes measured 36 reviews to land 8.
 *
 * PURE, OVER THE WHOLE SNAPSHOT, USING THE SAME CLASSIFIER `runSweep` ITSELF USES:
 * {@link deriveDisposition} decides eligibility — a red, conflicted, blocked-ambiguous, or
 * strike-exhausted PR never derives `post-review` in the first place, so it is never a
 * candidate here and can never hold the queue (design iii: only a PR this pass would actually
 * dispatch `post-review` for is ever chosen, and a chosen PR whose review fails leaves no new
 * ledger/dedup state, so the very next pass re-derives eligibility fresh and may choose it
 * again, or may not — the slot is never reserved).
 *
 * OLDEST-HEAD-FIRST, CHOSEN BECAUSE IT CANNOT STARVE (design ii): ranking by "most ready" or by
 * `openPrs` order lets a freshly-pushed PR overtake forever. Ranking by the age of the head
 * itself is monotone instead — a PR that loses this pass is STRICTLY OLDER next pass (nothing
 * un-ages a head), so every eligible PR reaches the front of the queue within a bounded number
 * of passes: the starvation falsifier is that the loser of one pass wins a later one once
 * nothing older remains. {@link OpenPrView.lastActivityAt} is the SAME clock
 * `absentChecksRepushDecision` (above) already reads as "when this head was pushed" — a push
 * always advances it — reused here rather than a second, independent age source. An unreadable
 * age (`Date.parse` -> `NaN`) never outranks a readable one (fails toward not jumping the
 * queue on state we cannot date, the same direction `absentChecksRepushDecision` fails); it can
 * still be chosen when it is the only eligible PR. Ties (equal age, or all ages unreadable)
 * break on ascending PR number, purely for a deterministic, test-stable choice — the ordering
 * rule itself does not depend on which side of a tie wins.
 */
export function selectReviewAdmission(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
): OpenPrView | undefined {
  return oldestActivityFirst(
    openPrs.filter((pr) => deriveDisposition(pr, policy, now).disposition === "post-review"),
    now,
  );
}

/**
 * THE OLDEST-HEAD-FIRST COMPARATOR ITSELF — lifted out of {@link selectReviewAdmission} (W1-T526)
 * so W1-T528's disjoint `update-branch` selection can CONSUME it rather than shipping a second
 * ordering that could silently disagree (design note iii, W1-T528's own doc: "whichever of the
 * two is built first exports the oldest-head-first comparator from `src/lib/sweep.ts` and the
 * second consumes it"). Byte-identical logic to what {@link selectReviewAdmission} always ran —
 * see that function's own doc, directly above, for the full starvation argument this ranking
 * exists to satisfy; it applies unchanged to any `{prNumber, lastActivityAt}` population, not
 * only the post-review one.
 */
export function oldestActivityFirst<T extends { prNumber: number; lastActivityAt: string }>(
  candidates: readonly T[],
  now: number,
): T | undefined {
  let winner: T | undefined;
  let winnerAgeMs = -Infinity;
  for (const candidate of candidates) {
    const pushedAt = Date.parse(candidate.lastActivityAt);
    const ageMs = Number.isNaN(pushedAt) ? -Infinity : now - pushedAt;
    if (!winner || ageMs > winnerAgeMs || (ageMs === winnerAgeMs && candidate.prNumber < winner.prNumber)) {
      winner = candidate;
      winnerAgeMs = ageMs;
    }
  }
  return winner;
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
 *
 * W1-T331: THIS FUNCTION WAS NEVER THE FROZEN PART — `policy` is already a per-call argument,
 * so any caller that builds/resolves its own `SweepPolicy` per consultation already gets a live
 * decision. The bug W1-T330 alone left open was that every real caller omitted `policy` and
 * silently took the default parameter, which resolves to {@link DEFAULT_SWEEP_POLICY} — a
 * const captured once at import (see that constant's own doc). `run-task.ts`'s
 * `costGovernorGateFor` is the fix: it builds an explicit `SweepPolicy` from a per-consultation
 * ceiling (sourced live by `daemon.ts`'s `runDaemon`, once per tick) and passes it here instead
 * of relying on the default.
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
// W1-T1038 — the MEMORY GOVERNOR (the 2026-08-19 host stall). Dispatch has priced every draw in
// dollars ({@link checkCostGovernor} above) and in turns (`num_turns`) since the ledger began,
// and never once in bytes: across the full deduped ledger, zero fields carry
// mem/rss/heap/swap/avail while 1,109 rows carry `cost_usd`. At 18:43:54.955Z the host went
// unreachable with three workers live, 4.69 GiB available minutes earlier. NOTHING WAS
// KILLED — zero `oom-kill`/`Out of memory`/`Killed process`/`oom_reaper` lines across
// journalctl/syslog/kern.log, a measured absence, not a lost log: with no swap the kernel could
// not page out anonymous memory, so it evicted and re-faulted executable pages under reclaim
// livelock, which never arms the OOM killer.
//
// THE ONE DELIBERATE ASYMMETRY WITH ITS TWO SIBLINGS ABOVE. {@link checkCostGovernor} and
// {@link checkQueueGovernor} are consulted through `dispatch-governor.ts`'s
// `checkDispatchGovernors`, whose own doc is headed "FAIL-CLOSED ON AN UNREADABLE OBSERVATION":
// an unreadable cost/queue reading is treated as if it were confirmed over ceiling. THIS
// GOVERNOR'S UNREADABLE CASE MUST NOT JOIN THAT ARM. Three-lane dispatch has been 100% of draws
// since 2026-08-14 (51 sets, admitted mean 3.00, one failure in six days); a guard that refused
// dispatch on every `/proc/meminfo` hiccup would convert a once-in-six-days event into a 100%
// outage. FAIL OPEN: an unreadable observation PERMITS the dispatch. That direction is enforced
// one layer up, at the composition point (`checkDispatchGovernors`'s own comment) — THIS
// predicate never sees a probe failure at all; its input is already a resolved number, and the
// failure (an unreadable `/proc/meminfo`) happens in the real wiring one layer further up still
// (`run-task.ts`'s `memoryGovernorGateFor`).
// ────────────────────────────────────────────────────────────────────────────

/** {@link checkMemoryGovernor}'s verdict for one dispatch-path consultation. */
export interface MemoryGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new run this pass. */
  deferred: boolean;
  /** The observed `MemAvailable` (MiB, read from `/proc/meminfo` — NEVER a cgroup limit; design
   *  note (6): this fleet's containers carry no memory limit, so a cgroup read reports
   *  "unbounded" and would authorise every dispatch silently) the decision was made against. */
  observedAvailableMib: number;
  /** The policy floor consulted (`policy.memoryFloorMib`, carried for the ledger line). */
  floorMib: number;
}

/**
 * The memory governor's pure predicate (design (i)): STRICTLY BELOW `policy.memoryFloorMib` MiB
 * available, NEW dispatch is deferred; at or above it, dispatch proceeds normally. Same shape as
 * {@link checkCostGovernor}/{@link checkQueueGovernor} immediately above — the observation, the
 * floor, and whether it defers — and the SAME dispatch-only asymmetry those two document: never
 * call this from `runSweep` or any of its deps (arm/dispatchFix/close/escalate); it is consulted
 * ONLY on the NEW-dispatch path.
 *
 * SHIPS INERT (design (vi)): `policy.memoryFloorMib` defaults to 0 (`plan/policy.yaml`'s own
 * row), and `observedAvailableMib` can never be negative, so `deferred` is `false` on every call
 * until an operator raises the floor against a measured figure — the threshold this task's own
 * rationale (7) says is NOT YET KNOWN and must not be guessed. Measuring it is this task's own
 * row ({@link logMemoryObservation}, below), never this default.
 *
 * DEFER, NEVER KILL (design (iii)): this predicate only ever gates the NEXT dispatch. It takes
 * a plain number and returns a plain object — there is no parameter through which it could
 * reach, signal, or otherwise touch a running process, so a live worker that crosses the floor
 * mid-run keeps running exactly as {@link checkCostGovernor}/{@link checkQueueGovernor} already
 * never touch an in-flight run either.
 */
export function checkMemoryGovernor(
  availableMib: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): MemoryGovernorResult {
  return {
    deferred: availableMib < policy.memoryFloorMib,
    observedAvailableMib: availableMib,
    floorMib: policy.memoryFloorMib,
  };
}

/**
 * THE OBSERVATION IS LEDGERED ON EVERY CONSULTATION (design (iv)) — unlike {@link
 * logCostGovernorDeferral}/{@link logQueueGovernorDeferral} immediately above, which fire ONLY
 * when their governor's `deferred` is `true`, this caller ledgers unconditionally, admitted
 * readings included. A deferral-only row would sample exactly the population that never happens
 * while the floor ships disabled (design note (vi)) — the evidence this task exists to gather
 * (what a live dispatch actually observes, design notes (7)/(8)) is the ADMITTED reading, not
 * the currently-unreachable deferred one.
 *
 * NOT registered in `ledger.ts`'s `DECISION_RELEVANT_LEDGER_STEPS` (design note (v)): nothing
 * reads this step back yet — THE READER IS THE OPERATOR, scanning the ledger union by hand.
 * Membership is required only once a future predicate reads this step back to decide something,
 * and that predicate's own PR is the one that adds it. Written WITHOUT the literal comparison
 * expression on purpose: test/ledger-rotation.test.ts derives the decision-relevant set by
 * scanning this file's TEXT for that pattern, comments included, so spelling it out here
 * manufactures a consumer that does not exist and fails that test on prose alone.
 */
export function logMemoryObservation(
  result: MemoryGovernorResult,
  appendLine: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void,
  ledgerPath: string,
  runId: string,
): void {
  appendLine(ledgerPath, {
    run_id: runId,
    task_id: "GOVERNOR",
    step: "dispatch_memory_observed",
    observed_available_mib: result.observedAvailableMib,
    memory_floor_mib: result.floorMib,
    deferred: result.deferred,
  });
}

/**
 * How many CONSECUTIVE `sweep.post_review.failed` lines — with no intervening `.done` — mean the
 * post-review path has STALLED rather than hiccupped.
 *
 * DERIVED FROM THE LEDGER, NOT PICKED. Over the live file unioned with every rotation, the
 * consecutive-failure runs (a success resets the count) were: one run of 1, two runs of 4, one run
 * of 5, and one run of 77. The short runs recovered in 2.6–3.5 minutes; the run of 77 spanned 32.5
 * minutes and was still going when an operator found it by hand. The observed transient maximum is
 * 5 and the observed stall is 77, with NO observation between — so 8 sits inside an empty gap, with
 * ~60% margin over the worst transient and far below the stall. Raise this only against new data.
 */
export const POST_REVIEW_STALL_THRESHOLD = 8;

/** {@link detectPostReviewStall}'s verdict. */
export interface PostReviewStallVerdict {
  /** true ⇒ the run of consecutive failures has reached {@link POST_REVIEW_STALL_THRESHOLD}. */
  stalled: boolean;
  /** Length of the CURRENT consecutive-failure run (0 when the newest outcome was a success). */
  consecutiveFailures: number;
  /** `ts` of the newest failure in the run — the EPISODE KEY the escalator dedups on. */
  newestFailureTs?: string;
  /** `ts` of the oldest failure in the run, so the escalation can state how long it has been going. */
  oldestFailureTs?: string;
  /**
   * The run's error text with digit runs replaced by `<N>`. NORMALISATION IS LOAD-BEARING: the 91
   * observed failures carried 10 DISTINCT raw error strings and exactly ONE normalised string,
   * because the text embeds the PR number (`gh pr view 1339 …` vs `gh pr view 1340 …`). Grouping on
   * the RAW text would split one systematic stall into ten unrelated-looking groups and defeat the
   * whole point of noticing that a failure repeats.
   */
  normalisedError?: string;
  /**
   * true when every failure in the run is an API quota exhaustion. Carried so the escalation can say
   * so — a quota failure is fleet-stopping but self-clearing at a known reset, which asks something
   * different of the operator than a persistent bug does. It deliberately does NOT gate
   * {@link PostReviewStallVerdict.stalled}: a systematic stall is worth surfacing whatever its cause,
   * and gating on a recognised error string would make the detector blind to every unrecognised one.
   */
  rateLimited: boolean;
}

/** Digit runs → `<N>`, so a per-PR error text collapses to one group. See `normalisedError`. */
function normaliseErrorText(s: string): string {
  return s.replace(/\d+/g, "<N>");
}

/**
 * Is the sweep's post-review path stalled? Pure over ledger lines, oldest-first.
 *
 * THE DEFECT THIS EXISTS FOR (measured 2026-08-05): `sweep.post_review.failed` had fired 91 times —
 * every one a GraphQL rate-limit — across a week, and NOTHING SURFACED IT. Green PRs sat unreviewed
 * while the sweep retried each tick and logged another identical line. The operator found it by
 * hand. A transport fix removes THIS cause; it does not remove the class, because the next
 * systematic post-review failure for a different reason would be equally silent.
 *
 * COUNTS THE CURRENT RUN ONLY, and any `.done` resets it — the question is "is it stalled NOW",
 * not "has it ever failed a lot". A lifetime count would latch permanently after the first bad day.
 */
export function detectPostReviewStall(
  lines: ReadonlyArray<Record<string, unknown>>,
  threshold: number = POST_REVIEW_STALL_THRESHOLD,
): PostReviewStallVerdict {
  const run: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (l.step === "sweep.post_review.done") run.length = 0;
    else if (l.step === "sweep.post_review.failed") run.push(l);
  }
  if (run.length === 0) return { stalled: false, consecutiveFailures: 0, rateLimited: false };
  const errs = run.map((l) => (typeof l.error === "string" ? l.error : ""));
  const newest = run[run.length - 1];
  const oldest = run[0];
  return {
    stalled: run.length >= threshold,
    consecutiveFailures: run.length,
    newestFailureTs: typeof newest?.ts === "string" ? newest.ts : undefined,
    oldestFailureTs: typeof oldest?.ts === "string" ? oldest.ts : undefined,
    normalisedError: normaliseErrorText(errs[errs.length - 1] ?? ""),
    rateLimited: errs.length > 0 && errs.every((e) => /rate limit/i.test(e)),
  };
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

/*
 * `hasMergeCredit` USED TO LIVE HERE and was removed 2026-08-13, not merely bypassed.
 *
 * It answered "has this task's merge already been credited" — either a live run's own terminal
 * `verdict: "merged"` line or a PRIOR `verdict.merged` correction from this rung — over an array
 * the caller had read with `readLedgerLines`, WHICH OPENS EXACTLY ONE FILE. That single-file read
 * was the defect: rotation caps a step at `MAX_RETAINED_LINES_PER_STEP`, so older credit left the
 * live file and the same tasks were re-credited forever.
 *
 * `readMergeCreditedTaskIds` (status.ts) now answers the same question across all three ledger
 * forms and returns the ids as a set. Its semantics are preserved exactly where they were right:
 * still keyed on `task_id` ALONE and never `run_id`, because sibling credit (P29(i)/W1-T149) means
 * ANY run of this task recording a merge counts — not only the run whose candidate is being
 * reconciled this pass. The line-shape test is still `isMergeCreditLine`, imported rather than
 * restated, for the reason the deleted comment gave: two hand-maintained copies of "what a merge
 * credit looks like" is what once let a back-credited task stay circuit-broken. Leaving this
 * function here beside the new reader would recreate exactly that.
 */

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
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});

  // THE CREDIT QUESTION IS "EVER", AND ONE FILE CANNOT ANSWER IT. This used to read
  // `readLedgerLines`, which opens exactly ONE path, against a step whose rows rotation caps at
  // `MAX_RETAINED_LINES_PER_STEP` (200 newest). Credit older than that left the live file, this
  // check said "not credited", the task was re-credited, and the fresh row evicted another —
  // self-sustaining. MEASURED 2026-08-13: 385 distinct credited tasks in the live file minus the
  // 200 rotation retains = 185, and the live file held EXACTLY 185 `sweep.credit_backfill` rows.
  // See {@link readMergeCreditedTaskIds} for the full arithmetic and the read-cost measurements.
  const credited = readMergeCreditedTaskIds(deps.ledgerPath, {
    // Only the tasks this pass could ask about, so the walk stops as soon as they are all resolved
    // rather than reading to the cap. Measured: real plan ids resolve below depth 8.
    candidates: candidates.map((c) => c.taskId),
    readLive: deps.readLedger,
  }).credited;

  const results: CreditBackfillResult[] = [];
  let corrected = 0;

  for (const c of candidates) {
    const alreadyCredited = credited.has(c.taskId);
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
      // Reflected into THIS pass's own view (not just re-read on the next sweep) so a duplicate
      // candidate naming the same task later in the same array credits exactly once.
      credited.add(c.taskId);
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

/**
 * QUEUE LABELS this reconciler retires issues from (W1-T349): `needs-human` (unchanged) plus
 * `fleet-notice` — a residual-escalation-judge demotion (escalate.ts's `escalateWithJudge`)
 * leaves the NEEDS ME board, which keys on `needs-human`, but the design's own promise —
 * "recovery is relabelling — nothing is deleted, nothing is unfiled" — only holds if THIS
 * reconciler can still find and retire it once its referent resolves. Below this point nothing
 * else changes: {@link EscalationReconcileCandidate} carries no label field at all, so {@link
 * runEscalationReconcile} already treats a fleet-notice-sourced candidate identically to a
 * needs-human one — by construction, not by an added branch.
 */
export const RETIRABLE_ESCALATION_LABELS: readonly string[] = [NEEDS_HUMAN_LABEL, FLEET_NOTICE_LABEL];

/**
 * List every OPEN issue across {@link RETIRABLE_ESCALATION_LABELS}, deduped by issue number (an
 * issue cannot carry both queue labels by construction — escalate.ts's `escalate()`/
 * `escalateWithJudge()` create with exactly ONE queue label — but the dedup costs nothing and
 * protects against a future producer that double-labels). Same fail-soft contract as a single
 * `listOpen` call: a read failure on ANY label aborts the WHOLE list (never a partial result the
 * caller could mistake for "nothing else is open") — the caller's existing catch already treats
 * that as "do nothing this cycle, never a confident zero open" (run-task.ts's
 * `buildEscalationReconcileCandidates`).
 */
export function listRetirableEscalationIssues(issues: IssueGateway): OpenIssue[] {
  const seen = new Map<number, OpenIssue>();
  for (const label of RETIRABLE_ESCALATION_LABELS) {
    for (const issue of issues.listOpen?.(label) ?? []) {
      seen.set(issue.number, issue);
    }
  }
  return [...seen.values()];
}

/** One open needs-human issue paired with its referenced task's CURRENT derived state. */
export interface EscalationReconcileCandidate {
  issueUrl: string;
  issueNumber?: number;
  taskId: string;
  /**
   * W1-T347: the W1-T346 ask-type classification for this issue, when the caller can supply
   * it (read back off the issue's `needs-question`/`needs-action` label). `"question"` routes
   * a terminal-referent close through {@link renderMootedCloseComment} instead of {@link
   * renderReconcileCloseComment} — see the guard in {@link runEscalationReconcile}. `"action"`
   * OR omitted (the untyped, pre-W1-T346 corpus) keeps today's close path byte-identical: this
   * is the legacy default and MUST NOT change behavior.
   */
  askType?: AskType;
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
  /**
   * What the candidate BUILDER saw on intake, so the summary can distinguish "nothing was open"
   * from "everything open was dropped". Optional and defaulted: a caller that does not supply it
   * gets exactly the line it got before, never a crash and never a fabricated zero.
   */
  intake?: { issuesSeen: number; droppedNoTaskTrailer: number; droppedNoReferent: number };
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
 * W1-T347 — the guard {@link renderReconcileCloseComment} above does NOT apply to: a
 * `needs-question` issue whose referent went terminal is MOOTED, not resolved, and closing it
 * in {@link renderReconcileCloseComment}'s voice ("is now merged, resolved by") claims an
 * answer nobody gave. The measured cost: 50 of 151 reconciler auto-closes carried question-form
 * titles, and #1200 ("needs a scope decision, not another retry") auto-closed 9 minutes after
 * an unrelated PR merged, citing the merge as if it had answered the question.
 *
 * Names the mooting event (the same PR the resolved-close cites) but states PLAINLY that the
 * question was never answered — only mooted by the referent going terminal — and tells the
 * reader where to re-raise it if it still stands. Starts with a FIXED, DISTINCT prefix ("MOOTED
 * by the escalation-lifecycle reconciler") so a later sweep/census can tell a mooted close from
 * a resolved one by exact string match, never by parsing prose (design clause iii).
 *
 * Pure + exported for a direct assertion, mirroring {@link renderReconcileCloseComment}.
 */
export function renderMootedCloseComment(c: EscalationReconcileCandidate): string {
  const pr = c.derived.prNumber !== undefined ? `#${c.derived.prNumber}` : (c.derived.prUrl ?? "its PR");
  const link = c.derived.prUrl ? ` (${c.derived.prUrl})` : "";
  const via = c.derived.source ? ` — derived via \`${c.derived.source}\`` : "";
  const event = c.derived.merged
    ? `${pr}${link} merged${via}`
    : `${pr}${link} closed without merging${via}`;
  return [
    "MOOTED by the escalation-lifecycle reconciler (fb-1784756088300-6a481e).",
    "",
    `The referenced task **${c.taskId}**'s blocking PR ${event}, so this issue no longer blocks anything and is being closed.`,
    "",
    "**This did NOT answer the question this issue raised.** No human weighed in — the referent simply went " +
      "terminal on its own, mooting the question rather than resolving it.",
    "",
    "_If the question still stands, re-raise it: reopen this issue, or file a fresh one against the task above._",
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
    // W1-T347: a question-typed issue is MOOTED by a terminal referent, never resolved by
    // one — nobody answered it. Action-typed and untyped (`askType` omitted, the legacy
    // pre-W1-T346 corpus) issues keep today's resolved-close comment byte-identical.
    const comment = c.askType === "question" ? renderMootedCloseComment(c) : renderReconcileCloseComment(c);
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
  // `total: 0` USED TO BE AMBIGUOUS — see EscalationIntake (run-task.ts) for the recon this cost.
  // `issues_seen` is always emitted (one integer, negligible on a line that fires ~16x/hour) so the
  // healthy case is positively identifiable rather than merely un-alarming.
  //
  // The per-reason tally rides ONLY on the abnormal path. On every healthy pass issuesSeen === total
  // and the line is one field wider than before; the detail appears exactly when there is something
  // to explain, which is also when an operator is reading it.
  const intake = deps.intake;
  const dropped =
    intake && intake.issuesSeen > summary.total
      ? { no_task_trailer: intake.droppedNoTaskTrailer, no_referent: intake.droppedNoReferent }
      : undefined;
  log("sweep.escalation_reconcile.summary", {
    total: summary.total,
    closed: summary.closed,
    // `undefined` when the caller supplied no intake — the field is absent, never a misleading 0.
    ...(intake ? { issues_seen: intake.issuesSeen } : {}),
    ...(dropped ? { dropped } : {}),
  });
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

/**
 * W1-T474 row 1 — the coverage-tier fix (#1758, `39f198a`): `coverage-ratchet` reads
 * `scripts/coverage-baseline.json` from the PR's OWN checked-out tree (the `pull_request`
 * default `refs/pull/N/merge`, per W1-T474's rationale (7)), so a PR that merged BEFORE #1758
 * raised the floor still fails against the file #1758 already fixed — its diff never touched
 * coverage. Matches on the required check's recorded name AND the ratchet's own "BLOCKED"
 * wording (`scripts/coverage-ratchet.mjs`), never on `checksState` alone — a PR that genuinely
 * lowered coverage must never match this class.
 */
export const COVERAGE_TIER_FIX_CLASS: FixClass = {
  id: "coverage-ratchet-stale-floor",
  fixPrNumber: 1758,
  description:
    "coverage-ratchet blocked against a floor #1758 had already raised in scripts/coverage-baseline.json " +
    "— the checked-out tree read the pre-fix floor, not a real coverage regression in this PR's own diff",
  matchesFailure: (pr) =>
    (pr.ciFailures ?? []).some(
      (f) => f.name === "coverage-ratchet" && /BLOCKED -- coverage is below a floor/i.test(f.logTail),
    ),
};

/**
 * W1-T474 row 2 — the capability-snapshot regeneration (#1762, `b537b08`): the `claims` required
 * check's `capability-snapshot:check` assertion (`scripts/generate-capability-snapshot.mjs`)
 * fails whenever the checked-out `MASTER-PLAN.md` doesn't match a fresh regeneration — and, per
 * rationale (7), the `pull_request` default checkout is the pinned merge ref against the OLD
 * base, so every PR merged before #1762 regenerated the snapshot reads the stale block. Matches
 * on the check's own STALE wording, never on checksState alone.
 */
export const CAPABILITY_SNAPSHOT_FIX_CLASS: FixClass = {
  id: "capability-snapshot-stale",
  fixPrNumber: 1762,
  description:
    "the claims check's capability-snapshot assertion failed on a MASTER-PLAN.md block #1762 had " +
    "already regenerated — the checked-out tree carried the stale block, not this PR's own diff",
  matchesFailure: (pr) =>
    (pr.ciFailures ?? []).some(
      (f) => f.name === "claims" && /CAPABILITY SNAPSHOT block is STALE/i.test(f.logTail),
    ),
};

/** The live class table this reconciler consults by default — a new systemic fix is a row appended
 *  here (design note i), never a change to {@link runPostFixReverification}. */
export const DEFAULT_FIX_CLASSES: readonly FixClass[] = [
  CI_GATE_TIMEOUT_FIX_CLASS,
  COVERAGE_TIER_FIX_CLASS,
  CAPABILITY_SNAPSHOT_FIX_CLASS,
];

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
  /**
   * OPTIONAL reader for a PR's currently-failing required checks (W1-T977), consulted ONLY when
   * this pass's own snapshot carries `ciFailures: undefined` AND `checksState === "pending"` —
   * the one state {@link CI_GATE_TIMEOUT_FIX_CLASS} exists to match and the one state
   * `buildOpenPrViews` (run-task.ts) never populates `OpenPrView.ciFailures` for: that producer
   * only fetches `ciFailures` when the AGGREGATE `checksState` is `"red"`, but a `ci-gate`
   * timeout is BY DEFINITION observed while a sibling required check is still running, i.e.
   * `checksState === "pending"` — so the class was structurally unable to see its own trigger.
   * Never consulted when `checksState` is `"green"`/`"none"` (nothing failing to read) or
   * already `"red"` (the snapshot's own `ciFailures` already carries it) — narrowly scoped to
   * the one gap this task closes, never a blanket re-fetch, and never widening what
   * `buildOpenPrViews` itself populates (design note iii — no other rung's view changes).
   * OMITTED (the default), behaviour is BYTE-IDENTICAL to before this dep existed: every
   * existing caller/fixture that doesn't supply it sees a pending PR's `ciFailures` stay
   * `undefined` exactly as today (criterion 5).
   */
  readCiFailures?: (pr: OpenPrView) => CiFailure[] | undefined | Promise<CiFailure[] | undefined>;
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
    // W1-T977: the shared snapshot's own `ciFailures` is undefined for a PENDING PR by
    // construction (`buildOpenPrViews` only fetches it when `checksState === "red"`) — but a
    // `ci-gate` required-check timeout is observed EXACTLY while a sibling is still pending, so
    // matching on the snapshot field alone can never fire for the one class this loop exists to
    // catch. Consult the injected reader ONLY in that gap (undefined + pending) — never for a
    // green/none PR (nothing failing) and never overriding an already-populated red snapshot —
    // so every other rung's view of `pr` stays untouched (design note iii).
    let extraCiFailures: CiFailure[] | undefined;
    if (pr.ciFailures === undefined && pr.checksState === "pending" && deps.readCiFailures) {
      try {
        extraCiFailures = await deps.readCiFailures(pr);
      } catch {
        // Best-effort, mirrors fetchCiFailures' own degrade-to-nothing contract: a failed read
        // just leaves this PR unmatched this pass rather than aborting the whole reconciliation.
      }
    }
    const matchPr: OpenPrView = extraCiFailures !== undefined ? { ...pr, ciFailures: extraCiFailures } : pr;
    const cls = classes.find((c) => mergedFixPrNumbers.has(c.fixPrNumber) && c.matchesFailure(matchPr));
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
