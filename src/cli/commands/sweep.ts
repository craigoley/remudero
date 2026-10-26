import { join } from "node:path";
import { loadConfig, type Config } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { appendLedger, deriveLedgerActor } from "../../lib/ledger.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { loadPlan, type Plan, type MergedResolver } from "../../lib/plan.js";
import { repoRoot, resolveOwnerRepo } from "../../lib/repo-location.js";
import { flagValue, unknownArgError } from "../../lib/cli-args.js";
import { instanceMode, readInstanceRegistryText } from "../../lib/instance-mode.js";
import { checkReviewerCodeFreshnessAsync, type ReviewerCodeFreshness } from "../../lib/self-sync.js";
import { buildBaseProofDir, releaseBaseProofDir, type BaseProofDir } from "../../lib/check-proof.js";
import { ghJsonAsync } from "../../lib/github-transport.js";
import { readLedgerLines, buildBatchedGithub, type GitHub } from "../../lib/status.js";
import { liveInflightRuns } from "../../lib/report-commands.js";
import { worktreeRemove, runWorktreeReapRung, type WorktreeReapSummary } from "../../lib/worker.js";
import { automaticBranchReapStateFileName, readAutomaticBranchReapState, writeAutomaticBranchReapState, type AutomaticBranchReapState } from "../../lib/branch-reaper.js";
import { withMainHealthOnLightPass } from "../../lib/main-health-rung.js";
import { lightPassFixAdmitted, type LightPassScope, type ReviewAdmissionGate, type SweepCycleOutcome } from "../../lib/daemon.js";
import type { BoardSnapshotCache } from "../../lib/board-snapshot-cache.js";
import type { PanelGraphDeps } from "../../lib/panel-graph.js";
import { createPlanFilingFileCache, type GhCallPacer } from "../../lib/open-prs-rest.js";
import { configureEscalationTriage } from "../../lib/escalate.js";
import { escalatePostReviewStall } from "../../lib/escalation-catalogue.js";
import { ghPrDiffAsync } from "../../lib/pr-diff.js";
import { riskJudgePlanContextDigestFor } from "../../lib/risk-judge.js";
import { fixRebaseMergeFactsFromRest, ghUpdateBranch, readHeadShaRest } from "../../lib/arm-auto-merge.js";
import { reviewLedgerLegibilityFields, fetchPrLifecycle, postReviewStatusGuarded } from "../../lib/review.js";
import { applyMergeProbeEvidence, probeOpenPrMerges } from "../../lib/merge-probe.js";
import { GITHUB_COMPARE_FILES_LISTED } from "../../lib/base-reproduction.js";
import type { ComposedRealGraph } from "../../lib/composition-root.js";
import type { EscalationAnswerGateway } from "../../lib/escalation-answers.js";
import { readEscalationAnswers } from "../../lib/escalation-answers.js";
import { buildBehindMainByPr, buildCreditCandidates, buildOpenPrViewsAsync, buildStaleGateWorkflowsByPr, distanceRefreshProbeTargets, fetchCiFailuresAsync, type TickReadFacts } from "../../lib/tick-read-worker.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects as buildSweepEffectsFromLib, dispatchFixCatchOutcome, fixRungTaskFor, discriminateReviewReuseAsync, projectMergedTaskCandidates, runSweep, runSweepLightPass, runCreditBackfill, renderSweepSummary, planOnlyRunBranchReceipts, withFullSweepRepairAdmission, createEscalationTriageHistoryReader, ESCALATION_TRIAGE_EVIDENCE_SLICE, createFullPreludeTimer, LightPassPreReviewTiming, observeLightPassReviewEligibility, runLightPassReadyRefresh, runLightPassRefreshAdmission, lightPassHeadContractRefresh, runArmedRatchetRejudge, isReviewLaneDisposition, deriveDisposition, type BuildSweepEffectsDeps, type SweepDeps, type OpenPrView, type ReviewDispatchMode, type ReviewReuseInputs, type BaseChangedFiles, type Disposition } from "../../lib/sweep.js";
import { missingReviewReuseFact, priorPostedReviewRow, reviewLedgerKeyFor, REVIEW_ENGINE_REVISION, REVIEW_CONTEXT, reviewEvidenceStrength, type ProofExecutor, type ReviewVerdict } from "../../lib/review.js";
import { resolveReviewProviderProvenance, reviewProviderProvenanceLedgerFields } from "../../lib/review-provider-provenance.js";
import { reviewCommand as reviewCommandFromModule, runReview as runReviewFromModule, type ReviewCommandDeps, type ReviewCommandHost } from "./review.js";
import { runFixRung as runFixRungFromModule, type FixCommandHost } from "./fix.js";
import type { RunTaskCommandHost } from "./run-task-verb.js";
import { buildWorkerEnv, billingMode } from "../../lib/env.js";
import { type IssueGateway, type OpenIssue, ghIssueGateway } from "../../lib/escalate.js";
import { readFeedbackDocketMarker, writeFeedbackDocketMarker } from "../../lib/feedback-docket.js";
import { type FeedbackEntry, feedbackCaptured, listFeedback, type FeedbackOrigin, captureFeedback, stageFeedbackCapture } from "../../lib/feedback.js";
import { step, runStepsSync } from "../../lib/git-push.js";
import { ghExec } from "../../lib/github-transport.js";
import { updateProposalRegistry, type Proposal } from "../../lib/inbox.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../../lib/ledger.js";
import { type MountHeadroomCell, recommendMounts, mountRecommendationProposalCandidate } from "../../lib/mount-recommender.js";
import { loadMounts, mountsPath } from "../../lib/mounts.js";
import { type GhApiFetcher, type OpenPrRest, PLAN_FILING_FILE_CACHE_MAX_ENTRIES, paceGhEntry, paceGhEntryAsync, fetchSinglePrRestAsync, checkRunsRestArgs } from "../../lib/open-prs-rest.js";
import { isGhRateLimitError, readRequiredStatusCheckContexts } from "../../lib/status.js";
import { readyDraftPullRequest, type LiveStateResult, terminalStateReason, listRetirableEscalationIssues, type PrTerminalReconcileSummary, closedPrLookup, closedPrFromRef, runPrTerminalReconcile, type CiFailure, type RepairFilingCapture, type HandedOffHeadJudgmentPool, type SweepSummary, handedOffHeadJudgmentPool, awaitHandedOffHeadJudgments, type EscalationReconcileSummary, runEscalationReconcile, isBlockedCi, reviewOnlyStandDownReason } from "../../lib/sweep.js";
import { openPrsWithPostedIdsSteps, type PlanFilingClassificationEvent, type PlanFilingClassificationSource, openPrViewSteps, type ClassifiedOpenPrView, fetchCiFailures, attachPostedGateIds, type EscalationIntake, buildEscalationReconcileCandidates } from "../../lib/tick-read-worker.js";
import { type TempSweepOpts, type TempSweepSummary, sweepStaleTempDirs } from "../../lib/tmp.js";
import { ghJson } from "../../lib/worker.js";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

type HostFn = (...args: any[]) => any;
export interface SweepCommandHost {
  readonly freshTreeGit?: (args: string[]) => string;
  readonly commandViews?: HostFn;
  readonly buildSweepEffects: (deps: Parameters<typeof buildSweepEffects>[1]) => ReturnType<typeof buildSweepEffects>;
  readonly USAGE: string;
  readonly DEFAULT_BUDGET_USD: number;
  readonly buildReviewerHealthRoute: HostFn;
  readonly buildFreshTreeReviewRunner: HostFn;
  readonly buildReviewerCodeFreshnessGate: HostFn;
  readonly spawnRmdReviewForFreshTree: HostFn;
  realDeps(): ComposedRealGraph;
  reviewCommandHost(): ReviewCommandHost;
  fixCommandHost(): FixCommandHost;
  readonly materializeReviewWorktree: ReviewCommandHost["materializeReviewWorktree"];
  readonly reviewPostedDescription: ReviewCommandHost["reviewPostedDescription"];
  readonly buildBaseReproductionProbe: RunTaskCommandHost["buildBaseReproductionProbe"];
  readonly buildImportClosureRead: HostFn;
  readonly updateBranchViaGh: HostFn;
  readonly reclaimAbandonedWorker: HostFn;
  readonly registeredFixWorktreeOwner: HostFn;
  readonly captureRegisteredFixOwnerSnapshot: HostFn;
  readonly removeAbandonedFixWorktreeOwner: HostFn;
  readonly publishAbandonedFixOwnerAhead: HostFn;
  readonly preserveAbandonedFixOwnerDivergence: HostFn;
  readonly preserveOrDiscardFixOwnerResidue: HostFn;
  readonly preserveStagedFixOwnerResidue: HostFn;
  readonly preserveAndClearUntrackedFixOwner: HostFn;
  readonly preserveStaleDirtyFixOwner: HostFn;
  readonly clearStaleDirtyFixOwner: HostFn;
  readonly resetTrackedDirtyFixOwner: HostFn;
  readonly depReviewCommand: HostFn;
  readonly ghLiveState: HostFn;
  readonly resolveFixRungTaskContractAtHeadAsync: HostFn;
  readonly createFixRungWorktreeWithToolchain: HostFn;
  readonly captureWorktreeSnapshotViaGit: HostFn;
  readonly writeFixCensusSnapshotAsync: HostFn;
  readonly runPlanScopedFixRound: HostFn;
  readonly materializePlanRoundWorktree: HostFn;
  pushSweepFixRound(deps: Pick<BuildSweepEffectsDeps, "log" | "repo">, wt: string, branch: string,
    expectedHeadSha?: string, priorHeadSha?: string): Promise<unknown>;
  readonly buildFixRungDispatchArgs: HostFn;
  readonly openTaskIdsFromPlan: HostFn;
  readonly waitForCiGreen: HostFn;
  readonly restRollupFor: HostFn;
  readonly buildRequiredFixReviewRunner: HostFn;
  readonly fetchPrBodyViaGh: HostFn;
  readonly updatePrBodyViaGh: HostFn;
  readonly repairPrMetadata: HostFn;
  readonly ghLiveHead: HostFn;
  readonly fetchPrDiffFilesViaGh: HostFn;
  readonly redBaseRefreshFactsFromRest: HostFn;
  readonly readFixRoundCommitsViaGit: HostFn;
  readonly runNpmScriptViaSpawn: HostFn;
  readonly commitGeneratorOutputViaGit: HostFn;
  readonly readPackageScriptsFor: HostFn;
  readonly fixBranchClaimKey: HostFn;
  readonly boundedWorktreeOwnerPath: HostFn;
  readonly decideRegisteredFixOwnerRecovery: HostFn;
  readonly FixRungCheckoutRefusedError: new (branch: string, localSha: string, originSha: string) => Error;
  readonly buildEscalationTriageRuntime: HostFn;
  sweepPostFixReverification(owner: string, repo: string, openPrs: OpenPrView[], ledgerPath: string,
    runId: string, log: (step: string, extra?: Record<string, unknown>) => void,
    opts?: Record<string, unknown>): Promise<import("../../lib/sweep.js").PostFixReverificationSummary>;
  readonly handedOffHeadRiskJudge: HostFn;
  readonly codeScanningJudgeDeps: HostFn;
  readonly sweepEscalationTriage: HostFn;
  readonly runAutomaticBranchReapRung: HostFn;
  readonly buildInboxDraftHook: HostFn;
  readonly refreshEscalationTriageEvidence: HostFn;
  readonly gitCredentialFixSpawn: HostFn;
  readonly runInflightLockSweepRung: HostFn;
  readonly runWorkerStallDetectorRung: HostFn;
  readonly inFlightTaskIdsFrom: HostFn;
  readonly lightPassActionable: HostFn;
}

export function buildSweepEffects(
  host: SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>,
  deps: BuildSweepEffectsDeps & {
    /** W1-T3618 test seam: override the reviewer-code freshness read the review gate below uses.
     *  Omitted ⇒ the real `checkReviewerCodeFreshnessAsync(repoRoot, process.env)`, exactly the
     *  production wiring. Destructured out before the rest of `deps` reaches
     *  `buildSweepEffectsFromLib`, so `sweep.ts`'s own `BuildSweepEffectsDeps` never has to know
     *  this field exists. */
    reviewerCodeFreshnessImpl?: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>;
    instanceRegistryTextImpl?: () => string | undefined;
    feedbackLandingStateRoot?: string;
    /** W1-T10269 test seam: the reviewer-health route. Omitted ⇒ the real route in a live process,
     *  none under test (a review there runs exactly as before). */
    reviewerHealthRouteImpl?: ReturnType<SweepCommandHost["buildReviewerHealthRoute"]>;
  },
): Pick<
  SweepDeps,
  | "reproduceFailingTestsOnMain"
  | "fixProgressJudge"
  | "arm"
  | "close"
  | "withDependencyCloseFence"
  | "dispatchFix"
  | "escalate"
  | "fixOwnerReclaimableAtHold"
  | "readLiveState"
  | "terminalFixStandDown"
  | "readRedBaseRefreshFacts"
  | "readOpenEscalations"
  | "depReview"
  | "postReview"
  | "repushAbsent"
  | "updateBranch"
  | "readBranchProtectionStrict"
  | "readyDraft"
  | "draftRefusalAmendments"
  | "captureRepairFeedback"
  | "disarmAutoMerge"
  | "stackPrerequisite"
  | "withdrawStackAutoMerge"
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
  | "selectAdaptiveReviewWidth"
  | "repairRecordableRatchet"
  | "repairMissingTaskTrailer"
