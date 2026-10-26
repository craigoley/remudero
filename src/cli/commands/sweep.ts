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
import type { ComposedRealGraph } from "../../lib/composition-root.js";
import type { EscalationAnswerGateway } from "../../lib/escalation-answers.js";
import { readEscalationAnswers } from "../../lib/escalation-answers.js";
import { buildBehindMainByPr, buildCreditCandidates, buildOpenPrViewsAsync, buildStaleGateWorkflowsByPr, fetchCiFailuresAsync, type TickReadFacts } from "../../lib/tick-read-worker.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects as buildSweepEffectsFromLib, dispatchFixCatchOutcome, fixRungTaskFor, discriminateReviewReuseAsync, projectMergedTaskCandidates, runSweep, runSweepLightPass, runCreditBackfill, renderSweepSummary, planOnlyRunBranchReceipts, withFullSweepRepairAdmission, createEscalationTriageHistoryReader, ESCALATION_TRIAGE_EVIDENCE_SLICE, createFullPreludeTimer, LightPassPreReviewTiming, observeLightPassReviewEligibility, runLightPassReadyRefresh, runLightPassRefreshAdmission, lightPassHeadContractRefresh, runArmedRatchetRejudge, isReviewLaneDisposition, deriveDisposition, type BuildSweepEffectsDeps, type SweepDeps, type OpenPrView, type ReviewDispatchMode, type ReviewReuseInputs, type BaseChangedFiles, type Disposition } from "../../lib/sweep.js";
import { missingReviewReuseFact, priorPostedReviewRow, reviewLedgerKeyFor, REVIEW_ENGINE_REVISION, REVIEW_CONTEXT, reviewEvidenceStrength, type ProofExecutor, type ReviewVerdict } from "../../lib/review.js";
import { resolveReviewProviderProvenance, reviewProviderProvenanceLedgerFields } from "../../lib/review-provider-provenance.js";
import { reviewCommand as reviewCommandFromModule, runReview as runReviewFromModule, type ReviewCommandDeps, type ReviewCommandHost } from "./review.js";
import { runFixRung as runFixRungFromModule, type FixCommandHost } from "./fix.js";
import type { RunTaskCommandHost } from "./run-task-verb.js";

