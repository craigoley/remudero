import { join } from "node:path";
import { loadConfig } from "../../lib/config.js";
import { type Config } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { appendLedger } from "../../lib/ledger.js";
import { deriveLedgerActor } from "../../lib/ledger.js";
import { systemClock } from "../../lib/clock.js";
import { type Clock } from "../../lib/clock.js";
import { loadPlan } from "../../lib/plan.js";
import { type Plan } from "../../lib/plan.js";
import { type MergedResolver } from "../../lib/plan.js";
import { repoRoot } from "../../lib/repo-location.js";
import { resolveOwnerRepo } from "../../lib/repo-location.js";
import { flagValue } from "../../lib/cli-args.js";
import { unknownArgError } from "../../lib/cli-args.js";
import { instanceMode } from "../../lib/instance-mode.js";
import { readInstanceRegistryText } from "../../lib/instance-mode.js";
import { checkReviewerCodeFreshnessAsync } from "../../lib/self-sync.js";
import { type ReviewerCodeFreshness } from "../../lib/self-sync.js";
import { buildBaseProofDir } from "../../lib/check-proof.js";
import { releaseBaseProofDir } from "../../lib/check-proof.js";
import { type BaseProofDir } from "../../lib/check-proof.js";
import { ghJsonAsync } from "../../lib/github-transport.js";
import { readLedgerLines } from "../../lib/status.js";
import { buildBatchedGithub } from "../../lib/status.js";
import { type GitHub } from "../../lib/status.js";
import { liveInflightRuns } from "../../lib/report-commands.js";
import { worktreeRemove } from "../../lib/worker.js";
import { runWorktreeReapRung } from "../../lib/worker.js";
import { type WorktreeReapSummary } from "../../lib/worker.js";
import { automaticBranchReapStateFileName } from "../../lib/branch-reaper.js";
import { readAutomaticBranchReapState } from "../../lib/branch-reaper.js";
import { writeAutomaticBranchReapState } from "../../lib/branch-reaper.js";
import { type AutomaticBranchReapState } from "../../lib/branch-reaper.js";
import { withMainHealthOnLightPass } from "../../lib/main-health-rung.js";
import { lightPassFixAdmitted } from "../../lib/daemon.js";
import { type LightPassScope } from "../../lib/daemon.js";
import { type ReviewAdmissionGate } from "../../lib/daemon.js";
import { type SweepCycleOutcome } from "../../lib/daemon.js";
import { type BoardSnapshotCache } from "../../lib/board-snapshot-cache.js";
import { type PanelGraphDeps } from "../../lib/panel-graph.js";
import { createPlanFilingFileCache } from "../../lib/open-prs-rest.js";
import { type GhCallPacer } from "../../lib/open-prs-rest.js";
import { configureEscalationTriage } from "../../lib/escalate.js";
import { escalatePostReviewStall } from "../../lib/escalation-catalogue.js";
import { ghPrDiffAsync } from "../../lib/pr-diff.js";
import { riskJudgePlanContextDigestFor } from "../../lib/risk-judge.js";
import { fixRebaseMergeFactsFromRest } from "../../lib/arm-auto-merge.js";
import { ghUpdateBranch } from "../../lib/arm-auto-merge.js";
import { readHeadShaRest } from "../../lib/arm-auto-merge.js";
import { reviewLedgerLegibilityFields } from "../../lib/review.js";
import { fetchPrLifecycle } from "../../lib/review.js";
import { postReviewStatusGuarded } from "../../lib/review.js";
import { applyMergeProbeEvidence } from "../../lib/merge-probe.js";
import { probeOpenPrMerges } from "../../lib/merge-probe.js";
import { GITHUB_COMPARE_FILES_LISTED } from "../../lib/base-reproduction.js";
import { type ComposedRealGraph } from "../../lib/composition-root.js";
import { type EscalationAnswerGateway } from "../../lib/escalation-answers.js";
import { readEscalationAnswers } from "../../lib/escalation-answers.js";
import { buildBehindMainByPr } from "../../lib/tick-read-worker.js";
import { buildCreditCandidates } from "../../lib/tick-read-worker.js";
import { buildOpenPrViewsAsync } from "../../lib/tick-read-worker.js";
import { buildStaleGateWorkflowsByPr } from "../../lib/tick-read-worker.js";
import { distanceRefreshProbeTargets } from "../../lib/tick-read-worker.js";
import { fetchCiFailuresAsync } from "../../lib/tick-read-worker.js";
import { type TickReadFacts } from "../../lib/tick-read-worker.js";
import { DEFAULT_SWEEP_POLICY } from "../../lib/sweep.js";
import { buildSweepEffects as buildSweepEffectsFromLib } from "../../lib/sweep.js";
import { dispatchFixCatchOutcome } from "../../lib/sweep.js";
import { fixRungTaskFor } from "../../lib/sweep.js";
import { discriminateReviewReuseAsync } from "../../lib/sweep.js";
import { projectMergedTaskCandidates } from "../../lib/sweep.js";
import { runSweep } from "../../lib/sweep.js";
import { runSweepLightPass } from "../../lib/sweep.js";
import { runCreditBackfill } from "../../lib/sweep.js";
import { renderSweepSummary } from "../../lib/sweep.js";
import { planOnlyRunBranchReceipts } from "../../lib/sweep.js";
import { withFullSweepRepairAdmission } from "../../lib/sweep.js";
import { createEscalationTriageHistoryReader } from "../../lib/sweep.js";
import { ESCALATION_TRIAGE_EVIDENCE_SLICE } from "../../lib/sweep.js";
import { createFullPreludeTimer } from "../../lib/sweep.js";
import { LightPassPreReviewTiming } from "../../lib/sweep.js";
import { observeLightPassReviewEligibility } from "../../lib/sweep.js";
import { runLightPassReadyRefresh } from "../../lib/sweep.js";
import { runLightPassRefreshAdmission } from "../../lib/sweep.js";
import { lightPassHeadContractRefresh } from "../../lib/sweep.js";
import { runArmedRatchetRejudge } from "../../lib/sweep.js";
import { isReviewLaneDisposition } from "../../lib/sweep.js";
import { deriveDisposition } from "../../lib/sweep.js";
import { type BuildSweepEffectsDeps } from "../../lib/sweep.js";
import { type SweepDeps } from "../../lib/sweep.js";
import { type OpenPrView } from "../../lib/sweep.js";
import { type ReviewDispatchMode } from "../../lib/sweep.js";
import { type ReviewReuseInputs } from "../../lib/sweep.js";
import { type BaseChangedFiles } from "../../lib/sweep.js";
import { type Disposition } from "../../lib/sweep.js";
import { missingReviewReuseFact } from "../../lib/review.js";
import { priorPostedReviewRow } from "../../lib/review.js";
import { reviewLedgerKeyFor } from "../../lib/review.js";
import { REVIEW_ENGINE_REVISION } from "../../lib/review.js";
import { REVIEW_CONTEXT } from "../../lib/review.js";
import { reviewEvidenceStrength } from "../../lib/review.js";
import { type ProofExecutor } from "../../lib/review.js";
import { type ReviewVerdict } from "../../lib/review.js";
import { resolveReviewProviderProvenance } from "../../lib/review-provider-provenance.js";
import { reviewProviderProvenanceLedgerFields } from "../../lib/review-provider-provenance.js";
import { reviewCommand as reviewCommandFromModule } from "./review.js";
import { runReview as runReviewFromModule } from "./review.js";
import { type ReviewCommandDeps } from "./review.js";
import { type ReviewCommandHost } from "./review.js";
import { runFixRung as runFixRungFromModule } from "./fix.js";
import { type FixCommandHost } from "./fix.js";
import { type RunTaskCommandHost } from "./run-task-verb.js";
import { reviewerFreshnessForPublication as reviewerFreshnessForPublicationFromModule } from "../../cli/commands/review.js";
import { ownStartFreshness as ownStartFreshnessFromModule } from "../../cli/commands/review.js";
import { type MaterializeReviewWorktreeResult } from "../../cli/commands/review.js";
import { type AddedTestsAtHead } from "../../cli/commands/run-task-verb.js";
import { type PublishAbandonedFixOwnerAheadDeps } from "../../cli/commands/run-task-verb.js";
import { hostWorktreeGitAtTopLevel } from "../../lib/check-proof.js";
import { recordBranchUpdate } from "../../lib/branch-update.js";
import { type BranchUpdateRecorder } from "../../lib/branch-update.js";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { ghExec } from "../../lib/github-transport.js";
import { ghTextAsync } from "../../lib/github-transport.js";
import { type GhAsyncExecutor } from "../../lib/github-transport.js";
import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { existsSync } from "node:fs";
import { fsyncSync } from "node:fs";
import { lstatSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { openSync } from "node:fs";
import { opendirSync } from "node:fs";
import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { readlinkSync } from "node:fs";
import { readSync } from "node:fs";
import { realpathSync } from "node:fs";
import { statSync } from "node:fs";
import { unlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { dirname } from "node:path";
import { isAbsolute } from "node:path";
import { relative } from "node:path";
import { resolve } from "node:path";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isHolderStale } from "../../lib/fs-race-safe.js";
import { readFileIfExists } from "../../lib/fs-race-safe.js";
import { isPromiseLike } from "../../lib/gardener.js";
import { runStepsEager } from "../../lib/gardener.js";
import { buildWorkerEnv } from "../../lib/env.js";
import { billingMode } from "../../lib/env.js";
import { renderFixPrompt } from "../../lib/prompt-render.js";
import { withReviewerWorktreeLease } from "../../lib/reviewer-worktree-lease.js";
import { REVIEWER_INCIDENT_FLAG } from "../../lib/reviewer-health.js";
import { REVIEWER_SHADOW_FLAG } from "../../lib/reviewer-health.js";
import { buildHealedReviewerTree } from "../../lib/reviewer-health.js";
import { evaluateReviewerHealth } from "../../lib/reviewer-health.js";
import { gitIn } from "../../lib/reviewer-health.js";
import { readReviewerHealthRows } from "../../lib/reviewer-health.js";
import { reviewerHealthStatePath } from "../../lib/reviewer-health.js";
import { reviewerRegressionEscalation } from "../../lib/reviewer-health.js";
import { type ReviewerIncident } from "../../lib/reviewer-health.js";
import { sweepStaleTempDirs } from "../../lib/tmp.js";
import { type TempSweepOpts } from "../../lib/tmp.js";
import { type TempSweepSummary } from "../../lib/tmp.js";
import { resolveInstallRoot } from "../../lib/install-root.js";
import { escalate } from "../../lib/escalate.js";
import { triageExistingEscalation } from "../../lib/escalate.js";
import { ghIssueGateway } from "../../lib/escalate.js";
import { ghIssueGatewayAsync } from "../../lib/escalate.js";
import { tryEscalate } from "../../lib/escalate.js";
import { tryEscalateAsync } from "../../lib/escalate.js";
import { type Escalation } from "../../lib/escalate.js";
import { type AsyncIssueGateway } from "../../lib/escalate.js";
import { type IssueGateway } from "../../lib/escalate.js";
import { type OpenIssue } from "../../lib/escalate.js";
import { prReferentFromIssueText } from "../../lib/escalate.js";
import { checkRunsRestArgs } from "../../lib/open-prs-rest.js";
import { type OpenPrRest } from "../../lib/open-prs-rest.js";
import { fetchSinglePrRestAsync } from "../../lib/open-prs-rest.js";
import { paceGhEntry } from "../../lib/open-prs-rest.js";
import { paceGhEntryAsync } from "../../lib/open-prs-rest.js";
import { type GhApiFetcher } from "../../lib/open-prs-rest.js";
import { PLAN_FILING_FILE_CACHE_MAX_ENTRIES } from "../../lib/open-prs-rest.js";
import { type MainRepairLane } from "../../lib/main-health-rung.js";
import { captureFeedback } from "../../lib/feedback.js";
import { feedbackCaptured } from "../../lib/feedback.js";
import { listFeedback } from "../../lib/feedback.js";
import { stageFeedbackCapture } from "../../lib/feedback.js";
import { type FeedbackEntry } from "../../lib/feedback.js";
import { type FeedbackOrigin } from "../../lib/feedback.js";
import { checkCommitMessage } from "../../lib/commit-message.js";
import { shapeCommitMessage } from "../../lib/commit-message.js";
import { isInPlanScope } from "../../lib/plan-architect.js";
import { draftsDueOnDaemon } from "../../lib/inbox.js";
import { resolvedInboxDraftLane } from "../../lib/inbox.js";
import { decideDraftDeferral } from "../../lib/inbox.js";
import { deferralFromOutcomes } from "../../lib/inbox.js";
import { parseDraftDeferralCache } from "../../lib/inbox.js";
import { DAEMON_DRAFT_BATCH_CAP } from "../../lib/inbox.js";
import { evictRefusalPoisonedKeys } from "../../lib/inbox.js";
import { markReopened } from "../../lib/inbox.js";
import { parseReopenedKeysCache } from "../../lib/inbox.js";
import { writeReopenedKeys } from "../../lib/inbox.js";
import { gitGrepAnchorTrue } from "../../lib/inbox.js";
import { warmAnchorGrepCache } from "../../lib/inbox.js";
import { warmedAnchorGrep } from "../../lib/inbox.js";
import { gitGrepAnchorTrueAsync } from "../../lib/inbox.js";
import { createAnchorGrepCache } from "../../lib/inbox.js";
import { readOriginMainSha } from "../../lib/inbox.js";
import { isRatifiedInLedger } from "../../lib/inbox.js";
import { parseDraftAttemptCache } from "../../lib/inbox.js";
import { parseDraftCache } from "../../lib/inbox.js";
import { createProposalShardReader } from "../../lib/inbox.js";
import { proposalShardDir } from "../../lib/inbox.js";
import { pruneOrphanedDraftsAsync } from "../../lib/inbox.js";
import { parseProposalRegistry } from "../../lib/inbox.js";
import { captureInboxDraftSnapshot } from "../../lib/inbox.js";
import { commitInboxDraftOutcomes } from "../../lib/inbox.js";
import { updateProposalRegistry } from "../../lib/inbox.js";
import { writeDraftAttemptPair } from "../../lib/inbox.js";
import { type DraftAttemptCache } from "../../lib/inbox.js";
import { type DraftCache } from "../../lib/inbox.js";
import { type DraftSelectionContext } from "../../lib/inbox.js";
import { type DraftRungOutcome } from "../../lib/inbox.js";
import { type EvidenceAnchor } from "../../lib/inbox.js";
import { type Proposal } from "../../lib/inbox.js";
import { declinedWithReceipts } from "../../lib/inbox-verdict-receipts.js";
import { readFeedbackDocketMarker } from "../../lib/feedback-docket.js";
import { writeFeedbackDocketMarker } from "../../lib/feedback-docket.js";
import { type PlanPrPreflightResult } from "../../lib/plan-pr-emitter.js";
import { filingAcceptanceCriteria } from "../../lib/plan-pr-emitter.js";
import { renderAcceptanceBlock } from "../../lib/plan-pr-emitter.js";
import { replaceAcceptanceBlock } from "../../lib/plan-pr-emitter.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../../lib/ledger.js";
import { feedbackLineagePayload } from "../../lib/contributor-admission.js";
import { feedbackLineageSnapshot } from "../../lib/contributor-admission.js";
import { observeFeedbackInputs } from "../../lib/contributor-admission.js";
import { envelope as feedbackLineageEnvelope } from "../../lib/untrusted-envelope.js";
import { benchmarkNonDispatchSpawn } from "../../lib/benchmark-run.js";
import { type AcceptanceCriterion } from "../../lib/plan.js";
import { loadMounts } from "../../lib/mounts.js";
import { mountsPath } from "../../lib/mounts.js";
import { type Mount } from "../../lib/mounts.js";
import { mountRecommendationProposalCandidate } from "../../lib/mount-recommender.js";
import { recommendMounts } from "../../lib/mount-recommender.js";
import { type MountHeadroomCell } from "../../lib/mount-recommender.js";
import { policyPath } from "../../lib/policy.js";
import { readRiskPolicy } from "../../lib/risk-judge.js";
import { realRiskJudge } from "../../lib/risk-judge.js";
import { resolveRiskJudgeMount } from "../../lib/risk-judge.js";
import { riskJudgeDiffInputBudget } from "../../lib/risk-judge.js";
import { riskJudgePlanContext } from "../../lib/risk-judge.js";
import { riskJudgePlanContextDigest } from "../../lib/risk-judge.js";
import { riskJudgeSpendCollector } from "../../lib/risk-judge.js";
import { type RiskJudgeChangeView } from "../../lib/risk-judge.js";
import { withoutRiskJudgePatches } from "../../lib/risk-judge.js";
import { acceptanceAuthorTimeCheck } from "../../lib/review.js";
import { acceptanceBlockRegion } from "../../lib/review.js";
import { extractTaskTrailerId } from "../../lib/review.js";
import { parseAcceptanceBlock } from "../../lib/review.js";
import { reviewerOutcome } from "../../lib/review.js";
import { reviewContractDigest } from "../../lib/review.js";
import { reviewInputDigest } from "../../lib/review.js";
import { resolvePlanCriteriaAtHead } from "../../lib/review.js";
import { type PlanCriteriaAtHeadResult } from "../../lib/review.js";
import { diagnoseBodyDefects } from "../../lib/body-repair.js";
import { criterionFieldTampered } from "../../lib/review.js";
import { filingSelfCreditCheck } from "../../lib/review.js";
import { planPrPreflightAtCommitAsync } from "../../lib/plan-pr-emitter.js";
import { isGhRateLimitError } from "../../lib/status.js";
import { taskIdFromRunBranch } from "../../lib/status.js";
import { readRequiredStatusCheckContexts } from "../../lib/status.js";
import { readyDraftPullRequest } from "../../lib/sweep.js";
import { isBlockedCi } from "../../lib/sweep.js";
import { listRetirableEscalationIssues } from "../../lib/sweep.js";
import { listRetirableEscalationIssuesAsync } from "../../lib/sweep.js";
import { indexEscalationTriageHistory } from "../../lib/sweep.js";
import { type EscalationTriageHistoryReader } from "../../lib/sweep.js";
import { type SweepSummary } from "../../lib/sweep.js";
import { closedPrFromRef } from "../../lib/sweep.js";
import { closedPrLookup } from "../../lib/sweep.js";
import { runPrTerminalReconcile } from "../../lib/sweep.js";
import { type PrTerminalReconcileSummary } from "../../lib/sweep.js";
import { runEscalationReconcile } from "../../lib/sweep.js";
import { runStaleEscalationRejudge } from "../../lib/sweep.js";
import { buildStaleEscalationRejudgePrompt } from "../../lib/sweep.js";
import { type StaleEscalationRejudgeCandidate } from "../../lib/sweep.js";
import { runPostFixReverification } from "../../lib/sweep.js";
import { terminalStateReason } from "../../lib/sweep.js";
import { usableInstrumentEntanglementPaths } from "../../lib/sweep.js";
import { type ArmedStalledPr } from "../../lib/sweep.js";
import { type CiFailure } from "../../lib/sweep.js";
import { type EscalationReconcileSummary } from "../../lib/sweep.js";
import { type FixClass } from "../../lib/sweep.js";
import { type FixDispatchEvidence } from "../../lib/sweep.js";
import { type FixOwnerResidue } from "../../lib/sweep.js";
import { type LiveStateResult } from "../../lib/sweep.js";
import { type PlanScopedFixRoundInput } from "../../lib/sweep.js";
import { type PostFixReverificationSummary } from "../../lib/sweep.js";
import { type ProofDiscriminationEvidence } from "../../lib/sweep.js";
import { type RepairFilingCapture } from "../../lib/sweep.js";
import { type UpdateBranchOutcome } from "../../lib/sweep.js";
import { DEFAULT_FIX_CLASSES } from "../../lib/sweep.js";
import { type MetadataRepairResult } from "../../lib/sweep.js";
import { riskJudgeHandedOffHead } from "../../lib/sweep.js";
import { handedOffHeadJudgmentPool } from "../../lib/sweep.js";
import { type HandedOffHeadJudgmentPool } from "../../lib/sweep.js";
import { awaitHandedOffHeadJudgments } from "../../lib/sweep.js";
import { riskJudgeCodeScanning } from "../../lib/sweep.js";
import { reviewOnlyStandDownReason } from "../../lib/sweep.js";
import { classifyUpdateBranchFailure } from "../../lib/fix-rung-classify.js";
import { ghJson } from "../../lib/worker.js";
import { parseReport } from "../../lib/worker.js";
import { removeWorktreeBase } from "../../lib/worker.js";
import { removeRunLock } from "../../lib/worker.js";
import { renderWorkerSettings } from "../../lib/worker.js";
import { spawnWorker } from "../../lib/worker.js";
import { hostWorktreeGit } from "../../lib/worktree-git.js";
import { hostWorktreeGitAsync } from "../../lib/worktree-git.js";
import { gitPushEmptyCommit } from "../../lib/git-push.js";
import { runStepsSync } from "../../lib/git-push.js";
import { step } from "../../lib/git-push.js";
import { type Steps } from "../../lib/git-push.js";
import { acquireDrainLock } from "../../lib/drain-lock.js";
import { defaultIsPidAlive } from "../../lib/drain-lock.js";
import { type DrainLockHandle } from "../../lib/drain-lock.js";
import { parseInflightLockInfo } from "../../lib/inflight-lock.js";
import { assertLiveWriteAllowed } from "../../lib/live-write-guard.js";
import { branchNamesFingerprint } from "../../lib/branch-reaper.js";
import { decideAutomaticBranchReap } from "../../lib/branch-reaper.js";
import { remoteBranchNamesSteps } from "../../lib/branch-reaper.js";
import { type BranchReapExec } from "../../lib/branch-reaper.js";
import { type LiveInflightRun } from "../../lib/report-commands.js";
import { type ClassifiedOpenPrView } from "../../lib/tick-read-worker.js";
import { type EscalationIntake } from "../../lib/tick-read-worker.js";
import { type PlanFilingClassificationEvent } from "../../lib/tick-read-worker.js";
import { type PlanFilingClassificationSource } from "../../lib/tick-read-worker.js";
import { type RollupCheck } from "../../lib/tick-read-worker.js";
import { attachPostedGateIds } from "../../lib/tick-read-worker.js";
import { buildEscalationReconcileCandidates } from "../../lib/tick-read-worker.js";
import { fetchCiFailures } from "../../lib/tick-read-worker.js";
import { openPrViewSteps } from "../../lib/tick-read-worker.js";
import { openPrsWithPostedIdsSteps } from "../../lib/tick-read-worker.js";

type HostFn = (...args: any[]) => any;
export interface SweepCommandHost {
readonly freshTreeGit?: (args: string[]) => string;
readonly commandViews?: HostFn;
readonly USAGE: string;
readonly DEFAULT_BUDGET_USD: number;
realDeps(): ComposedRealGraph;
reviewCommandHost(): ReviewCommandHost;
fixCommandHost(): FixCommandHost;
readonly materializeReviewWorktree: ReviewCommandHost["materializeReviewWorktree"];
readonly reviewPostedDescription: ReviewCommandHost["reviewPostedDescription"];
readonly buildBaseReproductionProbe: RunTaskCommandHost["buildBaseReproductionProbe"];
readonly buildImportClosureRead: HostFn;
readonly reclaimAbandonedWorker: HostFn;
readonly depReviewCommand: HostFn;
readonly ghLiveState: HostFn;
readonly resolveFixRungTaskContractAtHeadAsync: HostFn;
readonly captureWorktreeSnapshotViaGit: HostFn;
readonly writeFixCensusSnapshotAsync: HostFn;
pushSweepFixRound(deps: Pick<BuildSweepEffectsDeps, "log" | "repo">, wt: string, branch: string,
    expectedHeadSha?: string, priorHeadSha?: string): Promise<unknown>;
readonly openTaskIdsFromPlan: HostFn;
readonly waitForCiGreen: HostFn;
readonly restRollupFor: HostFn;
readonly fetchPrBodyViaGh: HostFn;
readonly updatePrBodyViaGh: HostFn;
readonly ghLiveHead: HostFn;
readonly fetchPrDiffFilesViaGh: HostFn;
readonly redBaseRefreshFactsFromRest: HostFn;
readonly readFixRoundCommitsViaGit: HostFn;
readonly runNpmScriptViaSpawn: HostFn;
readonly commitGeneratorOutputViaGit: HostFn;
readonly readPackageScriptsFor: HostFn;
readonly buildEscalationTriageRuntime: HostFn;
readonly runInflightLockSweepRung: HostFn;
  readonly readHeadShaRest: HostFn;
  readonly fixRebaseMergeFactsFromRest: HostFn;
  readonly ghUpdateBranch: HostFn;
  readonly prepareFreshOriginMainTree: HostFn;
  readonly freshTreeInspector: HostFn;
  readonly freshTreeFailureText: HostFn;
  readonly JUDGE_AT_OWN_START_FLAG: string;
  readonly runReview: HostFn;
  readonly prUrlTarget: HostFn;
  readonly ghUpdateBranchArgv: HostFn;
  readonly changeViewFromRows: HostFn;
  readonly changeViewArgs: HostFn;
  readonly prMetadataRestArgs: HostFn;
  readonly addedTestFilesAtHead: HostFn;
  readonly addedTestCriterion: HostFn;
  readonly acceptanceGateBodyRepair: HostFn;
  readonly execGrepProofInWorktree: HostFn;
  readonly workerChangedPaths: HostFn;
  readonly GIT_UNTRACKED_FILES_ALL: string;
  readonly namesATask: HostFn;
  readonly withGitCredentialSocket: HostFn;
  readonly prepareWorktreeToolchain: HostFn;
  readonly cleanupMaterializedWorktree: HostFn;
  readonly runFixRung: HostFn;
  readonly ciEvidenceDisagreementObservation: HostFn;
  readonly hostWorktreeGitResult: HostFn;
  readonly readTrackedDirtyOwnerPatch: HostFn;
  readonly preserveTrackedDirtyPatch: HostFn;
  readonly temporaryIndexTree: HostFn;
  readonly nulPaths: HostFn;
  readonly ZERO_GIT_OID: string;
  readonly FIX_BRANCH_CLAIM_PREFIX: string;
  readonly ghLiveStateByNumber: HostFn;
  readonly branchReapExec: HostFn;
  readonly reapBranchesSteps: HostFn;
  readonly capWorkerTailLines: HostFn;
  readonly draftProposalBatch: HostFn;
  readonly acceptedReviewAttemptId: HostFn;
  readonly mainRepairLaneFor: HostFn;
  readonly WORKER_STATE_LEDGER_STEP: string;
  readonly types?: {
    readonly FreshTreeReviewSeams: {
  /** `git -C <repoDir> …`, returning stdout. Throws on a non-zero exit, like `execFileSync`.
   *  Used for the FETCH and for proving a prior detached reviewer tree is safe to reuse — the
   *  worktree itself is still cut by {@link addWorktree} below. */
  git: (args: string[]) => string;
  /** THE REVIEW PATH'S OWN DETACHED-WORKTREE HELPER (`ReviewWorktreeDeps.addWorktree`,
   *  composition-root.ts), reused rather than re-spelled. `worktree-sites.ts` pins EXACTLY four
   *  raw `git worktree add` sites and refuses a fifth, correctly: this needs the same throwaway
   *  detached tree that helper already cuts for proof execution, just at the BASE revision instead
   *  of the PR head. One helper, two revisions — not a new hole in the census. */
  addWorktree: (repoDir: string, worktreePath: string, revision: string) => void;
  /** Run `rmd review <pr> …` with `cwd` at the fresh worktree. Resolves to the exit code; on a
   *  non-zero exit it first hands `onFailure` the child's bounded stderr tail (W1-T4055). */
  spawnReview: (worktree: string, args: string[], onFailure?: (failure: string) => void) => Promise<number>;
  /** Tests may replace ownership; production holds the general reaper's real run-lock token. */
  withWorktreeLease?: <T>(worktree: string, action: () => Promise<T>) => Promise<T>;
  /**
   * Classify the stable reviewer path before an add. `unsafe` deliberately combines a registered
   * path with a wrong ref, a branch checkout, dirt, a missing checkout, or an unreadable registry:
   * none proves a child would judge from the requested source revision. Optional only so the
   * production implementation remains one small, real git-backed default while focused tests can
   * name each preparation state without making a repository.
   */
  inspectExistingWorktree?: (
    repoDir: string,
    worktreePath: string,
    revision: string,
  ) => "absent" | "reusable" | "unsafe";
  /**
   * Make a new or safely reused tree runnable. The production default links the canonical
   * dependency install and records its generated link in git's common exclude. `false` is a
   * preparation refusal, never permission to run an incomplete reviewer tree.
   */
  prepareWorktree?: (repoDir: string, worktreePath: string) => boolean;
  /** Where worktrees are cut. One per code sha, reused across PRs in the same pass. */
  worktreeRoot: string;
};
    readonly CaptureRegisteredFixOwnerDeps: {
  processCensus?: (ownerPath: string) => ProcessCwdCensus;
  readClaim?: (inflightDir: string, claimKey: string) => "clear" | "occupied" | "unknown";
  now?: () => number;
  /** W1-T3822 capture-verification seams, shared with `preserveTrackedDirtyFixOwner`: both are
   *  siblings under the one `registeredOwnerRecovery` root, so they reuse this shape rather than
   *  mint a second one -- W1-T2894's ceiling only falls when siblings share (W1-T3744). */
  treesMatch?: (patchTree: string, ownerTree: string) => boolean;
  matchesDirtyRecovery?: (repoDir: string, recoveryRef: string, localSha: string, tree: string) => boolean;
  saveRecoveryFile?: (path: string, content: string) => void;
};
    readonly ProcessCwdCensus: | { state: "clear"; scanned: number }
  | { state: "occupied"; scanned: number; pid: number }
  | { state: "unknown"; scanned: number; reason: "proc_unavailable" | "cwd_unreadable" | "entry_bound" | "wall_bound" };
  };
}

type FreshTreeReviewSeams = NonNullable<SweepCommandHost["types"]>["FreshTreeReviewSeams"];
type CaptureRegisteredFixOwnerDeps = NonNullable<SweepCommandHost["types"]>["CaptureRegisteredFixOwnerDeps"];
type ProcessCwdCensus = NonNullable<SweepCommandHost["types"]>["ProcessCwdCensus"];

export async function sweepCommandWithHost(host: SweepCommandHost & Required<Pick<SweepCommandHost, "commandViews">>, rest: string[]): Promise<number> {
  const { USAGE, buildEscalationTriageRuntime } = host;
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
export { sweepCommandWithHost as sweepCommand };

export function buildSweepEffectsWithHost(
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
  const { realDeps, materializeReviewWorktree, reviewPostedDescription, buildBaseReproductionProbe, buildImportClosureRead, reclaimAbandonedWorker, depReviewCommand, ghLiveState, resolveFixRungTaskContractAtHeadAsync, captureWorktreeSnapshotViaGit, writeFixCensusSnapshotAsync, pushSweepFixRound, openTaskIdsFromPlan, waitForCiGreen, restRollupFor, fetchPrBodyViaGh, updatePrBodyViaGh, ghLiveHead, fetchPrDiffFilesViaGh, redBaseRefreshFactsFromRest, readFixRoundCommitsViaGit, runNpmScriptViaSpawn, commitGeneratorOutputViaGit, readPackageScriptsFor, DEFAULT_BUDGET_USD } = host;
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
export { buildSweepEffectsWithHost as buildSweepEffects };

export function buildSweepHookWithHost(
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
  const { buildEscalationTriageRuntime, runInflightLockSweepRung } = host;
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
export { buildSweepHookWithHost as buildSweepHook };

export function buildSweepLightHookWithHost(
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
export { buildSweepLightHookWithHost as buildSweepLightHook };

export function buildFreshTreeReviewRunnerWithHost(host: SweepCommandHost, 
  repoDir: string,
  deps: FreshTreeReviewSeams,
): (
  prArg: string,
  rest: string[],
  freshness: { originMainSha: string },
  onFailure?: (failure: string) => void,
) => Promise<number | undefined> {
  const prepareFreshOriginMainTree = host.prepareFreshOriginMainTree;
  const freshTreeInspector = host.freshTreeInspector;
  const freshTreeFailureText = host.freshTreeFailureText;
  const prepared = new Map<string, string>();
  return async (prArg, rest, freshness, onFailure) => {
    const sha = freshness.originMainSha;
    try {
      let worktree = prepared.get(sha);
      if (worktree === undefined) {
        // The fetch is what makes origin/main resolvable here at all; the daemon's own freshness
        // read already fetched, but this must not DEPEND on that having happened.
        deps.git(["-C", repoDir, "fetch", "--quiet", "origin", "main"]);
        worktree = prepareFreshOriginMainTree(repoDir, deps, "reviewer", sha);
        prepared.set(sha, worktree);
      }
      // RMD_SELF_SYNC_DONE keeps the child from trying to sync a checkout of its own: it is
      // already AT origin/main, and a self-sync attempt there is a refusal and a wasted fetch.
      const reviewerTree = worktree;
      const run = async () => {
        if (freshTreeInspector(deps)(repoDir, reviewerTree, sha) !== "reusable") {
          prepared.delete(sha);
          throw new Error(`cached reviewer worktree at ${reviewerTree} is no longer an exact clean detached checkout of ${sha}`);
        }
        return deps.spawnReview(reviewerTree, [prArg, ...rest], onFailure);
      };
      return await (deps.withWorktreeLease ?? withReviewerWorktreeLease)(reviewerTree, run);
    } catch (err) {
      prepared.delete(sha);
      // Never a verdict (see the doc above): swallow the failure, but carry WHY so a reader of
      // stderr — not just the caller's silent `undefined` — can tell a fetch/worktree/spawn
      // refusal from the ordinary "no runner wired" case. W1-T4055: and so can the ledger.
      process.stderr.write(`buildFreshTreeReviewRunner: falling back to the ordinary skip: ${String(err)}\n`);
      onFailure?.(freshTreeFailureText(String(err)));
      return undefined;
    }
  };
}
export { buildFreshTreeReviewRunnerWithHost as buildFreshTreeReviewRunner };

export function spawnRmdReviewForFreshTreeWithHost(host: SweepCommandHost, 
  worktree: string,
  args: string[],
  onFailure?: (failure: string) => void,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const freshTreeFailureText = host.freshTreeFailureText;
  return new Promise<number>((resolve, reject) => {
    // A daemon's installation token is copied at spawn and may expire during proof execution.
    // An App-backed child mints its own fresh token in main(); other callers keep their identity.
    const appConfigured = Boolean(parentEnv.GH_APP_ID && parentEnv.GH_APP_INSTALLATION_ID && parentEnv.GH_APP_PRIVATE_KEY_PATH);
    const child = spawn(join(worktree, "bin", "rmd"), ["review", ...args], {
      cwd: worktree,
      // W1-T4055: stderr is piped only to be TEED — every byte still reaches this process's stderr.
      stdio: ["inherit", "inherit", "pipe"],
      // The child IS at origin/main, so a self-sync there is a refusal and a wasted fetch.
      env: { ...parentEnv, RMD_SELF_SYNC_DONE: "1", ...(appConfigured ? { GH_TOKEN: "" } : {}) },
    });
    let held = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      held = (held + chunk.toString("utf8")).slice(-FRESH_TREE_STDERR_HOLD_CHARS);
    });
    child.on("error", reject);
    // `close`, not `exit`: only `close` guarantees the piped stderr has been read to its end.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) onFailure?.(signal && !held.trim() ? `killed by ${signal}` : freshTreeFailureText(held));
      resolve(exitCode);
    });
  });
}
export { spawnRmdReviewForFreshTreeWithHost as spawnRmdReviewForFreshTree };

export function buildReviewerCodeFreshnessGateWithHost(host: SweepCommandHost, 
  readFreshness: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
  log: (step: string, extra?: Record<string, unknown>) => void,
  next: (prArg: string, rest: string[], deps: ReviewCommandDeps) => Promise<number>,
  /** W1-T3723 — runs `rmd review` from a fresh worktree instead of skipping a stale-code PR; see
   *  {@link buildFreshTreeReviewRunner} for why the daemon's own checkout never moves. Returns
   *  `undefined` when it could not run at all, so the caller falls back to the original skip and
   *  W1-T3691's recurrence ladder stays the floor. W1-T4055: `onFailure` receives WHY, bounded. */
  reviewFromFreshTree?: (
    prArg: string,
    rest: string[],
    freshness: Extract<ReviewerCodeFreshness, { status: "stale" }>,
    onFailure?: (failure: string) => void,
  ) => Promise<number | undefined>,
): {
  call: (prArg: string, rest: string[], deps: ReviewCommandDeps) => Promise<number>;
  /** The sha pair the FIRST time THIS PASS'S freshness reads came back stale (there can be many,
   *  one per `call()`), or `undefined` when every read so far came back fresh, no PR reached the
   *  gate this pass, or every stale-looking read was actually unreadable. */
  staleThisPass: () => { oldSha: string; newSha: string } | undefined;
} {
  const reviewOptionFlags = reviewOptionFlagsWithHost.bind(undefined, host);
  const JUDGE_AT_OWN_START_FLAG = host.JUDGE_AT_OWN_START_FLAG;
  let firstStale: { oldSha: string; newSha: string } | undefined;
  return {
    call: async (prArg, rest, reviewDeps) => {
      // Read fresh for THIS PR, immediately before the spend it guards — never cached across the
      // pass (W1-T3697): a reading that changes between two PRs must be observed by the second PR
      // even though the first already ran under the earlier reading.
      const freshness = await readFreshness();
      if (freshness.status === "stale") {
        firstStale ??= { oldSha: freshness.codeSha, newSha: freshness.originMainSha };
        const stale = { pr: prArg, code_sha: freshness.codeSha, origin_main_sha: freshness.originMainSha, changed_paths: freshness.changedPaths?.length };
        // MOVE THE WORK, NOT THE CODE. Six pull requests once sat unreviewed for over an hour
        // behind a one-commit lag, and the only recovery was a process restart that a
        // multi-instance host then refused. A review does not need this process's modules — it
        // needs FRESH ones, and a subprocess out of a worktree at origin/main has them.
        if (reviewFromFreshTree) {
          // W1-T4055 — WHY, NOT ONLY WHETHER. 52 of 53 fresh-tree reviews once exited non-zero with
          // nothing but an exit code ledgered; the cause is what the next fix needs.
          let failure: string | undefined;
          const childArgs = [...rest, ...reviewOptionFlags(reviewDeps), JUDGE_AT_OWN_START_FLAG];
          return reviewFromFreshTree(prArg, childArgs, freshness, (why) => { failure = why; }).then((code) => {
            if (code !== undefined) {
              const why = code === 0 ? {} : { failure: failure ?? "no failure reported" };
              log("review.ran_from_fresh_tree", { ...stale, exit_code: code, ...why });
              return code;
            }
            // COULD NOT RUN — fall through to the original skip rather than judging with stale
            // code. W1-T3691's recurrence ladder still sees the skip and still escalates.
            const reason = failure ?? "no reason reported";
            log("review.skipped_stale_reviewer_code", { ...stale, fresh_tree: "unavailable", fresh_tree_reason: reason });
            return 0;
          });
        }
        log("review.skipped_stale_reviewer_code", stale);
        return 0;
      }
      // Operator ruling 2026-10-06: this reading is the review's START reading. The post-time
      // guard judges against it, so a merge landing mid-review no longer discards the verdict.
      return next(prArg, rest, { ...reviewDeps, reviewStartFreshness: freshness });
    },
    staleThisPass: () => firstStale,
  };
}
export { buildReviewerCodeFreshnessGateWithHost as buildReviewerCodeFreshnessGate };

export function buildReviewerHealthRouteWithHost(host: SweepCommandHost, 
  repoDir: string,
  config: Config,
  ledgerPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  tree: FreshTreeReviewSeams,
  issues?: AsyncIssueGateway,
  lane?: MainRepairLane,
): (prArg: string, rest: string[], reviewDeps: ReviewCommandDeps, normal: () => Promise<number>) => Promise<number> {
  const reviewerRevertLane = reviewerRevertLaneWithHost.bind(undefined, host);
  const prepareFreshOriginMainTree = host.prepareFreshOriginMainTree;
  const reviewOptionFlags = reviewOptionFlagsWithHost.bind(undefined, host);
  const JUDGE_AT_OWN_START_FLAG = host.JUDGE_AT_OWN_START_FLAG;
  const buildFreshTreeReviewRunner = buildFreshTreeReviewRunnerWithHost.bind(undefined, host);
  const git = gitIn(repoDir);
  const runId = `reviewer-health-${systemClock.now()}`;
  const self = (): { owner: string; repo: string } => resolveOwnerRepo();
  const escalation = { issues: issues ?? assigningIssueGateway(self().owner, self().repo, log), ledgerPath, runId };
  const repairLane = lane ?? reviewerRevertLane(self().owner, self().repo, config, ledgerPath, runId);
  const statePath = reviewerHealthStatePath(dirname(ledgerPath));
  const readRows = (cursor: Parameters<typeof readReviewerHealthRows>[1]) => readReviewerHealthRows(dirname(ledgerPath), cursor);
  const healthLog = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: "REVIEWER-HEALTH", step, lane: "review", ...extra });
  // A tree left at a healed path by an earlier process (its memo gone) is removed, then cut again.
  const cut = (prefix: string, sha: string): string => {
    try {
      return prepareFreshOriginMainTree(repoDir, tree, prefix, sha);
    } catch (error) {
      try {
        worktreeRemove(repoDir, `${tree.worktreeRoot}/${prefix}-${sha.slice(0, 12)}`);
      } catch {
        throw error; // deliberate: nothing was there to remove, so the cut's own refusal stands
      }
      return prepareFreshOriginMainTree(repoDir, tree, prefix, sha);
    }
  };
  const remove = (dir: string): void => worktreeRemove(repoDir, dir);
  const escalatedConflicts = new Set<string>();
  return async (prArg, rest, reviewDeps, normal) => {
    // An unreadable origin/main still ingests; no current reviewer is judged this call.
    const originMainSha = await git(["rev-parse", "origin/main"]).then((text) => text.trim(), () => null);
    const decision = await evaluateReviewerHealth({ originMainSha }, statePath, readRows, git, escalation, repairLane, healthLog, systemClock);
    if (decision.route === "normal") return normal();
    const incident: ReviewerIncident = decision.incident;
    // A healed tree built from a PR's head never reviews that same PR: the revert-built tree judges it.
    const withPr = decision.withPr !== null && String(decision.withPr) !== prArg ? decision.withPr : undefined;
    const healed = await buildHealedReviewerTree(repoDir, incident.offending!.sha, cut, remove, withPr === undefined ? {} : { withPr });
    if (healed.state === "empty") {
      log("reviewer.healed_patch_empty", { incident_id: incident.id, origin_main_sha: healed.originMainSha, pr: prArg });
      return normal();
    }
    if (healed.state !== "ready") {
      log("reviewer.healed_tree_unavailable", { incident_id: incident.id, pr: prArg, state: healed.state, reason: healed.reason,
        ...(healed.state === "conflict" ? { conflict_paths: healed.paths } : {}), origin_main_sha: healed.originMainSha });
      const key = `${incident.id}:${healed.originMainSha}`;
      if (healed.state === "conflict" && !escalatedConflicts.has(key)) {
        escalatedConflicts.add(key);
        // tryEscalateAsync never rejects; a failed filing is ledgered as escalation.failed.
        await tryEscalateAsync(reviewerRegressionEscalation(incident, healed), escalation);
      }
      return normal();
    }
    const childArgs = [...rest, ...reviewOptionFlags(reviewDeps), JUDGE_AT_OWN_START_FLAG];
    if (decision.shadow && originMainSha !== null) {
      // Today's reviewer, from the review path's own fresh origin/main tree, publishing nothing. The
      // runner never rejects: a failure reads undefined, its reason on the line below.
      let why: string | undefined;
      const code = await buildFreshTreeReviewRunner(repoDir, tree)(prArg, [...childArgs, REVIEWER_SHADOW_FLAG], { originMainSha }, (failure) => { why = failure; });
      log("reviewer.shadow_ran", { incident_id: incident.id, pr: prArg, origin_main_sha: originMainSha, exit_code: code ?? null,
        ...(why === undefined ? {} : { failure: why }) });
    }
    let failure: string | undefined;
    let code: number;
    try {
      code = await (tree.withWorktreeLease ?? withReviewerWorktreeLease)(healed.path, () =>
        tree.spawnReview(healed.path, [prArg, ...childArgs, REVIEWER_INCIDENT_FLAG, incident.id], (why) => { failure = why; }));
    } catch (error) {
      // COULD NOT RUN: today's path reviews, as it would with no incident; never an older reviewer.
      log("reviewer.healed_review_failed", { incident_id: incident.id, pr: prArg, healed_sha: healed.sha, error: String((error as Error)?.message ?? error) });
      return normal();
    }
    log("review.ran_from_healed_tree", { incident_id: incident.id, pr: prArg, healed_sha: healed.sha, origin_main_sha: healed.originMainSha,
      offending_sha: incident.offending!.sha, patch: healed.patch, ...(healed.withPr === undefined ? {} : { with_pr: healed.withPr }),
      exit_code: code, ...(code === 0 ? {} : { failure: failure ?? "no failure reported" }) });
    return code;
  };
}
export { buildReviewerHealthRouteWithHost as buildReviewerHealthRoute };

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