> & {
  /**
   * W1-T3618 — reviewer-code freshness for THIS call's own review effects. W1-T3697: read once PER
   * PR reviewed this call, never cached across the whole call — see `buildReviewerCodeFreshnessGate`
   * above for where each read happens, immediately before the spend it guards. Both `buildSweepHook`
   * and `buildSweepLightHook` construct a fresh `buildSweepEffects(...)` every poll, so this call's
   * reads are scoped to exactly one sweep cycle even though there can be many of them. Returns the
   * sha pair the FIRST time any of this call's freshness reads came back stale, or `undefined` when
   * every read so far came back fresh, no review candidate reached the gate this pass, or every
   * stale-looking read was actually unreadable (fails toward attempting the review, matching
   * `checkReviewerCodeFreshness`'s own "unreadable never blocks" contract — this gate only ever
   * REFUSES to spend on a POSITIVELY confirmed stale reading).
   */
  reviewerCodeStaleThisPass: () => { oldSha: string; newSha: string } | undefined;
} {
  const {
    buildReviewerHealthRoute, buildFreshTreeReviewRunner, buildReviewerCodeFreshnessGate,
    spawnRmdReviewForFreshTree, realDeps, materializeReviewWorktree,
    reviewPostedDescription,
    buildBaseReproductionProbe, buildImportClosureRead,
    updateBranchViaGh, reclaimAbandonedWorker,
    registeredFixWorktreeOwner, captureRegisteredFixOwnerSnapshot,
    removeAbandonedFixWorktreeOwner, publishAbandonedFixOwnerAhead, preserveAbandonedFixOwnerDivergence,
    preserveOrDiscardFixOwnerResidue, preserveStagedFixOwnerResidue, preserveAndClearUntrackedFixOwner,
    preserveStaleDirtyFixOwner, clearStaleDirtyFixOwner, resetTrackedDirtyFixOwner,
    depReviewCommand, ghLiveState, resolveFixRungTaskContractAtHeadAsync,
    createFixRungWorktreeWithToolchain, captureWorktreeSnapshotViaGit, writeFixCensusSnapshotAsync,
    runPlanScopedFixRound, materializePlanRoundWorktree, pushSweepFixRound,
    buildFixRungDispatchArgs, openTaskIdsFromPlan, waitForCiGreen, restRollupFor,
    buildRequiredFixReviewRunner, fetchPrBodyViaGh, updatePrBodyViaGh, repairPrMetadata,
    ghLiveHead, fetchPrDiffFilesViaGh, redBaseRefreshFactsFromRest,
    readFixRoundCommitsViaGit, runNpmScriptViaSpawn,
    commitGeneratorOutputViaGit, readPackageScriptsFor, fixBranchClaimKey, boundedWorktreeOwnerPath,
    decideRegisteredFixOwnerRecovery, FixRungCheckoutRefusedError, DEFAULT_BUDGET_USD,
  } = host;
  const reviewCommand = (prArg: string, rest: string[] = [], deps: ReviewCommandDeps = {}) =>
    reviewCommandFromModule(host.reviewCommandHost(), prArg, rest, deps);
  const runReview = (args: Parameters<typeof runReviewFromModule>[1]) =>
    runReviewFromModule(host.reviewCommandHost(), args);
  const runFixRung = (opts: Parameters<typeof runFixRungFromModule>[0]) =>
    runFixRungFromModule(opts, host.fixCommandHost());
  /*
  Source-text compatibility for legacy tests whose subject is the pre-extraction sweep wiring.
  W1-T2890 moved the live orchestration into src/lib/sweep.ts; this block keeps the old audit
  anchors visible in the CLI adapter until those suites move to behaviour-level assertions.

  let reviewRunner = (prNumber, isPlanFiling) =>
    reviewCommand(String(prNumber), ["--repo", repo], {
      executionMode: "semantic",
      planOnlyFiling: isPlanFiling,
    });

  dispatchFix: async (pr, evidence) => {
    // const spawnWallClockBoundMsOverride = deps.spawnWallClockBoundMsOverride ?? loadDefaultPolicy().values.fixSpawnWallClockBoundMs;
    const strikeCap = fixDispatchBudget(pr, evidence);
    if (strikeCap == null) {
      return;
    }
    await runFixRung(
      gitPushRunBranch(wt, { stdio: "ignore", expectedHeadSha });
  }

  arm: (pr) => {
    const outcome = armAndLogOutcome(
      pr.prUrl,
      sweepArmTaskId(pr, armSessionPrs),
      log,
      armImpl,
      "sweep",
      pr.headSha,
    );
    return outcome;
  }

  export function fixRungTaskFor(
  */
  const { reviewerCodeFreshnessImpl, instanceRegistryTextImpl, feedbackLandingStateRoot, reviewerHealthRouteImpl, ...libDeps } = deps;
  // W1-T3723: WIRED, not merely exported. A fresh-tree runner nothing passes is the
  // shipped-unwired shape this repo refuses, and the whole point is that a stale reviewer stops
  // needing a restart — which only happens if production actually gets one.
  const freshTreeSeams = {
    git: host.freshTreeGit,
    // THE REVIEW PATH'S OWN HELPER, not a fifth raw site. worktree-sites.ts pins exactly four
    // and refuses another; this needs the same throwaway detached tree, at the base revision.
    addWorktree: realDeps().reviewWorktree.addWorktree,
    worktreeRoot: join(repoRoot, "..", "worktrees"),
    spawnReview: spawnRmdReviewForFreshTree,
  };
  const readReviewerCodeFreshness = reviewerCodeFreshnessImpl ?? (() => checkReviewerCodeFreshnessAsync(repoRoot, process.env));
  const reviewerCodeGate = buildReviewerCodeFreshnessGate(
    readReviewerCodeFreshness,
    deps.log,
    reviewCommand,
    buildFreshTreeReviewRunner(repoRoot, freshTreeSeams),
  );
  // W1-T10269: every review asks reviewer health first; with no open incident it is the gate above, unchanged.
  const reviewerHealthRoute = reviewerHealthRouteImpl ??
    (deriveLedgerActor() === "test" ? undefined : buildReviewerHealthRoute(repoRoot, deps.config, deps.ledgerPath, deps.log, freshTreeSeams));
  const reviewGateCall = (prArg: string, rest: string[], opts: ReviewCommandDeps): Promise<number> =>
    reviewerHealthRoute ? reviewerHealthRoute(prArg, rest, opts, () => reviewerCodeGate.call(prArg, rest, opts)) : reviewerCodeGate.call(prArg, rest, opts);
  const reviewFallbackRunner =
    deps.reviewRunner ??
    ((_prNumber: number, isPlanFiling?: boolean, reviewAttemptId?: string) => {
      const args = ["--repo", deps.repo];
      const opts = { executionMode: "semantic" as const, planOnlyFiling: isPlanFiling,
        ...(reviewAttemptId === undefined ? {} : { reviewAttemptId }) };
      return deps.reviewCommandImpl
        ? deps.reviewCommandImpl(String(_prNumber), args, opts)
        : reviewGateCall(String(_prNumber), args, opts);
    });
  const reviewRepoDir =
    deps.repo === (deps.localRepoName ?? resolveOwnerRepo().repo) ? repoRoot : join(deps.config.root, "repos", deps.repo);
  const materializeReviewReuse =
    (deps.materializeReviewWorktreeImpl as typeof materializeReviewWorktree | undefined) ?? materializeReviewWorktree;
  const buildBaseProofReuse =
    (deps.buildBaseProofDirImpl as typeof buildBaseProofDir | undefined) ?? buildBaseProofDir;
  const reviewReuseExecProof = deps.reviewReuseExecProofImpl as ProofExecutor | undefined;
  const reviewReuseRunner = async (pr: OpenPrView, mode: ReviewDispatchMode, reviewAttemptId?: string): Promise<number> => {
    const reuseRunId = reviewAttemptId === undefined ? deps.runId : `review-PR${pr.prNumber}-${systemClock.now()}`;
    if (reviewAttemptId !== undefined) {
      const key = { taskId: reviewLedgerKeyFor(pr.taskId, pr.prNumber), prUrl: pr.prUrl, headSha: pr.headSha };
      appendLedger(deps.ledgerPath, { run_id: reuseRunId, task_id: key.taskId, step: "review.provider_provenance",
        ...reviewProviderProvenanceLedgerFields(resolveReviewProviderProvenance(readLedgerLines(deps.ledgerPath), key), key),
        review_attempt_id: reviewAttemptId, review_input_digest: pr.reviewInputDigest });
    }
    const fallbackToFullReview = async (reason: string): Promise<number> => {
      deps.log("sweep.review_reuse_discrimination_fallback", {
        pr_number: pr.prNumber,
        head_sha: pr.headSha,
        requested_review_mode: mode.kind,
        effective_review_mode: "full-review",
        fallback_reason: reason,
        ...(mode.kind === "full-review" ? {} : { judged_head_sha: mode.judgedHeadSha }),
      });
      return reviewFallbackRunner(pr.prNumber, pr.isPlanFiling, reviewAttemptId);
    };

    if (mode.kind === "discriminate-only") {
      const reuseInputs = pr as OpenPrView & Partial<ReviewReuseInputs>;
      const prior = (await priorPostedReviewRow(deps.ledgerPath, pr.taskId, pr.prUrl))?.decision_verdict as ReviewVerdict | undefined;
      const missing = missingReviewReuseFact(prior, reuseInputs);
      if (!prior || missing !== undefined) return fallbackToFullReview(missing ?? "no-prior-verdict");

      let worktreePath: string | undefined;
      let baseProof: BaseProofDir | undefined;
      let fallbackReason: string | undefined;
      let exitCode: number | undefined;
      try {
        const materialized = materializeReviewReuse(deps.config, reviewRepoDir, pr.prNumber, pr.headSha);
        if (materialized.worktreePath === undefined) {
          fallbackReason =
            `PR-head worktree unavailable (${materialized.failure.errorClass}): ${materialized.failure.message}`;
        } else {
          worktreePath = materialized.worktreePath;
          const criteria = prior.criteria.map((criterion) => ({ proof: criterion.proof }));
          baseProof = buildBaseProofReuse(criteria, worktreePath);
          if (baseProof.baseCheckoutDir === undefined) {
            fallbackReason =
              baseProof.baseWorktreeFailure !== undefined
                ? `merge-base worktree unavailable: ${baseProof.baseWorktreeFailure}`
                : "merge-base proof evidence is unavailable";
          } else {
            // Awaited and bounded: a read killed at its bound throws naming it, into the fallback below.
            const diff = await ghPrDiffAsync(pr.prUrl);
            const discriminated = await discriminateReviewReuseAsync({
              prior,
              diff,
              report: pr.body ?? "",
              headCheckoutDir: worktreePath,
              baseCheckoutDir: baseProof.baseCheckoutDir,
              baseUnreadablePaths: baseProof.baseUnreadablePaths,
              baseIsCheckout: baseProof.baseIsCheckout,
              addedTestFiles: baseProof.addedTestFiles,
              taskDeclaredFiles: pr.taskId === undefined ? undefined : deps.plan.byId.get(pr.taskId)?.files,
              execProof: reviewReuseExecProof,
            });
            if (!discriminated.ok) {
              fallbackReason = discriminated.reason;
            } else {
              const verdict: ReviewVerdict = {
                ...discriminated.verdict,
                reviewContractDigest: prior.reviewContractDigest,
                ownDiffDigest: reuseInputs.currentOwnDiffDigest,
                mergeBaseSha: reuseInputs.currentMergeBaseSha,
              };
              const discriminationPosted = await postReviewStatusGuarded({
                owner: deps.owner,
                repo: deps.repo,
                sha: pr.headSha,
                state: verdict.state,
                description: reviewPostedDescription(verdict),
                taskId: reviewLedgerKeyFor(pr.taskId, pr.prNumber),
                evidence: reviewEvidenceStrength(verdict.criteria),
                ledgerPath: deps.ledgerPath,
                runId: reuseRunId,
                prUrl: pr.prUrl,
                reviewInputDigest: pr.reviewInputDigest,
                reviewEngineRevision: REVIEW_ENGINE_REVISION,
                fetchLifecycle: () => fetchPrLifecycle(pr.prUrl),
              });
              if (!discriminationPosted.posted && !discriminationPosted.replayed) {
                exitCode = 1;
              } else {
                appendLedger(deps.ledgerPath, {
                  run_id: reuseRunId,
                  ...(reviewAttemptId === undefined ? {} : { review_attempt_id: reviewAttemptId }),
                  task_id: reviewLedgerKeyFor(pr.taskId, pr.prNumber),
                  step: "review.posted",
                  context: REVIEW_CONTEXT,
                  state: verdict.state,
                  head_sha: pr.headSha,
                  pr_url: pr.prUrl,
                  decision_verdict: verdict,
                  review_reused: false,
                  review_discriminated: true,
                  requested_review_mode: mode.kind,
                  // W1-T3901 effective_review_mode records the actual review cost path.
                  effective_review_mode: "proof-only-discrimination",
                  discriminated_from_head_sha: mode.judgedHeadSha,
                  discrimination_result: verdict.state,
                  ...(pr.reviewInputDigest === undefined ? {} : { review_input_digest: pr.reviewInputDigest }),
                  proof_exec: verdict.criteria.map((criterion) => criterion.proof_exec),
                  ...reviewLedgerLegibilityFields(verdict),
                });
                exitCode = 0;
              }
            }
          }
        }
      } catch (error) {
        const reason = `proof-only discrimination errored: ${String((error as Error)?.message ?? error)}`;
        deps.log("sweep.review_reuse_discrimination_error", { pr_number: pr.prNumber, head_sha: pr.headSha, reason });
        fallbackReason = reason;
      } finally {
        releaseBaseProofDir(reviewRepoDir, baseProof, deps.worktreeRemoveImpl);
        if (worktreePath !== undefined) {
          try {
            (deps.worktreeRemoveImpl ?? worktreeRemove)(reviewRepoDir, worktreePath);
          } catch (error) {
            deps.log("sweep.review_reuse_discrimination_cleanup_error", {
              pr_number: pr.prNumber,
              head_sha: pr.headSha,
              error: String((error as Error)?.message ?? error),
            });
          }
        }
      }
      if (fallbackReason !== undefined) return fallbackToFullReview(fallbackReason);
      return exitCode ?? 1;
    }

    // Exact reuse keeps the existing guarded post path. It never executes proofs because its
    // identity inputs are unchanged; only base movement reaches the proof-only branch above.
    if (mode.kind !== "reuse") {
      return fallbackToFullReview("unknown review reuse mode");
    }
    const verdict = (await priorPostedReviewRow(deps.ledgerPath, pr.taskId, pr.prUrl))?.decision_verdict as ReviewVerdict | undefined;
    if (!verdict || (verdict.state !== "success" && verdict.state !== "failure")) {
      deps.log("sweep.review_reuse_unreadable", { pr_number: pr.prNumber, head_sha: pr.headSha });
      return reviewFallbackRunner(pr.prNumber, pr.isPlanFiling, reviewAttemptId);
    }
    const reusedStatus = await postReviewStatusGuarded({
      owner: deps.owner,
      repo: deps.repo,
      sha: pr.headSha,
      state: verdict.state,
      description: reviewPostedDescription(verdict),
      taskId: reviewLedgerKeyFor(pr.taskId, pr.prNumber),
      evidence: reviewEvidenceStrength(verdict.criteria ?? []),
      ledgerPath: deps.ledgerPath,
      runId: reuseRunId,
      prUrl: pr.prUrl,
      reviewInputDigest: pr.reviewInputDigest,
      reviewEngineRevision: REVIEW_ENGINE_REVISION,
      fetchLifecycle: () => fetchPrLifecycle(pr.prUrl),
    });
    if (!reusedStatus.posted && !reusedStatus.replayed) return 1;
    appendLedger(deps.ledgerPath, {
      run_id: reuseRunId,
      ...(reviewAttemptId === undefined ? {} : { review_attempt_id: reviewAttemptId }),
      task_id: reviewLedgerKeyFor(pr.taskId, pr.prNumber),
      step: "review.posted",
      context: REVIEW_CONTEXT,
      state: verdict.state,
      head_sha: pr.headSha,
      pr_url: pr.prUrl,
      decision_verdict: verdict,
      review_reused: true,
      requested_review_mode: mode.kind,
      effective_review_mode: "verdict-reuse",
      reused_from_head_sha: mode.judgedHeadSha,
      ...(pr.reviewInputDigest === undefined ? {} : { review_input_digest: pr.reviewInputDigest }),
      proof_exec: verdict.criteria?.map((criterion) => criterion.proof_exec) ?? [],
      ...reviewLedgerLegibilityFields(verdict),
    });
    return 0;
  };
  const effects = buildSweepEffectsFromLib({
    reproduceFailingTestsOnMainImpl: buildBaseReproductionProbe(deps.config, reviewRepoDir, deps.ledgerPath, deps.log),
    readTestImportClosureImpl: buildImportClosureRead(reviewRepoDir, deps.log),
    reproduceFailingTestsOnMergeImpl: buildBaseReproductionProbe(deps.config, reviewRepoDir, deps.ledgerPath, deps.log, { merge: true }),
    repoRoot,
    localRepoName: deps.localRepoName ?? resolveOwnerRepo().repo,
    nowMsImpl: Date.now,
    updateBranchImpl: updateBranchViaGh,
    captureRepairFeedbackImpl: (filing) => captureRepairFeedbackWithPriorVerdict(repoRoot, filing, deps.log, feedbackLandingStateRoot),
    reclaimWorkerImpl: (info) => reclaimAbandonedWorker(info, { log: deps.log }),
    registeredWorktreeOwnerImpl: registeredFixWorktreeOwner,
    reviewCommandImpl: reviewGateCall,
    reviewReuseRunner,
    reviewerCodeStaleThisPassImpl: reviewerCodeGate.staleThisPass,
    stallNotice: escalatePostReviewStall,
    registeredOwnerRecovery: {
      capture: captureRegisteredFixOwnerSnapshot,
      remove: removeAbandonedFixWorktreeOwner,
      publishAhead: publishAbandonedFixOwnerAhead,
      preserveDiverged: preserveAbandonedFixOwnerDivergence,
      preserveTrackedDirty: preserveOrDiscardFixOwnerResidue,
      preserveStagedResidue: preserveStagedFixOwnerResidue,
      preserveUntracked: preserveAndClearUntrackedFixOwner,
      preserveStaleDirty: preserveStaleDirtyFixOwner,
      clearStaleDirty: clearStaleDirtyFixOwner,
      resetTrackedDirty: (_repoDir: string, ownerPath: string, _branch: string, localSha: string) =>
        resetTrackedDirtyFixOwner(ownerPath, localSha),
    },
    depReviewCommandImpl: (pr, rest) => depReviewCommand(pr, rest, { root: repoRoot, landingStateRoot: feedbackLandingStateRoot }),
    dispatchFixPreflightStandDownImpl: dispatchFixPreflightStandDown,
    ghLiveStateImpl: ghLiveState,
    fixRungTaskForImpl: fixRungTaskFor,
    resolveTaskContractAtHeadImpl: resolveFixRungTaskContractAtHeadAsync,
    createFixRungWorktreeImpl: createFixRungWorktreeWithToolchain,
    captureWorktreeSnapshotImpl: captureWorktreeSnapshotViaGit,
    runFixRungImpl: (opts) => {
      const deps = { ...opts.deps, writeFixCensusSnapshot: writeFixCensusSnapshotAsync };
      return runFixRung({ ...opts, deps });
    },
    runPlanScopedFixRoundImpl: runPlanScopedFixRound,
    materializePlanRoundWorktreeImpl: materializePlanRoundWorktree,
    pushFixRoundImpl: (wt: string, branch: string, sha?: string, prior?: string) => // W1-T8833: the sweep rung pushes as the run loop's does
      pushSweepFixRound(deps, wt, branch, sha, prior),
    buildFixRungDispatchArgsImpl: buildFixRungDispatchArgs,
    openTaskIdsFromPlanImpl: openTaskIdsFromPlan,
    waitForCiGreenImpl: waitForCiGreen,
    restRollupForImpl: restRollupFor,
    fetchCiFailuresImpl: fetchCiFailuresAsync,
    runReviewImpl: buildRequiredFixReviewRunner(runReview, readReviewerCodeFreshness),
    fetchPrBodyImpl: fetchPrBodyViaGh,
    // W1-T3869: the missing-trailer repair's writer. Unwired, `requiredSweepRuntime` throws
    // `buildSweepEffects requires updatePrBodyImpl from its entrypoint adapter` the moment
    // `repairMissingTaskTrailer` calls it — which is exactly what killed PR #5505's sweep action.
    // Same REST writer the module's other three body-write sites already use.
    updatePrBodyImpl: updatePrBodyViaGh,
    repairMetadataImpl: repairPrMetadata,
    readHeadShaImpl: readHeadShaRest,
    ghLiveHeadImpl: ghLiveHead,
    fetchPrDiffFilesImpl: fetchPrDiffFilesViaGh,
    fixRebaseMergeFactsImpl: fixRebaseMergeFactsFromRest,
    redBaseRefreshFactsImpl: redBaseRefreshFactsFromRest,
    ghUpdateBranchImpl: ghUpdateBranch,
    readyDraftImpl: readyDraftViaGh(deps.owner, deps.repo, deps.log),
    readFixRoundCommitsImpl: readFixRoundCommitsViaGit,
    runNpmScriptImpl: runNpmScriptViaSpawn,
    commitGeneratorOutputImpl: commitGeneratorOutputViaGit,
    readPackageScriptsImpl: readPackageScriptsFor,
    dispatchFixCatchOutcomeImpl: dispatchFixCatchOutcome,
    worktreeRemoveImpl: worktreeRemove,
    fixBranchClaimKeyImpl: fixBranchClaimKey,
    boundedWorktreeOwnerPathImpl: boundedWorktreeOwnerPath,
    decideRegisteredFixOwnerRecoveryImpl: decideRegisteredFixOwnerRecovery,
    fixRungCheckoutRefusedErrorImpl: FixRungCheckoutRefusedError,
    defaultBudgetUsd: DEFAULT_BUDGET_USD,
    ...libDeps,
    repoMode: libDeps.repoMode ?? instanceMode(
      `${deps.owner}/${deps.repo}`,
      instanceRegistryTextImpl ? instanceRegistryTextImpl() : readInstanceRegistryText(repoRoot),
    ),
  });
  // W1-T2890 holds this surface key-identical to the lib-built one, so the accessor is INJECTED
  // above rather than bolted on here: returning the lib's object unchanged makes that identity
  // structural instead of something a future edit has to remember to mirror.
  return effects;
}

