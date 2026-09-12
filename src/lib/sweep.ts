import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  armAutoMergeDetailed,
  armFailureAction,
  disarmAutoMerge,
  logArmAttribution,
  type ArmAttemptResult,
  type ArmLane,
  type ArmOutcome,
  type DisarmOutcome,
} from "./arm-auto-merge.js";
import { diagnoseBodyDefects } from "./body-repair.js";
import { type Config, fixStrikeCap } from "./config.js";
import { gitPushEmptyCommit, gitPushRunBranch, LanePushForeignHeadError } from "./git-push.js";
import { ghJson, ghJsonAsync } from "./github-transport.js";
import { runIsolatedLocalMergeRoute, localMergeRouteForCheck, type IsolatedMergeRouteResult } from "./ci-parity.js";
import { acquireInflightLock, InflightLockError, type InflightLockHandle } from "./inflight-lock.js";
import { appendLedger } from "./ledger.js";
import { resolveLedgerUnion } from "./ledger-union.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";
import { loadMounts, mountsPath, resolveMount, type Mount } from "./mounts.js";
import { DEFAULT_RISK, RETIREMENT_REASONS, type AcceptanceCriterion, type Plan, type RetirementReason, type TaskRisk } from "./plan.js";
import {
  defaultCreditStorePath,
  hasCreditBackfillReceipt,
  loadCreditStore,
  readLedgerLines,
  readMergeCreditedTaskIds,
  recordCreditBackfillReceipt,
  saveCreditStore,
  taskIdFromRunBranch,
  isGhRateLimitError,
} from "./status.js";
import type { CreditBackfillReceipt, CreditStore } from "./status.js";
import { installPolicyPath, loadDefaultPolicy, PolicyError } from "./policy.js";
import { loadDefaultCostAnomalyPolicy, recordCostAnomalies, type CostAnomalyPolicy } from "./cost-anomaly.js";
import {
  acceptanceBlockDiagnostics,
  automergeHoldFromLedger,
  cappedOverrideFromLedger,
  decideAutoMergeArm,
  isCriterionRefusal,
  parseAcceptanceBlock,
  postedArmFactsFromLedger,
  REVIEW_CONTEXT,
} from "./review.js";
import type { ArmDecision, AutomergeHold, CriterionVerdict } from "./review.js";
import { parseLedger } from "./retro.js";
import { selectRuntimeReviewWidth } from "./review-capacity.js";
import {
  activeWorkerCount,
  appendQuestion,
  capStderrExcerpt,
  listRegisteredWorktrees,
  renderWorkerSettings,
  spawnWorker,
  STDERR_EXCERPT_CAP,
  worktreeRemove,
  worktreesDir,
  type QuestionEntry,
  type SpawnWorkerArgs,
  type WorkerResult,
} from "./worker.js";
import {
  FLEET_NOTICE_LABEL,
  NEEDS_HUMAN_LABEL,
  escalationCause,
  escalate,
  ghIssueGateway,
  tryEscalate,
  type AskType,
  type EscalationClass,
  type IssueGateway,
  type OpenIssue,
} from "./escalate.js";
import { fetchWorkflowRunObservations, GhPaceFloorStandDownError, paceGhEntry, type GhCallPacer } from "./open-prs-rest.js";
// W1-T2384: the supersession types live in a leaf that imports nothing, so open-prs-rest.ts can
// declare the producer without closing the type cycle this module's value import would complete.
// Re-exported below, so every existing `from "…/sweep.js"` call site keeps working untouched.
import type {
  SupersessionDiffFinding,
  SupersessionEvidence,
  SupersessionStatus,
  SupersessionVerdict,
} from "./supersession.js";
export type { SupersessionDiffFinding, SupersessionEvidence, SupersessionStatus, SupersessionVerdict };
import type { ConflictFileDiff, MergeConflictEvidence, MergeState } from "./merge-state.js";
import type { WorkflowRunObservation } from "./workflow-run.js";
import type { ReviewCapacityPolicy } from "./review-capacity.js";
// Re-exported so existing `import type { … } from "./sweep.js"` call sites keep working.
export type { ConflictFileDiff, MergeConflictEvidence, MergeState } from "./merge-state.js";
// W1-T2340: declared in a leaf module so open-prs-rest.ts's producer imports it without closing
// an open-prs-rest <-> sweep cycle. See workflow-run.ts's own doc.
export type { WorkflowRunObservation } from "./workflow-run.js";

/**
 * The escalation's TASK IDENTITY for one open PR — pure, so the mint itself is testable without
 * reaching the `escalate` closure's real issue gateway.
 *
 * A PR carrying a `Remudero-Task:` trailer escalates under its own task id. A PR without one is the
 * OPERATOR-LANE agent PR — the class with neither a task nor a run id — and it used to be stamped
 * the literal string `"UNKNOWN"`. That is not a plan task id, so
 * `buildEscalationReconcileCandidates`'s `plan.byId.get(taskId)` missed it and the resulting issue
 * could NEVER be retired: 53 of 57 open needs-human issues carried `**Task:** UNKNOWN` while the
 * reconciler's population read 0 on every pass.
 *
 * `PR-<n>` is NOT a new convention — it is the SAME synthetic id the review lane already mints at
 * four call sites in this file, so an operator grepping either surface sees ONE identity for the
 * PR. And it round-trips: {@link buildEscalationReconcileCandidates} resolves a `PR-<n>` referent
 * directly from the number, because an id that is enumerable but UNDERIVABLE would convert a
 * visible orphan into an invisible one, which is strictly worse than leaving it alone.
 */
export function escalationTaskIdFor(pr: { taskId?: string; prNumber: number }): string {
  return pr.taskId ?? `PR-${pr.prNumber}`;
}

/**
 * W1-T516 — the SWEEP's OWN task-id resolution for one PR's arm attempt, gated on the
 * `sweep.armSessionPrs` policy flag.
 *
 * THE DEFECT THIS CLOSES. `buildSweepEffects`'s `arm` dep used to pass `pr.taskId` RAW to
 * {@link armAndLogOutcome}, while the review lane (`task_id: taskId ?? PR-<n>`), the
 * escalation lane ({@link escalationTaskIdFor}), and `approveCommand` all mint the SAME
 * `PR-<n>` synthetic id for exactly this case — a PR with no `Remudero-Task:` trailer. The
 * sweep was the ONE caller that did not, so `armAutoMerge`'s `if (!taskId)` branch refused
 * every session PR the sweep reviewed, unconditionally.
 *
 * OFF (the default): returns `pr.taskId` unchanged — a session PR still resolves to
 * `undefined` and `armAutoMerge` still refuses at `no-task-id`, byte-for-byte the pre-
 * existing behaviour.
 *
 * ON: mints the SAME `PR-<n>` fallback {@link escalationTaskIdFor} already mints, so the id
 * this arm passes is the exact key `decideArmFromLedgerVerdict` already finds the review
 * lane's own verdict under — no new ledger shape, no second synthetic id.
 */
export function sweepArmTaskId(pr: { taskId?: string; prNumber: number }, armSessionPrs: boolean): string | undefined {
  return armSessionPrs ? escalationTaskIdFor(pr) : pr.taskId;
}

/**
 * THE TASK THE FIX RUNG REPAIRS AGAINST — the plan task when the PR has one, otherwise a SYNTHETIC
 * stand-in keyed by the SAME id the review lane and the escalation lane already mint.
 *
 * THE DEFECT (impl-FY). `dispatchFix` looked the PR's task up in the plan and returned when it
 * found none, logging `sweep.fix.no_task`. An agent-authored PR has a descriptive branch and no
 * `Remudero-Task:` trailer, so it matches no task — and the rung that exists to repair a CI-failing
 * PR could not act on it. Measured: #1115, #1116, #1117, #1118, #1120, #1127 and #1132 all logged
 * `sweep.fix.no_task` with `task_id=(none)`, #1132 while dispositioned `blocked-fixable` — the
 * sweep correctly identifying a fixable PR and then doing nothing, every poll, silently.
 *
 * NOT A SECOND MECHANISM: the id comes from {@link escalationTaskIdFor} — `pr.taskId ?? PR-<n>`,
 * the SAME synthetic form `reviewCommand` writes its `review.posted` key with, so one PR has ONE
 * identity across the review, escalation and fix surfaces.
 *
 * AND IT IS WHAT MAKES THE CAP BIND. `priorStrikesFor` returns 0 for an undefined taskId, so an
 * un-synthesised PR would have been not merely reachable but UNBOUNDED — the same shape as the
 * defect. With the id present the strike cap keys on it exactly as it does for a plan task.
 *
 * `risk` is DEFAULT_RISK because a mount must resolve and a PR carries no risk field.
 */

/**
 * `acceptance` FOR A SYNTHETIC TASK (round 2, PR #1146's own review-floor failure): the ORIGINAL
 * premise here — "empty because a no-task PR has no plan criteria, which costs nothing since the
 * only disposition reaching this path seeds `criteria: []` and targets FAILING CHECKS, never a
 * review verdict" — is FALSE for a `blocked_review` disposition. That disposition DOES reach this
 * path for a synthetic (no-task) PR, and `runFixRung`'s post-strike `runReview` call judges
 * `task.acceptance` DIRECTLY (`criteria = task.acceptance ?? []`, never re-reading the PR body) —
 * so a hardcoded `[]` here made every synthetic-task review permanently unjudgeable
 * ("no acceptance criteria to judge (fail closed)"), regardless of what the fix worker changed,
 * on EVERY strike after the first: an unfixable loop, not merely a no-op one. `caller`-supplied
 * `body` closes it the SAME way `reviewCommand` already resolves criteria for a manual/plan PR —
 * `parseAcceptanceBlock` over the PR body's `## Acceptance` block — so a synthetic task carries
 * the SAME criteria a human `rmd review` run would find, instead of none.
 */
export function fixRungTaskFor(
  plan: Plan,
  pr: { prNumber: number; taskId?: string },
  body?: string,
  headRefName?: string,
): { task: { id: string; title: string; risk: TaskRisk; acceptance: AcceptanceCriterion[]; budget_usd?: number }; synthetic: boolean } {
  const found = pr.taskId ? plan.tasks.find((t) => t.id === pr.taskId) : undefined;
  if (found) return { task: found as never, synthetic: false };
  const branchTaskId = taskIdFromRunBranch(headRefName);
  const syntheticLaneId = branchTaskId && /^(?:RETRO|TRIAGE-.+|PLAN-.+|APPROVE-.+)$/.test(branchTaskId)
    ? branchTaskId
    : undefined;
  return {
    task: {
      // A plan-only lane PR deliberately has no credited task, even when its body carries a lane
      // trailer. The fix rung still needs the lane identity to recognize that
      // `run-RETRO-*`/TRIAGE/PLAN/APPROVE is its own head. Restrict this fallback to the four
      // orchestrator lane namespaces; a synthetic PR on `run-W1-T*` remains foreign and refused.
      id: pr.taskId ?? syntheticLaneId ?? escalationTaskIdFor(pr),
      title: `PR #${pr.prNumber}`,
      risk: DEFAULT_RISK,
      acceptance: body ? parseAcceptanceBlock(body) : [],
    },
    synthetic: true,
  };
}

/** The synthetic lane namespaces whose PR branches are created by the orchestrator itself. */
function isSyntheticOrchestratorLaneId(taskId: string): boolean {
  return /^(?:RETRO(?:-.+)?|TRIAGE-.+|PLAN-.+|APPROVE-.+)$/.test(taskId);
}

/**
 * Is `head` an acceptable branch for a fix dispatch to amend?
 *
 * FOR A PLAN TASK, unchanged and still strict: the fix must amend THAT task's own run branch,
 * because creditability is load-bearing (status.ts's `ownsBranch`) and a fix on an uncreditable
 * head loops forever and strands dependents.
 *
 * FOR A SYNTHETIC (no-task) PR the entire rationale is inapplicable — there is no task to credit
 * and no dependent to strand — so its own descriptive head is acceptable. ONE guard remains, and it
 * is the load-bearing half: a head that CLAIMS SOME OTHER TASK (`run-W1-T123-…`) is refused. Such a
 * PR is not task-less, it is MIS-TRAILERED, and amending it would push commits onto another task's
 * run branch under a synthetic identity.
 *
 * This never widens WHICH PRs are fixable — the disposition set is untouched — only whether the
 * rung can act on one the sweep has already classified.
 */

/**
 * Is `head` ANY dispatched run's own branch — `run-<taskId>-<epochMs>`, the shape every
 * worker push takes (`const branch = \`run-${runId}\``)? TASK-AGNOSTIC, unlike status.ts's
 * `ownsBranch`/`isBareRunBranch`, which answer "does this head claim THIS task".
 *
 * It is the only authorship signal the review path holds, and W1-T385 wires it to the one
 * consumer that needs it: `runReview` derives `humanAuthored` (see {@link
 * "./lib/review.js".RubricPrMeta.humanAuthored}) as "a head ref exists AND is not this
 * shape". Absent head ⇒ `false` here, so that consumer fails CLOSED.
 *
 * The regex is unchanged from `fixHeadAcceptable`'s own inline copy, which now calls this
 * so the shape has ONE home rather than two that can drift apart.
 */
export function isDispatchedRunBranch(head: string | undefined): boolean {
  return head !== undefined && /^run-.+-\d+$/.test(head);
}

export function fixHeadAcceptable(head: string | undefined, taskId: string, synthetic: boolean): boolean {
  if (!head) return false;
  const ownRunBranch = new RegExp(`^run-${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(head);
  if (!synthetic) return ownRunBranch;
  const exactSyntheticLaneBranch = isSyntheticOrchestratorLaneId(taskId) && head === `run-${taskId}`;
  // A synthetic id covers two shapes: an agent PR with NO id at all (descriptive branch), and a
  // LANE PR whose id is real but absent from plan.tasks. A lane can have the ordinary
  // `run-<id>-<dispatch epoch>` head or the exact `run-<id>` head when its id already ends in the
  // lane's own epoch. Preserve that full id as the strike/review key; only the ownership
  // equivalence changes. A run branch claiming a DIFFERENT task remains refused.
  return ownRunBranch || exactSyntheticLaneBranch || !isDispatchedRunBranch(head);
}

/**
 * WHY a fix dispatch just declined an uncreditable head, as ONE aggregatable token.
 *
 * `sweep.fix.uncreditable_head` recorded `head`/`synthetic` and no reason at all, so telemetry
 * could not tell whether a run of declines was ONE cause or several: reading `head` alone cannot
 * distinguish a well-formed run branch that claims the WRONG task (`run-W1-T172-<epochMs>`,
 * refused for a different id — two of the seven rows this host's ledger has ever recorded) from
 * one that is not a run branch at all, because the row does not carry the task id being fixed.
 * Both read as "an odd branch name" and neither is actionable.
 *
 * DELIBERATELY A SECOND, INDEPENDENT DERIVATION rather than a value threaded out of
 * {@link fixHeadAcceptable}: it consults that predicate as an ORACLE first and reports
 * `"unclassified"` — never a guess — whenever the predicate says the head IS acceptable and this
 * classifier therefore has no refusal to explain. That is the catch-all's whole purpose: it is
 * reachable ONLY when the two disagree, so a future change to `fixHeadAcceptable` that this
 * function is not taught about surfaces in telemetry as an honest "unattributed" rather than as a
 * confidently wrong cause. It is named to read that way on a dashboard.
 */

/**
 * The reasons, exhaustive over today's predicate:
 *   - `head_unresolved`    — `gh pr view` resolved no `headRefName`. The SAME `!head` case the
 *                            predicate's own first guard refuses, and the one the call site's
 *                            `!realBranch` arm reaches without ever calling the predicate.
 *   - `foreign_run_branch` — the head IS `run-<id>-<epochMs>` ({@link isDispatchedRunBranch}) but
 *                            not THIS task's own. Reachable under BOTH `synthetic` values, and the
 *                            only one reachable when `synthetic` is true: a synthetic PR whose head
 *                            claims some other task is MIS-TRAILERED, not task-less.
 *   - `not_a_run_branch`   — the head is not run-shaped at all (`fix/…`, `feat/…`). Reachable ONLY
 *                            when `synthetic` is false, because the predicate ACCEPTS exactly this
 *                            shape for a synthetic PR — so a `not_a_run_branch` row carrying
 *                            `synthetic: true` is by construction impossible and would itself be a
 *                            signal worth reading.
 *   - `unclassified`       — see above. Never a real cause.
 *
 * Pure, synchronous, no clock and no I/O — unit-testable against the same fixtures
 * `fixHeadAcceptable`'s own tests use. Changes NOTHING about WHEN the rung declines: the call
 * site's guard is untouched and this runs only after that guard has already fired.
 */
export type UncreditableHeadReason = "head_unresolved" | "foreign_run_branch" | "not_a_run_branch" | "unclassified";

export function uncreditableHeadReason(
  head: string | undefined,
  taskId: string,
  synthetic: boolean,
): UncreditableHeadReason {
  if (!head) return "head_unresolved";
  if (fixHeadAcceptable(head, taskId, synthetic)) return "unclassified";
  return isDispatchedRunBranch(head) ? "foreign_run_branch" : "not_a_run_branch";
}

const TERMINAL_UNCREDITABLE_HEAD_STEP = "sweep.fix.uncreditable_head";
/** W1-T3168: a foreign-head decline that did NOT escalate because the PR is not stuck. Ledgered so
 *  the suppression is legible — "we saw this and chose not to page you" must be greppable. */
const TERMINAL_UNCREDITABLE_HEAD_HEALTHY_STEP = "sweep.terminal_head.not_stuck";
const TERMINAL_UNCREDITABLE_HEAD_ESCALATED_STEP = "sweep.fix.uncreditable_head_escalated";
const TERMINAL_UNCREDITABLE_HEAD_PATTERN =
  '"step":"sweep\\.fix\\.uncreditable_head"|"step":"sweep\\.fix\\.uncreditable_head_escalated"';

/**
 * W1-T3168 — is a foreign-head PR actually STUCK, or merely not fleet-owned?
 *
 * The fix rung refuses a branch it does not own (W1-T296) and that refusal is correct. What did
 * NOT follow is that a human must be interrupted: "the rung declines to act on this PR" and "a
 * person must decide something about this PR" are different statements, and the producer collapsed
 * them. MEASURED 2026-09-08: issues #4623 and #4624 asked the operator to discard PRs #4619 and
 * #4621 minutes after they opened, both healthy; #4621 then merged on its own.
 *
 * STUCK is read off the rollup {@link OpenPrView} already carries — no extra GitHub read: required
 * checks RED, or a review that has come back FAILURE. Anything else that is positively healthy
 * (checks green or still running, review not failing) is a PR whose author is presumably still
 * working, which is the ordinary case for every operator-authored and every human contribution.
 *
 * INDETERMINATE ESCALATES. `"none"` on both is not evidence of health — it is the absence of
 * evidence, and it takes the same fail-open direction `EscalationReconcileCandidate.indeterminate`
 * already takes ("treat as neither resolved nor live").
 */
export function foreignHeadIsStuck(pr: Pick<OpenPrView, "reviewState" | "checksState">): boolean {
  if (pr.checksState === "red") return true;
  if (pr.reviewState === "failure") return true;
  // Positively healthy: checks are green or still running AND the review has not failed.
  if (pr.checksState === "green" || pr.checksState === "pending") return false;
  return true; // checksState "none" — unreadable, not healthy
}

interface TerminalUncreditableHead {
  prNumber: number;
  headSha: string;
  head: string;
  taskId: string;
  cause: "review" | "ci" | "conflict";
  escalated: boolean;
}

/**
 * W1-T2723 — process-lifetime index of terminal, head-SHA-keyed fix-rung declines. The first
 * lookup after a daemon boot reconstructs it from archive∪live ledger history; later sweep-effect
 * instances reuse the compact map and update it synchronously when they emit a new terminal row.
 * Rotation is therefore harmless without decompressing the full corpus on every poll.
 */
const terminalUncreditableHeadsByLedger = new Map<string, Map<string, TerminalUncreditableHead>>();

function terminalUncreditableHeadKey(prNumber: number, headSha: string): string {
  return `${prNumber}:${headSha}`;
}

function terminalUncreditableHeads(ledgerPath: string): Map<string, TerminalUncreditableHead> {
  const cached = terminalUncreditableHeadsByLedger.get(ledgerPath);
  if (cached) return cached;

  const union = resolveLedgerUnion(dirname(ledgerPath), TERMINAL_UNCREDITABLE_HEAD_PATTERN);
  // A fresh fixture/installation has no rotations. In that one case, use the live ledger; once
  // rotations exist, only a complete archive∪live union is accepted so a rotated terminal marker
  // can never silently disappear and re-enable the GraphQL loop.
  const rows = union.ok
    ? parseLedger(union.matches.join("\n"))
    : union.archiveCount === 0
      ? readLedgerLines(ledgerPath)
      : [];
  const terminals = new Map<string, TerminalUncreditableHead>();
  for (const row of rows) {
    if (
      row.step !== TERMINAL_UNCREDITABLE_HEAD_STEP ||
      row.reason !== "not_a_run_branch" ||
      row.terminal !== true ||
      typeof row.pr_number !== "number" ||
      typeof row.head_sha !== "string" ||
      typeof row.head !== "string" ||
      typeof row.repair_task_id !== "string" ||
      (row.cause !== "review" && row.cause !== "ci" && row.cause !== "conflict")
    ) {
      continue;
    }
    terminals.set(terminalUncreditableHeadKey(row.pr_number, row.head_sha), {
      prNumber: row.pr_number,
      headSha: row.head_sha,
      head: row.head,
      taskId: row.repair_task_id,
      cause: row.cause,
      escalated: false,
    });
  }
  for (const row of rows) {
    if (
      row.step !== TERMINAL_UNCREDITABLE_HEAD_ESCALATED_STEP ||
      typeof row.pr_number !== "number" ||
      typeof row.head_sha !== "string"
    ) {
      continue;
    }
    const terminal = terminals.get(terminalUncreditableHeadKey(row.pr_number, row.head_sha));
    if (terminal) terminal.escalated = true;
  }
  terminalUncreditableHeadsByLedger.set(ledgerPath, terminals);
  return terminals;
}

/**
 * W1-T2402: does `e` — whatever `dispatchFix`'s catch just caught — carry a SIGNAL TERMINATION,
 * and if so what is known about what the killed spawn spent? Read STRUCTURALLY off the error
 * object's own `signal`/`costUsd` properties, never by string-matching the free-text `.message`
 * a caller would otherwise have to grep for "terminated by signal SIGKILL" — the SDK's own
 * wording (`@anthropic-ai/claude-agent-sdk`'s `sdk.mjs`: `getProcessExitError` builds
 * `Error("Claude Code process terminated by signal " + signal + …)` and its own `_n` helper
 * `Object.assign`s `{signal, errorClass: "process_killed_by_signal", telemetryMessage}` directly
 * onto that `Error` before rejecting with it). That literal string appears nowhere in this
 * repo's own source, so reading it by substring would be exactly the class of misread this repo
 * has already been burned by twice (`fallback_push` matching a prose mention, `credential_expired`
 * matching 191 unrelated `containment.probe` rows) — LEARNINGS. The SDK's own error propagates
 * unwrapped up through `collectWorkerResult`'s `if (!sawResult) throw err` and `spawnWorker`'s own
 * pass-through catch (worker.ts) whenever ITS OWN clock-bound watchdog did not itself trip, so the
 * `signal` property really does survive, unaltered, all the way to this catch.
 */

/**
 * THE SIGNAL ALONE NEVER DECIDES ANYTHING (the shard's own correction to its brief): this fleet
 * sends itself the identical `SIGKILL` from at least three of its OWN paths (`killProcessGroup`'s
 * default, `deployer.ts`'s forced-deploy kickstart, W1-T1044's wall-clock reclaim) — so this
 * function only ever RECORDS the signal, structurally; it does not classify who sent it, and (see
 * {@link dispatchFixCatchOutcome}) it never changes whether the strike this call already spent
 * gets swallowed or propagated.
 *
 * `undefined` for an ordinary in-process failure (a failed `git`, a missing binary, a bad `gh`
 * response) that carries no such field — the existing, unchanged `sweep.fix.error` shape.
 */
export function fixDispatchSignalDeath(e: unknown): { signal: string; costUsd: number } | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const signal = (e as { signal?: unknown }).signal;
  if (typeof signal !== "string" || signal.length === 0) return undefined;
  const costUsd = (e as { costUsd?: unknown }).costUsd;
  // W1-T2402 Q2(a): `0` — never guessed higher — is the honest floor when the kill lands before
  // any SDK result envelope ever arrives, which is what every real signal kill on this fleet's
  // own spawn path does: `collectWorkerResult` only ever populates a cost figure off a
  // `type:"result"` envelope, and a pre-envelope throw means that envelope never arrived, so
  // there is nothing truthful to report beyond zero. Reads an explicit numeric `.costUsd` off
  // `e` when one IS present — forward-compatible with a future caller that does carry one — so
  // this never regresses once that becomes available; never guessed otherwise.
  return { signal, costUsd: typeof costUsd === "number" ? costUsd : 0 };
}

/**
 * W1-T2444 — THE THREE PREDICATES, READ OFF `dispatchFix`'s OWN CATCH, NOT RE-DERIVED FROM A
 * LEDGER SWEEP. `sweep.fix.error` today is 135 historical rows that split 55/42/38 across a
 * shared worker home (W1-T2441), a shared `.git/config` lock (`checkout -B` contention across
 * concurrent sweep worktrees), and GitHub GraphQL rate-limit exhaustion — three unrelated
 * defects with DISJOINT windows, so no rate anyone quotes off the bare step name describes a
 * single real process. This function is the classifier, so a future rate can name its class
 * instead of averaging over silence.
 *
 * ORDER MATTERS, first match wins, same order the ledger sweep used to derive the 55/42/38 split:
 *   1. a signal death — read STRUCTURALLY off `signalDeath`, never by matching "SIGKILL" in the
 *      free-text message (the same trap {@link fixDispatchSignalDeath}'s own doc closes) — is
 *      `"sigkill"`.
 *   2. `Command failed: git … checkout -B …` (the linked-worktree writing upstream-tracking
 *      config into the CANONICAL clone's `.git/config`, and losing the lock race) is
 *      `"checkout_b"`.
 *   3. `Command failed: gh pr view …` (37 of 38 in the historical corpus were the primary
 *      GraphQL budget; the 38th an unrelated `HTTP 503` this same predicate happens to cover) is
 *      `"gh_pr_view"`.
 * Anything else is left OUT of `ledgerFields` entirely — never forced into a class, never
 * written as the string `"unclassified"` — because a fourth cause existing tomorrow must not
 * silently misreport as one of today's three.
 */
export function fixDispatchErrorClass(
  message: string,
  signalDeath: { signal: string; costUsd: number } | undefined,
): string | undefined {
  if (signalDeath) return "sigkill";
  if (/Command failed: git\b.*\bcheckout -B\b/.test(message)) return "checkout_b";
  if (/Command failed: gh pr view\b/.test(message)) return "gh_pr_view";
  return undefined;
}

/**
 * W1-T2402: the WHOLE of `dispatchFix`'s catch decision, pulled out pure so every branch is
 * unit-testable without spawning anything. `ledgerFields` is what `sweep.fix.error` gets spread
 * with — the existing `error` string PLUS `signal`/`cost_usd` when {@link fixDispatchSignalDeath}
 * finds them, PLUS (W1-T2444) `class` when {@link fixDispatchErrorClass} recognises the failure —
 * the SAME conditional-spread shape `signal`/`cost_usd` already established, not a new
 * convention. `rethrow` mirrors W1-T1127's OWN `dispatchStarted` rule byte-for-byte and
 * UNCHANGED by this task: a strike already spent (`dispatchStarted`) keeps this swallowed here so
 * `runSweep` keeps recording `acted:true`, exactly as it does today; a failure before any strike
 * still propagates to `runSweep`'s own `catch`, which already records `acted:false`. Nothing here
 * paces, throttles, sleeps, or awaits — it is synchronous, and reads no clock. No new ledger step
 * is introduced — this is still written under `sweep.fix.error`, unchanged, so
 * `DECISION_RELEVANT_LEDGER_STEPS` (lib/ledger.ts) needs no update.
 */
export function dispatchFixCatchOutcome(e: unknown, dispatchStarted: boolean): { ledgerFields: Record<string, unknown>; rethrow: boolean } {
  const signalDeath = fixDispatchSignalDeath(e);
  const message = String((e as Error)?.message ?? e);
  const errorClass = fixDispatchErrorClass(message, signalDeath);
  return {
    ledgerFields: {
      error: message,
      ...(signalDeath ? { signal: signalDeath.signal, cost_usd: signalDeath.costUsd } : {}),
      ...(errorClass ? { class: errorClass } : {}),
    },
    rethrow: !dispatchStarted,
  };
}


type SweepRuntimeFn = (...args: any[]) => any;
type SweepRuntimeCtor = new (...args: any[]) => any;
type RegisteredFixOwnerSnapshot = any;
type RollupCheck = RollupCheckEntry;

function requiredSweepRuntime<T extends SweepRuntimeFn>(name: string): T {
  return ((..._args: Parameters<T>) => {
    throw new Error(`buildSweepEffects requires ${name} from its entrypoint adapter`);
  }) as unknown as T;
}

export function requiredSweepRuntimeCtor<T extends SweepRuntimeCtor>(name: string): T {
  return (class {
    constructor() {
      throw new Error(`buildSweepEffects requires ${name} from its entrypoint adapter`);
    }
  }) as unknown as T;
}

function prNumberFromRef(ref: string): number | undefined {
  const urlMatch = ref.match(/\/pull\/(\d+)/);
  if (urlMatch) return Number(urlMatch[1]);
  const bareMatch = ref.match(/#?(\d+)/);
  return bareMatch ? Number(bareMatch[1]) : undefined;
}

function armAndLogOutcome(
  prUrl: string,
  taskId: string | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
  arm: (prUrl: string, taskId: string | undefined) => ArmOutcome | ArmAttemptResult = armAutoMergeDetailed,
  lane: ArmLane = "operator",
  headSha?: string,
): ArmOutcome {
  const result = arm(prUrl, taskId);
  const outcome = typeof result === "string" ? result : result.outcome;
  const error = typeof result === "string" ? undefined : result.error;
  const rateLimit = typeof result === "string" ? undefined : result.rateLimit;
  const directMergePreflight = typeof result === "string" ? undefined : result.directMergePreflight;
  logArmAttribution(
    log,
    outcome,
    prUrl,
    taskId,
    lane,
    { ...(error !== undefined ? { outcome, error } : { outcome }), ...(headSha !== undefined ? { head_sha: headSha } : {}) },
    rateLimit,
    directMergePreflight,
  );
  return outcome;
}

export function sweepArmAttemptOutcome(
  outcome: ArmOutcomeName,
  attemptError: string | undefined,
): ArmOutcomeName | ArmAttemptOutcome {
  if (outcome !== "arm-error-ignored" || attemptError === undefined) return outcome;
  const failureClass = armFailureAction(attemptError);
  if (failureClass === "direct-merge") return outcome;
  return { outcome, failureClass };
}

export interface RegisteredFixOwnerRecoveryDeps {
  capture: SweepRuntimeFn;
  remove: SweepRuntimeFn;
  publishAhead?: SweepRuntimeFn;
  preserveDiverged?: SweepRuntimeFn;
}

export interface BuildSweepEffectsDeps {
  owner: string;
  repo: string;
  repoRoot?: string;
  localRepoName?: string;
  nowMsImpl?: () => number;
  config: Config;
  ledgerPath: string;
  runId: string;
  plan: Plan;
  log: (step: string, extra?: Record<string, unknown>) => void;
  policy?: SweepPolicy;
  reviewRunner?: (prNumber: number, isPlanFiling?: boolean) => Promise<number>;
  /** The command the DEFAULT `reviewRunner` above calls. Separate from `reviewRunner` on purpose:
   *  overriding `reviewRunner` replaces the default outright and leaves its opt-in untested, while
   *  this seam keeps the default arm itself — the one that names `executionMode: "semantic"` — as
   *  the code under test. Omitted, it is `reviewCommand`. */
  reviewCommandImpl?: (
    pr: string,
    args: string[],
    opts: { executionMode: "semantic"; planOnlyFiling?: boolean },
  ) => Promise<number>;
  spawnImpl?: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
  pushEmptyCommit?: typeof gitPushEmptyCommit;
  issuesImpl?: IssueGateway;
  stallNotice?: (
    verdict: PostReviewStallVerdict,
    ctx: { owner: string; repo: string; ledgerPath: string; runId: string; issues?: IssueGateway },
  ) => void;
  armImpl?: (prUrl: string, taskId: string | undefined) => ArmOutcome | ArmAttemptResult;
  armSessionPrsOverride?: boolean;
  updateBranchImpl?: (pr: ArmedStalledPr) => Promise<UpdateBranchOutcome>;
  rebaseDirtyFleetBranchImpl?: (pr: OpenPrView) => DirtyFleetRebaseOutcome | Promise<DirtyFleetRebaseOutcome>;
  captureRepairFeedbackImpl?: (filing: RepairFilingCapture) => void;
  ghRunImpl?: (file: string, args: readonly string[]) => void;
  spawnWallClockBoundMsOverride?: number;
  reclaimWorkerImpl?: (info: { runId: string; taskId: string; elapsedMs: number }) => void | Promise<void>;
  disarmImpl?: (prUrl: string) => DisarmOutcome | void;
  readJsonImpl?: (args: string[]) => Promise<unknown>;
  /** Shared pacer; omitted for the existing immediate CLI/test mode. */
  pacer?: GhCallPacer;
  fetchWorkflowRunObservationsImpl?: typeof fetchWorkflowRunObservations;
  /** W1-T3283 — the body write the trailer-repair effect performs. Injectable for the SAME reason
   *  `deps.updatePrBody` already is at this file's two other body-write sites: the effect is a thin
   *  wrapper around one network call, so without a seam the only way to cover it is to make a real
   *  one. Production supplies the entrypoint's GitHub body writer. */
  updatePrBodyImpl?: (prUrl: string, body: string) => Promise<void>;
  registeredWorktreeOwnerImpl?: (repoDir: string, branchRef: string) => string | undefined;
  registeredOwnerRecovery?: RegisteredFixOwnerRecoveryDeps;
  depReviewCommandImpl?: (prArg: string, rest?: string[]) => Promise<number>;
  dispatchFixPreflightStandDownImpl?: SweepRuntimeFn;
  ghLiveStateImpl?: SweepRuntimeFn;
  fixRungTaskForImpl?: typeof fixRungTaskFor;
  createFixRungWorktreeImpl?: SweepRuntimeFn;
  captureWorktreeSnapshotImpl?: SweepRuntimeFn;
  runFixRungImpl?: SweepRuntimeFn;
  buildFixRungDispatchArgsImpl?: SweepRuntimeFn;
  openTaskIdsFromPlanImpl?: SweepRuntimeFn;
  waitForCiGreenImpl?: SweepRuntimeFn;
  restRollupForImpl?: SweepRuntimeFn;
  fetchCiFailuresImpl?: SweepRuntimeFn;
  runReviewImpl?: SweepRuntimeFn;
  fetchPrBodyImpl?: SweepRuntimeFn;
  readHeadShaImpl?: SweepRuntimeFn;
  ghLiveHeadImpl?: SweepRuntimeFn;
  fetchPrDiffFilesImpl?: SweepRuntimeFn;
  fixRebaseMergeFactsImpl?: SweepRuntimeFn;
  redBaseRefreshFactsImpl?: SweepRuntimeFn;
  ghUpdateBranchImpl?: SweepRuntimeFn;
  readFixRoundCommitsImpl?: SweepRuntimeFn;
  runNpmScriptImpl?: SweepRuntimeFn;
  commitGeneratorOutputImpl?: SweepRuntimeFn;
  readPackageScriptsImpl?: SweepRuntimeFn;
  dispatchFixCatchOutcomeImpl?: typeof dispatchFixCatchOutcome;
  worktreeRemoveImpl?: typeof worktreeRemove;
  fixBranchClaimKeyImpl?: SweepRuntimeFn;
  boundedWorktreeOwnerPathImpl?: SweepRuntimeFn;
  decideRegisteredFixOwnerRecoveryImpl?: SweepRuntimeFn;
  fixRungCheckoutRefusedErrorImpl?: SweepRuntimeCtor;
  defaultBudgetUsd?: number;
}

/**
 * The default `gh` invocation for {@link buildSweepEffects}' `ghRunImpl` seam — a NAMED function
 * rather than an inline default so it is reachable by a test at all. Its one caller closes a pull
 * request, so a test that drove it through the effect would have to close one; called directly
 * with a harmless argv it exercises the same statement and proves the seam's default is the real
 * spawn rather than a stub that quietly does nothing.
 */
export function defaultSweepGhRun(file: string, args: readonly string[]): void {
  execFileSync(file, [...args], { stdio: "pipe" });
}

/**
 * The words a failed `git` spawn actually printed, for the `reason` these outcomes carry.
 *
 * `execFileSync`'s Error.message is only `Command failed: <the argv>` — it restates what we already
 * know and drops what git said. The diagnosis is on `.stderr`, which `stdio: "pipe"` captured.
 * MEASURED on #4946: a rebase that failed because no committer identity was configured reported
 * `conflict` with reason "Command failed: git -C … rebase origin/main", so a CI log showed
 * `+ 'conflict' - 'rebased'` and nothing about the cause; git's own "Please tell me who you are"
 * was sitting in a field nobody read. Falls back to the message when stderr is empty, so this can
 * only ever add detail.
 */
function spawnFailureText(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown };
  const stderrText = e?.stderr === undefined || e?.stderr === null ? "" : String(e.stderr).trim();
  return stderrText.length > 0 ? stderrText : String(e?.message ?? error);
}

export type DirtyFleetRebaseOutcome =
  | { outcome: "rebased"; oldHeadSha: string; newHeadSha: string }
  | { outcome: "conflict"; reason: string }
  | { outcome: "lease-mismatch"; reason: string }
  | { outcome: "error"; reason: string };

type DirtyFleetRebaseGit = (
  file: string,
  args: readonly string[],
  opts?: { cwd?: string; stdio?: "pipe" | "ignore"; encoding?: BufferEncoding },
) => string;

function dirtyFleetRebaseStoppedOnConflict(
  worktreePath: string,
  run: (cwd: string, args: readonly string[]) => string,
): boolean {
  try {
    const rebaseStateExists = ["rebase-merge", "rebase-apply"].some((stateDir) => {
      const statePath = run(worktreePath, ["rev-parse", "--git-path", stateDir]).trim();
      return statePath.length > 0 && existsSync(statePath);
    });
    if (!rebaseStateExists) return false;
    return run(worktreePath, ["ls-files", "-u"]).trim().length > 0;
  } catch (_inspectionError) {
    // If the rebase failure also makes git's state unreadable, keep the legacy conflict path.
    return true;
  }
}

function defaultDirtyFleetRebaseGit(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; stdio?: "pipe" | "ignore"; encoding?: BufferEncoding } = {},
): string {
  return execFileSync(file, [...args], {
    cwd: opts.cwd,
    encoding: opts.encoding ?? "utf8",
    stdio: opts.stdio ?? "pipe",
    maxBuffer: 1 << 24,
  }) as string;
}

export function rebaseDirtyFleetBranchViaGit(
  repoDir: string,
  worktreePath: string,
  pr: Pick<OpenPrView, "prNumber" | "headRefName" | "headSha">,
  deps: { git?: DirtyFleetRebaseGit; worktreeRemoveImpl?: typeof worktreeRemove } = {},
): DirtyFleetRebaseOutcome {
  const branch = pr.headRefName;
  if (!branch) return { outcome: "error", reason: `PR #${pr.prNumber} has no headRefName to rebase` };
  const git = deps.git ?? defaultDirtyFleetRebaseGit;
  const remove = deps.worktreeRemoveImpl ?? worktreeRemove;
  const ref = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const run = (cwd: string, args: readonly string[]): string => git("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
  let worktreeCreated = false;
  try {
    mkdirSync(dirname(worktreePath), { recursive: true });
    run(repoDir, [
      "fetch",
      "--no-tags",
      "--quiet",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
      `+${ref}:${remoteRef}`,
    ]);
    const observedHead = run(repoDir, ["rev-parse", remoteRef]).trim();
    if (observedHead !== pr.headSha) {
      return {
        outcome: "lease-mismatch",
        reason: `origin/${branch} moved from ${pr.headSha} to ${observedHead} before the rebase started`,
      };
    }
    run(repoDir, ["worktree", "add", "--detach", worktreePath, pr.headSha]);
    worktreeCreated = true;
    try {
      run(worktreePath, ["rebase", "origin/main"]);
    } catch (error) {
      const reason = capStderrExcerpt(spawnFailureText(error), STDERR_EXCERPT_CAP);
      const stoppedOnConflict = dirtyFleetRebaseStoppedOnConflict(worktreePath, run);
      if (!stoppedOnConflict) return { outcome: "error", reason };
      try {
        run(worktreePath, ["rebase", "--abort"]);
      } catch {
        /* best-effort cleanup before the worktree is removed below */
      }
      return {
        outcome: "conflict",
        reason,
      };
    }
    const newHeadSha = run(worktreePath, ["rev-parse", "HEAD"]).trim();
    assertLiveWriteAllowed("git-push", `rebasing dirty fleet branch ${branch} for PR #${pr.prNumber}`);
    try {
      run(worktreePath, ["push", `--force-with-lease=${ref}:${pr.headSha}`, "origin", `HEAD:${ref}`]);
    } catch (error) {
      return {
        outcome: "lease-mismatch",
        reason:
          `force-with-lease refused ${branch}: expected ${pr.headSha}, attempted ${newHeadSha}; ` +
          capStderrExcerpt(spawnFailureText(error), STDERR_EXCERPT_CAP),
      };
    }
    const observedRemote = run(worktreePath, ["ls-remote", "origin", ref]).trim().split(/\s+/)[0];
    if (observedRemote !== newHeadSha) {
      return {
        outcome: "lease-mismatch",
        reason: `force-with-lease push reported success, but ${ref} reads ${observedRemote || "<absent>"} instead of ${newHeadSha}`,
      };
    }
    return { outcome: "rebased", oldHeadSha: pr.headSha, newHeadSha };
  } catch (error) {
    return {
      outcome: "error",
      reason: capStderrExcerpt(spawnFailureText(error), STDERR_EXCERPT_CAP),
    };
  } finally {
    if (worktreeCreated) {
      try {
        remove(repoDir, worktreePath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export function buildSweepEffects(deps: BuildSweepEffectsDeps): Pick<
  SweepDeps,
  | "arm"
  | "close"
  | "dispatchFix"
  | "escalate"
  | "readLiveState"
  | "terminalFixStandDown"
  | "readRedBaseRefreshFacts"
  | "depReview"
  | "postReview"
  | "repushAbsent"
  | "updateBranch"
  | "captureRepairFeedback"
  | "disarmAutoMerge"
  | "requeueCheck"
  | "escalateCancelledCheck"
  | "escalateInfrastructureCheck"
  | "readCiGateRollup"
  | "reaggregateCiGate"
  | "readMainTip"
  | "readMainRepair"
  | "readStaleRedWorkflowRuns"
  | "runStaleRedLocalRoute"
  | "releaseStaleRed"
  | "releaseBaseCausedStandDown"
  | "rebaseDirtyFleetBranch"
  | "selectAdaptiveReviewWidth"
  | "repairMissingTaskTrailer"
> {
  const {
    owner,
    repo,
    config,
    repoRoot: entrypointRepoRoot = config.root,
    localRepoName = repo,
    nowMsImpl = () => Number(new globalThis.Date()),
    ledgerPath,
    runId,
    plan,
    log,
    policy = DEFAULT_SWEEP_POLICY,
    spawnImpl,
    pushEmptyCommit = gitPushEmptyCommit,
    issuesImpl,
    stallNotice = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["stallNotice"]>>("stallNotice"),
    armImpl = armAutoMergeDetailed,
    armSessionPrsOverride,
    updateBranchImpl = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["updateBranchImpl"]>>("updateBranchImpl"),
    rebaseDirtyFleetBranchImpl,
    captureRepairFeedbackImpl = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["captureRepairFeedbackImpl"]>>("captureRepairFeedbackImpl"),
    ghRunImpl = defaultSweepGhRun,
    spawnWallClockBoundMsOverride,
    reclaimWorkerImpl = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["reclaimWorkerImpl"]>>("reclaimWorkerImpl"),
    disarmImpl = disarmAutoMerge,
    readJsonImpl = ghJsonAsync,
    pacer,
    fetchWorkflowRunObservationsImpl: fetchWorkflowRunObservationsForBuild = fetchWorkflowRunObservations,
    registeredWorktreeOwnerImpl = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["registeredWorktreeOwnerImpl"]>>("registeredWorktreeOwnerImpl"),
    reviewCommandImpl = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["reviewCommandImpl"]>>("reviewCommandImpl"),
    registeredOwnerRecovery = {
      capture: requiredSweepRuntime("registeredOwnerRecovery.capture"),
      remove: requiredSweepRuntime("registeredOwnerRecovery.remove"),
    },
    depReviewCommandImpl: depReviewCommand = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["depReviewCommandImpl"]>>("depReviewCommandImpl"),
    dispatchFixPreflightStandDownImpl: dispatchFixPreflightStandDown = requiredSweepRuntime("dispatchFixPreflightStandDownImpl"),
    ghLiveStateImpl: ghLiveState = requiredSweepRuntime("ghLiveStateImpl"),
    fixRungTaskForImpl: fixRungTaskForForBuild = fixRungTaskFor,
    createFixRungWorktreeImpl: createFixRungWorktree = requiredSweepRuntime("createFixRungWorktreeImpl"),
    captureWorktreeSnapshotImpl: captureWorktreeSnapshotViaGit = requiredSweepRuntime("captureWorktreeSnapshotImpl"),
    runFixRungImpl: runFixRung = requiredSweepRuntime("runFixRungImpl"),
    buildFixRungDispatchArgsImpl: buildFixRungDispatchArgs = requiredSweepRuntime("buildFixRungDispatchArgsImpl"),
    openTaskIdsFromPlanImpl: openTaskIdsFromPlan = requiredSweepRuntime("openTaskIdsFromPlanImpl"),
    waitForCiGreenImpl: waitForCiGreen = requiredSweepRuntime("waitForCiGreenImpl"),
    restRollupForImpl: restRollupFor = requiredSweepRuntime("restRollupForImpl"),
    fetchCiFailuresImpl: fetchCiFailures = requiredSweepRuntime("fetchCiFailuresImpl"),
    runReviewImpl: runReview = requiredSweepRuntime("runReviewImpl"),
    fetchPrBodyImpl: fetchPrBodyViaGh = requiredSweepRuntime("fetchPrBodyImpl"),
    readHeadShaImpl: readHeadShaRest = requiredSweepRuntime("readHeadShaImpl"),
    ghLiveHeadImpl: ghLiveHead = requiredSweepRuntime("ghLiveHeadImpl"),
    fetchPrDiffFilesImpl: fetchPrDiffFilesViaGh = requiredSweepRuntime("fetchPrDiffFilesImpl"),
    fixRebaseMergeFactsImpl: fixRebaseMergeFactsFromRest = requiredSweepRuntime("fixRebaseMergeFactsImpl"),
    redBaseRefreshFactsImpl: redBaseRefreshFactsFromRest = requiredSweepRuntime("redBaseRefreshFactsImpl"),
    ghUpdateBranchImpl: ghUpdateBranch = requiredSweepRuntime("ghUpdateBranchImpl"),
    readFixRoundCommitsImpl: readFixRoundCommitsViaGit = requiredSweepRuntime("readFixRoundCommitsImpl"),
    runNpmScriptImpl: runNpmScriptViaSpawn = requiredSweepRuntime("runNpmScriptImpl"),
    commitGeneratorOutputImpl: commitGeneratorOutputViaGit = requiredSweepRuntime("commitGeneratorOutputImpl"),
    readPackageScriptsImpl: readPackageScriptsFor = requiredSweepRuntime("readPackageScriptsImpl"),
    dispatchFixCatchOutcomeImpl: dispatchFixCatchOutcomeForBuild = dispatchFixCatchOutcome,
    worktreeRemoveImpl: worktreeRemoveForBuild = worktreeRemove,
    fixBranchClaimKeyImpl: fixBranchClaimKey = requiredSweepRuntime("fixBranchClaimKeyImpl"),
    boundedWorktreeOwnerPathImpl: boundedWorktreeOwnerPath = requiredSweepRuntime("boundedWorktreeOwnerPathImpl"),
    decideRegisteredFixOwnerRecoveryImpl: decideRegisteredFixOwnerRecovery = requiredSweepRuntime("decideRegisteredFixOwnerRecoveryImpl"),
    fixRungCheckoutRefusedErrorImpl: FixRungCheckoutRefusedError = requiredSweepRuntimeCtor("fixRungCheckoutRefusedErrorImpl"),
    defaultBudgetUsd = 100,
    updatePrBodyImpl = requiredSweepRuntime<NonNullable<BuildSweepEffectsDeps["updatePrBodyImpl"]>>("updatePrBodyImpl"),
  } = deps;

  // W1-T2889: kept as a typed local (not a destructured default) so this default arm's shape
  // survives the positional-parameters-to-one-deps-object collapse verbatim — the sweep's
  // post-review lane still routes through reviewCommand, and nothing but `deps.reviewRunner`
  // can override it.
  let reviewRunner: (prNumber: number, isPlanFiling?: boolean) => Promise<number> = (prNumber, isPlanFiling) =>
    reviewCommandImpl(String(prNumber), ["--repo", repo], {
      executionMode: "semantic",
      planOnlyFiling: isPlanFiling,
    });
  if (deps.reviewRunner) reviewRunner = deps.reviewRunner;

  const repoDir = repo === localRepoName ? entrypointRepoRoot : join(config.root, "repos", repo);
  const repoRoot = entrypointRepoRoot;
  // W1-T2609: the SAME per-task lock directory `liveInflightRuns`/`acquireInflightLock` already
  // use everywhere else in this file (see e.g. sweepCommand's own `inflightDir`, above) — the fix
  // rung's per-(repo, branch) exclusive claim (dispatchFix, below) reuses this directory rather
  // than a second lock location.
  const inflightDir = join(config.root, "state", "inflight");
  const issues = issuesImpl ?? ghIssueGateway(owner, repo);
  const terminalHeads = terminalUncreditableHeads(ledgerPath);
  const escalateTerminalHead = (terminal: TerminalUncreditableHead, pr?: Pick<OpenPrView, "reviewState" | "checksState">): void => {
    if (terminal.escalated) return;
    // W1-T3168: the ownership fact alone is not an ask. A foreign head on a PR that is not stuck
    // needs no decision from anyone today, so it is LEDGERED and not escalated — never silently
    // dropped, because a suppressed ask nobody can see is the defect this repo keeps re-finding.
    // `pr` absent means the caller could not supply a rollup, which is indeterminate: escalate.
    if (pr && !foreignHeadIsStuck(pr)) {
      log(TERMINAL_UNCREDITABLE_HEAD_HEALTHY_STEP, {
        pr_number: terminal.prNumber,
        head_sha: terminal.headSha,
        review_state: pr.reviewState,
        checks_state: pr.checksState,
      });
      return;
    }
    const prUrl = `https://github.com/${owner}/${repo}/pull/${terminal.prNumber}`;
    const issueUrl = tryEscalate(
      {
        class: "BLOCKED",
        taskId: terminal.taskId,
        runId,
        headSha: terminal.headSha,
        headDedup: "independent",
        cause: terminal.cause,
        summary: `PR ${prUrl} cannot be repaired from its non-fleet head`,
        detail:
          `The fix rung correctly refused branch ${terminal.head} at head ${terminal.headSha}: it is not this task's ` +
          `fleet-owned run branch. Re-running the rung cannot change that ownership fact and would only repeat the ` +
          `same GitHub read. The PR needs a new task-owned implementation or a manual resolution.`,
        options: [
          {
            label: "supersede",
            detail: "replace this PR with an implementation on the task's fleet-owned run branch, then close the blocked PR.",
          },
          {
            label: "manual-resolution",
            detail: "repair or merge the existing PR manually while leaving the fleet's foreign-head guard intact.",
          },
        ],
        recommendation: "supersede",
        consequence: "The PR remains red and outside the fix rung's safe ownership boundary until a human chooses a resolution.",
      },
      { issues, ledgerPath, runId },
    );
    if (!issueUrl) return;
    terminal.escalated = true;
    log(TERMINAL_UNCREDITABLE_HEAD_ESCALATED_STEP, {
      pr_number: terminal.prNumber,
      head_sha: terminal.headSha,
      issue_url: issueUrl,
    });
  };
  const say = (msg: string) => console.error(`### rmd sweep — ${msg}`);
  // Defaults to the LIVE `plan/policy.yaml` flag (`loadDefaultPolicy`, the same memoized-per-
  // process reader every other W1-T253 consumer site uses) so production wiring picks up an
  // operator's edit with no code change; a test overrides `armSessionPrsOverride` directly to
  // drive both sides of the gate without writing a fixture policy file.
  const armSessionPrs = armSessionPrsOverride ?? loadDefaultPolicy().values.sweep.armSessionPrs;
  // W1-T1219: this fix-rung worker-spawn bound reads its OWN `plan/policy.yaml` row,
  // `fixSpawnWallClockBoundMs` — split off `sweepWallClockBoundMs` (which `daemonCommand`'s
  // `DaemonOpts.sweepWallClockBoundMs` still reads for the daemon-side sweep-tick bound) because
  // a sweep tick and this implement-class worker spawn are different populations; see that
  // field's own plan/policy.yaml row for the full derivation.
  const spawnWallClockBoundMs = spawnWallClockBoundMsOverride ?? loadDefaultPolicy().values.fixSpawnWallClockBoundMs;
  // W1-T516 — an `armImpl` WRAPPER, not a change to the `arm` dep's own `pr.taskId` argument
  // below: test/arm-outcome-five-sites.test.ts source-locks that dep as an EXPRESSION body
  // passing `pr.taskId` straight through (the impl-BI fix, proving the outcome is RETURNED,
  // never discarded by a braced body). Re-deriving the PR number from `prUrl` — rather than
  // threading `pr.prNumber` in — mirrors `logArmAttribution` immediately below, which already
  // re-derives `prNumber` from `prUrl` for its own ledger fields instead of trusting a second,
  // separately-passed number. `sweepArmTaskId` is skipped (raw `taskId` passed through
  // unchanged) when the number cannot be parsed at all — a malformed `prUrl` is exactly the
  // shape this must fail closed on, matching the pre-existing behaviour byte for byte.
  const sweepArmImpl: (prUrl: string, taskId: string | undefined) => ArmOutcome | ArmAttemptResult = (prUrl, taskId) => {
    const prNumber = prNumberFromRef(prUrl);
    return armImpl(prUrl, prNumber === undefined ? taskId : sweepArmTaskId({ taskId, prNumber }, armSessionPrs));
  };
  let mainCommitRead: Promise<{ sha?: string; committedAt?: string; error?: string } | undefined> | undefined;
  const readMainCommit = (): Promise<{ sha?: string; committedAt?: string; error?: string } | undefined> => {
    mainCommitRead ??= (async () => {
      try {
        const commit = (await readJsonImpl(["api", `repos/${owner}/${repo}/commits/main`])) as {
          sha?: unknown;
          commit?: { committer?: { date?: unknown } };
        };
        const sha = typeof commit?.sha === "string" ? commit.sha : undefined;
        const committedAt = typeof commit?.commit?.committer?.date === "string" ? commit.commit.committer.date : undefined;
        return sha || committedAt ? { sha, committedAt } : undefined;
      } catch (caught) {
        const error = String(caught);
        return { error };
      }
    })();
    return mainCommitRead;
  };
  const readMainRepair = async (): Promise<MainRepairEvidence | undefined> => {
    const main = await readMainCommit();
    return main?.sha && main.committedAt ? { sha: main.sha, committedAt: main.committedAt } : undefined;
  };

  return {
    // W1-T2853: one controller instance is retained per config root by review-capacity.ts, while
    // each pass supplies its already-read ledger snapshot. Host observation is local, provider
    // capacity comes only from the existing age-bounded status file, and all worker kinds count
    // against the same spawnWorker boundary counter.
    selectAdaptiveReviewWidth: ({ queueDepth, nowMs, ledgerLines, activeWorkers }) =>
      selectRuntimeReviewWidth({
        root: config.root,
        queueDepth,
        activeWorkers: activeWorkers ?? activeWorkerCount(),
        nowMs,
        ledgerLines,
        policy: policy.reviewCapacity,
        baseWidth: policy.reviewLanes,
        minWidth: policy.reviewLaneMin,
        maxWidth: policy.reviewLaneMax,
        log,
      }),
    // impl-BI — RETURN THE OUTCOME. PR #968 taught `runSweep` to read this effect's return
    // value (`armOutcomeArmed(armOutcome)` → `acted:false` + a stand-down reason), but THIS
    // adapter — the only implementation the daemon ever runs — still discarded it, so the
    // effect resolved to `undefined`. `armOutcomeArmed(undefined)` returns true by design
    // (it preserves the pre-#968 assumption for fakes that return nothing), which meant the
    // real sweep kept recording `acted:true` for refused arms and #968 was inert in
    // production. A brace and a `return` are the whole difference.

    //
    // W1-T449 — ROUTED THROUGH THE SHARED WRAPPER, NOT A BARE CALL. This used to call
    // `armAutoMerge` directly, so a successful sweep arm left NO ledger trace of its own —
    // only the `sweep.disposed` row (disposition `mergeable`, `acted: true`) and, on
    // FAILURE, prose folded into a stand-down reason. `armAndLogOutcome` is the SAME wrapper
    // every post-review Architect lane already uses (never a second logging path in
    // sweep.ts, per this task's design), passed the `"sweep"` lane so its
    // `automerge.armed`/`automerge.arm_skipped` line reads apart from a review-lane arm on
    // the ledger alone, even with no task id on either.
    // W1-T516: `armImpl` is `sweepArmImpl` above — it resolves the SAME `PR-<n>` synthetic id
    // the review lane already mints and ledgers under (gated on `armSessionPrs`) rather than
    // arming nothing for a session PR (no `Remudero-Task:` trailer). `pr.taskId` itself is
    // still passed straight through here, unchanged from before this task.

    //
    // W1-T1117: `attemptError` is a SIDE CHANNEL, not a second `gh pr merge` attempt — the
    // wrapped closure passed to `armAndLogOutcome` still calls `sweepArmImpl` exactly ONCE; it
    // only also stashes the raw failure text `armAndLogOutcome` itself discards down to the bare
    // outcome string it returns. `armFailureAction` is then re-read (never re-derived by some
    // second classifier) off that SAME text `attemptArm` already classified for the console line,
    // so the "mergeable" arm's dedup (lib/sweep.ts) can tell a semantic-but-retryable/transport
    // failure — never seed the dedup, the base/network condition bounds the retry, not this code
    // — from one the classifier could not decode at all, which DOES seed it (design iv: an
    // `"unknown"` failure takes the same non-retrying shape a genuinely permanent one would).
    // Every other outcome (including a bare "arm-error-ignored" with no captured text, which
    // cannot happen from this adapter but keeps every existing fake/test that returns a plain
    // `ArmOutcome` string compiling and behaving exactly as before) is returned unchanged.
    arm: (pr) => {
      let attemptError: string | undefined;
      const outcome = armAndLogOutcome(
        pr.prUrl,
        pr.taskId,
        log,
        (prUrl, taskId) => {
          const result = sweepArmImpl(prUrl, taskId);
          if (typeof result !== "string") attemptError = result.error;
          return result;
        },
        "sweep",
        // W1-T2258: `pr.headSha` (OpenPrView) is the head this disposition was decided against —
        // already in hand, no extra read needed to close the join gap for this lane.
        pr.headSha,
      );
      // The fold itself is `sweepArmAttemptOutcome` (pure, beside `armFailureAction`) so each of
      // its arms is a unit fixture rather than a branch only a whole sweep pass can reach.
      return sweepArmAttemptOutcome(outcome, attemptError);
    },

    // W1-T1000002 — THE CONVERGING WITHDRAWAL: sweep.ts calls this ONLY when an operator hold
    // stands over a PR GitHub already reports armed (`disarmAutoMerge(` — the grep proof that
    // the sweep now owns a withdrawal call site of its own). `disarmImpl` never throws, so no
    // try/catch is needed here; the ledger line naming who held it and why is written by the
    // caller (sweep.ts's own `automerge.hold_withdrawal`), never duplicated here.
    disarmAutoMerge: (pr) => {
      disarmImpl(pr.prUrl);
    },

    repairMissingTaskTrailer: async (pr, repair) => {
      await updatePrBodyImpl(pr.prUrl, repair.repairedBody);
      log("sweep.missing_task_trailer_body_write", {
        pr_number: pr.prNumber,
        head_sha: pr.headSha,
        task_id: repair.taskId,
        refire_event: repair.refireEvent,
        rerun_failed_jobs: repair.rerunFailedJobs,
      });
    },

    // THE ABSENT-CHECK-SUITE REMEDY (W1-T186 follow-up). Routed through git-push.ts's leaf, so
    // the live-write guard applies and no new outward path exists. `commit-tree` plumbing means
    // this NEVER touches the daemon checkout's working tree, index, or local branches — the
    // W1-T191 property. The push is a fast-forward onto the PR's own branch.
    repushAbsent: async (pr) => {
      if (!pr.headRefName) return undefined;
      return pushEmptyCommit(
        repoRoot,
        pr.headRefName,
        pr.headSha,
        `chore(ci): re-trigger checks on #${pr.prNumber}\n\n` +
          `GitHub created no Actions check-suite for ${pr.headSha.slice(0, 7)}. This empty commit\n` +
          `mints a fresh head sha so the suites are created. Automated by the sweep's ABSENT\n` +
          `remedy; bounded to ${ABSENT_REPUSH_CAP} per PR, after which the ordinary escalation runs.`,
      );
    },

    // W1-T54 ROUTED (the 2026-07-22 #533/#534 stall): the SAME depReviewCommand
    // `rmd dep-review` runs by hand, invoked from the sweep so a Dependabot PR
    // is judged unattended. The command's exit code conflates hold/escalate, so
    // the DECISION is read back off the dep-review.decided ledger line it just
    // wrote — the outcome drives the sweep's terminal-vs-hold dedup.
    depReview: async (pr) => {
      await depReviewCommand(String(pr.prNumber), ["--repo", repo]);
      const decided = readLedgerLines(ledgerPath)
        .filter((l) => l.step === "dep-review.decided" && l.task_id === `dep-review-PR${pr.prNumber}`)
        .at(-1);
      if (decided?.decision === "migrate") {
        const completed = readLedgerLines(ledgerPath)
          .filter(
            (l) =>
              l.step === "dep-review.migrate.completed" &&
              l.task_id === `dep-review-PR${pr.prNumber}` &&
              l.head_sha === pr.headSha,
          )
          .at(-1);
        return completed ? "migrate" : "hold";
      }
      return typeof decided?.decision === "string" ? decided.decision : "unknown";
    },

    // POST-REVIEW ROUTING (the #584 stall): a checks-green PR with NO posted
    // remudero-review gets the SAME reviewCommand the operator verb runs. The
    // posted verdict drives the NEXT sweep pass (success -> arm, failure ->
    // fix/escalate); a criteria-less PR posts FAIL fail-closed — a legible
    // gate state instead of a needs-human clarification issue.
    //
    // W1-T254: every attempt is ledgered up front (`sweep.post_review.attempt`)
    // and its outcome after (`.done` with the exit code, or `.failed` with the
    // thrown error) — the #707 diagnosis misread a dry-run `sweep.dispose`
    // line as a daemon action for lack of exactly this kind of attempt/outcome
    // trail. Rethrows on failure so runSweep's own per-PR throw containment
    // (sweep.ts) still marks `acted:false` + `action_error` on this PR's
    // `sweep.disposed` line — this is a MORE SPECIFIC sibling record, not a
    // replacement for it.
    postReview: async (pr) => {
      log("sweep.post_review.attempt", { pr_number: pr.prNumber, head_sha: pr.headSha });
      try {
        const exit = await reviewRunner(pr.prNumber, pr.isPlanFiling);
        log("sweep.post_review.done", { pr_number: pr.prNumber, head_sha: pr.headSha, exit });
      } catch (e) {
        log("sweep.post_review.failed", {
          pr_number: pr.prNumber,
          head_sha: pr.headSha,
          error: String((e as Error)?.message ?? e),
        });
        // A REPEATED failure escalates; a single one does not. Read back AFTER the log above so the
        // failure just recorded is counted — 91 identical failures produced no signal precisely
        // because nothing ever looked. detectPostReviewStall counts the CURRENT consecutive run
        // (any `.done` resets it) and escalatePostReviewStall dedups on an episode key, so an
        // ongoing stall escalates once however many ticks it spans. Never allowed to mask the
        // original failure: the rethrow below is what runSweep's per-PR containment records, and a
        // throw from the notice itself would replace a real error with a bookkeeping one.
        try {
          // `issues` (not the default gateway) — the SAME reason `issuesImpl` exists on this
          // function: without it this closure's body would open a REAL needs-human issue from any
          // offline test, which is how the escalate closure's own mint went uncovered.
          stallNotice(detectPostReviewStall(readLedgerLines(ledgerPath)), {
            owner,
            repo,
            ledgerPath,
            runId,
            issues,
          });
        } catch (notifyErr) {
          log("sweep.post_review.stall_notice_failed", { error: String((notifyErr as Error)?.message ?? notifyErr) });
        }
        throw e;
      }
    },

    close: (pr, reason) => {
      try {
        // W1-T920 — THE SUPERSESSION DISPOSITION REUSES THIS SAME EFFECT, DELIBERATELY: design
        // note (vi) requires either (a) a new `gh-pr-close` LiveWriteBoundary + fencing, or (b)
        // making the new act reversible by construction. Option (b) is chosen, and it costs
        // ZERO new code here — W1-T921 (immediately below) already stripped `--delete-branch`
        // from THIS call, so a supersession close (lib/sweep.ts's `DISPOSITION_RULES`, the
        // `pr.supersessionVerdict.status === "superseded"` row, disposition "stale") is
        // reversible by construction the moment it reaches this same site. No second close path,
        // no widened/narrowed `LiveWriteBoundary` verb set.
        //
        // W1-T921: NO `--delete-branch` HERE, AND THAT ABSENCE IS THE WHOLE CHANGE. DECISIONS.md's
        // 2026-08-16 ruling (W1-T919) gates the fleet on IRREVERSIBILITY rather than outwardness,
        // and rests that on closing preserving the head branch while merging destroys it — measured
        // on #1873 (closed, branch intact) against #1874 (merged, branch taken). But #1873 was
        // closed BY A HUMAN; this closure is the FLEET's close, and with the flag it destroyed the
        // very branch the ruling cites. The work was never actually lost — GitHub keeps
        // `refs/pull/<n>/head` permanently, so #1874's head object is still served today — but a
        // deleted branch cannot be reopened without first being restored, and the ruling exists to
        // authorise THIS actor. Rule 21 forbids amending the merged entry, so the effects layer is
        // where it is reconciled.
        //
        // THE MERGE PATHS KEEP THE FLAG AND MUST: W1-T447 wants merged branches reaped, where the
        // branch is genuinely spent. This is the one site that closes an UNMERGED pull request.
        ghRunImpl("gh", ["pr", "close", pr.prUrl, "--comment", `Closed by rmd sweep: ${reason}`]);
      } catch (e) {
        log("sweep.close.error", { pr_number: pr.prNumber, error: String((e as Error)?.message ?? e) });
      }
    },

    // W1-T1223 (design iv) — THE JOB, NEVER THE RUN: `actions/jobs/{job_id}/rerun`, never
    // `actions/runs/{run_id}/rerun-failed-jobs` — a whole-run re-run would re-spend an
    // already-green sibling job sharing this workflow run (`ci` and `coverage-ratchet` share one
    // here, the #2434/#2444 shape this task fixes). `ghRunImpl` is the SAME injection seam
    // `close` above already uses (W1-T921) — no `gh` call this closure makes is unobservable
    // offline. `check.jobId` absent (the rollup's `detailsUrl` carried none) degrades to a NAMED
    // no-op — never a guessed target.
    requeueCheck: (pr, check) => {
      if (!check.jobId) {
        log("sweep.check_requeue.no_job_id", { pr_number: pr.prNumber, check_name: check.name });
        return false;
      }
      try {
        ghRunImpl("gh", ["api", "-X", "POST", `repos/${owner}/${repo}/actions/jobs/${check.jobId}/rerun`]);
        log("sweep.check_requeue.dispatched", { pr_number: pr.prNumber, check_name: check.name, job_id: check.jobId });
        return true;
      } catch (e) {
        log("sweep.check_requeue.error", { pr_number: pr.prNumber, check_name: check.name, error: String((e as Error)?.message ?? e) });
        return false;
      }
    },

    // W1-T1223 (design iii) — a SECOND cancellation of the SAME required check on the SAME head
    // sha names the check and both cancellations to a human. `tryEscalate` (not the throwing
    // `escalate`), because this runs inside the sweep's own per-PR loop alongside every other
    // effect (W1-T254's throw containment) — a delivery failure here degrades to an
    // `escalation.failed` ledger row rather than aborting the rest of the pass.
    // `findDuplicateEscalation` (inside `escalate()`/`tryEscalate()`) already dedupes a repeated
    // call for the SAME (taskId, headSha, cause) into one issue, so this is safe to call every
    // pass the same pair keeps observing a re-cancellation, never opening a sibling issue.
    escalateCancelledCheck: (pr, check, reason) => {
      tryEscalate(
        {
          class: "BLOCKED",
          taskId: escalationTaskIdFor(pr),
          runId,
          headSha: pr.headSha,
          cause: "ci",
          summary: `required check "${check.name}" cancelled twice on the same head — ${pr.prUrl}`,
          detail:
            `The gate-reconciliation lane (W1-T1223) re-queued required check "${check.name}"'s job once ` +
            `on head ${pr.headSha}, and it was reported CANCELLED again on that SAME head — ${reason}. ` +
            `A concurrency group cancelling it, a capacity fault, or a workflow-level cancel are all beyond ` +
            `what a second re-queue could fix; nothing in this PR's own diff caused this.`,
          options: [
            {
              label: "investigate",
              detail: "look at the workflow run's own cancellation cause (concurrency group, runner capacity, a manual cancel) directly on GitHub Actions.",
            },
            { label: "manual-rerun", detail: "re-run the job by hand once the underlying CI-side cause is understood." },
          ],
          recommendation: "investigate",
        },
        { issues, ledgerPath, runId },
      );
    },

    // W1-T3194 — a repeated or unaddressable positively identified infrastructure failure is
    // terminal for the deterministic retry lane, but never a source-code worker strike. The
    // escalation gateway supplies durable episode dedup for the exact task/head/cause tuple.
    escalateInfrastructureCheck: (pr, check, reason, signature) => {
      tryEscalate(
        {
          class: "BLOCKED",
          taskId: escalationTaskIdFor(pr),
          runId,
          headSha: pr.headSha,
          cause: "ci",
          summary: `required check "${check.name}" exhausted its bounded infrastructure retry — ${pr.prUrl}`,
          detail:
            `The failed-CI infrastructure classifier identified ${signature} for check "${check.name}" ` +
            `on head ${pr.headSha}, but ${reason}. No code worker or fix strike was spent because ` +
            `the captured failure is outside the source diff's control.`,
          options: [
            {
              label: "investigate-actions",
              detail: "inspect the exact Actions job and GitHub artifact-service response before deciding whether to rerun manually.",
            },
            {
              label: "manual-rerun",
              detail: "rerun the exact job after confirming the infrastructure condition has cleared.",
            },
          ],
          recommendation: "investigate-actions",
        },
        { issues, ledgerPath, runId },
      );
    },

    // W1-T2300 (design ii/iii) — a FRESH REST read of ONE PR's required-check rollup, consulted
    // by `runSweep` immediately before a blocked-fixable disposition acts — NEVER the `openPrs`
    // snapshot this whole sweep pass started from (see `SweepDeps.readCiGateRollup`'s own doc,
    // lib/sweep.ts). `restRollupFor` is the SAME composed check-runs + combined-status read
    // `pollToGate`/`waitForCiGreen` already drive over this SAME non-blocking `readJsonImpl` seam
    // (W1-T2268) — no new gateway, no new credential, no GraphQL. A failed read degrades to
    // `undefined`: `staleCiGateTransition(undefined)` always returns `undefined`, so this lane
    // simply never fires for this PR on this pass, rather than aborting the whole sweep loop over
    // one PR's rollup read.
    readCiGateRollup: async (pr) => {
      try {
        return await restRollupFor(owner, repo, pr.headSha, readJsonImpl);
      } catch (e) {
        log("sweep.ci_gate_rollup.error", {
          pr_number: pr.prNumber,
          head_sha: pr.headSha,
          error: String((e as Error)?.message ?? e),
        });
        return undefined;
      }
    },

    // W1-T2300 (design ii/iv) — re-drive `ci-gate`'s OWN check-run job: the SAME per-job Actions
    // route `requeueCheck` above already uses (`actions/jobs/{job_id}/rerun`, NEVER
    // `actions/runs/{run_id}/rerun-failed-jobs` — Q3(x) forbids substituting a whole-run re-run,
    // which would re-spend an already-green sibling job sharing this workflow run). `transition`
    // (from `staleCiGateTransition`, lib/sweep.ts) carries no job id of its own — that function's
    // own doc names it "parsed by a future real-gateway producer from ci-gate's OWN check-run
    // detailsUrl", which is exactly this closure. A SECOND fresh read is taken here (rather than
    // reusing whatever `readCiGateRollup` returned moments earlier) because this call may run an
    // observable instant after the one that detected the stale transition, and design (i) already
    // requires every re-drive decision to compare against the CURRENT state, never a frame from a
    // moment ago. No job id resolvable (rollup unreadable, or ci-gate's own entry carries no
    // `detailsUrl`) degrades to a NAMED no-op — never a guessed target, exactly like
    // `requeueCheck`'s own contract above.
    reaggregateCiGate: async (pr, transition) => {
      let jobId: string | undefined;
      try {
        const rollup = await restRollupFor(owner, repo, pr.headSha, readJsonImpl);
        const gate = dedupeRollupByLatestAttempt(rollup).find(
          (c) => (c.name ?? c.context ?? "") === CI_GATE_CHECK_NAME,
        );
        jobId = gate?.detailsUrl?.match(/\/job\/(\d+)/)?.[1];
      } catch (e) {
        log("sweep.ci_gate_reaggregate.rollup_error", {
          pr_number: pr.prNumber,
          sibling_name: transition.siblingName,
          error: String((e as Error)?.message ?? e),
        });
      }
      if (!jobId) {
        log("sweep.ci_gate_reaggregate.no_job_id", { pr_number: pr.prNumber, sibling_name: transition.siblingName });
        return;
      }
      try {
        ghRunImpl("gh", ["api", "-X", "POST", `repos/${owner}/${repo}/actions/jobs/${jobId}/rerun`]);
        log("sweep.ci_gate_reaggregate.dispatched", {
          pr_number: pr.prNumber,
          job_id: jobId,
          sibling_name: transition.siblingName,
          sibling_started_at: transition.siblingStartedAt,
        });
      } catch (e) {
        log("sweep.ci_gate_reaggregate.error", {
          pr_number: pr.prNumber,
          job_id: jobId,
          error: String((e as Error)?.message ?? e),
        });
      }
    },

    // W1-T78 — the CLARIFICATION-QUESTION rung's real wiring: `question` is
    // ALREADY rendered (deterministically, from ledger ground truth) by the
    // caller (runSweep/routeFix via renderClarificationQuestion). This closure
    // does the TWO things the rung's design calls for: (1) log it to the
    // durable §2 question backlog (plan/questions.ndjson — an append-only side
    // channel, never a tasks.yaml edit, rule 15), and (2) use W1-T8's
    // `escalate()` purely as the notification TRANSPORT, carrying the SAME two
    // candidate resolutions as its options — never a generic needs-human.
    escalate: (pr, reason, question) => {
      const logged = appendQuestion(repoRoot, toQuestionEntry(question, new Date().toISOString()));
      log(logged ? "sweep.question.logged" : "sweep.question.log_failed", {
        pr_number: pr.prNumber,
        question: question.question.slice(0, 120),
      });
      // W1-T983 — THE ONE CLASS CHANGE THIS TASK MAKES: a capped review-orphaned PR (green
      // checks, no review posted, `priorReviewAttemptsForInput` at `policy.reviewOrphanCap`) reaches THIS
      // escalation path with nothing ELSE going to move it in the meantime — the sweep will not
      // re-dispatch the review lane again until W1-T1018's elapsed-time backoff
      // (`reviewInputBackoffElapsed`, lib/sweep.ts) lapses — so it escalates MANUAL instead of the
      // silent BLOCKED default every other blocked-ambiguous disposition still gets. Read off
      // the SAME `pr`/`policy` this closure already has in scope, via the pure predicate in
      // sweep.ts (never re-derived here) so the two conditions cannot drift apart. W1-T1018 (2026-
      // 08-19 operator ruling) removed the OLD permanent wall this comment used to describe here —
      // the disposition genuinely resumes retrying on its own once the backoff interval elapses.
      //
      // TARGET CLASS AND PROJECTED PING RATE (design clause ii, computed the same way rationale
      // (3)/(4) were): MANUAL averaged 8 issues over the SAME 29 distinct days BLOCKED did
      // (~0.28/day); this disposition fires ~1.7/day (5 issues over 3 days). Reclassifying only
      // THIS disposition to MANUAL projects to ~2/day for that class — "a few pings a day," well
      // under the ~15.6/day BLOCKED average a blanket tier change would reinstate. MANUAL also
      // fits the disposition semantically (this module's own header: "only a human hand can do
      // the thing") — a capped, green, unreviewable PR needs an operator to look at it and either
      // override the cap or merge it by hand; nothing downstream can move it further on its own.
      const cls: EscalationClass = isCappedReviewOrphanEscalation(pr, policy) ? "MANUAL" : "BLOCKED";
      escalate(
        {
          class: cls,
          // See {@link escalationTaskIdFor} — pure and separately tested, so the mint that makes
          // this issue retirable cannot silently regress behind this closure's real gateway.
          taskId: escalationTaskIdFor(pr),
          runId,
          // W1-T195: the SAME composite-key dimensions the fix rung's exhaustion
          // escalate sets (runFixRung, above) — `pr.headSha` is the SAME field the
          // fix rung dispatches strikes against, and `escalationCause` classifies off
          // the SAME `pr.mergeState`/`isBlockedCi(pr)` signals this closure's own
          // caller (routeFix/runSweep) already used to route here. When this
          // clarification observes the identical (PR, head, cause) an already-open
          // fix-rung-exhaustion issue named, `escalate()` appends here instead of
          // opening a sibling — the #412/#413-shaped duplicate this task fixes.
          headSha: pr.headSha,
          ...(reason === "review failing with no actionable unmet criteria (contradictory) — escalating"
            ? { headDedup: "independent" as const }
            : {}),
          cause: escalationCause(pr.mergeState === "dirty", isBlockedCi(pr)),
          summary: `PR ${pr.prUrl} needs a clarification — ${reason}`,
          detail:
            `The CLARIFICATION-QUESTION rung (W1-T78, ratifies P22's new rung) reconciled open PR #${pr.prNumber} ` +
            `to BLOCKED-AMBIGUOUS: ${reason}.\n\n${question.question}`,
          options: question.resolutions.map((r) => ({ label: r.label, detail: r.detail })),
          recommendation: question.resolutions[0].label,
        },
        { issues, ledgerPath, runId },
      );
    },

    dispatchFix: async (pr, evidence) => {
      let worktreePath = "";
      // W1-T2609: released in the SAME `finally` below that cleans up `worktreePath` — held for
      // this round's whole checkout→commit→push window (acquired just before the worktree is
      // created, released once `runFixRung` returns/throws), never a narrower slice.
      let branchClaim: InflightLockHandle | undefined;
      // W1-T1127: TRUE only once `runFixRung` has demonstrably spent a real strike — i.e. its
      // OWN `fix.dispatch` line below has been written. `runSweep`'s `sweep.disposed` dedup seed
      // (`prior.fixed`, sweep.ts) is keyed off THAT line's later effect (an `acted:true` row),
      // never off this closure returning cleanly. Before this task, EVERY throw here — a
      // `git checkout -B` racing `.git/config`'s lock included — was swallowed unconditionally,
      // so `runSweep` always saw a clean return and recorded `acted:true`, seeding the dedup for
      // a head that never received a single `fix.*` ledger row. `fixRungStalledWithoutNewHead`
      // (sweep.ts, W1-T1110) can only re-arm that gate by reading rows THIS run wrote — with none
      // written, it reads `false` forever, and the head is stuck (the plan record's rationale).
      // A throw BEFORE `fix.dispatch` must therefore reach `runSweep`'s own `catch` (which already
      // sets `acted = false` — untouched by this task) instead of being swallowed here. A throw
      // AFTER `fix.dispatch` is unchanged: the strike is real, `runSweep` must keep recording
      // `acted:true` exactly as it always has, so it is still swallowed below.
      let dispatchStarted = false;
      try {
        const terminalKey = terminalUncreditableHeadKey(pr.prNumber, pr.headSha);
        const priorTerminal = terminalHeads.get(terminalKey);
        // A delivered terminal decision is final for THIS SHA and requires no fresh network read.
        // If delivery failed, retain the ordinary live-state preflight below before retrying only
        // the escalation; the expensive/unchangeable head lookup is never repeated either way.
        if (priorTerminal?.escalated) return;

        // W1-T177 SITE (v): an INDEPENDENT fresh live-state read, via the
        // SAME `readLiveState`/`ghLiveState` fail-open contract every other
        // spending site uses (see {@link dispatchFixPreflightStandDown}) —
        // BEFORE any worktree/git side effect (fetch/add/checkout) ever
        // touches this PR. A failed/indeterminate read is ledgered and never
        // stands the dispatch down; only a positive terminal reading does.
        const preflightStandDown = await dispatchFixPreflightStandDown(ghLiveState, pr, log);
        if (preflightStandDown) return;
        if (priorTerminal) {
          escalateTerminalHead(priorTerminal, pr);
          return;
        }

        // W1-T78: an operator's answer to a PRIOR clarification question (routed here by the
        // DISPOSITION_RULES "answered" row) re-arms this SAME dispatch — never a new call site —
        // carrying the answer as an added constraint (threaded below, once `task` resolves),
        // its ceiling extended per the answer's own policy (config-driven, {@link
        // strikeCapForAnswer}, folded into {@link fixCeilingInForce} below), instead of the
        // ORIGINAL blocked_review dispatch's plain strikeCap. The fallback (when the answer
        // itself carries no override) is `policy.clarify` — the SAME policy
        // `DISPOSITION_RULES`' answered row just used to ROUTE here — never a second,
        // independently-hardcoded default that could silently diverge from the routing decision.
        //
        // W1-T2452: THE CUMULATIVE CEILING NOW BINDS, and is checked BEFORE any worktree/git
        // side effect — the SAME discipline the preflight check just above uses, so a refusal
        // here never leaves a stray worktree behind. `runFixRung` always counts a NEW call from
        // 0 strikes, so handing it a fresh full cap on every dispatch let one PR's ledger-derived
        // `priorStrikes` exceed the ceiling by up to `cap - 1` on every dispatch after the first
        // (observed: "fix strikes exhausted (3/2)" on PR #3043, cap=2). `fixCeilingInForce`
        // (sweep.ts) names the SAME ceiling `DISPOSITION_RULES`' rows already render — base cap,
        // or the extended answer ceiling when `pr.pendingAnswer` is live — and
        // `fixDispatchBudget` hands `runFixRung` only the REMAINDER against it, so the ledger's
        // running strike count for one PR can never cross that ceiling regardless of how many
        // dispatches it takes.
        const ceiling = fixCeilingInForce(pr, fixStrikeCap(config), policy.clarify);
        const strikeCap = fixDispatchBudget(pr.priorStrikes, ceiling);
        if (strikeCap == null) {
          // W1-T2452 design note (ii), THE LOAD-BEARING HALF: a non-positive remainder must
          // NEVER dispatch a zero-budget rung — that would silently convert an overspend into
          // a no-op that strands an otherwise-fixable PR forever. `DISPOSITION_RULES` row 4
          // already routes `priorStrikes >= strikeCap` to escalate, so reaching here at all
          // means THIS dispatch's own routing disagreed with the ceiling actually in force —
          // ledger that disagreement (naming the ceiling) instead of silently swallowing it,
          // and spend nothing.
          log("sweep.fix.ceiling_exhausted", {
            pr_number: pr.prNumber,
            prior_strikes: pr.priorStrikes,
            ceiling,
          });
          return;
        }

        // Creditability is load-bearing (status.ts ownsBranch): a fix must amend
        // THIS task's own run-branch (run-<id>-<epochMs>), never a foreign/fix-*
        // head — a fix on an uncreditable head loops forever + strands dependents.
        // `body` is fetched in the SAME call (never a second `gh pr view`) so
        // `fixRungTaskFor` can resolve a synthetic (no-task) PR's acceptance
        // criteria from its `## Acceptance` block — see that function's doc for
        // why a hardcoded `[]` here made a `blocked_review` synthetic dispatch
        // permanently unjudgeable.
        const headRef = ghJson(["pr", "view", pr.prUrl, "--json", "headRefName,headRefOid,body"]) as {
          headRefName?: string;
          headRefOid?: string;
          body?: string;
        };
        const realBranch = headRef.headRefName;
        // impl-FY: a PR with no plan task is STILL repairable — see fixRungTaskFor. The rung used to
        // log `sweep.fix.no_task` and return here, which is why seven agent-authored PRs were
        // classified fixable and then silently skipped every poll.
        const { task, synthetic } = fixRungTaskFor(plan, pr, headRef.body, realBranch);
        if (synthetic) log("sweep.fix.synthetic_task", { pr_number: pr.prNumber, task_id: task.id });
        if (!realBranch || !fixHeadAcceptable(realBranch, task.id, synthetic)) {
          // The guard above is UNCHANGED — this decides nothing, it only explains the decline
          // that already happened. `reason` matches the field `sweep.fix.not_open` already uses
          // for the same purpose (its own value comes from the pure `terminalStateReason`), so
          // this introduces no new telemetry convention; the value is an enumerated token rather
          // than that row's free prose because this one has to aggregate.
          const reason = uncreditableHeadReason(realBranch, task.id, synthetic);
          const cause = escalationCause(pr.mergeState === "dirty", isBlockedCi(pr));
          log(TERMINAL_UNCREDITABLE_HEAD_STEP, {
            pr_number: pr.prNumber,
            head_sha: pr.headSha,
            head: realBranch,
            synthetic,
            reason,
            ...(reason === "not_a_run_branch"
              ? { terminal: true, repair_task_id: task.id, cause }
              : {}),
          });
          if (reason === "not_a_run_branch" && realBranch) {
            const terminal: TerminalUncreditableHead = {
              prNumber: pr.prNumber,
              headSha: pr.headSha,
              head: realBranch,
              taskId: task.id,
              cause,
              escalated: false,
            };
            terminalHeads.set(terminalKey, terminal);
            escalateTerminalHead(terminal, pr);
          }
          return;
        }

        const branchRef = `refs/heads/${realBranch}`;
        let registeredOwner: string | undefined;
        try {
          registeredOwner = registeredWorktreeOwnerImpl(repoDir, branchRef);
        } catch (e) {
          log("sweep.fix.checkout_claim_declined", {
            reason: "registered_worktree_owner",
            owner_recovery_reason: "worktree_registry_unreadable",
            pr_number: pr.prNumber,
            task_id: task.id,
            branch: realBranch,
            error: capStderrExcerpt(String((e as Error)?.message ?? e), STDERR_EXCERPT_CAP),
          });
          throw e;
        }
        if (registeredOwner) {
          let snapshot: RegisteredFixOwnerSnapshot;
          try {
            snapshot = registeredOwnerRecovery.capture({
              repoDir,
              worktreesRoot: worktreesDir(config),
              ownerPath: registeredOwner,
              taskId: task.id,
              branch: realBranch,
              expectedRemoteSha: pr.headSha,
              observedRemoteSha: headRef.headRefOid,
              inflightDir,
              claimKey: fixBranchClaimKey(owner, repo, realBranch),
            });
          } catch (e) {
            log("sweep.fix.checkout_claim_declined", {
              reason: "registered_worktree_owner",
              owner_recovery_reason: "owner_snapshot_unreadable",
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              worktree_path: boundedWorktreeOwnerPath(registeredOwner),
              error: capStderrExcerpt(String((e as Error)?.message ?? e), STDERR_EXCERPT_CAP),
            });
            return;
          }
          const recovery = decideRegisteredFixOwnerRecovery(snapshot);
          if (recovery.kind === "keep") {
            log("sweep.fix.checkout_claim_declined", {
              reason: "registered_worktree_owner",
              owner_recovery_reason: recovery.reason,
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              worktree_path: snapshot.path,
              process_probe_reason: snapshot.processProbeReason,
            });
            return;
          }
          let preservedRecoveryRef: string | undefined;
          if (recovery.kind !== "reclaim-contained") {
            const localSha = snapshot.localSha;
            const remoteSha = snapshot.remoteSha;
            if (!localSha || !remoteSha) {
              log("sweep.fix.checkout_claim_declined", {
                reason: "registered_worktree_owner",
                owner_recovery_reason: "owner_salvage_identity_unreadable",
                pr_number: pr.prNumber,
                task_id: task.id,
                branch: realBranch,
                worktree_path: snapshot.path,
              });
              return;
            }
            try {
              if (recovery.kind === "publish-ahead") {
                (registeredOwnerRecovery.publishAhead ?? requiredSweepRuntime("registeredOwnerRecovery.publishAhead"))(
                  repoDir,
                  realBranch,
                  localSha,
                  remoteSha,
                );
                log("sweep.fix.checkout_owner_ahead_published", {
                  pr_number: pr.prNumber,
                  task_id: task.id,
                  branch: realBranch,
                  local_sha_prefix: localSha.slice(0, 12),
                  remote_sha_prefix: remoteSha.slice(0, 12),
                });
              } else {
                preservedRecoveryRef = String((registeredOwnerRecovery.preserveDiverged ?? requiredSweepRuntime("registeredOwnerRecovery.preserveDiverged"))(
                  repoDir,
                  realBranch,
                  localSha,
                ));
                log("sweep.fix.checkout_owner_divergence_preserved", {
                  pr_number: pr.prNumber,
                  task_id: task.id,
                  branch: realBranch,
                  local_sha_prefix: localSha.slice(0, 12),
                  remote_sha_prefix: remoteSha.slice(0, 12),
                  recovery_ref: preservedRecoveryRef.slice(0, 512),
                });
              }
            } catch (e) {
              log("sweep.fix.checkout_claim_declined", {
                reason: "registered_worktree_owner",
                owner_recovery_reason:
                  recovery.kind === "publish-ahead" ? "owner_ahead_publish_failed" : "owner_divergence_preserve_failed",
                pr_number: pr.prNumber,
                task_id: task.id,
                branch: realBranch,
                worktree_path: snapshot.path,
                local_sha_prefix: localSha.slice(0, 12),
                remote_sha_prefix: remoteSha.slice(0, 12),
                error: capStderrExcerpt(String((e as Error)?.message ?? e), STDERR_EXCERPT_CAP),
              });
              return;
            }
          }
          try {
            registeredOwnerRecovery.remove(repoDir, registeredOwner);
          } catch (e) {
            log("sweep.fix.checkout_claim_declined", {
              reason: "registered_worktree_owner",
              owner_recovery_reason: "owner_remove_failed",
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              worktree_path: snapshot.path,
              error: capStderrExcerpt(String((e as Error)?.message ?? e), STDERR_EXCERPT_CAP),
            });
            return;
          }
          let ownerAfterRemoval: string | undefined;
          try {
            ownerAfterRemoval = registeredWorktreeOwnerImpl(repoDir, branchRef);
          } catch (e) {
            log("sweep.fix.checkout_claim_declined", {
              reason: "registered_worktree_owner",
              owner_recovery_reason: "worktree_registry_reread_failed",
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              worktree_path: snapshot.path,
              error: capStderrExcerpt(String((e as Error)?.message ?? e), STDERR_EXCERPT_CAP),
            });
            return;
          }
          if (ownerAfterRemoval) {
            log("sweep.fix.checkout_claim_declined", {
              reason: "registered_worktree_owner",
              owner_recovery_reason:
                ownerAfterRemoval === registeredOwner ? "owner_registration_remained" : "owner_registration_changed",
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              worktree_path: boundedWorktreeOwnerPath(ownerAfterRemoval),
            });
            return;
          }
          log("sweep.fix.checkout_owner_reclaimed", {
            pr_number: pr.prNumber,
            task_id: task.id,
            branch: realBranch,
            worktree_path: snapshot.path,
            local_sha_prefix: snapshot.localSha?.slice(0, 12),
            remote_sha_prefix: snapshot.remoteSha?.slice(0, 12),
            age_ms: snapshot.ageMs,
            proof: {
              managed_path: snapshot.pathState === "managed",
              exact_branch: snapshot.attachmentState === "exact",
              clean_tree: snapshot.treeState === "clean",
              exact_remote_head: snapshot.remoteState === "exact",
              owner_history_action: recovery.kind,
              local_contained_by_remote: snapshot.historyState === "contained",
              recovery_ref: preservedRecoveryRef?.slice(0, 512),
              no_live_claim: snapshot.claimState === "clear",
              no_process_cwd: snapshot.processState === "clear",
            },
          });
        }

        // W1-T2609 (design ii): an EXCLUSIVE claim on this (repo, branch) pair, taken BEFORE any
        // worktree/git side effect — the same "declines before touching git" discipline the
        // preflight/ceiling checks above already keep. Reuses `acquireInflightLock`'s O_EXCL
        // discipline (never a second locking mechanism, W1-T228) keyed by `fixBranchClaimKey`
        // rather than `task.id`, because the thing being protected is the BRANCH two concurrent
        // rounds for the same task share, not the task id alone. A round that loses the race
        // DECLINES this poll — ledgered exactly like `sweep.fix.uncreditable_head` above — and
        // the sweep is level-triggered, so the next pass simply retries it.
        try {
          branchClaim = acquireInflightLock(inflightDir, fixBranchClaimKey(owner, repo, realBranch), { run_id: runId });
        } catch (e) {
          if (e instanceof InflightLockError) {
            log("sweep.fix.checkout_claim_declined", {
              reason: "inflight_lock_owner",
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              holder_run_id: e.holder.run_id,
              holder_pid: e.holder.pid,
            });
            return;
          }
          throw e;
        }

        const dispatchNowMs = nowMsImpl();
        worktreePath = join(worktreesDir(config), `sweep-${task.id}-${dispatchNowMs}`);
        try {
          const recoveredHead = createFixRungWorktree(repoDir, worktreePath, realBranch);
          if (recoveredHead) {
            log("sweep.fix.checkout_recovered", {
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: recoveredHead.branch,
              local_sha: recoveredHead.localSha,
              origin_sha: recoveredHead.originSha,
              recovery_ref: recoveredHead.recoveryRef,
            });
          }
        } catch (e) {
          if (e instanceof FixRungCheckoutRefusedError) {
            // W1-T2609 (design i): the local ref is ahead of origin/<branch> — a concurrent
            // round's unpushed commit sits there. Decline this round rather than reset it away;
            // the local ref (and that commit) is left exactly as `checkoutFixHeadRef` found it.
            log("sweep.fix.checkout_refused", {
              pr_number: pr.prNumber,
              task_id: task.id,
              branch: realBranch,
              local_sha: e.localSha,
              origin_sha: e.originSha,
            });
            return;
          }
          throw e;
        }
        const birthWorktreeSnapshot = captureWorktreeSnapshotViaGit(worktreePath);

        const mountsTable = loadMounts(mountsPath(repoRoot));
        const fixMount: Mount = resolveMount(mountsTable, "fix", task.risk);
        const reviewerMount: Mount = resolveMount(mountsTable, "reviewer", task.risk);
        const settingsFile = renderWorkerSettings({
          templatePath: join(repoRoot, "settings", "worker.json"),
          hooksDir: join(repoRoot, "hooks"),
          outPath: join(config.root, "tmp", `sweep-fix-settings-${task.id}-${dispatchNowMs}.json`),
        });
        const budgetUsd = task.budget_usd ?? defaultBudgetUsd;

        await runFixRung({
          ...buildFixRungDispatchArgs({
            task,
            runId,
            prUrl: pr.prUrl,
            branch: realBranch,
            worktreePath,
            mount: fixMount,
            settingsFile,
            config,
            budgetUsd,
            strikeCap,
            evidence,
            pr,
            reviewBase: { owner, repo, headCheckoutDir: worktreePath, reviewerMount },
          }),
          birthWorktreeSnapshot,
          // W1-T322: same plan this sweep already loaded (`fixRungTaskFor(plan, …)` above) — see
          // runTask's own `openTaskIds` comment for what this set is and why it's computed once.
          // W1-T367 (design (v)): the sweep has no derived projection in hand at this call site
          // either (it only ever loads `plan` — see `sweepCommand` — never `projectPlan`s it), so
          // this stays a plain `openTaskIdsFromPlan(plan)` call: no projection argument means no
          // second GitHub read gets opened here. That degrades to the EMPTY set (documented on
          // the function), so a SHIPS-UNWIRED marker on a PR this rung fixes is FLAGGED rather
          // than honoured off stale yaml — the safe direction.
          openTaskIds: openTaskIdsFromPlan(plan),
          deps: {
            // Fresh-spawn adapter: an empty resumeSessionId (cold PR) becomes a
            // fresh spawn rather than an attempt to resume a session that doesn't exist.
            spawn: (args: SpawnWorkerArgs) => (spawnImpl ?? spawnWorker)({ ...args, resumeSessionId: args.resumeSessionId || undefined }),
            waitForCiGreen,
            // W1-T138: refresh the ci-log evidence whenever a strike leaves CI
            // non-green — see runFixRung's own doc for why this must happen on
            // every strike, not just the first.
            fetchCiFailures: async (prUrlArg: string) => {
              const v = ghJson(["pr", "view", prUrlArg, "--json", "statusCheckRollup"]) as {
                statusCheckRollup?: RollupCheck[];
              };
              return fetchCiFailures(owner, repo, v.statusCheckRollup);
            },
            // W1-T1278 (condition A): same RAW rollup shape as the run-loop call site above —
            // see that site's own comment for why this must stay separate from `fetchCiFailures`.
            readCiRollup: async (prUrlArg: string) => {
              const v = ghJson(["pr", "view", prUrlArg, "--json", "statusCheckRollup"]) as {
                statusCheckRollup?: RollupCheck[];
              };
              return v.statusCheckRollup ?? [];
            },
            runReview,
            fetchPrBody: fetchPrBodyViaGh,
            // W1-T2610: same wiring as the run-loop's fix-rung `push:` closure above —
            // `expectedHeadSha` is the sha this rung just committed, so `gitPushRunBranch`'s
            // post-condition can catch a ref rewound between the commit and this push instead of
            // silently no-op'ing. The resulting `LanePushForeignHeadError` is let through
            // (never swallowed below) so the round parks rather than reporting a push that
            // moved nothing as success.
            push: (wt: string, _branch: string, expectedHeadSha: string) => {
              try {
                gitPushRunBranch(wt, { stdio: "ignore", expectedHeadSha });
              } catch (err) {
                if (err instanceof LanePushForeignHeadError) throw err;
                /* best-effort — the worker may already have pushed */
              }
            },
            readHeadShaForProvenance: readHeadShaRest,
            issues,
            ledgerPath,
            // W1-T78: the OUTER `log` stamps every line `task_id: "SWEEP"`/`"FIX"`
            // (this closure is shared by both `rmd sweep`'s and `rmd fix`'s
            // callers) — but `fix.dispatch`/`fix.review` lines need the REAL
            // task id so `deriveStrikeHistory` can find them again later (its
            // `line.task_id !== taskId` filter would otherwise match nothing
            // for every COLD dispatch, silently starving the clarification
            // question's "what the fix worker tried" input). `extra`'s own
            // `task_id` wins over the outer default (spread order in `log`'s
            // body), so this is a pure override, not a second ledger writer.
            log: (s: string, extra?: Record<string, unknown>) => {
              // W1-T1127: the ONE line `fixRungStalledWithoutNewHead`/`priorActionsFromLedger`
              // treat as "a real strike was spent" — see this closure's own doc, above. W1-T2403
              // extends this to `fix.retrigger` too: a retrigger-shaped round spends NO strike but
              // is still real engagement — a worker demonstrably ran and pushed — so a throw AFTER
              // it must reach this SAME "already acted" path, never the "wrote no fix.* row"
              // rethrow meant for a dispatch that never got this far.
              if (s === "fix.dispatch" || s === "fix.retrigger") dispatchStarted = true;
              log(s, { task_id: task.id, ...extra });
            },
            say,
            account: (r: WorkerResult) => r, // sweep meters nothing extra; the ledger carries per-spawn cost
            // W1-T177: the SAME live-state reader every fix-rung call site
            // wires — a fresh `gh pr view` read, never the sweep's `openPrs`
            // snapshot this dispatch was selected from.
            readLiveState: ghLiveState,
            // W1-T296: the SAME live-head reader every fix-rung call site
            // wires for the pre-strike branch-authorship check.
            readLiveHead: ghLiveHead,
            // W1-T1227: wired EXPLICITLY here too — see the run-loop call site's own comment on
            // this same field for why the internal `body-coverage`-only default is not enough to
            // make the pre-strike SCOPE gate live on this (the cold/sweep-driven) dispatch path.
            fetchPrDiffFiles: fetchPrDiffFilesViaGh,
            // W1-T1095: the SAME `ghLiveState` reader, aimed at whatever prerequisite PR
            // number a "blocked on #N" review names, in this SAME owner/repo — see
            // runFixRung's own `readPrerequisiteState` doc.
            readPrerequisiteState: (n: number) => ghLiveState(`https://github.com/${owner}/${repo}/pull/${n}`),
            // W1-T1095 (capability 3): same two seams as the run-loop call site above — pure
            // API reads plus the guarded update-branch write, never a local rebase.
            readMergeFacts: (n: number) => fixRebaseMergeFactsFromRest(owner, repo, n),
            // W1-T2671: same ci-log-only base-gap reader as the run-loop call site above.
            readRedBaseRefreshFacts: (n: number) => redBaseRefreshFactsFromRest(owner, repo, n),
            updateBranch: (n: number) => ghUpdateBranch(owner, repo, n),
            // W1-T1044: THIS is the call site the measured incident actually hit — a fix-rung
            // worker spawned from a `dispatchFix` disposition ran 8,970s as a direct child of
            // the daemon, parking `await deps.sweep()` (daemon.ts) for the whole of it. The
            // wall-clock bound + best-effort reclaim close it here.
            spawnWallClockBoundMs,
            reclaimWorker: reclaimWorkerImpl,
            // W1-T1284: same LOCAL worktree reader as the run-loop call site above — see that
            // site's own comment.
            captureWorktreeSnapshot: captureWorktreeSnapshotViaGit,
            readRegisteredWorktrees: () => listRegisteredWorktrees(repoDir),
            // W1-T2403: same LOCAL worktree reader as the run-loop call site above.
            readRoundCommits: readFixRoundCommitsViaGit,
            // W1-T2551: same three real, local wirings as the run-loop call site above.
            runGeneratorScript: async (script: string, cwd: string) => runNpmScriptViaSpawn(script, cwd),
            commitGeneratorOutput: (o: Parameters<typeof commitGeneratorOutputViaGit>[0]) => commitGeneratorOutputViaGit(o),
            packageScripts: readPackageScriptsFor(worktreePath),
          },
        });
      } catch (e) {
        // W1-T2402: a signal-terminated spawn (this fleet's own `killProcessGroup`/forced-deploy/
        // wall-clock-reclaim paths, or a genuine host OOM — indistinguishable by signal alone, see
        // `fixDispatchSignalDeath`'s own doc) used to be recoverable only by string-matching the
        // SDK's free-text message, and left `sweep.fix.error` with no `cost_usd` at all — the same
        // defect class W1-T2383 closed on the success path. `dispatchFixCatchOutcome` reads the
        // signal/cost structurally and decides `rethrow` off `dispatchStarted` ALONE, byte-for-byte
        // W1-T1127's existing rule — the signal itself never enters that decision.
        const outcome = dispatchFixCatchOutcome(e, dispatchStarted);
        log("sweep.fix.error", { pr_number: pr.prNumber, ...outcome.ledgerFields });
        // W1-T1127: still ledgered above (nothing is repaired by going quiet) — but a failure
        // that struck BEFORE the worker ran must propagate, not return cleanly, so `runSweep`'s
        // own `catch` (sweep.ts) records `acted: false` instead of seeding the dedup gate against
        // a head that wrote no `fix.*` row. A failure AFTER the worker ran (`dispatchStarted`)
        // stays swallowed here — that strike is real and must keep seeding the gate exactly as
        // it does today.
        if (outcome.rethrow) throw e;
      } finally {
        if (worktreePath) {
          try {
            worktreeRemove(repoDir, worktreePath);
          } catch {
            /* best-effort cleanup */
          }
        }
        // W1-T2609: release the branch claim LAST, on every exit path (return, decline, throw) —
        // symmetric with the worktree cleanup just above, so a lost race or a mid-round crash
        // never strands the claim past this round's own dispatch.
        branchClaim?.release();
      }
    },

    // W1-T177 SITE (iii): consulted by `runSweep` immediately before a
    // blocked-fixable disposition actually spends a fix-rung strike — see
    // `SweepDeps.readLiveState`'s own doc for the fail-open contract.
    readLiveState: (pr) => ghLiveState(pr.prUrl),

    // W1-T2752 — the outer, synchronous admission seam `runSweep` consults before EITHER
    // dispatch surface invokes `dispatchFix`. Reads the SAME process-lifetime `terminalHeads`
    // map (above) `dispatchFix`'s own `priorTerminal?.escalated` early-return already consults —
    // no second cache, no fresh GitHub read. Declines only the exact `PR@head SHA` whose
    // escalation was already delivered; a cached entry that has not yet delivered (or was never
    // cached at all) returns `undefined` and the ordinary dispatch path — including the failed-
    // delivery retry — runs unchanged.
    terminalFixStandDown: (pr) => {
      const terminal = terminalHeads.get(terminalUncreditableHeadKey(pr.prNumber, pr.headSha));
      // Written as two explicit checks, not `!terminal?.escalated` — that negated-optional-chain
      // shape is exactly the conflator test/catch-erasure-ratchet.test.ts's detector (b) exists to
      // hold at zero (it folds "no cached entry at all" and "cached but not yet delivered" into
      // one boolean the same way an erasing catch folds a failure and an absence together). Both
      // cases really do return the SAME `undefined` here — that is this seam's design (iv), not an
      // accidental erasure — but spelling it out keeps the two conditions separately legible.
      if (terminal === undefined || terminal.escalated !== true) return undefined;
      return `terminal uncreditable head already escalated for this PR@head (${TERMINAL_UNCREDITABLE_HEAD_ESCALATED_STEP})`;
    },

    // W1-T2789 — the sweep-level consumer of the SAME reversed-compare reader and exact-path
    // decision runFixRung already uses. This is deliberately not exposed through Serve.
    readRedBaseRefreshFacts: (pr) => redBaseRefreshFactsFromRest(owner, repo, pr.prNumber),

    // W1-T3422 — reached only after `selectStaleRedRelease` admits the cheap candidate; it shares the daemon REST pacer and has no retry/wait loop.
    readStaleRedWorkflowRuns: (pr) =>
      paceGhEntry(pacer, isGhRateLimitError, () => fetchWorkflowRunObservationsForBuild(owner, repo, pr.headSha, ghJson)),

    runStaleRedLocalRoute: (target) =>
      runIsolatedLocalMergeRoute(repoRoot, {
        prNumber: target.pr.prNumber,
        headSha: target.pr.headSha,
        mainSha: target.main.sha,
        route: target.route,
      }),

    releaseStaleRed: (target) => {
      if (!target.pr.headRefName) return undefined;
      return pushEmptyCommit(
        repoRoot,
        target.pr.headRefName,
        target.pr.headSha,
        `chore(ci): re-trigger stale check on #${target.pr.prNumber}\n\n` +
          `The required check ${target.failure.name} completed at ${target.failure.completedAt} before main repair ` +
          `${target.main.sha} (${target.main.committedAt}). Its declared local route passed on an isolated merge. ` +
          `This lease-protected empty commit mints a fresh head so GitHub recomputes the current check set. ` +
          `Automated by W1-T3422.`,
      );
    },

    // W1-T528 — the action half of W1-T520. `runSweep` calls this AT MOST ONCE per pass, on the
    // single PR `selectUpdateBranchTarget` chose — see `SweepDeps.updateBranch`'s own doc.
    updateBranch: (pr) => updateBranchImpl(pr),

    rebaseDirtyFleetBranch: (pr) =>
      rebaseDirtyFleetBranchImpl
        ? rebaseDirtyFleetBranchImpl(pr)
        : rebaseDirtyFleetBranchViaGit(
            repoDir,
            join(worktreesDir(config), `dirty-fleet-rebase-${pr.prNumber}-${nowMsImpl()}`),
            pr,
            { worktreeRemoveImpl: worktreeRemoveForBuild },
          ),

    // W1-T905 — "repair the instance, FILE THE CLASS". `runSweep` calls this AT MOST ONCE per
    // due surface, best-effort — see `SweepDeps.captureRepairFeedback`'s own doc.
    captureRepairFeedback: (filing) => captureRepairFeedbackImpl(filing),

    // One cached REST response supplies W1-T2620's SHA and W1-T3422's commit time. The older
    // lane may still use a valid SHA when the timestamp is absent; the newer lane cannot.
    readMainRepair,
    readMainTip: async () => (await readMainCommit())?.sha,

    // W1-T2620 (design iv) — THE LEAF IS THE ONE THAT EXISTS: the SAME `pushEmptyCommit` leaf
    // `repushAbsent` (above) and `sweepPostFixReverification`'s own redrive (this file) already
    // use — never a second outward path, and never `updateBranchImpl` (`armedButStalled`'s own
    // population is disjoint — green, armed, `behind` — from a base-caused PR, which is red by
    // construction; see `SweepDeps.releaseBaseCausedStandDown`'s own doc).
    releaseBaseCausedStandDown: async (pr, mainTipSha) => {
      if (!pr.headRefName) return;
      pushEmptyCommit(
        repoRoot,
        pr.headRefName,
        pr.headSha,
        `chore(ci): re-trigger checks on #${pr.prNumber}\n\n` +
          `This PR's red was base-caused — the one required check failing on every open PR the ` +
          `pass that stood it down last observed. Main has advanced to ${mainTipSha} since this ` +
          `head last stood down against an earlier tip. This empty commit mints a fresh head sha ` +
          `so the required checks recompute against CURRENT main. Automated by the base-caused ` +
          `release rung (W1-T2620).`,
      );
    },
  };
}


// Why: the pipeline was edge-triggered, so a verdict fired once and a missing consumer stranded
// the PR open-and-orphaned (#111/#113/#123) — docs/forensics/sweep.md.
/**
 * lib/sweep.ts — the level-triggered PR-pipeline reconciler (W1-T77, ratifies P22 core). Every
 * daemon poll and every `rmd sweep` re-derives each open PR's disposition from observed state, then
 * takes the one gated action. The predicate is a pure function of that state and the
 * {@link SweepPolicy} table (rule 2), never an LLM judgment. Worker liveness is run-state, so hung
 * workers are out of scope. INVARIANTS: {@link deriveDisposition} is total, so no open PR ends a
 * pass undisposed; each disposition writes one `sweep.disposed` line; actions dedup against the
 * ledger and fix dispatch is keyed on the head sha; a repeated (disposition, head_sha) pair
 * escalates ONCE at {@link SweepPolicy.repeatDispositionBound}; every effect is injected.
 */

/** One of the dispositions every open PR is reconciled into. */
export type Disposition =
  | "mergeable"
  | "blocked-fixable"
  | "refused-escalate"
  | "stale"
  | "blocked-ambiguous"
  | "dep-review"
  | "post-review"
  | "conflicted"
  | "wait";

/** W1-T920 — {@link SupersessionStatus} is THREE-VALUED, and "unreadable" is never collapsed into
 *  "unique". Only `"superseded"` may gate a CLOSE, and only carrying {@link SupersessionEvidence};
 *  `"unique"` is a positive "checked, none found" that lets a row YIELD (W1-T932);
 *  `"indeterminate"` means the read failed and never acts on any disposition. */

/** W1-T920 — {@link SupersessionDiffFinding} carries its OWN corpus control: a zero-hunk read is
 *  indistinguishable from a broken one on the hunk count alone, so `rawLineCount` must be non-zero
 *  before a verdict may claim `"superseded"`. // Why: the #1955 hand-diagnosis measured that shape. */

/** W1-T920 — {@link SupersessionEvidence} is what a `"superseded"` verdict NAMES rather than a bare
 *  label: the superseding PR number, the shared task id, and the diff finding with its own control.
 *  {@link SupersessionVerdict} is one PR's finding, READ and never computed by the disposition; its
 *  detector is a separate shard, so nothing in the real gateway sets one yet. */

/** One failing required CI check's name plus the tail of its log — the W1-T94 ci-log fix mode's
 *  ONLY input. Defined here, not in run-task.ts: {@link OpenPrView} carries it and run-task.ts
 *  already imports OpenPrView, so the reverse import would be circular. */
export interface CiFailure {
  name: string;
  logTail: string;
  /** Latest check conclusion preserved from the rollup so narrow infrastructure classifiers do
   * not have to infer FAILURE from the presence of a log. */
  conclusion?: string;
  /** The terminal time of the newest deduped failed attempt. It is deliberately not inferred
   * from `startedAt`: W1-T3422 can re-drive only after proving this verdict predates main's repair. */
  completedAt?: string;
  /** Actions job id parsed from the check's details URL. The bounded retry refuses to guess when
   * this is absent. */
  jobId?: string;
  /** The commit sha this failure is attributable to when the read identifies one (W1-T186);
   *  `undefined` in the ordinary case, where the check failed against the PR's own head.
   *  // Why: commitlint lints the whole base..head RANGE, so a required check can be tripped by a
   *  // commit that is not the PR's own (#420) — docs/forensics/sweep.md. */
  sha?: string;
  /** True when {@link sha} is OBSERVED to be outside this PR's own commit range — the #420 shape.
   *  Never asserted without positive evidence: merely unknown fails toward "assume it is the PR's
   *  own", never inventing an exoneration the read cannot support. */
  outsidePrRange?: boolean;
  /** WHY {@link logTail} is empty, when it is (W1-T2291, which split one empty tail into named
   *  causes). Present ONLY when the tail is empty and a cause was observed, absent whenever a tail
   *  was captured — so `logUnavailable !== undefined` never fires on a real tail. */
  logUnavailable?: CiLogUnavailableCause;
  /** WHICH source filled {@link logTail}. `"annotations"` is the fallback, reached only when the
   *  log read came back empty or failed, so a readable log can never be displaced by it. Absent
   *  exactly when {@link logUnavailable} is present — the two are complements. */
  tailSource?: CiTailSource;
  /** WHAT the annotation fallback did, when reached; absent entirely when the log answered. Kept
   *  separate from {@link logUnavailable} so a fallback can never take back the cause W1-T2291
   *  named. */
  annotationFallback?: CiAnnotationFallback;
}

export const ARTIFACT_FINALIZE_INTERMEDIARY_403 = "artifact-finalize-intermediary-403" as const;

export type CiInfrastructureFailureSignature = typeof ARTIFACT_FINALIZE_INTERMEDIARY_403;

export function classifyCiInfrastructureFailure(
  signal: Pick<CiFailure, "conclusion" | "logTail">,
): CiInfrastructureFailureSignature | undefined {
  if ((signal.conclusion ?? "").toUpperCase() !== "FAILURE") return undefined;
  const text = signal.logTail ?? "";
  if (
    /permission denied|resource not accessible by integration/i.test(text) ||
    /AssertionError|(?:^|\n)not ok\s+\d+|# fail\s+[1-9]\d*/i.test(text) ||
    /\berror TS\d{4}\b/i.test(text)
  ) {
    return undefined;
  }
  const uploadedAt = text.search(/artifact upload completed successfully/i);
  const finalizingAt = text.search(/finalizing artifact upload/i);
  const failedAt = text.search(
    /Failed to FinalizeArtifact[^\n]*(?:403[^\n]*Forbidden|Forbidden[^\n]*403)[^\n]*Error from intermediary/i,
  );
  if (uploadedAt >= 0 && finalizingAt > uploadedAt && failedAt > finalizingAt) {
    return ARTIFACT_FINALIZE_INTERMEDIARY_403;
  }
  return undefined;
}

/** W1-T2671/W1-T2789 — the two independently-observed facts required before a red branch may be
 *  refreshed from its base; an optional field is an honest unreadable result, never zero/empty. */
export interface RedBaseRefreshFacts {
  behindBy?: number;
  baseChangedFiles?: string[];
}

export interface RedBaseRefreshDecision {
  refresh: boolean;
  behindBy?: number;
  failingTestFiles: string[];
  failingSourceFiles: string[];
  matchingBaseFiles: string[];
}

// Locate the distinctive suffix first, then walk left for its ordinary path prefix: keeping prefix
// discovery out of the regexp keeps runtime linear on a corrupted log full of path delimiters.
const CI_TEST_PATH_SUFFIX = /\b(?:test|tests|__tests__)[\\/][A-Za-z0-9._@%+~\\/-]+\.(?:[cm]?[jt]sx?)/gi;
const CI_PATH_PREFIX_CHAR = /[A-Za-z0-9._:@%+~\\/-]/;

/** Extract only test-file paths from the CI evidence the fix rung receives. */
export function failingTestFilesFromCiFailures(failures: readonly CiFailure[]): string[] {
  const paths = new Set<string>();
  for (const failure of failures) {
    for (const text of [failure.name, failure.logTail]) {
      for (const match of text.matchAll(CI_TEST_PATH_SUFFIX)) {
        let start = match.index;
        while (start > 0 && CI_PATH_PREFIX_CHAR.test(text[start - 1])) start--;
        const end = match.index + match[0].length;
        paths.add(text.slice(start, end).replace(/^file:\/\//, "").replaceAll("\\", "/"));
      }
    }
  }
  return [...paths];
}

/** Extract source paths only from the existing, distinctive diff-coverage report. */
export function failingSourceFilesFromCiFailures(failures: readonly CiFailure[]): string[] {
  const report = diffCoverageReport(failures);
  if (!report) return [];
  return [...new Set(report.uncovered.map((pathLine) => pathLine.replace(/:\d+$/, "").replaceAll("\\", "/")))];
}

/** Exact repository path, or that complete path below an observed checkout prefix. */
function observedPathMatchesRepositoryPath(observedPath: string, repositoryPath: string): boolean {
  return observedPath === repositoryPath || observedPath.endsWith(`/${repositoryPath}`);
}

/** W1-T2671/W1-T2789 — the ONE pure exact-path decision shared by the fix rung and the sweep-level
 *  pre-exhaustion release, so neither caller can reinterpret a weak behind/path signal alone. */
export function decideRedBaseRefresh(
  failures: readonly CiFailure[],
  facts: RedBaseRefreshFacts,
): RedBaseRefreshDecision {
  const failingTestFiles = failingTestFilesFromCiFailures(failures);
  const failingSourceFiles = failingSourceFilesFromCiFailures(failures);
  const baseChangedFiles = facts.baseChangedFiles;
  const matchingBaseFiles =
    facts.behindBy !== undefined && facts.behindBy > 0 && baseChangedFiles !== undefined
      ? baseChangedFiles.filter((baseFile) =>
          [...failingTestFiles, ...failingSourceFiles].some((failureFile) =>
            observedPathMatchesRepositoryPath(failureFile, baseFile),
          ),
        )
      : [];
  return {
    refresh: matchingBaseFiles.length > 0,
    behindBy: facts.behindBy,
    failingTestFiles,
    failingSourceFiles,
    matchingBaseFiles,
  };
}

/** The sources {@link CiFailure.logTail} can come from, in preference order. */
export type CiTailSource = "log" | "annotations";

/** The outcome of the annotation fallback, recorded rather than folded into the log's own cause. */
export type CiAnnotationFallback =
  | { outcome: "recovered" }
  | { outcome: "empty" }
  | { outcome: "bare-exit-code" }
  | { outcome: "skipped-limit" }
  | { outcome: "failed"; detail: string };

/** The closed set of reasons a log tail came back empty — a NAMED outcome, never an absence.
 *  `no-job-id`: no Actions job id, so no read was attempted. `fetch-failed`: a read failed, `detail`
 *  carrying the observed error. `empty-log`: the read SUCCEEDED and the job printed nothing.
 *  MAX_CI_LOG_FAILURE_DETAIL is a BACKSTOP on that `detail`, not a primary control — what the fix
 *  prompt renders is — set far above any observed message, so a truncation is itself evidence. */
export const MAX_CI_LOG_FAILURE_DETAIL = 500;

export type CiLogUnavailableCause =
  | { kind: "no-job-id" }
  | { kind: "fetch-failed"; detail: string }
  | { kind: "empty-log" };

/**
 * One sentence naming why a log tail is missing, for BOTH consumers — run-task.ts's fix prompt and
 * this module's own escalation text — so the two can never describe the same cause differently.
 */
export function describeCiLogUnavailable(cause: CiLogUnavailableCause): string {
  switch (cause.kind) {
    case "no-job-id":
      return "log NOT read: this check reported no Actions job id, so no log fetch was attempted";
    case "fetch-failed":
      return `log NOT read: the log fetch was attempted and FAILED (${cause.detail})`;
    case "empty-log":
      return "log read successfully, but the job printed no failing output";
  }
}

/** PURE, deterministic classification (rule 2): a conflict is union-safe only when every
 *  conflicting file shows ZERO deletions on BOTH sides since the merge base. One deletion, or no
 *  file evidence at all, fails CLOSED — a wrong auto-resolution is worse than a strand (iii). */
export function isPureConcurrentAddition(files: readonly ConflictFileDiff[]): boolean {
  return files.length > 0 && files.every((f) => f.oursDeleted === 0 && f.theirsDeleted === 0);
}

/** W1-T2548 — THE DECLARED GENERATOR REGISTRY. For a path this table names, re-running the
 *  generator on the MERGED tree is correct by construction, so the resolution is not a merge at all.
 *  A path absent from the table stays refused: admission is bounded by a list a human wrote. Each
 *  value is the `package.json` script name — DATA (rule 2). // Why: docs/forensics/sweep.md. */
export const REGENERABLE_ARTIFACT_GENERATORS: Readonly<Record<string, string>> = Object.freeze({
  "scripts/source-size-baseline.json": "source-size-baseline:legacy",
  // W1-T3015 — THE TWIN GATE, REGISTERED AT LAST. `comment-load-ratchet` prints
  // "record it in scripts/comment-load-baseline.json" as its own remedy, exactly as the
  // source-size gate above prints its own, but that path was absent here — so committing the edit
  // the gate demanded read as an out-of-scope overrun, `renderFixPrompt` forbade it, and a
  // conflict on it was refused. That is the W1-T2650/W1-T2651 trap, still open for the twin.
  //
  // THE RECORDING SCRIPT, NOT THE SIGNAL TWIN. `comment-load-signal` passes `--no-record` and by
  // construction leaves the file byte-identical; registering it would declare a generator that
  // regenerates nothing.
  //
  // THE REGENERATION CLAIM HOLDS IN THE SAME SENSE IT HOLDS FOR THE ENTRY ABOVE, and no stronger.
  // `evaluateCommentLoadRatchet`'s `nextBaseline` is a function of the measured tree AND the
  // incoming baseline — a path that GREW keeps `recorded` rather than advancing to today's count.
  // The source-size generator has the identical shape (`nextBaseline[path] = recorded` on a
  // violation), so this inherits an admitted member's semantics and introduces no new class of
  // non-determinism. It is not pure over the tree alone, and neither is its twin.
  "scripts/comment-load-baseline.json": "comment-load-ratchet",
  "plan/plan-index.json": "plan-index",
  "docs/docs-index.json": "docs-index",
  "learnings/index.json": "learnings-index",
  "docs/cli-reference.md": "cli-reference",
  "MASTER-PLAN.md": "capability-snapshot",
  "packages/api-client/src/schema.d.ts": "api-client:generate",
});

/** W1-T2548 — PURE, deterministic (rule 2), admitted ALONGSIDE and never instead of
 *  {@link isPureConcurrentAddition}. Requires EVERY conflicting path to carry a declared generator,
 *  so a conflict straddling a hand-written path is refused WHOLE. Deletions are irrelevant: the
 *  generator re-run supersedes both recorded values regardless. */
export function isRegenerableArtifactConflict(
  files: readonly ConflictFileDiff[],
  generators: Readonly<Record<string, string>> = REGENERABLE_ARTIFACT_GENERATORS,
): boolean {
  return files.length > 0 && files.every((f) => Object.hasOwn(generators, f.path));
}

function coversEveryConflictPath(evidence: MergeConflictEvidence): boolean {
  const paths = new Set(evidence.redundantRefix?.comparedPaths ?? []);
  return evidence.files.length > 0 && evidence.files.every((f) => paths.has(f.path));
}

/** W1-T3273 — REDUNDANT-REFIX is a THIRD admission arm: resolving every conflicting path to
 *  main's bytes must have been performed already and recorded as byte evidence. This predicate
 *  refuses every prose/semantic lookalike by construction; task ids, commit subjects and
 *  similarity never enter the decision. */
export function isRedundantRefixConflict(evidence: MergeConflictEvidence | undefined): boolean {
  return (
    evidence?.redundantRefix?.compared === "bytes" &&
    evidence.redundantRefix.verdict === "main-byte-identical" &&
    coversEveryConflictPath(evidence)
  );
}

function redundantRefixConflictDeclineCause(evidence: MergeConflictEvidence | undefined): string | undefined {
  const redundant = evidence?.redundantRefix;
  if (!redundant) return undefined;
  if (redundant.compared !== "bytes") {
    return "redundant re-fix evidence was not a byte comparison";
  }
  if (!evidence || !coversEveryConflictPath(evidence)) {
    return "redundant re-fix byte comparison did not cover every conflicting path";
  }
  if (redundant.verdict === "different-from-main") {
    const paths = redundant.differingPaths?.length ? redundant.differingPaths.join(", ") : redundant.comparedPaths.join(", ");
    return `redundant re-fix byte comparison differed from main on ${paths}`;
  }
  if (redundant.verdict === "non-conflicting-files-failed") {
    const paths = redundant.failedApplyPaths?.length ? redundant.failedApplyPaths.join(", ") : "an uncaptured non-conflicting path";
    return `redundant re-fix byte comparison matched main, but non-conflicting files failed to apply: ${paths}`;
  }
  return undefined;
}

/** W1-T2548 — the conflicting path(s) the registry declares no generator for, so a refusal NAMES
 *  which path broke admission instead of making a reader re-derive it (acceptance 5). */
function undeclaredGeneratorPaths(
  files: readonly ConflictFileDiff[],
  generators: Readonly<Record<string, string>>,
): string[] {
  return files.filter((f) => !Object.hasOwn(generators, f.path)).map((f) => f.path);
}

/** W1-T2536/W1-T2548 — WHICH refusal disjunct fired, as a phrase for the row's `reason`: a
 *  deletion, no captured evidence, admission disabled, or the MIXED case straddling
 *  {@link REGENERABLE_ARTIFACT_GENERATORS}. The disabled arm is unreachable at the shipped default
 *  and written anyway, because the flag is policy DATA an operator may set false. */
export function conflictRefusalCause(
  files: readonly ConflictFileDiff[],
  policy: Pick<SweepPolicy, "mergeConflictAdmissionEnabled">,
  generators: Readonly<Record<string, string>> = REGENERABLE_ARTIFACT_GENERATORS,
  evidence?: MergeConflictEvidence,
): string {
  if (files.length === 0) return "no file evidence was captured";
  const redundantDecline = redundantRefixConflictDeclineCause(evidence);
  if (redundantDecline) return redundantDecline;
  if (files.some((f) => f.oursDeleted > 0 || f.theirsDeleted > 0)) {
    const undeclared = undeclaredGeneratorPaths(files, generators);
    // Name the offending path(s) only when the conflict STRADDLES the registry: where no path is
    // declared — the dominant hand-written shape — "involves a deletion" already says it all.
    if (undeclared.length > 0 && undeclared.length < files.length) {
      return `involves a deletion, and ${undeclared.join(", ")} ${undeclared.length === 1 ? "has" : "have"} no declared generator`;
    }
    return "involves a deletion";
  }
  if (policy.mergeConflictAdmissionEnabled !== true) {
    return "auto-resolution admission is disabled (mergeConflictAdmissionEnabled)";
  }
  return "not classifiable as a pure concurrent addition";
}

/** W1-T78 policy (rule 2) — how many strikes a fix-rung RE-DISPATCH gets once an operator answers a
 *  clarification question. Nested inside {@link SweepPolicy}, the config object every `runSweep`
 *  caller already threads, rather than a second separately-sourced policy object. */
export interface ClarifyPolicy {
  /** true (default): the answer resets the counter to a FRESH strikeCap. false: exactly one bounded extra strike. */
  resetStrikeCounterOnAnswer: boolean;
}

/** The default clarify policy — an answer earns a fresh full strikeCap. */
export const DEFAULT_CLARIFY_POLICY: ClarifyPolicy = { resetStrikeCounterOnAnswer: true };

/** Tunable thresholds as DATA (rule 2), never inlined constants in the predicate. A test proves
 *  that by tightening `staleDays` alone and flipping a fixture PR's disposition (acceptance 3). */
export interface SweepPolicy {
  /** No activity in >= this many days ⇒ the PR is abandoned -> close. */
  staleDays: number;
  /** Max fix-rung strikes before a failing review escalates instead of fixing. */
  strikeCap: number;
  /** W1-T78: re-dispatch strike-cap policy once an operator answers a clarification question. */
  clarify: ClarifyPolicy;
  /** W1-T121 QUEUE GOVERNOR — a WIP limit on DISPATCH ONLY: at or above this many open PRs, new
   *  dispatch is deferred, while drainage is never gated. Consumer: {@link checkQueueGovernor}.
   *  // Why: the 23-open-PR incident — docs/forensics/sweep.md. */
  wipLimit: number;
  /** W1-T172 (P19) — concurrent dispatch LANES a drain pass may fill, bounded by {@link wipLimit}:
   *  the governor is the CEILING, lanes only raise the rate it fills. Sourced from
   *  `plan/policy.yaml`. // Why: this also bounded the REVIEW lane until W1-T1049 split it out, and
   *  two ceilings added — docs/forensics/sweep.md. */
  dispatchLanes: number;
  /** W1-T1049 — THE REVIEW LANE'S OWN CONCURRENCY BUDGET, read directly off `plan/policy.yaml`.
   *  Floored at 1 in `runSweep`, so a misconfigured 0 can never mean "review nothing". A CEILING,
   *  NEVER A TARGET. // Why: it used to be a second read of {@link dispatchLanes}, and the two
   *  ceilings added to 6 workers on a host that fits about 4 — docs/forensics/sweep.md. */
  reviewLanes: number;
  /** Existing policy-row bounds plus the adaptive host/provider feedback thresholds. */
  reviewLaneMin: number;
  reviewLaneMax: number;
  reviewCapacity: ReviewCapacityPolicy;
  /** W1-T148 COST GOVERNOR — a DAILY spend ceiling on DISPATCH ONLY, never on drainage: stranding
   *  in-flight work to save money is the worse failure. Distinct from the PER-RUN cap, this is the
   *  cross-run daily total that cap cannot see. // Why: the $206/60-run spin loop, every run inside
   *  its own per-run cap. */
  dailyCostCeilingUsd: number;
  /** W1-T1038 — a DAILY-GOVERNOR TWIN of {@link dailyCostCeilingUsd}: the same dispatch-only shape
   *  with the OPPOSITE fail direction on an unreadable observation, enforced at the composition
   *  point. SHIPS AT 0, inert until an operator raises it against a figure not yet measured. */
  memoryFloorMib: number;
  /** W1-T114 — the STALENESS CEILING for the WAIT disposition: pending inside it means wait, at or
   *  beyond it the escalate path. A fixture proves this is data by lowering it and flipping a wait
   *  with no code change. A check still pending past it IS ambiguity, not merely in-flight. */
  pendingCeilingMinutes: number;
  /** How long an otherwise-mergeable PR may sit with a COMPLETELY EMPTY check rollup before the
   *  absent-check-suite remedy fires — the ABSENT-vs-PENDING discriminator's time half. See
   *  {@link absentChecksRepushDecision} for why a time bound is required at all. */
  absentCeilingMinutes: number;
  /** Retry threshold for ONE UNCHANGED review input, never a lifetime budget over historical heads:
   *  only completed judgments for the exact PR URL + head + body digest count, a new commit or body
   *  edit resets it, and refusals never consume it. // Why: W1-T1018 — reaching the cap no longer
   *  stops re-dispatch. See {@link reviewOrphanBackoffMinutes}. */
  reviewOrphanCap: number;
  /** W1-T1018 — THE ELAPSED-TIME BACKOFF that replaced permanent cessation: at the cap the sweep
   *  still escalates, but the lane resumes after this long. KEYED TO ELAPSED TIME, NEVER ATTEMPT
   *  COUNT — a delay keyed to attempts is a budget with pauses, exhausting into permanent silence. */
  reviewOrphanBackoffMinutes: number;
  /** W1-T905 — "repair the instance, FILE THE CLASS". A classified surface repaired for at least
   *  this many DISTINCT PRs inside {@link repairFilingWindowDays} is due exactly one
   *  `repair#<surface>` §7B entry. One occurrence is a repair, a recurrence is a defect, so the
   *  row's own `plan/policy.yaml` bound (min 2) forecloses filing on the first repair. */
  repairFilingThreshold: number;
  /** W1-T905 — the RECURRENCE WINDOW (days) {@link repairFilingThreshold} counts distinct-PR
   *  repairs within. See {@link dueRepairFilings}. */
  repairFilingWindowDays: number;
  /** W1-T920 — gates the SUPERSESSION row in {@link DISPOSITION_RULES}. `false` (the default) never
   *  consults `supersessionVerdict`, so behaviour is byte-for-byte today's. `true` lets a
   *  `"superseded"` verdict — never a bare `"unique"` or `"indeterminate"` — close the PR. */
  supersessionDisposalEnabled: boolean;
  /** W1-T932 — gates whether a `"unique"` verdict lets the BARE-NUMBER `stale` row YIELD, so a
   *  concept PR is not disposed stale merely because a higher-numbered sibling is open. Reads ONLY
   *  `status === "unique"` and FAILS CLOSED. // Why: a SEPARATE flag from
   *  {@link supersessionDisposalEnabled} — the blast radii differ. */
  conceptCoexistenceEnabled: boolean;
  /** W1-T984/W1-T2536 — GATES THE `conflicted` ROW. Shipped OFF awaiting a semantic predicate; turned
   *  ON because that predicate cannot live here — GitHub's COMPARE API never carries a HUNK. WHAT
   *  MAKES ADMITTING SAFE IS THE FENCE DOWNSTREAM: a wrong resolution mints a NEW HEAD and
   *  `remudero-review` is a required per-sha status, so the worst case is a red PR that escalates. */
  mergeConflictAdmissionEnabled: boolean;
  /** W1-T2998 — may a red ratchet whose remedy is a RECORDED NUMBER be repaired deterministically
   *  instead of spending an LLM fix round? DEFAULT FALSE, and deliberately the same shape as
   *  {@link mergeConflictAdmissionEnabled} above: an unattended write to a contributor's branch is
   *  an operator ratification, not a default. With it false the classifier still runs and still
   *  NAMES the remedy on the disposition reason — only the automatic repair is withheld. */
  recordableRatchetRepairEnabled?: boolean;
  /** W1-T3277 — may the update-branch rung refresh an ordinary open PR that has drifted far enough
   *  behind main even when it is not armed/stalled and not red with a stale gate. Same risk band as
   *  {@link mergeConflictAdmissionEnabled}: the write is unattended and targets contributor
   *  branches, so the predicate is policy-gated and distance-bounded rather than a default widening
   *  of the existing armed/stalled population. */
  reviewWaitingBranchRefreshEnabled?: boolean;
  /** W1-T3277 — how many commits behind main an open PR must be before the distance-refresh rung may
   *  press the existing update-branch button. Strictly greater-than: a value of 10 fires at 11, not
   *  at 10, matching the incident split that found red PRs at 10-11 behind and clean PRs at 1-8. */
  reviewWaitingBranchRefreshThreshold: number;
  /** W1-T2345 — THE UNBOUNDED-IDENTICAL-DISPOSITION BOUND: a repeated (disposition, head_sha) pair
   *  escalates once at this many consecutive rows; {@link repeatDispositionStreaksFromLedger} says
   *  why the key excludes the rendered `reason`. ONCE PER HEAD PER ROTATION WINDOW (W1-T2382):
   *  rotation selects against the marker, so the bound re-arms, and the window is BYTE-DRIVEN.
   *  NEVER PRE-EMPTS {@link pendingCeilingMinutes}. */
  repeatDispositionBound: number;
  /** W1-T2439 — HOW MANY PLAN-FILING PRs THE NON-SPAWNING REVIEW LANE MAY ADMIT PER LIGHT PASS; the
   *  spawning lane is bounded by {@link reviewLanes}. The number is DERIVED, not picked, from three
   *  measured quantities. // Why: the daemon hit "API rate limit already exceeded". */
  planFilingAdmissionBound: number;
}

/** The shipped default policy. A BOUNDED FAIL-SAFE (rule 2): an absent value falls back to a bounded
 *  default, never to unbounded spend, and the cost ceiling bounds RUNAWAY spend, not a budget.
 *  Several rows are COLLECTED from `plan/policy.yaml` rather than written as source literals, each a
 *  RELOCATION and never a retune. // Why: FROZEN AT IMPORT (W1-T331) — docs/forensics/sweep.md. */
const POLICY_SWEEP = loadDefaultPolicy().values.sweep;

/** W1-T1049 — reads `plan/policy.yaml`'s `sweep.reviewLanes` row DIRECTLY, never through
 *  `policy.ts`'s schema, which is outside this task's declared files. Validated like every other
 *  bounded numeric row, so a malformed row fails LOUD at load rather than falling back silently
 *  (rule 2). */
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

const REVIEW_CAPACITY_FIELDS = [
  "hostWorkerBudget",
  "workerMemoryReserveMib",
  "healthyWindowSamples",
  "sampleCadenceMs",
  "telemetryCadenceMs",
  "cpuPsiLowPct",
  "cpuPsiHighPct",
  "memoryPsiLowPct",
  "memoryPsiHighPct",
  "providerAllowancePct",
  "settlementWindowMs",
  "unhealthySettlementThreshold",
  "minHealthySettlements",
  "latencyExpansionRatio",
] as const satisfies readonly (keyof ReviewCapacityPolicy)[];

/** Direct bounded-row loader for W1-T2853's nested review-capacity policy. */
export function validateReviewCapacityPolicy(raw: unknown): ReviewCapacityPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyError("policy.yaml: 'sweep.reviewCapacity' must be a mapping of bounded numeric rows.");
  }
  const output = {} as Record<keyof ReviewCapacityPolicy, number>;
  for (const field of REVIEW_CAPACITY_FIELDS) {
    const row = (raw as Record<string, unknown>)[field];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}' must be a bounded numeric row.`);
    }
    const { value, min, max } = row as Record<string, unknown>;
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      typeof min !== "number" || !Number.isFinite(min) ||
      typeof max !== "number" || !Number.isFinite(max)
    ) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}' must carry finite value/min/max numbers.`);
    }
    if (min > max) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}' has min (${min}) > max (${max}).`);
    }
    if (value < min || value > max) {
      throw new PolicyError(
        `policy.yaml: 'sweep.reviewCapacity.${field}.value' (${value}) is out of its declared bound [${min}, ${max}].`,
      );
    }
    output[field] = value;
  }
  if (output.cpuPsiLowPct >= output.cpuPsiHighPct || output.memoryPsiLowPct >= output.memoryPsiHighPct) {
    throw new PolicyError("policy.yaml: review-capacity PSI low watermarks must be below their high watermarks.");
  }
  for (const field of ["hostWorkerBudget", "healthyWindowSamples", "unhealthySettlementThreshold", "minHealthySettlements"] as const) {
    if (!Number.isInteger(output[field]) || output[field] < 1) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}.value' must be a positive integer.`);
    }
  }
  if (output.sampleCadenceMs <= 0 || output.telemetryCadenceMs <= 0 || output.settlementWindowMs <= 0) {
    throw new PolicyError("policy.yaml: review-capacity cadence/window values must be positive.");
  }
  if (output.latencyExpansionRatio <= 1) {
    throw new PolicyError("policy.yaml: 'sweep.reviewCapacity.latencyExpansionRatio.value' must be greater than 1.");
  }
  return output;
}

/** Reads the row {@link validateReviewLanesRow} validates. Split from it so every refusal arm above
 *  is reachable from a test without a temp policy file on disk. */
function loadReviewPolicy(): { value: number; min: number; max: number; capacity: ReviewCapacityPolicy } {
  const path = installPolicyPath();
  const raw = parseYaml(readFileSync(path, "utf8")) as {
    sweep?: { reviewLanes?: unknown; reviewCapacity?: unknown };
  } | null;
  const value = validateReviewLanesRow(raw?.sweep?.reviewLanes);
  const row = raw?.sweep?.reviewLanes as Record<string, unknown>;
  return {
    value,
    min: row.min as number,
    max: row.max as number,
    capacity: validateReviewCapacityPolicy(raw?.sweep?.reviewCapacity),
  };
}
const REVIEW_POLICY = loadReviewPolicy();

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  staleDays: POLICY_SWEEP.staleDays,
  strikeCap: POLICY_SWEEP.strikeCap,
  clarify: DEFAULT_CLARIFY_POLICY,
  wipLimit: POLICY_SWEEP.wipLimit,
  dispatchLanes: POLICY_SWEEP.dispatchLanes,
  reviewLanes: REVIEW_POLICY.value,
  reviewLaneMin: REVIEW_POLICY.min,
  reviewLaneMax: REVIEW_POLICY.max,
  reviewCapacity: REVIEW_POLICY.capacity,
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
  // W1-T984 filed this OFF; W1-T2536 turns it ON — see the field's own doc for why the semantic
  // predicate W1-T984 waited for cannot live here, and what fences a wrong resolution instead.
  // Still NOT sourced from plan/policy.yaml: a hardcoded literal, the same choice
  // `conceptCoexistenceEnabled` just above already made.
  mergeConflictAdmissionEnabled: true,
  recordableRatchetRepairEnabled: POLICY_SWEEP.recordableRatchetRepairEnabled,
  // W1-T3277: flagged because this writes to contributor branches unattended. The threshold is the
  // measured split from 2026-09-09: ordinary clean PRs were 1-8 behind, red stale-base PRs 10-11.
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
  // W1-T2345: NOT sourced from plan/policy.yaml (see the field's own doc, above) — a hardcoded
  // literal, 50, derived against the merge-time population measured 2026-08-26 (see the field's
  // own doc for the full derivation), never a round number picked because it looked safe.
  repeatDispositionBound: 50,
  planFilingAdmissionBound: 3,
};

/** W1-T923 — one GATE failure whose remedy is a SINGLE, unambiguous form, so the fix rung can act
 *  on it directly. Never an unmet acceptance criterion — see {@link OpenPrView.actionableGateFailures}.
 *  `reason` is carried VERBATIM from the ledger's structured `reasons` array, never parsed out of
 *  `failure_reason` prose. */
export interface ActionableGateFailure {
  reason: string;
}

/** W1-T3172 — the two independently recorded halves of a Rule-25 refusal. These paths are
 * authority to launch W1-T2436's prerequisite worker only after
 * {@link usableInstrumentEntanglementPaths} validates both bounded, non-empty arrays. */
export interface InstrumentEntanglementPaths {
  instrumentPaths: string[];
  srcPaths: string[];
}

const MAX_INSTRUMENT_ENTANGLEMENT_PATHS = 64;
const MAX_INSTRUMENT_ENTANGLEMENT_PATH_LENGTH = 512;

/** Validate ledger-originated Rule-25 path evidence at every routing boundary. The ledger is
 * durable input, not trusted TypeScript memory: malformed, empty, or unbounded data must fail
 * closed to the existing ambiguous disposition rather than launch a worker with invented scope. */
export function usableInstrumentEntanglementPaths(value: unknown): value is InstrumentEntanglementPaths {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<InstrumentEntanglementPaths>;
  const usable = (paths: unknown): paths is string[] =>
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= MAX_INSTRUMENT_ENTANGLEMENT_PATHS &&
    paths.every(
      (path) =>
        typeof path === "string" &&
        path.trim().length > 0 &&
        path.length <= MAX_INSTRUMENT_ENTANGLEMENT_PATH_LENGTH,
    );
  return usable(candidate.instrumentPaths) && usable(candidate.srcPaths);
}

/** One open PR's OBSERVED state, as the sweep sees it — the input to the pure predicate. The real
 *  gateway builds this from `gh pr list --state open --json …` plus the review/CI derivation
 *  status.ts already does; tests inject fixtures. */
export interface OpenPrView {
  prNumber: number;
  prUrl: string;
  /** The task this PR credits (its `Remudero-Task:` trailer), if resolved. */
  taskId?: string;
  taskRetirement?: RetirementReason;
  /** Rolled-up remudero-review state on the head. */
  reviewState: "success" | "failure" | "pending" | "none";
  /** Rolled-up required-checks state on the head. */
  checksState: "green" | "red" | "pending" | "none";
  /** W1-T114 — ISO-8601 start of the NEWEST required check on this head, the WAIT disposition's
   *  only time input; populated when `checksState === "pending"`. Absent means the WAIT and
   *  stale-pending rows never match, failing toward the catch-all escalate rather than an
   *  indefinite silent wait on state we cannot date. */
  checksPendingSince?: string;
  /** W1-T913 — when the current head's pending was posted, the staleness clock the post-review row
   *  needs. `undefined` reads as STALE rather than fresh: re-driving a finished review is
   *  idempotent, stranding one whose state we cannot date is not. // Why: a naive pending post
   *  makes `reviewState` read "pending" forever — docs/forensics/sweep.md. */
  reviewPendingSince?: string;
  /** W1-T2844 — positive local-process evidence that the CURRENT head's pending review owner no
   *  longer exists. `undefined` covers live owners as well as identities that cannot be proved
   *  dead, which keep {@link reviewPendingIsStale}'s timeout behaviour. Only the real gateway sets
   *  this, from the durable pending ledger row. */
  reviewPendingOwnerDead?: boolean;
  /** W1-T2299 — when the current `reviewState` reading was posted, read off the same rollup entry
   *  already scanned. NOT A BODY-EDIT TIMESTAMP, and must never be documented as one: GitHub
   *  exposes no body-specific time field, so this detects ACTIVITY AFTER A VERDICT and a gaming
   *  edit buys a re-judgement, not a pass. `undefined` fails closed. */
  reviewVerdictPostedAt?: string;
  /** The unmet acceptance criteria from a failing review, `[]` otherwise. For a task-id-less PR,
   *  `buildOpenPrViews` populates this from the ledger under the same synthetic `PR-<n>` id
   *  `reviewCommand` uses. A non-empty list routes to `blocked-fixable`; it does not make the PR
   *  attributable to a plan task or widen {@link criteriaRecoverable}. */
  unmetCriteria: CriterionVerdict[];
  /** W1-T440 — true when a trailer resolved a task id, so {@link unmetCriteria} is attributable to
   *  a plan task. Row 7 reads it only after both fixable lists are empty, to say WHICH empty a
   *  failing review is. `undefined` is treated as `true`. // Why: deliberately NOT widened by the
   *  synthetic-key read, which would read as crediting an unattributed PR (#1527). */
  criteriaRecoverable?: boolean;
  /** W1-T923 — a SIBLING list to {@link unmetCriteria}, never a widening of it: what a GATE
   *  failure's own structured remedy populates. ONE ENTRY PER SINGLE-FORM REMEDY ONLY — a remedy
   *  offering a CHOICE is EXCLUDED entirely, because a worker picking wrong misattributes a
   *  ratified ruling. NEVER KEYED ON `failure_class`. // Why: #1991 named its exact remedy. */
  actionableGateFailures?: ActionableGateFailure[];
  /** W1-T3172 — exact-head, exact-input structured Rule-25 failure authority recovered from the
   *  latest matching `review.posted` row. Absent for stale, malformed, or other failure classes. */
  instrumentEntangled?: true;
  /** The validated path evidence paired with {@link instrumentEntangled}; both arrays are
   *  non-empty and bounded. Consumers still validate this field rather than trusting its type. */
  instrumentEntanglementPaths?: InstrumentEntanglementPaths;
  /** W1-T3309 — the structured Rule-25 cause of the LAST prerequisite-worker dispatch for this
   *  PR. This is deliberately separate from {@link instrumentEntanglementPaths}: the latter says
   *  what is failing NOW; this one proves a worker already tried to resolve that exact refusal.
   *  It is not head-keyed: a new head with the SAME refusal is the recurrence this stop exists to
   *  catch. Absent or malformed ledger evidence fails closed. */
  previousInstrumentEntanglementPaths?: InstrumentEntanglementPaths;
  /** Fix-rung strikes ALREADY attempted for this PR (from the ledger). */
  priorStrikes: number;
  /** W1-T2794 — the MERGED PR that already completed this PR's task, from the ownership-asserted
   *  credit projection ({@link CreditCandidate} with `merged: true`). STRICTLY STRONGER EVIDENCE
   *  than {@link supersededBy}, which means only that a higher-numbered OPEN peer shares the
   *  trailer: this one says the task is DONE, by a PR GitHub proves merged.
   *
   *  ⚠ ABSENT MEANS UNKNOWN, NEVER "NOT MERGED". Closing is destructive queue hygiene, so every
   *  darkness — no candidate set, an unreadable projection, a PR with no task id, or a candidate
   *  that does not read `merged: true` — leaves this undefined and the PR's disposition unchanged.
   *  Populated by {@link projectMergedTaskCandidates}; never inferred from YAML `status:`. */
  taskMergedBy?: number;
  /** A NEWER open PR crediting the same task supersedes this one. */
  supersededBy?: number;
  /** W1-T920 — a {@link SupersessionVerdict} for this PR, gated and default OFF. Distinct from
   *  {@link supersededBy}, a bare NUMBER matched on a shared trailer that design note (ii) forbids
   *  relying on alone: this carries a REASON, and its rows read ONLY `status` — close on
   *  `"superseded"`, yield on `"unique"` behind its own flag, and W1-T2779's yield on
   *  `"complementary"`. Fully wired but unpopulated today. */
  supersessionVerdict?: SupersessionVerdict;
  /** ISO-8601 timestamp of the PR's last activity (for the stale window). */
  lastActivityAt: string;
  /** W1-T1201 — read ONLY by {@link deriveDisposition}'s age clamp: A PR CANNOT BE IDLE LONGER
   *  THAN IT HAS EXISTED. Absent or unparseable reads as NO bound, never as "just created".
   *  // Why: eleven live PRs, hours old, were closed "no activity in 400d" by a shifted clock. */
  createdAt?: string;
  /** The head commit sha — keys fix-dispatch idempotence (a new push re-earns a strike). */
  headSha: string;
  /** The head BRANCH name, needed by the ABSENT-check-suite remedy, which pushes an empty commit
   *  to it to mint a fresh head sha. Optional so every existing fixture stays valid. */
  headRefName?: string;
  /** Current PR body, when the gateway already has it. Omitted means body-only repair rungs stand
   *  down to the pre-existing path rather than guessing. */
  body?: string;
  /** True only when the branch-derived task id resolved to a task record on main. */
  taskExistsOnMain?: boolean;
  /** Task ids whose plan records this PR added. Used only to refuse missing-trailer self-credit. */
  introducedTaskIds?: readonly string[];
  /** This PR's changed paths, when already observed by the gateway. */
  changedFiles?: readonly string[];
  /** The branch-derived task's declared files, when already observed from its main-plan record. */
  taskDeclaredFiles?: readonly string[];
  /** Observed: is GitHub auto-merge already armed on this PR? */
  autoMergeArmed: boolean;
  /** Head ref starts with `dependabot/` — routed to the W1-T54 dep-review lane and its own
   *  deterministic judge, NEVER the fix rung, which would push commits onto a Dependabot branch. */
  isDependabot?: boolean;
  /** W1-T528 — the operator's hold, and once auto-merge is armed the ONLY veto
   *  {@link selectUpdateBranchTarget} still checks for itself. The check is `=== true`, so an
   *  absent field leaves a PR eligible: GitHub refuses to arm a draft and only ARMED PRs reach
   *  here, so that narrow fail-open exposes just an operator drafting an already-armed PR. */
  isDraft?: boolean;
  /** W1-T196 — true when this PR files new tasks and so deliberately carries NO trailer; crediting
   *  a filing PR's own trailer would mark the task DONE on merge, before it is built. MUST be a
   *  POSITIVE signal from the emitter's own output — never inferred from the absent trailer, which
   *  would swallow a broken one. No producer sets it yet, so every unattributable PR escalates. */
  isPlanFiling?: boolean;
  planFilingSource?: "emitter-ledger" | "github-files" | "unreadable" | "not-plan-only";
  /** The failing review's one-line summary (context for fix/escalate). */
  reviewSummary?: string;
  /** Failing required-check name and log-tail evidence — the W1-T94 ci-log fix mode's input
   *  (W1-T100, the #170 fix). Populated when `checksState === "red"`, or when a child named by
   *  ci-gate's checked-in REQUIRED contract concluded red while the aggregate is still pending.
   *  `[]`/undefined degrades the fix prompt to "no detail captured", never a crash. */
  ciFailures?: CiFailure[];
  /** W1-T1223 — required checks whose LATEST attempt is CANCELLED with no later attempt on this
   *  head, distinct from a genuine failure ({@link ciFailures} names both). Never makes
   *  `checksState` anything but "red" — see {@link CancelledRequiredCheck}. */
  cancelledRequiredChecks?: CancelledRequiredCheck[];
  /** W1-T2504/W1-T2599 — concluded red children from ci-gate's checked-in REQUIRED contract. */
  redRequiredChecks?: string[];
  /** W1-T2340 — this head's own workflow runs, the raw input {@link stalledRunReason} reads.
   *  `undefined` when the listing could not be fetched, never degrading to `[]`, which would read
   *  as "GitHub scheduled nothing" instead of "we could not check". Not yet populated by the real
   *  gateway, so the new row never fires for existing callers. */
  workflowRuns?: readonly WorkflowRunObservation[];
  /** GitHub's own merge-conflict state, simplified (W1-T106, the #170 DIRTY strand) — see
   *  {@link MergeState}. `undefined`/`"unknown"` never disposition CONFLICTED (fail-closed): only
   *  an OBSERVED `"dirty"` does. */
  mergeState?: MergeState;
  /** GitHub's OWN raw `mergeable`, observed verbatim (W1-T186) and carried ALONGSIDE the
   *  simplified {@link mergeState} rather than replacing it, so an escalation names the exact fact
   *  GitHub reported rather than the bucket it was sorted into. // Why: a dirty PR registers ZERO
   *  check runs, so an escalation reading only checks and review had to misdescribe it (#412/#413). */
  mergeable?: boolean;
  /** GitHub's OWN raw `mergeable_state` string ("clean" | "dirty" | "blocked" | "behind" |
   *  "unstable" | "unknown" | …), observed verbatim (W1-T186, alongside {@link mergeable}) — the
   *  escalation names THIS reported value, never only the {@link MergeState} bucket. */
  mergeableState?: string;
  /** The merge-conflict fix mode's input — the conflicting file list plus both sides' log since
   *  the merge base (W1-T94's new mode, design note iii). Populated when `mergeState === "dirty"`,
   *  mirroring how `ciFailures` is populated only when `checksState === "red"`. */
  mergeConflict?: MergeConflictEvidence;
  /** What each recorded fix-rung strike TRIED for this PR's task, ledger ground truth only
   *  (W1-T78) — the clarification rung's input. `[]`/undefined when no strike is recorded, as for
   *  the terminal catch-all, which never dispatched a fix. */
  strikeHistory?: StrikeAttempt[];
  /** An operator's answer to a prior clarification question (W1-T78). Its `constraint` feeds the
   *  next fix dispatch VERBATIM, never a silent guess, and routes the PR to `blocked-fixable` even
   *  at cap, so the answer re-arms the rung rather than immediately re-exhausting it. Wired
   *  end-to-end and tested, but nothing populates it today. */
  pendingAnswer?: { constraint: string; resetStrikeCounter?: boolean };
  /** W1-T176 — true when the ledger already carries a refusal for this exact task/PR/head/body
   *  input. It separates a FIRST-SEEN zero-runs required check, which still routes to post-review,
   *  from a SECOND absence for the unchanged input, which escalates. A transient `gh` error
   *  deliberately does NOT set this, and a new commit or body edit re-earns one attempt. */
  reviewPostRefused?: boolean;
  /** W1-T176 — true when THIS pass could not read branch protection's required-contexts list, which
   *  gates the zero-runs discriminator rows OFF: without that list we cannot POSITIVELY confirm the
   *  review is required here, and calling its absence decidable would assume permissive on missing
   *  information. `true` routes to the catch-all — blocked-ambiguous, never mergeable. */
  requiredContextsUnreadable?: boolean;
  /** W1-T2399 — WHY the required-contexts read was unreadable, captured where the read happens so
   *  the escalation names it without a second GitHub call. Present only on a genuine read failure;
   *  protection that readably declares NO required contexts leaves this undefined. */
  requiredContextsReadFailure?: { branch: string; reason: string };
  /** W1-T225 — true when the ledger carries a review outcome for this task at an EARLIER head: the
   *  PR has been reviewed, just not on the head being looked at now. Changes only the REASON the
   *  post-review row states, never the dispatch — either way the remedy is a FRESH verdict, and a
   *  verdict from a superseded head is never copied forward. */
  reviewOrphanedByPush?: boolean;
  /** Completed judgments for the exact current input: task key, PR URL, head sha and body digest. A
   *  new commit or body edit resets this to zero; refusals and legacy rows never count. Recovering
   *  from a GitHub FAILURE with no matching judgment additionally requires an explicit zero and
   *  {@link reviewInputDigest}, so an unwired caller is never mistaken for evidence. */
  priorReviewAttemptsForInput?: number;
  /** Most recent completed `review.posted` timestamp for the same exact input counted above.
   *  Refusals never move this clock, having judged no content. Undefined means no completed
   *  attempt is known, and {@link reviewInputBackoffElapsed} then fails toward escalation. */
  reviewInputLastAttemptAt?: string;
  /** Versioned digest of the current head+body review input. Real gateway views always populate
   * it; omitted test/legacy callers retain the historical per-head outcome-dedup behavior. */
  reviewInputDigest?: string;
}

/** The disposition derived for one PR, plus a stated human reason. */
export interface DispositionResult {
  disposition: Disposition;
  reason: string;
}

/** One PR status-check-rollup entry, structurally — a CheckRun or StatusContext as `gh pr
 *  list/view --json statusCheckRollup` reports it. Names ONLY the fields
 *  {@link checksStateFromRollup} reads, so this deterministic core never depends on run-task.ts's
 *  richer `RollupCheck`, which stays structurally assignable without an import. */
export interface RollupCheckEntry {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  /** When this attempt started (W1-T457). gh's own exporter populates it for BOTH rollup shapes —
   *  a CheckRun's `startedAt`, a StatusContext's mapped `createdAt` — so it is present on every
   *  entry the real gateway reports, and is what {@link dedupeRollupByLatestAttempt} sorts on. */
  startedAt?: string;
  /** Terminal completion time, when the source transport supplied it. This does not participate
   * in attempt ordering; {@link startedAt} remains the stable rollup dedupe key. */
  completedAt?: string;
  /** Actions job details URL when this entry is a check run. Preserved so the main-health reader
   * can feed the same job-id-bearing evidence producer as the PR sweep. */
  detailsUrl?: string;
}

/** Conclusions GitHub's OWN merge-eligibility treats as SATISFYING a required check (W1-T103):
 *  SKIPPED and NEUTRAL count as green, so only a genuinely unresolved check holds "pending".
 *  EXPORTED so the poll loops read the SAME ok-set this file's predicate reads, rather than a
 *  narrower private copy that read a cleanly-concluded NEUTRAL as still pending. */
export const REQUIRED_CHECK_OK = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/** Conclusions that veto a required check outright. EXPORTED (W1-T457) so the failing-list PRODUCER
 *  filters on the same set this file's PREDICATE vetoes on and the two cannot drift. STALE is
 *  folded in here rather than given a fifth `checksState` member, exactly as CANCELLED is: it means
 *  "this reading is void". // Why: the drift — docs/forensics/sweep.md. */
export const REQUIRED_CHECK_FAIL = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

/** Group rollup entries by check name or status context and keep ONLY the latest
 *  {@link RollupCheckEntry.startedAt} — ci-gate's own dedupe rule, copied rather than reinvented.
 *  An entry with no `startedAt` sorts OLDER and a tie keeps the LAST encountered. // Why: a sha
 *  accumulates one entry PER ATTEMPT, so a superseded CANCELLED entry read "red" forever. */
export function dedupeRollupByLatestAttempt<T extends RollupCheckEntry>(rollup: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const c of rollup) {
    const key = c.name ?? c.context ?? "";
    const prior = latest.get(key);
    if (!prior || (c.startedAt ?? "") >= (prior.startedAt ?? "")) latest.set(key, c);
  }
  return [...latest.values()];
}

/** Aggregate ONLY the REQUIRED contexts into `checksState` (W1-T103). `requiredContexts` is branch
 *  protection's OWN list, threaded in rather than hardcoded (rule 2). UNREADABLE PROTECTION FAILS
 *  CLOSED — every reported context counts, because an unreadable rule must never manufacture a false
 *  green. `remudero-review` IS EXCLUDED UNCONDITIONALLY (W1-T394), even in that fallback: counting
 *  it made a red review indistinguishable from red CI. Deduped before judging.
 *  // Why: the #170 and #1441 incidents — docs/forensics/sweep.md. */
export function checksStateFromRollup(
  rollup: RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
): OpenPrView["checksState"] {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  if (all.length === 0) return "none";
  const required = new Set(requiredContexts ?? []);
  const knownRequired = required.size > 0;
  // Dedupe to ONE entry per check name — the LATEST attempt — before judging. Dedup cannot change
  // whether `gate` is empty (grouping merges rows sharing a key, it never drops one), so the
  // "required but not yet registered" distinction just below is unaffected (W1-T457).
  const gate = dedupeRollupByLatestAttempt(
    knownRequired ? all.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? "")) : all,
  );
  // Required contexts are configured but none has registered on this head yet
  // (e.g. the workflow hasn't started) — waiting, not "no checks at all".
  if (gate.length === 0) return knownRequired ? "pending" : "none";
  // ONE OK-SET, KNOWN CONTEXTS OR NOT. REQUIRED_CHECK_OK's doc is a claim about GITHUB'S
  // merge-eligibility semantics, which do not change because OUR token could not read protection.
  // NOT widened to a new `unknown` state: a fifth member every existing row silently fails to match
  // is the false-predicate-falls-through shape that produced the issue storm.
  const ok = REQUIRED_CHECK_OK;
  let anyPending = false;
  for (const c of gate) {
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (REQUIRED_CHECK_FAIL.has(s)) return "red";
    if (!ok.has(s)) anyPending = true;
  }
  return anyPending ? "pending" : "green";
}

/** W1-T1223 — one required check whose LATEST attempt is CANCELLED. `checksState` stays "red"
 *  exactly as for a genuine failure; a fifth member is refused for the reason
 *  {@link checksStateFromRollup} gives. The SEPARATE observable naming which red check is an ABSENT
 *  verdict rather than a bad one, so the job can be re-queued instead of a worker dispatched. */
export interface CancelledRequiredCheck {
  name: string;
  /** GitHub Actions job id, parsed by the real gateway from the rollup's own `detailsUrl` — the
   *  re-queue target is the JOB (design iv), never the workflow run. `undefined` when none could
   *  be read, and the real `requeueCheck` wiring then degrades to a named no-op. */
  jobId?: string;
  /** W1-T2431 — GitHub's OWN `run_attempt`, read off the SAME rollup {@link jobId} is parsed from:
   *  no new gateway, no new credential. A SURFACE the fleet does not write, so it counts an
   *  operator's own re-run too. No producer sets it today — a WIDENING of the `true` case, never a
   *  replacement that could narrow it. */
  runAttempt?: number;
}

/** W1-T2431 — whether this check's run has already been re-run, read off GitHub's own `runAttempt`
 *  rather than a ledger row the fleet wrote about its own action. Being ground truth it reads true
 *  for ANY actor and survives rotation. `undefined` or `<= 1` reads as "not yet re-run": an unread
 *  value must never MANUFACTURE a prior re-queue. Callers OR this with the ledger set. */
export function cancelledCheckAlreadyRequeuedFromSurface(runAttempt: number | undefined): boolean {
  return typeof runAttempt === "number" && runAttempt > 1;
}

/** W1-T1223 — which check has a LATEST (deduped) attempt that is CANCELLED. A genuinely FAILING
 *  check is never named: only the literal CANCELLED conclusion separates "nobody reached a verdict"
 *  from "a verdict came back bad". An unreadable `requiredContexts` names nothing. W1-T2283 dropped
 *  the `required` membership test, bringing the arm that ACTS into agreement with the miner. */
export function cancelledRequiredCheckNames(
  rollup: RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
): string[] {
  const required = new Set(requiredContexts ?? []);
  if (required.size === 0) return [];
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  const gate = dedupeRollupByLatestAttempt(all);
  return gate
    .filter((c) => (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase() === "CANCELLED")
    .map((c) => c.name ?? c.context ?? "unknown");
}

export const redQualityGateNames = (rollup: RollupCheckEntry[] | undefined, requiredCheckNames: Iterable<string> | undefined): string[] => dedupeRollupByLatestAttempt((rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT && ([...(requiredCheckNames ?? [])].includes(c.name ?? "") || [...(requiredCheckNames ?? [])].includes(c.context ?? "")))).filter((c) => REQUIRED_CHECK_FAIL.has((c.state ?? c.conclusion ?? c.status ?? "").toUpperCase())).map((c) => c.name ?? c.context ?? "unknown"); // W1-T2504

/** Job-level statuses {@link stalledRunReason} treats as that job having reached a final state. */
const JOB_TERMINAL_STATUSES = new Set(["completed"]);

/** W1-T2340 — names the reason a head's workflow runs read as STALLED rather than pending. THE
 *  DISCRIMINATOR: a job whose STATUS is non-terminal inside a run whose CONCLUSION is terminal —
 *  NOT an absence of jobs, which the reading measurement falsified. It needs no threshold, so this
 *  takes no `policy` or `now`, and every unreadable input FAILS TOWARD "NOT STALLED". */
export function stalledRunReason(runs: readonly WorkflowRunObservation[] | undefined): string | undefined {
  if (runs === undefined) return undefined;
  for (const run of runs) {
    const conclusion = (run.conclusion ?? "").trim();
    if (conclusion === "") continue; // run still in progress — untouched, not this function's concern
    const stuck = (run.jobs ?? []).find((j) => !JOB_TERMINAL_STATUSES.has((j.status ?? "").toLowerCase()));
    if (stuck) {
      return (
        `a job is still "${stuck.status ?? "unstarted"}" but its own run already concluded "${conclusion}" — ` +
        `a terminal run schedules nothing further, so that job will never move`
      );
    }
  }
  return undefined;
}

/** W1-T1278 — of the checks a fix rung believes are red, which are STILL red on a FRESH rollup read.
 *  A name is dropped ONLY for an observed `startedAt` with a currently NON-TERMINAL status —
 *  deliberately narrower than "no longer red", because one notch wider is "never fix a red PR". A
 *  name absent from the fresh rollup is NEVER dropped: an unreadable rollup manufactures nothing. */
export function stillRedRequiredNames(redNames: readonly string[], rollup: RollupCheckEntry[] | undefined): string[] {
  if (redNames.length === 0) return [];
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  const deduped = dedupeRollupByLatestAttempt(all);
  const byKey = new Map(deduped.map((c) => [c.name ?? c.context ?? "", c] as const));
  return redNames.filter((name) => {
    const fresh = byKey.get(name);
    if (!fresh || !fresh.startedAt) return true; // unreadable/absent — fail open, still red
    const s = (fresh.state ?? fresh.conclusion ?? fresh.status ?? "").toUpperCase();
    const inFlight = !REQUIRED_CHECK_OK.has(s) && !REQUIRED_CHECK_FAIL.has(s);
    return !inFlight; // an OBSERVED later attempt still running is the ONLY thing dropped
  });
}

/** One re-queue/escalate decision for one cancelled required check. */
export interface CancelledCheckRequeueDecision {
  requeue: boolean;
  escalate: boolean;
  reason: string;
}

/** W1-T1223 — BOUNDED BY A LEDGERED RECORD, never a clock or an in-memory counter. Zero priors
 *  re-queues once; a SECOND observation of the same pair escalates instead of repeating. One
 *  re-queue is either sufficient, for a preempted runner, or diagnostic, for a fault re-queueing
 *  cannot reach. */
export function cancelledCheckRequeueDecision(alreadyRequeued: boolean): CancelledCheckRequeueDecision {
  if (alreadyRequeued) {
    return {
      requeue: false,
      escalate: true,
      reason: "already re-queued once on this head sha and cancelled again — a second cancellation is beyond what re-queueing can reach",
    };
  }
  return {
    requeue: true,
    escalate: false,
    reason: "latest attempt was cancelled with no later attempt on this head — re-queueing the job once",
  };
}

/** The ledger step {@link requeuedCheckKeysFromLedger} reads back — one row per re-queue attempt. */
export const CHECK_REQUEUE_STEP = "sweep.check_requeued";

/** W1-T1223 — every `${headSha}@${checkName}` pair the ledger already records a
 *  {@link CHECK_REQUEUE_STEP} row for. `runSweep` writes the row BEFORE calling
 *  `deps.requeueCheck`, so a pass crashing between the write and the GitHub call still bounds the
 *  next pass toward escalating — the safer direction for an unattended CI mutation. */
export function requeuedCheckKeysFromLedger(lines: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.step === CHECK_REQUEUE_STEP && typeof l.head_sha === "string" && typeof l.check_name === "string") {
      out.add(`${l.head_sha}@${l.check_name}`);
    }
  }
  return out;
}

// ── W1-T2204 — MAIN'S OWN CHECK ROLLUP HAS NO READER ─────────────────────────────────────────
//
// Every predicate above reads a PR's rollup; nothing reads the DEFAULT BRANCH's own. This section is
// that reader — a pure transform to a NAMED observation of main's health — plus two decisions kept
// separate: whether to escalate, and whether that escalation may by itself stand down dispatch of
// unrelated tasks (it may not). SKIPPED counts as green for a PR but not for main, so skipped and
// known-vacuous names cannot make the verdict green.

/** Check names KNOWN, from the workflow's own guard, to conclude SUCCESS on a push having executed
 *  no real work. The check-runs API carries no "did this job do anything" field, so this is a NAMED,
 *  CITED allowlist (policy-as-data, rule 2): a future vacuous-on-push job is added BY NAME. */
export const PUSH_VACUOUS_SUCCESS_CHECK_NAMES: ReadonlySet<string> = new Set(["coverage-ratchet"]);

/** Main's health read off its own rollup — the default-branch sibling of `checksState`. "green": a
 *  required check GENUINELY concluded passing, none failed, none outstanding. "red": never
 *  auto-acted on beyond an escalation. "undetermined": still running, or every concluded check
 *  skipped or known-vacuous — NEVER collapsed into "green", the vacuous pass this reader refuses. */
export type MainHealthState = "green" | "red" | "undetermined";

/** One named observation of main's own check rollup (acceptance 1) — never a bare boolean. */
export interface MainHealthObservation {
  readonly state: MainHealthState;
  readonly sha: string;
  /** Human-readable reason the state landed where it did — carried into any escalation. */
  readonly reason: string;
  /** Required check names whose latest (deduped) attempt concluded with a failing conclusion. */
  readonly failingChecks: readonly string[];
  /** Required check names skipped, or known-vacuous-success — excluded from evidence either way. */
  readonly nonEvidenceChecks: readonly string[];
  /** Required check names with no terminal conclusion yet. */
  readonly pendingChecks: readonly string[];
  /** Failing node-test titles parsed from the failed check log, capped for operator readability. */
  readonly failingTestTitles?: readonly string[];
  /** Count of parsed failing test titles hidden behind the cap. */
  readonly hiddenFailingTestTitleCount?: number;
  /** The boundary commit for the current red-main streak, when the fetched window proves one. */
  readonly firstRedCommit?: MainHealthFirstRedCommit;
  /** True when the fetched run-history window never reached the preceding green run. */
  readonly runHistoryWindowExhausted?: boolean;
  /** Named soft-failures from optional enrichment reads. */
  readonly enrichmentFailures?: readonly string[];
}

/** PRIMARY CONTROL: maximum failing test titles named in one MAIN-HEALTH escalation. */
export const MAIN_HEALTH_FAILING_TEST_TITLE_CAP = 3;

export interface MainHealthPullRequestRef {
  readonly number?: number;
  readonly url?: string;
}

export interface MainHealthRunHistoryEntry {
  readonly headSha: string;
  readonly conclusion?: string;
  readonly url?: string;
  readonly pullRequests?: readonly MainHealthPullRequestRef[];
}

export interface MainHealthFirstRedCommit {
  readonly headSha: string;
  readonly afterGreenSha: string;
  readonly runUrl?: string;
  readonly pullRequest?: MainHealthPullRequestRef;
}

export interface MainHealthEnrichment {
  readonly ciFailures?: readonly CiFailure[];
  readonly ciFailuresUnavailable?: string;
  readonly runHistory?: readonly MainHealthRunHistoryEntry[];
  readonly runHistoryUnavailable?: string;
  readonly failingTestTitleCap?: number;
}

export interface MainHealthFailingTestTitleSummary {
  readonly titles: readonly string[];
  readonly hiddenCount: number;
  readonly logFailures: readonly string[];
}

function mainHealthFailureConclusion(conclusion: string | undefined): boolean {
  return REQUIRED_CHECK_FAIL.has((conclusion ?? "").toUpperCase());
}

function mainHealthSuccessConclusion(conclusion: string | undefined): boolean {
  return (conclusion ?? "").toUpperCase() === "SUCCESS";
}

export function mainHealthFailingTestTitles(
  failures: readonly CiFailure[],
  failingChecks: readonly string[],
  cap: number = MAIN_HEALTH_FAILING_TEST_TITLE_CAP,
): MainHealthFailingTestTitleSummary {
  const failingCheckSet = new Set(failingChecks);
  const titles: string[] = [];
  const seen = new Set<string>();
  const logFailures: string[] = [];
  for (const failure of failures) {
    if (failingCheckSet.size > 0 && !failingCheckSet.has(failure.name)) continue;
    if (failure.logUnavailable) {
      logFailures.push(`failing test log NOT read for ${failure.name}: ${describeCiLogUnavailable(failure.logUnavailable)}`);
    }
    for (const line of failure.logTail.split("\n")) {
      const title = line.match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/i)?.[1]?.trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      titles.push(title);
    }
  }
  const boundedCap = Math.max(0, cap);
  return {
    titles: titles.slice(0, boundedCap),
    hiddenCount: Math.max(0, titles.length - boundedCap),
    logFailures,
  };
}

export function mainHealthFirstRedCommitFromRunHistory(
  history: readonly MainHealthRunHistoryEntry[],
): MainHealthFirstRedCommit | "window-exhausted" | undefined {
  if (!history.some((run) => mainHealthFailureConclusion(run.conclusion))) return undefined;
  if (!history.some((run) => mainHealthSuccessConclusion(run.conclusion))) return "window-exhausted";
  let greenSha: string | undefined;
  for (const run of [...history].reverse()) {
    if (mainHealthSuccessConclusion(run.conclusion)) {
      greenSha = run.headSha;
      continue;
    }
    if (greenSha && mainHealthFailureConclusion(run.conclusion)) {
      const [pullRequest] = run.pullRequests ?? [];
      return {
        headSha: run.headSha,
        afterGreenSha: greenSha,
        ...(run.url ? { runUrl: run.url } : {}),
        ...(pullRequest ? { pullRequest } : {}),
      };
    }
  }
  return undefined;
}

export function enrichMainHealthObservation(
  observation: MainHealthObservation,
  enrichment: MainHealthEnrichment,
): MainHealthObservation {
  if (observation.state !== "red") return observation;
  const enrichmentFailures: string[] = [];
  let failingTestTitles: readonly string[] | undefined;
  let hiddenFailingTestTitleCount: number | undefined;
  if (enrichment.ciFailures) {
    const summary = mainHealthFailingTestTitles(
      enrichment.ciFailures,
      observation.failingChecks,
      enrichment.failingTestTitleCap,
    );
    failingTestTitles = summary.titles;
    hiddenFailingTestTitleCount = summary.hiddenCount;
    enrichmentFailures.push(...summary.logFailures);
  } else if (enrichment.ciFailuresUnavailable) {
    enrichmentFailures.push(`failing test log NOT read: ${enrichment.ciFailuresUnavailable}`);
  }

  let firstRedCommit: MainHealthFirstRedCommit | undefined;
  let runHistoryWindowExhausted: boolean | undefined;
  if (enrichment.runHistory) {
    const boundary = mainHealthFirstRedCommitFromRunHistory(enrichment.runHistory);
    if (boundary === "window-exhausted") {
      runHistoryWindowExhausted = true;
    } else {
      firstRedCommit = boundary;
    }
  } else if (enrichment.runHistoryUnavailable) {
    enrichmentFailures.push(`main push run history NOT read: ${enrichment.runHistoryUnavailable}`);
  }

  return {
    ...observation,
    ...(failingTestTitles ? { failingTestTitles } : {}),
    ...(hiddenFailingTestTitleCount !== undefined ? { hiddenFailingTestTitleCount } : {}),
    ...(firstRedCommit ? { firstRedCommit } : {}),
    ...(runHistoryWindowExhausted !== undefined ? { runHistoryWindowExhausted } : {}),
    ...(enrichmentFailures.length > 0 ? { enrichmentFailures } : {}),
  };
}

function mainHealthOperatorDetail(observation: MainHealthObservation): string {
  const lines: string[] = [];
  const titles = observation.failingTestTitles ?? [];
  if (titles.length > 0) {
    const more = observation.hiddenFailingTestTitleCount ? ` (+${observation.hiddenFailingTestTitleCount} more)` : "";
    lines.push(`failing test title(s): ${titles.join("; ")}${more}`);
  }
  if (observation.firstRedCommit) {
    const pr = observation.firstRedCommit.pullRequest;
    const prText = pr?.number
      ? `; merged PR #${pr.number}${pr.url ? ` (${pr.url})` : ""}`
      : "; merged PR unavailable from the fetched run";
    const runText = observation.firstRedCommit.runUrl ? `; run ${observation.firstRedCommit.runUrl}` : "";
    lines.push(
      `first red main push run: ${observation.firstRedCommit.headSha}${prText}; after ${observation.firstRedCommit.afterGreenSha} was green${runText}`,
    );
  } else if (observation.runHistoryWindowExhausted) {
    lines.push("main push run history window exhausted before a successful run; no first-red commit named");
  }
  lines.push(...(observation.enrichmentFailures ?? []));
  return lines.length > 0 ? ` ${lines.join(". ")}.` : "";
}

/** Read main's rollup into a {@link MainHealthObservation}, reusing the exact dedupe and
 *  required-contexts filter {@link checksStateFromRollup} applies so the two can never disagree
 *  about which entries are in play — but judging them against a STRICTER question: skipped and
 *  known-vacuous members never count as evidence, and an outstanding check reads "undetermined". */
export function mainHealthFromRollup(
  sha: string,
  rollup: readonly RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
  vacuousSuccessNames: ReadonlySet<string> = PUSH_VACUOUS_SUCCESS_CHECK_NAMES,
): MainHealthObservation {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  const required = new Set(requiredContexts ?? []);
  const knownRequired = required.size > 0;
  const gate = dedupeRollupByLatestAttempt(
    knownRequired ? all.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? "")) : all,
  );

  if (gate.length === 0) {
    return {
      state: "undetermined",
      sha,
      reason: knownRequired
        ? "required checks are configured but none have registered yet on main's head — undetermined, not green"
        : "no check-run rollup observed for main's head — undetermined, not green",
      failingChecks: [],
      nonEvidenceChecks: [],
      pendingChecks: [],
    };
  }

  const failingChecks: string[] = [];
  const nonEvidenceChecks: string[] = [];
  const pendingChecks: string[] = [];
  let evidenceOfGreen = false;
  for (const c of gate) {
    const name = c.name ?? c.context ?? "unknown";
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (REQUIRED_CHECK_FAIL.has(s)) {
      failingChecks.push(name);
    } else if (s === "SKIPPED" || vacuousSuccessNames.has(name)) {
      nonEvidenceChecks.push(name);
    } else if (s !== "SUCCESS" && s !== "NEUTRAL") {
      pendingChecks.push(name);
    } else {
      evidenceOfGreen = true;
    }
  }

  if (failingChecks.length > 0) {
    return {
      state: "red",
      sha,
      reason: `required check(s) concluded failing on main: ${failingChecks.join(", ")}`,
      failingChecks,
      nonEvidenceChecks,
      pendingChecks,
    };
  }
  if (pendingChecks.length > 0) {
    return {
      state: "undetermined",
      sha,
      reason: `required check(s) still pending on main, not yet concluded: ${pendingChecks.join(", ")} — undetermined, not green`,
      failingChecks,
      nonEvidenceChecks,
      pendingChecks,
    };
  }
  if (!evidenceOfGreen) {
    return {
      state: "undetermined",
      sha,
      reason: `every required check on main's head was skipped or a known vacuous pass (${
        nonEvidenceChecks.join(", ") || "none"
      }) — no genuine evidence the trunk is healthy, so undetermined rather than green`,
      failingChecks,
      nonEvidenceChecks,
      pendingChecks,
    };
  }
  return {
    state: "green",
    sha,
    reason:
      nonEvidenceChecks.length > 0
        ? `required check(s) genuinely passed on main, excluding non-evidence entries: ${nonEvidenceChecks.join(", ")}`
        : "required check(s) genuinely passed on main",
    failingChecks,
    nonEvidenceChecks,
    pendingChecks,
  };
}

/** Which existing escalation class carries a red-trunk finding. MANUAL is the fit, not a fourth
 *  class: it already covers something genuinely off that only a human can rule on. BLOCKED is the
 *  wrong shape (a specific PR's rung exhausted) and so is HARD_STOP — this call site never takes an
 *  action, it only reports. */
export function mainHealthEscalationClass(): EscalationClass {
  return "MANUAL";
}

/** Whether, and how, a {@link MainHealthObservation} should escalate. Never a revert (Q3). */
export interface MainHealthEscalationDecision {
  readonly escalate: boolean;
  readonly class?: EscalationClass;
  readonly reason: string;
}

/** A red trunk produces an escalation inside the existing taxonomy and NOTHING else: never a
 *  merge, never a revert, just a decision object (Q3). Anything short of "red", "undetermined"
 *  included, does not escalate — an in-flight or vacuous rollup is an incomplete read. */
export function mainHealthEscalationDecision(observation: MainHealthObservation): MainHealthEscalationDecision {
  if (observation.state !== "red") {
    return {
      escalate: false,
      reason: `main's own check state is "${observation.state}", not red — nothing to escalate: ${observation.reason}`,
    };
  }
  return {
    escalate: true,
    class: mainHealthEscalationClass(),
    reason: `main (${observation.sha}) is red — never auto-reverted, an operator ruling decides next steps: ${observation.reason}.${mainHealthOperatorDetail(observation)}`,
  };
}

/** The asymmetry, held as its own boolean rather than folded into
 *  {@link mainHealthEscalationDecision}: a red trunk escalates, but that escalation must NEVER by
 *  itself stop dispatch of unrelated tasks. Omitting `operatorRuling` is exactly "no ruling yet", so
 *  without an explicit `true` this returns `false`, red trunk or not. */
export function mainHealthShouldStandDownDispatch(observation: MainHealthObservation, operatorRuling?: boolean): boolean {
  return observation.state === "red" && operatorRuling === true;
}

// ── W1-T1275 — THE REQUIRED ROLLUP NEVER RECOMPUTES ONCE ITS OWN RUN CONCLUDES ───────────────
//
// ci-gate.yml dedupes by name and re-reads inside a bounded grace window, but every re-read lives
// INSIDE that one run: once it posts a terminal conclusion nothing brings it back. This section is
// the pure detection and the ledgered bound; the real Actions call is the caller's wiring. The check
// named "ci-gate" IS what branch protection requires; its siblings are what CI-GATE ITSELF requires.
// Why: #2612 held a green suite behind a stale failure for 155.4 minutes.
export const CI_GATE_CHECK_NAME = "ci-gate";

/** #2918 — `ci-gate` REPORTED AS A FAILURE IT CANNOT BE. It is a DOWNSTREAM AGGREGATOR: red BECAUSE
 *  a sibling is red, so a list naming both reports two failures where there is one and a worker
 *  handed the second can only chase a symptom. THE ONE CASE THAT IS KEPT is `ci-gate` failing ALONE
 *  — the stale-verdict shape {@link staleCiGateTransition} names — so a non-empty list never empties. */
export function withoutDownstreamGateFailure(failures: readonly CiFailure[]): CiFailure[] {
  const others = failures.filter((f) => f.name !== CI_GATE_CHECK_NAME);
  // Nothing else failed ⇒ the gate IS the signal. Also covers the empty list unchanged.
  if (others.length === 0) return [...failures];
  return others;
}

/** W1-T1275 — the ONE (head, sibling-transition) shape that makes `ci-gate`'s concluded verdict
 *  stale: its own latest deduped attempt concluded a NON-SUCCESS terminal state, and a required
 *  sibling's latest attempt is a terminal SUCCESS that STARTED AFTER ci-gate's did. `jobId` is
 *  ci-gate's OWN, never the sibling's: the AGGREGATOR is re-driven. */
export interface StaleCiGateTransition {
  jobId?: string;
  /** The required sibling whose later terminal success makes ci-gate's own verdict stale. */
  siblingName: string;
  /** That sibling's latest-attempt `startedAt` (ISO) — names WHICH transition (design iv), and
   *  is what {@link ciGateReaggregateKey} bounds the recompute to firing once for. */
  siblingStartedAt: string;
}

/** W1-T1275 — detect the ONE shape design note iii pins, and nothing wider. `ci-gate` must have a
 *  CONCLUDED failing attempt, since a still-pending gate has no verdict to be stale, and only a
 *  literal SUCCESS started STRICTLY LATER qualifies as the sibling. A genuinely failing suite is
 *  never re-run by this path. */
export function staleCiGateTransition(rollup: RollupCheckEntry[] | undefined): StaleCiGateTransition | undefined {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  if (all.length === 0) return undefined;
  const deduped = dedupeRollupByLatestAttempt(all);
  const gate = deduped.find((c) => (c.name ?? c.context ?? "") === CI_GATE_CHECK_NAME);
  if (!gate || !gate.startedAt) return undefined;
  const gateState = (gate.state ?? gate.conclusion ?? gate.status ?? "").toUpperCase();
  if (!REQUIRED_CHECK_FAIL.has(gateState)) return undefined;

  let latest: RollupCheckEntry | undefined;
  for (const c of deduped) {
    if ((c.name ?? c.context ?? "") === CI_GATE_CHECK_NAME) continue;
    const state = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (state !== "SUCCESS") continue;
    if (!c.startedAt || c.startedAt <= gate.startedAt) continue;
    if (!latest || c.startedAt > (latest.startedAt ?? "")) latest = c;
  }
  if (!latest) return undefined;
  return { siblingName: latest.name ?? latest.context ?? "unknown", siblingStartedAt: latest.startedAt! };
}

/** The (head, sibling-transition) identity {@link CI_GATE_REAGGREGATE_STEP}'s rows are keyed on.
 *  Two DIFFERENT transitions on one head are two DIFFERENT keys, each earning its own bounded
 *  recompute (W1-T1275, design iv). */
export function ciGateReaggregateKey(headSha: string, transition: StaleCiGateTransition): string {
  return `${headSha}@${transition.siblingName}@${transition.siblingStartedAt}`;
}

/** One recompute decision for one observed stale transition. */
export interface CiGateReaggregateDecision {
  reaggregate: boolean;
  reason: string;
}

/** W1-T1275 — BOUNDED BY A LEDGERED RECORD, never a clock or an in-memory counter, mirroring
 *  {@link cancelledCheckRequeueDecision}. Zero priors for this exact (head, sibling-transition)
 *  pair re-drives the gate's job once, which makes a re-run storm impossible by construction. */
export function ciGateReaggregateDecision(alreadyReaggregated: boolean): CiGateReaggregateDecision {
  if (alreadyReaggregated) {
    return {
      reaggregate: false,
      reason: "already re-driven once for this exact sibling transition on this head — never repeated",
    };
  }
  return {
    reaggregate: true,
    reason: "ci-gate concluded non-success and a required sibling later reached a terminal success on the same head",
  };
}

/** The ledger step {@link reaggregatedCiGateKeysFromLedger} reads back — one row per recompute. */
export const CI_GATE_REAGGREGATE_STEP = "sweep.ci_gate_reaggregated";

/** W1-T1275 — every transition key the ledger already records a {@link CI_GATE_REAGGREGATE_STEP}
 *  row for. `runSweep` writes the row BEFORE calling `deps.reaggregateCiGate`, the ordering
 *  {@link requeuedCheckKeysFromLedger} uses for the same reason. */
export function reaggregatedCiGateKeysFromLedger(lines: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (
      l.step === CI_GATE_REAGGREGATE_STEP &&
      typeof l.head_sha === "string" &&
      typeof l.sibling_name === "string" &&
      typeof l.sibling_started_at === "string"
    ) {
      out.add(`${l.head_sha}@${l.sibling_name}@${l.sibling_started_at}`);
    }
  }
  return out;
}

const MS_PER_DAY = 86_400_000;

/** The blocked_ci shape (W1-T100, broadened by W1-T138): a required check is red. The failing signal
 *  IS the CI log, and it takes PRECEDENCE over any review verdict beside it, because GitHub will not
 *  merge past a red required check. `checksState` is red ONLY for a required CHECK RUN failure — the
 *  review status is excluded (W1-T394) — so a red review can never make this true. EXPORTED so every
 *  caller imports this ONE definition. // Why: strikes were burnt re-litigating a review while the
 *  blocking check sat untouched. */
export function isBlockedCi(pr: OpenPrView): boolean {
  return pr.checksState === "red" || (pr.redRequiredChecks?.length ?? 0) > 0; // W1-T2504
}

/** True only when the authoritative unmet set is nonempty and every entry is a syntactically
 * recovered worker refusal. A missing/malformed `refusal` is never read from its prose `reason`.
 * This is the gate that prevents an advisory refusal from spending an ordinary fix strike. */
export function onlyRefusedUnmetCriteria(criteria: readonly CriterionVerdict[]): boolean {
  return criteria.length > 0 && criteria.every((criterion) => !criterion.met && isCriterionRefusal(criterion.refusal));
}

function refusedCriterionClasses(criteria: readonly CriterionVerdict[]): string {
  return [...new Set(criteria.flatMap((criterion) => (isCriterionRefusal(criterion.refusal) ? [criterion.refusal.class] : [])))].join(", ");
}

/** W1-T2998 — the ratchets whose ordinary remedy is a RECORDED NUMBER, DERIVED from
 *  {@link REGENERABLE_ARTIFACT_GENERATORS} rather than hand-listed beside it. That registry already
 *  answers "can a generator reproduce this artifact", which is precisely the property that makes a
 *  deterministic repair safe, and the conflict rung already trusts it for the same reason. One
 *  registry, not two lists (W1-T2548).
 *
 *  ⚠ THIS IS WHY `negative-reachability-ratchet` AND `catch-erasure-ratchet` CAN NEVER QUALIFY, and
 *  it is structural rather than a remembered exception: neither owns a baseline artifact, so
 *  neither appears in the registry at all. Their own text says "no allowlist to add it to" — a
 *  recorded number there BANKS the debt instead of paying it. A classifier that had to REMEMBER to
 *  exclude them would be one edit away from including them. */
export function recordableRatchetScripts(
  generators: Readonly<Record<string, string>> = REGENERABLE_ARTIFACT_GENERATORS,
): ReadonlySet<string> {
  return new Set(Object.values(generators));
}

/**
 * W1-T2998 — the generator scripts that would repair this PR's red required checks, or `undefined`
 * when even one red check is not of that class. PURE.
 *
 * ⚠ ALL-OR-NOTHING, AND THAT IS THE SAFETY PROPERTY. A PR red on `comment-load-ratchet` AND
 * `negative-reachability-ratchet` is NOT partially repairable: recording the first would leave the
 * second red, spend a push, and still need the fix rung — while making the PR look attended to. One
 * unrecognised red name refuses the whole set, so the existing dispatch keeps it.
 *
 * ⚠ AND AN EMPTY RED SET IS NOT A REPAIRABLE ONE. Nothing red means nothing to record; returning a
 * repair for it would push an empty commit on every green PR.
 */
export function recordableRatchetRepairFor(
  pr: Pick<OpenPrView, "redRequiredChecks" | "ciFailures" | "mergeState">,
  generators: Readonly<Record<string, string>> = REGENERABLE_ARTIFACT_GENERATORS,
): string[] | undefined {
  // A dirty PR runs no checks at all (W1-T106), so a red name on one is stale by construction.
  if (pr.mergeState === "dirty") return undefined;
  const red = [...new Set([...(pr.redRequiredChecks ?? []), ...(pr.ciFailures ?? []).map((f) => f.name)])].filter(Boolean);
  if (red.length === 0) return undefined;
  const admitted = recordableRatchetScripts(generators);
  const scripts: string[] = [];
  for (const name of red) {
    const script = resolveRatchetScript(name, admitted);
    if (script === undefined) return undefined;
    if (!scripts.includes(script)) scripts.push(script);
  }
  return scripts.length > 0 ? scripts.sort() : undefined;
}

export const MISSING_TASK_TRAILER_REPAIR_STEP = "sweep.missing_task_trailer_repaired" as const;

export interface MissingTaskTrailerRepair {
  taskId: string;
  trailer: string;
  repairedBody: string;
  reason: string;
  scopeOverrunPaths: string[];
  refireEvent: "pull_request.edited";
  rerunFailedJobs: false;
}

export type MissingTaskTrailerRepairDecision =
  | { action: "ignore"; reason: string }
  | { action: "stand-down"; reason: string }
  | { action: "repair"; repair: MissingTaskTrailerRepair };

function bodyAlreadyCarriesGateInput(body: string): boolean {
  const missingTrailer = diagnoseBodyDefects(body, [], {}).some((d) => d.kind === "no-trailer");
  return !missingTrailer || acceptanceBlockDiagnostics(body).headerFound;
}

function declaredPathCovers(declared: string, changed: string): boolean {
  const clean = declared.replace(/\/$/, "");
  if (clean === "" || clean === changed) return true;
  if (changed.startsWith(`${clean}/`)) return true;
  if (!clean.includes("*")) return false;
  const escaped = clean
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join("[^\\n]*");
  return new RegExp(`^${escaped}$`).test(changed);
}

export function changedPathsOutsideDeclaredFiles(
  changedFiles: readonly string[] | undefined,
  taskDeclaredFiles: readonly string[] | undefined,
): string[] {
  if (changedFiles === undefined || taskDeclaredFiles === undefined || taskDeclaredFiles.length === 0) return [];
  return changedFiles.filter((changed) => !taskDeclaredFiles.some((declared) => declaredPathCovers(declared, changed)));
}

function renderMissingTaskTrailerRepairBody(
  body: string,
  taskId: string,
  headRefName: string,
  scopeOverrunPaths: readonly string[],
): string {
  const trailer = `Remudero-Task: ${taskId}`;
  const note = [
    "## rmd sweep note",
    `rmd sweep added the trailer below because this body had neither a Remudero-Task trailer nor an Acceptance block.`,
    `It derived ${taskId} from branch ${headRefName}; this only gives the gate the task identity it already uses.`,
    scopeOverrunPaths.length > 0
      ? `Changed paths outside ${taskId}'s declared files were observed and left advisory: ${scopeOverrunPaths.join(", ")}.`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  const prefix = body.trim().length > 0 ? `${body.trimEnd()}\n\n` : "";
  return `${prefix}${note.join("\n")}\n\n${trailer}\n`;
}

export function missingTaskTrailerRepairDecision(
  pr: Pick<
    OpenPrView,
    | "body"
    | "changedFiles"
    | "headRefName"
    | "introducedTaskIds"
    | "prNumber"
    | "taskDeclaredFiles"
    | "taskExistsOnMain"
  >,
): MissingTaskTrailerRepairDecision {
  if (pr.body === undefined) return { action: "ignore", reason: "body was not observed by this sweep input" };
  if (bodyAlreadyCarriesGateInput(pr.body)) {
    return { action: "ignore", reason: "body already carries an accepted gate input" };
  }
  const taskId = taskIdFromRunBranch(pr.headRefName);
  if (taskId === undefined) {
    return {
      action: "stand-down",
      reason: "missing trailer repair refused: head branch does not match run-<taskId>-<epoch>, so no task id is derivable",
    };
  }
  if (pr.taskExistsOnMain !== true) {
    return {
      action: "stand-down",
      reason: `missing trailer repair refused: no plan record for ${taskId} on main, so the branch id is not resolvable`,
    };
  }
  if (pr.introducedTaskIds === undefined) {
    return {
      action: "stand-down",
      reason: `missing trailer repair refused: changed files for #${pr.prNumber} were not observed, so self-credit cannot be ruled out`,
    };
  }
  if (pr.introducedTaskIds.includes(taskId)) {
    return {
      action: "stand-down",
      reason: `missing trailer repair refused: this PR adds ${taskId}'s own plan record, so adding its trailer would self-credit the filing`,
    };
  }
  const scopeOverrunPaths = changedPathsOutsideDeclaredFiles(pr.changedFiles, pr.taskDeclaredFiles);
  const repairedBody = renderMissingTaskTrailerRepairBody(
    pr.body,
    taskId,
    pr.headRefName ?? "",
    scopeOverrunPaths,
  );
  return {
    action: "repair",
    repair: {
      taskId,
      trailer: `Remudero-Task: ${taskId}`,
      repairedBody,
      reason:
        "body had neither accepted gate input; trailer is branch-derived and the body edit emits a fresh pull_request.edited event",
      scopeOverrunPaths,
      refireEvent: "pull_request.edited",
      rerunFailedJobs: false,
    },
  };
}

/** W1-T2998 — a CI check name to the npm script that regenerates its artifact. Exact names and the
 *  historical `<check>-ratchet` form are matched; W1-T3140 renamed source-size's compatibility
 *  generator to `source-size-baseline:legacy`, so the stable `source-size` sensor can no longer be
 *  mistaken for a mechanically recordable failure. */
function resolveRatchetScript(checkName: string, admitted: ReadonlySet<string>): string | undefined {
  if (admitted.has(checkName)) return checkName;
  const suffixed = `${checkName}-ratchet`;
  return admitted.has(suffixed) ? suffixed : undefined;
}

/** W1-T3063 — the subject prefixes that FILE or AMEND a task rather than implementing it.
 *  `fix(plan)` is an amendment: its scope identifies the control-plane record it changes, not an
 *  implementation. A merged amendment may share the task's run-branch naming, but must never
 *  credit or close the implementation PR it repairs (#5231). */
export const FILING_SUBJECT_RE = /^(?:chore\(plan\)|fix\(plan\)|chore\(triage\)|chore\(feedback\)|docs\(plan\)|plan:|docs:|chore:)/;

/** W1-T3063 — does this merge subject describe an IMPLEMENTATION? `undefined` in, `undefined` out:
 *  a subject that could not be read is not evidence either way, and every destructive consumer must
 *  treat it as a refusal. PURE. */
export function creditSubjectIsImplementation(subject: string | undefined): boolean | undefined {
  if (subject === undefined) return undefined;
  const trimmed = subject.trim();
  if (trimmed === "") return undefined;
  return !FILING_SUBJECT_RE.test(trimmed);
}

/** W1-T2794 — stamp {@link OpenPrView.taskMergedBy} onto each open PR whose task a credit
 *  candidate proves MERGED. PURE: no I/O, no GitHub call, no ledger read — the caller already
 *  built this candidate set for the credit-backfill rung, and this reuses that same array rather
 *  than deriving a second one.
 *
 *  ⚠ FAIL OPEN ON DARKNESS, WHICH IS THE WHOLE SAFETY PROPERTY. Only a candidate with
 *  `merged === true` and a concrete `prNumber` can stamp anything. An empty or absent candidate
 *  array (a failed projection is indistinguishable from "nothing merged"), a PR carrying no
 *  `taskId`, or a candidate for another task all leave the view BYTE-IDENTICAL — so a read failure
 *  can never be laundered into a close.
 *
 *  ⚠ AND NEVER THE WINNER ITSELF. A candidate naming this very PR is skipped: the merged PR is not
 *  normally in the open array at all, but a stale listing must not be able to close the PR that
 *  did the work. */
export function projectMergedTaskCandidates(
  prs: readonly OpenPrView[],
  candidates: readonly CreditCandidate[] | undefined,
): OpenPrView[] {
  const mergedByTask = new Map<string, number>();
  for (const c of candidates ?? []) {
    // W1-T3063 — `=== true` IS THE FIX, and the strictness is the point: `undefined` (the subject
    // could not be read) and `false` (a filing earned the credit) must BOTH decline. A truthy test
    // here would re-admit the unknown case, which is how #4461 was closed against a `chore(plan)`.
    if (c.creditIsImplementation !== true) continue;
    if (c.merged === true && typeof c.prNumber === "number" && c.taskId) mergedByTask.set(c.taskId, c.prNumber);
  }
  if (mergedByTask.size === 0) return [...prs];
  return prs.map((pr) => {
    if (pr.taskId === undefined) return pr;
    const mergedBy = mergedByTask.get(pr.taskId);
    if (mergedBy === undefined || mergedBy === pr.prNumber) return pr;
    return { ...pr, taskMergedBy: mergedBy };
  });
}

/** W1-T1269/W1-T3309 — does the CURRENT failure repeat the exact cause a remedy already tried to
 *  resolve? THE EARLIER STOP, never a longer leash. Ordinary strikes key on their unmet claim set;
 *  the zero-strike Rule-25 refusal keys on its two structured path sets. Both arms are exact-set
 *  comparisons only — inclusion-descent is refused because it would stop a lateral change too.
 *  Missing or malformed prior evidence fails closed. */
export function fixRungRepeatsIdenticalFailure(pr: OpenPrView): boolean {
  const exactSet = (current: readonly string[], prior: readonly string[]): boolean => {
    const currentSet = new Set(current);
    const priorSet = new Set(prior);
    return (
      currentSet.size === current.length &&
      priorSet.size === prior.length &&
      currentSet.size === priorSet.size &&
      [...currentSet].every((value) => priorSet.has(value))
    );
  };
  const history = pr.strikeHistory ?? [];
  const priorClaims = history[history.length - 1]?.unmetClaims;
  const currentClaims = pr.unmetCriteria.map((c) => c.claim);
  if (currentClaims.length > 0) {
    if (!priorClaims || priorClaims.length === 0 || currentClaims.length !== priorClaims.length) return false;
    return exactSet(currentClaims, priorClaims);
  }

  if (
    pr.instrumentEntangled !== true ||
    !usableInstrumentEntanglementPaths(pr.instrumentEntanglementPaths) ||
    !usableInstrumentEntanglementPaths(pr.previousInstrumentEntanglementPaths)
  ) {
    return false;
  }
  return (
    exactSet(pr.instrumentEntanglementPaths.instrumentPaths, pr.previousInstrumentEntanglementPaths.instrumentPaths) &&
    exactSet(pr.instrumentEntanglementPaths.srcPaths, pr.previousInstrumentEntanglementPaths.srcPaths)
  );
}

/** W1-T923 — given the STRUCTURED `reasons` a gate failure carried, decide whether it names a
 *  SINGLE, unambiguous remedy. Exactly one is copied through VERBATIM; zero, or two or more, are
 *  excluded ENTIRELY rather than flagged, because a worker acting on the wrong one of several named
 *  options misattributes a ratified ruling. Reads NOTHING about `failure_class`. */
export function actionableGateFailuresFromReasons(reasons: readonly string[]): ActionableGateFailure[] {
  return reasons.length === 1 ? [{ reason: reasons[0] }] : [];
}

/** W1-T527 — WHY a PR is red, which {@link isBlockedCi} deliberately does not ask. Four causes
 *  reached the identical dispatch, and only the last is the fix rung's: `base-caused`, the same check
 *  failing on EVERY open PR this pass; `gate-conflict`, an unsatisfiable condition (Standing rule
 *  25); `environment`, a near-total failure ratio inside ONE check; and `in-diff`. Base-caused is
 *  asked FIRST because it exonerates every diff at once. PURE, NO I/O. */
export type RedCause = "base-caused" | "gate-conflict" | "environment" | "in-diff";

/** The Standing rule 25 refusal text `renderReviewSummary` emits. Matched as TEXT because the
 *  structured `ReviewVerdict.instrumentEntangled` boolean is not carried on {@link OpenPrView} —
 *  see {@link namesUnsatisfiableGate} for what that costs and why it is still safe. */
const UNSATISFIABLE_GATE_MARKER = /entangled: instrument path\(s\)/i;

/** A log tail shorter than this cannot establish a ratio — too few lines to be near-total. */
const ENVIRONMENT_MIN_TAIL_LINES = 4;
/** The share of log-tail lines that must be the SAME line before one message is "near-total". */
const ENVIRONMENT_REPEAT_RATIO = 0.9;

/** W1-T3029 — the Standing rule 15 refusal `failSummary` (lib/review.ts) emits. Matched as TEXT
 *  for the SAME reason {@link UNSATISFIABLE_GATE_MARKER} is: the structured
 *  `ReviewVerdict.criteriaTampered` boolean is not carried on {@link OpenPrView}, only
 *  {@link OpenPrView.reviewSummary} is. SAFE TO MATCH BECAUSE THE STRING IS A FIXED LITERAL: that
 *  branch of `failSummary` interpolates nothing (it is capped at 140 chars by the commit-status
 *  API and its own comment records five suites pinning `Standing rule 15`). THE KNOWN COST: a
 *  reword there drops this match silently and the reason below reverts to the generic wording —
 *  the same text coupling rule 25's marker already carries, and the same failure mode. */
const RULE_15_REFUSAL_MARKER = /Standing rule 15/;

/** W1-T3029 — did the review refuse under Standing rule 15 (a criterion added/edited beside
 *  non-plan files)? DIAGNOSTIC ONLY: no caller routes on this, and design (iii) REFUSES to make one.
 *  Rule 15's remedy is a PR SPLIT, a shape change no in-place fix rung can perform, so promoting
 *  this to an `actionableGateFailure` would spend strikes that cannot succeed — strictly worse than
 *  an unhelpful message. It changes what the escalation SAYS, never what the sweep DOES. */
export function namesRule15Refusal(pr: OpenPrView): boolean {
  return pr.reviewSummary !== undefined && RULE_15_REFUSAL_MARKER.test(pr.reviewSummary);
}

/** The required check failing on EVERY open PR in this pass, or `undefined`. THE VACUITY GUARD IS
 *  THE LOAD-BEARING PART: with a single open PR the claim is trivially true of its own failure, so
 *  fewer than two returns `undefined`. Any PR NOT failing this check also yields `undefined`, since
 *  a base outage reddens all of them, so a survivor is evidence AGAINST the base. */
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

/** True when the review named a condition no patch can satisfy (Standing rule 25 entanglement).
 *  Reads BOTH carriers because one is currently inert. THE SAFETY PROPERTY IS STRUCTURAL, NOT
 *  DETECTIVE: a rule-25 refusal fails the review COMMIT STATUS, which `checksState` excludes, so
 *  detection changes the ledger's reason text, not whether the escalation survives. */
export function namesUnsatisfiableGate(pr: OpenPrView): boolean {
  if (pr.reviewSummary && UNSATISFIABLE_GATE_MARKER.test(pr.reviewSummary)) return true;
  return pr.unmetCriteria.some((criterion) => UNSATISFIABLE_GATE_MARKER.test(criterion.reason));
}

/** The check whose log tail is one message repeated near-totally, or `undefined`.
 *  `findSiblingDisagreements` is the other half of this discriminator and is DELIBERATELY NOT
 *  CALLED: it needs BOTH poles, and {@link OpenPrView} carries failures only, so the ratio arm
 *  carries this class alone. */
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

/** The pure fold itself — see {@link RedCause} for the four classes and why this order. */
export function classifyRedCause(pr: OpenPrView, allPrs: readonly OpenPrView[]): RedCause {
  if (baseCausedCheckName(pr, allPrs) !== undefined) return "base-caused";
  if (namesUnsatisfiableGate(pr)) return "gate-conflict";
  if (environmentFaultCheckName(pr) !== undefined) return "environment";
  return "in-diff";
}

/** The two classes the fix rung cannot reach, and therefore the only two that change behaviour.
 *  `in-diff` dispatches exactly as before; `gate-conflict` refuses and escalates byte-identically.
 *  A stand-down leaves `acted:false`, and `priorActionsFromLedger` skips those rows, so no strike is
 *  spent and the PR is re-derived fresh next pass. */
export function redCauseStandsDown(cause: RedCause): boolean {
  return cause === "base-caused" || cause === "environment";
}

/** The stand-down reason carried on the EXISTING `sweep.disposed` line, not a new ledger step.
 *  This class is READ by the dispatch decision itself, which is what makes it an actor rather than
 *  a fourth dead signal beside `daemon.tree_dirty` and `CiFailure.outsidePrRange`. */
export function describeRedCause(cause: RedCause, pr: OpenPrView, allPrs: readonly OpenPrView[]): string {
  if (cause === "base-caused") {
    const name = baseCausedCheckName(pr, allPrs) ?? "a required check";
    return `red cause: base-caused — ${name} is failing on all ${allPrs.length} open PRs this pass, so it is not this diff; no strike spent`;
  }
  const name = environmentFaultCheckName(pr) ?? "a required check";
  return `red cause: environment — ${name} repeats one message across its whole log tail, an environment fault rather than a diff defect; no strike spent`;
}

/** W1-T2620 — per PR, the `main_tip_sha` most recently recorded on a base-caused `sweep.disposed`
 *  row: the marker this task rides on the EXISTING step, never a fourth ledger signal. `undefined`
 *  for a PR never observed base-caused. Reads `main_tip_sha` alone, never prose — that field is
 *  written only from the base-caused branch. */
export function lastBaseCausedTipFromLedger(lines: readonly Record<string, unknown>[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed") continue;
    if (typeof line.pr_number !== "number") continue;
    if (typeof line.main_tip_sha !== "string") continue;
    // Ledger lines are append-ordered — the LAST match for a given PR is its most recent.
    out.set(line.pr_number, line.main_tip_sha);
  }
  return out;
}

/** W1-T2620 — AT MOST ONE base-caused PR released per pass, oldest activity first. THE RELEASE
 *  CONDITION IS "main has moved since this PR last stood down", never "the cause is known". A PR
 *  with no prior record is NOT eligible: with no baseline nothing has advanced. Ordered by the SAME
 *  comparator the other selectors use, so a loser is strictly older next pass and cannot starve. */
export function selectBaseCausedRelease(
  prs: readonly OpenPrView[],
  mainTipSha: string,
  lastBaseCausedTipByPr: ReadonlyMap<number, string>,
  now: number,
): OpenPrView | undefined {
  const eligible = prs.filter((pr) => {
    if (classifyRedCause(pr, prs) !== "base-caused") return false;
    const lastTip = lastBaseCausedTipByPr.get(pr.prNumber);
    return lastTip !== undefined && lastTip !== mainTipSha;
  });
  if (eligible.length === 0) return undefined;
  return oldestActivityFirst(eligible, now);
}

export interface StaleBaseReleaseTarget {
  pr: OpenPrView;
  decision: RedBaseRefreshDecision;
  mainTipSha: string;
}

/** Successful queue-maintenance releases, keyed on every input the write depended on. */
export function staleBaseReleaseKeysFromLedger(lines: readonly Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    // A successful red-base refresh is still the existing update-branch action, so reuse its
    // decision-relevant, rotation-safe marker; `main_tip_sha` distinguishes this lane from the
    // stale-gate updater, whose rows do not carry that input.
    if (line.step !== "sweep.update_branch.updated") continue;
    if (typeof line.pr_number !== "number" || typeof line.head_sha !== "string" || typeof line.main_tip_sha !== "string") continue;
    keys.add(`${line.pr_number}@${line.head_sha}@${line.main_tip_sha}`);
  }
  return keys;
}

/** W1-T2789 — choose at most one strike-exhausted, checks-red PR whose exact failing path changed
 *  on a positively newer base. Candidates are inspected oldest-first, and only a successful prior
 *  release of this exact `(PR, head, main tip)` suppresses it. An unreadable comparison abstains. */
export async function selectStaleBaseRelease(
  prs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  mainTipSha: string | undefined,
  priorReleaseKeys: ReadonlySet<string>,
  readFacts: ((pr: OpenPrView) => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>) | undefined,
  onReadError: (pr: OpenPrView, error: unknown) => void = () => {},
): Promise<StaleBaseReleaseTarget | undefined> {
  if (mainTipSha === undefined || readFacts === undefined) return undefined;
  const remaining = prs.filter((pr) => {
    if (!isBlockedCi(pr) || (pr.ciFailures?.length ?? 0) === 0) return false;
    if (deriveDisposition(pr, policy, now).disposition !== "blocked-ambiguous") return false;
    if (pr.priorStrikes < fixCeilingInForce(pr, policy.strikeCap, policy.clarify)) return false;
    return !priorReleaseKeys.has(`${pr.prNumber}@${pr.headSha}@${mainTipSha}`);
  });
  while (remaining.length > 0) {
    const candidate = oldestActivityFirst(remaining, now)!;
    remaining.splice(remaining.indexOf(candidate), 1);
    try {
      const decision = decideRedBaseRefresh(candidate.ciFailures ?? [], await readFacts(candidate));
      if (decision.refresh) return { pr: candidate, decision, mainTipSha };
    } catch (error) {
      // Deliberate fail-closed read: attribute the outage, skip this candidate, and preserve the
      // ordinary blocked disposition. A missing compare must never manufacture update authority.
      onReadError(candidate, error);
    }
  }
  return undefined;
}

/** The one main read W1-T3422 needs. SHA and commit time are one observation: separating them permits a main move between requests and would pair a repair time with the wrong tree. */
export interface MainRepairEvidence {
  sha: string;
  committedAt: string;
}

export interface StaleRedReleaseTarget {
  pr: OpenPrView;
  failure: CiFailure;
  main: MainRepairEvidence;
  route: NonNullable<ReturnType<typeof localMergeRouteForCheck>>;
}

/** BACKSTOP: hard cap on live workflow reads after the timestamp-only filter. The same pass may inspect at most this many oldest stale candidates, then leaves the rest for its next scheduled run. */
export const STALE_RED_WORKFLOW_READ_CAP = 4;

/** Successful exact stale-red releases are keyed by every observation that authorised the empty
 * commit. A different check on the same head is deliberately a different decision. */
export function staleRedReleaseKeysFromLedger(lines: readonly Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    if (line.step !== "sweep.stale_red_redrive.released") continue;
    if (
      typeof line.pr_number !== "number" ||
      typeof line.head_sha !== "string" ||
      typeof line.main_sha !== "string" ||
      typeof line.check_name !== "string"
    ) continue;
    keys.add(`${line.pr_number}@${line.head_sha}@${line.main_sha}@${line.check_name}`);
  }
  return keys;
}

function validEarlierTime(before: string | undefined, after: string | undefined): boolean {
  if (!before || !after) return false;
  const beforeMs = Date.parse(before);
  const afterMs = Date.parse(after);
  return Number.isFinite(beforeMs) && Number.isFinite(afterMs) && beforeMs < afterMs;
}

function staleRedRequiredFailure(pr: OpenPrView, allPrs: readonly OpenPrView[], main: MainRepairEvidence): {
  failure: CiFailure;
  route: NonNullable<ReturnType<typeof localMergeRouteForCheck>>;
} | undefined {
  if (!isBlockedCi(pr) || classifyRedCause(pr, allPrs) === "base-caused") return undefined;
  const required = new Set(pr.redRequiredChecks ?? []);
  const failures = (pr.ciFailures ?? []).filter((failure) => required.has(failure.name));
  // One declared local command proves one required failure. More than one red required check has
  // no equivalent proof here, so it remains on the ordinary fix/escalation path.
  if (failures.length !== 1 || !pr.headRefName) return undefined;
  const failure = failures[0]!;
  if (!validEarlierTime(failure.completedAt, main.committedAt)) return undefined;
  const route = localMergeRouteForCheck(failure.name);
  return route ? { failure, route } : undefined;
}

/** Select the oldest exact stale-red candidate only after each cheap fact is complete. The live
 * workflow read happens last and is capped; undefined, an in-flight run, or any error declines.
 * W1-T2620's cohort release is excluded by `classifyRedCause`, so one pass cannot push twice. */
export async function selectStaleRedRelease(
  prs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  main: MainRepairEvidence | undefined,
  priorReleaseKeys: ReadonlySet<string>,
  readWorkflowRuns: ((pr: OpenPrView) => readonly WorkflowRunObservation[] | undefined | Promise<readonly WorkflowRunObservation[] | undefined>) | undefined,
  cap: number = STALE_RED_WORKFLOW_READ_CAP,
  onReadError: (pr: OpenPrView, error: unknown) => void = () => {},
): Promise<StaleRedReleaseTarget | undefined> {
  if (!main || !readWorkflowRuns || !validEarlierTime("1970-01-01T00:00:00.000Z", main.committedAt)) return undefined;
  const remaining = prs.filter((pr) => {
    if (deriveDisposition(pr, policy, now).disposition !== "blocked-ambiguous") return false;
    const candidate = staleRedRequiredFailure(pr, prs, main);
    return candidate !== undefined && !priorReleaseKeys.has(`${pr.prNumber}@${pr.headSha}@${main.sha}@${candidate.failure.name}`);
  });
  let reads = 0;
  while (remaining.length > 0 && reads < cap) {
    const pr = oldestActivityFirst(remaining, now)!;
    remaining.splice(remaining.indexOf(pr), 1);
    const candidate = staleRedRequiredFailure(pr, prs, main);
    if (!candidate) continue;
    reads += 1;
    try {
      const runs = await readWorkflowRuns(pr);
      if (runs === undefined || runs.some((run) => (run.conclusion ?? "").trim() === "")) continue;
      return { pr, failure: candidate.failure, main, route: candidate.route };
    } catch (caught) {
      const error = String(caught);
      onReadError(pr, error);
    }
  }
  return undefined;
}

/**
 * The named "why is this actually blocked" states an escalation must distinguish (W1-T186), never a
 * single overloaded pair. CONFLICTED: observed dirty, where zero check runs is EXPECTED. FAILING: a
 * required check CONCLUDED failure. ABSENT: a required context has ZERO runs on an otherwise-
 * mergeable PR. PENDING: still running. GATE_UNREADABLE (W1-T2399): a failed protection read. IN
 * THIS ORDER, CONFLICTED FIRST: "none" before "dirty" mis-sorts one as ABSENT (#412/#413).
 */
export type ObservedBlockerState = "CONFLICTED" | "FAILING" | "ABSENT" | "PENDING" | "GATE_UNREADABLE";

export function observedBlockerState(pr: OpenPrView): ObservedBlockerState | undefined {
  if (pr.mergeState === "dirty" || pr.mergeable === false) return "CONFLICTED";
  // CHECKED BEFORE reviewState, mirroring DISPOSITION_RULES row 4/5's own "ci-log wins"
  // precedence — a verdict beside a red required check may be STALE, computed before the push
  // that broke it — so FAILING fires regardless of what the review says.
  if (pr.checksState === "red") return "FAILING";
  // A failing REVIEW (checks not red) already names its own block via the criterion text;
  // PENDING/ABSENT below would misframe that as "wait" or "post the check".
  if (pr.reviewState === "failure") return undefined;
  if (pr.checksState === "pending") return "PENDING";
  if (pr.checksState === "none") return "ABSENT";
  // W1-T2399 — CHECKED BEFORE THE W1-T176 SHAPE BELOW, because when the repo-wide read failed we do
  // not KNOW that any context is absent: `checksState` is green, so the PR's own checks plainly ran.
  // The DISPOSITION is untouched — such a PR still falls to the catch-all and still escalates.
  if (pr.checksState === "green" && pr.reviewState === "none" && pr.requiredContextsUnreadable === true) {
    return "GATE_UNREADABLE";
  }
  // The W1-T176 shape: every OTHER required context is green, but remudero-review specifically has
  // zero observed runs — invisible to the branch above, because overall checksState reads "green".
  if (pr.checksState === "green" && pr.reviewState === "none") return "ABSENT";
  return undefined;
}

/** Why the ABSENT-check-suite remedy did or did not fire, so both outcomes are legible. */
export type AbsentRepushDecision =
  | { repush: true; reason: string }
  | { repush: false; reason: string };

/** How many empty-commit re-pushes ONE PR may earn before the remedy stands down and the ordinary
 *  escalation takes over. Mirrors `fixStrikeCap`'s role for the fix rung: a bound on a remedy that
 *  would otherwise retry forever on a PR GitHub simply never schedules. */
export const ABSENT_REPUSH_CAP = 1;

/**
 * THE ABSENT-CHECK-SUITE REMEDY'S DECISION (W1-T186 follow-up), in
 * {@link absentChecksRepushDecision} below. PURE: every inch of evidence is a parameter. THE
 * DISCRIMINATOR IS ABSENT vs PENDING, and BOTH halves are required, because re-pushing a PR whose
 * checks merely have not STARTED cancels in-flight runs and resets the review. STRUCTURE reuses
 * {@link checksStateFromRollup} — only a COMPLETELY EMPTY rollup reads "none" — and TIME clocks on
 * `lastActivityAt`. The W1-T176 sub-shape and a PASSING REVIEW are excluded, since the review is
 * per head sha. // Why: docs/forensics/sweep.md#second-pass-2026-09-06.
 */
/** W1-T1103 — minutes since this head was last pushed, so the NOT-YET-SCHEDULED row reads the
 *  IDENTICAL clock: "re-push yet?" and "escalate yet?" are one question. */
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

/** Name the FAILING check(s) plus the sha each ran against (W1-T186) — "checks red" is not
 *  actionable, "commitlint failed on 0e63429" is. Falls back to a generic sentence when no per-check
 *  detail was captured, and — the #420 fixture — says so explicitly when a check's own sha is
 *  OBSERVED to sit outside this PR's own commit range. */
function describeCiFailures(pr: OpenPrView): string {
  const failures = pr.ciFailures ?? [];
  if (failures.length === 0) {
    return (pr.redRequiredChecks ?? []).length > 0 ? `required check(s) already concluded red on head ${pr.headSha.slice(0, 7)} while ci-gate's own aggregate still reads "${pr.checksState}": ${(pr.redRequiredChecks ?? []).join(", ")}` : `a required check failed on head ${pr.headSha.slice(0, 7)} (no failing-check detail captured)`; // W1-T2504
  }
  return failures
    .map((f) => {
      const sha = (f.sha ?? pr.headSha).slice(0, 7);
      const rangeNote = f.outsidePrRange
        ? " — NOT one of this PR's own commits; only present on the base branch"
        : "";
      // An escalation naming a check but no reason reads as "it failed and we saw why"; it is the
      // operator who then discovers the log was never read. Say so in the SAME sentence that names
      // the check, through the one shared renderer.
      const logNote = f.logUnavailable ? ` — ${describeCiLogUnavailable(f.logUnavailable)}` : "";
      return `${f.name} failed on ${sha}${rangeNote}${logNote}`;
    })
    .join("; ");
}

/** The `mergeable`/`mergeableState` facts line every escalation carries when observed (W1-T186,
 *  acceptance 2) — "" when neither was read, so callers can omit it cleanly. */
function mergeableFactLine(pr: OpenPrView): string {
  if (pr.mergeable === undefined && pr.mergeableState === undefined) return "";
  return `observed mergeable=${pr.mergeable ?? "unknown"}, mergeableState=${pr.mergeableState ?? "unknown"}`;
}

/** Render the named observed-blocker facts (W1-T186) prepended to every clarification question;
 *  "" when none was named. FALSIFIER-SHAPED CONSTRAINT: the CONFLICTED branch must never contain
 *  the word "CI" or the token "blocked_ci" — both are FALSE for a conflicted PR, and #412/#413 is
 *  exactly an escalation that said so for a PR that was neither. */
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
    case "GATE_UNREADABLE": {
      // W1-T2399: names the REPO-WIDE read as the observed blocker, including the branch it could
      // not read and the classified reason, rather than asserting anything about this PR's checks.
      const f = pr.requiredContextsReadFailure;
      const where = f ? `branch protection on \`${f.branch}\`` : "branch protection";
      const why = f ? ` — ${f.reason}` : "";
      return (
        `[GATE_UNREADABLE]${suffix} this PR's own checks are GREEN on head ${pr.headSha.slice(0, 7)}; ` +
        `what could not be read is ${where}${why}, a REPO-WIDE read that this sweep pass makes once. ` +
        `An unreadable gate is never assumed permissive (W1-T176), so the merge is held — but nothing ` +
        `here is a claim about this PR's check runs. Remedy: restore the protection read (token scope, ` +
        `\`gh\` availability, network), then the next pass disposes this PR on its real state.`
      );
    }
    case "PENDING":
      return `[PENDING]${suffix} required checks are still running on head ${pr.headSha.slice(0, 7)}.`;
    default:
      return mergeableFact ? `(${mergeableFact})` : "";
  }
}

/** One row of the POLICY-AS-DATA table (rule 2): an observed-state predicate, the disposition it
 *  produces, and the stated reason. Selection lives in {@link DISPOSITION_RULES} — a data
 *  structure, never imperative branches — so adding, removing or reordering a disposition is a
 *  TABLE edit. */
interface DispositionRule {
  readonly disposition: Disposition;
  /** Observed-state predicate over the PR and the tunable {@link SweepPolicy} thresholds. `now` is
   *  the same sweep-pass clock {@link ageDays} came from, threaded so the WAIT and stale-pending
   *  rows derive the pending age without a second, independently-sourced clock. */
  readonly when: (pr: OpenPrView, policy: SweepPolicy, ageDays: number, now: number) => boolean;
  readonly reason: (pr: OpenPrView, policy: SweepPolicy, ageDays: number, now: number) => string;
}

/** W1-T114 — minutes checks have been pending on this head, or `undefined` when there is nothing to
 *  date. THE FALLBACK IS THE WHOLE FIX: `checksPendingSince` was never wired by any producer, so both
 *  rows required a value that was always `undefined` and every pending PR escalated. A CEILING ON
 *  WAITING, NOT A LICENCE TO IGNORE. // Why: docs/forensics/sweep.md#second-pass-2026-09-06. */
function pendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const raw = pr.checksPendingSince ?? pr.lastActivityAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
}

/** W1-T913 — minutes `remudero-review` has read PENDING on this head, posted by this system itself,
 *  or `undefined` when there is nothing to date. Mirrors {@link pendingAgeMinutes}'s fallback
 *  discipline exactly, so a pending PR is never stranded because a producer lagged. */
function reviewPendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const raw = pr.reviewPendingSince ?? pr.lastActivityAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
}

/** W1-T913 — is a currently-PENDING review old enough that the sweep should stop trusting it and
 *  offer this head to the post-review lane again? Reuses `policy.pendingCeilingMinutes` rather than
 *  a second threshold that could drift. UNDATED READS STALE — the OPPOSITE direction from the
 *  re-push remedy's caution, because a redundant pending post is a no-op. */
function reviewPendingIsStale(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {
  const age = reviewPendingAgeMinutes(pr, now);
  return age === undefined || age >= policy.pendingCeilingMinutes;
}

/** W1-T1018 — the ELAPSED-TIME BACKOFF replacing permanent cessation: has enough wall-clock time
 *  passed since this input's last completed judgment for the cap row to YIELD? ESCALATE AND KEEP
 *  GOING, NEVER ESCALATE INSTEAD OF GOING. The reset is structural, since a new head or body creates
 *  another digest. FAILS TOWARD ESCALATING, never toward silent retrying. */
export function reviewInputBackoffElapsed(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {
  if (!pr.reviewInputLastAttemptAt) return false;
  const last = Date.parse(pr.reviewInputLastAttemptAt);
  if (Number.isNaN(last)) return false;
  return now - last >= policy.reviewOrphanBackoffMinutes * 60_000;
}

/** W1-T2299 — THE SUPERSEDED-INPUT DETECTOR: has anything happened to this PR AFTER its current
 *  verdict was posted? NAMED FOR WHAT IT DETECTS — "activity", never "a body edit", since GitHub
 *  carries no body-specific timestamp; that coarseness is tolerable because the consumer ALSO
 *  requires zero judgments for the current digest. FAILS CLOSED on a missing timestamp. */
export function reviewVerdictOvertakenByActivity(pr: OpenPrView): boolean {
  if (!pr.reviewVerdictPostedAt) return false;
  const verdictAt = Date.parse(pr.reviewVerdictPostedAt);
  if (Number.isNaN(verdictAt)) return false;
  const activityAt = Date.parse(pr.lastActivityAt);
  if (Number.isNaN(activityAt)) return false;
  return activityAt > verdictAt;
}

/**
 * THE POLICY TABLE — ordered rules mapping observed PR-state to a disposition. Each row carries its
 * own trap and citation; the per-row index is docs/forensics/sweep.md#second-pass-2026-09-06.
 *
 * INVARIANT: precedence is TABLE ORDER, first match wins, and the terminal row matches
 * unconditionally, so "no disposition is ever none" is STRUCTURAL rather than a branch. The mapping
 * is DATA, so a policy edit flips a disposition without touching {@link deriveDisposition}, and
 * `mergeable` is only ever POSITIVELY matched. ORDER is load-bearing: close-out rows first;
 * blocked_ci BEFORE the review rows, because a verdict beside a red required check may be STALE;
 * CONFLICTED ABOVE mergeable, so a conflicting PR is never armed however green; and the
 * refused-head post-review row before the first-sighting one.
 */
export const DISPOSITION_RULES: readonly DispositionRule[] = [
  {
    // W1-T920 (DECISIONS.md #1987) — ROUTED THROUGH THE EXISTING "stale" disposition, never a new
    // one: that case already closes reversibly and already writes ONE `sweep.disposed` row, and
    // no new ledger step ships without a named reader. A NEW ROW, not a change to the bare-number
    // row below: this one matches a REASON-bearing verdict, gated and default OFF, and reads
    // NOTHING about the PR but `status`. `"unique"` and `"indeterminate"` are both inert here.
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
    // W1-T2794 — A TASK ALREADY MERGED BEATS EVERY OPEN-PEER ARGUMENT, so this row sits ABOVE the
    // `supersededBy` row below it. That row's arithmetic is "a higher-numbered OPEN peer shares
    // this trailer", which vanished the moment the winner merged and left the open array — which is
    // exactly how #3877 stayed open, was reviewed PASS, and then escalated `blocked-ambiguous`
    // every sweep after #3874 merged W1-T2786 and the credit rung wrote a durable `verdict.merged`.
    //
    // ⚠ THE FIELD IS THE GATE, NOT THIS PREDICATE. `taskMergedBy` is populated ONLY by
    // {@link projectMergedTaskCandidates} from an ownership-asserted `merged: true` candidate, so
    // absence here is darkness and this row simply does not match — the PR keeps whatever
    // disposition it had. Nothing infers completion from YAML `status:`.
    //
    // W1-T2779 IS NOT WEAKENED: a plan filing is not a merged implementation candidate, so a
    // complement can never populate this field and can never be closed by this row.
    disposition: "stale",
    when: (pr) => pr.taskMergedBy != null,
    reason: (pr) => `task ${pr.taskId ?? "(unknown)"} already merged by #${pr.taskMergedBy} — closing the leftover implementation PR`,
  },
  {
    disposition: "stale",
    when: (pr) =>
      pr.taskId !== undefined &&
      pr.taskRetirement !== undefined &&
      RETIREMENT_REASONS.includes(pr.taskRetirement) &&
      pr.isPlanFiling === false &&
      pr.planFilingSource === "not-plan-only",
    reason: (pr) =>
      `task ${pr.taskId ?? "(unknown)"} is explicitly ${pr.taskRetirement ?? "unclassified"} in the current main plan — closing the leftover implementation PR`,
  },
  {
    // W1-T932 — LETS THIS ROW YIELD, NEVER DISABLES IT: a guard that works for ordinary duplicate
    // PRs must keep working, and an ordinary duplicate carries no verdict at all, so the added
    // clause is false for it and this row matches as it always has. Gated behind
    // `conceptCoexistenceEnabled`, a SEPARATE flag from row 0's. Reads ONLY `status === "unique"`,
    // never `"indeterminate"` or an absent verdict — fail CLOSED to today's arithmetic.
    disposition: "stale",
    when: (pr, policy) =>
      pr.supersededBy != null &&
      pr.supersessionVerdict?.status !== "complementary" &&
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
    // W1-T54's dep lane, ROUTED. Before this row dep PRs sat ungated until an operator ran
    // `rmd dep-review` by hand, and the failure rows below would misroute them — a ci-log fix rung
    // must never push commits onto a Dependabot branch. The lane holds on red checks and escalates
    // majors, so routing is safe in every state; superseded and stale above still close first.
    disposition: "dep-review",
    when: (pr) => pr.isDependabot === true,
    reason: (pr) => `dependabot PR — dep-review lane (checks ${pr.checksState}, review ${pr.reviewState})`,
  },
  {
    // W1-T3078 — a worker can DECLINE a criterion under review.ts's closed grammar, but it may
    // never choose its own remedy or spend another attempt. This must sit above an answered
    // clarification and the shared strike-cap row: a pre-existing answer or a prior strike cannot
    // convert a refusal into a speculative patch. Required-CI red still wins via the explicit
    // guard, because that independent blocker must be repaired before any review verdict matters.
    disposition: "refused-escalate",
    when: (pr) =>
      !isBlockedCi(pr) &&
      pr.reviewState === "failure" &&
      onlyRefusedUnmetCriteria(pr.unmetCriteria),
    reason: (pr) =>
      `worker refused ${pr.unmetCriteria.length} acceptance criteri${pr.unmetCriteria.length === 1 ? "on" : "a"} ` +
      `(${refusedCriterionClasses(pr.unmetCriteria)}) — escalating without a fix strike`,
  },
  {
    // W1-T78: an operator's answer RE-ARMS the fix rung, but only within its own strike
    // allowance, so a bad answer still eventually escalates rather than looping. W1-T100
    // generalised it to the blocked_ci shape via the same `isBlockedCi` rows 4 and 5 share —
    // without that, a strike-exhausted blocked_ci PR could never be re-armed by an answer.
    disposition: "blocked-fixable",
    when: (pr, policy) => {
      if (!pr.pendingAnswer) return false;
      const reviewShape = pr.reviewState === "failure" && pr.unmetCriteria.length > 0;
      if (!reviewShape && !isBlockedCi(pr)) return false;
      const clarify: ClarifyPolicy = {
        resetStrikeCounterOnAnswer: pr.pendingAnswer.resetStrikeCounter ?? policy.clarify.resetStrikeCounterOnAnswer,
      };
      // `strikeCapForAnswer` returns the ADDITIONAL strikes an answer grants, so the cumulative
      // ceiling is the ORIGINAL cap plus that allowance — never an unconditional bypass of the
      // ledger's running count.
      return pr.priorStrikes < policy.strikeCap + strikeCapForAnswer(policy.strikeCap, clarify);
    },
    reason: (pr) =>
      `operator answered the clarification question — re-dispatching the fix rung with the added constraint (strike ${pr.priorStrikes + 1})`,
  },
  {
    // W1-T2299 — A CORRECTED INPUT CAN REACH THE REVIEWER THAT JUDGED THE OLD ONE. Rows 4/6/7 claim
    // every failing PR and none reads a timestamp, so a posted FAILURE used to make a head
    // permanently unofferable. Requires STRICT ZERO judgments for this exact head+body digest, so
    // coarse activity leaving the digest unchanged falls through to those rows.
    //
    // THE REVIEWER KEEPS ITS TEETH — only WHICH INPUT is judged changes, and a fresh verdict is
    // posted from scratch, so a re-offered head can still fail. NOT AUTHORITY TO OVERWRITE A
    // DIFFERENT BODY (W1-T2793): the guarded status site re-compares the digest before publishing.
    disposition: "post-review",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      pr.reviewState === "failure" &&
      reviewVerdictOvertakenByActivity(pr) &&
      pr.priorReviewAttemptsForInput === 0,
    reason: (pr) =>
      `checks green, remudero-review failed but the PR has seen activity since that verdict was posted ` +
      `(GitHub's PR object carries no body-specific timestamp, so this is activity-after-a-verdict, not ` +
      `provably a body edit), and the exact current input has no completed judgment — re-running ` +
      `the review lane on #${pr.prNumber} to judge the current input; ` +
      `a fresh verdict is posted and the prior one is never carried forward`,
  },
  {
    // GitHub can carry an exact-head remudero-review FAILURE this daemon never ledgered — an
    // externally posted status, lost state, or a host move. The generic failure rows recover
    // structured reasons only from `review.posted`, so with no matching row they escalated
    // "contradictory" forever. Requiring STRICT zero, not undefined, keeps legacy callers
    // byte-identical; `reviewPostRefused` makes the recovery one-shot for an unchanged input.
    disposition: "post-review",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      pr.reviewState === "failure" &&
      pr.reviewInputDigest !== undefined &&
      pr.priorReviewAttemptsForInput === 0 &&
      pr.reviewPostRefused !== true,
    reason: (pr) =>
      `checks green, remudero-review reports failure but the ledger has no matching completed ` +
      `review.posted evidence for this exact input — re-running the authoritative reviewer on ` +
      `#${pr.prNumber} to restore authoritative evidence in structured form; one exact-input post refusal stops retries`,
  },
  {
    // W1-T100: the exhaustion check now covers BOTH failure shapes — a failing
    // review AND a blocked_ci PR (checks red) — off the SAME strike counter/cap
    // (design note iv: one ladder, one exhaustion route).
    disposition: "blocked-ambiguous",
    when: (pr, policy) => (pr.reviewState === "failure" || isBlockedCi(pr)) && pr.priorStrikes >= policy.strikeCap,
    // W1-T186: once checks are the reason strikes exhausted, NAME the check and sha here too, so
    // the ledgered reason never reads as the generic, uninvestigable "fix strikes exhausted".
    //
    // W1-T2452: the denominator is {@link fixCeilingInForce}, NEVER the bare `policy.strikeCap` —
    // an answered PR renders against its EXTENDED ceiling, so reaching it reads as exactly that
    // rather than an impossible overshoot of the base cap.
    reason: (pr, policy) => {
      const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
      return isBlockedCi(pr)
        ? `fix strikes exhausted (${pr.priorStrikes}/${ceiling}) — ${describeCiFailures(pr)} — escalating`
        : `fix strikes exhausted (${pr.priorStrikes}/${ceiling}) — escalating`;
    },
  },
  {
    // W1-T100, broadened and PROMOTED ahead of the review-failing rows by W1-T138: blocked_ci is
    // POSITIVELY fixable — never the catch-all's escalate, and never re-litigated as a
    // review-unmet block just because a possibly stale verdict also sits on this head. The
    // exhausted case already matched row 4, so only a non-exhausted checks-red PR reaches here.
    // Fix FIRST, ask only after exhaustion.
    disposition: "blocked-fixable",
    when: (pr) => isBlockedCi(pr),
    // W1-T2452: denominator is {@link fixCeilingInForce}, not the bare `policy.strikeCap` — see
    // that function's own doc; keeps this ratio naming the SAME ceiling the dispatch site
    // (`dispatchFix`, run-task.ts) actually budgets against.
    reason: (pr, policy) => {
      const base = `${pr.checksState === "red" ? "required checks red" : describeCiFailures(pr)}`;
      // W1-T2998 — NAME THE DETERMINISTIC REMEDY WHENEVER ONE EXISTS, INDEPENDENTLY OF WHETHER IT
      // MAY BE TAKEN. With `recordableRatchetRepairEnabled` false this sentence is the ONLY effect
      // of the classifier, and it is not decoration: it tells the operator reading the ledger, and
      // the worker reading the dispatch, that the whole fix is a recorded number and names the
      // script that writes it. The strike ratio is unchanged either way.
      const repair = recordableRatchetRepairFor(pr);
      if (repair) {
        const how = repair.map((r) => `npm run ${r}`).join(" && ");
        const taken = policy.recordableRatchetRepairEnabled === true;
        return (
          `${base} — every red check is a RECORDABLE ratchet whose remedy is a recorded number (${how}) — ` +
          (taken
            ? "repairing deterministically instead of spending a fix round"
            : `deterministic repair is available but DISABLED (recordableRatchetRepairEnabled) — ci-log fix, strike ${pr.priorStrikes + 1}/${fixCeilingInForce(pr, policy.strikeCap, policy.clarify)}`)
        );
      }
      return `${base} — ci-log fix, strike ${pr.priorStrikes + 1}/${fixCeilingInForce(pr, policy.strikeCap, policy.clarify)}`; // W1-T2504: "red" is byte-identical; else names the specific check.
    },
  },
  {
    // W1-T1269 — AN EARLIER STOP, NEVER A LONGER LEASH. Ordered after row 4 (a PR at the cap
    // keeps that row's own reason) and after row 5 (checks-red still gets ci-log first), but
    // strictly before row 6, so a dispatch that would only reproduce a strike already proven to
    // add nothing is preempted the first time it recurs. `fixRungRepeatsIdenticalFailure` fails
    // CLOSED until a producer populates `StrikeAttempt.unmetClaims`, so this row is inert today.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.reviewState === "failure" && fixRungRepeatsIdenticalFailure(pr),
    reason: (pr, policy) =>
      `fix strike repeated the identical unmet criteria (strike ${pr.priorStrikes}/${policy.strikeCap}) — ` +
      `no further strike can add information — escalating before the cap`,
  },
  {
    // W1-T3172 — Rule 25's refusal is structurally fixable only through W1-T2436's prerequisite
    // worker, never an in-place strike. The exact-head/input board producer supplies both path
    // sets; this boundary validates them again. Ordered AFTER exhaustion so the configured cap
    // still wins, but BEFORE ordinary review routing because this arm spends zero ordinary
    // strikes and reconstructs a different first effect.
    disposition: "blocked-fixable",
    when: (pr) =>
      pr.reviewState === "failure" &&
      pr.instrumentEntangled === true &&
      usableInstrumentEntanglementPaths(pr.instrumentEntanglementPaths),
    reason: () =>
      "structured instrument entanglement — dispatching W1-T2436 prerequisite split worker with zero ordinary strikes",
  },
  {
    // Reached only when checks are NOT red (row 5 claimed that) and the unmet set is not a proven
    // repeat (row 5.5 claimed that) — a pure review-shaped block. Genuinely REACHABLE for a review
    // failure (W1-T394): `checksState` never goes red off `remudero-review` alone, so a
    // checks-green PR whose review fails lands here rather than being claimed by row 5.
    //
    // W1-T923 adds a THIRD disjunct, never a new rule: a GATE failure with empty `unmetCriteria`
    // that named a single-form remedy routes here exactly like a criterion failure. When
    // `unmetCriteria` is non-empty this row is byte-identical to before that task.
    disposition: "blocked-fixable",
    when: (pr) => pr.reviewState === "failure" && (pr.unmetCriteria.length > 0 || (pr.actionableGateFailures?.length ?? 0) > 0),
    // W1-T2452: denominator is {@link fixCeilingInForce} in both branches — see that
    // function's own doc; keeps this ratio naming the SAME ceiling the dispatch site
    // (`dispatchFix`, run-task.ts) actually budgets against.
    reason: (pr, policy) => {
      const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
      if (pr.unmetCriteria.length > 0) {
        return `${pr.unmetCriteria.length} unmet criteri${pr.unmetCriteria.length === 1 ? "on" : "a"} — strike ${pr.priorStrikes + 1}/${ceiling}`;
      }
      const n = pr.actionableGateFailures!.length;
      return `${n} actionable gate failure${n === 1 ? "" : "s"} (named remedy) — strike ${pr.priorStrikes + 1}/${ceiling}`;
    },
  },
  {
    // W1-T440: the SAME empty `unmetCriteria` has two distinct causes, and the reason used to
    // name the wrong one unconditionally. `criteriaRecoverable === false` is the OBSERVED signal
    // that no trailer resolved a task id, so the criteria were never RECOVERABLE, not
    // contradicted. Anything else means a trailer DID resolve and the ledger genuinely returned
    // nothing unmet — that arm keeps today's wording verbatim for every attributable PR.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.reviewState === "failure",
    reason: (pr) =>
      pr.criteriaRecoverable === false
        ? // W1-T2541: name the DERIVED repair, not only the defect. `diagnoseBodyDefects` reads the
          // Names the trailer the same way `projectPlan` does, so it invents nothing. Diagnosis
          // only: nothing here edits a body (see lib/body-repair.ts).
          // Why: measured 2026-08-31 on #3363/#3400/#3403 — docs/forensics/sweep.md.
          `review failing — criteria unrecoverable (no Remudero-Task: trailer to resolve them from) — escalating` +
          (() => {
            const d = diagnoseBodyDefects("", [], { headRef: pr.headRefName });
            const repair = d.find((x) => x.kind === "no-trailer")?.repair;
            return repair === undefined ? "" : ` — derived repair: add \`${repair}\` to the PR body`;
          })()
        : // W1-T3029 — THE THIRD CAUSE OF THE SAME EMPTY SET, tested strictly after the arm above so
          // W1-T440's unrecoverable case still wins wherever it applies (design v). A rule-15
          // refusal is FULLY DIAGNOSED — `failSummary` states the PR shape to change — so calling
          // it "contradictory" names a property the verdict does not have. Disposition is
          // deliberately unmoved; see {@link namesRule15Refusal} for why routing it would be worse.
          namesRule15Refusal(pr)
          ? `review failing on Standing rule 15 — a criterion was added/edited beside non-plan files — ` +
            `escalating — derived repair: file the shard in its own plan-only PR, then build it in a second PR`
          : "review failing with no actionable unmet criteria (contradictory) — escalating",
  },
  {
    // W1-T106 — CONFLICTED is a POSITIVE disposition, ABOVE mergeable: a dirty PR is NEVER armed
    // however green. None of rows 3-7 reference `mergeState`, so this placement changes no
    // precedence; it only guarantees row 8 never sees a dirty PR. Deterministically fixable (rule
    // 2, never an LLM judgment) ONLY when {@link isPureConcurrentAddition},
    // {@link isRegenerableArtifactConflict}, or {@link isRedundantRefixConflict} clears EVERY file;
    // a conflict satisfying none of those arms falls to the next row. Why: the flag's history and
    // the #170 incident — docs/forensics/sweep.md.
    disposition: "conflicted",
    when: (pr, policy) => {
      if (policy.mergeConflictAdmissionEnabled !== true || pr.mergeState !== "dirty") return false;
      const evidence = pr.mergeConflict;
      const files = evidence?.files ?? [];
      // W1-T2548: a SECOND, independent admission arm — either clears this row alone, never both
      // required. The registry arm is checked first only because its reason is the more specific
      // of the two when both happen to hold.
      return isRegenerableArtifactConflict(files) || isRedundantRefixConflict(evidence) || isPureConcurrentAddition(files);
    },
    reason: (pr) => {
      const evidence = pr.mergeConflict;
      const files = evidence?.files ?? [];
      if (isRegenerableArtifactConflict(files)) {
        const named = files.map((f) => `${f.path} (generator: ${REGENERABLE_ARTIFACT_GENERATORS[f.path]})`).join(", ");
        return (
          `merge conflict (mergeState dirty) — every conflicting path has a declared generator: ${named} — ` +
          `dispatching the merge-conflict fix mode to RE-RUN the generator(s) on the merged tree — the ` +
          `resolution is that output, never either side's recorded value`
        );
      }
      if (isRedundantRefixConflict(evidence)) {
        const paths = evidence!.redundantRefix!.comparedPaths.join(", ");
        return (
          `merge conflict (mergeState dirty) — redundant re-fix byte comparison matched main for ` +
          `${paths}; resolving those conflicting path(s) to main is byte-identical to main and the ` +
          `branch's non-conflicting files apply cleanly — dispatching the merge-conflict fix mode to ` +
          `take main for the redundant hunk(s)`
        );
      }
      return (
        `merge conflict (mergeState dirty) — pure concurrent addition on ` +
        `${files.map((f) => f.path).join(", ")} — dispatching the merge-conflict fix mode`
      );
    },
  },
  {
    // W1-T106 — the OTHER half of the same strand: a dirty PR whose conflict involves a DELETION
    // on either side, or whose evidence could not be captured, is NEVER auto-resolved. "A wrong
    // auto-resolution is worse than a strand" (design note iii, verbatim). REFUSE into escalate,
    // the SAME blocked-ambiguous rung every other ambiguous block routes through, naming the
    // conflicting files so an operator need not re-derive them.
    //
    // W1-T984: this escalation names the real paths AND each side's deletion count, so
    // `files: none captured` now means evidence genuinely could not be read.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.mergeState === "dirty",
    reason: (pr, policy) => {
      const evidence = pr.mergeConflict;
      const files = evidence?.files ?? [];
      const fileList = files.map((f) => `${f.path} (ours -${f.oursDeleted}, theirs -${f.theirsDeleted})`).join(", ");
      return (
        `merge conflict (mergeState dirty) — ${conflictRefusalCause(files, policy, REGENERABLE_ARTIFACT_GENERATORS, evidence)} — never auto-resolved — ` +
        `files: ${files.length > 0 ? fileList : "none captured"} — escalating`
      );
    },
  },
  {
    // W1-T2860 — GitHub can carry an exact-head remudero-review SUCCESS without the completed
    // `review.posted` row W1-T230 requires before arming. The status alone cannot recreate the
    // structured proof evidence, so route the contradiction through the same authoritative
    // reviewer. Deliberately symmetric with the unowned FAILURE recovery above: both identity
    // signals must be present and the count STRICTLY zero, so legacy callers stay mergeable.
    disposition: "post-review",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      pr.reviewState === "success" &&
      pr.reviewInputDigest !== undefined &&
      pr.priorReviewAttemptsForInput === 0 &&
      pr.reviewPostRefused !== true,
    reason: (pr) =>
      `checks green and GitHub reports remudero-review success, but the ledger has no matching completed ` +
      `review.posted evidence for this exact input — re-running the authoritative reviewer on ` +
      `#${pr.prNumber} before auto-merge; one exact-input post refusal stops retries`,
  },
  {
    // POSITIVE MATCH ONLY (W1-T93): mergeable is NEVER inferred from the mere absence of a
    // failure. It requires required-checks green AND review success, named explicitly — P22's own
    // words, "required contexts green, review success, unmerged".
    disposition: "mergeable",
    when: (pr) => pr.checksState === "green" && pr.reviewState === "success",
    reason: () => "review success, required checks green — arming auto-merge",
  },
  {
    // W1-T176 — a required check with ZERO observed runs is DETERMINISTIC-ACTION, not
    // blocked-ambiguous, but only ONCE. Ordered STRICTLY BEFORE the post-review row so a PR whose
    // post already came back REFUSED for this head never re-reaches that dispatch: the remedy has
    // run its course, and retrying would loop against a lane that already declined. Uses the SAME
    // escalate path as every other ambiguous block, so an operator sees a genuine question
    // instead of the PR sitting silently deduped forever.
    disposition: "blocked-ambiguous",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.reviewState === "none" &&
      pr.reviewPostRefused === true &&
      pr.requiredContextsUnreadable !== true,
    reason: () =>
      "required check (remudero-review) has zero observed check runs and the one deterministic post " +
      "attempt for this exact review input was refused — escalating rather than retrying indefinitely",
  },
  {
    // W1-T225 — THE LOOP FALSIFIER: a PR whose review was orphaned by a push re-earns the review
    // lane below, but not unboundedly for the SAME head+body input. Ordered strictly before that
    // row so a status that repeatedly disappears after completed judgments eventually asks an
    // operator. A new push or body edit resets the exact-input counter immediately. A PR awaiting
    // its FIRST review never matches — only one demonstrably reviewed before can exhaust this cap.
    // W1-T1018: the cap is no longer a PERMANENT wall — {@link reviewInputBackoffElapsed} must
    // ALSO read false, so once the backoff elapses this row yields and dispatch resumes.
    disposition: "blocked-ambiguous",
    when: (pr, policy, _ageDays, now) =>
      pr.checksState === "green" &&
      pr.reviewState === "none" &&
      pr.reviewOrphanedByPush === true &&
      (pr.priorReviewAttemptsForInput ?? 0) >= policy.reviewOrphanCap &&
      pr.requiredContextsUnreadable !== true &&
      !reviewInputBackoffElapsed(pr, policy, now),
    reason: (pr, policy) =>
      `review orphaned by a push, again — the sweep has already judged this unchanged review input ${pr.priorReviewAttemptsForInput} ` +
      `time(s) (>= ${policy.reviewOrphanCap} cap) — escalating; re-reviewing again after ` +
      `${policy.reviewOrphanBackoffMinutes}m of backoff, never stopping outright`,
  },
  {
    // POST-REVIEW ROUTING (the #584 stall, narrowed by W1-T176): a checks-GREEN PR whose review was
    // never posted used to fall to the catch-all and ESCALATE, so a hand-opened PR could sit fully
    // green forever. An ABSENT required check is mechanically decidable on its FIRST sighting, so
    // route it to the SAME `reviewCommand` the operator verb runs. A PR with no criteria posts FAIL
    // fail-closed, a LEGIBLE gate state rather than an escalation.
    //
    // W1-T225 also routes a review ORPHANED BY A PUSH here — identical dispatch, different reason,
    // prior verdict never carried forward. W1-T913/W1-T2844: `"pending"` matches once the owner is
    // proven dead or the pending is stale; a FRESH pending is EXCLUDED, claimed as `wait` below.
    disposition: "post-review",
    when: (pr, policy, _ageDays, now) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      (pr.reviewState === "none" ||
        (pr.reviewState === "pending" &&
          (pr.reviewPendingOwnerDead === true || reviewPendingIsStale(pr, policy, now)))),
    reason: (pr, policy, _ageDays, now) => {
      if (pr.reviewState === "pending") {
        if (pr.reviewPendingOwnerDead === true) {
          return `checks green, remudero-review owner proven dead — re-running the review lane on #${pr.prNumber}`;
        }
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
    // W1-T913: a FRESH, not-yet-stale pending is a review this system already dispatched and is
    // genuinely IN FLIGHT. Ordered STRICTLY AFTER the post-review row, so anything reaching here
    // has already failed that row's staleness check. Without this row a fresh pending would fall
    // to the catch-all and ESCALATE every tick for the duration of an ordinary review — trading
    // the silence this task fixes for an escalation storm, which is strictly worse.
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
    // W1-T2340 — A HEAD PENDING ONLY BECAUSE A CONCLUDED RUN PINNED ONE OF ITS JOBS reads exactly
    // like ordinary in-flight CI to the rows below, and would wait out the ceiling even though the
    // run that pinned the job is DONE. Ordered STRICTLY BEFORE them so a stalled head is named the
    // moment it is detectable; this shape needs no threshold at all. GATED ON `"pending"`
    // EXPLICITLY, never `"none"`, so it cannot fire on the input the ABSENT arm owns. TAKES NO
    // ACTION — re-running a concluded run is left to the operator, GitHub having refused it 403.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.checksState === "pending" && stalledRunReason(pr.workflowRuns) !== undefined,
    reason: (pr) =>
      `stalled, not pending — ${stalledRunReason(pr.workflowRuns)} — a required check that never truly ` +
      `finished still blocks the merge; escalating once rather than waiting on something that will not arrive`,
  },
  {
    // WAIT (W1-T114). Never reached with a FAILING review or red checks — rows 4-7 claimed those,
    // so only checks-pending survives here. Requires a DATABLE age; undated pending falls through
    // to the catch-all unchanged, the pre-W1-T114 behaviour for callers that never wired the
    // timestamp.
    // Why: ~24 of 30 open needs-human issues on 2026-07-19 were exactly this shape.
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
    // STALE-PENDING (W1-T114): the SAME datable-pending shape as the row above, but the ceiling is
    // met or exceeded — a check stuck this long IS ambiguity, not merely in-flight. Uses the SAME
    // escalate path as the catch-all, with the elapsed minutes and the ceiling both named.
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
    // NOT-YET-SCHEDULED (W1-T1103) — the THIRD reading of `checksState === "none"`: a head seconds
    // old with zero runs and one hours old with zero runs are the SAME count and OPPOSITE
    // situations. THE DISCRIMINATOR IS THE CLOCK the re-push remedy ALREADY OWNS, never a second
    // guessed constant — a bound firing on a healthy condition is this repo's recurring defect.
    // UNDATED FAILS TOWARD ESCALATE: an unreadable age is not evidence of youth, and treating it as
    // young would let a broken suite wait forever behind a bad timestamp.
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
    // TERMINAL rule, matching unconditionally — the LEAST permissive disposition (W1-T93), not the
    // most. A checks-red PR is caught by row 5 and a DATABLE checks-pending PR by rows 9/10, so
    // neither lands here. Anything else not positively mergeable and not failure-shaped no longer
    // falls through to mergeable by default: it lands here and ESCALATES, naming the observed
    // state, so it is never silent and never armed.
    disposition: "blocked-ambiguous",
    when: () => true,
    reason: (pr) =>
      `not positively mergeable — checks ${pr.checksState}, review ${pr.reviewState} — escalating`,
  },
];

/** Derive ONE open PR's disposition from observed state and policy — PURE, TOTAL, deterministic. It
 *  computes the one derived scalar the table needs and returns the first matching
 *  {@link DISPOSITION_RULES} row. W1-T1201 — AGE IS CLAMPED TO THE PR'S OWN LIFETIME, once, before
 *  any row reads it, AND THE CLAMP DOES NOT SILENTLY RESCUE: when it changes the outcome the
 *  `reason` says so, because a shifted clock once closed eleven live PRs. */
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
  // W1-T1201: the clamp can only ever SUPPRESS the bare stale row, the only row reading the
  // computed scalar. When the raw activity age would have crossed that threshold and the clamped
  // age does not, that suppression is a BROKEN-CLOCK SIGNAL, so it is folded into whichever other
  // row's reason actually fired.
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

/** W1-T983 — is this PR's disposition the CAPPED-GREEN-REVIEW-ORPHAN shape: the ONE
 *  blocked-ambiguous disposition reclassified to a reaching escalation tier. PURE, with no spawn and
 *  no GitHub call, mirrored EXACTLY off the conditions the cap row already reads. W1-T1018:
 *  deliberately still four conditions — a PR only reaches this when the cap row already matched. */
export function isCappedReviewOrphanEscalation(pr: OpenPrView, policy: SweepPolicy): boolean {
  return (
    pr.checksState === "green" &&
    pr.reviewState === "none" &&
    pr.reviewOrphanedByPush === true &&
    (pr.priorReviewAttemptsForInput ?? 0) >= policy.reviewOrphanCap &&
    pr.requiredContextsUnreadable !== true
  );
}

/** ARMING PARITY WITH THE RUN FLOW — a PR the run flow refused stayed open and unarmed, but a later
 *  sweep poll could still arm it through this separate path. NOT A SECOND IMPLEMENTATION: this
 *  delegates to {@link decideAutoMergeArm}, the SAME predicate the run flow calls. FAIL-OPEN ON
 *  ABSENT EVIDENCE — refusal requires positively observing `capped: true, plan_only: false` for THIS
 *  head. // Why: #800 armed at proof_exec 0/5 and merged 35 seconds later. */
export function decideSweepArm(
  pr: OpenPrView,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  // W1-T1028 — appended LAST, the SAME idiom {@link decideAutoMergeArm} uses, so no positional
  // caller shifts and omitting it is byte-for-byte today's behaviour. `OpenPrView` gains no field:
  // the run flow's classification is worktree-bound and this pass has no worktree, so the field
  // would be permanently unproducible.
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
  /** W1-T3277: the main-distance fact that selected this ordinary stale PR, when present. */
  behindBy?: number;
  /** W1-T3277/W1-T1212: why this PR reached the shared update-branch effect. */
  updateReason?: "armed-stalled" | "stale-gate" | "distance";
}

/** W1-T528 — the terminal outcome of ONE `gh pr update-branch` request; only these three are
 *  established without a live call against a real PR. `"updated"`: GitHub ACCEPTED the request, and
 *  the update completes asynchronously. `"conflict"`: GitHub refused — a real conflict, or a
 *  diverged head — reported and never retried by this call. `"error"`: any other failure. */
export type UpdateBranchOutcome = "updated" | "conflict" | "error";

/** W1-T520 — ARMED AND BEHIND, THE TWO FACTS NOTHING JOINED. Separately unremarkable; together they
 *  describe a PR that has done everything it can and stopped. WHY THE DETECTOR AND NOT THE FIX:
 *  acting mints a NEW HEAD, and a verdict is input-pinned, so every update discards the verdict it
 *  was waiting on. PURE AND FAIL-QUIET — an unread `mergeState` is not a stall. */
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
      updateReason: "armed-stalled",
    });
  }
  return out;
}

/** W1-T3277 — ordinary open PRs whose base has rotted far enough to deserve the same single
 *  update-branch press the armed/stalled rung already owns. The commit distance is injected data:
 *  `sweep.ts` stays pure and never performs a GitHub/git comparison itself. */
export function openPrsBehindMain(
  prs: readonly OpenPrView[],
  behindMainByPr: ReadonlyMap<number, number>,
  policy: Pick<SweepPolicy, "reviewWaitingBranchRefreshEnabled" | "reviewWaitingBranchRefreshThreshold">,
): ArmedStalledPr[] {
  if (policy.reviewWaitingBranchRefreshEnabled !== true) return [];
  const out: ArmedStalledPr[] = [];
  for (const pr of prs) {
    const behindBy = behindMainByPr.get(pr.prNumber);
    if (behindBy === undefined) continue;
    if (behindBy <= policy.reviewWaitingBranchRefreshThreshold) continue;
    if (pr.mergeState === "dirty" || pr.mergeable === false) continue;
    out.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
      headSha: pr.headSha,
      behindBy,
      updateReason: "distance",
    });
  }
  return out;
}

/** W1-T528 — THE ACTION HALF OF W1-T520: selects AT MOST ONE PR from {@link armedButStalled}'s own
 *  set, never a second predicate recomputing the same two facts. ONE PER PASS, OLDEST HEAD FIRST —
 *  updating mints a NEW head and a verdict is input-pinned, so updating the whole stalled set each
 *  pass costs N+(N-1)+…+1 reviews. TWO EXCLUSIONS: a DRAFT, and an IN-FLIGHT HEAD. */
export function selectUpdateBranchTarget(
  prs: readonly OpenPrView[],
  now: number,
  inFlightTaskIds: ReadonlySet<string> = new Set(),
  staleGateWorkflowsByPr: ReadonlyMap<number, readonly string[]> = new Map(),
  updatedForWorkflow: ReadonlySet<string> = new Set(),
  behindMainByPr: ReadonlyMap<number, number> = new Map(),
  policy: Pick<SweepPolicy, "reviewWaitingBranchRefreshEnabled" | "reviewWaitingBranchRefreshThreshold"> = DEFAULT_SWEEP_POLICY,
): ArmedStalledPr | undefined {
  // W1-T1212: the UNION of two disjoint-by-construction predicates, never a widening of either. A
  // PR named by both contributes ONE candidate; the first writer wins, and which shape wins
  // carries no meaning the comparator below reads.
  const combined = new Map<number, ArmedStalledPr>();
  for (const c of [
    ...armedButStalled(prs),
    ...redPrWithStaleGate(prs, staleGateWorkflowsByPr, updatedForWorkflow),
    ...openPrsBehindMain(prs, behindMainByPr, policy),
  ]) {
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

/** One PR {@link redPrWithStaleGate} selected — sibling to {@link ArmedStalledPr}, carrying the
 *  ONE extra fact the caller needs: which failing check's workflow moved on main, so the pair can
 *  be remembered and never re-selected for the same workflow. */
export interface StaleGatePr extends ArmedStalledPr {
  /** The currently-failing check whose workflow blob differs between this PR's merge ref and main. */
  staleWorkflow: string;
}

/** W1-T1212 — A RED PR RUNS A FROZEN COPY OF THE VERY GATE THAT BLOCKS IT: the merge ref's base
 *  parent is pinned at the last `synchronize`, so a gate fixed on main never reaches an older merge
 *  ref. `armedButStalled` cannot reach this population, since a red PR is never armed. THE
 *  DISCRIMINATOR IS EXACT, never "behind main" alone. REFUSED BY NAME: a CONFLICTED PR, and one
 *  whose stale names are ALL already spent. */
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
      updateReason: "stale-gate",
    });
  }
  return out;
}

// ── W1-T78 — THE CLARIFICATION-QUESTION rung (ratifies P22's new rung) ───────────────────────
//
// An ambiguous block yields a SPECIFIC, decidable operator question, never silence.
// `renderClarificationQuestion` is PURE: it renders ONLY what the sweep and ledger observed, never
// inventing a criterion or a resolution. Emitted per the §2 QUESTION contract to the durable backlog,
// with `escalate()` as the notification transport — both wired in run-task.ts.

/** One recorded fix-rung strike's outcome for a task — "what the fix worker tried", ledger ground
 *  truth ONLY, never inferred. Derived from `fix.dispatch`/`fix.review` rows by run-task.ts's
 *  `deriveStrikeHistory`. */
export interface StrikeAttempt {
  strike: number;
  round: "resume" | "fresh";
  /** Unmet criteria count going INTO this strike. */
  unmetCount: number;
  /** W1-T1269 — the unmet criteria CLAIM SET going into this strike, written by the same
   *  `fix.dispatch` ledger event that spends it. It tells a strike that failed IDENTICALLY from one
   *  that fixed half, which {@link unmetCount} cannot. */
  unmetClaims?: readonly string[];
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

/** The rendered output of the clarification rung for ONE blocked-ambiguous PR: the exact decision,
 *  both candidate resolutions, and the run and PR context — never a generic needs-human. */
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
  /** W1-T186: which named {@link ObservedBlockerState} this escalation observed, or `undefined`
   *  for an ordinary review-failure block where the criterion fields already say everything. */
  observedState?: ObservedBlockerState;
}

/** Render ONE blocked-ambiguous PR's clarification question deterministically, from ledger ground
 *  truth ONLY: the task id, the unmet criterion (claim vs the reviewer's requirement vs the spec's
 *  own proof text), and what the fix worker tried per strike. PURE, no guessing — with no single
 *  criterion to point at it names the observed disposition `reason`, but is NEVER silent. */
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
            // W1-T186: "checks", never "CI" — this sentence also renders inside a CONFLICTED
            // escalation, which must never contain the literal word "CI" (none ever ran).
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

  // Shared by both branches below, so editing the resolutions never requires editing the
  // "name both options" text twice.
  const decisionSuffix = `Which is right — (1) ${resolutions[0].label}: ${resolutions[0].detail}, or (2) ${resolutions[1].label}: ${resolutions[1].detail}`;

  const baseQuestion = criterion
    ? `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): after ${strikeHistory.length} fix strike(s) — ${tried} — ` +
      `"${criterion}" is still unmet. The reviewer requires: "${reviewerRequirement}". The spec's own proof text says: ` +
      `"${specText}". ${decisionSuffix}`
    : `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): ${reason} — ${tried}. There is no single actionable unmet ` +
      `criterion to point at. ${decisionSuffix}`;

  // W1-T186: prepend the named observed-blocker facts to EVERY escalation that has them, never
  // only the criterion-shaped ones. "" when none was found and no mergeable state was read.
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

/** Render a {@link ClarificationQuestion} into the §2 QUESTION contract's shape for the durable
 *  backlog. `current_assumption` names what stays true while the PR is unanswered: it never
 *  proceeds on a guess, it stays blocked. */
export function toQuestionEntry(q: ClarificationQuestion, ts: string): QuestionEntry {
  return {
    ts,
    task: q.taskId,
    question: q.question,
    current_assumption: `PR #${q.prNumber} (${q.prUrl}) stays BLOCKED-AMBIGUOUS — unmerged, no further fix strikes dispatched — until the operator answers.`,
    impact_if_wrong: "med",
  };
}

// ── W1-T2345 — THE UNBOUNDED-IDENTICAL-DISPOSITION COUNTER ──────────────────────────────────
//
// A disposition that CANNOT change on an unchanged head is re-derived at full weight forever. This
// bounds the REPETITION, never the verdict: {@link deriveDisposition} is untouched, `sweep.disposed`
// still writes one row every pass, and nothing here paces or sleeps a call.

/** One PR's identical-verdict run, as folded off `sweep.disposed` rows already on the ledger —
 *  see {@link repeatDispositionStreaksFromLedger}'s own doc for the fold rules. */
export interface RepeatDispositionRun {
  headSha: string;
  disposition: string;
  /** Consecutive `sweep.disposed` rows ending at (and including) the last one read. */
  streak: number;
  /** Whether the repeat escalation already fired somewhere inside THIS run, as the SURVIVING rows
   *  report it. W1-T2382: "this run" is bounded by rotation as well as by the head. */
  escalated: boolean;
}

/** Fold every `sweep.disposed` row into each PR's trailing identical-verdict run. KEYED ON
 *  `(disposition, head_sha)`, NEVER ON THE RENDERED `reason`, which carries a live counter. EVERY
 *  ROW COUNTS REGARDLESS OF `acted` — gating on it would exempt exactly the shapes this bound exists
 *  for. `escalated` carries forward only while THE ROWS IT READS SURVIVE, so post-rotation this
 *  legitimately reports a fresh run (W1-T2382).
 *
 * W1-T3359 — READS THE RECORDED `repeat_streak` INSTEAD OF RE-COUNTING SURVIVING ROWS.
 *
 * INVARIANT: retention keeps {@link MAX_RETAINED_LINES_PER_STEP} rows per step, shared across every
 * PR, so a recount can attribute only a fraction of that window to any one PR — sensitivity falls as
 * the fleet gets busier, the opposite of what a bound should do. Reading the streak the writing pass
 * already recorded removes that ceiling: one surviving row states the true count regardless of how
 * many other PRs' rows share the window. The recount stays as the fallback for rows written before
 * this field existed, so a mid-migration corpus is not misread as a fresh run. Measured against the
 * live fleet 2026-09-11: see the PR/task record, not this comment, for the numbers.
 *
 * TRAP: `sweep.disposed` IS retained and always has been — do not re-add it to the retention set or
 * treat rotation as archiving it wholesale, both tried and reverted before this shipped. `escalated`
 * stays derived from surviving rows only, per W1-T2382's per-rotation re-arm; making it durable here
 * would silently convert that into once-per-head-forever.
 *
 * FALSIFIER: test/a-disposition-is-logged-on-change-not-on-every-poll.test.ts. */

/** EXPORTED FOR ITS FALSIFIER, which is the only honest way to test it: mirroring this fold in
 *  test/a-disposition-is-logged-on-change-not-on-every-poll.test.ts made every behavioural mutation
 *  of THIS function survive, because the mirror answered instead. Same precedent as
 *  {@link renderRepeatEscalationQuestion} below — exported and pinned by a test. */
export function repeatDispositionStreaksFromLedger(lines: ReadonlyArray<Record<string, unknown>>): Map<number, RepeatDispositionRun> {
  const runs = new Map<number, RepeatDispositionRun>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed") continue;
    const prNumber = typeof line.pr_number === "number" ? line.pr_number : undefined;
    const headSha = typeof line.head_sha === "string" ? line.head_sha : undefined;
    const disposition = typeof line.disposition === "string" ? line.disposition : undefined;
    if (prNumber === undefined || headSha === undefined || disposition === undefined) continue;
    const prev = runs.get(prNumber);
    const continuesRun = prev !== undefined && prev.headSha === headSha && prev.disposition === disposition;
    // The recorded streak is authoritative when present: the pass that wrote it held the same fold
    // plus its own position in the run, so it can only be better informed than a recount over
    // whatever rows happen to have survived. A non-positive or non-integer value is not a reading.
    const recorded =
      typeof line.repeat_streak === "number" && Number.isInteger(line.repeat_streak) && line.repeat_streak > 0
        ? line.repeat_streak
        : undefined;
    const counted = continuesRun && prev ? prev.streak + 1 : 1;
    runs.set(prNumber, {
      headSha,
      disposition,
      streak: recorded ?? counted,
      escalated: (continuesRun && prev ? prev.escalated : false) || line.repeat_escalated === true,
    });
  }
  return runs;
}

/** Render the repeat-bound trip as a {@link ClarificationQuestion}: with no single unmet criterion
 *  to point at, the two resolutions name the honest outcomes of a verdict that is not disputed,
 *  only stuck repeating. W1-T2381: NO PRODUCTION CALLER — retained because it is exported and
 *  pinned by a test. */
export function renderRepeatEscalationQuestion(
  pr: OpenPrView,
  disposition: Disposition,
  reason: string,
  streak: number,
  bound: number,
): ClarificationQuestion {
  const resolutions: readonly [ClarificationResolution, ClarificationResolution] = [
    {
      label: "acknowledge-unchanged",
      detail:
        `no action needed from the sweep's own dispositioning — verdict "${disposition}" is correct and the sweep ` +
        `will keep re-deriving it every pass; this notice is visibility only, never a request to change the verdict.`,
    },
    {
      label: "intervene-manually",
      detail:
        `the automated remedy (if any) for "${disposition}" has had ${streak} unchanged passes on this head with ` +
        `nothing moving it forward — an operator looks at PR #${pr.prNumber} directly rather than waiting on another pass.`,
    },
  ];
  const question =
    `Task ${pr.taskId ?? "UNKNOWN"}, PR #${pr.prNumber} (${pr.prUrl}): the sweep has dispositioned this PR ` +
    `"${disposition}" ${streak} consecutive time(s) on the SAME head (>= ${bound} repeat bound) — ${reason}. The ` +
    `verdict itself is not in question, only its unchanging repetition is. Which is right — ` +
    `(1) ${resolutions[0].label}: ${resolutions[0].detail}, or (2) ${resolutions[1].label}: ${resolutions[1].detail}`;
  return {
    taskId: pr.taskId ?? "UNKNOWN",
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    question,
    criterion: "",
    reviewerRequirement: reason,
    specText: "",
    strikeHistory: [],
    resolutions,
  };
}

/** The ADDITIONAL strikes an operator's clarification answer grants — PURE and table-free (a second
 *  lever is a field on {@link ClarifyPolicy}, never a branch here). Two uses, ONE number: it IS the
 *  fresh `strikeCap` the re-dispatch passes to `runFixRung`, and the answered row adds it to
 *  `policy.strikeCap` for the cumulative ceiling. */
export function strikeCapForAnswer(originalCap: number, policy: ClarifyPolicy = DEFAULT_CLARIFY_POLICY): number {
  return policy.resetStrikeCounterOnAnswer ? originalCap : 1;
}

/** W1-T2452 — THE CUMULATIVE STRIKE CEILING ACTUALLY IN FORCE: `strikeCap` ordinarily, or the
 *  EXTENDED ceiling once an operator's answer is live — the SAME number the answered
 *  {@link DISPOSITION_RULES} row checks, never a second computation. Every rendered strike ratio and
 *  the real dispatch budget read THIS function, so neither can drift; that drift was the defect. */
export function fixCeilingInForce(
  pr: Pick<OpenPrView, "pendingAnswer">,
  strikeCap: number,
  clarifyPolicy: ClarifyPolicy = DEFAULT_CLARIFY_POLICY,
): number {
  if (!pr.pendingAnswer) return strikeCap;
  const clarify: ClarifyPolicy = {
    resetStrikeCounterOnAnswer: pr.pendingAnswer.resetStrikeCounter ?? clarifyPolicy.resetStrikeCounterOnAnswer,
  };
  return strikeCap + strikeCapForAnswer(strikeCap, clarify);
}

/** W1-T2452 — THE STRIKE BUDGET TO DISPATCH: the REMAINDER against {@link fixCeilingInForce}, NEVER
 *  a fresh full cap, because `runFixRung` counts each new call from 0 and a fresh cap let the
 *  cumulative ledger count exceed the ceiling. Returns `null` when the remainder is non-positive,
 *  THE LOAD-BEARING HALF: a silent zero-budget dispatch strands an otherwise-fixable PR forever. */
export function fixDispatchBudget(priorStrikes: number, ceiling: number): number | null {
  const remaining = ceiling - priorStrikes;
  return remaining > 0 ? remaining : null;
}

/** The last line in `lines` matching `pred` — append-only files read oldest-first, so the
 *  last match is the NEWEST record. Shared by both halves of {@link operatorVerdictEvidence}. */
function lastMatching<T extends Record<string, unknown>>(lines: ReadonlyArray<T>, pred: (l: T) => boolean): T | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pred(lines[i])) return lines[i];
  }
  return undefined;
}

/** W1-T435 — the fix rung's OPERATOR-STEERED re-arm, producing the SAME
 *  {@link OpenPrView.pendingAnswer} shape W1-T78 wired but never had a producer for, routed through
 *  the identical row and ceiling. ONE pass over TWO local sources: a one-tap verdict carrying a
 *  STEERING NOTE, quoted VERBATIM, and an ANSWERED clarification. A `good` verdict NEVER contributes. */
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

/** The block evidence `dispatchFix` carries, GENERALIZED (W1-T100) from a bare unmet array to the
 *  mode-evidence shape, so a checks-red PR carries ci-log input instead of an always-empty list.
 *  Exactly one field is meaningful per disposition. W1-T2236: `actionableGateFailures` rides
 *  ALONGSIDE `unmetCriteria` on a review-mode dispatch, which used to discard it at this boundary. */
export interface FixDispatchEvidence {
  unmetCriteria: CriterionVerdict[];
  ciFailures?: CiFailure[];
  /** W1-T106: the merge-conflict fix mode's input — populated for a `conflicted` dispatch only. */
  mergeConflict?: MergeConflictEvidence;
  /** W1-T2236: see this interface's own doc, above. Populated ONLY when `unmetCriteria` is empty. */
  actionableGateFailures?: ActionableGateFailure[];
  /** W1-T3172: cold-sweep authority for W1-T2436's prerequisite-worker route. */
  instrumentEntangled?: true;
  /** W1-T3172: exact validated path sets from the authoritative review ledger row. */
  instrumentEntanglementPaths?: InstrumentEntanglementPaths;
  /** W1-T3306: the exact capped proofs that need a body-only discrimination repair. */
  proofDiscrimination?: ProofDiscriminationEvidence;
}

/** The only proof grades that establish the capped-green repair has a mechanical body remedy. */
export interface ProofDiscriminationEvidence {
  readonly proofs: ReadonlyArray<{
    readonly claim: string;
    readonly proof: string;
    readonly proofExec: "executed_stale" | "not_executable";
  }>;
}

/**
 * Extract the only proof rows a capped-green repair worker may act on. This is
 * deliberately structural: a reason string is rendered prose and must never
 * decide whether a strike is spent.
 */
export function proofDiscriminationEvidenceFromCriteria(
  criteria: readonly CriterionVerdict[],
): ProofDiscriminationEvidence | undefined {
  const proofs = criteria.flatMap((criterion) =>
    criterion.proof_exec === "executed_stale" || criterion.proof_exec === "not_executable"
      ? [{ claim: criterion.claim, proof: criterion.proof, proofExec: criterion.proof_exec }]
      : [],
  );
  return proofs.length > 0 ? { proofs } : undefined;
}

function isProofExecOutcome(value: unknown): value is CriterionVerdict["proof_exec"] {
  return (
    value === "executed_stale" ||
    value === "not_executable" ||
    value === "executed_pass" ||
    value === "executed_fail" ||
    value === "exec_error" ||
    value === "base_unreadable" ||
    value === "not_yet_built" ||
    value === "stale_self_path"
  );
}

function criteriaFromLedgerValue(value: unknown): CriterionVerdict[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const criteria: CriterionVerdict[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const criterion = entry as Record<string, unknown>;
    if (
      typeof criterion.claim !== "string" ||
      typeof criterion.proof !== "string" ||
      typeof criterion.met !== "boolean" ||
      typeof criterion.reason !== "string" ||
      !isProofExecOutcome(criterion.proof_exec)
    ) {
      return undefined;
    }
    criteria.push({
      claim: criterion.claim,
      proof: criterion.proof,
      met: criterion.met,
      reason: criterion.reason,
      proof_exec: criterion.proof_exec,
    });
  }
  return criteria;
}

/**
 * Recover proof-discrimination evidence from the exact current `review.posted`
 * row. A later malformed or non-capped row clears prior evidence: a dispatch
 * must never act on a verdict it cannot bind to this PR and head.
 */
export function cappedProofDiscriminationFromLedger(
  pr: Pick<OpenPrView, "taskId" | "prUrl" | "headSha">,
  lines: ReadonlyArray<Record<string, unknown>>,
): ProofDiscriminationEvidence | undefined {
  if (!pr.taskId) return undefined;
  let evidence: ProofDiscriminationEvidence | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== pr.taskId) continue;
    if (line.pr_url !== pr.prUrl || line.head_sha !== pr.headSha) continue;
    evidence = undefined;
    if (line.state !== "success" || line.capped !== true || line.plan_only === true) continue;
    const verdict = line.decision_verdict;
    if (!verdict || typeof verdict !== "object") continue;
    const structured = verdict as Record<string, unknown>;
    if (structured.state !== "success" || structured.capped !== true || structured.planOnly === true) continue;
    const criteria = criteriaFromLedgerValue(structured.criteria);
    if (!criteria || criteria.some((criterion) => !criterion.met)) continue;
    evidence = proofDiscriminationEvidenceFromCriteria(criteria);
  }
  return evidence;
}

/** TERMINAL-STATE PREDICATE (W1-T177) — the ONE definition every spending site and the operator
 *  verb share, so a merged or closed PR is refused IDENTICALLY everywhere rather than through
 *  hardcoded copies that drift. Only `"OPEN"` carries a live block. Classifies a SUCCESSFULLY-READ
 *  state ONLY: an unreadable state must never be treated as terminal. */
export function terminalStateReason(state: string | undefined): string | undefined {
  if (state === "OPEN") return undefined;
  return `state is ${state ?? "UNKNOWN"} (only an OPEN PR carries a live block)`;
}

/** One fresh, live read of a PR's GitHub state (W1-T177). `ok:false` marks a genuinely FAILED or
 *  INDETERMINATE read, which the caller must treat exactly as if no check ran, never as terminal.
 *  `state` is present only when `ok`. */
export interface LiveStateResult {
  ok: boolean;
  state?: string;
  /** Current PR head from the same fresh read, when the caller needs input-pinned mutation. */
  headSha?: string;
}

/** The outcome names `armAutoMerge` returns. Mirrored rather than imported to keep lib/sweep.ts
 *  free of a run-task.ts dependency; {@link armOutcomeArmed} is the single place deciding which of
 *  them count as having actually armed. */
export type ArmOutcomeName =
  | "no-task-id"
  | "head-unavailable"
  | "ledger-refused"
  | "armed"
  | "direct-merged"
  | "direct-merge-failed"
  | "direct-merge-updated"
  | "direct-merge-preflight-refused"
  | "direct-merge-update-failed"
  | "arm-error-ignored"
  // W1-T947: refused because the diff is classified IRREVERSIBLE — mirrored here for the same
  // reason every other member is, so {@link armOutcomeArmed} type-checks without the import.
  | "irreversible-refused"
  // W1-T1000002: refused because an operator hold stands over this PR. A deliberate refusal,
  // never armed here or later, until the hold is released and a fresh pass re-derives whole.
  | "hold-refused";

/** W1-T1117: `armFailureAction`'s return, mirrored here for the same reason
 *  {@link ArmOutcomeName} is. `"direct-merge"` is deliberately absent: that class never reaches an
 *  `"arm-error-ignored"` outcome, so it can never be the `failureClass` a caller attaches below. */
export type ArmFailureClass = "transient" | "retryable" | "unknown";

/** W1-T1117: the richer shape `SweepDeps.arm` may return instead of the bare
 *  {@link ArmOutcomeName} — the same widening run-task.ts already established. `failureClass` is
 *  populated ONLY alongside `"arm-error-ignored"`. */
export interface ArmAttemptOutcome {
  outcome: ArmOutcomeName;
  failureClass?: ArmFailureClass;
}

/** TRUE only for outcomes that genuinely armed or merged: `armed`, and `direct-merged`, where GitHub
 *  refused `--auto` on an already-clean PR and the fallback merged it. Every other outcome armed
 *  NOTHING: no-task-id, head-unavailable and ledger-refused returned before any attempt;
 *  direct-merge-failed and arm-error-ignored attempted and did not stick; irreversible-refused is a
 *  deliberate refusal. Whether one is RETRIED is the dedup's question. */
export function armOutcomeArmed(outcome: ArmOutcomeName | void): boolean {
  // An `undefined` return is a fake/effect that predates this signature — treat it as armed,
  // which is exactly what the code assumed before, so no existing lane regresses.
  if (outcome === undefined) return true;
  return outcome === "armed" || outcome === "direct-merged";
}

/** W1-T2231 — the SAME "undefined means the pre-existing assumption" idiom {@link armOutcomeArmed}
 *  establishes for `deps.arm`, applied to `deps.dispatchFix`. A `false` return is the ONLY signal
 *  that stands a dispatch's `spent` field down; `undefined` and `true` both read as spent. */
export function dispatchFixSpent(outcome: boolean | void): boolean {
  if (outcome === undefined) return true;
  return outcome;
}

/** Injected effects — the real command wires arm/close/fix/escalate; tests fake them. */
export interface SweepDeps {
  /** Arm GitHub auto-merge; idempotent at the GitHub level. RETURNS ITS OUTCOME: `armAutoMerge` does
   *  not throw, and most outcomes mean it armed NOTHING. The effect used to discard that value while
   *  the sweep recorded `acted: true` regardless, which hid the refusal and made it PERMANENT,
   *  because that seeds the dedup. `void` reads as "armed". // Why: observed live on PR #960. */
  arm: (
    pr: OpenPrView,
  ) => ArmOutcomeName | ArmAttemptOutcome | void | Promise<ArmOutcomeName | ArmAttemptOutcome | void>;
  /** W1-T1000002 — WITHDRAW AN ARM THIS LANE DID NOT PLACE, called only when an operator hold stands
   *  over a PR already reporting armed. A disarm alone is undone by the next pass, whose dedup reads
   *  GitHub's live armed bit, so this fires EVERY pass the hold stands and the PR reads armed, and
   *  zero times once that bit reads false. SAFE WHEN NOT ARMED, so no extra probe is needed. */
  disarmAutoMerge?: (pr: OpenPrView, hold: AutomergeHold) => void | Promise<void>;
  /** Close a superseded/abandoned PR with a stated reason. */
  close: (pr: OpenPrView, reason: string) => void | Promise<void>;
  /** Invoke the W1-T54 dep-review lane on a Dependabot PR and return its DECISION, so the disposed
   *  line records the outcome and dedup can tell TERMINAL outcomes — never re-run for the same
   *  head — from "hold", which re-runs next sweep because a red check can go green on the SAME sha. */
  depReview?: (pr: OpenPrView) => string | void | Promise<string | void>;
  /** Invoke the review lane on a checks-green PR whose review was never posted. Verdicts are
   *  per-head, so dedup is unconditional per `pr@head` and a fresh push re-routes naturally.
   *  W1-T473: MAY be invoked CONCURRENTLY with other PRs' calls, bounded by `policy.reviewLanes`,
   *  with each review-input key claimed synchronously before scheduling. */
  postReview?: (pr: OpenPrView) => void | Promise<void>;
  /** W1-T2853 — choose this pass's review width from one already-derived queue and ledger snapshot.
   *  Omission preserves the committed `reviewLanes` behaviour for CLI and test callers. */
  selectAdaptiveReviewWidth?: (input: {
    queueDepth: number;
    nowMs: number;
    ledgerLines: ReadonlyArray<Record<string, unknown>>;
    /** W1-T3202 — already-read process count shared with repair admission. */
    activeWorkers?: number;
  }) => number;
  /** W1-T2584 — MAY THE BOUNDED REVIEW POOL ADMIT ANOTHER HEAD from this pass's already-derived
   *  pending set? Consulted synchronously before each worker pulls its next job; omission means
   *  `true`. It never interrupts a running reviewer — only later admissions, whose keys are released
   *  and whose heads re-derive next pass, so a timer expiry never becomes cancellation mid-write. */
  continueReviewAdmissions?: () => boolean;
  /** Dispatch the W1-T76 fix rung carrying the mode-appropriate evidence at once — the FULL unmet
   *  set for a review dispatch, or ci-log evidence for a blocked_ci one. W1-T2231: MAY return
   *  whether this call demonstrably SPENT a strike; `undefined` reads as spent, so this widening
   *  regresses no lane and never touches `acted`. */
  dispatchFix: (
    pr: OpenPrView,
    evidence: FixDispatchEvidence,
  ) => boolean | void | Promise<boolean | void>;
  /** W1-T2931 — claim one slot from the light pass's shared host budget immediately before a
   *  fix worker is dispatched. The claim is synchronous, so concurrent per-PR reconciliation
   *  cannot all observe the same free slot. Omitted by every non-light caller, preserving the
   *  full sweep and CLI paths byte-for-byte. A refusal spends no strike and re-derives next pass. */
  claimFixAdmission?: (pr: OpenPrView) =>
    | { admitted: true }
    | { admitted: false; reason: string };
  /** W1-T3202 — identifies the one shared host-budget controller that admitted this pass's
   *  detached repairs. Full sweeps build it inside {@link runSweep}; light sweeps share one across
   *  their per-PR calls. Omission preserves every direct/test caller's previous behavior. */
  repairAdmissionSurface?: SweepRepairSurface;
  /** Read-only live view of the controller above, used only for bounded overlap telemetry. */
  repairAdmissionTelemetry?: () => SweepFixCapacitySnapshot;
  /** W1-T3202 — injectable seam for the process-wide count. Production omits it and reads
   *  {@link activeWorkerCount}; a pass invokes either form exactly once. */
  readActiveWorkerCount?: () => number;
  /** W1-T2998 — repair a red RECORDABLE ratchet by re-running its generator and pushing the result,
   *  instead of spending an LLM fix round on a number the failing script already printed. Consulted
   *  ONLY when {@link SweepPolicy.recordableRatchetRepairEnabled} is true AND
   *  {@link recordableRatchetRepairFor} admitted every red check. Returns whether it actually
   *  repaired: ANY falsy answer falls through to {@link dispatchFix}, so a refusal inside the
   *  executor costs the PR nothing but a pass. Absent by construction in every caller that has not
   *  opted in, which is why the disabled path is the shipped one. */
  repairRecordableRatchet?: (
    pr: OpenPrView,
    scripts: readonly string[],
  ) => boolean | void | Promise<boolean | void>;
  /** W1-T3283 — body-only missing-trailer repair. The write itself is the `pull_request.edited`
   *  refire; this seam must never re-run a failed Actions job with its stale pre-edit payload. */
  repairMissingTaskTrailer?: (
    pr: OpenPrView,
    repair: MissingTaskTrailerRepair,
  ) => boolean | void | Promise<boolean | void>;
  /** Escalate a BLOCKED-AMBIGUOUS PR. `question` is the rung's rendered
   *  {@link ClarificationQuestion}: the real wiring logs it to the §2 backlog AND uses `escalate()`
   *  as the notification transport, carrying the same two resolutions as its options. */
  escalate: (pr: OpenPrView, reason: string, question: ClarificationQuestion) => void | Promise<void>;
  /** W1-T1223 — re-queue ONE cancelled required check's JOB
   *  (`POST .../actions/jobs/{job_id}/rerun`), NEVER the workflow run: a whole-run re-run would
   *  re-spend an already-green sibling sharing that run. AT MOST ONCE per `${headSha}@${checkName}`.
   *  // Why: learnings/ci.yaml#rerun-the-job-not-the-run pins this endpoint literal. */
  requeueCheck?: (
    pr: OpenPrView,
    check: CancelledRequiredCheck | CiFailure,
  ) => boolean | void | Promise<boolean | void>;
  /** W1-T1223 — a SECOND cancellation of the SAME check on the SAME head, after this lane already
   *  spent its one re-queue. Distinct from `escalate`, which asks an operator to pick between two
   *  candidate diffs: here there is no diff to choose, only a CI-side fault re-queueing cannot
   *  reach. */
  escalateCancelledCheck?: (pr: OpenPrView, check: CancelledRequiredCheck, reason: string) => void | Promise<void>;
  /** W1-T3194 — a positively identified infrastructure failure could not safely receive its one
   * bounded job retry, or recurred after that retry. It never becomes a source-code worker strike. */
  escalateInfrastructureCheck?: (
    pr: OpenPrView,
    check: CiFailure,
    reason: string,
    signature: CiInfrastructureFailureSignature,
  ) => void | Promise<void>;
  /** W1-T1275 — an OPTIONAL fresh read of ONE PR's live rollup, consulted immediately before a
   *  blocked-fixable disposition acts, never the snapshot this pass started from:
   *  {@link staleCiGateTransition} must compare against a sibling's CURRENT latest attempt. NOT a
   *  field on `OpenPrView`, whose producer literal would be wrong for a freshly-read value. */
  readCiGateRollup?: (pr: OpenPrView) => (RollupCheckEntry[] | undefined) | Promise<RollupCheckEntry[] | undefined>;
  /** W1-T1275 — re-drive `ci-gate`'s OWN job through the same per-job Actions route
   *  {@link requeueCheck} uses, when {@link staleCiGateTransition} names a sibling that reached a
   *  terminal success LATER than the gate's own verdict. AT MOST ONCE per (head, transition). */
  reaggregateCiGate?: (pr: OpenPrView, transition: StaleCiGateTransition) => void | Promise<void>;
  /** W1-T177 — an OPTIONAL fresh re-read of ONE PR's live state, consulted immediately before a
   *  blocked-fixable disposition SPENDS a strike, never the snapshot this pass started from (#388:
   *  merged mid-sweep, dispatched anyway). Omitted, or a failed read, behaves exactly as before —
   *  standing down fires ONLY on a positive, freshly observed terminal reading. */
  readLiveState?: (pr: OpenPrView) => LiveStateResult | Promise<LiveStateResult>;
  /** W1-T2752 — a SYNCHRONOUS, READ-ONLY admission read consulted immediately before
   *  `blocked-fixable` and `conflicted` invoke {@link dispatchFix}, never a replacement for either
   *  surface's own live-state/claim checks. `buildSweepEffects` supplies it from the SAME
   *  `terminalUncreditableHeads` cache W1-T2723's `dispatchFix` already consults internally — no
   *  second cache, no GitHub read here. Returns a stable, explicit stand-down reason ONLY when the
   *  exact `PR@head SHA` entry is present AND its escalation was already delivered; returns
   *  `undefined` for every other case, including a cached entry whose delivery failed (design (iv)
   *  — that one must still reach `dispatchFix` so the existing retry-on-failed-delivery path runs).
   *  A caller that omits this dep (every existing test/fixture) sees dispatch behave byte-for-byte
   *  as before. */
  terminalFixStandDown?: (pr: OpenPrView) => string | undefined;
  /** W1-T2789 — fresh reversed-compare evidence for a checks-red PR that the strike table would
   *  otherwise make terminal. Optional or unreadable preserves the ordinary disposition. The
   *  decision itself is {@link decideRedBaseRefresh}, shared verbatim with the fix rung. */
  readRedBaseRefreshFacts?: (pr: OpenPrView) => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>;
  /** W1-T3422 — one bounded live run listing, called only by {@link selectStaleRedRelease} after
   * timestamp, required-check, route, and ledger filters admitted a candidate. `undefined` is an
   * unreadable response and declines the redrive. */
  readStaleRedWorkflowRuns?: (
    pr: OpenPrView,
  ) => readonly WorkflowRunObservation[] | undefined | Promise<readonly WorkflowRunObservation[] | undefined>;
  /** W1-T3422 — materialise the observed head and main in an isolated merge, then run the
   * declared route. A non-pass result is ledgered as a stand-down and never reaches the push. */
  runStaleRedLocalRoute?: (target: StaleRedReleaseTarget) => IsolatedMergeRouteResult | Promise<IsolatedMergeRouteResult>;
  /** W1-T3422 — the existing lease-protected new-head leaf, called at most once after the local
   * route passed. Its return is the new observed head for the durable release receipt. */
  releaseStaleRed?: (target: StaleRedReleaseTarget) => string | undefined | Promise<string | undefined>;
  /** W1-T254 — when supplied, gates which disposition may actually act THIS pass; one that fails
   *  the predicate stands down, still ledgered, never silently skipped. The light-sweep ticker
   *  admits only `post-review`, the deterministic sha-pinned re-post safe alongside a running task. */
  actionable?: (d: Disposition) => boolean;
  /** W1-T2426 — WHY {@link SweepDeps.actionable} REFUSED, when the caller can say. That predicate is
   *  bare, so every disposition it gates recorded one generic sentence — not legible for a
   *  `post-review` that was eligible and merely lost this pass's admission. Consulted ONLY after a
   *  refusal, so it can never admit anything. // Why: 289 such rows across 18 PRs. */
  standDownReasonFor?: (d: Disposition) => string | undefined;

  /** W1-T2379/W1-T3202 — DO NOT AWAIT THE FIX RUNG'S CI WAIT. Set by the light pass and by the
   *  production full-sweep wrapper. The
   *  dispatch is still CALLED and still writes its `acted: true` row before returning, so the dedup
   *  seed is untouched — only the `await` moves into {@link drainDetachedSweepActions}. NOT AN
   *  ADMISSION CHANGE. */
  detachFixWait?: boolean;
  /** THE ABSENT-CHECK-SUITE REMEDY (W1-T186 follow-up). Pushes an EMPTY commit to the PR's own
   *  branch, minting a fresh head sha, and returns it. Omitted, the lane stands down and the
   *  ordinary escalation runs — the stand-down is named on the disposed line, never silent. */
  repushAbsent?: (pr: OpenPrView) => Promise<string | undefined>;
  /** W1-T528 — press the update-branch button. Invoked AT MOST ONCE per pass, on the single PR
   *  {@link selectUpdateBranchTarget} chose: never a loop, never a second attempt this pass. A
   *  `"conflict"` outcome is REPORTED and never retried by this call. */
  updateBranch?: (pr: ArmedStalledPr) => UpdateBranchOutcome | Promise<UpdateBranchOutcome>;
  /** W1-T2999 — before escalating a dirty PR on a fleet-owned `run-<id>-<epoch>` head, try the
   *  one safe mechanical repair: rebase that head onto current main and push it back with an
   *  explicit lease pinned to the observed head sha. A `"rebased"` result stands down the
   *  escalation for this pass so GitHub reruns checks on the new head. Every other outcome falls
   *  through to the existing escalation, preserving human visibility and never clobbering a
   *  branch another writer advanced. */
  rebaseDirtyFleetBranch?: (pr: OpenPrView) => DirtyFleetRebaseOutcome | Promise<DirtyFleetRebaseOutcome>;
  /** W1-T528: task ids with a LIVE in-flight run right now, consulted by
   *  {@link selectUpdateBranchTarget} to skip a head a live worker is still pushing to. Omitted
   *  means an empty set, exactly as if every PR's worker had already finished. */
  inFlightTaskIds?: ReadonlySet<string>;
  /** W1-T1212 — per red PR, the failing check names whose defining workflow blob differs between
   *  this PR's OWN merge ref and main RIGHT NOW: the ONLY population {@link redPrWithStaleGate}
   *  draws from. Cheap and exact, never re-derived from `checksState` alone, which is what let a red
   *  PR spin forever behind a gate that had already moved. */
  staleGateWorkflowsByPr?: ReadonlyMap<number, readonly string[]>;
  /** W1-T1212 — every `${prNumber}:${workflowName}` pair this lane has ALREADY requested an update
   *  for. An update mints a new head and a second request for the same pair is a no-op that still
   *  spends one, so a fired pair must be remembered and skipped. Read from prior ledger rows. */
  updatedForWorkflow?: ReadonlySet<string>;
  /** W1-T3277 — per open PR, how many commits `main` is ahead of the PR head. This is injected
   *  data for the ordinary stale-PR refresh rung; omission keeps the rung quiet, so callers that
   *  cannot read the comparison never invent a refresh. */
  behindMainByPr?: ReadonlyMap<number, number>;
  /** W1-T2620 — an OPTIONAL, per-PASS read of `origin/main`'s CURRENT tip, consulted ONCE before the
   *  per-PR walk; this module never calls gh or git, so the read is the caller's. Feeds
   *  {@link selectBaseCausedRelease}'s "main has moved" condition — never the `behind` GitHub
   *  reports, since a base-caused PR is red by construction. Omitted, the lane never fires. */
  readMainTip?: () => string | undefined | Promise<string | undefined>;
  /** W1-T3422 — SHA plus the main commit's actual time from one REST response. Missing or
   * malformed evidence leaves the exact stale-red lane silent while W1-T2620 may still use SHA. */
  readMainRepair?: () => MainRepairEvidence | undefined | Promise<MainRepairEvidence | undefined>;
  /** W1-T2620 — RELEASE the one base-caused stand-down chosen this pass: never a loop, the same
   *  AT-MOST-ONCE shape the update-branch dep uses. THE LEAF IS THE ONE THAT EXISTS, never a second
   *  outward path. Omitted, the target still stands down with the ordinary sentence; a THROW is
   *  caught identically, FAIL QUIET, never a false "released" ledger line. */
  releaseBaseCausedStandDown?: (pr: OpenPrView, mainTipSha: string) => void | Promise<void>;
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
  /** Preview only: derive dispositions, take NO effects, write NO ledger lines. Returns the same
   *  summary shape so `rmd sweep --dry-run` can print the plan. */
  dryRun?: boolean;
  /** W1-T905 — best-effort capture of a §7B entry for ONE surface found due this pass. NEVER ALLOWED
   *  TO FAIL THE PASS that produced the repairs it reports on: every call is wrapped in the SAME
   *  throw containment the action switch has. This pure module never touches the filesystem, and the
   *  injected dep's own idempotent write is the entire "no second store" guarantee. */
  captureRepairFeedback?: (filing: RepairFilingCapture) => void | Promise<void>;
  /** W1-T931 COST-ANOMALY SENTINEL — the `plan/policy.yaml` policy this pass consults; see
   *  `cost-anomaly.ts`'s header for the rationale. Omitted, `runSweep` resolves the default,
   *  memoized for the process lifetime. */
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
  /** W1-T254: set when this PR's gated action THREW. `acted` is false, but this is distinct from
   *  dedup, dry-run and stand-down: the action was attempted and failed, and is named here rather
   *  than propagating out of `runSweep` and aborting the rest of the pass. */
  actionError?: string;
  /** W1-T2231 — set ONLY for the two dispatch-based repair surfaces whose dispatch returned a
   *  concrete verdict; `undefined` everywhere else, and deliberately NEVER read as "no repair" —
   *  only an EXPLICIT `false` is. THIS IS NEVER `acted`, AND NEVER CHANGES IT. */
  spent?: boolean;
}

/** The whole sweep's outcome — counts per disposition + the per-PR actions. */
export interface SweepSummary {
  total: number;
  /** How many PRs landed in each disposition — every PR is counted exactly once. */
  byDisposition: Record<Disposition, number>;
  /** How many gated effects actually fired (deduped ones are excluded). */
  actionsTaken: number;
  /** W1-T99: how many gated effects were ATTEMPTED and THREW — distinct from `actionsTaken` and
   *  from PRs that never attempted. Each also has its own `sweep.action_failed` ledger line; this
   *  is the pass-level count a caller reads without re-deriving it from `actions`. */
  actionsFailed: number;
  /** Per-PR detail — INVARIANT: returned in `openPrs` input order, whichever phase finalized each. */
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
  /** `pr@head` keys, exactly like the sibling sets (W1-T514). PR-number-only until then, which let
   *  one `acted:true` line at head A dedup the SAME PR forever, including a genuinely NEW block at
   *  head B. A new head re-earns the attempt; the SAME head still dedupes, so no per-push storm. */
  escalated: Set<string>;
  /** `pr@head` keys whose dep-review reached a TERMINAL outcome (arm/escalate/refuse). */
  depReviewed: Set<string>;
  /** Exact-input keys with a DELIVERED verdict. NOT keyed off `sweep.disposed acted:true` like the
   *  other sets: that proves only the LANE WAS INVOKED, and keying on the attempt suppressed the
   *  same input forever after one no-op invocation. W1-T1213 split off {@link reviewRefused}. */
  reviewDelivered: Set<string>;
  /** Exact-input keys with an explicit refusal that still suppresses this input — every refusal
   *  EXCEPT the class {@link isReopenedClosedLifecycleRefusal} names as provably stale. A refusal
   *  leaves GitHub's status untouched, so without a key the lane would re-invoke the same input every
   *  pass. W1-T1213: the "already closed" refusal is never admitted, being FALSIFIED BY CONSTRUCTION. */
  reviewRefused: Set<string>;
  /** Exact-input keys whose sweep-owned review attempt THREW before it delivered a verdict. The
   *  value is the latest parseable ledger timestamp in milliseconds, or `undefined` when every
   *  matching row is undated. Unlike {@link reviewRefused}, this is a bounded retry clock, not a
   *  semantic or lifecycle decision about the PR (W1-T2753). */
  reviewRetryableThrows: Map<string, number | undefined>;
  /** Exact-input keys where the thrown post-review attempt hit GitHub's permanent PR diff ceiling.
   *  The remedy is a new head with a smaller diff, so this is a terminal marker for the current
   *  key, not another entry in the timed retry bucket. */
  reviewDiffCeilingRefused: Set<string>;
  /** Exact-input retryable throw counts. The first throw may be a hiccup; repeated throws are
   *  bounded by the existing strike cap so an unknown failure class cannot loop forever. */
  reviewRetryableThrowCounts: Map<string, number>;
  /** W1-T970 — keys built off the risk judge's OWN step, never from `sweep.disposed`.
   *  PR-NUMBER-KEYED, deliberately unlike the review sets: the producer emits the number, so there is
   *  no `??` fallback and #1931's matching-nothing collapse has no equivalent. A refusal expires on a
   *  NEW head sha or an explicit override, never by time; a MAP since W1-T1116, so it names its issue. */
  riskRefused: Map<string, string | undefined>;
  /** ABSENT-check-suite re-push history, read from this module's OWN `sweep.absent_repush` step.
   *  TWO keys because one is not enough: `shas` gives same-head idempotence, and `count` per PR is
   *  the BOUND — a re-push mints a NEW sha, so a sha key alone would license an unbounded chain of
   *  empty commits. */
  absentRepushes: Map<number, { count: number; shas: Set<string> }>;
  /** `${prNumber}@${headSha}@${taskId}` body edits already made for the missing-trailer repair. */
  missingTaskTrailerRepairs: Set<string>;
}

/** One review outcome key. Attributed rows use the material input; legacy rows and unwired
 *  fixtures retain the historical task+head key, so migration changes no local semantics. A real
 *  current view always carries `reviewInputDigest`, so a legacy row cannot pin a changed body. */
function reviewOutcomeKey(
  taskId: string,
  prUrl: string | undefined,
  headSha: string,
  inputDigest: string | undefined,
): string {
  return prUrl !== undefined && inputDigest !== undefined
    ? `input:${JSON.stringify([taskId, prUrl, headSha, inputDigest])}`
    : `${taskId}@${headSha}`;
}

function reviewOutcomeKeyForPr(pr: OpenPrView): string {
  const taskId = pr.reviewInputDigest !== undefined ? (pr.taskId ?? `PR-${pr.prNumber}`) : (pr.taskId ?? "");
  return reviewOutcomeKey(taskId, pr.prUrl, pr.headSha, pr.reviewInputDigest);
}

/** W1-T529 — WHAT EACH LANE'S STAND-DOWN COSTS, named so the cost is chosen rather than discovered,
 *  and carried verbatim into the PR's own reason. THIS TABLE NAMES A COST; IT DECIDES NOTHING — by
 *  the time it is read the guarded call has ALREADY been refused. */
const BUDGET_FLOOR_LANE_COST: Partial<Record<Disposition, string>> = {
  // Design (iv), verbatim: "A SKIPPED REVIEW leaves a GREEN PR UNMERGED — visible, recoverable
  // next pass." RECOVERABLE is load-bearing — see the refusal key this deliberately does NOT write.
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
  "refused-escalate": "a worker-refusal escalation is deferred; no fix strike is spent",
  // The hold/terminal outcome is re-read from live state next pass, so nothing is carried.
  "dep-review": "a dependency review is deferred one pass and re-read from live state",
  // Closing a stale PR is the least urgent action the sweep takes.
  stale: "a stale-PR close is deferred one pass",
};

/** W1-T529 — IS THIS THROW THE BUDGET FLOOR, AND WHAT DOES DECLINING THIS LANE COST? Returns the
 *  stand-down reason when it is, `undefined` for every other throw. WHY THE TWO CLASSES MUST NOT
 *  SHARE A PATH: routing it through `actionError` would write a `review.post_refused` row, and that
 *  row is a VERDICT, so a PR unaffordable for one tick would be deduped permanently then escalated. */
function budgetFloorStandDown(e: unknown, disposition: Disposition): string | undefined {
  if (!(e instanceof GhPaceFloorStandDownError)) return undefined;
  const cost = BUDGET_FLOOR_LANE_COST[disposition] ?? "this lane's action is skipped and re-derives next tick";
  return `gh budget at or below the stand-down floor (${e.resource} at ${e.remaining}/${e.limit}) — ${cost}`;
}

/** W1-T1213 — is `reason` the SPECIFIC "PR is already closed" half of `decideReviewStatusPost`'s
 *  lifecycle refusal? Matched on that function's own literal, verbatim. DELIBERATELY NOT the
 *  "already merged" sibling: a merged PR has no transition back to `state=open`, so that refusal
 *  has no falsifier and must keep suppressing forever. */
function isReopenedClosedLifecycleRefusal(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith("PR is already closed — refusing to post remudero-review");
}

const RETRYABLE_REVIEW_THROW_PREFIX = "post-review attempt threw — standing down rather than retrying this head unbounded:";

function isRetryableReviewThrow(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith(RETRYABLE_REVIEW_THROW_PREFIX);
}

export function isPostReviewDiffCeilingRefusal(reason: unknown): boolean {
  if (!isRetryableReviewThrow(reason)) return false;
  const raw = String(reason);
  const text = raw.toLowerCase();
  return (
    /pullrequest\.diff\s+too_large/i.test(raw) ||
    (text.includes("http 406") &&
      text.includes("diff exceeded") &&
      text.includes("maximum number of files") &&
      text.includes("300"))
  );
}

function postReviewFailureHistoryDisposition(
  pr: OpenPrView,
  prior: Pick<PriorActions, "reviewDiffCeilingRefused" | "reviewRetryableThrowCounts">,
  policy: SweepPolicy,
  now: number,
): DispositionResult | undefined {
  const eligible =
    pr.checksState === "green" &&
    pr.requiredContextsUnreadable !== true &&
    (pr.reviewState === "none" ||
      (pr.reviewState === "pending" &&
        (pr.reviewPendingOwnerDead === true || reviewPendingIsStale(pr, policy, now))));
  if (!eligible) return undefined;

  const reviewKey = reviewOutcomeKeyForPr(pr);
  if (prior.reviewDiffCeilingRefused.has(reviewKey)) {
    return {
      disposition: "blocked-ambiguous",
      reason:
        `post-review cannot read GitHub's PR diff for ${reviewKey}: the diff exceeds GitHub's ` +
        `300-file ceiling — split the PR under 300 files or push a smaller head before retrying`,
    };
  }

  const thrownAttempts = prior.reviewRetryableThrowCounts.get(reviewKey) ?? 0;
  if (thrownAttempts > policy.strikeCap) {
    return {
      disposition: "blocked-ambiguous",
      reason:
        `post-review attempts for ${reviewKey} have thrown ${thrownAttempts} time(s), exceeding ` +
        `the ${policy.strikeCap}-strike retry cap for this unchanged review input — escalating`,
    };
  }

  return undefined;
}

function retryableReviewThrowBackoffReason(
  retryableThrows: ReadonlyMap<string, number | undefined>,
  reviewKey: string,
  policy: SweepPolicy,
  now: number,
): string | undefined {
  if (!retryableThrows.has(reviewKey)) return undefined;
  const attemptedAt = retryableThrows.get(reviewKey);
  // An undated throw cannot prove that the bound is still live. Admit once; if the condition
  // persists, the existing catch writes a fresh dated row and restores the bounded stand-down.
  if (attemptedAt === undefined) return undefined;
  const ageMinutes = Math.max(0, (now - attemptedAt) / 60_000);
  if (ageMinutes >= policy.pendingCeilingMinutes) return undefined;
  return (
    `the last post-review attempt for ${reviewKey} threw ${Math.floor(ageMinutes)}m ago — ` +
    `retry backoff remains inside the ${policy.pendingCeilingMinutes}m pending ceiling; ` +
    `this is a retryable transport/process outcome, not a durable review refusal`
  );
}

function priorActionsFromLedger(lines: Array<Record<string, unknown>>): PriorActions {
  const armed = new Set<string>();
  const fixed = new Set<string>();
  const closed = new Set<number>();
  const escalated = new Set<string>();
  const depReviewed = new Set<string>();
  const reviewDelivered = new Set<string>();
  const reviewRefused = new Set<string>();
  const reviewRetryableThrows = new Map<string, number | undefined>();
  const reviewDiffCeilingRefused = new Set<string>();
  const reviewRetryableThrowCounts = new Map<string, number>();
  const riskRefused = new Map<string, string | undefined>();
  const absentRepushes = new Map<number, { count: number; shas: Set<string> }>();
  const missingTaskTrailerRepairs = new Set<string>();
  for (const line of lines) {
    // W1-T254/W1-T1213: OUTCOME-KEYED, off the review lane's OWN ledger lines — never
    // `sweep.disposed`. See PriorActions.reviewDelivered/reviewRefused's docs.
    if (line.step === "review.posted" || line.step === "review.post_refused") {
      if (typeof line.task_id === "string" && typeof line.head_sha === "string") {
        const key = reviewOutcomeKey(
          line.task_id,
          typeof line.pr_url === "string" ? line.pr_url : undefined,
          line.head_sha,
          typeof line.review_input_digest === "string" ? line.review_input_digest : undefined,
        );
        if (line.step === "review.posted") {
          reviewDelivered.add(key);
        } else if (isPostReviewDiffCeilingRefusal(line.reason)) {
          reviewDiffCeilingRefused.add(key);
          reviewRefused.add(key);
        } else if (isRetryableReviewThrow(line.reason)) {
          const parsed = typeof line.ts === "string" ? Date.parse(line.ts) : Number.NaN;
          const existing = reviewRetryableThrows.get(key);
          reviewRetryableThrowCounts.set(key, (reviewRetryableThrowCounts.get(key) ?? 0) + 1);
          if (!reviewRetryableThrows.has(key)) reviewRetryableThrows.set(key, undefined);
          if (!Number.isNaN(parsed) && (existing === undefined || parsed > existing)) {
            reviewRetryableThrows.set(key, parsed);
          }
        } else if (!isReopenedClosedLifecycleRefusal(line.reason)) {
          // W1-T1213: the "PR is already closed" refusal is excluded here, never added to
          // `reviewRefused` — see that field's own doc for why reaching this fold at all
          // already proves the refusal's named condition (the PR being closed) has ended.
          reviewRefused.add(key);
        }
      }
      continue;
    }
    // W1-T970: OUTCOME-KEYED off the risk judge's OWN step, never `sweep.disposed`. PR-number
    // keyed, and both fields are REQUIRED with no `??` fallback, so a pre-W1-T970 row written
    // before the producer emitted them is never matched.
    if (line.step === "risk_judge.escalated") {
      if (typeof line.pr_number === "number" && typeof line.head_sha === "string") {
        // W1-T1116: carry `issue_url` with the key. `undefined` rather than a `??` fallback when
        // an older row predates the field, so the `mergeable` arm can tell "no issue to name" from
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
    if (line.step === MISSING_TASK_TRAILER_REPAIR_STEP) {
      if (
        typeof line.pr_number === "number" &&
        typeof line.head_sha === "string" &&
        typeof line.task_id === "string"
      ) {
        missingTaskTrailerRepairs.add(`${line.pr_number}@${line.head_sha}@${line.task_id}`);
      }
      continue;
    }
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const pr = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (pr === undefined) continue;
    switch (line.disposition) {
      case "mergeable":
        // SHA-KEYED, exactly like `fixed` below. Keyed by PR number alone this set had no expiry:
        // one `acted:true` line — including one recorded for an arm that never happened — deduped
        // that PR forever. A new head must re-earn the attempt.
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
      case "refused-escalate":
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
  return {
    armed,
    fixed,
    closed,
    escalated,
    depReviewed,
    reviewDelivered,
    reviewRefused,
    reviewRetryableThrows,
    reviewDiffCeilingRefused,
    reviewRetryableThrowCounts,
    riskRefused,
    absentRepushes,
    missingTaskTrailerRepairs,
  };
}

/** W1-T1110 — HAS THE MOST RECENT `fix.dispatch` FOR THIS TASK ALREADY CONCLUDED WITHOUT LANDING A
 *  NEW HEAD? `prior.fixed` records only that a fix was DISPATCHED, never an outcome, and clears only
 *  on a new head — so a dispatch that ran and ENDED without pushing leaves the key set and every
 *  later pass stands down FOREVER. `fix.resolved` is never counted as stalled. TASK-ID KEYED, safe
 *  because every caller guards on the PR's CURRENT head. W1-T1210 — A TASKID WITH NO `fix.dispatch`
 *  ROW IS THE SAME SHAPE ONE STEP EARLIER, and the ABSENCE of the row is the falsifier. */
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

// ── W1-T905 — "repair the instance, FILE THE CLASS" ──────────────────────────────────────────
//
// A `sweep.disposed` row already NAMES a classified surface every time the sweep repairs a PR, but
// nothing rolls that up across PRs, so a defect repaired fifteen times is rediscovered by hand
// fifteen times. THIS IS NOT A ROUTER, A LANE OR A RUNG: the ONE addition is the bridge from a
// recurring surface to a §7B entry, a pure fold over rows that already exist.

/** The dispositions {@link priorActionsFromLedger}'s switch treats as an actual REPAIR verb having
 *  fired. `mergeable` is the HEALTHY outcome, not a defect. Scoped to exactly these four so a PR
 *  arming fifteen times — ordinary throughput — never floods the §7B inbox. */
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
  /** Deterministic — `fb-repair-<surface>-<window-bucket>`. STABLE for the same surface across
   *  every pass inside the SAME window, so the caller-side dedup never re-files twice for one
   *  window, and a genuinely new window can file again once the pattern persists into it. */
  id: string;
}

/** PURE fold over already-written `sweep.disposed` rows. Counts the DISTINCT PRs repaired for each
 *  surface inside the current epoch-anchored window, so fifteen PRs repaired for one surface produce
 *  ONE entry and one PR stuck across many passes cannot inflate the count. W1-T2231: `acted: true`
 *  proves only that the LANE WAS INVOKED, so a row whose `spent` reads EXPLICITLY `false` is excluded. */
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
    // W1-T2231: `acted: true` only proves the lane fired. A dispatch-based surface marks a
    // demonstrably-empty invocation `spent: false`, and THAT is what a repair count must exclude.
    // `undefined` is deliberately NOT treated as `false`.
    if (line.spent === false) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs) || tsMs < windowStart || tsMs >= windowEnd) continue;
    const prNumber = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (prNumber === undefined) continue;
    const perPr = bySurface.get(surface) ?? new Map<number, RepairFilingInstance>();
    // Last-write-wins per PR — a PR re-dispatched several times this window is counted ONCE,
    // carrying its most recent SPENDING repair's evidence; a later `spent: false` row is excluded
    // above and can never overwrite it.
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

/** Render ONE due surface's evidence body: the classified surface, the window and threshold that
 *  triggered filing, and per repaired PR the number, url, head sha and the disposition `reason`
 *  already ledgered. NEVER invents a cause — root cause is stated as unobserved, since this fold
 *  only ever reports RECURRENCE. */
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
  "refused-escalate": 0,
  "dep-review": 0,
  "post-review": 0,
  stale: 0,
  "blocked-ambiguous": 0,
  conflicted: 0,
  wait: 0,
});

/** W1-T513 — THE CROSS-CALL REVIEW-KEY MUTEX. The claim set used to be declared FRESH INSIDE every
 *  `runSweep` call, so it arbitrated only between PRs in that ONE call. MODULE-SCOPED so every
 *  caller in the process shares it without new wiring. NOT PROCESS-GLOBAL-FOREVER: a key is added
 *  when a worker is ready to START, and removed the instant the attempt settles. */
const inFlightReviewKeys = new Set<string>();

/** W1-T2520 — THE FIX-DISPATCH MUTEX, {@link inFlightReviewKeys}'s SIBLING for the other lane.
 *  `priorStrikes` is derived by COUNTING dispatch rows at view-build time, with no exclusion between
 *  that count and the dispatch it gates, so A CLAIM ALONE IS NOT ENOUGH and
 *  {@link claimFixDispatch} RE-READS the ledger the instant the claim is taken. A SEPARATE Set from
 *  the review mutex. // Why: 13 dispatches across two PRs against a cap of 2. */
const inFlightFixKeys = new Set<string>();

/** W1-T2788 — select the fix-rung ledger generation attributable to `currentHeadSha`. New rows name
 *  the head they targeted and require exact equality; legacy rows carry no head and reset only at a
 *  trustworthy observation for this task at the current head, so an incomplete history fails closed
 *  rather than manufacturing strike budget. `fix.review` also carries no head. */
export function fixLedgerRowsForHead(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentHeadSha?: string,
): Array<Record<string, unknown>> {
  if (!taskId) return [];
  if (!currentHeadSha) {
    return lines.filter(
      (line) => line.task_id === taskId && (line.step === "fix.dispatch" || line.step === "fix.review"),
    );
  }

  let legacyBoundary = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.task_id === taskId && line.step === "sweep.disposed" && line.head_sha === currentHeadSha) {
      legacyBoundary = i;
    }
  }

  const selected: Array<Record<string, unknown>> = [];
  const selectedStrikes = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.task_id !== taskId) continue;
    const strike = typeof line.strike === "number" ? line.strike : undefined;
    if (line.step === "fix.dispatch") {
      const taggedHead = typeof line.head_sha === "string" ? line.head_sha : undefined;
      const belongsToHead = taggedHead !== undefined
        ? taggedHead === currentHeadSha
        : legacyBoundary < 0 || i > legacyBoundary;
      if (strike !== undefined) {
        if (belongsToHead) selectedStrikes.add(strike);
        else selectedStrikes.delete(strike);
      }
      if (belongsToHead) selected.push(line);
      continue;
    }
    if (line.step === "fix.review" && strike !== undefined && selectedStrikes.has(strike)) {
      const taggedHead = typeof line.head_sha === "string" ? line.head_sha : undefined;
      if (taggedHead === undefined || taggedHead === currentHeadSha) selected.push(line);
    }
  }
  return selected;
}

/** W1-T2520 — the fresh under-claim counterpart to `priorStrikesFor`. What it adds is FRESHNESS: it
 *  reads the ledger AFTER taking the claim, so two callers cannot act on the same stale count.
 *  COUNTS DISTINCT `strike` NUMBERS, NOT RAW ROWS — two GENUINE strikes can never share a number,
 *  so a duplicate value is always the SAME attempt re-described. */
function freshFixDispatchCount(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentHeadSha: string,
): number {
  if (!taskId) return 0;
  const strikeNumbers = new Set<number>();
  let unnumbered = 0;
  for (const line of fixLedgerRowsForHead(lines, taskId, currentHeadSha)) {
    if (line.step !== "fix.dispatch") continue;
    if (typeof line.strike === "number") {
      strikeNumbers.add(line.strike);
    } else {
      unnumbered++;
    }
  }
  return strikeNumbers.size + unnumbered;
}

/** W1-T2379 — THE DETACHED-WAIT REGISTRY, module-scoped for the reason {@link inFlightReviewKeys}
 *  is: the ticker awaits the light pass, which awaits every open PR, and `dispatchFix` waits on CI.
 *  NOT FIRE-AND-FORGET, WHICH IS THE WHOLE DIFFICULTY: the dispatch is STARTED and its `acted: true`
 *  row WRITTEN synchronously inside the pass, because that row seeds the dedup. A DETACHED REJECTION
 *  IS SWALLOWED ON PURPOSE. */
/** W1-T2981 widened this from the single `"fix-dispatch"` literal: the registry was always a
 *  DAEMON-LIFETIME seam (the freshness exit drains it), and the retro is the loop's other long await. */
export type DetachedActionKind = "fix-dispatch" | "retro" | "auto-triage";

interface DetachedSweepActionRegistration {
  actionKind: DetachedActionKind; taskId: string; startedAtMs: number;
}

export interface DetachedSweepActionDescriptor {
  actionKind: DetachedActionKind; taskId: string; ageMs: number;
}

const detachedSweepActions = new Map<Promise<void>, DetachedSweepActionRegistration>();

/** W1-T2379: hand a started action to {@link detachedSweepActions} so the caller need not await it.
 *  The stored promise is already settled-safe — its rejection is caught here — so a drain can never
 *  itself reject. */
export function detachSweepAction(
  work: Promise<unknown>,
  action: Omit<DetachedSweepActionRegistration, "startedAtMs">,
): void {
  const held: Promise<void> = work.then(
    () => undefined,
    () => undefined,
  );
  detachedSweepActions.set(held, { ...action, startedAtMs: Date.now() });
  void held.finally(() => detachedSweepActions.delete(held));
}

/** W1-T2379 — LET WORK ALREADY IN FLIGHT FINISH RATHER THAN ABORTING IT. Awaits every detached
 *  action and settles once they all have. W1-T2744: an explicit daemon-lifetime seam, never part of
 *  a phase-local ticker's stop. W1-T2913: a bounded drain reports stragglers. */
export async function drainDetachedSweepActions(
  opts: { boundMs: number } = { boundMs: Number.POSITIVE_INFINITY },
): Promise<DetachedSweepActionDescriptor[]> {
  const detachedDrainBoundMs = Math.max(0, opts.boundMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = Number.isFinite(detachedDrainBoundMs)
    ? new Promise<"bounded">((resolve) => { timer = setTimeout(() => resolve("bounded"), detachedDrainBoundMs); })
    : undefined;
  try {
    while (detachedSweepActions.size > 0) {
      const settled = Promise.all([...detachedSweepActions.keys()]).then(() => "settled" as const);
      if (!bound) {
        await settled;
        continue;
      }
      if (await Promise.race([settled, bound]) === "bounded") {
        const observedAtMs = Date.now();
        return [...detachedSweepActions.values()].map((action) => ({
          actionKind: action.actionKind,
          taskId: action.taskId,
          ageMs: Math.max(0, observedAtMs - action.startedAtMs),
        }));
      }
    }
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** W1-T2379/W1-T2744: how many detached actions are still in flight. The daemon heartbeat reports
 *  this bounded count for observability; no production reader branches on it. */
export function detachedSweepActionCount(): number {
  return detachedSweepActions.size;
}

/** W1-T2981 — is an action of this kind already detached? A second concurrent retro would race the
 *  same marker file, so the rung refuses rather than stacking. A KIND query, not a separate boolean,
 *  so the registry stays the one source of truth about what is in flight. */
export function detachedActionInFlight(kind: DetachedActionKind): boolean {
  for (const action of detachedSweepActions.values()) if (action.actionKind === kind) return true;
  return false;
}

export type SweepRepairSurface = "full" | "light";

export interface SweepFixCapacitySnapshot {
  surface: SweepRepairSurface;
  queueDepth: number;
  hostWorkerBudget: number;
  activeWorkers: number;
  reviewReservations: number;
  fixesAdmitted: number;
  fixesRefused: number;
  fixAdmissionsAvailable: number;
}

/** W1-T3202 — one admission controller shared by both sweep surfaces. The caller supplies the
 *  already-measured worker count and review reservation; this function never re-reads either, so
 *  concurrent repair starts cannot each observe the same free slot. */
export function createSweepFixAdmissionController(input: {
  surface: SweepRepairSurface;
  queueDepth: number;
  hostWorkerBudget: number;
  activeWorkers: number;
  reviewReservations: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}): {
  claim: NonNullable<SweepDeps["claimFixAdmission"]>;
  snapshot: () => SweepFixCapacitySnapshot;
} {
  let available = Math.max(
    0,
    Math.trunc(input.hostWorkerBudget) - Math.max(0, Math.trunc(input.activeWorkers)) -
      Math.max(0, Math.trunc(input.reviewReservations)),
  );
  let fixesAdmitted = 0;
  let fixesRefused = 0;
  const snapshot = (): SweepFixCapacitySnapshot => ({
    surface: input.surface,
    queueDepth: input.queueDepth,
    hostWorkerBudget: input.hostWorkerBudget,
    activeWorkers: input.activeWorkers,
    reviewReservations: input.reviewReservations,
    fixesAdmitted,
    fixesRefused,
    fixAdmissionsAvailable: available,
  });
  const emit = (): void => {
    const state = snapshot();
    input.log?.("sweep.fix_capacity", {
      surface: state.surface,
      queue_depth: state.queueDepth,
      host_worker_budget: state.hostWorkerBudget,
      active_workers: state.activeWorkers,
      review_reservations: state.reviewReservations,
      fixes_admitted: state.fixesAdmitted,
      fixes_refused: state.fixesRefused,
      fix_admissions_available: state.fixAdmissionsAvailable,
    });
  };
  emit();
  return {
    snapshot,
    claim: () => {
      if (available <= 0) {
        fixesRefused++;
        emit();
        return {
          admitted: false,
          reason:
            `host worker budget ${input.hostWorkerBudget} exhausted for this ${input.surface} pass ` +
            `(${input.activeWorkers} active, ${input.reviewReservations} reserved for review, ` +
            `${fixesAdmitted} fixes admitted)` +
            " — repair remains queued and will be re-derived next pass",
        };
      }
      available--;
      fixesAdmitted++;
      emit();
      return { admitted: true };
    },
  };
}

/** Production composition for both full-sweep entry points. Kept pure so wiring cannot drift. */
export function withFullSweepRepairAdmission(deps: SweepDeps): SweepDeps {
  return { ...deps, detachFixWait: true, repairAdmissionSurface: "full" };
}

/**
 * THE SHARED ENTRY POINT: BOTH `rmd sweep` and the daemon poll loop call this ONE function. It
 * re-derives every open PR's disposition fresh, takes the ONE gated action per PR, writes one
 * `sweep.disposed` line per PR, and returns a summary both callers log. W1-T473 — REVIEW
 * CONCURRENCY: every disposition EXCEPT `post-review` runs one PR at a time in `openPrs` order,
 * while `post-review` PRs run in a SECOND, bounded phase, each against a DISTINCT key claimed
 * synchronously during the walk. `summary.actions` still returns in `openPrs` order.
 */
/** W1-T1218 — THE REVIEW LANE'S ORDER, AS A PURE FUNCTION: a NEW array ordered OLDEST-FIRST, so
 *  bounded workers pull the entries that have waited longest. GitHub answers newest-first, so
 *  cutting by position defers the oldest tail indefinitely. THE KEY IS the IMMUTABLE `createdAt`,
 *  with `prNumber` as tiebreak, keeping the comparator TOTAL. */
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

function effectiveReviewWidth(
  deps: SweepDeps,
  policy: SweepPolicy,
  queueDepth: number,
  nowMs: number,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  activeWorkers?: number,
): number {
  const min = Math.max(1, Math.trunc(policy.reviewLaneMin));
  const max = Math.max(min, Math.trunc(policy.reviewLaneMax));
  const base = Math.min(max, Math.max(min, Math.trunc(policy.reviewLanes)));
  if (!deps.selectAdaptiveReviewWidth) return base;
  try {
    const selected = deps.selectAdaptiveReviewWidth({ queueDepth, nowMs, ledgerLines, activeWorkers });
    if (!Number.isFinite(selected)) throw new Error(`non-finite width ${JSON.stringify(selected)}`);
    return Math.min(max, Math.max(min, Math.trunc(selected)));
  } catch (error) {
    (deps.log ?? (() => {}))("review.capacity.selector_failed", {
      queue_depth: queueDepth,
      base_width: base,
      error: String((error as Error)?.message ?? error),
    });
    return base;
  }
}

export async function runSweep(
  openPrs: OpenPrView[],
  deps: SweepDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<SweepSummary> {
  // Alias-bound call site (W1-T2393): the bare `readLedgerLines` regex cannot match a name-bound
  // call, so this marker is documentary only — the enforced corpus and the regex are unchanged.
  // ledger-read-intent: live — this fold reads the live file only, never rotations.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log ?? (() => {});

  // Dedup is keyed on the ledger, which persists across sweeps even when the input is
  // byte-identical — the level-triggered idempotence mechanism. The SAME read feeds
  // {@link decideSweepArm}'s head-bound recovery, so arming parity costs no extra read.
  const ledgerLines = readLedger(deps.ledgerPath);
  const prior = priorActionsFromLedger(ledgerLines);
  // W1-T3202 — FULL-SWEEP CAPACITY IS DERIVED ONCE, BEFORE ANY REPAIR CAN SPAWN. Reviews reserve
  // only their live spawning width (plan filings are deterministic), and the same active-worker
  // sample feeds both the adaptive review selector and the repair remainder. Light passes supply
  // their shared controller below because they fan this function out one PR at a time.
  const fullRepairActiveWorkers =
    deps.repairAdmissionSurface === "full" && !deps.claimFixAdmission
      ? (deps.readActiveWorkerCount ?? activeWorkerCount)()
      : undefined;
  const fullReviewQueueDepth = deps.repairAdmissionSurface === "full"
    ? reviewAdmissionQueueDepth(openPrs, policy, now, {
        delivered: prior.reviewDelivered,
        refused: prior.reviewRefused,
        retryableThrows: prior.reviewRetryableThrows,
      })
    : undefined;
  const fullReviewLanes = fullReviewQueueDepth === undefined
    ? undefined
    : effectiveReviewWidth(deps, policy, fullReviewQueueDepth, now, ledgerLines, fullRepairActiveWorkers);
  const fullRepairAdmission =
    fullRepairActiveWorkers === undefined || fullReviewQueueDepth === undefined || fullReviewLanes === undefined
      ? undefined
      : createSweepFixAdmissionController({
          surface: "full",
          queueDepth: fullReviewQueueDepth,
          hostWorkerBudget: policy.reviewCapacity.hostWorkerBudget,
          activeWorkers: fullRepairActiveWorkers,
          reviewReservations: Math.min(fullReviewQueueDepth, fullReviewLanes),
          log,
        });
  const claimFixAdmission = deps.claimFixAdmission ?? fullRepairAdmission?.claim;
  const repairAdmissionTelemetry = deps.repairAdmissionTelemetry ?? fullRepairAdmission?.snapshot;
  // W1-T1223 (design ii) — read fresh every pass, off the SAME ledger read above; never held in
  // memory across passes. See `requeuedCheckKeysFromLedger`'s own doc.
  const requeuedCheckKeys = requeuedCheckKeysFromLedger(ledgerLines);
  // W1-T1275 (design iv) — the SAME fresh-every-pass, ledger-only bound as `requeuedCheckKeys`
  // immediately above. See `reaggregatedCiGateKeysFromLedger`'s own doc.
  const reaggregatedCiGateKeys = reaggregatedCiGateKeysFromLedger(ledgerLines);
  // W1-T2345 — the SAME fresh-every-pass, ledger-only fold as `requeuedCheckKeys`/
  // `reaggregatedCiGateKeys` above. See `repeatDispositionStreaksFromLedger`'s own doc.
  const priorRepeatRuns = repeatDispositionStreaksFromLedger(ledgerLines);
  // W1-T2620/W1-T3422 — ONE read per pass, never per PR. The SHA-only compatibility seam stays
  // available to direct callers; production's effects cache both fields from one REST response.
  const mainRepair = deps.readMainRepair ? await deps.readMainRepair() : undefined;
  const mainTipSha = mainRepair?.sha ?? (deps.readMainTip ? await deps.readMainTip() : undefined);
  // W1-T2620 — AT MOST ONE base-caused PR selected for release THIS pass, oldest activity first,
  // computed ONCE before the walk — the same single-winner shape `selectUpdateBranchTarget` uses.
  const baseCausedReleaseTarget =
    mainTipSha === undefined
      ? undefined
      : selectBaseCausedRelease(openPrs, mainTipSha, lastBaseCausedTipFromLedger(ledgerLines), now);
  // W1-T2789 — unlike W1-T2620's cohort-wide release above, this is exact-path evidence for the
  // exhausted red population the disposition table would otherwise escalate before runFixRung
  // reaches its W1-T2671 pre-strike check. The write still rechecks live state and head below.
  const staleBaseReleaseTarget = await selectStaleBaseRelease(
    openPrs,
    policy,
    now,
    mainTipSha,
    staleBaseReleaseKeysFromLedger(ledgerLines),
    deps.updateBranch && deps.readLiveState && (deps.actionable?.("blocked-ambiguous") ?? true)
      ? deps.readRedBaseRefreshFacts
      : undefined,
    (pr, error) => log("sweep.red_base_refresh.read_error", {
      pr_number: pr.prNumber,
      head_sha: pr.headSha,
      error: String((error as Error)?.message ?? error),
    }),
  );
  // W1-T3422 — a distinct exact stale verdict path. It excludes the W1-T2620 cohort in the
  // selector and yields to W1-T2789 when that older, separately-proven base refresh already owns
  // this PR. The candidate read itself is bounded inside the selector; no candidate, no API call.
  const staleRedReleaseTarget = await selectStaleRedRelease(
    staleBaseReleaseTarget ? openPrs.filter((pr) => pr.prNumber !== staleBaseReleaseTarget.pr.prNumber) : openPrs,
    policy,
    now,
    mainRepair,
    staleRedReleaseKeysFromLedger(ledgerLines),
    deps.readStaleRedWorkflowRuns && deps.runStaleRedLocalRoute && deps.releaseStaleRed && (deps.actionable?.("blocked-ambiguous") ?? true)
      ? deps.readStaleRedWorkflowRuns
      : undefined,
    STALE_RED_WORKFLOW_READ_CAP,
    (pr, error) => log("sweep.stale_red.workflow_unreadable", {
      pr_number: pr.prNumber,
      head_sha: pr.headSha,
      error: String((error as Error)?.message ?? error),
    }),
  );
  // `prIndex` -> this PASS's own streak, and whether the one-time repeat escalation fires this
  // pass. A Map keyed by index rather than two positional parameters threaded through all four of
  // `finalizeDisposition`'s call sites, three of which are reached only from the deferred
  // post-review batch, well after the walk that computes this.
  const repeatMeta = new Map<number, { streak: number; escalated: boolean }>();

  // ── W1-T931 COST-ANOMALY SENTINEL ───────────────────────────────────────────────────────────
  // Hung off THIS pass rather than a new call site: `runSweep` already read the whole ledger and runs
  // on the daemon's cadence. Independent of `openPrs`, guarded by `!deps.dryRun`, and wrapped in the
  // SAME throw containment — a detector failure must never fail the reconciliation pass it shares a
  // ledger read with. `recordCostAnomalies` is idempotent per run id.
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
  // Filled by INDEX, never pushed — post-review actions are finalized out of pass order, so
  // `actions[i]` is the only way to keep {@link SweepSummary.actions}'s "in input order" invariant
  // while still letting reviews run concurrently.
  const actions: SweepAction[] = new Array(openPrs.length);
  // W1-T905: this pass's OWN newly-appended rows, mirrored as they are written and never re-read
  // from disk, so the repair-filing fold can see a recurrence that crossed threshold WITHIN this
  // pass — `ledgerLines` was read before these writes and is never refreshed.
  const passDisposedRows: Array<Record<string, unknown>> = [];
  let actionsTaken = 0;
  // W1-T99: counted distinctly from actionsTaken/noneCount so a caller can tell
  // "nothing to do" from "something threw" at a glance — see renderSweepSummary.
  let actionsFailed = 0;
  let noneCount = 0;
  // W1-T2789: once this lane has attempted an update, the older armed/stale-gate update lane at
  // the end of the pass must not issue a second request against the same stale snapshot.
  let staleBaseAttemptedPrNumber: number | undefined;
  const applyDirtyFleetRebase = async (
    pr: OpenPrView,
  ): Promise<{ handled: true; standDownReason: string } | { handled: false }> => {
    if (pr.mergeState !== "dirty" || !isDispatchedRunBranch(pr.headRefName) || !deps.rebaseDirtyFleetBranch) {
      return { handled: false };
    }
    const outcome = await deps.rebaseDirtyFleetBranch(pr);
    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: pr.taskId ?? "SWEEP",
      step: `sweep.dirty_fleet_rebase.${outcome.outcome}`,
      pr_number: pr.prNumber,
      pr_url: pr.prUrl,
      head_sha: pr.headSha,
      head_ref_name: pr.headRefName,
      ...(outcome.outcome === "rebased" ? { new_head_sha: outcome.newHeadSha } : { reason: outcome.reason }),
    });
    log("sweep.dirty_fleet_rebase", {
      pr_number: pr.prNumber,
      head_sha: pr.headSha,
      head_ref_name: pr.headRefName,
      outcome: outcome.outcome,
      ...(outcome.outcome === "rebased" ? { new_head_sha: outcome.newHeadSha } : { reason: outcome.reason }),
    });
    if (outcome.outcome !== "rebased") return { handled: false };
    return {
      handled: true,
      standDownReason:
        `rebased dirty fleet branch ${pr.headRefName} from ${outcome.oldHeadSha} to ${outcome.newHeadSha} ` +
        "before escalation; required checks will re-run on the new head and no human issue was filed",
    };
  };

  // ── W1-T473/W1-T513 — REVIEW CONCURRENCY BUDGET STATE ──────────────────────
  // `claimedReviewKeys` is the REAL mutual exclusion concurrency needs: a worker consults and updates
  // it synchronously immediately before its `postReview` attempt. Discovery alone does not claim,
  // since the pass-level snapshot may be stale by worker start. W1-T513 made it the module-level set.
  const claimedReviewKeys = inFlightReviewKeys;

  /** W1-T2771 — CLAIM AT ACTION TIME, THEN RE-READ THE OUTCOME UNDER THE CLAIM. The old placement
   *  claimed during the sequential walk, so a later fix action could hold a review candidate's key
   *  for minutes with no review in flight. The fresh read is the other half: reading synchronously
   *  after `add` makes the mutex and the durable outcome one atomic decision boundary. */
  function claimReview(
    reviewKey: string,
  ): { ok: true; release: () => void } | { ok: false; deduped: boolean; reason: string } {
    if (claimedReviewKeys.has(reviewKey)) {
      return {
        ok: false,
        deduped: true,
        reason: `duplicate review key (${reviewKey}) already claimed this pass — see PriorActions.reviewDelivered/reviewRefused's docs`,
      };
    }
    claimedReviewKeys.add(reviewKey);
    try {
      const fresh = priorActionsFromLedger(readLedger(deps.ledgerPath));
      const delivered = fresh.reviewDelivered.has(reviewKey);
      const durableRefusal = fresh.reviewRefused.has(reviewKey);
      const retryBackoff = retryableReviewThrowBackoffReason(fresh.reviewRetryableThrows, reviewKey, policy, now);
      if (delivered || durableRefusal || retryBackoff !== undefined) {
        claimedReviewKeys.delete(reviewKey);
        return {
          ok: false,
          deduped: true,
          reason: delivered
            ? `a verdict was already DELIVERED for ${reviewKey} — the action-time re-read deduped the re-post`
            : durableRefusal
              ? `a review post was already REFUSED for ${reviewKey} — the action-time re-read deduped the re-post`
              : retryBackoff!,
        };
      }
    } catch (e) {
      claimedReviewKeys.delete(reviewKey);
      return {
        ok: false,
        deduped: false,
        reason: `review action-time outcome read failed closed (${String((e as Error)?.message ?? e)}) — re-derived next pass`,
      };
    }
    return { ok: true, release: () => claimedReviewKeys.delete(reviewKey) };
  }

  /** W1-T2520 — CLAIM THIS PR'S FIX-DISPATCH KEY, or refuse: the fix-rung twin of the review claim
   *  above. Refuses in exactly two shapes, both SYNCHRONOUS — no `await` ever separates the check
   *  from the claim: a genuinely concurrent second claim, or a strike count RE-READ off the ledger
   *  that has already reached {@link fixCeilingInForce}. Only a successful claim releases. */
  function claimFixDispatch(
    pr: OpenPrView,
  ): { ok: true; release: () => void; run: <T>(fn: () => T | Promise<T>) => Promise<T> } | { ok: false; reason: string } {
    const fixKey = `${pr.taskId ?? ""}@${pr.headSha}`;
    if (inFlightFixKeys.has(fixKey)) {
      return {
        ok: false,
        reason: `duplicate fix-dispatch key (${fixKey}) already claimed this pass — a concurrent sweep is already dispatching this PR's fix rung`,
      };
    }
    inFlightFixKeys.add(fixKey);
    // READ UNDER THE CLAIM: taken only now the claim is held, so a `fix.dispatch` row a concurrent
    // caller wrote before this instant is counted here even though this pass's own `ledgerLines`,
    // read before any claim existed, predates it.
    const freshLines = readLedger(deps.ledgerPath);
    const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
    const freshStrikes = freshFixDispatchCount(freshLines, pr.taskId, pr.headSha);
    if (freshStrikes >= ceiling) {
      inFlightFixKeys.delete(fixKey);
      return {
        ok: false,
        reason: `fix strikes exhausted under the claim (${freshStrikes}/${ceiling}) — refused before dispatch, never spending a strike a concurrent sweep already spent`,
      };
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlightFixKeys.delete(fixKey);
    };
    return {
      ok: true,
      release,
      run: async (fn) => {
        try {
          return await fn();
        } finally {
          release();
        }
      },
    };
  }

  async function applyMissingTaskTrailerRepair(pr: OpenPrView): Promise<
    | { handled: false }
    | { handled: true; standDownReason: string }
  > {
    const decision = missingTaskTrailerRepairDecision(pr);
    if (decision.action === "ignore") return { handled: false };
    if (decision.action === "stand-down") return { handled: true, standDownReason: decision.reason };
    const repair = decision.repair;
    const key = `${pr.prNumber}@${pr.headSha}@${repair.taskId}`;
    if (prior.missingTaskTrailerRepairs.has(key)) {
      return {
        handled: true,
        standDownReason:
          `missing trailer already repaired for ${repair.taskId} on this head — awaiting the fresh ` +
          `pull_request.edited gate result, never rerunning the stale failed job`,
      };
    }
    if (!deps.repairMissingTaskTrailer) {
      return {
        handled: true,
        standDownReason: `missing trailer repair not wired — derived ${repair.trailer} but left the PR body unchanged`,
      };
    }
    const written = await deps.repairMissingTaskTrailer(pr, repair);
    if (written === false) {
      return {
        handled: true,
        standDownReason: `missing trailer repair declined while writing ${repair.trailer} — re-derived next pass`,
      };
    }
    prior.missingTaskTrailerRepairs.add(key);
    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: repair.taskId,
      step: MISSING_TASK_TRAILER_REPAIR_STEP,
      pr_number: pr.prNumber,
      pr_url: pr.prUrl,
      head_sha: pr.headSha,
      trailer: repair.trailer,
      refire_event: repair.refireEvent,
      rerun_failed_jobs: repair.rerunFailedJobs,
      scope_overrun_paths: repair.scopeOverrunPaths,
      reason: repair.reason,
    });
    return {
      handled: true,
      standDownReason:
        `missing trailer repaired by editing the PR body with ${repair.trailer}; GitHub will emit ` +
        `pull_request.edited for the fresh body, and no failed job was rerun` +
        (repair.scopeOverrunPaths.length > 0
          ? `; scope overrun reported: ${repair.scopeOverrunPaths.join(", ")}`
          : ""),
    };
  }

    // Reviews eligible this pass, deferred out of the main walk so they can run CONCURRENTLY with
    // each other, bounded by `reviewLanes` after the loop.
  const pendingReviews: Array<{
    index: number;
    pr: OpenPrView;
    reason: string;
    question: ClarificationQuestion | undefined;
    // W1-T513: carried alongside the job so both release sites release the SAME key they claimed;
    // recomputing it from `pr` would work, but carrying it removes any chance of drift.
    reviewKey: string;
  }> = [];

  /** The tail every disposition shares once `acted`, `actionError` and `standDownReason` are known —
   *  factored out so the synchronous walk and the concurrent review batch ledger and log IDENTICALLY.
   *  Unconditional counting matches the original inline placement: a deduped PR reaches here with
   *  `acted:false` and no error, so neither counter moves. W1-T1061: `armOutcome` rides alongside. */
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
    // W1-T2231: {@link SweepAction.spent}'s own doc — `undefined` for every call site except the
    // main per-PR walk's "blocked-fixable"/"conflicted" arms below.
    spent: boolean | undefined,
    // W1-T2620: the release marker riding the EXISTING `sweep.disposed` step. `undefined` for
    // every call site except the walk's "blocked-fixable" arm, and even there only when this pass
    // classified the PR base-caused AND a main tip was actually read.
    baseCausedMainTipSha: string | undefined = undefined,
  ): void {
    if (standDownReason) {
      // The site the TASK names ("a sweep disposition"), naming the state — never silent: a caller
      // diffing the ledger sees exactly why a blocked-fixable disposition spent nothing this pass.
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
      ...(spent !== undefined ? { spent } : {}),
    };

    log("sweep.dispose", {
      pr_number: pr.prNumber,
      disposition,
      acted,
      reason,
      deduped,
      ...(actionError ? { action_error: actionError } : {}),
      // W1-T254: THIS line fires unconditionally through the injected `log`, which the real wiring
      // persists to the SAME ledger regardless of `--dry-run`. Tagged so a preview pass is never
      // mistaken for a daemon action — the exact ambiguity that misread one during the #707
      // diagnosis.
      ...(deps.dryRun ? { dry_run: true } : {}),
    });

    // One ledger line per disposition (the INVARIANT). Skipped under --dry-run, because a preview
    // must leave no trace. The rendered question rides along whenever one exists: an UNANSWERED
    // question stays ledgered on every subsequent sweep, even once `acted` goes false.
    if (!deps.dryRun) {
      // W1-T2345 — this PASS's own repeat-streak figures, computed once per PR earlier in the walk
      // and read back by `index`, so all four call sites carry it with no signature change.
      const repeat = repeatMeta.get(index);
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
        // W1-T2345: `repeat_streak` rides every row — always in hand by this point — so the next
        // pass's fold never has to guess it back out of row order. `repeat_escalated` is present
        // ONLY on the pass that actually fired the one-time escalation, which is the field the
        // "stays quiet until the head moves" guarantee is built on.
        ...(repeat !== undefined ? { repeat_streak: repeat.streak } : {}),
        ...(repeat?.escalated ? { repeat_escalated: true } : {}),
        // W1-T1061: the FIELD sibling to `stand_down_reason`'s prose — present whenever `deps.arm`
        // returned a concrete outcome this pass, armed or not, and absent when no arm was
        // attempted. Same value the sentence names, so the two cannot drift: one write, read twice.
        ...(armOutcome ? { arm_outcome: armOutcome } : {}),
        // W1-T2231: present ONLY when the dispatch arms captured a concrete verdict for THIS call.
        // `dueRepairFilings` reads this field, never `acted`, to decide whether a dispatch-based
        // repair surface's row is an actual repair.
        ...(spent !== undefined ? { spent } : {}),
        ...(question ? { question: question.question } : {}),
        // W1-T2620 — rides this EXISTING step rather than minting a fourth ledger signal. Present
        // ONLY when this pass classified the PR base-caused AND a main tip was read; see
        // {@link lastBaseCausedTipFromLedger} for the fold that reads it back next pass.
        ...(baseCausedMainTipSha !== undefined ? { main_tip_sha: baseCausedMainTipSha } : {}),
      };
      appendLine(deps.ledgerPath, disposedLine);
      // W1-T905: mirrored in-memory with THIS PASS'S OWN `ts`, never re-read off disk. The real
      // append stamps its own write-time `ts`, which this never touches; the copy exists solely so
      // `dueRepairFilings` can see a same-pass recurrence without a second ledger read.
      passDisposedRows.push({ ...disposedLine, ts: new Date(now).toISOString() });
    }

    if (acted) actionsTaken++;
    else if (actionError) actionsFailed++;
  }

  // ── PER-PASS HEARTBEAT, WRITTEN BEFORE THE LOOP ────────────────────────────────────────────
  // A BLIND SWEEP AND A QUIET FLEET ARE INDISTINGUISHABLE without this: `sweep.disposed` writes a
  // decision per PR per tick, so its ABSENCE is the only other signal, and absence is what a healthy
  // quiet period looks like. POSITION IS THE WHOLE POINT — `sweep.summary` sits AFTER the loop, so a
  // pass that dies mid-way writes nothing; written here, "started but never summarised" becomes the
  // legible state `judgeSweepLiveness` reads. RENDER_RELEVANT, rotating on recency (W1-T1237).

  log("sweep.pass", { enumerated: openPrs.length, dry_run: deps.dryRun === true });

  for (let prIndex = 0; prIndex < openPrs.length; prIndex++) {
    const pr = openPrs[prIndex];
    let { disposition, reason } = postReviewFailureHistoryDisposition(pr, prior, policy, now) ?? deriveDisposition(pr, policy, now);
    // W1-T3306: `deriveDisposition` has no ledger input, while capped proof grades live only on
    // `review.posted`. Route the exact capped-green arm refusal through the EXISTING fix rung;
    // its claim re-read and shared strike cap remain the sole spending boundary. An operator
    // override keeps `arm` true and therefore retains the ordinary mergeable arm route.
    const proofDiscrimination =
      disposition === "mergeable" && automergeHoldFromLedger(ledgerLines, pr.prNumber) === undefined
        ? cappedProofDiscriminationFromLedger(pr, ledgerLines)
        : undefined;
    if (proofDiscrimination !== undefined && !decideSweepArm(pr, ledgerLines).arm) {
      const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
      if (pr.priorStrikes >= ceiling) {
        disposition = "blocked-ambiguous";
        reason = `capped review still has non-discriminating proofs, but its shared fix budget is exhausted (${pr.priorStrikes}/${ceiling})`;
      } else {
        disposition = "blocked-fixable";
        reason = "capped review has only non-discriminating proofs — dispatching the existing bounded fix rung to repair the PR body";
      }
    }
    byDisposition[disposition]++;

    // W1-T2345 — computed for EVERY disposition, never only blocked-ambiguous, and BEFORE the
    // per-disposition dedup below: this bounds the DERIVATION itself, orthogonal to whatever
    // per-head dedup a specific disposition's own gated action already has.
    const priorRepeatRun = priorRepeatRuns.get(pr.prNumber);
    const repeatRunContinues =
      priorRepeatRun !== undefined && priorRepeatRun.headSha === pr.headSha && priorRepeatRun.disposition === disposition;
    const repeatStreak = repeatRunContinues && priorRepeatRun ? priorRepeatRun.streak + 1 : 1;
    const repeatAlreadyEscalated = repeatRunContinues && priorRepeatRun ? priorRepeatRun.escalated : false;
    const repeatBoundTripped = repeatStreak >= policy.repeatDispositionBound;
    let repeatEscalatedNow = false;
    // Skipped entirely under --dry-run — a preview must leave no trace — and whenever a prior pass
    // already fired this run's escalation, the "stays quiet until the head moves" half of the
    // acceptance criteria.
    if (repeatBoundTripped && !repeatAlreadyEscalated && !deps.dryRun) {
      try {
        // W1-T2381: THE LEDGER ROW IS THE WHOLE OUTPUT — no `deps.escalate()` call. The dedup key
        // is task+head+cause and never the repeat condition, so routing the trip to the issue
        // surface landed comments on issues titled for a different cause. THE SURFACE IS
        // `digest.ts`. // Why: measured over eight trips — docs/forensics/sweep.md.
        log("sweep.repeat_escalated", { pr_number: pr.prNumber, disposition, streak: repeatStreak, head_sha: pr.headSha });
        repeatEscalatedNow = true;
      } catch (e) {
        // W1-T254 per-PR throw containment, KEPT after the escalate call was removed: the remaining
        // `log` is a real ledger append and can still throw on I/O, and one PR's failed write must
        // never take the whole pass. `repeatEscalatedNow` stays false, so the next pass tries again.
        log("sweep.repeat_escalate_failed", { pr_number: pr.prNumber, error: String((e as Error)?.message ?? e) });
      }
    }
    repeatMeta.set(prIndex, { streak: repeatStreak, escalated: repeatEscalatedNow });

    // W1-T196: a blocked-ambiguous PR with no task id is a KNOWN, non-emergency state ONLY when it
    // is POSITIVELY a plan-filing PR — one carries no trailer BY DESIGN, so there is no task to ask
    // about. An unattributed PR NOT flagged plan-filing still escalates: that is a genuine
    // attribution defect, not a designed gap.
    const unattributableFiling = disposition === "blocked-ambiguous" && !pr.taskId && pr.isPlanFiling === true;

    // W1-T78: render the question up front for blocked-ambiguous PRs — it is ledgered EVERY sweep
    // so an unanswered question stays visible, even on a deduped pass. Skipped for an
    // unattributable filing PR, where there is only a stand-down to record.
    const question =
      (disposition === "blocked-ambiguous" || disposition === "refused-escalate") && !unattributableFiling
        ? renderClarificationQuestion(pr, reason, pr.strikeHistory ?? [])
        : undefined;

    // Is this action already true (deduped)? Keyed per disposition.
    let alreadyDone: boolean;
    // W1-T1000002: set ONLY when an operator hold stands over a PR GitHub ALREADY reports armed.
    // The withdrawal fires unconditionally, never gated on `acted`, which a held PR always has
    // false.
    let holdToWithdraw: AutomergeHold | undefined;
    // W1-T1110: set ONLY when a PRIOR dispatch against this exact head is still deduping and its
    // rung has not stalled out. Named here rather than silently stood down — the unnamed
    // stand-down is what two readers independently misread as an unwired action path.
    let dedupStandDownReason: string | undefined;
    switch (disposition) {
      case "mergeable": {
        // PREFER OBSERVED STATE: GitHub's own `autoMergeArmed` is the authority for "already armed";
        // the sweep's memory is a fallback, now sha-keyed so a new head re-earns the attempt.
        // W1-T970: a head the risk judge escalated is refused HERE, in `alreadyDone`, never in the
        // rule's `when` and never in the merge path — the SAME non-action shape every other dedup
        // has. It clears on a NEW head sha or an explicit operator override.
        const riskRefusedKey = `${pr.prNumber}@${pr.headSha}`;
        const refused =
          prior.riskRefused.has(riskRefusedKey) &&
          !(pr.taskId !== undefined && cappedOverrideFromLedger(ledgerLines, pr.taskId, pr.headSha) !== undefined);
        // W1-T1000002: A HOLD IS A LEDGERED REFUSAL, NOT A BARE DISARM. Deliberately NEVER
        // sha-keyed, unlike `refused` above: a hold binds the PR, not any one head, so a push while
        // held changes nothing. No dedup key is seeded, so the pass re-derives whole the moment an
        // operator releases it — no separate resume path.
        const hold = automergeHoldFromLedger(ledgerLines, pr.prNumber);
        if (hold && pr.autoMergeArmed === true) holdToWithdraw = hold;
        const armedByGitHub = pr.autoMergeArmed === true;
        const armedByPriorPass = !armedByGitHub && prior.armed.has(`${pr.prNumber}@${pr.headSha}`);
        alreadyDone = armedByGitHub || armedByPriorPass || refused || hold !== undefined;
        // W1-T1116: NAME WHICH DISJUNCT FIRED. This switch left all of them silent, the same gap
        // the fix arm above already closed, and the only reason two readers misdiagnosed a
        // correctly-held #2432 as a never-clearing dedup. Order matches the `||` above, so a reader
        // learns the FIRST true disjunct — the one that actually short-circuited `alreadyDone`.
        if (armedByGitHub) {
          dedupStandDownReason = "auto-merge already armed (observed on GitHub) — nothing to re-arm";
        } else if (armedByPriorPass) {
          dedupStandDownReason = `auto-merge already armed by a prior sweep pass at this head (${pr.headSha.slice(0, 7)})`;
        } else if (refused) {
          // Carry the SAME `issue_url` the sibling `risk_judge.escalated` row already holds: the
          // pointer exists one row away, and this only moves it to the row a reader reaches first.
          // Never widens the override — naming the escape is not taking it.
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
        // DISPATCHED, never that it succeeded. When the ledger shows that rung already ENDED
        // without landing a new head, treating it as "already done" would dedup this PR against a
        // head nothing will move again. A dispatch that RESOLVED is never read as stalled.
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
        // W1-T2427: NAME THE DEDUP, the same shape the sibling arms use. The fact is already in
        // hand from this membership test, so the sentence costs no read and no ledger line. This
        // arm has been QUIET since 2026-08-17, which is not the same as fixed.
        if (alreadyDone) {
          dedupStandDownReason =
            `this PR is already recorded CLOSED by a prior sweep pass (pr #${pr.prNumber} is in the ` +
            `closed set) — the close is deduped, not skipped, and no second close was attempted`;
        }
        break;
      case "blocked-ambiguous":
      case "refused-escalate":
        // W1-T514: sha-keyed, exactly like every sibling arm above — a new head re-earns its own
        // escalation rather than being deduped by a stale head's `acted:true` line forever.
        alreadyDone = prior.escalated.has(`${pr.prNumber}@${pr.headSha}`);
        // W1-T2427: the LARGEST silent population (7,888 rows). Without this sentence the row is
        // indistinguishable from `deps.escalate` being unwired or throwing.
        if (alreadyDone) {
          dedupStandDownReason =
            `an escalation was already filed for this head (${pr.headSha.slice(0, 7)}) — the ` +
            `escalation is deduped, not skipped, and a new head re-earns its own`;
        }
        break;
      case "dep-review":
        alreadyDone = prior.depReviewed.has(`${pr.prNumber}@${pr.headSha}`);
        // W1-T2427: names the TERMINAL-outcome dedup specifically, because a `hold` deliberately
        // does NOT dedup (see `priorActionsFromLedger`'s own dep-review arm) — so "deduped" here
        // is a positive statement about the prior outcome, never a silent skip.
        if (alreadyDone) {
          dedupStandDownReason =
            `dependency review already reached a TERMINAL outcome at this head ` +
            `(${pr.headSha.slice(0, 7)}) — a hold would have re-run instead of deduping`;
        }
        break;
      case "post-review": {
        // W1-T254: OUTCOME-keyed, by taskId rather than prNumber — the review rows carry no PR
        // number. W1-T1213: a DELIVERED verdict suppresses this head forever; a REFUSED attempt
        // also suppresses UNLESS it was the stale "PR is already closed" refusal, in which case
        // reaching this check already proves the PR is open again.
        const reviewKey = reviewOutcomeKeyForPr(pr);
        const reviewDelivered = prior.reviewDelivered.has(reviewKey);
        const reviewDurablyRefused = prior.reviewRefused.has(reviewKey);
        const retryBackoff = retryableReviewThrowBackoffReason(prior.reviewRetryableThrows, reviewKey, policy, now);
        alreadyDone = reviewDelivered || reviewDurablyRefused || retryBackoff !== undefined;
        // W1-T2427 — THE SENTENCE MUST SEPARATE FOUR STATES THAT OTHERWISE LOOK IDENTICAL: this
        // dedup firing, `deps.postReview` never being wired, the light-pass admission being lost to
        // another PR, or a dry run. Only the first is this arm, and only this arm can say so.
        if (alreadyDone) {
          dedupStandDownReason = reviewDelivered
            ? `a verdict was already DELIVERED for ${reviewKey} — the re-post is deduped by this ` +
              `arm, not lost to an admission and not unwired`
            : reviewDurablyRefused
              ? `a review post was already REFUSED for ${reviewKey} — the re-post is deduped by this ` +
                `arm, not lost to an admission and not unwired`
              : retryBackoff;
        }
        break;
      }
      case "wait":
        // W1-T114: WAIT never gates an effect — there is nothing to dispatch, only time to let
        // pass. Forcing `alreadyDone` true, rather than adding a no-op case to the action switch,
        // keeps `acted` false unconditionally, so a wait is re-derived and re-ledgered every pass.
        alreadyDone = true;
        // W1-T1116 — the fourth silent guard. Forcing `alreadyDone` true is BY DESIGN, since there
        // is no refusal to distinguish, but the row still read `acted:false` with nothing saying
        // why. `reason` already narrates what is being waited on, reused verbatim.
        dedupStandDownReason = reason;
        break;
      default:
        alreadyDone = false;
    }

    // W1-T2789: a prior blocked-ambiguous escalation is not a successful base refresh. The
    // exact-path release has its own success key, so it stays retryable after a read or write
    // failure even when the ordinary escalation was already recorded for this head.
    if (staleBaseReleaseTarget?.pr.prNumber === pr.prNumber) {
      alreadyDone = false;
      dedupStandDownReason = undefined;
    }

    let acted = !alreadyDone && !deps.dryRun;
    // The dep-review lane's decision for THIS pass (dep-review disposition only)
    // — ledgered so priorActionsFromLedger can tell terminal from hold.
    let depReviewOutcome: string | undefined;
    // W1-T177: set ONLY when the terminal-state check stood the dispatch down — distinct from
    // `alreadyDone` (dedup) and `deps.dryRun` (preview), so the disposed line can name WHY `acted`
    // is false without conflating the three. W1-T1110 seeds it from `dedupStandDownReason` so a
    // still-deduped fix dispatch NAMES ITSELF on this same field rather than standing down silently.
    let standDownReason: string | undefined = dedupStandDownReason;
    // W1-T1061: the FIELD twin of `standDownReason`'s prose, set ONLY when the mergeable case
    // actually calls `deps.arm` and gets a concrete outcome back; every other path leaves this
    // `undefined` so no `arm_outcome` field is written at all.
    let armOutcome: ArmOutcomeName | undefined;
    // W1-T2231: set ONLY by the dispatch cases when `deps.dispatchFix` returns a concrete verdict;
    // otherwise `undefined`, so no `spent` field is written at all.
    let spent: boolean | undefined;
    // W1-T2620: set ONLY by the base-caused branch, when this pass classified the PR base-caused
    // AND a main tip was read; otherwise `undefined`, so no `main_tip_sha` field is written.
    let baseCausedMainTipSha: string | undefined;
    // W1-T254 — PER-PR THROW CONTAINMENT: a thrown action used to propagate straight out of
    // `runSweep` as one unattributed error, aborting the WHOLE pass. Named here and ledgered on
    // THIS PR's own line instead, so the loop always reaches the next PR.
    let actionError: string | undefined;
    // W1-T473: set true ONLY when a real `postReview` dep is wired and eligible, deferring this
    // PR's finalize call to the bounded concurrent batch after the loop rather than running inline.
    let deferredReview = false;

    if (acted) {
      // W1-T254 — LIGHT-SWEEP RESTRICTION. `actionable` defaults to everything, so `rmd sweep` and
      // the full sweep are unchanged. The light ticker passes `d => d === "post-review"`, so every
      // other lane stands down here and is re-derived on the next full sweep, never dropped.
      if (deps.actionable && !deps.actionable(disposition)) {
        acted = false;
        // W1-T2426: the caller may name WHICH mechanism refused; absent, the generic sentence
        // every gated disposition has always recorded, unchanged.
        standDownReason =
          deps.standDownReasonFor?.(disposition) ?? "deferred to full sweep (light pass)";
      } else {
        try {
          switch (disposition) {
            case "mergeable": {
              // ARMING PARITY (see {@link decideSweepArm}): the run flow's capped refusal is
              // worthless while this independent path arms the same verdict seconds later. Stand
              // down instead — `acted:false` keeps this PR out of `prior.armed`, so the next pass
              // re-derives and arms the moment executed proof or a ledgered override lands.
              const armDecision = decideSweepArm(pr, ledgerLines);
              if (!armDecision.arm) {
                acted = false;
                standDownReason = armDecision.reason;
                break;
              }
              // READ THE OUTCOME. `armAutoMerge` does not throw — it RETURNS which of its seven
              // branches it took, and five of them armed nothing. Discarding it is what let
              // `acted:true` be recorded for a PR that was never armed.
              const armResult = await deps.arm(pr);
              // W1-T1117: `deps.arm` may return the bare name it always could, or the richer
              // outcome-plus-failureClass object. Unwrap once, here.
              const armOutcomeName = typeof armResult === "object" && armResult !== null ? armResult.outcome : armResult;
              // W1-T1061: capture the concrete outcome whenever one came back. A `void` return is
              // the legacy "treat as armed" shape and names no real branch, so no field is written.
              if (armOutcomeName !== undefined) armOutcome = armOutcomeName;
              if (!armOutcomeArmed(armOutcomeName)) {
                acted = false;
                // The refusal used to go only to `say` -> stdout -> daemon.out.log, leaving no
                // trace in the ledger where anyone looks. Name it on the disposed line.
                standDownReason = `arm outcome: ${String(armOutcomeName)}`;
                // W1-T1117: an `arm-error-ignored` outcome classified `"unknown"` is the ONE
                // non-armed outcome that must NOT retry — the classifier could not decode the
                // failure, so nothing says the SAME attempt will ever succeed. `"transient"` and
                // `"retryable"` stay on the `acted:false` line just set, as before.
                const failureClass = typeof armResult === "object" && armResult !== null ? armResult.failureClass : undefined;
                if (armOutcomeName === "arm-error-ignored" && failureClass === "unknown") {
                  acted = true;
                  standDownReason = undefined;
                }
              }
              break;
            }
            case "blocked-fixable": {
              // W1-T177 — TERMINAL-STATE CHECK AT THE SPENDING SITE: re-read this PR's state
              // FRESH, right before a strike is spent, never the snapshot this pass started from.
              // Omitted or indeterminate behaves exactly as before — dispatch proceeds, failing
              // OPEN rather than closed to a stand-down.
              const live = await deps.readLiveState?.(pr);
              let terminal: string | undefined;
              if (live) {
                if (live.ok) {
                  terminal = terminalStateReason(live.state);
                } else {
                  // FAIL OPEN, ledgered: an indeterminate read must never be treated as terminal,
                  // which would silently halt every blocked-fixable dispatch on a gh outage.
                  log("sweep.dispose.indeterminate", { pr_number: pr.prNumber });
                }
              }
              if (terminal) {
                acted = false;
                standDownReason = terminal;
                break;
              }
              const missingTrailerRepair = await applyMissingTaskTrailerRepair(pr);
              if (missingTrailerRepair.handled) {
                acted = false;
                standDownReason = missingTrailerRepair.standDownReason;
                break;
              }
              // W1-T527 — CLASSIFY BEFORE SELECTING, because the strike is spent at dispatch and
              // cannot be refunded. `classifyRedCause` is a pure fold over evidence already in
              // hand. Only base-caused and environment stand down.
              const redCause = classifyRedCause(pr, openPrs);
              if (redCauseStandsDown(redCause)) {
                acted = false;
                standDownReason = describeRedCause(redCause, pr, openPrs);
                // W1-T2620 — THE BASE-CAUSED STAND-DOWN'S EXIT CONDITION; the classifier, its text
                // and the strike accounting are untouched. `main_tip_sha` rides THIS PR's own line
                // whenever this pass classified it base-caused and a tip was read — recorded on the
                // ORDINARY stand-down path too, so the next pass's fold has a baseline.
                if (redCause === "base-caused" && mainTipSha !== undefined) {
                  baseCausedMainTipSha = mainTipSha;
                  // `selectBaseCausedRelease` already picked AT MOST ONE PR for this pass, oldest
                  // activity first (design iii) — this PR releases only if it IS that winner.
                  if (baseCausedReleaseTarget?.prNumber === pr.prNumber && deps.releaseBaseCausedStandDown) {
                    // The "released" sentence is set ONLY once the effect is about to be attempted.
                    // Omitted, this PR falls through to the ordinary stand-down sentence: never a
                    // silent no-op, and never a "released" claim with no push behind it.
                    try {
                      await deps.releaseBaseCausedStandDown(pr, mainTipSha);
                      standDownReason =
                        `red cause: base-caused — released: main has advanced to ${mainTipSha} since ` +
                        `this head last stood down against an earlier tip; redriving through the ` +
                        `existing post-fix leaf (no strike spent)`;
                    } catch (e) {
                      // FAIL QUIET — NEVER LAUNDER A RED: a failed release leaves this PR standing
                      // down under the ordinary sentence, retried next pass; no strike was at stake.
                      log("sweep.base_caused_release.error", {
                        pr_number: pr.prNumber,
                        main_tip_sha: mainTipSha,
                        error: String((e as Error)?.message ?? e),
                      });
                    }
                  }
                }
                break;
              }
              // W1-T1275 — CI-GATE'S OWN CONCLUDED VERDICT CAN GO STALE: a required sibling's
              // success can land AFTER the gate's run concluded and posted a terminal FAILURE.
              // Fires BEFORE `dispatchFix` so a stale verdict never spends a strike on a diff that
              // carries no defect. Bounded to AT MOST ONCE per (head, sibling-transition), and the
              // rollup is a FRESH read, never a field cached on `pr`.
              const ciGateRollup =
                isBlockedCi(pr) && deps.readCiGateRollup ? await deps.readCiGateRollup(pr) : undefined;
              const staleTransition = staleCiGateTransition(ciGateRollup);
              if (staleTransition) {
                const key = ciGateReaggregateKey(pr.headSha, staleTransition);
                const decision = ciGateReaggregateDecision(reaggregatedCiGateKeys.has(key));
                if (decision.reaggregate) {
                  // LEDGERED BEFORE THE CALL, the same ordering the re-queue uses below: a crash
                  // between this write and the real GitHub call still bounds the NEXT pass toward
                  // standing down rather than re-driving twice.
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: CI_GATE_REAGGREGATE_STEP,
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    head_sha: pr.headSha,
                    sibling_name: staleTransition.siblingName,
                    sibling_started_at: staleTransition.siblingStartedAt,
                  });
                  reaggregatedCiGateKeys.add(key);
                  if (deps.reaggregateCiGate) await deps.reaggregateCiGate(pr, staleTransition);
                }
                acted = false;
                standDownReason = decision.reaggregate
                  ? `stale ci-gate verdict — re-driving its job (required sibling "${staleTransition.siblingName}" ` +
                    `reached success at ${staleTransition.siblingStartedAt}, after the gate concluded)`
                  : `stale ci-gate verdict already re-driven for this transition — awaiting the fresh result`;
                break;
              }
              let ciFailuresForFix = isBlockedCi(pr) ? pr.ciFailures ?? [] : [];
              // W1-T3194 — A POSITIVELY IDENTIFIED CI-INFRASTRUCTURE FAILURE HAS NO DEFECT IN THE
              // DIFF. Use the SAME job-only effect and durable head/check bound as cancellations,
              // before any fix claim or worker strike. A generic 403 never reaches this branch.
              const infrastructureFailures = ciFailuresForFix.flatMap((failure) => {
                const signature = classifyCiInfrastructureFailure({
                  conclusion: failure.conclusion,
                  logTail: failure.logTail,
                });
                return signature ? [{ failure, signature }] : [];
              });
              if (infrastructureFailures.length > 0) {
                const handledNames = new Set<string>();
                const outcomes: string[] = [];
                for (const { failure, signature } of infrastructureFailures) {
                  handledNames.add(failure.name);
                  const key = `${pr.headSha}@${failure.name}`;
                  let outcome: "dispatched" | "failed" | "repeated" | "missing-job-id";
                  let reason: string | undefined;
                  if (requeuedCheckKeys.has(key)) {
                    outcome = "repeated";
                    reason = "the same infrastructure signature remained after its one bounded job retry";
                  } else if (!failure.jobId) {
                    outcome = "missing-job-id";
                    reason = "the positively classified failure had no resolvable Actions job id";
                  } else {
                    // Durable BEFORE mutation: a crash between these two lines cannot turn one
                    // bounded retry into an unbounded loop.
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: CHECK_REQUEUE_STEP,
                      surface: "pr",
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      check_name: failure.name,
                      signature,
                      job_id: failure.jobId,
                      outcome: "attempting",
                      worker_strike_avoided: true,
                    });
                    requeuedCheckKeys.add(key);
                    const result = deps.requeueCheck ? await deps.requeueCheck(pr, failure) : false;
                    outcome = result === false ? "failed" : "dispatched";
                    if (outcome === "failed") reason = "the single-job rerun API call failed";
                  }
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: "sweep.ci_infrastructure_requeue",
                    surface: "pr",
                    pr_number: pr.prNumber,
                    head_sha: pr.headSha,
                    check_name: failure.name,
                    signature,
                    ...(failure.jobId ? { job_id: failure.jobId } : {}),
                    outcome,
                    worker_strike_avoided: true,
                  });
                  outcomes.push(`${outcome} "${failure.name}"`);
                  if (reason && deps.escalateInfrastructureCheck) {
                    await deps.escalateInfrastructureCheck(pr, failure, reason, signature);
                  }
                }
                ciFailuresForFix = ciFailuresForFix.filter((failure) => !handledNames.has(failure.name));
                if (ciFailuresForFix.length === 0) {
                  acted = false;
                  standDownReason = `failed CI infrastructure check(s): ${outcomes.join("; ")}`;
                  break;
                }
              }
              // W1-T1223 — A CANCELLED REQUIRED CHECK HAS NO DEFECT IN THE DIFF for a fix-rung
              // worker to read. Fires BEFORE `dispatchFix` so a PR whose ENTIRE red verdict is
              // cancellations never spends a strike on nothing.
              const cancelledChecks = isBlockedCi(pr) ? pr.cancelledRequiredChecks ?? [] : [];
              if (cancelledChecks.length > 0) {
                let requeuedAny = false;
                const outcomes: string[] = [];
                for (const check of cancelledChecks) {
                  const key = `${pr.headSha}@${check.name}`;
                  // W1-T2431: OR the ledger-derived reading with the surface-derived one — a re-run
                  // this fleet ledgered, OR one GitHub's `run_attempt` shows already happened (an
                  // operator's own, invisible to the ledger). This only widens the true case.
                  const decision = cancelledCheckRequeueDecision(
                    requeuedCheckKeys.has(key) || cancelledCheckAlreadyRequeuedFromSurface(check.runAttempt),
                  );
                  if (decision.requeue) {
                    // LEDGERED BEFORE THE CALL, so a crash between this write and the real GitHub
                    // call still bounds the NEXT pass toward escalating. Not dry-run-guarded:
                    // reaching this line already proves `acted` was true, which `dryRun` forces false.
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: CHECK_REQUEUE_STEP,
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      check_name: check.name,
                    });
                    requeuedCheckKeys.add(key);
                    if (deps.requeueCheck) {
                      await deps.requeueCheck(pr, check);
                      requeuedAny = true;
                    }
                    outcomes.push(`re-queued "${check.name}"`);
                  } else {
                    if (deps.escalateCancelledCheck) await deps.escalateCancelledCheck(pr, check, decision.reason);
                    outcomes.push(`escalated "${check.name}" (${decision.reason})`);
                  }
                }
                // A cancelled check carries no diff defect — when EVERY red required check named
                // this pass is a cancellation, stand down rather than burning a strike on nothing.
                // `acted` stays FALSE: claiming true would seed `prior.fixed`, dedupe the whole
                // disposition away, and stop this logic observing the second cancellation.
                const genuineFailures = ciFailuresForFix.filter((f) => !cancelledChecks.some((c) => c.name === f.name));
                if (genuineFailures.length === 0) {
                  acted = false;
                  standDownReason = `cancelled required check(s): ${outcomes.join("; ")}`;
                  break;
                }
              }
              // W1-T100: the evidence shape follows the SAME `isBlockedCi` predicate the table
              // routed on — a failing review carries the unmet set, a blocked_ci PR carries ci-log
              // evidence, never a mix. W1-T2236: the review branch also carries
              // `actionableGateFailures`. W1-T2231: the dedup gate reads `acted`, never `spent`.
              const fixEvidence = isBlockedCi(pr)
                ? { unmetCriteria: [], ciFailures: ciFailuresForFix }
                : {
                    unmetCriteria: pr.unmetCriteria,
                    actionableGateFailures: pr.actionableGateFailures,
                    instrumentEntangled: pr.instrumentEntangled,
                    instrumentEntanglementPaths: pr.instrumentEntanglementPaths,
                    proofDiscrimination,
                  };
              // W1-T2752 — a delivered terminal decision for this EXACT PR@head is FINAL:
              // `dispatchFix` already declines it internally (W1-T2723's `priorTerminal?.escalated`
              // check), but only after being invoked, so an unmoved head still recorded a phantom
              // `acted:true` on every poll after the one that delivered the escalation. This outer
              // check stands the whole disposition down BEFORE the claim/invocation below —
              // synchronous, read-only, no GitHub call — while a cached entry whose delivery
              // FAILED falls through unchanged, exactly as {@link SweepDeps.terminalFixStandDown}'s
              // own doc requires.
              const terminalStandDown = deps.terminalFixStandDown?.(pr);
              if (terminalStandDown) {
                acted = false;
                standDownReason = terminalStandDown;
                break;
              }
              // W1-T2998 — THE DETERMINISTIC REPAIR IS TRIED FIRST, AND ONLY UNDER THREE CONDITIONS
              // AT ONCE: the operator enabled it, an executor was injected, and every red required
              // check resolved to a registry-declared generator. Placed AFTER the terminal-state
              // pre-flight above and BEFORE `claimFixDispatch` below — ORDER IS LOAD-BEARING: a
              // repair that breaks out AFTER the claim leaks it, because the claim is released by
              // `fixClaim.run` and a repaired PR never reaches that call. Measured as five tests
              // that then saw ZERO dispatches for an unrelated task sharing the claim key.
              //
              // ⚠ ANY FALSY ANSWER FALLS THROUGH TO THE ORDINARY DISPATCH. The executor refuses on
              // anything it did not expect — an unexpected changed path, no change at all, a failed
              // push — and a refusal must cost the PR nothing but this pass. Never a stand-down:
              // the fix rung is still the right instrument when the cheap repair declined.
              const ratchetScripts =
                policy.recordableRatchetRepairEnabled === true && deps.repairRecordableRatchet
                  ? recordableRatchetRepairFor(pr)
                  : undefined;
              if (ratchetScripts && deps.repairRecordableRatchet) {
                const repaired = await deps.repairRecordableRatchet(pr, ratchetScripts);
                if (repaired) {
                  log("sweep.ratchet_repaired", {
                    pr_number: pr.prNumber,
                    head_sha: pr.headSha,
                    scripts: ratchetScripts,
                  });
                  break;
                }
                log("sweep.ratchet_repair_declined", {
                  pr_number: pr.prNumber,
                  head_sha: pr.headSha,
                  scripts: ratchetScripts,
                });
              }
              // W1-T2520 — THE FIX-DISPATCH CLAIM. See {@link claimFixDispatch} for why a claim
              // alone, without the fresh re-read it also performs, would not have stopped the
              // observed race. A refusal spends nothing and stands down like any declined lane.
              const fixClaim = claimFixDispatch(pr);
              if (!fixClaim.ok) {
                acted = false;
                standDownReason = fixClaim.reason;
                break;
              }
              // W1-T2931 — CLAIM THE SHARED HOST SLOT AT THE SPENDING POINT, after every earlier
              // no-worker exit AND after the per-PR mutex. A duplicate in-flight fix must not burn
              // one of this pass's host slots. A host refusal releases that mutex without invoking
              // dispatch, so it spends neither a worker nor a strike.
              const fixAdmission = claimFixAdmission?.(pr);
              if (fixAdmission && !fixAdmission.admitted) {
                fixClaim.release();
                acted = false;
                standDownReason = fixAdmission.reason;
                break;
              }
              // W1-T2379: started either way — only the `await` moves. See `SweepDeps.detachFixWait`.
              if (deps.detachFixWait) {
                detachSweepAction(
                  fixClaim.run(() => deps.dispatchFix(pr, fixEvidence)),
                  { actionKind: "fix-dispatch", taskId: pr.taskId ?? `PR-${pr.prNumber}` },
                );
                break;
              }
              const dispatchOutcome = await fixClaim.run(() => deps.dispatchFix(pr, fixEvidence));
              if (dispatchOutcome !== undefined) spent = dispatchFixSpent(dispatchOutcome);
              break;
            }
            case "conflicted": {
              // W1-T106: the SAME terminal-state pre-flight (W1-T177) as blocked-fixable — never
              // spend a merge-conflict fix strike on a PR that went terminal since the snapshot.
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
              // The "conflicted" row already gated this on the admission predicates, so the
              // dispatch carries merge-conflict evidence and never a mix. W1-T2231: the
              // "conflicted" analogue of the blocked-fixable capture above — both are
              // dispatch-based repair surfaces, so both feed `spent` the same way.
              const conflictedEvidence = { unmetCriteria: [], mergeConflict: pr.mergeConflict };
              // W1-T2752: the conflicted twin of the blocked-fixable terminal check above, same
              // reasoning — see `SweepDeps.terminalFixStandDown`'s own doc.
              const conflictedTerminalStandDown = deps.terminalFixStandDown?.(pr);
              if (conflictedTerminalStandDown) {
                acted = false;
                standDownReason = conflictedTerminalStandDown;
                break;
              }
              // W1-T2520: the conflicted twin of the blocked-fixable claim above, same reasoning
              // — see `claimFixDispatch`'s own doc.
              const conflictedFixClaim = claimFixDispatch(pr);
              if (!conflictedFixClaim.ok) {
                acted = false;
                standDownReason = conflictedFixClaim.reason;
                break;
              }
              // W1-T2931: merge-conflict repair spends the same worker slot as every other fix
              // rung. As above, the task-specific mutex comes first so an in-flight duplicate
              // cannot consume shared capacity; a host refusal releases it without dispatch.
              const conflictedAdmission = claimFixAdmission?.(pr);
              if (conflictedAdmission && !conflictedAdmission.admitted) {
                conflictedFixClaim.release();
                acted = false;
                standDownReason = conflictedAdmission.reason;
                break;
              }
              // W1-T2379: the conflicted twin of the blocked-fixable arm above, same reasoning.
              if (deps.detachFixWait) {
                detachSweepAction(
                  conflictedFixClaim.run(() => deps.dispatchFix(pr, conflictedEvidence)),
                  { actionKind: "fix-dispatch", taskId: pr.taskId ?? `PR-${pr.prNumber}` },
                );
                break;
              }
              const conflictedDispatchOutcome = await conflictedFixClaim.run(() => deps.dispatchFix(pr, conflictedEvidence));
              if (conflictedDispatchOutcome !== undefined) spent = dispatchFixSpent(conflictedDispatchOutcome);
              break;
            }
            case "stale":
              await deps.close(pr, reason);
              break;
            case "refused-escalate":
              await deps.escalate(pr, reason, question!);
              break;
            case "blocked-ambiguous":
              {
                const dirtyFleetRebase = await applyDirtyFleetRebase(pr);
                if (dirtyFleetRebase.handled) {
                  acted = false;
                  standDownReason = dirtyFleetRebase.standDownReason;
                  break;
                }
              }
              // W1-T3422 — the target was already filtered by a terminal required failure's
              // completion time, a newer observed main repair, a declared route, and a bounded
              // no-in-flight workflow read. This final live read closes the head-moved window
              // before the isolated merge or lease-protected push can begin.
              if (staleRedReleaseTarget?.pr.prNumber === pr.prNumber) {
                const target = staleRedReleaseTarget;
                const live = await deps.readLiveState?.(pr);
                if (live?.ok !== true) {
                  acted = false;
                  standDownReason = "stale-red release refused: fresh PR state was unreadable";
                  break;
                }
                const terminal = terminalStateReason(live.state);
                if (terminal) {
                  acted = false;
                  standDownReason = `stale-red release refused: ${terminal}`;
                  break;
                }
                if (live.headSha !== pr.headSha) {
                  acted = false;
                  standDownReason = live.headSha
                    ? `stale-red release refused: head moved from ${pr.headSha} to ${live.headSha}`
                    : "stale-red release refused: fresh head sha was unreadable";
                  break;
                }
                appendLine(deps.ledgerPath, {
                  run_id: deps.runId,
                  task_id: pr.taskId ?? "SWEEP",
                  step: "sweep.stale_red_redrive.attempted",
                  pr_number: pr.prNumber,
                  pr_url: pr.prUrl,
                  head_sha: pr.headSha,
                  main_sha: target.main.sha,
                  main_committed_at: target.main.committedAt,
                  check_name: target.failure.name,
                  failed_completed_at: target.failure.completedAt,
                  local_route: `${target.route.command} ${target.route.args.join(" ")}`,
                });
                let routeResult: IsolatedMergeRouteResult;
                try {
                  routeResult = await deps.runStaleRedLocalRoute!(target);
                } catch (caught) {
                  const error = String((caught as Error)?.message ?? caught);
                  routeResult = { outcome: "source-unreadable", detail: error };
                }
                appendLine(deps.ledgerPath, {
                  run_id: deps.runId,
                  task_id: pr.taskId ?? "SWEEP",
                  step: "sweep.stale_red_redrive.local_route",
                  pr_number: pr.prNumber,
                  pr_url: pr.prUrl,
                  head_sha: pr.headSha,
                  main_sha: target.main.sha,
                  check_name: target.failure.name,
                  outcome: routeResult.outcome,
                  detail: routeResult.detail,
                });
                if (routeResult.outcome !== "passed") {
                  acted = false;
                  standDownReason = `stale-red release declined: local route ${routeResult.outcome} (${routeResult.detail})`;
                  break;
                }
                try {
                  const newHead = await deps.releaseStaleRed!(target);
                  if (!newHead) {
                    acted = false;
                    standDownReason = "stale-red release declined: lease-protected push did not mint a new head";
                    break;
                  }
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: "sweep.stale_red_redrive.released",
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    head_sha: pr.headSha,
                    new_head_sha: newHead,
                    main_sha: target.main.sha,
                    main_committed_at: target.main.committedAt,
                    check_name: target.failure.name,
                    failed_completed_at: target.failure.completedAt,
                    local_route: `${target.route.command} ${target.route.args.join(" ")}`,
                    local_route_outcome: routeResult.outcome,
                  });
                  acted = false;
                  standDownReason =
                    `stale-red release: ${target.failure.name} completed before main repair and passed its declared isolated merge route; ` +
                    `minted ${newHead}`;
                  break;
                } catch (caught) {
                  const error = String((caught as Error)?.message ?? caught);
                  acted = false;
                  standDownReason = `stale-red release declined: lease-protected push failed (${error})`;
                  break;
                }
              }
              // W1-T2789 — an exhausted checks-red PR cannot reach the fix rung's own pre-strike
              // base-gap check, because the table routes it here first. When the shared exact-path
              // decision selected THIS oldest candidate, perform the same update-branch write before
              // escalating; `acted` stays false, so nothing seeds a dedup.
              if (staleBaseReleaseTarget?.pr.prNumber === pr.prNumber) {
                const live = await deps.readLiveState?.(pr);
                if (live?.ok !== true) {
                  log("sweep.red_base_refresh.live_indeterminate", {
                    pr_number: pr.prNumber,
                    head_sha: pr.headSha,
                  });
                } else {
                  const terminal = terminalStateReason(live.state);
                  if (terminal) {
                    acted = false;
                    standDownReason = `stale-base release refused: ${terminal}`;
                    break;
                  }
                  if (live.headSha !== pr.headSha) {
                    acted = false;
                    standDownReason = live.headSha
                      ? `stale-base release refused: head moved from ${pr.headSha} to ${live.headSha}`
                      : "stale-base release refused: fresh head sha was unreadable";
                    break;
                  }
                  const decision = staleBaseReleaseTarget.decision;
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: "sweep.red_base_refresh.attempted",
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    head_sha: pr.headSha,
                    main_tip_sha: staleBaseReleaseTarget.mainTipSha,
                    behind_by: decision.behindBy,
                    matching_base_files: decision.matchingBaseFiles,
                  });
                  staleBaseAttemptedPrNumber = pr.prNumber;
                  try {
                    const outcome = await deps.updateBranch!(pr);
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: outcome === "updated" ? "sweep.update_branch.updated" : `sweep.red_base_refresh.${outcome}`,
                      release_kind: "red-base",
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      main_tip_sha: staleBaseReleaseTarget.mainTipSha,
                      behind_by: decision.behindBy,
                      matching_base_files: decision.matchingBaseFiles,
                    });
                    if (outcome === "updated") {
                      acted = false;
                      standDownReason =
                        `base refresh requested before strike-cap escalation: head was ${decision.behindBy} commit(s) behind ` +
                        `and newer main changed ${decision.matchingBaseFiles.join(", ")}; no strike spent`;
                      break;
                    }
                  } catch (error) {
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: "sweep.red_base_refresh.error",
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      main_tip_sha: staleBaseReleaseTarget.mainTipSha,
                      error: String((error as Error)?.message ?? error),
                    });
                  }
                }
                // A read/write failure remains visible above but never poisons this input: no
                // successful release row exists, so the next pass may retry under the existing
                // GitHub pacer. Preserve today's escalation for this pass below.
              }
              // W1-T196: stand down instead of escalating `task: UNKNOWN` — see
              // `unattributableFiling` above. No escalate call and no issue, but NEVER silent: the
              // stand-down reason names both the PR and the unresolved attribution on this pass's
              // own disposed line.
              const missingTrailerRepair = await applyMissingTaskTrailerRepair(pr);
              if (missingTrailerRepair.handled) {
                acted = false;
                standDownReason = missingTrailerRepair.standDownReason;
                break;
              }
              const absentDecision = absentChecksRepushDecision(
                pr,
                policy,
                now,
                prior.absentRepushes.get(pr.prNumber) ?? { count: 0, shas: new Set<string>() },
              );
              if (!unattributableFiling && absentDecision.repush && deps.repushAbsent) {
                // THE REMEDY, firing INSTEAD OF this pass's escalation. The escalation path is
                // unchanged and the next pass re-derives from the new head: if the fresh sha gets
                // its suites the PR proceeds, and if not, the cap routes it to escalate.
                const oldHead = pr.headSha;
                const newHead = await deps.repushAbsent(pr);
                // LEDGERED, because a fire-and-forget action nobody records becomes invisible
                // state. `appendLine`, NOT `log()` — `log` is an optional narration sink, but
                // `priorActionsFromLedger` READS this step back to enforce the bound. Skipped
                // under --dry-run for the same reason the disposed line is.
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
                // `acted` stays FALSE, and this is load-bearing. `acted:true` on a
                // blocked-ambiguous line feeds `prior.escalated`, so claiming it would tell every
                // later pass this PR was already escalated, and it would then never escalate at
                // all. The re-push is a DIFFERENT action with its own ledger line.
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
                // W1-T473: NEVER await inline — that is exactly the one-at-a-time shape this
                // removes. The key is claimed and the PR queued immediately below, still inside
                // this synchronous switch before any `await` in this iteration.
                deferredReview = true;
              } else {
                acted = false;
                standDownReason = "no postReview dep wired — ungated PR left for the operator lane";
              }
              break;
          }
        } catch (e) {
          acted = false;
          // W1-T529 — DEGRADE, DO NOT RETRY, AND DO NOT CALL IT A FAILURE. A budget floor
          // stand-down means the guarded call was refused BEFORE it ran, so this lane declined
          // rather than failed. Recorded as a stand-down on this PR's own line rather than an
          // `actionError`, so it neither counts in `actionsFailed` nor writes the failure row.
          const floorStandDown = budgetFloorStandDown(e, disposition);
          if (floorStandDown !== undefined) {
            standDownReason = floorStandDown;
          } else {
            actionError = String((e as Error)?.message ?? e);
            // W1-T99 — the canonical crash this fixes: the first live BLOCKED-class escalation's
            // `gh issue create` threw on a missing label and took the WHOLE reconciler down. This
            // PR's own disposed line already carries `action_error`; this is a SEPARATE, distinctly
            // named step so a failed action is grep-able on its own.
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

    // W1-T1000002 — CONVERGE: WITHDRAW WHAT THIS LANE DID NOT ARM. Runs regardless of `acted`,
    // since a held PR always has it false and the action switch never reaches `deps.arm`. A disarm
    // alone is undone by the next pass, whose arming dedup reads GitHub's OWN live armed bit, so
    // the withdrawal must be issued on every pass that still observes hold-stands-and-armed.
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
      // W1-T2771: discovery is not execution and therefore owns no mutex. Carry the stable key into
      // the pool, where `claimReview` atomically claims it immediately before the attempt.
      const reviewKey = reviewOutcomeKeyForPr(pr);
      pendingReviews.push({ index: prIndex, pr, reason, question, reviewKey });
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
      spent,
      baseCausedMainTipSha,
    );
  }

  // ── W1-T1049 — REVIEW CONCURRENCY BUDGET, NOW ITS OWN ───────────────────────
  // Reviews get their OWN ceiling (`policy.reviewLanes`), no longer a SECOND consultation of
  // `policy.dispatchLanes`. That coupling pinned drainage's budget to a dispatch-only ruling and let
  // the two ceilings ADD with nothing naming their sum. Floored at 1. A CEILING, NOT A TARGET.
  // W1-T1218/W1-T2584: ORDER BEFORE THE PULL — GitHub answers newest-first, so slicing by position
  // deferred the same oldest tail every pass.
  const orderedReviews = orderPendingReviews(pendingReviews);
  const reviewLanes = fullReviewLanes ?? effectiveReviewWidth(deps, policy, orderedReviews.length, now, ledgerLines);
  const postReview = deps.postReview;
  let nextReviewIndex = 0;
  let admissionStopReason: string | undefined;

  const closeAdmissions = (reason: string): void => {
    admissionStopReason ??= reason;
  };

  const takeNextReview = (): (typeof orderedReviews)[number] | undefined => {
    if (admissionStopReason !== undefined) return undefined;
    if (deps.continueReviewAdmissions) {
      try {
        if (!deps.continueReviewAdmissions()) {
          closeAdmissions("review admission continuation gate closed — re-derived next pass");
          return undefined;
        }
      } catch (e) {
        // NOT AN ERASING CATCH: the failure text is carried INTO `closeAdmissions` inside a TEMPLATE
        // STRING, which `test/catch-erasure-ratchet.test.ts` has no route to recognise — its routes
        // are a rethrow, a logger call, a `reason:` key, or a comment like this one. The error is
        // preserved verbatim in the stop reason an operator reads, and the gate FAILS CLOSED.
        closeAdmissions(
          `review admission continuation gate failed closed (${String((e as Error)?.message ?? e)}) — re-derived next pass`,
        );
        return undefined;
      }
    }
    const job = orderedReviews[nextReviewIndex];
    if (job === undefined) return undefined;
    nextReviewIndex += 1;
    return job;
  };

  const runReview = async (job: (typeof orderedReviews)[number]): Promise<void> => {
    const claim = claimReview(job.reviewKey);
    if (!claim.ok) {
      finalizeDisposition(
        job.index,
        job.pr,
        "post-review",
        job.reason,
        job.question,
        false,
        claim.deduped,
        undefined,
        claim.reason,
        undefined,
        undefined,
        undefined,
      );
      return;
    }
    const repairCapacity = repairAdmissionTelemetry?.();
    if (deps.repairAdmissionSurface && repairCapacity) {
      log("sweep.review_started", {
        surface: deps.repairAdmissionSurface,
        queue_depth: repairCapacity.queueDepth,
        host_worker_budget: repairCapacity.hostWorkerBudget,
        active_workers: repairCapacity.activeWorkers,
        review_reservations: repairCapacity.reviewReservations,
        fixes_admitted: repairCapacity.fixesAdmitted,
        fixes_refused: repairCapacity.fixesRefused,
        review_began_while_repair_pending: detachedActionInFlight("fix-dispatch"),
        pr_number: job.pr.prNumber,
        head_sha: job.pr.headSha,
      });
    }
      let acted = true;
      let actionError: string | undefined;
      // W1-T529 (iv): set INSTEAD of `actionError` when the throw is a budget floor stand-down —
      // carried onto this PR's own `sweep.disposed` line as `stand_down_reason`.
      let standDownReason: string | undefined;
      try {
        if (postReview) {
          try {
            await postReview(job.pr);
          } catch (e) {
            acted = false;
            // W1-T529 — THE ONE THROW THAT MUST NOT LEAVE A DEDUP KEY. Design (v), the
            // `review.post_refused` arm below, is right about every ORDINARY throw and exactly wrong
            // about this one: a floor stand-down says nothing about this PR, because the guarded
            // call never ran, while `review.post_refused` is read as a VERDICT that ESCALATES
            // unchanged input. THE REPEAT IS STILL BOUNDED, just not by a key: the pacer CONSUMES
            // its trip on the call it refuses.
            const floorStandDown = budgetFloorStandDown(e, "post-review");
            if (floorStandDown !== undefined) {
              standDownReason = floorStandDown;
              // W1-T2584: capacity is provider/account-wide, not a verdict about this PR. Once
              // one worker observes the floor, no worker may pull a later head from this same
              // snapshot. Jobs already admitted may settle; every unstarted key is released below.
              closeAdmissions("review admissions stopped after provider capacity stand-down — re-derived next pass");
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
              // W1-T529/W1-T2753 — THE BOUNDED RETRY KEY. `sweep.action_failed` alone leaves no
              // exact-input outcome key and would retry this throw every pass. This prefix is
              // classified into `reviewRetryableThrows`, not the durable `reviewRefused` set: the
              // latest dated throw suppresses only through the pending ceiling.
              appendLine(deps.ledgerPath, {
                run_id: deps.runId,
                // This row is an outcome key, not only a diagnostic. Fully attributed views use
                // the same task/PR/head/body identity as delivered/refused posts; legacy callers
                // retain the historical empty-task fallback.
                task_id:
                  job.pr.reviewInputDigest !== undefined
                    ? (job.pr.taskId ?? `PR-${job.pr.prNumber}`)
                    : (job.pr.taskId ?? ""),
                step: "review.post_refused",
                head_sha: job.pr.headSha,
                ...(job.pr.reviewInputDigest !== undefined
                  ? { pr_url: job.pr.prUrl, review_input_digest: job.pr.reviewInputDigest }
                  : {}),
                reason: `post-review attempt threw — standing down rather than retrying this head unbounded: ${actionError}`,
              });
            }
          }
        }
      } finally {
        // W1-T513: release the key from the module-level mutex the instant this attempt SETTLES,
        // and BEFORE `finalizeDisposition`, which only ledgers and never gates a future pass. On
        // success `postReview` has already durably written the reviewed state a later pass sees; on
        // failure the row just above establishes a bounded retry clock.
        claim.release();
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
        undefined,
      );
  };

  // W1-T2584 — FIXED-SIZE PULL POOL. At most `reviewLanes` worker promises and that many live
  // effects. Each pull increments the index synchronously before its first await, preserving
  // oldest-first START order even when reviewers settle out of order.
  const workerCount = Math.min(reviewLanes, orderedReviews.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const job = takeNextReview();
        if (job === undefined) return;
        await runReview(job);
      }
    }),
  );

  // Only a named admission stop can leave an unstarted tail. W1-T2771: these jobs were discovered
  // but never pulled, so they own NO mutex key — do not `delete` theirs here, since a concurrent
  // pass may own it for a real active review. Ledger `acted:false` with no outcome key.
  const unstartedReviews = orderedReviews.slice(nextReviewIndex);
  for (const job of unstartedReviews) {
    finalizeDisposition(
      job.index,
      job.pr,
      "post-review",
      job.reason,
      job.question,
      false,
      false,
      undefined,
      admissionStopReason ?? "review admissions stopped — re-derived next pass",
      undefined,
      undefined,
      undefined,
    );
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
  // W1-T520 — the stall report. One line PER STALLED PR naming both facts, and NOTHING when the
  // set is empty. Emitted through `appendLine`, the durable sink, because `log` is an optional hook
  // a caller may leave unwired. This REPORTS the whole set; the lane below ACTS, on one of them.
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
  // W1-T528 — PRESS THE BUTTON. {@link selectUpdateBranchTarget} picks AT MOST ONE PR from the set
  // just reported and, when the dep is wired, requests GitHub update it. Never a loop, and a
  // conflict is REPORTED and skipped rather than retried this pass.
  if (!deps.dryRun && deps.updateBranch) {
    const target = selectUpdateBranchTarget(
      openPrs.filter((pr) => pr.prNumber !== staleBaseAttemptedPrNumber),
      now,
      deps.inFlightTaskIds ?? new Set(),
      deps.staleGateWorkflowsByPr ?? new Map(),
      deps.updatedForWorkflow ?? new Set(),
      deps.behindMainByPr ?? new Map(),
      policy,
    );
    if (target) {
      // W1-T1212: a `StaleGatePr` (never `armedButStalled`'s own shape) carries the ONE extra
      // fact `deps.updatedForWorkflow`'s next read needs to remember this exact pair.
      const staleWorkflow = "staleWorkflow" in target ? (target as StaleGatePr).staleWorkflow : undefined;
      const staleWorkflowFields = staleWorkflow === undefined ? {} : { stale_workflow: staleWorkflow };
      const behindFields = target.behindBy === undefined ? {} : { behind_by: target.behindBy };
      const updateReasonFields = target.updateReason === undefined ? {} : { update_reason: target.updateReason };
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: target.taskId ?? "SWEEP",
        step: "sweep.update_branch.attempted",
        pr_number: target.prNumber,
        pr_url: target.prUrl,
        head_sha: target.headSha,
        ...staleWorkflowFields,
        ...behindFields,
        ...updateReasonFields,
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
          ...behindFields,
          ...updateReasonFields,
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
          ...behindFields,
          ...updateReasonFields,
        });
      }
    }
  }
  // W1-T905 — "repair the instance, FILE THE CLASS": a PURE fold over this pass's own view of
  // `sweep.disposed`, then AT MOST ONE best-effort capture per due surface. Wrapped in the SAME
  // throw containment the action switch has — a capture failure must never fail the pass that
  // produced the repairs it reports on.
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
 * W1-T463 — THE DIAGNOSIS FOR "a light sweep ticks every 60s and a PR still sat green and unreviewed
 * for ~15 minutes". `runSweep`'s loop is SEQUENTIAL and `postReview` materializes a worktree and
 * executes every whitelisted proof, so one slow PR blocked every eligible PR behind it. THE FIX IS
 * SCOPED TO THIS ONE CALLER: every open PR gets its OWN call, fired CONCURRENTLY through the same
 * dedup and ledger path. AN EMPTY PASS STILL GETS EXACTLY ONE CALL, or the per-pass heartbeat would
 * vanish on a quiet tick.
 */
export async function runSweepLightPass(
  openPrs: OpenPrView[],
  deps: SweepDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<SweepSummary[]> {
  if (openPrs.length === 0) return [await runSweep([], deps, policy)];
  // W1-T526/W1-T2792 — THE QUEUE-ADMISSION RULE. The light pass admits at most the existing
  // `reviewLanes` semantic width, never the old hidden hard-coded one. Every other PR's own
  // `deps.actionable` is wrapped so its disposition is still reconciled and its loss attributable.
  const now = deps.now ? deps.now() : Date.now();
  // W1-T2439/W1-T2792: the light pass admits from BOTH lanes — the spawning one at the policy review
  // width, and the non-spawning plan-filing one at its own smaller derived bound. W1-T2583: READ THE
  // LEDGER ONCE FOR SELECTION, BEFORE RANKING; this pass-level fold is only the liveness filter.
  // ledger-read-intent: live — this fold reads the live file only, never rotations.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const selectionLedgerLines = readLedger(deps.ledgerPath);
  const selectionPrior = priorActionsFromLedger(selectionLedgerLines);
  const outcomes: ReviewAdmissionOutcomes = {
    delivered: selectionPrior.reviewDelivered,
    refused: selectionPrior.reviewRefused,
    retryableThrows: selectionPrior.reviewRetryableThrows,
  };
  const queueDepth = reviewAdmissionQueueDepth(openPrs, policy, now, outcomes);
  const activeWorkers = (deps.readActiveWorkerCount ?? activeWorkerCount)();
  const semanticBound = effectiveReviewWidth(deps, policy, queueDepth, now, selectionLedgerLines, activeWorkers);
  const { spawning, planFilings } = selectReviewAdmissions(openPrs, policy, now, outcomes, semanticBound);
  // W1-T2931 — one host budget, with review/merge work served before new repair work. The light
  // pass still reconciles every PR concurrently; only the expensive fix-dispatch spending point
  // claims from this shared pool. `activeWorkerCount` is the same process-wide counter the adaptive
  // review controller reads, and selected spawning reviews reserve their width before fixes race.
  const hostWorkerBudget = policy.reviewCapacity.hostWorkerBudget;
  const reviewReservations = spawning.length;
  const repairAdmission = createSweepFixAdmissionController({
    surface: "light",
    queueDepth,
    hostWorkerBudget,
    activeWorkers,
    reviewReservations,
    log: deps.log,
  });
  const claimFixAdmission = repairAdmission.claim;
  const selectedNumbers = new Set<number>([
    ...spawning.map((p) => p.prNumber),
    ...planFilings.map((p) => p.prNumber),
  ]);
  // Known outcome-deduped heads did not compete for either bound, but must still pass through
  // `runSweep`'s action-time guard so their own row says DELIVERED or REFUSED rather than falsely
  // claiming they lost an admission. This never dispatches a review.
  const outcomeDedupedNumbers = new Set(
    openPrs
      .filter((pr) =>
        deriveDisposition(pr, policy, now).disposition === "post-review" &&
        reviewAdmissionOutcomeKnown(pr, outcomes, policy, now))
      .map((pr) => pr.prNumber),
  );
  const admittedNumbers = spawning.map((p) => `#${p.prNumber}`).join(", ");
  return Promise.all(
    openPrs.map((pr) => {
      const baseActionable = deps.actionable;
      const baseStandDownReasonFor = deps.standDownReasonFor;
      // W1-T2379: `detachFixWait` is set on EVERY forwarded shape, admitted or not — the tick this
      // pass runs inside is awaited whichever PR won the post-review admission, so the fix rung's
      // CI wait must leave the await on both branches.
      const scopedDeps: SweepDeps =
        selectedNumbers.has(pr.prNumber) || outcomeDedupedNumbers.has(pr.prNumber)
          ? {
              ...deps,
              detachFixWait: true,
              repairAdmissionSurface: "light",
              repairAdmissionTelemetry: repairAdmission.snapshot,
              selectAdaptiveReviewWidth: undefined,
              claimFixAdmission,
            }
          : {
              ...deps,
              detachFixWait: true,
              repairAdmissionSurface: "light",
              repairAdmissionTelemetry: repairAdmission.snapshot,
              selectAdaptiveReviewWidth: undefined,
              claimFixAdmission,
              actionable: (d) => (d === "post-review" ? false : baseActionable ? baseActionable(d) : true),
              // W1-T2426: name the mechanism, not just the fact. A `post-review` refused HERE was
              // eligible and lost this pass's bounded admission — a different event from a lane the
              // light pass never runs, and both used to write the same sentence.
              standDownReasonFor: (d) =>
                d === "post-review"
                  ? (pr.isPlanFiling === true
                      ? `not admitted this pass: at most ${policy.planFilingAdmissionBound} plan-filing ` +
                        "post-review admissions per light pass"
                      : `not admitted this pass: semantic post-review admission bound ${semanticBound}` +
                        (admittedNumbers ? `; admitted ${admittedNumbers} ahead` : ""))
                  : baseStandDownReasonFor?.(d),
            };
      return runSweep([pr], scopedDeps, policy);
    }),
  );
}

/** Outcome keys already known, before admission, to make the action-time review guard stand down. */
export interface ReviewAdmissionOutcomes {
  delivered: ReadonlySet<string>;
  refused: ReadonlySet<string>;
  /** W1-T2753: optional for compatibility with callers predating timed throw backoff. */
  retryableThrows?: ReadonlyMap<string, number | undefined>;
}

const EMPTY_RETRYABLE_REVIEW_THROWS = new Map<string, number | undefined>();

const EMPTY_REVIEW_ADMISSION_OUTCOMES: ReviewAdmissionOutcomes = {
  delivered: new Set<string>(),
  refused: new Set<string>(),
  retryableThrows: EMPTY_RETRYABLE_REVIEW_THROWS,
};

function reviewAdmissionOutcomeKnown(
  pr: OpenPrView,
  outcomes: ReviewAdmissionOutcomes,
  policy: SweepPolicy,
  now: number,
): boolean {
  const key = reviewOutcomeKeyForPr(pr);
  return (
    outcomes.delivered.has(key) ||
    outcomes.refused.has(key) ||
    retryableReviewThrowBackoffReason(outcomes.retryableThrows ?? EMPTY_RETRYABLE_REVIEW_THROWS, key, policy, now) !==
      undefined
  );
}

/** W1-T526 — WHICH OPEN PRS the light pass admits into `post-review`. Branch protection's `strict`
 *  setting means only ONE open PR can merge before every other reads `behind`, and that PR's next
 *  push mints a NEW head, discarding the sha-pinned verdict — so unbounded fan-out cost
 *  N + (N-1) + … + 1 reviews to land N merges. OLDEST-HEAD-FIRST CANNOT STARVE: head age is monotone. */
export function selectReviewAdmission(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
): OpenPrView | undefined {
  return selectReviewAdmissions(openPrs, policy, now).spawning[0];
}

/** W1-T2439 — THE SPLIT ADMISSION, AND WHY THE PREDICATE IS `isPlanFiling` AND NOT THE REVIEW'S
 *  OUTCOME: the outcome is written AFTER the review runs, so this function cannot see it. TWO LANES,
 *  AND ONLY ONE CAN SPAWN — every PR not flagged a plan filing, at the configured review width, and
 *  plan filings, at {@link SweepPolicy.planFilingAdmissionBound}. FAIL-OPEN: `undefined` is SPAWNING. */
export function selectReviewAdmissions(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  outcomes: ReviewAdmissionOutcomes = EMPTY_REVIEW_ADMISSION_OUTCOMES,
  reviewWidth: number = Math.max(1, policy.reviewLanes),
): { spawning: OpenPrView[]; planFilings: OpenPrView[] } {
  // W1-T2583: selection and execution must agree on outcome-keyed eligibility, so the caller folds
  // both sets once from the same reader `runSweep` uses and filters here before either lane ranks.
  // The action-time lookup stays in `runSweep` as the boundary for a verdict racing this snapshot.
  const eligible = openPrs.filter((pr) =>
    deriveDisposition(pr, policy, now).disposition === "post-review" &&
    !reviewAdmissionOutcomeKnown(pr, outcomes, policy, now));
  const filings = eligible.filter((pr) => pr.isPlanFiling === true);
  const rest = eligible.filter((pr) => pr.isPlanFiling !== true);

  const oldestFirst = (a: OpenPrView, b: OpenPrView): number => {
    const ka = Date.parse(reviewAdmissionKey(a));
    const kb = Date.parse(reviewAdmissionKey(b));
    const aa = Number.isNaN(ka) ? -Infinity : now - ka;
    const ab = Number.isNaN(kb) ? -Infinity : now - kb;
    return ab !== aa ? ab - aa : a.prNumber - b.prNumber;
  };

  // The cheap lane, oldest-first on the SAME immutable key, truncated at its own bound. Sorting
  // by the key rather than repeatedly calling `oldestByKey` keeps one ordering definition.
  const bound = Math.max(0, policy.planFilingAdmissionBound);
  const planFilings = [...filings]
    .sort(oldestFirst)
    .slice(0, bound);

  const spawning = [...rest].sort(oldestFirst).slice(0, Math.max(1, reviewWidth));
  return { spawning, planFilings };
}

/** Number of spawning review candidates before the adaptive admission cut. */
function reviewAdmissionQueueDepth(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  outcomes: ReviewAdmissionOutcomes,
): number {
  return openPrs.filter((pr) =>
    pr.isPlanFiling !== true &&
    deriveDisposition(pr, policy, now).disposition === "post-review" &&
    !reviewAdmissionOutcomeKnown(pr, outcomes, policy, now)
  ).length;
}

/** W1-T2426 — THE ADMISSION KEY, AND WHY IT IS NOT {@link OpenPrView.lastActivityAt}.
 *  {@link selectReviewAdmission} argues oldest-first cannot starve because nothing un-ages a head.
 *  THAT PREMISE IS FALSE FOR THE WINNER: POSTING A VERDICT IS ITSELF AN UPDATE. {@link
 *  orderPendingReviews} already ranks on the IMMUTABLE `createdAt`, and since `updatedAt >=
 *  createdAt` the fallback can only UNDER-rank. // Why: docs/forensics/sweep.md. */
export function reviewAdmissionKey(pr: Pick<OpenPrView, "createdAt" | "lastActivityAt">): string {
  const created = pr.createdAt;
  if (created !== undefined && created !== "" && !Number.isNaN(Date.parse(created))) return created;
  return pr.lastActivityAt;
}

/** THE OLDEST-HEAD-FIRST COMPARATOR ITSELF, lifted out of {@link selectReviewAdmission} so
 *  W1-T528's disjoint `update-branch` selection CONSUMES it rather than shipping a second ordering
 *  that could silently disagree. Byte-identical logic to what that function always ran — see its
 *  doc for the starvation argument, which applies to any `{prNumber, lastActivityAt}` population. */
export function oldestActivityFirst<T extends { prNumber: number; lastActivityAt: string }>(
  candidates: readonly T[],
  now: number,
): T | undefined {
  return oldestByKey(candidates, now, (c) => c.lastActivityAt);
}

/** W1-T2426 — THE RANKING ITSELF, with the key supplied by the caller. ONE IMPLEMENTATION, TWO KEYS,
 *  DELIBERATELY NOT TWO COMPARATORS: extracting the key keeps the shared-ordering guarantee, so the
 *  tie-break, the `-Infinity` treatment of an unparseable date, and the strict `>` that makes the
 *  FIRST maximal candidate win are defined exactly once. {@link oldestActivityFirst} is UNCHANGED,
 *  and remains correct for `update-branch`, where an advancing `updatedAt` is the right key. */
function oldestByKey<T extends { prNumber: number }>(
  candidates: readonly T[],
  now: number,
  keyOf: (candidate: T) => string,
): T | undefined {
  let winner: T | undefined;
  let winnerAgeMs = -Infinity;
  for (const candidate of candidates) {
    const pushedAt = Date.parse(keyOf(candidate));
    const ageMs = Number.isNaN(pushedAt) ? -Infinity : now - pushedAt;
    if (!winner || ageMs > winnerAgeMs || (ageMs === winnerAgeMs && candidate.prNumber < winner.prNumber)) {
      winner = candidate;
      winnerAgeMs = ageMs;
    }
  }
  return winner;
}

/**
 * W1-T3027 — EVERY disposition, in a fixed order, so the counts SUM TO `total`.
 *
 * The five this line used to name are a SUBSET of the eight {@link Disposition} holds, and the
 * three it omitted — `post-review`, `dep-review`, `wait` — are where a healthy board mostly SITS.
 * MEASURED 2026-09-07 against the live repo: `rmd sweep --dry-run` reported "11 open PR(s) · 0
 * action(s) taken · mergeable 0 · blocked-fixable 2 · conflicted 0 · stale 0 · blocked-ambiguous 0".
 * Every number there is true and the line still cannot be read: nine of eleven PRs are in no bucket
 * it prints, and an operator asking "is the review lane running, or has it stalled?" — the question
 * this repo's own recurring `remudero-review` stall makes people ask — gets no answer from the one
 * summary the verb emits.
 *
 * The same shape CLAUDE.md already names for `lint-plan`: a technically-true aggregate that
 * misleads by omission. A reader cannot tell a subset from a total without being told which it is,
 * so the fix is to print all of them and let the arithmetic be checkable.
 */
const DISPOSITION_RENDER_ORDER: readonly Disposition[] = [
  "mergeable",
  "blocked-fixable",
  "refused-escalate",
  "conflicted",
  "stale",
  "blocked-ambiguous",
  "dep-review",
  "post-review",
  "wait",
];

/** One-line human render of a sweep summary, for both callers' console output. */
export function renderSweepSummary(s: SweepSummary): string {
  const b = s.byDisposition;
  const counts = DISPOSITION_RENDER_ORDER.map((d) => `${d} ${b[d]}`).join(" · ");
  // The buckets now cover every disposition, so anything left over is a counting defect rather than
  // a rendering choice — say so instead of letting the reader do the subtraction and wonder.
  const summed = DISPOSITION_RENDER_ORDER.reduce((n, d) => n + b[d], 0);
  const residual = s.total - summed;
  return (
    `sweep: ${s.total} open PR(s) · ${s.actionsTaken} action(s) taken · ${counts}` +
    (s.actionsFailed > 0 ? ` · ⚠️ ${s.actionsFailed} action(s) FAILED (see sweep.action_failed)` : "") +
    (s.noneCount > 0 ? ` · ⚠️ ${s.noneCount} UNDISPOSED (invariant violated)` : "") +
    (residual !== 0 ? ` · ⚠️ ${residual} UNACCOUNTED (dispositions do not sum to the open count)` : "")
  );
}

// ── W1-T121 — THE QUEUE GOVERNOR (the 23-open-PR incident) ───────────────────────────────────
//
// No backpressure existed anywhere in the pipeline, so authoring rate converted DIRECTLY into queue
// depth. Little's law is the argument: throughput comes from BOUNDING WIP. ASYMMETRY IS THE WHOLE
// DESIGN: {@link checkQueueGovernor} is consulted ONLY on the NEW-task dispatch path, NEVER by
// `runSweep`, which drains already-open PRs at ANY depth. // Why: docs/forensics/sweep.md.

/** {@link checkQueueGovernor}'s verdict for one dispatch-path consultation. */
export interface QueueGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new PR this pass. */
  deferred: boolean;
  /** The open-PR count the decision was made against. */
  observedOpenCount: number;
  /** The policy limit consulted (`policy.wipLimit`, carried for the ledger line). */
  wipLimit: number;
}

/** The queue governor's pure predicate: at or above `policy.wipLimit` open PRs, NEW dispatch is
 *  deferred; below it, dispatch proceeds. THRESHOLDS ARE POLICY DATA (rule 2) — that field is the
 *  ONLY thing that moves this decision. Never call this from `runSweep` or any of its deps; see
 *  the asymmetry note above. */
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

/** A throttled pass is NOT silent: the dispatch path calls this exactly when
 *  {@link checkQueueGovernor} defers, writing one ledger line carrying the observed open count — so
 *  a quiet daemon with nothing runnable stays distinguishable from a THROTTLED one. */
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

// ── W1-T148 — THE COST GOVERNOR (the $206/60-run spin-loop incident) ─────────────────────────
//
// A spin loop burned roughly $206 over 60 runs with no DAILY ceiling anywhere: every run stayed
// safely under its own per-run cap, so that backstop never fired. The architectural TWIN of the queue
// governor above — a WIP limit bounds intake by COUNT, this by DOLLARS. Same asymmetry, because
// throttling drainage would strand in-flight work to save money.

/** Sums ONE ledgered dollar figure per RUN, for every run with at least one line inside the window,
 *  then totals them. {@link deriveDayCostUsd} and {@link deriveWeekCostUsd} are both this ONE
 *  reduction over a different window. PER-RUN, NOT PER-LINE, WHICH AVOIDS DOUBLE-COUNTING: a run's
 *  `verdict` line, or absent one its first cost-bearing line, already carries its RUNNING TOTAL. */
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

// W1-T2895: `utcDayWindowMs`/`utcWeekWindowMs` moved to the leaf module `time-window.ts` — this
// was the `retro.ts` -> `sweep.ts` edge in the `cost-anomaly.ts -> retro.ts -> sweep.ts` cycle.
// Re-exported here unchanged for `deriveDayCostUsd`/`deriveWeekCostUsd` below and for `glance.ts`.
export { utcDayWindowMs, utcWeekWindowMs } from "./time-window.js";
import { utcDayWindowMs, utcWeekWindowMs } from "./time-window.js";

/** The day's ledgered cost — `now`'s UTC calendar day, per-run (see {@link deriveWindowCostUsd}).
 *  BEHAVIOR UNCHANGED from this function's pre-W1-T159 form: same window, same verdict-preferred
 *  per-run reduction, so {@link checkCostGovernor}'s call site sees byte-identical results. */
export function deriveDayCostUsd(lines: ReadonlyArray<Record<string, unknown>>, now: number): number {
  const [start, end] = utcDayWindowMs(now);
  return deriveWindowCostUsd(lines, start, end);
}

/** The WEEK-TO-DATE ledgered cost (W1-T159): the current UTC ISO week, same per-run reduction as
 *  {@link deriveDayCostUsd}. The GLANCE strip's own falsifier is why this exists beside the day
 *  figure — a daily-only figure cannot answer whether today is normal, since a modest post-merge
 *  burn is only legible against a weekly baseline. */
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

/** The cost governor's pure predicate: at or over `policy.dailyCostCeilingUsd` ledgered dollars spent
 *  today, NEW dispatch is deferred. THRESHOLDS ARE POLICY DATA (rule 2), and this is never called
 *  from `runSweep`. W1-T331: `policy` is a per-call argument, and the bug was that every real caller
 *  omitted it and took the default parameter, captured once at import. */
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

/** A throttled pass is NOT silent: the dispatch path calls this exactly when
 *  {@link checkCostGovernor} defers, writing one ledger line naming the day-cost and ceiling — so a
 *  quiet daemon stays distinguishable from a BUDGET-THROTTLED one. */
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

// ── W1-T1038 — THE MEMORY GOVERNOR (the 2026-08-19 host stall) ───────────────────────────────
//
// Dispatch has priced every draw in dollars and in turns, and never once in bytes. The host went
// unreachable with three workers live and NOTHING WAS KILLED — a measured absence of every OOM
// signature. THE ONE DELIBERATE ASYMMETRY WITH ITS TWO SIBLINGS: those are composed FAIL-CLOSED,
// where an unreadable reading counts as over ceiling. THIS GOVERNOR'S UNREADABLE CASE MUST NOT JOIN
// THAT ARM — refusing dispatch on every `/proc/meminfo` hiccup would convert a once-in-six-days
// event into a total outage. FAIL OPEN. // Why: docs/forensics/sweep.md.

/** {@link checkMemoryGovernor}'s verdict for one dispatch-path consultation. */
export interface MemoryGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new run this pass. */
  deferred: boolean;
  /** The observed `MemAvailable` (MiB, read from `/proc/meminfo` — NEVER a cgroup limit; design
   *  note (6): this fleet's containers carry no memory limit, so a cgroup read reports
   *  "unbounded" and would authorise every dispatch silently). */
  observedAvailableMib: number;
  /** The policy floor consulted (`policy.memoryFloorMib`, carried for the ledger line). */
  floorMib: number;
}

/** The memory governor's pure predicate: STRICTLY BELOW `policy.memoryFloorMib` available, NEW
 *  dispatch is deferred. Same shape and the SAME dispatch-only asymmetry as its two siblings. SHIPS
 *  INERT: the floor defaults to 0 and the observation can never be negative, so this never defers
 *  until an operator raises the floor against a figure not yet measured. DEFER, NEVER KILL. */
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

/** THE OBSERVATION IS LEDGERED ON EVERY CONSULTATION — unlike the two deferral loggers above, this
 *  ledgers unconditionally, admitted readings included: a deferral-only row would sample exactly the
 *  population that never happens while the floor ships disabled. NOT registered in `ledger.ts`'s
 *  decision-relevant set, because nothing reads this step back yet — THE READER IS THE OPERATOR.
 *  Written WITHOUT the literal comparison expression, because test/ledger-rotation.test.ts derives
 *  that set by scanning this file's TEXT, comments included. */
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

/** How many CONSECUTIVE `sweep.post_review.failed` lines — with no intervening `.done` — mean the
 *  post-review path has STALLED rather than hiccupped. DERIVED FROM THE LEDGER, NOT PICKED: the
 *  observed transient maximum is 5 and the observed stall is 77, with NO observation between, so 8
 *  sits inside an empty gap. Raise this only against new data. */
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
  /** The run's error text with digit runs replaced by `<N>`. NORMALISATION IS LOAD-BEARING: the
   *  observed failures carried ten distinct raw strings and exactly ONE normalised string, because
   *  the text embeds the PR number. Grouping on the RAW text would split one systematic stall into
   *  ten unrelated-looking groups. */
  normalisedError?: string;
  /** True when every failure in the run is an API quota exhaustion, carried so the escalation can
   *  say so — a quota failure is fleet-stopping but self-clearing at a known reset, which asks
   *  something different of an operator. It deliberately does NOT gate `stalled`: gating on a
   *  recognised error string would blind the detector to every other one. */
  rateLimited: boolean;
}

/** Digit runs → `<N>`, so a per-PR error text collapses to one group. See `normalisedError`. */
function normaliseErrorText(s: string): string {
  return s.replace(/\d+/g, "<N>");
}

/** Is the sweep's post-review path stalled? Pure over ledger lines, oldest-first. THE DEFECT THIS
 *  EXISTS FOR: `sweep.post_review.failed` had fired dozens of times across a week — every one a rate
 *  limit — and NOTHING SURFACED IT until an operator found it by hand. COUNTS THE CURRENT RUN ONLY,
 *  since a lifetime count would latch permanently after the first bad day. */
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

// ── W1-T150 — THE LEVEL-TRIGGERED CREDIT BACKFILL rung (ratifies P30) ────────────────────────
//
// The same P22 argument applied to the MERGE EVENT rather than open-PR pipeline state. A run's
// terminal `verdict` line is EDGE-TRIGGERED at run-end, so a run that ends before its OWNED PR merges
// never revisits the question and the ledger's per-task credit can sit wrong forever. This rung
// re-derives fresh every poll, the same way `runSweep` closes the open-PR gap.

/** One task's observed merge-credit candidacy. `merged` is the CALLER's ownership-asserted,
 *  trailer-anchored verdict, since this module never talks to GitHub: true only when a MERGED PR is
 *  owned by this task's own `run-<taskId>-*` branch and carries its anchored trailer, for any run of
 *  the task. The backfill must NEVER fire on less than an observed merge — that is the falsifier. */
export interface CreditCandidate {
  taskId: string;
  prNumber: number;
  prUrl: string;
  merged: boolean;
  /** W1-T3063 — did the CREDITING pr actually implement the task, or merely cite it? `undefined`
   *  means UNKNOWN and is treated exactly like `false` by every destructive consumer: absence of
   *  evidence is not evidence of supersession. Derived from the merge subject against the same
   *  filing vocabulary `lint-plan` already excludes ("a filing cites a task; it does not implement
   *  it"), never from a second list. Why: #4461, a validated build, was closed against #3195, a
   *  `chore(plan)` touching one shard. */
  creditIsImplementation?: boolean;
}

/** One task's credit-backfill outcome this pass. */
export interface CreditBackfillResult {
  taskId: string;
  prNumber: number;
  prUrl: string;
  /** True ⇒ a NEW `verdict.merged` correction was appended this pass. */
  corrected: boolean;
  /** True ⇒ the ledger already carried merge credit OR a durable backfill receipt suppressed it. */
  alreadyCredited: boolean;
  /** True ⇒ a durable receipt from an earlier completed pass suppressed this candidate. */
  durablyBackfilled: boolean;
}

/** The whole credit-backfill pass's outcome. */
export interface CreditBackfillSummary {
  total: number;
  corrected: number;
  results: CreditBackfillResult[];
  /**
   * W1-T3019 — WAS THE "NOT CREDITED" ANSWER PROVEN, OR JUST NOT FOUND YET?
   *
   * {@link readMergeCreditedTaskIds} already returns `complete`, and this rung discarded it. The
   * walk stops at {@link CREDIT_SCAN_MAX_ROTATIONS} rotations; when it runs out with candidates
   * still unresolved it reports `complete: false`, and its own doc says those "get re-credited".
   * A correction taken on an UNPROVEN absence is the re-credit loop the module header describes as
   * closed — so the distinction has to be measurable before anyone can say whether it is.
   */
  creditScanComplete: boolean;
  /**
   * TRUE when the walk stopped because it ran out of BUDGET rather than out of CORPUS — i.e. it
   * opened the cap's worth of files and still had candidates outstanding. This, not
   * `creditScanComplete`, is the churn discriminator: `complete` is false for a genuinely NEW
   * merge too (nothing has credited it yet, so it never resolves), and crediting that one is the
   * rung working correctly.
   */
  creditScanExhaustedBudget: boolean;
  /** Files the credit walk opened (live + rotations). Diagnostic only — see the discriminator's
   *  own note for why this count cannot decide whether the budget was exhausted. */
  creditScanFilesRead: number;
  /**
   * Candidates whose credit state is UNKNOWN — not found, on a walk that ran out of BUDGET. Always
   * 0 when the walk exhausted the corpus instead, because reading every file and finding nothing IS
   * a proven absence. A correction counted here was written without proof that the task was
   * uncredited, and is the re-credit loop if it repeats for the same task.
   */
  creditScanUnknown: number;
  /** Candidates suppressed by a durable backfill receipt. Summary-only so the fixed path remains
   * measurable without restoring the old per-candidate log loop. */
  durableReceiptSuppressions: number;
}

/** Credit-backfill-specific persistence seams. Production shares the existing atomic credit store;
 * tests can make append/write ordering and the load-bearing lookup directly observable. */
export type CreditBackfillDeps = Pick<
  SweepDeps,
  "ledgerPath" | "runId" | "readLedger" | "appendLine" | "log" | "dryRun"
> & {
  creditStorePath?: string;
  readCreditStore?: () => CreditStore;
  writeCreditStore?: (store: CreditStore) => void;
};

/*
 * `hasMergeCredit` USED TO LIVE HERE and was removed 2026-08-13. It answered "has this task's merge
 * already been credited" over an array read with `readLedgerLines`, WHICH OPENS EXACTLY ONE FILE —
 * and that single-file read was the defect: rotation caps a step, so older credit left the live file
 * and the same tasks were re-credited forever. `readMergeCreditedTaskIds` (status.ts) now answers
 * across all three ledger forms, still keyed on `task_id` ALONE, because ANY run of this task
 * recording a merge counts.
 */

/** THE CREDIT-BACKFILL RUNG (W1-T150). For every candidate whose OWNED PR is `merged` but whose
 *  ledger carries no credit yet, append EXACTLY ONE `verdict.merged` correction naming the PR. A
 *  candidate whose PR is not merged is always a no-op, and a repeat pass appends nothing further:
 *  `alreadyCredited` is recomputed per candidate against the snapshot PLUS this pass's own
 *  corrections, so two candidates naming one task still credit exactly once. A SEPARATE entry point
 *  from {@link runSweep}, whose input domain is one view per OPEN PR. */
export async function runCreditBackfill(
  candidates: CreditCandidate[],
  deps: CreditBackfillDeps,
): Promise<CreditBackfillSummary> {
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const creditStorePath = deps.creditStorePath ?? defaultCreditStorePath(deps.ledgerPath);
  const creditStoreAtStart = deps.readCreditStore?.() ?? loadCreditStore(creditStorePath);
  const writeCreditStore = deps.writeCreditStore ?? ((store: CreditStore) => saveCreditStore(creditStorePath, store));

  // THE CREDIT QUESTION IS "EVER", AND ONE FILE CANNOT ANSWER IT. This used to read
  // `readLedgerLines`, which opens exactly ONE path, against a step whose rows rotation caps. Credit
  // older than the cap left the live file, this check said "not credited", the task was re-credited,
  // and the fresh row evicted another — self-sustaining. // Why: docs/forensics/sweep.md.
  // W1-T3019: `complete` and `filesRead` are CARRIED, not discarded. See CreditBackfillSummary's
  // own doc — an unfinished walk's "not credited" is an absence of evidence. W1-T3223 does not
  // branch on that absence either: only the separate durable proof that THIS WRITER already
  // appended may suppress it, so a genuinely new merge still receives its first correction.
  const creditScan = readMergeCreditedTaskIds(deps.ledgerPath, {
    // Only the tasks this pass could ask about, so the walk stops as soon as they are all resolved
    // rather than reading to the cap. Measured: real plan ids resolve below depth 8.
    candidates: candidates.map((c) => c.taskId),
    readLive: deps.readLedger,
  });
  const credited = creditScan.credited;
  // Computed BEFORE the loop's own `credited.add`, so this counts what the WALK could not prove,
  // never what this pass then corrected.
  // THE DISCRIMINATOR IS THE BUDGET, NOT `complete`. `complete` is false whenever ANY candidate is
  // unresolved — including a brand-new merge nothing has credited yet, which this rung exists to
  // credit. Only a walk that left files unopened has an absence it did not prove.
  //
  // READ FROM THE WALK, never re-derived from `filesRead` — that test was wrong in BOTH directions
  // (measured): a corpus of exactly `cap` rotations, and a walk resolving its last candidate ON the
  // final rotation, both reach `cap + 1` without the budget binding; and a corrupt rotation spends
  // a slot without incrementing the count, hiding a genuinely exhausted walk.
  const creditScanExhaustedBudget = creditScan.budgetExhausted;
  const creditScanUnknown = creditScanExhaustedBudget ? candidates.filter((c) => !credited.has(c.taskId)).length : 0;

  const results: CreditBackfillResult[] = [];
  let corrected = 0;
  let durableReceiptSuppressions = 0;
  const receiptsToPersist: Array<{ taskId: string; receipt: CreditBackfillReceipt }> = [];

  for (const c of candidates) {
    // Only a receipt that existed BEFORE this pass is a durable suppression. A duplicate candidate
    // later in this array is suppressed by `credited.add` below and must not inflate this metric.
    const durablyBackfilled = hasCreditBackfillReceipt(creditStoreAtStart, c.taskId);
    const alreadyCredited = credited.has(c.taskId) || durablyBackfilled;
    const shouldCorrect = c.merged && !alreadyCredited;
    const acted = shouldCorrect && !deps.dryRun;

    if (c.merged && durablyBackfilled) durableReceiptSuppressions++;

    if (acted) {
      // ORDERING INVARIANT: append first. A false receipt can hide real merge credit; a missing
      // receipt can only cause an at-least-once duplicate after a crash or best-effort save failure.
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: c.taskId,
        step: "verdict.merged",
        verdict: "merged",
        pr_number: c.prNumber,
        pr_url: c.prUrl,
        source: "sweep.credit_backfill",
      });
      receiptsToPersist.push({
        taskId: c.taskId,
        receipt: { source: "sweep.credit_backfill", prUrl: c.prUrl, prNumber: c.prNumber },
      });
      // Reflected into THIS pass's own view, not just re-read on the next sweep, so a duplicate
      // candidate naming the same task later in the same array credits exactly once.
      credited.add(c.taskId);
      corrected++;
    }

    // LOG ONLY WHAT WAS ACTED ON. This ran once per candidate per sweep, and the daemon sweeps
    // every poll, so a backfill correcting nothing wrote a line per already-credited task forever.
    // The ledger is the provenance spine and its SIZE is a read cost charged to every reader. The
    // summary still reports `total` on every pass, so COVERAGE stays observable.
    if (acted) {
      log("sweep.credit_backfill", {
        task_id: c.taskId,
        pr_number: c.prNumber,
        pr_url: c.prUrl,
        corrected: acted,
        already_credited: alreadyCredited,
        // W1-T3019: false ⇒ this correction was written on an absence the walk never proved. A row
        // repeating for one task with this false is the re-credit loop, naming itself.
        credit_scan_complete: creditScan.complete,
        credit_scan_exhausted_budget: creditScanExhaustedBudget,
      });
    }

    results.push({
      taskId: c.taskId,
      prNumber: c.prNumber,
      prUrl: c.prUrl,
      corrected: acted,
      alreadyCredited,
      durablyBackfilled,
    });
  }

  // One atomic best-effort store write per COMPLETED pass, never one fsync per candidate. Dry-run
  // queues no receipts because `acted` is false. If append throws, control never reaches this save.
  if (receiptsToPersist.length > 0) {
    const nextStore = receiptsToPersist.reduce(
      (store, pending) => recordCreditBackfillReceipt(store, pending.taskId, pending.receipt),
      creditStoreAtStart,
    );
    writeCreditStore(nextStore);
  }

  const summary: CreditBackfillSummary = {
    total: candidates.length,
    corrected,
    results,
    creditScanComplete: creditScan.complete,
    creditScanExhaustedBudget,
    creditScanFilesRead: creditScan.filesRead,
    creditScanUnknown,
    durableReceiptSuppressions,
  };
  log("sweep.credit_backfill.summary", {
    total: summary.total,
    corrected: summary.corrected,
    // W1-T3019 — the three figures that say whether `corrected` is repair or churn.
    credit_scan_complete: summary.creditScanComplete,
    credit_scan_exhausted_budget: summary.creditScanExhaustedBudget,
    credit_scan_files_read: summary.creditScanFilesRead,
    credit_scan_unknown: summary.creditScanUnknown,
    durable_receipt_suppressions: summary.durableReceiptSuppressions,
  });
  return summary;
}

// ── ESCALATION-LIFECYCLE RECONCILER (fb-1784756088300-6a481e) ────────────────────────────────
//
// The sweep RAISES needs-human issues but nothing ever CLOSED them when the blocker resolved, so the
// large majority of open ones were stale. This is the missing third leg — creation, dedup, CLOSURE
// here — riding the SAME level-triggered doctrine as the credit backfill above. A referent is
// TERMINAL, and the escalation auto-closes naming the resolution, when it MERGED or CLOSED WITHOUT
// MERGING. Bounded per cycle, each close ledgered.

/** How many stale escalations one reconcile pass may close — bounds the write burst so a large
 *  backlog (the observed 94-open shape) drains across several sweeps, never one. */
export const MAX_ESCALATION_CLOSES_PER_CYCLE = 20;

/** QUEUE LABELS this reconciler retires issues from (W1-T349): `needs-human` plus `fleet-notice`. A
 *  residual-escalation-judge demotion leaves the NEEDS ME board, which keys on `needs-human`, but
 *  the design's promise — "recovery is relabelling, nothing is deleted" — only holds if THIS
 *  reconciler can still find and retire it. */
export const RETIRABLE_ESCALATION_LABELS: readonly string[] = [NEEDS_HUMAN_LABEL, FLEET_NOTICE_LABEL];

/** List every OPEN issue across {@link RETIRABLE_ESCALATION_LABELS}, deduped by issue number. Same
 *  fail-soft contract as a single listing: a read failure on ANY label aborts the WHOLE list, never
 *  a partial result a caller could mistake for "nothing else is open". */
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
  /** W1-T347: the ask-type classification for this issue, when the caller can supply it from the
   *  issue's own label. `"question"` routes a terminal-referent close through
   *  {@link renderMootedCloseComment}; `"action"` or omitted — the untyped legacy corpus — keeps
   *  today's close path byte-identical. */
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
  /** What the candidate BUILDER saw on intake, so the summary can distinguish "nothing was open"
   *  from "everything open was dropped". Optional and defaulted: a caller that omits it gets
   *  exactly the line it got before, never a crash and never a fabricated zero. */
  intake?: { issuesSeen: number; droppedNoTaskTrailer: number; droppedNoReferent: number };
}

/** The closing citation posted on a reconciled issue — NAMES THE RESOLUTION, the merged PR or the
 *  closed-without-merging one that superseded it, so the closure is legible rather than a silent
 *  disappearance. Pure and exported for a direct assertion. */
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

/** W1-T347 — the guard {@link renderReconcileCloseComment} does NOT apply to: a `needs-question`
 *  issue whose referent went terminal is MOOTED, not resolved, and closing it in that function's
 *  voice claims an answer nobody gave. This states PLAINLY that the question was never answered,
 *  starting with a FIXED, DISTINCT prefix so a later census can tell the two apart by exact match. */
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

/** Reconcile OPEN needs-human issues against their referent's CURRENT derived state. A separate
 *  entry point mirroring {@link runCreditBackfill}: its input domain is one OPEN issue per
 *  candidate, disjoint from `runSweep`'s open PRs. Best-effort and per-issue throw-contained, so
 *  one failed close never strands the rest — the W1-T99 lesson. */
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
    // W1-T347: a question-typed issue is MOOTED by a terminal referent, never resolved by one.
    // Action-typed and untyped (the legacy pre-W1-T346 corpus) issues keep today's comment.
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
  // `total: 0` USED TO BE AMBIGUOUS. `issues_seen` is always emitted, so the healthy case is
  // positively identifiable rather than merely un-alarming. The per-reason tally rides ONLY on the
  // abnormal path, appearing exactly when there is something to explain.
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

// ── POST-FIX RE-VERIFICATION RECONCILER (W1-T124) ────────────────────────────────────────────
//
// The DRAINAGE-side complement to the queue governor above: the governor stops the queue GROWING,
// this rung stops it ROTTING. DESIGN (i): the failure-pattern-to-fix-PR mapping is held as DATA
// ({@link DEFAULT_FIX_CLASSES}), so covering a new systemic fix is a ROW, never a branch. DESIGN
// (iii): the re-drive needs REAL ci-gate semantics, so W1-T123's dedupe-by-name is a hard dependency.

/** One failure-pattern to fix-PR class mapping ROW: DATA, not code. `matchesFailure` is a PURE
 *  predicate over the SAME {@link OpenPrView} shape every other rung reads, never an LLM
 *  classification (rule 2), so covering a new systemic fix appends a row here. */
export interface FixClass {
  /** Stable id for ledger lines, dedup keys, and test fixtures — never reused across rows. */
  id: string;
  /** The merged PR whose fix resolves this class — named in every reason/ledger line. */
  fixPrNumber: number;
  description: string;
  /** Does this PR's OBSERVED, currently-recorded failure match this class? */
  matchesFailure: (pr: OpenPrView) => boolean;
}

/** The 2026-07-19 regression fixture's own class: `ci-gate` times out waiting for a required check
 *  that had, or shortly would have, succeeded on the SAME head. Matches on the failing check's
 *  recorded name AND its log tail, never on `checksState` alone — a genuinely red mutation-ratchet
 *  must never match this class. */
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

/** W1-T474 row 1 — the coverage-tier fix. The ratchet reads its baseline from the PR's OWN
 *  checked-out tree, so a PR merged before the fix still fails against the file that fix already
 *  corrected, though its diff never touched coverage. Matches on the check name AND the ratchet's
 *  own "BLOCKED" wording: a PR that genuinely lowered coverage must not match. */
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

/** W1-T474 row 2 — the capability-snapshot regeneration. The check fails whenever the checked-out
 *  `MASTER-PLAN.md` does not match a fresh regeneration, and the default checkout is the merge ref
 *  against the OLD base, so every PR merged before the fix reads the stale block. Matches on the
 *  check's own STALE wording, never on `checksState` alone. */
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
 *  here, never a change to {@link runPostFixReverification}. */
/** The DIFF-SCOPED coverage failure's own wording, NOT the aggregate ratchet's.
 *  {@link COVERAGE_TIER_FIX_CLASS} keys on the floor sentence; the per-diff gate that blocks most
 *  PRs prints a different one and therefore matched nothing at all. */
const DIFF_COVERAGE_BLOCK_RE = /diff-coverage: BLOCKED -- this diff adds source line\(s\) with zero covering tests/i;

/** `  - src/lib/foo.ts:123` — one uncovered line as the gate lists them. */
const UNCOVERED_LINE_RE = /^\s*-\s+(\S+:\d+)\s*$/;

/** What {@link diffCoverageReport} found: the check that blocked and the lines it named. */
export interface DiffCoverageReport {
  check: string;
  uncovered: string[];
}

/** REPORTS a diff-scoped coverage block and the lines it names. A REPORTER, NEVER A REPAIRER, AND
 *  THE DISTINCTION IS STRUCTURAL: {@link FixClass} requires a `fixPrNumber` meaning the merged PR
 *  whose fix resolves the class, and a diff-coverage block is not that shape — its remedy is a test
 *  for one line, so a fourth row would invent a meaningless number. */
export function diffCoverageReport(failures: readonly CiFailure[]): DiffCoverageReport | undefined {
  for (const f of failures) {
    if (!DIFF_COVERAGE_BLOCK_RE.test(f.logTail)) continue;
    const uncovered: string[] = [];
    for (const line of f.logTail.split("\n")) {
      const m = line.match(UNCOVERED_LINE_RE);
      if (m?.[1]) uncovered.push(m[1]);
    }
    return { check: f.name, uncovered };
  }
  return undefined;
}

export const DEFAULT_FIX_CLASSES: readonly FixClass[] = [
  CI_GATE_TIMEOUT_FIX_CLASS,
  COVERAGE_TIER_FIX_CLASS,
  CAPABILITY_SNAPSHOT_FIX_CLASS,
];

/** The injected redrive effect's outcome. `fresh`, when present, is a brand new {@link OpenPrView}
 *  read AFTER the redrive settled — never the STALE pre-redrive view, which would just re-observe
 *  the red it set out to clear. Absent `fresh` means the redrive was dispatched with no settled
 *  read yet: this pass records it so it is never repeated. */
export interface RedriveResult {
  fresh?: OpenPrView;
}

/** Injected effects for {@link runPostFixReverification} — mirrors {@link runCreditBackfill} and
 *  {@link runEscalationReconcile}'s shape, so all three reconciler rungs behave identically. */
export interface PostFixReverificationDeps {
  /** Re-drive the PR's matched required check for the given class. Whether that means re-requesting
   *  the check-run in place or pushing a refresh commit is the effect's own decision; this module
   *  never calls gh or git directly. */
  redrive: (pr: OpenPrView, fixClass: FixClass) => RedriveResult | Promise<RedriveResult>;
  ledgerPath: string;
  runId: string;
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  appendLine?: typeof appendLedger;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Preview only: derive matches, take no effects, write no ledger lines. */
  dryRun?: boolean;
  /** OPTIONAL reader for a PR's currently-failing checks (W1-T977), consulted ONLY when this pass's
   *  snapshot carries `ciFailures: undefined` AND `checksState === "pending"` — the one state
   *  {@link CI_GATE_TIMEOUT_FIX_CLASS} exists to match and the one state the producer never
   *  populates, so the class was structurally unable to see its own trigger. */
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

/** THE POST-FIX RE-VERIFICATION RUNG (W1-T124). For every open PR whose CURRENTLY-recorded failure
 *  matches a {@link FixClass} row whose `fixPrNumber` the caller reports merged, re-drive its
 *  matched check EXACTLY ONCE, deduped by `pr@headSha@class` so a NEW push re-earns one. A PR
 *  matching no merged class is entirely untouched — the falsifier proving the mapping does real work. */
export async function runPostFixReverification(
  openPrs: OpenPrView[],
  mergedFixPrNumbers: ReadonlySet<number>,
  deps: PostFixReverificationDeps,
  classes: readonly FixClass[] = DEFAULT_FIX_CLASSES,
): Promise<PostFixReverificationSummary> {
  // Alias-bound call site (W1-T2393): the bare `readLedgerLines` regex cannot match a name-bound
  // call, so this marker is documentary only.
  // ledger-read-intent: live — this fold reads the live file only, never rotations.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const lines = readLedger(deps.ledgerPath);

  const results: PostFixReverificationResult[] = [];
  let redriven = 0;

  for (const pr of openPrs) {
    // W1-T977: the shared snapshot's `ciFailures` is undefined for a PENDING PR by construction,
    // but a `ci-gate` timeout is observed EXACTLY while a sibling is still pending — so matching on
    // the snapshot field alone can never fire for the one class this loop exists to catch. Consult
    // the injected reader ONLY in that gap, never overriding a red snapshot.
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

    // Head-keyed dedup, mirroring `runSweep`'s fix-dispatch dedup: a NEW push legitimately re-earns
    // a redrive even for the same class, but a repeat pass over the SAME head never re-drives twice.
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
      // PER-PR THROW CONTAINMENT (the W1-T99 lesson): one failed redrive never strands the rest of
      // this pass, and since nothing is ledgered on failure it retries on the very next sweep.
      log("sweep.post_fix_redrive_failed", {
        pr_number: pr.prNumber,
        fix_class: cls.id,
        error: String((e as Error)?.message ?? e),
      });
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "redrive-failed", fixClassId: cls.id });
      continue;
    }

    // Design note iv: captured from the PRE-redrive view, never from `redrive.fresh`, whose ledger
    // read may already reflect THIS pass's own no-strike redrive — the full count this PR carried
    // in is what gets credited back.
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
      // Re-dispose on the fresh, settled result (design note ii) with strikes credited to zero
      // (design note iv): the ONLY defect this rung ever matches is the now-fixed class, so every
      // strike a MATCHED PR carried in was spent chasing that same infrastructure artifact.
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
