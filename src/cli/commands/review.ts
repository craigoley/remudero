import { createHash } from "node:crypto";
import { findTaskInCatalogs, catalogTaskContract, type TaskLookupOptions } from "../../lib/task-lookup.js";
import type { WorkerStreamEvent } from "../../lib/worker.js";
import type { GhApiFetcher } from "../../lib/open-prs-rest.js";
import { type WorkerStateSensor, type ReviewRunResult, type MaterializationErrorClass, type MaterializationFailure, type CensusChildResult } from "./run-task-verb.js";
import { buildBaseProofDirAsync, hostWorktreeGitAtTopLevel, type BaseProofDir } from "../../lib/check-proof.js";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { checksStateFromRollup, currentReviewSignal, reportReviewPhase, withheldReviewRefusalRow, readHostedFixProofResults, type HostedFixProofReader } from "../../lib/sweep.js";
import { MOVER_BRANCH_PREFIX, movedFromCommit, parseMoverReceipts, verifyMoverRemoval, type MoverOpsRead, verifyMoverRemovalPublic, type MoverRemovalVerdict, parseReviewerHistoryEvidence, parseWhitelistedProof, reviewRowNamesPr, resolveProofTestPath, resolveNameFilteredCandidatesAsync, publicTaskHoldDescription, taskHoldRefusal, type TaskHoldReading } from "../../lib/review.js";
import { extractReviewFindings, recordReviewFindings, type FindingCapture } from "../../lib/review-findings.js";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isWorkerProviderId, loadConfig, type Config, type WorkerProviderId } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { disarmOutcomeWithdrawn, disarmAutoMerge, disarmAutoMergeAsync, realArmDepsAsync, armIfVerdictPermitsAsync, type ArmOutcome, type DisarmOutcome, type DisarmRenewal } from "../../lib/arm-auto-merge.js";
import { type ComposedRealGraph, type ReviewWorktreeDeps } from "../../lib/composition-root.js";
import { writeReviewEvidenceRecord } from "../../lib/review-evidence-record.js";
import { SPECIALIST_TOOLS } from "../../lib/specialist-panel.js";
import { REVIEWER_INCIDENT_FLAG, REVIEWER_SHADOW_FLAG, REVIEWER_SHADOW_VERDICT_STEP, reviewerHealthRowFields, reviewerShadowStep } from "../../lib/reviewer-health.js";
import { isCalibrationCaseOf, reviewerModelPin } from "../../lib/reviewer-calibration.js";
import { withTempDir } from "../../lib/tmp.js";
import { systemClock } from "../../lib/clock.js";
import { reapWorkerScratch } from "../../lib/worker-scratch.js";
import { resolveInstallRoot } from "../../lib/install-root.js";
import { escalate, ghIssueGatewayAsync, tryEscalateAsync, type AsyncIssueGateway } from "../../lib/escalate.js";
import { combinedStatusRestArgs, compareRestArgs, mapRestPr, rollupForAsync, tryFetchReviewReuseFacts, type ReviewReuseFacts, type RestPullRow } from "../../lib/open-prs-rest.js";
import { ghJsonAsync, ghLinesAsync, ghTextAsync } from "../../lib/github-transport.js";
import { appendLedger, REVIEW_LANE_ABORTED_STEP } from "../../lib/ledger.js";
import { NO_CRITERIA_FAIL_SUMMARY, NO_CRITERIA_REVIEWER_OUTCOME, requiredSemanticDecisionDigest } from "../../lib/required-semantic-review.js";
import { deriveTaskClass } from "../../lib/task-class.js";
import { withReceiptWork } from "../../lib/benchmark-run.js";
import { classifyReviewOutcome, DOWNGRADE_UNCLASSIFIED, recordedReviewVerdictLines, reviewReplayLedgerFields, unclassifiedDowngrades, type ReviewReplayInput, type ReviewOutcomeDecision } from "../../lib/review-outcome-class.js";
import { type AdmissionObserver } from "../../lib/contributor-admission.js";
import { observeContributorAdmission } from "../../lib/arm-auto-merge.js";
import { observeAdmissionDisposition } from "../../lib/action-executor.js";
import { listedLedgerFiles, readLedgerUnionRawLinesAsync, readLedgerUnionRecords } from "../../lib/ledger-union.js";
import { defaultGitRunnerAsync, visibleCriteria, type AcceptanceCriterion, DEFAULT_RISK, type TaskRisk } from "../../lib/plan.js";
import { planDestinationRepository } from "../../lib/plan-destination.js";
import { landReviewFindingsAsync, reviewFindingsRelPath, type LandFeedbackResult } from "../../lib/feedback-landing.js";
import { defaultOpsCatalogApi, type OpsCatalogApi } from "../../lib/ops-catalog-source.js";
import { loadMounts, mountsPath, resolveMount, type Mount } from "../../lib/mounts.js";
import { resolveRiskJudgeMount } from "../../lib/risk-judge.js";
import { runShadowJudge, SHADOW_JUDGE_MAX_BUDGET_USD } from "../../lib/shadow-judge.js";
import type { ReviewTriagePullRequest } from "../../lib/review-triage.js";
import { ghUnauthorizedError, holdReviewRunLive, renewReviewPublisherToken, reviewClaimTakenOverBy, type ReviewIssueGateway,
  type ReviewTokenRenewal } from "../../lib/review.js";
import { isTestRunner } from "../../lib/live-write-guard.js";
import { REVIEW_CONTEXT, REVIEW_ENGINE_REVISION, settleReviewOutboxEntry, applyVerdictStability, applyReviewStatusHistoryGuard, readReviewStatusHistory, type ReviewStatusHistoryReader, buildReviewPrompt, reviewScopeContext, reviewPlacementAdmitted, cappedAnnotation, cappedOverrideFromLedger, UNCERTIFIED_PASS_HELD, cappedWordingApplies, decideAutoMergeArm, fetchPrLifecycle, fetchPrLifecycleAsync, floorDegradedAnnotation, judgeRubric, rubricAdvisorySection, scopeAdvisorySection, inverseScopeAdvisorySection, unwiredExportAdvisorySection, keywordOnlyAnnotation, markUnbackedBodyGuards, parseAcceptanceBlock, parseReviewerUnable, parseReviewerVerdictClauses, parseReviewerVerdicts, postReviewCommentGuarded, postReviewPending, postReviewStatus, postReviewStatusGuarded, postUnreadTaskHoldGuarded, reviewDescriptionWithCodeProvenance, reviewCodeShaFromDescription, semanticJudgementRefusal, reviewPendingDescriptionWithOwner, reviewStatusOwnerRun, reviewFollowUps, followUpFindingsSection, readReviewStatusEntry, reviewStatusEntryFromCombined, priorReviewVerdictFromLedger, priorHeadFindingsFromLedger, priorHeadReviewRows, reviewLedgerKeyFor, UNFILED_RUN_SENTINEL, planOnlyDiff, reviewerOutcome, reviewerRerunDecision, reviewerVerdictContract, reviewEvidenceStrength, claimReviewDecision, preparePromisedReviewDecision, reviewTaskIdEvidenceAsync, satelliteReservationRead, reviewContractDigest, reviewTaskNarrative, type ReviewTaskNarrativeInput, reviewInputDigest, reviewLedgerLegibilityFields, reviewLedgerReasons, unmetReviewCriteria, proofConcludedNothing, resolvePlanCriteriaAtHeadAsync, type PlanCriteriaAtHeadDivergence, type CriterionVerdict, type ReviewVerdict, type PlanLintOutcome, type ReviewEvaluatorProvenance, type ReviewStatusHistory, type PriorReproducedReviewFailure, type ReviewAdmission } from "../../lib/review.js";
import { resolveReviewProviderProvenance, reviewProviderProvenanceLedgerFields } from "../../lib/review-provider-provenance.js";
import { validateWorkerSettingsFile } from "../../lib/settings.js";
import { readLedgerLines, readRequiredStatusCheckContextsAsync } from "../../lib/status.js";
import { isDispatchedRunBranch } from "../../lib/sweep.js";
import { headLacksOwnTaskRecord, OWN_TASK_RECORD_MISSING_CAUSE } from "../../lib/sweep.js";
import { readRuntimeImageSha, REVIEW_REQUEUED_STEP, reviewerImageDecisionDigest } from "../../lib/sweep.js";
import { REVIEW_RUN_SETTLED_STEPS, REVIEWER_START_FAILED_OUTCOME } from "../../lib/sweep.js";
import { ghJson, renderWorkerSettings, cashDivertSpawnFields, spawnWorker, workerLedgerFields, workerTranscript, excludeNodeModulesFromGit, linkWorktreeNodeModules, resolveNodeModulesSource, type SpawnWorkerArgs, type WorkerResult, type WorkerSelectionAssignment, WorkerAbandonedError, worktreeRemoveAsync } from "../../lib/worker.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "../../lib/worktree-git.js";
// @ts-expect-error a plain .mjs script with no declaration file, as src/lib/merged-ratchet-verdict.ts imports its siblings.
import { PROOF_DISCRIMINATION_JOB, PROOF_DISCRIMINATION_WORKFLOW, RESULT_FORMAT, RESULT_MARKER, bodyDigest, discriminationProofs, proofDiscriminationDigests } from "../../../scripts/proof-discrimination-gate.mjs";
import { releaseReviewWorktree } from "../../lib/review-worktree-reclaim.js";
import { step } from "../../lib/git-push.js";
import { acquireDrainLock, type DrainLockHandle } from "../../lib/drain-lock.js";
import { taskTargetsRepo } from "../../lib/drain.js";
import { checkReviewerCodeFreshnessAsync, type ReviewerCodeFreshness } from "../../lib/self-sync.js";
import { acquireInflightLock, sweepStaleInflightLocks } from "../../lib/inflight-lock.js";
import { repoRoot, resolveOwnerRepo } from "../../lib/repo-location.js";
import { instanceMode, readInstanceRegistryText } from "../../lib/instance-mode.js";
import { fetchPrDiff, prDiffSourceAsync } from "../../lib/pr-diff.js";
import { asOwnerRepoUnresolvable } from "../../lib/owner-repo.js";
import { flagValue } from "../../lib/cli-args.js";
import { resolveReviewTarget, reviewTaskIdFromBody, reviewPrNumber, reviewViewArgs } from "../../lib/report-commands.js";
import { managedCheckoutInstallEscalation, stagedInstall, type StagedInstallFailure } from "../../lib/staged-install.js";
import { UNTASKED_REVIEW_BUDGET_USD, isPlanOnlyFilingPr, resolveReviewTaskId, reviewStateFromRollup, reviewStatusHistoryFromRest, usesUntaskedReviewMetadata } from "../../lib/tick-read-worker.js";
import { freshPullRowRead, resolvePullRequestTaskSubject, type PullRequestTaskSubject } from "../../lib/task-dispatch-hold.js";

export interface ReviewCommandHost {
  readonly GIT_UNTRACKED_FILES_ALL: string;
  readonly JUDGE_AT_OWN_START_FLAG: string;
  acceptedReviewAttemptId(value: unknown, prNumber?: number): string | undefined;
  attributeWorkerStreamEvent(event: WorkerStreamEvent, assignment: Pick<WorkerSelectionAssignment, "id" | "selected"> | undefined): WorkerStreamEvent;
  ledgeredNonDispatchSpawn(lane: string, raw?: typeof spawnWorker): typeof spawnWorker;
  lintPlanForReview(
    headCheckoutDir: string | undefined,
    git?: (cwd: string, args: string[]) => string | Promise<string>,
    run?: (argv: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<CensusChildResult>,
    options?: { signal?: AbortSignal; log?: (step: string, extra?: Record<string, unknown>) => void },
  ): Promise<PlanLintOutcome>;
  readonly liveWorkerRunIds: Set<string>;
  materializeReviewWorktree(config: Config, repoDir: string, prNumber: number, headSha: string, deps?: ReviewWorktreeDeps<string | Promise<string>, void | Promise<void>>): MaterializeReviewWorktreeResult | Promise<MaterializeReviewWorktreeResult>;
  readonly reviewWorktreeAsync?: ReviewWorktreeDeps<string | Promise<string>, void | Promise<void>>;
  readHeadShaRest(prUrl: string, fetch?: GhApiFetcher): string;
  readMainPlanTreeSha(repoDir: string): string;
  realDeps(): ComposedRealGraph;
  reviewPostedDescription(verdict: Pick<ReviewVerdict, "summary" | "capped"> & Partial<Pick<ReviewVerdict, "criteria">>, materializationFailure?: MaterializationFailure): string;
  reviewWorkerLockId(runId: string): string;
  reviewerClockBoundMs(override?: number): number;
  reviewSubjectGit(repoDir: string, argv: string[]): string;
  /** W1-T12419: the shadow decision-model triage of a pull request before its review. Absent ⇒ no triage. */
  triagePullRequest?(config: Config, pr: ReviewTriagePullRequest): Promise<unknown>;
}

export const PLAN_LINT_RETRY_FLAG = "--plan-lint-retry";

function repeatedFlagValues(rest: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rest.length - 1; i++) {
    if (rest[i] === flag) values.push(rest[++i]!);
  }
  return values;
}

/** W1-T12152: the review lane's prompt template — {@link buildReviewPrompt} and {@link reviewerVerdictContract} over a
 *  placeholder task with one criterion, every task, PR and evidence slot a named marker. It is rendered before any task
 *  text is filled in, so two PRs reviewed under one contract record one prompt revision. */
export function reviewPromptTemplate(): string {
  return buildReviewPrompt({ task: { id: "${TASK_ID}", acceptance: [{ claim: "${CLAIM}", proof: "${PROOF}" }] },
    prUrl: "${PR_URL}", owner: "${OWNER}", repo: "${REPO}", headSha: "${HEAD_SHA}", evidencePath: "${EVIDENCE_PATH}",
    proofEvidencePath: "${PROOF_EVIDENCE_PATH}", declaredFiles: ["${DECLARED_PATH}"], changedFiles: ["${CHANGED_PATH}"],
    widenedFiles: [] }) + "\n" + reviewerVerdictContract(1);
}

export function reviewOptionsFromFlags(host: ReviewCommandHost, rest: string[]): Pick<ReviewCommandDeps, "planOnlyFiling" | "executionMode" | "judgeAtOwnStart" | "reviewAttemptId" | "excludeProviders" | "planLintRetryHead"> {
  const { JUDGE_AT_OWN_START_FLAG, acceptedReviewAttemptId } = host;
  const mode = flagValue(rest, "--execution-mode");
  const reviewAttemptId = acceptedReviewAttemptId(flagValue(rest, "--review-attempt-id"));
  const planLintRetryHead = flagValue(rest, PLAN_LINT_RETRY_FLAG);
  const excludeProviders = [...new Set([
    ...repeatedFlagValues(rest, "--exclude-provider"),
    ...(flagValue(rest, "--exclude-providers") ?? "").split(","),
  ].map((provider) => provider.toLowerCase()).filter((provider): provider is WorkerProviderId => isWorkerProviderId(provider)))];
  return {
    ...(rest.includes(JUDGE_AT_OWN_START_FLAG) ? { judgeAtOwnStart: true } : {}),
    ...(rest.includes("--plan-only-filing") ? { planOnlyFiling: true } : rest.includes("--not-plan-only-filing") ? { planOnlyFiling: false } : {}),
    ...(mode === "semantic" || mode === "deterministic" ? { executionMode: mode } : {}),
    ...(reviewAttemptId === undefined ? {} : { reviewAttemptId }),
    ...(planLintRetryHead !== undefined && /^[a-f0-9]{40}$/i.test(planLintRetryHead) ? { planLintRetryHead } : {}),
    ...(excludeProviders.length ? { excludeProviders } : {}),
  };
}

/** The run-id shape of a reviewer's own claim (`rmd review`'s `review-PR<n>-<ms>`, and the dependency reviewer's). */
const REVIEWER_RUN_ID = /^(?:dep-)?review-PR\d+-/;

/** W1-T14177 (INVARIANT one-live-review-owner) — postReviewPending's refusal because ANOTHER live REVIEWER holds this
 *  head's claim. These are not this refusal:
 *  - this run's own idempotent no-op;
 *  - a closed lifecycle;
 *  - a drained outbox;
 *  - a claim a dispatching lane posted for the review it hands off (the sweep's reviewer-code advance posts under its
 *    own SWEEP-* run, then admits this review);
 *  - a holder whose run already settled this head: its newest claim or settle row here is a settle row
 *    ({@link REVIEW_RUN_SETTLED_STEPS}), e.g. a completed hold it published. A holder with no row at all is a takeover
 *    GitHub accepted before its ledger append, so it is still live.
 *  `ledger` is the command's ledger snapshot at admission. Returns a fixed reason naming the sanitised holder,
 *  which the caller returns instead of reviewing or posting. */
export function pendingClaimHeldByAnotherRun(
  result: { posted: boolean; reason?: string; lifecycle?: unknown; outbox?: unknown }, runId: string,
  ledger: ReadonlyArray<Record<string, unknown>>, headSha: string,
): string | undefined {
  if (result.posted || result.lifecycle !== undefined || result.outbox !== undefined) return undefined;
  const holder = /\(owned by run ([^)]+)\)/.exec(result.reason ?? "")?.[1];
  if (holder === undefined || holder === runId || !REVIEWER_RUN_ID.test(holder)) return undefined;
  const newest = ledger.findLast((line) => line.run_id === holder && line.head_sha === headSha &&
    (line.step === "review.pending_posted" || (typeof line.step === "string" && REVIEW_RUN_SETTLED_STEPS.has(line.step))));
  if (newest !== undefined && newest.step !== "review.pending_posted") return undefined;
  // The holder id is read from GitHub and the ledger: only run-id characters reach a log line.
  return `another reviewer run (${holder.replace(/[^A-Za-z0-9._:-]/g, "")}) holds this head's remudero-review claim`;
}

/** W1-T14177: check the current post against history before invoking the takeover publisher. */
async function readBoundPendingClaimStatus(owner: string, repo: string, sha: string, read: GhApiFetcher):
  Promise<{ combined: unknown; reason?: never } | { reason: string; combined?: never }> {
  try {
    const combined = await read(combinedStatusRestArgs(owner, repo, sha)) as { statuses?: unknown } | null;
    const current = reviewStatusEntryFromCombined(combined);
    const live = reviewStatusHistoryFromRest(combined?.statuses)?.[0];
    const newest = reviewStatusHistoryFromRest(await read(["api", `repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100`]))?.[0];
    if (current && live?.id !== undefined && live.id === newest?.id) return { combined };
    return { reason: "GitHub's live remudero-review status id does not match its newest history entry" };
  } catch (error) {
    return { reason: `GitHub's live remudero-review status could not be verified: ${String(error)}` };
  }
}

/** W1-T14156: the `rmd review` verb runs the model reviewer unless its caller chose a mode. */
export function operatorReviewArgs(rest: string[]): string[] {
  return rest.includes("--execution-mode") ? rest : [...rest, "--execution-mode", "semantic"];
}

export const REVIEW_EXIT_CAUSE_FLAG = "--exit-cause-file";
const REVIEW_EXIT_STEPS = ["view", "setup", "materialize", "review", "publish"] as const;
export const REVIEW_EXIT_CAUSES = [
  "repo-unresolvable", "closed-before-review", "subject-refused", "task-narrative-unavailable",
  "task-metadata-unavailable", "semantic-setup-unavailable", "own-task-record-missing",
  "shadow-verdict-withheld", "replayed-verdict-withheld", "verdict-not-posted",
  "verdict-failure", "verdict-pending", "verdict-not-success", "review-claim-held", "reviewer-stale-at-start",
  ...REVIEW_EXIT_STEPS.map((step) => `threw-in-${step}` as const),
] as const;
export type ReviewExitCause = (typeof REVIEW_EXIT_CAUSES)[number];
type ReviewExit = { step: (typeof REVIEW_EXIT_STEPS)[number]; as: (cause: ReviewExitCause) => void; release?: () => void };

function writeReviewExitCause(rest: string[], cause: ReviewExitCause, error?: unknown): void {
  const path = flagValue(rest, REVIEW_EXIT_CAUSE_FLAG);
  if (path === undefined) return;
  const errorClass = error === undefined ? "" : `\t${error instanceof Error ? error.constructor.name : typeof error}`;
  try {
    writeFileSync(path, `${cause}${errorClass}\n`);
  } catch (e) {
    console.error(`rmd review: exit cause ${cause} was not written: ${String((e as Error)?.message ?? e)}`);
  }
}

async function reportingReviewExit(rest: string[], run: (exit: ReviewExit) => Promise<number>): Promise<number> {
  const exit: ReviewExit = { step: "view", as: (cause) => writeReviewExitCause(rest, cause) };
  try {
    return await run(exit);
  } catch (error) {
    writeReviewExitCause(rest, `threw-in-${exit.step}`, error);
    throw error;
  } finally {
    exit.release?.();
  }
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
/** W1-T1085 / W1-T14241: the command that releases a capped code pass, printed where a CAPPED verdict was judged. */
function cappedOverrideHint(prNumber: number): string {
  return `NOTE: a CAPPED verdict cannot arm auto-merge without executed proof or an operator override: ` +
    `rmd review ${prNumber} --override-capped-by <name> --override-capped-reason <text>`;
}

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
  const refusal = armWithdrawalReason(verdict, ctx, deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath)));
  if (refusal === undefined) return false;
  const outcome = (deps.disarm ?? disarmAutoMerge)(ctx.prUrl);
  logArmWithdrawal(ctx, refusal, outcome);
  return true;
}

type ArmWithdrawalCtx = Parameters<typeof withdrawArmIfVerdictRefuses>[1];

/** Why the verdict refuses an arm, so one taken at open is withdrawn; undefined when it permits one. */
function armWithdrawalReason(verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">, ctx: ArmWithdrawalCtx,
  ledgerLines: () => ReadonlyArray<Record<string, unknown>>): string | undefined {
  const override = verdict.capped
    ? cappedOverrideFromLedger([...ledgerLines()], ctx.taskId, ctx.headSha, ctx.prUrl)
    : undefined;
  const decision = decideAutoMergeArm(verdict, false, override);
  return decision.arm ? undefined : decision.reason;
}