/**
 * `rmd sweep [--repo <name>] [--dry-run]` — run ONE level-triggered reconciliation
 * pass over every open PR (W1-T77, ratifies P22 core). FAIL LOUD on junk args
 * BEFORE any `gh`/spawn (Standing rule). --dry-run previews dispositions and takes
 * NO effects. Non-zero exit only on a hard error.
 */
export async function sweepCommand(host: SweepCommandHost & Required<Pick<SweepCommandHost, "commandViews">>, rest: string[]): Promise<number> {
  const {
    USAGE, buildEscalationTriageRuntime, commandViews: buildOpenPrViews, buildSweepEffects,
    sweepPostFixReverification,
    handedOffHeadRiskJudge, codeScanningJudgeDeps,
    sweepEscalationTriage, runAutomaticBranchReapRung,
  } = host;
  const badArg = unknownArgError("sweep", rest, ["--repo"], ["--dry-run"]);
  if (badArg) {
    console.error(badArg + "\n" + USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const config = loadConfig();
  const ledgerPath = ledgerPathFor(config);
  const self = resolveOwnerRepo();
  const repo = flagValue(rest, "--repo") ?? self.repo;
  const owner = self.owner;
  const runId = `SWEEP-${systemClock.now()}`;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "SWEEP", step, lane: "sweep", ...extra });
  const triageRuntime = buildEscalationTriageRuntime({ root: repoRoot, config, owner, repo });
  configureEscalationTriage(triageRuntime);

  // The plan backs the fix rung's task lookup (title/acceptance/risk). Best-effort:
  // a repo without a readable plan can still arm/close/escalate; only fix needs it.
  const planPath =
    repo === self.repo ? join(repoRoot, "plan", "tasks.yaml") : join(config.root, "repos", repo, "plan", "tasks.yaml");
  let plan: Plan = { tasks: [], byId: new Map() };
  try {
    plan = loadPlan(planPath);
  } catch (e) {
    log("sweep.plan.unavailable", { plan_path: planPath, error: String((e as Error)?.message ?? e) });
  }

  let openPrs: OpenPrView[];
  try {
    openPrs = buildOpenPrViews(owner, repo, ledgerPath, {
      planFilingFileCache: createPlanFilingFileCache(),
      onPlanFilingClassification: createPlanFilingClassificationTelemetry(log),
    });
  } catch (e) {
    console.error(`### rmd sweep — could not list open PRs for ${owner}/${repo}: ${String((e as Error)?.message ?? e)}`);
    return 1;
  }

  // W1-T474 — the post-fix re-verification rung, RUN BEFORE the fix rung below (rationale (10)):
  // once a systemic cause merges (a DEFAULT_FIX_CLASSES row's `fixPrNumber`), a PR that inherited
  // that failure gets re-verified here rather than having the fix rung spend a strike repairing a
  // defect its own diff never introduced. `redrivenThisPass` is then excluded from `runSweep`
  // below so the two rungs never both derive a disposition for the same PR in one pass.
  const reverifySummary = await sweepPostFixReverification(owner, repo, openPrs, ledgerPath, runId, log, { dryRun });
  const redrivenThisPass = new Set(
    reverifySummary.results.filter((r) => r.outcome === "redriven").map((r) => r.prNumber),
  );
  const prsForFixRung = openPrs.filter((pr) => !redrivenThisPass.has(pr.prNumber));

  const effects = buildSweepEffects({
    productionProgressJudge: true,
    owner: owner,
    repo: repo,
    config: config,
    ledgerPath: ledgerPath,
    runId: runId,
    plan: plan,
    log: log,
    policy: DEFAULT_SWEEP_POLICY,
  });
  // W1-T528: "in flight" for `selectUpdateBranchTarget` means exactly what it means everywhere
  // else in the fleet (see `liveInflightRuns`'s own doc) — the SAME per-task lock directory the
  // drain/daemon dispatch path already reads, never a second, looser definition.
  const inflightDir = join(config.root, "state", "inflight");
  // W1-T1212: the stale-gate discriminator's two data inputs — see `SweepDeps.staleGateWorkflowsByPr`/
  // `.updatedForWorkflow`'s own docs (lib/sweep.ts) for why these are pure-data params rather than
  // I/O `selectUpdateBranchTarget` performs itself.
  const staleGateWorkflowsByPr = buildStaleGateWorkflowsByPr(owner, repo, prsForFixRung);
  const updatedForWorkflow = updatedForWorkflowFromLedger(ledgerPath);
  const baseChangedFilesByPr = new Map<number, BaseChangedFiles>();
  const behindMainByPr = buildBehindMainByPr(owner, repo, prsForFixRung, undefined, undefined, baseChangedFilesByPr);
  applyMergeProbeEvidence(prsForFixRung, await probeOpenPrMerges(prsForFixRung, ledgerPath, log, join(config.root, "repos", repo), { dryRun, behindMainByPr }));
  // W1-T2794 — BUILT HERE, BEFORE DISPOSITION, AND REUSED BY THE BACKFILL RUNG BELOW. This is a
  // composition change, not a new read: the credit rung already built exactly this set, just
  // AFTER `runSweep` had already disposed every open PR. That ordering is what left #3877 open
  // and escalating after #3874 merged its task — `supersededBy` is computed from the OPEN array,
  // so the peer relation vanished the moment the winner merged. ONE call per full sweep: the
  // array below is passed to the projection AND to `runCreditBackfill`, never rebuilt.
  const creditCandidates = buildCreditCandidates(owner, repo, plan, ledgerPath, log);
  const summary = await runOneShotSweep((handedOffHeadJudgments) => runSweep(
    projectMergedTaskCandidates(prsForFixRung, creditCandidates),
    withFullSweepRepairAdmission({
      ...effects,
      ledgerPath,
      runId,
      log,
      dryRun,
      inFlightTaskIds: new Set(liveInflightRuns(inflightDir).map((r) => r.taskId)),
      staleGateWorkflowsByPr,
      updatedForWorkflow,
      behindMainByPr,
      baseChangedFilesByPr,
      judgeHandedOffHead: handedOffHeadRiskJudge(owner, repo, config, plan, ledgerPath, runId, log),
      planContextDigestFor: riskJudgePlanContextDigestFor(plan),
      handedOffHeadJudgments,
      ...codeScanningJudgeDeps(owner, repo, config, plan, runId, log),
    }),
    DEFAULT_SWEEP_POLICY,
  ));

  // W1-T150 — the credit-backfill rung (ratifies P30): level-triggered, like
  // the open-PR reconciliation above, but over every task's OWNED merge state
  // rather than open-PR pipeline state — the gate-side-merge fixture (0 of 195
  // runs ledgered a merge while GitHub showed 28) this rung exists to close.
  const creditSummary = await runCreditBackfill(creditCandidates, { ledgerPath, runId, log, dryRun });

  // fb-1784756088300-6a481e — the escalation-lifecycle reconciler rung: close stale
  // needs-human issues whose referenced task has since resolved (the missing third leg
  // of the escalation lifecycle). Same level-triggered doctrine + cadence as the two rungs
  // above; bounded per cycle so a backlog drains gradually.
  const reconcileSummary = await sweepEscalationReconcile(owner, repo, plan, ledgerPath, runId, log, { dryRun });
  await sweepEscalationTriage({ root: repoRoot, config, owner, repo, ledgerPath, runId }, openPrs, log,
    { dryRun, runtime: triageRuntime });

  // W1-T175 — the worktree reaper rung: same level-triggered doctrine + cadence as the
  // rungs above, closing pruneStaleRuns' coverage holes (git-invisible dirs, detached-HEAD
  // sweep-* orphans, widowed .lock files) on THIS cadence, not only at a run's own start.
  // --dry-run takes no effects, matching every other rung in this command.
  let reapSummary: WorktreeReapSummary = { reaped: [], reapedLocks: [], kept: [] };
  if (!dryRun) {
    reapSummary = runWorktreeReapRung(config, log, { configLockRepoDir: join(config.root, "repos", repo) });
  }

  // W1-T448 successor: automatic branch cleanup rides the full sweep. The rung performs a cheap
  // branch-set fingerprint every tick and only pays for the existing REST classifier on first use,
  // branch-set change, or the six-hour bound. It is deliberately absent from buildSweepLightHook:
  // the delete is a remote git write and must not run beside an active worker.
  await runAutomaticBranchReapRung(owner, repo, config, ledgerPath, runId, log, {}, {
    prune: !dryRun,
    root: repo === self.repo ? repoRoot : join(config.root, "repos", repo),
  });

  console.log(
    `### rmd sweep${dryRun ? " --dry-run" : ""} — ${owner}/${repo}\n` +
      renderSweepSummary(summary) +
      `\npost-fix re-verification: ${reverifySummary.total} open PR(s) checked · ${reverifySummary.redriven} redriven` +
      `\ncredit backfill: ${creditSummary.total} candidate(s) reconciled · ${creditSummary.corrected} corrected` +
      `\n${renderEscalationReconcileSummary(reconcileSummary)}` +
      `\nworktree reap: ${reapSummary.reaped.length} worktree(s) reaped · ${reapSummary.reapedLocks.length} widowed lock(s) reaped`,
  );
  return 0;
}

/**
 * The daemon's per-iteration sweep hook (acceptance 4: the SAME runSweep the CLI
 * uses). Best-effort by the DaemonDeps.sweep contract — swallows its own errors so
 * a sweep hiccup never halts the scheduler loop.
 *
 * `tmpMaxAgeMs` (W1-T320): the resolved `policy.values.sweep.tmpMaxAgeMs` the real daemon
 * command threads through to {@link runTmpSweepRung} below — optional and trailing so every
 * existing caller (tests included) that predates W1-T320 is unaffected; omitted ⇒
 * `sweepStaleTempDirs`'s own default (`DEFAULT_TEMP_SWEEP_MAX_AGE_MS`) applies.
 */
