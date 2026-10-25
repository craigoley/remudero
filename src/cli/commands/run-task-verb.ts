// W1-T9332: shared entrypoint collaborators arrive through the host; libraries import directly.
// Top-level helpers take narrow host ports; the factory snapshots ports once and binds public facades.
import type { PlanLintOutcome } from "../../lib/review.js";
import type { QuarantinedTask } from "../../lib/plan.js";
import { type FixProgressJudge, type FixProgressVerdict } from "../../lib/fix-progress-judge.js";
import { type BranchUpdateRecorder } from "../../lib/branch-update.js";
import { retryWhileLockBusy } from "../../lib/lock-busy-retry.js";
import { retryPollRead } from "../../lib/poll-read-retry.js";
import { recyclePauseDetail } from "../../lib/recycle-yield.js";
import { execFileSync, spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { rm as rmAsync } from "node:fs/promises";
import { RUN_AGENT_WAIT_HEAP_STEP, type AgentWaitHeap } from "../../lib/agent-wait-heap.js";
import { type FixOutcome as TypedFixOutcome } from "../../lib/fix-outcome.js";
import { type FixRoundReapplyPorts } from "../../lib/fix-round-reapply.js";
import { productionFixProgressJudge, type JobRequeueOutcome } from "../../lib/sweep.js";
import { ghExec, ghJsonAsync } from "../../lib/github-transport.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveRepoLayout } from "../../lib/repo-layout.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixStrikeCap, globalArtifactPath, enabledWorkerProviders, loadConfig, softBudgetThreshold, userOverallLearningsHome, workerHomeDir, type Config } from "../../lib/config.js";
import { ledgerPathFor, nextLaneEpochMs } from "../../lib/ledger-path.js";
import { realArmDepsAsync, isPrMergedNow, armAutoMerge, armAutoMergeAtOpen, armAutoMergeAtOpenAsync, disarmOutcomeWithdrawn, disarmAutoMerge, disarmAutoMergeAsync, armIfVerdictPermits, type ArmOutcome, type DisarmOutcome } from "../../lib/arm-auto-merge.js";
import { type BoardSnapshotCache } from "../../lib/board-snapshot-cache.js";
import { recordSkillUsage, skillUsagePath } from "../../lib/knowledge-gardener.js";
import { learningUsagePath, readLearningUsage, recordLearningUsage, seedOf } from "../../lib/knowledge-value.js";
import { contestedPropensities } from "../../lib/knowledge-outcome.js";
import { buildPromptManifest } from "../../lib/prompt-manifest.js";
import { billingMode, readBinaryPin, type BillingMode } from "../../lib/env.js";
import { renderAnchorBlock } from "../../lib/compaction.js";
import { checkpointCommitSubject, checkpointRemaining, classifyRoundTip, isWipSubject, judgeCheckpointStop, prTitleForTask, prTitleFromBranchCommits, renderContinuationPrompt, type CheckpointStop } from "../../lib/unfinished-checkpoint.js";
import { PREOPEN_GATE_STEP, preopenGateLedgerFields, renderPreopenGatePrompt, runPreopenGate, updatePreopenGateAlert, type PreopenGateResult } from "../../lib/preopen-gate.js";
import { implementPromptParts, renderDiagnosePrompt, renderFixPrompt, renderImplementPrompt, renderImplementPromptWithParts, renderReconPrompt, scopeGuardOutOfScopeFiles, type PriorPartialWork } from "../../lib/prompt-render.js";
import type { RunResult } from "../../lib/run-result.js";
import { dropTierRowsBeforePush, prePushGateRefusal } from "../../lib/pre-push-refusal.js";
import type { Tier } from "../../lib/tier.js";
import { routeSpecialists, taskMetadataFromPrinciples } from "../../lib/specialist-panel.js";
import { type DaemonFreshness, pendingWorkerBoundaryHandoffs } from "../../lib/daemon.js";
import { defaultListCandidates, defaultReadMarkers, killProcessGroup } from "../../lib/worker-containment.js";
import { sweepStaleTempDirsAsync, type TempSweepOpts, type TempSweepSummary } from "../../lib/tmp.js";
import { IMAGE_BUILD_SHA_PATH } from "../../lib/deployer.js";
import { bakedClosureCatalogDetails, bakedClosureCatalogFiles } from "../../lib/baked-closure-catalog.js";
import { createSelectedModeQualification, observeSelectedMode, instanceMode, readInstanceRegistryText } from "../../lib/instance-mode.js";
import { instanceRegistryRuntimePresent, withInstanceRegistryRuntime } from "../../lib/instance-registry-selection.js";
import type { RegistryFileIO } from "../../lib/instance-registry-selection.js";
import { resolveInstallRoot } from "../../lib/install-root.js";
import { escalate, escalateAsync, ghIssueGateway, ghIssueGatewayAsync, tryEscalate, type Escalation, type EscalationJudgeVerdict, type AsyncIssueGateway, type IssueGateway } from "../../lib/escalate.js";
import { mapRestPr, prStateFromRest, singlePrRestArgs, type ReviewReuseFacts, type GhApiFetcher, type RestPullRow, type RestRollupEntry } from "../../lib/open-prs-rest.js";
import { probeMerge, type MergedTypecheckPorts } from "../../lib/merge-probe.js";
import { recordDecision } from "../../lib/feedback-landing.js";
import { preflightFailureNotice, preflightSummaryPath } from "../../lib/ci-parity.js";
import { coverageNarrowSuites, type CoverageRun, type CoverageVerdict } from "../../lib/coverage-narrow.js";
import { buildAffectedSuitesGraph, type AffectedSelection } from "../../lib/affected-suites.js";
import { consumeSourceSizeFollowup, classifySourceSizeSummary, type ConsumeSourceSizeFollowupArgs, type ConsumeSourceSizeFollowupResult } from "../../lib/source-size-followup.js";
import { decideGatePosture, type GatePostureDecision, type GatePostureFinding, type GatePostureRuntime } from "../../lib/gate-posture.js";
import { refusalReason } from "../../lib/inbox.js";
import { gatherRuns, parseLedger } from "../../lib/retro.js";
import type { ChildEntryStoreOptions } from "../../lib/child-entry-argv.js";
import { bodyWithFailingProofAtOpen, defaultProofRunnerAsync, openPullRequestCheckedAsync, PrOpenRefusedError, readOtherOpenPrForTask, recordRefusedPrOpen, type AsyncOpenPullRequestProofRunner, type OpenPrJsonReader, type OpenPullRequestProofRunner } from "../../lib/pr-open.js";
import { createPlanPrRest, probeExistingPlanPr } from "../../lib/plan-pr-emitter.js";
import { findTaskShard, requestScopeAmendment, readBuildScopeRecovery, saveBuildScopeRecovery, restoreBuildScopeRecovery, type ScopeAmendmentOutcome, type ScopeAmendmentRequest, type ProofAmendmentWritePorts } from "../../lib/proof-amendment.js";
import { appendLedger, DECISION_RELEVANT_LEDGER_STEPS } from "../../lib/ledger.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { resolveReleasedIds, type ReleaseReaders } from "../../lib/drain.js";
import { cashTrialPolicy, cashTrialSpawnFields, decideCashTrial } from "../../lib/cash-trial.js";
import { benchmarkNonDispatchSpawn, callerOwnsBenchmarkReceipt, type BenchmarkStackEvidence, dispatchTaskShape, fixLaneBenchmarkWork, type BenchmarkWorkInput } from "../../lib/benchmark-run.js";
import { type RepairReceiptContext } from "../../lib/repair-cost-evidence.js";
import { type CiRemedyExecution } from "../../lib/ci-remedy-execution.js";
import { PAIRED_ATTEMPT_MAX_BUDGET_USD, PAIRED_CLI_REFUSAL, runPairedTrial, sealedPairedAttemptDispatcher, type PairedTrialInput } from "../../lib/paired-trial.js";
import { runProspectiveAaPair } from "../../lib/benchmark-aa-prospective.js";
import { parseSelfForecast, SELF_FORECAST_REPORT_CONTRACT } from "../../lib/self-forecast.js";
import { readLedgerUnionRecordsSync } from "../../lib/ledger-union.js";
import { releasedTaskIds, assertRunnable, loadPlan, selectTask, type AcceptanceCriterion, type TaskRisk, type Plan, type Task, taskRecordPath } from "../../lib/plan.js";
import { GENERIC_EXIT_CODE, RmdError } from "../../lib/errors.js";
import { assertLintClean, lintTask, TaskLintError } from "../../lib/task-linter.js";
import { readPriorRefusal, preDispatchContractRevision, writePriorRefusal, repairRefusedTask, type RefusalViolation } from "../../lib/dispatch-repair.js";
import { loadMounts, mountsPath, resolveMount, resolveMountForClass, type Mount } from "../../lib/mounts.js";
import { resolveMountExplorationDispatch as exploreMount } from "../../lib/mount-exploration.js";
import { type MountHeadroomCell } from "../../lib/mount-recommender.js";
import { loadDefaultPolicy, loadPolicy, policyPath } from "../../lib/policy.js";
import { loadRatifications, ratificationPinCheck, ratificationsPath, type Ratifications } from "../../lib/ratification.js";
import { defaultOpenFileCountAsync, reapStaleClones, reapStaleClonesAsync, type CloneReapSummary } from "../../lib/clone-reaper.js";
import { type ObjectReapDeps, type ObjectReapResult } from "../../lib/object-reaper.js";
import { deriveTaskClass, implementRouteClass } from "../../lib/task-class.js";
import { readFixRoutingRows } from "../../lib/fix-routing-learner.js";
import { DEFAULT_RISK_POLICY, readRiskPolicy, realRiskJudge, resolveRiskJudgeMount, riskJudgeDiffInputBudget, riskJudgePlanContext, riskJudgePlanContextDigest, riskJudgeSpendCollector, runRiskJudge, type RiskJudgeChangeView, type RiskJudgeInput, type RiskJudgeVerdict, withoutRiskJudgePatches } from "../../lib/risk-judge.js";
import { runShadowJudge, SHADOW_JUDGE_MAX_BUDGET_USD } from "../../lib/shadow-judge.js";
import { buildSkillEffectivenessReport, loadInjectableSkills, observeSkillSelection, renderSkillsPart, skillsInjectedEvent, skillWithheldForRun } from "../../lib/skill-workshop.js";
import { ContainmentError, probeContainment, type ProbeExecutor } from "../../lib/containment.js";
import { ProviderCapacityBlockedError, assertOpenWeightToolBoundary } from "../../lib/worker-provider.js";
import { IsolationError, probeIsolation, type ProbeExecutor as IsolationProbeExecutor } from "../../lib/isolation.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, LEARNING_PROPENSITY_DRAWS, parseRuleBodyPointer, parseRuleHeadlines, projectLearningsHome, renderHeadlineOnlyIndex, retrieveRuleBodyOrDegrade } from "../../lib/learnings.js";
import type { RuleHeadline } from "../../lib/learnings.js";
import { assertProvenance, citation } from "../../lib/provenance.js";
import { loadOperatorNotesForTask, renderOperatorNotes } from "../../lib/operator-notes.js";
import { computeMatchedLearningsForArm, resolveWipeTestArmPermission } from "../../lib/wipe-test.js";
import { loadPlanIndex, renderPlanIndex } from "../../lib/plan-index.js";
import { bodyContradictsDiff, cappedOverrideFromLedger, decideAutoMergeArm, decideArmFromLedgerVerdict, isTddStrict, judgeRubric, resolveAutoMergeArm, reviewerOutcome, reviewDecisionDigest, type PlanCriteriaAtHeadResult, parseWhitelistedProof, execWhitelistedProof, execWhitelistedProofAsync, type ReviewVerdict, type ReviewEvaluatorProvenance } from "../../lib/review.js";
import { recordHeadProviderAfterPush, type HeadReflogEntry } from "../../lib/review-provider-provenance.js";
import { decideDispatchClaim, releaseDispatchClaim, releaseDispatchClaimAsync, gitClaimRunnerAsync, dispatchClaimRef, pidIsPresent, readNamespaceBootMs, reclaimSilentDispatchClaim, holdDispatchClaim, type DispatchClaimReserverAsync } from "../../lib/dispatch-claim.js";
import { validateWorkerSettingsFile } from "../../lib/settings.js";
import { buildBatchedGithub, classifyGhFailure, deriveStatus, dispatchesWithoutNewOwnedPr, ghGateway, ghRequiredStatusCheckContexts, projectPlan, readLedgerLines, type GitHub, type GhFailureReason, preferImplementingPr, type PrRef, type BatchedPr, type StatusProjection, persistVerifiedCredit, type ThrownRunVerdictStage, type RefusedRunVerdictStage } from "../../lib/status.js";
import { dedupeRollupByLatestAttempt, buildFixProgressInput, terminalStateReason, type ActionableGateFailure, type CiFailure, type FixDispatchSnapshot, type FixSuperseded, type LiveStateResult, type MergeConflictEvidence, type OpenPrView, type RollupCheckEntry, type ProofDiscriminationEvidence, type RedBaseRefreshFacts, type SweepDeps, type RegistrationChange, trackRepairLadder, type FixRoundBranchClaim } from "../../lib/sweep.js";
import { classifyNoPrShape } from "../../lib/fix-rung-classify.js";
import { DEFAULT_PRUNE_GRACE_MS, appendQuestion, ghJson, parseDecisionRequest, parseLearningsUsed, parseSkillsUsed, parseQuestion, parseReconReport, parseReport, pruneStaleRuns, reapStaleWorktrees, removeRunLock, renderWorkerSettings, resolveGenericRouteToolBound, harnessOwnsGitFor, IMPLEMENT_CASH_TOOLS, IMPLEMENT_CLAUDE_TOOLS, WORKER_RULE_TOOL_NAME, implementToolBound, resolveDispatchLaneToolBound, cashDivertSpawnFields, cashFallbackRefusal, runAdhocLaneReapRung, runWorktreeReapRung, spawnWorker, cacheTokenLedgerFields, capStderrExcerpt, STDERR_EXCERPT_CAP, noPrReportExcerpt, listRegisteredWorktrees, readRunLock, workerLedgerFields, workerTranscript, resolveCommitAssignment, linkWorktreeNodeModules, worktreeAdd, worktreeAddAsync, worktreeLockIsPidAlive, worktreeRemove, worktreesDir, writeRunLock, WorktreeBaseStaleError, WorktreeNodeModulesRefusedError, detectWorktreeBaseUncheckableStreak, WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND, type RunLockInfo, type SpawnWorkerArgs, type RegisteredWorktree, type WorkerResult, type WorktreeReapSummary, WorkerStateTracker, DEFAULT_WORKER_QUIET_FLOOR_MS, type WorkerState, type WorkerStreamObserver, type WorkerStreamEvent, type WorkerSelectionAssignment, WorkerAbandonedError, deliverOperatorAnswerToRunningWorker, workerContinuation } from "../../lib/worker.js";
import { QuietRoundEndedError, createQuietBoundHistory, guardSpawnWithQuietWatchdog, productionQuietWorkerJudge, quietHistoryOptions, runQuietWorkerWatchdog, type QuietBoundHistory, type QuietWorkerJudge } from "../../lib/quiet-worker-watchdog.js";
import { isCodexWorkerOutputLimitError } from "../../lib/worker-provider.js";
import { type AddedTestAliasRewrite, type TestAliasRewriter } from "../../lib/added-test-alias-rewrite.js";
import { enrichWorkerStreamEvent } from "../../lib/worker-telemetry.js";
import { toolStepSignature } from "../../lib/tool-step-signature.js";
import { loadDefaultCostAnomalyPolicy, type CostAnomalyPolicy } from "../../lib/cost-anomaly.js";
import { hostWorktreeGit, hostWorktreeGitAsync, type HostWorktreeGitOptions } from "../../lib/worktree-git.js";
import { gitPushRunBranch, gitPushRunBranchAsync, LanePushForeignHeadError, step, type PushRunBranchAsyncOpts } from "../../lib/git-push.js";
import { sweepStaleWorkerHomes, sweepStaleWorkerHomesAsync } from "../../lib/worker-home.js";
import { FIX_WORKER_TOOLS, FIX_WORKER_TOOLS_HARNESS_COMMITS } from "../../lib/fix-fence.js";
import { acquireDrainLock, defaultIsPidAlive, type DrainLockHandle } from "../../lib/drain-lock.js";
import { checkReviewerCodeFreshnessAsync, type ReviewerCodeFreshness } from "../../lib/self-sync.js";
import { acquireInflightLock, InflightLockError, inflightLockPath, type InflightLockHandle } from "../../lib/inflight-lock.js";
import { runDiagnoseThenRetry, type DiagnoseThenRetryResult, type AttemptOutcome, type FailureSignal } from "../../lib/classify.js";
import { shouldRecordDecision, reversibilityFactor, type DiffFileChange } from "../../lib/risk-score.js";
import { assertLiveWriteAllowed } from "../../lib/live-write-guard.js";
import { runChildCredentialSocket } from "../../lib/secret-boundary.js";
import { repoRoot, resolveOwnerRepo } from "../../lib/repo-location.js";
import { flagValue } from "../../lib/cli-args.js";
import { resolveReviewTarget } from "../../lib/report-commands.js";
import { managedCheckoutInstallEscalation, stagedInstall, type StagedInstallFailure } from "../../lib/staged-install.js";
import { buildIntoStore, childEntryStoreRoot } from "../../lib/child-entry-store.js";
import { buildEngineAfterStore } from "../../lib/engine-tree.js";
import { chainAbortSignal } from "../../lib/run-child.js";
import { type RollupCheck, fetchCiFailures, fetchCiFailuresAsync } from "../../lib/tick-read-worker.js";

export type GitRunner = (args: string[], stdin?: string) => string;

export interface RunTaskCommandHost {
  readonly syncPlanOrRefuse: (planPath: string, opts: { allowStale: boolean; log: (step: string, extra?: Record<string, unknown>) => void; say: (msg: string) => void; planSnapshot?: (o: { allowStale?: boolean }) => SyncedPlan; quarantine?: (quarantined: QuarantinedTask[]) => void }) => SyncedPlan | { error: string };
  readonly lintPlanForReview: (headCheckoutDir: string | undefined) => Promise<PlanLintOutcome>;
  readonly proofRepairRoundRefusalInWorktree: (input: { worktreePath: string; roundStartSha: string | undefined; stageable: readonly string[]; proofs: readonly string[]; childRoot?: string; childStore?: ChildEntryStoreOptions }) => { reason: string; undeclared: string[] } | undefined;
  readonly startShellLessMergeConflictMerge: (worktreePath: string, injectedGit?: GitRunner) => { started: boolean; reason?: string };
  readonly terminalVerdictFields: (r: WorkerResult | null) => { provider?: WorkerResult["provider"]; model: string | null; served_model: string | null; routed_model?: string; selection_assignment_id?: string; tokens?: WorkerResult["tokens"]; worker_duration_ms?: number; total_cost_usd?: number; notional_cost_usd?: number; spend_role?: "restated"; success?: boolean };
  readonly renderReconClaimLines: (taskId: string, observedLines: string[], gapLines: string[]) => string[];
  readonly CENSUS_BASELINE_FILES: readonly string[];
  readonly BRANCH_NAME_CONTRACT_PART: string;
  readonly workerBoundaryStack: BenchmarkStackEvidence & { loadedModule?: import("../../lib/prevention-source-evidence.js").ImportedModuleEvidence };
  readonly buildBaseReproductionProbe: (config: Config, repoDir: string, ledgerPath: string, log: (step: string, extra?: Record<string, unknown>) => void, deps?: Pick<SweepDeps, "readLedger"> & {
    git?: (args: string[], timeoutMs: number) => Promise<void>;
    link?: typeof linkWorktreeNodeModules;
    readFile?: (path: string) => Promise<unknown>;
    remove?: typeof rmAsync;
    execute?: typeof execWhitelistedProofAsync;
    timeout?: () => number;
    clock?: Clock;
    
    merge?: boolean;
    
    treeGit?: (tree: string, args: string[], timeoutMs: number) => Promise<unknown>;
  }) => NonNullable<SweepDeps["reproduceFailingTestsOnMain"]>;
  readonly writeSyncLine: (fd: 1 | 2, line: string) => void;
  readonly WORKER_STATE_LEDGER_STEP: string;
  readonly capWorkerTailLines: (lines: readonly string[], maxLines?: number, maxBytes?: number) => string[];
  readonly writeWorkerTailBestEffort: (tailPath: string, lines: readonly string[]) => void;
  readonly attributeWorkerStreamEvent: (event: WorkerStreamEvent, assignment: Pick<WorkerSelectionAssignment, "id" | "selected"> | undefined) => WorkerStreamEvent;
  readonly quietBoundHistory: ReturnType<typeof createQuietBoundHistory>;
  readonly readWorktreeHeadReflog: (worktreePath: string) => HeadReflogEntry[] | undefined;
  readonly workerCreatedCurrentHead: (worktreePath: string, before: ReadonlyArray<HeadReflogEntry> | undefined) => boolean;
  readonly syncPlanOrRefuseAsync: (planPath: string, opts: Omit<Parameters<RunTaskCommandHost["syncPlanOrRefuse"]>[1], "planSnapshot"> & {
    planSnapshot?: (o: { allowStale?: boolean }) => SyncedPlan | Promise<SyncedPlan>;
  }) => Promise<SyncedPlan | { error: string }>;
  readonly isTerminalRed: (state: string) => boolean;
  readonly ghPrCreateFillCommand: (worktreePath: string, owner: string, repo: string, branch: string, title?: string, bodyOverride?: string, proofRunner?: OpenPullRequestProofRunner, childStore?: ChildEntryStoreOptions) => PrCreateCommand;
  readonly withDiagnostics: (command: PrCreateCommand, diagnostics: PrCreateDiagnostic[]) => PrCreateCommand;
  readonly draftPrCreate: (worktreePath: string, owner: string, repo: string, branch: string, title?: string, bodyOverride?: string) => { title: string; body: string; diagnostics: PrCreateDiagnostic[] };
  readonly prCreateArgv: (worktreePath: string, owner: string, repo: string, branch: string, resolvedTitle: string, checkedBody: string) => PrCreateCommand;
  readonly runGhPrCreate: (prCreate: { command: "gh"; args: string[]; options: { cwd: string; encoding: "utf8" }; diagnostics?: readonly PrCreateDiagnostic[] }, branch: string, log: (step: string, extra?: Record<string, unknown>) => void, say: (msg: string) => void, exec?: (command: string, args: string[], options: { cwd: string; encoding: "utf8" }) => string) => { prUrl?: string; prNumber?: number };
  readonly lastCommitSubject: (worktreePath: string) => string | undefined;
  readonly appendTaskTrailerToCommit: (worktreePath: string, taskId: string) => boolean;
  readonly fetchPrBodyViaGh: (prUrl: string, gh?: (args: string[]) => unknown) => Promise<string>;
  readonly fetchPrDiffFilesViaGh: (prUrl: string, gh?: (args: string[]) => unknown) => Promise<string[]>;
  readonly changeView: (prUrl: string, fetch?: (args: string[]) => unknown) => RiskJudgeChangeView;
  readonly rewriteAcceptanceBlockFromPlan: (body: string, taskId: string, planCriteria: readonly AcceptanceCriterion[]) => | { kind: "no-block" | "healthy" }
  | { kind: "rewritten"; repairedBody: string; removedProofs: string[]; planProofs: string[] };
  readonly execGrepProofInWorktree: (cwd: string) => (proof: string) => { hits: number } | undefined;
  readonly ensureTaskTrailer: (prUrl: string, taskId: string, log?: (step: string, extra?: Record<string, unknown>) => void, read?: (args: string[]) => unknown, write?: (args: string[]) => unknown) => void;
  readonly ghPrHeadGateway: (gh?: (args: string[]) => unknown) => PrHeadGateway;
  readonly checkPrOwnership: (prUrl: string, ownBranch: string, gateway: PrHeadGateway, costUsd: number, accountLabel?: string) => OwnershipVerdict | null;
  readonly scrubGitCredentialText: (text: string) => string;
  readonly openTaskIdsFromPlan: (plan: Plan, projection?: ReadonlyMap<string, StatusProjection>) => Set<string>;
  readonly yieldingSleep: (ms: number) => Promise<void>;
  readonly restRollupFor: (owner: string, repo: string, sha: string, read: (args: string[]) => Promise<unknown>) => Promise<RestRollupEntry[]>;
  readonly pollRestTarget: (prUrl: string, who: string) => { owner: string; repo: string; number: number };
  readonly ciGateState: (r: CiGateOutcome | "green" | "red" | "timeout") => "green" | "red" | "timeout" | "freshness_handoff";
  readonly STALL_WINDOW: number;
  readonly checkWaitStalled: (readings: ReadonlyArray<RollupEntry[] | undefined>) => {
  stalled: boolean;
  pending: string[];
};
  readonly waitForCiGreen: (prUrl: string, log: (step: string, extra?: Record<string, unknown>) => void, everySec?: number, deps?: PollDeps) => Promise<CiGateOutcome>;
  readonly runReview: (args: {
  owner: string;
  repo: string;
  prUrl: string;
  
  runtimeImageSha?: string | null;
  
  task: { id: string; acceptance?: AcceptanceCriterion[]; files?: string[]; risk?: TaskRisk; budget_usd?: number; sourcePath?: string };
  
  readReviewReuseFacts?: () => ReviewReuseFacts | undefined;
  report: string;
  
  implementationReport?: string;
  
  reportIsSubstitute?: boolean;
  
  reviewInputBody?: string;
  
  reportSubstituteCause?: import("../../lib/review.js").ReportSubstituteCause;
  settingsFile: string;
  config: Config;
  budgetUsd?: number;
  log: (step: string, extra?: Record<string, unknown>) => void;
  say: (msg: string) => void;
  account: (r: WorkerResult) => WorkerResult;
  
  spawnReviewer?: boolean;
  
  requireSemanticReview?: boolean;
  
  reviewerQueryFn?: SpawnWorkerArgs["queryFn"];
  
  reviewerSpawnWorker?: typeof spawnWorker;
  
  workerTelemetry?: WorkerStateSensor;
  
  reviewerMount?: Mount;
  
  reviewerClockBoundMs?: number;
  
  headCheckoutDir?: string;
  
  baseCheckoutDir?: string;
  
  baseUnreadablePaths?: ReadonlySet<string>;
  
  baseIsCheckout?: boolean;
  
  addedTestFiles?: ReadonlySet<string>;
  
  materializationFailure?: MaterializationFailure;
  
  disarm?: (prUrl: string) => DisarmOutcome | void;
  
  headRefName?: string;
  
  arm?: (prUrl: string, taskId: string) => ArmOutcome;
  
  ledgerPath: string;
  
  runId: string;
  
  judgeRubricFn?: typeof judgeRubric;
  
  lintPlanForReviewFn?: RunTaskCommandHost["lintPlanForReview"];
  
  openTaskIds?: ReadonlySet<string>;
  
  reviewerCodeFreshness?: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>;
}) => Promise<ReviewRunResult>;
  readonly ghLiveState: (prUrl: string) => LiveStateResult;
  readonly ghLiveHead: (prUrl: string, gh?: (args: string[]) => unknown) => LiveHeadResult;
  readonly captureWorktreeSnapshotViaGit: (worktreePath: string) => WorktreeSnapshot | undefined;
  readonly ghUpdateBranch: (owner: string, repo: string, prNumber: number, exec?: typeof execFileSync, via?: string, record?: BranchUpdateRecorder) => { ok: boolean; error?: string };
  readonly redBaseRefreshFactsFromRest: (owner: string, repo: string, prNumber: number, fetch?: GhApiFetcher) => RedBaseRefreshFacts;
  readonly fixRebaseMergeFactsFromRest: (owner: string, repo: string, prNumber: number, fetch?: GhApiFetcher) => FixRebaseMergeFacts;
  readonly reclaimAbandonedWorker: (info: { runId: string; taskId: string; elapsedMs: number }, deps?: {
    listCandidates?: typeof defaultListCandidates;
    readMarkers?: typeof defaultReadMarkers;
    kill?: typeof killProcessGroup;
    
    log?: (step: string, extra?: Record<string, unknown>) => void;
  }) => void;
  readonly fixWorkerRunId: (callerRunId: string, label: string, startedAtMs: number) => string;
  readonly fixWorkerReceipt: (spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>, log: (step: string, extra?: Record<string, unknown>) => void, workerRunId: string, work?: BenchmarkWorkInput, repair?: RepairReceiptContext, tail?: { root: string }, remedyExecution?: CiRemedyExecution) => {
  spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
  joinFields: () => Record<string, unknown>;
  ledgerFields: (result: WorkerResult) => Record<string, unknown>;
};
  readonly spawnFixWorkerBounded: (deps: {
    spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
    spawnWallClockBoundMs?: number;
    reclaimWorker?: (info: { runId: string; taskId: string; elapsedMs: number }) => void | Promise<void>;
    watchSuperseded?: (snapshot: FixDispatchSnapshot, signal: AbortSignal) => Promise<FixSuperseded | undefined>;
    log: (step: string, extra?: Record<string, unknown>) => void;
  }, args: SpawnWorkerArgs, ctx: { runId: string; taskId: string; snapshot?: FixDispatchSnapshot }) => Promise<
  | { kind: "spawned"; result: WorkerResult; elapsedMs: number }
  | { kind: "abandoned"; elapsedMs: number }
  | { kind: "superseded"; elapsedMs: number; superseded: FixSuperseded }
>;
  readonly readFixRoundCommitsViaGit: (worktreePath: string, sinceSha: string) => FixRoundCommit[];
  readonly runNpmScriptViaSpawn: (script: string, cwd: string) => { status: number; stdout: string; stderr: string };
  readonly commitGeneratorOutputViaGit: (opts: { cwd: string; message: string; git?: (cwd: string, args: string[]) => string }) => { sha: string; changed: boolean };
  readonly readPackageScriptsFor: (worktreePath: string) => Readonly<Record<string, string>>;
  readonly runFixRung: (opts: {
  
  guardRoundHead?: boolean;
  taskId: string;
  runId: string;
  
  task: { id: string; title: string; acceptance?: AcceptanceCriterion[]; files?: string[]; design?: string; amendment?: string; narrativeUnavailable?: true };
  prUrl: string;
  branch: string;
  worktreePath: string;

  initialSessionId: string;
  initialSessionProvider?: WorkerResult["provider"];
  mount: Mount;
  
  stepUpMount?: Mount;
  settingsFile: string;
  config: Config;
  budgetUsd: number;
  strikeCap: number;
  progressDecision?: FixProgressVerdict;
  progressApproach?: string;
  
  useProductionProgressJudge?: boolean;
  
  retriggerCap?: number;
  
  initialReview: ReviewRunResult;
  
  progressReviewInputDigest?: string;
  initialCriterionIndices?: readonly number[];
  reviewBase: { owner: string; repo: string; headCheckoutDir: string; reviewerMount: Mount }; birthWorktreeSnapshot?: WorktreeSnapshot;
  
  reviewerClockBoundMs?: number;
  
  workerTelemetry?: WorkerStateSensor;
  
  openTaskIds?: ReadonlySet<string>;
  
  reviewerCodeFreshness?: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>;
  
  constraint?: string;
  feedbackContributions?: readonly unknown[];
  
  ciFailures?: CiFailure[];
  ciEvidenceDisagreement?: CiEvidenceDisagreementObservation;
  
  escalationJudge?: (e: Escalation) => Promise<EscalationJudgeVerdict>;
  
  mergeConflict?: MergeConflictEvidence;
  baseSha?: string;
  
  actionableGateFailures?: ActionableGateFailure[];
  
  proofDiscrimination?: ProofDiscriminationEvidence;
  
  priorPartialWork?: PriorPartialWork;
  deps: {
    spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
    fixProgressJudge?: FixProgressJudge;
    
    harnessCommitForShellLessWorker?: RunTaskCommandHost["harnessCommitForShellLessWorker"];
    writeFixCensusSnapshot?: (...args: Parameters<RunTaskCommandHost["writeFixCensusSnapshot"]>) => string | undefined | Promise<string | undefined>;
    readMainTip?: () => string | Promise<string>;
    reproduceFailingTestsOnMain?: NonNullable<SweepDeps["reproduceFailingTestsOnMain"]>;
    requeueCheck?: (failure: CiFailure) => boolean | JobRequeueOutcome | Promise<boolean | JobRequeueOutcome>;
    
    proofRepairRoundRefusal?: RunTaskCommandHost["proofRepairRoundRefusalInWorktree"];
    scopeAmendmentWritePorts?: ProofAmendmentWritePorts;
    scopeAmendmentPortsIo?: Parameters<RunTaskCommandHost["buildProofAmendmentWritePorts"]>[1];
    scopeAmendmentGit?: typeof hostWorktreeGitAsync;
    
    worktreeHasUncommittedChanges?: (worktreePath: string) => boolean;
    
    startShellLessMergeConflictMerge?: RunTaskCommandHost["startShellLessMergeConflictMerge"];
    
    commitsAhead?: (worktreePath: string, base: string) => number;
    readRemoteBranchHead?: (worktreePath: string, branch: string) => Promise<string | undefined>; 
    
    waitForCiGreen: (
      prUrl: string,
      log: (step: string, extra?: Record<string, unknown>) => void,
    ) => Promise<CiGateOutcome | "green" | "red" | "timeout">;
    
    readLiveState?: (prUrl: string) => LiveStateResult | Promise<LiveStateResult>;
    
    readLiveHead?: (prUrl: string) => LiveHeadResult | Promise<LiveHeadResult>;
    
    fetchCiFailures?: (prUrl: string, sha?: string) => Promise<CiFailure[]>;
    
    readCiRollup?: (prUrl: string) => RollupCheckEntry[] | Promise<RollupCheckEntry[]>;
    
    fetchPrBody?: (prUrl: string) => Promise<string>;
    
    fetchPrDiffFiles?: (prUrl: string) => Promise<string[]>;
    
    updatePrBody?: (prUrl: string, body: string) => Promise<void>;
    
    addedTestsAtHead?: (headSha: string) => AddedTestsAtHead;
    
    diffAtHead?: (headSha: string) => string | undefined;
    
    execAcceptanceGateRepairProof?: (proof: string) => { hits: number } | undefined;
    
    resolveTaskContractAtHead?: (
      prUrl: string,
      taskId: string,
    ) => PlanCriteriaAtHeadResult | undefined | Promise<PlanCriteriaAtHeadResult | undefined>;
    runReview: (args: Parameters<RunTaskCommandHost["runReview"]>[0]) => ReturnType<RunTaskCommandHost["runReview"]>;
    
    push: (worktreePath: string, branch: string, expectedHeadSha?: string, priorHeadSha?: string) => unknown;
    
    readHeadShaForProvenance?: (prUrl: string) => string;
    issues: IssueGateway;
    escalationIssues?: AsyncIssueGateway;
    ledgerPath: string;
    
    readFixRoutingRows?: (stateDir: string, nowMs: number) => Promise<Array<Record<string, unknown>>>;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    account: (r: WorkerResult) => WorkerResult;
    
    spawnWallClockBoundMs?: number;
    
    reclaimWorker?: (info: { runId: string; taskId: string; elapsedMs: number }) => void | Promise<void>;
    watchSuperseded?: (snapshot: FixDispatchSnapshot, signal: AbortSignal) => Promise<FixSuperseded | undefined>;
    
    readPrerequisiteState?: (prNumber: number) => LiveStateResult | Promise<LiveStateResult>;
    
    readMergeFacts?: (prNumber: number) => FixRebaseMergeFacts | Promise<FixRebaseMergeFacts>;
    
    updateBranch?: (prNumber: number) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
    
    readRedBaseRefreshFacts?: (prNumber: number) => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>;
    
    reproduceFailingTestsOnMerge?: NonNullable<SweepDeps["reproduceFailingTestsOnMerge"]>;
    
    ledgerLines?: () => Array<Record<string, unknown>>;
    
    captureWorktreeSnapshot?: (worktreePath: string) => WorktreeSnapshot | undefined | Promise<WorktreeSnapshot | undefined>; readRegisteredWorktrees?: () => readonly RegisteredWorktree[] | Promise<readonly RegisteredWorktree[]>;
    
    readRoundCommits?: ReadFixRoundCommits;
    
    runGeneratorScript?: (script: string, cwd: string) => Promise<{ status: number; stdout: string; stderr: string }>;
    
    commitGeneratorOutput?: (opts: { cwd: string; message: string }) => { sha: string; changed: boolean } | Promise<{ sha: string; changed: boolean }>;
    
    packageScripts?: Readonly<Record<string, string>>;
    
    branchClaim?: FixRoundBranchClaim;
    
    approvedSkillsDir?: string;
  };
}) => Promise<FixRungOutcome>;
  readonly buildProofAmendmentGitOps: (git?: (worktreePath: string, args: string[]) => string) => {
  gitAdd: (worktreePath: string, relPath: string) => void;
  gitCommit: (worktreePath: string, message: string) => string;
};
  readonly buildProofAmendmentWritePorts: (params: {
    taskId: string;
    worktreePath: string;
    config: Config;
    owner: string;
    repo: string;
    prNumber: number;
    ledgerLinesNow: readonly Record<string, unknown>[];
    log: (step: string, extra?: Record<string, unknown>) => void;
    gitOps: { gitAdd: (worktreePath: string, relPath: string) => void; gitCommit: (worktreePath: string, message: string) => string };
    amendmentKind?: "proof_amendment" | "scope_amendment";
  }, io?: {
    findShardFn?: typeof findTaskShard;
    worktreeAddFn?: typeof worktreeAdd;
    worktreeRemoveFn?: typeof worktreeRemove;
    writeFileFn?: (absPath: string, text: string) => void;
    gitPushFn?: (worktreePath: string, branch: string, expectedHeadSha: string) => void;
    ghJsonFn?: GhApiFetcher;
    probeExistingPlanPrFn?: typeof probeExistingPlanPr;
    createPlanPrRestFn?: typeof createPlanPrRest;
    isPrMergedNowFn?: typeof isPrMergedNow;
    ghExecFn?: typeof ghExec;
    assertLiveWriteAllowedFn?: typeof assertLiveWriteAllowed;
  }) => ProofAmendmentWritePorts;
  readonly prNumberFromRef: (ref: string) => number | undefined;
  readonly workerSignal: (r: WorkerResult) => FailureSignal;
  readonly harvestFollowupsFromReport: (text: string, ctx: {
    label: string;
    prUrl?: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    
    runId?: string;
    
    seen?: Set<string>;
  }) => void;
  readonly commitsAhead: (worktreePath: string, base: string) => number;
  readonly sha256Hex: (s: string) => string;
  readonly readRuleSourceFileOrUndefined: (path: string) => string | undefined;
  readonly DEFAULT_BUDGET_USD: number;
  readonly archiveWorkerTranscript: (opts: {
    root: string;
    taskId: string;
    runId: string;
    rung: string;
    text: string;
    model?: string;
    verdict?: string;
    headSha?: string;
    retention?: number;
    worker?: Pick<WorkerResult, "provider" | "routedModel" | "servedModel" | "selectionAssignmentId">;
  }, log: (step: string, extra?: Record<string, unknown>) => void) => { path: string; bytes: number } | undefined;
  readonly withPredecessorTranscriptCopies: <T>(args: SpawnWorkerArgs, opts: { root: string; taskId: string; excludeRunId?: string; limit?: number }, spawn: (args: SpawnWorkerArgs) => Promise<T>, log: (step: string, extra?: Record<string, unknown>) => void) => Promise<T>;
  readonly benchmarkRunLedgerLogger: (write: (step: string, fields: Record<string, unknown>) => void, stackEvidence?: BenchmarkStackEvidence, initialWork?: BenchmarkWorkInput) => (step: string, extra?: Record<string, unknown>) => void;
  readonly recordBenchmarkWorkerAttempt: (call: () => Promise<WorkerResult>, log: (step: string, fields: Record<string, unknown>) => void, selected: () => { id: string } | undefined, stopPolling: () => void) => Promise<WorkerResult>;
  readonly dispatchFallbackObserver: (log: (step: string, fields: Record<string, unknown>) => void, caller?: SpawnWorkerArgs["onModelFallbackAttempt"]) => NonNullable<SpawnWorkerArgs["onModelFallbackAttempt"]>;
  readonly withGitCredentialSocket: (args: SpawnWorkerArgs, socketPath: string, harnessCheckout?: string) => SpawnWorkerArgs;
  readonly runErrorCause: (err: unknown) => RunErrorCause;
  readonly censusPushRefusal: (err: unknown) => CensusPushRefusal | undefined;
  readonly CENSUS_PUSH_CHECK: string;
  readonly CENSUS_SNAPSHOT_ENV: string;
  readonly COVERAGE_PUSH_CHECK: string;
  readonly CENSUS_PUSH_NEVER_BYPASS: string;
  readonly fixCensusAppliesToRepo: (repo: string | undefined, log: (step: string, extra?: Record<string, unknown>) => void, resolveSelf?: () => { owner: string; repo: string }) => boolean;
  readonly writeFixCensusSnapshot: (root: string, log: (step: string, extra?: Record<string, unknown>) => void, runGit?: typeof hostWorktreeGit) => string | undefined;
  readonly writeFixCensusSnapshotAsync: (root: string, log: (step: string, extra?: Record<string, unknown>) => void, runGit?: (root: string, args: string[], options?: HostWorktreeGitOptions) => string | Promise<string>) => Promise<string | undefined>;
  readonly checkFixCensusSnapshotAsync: (root: string, path: string | undefined, log: (step: string, extra?: Record<string, unknown>) => void, run?: CensusChildRunner<Promise<CensusChildResult>>) => Promise<{ refusal?: CensusPushRefusal; unmeasured?: string } | undefined>;
  readonly FixRoundPushError: new (pushCause: RunErrorCause, refusal: CensusPushRefusal | undefined, detail: string) => RmdError & { readonly pushCause: RunErrorCause; readonly refusal: CensusPushRefusal | undefined; readonly detail: string };
  readonly pushFixRound: (wt: string, branch: string, expectedHeadSha?: string, priorHeadSha?: string, deps?: Pick<PushRunBranchAsyncOpts, "capture" | "exec"> & { mergedTypecheck?: MergedTypecheckPorts }) => Promise<FixRoundPushReceipt>;
  readonly coveragePrecheck: (wt: string, ports?: CoveragePrecheckPorts) => Promise<CoveragePrecheck>;
  readonly coveragePushRefusal: (result: CoveragePrecheck, log: (step: string, extra?: Record<string, unknown>) => void, site: string) => CensusPushRefusal | undefined;
  readonly pushFixRoundPrechecked: (log: (step: string, extra?: Record<string, unknown>) => void, wt: string, branch: string, expectedHeadSha?: string, ports?: CoveragePrecheckPorts, push?: (wt: string, branch: string, expectedHeadSha?: string, priorHeadSha?: string) => unknown, priorHeadSha?: string, reapply?: { ports?: FixRoundReapplyPorts; attempted?: boolean }) => Promise<unknown>;
  readonly repairRetroAcceptanceBlock: (prUrl: string, log: (step: string, extra?: Record<string, unknown>) => void, deps?: {
    fetchBody?: (url: string) => string;
    editBody?: (url: string, body: string) => void;
    
    diff?: string;
    
    diffText?: (url: string) => string;
  }) => "repaired" | "healthy" | "unrepresentable" | "error";
  readonly defaultRetroFetchBody: (url: string) => string;
  readonly defaultRetroEditBody: (url: string, body: string) => void;
  readonly prUrlTarget: (prUrl: string) => { owner: string; repo: string; number: number } | undefined;
  readonly readHeadShaRest: (prUrl: string, fetch?: GhApiFetcher) => string;
  readonly resolveFixRungTaskContractAtHeadAsync: (prUrl: string, taskId: string, repoDir: string, readHeadSha?: (prUrl: string) => string) => Promise<PlanCriteriaAtHeadResult | undefined>;
  readonly MERGE_BASE_DIFF_ARGS: readonly ["diff", "--name-only", "origin/main...HEAD"];
  readonly hostWorktreeGitResult: (worktreePath: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  readonly dispatchClaimReserverAsyncFor: (repoDir: string) => DispatchClaimReserverAsync;
  readonly WORKTREE_REAP_BOOT_CONTRACT_VERSION: string;
  readonly logCloneReapSurvey: (config: Config, log: (step: string, fields: Record<string, unknown>) => void, deps?: {
    roots?: () => string[];
    reap?: typeof reapStaleClones;
    policy?: () => { enabled: boolean; maxAgeHours: number };
    
    ratifications?: Ratifications;
  }) => CloneReapSummary | null;
  readonly cloneReapPlan: (config: Config, log: (step: string, fields: Record<string, unknown>) => void, deps: Omit<NonNullable<Parameters<RunTaskCommandHost["logCloneReapSurvey"]>[2]>, "reap">) => { roots: string[]; opts: { dryRun: boolean; maxAgeMs: number } };
  readonly logCloneReapRow: (log: (step: string, fields: Record<string, unknown>) => void, summary: CloneReapSummary, rootsSurveyed: number) => CloneReapSummary;
  readonly DISK_RECLAIM_DEFAULT_SWEEPS: { readonly sweepTempDirs: typeof sweepStaleTempDirsAsync; readonly reapClonesSurvey: RunTaskCommandHelpers["logCloneReapSurveyAsync"]; readonly sweepWorkerHomes: typeof sweepStaleWorkerHomesAsync };
  readonly createDaemonGatewayFactory: (root: string, log: (event: string, extra?: Record<string, unknown>) => void, opts?: {
    snapshotFor?: (owner: string, repo: string) => BoardSnapshotCache;
    trailerIndexFor?: (owner: string, repo: string) => (() => Map<string, PrRef[]> | null) | undefined;
    exec?: (args: string[]) => string;
    fetchAll?: () => BatchedPr[];
    fetchChangedFiles?: (prNumber: string) => Promise<string[] | undefined>;
  }) => (owner: string, repo: string) => GitHub;
  readonly readRegistrationChanges: (repoDir: string, paths: readonly string[], baseRef?: string, git?: PublishAbandonedFixOwnerAheadDeps["runGit"], headRef?: string) => RegistrationChange[];
  readonly commitWorkerEdits: (repoDir: string, declaredPaths: readonly string[], message: string, deps?: PublishAbandonedFixOwnerAheadDeps, acceptance?: readonly AcceptanceCriterion[], options?: { admitTests?: boolean; priorHeadSha?: string; branch?: string; checkpoint?: boolean; aliasRewriter?: TestAliasRewriter }) => WorkerEditCommit;
  readonly fixRoundGitOwnership: (config: Pick<Config, "workerProviders">) => { harnessCommits: boolean; cashTools: string[] | undefined };
  readonly MISSING_COMMIT_MESSAGE_REASON: string;
  readonly harnessCommitForShellLessWorker: (input: {
    
    harnessOwnsGit: boolean;
    commitCount: number;
    report: string;
    worktreePath: string;
    declaredPaths: readonly string[];
    acceptance?: readonly AcceptanceCriterion[];
    admitTests?: boolean;
    priorHeadSha?: string;
    branch?: string;
    fixOutcome?: TypedFixOutcome["kind"];
    subjectSource?: "worker-authored" | "re-asked" | "harness-derived";
    derivedCommit?: { subject: string; reason: string };
    
    assignmentId?: string;
    requireMergeHead?: boolean;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    
    onRefusal?: (reason: string, undeclared?: readonly string[], conflictMarkerFiles?: readonly string[]) => void;
    
    onCommit?: (sha: string, undeclared?: readonly string[]) => void;
  }, deps?: { commit?: RunTaskCommandHost["commitWorkerEdits"]; ahead?: (worktreePath: string, base: string) => number }) => number;
  readonly worktreeHasUncommittedChanges: (worktreePath: string) => boolean;
  readonly COMMIT_LINE_RESUME_PROMPT: string;
  readonly writerCannotResume: (provider: WorkerResult["provider"], tools?: readonly string[]) => boolean;
  readonly missingCommitLinePrompt: (input: {
  provider?: WorkerResult["provider"];
  tools?: readonly string[];
  title: string;
  report: string;
  worktreePath: string;
  declaredPaths?: readonly string[];
}) => string;
  readonly pathIsUnderDeclaredSurface: (path: string, declaredPaths: readonly string[]) => boolean;
  readonly execFilePromise: (file: string, args: readonly string[], options: import('node:child_process').ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string; stderr: string }>;
  readonly AWAITING_EXTERNAL_LEDGER_STEP: string;
  readonly readLedgerRawLines: (path: string) => readonly string[];
  readonly releaseReadersFor: (path: string) => ReleaseReaders;
}

export interface WorkerStateSensor {
  /** Pass as `spawnWorker`'s `streamObserver` at every call site for this run. */
  observer: WorkerStreamObserver;
  /** Start the quiet-floor poll for the DURATION of one in-flight spawn call; returns the stop
   *  function — call it (typically via `.finally`) the instant that spawn settles. Safe to call
   *  again for the NEXT spawn in the same run: each call owns its own timer, `unref`'d so it
   *  never keeps the process alive on its own. */
  startPolling: () => () => void;
  /**
   * W1-T2557: set (at most meaningfully once per run, right after `taskClass` resolves — see
   * `runTask`'s own call site) the turn-count bound {@link deriveRunawayTurnBound} derived for
   * this run's class. `undefined` — the default until this is called, and the value a
   * best-effort derivation failure passes — means the mid-flight runaway signal never fires for
   * this run: never a guessed bound standing in for one that could not be derived.
   */
  setRunawayBound: (bound: number | undefined) => void;
}

export interface SyncedPlan {
  plan: Plan;
  /** True when `git fetch` failed and `allowStale` let the run proceed on the last-known refs. */
  staleDispatch: boolean;
}

export interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  /** W1-T2804 — when this ATTEMPT started. Already carried at runtime by every producer this
   *  interface widens ({@link RestRollupEntry.startedAt}); declared here so the poll-loop readers
   *  can hand these entries to {@link dedupeRollupByLatestAttempt}, which sorts on it, without
   *  the type silently erasing the only field that distinguishes one attempt from its successor. */
  startedAt?: string;
}

export type PrCreateDiagnostic = { step: string; extra: Record<string, unknown> };

export type PrCreateCommand = { command: "gh"; args: string[]; options: { cwd: string; encoding: "utf8" }; diagnostics?: PrCreateDiagnostic[] };

export type BoundaryCheckpointRestore =
  (| { base: "main"; headSha: string; dropped?: true }
  | { base: "checkpoint"; headSha: string; mainConflicts: string[]; reason?: string }) & { sourceBranchAbsent?: true };

export type AddedTestsAtHead = { kind: "read"; files: readonly string[] } | { kind: "unreadable"; reason: string };

export interface PrHeadGateway {
  /** The PR's head branch name, or `undefined` if it cannot be resolved. */
  headRefName(prUrl: string): string | undefined;
}

export interface OwnershipVerdict {
  verdict: "pr_attribution_failed";
  ledger: {
    verdict: "pr_attribution_failed";
    claimed_url: string;
    claimed_branch: string | null;
    owned_branch: string;
    cost_usd: number;
    /** W1-T268: the account this run's spend is attributed to — see {@link WorkerResult.accountLabel}. */
    account_label?: string;
    reason: string;
  };
}

export interface RemotePresenceProbeFailure {
  status: number | null;
  stderr: string;
}

export type FallbackPushCause =
  | { cause: "probe_unreadable"; detail: string; evidence: string }
  | { cause: "credential_expired"; detail: string; evidence: string }
  | { cause: "push_not_attempted"; detail: string; evidence: string }
  | { cause: "undetermined"; detail: string; evidence: string };

export interface GateOutcome {
  merged: boolean;
  verdict?: "awaiting_merge" | "blocked_ci" | "handed_off";
  reason: string;
  headSha?: string;
  checks?: string[];
}

export interface PollDeps {
  /** Defaults to {@link ghJsonAsync}. */
  readJson?: (args: string[]) => Promise<unknown>;
  /** Defaults to {@link yieldingSleep}. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * W1-T3584: the target repo's own required-status-check contexts — the SAME seam shape
   * `ghRequiredStatusCheckContexts` already exposes and the sweep's `deps.requiredContexts`
   * (line ~30372) already takes, so no new contract is invented. `waitForCiGreen` calls this
   * ONCE per wait (never per poll — see its own call site) and defaults to
   * {@link ghRequiredStatusCheckContexts}. `undefined` (unreadable protection or a genuinely
   * unprotected branch) takes `ciGateFromRollup` down its unchanged fail-closed fallback.
  */
  requiredContexts?: (owner: string, repo: string) => string[] | undefined;
  externalWaitFreshness?: ExternalWaitFreshness;
  externalWaitRecycle?: () => string | undefined;
  /**
   * W1-T5345: yield the CI wait on its FIRST poll, after `run.awaiting_external` is written, so
   * the daemon lane that opened the PR is free at PR open. Only the daemon's `runOne` sets it;
   * `rmd run-task` by hand, `rmd drain` and `rmd approve` leave it off and wait in-lane.
   */
  handOffAtPrOpen?: boolean;
}

export type PrOpenHandoffDeclineReason = "irreversible_diff" | "no_merge_boundary" | "shadow_instance";

export type ExternalWaitFreshness = () =>
  | Extract<DaemonFreshness, { stale: true }>
  | undefined
  | Promise<Extract<DaemonFreshness, { stale: true }> | undefined>;

export type CiGateOutcome =
  | {
      state: "green" | "red" | "timeout";
      sha?: string;
      checks?: string[];
      checkCount?: number;
    }
  | {
      state: "freshness_handoff";
      sha: string;
      oldSha: string;
      newSha: string;
      recycle?: never;
      trigger?: never;
      checks?: never;
      checkCount?: never;
    }
  | {
      state: "freshness_handoff";
      sha: string;
      recycle: string;
      oldSha?: never;
      newSha?: never;
      trigger?: never;
      checks?: never;
      checkCount?: never;
    }
  | {
      // W1-T5345: the daemon lane's hand-off at PR open.
      state: "freshness_handoff";
      sha: string;
      trigger: "pr_open";
      recycle?: never;
      oldSha?: never;
      newSha?: never;
      checks?: never;
      checkCount?: never;
    };

export type ReviewRunResult = ReviewVerdict & {
  headSha: string;
  reviewerOutcome: string;
  verdictWithheld?: string;
  reviewDecisionDigest?: string;
  decisionDisposition?: "computed" | "replayed" | "in_flight" | "conflict";
  evaluatorProvenance?: ReviewEvaluatorProvenance;
};

export interface FixRungOutcome {
  outcome: "fixed" | "escalated" | "stood_down" | "spawn_abandoned" | "parked" | "rebased" | "base_refreshed" | "needs_design" | "handed_off";
  /** The last review computed — passing when `outcome === "fixed"`. Unchanged from the PRIOR
   *  round's own verdict when `outcome === "spawn_abandoned"` (W1-T1044): the strike that
   *  abandoned never produced a new head to re-review. */
  review: ReviewRunResult;
  strikes: number;
  /**
   * W1-T2403: how many rounds this invocation spent on a RETRIGGER-SHAPED outcome (see
   * {@link isRetriggerShapedCommit}) rather than an ordinary strike — SEPARATE from `strikes`,
   * never folded into it. `0` on every outcome this task's own change did not touch (no round
   * this rung ran was ever classified retrigger-shaped).
   */
  retriggers: number;
  /**
   * W1-T1095 (design note ii — "every termination writes a reason"): a short, ALWAYS-PRESENT
   * machine-legible reason naming why THIS pass ended the way it did — never blank, regardless
   * of `outcome`. Distinct from `standDownReason` (a longer, human-facing sentence set only for
   * `"stood_down"`): this field is populated on every branch, including `"fixed"` (where nothing
   * else on this type otherwise says why the loop stopped) and the plain-exhaustion escalate.
   */
  reason: string;
  /**
   * W1-T1044: set only when `outcome === "spawn_abandoned"` — how long (ms) the abandoned
   * `deps.spawn` call had been running when the wall-clock bound gave up on it. See
   * {@link spawnFixWorkerBounded}'s own doc for why this is ledgered BEFORE the worker is
   * reclaimed, never only reported here.
   */
  spawnAbandonedElapsedMs?: number;
  /**
   * Set when `outcome === "escalated"`, and — W1-T296 — also set when a
   * `"stood_down"` outcome escalated a foreign-authorship stand-down (the
   * ONLY stand-down reason that opens a needs-human issue; the terminal-state
   * reasons, W1-T177 below, still ledger-only — nothing for a human to decide
   * on a merged/closed PR).
   */
  issueUrl?: string;
  /**
   * W1-T177: set only when `outcome === "stood_down"` — the freshly observed
   * terminal-state reason (from {@link terminalStateReason}) that stopped a
   * strike from being spent, or the exhaustion escalate() from firing, on a
   * PR that no longer carries a live block. W1-T296 extends this SAME field
   * with a second reason source — see {@link branchAuthorshipStandDownReason}.
   */
  standDownReason?: string;
  superseded?: FixSuperseded;
  /**
   * W1-T1095: set only when `outcome === "parked"` — the prerequisite PR number
   * {@link outOfDiffBlockerFor} found. The rung spent ZERO strikes reaching this outcome
   * (design note iv — parking is not retrying) and expects to be invoked again later (the
   * SAME way every other dispatch is re-polled); the next call resumes normally the moment
   * {@link prerequisiteMerged} reads this PR as merged.
   */
  blockedOnPr?: number;
}

export type CiEvidenceDisagreementObservation = {
  /** W1-T2804 — the head sha BOTH readers resolved for within this one decision. Absent only when
   *  no reader reported one, in which case the row asserts a disagreement without claiming a shared
   *  subject. Never hand-authored: it is whatever the gate read actually judged. */
  sha?: string;
  rollup: {
    checks_state: OpenPrView["checksState"];
    red_checks: string[];
  };
  miner: {
    enumerable_failures: Array<{ name: string }>;
  };
};

export interface LiveHeadResult {
  ok: boolean;
  headSha?: string;
  author?: string;
  headRefName?: string;
}

export type WorktreeSnapshot = { status: string; diff: string; untrackedHash: string };

export interface FixRebaseMergeFacts {
  mergeable?: string;
  behindBy?: number;
}

export interface FixRoundCommit {
  changedFiles: number;
  subject: string;
  diffStat?: string;
  diffDigest?: string;
}

export type ReadFixRoundCommits = (worktreePath: string, sinceSha: string) => FixRoundCommit[] | Promise<FixRoundCommit[]>;

export interface WorkerErrorVerdict {
  verdict: "blocked_budget" | "failed";
  budgetBreach: boolean;
  /** Spread verbatim onto the `verdict` ledger line — carries turns + cost. */
  ledger: {
    worker_exit?: NonNullable<WorkerResult["exit"]>["kind"];
    worker_exit_signal?: string;
    worker_exit_code?: number;
    verdict: "blocked_budget" | "failed";
    stage: string;
    subtype: string;
    num_turns: number;
    cost_usd: number;
    billing_mode: BillingMode;
    /** W1-T268: the account this spend is attributed to — see {@link WorkerResult.accountLabel}. */
    account_label?: string;
    reason: string;
    /** W1-T6: the failing call's configured model/effort + its token usage —
     * a failed worker call is never free OR untelemetered in the ledger. */
    model: string;
    effort: string;
    tokens: WorkerResult["tokens"];
    /** W1-T35 named columns — see {@link cacheTokenLedgerFields}. */
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface NoPrVerdict {
  verdict: "no_pr";
  ledger: {
    verdict: "no_pr";
    stage: string;
    subtype: string;
    num_turns: number;
    cost_usd: number;
    billing_mode: BillingMode;
    /** W1-T268: the account this spend is attributed to — see {@link WorkerResult.accountLabel}. */
    account_label?: string;
    reason: string;
    model: string;
    effort: string;
    tokens: WorkerResult["tokens"];
    /** W1-T35 named columns — see {@link cacheTokenLedgerFields}. */
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    /**
     * W1-T407: commits on HEAD ahead of `origin/main` at verdict time — the SILENT NO-OP
     * GUARD's own predicate (`commitsAhead`, above), threaded through instead of computed and
     * discarded. Appended LAST so no existing positional `noPrVerdict` caller shifted. Lets a
     * reader separate WROTE NOTHING from WROTE SOMETHING THAT COULD NOT BE PUSHED without
     * re-deriving it from a worktree `worktreeRemove` has already deleted by the time anyone
     * reads this row.
     */
    commits_ahead: number;
    /**
     * W1-T407: the worker's own closing report — `text` + `blocks`, already parsed three
     * times at this call site (decision request, PR url, already-satisfied claim) before
     * being dropped — riding the row as a capped excerpt ({@link noPrReportExcerpt}).
     * `undefined`, never an empty string, when the worker left nothing to carry.
     */
    report_excerpt?: string;
    /**
     * (W1-T465) WHICH KIND of `no_pr` this row is, per {@link classifyNoPrShape} — the stalled
     * "backgrounded a job and ended the turn" shape, or unclassified. DIAGNOSTIC ONLY: no
     * scheduling path reads it, and `no_pr` remains drain-halting either way. Always present, so
     * a reader can tell "looked and found nothing" from "the field predates this task".
     */
    no_pr_shape: "awaiting-notification" | "unclassified";
    /** W1-T3978: producer-owned terminal classification. Absent means the ordinary no-PR path. */
    terminal_class?: "harness_commit_refused";
  };
}

export interface AlreadySatisfiedClaim {
  raw: string;
  ref: string;
}

export type AlreadySatisfiedRefusal =
  /** `claim.ref` is not a PR reference at all, so there is nothing to verify against. */
  | "unparsable_ref"
  /** The gateway was consulted and holds no merged PR carrying this task's trailer. */
  | "not_found"
  /** A merged PR carries the trailer, but it is NOT the one the worker claimed. */
  | "different_pr";

export type AlreadySatisfiedResolution =
  | { outcome: "verified"; number: number; url: string }
  | { outcome: "refuted"; reason: AlreadySatisfiedRefusal; creditedNumber?: number }
  | { outcome: "unverifiable"; reason: GhFailureReason };

export interface AlreadySatisfiedVerdict {
  verdict: "already_satisfied";
  prUrl: string;
  ledger: {
    verdict: "already_satisfied";
    stage: string;
    subtype: string;
    num_turns: number;
    cost_usd: number;
    billing_mode: BillingMode;
    account_label?: string;
    reason: string;
    pr_number: number;
    pr_url: string;
    model: string;
    effort: string;
    tokens: WorkerResult["tokens"];
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface ReconArtifact {
  task_id: string;
  plan_sha: string;
  files_digest: string;
  observed: string;
  inferred: string;
  couldnt_verify: string;
  written_at: string;
  run_id: string;
}

export type ProbeKeyInputs = Record<(typeof PROBE_KEY_FIELDS)[number], string>;

export interface ProbeProof {
  runId: string;
  provedAtMs: number;
  provedAt: string;
  containmentReason: string;
  isolationReason: string;
}

export interface ProbeVerdictCache {
  /** The stored pass for `key` — never while the process is held. */
  lookup(key: string): ProbeProof | undefined;
  /** A ticket taken before probing; {@link ProbeVerdictCache.recordPass} refuses it if a hold landed since. */
  open(): number;
  /** Store a clean pass and lift the hold — unless a failure was observed after `ticket` was taken. */
  recordPass(key: string, proof: ProbeProof, ticket: number): boolean;
  /** A probe did not cleanly pass: drop every stored pass and hold until one does. */
  hold(reason: string): void;
  readonly heldReason: string | undefined;
}

export interface ProbeAdmissionOptions {
  /** W1-T5346: the probe-verdict cache. Default: the process-wide one — EXCEPT when a probe executor
   *  is injected, where a fresh per-run cache keeps a test executor's verdict out of the process. */
  probeVerdictCache?: ProbeVerdictCache;
  /** W1-T5346 test seam for two key inputs. Default: {@link IMAGE_BUILD_SHA_PATH} and the harness
   *  revision this module was loaded from. */
  probeKeySources?: { imageBuildShaPath?: string; harnessRevision?: string };
}

export interface RunTaskBodyOptions extends ProbeAdmissionOptions {
  /** W1-T7096: set only by the drain and the CLI — the fix rung then asks the production judge. */
  productionProgressJudge?: boolean;
  /** Test seam for the pre-open fast gate; production runs `runPreopenGate`, an injected spawn skips it. */
  preopenGate?: (worktreePath: string) => Promise<PreopenGateResult>;
  instanceRegistryTextImpl?: (repoRoot: string) => string | undefined;
  selectedModeFileIO?: RegistryFileIO;
  armAdhocLaneReap?: boolean;
  binaryPinDeps?: Parameters<typeof readBinaryPin>[0];
  claimReserver?: DispatchClaimReserverAsync;
  containmentExec?: ProbeExecutor;
  externalWaitFreshness?: ExternalWaitFreshness;
  externalWaitRecycle?: () => string | undefined;
  handOffAtPrOpen?: boolean;
  isolationExec?: IsolationProbeExecutor;
  managedCheckoutInstall?: (repoDir: string) => void;
  maskLearnings?: boolean;
  maskRecon?: boolean;
  maskRules?: boolean;
  noMerge?: boolean;
  readHeadShaForProvenance?: (prUrl: string) => string;
  /** W1-T4797: test seam for the pre-push diff-coverage precheck; production reads the real ones. */
  coveragePrecheckPorts?: CoveragePrecheckPorts;
  /** Where a stale-proof PR-open refusal or managed-checkout install failure escalates; production files the task repo's own issue. */
  prOpenRefusalIssues?: IssueGateway;
  /** W1-T5520: test seams for the sibling-PR check and the REST create; production reads `ghJsonAsync` and `execFileSync`. */
  otherOpenPrReader?: OpenPrJsonReader;
  prCreateExec?: Parameters<RunTaskCommandHost["runGhPrCreate"]>[4];
  prOpenProofRunner?: AsyncOpenPullRequestProofRunner;
  /** W1-T10026: test seam for a build's left-out-import scope request; production asks `requestScopeAmendment`. */
  implementPush?: typeof gitPushRunBranchAsync;
  implementScopeAmendment?: (request: ScopeAmendmentRequest) => ScopeAmendmentOutcome;
  implementScopeAmendmentPortsIo?: Parameters<RunTaskCommandHost["buildProofAmendmentWritePorts"]>[1];
  implementScopeAmendmentState?: (url: string) => Promise<"open" | "merged" | "closed">;
  spawnWallClockBoundMs?: number;
  workerRuleHeadlinesEnabled?: boolean;
  worktreeBaseDeps?: Parameters<typeof worktreeAdd>[4];
}

export interface RunTaskContext {
  restartPhase?: { current: string };
  /** W1-T7096: a caller-supplied worker spawn (a test seam); a run on the real spawn asks the LLM judge. */
  spawnInjected?: boolean;
  /**
   * Shared with the one real spawn wrapper.  The preflight runs in runTaskBody, while the wrapper
   * is built in runTask, so a scalar in either scope would silently describe different runs.
   */
  cashContainmentState?: { contained: boolean };
  /** One shared proof function for both preflights and the spawn wrapper of this run. */
  cashContainmentBoundary?: typeof assertOpenWeightToolBoundary;
  config: Config;
  fetchPrBodyFn: RunTaskCommandHost["fetchPrBodyViaGh"];
  github: GitHub;
  isMerged: (task: Task) => boolean;
  ledgerPath: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  openTaskIds: ReadonlySet<string>;
  opts: RunTaskBodyOptions;
  owner: string;
  plan: Plan;
  planPath: string;
  recordDecisionFn: typeof recordDecision;
  repoRoot: string;
  runId: string;
  runReviewFn: RunTaskCommandHost["runReview"];
  say: (msg: string) => void;
  spawn: typeof spawnWorker;
  task: Task;
  taskId: string;
  /** Resolved once by the outer run so reviewer watchdogs reuse the same policy value. */
  workerAbandonMs?: number;
  workerStateSensor: WorkerStateSensor;
  /** Swaps the whole plan for one of this run's task after the body's last plan read, before the first agent wait. */
  releasePlan?: () => void;
}

export type ManagedCheckoutRefresh = { release: () => void } & (
  | { kind: "unborrowed" | "current" | "fast_forwarded" }
  | { kind: "skipped"; reason: string }
);

export type SourceSizeGatePostureRuntime = GatePostureRuntime & {
  decide?: typeof decideGatePosture;
  consume?: (input: ConsumeSourceSizeFollowupArgs) => ConsumeSourceSizeFollowupResult;
};

export interface SourceSizeGatePostureResult {
  decision: GatePostureDecision;
  followup?: ConsumeSourceSizeFollowupResult;
}

export type RunErrorCause =
  | "census-refused-push"
  | "git-push-failed"
  | "git-commit-failed"
  | "pr-create-failed"
  | "github-read-failed"
  | "base-proof-refused"
  | "subscription-only-refused"
  | "run-error";

export interface CensusPushRefusal {
  text: string;
  censuses: string[];
  offeredBaselines: string[];
}

export type CensusChildResult = Pick<SpawnSyncReturns<string>, "status" | "signal" | "stdout" | "stderr" | "error">;

export type CensusChildRunner<R> = (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => R;

export type FixRoundPushReceipt = { fixRoundPushedHead: string | undefined };
export type CoveragePrecheck =
  | { outcome: "not-applicable"; repo: string; reason: string }
  | CoverageVerdict;

export type CoverageRunResult = CoverageRun;

export type CoveragePrecheckPorts = {
  repo?: string;
  changedFiles?: (wt: string) => string[] | Promise<string[]>;
  select?: (wt: string, changed: string[]) => AffectedSelection | Promise<AffectedSelection>;
  /** W1-T9483: the narrow pass's suites — default {@link coverageNarrowSuites}. */
  narrow?: (wt: string, changed: string[]) => string[] | Promise<string[]>;
  /** W1-T9483: the head sha an `uncovered-narrow` row is keyed on. */
  head?: (wt: string) => string | Promise<string>;
  manifest?: (wt: string) => { thresholdMs: number; files: Record<string, number> };
  run?: (wt: string, suites: string[], timeoutMs: number) => CoverageRunResult | Promise<CoverageRunResult>;
  /** Bounds captured output in the real runner; the default retains spawnSync's 64 MiB ceiling. */
  maxOutputBytes?: number;
  /** W1-T5227: the head's files (against origin/main) still holding a conflict marker. */
  conflictMarkers?: (wt: string) => string[];
};

export type CensusPushRungOutcome =
  | { outcome: "cleared"; strikes: number; remedy: "code-change" | "baseline-row"; baselineFiles: string[]; catalogFiles?: string[] }
  | { outcome: "refused"; strikes: number; refusal: CensusPushRefusal; reason: string };

export type MaterializationErrorClass = "worktree-collision" | "fetch-failure" | "other";

export interface MaterializationFailure {
  errorClass: MaterializationErrorClass;
  message: string;
}

export interface WorkerEditCommit {
  /** True only when the worker's edits were committed onto the branch. */
  readonly committed: boolean;
  /** The new HEAD sha, present only when `committed`. */
  readonly sha?: string;
  /** Paths outside the declared surface and its allowed exceptions. Reported, never staged. */
  readonly undeclared: readonly string[];
  /** W1-T4450: registered regenerable artifacts staged although undeclared (see commitWorkerEdits). */
  readonly regenerable?: readonly string[];
  /** W1-T5386: new tests admitted by the task's own title proofs. */
  readonly proofMatchedTests?: readonly string[];
  readonly admittedTests?: readonly string[];
  readonly admittedRegistrations?: readonly string[];
  /** Why nothing was committed, when `committed` is false. */
  readonly reason?: string;
  /** W1-T5227: the declared paths still holding a conflict marker; nothing staged, MERGE_HEAD left live. */
  readonly conflictMarkerFiles?: readonly string[];
  readonly headMoved?: { prior_head_sha: string; observed_head_sha: string; other_worktrees: string[] };
  readonly aliasRewrite?: AddedTestAliasRewrite;
}

export interface RequiredCompanion {
  path: string;
  importers: string[];
}

export interface PublishAbandonedFixOwnerAheadDeps {
  runGit?: (args: string[]) => string;
}

export class ImplementBudgetBreach extends Error {
  constructor() {
    super("worker breached maxBudgetUsd — not retried (dollars are the backstop)");
  }
}

export class ManagedCheckoutRefreshRefusedError extends RmdError {
  readonly reasonClass = "blocked_toolchain" as const;
  constructor(readonly reason: string) {
    super("git", GENERIC_EXIT_CODE, `managed checkout refresh refused: ${reason}`, { reason });
    this.name = "ManagedCheckoutRefreshRefusedError";
  }
}

class ManagedCheckoutNotRefreshedError extends WorktreeNodeModulesRefusedError {
  constructor(refused: WorktreeNodeModulesRefusedError, readonly notRefreshed: string) {
    super(refused.packageName, refused.worktreePath, refused.nodeModulesSource);
    this.message += `; the managed checkout was not fast-forwarded: ${notRefreshed}`;
  }
}

export function createProbeVerdictCache(): ProbeVerdictCache {
  const passes = new Map<string, ProbeProof>();
  let generation = 0;
  let heldReason: string | undefined;
  return {
    lookup: (key) => (heldReason === undefined ? passes.get(key) : undefined),
    open: () => generation,
    recordPass: (key, proof, ticket) => {
      if (ticket !== generation) return false;
      passes.set(key, proof);
      heldReason = undefined;
      return true;
    },
    hold: (reason) => {
      passes.clear();
      heldReason = reason;
      generation += 1;
    },
    get heldReason() {
      return heldReason;
    },
  };
}

export const IMPLEMENT_REFUSAL_REPORT_CONTRACT = [
  "",
  "# REFUSAL REPORTING",
  "- If evidence at the current HEAD shows that you cannot satisfy a specific acceptance criterion,",
  "  put this exact block in your final REPORT, with one line for each refused criterion:",
  "  REFUSED:",
  "  <criterion index>. [premise-rotted|outside-declared-files|needs-operator-input|proof-unexecutable-at-head|contradicts-another-criterion] <one concrete sentence>",
  "- Use only a listed class. Do not use this block for a transient tool failure or a guess.",
  "- A refusal is advisory evidence: it can fail only that criterion and routes to an operator; it",
  "  never approves work, changes declared scope, or authorizes a retry.",
  "- If you refuse criterion N, do not state `Criterion N: COMPLETE`, `IMPLEMENTED`, or `SATISFIED`",
  "  in the PR body. That explicit contradiction fails review.",
].join("\n");

export const IMPLEMENT_WAIT_TARGET_CONTRACT = [
  "",
  "# WAITING ON A BACKGROUND RUN",
  "- A wait on a background test run waits on the RUNNER'S EXIT (the process, or the `[exited with code N]` marker in its output), never on a reporter-specific line such as `duration_ms`.",
].join("\n");

export const RUN_BRANCH_FILED_FORM = "run-<taskId>-<epochMs>";

export const RUN_BRANCH_UNFILED_FORM = "run-unfiled-<epochMs>";

export const WORKER_ACTIVITY_LEDGER_STEP = "worker.activity";

export const WORKER_RUNAWAY_TURNS_LEDGER_STEP = "worker.runaway_turns";

const WORKER_STATE_POLL_MS = 5_000;

const WORKER_TELEMETRY_TEXT_MAX_CHARS = 240;

export const FALLBACK_PUSH_EVIDENCE_ABSENT = "(no readable stderr/transcript text was captured)";

export const ALREADY_SATISFIED_VERIFY_ATTEMPTS = 3;

export const PLAN_RECORD_ABSENT = "absent";

export const RECON_MAX_TURNS = 40;

const RULE_HEADLINES_SRC = "plan#W1-T2508";

const PROBE_KEY_FIELDS = ["imageBuildSha", "harnessRevision", "workerSettings", "hooks", "cliVersion", "provider", "claudeBin", "root"] as const;

const PROCESS_PROBE_VERDICTS = createProbeVerdictCache();

type RunTaskHelperHost = Pick<RunTaskCommandHost,
  "BRANCH_NAME_CONTRACT_PART" |
  "syncPlanOrRefuse" |
  "lintPlanForReview" |
  "proofRepairRoundRefusalInWorktree" |
  "startShellLessMergeConflictMerge" |
  "terminalVerdictFields" |
  "renderReconClaimLines" |
  "CENSUS_BASELINE_FILES" |
  "workerBoundaryStack" |
  "buildBaseReproductionProbe" |
  "writeSyncLine" |
  "WORKER_STATE_LEDGER_STEP" |
  "capWorkerTailLines" |
  "writeWorkerTailBestEffort" |
  "attributeWorkerStreamEvent" |
  "quietBoundHistory" |
  "readWorktreeHeadReflog" |
  "workerCreatedCurrentHead" |
  "syncPlanOrRefuseAsync" |
  "isTerminalRed" |
  "ghPrCreateFillCommand" |
  "withDiagnostics" |
  "draftPrCreate" |
  "prCreateArgv" |
  "runGhPrCreate" |
  "lastCommitSubject" |
  "appendTaskTrailerToCommit" |
  "fetchPrBodyViaGh" |
  "fetchPrDiffFilesViaGh" |
  "changeView" |
  "rewriteAcceptanceBlockFromPlan" |
  "execGrepProofInWorktree" |
  "ensureTaskTrailer" |
  "ghPrHeadGateway" |
  "checkPrOwnership" |
  "scrubGitCredentialText" |
  "openTaskIdsFromPlan" |
  "yieldingSleep" |
  "restRollupFor" |
  "pollRestTarget" |
  "ciGateState" |
  "STALL_WINDOW" |
  "checkWaitStalled" |
  "waitForCiGreen" |
  "runReview" |
  "ghLiveState" |
  "ghLiveHead" |
  "captureWorktreeSnapshotViaGit" |
  "ghUpdateBranch" |
  "redBaseRefreshFactsFromRest" |
  "fixRebaseMergeFactsFromRest" |
  "reclaimAbandonedWorker" |
  "fixWorkerRunId" |
  "fixWorkerReceipt" |
  "spawnFixWorkerBounded" |
  "readFixRoundCommitsViaGit" |
  "runNpmScriptViaSpawn" |
  "commitGeneratorOutputViaGit" |
  "readPackageScriptsFor" |
  "runFixRung" |
  "buildProofAmendmentGitOps" |
  "buildProofAmendmentWritePorts" |
  "prNumberFromRef" |
  "workerSignal" |
  "harvestFollowupsFromReport" |
  "commitsAhead" |
  "sha256Hex" |
  "readRuleSourceFileOrUndefined" |
  "DEFAULT_BUDGET_USD" |
  "archiveWorkerTranscript" |
  "withPredecessorTranscriptCopies" |
  "benchmarkRunLedgerLogger" |
  "recordBenchmarkWorkerAttempt" |
  "dispatchFallbackObserver" |
  "withGitCredentialSocket" |
  "runErrorCause" |
  "censusPushRefusal" |
  "CENSUS_PUSH_CHECK" |
  "CENSUS_SNAPSHOT_ENV" |
  "COVERAGE_PUSH_CHECK" |
  "CENSUS_PUSH_NEVER_BYPASS" |
  "fixCensusAppliesToRepo" |
  "writeFixCensusSnapshot" |
  "writeFixCensusSnapshotAsync" |
  "checkFixCensusSnapshotAsync" |
  "FixRoundPushError" |
  "pushFixRound" |
  "coveragePrecheck" |
  "coveragePushRefusal" |
  "pushFixRoundPrechecked" |
  "repairRetroAcceptanceBlock" |
  "defaultRetroFetchBody" |
  "defaultRetroEditBody" |
  "prUrlTarget" |
  "readHeadShaRest" |
  "resolveFixRungTaskContractAtHeadAsync" |
  "MERGE_BASE_DIFF_ARGS" |
  "hostWorktreeGitResult" |
  "dispatchClaimReserverAsyncFor" |
  "WORKTREE_REAP_BOOT_CONTRACT_VERSION" |
  "logCloneReapSurvey" |
  "cloneReapPlan" |
  "logCloneReapRow" |
  "DISK_RECLAIM_DEFAULT_SWEEPS" |
  "createDaemonGatewayFactory" |
  "readRegistrationChanges" |
  "commitWorkerEdits" |
  "fixRoundGitOwnership" |
  "MISSING_COMMIT_MESSAGE_REASON" |
  "harnessCommitForShellLessWorker" |
  "worktreeHasUncommittedChanges" |
  "COMMIT_LINE_RESUME_PROMPT" |
  "writerCannotResume" |
  "missingCommitLinePrompt" |
  "pathIsUnderDeclaredSurface" |
  "execFilePromise" |
  "AWAITING_EXTERNAL_LEDGER_STEP" |
  "readLedgerRawLines"
>;

type BoundRunTaskHelper<F> = F extends (helperHost: never, ...args: infer A) => infer R ? (...args: A) => R : never;


function defaultBinaryPinDeps(claudeBin: string): Parameters<typeof readBinaryPin>[0] {
  return {
    readCliManifest: () => readFileSync(fileURLToPath(new URL("../../../deploy/package.json", import.meta.url)), "utf8"),
    runClaudeVersion: () => execFileSync(claudeBin, ["--version"], { encoding: "utf8" }),
  };
}

function deriveRunawayTurnBound(
  historicalTurnCounts: readonly number[],
  policy: Pick<CostAnomalyPolicy, "multiplier" | "minSamples">,
): number | undefined {
  if (historicalTurnCounts.length < policy.minSamples) return undefined;
  const sorted = [...historicalTurnCounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return median * policy.multiplier;
}

function dispatchStreamObserver(
  helperHost: Pick<RunTaskHelperHost, "attributeWorkerStreamEvent">, base: WorkerStreamObserver,
  spawn: Pick<SpawnWorkerArgs, "model" | "mountProvider"> & { cwd?: string },
  assignment: () => Pick<WorkerSelectionAssignment, "id" | "requested" | "selected"> | undefined,
): WorkerStreamObserver {
  const { attributeWorkerStreamEvent } = helperHost;
  return (event) => {
    const current = assignment();
    const located = spawn.cwd && !event.cwd ? { ...event, cwd: spawn.cwd } : event;
    base(attributeWorkerStreamEvent(enrichWorkerStreamEvent(located, spawn, current), current));
  };
}

function watchDispatchSpawn(
  helperHost: Pick<RunTaskHelperHost, "quietBoundHistory" | "commitWorkerEdits" | "worktreeHasUncommittedChanges">, rawSpawn: typeof spawnWorker,
  watch: {
    enabled: boolean;
    taskId: string;
    runId: string;
    ledgerPath: string;
    fallbackBoundMs: number;
    spawnArgs: Pick<SpawnWorkerArgs, "cwd" | "settingsFile" | "workerClass">;
    task: Pick<ReturnType<typeof selectTask>, "files" | "acceptance">;
    provider: () => string | undefined;
    log: (step: string, fields: Record<string, unknown>) => void;
    /** The daemon's recycle-PAUSE reader: a pending recycle ends the round on the checkpoint path. */
    recyclePending?: () => string | undefined;
  },
  seams: {
    runWatchdog?: typeof runQuietWorkerWatchdog;
    readRows?: typeof readLedgerUnionRecordsSync; // tests only, and only with no `history`: no default reads the union inline
    history?: QuietBoundHistory;
    judge?: QuietWorkerJudge;
    deliver?: typeof deliverOperatorAnswerToRunningWorker;
    hasUncommittedChanges?: RunTaskCommandHost["worktreeHasUncommittedChanges"];
    commit?: RunTaskCommandHost["commitWorkerEdits"];
    push?: typeof gitPushRunBranchAsync;
    headSha?: (cwd: string) => string;
  } = {},
): typeof spawnWorker {
  const { quietBoundHistory, commitWorkerEdits, worktreeHasUncommittedChanges } = helperHost;
  if (!watch.enabled) return rawSpawn;
  const { taskId, spawnArgs, task, log } = watch;
  const state: { rootPid?: number; ended?: QuietRoundEndedError } = {};
  const abort = new AbortController();
  const readRows = seams.history ? undefined : seams.readRows;
  const watchdogOptions: Parameters<typeof runQuietWorkerWatchdog>[0] = {
    taskId,
    runId: watch.runId,
    rootPid: () => state.rootPid,
    provider: watch.provider,
    ...(readRows ? {
      history: () => {
        const read = readRows(dirname(watch.ledgerPath), { step: ["worker.state", "worker.assignment"] });
        return read.ok ? read.rows : [];
      },
    } : quietHistoryOptions(dirname(watch.ledgerPath), seams.history ?? quietBoundHistory)),
    fallbackBoundMs: watch.fallbackBoundMs,
    quietFloorMs: DEFAULT_WORKER_QUIET_FLOOR_MS,
    ledger: (step, fields) => log(step, fields),
    judge: seams.judge ?? productionQuietWorkerJudge({ cwd: spawnArgs.cwd, settingsFile: spawnArgs.settingsFile }),
    nudge: (message) => (seams.deliver ?? deliverOperatorAnswerToRunningWorker)(taskId, message, { ledger: (event, fields) => log(event, fields ?? {}) })
      === "delivered" ? "delivered" : "unsupported",
    ...(watch.recyclePending ? { recyclePending: watch.recyclePending } : {}),
    endRound: async (reason, trigger) => {
      if ((spawnArgs.workerClass ?? "implement") !== "implement") return { ended: false, reason: "not an implement worker" };
      const cwd = spawnArgs.cwd;
      let undeclaredPaths: readonly string[] = [];
      try {
        // The W1-T7697 checkpoint path (yieldAtWorkerBoundary): retain the disk work, push it, then release the lane.
        if ((seams.hasUncommittedChanges ?? worktreeHasUncommittedChanges)(cwd)) {
          const checkpoint = (seams.commit ?? commitWorkerEdits)(cwd, task.files ?? [],
            `${checkpointCommitSubject(`yield at ${trigger === "recycle" ? "container recycle" : trigger === "restart" ? "daemon restart" : "quiet worker"}`)}\n\n[remudero-context]\ndecided: retain work for restart\nremaining: resume\nfailed: none\n\nRemudero-Task: ${taskId}`,
            {}, task.acceptance, { checkpoint: true });
          // W1-T8008: a checkpoint keeps undeclared work too; only what git forces (markers, unresolved paths) refuses.
          if (!checkpoint.committed) {
            return { ended: false, reason: `checkpoint refused: ${checkpoint.reason ?? checkpoint.undeclared.join(", ")}` };
          }
          undeclaredPaths = checkpoint.undeclared;
        }
        await pushRestartCheckpoint(cwd, seams.push); // W1-T8397: the recycle/quiet/restart round end skips the PR gate too
      } catch (error) {
        return { ended: false, reason: `checkpoint failed: ${String((error as Error)?.message ?? error)}` };
      }
      const checkpointSha = (seams.headSha ?? ((dir: string) => hostWorktreeGit(dir, ["rev-parse", "HEAD"]).trim()))(cwd);
      state.ended = new QuietRoundEndedError({ checkpointSha, reason, ...(trigger ? { trigger } : {}),
        ...(undeclaredPaths.length > 0 ? { undeclaredPaths: [...undeclaredPaths] } : {}) });
      abort.abort();
      return { ended: true, checkpointSha };
    },
  };
  // Direct call on the run path; a test may substitute the runner through the seam.
  const watchdog = seams.runWatchdog ? seams.runWatchdog(watchdogOptions) : runQuietWorkerWatchdog(watchdogOptions);
  return guardSpawnWithQuietWatchdog(rawSpawn, {
    watchdog, abort, onRootPid: (pid) => { state.rootPid = pid; }, ended: () => state.ended,
  });
}

function checkpointUndeclaredFields(undeclared: readonly string[]): { undeclared_paths?: string[] } {
  return undeclared.length === 0 ? {} : { undeclared_paths: [...undeclared] };
}

async function commitAndPushRestartCheckpoint(
  helperHost: Pick<RunTaskHelperHost, "commitWorkerEdits" | "worktreeHasUncommittedChanges">, worktreePath: string,
  task: { files?: readonly string[]; acceptance?: readonly AcceptanceCriterion[] },
  taskId: string,
  waitingOn: string,
  seams: { push?: typeof gitPushRunBranchAsync; hasUncommittedChanges?: RunTaskCommandHost["worktreeHasUncommittedChanges"] } = {},
): Promise<{ undeclared: readonly string[] }> {
  const { commitWorkerEdits, worktreeHasUncommittedChanges } = helperHost;
  let undeclared: readonly string[] = [];
  if ((seams.hasUncommittedChanges ?? worktreeHasUncommittedChanges)(worktreePath)) {
    const checkpoint = commitWorkerEdits(worktreePath, task.files ?? [],
      `${checkpointCommitSubject(`yield at ${waitingOn}`)}\n\n[remudero-context]\ndecided: retain work for restart\nremaining: resume ${waitingOn}\nfailed: none\n\nRemudero-Task: ${taskId}`,
      {}, task.acceptance, { checkpoint: true });
    if (!checkpoint.committed) throw new Error(`restart checkpoint refused: ${checkpoint.reason ?? checkpoint.undeclared.join(", ")}`);
    undeclared = checkpoint.undeclared;
  }
  await pushRestartCheckpoint(worktreePath, seams.push);
  return { undeclared };
}

async function pushRestartCheckpoint(worktreePath: string, push: typeof gitPushRunBranchAsync = gitPushRunBranchAsync): Promise<void> {
  await push(worktreePath, { prGates: false });
}

function freshnessYieldRows(a: {
  waitingOn: string; branch: string; headSha: string; undeclared: readonly string[];
  freshness?: { oldSha: string; newSha: string }; recycle?: string;
}): Array<{ step: string; fields: Record<string, unknown> }> {
  const undeclared = checkpointUndeclaredFields(a.undeclared);
  return [
    { step: "run.freshness_handoff", fields: { waiting_on: a.waitingOn, branch: a.branch, head_sha: a.headSha,
      ...(a.freshness ? { old_sha: a.freshness.oldSha, new_sha: a.freshness.newSha } : { trigger: "recycle", detail: a.recycle }), ...undeclared } },
    { step: "verdict", fields: { verdict: "handed_off", reason: "freshness_yield", waiting_on: a.waitingOn, branch: a.branch, head_sha: a.headSha, ...undeclared } },
  ];
}

function roundEndedHandoffRows(
  detail: QuietRoundEndedError["detail"],
  branch: string,
): Array<{ step: string; fields: Record<string, unknown> }> {
  const headSha = detail.checkpointSha ?? null;
  const undeclared = checkpointUndeclaredFields(detail.undeclaredPaths ?? []);
  if (detail.trigger !== "recycle" && detail.trigger !== "restart") {
    return [{ step: "verdict", fields: { verdict: "handed_off", reason: "quiet_worker_round_ended", branch, head_sha: headSha, detail: detail.reason, ...undeclared } }];
  }
  return [
    { step: "run.freshness_handoff", fields: { waiting_on: "worker_round", branch, head_sha: headSha, trigger: detail.trigger, detail: detail.reason, ...undeclared } },
    { step: "verdict", fields: { verdict: "handed_off", reason: "freshness_yield", waiting_on: "worker_round", branch, head_sha: headSha, detail: detail.reason, ...undeclared } },
  ];
}

function boundedWorkerTelemetryText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= WORKER_TELEMETRY_TEXT_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, WORKER_TELEMETRY_TEXT_MAX_CHARS)}…`;
}

function buildWorkerStateSensor(helperHost: Pick<RunTaskHelperHost, "WORKER_STATE_LEDGER_STEP" | "capWorkerTailLines" | "writeWorkerTailBestEffort">, args: {
  ledgerPath: string;
  runId: string;
  taskId: string;
  root: string;
  quietFloorMs?: number;
  now?: () => number;
  pollMs?: number;
}): WorkerStateSensor {
  const { WORKER_STATE_LEDGER_STEP, capWorkerTailLines, writeWorkerTailBestEffort } = helperHost;
  const now = args.now ?? Date.now;
  const tracker = new WorkerStateTracker(args.quietFloorMs ?? DEFAULT_WORKER_QUIET_FLOOR_MS);
  const tailPath = join(args.root, "state", "runs", `${args.runId}.tail`);
  let tailLines: string[] = [];
  // W1-T2557: mutable ONLY via `setRunawayBound` below — `undefined` until `runTask`'s own call
  // site resolves one (or a derivation failure leaves it unset), meaning the runaway signal
  // stays silent rather than guessing.
  let runawayBoundTurns: number | undefined;
  let runawaySignaled = false;
  let lastWorkerText: string | undefined;
  let activeTool: { name: string; startedAtMs: number; reason?: string } | undefined;
  let lastActivityKey: string | undefined;
  let nextToolCallIndex = 0;

  const recordTransition = (next: WorkerState): void => {
    try {
      appendLedger(args.ledgerPath, {
        run_id: args.runId,
        task_id: args.taskId,
        step: WORKER_STATE_LEDGER_STEP,
        state: next,
      });
    } catch {
      // Best-effort (design note iv/note at end of the task file: "the design's best-effort,
      // never-fatal contract for BOTH the observer and the tail write"). A ledger-append
      // hiccup (an unwritable `state/` dir, a torn concurrent write) must never propagate out
      // of the observer and take the worker it is trying to observe down with it.
    }
  };

  /**
   * W1-T2557: check the running count on every observed stream event. `worker.activity` already
   * carries the event's count while the spawn is in flight. Append `worker.runaway_turns` AT MOST
   * ONCE per run, when the count first clears `runawayBoundTurns` — a report, never a kill/defer.
   */
  const observeTurns = (): void => {
    const current = tracker.turnsSoFar();
    if (!runawaySignaled && runawayBoundTurns !== undefined && current > runawayBoundTurns) {
      runawaySignaled = true;
      try {
        appendLedger(args.ledgerPath, {
          run_id: args.runId,
          task_id: args.taskId,
          step: WORKER_RUNAWAY_TURNS_LEDGER_STEP,
          turns_so_far: current,
          bound_turns: runawayBoundTurns,
        });
      } catch {
        // Best-effort (W1-T942 design note iv, unchanged discipline): an observability organ
        // that can kill a worker is worse than the blindness it cures.
      }
    }
  };

  const observer: WorkerStreamObserver = (event) => {
    if (event.text) {
      tailLines = capWorkerTailLines([...tailLines, event.text]);
      writeWorkerTailBestEffort(tailPath, tailLines);
    }
    const toolEnded = activeTool !== undefined && event.kind !== "tool-executing";
    const eventAt = new Date(event.tsMs).toISOString();
    const toolName = event.toolName ?? (event.kind === "tool-executing" ? boundedWorkerTelemetryText(event.text) : undefined);
    const toolCallIndex = event.kind === "tool-executing" ? nextToolCallIndex++ : undefined;
    try {
      const toolSignature = event.toolName ? toolStepSignature(event.toolName, event.toolInput, event.cwd ?? "") : undefined;
      const activityRow = {
        run_id: args.runId,
        task_id: args.taskId,
        step: WORKER_ACTIVITY_LEDGER_STEP,
        event_kind: event.kind,
        event_at: eventAt,
        ...(event.workerRole ? { worker_role: event.workerRole } : {}),
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.requestedModel ? { requested_model: event.requestedModel } : {}),
        ...(event.servedModel ? { served_model: event.servedModel } : {}),
        // W1-T4615: the routed half beside the requested alias, or a named gap.
        ...(event.selectionAssignmentId
          ? { selection_assignment_id: event.selectionAssignmentId }
          : { assignment_unavailable_reason: "assignment-not-observed" }),
        ...(event.routedProvider ? { routed_provider: event.routedProvider } : {}),
        ...(event.routedModel ? { routed_model: event.routedModel } : {}),
        ...(event.turnsSoFar === undefined ? {} : { turns_so_far: event.turnsSoFar }),
        ...(event.kind === "tool-executing"
          ? {
              tool_name: toolName ?? "unknown",
              tool_call_index: toolCallIndex,
              ...(toolSignature ? { tool_signature: toolSignature } : {}),
              ...(lastWorkerText ? { tool_reason: boundedWorkerTelemetryText(lastWorkerText) } : {}),
              tool_started_at: eventAt,
            }
          : {}),
        ...(toolEnded && activeTool
          ? {
              tool_name: activeTool.name,
              tool_completed_at: eventAt,
              tool_duration_ms: Math.max(0, event.tsMs - activeTool.startedAtMs),
              ...(event.toolOutcome ? { tool_outcome: event.toolOutcome } : {}),
            }
          : {}),
      };
      // E5: a same-millisecond burst of bare heartbeats renders byte-identical rows; ledger one.
      const activityKey = JSON.stringify(activityRow);
      const isBareHeartbeat = event.kind === "message" && !event.text && !event.toolName && !event.toolOutcome && !toolEnded;
      if (!isBareHeartbeat || activityKey !== lastActivityKey) {
        appendLedger(args.ledgerPath, activityRow);
        lastActivityKey = isBareHeartbeat ? activityKey : undefined;
      }
    } catch {
      // Best-effort: telemetry must never be able to take down the worker it observes.
    }
    if (event.kind === "working") lastWorkerText = event.text;
    if (event.kind === "tool-executing") {
      activeTool = {
        name: toolName ?? "unknown",
        startedAtMs: event.tsMs,
        reason: boundedWorkerTelemetryText(lastWorkerText),
      };
    } else {
      activeTool = undefined;
    }
    const next = tracker.observe(event);
    if (next) recordTransition(next);
    observeTurns();
  };

  const startPolling = (): (() => void) => {
    const timer = setInterval(() => {
      const next = tracker.check(now());
      if (next) recordTransition(next);
    }, args.pollMs ?? WORKER_STATE_POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return {
    observer,
    startPolling,
    setRunawayBound: (bound) => {
      runawayBoundTurns = bound;
    },
  };
}

function resolveOwner(): string {
  return resolveOwnerRepo().owner;
}

function shadowLiveWouldHaveDone(armed: boolean, reason?: string): { would: "would_merge" | "would_block"; reason?: string } {
  return armed ? { would: "would_merge" } : { would: "would_block", reason };
}

function resolveShadowInstanceArmPermission(shadowInstance: boolean): { armed: boolean; reason?: string } {
  return shadowInstance
    ? { armed: false, reason: "shadow instance — never arms or merges a pull request (W1-T4265)" }
    : { armed: true };
}

async function ghPrCreateFillCommandAsync(
  helperHost: Pick<RunTaskHelperHost, "withDiagnostics" | "draftPrCreate" | "prCreateArgv">, worktreePath: string,
  owner: string,
  repo: string,
  branch: string,
  title?: string,
  runProofAsync?: AsyncOpenPullRequestProofRunner,
  /** A finished build whose only defect is a failing filed proof is opened with that proof named, never stranded. */
  openOnFailingProof = false,
  childStore: ChildEntryStoreOptions = {},
): Promise<PrCreateCommand> {
  const { withDiagnostics, draftPrCreate, prCreateArgv } = helperHost;
  const draft = draftPrCreate(worktreePath, owner, repo, branch, title);
  let checkedBody: string;
  try {
    checkedBody = await openPullRequestCheckedAsync(draft.body, branch, worktreePath, "origin/main", runProofAsync ?? ((proof, base, root, target) => defaultProofRunnerAsync(proof, base, root, target, { store: childStore })), { owner, repo });
  } catch (err) {
    if (!openOnFailingProof || !(err instanceof PrOpenRefusedError) || err.failingProof === undefined) throw err;
    const opened: PrCreateDiagnostic = {
      step: "pr.opened_with_failing_proof",
      extra: { branch, proof: err.failingProof.proof, refusal_class: err.refusalClass },
    };
    return withDiagnostics(
      prCreateArgv(worktreePath, owner, repo, branch, draft.title, bodyWithFailingProofAtOpen(err.failingProof)),
      [...draft.diagnostics, opened],
    );
  }
  return withDiagnostics(prCreateArgv(worktreePath, owner, repo, branch, draft.title, checkedBody), draft.diagnostics);
}

function worktreeHeadOrUndefined(worktreePath: string): string | undefined {
  try {
    return hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim() || undefined;
  } catch (e) {
    void e; // an unreadable head only costs the harness-tip shortcut; the subject rule still applies
    return undefined;
  }
}

function worktreeDiffStat(worktreePath: string): string {
  try {
    const stat = hostWorktreeGit(worktreePath, ["diff", "--stat", "HEAD"]).trim().split("\n").filter(Boolean).slice(-12).join("; ");
    const untracked = hostWorktreeGit(worktreePath, ["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean);
    const text = [stat, untracked.length ? `untracked: ${untracked.slice(0, 12).join(", ")}` : ""].filter(Boolean).join("; ");
    return text.length > 800 ? `${text.slice(0, 800)}...` : text;
  } catch (e) {
    void e; // the stat is evidence for the judge, not a gate
    return "";
  }
}

function branchPrTitle(helperHost: Pick<RunTaskHelperHost, "lastCommitSubject">, worktreePath: string, task?: { id: string; title?: string }): string | undefined {
  const { lastCommitSubject } = helperHost;
  try {
    const subjects = hostWorktreeGit(worktreePath, ["log", "--format=%s", ...(task ? ["--no-merges"] : []), "origin/main..HEAD"]).split("\n");
    return (task && prTitleForTask(subjects, task)) || (prTitleFromBranchCommits(subjects) ?? lastCommitSubject(worktreePath));
  } catch (e) {
    // An unreadable range falls back to the tip subject, the pre-#10482 behaviour; a filed task still names its PR.
    void e;
    const tip = lastCommitSubject(worktreePath);
    return (task && prTitleForTask(tip ? [tip] : [], task)) || tip;
  }
}

async function restoreBoundaryCheckpoint(
  checkpoint: { branch: string; headSha: string },
  taskId: string,
  git: (args: string[]) => Promise<string>,
  log: (step: string, data: Record<string, unknown>) => void = () => {},
): Promise<BoundaryCheckpointRestore> {
  const remoteHead = (await git(["ls-remote", "origin", `refs/heads/${checkpoint.branch}`])).trim().split(/\s+/)[0];
  if (remoteHead && remoteHead !== checkpoint.headSha) throw new Error("the checkpoint's remote head moved; refusing to replay a different worker's work");
  const absence = remoteHead ? {} : { sourceBranchAbsent: true as const };
  const mainSha = (await git(["rev-parse", "HEAD"])).trim();
  if (!remoteHead) {
    try {
      await git(["merge-base", "--is-ancestor", checkpoint.headSha, mainSha]);
      return { base: "main", headSha: mainSha, ...absence };
    } catch (error) {
      // A missing local object or non-ancestor needs the remote fetch before deciding whether work is lost.
    }
    const drop = (reason: string): BoundaryCheckpointRestore => {
      log("implement.checkpoint_dropped", { task_id: taskId, source_branch: checkpoint.branch, head_sha: checkpoint.headSha, reason });
      return { base: "main", headSha: mainSha, dropped: true, ...absence };
    };
    try {
      await git(["fetch", "origin", checkpoint.headSha]);
    } catch (error) {
      const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message ?? error);
      if (!/not our ref|unadvertised object|couldn't find remote ref/.test(detail)) throw error;
      return drop(`checkpoint object unavailable on origin: ${detail}`);
    }
    if ((await git(["rev-parse", "FETCH_HEAD"])).trim() !== checkpoint.headSha) return drop("fetched object does not match the checkpoint head");
    await git(["push", `--force-with-lease=refs/heads/${checkpoint.branch}:`, "origin", `${checkpoint.headSha}:refs/heads/${checkpoint.branch}`]);
    log("implement.checkpoint_branch_recreated", { task_id: taskId, source_branch: checkpoint.branch, head_sha: checkpoint.headSha });
  } else {
    await git(["fetch", "origin", checkpoint.branch]);
  }
  const fetchedHead = (await git(["rev-parse", "FETCH_HEAD"])).trim();
  if (fetchedHead !== checkpoint.headSha) throw new Error("the checkpoint's remote head moved during fetch");
  const base = (await git(["merge-base", checkpoint.headSha, mainSha])).trim();
  if (base === checkpoint.headSha) return { base: "main", headSha: mainSha, ...absence }; // main already carries it
  if (base === mainSha) {
    await git(["reset", "--hard", "--quiet", checkpoint.headSha]); // it already sits on current main
    return { base: "main", headSha: checkpoint.headSha, ...absence };
  }
  const probe = await probeMerge({ headSha: checkpoint.headSha, mainSha, git: async (args) => {
    try {
      return { status: 0, stdout: await git([...args]) };
    } catch (error) {
      // merge-tree exits 1 on a conflict with the tree and the conflicted paths still on stdout.
      const failed = error as { code?: unknown; status?: unknown; stdout?: unknown };
      const status = typeof failed.code === "number" ? failed.code : typeof failed.status === "number" ? failed.status : null;
      return { status, stdout: typeof failed.stdout === "string" ? failed.stdout : "" };
    }
  } });
  if (probe.verdict !== "clean") {
    await git(["reset", "--hard", "--quiet", checkpoint.headSha]);
    return { base: "checkpoint", headSha: checkpoint.headSha, mainConflicts: probe.verdict === "conflict" ? probe.paths : [],
      ...(probe.verdict === "unreadable" ? { reason: probe.reason } : {}), ...absence };
  }
  const merged = (await git(["commit-tree", probe.tree, "-p", checkpoint.headSha, "-p", mainSha, "-m",
    `${checkpointCommitSubject("merge main into the restored checkpoint")}\n\nRemudero-Task: ${taskId}`])).trim();
  await git(["reset", "--hard", "--quiet", merged]);
  return { base: "main", headSha: merged, ...absence };
}

function diffFileChangesFromPatch(diff: string): DiffFileChange[] {
  const byFile = new Map<string, string[]>();
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/\sb\/(\S+)\s*$/);
      file = m ? m[1] : "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      // A deleted file's `+++` line is `/dev/null` — keep the path the `diff --git` header
      // already set rather than clobbering it (mirrors lib/review.ts's own walkDiff, W1-T389).
      const plus = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      if (plus !== "/dev/null") file = plus;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("@@") || !file) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) {
      const lines = byFile.get(file) ?? [];
      lines.push(raw.slice(1));
      byFile.set(file, lines);
    } else if (!byFile.has(file)) {
      byFile.set(file, []);
    }
  }
  return [...byFile.entries()].map(([path, lines]) => ({ path, content: lines.join("\n") }));
}

function diffIsClassifiedIrreversible(diffText: string): boolean {
  return reversibilityFactor({ files: diffFileChangesFromPatch(diffText) }, {}).band === "critical";
}

function irreversibleSignalForWorktree(worktreePath: string): boolean {
  try {
    const patch = hostWorktreeGit(worktreePath, ["diff", "origin/main...HEAD"], { maxBuffer: 64 * 1024 * 1024 });
    return diffIsClassifiedIrreversible(patch);
  } catch {
    return false;
  }
}

function armRunIdFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  prUrl: string,
): string | undefined {
  let runId: string | undefined;
  for (const line of lines) {
    if (line.step !== "automerge.armed") continue;
    if (line.pr_url !== prUrl) continue;
    if (typeof line.run_id === "string") runId = line.run_id;
  }
  return runId;
}

function mergeShaNow(helperHost: Pick<RunTaskHelperHost, "prUrlTarget">, prUrl: string, fetch: GhApiFetcher = ghJson): string | undefined {
  const { prUrlTarget } = helperHost;
  const target = prUrlTarget(prUrl);
  if (!target) return undefined;
  try {
    const row = fetch(singlePrRestArgs(target.owner, target.repo, target.number)) as {
      merge_commit_sha?: unknown;
    };
    return typeof row?.merge_commit_sha === "string" && row.merge_commit_sha.length > 0
      ? row.merge_commit_sha
      : undefined;
  } catch {
    return undefined;
  }
}

function lostRaceEscalation(input: {
  prUrl: string;
  taskId: string;
  runId: string;
  refusal: string;
  mergeSha?: string;
  confidence?: number;
  reasons?: readonly string[];
  armRunId?: string;
}): {
  class: "HARD_STOP";
  taskId: string;
  runId: string;
  summary: string;
  detail: string;
  options: Array<{ label: string; detail: string }>;
  recommendation: string;
} {
  const sha = input.mergeSha ?? "unresolved";
  const confidence = typeof input.confidence === "number" ? input.confidence.toFixed(2) : "n/a";
  const reasons = input.reasons && input.reasons.length > 0 ? input.reasons.join("\n  - ") : "none recorded";
  return {
    class: "HARD_STOP",
    taskId: input.taskId,
    runId: input.runId,
    summary: `REFUSED VERDICT MERGED UNATTENDED — the withdrawal lost the race — ${input.prUrl}`,
    detail:
      `${input.refusal}\n\n` +
      `The withdrawal was attempted and GitHub reported the pull request already MERGED, so the ` +
      `arm this run refused was never withdrawn.\n\n` +
      `merge sha:    ${sha}\n` +
      `confidence:   ${confidence}\n` +
      `armed by run: ${input.armRunId ?? "unattributed — no automerge.armed row for this pull request"}\n` +
      `judge reasons:\n  - ${reasons}\n\n` +
      `NOTHING WAS REVERTED, REOPENED OR FORCE-PUSHED. Whether this commit stands is your ruling.`,
    options: [
      {
        label: "accept-the-merge",
        detail: "read the merged diff and, if it is acceptable, record that and continue — no action on the commit.",
      },
      {
        label: "back-it-out-by-hand",
        detail: "revert the merge sha above yourself; the fleet deliberately does not revert on its own.",
      },
    ],
    recommendation: "accept-the-merge",
  };
}

async function riskJudgeDisarm(
  helperHost: Pick<RunTaskHelperHost, "prUrlTarget">, ctx: Parameters<BoundRunTaskHelper<typeof disposeDisarm>>[1],
  disarm: typeof disarmAutoMergeAsync = disarmAutoMergeAsync,
  disposition: Parameters<BoundRunTaskHelper<typeof disposeDisarm>>[2] = {},
): Promise<ReturnType<BoundRunTaskHelper<typeof disposeDisarm>>> {
  return disposeDisarm(helperHost, await disarm(ctx.prUrl), ctx, disposition);
}

function disposeDisarm(
  helperHost: Pick<RunTaskHelperHost, "prUrlTarget">, outcome: DisarmOutcome | void,
  ctx: {
    prUrl: string;
    taskId: string;
    runId: string;
    ledgerPath: string;
    reason: string;
    refusal: string;
    confidence?: number;
    reasons?: readonly string[];
  },
  deps: {
    mergeSha?: (prUrl: string) => string | undefined;
    ledgerLines?: () => Array<Record<string, unknown>>;
  } = {},
): {
  step: "automerge.disarmed" | "automerge.disarm_skipped";
  row: Record<string, unknown>;
  escalation?: ReturnType<typeof lostRaceEscalation>;
} {
  const step = disarmOutcomeWithdrawn(outcome) ? "automerge.disarmed" : "automerge.disarm_skipped";
  const row: Record<string, unknown> = { reason: ctx.reason, outcome: outcome ?? null };
  if (outcome !== "lost-race") return { step, row };
  return {
    step,
    row,
    escalation: lostRaceEscalation({
      prUrl: ctx.prUrl,
      taskId: ctx.taskId,
      runId: ctx.runId,
      refusal: ctx.refusal,
      mergeSha: (deps.mergeSha ?? mergeShaNow.bind(undefined, helperHost))(ctx.prUrl),
      confidence: ctx.confidence,
      reasons: ctx.reasons,
      armRunId: armRunIdFromLedger((deps.ledgerLines ?? (() => readLedgerLines(ctx.ledgerPath)))(), ctx.prUrl),
    }),
  };
}

function fallbackPushEvidence(helperHost: Pick<RunTaskHelperHost, "scrubGitCredentialText">, text: string): string {
  const { scrubGitCredentialText } = helperHost;
  const trimmed = text.trim();
  if (trimmed === "") return FALLBACK_PUSH_EVIDENCE_ABSENT;
  return capStderrExcerpt(scrubGitCredentialText(trimmed), STDERR_EXCERPT_CAP);
}

function fallbackPushCause(
  helperHost: Pick<RunTaskHelperHost, "scrubGitCredentialText">, probe: RemotePresenceProbeFailure | undefined,
  workerEvidence: string,
): FallbackPushCause {
  const { scrubGitCredentialText } = helperHost;
  if (!probe || probe.status !== 2) {
    const reason = classifyGhFailure(probe?.status ?? null, probe?.stderr ?? "");
    // `detail` is scrubbed too (not only the new `evidence` field below): it already interpolated
    // the probe's raw stderr before this task, and a credential-bearing URL in THAT stderr would
    // have leaked exactly the same way. Existing consumers only ever regex/substring-match `detail`
    // (see the sibling suite's `assert.match(..., /status 128/)`) — none depend on a credential
    // surviving inside it, so scrubbing changes no observable behavior except closing the leak.
    const scrubbedStderr = probe?.stderr ? scrubGitCredentialText(probe.stderr) : "";
    return {
      cause: "probe_unreadable",
      detail:
        `git ls-remote could not confirm the branch is absent (status ${probe?.status ?? "none"}, ` +
        `classified ${reason})${scrubbedStderr ? `: ${scrubbedStderr}` : ""}`,
      evidence: fallbackPushEvidence(helperHost, probe?.stderr ?? ""),
    };
  }
  if (classifyGhFailure(null, workerEvidence) === "auth") {
    return {
      cause: "credential_expired",
      detail: "the worker's own transcript/stderr carries a git/gh authentication failure",
      // THE FIX: `credential_expired`'s `detail` above stayed a fixed sentence on all 15 incidents
      // to date — this is the text the classifier just read to reach that verdict, carried instead
      // of discarded (W1-T2522).
      evidence: fallbackPushEvidence(helperHost, workerEvidence),
    };
  }
  if (!/\bgit\s+push\b/i.test(workerEvidence)) {
    return {
      cause: "push_not_attempted",
      detail: "no \"git push\" invocation appears anywhere in the worker's own transcript",
      evidence: fallbackPushEvidence(helperHost, workerEvidence),
    };
  }
  return {
    cause: "undetermined",
    detail:
      "the branch is confirmed absent from origin but neither a credential failure nor a missing " +
      "push attempt is evident in the worker's own transcript",
    evidence: fallbackPushEvidence(helperHost, workerEvidence),
  };
}

function rollupCheckSummary(rollup: RollupEntry[] | undefined): string[] {
  return (rollup ?? []).map((c) => `${c.name ?? c.context ?? "unknown"}:${c.conclusion ?? c.status ?? c.state ?? ""}`);
}

function prOpenHandoffDecline(run: { irreversible: boolean; noMerge: boolean; shadowInstance: boolean }): PrOpenHandoffDeclineReason | undefined {
  // The sweep's re-arm path is never handed the irreversible signal (W1-T947's named residual).
  if (run.irreversible) return "irreversible_diff";
  // The wipe-test no-merge boundary lives only in this run (`resolveWipeTestArmPermission`).
  if (run.noMerge) return "no_merge_boundary";
  // The shadow-instance arm refusal lives only in this run (`resolveShadowInstanceArmPermission`).
  if (run.shadowInstance) return "shadow_instance";
  return undefined;
}

async function pollToGate(
  helperHost: Pick<RunTaskHelperHost, "isTerminalRed" | "yieldingSleep" | "restRollupFor" | "pollRestTarget" | "STALL_WINDOW" | "checkWaitStalled" | "AWAITING_EXTERNAL_LEDGER_STEP">, prUrl: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  everySec = 6,
  deps: PollDeps = {},
): Promise<GateOutcome> {
  const { isTerminalRed, yieldingSleep, restRollupFor, pollRestTarget, STALL_WINDOW, checkWaitStalled, AWAITING_EXTERNAL_LEDGER_STEP } = helperHost;
  const read = deps.readJson ?? ghJsonAsync;
  const sleep = deps.sleep ?? yieldingSleep;
  // W1-T2268: REST, never GraphQL — see the block above `restRollupFor`.
  const { owner, repo, number } = pollRestTarget(prUrl, "pollToGate");
  const readings: (RollupEntry[] | undefined)[] = [];
  for (let i = 0; ; i++) {
    const row = (await retryPollRead(() => read(singlePrRestArgs(owner, repo, number)), { log, sleep })) as RestPullRow;
    const state = prStateFromRest(row);
    if (state === "MERGED") return { merged: true, reason: "checks green" };
    if (state === "CLOSED") return { merged: false, verdict: "blocked_ci", reason: "pr closed" };
    const sha = mapRestPr(row).headRefOid;
    const roll = await retryPollRead(() => restRollupFor(owner, repo, sha, read), { log, sleep });
    const checks = rollupCheckSummary(roll);
    const red = roll.find((c) => isTerminalRed(String(c.conclusion ?? c.state ?? "")));
    if (red) {
      log("pr.checks", { conclusion: "red", check: red.name ?? red.context ?? "unknown", head_sha: sha, checks });
      return {
        merged: false,
        verdict: "blocked_ci",
        reason: `required check red: ${red.name ?? red.context ?? "unknown"}`,
        headSha: sha,
        checks,
      };
    }
    if (i === 0) log(AWAITING_EXTERNAL_LEDGER_STEP, { waiting_on: "pr" });
    const recycle = deps.externalWaitRecycle?.();
    if (recycle) {
      log("run.freshness_handoff", { waiting_on: "pr", head_sha: sha, trigger: "recycle", detail: recycle });
      return { merged: false, verdict: "handed_off", reason: "recycle_yield", headSha: sha, checks };
    }
    readings.push(roll);
    if (readings.length > STALL_WINDOW) readings.shift(); // checkWaitStalled only ever looks at the last STALL_WINDOW
    const stall = checkWaitStalled(readings);
    if (stall.stalled) {
      const verdict = stall.pending.length === 0 ? "awaiting_merge" : "blocked_ci";
      const reason =
        stall.pending.length > 0
          ? `no progress for ${STALL_WINDOW} consecutive polls — still pending: ${stall.pending.join(", ")}`
          : `all observed checks terminal green for ${STALL_WINDOW} consecutive polls; awaiting GitHub merge`;
      log("pr.stalled", {
        pending: stall.pending,
        identicalPolls: STALL_WINDOW,
        verdict,
        reason,
        head_sha: sha,
        checks,
      });
      return {
        merged: false,
        verdict,
        reason,
        headSha: sha,
        checks,
      };
    }
    if (i === 0 || i % 5 === 0) {
      log("pr.polling", {
        state,
        checks,
      });
    }
    // W1-T463: see `waitForCiGreen`'s note — a timer, not a blocking child process.
    await sleep(everySec * 1000);
  }
}

function ciGateBlockReason(helperHost: Pick<RunTaskHelperHost, "ciGateState">, r: CiGateOutcome | "green" | "red" | "timeout"): string {
  const { ciGateState } = helperHost;
  const state = ciGateState(r);
  if (state === "freshness_handoff") {
    return "daemon code became stale while CI was pending; yielded at the recorded external-wait boundary";
  }
  const base = `ci ${state} before review`;
  if (typeof r === "string" || r.checks === undefined) return `${base}; relevant checks unavailable`;
  const checkCount = Math.max(r.checkCount ?? r.checks.length, r.checks.length);
  const kind = state === "timeout" ? "pending" : "red";
  if (checkCount === 0) return `${base}; ${kind} checks: none (0 total)`;
  const shown = r.checks.join(", ");
  const truncated = checkCount > r.checks.length ? `; first ${r.checks.length} shown` : "";
  return `${base}; ${kind} checks: ${shown} (${checkCount} total${truncated})`;
}

function fixRungTerminationVerdict(
  rung: Pick<FixRungOutcome, "outcome" | "reason" | "standDownReason" | "blockedOnPr">,
): { reason: string; extra: Record<string, unknown>; phrase: string } {
  if (rung.outcome === "parked") {
    return {
      reason: rung.reason,
      extra: { blocked_on_pr: rung.blockedOnPr },
      phrase: `parked on prerequisite #${rung.blockedOnPr}`,
    };
  }
  if (rung.outcome === "rebased") {
    // W1-T1095 (capability 3): the head MOVED, so this rung is over — see `runFixRung`'s own
    // comment at the return site for why continuing against a now-stale worktree would push
    // nothing. Carries the same `blocked_on_pr` field the parked arm does, because it is the
    // same prerequisite that put this PR here.
    return {
      reason: rung.reason,
      extra: { blocked_on_pr: rung.blockedOnPr },
      phrase: `rebased onto its base (prerequisite #${rung.blockedOnPr})`,
    };
  }
  if (rung.outcome === "base_refreshed") {
    return {
      reason: rung.reason,
      extra: {},
      phrase: "base refreshed without spending a strike",
    };
  }
  return {
    reason: `stood down — ${rung.standDownReason}`,
    extra: {},
    phrase: `stood down (${rung.standDownReason})`,
  };
}

function workerErrorVerdict(
  r: WorkerResult,
  costUsd: number,
  stage: string,
): WorkerErrorVerdict | null {
  // A "success" subtype is a CLEAN terminal state and is NEVER a worker error — even if
  // isError is set. collectWorkerResult sets isError=true when the SDK iterator throws
  // AFTER yielding the result envelope; on a SUCCESS envelope that leaves the pair
  // {isError:true, subtype:"success"}, which previously produced the contradictory verdict
  // "worker error at implement: success" (run W1-T12a-1784117152056). A success-but-no-PR
  // run is handled downstream by noPrVerdict, not here.
  if (!r.isError || r.subtype === "success") return null;
  const budgetBreach = r.subtype === "error_max_budget_usd";
  const verdict: WorkerErrorVerdict["verdict"] = budgetBreach ? "blocked_budget" : "failed";
  return {
    verdict,
    budgetBreach,
    ledger: {
      ...(r.exit ? { worker_exit: r.exit.kind } : {}),
      ...(r.exit?.kind === "signal" ? { worker_exit_signal: r.exit.signal } : {}),
      ...(r.exit?.kind === "exit" ? { worker_exit_code: r.exit.code } : {}),
      verdict,
      stage,
      subtype: r.subtype,
      num_turns: r.numTurns,
      cost_usd: costUsd,
      billing_mode: billingMode(r.childEnvKeys),
      account_label: r.accountLabel,
      reason: budgetBreach
        ? "worker breached maxBudgetUsd — not retried (dollars are the backstop)"
        : r.exit?.kind === "signal"
          ? `worker ended by signal ${r.exit.signal} at ${stage}`
          : `worker error at ${stage}: ${r.subtype}`,
      model: r.model,
      effort: r.effort,
      tokens: r.tokens,
      ...cacheTokenLedgerFields(r.tokens),
    },
  };
}

function noPrVerdict(
  r: WorkerResult,
  costUsd: number,
  stage: string,
  commitsAheadCount: number,
  terminalClass?: "harness_commit_refused",
): NoPrVerdict {
  const reportExcerpt = noPrReportExcerpt(r);
  return {
    verdict: "no_pr",
    ledger: {
      verdict: "no_pr",
      stage,
      subtype: r.subtype,
      num_turns: r.numTurns,
      cost_usd: costUsd,
      billing_mode: billingMode(r.childEnvKeys),
      account_label: r.accountLabel,
      reason:
        reportExcerpt !== undefined
          ? "worker completed without opening a PR — left its own account, see report_excerpt"
          : "worker completed without opening a PR",
      model: r.model,
      effort: r.effort,
      tokens: r.tokens,
      ...cacheTokenLedgerFields(r.tokens),
      commits_ahead: commitsAheadCount,
      ...(reportExcerpt !== undefined ? { report_excerpt: reportExcerpt } : {}),
      // W1-T465: recorded UNCONDITIONALLY, unlike `report_excerpt` above — an absent field and a
      // field reading `unclassified` mean different things, and only one of them is a measurement.
      no_pr_shape: classifyNoPrShape(reportExcerpt),
      ...(terminalClass === "harness_commit_refused" ? { terminal_class: terminalClass } : {}),
    },
  };
}

function parseAlreadySatisfied(text: string): AlreadySatisfiedClaim | undefined {
  const matches = [...text.matchAll(/^[ \t]*ALREADY_SATISFIED:[ \t]*(\S.*)$/gim)];
  if (!matches.length) return undefined;
  const ref = matches[matches.length - 1][1].trim();
  return ref ? { raw: text, ref } : undefined;
}

function resolveAlreadySatisfied(
  helperHost: Pick<RunTaskHelperHost, "prNumberFromRef">, claim: AlreadySatisfiedClaim,
  github: GitHub,
  taskId: string,
): AlreadySatisfiedResolution {
  const { prNumberFromRef } = helperHost;
  const claimedNumber = prNumberFromRef(claim.ref);
  if (claimedNumber === undefined) return { outcome: "refuted", reason: "unparsable_ref" };
  // W1-T441: ask for EVERY merged PR carrying the trailer, not just the newest. Membership needs
  // no file reads at all — the claim is either among the trailered PRs or it is not — which is
  // why this half of the fix is free while rung (c)'s ATTRIBUTION half is not. Falls back to the
  // single-answer method when a gateway does not implement the wider one.
  const all = github.findMergedByTrailerAll?.(taskId);
  const credited = all === undefined ? github.findMergedByTrailer(taskId) : undefined;
  const candidates: PrRef[] = all ?? (credited ? [credited] : []);

  if ((all === null || (all === undefined && !credited)) && github.readFailed?.()) {
    // The gateway could not answer. Unchanged from #1631: an unreadable read is not a false claim.
    return { outcome: "unverifiable", reason: github.readFailureReason?.() ?? "unknown" };
  }
  if (candidates.length === 0) return { outcome: "refuted", reason: "not_found" };

  // THE FIX: a worker citing the PR that IMPLEMENTED the task is verified even when a later
  // `chore(plan): close ... as already-satisfied` PR carries the same trailer and is newer.
  const match = candidates.find((pr) => pr.number === claimedNumber);
  if (match) return { outcome: "verified", number: match.number, url: match.url };

  // Genuinely not among them — still refused, and the row names the PR the gateway would credit.
  // `preferImplementingPr` picks WHICH rival to name; with one candidate it is that candidate,
  // so the single-hit message is byte-identical to before.
  const rival = preferImplementingPr(candidates, (url) => github.changedFiles?.(url)) ?? candidates[0];
  return { outcome: "refuted", reason: "different_pr", creditedNumber: rival.number };
}

function resolveAlreadySatisfiedWithRetry(
  helperHost: Pick<RunTaskHelperHost, "prNumberFromRef">, claim: AlreadySatisfiedClaim,
  github: GitHub,
  taskId: string,
  resolve: (
    c: AlreadySatisfiedClaim,
    g: GitHub,
    t: string,
  ) => AlreadySatisfiedResolution = resolveAlreadySatisfied.bind(undefined, helperHost),
  attempts: number = ALREADY_SATISFIED_VERIFY_ATTEMPTS,
): { resolution: AlreadySatisfiedResolution; attempts: number } {
  // A bound below one would ask nothing and return no resolution at all, so the first read always
  // happens; `attempts` bounds the RE-reads, never the question itself.
  const total = Math.max(1, attempts);
  let last = resolve(claim, github, taskId);
  let used = 1;
  while (last.outcome === "unverifiable" && used < total) {
    last = resolve(claim, github, taskId);
    used += 1;
  }
  return { resolution: last, attempts: used };
}

function alreadySatisfiedVerdict(
  r: WorkerResult,
  costUsd: number,
  stage: string,
  pr: { number: number; url: string },
): AlreadySatisfiedVerdict {
  return {
    verdict: "already_satisfied",
    prUrl: pr.url,
    ledger: {
      verdict: "already_satisfied",
      stage,
      subtype: r.subtype,
      num_turns: r.numTurns,
      cost_usd: costUsd,
      billing_mode: billingMode(r.childEnvKeys),
      account_label: r.accountLabel,
      reason: `worker found acceptance already satisfied by merged ${pr.url} — credited, no new PR opened`,
      pr_number: pr.number,
      pr_url: pr.url,
      model: r.model,
      effort: r.effort,
      tokens: r.tokens,
      ...cacheTokenLedgerFields(r.tokens),
    },
  };
}

function implementAttemptOutcome(helperHost: Pick<RunTaskHelperHost, "workerSignal">, r: WorkerResult): AttemptOutcome {
  const { workerSignal } = helperHost;
  if (r.apiError) return { success: false, evidence: workerSignal(r) };
  if (r.isError && r.subtype === "error_max_budget_usd") throw new ImplementBudgetBreach();
  if (r.isError && r.subtype === "success") return { success: true };
  if (r.isError) return { success: false, evidence: workerSignal(r) };
  return { success: true };
}

function finishTransientRetry(
  helperHost: Pick<RunTaskHelperHost, "terminalVerdictFields">, driverResult: DiagnoseThenRetryResult,
  context: { taskId: string; runId: string; repoDir: string; worktreePath: string; costUsd: number;
    worker: WorkerResult; log: RunTaskContext["log"]; say: RunTaskContext["say"] },
  removeWorktree: typeof worktreeRemove = worktreeRemove,
): RunResult | undefined {
  const { terminalVerdictFields } = helperHost;
  if (driverResult.outcome !== "gave_up" || driverResult.exhaustedClass !== "transient") return undefined;
  const { taskId, runId, repoDir, worktreePath, costUsd, worker, log, say } = context;
  if (driverResult.cashAllowanceExhausted) {
    log("worktree.retained", { on: "cash_allowance_exhausted", reason: "a later tool turn may have left unpublished edits" });
  } else {
    try {
      removeWorktree(repoDir, worktreePath);
      log("worktree.remove", { on: "blocked_transient" });
    } catch (e) {
      log("worktree.remove.error", { on: "blocked_transient", error: String((e as Error)?.message ?? e) });
    }
  }
  log("verdict", {
    verdict: "blocked_transient",
    stage: "implement",
    subtype: worker.subtype,
    num_turns: worker.numTurns,
    cost_usd: costUsd,
    billing_mode: billingMode(worker.childEnvKeys),
    account_label: worker.accountLabel,
    reason: driverResult.cashAllowanceExhausted ? driverResult.reason
      : `repeated transient API error across ${driverResult.transientRetries} retries — ${driverResult.reason}`,
    ...terminalVerdictFields(worker),
  });
  say(`verdict: blocked_transient — ${driverResult.reason}`);
  return { taskId, runId, merged: false, costUsd, verdict: "blocked_transient" };
}

function workerVisibleRecordPath(
  planPath: string,
  recordPath: string | undefined,
): string | undefined {
  if (!recordPath) return undefined;
  if (!isAbsolute(recordPath)) return recordPath; // already tree-relative — nothing to re-anchor
  // The tree `planPath` LIVES IN, never the module-level `repoRoot`: that one is resolved from
  // `process.cwd()` at import time, so for an injected `opts.planPath` it names an unrelated tree
  // and every answer would escape as `../..`. `dirname(planPath)/..` is the same anchor the
  // neighbouring `learningsDir` already uses.
  const rel = relative(dirname(dirname(planPath)), recordPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

function taskRecordContextLine(
  taskId: string,
  recordPath: string | undefined,
  criteria: ReadonlyArray<AcceptanceCriterion> = [],
): string {
  if (!recordPath) return "";
  const rendered = criteria.map(
    (c, i) => `    (${String.fromCharCode(97 + i)}) ${c.claim}\n        proof: ${c.proof}`,
  );
  return (
    `- YOUR TASK'S OWN RECORD IS AT ${recordPath} — READ IT FIRST. It carries the design, ` +
    "rationale and acceptance criteria that recon would otherwise have relayed, and nothing " +
    `else in this prompt contains them. ${citation(`plan#${taskId}`)}` +
    (rendered.length ? `\n    Acceptance criteria, verbatim from that record:\n${rendered.join("\n")}` : "")
  );
}

function nonEmptyLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function reconObservedToContext(helperHost: Pick<RunTaskHelperHost, "renderReconClaimLines">, recon: WorkerResult, taskId: string, recordPath?: string): string {
  const { renderReconClaimLines } = helperHost;
  const parsed = parseReconReport(workerTranscript(recon));
  const lines = nonEmptyLines(parsed?.observed ?? "");
  const gaps = nonEmptyLines(parsed?.couldntVerify ?? "");
  // Each line becomes a cited CONTEXT claim (provenance from recon). The record line leads: it is
  // stable per task, while recon's output is per-run (cache-aware ordering, W1-T35). Gaps come
  // LAST so the prompt reads observations-then-caveats, and each carries the prefix above.
  return [taskRecordContextLine(taskId, recordPath), ...renderReconClaimLines(taskId, lines, gaps)]
    .filter((s) => s.length > 0)
    .join("\n");
}

function reconDegradedContextNote(
  subtype: string,
  taskId: string,
  recordPath?: string,
  acceptance: ReadonlyArray<AcceptanceCriterion> = [],
): string {
  const lines = [
    `- RECON CONTEXT ABSENT: the recon worker errored twice in a row (${subtype}) and the ` +
      "bounded retry was exhausted, so no OBSERVED lines are available for this run — do not " +
      "assume recon ran cleanly; rely only on the CONTEXT/TASK below and your own read-only " +
      `inspection. ${citation(`recon#${taskId}`)}`,
  ];

  // ── SAY WHERE. The note above has always told a degraded worker to rely on "your own read-only
  // inspection" and never said WHERE to look — and nothing else in the prompt carries the task's
  // own text. `renderImplementPrompt` renders `task.prompt ?? task.title` (MEASURED: zero task
  // records carry `prompt:`, so it is always the title), `design:` is read by nothing in src/ at
  // all, and `task.acceptance` is consumed by `runReview` — the REVIEWER, not the worker. The
  // specification therefore reaches a worker ONLY because recon opens the record from disk and
  // relays it, which makes recon the sole transport for the task's own text rather than a
  // research phase. When recon degrades that transport is gone: MEASURED on W1-T399, implement
  // burned 138 turns and produced zero commits from a one-line title.
  // The bullet itself now lives in {@link taskRecordContextLine}, shared with the HEALTHY path —
  // extracted rather than copied so the two cannot drift and this path cannot gain a second copy.
  // Output here is byte-identical to before the extraction; only the criteria travel on this side.
  const recordLine = taskRecordContextLine(taskId, recordPath, acceptance);
  if (recordLine) lines.push(recordLine);
  return lines.join("\n");
}

function reconMaskedContextNote(
  taskId: string,
  recordPath?: string,
  acceptance: ReadonlyArray<AcceptanceCriterion> = [],
): string {
  const lines = [
    "- RECON CONTEXT MASKED: this run is arm B of a RECON-factor wipe-test pair (W1-T2512) — " +
      "the recon worker was deliberately never spawned, and the recon artifact store was " +
      "neither read nor written, so no OBSERVED lines are available for this run by design; " +
      "rely only on the CONTEXT/TASK below and your own read-only inspection. " +
      `${citation(`recon#${taskId}`)}`,
  ];
  const recordLine = taskRecordContextLine(taskId, recordPath, acceptance);
  if (recordLine) lines.push(recordLine);
  return lines.join("\n");
}

function fileDigestOrAbsent(helperHost: Pick<RunTaskHelperHost, "sha256Hex">, p: string): string {
  const { sha256Hex } = helperHost;
  try {
    return sha256Hex(readFileSync(p, "utf8"));
  } catch {
    return "absent";
  }
}

function filesDigest(helperHost: Pick<RunTaskHelperHost, "sha256Hex">, worktreePath: string, files: ReadonlyArray<string>): string {
  const { sha256Hex } = helperHost;
  const sorted = [...files].sort();
  const combined = sorted.map((f) => `${f}:${fileDigestOrAbsent(helperHost, join(worktreePath, f))}`).join("\n");
  return sha256Hex(combined);
}

function taskRecordSha(helperHost: Pick<RunTaskHelperHost, "sha256Hex">, planPath: string, taskId: string): string {
  const { sha256Hex } = helperHost;
  const recordPath = taskRecordPath(planPath, taskId);
  if (!recordPath) return PLAN_RECORD_ABSENT;
  try {
    return sha256Hex(readFileSync(recordPath, "utf8"));
  } catch {
    // A race (the resolved path vanished between taskRecordPath's read and this one) reads
    // identically to "never resolved" — both are the same ABSENT sentinel to every consumer.
    return PLAN_RECORD_ABSENT;
  }
}

function decideReconArtifactReuse(
  prior: ReconArtifact | undefined,
  currentPlanSha: string,
  currentFilesDigest: string,
): { valid: boolean; invalidationReason?: "plan_sha" | "files_digest" } {
  if (!prior) return { valid: false };
  if (currentPlanSha === PLAN_RECORD_ABSENT) return { valid: false, invalidationReason: "plan_sha" };
  const valid = prior.plan_sha === currentPlanSha && prior.files_digest === currentFilesDigest;
  if (valid) return { valid: true };
  return { valid: false, invalidationReason: prior.plan_sha !== currentPlanSha ? "plan_sha" : "files_digest" };
}

function reconArtifactPath(root: string, taskId: string): string {
  return join(root, "state", "recon-artifacts", `${taskId}.json`);
}

function loadReconArtifact(root: string, taskId: string): ReconArtifact | undefined {
  const p = reconArtifactPath(root, taskId);
  if (!existsSync(p)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ReconArtifact).plan_sha === "string" &&
      typeof (parsed as ReconArtifact).files_digest === "string" &&
      typeof (parsed as ReconArtifact).observed === "string" &&
      typeof (parsed as ReconArtifact).inferred === "string" &&
      typeof (parsed as ReconArtifact).couldnt_verify === "string"
    ) {
      return parsed as ReconArtifact;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeReconArtifact(root: string, artifact: ReconArtifact): void {
  const p = reconArtifactPath(root, artifact.task_id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(artifact, null, 2));
}

function reconArtifactToContext(helperHost: Pick<RunTaskHelperHost, "renderReconClaimLines">, artifact: ReconArtifact, taskId: string, recordPath?: string): string {
  const { renderReconClaimLines } = helperHost;
  const lines = nonEmptyLines(artifact.observed);
  const gaps = nonEmptyLines(artifact.couldnt_verify);
  const header =
    `- REUSED RECON ARTIFACT from a prior dispatch of this task (written ${artifact.written_at}): ` +
    "the claims below are EVIDENCE to VERIFY-AND-EXTEND, not settled fact — confirm each before " +
    `building on it, the same as you would recon's own OBSERVED output. ${citation(`recon#${taskId}`)}`;
  return [header, taskRecordContextLine(taskId, recordPath), ...renderReconClaimLines(taskId, lines, gaps)]
    .filter((s) => s.length > 0)
    .join("\n");
}

function buildRuleHeadlinesPart(
  helperHost: Pick<RunTaskHelperHost, "readRuleSourceFileOrUndefined">, enabled: boolean,
  sourcePath: string,
  readFile: (path: string) => string | undefined = helperHost.readRuleSourceFileOrUndefined,
  displayPath: string = sourcePath,
): string {
  if (!enabled) return "";
  // `sourcePath` is where the file is READ from (an absolute worktree path at the real call site);
  // `displayPath` is what the WORKER is told. The worker's cwd is its own worktree, so the
  // repo-relative name is the one that resolves for it, and no prompt line names a foreign tree.
  const introLine =
    `- CLAUDE.md's rule headlines (progressive disclosure, W1-T2508) — headlines only, no ` +
    `bodies, so you know what exists without paying for what you don't need yet. ` +
    citation(RULE_HEADLINES_SRC);
  const raw = readFile(sourcePath);
  if (raw === undefined) {
    const unreadable: RuleHeadline = {
      headline: "CLAUDE.md rule index",
      body: ` (unavailable — could not read rule source ${displayPath})`,
    };
    // Indented without its own bullet, like the index lines below: it continues the cited intro claim. As a
    // bullet it was an uncited claim, and the provenance gate refused every dispatch to a tree with no CLAUDE.md.
    return [introLine, `    ${retrieveRuleBodyOrDegrade(unreadable, () => undefined).replace(/^- /, "")}`].join("\n");
  }
  const rules = parseRuleHeadlines(raw);
  const indexLines = renderHeadlineOnlyIndex(rules)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => `    ${l.replace(/^- /, "")}`);
  // W1-T3323: the bodies left CLAUDE.md for `doctrine/`, so the line telling a worker WHERE to
  // read one has to move with them or it sends the worker to a file that no longer holds the
  // evidence. The 56 paths themselves stay OUT of the prompt — that is ~2800 bytes on every
  // turn-0 to save one `grep`, and this part exists to spend fewer bytes, not more; the source
  // names the exact path beside every headline and the worker has it in its own worktree.
  // A corpus whose bodies are still inline (any un-migrated tree) keeps the original line.
  const migrated = rules.some((r) => parseRuleBodyPointer(r.body) !== undefined);
  const pointer = migrated
    ? `    Each headline's full body — the measurement that earned it — is a file under ` +
      `doctrine/ in your own worktree, and ${displayPath} names the exact path beside every ` +
      `headline. Read one when you are about to apply that rule precisely, or you doubt it.`
    : `    Read a headline's full body from ${displayPath} in your own worktree when you need it — ` +
      "this index carries headlines only.";
  return [introLine, ...indexLines, pointer].join("\n");
}

function softBudgetWarning(
  costUsd: number,
  thresholdUsd: number,
  alreadyWarned: boolean,
): boolean {
  return !alreadyWarned && costUsd >= thresholdUsd;
}

function resolveRunMounts(
  repoRootDir: string,
  task: Pick<Task, "type" | "risk" | "files" | "band_meaning">,
  log: (step: string, extra?: Record<string, unknown>) => void,
): {
  mount: Mount;
  reviewerMount: Mount;
  fixMount: Mount;
  /**
   * W1-T7B: the DIAGNOSE stage's own mount (`routes.diagnose`, task_type "diagnose" × risk) —
   * model STEPS UP (§9), same discipline as `reviewerMount`/`fixMount` above. Resolved via the
   * plain (never class-routed) `resolveMount`, exactly like those two: `test/mounts-wiring.test.ts`
   * already proves `resolveMount(m, "diagnose", risk)` resolves for every risk off the committed
   * table, so — like `reviewerMount`/`fixMount` — this is never optional/try-caught.
   */
  diagnoseMount: Mount;
  /** The last-attempt mount (`step_up:` in mounts.yaml); absent keeps every attempt on its own mount. */
  stepUpMount?: Mount;
  /**
   * impl-BP — the RECON stage's own mount (`routes.recon`, task_type "recon" × risk × class).
   *
   * OPTIONAL, AND THAT IS THE SAFETY PROPERTY. Recon runs on EVERY dispatch, so a throw here
   * would break all dispatch rather than one lane. `resolveMountForClass` throws `MountsError`
   * on a missing/unroutable row, so it is called behind a try/catch and yields `undefined`
   * instead — and the recon spawn omits `model`/`effort` when it is `undefined`, which is
   * byte-for-byte today's behaviour (`lib/worker.ts`'s `if (args.model)` / `if (args.effort)`
   * guards simply never fire). A table without a `recon:` row is therefore INERT, not fatal.
   */
  reconMount: Mount | undefined;
  taskClass: string;
  mountClass: string;
} {
  const mountsTable = loadMounts(mountsPath(repoRootDir));
  const taskClass = deriveTaskClass(task);
  const mountResolution = resolveMountForClass(mountsTable, task.type, task.risk, implementRouteClass(task, taskClass));
  if (mountResolution.fellBackToDefault) {
    // W1-T167 acceptance: a class with no row falls back to the default LOUDLY —
    // a ledger line NAMING the missing class, never a silent number swap.
    log("mount.class_fallback", {
      task_type: task.type,
      risk: task.risk,
      requested_class: taskClass,
      resolved_class: mountResolution.resolvedClass,
    });
  }
  // The fresh advisory reviewer is its OWN mount-governed phase (task_type="reviewer",
  // W1-T63/P10); the blocked_review fix rung rides its own "fix" row (W1-T76) —
  // both resolved here alongside the task's own mount, never an undeclared literal.
  // impl-BP — RESOLVE THE RECON ROW, the one `routes:` entry nothing read. The state
  // directory's `mounts.yaml` has carried a fully-specified `recon:` block (haiku for low-risk/docs/plan-lint,
  // sonnet for medium/high src) since the class axis landed, and the recon spawn passed neither
  // `model` nor `effort` — so every recon in this repo's history ran on the SDK default. Measured
  // over the ledger unioned across all 661 rotations: 413 `recon.done` rows, model label
  // `"default"` on every single one, never a routed model. Same defect class as the `#781
  // architect:` row CLAUDE.md already records — a row that looks configured and has no reader.
  //
  // FAIL-SOFT BY CONSTRUCTION, because recon runs on EVERY dispatch: `resolveMountForClass`
  // throws on an absent/unroutable row, so a table without `recon:` (or an older committed table)
  // must degrade to today's behaviour rather than take the whole fleet down. The catch yields
  // `undefined`, the spawn then omits both knobs, and `lib/worker.ts`'s `if (args.model)` /
  // `if (args.effort)` guards leave the SDK default in place exactly as before.
  let reconMount: Mount | undefined;
  try {
    reconMount = resolveMountForClass(mountsTable, "recon", task.risk, taskClass).mount;
  } catch (e) {
    log("mount.recon_unrouted", {
      risk: task.risk,
      task_class: taskClass,
      reason: String((e as Error)?.message ?? e),
    });
  }
  return {
    mount: mountResolution.mount,
    reviewerMount: resolveMount(mountsTable, "reviewer", task.risk),
    fixMount: resolveMount(mountsTable, "fix", task.risk),
    diagnoseMount: resolveMount(mountsTable, "diagnose", task.risk),
    ...(mountsTable.step_up ? { stepUpMount: mountsTable.step_up } : {}),
    reconMount,
    taskClass,
    mountClass: mountResolution.resolvedClass,
  };
}

function probeVerdictKey(inputs: ProbeKeyInputs): string {
  const hash = createHash("sha256");
  for (const field of PROBE_KEY_FIELDS) {
    const value = inputs[field];
    if (typeof value !== "string") throw new Error(`probe key input ${field} is missing`);
    hash.update(`${field}\0${value}\0`);
  }
  return hash.digest("hex");
}

function hookFilesUnder(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? hookFilesUnder(dir, join(rel, entry.name)) : [join(rel, entry.name)]))
    .sort();
}

function readProbeKeyInputs(src: {
  settingsFile: string;
  runId: string;
  hooksDir: string;
  imageBuildShaPath: string;
  harnessRevision: string;
  cliVersion: string | undefined;
  provider: string;
  claudeBin: string;
  root: string;
}): ProbeKeyInputs {
  const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    imageBuildSha: existsSync(src.imageBuildShaPath) ? readFileSync(src.imageBuildShaPath, "utf8").trim() : "absent",
    harnessRevision: src.harnessRevision,
    workerSettings: digest(readFileSync(src.settingsFile, "utf8").split(src.runId).join("<run>")),
    hooks: hookFilesUnder(src.hooksDir).map((rel) => `${rel}:${digest(readFileSync(join(src.hooksDir, rel)))}`).join(","),
    cliVersion: src.cliVersion ?? "unobserved",
    provider: src.provider,
    claudeBin: src.claudeBin,
    root: src.root,
  };
}

function reportWorkerSourceSizeFollowup(
  args: ConsumeSourceSizeFollowupArgs,
  log: (step: string, extra?: Record<string, unknown>) => void,
  say: (message: string) => void,
  consume?: (input: ConsumeSourceSizeFollowupArgs) => ConsumeSourceSizeFollowupResult,
): ConsumeSourceSizeFollowupResult | undefined {
  try {
    const result = consume ? consume(args) : consumeSourceSizeFollowup(args);
    if (result.action === "filed") {
      say(`source-size follow-up filed as ${result.feedbackId} for ${result.files.length} material hotspot(s)`);
      return result;
    }
    if (result.action === "noop") {
      log("source_size.followup.noop", {
        reason: result.reason,
        ...(result.signature ? { signature: result.signature } : {}),
      });
      return result;
    }
    log("source_size.followup.error", { reason: result.reason, detail: result.detail });
    say(`source-size follow-up could not be filed (${result.reason}) — implementation verdict is unchanged`);
    return result;
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 512);
    log("source_size.followup.error", { reason: "unexpected_throw", detail });
    say("source-size follow-up could not be evaluated — implementation verdict is unchanged");
    return undefined;
  }
}

function isManagedCheckoutLockBusy(error: unknown): boolean {
  return error instanceof ManagedCheckoutRefreshRefusedError && error.reason.startsWith("another dispatch holds ");
}

function refreshManagedCheckout(
  helperHost: Pick<RunTaskHelperHost, "execFilePromise">, repoDir: string,
  lockPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  install?: (repoDir: string) => void | Promise<void>,
  escalate?: (failure: StagedInstallFailure) => void,
): Promise<ManagedCheckoutRefresh> {
  const { execFilePromise } = helperHost;
  if (!existsSync(join(repoDir, "node_modules"))) return Promise.resolve({ kind: "unborrowed", release: () => {} });
  // W1-T4933: staged and swapped, never the in-place clear-then-fill of ensureInstallFresh, which empties a tree others are linked to.
  const runInstall = install ?? ((dir: string) => void stagedInstall(dir, { log, escalate }));
  // W1-T6356: the lock is taken SYNCHRONOUSLY (a cheap file create) so a busy lock still throws from the call itself, which is
  // what retryWhileLockBusy's try/catch sees; only the git work after it is awaited.
  let lock: DrainLockHandle;
  try {
    lock = acquireDrainLock(lockPath);
  } catch (error) {
    throw new ManagedCheckoutRefreshRefusedError(`another dispatch holds ${lockPath} (${String((error as Error)?.message ?? error)})`);
  }
  // Async, so a fetch over a slow origin never holds the daemon loop (2026-10-08 profile: 20.1 s and 29.5 s blocks).
  const git = async (...args: string[]) => (await execFilePromise("git", ["-C", repoDir, ...args], { encoding: "utf8" })).stdout.trim();
  return refreshHeldManagedCheckout(repoDir, () => lock.release(), log, runInstall, git);
}

async function refreshHeldManagedCheckout(
  repoDir: string,
  release: () => void,
  log: (step: string, extra?: Record<string, unknown>) => void,
  runInstall: (repoDir: string) => void | Promise<void>,
  git: (...args: string[]) => Promise<string>,
): Promise<ManagedCheckoutRefresh> {
  const skip = (reason: string): ManagedCheckoutRefresh => {
    log("managed_checkout.refresh_skipped", { reason });
    return { kind: "skipped", reason, release };
  };
  try {
    const dirty = await git("status", "--porcelain");
    if (dirty) return skip(`checkout is dirty (${dirty.split("\n").length} changed path(s))`);
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") return skip(`checkout is on ${branch}, not main`);
    try {
      await git("fetch", "--quiet", "origin");
    } catch (error) {
      // Not a refusal: an unreachable origin leaves the checkout as it is, and `skip` ledgers the reason the refusal names.
      return skip(`could not fetch origin (${String((error as Error)?.message ?? error)})`);
    }
    const beforeSha = await git("rev-parse", "HEAD");
    if (beforeSha === (await git("rev-parse", "origin/main"))) {
      // W1-T4933: code that is already current can still sit on a tree that predates its lockfile. A failed refresh keeps
      // the old tree (stagedInstall ledgered and escalated it); the dispatch goes on and W1-T4193 names any mismatch it causes.
      try {
        await runInstall(repoDir);
      } catch (error) {
        log("managed_checkout.install_kept_stale", { reason: String((error as Error)?.message ?? error).slice(0, 512) });
      }
      return { kind: "current", release };
    }
    if ((await git("merge-base", "HEAD", "origin/main")) !== beforeSha) return skip("checkout has diverged from origin/main");
    const borrower = listRegisteredWorktrees(repoDir).find(({ path }) => {
      const held = path === repoDir ? undefined : readRunLock(path);
      return held?.kind === "corrupt" || (held?.kind === "live" && defaultIsPidAlive(held.info.pid));
    });
    if (borrower) return skip(`a live worker still borrows its node_modules (${borrower.path})`);
    await git("merge", "--ff-only", "--quiet", "origin/main");
    log("managed_checkout.fast_forward", { before_sha: beforeSha, after_sha: await git("rev-parse", "HEAD") });
    try {
      await runInstall(repoDir);
    } catch (error) {
      // Revert, so the checkout still reads as behind and the next dispatch retries the install instead of linking it.
      await git("reset", "--quiet", "--keep", beforeSha);
      throw new Error(`install failed after the fast-forward, reverted to ${beforeSha}: ${String((error as Error)?.message ?? error)}`);
    }
    return { kind: "fast_forwarded", release };
  } catch (error) {
    release();
    throw new ManagedCheckoutRefreshRefusedError(String((error as Error)?.message ?? error));
  }
}

function sourceSizeGateFollowupConsumer(
  input: ConsumeSourceSizeFollowupArgs,
  log: (step: string, extra?: Record<string, unknown>) => void,
  say: (message: string) => void,
  report: typeof reportWorkerSourceSizeFollowup = reportWorkerSourceSizeFollowup,
): ConsumeSourceSizeFollowupResult {
  return (
    report(input, log, say) ?? {
      action: "error",
      reason: "filing_failed",
      detail: "source-size follow-up consumer returned no result",
    }
  );
}

function buildSourceSizeGatePostureRuntime(
  repoRoot: string,
  worktreePath: string,
  settingsFile: string,
  spawn: typeof spawnWorker,
  log: (step: string, extra?: Record<string, unknown>) => void,
  say: (message: string) => void,
): SourceSizeGatePostureRuntime {
  try {
    const spend = riskJudgeSpendCollector();
    return {
      runRiskJudge,
      spend,
      judge: realRiskJudge({
        mount: resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot))),
        cwd: worktreePath,
        settingsFile,
        spawn,
        spend,
        log: (step, extra) => log(step, extra),
      }),
      consume: (input) => sourceSizeGateFollowupConsumer(input, log, say),
    };
  } catch (error) {
    log("gate_posture.judge_unavailable", {
      gate: "ci:source-size",
      reason: `source-size judge setup unavailable — ${String((error as Error)?.message ?? error)}`,
    });
    return {};
  }
}

function sourceSizeFollowupDebtResult(result: ConsumeSourceSizeFollowupResult | undefined): string | undefined {
  if (result?.action === "filed") return `feedback:${result.feedbackId}`;
  // A duplicate is the successful retry outcome for this pilot: the durable signature already
  // proves the bounded follow-up exists, so it is not a failed side effect.
  if (result?.action === "noop" && result.reason === "duplicate") {
    return `source-size://duplicate/${result.signature ?? "unknown"}`;
  }
  return undefined;
}

async function reportWorkerSourceSizeFollowupWithGatePosture(
  args: ConsumeSourceSizeFollowupArgs,
  log: (step: string, extra?: Record<string, unknown>) => void,
  say: (message: string) => void,
  deps: SourceSizeGatePostureRuntime = {},
): Promise<SourceSizeGatePostureResult> {
  let classified: ReturnType<typeof classifySourceSizeSummary>;
  try {
    const raw = (args.readFile ?? ((path) => readFileSync(path, "utf8")))(preflightSummaryPath(args.worktreeRoot));
    classified = classifySourceSizeSummary(JSON.parse(raw), args.expectedHead);
  } catch {
    // The existing consumer owns the exact no-op/error narration for an unreadable summary. An
    // unreadable sensor is not a deterministic finding and therefore must not spawn a judge.
    return {
      decision: {
        outcome: "LAND",
        reason: "source-size summary was unreadable; no deterministic gate finding",
        judgmentSpawned: false,
        fallback: false,
      },
      followup: reportWorkerSourceSizeFollowup(args, log, say, deps.consume),
    };
  }

  const materialHotspots = classified.action === "material" ? classified.hotspots : undefined;
  const finding: GatePostureFinding | undefined =
    materialHotspots !== undefined
      ? {
          gate: "ci:source-size",
          finding: `source-size reported ${materialHotspots.length} material maintainability hotspot(s)`,
          evidence: materialHotspots.map((hotspot) => hotspot.path),
          recoverability: "recoverable",
          currentConsequence: "LAND+DEBT",
        }
      : undefined;

  if (finding === undefined) {
    const decision = await (deps.decide ?? decideGatePosture)({ finding: undefined }, { log });
    return {
      decision,
      followup: reportWorkerSourceSizeFollowup(args, log, say, deps.consume),
    };
  }

  let sideEffectAttempted = false;
  let followup: ConsumeSourceSizeFollowupResult | undefined;
  const applyFollowup = (): string | undefined => {
    if (sideEffectAttempted) return sourceSizeFollowupDebtResult(followup);
    sideEffectAttempted = true;
    followup = reportWorkerSourceSizeFollowup(args, log, say, deps.consume);
    return sourceSizeFollowupDebtResult(followup);
  };

  const decision = await (deps.decide ?? decideGatePosture)(
    {
      finding,
      change: {
        description: "source-size maintainability signal produced a bounded follow-up candidate",
        files: [...(finding.evidence ?? [])],
      },
      planContext: { taskId: args.sourceTask, taskType: "source-size-followup" },
      headSha: args.expectedHead,
      ...(args.sourcePr === undefined ? {} : { prNumber: Number(args.sourcePr.match(/\/pull\/(\d+)/)?.[1]) || undefined }),
    },
    {
      runRiskJudge: deps.runRiskJudge,
      judge: deps.judge,
      cache: deps.cache,
      spend: deps.spend,
      log,
      // Both labels have the same bounded effect for this pilot: file the existing, deduped
      // decomposition follow-up. The judge chooses whether the work is ordinary repair or debt;
      // it never receives authority to rewrite the deterministic hotspot finding.
      repair: applyFollowup,
      fileDebt: applyFollowup,
    },
  );

  // A fallback means the judge did not choose a consequence. Restore the pre-pilot behavior,
  // which was to file the source-size follow-up, without trying a second time after a failed
  // callback (the callback itself is the existing idempotent consumer).
  if (decision.fallback && !sideEffectAttempted) applyFollowup();
  if (decision.outcome === "LAND" && !decision.fallback) {
    log("source_size.followup.deferred", {
      reason: decision.reason,
      hotspot_count: finding.evidence?.length ?? 0,
    });
    say("source-size follow-up deferred by the gate judge — implementation remains unblocked");
  }
  return { decision, ...(followup === undefined ? {} : { followup }) };
}

async function withInflightRunLock<T>(
  lock: InflightLockHandle,
  taskId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  run: (log: (step: string, extra?: Record<string, unknown>) => void) => Promise<T>,
): Promise<T> {
  let waitingOn: unknown;
  try {
    return await run((step, extra) => {
      if (step === "run.freshness_handoff" && extra?.trigger === "recycle") waitingOn = extra.waiting_on;
      log(step, extra);
    });
  } finally {
    try {
      if (waitingOn) log("inflight.recycle_yield", {
        lock_key: basename(lock.path, ".lock"), task_id: taskId, run_id: lock.info.run_id, waiting_on: waitingOn,
      });
    } finally {
      lock.release();
    }
  }
}

function endThrownRun(
  helperHost: Pick<RunTaskHelperHost, "terminalVerdictFields" | "scrubGitCredentialText" | "runErrorCause">, log: RunTaskContext["log"],
  alreadyEnded: boolean,
  stage: ThrownRunVerdictStage,
  err: unknown,
  costUsd: number,
): void {
  const { runErrorCause } = helperHost;
  endRunOnce(helperHost, log, alreadyEnded, () => ({
    verdict: "failed",
    reason: boundedVerdictReason(helperHost, String((err as Error)?.message ?? err)),
    stage,
    cause: runErrorCause(err),
    cost_usd: costUsd,
  }));
}

async function deferOpenToSiblingPr(
  helperHost: Pick<RunTaskHelperHost, "terminalVerdictFields" | "scrubGitCredentialText">, ctx: RunTaskContext,
  run: { impl: WorkerResult; branch: string; worktreePath: string; repoDir: string; costUsd: number },
): Promise<RunResult | undefined> {
  const { terminalVerdictFields } = helperHost;
  const { log, say, opts, owner, task, taskId, runId } = ctx;
  const { impl, branch, worktreePath, repoDir, costUsd } = run;
  const sibling = await readOtherOpenPrForTask(owner, task.repo, taskId, branch, opts.otherOpenPrReader ?? ((args) => ghJsonAsync(args)));
  if (sibling.state === "unreadable") {
    log("pr.open_existing_check_unreadable", { branch, error: boundedVerdictReason(helperHost, sibling.error) });
    return undefined;
  }
  if (sibling.state === "none") return undefined;
  const headSha = hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
  log("pr.open_deferred_to_existing", {
    existing_pr_number: sibling.number,
    existing_pr_url: sibling.url,
    existing_head_ref: sibling.head_ref,
    matched_by: sibling.matched_by,
    branch,
    head_sha: headSha,
    cost_usd: costUsd,
  });
  reclaimRunWorktree(repoDir, worktreePath, "pr_open.deferred_to_existing", log);
  log("verdict", {
    verdict: "blocked_inflight",
    reason: `${taskId} already has open PR #${sibling.number} (${sibling.head_ref}); not opening a second`,
    stage: "pr_open.deferred_to_existing",
    branch,
    head_sha: headSha,
    cost_usd: costUsd,
    billing_mode: billingMode(impl.childEnvKeys),
    account_label: impl.accountLabel,
    ...terminalVerdictFields(impl),
  });
  say(`verdict: blocked_inflight — ${taskId} already has open PR #${sibling.number}; branch ${branch} kept on origin at ${headSha}`);
  return { taskId, runId, merged: false, costUsd, verdict: "blocked_inflight" };
}

function reclaimRunWorktree(
  repoDir: string,
  worktreePath: string,
  on: string,
  log: RunTaskContext["log"],
  remove: (repoDir: string, worktreePath: string) => void = worktreeRemove,
): void {
  try {
    remove(repoDir, worktreePath);
    log("worktree.remove", { on });
  } catch (e) {
    log("worktree.remove.error", { on, error: String((e as Error)?.message ?? e) });
  }
}

function endRefusedRun(
  helperHost: Pick<RunTaskHelperHost, "terminalVerdictFields" | "scrubGitCredentialText">, log: RunTaskContext["log"],
  alreadyEnded: boolean,
  stage: RefusedRunVerdictStage,
  result: RunResult,
  reason: string,
): RunResult {
  endRunOnce(helperHost, log, alreadyEnded, () => ({ verdict: result.verdict, reason: boundedVerdictReason(helperHost, reason), stage, cost_usd: result.costUsd }));
  return result;
}

function boundedVerdictReason(helperHost: Pick<RunTaskHelperHost, "scrubGitCredentialText">, text: string): string {
  const { scrubGitCredentialText } = helperHost;
  return capStderrExcerpt(scrubGitCredentialText(text), STDERR_EXCERPT_CAP);
}

function endRunOnce(helperHost: Pick<RunTaskHelperHost, "terminalVerdictFields">, log: RunTaskContext["log"], alreadyEnded: boolean, row: () => Record<string, unknown>): void {
  const { terminalVerdictFields } = helperHost;
  if (alreadyEnded) return;
  try {
    log("verdict", { ...row(), ...terminalVerdictFields(null) });
  } catch {
    const reason = "thrown-run-verdict-ledger-write-failed";
    void reason; // the caller's rethrow or return is the authoritative outcome
  }
}

async function repairCensusRefusedPush(helperHost: Pick<RunTaskHelperHost, "CENSUS_BASELINE_FILES" | "reclaimAbandonedWorker" | "fixWorkerRunId" | "fixWorkerReceipt" | "spawnFixWorkerBounded" | "commitsAhead" | "censusPushRefusal" | "CENSUS_PUSH_CHECK" | "CENSUS_SNAPSHOT_ENV" | "COVERAGE_PUSH_CHECK" | "CENSUS_PUSH_NEVER_BYPASS" | "fixCensusAppliesToRepo" | "writeFixCensusSnapshotAsync" | "checkFixCensusSnapshotAsync" | "fixRoundGitOwnership" | "harnessCommitForShellLessWorker">, input: {
  refusal: CensusPushRefusal;
  task: Task;
  runId: string;
  worktreePath: string;
  branch: string;
  resumeSessionId: string;
  resumeSessionProvider?: WorkerResult["provider"];
  mount: Mount;
  stepUpMount?: Mount;
  settingsFile: string;
  config: Config;
  budgetUsd: number;
  ledgerPath: string;
  spawnWallClockBoundMs?: number;
  spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
  account: (r: WorkerResult) => WorkerResult;
  log: (step: string, extra?: Record<string, unknown>) => void;
  say: (msg: string) => void;
  /** W1-T4797: re-run a NON-hook gate (the diff-coverage precheck) after each strike's commit, before the push;
   *  a refusal it returns becomes the next strike's evidence exactly as a hook refusal does. */
  recheck?: () => Promise<CensusPushRefusal | undefined>;
  /** Only the implement fallback offers closure catalog edits; the fix lane never does. */
  catalogFiles?: (refusal: CensusPushRefusal) => readonly string[];
}): Promise<CensusPushRungOutcome> {
  const { CENSUS_BASELINE_FILES, reclaimAbandonedWorker, fixWorkerRunId, fixWorkerReceipt, spawnFixWorkerBounded, commitsAhead, censusPushRefusal, CENSUS_PUSH_CHECK, CENSUS_SNAPSHOT_ENV, COVERAGE_PUSH_CHECK, CENSUS_PUSH_NEVER_BYPASS, fixCensusAppliesToRepo, writeFixCensusSnapshotAsync, checkFixCensusSnapshotAsync, fixRoundGitOwnership, harnessCommitForShellLessWorker } = helperHost;
  const { task, worktreePath: cwd, log } = input;
  const head = () => hostWorktreeGit(cwd, ["rev-parse", "HEAD"]).trim();
  const startHead = head();
  const offered = new Set(input.refusal.offeredBaselines);
  const catalogOffered = new Set<string>();
  const { harnessCommits, cashTools } = fixRoundGitOwnership(input.config);
  const strikeCap = fixStrikeCap(input.config);
  let refusal = input.refusal;
  for (let strike = 1; strike <= strikeCap; strike++) {
    const catalogFiles = input.catalogFiles?.(refusal) ?? [];
    for (const path of catalogFiles) catalogOffered.add(path);
    log("census_push.refused", { strike, censuses: refusal.censuses, refusal: refusal.text, worktree: cwd });
    const mount = input.stepUpMount && strike > 1 && strike === strikeCap ? input.stepUpMount : input.mount;
    const censusSnapshotPath = harnessCommits && fixCensusAppliesToRepo(task.repo, log) ? await writeFixCensusSnapshotAsync(cwd, log) : undefined;
    const prompt = [
      renderFixPrompt({
        task,
        round: strike,
        branch: input.branch,
        harnessCommits,
        censusSnapshotPath,
        evidence: { ciFailures: [{ name: input.recheck ? COVERAGE_PUSH_CHECK : CENSUS_PUSH_CHECK, logTail: refusal.text }] },
        reachableRemedyFiles: [
          ...refusal.offeredBaselines.map((path) => ({ path, job: "census-precheck" })),
          ...catalogFiles.map((path) => ({ path, job: "baked-closure" })),
        ],
      }),
      "",
      input.recheck
        ? "PRE-PUSH DIFF-COVERAGE (W1-T4797): no PR exists yet — CI's coverage-ratchet would refuse this head; add the tests that cover each line named above."
        : censusPushRefusal(refusal.text)
          ? "PRE-PUSH CENSUS (W1-T4656): no PR exists yet — hooks/pre-push refused this branch with the census rows above."
          : "PRE-PUSH GATE: no PR exists yet — hooks/pre-push refused this branch with the gate output above; apply the remedy it names.",
      CENSUS_PUSH_NEVER_BYPASS,
      ...(catalogFiles.length > 0 ? ["Baked-closure catalog — update these lists in this reviewed implement build:", bakedClosureCatalogDetails(refusal.text)] : []),
    ].join("\n");
    const roundStart = head();
    const receipt = fixWorkerReceipt(input.spawn, log, fixWorkerRunId(input.runId, `census${strike}`, systemClock.now()), fixLaneBenchmarkWork(task, input.ledgerPath));
    const spawned = await spawnFixWorkerBounded(
      { spawn: receipt.spawn, log, spawnWallClockBoundMs: input.spawnWallClockBoundMs, reclaimWorker: (info) => reclaimAbandonedWorker(info, { log }) },
      {
        cwd,
        permissionMode: "bypassPermissions",
        settingsFile: input.settingsFile,
        model: mount.model,
        mountProvider: mount.provider,
        effort: mount.effort,
        maxTurns: mount.maxTurns,
        maxBudgetUsd: input.budgetUsd,
        config: input.config,
        prompt,
        ...(censusSnapshotPath ? { env: { [CENSUS_SNAPSHOT_ENV]: censusSnapshotPath } } : {}),
        resumeSessionId: strike === 1 ? input.resumeSessionId : undefined,
        ...(strike === 1 && input.resumeSessionId ? { continuation: workerContinuation(
          { provider: input.resumeSessionProvider, text: "", blocks: [] },
          "The current task, output contract and refused gate are in the pending action below.", cwd,
        ) } : {}),
        tools: harnessCommits ? FIX_WORKER_TOOLS_HARNESS_COMMITS : FIX_WORKER_TOOLS,
        ...(cashTools === undefined ? {} : { cashTools }),
        runId: input.runId,
        taskId: task.id,
      },
      { runId: input.runId, taskId: task.id },
    );
    if (spawned.kind !== "spawned") return { outcome: "refused", strikes: strike, refusal, reason: `fix worker ${spawned.kind} after ${spawned.elapsedMs}ms` };
    const result = input.account(spawned.result);
    const censusCheck = await checkFixCensusSnapshotAsync(cwd, censusSnapshotPath, log);
    if (censusCheck?.refusal) {
      refusal = censusCheck.refusal;
      log("census_push.strike", { strike, ...receipt.ledgerFields(result), cost_usd: result.costUsd,
        reason: "saved edits refused by census before commit", refusal: refusal.text });
      continue;
    }
    harnessCommitForShellLessWorker({
      harnessOwnsGit: harnessCommits,
      commitCount: commitsAhead(cwd, roundStart),
      report: workerTranscript(result),
      worktreePath: cwd,
      declaredPaths: [...(task.files ?? []), ...refusal.offeredBaselines, ...catalogFiles],
      acceptance: task.acceptance,
      assignmentId: result.selectionAssignmentId,
      log,
      say: input.say,
    });
    const baselineFiles = hostWorktreeGit(cwd, ["diff", "--name-only", startHead, "HEAD", "--", ...CENSUS_BASELINE_FILES])
      .split("\n")
      .filter(Boolean);
    log("census_push.strike", { strike, ...receipt.ledgerFields(result), cost_usd: result.costUsd, baseline_files: baselineFiles });
    const unoffered = baselineFiles.filter((f) => !offered.has(f));
    if (unoffered.length > 0) return { outcome: "refused", strikes: strike, refusal, reason: `raised a baseline no refusal row offers: ${unoffered.join(", ")}` };
    const stillRefused = await input.recheck?.();
    if (stillRefused) {
      refusal = stillRefused;
      continue;
    }
    dropTierRowsBeforePush(cwd, log);
    try {
      await gitPushRunBranchAsync(cwd);
    } catch (err) {
      const next = censusPushRefusal(err) ?? prePushGateRefusal(err);
      if (!next) throw err;
      refusal = next;
      for (const f of next.offeredBaselines) offered.add(f);
      continue;
    }
    const remedy = baselineFiles.length > 0 ? "baseline-row" : "code-change";
    const catalogFilesStaged = catalogOffered.size > 0
      ? hostWorktreeGit(cwd, ["diff", "--name-only", startHead, "HEAD", "--", ...catalogOffered]).split("\n").filter(Boolean).sort()
      : [];
    log("census_push.cleared", { strikes: strike, remedy, baseline_files: baselineFiles, censuses: input.refusal.censuses });
    return { outcome: "cleared", strikes: strike, remedy, baselineFiles,
      ...(catalogFilesStaged.length > 0 ? { catalogFiles: catalogFilesStaged } : {}) };
  }
  return { outcome: "refused", strikes: strikeCap, refusal, reason: `not cleared in ${strikeCap} strike(s)` };
}

function normalizeRunPrAcceptanceFromPlan(
  helperHost: Pick<RunTaskHelperHost, "rewriteAcceptanceBlockFromPlan" | "defaultRetroFetchBody" | "defaultRetroEditBody">, prUrl: string,
  taskId: string,
  planCriteria: readonly AcceptanceCriterion[],
  log: (step: string, extra?: Record<string, unknown>) => void,
  // The SAME two leaves (and the same defaults) repairRetroAcceptanceBlock injects — reused from its
  // own signature rather than a second inline copy; its retro-only `diff` input is omitted here.
  deps: Omit<NonNullable<Parameters<RunTaskCommandHost["repairRetroAcceptanceBlock"]>[2]>, "diff"> = {},
): "rewritten" | "healthy" | "no-block" | "error" {
  const { rewriteAcceptanceBlockFromPlan, defaultRetroFetchBody, defaultRetroEditBody } = helperHost;
  if (planCriteria.length === 0) return "no-block";
  const { fetchBody, editBody } = { fetchBody: defaultRetroFetchBody, editBody: defaultRetroEditBody, ...deps };
  try {
    const body = fetchBody(prUrl);
    // W1-T5544: the comparison and splice live in {@link rewriteAcceptanceBlockFromPlan}, shared with the sweep cure.
    const rewrite = rewriteAcceptanceBlockFromPlan(body, taskId, planCriteria);
    if (rewrite.kind !== "rewritten") return rewrite.kind;
    editBody(prUrl, rewrite.repairedBody);
    log("pr.body_normalized", { pr: prUrl, removed_proofs: rewrite.removedProofs, rendered_proofs: rewrite.planProofs });
    return "rewritten";
  } catch (e) {
    log("pr.body_normalize.error", { pr_url: prUrl, error: String((e as Error)?.message ?? e) });
    return "error";
  }
}

function recordBakedClosureCatalog(
  helperHost: Pick<RunTaskHelperHost, "defaultRetroFetchBody" | "defaultRetroEditBody">, prUrl: string,
  files: readonly string[],
  log: (step: string, extra?: Record<string, unknown>) => void,
  deps: Pick<NonNullable<Parameters<RunTaskCommandHost["repairRetroAcceptanceBlock"]>[2]>, "fetchBody" | "editBody"> = {},
): void {
  const { defaultRetroFetchBody, defaultRetroEditBody } = helperHost;
  if (files.length === 0) return;
  try {
    const body = (deps.fetchBody ?? defaultRetroFetchBody)(prUrl);
    const catalog = `Baked-closure catalog: ${[...new Set(files)].sort().map((file) => `\`${file}\``).join(", ")}`;
    if (body.split("\n").includes(catalog)) return;
    const trailer = body.match(/^Remudero-Task: .+$/m)?.[0];
    const prose = body.replace(/^Remudero-Task: .+\n?/gm, "").trimEnd();
    (deps.editBody ?? defaultRetroEditBody)(prUrl, `${prose}\n\n${catalog}${trailer ? `\n\n${trailer}` : ""}`);
    log("pr.body_normalized", { pr: prUrl, site: "baked-closure-catalog", catalog_files: [...files] });
  } catch (error) {
    log("pr.body_normalize.error", { pr_url: prUrl, site: "baked-closure-catalog", catalog_files: [...files], error: String(error) });
  }
}

function refusedBranchChangedFiles(helperHost: Pick<RunTaskHelperHost, "hostWorktreeGitResult">, worktreePath: string): string[] | undefined {
  const { hostWorktreeGitResult } = helperHost;
  const base = hostWorktreeGitResult(worktreePath, ["merge-base", "origin/main", "HEAD"]);
  if (base.status !== 0 || base.stdout.trim() === "") return undefined;
  const diff = hostWorktreeGitResult(worktreePath, ["diff", "--name-only", base.stdout.trim(), "HEAD"]);
  if (diff.status !== 0) return undefined;
  return diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function logCloneReapSurveyAsync(
  helperHost: Pick<RunTaskHelperHost, "cloneReapPlan" | "logCloneReapRow">, config: Config,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: Omit<NonNullable<Parameters<RunTaskCommandHost["logCloneReapSurvey"]>[2]>, "reap"> & { reap?: typeof reapStaleClonesAsync } = {},
): Promise<CloneReapSummary | null> {
  const { cloneReapPlan, logCloneReapRow } = helperHost;
  try {
    const plan = cloneReapPlan(config, log, deps);
    const summary = await (deps.reap ?? reapStaleClonesAsync)(plan.roots, plan.opts);
    return logCloneReapRow(log, summary, plan.roots.length);
  } catch {
    return null; // best-effort, exactly like the sync survey — never blocks the dispatch
  }
}

function logWorktreeReapBootSurvey(
  helperHost: Pick<RunTaskHelperHost, "WORKTREE_REAP_BOOT_CONTRACT_VERSION">, config: Config,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: {
    root?: () => string;
    reap?: typeof reapStaleWorktrees;
    policy?: () => { enabled: boolean };
    isPidAlive?: (pid: number, info: RunLockInfo) => boolean;
    /** W1-T2694: injected ratification pins — same seam shape as `policy` above. */
    ratifications?: Ratifications;
  } = {},
): WorktreeReapSummary | null {
  const { WORKTREE_REAP_BOOT_CONTRACT_VERSION } = helperHost;
  try {
    const readPolicy =
      deps.policy ?? (() => loadPolicy(policyPath(config.root)).values.worktreeReapBoot);
    const policyBlock = readPolicy();
    // W1-T2694 (design (ii)): same "refuse forces dry-run, never widen" direction as
    // {@link logCloneReapSurvey} — this rung can destroy uncommitted worktrees when armed.
    const pins = deps.ratifications ?? loadRatifications(ratificationsPath(config.root));
    const pin = ratificationPinCheck("worktreeReapBoot", policyBlock, WORKTREE_REAP_BOOT_CONTRACT_VERSION, pins);
    if (!pin.fire) log("rung.unratified", { rung: "worktreeReapBoot", diff: pin.diff });
    const enabled = pin.fire && policyBlock.enabled;
    const reap = deps.reap ?? reapStaleWorktrees;
    const root = (deps.root ?? (() => worktreesDir(config)))();
    const summary = reap(root, {
      dryRun: !enabled,
      isPidAlive: deps.isPidAlive ?? worktreeLockIsPidAlive,
    });
    if (summary.reaped.length || summary.reapedLocks.length) {
      log("worktree.reap_boot", {
        dry_run: !enabled,
        reaped: summary.reaped.length,
        reaped_locks: summary.reapedLocks.length,
      });
    }
    // W1-T378's own doctrine, unchanged: an `activity-unknown` keep is the reaper declining to
    // decide, and it is what bounds disk growth now that an ambiguous signal keeps rather than
    // destroys — so it earns its own row exactly as runWorktreeReapRung's does.
    const undecidable = (summary.keptReasons ?? []).filter((k) => k.reason === "activity-unknown");
    if (undecidable.length) {
      log("worktree.reap_boot.undecidable", { kept: undecidable.map((k) => k.name) });
    }
    return summary;
  } catch {
    return null; // best-effort, exactly like the sibling boot sweeps — never blocks the dispatch
  }
}

async function logDiskReclaimRung(
  helperHost: Pick<RunTaskHelperHost, "DISK_RECLAIM_DEFAULT_SWEEPS">, config: Config,
  log: (step: string, fields: Record<string, unknown>) => void,
  deps: {
    sweepTempDirs?: (opts?: TempSweepOpts) => TempSweepSummary | Promise<TempSweepSummary>;
    reapClonesSurvey?: (
      ...a: Parameters<BoundRunTaskHelper<typeof logCloneReapSurveyAsync>>
    ) => CloneReapSummary | null | Promise<CloneReapSummary | null>;
    cloneReapDeps?: Parameters<BoundRunTaskHelper<typeof logCloneReapSurveyAsync>>[2];
    sweepWorkerHomes?: (
      ...a: Parameters<typeof sweepStaleWorkerHomes>
    ) => ReturnType<typeof sweepStaleWorkerHomes> | Promise<ReturnType<typeof sweepStaleWorkerHomes>>;
    workerHomeRoot?: () => string;
    /** W1-T3092: the object reaper. Seams mirror the three sweeps above — appended LAST so no
     *  positional caller shifts. `policy` and `ratifications` follow logWorktreeReapBootSurvey. */
    reapObjects?: (repoDir: string, inflightDir: string, deps: ObjectReapDeps) => ObjectReapResult | Promise<ObjectReapResult>;
    objectRepoDir?: () => string;
    objectInflightDir?: () => string;
    objectPolicy?: () => { enabled: boolean };
    ratifications?: Ratifications;
    /** W1-T4022: the real `lsof`-backed probe (src/lib/clone-reaper.ts) — a test can still inject
     *  its own; production leaves this unset and gets the AWAITED, bounded
     *  {@link defaultOpenFileCountAsync}, never the fail-closed `() => 1` object-reaper.ts falls back
     *  to when NOTHING supplies a counter. */
    objectOpenFileCount?: (dir: string) => number;
    /** W1-T4022: where the consecutive-refusal streak persists across daemon restarts. */
    objectStreakPath?: () => string;
    objectOwnInflightLock?: string;
    /** 2026-10-06: the daemon's own checkout, reaped as a second repo with its own streak. */
    objectDaemonCheckoutDir?: () => string;
  } = {},
): Promise<{
  tempDirsRemoved: number;
  clonesReaped: number;
  cloneBytesReclaimed: number;
  workerHomesRemoved: number;
  objectsPruned: number;
  objectsWouldPrune: number;
}> {
  const { DISK_RECLAIM_DEFAULT_SWEEPS } = helperHost;
  // AWAITED (2026-10-06): every sweep's default is the off-loop twin of the sync sweep it replaced.
  const sweepTempDirs = deps.sweepTempDirs ?? DISK_RECLAIM_DEFAULT_SWEEPS.sweepTempDirs;
  const reapClonesSurvey = deps.reapClonesSurvey ?? DISK_RECLAIM_DEFAULT_SWEEPS.reapClonesSurvey;
  const sweepWorkerHomes = deps.sweepWorkerHomes ?? DISK_RECLAIM_DEFAULT_SWEEPS.sweepWorkerHomes;

  let tempDirsRemoved = 0;
  try {
    tempDirsRemoved = (await sweepTempDirs()).removed.length;
  } catch {
    // best-effort — a throw here must never block the dispatch or the other two sweeps
  }

  let clonesReaped = 0;
  let cloneBytesReclaimed = 0;
  try {
    // Suppressed logger: logCloneReapSurvey already best-effort-catches internally, but an
    // injected `reapClonesSurvey` test double could still throw — belt-and-suspenders so this
    // guard behaves identically to the other two.
    const summary = await reapClonesSurvey(config, () => {}, deps.cloneReapDeps);
    clonesReaped = summary?.reaped.length ?? 0;
    cloneBytesReclaimed = summary?.bytesReclaimed ?? 0;
  } catch {
    // best-effort — a throw here must never block the dispatch or the other two sweeps
  }

  let workerHomesRemoved = 0;
  try {
    const root = (deps.workerHomeRoot ?? (() => workerHomeDir(config)))();
    workerHomesRemoved = (await sweepWorkerHomes(root, { stateRoot: config.root })).removed.length;
  } catch {
    // best-effort — a throw here must never block the dispatch or the other two sweeps
  }

  const objectsPruned = 0;
  const objectsWouldPrune = 0;

  if (tempDirsRemoved || clonesReaped || workerHomesRemoved || objectsPruned || objectsWouldPrune) {
    log("run.disk_reclaim", {
      tmp_dirs_removed: tempDirsRemoved,
      clones_reaped: clonesReaped,
      clone_bytes_reclaimed: cloneBytesReclaimed,
      worker_homes_removed: workerHomesRemoved,
      objects_pruned: objectsPruned,
      // SURVEY ESTIMATE, at survey time — the armed pass runs later against a repo that has moved.
      objects_would_prune: objectsWouldPrune,
    });
  }

  return { tempDirsRemoved, clonesReaped, cloneBytesReclaimed, workerHomesRemoved, objectsPruned, objectsWouldPrune };
}

function logLearningsUsed(
  log: (step: string, extra?: Record<string, unknown>) => void,
  text: string,
  injectedIds: readonly string[],
  usagePath?: string,
): void {
  const parsed = parseLearningsUsed(text, injectedIds);
  const row = parsed
    ? { used_ids: parsed.usedIds, injected_ids: parsed.injectedIds, refused: parsed.refused }
    : { silent: true, injected_ids: [...injectedIds] };
  log("learnings.used", row);
  if (usagePath) recordLearningUsage(usagePath, row);
}

function logSkillsUsed(
  log: (step: string, extra?: Record<string, unknown>) => void,
  text: string,
  injectedNames: readonly string[],
  usagePath?: string,
): void {
  const parsed = parseSkillsUsed(text, injectedNames);
  const row = parsed
    ? { used_names: parsed.usedNames, injected_names: parsed.injectedNames, refused: parsed.refused }
    : { silent: true, injected_names: [...injectedNames] };
  log("skills.used", row);
  if (usagePath) recordSkillUsage(usagePath, row);
}

function fixRungCiFailures(helperHost: Pick<RunTaskHelperHost, "restRollupFor">, owner: string, repo: string): (prUrl: string, sha?: string) => Promise<CiFailure[]> {
  const { restRollupFor } = helperHost;
  return async (prUrl, sha) => {
    if (sha) return fetchCiFailuresAsync(owner, repo, await restRollupFor(owner, repo, sha, ghJsonAsync));
    const v = ghJson(["pr", "view", prUrl, "--json", "statusCheckRollup"]) as { statusCheckRollup?: RollupCheck[] };
    return fetchCiFailuresAsync(owner, repo, v.statusCheckRollup);
  };
}

function cashContainedRunRefusal(
  helperHost: Pick<RunTaskHelperHost, "fixRoundGitOwnership">, config: Config,
  implementCashTools: readonly string[] | undefined,
): string | undefined {
  const { fixRoundGitOwnership } = helperHost;
  const required: Array<{ lane: string; tools: readonly string[] | undefined }> = [
    { lane: "recon", tools: cashDivertSpawnFields("recon").cashTools },
    { lane: "implement", tools: implementCashTools },
    { lane: "diagnose", tools: cashDivertSpawnFields("diagnose").cashTools },
    { lane: "review", tools: cashDivertSpawnFields("review").cashTools },
    { lane: "fix", tools: fixRoundGitOwnership(config).cashTools },
  ];
  for (const requirement of required) {
    const refusal = cashFallbackRefusal(config, requirement.tools);
    if (refusal !== undefined) return `${requirement.lane}: ${refusal}`;
  }
  return undefined;
}

function forceCashContainedRunSpawn(args: SpawnWorkerArgs, config: Config): SpawnWorkerArgs {
  const tools = args.cashTools ?? args.tools;
  const refusal = cashFallbackRefusal(config, tools);
  if (refusal !== undefined) {
    throw new Error(`cash-contained run refuses a worker without a cash-equivalent surface: ${refusal}`);
  }
  return {
    ...args,
    mountProvider: "cash",
    ...(tools === undefined ? {} : { tools: [...tools] }),
  };
}

function headProvenanceFields(worktreePath: string): { head_sha?: string; head_assignment?: string } {
  let headSha: string;
  try {
    headSha = hostWorktreeGit(worktreePath, ["rev-parse", "--verify", "HEAD"]).trim();
  } catch {
    // No head to name: the row omits both fields rather than inventing a sha.
    return {};
  }
  return { head_sha: headSha, head_assignment: resolveCommitAssignment(worktreePath, headSha) };
}

function createHarnessCommitRefusalRecorder(state: { reason?: string }): (reason: string) => void {
  return (reason) => {
    state.reason = reason;
  };
}

async function resumeForMissingCommitLine(
  helperHost: Pick<RunTaskHelperHost, "MISSING_COMMIT_MESSAGE_REASON" | "harnessCommitForShellLessWorker" | "worktreeHasUncommittedChanges">, input: {
    commitCount: number;
    refusalReason: string | undefined;
    report: string;
    task?: Pick<Task, "id" | "title" | "type">;
    worktreePath: string;
    declaredPaths: readonly string[];
    acceptance?: readonly AcceptanceCriterion[];
    /** W1-T4614: the ORIGINAL worker's assignment — it did the edits; the resume only supplies the line. */
    assignmentId?: string;
    log: (step: string, extra?: Record<string, unknown>) => void;
    say: (msg: string) => void;
    onCommit?: Parameters<RunTaskCommandHost["harnessCommitForShellLessWorker"]>[0]["onCommit"];
    /** Resume the worker's OWN session once with the ask-for-the-line prompt. A required
     *  collaborator the implement lane wires, like `log`/`say` — not an optional seam. */
    resume: () => Promise<{
      text: string;
      costUsd?: number;
      sessionId?: string;
      numTurns?: number;
      subtype?: string;
    }>;
  },
  // The SAME seam `harnessCommitForShellLessWorker` takes, forwarded to it unchanged: the retried
  // commit is that helper's, so its `commit`/`ahead` fakes are the only seams this recovery needs.
  deps: Parameters<RunTaskCommandHost["harnessCommitForShellLessWorker"]>[1] = {},
): Promise<{ commitCount: number; refusalReason: string | undefined; report: string; resumed: boolean }> {
  const { MISSING_COMMIT_MESSAGE_REASON, harnessCommitForShellLessWorker, worktreeHasUncommittedChanges } = helperHost;
  const noop = {
    commitCount: input.commitCount,
    refusalReason: input.refusalReason,
    report: input.report,
    resumed: false as const,
  };
  if (input.refusalReason !== MISSING_COMMIT_MESSAGE_REASON || input.commitCount !== 0) return noop;
  if (!worktreeHasUncommittedChanges(input.worktreePath)) return noop;

  input.log("implement.commit_line_requested", {});
  input.say("no COMMIT_MESSAGE line in the report — resuming the worker's session once to ask for it");
  const resumed = await input.resume();
  input.log("implement.resumed", {
    ...(resumed.sessionId ? { session_id: resumed.sessionId } : {}),
    cost_usd: resumed.costUsd,
    ...(resumed.numTurns !== undefined ? { num_turns: resumed.numTurns } : {}),
    ...(resumed.subtype !== undefined ? { subtype: resumed.subtype } : {}),
    reason: "missing_commit_line",
  });

  // APPENDED, never replacing the original report — the original REPORT content (follow-ups,
  // learnings-used, the worker's own narrative) survives; only the anchored COMMIT_MESSAGE line
  // the resumed reply carries is new, and `parseReport`'s own "last one wins" rule picks it up.
  const combinedReport = `${input.report}\n${resumed.text}`;
  const derivedCommit = parseReport(combinedReport)?.commitMessage === undefined && input.task
    ? derivedImplementCommit(input.task, input.declaredPaths)
    : undefined;
  if (parseReport(combinedReport)?.commitMessage === undefined && derivedCommit === undefined) {
    const reason = `${MISSING_COMMIT_MESSAGE_REASON} (asked the worker's own session once; still absent)`;
    input.log("implement.harness_commit_refused", { reason });
    return { commitCount: input.commitCount, refusalReason: reason, report: combinedReport, resumed: true };
  }

  const refusalState: { reason?: string } = {};
  const commitCount = harnessCommitForShellLessWorker(
    {
      harnessOwnsGit: true,
      commitCount: input.commitCount,
      report: combinedReport,
      worktreePath: input.worktreePath,
      declaredPaths: input.declaredPaths,
      acceptance: input.acceptance,
      subjectSource: derivedCommit ? "harness-derived" : "re-asked",
      derivedCommit,
      assignmentId: input.assignmentId,
      log: input.log,
      say: input.say,
      onRefusal: createHarnessCommitRefusalRecorder(refusalState),
      onCommit: input.onCommit,
    },
    deps,
  );
  return { commitCount, refusalReason: refusalState.reason, report: combinedReport, resumed: true };
}

function requiredCompanions(
  sha: string,
  leftOut: readonly string[],
  git: (args: string[]) => string,
): RequiredCompanion[] {
  if (leftOut.length === 0) return [];
  const paths = (args: string[]) => git(args).split("\0").filter(Boolean);
  const committed = paths(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--diff-filter=d", sha])
    .filter((path) => /\.(?:ts|mts|mjs|js|cjs)$/.test(path));
  const files = new Map(committed.map((path) => [path, git(["show", `${sha}:${path}`])]));
  const { directImports } = buildAffectedSuitesGraph(files, [...paths(["ls-tree", "-r", "--name-only", "-z", sha]), ...leftOut]);
  const left = new Set(leftOut);
  const importers = new Map<string, string[]>();
  for (const [file, deps] of directImports) {
    for (const dep of deps) if (left.has(dep)) importers.set(dep, [...(importers.get(dep) ?? []), file]);
  }
  return [...importers].sort(([a], [b]) => a.localeCompare(b)).map(([path, by]) => ({ path, importers: by.sort() }));
}

async function readBuildScopeAmendmentState(
  url: string, fetch: (args: string[]) => Promise<unknown> = ghJsonAsync,
): Promise<"open" | "merged" | "closed"> {
  const pr = await fetch(["pr", "view", url, "--json", "state,mergedAt"]) as { state?: string; mergedAt?: string };
  if (pr.mergedAt || pr.state === "MERGED") return "merged";
  if (pr.state === "OPEN") return "open";
  if (pr.state === "CLOSED") return "closed";
  throw new Error("scope amendment state is unreadable");
}

async function askScopeForLeftOutImports(input: {
  taskId: string;
  branch: string;
  commit: { sha: string; undeclared: readonly string[] } | undefined;
  git: (args: string[]) => string;
  amend: (request: ScopeAmendmentRequest) => ScopeAmendmentOutcome | Promise<ScopeAmendmentOutcome>;
  log: (step: string, extra?: Record<string, unknown>) => void;
}): Promise<{ companions: RequiredCompanion[]; amendment: ScopeAmendmentOutcome } | undefined> {
  if (!input.commit) return undefined;
  const { sha, undeclared } = input.commit;
  const companions = requiredCompanions(sha, undeclared, input.git);
  if (companions.length === 0) return undefined;
  const paths = companions.map((c) => c.path);
  const importers = Object.fromEntries(companions.map((c) => [c.path, c.importers]));
  input.log("implement.scope_needed", { task_id: input.taskId, paths, importers, head_sha: sha });
  let amendment: ScopeAmendmentOutcome;
  try {
    amendment = await input.amend({ taskId: input.taskId, kind: "build", importers: [...new Set(companions.flatMap((c) => c.importers))], prNumber: 0, prUrl: "", headSha: sha, headRef: input.branch,
      paths, changedPaths: [...undeclared, ...companions.flatMap((c) => c.importers)] });
  } catch (error) {
    amendment = { kind: "refused", reason: "scope-amendment-error", detail: String(error) };
  }
  input.log("implement.scope_amendment", { ...amendment, outcome: amendment.kind, task_id: input.taskId, paths, head_sha: sha });
  return { companions, amendment };
}

function derivedImplementCommit(task: Pick<Task, "id" | "title" | "type">, paths: readonly string[]): { subject: string; reason: string } | undefined {
  if (task.type !== "implement" || !task.title.trim() || !paths[0]) return undefined;
  const parts = paths[0].split("/");
  const area = (parts.length > 1 ? parts[parts.length - 2] : parts[0].replace(/\.[^.]+$/, ""))
    .toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!area || area.length > 60) return undefined;
  const clause = task.title.split(/\s+[—–-]\s+|[;:.!?]\s+/)[0].trim().toLowerCase().replace(/\s+/g, " ");
  const prefix = `feat(${area}): `;
  const subject = prefix + Array.from(clause).slice(0, 100 - prefix.length).join("").trimEnd().replace(/[^\p{L}\p{N}]$/u, "");
  if (subject === prefix) return undefined;
  return { subject, reason: `no COMMIT_MESSAGE after one re-ask; ${task.id} title and ${paths[0]}` };
}

function commitLineResume(
  helperHost: Pick<RunTaskHelperHost, "COMMIT_LINE_RESUME_PROMPT" | "missingCommitLinePrompt">, spawn: typeof spawnWorker,
  account: (r: WorkerResult) => WorkerResult,
  spawnArgs: Omit<SpawnWorkerArgs, "prompt">,
  context?: { provider?: WorkerResult["provider"]; title: string; report: string; declaredPaths?: readonly string[] },
): () => Promise<{ text: string; costUsd: number; sessionId: string; numTurns: number; subtype: string }> {
  const { COMMIT_LINE_RESUME_PROMPT, missingCommitLinePrompt } = helperHost;
  return async () => {
    const prompt = context ? missingCommitLinePrompt({ ...context, tools: spawnArgs.tools, worktreePath: spawnArgs.cwd }) : COMMIT_LINE_RESUME_PROMPT;
    const resumed = account(await spawn({ ...spawnArgs, prompt }));
    return {
      text: workerTranscript(resumed),
      costUsd: resumed.costUsd,
      sessionId: resumed.sessionId,
      numTurns: resumed.numTurns,
      subtype: resumed.subtype,
    };
  };
}

export function runTaskCommandHelpers(host: RunTaskCommandHost) {
  const helperHost: RunTaskHelperHost = {
    BRANCH_NAME_CONTRACT_PART: host.BRANCH_NAME_CONTRACT_PART,
    syncPlanOrRefuse: host.syncPlanOrRefuse,
    lintPlanForReview: host.lintPlanForReview,
    proofRepairRoundRefusalInWorktree: host.proofRepairRoundRefusalInWorktree,
    startShellLessMergeConflictMerge: host.startShellLessMergeConflictMerge,
    terminalVerdictFields: host.terminalVerdictFields,
    renderReconClaimLines: host.renderReconClaimLines,
    CENSUS_BASELINE_FILES: host.CENSUS_BASELINE_FILES,
    workerBoundaryStack: host.workerBoundaryStack,
    buildBaseReproductionProbe: host.buildBaseReproductionProbe,
    writeSyncLine: host.writeSyncLine,
    WORKER_STATE_LEDGER_STEP: host.WORKER_STATE_LEDGER_STEP,
    capWorkerTailLines: host.capWorkerTailLines,
    writeWorkerTailBestEffort: host.writeWorkerTailBestEffort,
    attributeWorkerStreamEvent: host.attributeWorkerStreamEvent,
    quietBoundHistory: host.quietBoundHistory,
    readWorktreeHeadReflog: host.readWorktreeHeadReflog,
    workerCreatedCurrentHead: host.workerCreatedCurrentHead,
    syncPlanOrRefuseAsync: host.syncPlanOrRefuseAsync,
    isTerminalRed: host.isTerminalRed,
    ghPrCreateFillCommand: host.ghPrCreateFillCommand,
    withDiagnostics: host.withDiagnostics,
    draftPrCreate: host.draftPrCreate,
    prCreateArgv: host.prCreateArgv,
    runGhPrCreate: host.runGhPrCreate,
    lastCommitSubject: host.lastCommitSubject,
    appendTaskTrailerToCommit: host.appendTaskTrailerToCommit,
    fetchPrBodyViaGh: host.fetchPrBodyViaGh,
    fetchPrDiffFilesViaGh: host.fetchPrDiffFilesViaGh,
    changeView: host.changeView,
    rewriteAcceptanceBlockFromPlan: host.rewriteAcceptanceBlockFromPlan,
    execGrepProofInWorktree: host.execGrepProofInWorktree,
    ensureTaskTrailer: host.ensureTaskTrailer,
    ghPrHeadGateway: host.ghPrHeadGateway,
    checkPrOwnership: host.checkPrOwnership,
    scrubGitCredentialText: host.scrubGitCredentialText,
    openTaskIdsFromPlan: host.openTaskIdsFromPlan,
    yieldingSleep: host.yieldingSleep,
    restRollupFor: host.restRollupFor,
    pollRestTarget: host.pollRestTarget,
    ciGateState: host.ciGateState,
    STALL_WINDOW: host.STALL_WINDOW,
    checkWaitStalled: host.checkWaitStalled,
    waitForCiGreen: host.waitForCiGreen,
    runReview: host.runReview,
    ghLiveState: host.ghLiveState,
    ghLiveHead: host.ghLiveHead,
    captureWorktreeSnapshotViaGit: host.captureWorktreeSnapshotViaGit,
    ghUpdateBranch: host.ghUpdateBranch,
    redBaseRefreshFactsFromRest: host.redBaseRefreshFactsFromRest,
    fixRebaseMergeFactsFromRest: host.fixRebaseMergeFactsFromRest,
    reclaimAbandonedWorker: host.reclaimAbandonedWorker,
    fixWorkerRunId: host.fixWorkerRunId,
    fixWorkerReceipt: host.fixWorkerReceipt,
    spawnFixWorkerBounded: host.spawnFixWorkerBounded,
    readFixRoundCommitsViaGit: host.readFixRoundCommitsViaGit,
    runNpmScriptViaSpawn: host.runNpmScriptViaSpawn,
    commitGeneratorOutputViaGit: host.commitGeneratorOutputViaGit,
    readPackageScriptsFor: host.readPackageScriptsFor,
    runFixRung: host.runFixRung,
    buildProofAmendmentGitOps: host.buildProofAmendmentGitOps,
    buildProofAmendmentWritePorts: host.buildProofAmendmentWritePorts,
    prNumberFromRef: host.prNumberFromRef,
    workerSignal: host.workerSignal,
    harvestFollowupsFromReport: host.harvestFollowupsFromReport,
    commitsAhead: host.commitsAhead,
    sha256Hex: host.sha256Hex,
    readRuleSourceFileOrUndefined: host.readRuleSourceFileOrUndefined,
    DEFAULT_BUDGET_USD: host.DEFAULT_BUDGET_USD,
    archiveWorkerTranscript: host.archiveWorkerTranscript,
    withPredecessorTranscriptCopies: host.withPredecessorTranscriptCopies,
    benchmarkRunLedgerLogger: host.benchmarkRunLedgerLogger,
    recordBenchmarkWorkerAttempt: host.recordBenchmarkWorkerAttempt,
    dispatchFallbackObserver: host.dispatchFallbackObserver,
    withGitCredentialSocket: host.withGitCredentialSocket,
    runErrorCause: host.runErrorCause,
    censusPushRefusal: host.censusPushRefusal,
    CENSUS_PUSH_CHECK: host.CENSUS_PUSH_CHECK,
    CENSUS_SNAPSHOT_ENV: host.CENSUS_SNAPSHOT_ENV,
    COVERAGE_PUSH_CHECK: host.COVERAGE_PUSH_CHECK,
    CENSUS_PUSH_NEVER_BYPASS: host.CENSUS_PUSH_NEVER_BYPASS,
    fixCensusAppliesToRepo: host.fixCensusAppliesToRepo,
    writeFixCensusSnapshot: host.writeFixCensusSnapshot,
    writeFixCensusSnapshotAsync: host.writeFixCensusSnapshotAsync,
    checkFixCensusSnapshotAsync: host.checkFixCensusSnapshotAsync,
    FixRoundPushError: host.FixRoundPushError,
    pushFixRound: host.pushFixRound,
    coveragePrecheck: host.coveragePrecheck,
    coveragePushRefusal: host.coveragePushRefusal,
    pushFixRoundPrechecked: host.pushFixRoundPrechecked,
    repairRetroAcceptanceBlock: host.repairRetroAcceptanceBlock,
    defaultRetroFetchBody: host.defaultRetroFetchBody,
    defaultRetroEditBody: host.defaultRetroEditBody,
    prUrlTarget: host.prUrlTarget,
    readHeadShaRest: host.readHeadShaRest,
    resolveFixRungTaskContractAtHeadAsync: host.resolveFixRungTaskContractAtHeadAsync,
    MERGE_BASE_DIFF_ARGS: host.MERGE_BASE_DIFF_ARGS,
    hostWorktreeGitResult: host.hostWorktreeGitResult,
    dispatchClaimReserverAsyncFor: host.dispatchClaimReserverAsyncFor,
    WORKTREE_REAP_BOOT_CONTRACT_VERSION: host.WORKTREE_REAP_BOOT_CONTRACT_VERSION,
    logCloneReapSurvey: host.logCloneReapSurvey,
    cloneReapPlan: host.cloneReapPlan,
    logCloneReapRow: host.logCloneReapRow,
    DISK_RECLAIM_DEFAULT_SWEEPS: host.DISK_RECLAIM_DEFAULT_SWEEPS,
    createDaemonGatewayFactory: host.createDaemonGatewayFactory,
    readRegistrationChanges: host.readRegistrationChanges,
    commitWorkerEdits: host.commitWorkerEdits,
    fixRoundGitOwnership: host.fixRoundGitOwnership,
    MISSING_COMMIT_MESSAGE_REASON: host.MISSING_COMMIT_MESSAGE_REASON,
    harnessCommitForShellLessWorker: host.harnessCommitForShellLessWorker,
    worktreeHasUncommittedChanges: host.worktreeHasUncommittedChanges,
    COMMIT_LINE_RESUME_PROMPT: host.COMMIT_LINE_RESUME_PROMPT,
    writerCannotResume: host.writerCannotResume,
    missingCommitLinePrompt: host.missingCommitLinePrompt,
    pathIsUnderDeclaredSurface: host.pathIsUnderDeclaredSurface,
    execFilePromise: host.execFilePromise,
    AWAITING_EXTERNAL_LEDGER_STEP: host.AWAITING_EXTERNAL_LEDGER_STEP,
    readLedgerRawLines: host.readLedgerRawLines,
  };
  return {
    defaultBinaryPinDeps: defaultBinaryPinDeps.bind(undefined),
    deriveRunawayTurnBound: deriveRunawayTurnBound.bind(undefined),
    dispatchStreamObserver: dispatchStreamObserver.bind(undefined, helperHost),
    watchDispatchSpawn: watchDispatchSpawn.bind(undefined, helperHost),
    checkpointUndeclaredFields: checkpointUndeclaredFields.bind(undefined),
    commitAndPushRestartCheckpoint: commitAndPushRestartCheckpoint.bind(undefined, helperHost),
    pushRestartCheckpoint: pushRestartCheckpoint.bind(undefined),
    freshnessYieldRows: freshnessYieldRows.bind(undefined),
    roundEndedHandoffRows: roundEndedHandoffRows.bind(undefined),
    boundedWorkerTelemetryText: boundedWorkerTelemetryText.bind(undefined),
    buildWorkerStateSensor: buildWorkerStateSensor.bind(undefined, helperHost),
    resolveOwner: resolveOwner.bind(undefined),
    shadowLiveWouldHaveDone: shadowLiveWouldHaveDone.bind(undefined),
    resolveShadowInstanceArmPermission: resolveShadowInstanceArmPermission.bind(undefined),
    ghPrCreateFillCommandAsync: ghPrCreateFillCommandAsync.bind(undefined, helperHost),
    worktreeHeadOrUndefined: worktreeHeadOrUndefined.bind(undefined),
    worktreeDiffStat: worktreeDiffStat.bind(undefined),
    branchPrTitle: branchPrTitle.bind(undefined, helperHost),
    restoreBoundaryCheckpoint: restoreBoundaryCheckpoint.bind(undefined),
    diffFileChangesFromPatch: diffFileChangesFromPatch.bind(undefined),
    diffIsClassifiedIrreversible: diffIsClassifiedIrreversible.bind(undefined),
    irreversibleSignalForWorktree: irreversibleSignalForWorktree.bind(undefined),
    armRunIdFromLedger: armRunIdFromLedger.bind(undefined),
    mergeShaNow: mergeShaNow.bind(undefined, helperHost),
    lostRaceEscalation: lostRaceEscalation.bind(undefined),
    riskJudgeDisarm: riskJudgeDisarm.bind(undefined, helperHost),
    disposeDisarm: disposeDisarm.bind(undefined, helperHost),
    fallbackPushEvidence: fallbackPushEvidence.bind(undefined, helperHost),
    fallbackPushCause: fallbackPushCause.bind(undefined, helperHost),
    rollupCheckSummary: rollupCheckSummary.bind(undefined),
    prOpenHandoffDecline: prOpenHandoffDecline.bind(undefined),
    pollToGate: pollToGate.bind(undefined, helperHost),
    ciGateBlockReason: ciGateBlockReason.bind(undefined, helperHost),
    fixRungTerminationVerdict: fixRungTerminationVerdict.bind(undefined),
    workerErrorVerdict: workerErrorVerdict.bind(undefined),
    noPrVerdict: noPrVerdict.bind(undefined),
    parseAlreadySatisfied: parseAlreadySatisfied.bind(undefined),
    resolveAlreadySatisfied: resolveAlreadySatisfied.bind(undefined, helperHost),
    resolveAlreadySatisfiedWithRetry: resolveAlreadySatisfiedWithRetry.bind(undefined, helperHost),
    alreadySatisfiedVerdict: alreadySatisfiedVerdict.bind(undefined),
    implementAttemptOutcome: implementAttemptOutcome.bind(undefined, helperHost),
    finishTransientRetry: finishTransientRetry.bind(undefined, helperHost),
    workerVisibleRecordPath: workerVisibleRecordPath.bind(undefined),
    taskRecordContextLine: taskRecordContextLine.bind(undefined),
    nonEmptyLines: nonEmptyLines.bind(undefined),
    reconObservedToContext: reconObservedToContext.bind(undefined, helperHost),
    reconDegradedContextNote: reconDegradedContextNote.bind(undefined),
    reconMaskedContextNote: reconMaskedContextNote.bind(undefined),
    fileDigestOrAbsent: fileDigestOrAbsent.bind(undefined, helperHost),
    filesDigest: filesDigest.bind(undefined, helperHost),
    taskRecordSha: taskRecordSha.bind(undefined, helperHost),
    decideReconArtifactReuse: decideReconArtifactReuse.bind(undefined),
    reconArtifactPath: reconArtifactPath.bind(undefined),
    loadReconArtifact: loadReconArtifact.bind(undefined),
    writeReconArtifact: writeReconArtifact.bind(undefined),
    reconArtifactToContext: reconArtifactToContext.bind(undefined, helperHost),
    buildRuleHeadlinesPart: buildRuleHeadlinesPart.bind(undefined, helperHost),
    softBudgetWarning: softBudgetWarning.bind(undefined),
    resolveRunMounts: resolveRunMounts.bind(undefined),
    probeVerdictKey: probeVerdictKey.bind(undefined),
    hookFilesUnder: hookFilesUnder.bind(undefined),
    readProbeKeyInputs: readProbeKeyInputs.bind(undefined),
    reportWorkerSourceSizeFollowup: reportWorkerSourceSizeFollowup.bind(undefined),
    isManagedCheckoutLockBusy: isManagedCheckoutLockBusy.bind(undefined),
    refreshManagedCheckout: refreshManagedCheckout.bind(undefined, helperHost),
    refreshHeldManagedCheckout: refreshHeldManagedCheckout.bind(undefined),
    sourceSizeGateFollowupConsumer: sourceSizeGateFollowupConsumer.bind(undefined),
    buildSourceSizeGatePostureRuntime: buildSourceSizeGatePostureRuntime.bind(undefined),
    sourceSizeFollowupDebtResult: sourceSizeFollowupDebtResult.bind(undefined),
    reportWorkerSourceSizeFollowupWithGatePosture: reportWorkerSourceSizeFollowupWithGatePosture.bind(undefined),
    withInflightRunLock: withInflightRunLock.bind(undefined),
    endThrownRun: endThrownRun.bind(undefined, helperHost),
    deferOpenToSiblingPr: deferOpenToSiblingPr.bind(undefined, helperHost),
    reclaimRunWorktree: reclaimRunWorktree.bind(undefined),
    endRefusedRun: endRefusedRun.bind(undefined, helperHost),
    endRunOnce: endRunOnce.bind(undefined, helperHost),
    boundedVerdictReason: boundedVerdictReason.bind(undefined, helperHost),
    repairCensusRefusedPush: repairCensusRefusedPush.bind(undefined, helperHost),
    normalizeRunPrAcceptanceFromPlan: normalizeRunPrAcceptanceFromPlan.bind(undefined, helperHost),
    recordBakedClosureCatalog: recordBakedClosureCatalog.bind(undefined, helperHost),
    refusedBranchChangedFiles: refusedBranchChangedFiles.bind(undefined, helperHost),
    logCloneReapSurveyAsync: logCloneReapSurveyAsync.bind(undefined, helperHost),
    logWorktreeReapBootSurvey: logWorktreeReapBootSurvey.bind(undefined, helperHost),
    logDiskReclaimRung: logDiskReclaimRung.bind(undefined, helperHost),
    logLearningsUsed: logLearningsUsed.bind(undefined),
    logSkillsUsed: logSkillsUsed.bind(undefined),
    fixRungCiFailures: fixRungCiFailures.bind(undefined, helperHost),
    cashContainedRunRefusal: cashContainedRunRefusal.bind(undefined, helperHost),
    forceCashContainedRunSpawn: forceCashContainedRunSpawn.bind(undefined),
    headProvenanceFields: headProvenanceFields.bind(undefined),
    createHarnessCommitRefusalRecorder: createHarnessCommitRefusalRecorder.bind(undefined),
    resumeForMissingCommitLine: resumeForMissingCommitLine.bind(undefined, helperHost),
    requiredCompanions: requiredCompanions.bind(undefined),
    readBuildScopeAmendmentState: readBuildScopeAmendmentState.bind(undefined),
    askScopeForLeftOutImports: askScopeForLeftOutImports.bind(undefined),
    derivedImplementCommit: derivedImplementCommit.bind(undefined),
    commitLineResume: commitLineResume.bind(undefined, helperHost),
  };
}

export type RunTaskCommandHelpers = ReturnType<typeof runTaskCommandHelpers>;

export async function runTask(
  taskId: string,
  opts: ProbeAdmissionOptions & {
    planPath?: string;
    config?: Config;
    /** W1-T7096: the drain and the CLI ask the production LLM progress judge in the fix rung. */
    productionProgressJudge?: boolean;
    preopenGate?: RunTaskBodyOptions["preopenGate"];
    /** Frozen at the executing module boundary by default; trial runners may supply pinned artifacts. */
    benchmarkStackEvidence?: BenchmarkStackEvidence;
    allowStale?: boolean;
    /** Explicit `--plan <path>` escape hatch (daemon only): read that file LITERALLY, no git
     *  sync — the operator named an exact file, so honor it verbatim, same as the sibling
     *  guard around the daemon's own non-self clone-sync (`!flagValue(rest, "--plan")`). */
    skipGitSync?: boolean;
    /**
     * W1-T2513 — coalescing seam for the multi-lane dispatch path: threaded straight through
     * to {@link syncPlanOrRefuse}'s identical param (see that function's and
     * {@link createPlanSyncCoalescer}'s own docs for the full contract). `drainCommand` and
     * `daemonCommand` build ONE coalescer per invocation and pass its `sync` method here for
     * every lane's `runTask` call, so the three lanes of one tick share a single origin fetch
     * and a single plan parse instead of paying for it three times. Omitted — every other
     * caller (`rmd run-task`, `rmd wipe-test`, every existing test) — `runTask` fetches and
     * loads for itself exactly as it always has.
     */
    planSnapshot?: (o: { allowStale?: boolean }) => SyncedPlan | Promise<SyncedPlan>;
    /** A run child's collection at each agent wait, ledgered as {@link RUN_AGENT_WAIT_HEAP_STEP}; absent in-process. */
    atAgentWait?: () => Promise<AgentWaitHeap>;
    /** W1-T319 (fb-1784773321502-86793d): the deliberate override for the ALREADY-MERGED
     *  by-id refusal below — modelled on `allowStale` above. With it unset (the default), a
     *  task the projection already reports merged refuses at zero cost, verdict
     *  `task_already_merged`; set, the dispatch proceeds EXACTLY as it did before this guard
     *  existed. Always ledgered (`dispatch.rerun_override`) so a deliberate re-run is never
     *  indistinguishable from a guard that failed to fire. */
    rerun?: boolean;
    /** Injectable worker-spawn — behavioral tests (W1-T20c criterion 5) count calls to prove
     *  a linter-failing task NEVER reaches a spawn. Default: the real {@link spawnWorker}. */
    spawn?: typeof spawnWorker;
    /** Injectable GitHub gateway for the status projection — lets a behavioral test drive the
     *  dispatch path without a network round-trip. Default: the real {@link ghGateway}. */
    github?: GitHub;
    /**
     * W1-T2509 — A GATEWAY *FACTORY* THE CALLER MAY MEMOISE, so N concurrent lanes pay ONE cold
     * walk instead of N. `buildBatchedGithub` holds `knownBoardPrs` at GATEWAY scope, so a gateway
     * built per lane always starts `undefined`, takes `mode: "full"`, and walks the whole repo
     * again — the identical constructor-lifetime defect `buildInboxDraftHook`'s own doc measured
     * for the board rungs (5,022 `mode: "full"` at a mean of 9.74 REST calls against a warm
     * gateway's steady-state 2). `runOne` never received that fix, so each dispatch lane paid a
     * full walk SYNCHRONOUSLY before yielding, and `Promise.allSettled(admitted.map(runOne))` could
     * not enter lane 2 until lane 1 finished it.
     *
     * A FACTORY, NOT AN INSTANCE, BECAUSE THE KEY IS `(owner, task.repo)` AND NOT THE DRAIN TARGET:
     * a task carrying a different `repo:` than the drain's must not be answered by the target's
     * gateway. The caller memoises per owner/repo; this seam only lets it.
     *
     * `github` above still wins when both are supplied — no existing test caller changes shape.
     */
    githubFor?: (owner: string, repo: string) => GitHub;
    /** W1-T86 (P12 wipe-test harness): arm B of a LEARNINGS-factor `rmd wipe-test` pair —
     *  MASK learnings injection for this run. Forces the rendered prompt's matched-learnings
     *  text to "" WITHOUT reading the store (see {@link computeMatchedLearningsForArm}); never
     *  set by any caller other than `wipeTestCommand`. */
    maskLearnings?: boolean;
    /** W1-T2512 (P12 wipe-test harness, RECON factor): arm B of a RECON-factor `rmd wipe-test`
     *  pair — skip the recon spawn ENTIRELY for this run. The recon artifact store
     *  (`loadReconArtifact`/`writeReconArtifact`) is neither read nor written — masked, not
     *  deleted, the same discipline `maskLearnings` keeps for the learnings store — and
     *  implement proceeds with an explicit "recon masked" context note (never a silently empty
     *  CONTEXT block; see {@link reconMaskedContextNote}) instead of whatever recon would have
     *  observed. Never set by any caller other than `wipeTestCommand`. */
    maskRecon?: boolean;
    /** W1-T2761 (P12 wipe-test harness, RULES factor): arm B of a RULES-factor `rmd wipe-test`
     *  pair — force the `rule_headlines` prompt part to `""` for this run REGARDLESS of the
     *  `workerRuleHeadlines.enabled` policy row, masking the part and nothing else
     *  ({@link wipeTestFactorMasksRules}, wipe-test.ts). Never set by any caller other than
     *  `wipeTestCommand`. */
    maskRules?: boolean;
    /** Injectable override for the `workerRuleHeadlines.enabled` policy gate (design (i)) — the
     *  SAME `?? loadDefaultPolicy()` seam every other opts-defaulted policy knob in this file
     *  uses, so a test can drive the `rule_headlines` prompt part on/off without a real
     *  `plan/policy.yaml` row. Default: `loadDefaultPolicy().values.workerRuleHeadlines.enabled`
     *  (absent/off unless an operator commits the row). */
    workerRuleHeadlinesEnabled?: boolean;
    /** Injectable containment-probe executor (W1-T91) — behavioral tests drive the REAL
     *  blocked_containment catch branch (the structured guard/check/observed fields on its
     *  ledger verdict line) through this seam, the SAME shape `defaultReconRunLens`'s own
     *  `deps.probeExec` already uses, without touching `loadConfig()` (unavailable in CI) or
     *  spawning a real sandboxed worker. Default: the real spawn-backed executor. */
    containmentExec?: ProbeExecutor;
    externalWaitFreshness?: ExternalWaitFreshness;
    externalWaitRecycle?: () => string | undefined;
    /** W1-T5345: hand the PR to the sweep at the first CI poll ({@link PollDeps.handOffAtPrOpen}). Daemon only. */
    handOffAtPrOpen?: boolean;
    /** Injectable isolation-probe executor (W1-T91) — the isolation sibling of
     *  `containmentExec` above, driving the REAL blocked_isolation catch branch. Default: the
     *  real spawn-backed executor. */
    isolationExec?: IsolationProbeExecutor;
    /** Injectable cash boundary proof. Default executes the production bubblewrap-backed proof;
     * behavioral tests use this only to drive the capacity-recovery terminal paths. */
    cashContainmentBoundary?: typeof assertOpenWeightToolBoundary;
    /** Injectable reads for the BINARY-PIN rung. Default: {@link defaultBinaryPinDeps} over the
     *  resolved `config.claudeBin` — a test drives a chosen version pair through this seam without
     *  a real binary, and test/binary-pin-rung.test.ts separately exercises the DEFAULT for real. */
    binaryPinDeps?: Parameters<typeof readBinaryPin>[0];
    /** Injectable review judge for the PRIMARY (post-CI-green) review call — the same
     *  shape `runFixRung`'s own `deps.runReview` already exposes. Default: the real
     *  {@link runReview}. W1-T125: lets a behavioral test drive a REAL runTask() through
     *  the capped-refusal branch (and its `disarmAutoMerge` call, right before escalating)
     *  without a live reviewer spawn — `runReview` itself hard-codes `spawnWorker` (never
     *  this file's injectable `spawn` param), so a genuine CAPPED verdict from a real
     *  reviewer round-trip cannot be produced deterministically in a test. */
    runReview?: (args: Parameters<RunTaskCommandHost["runReview"]>[0]) => ReturnType<RunTaskCommandHost["runReview"]>;
    /**
     * Read THIS PR's current body, so the review judges the artefact the author is told is judged.
     * Appended LAST so no positional caller shifts. Injected only by tests; in production it
     * DEFAULTS to {@link fetchPrBodyViaGh}. Best-effort — a throwing fetcher falls back to the
     * worker-text report, i.e. exactly the pre-fix behaviour.
     */
    fetchPrBody?: (prUrl: string) => Promise<string>;
    /** Fresh REST read for the exact-head producer claim; injectable for offline runTask tests. */
    readHeadShaForProvenance?: (prUrl: string) => string;
    /** Injectable decision-record writer+lander (W1-T191, write site 1) — lets a behavioral
     *  test drive a REAL runTask() through the DECISION_REQUEST auto-choose branch and assert
     *  exactly what it writes/lands, without ever shelling out to a real git/gh. Default: the
     *  real {@link recordDecision} (feedback-landing.js), which writes
     *  `plan/decisions.d/<taskId>-<runId>.md` and lands it via the shared decisions-landing
     *  bridge — the same mechanism W1-T243 proved for `plan/feedback/**`. */
    recordDecision?: typeof recordDecision;
    /** W1-T1045: override the resolved clock bound (ms) — the SAME injection convention as
     *  every other opt-in seam above. Default: `policy.values.workerAbandon`, read below. */
    workerAbandonMs?: number;
    /** W1-T7807: override the quiet-worker watchdog's no-history fallback bound (ms). Default: `policy.values.workerStall`. */
    workerStallMs?: number;
    /** W1-T2847: overrides `plan/policy.yaml`'s `sweep.armAdhocLaneReap` for the ad-hoc lane reap
     *  rung — the same `?? loadDefaultPolicy()` seam `workerAbandonMs` above uses, so a test can
     *  drive both arms without editing the shipped policy file. */
    armAdhocLaneReap?: boolean;
    /** W1-T4797: test seam for the pre-push diff-coverage precheck; production reads the real ones. */
    coveragePrecheckPorts?: CoveragePrecheckPorts;
    /**
     * W1-T1044: override for the fix rung's worker-spawn wall-clock bound (see
     * `runFixRung`'s own `deps.spawnWallClockBoundMs` doc). Optional — omitted reads
     * `plan/policy.yaml`'s `fixSpawnWallClockBoundMs` row (`loadDefaultPolicy`) — W1-T1219 split
     * this OFF `sweepWallClockBoundMs`, so retuning the sweep tick's bound no longer moves this
     * one — the SAME `?? loadDefaultPolicy()` injection seam `test/config-reader-seams.test.ts`
     * requires every unredirectable policy read to carry; a test overrides this directly to
     * drive the bound without writing a fixture policy file.
     */
    spawnWallClockBoundMs?: number;
    /**
     * W1-T1062 (DISPATCH-PATH OWNER THREADING): overrides the owner this run clones from,
     * gateways against, and opens its PR/issues against — every one of the eleven uses fed by
     * the single `owner` binding just below. `resolveDaemonTarget`'s `--repo <owner>/<name>`
     * resolution (via the SAME `resolveReviewTarget` splitter `rmd review --repo` already
     * uses) is the one production source that sets this, threaded through `daemonCommand`'s
     * `runOne` closure. Omitted — every OTHER caller (manual `rmd run-task`, `rmd drain`,
     * `rmd wipe-test`) — this is `undefined` and `owner` resolves from THIS checkout's own
     * origin (`resolveOwner()`), byte-identical to before this option existed. Threading this
     * WITHOUT the daemon-side fix (or vice versa) is the partial-fix hazard the task record
     * warns about: cloning under one owner and opening the PR under another is worse than
     * today's honest self-owner-only behaviour.
     */
    owner?: string;
    /**
     * W1-T1256 (THE NO-MERGE BOUNDARY, operator ruling 2026-08-23): this run's PR may open,
     * but the deferred arm-at-verdict call site (right before `pollToGate`, below) must never
     * call {@link armAutoMergeAtOpen} for it — set ONLY by `wipeTestCommand`, for BOTH arms of
     * a wipe-test pair. Why: a merged arm A moves `origin/main` and flips `projectPlan`'s
     * `isMerged` for arm B, a REMOTE channel no local reset/reclone can reach (design note
     * (iii)/(iv) of the task record) — so a successful arm A would otherwise destroy its own
     * control by making arm B refuse at zero cost (W1-T319's already-merged guard). The
     * decision itself is a pure policy function ({@link resolveWipeTestArmPermission},
     * src/lib/wipe-test.ts) this call site consults rather than re-deriving; every OTHER
     * caller of `runTask` omits this, so today's arm-at-verdict behavior is unchanged for
     * every non-wipe-test dispatch.
     */
    noMerge?: boolean;
    /**
     * W1-T1268 (CROSS-HOST DISPATCH CLAIM): overrides the reserver the claim taken right
     * after the clone is confirmed (below) attempts against, releases on every refusal, and
     * releases again in the holder-arm `finally`. Default: the real
     * {@link dispatchClaimReserverFor} bound to `repoDir` — every production caller omits
     * this and gets the genuine `refs/rmd-dispatch/` git-ref-CAS. The seam mirrors every
     * other injectable above (`spawn`, `github`, `containmentExec`): a test drives the
     * `taken`/`unreachable` refusal, the release it triggers, and a release that itself
     * throws (best-effort, caught in the `finally`) deterministically, without a genuine
     * two-writer race against a real git remote.
     */
    claimReserver?: DispatchClaimReserverAsync;
    /**
     * W1-T1268 coverage seam: overrides the independent remote-head read `worktreeAdd`'s own
     * `assertWorktreeBaseCurrent` performs right after this run's ONE worktree is cut. Default:
     * `worktreeAdd`'s own default (a real, fresh `git ls-remote`). The genuine mechanism that
     * lets a base go stale despite the fetch immediately before it is, per `worktreeAdd`'s own
     * doc, UNMEASURED — an in-process race no test can script against a real remote — so this
     * is the same injection {@link WorktreeBaseStaleError}'s own direct tests
     * (`test/worktree-base-currency.test.ts`) already use, threaded here so a test can drive
     * the REAL `runTask()` catch branch that drops this run's dispatch claim on that refusal.
     */
    worktreeBaseDeps?: Parameters<typeof worktreeAdd>[4];
    /** W1-T4356/W1-T4933: refreshes a managed checkout whose lockfile hash moved; default {@link stagedInstall}. */
    managedCheckoutInstall?: (repoDir: string) => void;
    /** Test gateway for checkout install escalation; production uses the task repo's issue gateway. */
    prOpenRefusalIssues?: IssueGateway;
    /** W1-T5520: test seams for the sibling-PR check and the REST create; production reads `ghJsonAsync` and `execFileSync`. */
    otherOpenPrReader?: OpenPrJsonReader;
    prCreateExec?: Parameters<RunTaskCommandHost["runGhPrCreate"]>[4];
    prOpenProofRunner?: AsyncOpenPullRequestProofRunner;
    implementPush?: RunTaskBodyOptions["implementPush"];
    implementScopeAmendment?: RunTaskBodyOptions["implementScopeAmendment"];
    implementScopeAmendmentPortsIo?: RunTaskBodyOptions["implementScopeAmendmentPortsIo"];
    implementScopeAmendmentState?: RunTaskBodyOptions["implementScopeAmendmentState"];
    instanceRegistryTextImpl?: (repoRoot: string) => string | undefined;
    selectedModeFileIO?: RegistryFileIO;
    pairedTrial?: Partial<PairedTrialInput>;
    pairedTrialHost?: "daemon";
    /** W1-T5115: the daemon's git credential socket, handed to every spawn below. Only the daemon passes it — a direct
     *  `rmd run-task` keeps the ambient helper byte-for-byte. */
    gitCredentialSocketPath?: string;
    /** W1-T9085: a run child's cancel, chained into every worker spawn's `signal` (W1-T5659). Omitted, no spawn gets one. */
    abortSignal?: AbortSignal;
    /** W1-T9085: receives the fire-and-forget paired-trial work so a run child can await it. Omitted, it is detached as before. */
    onBackgroundWork?: (work: Promise<unknown>) => void;
  } = {},
  host: RunTaskCommandHost,
): Promise<RunResult> {
  if (process.env.RMD_INSTANCE_REGISTRY !== undefined && !instanceRegistryRuntimePresent()) {
    return withInstanceRegistryRuntime(() => runTask(taskId, opts, host));
  }
  const {
    BRANCH_NAME_CONTRACT_PART,
    syncPlanOrRefuse,
    lintPlanForReview,
    proofRepairRoundRefusalInWorktree,
    startShellLessMergeConflictMerge,
    terminalVerdictFields,
    renderReconClaimLines,
    CENSUS_BASELINE_FILES,
    workerBoundaryStack,
    buildBaseReproductionProbe,
    writeSyncLine,
    WORKER_STATE_LEDGER_STEP,
    capWorkerTailLines,
    writeWorkerTailBestEffort,
    attributeWorkerStreamEvent,
    quietBoundHistory,
    readWorktreeHeadReflog,
    workerCreatedCurrentHead,
    syncPlanOrRefuseAsync,
    isTerminalRed,
    ghPrCreateFillCommand,
    withDiagnostics,
    draftPrCreate,
    prCreateArgv,
    runGhPrCreate,
    lastCommitSubject,
    appendTaskTrailerToCommit,
    fetchPrBodyViaGh,
    fetchPrDiffFilesViaGh,
    changeView,
    rewriteAcceptanceBlockFromPlan,
    execGrepProofInWorktree,
    ensureTaskTrailer,
    ghPrHeadGateway,
    checkPrOwnership,
    scrubGitCredentialText,
    openTaskIdsFromPlan,
    yieldingSleep,
    restRollupFor,
    pollRestTarget,
    ciGateState,
    STALL_WINDOW,
    checkWaitStalled,
    waitForCiGreen,
    runReview,
    ghLiveState,
    ghLiveHead,
    captureWorktreeSnapshotViaGit,
    ghUpdateBranch,
    redBaseRefreshFactsFromRest,
    fixRebaseMergeFactsFromRest,
    reclaimAbandonedWorker,
    fixWorkerRunId,
    fixWorkerReceipt,
    spawnFixWorkerBounded,
    readFixRoundCommitsViaGit,
    runNpmScriptViaSpawn,
    commitGeneratorOutputViaGit,
    readPackageScriptsFor,
    runFixRung,
    buildProofAmendmentGitOps,
    buildProofAmendmentWritePorts,
    prNumberFromRef,
    workerSignal,
    harvestFollowupsFromReport,
    commitsAhead,
    sha256Hex,
    readRuleSourceFileOrUndefined,
    DEFAULT_BUDGET_USD,
    archiveWorkerTranscript,
    withPredecessorTranscriptCopies,
    benchmarkRunLedgerLogger,
    recordBenchmarkWorkerAttempt,
    dispatchFallbackObserver,
    withGitCredentialSocket,
    runErrorCause,
    censusPushRefusal,
    CENSUS_PUSH_CHECK,
    CENSUS_SNAPSHOT_ENV,
    COVERAGE_PUSH_CHECK,
    CENSUS_PUSH_NEVER_BYPASS,
    fixCensusAppliesToRepo,
    writeFixCensusSnapshot,
    writeFixCensusSnapshotAsync,
    checkFixCensusSnapshotAsync,
    FixRoundPushError,
    pushFixRound,
    coveragePrecheck,
    coveragePushRefusal,
    pushFixRoundPrechecked,
    repairRetroAcceptanceBlock,
    defaultRetroFetchBody,
    defaultRetroEditBody,
    prUrlTarget,
    readHeadShaRest,
    resolveFixRungTaskContractAtHeadAsync,
    MERGE_BASE_DIFF_ARGS,
    hostWorktreeGitResult,
    dispatchClaimReserverAsyncFor,
    WORKTREE_REAP_BOOT_CONTRACT_VERSION,
    logCloneReapSurvey,
    cloneReapPlan,
    logCloneReapRow,
    DISK_RECLAIM_DEFAULT_SWEEPS,
    createDaemonGatewayFactory,
    readRegistrationChanges,
    commitWorkerEdits,
    fixRoundGitOwnership,
    MISSING_COMMIT_MESSAGE_REASON,
    harnessCommitForShellLessWorker,
    worktreeHasUncommittedChanges,
    COMMIT_LINE_RESUME_PROMPT,
    writerCannotResume,
    missingCommitLinePrompt,
    pathIsUnderDeclaredSurface,
    execFilePromise,
    AWAITING_EXTERNAL_LEDGER_STEP,
    readLedgerRawLines,
    releaseReadersFor,
  } = host;
  const {
    defaultBinaryPinDeps,
    deriveRunawayTurnBound,
    dispatchStreamObserver,
    watchDispatchSpawn,
    checkpointUndeclaredFields,
    commitAndPushRestartCheckpoint,
    pushRestartCheckpoint,
    freshnessYieldRows,
    roundEndedHandoffRows,
    boundedWorkerTelemetryText,
    buildWorkerStateSensor,
    resolveOwner,
    shadowLiveWouldHaveDone,
    resolveShadowInstanceArmPermission,
    ghPrCreateFillCommandAsync,
    worktreeHeadOrUndefined,
    worktreeDiffStat,
    branchPrTitle,
    restoreBoundaryCheckpoint,
    diffFileChangesFromPatch,
    diffIsClassifiedIrreversible,
    irreversibleSignalForWorktree,
    armRunIdFromLedger,
    mergeShaNow,
    lostRaceEscalation,
    riskJudgeDisarm,
    disposeDisarm,
    fallbackPushEvidence,
    fallbackPushCause,
    rollupCheckSummary,
    prOpenHandoffDecline,
    pollToGate,
    ciGateBlockReason,
    fixRungTerminationVerdict,
    workerErrorVerdict,
    noPrVerdict,
    parseAlreadySatisfied,
    resolveAlreadySatisfied,
    resolveAlreadySatisfiedWithRetry,
    alreadySatisfiedVerdict,
    implementAttemptOutcome,
    finishTransientRetry,
    workerVisibleRecordPath,
    taskRecordContextLine,
    nonEmptyLines,
    reconObservedToContext,
    reconDegradedContextNote,
    reconMaskedContextNote,
    fileDigestOrAbsent,
    filesDigest,
    taskRecordSha,
    decideReconArtifactReuse,
    reconArtifactPath,
    loadReconArtifact,
    writeReconArtifact,
    reconArtifactToContext,
    buildRuleHeadlinesPart,
    softBudgetWarning,
    resolveRunMounts,
    probeVerdictKey,
    hookFilesUnder,
    readProbeKeyInputs,
    reportWorkerSourceSizeFollowup,
    isManagedCheckoutLockBusy,
    refreshManagedCheckout,
    refreshHeldManagedCheckout,
    sourceSizeGateFollowupConsumer,
    buildSourceSizeGatePostureRuntime,
    sourceSizeFollowupDebtResult,
    reportWorkerSourceSizeFollowupWithGatePosture,
    withInflightRunLock,
    endThrownRun,
    deferOpenToSiblingPr,
    reclaimRunWorktree,
    endRefusedRun,
    endRunOnce,
    boundedVerdictReason,
    repairCensusRefusedPush,
    normalizeRunPrAcceptanceFromPlan,
    recordBakedClosureCatalog,
    refusedBranchChangedFiles,
    logCloneReapSurveyAsync,
    logWorktreeReapBootSurvey,
    logDiskReclaimRung,
    logLearningsUsed,
    logSkillsUsed,
    fixRungCiFailures,
    cashContainedRunRefusal,
    forceCashContainedRunSpawn,
    headProvenanceFields,
    createHarnessCommitRefusalRecorder,
    resumeForMissingCommitLine,
    requiredCompanions,
    readBuildScopeAmendmentState,
    askScopeForLeftOutImports,
    derivedImplementCommit,
    commitLineResume,
  } = runTaskCommandHelpers(host);
  const config = opts.config ?? loadConfig();
  const rawSpawn = opts.spawn ?? spawnWorker;
  const runReviewFn = opts.runReview ?? runReview;
  const fetchPrBodyFn = opts.fetchPrBody ?? fetchPrBodyViaGh;
  const recordDecisionFn = opts.recordDecision ?? recordDecision;
  const planPath = opts.planPath ?? join(repoRoot, "plan", "tasks.yaml");
  const ledgerPath = ledgerPathFor(config);
  const owner = opts.owner ?? resolveOwner();
  // W1-T1045: THE CLOCK BOUND — read here, once, alongside every other opts-defaulted knob
  // above, and threaded into the `spawn` wrap-once shape below so every real dispatch spawn
  // (recon/implement/diagnose/decision-resume) gets it BY CONSTRUCTION, the same rationale
  // `onSpawnError`/`workerStateSensor.observer` already state for that wrapper.
  const workerAbandonMs = opts.workerAbandonMs ?? loadDefaultPolicy().values.workerAbandon;
  // W1-T7807: the policy `workerStall` row is the quiet-worker watchdog's no-history fallback bound.
  const workerStallFallbackMs = opts.workerStallMs ?? loadDefaultPolicy().values.workerStall;

  // W1-T2528: not routed through `nextLaneEpochMs` — `taskId` is already the per-rung
  // component, and same-taskId reruns are refused earlier by the dispatch claim/inflight check.
  const runId = `${taskId}-${Date.now()}`;
  const log = benchmarkRunLedgerLogger((step, fields) =>
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, lane: "run-task", ...fields }),
    opts.benchmarkStackEvidence ?? workerBoundaryStack);

  // W1-T942: ONE worker-state sensor for THIS run's whole lifetime — recon, implement, and the
  // DECISION_REQUEST resume below all share it (see `buildWorkerStateSensor`'s own doc for why
  // a fresh tracker per spawn would misreport a restart the operator never actually saw).
  const workerStateSensor = buildWorkerStateSensor({ ledgerPath, runId, taskId, root: config.root });
  const restartPhase = { current: "recon" };
  const noteRestartPhase = (phase: string): void => {
    restartPhase.current = phase;
    log("run.phase", { waiting_on: phase });
  };

  /**
   * W1-T442: THE DESTINATION for a spawn's asynchronous 'error' event. Wrapping
   * the `spawn` dep ONCE here — rather than adding `onSpawnError` at each of
   * recon's, implement's and fix's call sites — means a spawn added later is
   * diagnosed by construction instead of by remembering.
   *
   * `worker.spawn_error` is DIAGNOSTIC and is deliberately NOT added to
   * `DECISION_RELEVANT_LEDGER_STEPS`: nothing reads it, so a rotation dropping
   * it costs a post-mortem rather than a wrong decision — the same argument
   * #1629 made for `dispatch.circuit_broken`. (#1648 took the OPPOSITE decision
   * for its own rows, and the difference is the whole test: there, a consumer
   * had appeared that read them. `test/ledger-rotation.test.ts` re-derives the
   * set from consumer source, so it will refuse this the moment one appears
   * here too.)
   *
   * W1-T942: the SAME wrap-once shape now ALSO attaches `workerStateSensor.observer` — the
   * real observer, wired at the real spawn path rather than merely available (Standing rule
   * 14) — and polls the quiet floor for exactly the duration this ONE spawn is in flight.
   */
  // Set only after a blocked subscription containment/isolation probe is replaced by the cash
  // adapter's structural boundary proof below.  Ordinary runs keep the existing per-spawn auction.
  const cashContainmentState = { contained: false };
  const cashContainmentBoundary = opts.cashContainmentBoundary ?? assertOpenWeightToolBoundary;
  // A wait allocates almost nothing, so no GC would take the setup garbage before the kernel swapped it (agent-wait-heap.ts).
  const observeAgentWait = (): void => {
    if (!opts.atAgentWait) return;
    const waitingOn = restartPhase.current;
    opts.atAgentWait().then(
      (heap) => log(RUN_AGENT_WAIT_HEAP_STEP, { waiting_on: waitingOn, ...heap }),
      (error: unknown) => log(RUN_AGENT_WAIT_HEAP_STEP, { waiting_on: waitingOn, error: String((error as Error)?.message ?? error) }),
    );
  };
  const spawn: typeof spawnWorker = (requestedSpawnArgs) => {
    noteRestartPhase(restartPhase.current);
    observeAgentWait();
    // W1-T5115: at the ONE wrapper every dispatch spawn passes, so no spawn added later can miss the socket.
    const socketPath = runChildCredentialSocket(opts.gitCredentialSocketPath);
    const spawnArgs = chainAbortSignal(socketPath
      ? withGitCredentialSocket(requestedSpawnArgs, socketPath)
      : requestedSpawnArgs, opts.abortSignal);
    const effectiveSpawnArgs = cashContainmentState.contained ? forceCashContainedRunSpawn(spawnArgs, config) : spawnArgs;
    const stopPolling = workerStateSensor.startPolling();
    let selectionAssignment: Parameters<NonNullable<SpawnWorkerArgs["onSelectionAssignment"]>>[0] | undefined;
    const baseStreamObserver = effectiveSpawnArgs.streamObserver ?? workerStateSensor.observer;
    const receiptLog: typeof log = callerOwnsBenchmarkReceipt(effectiveSpawnArgs) ? () => {} : log; // W1-T4613: fixWorkerReceipt owns it
    // W1-T7807: the quiet-worker watchdog rides every REAL dispatch spawn (an injected spawn has no process tree to read).
    const watchedSpawn = watchDispatchSpawn(rawSpawn, {
      enabled: !opts.spawn, taskId, runId, ledgerPath, fallbackBoundMs: workerStallFallbackMs, spawnArgs: effectiveSpawnArgs, task, log,
      provider: () => selectionAssignment?.selected.provider, recyclePending: opts.externalWaitRecycle ?? (() => recyclePauseDetail(config.root)),
    });
    return recordBenchmarkWorkerAttempt(() => watchedSpawn({
      ...effectiveSpawnArgs,
      // A dispatch run builds in its task worktree: its workers reserve (and learn) host memory as "implement".
      workerClass: effectiveSpawnArgs.workerClass ?? "implement",
      // Every dispatch-phase worker inherits the run identity at the ONE wrapper that already owns its state/error telemetry, so the
      // routing assignment and terminal worker row join without inferring a task; an injected observer still runs, but after the ledger.
      runId: effectiveSpawnArgs.runId ?? runId,
      taskId: effectiveSpawnArgs.taskId ?? taskId,
      onSelectionAssignment: (assignment) => {
        selectionAssignment = assignment;
        receiptLog("worker.assignment", { worker_assignment: assignment });
        effectiveSpawnArgs.onSelectionAssignment?.(assignment);
      },
      onModelFallbackAttempt: dispatchFallbackObserver(receiptLog, effectiveSpawnArgs.onModelFallbackAttempt),
      onSpawnError:
        effectiveSpawnArgs.onSpawnError ??
        ((err) =>
          log("worker.spawn_error", {
            // The errno IS the finding — everything else is context for it.
            code: err.code ?? null,
            errno: typeof err.errno === "number" ? err.errno : null,
            syscall: err.syscall ?? null,
            path: err.path ?? null,
            error: String(err.message ?? err),
          })),
      // Keep provider/model attribution specific to THIS spawn, not the run's initial mount.
      // The selected assignment is authoritative for provider + requested model; the selected
      // model is deliberately not promoted to a served-model receipt.
      streamObserver: dispatchStreamObserver(baseStreamObserver, effectiveSpawnArgs, () => selectionAssignment),
      // W1-T1045: every real dispatch spawn gets the clock bound BY CONSTRUCTION — the SAME
      // wrap-once rationale as `onSpawnError`/`streamObserver` above. A caller that already set
      // its own `clockBound` (none exist today) is respected; every future dispatch call site
      // through this wrapper is covered without remembering to add it individually.
      clockBound: effectiveSpawnArgs.clockBound ?? { boundMs: workerAbandonMs },
    }), receiptLog, () => selectionAssignment, stopPolling);
  };
  // W1-T143: a raw synchronous write, not console.log — this narration is exactly what the
  // daemon's `runOne` exercises on every dispatch, and console.log's async, non-TTY-buffered
  // writes are why daemon.out.log sat empty for a whole live run (see writeSyncLine's doc).
  const say = (msg: string) => writeSyncLine(1, `\n### [${taskId}] ${msg}`);

  // ── GIT SELF-SYNC (W1-T60): read the plan from `origin/main`, never the working tree — a
  // dirty local WIP file or a stale local `main` must never change what this run dispatches,
  // and the runner must never require a manual `git pull` first. A fetch failure FAILS
  // CLOSED (named ledger error, no spawn) unless `--allow-stale` explicitly opts in.
  let plan: Plan;
  if (opts.skipGitSync) {
    plan = loadPlan(planPath);
  } else {
    const synced = await syncPlanOrRefuseAsync(planPath, {
      allowStale: opts.allowStale ?? false,
      log,
      say,
      planSnapshot: opts.planSnapshot,
    });
    if ("error" in synced) {
      return { taskId, runId, merged: false, costUsd: 0, verdict: "blocked_git_fetch" };
    }
    plan = synced.plan;
  }
  const task = selectTask(plan, taskId);

  // ── Merge-state is DERIVED FROM GITHUB, never from the yaml `status:` field
  // (MASTER-PLAN v2.1). Project the whole plan against GitHub, cache it to a
  // machine-owned status.json, and gate on the derived merged predicate. The
  // runner NEVER writes tasks.yaml.
  const statusPath = join(config.root, "state", "status.json");
  // Hoisted (was inline) so runTaskBody's SILENT NO-OP GUARD (W1-T272) can reuse the SAME
  // gateway instance for its ALREADY_SATISFIED evidence check, rather than opening a second one.
  //
  // BATCHED, NOT `ghGateway` — the dispatch path was the last O(N)-GraphQL surface. The line
  // below feeds `projectPlan(plan, …)` on the very next line, which is the WHOLE plan (441 tasks
  // at this sha), and `ghGateway.findMergedByTrailer` spends ONE `gh pr list --search
  // '"Remudero-Task: <id>" in:body'` per task — a GraphQL search each. So a single dispatch could
  // cost ~441 of the account's 5000/hour, and a two-lane drain doubled it: MEASURED exhaustion at
  // 5661/5000 while REST sat untouched at 5000/5000, with a drain reporting `no_runnable` at
  // $0.00. `buildBatchedGithub` answers the same question client-side off ONE `fetchBoardPrsRest`
  // pass (steady state 2 REST calls), which is the same batch-once-amortize-over-N-tasks shape
  // `projectPlan` already applies to the ledger read and to rung (c2)'s head-branch corroboration.
  //
  // THE CREDIT IS UNCHANGED, and that is the load-bearing claim rather than the cost. The batched
  // `findMergedByTrailer` matches the ANCHORED `^Remudero-Task: <id>$` line — the SAME regex
  // `hasAnchoredTrailer` re-verifies with before `creditsByAnchoredTrailer` may credit — whereas
  // the search form is documented fuzzy and returns candidates the caller then rejects. Same
  // credits, strictly fewer rejected candidates. Coverage is not lost either: the REST walk is
  // bounded at 50 pages x 100 per state (5000 open + 5000 closed) against ~1.5k PRs in this repo,
  // and it reports `truncated` rather than silently dropping a tail.
  // W1-T2509: `githubFor` lets a multi-lane caller hand every lane ONE memoised gateway per
  // owner/repo, so lanes 2..N hit a warm `knownBoardPrs` index (a `mode: "delta"` fetch)
  // instead of each paying `mode: "full"`. Absent it, this is byte-identical to before.
  const github = opts.github ?? opts.githubFor?.(owner, task.repo) ?? createDaemonGatewayFactory(config.root, log)(owner, task.repo);
  const projection = projectPlan(plan, { ledgerPath: ledgerPathFor(config), github }, statusPath);
  const isMerged = (t: Task): boolean => projection.get(t.id)?.merged ?? false;
  // W1-T322/W1-T367: computed once per run off the SAME plan+projection already built above —
  // the SHIPS-UNWIRED marker verification set both `runReviewFn` and `runFixRung` below consult.
  // Feeding `openTaskIdsFromPlan` the derived `projection` (never the plan alone) is the W1-T367
  // fix — see that function's own doc for why the yaml `status:` field wrongly credited 248
  // merged tasks as open. No second GitHub read: this is the SAME `projectPlan` pass `isMerged`
  // above already paid for.
  const openTaskIds = openTaskIdsFromPlan(plan, projection);

  // ── ALREADY-MERGED BY-ID REFUSAL (W1-T319, fb-1784773321502-86793d): `isMerged` above is
  // handed to `assertRunnable` next, which spends it ENTIRELY on the target's DEPENDENCIES —
  // nothing on this path ever asks the one question the projection already answers about the
  // TARGET itself. The incident this fixes: a task the projection already recorded merged
  // (source:ledger, via a real PR) was dispatched anyway, pushed an empty branch, and claimed
  // the OLD PR (pr_attribution_failed) — $1.30 for an outcome decided before the worker
  // spawned. Reuses the SAME `projection` and `github` gateway already in scope — no second
  // `projectPlan` call, no second gateway. Sits BEFORE `assertRunnable` (so the refusal names
  // the accurate reason, not a downstream dependency message), before the §5C linter, the
  // inflight lock, worktree materialization and any spawn: zero cost beyond the map lookup.
  // The daemon's console-kick loop (`isMerged(kick.taskId)` in daemon.ts) and drain's
  // eligibility filter already guard their own paths — this was the one dispatch entry point
  // without it. `--rerun` is the explicit, ledgered escape hatch (mirrors `--allow-stale`).
  if (isMerged(task)) {
    if (opts.rerun) {
      log("dispatch.rerun_override", { pr_url: projection.get(task.id)?.prUrl });
    } else {
      const mergedPrUrl = projection.get(task.id)?.prUrl;
      log("dispatch.refused_already_merged", { pr_url: mergedPrUrl });
      say(
        `REFUSED: ${task.id} is already merged${mergedPrUrl ? ` (${mergedPrUrl})` : ""} — pass --rerun to dispatch anyway`,
      );
      // W1-T2446: EVIDENCE ARM, HOISTED HERE. `decideDispatchClaimRelease`'s evidence arm
      // (dispatch-claim.ts) fires only where `claimReserver` is in scope, and until now that
      // was exactly ONE call site 300 lines below (`claimOutcome === "taken"`, at the CAS this
      // refusal always returns before reaching) -- so the one release arm that needs neither a
      // live holder nor an operator was unreachable in exactly the case it was written for.
      // W1-T2424's claim survived its own merge until an operator deleted the ref by hand.
      // `isMerged(task)` above is the SAME projection already paid for -- no new probe. The
      // reserver is bound to `repoDir`'s path, not constructed yet this early: reading and
      // dropping a claim that turns out to be held costs one `ls-remote` plus, at most, one
      // delete -- no new I/O beyond that. Best-effort and silent when there is nothing to
      // release: `holder()`/`drop()` are plain git reads/writes that fail closed (return
      // undefined/false) on an unreachable remote or on a repo this host has never cloned,
      // same as any other dispatch attempt for this task would see from a fresh host -- see
      // `dispatchClaimReserverFor`'s own doc for why `repoDir`, not `repoRoot`. NO TIMER: the
      // only new input is `isMerged`, the identical evidence `decideDispatchClaimRelease`'s
      // one existing call site already reuses -- this hoists ITS reach, never its meaning.
      const staleClaimReserver = opts.claimReserver ?? dispatchClaimReserverAsyncFor(join(config.root, "repos", task.repo));
      if ((await staleClaimReserver.holder(task.id)) !== undefined) {
        const released = await releaseDispatchClaimAsync(task.id, staleClaimReserver, { evidenceObserved: true });
        log("dispatch.claim_released", {
          ref: dispatchClaimRef(task.id),
          arm: released.arm,
          release: released.release,
          dropped: released.dropped,
          reason: released.reason,
        });
      }
      return { taskId, runId, merged: false, costUsd: 0, verdict: "task_already_merged" };
    }
  }

  // W1-T3216: the released set is passed so an operator-ratified verify:human task runs here too.
  // Read once, at this single-task entry point — there is no pass to amortise it over.
  // W1-T10348: preserve the shared resolver across the extraction.
  assertRunnable(plan, task, isMerged, resolveReleasedIds(releaseReadersFor(ledgerPath), plan));

  // ── §5C LAYER A: deterministic task linter, FAIL-CLOSED pre-dispatch guard
  // (MASTER-PLAN §5C). Four malformed tasks (W1-T6, W1-T9, W1-T12) reached a
  // worker and burned budget before a human noticed the pattern; this refuses a
  // linter-failing task BEFORE the inflight lock is even taken — no lock, no
  // worktree, no worker ever spawns. `rmd drain` dispatches every task through
  // this same `runTask` path, so this ONE call site gates both entry points.
  try {
    // proofDialect — W1-T246's pre-dispatch "warn" demotion is REVERSED here: a proof that
    // cannot execute now BLOCKS pre-dispatch, exactly as it already blocks at filing (`rmd
    // lint-plan`, the inbox draft rung, the retro's plan-health sweep). The demotion's stated
    // reason was that a "~90-task legacy backlog" would brick into blocked_illformed
    // overnight; measured over the 7 days to 2026-07-30 that premise no longer holds — only
    // 24 tasks are dispatchable at all, 15 of which still dispatch under this gate, while the
    // demotion let 45 runs / $400.83 (49.4% of run spend, 34 distinct tasks) reach a worker
    // with a proof that could never execute. NONE of those 45 merged, and none could have:
    // review.ts's `capped` (`executableCriteria.length > 0 && executedCount === 0`) is
    // unavoidable for such a task, and decideAutoMergeArm has refused to arm auto-merge on
    // ANY capped verdict since W1-T229/#528 (2026-07-22). So this refusal declines to pay for
    // a run a downstream gate would refuse anyway. The escape hatch is `git revert` of the
    // one commit that made this change — deliberately no config key, env var, or policy row.
    //
    // proofResolvability:"warn" — DELIBERATELY LEFT DEMOTED, and this is not an oversight.
    // W1-T101's rollout reason still binds: a queued task's proof legitimately FORWARD-
    // REFERENCES the test its own PR will create (recon-AB measured 27 of 39 path proofs
    // doing exactly that), and resolvability cannot tell that apart from a dead reference
    // pre-dispatch. Blocking it would refuse correct authoring at scale. BLOCKS at
    // filing/plan-health (the birth gate this check exists for); WARNS pre-dispatch.
    //
    // ONE options object for both calls: the loop below is visibility-only (it ledgers a
    // `lint.warned` line per still-demoted violation) and `assertLintClean` is the actual
    // gate, so the two MUST agree — two separate literals had already drifted once.
    const preDispatchLint = { proofResolvability: "warn" } as const;
    for (const v of lintTask(task, preDispatchLint).violations) {
      if ((v.check === "proof-dialect" || v.check === "proof-resolvability") && v.severity === "warn") {
        log("lint.warned", { check: v.check, message: v.message });
      }
    }
    assertLintClean(task, preDispatchLint);
  } catch (e) {
    if (e instanceof TaskLintError) {
      log("lint.blocked", { violations: e.violations });
      say(
        `REFUSED: task ${taskId} failed the pre-dispatch linter — ${e.violations.length} violation(s):\n` +
          e.violations.map((v) => `  • [${v.check}] ${v.message}`).join("\n"),
      );
      // W1-T3657: A TASK THE LINTER REFUSES IS REPAIRED, NOT RE-ATTEMPTED FOREVER. Deterministic
      // re-attempts of the SAME task reach the IDENTICAL verdict every tick (measured: 1,232
      // refusals of one already-shipped task in 10.4h) — no strike spent, no escalation, nothing
      // touched. `repairRefusedTask` (src/lib/dispatch-repair.ts) spends the decision instead:
      // dispatch ONE repair lane carrying `e.violations` VERBATIM, or, on a SECOND refusal
      // carrying the SAME verdict, escalate to the operator rather than re-reconning. A later
      // identical refusal is held after that terminal escalation, with no second GitHub write.
      // NEVER spawns (`dispatchRepairLaneDefault` below only logs+says) — the "no spawn on a
      // linter-failing task" invariant (W1-T20c criterion 5, test/task-linter-wiring.test.ts)
      // holds exactly as it did before this task.
      const dispatchRepairLaneDefault = (input: { taskId: string; verdict: string; progress: boolean }) => {
        log("dispatch.repair.dispatched", input);
        say(
          `REPAIR: dispatching one repair lane for ${input.taskId} (${input.progress ? "verdict changed — progress" : "first refusal"}) ` +
            `carrying the linter's own verdict:\n${input.verdict}`,
        );
      };
      const escalateDefault = (input: { taskId: string; verdict: string; attempts: number }) => {
        const escalation: Escalation = {
          class: "BLOCKED",
          taskId: input.taskId,
          runId,
          summary: `pre-dispatch linter refused ${input.taskId} again with the SAME verdict (${input.attempts}x) — repair lane made no progress`,
          detail:
            `A repair lane already ran once for this exact verdict and the task still refuses to dispatch:\n\n${input.verdict}\n\n` +
            `A second automatic repair lane would only repeat it — this is why the loop stops here instead of re-reconning.`,
          options: [
            {
              label: "restructure-task",
              detail: "edit the task's plan record to resolve the named linter violation(s), then re-dispatch.",
            },
          ],
          recommendation: "restructure-task",
        };
        const issueUrl = escalate(escalation, { issues: ghIssueGateway(owner, task.repo), ledgerPath, runId });
        log("dispatch.repair.escalated", { ...input, issue_url: issueUrl });
      };
      const violations: RefusalViolation[] = e.violations.map((v) => ({ check: v.check, message: v.message }));
      const refusalStateRoot = join(config.root, "state");
      const repairAction = repairRefusedTask(
        taskId,
        violations,
        (id) => readPriorRefusal(refusalStateRoot, id),
        (id, prior) => writePriorRefusal(refusalStateRoot, id, prior),
        dispatchRepairLaneDefault,
        escalateDefault,
        preDispatchContractRevision(task),
      );
      if (repairAction.kind === "held") {
        log("dispatch.repair.held", {
          reason: "unchanged pre-dispatch verdict was already escalated",
          verdict: repairAction.verdict,
          escalation_attempts: repairAction.attempts,
        });
      }
      return { taskId, runId, merged: false, costUsd: 0, verdict: "blocked_illformed" };
    }
    throw e;
  }

  // ── PER-TASK IN-FLIGHT LOCK (guard 1, docs/archive/DIAGNOSIS.md diag/drain-sequential-await).
  // No two runs of the SAME task may overlap — whatever launched them (two drains, or a
  // manual run-task beside a running drain). A LIVE holder ⇒ REFUSE this run (naming the
  // holder); a stale (dead-pid) lock ⇒ reclaim.
  //
  // RELEASED ON EVERY *UNWOUND* PATH — return OR throw — via the finally below. THAT IS NOT
  // "every terminal path", and the difference is the whole reason the sweep rung exists: a
  // `finally` only runs if the stack unwinds. There are NO signal handlers anywhere in src/,
  // so SIGKILL (unhandleable) AND SIGTERM/SIGINT (Node's default terminates without unwinding)
  // both leave the lock file behind — as does an OOM-kill or power loss. An earlier revision of
  // this comment claimed "a crash never leaves a permanent stale lock"; that was false, and
  // `sweepStaleInflightLocks`' own doc already contradicted it with an observed case
  // (`W1-T1.lock` holding pid 65304, dead two days, still present). Stale locks are REAL,
  // EXPECTED, and cleared by the next acquire of this same task or by the sweep rung.
  const inflightDir = join(config.root, "state", "inflight");
  let inflightLock;
  try {
    inflightLock = acquireInflightLock(inflightDir, taskId, { run_id: runId });
  } catch (e) {
    if (e instanceof InflightLockError) {
      log("inflight.refused", { holder_pid: e.holder.pid, holder_run_id: e.holder.run_id });
      say(`REFUSED: task ${taskId} already running (pid ${e.holder.pid}, run ${e.holder.run_id}) — not starting a duplicate`);
      return { taskId, runId, merged: false, costUsd: 0, verdict: "blocked_inflight" };
    }
    throw e;
  }
  const detach = (work: Promise<unknown>): void => opts.onBackgroundWork?.(work);
  detach(runPairedTrial({ ...(opts.pairedTrialHost === "daemon"
    ? { dispatchAttempt: sealedPairedAttemptDispatcher({ task, config, repoDir: join(config.root, "repos", task.repo), spawn: rawSpawn,
      maxBudgetUsd: task.budget_usd ?? DEFAULT_BUDGET_USD, clockBoundMs: workerAbandonMs }) }
    : { dispatchRefusal: PAIRED_CLI_REFUSAL }), ...opts.pairedTrial, task, lane: "implement", stateDir: join(config.root, "state"), log,
    harnessRevision: (opts.benchmarkStackEvidence ?? workerBoundaryStack).harnessRevision }));
  // W1-T4647: a registered prospective A/A pairs the task on its one pinned stack, subscription only; inert otherwise.
  detach(runProspectiveAaPair({ ...(opts.pairedTrialHost === "daemon"
    ? { dispatchAttempt: sealedPairedAttemptDispatcher({ task, config, repoDir: join(config.root, "repos", task.repo),
      spawn: benchmarkNonDispatchSpawn("aa-prospective", rawSpawn), maxBudgetUsd: PAIRED_ATTEMPT_MAX_BUDGET_USD, clockBoundMs: workerAbandonMs }) }
    : { dispatchRefusal: PAIRED_CLI_REFUSAL }), task, lane: "implement", stateDir: join(config.root, "state"), config,
    harnessRevision: (opts.benchmarkStackEvidence ?? workerBoundaryStack).harnessRevision }));
  return withInflightRunLock(inflightLock, taskId, log, async (runLog) => {
    const ctx: RunTaskContext = {
      restartPhase,
      spawnInjected: opts.spawn !== undefined,
      cashContainmentBoundary,
      cashContainmentState,
      config,
      fetchPrBodyFn,
      github,
      isMerged,
      ledgerPath,
      log: runLog,
      openTaskIds,
      opts,
      owner,
      plan,
      planPath,
      recordDecisionFn,
      repoRoot,
      runId,
      runReviewFn,
      say,
      spawn,
      task,
      taskId,
      workerAbandonMs,
      workerStateSensor,
      releasePlan: () => {
        plan = { tasks: [task], byId: new Map([[task.id, task]]) };
        ctx.plan = plan;
      },
    };
    return await runTaskBody(ctx, host);
  });
}

export async function runTaskBody(ctx: RunTaskContext, host: RunTaskCommandHost): Promise<RunResult> {
  const {
    BRANCH_NAME_CONTRACT_PART,
    syncPlanOrRefuse,
    lintPlanForReview,
    proofRepairRoundRefusalInWorktree,
    startShellLessMergeConflictMerge,
    terminalVerdictFields,
    renderReconClaimLines,
    CENSUS_BASELINE_FILES,
    workerBoundaryStack,
    buildBaseReproductionProbe,
    writeSyncLine,
    WORKER_STATE_LEDGER_STEP,
    capWorkerTailLines,
    writeWorkerTailBestEffort,
    attributeWorkerStreamEvent,
    quietBoundHistory,
    readWorktreeHeadReflog,
    workerCreatedCurrentHead,
    syncPlanOrRefuseAsync,
    isTerminalRed,
    ghPrCreateFillCommand,
    withDiagnostics,
    draftPrCreate,
    prCreateArgv,
    runGhPrCreate,
    lastCommitSubject,
    appendTaskTrailerToCommit,
    fetchPrBodyViaGh,
    fetchPrDiffFilesViaGh,
    changeView,
    rewriteAcceptanceBlockFromPlan,
    execGrepProofInWorktree,
    ensureTaskTrailer,
    ghPrHeadGateway,
    checkPrOwnership,
    scrubGitCredentialText,
    openTaskIdsFromPlan,
    yieldingSleep,
    restRollupFor,
    pollRestTarget,
    ciGateState,
    STALL_WINDOW,
    checkWaitStalled,
    waitForCiGreen,
    runReview,
    ghLiveState,
    ghLiveHead,
    captureWorktreeSnapshotViaGit,
    ghUpdateBranch,
    redBaseRefreshFactsFromRest,
    fixRebaseMergeFactsFromRest,
    reclaimAbandonedWorker,
    fixWorkerRunId,
    fixWorkerReceipt,
    spawnFixWorkerBounded,
    readFixRoundCommitsViaGit,
    runNpmScriptViaSpawn,
    commitGeneratorOutputViaGit,
    readPackageScriptsFor,
    runFixRung,
    buildProofAmendmentGitOps,
    buildProofAmendmentWritePorts,
    prNumberFromRef,
    workerSignal,
    harvestFollowupsFromReport,
    commitsAhead,
    sha256Hex,
    readRuleSourceFileOrUndefined,
    DEFAULT_BUDGET_USD,
    archiveWorkerTranscript,
    withPredecessorTranscriptCopies,
    benchmarkRunLedgerLogger,
    recordBenchmarkWorkerAttempt,
    dispatchFallbackObserver,
    withGitCredentialSocket,
    runErrorCause,
    censusPushRefusal,
    CENSUS_PUSH_CHECK,
    CENSUS_SNAPSHOT_ENV,
    COVERAGE_PUSH_CHECK,
    CENSUS_PUSH_NEVER_BYPASS,
    fixCensusAppliesToRepo,
    writeFixCensusSnapshot,
    writeFixCensusSnapshotAsync,
    checkFixCensusSnapshotAsync,
    FixRoundPushError,
    pushFixRound,
    coveragePrecheck,
    coveragePushRefusal,
    pushFixRoundPrechecked,
    repairRetroAcceptanceBlock,
    defaultRetroFetchBody,
    defaultRetroEditBody,
    prUrlTarget,
    readHeadShaRest,
    resolveFixRungTaskContractAtHeadAsync,
    MERGE_BASE_DIFF_ARGS,
    hostWorktreeGitResult,
    dispatchClaimReserverAsyncFor,
    WORKTREE_REAP_BOOT_CONTRACT_VERSION,
    logCloneReapSurvey,
    cloneReapPlan,
    logCloneReapRow,
    DISK_RECLAIM_DEFAULT_SWEEPS,
    createDaemonGatewayFactory,
    readRegistrationChanges,
    commitWorkerEdits,
    fixRoundGitOwnership,
    MISSING_COMMIT_MESSAGE_REASON,
    harnessCommitForShellLessWorker,
    worktreeHasUncommittedChanges,
    COMMIT_LINE_RESUME_PROMPT,
    writerCannotResume,
    missingCommitLinePrompt,
    pathIsUnderDeclaredSurface,
    execFilePromise,
    AWAITING_EXTERNAL_LEDGER_STEP,
    readLedgerRawLines,
  } = host;
  const {
    defaultBinaryPinDeps,
    deriveRunawayTurnBound,
    dispatchStreamObserver,
    watchDispatchSpawn,
    checkpointUndeclaredFields,
    commitAndPushRestartCheckpoint,
    pushRestartCheckpoint,
    freshnessYieldRows,
    roundEndedHandoffRows,
    boundedWorkerTelemetryText,
    buildWorkerStateSensor,
    resolveOwner,
    shadowLiveWouldHaveDone,
    resolveShadowInstanceArmPermission,
    ghPrCreateFillCommandAsync,
    worktreeHeadOrUndefined,
    worktreeDiffStat,
    branchPrTitle,
    restoreBoundaryCheckpoint,
    diffFileChangesFromPatch,
    diffIsClassifiedIrreversible,
    irreversibleSignalForWorktree,
    armRunIdFromLedger,
    mergeShaNow,
    lostRaceEscalation,
    riskJudgeDisarm,
    disposeDisarm,
    fallbackPushEvidence,
    fallbackPushCause,
    rollupCheckSummary,
    prOpenHandoffDecline,
    pollToGate,
    ciGateBlockReason,
    fixRungTerminationVerdict,
    workerErrorVerdict,
    noPrVerdict,
    parseAlreadySatisfied,
    resolveAlreadySatisfied,
    resolveAlreadySatisfiedWithRetry,
    alreadySatisfiedVerdict,
    implementAttemptOutcome,
    finishTransientRetry,
    workerVisibleRecordPath,
    taskRecordContextLine,
    nonEmptyLines,
    reconObservedToContext,
    reconDegradedContextNote,
    reconMaskedContextNote,
    fileDigestOrAbsent,
    filesDigest,
    taskRecordSha,
    decideReconArtifactReuse,
    reconArtifactPath,
    loadReconArtifact,
    writeReconArtifact,
    reconArtifactToContext,
    buildRuleHeadlinesPart,
    softBudgetWarning,
    resolveRunMounts,
    probeVerdictKey,
    hookFilesUnder,
    readProbeKeyInputs,
    reportWorkerSourceSizeFollowup,
    isManagedCheckoutLockBusy,
    refreshManagedCheckout,
    refreshHeldManagedCheckout,
    sourceSizeGateFollowupConsumer,
    buildSourceSizeGatePostureRuntime,
    sourceSizeFollowupDebtResult,
    reportWorkerSourceSizeFollowupWithGatePosture,
    withInflightRunLock,
    endThrownRun,
    deferOpenToSiblingPr,
    reclaimRunWorktree,
    endRefusedRun,
    endRunOnce,
    boundedVerdictReason,
    repairCensusRefusedPush,
    normalizeRunPrAcceptanceFromPlan,
    recordBakedClosureCatalog,
    refusedBranchChangedFiles,
    logCloneReapSurveyAsync,
    logWorktreeReapBootSurvey,
    logDiskReclaimRung,
    logLearningsUsed,
    logSkillsUsed,
    fixRungCiFailures,
    cashContainedRunRefusal,
    forceCashContainedRunSpawn,
    headProvenanceFields,
    createHarnessCommitRefusalRecorder,
    resumeForMissingCommitLine,
    requiredCompanions,
    readBuildScopeAmendmentState,
    askScopeForLeftOutImports,
    derivedImplementCommit,
    commitLineResume,
  } = runTaskCommandHelpers(host);
  const {
    config,
    fetchPrBodyFn,
    github,
    isMerged,
    ledgerPath,
    log: ctxLog,
    openTaskIds,
    opts,
    owner,
    planPath,
    recordDecisionFn,
    repoRoot,
    runId,
    runReviewFn,
    say,
    spawn,
    task,
    taskId,
    workerAbandonMs,
    workerStateSensor,
    spawnInjected = false,
  } = ctx;
  // W1-T4655: set BEFORE the write, so no thrown-run exit (endThrownRun) writes a second verdict.
  let verdictWritten = false;
  const log: RunTaskContext["log"] = (step, extra) => {
    if (step === "verdict") verdictWritten = true;
    ctxLog(step, extra);
  };
  const restartPhase = ctx.restartPhase ?? { current: "recon" };
  const noteRestartPhase = (phase: string): void => {
    restartPhase.current = phase;
    log("run.phase", { waiting_on: phase });
  };
  // Direct callers of the exported body retain ordinary routing.  Production runTask always
  // supplies the shared object so the preflight and its spawn wrapper observe the same decision.
  const cashContainmentState = ctx.cashContainmentState ?? { contained: false };
  const cashContainmentBoundary = ctx.cashContainmentBoundary ?? assertOpenWeightToolBoundary;

  // Hold the instance mode for the run so a registry edit cannot flip its deferred arm decision.
  const shadowInstance = instanceMode(`${owner}/${task.repo}`, (opts.instanceRegistryTextImpl ?? readInstanceRegistryText)(repoRoot)) === "shadow";
  const selectedModeQualification = createSelectedModeQualification(config.selectedRegistryMode, `${owner}/${task.repo}`,
    { envPath: process.env.RMD_INSTANCE_REGISTRY, instanceName: process.env.RMD_INSTANCE_NAME }, log, opts.selectedModeFileIO);

  // Budget is a RUNAWAY TRIPWIRE, not an allowance (§9). The HARD cap defaults to
  // DEFAULT_BUDGET_USD ($100 — an order of magnitude above any observed task) when a
  // task omits it; the SOFT threshold ($25 default, config-tunable) only surfaces an
  // anomaly as a WARNING and never kills.
  const budgetUsd = task.budget_usd ?? DEFAULT_BUDGET_USD;
  const softThresholdUsd = softBudgetThreshold(config);

  // ── MOUNT RESOLUTION (§9; class axis W1-T167). The (task_type × risk × class)
  // routing table OWNS the model/effort/max_turns a run rides — never a
  // hardcoded literal (the W1-T6 defect: a dead mounts.yaml + a hardcoded
  // 60-turn ceiling, see docs/archive/DIAGNOSIS.md). Resolve ONCE here and FAIL LOUD on a
  // type/risk miss: a missing route is a config gap, never a silent fallback
  // to some default number. loadMounts throws on a bad/absent table;
  // resolveMountForClass throws on an unrouted (type × risk); an unrouted
  // CLASS is expected (not every class has a cheap row) and falls back to the
  // table's `src` default — LOUDLY, via the `mount.class_fallback` line below.
  // The table is a COMMITTED repo artifact (§9, golden-gated), read from the repo
  // checkout — resolution + the loud class-fallback ledgering live in
  // resolveRunMounts (exported, above) so every branch, including the fallback a
  // COMPLETE committed table can never reach, is unit-covered with fixture tables.
  const { mount, reviewerMount, fixMount, diagnoseMount, stepUpMount, reconMount, taskClass, mountClass } = resolveRunMounts(
    repoRoot,
    task,
    log,
  );
  const scopePointer = join(config.root, "state", "recovery", "build-scope", taskId, "latest.json");
  let scopeRecovery: ReturnType<typeof readBuildScopeRecovery> | undefined;
  let scopeWait: { amendmentUrl: string; paths: string[] } | undefined;
  if (existsSync(scopePointer)) {
    try {
      const pointer = JSON.parse(readFileSync(scopePointer, "utf8"));
      scopeRecovery = readBuildScopeRecovery(pointer.path, taskId);
      if (pointer.amendmentUrl && Array.isArray(pointer.paths) && pointer.paths.some((path: string) => !pathIsUnderDeclaredSurface(path, task.files ?? []))) {
        scopeWait = { amendmentUrl: pointer.amendmentUrl, paths: pointer.paths };
      }
    } catch (error) {
      scopeRecovery = { status: "unverifiable", path: scopePointer, reason: String(error) };
    }
  }
  log("run.start", {
    ...(scopeRecovery ? { scope_recovery: scopeRecovery.status, recovery_path: scopeRecovery.path,
      ...(scopeRecovery.status !== "verified" ? { recovery_reason: scopeRecovery.reason } : {}) } : {}),
    repo: task.repo,
    type: task.type,
    risk: task.risk,
    // W1-T167: the task's routing class (docs / plan-lint / src) and the class
    // the mount actually resolved to (differs from task_class only on a loud
    // fallback, logged above) — the pair the retro's per-class calibration
    // (lib/retro.ts's aggregateByClass) reads alongside this line's cost/verdict.
    task_class: taskClass,
    mount_class: mountClass,
    task_shape: dispatchTaskShape({ task, tasks: ctx.plan.tasks, ledgerPath, lane: "run-task", reconUnavailableReason: "recon-not-yet-run" }),
    provider: mount.provider,
    worker_role: "implementer",
    budget_usd: budgetUsd,
    soft_threshold_usd: softThresholdUsd,
    mount: { model: mount.model, effort: mount.effort, max_turns: mount.maxTurns, context_budget: mount.contextBudget },
  });

  if (scopeWait) {
    let state: string;
    try {
      state = await (opts.implementScopeAmendmentState ?? readBuildScopeAmendmentState)(scopeWait.amendmentUrl);
    } catch (error) {
      state = "unreadable";
      log("implement.scope_wait_unreadable", { amendment_url: scopeWait.amendmentUrl, reason: String(error) });
    }
    if (state !== "closed") {
      log("verdict", { verdict: "blocked_inflight", reason: "scope_amendment_pending", amendment_url: scopeWait.amendmentUrl,
        scopeAmendmentsPending: state === "open" ? 1 : 0, amendment_state: state, cost_usd: 0 });
      return { taskId, runId, merged: false, costUsd: 0, verdict: "blocked_inflight" };
    }
  }

  // The decision and its failure-tolerant arms live in `exploreMount`, which never throws; only real data sources are wired here.
  // `runId` is clock-derived, so no harness can steer this call onto explore — the arms are seamed.
  const explored = await exploreMount(
    {
      taskType: task.type,
      risk: task.risk,
      taskClass,
      currentMount: mount,
      config,
      runId,
      taskId,
      enabledProviders: enabledWorkerProviders(config),
    },
    {
      loadCells: async () => {
        const scriptUrl = pathToFileURL(join(repoRoot, "scripts", "mount-headroom-sweep.mjs")).href;
        const sweep = (await import(scriptUrl)) as {
          buildMountHeadroomSweep: (stateDir: string) => { cells: MountHeadroomCell[] };
        };
        return sweep.buildMountHeadroomSweep(join(config.root, "state")).cells;
      },
      loadMountsTable: () => loadMounts(mountsPath(repoRoot)),
      log,
    },
  );
  const implementMount = explored.mount;
  const implementConfig = explored.config;
  say(`run ${runId} — target ${owner}/${task.repo} · mount ${implementMount.model}/${implementMount.effort} · ${implementMount.maxTurns} turns (${task.type}×${task.risk}×${taskClass})`);

  // W1-T3573: `task.type` "review"/"manual" ride this SAME generic implement spawn (below) with
  // no dedicated dispatch path of their own, so — unlike `implement`/`diagnose`/`recon`, which
  // this deliberately leaves untouched — they get an EXPLICIT declared tool bound instead of the
  // spawn's unrestricted default. `resolveGenericRouteToolBound` is fail-closed: a lane it does
  // not name throws rather than resuming unrestricted, so this is only ever called for the two
  // lanes the table declares.
  const genericRouteTools =
    task.type === "review" || task.type === "manual" ? [...resolveGenericRouteToolBound(task.type)] : undefined;
  // W1-T3696 step (2): implement's surface is chosen from WHAT IS RUNNING IT. A cash-billed mount
  // gets the bounded, shell-less surface; Claude keeps exactly what it has today (unrestricted for
  // implement, the declared bound for review/manual) — this is a per-provider equivalence, never a
  // narrowing of the Claude lane to fit a cheaper one.
  const implementTools = implementToolBound(implementMount.provider, genericRouteTools);
  // Read from the SAME value the spawn is bounded with, so the contract a worker was given and the
  // verdict it is judged by cannot disagree. True for the shell-less cash surface above, and ALSO
  // when the operator has handed implement's git effects to the harness on every provider — the
  // opt-in that makes a Claude implement run divertible, because its prompt then already says so.
  const harnessOwnsGit = config.workerProviders?.harnessCommitsImplement === true
    || harnessOwnsGitFor(implementTools);
  // THE COHERENCE RULE, AND IT IS ONE LINE ON PURPOSE: a spawn may offer a shell-less divert
  // surface ONLY if it was told the harness owns git. Offering one to a worker whose prompt said
  // `git push` would hand it, on retry, a surface that cannot do what it was just asked to do.
  const implementCashTools = harnessOwnsGit ? [...IMPLEMENT_CASH_TOOLS] : undefined;
  const cashTrial = decideCashTrial({
    task,
    taskClass,
    config,
    harnessCommits: implementCashTools !== undefined,
    stateDir: dirname(ledgerPath),
  });
  if (cashTrial) log("cash_trial.decided", { arm: cashTrial.arm, reason: cashTrial.reason });
  const cashTrialSpawn = cashTrialSpawnFields(cashTrial, implementCashTools, cashTrialPolicy(config).models);

  /**
   * The subscription probes are intentionally shell-backed, so a blocked auction cannot run
   * them on cash. Cash has a different structural boundary: no shell, a fixed check table, and
   * a scrubbed environment. Accept it only when every later worker in this run has an explicit
   * cash equivalent, then pin all later spawns to cash so a recovered subscription cannot inherit
   * a proof for the wrong execution boundary.
   */
  const establishCashContainedRun = (preflight: "containment" | "isolation"): string | undefined => {
    const refusal = cashContainmentState.contained ? undefined : cashContainedRunRefusal(config, implementCashTools);
    if (refusal !== undefined) return refusal;
    const reason = cashContainmentBoundary(config.root);
    cashContainmentState.contained = true;
    log(`${preflight}.probe`, {
      provider: "cash",
      method: "structural-adapter-boundary",
      reason,
      subscription_probe: "blocked",
    });
    say(`${preflight} preflight PASSED on the cash adapter — ${reason}`);
    return undefined;
  };

  // W1-T2557: THE RUNAWAY BOUND — sized against THIS task's own class's OBSERVED turn-count
  // history (see `deriveRunawayTurnBound`'s own doc), read ONCE here rather than re-derived on
  // every poll tick. `taskClass` is only known from this point on (resolveRunMounts, above), so
  // the sensor is built with no bound and this call configures it as soon as one is available.
  // Best-effort and SILENT on failure (a bad/absent ledger or policy read must never block
  // dispatch) — the SAME "cannot observe, never a guess" polarity `WorkerStateTracker`'s own
  // UNKNOWN state already keeps, so an unresolved bound simply leaves the mid-flight runaway
  // signal quiet for this one run rather than fabricating a threshold nothing measured.
  try {
    const historyNdjson = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    const classTurnHistory = gatherRuns(parseLedger(historyNdjson))
      .filter((r) => (r.taskClass ?? "unknown") === taskClass && r.numTurns > 0)
      .map((r) => r.numTurns);
    workerStateSensor.setRunawayBound(deriveRunawayTurnBound(classTurnHistory, loadDefaultCostAnomalyPolicy()));
  } catch {
    // best-effort — see this block's own doc above.
  }

  let costUsd = 0;
  let budgetWarned = false;
  const account = (r: WorkerResult) => {
    costUsd += r.costUsd; // NOTIONAL on subscription — tripwire/meter only (FF10d)
    // SOFT threshold: ledger a WARNING once and CONTINUE — anomalies must be VISIBLE
    // without being FATAL. The hard cap (maxBudgetUsd, per spawn) remains the kill.
    if (softBudgetWarning(costUsd, softThresholdUsd, budgetWarned)) {
      budgetWarned = true;
      log("budget.warning", {
        cost_usd: costUsd,
        soft_threshold_usd: softThresholdUsd,
        hard_cap_usd: budgetUsd,
        note: "notional spend crossed the soft tripwire — NOT a kill; a run this expensive is likely looping",
      });
      say(`⚠️ budget.warning: notional $${costUsd.toFixed(2)} ≥ soft $${softThresholdUsd.toFixed(2)} (hard cap $${budgetUsd.toFixed(2)}) — continuing`);
    }
    return r;
  };

  // W1-T8676: the boundary checkpoint this run restored, which `failOnWorkerError` keeps through a worker error.
  let restoredCheckpoint: { branch: string; headSha: string } | undefined;
  /** W1-T8676/W1-T9786: the restored checkpoint a failed exit keeps, unless this run pushed its own branch (the newer
   *  checkpoint, W1-T7837). Read while the worktree stands; only a proven absence (exit 1) keeps it. */
  const checkpointToKeep = (): { branch: string; headSha: string } | undefined => restoredCheckpoint !== undefined &&
    hostWorktreeGitResult(worktreePath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).status === 1
    ? restoredCheckpoint : undefined;
  /**
   * A worker returned an ERROR envelope (max_turns, max_budget_usd, execution
   * error). Turn it into a terminal verdict: clean the worktree so no debris
   * survives, ledger the verdict WITH num_turns + cost_usd (a failed run is never
   * free in the ledger), and return. A budget breach is verdict=blocked_budget
   * and is NEVER retried — dollars are the hard backstop. Any other error is
   * `failed`. Returns null when the result is not an error (caller proceeds).
   */
  const failOnWorkerError = (r: WorkerResult, stage: string, reason?: string): RunResult | null => {
    const v = workerErrorVerdict(r, costUsd, stage);
    if (!v) return null;
    // W1-T8676: a worker error is not the checkpoint's fault.
    const keptCheckpoint = v.verdict === "failed" ? checkpointToKeep() : undefined;
    try {
      worktreeRemove(repoDir, worktreePath);
      log("worktree.remove", { on: `${stage}.error` });
    } catch (e) {
      log("worktree.remove.error", { on: `${stage}.error`, error: String((e as Error)?.message ?? e) });
    }
    log("verdict", { ...v.ledger, ...terminalVerdictFields(r), ...(reason ? { reason } : {}) });
    if (keptCheckpoint) {
      log("implement.checkpoint_kept", { task_id: taskId, source_branch: keptCheckpoint.branch, head_sha: keptCheckpoint.headSha,
        failed_stage: stage, failed_subtype: r.subtype });
    }
    say(
      `verdict: ${v.verdict} (${r.subtype}) at ${stage} · ${r.numTurns} turns · notional $${costUsd.toFixed(4)}`,
    );
    return { taskId, runId, merged: false, costUsd, verdict: v.verdict };
  };

  // ── Validate-before-spawn guard (FF10a): reject a bad settings file BY NAME.
  const settingsFile = renderWorkerSettings({
    templatePath: join(resolveInstallRoot(config), "settings", "worker.json"),
    hooksDir: join(resolveInstallRoot(config), "hooks"),
    outPath: join(config.root, "tmp", `worker-settings-${runId}.json`),
  });
  validateWorkerSettingsFile(settingsFile); // throws WorkerSettingsError if invalid
  log("settings.validated", { settingsFile });
  say("worker settings validated against pinned SandboxSettingsSchema");

  // ── BINARY-PIN RUNG (wires checkBinaryPin, which shipped with no production caller).
  //
  // WHY HERE. It runs on the WORKER'S HOST, once per run, in the same preflight block as the two
  // probes below — the mismatch bites where a worker spawns, not in CI, and the granularity that
  // is right for containment is right for this: the binary is constant across every spawn in a run.
  // It is placed FIRST because it is the cheapest reading that could explain either probe failing.
  //
  // LOUD AND NON-BLOCKING, and that is checkBinaryPin's OWN stated contract, not a softening
  // invented here: it "returns {drift: true, reason} naming both versions, so a caller can LEDGER
  // the drift and CONTINUE rather than hard-fail: the operator still updates the CLI deliberately,
  // so this makes a swap VISIBLE and INTENTIONAL, never impossible". Two facts agree with it. The
  // fleet has been running on a mismatch (declared 2.1.220, operator host 2.1.227) and merging PRs
  // throughout, so a mismatch is demonstrably not fatal. And a refusal here would be the FIFTH
  // bound in this repo measured firing on a healthy condition — it would meet the operator at the
  // door on a host that is mismatched TODAY.
  const binaryPin = readBinaryPin(opts.binaryPinDeps ?? defaultBinaryPinDeps(config.claudeBin));
  log("preflight.binary_pin", {
    status: binaryPin.status,
    declared_version: binaryPin.declaredVersion,
    observed_version: binaryPin.observedVersion,
    reason: binaryPin.reason,
  });
  if (binaryPin.status !== "match") say(`binary pin ${binaryPin.status.toUpperCase()} — ${binaryPin.reason}`);

  // ── PROBE ADMISSION (W1-T5346): reuse this process's last passing proof only while every input the
  // probes read is unchanged. See `probeVerdictKey`'s section above for the fail-closed contract.
  const probeCache = opts.probeVerdictCache
    ?? (opts.containmentExec !== undefined || opts.isolationExec !== undefined ? createProbeVerdictCache() : PROCESS_PROBE_VERDICTS);
  let probeKey: string | undefined;
  let probeKeyError = "";
  try {
    probeKey = probeVerdictKey(readProbeKeyInputs({
      settingsFile,
      runId,
      hooksDir: join(resolveInstallRoot(config), "hooks"),
      imageBuildShaPath: opts.probeKeySources?.imageBuildShaPath ?? IMAGE_BUILD_SHA_PATH,
      harnessRevision: opts.probeKeySources?.harnessRevision ?? JSON.stringify(workerBoundaryStack.harnessRevision),
      cliVersion: binaryPin.observedVersion,
      provider: implementMount.provider ?? "claude",
      claudeBin: config.claudeBin,
      root: config.root,
    }));
  } catch (error) {
    // UNKEYED, not unproven: the `probe_cache.miss` row below records this error and the run probes.
    probeKeyError = String((error as Error)?.message ?? error).slice(0, 300);
  }
  const probeTicket = probeCache.open();
  const cachedProof = probeKey === undefined ? undefined : probeCache.lookup(probeKey);
  if (cachedProof === undefined) {
    const heldReason = probeCache.heldReason;
    log("probe_cache.miss", {
      probe_key: probeKey ?? null,
      reason: probeKey === undefined ? `unkeyed: ${probeKeyError}` : heldReason !== undefined ? `held: ${heldReason}` : "no-entry",
    });
  }
  /** A cached pass, ledgered on the probe's OWN step so every reader of probe history sees it. */
  const reuseProof = (preflight: "containment" | "isolation", proof: ProbeProof) => {
    const reason = preflight === "containment" ? proof.containmentReason : proof.isolationReason;
    log(`${preflight}.probe`, {
      [preflight === "containment" ? "contained" : "isolated"]: true,
      reason,
      cost_usd: 0,
      cached: true,
      probe_key: probeKey,
      proved_by_run: proof.runId,
      proved_at: proof.provedAt,
      age_ms: systemClock.now() - proof.provedAtMs,
    });
    return { reason: `${reason} (reused from run ${proof.runId})`, costUsd: 0 };
  };
  let containmentProven: string | undefined;
  let isolationProven: string | undefined;

  // ── Post-spawn CONTAINMENT PREFLIGHT (W1-T2 #2 / WS-0 verdict 7 / Standing rule 11). Validation
  // proves the file WELL-FORMED, not that the sandbox ENGAGED (`-p` silently runs unsandboxed — FF10a).
  // Once per boot and on any change of its inputs (`probeVerdictKey`, W1-T5346), empirically confirm an
  // outside-cwd write is OS-DENIED; otherwise `reuseProof` replays that verdict — never assumed from
  // configuration. FAIL CLOSED: containment unproven ⇒ the run does not proceed.
  try {
    const probe = cachedProof !== undefined ? reuseProof("containment", cachedProof) : await probeContainment({
      settingsFile,
      config,
      budgetUsd,
      log: (s, extra) => log(s, extra),
      exec: opts.containmentExec,
    });
    costUsd += probe.costUsd; // meter the probe spawn (notional; the ledger has it)
    say(`containment preflight PASSED — ${probe.reason}`);
    containmentProven = probe.reason;
  } catch (caught) {
    probeCache.hold(`containment: ${String((caught as Error)?.message ?? caught).slice(0, 300)}`);
    let e: unknown = caught;
    // A capacity block says the shell-backed probe cannot run, not that containment failed.  The
    // cash adapter has no shell to probe; establish its separate boundary and pin this run to it.
    if (e instanceof ProviderCapacityBlockedError && cashContainedRunRefusal(config, implementCashTools) === undefined) {
      try {
        establishCashContainedRun("containment");
        e = undefined;
      } catch (error) {
        const detail = String((error as Error)?.message ?? error);
        log("containment.probe", {
          provider: "cash",
          method: "structural-adapter-boundary",
          reason: "cash_adapter_boundary_unproven",
          detail,
        });
        e = new ContainmentError(
          `containment preflight: cash adapter boundary could not be proven — ${detail}`,
          "cash-adapter-boundary",
          "unproven",
        );
      }
    }
    if (e instanceof ContainmentError) {
      log("verdict", {
        verdict: "blocked_containment",
        reason: e.message,
        // W1-T91/P23 (i): structured guard-cause alongside the prose reason — a
        // guard-fired block reads as INFRASTRUCTURE at retro-read time without
        // parsing prose (plan/mast-mapping.yaml's infrastructure row).
        guard: e.guard,
        check: e.check,
        observed: e.observed,
        cost_usd: costUsd,
        billing_mode: billingMode(e.childEnvKeys),
        account_label: e.accountLabel,
        ...terminalVerdictFields(null),
      });
      say(`verdict: blocked_containment — ${e.message}`);
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_containment" };
    }
    if (e !== undefined) {
      // W1-T4701: a capacity block is a deferral daemon.ts backs off on; the run still ends here.
      endThrownRun(log, verdictWritten, "preflight.containment", e, costUsd);
      throw e;
    }
  }

  // ── Isolation PREFLIGHT (W1-T17 / Standing rule 11 / FIELD FINDING 11b): the current shell
  // isolation (CLAUDE_CODE_SHELL routing the Bash-tool snapshot to an empty rc) works ONLY because
  // THIS host's `~/.bashrc` happens to be absent — an accident of the machine, not construction
  // (LEARNINGS.md). A populated `~/.bashrc` would silently isolate NOTHING. Once per boot and on any
  // change of its inputs (`probeVerdictKey`, W1-T5346), empirically confirm a worker inherits ZERO
  // operator aliases/functions before any task worker runs; otherwise `reuseProof` replays that
  // verdict — never assumed from configuration. FAIL CLOSED: a nonzero count means isolation is not
  // holding on this host — the run refuses to start.
  try {
    if (cashContainmentState.contained) {
      // No shell exists on the cash adapter, so the shell alias/function probe is inapplicable.
      // Re-run the adapter's executable boundary check rather than treating an absent shell probe
      // as a successful one.
      establishCashContainedRun("isolation");
    } else {
      const isoProbe = cachedProof !== undefined ? reuseProof("isolation", cachedProof) : await probeIsolation({
        settingsFile,
        config,
        budgetUsd,
        log: (s, extra) => log(s, extra),
        exec: opts.isolationExec,
      });
      costUsd += isoProbe.costUsd; // meter the probe spawn (notional; the ledger has it)
      say(`isolation preflight PASSED — ${isoProbe.reason}`);
      isolationProven = isoProbe.reason;
    }
  } catch (caught) {
    probeCache.hold(`isolation: ${String((caught as Error)?.message ?? caught).slice(0, 300)}`);
    let e: unknown = caught;
    if (e instanceof ProviderCapacityBlockedError && cashContainedRunRefusal(config, implementCashTools) === undefined) {
      try {
        establishCashContainedRun("isolation");
        e = undefined;
      } catch (error) {
        const detail = String((error as Error)?.message ?? error);
        log("isolation.probe", {
          provider: "cash",
          method: "structural-adapter-boundary",
          reason: "cash_adapter_boundary_unproven",
          detail,
        });
        e = new IsolationError(
          `isolation preflight: cash adapter boundary could not be proven — ${detail}`,
          "unproven",
        );
      }
    }
    if (e instanceof IsolationError) {
      log("verdict", {
        verdict: "blocked_isolation",
        reason: e.message,
        // W1-T91/P23 (i): structured guard-cause alongside the prose reason — see
        // the identical comment on the ContainmentError branch above.
        guard: e.guard,
        check: e.check,
        observed: e.observed,
        cost_usd: costUsd,
        billing_mode: billingMode(e.childEnvKeys),
        account_label: e.accountLabel,
        ...terminalVerdictFields(null),
      });
      say(`verdict: blocked_isolation — ${e.message}`);
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_isolation" };
    }
    if (e !== undefined) {
      endThrownRun(log, verdictWritten, "preflight.isolation", e, costUsd);
      throw e;
    }
  }
  // W1-T5346: store only a FRESH, clean shell pass of BOTH probes. A cash-routed run proved a
  // different boundary, so it is never stored (its capacity-blocked probe already held the cache).
  if (cachedProof === undefined && probeKey !== undefined && containmentProven !== undefined && isolationProven !== undefined) {
    const recorded = probeCache.recordPass(probeKey, { runId, provedAtMs: systemClock.now(), provedAt: systemClock.iso(), containmentReason: containmentProven, isolationReason: isolationProven }, probeTicket);
    log("probe_cache.recorded", { probe_key: probeKey, recorded });
  }

  // ── Clone + worktree.
  const repoDir = join(config.root, "repos", task.repo);
  if (!existsSync(repoDir)) {
    mkdirSync(dirname(repoDir), { recursive: true });
    ghExec(["repo", "clone", `${owner}/${task.repo}`, repoDir], { stdio: "inherit" });
  }

  // ── CROSS-HOST DISPATCH CLAIM (W1-T1268), TAKEN BEFORE ANY SPEND ────────────────────────────
  // HERE, right after the clone is guaranteed to exist and before pruneStaleRuns/worktreeAdd —
  // no worktree, no branch, no run lock and no worker have been touched yet, so a refusal below
  // costs nothing to unwind. This closes the STRICTLY CROSS-HOST, STRICTLY PRE-ARTIFACT gap the
  // ten `isDispatchEligible` probes (src/lib/drain.ts) cannot: `isOpenPr`/`hasPushedRunBranch`
  // both read a PUBLISHED artifact, and neither exists at the moment a second host — or an
  // operator dispatching by hand beside the fleet — starts the SAME task. `repoDir`, not
  // `repoRoot`: see {@link dispatchClaimReserverFor}'s own doc for why.
  // AWAITED, never `spawnSync` (2026-10-06): runTask runs inside the daemon process, and this
  // claim's sync git was the loop's largest holder — 89 loop_lag rows, 1,506 s, up to 106 s each.
  const claimReserver = opts.claimReserver ?? dispatchClaimReserverAsyncFor(repoDir);
  let claimAnchor = await claimReserver.mintAnchor();
  const claimOutcome = await claimReserver.attempt(task.id, claimAnchor);
  const claimHolder = claimOutcome === "taken" ? await claimReserver.holder(task.id) : undefined;
  // W1-T2552: the failing attempt's OWN git stderr, threaded into the refusal so an unreachable
  // verdict names its cause instead of only its category. Optional on the interface, so a test's
  // fake reserver that does not implement it yields today's wording byte-for-byte.
  const claimDecision = decideDispatchClaim(claimOutcome, {
    taskId: task.id,
    holder: claimHolder,
    stderr: claimOutcome === "unreachable" ? claimReserver.lastAttemptStderr?.() : undefined,
  });
  log("dispatch.claim", {
    ref: dispatchClaimRef(task.id),
    outcome: claimOutcome,
    proceed: claimDecision.proceed,
    reason: claimDecision.reason,
  });
  if (!claimDecision.proceed) {
    let reclaimedAnchor: string | undefined;
    // CONTENTION CARRIES ITS OWN EVIDENCE: `isMerged(task)` is the SAME projection this run
    // already computed above (the W1-T319 already-merged guard) — exactly one of the three
    // signals (`isMerged`, `readLiveState`/`isLiveMergeCredited`, `closedUnmergedRunBranches`)
    // the dispatch rung's own probes already read, re-used rather than re-derived. A claim
    // whose task is demonstrably merged is stale and this run (the loser) is exactly the run
    // holding fresh proof of it, so it drops the stale ref rather than leaving it for a THIRD
    // lane to find blocked by a dead claim. The refusal below stands either way.
    if (claimOutcome === "taken") {
      // W1-T2784: the DEAD-CLAIMANT probe, supplied HERE and nowhere else — this is the only
      // path that meets a claim it does not own with no landed evidence, i.e. the exact case
      // that was producing permanent refs. See `decideDispatchClaimRelease`'s arm 3 for why the
      // narrow same-host/predates-boot shape is decidable when general cross-host liveness is
      // not. The probe is a THUNK: `releaseDispatchClaim` only calls it once an anchor has
      // actually parsed, so arms 1 and 2 still cost no /proc read and no git round trip.
      // The awaited release hands the probe the anchor it already parsed, so the pid is read from
      // the SAME git answer that decided the arm — no second fetch + cat-file round trip.
      const released = await releaseDispatchClaimAsync(task.id, claimReserver, {
        evidenceObserved: isMerged(task),
        livenessProbe: (anchor) => {
          const namespaceBootMs = readNamespaceBootMs();
          if (namespaceBootMs === undefined) return undefined; // declines to the operator arm
          return {
            localHost: hostname(),
            namespaceBootMs,
            namespaceBootIso: new Date(namespaceBootMs).toISOString(),
            pidPresent: pidIsPresent(anchor.pid),
          };
        },
      });
      log("dispatch.claim_released", {
        ref: dispatchClaimRef(task.id),
        arm: released.arm,
        release: released.release,
        dropped: released.dropped,
        reason: released.reason,
      });
      // LOUD ON THE CONSOLE TOO, not only in the ledger (design note): this arm DELETES a lock a
      // peer might believe it holds, so the operator reading stdout must see it happen and see
      // which signals decided it — the ledger row alone is a record nobody is watching live.
      if (released.arm === "dead-claimant") say(`RELEASED a dead claim — ${released.reason}`);
      if (!released.release)
        reclaimedAnchor = (await reclaimSilentDispatchClaim(task.id, claimReserver, { run: gitClaimRunnerAsync(repoDir), stateDir: dirname(ledgerPath), log, say })).anchor;
    }
    if (reclaimedAnchor === undefined) {
      say(`REFUSED: ${claimDecision.reason}`);
      // `unreachable` mirrors `blocked_git_fetch`'s own "cannot reach origin" refusal (this IS a
      // git-connectivity failure, not a new failure mode); `taken` mirrors `blocked_inflight`'s
      // own "another holder owns this run right now" (this IS that condition, cross-host instead
      // of same-host) — no new RunResult verdict is introduced for either arm.
      // W1-T4708: ledgered too, or the refused run read as in flight to every reader.
      const refused: RunResult = {
        taskId,
        runId,
        merged: false,
        costUsd: 0,
        verdict: claimOutcome === "unreachable" ? "blocked_git_fetch" : "blocked_inflight",
      };
      return endRefusedRun(log, verdictWritten, "dispatch.claim", refused, claimDecision.reason);
    }
    claimAnchor = reclaimedAnchor;
  }

  // ── Reclaim debris from crashed prior runs (WS-1: a max-turns death left its
  // run-* worktree + branch behind). Do this BEFORE adding ours so leftovers can
  // never block the new worktree/branch. Best-effort; ledger what was reclaimed.
  const pruned = pruneStaleRuns(repoDir, worktreesDir(config), { graceMs: DEFAULT_PRUNE_GRACE_MS });
  if (pruned.worktrees.length || pruned.branches.length || pruned.skipped.length) {
    log("worktree.prune", { worktrees: pruned.worktrees, branches: pruned.branches, skipped: pruned.skipped });
    say(
      `pruned ${pruned.worktrees.length} stale worktree(s), ${pruned.branches.length} branch(es)` +
        (pruned.skipped.length ? `; SKIPPED ${pruned.skipped.length} live worktree(s)` : ""),
    );
  }
  // W1-T406: pruneStaleRuns (above) only reclaims what git's OWN worktree registry still
  // names — it leaves three coverage holes (git-invisible dirs, detached-HEAD `sweep-*`
  // orphans, widowed `.lock` files) that only reapStaleWorktrees closes, and this one-shot
  // dispatch never reaches the daemon poll or `rmd sweep` call site that would otherwise run
  // it. Best-effort and ships dry (`worktreeReapBoot.enabled`) — see logWorktreeReapBootSurvey.
  logWorktreeReapBootSurvey(config, log);
  // W1-T2847: the SAME start-of-run rung, pointed at the ad-hoc lane root. MEASURED 2026-09-04:
  // `worktreesDir` (the only root the line above ever scans) held 11 entries totalling 44K while
  // 180 linked worktrees totalling 4.7G sat as its SIBLINGS under config.root, reached by nothing
  // on any cadence. Ships SURVEY-ONLY — `runAdhocLaneReapRung`'s `enabled` seam defaults false, so
  // this ledgers what it would reclaim and removes nothing; arming it is an operator decision that
  // earns its own policy key once several passes' dispositions have been read, exactly the posture
  // `worktreeReapBoot` shipped in.
  //
  // SCOPE: `src/run-task.ts` is NOT in W1-T2847's declared `files:`. The shard's own note invites
  // this — "the rung wiring already exists via runWorktreeReapRung, and an implementer who needs
  // it should widen the shard deliberately rather than inherit it" — and it is needed: a rung with
  // no call site is a dead parameter (the #339/W1-T281 shape, where deleting the call fails no
  // test). Recorded here and in the PR body because the linter refuses the shard edit that would
  // record it in `files:`; the reviewer's `scope_violation` is advisory and names review-ratified
  // widenings legitimate.
  // W1-T2847: ARMED from policy, not from a hardcoded default. The rung's own doc calls arming "a
  // separate operator decision"; until this row existed the call site passed no `enabled` at all,
  // so the decision had nowhere to live and the pass was permanently survey-only. Every refusal
  // underneath is unchanged — live pid, live upstream branch, incomplete probe, 14-day ceiling.
  runAdhocLaneReapRung(config, log, { repoDir, enabled: () => opts.armAdhocLaneReap ?? loadDefaultPolicy().values.sweep.armAdhocLaneReap });
  // W1-T411: three MORE sweeps with call sites only inside daemonCommand — stale rmd temp
  // dirs, abandoned review clones, and per-spawn worker homes — get the SAME start-of-run
  // reclaim rung pruneStaleRuns and logWorktreeReapBootSurvey already occupy. Unlike the
  // worktree reaper above, all three already run ARMED wherever they run today, so this needs
  // no dry-run flag of its own — see logDiskReclaimRung.
  await logDiskReclaimRung(config, log, { objectOwnInflightLock: basename(inflightLockPath(join(config.root, "state", "inflight"), taskId)) });

  const branch = `run-${runId}`;
  const worktreePath = join(worktreesDir(config), branch);
  // W1-T4356: nothing else fast-forwards repos/<repo>, so a lockfile change on main left every implement dispatch refused by
  // W1-T4193 below. A refusal here is that same deferral, raised before a worktree exists.
  let checkoutRefresh: ManagedCheckoutRefresh;
  try {
    checkoutRefresh = await retryWhileLockBusy(
      () => refreshManagedCheckout(repoDir, join(config.root, "state", `managed-checkout-${task.repo}.lock`), log, opts.managedCheckoutInstall, (failure) => {
        void tryEscalate(managedCheckoutInstallEscalation(failure, task.id, runId), { issues: opts.prOpenRefusalIssues ?? ghIssueGateway(owner, task.repo), ledgerPath, runId });
      }),
      isManagedCheckoutLockBusy,
      { log },
    );
  } catch (e) {
    log("managed_checkout.refresh_refused", { reason: String((e as Error)?.message ?? e) });
    // W1-T4701: above the outer catch, so without this row the deferred run read as in flight forever.
    endThrownRun(log, verdictWritten, "managed_checkout.refresh", e, costUsd);
    await releaseDispatchClaimAsync(task.id, claimReserver, { anchor: claimAnchor });
    throw e;
  }
  // W1-T405: worktreeAdd itself asserts base currency and throws WorktreeBaseStaleError before
  // recon/implement/commit spend anything, so a stale base is refused HERE rather than surfacing
  // after a full run as the scope guard's "forged merge-base" misdiagnosis. Verdict stays
  // "failed", the scope guard's own verdict for that condition, so drain.ts needs no new case.
  try {
    // LIVENESS TOKEN: a SIBLING file (never committed), so a concurrent pruneStaleRuns skips this
    // worktree instead of `--force`-removing it; dropped at terminal verdict (the finally below) or
    // by the catch below, and a crashed run's dead pid lets prune reclaim it (docs/archive/DIAGNOSIS.md).
    // W1-T5280: written BEFORE the 5-10 minute add, or a same-process DAEMON lane's prune removes the
    // registered, lockless worktree mid-add (2026-10-01 17:28:16Z). The empty dir comes first because
    // reapStaleWorktrees' widowed-lock pass deletes a `.lock` whose directory does not exist yet.
    // W1-T4356: written BEFORE the checkout lock is released, so a peer's refresh sees this borrower.
    mkdirSync(worktreePath, { recursive: true });
    writeRunLock(worktreePath, { pid: process.pid, run_id: runId, startedAt: new Date().toISOString() });
    // W1-T2621: `log` goes last so a test's `worktreeBaseDeps` can never swallow this run's ledger.
    // W1-T4193: the implement lane, and only it, refuses a same-package lockfile mismatch (the arm below defers it).
    await worktreeAddAsync(repoDir, worktreePath, branch, "origin/main", { ...opts.worktreeBaseDeps, log, refuseSamePackageLockfileMismatch: true });
  } catch (caught) {
    removeRunLock(worktreePath); // W1-T5280: no arm below hands this worktree on
    // W1-T4356: a refusal over a checkout the refresh had to leave behind names why it was left.
    const e = caught instanceof WorktreeNodeModulesRefusedError && checkoutRefresh.kind === "skipped"
      ? new ManagedCheckoutNotRefreshedError(caught, checkoutRefresh.reason)
      : caught;
    if (e instanceof WorktreeBaseStaleError) {
      log("worktree.stale_base", { base: e.base, remote_head: e.remoteHead, ref: e.ref, behind: e.behind });
      say(
        `REFUSED: worktree base ${e.base} is behind origin/${e.ref}'s remote head ${e.remoteHead} — ` +
          "refusing before recon/implement/commit spend anything",
      );
      // W1-T4708: the terminal row lands BEFORE the release, so a throwing release cannot lose it.
      const refused = endRefusedRun(log, verdictWritten, "worktree.stale_base", { taskId, runId, merged: false, costUsd: 0, verdict: "failed" }, e.message);
      // W1-T1268: this run already holds the dispatch claim taken above — drop it (holder arm)
      // before returning, or a stale base on THIS host would strand the claim for an operator
      // to clear even though nothing is actually in flight.
      await releaseDispatchClaimAsync(task.id, claimReserver, { anchor: claimAnchor });
      return refused;
    }
    if (e instanceof WorktreeNodeModulesRefusedError) {
      // W1-T4193: a DEFERRAL, not a strike. Rethrown so daemon.ts's `isSpawnInfraBlocked` backs off on its
      // `blocked_toolchain` tag; the claim is dropped first, or every later dispatch would meet it as taken.
      log("worktree.node_modules_refused", {
        package: e.packageName,
        worktreePath: e.worktreePath,
        node_modules_source: e.nodeModulesSource,
        ...(e instanceof ManagedCheckoutNotRefreshedError ? { managed_checkout_not_refreshed: e.notRefreshed } : {}),
      });
      endThrownRun(log, verdictWritten, "worktree.node_modules", e, costUsd);
      say(`REFUSED: ${e.message}`);
      try {
        worktreeRemove(repoDir, worktreePath);
        log("worktree.remove", { on: "node_modules_refused" });
      } catch (removeErr) {
        log("worktree.remove.error", { on: "node_modules_refused", error: String((removeErr as Error)?.message ?? removeErr) });
      }
      try {
        await releaseDispatchClaimAsync(task.id, claimReserver, { anchor: claimAnchor });
      } catch (releaseErr) {
        // Never replace the typed refusal: a generic throw here would read as a fatal crash, not a deferral.
        log("dispatch.claim_release_error", { error: String((releaseErr as Error)?.message ?? releaseErr) });
      }
      throw e;
    }
    // W1-T2528: any OTHER add failure — ledger it before rethrowing (same idiom as `addLaneWorktree`).
    log("worktree.add_failed", { branch, error: String((e as Error)?.message ?? e) });
    endThrownRun(log, verdictWritten, "worktree.add", e, costUsd);
    try {
      rmdirSync(worktreePath); // only the EMPTY dir made above; a partly-built worktree stays for prune
    } catch {
      // not empty, or already gone — either way nothing of this run's is left to free
    }
    // W1-T5280: drop the claim AFTER the terminal row (W1-T4708), or the next dispatches read
    // `blocked_inflight` until the breaker trips; a throwing release never replaces the add's error.
    try {
      await releaseDispatchClaimAsync(task.id, claimReserver, { anchor: claimAnchor });
    } catch (releaseErr) {
      log("dispatch.claim_release_error", { error: String((releaseErr as Error)?.message ?? releaseErr) });
    }
    throw e;
  } finally {
    checkoutRefresh.release();
  }
  // W1-T9374: this fresh main worktree has a usable install even when repos/<repo> is unborrowed.
  // Fill the shared store off-loop and unawaited; the builder writes its own --out, never this tree.
  log("child_entry.store_build_requested", { source: "run-worktree", tree: worktreePath, checkout_kind: checkoutRefresh.kind });
  void buildIntoStore(worktreePath, {
    storeRoot: childEntryStoreRoot(config.root),
    log,
    liveTrees: () => listRegisteredWorktrees(repoDir).map(({ path }) => path),
  }).then((stored) => buildEngineAfterStore(worktreePath, join(config.root, "state"), childEntryStoreRoot(config.root), stored, log));
  // W1-T2626 (design note (iii)): a single unreadable remote head is already ledgered --
  // `worktree.add`'s `remote_head: "unreadable"` plus its `worktree.base_uncheckable`
  // companion, both from worktreeAdd itself -- but nothing yet distinguished "this happened
  // once" from "this guard has not actually measured anything in N creations running". Read
  // the ledger back and name that run explicitly, once it crosses the bound, so an operator
  // (or the retro) finds ONE line rather than reconstructing a streak by counting warnings
  // across a session. Never refuses, never repairs -- only the record (see this task's
  // rationale: "no refusal, no policy, no repair").
  const uncheckableStreak = detectWorktreeBaseUncheckableStreak(readLedgerLines(ledgerPath));
  if (uncheckableStreak.degraded) {
    log("worktree.base_check_degraded", {
      ref: "main",
      consecutive_unreadable: uncheckableStreak.consecutiveUnreadable,
      threshold: WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND,
      oldest_ts: uncheckableStreak.oldestTs,
      newest_ts: uncheckableStreak.newestTs,
    });
  }

  const claimLease = holdDispatchClaim(task.id, claimReserver, claimAnchor, { log });
  try {
    const checkpoint = pendingWorkerBoundaryHandoffs(readLedgerRawLines(ledgerPath)).get(taskId);
    if (checkpoint) {
      try {
        const restored = await restoreBoundaryCheckpoint(checkpoint, taskId, (args) => hostWorktreeGitAsync(worktreePath, args), log);
        if (!(restored.base === "main" && restored.dropped)) {
          restoredCheckpoint = checkpoint;
          log("implement.checkpoint_restored", { source_branch: checkpoint.branch, source_head_sha: checkpoint.headSha, branch,
            base: restored.base, restored_head_sha: restored.headSha,
            ...(restored.sourceBranchAbsent ? { source_branch_absent: true } : {}),
            ...(restored.base === "checkpoint" ? { main_conflicts: restored.mainConflicts, merge_unreadable: restored.reason } : {}) });
        }
      } catch (error) {
        log("verdict", { verdict: "no_pr", reason: "restart_checkpoint_restore_failed", branch,
          source_branch: checkpoint.branch, detail: String((error as Error)?.message ?? error), cost_usd: costUsd });
        return { taskId, runId, merged: false, costUsd, verdict: "no_pr" };
      }
    }
    let scopeRecoveryPrompt = "";
    if (scopeRecovery?.status === "verified" && !scopeWait) {
      try {
        const paths = [...scopeRecovery.data.committedPaths, ...scopeRecovery.data.companions.map((c) => c.path)];
        if (paths.some((path) => !pathIsUnderDeclaredSurface(path, task.files ?? []))) throw new Error("saved paths are outside the amended task scope");
        await restoreBuildScopeRecovery(scopeRecovery.data, worktreePath, (args) => hostWorktreeGit(worktreePath, args));
        log("implement.scope_restored", { recovery_path: scopeRecovery.path, source_head_sha: scopeRecovery.data.headSha, paths });
        scopeRecoveryPrompt = `\nRecovered build work from ${scopeRecovery.data.branch} after scope amendment ${scopeRecovery.data.amendmentUrl}. ` +
          "The saved harness changes and companions are present as uncommitted edits. Continue this work and include it in your report.\n";
      } catch (error) {
        log("implement.scope_recovery_fresh", { recovery_path: scopeRecovery.path, reason: String(error) });
      }
    } else if (scopeRecovery) {
      log("implement.scope_recovery_fresh", { recovery_path: scopeRecovery.path,
        reason: scopeRecovery.status === "verified" ? "amendment closed without granting scope" : scopeRecovery.reason });
    }
    // ── Recon (read-only).
    say("recon worker");
    // W1-T37 / MASTER-PLAN §8A Tier 2: the plan is RETRIEVED, not injected — the recon prompt
    // carries a content-hash-cached PLAN INDEX derived from the master plan, not the plan body.
    // `loadPlanIndex` is non-fatal when the source is missing and never writes a generated file.
    const planIndex = loadPlanIndex(resolveRepoLayout(join(dirname(planPath), "..")).masterPlan);
    const planIndexBlock = planIndex ? renderPlanIndex(planIndex) : "";
    // W1-T164: task-scoped operator guidance notes — read from the durable console-editable
    // store (`repoRoot`, the SAME root worker.ts's question store reads/writes), scoped strictly
    // to THIS task's id (never another task's), and rendered ONCE so the identical block injects
    // into both the recon prompt below and the implement prompt further down.
    const operatorNotes = loadOperatorNotesForTask(repoRoot, task.id);
    const operatorNotesBlock = renderOperatorNotes(operatorNotes);
    log("operator_notes.injected", { count: operatorNotes.length });
    // W1-T2632: HOISTED from further below (was computed only after recon returned, "since
    // recon already relayed all of this" — a premise `renderReconPrompt`'s own doc disproves).
    // ONE lookup shared by the recon prompt below AND the post-recon CONTEXT block further
    // down, never re-derived: `taskRecordPath` is fail-soft (`undefined` on an unresolvable
    // record) and `workerVisibleRecordPath` (W1-T501) re-anchors it to the WORKER's own tree,
    // never the orchestrator's `planPath`.
    // W1-T2920: `plan` (loaded a few lines above) already carries every task's `sourcePath`, so
    // this is a `Map.get` rather than the walk-and-reparse-every-shard fallback — the cost this
    // task exists to stop paying once per dispatch prompt.
    const recordPath = workerVisibleRecordPath(planPath, taskRecordPath(planPath, taskId, ctx.plan));
    ctx.releasePlan?.();
    // impl-BP: model/effort come from the RECON row of the mount table (task_type "recon" ×
    // risk × class, §9) — the same discipline the implement spawn ~100 lines below states as
    // "never a hardcoded literal". These were simply absent, so every recon ran on the SDK
    // default and `routes.recon` was dead data.
    //
    // `undefined` is a SUPPORTED value, not a bug: `lib/worker.ts`'s `if (args.model)` /
    // `if (args.effort)` guards leave the option unset, which is exactly today's behaviour.
    // That is what makes an absent/unreadable `recon:` row inert here — see resolveRunMounts.
    //
    // Hoisted into a closure (W1-T299) so the SAME spawn can be issued a bounded second time
    // on a worker error, below — never a copy-pasted second call site to drift out of sync.
    const spawnRecon = () =>
      spawn({
        cwd: worktreePath,
        permissionMode: "bypassPermissions",
        // W1-T3616: recon's prompt names `git remote -v`, `git log --oneline -5` and `ls`, so its
        // honest bound includes Bash. Read-only, so no Write/Edit.
        tools: [...resolveDispatchLaneToolBound("recon", reconMount?.provider ?? "claude")],
        // W1-T3726: plus the surface to use if the auction BLOCKS — see cashDivertSpawnFields.
        ...cashDivertSpawnFields("recon"),
        settingsFile,
        model: reconMount?.model,
        mountProvider: reconMount?.provider,
        effort: reconMount?.effort,
        // maxTurns DELIBERATELY NOT taken from the mount, and the ROW agrees with this cap.
        // impl-BP flagged a 50x contradiction (rows said 400, this said 8); the operator ruled the
        // ROW moves rather than this bound moving to 400, so recon stays cheap on every dispatch
        // and the table no longer asserts something the code does not do (impl-BS). Both halves
        // are pinned by test/recon-mount-routing.test.ts so neither can drift back.
        maxTurns: RECON_MAX_TURNS,
        maxBudgetUsd: budgetUsd, // dollars are the real backstop (WS-0 knob a).
        config,
        prompt: renderReconPrompt(planIndexBlock, operatorNotesBlock, task, recordPath),
      });

    let recon: WorkerResult | undefined;
    let reconDegradedSubtype: string | undefined;
    let reusedReconArtifact: ReconArtifact | undefined;
    let reconMasked = false;

    if (opts.maskRecon) {
      // W1-T2512 (RECON factor, arm B): the spawn is SKIPPED ENTIRELY — never issued, not even
      // once — and the recon artifact store is NEITHER READ NOR WRITTEN: `loadReconArtifact`/
      // `writeReconArtifact` both sit inside the branch below, which this `if` skips outright,
      // same as `computeMatchedLearningsForArm("B", ...)` never calls its own `deps` chain.
      // MASKED, NOT DELETED — a later non-wipe-test dispatch of this same task still sees
      // whatever artifact a prior real recon left behind, untouched by this run.
      reconMasked = true;
      say("recon masked (wipe-test RECON factor, arm B) — implement proceeds with NO recon context");
      log("recon.masked", {
        reason: "wipe-test RECON-factor pair, arm B (W1-T2512): recon spawn skipped, artifact store untouched",
      });
    } else {
      // W1-T2241: RECON ARTIFACT REUSE — before ever spawning recon, check whether a VALID prior
      // artifact exists for THIS task at THIS `(plan_sha, files_digest)`. Both are computed against
      // `worktreePath`, already checked out fresh from `origin/main` above, so "current" always
      // means what THIS dispatch would itself observe — never a stale read of the orchestrator's
      // own tree. See `taskRecordSha`/`filesDigest`/`ReconArtifact`'s doc (above `RECON_MAX_TURNS`)
      // for the key's derivation and why it drops `head_sha`.
      //
      // W1-T2510: `plan_sha` is now `taskRecordSha` — the digest of THIS task's own plan record —
      // not `planSha` (the whole `plan/` directory, kept above only as the rejected alternative).
      // The record is looked up against the WORKTREE's own `plan/tasks.yaml`, the same "fresh off
      // this dispatch's own checkout" discipline `filesDigest` already follows, never the
      // orchestrator's own (possibly staler) `planPath`.
      const currentPlanSha = taskRecordSha(join(worktreePath, "plan", "tasks.yaml"), taskId);
      const currentFilesDigest = filesDigest(worktreePath, task.files ?? []);
      const priorReconArtifact = loadReconArtifact(config.root, taskId);
      const reconDecision = decideReconArtifactReuse(priorReconArtifact, currentPlanSha, currentFilesDigest);
      const reconArtifactValid = reconDecision.valid;

      if (reconArtifactValid) {
        // HIT: recon is skipped entirely this dispatch — the cost this task exists to stop
        // paying twice. `reconArtifactToContext` (below, at the CONTEXT-render site) frames every
        // relayed line as evidence to VERIFY-AND-EXTEND, never authority (MASTER-PLAN Q3).
        reusedReconArtifact = priorReconArtifact;
        say(`recon artifact reused (written ${priorReconArtifact!.written_at}) — recon skipped this dispatch`);
        log("recon.reused", {
          plan_sha: currentPlanSha,
          files_digest: currentFilesDigest,
          written_at: priorReconArtifact!.written_at,
          source_run_id: priorReconArtifact!.run_id,
        });
      } else {
        // MISS: a full recon runs, exactly as before this task (MASTER-PLAN Q3 — "recon still
        // runs when the key misses"). The MISS ITSELF is ledgered explicitly, distinguishing a
        // first-ever dispatch (`recon.absent`) from a prior artifact this task's `plan_sha` or
        // `files:` has since moved past (`recon.invalidated`) — never a silent, unexplained
        // full recon (P48(ii): no silent empty).
        if (priorReconArtifact) {
          const reason = reconDecision.invalidationReason!;
          say(`recon artifact invalidated (${reason} changed) — running a full recon`);
          log("recon.invalidated", {
            reason,
            prior_plan_sha: priorReconArtifact.plan_sha,
            plan_sha: currentPlanSha,
            prior_files_digest: priorReconArtifact.files_digest,
            files_digest: currentFilesDigest,
          });
        } else {
          log("recon.absent", { plan_sha: currentPlanSha, files_digest: currentFilesDigest });
        }

        recon = account(await spawnRecon());
        log("recon.done", {
          session_id: recon.sessionId,
          cost_usd: recon.costUsd,
          num_turns: recon.numTurns,
          subtype: recon.subtype,
          attempt: 1,
          // W1-T6: every worker call ledgers the standard telemetry shape.
          ...workerLedgerFields(recon),
        });

        // W1-T299: recon is a READ-ONLY preamble — a worker ERROR here (overwhelmingly
        // `error_max_turns`; RECON_MAX_TURNS's own doc above measured 11/18 recons dying on the cap
        // on 2026-08-03) used to be FATAL to the WHOLE RUN via failOnWorkerError, ending dispatch
        // before implement ever spawned and burning a strike toward `dispatchesWithoutNewOwnedPr`'s
        // per-task breaker with no PR and no chance of ever getting one. Degrade instead of abort:
        // ONE bounded retry, and if that ALSO errors, proceed to implement anyway with an EXPLICIT
        // "recon context absent" claim (reconDegradedContextNote, never a silently empty CONTEXT
        // block) and a loud `recon.degraded` ledger line naming the subtype.
        //
        // The ONE exception is a budget breach: workerErrorVerdict's own doc says dollars are the
        // hard backstop, never retried anywhere in this file — recon gets no special case there and
        // stays fatal on a budget breach, unchanged from before this task.
        //
        // OPEN QUESTION the task file left for the implementer: should a degraded-recon run be
        // exempted from `dispatchesWithoutNewOwnedPr`? Decided NO — `run.start` above already
        // ledgered this dispatch before recon ever spawned, so it counts as a REAL dispatch exactly
        // like every other run regardless of what recon does; a task whose recon can never complete
        // must still eventually trip the breaker rather than dispatch forever for free.
        const reconVerdict1 = workerErrorVerdict(recon, costUsd, "recon");
        if (reconVerdict1) {
          if (reconVerdict1.budgetBreach) {
            const reconFail = failOnWorkerError(recon, "recon");
            if (reconFail) return reconFail;
          }
          say(`recon worker errored (${recon.subtype}) — one bounded retry before degrading (W1-T299)`);
          log("recon.retry", { subtype: recon.subtype, num_turns: recon.numTurns });
          recon = account(await spawnRecon());
          log("recon.done", {
            session_id: recon.sessionId,
            cost_usd: recon.costUsd,
            num_turns: recon.numTurns,
            subtype: recon.subtype,
            attempt: 2,
            ...workerLedgerFields(recon),
          });
          const reconVerdict2 = workerErrorVerdict(recon, costUsd, "recon");
          if (reconVerdict2) {
            if (reconVerdict2.budgetBreach) {
              const reconFail = failOnWorkerError(recon, "recon");
              if (reconFail) return reconFail;
            }
            // Second failure — DEGRADE, never abort: proceed to implement with an EMPTY recon
            // context (reconDegradedContextNote below makes the absence explicit in the prompt).
            reconDegradedSubtype = recon.subtype;
            log("recon.degraded", {
              subtype: recon.subtype,
              num_turns: recon.numTurns,
              reason: `recon errored twice in a row (${recon.subtype}) — bounded retry exhausted; implement proceeds with an EMPTY recon context`,
            });
            say(`⚠️ recon.degraded (${recon.subtype}) — implement proceeds with NO recon context`);
          }
        }

        // W1-T2241: persist the artifact for the NEXT dispatch of this SAME task — only on a
        // genuine success (never on a degrade: the final attempt's text is an error envelope, not
        // a report worth keeping) and only when the transcript actually parses as a RECON REPORT
        // (an unparseable "success" has nothing worth persisting either — same guard
        // `reconObservedToContext` already applies via `parseReconReport`'s `null` return).
        if (!reconDegradedSubtype) {
          const parsedForArtifact = parseReconReport(workerTranscript(recon));
          if (parsedForArtifact) {
            writeReconArtifact(config.root, {
              task_id: taskId,
              plan_sha: currentPlanSha,
              files_digest: currentFilesDigest,
              observed: parsedForArtifact.observed,
              inferred: parsedForArtifact.inferred,
              couldnt_verify: parsedForArtifact.couldntVerify,
              written_at: new Date().toISOString(),
              run_id: runId,
            });
          }
        }
      }
    }

    // Recon's own optional '## Follow-ups' section (renderReconPrompt above) — no `pr_url`
    // (recon never opens one); the retro harvest still cites its run/task. Skipped on a
    // degraded recon (the final attempt's text is an error envelope, not a report) AND on a
    // reused artifact (no fresh transcript this dispatch — the artifact's origin run already
    // harvested its own follow-ups when it ran).
    if (recon && !reconDegradedSubtype) {
      harvestFollowupsFromReport(workerTranscript(recon), { label: "recon", runId, log, say });
    }

    // ── Promptsmith READ side (W1-T19; SPLIT + INDEX + SUPERSESSION, W1-T33;
    // LAYERED — project + user-overall + global, P32/W1-T145): inject the
    // distrust rule, the autonomy clause, and the task-matched LEARNINGS
    // facts. `loadLayeredLearningsForTaskFiles` reads the PROJECT layer via
    // the index-based LOOKUP (W1-T33's learnings `index.json`, not a scan —
    // it parses only the corpus shards task.files could match), then merges
    // in the USER-OVERALL layer (a fleet-readable home outside this repo)
    // and the RMD-GLOBAL layer (a hash-pinned artifact — a tampered/missing
    // one contributes zero entries and is logged, never silently trusted) in
    // PRECEDENCE order. `selectLearnings` then matches by file-glob and
    // filters out any `lifecycle: superseded` entry before ranking, so a
    // decayed fact can never be injected; the KNOWLEDGE BUDGET caps the
    // injected facts and DROPPED entries are logged so a growing corpus never
    // becomes an unbounded context tax. On a fresh instance the user-overall
    // directory and global artifact don't exist yet (§6 transport is
    // deferred) — both layers are non-fatal absences, so this is a pure
    // superset of the project-only injection that shipped before.
    const learningsDir = projectLearningsHome(repoDir); // W1-T2506: follows the TARGET repo, not the plan's checkout
    // `recordPath` is REUSED, not re-resolved: it was hoisted above the recon spawn (W1-T2632)
    // so the SAME lookup now feeds both the recon prompt's pointer line and this CONTEXT block —
    // one `taskRecordPath`/`workerVisibleRecordPath` computation, three consumers, never a second
    // anchoring rule. It used to be resolved only here, on the degraded arm, "since recon already
    // relayed all of this" — but recon was never told WHICH TASK it was reconning, only its
    // `OBSERVED:` section survives `reconObservedToContext`, and that section can be empty. See
    // that function's doc.
    // W1-T2241/W1-T2512: exactly one of these four is ever set, mutually exclusive (see the
    // recon dispatch above) — `reconMasked` short-circuits the WHOLE branch that could set
    // `reusedReconArtifact`/`reconDegradedSubtype`/`recon`, so it is checked first even though
    // it was introduced last.
    const reconContext = reconMasked
      ? reconMaskedContextNote(taskId, recordPath, task.acceptance ?? [])
      : reusedReconArtifact
        ? reconArtifactToContext(reusedReconArtifact, taskId, recordPath)
        : reconDegradedSubtype
          ? reconDegradedContextNote(reconDegradedSubtype, taskId, recordPath, task.acceptance ?? [])
          : reconObservedToContext(recon!, taskId, recordPath);
    const learningsSelectionText = [
      task.title,
      task.rationale ?? "",
      task.prompt ?? "",
      ...(task.context ?? []).map((claim) => claim.claim),
      ...(task.acceptance ?? []).flatMap((criterion) => [criterion.claim, criterion.proof]),
      reconContext,
    ];
    // W1-T86 (P12 wipe-test harness): arm B of a wipe-test pair MASKS injection —
    // computeMatchedLearningsForArm("B", ...) returns "" WITHOUT calling any of the
    // load/select/render chain below, so the store is never touched, only the
    // resulting text is forced empty. A normal (non-wipe-test) run always passes
    // opts.maskLearnings undefined, i.e. arm "A" — byte-identical to the chain this
    // block ran before W1-T86.
    const learningUsage = readLearningUsage(learningUsagePath(join(config.root, "state")));
    const learningsResult = computeMatchedLearningsForArm(opts.maskLearnings ? "B" : "A", {
      homes: {
        projectDir: learningsDir,
        userOverallDir: userOverallLearningsHome(config),
        globalArtifactPath: globalArtifactPath(config),
      },
      taskFiles: task.files,
      selectionContext: {
        text: learningsSelectionText,
        usage: learningUsage,
        seed: seedOf(runId),
        propensityDraws: LEARNING_PROPENSITY_DRAWS,
      },
      budgetChars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    });
    // W1-T4094: only the Claude implement bound gets the rule tool; cash and review/manual keep theirs.
    const ruleLookup = implementTools === IMPLEMENT_CLAUDE_TOOLS
      ? {
          onPulled: (id: string, status: "found" | "missing" | "error") => log("knowledge.pulled", { id, status }),
          learningLookup: {
            homes: { projectDir: learningsDir, userOverallDir: userOverallLearningsHome(config), globalArtifactPath: globalArtifactPath(config) },
            allowedIds: learningsResult.selectedIds,
          },
        }
      : undefined;
    // VOLATILE (Tier 1) — deliberately NOT combined with the stable doctrine
    // preamble here: renderImplementPrompt places this LAST in the CONTEXT
    // block (cache-aware ordering, W1-T35) so a growing corpus can never bust
    // the cache for the stable/per-task bytes that precede it.
    const matchedLearnings = learningsResult.matchedLearnings;
    // W1-T419: `matched_ids` sits beside the pre-existing `matched` count — `dropped` already
    // logged ids, so a count-only `matched` was asymmetric and made per-entry injection
    // frequency unrecoverable from the ledger. This row is deliberately NOT added to
    // DECISION_RELEVANT_LEDGER_STEPS (lib/ledger.ts): no decision reads it, so a rotation
    // archiving it away loses analytics (the retro-side citation miner's input), never
    // correctness — the inverse of the #977 trap (a DECISION reading a rotated step), and the
    // next reader should know which side of that line this row sits on before "fixing" it.
    log("learnings.injected", {
      matched: learningsResult.selectedIds.length,
      matched_ids: learningsResult.selectedIds,
      dropped: learningsResult.droppedIds,
      budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
      matched_by: learningsResult.matchedBy,
      global_refused_reason: learningsResult.globalRefusedReason,
      masked: !!opts.maskLearnings,
      // W1-T4241: the budget cut, not match strength, decided these entries (0 < p < 1), so injected
      // vs dropped is a seeded randomization the outcome fold (knowledge-outcome.ts) can read.
      propensity: contestedPropensities(learningsResult.propensity),
      usage_sha: createHash("sha256").update(JSON.stringify(learningUsage)).digest("hex").slice(0, 16),
    });

    // ── Render + provenance-lint the prompt.
    // W1-T2761: the `rule_headlines` part — "" (identical to every render before this task)
    // unless `workerRuleHeadlines.enabled` is on AND this isn't a RULES-factor wipe-test arm B.
    // Read from THIS dispatch's own worktree (W1-T501's "the worker's own tree, never the
    // orchestrator's" discipline `recordPath` above already follows), never the orchestrator's
    // own checkout, so a worker is only ever handed an index of the CLAUDE.md it can itself see.
    const ruleHeadlinesEnabled = opts.maskRules
      ? false
      : opts.workerRuleHeadlinesEnabled ?? loadDefaultPolicy().values.workerRuleHeadlines.enabled;
    const ruleHeadlinesPart = buildRuleHeadlinesPart(
      ruleHeadlinesEnabled,
      join(worktreePath, "CLAUDE.md"),
      undefined,
      "CLAUDE.md",
    );
    // W1-T3101 — approved, opted-in skills for this task class, spending the SAME knowledge budget
    // matchedLearnings already spends. Each eligible skill is withheld on a seeded share of runs
    // (skillWithheldForRun), so buildSkillEffectivenessReport has a randomized control cohort.
    const skillSelection = observeSkillSelection(
      loadInjectableSkills(join(repoRoot, ".claude", "skills")),
      task.type,
      DEFAULT_KNOWLEDGE_BUDGET_CHARS,
      task.files,
      (skillName) => skillWithheldForRun(runId, skillName),
    );
    const injectableSkills = skillSelection.selected;
    const skillsPart = renderSkillsPart(injectableSkills);
    // W1-T3379: unlike skills.injected this is emitted even at zero selection, preserving the
    // denominator and budget omission needed for the read-only implement-path effectiveness report.
    log("skills.selection", skillSelection.observation);
    // Same shape as learnings.injected above, and same status: analytics, never a decision input.
    const skillsEvent = skillsInjectedEvent(injectableSkills, task.type, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
    if (skillsEvent) log("skills.injected", skillsEvent);
    // ONE call yields both the text the worker gets and the parts it was assembled from. The
    // manifest below is ledgered from THESE parts; deriving them a second time is what let the
    // manifest disagree with the prompt (see renderImplementPromptWithParts).
    const { prompt: renderedImplementPrompt, parts: implementParts } = renderImplementPromptWithParts(
      task, reconContext, runId, matchedLearnings, operatorNotesBlock, ruleHeadlinesPart, skillsPart,
      harnessOwnsGit,
    );
    // This is an output-only contract, deliberately outside `# CONTEXT`; the provenance manifest
    // still hashes the exact prompt sent to the worker below. The companion anchor append keeps a
    // compaction from deleting the only syntax the deterministic judge is allowed to honour.
    const ruleToolPointer = ruleLookup
      ? `\nTo read a doctrine rule by id or phrase, or a learning's evidence by learnings#id, call ${WORKER_RULE_TOOL_NAME}.`
      : "";
    const prompt = `${renderedImplementPrompt}${scopeRecoveryPrompt}${ruleToolPointer}\n${IMPLEMENT_REFUSAL_REPORT_CONTRACT}\n${IMPLEMENT_WAIT_TARGET_CONTRACT}\n${BRANCH_NAME_CONTRACT_PART}\n${SELF_FORECAST_REPORT_CONTRACT}`;
    assertProvenance(prompt); // throws ProvenanceError on any uncited CONTEXT claim
    // W1-T71: the ONE new emission this task makes — a sha256 of the fully-rendered prompt this
    // run is about to spawn with, so `rmd receipt <pr>` (src/lib/receipt.ts's buildReceipt) has a
    // ground-truth field to read instead of a fabricated one. Rides the SAME `prompt.linted` line
    // (a one-line addition, per the task's own design), never a second ledger step.
    log("prompt.linted", { provenance: "clean", prompt_template_hash: createHash("sha256").update(prompt).digest("hex") });
    say("prompt provenance-linted: clean");
    // W1-T2297: RECORDS the composition of the prompt this run just spawned with. `prompt.linted`
    // above already fingerprints the WHOLE rendered prompt; this ledgers the per-PART breakdown
    // (the SAME array the render above returned — this sentence used to be a CLAIM about a second
    // `implementPromptParts` call typed out beside it, and the claim was false: `skillsPart` was
    // handed to the render and dropped from the manifest, so an injected skill the worker really
    // received was ledgered `present: false`. It is now a fact about a single call) —
    // doctrine / task claims / recon / operator notes / matched learnings / task body — each as a
    // sha256 + byte length, NEVER the part's own text (rows stay greppable forever and rotate
    // through archives; republishing prompt content into them is out of scope by design). An
    // absent part (operator notes nobody wrote, a recon context that rendered empty) is recorded
    // `present: false` rather than a hash of the empty string standing in for "nothing here" — see
    // `buildPromptManifest`'s own doc. A RECORD, never a gate: nothing reads this to decide
    // anything, so it is deliberately NOT added to DECISION_RELEVANT_LEDGER_STEPS (lib/ledger.ts).
    log("prompt.manifest", { parts: buildPromptManifest(implementParts) });

    // ── COMPACTION ANCHOR (MASTER-PLAN §8B / W1-T36): the goal + acceptance
    // criteria + hard constraints, built ONCE and ledgered here so the anchor
    // this run WOULD re-inject verbatim after a compaction is a matter of
    // repo-state fact, not a claim in a possibly-lossy REPORT. Live mid-stream
    // re-injection (a real compaction firing during THIS spawn) is W1-T12e's
    // operator-golden drill — this run-level wiring records the anchor that
    // drill will send. `ruleHeadlinesPart` is the SAME string the turn-0 prompt above just
    // carried (design (iii)) — never re-derived, so a compaction can never re-inject a
    // headline index that drifted from what turn 0 actually said.
    const anchor = `${renderAnchorBlock(task, runId, ruleHeadlinesPart, harnessOwnsGit)}\n${IMPLEMENT_REFUSAL_REPORT_CONTRACT}\n${IMPLEMENT_WAIT_TARGET_CONTRACT}\n${BRANCH_NAME_CONTRACT_PART}\n${SELF_FORECAST_REPORT_CONTRACT}`;
    log("anchor.built", { anchor });

    // ── Implement + DIAGNOSE-THEN-RETRY (W1-T7B — Standing rule 14: the CALL SITE is the
    // deliverable). `classify.js`'s `runDiagnoseThenRetry` (built by W1-T7, PR #48, with ZERO
    // call site since — the two-strikes DIAGNOSE dispatch was UNREACHABLE) now DRIVES every
    // implement attempt. A TRANSIENT failure (an Anthropic-side server_error mid-response, or a
    // network/5xx/CI-infra blip) retries bounded (MAX_TRANSIENT_RETRIES), consuming NO strike —
    // byte-identical to the pre-W1-T7B behavior. A REAL strike no longer fails the run on the
    // FIRST one: it accumulates, and at DIAGNOSE_AT_STRIKES (two) an evidence-only DIAGNOSE
    // worker (mount steps UP, §9) runs BEFORE any third patch attempt — that third attempt's
    // prompt carries the diagnose findings verbatim, never a third blind patch (acceptance #1).
    noteRestartPhase("implementing");
    say("implement worker");
    const workerHeadReflogBefore = readWorktreeHeadReflog(worktreePath);
    // W1-T9030: the head every round starts from — after a checkpoint restore it is the harness's own merge commit.
    let roundHeadBefore = worktreeHeadOrUndefined(worktreePath);
    let impl!: WorkerResult;
    // W1-T7697: retain disk work before releasing a lane; a failed checkpoint is never a handoff.
    const yieldAtWorkerBoundary = async (waitingOn: string, phase = waitingOn): Promise<RunResult | undefined> => {
      noteRestartPhase(phase === "checkpoint" ? "checkpointed" : phase === "decision" ? "implementing" : phase);
      const freshness = await opts.externalWaitFreshness?.();
      const recycle = freshness ? undefined : (opts.externalWaitRecycle ?? (() => recyclePauseDetail(config.root)))();
      if (!freshness && !recycle) return undefined;
      let undeclared: readonly string[] = [];
      try {
        ({ undeclared } = await commitAndPushRestartCheckpoint(worktreePath, task, taskId, waitingOn));
      } catch (error) {
        log("verdict", { verdict: "no_pr", reason: "restart_checkpoint_failed", waiting_on: waitingOn,
          detail: String((error as Error)?.message ?? error), branch, cost_usd: costUsd, ...terminalVerdictFields(impl) });
        return { taskId, runId, merged: false, costUsd, verdict: "no_pr" };
      }
      const headSha = hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
      for (const row of freshnessYieldRows({ waitingOn, branch, headSha, undeclared,
        ...(freshness ? { freshness: { oldSha: freshness.oldSha, newSha: freshness.newSha } } : { recycle }) })) {
        log(row.step, row.step === "verdict" ? { ...row.fields, cost_usd: costUsd, ...terminalVerdictFields(impl) } : row.fields);
      }
      return { taskId, runId, merged: false, costUsd, verdict: "handed_off" };
    };
    const attemptImplement = async (findings?: string): Promise<AttemptOutcome> => {
      // The diagnose-informed attempt is the LAST one before the task goes to a human, and it only
      // happens after the implement mount has failed twice: that attempt steps up (operator ruling
      // 2026-09-22 — Opus and Sol are for work the Sonnet/Luna tier could not do).
      const attemptMount = findings && stepUpMount ? stepUpMount : implementMount;
      if (attemptMount !== implementMount) log("implement.step_up", { from: implementMount.model, to: attemptMount.model });
      impl = account(
        // `spawn` (opts.spawn ?? the real spawnWorker, exactly like the recon dispatch
        // above) — not the raw spawnWorker import. Zero behavior change on the real path
        // (opts.spawn is omitted by every real caller, so this is the same function
        // object either way); the seam lets a behavioral test drive the implement
        // dispatch the same way it already can recon (W1-T105's post-PR-open harvest
        // call site below is otherwise unreachable without a live worker spawn).
        await spawn({
          cwd: worktreePath,
          permissionMode: "bypassPermissions",
          // model/effort/max_turns come from the MOUNT (task_type × risk, §9), never a
          // hardcoded literal. max_turns is the runaway-LOOP guard; dollars (maxBudgetUsd)
          // are the real backstop. Recalibrated in mounts.yaml from OBSERVED runs (W1-T6
          // needed >61 turns — docs/archive/DIAGNOSIS.md), an order of magnitude above expected.
          model: attemptMount.model,
          mountProvider: attemptMount.provider,
          effort: attemptMount.effort,
          maxTurns: attemptMount.maxTurns,
          maxBudgetUsd: budgetUsd,
          settingsFile,
          config: implementConfig,
          // W1-T3573: `undefined` for `implement`/`diagnose`/`recon` — byte-identical
          // unrestricted behavior. Only `review`/`manual` carry a declared bound (above).
          tools: implementTools === undefined ? undefined : [...implementTools],
          ...(ruleLookup === undefined ? {} : { ruleLookup }),
          ...(implementCashTools === undefined ? {} : { cashTools: implementCashTools }),
          ...(attemptMount === implementMount ? cashTrialSpawn : {}),
          // W1-T7B: a diagnose-informed attempt gets the SAME task prompt, plus the prior
          // DIAGNOSE worker's report appended verbatim — never paraphrased, never silently
          // re-issued as an identical blind prompt (acceptance #1's "never blind" falsifier).
          prompt: findings
            ? `${prompt}\n\n## DIAGNOSE FINDINGS (a prior evidence-only worker's report — read before ` +
              `trying again; do NOT repeat the same failing approach blind)\n${findings}`
            : prompt,
        }),
      );
      const implHead = headProvenanceFields(worktreePath);
      log("implement.done", {
        session_id: impl.sessionId,
        cost_usd: impl.costUsd,
        num_turns: impl.numTurns,
        subtype: impl.subtype,
        api_error: impl.apiError,
        diagnose_informed: !!findings,
        permission_denials: impl.permissionDenials.length,
        // W1-T6: every worker call ledgers the standard telemetry shape.
        ...workerLedgerFields(impl),
        ...implHead,
        self_forecast: parseSelfForecast(workerTranscript(impl)),
      });
      // W1-T3079: archive this worker's transcript — see the "Worker transcript archive" section
      // above `runTask`. Best-effort and keyed on `runId` alone (not per-attempt), so a
      // transient/diagnose-informed retry's own re-dispatch OVERWRITES the same file rather than
      // multiplying it: `implement.done` is one archive point per run, unlike the fix rung's
      // per-strike archive below.
      const implHeadShaForArchive = implHead.head_sha;
      archiveWorkerTranscript(
        {
          root: config.root,
          taskId,
          runId,
          rung: "implement",
          text: workerTranscript(impl),
          model: attemptMount.model,
          verdict: impl.subtype,
          headSha: implHeadShaForArchive,
          worker: impl,
        },
        log,
      );
      // implementAttemptOutcome reproduces isTransientResult's/workerErrorVerdict's existing
      // invariants byte-for-byte (see its own doc) and THROWS ImplementBudgetBreach on
      // error_max_budget_usd rather than returning failure — dollars are the hard backstop and
      // must never be retried, so that case is handled OUTSIDE the driver, below.
      return implementAttemptOutcome(impl);
    };
    const dispatchDiagnose = async (): Promise<{ text: string }> => {
      say("diagnose worker (two strikes — evidence-only, before any third patch)");
      const d = account(
        await withPredecessorTranscriptCopies({
          cwd: worktreePath,
          permissionMode: "bypassPermissions",
          // W1-T3616: diagnose inspects `git diff`/`git status` and re-runs whatever failed, so it
          // declares Bash. "Do NOT modify, commit, or push ANYTHING" — hence no Write/Edit.
          tools: [...resolveDispatchLaneToolBound("diagnose", diagnoseMount.provider ?? "claude")],
          // W1-T3726: plus the surface to use if the auction BLOCKS — see cashDivertSpawnFields.
          ...cashDivertSpawnFields("diagnose"),
          model: diagnoseMount.model,
          mountProvider: diagnoseMount.provider,
          effort: diagnoseMount.effort,
          maxTurns: diagnoseMount.maxTurns,
          maxBudgetUsd: budgetUsd,
          settingsFile,
          config,
          prompt: renderDiagnosePrompt(task, [workerTranscript(impl), impl.stderr].join("\n")),
        }, { root: config.root, taskId, excludeRunId: runId }, spawn, log),
      );
      log("diagnose.worker_done", {
        session_id: d.sessionId,
        cost_usd: d.costUsd,
        num_turns: d.numTurns,
        subtype: d.subtype,
        // W1-T6: every worker call ledgers the standard telemetry shape.
        ...workerLedgerFields(d),
      });
      // W1-T3079: archive this worker's transcript — see the "Worker transcript archive" section
      // above `runTask`. `runDiagnoseThenRetry` calls `diagnose` at most once per run, so this
      // never overwrites a sibling round's file the way the implement archive above can.
      archiveWorkerTranscript(
        { root: config.root, taskId, runId, rung: "diagnose", text: workerTranscript(d), model: diagnoseMount.model, verdict: d.subtype, worker: d },
        log,
      );
      return { text: workerTranscript(d) };
    };

    let driverResult: Awaited<ReturnType<typeof runDiagnoseThenRetry>>;
    try {
      // W1-T2515: SUPPLY THE BACKOFF. This was the ONLY production call site of
      // runDiagnoseThenRetry and it passed no `sleep`, so the seam classify.ts had carried since
      // W1-T46 — documented as 'default: no-op — tests never sleep' — was a no-op in production
      // too. MEASURED on 2026-08-30: MAX_TRANSIENT_RETRIES spent in 3.519s (19:52:34.185Z ->
      // 19:52:37.704Z) against a session limit whose own message said it reset at 20:50Z, 57m23s
      // later. The schedule lives in classify.ts (transientBackoffMs, bounded); this passes only
      // the clock, so a test can drive the whole thing without a real timer.
      driverResult = await runDiagnoseThenRetry({
        fixProgressJudge: ctx.spawnInjected ? undefined : productionFixProgressJudge({ cwd: worktreePath, settingsFile }),
        progressInput: buildFixProgressInput({ taskId, headSha: "implement", currentRed: [], ledger: [] }),
        attempt: attemptImplement,
        diagnose: dispatchDiagnose,
        log,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    } catch (e) {
      if (!(e instanceof ImplementBudgetBreach)) throw e;
      // Exits the diagnose-then-retry loop immediately — `impl` (the breaching attempt) is
      // already captured above; the ordinary post-loop code below (failOnWorkerError) renders
      // it blocked_budget exactly as it always has, off that SAME `impl`.
      driverResult = { outcome: "gave_up", strikes: 0, transientRetries: 0, diagnosed: false, attempts: 1, reason: e.message };
    }

    if (driverResult.outcome === "held") {
      log("verdict", { verdict: "blocked_transient", stage: "implement", reason: driverResult.reason });
      return { taskId, runId, merged: false, costUsd, verdict: "blocked_transient" };
    }

    const transientVerdict = finishTransientRetry(driverResult, {
      taskId, runId, repoDir, worktreePath, costUsd, worker: impl, log, say,
    });
    if (transientVerdict) return transientVerdict;
    // ── The worker's OWN preflight verdict, surfaced before any verdict branch consumes the run.
    // `rmd preflight` writes `<repoRoot>/coverage/preflight-summary.json` in the worktree it ran
    // in — and that worktree is still on disk here, because every `worktreeRemove` in this
    // function sits inside a verdict branch BELOW this line and the `finally` drops only the run
    // lock. Read it now, above `failOnWorkerError`, so a worker that hit its turn cap while
    // fighting a failing check still reports WHICH check. Silent when preflight passed, when the
    // worker never ran it, and when the file cannot be read — see `preflightFailureNotice`.
    const preflightNotice = preflightFailureNotice(worktreePath);
    if (preflightNotice) {
      log("preflight.failed", { detail: preflightNotice, worktree: worktreePath });
      say(preflightNotice);
    }

    // W1-T2862/W1-T3801: consume the worker's successful source-size signal while this exact
    // worktree and its durable preflight summary still exist. This runs before every implementation
    // verdict branch that may remove the worktree. The source-size pilot is advisory: it can defer
    // or file a bounded decomposition follow-up, but never blocks the feature verdict.
    try {
      const expectedHead = hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
      const gatePostureDeps = buildSourceSizeGatePostureRuntime(repoRoot, worktreePath, settingsFile, spawn, log, say);
      // Keep the wrapper call in the worker-return window so the worktree and summary are still
      // present; its injected consumer above remains the existing source-size writer.
      // The production adapter still owns the existing reportWorkerSourceSizeFollowup( consumer;
      // the gate posture layer only decides whether to invoke that same bounded writer.
      await reportWorkerSourceSizeFollowupWithGatePosture(
        {
          root: repoDir,
          worktreeRoot: worktreePath,
          expectedHead,
          stateDir: dirname(ledgerPath),
          ledgerPath,
          runId,
          sourceTask: taskId,
          sourcePr: parseReport(workerTranscript(impl))?.prUrl,
          sourceBranch: branch,
        },
        log,
        say,
        gatePostureDeps,
      );
    } catch (error) {
      const detail = String((error as Error)?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 512);
      log("source_size.followup.noop", { reason: "head_unreadable", detail });
    }

    const implFail = failOnWorkerError(impl, "implement", driverResult.reason);
    if (implFail) return implFail;

    const fullText = (r: WorkerResult) => workerTranscript(r);

    // ── DECISION_REQUEST → auto-choose RECOMMENDED → resume (§4).
    const decision = parseDecisionRequest(fullText(impl));
    if (decision && !parseReport(fullText(impl))?.prUrl) {
      const chosen = decision.recommended ?? decision.options[0] ?? "(first option)";
      // W1-T32: decision-record hygiene. Every DECISION_REQUEST is auto-chosen and
      // ledgered — that never changes — but only decisions worth a human's
      // future attention (risk >= medium, or an explicit reversibility
      // caveat) get PROMOTED to a durable, human-read record. A trivial
      // filename pick stays ledger-only instead of burying real decisions.
      const recordVerdict = shouldRecordDecision(decision);
      let landed = false;
      if (recordVerdict.record) {
        // W1-T191: one shard per resolution (`plan/decisions.d/<taskId>-<runId>.md`), never
        // the shared `DECISIONS.md` append this replaces — concurrent runs across different
        // tasks/run ids can never collide on the same path. Harness-owned and deterministic
        // (never delegated to the worker's own commit — the resume prompt below never even
        // mentions this file), and best-effort landed via the SAME commit-bridge mechanism
        // W1-T243 proved for `plan/feedback/**`, so `repoRoot` never sits dirty waiting for
        // an operator to notice (the defect this task fixes).
        landed = recordDecisionFn(repoRoot, {
          taskId,
          runId,
          options: decision.options,
          chosen,
          band: recordVerdict.band,
          reason: recordVerdict.reason,
          ...(decision.falsifier ? { falsifier: decision.falsifier } : {}),
        }).landed;
      }
      log("decision.autochoose", {
        chosen,
        recorded: recordVerdict.record,
        risk_band: recordVerdict.band,
        landed,
        falsifier: decision.falsifier ?? null,
      });
      say(
        `DECISION_REQUEST auto-chose: ${chosen} (${
          recordVerdict.record
            ? `recorded in plan/decisions.d/ — ${landed ? "landed" : "landing pending"}`
            : "ledger-only, " + recordVerdict.band + " risk"
        })`,
      );
      const boundaryYield = await yieldAtWorkerBoundary("decision");
      if (boundaryYield) return boundaryYield;
      impl = account(
        // W1-T191: this resumed spawn used to call the real `spawnWorker` directly, bypassing
        // the injectable `spawn` (`opts.spawn ?? spawnWorker`) every OTHER spawn call site in
        // this function uses — the DECISION_REQUEST resume branch was consequently untestable
        // in isolation (no behavioral test could drive it without a real Claude subprocess).
        // Production behavior is unchanged: `spawn` defaults to the exact same `spawnWorker`.
        await spawn({
          cwd: worktreePath,
          permissionMode: "bypassPermissions",
          settingsFile,
          resumeSessionId: impl.sessionId,
          continuation: workerContinuation(impl, prompt, worktreePath),
          model: implementMount.model, // same mount as the initial implement spawn (§9).
          mountProvider: implementMount.provider,
          effort: implementMount.effort,
          maxTurns: implementMount.maxTurns,
          maxBudgetUsd: budgetUsd,
          config: implementConfig,
          // W1-T3573: same declared bound as the initial spawn above — a resumed session is
          // still the SAME lane, so it must not regain unrestricted tools on resume.
          tools: implementTools === undefined ? undefined : [...implementTools],
          ...(ruleLookup === undefined ? {} : { ruleLookup }),
          ...(implementCashTools === undefined ? {} : { cashTools: implementCashTools }),
          ...cashTrialSpawn,
          // W1-T3696: the RESUMED turn must restate the SAME contract the initial spawn was given.
          // A shell-less worker told here to `git push` would spend its remaining turns failing at
          // a tool it does not have, which is the one place this lane cannot recover from.
          prompt: harnessOwnsGit
            ? `Decision made: ${chosen}. Now execute the change and the OUTPUT CONTRACT from before: ` +
              `save your edits to the files, run NO git or gh commands, and end with a REPORT carrying ` +
              `a line \`COMMIT_MESSAGE: <type>(<scope>): <subject>\` — the harness commits, pushes and opens the PR.`
            : `Decision made: ${chosen}. Now execute the change and the OUTPUT CONTRACT from before: ` +
              `commit, \`git push origin HEAD\` (no -u), open the PR with \`gh pr create --fill --base main\`, ` +
              `and end with a REPORT whose last line is exactly: PR_URL: <url>`,
        }),
      );
      log("implement.resumed", {
        session_id: impl.sessionId,
        cost_usd: impl.costUsd,
        num_turns: impl.numTurns,
        subtype: impl.subtype,
        // W1-T6: every worker call ledgers the standard telemetry shape.
        ...workerLedgerFields(impl),
      });
      const resumeFail = failOnWorkerError(impl, "implement.resumed");
      if (resumeFail) return resumeFail;
    }

    // A worker that stops on a `wip:` checkpoint tip has not finished (#10482): resume it. The first
    // stop always resumes; whether a later stop resumes again is the progress judge's call (W1-T7096).
    const checkpointStops: CheckpointStop[] = [];
    let checkpointJudge: FixProgressJudge | undefined;
    for (;;) {
      const tipSubject = lastCommitSubject(worktreePath);
      const roundReport = parseReport(fullText(impl));
      const roundTip = classifyRoundTip({
        tipSubject, headBefore: roundHeadBefore, headNow: worktreeHeadOrUndefined(worktreePath),
        finishedByReport: roundReport?.prUrl !== undefined || (harnessOwnsGit && roundReport?.commitMessage !== undefined),
        reportOpenedPr: roundReport?.prUrl !== undefined,
      });
      if (tipSubject === undefined || !roundTip.unfinished) {
        // A wip-shaped tip the harness wrote, left unmoved by a round that reported its completion line: finished.
        if (tipSubject !== undefined && isWipSubject(tipSubject) && !roundTip.headMoved && roundReport?.prUrl === undefined) {
          log("implement.finished_on_harness_tip", { subject: tipSubject, tip_author: roundTip.tipAuthor, head_moved: roundTip.headMoved });
        }
        break;
      }
      const checkpointYield = await yieldAtWorkerBoundary("checkpoint");
      if (checkpointYield) return checkpointYield;
      let tipBody = "";
      try {
        tipBody = hostWorktreeGit(worktreePath, ["log", "-1", "--format=%b"]);
      } catch (e) {
        // An unreadable body only loses the remaining hint; the resume still runs with a generic prompt.
        void e;
      }
      const remaining = checkpointRemaining(tipBody);
      log("implement.unfinished", { subject: tipSubject, remaining: remaining ?? null, tip_author: roundTip.tipAuthor, head_moved: roundTip.headMoved });
      const workingTree = worktreeDiffStat(worktreePath);
      checkpointStops.push({ round: checkpointStops.length + 1, subject: tipSubject, remaining, ...(workingTree ? { workingTree } : {}) });
      const decision = await judgeCheckpointStop(checkpointStops, {
        readHead: () => hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]),
        makeJudge: () => (checkpointJudge ??= opts.productionProgressJudge === true || !spawnInjected
          ? productionFixProgressJudge({ cwd: worktreePath, settingsFile }) : undefined),
      });
      log("implement.checkpoint_judged", { stop: checkpointStops.length, resume: decision.resume, by: decision.by, reason: decision.reason });
      if (!decision.resume) break;
      const judgedYield = await yieldAtWorkerBoundary("checkpoint");
      if (judgedYield) return judgedYield;
      noteRestartPhase("implementing");
      roundHeadBefore = worktreeHeadOrUndefined(worktreePath);
      impl = account(
        await spawn({
          cwd: worktreePath,
          permissionMode: "bypassPermissions",
          settingsFile,
          resumeSessionId: impl.sessionId,
          continuation: workerContinuation(impl, prompt, worktreePath),
          model: implementMount.model,
          mountProvider: implementMount.provider,
          effort: implementMount.effort,
          maxTurns: implementMount.maxTurns,
          maxBudgetUsd: budgetUsd,
          config: implementConfig,
          tools: implementTools === undefined ? undefined : [...implementTools],
          ...(ruleLookup === undefined ? {} : { ruleLookup }),
          ...(implementCashTools === undefined ? {} : { cashTools: implementCashTools }),
          ...cashTrialSpawn,
          prompt: renderContinuationPrompt(tipSubject, remaining, harnessOwnsGit),
        }),
      );
      log("implement.continued", { session_id: impl.sessionId, cost_usd: impl.costUsd, num_turns: impl.numTurns, subtype: impl.subtype, ...workerLedgerFields(impl) });
      const continueFail = failOnWorkerError(impl, "implement.continued");
      if (continueFail) return continueFail;
    }

    // The harness runs the fast gate itself before opening the PR; a failing step goes back to the worker once.
    const preopenGate = opts.preopenGate ?? (spawnInjected ? undefined : (path: string) => runPreopenGate(path));
    if (preopenGate !== undefined && !parseReport(fullText(impl))?.prUrl) {
      const workerYield = await yieldAtWorkerBoundary("worker", "preopen_gate");
      if (workerYield) return workerYield;
      const gate = await preopenGate(worktreePath);
      log(PREOPEN_GATE_STEP, { result: gate.kind, failed: gate.kind === "fail" ? gate.failedSteps : [], duration_ms: gate.durationMs,
        ...(gate.kind === "unmeasured" ? { reason: gate.reason } : {}), ...preopenGateLedgerFields(gate) });
      updatePreopenGateAlert({ stateDir: dirname(ledgerPath), readRows: () => readLedgerLines(ledgerPath), log });
      if (gate.kind === "fail") {
        const preopenYield = await yieldAtWorkerBoundary("preopen_gate", "implementing");
        if (preopenYield) return preopenYield;
        noteRestartPhase("implementing");
        impl = account(
          await spawn({
            cwd: worktreePath,
            permissionMode: "bypassPermissions",
            settingsFile,
            resumeSessionId: impl.sessionId,
            continuation: workerContinuation(impl, prompt, worktreePath),
            model: implementMount.model,
            mountProvider: implementMount.provider,
            effort: implementMount.effort,
            maxTurns: implementMount.maxTurns,
            maxBudgetUsd: budgetUsd,
            config: implementConfig,
            tools: implementTools === undefined ? undefined : [...implementTools],
            ...(ruleLookup === undefined ? {} : { ruleLookup }),
            ...(implementCashTools === undefined ? {} : { cashTools: implementCashTools }),
            ...cashTrialSpawn,
            prompt: renderPreopenGatePrompt(gate.failedSteps, harnessOwnsGit),
          }),
        );
        log("implement.preopen_continued", { session_id: impl.sessionId, cost_usd: impl.costUsd, num_turns: impl.numTurns, subtype: impl.subtype, ...workerLedgerFields(impl) });
        const gateFail = failOnWorkerError(impl, "implement.preopen_continued");
        if (gateFail) return gateFail;
        const repairedGate = await preopenGate(worktreePath);
        log(PREOPEN_GATE_STEP, { after_repair: true, result: repairedGate.kind,
          failed: repairedGate.kind === "fail" ? repairedGate.failedSteps : [], duration_ms: repairedGate.durationMs,
          ...(repairedGate.kind === "unmeasured" ? { reason: repairedGate.reason } : {}), ...preopenGateLedgerFields(repairedGate) });
        updatePreopenGateAlert({ stateDir: dirname(ledgerPath), readRows: () => readLedgerLines(ledgerPath), log });
      }
    }

    if (!parseReport(fullText(impl))?.prUrl) {
      const workerYield = await yieldAtWorkerBoundary("worker", "pushing");
      if (workerYield) return workerYield;
    }

    // ── QUESTION contract (non-blocking) — log, don't stall (§2).
    const question = parseQuestion(fullText(impl));
    if (question) {
      const logged = appendQuestion(repoRoot, {
        ts: new Date().toISOString(),
        task: taskId,
        question: question.question,
        current_assumption: question.currentAssumption,
        impact_if_wrong: question.impactIfWrong,
      });
      log(logged ? "question.logged" : "question.log_failed", {
        question: question.question.slice(0, 120),
      });
    }

    logLearningsUsed(log, fullText(impl), learningsResult.selectedIds, learningUsagePath(join(config.root, "state")));
    logSkillsUsed(log, fullText(impl), injectableSkills.map((s) => s.name), skillUsagePath(join(config.root, "state")));

    const workerHeadCreatedLocally = workerCreatedCurrentHead(worktreePath, workerHeadReflogBefore);

    // ── PR (worker REPORT or orchestrator fallback).
    let prUrl = parseReport(fullText(impl))?.prUrl;
    let stagedClosureCatalogFiles: string[] = [];

    // SILENT NO-OP GUARD: by here the worker reached a terminal SUCCESS (non-success
    // subtypes already returned above via workerErrorVerdict). If it committed NOTHING and
    // opened no PR, it produced nothing to merge — an honest `no_pr` verdict, NOT a failed
    // "worker error: success" (run W1-T12a-1784117152056) and NOT a gh-pr-create throw on an
    // empty branch. Only reached when there's no PR to gate.
    //
    // Computed ONCE and held in `commitCount` (W1-T407) rather than re-called inline: the guard's
    // predicate is unchanged (still `=== 0`), but the same value now also rides the `no_pr`
    // ledger row below instead of being thrown away after deciding the branch.
    let commitCount = commitsAhead(worktreePath, "origin/main");

    // W1-T3696 step (1), WIRED: a worker with no shell cannot commit its own edits, so the harness
    // commits them here. This is the ONLY missing verb — the fallback push below and the
    // orchestrator PR creation after it already exist, so once this produces a commit the rest of
    // the run is the long-proven path, unchanged.
    //
    // GATED ON THE SPAWN'S OWN TOOL SURFACE, not on the provider. `harnessOwnsGit` is true exactly
    // when this spawn was bounded without a shell, which is the condition under which the worker
    // was TOLD the harness would commit (the same flag built its output contract). A shell-capable
    // worker that committed nothing is left alone: it could have committed and chose not to, and
    // turning that into a pull request would change a long-standing verdict rather than enable a
    // new lane.
    //
    // The first attempt uses the worker's anchored subject. A non-resumable writer that still omits
    // it after one contextual re-ask may use the task-record fallback below.
    // CALLED UNCONDITIONALLY, and it owns its own precondition. Guarding here instead would put the
    // decision on lines no test can reach without driving this entire dispatch — which is what
    // `diff-coverage` refused, and rightly: the branch deciding whether a run produces a pull
    // request must be exercised, not reasoned about from outside.
    const harnessCommitRefusalState: { reason?: string } = {};
    let harnessCommitted: { sha: string; undeclared: readonly string[] } | undefined;
    const onHarnessCommit = (sha: string, undeclared: readonly string[] = []) => { harnessCommitted = { sha, undeclared }; };
    commitCount = harnessCommitForShellLessWorker({
      harnessOwnsGit,
      commitCount,
      report: fullText(impl),
      worktreePath,
      declaredPaths: task.files ?? [],
      acceptance: task.acceptance,
      assignmentId: impl.selectionAssignmentId,
      log,
      say,
      onRefusal: createHarnessCommitRefusalRecorder(harnessCommitRefusalState),
      onCommit: onHarnessCommit,
    });

    // W1-T4052: A MISSING COMMIT_MESSAGE LINE IS ASKED FOR, NOT DISCARDED. `resumeForMissingCommitLine`
    // owns its own precondition (called unconditionally, exactly like the helper above) — it no-ops
    // for every refusal EXCEPT the exact missing-line one, and only when the worktree still holds
    // uncommitted changes. A Codex writer gets its own diff and report because its resumed spawn
    // starts fresh. A still-missing line may use the task record, through the same commit guard.
    const commitLineRecovery = await resumeForMissingCommitLine({
      commitCount,
      refusalReason: harnessCommitRefusalState.reason,
      report: fullText(impl),
      task: writerCannotResume(impl.provider ?? implementMount.provider, implementTools) ? task : undefined,
      worktreePath,
      declaredPaths: task.files ?? [],
      acceptance: task.acceptance,
      assignmentId: impl.selectionAssignmentId,
      log,
      say,
      onCommit: onHarnessCommit,
      resume: commitLineResume(spawn, account, {
        cwd: worktreePath,
        permissionMode: "bypassPermissions",
        settingsFile,
        resumeSessionId: impl.sessionId,
        continuation: workerContinuation(impl, prompt, worktreePath),
        model: implementMount.model,
        mountProvider: implementMount.provider,
        effort: implementMount.effort,
        maxTurns: implementMount.maxTurns,
        maxBudgetUsd: budgetUsd,
        config: implementConfig,
        tools: implementTools === undefined ? undefined : [...implementTools],
        ...(ruleLookup === undefined ? {} : { ruleLookup }),
        ...(implementCashTools === undefined ? {} : { cashTools: implementCashTools }),
        ...cashTrialSpawn,
      }, { provider: impl.provider ?? implementMount.provider, title: task.title, report: fullText(impl), declaredPaths: task.files ?? [] }),
    });
    commitCount = commitLineRecovery.commitCount;
    harnessCommitRefusalState.reason = commitLineRecovery.refusalReason;
    const harnessCommitRefusalReason = harnessCommitRefusalState.reason;
    const harnessCommitRefused = harnessCommitRefusalReason !== undefined && commitCount === 0;

    // W1-T10026: a commit whose own files import a path it left out never opens bare; it asks for that scope.
    const scopeNeeded = await askScopeForLeftOutImports({
      taskId, branch, commit: harnessCommitted, log, git: (args) => hostWorktreeGit(worktreePath, args),
      amend: opts.implementScopeAmendment ?? ((request) => requestScopeAmendment(request, buildProofAmendmentWritePorts({
        taskId, worktreePath: repoDir, config, owner, repo: task.repo, prNumber: request.prNumber, ledgerLinesNow: [], log,
        gitOps: buildProofAmendmentGitOps(), amendmentKind: "scope_amendment",
      }, opts.implementScopeAmendmentPortsIo))),
    });
    if (scopeNeeded) {
      harvestFollowupsFromReport(fullText(impl), { label: "implement", runId, log, say });
      const { amendment } = scopeNeeded;
      const recoveryPath = await saveBuildScopeRecovery({ root: config.root, taskId, branch, worktreePath,
        headSha: harnessCommitted!.sha, amendmentUrl: "amendmentUrl" in amendment ? amendment.amendmentUrl : "",
        companions: scopeNeeded.companions.map((c) => c.path), git: (args) => hostWorktreeGit(worktreePath, args) });
      log("implement.scope_needed", { recovery_path: recoveryPath, paths: scopeNeeded.companions.map((c) => c.path),
        head_sha: harnessCommitted!.sha, amendment_url: "amendmentUrl" in amendment ? amendment.amendmentUrl : "" });
      reclaimRunWorktree(repoDir, worktreePath, "implement.scope_needed", log);
      log("verdict", {
        verdict: "no_pr",
        reason: "scope_needed",
        paths: scopeNeeded.companions.map((c) => c.path),
        head_sha: harnessCommitted?.sha,
        amendment_outcome: amendment.kind,
        ...(amendment.kind === "refused" ? { amendment_reason: amendment.reason, amendment_detail: amendment.detail } : {}),
        ...("amendmentUrl" in amendment ? { amendment_url: amendment.amendmentUrl } : {}),
        cost_usd: costUsd,
        ...terminalVerdictFields(impl),
      });
      say(`verdict: no_pr — committed files import left-out ${scopeNeeded.companions.map((c) => c.path).join(", ")}; ` +
        `scope amendment ${amendment.kind}${amendment.kind === "refused" ? ` (${amendment.reason})` : ""}`);
      return { taskId, runId, merged: false, costUsd, verdict: "no_pr" };
    }

    if (!prUrl && commitCount === 0) {
      // W1-T412: HARVEST BEFORE THIS BLOCK'S RETURNS, because every path out of it returns and
      // the implement phase's own harvest call sits far BELOW, after `gh pr create`/`pr.opened`
      // — placed there because that is where `prUrl` becomes known on the orchestrator-fallback
      // path. The consequence, measured across four empty-diff runs (W1-T388, W1-T392 twice,
      // W1-T393): recon follow-ups survive and IMPLEMENT follow-ups are discarded on exactly the
      // verdict where a worker most needs to say something. This is a call that never happens,
      // not a verdict that needs changing — nothing below is altered.
      //
      // NOT A SECOND, PARALLEL CALL SITE: this block returns on EVERY path (already_satisfied
      // and no_pr alike), so the call below is unreachable from here and no run can harvest
      // twice. That disjointness is what makes one-harvest-per-phase hold by construction
      // rather than by a flag, and `test/no-pr-followups-harvested.test.ts` locks BOTH
      // directions — the PR-bearing run still harvests exactly once, with its pr_url intact.
      //
      // `prUrl` is deliberately NOT passed: this run opened no PR, and
      // `harvestFollowupsFromReport` spreads `pr_url` in only when defined, so the line carries
      // no blank field. That is the SAME shape the recon call site already emits on every
      // dispatch — the PR-less path is long-proven, not new code.
      harvestFollowupsFromReport(fullText(impl), { label: "implement", runId, log, say });
      // W1-T272: the THIRD exit — before falling to the drain-halting `no_pr`, check whether
      // the worker instead claimed ALREADY_SATISFIED and, if so, whether that claim actually
      // verifies against the board gateway. A claim that fails to verify is deliberately NOT
      // an error of its own — it just falls straight through to the unchanged `no_pr` path,
      // exactly as if no claim had been made at all.
      const claim = parseAlreadySatisfied(fullText(impl));
      // W1-T2370: an UNVERIFIABLE read is re-asked here, between the resolution and the verdict —
      // never inside the resolver, which stays a pure function over the gateway it is handed.
      const verify = claim ? resolveAlreadySatisfiedWithRetry(claim, github, taskId) : undefined;
      const resolution = verify?.resolution;
      const resolved = resolution?.outcome === "verified" ? resolution : undefined;
      if (claim && resolved) {
        const v = alreadySatisfiedVerdict(impl, costUsd, "implement", resolved);
        // Make the credit the dispatcher's too, or its next projection re-dispatches the task.
        const credit = persistVerifiedCredit(ledgerPath, task, resolved, github.changedFiles?.(resolved.url));
        log("already_satisfied.credit_persisted", { pr_number: resolved.number, outcome: credit });
        try {
          worktreeRemove(repoDir, worktreePath);
          log("worktree.remove", { on: "already_satisfied" });
        } catch (e) {
          log("worktree.remove.error", { on: "already_satisfied", error: String((e as Error)?.message ?? e) });
        }
        log("verdict", { ...v.ledger, ...terminalVerdictFields(impl) });
        say(`verdict: already_satisfied — credited via ${v.prUrl} · ${impl.numTurns} turns`);
        return { taskId, runId, prUrl: v.prUrl, merged: true, costUsd, verdict: "already_satisfied" };
      }
      if (claim && resolution?.outcome === "unverifiable") {
        // NEITHER CREDIT NOR REFUSAL. The gateway could not answer, so the claim is not
        // refuted — recording it as `already_satisfied.refused` is what turned a failed read
        // into "the worker lied" and re-dispatched two already-shipped tasks. The verdict
        // still falls to `no_pr` (an unverifiable claim can never be credited — that would be
        // strictly worse than the defect), but the RECORD no longer asserts the claim was false.
        log("already_satisfied.unverified", {
          claimed_ref: claim.ref,
          claimed_number: prNumberFromRef(claim.ref) ?? null,
          reason: resolution.reason,
          // W1-T2370: how many gateway READS were spent before giving up, so a later reader can tell
          // "the bound was exhausted" from "the read failed once" without replaying anything.
          verify_attempts: verify?.attempts ?? 1,
        });
        say(
          `ALREADY_SATISFIED claim ("${claim.ref}") could NOT be verified — the board gateway read ` +
            `failed (${resolution.reason}). Not refuted; falling to no_pr.`,
        );
      } else if (claim && resolution?.outcome === "refuted") {
        log("already_satisfied.refused", {
          claimed_ref: claim.ref,
          claimed_number: prNumberFromRef(claim.ref) ?? null,
          // WHICH of the three things happened — the row is the forensic record and could not
          // say before. `credited_number` rides along on the one reason that has a rival PR.
          reason: resolution.reason,
          ...(resolution.creditedNumber !== undefined ? { credited_number: resolution.creditedNumber } : {}),
        });
        say(
          `ALREADY_SATISFIED claim ("${claim.ref}") did not verify against the board gateway ` +
            `(${resolution.reason}) — falling to no_pr`,
        );
      }
      const v = noPrVerdict(
        impl,
        costUsd,
        "implement",
        commitCount,
        harnessCommitRefused ? "harness_commit_refused" : undefined,
      );
      try {
        worktreeRemove(repoDir, worktreePath);
        log("worktree.remove", { on: "no_pr" });
      } catch (e) {
        log("worktree.remove.error", { on: "no_pr", error: String((e as Error)?.message ?? e) });
      }
      log("verdict", { ...v.ledger, pre_dispatch_contract_revision: preDispatchContractRevision(task), ...terminalVerdictFields(impl) });
      say(`verdict: no_pr — worker completed without opening a PR · ${impl.numTurns} turns`);
      return {
        taskId,
        runId,
        merged: false,
        costUsd,
        verdict: "no_pr",
        ...(harnessCommitRefused
          ? { harnessCommitRefused: true as const, harnessCommitRefusalReason }
          : {}),
      } as RunResult;
    }

    // W1-T4656: ONE policy read shared by the census rung and the fix rung (config-reader-seams counts reads).
    const fixSpawnWallClockBoundMs = () => opts.spawnWallClockBoundMs ?? loadDefaultPolicy().values.fixSpawnWallClockBoundMs;
    // Ensure the branch is on origin (worker pushes without -u).
    let branchOnOrigin = false;
    let probeFailure: RemotePresenceProbeFailure | undefined;
    try {
      // W1-T2267: was `stdio: "ignore"`, which discarded the probe's own stderr — the exact
      // evidence `fallbackPushCause` needs to tell an unreadable remote from a genuinely
      // absent ref. The leaf pipes it, so a failed probe's error carries it.
      hostWorktreeGit(worktreePath, ["ls-remote", "--exit-code", "origin", branch]);
      branchOnOrigin = true;
    } catch (e) {
      branchOnOrigin = false;
      // W1-T2267: capture the probe's exit status/stderr instead of a bare, unbound `catch` —
      // see `fallbackPushCause` (above scopeGuardOutOfScopeFiles) for what this evidence feeds.
      const err = e as { status?: number | null; stderr?: Buffer | string };
      probeFailure = {
        status: typeof err.status === "number" ? err.status : null,
        stderr: err.stderr !== undefined ? String(err.stderr).trim() : "",
      };
    }
    if (!branchOnOrigin) {
      // W1-T2267: WHY the fallback fired, not only that it did (design (i)). Computed and
      // ledgered BEFORE the push below, from evidence already in hand — the probe's own
      // status/stderr and the implement worker's own transcript+stderr (identical evidence
      // `workerSignal` already builds for the retry classifier, just reused for a different
      // question). This does not gate or delay the push itself (design note: "a run that cannot
      // determine WHY still pushes" — acceptance #4).
      const pushCause = fallbackPushCause(probeFailure, [workerTranscript(impl), impl.stderr].join("\n"));
      // `evidence` (W1-T2522) rides the SAME line as `cause`/`detail`, never a second ledger step —
      // one row per fallback push, now carrying the scrubbed/bounded text that class was read from
      // instead of losing it, exactly what left all 15 `credential_expired` rows to date
      // indistinguishable from one another.
      log("fallback_push.cause", { branch, cause: pushCause.cause, detail: pushCause.detail, evidence: pushCause.evidence });
      say(`fallback push firing for ${branch} — cause: ${pushCause.cause} (${pushCause.detail})`);
      // W1-T142 SCOPE GUARD, W1-T434 PUSH-AND-FLAG — the ONE orchestrator-initiated push in this
      // file; workers normally push in their sandbox. This fallback pushes whatever a refreshed,
      // collapsed or squashed worktree holds, only when the branch is ABSENT from origin.
      // Compute the diff FRESH from this worktree BEFORE pushing; ledger the diff about to publish.
      // W1-T434 changed overrun REFUSAL to PUSH-AND-FLAG: refusing with verdict "failed" destroyed
      // the reaped branch, the only evidence separating phantom reverts from under-declared files.
      // Four refusals in one week reportedly lost ~$29 each (operator report, UNMEASURED here).
      // Worker pushes bypassed it: W1-T393/#1521 changed undeclared src/lib/ledger.ts anyway.
      // This guard reaches only ONE of gitPushRunBranch's nine sites, after the work was paid for.
      // DETECTION is unchanged and names the same paths; BLOCK becomes FLAG. `unwiredAdvisories`
      // affects neither `state` nor `floorState` (lib/review.ts). W1-T434's then-at-open
      // `armAutoMergeAtOpen` meant a phantom revert passing CI and the review floor could merge,
      // whereas refusal had kept it off origin. This accepted tradeoff leaves containment to the
      // merge gate (Standing rule 3B), preserves human adjudication, and admits the guard's limits.
      // EMPTY SCOPE remains asymmetric: scopeGuardOutOfScopeFiles treats absent/empty files as
      // everything out of scope; review-side scopeViolationFiles deliberately never fires then.
      // Thus a no-files task still ledgers scope_guard.overrun but gets NO PR advisory.
      // THREE-DOT is required: origin/main..HEAD compares TIPS and falsely includes files merged
      // to main after this worktree was cut. At drain boot3147755, W1-T395 was wrongly refused
      // after #1533 merged, naming src/run-task.ts and test/drain-gateway-batched.test.ts that its
      // worker never opened. Main advancing must not break a running drain.
      // origin/main...HEAD compares the MERGE BASE: only THIS BRANCH's changes since its start,
      // the same question and convention used at both lib/ci-parity.ts diff sites.
      let diffFiles: string[] | undefined;
      try {
        diffFiles = hostWorktreeGit(worktreePath, MERGE_BASE_DIFF_ARGS)
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);
      } catch (e) {
        // W1-T434: an unreadable diff no longer refuses either, and the reason is NOT merely
        // symmetry with the overrun arm below — an orchestrator-side `git diff` that will not run
        // is a fact about THIS WORKTREE'S git, not about the work the worker did. Failing closed
        // here answered a question about the tooling by throwing away the branch. The line carries
        // no `out_of_scope` key at all rather than an empty one: nothing was compared, and an
        // empty list would read as "compared, found nothing" (the W1-T186 emitter discipline, and
        // the same unknown-is-not-zero law `probeIdle` was corrected to follow).
        log("scope_guard.diff_unreadable", {
          error: String((e as Error)?.message ?? e),
          declared_files: task.files ?? [],
          reason:
            "pushing unflagged rather than refusing: an unreadable orchestrator-side diff says nothing " +
            "about the work, and the scope comparison is re-run per PR at review time",
        });
        say(
          `branch ${branch}'s diff against origin/main could not be read — pushing anyway and leaving the ` +
            `declared-scope comparison to the review, rather than discarding completed work over a diff ` +
            `this worktree could not produce`,
        );
        diffFiles = undefined;
      }
      const outOfScope = diffFiles === undefined ? [] : scopeGuardOutOfScopeFiles(diffFiles, task.files,
        readRegistrationChanges(worktreePath, diffFiles, "origin/main"));
      if (outOfScope.length > 0) {
        // THE REASON IS THIS DECISION'S OWN (the #981 rule — a ledger line carries the reason from
        // the decision that produced its outcome, never from a neighbouring gate).
        log("scope_guard.overrun", {
          out_of_scope: outOfScope,
          declared_files: task.files ?? [],
          reason:
            "pushed and flagged rather than refused: the branch is the only evidence that separates a " +
            "phantom revert from an under-declared files:, and a refusal reaped it — W1-T401's review-side " +
            "advisory carries the overrun to the human gate instead",
        });
        // THE MESSAGE NAMES WHAT IT OBSERVED, NOT A CAUSE IT CANNOT SEE. It used to assert
        // "likely a forged merge-base / phantom revert (the reset --soft near-miss)" — the RAREST
        // of several causes producing an identical file list, and the one a reader then spends an
        // hour chasing. The stale-base cause is gone as of the three-dot fix above, so what remains
        // really is more likely to be a genuine scope problem; the honest phrasing says which two
        // things it compared and leaves the diagnosis to whoever can see more than a file list.
        say(
          `SCOPE OVERRUN: branch ${branch}'s diff against its merge base with origin/main touches file(s) ` +
            `outside task ${taskId}'s declared scope — either the work genuinely went out of scope or ` +
            `the task under-declares files:; pushing and flagging on the PR: ${outOfScope.join(", ")}`,
        );
      }
      say("fallback: pushing branch from orchestrator (outside sandbox)");
      dropTierRowsBeforePush(worktreePath, log);
      // W1-T4797: CI's diff-coverage, scoped, BEFORE the push. `uncovered` goes to the bounded repair rung with
      // CI's own uncovered lines; `covered` and `unavailable` (ledgered with its reason) push as before.
      const precheck = await coveragePrecheck(worktreePath, { ...opts.coveragePrecheckPorts, repo: task.repo });
      const coverageRefusal = coveragePushRefusal(precheck, log, "fallback_push");
      // W1-T5309: an `uncovered-narrow` gap refuses nothing. The worker gets ONE pre-PR repair with the narrow pass's
      // lines, then the push below proceeds whatever that attempt did; CI's coverage-ratchet stays the authority.
      if (precheck.outcome === "uncovered-narrow") {
        const advisory = await repairCensusRefusedPush({
          refusal: { text: `${COVERAGE_PUSH_CHECK}: the diff's own and direct-importer suites leave these added lines uncovered (advisory; the push proceeds after this one attempt) —\n${precheck.text}`, censuses: ["diff-coverage"], offeredBaselines: [] },
          task, runId, worktreePath, branch, resumeSessionId: impl.sessionId, resumeSessionProvider: impl.provider, mount: fixMount,
          settingsFile, config: { ...config, fixStrikeCap: 1 }, budgetUsd, ledgerPath, spawnWallClockBoundMs: fixSpawnWallClockBoundMs(),
          spawn: trackRepairLadder(spawn, { config, log }), account, log, say, recheck: async () => undefined,
        }).catch((error: unknown) => ({ outcome: "error", reason: String((error as Error)?.message ?? error) }));
        say(`coverage: one advisory repair for an uncovered-narrow head ended ${advisory.outcome}; pushing as before`);
      }
      try {
        if (coverageRefusal) throw new FixRoundPushError("run-error", coverageRefusal, coverageRefusal.text);
        await (opts.implementPush ?? gitPushRunBranchAsync)(worktreePath);
      } catch (err) {
        const refusal = err instanceof FixRoundPushError ? err.refusal : censusPushRefusal(err) ?? prePushGateRefusal(err);
        if (!refusal) throw err;
        const refusalLabel = coverageRefusal && err instanceof FixRoundPushError ? "coverage-refused" : censusPushRefusal(err) ? "census-refused" : "pre-push-refused";
        const rung = await repairCensusRefusedPush({
          refusal, task, runId, worktreePath, branch, resumeSessionId: impl.sessionId,
          resumeSessionProvider: impl.provider, mount: fixMount,
          ...(stepUpMount ? { stepUpMount } : {}), settingsFile, config, budgetUsd, ledgerPath,
          spawnWallClockBoundMs: fixSpawnWallClockBoundMs(),
          spawn: trackRepairLadder(spawn, { config, log }), account, log, say,
          catalogFiles: (refusal) => bakedClosureCatalogFiles(refusal.text),
          ...(refusalLabel === "coverage-refused"
            ? { recheck: async () => coveragePushRefusal(await coveragePrecheck(worktreePath, { ...opts.coveragePrecheckPorts, repo: task.repo }), log, "fallback_push.repair") }
            : {}),
        });
        if (rung.outcome === "refused") {
          if (bakedClosureCatalogFiles(rung.refusal.text).length > 0) {
            try {
              const issueUrl = await escalateAsync({ class: "BLOCKED", taskId, runId,
                summary: `implement build ${taskId} could not catalog its baked closure`,
                detail: `Census rows:\n${rung.refusal.text}\n\nBaked-closure catalog:\n${bakedClosureCatalogDetails(rung.refusal.text)}\n\nWorktree kept: ${worktreePath}`,
                options: [{ label: "catalog-and-resume", detail: "catalog the named closure lists in this build, then resume" },
                  { label: "file-a-task", detail: "file a reviewed task for the missed closure join" }],
                recommendation: "catalog-and-resume", consequence: "the build stays failed with its worktree kept until the closure is catalogued" },
              { issues: opts.prOpenRefusalIssues ?? ghIssueGatewayAsync(owner, task.repo), ledgerPath, runId });
              log("census_push.closure_escalated", { issue_url: issueUrl, refusal: rung.refusal.text, worktree: worktreePath });
            } catch (error) {
              log("census_push.closure_escalated", { error: String(error), refusal: rung.refusal.text, worktree: worktreePath });
            }
          }
          // The gate refuses every push of this head, so the worktree is the evidence W1-T434 would have pushed.
          log("verdict", {
            verdict: "failed",
            reason: `${refusalLabel} push not cleared by the fix rung (${rung.reason})`,
            stage: "fallback_push.census",
            cause: "census-refused-push" satisfies RunErrorCause,
            censuses: rung.refusal.censuses,
            refusal: rung.refusal.text,
            strikes: rung.strikes,
            ...headProvenanceFields(worktreePath),
            cost_usd: costUsd,
            billing_mode: billingMode(impl.childEnvKeys),
            account_label: impl.accountLabel,
            ...terminalVerdictFields(impl),
          });
          say(`verdict: failed — ${refusalLabel} push (${rung.refusal.censuses.join(", ")}); worktree kept: ${worktreePath}`);
          return { taskId, runId, merged: false, costUsd, verdict: "failed" };
        }
        stagedClosureCatalogFiles = rung.catalogFiles ?? [];
      }
    }
    // W1-T4425: when the worker already reported its OWN PR, normalize its body from THIS run's
    // plan record before the trailer-amend push below, so `trailer-body-proof-divergence` never
    // reaches CI (#6888, #6929, #6931). Best-effort/no-op cases are documented on the function
    // itself. The fallback below may adopt a worker-opened PR and normalize it afterward.
    if (prUrl) {
      normalizeRunPrAcceptanceFromPlan(prUrl, taskId, task.acceptance ?? [], log);
    }
    // W1-T1012: append the `Remudero-Task:` trailer to the branch's actual tip commit HERE —
    // after both push paths above (the worker's own sandbox push, or the orchestrator
    // fallback just above) have already landed it on origin, and before EITHER PR path below
    // (the worker's own already-reported `prUrl`, or the `gh pr create --fill` fallback) can
    // read that tip. `appendTaskTrailerToCommit` amends only when the trailer is missing, so
    // an already-trailered commit (a worker that wrote it itself) pays no second amend.
    if (appendTaskTrailerToCommit(worktreePath, taskId)) {
      await (opts.implementPush ?? gitPushRunBranchAsync)(worktreePath, { force: true });
    }
    if (!prUrl) {
      let prCreate: ReturnType<typeof ghPrCreateFillCommand>;
      try {
        // W1-T6034: the filed proofs run as awaited children, off the daemon loop. W1-T7952: titled after the task.
        prCreate = await ghPrCreateFillCommandAsync(worktreePath, owner, task.repo, branch, branchPrTitle(worktreePath, task), opts.prOpenProofRunner, true, { log });
      } catch (err) {
        if (!(err instanceof PrOpenRefusedError)) throw err;
        // The branch is already on origin (both push paths ran above), so a refusal names it rather than stranding it.
        const headSha = hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim();
        const issues = opts.prOpenRefusalIssues ?? ghIssueGateway(owner, task.repo);
        const changedFiles = refusedBranchChangedFiles(worktreePath);
        const issueUrl = recordRefusedPrOpen(err, { taskId, branch, headSha, changedFiles, declaredFiles: task.files }, log, { issues, ledgerPath, runId });
        reclaimRunWorktree(repoDir, worktreePath, "pr_open.refused", log);
        log("verdict", {
          verdict: "failed",
          reason: boundedVerdictReason(err.message),
          stage: "pr_open.refused",
          cause: "base-proof-refused" satisfies RunErrorCause,
          branch,
          head_sha: headSha,
          refusal_class: err.refusalClass,
          ...(issueUrl ? { issue_url: issueUrl } : {}),
          cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys),
          account_label: impl.accountLabel,
          ...terminalVerdictFields(impl),
        });
        say(`verdict: failed — PR open refused (${err.refusalClass}); branch ${branch} kept on origin at ${headSha}`);
        return { taskId, runId, merged: false, costUsd, verdict: "failed" };
      }
      // After the local open checks: a refused open never reads GitHub, and a sibling still stops the create.
      const deferred = await deferOpenToSiblingPr(ctx, { impl, branch, worktreePath, repoDir, costUsd });
      if (deferred) return deferred;
      prUrl = runGhPrCreate(prCreate, branch, log, say, opts.prCreateExec).prUrl;
      // A worker may have opened this exact PR without reporting its URL. The generic-422
      // adoption above discovers it only here, after the earlier direct-PR normalization point.
      // Reuse that same body repair before review so the adopted worker prose cannot fail the
      // plan's acceptance gate. A newly created, already-matching body is a no-op.
      if (prUrl) normalizeRunPrAcceptanceFromPlan(prUrl, taskId, task.acceptance ?? [], log);
    }
    if (!prUrl) {
      log("verdict", {
        verdict: "failed",
        reason: "no PR opened",
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      return { taskId, runId, merged: false, costUsd, verdict: "failed" };
    }
    // RUN-OWNERSHIP GUARD (W1-T62) — before ANY side effect touches this PR, assert
    // it is actually this run's own PR (the false-merged inversion backstop; see
    // checkPrOwnership). Fails closed and named on mismatch; the PR is left untouched.
    const ownership = checkPrOwnership(prUrl, branch, ghPrHeadGateway(), costUsd, impl.accountLabel);
    if (ownership) {
      log("verdict", { ...ownership.ledger, ...terminalVerdictFields(impl) });
      say(
        `verdict: pr_attribution_failed — claimed PR ${prUrl} (branch ${ownership.ledger.claimed_branch ?? "unresolved"}) ` +
          `is not this run's own branch (${branch}) — PR left UNTOUCHED`,
      );
      return { taskId, runId, merged: false, costUsd, verdict: "pr_attribution_failed" };
    }
    // Stamp the provenance trailer (deriveStatus source (c)) before gating.
    ensureTaskTrailer(prUrl, taskId, log);
    recordBakedClosureCatalog(prUrl, stagedClosureCatalogFiles, log);
    recordHeadProviderAfterPush(
      { taskId, prUrl, source: "implement", worker: impl, workerHeadCreatedLocally },
      {
        readProducedHeadSha: () => hostWorktreeGit(worktreePath, ["rev-parse", "HEAD"]).trim(),
        readHeadSha: opts.readHeadShaForProvenance ?? readHeadShaRest,
        log,
      },
    );
    // W1-T4614: the head the PR opened at, joinable to its review and CI verdicts and to the assignment that wrote it.
    log("pr.opened", { pr_url: prUrl, ...headProvenanceFields(worktreePath) });
    say(`PR: ${prUrl}`);

    // ── IRREVERSIBILITY SIGNAL (W1-T947, W1-T919 ruling): computed ONCE, right
    // after the PR exists, and reused at BOTH arm-time gates below — the
    // post-review decision gate and the deferred arm call itself (W1-T975; see
    // the "── ARM" block further down, right before pollToGate). Kept here
    // rather than re-derived at either later site: a re-derive could disagree
    // with itself on the identical diff if either read failed differently.
    const irreversible = irreversibleSignalForWorktree(worktreePath);

    // The implement worker's own optional '## Follow-ups' section (§2 OUTPUT CONTRACT,
    // outputContractLines in lib/compaction.ts).
    harvestFollowupsFromReport(fullText(impl), { label: "implement", prUrl, runId, log, say });

    // ── REVIEW GATE (W1-T1D). Wait for `ci` green, then JUDGE the task's
    // acceptance criteria and POST `remudero-review` to the PR head sha — only
    // THEN arm auto-merge. This is the call site the T1C/T1D split left unowned:
    // a REQUIRED check that nothing posts deadlocks every merge, so the poster
    // lives here, before arming. A ci that never greens is blocked_ci (no review
    // over unproven code); a review=failure is blocked_review (the required check
    // is red and GitHub will not merge). Pending is never treated as pass.
    // W1-T5345: the daemon lane hands its PR to the sweep at PR open unless a post-CI gate only
    // this run can apply stands over it (PR_OPEN_HANDOFF_STEP_OWNERS) — that decline is ledgered.
    const handoffDeclined = opts.handOffAtPrOpen
      ? prOpenHandoffDecline({ irreversible, noMerge: !!opts.noMerge, shadowInstance })
      : undefined;
    if (handoffDeclined) log("run.handoff_declined", { trigger: "pr_open", reason: handoffDeclined, pr_url: prUrl });
    const ci = await waitForCiGreen(prUrl, (s, extra) => log(s, extra), 6, {
      externalWaitFreshness: opts.externalWaitFreshness,
      externalWaitRecycle: opts.externalWaitRecycle,
      handOffAtPrOpen: opts.handOffAtPrOpen === true && handoffDeclined === undefined,
    });
    if (ci.state === "freshness_handoff") {
      // W1-T4662: this is a HAND-OFF, never a failure — a healthy run that reached the CI-wait
      // boundary and left its OPEN pr_url for a fresher daemon lifetime to pick back up. It used
      // to share `blocked_transient` with a genuine, repeated Anthropic-side API error, which made
      // the daemon's cross-task API-window hold and lane refill back dispatch off a signal that
      // named nothing wrong. The shared RunResult union names this outcome directly.
      const reason = ci.trigger === "pr_open" ? "pr_open_yield" : ci.recycle === undefined ? "freshness_yield" : "recycle_yield";
      say(
        ci.trigger === "pr_open"
          ? "PR-open handoff: CI is pending; the sweep owns this PR's CI wait, review and merge"
          : `daemon ${ci.recycle === undefined ? "freshness" : "recycle"} handoff: CI is pending; leaving PR open for the refreshed daemon`,
      );
      log("verdict", {
        verdict: "handed_off",
        pr_url: prUrl,
        reason,
        head_sha: ci.sha,
        old_sha: ci.oldSha,
        new_sha: ci.newSha,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "handed_off" };
    }
    const ciState = ciGateState(ci);
    if (ciState !== "green") {
      const reason = ciGateBlockReason(ci);
      say("fallback: pushing branch already done; ci not green — skipping review, leaving PR open");
      log("verdict", {
        verdict: "blocked_ci",
        pr_url: prUrl,
        reason,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      say(`verdict: blocked_ci (${reason}) — PR left OPEN: ${prUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked_ci" };
    }
    // THE REVIEW MUST JUDGE THE PR BODY, NOT THE WORKER'S CHAT TEXT (recon-GK).
    //
    // This passed `fullText(impl)` — the implementation worker's running narrative. `runReview`
    // feeds that string to `bodyContradictsDiff` (lib/review.ts:1803), which asks whether the
    // author's CLAIMS ABOUT THE CHANGESET match the diff. A narrative naturally contains phrases
    // like "plan-only" or "exactly one file" while DESCRIBING the job, so the gate correctly
    // reported a contradiction of a claim the PR BODY never made. Observed live on #1156, the
    // first task PR the autonomous loop produced end to end: its 7,528-byte body contains zero
    // occurrences of "plan-only", and driving `bodyContradictsDiff` with that body and that file
    // list offline returns [] — the checker is right, it was handed the wrong document.
    //
    // W1-T256 fixed this EXACT confusion for the fix rung (see `fetchPrBody`'s doc, above:
    // "this re-review judges the fix worker's CHAT TEXT instead"), and the authoritative
    // `reviewCommand`/`post-review` path has always used `report: body`. This is the third and
    // last consumer to be brought in line.
    //
    // Best-effort, same discipline as W1-T256: a failed read falls back to the worker text rather
    // than blocking the review, so a `gh` outage degrades to the old behaviour instead of a stall.
    //
    // W1-T1100: `reviewReportIsSubstitute` starts true (the fallback value already assigned above
    // is the substitute) and flips to false ONLY on a successful fetch — so a throw leaves it
    // true, matching `reviewReport` staying the worker's text. Threaded into `runReviewFn` below
    // so `bodyContradictsDiff` and the keyword floor both know this is not the PR body.
    let reviewReport = fullText(impl);
    let reviewReportIsSubstitute = true;
    let reviewReportSubstituteCause: import("../../lib/review.js").ReportSubstituteCause | undefined;
    try {
      reviewReport = await fetchPrBodyFn(prUrl);
      reviewReportIsSubstitute = false;
    } catch (e) {
      // This path ALWAYS attempts the fetch, so a substitute here can only mean the read
      // FAILED -- unlike the fix rung, where three of four modes never ask at all.
      reviewReportSubstituteCause = { kind: "fetch-failed" };
      log("review.body_fetch_error", { error: String((e as Error)?.message ?? e) });
    }
    let review = await runReviewFn({
      owner,
      repo: task.repo,
      prUrl,
      task,
      report: reviewReport,
      reportIsSubstitute: reviewReportIsSubstitute,
      reportSubstituteCause: reviewReportSubstituteCause,
      implementationReport: fullText(impl),
      settingsFile,
      config,
      budgetUsd,
      log: (s, extra) => log(s, extra),
      say,
      account,
      reviewerMount,
      reviewerClockBoundMs: workerAbandonMs,
      workerTelemetry: workerStateSensor,
      // A run that established the cash adapter as its containment boundary must keep this
      // reviewer on that same boundary; otherwise a recovered subscription could run after a
      // cash-only proof. Ordinary runs retain runReview's existing default router.
      reviewerSpawnWorker: cashContainmentState.contained ? spawn : undefined,
      // W1-T65 (ratifies P15) — HEAD DISCIPLINE: worktreePath IS the PR head here
      // (this run's own worktree, checked out at the branch it just pushed; CI
      // that follows never mutates it). NEVER the operator's working checkout —
      // the deterministic floor observes THIS run's repo state, not report prose.
      headCheckoutDir: worktreePath,
      reviewerCodeFreshness: () => checkReviewerCodeFreshnessAsync(repoRoot, process.env),
      ledgerPath,
      runId,
      openTaskIds,
    });

    if (review.verdictWithheld) {
      log("verdict", {
        verdict: "blocked",
        pr_url: prUrl,
        reason: review.verdictWithheld,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      say(`verdict: blocked — reviewer code freshness withheld the review verdict: ${prUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
    }

    // ── THE blocked_review FIX RUNG (W1-T76, absorbs P21; §3's fixing state).
    // A failing review used to be TERMINAL here — the PR sat OPEN, the reviewer's
    // computed unmet_criteria + reasons were dropped, and a fresh re-run patched
    // whichever criterion the LAST block named and dropped the other (#111/#113's
    // ping-pong). Dispatch ONE bounded fix worker with the FULL unmet set at once,
    // amending this SAME branch/PR. Wired at the ONE call site `runTask` has — the
    // drain/daemon path and the manual `rmd run-task` path both reach it, so both
    // get the rung for free (no duplicated fix-dispatch logic).
    if (review.state !== "success") {
      const rung = await runFixRung({
        guardRoundHead: true,
        // A run on the real worker spawn is a production run: it always asks the LLM judge.
        useProductionProgressJudge: opts.productionProgressJudge === true || !spawnInjected,
        taskId,
        runId,
        task,
        prUrl,
        branch,
        worktreePath,
        initialSessionId: impl.sessionId,
        initialSessionProvider: impl.provider,
        mount: fixMount,
        ...(stepUpMount ? { stepUpMount } : {}),
        settingsFile,
        config,
        budgetUsd,
        strikeCap: fixStrikeCap(config),
        initialReview: review,
        reviewBase: { owner, repo: task.repo, headCheckoutDir: worktreePath, reviewerMount },
        reviewerClockBoundMs: workerAbandonMs,
        workerTelemetry: workerStateSensor,
        openTaskIds,
        reviewerCodeFreshness: () => checkReviewerCodeFreshnessAsync(repoRoot, process.env),
        deps: {
          writeFixCensusSnapshot: writeFixCensusSnapshotAsync,
          // W1-T3718: the SAME repair-ladder tracking the sweep's fix spawn carries.
          spawn: trackRepairLadder(spawn, { config, log }),
          waitForCiGreen: (url, waitLog) => waitForCiGreen(url, waitLog, 6, { externalWaitRecycle: opts.externalWaitRecycle }),
          // W1-T138: refresh the ci-log evidence whenever a strike leaves CI
          // non-green — see runFixRung's own doc for why this must happen on
          // every strike, not just the first.
          // W1-T2804: when the round's gate read reported the sha it judged, mine THAT commit's
          // rollup over `restRollupFor` — the same REST read the gate itself used — so the two
          // readers cannot answer about different heads. No sha (a stub, or a gate that reported
          // none) falls back to the pre-existing `gh pr view` read unchanged, fail open.
          fetchCiFailures: fixRungCiFailures(owner, task.repo),
          // W1-T1278 (condition A): the SAME `gh pr view --json statusCheckRollup` shape
          // `fetchCiFailures` above reads, but RAW (never filtered to failing names only) — the
          // pre-strike gate needs to see a currently-red name's PENDING later attempt, which
          // `fetchCiFailures` itself deliberately excludes.
          readCiRollup: async (prUrlArg) => {
            const v = ghJson(["pr", "view", prUrlArg, "--json", "statusCheckRollup"]) as {
              statusCheckRollup?: RollupCheck[];
            };
            return v.statusCheckRollup ?? [];
          },
          // W1-T3557: ALWAYS wired in production — `worktreePath` is this rung's own checkout,
          // the SAME one `headCheckoutDir` above already points at, so no extra fetch is spent
          // resolving the plan at whatever head this round's push just landed.
          resolveTaskContractAtHead: (prUrlArg, taskIdArg) => resolveFixRungTaskContractAtHeadAsync(prUrlArg, taskIdArg, worktreePath),
          runReview,
          fetchPrBody: fetchPrBodyViaGh,
          // W1-T3506: the SAME worktree this round pushes to, run through the SAME proof
          // executor `judgeCriterion` itself uses (review.ts's parseWhitelistedProof/
          // execWhitelistedProof) — never a second, hand-rolled grep invocation.
          execAcceptanceGateRepairProof: execGrepProofInWorktree(worktreePath),
          // W1-T2610 + W1-T4693: `expectedHeadSha` still raises `LanePushForeignHeadError` on a rewound ref;
          // a refusal or failure now throws `FixRoundPushError`, which `runFixRung` turns into a named round.
          push: (wt, br, sha, prior) => pushFixRoundPrechecked((step, extra) => log(step, extra), wt, br, sha, { repo: task.repo }, pushFixRound, prior),
          readHeadShaForProvenance: readHeadShaRest,
          issues: ghIssueGateway(owner, task.repo),
          escalationIssues: ghIssueGatewayAsync(owner, task.repo),
          ledgerPath,
          log: (s, extra) => log(s, extra),
          say,
          account,
          // W1-T177: the SAME live-state reader every fix-rung call site
          // wires — a fresh `gh pr view` read, never this run's own snapshot.
          readLiveState: ghLiveState,
          // W1-T296: the pre-strike branch-authorship check's live-head
          // reader — same fresh-`gh`-read discipline as `readLiveState`.
          readLiveHead: ghLiveHead,
          // W1-T1227: wired EXPLICITLY (never left to the internal `?? fetchPrDiffFilesViaGh`
          // default `body-coverage` mode already used, W1-T307) so the pre-strike SCOPE gate
          // ({@link fixRungScopeStandDownReason}) is actually live here, not just in a test that
          // happens to wire it — a fresh `gh pr view --json files` read every round, same
          // fresh-read discipline as `readLiveState`/`readLiveHead` above.
          fetchPrDiffFiles: fetchPrDiffFilesViaGh,
          // W1-T1095: the SAME `ghLiveState` reader, aimed at whatever prerequisite PR number
          // a "blocked on #N" review names, in THIS task's own owner/repo — see runFixRung's
          // own `readPrerequisiteState` doc for the fail-safe (not-merged) default this takes
          // on a failed/indeterminate read.
          readPrerequisiteState: (n) => ghLiveState(`https://github.com/${owner}/${task.repo}/pull/${n}`),
          // W1-T1095 (capability 3): the two REST observations and the update-branch write.
          // Both are PURE API — no branch, no checkout — because the daemon is detached on every
          // boot, the assumption that broke `armAuto`'s `--delete-branch` (W1-T1111).
          readMergeFacts: (n) => fixRebaseMergeFactsFromRest(owner, task.repo, n),
          // W1-T2671: separate reversed-compare read for the base-only gap. Kept distinct from
          // `readMergeFacts` so ordinary pre-strike mergeability checks do not pay for or confuse
          // this ci-log-only file-overlap optimization.
          readRedBaseRefreshFacts: (n) => redBaseRefreshFactsFromRest(owner, task.repo, n),
          // W1-T8396: this rung's own checkout already holds the head, so its trial merge needs no fetch of it.
          reproduceFailingTestsOnMerge: buildBaseReproductionProbe(config, worktreePath, ledgerPath, (s, extra) => log(s, extra), { merge: true }),
          updateBranch: (n) => ghUpdateBranch(owner, task.repo, n),
          // W1-T1044: the wall-clock bound on this rung's own worker spawn, and the best-effort
          // reclaim of whatever it abandoned — see runFixRung's own deps doc. W1-T1219: reads
          // `fixSpawnWallClockBoundMs`, its OWN policy row, not the sweep tick's.
          spawnWallClockBoundMs: fixSpawnWallClockBoundMs(),
          // W1-T2261: binds this rung's OWN `log` through so a match/no-match reclaim outcome
          // (`fix.spawn_reclaimed`/`fix.spawn_reclaim_no_match`) lands in the same ledger stream
          // as `fix.spawn_abandoned` — the bare function reference below this before this task
          // reached `reclaimAbandonedWorker`'s default no-op log, so neither outcome was ever
          // recorded, only inferred from the process table staying quiet.
          reclaimWorker: (info) => reclaimAbandonedWorker(info, { log: (s, extra) => log(s, extra) }),
          // W1-T1284: the pre-strike UNCHANGED-TREE check's live worktree reader — three LOCAL
          // git reads against this rung's own checkout, never the PR's remote head.
          captureWorktreeSnapshot: captureWorktreeSnapshotViaGit,
          // W1-T2403: the SAME local-worktree discipline as `captureWorktreeSnapshot` above — a
          // real `git` read against this rung's own checkout, never a remote call.
          readRoundCommits: readFixRoundCommitsViaGit,
          // W1-T2551: the generator-fix short-circuit's three real, local wirings — `npm run`,
          // `git add -A && git commit`, and this checkout's OWN package.json scripts. See each
          // helper's own doc for why every write stays best-effort/fail-closed.
          runGeneratorScript: async (script, cwd) => runNpmScriptViaSpawn(script, cwd),
          commitGeneratorOutput: (o) => commitGeneratorOutputViaGit(o),
          packageScripts: readPackageScriptsFor(worktreePath),
        },
      });
      review = rung.review;
      if (rung.outcome === "spawn_abandoned") {
        // W1-T1044: the worker never demonstrably returned — never a strike (see
        // spawnFixWorkerBounded's own doc), and the abandonment is already ledgered
        // (`fix.spawn_abandoned`) + reclaimed before this rung returned. Blocked, exactly like
        // the escalated/stood-down outcomes below, so the drain's stop-on-block invariant holds.
        log("verdict", {
          verdict: "blocked",
          pr_url: prUrl,
          reason: `fix rung abandoned — worker spawn exceeded its ${rung.spawnAbandonedElapsedMs}ms wall-clock bound`,
          cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys),
          account_label: impl.accountLabel,
          ...terminalVerdictFields(impl),
        });
        say(`verdict: blocked — fix worker spawn abandoned (wall-clock bound): ${prUrl}`);
        return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
      }
      if (rung.outcome === "handed_off") {
        log("verdict", {
          verdict: "handed_off", pr_url: prUrl, reason: rung.reason, cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys), account_label: impl.accountLabel, ...terminalVerdictFields(impl),
        });
        say(`verdict: handed_off (${rung.reason}) — PR left OPEN: ${prUrl}`);
        return { taskId, runId, prUrl, merged: false, costUsd, verdict: "handed_off" };
      }
      if (rung.outcome === "escalated") {
        log("verdict", {
          verdict: "blocked",
          pr_url: prUrl,
          reason: `fix rung exhausted after ${rung.strikes} strike(s)`,
          issue_url: rung.issueUrl,
          cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys),
          account_label: impl.accountLabel,
          ...terminalVerdictFields(impl),
        });
        say(`verdict: blocked — fix rung exhausted (${rung.strikes} strike(s)), escalated: ${rung.issueUrl}`);
        return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
      }
      if (
        rung.outcome === "stood_down" ||
        rung.outcome === "parked" ||
        rung.outcome === "rebased" ||
        rung.outcome === "base_refreshed"
      ) {
        // NON-SPENDING TERMINATIONS, ONE EMISSION.
        //
        // W1-T177 (`stood_down`): this run's own PR went terminal (merged/closed) mid-rung —
        // stand down rather than spend another strike or escalate.
        //
        // W1-T1095 (`parked`): the remedy lives OUTSIDE this diff — never a strike spent, never
        // an issue opened (design note v: the operator's merge gate is never softened by this
        // rung). The PR stays open exactly like every other "blocked" verdict; the next poll
        // that reaches this same rung re-checks the prerequisite and resumes automatically the
        // moment it merges (capability 3 — see `outOfDiffBlockerFor`/`prerequisiteMerged`).
        //
        // BOTH reuse the existing "blocked" verdict (never a spend, never a bypass) so the
        // drain's stop-on-block invariant still holds; the ledger line names the SITE and the
        // STATE, not just "blocked". What differs between them is ONLY the reason, one extra
        // ledger field and the console phrasing — `fixRungTerminationVerdict` owns exactly that
        // difference as a pure function with a unit fixture per arm, so `parked` shares this
        // already-exercised emission instead of being a second near-identical block that no
        // test can reach.
        const termination = fixRungTerminationVerdict(rung);
        log("verdict", {
          verdict: "blocked",
          pr_url: prUrl,
          reason: termination.reason,
          ...termination.extra,
          cost_usd: costUsd,
          billing_mode: billingMode(impl.childEnvKeys),
          account_label: impl.accountLabel,
          ...terminalVerdictFields(impl),
        });
        say(`verdict: blocked — ${termination.phrase}: ${prUrl}`);
        return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
      }
    }

    // ── W1-T185 (Gap 1, criteria 2-3), raised by W1-T229: THE AUTO-MERGE
    // ARMING PATH refuses ANY CAPPED verdict, unattended — the #411 shape
    // (0/5 proofs executed, posted as uncapped PASS, merged without a human reading the diff).
    // W1-T229 removed the tdd:strict exemption: capped non-strict PRs had armed like ordinary
    // PASS, making prose the DEFAULT floor because {tdd: strict} is opt-in.
    // No autonomous run grants itself an override: a HUMAN grants it out of band through
    // `rmd review <pr> --override-capped-by/--override-capped-reason`; recover it from the SAME
    // readLedgerLines ledger as every other precedence check. Uncapped verdicts arm unchanged:
    // decideAutoMergeArm REFUSES only the shape named by rule22 fixture(iii).
    // KNOWN RESIDUAL GAP, outside W1-T185's plan/tasks.yaml files scope: sweep.ts's independent
    // "checks green + review success -> mergeable" reconciliation does not consult capped or an
    // override. A refused PR stays OPEN and UNARMED here but a later sweep could still arm it.
    // Leave that gap to its follow-up rather than silently widening this task.
    // A SECOND, SAME-SHAPED RESIDUAL GAP (W1-T947): its W1-T947-*.yaml plan shard files name
    // only review.ts, run-task.ts and its test. decideArmFromLedgerVerdict/armAutoMerge
    // (lib/review.ts, lib/run-task.ts), reached through withdrawArmIfVerdictRefuses/
    // armIfVerdictPermits, use the SAME decideAutoMergeArm but pass no irreversible signal:
    // ledger recovery has no live worktree diff. Thus a PR these two run gates correctly refuse
    // could still be armed by a later sweep or manual `rmd review`. Keep this out-of-scope gap
    // explicit, per the task's own design clause(v).
    const tddStrict = isTddStrict(task.principles);
    // W1-T948: the specialist panel's testing trigger (specialist-panel.ts)
    // reads the SAME `principles` this line just did, through the panel's one
    // real production call path — `taskMetadataFromPrinciples` wraps the same
    // `isTddStrict` read above, so the two can never disagree. Observability
    // only (a log line): no diff content is sourced, since only the testing
    // trigger is in this task's scope (specialist-panel.ts's own W1-T948
    // determination doc explains why the diff is deliberately empty-files).
    const specialistTriggers = routeSpecialists({
      diff: { files: [] },
      task: taskMetadataFromPrinciples(task.principles),
    });
    if (specialistTriggers.length > 0) {
      log("specialist.panel", { triggers: specialistTriggers.map((t) => t.specialist) });
    }
    // W1-T219: head-bound — an override granted against a DIFFERENT head than
    // this exact verdict's is never honoured (see cappedOverrideFromLedger).
    const cappedOverride = review.capped
      ? cappedOverrideFromLedger(readLedgerLines(ledgerPath), taskId, review.headSha)
      : undefined;
    // W1-T947: `irreversible` reuses the SAME diff-derived verdict computed above at PR-open
    // (never re-derived — a re-derive here could disagree with the at-open gate on the
    // identical diff if either read failed differently) so this decision-time gate honours the
    // W1-T919 ruling exactly like the at-open one just did.
    const armDecision = resolveAutoMergeArm(review, tddStrict, cappedOverride, (s, extra) => log(s, extra), irreversible);
    if (!armDecision.arm) {
      // W1-T125 primitive, retargeted by W1-T975: this run itself never arms until
      // AFTER this check passes (see the deferred arm call further down, right
      // before pollToGate), so there is usually nothing here to withdraw. Kept as
      // a defensive no-op against the KNOWN RESIDUAL GAP named a few lines above
      // (sweep.ts's own "checks green + review success" arming predicate reacting
      // to this same capped verdict's posted `success` status before this
      // decision lands) — if the sweep armed the PR in that window, this
      // withdraws it before escalating.
      // W1-T947: CAPPED and IRREVERSIBLE are different facts about the PR — the reason below,
      // and the escalation it feeds, must name the one that actually fired (design clause iii).
      const reason = irreversible
        ? "diff classified irreversible (W1-T919) — auto-merge refused unattended"
        : "capped verdict refused auto-merge";
      // W1-T1215: FOLLOW THE OUTCOME. This discarded the return and logged `automerge.disarmed`
      // unconditionally, so a withdrawal GitHub refused read as a completed one. `disposeDisarm`
      // holds the whole decision (and every lost-race-only read) where a test can reach it.
      const disposition = disposeDisarm(await disarmAutoMergeAsync(prUrl), { prUrl, taskId, runId, ledgerPath, reason, refusal: armDecision.reason });
      log(disposition.step, disposition.row);
      const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? prUrl;
      const issueUrl = escalate(
        // W1-T1215: the lost race outranks BOTH arms below — "auto-merge was NOT armed" is simply
        // false once it armed and merged, so that must not be what an operator reads.
        disposition.escalation ??
        (irreversible
          ? {
              class: "BLOCKED",
              taskId,
              runId,
              summary: `diff classified IRREVERSIBLE — auto-merge refused unattended (W1-T919) — ${prUrl}`,
              detail: `${armDecision.reason}\n\nAuto-merge was NOT armed.`,
              options: [
                {
                  label: "merge-manually",
                  detail:
                    "read the diff and, once satisfied it is correct and intended, merge it by hand — " +
                    "or close/amend it if the irreversible effect should not ship as-is.",
                },
              ],
              recommendation: "merge-manually",
            }
          : {
              class: "BLOCKED",
              taskId,
              runId,
              summary: `CAPPED verdict — auto-merge refused unattended — ${prUrl}`,
              detail:
                `remudero-review posted CAPPED (0 of ${review.criteria.length} proofs executed). ` +
                `${armDecision.reason}\n\nAuto-merge was NOT armed.`,
              options: [
                {
                  label: "add-proof",
                  detail:
                    "push executable proof (a whitelisted `grep:`/`unit test:` dialect proof) so the review " +
                    "executes and certifies the diff for real, then re-drain.",
                },
                {
                  label: "override",
                  detail:
                    `rmd review ${prNum} --override-capped-by <name> --override-capped-reason <text>, then ` +
                    `re-drain to arm.`,
                },
              ],
              recommendation: "add-proof",
            }),
        { issues: ghIssueGateway(owner, task.repo), ledgerPath, runId },
      );
      log("verdict", {
        verdict: "blocked",
        pr_url: prUrl,
        reason,
        issue_url: issueUrl,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      say(`verdict: blocked — ${irreversible ? "diff classified irreversible" : "CAPPED verdict"}, escalated: ${issueUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
    }

    // ── RISK JUDGE (P34 clause (b), MASTER-PLAN §4B/§9, W1-T248): assess THIS
    // candidate change — never `task.risk` (a sizing artifact, never consulted here) —
    // before an already-armed PR is allowed to fall through to the merge gate.
    // Low-risk-and-confident PROCEEDS unchanged. High-risk OR low-confidence ESCALATES,
    // naming the judge's own OBSERVED reasons (W1-T186 emitter discipline); the escalate
    // dep below withdraws the early arm-at-open FIRST (the identical W1-T125 shape the
    // capped-refusal branch above uses), so an already-armed PR can never merge behind
    // this escalation. Judge-unavailable (spawn error, unparseable output) fails closed
    // to ESCALATE inside assessRisk itself — this call site never has to remember that
    // rule. Runs on the cheapest configured (haiku-class) mount, resolved fresh from
    // mounts.yaml (W1-T5) rather than any mount already resolved for the task's own work.
    // W1-T970: the identifiers a refusal needs to be sha-keyed — captured HERE, at input
    // construction, never re-read later. `prUrl` is already in scope (used above in
    // `change.description`) and `review.headSha` is the SAME head `cappedOverrideFromLedger`
    // read a few statements earlier — the head this candidate change was actually assessed at,
    // not whatever `gh pr view` would report if re-read after the judge returns.
    // W1-T2284: `description` is the ONLY place `task.title` reaches the judge — it used to
    // ALSO ride along as `planContext.title` below, the same string under a second label,
    // which is what let #2853 read as a double confirmation of a defect rather than one
    // description of one change. `planContext` now carries `taskId`/`taskType` only.
    const riskJudgeInput: RiskJudgeInput = {
      change: { description: `${task.title} — ${prUrl}`, files: task.files },
      gatesState: { review_state: review.state, review_capped: review.capped, ci, arm_decision: armDecision.reason },
      planContext: { ...riskJudgePlanContext(task.id, task) },
      planContextDigest: riskJudgePlanContextDigest(task),
      prNumber: prNumberFromRef(prUrl),
      headSha: review.headSha,
    };
    const riskJudgeMount = resolveRiskJudgeMount(loadMounts(mountsPath(repoRoot)));
    // W1-T4050: LIVE, per-run read of `plan/policy.yaml`'s `risk:` section — never memoized
    // (unlike `loadDefaultPolicy`), so an operator's merged policy edit governs the very next
    // unattended risk judgment with no daemon restart. Absent section ⇒ DEFAULT_RISK_POLICY,
    // reproducing the pre-existing hard-coded 0.7 exactly.
    const riskPolicy = readRiskPolicy(policyPath(repoRoot));
    // W1-T1031: fetch the ACTUAL change view (bounded, REST-sourced — see `changeView`'s own
    // doc) and attach it to the input the real judge is given, right before it runs. A throw
    // from `changeView(prUrl)` here (an unparseable prUrl, a failed REST call) is deliberately
    // left to PROPAGATE, never caught: `assessRisk` marks the observation unavailable, and this
    // caller's explicit policy retains the deterministic gates without inventing a risk decision
    // or falling back onto the declared `task.files` list alone, which would reproduce this task's
    // own defect under the cover of "best effort".
    // W1-T2383 (rank 1): ONE collector per judgment — `realRiskJudge` records each spawn into it
    // and `runRiskJudge` reads the total onto the `risk_judge.decision` row it already writes.
    // Declared HERE, at the single call site, so it cannot outlive one judgment.
    const riskJudgeSpend = riskJudgeSpendCollector();
    let primaryRiskServedModel: string | null = null;
    let judgedRiskInput = riskJudgeInput;
    // W1-T7724: the view is read ONCE; the diff tier (a second judgment of an uncertain `low`) reuses its patches.
    let readChangeViewOnce: RiskJudgeChangeView | undefined;
    const judgeWithChangeView = async (input: RiskJudgeInput): Promise<RiskJudgeVerdict> => {
      const view = (readChangeViewOnce ??= changeView(prUrl));
      judgedRiskInput = {
        ...input,
        change: { ...input.change, changeView: withoutRiskJudgePatches(view) },
      };
      return realRiskJudge({
        mount: riskJudgeMount, cwd: worktreePath, settingsFile, spend: riskJudgeSpend,
        spawn: async (options) => {
          const result = await spawn(options);
          primaryRiskServedModel = result.servedModel ?? result.routedModel ?? null;
          return result;
        },
      })(judgedRiskInput);
    };
    const riskJudgeResult = await runRiskJudge(riskJudgeInput, {
      judge: judgeWithChangeView,
      spend: riskJudgeSpend,
      diffSource: {
        read: () => readChangeViewOnce ?? changeView(prUrl),
        inputBudgetChars: riskJudgeDiffInputBudget(riskJudgeMount),
      },
      escalate: async (verdict, action) => {
        // W1-T125 shape, retargeted by W1-T975: this run itself never arms until
        // AFTER the risk judge proceeds (see the deferred arm call further down),
        // so there is usually nothing here to withdraw — kept as the same
        // defensive no-op against a sweep race as the capped-refusal branch
        // above, in case the sweep armed the PR in the window between the review
        // posting and this decision.
        // W1-T1215: FOLLOW THE OUTCOME. This discarded the return and logged
        // `automerge.disarmed` unconditionally beside it, so the withdrawal #2506 attempted —
        // which GitHub refused because the pull request had ALREADY MERGED — was recorded as a
        // completed withdrawal. Same predicate and same vocabulary `withdrawArmIfVerdictRefuses`
        // already established (W1-T1056); this only applies them at the site that fired.
        const disposition = await riskJudgeDisarm({
          prUrl, taskId, runId, ledgerPath,
          reason: "risk judge escalated — auto-merge refused",
          refusal: `risk judge ESCALATED (${verdict.verdict}, confidence ${verdict.confidence.toFixed(2)}) — ${action.reason}`,
          confidence: verdict.confidence,
          reasons: verdict.reasons,
        });
        log(disposition.step, disposition.row);
        // W1-T1215: a REFUSED verdict on a change that MERGED ANYWAY is not a BLOCKED row — the
        // thing BLOCKED says cannot proceed has already proceeded, so it escalates HARD_STOP.
        return escalate(
          disposition.escalation ?? {
            class: "BLOCKED",
            taskId,
            runId,
            summary: `risk judge ESCALATED (${verdict.verdict}, confidence ${verdict.confidence.toFixed(2)}) — ${prUrl}`,
            detail: `${action.reason}\n\nAuto-merge was NOT allowed to proceed unattended.`,
            options: [
              {
                label: "review-manually",
                detail: "read the diff and either merge it by hand or push a follow-up fix, then re-drain.",
              },
            ],
            recommendation: "review-manually",
          },
          { issues: ghIssueGateway(owner, task.repo), ledgerPath, runId },
        );
      },
      // W1-T5403: key every judge row to the PR head, so the sweep never re-judges a head decided here.
      log: (s, extra) => log(s, { ...extra, pr_number: riskJudgeInput.prNumber, head_sha: riskJudgeInput.headSha }),
    }, {
      // Judge unavailability is recorded, while the deterministic gates remain authoritative.
      judgeUnavailableAction: "proceed",
      // W1-T4050: the configured threshold (plan/policy.yaml's `risk.confidenceThreshold`,
      // read live above) is the one this unattended caller applies — no longer the module's
      // own DEFAULT_CONFIDENCE_THRESHOLD literal, unreachable from outside risk-judge.ts.
      confidenceThreshold: riskPolicy.confidenceThreshold,
      borderlineBand: riskPolicy.borderlineBand,
    });
    if (riskJudgeResult.verdict.availability !== "unavailable") {
      await runShadowJudge({
        surface: "risk", key: `${task.id}:${review.headSha}`,
        primaryMount: riskJudgeMount, primaryDecision: riskJudgeResult.verdict.verdict,
        primaryServedModel: primaryRiskServedModel,
        mounts: () => [riskJudgeMount, resolveMount(loadMounts(mountsPath(repoRoot)), "reviewer", task.risk)],
        log,
        judge: async (mount) => {
          let shadowServedModel: string | null = null;
          const shadow = await realRiskJudge({
            mount, cwd: worktreePath, settingsFile, maxAttempts: 1,
            spawn: async (options) => {
              const result = await spawn({
                ...options, maxTurns: Math.min(options.maxTurns ?? 4, 4),
                maxBudgetUsd: SHADOW_JUDGE_MAX_BUDGET_USD,
                clockBound: { boundMs: 60_000 },
              });
              shadowServedModel = result.servedModel ?? result.routedModel ?? null;
              return result;
            },
          })(judgedRiskInput);
          if (shadow.availability === "unavailable") throw new Error("shadow risk verdict unavailable");
          return { decision: shadow.verdict, servedModel: shadowServedModel };
        },
      });
    }
    if (riskJudgeResult.action.kind === "escalate") {
      log("verdict", {
        verdict: "blocked",
        pr_url: prUrl,
        reason: "risk judge escalated",
        issue_url: riskJudgeResult.escalationUrl,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      say(`verdict: blocked — risk judge escalated: ${riskJudgeResult.escalationUrl}`);
      return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };
    }

    // ── ARM (W1-T125, DEFERRED BY W1-T975): register GitHub auto-merge only NOW —
    // the FIRST point this run stands behind a verdict: CI green, review passed (or fixed),
    // capped gate did not refuse and risk judge did not escalate. Earlier ci-not-green,
    // fix-exhausted, stood-down, capped-refusal and risk-escalation exits RETURN before this
    // line, leaving NO standing arm.
    // W1-T975: alreadyDone = pr.autoMergeArmed === true short-circuits the sweep's own arming
    // decision, the ONE place it can consult a durable W1-T970 risk refusal (lib/sweep.ts).
    // Old at-open arming bypassed that predicate permanently on every early exit. Disarming
    // those exits would not fix it: checks-green + review-success re-armed the PR in five of
    // five measured races. Deferral leaves an abandoned PR only the sweep's mergeable route,
    // where the durable refusal cannot be bypassed.
    // The LATE blocked_ci exit AFTER pollToGate still keeps its arm: review was posted and
    // risk passed before arming, so polling the already-armed PR is unchanged.
    // W1-T1256 no-merge boundary: ONLY wipeTestCommand sets opts.noMerge, for BOTH arms of a
    // wipe-test pair. Pure resolveWipeTestArmPermission in wipe-test.ts decides; this call site
    // skips armAutoMergeAtOpen outright on refusal, so the pair's PR cannot arm or merge away.
    // Check shadow before wipe-test; the counterfactual uses this same live arm decision.
    if (shadowInstance) {
      const shadowVerdict = shadowLiveWouldHaveDone(true);
      log("shadow.verdict", {
        pr_url: prUrl,
        task_id: taskId,
        review_verdict: review.state,
        ...shadowVerdict,
      });
    }
    const shadowArmDecision = resolveShadowInstanceArmPermission(shadowInstance);
    const wipeTestArmDecision = resolveWipeTestArmPermission(!!opts.noMerge);
    const armOutcome = await observeSelectedMode<ArmOutcome | "no-merge-boundary-refused" | "shadow-instance-refused">(
      selectedModeQualification, "run-arm", async () => !shadowArmDecision.armed
      ? "shadow-instance-refused"
      : wipeTestArmDecision.armed
        ? await armAutoMergeAtOpenAsync(prUrl,
          selectedModeQualification === undefined ? undefined : realArmDepsAsync(() => config, selectedModeQualification), irreversible)
        : "no-merge-boundary-refused", prUrl);
    // W1-T2258: `review.headSha` — the SAME head captured in `riskJudgeInput` above — is already
    // in scope here and simply was not put on the row; this is the SINGLE LARGEST dropped
    // population (the "run-task" lane, the deferred arm every normal implement-task PR takes).
    log("automerge.armed", {
      at: "verdict",
      outcome: armOutcome,
      irreversible,
      head_sha: review.headSha,
      ...(wipeTestArmDecision.reason ? { reason: wipeTestArmDecision.reason } : {}),
    });
    // ── POLL to the gate (W1-T1B).
    // Auto-merge was armed immediately above, now that this run has a verdict it
    // stands behind — this block only observes. The runner NEVER force-merges:
    // GitHub merges only when the required check is green. If checks go red or
    // the poll times out, the PR is LEFT OPEN and the verdict is blocked_ci —
    // pending is treated as blocked, never as pass. No Action arms a PR; only
    // this code, only on PRs it opened.
    const outcome = await pollToGate(prUrl, (s, extra) => log(s, extra), 6, {
      externalWaitRecycle: opts.externalWaitRecycle ?? (() => recyclePauseDetail(config.root)),
    });

    if (outcome.merged) {
      log("pr.merged", { state: "MERGED" });
      worktreeRemove(repoDir, worktreePath);
      log("worktree.remove", {});
      log("verdict", {
        verdict: "merged",
        pr_url: prUrl,
        cost_usd: costUsd,
        billing_mode: billingMode(impl.childEnvKeys),
        account_label: impl.accountLabel,
        ...terminalVerdictFields(impl),
      });
      say(`verdict: merged · notional cost $${costUsd.toFixed(4)}`);
      return { taskId, runId, prUrl, merged: true, costUsd, verdict: "merged" };
    }

    // Blocked or awaiting merge: leave the PR open (auto-merge stays armed; it will land later if
    // GitHub materializes it) and the worktree for post-mortem.
    const terminalVerdict = outcome.verdict ?? "blocked_ci";
    log("verdict", {
      verdict: terminalVerdict,
      pr_url: prUrl,
      reason: outcome.reason,
      ...(outcome.headSha ? { head_sha: outcome.headSha } : {}),
      ...(outcome.checks ? { checks: outcome.checks } : {}),
      cost_usd: costUsd,
      billing_mode: billingMode(impl.childEnvKeys),
      account_label: impl.accountLabel,
      ...terminalVerdictFields(impl),
    });
    say(`verdict: ${terminalVerdict} (${outcome.reason}) — PR left OPEN: ${prUrl}`);
    return { taskId, runId, prUrl, merged: false, costUsd, verdict: terminalVerdict };
  } catch (err) {
    // W1-T7807: the quiet-worker watchdog's `end_round` verdict (or a pending recycle) stopped this round AFTER pushing a
    // checkpoint. That is a handoff, never a failure, and the worktree is kept exactly as the freshness yield keeps it.
    if (err instanceof QuietRoundEndedError) {
      for (const row of roundEndedHandoffRows(err.detail, branch)) {
        log(row.step, row.step === "verdict" ? { ...row.fields, cost_usd: costUsd, ...terminalVerdictFields(null) } : row.fields);
      }
      say(`verdict: handed_off — ${err.detail.trigger === "recycle" ? "a pending recycle" : err.detail.trigger === "restart" ? "a latched daemon restart" : "the quiet-worker watchdog"} ended the round (${err.detail.reason})`);
      return { taskId, runId, merged: false, costUsd, verdict: "handed_off" };
    }
    // W1-T1045: the clock-bound watchdog (worker.ts) aborted a silent dispatch spawn — NAME it
    // and return a terminal verdict rather than falling through to the generic `run.error` +
    // re-throw below, which would leave this run's promise REJECTED instead of resolved: exactly
    // the "vanishes rather than ends" gap criterion 5 exists to close.
    if (err instanceof WorkerAbandonedError) {
      const { evidence } = err;
      // THE EVIDENCE LANDS FIRST — before the worktree is removed below, before this function's
      // own `finally` drops the worktree liveness lock, and before `runTask`'s outer `finally`
      // releases the inflight lock: the task note's own ordering requirement ("BEFORE anything
      // is released"). `num_turns` is deliberately absent, never fabricated: a stalled stream
      // never produced the SDK's completion envelope, so there is nothing to report.
      log("verdict", {
        verdict: "failed",
        reason: err.message,
        stage: "worker.abandoned",
        elapsed_ms: evidence.elapsedMs,
        bound_ms: evidence.boundMs,
        last_state: evidence.lastState ?? null,
        last_state_ms: evidence.lastStateMs ?? null,
        cost_usd: costUsd,
        ...terminalVerdictFields(null),
      });
      say(
        `verdict: failed — worker abandoned after ${Math.round(evidence.elapsedMs / 1000)}s of silence ` +
          `(bound ${Math.round(evidence.boundMs / 1000)}s, last observed state: ${evidence.lastState ?? "unknown"})`,
      );
      try {
        worktreeRemove(repoDir, worktreePath);
        log("worktree.remove", { on: "worker.abandoned" });
      } catch (e) {
        log("worktree.remove.error", { on: "worker.abandoned", error: String((e as Error)?.message ?? e) });
      }
      return { taskId, runId, merged: false, costUsd, verdict: "failed" };
    }
    if (isCodexWorkerOutputLimitError(err)) {
      log("verdict", {
        verdict: "failed",
        reason: err.message,
        stage: "worker.bounded_output",
        stream: err.stream,
        limit_bytes: err.limitBytes,
        observed_bytes: err.observedBytes,
        // W1-T4595: which event kinds filled it, on the task row too (not only on retro.error).
        event_bytes_by_kind: err.event_bytes_by_kind ?? err.eventBytesByKind ?? {},
        pending_line_bytes: err.pendingLineBytes ?? 0,
        cost_usd: costUsd,
        ...terminalVerdictFields(null),
      });
      say(
        `verdict: failed — Codex worker ${err.stream} output exceeded ${err.limitBytes} bytes ` +
          `(${err.observedBytes} observed)`,
      );
      try {
        worktreeRemove(repoDir, worktreePath);
        log("worktree.remove", { on: "worker.bounded_output" });
      } catch (e) {
        log("worktree.remove.error", { on: "worker.bounded_output", error: String((e as Error)?.message ?? e) });
      }
      return { taskId, runId, merged: false, costUsd, verdict: "failed" };
    }
    log("run.error", { error: String((err as Error)?.message ?? err) });
    // W1-T9786: nor is a thrown harness error (W1-T9047's refused push), so this exit keeps it too.
    let keptThroughThrow: { branch: string; headSha: string } | undefined;
    try {
      keptThroughThrow = verdictWritten ? undefined : checkpointToKeep();
    } catch (error) {
      // Unproven (a refused worktree pointer): keep nothing, as before, and never replace the run's own error.
      log("implement.checkpoint_keep_unproven", { task_id: taskId, error: String((error as Error)?.message ?? error) });
    }
    // W1-T4655: the run DID end, so it gets ONE terminal row naming the harness cause.
    endThrownRun(log, verdictWritten, "run.error", err, costUsd);
    if (keptThroughThrow) {
      log("implement.checkpoint_kept", { task_id: taskId, source_branch: keptThroughThrow.branch, head_sha: keptThroughThrow.headSha,
        failed_stage: "run.error", failed_cause: runErrorCause(err) });
    }
    // Reclaim the worktree even on an unexpected throw — a dead run must not
    // leave debris that blocks the next one (start-of-run prune is the backstop,
    // but clean up eagerly here too). Best-effort; the ledger already has the
    // error. The stale run-* branch is swept by the next run's pruneStaleRuns.
    try {
      worktreeRemove(repoDir, worktreePath);
      log("worktree.remove", { on: "run.error" });
    } catch (e) {
      log("worktree.remove.error", { on: "run.error", error: String((e as Error)?.message ?? e) });
    }
    throw err;
  } finally {
    // Terminal verdict (or throw) ⇒ this run no longer owns the worktree. Drop the
    // liveness token so a later prune may reclaim the worktree. Idempotent; the
    // sibling file also vanishes with the worktree on the paths that remove it.
    removeRunLock(worktreePath);
    // W1-T1268: HOLDER ARM — drop the dispatch claim this run took, CAS'd on `claimAnchor` so
    // this can only ever delete the claim it still holds, never one that has since become
    // another lane's. Best-effort, matching `removeRunLock` immediately above: a throw here
    // must never replace whatever verdict this run actually reached.
    try {
      const released = await releaseDispatchClaimAsync(task.id, claimReserver, { anchor: await claimLease.stop() });
      log("dispatch.claim_released", {
        ref: dispatchClaimRef(task.id),
        arm: released.arm,
        release: released.release,
        dropped: released.dropped,
        reason: released.reason,
      });
    } catch (e) {
      log("dispatch.claim_release_error", { error: String((e as Error)?.message ?? e) });
    }
  }
} // ── end runTaskBody