export function buildRequiredFixReviewRunnerWithHost(host: SweepCommandHost, 
  next: typeof runReview,
  readFreshness: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): typeof runReview {
  const runReview = host.runReview;
  return async (args) => {
    const startFreshness = await ownStartFreshness(readFreshness);
    return next({ ...args, requireSemanticReview: true,
      reviewerCodeFreshness: reviewerFreshnessForPublication(startFreshness, readFreshness) });
  };
}
export { buildRequiredFixReviewRunnerWithHost as buildRequiredFixReviewRunner };

export function codeScanningJudgeDepsWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  config: Config,
  plan: Plan,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  spawn?: typeof spawnWorker,
  fetchFiles: (args: string[]) => Promise<unknown> = ghJsonAsync,
): Pick<SweepDeps, "judgeCodeScanningAlerts" | "postCodeScanningRuling"> {
  const prUrlTarget = host.prUrlTarget;
  return {
    judgeCodeScanningAlerts: riskJudgeCodeScanning(async (pr, alerts) => {
      const task = pr.taskId === undefined ? undefined : plan.byId.get(pr.taskId);
      const spend = riskJudgeSpendCollector();
      const patches = new Map<string, string>();
      const target = prUrlTarget(pr.prUrl);
      if (target) {
        const rows = await fetchFiles(["api", `repos/${target.owner}/${target.repo}/pulls/${target.number}/files?per_page=100`]);
        for (const row of Array.isArray(rows) ? (rows as Array<{ filename?: unknown; patch?: unknown }>) : []) {
          if (typeof row.filename === "string" && typeof row.patch === "string") patches.set(row.filename, row.patch.slice(0, 6000));
        }
      }
      return {
        input: {
          change: { description: `${task?.title ?? `PR #${pr.prNumber}`} — ${pr.prUrl}`, files: task?.files },
          gatesState: { review_state: pr.reviewState, checks_state: pr.checksState, owner: "sweep (code-scanning alert)" },
          planContext: { taskId: pr.taskId, taskType: task?.type },
          codeScanning: {
            alerts: alerts.map((a) => ({
              ruleId: a.ruleId, severity: a.severity, message: a.message, path: a.path, line: a.line,
              ...(patches.has(a.path) ? { hunk: patches.get(a.path) } : {}),
            })),
          },
        },
        config: { confidenceThreshold: readRiskPolicy(policyPath(repoRoot)).confidenceThreshold },
        orchestrator: {
          spend,
          log,
          judge: async (input) => {
            const settingsFile = renderWorkerSettings({
              templatePath: join(resolveInstallRoot(config), "settings", "worker.json"),
              hooksDir: join(resolveInstallRoot(config), "hooks"),
              outPath: join(config.root, "tmp", `risk-judge-settings-${runId}.json`),
            });
            const mount = resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot)));
            return realRiskJudge({ mount, cwd: config.root, settingsFile, spawn, spend })(input);
          },
          escalate: () => "",
        },
      };
    }),
    postCodeScanningRuling: (pr, body) => {
      ghExec(["pr", "comment", pr.prUrl, "--repo", `${owner}/${repo}`, "--body", body], { stdio: "pipe" });
    },
  };
}
export { codeScanningJudgeDepsWithHost as codeScanningJudgeDeps };

export function handedOffHeadRiskJudgeWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  config: Config,
  plan: Plan,
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  spawn?: typeof spawnWorker,
  escalateImpl: typeof escalate = escalate,
  readChangeView: (prUrl: string) => RiskJudgeChangeView | Promise<RiskJudgeChangeView> = changeViewAsyncWithHost.bind(undefined, host),
): NonNullable<SweepDeps["judgeHandedOffHead"]> {
  const changeViewAsync = changeViewAsyncWithHost.bind(undefined, host);
  return riskJudgeHandedOffHead((pr, signal) => {
    const task = pr.taskId === undefined ? undefined : plan.byId.get(pr.taskId);
    const spend = riskJudgeSpendCollector();
    let viewRead: Promise<RiskJudgeChangeView> | undefined;
    const readViewOnce = (): Promise<RiskJudgeChangeView> => (viewRead ??= (async () => readChangeView(pr.prUrl))());
    return {
      input: {
        change: { description: `${task?.title ?? `PR #${pr.prNumber}`} — ${pr.prUrl}`, files: task?.files },
        gatesState: { review_state: pr.reviewState, checks_state: pr.checksState, owner: "sweep (handed-off head)" },
        planContext: riskJudgePlanContext(pr.taskId, task),
        planContextDigest: riskJudgePlanContextDigest(task),
      },
      config: (() => {
        const riskPolicy = readRiskPolicy(policyPath(repoRoot));
        return { confidenceThreshold: riskPolicy.confidenceThreshold, borderlineBand: riskPolicy.borderlineBand };
      })(),
      orchestrator: {
        spend,
        log,
        // W1-T7724: the change view is read ONCE per head; the description tier shows its counts and the diff
        // tier (an uncertain `low`) reads its patches from the same read — no second GitHub call.
        diffSource: {
          read: readViewOnce,
          inputBudgetChars: (tier1Chars) =>
            riskJudgeDiffInputBudget(resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot))))(tier1Chars),
        },
        judge: async (input) => {
          const settingsFile = renderWorkerSettings({
            templatePath: join(resolveInstallRoot(config), "settings", "worker.json"),
            hooksDir: join(resolveInstallRoot(config), "hooks"),
            outPath: join(config.root, "tmp", `risk-judge-settings-${runId}.json`),
          });
          const mount = resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot)));
          const judged = { ...input, change: { ...input.change, changeView: withoutRiskJudgePatches(await readViewOnce()) } };
          return realRiskJudge({ mount, cwd: config.root, settingsFile, spawn, spend, signal })(judged);
        },
        escalate: (verdict, action) =>
          escalateImpl(
            {
              class: "BLOCKED",
              taskId: pr.taskId ?? `PR-${pr.prNumber}`,
              runId,
              headSha: pr.headSha,
              summary: `risk judge ESCALATED a handed-off head (${verdict.verdict}, confidence ${verdict.confidence.toFixed(2)}) — ${pr.prUrl}`,
              detail: `${action.reason}\n\nThe sweep held auto-merge for head ${pr.headSha}; it was NOT armed unattended.`,
              options: [
                {
                  label: "review-manually",
                  detail: "read the diff and either merge it by hand or push a follow-up fix; a new head is judged again.",
                },
              ],
              recommendation: "review-manually",
            },
            { issues: ghIssueGateway(owner, repo), ledgerPath, runId },
          ),
      },
    };
  });
}
export { handedOffHeadRiskJudgeWithHost as handedOffHeadRiskJudge };

export async function refreshEscalationTriageEvidenceWithHost(host: SweepCommandHost, 
  runtime: Pick<ReturnType<typeof buildEscalationTriageRuntime>, "refresh">,
  ledgerPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const buildEscalationTriageRuntime = host.buildEscalationTriageRuntime;
  try {
    await runtime.refresh(ledgerPath);
  } catch (e) {
    log("escalation_triage.evidence_refresh_failed", { error: String((e as Error)?.message ?? e) });
  }
}
export { refreshEscalationTriageEvidenceWithHost as refreshEscalationTriageEvidence };