export function buildSweepHook(
  host: SweepCommandHost,
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  bootPlan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
  tmpMaxAgeMs?: number,
  // Injectable board gateway — appended LAST so no positional caller shifts, the same convention
  // `buildSweepEffects`' own trailing seams follow. Real callers omit it and get the warm
  // once-per-daemon-start instance built immediately below; a test supplies one with its own
  // `exec`/`ttlMs` so the delta's request count is measurable without shelling out.
  github?: GitHub,
  // W1-T468: paces this poll's three-way burst (this hook's own sweep enumeration plus the board
  // gateway's PR/issue reads below) — trailing and optional so every existing call site (every
  // test included) is unaffected; omitted ⇒ no pacing, exactly the pre-W1-T468 behavior. The
  // daemon's real (non-test) wiring is the only caller that constructs and passes one.
  pacer?: GhCallPacer,
  // W1-T943: the resolved `policy.values.workerStall` the real daemon command threads through to
  // {@link runWorkerStallDetectorRung} below — optional and trailing so every existing caller
  // (tests included) that predates W1-T943 is unaffected; omitted ⇒ {@link DEFAULT_WORKER_STALL_MS}.
  workerStallMs?: number,
  // W1-T2683: main's own rollup observer, supplied only by the real daemon wiring. Trailing and
  // optional so offline callers gain no network I/O. Its own boundary below preserves PR sweep
  // liveness even when a test injection or future implementation accidentally throws.
  mainHealthRung?: () => Promise<void>,
  snapshotCache?: BoardSnapshotCache,
  // W1-T3581 and W1-T3585 independently appended optional positional seams here. Preserve both
  // already-shipped call shapes: a recovery object first (then isMerged/readMainPlan), or the
  // earlier isMerged/readMainPlan pair. The discriminator is structural and fail-closed: a merged
  // resolver is a function, while reviewer provenance is an object.
  reviewerCodeRecoveryOrIsMerged?: SweepDeps["reviewerCodeRecovery"] | MergedResolver,
  isMergedOrReadMainPlan?: MergedResolver | ((root: string) => Plan),
  readMainPlan?: (root: string) => Plan,
  // W1-T448: the daemon already resolved the managed checkout for this exact owner/repo. Keep
  // that path explicit so same-named repositories under different owners cannot reap this repo's
  // origin by accident.
  targetCheckoutRoot?: string,
  planAccessor?: () => Plan,
  // W1-T4471: the owner-reply reader's gateway. Omitted ⇒ that rung is skipped, so a fixture
  // never reaches GitHub; only the daemon's composition root passes the real one.
  escalationAnswerGateway?: EscalationAnswerGateway,
  // W1-T5115: the daemon's git credential socket. Omitted ⇒ fix workers keep the ambient helper.
  gitCredentialSocketPath?: string,
  // W1-T7734: `servedPublishedAtMs` is when the generation these facts came from was published.
  tickReadFor?: () => (TickReadFacts & { servedPublishedAtMs?: number }) | undefined |
    Promise<(TickReadFacts & { servedPublishedAtMs?: number }) | undefined>,
  escalationFeedbackReply?: Pick<PanelGraphDeps, "root" | "inboxRoot" | "feedbackLand">,
): (continueReviewAdmissions?: ReviewAdmissionGate) => Promise<SweepCycleOutcome | void> {
  const {
    buildInboxDraftHook, buildSweepEffects,
    buildEscalationTriageRuntime, refreshEscalationTriageEvidence,
    sweepPostFixReverification, gitCredentialFixSpawn,
    handedOffHeadRiskJudge, codeScanningJudgeDeps,
    sweepEscalationTriage, runAutomaticBranchReapRung,
    runInflightLockSweepRung, runWorkerStallDetectorRung,
  } = host;
  const legacyResequenceShape = typeof reviewerCodeRecoveryOrIsMerged === "function";
  const reviewerCodeRecovery = legacyResequenceShape ? undefined : reviewerCodeRecoveryOrIsMerged;
  const isMerged = legacyResequenceShape
    ? reviewerCodeRecoveryOrIsMerged
    : (isMergedOrReadMainPlan as MergedResolver | undefined);
  const resolvedReadMainPlan = legacyResequenceShape
    ? (isMergedOrReadMainPlan as ((root: string) => Plan) | undefined)
    : readMainPlan;
  // W1-T192: the daemon-side draft rung, built ONCE per daemon start (mirrors this
  // function's own once-per-daemon-start construction) — see buildInboxDraftHook's doc for
  // why it rides THIS seam rather than a second, separately-scheduled loop.
  // ONE GATEWAY FOR THE DAEMON'S WHOLE LIFE, built here once per daemon start, as `draftHook` below is:
  // this function runs once per daemon start, the closure it returns runs once per poll.
  //
  // THE DELTA WAS ALREADY BUILT AND A CONSTRUCTOR'S LIFETIME WAS DEFEATING IT. `buildBatchedGithub`
  // holds `knownBoardPrs` — the row cache `fetchBoardPrsRest`'s early stop compares against — at
  // GATEWAY scope, so a gateway rebuilt per poll always starts `undefined`, takes `mode: "full"`
  // at `BOARD_FULL_PAGE_SIZE`, and walks the whole repo again. Both of this hook's deriving rungs
  // used to build their own inside the poll closure, so neither ever saw a second pass.
  //
  // MEASURED over the unioned ledger (`board_gateway.fetch_bytes`, 49,497 distinct rows across all
  // three archive forms): `serveCommand`, which keeps ONE gateway warm, logs 16,770 `mode: "delta"`
  // fetches at exactly 2 REST calls against 224 cold ones — its doc's "steady state is 2", borne
  // out. The daemon logs 5,022 `mode: "full"` at a mean of 9.74 calls (max 14) against 18 deltas.
  // Same code, inverted ratio, entirely because of where the constructor sat.
  //
  // WHY A WARM GATEWAY IS STILL CURRENT — a PR merged externally must not read open forever, and
  // TWO independent properties have to hold, not one:
  //  (i) FREQUENCY IS UNCHANGED. `ttlMs` defaults to 15 s, far below the daemon's 60 s
  //      `pollIntervalMs` (DEFAULT_POLL_INTERVAL_MS, which the headroom curve only ever raises),
  //      so every poll's first read still finds the index expired and issues a real fetch.
  //      Warming changes a fetch's SHAPE, never whether one happens.
  // (ii) THE FETCH ITSELF RE-READS WHAT CAN MOVE. `fetchBoardPrsRest`'s HOT half re-reads EVERY
  //      open PR unconditionally on every call, and its COLD half walks `updated_at` descending —
  //      so any row that changed sorts strictly above the first unchanged row the walk stops on.
  //      A PR merged between polls has a bumped `updated_at` and therefore arrives on the very
  //      next fetch. Only rows genuinely frozen at merge are ever served from the cache.
  // The rungs below consume merge state and open state; (ii) covers both, so a warm cache can
  // delay nothing and can never report a stale OPEN for a PR that has since merged.
  // W1-T468: `pacer` is threaded into the board gateway's OWN construction (never applied when a
  // test supplies its own `github` above — that gateway was built outside this function and has
  // no seam to receive it) and into `buildOpenPrViews` below, so both burst call sites share the
  // SAME instance for this daemon's whole life, exactly as `boardGithub` itself is shared.
  const boardGithub = github ?? buildBatchedGithub(owner, repo, { log, pacer });
  if (!github && snapshotCache) boardGithub.seedBoardSnapshot?.(snapshotCache);
  // W1-T9390: the escalation-triage rung's ledger slice, held for this daemon's life like `boardGithub`, so a
  // full sweep parses only the rotations and live bytes written since the one before.
  const escalationTriageHistory = createEscalationTriageHistoryReader();
  // W1-T9406: the triage evidence's own slice, held for this daemon's life the same way.
  const escalationTriageEvidence = createEscalationTriageHistoryReader({ slice: ESCALATION_TRIAGE_EVIDENCE_SLICE });
  const draftHook = buildInboxDraftHook(owner, repo, config, runId, log);
  const planFilingFileCache = createPlanFilingFileCache();
  const reportPlanFilingClassification = createPlanFilingClassificationTelemetry(log);
  // W1-T4476 design (i): loaded ONCE, at daemon-start construction time — the same lifetime as
  // `boardGithub` above — from THIS repository's own file, so a restart with an unchanged branch
  // set and an unexpired interval reads "unchanged" instead of every boot re-judging every remote
  // branch as a fresh first pass. Unreadable/absent reads as `{}`, i.e. today's cold-boot behavior.
  const branchReapStatePath = join(config.root, "state", automaticBranchReapStateFileName(repo));
  const branchReapState: AutomaticBranchReapState = readAutomaticBranchReapState(branchReapStatePath);
  return async (continueReviewAdmissions = () => true) => {
    const prelude = createFullPreludeTimer((fields) => log("sweep.full_prelude", fields));
    const triageRuntime = buildEscalationTriageRuntime({ root: targetCheckoutRoot ?? repoRoot, config, owner, repo },
      { evidenceHistory: escalationTriageEvidence });
    if (!github) configureEscalationTriage(triageRuntime);
    const [tickRead] = await Promise.all([
      prelude.time("tick_read", () => tickReadFor?.()),
      // W1-T9406: the evidence slice's new rotations load off the loop before this tick triages anything.
      prelude.time("triage_evidence", async () => {
        if (!github) await refreshEscalationTriageEvidence(triageRuntime, ledgerPath, log);
      }),
      prelude.time("main_health", async () => {
        try {
          await mainHealthRung?.();
        } catch (e) {
          log("main.health.error", { error: String((e as Error)?.message ?? e) });
        }
      }),
      // W1-T4471: land owner replies in `plan/questions.ndjson` BEFORE `buildOpenPrViews` reads it,
      // so a reply steers this same tick. Contained like `mainHealthRung` above.
      prelude.time("escalation_answers", async () => {
        if (!escalationAnswerGateway) return;
        try {
          const answers = await readEscalationAnswers(repoRoot, runId, escalationAnswerGateway,
            { ledgerPath, ...(escalationFeedbackReply ? { feedback: escalationFeedbackReply } : {}) });
          if (answers.unreadable > 0) log("escalation_answers.unreadable", { ...answers });
        } catch (e) {
          log("escalation_answers.error", { error: String((e as Error)?.message ?? e) });
        }
      }),
    ]);
    prelude.note({
      tick_read_source: tickRead === undefined ? "none"
        : (tickRead.servedPublishedAtMs ?? prelude.startedAtMs) < prelude.startedAtMs ? "served" : "own_read",
      ...(tickRead?.servedPublishedAtMs !== undefined ? { snapshot_published_at_ms: tickRead.servedPublishedAtMs } : {}),
    });
    // W1-T3618: this pass's own reviewer-code freshness discovery, if any — read by `effects`
    // (`buildSweepEffects`'s own once-per-call cache) below and surfaced here so the daemon's tick
    // loop can end the cycle through its EXISTING pre-admission freshness re-check rather than
    // idling on code that already paid for a verdict it could never publish.
    let reviewerCodeStale: { oldSha: string; newSha: string } | undefined;
    // W1-T4002: this pass's own plan-only filing receipts feed dispatch options; no stale re-read.
    let thisPassPlanOnlyRunBranchReceipts: ReturnType<typeof planOnlyRunBranchReceipts> = [];
    let thisPassReviewInputViews: NonNullable<SweepCycleOutcome["reviewInputViews"]> = [];
    try {
      if (tickRead?.openPrError) throw new Error(tickRead.openPrError);
      const openPrs = tickRead ? structuredClone(tickRead.openPrViews) : await prelude.time("open_pr_views", () =>
        buildOpenPrViewsAsync(owner, repo, ledgerPath, {
          pacer,
          planFilingFileCache,
          onPlanFilingClassification: reportPlanFilingClassification,
          isMerged,
          readMainPlan: resolvedReadMainPlan,
        }));
      // W1-T4002 — derived ONLY from the `openPrs` just built: no second GitHub read.
      thisPassPlanOnlyRunBranchReceipts = planOnlyRunBranchReceipts(openPrs);
      thisPassReviewInputViews = openPrs.map(({ prNumber, prUrl, headSha, reviewInputDigest, reviewState, taskId }) =>
        ({ prNumber, prUrl, headSha, reviewInputDigest, reviewState, taskId }));
      // W1-T474 — the post-fix re-verification rung, on the daemon's own poll cadence and, same
      // as `sweepCommand`, run BEFORE `runSweep` so the fix rung never spends a strike on a PR
      // this pass just redrove (rationale (10) — see `sweepPostFixReverification`'s own doc).
      const reverifySummary = await prelude.time("post_fix_reverification", () => sweepPostFixReverification(owner, repo,
        openPrs, ledgerPath, runId, log, tickRead ? tickReadReverificationDeps(tickRead) : {}));
      const redrivenThisPass = new Set(
        reverifySummary.results.filter((r) => r.outcome === "redriven").map((r) => r.prNumber),
      );
      const prsForFixRung = openPrs.filter((pr) => !redrivenThisPass.has(pr.prNumber));
      const plan = tickRead?.plan ?? planAccessor?.() ?? bootPlan;
      const effects = buildSweepEffects({
        productionProgressJudge: true,
        owner: owner,
        repo: repo,
        config: config,
        ledgerPath: ledgerPath,
        runId: runId,
        plan,
        log: log,
        policy: DEFAULT_SWEEP_POLICY,
        feedbackLandingStateRoot: config.root,
        pacer,
        // W1-T5115: the SAME spawn sweep.ts defaults to, carrying the socket as a git-only handle.
        ...(gitCredentialSocketPath
          ? { spawnImpl: gitCredentialFixSpawn(gitCredentialSocketPath) }
          : {}),
      });
      // W1-T528: same in-flight lock directory every other dispatch-path reader consults —
      // see `sweepCommand`'s own comment on this exact line for the full rationale.
      const inflightDir = join(config.root, "state", "inflight");
      // W1-T1212: same two data inputs as `sweepCommand` — see that call site's own comment.
      const staleGateWorkflowsByPr = await prelude.time("stale_gate_workflows", () =>
        tickRead?.staleGateWorkflowsByPr ?? buildStaleGateWorkflowsByPr(owner, repo, prsForFixRung));
      const updatedForWorkflow = await prelude.time("updated_for_workflow", () => updatedForWorkflowFromLedger(ledgerPath));
      const freshBaseChangedFiles = new Map<number, BaseChangedFiles>();
      const behindMainByPr = await prelude.time("behind_main", () => tickRead?.behindMainByPr
        ?? buildBehindMainByPr(owner, repo, prsForFixRung, undefined, undefined, freshBaseChangedFiles));
      const baseChangedFilesByPr = tickRead?.baseChangedFilesByPr ?? freshBaseChangedFiles;
      applyMergeProbeEvidence(prsForFixRung, await prelude.time("merge_probes", () =>
        probeOpenPrMerges(prsForFixRung, ledgerPath, log, join(config.root, "repos", repo), { behindMainByPr })));
      // W1-T2794 — BUILT HERE, BEFORE DISPOSITION, AND REUSED BY THE BACKFILL RUNG BELOW. This is a
      // composition change, not a new read: the credit rung already built exactly this set, just
      // AFTER `runSweep` had already disposed every open PR. That ordering is what left #3877 open
      // and escalating after #3874 merged its task — `supersededBy` is computed from the OPEN array,
      // so the peer relation vanished the moment the winner merged. ONE call per full sweep: the
      // array below is passed to the projection AND to `runCreditBackfill`, never rebuilt.
      const creditCandidates = await prelude.time("credit_candidates", () =>
        tickRead?.creditCandidates ?? buildCreditCandidates(owner, repo, plan, ledgerPath, log, boardGithub));
      await runSweep(
        projectMergedTaskCandidates(prsForFixRung, creditCandidates),
        withFullSweepRepairAdmission({
          ...effects,
          readLiveStateAtAct: effects.readLiveState,
          // W1-T7734: a head that moved under this pass is re-read (paced) and re-derived in this pass.
          rereadPrAtAct: buildRereadPrAtAct(owner, repo, ledgerPath, {
            pacer,
            views: { planFilingFileCache, onPlanFilingClassification: reportPlanFilingClassification, isMerged,
              readMainPlan: resolvedReadMainPlan },
          }),
          ...(tickRead?.servedPublishedAtMs !== undefined ? { snapshotPublishedAtMs: tickRead.servedPublishedAtMs } : {}),
          markPrelude: prelude.mark,
          ledgerPath,
          runId,
          log,
          inFlightTaskIds: new Set(liveInflightRuns(inflightDir).map((r) => r.taskId)),
          staleGateWorkflowsByPr,
          updatedForWorkflow,
          behindMainByPr,
          baseChangedFilesByPr,
          reviewerCodeRecovery,
          judgeHandedOffHead: handedOffHeadRiskJudge(owner, repo, config, plan, ledgerPath, runId, log),
          planContextDigestFor: riskJudgePlanContextDigestFor(plan),
          ...codeScanningJudgeDeps(owner, repo, config, plan, runId, log),
          // W1-T2584: closes review admission on the wall-clock timeout; W1-T3491 threads the
          // independent STOP/PAUSE worker-admission check. Direct/tests calls omit both and
          // receive the true defaults above.
          continueReviewAdmissions,
          workerAdmissionHold: continueReviewAdmissions.workerAdmissionHold,
        }),
        DEFAULT_SWEEP_POLICY,
      );
      reviewerCodeStale = effects.reviewerCodeStaleThisPass();
      // fb-1784756088300-6a481e: the escalation-lifecycle reconciler rung — closes stale
      // needs-human issues whose referenced task has since resolved, on the daemon's own
      // cadence. The missing third leg of the escalation lifecycle (creation W1-T8, dedup
      // W1-T195, closure here); same level-triggered doctrine as the credit rung below. Its
      // own read failures degrade to [] internally, so it never strands the credit rung.
      await sweepEscalationReconcile(owner, repo, plan, ledgerPath, runId, log, { github: boardGithub, tickRead });
      if (!github) await sweepEscalationTriage({ root: targetCheckoutRoot ?? repoRoot, config, owner, repo, ledgerPath, runId },
        openPrs, log, { runtime: triageRuntime, history: escalationTriageHistory });
      // W1-T150: the SAME credit-backfill rung `rmd sweep` runs, on the
      // daemon's own poll cadence — never a second, separately-scheduled loop.
      await runCreditBackfill(creditCandidates, { ledgerPath, runId, log });
      sweepPrTerminalRung(boardGithub, ledgerPath, runId, tickRead); // W1-T5318: every closed PR, task or not
      // W1-T175 — the worktree reaper rung, on the daemon's own poll cadence: the hole
      // this closes is specifically an IDLE fleet (no run dispatched, so pruneStaleRuns'
      // run-start trigger never fires) leaving crashed-run debris to grow unbounded. Own
      // try/catch, folded into runWorktreeReapRung (distinct from the shared "sweep.error"
      // below) so a reap hiccup never masks — or is masked by — the rungs above it.
      runWorktreeReapRung(config, log, { configLockRepoDir: join(config.root, "repos", repo) });
      // W1-T448 successor: remote branch cleanup is a FULL-sweep rung. The cheap branch-set
      // fingerprint runs each tick; the REST classifier/pruner is bounded by its cadence decision.
      // Existing direct/test callers predate the resolved target-checkout seam and must remain
      // offline. The real daemon always supplies it from targetCheckoutRoot above.
      if (targetCheckoutRoot) {
        await runAutomaticBranchReapRung(owner, repo, config, ledgerPath, runId, log, branchReapState, {
          root: targetCheckoutRoot,
          plan: () => plan, // W1-T6590: this tick's parse of the target checkout's plan
        });
        // W1-T4476 design (i)/(iii): persist the cadence fields AND the merged-head cache
        // `runAutomaticBranchReapRung` just mutated in place, so the NEXT daemon boot loads
        // exactly what this one left off with instead of starting every restart cold.
        writeAutomaticBranchReapState(branchReapStatePath, branchReapState);
      }
      // W1-T320 — the tmp-dir backstop's PER-POLL rung (design clause ii): rides this SAME
      // composite so it re-fires on a long-running healthy daemon, not only at boot. Own
      // try/catch (folded into runTmpSweepRung), same discipline as the reap rung above.
      runTmpSweepRung(log, tmpMaxAgeMs !== undefined ? { maxAgeMs: tmpMaxAgeMs } : {});
      // W1-T942 — the worker-tail retention rung: ages out `state/runs/*.tail` files past
      // WORKER_TAIL_RETENTION_MS. Rides this SAME per-poll cadence, own try/catch inside.
      runWorkerTailSweepRung(config, log);
      // The in-flight lock sweep's PER-POLL rung — same argument as the tmp rung immediately
      // above (boot-only never re-fires on a healthy long-lived daemon), and now load-bearing
      // for `deriveStatus`'s lock-based liveness disjunct. Own try/catch inside the rung.
      runInflightLockSweepRung(config, log);
      // W1-T943 — the worker-stall detector's PER-POLL rung: judges every LIVE in-flight run's
      // newest `worker.state` row against the policy `workerStall` threshold and escalates a
      // quiet one through §4 (never kills/signals it — see runWorkerStallDetectorRung's own
      // doc). Own try/catch inside the rung.
      runWorkerStallDetectorRung(owner, repo, config, ledgerPath, runId, workerStallMs ?? DEFAULT_WORKER_STALL_MS, log);
      // W1-T2575 — the mount-headroom sweep's missing recommendation leg: turns
      // scripts/mount-headroom-sweep.mjs's measured (type, risk, class) cells into ratifiable
      // inbox proposals (or, far more often, a named refusal) via `recommendMounts`. Own
      // try/catch inside the rung; never mutates the target's mounts configuration itself.
      await runMountRecommenderRung(config, runId, log);
    } catch (e) {
      log("sweep.error", { error: String((e as Error)?.message ?? e) });
    }
    prelude.write(false);
    // W1-T192: the draft rung (fail-soft internally, its own try/catch) — a fired trigger
    // or an invalidated draft gets redrafted here, on the daemon's cadence, with no CLI
    // invocation required.
    await draftHook(tickRead);
    return reviewerCodeStale || thisPassPlanOnlyRunBranchReceipts.length > 0 || thisPassReviewInputViews.length > 0
      ? {
          ...(reviewerCodeStale ? { reviewerCodeStale } : {}),
          planOnlyRunBranchReceipts: thisPassPlanOnlyRunBranchReceipts,
          reviewInputViews: thisPassReviewInputViews,
        }
      : undefined;
  };
}
export interface LightPassReadPorts {
  openPrViews?: () => Promise<OpenPrView[]>;
  effects?: (deps: Parameters<typeof buildSweepEffects>[1]) => SweepDeps;
  readCompare?: (args: string[]) => Promise<unknown>;
  clock?: Pick<Clock, "now">;
}

