import { join, basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadConfig, type Config } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { appendLedger, deriveLedgerActor, DECISION_RELEVANT_LEDGER_STEPS } from "../../lib/ledger.js";
import { systemClock, type Clock } from "../../lib/clock.js";
import { loadPlan, type Plan, type MergedResolver, type AcceptanceCriterion, type Task } from "../../lib/plan.js";
import { repoRoot, resolveOwnerRepo } from "../../lib/repo-location.js";
import { flagValue, unknownArgError } from "../../lib/cli-args.js";
import { instanceMode, readInstanceRegistryText } from "../../lib/instance-mode.js";
import { checkReviewerCodeFreshnessAsync, type ReviewerCodeFreshness } from "../../lib/self-sync.js";
import { buildBaseProofDir, releaseBaseProofDir, type BaseProofDir } from "../../lib/check-proof.js";
import { ghJsonAsync, ghExec, ghTextAsync, type GhAsyncExecutor } from "../../lib/github-transport.js";
import { readLedgerLines, buildBatchedGithub, type GitHub, deriveStatus, isGhRateLimitError, taskIdFromRunBranch, readRequiredStatusCheckContexts } from "../../lib/status.js";
import { liveInflightRuns, type LiveInflightRun } from "../../lib/report-commands.js";
import { worktreeRemove, runWorktreeReapRung, type WorktreeReapSummary, ghJson, parseReport, pruneStaleRuns, removeWorktreeBase, removeRunLock, renderWorkerSettings, spawnWorker, worktreeAdd } from "../../lib/worker.js";
import { automaticBranchReapStateFileName, readAutomaticBranchReapState, writeAutomaticBranchReapState, type AutomaticBranchReapState, branchNamesFingerprint, decideAutomaticBranchReap, remoteBranchNamesSteps, type BranchReapExec } from "../../lib/branch-reaper.js";
import { withMainHealthOnLightPass, type MainRepairLane } from "../../lib/main-health-rung.js";
import { lightPassFixAdmitted, type LightPassScope, type ReviewAdmissionGate, type SweepCycleOutcome } from "../../lib/daemon.js";
import { type BoardSnapshotCache } from "../../lib/board-snapshot-cache.js";
import { type PanelGraphDeps } from "../../lib/panel-graph.js";
import { createPlanFilingFileCache, type GhCallPacer, checkRunsRestArgs, type OpenPrRest, fetchSinglePrRestAsync, paceGhEntry, paceGhEntryAsync, type GhApiFetcher, PLAN_FILING_FILE_CACHE_MAX_ENTRIES } from "../../lib/open-prs-rest.js";
import { configureEscalationTriage, escalate, triageExistingEscalation, type EscalateDeps, ghIssueGateway, ghIssueGatewayAsync, tryEscalate, tryEscalateAsync, type Escalation, type AsyncIssueGateway, type IssueGateway, type OpenIssue, prReferentFromIssueText } from "../../lib/escalate.js";
import { escalatePostReviewStall, escalateCircuitBreak, escalateHeadroomReserve, escalateLifetimeCapExceeded } from "../../lib/escalation-catalogue.js";
import { ghPrDiffAsync } from "../../lib/pr-diff.js";
import { riskJudgePlanContextDigestFor, readRiskPolicy, realRiskJudge, resolveRiskJudgeMount, riskJudgeDiffInputBudget, riskJudgePlanContext, riskJudgePlanContextDigest, riskJudgeSpendCollector, type RiskJudgeChangeView, withoutRiskJudgePatches } from "../../lib/risk-judge.js";
import { fixRebaseMergeFactsFromRest, ghUpdateBranch, readHeadShaRest, disarmAutoMerge } from "../../lib/arm-auto-merge.js";
import { reviewLedgerLegibilityFields, fetchPrLifecycle, postReviewStatusGuarded, missingReviewReuseFact, priorPostedReviewRow, reviewLedgerKeyFor, REVIEW_ENGINE_REVISION, REVIEW_CONTEXT, reviewEvidenceStrength, type ProofExecutor, type ReviewVerdict, acceptanceAuthorTimeCheck, acceptanceBlockRegion, parseAcceptanceBlock, reviewerOutcome, reviewContractDigest, reviewInputDigest, criterionFieldTampered, filingSelfCreditCheck } from "../../lib/review.js";
import { applyMergeProbeEvidence, probeOpenPrMerges } from "../../lib/merge-probe.js";
import { GITHUB_COMPARE_FILES_LISTED } from "../../lib/base-reproduction.js";
import { type ComposedRealGraph, type ReviewWorktreeDeps } from "../../lib/composition-root.js";
import { type EscalationAnswerGateway, readEscalationAnswers } from "../../lib/escalation-answers.js";
import { buildBehindMainByPr, buildCreditCandidates, buildOpenPrViewsAsync, buildStaleGateWorkflowsByPr, distanceRefreshProbeTargets, fetchCiFailuresAsync, type TickReadFacts, type ClassifiedOpenPrView, type EscalationIntake, type PlanFilingClassificationEvent, type PlanFilingClassificationSource, type RollupCheck, attachPostedGateIds, buildEscalationReconcileCandidates, fetchCiFailures, openPrViewSteps, openPrsWithPostedIdsSteps } from "../../lib/tick-read-worker.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects as buildSweepEffectsFromLib, dispatchFixCatchOutcome, fixRungTaskFor, discriminateReviewReuseAsync, projectMergedTaskCandidates, runSweep, runSweepLightPass, runCreditBackfill, renderSweepSummary, planOnlyRunBranchReceipts, withFullSweepRepairAdmission, createEscalationTriageHistoryReader, ESCALATION_TRIAGE_EVIDENCE_SLICE, createFullPreludeTimer, LightPassPreReviewTiming, observeLightPassReviewEligibility, runLightPassReadyRefresh, runLightPassRefreshAdmission, lightPassHeadContractRefresh, runArmedRatchetRejudge, isReviewLaneDisposition, deriveDisposition, type BuildSweepEffectsDeps, type SweepDeps, type OpenPrView, type ReviewDispatchMode, type ReviewReuseInputs, type BaseChangedFiles, type Disposition, readyDraftPullRequest, fixDispatchBudget, isBlockedCi, listRetirableEscalationIssues, listRetirableEscalationIssuesAsync, indexEscalationTriageHistory, type EscalationTriageHistoryReader, type SweepSummary, closedPrFromRef, closedPrLookup, runPrTerminalReconcile, type PrTerminalReconcileSummary, runEscalationReconcile, runStaleEscalationRejudge, buildStaleEscalationRejudgePrompt, type StaleEscalationRejudgeCandidate, runPostFixReverification, terminalStateReason, usableInstrumentEntanglementPaths, type CiFailure, type EscalationReconcileSummary, type FixClass, type FixDispatchEvidence, type FixOwnerResidue, type LiveStateResult, type PlanScopedFixRoundInput, type PostFixReverificationSummary, type ProofDiscriminationEvidence, type RepairFilingCapture, DEFAULT_FIX_CLASSES, fixHeadAcceptable, sweepArmTaskId, riskJudgeHandedOffHead, handedOffHeadJudgmentPool, type HandedOffHeadJudgmentPool, awaitHandedOffHeadJudgments, riskJudgeCodeScanning, reviewOnlyStandDownReason } from "../../lib/sweep.js";
import { resolveReviewProviderProvenance, reviewProviderProvenanceLedgerFields } from "../../lib/review-provider-provenance.js";
import { reviewCommand as reviewCommandFromModule, runReview as runReviewFromModule, type ReviewCommandDeps, type ReviewCommandHost, reviewerFreshnessForPublication as reviewerFreshnessForPublicationFromModule, ownStartFreshness as ownStartFreshnessFromModule, type MaterializeReviewWorktreeResult } from "./review.js";
import { runFixRung as runFixRungFromModule, type FixCommandHost, fixCommandHelpers } from "./fix.js";
import { type RunTaskCommandHost, type LiveHeadResult, type WorktreeSnapshot } from "./run-task-verb.js";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isHolderStale, readFileIfExists } from "../../lib/fs-race-safe.js";
import { isPromiseLike, runStepsEager } from "../../lib/gardener.js";
import { buildWorkerEnv, billingMode } from "../../lib/env.js";
import { FIX_MODE_RULES, renderFixPrompt } from "../../lib/prompt-render.js";
import { type Tier } from "../../lib/tier.js";
import { spawnReconSpecialist } from "../../lib/onboard/recon.js";
import { withReviewerWorktreeLease } from "../../lib/reviewer-worktree-lease.js";
import { REVIEWER_INCIDENT_FLAG, REVIEWER_SHADOW_FLAG, buildHealedReviewerTree, evaluateReviewerHealth, gitIn, readReviewerHealthRows, reviewerHealthStatePath, reviewerRegressionEscalation, type ReviewerIncident } from "../../lib/reviewer-health.js";
import { sweepStaleTempDirs } from "../../lib/tmp.js";
import { resolveInstallRoot } from "../../lib/install-root.js";
import { captureFeedback, feedbackCaptured, listFeedback, stageFeedbackCapture, type FeedbackEntry, type FeedbackOrigin } from "../../lib/feedback.js";
import { checkCommitMessage } from "../../lib/commit-message.js";
import { isInPlanScope } from "../../lib/plan-architect.js";
import { updateProposalRegistry, type Proposal } from "../../lib/inbox.js";
import { readFeedbackDocketMarker, writeFeedbackDocketMarker } from "../../lib/feedback-docket.js";
import { planPrPreflight, type PlanPrPreflightResult, filingAcceptanceCriteria, renderAcceptanceBlock, replaceAcceptanceBlock, planPrPreflightAtCommitAsync } from "../../lib/plan-pr-emitter.js";
import { feedbackLineagePayload, feedbackLineageSnapshot, observeFeedbackInputs } from "../../lib/contributor-admission.js";
import { envelope as feedbackLineageEnvelope } from "../../lib/untrusted-envelope.js";
import { benchmarkNonDispatchSpawn } from "../../lib/benchmark-run.js";
import { loadMounts, mountsPath, type Mount } from "../../lib/mounts.js";
import { mountRecommendationProposalCandidate, recommendMounts, type MountHeadroomCell } from "../../lib/mount-recommender.js";
import { loadDefaultPolicy, policyPath } from "../../lib/policy.js";
import { citation } from "../../lib/provenance.js";
import { diagnoseBodyDefects } from "../../lib/body-repair.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "../../lib/worktree-git.js";
import { gitPushRunBranch, gitPushEmptyCommit, runStepsSync, step, type Steps } from "../../lib/git-push.js";
import { defaultIsPidAlive } from "../../lib/drain-lock.js";
import { parseInflightLockInfo } from "../../lib/inflight-lock.js";
import { assertLiveWriteAllowed } from "../../lib/live-write-guard.js";