/** W1-T1056: the row follows the OUTCOME, never the attempt. This is the load-bearing site —
 *  it runs BECAUSE the PR was armed at open and the verdict now refuses, so there is genuinely
 *  an arm to withdraw, and this row is the one an incident reader consults when asking "did the
 *  arm fire, and why did a refused PR merge anyway?". A failed withdrawal recorded as
 *  `automerge.disarmed` leaves the arm standing on GitHub and the ledger asserting it is gone. */
function logArmWithdrawal(ctx: ArmWithdrawalCtx, refusal: string, outcome: DisarmOutcome | void): void {
  ctx.log(disarmOutcomeWithdrawn(outcome) ? "automerge.disarmed" : "automerge.disarm_skipped", {
    reason: `verdict refuses auto-merge: ${refusal}`,
    outcome,
    head_sha: ctx.headSha,
  });
}

/** W1-T15030 — {@link withdrawArmIfVerdictRefuses} with the disarm awaited, so a disarm GitHub refuses with HTTP 401
 *  renews the token once and retries once. The same decision and the same rows; `token_unrenewable` is returned for the
 *  caller to stop on. */
export async function withdrawArmIfVerdictRefusesAsync(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  ctx: Parameters<typeof withdrawArmIfVerdictRefuses>[1],
  deps: Omit<NonNullable<Parameters<typeof withdrawArmIfVerdictRefuses>[2]>, "disarm"> & DisarmRenewal & {
    disarm?: (prUrl: string) => DisarmOutcome | void | Promise<DisarmOutcome | void>;
  } = {},
): Promise<{ withdrawn: boolean; outcome?: DisarmOutcome | void }> {
  // Only a capped verdict reads the ledger (its operator override), and that read is awaited.
  const rows = !verdict.capped ? [] : deps.ledgerLines?.() ??
    await readLedgerUnionRecords(dirname(ctx.ledgerPath), { selectRotation: () => false,
      step: ["automerge.capped_override_granted"], where: (row) => row.head_sha === ctx.headSha });
  const refusal = armWithdrawalReason(verdict, ctx, () => rows);
  if (refusal === undefined) return { withdrawn: false };
  const renewToken = deps.renewToken ?? (() => renewReviewPublisherToken({ force: true }));
  const outcome = await (deps.disarm ?? ((prUrl: string) => disarmAutoMergeAsync(prUrl, realArmDepsAsync(), { renewToken })))(ctx.prUrl);
  logArmWithdrawal(ctx, refusal, outcome);
  return { withdrawn: true, outcome };
}

/** W1-T15030: the claim this run holds at `headSha` was taken over by another run, read from the ledger. */
export async function reviewClaimLost(ledgerPath: string, runId: string, headSha: string, prUrl: string): Promise<string | undefined> {
  try {
    const claims = await readLedgerUnionRecords(dirname(ledgerPath), { selectRotation: () => false, step: ["review.pending_posted"],
      where: (row) => row.head_sha === headSha });
    return reviewClaimTakenOverBy(claims, runId, headSha, prUrl);
  } catch {
    // An unreadable ledger proves no takeover; the guarded post's own lock and lifecycle reads still decide.
    return undefined;
  }
}

/** W1-T15030: an escalation's issue gateway whose every GitHub write and read renews a refused token once and retries
 *  once, as the status posts and disarms do. A second 401 records `review.post_refused` reason `token_unrenewable`
 *  (phase `escalation`) and fails the call as before, so tryEscalateAsync ledgers it and nothing is filed. */
export function renewingIssueGateway(gateway: AsyncIssueGateway | ReviewIssueGateway, ctx: {
  log: (step: string, extra?: Record<string, unknown>) => void; prUrl?: string; headSha?: string;
  renewToken?: () => Promise<unknown>;
}): AsyncIssueGateway {
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(gateway)) {
    if (typeof member !== "function") { wrapped[name] = member; continue; }
    const call = (args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(gateway, args);
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await call(args);
      } catch (first) {
        if (!ghUnauthorizedError(first)) throw first;
      }
      await (ctx.renewToken ?? (() => renewReviewPublisherToken({ force: true })))();
      try {
        return await call(args);
      } catch (second) {
        if (ghUnauthorizedError(second)) {
          ctx.log("review.post_refused", { pr_url: ctx.prUrl, head_sha: ctx.headSha, reason: "token_unrenewable", phase: "escalation",
            gateway_call: name });
        }
        throw second;
      }
    };
  }
  return wrapped as AsyncIssueGateway;
}

/** W1-T15030: an awaited withdrawal once this run may already have published. The claim is re-read first (a run that
 *  lost it disarms nothing), and a disarm GitHub refused twice is recorded `token_unrenewable`, never discarded. */
export async function withdrawAfterPublication(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly">,
  ctx: ArmWithdrawalCtx & { runId: string },
  deps: Parameters<typeof withdrawArmIfVerdictRefusesAsync>[2] & { claimLost?: () => Promise<string | undefined> } = {},
): Promise<"claim_lost" | "token_unrenewable" | undefined> {
  const { claimLost, ...withdrawDeps } = deps;
  const taker = await (claimLost ?? (() => reviewClaimLost(ctx.ledgerPath, ctx.runId, ctx.headSha, ctx.prUrl)))();
  if (taker !== undefined) {
    ctx.log("review.post_refused", { pr_url: ctx.prUrl, head_sha: ctx.headSha, attempted_state: verdict.state, reason: "claim_lost",
      phase: "arm_withdrawal", taken_over_by_run_id: taker });
    return "claim_lost";
  }
  const withdrawal = await withdrawArmIfVerdictRefusesAsync(verdict, ctx, withdrawDeps);
  if (withdrawal.outcome !== "token_unrenewable") return undefined;
  ctx.log("review.post_refused", { pr_url: ctx.prUrl, head_sha: ctx.headSha, attempted_state: verdict.state,
    reason: "token_unrenewable", phase: "arm_withdrawal" });
  return "token_unrenewable";
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

export class ReviewerSnapshotError extends Error {
  constructor(
    readonly phase: ReviewerSnapshotPhase,
    readonly reason: "source-unavailable" | "head-mismatch" | "clone-failed" | "unreadable" | "dirty",
    message: string,
    /** W1-T14938: why an integrity read failed — the git subcommand, its error and whether the checkout path exists. */
    readonly unreadable?: { gitCommand: string; gitError: string; checkoutExists: boolean },
  ) {
    super(message);
    this.name = "ReviewerSnapshotError";
  }
}

/** W1-T14938: the `review.reviewer.<phase>_error` row's fields, naming the failed git read when there was one. */
export function reviewerSnapshotErrorRow(e: ReviewerSnapshotError): Record<string, unknown> {
  return {
    reason: e.reason,
    error: e.message,
    ...(e.unreadable ? { git_command: e.unreadable.gitCommand, git_error: e.unreadable.gitError, checkout_exists: e.unreadable.checkoutExists } : {}),
  };
}

/**
 * W1-T14938: the shadow judge's integrity check. runShadowJudge records any judge error only as
 * shadow_judge.unavailable, so this logs the review.reviewer.<phase>_error row first and rethrows: the
 * shadow result is still discarded, and the row still names the failed git read.
 */
export function assertShadowSnapshotIntegrity(
  host: Pick<ReviewCommandHost, "GIT_UNTRACKED_FILES_ALL">, cwd: string, expectedHeadSha: string,
  log: (step: string, fields: Record<string, unknown>) => void,
): void {
  try {
    assertReviewerSnapshotIntegrity(host, cwd, expectedHeadSha);
  } catch (e) {
    // The row is diagnostic: a failed append (a full disk) must never replace the checkout refusal, so the original
    // ReviewerSnapshotError is always the one rethrown.
    if (e instanceof ReviewerSnapshotError) {
      try { log(`review.reviewer.${e.phase}_error`, reviewerSnapshotErrorRow(e)); } catch { /* the refusal below still stands */ }
    }
    throw e;
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
): { cwd: string; nodeModules: ReturnType<typeof linkWorktreeNodeModules>; dependencyReadRoots: string[]; originMain: string | null } {
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
  let originMain: string | null;
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", "--", sourceRepo, cwd], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    // W1-T11343: a clone maps the source's LOCAL main, which the daemon never moves, to origin/main.
    // Pin the source's own origin/main instead; with none keep none, not a stale base posing as main.
    originMain = hostWorktreeGit(sourceRepo, ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/main"]).trim() || null;
    hostWorktreeGit(cwd, originMain ? ["update-ref", "refs/remotes/origin/main", originMain] : ["update-ref", "-d", "refs/remotes/origin/main"]);
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

  // Only the clone's exclude changes, so a linked dependency tree stays invisible to the post-review
  // cleanliness proof even where .gitignore omits node_modules. Dependency roots outside the
  // checkout reach Codex read-only; the source checkout gets no broader writable sandbox grant.
  excludeNodeModulesFromGit(cwd);
  const dependencyRoot = (() => { try { const source = resolveNodeModulesSource(sourceDir); return source ? realpathSync(source) : undefined; } catch { /* No source earns no grant. */ return undefined; } })();
  const nodeModules = linkWorktreeNodeModules(sourceDir, cwd, dependencyRoot ? { resolveSource: () => dependencyRoot } : {});
  const dependencyRelative = dependencyRoot ? relative(cwd, dependencyRoot) : "";
  const dependencyReadRoots = dependencyRoot && (dependencyRelative === ".." || dependencyRelative.startsWith(`..${sep}`) || isAbsolute(dependencyRelative)) ? [dependencyRoot] : [];
  return { cwd, nodeModules, dependencyReadRoots, originMain };
}

/** A semantic result is usable only while the disposable checkout remains exact and clean. */
export function assertReviewerSnapshotIntegrity(host: Pick<ReviewCommandHost, "GIT_UNTRACKED_FILES_ALL">, cwd: string, expectedHeadSha: string): void {
  const { GIT_UNTRACKED_FILES_ALL } = host;
  // W1-T14938: each read runs alone, so a refusal names the subcommand that failed, its error and whether the path exists.
  const unreadable = (gitCommand: string, e: unknown) => new ReviewerSnapshotError(
    "integrity", "unreadable", "semantic reviewer checkout integrity is unreadable",
    { gitCommand, gitError: String((e as Error)?.message ?? e), checkoutExists: existsSync(cwd) },
  );
  let actualHead: string;
  try {
    actualHead = hostWorktreeGit(cwd, ["rev-parse", "HEAD"]).trim();
  } catch (e) {
    throw unreadable("rev-parse", e);
  }
  let status: string;
  try {
    // W1-T14939: no output bound — Node's 1 MiB default turned a large dirty tree into ENOBUFS, read as "unreadable".
    status = hostWorktreeGit(cwd, ["status", "--porcelain=v1", GIT_UNTRACKED_FILES_ALL], { maxBuffer: Infinity });
  } catch (e) {
    throw unreadable("status", e);
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

/** W1-T13849: an earlier downgrade-unclassified hold at this head and input digest (else decision digest). History
 *  that cannot be read counts as held, so the FAIL folds as origin/main does and is never withheld again blindly. */
export async function unclassifiedHoldRecorded(ledgerPath: string | undefined, headSha: string,
  inputDigest: string | undefined, decisionDigest: string, shadow = false): Promise<boolean> {
  if (!ledgerPath) return true;
  const stateDir = dirname(ledgerPath);
  const step = reviewerShadowStep("review.semantic_incomplete", shadow);
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await readLedgerUnionRawLinesAsync(stateDir, { step, refuseIncomplete: true,
      keep: (line) => line.includes(headSha) && line.includes(DOWNGRADE_UNCLASSIFIED) });
    if (!read.ok || read.rawLines.some((line) => {
      // The union's exact step filter already verified each line as a JSON object.
      const row = JSON.parse(line) as Record<string, unknown>;
      return row.reason === DOWNGRADE_UNCLASSIFIED && row.head_sha === headSha && (inputDigest !== undefined
        ? row.review_input_digest === inputDigest : row.review_decision_digest === decisionDigest);
    })) return true;
    // Rotation publishes its archive before replacing the live file. A second listing after a miss
    // detects an archive that landed between the first listing and the live read.
    let listed = true;
    const { rotations } = listedLedgerFiles(stateDir, { readdirSync }, () => { listed = false; });
    if (!listed) return true;
    if (rotations.length === read.archiveFiles.length && rotations.every((entry, i) => entry.path === read.archiveFiles[i])) return false;
  }
  return true; // Repeated rotation leaves history uncertain, just like an unreadable ledger.
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

/** W1-T11163 — this head's required checks green (branch protection's own list) and its review success, read fresh. */
export async function readChecksGreenReviewedAtHead(
  owner: string,
  repo: string,
  headSha: string,
  readJson: (args: string[]) => unknown = ghJsonAsync,
  readText: (args: string[]) => Promise<string> = ghTextAsync,
): Promise<boolean> {
  const required = await readRequiredStatusCheckContextsAsync(owner, repo, "main", readText);
  if (required.kind !== "contexts") return false;
  const rollup = await rollupForAsync(owner, repo, headSha, readJson);
  return checksStateFromRollup(rollup, required.contexts) === "green" && reviewStateFromRollup(rollup) === "success";
}

/** W1-T11151: the raw status poster, recording whether a publication threw. That is the one non-terminal outcome (the
 *  guarded post ledgers `review.post_failed`), so it alone keeps the review's slot until it settles; a posted, refused,
 *  withheld or replayed verdict is terminal and reports `posted`. */
export { readReviewStatusHistory, type ReviewStatusHistoryReader } from "../../lib/review.js";

/** W1-T14179: the writer a review comment names, hidden in the rendered text, so another host can tell its runs apart. */
const REVIEW_WRITER_MARKER = /<!-- remudero-review writer run=(\S+) input=(\S+) code=(\S+) -->/;
export function reviewWriterMarker(runId: string, inputDigest: string | undefined, codeSha: string | undefined): string {
  return `<!-- remudero-review writer run=${runId} input=${inputDigest ?? "none"} code=${codeSha ?? "none"} -->`;
}

/** W1-T14179: the newest terminal remudero-review status at a head when it is a FAIL, with what its comment names. */
export interface StandingReviewFailure {
  headSha: string;
  runId?: string;
  inputDigest?: string;
  codeSha?: string;
  unmet: { claim: string; reason: string }[];
}
type SharedReviewStatusHistory = ReviewStatusHistory & { standingFailure?: StandingReviewFailure };
export interface ReviewPassDispute { reason: string; description: string; failRunId?: string; unanswered: string[]; standing: StandingReviewFailure }
type ReviewWriter = { runId: string; inputDigest?: string; codeSha?: string };

export function standingReviewFailureFromHistory(statuses: readonly unknown[], reviews: readonly unknown[], headSha: string): StandingReviewFailure | undefined {
  const field = (row: unknown, key: string): unknown => (row as Record<string, unknown> | null)?.[key];
  const terminal = statuses.find((row) => field(row, "context") === REVIEW_CONTEXT && String(field(row, "state")).toLowerCase() !== "pending");
  if (terminal === undefined || String(field(terminal, "state")).toLowerCase() !== "failure") return undefined;
  const bodies = reviews.filter((row) => field(row, "commit_id") === headSha && typeof field(row, "body") === "string" &&
    /^\s*\*\*remudero-review=failure\*\*/.test(String(field(row, "body"))))
    .sort((a, b) => String(field(a, "submitted_at") ?? "").localeCompare(String(field(b, "submitted_at") ?? "")));
  const body = String(field(bodies.at(-1), "body") ?? "");
  const marker = REVIEW_WRITER_MARKER.exec(body);
  const named = (value: string | undefined): string | undefined => value === undefined || value === "none" ? undefined : value;
  const unmet: { claim: string; reason: string }[] = [];
  for (const line of body.split(/\r?\n---\s*(?:\r?\n|$)/)[0]!.split(/\r?\n/)) {
    const item = /^(?:\d+\.|-)\s+(.+)$/.exec(line);
    if (item) unmet.push({ claim: item[1]!.trim(), reason: "" });
    else if (unmet.length > 0 && /^\s+\S/.test(line)) unmet.at(-1)!.reason += `${line.trim().replace(/^- /, "")}\n`;
  }
  const runId = named(marker?.[1]), inputDigest = named(marker?.[2]);
  const codeSha = named(marker?.[3]) ?? reviewCodeShaFromDescription(field(terminal, "description"));
  return { headSha, ...(runId ? { runId } : {}), ...(inputDigest ? { inputDigest } : {}), ...(codeSha ? { codeSha } : {}),
    unmet: unmet.map((criterion) => ({ claim: criterion.claim, reason: criterion.reason.trim() })) };
}

async function readReviewHistoryPages(readJson: (args: string[], options: { fresh: true }) => unknown | Promise<unknown>, endpoint: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const value = await readJson(["api", `${endpoint}?per_page=100&page=${page}`], { fresh: true });
    if (!Array.isArray(value)) throw new Error("GitHub returned a non-list response");
    rows.push(...value.flat());
    if (value.flat().length < 100) return rows;
  }
  throw new Error("GitHub history still full after 10 pages");
}

/** W1-T14179: {@link readReviewStatusHistory} plus the standing FAIL, from the same GitHub reads. Any read error is unreadable. */
async function readSharedReviewStatusHistory(owner: string, repo: string, prUrl: string, headSha: string,
  readJson: (args: string[], options: { fresh: true }) => unknown | Promise<unknown> =
    (args, options) => ghJsonAsync(args, undefined, undefined, options)): Promise<SharedReviewStatusHistory> {
  const reads = new Map<string, Promise<unknown>>();
  const once = (args: string[], options: { fresh: true }): Promise<unknown> => {
    const key = args.join("\0");
    if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => readJson(args, options)));
    return reads.get(key)!;
  };
  const history = await readReviewStatusHistory(owner, repo, prUrl, headSha, once);
  if (history.kind === "unreadable") return history;
  try {
    const statuses = await readReviewHistoryPages(once, `repos/${owner}/${repo}/commits/${headSha}/statuses`);
    const failed = standingReviewFailureFromHistory(statuses, [], headSha);
    if (failed === undefined) return history;
    const number = /\/pull\/([1-9]\d*)\/?$/.exec(prUrl)?.[1];
    if (number === undefined) throw new Error("PR number is unavailable from review URL");
    const reviews = await readReviewHistoryPages(once, `repos/${owner}/${repo}/pulls/${number}/reviews`);
    return { ...history, standingFailure: standingReviewFailureFromHistory(statuses, reviews, headSha) };
  } catch (error) {
    return { kind: "unreadable", reason: `GitHub remudero-review standing failure unreadable: ${String((error as Error)?.message ?? error)}` };
  }
}

/** W1-T14179 (invariant no-silent-override): why a PASS may not replace another run's standing FAIL on this head,
 *  input and reviewer code (an unknown code on either side counts as the same). A criterion is answered when its own proof executed and passed where the FAIL's proof did not, or when the
 *  reproduced-failure rule recorded it addressed. A FAIL whose criteria are unreadable is never answered. */
export function passDisputesStandingFailure(verdict: Pick<ReviewVerdict, "state" | "criteria">, headSha: string, writer: ReviewWriter,
  history: ReviewStatusHistory, answeredClaims: ReadonlySet<string> = new Set()): ReviewPassDispute | undefined {
  if (verdict.state !== "success" || history.kind !== "readable") return undefined;
  const standing = (history as SharedReviewStatusHistory).standingFailure;
  if (standing === undefined || standing.headSha !== headSha || standing.runId === writer.runId) return undefined;
  if (standing.inputDigest !== undefined && writer.inputDigest !== undefined && standing.inputDigest !== writer.inputDigest) return undefined;
  if (standing.codeSha !== undefined && writer.codeSha !== undefined && standing.codeSha !== writer.codeSha) return undefined;
  const answers = (failed: { claim: string; reason: string }): boolean => {
    const matches = verdict.criteria.filter((criterion) => criterion.claim.trim() === failed.claim);
    return answeredClaims.has(failed.claim) || (matches.length === 1 && matches[0]!.met && matches[0]!.proof_exec === "executed_pass" &&
      failed.reason !== "" && !/proof executed and PASSED/i.test(failed.reason));
  };
  const unanswered = standing.unmet.length === 0 ? ["the FAIL names no readable criterion"]
    : standing.unmet.filter((failed) => !answers(failed)).map((failed) => failed.claim);
  if (unanswered.length === 0) return undefined;
  const failRun = standing.runId ?? "unknown";
  return { reason: `PASS of run ${writer.runId} disputes the standing FAIL of run ${failRun} on ${headSha.slice(0, 7)}; ` +
      `${unanswered.length} unmet criteria unanswered`,
    description: `remudero-review: pending — PASS disputes FAIL of run ${failRun}`, ...(standing.runId ? { failRunId: standing.runId } : {}),
    unanswered, standing };
}

/** W1-T14179: the publish path's history read, refusing a disputed PASS. The reproduced-failure rule and the semantic
 *  rule decide first; a plan-only pass has no semantic judgement to dispute. */
function disputeGuardedHistoryReader(read: ReviewStatusHistoryReader, verdict: ReviewVerdict, writer: ReviewWriter,
  judgement: { planOnly?: unknown; reviewerOutcome?: unknown }, onDispute: (dispute: ReviewPassDispute) => void,
  evidence?: Parameters<typeof applyReviewStatusHistoryGuard>[3], presentedFailureIds: readonly string[] = []): ReviewStatusHistoryReader {
  if (judgement.planOnly === true || semanticJudgementRefusal(judgement) !== undefined) return read;
  return async (owner, repo, prUrl, headSha) => {
    const history = await read(owner, repo, prUrl, headSha);
    const reproduction = applyReviewStatusHistoryGuard(verdict, headSha, history, evidence, undefined, presentedFailureIds);
    if (history.kind !== "readable" || reproduction.verdict.state !== "success") return history;
    const addressed = new Set(reproduction.verdict.reproducedFailureIdsAddressed ?? []);
    const answered = new Set(history.failures.filter((failure) => failure.headSha === headSha && addressed.has(failure.id))
      .map((failure) => failure.finding.split(/\r?\n/, 1)[0]!.replace(/^\s*\d+\.\s*/, "").trim()));
    const dispute = passDisputesStandingFailure(verdict, headSha, writer, history, answered);
    if (dispute === undefined) return history;
    onDispute(dispute);
    return { kind: "unreadable", reason: dispute.reason };
  };
}

/** W1-T14179: a disputed PASS posts pending naming both runs, withdraws any arm and raises one escalation. */
async function holdDisputedPass(dispute: ReviewPassDispute, verdict: ReviewVerdict, ctx: {
  owner: string; repo: string; prUrl: string; headSha: string; taskId: string; runId: string; ledgerPath: string;
  catalog?: "public" | "ops"; log: (step: string, extra?: Record<string, unknown>) => void;
  disarm?: (prUrl: string) => DisarmOutcome | void; renewToken?: () => Promise<unknown>;
  publish: (held: ReviewVerdict, description: string, claimLost: () => Promise<string | undefined>) => Promise<{ posted: boolean; claimLost?: string }>;
}): Promise<ReviewVerdict & { verdictWithheld: string }> {
  const held: ReviewVerdict = { ...verdict, state: "pending", summary: dispute.description };
  // W1-T15030: a run that lost its claim disarms nothing, posts nothing and opens no escalation.
  const taker = await reviewClaimLost(ctx.ledgerPath, ctx.runId, ctx.headSha, ctx.prUrl);
  if (taker !== undefined) {
    ctx.log("review.post_refused", { pr_url: ctx.prUrl, head_sha: ctx.headSha, attempted_state: "success", outcome: "disputed_pass_held",
      reason: "claim_lost", taken_over_by_run_id: taker });
    return { ...held, verdictWithheld: "claim_lost" };
  }
  const claimLost = () => reviewClaimLost(ctx.ledgerPath, ctx.runId, ctx.headSha, ctx.prUrl);
  const withdrawn = await withdrawAfterPublication(held, { prUrl: ctx.prUrl, taskId: ctx.taskId, headSha: ctx.headSha,
    ledgerPath: ctx.ledgerPath, log: ctx.log, runId: ctx.runId },
    { disarm: ctx.disarm, claimLost, ...(ctx.renewToken ? { renewToken: ctx.renewToken } : {}) });
  if (withdrawn !== undefined) return { ...held, verdictWithheld: withdrawn };
  const published = await ctx.publish(held, dispute.description, claimLost);
  // W1-T15030: the post re-read the claim under its lock; a run that lost it there opens no escalation.
  if (published.claimLost !== undefined) return { ...held, verdictWithheld: "claim_lost" };
  const ops = ctx.catalog === "ops";
  const issueUrl = await tryEscalateAsync({
    class: "MANUAL", taskId: ctx.taskId, runId: ctx.runId, headSha: ctx.headSha, cause: "review",
    summary: `PR ${ctx.prUrl} has a PASS that disputes a standing FAIL`,
    detail: ops ? "Two reviews disagree on this head; detailed evidence is retained on the host."
      : `${dispute.reason}. Unanswered: ${dispute.unanswered.join("; ")}.`,
    options: [
      { label: "Run a third review", detail: "Run one more semantic review of this head to settle the disagreement." },
      { label: "Decide by hand", detail: "Read both reviews, then post the verdict this head deserves." },
    ],
    recommendation: "Run a third review",
    consequence: "The required review remains pending and the PR cannot merge.",
  }, { issues: renewingIssueGateway(ghIssueGatewayAsync(ctx.owner, ctx.repo), { log: ctx.log, prUrl: ctx.prUrl, headSha: ctx.headSha,
    ...(ctx.renewToken ? { renewToken: ctx.renewToken } : {}) }), ledgerPath: ctx.ledgerPath, runId: ctx.runId });
  ctx.log("review.post_refused", {
    pr_url: ctx.prUrl, head_sha: ctx.headSha, attempted_state: "success", outcome: "disputed_pass_held", reason: dispute.reason,
    pass_run_id: ctx.runId, fail_run_id: dispute.failRunId ?? null, fail_review_input_digest: dispute.standing.inputDigest ?? null,
    unanswered_criteria: ops ? dispute.unanswered.length : dispute.unanswered, pending_posted: published.posted, escalation_issue_url: issueUrl,
  });
  return { ...held, verdictWithheld: dispute.reason };
}

export function failureRecordingPoster(): { post: (o: Parameters<typeof postReviewStatus>[0]) => Promise<void>; failed: () => boolean; published: () => boolean } {
  let threw = false;
  let published = false;
  return {
    post: async (o) => {
      try {
        // W1-T15030: the guarded publisher's postRenewingOnce owns the one renewal and retry; no re-mint runs in here.
        await postReviewStatus(o);
        published = true;
        // W1-T15030: a retry that published clears the failure an earlier attempt recorded.
        threw = false;
      } catch (error) {
        threw = true;
        throw error;
      }
    },
    failed: () => threw,
    published: () => published,
  };
}

async function readReviewHostedJobLog(argv: string[]): Promise<string> {
  const lines: string[] = [];
  await ghLinesAsync(argv, line => {
    // Keep the shared parser's receipts, test locations and failure section marker in order.
    if (line.includes("RMD-TEST-FILE-DIAGNOSTIC ") || line.includes(".test.") || line.includes("✖ failing tests:")) {
      lines.push(line);
    }
  });
  return lines.join("\n");
}

/** W1-T11200: share the fix lane's exact-head, file-receipt reader with the review judge. */
export async function reviewHostedCiFileEvidence(
  args: { owner: string; repo: string; headSha: string; criteria: readonly AcceptanceCriterion[];
    headCheckoutDir?: string; log: (step: string, extra?: Record<string, unknown>) => void },
  read: HostedFixProofReader = (headSha, proofs) => readHostedFixProofResults({
    owner: args.owner, repo: args.repo, headSha, proofs,
  }, { json: ghJsonAsync, text: readReviewHostedJobLog }),
): Promise<ReadonlyMap<string, "passed" | "failed"> | undefined> {
  try {
    const files = new Set<string>();
    for (const criterion of visibleCriteria([...args.criteria])) {
      const text = args.headCheckoutDir
        ? resolveProofTestPath(criterion.proof, args.headCheckoutDir, { target: args }).proof : criterion.proof;
      const proof = parseWhitelistedProof(text, args);
      if (proof?.kind !== "test") continue;
      if (!proof.nameFiltered) files.add(proof.label);
      else if (args.headCheckoutDir && proof.runner !== "vitest") {
        const resolution = await resolveNameFilteredCandidatesAsync(args.headCheckoutDir, proof.label);
        if (resolution.status === "resolved") for (const file of resolution.files) files.add(file);
      }
    }
    if (files.size === 0) return undefined;
    const results = await read(args.headSha, [...files].map(file => `unit test: ${file}`));
    const evidence = new Map<string, "passed" | "failed">();
    for (const result of results) {
      if (result.headSha !== args.headSha || !files.has(result.testFile)) continue;
      if (result.result === "fail") evidence.set(result.testFile, "failed");
      else if (!evidence.has(result.testFile)) evidence.set(result.testFile, "passed");
    }
    return evidence.size > 0 ? evidence : undefined;
  } catch (error) {
    args.log("review.hosted_ci.unavailable", { head_sha: args.headSha, reason: String(error) });
    return undefined;
  }
}

// ── W1-T11157: CI'S PROOF-DISCRIMINATION RECORD, COMPARED IN SHADOW ───────────────────────────────────────────────
// Operator trust decision 2026-11-03: the record is authenticated only as the log of a successful GitHub Actions job of
// the proof-discrimination workflow at this exact head, read through the App gateway; the executor is the gate's import
// closure plus its toolchain inputs and workflow (scripts/proof-discrimination-gate.mjs computes it for both sides); and
// a hosted outcome counts toward no verdict. The review still runs every proof and only ledgers agreement.

/** One row per review that ran proofs at a head checkout: per-proof agreement, or why the record was not eligible. */
export const PROOF_REUSE_SHADOW_STEP = "review.proof_reuse_shadow";

interface HostedProofOutcome { proof: string; head: string; base: string; verdict: string }
interface ProofDiscriminationRecord {
  format?: string; head_sha?: string; base_sha?: string; body_digest?: string; criteria_source?: string;
  executor_digest?: string | null; workflow_digest?: string | null; too_large?: boolean; proofs?: HostedProofOutcome[];
}
export type ProofDiscriminationRecordRead =
  | { kind: "record"; record: ProofDiscriminationRecord; runId: number; jobId: number }
  | { kind: "ineligible"; reason: string };
interface ProofRecordIo {
  json: (args: string[]) => Promise<unknown>;
  lines: (args: string[], onLine: (line: string) => void) => Promise<void>;
}

const WORKFLOW_PATH: string = PROOF_DISCRIMINATION_WORKFLOW;

/** The record for `headSha`: the latest successful pull_request run of the workflow at that head, its successful
 *  proof-discrimination job, and the one record line in that job's log. Three App-gateway reads. */
export async function readProofDiscriminationRecord(
  target: { owner: string; repo: string; headSha: string },
  io: ProofRecordIo = { json: ghJsonAsync, lines: ghLinesAsync },
): Promise<ProofDiscriminationRecordRead> {
  const repoPath = `repos/${target.owner}/${target.repo}`;
  const workflowFile = WORKFLOW_PATH.slice(WORKFLOW_PATH.lastIndexOf("/") + 1);
  const listed = await io.json(["api", `${repoPath}/actions/workflows/${workflowFile}/runs?head_sha=${target.headSha}&status=success&per_page=20`]) as
    { workflow_runs?: Array<{ id?: unknown; head_sha?: unknown; path?: unknown; conclusion?: unknown; event?: unknown }> } | undefined;
  const runIds = (listed?.workflow_runs ?? []).filter(run => typeof run.id === "number" && run.head_sha === target.headSha &&
    run.conclusion === "success" && run.event === "pull_request" &&
    (run.path === WORKFLOW_PATH || String(run.path).startsWith(`${WORKFLOW_PATH}@`))).map(run => run.id as number);
  if (runIds.length === 0) return { kind: "ineligible", reason: "no successful proof-discrimination run at this head" };
  const runId = Math.max(...runIds);
  const listedJobs = await io.json(["api", `${repoPath}/actions/runs/${runId}/jobs?per_page=50`]) as
    { jobs?: Array<{ id?: unknown; name?: unknown; head_sha?: unknown; conclusion?: unknown; run_id?: unknown }> } | undefined;
  const job = (listedJobs?.jobs ?? []).find(entry => typeof entry.id === "number" && entry.name === PROOF_DISCRIMINATION_JOB &&
    entry.head_sha === target.headSha && entry.conclusion === "success" && entry.run_id === runId);
  if (job === undefined) return { kind: "ineligible", reason: `run ${runId} has no successful ${PROOF_DISCRIMINATION_JOB} job at this head` };
  const jobId = job.id as number;
  const recordLines: string[] = [];
  await io.lines(["api", `${repoPath}/actions/jobs/${jobId}/logs`], line => {
    const text = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\r$/, "");
    if (text.startsWith(RESULT_MARKER)) recordLines.push(text.slice(RESULT_MARKER.length));
  });
  if (recordLines.length !== 1) {
    return { kind: "ineligible", reason: `job ${jobId} published ${recordLines.length} result records, not one` };
  }
  let record: ProofDiscriminationRecord;
  try {
    record = JSON.parse(recordLines[0]!) as ProofDiscriminationRecord;
  } catch (error) {
    return { kind: "ineligible", reason: `result record unreadable: ${String(error).slice(0, 200)}` };
  }
  if (record?.format !== RESULT_FORMAT) return { kind: "ineligible", reason: `result record format ${String(record?.format)} is not ${RESULT_FORMAT}` };
  return { kind: "record", record, runId, jobId };
}

/** Every path a unified diff names, both sides of a rename or copy included. */
export function diffTouchedPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      paths.add(header[1]!);
      paths.add(header[2]!);
      continue;
    }
    const moved = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (moved) paths.add(moved[1]!);
  }
  return [...paths];
}

