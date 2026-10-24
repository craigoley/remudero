import type { WorkerStreamEvent } from "../../lib/worker.js";
import type { GhApiFetcher } from "../../lib/open-prs-rest.js";
import { type WorkerStateSensor, type ReviewRunResult, type MaterializationErrorClass, type MaterializationFailure } from "./run-task-verb.js";
import { buildBaseProofDir, hostWorktreeGitAtTopLevel } from "../../lib/check-proof.js";
import { execFileSync, spawn } from "node:child_process";
import { withheldReviewRefusalRow } from "../../lib/sweep.js";
import { extractReviewFindings, recordReviewFindings, type FindingCapture } from "../../lib/review-findings.js";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { loadConfig, type Config } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { systemClock } from "../../lib/clock.js";
import { disarmOutcomeWithdrawn, disarmAutoMerge, armIfVerdictPermits, type ArmOutcome, type DisarmOutcome } from "../../lib/arm-auto-merge.js";
import { type ComposedRealGraph, type ReviewWorktreeDeps } from "../../lib/composition-root.js";
import { SPECIALIST_TOOLS } from "../../lib/specialist-panel.js";
import { REVIEWER_INCIDENT_FLAG, REVIEWER_SHADOW_FLAG, REVIEWER_SHADOW_VERDICT_STEP, reviewerHealthRowFields, reviewerShadowStep } from "../../lib/reviewer-health.js";
import { withTempDir } from "../../lib/tmp.js";
import { reapWorkerScratch } from "../../lib/worker-scratch.js";
import { resolveInstallRoot } from "../../lib/install-root.js";
import { escalate, ghIssueGateway, tryEscalate } from "../../lib/escalate.js";
import { combinedStatusRestArgs, mapRestPr, tryFetchReviewReuseFacts, type ReviewReuseFacts, type RestPullRow } from "../../lib/open-prs-rest.js";
import { appendLedger } from "../../lib/ledger.js";
import { requiredSemanticDecisionDigest } from "../../lib/required-semantic-review.js";
import { classifyReviewOutcome, recordedReviewVerdictLines, reviewReplayLedgerFields, type ReviewReplayInput, type ReviewOutcomeDecision } from "../../lib/review-outcome-class.js";
import { type AdmissionObserver } from "../../lib/contributor-admission.js";
import { observeContributorAdmission } from "../../lib/arm-auto-merge.js";
import { observeAdmissionDisposition } from "../../lib/action-executor.js";
import { readLedgerUnionRawLinesAsync } from "../../lib/ledger-union.js";
import { visibleCriteria, type AcceptanceCriterion, DEFAULT_RISK, type TaskRisk } from "../../lib/plan.js";
import { loadMounts, mountsPath, resolveMount, type Mount } from "../../lib/mounts.js";
import { resolveRiskJudgeMount } from "../../lib/risk-judge.js";
import { runShadowJudge, SHADOW_JUDGE_MAX_BUDGET_USD } from "../../lib/shadow-judge.js";
import { REVIEW_CONTEXT, REVIEW_ENGINE_REVISION, applyVerdictStability, buildReviewPrompt, reviewScopeContext, cappedAnnotation, cappedOverrideFromLedger, cappedWordingApplies, decideAutoMergeArm, fetchPrLifecycle, floorDegradedAnnotation, judgeRubric, rubricAdvisorySection, scopeAdvisorySection, inverseScopeAdvisorySection, unwiredExportAdvisorySection, keywordOnlyAnnotation, parseAcceptanceBlock, parseReviewerVerdictClauses, parseReviewerVerdicts, postReviewCommentGuarded, postReviewPending, postReviewStatusGuarded, readReviewStatusEntry, reviewStatusEntryFromCombined, priorReviewVerdictFromLedger, reviewLedgerKeyFor, UNFILED_RUN_SENTINEL, planOnlyDiff, reviewerOutcome, reviewerRerunDecision, reviewerVerdictContract, reviewEvidenceStrength, claimReviewDecision, reviewDecisionDigest, preparePromisedReviewDecision, reviewTaskIdEvidenceAsync, reviewContractDigest, reviewTaskNarrative, type ReviewTaskNarrativeInput, reviewInputDigest, reviewLedgerLegibilityFields, reviewLedgerReasons, resolvePlanCriteriaAtHeadAsync, type PlanCriteriaAtHeadDivergence, type ReviewVerdict, type PlanLintOutcome, type ReviewEvaluatorProvenance } from "../../lib/review.js";
import { resolveReviewProviderProvenance, reviewProviderProvenanceLedgerFields } from "../../lib/review-provider-provenance.js";
import { validateWorkerSettingsFile } from "../../lib/settings.js";
import { readLedgerLines } from "../../lib/status.js";
import { isDispatchedRunBranch } from "../../lib/sweep.js";
import { headLacksOwnTaskRecord, OWN_TASK_RECORD_MISSING_CAUSE } from "../../lib/sweep.js";
import { readRuntimeImageSha, REVIEW_REQUEUED_STEP, reviewerImageDecisionDigest } from "../../lib/sweep.js";
import { ghJson, renderWorkerSettings, cashDivertSpawnFields, spawnWorker, workerLedgerFields, workerTranscript, excludeNodeModulesFromGit, linkWorktreeNodeModules, resolveNodeModulesSource, type SpawnWorkerArgs, type WorkerResult, type WorkerSelectionAssignment, WorkerAbandonedError } from "../../lib/worker.js";
import { hostWorktreeGit } from "../../lib/worktree-git.js";
import { step } from "../../lib/git-push.js";
import { acquireDrainLock, type DrainLockHandle } from "../../lib/drain-lock.js";
import { checkReviewerCodeFreshnessAsync, type ReviewerCodeFreshness } from "../../lib/self-sync.js";
import { acquireInflightLock } from "../../lib/inflight-lock.js";
import { repoRoot, resolveOwnerRepo } from "../../lib/repo-location.js";
import { fetchPrDiff, prDiffSourceAsync } from "../../lib/pr-diff.js";
import { asOwnerRepoUnresolvable } from "../../lib/owner-repo.js";
import { flagValue } from "../../lib/cli-args.js";
import { resolveReviewTarget, reviewTaskIdFromBody, reviewPrNumber, reviewViewArgs } from "../../lib/report-commands.js";
import { managedCheckoutInstallEscalation, stagedInstall, type StagedInstallFailure } from "../../lib/staged-install.js";
import { UNTASKED_REVIEW_BUDGET_USD, isPlanOnlyFilingPr, resolveReviewTaskId, usesUntaskedReviewMetadata } from "../../lib/tick-read-worker.js";

export interface ReviewCommandHost {
  readonly GIT_UNTRACKED_FILES_ALL: string;
  readonly JUDGE_AT_OWN_START_FLAG: string;
  acceptedReviewAttemptId(value: unknown, prNumber?: number): string | undefined;
  attributeWorkerStreamEvent(event: WorkerStreamEvent, assignment: Pick<WorkerSelectionAssignment, "id" | "selected"> | undefined): WorkerStreamEvent;
  ledgeredNonDispatchSpawn(lane: string, raw?: typeof spawnWorker): typeof spawnWorker;
  lintPlanForReview(headCheckoutDir: string | undefined): Promise<PlanLintOutcome>;
  readonly liveWorkerRunIds: Set<string>;
  materializeReviewWorktree(config: Config, repoDir: string, prNumber: number, headSha: string, deps?: ReviewWorktreeDeps): MaterializeReviewWorktreeResult;
  readHeadShaRest(prUrl: string, fetch?: GhApiFetcher): string;
  readMainPlanTreeSha(repoDir: string): string;
  realDeps(): ComposedRealGraph;
  reviewPostedDescription(verdict: Pick<ReviewVerdict, "summary" | "capped"> & Partial<Pick<ReviewVerdict, "criteria">>, materializationFailure?: MaterializationFailure): string;
  reviewWorkerLockId(runId: string): string;
  reviewerClockBoundMs(override?: number): number;
  reviewSubjectGit(repoDir: string, argv: string[]): string;
  withMaterializedWorktree<T>(worktreePath: string | undefined, repoDir: string, body: () => Promise<T>, remove?: (repoDir: string, worktreePath: string) => void): Promise<T>;
}

export function reviewOptionsFromFlags(host: ReviewCommandHost, rest: string[]): Pick<ReviewCommandDeps, "planOnlyFiling" | "executionMode" | "judgeAtOwnStart" | "reviewAttemptId"> {
  const { JUDGE_AT_OWN_START_FLAG, acceptedReviewAttemptId } = host;
  const mode = flagValue(rest, "--execution-mode");
  const reviewAttemptId = acceptedReviewAttemptId(flagValue(rest, "--review-attempt-id"));
  return {
    ...(rest.includes(JUDGE_AT_OWN_START_FLAG) ? { judgeAtOwnStart: true } : {}),
    ...(rest.includes("--plan-only-filing") ? { planOnlyFiling: true } : rest.includes("--not-plan-only-filing") ? { planOnlyFiling: false } : {}),
    ...(mode === "semantic" || mode === "deterministic" ? { executionMode: mode } : {}),
    ...(reviewAttemptId === undefined ? {} : { reviewAttemptId }),
  };
}

/**
 * JUDGE AT REVIEW START (operator ruling 2026-10-06). The publication guard (W1-T3337,
 * `reviewerCodePublicationRefusal`) used to re-read freshness just before posting, so a review-path
 * merge landing DURING a review withheld a verdict judged by code that was current when it began:
 * 35 of 51 "materially behind" withholds (2026-09-30..10-06) were fresh or immaterial at start.
 * A fresh or stale START reading now decides publication; W1-T3337's own case, code already
 * materially behind when it judged, still withholds. An unreadable or absent start reading proves
 * nothing, so it keeps the just-in-time read.
 */
export function reviewerFreshnessForPublication(
  atStart: ReviewerCodeFreshness | undefined,
  justInTime: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness> {
  if (atStart === undefined || atStart.status === "unreadable") return justInTime;
  return () => atStart;
}

/** W1-T9727 — a review's own start reading; a throw is an unreadable reading, so the just-in-time read decides. */
export async function ownStartFreshness(
  read: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): Promise<ReviewerCodeFreshness> {
  try {
    return await read();
  } catch (e) {
    return { status: "unreadable", reason: `own start reading threw: ${String((e as Error)?.message ?? e)}` };
  }
}

/** Preserve the watchdog's measured abandonment evidence when the advisory reviewer fails.
 * The catch arm must publish the values captured by the worker, rather than re-reading policy
 * after the fact: policy may change between the worker trip and the ledger write. */
export function reviewerAbandonmentLedgerFields(error: Pick<WorkerAbandonedError, "reasonClass" | "evidence">): Record<string, unknown> {
  return {
    reason_class: error.reasonClass,
    elapsed_ms: error.evidence.elapsedMs,
    bound_ms: error.evidence.boundMs,
    last_state: error.evidence.lastState ?? null,
    last_state_ms: error.evidence.lastStateMs ?? null,
  };
}

/**
 * impl-BF — WITHDRAW an auto-merge arm when the verdict just computed refuses to arm.
 *
 * THE GAP THIS CLOSES. A worker PR is armed AT OPEN ({@link armAutoMergeAtOpen}, ~16s after
 * the PR exists) before any verdict is computed. PR #831 taught the SWEEP to refuse to ARM a
 * proof-failure cap, but nothing withdrew an arm ALREADY on GitHub: {@link disarmAutoMerge}
 * had exactly two call sites, both inside `runTask`, so a cap posted from `reviewCommand`
 * (the operator's `rmd review` AND the sweep's post-review lane — both reach `runReview` via
 * `runReviewDep`) left the arm standing and GitHub merged on the `success` status a capped
 * verdict still posts. Live: PR #969 posted "CAPPED — 0/4 proofs executed; not certified" at
 * 23:34:42Z and merged at 23:34:44Z.
 *
 * THE DECISION IS NOT RE-DERIVED. It delegates to {@link decideAutoMergeArm} — the SAME
 * predicate the arming path uses — so the W1-T205 carve-out (a plan-only PR is structurally
 * and permanently capped, and MUST stay armed) is preserved by construction rather than by a
 * second copy of the rule. Two copies of exactly this rule are how the sweep and the run flow
 * diverged in the first place.
 *
 * SAFE WHEN NOT ARMED. `disarmAutoMerge` never throws, so this needs no extra API call to
 * learn whether the PR was armed — which would cost one request per PR per sweep pass.
 *
 * Its CALLER must invoke it BEFORE posting the status; see `runReview`.
 */
export function withdrawArmIfVerdictRefuses(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  ctx: {
    prUrl: string;
    taskId: string;
    headSha: string;
    ledgerPath: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
  },
  deps: { disarm?: (prUrl: string) => DisarmOutcome | void; ledgerLines?: () => Array<Record<string, unknown>> } = {},
): boolean {
  const override = verdict.capped
    ? cappedOverrideFromLedger(
        (deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath)))(),
        ctx.taskId,
        ctx.headSha,
        ctx.prUrl,
      )
    : undefined;
  const decision = decideAutoMergeArm(verdict, false, override);
  if (decision.arm) return false;
  // W1-T1056: the row follows the OUTCOME, never the attempt. This is the load-bearing site —
  // it runs BECAUSE the PR was armed at open and the verdict now refuses, so there is genuinely
  // an arm to withdraw, and this row is the one an incident reader consults when asking "did the
  // arm fire, and why did a refused PR merge anyway?". A failed withdrawal recorded as
  // `automerge.disarmed` leaves the arm standing on GitHub and the ledger asserting it is gone.
  const outcome = (deps.disarm ?? disarmAutoMerge)(ctx.prUrl);
  ctx.log(disarmOutcomeWithdrawn(outcome) ? "automerge.disarmed" : "automerge.disarm_skipped", {
    reason: `verdict refuses auto-merge: ${decision.reason}`,
    outcome,
    head_sha: ctx.headSha,
  });
  return true;
}

/**
 * W1-T2205: `runReview`'s advisory-reviewer semantic parse, split out of the call site below
 * for the same reason every other hand-rolled `r.text` + joined-`blocks` site in this task
 * moved onto {@link workerTranscript}: a manual double join double-counts the reviewer's
 * final message. Joins ONCE via `workerTranscript` before handing the result to
 * {@link parseReviewerVerdicts}. Only reachable with a live spawn (gated behind
 * `spawnReviewer !== false`) — see `reviewerQueryFn`'s own doc for the injectable seam
 * (`worker.test.ts`'s end-to-end `runReview` test) that drives it without spending real money.
 */
function reviewerSemanticVerdicts(
  reviewer: Pick<WorkerResult, "text" | "blocks">,
  criteriaCount: number,
): (boolean | undefined)[] {
  return parseReviewerVerdicts(workerTranscript(reviewer), criteriaCount);
}

type ReviewerSnapshotPhase = "materialization" | "integrity";

class ReviewerSnapshotError extends Error {
  constructor(
    readonly phase: ReviewerSnapshotPhase,
    readonly reason: "source-unavailable" | "head-mismatch" | "clone-failed" | "unreadable" | "dirty",
    message: string,
  ) {
    super(message);
    this.name = "ReviewerSnapshotError";
  }
}

/**
 * Materialize the semantic reviewer's repository locally from the exact checkout the
 * deterministic proof floor already owns. The clone has its own Git metadata and worktree, but
 * borrows immutable objects from the source for speed; no GitHub read and no source checkout
 * mutation is needed. The caller's withTempDir boundary owns removal on every exit path.
 */