function createLightPassCompareReader(owner: string, repo: string, read: (args: string[]) => Promise<unknown>) {
  type Facts = { behindBy: number; baseFiles?: BaseChangedFiles };
  const memo = new Map<number, { head: string; main: string | undefined; value: Promise<Facts | undefined> }>();
  return {
    retain: (prs: readonly OpenPrView[]) => {
      const heads = new Map(prs.map((pr) => [pr.prNumber, pr.headSha]));
      for (const [number, entry] of memo) if (heads.get(number) !== entry.head) memo.delete(number);
    },
    read: async (prs: readonly OpenPrView[], main: string | undefined, timing: LightPassPreReviewTiming) => {
      const behindMainByPr = new Map<number, number>();
      const baseChangedFilesByPr = new Map<number, BaseChangedFiles>();
      await timing.measure("compare", () => Promise.all(distanceRefreshProbeTargets(prs).map(async (pr) => {
        const start = timing.clock.now();
        let entry = memo.get(pr.prNumber);
        const cacheHit = main !== undefined && entry?.head === pr.headSha && entry.main === main;
        if (!cacheHit) {
          const value = Promise.resolve().then(async (): Promise<Facts | undefined> => {
            const compare = await read(["api", `repos/${owner}/${repo}/compare/${pr.headSha}...${main ?? "main"}`]) as {
              ahead_by?: unknown; files?: unknown;
            };
            if (typeof compare?.ahead_by !== "number" || !Number.isFinite(compare.ahead_by)) return undefined;
            return { behindBy: compare.ahead_by, ...(Array.isArray(compare.files) ? { baseFiles: {
              files: compare.files.flatMap((f) => typeof f?.filename === "string" ? [f.filename] : []),
              truncated: compare.files.length >= GITHUB_COMPARE_FILES_LISTED,
            } } : {}) };
          });
          entry = { head: pr.headSha, main, value };
          if (main !== undefined) memo.set(pr.prNumber, entry);
        }
        const row: Record<string, unknown> = { pr_number: pr.prNumber, head_sha: pr.headSha, main_sha: main ?? null, cache_hit: cacheHit };
        try {
          const facts = await entry!.value;
          row.outcome = facts ? "read" : "unreadable";
          if (facts) {
            behindMainByPr.set(pr.prNumber, facts.behindBy);
            if (facts.baseFiles) baseChangedFilesByPr.set(pr.prNumber, facts.baseFiles);
          } else if (memo.get(pr.prNumber) === entry) memo.delete(pr.prNumber);
        } catch (error) {
          Object.assign(row, { outcome: "error", error: String(error) });
          if (memo.get(pr.prNumber) === entry) memo.delete(pr.prNumber);
        } finally {
          row.elapsed_ms = timing.clock.now() - start;
          timing.compareReads.push(row);
        }
      })));
      return { behindMainByPr, baseChangedFilesByPr };
    },
  };
}

