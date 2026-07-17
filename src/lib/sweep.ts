import { appendLedger } from "./ledger.js";
import { readLedgerLines } from "./status.js";
import type { CriterionVerdict } from "./review.js";

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
 *   - BLOCKED-FIXABLE  — a failing review with actionable unmet criteria and strikes
 *                        left -> dispatch the W1-T76 fix rung (reused, not
 *                        reimplemented) carrying the FULL unmet set at once.
 *   - STALE/SUPERSEDED — a newer PR credits the same task, or no activity in N days
 *                        -> close with a stated reason (the #111/#113 manual chore).
 *   - BLOCKED-AMBIGUOUS— fix strikes exhausted, contradictory criteria, OR the
 *                        TERMINAL catch-all (anything not positively mergeable and
 *                        not already failure-shaped, e.g. CI-red with review
 *                        skipped/none/pending) -> escalate via W1-T8's
 *                        `escalate()`, naming the observed CI/review state so it is
 *                        never silent and never armed (a dedicated
 *                        clarification-question rung is W1-T78, NOT this task —
 *                        plain escalate() is correct and sufficient here).
 *                        blocked_ci-shaped PRs route here only UNTIL the fix rung
 *                        accepts CI-log input (W1-T94); once that lands, this row
 *                        should split so ci=red carries actionable log input to
 *                        blocked-fixable instead.
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
 * Tunable thresholds as DATA (rule 2) — never inlined constants in the predicate.
 * A test overrides these to prove policy is data (acceptance 3): tightening
 * `staleDays` flips a fixture PR's disposition with zero sweep-code changes.
 */
export interface SweepPolicy {
  /** No activity in >= this many days ⇒ the PR is abandoned -> close. */
  staleDays: number;
  /** Max fix-rung strikes before a failing review escalates instead of fixing. */
  strikeCap: number;
}

/** The default policy — 14-day stale window, 2 fix strikes (mirrors fixStrikeCap). */
export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  staleDays: 14,
  strikeCap: 2,
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
}

/** The disposition derived for one PR, plus a stated human reason. */
export interface DispositionResult {
  disposition: Disposition;
  reason: string;
}

const MS_PER_DAY = 86_400_000;

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
 *   3. FAILING + strikes exhausted (>= cap)              -> blocked-ambiguous (escalate).
 *   4. FAILING + actionable unmet criteria, strikes left -> blocked-fixable (fix rung).
 *   5. FAILING + no actionable criteria (contradictory)  -> blocked-ambiguous (escalate).
 *   6. CI GREEN + REVIEW SUCCESS (POSITIVE match only)   -> mergeable (arm).
 *   7. TERMINAL catch-all (the #161 fix, W1-T93): anything not positively
 *      mergeable and not already failure-shaped — including CI-red with review
 *      skipped/none/pending — -> blocked-ambiguous (escalate), naming the
 *      observed checks/review state. The catch-all is the LEAST permissive
 *      disposition, never the most permissive one; mergeable is ONLY ever
 *      positively matched (row 6), never a fallback.
 *
 * Stale/superseded rows precede the failing/mergeable rows so tightening the
 * stale threshold flips an otherwise-mergeable PR to a close. Rows 3-5 (review
 * FAILING) precede row 6 so a CI-green-but-review-failing PR still routes to
 * fix/escalate, not mergeable.
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
    disposition: "blocked-ambiguous",
    when: (pr, policy) => pr.reviewState === "failure" && pr.priorStrikes >= policy.strikeCap,
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
    // (the #161 fix, W1-T93), not the most permissive one. A CI-red PR with its
    // review skipped/none/pending — the #161 shape — matches no failure rule
    // (reviewState isn't "failure") and no longer falls through to mergeable by
    // default: it lands here and ESCALATES, naming the observed state, so it is
    // never silent and never armed. (blocked_ci-shaped PRs route here only UNTIL
    // the fix rung accepts CI-log input — W1-T94.)
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

/** Injected effects — the real command wires arm/close/fix/escalate; tests fake them. */
export interface SweepDeps {
  /** Arm GitHub auto-merge (armAutoMerge). Idempotent at the GitHub level. */
  arm: (pr: OpenPrView) => void | Promise<void>;
  /** Close a superseded/abandoned PR with a stated reason. */
  close: (pr: OpenPrView, reason: string) => void | Promise<void>;
  /** Dispatch the W1-T76 fix rung carrying the FULL unmet set at once. */
  dispatchFix: (pr: OpenPrView, unmet: CriterionVerdict[]) => void | Promise<void>;
  /** Escalate an ambiguous block via W1-T8's escalate(). */
  escalate: (pr: OpenPrView, reason: string) => void | Promise<void>;
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
          await deps.dispatchFix(pr, pr.unmetCriteria);
          break;
        case "stale":
          await deps.close(pr, reason);
          break;
        case "blocked-ambiguous":
          await deps.escalate(pr, reason);
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
    });

    log("sweep.dispose", {
      pr_number: pr.prNumber,
      disposition,
      acted,
      reason,
      deduped: alreadyDone,
    });

    // One ledger line per disposition (the INVARIANT). Skipped under --dry-run —
    // a preview must leave no trace, so a real run afterward still acts.
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