export async function updateBranchViaGhWithHost(host: SweepCommandHost, pr: ArmedStalledPr, record?: BranchUpdateRecorder): Promise<UpdateBranchOutcome> {
  const ghUpdateBranchArgv = host.ghUpdateBranchArgv;
  assertLiveWriteAllowed("gh-pr-merge", `requesting the update-branch REST endpoint on ${pr.prUrl}`);
  const ownerRepo = ownerRepoFromPrUrl(pr.prUrl);
  if (!ownerRepo) return "error";
  const fields = { repo: `${ownerRepo.owner}/${ownerRepo.repo}`, prNumber: pr.prNumber,
    via: `sweep:${pr.updateReason ?? "refresh"}`, expectedHeadSha: pr.headSha };
  try {
    ghExec(ghUpdateBranchArgv(ownerRepo.owner, ownerRepo.repo, pr.prNumber, pr.headSha), { stdio: "pipe" });
    recordBranchUpdate({ ...fields, outcome: "updated" }, record);
    return "updated";
  } catch (e) {
    const msg = String((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e);
    const outcome = classifyUpdateBranchFailure(msg);
    recordBranchUpdate({ ...fields, outcome, error: msg }, record);
    return outcome;
  }
}
export { updateBranchViaGhWithHost as updateBranchViaGh };

export async function changeViewAsyncWithHost(host: SweepCommandHost, 
  prUrl: string,
  fetch: (args: string[]) => Promise<unknown> = ghJsonAsync,
): Promise<RiskJudgeChangeView> {
  const changeViewFromRows = host.changeViewFromRows;
  const changeViewArgs = host.changeViewArgs;
  return changeViewFromRows(await fetch(changeViewArgs(prUrl)));
}
export { changeViewAsyncWithHost as changeViewAsync };

export async function repairPrMetadataWithHost(host: SweepCommandHost, 
  pr: Pick<OpenPrView, "prUrl"> & Partial<Pick<OpenPrView, "headSha">>,
  checks: readonly string[],
  write: (url: string, fields: { title?: string; body?: string }) => void =
    (url, fields) => { ghExec(prMetadataRestArgs(url, fields), { stdio: "pipe" }); },
  read: (url: string) => { title?: string; body?: string } = (url) => {
    const target = prUrlTarget(url);
    if (!target) throw new Error(`metadata read: cannot resolve PR URL ${JSON.stringify(url)}`);
    return ghJson(["api", `repos/${target.owner}/${target.repo}/pulls/${target.number}`]) as { title?: string; body?: string };
  },
  /** W1-T5544: the task criteria the gate itself resolves for this body at the PR head (`[]` = unreadable or untrailered). */
  planCriteriaAtHead: (body: string, headSha: string) => readonly AcceptanceCriterion[] = planCriteriaAtHeadForRepairWithHost.bind(undefined, host),
  /** The test files this PR head ADDS against main — absent at base, so a `unit test:` on one cannot pass there. */
  addedTestsAtHead: (headSha: string) => AddedTestsAtHead = host.addedTestFilesAtHead,
): Promise<MetadataRepairResult> {
  const prMetadataRestArgs = host.prMetadataRestArgs;
  const prUrlTarget = host.prUrlTarget;
  const planCriteriaAtHeadForRepair = planCriteriaAtHeadForRepairWithHost.bind(undefined, host);
  const addedTestFilesAtHead = host.addedTestFilesAtHead;
  const addedTestCriterion = host.addedTestCriterion;
  const acceptanceGateBodyRepair = host.acceptanceGateBodyRepair;
  const live = read(pr.prUrl);
  const fields: { title?: string; body?: string } = {};
  const bodyChecked = checks.includes("acceptance-author-gate") || checks.includes("proof-discrimination");
  if (checks.includes("commitlint")) {
    const liveTitle = live.title;
    if (typeof liveTitle !== "string" || liveTitle.trim() === "") {
      return { repaired: false, reason: "live PR title is unavailable" };
    }
    if (checkCommitMessage(liveTitle).length === 0) {
      if (!bodyChecked) {
        return { repaired: false, notMetadata: true, reason: "live PR title already satisfies commitlint; the red is not a title defect" };
      }
    } else {
      const conventional = liveTitle.match(/^((?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?):\s*(.*)$/i);
      const prefix = conventional && conventional[1] === conventional[1].toLowerCase() ? conventional[1] : "fix(pr)";
      const subject = conventional?.[2]?.trim() || liveTitle.trim();
      fields.title = shapeCommitMessage(prefix, subject).header;
      if (checkCommitMessage(fields.title).length > 0) {
        return { repaired: false, reason: "candidate PR title did not satisfy commitlint" };
      }
    }
  }
  if (bodyChecked) {
    if (live.body === undefined) return { repaired: false, reason: "live PR body is unavailable" };
    // W1-T5544: the two gate-refusal cures apply ONLY while acceptance-author-gate is itself red — a
    // proof-discrimination-only red is never cured by rewriting a body that gate does not read.
    const gateRed = checks.includes("acceptance-author-gate");
    const planCriteria = gateRed && pr.headSha ? planCriteriaAtHead(live.body, pr.headSha) : [];
    // Never the generic grep of a function main already has: proof-discrimination reads it executed_stale, so the
    // "repair" was a guaranteed red (#10404, #10413). Only a proof derived from a test the diff ADDS misses at base.
    const added: AddedTestsAtHead = pr.headSha ? addedTestsAtHead(pr.headSha) : { kind: "unreadable", reason: "no PR head sha" };
    const headOnly = added.kind === "read" ? added.files.map(addedTestCriterion) : [];
    const gate = acceptanceAuthorTimeCheck(live.body);
    if (!gate.ok && (gate.defect === "no-header" || gate.defect === "empty-proofs") && headOnly.length === 0) {
      const why = added.kind === "read" ? "the diff adds no test file" : added.reason;
      return {
        repaired: false,
        noCure: true,
        reason:
          `the body has no judgeable Acceptance block and ${why}, so no proof that misses at base is derivable; ` +
          "a generic block would pass at base and fail proof-discrimination",
      };
    }
    const repair = acceptanceGateBodyRepair(live.body, headOnly, gateRed ? { planCriteria } : undefined);
    if (!repair) {
      return {
        repaired: false,
        noCure: true,
        reason: "the body red has no deterministic acceptance repair; scope or proof amendment is required",
      };
    }
    fields.body = repair.repairedBody;
  }
  if (fields.title === undefined && fields.body === undefined) {
    return { repaired: false, reason: "no title or body edit was derived" };
  }
  write(pr.prUrl, fields);
  return { repaired: true, reason: `edited ${Object.keys(fields).join(" and ")} through the PR REST endpoint` };
}
export { repairPrMetadataWithHost as repairPrMetadata };

export function planCriteriaAtHeadForRepairWithHost(host: SweepCommandHost, body: string, headSha: string, cwd: string = process.cwd()): readonly AcceptanceCriterion[] {
  const resolveFixRungTaskContractAtHead = resolveFixRungTaskContractAtHeadWithHost.bind(undefined, host);
  const taskId = extractTaskTrailerId(body);
  if (taskId === undefined) return [];
  try {
    hostWorktreeGitAtTopLevel(cwd, ["cat-file", "-e", `${headSha}^{commit}`]);
  } catch {
    // The head object is not local yet (a branch pushed since the last fetch): ask origin for it once.
    try {
      hostWorktreeGitAtTopLevel(cwd, ["fetch", "--quiet", "origin", headSha], { timeout: 60_000 });
    } catch {
      // Unreadable head means unreadable plan: no divergence cure, and the escalation still carries its reason.
      return [];
    }
  }
  return resolveFixRungTaskContractAtHead("", taskId, cwd, () => headSha)!.criteria;
}
export { planCriteriaAtHeadForRepairWithHost as planCriteriaAtHeadForRepair };

export async function runPlanScopedFixRoundWithHost(host: SweepCommandHost, input: PlanScopedFixRoundInput): Promise<{ outcome: "pushed" | "refused" | "metadata-repaired"; headSha?: string; reason?: string; preflight?: PlanPrPreflightResult }> {
  const runPlanScopedConflictRound = runPlanScopedConflictRoundWithHost.bind(undefined, host);
  const acceptanceGateBodyRepair = host.acceptanceGateBodyRepair;
  const execGrepProofInWorktree = host.execGrepProofInWorktree;
  const workerChangedPaths = host.workerChangedPaths;
  const GIT_UNTRACKED_FILES_ALL = host.GIT_UNTRACKED_FILES_ALL;
  const namesATask = host.namesATask;
  if (input.conflict === true) return runPlanScopedConflictRound(input);
  const { pr, deps, worktreePath } = input;
  const git = deps.runGit ?? ((args: string[]) => hostWorktreeGit(worktreePath, args));
  const preflightImpl = deps.preflight ?? planPrPreflightAtCommitAsync;
  const preflight = (tree: string, sha: string, meta: { title: string; body: string }) => deps.preflight
    ? preflightImpl(tree, sha, { ...meta, headRef: pr.headRefName })
    : planPrPreflightAtCommitAsync(tree, sha, { ...meta, headRef: pr.headRefName }, { log: deps.log });
  const files = input.task.files.filter((path) => isInPlanScope(path) && !path.split("/").includes(".."));
  let roundId: string | undefined;
  const roundFields = () => ({ task_id: input.task.id, pr_number: pr.prNumber, head_sha: pr.headSha,
    round_id: roundId, strike: pr.priorStrikes + 1, mode: "plan-gate" });
  const refuse = (reason: string, verdict?: PlanPrPreflightResult) => {
    if (roundId) {
      deps.log("fix.commit_refused", { ...roundFields(), reason });
      deps.log("fix.done", { ...roundFields(), subtype: "commit_refused" });
    }
    return { outcome: "refused" as const, reason, preflight: verdict };
  };
  let metadata = { title: input.title, body: input.body };
  try {
    if (files.length === 0) return refuse("the filing has no stageable plan paths");
    if (git(["rev-parse", "HEAD"]).trim() !== pr.headSha) return refuse("the plan round head moved before dispatch");
    const initial = await preflight(worktreePath, pr.headSha, metadata);
    const existing = new Set(files.filter((path) => git(["ls-tree", "--name-only", "origin/main", "--", path]).trim() !== ""));
    const introduced = files.filter((path) => !existing.has(path) && /^plan\/tasks\.d\/.*\.ya?ml$/.test(path))
      .flatMap((path) => [...git(["show", `${pr.headSha}:${path}`]).matchAll(/^\s*-?\s*id:\s*(\S+)/gm)].map((m) => m[1]!));
    let repairedBody = metadata.body;
    const selfCredit = filingSelfCreditCheck(repairedBody, introduced);
    if (!selfCredit.ok) repairedBody = repairedBody.replace(/^Remudero-Task:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/gm,
      (line, id: string) => id === selfCredit.taskId ? "" : line).trimEnd();
    const structural = acceptanceGateBodyRepair(repairedBody, introduced.length ? filingAcceptanceCriteria(introduced, files) : undefined);
    if (structural) repairedBody = structural.repairedBody;
    const defects = diagnoseBodyDefects(repairedBody, parseAcceptanceBlock(repairedBody), { execProof: deps.execProof ?? execGrepProofInWorktree(worktreePath) });
    for (const defect of defects) {
      if (defect.kind !== "wrapped-proof" || !defect.repair || !defect.criterion) continue;
      const proof = parseAcceptanceBlock(repairedBody)[defect.criterion - 1]?.proof;
      if (proof) repairedBody = repairedBody.replace(proof, defect.repair);
    }
    if (repairedBody !== metadata.body) {
      const candidate = { ...metadata, body: repairedBody };
      const verdict = await preflight(worktreePath, pr.headSha, candidate);
      if (!acceptanceAuthorTimeCheck(repairedBody).ok || !filingSelfCreditCheck(repairedBody, introduced).ok) return refuse("the repaired filing body fails author-time acceptance", verdict);
      if (verdict.ok && verdict.unreadable.length === 0 && verdict.timedOut === undefined) {
        await deps.updateMetadata(candidate);
        return { outcome: "metadata-repaired", headSha: pr.headSha, preflight: verdict };
      }
      metadata = candidate;
    }
    roundId = `${input.runId ?? input.task.id}:${pr.priorStrikes + 1}:${systemClock.now()}`;
    deps.log("fix.dispatch", { ...roundFields(), verdict_regime: "executed" });
    await observeFeedbackInputs(input.admission, pr.pendingAnswer?.contributions ?? [], "plan-fix-adoption", deps.log,
      deps.feedbackRead);
    const report = await deps.spawn(renderFixPrompt({ task: { ...input.task, files }, round: 1, branch: pr.headRefName!,
      harnessCommits: true, evidence: { planGateFindings: [...initial.failures, ...initial.unreadable], ciFailures: pr.ciFailures,
        constraint: [input.lastRefusal, feedbackFixConstraint(pr.pendingAnswer)].filter(Boolean).join("\n\n") || undefined } }));
    if (git(["rev-parse", "HEAD"]).trim() !== pr.headSha) return refuse("the worker moved the plan round head");
    const changed = workerChangedPaths(git(["status", "--porcelain", "-z", GIT_UNTRACKED_FILES_ALL]));
    const outside = changed.filter((path) => !files.includes(path));
    if (outside.length) return refuse(`plan round changed paths outside the PR's own plan paths: ${outside.join(", ")}`);
    for (const path of changed.filter((p) => existing.has(p))) {
      const diff = git(["diff", "HEAD", "--", path]);
      const prior = git(["diff", "--unified=0", `origin/main...${pr.headSha}`, "--", path]);
      if (untouchedPlanCriterion(diff, prior, path)) return refuse(`plan round changed an untouched criterion in ${path}`);
    }
    const proposedTitle = /^PR_TITLE:[ \t]*(.+)$/m.exec(report)?.[1];
    const proposedAcceptance = /^PR_ACCEPTANCE:[ \t]*\r?\n([\s\S]*?)^END_PR_ACCEPTANCE[ \t]*$/m.exec(report)?.[1];
    if (proposedTitle) metadata.title = proposedTitle.trim();
    if (proposedAcceptance) {
      const check = acceptanceAuthorTimeCheck(proposedAcceptance);
      if (!check.ok) return refuse(check.message);
      metadata.body = replaceAcceptanceBlock(metadata.body, parseAcceptanceBlock(proposedAcceptance));
    }
    if (!filingSelfCreditCheck(metadata.body, introduced).ok || !acceptanceAuthorTimeCheck(metadata.body).ok) return refuse("the proposed filing body fails author-time acceptance");
    let sha = pr.headSha;
    if (changed.length) {
      const message = parseReport(report)?.commitMessage;
      if (!message || checkCommitMessage(message).length) return refuse("the plan round needs a valid COMMIT_MESSAGE");
      git(["add", "-A", "--", ...changed]);
      const filedTask = taskIdFromRunBranch(pr.headRefName) === input.task.id && namesATask(input.task.id);
      git(["commit", "-m", message, ...(filedTask ? ["-m", `Remudero-Task: ${input.task.id}`] : [])]);
      sha = git(["rev-parse", "HEAD"]).trim();
    } else if (metadata.title === input.title && metadata.body === input.body) return refuse("the worker changed nothing");
    const verdict = await preflight(worktreePath, sha, metadata);
    // A check that ran out of its budget has no verdict, so it holds the push like an unreadable one.
    if (!verdict.ok || verdict.unreadable.length || verdict.timedOut) return refuse((verdict.failures[0] ?? verdict.unreadable[0] ?? verdict.timedOut?.[0])!.firstLine, verdict);
    if (metadata.title !== input.title || metadata.body !== input.body) await deps.updateMetadata(metadata);
    if (sha === pr.headSha) {
      deps.log("fix.done", { ...roundFields(), subtype: "success" });
      return { outcome: "metadata-repaired", headSha: sha, preflight: verdict };
    }
    await deps.push(sha);
    deps.log("fix.done", { ...roundFields(), subtype: "success", pushed_head_sha: sha });
    return { outcome: "pushed", headSha: sha, preflight: verdict };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    deps.log("sweep.plan_round.error", { pr_number: pr.prNumber, head_sha: pr.headSha, reason });
    return refuse(reason);
  }
}
export { runPlanScopedFixRoundWithHost as runPlanScopedFixRound };

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

export function gitCredentialFixSpawnWithHost(host: SweepCommandHost, 
  socketPath: string,
  raw: typeof spawnWorker = spawnWorker,
  harnessCheckout: string = repoRoot,
): typeof spawnWorker {
  const withGitCredentialSocket = host.withGitCredentialSocket;
  const spawnFix = benchmarkNonDispatchSpawn("sweep-fix", raw);
  return (args) => spawnFix(withGitCredentialSocket(args, socketPath, harnessCheckout));
}
export { gitCredentialFixSpawnWithHost as gitCredentialFixSpawn };

export function materializePlanRoundWorktreeWithHost(host: SweepCommandHost, config: Config, repoDir: string, prNumber: number, headSha: string,
  deps: Pick<ReviewCommandDeps, "materialize"> & { prepare?: FreshTreeReviewSeams["prepareWorktree"] } = {},
): MaterializeReviewWorktreeResult {
  const materializeReviewWorktree = host.materializeReviewWorktree;
  const prepareWorktreeToolchain = host.prepareWorktreeToolchain;
  const cleanupMaterializedWorktree = host.cleanupMaterializedWorktree;
  const result = (deps.materialize ?? materializeReviewWorktree)(config, repoDir, prNumber, headSha);
  if (result.worktreePath && !(deps.prepare ?? prepareWorktreeToolchain)(repoDir, result.worktreePath)) {
    cleanupMaterializedWorktree(worktreeRemove, repoDir, result.worktreePath);
    return { worktreePath: undefined, failure: { errorClass: "other", message: "plan round toolchain unavailable" } };
  }
  return result;
}
export { materializePlanRoundWorktreeWithHost as materializePlanRoundWorktree };

export function resolveFixRungTaskContractAtHeadWithHost(host: SweepCommandHost, 
  prUrl: string,
  taskId: string,
  repoDir: string,
  readHeadSha: (prUrl: string) => string = host.readHeadShaRest,
): PlanCriteriaAtHeadResult | undefined {
  const readHeadShaRest = host.readHeadShaRest;
  let headSha: string;
  try {
    headSha = readHeadSha(prUrl);
  } catch {
    // The caller distinguishes "unreadable" from "readable-but-empty" only by presence/absence
    // of a result — an unreadable HEAD is unreadable regardless of which read failed first.
    return undefined;
  }
  return resolvePlanCriteriaAtHead(`Remudero-Task: ${taskId}`, repoDir, "plan/tasks.yaml", headSha);
}
export { resolveFixRungTaskContractAtHeadWithHost as resolveFixRungTaskContractAtHead };

export function sweepPrTerminalRung(github: Pick<GitHub, "prByRef">, ledgerPath: string, runId: string, // W1-T5318
  tickRead?: Pick<TickReadFacts, "closedPrs">): PrTerminalReconcileSummary {
  const lookup = tickRead?.closedPrs ? closedPrLookup(tickRead.closedPrs) : (url: string) => closedPrFromRef(github.prByRef(url));
  return runPrTerminalReconcile(lookup, { ledgerPath, runId });
}

export function tickReadReverificationDeps(tickRead: Pick<TickReadFacts, "mergedFixPrNumbers" | "postFixCiFailuresByPr">): {
  isMergedByNumber: (prNumber: number) => boolean;
  readCiFailures: (pr: OpenPrView) => CiFailure[] | undefined;
} {
  return {
    isMergedByNumber: (number) => tickRead.mergedFixPrNumbers.includes(number),
    readCiFailures: (pr) => tickRead.postFixCiFailuresByPr.get(pr.prNumber),
  };
}

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

export function feedbackFixConstraint(answer: { constraint: string; contributions?: readonly unknown[] } | undefined): string | undefined {
  return answer?.contributions?.length
    ? feedbackLineageEnvelope(feedbackLineagePayload(answer.constraint, answer.contributions), "feedback-entry")
    : answer?.constraint;
}

export function buildFixRungDispatchArgsWithHost(host: SweepCommandHost, args: {
  task: { id: string; title: string; acceptance?: AcceptanceCriterion[] };
  runId: string;
  prUrl: string;
  branch: string;
  worktreePath: string;
  mount: Mount;
  settingsFile: string;
  config: Config;
  budgetUsd: number;
  strikeCap: number;
  evidence: FixDispatchEvidence;
  pr: {
    headSha: string;
    reviewInputDigest?: string;
    reviewSummary?: string;
    pendingAnswer?: { constraint: string; resetStrikeCounter?: boolean; spent?: true; contributions?: unknown[] };
    checksState?: OpenPrView["checksState"];
    redRequiredChecks?: readonly string[];
  };
  reviewBase: { owner: string; repo: string; headCheckoutDir: string; reviewerMount: Mount };
}): Omit<Parameters<typeof runFixRung>[0], "deps"> {
  const runFixRung = host.runFixRung;
  const ciEvidenceDisagreementObservation = host.ciEvidenceDisagreementObservation;
  const { evidence, pr } = args;
  // W1-T100: `evidence.ciFailures` is defined ONLY for a blocked_ci dispatch
  // (runSweep/routeFix set it, undefined otherwise) — the SAME discriminator
  // both callers use to pick this evidence shape. W1-T106: `evidence.mergeConflict`
  // is the analogous discriminator for a `conflicted` dispatch — checked FIRST
  // (mirrors FIX_MODE_RULES' ordering) since a merge-conflict PR also carries no
  // review verdict.
  const isMergeConflict = evidence.mergeConflict !== undefined;
  const isCiLog = !isMergeConflict && evidence.ciFailures !== undefined;
  const unmet = evidence.unmetCriteria;
  const initialCriterionIndices = unmet.map((c) => {
    const matches = (args.task.acceptance ?? []).flatMap((criterion, index) =>
      criterion.claim === c.claim && (!c.proof || criterion.proof === c.proof) ? [index] : []);
    return matches.length === 1 ? matches[0]! + 1 : 0;
  });
  // W1-T5544: gate-log evidence names proofs only; the plan's own criteria supply each claim.
  const proofDiscrimination = withPlanClaims(evidence.proofDiscrimination, args.task.acceptance);

  // A failing verdict seeded from the ledger's unmet criteria (review mode) —
  // OR, for a blocked_ci/conflicted dispatch (W1-T100, broadened by W1-T106/
  // W1-T138 to fire regardless of the review verdict beside it), a placeholder
  // verdict: `criteria: []` so the rung never re-litigates a review verdict
  // that may be stale or simply irrelevant until the block actually clears (a
  // FRESH review only ever runs once CI is green). Either way, the fix rung
  // re-derives the AUTHORITATIVE verdict via runReview after each strike.
  const initialReview: ReviewVerdict & { headSha: string; reviewerOutcome: string } = isMergeConflict
    ? {
        state: "failure",
        criteria: [],
        testTheater: false,
        summary: `sweep-reconstructed: merge state dirty (${(evidence.mergeConflict?.files ?? []).length} conflicting file(s)) — merge-conflict dispatch, no review can run until the conflict resolves`,
        floorDegraded: false,
        capped: false,
        keywordOnly: false,
        planOnly: false,
        headSha: pr.headSha,
        reviewerOutcome: "sweep-reconstructed-merge-conflict",
      }
    : isCiLog
    ? {
        state: "failure",
        criteria: [],
        testTheater: false,
        summary: `sweep-reconstructed: required checks red (${(evidence.ciFailures ?? []).length} failing check(s)) — ci-log dispatch, any review verdict on this head is disregarded until checks are green`,
        floorDegraded: false,
        capped: false,
        keywordOnly: false,
        planOnly: false,
        headSha: pr.headSha,
        reviewerOutcome: "sweep-reconstructed-ci-log",
      }
    : {
        state: "failure",
        criteria:
          proofDiscrimination?.proofs.map((proof) => ({
            claim: proof.claim,
            proof: proof.proof,
            met: true,
            reason: "capped proof requires base discrimination",
            proof_exec: proof.proofExec,
          })) ?? unmet,
        testTheater: false,
        summary:
          pr.reviewSummary ??
          (proofDiscrimination
            ? `sweep-reconstructed capped review (${proofDiscrimination.proofs.length} proof(s) need discrimination)`
            : `sweep-reconstructed failing review (${unmet.length} unmet)`),
        floorDegraded: false,
        capped: proofDiscrimination !== undefined,
        keywordOnly: false,
        planOnly: false,
        instrumentEntangled:
          evidence.instrumentEntangled === true && usableInstrumentEntanglementPaths(evidence.instrumentEntanglementPaths)
            ? true
            : undefined,
        instrumentEntanglementPaths:
          evidence.instrumentEntangled === true && usableInstrumentEntanglementPaths(evidence.instrumentEntanglementPaths)
            ? evidence.instrumentEntanglementPaths
            : undefined,
        headSha: pr.headSha,
        reviewerOutcome: "sweep-reconstructed",
      };

  return {
    taskId: args.task.id,
    runId: args.runId,
    task: args.task,
    prUrl: args.prUrl,
    branch: args.branch,
    worktreePath: args.worktreePath,
    initialSessionId: "", // cold PR: no session — strike 1 degrades to fresh (adapter below)
    mount: args.mount,
    settingsFile: args.settingsFile,
    config: args.config,
    budgetUsd: args.budgetUsd,
    strikeCap: args.strikeCap,
    initialReview,
    progressReviewInputDigest: pr.reviewInputDigest,
    initialCriterionIndices,
    constraint: feedbackFixConstraint(pr.pendingAnswer),
    pendingAnswer: pr.pendingAnswer,
    feedbackContributions: pr.pendingAnswer?.contributions === undefined ? undefined : feedbackLineageSnapshot(pr.pendingAnswer.contributions),
    progressDecision: evidence.progressDecision,
    progressApproach: evidence.progressApproach,
    ciFailures: evidence.ciFailures,
    ciEvidenceDisagreement: isCiLog
      ? ciEvidenceDisagreementObservation({
          checksState: pr.checksState,
          redChecks: pr.redRequiredChecks,
          ciFailures: evidence.ciFailures ?? [],
          // W1-T2804: the sweep resolved this head and mined `evidence.ciFailures` from it, so both
          // halves of THIS dispatch already share a subject — naming it is what makes that legible.
          sha: pr.headSha,
        })
      : undefined,
    mergeConflict: evidence.mergeConflict,
    ...(evidence.baseSha !== undefined ? { baseSha: evidence.baseSha } : {}),
    // W1-T2236: threaded through unconditionally, mirroring `ciFailures`/`mergeConflict` above —
    // `runFixRung`'s round-1 gate only reads this when it is ALSO a review-mode round (neither
    // merge-conflict nor ci-log), so its presence here for those two branches is inert.
    actionableGateFailures: evidence.actionableGateFailures,
    proofDiscrimination,
    reviewBase: args.reviewBase,
  };
}
export { buildFixRungDispatchArgsWithHost as buildFixRungDispatchArgs };

export class FixRungCheckoutRefusedError extends Error {
  constructor(
    public readonly branch: string,
    public readonly localSha: string,
    public readonly originSha: string,
  ) {
    super(
      `refusing to reset local branch ${branch} (${localSha}) to origin/${branch} (${originSha}): ` +
        `the local ref changed or is held by a worktree, so recovery cannot prove the move safe`,
    );
    this.name = "FixRungCheckoutRefusedError";
  }
}

export function registeredFixWorktreeOwner(repoDir: string, branchRef: string): string | undefined {
  const rows = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const record of rows.split(/\n\n+/)) {
    const lines = record.split("\n");
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (worktree && lines.some((line) => line === `branch ${branchRef}`)) return worktree;
  }
  return undefined;
}

export function boundedWorktreeOwnerPath(value: string): string {
  return value.replace(/[\r\n\0]/g, "?").slice(0, 512);
}

export function decideRegisteredFixOwnerRecovery(
  snapshot: RegisteredFixOwnerSnapshot,
): RegisteredFixOwnerRecoveryDecision {
  if (snapshot.pathState === "foreign") return { kind: "keep", reason: "foreign_worktree_path" };
  if (snapshot.pathState !== "managed") return { kind: "keep", reason: "worktree_path_unreadable" };
  if (snapshot.attachmentState === "detached_or_other")
    return { kind: "keep", reason: "detached_or_wrong_branch" };
  if (snapshot.attachmentState !== "exact") return { kind: "keep", reason: "branch_probe_unreadable" };
  if (snapshot.treeState === "untracked_dirty") {
    return snapshot.remoteState === "exact" && snapshot.historyState !== "unknown" &&
      // W1-T7998: at the PR's current head too; the dead, idle owner held #10829 and #12582 forever.
      snapshot.localSha && snapshot.remoteSha &&
      snapshot.claimState === "clear" && snapshot.processState === "clear" &&
      snapshot.ageMs !== null && Number.isFinite(snapshot.ageMs) &&
      snapshot.idleBoundMs != null && Number.isFinite(snapshot.idleBoundMs) && snapshot.idleBoundMs > 0 &&
      snapshot.ageMs > snapshot.idleBoundMs
      ? { kind: "preserve-stale-dirty" }
      : { kind: "keep", reason: "dirty_worktree" };
  }
  if (snapshot.treeState !== "clean" && snapshot.treeState !== "tracked_dirty" && snapshot.treeState !== "untracked_only")
    return { kind: "keep", reason: "tree_probe_unreadable" };
  if (snapshot.remoteState === "changed") return { kind: "keep", reason: "remote_head_changed" };
  if (snapshot.remoteState !== "exact") return { kind: "keep", reason: "remote_head_unreadable" };
  if (snapshot.historyState === "unknown") return { kind: "keep", reason: "history_probe_unreadable" };
  if (snapshot.claimState === "occupied") return { kind: "keep", reason: "live_branch_claim" };
  if (snapshot.claimState !== "clear") return { kind: "keep", reason: "branch_claim_unreadable" };
  if (snapshot.processState === "occupied") return { kind: "keep", reason: "process_cwd_owner" };
  if (snapshot.processState !== "clear") return { kind: "keep", reason: "process_cwd_probe_unreadable" };
  if (snapshot.treeState === "tracked_dirty") return { kind: "preserve-tracked-dirty" };
  // W1-T6355: untracked-only residue of an ended run (claim and process census clear above) is
  // preserved then released, but only on a head the PR already contains -- ahead/diverged history
  // beside untracked paths stays a no-touch decline.
  if (snapshot.treeState === "untracked_only")
    return snapshot.historyState === "contained"
      ? { kind: "preserve-untracked-dirty" }
      : { kind: "keep", reason: "dirty_worktree" };
  if (snapshot.historyState === "ahead") return { kind: "publish-ahead" };
  if (snapshot.historyState === "diverged") return { kind: "preserve-diverged" };
  return { kind: "reclaim-contained" };
}

export function captureRegisteredFixOwnerSnapshotWithHost(host: SweepCommandHost, 
  args: {
    repoDir: string;
    worktreesRoot: string;
    ownerPath: string;
    taskId: string;
    branch: string;
    expectedRemoteSha: string;
    observedRemoteSha?: string;
    inflightDir: string;
    claimKey: string;
    claimRoundEnded?: (claimRunId: string) => boolean;
    idleBoundMs?: number | null;
  },
  deps: CaptureRegisteredFixOwnerDeps = {},
): RegisteredFixOwnerSnapshot {
  const GIT_UNTRACKED_FILES_ALL = host.GIT_UNTRACKED_FILES_ALL;
  const hostWorktreeGitResult = host.hostWorktreeGitResult;
  const snapshot: RegisteredFixOwnerSnapshot = {
    path: boundedWorktreeOwnerPath(args.ownerPath),
    pathState: "unknown",
    attachmentState: "unknown",
    treeState: "unknown",
    remoteState: "unknown",
    historyState: "unknown",
    claimState: "unknown",
    processState: "unknown",
    ageMs: null,
    idleBoundMs: args.idleBoundMs,
    localSha: null,
    remoteSha: args.observedRemoteSha ?? null,
  };

  let ownerPath: string;
  try {
    ownerPath = realpathSync(args.ownerPath);
    const root = realpathSync(args.worktreesRoot);
    const rel = relative(root, ownerPath);
    snapshot.pathState = pathIsAtOrBelow(ownerPath, root) && !rel.includes(sep) && isManagedFixOwnerWorktreeName(basename(ownerPath), args.taskId)
      ? "managed"
      : "foreign";
    snapshot.path = boundedWorktreeOwnerPath(ownerPath);
    snapshot.ageMs = Math.max(0, (deps.now ?? Date.now)() - statSync(ownerPath).mtimeMs);
  } catch (e) {
    return { ...snapshot, error: String(e) };
  }
  if (snapshot.pathState !== "managed") return snapshot;

  try {
    const attached = hostWorktreeGit(ownerPath, ["symbolic-ref", "-q", "HEAD"]).trim();
    snapshot.attachmentState = attached === `refs/heads/${args.branch}` ? "exact" : "detached_or_other";
  } catch (e) {
    return {
      ...snapshot,
      attachmentState: (e as { status?: number }).status === 1 ? "detached_or_other" : "unknown",
      error: String(e),
    };
  }
  if (snapshot.attachmentState !== "exact") return snapshot;

  try {
    const status = hostWorktreeGit(ownerPath, ["status", "--porcelain=v1", GIT_UNTRACKED_FILES_ALL]);
    if (status.length === 0) {
      snapshot.treeState = "clean";
    } else {
      const untracked = hostWorktreeGit(ownerPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
      snapshot.treeState = untracked.length === 0
        ? "tracked_dirty"
        : readOwnerHasTrackedWork(ownerPath) ? "untracked_dirty" : "untracked_only";
    }
  } catch (e) {
    return { ...snapshot, error: String(e) };
  }
  if (!args.observedRemoteSha) return snapshot;
  snapshot.remoteState = args.observedRemoteSha === args.expectedRemoteSha ? "exact" : "changed";
  if (snapshot.remoteState !== "exact") return snapshot;

  try {
    snapshot.localSha = hostWorktreeGit(ownerPath, ["rev-parse", "HEAD"]).trim();
    const contained = hostWorktreeGitResult(args.repoDir, ["merge-base", "--is-ancestor", snapshot.localSha, args.observedRemoteSha]);
    if (contained.status === 0) {
      snapshot.historyState = "contained";
    } else if (contained.status === 1) {
      const remoteContainedByLocal = hostWorktreeGitResult(args.repoDir, ["merge-base", "--is-ancestor", args.observedRemoteSha, snapshot.localSha]);
      snapshot.historyState = remoteContainedByLocal.status === 0
        ? "ahead"
        : remoteContainedByLocal.status === 1
          ? "diverged"
          : "unknown";
    } else {
      snapshot.historyState = "unknown";
    }
  } catch (e) {
    return { ...snapshot, error: String(e) };
  }
  if (snapshot.historyState === "unknown") return snapshot;

  try {
    snapshot.claimState = deps.readClaim
      ? deps.readClaim(args.inflightDir, args.claimKey)
      : readRegisteredFixOwnerClaim(args.inflightDir, args.claimKey, args.claimRoundEnded);
  } catch (e) {
    return { ...snapshot, error: String(e) };
  }
  if (snapshot.claimState !== "clear") return snapshot;

  const process = (deps.processCensus ?? readBoundedProcessCwdCensus)(ownerPath);
  snapshot.processState = process.state;
  if (process.state === "unknown") snapshot.processProbeReason = process.reason;
  return snapshot;
}
export { captureRegisteredFixOwnerSnapshotWithHost as captureRegisteredFixOwnerSnapshot };

export function readOwnerHasTrackedWork(ownerPath: string): boolean {
  if (hostWorktreeGit(ownerPath, ["status", "--porcelain=v1", "--untracked-files=no"]).length > 0) return true;
  return FIX_OWNER_OPERATION_MARKERS.some((marker) => {
    try {
      readFileSync(resolve(ownerPath, hostWorktreeGit(ownerPath, ["rev-parse", "--git-path", marker]).trim()));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  });
}

export function removeAbandonedFixWorktreeOwner(repoDir: string, worktreePath: string): void {
  // No --force: a dirty owner is refused. The fix clone is pinned through the hardened leaf.
  hostWorktreeGit(repoDir, ["worktree", "remove", worktreePath]);
  removeRunLock(worktreePath);
  removeWorktreeBase(worktreePath);
}

export function preserveOrDiscardFixOwnerResidueWithHost(host: SweepCommandHost, 
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string | FixOwnerResidue {
  const readTrackedDirtyOwnerPatch = host.readTrackedDirtyOwnerPatch;
  const readFixOwnerResidue = readFixOwnerResidueWithHost.bind(undefined, host);
  const preserveTrackedDirtyPatch = host.preserveTrackedDirtyPatch;
  const patch = readTrackedDirtyOwnerPatch(ownerPath, localSha);
  if (patch.length === 0) return readFixOwnerResidue(ownerPath, localSha);
  return preserveTrackedDirtyPatch(repoDir, ownerPath, branch, localSha, patch, deps);
}
export { preserveOrDiscardFixOwnerResidueWithHost as preserveOrDiscardFixOwnerResidue };

export function preserveStagedFixOwnerResidueWithHost(host: SweepCommandHost, 
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string {
  const readTrackedDirtyOwnerPatch = host.readTrackedDirtyOwnerPatch;
  const preserveTrackedDirtyPatch = host.preserveTrackedDirtyPatch;
  const temporaryIndexTree = host.temporaryIndexTree;
  readTrackedDirtyOwnerPatch(ownerPath, localSha); // the HEAD and no-untracked guards; its diff is the working tree's
  const gitOut = (args: string[]) => hostWorktreeGit(ownerPath, args, { maxBuffer: 1 << 26 });
  const patch = gitOut(["diff", "--cached", "--binary", "--no-ext-diff", localSha]);
  const ownerIndex = resolve(ownerPath, gitOut(["rev-parse", "--git-path", "index"]).trim());
  return preserveTrackedDirtyPatch(repoDir, ownerPath, branch, localSha, patch, deps, () =>
    temporaryIndexTree(ownerPath, localSha, () => {}, ownerIndex),
  );
}
export { preserveStagedFixOwnerResidueWithHost as preserveStagedFixOwnerResidue };

const FIX_OWNER_OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const;

export function readFixOwnerResidueWithHost(host: SweepCommandHost, ownerPath: string, localSha: string): FixOwnerResidue {
  const nulPaths = host.nulPaths;
  const GIT_UNTRACKED_FILES_ALL = host.GIT_UNTRACKED_FILES_ALL;
  const gitOut = (args: string[]) => hostWorktreeGit(ownerPath, args);
  let markerKind: FixOwnerResidue["markerKind"] = null;
  let markerSha: string | null = null;
  for (const marker of FIX_OWNER_OPERATION_MARKERS) {
    let raw: string;
    try {
      raw = readFileSync(resolve(ownerPath, gitOut(["rev-parse", "--git-path", marker]).trim()), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const markerLine = raw.split("\n")[0].trim();
    if (!/^[0-9a-f]{40,64}$/i.test(markerLine)) throw new Error(`dirty owner ${marker} is malformed`);
    markerKind = marker;
    markerSha = markerLine;
    break;
  }
  const unmerged = [...new Set(nulPaths(gitOut(["diff", "--name-only", "--diff-filter=U", "-z"])))];
  const unmergedSet = new Set(unmerged);
  const staged = nulPaths(gitOut(["diff", "--cached", "--name-only", "-z", localSha])).filter((path) => !unmergedSet.has(path));
  const bound = (paths: string[]) => paths.slice(0, FIX_OWNER_RESIDUE_PATH_BOUND).map((path) => path.slice(0, 256));
  return {
    markerKind,
    markerSha,
    unmergedPaths: bound(unmerged),
    unmergedMore: Math.max(0, unmerged.length - FIX_OWNER_RESIDUE_PATH_BOUND),
    stagedPaths: bound(staged),
    stagedMore: Math.max(0, staged.length - FIX_OWNER_RESIDUE_PATH_BOUND),
    status: gitOut(["status", "--porcelain=v1", GIT_UNTRACKED_FILES_ALL]).slice(0, 512),
    ...(markerKind === null && staged.length > 0 ? { refusal: "owner_dirty_staged_only_refused" as const } : {}),
  };
}
export { readFixOwnerResidueWithHost as readFixOwnerResidue };

export function resetTrackedDirtyFixOwner(ownerPath: string, localSha: string): void {
  hostWorktreeGit(ownerPath, ["reset", "--hard", localSha]);
}

export function preserveAndClearUntrackedFixOwnerWithHost(host: SweepCommandHost, 
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string {
  const temporaryIndexTree = host.temporaryIndexTree;
  const preserveTrackedDirtyPatch = host.preserveTrackedDirtyPatch;
  const observedHead = hostWorktreeGit(ownerPath, ["rev-parse", "HEAD"]).trim();
  if (observedHead !== localSha) throw new Error(`dirty owner HEAD changed: expected ${localSha}, observed ${observedHead}`);
  if (readOwnerHasTrackedWork(ownerPath)) throw new Error("dirty owner has tracked work beside its untracked paths");
  let patch = "";
  temporaryIndexTree(ownerPath, localSha, (env) => {
    hostWorktreeGit(ownerPath, ["add", "-A"], { env });
    patch = hostWorktreeGit(ownerPath, ["diff", "--cached", "--binary", "--no-ext-diff", localSha], { env, maxBuffer: 1 << 26 });
  });
  const recoveryRef = preserveTrackedDirtyPatch(repoDir, ownerPath, branch, localSha, patch, deps);
  hostWorktreeGit(ownerPath, ["clean", "-fd"]);
  return recoveryRef;
}
export { preserveAndClearUntrackedFixOwnerWithHost as preserveAndClearUntrackedFixOwner };

export function preserveStaleDirtyFixOwnerWithHost(host: SweepCommandHost, 
  root: string,
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string {
  const temporaryIndexTree = host.temporaryIndexTree;
  const nulPaths = host.nulPaths;
  const preserveFixHead = preserveFixHeadWithHost.bind(undefined, host);
  const gitOut = (args: string[]) => hostWorktreeGit(ownerPath, args, { maxBuffer: 1 << 26 });
  const observedHead = gitOut(["rev-parse", "HEAD"]).trim();
  if (observedHead !== localSha) throw new Error(`dirty owner HEAD changed: expected ${localSha}, observed ${observedHead}`);
  if (gitOut(["diff", "--cached", "--name-only", "--diff-filter=U", "-z"]))
    throw new Error("dirty owner index has unresolved stages");
  const untracked = gitOut(["ls-files", "--others", "--exclude-standard", "-z"]);
  const indexPatch = gitOut(["diff", "--cached", "--binary", localSha]);
  const worktreePatch = gitOut(["diff", "--binary"]);
  const emptyTree = hostWorktreeGit(ownerPath, ["mktree"], { input: "" }).trim();
  let untrackedPatch = "";
  temporaryIndexTree(ownerPath, localSha, (env) => {
    hostWorktreeGit(ownerPath, ["read-tree", "--empty"], { env });
    for (const path of nulPaths(untracked)) {
      const absolute = join(ownerPath, path);
      const stat = lstatSync(absolute);
      const blob = stat.isSymbolicLink()
        ? hostWorktreeGit(ownerPath, ["hash-object", "-w", "--stdin"], { input: readlinkSync(absolute) }).trim()
        : hostWorktreeGit(ownerPath, ["hash-object", "--no-filters", "-w", "--", path]).trim();
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
      hostWorktreeGit(ownerPath, ["update-index", "--add", "--cacheinfo", mode, blob, path], { env });
    }
    untrackedPatch = hostWorktreeGit(ownerPath, ["diff", "--cached", "--binary", emptyTree], { env, maxBuffer: 1 << 26 });
  });
  if (!untracked || !untrackedPatch) throw new Error("dirty owner untracked state is empty");
  const recoveryRef = preserveFixHead(repoDir, branch, localSha);
  const recoveryRoot = join(root, "recovery");
  const parent = join(root, "recovery", "fix-owner", branch);
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(recoveryRoot, ".rmd-scratch-keep"), "W1-T7719: preserved fix-owner state\n", { flush: true });
  const savedPath = mkdtempSync(join(parent, `${localSha}-${(deps.now ?? Date.now)()}-`));
  const save = deps.saveRecoveryFile ?? ((path: string, content: string) => writeFileSync(path, content, { flag: "wx", flush: true }));
  for (const [name, content] of [
    ["index.patch", indexPatch], ["worktree.patch", worktreePatch],
    ["untracked.patch", untrackedPatch], ["untracked.paths", untracked], ["head.ref", `${recoveryRef}\n`],
  ]) {
    const path = join(savedPath, name);
    save(path, content);
    if (!readFileSync(path).equals(Buffer.from(content))) throw new Error(`saved owner state did not verify: ${name}`);
  }
  for (const path of [savedPath, parent, dirname(parent), recoveryRoot, root]) {
    const directory = openSync(path, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  return savedPath;
}
export { preserveStaleDirtyFixOwnerWithHost as preserveStaleDirtyFixOwner };

export function clearStaleDirtyFixOwner(ownerPath: string, localSha: string): void {
  resetTrackedDirtyFixOwner(ownerPath, localSha);
  hostWorktreeGit(ownerPath, ["clean", "-fd"]);
}

export function preserveFixHeadWithHost(host: SweepCommandHost, repoDir: string, branch: string, localSha: string): string {
  const ZERO_GIT_OID = host.ZERO_GIT_OID;
  const recoveryRef = `refs/rmd-recovery/fix/${branch}/${localSha}`;
  let existing: string | null = null;
  try {
    existing = execFileSync("git", ["-C", repoDir, "rev-parse", "--verify", recoveryRef], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // `rev-parse --verify` exits non-zero when the recovery ref does not exist, which is the
    // ORDINARY first-preserve case and not a fault: `null` here means "no ref yet", and the
    // `update-ref` below then creates it with a ZERO_GIT_OID compare-and-swap that itself fails
    // closed if the ref appeared in between. A genuinely broken repository would fail that
    // update-ref too, so the distinction is not erased — it is deferred to the write that needs it.
    existing = null;
  }
  if (existing === null) {
    execFileSync("git", ["-C", repoDir, "update-ref", recoveryRef, localSha, ZERO_GIT_OID], { stdio: "pipe" });
  } else if (existing !== localSha) {
    throw new Error(`recovery ref ${recoveryRef} resolves to ${existing}, expected ${localSha}`);
  }
  const preserved = execFileSync("git", ["-C", repoDir, "rev-parse", "--verify", recoveryRef], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (preserved !== localSha) throw new Error(`recovery ref ${recoveryRef} did not preserve ${localSha}`);
  return recoveryRef;
}
export { preserveFixHeadWithHost as preserveFixHead };

export function publishAbandonedFixOwnerAhead(
  repoDir: string,
  branch: string,
  localSha: string,
  observedRemoteSha: string,
  deps: PublishAbandonedFixOwnerAheadDeps = {},
): void {
  const ref = `refs/heads/${branch}`;
  const runGit = deps.runGit ?? ((args: string[]) => execFileSync(
    "git",
    ["-C", repoDir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  const before = remoteHeadShaFromLsRemote(
    runGit(["ls-remote", "--exit-code", "origin", ref]),
    ref,
  );
  if (before !== observedRemoteSha) {
    throw new Error(`remote head changed before publish: expected ${observedRemoteSha}, observed ${before ?? "unreadable"}`);
  }
  runGit(["push", "origin", `${localSha}:${ref}`]);
  const after = remoteHeadShaFromLsRemote(
    runGit(["ls-remote", "--exit-code", "origin", ref]),
    ref,
  );
  if (after !== localSha) {
    throw new Error(`ordinary push did not publish exact local SHA: expected ${localSha}, observed ${after ?? "unreadable"}`);
  }
}

export function preserveAbandonedFixOwnerDivergenceWithHost(host: SweepCommandHost, repoDir: string, branch: string, localSha: string): string {
  const preserveFixHead = preserveFixHeadWithHost.bind(undefined, host);
  return preserveFixHead(repoDir, branch, localSha);
}
export { preserveAbandonedFixOwnerDivergenceWithHost as preserveAbandonedFixOwnerDivergence };

export async function createFixRungWorktreeWithToolchainWithHost(host: SweepCommandHost, 
  repoDir: string,
  worktreePath: string,
  branch: string,
  prepare: (repoDir: string, worktreePath: string) => boolean = host.prepareWorktreeToolchain,
): Promise<FixHeadRecovery | undefined> {
  const prepareWorktreeToolchain = host.prepareWorktreeToolchain;
  const createFixRungWorktree = createFixRungWorktreeWithHost.bind(undefined, host);
  const recovery = await createFixRungWorktree(repoDir, worktreePath, branch);
  if (!prepare(repoDir, worktreePath)) {
    throw new Error("fix worktree toolchain unavailable: node_modules could not be linked");
  }
  return recovery;
}
export { createFixRungWorktreeWithToolchainWithHost as createFixRungWorktreeWithToolchain };

export function fixBranchClaimKeyWithHost(host: SweepCommandHost, owner: string, repo: string, branch: string): string {
  const FIX_BRANCH_CLAIM_PREFIX = host.FIX_BRANCH_CLAIM_PREFIX;
  return `${FIX_BRANCH_CLAIM_PREFIX}${owner}--${repo}--${branch}`.replace(/[/\\]/g, "__");
}
export { fixBranchClaimKeyWithHost as fixBranchClaimKey };

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

export async function sweepEscalationTriageWithHost(host: SweepCommandHost, 
  context: { root: string; config: Config; owner: string; repo: string; ledgerPath: string; runId: string },
  openPrs: readonly OpenPrView[],
  log: (step: string, extra?: Record<string, unknown>) => void,
  io: {
    dryRun?: boolean;
    rows?: Record<string, unknown>[];
    /** W1-T9390: the daemon's reader, built once per start; absent (`rmd sweep`), one is built for this call. */
    history?: EscalationTriageHistoryReader;
    issues?: AsyncIssueGateway;
    runtime?: ReturnType<typeof buildEscalationTriageRuntime>;
    clock?: Clock;
    relabel?: (url: string, label: string) => void | Promise<void>;
    execAsync?: GhAsyncExecutor;
  } = {},
): Promise<void> {
  const buildEscalationTriageRuntime = host.buildEscalationTriageRuntime;
  try {
    const { ledgerPath, runId, owner, repo } = context;
    // W1-T9390: this rung runs on the daemon loop, so its ledger read and every GitHub read or write are awaited.
    const history = io.rows ?? (await (io.history ?? createEscalationTriageHistoryReader())(dirname(ledgerPath))).rows;
    const issues = io.issues ?? ghIssueGatewayAsync(owner, repo, { exec: (args) => ghTextAsync(args, {}, io.execAsync) });
    const open = await listRetirableEscalationIssuesAsync(issues);
    const { births, judgedStateKeys } = indexEscalationTriageHistory(history);
    const nowMs = (io.clock ?? systemClock).now();
    const runtime = io.runtime ?? buildEscalationTriageRuntime(context);
    // W1-T9406: the evidence slice is refreshed off the loop before any candidate's evidence is read.
    await runtime.refresh(ledgerPath);
    const deps = { issues, ledgerPath, runId };
    const cfg = runtime(deps);
    // Async transport: this sweep runs on the daemon loop, so the relabel must not block the event loop.
    const relabel = io.relabel ?? (async (url: string, label: string): Promise<void> => {
      assertLiveWriteAllowed("gh-transport", "routing an escalation after triage");
      await ghTextAsync(["issue", "edit", url, "--repo", `${owner}/${repo}`, "--add-label", label,
        "--remove-label", label === "needs-human" ? "fleet-notice" : "needs-human"], {}, io.execAsync);
    });
    const candidates: StaleEscalationRejudgeCandidate[] = [];
    for (const issue of open) {
      const birth = births.get(issue.url);
      if (!birth || typeof birth.ts !== "string" || !Number.isFinite(Date.parse(birth.ts))) continue;
      const subject = birth.triage_subject as Escalation;
      if (!subject || !Array.isArray(subject.options)) continue;
      const pr = openPrs.find((p) => p.taskId === subject.taskId || p.prNumber === prReferentFromIssueText(subject.detail + subject.summary));
      const referentStateNow = pr ? JSON.stringify({ head: pr.headSha, review: pr.reviewState,
        checks: pr.checksState, mergeable: pr.mergeable, mergeableState: pr.mergeableState }) : "referent state unavailable";
      const siblingSummaries = open.filter((sibling) => sibling.url !== issue.url &&
        sibling.body?.includes(`**Task:** ${subject.taskId}\n`)).map((sibling) => sibling.title ?? sibling.url).sort();
      const stateKey = createHash("sha256").update(JSON.stringify([issue.url, issue.body, referentStateNow, siblingSummaries, cfg.mode])).digest("hex");
      candidates.push({ issueUrl: issue.url, issueNumber: issue.number, escalation: subject,
        ageMs: nowMs - Date.parse(birth.ts), referentStateNow, siblingSummaries, stateKey });
    }
    await runStaleEscalationRejudge(candidates, {
      ledgerPath, runId, log, dryRun: io.dryRun,
      alreadyJudgedStateKeys: judgedStateKeys,
      judge: (candidate) => {
        if (candidate.referentStateNow === "referent state unavailable")
          return Promise.resolve({ decision: "deliver", reason: "referent state unavailable" });
        return cfg.judge!({ ...candidate.escalation, detail: buildStaleEscalationRejudgePrompt(candidate) });
      },
      demote: async (url, reason) => { await issues.comment?.(url, reason); await relabel(url, "fleet-notice"); },
      triage: {
        mode: cfg.mode ?? "shadow", evidence: cfg.evidence,
        autoResolve: async (candidate) => {
          try {
            await triageExistingEscalation(candidate.escalation, candidate.issueUrl, { ...deps, triage: cfg }, relabel);
          } catch (err) {
            await relabel(candidate.issueUrl, "needs-human");
            throw err;
          }
        },
      },
    });
  } catch (err) {
    log("sweep.escalation_triage.failed", { reason: String(err) });
  }
}
export { sweepEscalationTriageWithHost as sweepEscalationTriage };

export async function sweepPostFixReverificationWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  openPrs: OpenPrView[],
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: {
    dryRun?: boolean;
    classes?: readonly FixClass[];
    pushEmptyCommit?: typeof gitPushEmptyCommit;
    isMergedByNumber?: (prNumber: number) => boolean;
    readCiFailures?: (pr: OpenPrView) => CiFailure[] | undefined | Promise<CiFailure[] | undefined>;
  } = {},
): Promise<PostFixReverificationSummary> {
  const ghLiveStateByNumber = host.ghLiveStateByNumber;
  const classes = opts.classes ?? DEFAULT_FIX_CLASSES;
  const pushEmptyCommitImpl = opts.pushEmptyCommit ?? gitPushEmptyCommit;
  const isMergedByNumber = opts.isMergedByNumber ?? ((n) => ghLiveStateByNumber(owner, repo, n) === "MERGED");
  // W1-T977: the rung's own read for a PR still pending — see `PostFixReverificationDeps.
  // readCiFailures`'s own doc (sweep.ts) for why the shared `OpenPrView.ciFailures` snapshot is
  // undefined for exactly this case. Mirrors the `fetchCiFailures` dep already wired below (line
  // ~16332) for the ci-log fix mode: same `gh pr view --json statusCheckRollup` read, same
  // `fetchCiFailures(owner, repo, ...)` leaf, just keyed off this rung's own PR argument instead
  // of a bare `prUrl` string.
  const readCiFailuresImpl =
    opts.readCiFailures ??
    (async (pr: OpenPrView) => {
      const v = ghJson(["pr", "view", pr.prUrl, "--json", "statusCheckRollup"]) as {
        statusCheckRollup?: RollupCheck[];
      };
      return fetchCiFailuresAsync(owner, repo, v.statusCheckRollup);
    });

  const mergedFixPrNumbers = new Set<number>();
  for (const fixPrNumber of new Set(classes.map((c) => c.fixPrNumber))) {
    if (isMergedByNumber(fixPrNumber)) mergedFixPrNumbers.add(fixPrNumber);
  }

  return runPostFixReverification(
    openPrs,
    mergedFixPrNumbers,
    {
      // W1-T474 rationale (8): the effect the ABSENT remedy already ships, reused verbatim rather
      // than a new outward path — an empty commit on the PR's OWN branch (never --force, never a
      // rebase, per src/lib/sweep.ts's own house rule). No settled `fresh` view is returned: a
      // push cannot observe GitHub's own re-derived checks/review synchronously, so (design note
      // ii, sweep.ts) this pass records the redrive and stops — the next ordinary sweep re-derives
      // the disposition once the fresh head's state has actually landed.
      redrive: (pr, cls) => {
        if (!pr.headRefName) return {};
        pushEmptyCommitImpl(
          repoRoot,
          pr.headRefName,
          pr.headSha,
          `chore(ci): re-trigger checks on #${pr.prNumber}\n\n` +
            `${cls.description}\n\nThe fix (#${cls.fixPrNumber}) has merged since this head was tested; this\n` +
            `empty commit mints a fresh head sha so the required checks recompute against CURRENT\n` +
            `main. Automated by the post-fix re-verification rung (W1-T474/W1-T124).`,
        );
        return {};
      },
      readCiFailures: readCiFailuresImpl,
      ledgerPath,
      runId,
      log,
      dryRun: opts.dryRun,
    },
    classes,
  );
}
export { sweepPostFixReverificationWithHost as sweepPostFixReverification };

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

export function runAutomaticBranchReapRungWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  state: AutomaticBranchReapState,
  opts: {
    prune?: boolean;
    root?: string;
    clock?: Pick<Clock, "now">;
    intervalMs?: number;
    exec?: BranchReapExec;
    plan?: () => Plan | undefined;
  } = {},
): void | Promise<void> {
  const automaticBranchReapSteps = automaticBranchReapStepsWithHost.bind(undefined, host);
  const root = opts.root ?? (repo === resolveOwnerRepo().repo ? repoRoot : join(config.root, "repos", repo));
  const key = `${owner}/${repo}\0${root}`;
  if (automaticBranchReapsInFlight.has(key)) return;
  automaticBranchReapsInFlight.add(key);
  try {
    const pass = runStepsEager(automaticBranchReapSteps(owner, repo, config, ledgerPath, runId, log, state, { ...opts, root }));
    if (isPromiseLike(pass)) return Promise.resolve(pass).finally(() => automaticBranchReapsInFlight.delete(key));
  } catch (error) {
    automaticBranchReapsInFlight.delete(key);
    throw error;
  }
  automaticBranchReapsInFlight.delete(key);
}
export { runAutomaticBranchReapRungWithHost as runAutomaticBranchReapRung };

const automaticBranchReapsInFlight = new Set<string>();

export function* automaticBranchReapStepsWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  state: AutomaticBranchReapState,
  opts: {
    prune?: boolean;
    root?: string;
    clock?: Pick<Clock, "now">;
    intervalMs?: number;
    exec?: BranchReapExec;
    plan?: () => Plan | undefined;
  } = {},
): Steps<void> {
  const branchReapExec = host.branchReapExec;
  const reapBranchesSteps = host.reapBranchesSteps;
  const checkoutRoot = opts.root ?? (repo === resolveOwnerRepo().repo ? repoRoot : join(config.root, "repos", repo));
  const exec = opts.exec ?? branchReapExec(checkoutRoot);
  let names: string[];
  try {
    names = yield* remoteBranchNamesSteps(exec);
  } catch (e) {
    log("branch_reap.sweep.failed", {
      outcome: "unreadable",
      reason: "remote branch listing failed",
      error: String((e as Error)?.message ?? e),
    });
    return;
  }
  if (names.length === 0) {
    log("branch_reap.sweep.failed", {
      outcome: "unreadable",
      reason: "remote branch listing was empty",
    });
    return;
  }

  const nowMs = (opts.clock ?? systemClock).now();
  const decision = decideAutomaticBranchReap(state, names, nowMs, opts.intervalMs);
  state.lastBranchFingerprint = decision.branchFingerprint;
  if (!decision.fire) return;
  state.lastRunAtMs = nowMs;

  log("branch_reap.sweep.started", {
    mode: opts.prune === false ? "dry-run" : "prune",
    reason: decision.reason,
    branch_count: names.length,
    repository: `${owner}/${repo}`,
  });
  let code = 1;
  let exitReason = "unnamed non-zero exit";
  try {
    code = yield* reapBranchesSteps(opts.prune === false ? [] : ["--prune"], {
      onExitReason: (why) => {
        exitReason = why;
      },
      root: checkoutRoot,
      ownerRepo: { owner, repo },
      exec,
      plan: opts.plan,
      ledgerPath,
      quiet: true,
      runId,
      creditLedgerPath: ledgerPath,
      // W1-T4476 design (iii)/(iv): the cache this state carries in from the LAST pass, and the
      // update this pass hands back — `state` is the one object the caller (buildSweepHook)
      // persists to disk right after this function returns, so the cache and the cadence fields
      // land in the same write.
      mergedHeadShaCache: state.mergedHeadShas ? new Map(Object.entries(state.mergedHeadShas)) : undefined,
      onMergedHeadCacheUpdate: (next) => {
        state.mergedHeadShas = next;
      },
      noPrHeadShaCache: state.noPrHeadShas ? new Map(Object.entries(state.noPrHeadShas)) : undefined,
      onNoPrHeadCacheUpdate: (next) => {
        state.noPrHeadShas = next;
      },
    });
  } catch (e) {
    log("branch_reap.sweep.failed", {
      outcome: "exception",
      reason: decision.reason,
      error: String((e as Error)?.message ?? e),
    });
    return;
  } finally {
    // The prune changed the remote branch set. Refresh the cheap fingerprint so the next ordinary
    // poll does not immediately spend another full REST classification on our own deletion.
    try {
      state.lastBranchFingerprint = branchNamesFingerprint(yield* remoteBranchNamesSteps(exec));
    } catch {
      // Keep the pre-pass fingerprint; a later poll will retry because the remote cannot be proved current.
    }
  }
  // `trigger` is why the pass RAN (the fleet pushes branches all day, so it is nearly always
  // branch-set-changed); `reason` is why it ended as it did — never the trigger read as a failure.
  log("branch_reap.sweep.completed", {
    outcome: code === 0 ? "ok" : "completed_with_drift_or_failure",
    code,
    trigger: decision.reason,
    reason: code === 0 ? "clean" : exitReason,
    repository: `${owner}/${repo}`,
  });
}
export { automaticBranchReapStepsWithHost as automaticBranchReapSteps };

export const DEFAULT_WORKER_STALL_MS = 3_600_000;

export function runWorkerStallDetectorRungWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  config: Config,
  ledgerPath: string,
  runId: string,
  thresholdMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
  issues?: IssueGateway,
  // Injectable clock (tests) — same discipline as sweepStaleWorkerTails'/DaemonDeps' own `now`,
  // so the age comparison + the episode-boundary re-arm are provable without a real wall-clock
  // wait (Rule 18). Omitted ⇒ the real wall clock, unchanged production behavior.
  now: () => number = Date.now,
): void {
  const findStalledWorkers = findStalledWorkersWithHost.bind(undefined, host);
  const capWorkerTailLines = host.capWorkerTailLines;
  try {
    const inflightDir = join(config.root, "state", "inflight");
    const liveRuns = liveInflightRuns(inflightDir);
    if (liveRuns.length === 0) return;
    const ledgerLines = readLedgerLines(ledgerPath);
    const stalled = findStalledWorkers(liveRuns, ledgerLines, thresholdMs, now());
    for (const candidate of stalled) {
      const quietMinutes = Math.round(candidate.quietMs / 60_000);
      // Ledgered BEFORE the escalation call, mirroring escalateCircuitBreak/
      // escalateLifetimeCapExceeded's "the dedup marker is written whether or not delivery
      // succeeds" discipline — the row IS the dedup key `findStalledWorkers` reads back next
      // tick, so a `gh` failure below must never leave this episode un-marked and re-firing on
      // the very next poll.
      appendLedger(ledgerPath, {
        run_id: candidate.runId,
        task_id: candidate.taskId,
        step: WORKER_STALLED_LEDGER_STEP,
        quiet_ms: candidate.quietMs,
        last_state: candidate.lastState ?? null,
      });
      const tailPath = join(config.root, "state", "runs", `${candidate.runId}.tail`);
      const tail = capWorkerTailLines(
        readWorkerTailBestEffort(tailPath),
        WORKER_STALL_TAIL_ATTACH_MAX_LINES,
        WORKER_STALL_TAIL_ATTACH_MAX_BYTES,
      ).join("\n");
      const issueUrl = tryEscalate(
        {
          class: "BLOCKED",
          taskId: candidate.taskId,
          // The STALLED run's own id — the evidence an operator needs to act on "stop this run"
          // — never the daemon's own coordinating run id (see EscalateDeps.runId below for that).
          runId: candidate.runId,
          summary: `${candidate.taskId}: worker run ${candidate.runId} has said nothing for ${quietMinutes} min`,
          detail:
            `W1-T943: run ${candidate.runId} (task ${candidate.taskId}) has produced no \`worker.state\` ` +
            `transition for ${quietMinutes} minute(s) — past the policy \`workerStall\` threshold. This can be ` +
            `a genuinely wedged worker OR a long healthy step the fixed threshold misjudged: never auto-killed ` +
            `either way (design note iv) — the operator, or a future paramedic verb, decides. Last recorded ` +
            `state: ${candidate.lastState ?? "unknown"}.\n\n` +
            `Last tail lines from this run:\n\`\`\`\n${tail || "(no tail captured)"}\n\`\`\``,
          options: [
            {
              label: "leave it running",
              detail:
                "Take no action. A long but legitimate step (a full local suite, a slow spawn) can look " +
                "identical to a wedge from the outside — silence alone is not proof.",
            },
            {
              label: "stop this run",
              detail: `Interrupt run ${candidate.runId} yourself and let the fleet redispatch ${candidate.taskId} fresh — this detector never does so itself.`,
            },
          ],
          recommendation: "leave it running",
        },
        // `runId` HERE is the escalating daemon's OWN run — the escalation-machinery dedup/
        // failure-ledger actor, distinct from `e.runId` (the stalled run) immediately above.
        { issues: issues ?? ghIssueGateway(owner, repo), ledgerPath, runId },
      );
      log("daemon.worker_stall", {
        run_id: candidate.runId,
        task_id: candidate.taskId,
        quiet_ms: candidate.quietMs,
        issue_url: issueUrl,
      });
    }
  } catch (e) {
    log("daemon.worker_stall", { error: String((e as Error)?.message ?? e) });
  }
}
export { runWorkerStallDetectorRungWithHost as runWorkerStallDetectorRung };

export function lightPassActionable(
  disposition: Disposition,
  fixRungAllowed: boolean,
  // W1-T2430 — TRUE ONLY for `buildSweepLightHook`'s SECOND, narrower `runSweepLightPass` call,
  // over the subset `blockedFixableIsRequeueOnly` has already proven can never reach
  // `dispatchFix` (every `ciFailures` entry on that PR names a cancelled required check, so
  // `runSweep`'s own `blocked-fixable` case always breaks at its "cancelled required check(s)"
  // stand-down before it ever gets there — see that case's own comment in `src/lib/sweep.ts`).
  // Admitting here can therefore never widen the spend bound `fixRungAllowed` exists to
  // enforce: the lane's whole action is one `POST actions/jobs/{id}/rerun` (W1-T1223), which
  // spawns no worker. Every EXISTING caller passes 2 args and gets this function's original
  // 3-line shape back, byte-identical (W1-T1211) — this is an ADDITIVE 3rd parameter, not a
  // change to `fixRungAllowed`'s own meaning.
  requeueLaneOnly: boolean = false,
  // W1-T5922 — TRUE only on `buildSweepLightHook`'s ordinary pass. An arm is one GitHub call behind
  // the full sweep's own guards (decideSweepArm, the W1-T5403 risk judge, holds, dedups); it spawns
  // no worker. Default false, so every 2- and 3-argument caller keeps its original shape.
  armAllowed: boolean = false,
  // W1-T8086: the ordinary pass's repair lanes use the existing per-claim fix-capacity admission.
  // 2026-10-14: `conflicted` too, so a merge-conflict round no longer waits for the next full sweep.
  repairFixAllowed: boolean = false,
): boolean {
  // W1-T9558: all three review-lane dispositions; the cheap modes otherwise waited on a full pass.
  if (isReviewLaneDisposition(disposition)) return true;
  if (disposition === "mergeable") return armAllowed;
  // The two dispositions whose ACTION is `dispatchFix` — the only lane that spawns a worker. Both
  // take `runSweep`'s per-claim fix-capacity admission (`claimFixAdmission`, after the per-head
  // `claimFixDispatch` mutex) before they spawn, so on the ordinary pass that claim is the gate, not
  // W1-T1211's "every in-flight run is waiting" blanket. `blocked-fixable` also admits requeues.
  // MEASURED 2026-10-14 on the core ledger: 220 `conflicted` rows read "deferred to full sweep
  // (light pass)" against 7 that acted. Full passes finished a median 18.9 min apart (p90 44.5, max
  // 100), and #11604, #11679, #11689 and #11699 each waited 68-241 min for a conflict round that never
  // came. A refused claim names the capacity; a review-only pass still stands both lanes down.
  if (disposition === "blocked-fixable") return fixRungAllowed || requeueLaneOnly || repairFixAllowed;
  if (disposition === "conflicted") return fixRungAllowed || repairFixAllowed;
  return false;
}

export function blockedFixableIsRequeueOnly(pr: OpenPrView): boolean {
  if (!isBlockedCi(pr)) return false;
  const cancelledChecks = pr.cancelledRequiredChecks ?? [];
  if (cancelledChecks.length === 0) return false;
  const genuineFailures = (pr.ciFailures ?? []).filter(
    (f) => !cancelledChecks.some((c) => c.name === f.name),
  );
  return genuineFailures.length === 0;
}

export function fixRungAllowedBesideInFlight(
  lines: ReadonlyArray<Record<string, unknown>>,
  inFlightTaskIds: readonly string[],
): boolean {
  return inFlightTaskIds.every((taskId) => runIsAwaitingExternal(lines, taskId));
}

export function inFlightTaskIdsFromWithHost(host: SweepCommandHost, inflightDir: string): string[] {
  const FIX_BRANCH_CLAIM_PREFIX = host.FIX_BRANCH_CLAIM_PREFIX;
  if (!existsSync(inflightDir)) return [];
  return readdirSync(inflightDir)
    .filter((entry) => entry.endsWith(".lock") && !entry.startsWith(FIX_BRANCH_CLAIM_PREFIX))
    .map((entry) => entry.slice(0, -".lock".length));
}
export { inFlightTaskIdsFromWithHost as inFlightTaskIdsFrom };

export function reviewOnlyLightPassDeps(scope?: LightPassScope): Pick<SweepDeps, "lightPassScope" | "standDownReasonFor"> {
  const name = scope?.reviewOnly === true ? scope.scope : undefined;
  return name ? { lightPassScope: name, standDownReasonFor: () => reviewOnlyStandDownReason(name) } : {};
}

export interface LightPassReadPorts {
  openPrViews?: () => Promise<OpenPrView[]>;
  effects?: (deps: Parameters<typeof buildSweepEffects>[1]) => SweepDeps;
  readCompare?: (args: string[]) => Promise<unknown>;
  clock?: Pick<Clock, "now">;
}

export function createLightPassCompareReader(owner: string, repo: string, read: (args: string[]) => Promise<unknown>) {
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

export function buildInboxDraftHookWithHost(host: SweepCommandHost, 
  owner: string,
  repo: string,
  config: Config,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  draftBatch: (
    toDraft: Proposal[],
    config: Config,
    owner: string,
    repo: string,
    runId: string,
    log: (step: string, extra?: Record<string, unknown>) => void,
  ) => Promise<DraftRungOutcome[]> = host.draftProposalBatch,
  grepAnchor?: (ref: string, anchor: EvidenceAnchor) => boolean,
  mainSha: () => string | undefined = () => readOriginMainSha(repoRoot),
  grepAnchorAsync?: (ref: string, anchor: EvidenceAnchor) => Promise<boolean>,
  legacyGrepAnchorAsync?: (ref: string, anchor: EvidenceAnchor) => Promise<boolean>,
): (tickRead?: TickReadFacts) => Promise<void> {
  const draftProposalBatch = host.draftProposalBatch;
  // 2026-10-06: the sync `git grep` behind each anchor held the daemon loop up to 29 s a spawn. The
  // readiness pass stays sync, so every anchor is warmed into the cache OFF the loop first. A test
  // that injects only the sync seam warms through that same seam, so its answers are unchanged.
  const grepAnchorSync = grepAnchor ?? ((ref: string, anchor: EvidenceAnchor) => gitGrepAnchorTrue(repoRoot, ref, anchor));
  const grepAnchorWarm =
    legacyGrepAnchorAsync ??
    grepAnchorAsync ??
    (grepAnchor
      ? async (ref: string, anchor: EvidenceAnchor) => grepAnchor(ref, anchor)
      : (ref: string, anchor: EvidenceAnchor) => gitGrepAnchorTrueAsync(repoRoot, ref, anchor));
  // W1-T2564: see the migration block below — this is the once-per-daemon-start scope it needs.
  let attemptsMigrated = false;
  const anchorGrepCache = createAnchorGrepCache();
  // W1-T9443: the orphan prune's shard population, held for this daemon's life like the anchor cache above, so a
  // full sweep reads, off the loop, only the shard files that changed since the one before.
  const shardReader = createProposalShardReader(proposalShardDir(join(config.root, "state", "inbox-proposals.json")), { log });
  return async () => {
    try {
      const registryPath = join(config.root, "state", "inbox-proposals.json");
      const causalScope = { repository: `${owner}/${repo}` };
      commitInboxDraftOutcomes({ stateDir: join(config.root, "state"), scope: causalScope, snapshots: [], outcomes: [], log });
      const proposals: Proposal[] = parseProposalRegistry(readFileIfExists(registryPath));
      if (proposals.length === 0) return; // no active proposals — no spend
      const ledgerPath = ledgerPathFor(config);

      const draftsPath = join(config.root, "state", "inbox-drafts.json");
      const pruned = await pruneOrphanedDraftsAsync(draftsPath, registryPath, shardReader);
      if (pruned && pruned.count > 0) log("inbox.drafts_pruned", { count: pruned.count, bytes_before: pruned.bytesBefore, bytes_after: pruned.bytesAfter });
      const drafts: DraftCache = parseDraftCache(readFileIfExists(draftsPath));
      const attemptsPath = join(config.root, "state", "inbox-draft-attempts.json");
      const attempts: DraftAttemptCache = parseDraftAttemptCache(readFileIfExists(attemptsPath));

      // W1-T2564 MIGRATION, ONCE PER DAEMON START, BEFORE `due` IS COMPUTED. Not writing a key for
      // a refusal fixes the write path forward and repairs nothing already on disk: 267 of 353
      // proposals were keyed with no cached draft and, their key being the literal `::0`, could
      // never become due again.
      //
      // ⚠ WHY ONCE PER PROCESS RATHER THAN EVERY POLL — A TEST CAUGHT THE NAIVE FORM. Run per poll
      // it also evicts the key W1-T192 had just written for a GENUINE failure in that same poll,
      // re-opening it forever: an unbounded retry loop wearing a migration's clothes, and the exact
      // opposite of the bounded one-off this is meant to be (test/run-task.test.ts's "an ORDINARY
      // failure still writes its attempt key" reddened on precisely that). Once per daemon start
      // keeps the property that matters — a fresh host recovers with no operator step, because
      // every boot runs it — while bounding a re-opened genuine failure to ONE extra attempt per
      // daemon start rather than one per poll. `buildInboxDraftHook` is constructed once per daemon
      // start (see its own doc), so this closure flag is that scope.
      // W1-T2566: THE CLOSURE FLAG STAYS — it is what keeps this off the per-poll path, and the
      // comment above records the test that caught the naive form. What it CANNOT do is survive a
      // restart, which is precisely what resets it: at a MEASURED median daemon lifetime of 50.5
      // minutes (479 processes, 32% under 30 min) a proposal that fails genuinely and repeatedly
      // never acquires a cached draft, satisfies the eviction predicate on every boot, and is
      // re-opened ~29 times a day at an $8.52 draft mean. The PERSISTED per-id marker below is the
      // bound that survives the restart; the flag and the marker do different jobs.
      if (!attemptsMigrated) {
        attemptsMigrated = true;
        const reopenedPath = join(config.root, "state", "inbox-reopened-keys.json");
        const reopened = parseReopenedKeysCache(readFileIfExists(reopenedPath));
        // KEYED ON PROPOSAL ID, never a global "migration done" flag: an id never seen before is
        // still re-opened on FIRST SIGHT, so a freshly-provisioned host recovers with no operator
        // step — the property W1-T2564 chose a closure flag to get, preserved rather than traded.
        const evicted = evictRefusalPoisonedKeys(attempts, drafts, new Set(proposals.map((p) => p.id)), new Set(Object.keys(reopened)));
        if (evicted.length > 0) {
          writeDraftAttemptPair(draftsPath, attemptsPath, drafts, attempts);
          // Written AFTER the pair commits. A marker recorded for an eviction that never landed
          // would silently retire a proposal the caches still consider due — the failure direction
          // that costs work rather than one extra attempt.
          writeReopenedKeys(reopenedPath, markReopened(reopened, evicted, new Date().toISOString()));
          log("inbox.draft_attempts_reopened", { evicted: evicted.length, evicted_ids: evicted.slice(0, 20), refused_this_batch: 0 });
        }
      }

      let draftSelection: DraftSelectionContext | undefined;
      try {
        const ledgerLines = readLedgerLines(ledgerPath);
        const sha = mainSha();
        const anchors = proposals.flatMap((p) => p.evidenceAnchors);
        const grepFailures = await warmAnchorGrepCache(anchorGrepCache, sha, anchors, grepAnchorWarm);
        draftSelection = {
          grepAnchorTrue: (a: EvidenceAnchor) => warmedAnchorGrep(anchorGrepCache, sha, grepFailures, a, grepAnchorSync),
          openProposalIds: new Set(proposals.map((p) => p.id)),
          isRatified: (id) => isRatifiedInLedger(ledgerLines, id),
          isDeclined: declinedWithReceipts(ledgerLines, join(config.root, "state")),
        };
      } catch (e) {
        log("inbox.draft_readiness_unavailable", { error: String((e as Error)?.message ?? e) });
      }

      const draftLane = resolvedInboxDraftLane(repoRoot);
      const due = draftsDueOnDaemon(proposals, drafts, attempts, DAEMON_DRAFT_BATCH_CAP, draftSelection, draftLane);
      if (due.length === 0) return;

      // W1-T2561: NAME THE DEFERRAL, NEVER CAP SILENTLY. `draftsDueOnDaemon` now returns at most
      // DAEMON_DRAFT_BATCH_CAP proposals per poll, so on a large registry `due` is a SLICE and the
      // rest are still due. A cap that shows up nowhere is the "tested, inert" shape this repo has
      // shipped before: the queue would drain at a bounded rate with no way to see the backlog or
      // tell a paced drain from a wedged one. This is a pure observation — a count of a set already
      // computed above, spawning nothing — and `deferred: 0` on an uncapped poll is a real reading,
      // not silence, so the row is written unconditionally.
      const eligible = draftsDueOnDaemon(proposals, drafts, attempts, 0, draftSelection, draftLane);
      log("inbox.draft_batch", {
        eligible: eligible.length,
        drafting: due.length,
        deferred: eligible.length - due.length,
        cap: DAEMON_DRAFT_BATCH_CAP,
      });

      // W1-T193: the console must render a proposal as DRAFTING (with its spawn time) for the
      // whole window an Architect worker is actually running for it — "never lies about its
      // own state", the same bar W1-T156 set for liveness. Written BEFORE the batch spawns and
      // cleared in the `finally` below regardless of outcome, so a crash mid-draft is the only
      // way this file can go stale (self-corrects: a stuck entry is overwritten the next time
      // ANY draft batch runs, since this rung always writes its own full `due` set, never
      // merges onto a stale one).
      // ── W1-T2569: THE RE-ENTRANCY GUARD ───────────────────────────────────────────────────
      // THE BOUND STOPS AWAITING; IT DOES NOT CANCEL. `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS`
      // (559_000, lib/daemon.ts) abandons `await deps.sweep()` at 9.3 minutes, but the sweep — and
      // this rung inside it — KEEPS RUNNING DETACHED. A draft batch is 3 sequential drafts at a
      // measured 316s median, ~948s end to end, so it is un-awaited EVERY time and the next loop
      // iteration starts a fresh sweep carrying a fresh batch.
      //
      // MEASURED 2026-09-01, six consecutive cycles, perfect alternation:
      //   batch 17:38:13 -> abandoned 17:46:45 (+512s) -> batch 17:53:01 -> abandoned 18:01:15 ...
      // with `daemon.sweep.abandoned` carrying `elapsed_ms: 559000, bound_ms: 559000` exactly.
      // Cost: 16 Architect spawns across 5 distinct proposals, $123.30, drafts cache frozen at 62.
      //
      // THIS IS WHY `buildInboxDraftHook`'s OWN DOC WAS WRONG to say the hook is "awaited to
      // completion by the daemon's serial sweep tick" — corrected at that doc; see it for the
      // wider class, which is NOT confined to this rung.
      //
      // O_EXCL + reclaimStaleLock, REUSED not reinvented: `acquireDrainLock` is already
      // path-parameterised and already applies the pid+host staleness rule (`isHolderStale`) that
      // W1-T1067 settled for `drain.lock`. A SECOND staleness rule here would be a second thing to
      // drift. The staleness bound is load-bearing in the other direction too: without it a killed
      // daemon strands the lock and this rung never runs again — the exact W1-T1067 failure, one
      // file over.
      // ── W1-T2590: DO NOT RETRY INTO A SHUT DOOR ───────────────────────────────────────────
      // Checked FIRST — before the lock, before the registry is even consulted — so a deferred
      // poll costs nothing: no lock churn, no `deps.spawn`, no Architect. The instant comes from
      // the provider's OWN refusal text (`detectUsageLimitRefusal`, lib/classify.ts), which on the
      // measured real string was more accurate than the headroom governor's belief at that moment.
      //
      // THIS IS WHAT MAKES RAISING `DAEMON_DRAFT_BATCH_CAP` SAFE LATER. W1-T2564 correctly stopped
      // a refusal from writing an attempt key, so a refused draft now stays due and retries next
      // poll; that left the cap as the ONLY bound on a retry storm during a live outage — the exact
      // condition that produced 494 refusals in seven hours. Bounding the retry by the account's
      // own stated window is the prerequisite, not a nicety.
      const deferralPath = join(config.root, "state", "inbox-draft-deferred-until.json");
      const deferral = decideDraftDeferral(parseDraftDeferralCache(readFileIfExists(deferralPath)), Date.now());
      if (deferral.defer) {
        log("inbox.draft_batch.deferred", {
          until: new Date(deferral.untilMs).toISOString(),
          remaining_ms: deferral.remainingMs,
          matched: deferral.matched,
        });
        return;
      }

      const draftLockPath = join(config.root, "state", "inbox-draft.lock");
      let draftLock: DrainLockHandle;
      try {
        draftLock = acquireDrainLock(draftLockPath);
      } catch (e) {
        // A LIVE holder is the expected, healthy outcome of an abandoned-but-still-running batch —
        // it is a SKIP, never an error. Ledgered so a stuck lock is visible rather than looking
        // like a rung that quietly stopped firing.
        log("inbox.draft_batch.skipped", {
          reason: "another draft batch holds the lock",
          detail: String((e as Error)?.message ?? e),
        });
        return;
      }
      try {
      const inflightPath = join(config.root, "state", "inbox-draft-inflight.json");
      const spawnedAt = new Date().toISOString();
      writeFileSync(inflightPath, JSON.stringify(Object.fromEntries(due.map((p) => [p.id, spawnedAt])), null, 2), "utf8");

      let outcomes: DraftRungOutcome[];
      const snapshots = due.map(proposal => captureInboxDraftSnapshot(proposal, causalScope));
      try {
        outcomes = await draftBatch(due, config, owner, repo, runId, log);
      } finally {
        // ⚠ W1-T2569 CORRECTION — THIS CLAIM WAS FALSE AND COST $123.30. It used to read "Only one
        // draft rung runs at a time (this hook is awaited to completion by the daemon's own serial
        // sweep tick before the next one can start)". The sweep tick does NOT await to completion:
        // `DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS` (559_000, lib/daemon.ts) stops AWAITING at 9.3
        // minutes and does not CANCEL, so a ~948s draft batch keeps running detached while the next
        // iteration starts a fresh one. MEASURED: six consecutive batch/abandon alternations.
        //
        // Clearing the whole file is safe now for a DIFFERENT reason — the lock acquired above
        // means this really is the only batch running. It was never safe because of serialization.
        writeFileSync(inflightPath, JSON.stringify({}, null, 2), "utf8");
      }

      // W1-T2564: ids left unkeyed because the account refused them — ledgered below so a refusal
      // storm is visible as itself rather than as a run of malformed-output errors.
      const refusedThisBatch: string[] = [];
      for (const outcome of outcomes) {
        const proposal = due.find((p) => p.id === outcome.proposalId);
        if (!proposal) continue; // unreachable — outcomes are 1:1 with `due`
        // IDEMPOTENCE (W1-T192): mark this cause ATTEMPTED whether it succeeded or failed —
        // see this function's own doc for why a failed attempt must be throttled too.
        //
        // W1-T2564: EXCEPT A REFUSAL, WHICH IS NOT AN ATTEMPT. W1-T192's argument is that a cause
        // which was TRIED and failed must not be retried every poll. A run the account turned away
        // was never tried, so keying it does not throttle a failure — it retires work that never
        // ran, permanently, because a routed follow-up's key is the literal `::0` and can never
        // change. This is the ONLY arm that skips the write; an ordinary failure still keys, so
        // W1-T192's throttle is untouched (its own test pins that).
        if (!outcome.ok && outcome.refused) {
          refusedThisBatch.push(outcome.proposalId);
        }
      }
      // ATOMIC PAIR (W1-T241): see lib/inbox.ts's `writeDraftAttemptPair` doc for the
      // torn-file/wedged-idempotence hazard this closes and why drafts commits before
      // attempts.
      if (refusedThisBatch.length > 0) {
        log("inbox.draft_attempts_reopened", { evicted: 0, refused_this_batch: refusedThisBatch.length });
      }
      // W1-T2590: record the window the account itself stated, so the NEXT poll waits it out
      // instead of spending against a door that is still shut. `deferralFromOutcomes` returns
      // nothing when no refusal carried a usable instant — a zone-less refusal must not stop the
      // rung on a window whose end nobody stated (see its own doc), so that case falls through to
      // today's behaviour: retry next poll, bounded by the batch cap.
      const nextDeferral = deferralFromOutcomes(outcomes);
      if (nextDeferral) {
        writeFileSync(deferralPath, JSON.stringify(nextDeferral, null, 2), "utf8");
        log("inbox.draft_deferral_recorded", {
          until: new Date(nextDeferral.deferredUntilMs).toISOString(),
          matched: nextDeferral.matched,
        });
      }
      // Re-read under the shared registry lock, adopt only this batch's unchanged generations,
      // and persist completion before publication. Never spread an old whole-cache snapshot
      // over unrelated writes or mark newer direction attempted when an older worker finishes.
      commitInboxDraftOutcomes({ stateDir: join(config.root, "state"), scope: causalScope, snapshots, outcomes, lane: draftLane, log });
      } finally {
        draftLock.release();
      }
    } catch (e) {
      log("inbox.draft_rung.error", { error: String((e as Error)?.message ?? e) });
    }
  };
}
export { buildInboxDraftHookWithHost as buildInboxDraftHook };

const FRESH_TREE_STDERR_HOLD_CHARS = 64 * 1024;

export function reviewOptionFlagsWithHost(host: SweepCommandHost, opts: Pick<ReviewCommandDeps, "planOnlyFiling" | "executionMode" | "reviewAttemptId">): string[] {
  const acceptedReviewAttemptId = host.acceptedReviewAttemptId;
  const attemptId = acceptedReviewAttemptId(opts.reviewAttemptId);
  return [
    ...(opts.planOnlyFiling === undefined ? [] : [opts.planOnlyFiling ? "--plan-only-filing" : "--not-plan-only-filing"]),
    ...(opts.executionMode === undefined ? [] : ["--execution-mode", opts.executionMode]),
    ...(attemptId === undefined ? [] : ["--review-attempt-id", attemptId]),
  ];
}
export { reviewOptionFlagsWithHost as reviewOptionFlags };

export function reviewerFreshnessForPublication(
  atStart: ReviewerCodeFreshness | undefined,
  justInTime: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness> {
  return reviewerFreshnessForPublicationFromModule(atStart, justInTime);
}

export async function ownStartFreshness(
  read: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): Promise<ReviewerCodeFreshness> {
  return ownStartFreshnessFromModule(read);
}

export function assigningIssueGateway(owner: string, repo: string, log: (step: string, extra?: Record<string, unknown>) => void,
  gateway: AsyncIssueGateway = ghIssueGatewayAsync(owner, repo)): AsyncIssueGateway {
  return {
    ...gateway,
    create: async (title, body, labels) => {
      const url = await gateway.create(title, body, labels);
      await ghTextAsync(["issue", "edit", url, "--repo", `${owner}/${repo}`, "--add-assignee", owner]).catch((error: unknown) =>
        log("reviewer.regression_assign_failed", { issue_url: url, error: String((error as Error)?.message ?? error) }));
      return url;
    },
  };
}

export function reviewerRevertLaneWithHost(host: SweepCommandHost, owner: string, repo: string, config: Config, ledgerPath: string, runId: string): MainRepairLane {
  const mainRepairLaneFor = host.mainRepairLaneFor;
  const pull = (url: string) => /\/pull\/(\d+)$/.exec(url)?.[1] ?? "";
  return {
    ...mainRepairLaneFor(owner, repo, config, ledgerPath, runId),
    readPr: async (url) => {
      const pr = (await ghJsonAsync(["api", `repos/${owner}/${repo}/pulls/${pull(url)}`])) as { state?: unknown; merged?: unknown };
      return { state: pr?.merged === true ? "merged" : pr?.state === "open" ? "open" : "closed" };
    },
    closePr: async (url, comment) => {
      await ghJsonAsync(["api", "--method", "POST", `repos/${owner}/${repo}/issues/${pull(url)}/comments`, "-f", `body=${comment}`]);
      await ghJsonAsync(["api", "--method", "PATCH", `repos/${owner}/${repo}/pulls/${pull(url)}`, "-f", "state=closed"]);
    },
  };
}
export { reviewerRevertLaneWithHost as reviewerRevertLane };

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

export function ownerRepoFromPrUrl(prUrl: string): { owner: string; repo: string } | undefined {
  const m = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export function untouchedPlanCriterion(roundDiff: string, priorDiff: string, path: string): boolean {
  if (!criterionFieldTampered(roundDiff)) return false;
  const modified = new Set<number>();
  let line = 0;
  for (const text of priorDiff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith("+") && !text.startsWith("+++")) modified.add(line++);
    else if (text.startsWith(" ")) line++;
  }
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  for (const hunk of roundDiff.split(/(?=^@@ )/m).slice(1)) {
    if (!criterionFieldTampered(header + hunk)) continue;
    const start = /^@@ -(\d+)/.exec(hunk);
    let oldLine = Number(start?.[1]);
    let removed = 0;
    let added = 0;
    for (const text of hunk.split("\n").slice(1)) {
      if (text.startsWith("-")) {
        if (!modified.has(oldLine)) return true;
        removed++;
        oldLine++;
      } else if (text.startsWith("+")) added++;
      else if (text.startsWith(" ")) oldLine++;
    }
    if (removed === 0 || added > removed) return true;
  }
  return false;
}

export async function runPlanScopedConflictRoundWithHost(host: SweepCommandHost, input: PlanScopedFixRoundInput): Promise<{ outcome: "pushed" | "refused" | "metadata-repaired"; headSha?: string; reason?: string; preflight?: PlanPrPreflightResult }> {
  const GIT_UNTRACKED_FILES_ALL = host.GIT_UNTRACKED_FILES_ALL;
  const { pr, deps, worktreePath } = input;
  const git = deps.runGit ?? ((args: string[]) => hostWorktreeGit(worktreePath, args));
  const preflight = (tree: string, sha: string, meta: { title: string; body: string }) => deps.preflight
    ? deps.preflight(tree, sha, { ...meta, headRef: pr.headRefName })
    : planPrPreflightAtCommitAsync(tree, sha, { ...meta, headRef: pr.headRefName }, { log: deps.log });
  let roundId: string | undefined;
  const roundFields = () => ({ task_id: input.task.id, pr_number: pr.prNumber, head_sha: pr.headSha,
    round_id: roundId, strike: pr.priorStrikes + 1, mode: "plan-conflict" });
  const refuse = (reason: string, verdict?: PlanPrPreflightResult) => {
    if (roundId) {
      deps.log("fix.commit_refused", { ...roundFields(), reason });
      deps.log("fix.done", { ...roundFields(), subtype: "commit_refused" });
    }
    return { outcome: "refused" as const, reason, preflight: verdict };
  };
  const metadata = { title: input.title, body: input.body };
  try {
    if (git(["rev-parse", "HEAD"]).trim() !== pr.headSha) return refuse("the plan round head moved before dispatch");
    const merged = gitStatusResult(git, ["merge", "--no-commit", "--no-ff", "origin/main"]);
    const unmerged = git(["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
    if (merged.status !== 0 && unmerged.length === 0) return refuse(`merging origin/main failed without a conflict: ${merged.error}`);
    const outside = unmerged.filter((path) => !isInPlanScope(path) || path.split("/").includes(".."));
    if (outside.length) return refuse(`the merge conflicts outside the plan scope: ${outside.join(", ")}`);
    let report = "";
    if (unmerged.length > 0) {
      roundId = `${input.runId ?? input.task.id}:${pr.priorStrikes + 1}:${systemClock.now()}`;
      deps.log("fix.dispatch", { ...roundFields(), verdict_regime: "executed" });
      report = await deps.spawn(renderFixPrompt({ task: { ...input.task, files: unmerged }, round: 1, branch: pr.headRefName!,
        harnessCommits: true, evidence: {
          planGateFindings: unmerged.map((path) => ({ check: "merge-conflict", firstLine:
            `${path} has conflict markers: keep main's side (the newer fleet decision, e.g. a retirement or status); ` +
            "re-apply the branch's change only where it still applies to the merged task; drop an edit aimed at a task " +
            "main has retired or merged, and propose a PR_ACCEPTANCE without its line" })),
          constraint: [input.lastRefusal, feedbackFixConstraint(pr.pendingAnswer)].filter(Boolean).join("\n\n") || undefined } }));
      if (git(["rev-parse", "HEAD"]).trim() !== pr.headSha) return refuse("the worker moved the plan round head");
      const touched = git(["status", "--porcelain", "-z", GIT_UNTRACKED_FILES_ALL]).split("\0")
        .filter((entry) => entry.length >= 4 && entry[1] !== " ").map((entry) => entry.slice(3));
      const stray = touched.filter((path) => !unmerged.includes(path));
      if (stray.length) return refuse(`plan round changed paths outside the conflicted plan paths: ${stray.join(", ")}`);
      git(["add", "-A", "--", ...unmerged]);
      const markers = gitStatusResult(git, ["grep", "--cached", "-n", "-E", "^(<{7}|>{7})( |$)", "--", ...unmerged]);
      if (markers.status === 0) return refuse(`conflict markers remain: ${markers.out.split("\n")[0]}`);
      if (markers.status !== 1) return refuse(`checking for conflict markers failed: ${markers.error}`);
    }
    const proposedTitle = /^PR_TITLE:[ \t]*(.+)$/m.exec(report)?.[1];
    const proposedAcceptance = /^PR_ACCEPTANCE:[ \t]*\r?\n([\s\S]*?)^END_PR_ACCEPTANCE[ \t]*$/m.exec(report)?.[1];
    const proposedBody = /^PR_BODY:[ \t]*\r?\n([\s\S]*?)^END_PR_BODY[ \t]*$/m.exec(report)?.[1];
    if (proposedTitle) metadata.title = proposedTitle.trim();
    if (proposedBody) metadata.body = proposedBody.trimEnd();
    if (proposedAcceptance) {
      const check = acceptanceAuthorTimeCheck(proposedAcceptance);
      if (!check.ok) return refuse(check.message);
      // The block is REPLACED in place, so a criterion for a retired task's edit is gone, not demoted.
      const region = acceptanceBlockRegion(metadata.body);
      const rendered = renderAcceptanceBlock(parseAcceptanceBlock(proposedAcceptance) as AcceptanceCriterion[]).replace(/\n+$/, "");
      if (region) {
        const lines = metadata.body.split("\n");
        lines.splice(region.headerLine, region.endLine - region.headerLine, ...rendered.split("\n"));
        metadata.body = lines.join("\n");
      } else metadata.body = replaceAcceptanceBlock(metadata.body, parseAcceptanceBlock(proposedAcceptance));
    }
    git(["commit", "-m", `Merge branch 'main' into ${pr.headRefName}`]);
    const sha = git(["rev-parse", "HEAD"]).trim();
    const verdict = await preflight(worktreePath, sha, metadata);
    if (!verdict.ok || verdict.unreadable.length || verdict.timedOut) return refuse((verdict.failures[0] ?? verdict.unreadable[0] ?? verdict.timedOut?.[0])!.firstLine, verdict);
    if (metadata.title !== input.title || metadata.body !== input.body) await deps.updateMetadata(metadata);
    await deps.push(sha);
    deps.log("sweep.plan_round.merged", { pr_number: pr.prNumber, head_sha: pr.headSha, merge_sha: sha, conflicted: unmerged });
    if (roundId) deps.log("fix.done", { ...roundFields(), subtype: "success", pushed_head_sha: sha });
    return { outcome: "pushed", headSha: sha, preflight: verdict };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    deps.log("sweep.plan_round.error", { pr_number: pr.prNumber, head_sha: pr.headSha, reason });
    return refuse(reason);
  }
}
export { runPlanScopedConflictRoundWithHost as runPlanScopedConflictRound };

export function fetchOpenPrsWithPostedIds(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  return runStepsSync(openPrsWithPostedIdsSteps(owner, repo, fetch));
}

export function withPlanClaims(
  evidence: ProofDiscriminationEvidence | undefined,
  acceptance: readonly AcceptanceCriterion[] | undefined,
): ProofDiscriminationEvidence | undefined {
  if (evidence?.source !== "gate-log" || acceptance === undefined) return evidence;
  return {
    ...evidence,
    proofs: evidence.proofs.map((row) => {
      const match = acceptance.find((criterion) => (criterion.proof ?? "").trim() === row.proof.trim());
      return match ? { ...row, claim: match.claim } : row;
    }),
  };
}

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

export interface FixHeadRecovery {
  branch: string;
  localSha: string;
  originSha: string;
  recoveryRef: string;
}

export function isManagedFixOwnerWorktreeName(name: string, taskId: string): boolean {
  return managedFixOwnerWorktreePrefixes.some((prefix) => {
    const expected = `${prefix}-${taskId}-`;
    return name.startsWith(expected) && /^\d+$/.test(name.slice(expected.length));
  });
}

export interface RegisteredFixOwnerSnapshot {
  path: string;
  pathState: RegisteredFixOwnerSignal;
  attachmentState: "exact" | "detached_or_other" | "unknown";
  /** W1-T6355: `untracked_only` is untracked paths with NO tracked change and no interrupted operation;
   *  `untracked_dirty` is untracked paths beside tracked work; W1-T7719 recovers dead stale owners. */
  treeState: "clean" | "tracked_dirty" | "untracked_dirty" | "untracked_only" | "unknown";
  remoteState: "exact" | "changed" | "unknown";
  historyState: "contained" | "ahead" | "diverged" | "unknown";
  claimState: "clear" | "occupied" | "unknown";
  processState: "clear" | "occupied" | "unknown";
  ageMs: number | null;
  idleBoundMs?: number | null;
  localSha: string | null;
  remoteSha: string | null;
  processProbeReason?: string;
  error?: string;
}

export type RegisteredFixOwnerRecoveryDecision =
  | {
      kind:
        | "reclaim-contained"
        | "publish-ahead"
        | "preserve-diverged"
        | "preserve-tracked-dirty"
        | "preserve-stale-dirty"
        | "preserve-untracked-dirty";
    }
  | {
      kind: "keep";
      reason:
        | "foreign_worktree_path"
        | "worktree_path_unreadable"
        | "detached_or_wrong_branch"
        | "branch_probe_unreadable"
        | "dirty_worktree"
        | "tree_probe_unreadable"
        | "remote_head_changed"
        | "remote_head_unreadable"
        | "history_probe_unreadable"
        | "live_branch_claim"
        | "branch_claim_unreadable"
        | "process_cwd_owner"
        | "process_cwd_probe_unreadable";
    };

export function pathIsAtOrBelow(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function readBoundedProcessCwdCensus(
  ownerPath: string,
  deps: ProcessCwdCensusDeps = {},
): ProcessCwdCensus {
  const now = deps.now ?? Date.now;
  const maxEntries = deps.maxEntries ?? FIX_OWNER_PROC_ENTRY_BOUND;
  const wallMs = deps.wallMs ?? FIX_OWNER_PROC_WALL_MS;
  const started = now();
  let procDir: ReturnType<typeof opendirSync> | undefined;
  let readNextPid = deps.readNextPid;
  try {
    if (!readNextPid) {
      try {
        procDir = opendirSync("/proc");
      } catch {
        return { state: "unknown", scanned: 0, reason: "proc_unavailable" };
      }
      readNextPid = () => procDir!.readSync()?.name ?? null;
    }
    const readCwd = deps.readCwd ?? ((pid: string) => readlinkSync(join("/proc", pid, "cwd")));
    let scanned = 0;
    for (;;) {
      if (now() - started > wallMs) return { state: "unknown", scanned, reason: "wall_bound" };
      let entry: string | null;
      try {
        entry = readNextPid();
      } catch {
        return { state: "unknown", scanned, reason: "proc_unavailable" };
      }
      if (entry === null) return { state: "clear", scanned };
      if (!/^\d+$/.test(entry)) continue;
      if (scanned >= maxEntries) return { state: "unknown", scanned, reason: "entry_bound" };
      scanned += 1;
      let cwd: string;
      try {
        cwd = readCwd(entry);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { state: "unknown", scanned, reason: "cwd_unreadable" };
      }
      if (pathIsAtOrBelow(cwd, ownerPath)) return { state: "occupied", scanned, pid: Number(entry) };
    }
  } finally {
    try {
      procDir?.closeSync();
    } catch (e) {
      const error = String(e);
      void error;
    }
  }
}

export function readRegisteredFixOwnerClaim(
  inflightDir: string,
  claimKey: string,
  roundEnded?: (claimRunId: string) => boolean,
): "clear" | "occupied" | "unknown" {
  const raw = readFileIfExists(join(inflightDir, `${claimKey}.lock`));
  if (raw === undefined) return "clear";
  const holder = parseInflightLockInfo(raw);
  if (!holder) return "unknown";
  if (isHolderStale(holder, { isPidAlive: defaultIsPidAlive })) return "clear";
  // W1-T5955: the holder pid is the daemon, which outlives the round; the round's end row decides.
  return roundEnded?.(holder.run_id) ? "clear" : "occupied";
}

const FIX_OWNER_RESIDUE_PATH_BOUND = 20;

export function remoteHeadShaFromLsRemote(raw: string, ref: string): string | null {
  for (const line of raw.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === ref && /^[0-9a-f]{40}$/i.test(sha ?? "")) return sha;
  }
  return null;
}

export async function createFixRungWorktreeWithHost(host: SweepCommandHost, 
  repoDir: string,
  worktreePath: string,
  branch: string,
  deps: CheckoutFixHeadRefDeps = {},
): Promise<FixHeadRecovery | undefined> {
  const checkoutFixHeadRef = checkoutFixHeadRefWithHost.bind(undefined, host);
  await hostWorktreeGitAsync(repoDir, ["fetch", "origin", "--quiet"]);
  await hostWorktreeGitAsync(repoDir, ["worktree", "add", worktreePath, `origin/${branch}`]);
  return checkoutFixHeadRef(repoDir, worktreePath, branch, deps);
}
export { createFixRungWorktreeWithHost as createFixRungWorktree };

export function latestPriorVerdictSuppresses(priorEntriesForOrigin: readonly FeedbackEntry[]): FeedbackEntry | undefined {
  let latest: FeedbackEntry | undefined;
  for (const entry of priorEntriesForOrigin) {
    if (!latest || Date.parse(entry.ts) > Date.parse(latest.ts)) latest = entry;
  }
  return latest?.status === "rejected" ? latest : undefined;
}

const repairFilingSuppressionsLogged = new Set<string>();

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

export const MOUNT_RECOMMENDER_CADENCE_POLICY = {
  kind: "daily-ledger-evidence-accrual",
  intervalMs: 24 * 60 * 60 * 1000,
} as const;

export function mountRecommenderCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-mount-recommender.json");
}

export function mountRecommenderNextFireMs(marker: ReturnType<typeof readFeedbackDocketMarker>): number | undefined {
  if (!marker) return undefined;
  const last = Date.parse(marker.lastFireIso);
  if (Number.isNaN(last)) return undefined;
  return last + MOUNT_RECOMMENDER_CADENCE_POLICY.intervalMs;
}

export const WORKER_STALLED_LEDGER_STEP = "worker.stalled";

export function findStalledWorkersWithHost(host: SweepCommandHost, 
  liveRuns: readonly Pick<LiveInflightRun, "runId" | "taskId">[],
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  thresholdMs: number,
  nowMs: number,
): WorkerStallCandidate[] {
  const WORKER_STATE_LEDGER_STEP = host.WORKER_STATE_LEDGER_STEP;
  const out: WorkerStallCandidate[] = [];
  for (const run of liveRuns) {
    let lastStateTs: number | undefined;
    let lastState: string | undefined;
    let lastStalledTs: number | undefined;
    for (const line of ledgerLines) {
      if (line.run_id !== run.runId) continue;
      const ts = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (line.step === WORKER_STATE_LEDGER_STEP && (lastStateTs === undefined || ts > lastStateTs)) {
        lastStateTs = ts;
        lastState = typeof line.state === "string" ? line.state : undefined;
      }
      if (line.step === WORKER_STALLED_LEDGER_STEP && (lastStalledTs === undefined || ts > lastStalledTs)) {
        lastStalledTs = ts;
      }
    }
    if (lastStateTs === undefined) continue; // nothing to measure yet (W1-T942 dependency)
    if (lastStalledTs !== undefined && lastStalledTs > lastStateTs) continue; // mid-episode — already reported
    const quietMs = nowMs - lastStateTs;
    if (quietMs < thresholdMs) continue;
    out.push({ runId: run.runId, taskId: run.taskId, quietMs, lastState });
  }
  return out;
}
export { findStalledWorkersWithHost as findStalledWorkers };

export const WORKER_STALL_TAIL_ATTACH_MAX_LINES = 100;

export const WORKER_STALL_TAIL_ATTACH_MAX_BYTES = 8 * 1024;

export function readWorkerTailBestEffort(tailPath: string): string[] {
  try {
    if (!existsSync(tailPath)) return [];
    return readFileSync(tailPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

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

export const WORKER_TAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function gitStatusResult(git: (args: string[]) => string, args: string[]): { status: number | null; out: string; error?: string } {
  try {
    return { status: 0, out: git(args) };
  } catch (error) {
    const failed = error as { status?: unknown; stdout?: unknown; message?: unknown };
    return { status: typeof failed.status === "number" ? failed.status : null, out: String(failed.stdout ?? ""),
      error: String(failed.message ?? error) };
  }
}

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

export interface CheckoutFixHeadRefDeps {
  /** Test seam at the exact compare-and-swap boundary; production never supplies it. */
  beforeHeadCompareAndSwap?: () => void;
}

export type RegisteredFixOwnerSignal = "managed" | "foreign" | "unknown";

const managedFixOwnerWorktreePrefixes = ["sweep", "run"] as const;

export interface ProcessCwdCensusDeps {
  readNextPid?: () => string | null;
  readCwd?: (pid: string) => string;
  now?: () => number;
  maxEntries?: number;
  wallMs?: number;
}

const FIX_OWNER_PROC_ENTRY_BOUND = 4_096;

const FIX_OWNER_PROC_WALL_MS = 100;

export function checkoutFixHeadRefWithHost(host: SweepCommandHost, 
  repoDir: string,
  worktreePath: string,
  branch: string,
  deps: CheckoutFixHeadRefDeps = {},
): FixHeadRecovery | undefined {
  const ZERO_GIT_OID = host.ZERO_GIT_OID;
  const preserveFixHead = preserveFixHeadWithHost.bind(undefined, host);
  const originSha = hostWorktreeGit(repoDir, ["rev-parse", `origin/${branch}`]).trim();
  const branchRef = `refs/heads/${branch}`;
  let localSha: string | null = null;
  try {
    localSha = hostWorktreeGit(repoDir, ["rev-parse", "--verify", branchRef]).trim();
  } catch {
    localSha = null; // no local ref yet — the "create fresh" case below.
  }

  let recovery: FixHeadRecovery | undefined;
  if (localSha === null) {
    hostWorktreeGit(repoDir, ["update-ref", branchRef, originSha, ZERO_GIT_OID]);
  } else if (localSha !== originSha) {
    if (fixHeadHeldByWorktree(repoDir, branchRef)) {
      throw new FixRungCheckoutRefusedError(branch, localSha, originSha);
    }
    let localIsAncestor = false;
    try {
      hostWorktreeGit(repoDir, ["merge-base", "--is-ancestor", localSha, originSha]);
      localIsAncestor = true;
    } catch {
      localIsAncestor = false; // non-zero exit ⇒ NOT an ancestor (ahead, or diverged) — refuse below.
    }
    if (!localIsAncestor) {
      const recoveryRef = preserveFixHead(repoDir, branch, localSha);
      recovery = { branch, localSha, originSha, recoveryRef };
    }
    deps.beforeHeadCompareAndSwap?.();
    try {
      hostWorktreeGit(repoDir, ["update-ref", branchRef, originSha, localSha]);
    } catch {
      throw new FixRungCheckoutRefusedError(branch, localSha, originSha);
    }
  }

  hostWorktreeGit(worktreePath, ["checkout", branch]);
  const checkedOutSha = hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
  if (checkedOutSha !== originSha) throw new FixRungCheckoutRefusedError(branch, checkedOutSha, originSha);
  return recovery;
}
export { checkoutFixHeadRefWithHost as checkoutFixHeadRef };

export interface WorkerStallCandidate {
  runId: string;
  taskId: string;
  /** ms of quiet since this run's newest `worker.state` transition. */
  quietMs: number;
  /** the run's newest recorded `worker.state` value, when one exists. */
  lastState: string | undefined;
}

export interface HeadroomRecoveryCandidate {
  issueUrl: string;
  window: string;
  resetsAt: string;
  /** The recovery reading that justifies retiring this issue — always `over_ceiling: false`,
   *  always for the SAME `window`, always newer than the escalation it retires. */
  recovery: { percentUsed: number; limitPct: number; ts: string };
}

export function fixHeadHeldByWorktree(repoDir: string, branchRef: string): boolean {
  return registeredFixWorktreeOwner(repoDir, branchRef) != null;
}