type HostFn = (...args: any[]) => any;
export interface SweepCommandHost {
  readonly freshTreeGit: (args: string[]) => string;
  readonly USAGE: string;
  readonly DEFAULT_BUDGET_USD: number;
  readonly buildFreshTreeReviewRunner: (repoDir: string, deps: FreshTreeReviewSeams) => (
    prArg: string, rest: string[], freshness: { originMainSha: string },
    onFailure?: (failure: string) => void,
  ) => Promise<number | undefined>;
  realDeps(): ComposedRealGraph;
  reviewCommandHost(): ReviewCommandHost;
  fixCommandHost(): FixCommandHost;
  readonly materializeReviewWorktree: ReviewCommandHost["materializeReviewWorktree"];
  readonly reviewPostedDescription: ReviewCommandHost["reviewPostedDescription"];
  readonly buildBaseReproductionProbe: RunTaskCommandHost["buildBaseReproductionProbe"];
  readonly buildImportClosureRead: HostFn;
  readonly updateBranchViaGh: HostFn;
  readonly reclaimAbandonedWorker: HostFn;
  readonly publishAbandonedFixOwnerAhead: HostFn;
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
  readonly repairPrMetadata: HostFn;
  readonly ghLiveHead: HostFn;
  readonly fetchPrDiffFilesViaGh: HostFn;
  readonly redBaseRefreshFactsFromRest: HostFn;
  readonly readFixRoundCommitsViaGit: HostFn;
  readonly runNpmScriptViaSpawn: HostFn;
  readonly commitGeneratorOutputViaGit: HostFn;
  readonly readPackageScriptsFor: HostFn;
  readonly buildEscalationTriageRuntime: HostFn;
  readonly buildInboxDraftHook: HostFn;
  readonly runTmpSweepRung: HostFn;
  readonly runWorkerTailSweepRung: HostFn;
  readonly runInflightLockSweepRung: HostFn;
  readonly GIT_UNTRACKED_FILES_ALL: string;
  readonly prepareWorktreeToolchain: HostFn;
  readonly prepareFreshOriginMainTree: HostFn;
  readonly freshTreeFailureText: HostFn;
  readonly acceptedReviewAttemptId: HostFn;
  readonly JUDGE_AT_OWN_START_FLAG: string;
  readonly WORKER_STATE_LEDGER_STEP: string;
  readonly WORKER_TAIL_MAX_BYTES: number;
  readonly WORKER_TAIL_MAX_LINES: number;
  readonly capWorkerTailLines: HostFn;
  readonly writeWorkerTailBestEffort: HostFn;
  readonly changeView: HostFn;
  readonly changeViewArgs: HostFn;
  readonly changeViewFromRows: HostFn;
  readonly acceptanceGateBodyRepair: HostFn;
  readonly execGrepProofInWorktree: HostFn;
  readonly ciEvidenceDisagreementObservation: HostFn;
  readonly ghLiveStateByNumber: HostFn;
  readonly withGitCredentialSocket: HostFn;
  readonly cleanupMaterializedWorktree: HostFn;
  readonly prUrlTarget: HostFn;
  readonly branchReapExec: HostFn;
  readonly reapBranchesSteps: (rest: string[], opts: Record<string, unknown> & {
    onExitReason?: (reason: string) => void;
    onMergedHeadCacheUpdate?: (next: Readonly<Record<string, string>>) => void;
    onNoPrHeadCacheUpdate?: (next: Readonly<Record<string, string>>) => void;
  }) => Steps<number>;
  readonly hostWorktreeGitResult: HostFn;
  readonly ZERO_GIT_OID: string;
  readonly temporaryIndexTree: (repoDir: string, baseSha: string,
    mutate: (env: NodeJS.ProcessEnv) => void, seedIndexPath?: string) => string;
  readonly nulPaths: (raw: string) => string[];
  readonly readTrackedDirtyOwnerPatch: HostFn;
  readonly preserveTrackedDirtyPatch: HostFn;
  readonly workerChangedPaths: (raw: string) => string[];
  readonly FIX_BRANCH_CLAIM_PREFIX: string;
  readonly AWAITING_EXTERNAL_LEDGER_STEP: string;
  readonly namesATask: HostFn;
  readonly mainRepairLaneFor: HostFn;
  readonly types?: {
    FreshTreeReviewSeams: {
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
    ProcessCwdCensus: | { state: "clear"; scanned: number }
  | { state: "occupied"; scanned: number; pid: number }
  | { state: "unknown"; scanned: number; reason: "proc_unavailable" | "cwd_unreadable" | "entry_bound" | "wall_bound" };
    CaptureRegisteredFixOwnerDeps: {
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
  };
}
type FreshTreeReviewSeams = NonNullable<SweepCommandHost["types"]>["FreshTreeReviewSeams"];
type ProcessCwdCensus = NonNullable<SweepCommandHost["types"]>["ProcessCwdCensus"];
type CaptureRegisteredFixOwnerDeps = NonNullable<SweepCommandHost["types"]>["CaptureRegisteredFixOwnerDeps"];

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

export interface FixHeadRecovery {
  branch: string;
  localSha: string;
  originSha: string;
  recoveryRef: string;
}

export interface CheckoutFixHeadRefDeps {
  /** Test seam at the exact compare-and-swap boundary; production never supplies it. */
  beforeHeadCompareAndSwap?: () => void;
}

export type RegisteredFixOwnerSignal = "managed" | "foreign" | "unknown";

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

export interface ProcessCwdCensusDeps {
  readNextPid?: () => string | null;
  readCwd?: (pid: string) => string;
  now?: () => number;
  maxEntries?: number;
  wallMs?: number;
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

/** One live in-flight run whose newest `worker.state` row has aged past the policy `workerStall`
 *  threshold, per {@link findStalledWorkers}. */
export interface WorkerStallCandidate {
  runId: string;
  taskId: string;
  /** ms of quiet since this run's newest `worker.state` transition. */
  quietMs: number;
  /** the run's newest recorded `worker.state` value, when one exists. */
  lastState: string | undefined;
}

export interface LightPassReadPorts {
  openPrViews?: () => Promise<OpenPrView[]>;
  effects?: (deps: Parameters<ReturnType<typeof sweepCommandHelpers>["buildSweepEffects"]>[0]) => SweepDeps;
  readCompare?: (args: string[]) => Promise<unknown>;
  clock?: Pick<Clock, "now">;
}

/** How much of a running child's stderr is held in memory to take that tail from. */
export const FRESH_TREE_STDERR_HOLD_CHARS = 64 * 1024;

/**
 * W1-T2609/W1-T2839: thrown when a fix-head move cannot prove it is safe. W1-T2839 preserves an
 * unheld ahead/diverged tip before moving it; a held branch or failed compare-and-swap still
 * refuses. Both shas are carried so the caller's decline row is diagnosable without another read.
 */
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

/** Names of daemon-created worktrees that may enter the already fail-closed registered-owner recovery.
 * A `run-` tree is the task's original implementation worktree; a `sweep-` tree is a later fix
 * rung. Both remain constrained to the configured root, exact task id, numeric epoch, branch,
 * cleanliness, remote identity, ancestry, claim, and process-cwd checks below. */
export const managedFixOwnerWorktreePrefixes = ["sweep", "run"] as const;

export const FIX_OWNER_PROC_ENTRY_BOUND = 4_096;

export const FIX_OWNER_PROC_WALL_MS = 100;

export const FIX_OWNER_RESIDUE_PATH_BOUND = 20;

export const FIX_OWNER_OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const;

/**
 * A suppressed repair filing has no file to satisfy the normal same-window `existsSync` guard.
 * Keep the telemetry level-triggered without writing the same row on every daemon poll: one row
 * per process for each `(root, window id, rejecting verdict, evidence count)`. A daemon restart
 * logs the still-active suppression once again, and genuinely new evidence logs a fresh row.
 */
export const repairFilingSuppressionsLogged = new Set<string>();

export const MOUNT_RECOMMENDER_CADENCE_POLICY = {
  kind: "daily-ledger-evidence-accrual",
  intervalMs: 24 * 60 * 60 * 1000,
} as const;

export const automaticBranchReapsInFlight = new Set<string>();

// ── WORKER STALL DETECTOR (W1-T943) ─────────────────────────────────────────────────────────
//
// W1-T942 produces `worker.state`; nothing judged it until now — the exact shape W1-T316/
// W1-T317/W1-T916 already paid for (a signal with no reader). LEVEL-TRIGGERED (design note i):
// reads the AGE of the newest `worker.state` row for each LIVE in-flight run (`liveInflightRuns`'s
// own pid-checked lock read — never a second, looser "in flight"), never an event the run itself
// must emit — a wedged, swapped, or dead-socket worker may never emit anything again, so a
// detector waiting for it to announce its own stall cannot fire in exactly the case it exists for.

/** Ledger step a worker-stall verdict rides — appended ONCE per quiet episode (design ii), never
 *  once per tick. */
export const WORKER_STALLED_LEDGER_STEP = "worker.stalled";

/** DEFAULT quiet threshold, mirrored from `plan/policy.yaml`'s `workerStall` row for a caller
 *  with no policy in hand (test fixtures, primarily) — production always threads the real
 *  `policy.values.workerStall` through {@link buildSweepHook} instead of relying on this. See
 *  that row's own comment for why 60 minutes is the default (design note v: comfortably above
 *  the ~16-minute `--ci-parity` suite W1-T463/W1-T465 measured). */
export const DEFAULT_WORKER_STALL_MS = 3_600_000;

/** Bound the worker-stall escalation's tail excerpt is capped to AT THE ATTACH SITE (design
 *  note iii: "a 2 MB issue body is its own outage") — deliberately TIGHTER than the tail FILE's
 *  own {@link WORKER_TAIL_MAX_LINES}/{@link WORKER_TAIL_MAX_BYTES} ceiling: an issue body is read
 *  by a human deciding "wedged or just busy", not grepped, and a shorter excerpt is already
 *  enough evidence for that judgment. */
export const WORKER_STALL_TAIL_ATTACH_MAX_LINES = 100;

export const WORKER_STALL_TAIL_ATTACH_MAX_BYTES = 8 * 1024;

export function sweepCommandHelpers(host: SweepCommandHost) {
  const { freshTreeGit, USAGE, DEFAULT_BUDGET_USD, buildFreshTreeReviewRunner, realDeps, reviewCommandHost, fixCommandHost, materializeReviewWorktree, reviewPostedDescription, buildBaseReproductionProbe, buildImportClosureRead, updateBranchViaGh, reclaimAbandonedWorker, publishAbandonedFixOwnerAhead, depReviewCommand, ghLiveState, resolveFixRungTaskContractAtHeadAsync, captureWorktreeSnapshotViaGit, writeFixCensusSnapshotAsync, pushSweepFixRound, openTaskIdsFromPlan, waitForCiGreen, restRollupFor, fetchPrBodyViaGh, updatePrBodyViaGh, repairPrMetadata, ghLiveHead, fetchPrDiffFilesViaGh, redBaseRefreshFactsFromRest, readFixRoundCommitsViaGit, runNpmScriptViaSpawn, commitGeneratorOutputViaGit, readPackageScriptsFor, buildEscalationTriageRuntime, buildInboxDraftHook, runTmpSweepRung, runWorkerTailSweepRung, runInflightLockSweepRung, GIT_UNTRACKED_FILES_ALL, prepareWorktreeToolchain, prepareFreshOriginMainTree, freshTreeFailureText, acceptedReviewAttemptId, JUDGE_AT_OWN_START_FLAG, WORKER_STATE_LEDGER_STEP, WORKER_TAIL_MAX_BYTES, WORKER_TAIL_MAX_LINES, capWorkerTailLines, writeWorkerTailBestEffort, changeView, changeViewArgs, changeViewFromRows, acceptanceGateBodyRepair, execGrepProofInWorktree, ciEvidenceDisagreementObservation, ghLiveStateByNumber, withGitCredentialSocket, cleanupMaterializedWorktree, prUrlTarget, branchReapExec, reapBranchesSteps, hostWorktreeGitResult, ZERO_GIT_OID, temporaryIndexTree, nulPaths, readTrackedDirtyOwnerPatch, preserveTrackedDirtyPatch, workerChangedPaths, FIX_BRANCH_CLAIM_PREFIX, AWAITING_EXTERNAL_LEDGER_STEP, namesATask, mainRepairLaneFor } = host;
  const runReview = (args: Parameters<typeof runReviewFromModule>[1]) => runReviewFromModule(host.reviewCommandHost(), args);
  const runFixRung = (opts: Parameters<typeof runFixRungFromModule>[0]) => runFixRungFromModule(opts, host.fixCommandHost());

function spawnRmdReviewForFreshTree(
  worktree: string,
  args: string[],
  onFailure?: (failure: string) => void,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
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

function reviewOptionFlags(opts: Pick<ReviewCommandDeps, "planOnlyFiling" | "executionMode" | "reviewAttemptId">): string[] {
  const attemptId = acceptedReviewAttemptId(opts.reviewAttemptId);
  return [
    ...(opts.planOnlyFiling === undefined ? [] : [opts.planOnlyFiling ? "--plan-only-filing" : "--not-plan-only-filing"]),
    ...(opts.executionMode === undefined ? [] : ["--execution-mode", opts.executionMode]),
    ...(attemptId === undefined ? [] : ["--review-attempt-id", attemptId]),
  ];
}

function reviewerFreshnessForPublication(
  atStart: ReviewerCodeFreshness | undefined,
  justInTime: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness> {
  return reviewerFreshnessForPublicationFromModule(atStart, justInTime);
}

async function ownStartFreshness(
  read: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): Promise<ReviewerCodeFreshness> {
  return ownStartFreshnessFromModule(read);
}

function buildReviewerCodeFreshnessGate(
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

/** W1-T10269 — the escalation's issue gateway, assigning each issue it files to the repo owner
 *  (escalation by assignment: Remudero Issues are the alert channel). */
function assigningIssueGateway(owner: string, repo: string, log: (step: string, extra?: Record<string, unknown>) => void,
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

/** W1-T10269 — the red-main repair lane for a reviewer regression's revert PR, with the PR read and
 *  close over REST that the main-health rung uses when its lane names none. */
function reviewerRevertLane(owner: string, repo: string, config: Config, ledgerPath: string, runId: string): MainRepairLane {
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

/**
 * W1-T10269 — A REVIEWER REGRESSION HEALS ITSELF: every daemon review asks reviewer health first
 * (src/lib/reviewer-health.ts). With no open incident the review runs exactly as before. With one,
 * it runs from a HEALED tree — origin/main with the offending merge reverted on top, rebuilt whenever
 * origin/main moves, so W1-T228 reads it fresh — never from an old head or an engine tree; while
 * today's reviewer has no judgment yet it also runs in shadow, publishing nothing. A healed tree that
 * cannot be built escalates and the review falls back to today's path, unchanged.
 * Injection reuses the review path's own {@link FreshTreeReviewSeams} (the same object the stale-code
 * fresh-tree runner takes), the escalation's issue gateway and the red-main repair lane.
 */
function buildReviewerHealthRoute(
  repoDir: string,
  config: Config,
  ledgerPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  tree: FreshTreeReviewSeams,
  issues?: AsyncIssueGateway,
  lane?: MainRepairLane,
): (prArg: string, rest: string[], reviewDeps: ReviewCommandDeps, normal: () => Promise<number>) => Promise<number> {
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

/** W1-T4415 — the sweep's draft-readying effect: `gh pr ready` on one draft, ledgered by
 *  {@link readyDraftPullRequest}. Marking ready is the whole write; it never merges or closes. */
function readyDraftViaGh(
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

function buildRequiredFixReviewRunner(
  next: typeof runReview,
  readFreshness: () => ReviewerCodeFreshness | Promise<ReviewerCodeFreshness>,
): typeof runReview {
  return async (args) => {
    const startFreshness = await ownStartFreshness(readFreshness);
    return next({ ...args, requireSemanticReview: true,
      reviewerCodeFreshness: reviewerFreshnessForPublication(startFreshness, readFreshness) });
  };
}

function buildSweepEffects(
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
    reviewerHealthRouteImpl?: ReturnType<typeof buildReviewerHealthRoute>;
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
 * W1-T5633 — the sweep's code-scanning judge and its PR comment, wired beside
 * {@link handedOffHeadRiskJudge} at every sweep entrypoint. The judge is the SAME mount, policy and
 * spend collector, shown the alerts and the PR's own diff hunks (REST `patch`, bounded); its
 * escalation is a no-op, because an escalating judge here means "fix it", never "ask a person".
 */
function codeScanningJudgeDeps(
  owner: string,
  repo: string,
  config: Config,
  plan: Plan,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  spawn?: typeof spawnWorker,
  fetchFiles: (args: string[]) => Promise<unknown> = ghJsonAsync,
): Pick<SweepDeps, "judgeCodeScanningAlerts" | "postCodeScanningRuling"> {
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

/**
 * W1-T5403 — the sweep's risk judge for a head whose run ended `handed_off`: the SAME judge mount,
 * live risk policy, spend collector and BLOCKED escalation the in-run call in runTaskBody uses, with
 * the change view read at judgment time over the async transport (W1-T5523: off the sweep pass). A
 * settings or change-view failure surfaces as an unavailable judge through `assessRisk`, never as a
 * proceed. Wired by both sweep entrypoints.
 */
function handedOffHeadRiskJudge(
  owner: string,
  repo: string,
  config: Config,
  plan: Plan,
  ledgerPath: string,
  runId: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
  spawn?: typeof spawnWorker,
  escalateImpl: typeof escalate = escalate,
  readChangeView: (prUrl: string) => RiskJudgeChangeView | Promise<RiskJudgeChangeView> = changeViewAsync,
): NonNullable<SweepDeps["judgeHandedOffHead"]> {
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

/**
 * W1-T9406: a pass driver's refresh of the triage evidence slice, loading its new rotations off the loop before the
 * pass triages anything. A failed refresh is contained and logged: the evidence then reads what it lacks inline, as
 * the union would, or refuses when the slice is unreadable.
 */
async function refreshEscalationTriageEvidence(
  runtime: Pick<ReturnType<typeof buildEscalationTriageRuntime>, "refresh">,
  ledgerPath: string,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await runtime.refresh(ledgerPath);
  } catch (e) {
    log("escalation_triage.evidence_refresh_failed", { error: String((e as Error)?.message ?? e) });
  }
}

/** W1-T5523 — {@link changeView} over the async gh transport, for the sweep's background judgment. */
async function changeViewAsync(
  prUrl: string,
  fetch: (args: string[]) => Promise<unknown> = ghJsonAsync,
): Promise<RiskJudgeChangeView> {
  return changeViewFromRows(await fetch(changeViewArgs(prUrl)));
}

/** W1-T5543: preserve the prior head's criterion surface, including block scalar continuations. */
function untouchedPlanCriterion(roundDiff: string, priorDiff: string, path: string): boolean {
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

/** W1-T9289: one git call whose non-zero exit is a RESULT (`status`), never an erasure. */
function gitStatusResult(git: (args: string[]) => string, args: string[]): { status: number | null; out: string; error?: string } {
  try {
    return { status: 0, out: git(args) };
  } catch (error) {
    const failed = error as { status?: unknown; stdout?: unknown; message?: unknown };
    return { status: typeof failed.status === "number" ? failed.status : null, out: String(failed.stdout ?? ""),
      error: String(failed.message ?? error) };
  }
}

/**
 * W1-T9289 — THE CONFLICT MODE OF THE PLAN-SCOPED ROUND. A dirty fleet plan PR gets origin/main MERGED into its head
 * (a merge commit, never a rebase or a force push). Main's side is the newer fleet decision and is kept; the worker
 * re-applies the branch's change only where it still applies to the merged task and edits ONLY the conflicted plan
 * paths. The pushed merge commit must preflight clean, so a head that fails `planPrPreflight` is never pushed.
 */
async function runPlanScopedConflictRound(input: PlanScopedFixRoundInput): Promise<{ outcome: "pushed" | "refused" | "metadata-repaired"; headSha?: string; reason?: string; preflight?: PlanPrPreflightResult }> {
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

async function runPlanScopedFixRound(input: PlanScopedFixRoundInput): Promise<{ outcome: "pushed" | "refused" | "metadata-repaired"; headSha?: string; reason?: string; preflight?: PlanPrPreflightResult }> {
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

function fetchOpenPrsWithPostedIds(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  return runStepsSync(openPrsWithPostedIdsSteps(owner, repo, fetch));
}

function branchAuthorshipStandDownReason(
  rungOwnHeadSha: string | undefined,
  liveHead: LiveHeadResult,
): { reason: string; headSha: string; author: string } | undefined {
  return fixCommandHelpers(fixCommandHost()).branchAuthorshipStandDownReason(rungOwnHeadSha, liveHead);
}

/**
 * W1-T1284 (the fix-rung pre-strike gate's fourth reason source, composed into
 * {@link fixRungStandDownReason} below — never a parallel early return): is the worktree, right
 * now, byte-identical to the snapshot recorded the last time THIS SAME gate was about to be
 * spent against?
 *
 * THE DEFECT THIS CLOSES: the pre-strike gate already re-reads WHO moved the head
 * (`branchAuthorshipStandDownReason`) and WHETHER the PR went terminal, both fresh every round —
 * but a live head EQUAL to the rung's own last-pushed head reads as "fine, not foreign" (correctly,
 * for THAT check's own purpose), so a strike whose worker pushed nothing at all left no signal
 * anywhere that the next strike was about to run against a tree its own last strike never touched.
 * This is that missing signal — read from the WORKTREE directly, never proxied through the PR's
 * remote head sha, because `deps.push` is best-effort (a push that silently fails leaves real local
 * progress with no remote trace) and an untracked file a worker adds never reaches the remote at
 * all until it is committed.
 *
 * KEYED PER GATE (`gateKey` — see `runFixRung`'s own call site for its derivation: the sorted
 * failing check names in ci-log mode, the sorted unmet-criterion claims in review mode, or the
 * sorted conflicting-file list in merge-conflict mode) so a rung that fixed check A and moved on to
 * a newly-red check B is never told "nothing changed" even on an unchanged sha (Q2's own
 * falsifier — this is also why a base that moves under the branch, changing WHICH check is red,
 * never trips this check: the gate key itself moves).
 *
 * `previousFailure` is `undefined` on the rung's first round (nothing recorded yet — exactly
 * {@link branchAuthorshipStandDownReason}'s own "first round has no prior head" contract) and
 * whenever the prior round's own snapshot capture was unreadable.
 *
 * PURE and exported so the boundary is unit-testable independent of the rung's git plumbing.
 */
function unchangedTreeStandDownReason(
  gateKey: string,
  previousFailure: { gateKey: string; snapshot: WorktreeSnapshot } | undefined,
  currentSnapshot: WorktreeSnapshot | undefined,
): { reason: string } | undefined {
  return fixCommandHelpers(fixCommandHost()).unchangedTreeStandDownReason(gateKey, previousFailure, currentSnapshot);
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
async function dispatchFixPreflightStandDown(
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

/** W1-T5544: gate-log evidence carries the stale PROOF only (the job log prints no claim). Resolve each proof's real claim
 *  from the task's plan criteria so a `PROOF_AMENDMENT` can name it byte-for-byte. Non-gate-log evidence is returned
 *  as-is (same object), and an unmatched proof keeps its stand-in claim. */
function withPlanClaims(
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

/** W1-T5115: the sweep fix rung's spawn — sweep.ts's own `benchmarkNonDispatchSpawn("sweep-fix")` default — with the
 *  daemon's git credential socket on every fix worker it starts. */
function gitCredentialFixSpawn(
  socketPath: string,
  raw: typeof spawnWorker = spawnWorker,
  harnessCheckout: string = repoRoot,
): typeof spawnWorker {
  const spawnFix = benchmarkNonDispatchSpawn("sweep-fix", raw);
  return (args) => spawnFix(withGitCredentialSocket(args, socketPath, harnessCheckout));
}

function materializePlanRoundWorktree(config: Config, repoDir: string, prNumber: number, headSha: string,
  deps: Pick<ReviewCommandDeps, "materialize"> & { prepare?: FreshTreeReviewSeams["prepareWorktree"] } = {},
): MaterializeReviewWorktreeResult {
  const result = (deps.materialize ?? materializeReviewWorktree)(config, repoDir, prNumber, headSha);
  if (result.worktreePath && !(deps.prepare ?? prepareWorktreeToolchain)(repoDir, result.worktreePath)) {
    cleanupMaterializedWorktree(worktreeRemove, repoDir, result.worktreePath);
    return { worktreePath: undefined, failure: { errorClass: "other", message: "plan round toolchain unavailable" } };
  }
  return result;
}

/**
 * Pure builder, mirroring `buildEscalationReconcileCandidates`'s own "read the ledger, hand back
 * candidates" shape: one {@link HeadroomRecoveryCandidate} per still-OPEN headroom-reserve
 * escalation (`openIssueUrls`, the caller's own live `listOpen` read — never re-read here) whose
 * `daemon.headroom_reserve.escalated` row names a `window` that has SINCE recovered. An escalated
 * row missing `window`/`resets_at` (every row written before this task) or whose `issue_url` is not
 * in `openIssueUrls` (never delivered, or already closed) yields no candidate.
 */
function buildHeadroomRecoveryCandidates(
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
function renderHeadroomRecoveryCloseComment(c: HeadroomRecoveryCandidate): string {
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
async function retireRecoveredHeadroomEscalations(
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

function sweepPrTerminalRung(github: Pick<GitHub, "prByRef">, ledgerPath: string, runId: string, // W1-T5318
  tickRead?: Pick<TickReadFacts, "closedPrs">): PrTerminalReconcileSummary {
  const lookup = tickRead?.closedPrs ? closedPrLookup(tickRead.closedPrs) : (url: string) => closedPrFromRef(github.prByRef(url));
  return runPrTerminalReconcile(lookup, { ledgerPath, runId });
}

/** W1-T4075: the post-fix re-verification rung's two reads, answered from one tick-read generation. */
function tickReadReverificationDeps(tickRead: Pick<TickReadFacts, "mergedFixPrNumbers" | "postFixCiFailuresByPr">): {
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
function updatedForWorkflowFromLedger(ledgerPath: string): Set<string> {
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
function createPlanFilingClassificationTelemetry(
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
function buildOpenPrViews(owner: string, repo: string, ledgerPath: string, deps: NonNullable<Parameters<typeof openPrViewSteps>[3]> = {}): ClassifiedOpenPrView[] {
  const fetch = deps.fetch ?? ghJson;
  return runStepsSync(openPrViewSteps(owner, repo, ledgerPath, deps, {
    read: fetch,
    openPrRows: () => paceGhEntry(deps.pacer, isGhRateLimitError, () => fetchOpenPrsWithPostedIds(owner, repo, fetch)),
    ciFailures: deps.fetchCiFailureEvidence ?? fetchCiFailures,
    requiredContexts: readRequiredStatusCheckContexts,
  }));
}

function buildRereadPrAtAct(
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
 * Pure arg-builder for a cold-PR `dispatchFix` reconstruction (W1-T100/W1-T106):
 * derives the SAME `runFixRung` options (everything but `deps`, whose adapters
 * close over dispatchFix's own git/gh/worker-spawn side effects) that
 * `buildSweepEffects.dispatchFix` used to build inline. Extracted so the
 * mode-classification and initial-verdict reconstruction — evidence.mergeConflict
 * takes precedence over evidence.ciFailures over an ordinary reviewer-unmet seed,
 * mirroring FIX_MODE_RULES' own ordering — is unit-testable directly, without the
 * worktree/spawn boundary around dispatchFix itself (the codebase's established
 * "the arg-builder carries the testable read-only contract; the spawn wrapper is
 * untested by design" split — see spawnSpecialistWorker/spawnReconSpecialist).
 */
function feedbackFixConstraint(answer: { constraint: string; contributions?: readonly unknown[] } | undefined): string | undefined {
  return answer?.contributions?.length
    ? feedbackLineageEnvelope(feedbackLineagePayload(answer.constraint, answer.contributions), "feedback-entry")
    : answer?.constraint;
}

function buildFixRungDispatchArgs(args: {
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

/**
 * Return the registered worktree path that owns one exact full branch ref. Git's porcelain
 * format keeps the path and branch on separate lines within one blank-line-delimited record;
 * parsing records avoids both substring branch matches and detached-worktree false positives.
 */
function registeredFixWorktreeOwner(repoDir: string, branchRef: string): string | undefined {
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

function fixHeadHeldByWorktree(repoDir: string, branchRef: string): boolean {
  return registeredFixWorktreeOwner(repoDir, branchRef) != null;
}

function boundedWorktreeOwnerPath(value: string): string {
  return value.replace(/[\r\n\0]/g, "?").slice(0, 512);
}

function isManagedFixOwnerWorktreeName(name: string, taskId: string): boolean {
  return managedFixOwnerWorktreePrefixes.some((prefix) => {
    const expected = `${prefix}-${taskId}-`;
    return name.startsWith(expected) && /^\d+$/.test(name.slice(expected.length));
  });
}

function decideRegisteredFixOwnerRecovery(
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

function pathIsAtOrBelow(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readBoundedProcessCwdCensus(
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

function readRegisteredFixOwnerClaim(
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

function captureRegisteredFixOwnerSnapshot(
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

/** W1-T6355: tracked modifications, staged paths or an interrupted merge/cherry-pick/revert. */
function readOwnerHasTrackedWork(ownerPath: string): boolean {
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

function removeAbandonedFixWorktreeOwner(repoDir: string, worktreePath: string): void {
  // No --force: a dirty owner is refused. The fix clone is pinned through the hardened leaf.
  hostWorktreeGit(repoDir, ["worktree", "remove", worktreePath]);
  removeRunLock(worktreePath);
  removeWorktreeBase(worktreePath);
}

/** W1-T5918: the production seam. An empty HEAD-relative diff returns the index/operation residue
 *  (to be recorded, then reset) instead of throwing; a real diff is preserved exactly as before. */
function preserveOrDiscardFixOwnerResidue(
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string | FixOwnerResidue {
  const patch = readTrackedDirtyOwnerPatch(ownerPath, localSha);
  if (patch.length === 0) return readFixOwnerResidue(ownerPath, localSha);
  return preserveTrackedDirtyPatch(repoDir, ownerPath, branch, localSha, patch, deps);
}

/** W1-T5974: a staged-only residue on a head the PR has moved past, preserved from the owner's
 *  INDEX (`git diff --cached --binary <localSha>`) into the same immutable recovery-ref shape, the
 *  ref's tree proven equal to the owner's own index tree before the caller resets anything. */
function preserveStagedFixOwnerResidue(
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string {
  readTrackedDirtyOwnerPatch(ownerPath, localSha); // the HEAD and no-untracked guards; its diff is the working tree's
  const gitOut = (args: string[]) => hostWorktreeGit(ownerPath, args, { maxBuffer: 1 << 26 });
  const patch = gitOut(["diff", "--cached", "--binary", "--no-ext-diff", localSha]);
  const ownerIndex = resolve(ownerPath, gitOut(["rev-parse", "--git-path", "index"]).trim());
  return preserveTrackedDirtyPatch(repoDir, ownerPath, branch, localSha, patch, deps, () =>
    temporaryIndexTree(ownerPath, localSha, () => {}, ownerIndex),
  );
}

function readFixOwnerResidue(ownerPath: string, localSha: string): FixOwnerResidue {
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

// W1-T3822 — the tracked-only diff is durably captured by `preserveTrackedDirtyFixOwner` above,
// but capture alone does not make the owner reclaimable: `removeAbandonedFixWorktreeOwner` runs a
// plain `git worktree remove` with no `--force` (by design — a forced removal is exactly the data
// loss this whole recovery arm exists to avoid), and plain `git worktree remove` REFUSES a
// worktree carrying modified or untracked files. Left uncalled, the owner would stay dirty after
// preservation and `remove` would fail closed on the exact same worktree every poll -- the
// tracked-only sibling of the `dirty_worktree` stand-down this task exists to repair, just
// surfacing under `owner_remove_failed` instead of `dirty_worktree`. This resets the owner's
// tracked state to its OWN already-preserved HEAD, never anywhere else, and only after the caller
// has confirmed the recovery ref reproduces that exact tree.
function resetTrackedDirtyFixOwner(ownerPath: string, localSha: string): void {
  hostWorktreeGit(ownerPath, ["reset", "--hard", localSha]);
}

/** W1-T6355: an ended run's UNTRACKED-ONLY owner. The untracked paths are recorded into the same
 *  immutable, tree-verified recovery ref as tracked residue (patch built from a temporary index, so
 *  the owner's own index is never touched), and only then cleared -- `git clean -fd`, never `-x`
 *  or a forced worktree removal -- so the plain `git worktree remove` that follows can succeed. */
function preserveAndClearUntrackedFixOwner(
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string {
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

/** W1-T7719: keep index, worktree and untracked patches outside the worktree janitors' roots. */
function preserveStaleDirtyFixOwner(
  root: string,
  repoDir: string,
  ownerPath: string,
  branch: string,
  localSha: string,
  deps: CaptureRegisteredFixOwnerDeps = {},
): string {
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

function clearStaleDirtyFixOwner(ownerPath: string, localSha: string): void {
  resetTrackedDirtyFixOwner(ownerPath, localSha);
  hostWorktreeGit(ownerPath, ["clean", "-fd"]);
}

function preserveFixHead(repoDir: string, branch: string, localSha: string): string {
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

function preserveAbandonedFixOwnerDivergence(repoDir: string, branch: string, localSha: string): string {
  return preserveFixHead(repoDir, branch, localSha);
}

/**
 * W1-T2609: the fix rung's checkout onto its shared head ref (the PR's own branch, `realBranch`
 * at the one call site) — NON-DESTRUCTIVE, unlike the `checkout -B` this replaced. That branch
 * name is deliberately shared across every concurrent fix round for one task: creditability pins the branch name.
 * See `fixHeadAcceptable`/`deriveStatus`'s `ownsBranch` at this function's caller; only the
 * WORKTREE is per-attempt unique. A plain `checkout -B <branch> origin/<branch>` unconditionally
 * FORCE-RESETS the local ref to `origin/<branch>`, so a round that already committed locally
 * (unpushed) had that commit silently rewound by a concurrent round landing here in the same
 * window (PR #3261's reported incident).
 *
 * W1-T2839 closes the permanent-refusal state W1-T2609 left behind. Absent, equal, and behind
 * refs still create/attach/fast-forward. An ahead or diverged ref is moved only after (1) no
 * registered worktree holds it, (2) an exact recovery ref preserves its tip, and (3) an
 * `update-ref` compare-and-swap proves it did not change since inspection. Any failed proof
 * refuses; a successful transition returns its recovery evidence for the dispatch ledger.
 */
function checkoutFixHeadRef(
  repoDir: string,
  worktreePath: string,
  branch: string,
  deps: CheckoutFixHeadRefDeps = {},
): FixHeadRecovery | undefined {
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

/**
 * W1-T1129: the fix rung's throwaway worktree AND its named local branch, extracted from
 * `dispatchFix` (its one call site) purely so this exact git sequence is directly unit-testable
 * against a real repo.
 *
 * W1-T1129 removed the tracking-config write a `checkout -B ... origin/<branch>` would normally
 * make in the shared `.git/config`. W1-T2839 no longer uses `checkout -B`: it creates or moves the
 * local ref explicitly, then checks out that already-existing branch. The result remains a named,
 * pushable branch and still writes no `branch.<branch>.remote`/`.merge` tracking configuration.
 *
 * W1-T2609/W1-T2839: the checkout step itself is now {@link checkoutFixHeadRef} — it never
 * force-resets the shared branch, and it preserves stale non-ancestor tips before CAS recovery.
 *
 * W1-T5284: the fetch and the add are awaited — the sweep runs this on the daemon's loop, and its
 * sync `git fetch` held that loop. The branch claim the sweep takes first still serializes rounds.
 */
async function createFixRungWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  deps: CheckoutFixHeadRefDeps = {},
): Promise<FixHeadRecovery | undefined> {
  await hostWorktreeGitAsync(repoDir, ["fetch", "origin", "--quiet"]);
  await hostWorktreeGitAsync(repoDir, ["worktree", "add", worktreePath, `origin/${branch}`]);
  return checkoutFixHeadRef(repoDir, worktreePath, branch, deps);
}

/** The sweep fix lane cuts its own branch-attached worktree, bypassing `worktreeAdd`'s
 * dependency link. Supply the same local CLI toolchain before its worker can commit; an
 * unavailable link refuses before a strike instead of failing at the commit-msg hook. */
async function createFixRungWorktreeWithToolchain(
  repoDir: string,
  worktreePath: string,
  branch: string,
  prepare: (repoDir: string, worktreePath: string) => boolean = prepareWorktreeToolchain,
): Promise<FixHeadRecovery | undefined> {
  const recovery = await createFixRungWorktree(repoDir, worktreePath, branch);
  if (!prepare(repoDir, worktreePath)) {
    throw new Error("fix worktree toolchain unavailable: node_modules could not be linked");
  }
  return recovery;
}

function fixBranchClaimKey(owner: string, repo: string, branch: string): string {
  return `${FIX_BRANCH_CLAIM_PREFIX}${owner}--${repo}--${branch}`.replace(/[/\\]/g, "__");
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
function latestPriorVerdictSuppresses(priorEntriesForOrigin: readonly FeedbackEntry[]): FeedbackEntry | undefined {
  let latest: FeedbackEntry | undefined;
  for (const entry of priorEntriesForOrigin) {
    if (!latest || Date.parse(entry.ts) > Date.parse(latest.ts)) latest = entry;
  }
  return latest?.status === "rejected" ? latest : undefined;
}

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
function captureRepairFeedbackWithPriorVerdict(
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
async function runOneShotSweep(
  run: (pool: HandedOffHeadJudgmentPool) => Promise<SweepSummary>,
  pool = handedOffHeadJudgmentPool(),
): Promise<SweepSummary> {
  try {
    return await run(pool);
  } finally {
    await awaitHandedOffHeadJudgments(pool);
  }
}

/**
 * `rmd sweep [--repo <name>] [--dry-run]` — run ONE level-triggered reconciliation
 * pass over every open PR (W1-T77, ratifies P22 core). FAIL LOUD on junk args
 * BEFORE any `gh`/spawn (Standing rule). --dry-run previews dispositions and takes
 * NO effects. Non-zero exit only on a hard error.
 */
async function sweepCommand( rest: string[]): Promise<number> {
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

/** The reconciler's live close side (fb-1784756088300-6a481e): `gh issue close --comment` via
 *  {@link ghIssueGateway}, built once. Throws if the gateway cannot close, so a phantom close
 *  is never ledgered — the reconciler's per-issue containment catches it as `close-failed`. */
function buildEscalationCloser(
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
function renderEscalationReconcileSummary(s: SweepEscalationReconcileSummary): string {
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

async function sweepEscalationReconcile(
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

/** Rejudge only observed open issues, using their recorded subjects and this sweep's referent state. */
async function sweepEscalationTriage(
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

/**
 * THE W1-T474 CALL SITE for W1-T124's post-fix re-verification rung (`runPostFixReverification`,
 * src/lib/sweep.ts) — built and unit-tested (test/post-fix-reverification.test.ts) but callerless
 * until this task. For every open PR whose recorded failure matches a {@link DEFAULT_FIX_CLASSES}
 * row whose `fixPrNumber` has MERGED, mints a fresh head via the SAME `pushEmptyCommit` leaf the
 * ABSENT remedy (`repushAbsent` in {@link buildSweepEffects}) already uses — never a check
 * re-run: W1-T474's rationale (7) measured that the `pull_request` default checkout is the
 * PINNED merge ref, so re-requesting the same check-run replays the identical stale tree. Only a
 * new push (which fires `synchronize` and recomputes `refs/pull/N/merge` against CURRENT main)
 * actually changes what gets tested.
 *
 * `isMergedByNumber` defaults to a real `gh pr view --json state` read (mirrors `ghLiveStateByNumber`'s
 * own shape) so a class's fix is only ever treated as merged off a LIVE read, never an assumption.
 * `openPrs` is the caller's own already-fetched snapshot (never a second `buildOpenPrViews` read)
 * so this rung and `runSweep` observe the identical state for the same pass.
 *
 * MUST be called BEFORE `runSweep` (rationale (10)): the caller is responsible for excluding this
 * pass's `outcome === "redriven"` PRs from the list it hands `runSweep`, so the fix rung never
 * spends a strike deriving a disposition for a PR this rung just acted on in the same pass — a
 * fresh head carries no settled checks/review yet, so no rung should dispose it again until the
 * NEXT poll observes GitHub's own post-push state.
 */
async function sweepPostFixReverification(
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
async function runMountRecommenderRung(
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
 * Automatic remote-branch cleanup for one target repository. The cheap branch-set read happens on
 * every full sweep, while the existing expensive classifier/pruner runs only on first use, a branch
 * set change, or the six-hour bound. This is deliberately on the full sweep path: the write is a
 * remote `git push --delete`, so the light in-flight pass must never reach it.
 *
 * The command remains the one classification authority. This adapter supplies the target checkout,
 * target GitHub owner/repo, daemon run id and quiet output; it never constructs a second delete
 * predicate. An unreadable or empty branch listing is a named refusal, never a healthy zero.
 */
function runAutomaticBranchReapRung(
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

function* automaticBranchReapSteps(
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

/**
 * Pure judgement (design i/ii): which of `liveRuns` have gone quiet past `thresholdMs`, derived
 * from the AGE of each run's own newest `worker.state` ledger row — never a second, event-driven
 * definition of "stalled". A live run with NO `worker.state` row at all is skipped outright:
 * there is nothing whose age this can measure yet (the W1-T942 dependency's own shape — shipping
 * this detector before it would be a guard with no input, W1-T916's class of defect).
 *
 * DEDUP, ONE ROW PER QUIET EPISODE (design ii): a run is excluded when it already carries a
 * `worker.stalled` row NEWER than its own newest `worker.state` row — that quiet episode was
 * already reported and nothing has changed since. The moment the run speaks again (a fresh
 * `worker.state` transition postdating the last `worker.stalled` row), the comparison flips and
 * a LATER quiet stretch re-arms this check — never a per-tick re-fire, and never permanently
 * silenced either.
 *
 * Pure — no fs, no clock read of its own (`nowMs` is a parameter) — so the whole dedup/re-arm
 * shape is unit-testable against synthetic ledger lines with no file on disk at all
 * (test/worker-stall-detector.test.ts).
 */
function findStalledWorkers(
  liveRuns: readonly Pick<LiveInflightRun, "runId" | "taskId">[],
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  thresholdMs: number,
  nowMs: number,
): WorkerStallCandidate[] {
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

/** Best-effort, never-throwing read of a run's live tail for the stall escalation's evidence
 *  attachment — the read-side mirror of {@link writeWorkerTailBestEffort}. An absent/unreadable
 *  tail degrades to an empty array: the escalation still fires — W1-T942's own tail write is
 *  best-effort too, and a missing tail must never block the ONLY thing this detector is allowed
 *  to do (tell someone, design note iv). */
function readWorkerTailBestEffort(tailPath: string): string[] {
  try {
    if (!existsSync(tailPath)) return [];
    return readFileSync(tailPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * The daemon's per-poll WORKER-STALL rung (W1-T943) — appends `worker.stalled` ONCE per quiet
 * episode ({@link findStalledWorkers}) and escalates through the EXISTING §4 machinery
 * ({@link tryEscalate}), never a second one. NEVER acts on the run itself (design iv): no kill,
 * no signal, no dispatch deferral, no strike, no budget change — appending a ledger row and
 * filing/deduping an issue are the only two things this function does, full stop. Rides the SAME
 * per-poll cadence `runWorktreeReapRung`/`runInflightLockSweepRung`/`runWorkerTailSweepRung`
 * already occupy (see `buildSweepHook`'s call site) — own try/catch so a hiccup here never masks,
 * or is masked by, the rungs around it.
 */
function runWorkerStallDetectorRung(
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
function buildSweepHook(
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

/**
 * W1-T1211 — WHAT THE LIGHT PASS MAY ACT ON THIS TICK.
 *
 * `buildSweepLightHook` wires `actionable` while `runOne` is in flight, and every lane except
 * `post-review` stands down as "deferred to full sweep (light pass)". The RESTRICTION's
 * justification is spend-and-capacity — `src/lib/sweep.ts` records 3 dispatch lanes + 3 review
 * lanes against a host measured to fit about four concurrent workers — and of those five lanes
 * ONLY `dispatchFix` spawns a worker. `close`, `escalate`, `depReview` and `arm` are API calls.
 *
 * So the blanket is wider than its reason for exactly one case: a run that is WAITING rather than
 * working. Measured (this task's shard): one lock held 41 minutes wrote 347 light passes and ZERO
 * full sweeps while `fix.dispatch` read zero for twenty-one hours.
 *
 * The other four lanes are DELIBERATELY UNCHANGED (design note iii) — widening the blanket further
 * is a separate argument this task does not make.
 */
function lightPassActionable(
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
function blockedFixableIsRequeueOnly(pr: OpenPrView): boolean {
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
function runIsAwaitingExternal(lines: ReadonlyArray<Record<string, unknown>>, taskId: string): boolean {
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
function fixRungAllowedBesideInFlight(
  lines: ReadonlyArray<Record<string, unknown>>,
  inFlightTaskIds: readonly string[],
): boolean {
  return inFlightTaskIds.every((taskId) => runIsAwaitingExternal(lines, taskId));
}

/**
 * W1-T1211: the in-flight TASK ids, read from `state/inflight/*.lock` FILENAMES.
 *
 * A directory read, never a pid probe — see {@link runIsAwaitingExternal}'s doc for why
 * `liveInflightRuns` is refused here. The shared directory also holds namespaced fix-branch
 * serialization claims, which are not task runs and therefore never enter the task-phase join.
 * This reads no lock CONTENT, releases nothing, and ages nothing out: W1-T1067's stranded
 * `drain.lock` is the precedent for what a clock-shaped release does when its signal never
 * arrives, and this path has no clock at all.
 */
function inFlightTaskIdsFrom(inflightDir: string): string[] {
  if (!existsSync(inflightDir)) return [];
  return readdirSync(inflightDir)
    .filter((entry) => entry.endsWith(".lock") && !entry.startsWith(FIX_BRANCH_CLAIM_PREFIX))
    .map((entry) => entry.slice(0, -".lock".length));
}

/** W1-T9569 — what a review-only light pass writes on its rows: its scope, in the stand-down text and in
 * `light_pass_scope`, never the ordinary "deferred to full sweep (light pass)". An ordinary pass gets nothing. */
function reviewOnlyLightPassDeps(scope?: LightPassScope): Pick<SweepDeps, "lightPassScope" | "standDownReasonFor"> {
  const name = scope?.reviewOnly === true ? scope.scope : undefined;
  return name ? { lightPassScope: name, standDownReasonFor: () => reviewOnlyStandDownReason(name) } : {};
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

function buildSweepLightHook(
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

  return { spawnRmdReviewForFreshTree, reviewOptionFlags, reviewerFreshnessForPublication, ownStartFreshness, buildReviewerCodeFreshnessGate, assigningIssueGateway, reviewerRevertLane, buildReviewerHealthRoute, readyDraftViaGh, buildRequiredFixReviewRunner, buildSweepEffects, codeScanningJudgeDeps, handedOffHeadRiskJudge, refreshEscalationTriageEvidence, changeViewAsync, untouchedPlanCriterion, gitStatusResult, runPlanScopedConflictRound, runPlanScopedFixRound, fetchOpenPrsWithPostedIds, branchAuthorshipStandDownReason, unchangedTreeStandDownReason, dispatchFixPreflightStandDown, withPlanClaims, gitCredentialFixSpawn, materializePlanRoundWorktree, buildHeadroomRecoveryCandidates, renderHeadroomRecoveryCloseComment, retireRecoveredHeadroomEscalations, sweepPrTerminalRung, tickReadReverificationDeps, updatedForWorkflowFromLedger, createPlanFilingClassificationTelemetry, buildOpenPrViews, buildRereadPrAtAct, feedbackFixConstraint, buildFixRungDispatchArgs, registeredFixWorktreeOwner, fixHeadHeldByWorktree, boundedWorktreeOwnerPath, isManagedFixOwnerWorktreeName, decideRegisteredFixOwnerRecovery, pathIsAtOrBelow, readBoundedProcessCwdCensus, readRegisteredFixOwnerClaim, captureRegisteredFixOwnerSnapshot, readOwnerHasTrackedWork, removeAbandonedFixWorktreeOwner, preserveOrDiscardFixOwnerResidue, preserveStagedFixOwnerResidue, readFixOwnerResidue, resetTrackedDirtyFixOwner, preserveAndClearUntrackedFixOwner, preserveStaleDirtyFixOwner, clearStaleDirtyFixOwner, preserveFixHead, preserveAbandonedFixOwnerDivergence, checkoutFixHeadRef, createFixRungWorktree, createFixRungWorktreeWithToolchain, fixBranchClaimKey, latestPriorVerdictSuppresses, captureRepairFeedbackWithPriorVerdict, runOneShotSweep, sweepCommand, buildEscalationCloser, renderEscalationReconcileSummary, sweepEscalationReconcile, sweepEscalationTriage, sweepPostFixReverification, mountRecommenderCadenceMarkerPath, mountRecommenderNextFireMs, runMountRecommenderRung, runAutomaticBranchReapRung, automaticBranchReapSteps, findStalledWorkers, readWorkerTailBestEffort, runWorkerStallDetectorRung, buildSweepHook, lightPassActionable, blockedFixableIsRequeueOnly, runIsAwaitingExternal, fixRungAllowedBesideInFlight, inFlightTaskIdsFrom, reviewOnlyLightPassDeps, createLightPassCompareReader, buildSweepLightHook };
}

export function buildSweepEffects(host: SweepCommandHost, ...args: Parameters<ReturnType<typeof sweepCommandHelpers>["buildSweepEffects"]>): ReturnType<ReturnType<typeof sweepCommandHelpers>["buildSweepEffects"]> {
  return sweepCommandHelpers(host).buildSweepEffects(...args);
}

export async function sweepCommand(host: SweepCommandHost, ...args: Parameters<ReturnType<typeof sweepCommandHelpers>["sweepCommand"]>): ReturnType<ReturnType<typeof sweepCommandHelpers>["sweepCommand"]> {
  return sweepCommandHelpers(host).sweepCommand(...args);
}

export function buildSweepHook(host: SweepCommandHost, ...args: Parameters<ReturnType<typeof sweepCommandHelpers>["buildSweepHook"]>): ReturnType<ReturnType<typeof sweepCommandHelpers>["buildSweepHook"]> {
  return sweepCommandHelpers(host).buildSweepHook(...args);
}

export function buildSweepLightHook(host: SweepCommandHost, ...args: Parameters<ReturnType<typeof sweepCommandHelpers>["buildSweepLightHook"]>): ReturnType<ReturnType<typeof sweepCommandHelpers>["buildSweepLightHook"]> {
  return sweepCommandHelpers(host).buildSweepLightHook(...args);
}