/** check-proof's verdict names as the host's proof outcomes; an unmapped verdict never agrees. */
const HOSTED_VERDICT_AS_HOST: Readonly<Record<string, CriterionVerdict["proof_exec"]>> = {
  pass: "executed_pass", fail: "executed_fail", executed_stale: "executed_stale",
};

async function trackedPathsAsync(dir: string): Promise<string[]> {
  return (await hostWorktreeGitAsync(dir, ["ls-files", "-z"], { maxBuffer: 1 << 26 })).split("\0").filter(Boolean);
}

interface ProofReuseShadowInput {
  prUrl: string; headSha: string; diff: string; body: string | undefined; criteria: readonly AcceptanceCriterion[];
  headCheckoutDir: string; hostCriteria: readonly Pick<CriterionVerdict, "proof" | "proof_exec">[]; hostProofMs: number;
  listTracked?: (dir: string) => Promise<string[]>;
}

/** The {@link PROOF_REUSE_SHADOW_STEP} row for one review. Reads the head checkout only and never throws: the verdict
 *  is already built and this row is all it produces. `would_save_ms` is the host proof time an eligible reuse skips. */
export async function proofReuseShadowRow(read: ProofDiscriminationRecordRead, input: ProofReuseShadowInput): Promise<Record<string, unknown>> {
  try {
    return await compareProofReuse(read, input);
  } catch (error) {
    return { pr_url: input.prUrl, head_sha: input.headSha, host_proof_ms: input.hostProofMs, eligible: false, would_save_ms: 0,
      reason: `shadow comparison failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
}

async function compareProofReuse(read: ProofDiscriminationRecordRead, input: ProofReuseShadowInput): Promise<Record<string, unknown>> {
  const row = { pr_url: input.prUrl, head_sha: input.headSha, host_proof_ms: input.hostProofMs };
  const hosted = read.kind === "record" ? { hosted_run_id: read.runId, hosted_job_id: read.jobId } : {};
  const ineligible = (reason: string) => ({ ...row, eligible: false, reason, would_save_ms: 0, ...hosted });
  if (read.kind === "ineligible") return ineligible(read.reason);
  const record = read.record;
  if (record.head_sha !== input.headSha) return ineligible("result record names another head");
  if (record.too_large === true) return ineligible("record too large");
  if (input.body === undefined) return ineligible("no PR body snapshot to compare");
  if (record.body_digest !== bodyDigest(input.body)) return ineligible("body digest mismatch");
  const hostProofs: string[] = discriminationProofs(input.criteria);
  const hostedProofs = (record.proofs ?? []).map(outcome => outcome.proof);
  if (JSON.stringify([...hostProofs].sort()) !== JSON.stringify([...hostedProofs].sort())) {
    return ineligible(`criteria mismatch: ${hostedProofs.length} hosted proof(s), ${hostProofs.length} at the host`);
  }
  let digests: { files: string[]; executor_digest: string; workflow_digest: string | null };
  try {
    const tracked = await (input.listTracked ?? trackedPathsAsync)(input.headCheckoutDir);
    digests = proofDiscriminationDigests(tracked, (path: string) => readFileSync(join(input.headCheckoutDir, path)));
  } catch (error) {
    return ineligible(`executor digest unreadable: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }
  const executor = new Set(digests.files);
  const touched = diffTouchedPaths(input.diff).filter(path => executor.has(path) || path === WORKFLOW_PATH || path.startsWith("test/setup/"));
  if (touched.length > 0) return ineligible(`diff touches the executor: ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""}`);
  if (digests.executor_digest !== record.executor_digest) return ineligible("executor digest mismatch");
  if (digests.workflow_digest !== record.workflow_digest) return ineligible("workflow digest mismatch");
  const proofs = (record.proofs ?? []).map(outcome => {
    const host = input.hostCriteria.find(criterion => criterion.proof.trim() === outcome.proof)?.proof_exec ?? "not_judged";
    return { proof: outcome.proof, hosted: outcome.verdict, hosted_head: outcome.head, hosted_base: outcome.base, host,
      agree: HOSTED_VERDICT_AS_HOST[outcome.verdict] === host };
  });
  const agreed = proofs.filter(proof => proof.agree).length;
  return { ...row, eligible: true, ...hosted, criteria_source: record.criteria_source, would_save_ms: input.hostProofMs,
    agreed, disagreed: proofs.length - agreed, proofs };
}

// Project at the final write: status guards may replace a description with a private failure reason.
// W1-T14035: a pending ops post keeps the run its guarded description names, so an ops hold names its owner as a public
// one does; it carries no code provenance, as no pending post does.
export function catalogReviewPoster(catalog: "public" | "ops" | undefined, post: typeof postReviewStatus, codeSha?: string): typeof postReviewStatus {
  return catalog !== "ops" ? post : async options => {
    // W1-T14902: a task hold keeps a public-safe description naming the hold, so an ops task's PR says why it waits.
    const held = options.state === "pending" ? publicTaskHoldDescription(options.description) : undefined;
    const description = held ?? `remudero-review: ${options.state} — detailed evidence retained on host`;
    const owner = options.state === "pending" ? reviewStatusOwnerRun(options.description) : undefined;
    await post({ ...options, description: owner !== undefined ? reviewPendingDescriptionWithOwner(description, owner)
      : codeSha ? reviewDescriptionWithCodeProvenance(description, codeSha) : description });
  };
}

/** W1-T14581: the ops-task review comment. Publication permits only acceptance text (W1-T12207), so each visible
 *  claim carries its verdict mark — PASS, FAIL, or UNDETERMINED for a proof that reached no conclusion — and nothing
 *  else: no reason, proof output, path or measurement. A reader of the PR can see WHICH claim failed. */
export function opsReviewCommentBody(state: string, acceptance: readonly AcceptanceCriterion[],
  criteria: ReadonlyArray<Pick<CriterionVerdict, "claim" | "met" | "proof_exec">>): string {
  const marks = visibleCriteria([...acceptance]).map(criterion => {
    const index = acceptance.indexOf(criterion);
    const judged = criteria[index]?.claim === criterion.claim ? criteria[index] : criteria.find(c => c.claim === criterion.claim);
    const mark = judged === undefined || !judged.met && proofConcludedNothing(judged.proof_exec) ? "UNDETERMINED"
      : judged.met ? "PASS" : "FAIL";
    return `- ${mark}: ${criterion.claim}`;
  });
  return `**remudero-review=${state}** — detailed evidence retained on host\n\n${marks.join("\n")}`;
}

/** W1-T14581: the host-side review record of one reviewed head of an ops-catalog task — the full criterion reasons
 *  and every reviewer finding (mechanism, remedy, anchor) its PR may not show. Console's PR view and the fix lane
 *  read it through the `review_record_path` its `review.posted` row carries. Holdout criteria (W1-T166) and their
 *  findings never enter it: the fix lane is worker-readable. */
export interface OpsReviewRecord {
  version: 1;
  task_id: string;
  pr_url: string;
  head_sha: string;
  state: string;
  review_decision_digest: string;
  criteria: Array<{ index: number; claim: string; met: boolean; proof_exec: string; proof: string; reason: string;
    proof_failure_output?: string;
    /** W1-T15100: a failed sandbox start check's stderr, exit code or signal, and each bind source's state. */
    sandbox_start_failure?: { stderr: string; exit_code: number | null; signal: string | null; bind_sources: Array<{ path: string; existed: boolean }> } }>;
  reasons: string[];
  findings: Array<{ criterion_index: number; category: string; severity: string; mechanism: string; remedy: string | null;
    anchor: FindingCapture["findings"][number]["anchor"] }>;
}

export function opsReviewRecord(input: { taskId: string; prUrl: string; headSha: string; state: string; decisionDigest: string;
  criteria: readonly CriterionVerdict[]; reasons: readonly string[]; findings: FindingCapture["findings"] }): OpsReviewRecord {
  return {
    version: 1, task_id: input.taskId, pr_url: input.prUrl, head_sha: input.headSha, state: input.state,
    review_decision_digest: input.decisionDigest,
    criteria: input.criteria.flatMap((c, i) => c.holdout ? [] : [{ index: i + 1, claim: c.claim, met: c.met,
      proof_exec: c.proof_exec, proof: c.proof, reason: c.reason,
      ...(c.proofFailureOutput !== undefined ? { proof_failure_output: c.proofFailureOutput } : {}),
      ...(c.sandboxStartFailure !== undefined ? { sandbox_start_failure: { stderr: c.sandboxStartFailure.stderr,
        exit_code: c.sandboxStartFailure.exitCode ?? null, signal: c.sandboxStartFailure.signal ?? null,
        bind_sources: c.sandboxStartFailure.bindSources.map((b) => ({ path: b.path, existed: b.existed })) } } : {}) }]),
    reasons: [...input.reasons],
    findings: input.findings.filter(f => input.criteria[f.criterion - 1]?.holdout !== true).map(f => ({
      criterion_index: f.criterion, category: f.category, severity: f.severity, mechanism: f.mechanism, remedy: f.remedy,
      anchor: f.anchor })),
  };
}

/** W1-T15077: the private page of a failed or capped ops-task review: each criterion's reason, and each finding's
 *  file:line, mechanism, remedy and status. It lands only in the plan destination, never on the public PR. */
export function opsReviewFindingsMarkdown(record: OpsReviewRecord): string {
  const one = (text: string | null): string => (text ?? "none").replace(/\s+/g, " ").trim();
  return [`# Review of ${record.pr_url} at ${record.head_sha}`, "", `Task: ${record.task_id}. State: ${record.state}.`, "",
    "## Criteria", ...record.criteria.map(c => `- ${c.index}. ${c.met ? "PASS" : "FAIL"} (${c.proof_exec}): ${one(c.claim)}\n` +
      `  reason: ${one(c.reason)}`), "", "## Findings",
    ...(record.findings.length === 0 ? ["- none"] : record.findings.map(f => `- ${f.anchor.path}:${f.anchor.line} ` +
      `(criterion ${f.criterion_index}, ${f.severity} ${f.category}, ${f.anchor.status})\n` +
      `  mechanism: ${one(f.mechanism)}\n  remedy: ${one(f.remedy)}`)),
    ...(record.reasons.length === 0 ? [] : ["", "## Reasons", ...record.reasons.map(r => `- ${one(r)}`)]), ""].join("\n");
}

/** W1-T15077: a failed or capped ops-task verdict lands its findings in remudero-ops. A refused landing changes no
 *  status: its cause is ledgered as review.record_write_failed beside the host record, and nothing else. */
export async function publishOpsReviewFindings(stateDir: string, record: OpsReviewRecord,
  target: { prNumber: number | undefined; capped: boolean }, log: (step: string, extra?: Record<string, unknown>) => void,
  land: typeof landReviewFindingsAsync = landReviewFindingsAsync, say?: (line: string) => void): Promise<"landed" | "refused" | "not_failed"> {
  if (record.state !== "failure" && !target.capped) return "not_failed";
  const refuse = (reason: string): "refused" => {
    log("review.record_write_failed", { pr_number: target.prNumber ?? null, head_sha: record.head_sha, destination: "plan_destination", reason });
    return "refused";
  };
  if (target.prNumber === undefined) return refuse("the review names no pull request number");
  const landed = await land(stateDir, { prNumber: target.prNumber, headSha: record.head_sha,
    content: opsReviewFindingsMarkdown(record) }).catch((error: unknown): LandFeedbackResult => ({ landed: false, files: [], error: String(error) }));
  const expectedPath = reviewFindingsRelPath(target.prNumber, record.head_sha);
  const pathRefusal = landed.refused?.find(refusal => refusal.path === expectedPath);
  if (pathRefusal !== undefined) return refuse(pathRefusal.reason);
  if (!landed.landed) return refuse(landed.error ?? "the findings landing produced no pull request");
  say?.(`remudero-review: findings for ${record.head_sha.slice(0, 7)} landed privately${landed.prUrl ? ` (${landed.prUrl})` : ""}`);
  return "landed";
}

const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** W1-T14581: where a head's record lives under the state dir — one file per repo, PR and head; `undefined` when a
 *  segment could escape the record tree. */
export function opsReviewRecordPath(stateDir: string, target: { owner: string; repo: string; prNumber: number | string | undefined; headSha: string }): string | undefined {
  const pr = String(target.prNumber);
  if (!SAFE_SEGMENT.test(target.owner) || !SAFE_SEGMENT.test(target.repo) || !/^[1-9]\d{0,9}$/.test(pr) ||
      !/^[a-f0-9]{7,64}$/.test(target.headSha)) return undefined;
  return join(stateDir, "review-records", target.owner, target.repo, `pr-${pr}`, `${target.headSha}.json`);
}

/** W1-T14581: write a head's record atomically. A failure is returned, never thrown: the verdict is already decided,
 *  and the caller ledgers why the row carries no record path. */
export function writeOpsReviewRecord(stateDir: string, target: Parameters<typeof opsReviewRecordPath>[1], record: OpsReviewRecord):
  { path: string } | { error: string } {
  const path = opsReviewRecordPath(stateDir, target);
  if (path === undefined) return { error: "review record target has an unsafe path segment" };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, path);
    return { path };
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) };
  }
}