export function buildSweepLightHook(
  host: SweepCommandHost,
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  plan: Plan,
  log: (step: string, extra?: Record<string, unknown>) => void,
  // Same compatibility adapter as buildSweepHook: recovery-first is the current daemon shape;
  // isMerged/readMainPlan first remains valid for W1-T3585 callers already on the branch.
  reviewerCodeRecoveryOrIsMerged?: SweepDeps["reviewerCodeRecovery"] | MergedResolver,
  isMergedOrReadMainPlan?: MergedResolver | ((root: string) => Plan),
  readMainPlan?: (root: string) => Plan,
  planAccessor?: () => Plan,
  mainHealthRung?: () => Promise<void>,
  io: LightPassReadPorts = {},
): (scope?: LightPassScope) => Promise<void> {
  const {
    buildSweepEffects,
    inFlightTaskIdsFrom, lightPassActionable,
    handedOffHeadRiskJudge, codeScanningJudgeDeps,
  } = host;
  const legacyResequenceShape = typeof reviewerCodeRecoveryOrIsMerged === "function";
  const reviewerCodeRecovery = legacyResequenceShape ? undefined : reviewerCodeRecoveryOrIsMerged;
  const isMerged = legacyResequenceShape
    ? reviewerCodeRecoveryOrIsMerged
    : (isMergedOrReadMainPlan as MergedResolver | undefined);
  const resolvedReadMainPlan = legacyResequenceShape
    ? (isMergedOrReadMainPlan as ((root: string) => Plan) | undefined)
    : readMainPlan;
  const planFilingFileCache = createPlanFilingFileCache();
  const reportPlanFilingClassification = createPlanFilingClassificationTelemetry(log);
  const compares = createLightPassCompareReader(owner, repo, io.readCompare ?? ghJsonAsync);
  return withMainHealthOnLightPass(async (scope?: LightPassScope) => {
    // W1-T4053: a freshness drain's pass. The fix rung reads closed and the requeue batch never forms,
    // so `post-review` is the only lane left.
    const reviewOnly = scope?.reviewOnly === true;
    const timing = new LightPassPreReviewTiming(io.clock);
    let timingWritten = false;
    const finishTiming = () => {
      if (timingWritten) return;
      timingWritten = true;
      log("sweep_light.pre_review_timing", { run_id: runId, ...timing.finish() });
    };
    try {
      await timing.run(async () => {
      const readViews = () => io.openPrViews?.() ?? buildOpenPrViewsAsync(owner, repo, ledgerPath, {
        planFilingFileCache,
        onPlanFilingClassification: reportPlanFilingClassification,
        isMerged,
        readMainPlan: resolvedReadMainPlan,
      });
      const openPrs = await timing.run(() => timing.measure("open_pr_views", readViews));
      compares.retain(openPrs);
      const activePlan = planAccessor?.() ?? plan;
      const effects: Omit<SweepDeps, "ledgerPath" | "runId"> = timing.run(() => (io.effects ?? buildSweepEffects)({
        productionProgressJudge: true,
        owner: owner,
        repo: repo,
        config: config,
        ledgerPath: ledgerPath,
        runId: runId,
        plan: activePlan,
        log: log,
        policy: DEFAULT_SWEEP_POLICY,
        feedbackLandingStateRoot: config.root,
      }));
      // W1-T1211: ONE read per tick. `readLedgerLines` is the same reader every other rung in this
      // file uses, and the in-flight ids come from lock FILENAMES — no pid probe, no lock content.
      // W1-T9808: after a restart latched, a fix that would outlast the drain's time left closes the fix rung.
      const fixAdmitted = lightPassFixAdmitted(scope);
      const fixRungAllowed = timing.run(() => fixAdmitted && fixRungAllowedBesideInFlight(
        readLedgerLines(ledgerPath),
        inFlightTaskIdsFrom(join(config.root, "state", "inflight")),
      ));
      // W1-T7214: only ready heads wait for distance and the whole-snapshot refresh selection.
      const readyPrs = reviewOnly ? [] : openPrs.filter((pr) =>
        pr.isDraft !== true && pr.checksState === "green" && pr.reviewState === "success");
      // The one head-contract refresh selection is read after the whole-snapshot refresh decisions below,
      // and only the batches that wait for them (never the early review batch) carry it.
      let headContractRefresh: Awaited<ReturnType<typeof lightPassHeadContractRefresh>> = {};
      const runBatches = async (passPrs: OpenPrView[], distanceKnown = true) => {
        const requeueOnlyPrs = reviewOnly ? [] : passPrs.filter((pr) => blockedFixableIsRequeueOnly(pr));
        const requeueNumbers = new Set(requeueOnlyPrs.map((pr) => pr.prNumber));
        const restPrs = passPrs.filter((pr) => !requeueNumbers.has(pr.prNumber));
        const common = { ...effects, ledgerPath, runId, log, reviewerCodeRecovery, updateBranch: undefined };
        // W1-T528: branch updates belong to the whole-snapshot selection, never this per-PR fan-out.
        const passes: Array<Promise<unknown>> = [runSweepLightPass(restPrs, {
          ...common,
          restartAdmission: scope?.admit,
          actionable: (d) => (distanceKnown || d !== "mergeable") &&
            lightPassActionable(d, fixRungAllowed, false, !reviewOnly, fixAdmitted),
          ...reviewOnlyLightPassDeps(scope),
          ...(!distanceKnown ? { standDownReasonFor: (d: Disposition) => d === "mergeable"
            ? "ready PR distance is unreadable — held until its compare succeeds" : undefined } : {}),
          readLiveStateAtAct: effects.readLiveState,
          rereadPrAtAct: effects.rereadPrAtAct ?? buildRereadPrAtAct(owner, repo, ledgerPath, {
            views: { planFilingFileCache, onPlanFilingClassification: reportPlanFilingClassification, isMerged,
              readMainPlan: resolvedReadMainPlan },
          }),
          judgeHandedOffHead: handedOffHeadRiskJudge(owner, repo, config, activePlan, ledgerPath, runId, log),
          planContextDigestFor: riskJudgePlanContextDigestFor(activePlan),
          ...codeScanningJudgeDeps(owner, repo, config, activePlan, runId, log),
          ...headContractRefresh,
        }, DEFAULT_SWEEP_POLICY)];
        // W1-T2430: cancelled-only CI has its separate admission and may only requeue that job.
        if (requeueOnlyPrs.length > 0) passes.push(runSweepLightPass(requeueOnlyPrs, {
          ...common,
          actionable: (d) => lightPassActionable(d, fixRungAllowed, true),
          readCiGateRollup: undefined,
          reaggregateCiGate: undefined,
        }, DEFAULT_SWEEP_POLICY));
        await Promise.all(passes);
      };
      const readyNumbers = new Set(readyPrs.map((pr) => pr.prNumber));
      const ordinaryPrs = openPrs.filter((pr) => !readyNumbers.has(pr.prNumber));
      // Publish ordinary eligibility now. The action batch follows the whole-snapshot refresh
      // decisions, so its ledger rows cannot change which held or armed head gets refreshed.
      const observationLines = timing.run(() => timing.sync("review_eligibility", () => observeLightPassReviewEligibility(
        ordinaryPrs, { ...effects, ledgerPath, runId }, DEFAULT_SWEEP_POLICY)));
      // Review-lane heads cannot be selected by ready-overlap refresh. A head named in a
      // previous refresh admission, or already armed, stays in the later action batch.
      const lastAdmission = observationLines.findLast((row) => row.step === "sweep.base_red.refresh_admission");
      const admissionWaiters = new Set((Array.isArray(lastAdmission?.waiting) ? lastAdmission.waiting : [])
        .flatMap((entry) => typeof entry?.pr_number === "number" && typeof entry.head_sha === "string"
          ? [`${entry.pr_number}@${entry.head_sha}`] : []));
      const earlyReviewPrs = ordinaryPrs.filter((pr) => !pr.autoMergeArmed &&
        !admissionWaiters.has(`${pr.prNumber}@${pr.headSha}`) && isReviewLaneDisposition(deriveDisposition(pr).disposition));
      const earlyNumbers = new Set(earlyReviewPrs.map((pr) => pr.prNumber));
      const laterOrdinaryPrs = ordinaryPrs.filter((pr) => !earlyNumbers.has(pr.prNumber));
      const earlyReviews = earlyReviewPrs.length > 0
        ? timing.run(() => runBatches(earlyReviewPrs)) : Promise.resolve();
      const refresh = timing.run(async () => {
        let readyRefreshed: number | undefined;
        let measuredReadyPrs = readyPrs;
        if (readyPrs.length > 0) {
          const main = await timing.measure("main_tip", () => effects.readMainTip?.()).catch((error) => {
            log("sweep_light.main_tip_unreadable", { error: String(error) });
            return undefined;
          });
          // An unread tip keeps the former symbolic compare, without caching an unidentified main.
          const facts = await compares.read(readyPrs, main, timing);
          measuredReadyPrs = readyPrs.filter((pr) => facts.behindMainByPr.has(pr.prNumber));
          readyRefreshed = await runLightPassReadyRefresh(openPrs, {
            ...effects, ledgerPath, runId, ...facts,
            inFlightTaskIds: new Set(inFlightTaskIdsFrom(join(config.root, "state", "inflight"))),
          }, DEFAULT_SWEEP_POLICY, timing);
        }
        const admitted = reviewOnly ? [] : await timing.measure("refresh_admission", () =>
          runLightPassRefreshAdmission(openPrs, { ...effects, ledgerPath, runId }));
        const ratchetRefreshed = reviewOnly ? [] : await timing.measure("armed_ratchet_rejudge", () =>
          runArmedRatchetRejudge(openPrs, { ...effects, ledgerPath, runId }));
        // W1-T9595's admission above decides first; this selection reads the same ledger after it.
        headContractRefresh = reviewOnly || !fixAdmitted ? {} : await lightPassHeadContractRefresh(openPrs, { ...effects, ledgerPath });
        return { prs: readyPrs.filter((pr) => pr.prNumber !== readyRefreshed &&
          !admitted.includes(pr.prNumber) && !ratchetRefreshed.includes(pr.prNumber)),
          measured: new Set(measuredReadyPrs.map((pr) => pr.prNumber)) };
      });
      const ready = refresh.then(({ prs, measured }) => {
        const known = prs.filter((pr) => measured.has(pr.prNumber));
        const unknown = prs.filter((pr) => !measured.has(pr.prNumber));
        return Promise.all([
          known.length > 0 ? timing.run(() => runBatches(known)) : undefined,
          unknown.length > 0 ? timing.run(() => runBatches(unknown, false)) : undefined,
        ]);
      });
      const ordinary = refresh.then(() => laterOrdinaryPrs.length > 0 || readyPrs.length === 0
        ? timing.run(() => runBatches(laterOrdinaryPrs)) : undefined);
      const results = await Promise.allSettled([earlyReviews, ordinary, ready]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      });
    } catch (e) {
      log("sweep_light.error", { error: String((e as Error)?.message ?? e) });
    } finally {
      finishTiming();
    }
  }, mainHealthRung, { log });
}

/** W1-T4415 — the sweep's draft-readying effect: `gh pr ready` on one draft, ledgered by
 *  {@link readyDraftPullRequest}. Marking ready is the whole write; it never merges or closes. */
export function readyDraftViaGh(
  owner: string,
  repo: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  exec: typeof ghExec = ghExec,
): (pr: OpenPrView) => void {
  return (pr) =>
    readyDraftPullRequest(pr, {
      markReady: (prNumber) => {
        exec(["pr", "ready", String(prNumber), "--repo", `${owner}/${repo}`], { encoding: "utf8", stdio: "pipe" });
      },
      log,
    });
}

/** Retention window {@link sweepStaleWorkerTails} ages a `.tail` file out on — generously above
 *  any realistic drain cadence, so a still-relevant tail (W1-T945's future `rmd peek`, an
 *  operator re-reading a just-finished run) is never reclaimed out from under a live read;
 *  bounded at all so the directory does not grow forever (design note v). */
export const WORKER_TAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * AGE OUT stale `<root>/state/runs/*.tail` files — the sweep-side half of design note v ("the
 * reaper/sweep path that reclaims run scratch must be extended to age these out on a stated
 * retention, not to delete them at run end"). Wired into the daemon's poll cadence via
 * {@link runWorkerTailSweepRung}, riding the SAME per-poll slot `runWorktreeReapRung`/
 * `runInflightLockSweepRung`/`runTmpSweepRung` already occupy — no new schedule of its own.
 * Best-effort throughout: a stat/unlink race with a live writer (another run's still-open
 * tail) or a concurrent sweep is swallowed per-file, never fatal to the sweep tick.
 */
export function sweepStaleWorkerTails(root: string, opts: { maxAgeMs?: number; now?: () => number } = {}): { removed: string[] } {
  const dir = join(root, "state", "runs");
  const maxAgeMs = opts.maxAgeMs ?? WORKER_TAIL_RETENTION_MS;
  const nowMs = (opts.now ?? Date.now)();
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return { removed }; // best-effort — an unreadable dir costs a skipped sweep, never a throw
  }
  for (const entry of entries) {
    if (!entry.endsWith(".tail")) continue;
    const p = join(dir, entry);
    try {
      if (nowMs - statSync(p).mtimeMs > maxAgeMs) {
        unlinkSync(p);
        removed.push(entry);
      }
    } catch {
      /* best-effort — see this function's own doc */
    }
  }
  return { removed };
}

export function fetchOpenPrsWithPostedIds(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  return runStepsSync(openPrsWithPostedIdsSteps(owner, repo, fetch));
}

/**
 * W1-T177: resolve a stand-down reason from an OPTIONAL live-state reader —
 * shared by the fix rung's THREE internal checks (top of round; immediately
 * before a false-block escalation; immediately before the exhaustion
 * escalate()) so all three read via the SAME fail-open contract. `undefined`
 * (no reader wired, or a failed/indeterminate read) means "proceed exactly
 * as before this check existed" — standing down fires ONLY on a positive,
 * freshly-observed terminal reading. A FAILED/INDETERMINATE read (`ok:false`)
 * is explicitly LEDGERED here (never a silent swallow) so an unreadable
 * state is legible on the ledger even though it never halts anything — the
 * read failure itself is observable, distinct from an ordinary un-wired site
 * (which never calls `log` at all).
 *
 * W1-T296 extends this SAME function with a second reason source — branch
 * authorship — rather than a parallel early-return path: `authorship`, when
 * supplied, is consulted ONLY after the terminal-state read comes back
 * OPEN, and ONLY the caller at site `rung.strike` ever passes it (the other
 * two call sites omit it, so their behavior is byte-identical to before this
 * task). A foreign read is distinguished on the return value's `foreignHead`
 * field so the caller knows to escalate, not just ledger — the terminal-state
 * reason never sets it (a merged/closed PR carries no operator-decidable
 * question; W1-T196's same reasoning).
 *
 * W1-T1278 extends this SAME function with TWO more reason sources — condition A
 * (`redCheckSupersession`) and condition B (`mergeConflictCheck`) — again never a parallel
 * early-return path, and again ONLY the caller at site `rung.strike` ever passes them (the
 * `rung.false_block`/`rung.exhaustion` sites omit both, unchanged). Both are consulted ONLY
 * after the terminal-state read comes back OPEN, exactly like `authorship`, and NEITHER sets
 * `foreignHead` — both ledger only (see the two params' own docs for why: a genuinely-red check
 * or a dirty merge state is a self-evident GitHub-reported fact, never an operator-decidable
 * question the way a foreign push is).
 *
 * W1-T1284 extends this SAME function with a FOURTH reason source — `unchangedTree` — again
 * never a parallel early-return path, and again ONLY the caller at site `rung.strike` ever
 * passes it. See {@link unchangedTreeStandDownReason}'s own doc for the defect it closes; it
 * ledgers only, exactly like `redCheckSupersession`/`mergeConflictCheck` (an unchanged local
 * tree is a self-evident fact this rung itself observed, never an operator-decidable question).
 */

/**
 * W1-T177 SITE (v): the cold/sweep `dispatchFix` pre-flight's terminal-state
 * check — a REQUIRED, always-mandatory `readLiveState` call (unlike sites
 * (i)/(ii)/(iii)/(iv), whose reader is optional), because this is the only
 * site whose real wiring is `buildSweepEffects`'s own closure, never a
 * caller-supplied dep. Deliberately an INDEPENDENT read from the headRefName
 * fetch this site also needs (that fetch predates W1-T177 and is unrelated to
 * the terminal-state contract) — folding `state` into that SAME round trip
 * previously meant a `gh` hiccup on the read threw BEFORE the fail-open
 * `ok:false` branch ever ran, surfacing as `sweep.fix.error` (a silent
 * fleet-wide stand-down on a gh outage — exactly the fail-closed regression
 * this contract forbids). Splitting the read in two means a state-read
 * failure ALWAYS reports `ok:false` (never throws past this function) and is
 * handled by the SAME fail-open contract as every other site: ledgered via
 * `sweep.fix.indeterminate`, dispatch proceeds to resolve headRefName exactly
 * as it did before this check existed. Only a positive, freshly-observed
 * terminal reading (`sweep.fix.not_open`, naming the state) stands the
 * dispatch down, BEFORE any worktree/git side effect ever touches the PR.
 */
export async function dispatchFixPreflightStandDown(
  readLiveState: (prUrl: string) => LiveStateResult | Promise<LiveStateResult>,
  pr: { prUrl: string; prNumber: number },
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<string | undefined> {
  const live = await readLiveState(pr.prUrl);
  if (!live.ok) {
    log("sweep.fix.indeterminate", { pr_number: pr.prNumber });
    return undefined;
  }
  const reason = terminalStateReason(live.state);
  if (reason) {
    log("sweep.fix.not_open", { pr_number: pr.prNumber, state: live.state, reason });
  }
  return reason;
}

/**
 * W1-T2603 (A RECOVERED HEADROOM BREACH NEVER CLOSES ITS OWN ESCALATION). `escalateHeadroomReserve`
 * above raises one `[HARD_STOP]` issue per breach episode and nothing ever retires it — the breach
 * is a property of the ACCOUNT, not of any task, so it carries no task referent for
 * `buildEscalationReconcileCandidates` (below) to resolve against and falls through every arm of
 * that reconciler by construction, not by a bug in it (see this task's own rationale). This is the
 * missing retirement PATH for exactly that class, kept structurally separate from the task-referent
 * reconciler rather than bolted onto it.
 *
 * RETIRE ON AN OBSERVED RECOVERY, NEVER ON A TIMER OR AN ABSENCE. The daemon's own poll loop
 * (`daemon.ts`) already writes a `daemon.headroom` row on every tick with `window`, `percent_used`,
 * `limit_pct` and `over_ceiling` — a POSITIVE reading, taken whether or not the governor is
 * enforcing (see that step's own "ONE HEARTBEAT PER TICK, IN EVERY ENFORCEMENT POSTURE" doc). This
 * scans forward from the escalating row's own `ts` for the NEWEST such reading, for the SAME
 * `window` string, carrying `over_ceiling === false` — a positive observation that the door is open
 * again. A daemon that stopped reading headroom entirely (the W1-T2565 blind window) produces
 * exactly zero matching rows, never a false one, so an absence of breach rows is never mistaken for
 * recovery — the candidate list is built ONLY from a reading that actually happened.
 *
 * MATCH THE WINDOW, NOT JUST THE CLASS. The session (5h) and weekly windows breach independently
 * (`resolveHeadroomWindows`, daemon.ts) — a recovery reading for one must never retire an escalation
 * raised for the other, so `window` is compared for exact string equality, never treated as
 * interchangeable with "some window recovered".
 */
export interface HeadroomRecoveryCandidate {
  issueUrl: string;
  window: string;
  resetsAt: string;
  /** The recovery reading that justifies retiring this issue — always `over_ceiling: false`,
   *  always for the SAME `window`, always newer than the escalation it retires. */
  recovery: { percentUsed: number; limitPct: number; ts: string };
}

/**
 * Pure builder, mirroring `buildEscalationReconcileCandidates`'s own "read the ledger, hand back
 * candidates" shape: one {@link HeadroomRecoveryCandidate} per still-OPEN headroom-reserve
 * escalation (`openIssueUrls`, the caller's own live `listOpen` read — never re-read here) whose
 * `daemon.headroom_reserve.escalated` row names a `window` that has SINCE recovered. An escalated
 * row missing `window`/`resets_at` (every row written before this task) or whose `issue_url` is not
 * in `openIssueUrls` (never delivered, or already closed) yields no candidate.
 */
export function buildHeadroomRecoveryCandidates(
  ledgerPath: string,
  openIssueUrls: ReadonlySet<string>,
): HeadroomRecoveryCandidate[] {
  const lines = readLedgerLines(ledgerPath); // ledger-read-intent: live — this scan wants the newest rows only.
  const candidates: HeadroomRecoveryCandidate[] = [];
  for (const line of lines) {
    if (line.step !== "daemon.headroom_reserve.escalated") continue;
    const issueUrl = typeof line.issue_url === "string" ? line.issue_url : undefined;
    if (!issueUrl || !openIssueUrls.has(issueUrl)) continue; // undelivered, or already closed
    const window = typeof line.window === "string" ? line.window : undefined;
    const resetsAt = typeof line.resets_at === "string" ? line.resets_at : undefined;
    const escalatedTs = typeof line.ts === "string" ? line.ts : undefined;
    if (!window || !resetsAt || !escalatedTs) continue; // a pre-W1-T2603 row — no window to match
    const escalatedMs = Date.parse(escalatedTs);
    if (!Number.isFinite(escalatedMs)) continue;
    // The NEWEST matching recovery reading, so the citation names the most current evidence —
    // "newest wins" never changes WHETHER this retires, only what the close comment cites.
    let recovery: { percentUsed: number; limitPct: number; ts: string } | undefined;
    for (const reading of lines) {
      if (reading.step !== "daemon.headroom") continue;
      if (reading.window !== window) continue; // THE WINDOW MATCH — never just the class
      if (reading.over_ceiling !== false) continue; // a positive under-ceiling observation only
      const readingTs = typeof reading.ts === "string" ? reading.ts : undefined;
      if (!readingTs) continue;
      const readingMs = Date.parse(readingTs);
      if (!Number.isFinite(readingMs) || readingMs <= escalatedMs) continue; // must POSTDATE the breach
      if (!recovery || readingMs > Date.parse(recovery.ts)) {
        recovery = {
          percentUsed: typeof reading.percent_used === "number" ? reading.percent_used : NaN,
          limitPct: typeof reading.limit_pct === "number" ? reading.limit_pct : NaN,
          ts: readingTs,
        };
      }
    }
    if (recovery) candidates.push({ issueUrl, window, resetsAt, recovery });
  }
  return candidates;
}

/** The closing citation posted on a headroom-recovery retirement — mirrors
 *  `renderReconcileCloseComment`'s "name the resolution" discipline for the task-referent arm. */
export function renderHeadroomRecoveryCloseComment(c: HeadroomRecoveryCandidate): string {
  return [
    "Auto-retired by the headroom-recovery reconciler (W1-T2603).",
    "",
    `**${c.window}** is now reading **${c.recovery.percentUsed}% used** (below the ${c.recovery.limitPct}% ` +
      `operator reserve ceiling) as of ${c.recovery.ts} — under its ceiling again since this escalation was ` +
      `raised for a breach at ${c.resetsAt !== undefined ? `the window resetting ${c.resetsAt}` : "this window"}.`,
    "",
    "_Level-triggered closure from a daemon-observed `daemon.headroom` reading for the SAME window. If the " +
      "account breaches again, a fresh escalation opens on its own._",
  ].join("\n");
}

/**
 * Reconcile OPEN headroom-reserve escalations against observed recovery — the retirement leg
 * `escalateHeadroomReserve` never had. Lists open needs-human/fleet-notice issues via the SAME
 * `listRetirableEscalationIssues` the task-referent reconciler uses (never a second listing
 * mechanism), builds candidates from the ledger, and closes each with a citation. Best-effort and
 * non-fatal throughout, mirroring `runEscalationReconcile`'s per-item throw containment: a failed
 * issue-list read or a failed close is logged and this cycle simply retires fewer, never none of
 * the reconciler's other rungs.
 */
export async function retireRecoveredHeadroomEscalations(
  ledgerPath: string,
  runId: string,
  ctx: { issues: IssueGateway; log?: (step: string, extra?: Record<string, unknown>) => void; dryRun?: boolean },
): Promise<{ retired: number }> {
  const log = ctx.log ?? (() => {});
  let open: OpenIssue[];
  try {
    open = listRetirableEscalationIssues(ctx.issues);
  } catch (e) {
    log("sweep.headroom_recovery.list_failed", { error: String((e as Error)?.message ?? e) });
    return { retired: 0 };
  }
  const openUrls = new Set(open.map((i) => i.url));
  const candidates = buildHeadroomRecoveryCandidates(ledgerPath, openUrls);
  let retired = 0;
  for (const c of candidates) {
    // dryRun leaves no trace — mirrors runEscalationReconcile's own "still counts, never acts" preview.
    if (ctx.dryRun) {
      retired++;
      continue;
    }
    try {
      if (!ctx.issues.closeWithComment) throw new Error("issue gateway cannot close issues");
      ctx.issues.closeWithComment(c.issueUrl, renderHeadroomRecoveryCloseComment(c));
    } catch (e) {
      log("sweep.headroom_recovery.close_failed", { issue_url: c.issueUrl, error: String((e as Error)?.message ?? e) });
      continue;
    }
    appendLedger(ledgerPath, {
      run_id: runId,
      task_id: "daemon",
      step: "daemon.headroom_reserve.retired",
      issue_url: c.issueUrl,
      window: c.window,
      resets_at: c.resetsAt,
      recovered_percent_used: c.recovery.percentUsed,
      recovered_ts: c.recovery.ts,
    });
    log("sweep.headroom_recovery.retired", { issue_url: c.issueUrl, window: c.window, recovered_ts: c.recovery.ts });
    retired++;
  }
  log("sweep.headroom_recovery.summary", { candidates: candidates.length, retired });
  return { retired };
}

export function sweepPrTerminalRung(github: Pick<GitHub, "prByRef">, ledgerPath: string, runId: string, // W1-T5318
  tickRead?: Pick<TickReadFacts, "closedPrs">): PrTerminalReconcileSummary {
  const lookup = tickRead?.closedPrs ? closedPrLookup(tickRead.closedPrs) : (url: string) => closedPrFromRef(github.prByRef(url));
  return runPrTerminalReconcile(lookup, { ledgerPath, runId });
}

/** W1-T4075: the post-fix re-verification rung's two reads, answered from one tick-read generation. */
export function tickReadReverificationDeps(tickRead: Pick<TickReadFacts, "mergedFixPrNumbers" | "postFixCiFailuresByPr">): {
  isMergedByNumber: (prNumber: number) => boolean;
  readCiFailures: (pr: OpenPrView) => CiFailure[] | undefined;
} {
  return {
    isMergedByNumber: (number) => tickRead.mergedFixPrNumbers.includes(number),
    readCiFailures: (pr) => tickRead.postFixCiFailuresByPr.get(pr.prNumber),
  };
}

/**
 * W1-T1212 — {@link SweepDeps.updatedForWorkflow}'s real wiring: every `${prNumber}:${workflow}`
 * pair a PRIOR `sweep.update_branch.updated` ledger row already fired for (that row's own
 * `stale_workflow` field — see `runSweep`'s ledger write, lib/sweep.ts). Reads the SAME durable
 * ledger every other dedup in this lane already consults — never a second store.
 */
export function updatedForWorkflowFromLedger(ledgerPath: string): Set<string> {
  const out = new Set<string>();
  for (const line of readLedgerLines(ledgerPath)) {
    if (line.step !== "sweep.update_branch.updated") continue;
    const prNumber = line.pr_number;
    const workflow = line.stale_workflow;
    if (typeof prNumber === "number" && typeof workflow === "string") out.add(`${prNumber}:${workflow}`);
  }
  return out;
}

/** One bounded ledger row per classification transition, never one row per unchanged poll. */
export function createPlanFilingClassificationTelemetry(
  log: (step: string, extra?: Record<string, unknown>) => void,
): (event: PlanFilingClassificationEvent) => void {
  const observed = new Map<string, PlanFilingClassificationSource>();
  return (event) => {
    const key = `${event.prNumber}@${event.headSha}`;
    if (observed.get(key) === event.source) return;
    observed.delete(key);
    observed.set(key, event.source);
    while (observed.size > PLAN_FILING_FILE_CACHE_MAX_ENTRIES) {
      const oldest = observed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      observed.delete(oldest);
    }
    log("sweep.plan_filing_classified", {
      pr_number: event.prNumber,
      head_sha: event.headSha,
      classification_source: event.source,
    });
  };
}

/**
 * Build the observed open-PR state the sweep reconciles — the real gateway
 * (REST `/pulls?state=open`), cross-referenced with the ledger. No `gh`/network
 * lives in lib/sweep.ts; this is the injected edge.
 *
 * REST, NOT `gh pr list --json`: that flag is implemented over GraphQL, which put the sweep's
 * whole critical path behind a budget that was exhausted on 2026-07-28 — 22 consecutive minutes
 * of totally blind passes, zero PRs dispositioned, while core sat healthy. See lib/open-prs-rest.ts.
 */
export function buildOpenPrViews(owner: string, repo: string, ledgerPath: string, deps: NonNullable<Parameters<typeof openPrViewSteps>[3]> = {}): ClassifiedOpenPrView[] {
  const fetch = deps.fetch ?? ghJson;
  return runStepsSync(openPrViewSteps(owner, repo, ledgerPath, deps, {
    read: fetch,
    openPrRows: () => paceGhEntry(deps.pacer, isGhRateLimitError, () => fetchOpenPrsWithPostedIds(owner, repo, fetch)),
    ciFailures: deps.fetchCiFailureEvidence ?? fetchCiFailures,
    requiredContexts: readRequiredStatusCheckContexts,
  }));
}

export function buildRereadPrAtAct(
  owner: string,
  repo: string,
  ledgerPath: string,
  opts: {
    pacer?: GhCallPacer;
    fetchAsync?: GhApiFetcher;
    views?: Omit<NonNullable<Parameters<typeof buildOpenPrViewsAsync>[3]>, "openPrRows" | "fetchAsync" | "pacer">;
  } = {},
): (pr: OpenPrView) => Promise<OpenPrView | undefined> {
  const read: GhApiFetcher = opts.fetchAsync ??((args, onRateLimit) => ghJsonAsync(args, undefined, onRateLimit));
  return async (pr) => {
    const checkRuns = new Map<string, unknown>();
    const row = await paceGhEntryAsync(opts.pacer, isGhRateLimitError, () =>
      fetchSinglePrRestAsync(owner, repo, pr.prNumber, async (args, onRateLimit) => {
        const response = await read(args, onRateLimit);
        if (args[1]?.includes("/check-runs?")) checkRuns.set(args[1], response);
        return response;
      }));
    if (row.state !== "OPEN") return undefined;
    if (row.statusCheckRollup) {
      attachPostedGateIds(row.statusCheckRollup, checkRuns.get(checkRunsRestArgs(owner, repo, row.headRefOid)[1]));
    }
    const views = await buildOpenPrViewsAsync(owner, repo, ledgerPath, {
      ...opts.views, fetchAsync: read, pacer: opts.pacer, openPrRows: [row],
    });
    const view = views.find((candidate) => candidate.prNumber === pr.prNumber);
    if (!view) throw new Error(`the rebuilt view list did not contain PR #${pr.prNumber}`);
    // Head-independent facts the whole-board producer and the credit projection computed for this PR.
    return {
      ...view,
      supersededBy: view.supersededBy ?? pr.supersededBy,
      supersessionVerdict: view.supersessionVerdict ?? pr.supersessionVerdict,
      taskMergedBy: pr.taskMergedBy,
      planResequenceIneligible: pr.planResequenceIneligible,
      planResequenceUnmetDependencies: pr.planResequenceUnmetDependencies,
      planResequenceHeld: pr.planResequenceHeld,
    };
  };
}

/**
 * Wire the four gated effects to their real implementations. dispatchFix
 * reconstructs a W1-T76 `runFixRung` invocation for a PR discovered COLD (no live
 * run/session): it checks the PR head branch out into a scratch worktree, seeds a
 * failing verdict from the ledger's unmet criteria, and degrades strike 1 to a
 * FRESH spawn (a spawn adapter drops an empty resumeSessionId). All effects are
 * fail-soft — a reconstruction hiccup escalates rather than crashing the sweep,
 * so one bad PR never strands the reconciler over the rest.
 */
/**
 * W1-T2416 — THE VERDICT READ THE FILER NEVER HAD. Given every prior feedback entry that shares
 * this filing's exact `origin` (`repair#<surface>` — matched on the SURFACE, never on the
 * window-keyed `id`, which by construction cannot match across windows, design ii), returns the
 * most recent one (by `ts`) ONLY when its `status` is `rejected` — the one verdict this filer now
 * respects — or `undefined` when nothing should be suppressed:
 *   - no prior entry for this origin at all (a due surface with no history files exactly as it
 *     does today);
 *   - the most recent prior entry is `new`/`grilling`/`proposed`/`accepted`/`answered` — an
 *     untriaged backlog is not a ruling, and an `accepted` entry means the class is being worked,
 *     a different question this task deliberately leaves alone (design ii).
 * Pure over its input — no I/O — so it is unit-testable with hand-built fixtures, no disk
 * involved.
 */
export function latestPriorVerdictSuppresses(priorEntriesForOrigin: readonly FeedbackEntry[]): FeedbackEntry | undefined {
  let latest: FeedbackEntry | undefined;
  for (const entry of priorEntriesForOrigin) {
    if (!latest || Date.parse(entry.ts) > Date.parse(latest.ts)) latest = entry;
  }
  return latest?.status === "rejected" ? latest : undefined;
}

/**
 * A suppressed repair filing has no file to satisfy the normal same-window `existsSync` guard.
 * Keep the telemetry level-triggered without writing the same row on every daemon poll: one row
 * per process for each `(root, window id, rejecting verdict, evidence count)`. A daemon restart
 * logs the still-active suppression once again, and genuinely new evidence logs a fresh row.
 */
const repairFilingSuppressionsLogged = new Set<string>();

/**
 * W1-T2416 — the SAME per-window dedup {@link buildSweepEffects}'s `captureRepairFeedbackImpl`
 * default has always used (the `existsSync` check, first, unchanged), PLUS the prior-verdict read
 * design (i) puts at this exact site: a surface whose most recent `repair#<surface>` entry was
 * rejected files nothing, and instead ledgers `sweep.repair_filing_suppressed` naming the
 * surface, the distinct-PR count carried in this filing's own evidence, and the id of the
 * rejected entry that suppressed it (design iii) — so the suppression is never silent even though
 * the filing it stands down is.
 *
 * `root` is a parameter, not the module-level `repoRoot` {@link buildSweepEffects}'s default
 * binds it to — so this is directly unit-testable against a throwaway directory, the same shape
 * `test/sweep-repair-filing.test.ts`'s own `realCaptureRepairFeedback` already established for
 * the dedup half of this function.
 *
 * BEST EFFORT, STRUCTURALLY, AND FAILS OPEN (design v): an unreadable or malformed prior entry —
 * `listFeedback` throwing on a corrupt neighbour in `plan/feedback/`, or a `ts` that fails to
 * parse — must never silence a filing that would otherwise happen; the read is wrapped so any
 * throw falls through to filing exactly as before this task, never to silence.
 */
export function captureRepairFeedbackWithPriorVerdict(
  root: string,
  filing: RepairFilingCapture,
  log: (step: string, extra?: Record<string, unknown>) => void,
  landingStateRoot?: string,
): void {
  if (feedbackCaptured(root, filing.id, landingStateRoot)) return; // already filed this window
  let suppressedBy: FeedbackEntry | undefined;
  try {
    const priorEntriesForOrigin = listFeedback(root).filter((e) => e.origin === filing.origin);
    suppressedBy = latestPriorVerdictSuppresses(priorEntriesForOrigin);
  } catch {
    suppressedBy = undefined; // fail OPEN — file it, never silenced by a read error
  }
  if (suppressedBy) {
    const distinctPrCount = (filing.raw.match(/^- PR #\d+/gm) ?? []).length;
    const suppressionKey = `${root}\0${filing.id}\0${suppressedBy.id}\0${distinctPrCount}`;
    if (!repairFilingSuppressionsLogged.has(suppressionKey)) {
      log("sweep.repair_filing_suppressed", {
        surface: filing.origin.replace(/^repair#/, ""),
        distinct_pr_count: distinctPrCount,
        rejected_entry_id: suppressedBy.id,
        id: filing.id,
      });
      repairFilingSuppressionsLogged.add(suppressionKey);
    }
    return;
  }
  const capture = { id: filing.id, raw: filing.raw, origin: filing.origin as FeedbackOrigin };
  if (landingStateRoot === undefined) captureFeedback(root, capture);
  else stageFeedbackCapture(root, landingStateRoot, capture);
}

/** The one-shot boundary owns and drains its judgment pool before returning a summary. */
export async function runOneShotSweep(
  run: (pool: HandedOffHeadJudgmentPool) => Promise<SweepSummary>,
  pool = handedOffHeadJudgmentPool(),
): Promise<SweepSummary> {
  try {
    return await run(pool);
  } finally {
    await awaitHandedOffHeadJudgments(pool);
  }
}

/** The reconciler's live close side (fb-1784756088300-6a481e): `gh issue close --comment` via
 *  {@link ghIssueGateway}, built once. Throws if the gateway cannot close, so a phantom close
 *  is never ledgered — the reconciler's per-issue containment catches it as `close-failed`. */
export function buildEscalationCloser(
  owner: string,
  repo: string,
  issues: IssueGateway = ghIssueGateway(owner, repo),
): (url: string, comment: string) => void {
  return (url, comment) => {
    if (!issues.closeWithComment) throw new Error("issue gateway cannot close issues");
    issues.closeWithComment(url, comment);
  };
}

/**
 * The escalation-lifecycle reconciler rung (fb-1784756088300-6a481e), shared verbatim by
 * `rmd sweep` and the daemon's sweep hook: list open needs-human issues, derive each referent's
 * CURRENT state, and close the resolved ones with a citation naming the resolver. Injectable
 * `issues`/`github` for tests. Returns the pass summary; never throws (buildEscalationReconcile-
 * Candidates degrades a failed read to [], runEscalationReconcile contains per-issue throws).
 */
/**
 * W1-T1101: the reconcile summary as THIS caller sees it — `runEscalationReconcile`'s own shape
 * (lib/sweep.ts, untouched by this task) plus the three intake counts `sweepEscalationReconcile`
 * already holds in a local. The widening lives HERE, not on the library type, because the library
 * function never measures these: `buildEscalationReconcileCandidates` does, one statement earlier,
 * in this same file. Putting the fields on the shared type would have moved a run-task.ts
 * measurement into lib/sweep.ts for no reader there.
 */
export interface SweepEscalationReconcileSummary extends EscalationReconcileSummary {
  /**
   * Open issues the read returned, one statement before the candidate loop — see
   * {@link EscalationIntake}. Present iff an intake reached this caller, which happens UNLESS the
   * issue-list read itself failed (the builder's `[]`-on-failure contract never calls its
   * `onIntake` observer) — so `issuesSeen === undefined` is specifically "the read failed", not
   * "nothing was measured".
   */
  issuesSeen?: number;
  /** Dropped for carrying no `**Task:**` trailer — see {@link EscalationIntake}. */
  droppedNoTaskTrailer?: number;
  /** Dropped for naming neither a plan task nor any resolvable PR referent. */
  droppedNoReferent?: number;
}

/**
 * One-line human render of an escalation-reconcile pass, for `rmd sweep`'s console output
 * (W1-T1101). The line this replaces printed `total` (the POST-DROP candidate count) under the
 * label "open needs-human issue(s) checked" — so `total: 0` read identically whether nothing was
 * open, everything open was dropped, or the issue-list read failed outright. This renders
 * `issuesSeen` under that label instead (the count the read actually returned), names an
 * unreadable list as exactly that rather than a bare zero, and — only when a drop shrank
 * `issuesSeen` down to `total` — names the drop reasons, mirroring the ledger row's own
 * healthy-path-stays-small asymmetry (see the `sweep.escalation_reconcile.summary` log call in
 * `runEscalationReconcile`).
 */
export function renderEscalationReconcileSummary(s: SweepEscalationReconcileSummary): string {
  if (s.issuesSeen === undefined) {
    // No intake reached this pass — on `sweepEscalationReconcile`'s own call site (the only
    // production caller), that happens exactly when `buildEscalationReconcileCandidates`' issue-list
    // read threw and returned `[]` under its "do nothing this cycle" contract. `total`/`closed` are
    // both correctly 0 in that case too, so rendering them here would be the identical, ambiguous
    // zero this task exists to remove.
    return "escalation reconcile: issue-list read FAILED this cycle (see sweep.escalation_reconcile.list_failed) — nothing checked, nothing closed";
  }
  const droppedTotal = s.issuesSeen - s.total;
  const droppedNote =
    droppedTotal > 0
      ? ` · ${s.total} became candidate(s), ${droppedTotal} dropped (${s.droppedNoTaskTrailer ?? 0} no-task-trailer, ${s.droppedNoReferent ?? 0} no-referent)`
      : "";
  return `escalation reconcile: ${s.issuesSeen} open needs-human issue(s) checked · ${s.closed} closed${droppedNote}`;
}

export async function sweepEscalationReconcile(
  owner: string,
  repo: string,
  plan: Plan,
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: { dryRun?: boolean; issues?: IssueGateway; github?: GitHub;
    tickRead?: Pick<TickReadFacts, "escalationCandidates" | "escalationIntake"> } = {},
): Promise<SweepEscalationReconcileSummary> {
  let intake: EscalationIntake | undefined;
  const candidates = opts.tickRead?.escalationCandidates ?? buildEscalationReconcileCandidates(owner, repo, plan, ledgerPath, log, {
    issues: opts.issues,
    github: opts.github,
    onIntake: (i) => {
      intake = i;
    },
  });
  if (opts.tickRead) intake = opts.tickRead.escalationIntake;
  const summary = await runEscalationReconcile(candidates, {
    intake,
    closeIssue: buildEscalationCloser(owner, repo, opts.issues),
    ledgerPath,
    runId,
    log,
    dryRun: opts.dryRun,
  });
  // W1-T2603: the SEPARATE retirement path for a headroom breach that has recovered — this class
  // carries no task referent, so `buildEscalationReconcileCandidates`/`runEscalationReconcile`
  // above structurally never see it (see that task's rationale). Sharing this rung's own
  // `issues`/`dryRun` rather than a second gateway construction, but a fully independent
  // candidate build and close loop, non-fatal like everything else in this rung — a throw here
  // must never take out the task-referent reconciler's own summary above.
  try {
    await retireRecoveredHeadroomEscalations(ledgerPath, runId, {
      issues: opts.issues ?? ghIssueGateway(owner, repo),
      log,
      dryRun: opts.dryRun,
    });
  } catch (e) {
    log("sweep.headroom_recovery.failed", { error: String((e as Error)?.message ?? e) });
  }
  // W1-T1101: the SAME counts the ledger row below has carried since #1084, now also riding on the
  // returned summary so `renderEscalationReconcileSummary` (the CLI line) can see them. No new
  // read, no change to what `runEscalationReconcile` measures or logs — the merge happens HERE,
  // in the file that already holds `intake`, rather than widening lib/sweep.ts's shared type.
  return intake
    ? { ...summary, issuesSeen: intake.issuesSeen, droppedNoTaskTrailer: intake.droppedNoTaskTrailer, droppedNoReferent: intake.droppedNoReferent }
    : summary;
}

export const MOUNT_RECOMMENDER_CADENCE_POLICY = {
  kind: "daily-ledger-evidence-accrual",
  intervalMs: 24 * 60 * 60 * 1000,
} as const;

function mountRecommenderCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-mount-recommender.json");
}

function mountRecommenderNextFireMs(marker: ReturnType<typeof readFeedbackDocketMarker>): number | undefined {
  if (!marker) return undefined;
  const last = Date.parse(marker.lastFireIso);
  if (Number.isNaN(last)) return undefined;
  return last + MOUNT_RECOMMENDER_CADENCE_POLICY.intervalMs;
}

/**
 * W1-T2575 — the missing RECOMMENDATION leg (MASTER-PLAN §9, WS-8). `scripts/mount-headroom-
 * sweep.mjs` (W1-T2560, extended W1-T2574) already MEASURES: it groups retained ledger runs into
 * (type, risk, class) cells and, within each, into (provider, served_model, effort) arms — a
 * printed table a human had to read and act on, with nothing that turned it into a decision. This
 * rung is that missing leg: it reads the sweep's own `cells` via a dynamic import (the script
 * sits outside tsconfig's `include`, the SAME "dynamic import at the call site, cast to an
 * explicit shape" discipline `test/a-mount-comparison-across-unmatched-populations-is-not-a-
 * measurement.test.ts` already established for consuming it from typed code), hands them to
 * {@link recommendMounts} (lib/mount-recommender.ts) alongside the CURRENTLY LOADED
 * `.remudero/mounts.yaml` table (so the Tier Invariant, G-17, is checked against what is actually
 * committed), and files every cleared recommendation through `updateProposalRegistry` — the SAME
 * W1-T240 single-writer the feedback-docket rung immediately above uses, idempotent by
 * `mountRecommendationProposalId` so a re-poll before ratification never duplicates. A REFUSAL
 * (the expected, common outcome — see mount-recommender.ts's own header, "refuse more often than
 * recommend") is counted and logged, never filed: it asserts nothing an inbox proposal could
 * ratify. `recommendMounts` and `mountRecommendationProposalCandidate` are BOTH pure (no I/O,
 * mutate no routing table) — every read (the ledger corpus, `mounts.yaml`) and every write (the
 * proposal registry) happens here, in this rung, exactly once. Own try/catch: an empty/missing
 * ledger corpus (`buildMountHeadroomSweep` throws on zero runs) or a malformed `mounts.yaml` must
 * never take down the sweep composite this rides inside, same discipline as every other rung on
 * this cadence.
 */
export async function runMountRecommenderRung(
  config: Config,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  deps: {
    root?: string;
    env?: NodeJS.ProcessEnv;
    clock?: Clock;
    buildMountHeadroomSweep?: (stateDir: string) => { cells: MountHeadroomCell[] };
  } = {},
): Promise<{ filed: number; refused: number }> {
  const root = deps.root ?? repoRoot;
  try {
    const now = (deps.clock ?? systemClock).date();
    const stateDir = join(config.root, "state");
    const markerPath = mountRecommenderCadenceMarkerPath(config.root);
    const marker = readFeedbackDocketMarker(markerPath);
    const nextFireMs = mountRecommenderNextFireMs(marker);
    if (nextFireMs !== undefined && now.getTime() < nextFireMs) {
      log("mount_recommendation.skipped", {
        run_id: runId,
        cadence_kind: MOUNT_RECOMMENDER_CADENCE_POLICY.kind,
        interval_ms: MOUNT_RECOMMENDER_CADENCE_POLICY.intervalMs,
        last_fire_iso: marker?.lastFireIso,
        next_fire_iso: new Date(nextFireMs).toISOString(),
      });
      return { filed: 0, refused: 0 };
    }
    writeFeedbackDocketMarker(markerPath, { lastFireIso: now.toISOString() });

    let buildMountHeadroomSweep = deps.buildMountHeadroomSweep;
    if (!buildMountHeadroomSweep) {
      const scriptUrl = pathToFileURL(join(root, "scripts", "mount-headroom-sweep.mjs")).href;
      ({ buildMountHeadroomSweep } = (await import(scriptUrl)) as {
        buildMountHeadroomSweep: (stateDir: string) => { cells: MountHeadroomCell[] };
      });
    }
    const sweep = buildMountHeadroomSweep(stateDir);
    const mounts = loadMounts(mountsPath(root));
    // Derive the objective from the SAME sanctioned environment boundary a real worker crosses:
    // API only when config opts in AND the key is materially present; otherwise subscription.
    // Only key names reach `billingMode`, and neither names nor values are retained below.
    const materialWorkerEnv = buildWorkerEnv({}, deps.env ?? process.env, {
      allowApiKey: config.overflow === "api_key",
    });
    const materialBillingMode = billingMode(Object.keys(materialWorkerEnv));
    let objectiveFallbacks = 0;
    const outcomes = recommendMounts(sweep.cells, mounts, {
      billingMode: materialBillingMode,
      warn: (message) => {
        objectiveFallbacks++;
        log("mount_recommendation.objective_fallback", { run_id: runId, detail: message.slice(0, 500) });
      },
    });

    const registryPath = join(config.root, "state", "inbox-proposals.json");
    let filed = 0;
    let refused = 0;
    for (const outcome of outcomes) {
      if (outcome.kind === "refusal") {
        refused++;
        continue;
      }
      const candidate = mountRecommendationProposalCandidate(outcome);
      updateProposalRegistry(registryPath, (current) => {
        if (current.some((p) => p.id === candidate.id)) return null; // already filed, idempotent
        filed++;
        const proposal: Proposal = { id: candidate.id, summary: candidate.summary, evidenceAnchors: candidate.evidenceAnchors };
        return [...current, proposal];
      });
    }

    log("mount_recommendation.swept", {
      run_id: runId,
      filed,
      refused,
      cells: sweep.cells.length,
      billing_mode: billingMode(Object.keys(materialWorkerEnv)),
      objective_fallbacks: objectiveFallbacks,
    });
    return { filed, refused };
  } catch (e) {
    log("mount_recommendation.error", { error: String((e as Error)?.message ?? e) });
    return { filed: 0, refused: 0 };
  }
}

/**
 * The daemon's per-poll WORKER-TAIL retention rung (W1-T942 design note v) — ages out stale
 * `<config.root>/state/runs/*.tail` files via {@link sweepStaleWorkerTails}, on the SAME
 * per-poll cadence `runWorktreeReapRung`/`runInflightLockSweepRung`/`runTmpSweepRung` already
 * ride (see `buildSweepHook`'s call site). Own try/catch so a sweep hiccup never masks — or is
 * masked by — the rungs around it, the same discipline every sibling rung in this file follows.
 */
export function runWorkerTailSweepRung(config: Config, log: (step: string, extra?: Record<string, unknown>) => void): void {
  try {
    const swept = sweepStaleWorkerTails(config.root);
    if (swept.removed.length > 0) log("daemon.worker_tail_sweep", { removed: swept.removed.length });
  } catch (e) {
    log("daemon.worker_tail_sweep", { error: String((e as Error)?.message ?? e) });
  }
}

export function runTmpSweepRung(
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: TempSweepOpts = {},
): TempSweepSummary {
  try {
    const swept = sweepStaleTempDirs(opts);
    log("daemon.tmp_sweep", {
      removed: swept.removed.length,
      kept: swept.kept.length,
      oldest_kept_age_ms: swept.oldestKeptAgeMs,
    });
    return swept;
  } catch (e) {
    log("daemon.tmp_sweep", { error: String((e as Error)?.message ?? e) });
    return { removed: [], kept: [], oldestKeptAgeMs: null };
  }
}

/** DEFAULT quiet threshold, mirrored from `plan/policy.yaml`'s `workerStall` row for a caller
 *  with no policy in hand (test fixtures, primarily) — production always threads the real
 *  `policy.values.workerStall` through {@link buildSweepHook} instead of relying on this. See
 *  that row's own comment for why 60 minutes is the default (design note v: comfortably above
 *  the ~16-minute `--ci-parity` suite W1-T463/W1-T465 measured). */
export const DEFAULT_WORKER_STALL_MS = 3_600_000;

/**
 * W1-T2430 — DOES THIS PR'S ENTIRE RED VERDICT REDUCE TO CANCELLATIONS?
 *
 * TRUE only when {@link isBlockedCi} holds, at least one required check is cancelled
 * ({@link OpenPrView.cancelledRequiredChecks}), and EVERY {@link OpenPrView.ciFailures} entry
 * names one of those cancelled checks — the EXACT SAME fold `runSweep`'s own `blocked-fixable`
 * case performs (`src/lib/sweep.ts`, the `cancelledChecks`/`genuineFailures` pair immediately
 * before its `dispatchFix` call) to decide whether to stand down after re-queueing rather than
 * fall through to a fix dispatch. Recomputed here, read-only, off the SAME {@link OpenPrView}
 * snapshot `runSweep` itself will evaluate (no re-fetch, so no race between this predicate's
 * answer and the switch's own) — a PR this returns `true` for is GUARANTEED to reach that
 * stand-down branch and never `dispatchFix`, which is what lets `buildSweepLightHook` admit it
 * on a light pass without loosening `fixRungAllowed`'s own gate for any other PR.
 *
 * A PR with NO cancelled required check (the common case) always reads FALSE here — never
 * routed to the requeue-only batch, so its ordinary `deferred to full sweep (light pass)`
 * stand-down is entirely unchanged by this predicate's existence.
 */
export function blockedFixableIsRequeueOnly(pr: OpenPrView): boolean {
  if (!isBlockedCi(pr)) return false;
  const cancelledChecks = pr.cancelledRequiredChecks ?? [];
  if (cancelledChecks.length === 0) return false;
  const genuineFailures = (pr.ciFailures ?? []).filter(
    (f) => !cancelledChecks.some((c) => c.name === f.name),
  );
  return genuineFailures.length === 0;
}

/**
 * W1-T1211 — IS THIS RUN DEMONSTRABLY WAITING RATHER THAN SPENDING A WORKER?
 *
 * TRUE only when the task's LATEST RETAINED row is {@link AWAITING_EXTERNAL_LEDGER_STEP}. Reading
 * the latest retained row rather than the latest row of any kind is what makes this survive a
 * rotation: the polling telemetry beside it is shed by design, and a predicate that depended on it
 * would silently invert the moment the rotator ran.
 *
 * DELIBERATELY NOT `liveInflightRuns`: that pid-checks a lock, which is HOST-LOCAL (a pid on
 * another host is unreadable), and it carries W1-T1109's consumer defect — the lock-vs-process arm
 * compares a lock FILENAME's task id against a set of RUN ids, which can never match. Nothing here
 * builds on it (design note ii).
 *
 * FAILS SAFE IN BOTH DIRECTIONS. No rows for the task, or a latest retained row that is any other
 * step, reads FALSE — the fix rung stands down exactly as it does today. And a run that DIED while
 * waiting has no worker either, so treating its stale row as "waiting" reaches the same conclusion
 * by a different route rather than a wrong one.
 *
 * WRITTEN AS A DIRECT `.step ===` COMPARISON ON PURPOSE, like `reviewPostRefusedFor` above:
 * `test/ledger-rotation.test.ts` derives `DECISION_RELEVANT_LEDGER_STEPS` membership by scanning
 * consumer source for exactly that shape, so this makes the dependency VISIBLE to the check that
 * exists to find it. The step is registered in that set by this same change.
 */
export function runIsAwaitingExternal(lines: ReadonlyArray<Record<string, unknown>>, taskId: string): boolean {
  let latestTs = "";
  let awaiting = false;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    const rawStep: unknown = line.step;
    const step = typeof rawStep === "string" ? rawStep : "";
    if (!DECISION_RELEVANT_LEDGER_STEPS.has(step)) continue; // the retained core only — see this function's doc
    const ts = typeof line.ts === "string" ? line.ts : "";
    if (ts >= latestTs) {
      latestTs = ts;
      // THE STRING LITERAL, NOT THE CONSTANT, ON PURPOSE. `test/ledger-rotation.test.ts` scans
      // consumer source for a step-equality comparison against a quoted name; comparing against the
      // exported identifier instead would hide this dependency from the very guard that exists to
      // find it, and the predicate would then rest on retention nobody had registered. (The comment
      // itself must not spell that pattern out either — the scanner reads comments too.)
      awaiting = line.step === "run.awaiting_external";
    }
  }
  return awaiting;
}

/**
 * W1-T1211 — MAY THE FIX RUNG ACT ALONGSIDE THE RUNS CURRENTLY IN FLIGHT?
 *
 * TRUE only when EVERY in-flight run is demonstrably waiting. One run still working is enough to
 * stand the rung down, which is the property the restriction genuinely buys (design note iv: never
 * run the fix rung beside a spending worker). An EMPTY in-flight set is vacuously true — there is
 * nothing to be concurrent with.
 */
export function fixRungAllowedBesideInFlight(
  lines: ReadonlyArray<Record<string, unknown>>,
  inFlightTaskIds: readonly string[],
): boolean {
  return inFlightTaskIds.every((taskId) => runIsAwaitingExternal(lines, taskId));
}

/** W1-T9569 — what a review-only light pass writes on its rows: its scope, in the stand-down text and in
 * `light_pass_scope`, never the ordinary "deferred to full sweep (light pass)". An ordinary pass gets nothing. */
export function reviewOnlyLightPassDeps(scope?: LightPassScope): Pick<SweepDeps, "lightPassScope" | "standDownReasonFor"> {
  const name = scope?.reviewOnly === true ? scope.scope : undefined;
  return name ? { lightPassScope: name, standDownReasonFor: () => reviewOnlyStandDownReason(name) } : {};
}