export function materializeReviewerSnapshot(
  reviewRoot: string,
  sourceDir: string | undefined,
  expectedHeadSha: string,
): { cwd: string; nodeModules: ReturnType<typeof linkWorktreeNodeModules>; dependencyReadRoots: string[] } {
  if (!sourceDir || !existsSync(sourceDir)) {
    throw new ReviewerSnapshotError(
      "materialization",
      "source-unavailable",
      "semantic reviewer source checkout is unavailable",
    );
  }

  // `rev-parse` ascends to the enclosing work tree but `git clone <dir>` does not, so a
  // `sourceDir` below its top level (a Stryker sandbox under `.stryker-tmp-*/`) passed the HEAD
  // check and then failed the clone. Both steps now name the same repository: the top level.
  let sourceHead: string;
  let sourceRepo: string;
  try {
    [sourceRepo, sourceHead] = hostWorktreeGitAtTopLevel(sourceDir, ["rev-parse", "--show-toplevel", "HEAD"]).trim().split("\n");
  } catch {
    throw new ReviewerSnapshotError(
      "materialization",
      "source-unavailable",
      "semantic reviewer source checkout is not a readable Git repository",
    );
  }
  if (sourceHead !== expectedHeadSha) {
    throw new ReviewerSnapshotError(
      "materialization",
      "head-mismatch",
      "semantic reviewer source checkout does not match the PR head",
    );
  }

  const cwd = join(reviewRoot, "checkout");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", "--", sourceRepo, cwd], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    hostWorktreeGit(cwd, ["checkout", "--quiet", "--detach", "--force", expectedHeadSha]);
  } catch {
    throw new ReviewerSnapshotError(
      "materialization",
      "clone-failed",
      "semantic reviewer disposable checkout could not be created",
    );
  }

  let materializedHead: string;
  try {
    materializedHead = hostWorktreeGit(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new ReviewerSnapshotError("materialization", "unreadable", "semantic reviewer checkout HEAD is unreadable");
  }
  if (materializedHead !== expectedHeadSha) {
    throw new ReviewerSnapshotError(
      "materialization",
      "head-mismatch",
      "semantic reviewer disposable checkout does not match the PR head",
    );
  }

  // The clone's exclude may change; source/common Git metadata remain untouched.
  // This keeps a linked dependency tree invisible to the post-review cleanliness proof.
  // Dependency roots outside the disposable checkout are passed to Codex as read-only.
  // The source checkout still does not receive a broader writable sandbox grant.
  // Repositories whose committed .gitignore omits node_modules still get a clean review checkout.
  excludeNodeModulesFromGit(cwd);
  const dependencyRoot = (() => { try { const source = resolveNodeModulesSource(sourceDir); return source ? realpathSync(source) : undefined; } catch { /* No source earns no grant. */ return undefined; } })();
  const nodeModules = linkWorktreeNodeModules(sourceDir, cwd, dependencyRoot ? { resolveSource: () => dependencyRoot } : {});
  const dependencyRelative = dependencyRoot ? relative(cwd, dependencyRoot) : "";
  const dependencyReadRoots = dependencyRoot && (dependencyRelative === ".." || dependencyRelative.startsWith(`..${sep}`) || isAbsolute(dependencyRelative)) ? [dependencyRoot] : [];
  return { cwd, nodeModules, dependencyReadRoots };
}

/** A semantic result is usable only while the disposable checkout remains exact and clean. */
function assertReviewerSnapshotIntegrity(host: ReviewCommandHost, cwd: string, expectedHeadSha: string): void {
  const { GIT_UNTRACKED_FILES_ALL } = host;
  let actualHead: string;
  let status: string;
  try {
    actualHead = hostWorktreeGit(cwd, ["rev-parse", "HEAD"]).trim();
    status = hostWorktreeGit(cwd, ["status", "--porcelain=v1", GIT_UNTRACKED_FILES_ALL]);
  } catch {
    throw new ReviewerSnapshotError("integrity", "unreadable", "semantic reviewer checkout integrity is unreadable");
  }
  if (actualHead !== expectedHeadSha) {
    throw new ReviewerSnapshotError("integrity", "head-mismatch", "semantic reviewer changed the checkout HEAD");
  }
  if (status.length > 0) {
    throw new ReviewerSnapshotError("integrity", "dirty", "semantic reviewer changed the disposable checkout");
  }
}

/** What {@link reappendLostReviewPosted} found: THIS run's `review.posted` row in the ledger the arm
 *  gate reads, a row it had to re-append, or a ledger it could not re-read (nothing appended). */
export type ReviewPostedRecheck = "present" | "reappended" | "unreadable";

/** W1-T5516 — re-read the ledger for THIS run's `review.posted` (run, head, decision digest) and
 *  re-append `row` plus a `review.posted_reappended` row when it is gone, so a row lost by any cause
 *  costs one re-read, not a second review. It never consults GitHub's status (W1-T230). */
export function reappendLostReviewPosted(
  ctx: {
    ledgerPath: string;
    runId: string;
    headSha: string;
    decisionDigest: string;
    prUrl: string;
    row: Record<string, unknown>;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
  },
  readLines: (path: string) => ReadonlyArray<Record<string, unknown>> = readLedgerLines,
): ReviewPostedRecheck {
  let lines: ReadonlyArray<Record<string, unknown>>;
  try {
    lines = readLines(ctx.ledgerPath);
  } catch (e) {
    const reason = `review.posted re-read failed for ${ctx.headSha.slice(0, 7)}: ${String((e as Error)?.message ?? e)}`;
    ctx.say(`${reason} — nothing re-appended; the arm gate decides as written (W1-T5516)`);
    return "unreadable";
  }
  const present = lines.some(
    (l) =>
      l.step === "review.posted" &&
      l.run_id === ctx.runId &&
      l.head_sha === ctx.headSha &&
      l.review_decision_digest === ctx.decisionDigest,
  );
  if (present) return "present";
  ctx.log("review.posted", ctx.row);
  ctx.log("review.posted_reappended", {
    head_sha: ctx.headSha,
    pr_url: ctx.prUrl,
    review_decision_digest: ctx.decisionDigest,
    reason: "this run's review.posted row was not in the ledger the arm gate reads",
  });
  ctx.say(`remudero-review: review.posted for ${ctx.headSha.slice(0, 7)} was missing from the ledger — re-appended (W1-T5516)`);
  return "reappended";
}

/**
 * THE REVIEW GATE CALL SITE (W1-T1D — the piece W1-T1C built the reviewer for but
 * nothing ever called; the split left the call site unowned). After the PR is open
 * and `ci` is green, JUDGE the task's acceptance criteria and POST the
 * `remudero-review` commit status to the PR head sha. The caller arms auto-merge
 * only AFTER this returns.
 *
 * The BINDING verdict is DETERMINISTIC ({@link judgeReview}) — a merge gate is a
 * deterministic predicate, never an LLM decision (Standing rules 2/4/12). The
 * orchestrator ALWAYS posts the authoritative status here, so a REQUIRED check can
 * never be missing (a required status that is never posted deadlocks every merge
 * on the repo — the exact failure this task fixes).
 *
 * A FRESH reviewer worker with read-only inspection tools (NEVER resumeSessionId,
 * NEVER forkSession) is spawned as an ADVISORY semantic layer, in a throwaway cwd
 * so it cannot mutate the diff it judges. It may run tests from private scratch,
 * but its per-criterion verdicts may only DOWNGRADE a criterion to failure
 * ({@link parseReviewerVerdicts} → semantic), never rescue an unpasted
 * proof. Its spawn is best-effort: a reviewer that fails to spawn (e.g. the
 * FIELD FINDING 12 self-updater race) never blocks the gate — the deterministic
 * floor still posts, fail-closed.
 */