export type OpsReviewRecordRead = { status: "found"; record: OpsReviewRecord } | { status: "absent" } | { status: "unreadable"; reason: string };

/** W1-T14581: the fix lane's and Console's read of a head's record. Absent (no record was linked, or its file is gone)
 *  and unreadable (a record exists but cannot be trusted) are different answers: only the second is a defect. */
export function readOpsReviewRecord(path: string, read: (path: string) => string = p => readFileSync(p, "utf8")): OpsReviewRecordRead {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", reason: String((error as Error)?.message ?? error) };
  }
  try {
    const record = JSON.parse(text) as Partial<OpsReviewRecord>;
    if (record?.version !== 1 || typeof record.pr_url !== "string" || typeof record.head_sha !== "string" ||
        !Array.isArray(record.criteria) || !Array.isArray(record.findings) || !Array.isArray(record.reasons)) {
      return { status: "unreadable", reason: "review record has an unknown shape" };
    }
    return { status: "found", record: record as OpsReviewRecord };
  } catch (error) {
    return { status: "unreadable", reason: String((error as Error)?.message ?? error) };
  }
}

/** W1-T14581: the record the NEWEST `review.posted` row for this PR head links. A newer row without a link (a public
 *  review, or a record that failed to write) answers absent: an older head's or older verdict's record never stands
 *  in for the current one. */
export function opsReviewRecordForHead(rows: ReadonlyArray<Record<string, unknown>>, prUrl: string, headSha: string,
  read?: (path: string) => string): OpsReviewRecordRead {
  const posted = rows.filter(row => row.step === "review.posted" && row.pr_url === prUrl && row.head_sha === headSha).at(-1);
  if (typeof posted?.review_record_path !== "string") return { status: "absent" };
  const found = readOpsReviewRecord(posted.review_record_path, read);
  return found.status === "found" && (found.record.pr_url !== prUrl || found.record.head_sha !== headSha)
    ? { status: "unreadable", reason: "review record names another pull request head" } : found;
}

/** W1-T14146: what the reviewer's assignment receipt records of the reviewed work — the class of the PR's plan task,
 *  `deriveTaskClass` of its files as its implement run records it — and nothing when the review has no plan task
 *  (untasked, or its task unresolved at head), so the receipt names no class rather than the default one. */
export function reviewedTaskWork(task: { files?: string[] }, setup: Pick<ReviewReplayInput, "untasked" | "head_task_resolved">): { taskClass?: string } {
  return setup.untasked || !setup.head_task_resolved ? {} : { taskClass: deriveTaskClass({ files: task.files }) };
}