type HostFn = (...args: any[]) => any;
export interface SweepCommandHost {
  readonly freshTreeGit?: (args: string[]) => string;
  readonly commandViews?: HostFn;
  readonly buildSweepEffects: (deps: Parameters<typeof buildSweepEffects>[1]) => ReturnType<typeof buildSweepEffects>;
  readonly USAGE: string;
  readonly DEFAULT_BUDGET_USD: number;
  readonly DEFAULT_WORKER_STALL_MS: number;
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
  readonly captureRepairFeedbackWithPriorVerdict: HostFn;
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
  readonly dispatchFixPreflightStandDown: HostFn;
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
  readonly readyDraftViaGh: HostFn;
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
  readonly updatedForWorkflowFromLedger: HostFn;
  runOneShotSweep(run: (pool: import("../../lib/sweep.js").HandedOffHeadJudgmentPool) =>
    Promise<import("../../lib/sweep.js").SweepSummary>): Promise<import("../../lib/sweep.js").SweepSummary>;
  readonly handedOffHeadRiskJudge: HostFn;
  readonly codeScanningJudgeDeps: HostFn;
  readonly sweepEscalationReconcile: HostFn;
  readonly sweepEscalationTriage: HostFn;
  readonly runAutomaticBranchReapRung: HostFn;
  readonly renderEscalationReconcileSummary: HostFn;
  readonly buildInboxDraftHook: HostFn;
  readonly createPlanFilingClassificationTelemetry: HostFn;
  readonly refreshEscalationTriageEvidence: HostFn;
  readonly tickReadReverificationDeps: HostFn;
  readonly gitCredentialFixSpawn: HostFn;
  readonly buildRereadPrAtAct: HostFn;
  readonly sweepPrTerminalRung: HostFn;
  readonly runTmpSweepRung: HostFn;
  readonly runWorkerTailSweepRung: HostFn;
  readonly runInflightLockSweepRung: HostFn;
  readonly runWorkerStallDetectorRung: HostFn;
  readonly runMountRecommenderRung: HostFn;
  readonly fixRungAllowedBesideInFlight: HostFn;
  readonly inFlightTaskIdsFrom: HostFn;
  readonly blockedFixableIsRequeueOnly: HostFn;
  readonly lightPassActionable: HostFn;
  readonly reviewOnlyLightPassDeps: HostFn;
  createLightPassCompareReader(owner: string, repo: string, read: (args: string[]) => Promise<unknown>): {
    retain(prs: readonly OpenPrView[]): void;
    read(prs: readonly OpenPrView[], main: string | undefined, timing: LightPassPreReviewTiming): Promise<{
      behindMainByPr: Map<number, number>;
      baseChangedFilesByPr: Map<number, BaseChangedFiles>;
    }>;
  };
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
    updateBranchViaGh, captureRepairFeedbackWithPriorVerdict, reclaimAbandonedWorker,
    registeredFixWorktreeOwner, captureRegisteredFixOwnerSnapshot,
    removeAbandonedFixWorktreeOwner, publishAbandonedFixOwnerAhead, preserveAbandonedFixOwnerDivergence,
    preserveOrDiscardFixOwnerResidue, preserveStagedFixOwnerResidue, preserveAndClearUntrackedFixOwner,
    preserveStaleDirtyFixOwner, clearStaleDirtyFixOwner, resetTrackedDirtyFixOwner,
    depReviewCommand, dispatchFixPreflightStandDown, ghLiveState, resolveFixRungTaskContractAtHeadAsync,
    createFixRungWorktreeWithToolchain, captureWorktreeSnapshotViaGit, writeFixCensusSnapshotAsync,
    runPlanScopedFixRound, materializePlanRoundWorktree, pushSweepFixRound,
    buildFixRungDispatchArgs, openTaskIdsFromPlan, waitForCiGreen, restRollupFor,
    buildRequiredFixReviewRunner, fetchPrBodyViaGh, updatePrBodyViaGh, repairPrMetadata,
    ghLiveHead, fetchPrDiffFilesViaGh, redBaseRefreshFactsFromRest,
    readyDraftViaGh, readFixRoundCommitsViaGit, runNpmScriptViaSpawn,
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
    createPlanFilingClassificationTelemetry, sweepPostFixReverification,
    updatedForWorkflowFromLedger, runOneShotSweep,
    handedOffHeadRiskJudge, codeScanningJudgeDeps,
    sweepEscalationReconcile, sweepEscalationTriage, runAutomaticBranchReapRung,
    renderEscalationReconcileSummary,
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
    buildInboxDraftHook, createPlanFilingClassificationTelemetry, buildSweepEffects,
    buildEscalationTriageRuntime, refreshEscalationTriageEvidence,
    sweepPostFixReverification, tickReadReverificationDeps, gitCredentialFixSpawn,
    updatedForWorkflowFromLedger,
    buildRereadPrAtAct, handedOffHeadRiskJudge, codeScanningJudgeDeps,
    sweepEscalationReconcile, sweepEscalationTriage, sweepPrTerminalRung, runAutomaticBranchReapRung,
    runTmpSweepRung, runWorkerTailSweepRung, runInflightLockSweepRung, runWorkerStallDetectorRung,
    DEFAULT_WORKER_STALL_MS, runMountRecommenderRung,
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
  io: {
    openPrViews?: () => Promise<OpenPrView[]>;
    effects?: (deps: Parameters<SweepCommandHost["buildSweepEffects"]>[0]) => SweepDeps;
    readCompare?: (args: string[]) => Promise<unknown>;
    clock?: Pick<Clock, "now">;
  } = {},
): (scope?: LightPassScope) => Promise<void> {
  const {
    createPlanFilingClassificationTelemetry, fixRungAllowedBesideInFlight, buildSweepEffects,
    inFlightTaskIdsFrom, blockedFixableIsRequeueOnly, lightPassActionable, reviewOnlyLightPassDeps,
    buildRereadPrAtAct, handedOffHeadRiskJudge, codeScanningJudgeDeps, createLightPassCompareReader,
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