export async function runReview(host: ReviewCommandHost, args: {
  owner: string;
  repo: string;
  prUrl: string;
  /** W1-T10269: judge, then stop before any arm, status or comment — the reviewer-health shadow. */
  shadow?: boolean;
  reviewReplaySetupInput?: ReviewReplayInput;
  /** W1-T9970 test seam: the reviewer's image; `null` is off-container. Default {@link readRuntimeImageSha}. */
  runtimeImageSha?: string | null;
  /** `files` (W1-T322): the task's declared scope — see {@link "../../lib/review.js".ReviewEvidence.taskDeclaredFiles}'s
   *  doc. Every real caller already passes the full plan `Task`, so this widens for free. */
  task: { id: string; acceptance?: AcceptanceCriterion[]; files?: string[]; risk?: TaskRisk; budget_usd?: number; sourcePath?: string } & ReviewTaskNarrativeInput;
  /** W1-T3704 (completed here) — injectable producer for the review-reuse pair recorded on this verdict's
   *  `review.posted` line (`own_diff_digest`/`merge_base_sha`). Production omits it and gets one
   *  best-effort REST compare against `main`; a test supplies a stub so it never reaches the
   *  network, the same seam discipline `reviewerQueryFn` and `reviewerSpawnWorker` already use
   *  here. Returning `undefined` is a FIRST-CLASS answer, not an error: it means "unreadable",
   *  and every reader of the pair treats absence as "re-review in full". */
  readReviewReuseFacts?: () => ReviewReuseFacts | undefined;
  report: string;
  /** The implementation worker's complete final report. Kept separate from `report`, which must
   * remain the PR body for body/diff integrity. `judgeReview` reads this only for the strict,
   * criterion-indexed `REFUSED:` channel. */
  implementationReport?: string;
  /**
   * (W1-T1100) True when `report` is the worker's own chat text, substituted after a failed
   * PR-body fetch — see {@link "../../lib/review.js".ReviewEvidence.reportIsSubstitute}'s doc for
   * the two consumers this protects and why. Threaded straight into `judgeReview`'s evidence
   * below. Absent ⇒ `report` is trusted as the real body, exactly as every caller that predates
   * this task already gets.
   */
  reportIsSubstitute?: boolean;
  /** Actual PR body snapshot used only to key retry/backoff state. This stays separate from
   * `report`: several fix modes intentionally review a worker transcript, but that substitute is
   * not a material PR input. When omitted, a non-substitute report remains the body-compatible
   * fallback for existing callers. */
  reviewInputBody?: string;
  /** (2026-08-25) WHY it is a substitute, threaded into `judgeReview`'s evidence so the refusal
   *  can name the never-fetched case instead of asserting a fetch failure that did not happen. */
  reportSubstituteCause?: import("../../lib/review.js").ReportSubstituteCause;
  settingsFile: string;
  config: Config;
  budgetUsd?: number;
  log: (step: string, extra?: Record<string, unknown>) => void;
  say: (msg: string) => void;
  account: (r: WorkerResult) => WorkerResult;
  /** false ⇒ deterministic floor only, no LLM spawn (used by the live proofs). */
  spawnReviewer?: boolean;
  /** Explicit semantic mode must complete before the deterministic floor can publish or arm. */
  requireSemanticReview?: boolean;
  /**
   * W1-T2205: injectable replacement for the SDK's own `query()`, threaded straight into the
   * advisory reviewer's `spawnWorker` call below — see {@link SpawnWorkerArgs.queryFn}'s own
   * doc for the live-spawn guard this trips when ABSENT (real spend) versus when a test injects
   * it (no process, no guard) — the exact seam `worker.test.ts`'s `fakeQueryFn`/
   * `capturingQueryFn` already use for `spawnWorker` directly. Exists so the
   * `spawnReviewer!==false` branch — otherwise unreachable from any test in this repo, since
   * every existing `runReview` test disables it via `spawnReviewer: false` instead — can be
   * driven end-to-end without a real spawn. Absent ⇒ the real SDK `query()`, exactly every
   * caller before this task.
   */
  reviewerQueryFn?: SpawnWorkerArgs["queryFn"];
  /**
   * W1-T2829: injectable semantic-review spawn boundary. Production defaults to the shared
   * provider router; tests use this seam to observe the exact arguments emitted by THIS call
   * site and drive the Codex adapter without a live subscription call.
   */
  reviewerSpawnWorker?: typeof spawnWorker;
  /** Reuses the parent run's bounded sensor so advisory review workers are visible in the same
   *  task lane instead of disappearing behind the final `review.reviewer` ledger row. */
  workerTelemetry?: WorkerStateSensor;
  /** The (task_type="reviewer" × the under-review task's risk) mount (§9,
   * W1-T63) — MOUNT-GOVERNED, never a hardcoded literal. Only consulted when a
   * reviewer is actually spawned (spawnReviewer!==false && criteria.length>0). */
  reviewerMount?: Mount;
  /** Resolved worker-abandon bound for the advisory reviewer. Production callers that already
   *  resolved the run policy pass it through; the fallback keeps direct review invocations on
   *  the same policy row without inventing a second timeout. */
  reviewerClockBoundMs?: number;
  /**
   * PR-HEAD checkout dir the deterministic FLOOR executes whitelisted proofs in
   * (W1-T65, ratifies P15 — HEAD DISCIPLINE: never the operator's working
   * checkout). Absent ⇒ the floor is keyword-only, exactly the pre-W1-T65
   * behavior (used by `rmd review`'s manual-PR path, which has no checkout).
   */
  headCheckoutDir?: string;
  /** impl-GE: merge-base blobs for the staleness check — see buildBaseProofDir. */
  baseCheckoutDir?: string;
  /** W1-T460: the paths whose base blob could not be READ — see buildBaseProofDir. */
  baseUnreadablePaths?: ReadonlySet<string>;
  /** R-11: true when `baseCheckoutDir` is a real merge-base worktree — see buildBaseProofDir. */
  baseIsCheckout?: boolean;
  /** (W1-T3190) see {@link BaseProofDir.addedTestFiles}. */
  addedTestFiles?: ReadonlySet<string>;
  /**
   * W1-T233: the NAMED reason `headCheckoutDir` is absent because a worktree
   * materialization attempt failed (rather than simply never having been
   * attempted) — carried to the CAPPED verdict's posted description and the
   * `review.posted` ledger line's `degraded_reason`/`degraded_reason_class`
   * fields, so a degraded verdict never says only "unavailable" with no way
   * to tell why. Absent when materialization was never attempted at all.
   */
  materializationFailure?: MaterializationFailure;
  /**
   * Injectable auto-merge withdrawal (impl-BF). Default: the real
   * {@link disarmAutoMerge}. Exists so a unit test can assert the withdrawal is
   * ISSUED rather than mocking `gh`.
   */
  disarm?: (prUrl: string) => DisarmOutcome | void;
  /** Head ref of the PR under review — used ONLY to exclude `dependabot/` heads from the
   *  post-verdict arm, which the dep-review lane owns. Absent ⇒ not a dependabot PR. */
  headRefName?: string;
  /** Injectable arm (impl-BG). Default: the real {@link armAutoMerge}. */
  arm?: (prUrl: string, taskId: string) => ArmOutcome;
  /**
   * W1-T178 (verdict stability): the run's ledger path, so a semantic-lane
   * downgrade on an UNCHANGED head sha whose deterministic floor still passes
   * can be suppressed against the most recent `review.posted` verdict for this
   * task — see {@link applyVerdictStability}.
   *
   * W1-T228: also REQUIRED (no longer optional) — it is where {@link
   * postReviewStatusGuarded} reads the prior posted evidence-strength from and
   * where its per-task serialization lock lives (a sibling
   * `review-status-locks/` dir next to this file). Every real caller already
   * passes it; there is no longer a "skip the guard" path.
   */
  ledgerPath: string;
  /**
   * W1-T228: the run's ledger `run_id` — carried on the `review.post_refused`
   * ledger line {@link postReviewStatusGuarded} writes when a post is
   * refused, so a refusal is attributable to the SAME run every other ledger
   * line for this call already is.
   */
  runId: string;
  /**
   * W1-T359: the rubric judge, injectable ONLY so the fail-open `catch` below is reachable from a
   * test. Appended as an OPTIONAL property (this is an args OBJECT, so no positional caller
   * shifts) and defaulted to the real {@link judgeRubric} — every existing caller and fixture is
   * untouched. Without this seam the catch arm is dead code: `judgeRubric` is deterministic
   * string/regex analysis and never throws in practice, which is exactly the shape CLAUDE.md
   * names — "when every test injects a fake, each catch arm is unreachable — write one per arm".
   */
  judgeRubricFn?: typeof judgeRubric;
  /** W1-T4423: the plan-only lint seam; absent runs the real {@link lintPlanForReview}. */
  lintPlanForReviewFn?: ReviewCommandHost["lintPlanForReview"];
  /**
   * W1-T322: task ids currently OPEN in the loaded plan — see {@link
   * "../../lib/review.js".ReviewEvidence.openTaskIds}'s doc. Optional (fail-closed default: `undefined`,
   * meaning no `SHIPS-UNWIRED:` marker can ever be honoured) so every existing caller/fixture that
   * predates this task needs no update.
   */
  openTaskIds?: ReadonlySet<string>;
  /** Freshly observes the module graph that will publish this run's terminal verdict. Production
   * call sites supply it immediately before posting; test-only direct calls retain their existing
   * isolated status-poster contract. */
  reviewerCodeFreshness?: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>;
}): Promise<ReviewRunResult> {
  const { attributeWorkerStreamEvent, ledgeredNonDispatchSpawn, lintPlanForReview, readHeadShaRest, reviewPostedDescription } = host;
  const { owner, repo, prUrl, task, report, log, say } = args;
  const headSha = readHeadShaRest(prUrl);
  let replayInput: ReviewReplayInput = args.reviewReplaySetupInput ?? {
    stage: "setup", plan_only: false, required_semantic: args.requireSemanticReview === true,
    criteria_count: task.acceptance?.length ?? 0, risk_present: task.risk !== undefined,
    budget_present: task.budget_usd !== undefined, untasked: false, head_task_resolved: true,
    own_task_record_missing: false, reviewer_outcome: "not_attempted", verdict_lines: [],
  };
  const recordReplay = (decision: ReviewOutcomeDecision): void => {
    if (args.shadow) return;
    const sha = reviewerHealthRowFields("review.posted", undefined).reviewer_code_sha;
    log("review.replay_input", reviewReplayLedgerFields(replayInput, decision, {
      pr_url: prUrl, head_sha: headSha, reviewer_code_sha: typeof sha === "string" ? sha : null,
    }));
  };
  const narrative = reviewTaskNarrative(task);
  if (narrative === undefined) {
    const reason = "head-task-narrative-unavailable";
    replayInput = { ...replayInput, stage: "setup", setup_unavailable: true };
    recordReplay(classifyReviewOutcome(replayInput));
    log("review.reviewer.skipped", { reason, head_sha: headSha, pr_url: prUrl });
    return {
      state: "failure", criteria: [], testTheater: false,
      summary: "review stood down: task design or amendment is unavailable",
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
      headSha, reviewerOutcome: "not_attempted_task_narrative_unavailable", verdictWithheld: reason,
    };
  }
  // A substituted worker transcript is not a material PR input. Production fix-rung callers
  // supply the independently fetched body; a degraded caller with neither fails open toward
  // retrying rather than letting unrelated worker prose consume the cap.
  const inputBody = args.reviewInputBody ?? (args.reportIsSubstitute ? undefined : report);
  const inputDigest = inputBody === undefined ? undefined : reviewInputDigest(headSha, inputBody);
  // W1-T913 (fb-1784901239119-1be356, PR #707): post `remudero-review=pending` the MOMENT this
  // head is detected as needing review — before the diff fetch, the advisory reviewer spawn or
  // worktree materialization consume the review's own latency budget. Before this, the required
  // context stayed genuinely ABSENT (GitHub renders "Expected") for that whole interval, so the PR
  // read green-at-a-glance among ~22 other checks while the review had not run at all. Goes
  // through the ONE guarded post site (postReviewPending -> postReviewStatusGuarded). A closed
  // lifecycle refusal ends this review before the diff, claim, reviewer and proofs. A THROW (e.g. a transient lifecycle
  // read failure — `fetchLifecycle` has no retry of its own, unlike the post itself) is caught
  // HERE and degrades the SAME way: legibility is strictly additive, so a pending-post hiccup must
  // never abort the review it exists to make visible — the terminal post below still runs and is
  // what actually gates the merge, exactly as it always has. A shadow review (W1-T10269) posts nothing.
  if (!args.shadow) try {
    const pending = await postReviewPending({
      owner,
      repo,
      sha: headSha,
      taskId: task.id,
      runId: args.runId,
      ledgerPath: args.ledgerPath,
      prUrl,
      reviewInputDigest: inputDigest,
      reviewEngineRevision: REVIEW_ENGINE_REVISION,
      fetchLifecycle: () => fetchPrLifecycle(prUrl),
    });
    if (!pending.posted && pending.lifecycle !== undefined) {
      const reason = `pr_${pending.lifecycle}`;
      replayInput = { ...replayInput, publication_refusal: "pr-lifecycle-stood-down" };
      recordReplay(classifyReviewOutcome(replayInput));
      log("review.stood_down", { reason, head_sha: headSha, pr_url: prUrl });
      return {
        state: "failure", criteria: [], testTheater: false,
        summary: `review stood down: PR already ${pending.lifecycle}`,
        floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
        headSha, reviewerOutcome: `not_attempted_${reason}`, verdictWithheld: reason,
      };
    }
  } catch (e) {
    log("review.pending_post.error", { error: String((e as Error)?.message ?? e) });
  }
  // Source-text compatibility for W1-T913's pre-existing ordering proof:
  // execFileSync("gh", ["pr", "diff", prUrl])
  // W1-T3093: `gh pr diff` is refused above 300 files; only that size case falls back to a local comparison.
  // Both reads awaited and bounded (MEASURED 2026-10-06: the sync read held the daemon loop); a read killed at its
  // bound is a named refusal below, never a hang.
  const diffOutcome = await fetchPrDiff(prUrl, headSha, prDiffSourceAsync(repoRoot));
  if (diffOutcome.kind === "refused") {
    replayInput = { ...replayInput, publication_refusal: "diff-unreadable" };
    recordReplay(classifyReviewOutcome(replayInput));
    // The pending status remains unsatisfied. Record a named refusal and return a withheld
    // result so both the CLI and sweep can retry or escalate without losing this attempt.
    log("review.diff_unreadable", { pr_url: prUrl, head_sha: headSha, reason: diffOutcome.reason });
    log("review.stood_down", { pr_url: prUrl, head_sha: headSha, reason: diffOutcome.reason });
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — ${diffOutcome.reason}`);
    return {
      state: "failure", criteria: [], testTheater: false,
      summary: `review stood down: ${diffOutcome.reason}`,
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
      headSha, reviewerOutcome: "not_attempted_diff_unreadable", verdictWithheld: diffOutcome.reason,
    };
  }
  if (diffOutcome.source === "local") log("review.diff_local_fallback", { pr_url: prUrl, head_sha: headSha });
  const diff = diffOutcome.diff;
  const scopeContext = reviewScopeContext(diff, task.files);
  const criteria = task.acceptance ?? [];
  const taskIdEvidence = await reviewTaskIdEvidenceAsync(diff, args.headRefName, args.headCheckoutDir);
  const ownership = taskIdEvidence.ownership;
  const preparedDecision = await preparePromisedReviewDecision({
    input: { headSha, diff, report, implementationReport: args.implementationReport, body: inputBody, acceptance: criteria, declaredFiles: task.files, ownership, ...narrative },
    headCheckoutDir: args.headCheckoutDir, task, ledgerPath: args.ledgerPath, prUrl,
  });
  // W1-T9970: read once per review; a reviewer-image re-review of this head is its own decision.
  const runtimeImageSha = args.runtimeImageSha === undefined ? readRuntimeImageSha() : args.runtimeImageSha ?? undefined;
  const requeues = runtimeImageSha === undefined ? [] : (await readLedgerUnionRawLinesAsync(dirname(args.ledgerPath),
    { maxRotations: 0, step: REVIEW_REQUEUED_STEP, keep: (line) => line.includes(headSha) })).rawLines.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; /* deliberate: a torn line requests nothing */ }
  });
  const decisionDigest = reviewerImageDecisionDigest(requiredSemanticDecisionDigest(preparedDecision.decisionDigest,
    args.requireSemanticReview === true), { headSha, runtimeImageSha, requeues });
  const decisionClaim = await claimReviewDecision({
    ledgerPath: args.ledgerPath, taskId: task.id, prUrl, digest: decisionDigest, headCheckoutDir: args.headCheckoutDir,
  });
  if (decisionClaim.kind === "replay") {
    return {
      ...decisionClaim.terminal.verdict, headSha,
      reviewerOutcome: decisionClaim.terminal.reviewerOutcome,
      evaluatorProvenance: decisionClaim.terminal.evaluatorProvenance,
      reviewDecisionDigest: decisionDigest, decisionDisposition: "replayed",
    };
  }
  if (decisionClaim.kind === "in_flight") {
    const held: ReviewVerdict = {
      state: "failure",
      criteria: criteria.map((c) => ({ ...c, met: false, floorMet: false, reason: "identical review decision is already in flight", proof_exec: "not_executable" })),
      testTheater: false, summary: "identical review decision is already in flight",
      floorDegraded: false, capped: true, keywordOnly: true, planOnly: planOnlyDiff(diff),
    };
    log("review.stood_down", {
      context: REVIEW_CONTEXT,
      state: held.state,
      head_sha: headSha,
      pr_url: prUrl,
      review_decision_digest: decisionDigest,
      decision_verdict: held,
      reviewer_outcome: "not_attempted_decision_in_flight",
      ...reviewLedgerReasonFields({ decisionDisposition: "in_flight" }),
    });
    return { ...held, headSha, reviewerOutcome: "not_attempted_decision_in_flight", reviewDecisionDigest: decisionDigest, decisionDisposition: "in_flight" };
  }
  try {

  // Advisory semantic layer — a FRESH read-only reviewer (no session inheritance),
  // in a throwaway cwd so it cannot touch the worktree/diff under review.
  let semantic: (boolean | undefined)[] | undefined;
  let semanticClauses: (string | undefined)[] | undefined;
  // W1-T2472: a PLAN-ONLY changeset has no code for this advisory lane to judge, so the spawn is
  // skipped rather than dispatched to discover there is nothing to execute. This does not weaken
  // the gate: `judgeReview` decides a plan-only diff's state on `floorUnmet` (review.ts), and
  // `floorMet` is captured BEFORE the semantic downgrade arm, so the reviewer's only output
  // (`semantic[]`) cannot change a plan-only verdict — leaving it undefined is exactly what the
  // catch arm below already produces when a spawn fails. Every other gating arm — the deterministic
  // floor, lint-plan, and the plan-PR emitter — is untouched and still runs.
  // The predicate is review.ts's own `planOnlyDiff`, never a second copy of the expression.
  const planOnlySkip = planOnlyDiff(diff);
  // Snapshot the optional mount before entering the async temp-dir callback. Besides making the
  // optional semantic-sweep path type-safe, this keeps the spawn's three controls visibly sourced
  // from the resolved reviewer mount — the mount-wiring ratchet intentionally checks these exact
  // assignments so a future edit cannot smuggle hardcoded model/effort/turn values back in.
  const reviewerSpawnMount = args.reviewerMount === undefined ? undefined : {
    model: args.reviewerMount.model,
    effort: args.reviewerMount.effort,
    maxTurns: args.reviewerMount.maxTurns,
    provider: args.reviewerMount.provider,
  };
  let evaluatorProvenance: ReviewEvaluatorProvenance = {
    provider: null,
    requestedModel: reviewerSpawnMount?.model ?? null,
    servedModel: null,
    effort: reviewerSpawnMount?.effort ?? null,
    sessionId: null,
  };
  const attemptReviewer = args.spawnReviewer !== false && reviewerSpawnMount !== undefined && criteria.length > 0 && !planOnlySkip;
  let reviewerSubtype: string | undefined;
  let reviewerExit: WorkerResult["exit"];
  let reviewerSpawnFailed = false;
  let reviewerFindingText: string | undefined;
  if (planOnlySkip) {
    // The ledger must say WHICH PATH RAN. Without this row a skipped review and a completed one
    // differ only by the ABSENCE of `review.reviewer`, which is not something a query can count.
    log("review.reviewer.skipped", { reason: "plan-only", criteria: criteria.length });
  }
  if (attemptReviewer) {
    try {
      // W1-T115: routed through withTempDir so this throwaway cwd is ALWAYS
      // removed on exit — success or thrown error — instead of the bare
      // mkdtempSync this used to be, which never cleaned up on any path and
      // leaked one `rmd-review-*` dir per PR review (a major contributor to
      // the 26,711-dir ENOSPC incident: this runs on every gate check).
      await withTempDir("review", async (reviewRoot) => {
        const snapshot = materializeReviewerSnapshot(reviewRoot, args.headCheckoutDir, headSha);
        log("review.reviewer.materialized", {
          head_sha: headSha,
          node_modules: snapshot.nodeModules,
        });
        const prompt =
          buildReviewPrompt({
            task: { id: task.id, acceptance: criteria, ...narrative },
            prUrl,
            owner,
            repo,
            headSha,
            ...scopeContext,
          }) +
          "\n" +
          reviewerVerdictContract(criteria.length);
        const stopTelemetry = args.workerTelemetry?.startPolling();
        let reviewer: WorkerResult;
        const reviewerClockBoundMs =
          host.reviewerClockBoundMs(args.reviewerClockBoundMs);
        const reviewerClockBound = { clockBound: { boundMs: reviewerClockBoundMs } };
        const reviewerSpawnWorker = args.reviewerSpawnWorker ?? ledgeredNonDispatchSpawn("review");
        // W1-T4615: assigned before the provider call, so every later stream event names the routed model.
        let reviewerAssignment: WorkerSelectionAssignment | undefined;
        try {
          let priorSignal: string | undefined;
          for (;;) {
            reviewerAssignment = undefined as WorkerSelectionAssignment | undefined;
            reviewer = args.account(
              await reviewerSpawnWorker({
                cwd: snapshot.cwd,
                permissionMode: "bypassPermissions",
                settingsFile: args.settingsFile,
                // MOUNT-GOVERNED (§9, W1-T63/P10): model/effort/max_turns come from the
                // resolved "reviewer" mount, never a hardcoded literal. Before this, an
                // undeclared 12-turn cap with no model/effort override walled
                // `error_max_turns` on every substantive code PR — a floor-only PASS silently masquerading
                // as a completed review (P10-a; reviewerOutcome below makes it legible).
                model: reviewerSpawnMount!.model,
                mountProvider: reviewerSpawnMount!.provider,
                effort: reviewerSpawnMount!.effort,
                maxTurns: reviewerSpawnMount!.maxTurns,
                maxBudgetUsd: args.budgetUsd,
                config: args.config,
                queryFn: args.reviewerQueryFn, // W1-T2205: absent ⇒ the real SDK query(), unchanged.
                // W1-T2829/W1-T2946: preserve read-only tools while granting Codex narrow TMPDIR writes and dependency reads.
                tools: SPECIALIST_TOOLS, sandboxIntent: "disposable-review", sandboxReadRoots: snapshot.dependencyReadRoots,
                // REVIEW-CASH-DIVERT: OFFER THE CASH SURFACE. Without this the auction's divert chain refuses
                // this spawn outright ("tool surface is not implementable by cash"), which under a
                // full squeeze takes the REQUIRED `remudero-review` check down and with it every
                // merge on the board. One unconditional line, exactly like recon/diagnose — the
                // branch lives in `cashDivertSpawnFields`, where a unit test can reach it.
                ...cashDivertSpawnFields("review"),
                runId: args.runId,
                taskId: task.id,
                // Reviews are admission-gating work.  Give the advisory worker the same idle-activity
                // watchdog as dispatch workers so a provider/SDK stall cannot hold the decision claim
                // (and leave `remudero-review=pending`) forever.  The deterministic floor still posts
                // a terminal verdict when this bound trips.
                ...reviewerClockBound,
                onSelectionAssignment: (assignment) => { reviewerAssignment = assignment; },
                streamObserver: args.workerTelemetry ? (event) => args.workerTelemetry!.observer(attributeWorkerStreamEvent({ ...event, workerRole: "reviewer", cwd: snapshot.cwd, provider: reviewerSpawnMount!.provider, requestedModel: reviewerSpawnMount!.model }, reviewerAssignment)) : undefined,
                prompt, // NEVER resumeSessionId, NEVER forkSession — fresh by construction.
              }),
            );
            assertReviewerSnapshotIntegrity(host, snapshot.cwd, headSha);
            if (priorSignal !== undefined && reviewer.exit?.kind === "signal") {
              log("review.reviewer.signal_ended_twice", {
                first_signal: priorSignal, second_signal: reviewer.exit.signal,
              });
            }
            if (reviewerRerunDecision(reviewer, priorSignal) === "accept") break;
            priorSignal = (reviewer.exit as { kind: "signal"; signal: string }).signal;
            log("review.reviewer.rerun", { first_signal: priorSignal, session_id: reviewer.sessionId });
          }
        } finally {
          stopTelemetry?.();
        }
        const candidateSemantic = reviewerSemanticVerdicts(reviewer, criteria.length);
        semantic = candidateSemantic;
        reviewerFindingText = workerTranscript(reviewer);
        semanticClauses = parseReviewerVerdictClauses(reviewerFindingText, criteria.length);
        reviewerSubtype = reviewer.subtype;
        reviewerExit = reviewer.exit;
        const reviewerFields = workerLedgerFields(reviewer);
        evaluatorProvenance = {
          provider: reviewerFields.provider ?? null,
          requestedModel: reviewerFields.model,
          servedModel: reviewerFields.served_model,
          effort: reviewerFields.effort,
          sessionId: reviewer.sessionId ?? null,
          routedModel: reviewerFields.routed_model ?? reviewerAssignment?.selected.model ?? null,
          selectionAssignmentId: reviewerFields.selection_assignment_id ?? reviewerAssignment?.id ?? null,
        };
        log("review.reviewer", {
          session_id: reviewer.sessionId,
          subtype: reviewer.subtype,
          downgrades: semantic.filter((s) => s === false).length,
          // W1-T6: the advisory reviewer is a BRAIN-PLANE call — same telemetry
          // shape as a worker call, so ledger lines are queryable uniformly.
          ...reviewerFields,
          ...(reviewerFields.selection_assignment_id ? {}
            : reviewerAssignment ? { selection_assignment_id: reviewerAssignment.id }
            : { assignment_unavailable_reason: "assignment-not-observed" }),
          ...(reviewerFields.routed_model || !reviewerAssignment ? {} : { routed_model: reviewerAssignment.selected.model }),
        });
        await runShadowJudge({
          surface: "review", key: `${prUrl}:${headSha}:${decisionDigest}`,
          primaryMount: args.reviewerMount!, primaryDecision: candidateSemantic,
          primaryServedModel: reviewer.servedModel ?? reviewer.routedModel ?? null,
          mounts: () => [args.reviewerMount!, resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot)))],
          log,
          judge: async (mount) => {
            const shadow = args.account(await reviewerSpawnWorker({
              cwd: snapshot.cwd, permissionMode: "bypassPermissions", settingsFile: args.settingsFile,
              model: mount.model, mountProvider: mount.provider, effort: mount.effort,
              maxTurns: Math.min(mount.maxTurns, 12), maxBudgetUsd: SHADOW_JUDGE_MAX_BUDGET_USD,
              config: args.config, queryFn: args.reviewerQueryFn,
              tools: ["Read", "Grep", "Glob"], sandboxIntent: "disposable-review",
              sandboxReadRoots: snapshot.dependencyReadRoots,
              runId: args.runId, taskId: task.id,
              clockBound: { boundMs: Math.min(reviewerClockBoundMs, 60_000) },
              prompt,
            }));
            assertReviewerSnapshotIntegrity(host, snapshot.cwd, headSha);
            return {
              decision: reviewerSemanticVerdicts(shadow, criteria.length),
              servedModel: shadow.servedModel ?? shadow.routedModel ?? null,
            };
          },
        });
        // The reviewer is fresh (no resume) — reap its SDK scratchpad now, before
        // withTempDir removes reviewCwd. Best-effort, guarded (lib/worker-scratch).
        reapWorkerScratch(snapshot.cwd);
      });
    } catch (e) {
      // Advisory only — the deterministic floor still binds and posts below.
      reviewerSpawnFailed = true;
      if (e instanceof WorkerAbandonedError) {
        log("review.reviewer.abandoned", reviewerAbandonmentLedgerFields(e));
      }
      if (e instanceof ReviewerSnapshotError) {
        log(`review.reviewer.${e.phase}_error`, { reason: e.reason, error: e.message });
      }
      log("review.reviewer.error", { error: String((e as Error)?.message ?? e) });
    }
  }
  // W1-T63/P10-a: LEGIBLE outcome of the reviewer spawn — a floor-only PASS
  // (never attempted, or attempted but walled/spawn-failed) is never
  // byte-identical in the ledger/console to a review the reviewer COMPLETED.
  const outcome = reviewerOutcome({
    attempted: attemptReviewer,
    subtype: reviewerSubtype,
    exit: reviewerExit,
    spawnError: reviewerSpawnFailed,
    // Reported from what ACTUALLY happened, never from the classification alone: `planOnlySkip &&
    // !attemptReviewer` is true only when the spawn was really not dispatched. Measured while
    // falsifying this change — with the gate removed but the flag still passed, a run that DID
    // spawn still reported `not_attempted_plan_only`, i.e. the ledger lied in the one direction
    // this outcome exists to prevent.
    planOnlySkip: planOnlySkip && !attemptReviewer,
  });
  replayInput = { ...replayInput, stage: "semantic", plan_only: planOnlySkip,
    criteria_count: criteria.length, reviewer_outcome: outcome,
    verdict_lines: recordedReviewVerdictLines(reviewerFindingText ?? "", criteria.length) };
  const replayDecision = classifyReviewOutcome(replayInput);
  const semanticRefusal = replayDecision.class === "posted" ? undefined : replayDecision.reason;
  if (semanticRefusal !== undefined) {
    recordReplay(replayDecision);
    log("review.semantic_incomplete", { reason: semanticRefusal, head_sha: headSha, pr_url: prUrl,
      reviewer_outcome: outcome, review_decision_digest: decisionDigest });
    say(`remudero-review: verdict WITHHELD — ${semanticRefusal}; no verdict publication or merge effect`);
    return { state: "failure", criteria: [], cannotEvaluate: true, testTheater: false,
      summary: semanticRefusal, floorDegraded: true, capped: true, keywordOnly: false, planOnly: false,
      headSha, reviewerOutcome: outcome, verdictWithheld: semanticRefusal,
      reviewDecisionDigest: decisionDigest, evaluatorProvenance };
  }
  // A missing envelope is UNKNOWN, not a measured zero. Parse is bounded and purely
  // advisory; a filesystem/telemetry problem cannot become a review failure.
  let findingCapture: FindingCapture = { state: "unavailable", findings: [], verifiedCount: 0, invalidCount: 0, droppedCount: 0 };
  if (outcome === "success" && reviewerFindingText !== undefined && args.headCheckoutDir) {
    try {
      findingCapture = extractReviewFindings({ owner, repo, prUrl, headSha, root: args.headCheckoutDir, diff,
        criteriaCount: criteria.length, text: reviewerFindingText });
    } catch { /* The existing reviewer verdict and status still proceed. */ }
  }

  // BINDING deterministic verdict; the orchestrator is the authoritative poster.
  // W1-T65 (ratifies P15): headCheckoutDir wires the FLOOR's whitelisted-proof
  // execution to the PR HEAD (never the operator's working checkout) — so the
  // gate observes repo state whether or not the advisory reviewer above ever
  // completed.
  // W1-T4423: a plan-only PASS names lint-plan, so the review runs it on the target repo's plan at this head.
  const planLint = planOnlySkip ? await (args.lintPlanForReviewFn ?? lintPlanForReview)(args.headCheckoutDir) : undefined;
  const computed = await preparedDecision.judge({
    diff,
    report,
    planLint,
    headRefName: args.headRefName,
    reservationOwnership: ownership,
    baseTaskIdDeclarations: taskIdEvidence.baseDeclarations,
    implementationReport: args.implementationReport,
    target: { owner, repo },
    // W1-T1100: threaded straight from this call's own args — see this arg's own doc.
    reportIsSubstitute: args.reportIsSubstitute,
    reportSubstituteCause: args.reportSubstituteCause,
    semantic,
    semanticClauses,
    headCheckoutDir: args.headCheckoutDir,
    baseCheckoutDir: args.baseCheckoutDir,
    baseUnreadablePaths: args.baseUnreadablePaths,
    baseIsCheckout: args.baseIsCheckout,
    addedTestFiles: args.addedTestFiles,
    // W1-T322: advisory-only inputs — see ReviewEvidence's own doc for both fields.
    taskDeclaredFiles: task.files,
    openTaskIds: args.openTaskIds,
  });

  // W1-T359: ADVISORY rubric layer — invoked AFTER `computed` above, over the
  // SAME `diff`/`report` the binding verdict just judged, and consulted by
  // NOTHING downstream of it: `computed`/`verdict`/the arm decision are already
  // fixed values by the time this runs, so a rubric finding can never change
  // them (the falsifier this satisfies: the verdict is byte-identical with the
  // rubric stubbed out). `judgeRubric` is deterministic string/regex analysis
  // over `diff`/`report` — no model call, no mount, no extra spawn cost — so a
  // throw here (there should never be one) is caught and degrades to exactly
  // today's review: no advisory section, the binding verdict/post unaffected.
  let rubric: ReturnType<typeof judgeRubric> | undefined;
  try {
    // W1-T385: `humanAuthored` had NO producer anywhere in the tree, so the guard's
    // `planOnly && humanAuthored` exemption could never fire and its refusal asserted a
    // worker author on hand-opened plan-only PRs. Derived here from the head ref — the
    // only authorship signal this path holds — rather than left undefined: `reviewCommand`
    // (the operator's `rmd review` AND the sweep's post-review lane) passes `headRefName`
    // straight from `gh pr view`. `runFixRung`'s call site passes none, and that is a
    // dispatched run amending its own run branch, so `undefined ⇒ false` is the correct
    // answer there and not merely the safe one.
    const rubricInput = {
      diff,
      report,
      planOnly: computed.planOnly,
      humanAuthored: args.headRefName !== undefined && !isDispatchedRunBranch(args.headRefName),
    };
    // The default branch keeps the literal `judgeRubric(...)` call — this task's own structural
    // test asserts that text is present in runReview's body, and the seam must not weaken it.
    rubric = args.judgeRubricFn ? args.judgeRubricFn(rubricInput) : judgeRubric(rubricInput);
  } catch (e) {
    log("review.rubric.error", { error: String((e as Error)?.message ?? e) });
  }

  // W1-T178: suppress semantic noise only for the same known head, body and contract.
  // A changed engine or task narrative is new information, not an unchanged review.
  // Missing recorded identity cannot certify that the prior verdict judged these inputs.
  // The stability rule remains asymmetric; an improved verdict always proceeds.
  const contractDigest = reviewContractDigest({
    taskId: task.id,
    acceptance: task.acceptance ?? [],
    declaredFiles: task.files,
    risk: task.risk,
    budgetUsd: task.budget_usd ?? args.budgetUsd,
    ...narrative,
  });
  const prior = args.ledgerPath && inputDigest !== undefined
    ? priorReviewVerdictFromLedger(readLedgerLines(args.ledgerPath).filter((line) => line.review_input_digest === inputDigest), task.id, args.prUrl)
    : undefined;
  let { verdict, suppressed } = applyVerdictStability(computed, headSha,
    prior?.reviewContractDigest === contractDigest ? prior : undefined);
  verdict = { ...verdict, reviewContractDigest: contractDigest };

  // W1-T3704 (completed here) — RECORD WHAT THIS VERDICT ACTUALLY JUDGED, so a LATER push can be compared against
  // it instead of re-deriving a verdict that did not change. `ReviewVerdict.ownDiffDigest` and
  // `mergeBaseSha` have existed since W1-T3704 and NOTHING EVER SET EITHER — which is why
  // `reviewReuseVerdict` (lib/sweep.ts) returned `full-review` unconditionally and an orphaned
  // review was always re-run from scratch.
  //
  // ATTACHED HERE, AFTER `applyVerdictStability`, ON PURPOSE. These two values describe the PR
  // this pass looked at; they are not an input to the pass/fail judgment and must not be able to
  // influence it. Everything above this line — `computed`, the stability suppression, the floor —
  // is byte-identical with this block deleted, which is the falsifier the PR body reports.
  //
  // BEST-EFFORT, AND ITS FAILURE DIRECTION IS THE SAFE ONE: an unreadable compare leaves both
  // fields absent, the ledger line omits them, and every reader treats absence as "re-review in
  // full". The reuse path can only ever be *skipped* by a failure here, never wrongly taken.
  const reuseFacts = (args.readReviewReuseFacts ?? (() => tryFetchReviewReuseFacts(owner, repo, "main", headSha, ghJson)))();
  if (reuseFacts) verdict = { ...verdict, ...reuseFacts };

  let decisionDisposition: "computed" | "conflict" = "computed";
  if (suppressed) {
    // VISIBLE, not silently swallowed: names the sha + both verdicts + the
    // floor result a suppression relied on, distinct from the review.posted
    // line below (which now carries the SUCCESS actually posted).
    log("review.downgrade_suppressed", {
      head_sha: headSha,
      predecessor_state: prior!.state,
      suppressed_state: computed.state,
      floor_state: computed.floorState,
    });
    say(
      `remudero-review: semantic downgrade SUPPRESSED on unchanged head ${headSha.slice(0, 7)} — ` +
        `deterministic floor still passes; prior verdict (success) stands (verdict-stability, W1-T178)`,
    );
  }

  // W1-T233: a CAPPED verdict caused by a materialization failure carries the
  // named reason on the posted description itself — the operator reading the
  // commit status (not just the ledger) sees WHY, never only "unavailable".
  const description = reviewPostedDescription(verdict, args.materializationFailure);
  // W1-T10269: the shadow's would-be terminal. It reached publication and publishes nothing.
  if (args.shadow) {
    log(REVIEWER_SHADOW_VERDICT_STEP, { state: verdict.state, head_sha: headSha, pr_url: prUrl, reviewer_outcome: outcome,
      review_decision_digest: decisionDigest });
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: "reviewer-health shadow: no publication",
      reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }

  // impl-BF — WITHDRAW AN EXISTING ARM BEFORE THE STATUS GOES UP.
  //
  // A worker PR is armed AT OPEN (armAutoMergeAtOpen, ~16s after the PR exists) before any
  // verdict is computed. PR #831 taught the SWEEP to refuse to ARM a proof-failure cap, but
  // nothing withdrew an arm already on GitHub: `disarmAutoMerge` had exactly two call sites,
  // both inside `runTask`, so a cap posted from `reviewCommand` (the operator's `rmd review`
  // AND the sweep's post-review lane, which reaches this same function via `runReviewDep`)
  // left the arm standing. Live: PR #969 posted "CAPPED — 0/4 proofs executed; not certified"
  // at 23:34:42Z and GitHub merged it at 23:34:44Z. Two seconds.
  //
  // ORDER IS THE FIX: this runs BEFORE `postReviewStatusGuarded` below, so the arm is gone
  // before the required status can be satisfied. Disarming after the post would race GitHub —
  // and #969 shows that race is lost in about two seconds.
  //
  // THE DECISION IS NOT RE-DERIVED: `decideAutoMergeArm` is the SAME predicate the arming
  // path uses, so the W1-T205 carve-out (a plan-only PR is structurally, permanently capped
  // and MUST stay armed) is preserved by construction rather than by a second copy of the
  // rule — two copies of exactly this rule are how the sweep and the run flow diverged.
  // `disarmAutoMerge` never throws and is a no-op-ish on an unarmed PR, so this needs no
  // extra API call to learn whether the PR was armed.
  withdrawArmIfVerdictRefuses(
    verdict,
    { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, log },
    { disarm: args.disarm },
  );

  // W1-T228: the ONLY call path that posts `remudero-review` from here on —
  // acquires the per-task serialization lock, re-reads the ledger + live PR
  // lifecycle INSIDE it, and refuses (ledgering the refusal) rather than
  // overwrite an executed-evidence verdict with a weaker one, or write
  // against an already-merged/closed PR. See lib/review.ts's W1-T228 block
  // comment for the full design.
  if (verdict.taskIdOwnershipWithheld) {
    replayInput = { ...replayInput, publication_refusal: "task-id-ownership-withheld" };
    recordReplay(classifyReviewOutcome(replayInput));
    // W1-T4414: an unreadable reservation holds the verdict — no terminal status, the same channel every caller honours.
    log("review.post_refused", withheldReviewRefusalRow({ headSha, prUrl, reason: verdict.taskIdOwnershipWithheld, ownership: verdict.taskIdOwnership, inputDigest }));
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — ${verdict.taskIdOwnershipWithheld}`);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: verdict.taskIdOwnershipWithheld, reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  let reviewerCodeFreshness: ReviewerCodeFreshness | undefined;
  try {
    reviewerCodeFreshness = await args.reviewerCodeFreshness?.();
  } catch (error) {
    reviewerCodeFreshness = { status: "unreadable", reason: `could not assess reviewer code freshness: ${String(error)}` };
  }
  const posted = await postReviewStatusGuarded({
    owner,
    repo,
    sha: headSha,
    state: verdict.state,
    description,
    taskId: task.id,
    evidence: reviewEvidenceStrength(verdict.criteria),
    ledgerPath: args.ledgerPath,
    runId: args.runId,
    prUrl,
    reviewInputDigest: inputDigest,
    reviewDecisionDigest: decisionDigest,
    reopenedDegradedTerminal: decisionClaim.reopenedDegradedTerminal,
    reviewEngineRevision: REVIEW_ENGINE_REVISION,
    evaluatorProvenance,
    reviewerCodeFreshness,
    fetchLifecycle: () => fetchPrLifecycle(prUrl),
  });
  if (posted.conflict) {
    decisionDisposition = "conflict";
    verdict = {
      ...verdict,
      state: "failure",
      summary: `review verdict conflict for decision ${decisionDigest.slice(0, 11)} — operator adjudication required`,
    };
    withdrawArmIfVerdictRefuses(
      verdict,
      { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, log },
      { disarm: args.disarm },
    );
    if (!posted.posted) {
      replayInput = { ...replayInput, publication_refusal: "conflict-hold-publication-failed" };
      recordReplay(classifyReviewOutcome(replayInput));
      say(`remudero-review: conflict hold FAILED to post for ${headSha.slice(0, 7)} — ${posted.reason}`);
      return { ...verdict, headSha, reviewerOutcome: outcome, reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
    }
  } else if (!posted.posted) {
    replayInput = { ...replayInput, publication_refusal: "terminal-publication-refused" };
    recordReplay(classifyReviewOutcome(replayInput));
    // REFUSED, NOT SWALLOWED: postReviewStatusGuarded already ledgered
    // `review.post_refused` with the full reason; this is the loud console
    // twin so a refusal is as visible as an ordinary posted verdict is.
    say(
      `remudero-review: post REFUSED for ${headSha.slice(0, 7)} (verdict computed: ${verdict.state}) — ` +
        `${posted.reason} (W1-T228 — see the review.post_refused ledger line)`,
    );
    return {
      ...verdict,
      headSha,
      reviewerOutcome: outcome,
      ...(reviewerCodeFreshness !== undefined && reviewerCodeFreshness.status !== "fresh"
        ? { verdictWithheld: posted.reason ?? "reviewer code freshness withheld the terminal verdict" }
        : {}),
      reviewDecisionDigest: decisionDigest,
      decisionDisposition,
      evaluatorProvenance,
    };
  }
  const unmet = verdict.criteria.filter((c) => !c.met);
  // W1-T166: holdout criteria are reviewer-visible but WORKER-hidden. `verdict.state`
  // above already folded them into the pass/fail decision; the DISPLAYED claim/reason
  // text below must not — this feeds the `review.posted` ledger's `unmet_criteria`/
  // `reasons` (which a cold-dispatch fix rung reconstructs verbatim, unmetFromLedger)
  // AND the PR comment further down, both `gh`-readable by the very worker a holdout
  // criterion must never reach.
  const visibleUnmet = visibleCriteria(unmet);
  const unmetClaims = visibleUnmet.map((c) => c.claim);
  // W1-T1016: `reviewLedgerReasons` is the SAME pure rule this line used to compute inline
  // (per-visible-unmet-criterion reason + testTheater), now ALSO covering the changeset-
  // contradiction path so `reasons` is never `[]` for the one failure shape the fleet already
  // owns a `blocked-fixable` disposition row for — see that function's own doc (lib/review.ts).
  const reasons = reviewLedgerReasons(verdict);
  // OBSERVABILITY (W1-T65 design): per-criterion proof_exec outcome, so an
  // OBSERVED verdict (executed_pass/executed_fail) is legible on the ledger vs a
  // KEYWORD one (not_executable), and an environment hiccup (exec_error) is never
  // silently indistinguishable from either.
  const proofExec = verdict.criteria.map((c) => c.proof_exec);
  // The gate TEACHES: the FULL list of unmet criteria goes to the ledger (and the
  // PR comment below) — the status description names only the first (length-capped).
  const reviewPostedRow = {
    context: REVIEW_CONTEXT,
    state: verdict.state,
    head_sha: headSha,
    pr_url: prUrl,
    ...(inputDigest !== undefined ? { review_input_digest: inputDigest } : {}),
    review_engine_revision: REVIEW_ENGINE_REVISION,
    ...(runtimeImageSha !== undefined ? { runtime_image_sha: runtimeImageSha } : {}),
    review_decision_digest: decisionDigest,
    decision_verdict: verdict,
    evaluator_provenance: evaluatorProvenance,
    ...(reviewerCodeFreshness !== undefined ? { reviewer_code_provenance: reviewerCodeFreshness } : {}),
    test_theater: verdict.testTheater,
    unmet_criteria: unmetClaims,
    reasons,
    // W1-T63/P10-a: makes a floor-only PASS LEGIBLE — never byte-identical to a
    // review the LLM reviewer actually completed.
    reviewer_outcome: outcome,
    finding_capture_state: findingCapture.state,
    finding_verified_count: findingCapture.verifiedCount,
    finding_unverified_count: findingCapture.findings.length - findingCapture.verifiedCount,
    finding_invalid_count: findingCapture.invalidCount,
    finding_dropped_count: findingCapture.droppedCount,
    // W1-T65/P15: per-criterion proof_exec, index-aligned to verdict.criteria.
    proof_exec: proofExec,
    // W1-T72 (W1-T65 follow-up): LOUD legibility — true when execution fell
    // back to the keyword floor on EVERY criterion while at least one proof
    // was WRITTEN to be runnable (house dialect). NO blocking-behavior change:
    // `state` above is exactly what it always was.
    floor_degraded: verdict.floorDegraded,
    // W1-T233: the named reason (+ class) `headCheckoutDir` was absent, when
    // it is absent because materialization was ATTEMPTED and failed — queryable
    // directly rather than only readable from prose, so a degraded verdict
    // never again says only "unavailable". See degradedReasonLedgerFields's
    // own doc for why this is a shared function, not hand-copied fields.
    ...reviewLedgerReasonFields({ decisionDisposition, materializationFailure: args.materializationFailure }),
    // W1-T185 (criterion 5): `capped` — computed UNCONDITIONALLY, never forcing
    // `state`/`floor_state` (CAPPED IS NOT FAIL); consequential only via the
    // SEPARATE auto-merge arming path (decideAutoMergeArm, below), which
    // refuses ANY capped verdict since W1-T229 — and `keyword_only` — true
    // when NO PR-head checkout was given at all (e.g. `rmd review`'s
    // manual-PR path). Read off `verdict`
    // through `reviewLedgerLegibilityFields` so the ledger line names EXACTLY
    // the same two facts the posted status description rendered, never a
    // hand-copied projection that could drift from it.
    ...reviewLedgerLegibilityFields(verdict),
    // W1-T178: the deterministic anchor `state` was checked against, and
    // whether this line's `state` is a suppressed downgrade rather than a
    // review that genuinely passed — always present, never inferred.
    floor_state: computed.floorState,
    downgrade_suppressed: suppressed,
    // W1-T166: the reward-hacking measurement — visible-pass-rate minus
    // holdout-pass-rate for this run, `null` when not measurable (no holdout
    // criteria declared). See ReviewVerdict.rewardHackingGap's doc.
    reward_hacking_gap: verdict.rewardHackingGap,
    // W1-T1118: the reachability scan's EXAMINED population, riding this ALREADY-EMITTED row
    // rather than a new ledger line — a NUMBER (0 included) when the scan ran, `null` when the
    // `if (checkoutDir)` guard skipped it entirely. See ReviewVerdict.reachabilityScanned's doc
    // for the three-state silence this separates: no checkout (`null`), scanned N and cleared all
    // N (`N` with no `review.unwired_advisory` line below), and a diff that added no exported
    // function at all (`0`).
    reachability_scanned: verdict.reachabilityScanned ?? null,
    // W1-T1264 (design (i)/(iii)): the changeset-claims-recognised count, riding this
    // ALREADY-EMITTED row rather than a new ledger line — see
    // ReviewVerdict.changesetClaimsRecognised's doc for why a bare `changesetContradictions: []`
    // above cannot tell "never read a claim" apart from "checked, and it agrees", and
    // CHANGESET_CLAIM_FALSIFIER_NOTE (lib/review.ts) for how an author reads this number.
    // `null` (never `0`) mirrors `changesetContradictions`'s own substitute-withholding above.
    changeset_claims_recognised: verdict.changesetClaimsRecognised ?? null,
    // W1-T1264 design (iv): true when the quote-stripping pass reached end-of-body still inside an
    // open fence, silently starving the count above — named rather than left to read as a mundane
    // zero.
    changeset_fence_unbalanced_at_eof: verdict.changesetFenceUnbalancedAtEof ?? null,
  };
  log("review.posted", reviewPostedRow);
  recordReplay(replayDecision);
  // W1-T322 (SHIPS-UNWIRED advisory floor): ADVISORY ONLY — ledgered here, never consulted by the
  // verdict/arm decision above or below. One `review.unwired_advisory` line per reason code (see
  // {@link "../../lib/review.js".UnwiredAdvisory}'s doc), naming the PR (taskId + headSha + prUrl), the
  // reason code and the offending symbols — this is the dataset W1-T323's measurement window reads.
  // ADVISORY BECAUSE NO ARM READS IT, NOT BECAUSE IT IS EXCLUDED FROM ROTATION RETENTION. This
  // comment used to say the step was "NOT added to DECISION_RELEVANT_LEDGER_STEPS, deliberately",
  // deferring registration to W1-T323's own change. That became false when W1-T1017 registered
  // `review.unwired_advisory` in that Set (lib/ledger.ts) AHEAD of the flip, because rotation was
  // dropping 95%+ of these rows — live 4 / rotations 83, against a `review.posted` control of live
  // 219 / rotations 390 — and the corpus W1-T323 must be adjudicated against was being archived
  // out from under it. MEMBERSHIP IN THAT SET MEANS RETENTION, NOT BLOCKING: it keeps the newest
  // rows past rotation and gives no arm a reason to consult them. The conclusion above is
  // unchanged — nothing in the verdict or arm path decides off this step — only the stated reason
  // was wrong, and a lane wrote a test asserting the absence this comment implied.
  for (const advisory of verdict.unwiredAdvisories ?? []) {
    log("review.unwired_advisory", {
      pr_url: prUrl,
      head_sha: headSha,
      reason_code: advisory.reasonCode,
      symbols: advisory.symbols,
      detail: advisory.detail,
    });
  }
  // impl-BL — THE MIRROR OF THE WITHDRAWAL ABOVE, AND IT MUST STAY BELOW THE `log("review.posted")`
  // CALL ABOVE. That line is the evidence W1-T230's gate requires: `armAutoMerge` →
  // `priorReviewVerdictFromLedger` → `decideArmFromLedgerVerdict` looks for a `review.posted` line
  // matching this taskId AND headSha, and fails CLOSED when it finds none. It once sat right after
  // `postReviewStatusGuarded`, which writes no `review.posted`, so every gated arm was refused
  // (PR-977: the refusal at 00:57:06.808, its row at .809).
  //
  // A ROW CAN STILL GO MISSING: a concurrent rotation (serve and the daemon share the volume) lost
  // PR #8887's row. W1-T5514 drains that window, but a read between its rename and drain can still
  // miss it. So THIS run's row is re-read and re-appended, ledgering `review.posted_reappended`,
  // before the gate reads (W1-T5516). The gate never falls back to GitHub's status: that surface is
  // mutable (W1-T230, #449). A failed re-read appends nothing and the gate fails closed as before.
  //
  // The gate still does real work: `armAutoMerge` re-reads the PR's CURRENT head and refuses a push
  // that landed after this verdict. No `posted.posted` guard is needed: that branch already returned.
  reappendLostReviewPosted({ ledgerPath: args.ledgerPath, runId: args.runId, headSha, decisionDigest, prUrl,
    row: reviewPostedRow, log, say });
  const armCtx = { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, headRefName: args.headRefName, log };
  armIfVerdictPermits(verdict, armCtx, { arm: args.arm });
  // Record after both authoritative posting and auto-merge eligibility. The recorder
  // swallows telemetry write failures; replay returns above before reaching this call.
  recordReviewFindings(findingCapture, { taskId: task.id, prUrl, headSha, decisionDigest,
    provenance: evaluatorProvenance, log });
  if (verdict.capped) {
    // W1-T1085: the annotation gets the SAME `planOnly` fact the status three-ways on, so one run
    // stops emitting two contradictory sentences about one verdict. No decision changes here.
    say(cappedAnnotation(proofExec.length, verdict.planOnly === true));
  } else if (verdict.floorDegraded) {
    say(floorDegradedAnnotation(proofExec.length));
  }
  if (verdict.keywordOnly && !verdict.capped) {
    say(keywordOnlyAnnotation());
  }
  const hasUnmet = verdict.state !== "success" && (unmetClaims.length > 0 || verdict.testTheater);
  // W1-T359: the rubric's advisory section — present whenever `judgeRubric` found
  // something, INDEPENDENT of `verdict.state` (a rubric concern, e.g. two unrelated
  // things in one PR, can surface on an otherwise-passing review). Folded into the
  // SAME best-effort PR review as the unmet-criteria block below rather than a
  // second review submission, so a rubric finding never gets its own separate
  // network path to fail on.
  const rubricSection = rubric ? rubricAdvisorySection(rubric) : undefined;
  // W1-T434: the declared-scope overrun's own section, folded into the SAME best-effort comment
  // for the same reason the rubric is — a scope finding never gets its own network path to fail
  // on. Reads `verdict.unwiredAdvisories`, which the loop above has already ledgered, so the PR
  // comment and the `review.unwired_advisory` line cannot disagree about one PR. Present
  // INDEPENDENT of `verdict.state`: an overrun is normal on an otherwise-passing review (that is
  // W1-T401's measured majority), and it is exactly the passing case where nothing else would
  // ever mention it.
  const scopeSection = scopeAdvisorySection(verdict.unwiredAdvisories);
  // The `unwired_export` sibling, folded into the SAME comment for the same reasons: it reads the
  // advisory the loop above has already ledgered (so comment and `review.unwired_advisory` cannot
  // disagree), it gets no separate network path to fail on, and it is present INDEPENDENT of
  // `verdict.state` — an unreached export is normal on an otherwise-passing review, and the
  // passing case is exactly where nothing else would ever mention it. Advisory only: whether an
  // unwired export should BLOCK is W1-T323's open operator adjudication, not this call site's.
  const unwiredSection = unwiredExportAdvisorySection(verdict.unwiredAdvisories);
  // The third and last renderable sibling (`unresolved_task_scope`, the fourth reason code, is
  // deliberately NOT rendered — its evidence field has no producer in src/, so a section for it
  // would be dead code; see inverseScopeAdvisorySection's doc). Same contract as the two above:
  // reads the advisory the loop already ledgered, shares their one best-effort comment, and is
  // present INDEPENDENT of `verdict.state` because an undertouched declared scope is normal on an
  // otherwise-passing review — the passing case being exactly where nothing else would mention it.
  // Advisory only: blocking is W1-T323's open adjudication, not this call site's.
  const inverseScopeSection = inverseScopeAdvisorySection(verdict.unwiredAdvisories);
  const parts: string[] = [];
  if (hasUnmet) {
    parts.push(
      `**remudero-review=failure** — the following acceptance ${unmetClaims.length === 1 ? "criterion is" : "criteria are"} unmet:\n\n` +
        visibleUnmet.map((c, i) => {
          const tail = c.failureTail?.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
          return `${i + 1}. ${c.claim}\n   - ${reasons[i]}` + (tail
            ? `\n\n   <details>\n   <summary>Proof failure output</summary>\n\n   <pre>${tail}</pre>\n   </details>\n`
            : "");
        }).join("\n") +
        (verdict.testTheater ? `\n\n_Also: test theater — added tests assert nothing._` : "") +
        `\n\nAdd the missing work (or escalate). Do NOT edit the acceptance criteria to match the diff.`,
    );
  }
  if (rubricSection) parts.push(rubricSection);
  if (scopeSection) parts.push(scopeSection);
  if (unwiredSection) parts.push(unwiredSection);
  if (inverseScopeSection) parts.push(inverseScopeSection);
  if (parts.length === 0) parts.push(`**remudero-review=${verdict.state}** — ${verdict.summary}`);
  const body = parts.join("\n\n---\n\n");
  postReviewCommentGuarded(prUrl, body, { commitSha: headSha });
  // W1-T63/P10-a: the console summary distinguishes a completed review from a
  // floor-only one (reviewer never attempted, or attempted but walled/failed).
  // W1-T65/P15: and now names how many criteria the FLOOR itself OBSERVED
  // (executed_pass/executed_fail) vs judged on report keywords (not_executable) —
  // legible whether or not the sentence above ever completed.
  const executed = proofExec.filter((p) => p === "executed_pass" || p === "executed_fail").length;
  say(
    `remudero-review=${verdict.state} posted to ${headSha.slice(0, 7)} — ${verdict.summary} ` +
      `(reviewer_outcome: ${outcome}; proof_exec: ${executed}/${proofExec.length} observed on the PR head)`,
  );
  return {
    ...verdict, headSha, reviewerOutcome: outcome,
    reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance,
  };
  } finally {
    decisionClaim.release();
  }
}

/**
 * W1-T4933: the REVIEWER's call site of the staged install. `reviewCommand` cuts its worktrees from a managed checkout and
 * links that checkout's node_modules, so a tree that predates the lockfile fails the proofs it runs (six on console PR #1866).
 * Dispatch's {@link refreshManagedCheckout} shares no path with it. Under the same checkout lock; a held lock or a failed
 * install is ledgered and the review goes on against the tree that is there (a failure keeps the old one).
 */
export function refreshReviewSubjectInstall(
  repoDir: string,
  lockPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  escalate?: (failure: StagedInstallFailure) => void,
  install: (repoDir: string) => void = (dir) => void stagedInstall(dir, { log, escalate }),
): void {
  if (!existsSync(join(repoDir, "node_modules"))) return;
  let lock: DrainLockHandle;
  try {
    lock = acquireDrainLock(lockPath);
  } catch (error) {
    log("review.subject_install_skipped", { reason: `another dispatch holds ${lockPath} (${String((error as Error)?.message ?? error)})` });
    return;
  }
  try {
    install(repoDir);
  } catch (error) {
    log("review.subject_install_kept_stale", { reason: String((error as Error)?.message ?? error).slice(0, 512) });
  } finally {
    lock.release();
  }
}

/** Result of {@link materializeReviewWorktree}: either a usable path, or a
 * clean workspace (nothing left behind) plus the named reason it failed. */
export type MaterializeReviewWorktreeResult =
  | { worktreePath: string; failure?: undefined }
  | { worktreePath: undefined; failure: MaterializationFailure };

/** Manual review cause annotation; an in-flight claim is not a missing PR-head checkout. */
export function reviewVerdictAnnotation(
  verdict: Pick<ReviewVerdict, "keywordOnly"> & Partial<Pick<ReviewRunResult, "decisionDisposition">>,
): string {
  if (verdict.decisionDisposition === "in_flight") return "HELD: identical review decision is already in flight";
  return verdict.keywordOnly ? "KEYWORD-ONLY: no proof was executed (no PR-head checkout)" : "";
}

/** The `review.posted` ledger line's degraded-reason fields (W1-T233) —
 * mirrors {@link reviewLedgerLegibilityFields}'s pattern: one function the
 * real log call AND a unit test both read the SAME two fields through, so
 * they can never hand-drift apart. Both fields are simply absent (dropped by
 * `JSON.stringify`) when materialization was never attempted at all. */
export function degradedReasonLedgerFields(materializationFailure?: MaterializationFailure): {
  degraded_reason?: string;
  degraded_reason_class?: MaterializationErrorClass;
} {
  return {
    degraded_reason: materializationFailure?.message,
    degraded_reason_class: materializationFailure?.errorClass,
  };
}

/** Stable, countable causes for review degradation or a held decision. */
export function reviewLedgerReasonFields(args: {
  decisionDisposition?: ReviewRunResult["decisionDisposition"];
  materializationFailure?: MaterializationFailure;
}): {
  review_reason?: "decision_in_flight" | "materialization_failure";
  review_reason_detail?: string;
  decision_disposition?: "in_flight";
  degraded_reason?: string;
  degraded_reason_class?: MaterializationErrorClass;
} {
  if (args.decisionDisposition === "in_flight") {
    return {
      review_reason: "decision_in_flight",
      review_reason_detail: "identical review decision is already in flight",
      decision_disposition: "in_flight",
    };
  }
  if (args.materializationFailure) {
    return {
      review_reason: "materialization_failure",
      review_reason_detail: `${args.materializationFailure.errorClass}: ${args.materializationFailure.message}`,
      ...degradedReasonLedgerFields(args.materializationFailure),
    };
  }
  return {};
}

/**
 * Injectable seams for `reviewCommand` (W1-T70): each defaults to the real `gh`/config/
 * worktree/review plumbing, so a test can drive the taskId/criteria-resolution codepath
 * this task fixed — the exact block that used to read as 0 lcov hits inside a function no
 * test could otherwise reach without a live `gh` auth + git checkout — end to end, without
 * a real `gh` call, a real `~/.config/remudero/config.json` touch, or a real worktree/LLM
 * spawn. Every default is an OBJECT-SPREAD MERGE (`{ x: realX, ...deps }`) reusing an
 * EXISTING top-level binding (`ghJson`/`loadConfig`/`materializeReviewWorktree`/`runReview`)
 * — never a `??`/ternary (which V8 instruments as a branch, so an override-only test would
 * leave the untaken "real" side permanently uncovered and regress the aggregate branch
 * ratchet) and never a freshly-extracted "default" wrapper function (whose own body would
 * be a brand-new, never-invoked-under-test line this same gate would then flag).
 */
export interface ReviewCommandDeps {
  /** Bounded admission identity, separate from the existing worker/run and ownership conventions. */
  reviewAttemptId?: string;
  contributorAdmission?: AdmissionObserver;
  fetchView?: (args: string[]) => unknown;
  loadConfig?: () => Config;
  materialize?: ReviewCommandHost["materializeReviewWorktree"];
  withMaterialized?: ReviewCommandHost["withMaterializedWorktree"];
  buildBaseProof?: typeof buildBaseProofDir;
  runReview?: (args: Parameters<typeof runReview>[1]) => ReturnType<typeof runReview>;
  postStatus?: typeof postReviewStatusGuarded;
  reviewerCodeFreshness?: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>;
  /** W1-T913: injectable so a test can observe the pending post without a real `gh` spawn — see
   *  `postReviewPending`'s call site below. Defaults to the real {@link postReviewPending}. */
  postReviewPending?: typeof postReviewPending;
  /** W1-T2511: the head-sha fetch, hoisted ABOVE criteria resolution. Same signature and same
   *  default implementation as {@link ReviewWorktreeDeps.fetch}, deliberately — the materializer
   *  still runs its own, and a second fetch of an already-fetched ref is a no-op, so this adds an
   *  ordering guarantee rather than a second network cost. Injectable so a test can drive the
   *  unfetched-sha case without a network. */
  fetchHead?: (repoDir: string, prNumber: number, headSha?: string) => void;
  /** Operator CLI remains deterministic; only internal unattended callers opt in. */
  executionMode?: "deterministic" | "semantic";
  /** W1-T3115: the sweep already proved this from GitHub's complete material file list. Carry
   *  that fact across the process boundary instead of making reviewCommand reclassify with the
   *  narrower emitter-ledger evidence available here. Undefined preserves the operator CLI. */
  planOnlyFiling?: boolean;
  /** Test-only escape hatch for older injected reviewCommand fixtures that use `--repo` merely to
   * avoid the live `resolveOwnerRepo()` read. Production callers never set this; explicit target
   * reviews validate the managed clone before target data is read. */
  enforceReviewSubjectCheckout?: boolean;
  resolveOwnerRepo?: typeof resolveOwnerRepo;
  /** W1-T4933: brings an explicit target's managed checkout install in line with its lockfile before proofs run; default {@link stagedInstall}. */
  refreshSubjectInstall?: (repoDir: string) => void;
  /** The freshness gate's reading taken immediately before this review began; see
   *  {@link reviewerFreshnessForPublication}. Absent, the operator CLI keeps the just-in-time read. */
  reviewStartFreshness?: ReviewerCodeFreshness;
  /** W1-T9727: set by `--judge-at-own-start` (the fresh-tree child): with no handed reading, take one at start. */
  judgeAtOwnStart?: boolean;
}

type ReviewSubjectFailureReason =
  | "review-subject-missing"
  | "review-subject-not-git"
  | "review-subject-origin-mismatch";

export type ReviewSubjectCheckout =
  | { ok: true; repoDir: string; explicitTarget: boolean }
  | { ok: false; reason: ReviewSubjectFailureReason; message: string; repoDir: string; explicitTarget: true };

function parseOwnerRepoFromOriginUrl(url: string): { owner: string; repo: string } | undefined {
  const m = url.trim().match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

function ownerRepoEqual(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return a.owner === b.owner && a.repo === b.repo;
}

export function resolveReviewSubjectCheckout(host: ReviewCommandHost, args: {
  config: Config;
  rest: string[];
  self: { owner: string; repo: string };
  target: { owner: string; repo: string };
  controllerRepoRoot?: string;
  git?: (repoDir: string, argv: string[]) => string;
  exists?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
}): ReviewSubjectCheckout {
  const controllerRepoRoot = args.controllerRepoRoot ?? repoRoot;
  const explicitRepo = flagValue(args.rest, "--repo") !== undefined;
  if (!explicitRepo || ownerRepoEqual(args.self, args.target)) {
    return { ok: true, repoDir: controllerRepoRoot, explicitTarget: explicitRepo };
  }

  const repoDir = join(args.config.root, "repos", args.target.repo);
  const exists = args.exists ?? existsSync;
  const isDirectory =
    args.isDirectory ??
    ((path: string) => {
      try {
        return lstatSync(path).isDirectory();
      } catch (e) {
        // Unstatable is equivalent to absent for this clone validation.
        return false;
      }
    });
  const git = args.git ?? host.reviewSubjectGit;

  if (!exists(repoDir) || !isDirectory(repoDir)) {
    return {
      ok: false,
      reason: "review-subject-missing",
      message: `explicit review target ${args.target.owner}/${args.target.repo} has no managed checkout at ${repoDir}`,
      repoDir,
      explicitTarget: true,
    };
  }

  try {
    if (git(repoDir, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
      return {
        ok: false,
        reason: "review-subject-not-git",
        message: `explicit review target ${args.target.owner}/${args.target.repo} checkout at ${repoDir} is not a git work tree`,
        repoDir,
        explicitTarget: true,
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: "review-subject-not-git",
      message:
        `explicit review target ${args.target.owner}/${args.target.repo} checkout at ${repoDir} is not readable as a git work tree: ` +
        String((e as Error)?.message ?? e),
      repoDir,
      explicitTarget: true,
    };
  }

  let origin;
  try {
    origin = parseOwnerRepoFromOriginUrl(git(repoDir, ["config", "--get", "remote.origin.url"]));
  } catch (e) {
    // An unreadable origin is reported below as an origin mismatch, never a controller fallback.
    origin = undefined;
  }
  if (!origin || !ownerRepoEqual(origin, args.target)) {
    const observed = origin ? `${origin.owner}/${origin.repo}` : "unreadable";
    return {
      ok: false,
      reason: "review-subject-origin-mismatch",
      message:
        `explicit review target ${args.target.owner}/${args.target.repo} checkout at ${repoDir} has origin ${observed}`,
      repoDir,
      explicitTarget: true,
    };
  }

  return { ok: true, repoDir, explicitTarget: true };
}

export function reviewSubjectFallbackAllowed(deps: ReviewCommandDeps): boolean {
  if (deps.enforceReviewSubjectCheckout === true) return false;
  return (
    deps.fetchView !== undefined ||
    deps.fetchHead !== undefined ||
    deps.materialize !== undefined ||
    deps.runReview !== undefined ||
    deps.postReviewPending !== undefined
  );
}

/**
 * Whether the plan shard tree that supplied `source` predates the one on `origin/main`.
 *
 * `resolvePlanCriteriaAtHead` already computed and printed this tree identity as part of its
 * read provenance. Reuse that value instead of asking git for a second identity for the PR head:
 * the only new git read is main's current tree.
 */
export function planTreeIsBehindMain(host: ReviewCommandHost, source: string, repoDir: string): boolean {
  const planTreeSha = /(?:^|\s)plan\/tasks\.d\/@([0-9a-f]{12,40})(?:\s|$)/.exec(source)?.[1];
  if (!planTreeSha) return false;

  try {
    const mainPlanTreeSha = host.readMainPlanTreeSha(repoDir);
    return !mainPlanTreeSha.startsWith(planTreeSha);
  } catch {
    // The advisory must not turn an otherwise reviewable PR into a failure when main is unreadable.
    return false;
  }
}

export async function reviewCommand(host: ReviewCommandHost, prArg: string, rest: string[] = [], deps: ReviewCommandDeps = {}): Promise<number> {
  const { acceptedReviewAttemptId, materializeReviewWorktree, realDeps, reviewPostedDescription, withMaterializedWorktree } = host;
  deps = { ...reviewOptionsFromFlags(host, rest), ...deps };
  const {
    fetchView,
    loadConfig: loadConfigDep,
    materialize,
    withMaterialized,
    buildBaseProof,
    runReview: runReviewDep,
    postStatus: postStatusDep,
    reviewerCodeFreshness: reviewerCodeFreshnessDep,
    postReviewPending: postReviewPendingDep,
    fetchHead,
    executionMode,
    planOnlyFiling,
  } = {
    fetchView: ghJson,
    loadConfig,
    materialize: materializeReviewWorktree,
    withMaterialized: withMaterializedWorktree,
    buildBaseProof: buildBaseProofDir,
    runReview: runReview.bind(null, host),
    postStatus: postReviewStatusGuarded,
    reviewerCodeFreshness: () => checkReviewerCodeFreshnessAsync(repoRoot, process.env),
    postReviewPending,
    fetchHead: realDeps().reviewWorktree.fetch,
    executionMode: "deterministic" as const,
    ...deps,
  };

  // `--repo <name>` or `--repo <owner>/<name>` lets the runner post remudero-review to a
  // repo OTHER than this checkout (e.g. remudero-sandbox for the daemon's live commissioning,
  // W1-T12d). Without it, resolveOwnerRepo() pins to repoRoot's origin (the main repo) and
  // `gh pr view` resolves the PR in the CWD — so a sandbox PR could never be gated. The lib
  // layer (runReview / postReviewStatus) already takes owner+repo; only the CLI was pinned.
  let defaults: { owner: string; repo: string } | undefined;
  let defaultsFailure: ReturnType<typeof asOwnerRepoUnresolvable> | undefined;
  try {
    defaults = (deps.resolveOwnerRepo ?? resolveOwnerRepo)();
  } catch (e) {
    const reason = asOwnerRepoUnresolvable(e, repoRoot);
    defaultsFailure = reason;
  }
  if (defaultsFailure && !(flagValue(rest, "--repo") ?? "").includes("/")) {
    console.error(`rmd review: ${defaultsFailure.message}`);
    return 1;
  }
  const selfTarget = defaults ?? { owner: "", repo: "" };
  const { owner, repo } = resolveReviewTarget(selfTarget, rest);
  // W1-T265's REST transport, applied to this read — see reviewViewArgs for the 87 measured
  // failures this closes. The REST arm returns a raw pull row and is normalised by that task's
  // own `mapRestPr`; the `gh pr view` arm (a bare branch name, which REST cannot address) already
  // returns the `gh --json` shape and passes through untouched. Both arms yield the SAME five
  // fields, so nothing downstream of `body` can tell which transport served it.
  const args = reviewViewArgs(owner, repo, prArg);
  const raw = fetchView(args);
  // The sweep's open-PR snapshot can age while earlier reviews run. The numeric arm already
  // fetched the live REST row, so decline a closed PR before fetching its head or building a
  // worktree. The guarded poster still makes the final lifecycle check for an in-flight close.
  if (reviewPrNumber(prArg) !== undefined && (raw as RestPullRow).state === "closed") {
    // The decline is a review outcome too: ledger it so a skipped closed PR is not a silent gap.
    const closed = raw as RestPullRow;
    appendLedger(ledgerPathFor(loadConfigDep()), {
      run_id: `review-PR${closed.number}-${systemClock.now()}`, task_id: `PR-${closed.number}`, lane: "review",
      step: "review.skipped_closed_before_review", pr_number: closed.number, pr_url: closed.html_url,
      head_sha: closed.head?.sha, merged: typeof closed.merged_at === "string",
    });
    console.log(`rmd review: PR #${prArg} closed before review; no verdict posted`);
    return 2;
  }
  const view = (reviewPrNumber(prArg) !== undefined ? mapRestPr(raw as RestPullRow) : raw) as {
    headRefOid: string;
    headRefName: string;
    body: string;
    url: string;
    number: number;
  };
  let body = view.body ?? "";
  const reportBody = body;
  const inputDigest = reviewInputDigest(view.headRefOid, body);
  const config = loadConfigDep();
  const ledgerPath = ledgerPathFor(config);
  const reviewLedger = readLedgerLines(ledgerPath);

  // Criteria: task trailer → tasks.yaml; else the PR body's Acceptance: block.
  let criteria: AcceptanceCriterion[] = [];
  let source = "NONE (fail closed — nothing to judge is never a pass)";
  const taskId = resolveReviewTaskId(
    body,
    view.headRefName,
    planOnlyFiling ?? isPlanOnlyFilingPr(reviewLedger, view.url),
  );
  const reviewKey = reviewLedgerKeyFor(taskId, view.number);
  const runId = `review-PR${view.number}-${systemClock.now()}`;
  const reviewAttemptId = acceptedReviewAttemptId(deps.reviewAttemptId, view.number);
  // W1-T10269: a shadow review publishes nothing and its rows are renamed; every terminal row names the judging code's sha.
  const shadow = rest.includes(REVIEWER_SHADOW_FLAG);
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: reviewKey, step: reviewerShadowStep(step, shadow), lane: "review",
      ...(reviewAttemptId === undefined ? {} : { review_attempt_id: reviewAttemptId, review_input_digest: inputDigest }), ...extra,
      ...reviewerHealthRowFields(step, flagValue(rest, REVIEWER_INCIDENT_FLAG)) });
  const adoptionComment = flagValue(rest, "--admission-adopt-comment");
  if (!shadow) {
    await observeAdmissionDisposition(config.contributorAdmission,
      { owner, repo, prNumber: view.number, headSha: view.headRefOid }, config.root, log,
      adoptionComment === undefined ? undefined : Number(adoptionComment));
    await (deps.contributorAdmission ?? ((target, action) => observeContributorAdmission(config.contributorAdmission, target, action, log)))
      ({ owner, repo, prNumber: view.number, headSha: view.headRefOid }, "review");
  }
  const reviewSubject = resolveReviewSubjectCheckout(host, {
    config,
    rest,
    self: selfTarget,
    target: { owner, repo },
  });
  const subjectCheckout = reviewSubject.ok || reviewSubjectFallbackAllowed(deps)
    ? { ok: true as const, repoDir: reviewSubject.ok ? reviewSubject.repoDir : repoRoot, explicitTarget: reviewSubject.explicitTarget }
    : reviewSubject;
  if (!subjectCheckout.ok) {
    log("review.subject_refused", {
      reason: subjectCheckout.reason,
      message: subjectCheckout.message,
      subject_repo_dir: subjectCheckout.repoDir,
      target_owner: owner,
      target_repo: repo,
    });
    // W1-T4410: a refusal about THIS machine's checkout judges nothing about the PR, so no status is posted.
    console.error(
      `rmd review: REFUSED — ${subjectCheckout.message}. No status was posted on the PR; ` +
        `run the review where ${owner}/${repo} is checked out (that repo's own daemon reviews it).`,
    );
    return 1;
  }
  const subjectRepoDir = subjectCheckout.repoDir;
  // W1-T4933: a satellite's managed checkout is the reviewer's install source too; only a validated one (never the test fallback).
  if (subjectCheckout.explicitTarget && subjectRepoDir !== repoRoot && (reviewSubject.ok || deps.refreshSubjectInstall !== undefined)) {
    refreshReviewSubjectInstall(
      subjectRepoDir,
      join(config.root, "state", `managed-checkout-${repo}.lock`),
      log,
      (failure) => void tryEscalate(managedCheckoutInstallEscalation(failure, reviewKey, runId), { issues: ghIssueGateway(owner, repo), ledgerPath, runId }),
      deps.refreshSubjectInstall,
    );
  }
  // W1-T322: the same plan lookup this block already does for `criteria` also carries the
  // task's declared scope — an advisory-only input judgeReview needs. Stays `undefined` on ANY
  // read/parse failure (see the catch below), exactly like `criteria` degrading to the body's
  // Acceptance: block — never a reason to fail the review.
  let taskDeclaredFiles: string[] | undefined;
  let taskRisk: TaskRisk | undefined;
  let taskBudgetUsd: number | undefined;
  let taskNarrative: ReviewTaskNarrativeInput = {};
  // W1-T2623: PERMANENTLY `undefined` on THIS path, deliberately — `resolvePlanCriteriaAtHead`
  // (lib/review.ts) has no `openTaskIds` field to assign from (the field the resolver it replaced,
  // `resolvePlanCriteriaForReview`, DID carry — see that function's own comment on why: computing
  // it here would be "a second, independent GitHub read this reviewer does not otherwise need").
  // This is NOT a leftover of the swap: an absent set reaches `judgeReview`'s
  // `openTaskIds ?? new Set()` exactly like the replaced resolver's own projection-less
  // `openTaskIdsFromPlan(plan)` did (that function degrades to the empty set with no projection,
  // documented on its own declaration) — the two are proven and LOCKED equivalent by
  // test/resolver-swap-field-parity.test.ts, never restored to a real computed value here.
  const openTaskIds: Set<string> | undefined = undefined;
  // W1-T2462: `resolvePlanCriteriaAtHead` (lib/review.ts) resolves this trailered PR's criteria
  // from the plan AS IT STANDS AT `view.headRefOid` rather than `resolvePlanCriteriaForReview`'s
  // `loadPlan(planPath)` read of the container's checked-out working tree. That working-tree read
  // is what let a plan shard that merged between two daemon boots stay invisible to a
  // review of the very PR head that shard reached (W1-T2432's shipped, previously-uncalled fix).
  //
  // W1-T2511: AND THE FETCH THAT MAKES THAT SHA READABLE NOW RUNS FIRST. This comment used to say
  // the resolution cost "no second network read" because "this fetch already holds" the head sha —
  // and no fetch had run. The only one on this command's path was `deps.fetch(repoDir)`, the first
  // statement of `materializeReviewWorktree`, 65 lines BELOW. So the reviewer asked git about a
  // commit it had not yet arranged to have, and the code that would arrange it ran next.
  //
  // IT COST TWO DIFFERENT VERDICTS, NOT ONE. `loadPlanAtRef` throws on an unreadable object and the
  // resolver degrades to `criteria: []`; the body fallback below then decides which. A body with no
  // `## Acceptance` block yields "FAIL — no acceptance criteria to judge" (#3328). A body that HAS
  // one yields something quieter and worse: #3365 fell back to a single body criterion and posted
  // `CAPPED: 0/1 proofs executed` while its shard resolved 8/8 — a silent downgrade that reads
  // exactly like an ordinary weakly-proven PR and refuses auto-merge with no visible cause.
  //
  // THE FETCH IS BEST-EFFORT HERE AND NAMED LATER, DELIBERATELY. A failure is swallowed rather than
  // returned: `materializeReviewWorktree` re-runs the same fetch below and reports a genuine
  // outage through its own `fetch-failure` class, which is the degradation path this command
  // already has. Failing here instead would invent a second one for the same condition.
  try {
    fetchHead(subjectRepoDir, view.number, view.headRefOid);
  } catch (e) {
    void e;
    // Swallowed on purpose — see above. The materializer's own fetch names a real outage.
  }
  let resolverDivergence: PlanCriteriaAtHeadDivergence | undefined;
  let ownTaskRecordMissing = false, headTaskResolved = false;
  // W1-T2846: a fleet PR can lose its trailer while retaining the task-bearing run branch.
  // Give the existing exact-trailer criteria resolver only the recovered identity it needs;
  // `reportBody` still carries the real PR body unchanged to the fallback and reviewer below.
  if (taskId && !reviewTaskIdFromBody(body)) body = `Remudero-Task: ${taskId}`;
  if (taskId) {
    const resolved = await resolvePlanCriteriaAtHeadAsync(body, subjectRepoDir, "plan/tasks.yaml", view.headRefOid);
    criteria = resolved.criteria;
    if (resolved.source) source = resolved.source;
    taskDeclaredFiles = resolved.taskDeclaredFiles;
    taskRisk = resolved.taskRisk;
    taskBudgetUsd = resolved.taskBudgetUsd;
    taskNarrative = resolved.taskNarrative ?? {};
    resolverDivergence = resolved.divergence;
    headTaskResolved = resolved.divergence === undefined && resolved.criteria.length > 0;
    // W1-T9232: a head cut before its own shard merged is pending a refresh from main, not a plan fault. Only a task
    // origin/main HAS qualifies; one absent from both, or a TRIAGE-/main-repair/unfiled identity, keeps today's path.
    if (taskId !== UNFILED_RUN_SENTINEL && resolved.divergence === undefined && resolved.criteria.length === 0 &&
      resolved.taskRisk === undefined && resolved.taskBudgetUsd === undefined) {
      const atMain = await resolvePlanCriteriaAtHeadAsync(body, subjectRepoDir, "plan/tasks.yaml", "origin/main");
      ownTaskRecordMissing = headLacksOwnTaskRecord(resolved, atMain);
    }
  }
  if (criteria.length === 0) {
    const fromBody = parseAcceptanceBlock(reportBody);
    if (fromBody.length) {
      criteria = fromBody;
      source = `PR body Acceptance: block (${fromBody.length} criteria)`;
    }
  }

  const provenanceKey = { taskId: reviewKey, prUrl: view.url, headSha: view.headRefOid };
  const provenance = resolveReviewProviderProvenance(reviewLedger, provenanceKey);
  log("review.provider_provenance", reviewProviderProvenanceLedgerFields(provenance, provenanceKey));

  let spawnReviewer = false, reviewerMount: Mount | undefined;
  let settingsFile = "";
  const replaySetupInput: ReviewReplayInput = {
    stage: "setup", plan_only: false, required_semantic: executionMode === "semantic",
    criteria_count: criteria.length, risk_present: taskRisk !== undefined, budget_present: taskBudgetUsd !== undefined,
    untasked: (!taskId || taskId === UNFILED_RUN_SENTINEL) ||
      (resolverDivergence === undefined && usesUntaskedReviewMetadata(taskId, view.headRefName)),
    head_task_resolved: headTaskResolved, own_task_record_missing: ownTaskRecordMissing,
    reviewer_outcome: "not_attempted", verdict_lines: [],
  };
  const recordSetupReplay = (input: ReviewReplayInput, decision: ReviewOutcomeDecision): void => {
    const sha = reviewerHealthRowFields("review.posted", flagValue(rest, REVIEWER_INCIDENT_FLAG)).reviewer_code_sha;
    log("review.replay_input", reviewReplayLedgerFields(input, decision, {
      pr_url: view.url, head_sha: view.headRefOid, reviewer_code_sha: typeof sha === "string" ? sha : null,
    }));
  };
  if (reviewTaskNarrative(taskNarrative) === undefined) {
    const unavailableInput = { ...replaySetupInput, setup_unavailable: true };
    recordSetupReplay(unavailableInput, classifyReviewOutcome(unavailableInput));
    log("review.reviewer.skipped", { reason: "head-task-narrative-unavailable", head_sha: view.headRefOid, pr_url: view.url });
    console.error("rmd review: head task design or amendment unavailable; no pending status, verdict or merge effect");
    return 2;
  }
  const setupDecision = classifyReviewOutcome(replaySetupInput);
  if (executionMode === "semantic") {
    // Unfiled PRs and exact generated lanes use bounded defaults; semantic review remains required.
    // A missing real task shard still refuses rather than inheriting these defaults (W1-T3387).
    if ((!taskId || taskId === UNFILED_RUN_SENTINEL) ||
        (resolverDivergence === undefined && usesUntaskedReviewMetadata(taskId, view.headRefName))) {
      taskRisk ??= DEFAULT_RISK;
      taskBudgetUsd ??= UNTASKED_REVIEW_BUDGET_USD;
      log("review.reviewer.untasked_defaults", { task_risk: taskRisk, hard_cap_usd: taskBudgetUsd });
    }
    const missing = [taskRisk === undefined ? "risk" : undefined, taskBudgetUsd === undefined ? "budget_usd" : undefined].filter(Boolean);
    if (headTaskResolved && missing.length > 0) {
      taskRisk ??= DEFAULT_RISK;
      taskBudgetUsd ??= UNTASKED_REVIEW_BUDGET_USD;
      log("review.reviewer.metadata_defaults", { task: taskId, missing, task_risk: taskRisk, hard_cap_usd: taskBudgetUsd });
    }
    if (taskRisk === undefined || taskBudgetUsd === undefined) {
      // Only a derived task id whose shard did not resolve at this head reaches here: a plan-resolution fault, not an untasked PR.
      // Its reason stays distinct from `semantic-setup-unavailable`.
      log("review.reviewer.skipped", { reason: "head-task-metadata-unavailable", missing });
      if (setupDecision.class === "refused") {
        recordSetupReplay(replaySetupInput, setupDecision);
        log("review.semantic_setup_refused", { reason: "head-task-metadata-unavailable", head_sha: view.headRefOid, pr_url: view.url });
        console.error("rmd review: semantic review unavailable (head task metadata); no pending status, verdict or merge effect");
        return 2;
      }
    } else {
      try {
        reviewerMount = resolveMount(loadMounts(mountsPath(repoRoot)), "reviewer", taskRisk);
        settingsFile = renderWorkerSettings({
          templatePath: join(resolveInstallRoot(config), "settings", "worker.json"),
          hooksDir: join(resolveInstallRoot(config), "hooks"),
          outPath: join(config.root, "tmp", `reviewer-settings-${runId}.json`),
        });
        validateWorkerSettingsFile(settingsFile);
        spawnReviewer = true;
        log("review.semantic_mode", { task_risk: taskRisk, hard_cap_usd: taskBudgetUsd });
      } catch (e) {
        reviewerMount = undefined;
        settingsFile = "";
        const unavailableInput = { ...replaySetupInput, setup_unavailable: true };
        recordSetupReplay(unavailableInput, classifyReviewOutcome(unavailableInput));
        log("review.reviewer.skipped", {
          reason: "semantic-setup-unavailable",
          error: String((e as Error)?.message ?? e),
        });
        // An explicitly selected semantic review must not become a deterministic PASS that
        // runReview can auto-arm. Refuse before either pending poster or materializer runs.
        log("review.semantic_setup_refused", { reason: "semantic-setup-unavailable", head_sha: view.headRefOid, pr_url: view.url });
        console.error("rmd review: semantic setup unavailable; no pending status, verdict or merge effect");
        return 2;
      }
    }
  }

  // W1-T2315: name the divergence rather than let it pass silently into the body fallback above —
  // a trailer that resolved nothing because the plan could not be LOADED is a different fact, with
  // a different remedy, than a body carrying no trailer at all. Ledgered (never a reason to fail
  // this review) so whoever reconciles the gate and this resolver has the id and the plan's own
  // error to work from, instead of rediscovering it from a truncated `## Acceptance` verdict.
  if (resolverDivergence) {
    log("review.resolver_divergence", { task_id: resolverDivergence.taskId, reason: resolverDivergence.reason });
    console.log(
      `### rmd review: plan resolver diverged from the CI gate for ${resolverDivergence.taskId} — ` +
        `${resolverDivergence.reason} (falling back to the PR body; see review.resolver_divergence in the ledger)`,
    );
  }

  console.log(`### rmd review PR #${view.number} — criteria from ${source}`);

  // W1-T913: `rmd review`'s OWN START posts remudero-review=pending — before this line, the
  // command posted nothing until it had judged, so the worktree materialization below (its own
  // measurable latency) sat behind the SAME absent-required-context window `runReview`'s own
  // pending post (see its call site) closes for the run lane. Idempotent per exact input
  // (`postReviewPending`'s own no-op guard): `runReviewDep` below reaches the SAME call a second
  // time and finds it already posted, so this is never a duplicate API call, only earlier
  // coverage of a latency window unique to this manual/sweep-dispatched path. A throw (e.g. a
  // transient lifecycle-read failure) degrades the SAME way `runReview`'s own call site does —
  // best-effort legibility, never a reason this command fails to review the PR at all.
  // W1-T9727: a fresh-tree child reads at its own start, before a memory-admission wait lets main move past it.
  const startFreshness = deps.reviewStartFreshness ??
    (deps.judgeAtOwnStart === true ? await ownStartFreshness(reviewerCodeFreshnessDep) : undefined);
  // The start reading could not prove freshness: say so, then fall back to the JIT read.
  if (startFreshness?.status === "unreadable") {
    log("review.reviewer_freshness_unreadable_at_start", {
      pr_url: view.url, head_sha: view.headRefOid, review_input_digest: inputDigest,
      reason: startFreshness.reason,
    });
  }
  const publicationFreshness = reviewerFreshnessForPublication(startFreshness, reviewerCodeFreshnessDep);
  if (!shadow) try {
    await postReviewPendingDep({
      owner,
      repo,
      sha: view.headRefOid,
      taskId: reviewKey,
      runId,
      ledgerPath,
      prUrl: view.url,
      reviewInputDigest: inputDigest,
      reviewEngineRevision: REVIEW_ENGINE_REVISION,
      fetchLifecycle: () => fetchPrLifecycle(view.url),
    });
  } catch (e) {
    log("review.pending_post.error", { error: String((e as Error)?.message ?? e) });
  }

  // W1-T9232: the pending status just posted STANDS — no verdict is judged on a plan that lacks the task's own record.
  // The sweep reads this row, refreshes the branch from main and re-reviews the new head.
  if (ownTaskRecordMissing) {
    const withheldInput = { ...replaySetupInput, publication_refusal: OWN_TASK_RECORD_MISSING_CAUSE };
    recordSetupReplay(withheldInput, classifyReviewOutcome(withheldInput));
    log("review.reviewer.skipped", {
      reason: OWN_TASK_RECORD_MISSING_CAUSE, pr_number: view.number, pr_url: view.url, head_sha: view.headRefOid,
      derived_repair: "refresh the branch from main", missing: ["risk", "budget_usd", "criteria"],
    });
    console.log(
      `rmd review PR #${view.number}: ${taskId} has no record at head ${view.headRefOid.slice(0, 7)} but origin/main has it ` +
        `(${OWN_TASK_RECORD_MISSING_CAUSE}) — pending; refresh the branch from main, then re-review`,
    );
    return 2;
  }

  // W1-T185 (Gap 2): materialize a throwaway worktree at the PR head so
  // whitelisted proofs actually EXECUTE on this manual path, matching what
  // the automated fix rung observes for the same PR/proofs (acceptance
  // criterion 4). On ANY failure this leaves worktreePath undefined and the
  // review falls back to keyword-only — EXPLICITLY marked (criterion 5),
  // never silently, and (W1-T233) the console line below now NAMES why,
  // instead of a bare "unavailable" with the real reason thrown away.
  const materialized = materialize(config, subjectRepoDir, view.number, view.headRefOid);
  if (materialized.worktreePath === undefined) {
    console.log(
      `(worktree materialization failed [${materialized.failure.errorClass}]: ` +
        `${materialized.failure.message} — this verdict will post keyword-only)`,
    );
  }
  const worktreePath = materialized.worktreePath;

  // impl-GE / R-11: the merge-base side this PR's proofs are re-run against, so a proof that ALREADY
  // matched/passed before the work existed is marked `executed_stale` instead of counting as
  // evidence. Built from the materialised head worktree (the merge-base is resolved there);
  // `baseCheckoutDir` is a real detached worktree when `baseIsCheckout` is true, else the blob-only
  // fallback (or undefined when the PR has no dialect proof / no resolvable base — the check then
  // stays inert, exactly as it was for its first 1,180 verdicts). W1-T460's `baseUnreadablePaths`
  // rides along: a per-proof fact the dir alone cannot carry.
  const baseProof = worktreePath ? buildBaseProof(criteria, worktreePath) : undefined;

  // W1-T185 (Gap 2, criterion 6): withMaterializedWorktree guarantees teardown
  // on EVERY exit path, including a throw from runReview itself — never just
  // the success path, which would reproduce the W1-T175 leak class. (R-11) The
  // base worktree is torn down by the SAME helper, as the outer scope, so the
  // head goes first and the base follows on every exit path too; a grep tree is
  // deleted there the same way, and a blob-only fallback dir is not a worktree and
  // is left to the boot sweep (src/lib/tmp.ts) exactly as before.
  const verdict = await withMaterialized(
    baseProof?.baseIsCheckout || baseProof?.baseIsGrepTree ? baseProof.baseCheckoutDir : undefined,
    subjectRepoDir,
    () =>
      withMaterialized(worktreePath, subjectRepoDir, () => whileWorkerRunLive(host, runId, () =>
        runReviewDep({
          reviewReplaySetupInput: replaySetupInput,
          owner,
          repo,
          prUrl: view.url,
          // impl-BG: excludes dependabot heads from the post-verdict arm (the dep-review lane owns those).
          headRefName: view.headRefName,
          task: {
            id: reviewKey,
            acceptance: criteria,
            files: taskDeclaredFiles,
            risk: taskRisk,
            budget_usd: taskBudgetUsd,
            ...taskNarrative,
          },
          report: reportBody, // the PR body is the manual author's REPORT (proofs are pasted here)
          settingsFile,
          config,
          budgetUsd: spawnReviewer ? taskBudgetUsd : undefined,
          log,
          say: (m) => console.log(m),
          account: (r) => r,
          spawnReviewer,
          requireSemanticReview: executionMode === "semantic",
          reviewerMount,
          // W1-T185 (Gap 2): the materialized worktree above when available — the
          // SAME `headCheckoutDir` wiring the autonomous path uses, so whitelisted
          // proofs execute here too. `undefined` (materialization unavailable)
          // makes `judgeReview` mark the verdict `keywordOnly`+`capped`, exactly
          // the documented fallback (criterion 5) — never silent.
          headCheckoutDir: worktreePath,
          reviewerCodeFreshness: publicationFreshness,
          // The three base facts, threaded by NAME so a reader (and test/preexisting-proof-hits-wiring)
          // can see each one reach the evidence: the dir, the per-proof unreadable set (W1-T460), and
          // whether the dir is a checkout a `unit test:` proof may honestly be re-run in (R-11).
          baseCheckoutDir: baseProof?.baseCheckoutDir,
          baseUnreadablePaths: baseProof?.baseUnreadablePaths,
          baseIsCheckout: baseProof?.baseIsCheckout,
          addedTestFiles: baseProof?.addedTestFiles,
          // W1-T233: the named reason materialization failed (absent ⇒ it was
          // never attempted at all) — carried onto the posted CAPPED description
          // and the review.posted ledger line's degraded_reason fields.
          materializationFailure: materialized.failure,
          ledgerPath,
          runId,
          openTaskIds,
          ...(shadow ? { shadow: true } : {}),
        }), join(config.root, "state", "inflight")),
      ),
    baseProof?.baseIsGrepTree ? (_repo, tree) => rmSync(tree, { recursive: true, force: true }) : undefined,
  );
  // W1-T10269: a shadow review ends at its verdict: no restore, no status, no comment, no arm.
  if (shadow) return verdict.verdictWithheld ? 2 : 0;

  // A final review decision is immutable, but GitHub's commit status is last-write-wins. A stale
  // daemon may have posted pending after that decision; replay must check the live context and
  // restore the already-judged terminal status instead of reporting a success that GitHub cannot see.
  let replayStatusAction: "restored" | "confirmed" | undefined;
  if (verdict.decisionDisposition === "replayed" && verdict.reviewDecisionDigest) {
    const restored = await postStatusDep({
      owner, repo, sha: view.headRefOid, state: verdict.state,
      description: reviewPostedDescription(verdict),
      taskId: reviewKey, evidence: reviewEvidenceStrength(verdict.criteria),
      ledgerPath, runId, prUrl: view.url, reviewInputDigest: inputDigest,
      reviewDecisionDigest: verdict.reviewDecisionDigest,
      reviewEngineRevision: REVIEW_ENGINE_REVISION,
      reviewerCodeFreshness: await publicationFreshness(),
      fetchLifecycle: () => fetchPrLifecycle(view.url),
      fetchCurrentStatus: () => reviewStatusEntryFromCombined(fetchView(combinedStatusRestArgs(owner, repo, view.headRefOid)))?.state,
      fetchCurrentStatusEntry: () => readReviewStatusEntry(owner, repo, view.headRefOid, deps.fetchView),
      fetchPublisher: deps.fetchView,
    });
    if (restored.posted) {
      replayStatusAction = "restored";
      log("review.posted", {
        context: REVIEW_CONTEXT, state: verdict.state, head_sha: view.headRefOid, pr_url: view.url,
        review_input_digest: inputDigest, review_engine_revision: REVIEW_ENGINE_REVISION,
        review_decision_digest: verdict.reviewDecisionDigest, decision_verdict: verdict,
        evaluator_provenance: verdict.evaluatorProvenance,
        reviewer_outcome: verdict.reviewerOutcome, proof_exec: verdict.criteria.map((criterion) => criterion.proof_exec),
        status_recovered: true,
        status_publisher: restored.publisherEvidence,
      });
    } else if (restored.replayed) {
      replayStatusAction = "confirmed";
      // W1-T5726: nothing posted, but this input WAS judged; no row leaves the attempt count 0 and the sweep re-reviews (#9138).
      log("review.posted", {
        context: REVIEW_CONTEXT, state: verdict.state, head_sha: view.headRefOid, pr_url: view.url,
        review_input_digest: inputDigest, review_engine_revision: REVIEW_ENGINE_REVISION,
        review_decision_digest: verdict.reviewDecisionDigest, decision_verdict: verdict,
        evaluator_provenance: verdict.evaluatorProvenance,
        reviewer_outcome: verdict.reviewerOutcome, proof_exec: verdict.criteria.map((criterion) => criterion.proof_exec),
        status_confirmed: true,
        status_publisher: restored.publisherEvidence,
      });
    } else {
      verdict.verdictWithheld = restored.reason ?? "could not restore the live remudero-review status";
    }
  }

  console.log(
    `\nremudero-review=${verdict.state} ${verdict.verdictWithheld ? "WITHHELD" : replayStatusAction ?? "posted"} to ${view.url} (head ${verdict.headSha.slice(0, 7)})` +
      (verdict.verdictWithheld ? ` — ${verdict.verdictWithheld}` : "") +
      (reviewVerdictAnnotation(verdict) ? ` — ${reviewVerdictAnnotation(verdict)}` : "") +
      // W1-T1085: the same three-way fact the status itself renders — a plan-only PR is not a
      // degraded one, and saying "not certified" here contradicts the status posted seconds ago.
      (cappedWordingApplies(verdict) ? " — CAPPED: not certified (0 proofs executed)" : ""),
  );
  if (verdict.verdictWithheld) return 2;

  if (verdict.criteria.some((criterion) => !criterion.met) && planTreeIsBehindMain(host, source, subjectRepoDir)) {
    console.log(
      "NOTE: the criteria came from a plan tree older than origin/main; merge origin/main into the branch " +
        "before treating this unmet verdict as a diff defect",
    );
  }

  // W1-T185 (Gap 1, criterion 2), raised by W1-T229: the operator override —
  // a LEDGERED, attributable decision to arm a capped verdict anyway.
  // Granted here (the manual escape hatch, an operator-run command) rather
  // than inferred: an override is a decision someone made, and it must name
  // who. No `principles`/tdd-tier check gates this note since W1-T229 — a
  // CAPPED verdict refuses to arm regardless of tdd tier.
  const overrideBy = flagValue(rest, "--override-capped-by");
  const overrideReason = flagValue(rest, "--override-capped-reason");
  if (overrideBy && overrideReason) {
    if (!taskId) {
      console.error(
        "--override-capped-by/--override-capped-reason need a resolvable task (a Remudero-Task: trailer) " +
          "— not recorded.",
      );
    } else {
      // W1-T219: BIND the grant to the head it was actually reviewed against —
      // cappedOverrideFromLedger refuses to honour it against any other head.
      log("automerge.capped_override_granted", {
        by: overrideBy,
        reason: overrideReason,
        pr_url: view.url,
        head_sha: verdict.headSha,
      });
      console.log(
        `CAPPED override recorded — by ${overrideBy}: ${overrideReason} (task ${taskId}, head ${verdict.headSha.slice(0, 7)})`,
      );
    }
  } else if (cappedWordingApplies(verdict)) {
    // W1-T1085: a SEPARATE call site from the capped annotation above, with the same defect —
    // gated on `capped` alone. For a plan-only verdict both halves are false: it arms, and the
    // override is structurally unreachable, so the hint is advice that cannot be followed. The
    // status this run posts already states the truth, so nothing replaces it here.
    console.log(
      `NOTE: a CAPPED verdict cannot arm auto-merge without executed proof or an operator override: ` +
        `rmd review ${view.number} --override-capped-by <name> --override-capped-reason <text>`,
    );
  }

  return verdict.state === "success" ? 0 : 1;
}

/** W1-T5998 — hold `runId` in {@link liveWorkerRunIds} for as long as `spawn` runs its worker. */
export async function whileWorkerRunLive<T>(host: ReviewCommandHost, runId: string, spawn: () => Promise<T>, inflightDir?: string): Promise<T> {
  const { liveWorkerRunIds, reviewWorkerLockId } = host;
  const held = inflightDir === undefined ? undefined : acquireInflightLock(join(inflightDir, "review-workers"),
    reviewWorkerLockId(runId), { run_id: runId, reclaim: false });
  liveWorkerRunIds.add(runId);
  try {
    return await spawn();
  } finally {
    liveWorkerRunIds.delete(runId);
    held?.release();
  }
}