export async function runReview(host: ReviewCommandHost, args: {
  owner: string;
  repo: string;
  prUrl: string;
  onPhase?: (phase: string) => void;
  /** W1-T10269: judge, then stop before any arm, status or comment — the reviewer-health shadow. */
  shadow?: boolean;
  /** W1-T12145: a calibration case review. Its shadow judge never starts, so a case spends nothing outside the pass's
   *  idle gate and evaluator cap. */
  calibrationCase?: boolean;
  planLintRetryHead?: string;
  reviewReplaySetupInput?: ReviewReplayInput;
  /** W1-T9970 test seam: the reviewer's image; `null` is off-container. Default {@link readRuntimeImageSha}. */
  runtimeImageSha?: string | null;
  /** `files` (W1-T322): the task's declared scope — see {@link "../../lib/review.js".ReviewEvidence.taskDeclaredFiles}'s
   *  doc. Every real caller already passes the full plan `Task`, so this widens for free. */
  task: { catalog?: "public" | "ops"; id: string; title?: string; acceptance?: AcceptanceCriterion[]; files?: string[]; risk?: TaskRisk; budget_usd?: number; sourcePath?: string } & ReviewTaskNarrativeInput;
  /** W1-T14902 test seam: the named task's `dispatch_hold` reading. Omitted, the guarded poster reads it at main. */
  taskHold?: TaskHoldReading;
  /** W1-T3704 (completed here) — injectable producer for the review-reuse pair recorded on this verdict's
   *  `review.posted` line (`own_diff_digest`/`merge_base_sha`). Production omits it and gets one
   *  best-effort REST compare against `main`; a test supplies a stub so it never reaches the
   *  network, the same seam discipline `reviewerQueryFn` and `reviewerSpawnWorker` already use
   *  here. Returning `undefined` is a FIRST-CLASS answer, not an error: it means "unreadable",
   *  and every reader of the pair treats absence as "re-review in full". */
  readReviewReuseFacts?: () => ReviewReuseFacts | undefined;
  /** Shared GitHub status/review history; injected so review tests never contact the network. */
  readReviewStatusHistory?: ReviewStatusHistoryReader;
  /** Creation time from the PR view, when the caller already has it. */
  prCreatedAt?: string;
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
  /** Actual PR body snapshot used to key retry/backoff and bind published evidence. This stays separate from
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
  /** Providers to avoid when this review is re-admitted after its reviewer was unable to inspect. */
  excludeProviders?: SpawnWorkerArgs["excludeProviders"];
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
  signal?: AbortSignal;
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
  /** W1-T11162: how long the caller's head and base trees took, for a plan-only review's phase row. */
  materializeMs?: number;
  /**
   * Injectable auto-merge withdrawal (impl-BF). Default: the real
   * {@link disarmAutoMerge}. Exists so a unit test can assert the withdrawal is
   * ISSUED rather than mocking `gh`.
   */
  disarm?: (prUrl: string) => DisarmOutcome | void;
  /** W1-T15030: renews this run's GitHub token before it publishes, and after a 401. Default
   *  {@link renewReviewPublisherToken}. */
  renewToken?: (opts?: { force?: boolean }) => Promise<ReviewTokenRenewal>;
  /** Head ref of the PR under review — used ONLY to exclude `dependabot/` heads from the
   *  post-verdict arm, which the dep-review lane owns. Absent ⇒ not a dependabot PR. */
  headRefName?: string;
  /** W1-T14195: the verified-or-refused mover removal this head is, when it is mover-shaped and carries no criteria. */
  moverRemoval?: MoverRemovalVerdict;
  /** W1-T13817: core's checkout when the PR is a satellite's; its origin holds W1 reservations the satellite's lacks. */
  reservationHomeDir?: string;
  /** Injectable arm (impl-BG), awaited (W1-T9549). Default: the awaited {@link armAutoMergeDetailedAsync}. */
  arm?: (prUrl: string, taskId: string) => ArmOutcome | Promise<ArmOutcome>;
  /** W1-T15077: lands a failed ops-task review's findings privately. Default {@link landReviewFindingsAsync}. */
  landReviewFindings?: typeof landReviewFindingsAsync;
  /** W1-T13698: the repository's instance mode. Absent ⇒ read from the instance registry (unknown ⇒ live). */
  repoMode?: "shadow" | "live";
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
  /** W1-T12227: the path that admitted this review, named on `review.refused_after_finished_review`. */
  admission?: ReviewAdmission;
}): Promise<ReviewRunResult> {
  // W1-T15030: the run is held live in this process for its whole claimed span, whichever caller runs it (reviewCommand,
  // runTask, the fix lane), so the orphan judge never reads a running review's silence as a dead owner.
  const releaseLive = holdReviewRunLive(args.runId);
  try {
    return await claimedReviewSpan();
  } finally {
    releaseLive();
  }
  async function claimedReviewSpan(): Promise<ReviewRunResult> {
  const phases: Record<string, number> = { started: systemClock.now() };
  // W1-T11149: the phase reaches the CPU bound (setup, proofs) or the provider bound (judge, posting), in process or as a child.
  const reportPhase = (phase: string): void => (args.onPhase ?? reportReviewPhase)(phase);
  reportPhase("setup");
  const { attributeWorkerStreamEvent, ledgeredNonDispatchSpawn, lintPlanForReview, readHeadShaRest, reviewPostedDescription } = host;
  const { owner, repo, prUrl, task, report, log, say } = args;
  const laneSignal = currentReviewSignal();
  const signal = args.signal && laneSignal ? AbortSignal.any([args.signal, laneSignal]) : args.signal ?? laneSignal;
  const headSha = readHeadShaRest(prUrl);
  let replayInput: ReviewReplayInput = args.reviewReplaySetupInput ?? {
    stage: "setup", plan_only: false, required_semantic: args.requireSemanticReview === true,
    criteria_count: task.acceptance?.length ?? 0, risk_present: task.risk !== undefined,
    budget_present: task.budget_usd !== undefined, untasked: false, head_task_resolved: true,
    own_task_record_missing: false, reviewer_outcome: "not_attempted", verdict_lines: [],
  };
  let replayReviewerCodeSha: string | undefined;
  const recordReplay = (decision: ReviewOutcomeDecision): void => {
    if (args.shadow) return;
    const sha = replayReviewerCodeSha ?? reviewerHealthRowFields("review.posted", undefined).reviewer_code_sha;
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
  // supply the independently fetched body. Without either body snapshot, leave this input
  // eligible for retry and withhold terminal publication.
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
  let prCreatedAt = args.prCreatedAt;
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
      fetchLifecycle: async () => {
        const lifecycle = await fetchPrLifecycleAsync(prUrl);
        prCreatedAt ??= lifecycle.createdAt;
        return lifecycle;
      },
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
  const readStatusHistory = args.readReviewStatusHistory ?? readSharedReviewStatusHistory;
  const initialStatusHistory: ReviewStatusHistory = args.shadow
    ? { kind: "readable", failures: [] }
    : await readStatusHistory(owner, repo, prUrl, headSha);
  if (initialStatusHistory.kind === "unreadable") {
    const reason = `pending: ${initialStatusHistory.reason}`;
    log("review.stood_down", { context: REVIEW_CONTEXT, state: "pending", head_sha: headSha, pr_url: prUrl, reason });
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — ${reason}`);
    reportPhase("posted");
    return {
      state: "pending", criteria: [], testTheater: false, summary: "review stood down: shared status history unreadable",
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
      headSha, reviewerOutcome: "not_attempted_status_history_unreadable", verdictWithheld: reason,
    };
  }
  // Source-text compatibility for W1-T913's pre-existing ordering proof:
  // execFileSync("gh", ["pr", "diff", prUrl])
  // W1-T3093: `gh pr diff` is refused above 300 files; only that size case falls back to a local comparison.
  // Both reads awaited and bounded (MEASURED 2026-10-06: the sync read held the daemon loop); a read killed at its
  // bound is a named refusal below, never a hang.
  phases.diffStart = systemClock.now();
  const diffOutcome = await fetchPrDiff(prUrl, headSha, prDiffSourceAsync(repoRoot));
  phases.diff = systemClock.now();
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
  // W1-T12419: one shadow triage request about THIS pull request, started before the reviewer spawns and
  // never awaited. The review neither waits for nor reads it; its decision.answered row is the whole record.
  if (!args.shadow && host.triagePullRequest) {
    void host.triagePullRequest(args.config, { prUrl, headSha, title: task.title ?? task.id, diff }).catch((error: unknown) => {
      process.stderr.write(`review triage unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  const scopeContext = reviewScopeContext(diff, task.files, reviewPlacementAdmitted(diff, args.headCheckoutDir, task.files, task.acceptance ?? []));
  const criteria = task.acceptance ?? [];
  const taskIdEvidence = await reviewTaskIdEvidenceAsync(diff, args.headRefName, args.headCheckoutDir,
    args.reservationHomeDir && args.headCheckoutDir ? satelliteReservationRead(args.headCheckoutDir, args.reservationHomeDir) : undefined);
  const ownership = taskIdEvidence.ownership;
  const preparedDecision = await preparePromisedReviewDecision({
    input: { headSha, diff, report, implementationReport: args.implementationReport, body: inputBody, acceptance: criteria, declaredFiles: task.files, ownership, moverRemoval: args.moverRemoval,
      sharedReviewHistory: initialStatusHistory.kind === "readable" ? {
        failureIds: initialStatusHistory.failures.filter((finding) => finding.headSha === headSha).map((finding) => finding.id),
        revision: initialStatusHistory.revision,
      } : undefined, ...narrative },
    headCheckoutDir: args.headCheckoutDir, task, ledgerPath: args.ledgerPath, prUrl,
  });
  // W1-T9970: read once per review; a reviewer-image re-review of this head is its own decision.
  const runtimeImageSha = args.runtimeImageSha === undefined ? readRuntimeImageSha() : args.runtimeImageSha ?? undefined;
  const requeues = runtimeImageSha === undefined ? [] : (await readLedgerUnionRawLinesAsync(dirname(args.ledgerPath),
    { maxRotations: 0, step: REVIEW_REQUEUED_STEP, keep: (line) => line.includes(headSha) })).rawLines.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; /* deliberate: a torn line requests nothing */ }
  });
  let decisionDigest = reviewerImageDecisionDigest(requiredSemanticDecisionDigest(preparedDecision.decisionDigest,
    args.requireSemanticReview === true), { headSha, runtimeImageSha, requeues });
  let planLintRetry: Parameters<typeof claimReviewDecision>[0]["planLintRetry"];
  let retryReuseFacts: ReviewReuseFacts | undefined;
  if (args.planLintRetryHead !== undefined && !args.shadow) {
    try {
      if (args.planLintRetryHead !== headSha) throw new Error("requested head differs from the PR head");
      const readView = async () => {
        const view = await ghJsonAsync(["api", `repos/${owner}/${repo}/pulls/${reviewPrNumber(prUrl)}`]) as { head?: { sha?: string }; base?: { ref?: string } };
        const liveHead = view.head?.sha;
        const baseRef = view.base?.ref;
        if (typeof liveHead !== "string" || liveHead.length === 0 || typeof baseRef !== "string" || baseRef.length === 0) {
          throw new Error("retry head or base branch is unreadable");
        }
        return { headSha: liveHead, baseRef };
      };
      const readRetryReuseFacts = async (baseRef: string, head: string) => {
        const compare = await ghJsonAsync(compareRestArgs(owner, repo, baseRef, head));
        return tryFetchReviewReuseFacts(owner, repo, baseRef, head, () => compare);
      };
      const captured = await readView();
      if (captured.headSha !== headSha) throw new Error("PR head moved while capturing the retry");
      retryReuseFacts = await (args.readReviewReuseFacts ?? (() => readRetryReuseFacts(captured.baseRef, headSha)))();
      if (!retryReuseFacts) throw new Error("retry merge base is unreadable");
      planLintRetry = {
        attemptId: `review-PR${reviewPrNumber(prUrl)}-${randomUUID()}`,
        runId: args.runId, headSha: args.planLintRetryHead, mergeBaseSha: retryReuseFacts.mergeBaseSha,
        owner, repo, readRequiredContexts: readRequiredStatusCheckContextsAsync,
        observe: async () => {
          const live = await readView();
          const facts = await readRetryReuseFacts(live.baseRef, live.headSha);
          if (!facts) throw new Error("retry merge base is unreadable");
          const required = await readRequiredStatusCheckContextsAsync(owner, repo, encodeURIComponent(live.baseRef));
          const rollup = await rollupForAsync(owner, repo, live.headSha, ghJsonAsync);
          const complete = required.kind === "contexts" && required.contexts.filter(context => context !== REVIEW_CONTEXT)
            .every(context => rollup.some(check => check.name === context || check.context === context));
          return { ...live, mergeBaseSha: facts.mergeBaseSha, checks: {
            headSha: live.headSha, fresh: live.headSha === headSha, complete,
            passing: checksStateFromRollup(rollup, required.kind === "contexts" ? required.contexts : undefined) === "green",
          } };
        },
      };
    } catch (error) {
      // PR coordinates keep this diagnostic out of gatherRuns' PR-credit fallback.
      log("review.plan_lint_retry_not_requested", {
        pr_number: reviewPrNumber(prUrl), owner, repo, head_sha: headSha,
        requested_head_sha: args.planLintRetryHead, reason: String(error),
      });
    }
  }
  const decisionClaim = await claimReviewDecision({
    ledgerPath: args.ledgerPath, taskId: task.id, prUrl, digest: decisionDigest, headCheckoutDir: args.headCheckoutDir,
    ...(planLintRetry === undefined ? {} : { planLintRetry }),
  });
  phases.decision = systemClock.now();
  if (decisionClaim.kind === "replay") {
    const priorVerdict = decisionClaim.terminal.verdict;
    const replayHistory = args.shadow || priorVerdict.state !== "success"
      ? initialStatusHistory : await readStatusHistory(owner, repo, prUrl, headSha);
    const guarded = applyReviewStatusHistoryGuard(priorVerdict, headSha, replayHistory);
    if (guarded.kind === "pending") {
      const reason = `pending: ${guarded.reason}`;
      log("review.stood_down", { context: REVIEW_CONTEXT, state: "pending", head_sha: headSha, pr_url: prUrl, reason });
      say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — ${reason}`);
      reportPhase("posted");
      return {
        ...guarded.verdict, headSha, verdictWithheld: reason,
        reviewerOutcome: decisionClaim.terminal.reviewerOutcome,
        evaluatorProvenance: decisionClaim.terminal.evaluatorProvenance,
        reviewDecisionDigest: decisionDigest, decisionDisposition: "replayed",
      };
    }
    const replayDigest = guarded.verdict.state !== priorVerdict.state && replayHistory.kind === "readable"
      ? createHash("sha256").update(JSON.stringify({
        kind: "shared-review-history-guard-v1", priorDecisionDigest: decisionDigest, headSha,
        failureIds: replayHistory.failures.filter(finding => finding.headSha === headSha).map(finding => finding.id).sort(),
        historyRevision: replayHistory.revision ?? null,
      })).digest("hex") : decisionDigest;
    return {
      ...guarded.verdict, headSha,
      reviewerOutcome: decisionClaim.terminal.reviewerOutcome,
      evaluatorProvenance: decisionClaim.terminal.evaluatorProvenance,
      reviewDecisionDigest: replayDigest, decisionDisposition: "replayed",
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

  let priorReviewSnapshot: ReturnType<typeof readLedgerLines> | undefined;
  // ledger-read-intent: live — stability uses the same live rows as the earlier-head prompt.
  const priorReviewRows = () => priorReviewSnapshot ??= readLedgerLines(args.ledgerPath);

  // Advisory semantic layer — a FRESH read-only reviewer (no session inheritance),
  // in a throwaway cwd so it cannot touch the worktree/diff under review.
  let semantic: (boolean | undefined)[] | undefined;
  let semanticClauses: (string | undefined)[] | undefined;
  let reviewerUnable: (string | undefined)[] | undefined;
  // W1-T2472: a PLAN-ONLY changeset has no code for this advisory lane to judge, so the spawn is
  // skipped rather than dispatched to discover there is nothing to execute. This does not weaken
  // the gate: `judgeReview` decides a plan-only diff's state on `floorUnmet` (review.ts), and
  // `floorMet` is captured BEFORE the semantic downgrade arm, so the reviewer's only output
  // (`semantic[]`) cannot change a plan-only verdict — leaving it undefined is exactly what the
  // catch arm below already produces when a spawn fails. Every other gating arm — the deterministic
  // floor, lint-plan, and the plan-PR emitter — is untouched and still runs.
  // The predicate is review.ts's own `planOnlyDiff`, never a second copy of the expression.
  const planOnlySkip = planOnlyDiff(diff);
  // W1-T13151: the lane's signal aborted (or the lint says its own run was aborted), so this review judged nothing.
  // It posts no remudero-review verdict and writes one review.lane_aborted row. The pending status stays, so the
  // next sweep pass admits this head again through the ordinary post-review route. A lint that could not run for
  // any other reason does not stop here: it still withholds a plan-only PASS (invariant a-lint-that-never-ran-is-no-pass).
  const laneAbortedResult = (phase: "plan-lint" | "posting", lint: PlanLintOutcome | undefined): ReviewRunResult | undefined => {
    const lintAborted = lint !== undefined && !lint.ran && lint.aborted === true;
    if (signal?.aborted !== true && !lintAborted) return undefined;
    const reason = lintAborted ? lint.reason : "lane signal aborted";
    log(REVIEW_LANE_ABORTED_STEP, {
      pr_number: reviewPrNumber(prUrl), pr_url: prUrl, head_sha: headSha, phase, reason,
      review_decision_digest: decisionDigest, ...(args.shadow ? { shadow: true } : {}),
    });
    say(`remudero-review: lane aborted for ${headSha.slice(0, 7)} (${phase}) — ${reason}; no verdict posted`);
    return {
      state: "pending", criteria: [], testTheater: false,
      summary: `review lane aborted (${phase}): ${reason}; no verdict posted`,
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: planOnlySkip,
      ...(lint === undefined ? {} : { planLint: lint }),
      headSha, reviewerOutcome: `not_judged_lane_aborted_${phase}`, verdictWithheld: `lane aborted: ${reason}`,
      reviewDecisionDigest: decisionDigest,
    };
  };
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
  // W1-T13868: review.finding rows name why a reviewer's served model is null; the provenance type stays unchanged.
  let reviewerServedModelReason: string | undefined;
  const attemptReviewer = args.spawnReviewer !== false && reviewerSpawnMount !== undefined && criteria.length > 0 && !planOnlySkip;
  // W1-T11157 (shadow): CI's record for this head is read beside the host's proof run; nothing reads it before the
  // binding verdict below is built, and the comparison only ledgers agreement.
  const proofReuseRead = args.headCheckoutDir !== undefined && discriminationProofs(criteria).length > 0
    ? readProofDiscriminationRecord({ owner, repo, headSha }).catch((error: unknown): ProofDiscriminationRecordRead =>
      ({ kind: "ineligible", reason: `record unreadable: ${String((error as Error)?.message ?? error).slice(0, 300)}` }))
    : undefined;
  const hostedCiFilePassed = await reviewHostedCiFileEvidence({ owner, repo, headSha, criteria,
    headCheckoutDir: args.headCheckoutDir, log });
  const proofEvidence: Parameters<typeof preparedDecision.judge>[0] = {
    hostedCiFilePassed,
    diff,
    report,
    headRefName: args.headRefName,
    reservationOwnership: ownership,
    baseTaskIdDeclarations: taskIdEvidence.baseDeclarations,
    implementationReport: args.implementationReport,
    target: { owner, repo },
    // W1-T1100: threaded straight from this call's own args — see this arg's own doc.
    reportIsSubstitute: args.reportIsSubstitute,
    reportSubstituteCause: args.reportSubstituteCause,
    headCheckoutDir: args.headCheckoutDir,
    baseCheckoutDir: args.baseCheckoutDir,
    baseUnreadablePaths: args.baseUnreadablePaths,
    baseIsCheckout: args.baseIsCheckout,
    addedTestFiles: args.addedTestFiles,
    // W1-T322: advisory-only inputs — see ReviewEvidence's own doc for both fields.
    taskDeclaredFiles: task.files,
    openTaskIds: args.openTaskIds,
    moverRemoval: args.moverRemoval,
  };
  // The proofs run here when a reviewer follows, else in the binding judge below; either way the CPU work starts now.
  reportPhase("proofs");
  const preliminaryStartedAt = systemClock.now();
  const preliminaryProofs = attemptReviewer ? await preparedDecision.judge(proofEvidence) : undefined;
  const preliminaryProofMs = systemClock.now() - preliminaryStartedAt;
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
    // The proofs are done; the LLM judge waits on its provider, not this host's CPU (the binding judge after it reuses them).
    reportPhase("judge");
    try {
      const priorHeadFindings = priorHeadFindingsFromLedger(
        await priorHeadReviewRows(args.ledgerPath, priorReviewRows(), task.id, prUrl, { prCreatedAt, signal }),
        task.id, prUrl, headSha,
      );
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
          origin_main: snapshot.originMain,
        });
        const evidencePath = join(snapshot.cwd, ".git", "rmd-review-input.json");
        writeFileSync(evidencePath, JSON.stringify({
          headSha, diff, report, reportIsSubstitute: args.reportIsSubstitute === true,
          ...(args.implementationReport === undefined ? {} : { implementationReport: args.implementationReport }),
        }), { mode: 0o600 });
        const proofEvidencePath = join(snapshot.cwd, ".git", "rmd-review-proofs.json");
        writeFileSync(proofEvidencePath, JSON.stringify({
          headSha, phase: "pre-semantic", mergeVerdict: false,
          baseProvided: args.baseCheckoutDir !== undefined, baseIsCheckout: args.baseIsCheckout === true,
          executions: preparedDecision.proofExecutions().map(({ cwd, ...execution }) => ({ ...execution,
            side: cwd === args.headCheckoutDir ? "head" : cwd === args.baseCheckoutDir ? "base" : "other" })),
          capped: preliminaryProofs!.capped, floorDegraded: preliminaryProofs!.floorDegraded,
          criteria: preliminaryProofs!.criteria.map((criterion, index) => ({ index: index + 1,
            proof: criterion.proof, proof_exec: criterion.proof_exec, floorMet: criterion.floorMet, reason: criterion.reason })),
        }), { mode: 0o600 });
        const prompt =
          buildReviewPrompt({
            task: { id: task.id, acceptance: criteria, ...narrative },
            prUrl,
            owner,
            repo,
            headSha,
            evidencePath,
            proofEvidencePath,
            ...scopeContext,
            priorReproducedFailures: initialStatusHistory.kind === "readable" ? initialStatusHistory.failures : [],
            priorHeadFindings,
          }) +
          "\n" +
          reviewerVerdictContract(criteria.length);
        // W1-T12152: the assignment's prompt revision hashes this template, never the filled prompt above.
        const promptTemplate = reviewPromptTemplate();
        const stopTelemetry = args.workerTelemetry?.startPolling();
        let reviewer: WorkerResult;
        const reviewerClockBoundMs =
          host.reviewerClockBoundMs(args.reviewerClockBoundMs);
        const reviewerClockBound = { clockBound: { boundMs: reviewerClockBoundMs } };
        const reviewerSpawn = args.reviewerSpawnWorker ?? ledgeredNonDispatchSpawn("review");
        // W1-T14146: every reviewer call, the judge's and its shadow's, carries the reviewed work, so its assignment
        // receipt records the plan task's class.
        const reviewedWork = reviewedTaskWork(task, replayInput);
        const reviewerSpawnWorker: typeof spawnWorker = (spawnArgs) => reviewerSpawn(withReceiptWork(spawnArgs, reviewedWork));
        // W1-T4615: assigned before the provider call, so every later stream event names the routed model.
        let reviewerAssignment: WorkerSelectionAssignment | undefined;
        // W1-T14037: the proofs the orchestrator recorded at this head; a reviewer command call that re-runs one is its own
        // kind in worker.tool_lineage. Recorded only: nothing reads the kind to decide anything.
        const recordedProofCommands = preparedDecision.proofExecutions()
          .filter((execution) => execution.cwd === args.headCheckoutDir)
          .map(({ command, args: argv, cwd }) => ({ command, args: [...argv], cwd }));
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
                excludeProviders: args.excludeProviders,
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
                streamObserver: args.workerTelemetry
                  ? (event) => args.workerTelemetry!.observer(attributeWorkerStreamEvent({ ...event, workerRole: "reviewer", cwd: snapshot.cwd, provider: reviewerSpawnMount!.provider, requestedModel: reviewerSpawnMount!.model }, reviewerAssignment))
                  : undefined,
                reviewer: { recordedProofCommands, cwd: snapshot.cwd },
                promptTemplate,
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
        reviewerUnable = parseReviewerUnable(reviewerFindingText, criteria.length);
        // A success envelope can precede a terminal SDK error; preserve that failure evidence.
        const terminalError = reviewer.apiError ? "api_error" : reviewer.isError ? "worker_error" : undefined;
        reviewerSubtype = reviewer.subtype === "success" && terminalError ? terminalError : reviewer.subtype;
        reviewerExit = reviewer.exit;
        const reviewerFields = workerLedgerFields(reviewer);
        reviewerServedModelReason = reviewerFields.served_model_reason;
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
          // W1-T11428: criteria this reviewer could not inspect; W1-T11432 reads the provider beside it.
          unable: reviewerUnable.filter((u) => u !== undefined).length,
          // W1-T14037: reviewer command calls by kind; `proof-rerun` re-ran a proof the orchestrator recorded at this head.
          ...(reviewer.reviewerCommandKinds ? { command_kinds: reviewer.reviewerCommandKinds } : {}),
          ...(args.excludeProviders?.length ? { exclude_providers: [...args.excludeProviders] } : {}),
          ...(reviewerAssignment?.routing.exclusion_unhonoured
            ? { exclusion_unhonoured: reviewerAssignment.routing.exclusion_unhonoured } : {}),
          // W1-T6: the advisory reviewer is a BRAIN-PLANE call — same telemetry
          // shape as a worker call, so ledger lines are queryable uniformly.
          ...reviewerFields,
          ...(reviewerFields.selection_assignment_id ? {}
            : reviewerAssignment ? { selection_assignment_id: reviewerAssignment.id }
            : { assignment_unavailable_reason: "assignment-not-observed" }),
          ...(reviewerFields.routed_model || !reviewerAssignment ? {} : { routed_model: reviewerAssignment.selected.model }),
        });
        // W1-T12145: a calibration case starts no shadow judge; its spend would skip the pass's idle gate and cap.
        if (!args.calibrationCase) await runShadowJudge({
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
              promptTemplate,
              prompt,
            }));
            assertShadowSnapshotIntegrity(host, snapshot.cwd, headSha, log);
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
        log(`review.reviewer.${e.phase}_error`, reviewerSnapshotErrorRow(e));
      }
      log("review.reviewer.error", { error: String((e as Error)?.message ?? e) });
    }
  }
  // W1-T63/P10-a: LEGIBLE outcome of the reviewer spawn — a floor-only PASS
  // (never attempted, or attempted but walled/spawn-failed) is never
  // byte-identical in the ledger/console to a review the reviewer COMPLETED.
  // W1-T14826: under required semantic review, a code PR naming no criteria (and no verified mover removal) has nothing
  // for a reviewer to judge; its own outcome lets the gate post the floor's FAIL once instead of withholding it on every
  // run. A deterministic or advisory run keeps the bare `not_attempted` (W1-T14156 criterion 3).
  const noCriteriaFinal = args.requireSemanticReview === true && criteria.length === 0 && !planOnlySkip && !attemptReviewer &&
    args.moverRemoval?.verified !== true;
  const outcome = noCriteriaFinal ? NO_CRITERIA_REVIEWER_OUTCOME : reviewerOutcome({
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
    // Only when criteria exist: a review with none has no semantic work to skip, so it keeps the
    // bare `not_attempted` ("no criteria") value it always reported.
    deterministicMode: args.spawnReviewer === false && criteria.length > 0,
  });
  replayInput = { ...replayInput, stage: "semantic", plan_only: planOnlySkip,
    criteria_count: criteria.length, reviewer_outcome: outcome,
    verdict_lines: recordedReviewVerdictLines(reviewerFindingText ?? "", criteria.length) };
  const completionDecision = classifyReviewOutcome(replayInput);
  const withholdSemanticVerdict = (decision: ReviewOutcomeDecision): ReviewRunResult => {
    const semanticRefusal = decision.reason;
    recordReplay(decision);
    log("review.semantic_incomplete", { reason: semanticRefusal, head_sha: headSha, pr_url: prUrl,
      reviewer_outcome: outcome, review_decision_digest: decisionDigest,
      // W1-T13945: the evaluator that withheld, so a repeat withhold at this input is re-run on another provider.
      ...(evaluatorProvenance.provider !== null ? { provider: evaluatorProvenance.provider } : {}),
      ...(evaluatorProvenance.routedModel ? { routed_model: evaluatorProvenance.routedModel } : {}),
      ...(inputDigest !== undefined ? { review_input_digest: inputDigest } : {}),
      ...(semanticRefusal === DOWNGRADE_UNCLASSIFIED ? { downgrade_unclassified: replayInput.downgrade_unclassified } : {}) });
    say(`remudero-review: verdict WITHHELD — ${semanticRefusal}; no verdict publication or merge effect`);
    return { state: "failure", criteria: [], cannotEvaluate: true, testTheater: false,
      summary: semanticRefusal, floorDegraded: true, capped: true, keywordOnly: false, planOnly: false,
      headSha, reviewerOutcome: outcome, verdictWithheld: semanticRefusal,
      reviewDecisionDigest: decisionDigest, evaluatorProvenance };
  };
  if (completionDecision.class !== "posted") return withholdSemanticVerdict(completionDecision);
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
  phases.lintStart = systemClock.now();
  const planLint = planOnlySkip ? await (args.lintPlanForReviewFn ?? lintPlanForReview)(args.headCheckoutDir,
    undefined, undefined, { signal, log }) : undefined;
  phases.lint = systemClock.now();
  // W1-T13151 (invariant aborted-is-not-judged): a lane the restart drain aborted keeps running, and its lint
  // returned "lint-plan aborted". Judging that would post a binding FAILURE nothing judged (#18803, 2026-11-16).
  const abortedAtLint = laneAbortedResult("plan-lint", planLint);
  if (abortedAtLint !== undefined) return abortedAtLint;
  const computed = await preparedDecision.judge({
    ...proofEvidence, planLint, semantic, semanticClauses, reviewerUnable,
    diff, report,
    target: { owner, repo },
    headCheckoutDir: args.headCheckoutDir,
    baseCheckoutDir: args.baseCheckoutDir,
    taskDeclaredFiles: task.files,
    openTaskIds: args.openTaskIds,
  });
  phases.judge = systemClock.now();
  if (proofReuseRead !== undefined) {
    log(PROOF_REUSE_SHADOW_STEP, await proofReuseShadowRow(await proofReuseRead, { prUrl, headSha, diff, body: inputBody,
      criteria, headCheckoutDir: args.headCheckoutDir!, hostCriteria: computed.criteria,
      hostProofMs: preliminaryProofMs + phases.judge - phases.lint }));
  }

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
    ? priorReviewVerdictFromLedger(priorReviewRows().filter((line) => line.review_input_digest === inputDigest), task.id, args.prUrl)
    : undefined;
  let { verdict, suppressed } = applyVerdictStability(computed, headSha,
    prior?.reviewContractDigest === contractDigest ? prior : undefined);
  verdict = { ...verdict, reviewContractDigest: contractDigest };
  if (outcome === NO_CRITERIA_REVIEWER_OUTCOME && verdict.state === "failure") {
    verdict = { ...verdict, summary: NO_CRITERIA_FAIL_SUMMARY };
  }

  // Ask again once per head and input when an unclassified downgrade survives stability and the floor did not fail.
  const downgradeUnclassified = suppressed || preliminaryProofs?.floorState === "failure" ? []
    : unclassifiedDowngrades(semantic, semanticClauses, preliminaryProofs?.criteria);
  if (downgradeUnclassified.length > 0) {
    replayInput = { ...replayInput, downgrade_unclassified: downgradeUnclassified,
      downgrade_unclassified_withheld: await unclassifiedHoldRecorded(args.ledgerPath, headSha, inputDigest, decisionDigest, args.shadow) };
  }
  const replayDecision = classifyReviewOutcome(replayInput);
  if (replayDecision.class !== "posted") return withholdSemanticVerdict(replayDecision);

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
  const reuseFacts = retryReuseFacts ?? (args.readReviewReuseFacts ?? (() => tryFetchReviewReuseFacts(owner, repo, "main", headSha, ghJson)))();
  if (reuseFacts) verdict = { ...verdict, ...reuseFacts };

  let decisionDisposition: "computed" | "conflict" = "computed";

  // W1-T10269: the shadow's would-be terminal. It reached publication and publishes nothing.
  if (args.shadow) {
    log(REVIEWER_SHADOW_VERDICT_STEP, { state: verdict.state, head_sha: headSha, pr_url: prUrl, reviewer_outcome: outcome,
      review_decision_digest: decisionDigest });
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: "reviewer-health shadow: no publication",
      reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }



  // W1-T233: keep the published description aligned with the final guarded verdict.
  const description = reviewPostedDescription(verdict, args.materializationFailure);

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
  // W1-T15030: before the first disarm or post, renew a token the reviewer outlived, and stop if another run took this
  // run's claim over: a run that lost its claim posts nothing, disarms nothing and opens no escalation.
  const renewToken = args.renewToken ?? ((o?: { force?: boolean }) => renewReviewPublisherToken(o));
  await renewToken();
  const withdrawDeps = { disarm: args.disarm, renewToken: () => renewToken({ force: true }) };
  const readClaimLost = () => reviewClaimLost(args.ledgerPath, args.runId, headSha, prUrl);
  const claimLostResult = (taker: string): ReviewRunResult => {
    reportPhase("posted");
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — claim_lost: run ${taker} took this review over`);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: "claim_lost", reviewDecisionDigest: decisionDigest,
      decisionDisposition, evaluatorProvenance };
  };
  const claimLost = async (): Promise<ReviewRunResult | undefined> => {
    const taker = await readClaimLost();
    if (taker === undefined) return undefined;
    log("review.post_refused", { pr_url: prUrl, head_sha: headSha, attempted_state: verdict.state, reason: "claim_lost",
      taken_over_by_run_id: taker });
    return claimLostResult(taker);
  };
  // W1-T15030: every withdrawal once the status may be up re-reads the claim and records a twice-refused disarm.
  const withdrawPosted = (v: ReviewVerdict) => withdrawAfterPublication(v,
    { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, log, runId: args.runId }, { ...withdrawDeps, claimLost: readClaimLost });
  const lostAtPost = await claimLost();
  if (lostAtPost !== undefined) return lostAtPost;
  const disarmedAtPost = await withdrawArmIfVerdictRefusesAsync(
    verdict,
    { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, log },
    withdrawDeps,
  );
  if (disarmedAtPost.outcome === "token_unrenewable") {
    log("review.post_refused", { pr_url: prUrl, head_sha: headSha, attempted_state: verdict.state, reason: "token_unrenewable" });
    reportPhase("posted");
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — token_unrenewable: the disarm was refused twice`);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: "token_unrenewable", reviewDecisionDigest: decisionDigest,
      decisionDisposition, evaluatorProvenance };
  }

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
    // W1-T11151: a withheld verdict is terminal (its review.post_refused row is written), so it reports `posted`.
    (args.onPhase ?? reportReviewPhase)("posted");
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — ${verdict.taskIdOwnershipWithheld}`);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: verdict.taskIdOwnershipWithheld, reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  if (inputDigest === undefined && verdict.state !== "pending") {
    const reason = "PR body unavailable for the review evidence input digest";
    replayInput = { ...replayInput, publication_refusal: reason };
    recordReplay(classifyReviewOutcome(replayInput));
    log("review.evidence_write_failed", { pr_number: reviewPrNumber(prUrl), head_sha: headSha, reason });
    log("review.post_refused", { pr_url: prUrl, head_sha: headSha, attempted_state: verdict.state, reason });
    reportPhase("posted");
    say(`remudero-review: verdict WITHHELD for ${headSha.slice(0, 7)} — ${reason}`);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: reason, reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  let reviewerCodeFreshness: ReviewerCodeFreshness | undefined;
  try {
    reviewerCodeFreshness = await args.reviewerCodeFreshness?.();
  } catch (error) {
    reviewerCodeFreshness = { status: "unreadable", reason: `could not assess reviewer code freshness: ${String(error)}` };
  }
  // Publication already assessed this loaded reviewer; bundled code need not have a checkout HEAD.
  if (reviewerCodeFreshness !== undefined && reviewerCodeFreshness.status !== "unreadable") {
    replayReviewerCodeSha = reviewerCodeFreshness.codeSha;
  }
  // W1-T13151: the drain can abort the lane while the verdict is judged; an aborted lane posts nothing binding.
  const abortedAtPost = laneAbortedResult("posting", planLint);
  if (abortedAtPost !== undefined) return abortedAtPost;
  phases.postStart = systemClock.now();
  reportPhase("posting");
  const poster = failureRecordingPoster();
  const publishingState = verdict.state;
  const codeSha = reviewerCodeFreshness?.status === "fresh" ? reviewerCodeFreshness.codeSha : undefined;
  const historyEvidence = reviewerFindingText === undefined ? undefined : parseReviewerHistoryEvidence(reviewerFindingText, criteria.length);
  const presentedFailureIds = initialStatusHistory.kind === "readable" ? initialStatusHistory.failures.map(finding => finding.id) : [];
  let dispute: ReviewPassDispute | undefined;
  // W1-T15077: the private findings page of an ops task's failed or capped verdict, landed at most once per run. EVERY
  // return below that follows a status this run PUBLISHED calls it: the disputed-pass hold (holdDisputedPass), the
  // semantic hold (posted.semanticHold), the task hold (posted.taskHold), the capped hold (posted.cappedHold), any
  // other pending outcome, and the posted terminal verdict (after armIfVerdictPermitsAsync). The returns that publish
  // no status for this head land nothing, as the next review of the head decides: the shadow
  // (REVIEWER_SHADOW_VERDICT_STEP), a semantic replay (withholdSemanticVerdict), a withheld task id
  // (taskIdOwnershipWithheld), a missing input digest, an aborted lane (laneAbortedResult), a refused post (!posted.posted)
  // and a conflict hold that failed to post. publishOpsReviewFindings itself lands only a failed or capped verdict.
  let findingsLanded = false;
  const landFindings = async (capped: boolean): Promise<void> => {
    if (task.catalog !== "ops" || findingsLanded) return;
    findingsLanded = true;
    const record = opsReviewRecord({ taskId: task.id, prUrl, headSha, state: verdict.state, decisionDigest, criteria: verdict.criteria,
      reasons: reviewUnmetFields(verdict).reasons, findings: findingCapture.findings });
    await publishOpsReviewFindings(dirname(args.ledgerPath), record, { prNumber: reviewPrNumber(prUrl), capped: capped || verdict.capped === true },
      log, args.landReviewFindings, say);
  };
  const posted = await postReviewStatusGuarded({
    post: catalogReviewPoster(task.catalog, poster.post, reviewerCodeFreshness?.status === "fresh" ? reviewerCodeFreshness.codeSha : undefined),
    outboxBeforePost: true,
    owner,
    repo,
    sha: headSha,
    state: verdict.state,
    verdict,
    reviewerHistoryEvidence: historyEvidence,
    presentedFailureIds,
    readReviewStatusHistory: disputeGuardedHistoryReader(readStatusHistory, verdict, { runId: args.runId, inputDigest, codeSha },
      { planOnly: planOnlySkip, reviewerOutcome: outcome }, (found) => { dispute = found; }, historyEvidence, presentedFailureIds),
    description,
    taskId: task.id,
    evidence: reviewEvidenceStrength(verdict.criteria),
    ledgerPath: args.ledgerPath,
    runId: args.runId,
    prUrl,
    reviewInputDigest: inputDigest,
    reviewDecisionDigest: decisionDigest,
    reopenedDegradedTerminal: decisionClaim.reopenedDegradedTerminal,
    ...(decisionClaim.reopenedDegradedTerminal && planLintRetry !== undefined
      ? { planLintRetry: { ...planLintRetry, outcome: planLint } } : {}),
    reviewEngineRevision: REVIEW_ENGINE_REVISION,
    evaluatorProvenance,
    reviewerCodeFreshness,
    renewToken: () => renewToken({ force: true }),
    claimLost: readClaimLost,
    finishedReview: { admission: args.admission ?? "direct", reviewerMs: phases.postStart - phases.started },
    fetchLifecycle: () => fetchPrLifecycleAsync(prUrl),
    readRequiredContexts: readRequiredStatusCheckContextsAsync,
    cannotEvaluateEscalation: (e, issues) => tryEscalateAsync(task.catalog === "ops" ? { ...e, detail: "Review cannot evaluate this head; detailed evidence is retained on the host." } : e,
      { issues: renewingIssueGateway(issues ?? ghIssueGatewayAsync(owner, repo), { log, prUrl, headSha, renewToken: withdrawDeps.renewToken }),
        ledgerPath: args.ledgerPath, runId: args.runId }),
    // W1-T14235 (invariant no-semantic-no-code-pass): a code pass publishes only on this run's own semantic judgement.
    semanticJudgement: { planOnly: planOnlySkip, reviewerOutcome: outcome },
    ...(args.taskHold !== undefined ? { taskHold: args.taskHold } : {}),
  });
  phases.post = systemClock.now();
  // W1-T11151: `posted` releases admission once the outcome is terminal: posted, refused (review.post_refused) or a
  // replayed terminal. Only a publication that threw (review.post_failed) holds its slot until the review settles.
  if (!poster.failed()) (args.onPhase ?? reportReviewPhase)("posted");
  // W1-T15030: the guarded post re-read the claim under its lock and refused (its row is written): nothing more is done.
  if (posted.claimLost !== undefined) return claimLostResult(posted.claimLost);
  decisionDigest = posted.effectiveReviewDecisionDigest ?? decisionDigest;
  if (posted.effectiveVerdict) verdict = { ...verdict, ...posted.effectiveVerdict, state: posted.effectiveState ?? posted.effectiveVerdict.state };
  if (dispute !== undefined && posted.effectiveState === "pending") {
    const lostAtHold = await claimLost();
    if (lostAtHold !== undefined) return lostAtHold;
    const held = await holdDisputedPass(dispute, verdict, { owner, repo, prUrl, headSha, taskId: task.id, runId: args.runId,
      ledgerPath: args.ledgerPath, catalog: task.catalog, log, disarm: args.disarm, renewToken: withdrawDeps.renewToken,
      publish: (pending, pendingDescription, heldClaimLost) => postReviewStatusGuarded({ post: catalogReviewPoster(task.catalog, poster.post),
        claimLost: heldClaimLost,
        owner, repo, sha: headSha, state: "pending", verdict: pending, description: pendingDescription, taskId: task.id,
        evidence: reviewEvidenceStrength(pending.criteria), ledgerPath: args.ledgerPath, runId: args.runId, prUrl,
        reviewInputDigest: inputDigest, reviewEngineRevision: REVIEW_ENGINE_REVISION, reviewerCodeFreshness,
        fetchLifecycle: () => fetchPrLifecycleAsync(prUrl), readRequiredContexts: readRequiredStatusCheckContextsAsync }) });
    say(`remudero-review: PASS NOT PUBLISHED for ${headSha.slice(0, 7)} — ${held.verdictWithheld}`);
    await landFindings(false);
    return { ...held, headSha, reviewerOutcome: outcome, reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  if (posted.semanticHold !== undefined) {
    // W1-T14235: the pass was held (pending, or a standing failure left standing), so an arm taken at open is withdrawn.
    await withdrawPosted(verdict);
    say(`remudero-review: PASS NOT PUBLISHED for ${headSha.slice(0, 7)} — ${posted.reason ?? posted.semanticHold}`);
    await landFindings(false);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: posted.reason ?? posted.semanticHold,
      reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  if (posted.taskHold !== undefined) {
    // W1-T14902: the pass was held as pending until the operator releases the task's hold, so an arm taken at open is withdrawn.
    await withdrawPosted(verdict);
    say(`remudero-review: PASS NOT PUBLISHED for ${headSha.slice(0, 7)} — ${posted.taskHold}`);
    await landFindings(false);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: posted.taskHold,
      reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  if (posted.cappedHold !== undefined) {
    // W1-T14241 (invariant capped-is-not-green): the capped pass was held as pending, so an arm taken at open is withdrawn.
    await withdrawPosted(verdict);
    say(`remudero-review: CAPPED PASS NOT PUBLISHED for ${headSha.slice(0, 7)} — ${posted.cappedHold}`);
    await landFindings(true);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: posted.cappedHold,
      reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  if (posted.effectiveState === "pending") {
    await landFindings(false);
    return { ...verdict, headSha, reviewerOutcome: outcome, verdictWithheld: posted.reason,
      reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
  }
  if (suppressed && verdict.state === "success") {
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

  if (publishingState === "success" && verdict.state === "failure") await withdrawPosted(verdict);
  if (posted.conflict) {
    decisionDisposition = "conflict";
    verdict = {
      ...verdict,
      state: "failure",
      summary: `review verdict conflict for decision ${decisionDigest.slice(0, 11)} — operator adjudication required`,
    };
    await withdrawPosted(verdict);
    if (!posted.posted) {
      replayInput = { ...replayInput, publication_refusal: "conflict-hold-publication-failed" };
      recordReplay(classifyReviewOutcome(replayInput));
      say(`remudero-review: conflict hold FAILED to post for ${headSha.slice(0, 7)} — ${posted.reason}`);
      return { ...verdict, headSha, reviewerOutcome: outcome, reviewDecisionDigest: decisionDigest, decisionDisposition, evaluatorProvenance };
    }
  } else if (!posted.posted) {
    replayInput = { ...replayInput, publication_refusal: "terminal-publication-refused" };
    recordReplay(classifyReviewOutcome(replayInput));
    // W1-T15077: terminal status failures are outboxed for retry. Publish this head's private
    // evidence now as well, so a later drain that posts the status cannot leave it behind. W1-T15030: a post GitHub
    // refused twice (token_unrenewable) leaves the same outbox entry, so it lands the evidence too.
    if (task.catalog === "ops" && (posted.reason?.startsWith("posting remudero-review failed and was not applied") === true ||
        posted.reason?.startsWith("token_unrenewable:") === true)) {
      await landFindings(verdict.capped === true);
    }
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
  // W1-T166: holdout criteria are reviewer-visible but WORKER-hidden. `verdict.state`
  // above already folded them into the pass/fail decision; the DISPLAYED claim/reason
  // text below must not — this feeds the `review.posted` ledger's `unmet_criteria`/
  // `reasons` (which a cold-dispatch fix rung reconstructs verbatim, unmetFromLedger)
  // AND the PR comment further down, both `gh`-readable by the very worker a holdout
  // criterion must never reach.
  // W1-T1016: `reviewLedgerReasons` is the SAME pure rule this line used to compute inline
  // (per-visible-unmet-criterion reason + testTheater), now ALSO covering the changeset-
  // contradiction path so `reasons` is never `[]` for the one failure shape the fleet already
  // owns a `blocked-fixable` disposition row for — see that function's own doc (lib/review.ts).
  const { visibleUnmet, unmetClaims, reasons } = reviewUnmetFields(verdict);
  // OBSERVABILITY (W1-T65 design): per-criterion proof_exec outcome, so an
  // OBSERVED verdict (executed_pass/executed_fail) is legible on the ledger vs a
  // KEYWORD one (not_executable), and an environment hiccup (exec_error) is never
  // silently indistinguishable from either.
  const proofExec = verdict.criteria.map((c) => c.proof_exec);
  // The gate TEACHES: the FULL list of unmet criteria goes to the ledger (and the
  // PR comment below) — the status description names only the first (length-capped).
  // W1-T14581: an ops task's reasons and findings stay on the host, in one record per head its row links.
  const opsRecordBody = task.catalog !== "ops" ? undefined : opsReviewRecord({ taskId: task.id, prUrl, headSha,
    state: verdict.state, decisionDigest, criteria: verdict.criteria, reasons, findings: findingCapture.findings });
  const opsRecord = opsRecordBody === undefined ? undefined
    : writeOpsReviewRecord(dirname(args.ledgerPath), { owner, repo, prNumber: reviewPrNumber(prUrl), headSha }, opsRecordBody);
  if (opsRecord !== undefined && "error" in opsRecord) log("review.record_write_failed", { pr_number: reviewPrNumber(prUrl), head_sha: headSha, reason: opsRecord.error });
  const reviewPostedRow = {
    context: REVIEW_CONTEXT,
    state: verdict.state,
    head_sha: headSha,
    pr_url: prUrl,
    ...(opsRecord !== undefined && "path" in opsRecord ? { review_record_path: opsRecord.path } : {}),
    ...(inputDigest !== undefined ? { review_input_digest: inputDigest } : {}),
    review_engine_revision: REVIEW_ENGINE_REVISION,
    ...(runtimeImageSha !== undefined ? { runtime_image_sha: runtimeImageSha } : {}),
    review_decision_digest: decisionDigest,
    decision_verdict: verdict,
    evaluator_provenance: evaluatorProvenance,
    ...(reviewerCodeFreshness?.status === "fresh" ? { reviewer_code_sha: reviewerCodeFreshness.codeSha } : {}),
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
  if (inputDigest !== undefined) settleReviewOutboxEntry(args.ledgerPath, prUrl, inputDigest);
  await writeReviewEvidenceRecord(reviewPostedRow, task.catalog).catch(error => {
    log("review.evidence_write_failed", { pr_number: reviewPrNumber(prUrl), head_sha: headSha, reason: String(error) });
  });
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
  phases.armStart = systemClock.now();
  reappendLostReviewPosted({ ledgerPath: args.ledgerPath, runId: args.runId, headSha, decisionDigest, prUrl,
    row: reviewPostedRow, log, say });
  // W1-T13698: a shadow instance reviews and posts exactly as live does, but arms and merges nothing —
  // the arm refuses it (`automerge.shadow_refused`), as the sweep's does.
  const repoMode = args.repoMode ?? instanceMode(`${owner}/${repo}`, readInstanceRegistryText(repoRoot));
  const armCtx = { prUrl, taskId: task.id, headSha, ledgerPath: args.ledgerPath, headRefName: args.headRefName, log, repoMode,
    readChecksGreenReviewed: (_url: string, head: string) => readChecksGreenReviewedAtHead(owner, repo, head) };
  // W1-T9549: AWAITED. The daemon runs this review (`trackInFlightReview`), so the arm's gh and git leave its loop free.
  await armIfVerdictPermitsAsync(verdict, armCtx, { arm: args.arm });
  await landFindings(false);
  // Record after both authoritative posting and auto-merge eligibility. The recorder
  // swallows telemetry write failures; replay returns above before reaching this call.
  if (planOnlySkip) log("review.plan_only_phases", { head_sha: headSha, ...planOnlyPhaseFields(phases, systemClock.now(), args.materializeMs) });
  recordReviewFindings(findingCapture, { taskId: task.id, prUrl, headSha, decisionDigest,
    provenance: { ...evaluatorProvenance, servedModelReason: reviewerServedModelReason }, log });
  const followUps = reviewFollowUps(verdict.criteria, reviewerFindingText);
  for (const followUp of followUps) {
    log("review.follow_up_finding", { ...followUp, provider: evaluatorProvenance.provider,
      model: evaluatorProvenance.servedModel ?? evaluatorProvenance.routedModel ?? evaluatorProvenance.requestedModel,
      head_sha: headSha, review_decision_digest: decisionDigest,
      ...(inputDigest !== undefined ? { review_input_digest: inputDigest } : {}) });
  }
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
  // A holdout criterion's text never reaches a worker-readable surface (W1-T166), so its follow-ups stay host-side.
  const followUpSection = followUpFindingsSection(followUps.filter((f) => verdict.criteria[f.criterion - 1]?.holdout !== true));
  if (followUpSection) parts.push(followUpSection);
  // Ops publication permits only acceptance text; derived reasons, proof output and scope stay local.
  const body = task.catalog === "ops"
    ? opsReviewCommentBody(verdict.state, task.acceptance ?? [], verdict.criteria)
    : `${parts.join("\n\n---\n\n")}\n\n${reviewWriterMarker(args.runId, inputDigest, codeSha)}`;
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

/** W1-T15030: {@link refreshReviewSubjectInstall} whose escalation is ASYNC and awaited before this returns. staged-install
 *  marks a lockfile hash escalated once, so an issue a quick review exit cut short would never be filed again.
 *  `install` receives the recording escalation, as the default staged install does. */
export async function refreshReviewSubjectInstallAsync(
  repoDir: string,
  lockPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  escalate: (failure: StagedInstallFailure) => Promise<unknown>,
  install?: (repoDir: string, escalate: (failure: StagedInstallFailure) => void) => void,
): Promise<void> {
  const escalations: Promise<unknown>[] = [];
  const recordEscalation = (failure: StagedInstallFailure): void => { escalations.push(escalate(failure)); };
  refreshReviewSubjectInstall(repoDir, lockPath, log, recordEscalation,
    install === undefined ? undefined : (dir) => install(dir, recordEscalation));
  await Promise.all(escalations);
}

/** Result of {@link materializeReviewWorktree}: either a usable path, or a
 * clean workspace (nothing left behind) plus the named reason it failed. */
export type MaterializeReviewWorktreeResult =
  | { worktreePath: string; failure?: undefined }
  | { worktreePath: undefined; failure: MaterializationFailure };

/** Worker-visible publication fields, excluding proofs that reached no conclusion. */
export function reviewUnmetFields(verdict: ReviewVerdict) {
  const visibleUnmet = visibleCriteria(unmetReviewCriteria(verdict.criteria));
  return {
    visibleUnmet,
    unmetClaims: visibleUnmet.map(c => c.claim),
    reasons: reviewLedgerReasons(verdict),
  };
}

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
 * W1-T14195: read both halves of a mover removal and verify them (see lib/review.ts). The public half is local git in
 * the subject checkout (merge base to head); the ops half is three GETs against the configured plan destination: the
 * record at the receipt's commit, that commit's reachability from ops main, and then the public blob at the record's
 * moved_from commit. Every read that fails is the refusal `ops-read-unreadable` or a named public one, never a pass.
 */
export async function readMoverRemoval(args: {
  headRefName: string; headRefOid: string; repoDir: string; stateDir: string;
  /** Test seams: the git runner over the subject checkout, the ops API, and the base ref the merge base is cut from. */
  git?: (args: string[]) => Promise<string>; api?: OpsCatalogApi; baseRef?: string;
}): Promise<MoverRemovalVerdict> {
  const run = args.git ?? defaultGitRunnerAsync(args.repoDir);
  const attempt = (gitArgs: string[]): Promise<string | undefined> => run(gitArgs).then(out => out, () => undefined);
  const mergeBase = (await attempt(["merge-base", args.baseRef ?? "origin/main", args.headRefOid]))?.trim();
  const log = mergeBase ? await attempt(["log", "-z", "--format=%B", `${mergeBase}..${args.headRefOid}`]) : undefined;
  const status = mergeBase ? await attempt(["diff", "--name-status", "-z", "--no-renames", mergeBase, args.headRefOid]) : undefined;
  const message = (log ?? "").split("\0").join("\n");
  const fields = status === undefined ? undefined : status.split("\0").filter(Boolean);
  const entries = fields !== undefined && fields.length % 2 === 0
    ? Array.from({ length: fields.length / 2 }, (_, i) => ({ status: fields[2 * i]!, path: fields[2 * i + 1]! })) : undefined;
  const parsed = parseMoverReceipts(message);
  // One merge-base blob read per receipt, taken before the sync verifier runs.
  const baseBlobs = new Map<string, string | undefined>();
  if ("receipts" in parsed && mergeBase) {
    for (const receipt of parsed.receipts) baseBlobs.set(receipt.path, (await attempt(["rev-parse", "--verify", `${mergeBase}:${receipt.path}`]))?.trim());
  }
  const publicHalf = { headRefName: args.headRefName, message, entries, baseBlobAt: (path: string) => baseBlobs.get(path) };
  const pub = verifyMoverRemovalPublic(publicHalf);
  if (!pub.ok) return { verified: false, reason: pub.reason, ...(pub.id === undefined ? {} : { id: pub.id }) };
  const destination = planDestinationRepository(args.stateDir);
  const named = destination.outcome === "named" ? `${destination.owner}/${destination.repo}` : undefined;
  // Every receipt must name the plan destination; only then is the ops repository read at all.
  if (pub.receipts.some(receipt => receipt.repository !== named)) return verifyMoverRemoval({ public: publicHalf, ops: { destination: named } });
  const api = args.api ?? defaultOpsCatalogApi();
  const reads: Record<string, MoverOpsRead> = {};
  const reachable = new Map<string, boolean>();
  for (const receipt of pub.receipts) {
    try {
      const file = await api(`repos/${named}/contents/${receipt.path}?ref=${receipt.commit}`) as { type?: unknown; encoding?: unknown; content?: unknown; sha?: unknown };
      if (!reachable.has(receipt.commit)) {
        const compare = await api(`repos/${named}/compare/${receipt.commit}...main`) as { status?: unknown };
        reachable.set(receipt.commit, compare.status === "ahead" || compare.status === "identical");
      }
      const isFile = file.type === "file" && file.encoding === "base64" && typeof file.content === "string";
      const text = isFile ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(file.content as string, "base64")) : undefined;
      if (text !== undefined && createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex") !== file.sha) throw new Error("ops blob differs from its sha");
      const movedFrom = text === undefined ? undefined : movedFromCommit(text);
      const publicBlob = movedFrom === undefined ? undefined : (await attempt(["rev-parse", "--verify", `${movedFrom}:${receipt.path}`]))?.trim();
      reads[receipt.id] = { text, reachableFromMain: reachable.get(receipt.commit) === true, publicBlobAtMovedFrom: publicBlob };
    } catch (error) {
      // Any failed read is `ops-read-unreadable`, a refusal: the error text may carry private ops paths, so it is not kept.
      void error;
      reads[receipt.id] = "unreadable";
    }
  }
  return verifyMoverRemoval({ public: publicHalf, ops: { destination: named, reads } });
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
  taskLookup?: TaskLookupOptions;
  /** W1-T14195: the mover-removal read; the real two-repository read by default. */
  readMoverRemoval?: typeof readMoverRemoval;
  disarm?: (prUrl: string) => DisarmOutcome | void;
  onPhase?: (phase: string) => void;
  planLintRetryHead?: string;
  /** Bounded admission identity, separate from the existing worker/run and ownership conventions. */
  reviewAttemptId?: string;
  /** Test-only path for start-phase rows emitted before config is available or when its ledger is unreadable. */
  startPhasesLedgerPath?: string;
  contributorAdmission?: AdmissionObserver;
  fetchView?: (args: string[]) => unknown;
  /** Shared status/review history reader, injectable so command tests stay offline. */
  readReviewStatusHistory?: ReviewStatusHistoryReader;
  loadConfig?: () => Config;
  materialize?: ReviewCommandHost["materializeReviewWorktree"];
  withMaterialized?: typeof withMaterializedWorktree;
  /** W1-T11341: awaited by default, so an in-process review's base git never holds the daemon loop; a sync fake still fits. */
  buildBaseProof?: (criteria: Parameters<typeof buildBaseProofDirAsync>[0], headCheckoutDir: string) => BaseProofDir | Promise<BaseProofDir>;
  runReview?: (args: Parameters<typeof runReview>[1]) => ReturnType<typeof runReview>;
  postStatus?: typeof postReviewStatusGuarded;
  /** W1-T14902: posts pending naming an unread task hold when the task catalog is unreadable. Under the test runner the
   *  default posts nothing, so a fixture that reaches this exit never shells out to the real `gh`; inject to observe it. */
  publishUnreadHold?: typeof publishUnreadTaskCatalogHold;
  reviewerCodeFreshness?: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>;
  /** W1-T913: injectable so a test can observe the pending post without a real `gh` spawn — see
   *  `postReviewPending`'s call site below. Defaults to the real {@link postReviewPending}. */
  postReviewPending?: typeof postReviewPending;
  /** REST reader for the pending claim's combined status and newest history entry. */
  fetchPendingStatus?: GhApiFetcher;
  /** W1-T2511: the head-sha fetch, hoisted ABOVE criteria resolution. Same signature and same
   *  default implementation as {@link ReviewWorktreeDeps.fetch}, deliberately — the materializer
   *  still runs its own, and a second fetch of an already-fetched ref is a no-op, so this adds an
   *  ordering guarantee rather than a second network cost. Injectable so a test can drive the
   *  unfetched-sha case without a network. */
  fetchHead?: (repoDir: string, prNumber: number, headSha?: string) => unknown;
  /** The CLI verb defaults to semantic through operatorReviewArgs; internal callers that pass no flag stay deterministic. */
  executionMode?: "deterministic" | "semantic";
  /** Providers to avoid on a re-admitted review after a reviewer-unavailable result. */
  excludeProviders?: SpawnWorkerArgs["excludeProviders"];
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

/**
 * Run `body` against a possibly-materialized worktree, tearing it down on
 * EVERY exit path — `body` resolving, AND `body` throwing — never just the
 * success path, which would reproduce the W1-T175 leak class (that task
 * exists precisely because run worktrees already strand on disk). `undefined`
 * `worktreePath` (materialization was skipped/unavailable) is a no-op finally,
 * matching {@link materializeReviewWorktree}'s failure contract. Exported +
 * injectable so the teardown-on-throw guarantee (acceptance criterion 6) is a
 * unit fixture, independent of the real git/CLI plumbing `reviewCommand`
 * wires this with.
 */
export async function withMaterializedWorktree<T>(
  worktreePath: string | undefined,
  repoDir: string,
  body: () => Promise<T>,
  remove: (repoDir: string, worktreePath: string) => void | Promise<void> = worktreeRemoveAsync,
): Promise<T> {
  try {
    return await body();
  } finally {
    if (worktreePath) {
      try {
        await remove(repoDir, worktreePath);
      } catch (e) {
        // Best-effort teardown: a removal failure must never mask `body`'s own
        // result or throw — the ledger/console already carry the review's
        // outcome; a stranded worktree here is a startup-prune concern
        // (pruneStaleRuns), never this command's job to retry.
        console.error(`(worktree teardown failed for ${worktreePath}: ${String((e as Error)?.message ?? e)})`);
      } finally {
        releaseReviewWorktree(worktreePath);
      }
    }
  }
}

export async function reviewCommand(host: ReviewCommandHost, prArg: string, rest: string[] = [], deps: ReviewCommandDeps = {}, exit?: ReviewExit): Promise<number> {
  if (exit === undefined) return reportingReviewExit(rest, (opened) => reviewCommand(host, prArg, rest, deps, opened));
  const { acceptedReviewAttemptId, materializeReviewWorktree, realDeps, reviewPostedDescription } = host;
  // W1-T11261: time every step before the first ledger row; a step that throws still records its elapsed time and error class.
  const commandStartedAt = systemClock.now();
  const startPhases: Record<string, unknown> = {};
  const recordStartPhase = (name: string, startedAt: number, error?: unknown): void => {
    startPhases[`${name}_ms`] = systemClock.now() - startedAt;
    if (error !== undefined) startPhases[`${name}_error`] = error instanceof Error ? error.constructor.name : typeof error;
  };
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
    excludeProviders,
    readMoverRemoval: readMoverRemovalDep,
  } = {
    fetchView: ghJson,
    loadConfig,
    materialize: materializeReviewWorktree,
    withMaterialized: withMaterializedWorktree,
    buildBaseProof: buildBaseProofDirAsync,
    runReview: runReview.bind(null, host),
    postStatus: postReviewStatusGuarded,
    reviewerCodeFreshness: () => checkReviewerCodeFreshnessAsync(repoRoot, process.env),
    postReviewPending,
    fetchHead: host.reviewWorktreeAsync?.fetch ?? realDeps().reviewWorktree.fetch,
    executionMode: "deterministic" as const,
    readMoverRemoval,
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
    exit.as("repo-unresolvable");
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
  // W1-T15037: the own-start reading comes before the first gh read, whose read-cadence lock can wait for many
  // minutes; main moving during that wait is the same case as the W1-T9727 admission wait, not stale code.
  const ownStartReading = deps.reviewStartFreshness ??
    (deps.judgeAtOwnStart === true ? await ownStartFreshness(reviewerCodeFreshnessDep) : undefined);
  const raw = await (deps.fetchView ?? ghJsonAsync)(args);
  exit.step = "setup";
  // The sweep's open-PR snapshot can age while earlier reviews run. The numeric arm already
  // fetched the live REST row, so decline a closed PR before fetching its head or building a
  // worktree. The guarded poster still makes the final lifecycle check for an in-flight close.
  // W1-T12145: a calibration case is a MERGED pull request reviewed in shadow at its recorded head. It is
  // reviewed although closed only when the head it names is the one the PR merged; a shadow review publishes nothing.
  const calibrationCase = reviewPrNumber(prArg) !== undefined && isCalibrationCaseOf(rest, raw as RestPullRow);
  if (reviewPrNumber(prArg) !== undefined && (raw as RestPullRow).state === "closed" && !calibrationCase) {
    // The decline is a review outcome too: ledger it so a skipped closed PR is not a silent gap.
    const closed = raw as RestPullRow;
    appendLedger(ledgerPathFor(loadConfigDep()), {
      run_id: `review-PR${closed.number}-${Date.now()}`, task_id: `PR-${closed.number}`, lane: "review",
      step: "review.skipped_closed_before_review", pr_number: closed.number, pr_url: closed.html_url,
      head_sha: closed.head?.sha, merged: typeof closed.merged_at === "string",
    });
    console.log(`rmd review: PR #${prArg} closed before review; no verdict posted`);
    exit.as("closed-before-review");
    return 2;
  }
  const view = (reviewPrNumber(prArg) !== undefined ? mapRestPr(raw as RestPullRow) : raw) as {
    createdAt?: string;
    headRefOid: string;
    headRefName: string;
    body: string;
    url: string;
    number: number;
  };
  let body = view.body ?? "";
  const reportBody = body;
  const runId = `review-PR${view.number}-${Date.now()}`;
  // W1-T15030: while this command runs, its run is live in this process, so its claim is never read as orphaned.
  exit.release?.();
  exit.release = holdReviewRunLive(runId);
  const reviewAttemptId = acceptedReviewAttemptId(deps.reviewAttemptId, view.number);
  const shadow = rest.includes(REVIEWER_SHADOW_FLAG);
  const startPhasesStep = reviewerShadowStep("review.start_phases", shadow);
  const inputDigest = reviewInputDigest(view.headRefOid, body);
  const fallbackStartPhasesLedgerPath = deps.startPhasesLedgerPath ?? ledgerPathFor({ root: join(homedir(), "Remudero") });
  let startPhasesRowWritten = false;
  const writeStartPhases = (path: string, taskId: string): void => {
    if (startPhasesRowWritten) return;
    const row = {
      run_id: runId, task_id: taskId, step: startPhasesStep, lane: "review",
      ...(reviewAttemptId === undefined ? {} : { review_attempt_id: reviewAttemptId, review_input_digest: inputDigest }),
      head_sha: view.headRefOid, total_ms: systemClock.now() - commandStartedAt, ...startPhases,
      ...reviewerHealthRowFields("review.start_phases", flagValue(rest, REVIEWER_INCIDENT_FLAG)),
    };
    try {
      appendLedger(path, row);
    } catch (error) {
      if (path === fallbackStartPhasesLedgerPath) throw error;
      appendLedger(fallbackStartPhasesLedgerPath, row);
    }
    startPhasesRowWritten = true;
  };
  const startPhaseHandlers = <T>(name: string, startedAt: number, path: string, taskId: string): [(value: T) => T, (error: unknown) => never] => [
    value => { recordStartPhase(name, startedAt); return value; },
    error => { recordStartPhase(name, startedAt, error ?? "thrown"); writeStartPhases(path, taskId); throw error; },
  ];
  const configLoadStartedAt = systemClock.now();
  let config: Config;
  try {
    config = loadConfigDep();
    recordStartPhase("config_load", configLoadStartedAt);
  } catch (e) {
    recordStartPhase("config_load", configLoadStartedAt, e ?? "thrown");
    writeStartPhases(fallbackStartPhasesLedgerPath, `PR-${view.number}`);
    throw e;
  }
  const ledgerPath = ledgerPathFor(config);
  // W1-T14947: before anything else this run does, reap the review locks whose owner this container proves gone, so a
  // recycle refusal that named one settles (see reclaimDeadReviewLocks).
  if (!shadow) reclaimDeadReviewLocks(join(config.root, "state", "inflight"));
  const ledgerReadStartedAt = systemClock.now();
  let reviewLedger: ReturnType<typeof readLedgerLines>;
  try {
    reviewLedger = readLedgerLines(ledgerPath);
    recordStartPhase("ledger_read", ledgerReadStartedAt);
  } catch (e) {
    recordStartPhase("ledger_read", ledgerReadStartedAt, e ?? "thrown");
    writeStartPhases(ledgerPath, `PR-${view.number}`);
    throw e;
  }

  // Criteria: task trailer → tasks.yaml; else the PR body's Acceptance: block.
  let criteria: AcceptanceCriterion[] = [];
  let source = "NONE (fail closed — nothing to judge is never a pass)";
  const reviewPlanOnlyFiling = planOnlyFiling ?? isPlanOnlyFilingPr(reviewLedger, view.url);
  const taskId = resolveReviewTaskId(
    body,
    view.headRefName,
    reviewPlanOnlyFiling,
  );
  const reviewKey = reviewLedgerKeyFor(taskId, view.number);
  // W1-T10269: a shadow review publishes nothing and its rows are renamed; every terminal row names the judging code's sha.
  // W1-T13380: `startFailure` is the reason this run recorded when its reviewer could not start.
  let startFailure: string | undefined;
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    if (step === "review.semantic_incomplete" && extra.reviewer_outcome === REVIEWER_START_FAILED_OUTCOME) startFailure = String(extra.reason);
    appendLedger(ledgerPath, { run_id: runId, task_id: reviewKey, step: reviewerShadowStep(step, shadow), lane: "review",
      ...(reviewAttemptId === undefined ? {} : { review_attempt_id: reviewAttemptId, review_input_digest: inputDigest }), ...extra,
      ...reviewerHealthRowFields(step, flagValue(rest, REVIEWER_INCIDENT_FLAG)) });
  };
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
    exit.as("subject-refused");
    return 1;
  }
  const subjectRepoDir = subjectCheckout.repoDir;
  // W1-T4933: a satellite's managed checkout is the reviewer's install source too; only a validated one (never the test fallback).
  if (subjectCheckout.explicitTarget && subjectRepoDir !== repoRoot && (reviewSubject.ok || deps.refreshSubjectInstall !== undefined)) {
    // W1-T15030: the async escalation is awaited, so a quick review exit cannot end the process before the issue exists.
    await refreshReviewSubjectInstallAsync(
      subjectRepoDir,
      join(config.root, "state", `managed-checkout-${repo}.lock`),
      log,
      (failure) => tryEscalateAsync(managedCheckoutInstallEscalation(failure, reviewKey, runId),
        { issues: renewingIssueGateway(ghIssueGatewayAsync(owner, repo), { log }), ledgerPath, runId }),
      deps.refreshSubjectInstall,
    );
  }
  // W1-T322: the same plan lookup this block already does for `criteria` also carries the
  // task's declared scope — an advisory-only input judgeReview needs. Stays `undefined` on ANY
  // read/parse failure (see the catch below), exactly like `criteria` degrading to the body's
  // Acceptance: block — never a reason to fail the review.
  let taskCatalog: "public" | "ops" | undefined;
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
  const fetchHeadStartedAt = systemClock.now();
  try {
    await fetchHead(subjectRepoDir, view.number, view.headRefOid);
    recordStartPhase("fetch_head", fetchHeadStartedAt);
  } catch (e) {
    recordStartPhase("fetch_head", fetchHeadStartedAt, e ?? "thrown");
    void e;
    // Swallowed on purpose — see above. The materializer's own fetch names a real outage.
  }
  let resolverDivergence: PlanCriteriaAtHeadDivergence | undefined;
  let mainPlanDivergence: PlanCriteriaAtHeadDivergence | undefined;
  let ownTaskRecordMissing = false, headTaskResolved = false;
  let publicTaskAbsent = false;
  // W1-T2846: a fleet PR can lose its trailer while retaining the task-bearing run branch.
  // Give the existing exact-trailer criteria resolver only the recovered identity it needs;
  // `reportBody` still carries the real PR body unchanged to the fallback and reviewer below.
  if (taskId && !reviewTaskIdFromBody(body)) body = `Remudero-Task: ${taskId}`;
  const headCriteriaStartedAt = systemClock.now();
  const [recordHeadSuccess, recordHeadFailure] = startPhaseHandlers<Awaited<ReturnType<typeof resolvePlanCriteriaAtHeadAsync>>>(
    "head_criteria", headCriteriaStartedAt, ledgerPath, reviewKey,
  );
  // W1-T13794: a satellite target's catalog (remudero-ops) holds other repositories' tasks naming dependencies it cannot
  // hold; the strict read threw on the first one and every task of that repository was refused review. Its own tasks stay strict.
  const keepsUnseenDependency = subjectCheckout.explicitTarget && subjectRepoDir !== repoRoot
    ? (task: { repo: string }) => !taskTargetsRepo(task.repo, `${owner}/${repo}`) : undefined;
  if (taskId) {
    const resolved = await resolvePlanCriteriaAtHeadAsync(body, subjectRepoDir, "plan/tasks.yaml", view.headRefOid, undefined,
      keepsUnseenDependency)
      .then(recordHeadSuccess, recordHeadFailure);
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
      const mainCriteriaStartedAt = systemClock.now();
      const [recordMainSuccess, recordMainFailure] = startPhaseHandlers<Awaited<ReturnType<typeof resolvePlanCriteriaAtHeadAsync>>>(
        "main_criteria", mainCriteriaStartedAt, ledgerPath, reviewKey,
      );
      const atMain = await resolvePlanCriteriaAtHeadAsync(body, subjectRepoDir, "plan/tasks.yaml", "origin/main", undefined,
        keepsUnseenDependency)
        .then(recordMainSuccess, recordMainFailure);
      ownTaskRecordMissing = headLacksOwnTaskRecord(resolved, atMain);
      mainPlanDivergence = atMain.divergence;
      publicTaskAbsent = atMain.divergence === undefined && atMain.criteria.length === 0 &&
        atMain.taskDeclaredFiles === undefined && atMain.taskRisk === undefined && atMain.taskBudgetUsd === undefined;
    }
  }
  // W1-T14902 (invariant an-unread-hold-holds): THE ONE unread-hold exit. Every path that leaves this review without a
  // verdict for a named task whose record could not be read replaces a success already on this head with pending
  // naming the unread hold, projected as an ops task's status is. A shadow posts nothing.
  const publishUnreadHoldFor = async (source: string, reason: string): Promise<void> => {
    // The review lane's own untasked classification of this id on this head (a main-repair or other generated lane's
    // synthetic trailer on its own run branch names no task); the publisher re-checks the live PR through the resolver.
    if (shadow || !taskId || usesUntaskedReviewMetadata(taskId, view.headRefName)) return;
    await (deps.publishUnreadHold ?? (isTestRunner() ? async () => {} : publishUnreadTaskCatalogHold))({
      post: catalogReviewPoster("ops", postReviewStatus), owner, repo, sha: view.headRefOid, taskId, reviewKey, source, reason, planOnlyFiling: reviewPlanOnlyFiling,
      ledgerPath, runId, prUrl: view.url, reviewInputDigest: inputDigest, fetchLifecycle: () => fetchPrLifecycleAsync(view.url), log });
  };
  // The public plan at origin/main could not be read for a task the head's plan lacks: neither its hold nor its catalog
  // is known, so the hold is unread before anything else runs.
  if (mainPlanDivergence !== undefined) await publishUnreadHoldFor("public plan at origin/main", mainPlanDivergence.reason);
  if (taskId && publicTaskAbsent) {
    const lookUp = () => findTaskInCatalogs(taskId, { ...deps.taskLookup, stateDir: join(config.root, "state"), byId: new Map() });
    let found = await lookUp();
    // W1-T12226: a push to the ops branch during the read refuses it; the next read sees the new commit. One retry only.
    if (found.outcome === "unreadable" && found.reason === "ops-ref_moved") found = await lookUp();
    if (found.outcome === "unreadable") {
      log("review.catalog.unreadable", { reason: found.reason });
      await publishUnreadHoldFor("task catalog", found.reason);
      console.error("rmd review: task catalog unreadable; no body fallback or review effect");
      exit.as("task-metadata-unavailable");
      return 2;
    }
    if (found.outcome === "found") {
      const contract = catalogTaskContract(found);
      taskCatalog = found.catalog;
      if (contract.criteria.length === 0) {
        console.error("rmd review: catalog task has no acceptance criteria; no body fallback or review effect");
        exit.as("task-metadata-unavailable");
        return 2;
      }
      criteria = contract.criteria;
      taskDeclaredFiles = contract.taskDeclaredFiles;
      taskRisk = contract.taskRisk;
      taskBudgetUsd = contract.taskBudgetUsd;
      taskNarrative = contract.taskNarrative ?? {};
      source = contract.source ?? source;
      headTaskResolved = true;
    }
  }
  let criteriaFromBody = false;
  if (criteria.length === 0) {
    const fromBody = parseAcceptanceBlock(reportBody);
    if (fromBody.length) {
      criteria = fromBody;
      source = `PR body Acceptance: block (${fromBody.length} criteria)`;
      criteriaFromBody = true;
    }
  }
  // W1-T14627: proof-discrimination took the body's `kind: guard` on trust; a guard no record declares is refused here.
  const guardCheck = markUnbackedBodyGuards(criteria, parseAcceptanceBlock(reportBody), criteriaFromBody);
  if (guardCheck.unbacked.length > 0) {
    criteria = guardCheck.criteria;
    log("review.body_guard_unbacked", { head_sha: view.headRefOid, count: guardCheck.unbacked.length });
  }
  // W1-T14195: the mover's REMOVE pull request carries neither a trailer nor an Acceptance block on purpose. A head that
  // is mover-shaped and still has no criteria is verified against both repositories; any failure leaves the no-criteria
  // refusal in place, and the reason is ledgered, never posted.
  let moverRemoval: MoverRemovalVerdict | undefined;
  if (criteria.length === 0 && !taskId && view.headRefName.startsWith(MOVER_BRANCH_PREFIX)) {
    moverRemoval = await readMoverRemovalDep({ headRefName: view.headRefName, headRefOid: view.headRefOid,
      repoDir: subjectRepoDir, stateDir: join(config.root, "state") });
    log("review.mover_removal", moverRemoval.verified ? { verified: true, tasks: moverRemoval.receipts.map(r => r.id) } : { verified: false, reason: moverRemoval.reason, task: moverRemoval.id ?? null });
    if (moverRemoval.verified) source = `verified mover removal of ${moverRemoval.receipts.map(r => r.id).join(", ")}`;
  }

  writeStartPhases(ledgerPath, reviewKey);
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
    exit.as("task-narrative-unavailable");
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
        await publishUnreadHoldFor("task record at the PR head", `missing ${missing.join(", ")}`);
        console.error("rmd review: semantic review unavailable (head task metadata); no verdict or merge effect");
        exit.as("task-metadata-unavailable");
        return 2;
      }
    } else {
      try {
        reviewerMount = resolveMount(loadMounts(mountsPath(repoRoot)), "reviewer", taskRisk);
        // W1-T12145: a calibration case pins the reviewer model under test; reviewerModelPin is undefined outside shadow.
        const pin = reviewerModelPin(rest);
        if (pin !== undefined) reviewerMount = { ...reviewerMount, provider: pin.provider, model: pin.model };
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
        exit.as("semantic-setup-unavailable");
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
  const startFreshness = ownStartReading;
  // The start reading could not prove freshness: say so, then fall back to the JIT read.
  if (startFreshness?.status === "unreadable") {
    log("review.reviewer_freshness_unreadable_at_start", {
      pr_url: view.url, head_sha: view.headRefOid, review_input_digest: inputDigest,
      reason: startFreshness.reason,
    });
  }
  // W1-T12227: a fresh-tree child stale at its own start ends before its pending status and its reviewer; its gate retries.
  if (!shadow && deps.reviewStartFreshness === undefined && startFreshness?.status === "stale") {
    console.error(`rmd review: reviewer code ${startFreshness.codeSha.slice(0, 12)} is behind origin/main ` +
      `${startFreshness.originMainSha.slice(0, 12)} at its own start; no pending status and no reviewer`);
    exit.as("reviewer-stale-at-start");
    return 2;
  }
  const publicationFreshness = reviewerFreshnessForPublication(startFreshness, reviewerCodeFreshnessDep);
  // W1-T14947: one lock under state/inflight/reviews from before the pending post until after the terminal row — the
  // claim, materialization, base proof, the review and any replayed or restored post — released on every exit path, so
  // a container recycle's drain waits for an in-flight review. A shadow review posts nothing and takes none.
  const reviewLock = shadow ? undefined : acquireInflightLock(join(config.root, "state", "inflight", REVIEW_INFLIGHT_DIR),
    host.reviewWorkerLockId(runId), { run_id: runId, reclaim: false });
  try {
    let claimHeld: string | undefined;
    let claimPosted = false;
    if (!shadow) try {
      const claimLedger = await readLedgerUnionRecords(dirname(ledgerPath), {
        selectRotation: () => false,
        step: ["review.pending_posted", ...REVIEW_RUN_SETTLED_STEPS],
        where: (row) => row.head_sha === view.headRefOid && reviewRowNamesPr(row, reviewKey, view.url),
        onUnreadLive: () => { claimHeld = "the action-time review ledger could not be read"; },
      });
      const hasClaim = claimLedger.some(row => row.step === "review.pending_posted");
      const checkedStatus = hasClaim ? await readBoundPendingClaimStatus(owner, repo, view.headRefOid,
        deps.fetchPendingStatus ?? ((args) => ghJsonAsync(args, undefined, undefined, { fresh: true }))) : undefined;
      claimHeld ??= checkedStatus?.reason;
      const claim = claimHeld !== undefined ? undefined : await postReviewPendingDep({
        owner,
        repo,
        sha: view.headRefOid,
        taskId: reviewKey,
        runId,
        ledgerPath,
        prUrl: view.url,
        reviewInputDigest: inputDigest,
        reviewEngineRevision: REVIEW_ENGINE_REVISION,
        fetchLifecycle: () => fetchPrLifecycleAsync(view.url),
        fetchStatus: checkedStatus === undefined ? undefined : () => checkedStatus.combined,
      });
      claimPosted = claim?.posted === true;
      if (claim !== undefined) claimHeld = pendingClaimHeldByAnotherRun(claim, runId, claimLedger, view.headRefOid);
    } catch (e) {
      log("review.pending_post.error", { error: String((e as Error)?.message ?? e) });
    }
    // W1-T14177: a claim refusal is returned, never discarded — another run's live claim holds this head.
    if (claimHeld !== undefined) {
      log("review.stood_down", { pr_url: view.url, head_sha: view.headRefOid, review_input_digest: inputDigest, reason: claimHeld });
      console.log(`rmd review: PR #${view.number} not reviewed — ${claimHeld}`);
      exit.as("review-claim-held");
      return 2;
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
      exit.as("own-task-record-missing");
      return 2;
    }

    // W1-T185 (Gap 2): materialize a throwaway worktree at the PR head so
    // whitelisted proofs actually EXECUTE on this manual path, matching what
    // the automated fix rung observes for the same PR/proofs (acceptance
    // criterion 4). On ANY failure this leaves worktreePath undefined and the
    // review falls back to keyword-only — EXPLICITLY marked (criterion 5),
    // never silently, and (W1-T233) the console line below now NAMES why,
    // instead of a bare "unavailable" with the real reason thrown away.
    exit.step = "materialize";
    const materializeStartedMs = systemClock.now();
    const materialized = await materialize(config, subjectRepoDir, view.number, view.headRefOid);
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
    const baseProof = worktreePath ? await buildBaseProof(criteria, worktreePath) : undefined;
    const materializeMs = systemClock.now() - materializeStartedMs;

    // W1-T185 (Gap 2, criterion 6): withMaterializedWorktree guarantees teardown
    // on EVERY exit path, including a throw from runReview itself — never just
    // the success path, which would reproduce the W1-T175 leak class. (R-11) The
    // base worktree is torn down by the SAME helper, as the outer scope, so the
    // head goes first and the base follows on every exit path too; a grep tree is
    // deleted there the same way, and a blob-only fallback dir is not a worktree and
    // is left to the boot sweep (src/lib/tmp.ts) exactly as before.
    // W1-T185 (Gap 1, criterion 2), raised by W1-T229: the operator override —
    // a LEDGERED, attributable decision to arm a capped verdict anyway.
    // Granted here (the manual escape hatch, an operator-run command) rather
    // than inferred: an override is a decision someone made, and it must name
    // who. No `principles`/tdd-tier check gates this note since W1-T229 — a
    // CAPPED verdict refuses to arm regardless of tdd tier. W1-T14241: recorded
    // BEFORE the review runs, because a capped code pass now posts pending until
    // an override for its head is in the ledger — the run's own guarded post
    // reads this row and publishes success.
    const overrideBy = flagValue(rest, "--override-capped-by");
    const overrideReason = flagValue(rest, "--override-capped-reason");
    if (overrideBy && overrideReason && !shadow) {
      if (!taskId) {
        console.error(
          "--override-capped-by/--override-capped-reason need a resolvable task (a Remudero-Task: trailer) " +
            "— not recorded.",
        );
      } else {
        // W1-T219: BIND the grant to the head it is reviewed against —
        // cappedOverrideFromLedger refuses to honour it against any other head.
        log("automerge.capped_override_granted", {
          by: overrideBy,
          reason: overrideReason,
          pr_url: view.url,
          head_sha: view.headRefOid,
        });
        console.log(
          `CAPPED override recorded — by ${overrideBy}: ${overrideReason} (task ${taskId}, head ${view.headRefOid.slice(0, 7)})`,
        );
      }
    }
    exit.step = "review";
    let verdict = await withMaterialized(
      baseProof?.baseIsCheckout || baseProof?.baseIsGrepTree ? baseProof.baseCheckoutDir : undefined,
      subjectRepoDir,
      () =>
        withMaterialized(worktreePath, subjectRepoDir, () => whileWorkerRunLive(host, runId, () =>
          runReviewDep({
            onPhase: deps.onPhase,
            ...(deps.planLintRetryHead === undefined ? {} : { planLintRetryHead: deps.planLintRetryHead }),
            reviewReplaySetupInput: replaySetupInput,
            owner,
            repo,
            prUrl: view.url,
            // impl-BG: excludes dependabot heads from the post-verdict arm (the dep-review lane owns those).
            headRefName: view.headRefName,
            ...(keepsUnseenDependency ? { reservationHomeDir: repoRoot } : {}),
            task: {
              id: reviewKey,
              catalog: taskCatalog,
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
            excludeProviders,
            // W1-T185 (Gap 2): the materialized worktree above when available — the
            // SAME `headCheckoutDir` wiring the autonomous path uses, so whitelisted
            // proofs execute here too. `undefined` (materialization unavailable)
            // makes `judgeReview` mark the verdict `keywordOnly`+`capped`, exactly
            // the documented fallback (criterion 5) — never silent.
            headCheckoutDir: worktreePath,
            reviewerCodeFreshness: publicationFreshness,
            admission: deps.reviewStartFreshness !== undefined ? "start-gate" : deps.judgeAtOwnStart === true ? "fresh-tree-child" : "operator",
            prCreatedAt: view.createdAt,
            readReviewStatusHistory: deps.readReviewStatusHistory,
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
            materializeMs,
            ledgerPath,
            runId,
            openTaskIds,
            ...(moverRemoval === undefined ? {} : { moverRemoval }),
            ...(shadow ? { shadow: true } : {}),
            ...(calibrationCase ? { calibrationCase: true } : {}),
          }), join(config.root, "state", "inflight")),
        ),
      baseProof?.baseIsGrepTree ? (_repo, tree) => rmSync(tree, { recursive: true, force: true }) : undefined,
    );
    // W1-T10269: a shadow review ends at its verdict: no restore, no status, no comment, no arm.
    exit.step = "publish";
    if (shadow && verdict.verdictWithheld) exit.as("shadow-verdict-withheld");
    if (shadow) return verdict.verdictWithheld ? 2 : 0;
    // W1-T13380: a reviewer that never started leaves no review running, so this run replaces its own claim with the truth.
    if (claimPosted && startFailure !== undefined) {
      try {
        await postStatusDep({ post: catalogReviewPoster(taskCatalog, failureRecordingPoster().post), owner, repo, sha: view.headRefOid,
          state: "pending", description: `pending (owned by run ${runId}) — no review running: the reviewer failed to start ` +
            `(${startFailure}); retry due`, taskId: reviewKey, evidence: "no_evidence", ledgerPath, runId, prUrl: view.url,
          reviewInputDigest: inputDigest, reviewEngineRevision: REVIEW_ENGINE_REVISION, fetchLifecycle: () => fetchPrLifecycleAsync(view.url),
          // W1-T15030: a run another run took over replaces nothing: the post is refused claim_lost under its lock.
          claimLost: () => reviewClaimLost(ledgerPath, runId, view.headRefOid, view.url) });
      } catch (e) {
        log("review.pending_post.error", { error: String((e as Error)?.message ?? e) });
      }
    }

    // A final review decision is immutable, but GitHub's commit status is last-write-wins. A stale
    // daemon may have posted pending after that decision; replay must check the live context and
    // restore the already-judged terminal status instead of reporting a success that GitHub cannot see.
    let replayStatusAction: "restored" | "confirmed" | undefined;
    if (verdict.decisionDisposition === "replayed" && verdict.reviewDecisionDigest) {
      if (verdict.verdictWithheld) exit.as("replayed-verdict-withheld");
      if (verdict.verdictWithheld) return 2;
      const restorePoster = failureRecordingPoster();
      const restoringState = verdict.state;
      const restoringFreshness = await publicationFreshness();
      // W1-T15030: replay withdrawals renew refused tokens and check the claim before disarming.
      const replayClaimLost = () => reviewClaimLost(ledgerPath, runId, view.headRefOid, view.url);
      const withdrawReplayed = (v: ReviewVerdict) => withdrawAfterPublication(v,
        { prUrl: view.url, taskId: reviewKey, headSha: view.headRefOid, ledgerPath, log, runId },
        { disarm: deps.disarm, claimLost: replayClaimLost });
      let replayDispute: ReviewPassDispute | undefined;
      const restored = await postStatusDep({
        post: catalogReviewPoster(taskCatalog, restorePoster.post, restoringFreshness.status === "fresh" ? restoringFreshness.codeSha : undefined),
        owner, repo, sha: view.headRefOid, state: verdict.state, verdict,
        readReviewStatusHistory: disputeGuardedHistoryReader(deps.readReviewStatusHistory ?? readSharedReviewStatusHistory, verdict,
          { runId, inputDigest, codeSha: restoringFreshness.status === "fresh" ? restoringFreshness.codeSha : undefined },
          { planOnly: verdict.planOnly, reviewerOutcome: verdict.reviewerOutcome }, (found) => { replayDispute = found; }),
        description: reviewPostedDescription(verdict),
        taskId: reviewKey, evidence: reviewEvidenceStrength(verdict.criteria),
        ledgerPath, runId, prUrl: view.url, reviewInputDigest: inputDigest,
        reviewDecisionDigest: verdict.reviewDecisionDigest,
        reviewEngineRevision: REVIEW_ENGINE_REVISION,
        reviewerCodeFreshness: restoringFreshness,
        fetchLifecycle: () => fetchPrLifecycle(view.url),
        fetchCurrentStatus: () => reviewStatusEntryFromCombined(fetchView(combinedStatusRestArgs(owner, repo, view.headRefOid)))?.state,
        fetchCurrentStatusEntry: () => readReviewStatusEntry(owner, repo, view.headRefOid, deps.fetchView),
        fetchPublisher: deps.fetchView,
        readRequiredContexts: readRequiredStatusCheckContextsAsync,
        cannotEvaluateEscalation: (e, issues) => tryEscalateAsync(taskCatalog === "ops" ? { ...e, detail: "Review cannot evaluate this head; detailed evidence is retained on the host." } : e,
          { issues: renewingIssueGateway(issues ?? ghIssueGatewayAsync(owner, repo), { log, prUrl: view.url, headSha: view.headRefOid }), ledgerPath, runId }),
        // W1-T14235: a replayed decision re-publishes a code pass only when its recorded judgement was semantic.
        semanticJudgement: { planOnly: verdict.planOnly, reviewerOutcome: verdict.reviewerOutcome },
        claimLost: replayClaimLost,
      });
      verdict.reviewDecisionDigest = restored.effectiveReviewDecisionDigest ?? verdict.reviewDecisionDigest;
      if (restored.effectiveVerdict) verdict = { ...verdict, ...restored.effectiveVerdict, state: restored.effectiveState ?? restored.effectiveVerdict.state };
      if (restored.claimLost !== undefined) verdict.verdictWithheld = "claim_lost";
      else if (restoringState === "success" && verdict.state === "failure") await withdrawReplayed(verdict);
      if (restored.claimLost !== undefined) {
        // W1-T15030: refused claim_lost under the lock; nothing is disarmed, held or escalated.
      } else if (replayDispute !== undefined && restored.effectiveState === "pending") {
        verdict = { ...verdict, ...await holdDisputedPass(replayDispute, verdict, { owner, repo, prUrl: view.url, headSha: view.headRefOid,
          taskId: reviewKey, runId, ledgerPath, catalog: taskCatalog, log, disarm: deps.disarm,
          publish: (pending, pendingDescription, heldClaimLost) => postStatusDep({ post: catalogReviewPoster(taskCatalog, restorePoster.post), owner, repo,
            claimLost: heldClaimLost,
            sha: view.headRefOid, state: "pending", verdict: pending, description: pendingDescription, taskId: reviewKey,
            evidence: reviewEvidenceStrength(pending.criteria), ledgerPath, runId, prUrl: view.url, reviewInputDigest: inputDigest,
            reviewEngineRevision: REVIEW_ENGINE_REVISION, reviewerCodeFreshness: restoringFreshness,
            fetchLifecycle: () => fetchPrLifecycle(view.url), readRequiredContexts: readRequiredStatusCheckContextsAsync }) }) };
      } else if (restored.semanticHold !== undefined) {
        if (verdict.state === "pending") await withdrawReplayed(verdict);
        verdict.verdictWithheld = restored.reason ?? restored.semanticHold;
      } else if (restored.cappedHold !== undefined) {
        // W1-T14241: a replayed capped code pass no override certified is restored as pending, never as success.
        await withdrawReplayed(verdict);
        verdict.verdictWithheld = restored.cappedHold;
      } else if (restored.posted) {
        replayStatusAction = "restored";
        const { unmetClaims, reasons } = reviewUnmetFields(verdict);
        const reviewPostedRow = {
          context: REVIEW_CONTEXT, state: verdict.state, head_sha: view.headRefOid, pr_url: view.url,
          review_input_digest: inputDigest, review_engine_revision: REVIEW_ENGINE_REVISION,
          review_decision_digest: verdict.reviewDecisionDigest, decision_verdict: verdict,
          evaluator_provenance: verdict.evaluatorProvenance,
          ...(restoringFreshness.status === "fresh" ? { reviewer_code_sha: restoringFreshness.codeSha } : {}),
          reviewer_outcome: verdict.reviewerOutcome, proof_exec: verdict.criteria.map((criterion) => criterion.proof_exec),
          unmet_criteria: unmetClaims, reasons, ...reviewLedgerLegibilityFields(verdict),
          status_recovered: true,
          status_publisher: restored.publisherEvidence,
        };
        log("review.posted", reviewPostedRow);
        if (restorePoster.published()) {
          await writeReviewEvidenceRecord(reviewPostedRow, taskCatalog).catch(error => {
            log("review.evidence_write_failed", { pr_number: view.number, head_sha: view.headRefOid, reason: String(error) });
          });
        }
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
      // W1-T11151: a restored, confirmed or refused replay is terminal; only a restore whose publication threw holds its slot.
      if (!restorePoster.failed()) (deps.onPhase ?? reportReviewPhase)("posted");
    }

    console.log(
      `\nremudero-review=${verdict.state} ${verdict.verdictWithheld ? "WITHHELD" : replayStatusAction ?? "posted"} to ${view.url} (head ${verdict.headSha.slice(0, 7)})` +
        (verdict.verdictWithheld ? ` — ${verdict.verdictWithheld}` : "") +
        (reviewVerdictAnnotation(verdict) ? ` — ${reviewVerdictAnnotation(verdict)}` : "") +
        // W1-T1085: the same three-way fact the status itself renders — a plan-only PR is not a
        // degraded one, and saying "not certified" here contradicts the status posted seconds ago.
        (cappedWordingApplies(verdict) ? " — CAPPED: not certified (0 proofs executed)" : ""),
    );
    // W1-T14241: a capped code pass held as pending is withheld, yet the override that releases it is still followable.
    const cappedHoldWithheld = verdict.verdictWithheld?.startsWith(UNCERTIFIED_PASS_HELD) === true;
    if (cappedHoldWithheld && !(overrideBy && overrideReason) && cappedWordingApplies(verdict)) {
      console.log(cappedOverrideHint(view.number));
    }
    if (verdict.verdictWithheld) exit.as("verdict-not-posted");
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
    // W1-T14241: the grant itself is recorded BEFORE the review runs (the `--override-capped-by` block above), so the run's
    // own guarded post reads it and releases the capped pass to success. Only the hint remains here.
    if (!(overrideBy && overrideReason) && cappedWordingApplies(verdict) && !cappedHoldWithheld) {
      // W1-T1085: a SEPARATE call site from the capped annotation above, with the same defect —
      // gated on `capped` alone. For a plan-only verdict both halves are false: it arms, and the
      // override is structurally unreachable, so the hint is advice that cannot be followed. The
      // status this run posts already states the truth, so nothing replaces it here.
      console.log(cappedOverrideHint(view.number));
    }

    if (verdict.state !== "success") exit.as(REVIEW_EXIT_CAUSES.find((cause) => cause === `verdict-${verdict.state}`) ?? "verdict-not-success");
    return verdict.state === "success" ? 0 : 1;
  } finally {
    reviewLock?.release();
  }
}

/** W1-T14947: the in-flight lock directory a review holds from its claim to its result, read by deploy/recycle-container.sh's
 *  drain. Task dispatch and the orphan sweep read only the top-level `state/inflight/*.lock` files, so a review lock is never
 *  a task run (invariant one-lock-per-review). */
export const REVIEW_INFLIGHT_DIR = "reviews";

/** W1-T14947: remove each lock under `<inflightDir>/reviews` whose owner this host proves gone — its pid is dead, or now
 *  names a process younger than the lock (isHolderStale) — and return the reaped ids. A review killed past its finally (a
 *  drain that abandons it, a crash, a kill) leaves its lock behind. A recycle refusal may already name that lock as a
 *  blocker, and the deployer settles a lock blocker only once the file is gone, while the held automatic recycle never
 *  reruns deploy/recycle-container.sh, whose own reclaim runs only inside a recycle. So every review run reaps them first,
 *  inside the container whose process table can answer. A lock another host wrote is judged exactly as the daemon's boot
 *  sweep judges a top-level one. Never throws: an unreadable directory is returned as `error` and the review goes on. */
export function reclaimDeadReviewLocks(
  inflightDir: string, opts: Parameters<typeof sweepStaleInflightLocks>[1] = {},
): { reaped: string[]; error?: string } {
  try {
    const { reaped } = sweepStaleInflightLocks(join(inflightDir, REVIEW_INFLIGHT_DIR), opts);
    if (reaped.length > 0) console.log(`rmd review: reclaimed review lock(s) whose owner is gone: ${reaped.join(", ")}`);
    return { reaped };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    console.error(`rmd review: review locks not swept (${error}); a dead one stays until a later run reaps it`);
    return { reaped: [], error };
  }
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

/** W1-T11162 — a plan-only review's own phases, in milliseconds, from the marks {@link runReview} takes. */
export function planOnlyPhaseFields(marks: Record<string, number>, armedAt: number, materializeMs?: number): Record<string, number> {
  const span = (from: string, to: string): number => Math.max(0, (marks[to] ?? marks[from] ?? 0) - (marks[from] ?? 0));
  return {
    ...(materializeMs === undefined ? {} : { materialize_ms: materializeMs }),
    diff_ms: span("diffStart", "diff"), decision_ms: span("diff", "decision"), lint_ms: span("lintStart", "lint"),
    judge_ms: span("lint", "judge"), post_ms: span("postStart", "post"),
    arm_ms: Math.max(0, armedAt - (marks.armStart ?? armedAt)), total_ms: Math.max(0, armedAt - (marks.started ?? armedAt)),
  };
}

/**
 * W1-T14902 (invariant an-unread-hold-holds): the review could not read the named task's catalog, so the task's
 * `dispatch_hold` is unread. Before the review exits, it replaces whatever status this head carries (a success from an
 * earlier pass included) with pending naming the unread hold, through the pending-only {@link postUnreadTaskHoldGuarded},
 * which ledgers what the post actually did. A throw is ledgered too, never thrown out of the review's exit.
 */
export async function publishUnreadTaskCatalogHold(args: {
  publish?: typeof postUnreadTaskHoldGuarded;
  post: Parameters<typeof postReviewStatusGuarded>[0]["post"];
  owner: string; repo: string; sha: string; taskId: string; reviewKey: string; reason: string;
  /** What could not be read. Default: the task catalog. */
  source?: string;
  ledgerPath: string; runId: string; prUrl: string; reviewInputDigest: string;
  fetchLifecycle: Parameters<typeof postReviewStatusGuarded>[0]["fetchLifecycle"];
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** Whether this review identified the PR as a plan-only filing (its run branch then names no task). */
  planOnlyFiling?: boolean;
  /** The one PR task resolver. Default: {@link resolvePullRequestTaskSubject}, one fresh read of the live PR. */
  resolveSubject?: (prUrl: string) => Promise<PullRequestTaskSubject>;
}): Promise<void> {
  // W1-T14902: the hold belongs to the task the LIVE PR names, classified on its live head. An untasked PR (a generated
  // lane's synthetic trailer on its own run branch) has no hold to be unread, so a success standing on it stays.
  // An unreadable PR is no exemption: the hold stays unread and pending is posted.
  let taskId = args.taskId;
  let inputDigest = args.reviewInputDigest;
  try {
    const subject = await (args.resolveSubject ??
      ((url: string) => resolvePullRequestTaskSubject(url, freshPullRowRead, () => args.planOnlyFiling === true)))(args.prUrl);
    if (subject.untasked) {
      args.log("review.dispatch_hold_untasked", { task_id: subject.taskId ?? null, head_ref: subject.headRefName });
      return;
    }
    taskId = subject.taskId ?? taskId;
    // Round-8 C1: the pending write names the body the hold was read from, so the freshness rule judges it against the
    // live PR rather than the body this review started from.
    inputDigest = reviewInputDigest(args.sha, subject.snapshot.body, REVIEW_ENGINE_REVISION);
  } catch (e) {
    args.log("review.dispatch_hold_subject_unreadable", { error: String((e as Error)?.message ?? e) });
  }
  const refusal = taskHoldRefusal({ outcome: "unread", taskId, reason: `${args.source ?? "task catalog"} ${args.reason}` })!;
  try {
    await (args.publish ?? postUnreadTaskHoldGuarded)({ post: args.post, owner: args.owner, repo: args.repo, sha: args.sha,
      refusal, taskId: args.reviewKey, ledgerPath: args.ledgerPath, runId: args.runId, prUrl: args.prUrl,
      reviewInputDigest: inputDigest, reviewEngineRevision: REVIEW_ENGINE_REVISION, fetchLifecycle: args.fetchLifecycle });
  } catch (e) {
    args.log("review.pending_post.error", { error: String((e as Error)?.message ?? e) });
  }
}
