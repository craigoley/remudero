import type { LifetimeIndexFailure } from "../../lib/lifetime-identity-index.js";
import { pendingImprovementActions } from "../../lib/improvement-thread.js";
import type { RatifyCliGateway } from "../../lib/panel-graph.js";
/**
 * W1-T9333 — the `daemon` verb's handler, moved out of `src/run-task.ts` (decomposition: one verb per module).
 * `daemonCommand` is the unchanged body; the run-task.ts symbols it reaches arrive through {@link DaemonCommandHost}
 * (never an import — `cli-no-run-task`), and `src/run-task.ts` keeps a same-named function that builds the host
 * and delegates here, so HANDLERS and every caller are unchanged.
 */
import type { tickReadProducer, TickReadFacts, TickReadRequest } from "../../lib/tick-read-worker.js";
import { registeredGardenEnabled } from "../../lib/garden-registry.js";
import { startReadPlane, startReadPlaneTelemetry, onePassPerGeneration, freshReadGeneration, type ReadGeneration } from "../../lib/read-plane.js";
import { remeasureSettledGoals, withGoalRemeasurement } from "../../lib/goals.js";
import { judgeCiEscalation, productionCiJudgePorts, singleFlightCiJudge, withCiJudgeAfterSweep, type CiJudgeIo } from "../../lib/ci-escalation-judge.js";
import { recyclePauseDetail } from "../../lib/recycle-yield.js";
import { judgeDiskHeadroom, readDiskFreeBytes } from "../../lib/doctor.js";
import { execFileSync } from "node:child_process";
import { execFileLoopBounded } from "../../lib/loop-bounded-child.js";
import { GATEWAY_FETCH_TIMEOUT_MS } from "../../lib/git-fetch-retry.js";
import { productionDispatchBreakJudge, productionFixProgressJudge } from "../../lib/sweep.js";
import { ghExec, ghJsonAsync, ghTextAsync } from "../../lib/github-transport.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, providerRoutingOwnsHeadroom, resolveHeadroomEnabled, workerHomeDir, type Config } from "../../lib/config.js";
import { ledgerPathFor } from "../../lib/ledger-path.js";
import { escalateCrashLoop, escalateDiskHeadroomBreach, escalateHeadroomParkCeiling, escalateHeadroomReserve, escalateQuotaExhaustion, escalateReplayStranded, escalateStarvation, escalateStarvationCleared } from "../../lib/escalation-catalogue.js";
import { resolveProviderRoutingPolicy } from "../../lib/provider-routing-policy.js";
import { writeProviderRoutingStatus, type ProviderRoutingWriteInput } from "../../lib/provider-routing-status.js";
import { readFileIfExists } from "../../lib/fs-race-safe.js";
import { mergedInLastDayAsync } from "../../lib/fleet-lane.js";
import { startDaemonSreLane } from "../../lib/daemon.js";
import { REGISTERED_GARDEN_NAMES, startGardenOffLoop, type GardenPassSpawn, type RegisteredGardenName } from "../../lib/garden-registry.js";
import { gardenSchedule } from "../../lib/garden-registry.js";
import { createGardenerRuntimeWriter } from "../../lib/gardener-runtime.js";
import { daemonSreLaneInput, resolveSreLaneInstance, sreLaneEnabled, sreLaneStartRow } from "../../lib/sre-lane.js";
import { daemonSreRunbookHost, daemonSreRunbookPass, readRunbookReceipts, sreRunbookCatalog } from "../../lib/sre-runbooks.js";
import { daemonBreakerRunbookHost } from "../../lib/breaker-release.js";
import { inboxThreadStorePath, type RatifyCliHandle } from "../../lib/panel-graph.js";
import { createThreadEventSync, registryThreadItems, type InboxResponderDeps } from "../../lib/inbox-responder.js";
import type { InboxCausalScope } from "../../lib/inbox-thread.js";
import { gitRecommendationEvidence, RECOMMENDATION_SEED_PATH } from "../../lib/inbox-recommendation.js";
import { censusRunDirs } from "../../lib/run-child-contract.js";
import { plannedSequence, runDrain, type DrainDeps, type MergedSet, type OpenPrCheck } from "../../lib/drain.js";
import { fileTargetJobStore, nativeTargetAdmission, readTargetExecution, type ProductBuildInstances } from "../../lib/product-build.js";
import { loadManagedRepos } from "../../lib/managed-repos.js";
import type { RunResult } from "../../lib/run-result.js";
import { runBoundedTargetJob, type BoundedTargetJobPorts, type BoundedTargetJobOutcome, daemonBoot, daemonExitCodeForSummary, resolveFleetControlHold, runDaemon, readRestartHistoryLines, type CrashLoopVerdict, type DaemonDeps, type DaemonKick, type DaemonOpts, type DaemonSummary, priorUnrecognisedResetStrings, daemonPushTokenSource, receivePackCredentialProbe } from "../../lib/daemon.js";
import { sweepStrandedReviewWorktrees } from "../../lib/review-worktree-reclaim.js";
import { sweepReclaimableArtifacts } from "../../lib/disk-artifact-reclaim.js";
import { readGhRateLimitBuckets } from "../../lib/daemon-health.js";
import { defaultListCandidates, defaultReadMarkers, killProcessGroup, sweepOrphanWorkers, workerInstallationScope } from "../../lib/worker-containment.js";
import { sweepStaleTempDirs } from "../../lib/tmp.js";
import { sweepStaleWorkerScratch } from "../../lib/worker-scratch.js";
import { daemonInstanceRegistryPath } from "../../lib/deployer.js";
import { DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS } from "../../lib/dep-review.js";
import { withEscalationSpoolDrain } from "../../lib/host-escalation-spool.js";
import { instanceMode, readInstanceRegistryText } from "../../lib/instance-mode.js";
import { escalate, escalateWithJudge, realEscalationJudge, ghIssueGateway, ghIssueGatewayAsync, type Escalation, type EscalationJudgeVerdict } from "../../lib/escalate.js";
import { createGhCallPacer } from "../../lib/open-prs-rest.js";
import { buildMainHealthRung } from "../../lib/main-health-rung.js";
import { ghEscalationAnswerGateway } from "../../lib/escalation-answers.js";
import { feedbackLandingSweepRungs, type LandingReviewRequest } from "../../lib/feedback-landing.js";
import { readAffectedSuitesInputAsync } from "../../lib/affected-suites.js";
import { parseProposalRegistry } from "../../lib/inbox.js";
import { appendLedger, markDaemonProcessActor } from "../../lib/ledger.js";
import { clockFromMillisFn, fixedClock, systemClock } from "../../lib/clock.js";
import { getHeapStatistics } from "node:v8";
import { sweepInflightLocksWithReceipts } from "../../lib/benchmark-run.js";
import { ledgerMemoHolders } from "../../lib/ledger-union.js";
import { childMeasurementCadenceSpawn, measurementCadenceChildRunner } from "../../lib/measurement-cadence.js";
import { loadPlan, type Plan } from "../../lib/plan.js";
import { readOperatorReleaseRecords } from "../../lib/machine-filing-judge.js";
import { readReleaseLedgerLines } from "../../lib/operator-release.js";
import { runnerConfigDigest, terminalPreDispatchRefusalRevisions } from "../../lib/dispatch-repair.js";
import { loadMounts, mountsPath } from "../../lib/mounts.js";
import { loadPolicy, policyPath } from "../../lib/policy.js";
import { refreshReviewPublisherToken as refreshInstallationToken } from "../../lib/review.js";
import { feedbackStatusOnMain } from "../../lib/auto-triage.js";
import { bootSweepDispatchClaims, dispatchClaimRef, releaseLandedDispatchClaims, claimMintedByRerun, type DispatchClaimReserver, type DispatchClaimReserverAsync } from "../../lib/dispatch-claim.js";
import { loadCreditStore, saveCreditStore, recordCredit, refusesAsPlanOnly, buildCommitTrailerIndex, projectPlan, independentBlockReleasesFrom, readLedgerLines, readLedgerSnapshot, buildLedgerIndex, createDispatchBreakerCache, evaluateDispatchBreakerCorroboratedDetailed, hasRepeatedTaskAttributableLifetimeDispatches, type LedgerLines, type LedgerSnapshot, type DispatchBreakerDetail, type GitHub, type PrRef, type StatusProjection, taskIdFromRunBranch } from "../../lib/status.js";
import { DEFAULT_SWEEP_POLICY, productionFixPressure, readIdleLightCadence, readObservedReviewMedianMs } from "../../lib/sweep.js";
import { startMainEntryWatch } from "../../lib/main-entry.js";
import { createLiveSetKeeper, createPlanCopyBook, daemonHolderSource, observedPlanSync, startDaemonMemoryCensus } from "../../lib/daemon-memory-census.js";
import { terminalUnionScans } from "../../lib/sweep.js";
import { createDaemonFootprint, daemonFootprintPath, installDaemonFootprint } from "../../lib/daemon-footprint.js";
import { applyDaemonMemoryPolicy, createDaemonMemoryGovernor, createDaemonSlackReclaimer, installDaemonSlackReclaimer, readDaemonMemoryPolicy } from "../../lib/daemon-memory-policy.js";
import { workerThreads } from "../../lib/worker-heaps.js";
import { readCiGateRequiredChecks } from "../../lib/ci-gate-required.js";
import { resolveClaudeExecutable, claudeExecutableCache } from "../../lib/worker.js";
import { defaultInstance, memoryStoreReadFailure, readMemoryLedger, sweepMemoryReservations } from "../../lib/host-memory-ledger.js";
import { type DispatchGovernorDeps } from "../../lib/dispatch-governor.js";
import { focusGateFor } from "../../lib/focus-gardener.js";
import { captureHeavyNewBuildStartupGate } from "../../lib/heavy-ready-startup.js";
import { hostWorktreeGitAsync } from "../../lib/worktree-git.js";
import { step } from "../../lib/git-push.js";
import { ensureWorkerKeychain, sweepStaleWorkerHomes, workerKeychainPaths } from "../../lib/worker-home.js";
import { acquireDrainLock, DrainLockError } from "../../lib/drain-lock.js";
import { testRunnerOnItsOwnCheckout } from "../../lib/self-sync.js";
import { withLiveEditLadders } from "../../lib/live-edit-ladder.js";
import { checkSharedPause, disposeSharedPauseRefresh, prepareSharedPause, clearKick, consumeDrainNow, clearPrAction, consumeStop, isQuietHours, kickFilePath, pauseDetail, pendingKicks, pendingPrActions, stopDetail } from "../../lib/fleet-control.js";
import { wireSweepWakeToDaemon } from "../../lib/github-event-wake.js";
import { startInstallationTokenRefresh } from "../../lib/github-app.js";
import { LEDGER_REQUEST_STEP, realScopedMint, startDaemonGitCredentialSocket, type ScopedTokenMint } from "../../lib/secret-boundary.js";
import { automaticBranchReapStateFileName, orphanRunBranchEvidenceReader } from "../../lib/branch-reaper.js";
import { repoRoot, resolveOwnerRepo, writeDaemonTargetRecord } from "../../lib/repo-location.js";
import { resolveRepoLayout } from "../../lib/repo-layout.js";
import { flagValue, unknownArgError } from "../../lib/cli-args.js";
import { liveInflightRuns, readCheckoutDepth } from "../../lib/report-commands.js";
import { adoptRunChildren, createAdmittedPlanSlot, runChildModeIsOn, startRunChildProbe, tapPlanSnapshot, type AdoptedRunChild } from "../../lib/run-child.js";
import { loadRunChildMode, type RunChildMode } from "../../lib/policy.js";
import {
  bootRunChildMode, createRunChildModeTracker, readRunChildPolicy, runChildModeFor,
  type RunChildContractEscalation, type RunChildModeDecision,
} from "../../lib/run-child-mode.js";
import { type TickReadOptions, startTickReadWorker, tickReadWorkerUrl, fetchCiFailuresAsync, mergeLogEvidenceByRoot } from "../../lib/tick-read-worker.js";

/**
 * W1-T9333: everything `daemonCommand` reaches in `src/run-task.ts` that is not a `src/lib` symbol. This module
 * may not import run-task.ts (`cli-no-run-task`: a cycle with HANDLERS), so run-task.ts builds this object and passes
 * it in, like the repo's other `*Deps` seams. Each member is the SAME function or value run-task.ts defines. Their
 * real parameter types are run-task.ts-local, so members are typed loosely here; the delegating `daemonCommand`
 * in run-task.ts keeps the same name and call signature for every caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostFn = (...args: any[]) => any;

export function daemonImprovementActionDeps(stateDir: string, gateway: RatifyCliGateway) {
  return {
    pendingImprovementActions: () => pendingImprovementActions(stateDir),
    handOffImprovementAction: async (target: { operationId: string; stateDir: string; repoRoot: string }) => {
      if (!gateway.improvement) throw new Error("The daemon's fresh-source improvement gateway is unavailable.");
      return gateway.improvement(target);
    },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostValue = any;
export interface DaemonCommandHost {
  readonly USAGE: string;
  readonly auditedLifetimeTalliesFromArchives: HostFn;
  readonly baseReproductionHostCache: HostValue;
  readonly boardReviewHooksForTick: HostFn;
  readonly breakerDetailDep: HostFn;
  readonly breakerGateFor: HostFn;
  readonly buildAutoTriageDaemonHooks: HostFn;
  readonly buildBenchmarkCohortDaemonHooks: HostFn;
  readonly buildCiLearningDaemonHooks: HostFn;
  readonly buildCoverageNightlyDaemonHook: HostFn;
  readonly buildDaemonReadRefresher: HostFn;
  readonly buildDigestCadenceDaemonHooks: HostFn;
  readonly buildGithubPostureDaemonHooks: HostFn;
  readonly buildIntakeRungsDaemonHooks: HostFn;
  readonly buildLedgerCompactionDaemonHooks: HostFn;
  readonly buildMeasurementCadenceDaemonHooks: HostFn;
  readonly buildRetroDaemonHooks: HostFn;
  readonly buildSweepHook: HostFn;
  readonly buildSweepLightHook: HostFn;
  readonly buildWipeTestCadenceDaemonHooks: HostFn;
  readonly costGovernorGateFor: HostFn;
  readonly createDaemonGatewayFactory: HostFn;
  readonly createOpenPrCountObservation: HostFn;
  readonly createPlanSyncCoalescer: HostFn;
  readonly daemonDefaultBuildSweepHook: HostFn;
  readonly daemonDefaultBuildSweepLightHook: HostFn;
  readonly daemonFreshnessReads: HostFn;
  readonly daemonRunChildContract: HostFn;
  readonly daemonGardenPassSpawn: HostFn;
  readonly daemonMemoryTelemetryReader: HostFn;
  readonly daemonPlanReaders: HostFn;
  readonly dailyCostCeilingReloader: HostFn;
  readonly dispatchClaimReserverAsyncFor: HostFn;
  readonly dispatchClaimReserverFor: HostFn;
  readonly dispatchFilingCache: HostValue;
  readonly dispatchFilingPrefetch: HostValue;
  readonly dispatchValueContextForSelection: HostFn;
  readonly escalationSpoolDrainWiring: HostFn;
  readonly fixCommand: HostFn;
  readonly fleetLaneSamenessJudge: HostFn;
  readonly fleetRatifyGateway: HostFn;
  readonly ghLiveStateByNumber: HostFn;
  readonly headroomPolicyFromCurve: HostFn;
  readonly inboxRecommendationWriter: HostFn;
  readonly inboxThreadDecider: HostFn;
  readonly liveEditLadderWiring: HostFn;
  readonly loadDaemonPlan: HostFn;
  readonly logCloneReapSurvey: HostFn;
  readonly mainRepairLaneFor: HostFn;
  readonly makeLandingReviewRequest: HostFn;
  readonly memoiseBoardSnapshotByRepo: HostFn;
  readonly memoiseGatewayByRepo: HostFn;
  readonly memoryGovernorGateFor: HostFn;
  readonly memoryReadTrackerFor: HostFn;
  readonly onCircuitBreakWithVerifier: HostFn;
  readonly openSiblingObservation: HostFn;
  readonly orphanSweepRunActive: HostFn;
  readonly orphanWorkerKillLedger: HostFn;
  readonly plainInboxWriter: HostFn;
  readonly productionLifetimePressureHook: HostFn;
  readonly quarantineReporter: HostFn;
  readonly queueGovernorGateFor: HostFn;
  readonly readMainCeilingVerdictAsync: HostFn;
  readonly readPushedRunBranchesOutputAsync: HostFn;
  readonly readUsageSnapshotPreferSdk: HostFn;
  readonly realDeps: HostFn;
  readonly registeredGardenDueProbe: HostFn;
  readonly requeueActionsJobAsync: HostFn;
  readonly resequenceMergedResolver: HostFn;
  readonly resolveDaemonTarget: HostFn;
  readonly resolveReloadPlan: HostFn;
  readonly reviewCommand: HostFn;
  readonly reviewerCodeRecoveryFromLoadedModule: HostFn;
  readonly runInChildWhenOn: HostFn;
  readonly runInflightLockSweepRung: HostFn;
  readonly runRegisteredGardenPass: HostFn;
  readonly runRepositoryMaintenanceRung: HostFn;
  readonly runTask: HostFn;
  readonly servedTickRead: HostFn;
  readonly shardRepairRequester: HostFn;
  readonly syncPlanOrRefuseAsync: HostFn;
  readonly unwireOwnCheckoutCredentialHelper: HostFn;
  readonly writeSyncLine: HostFn;
}

/** The sweep-hook builders' types, as the host supplies them. */
type DaemonSweepHookBuilder = DaemonCommandHost["buildSweepHook"];
type DaemonSweepLightHookBuilder = DaemonCommandHost["buildSweepLightHook"];

/** What {@link buildRegisteredGarden} builds a garden over: the daemon's own config, repo and ledger writers. */
export interface GardenBuildContext {
  codeSha?: string;
  pollIntervalMs?: number;
  config: Config;
  repoRoot: string;
  owner: string;
  repo: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  raiseDuplicate: (e: Escalation) => string;
}

/** One production composition, using the boot's existing gateway and its in-flight ownership. */
export function createDaemonInboxResponder(opts: {
  root: string;
  ledgerPath: string;
  scope: InboxCausalScope;
  ratify: Pick<RatifyCliHandle, "reframe">;
  decide: InboxResponderDeps["decide"];
  log: (step: string, extra?: Record<string, unknown>) => void;
}): InboxResponderDeps {
  const scope = { ...opts.scope }, threadStorePath = inboxThreadStorePath(opts.root);
  return {
    scope, threadStorePath, ledgerPath: opts.ledgerPath,
    readItems: () => registryThreadItems(join(opts.root, "state"), opts.ledgerPath, scope),
    reframe: (proposalId, feedback, input) => opts.ratify.reframe(proposalId, feedback, input),
    syncEvents: createThreadEventSync({ ledgerPath: opts.ledgerPath, threadStorePath, stateDir: join(opts.root, "state"), log: opts.log }).sync,
    decide: opts.decide,
  };
}

/**
 * W1-T10615: ONE daemon's view of the kick markers under its own config root. A repo-scoped marker
 * (`KICK_REQUESTED-<repo>:<taskId>`) belongs only to the daemon whose target names that repository; an
 * unscoped legacy marker only to the self daemon, whose plan the console's Run button reads. Every other
 * daemon leaves a marker alone, so it can neither consume nor refuse a kick another repository's plan
 * owns. A marker is offered only while the exact file its clear would delete exists, so a marker whose
 * body disagrees with its name is never dispatched and is left for an operator, as a garbage one is.
 */
export function daemonKickPort(root: string, target: { repo: string; isSelf: boolean }): {
  pendingKicks: () => DaemonKick[];
  clearKick: (taskId: string, repo?: string) => void;
} {
  const addressed = (kick: DaemonKick) => kick.repo === undefined ? target.isSelf : kick.repo.toLowerCase() === target.repo.toLowerCase();
  return {
    pendingKicks: () => pendingKicks(root).filter((kick) => addressed(kick) && existsSync(kickFilePath(root, kick.taskId, kick.repo))),
    clearKick: (taskId, repo) => { clearKick(root, taskId, repo); },
  };
}

/**
 * W1-T10799: foreign repo-scoped markers and unfinished durable jobs under the CORE root. Only
 * {@link createNativeTargetJobRunner} consumes them; durable recovery survives a missing marker.
 */
export function daemonTargetJobPort(root: string, self: { repo: string }): {
  pendingTargetJobs: () => Array<DaemonKick & { repo: string }>;
} {
  return {
    pendingTargetJobs: () => {
      const marked = pendingKicks(root).flatMap((kick) =>
        kick.repo !== undefined && kick.repo.toLowerCase() !== self.repo.toLowerCase() && existsSync(kickFilePath(root, kick.taskId, kick.repo))
          ? [{ taskId: kick.taskId, origin: kick.origin, repo: kick.repo }] : []);
      const durable = fileTargetJobStore(root).readAll().filter((job) => job.status === "admitted" && job.repo.toLowerCase() !== self.repo.toLowerCase());
      return [...marked, ...durable.filter((job) => !marked.some((kick) => kick.origin === job.origin))];
    },
  };
}

/** Host governors and contract-pinned releases remain shared; repository decision reads are target-scoped. */
const TARGET_JOB_DAEMON_DEPS = [
  "checkStop", "checkPause", "checkCostGovernor", "checkQueueGovernor", "checkMemoryGovernor", "memoryReadTracker", "readMemoryStoreFailure",
  "checkQuietHours", "checkHeavyNewBuild", "readUsage", "readLedgerLines", "readDurableReleases",
] as const satisfies readonly (keyof DrainDeps & keyof DaemonDeps)[];

/** Repository reads for one bounded target; host capacity still belongs to the Core daemon. */
export function createNativeTargetRepository(root: string, owner: string, repo: string, github: GitHub, _core: Partial<DaemonDeps> = {}) {
  const ledgerPath = ledgerPathFor({ root });
  const state = join(root, "state", "target-repositories", encodeURIComponent(owner.toLowerCase()), encodeURIComponent(repo.toLowerCase()));
  const cache = createDispatchBreakerCache();
  let snapshot: Pick<LedgerSnapshot, "lines" | "index"> | undefined;
  let details = new Map<string, DispatchBreakerDetail>();
  let branches: ReturnType<NonNullable<GitHub["listOpenHeadBranches"]>> | undefined;
  let branchesRead = false;
  const current = () => {
    if (snapshot !== undefined) return snapshot;
    const source = readLedgerSnapshot(ledgerPath);
    const runRepos = new Map<string, Set<string>>();
    for (const row of source.lines) {
      if (row.step !== "run.start" || typeof row.run_id !== "string" || typeof row.repo !== "string") continue;
      const repos = runRepos.get(row.run_id) ?? new Set<string>();
      repos.add(row.repo.toLowerCase());
      runRepos.set(row.run_id, repos);
    }
    const rows = source.lines.filter((row) => {
      if (typeof row.repo === "string") return row.repo.toLowerCase() === repo.toLowerCase();
      const repos = typeof row.run_id === "string" ? runRepos.get(row.run_id) : undefined;
      return repos?.size === 1 && repos.has(repo.toLowerCase());
    });
    const lines = Object.defineProperties(rows, {
      torn: { value: source.lines.torn }, present: { value: source.lines.present },
    }) as LedgerLines;
    snapshot = { lines, index: buildLedgerIndex(lines) };
    return snapshot;
  };
  const detailFor = (id: string) => {
    let detail = details.get(id);
    if (detail === undefined) {
      detail = evaluateDispatchBreakerCorroboratedDetailed(ledgerPath, id, cache, () => {
        if (!branchesRead) { branches = github.listOpenHeadBranches?.(); branchesRead = true; }
        return branches;
      }, { snapshot: current() });
      details.set(id, detail);
    }
    return detail;
  };
  const governors = {
    beginSelectionPass: () => { snapshot = undefined; details = new Map(); branchesRead = false; },
    isCircuitTripped: (id: string) => detailFor(id).state === "tripped",
    isIndeterminate: (id: string) => detailFor(id).state === "indeterminate",
    breakerDetail: (id: string) => ({ ...detailFor(id) }),
    isLifetimeCapExceeded: (id: string) => hasRepeatedTaskAttributableLifetimeDispatches(current().lines, id),
  } satisfies Partial<DrainDeps>;
  return {
    persistCredit: (task: Plan["tasks"][number], pr: { number: number; url: string }, files: readonly string[] | undefined) => {
      if (files === undefined || files.length === 0) return "unreadable" as const;
      if (refusesAsPlanOnly(task, files)) return "plan-only" as const;
      const path = join(state, "credits.json");
      saveCreditStore(path, recordCredit(loadCreditStore(path), task.id, {
        source: "trailer", prUrl: pr.url, prNumber: pr.number, prState: "MERGED",
      }));
      return "recorded" as const;
    },
    project: (plan: Plan) => {
      governors.beginSelectionPass();
      github.resetFailureFlags?.();
      return projectPlan(plan, { ledgerPath, github, readLedger: () => current().lines,
        creditStorePath: join(state, "credits.json"), creditOverridePath: join(state, "credit-overrides.yaml"),
        skipUncreditedBuildWarning: true }, join(state, "status.json"));
    },
    governors,
  };
}

/** Keep each target's decision cache for this daemon lifetime, with no cross-repository aliasing. */
export function nativeTargetRepositoryResolver(root: string, githubFor: (owner: string, repo: string) => GitHub) {
  const scopes = new Map<string, ReturnType<typeof createNativeTargetRepository>>();
  return (owner: string, repo: string) => {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    let scope = scopes.get(key);
    if (scope === undefined) {
      scope = createNativeTargetRepository(root, owner, repo, githubFor(owner, repo));
      scopes.set(key, scope);
    }
    return scope;
  };
}

export interface NativeTargetJobContext {
  /** The core daemon's config root: its ledger, its kick markers and the job records live under it. */
  root: string;
  /** The checkout whose reviewed managed set enrolls targets and whose registry names their live daemons. */
  repoRoot: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  nowMs: () => number;
  instances?: ProductBuildInstances;
  /** The target clone's plan path, derived exactly as `resolveDaemonTarget` derives it; undefined refuses to start. */
  planPathFor: (owner: string, repo: string) => string | undefined;
  /** Clone-if-absent, then sync that plan from origin/main through the existing plan-sync refusal. */
  syncPlan: (planPath: string, owner: string, repo: string) => Promise<{ plan: Plan } | { error: string }>;
  /** The merged/open-PR projection bound to the TARGET owner and repository, never the core repository's closures. */
  project: (plan: Plan, owner: string, repo: string) => Map<string, StatusProjection>;
  repositoryDeps: (owner: string, repo: string, core: DaemonDeps) => Partial<DrainDeps>;
  runTask: (taskId: string, target: { planPath: string; owner: string; repo: string; plan: Plan; onRunCreated: (runId: string) => void }) => Promise<RunResult>;
  claimHeld: BoundedTargetJobPorts["claimHeld"];
  runDrain?: typeof runDrain;
}

/**
 * W1-T10799: the core daemon's owner of ONE bounded native job for a managed target with no daemon of its own. It
 * composes {@link runBoundedTargetJob} over the real durable record, the real registry and managed set, and the
 * maintained drain with the core daemon's own governors, and takes no capacity of its own: the daemon runs it inline in
 * the lane it reserves.
 */
export function createNativeTargetJobRunner(ctx: NativeTargetJobContext): (kick: DaemonKick & { repo: string }, daemonDeps: DaemonDeps, onDispatch?: () => void) => Promise<BoundedTargetJobOutcome> {
  const store = fileTargetJobStore(ctx.root);
  const stateDir = join(ctx.root, "state");
  let reserved = false;
  return async (kick, daemonDeps, chargeDispatch) => {
    if (reserved) {
      ctx.log("target_job.capacity_deferred", { task: kick.taskId, origin: kick.origin, repo: kick.repo, reason: "core lane reserved by another job" });
      return { state: "held", reason: "core lane reserved by another job" };
    }
    reserved = true;
    try {
      let owner = "";
      let planPath = "";
      let projection = new Map<string, StatusProjection>();
      const governors = Object.fromEntries(TARGET_JOB_DAEMON_DEPS.flatMap((key) => (daemonDeps[key] === undefined ? [] : [[key, daemonDeps[key]]]))) as Partial<DrainDeps>;
      const jobDeps: BoundedTargetJobPorts = {
        readJob: store.read,
        writeJob: store.write,
        admit: (repo) => nativeTargetAdmission(repo, { ...ctx.instances, repoRoot: ctx.repoRoot }),
        syncPlan: async (targetOwner, repo) => {
          const path = ctx.planPathFor(targetOwner, repo);
          if (path === undefined) return { error: "no target clone path" };
          owner = targetOwner;
          planPath = path;
          return ctx.syncPlan(path, targetOwner, repo);
        },
        claimHeld: ctx.claimHeld,
        // The core ledger's own receipts for THIS origin, read from the dispatch time the durable record kept.
        execution: (record) => readTargetExecution(stateDir, { taskId: record.taskId, origin: record.origin, repo: record.repo,
          requestedAt: fixedClock(Date.parse(record.updatedAt) - 60_000).iso(), nowMs: ctx.nowMs(), runId: record.runId }),
        drain: (plan, opts, onDispatch) => {
          const repository = ctx.repositoryDeps(owner, kick.repo, daemonDeps);
          return (ctx.runDrain ?? runDrain)(plan, {
          ...governors,
          ...repository,
          refreshMerged: () => {
            projection = ctx.project(plan, owner, kick.repo);
            return (id) => projection.get(id)?.merged ?? false;
          },
          isOpenPr: (id) => { const row = projection.get(id); return row?.prState === "OPEN" ? row.prNumber : undefined; },
          isCreditIndeterminate: (id) => projection.get(id)?.indeterminate === true,
          isIndeterminate: (id) => projection.get(id)?.indeterminate === true || repository.isIndeterminate?.(id) === true,
          isIndependentFailureBlocked: (id) => projection.get(id)?.independentFailureBlocked === true,
          runOne: async (id) => {
            onDispatch();
            chargeDispatch?.();
            return ctx.runTask(id, { planPath, owner, repo: kick.repo, plan, onRunCreated: (runId) => {
              const read = store.read(kick.origin);
              if (read.state !== "found" || read.record.status !== "admitted" || read.record.runId !== undefined) throw new Error("native job identity unavailable");
              store.write({ ...read.record, runId });
              ctx.log("console.kick_dispatched", { task: id, origin: kick.origin, repo: kick.repo, native_run_id: runId });
            } });
          },
          log: (step, extra) => ctx.log(step, { ...extra, owner, repo: kick.repo }),
        }, opts);
        },
        clearKick: (taskId, repo) => { clearKick(ctx.root, taskId, repo); },
        log: ctx.log,
        nowIso: () => clockFromMillisFn(ctx.nowMs).iso(),
      };
      return await runBoundedTargetJob(kick, jobDeps);
    } finally { reserved = false; }
  };
}

/** W1-T10897: the checkout whose `origin` is the target repo — this engine checkout for a self-targeting
 *  daemon, else the target's clone under the config root's `repos/`. */
export function daemonTargetCheckoutRoot(target: { repo: string; isSelf: boolean }, configRoot: string, selfRoot: string = repoRoot): string {
  return target.isSelf ? selfRoot : join(configRoot, "repos", target.repo);
}

/**
 * W1-T916 — the ONE ref read behind {@link DrainDeps.readPushedRunBranches} and its daemon twin.
 * Raw `git ls-remote --heads origin 'run-*'` output, returned verbatim for `runBranchTaskIds`
 * (drain.ts) to parse ONCE PER PASS above the dispatch loop. Scoped to `run-*` so the refspec
 * filters server-side rather than shipping every head back; `ls-remote` speaks the git protocol and
 * spends neither the REST nor the GraphQL budget — measured at 46 refs in 199 ms with `core`
 * remaining identical before and after.
 *
 * FAIL OPEN, DELIBERATELY. A throw (network blip, auth, no remote) yields `""`, which parses to an
 * EMPTY set, so no task is refused — precisely the behaviour before this existed. The degraded
 * outcome is "no improvement", never "dispatch wrongly blocked", which is the only safe direction
 * for a guard that decides whether work starts at all.
 *
 * `exec` is appended LAST and defaulted so no caller shifts; it exists because the catch arm above
 * is otherwise unreachable from any offline test, which is exactly how this task's own defect
 * (a seam nothing supplied) came about.
 */
type RunBranchSyncExec = (cmd: string, args: string[], opts: { encoding: "utf8"; cwd: string }) => string;
type RunBranchAsyncExec = (cmd: string, args: string[], opts: { encoding: "utf8"; cwd: string; timeout: number; killSignal: "SIGKILL" }) => Promise<{ stdout: string }>;

/** W1-T10897: a leading checkout path names the repo whose `origin` is listed; without one it is this engine checkout. */
export function readPushedRunBranchesOutput(checkout: string, exec?: RunBranchSyncExec): string;
export function readPushedRunBranchesOutput(exec?: RunBranchSyncExec): string;
export function readPushedRunBranchesOutput(...args: [(string | RunBranchSyncExec)?, RunBranchSyncExec?]): string {
  const [cwd, exec = execFileSync as never] = typeof args[0] === "string" ? [args[0], args[1]] : [repoRoot, args[0]];
  try {
    return exec("git", ["ls-remote", "--heads", "origin", "run-*"], { encoding: "utf8", cwd });
  } catch {
    // Deliberate fail-open: unreadable refs and no refs both leave dispatch eligible (W1-T916).
    return "";
  }
}

/** W1-T5805 — the same read as an awaited child, for the daemon's tick and each lane refill: killed past
 *  `timeoutMs`, and REJECTING on any failure so the daemon ledgers it and keeps its fail-open direction.
 *  W1-T10897: a consumer daemon passes its target checkout, and the rejection names that checkout, so the
 *  `dispatch.run_branch_read_failed` row says which repo's listing failed. */
export function readPushedRunBranchesOutputAsync(checkout: string, exec?: RunBranchAsyncExec, timeoutMs?: number): Promise<string>;
export function readPushedRunBranchesOutputAsync(exec?: RunBranchAsyncExec, timeoutMs?: number): Promise<string>;
export async function readPushedRunBranchesOutputAsync(
  ...args: [(string | RunBranchAsyncExec)?, (RunBranchAsyncExec | number)?, number?]
): Promise<string> {
  const [cwd, exec = execFileLoopBounded, timeoutMs = GATEWAY_FETCH_TIMEOUT_MS] = typeof args[0] === "string"
    ? [args[0], args[1] as RunBranchAsyncExec | undefined, args[2]]
    : [repoRoot, args[0], args[1] as number | undefined];
  const opts = { encoding: "utf8", cwd, timeout: timeoutMs, killSignal: "SIGKILL" } as const;
  try {
    return (await exec("git", ["ls-remote", "--heads", "origin", "run-*"], opts)).stdout;
  } catch (error) {
    throw new Error(`run-branch listing in ${cwd}: ${String((error as Error)?.message ?? error)}`, { cause: error });
  }
}

/** Render a {@link DaemonSummary} — "what happened, or is happening" — at a glance. */
function renderDaemonSummary(s: DaemonSummary): string {
  return [
    "── daemon summary ────────────────────────────────────────",
    `attempted : ${s.attempted.length ? s.attempted.join(", ") : "(none)"}`,
    `merged    : ${s.merged.length ? s.merged.join(", ") : "(none)"}`,
    `stopped   : ${s.stopReason}${s.stopDetail ? ` — ${s.stopDetail}` : ""}`,
    `idle ticks: ${s.ticks}`,
    `cost      : notional $${s.costUsd.toFixed(4)}`,
    "──────────────────────────────────────────────────────────",
  ].join("\n");
}

export async function daemonCommand(
  rest: string[],
  deps: {
    /** Injectable GitHub-gateway constructor for the merged-status projection. Defaults to the
     *  BATCHED {@link buildBatchedGithub} — one NON-search `gh pr list` per projection, which is
     *  what keeps merge state derivable while GitHub's GraphQL `search()` connection is
     *  throttled. Mirrors {@link drainCommand}'s identical seam so a test can prove which
     *  gateway the daemon derives from without a network round-trip. */
    githubFactory?: (owner: string, repo: string) => GitHub;
    /** Explicit fixture configuration; production keeps the existing config loader. */
    config?: Config;
    /** Injectable self-target repo root. Defaults to this module's real `repoRoot`. A
     *  self-target run with no explicit `--plan` derives its plan path from THIS value
     *  (`resolveDaemonTarget`) and then git-syncs it (`syncPlanOrRefuse`) — a test that
     *  needs to drive that sync's REFUSED/WARNING branches (its own `say` callback,
     *  W1-T143) without a real `git fetch origin` against this repo's actual remote
     *  points it at a local git fixture instead. Production never passes this. */
    repoRoot?: string;
    /** Injectable daemon loop (W1-T160 coverage seam). Defaults to the real {@link runDaemon}.
     *  A test passes a stub that captures the wired `DaemonDeps` and returns immediately, so the
     *  hook-wiring the daemon builds just before its loop (checkRetroTrigger/runRetroTrigger,
     *  self-target only) is exercised without spawning a real, unbounded daemon. Production never
     *  passes this. */
    runDaemon?: typeof runDaemon;
    runTask?: DaemonCommandHost["runTask"];
    readRunChildMode?: () => RunChildMode;
    /** W1-T9089: delivers `run_child.contract_failing`'s escalation; production raises it through `escalate`. */
    runChildContractEscalate?: (escalation: RunChildContractEscalation) => string | null | undefined;
    /** Command seams for the selected-repository PR-action wiring test. Production keeps the
     * established fix/review implementations; tests inject terminal fakes without touching GitHub. */
    fixCommand?: DaemonCommandHost["fixCommand"];
    reviewCommand?: DaemonCommandHost["reviewCommand"];
    /** Injectable sweep-hook builders for composition-root tests. Production keeps both real
     * builders; the seam lets a test observe the immutable reviewer-code provenance handed to
     * the full and light paths without reading this source file as text. */
    buildSweepHook?: DaemonSweepHookBuilder;
    buildSweepLightHook?: DaemonSweepLightHookBuilder;
    /** Composition seam: observe the cache-only triage input without starting a read worker. */
    buildAutoTriageHooks?: DaemonCommandHost["buildAutoTriageDaemonHooks"];
    /** Injectable mutable boot routine. Tests use it to prove an already-held fleet does not
     * enter daemonBoot's sweeps or keychain work. */
    daemonBoot?: typeof daemonBoot;
    /** Optional control readers for command-level wiring tests. Production omits them and reads
     * the canonical local/shared fleet controls below. */
    checkStop?: () => string | undefined;
    checkPause?: () => string | undefined;
    /** Injectable W1-T2568 wake wiring and signal re-raise for deterministic shutdown coverage.
     * Production keeps the real filesystem watcher and `process.kill`; tests can observe that
     * the watcher closes before the daemon re-raises SIGINT/SIGTERM without signalling the test
     * runner itself. */
    wireSweepWake?: typeof wireSweepWakeToDaemon;
    startGitCredentialSocket?: typeof startDaemonGitCredentialSocket;
    startReadPlane?: typeof startReadPlane;
    startLoopTelemetry?: typeof startReadPlaneTelemetry;
    startMemoryCensus?: typeof startDaemonMemoryCensus;
    processKill?: (pid: number, signal: NodeJS.Signals) => boolean;
    /** Best-effort boot projection for provider routing; production writes one bounded state file. */
    writeProviderRoutingStatus?: (root: string, input: ProviderRoutingWriteInput) => void;
    bootClaimReserver?: DispatchClaimReserver;
    tickClaimReserver?: DispatchClaimReserverAsync;
    /** Opt-in NEW-build reservation reader; production uses the private-dir environment adapter. */
    checkHeavyNewBuild?: DispatchGovernorDeps["checkHeavyNewBuild"];
    /** Injectable clock for the daily-cost consultation. Production keeps the real clock. */
    now?: () => number;
    /** W1-T5347: injectable `MemAvailable` reading for the wired memory gate — see drainCommand's
     *  identical seam. Production omits it and reads the real `/proc/meminfo`. */
    readAvailableMemoryMib?: () => number;
    readQueuePressure?: typeof productionFixPressure;
    /** W1-T3401: injectable residual escalation judge for `escalateBlock` below (the SAME seam
     *  shape `runFixRung`'s own `opts.escalationJudge` already uses — `opts.escalationJudge ??
     *  realEscalationJudge({...})`). Production omits it and gets the real, cheapest-mount,
     *  no-tools spawn; a test injects a fake so the block-escalation wiring is exercised without
     *  a real worker spawn. */
    escalationJudge?: (e: Escalation) => Promise<EscalationJudgeVerdict>;
    gardenPassesInProcess?: boolean;
    /** W1-T5361 test seam: the garden pass spawn every registered garden runs through, instead of the child. */
    gardenPassSpawn?: GardenPassSpawn;
    /** W1-T5115 test seams: the App refresh whose `ready` gates the git credential socket, and an
     *  in-process mint for that socket. Production omits both: the real refresh, and the socket on
     *  its own thread minting through `mintScopedToken`. */
    startGithubAppRefresh?: typeof startInstallationTokenRefresh;
    gitCredentialMint?: ScopedTokenMint;
    ciJudgeIo?: CiJudgeIo;
    /** The entry's GC tuning (daemon-memory-policy.ts). Production applies it to this process; a test
     *  injects a recorder so the call is observed without retuning the test runner's own V8. */
    applyMemoryPolicy?: typeof applyDaemonMemoryPolicy;
  } = {},
  host: DaemonCommandHost,
): Promise<number> {
  const {
    USAGE,
    auditedLifetimeTalliesFromArchives,
    baseReproductionHostCache,
    boardReviewHooksForTick,
    breakerDetailDep,
    breakerGateFor,
    buildAutoTriageDaemonHooks,
    buildBenchmarkCohortDaemonHooks,
    buildCiLearningDaemonHooks,
    buildCoverageNightlyDaemonHook,
    buildDaemonReadRefresher,
    buildDigestCadenceDaemonHooks,
    buildGithubPostureDaemonHooks,
    buildIntakeRungsDaemonHooks,
    buildLedgerCompactionDaemonHooks,
    buildMeasurementCadenceDaemonHooks,
    buildRetroDaemonHooks,
    buildWipeTestCadenceDaemonHooks,
    costGovernorGateFor,
    createDaemonGatewayFactory,
    createOpenPrCountObservation,
    createPlanSyncCoalescer,
    daemonDefaultBuildSweepHook,
    daemonDefaultBuildSweepLightHook,
    daemonFreshnessReads,
    daemonGardenPassSpawn,
    daemonMemoryTelemetryReader,
    daemonPlanReaders,
    dailyCostCeilingReloader,
    dispatchClaimReserverAsyncFor,
    dispatchClaimReserverFor,
    dispatchFilingCache,
    dispatchFilingPrefetch,
    dispatchValueContextForSelection,
    escalationSpoolDrainWiring,
    fixCommand,
    fleetLaneSamenessJudge,
    fleetRatifyGateway,
    ghLiveStateByNumber,
    headroomPolicyFromCurve,
    inboxRecommendationWriter,
    inboxThreadDecider,
    liveEditLadderWiring,
    loadDaemonPlan,
    logCloneReapSurvey,
    mainRepairLaneFor,
    makeLandingReviewRequest,
    memoiseBoardSnapshotByRepo,
    memoiseGatewayByRepo,
    memoryGovernorGateFor,
    memoryReadTrackerFor,
    onCircuitBreakWithVerifier,
    openSiblingObservation,
    orphanSweepRunActive,
    orphanWorkerKillLedger,
    plainInboxWriter,
    productionLifetimePressureHook,
    quarantineReporter,
    queueGovernorGateFor,
    readMainCeilingVerdictAsync,
    readPushedRunBranchesOutputAsync,
    readUsageSnapshotPreferSdk,
    realDeps,
    registeredGardenDueProbe,
    requeueActionsJobAsync,
    resequenceMergedResolver,
    resolveDaemonTarget,
    resolveReloadPlan,
    reviewCommand,
    reviewerCodeRecoveryFromLoadedModule,
    runInChildWhenOn,
    runInflightLockSweepRung,
    runRegisteredGardenPass,
    runRepositoryMaintenanceRung,
    runTask,
    servedTickRead,
    shardRepairRequester,
    syncPlanOrRefuseAsync,
    unwireOwnCheckoutCredentialHelper,
    writeSyncLine,
  } = host;
  // 2026-10-10: FIRST, BEFORE ANYTHING ALLOCATES. Keep the heap a fixed multiple of what survives each
  // collection instead of letting garbage reach ~4x the live set under the 8 GB ceiling, and take that
  // ceiling out of the NODE_OPTIONS every child inherits. Never fatal: a malformed policy row boots on
  // the defaults and names itself on the daemon.memory_policy row below.
  const memoryPolicyRead = readDaemonMemoryPolicy(policyPath(deps.repoRoot ?? repoRoot));
  const memoryPolicyApplied = (deps.applyMemoryPolicy ?? applyDaemonMemoryPolicy)(memoryPolicyRead.policy);
  // W1-T2697: mark THIS process as the daemon BEFORE anything below can append a ledger row —
  // every `appendLedger` call this process makes (in-process, e.g. a wired sweep tick) from here
  // on reports `actor: "daemon"` rather than the operator-shell default. See
  // `deriveLedgerActor`'s doc (src/lib/ledger.ts) for why a worker this daemon later spawns is
  // still `"worker"` despite inheriting this same env marker.
  markDaemonProcessActor();
  // W1-T7092: subscribe the worker-heaps registry before anything below can spawn a thread, exactly
  // as serve does, so daemon.alive can size every worker isolate by its spawn site.
  workerThreads();

  // FAIL LOUD on junk args BEFORE any spawn/lock — `rmd daemon install --dry-run` silently
  // ran the daemon (draining W1-T15) because `install`/`--dry-run` were ignored. daemon
  // takes only these flags; anything else prints usage and exits non-zero, spawning nothing.
  const badArg = unknownArgError(
    "daemon",
    rest,
    ["--max", "--poll-ms", "--repo", "--plan"],
    ["--dry-run", "--allow-self-target", "--allow-stale"],
  );
  if (badArg) {
    writeSyncLine(2, badArg + "\n" + USAGE);
    return 2;
  }
  const allowStale = rest.includes("--allow-stale");
  const maxIdx = rest.indexOf("--max");
  const pollIdx = rest.indexOf("--poll-ms");
  // W1-T253 (P37 CONSUMERS): pollIntervalMs + the headroom curve read from `plan/policy.yaml`
  // (never `daemon.ts`'s own fs-free literal defaults — see headroomPolicyFromCurve's doc)
  // on every real invocation, so a plan-reviewed policy edit retunes the LIVE daemon with
  // zero code change.
  const policy = loadPolicy(policyPath(repoRoot));
  const opts: DaemonOpts = {
    max: maxIdx >= 0 ? Number(rest[maxIdx + 1]) : undefined,
    pollIntervalMs: pollIdx >= 0 ? Number(rest[pollIdx + 1]) : policy.values.pollIntervalMs,
    headroomPolicy: headroomPolicyFromCurve(policy.values.headroom.curve),
    // W1-T343 (ADOPT drain's EXISTING LANE MACHINERY, SHIP DARK): the SAME SweepPolicy row
    // `drainCommand` already reads for `rmd drain` (ONE threshold home, never a second) —
    // raising either is a policy-data edit (plan/policy.yaml), never a CLI flag or a second
    // constant here. Default 1 keeps this call BYTE-IDENTICAL to before this task — see
    // `DaemonOpts.laneCount`'s own doc for the proof.
    laneCount: DEFAULT_SWEEP_POLICY.dispatchLanes,
    wipLimit: DEFAULT_SWEEP_POLICY.wipLimit,
    // W1-T1044: the wall-clock bound on `await deps.sweep()`. W1-T1219: this row no longer also
    // feeds `buildSweepEffects`'s fix-rung worker-spawn bound — a sweep tick and that spawn are
    // different populations, so each now reads its OWN `plan/policy.yaml` row (see
    // `fixSpawnWallClockBoundMs`'s own doc for why one row could no longer bound both).
    sweepWallClockBoundMs: policy.values.sweepWallClockBoundMs,
  };
  const config = deps.config ?? loadConfig();
  // Headroom governor switch (operator ruling fb-1784894405468-a4153e; default clause
  // reversed 2026-07-25 — the switch now defaults ON, and this host opts OUT explicitly
  // via config `headroom.enabled: false`): resolve the host posture from config/env HERE
  // and pass it explicitly, so the live daemon reads the flag while the library keeps
  // its enforcement default.
  opts.headroomEnabled = resolveHeadroomEnabled(config) && !providerRoutingOwnsHeadroom(config);
  const ledgerPath = ledgerPathFor(config);
  const statusPath = join(config.root, "state", "status.json");
  const self = resolveOwnerRepo();
  const reposDir = join(config.root, "repos");
  // deps.repoRoot's doc (above, W1-T143) explains why this is injectable at all.
  const effectiveRepoRoot = deps.repoRoot ?? repoRoot;
  // W1-T3581: capture the SHA of the source tree that loaded THIS daemon process once. The
  // mutable checkout may advance while the process stays alive, so it cannot prove which review
  // code is executing. This is intentionally the same module-relative source used for the
  // daemon.boot `boot_head_sha` below, and is never refreshed from cwd or HEAD during a sweep.
  // W1-T9333: this module sits two directories deeper than src/run-task.ts did, so the repo root is two more levels up.
  const daemonModuleRepoDir = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const daemonLoadedCodeSha = (() => {
    try {
      return execFileSync("git", ["-C", daemonModuleRepoDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // No git or no checkout here: the loaded code identity is unknown, which the freshness check reads as undefined.
      return undefined;
    }
  })();
  const reviewerCodeRecovery = {
    ...reviewerCodeRecoveryFromLoadedModule(daemonModuleRepoDir, daemonLoadedCodeSha),
    freshTreeReviewAvailable: true,
  };
  const buildSweepHook: DaemonSweepHookBuilder = (...args) => withGoalRemeasurement(
    withCiJudgeAfterSweep((deps.buildSweepHook ?? daemonDefaultBuildSweepHook)(...args), () => target.isSelf ? kickCiJudge?.() : undefined),
    () => remeasureSettledGoals({ repoRoot: target.isSelf ? effectiveRepoRoot : targetCheckoutRoot, stateDir: join(config.root, "state"),
      tasks: activePlanRef.current.tasks, settled: (id) => lastProj?.get(id)?.indeterminate ? undefined : lastProj?.get(id)?.merged,
      log }), log);
  const buildSweepLightHook: DaemonSweepLightHookBuilder = deps.buildSweepLightHook ?? daemonDefaultBuildSweepLightHook;

  // ── REPO TARGETING + self-target GUARD (fix/daemon-repo-targeting). The daemon must know
  // WHICH repo to drain, EXPLICITLY — the old code read the plan from its own checkout and
  // hardcoded the "remudero" gateway, so an unattended run silently drained its own source.
  // --repo/--plan choose the gateway + plan source; W1-T12d targets the sandbox explicitly.
  const resolved = resolveDaemonTarget(
    { selfOwner: self.owner, selfRepo: self.repo, repoRoot: effectiveRepoRoot, reposDir },
    rest,
  );
  if ("error" in resolved) {
    writeSyncLine(2, resolved.error + "\n" + USAGE);
    return 2;
  }
  const target = resolved.target;

  const runId = `DAEMON-${Date.now()}`;
  let lastReadPlaneStep: string | undefined;
  let onMainEntryStep: ((step: string) => void) | undefined;
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lastReadPlaneStep = step;
    appendLedger(ledgerPath, { run_id: runId, task_id: "DAEMON", step, lane: "daemon", ...extra });
    onMainEntryStep?.(step);
  };
  // bundlemain: which entry this main started from (bin/rmd's choice), and a bundled main's first tick settles it.
  onMainEntryStep = startMainEntryWatch({ log, root: daemonModuleRepoDir });
  // W1-T9065: the lane's approve and the responder's reframe run from a tree at origin/main.
  const fleetRatify = fleetRatifyGateway(repoRoot, join(config.root, "state", "logs"), ledgerPath, { stateRoot: config.root });
  const ciJudgeIo = deps.ciJudgeIo ?? (deps.repoRoot === undefined ? {} : undefined);
  const kickCiJudge = ciJudgeIo && singleFlightCiJudge(() => judgeCiEscalation(productionCiJudgePorts({
    owner: self.owner, repo: self.repo, repoRoot: effectiveRepoRoot, stateDir: join(config.root, "state"), log, ...ciJudgeIo,
  })), log);
  log("daemon.memory_policy", {
    ...memoryPolicyApplied,
    tighten_share: memoryPolicyRead.policy.tightenShare,
    restart_share: memoryPolicyRead.policy.restartShare,
    heap_size_limit: getHeapStatistics().heap_size_limit,
    ...(memoryPolicyRead.error ? { policy_error: memoryPolicyRead.error } : {}),
  });
  log("daemon.target", {
    repo: target.repo,
    gateway: `${target.owner}/${target.repo}`,
    instance_mode: instanceMode(`${target.owner}/${target.repo}`, readInstanceRegistryText(repoRoot)),
    plan_path: target.planPath,
    self_host: target.isSelf,
    dry_run: target.dryRun,
  });
  // W1-T143 (DAEMON OBSERVABILITY): name the daemon's canonical paths ALOUD, at boot,
  // before ANYTHING else (including a --dry-run early return) — so the ledger location
  // is provably deterministic (a pure function of config.root, ledgerPathFor) and never
  // folklore (rationale: config.root defaults to os.homedir()/Remudero, the PARENT of the
  // repo checkout, not where an operator instinctively looks). Ledgered (`daemon.paths`)
  // AND printed (writeSyncLine — see its doc for why NOT console.log) so it lands on
  // whichever channel the operator is actually watching.
  const outLogPath = join(config.root, "state", "logs", "daemon.out.log");
  const errLogPath = join(config.root, "state", "logs", "daemon.err.log");
  log("daemon.paths", { ledger_path: ledgerPath, out_log: outLogPath, err_log: errLogPath });
  writeSyncLine(
    1,
    `### rmd daemon — ledger: ${ledgerPath} | stdout: ${outLogPath} | stderr: ${errLogPath}`,
  );

  // W1-T1024 — THE FLEET AUTHENTICATES AS THE INSTALLED GITHUB APP, whose core/graphql pool is
  // measured SEPARATE from an operator's interactive session (github-app.ts's own doc: the
  // incident that files this task was an operator session exhausting graphql while the daemon's
  // own traffic in that window was negligible). Started here, once, in the DAEMON'S OWN PROCESS
  // — process.env only means anything to ITS children, and every existing GH_TOKEN consumer
  // (env.ts's ALLOWLIST at worker spawn, review.ts's per-call spread, deploy/entrypoint.sh's
  // credential helper) already reads it at call/spawn time, so refreshing it here reaches all
  // three with NO call-site change.
  //
  // GATED ON CONFIG PRESENCE so an unconfigured host (the App not installed there yet) is BYTE-
  // IDENTICAL to before this task: zero ledger lines, zero timers, GH_TOKEN's own optional shape
  // preserved exactly. Where it IS configured, `refreshInstallationToken` mints once immediately
  // and this loop reschedules itself off the minted `expires_at` (via `nextRefreshDelayMs`,
  // strictly inside the one-hour life) — or off `REFRESH_MARGIN_MS` when a mint fails, so a
  // transient outage keeps retrying rather than going silent (design iv: degrade, never refuse).
  //
  // THE WORKER GAP IS A KNOWN, ACCEPTED LIMIT (github-app.ts's file header, design iii): a
  // worker's own GH_TOKEN copy is captured at spawn and held for its whole run, so a run
  // outliving the token's one-hour life can still hit the failure it always could — closing that
  // needs a change to worker.ts or git-push.ts, neither of which is in this task's declared
  // files. This refresher fixes the DAEMON's own calls and every FRESHLY-spawned worker; it does
  // not retrofit an already-running one.

  // W1-T2554 — AWAIT THE FIRST MINT BEFORE THE FIRST BOARD READ. `startInstallationTokenRefresh`
  // used to end on a bare, unawaited `tick()`, so `GH_TOKEN` was written on its own schedule while
  // this function fell straight through into the first sweep's `gh api` calls — MEASURED landing
  // the mint 1.899s AFTER the first board fetch had already failed `auth`. `ready` is present only
  // when `armed` (a plain-`GH_TOKEN` host with no `GH_APP_*` names has nothing to wait for) and
  // NEVER rejects (github-app.ts's own doc on `ready`), so this await can only delay the first
  // sweep by the mint's own latency — it can never hang the daemon or surface a throw here.
  const githubAppRefresh = (deps.startGithubAppRefresh ?? startInstallationTokenRefresh)({ log, refresh: refreshInstallationToken });
  if (githubAppRefresh.ready) {
    await githubAppRefresh.ready;
  }

  // Read the plan to schedule. For a NON-self target without an explicit --plan, read it from a
  // clone of the target repo (the daemon clones it for execution anyway), SYNCED to the latest
  // default branch so the scheduled plan is current — a stale clone would drain an old plan.
  let plan: Plan;
  const raiseDuplicate = (e: Escalation): string =>
    escalate({ ...e, runId }, { issues: ghIssueGateway(target.owner, target.repo), ledgerPath, runId });
  const requestShardRepair = shardRepairRequester(join(config.root, "state"), log);
  const reportPlanQuarantine = quarantineReporter(log, raiseDuplicate, requestShardRepair);
  const planReaders = daemonPlanReaders(target.planPath, reportPlanQuarantine);
  const gardenContext: GardenBuildContext = { config, repoRoot: effectiveRepoRoot, owner: self.owner, repo: self.repo, log, raiseDuplicate, pollIntervalMs: opts.pollIntervalMs, codeSha: daemonLoadedCodeSha };
  const injectedPassSpawn: GardenPassSpawn | undefined = deps.gardenPassSpawn
    ?? (deps.gardenPassesInProcess ? (name, args, signal) => runRegisteredGardenPass(name, args, gardenContext, signal) : undefined);
  const gardenPassSpawn = daemonGardenPassSpawn(log, injectedPassSpawn);
  const gardenerRuntime = createGardenerRuntimeWriter({ stateDir: join(config.root, "state"), repository: `${target.owner}/${target.repo}`,
    daemonRunId: runId, codeSha: daemonLoadedCodeSha, log,
    gardens: REGISTERED_GARDEN_NAMES.map((name) => ({ name, enabled: registeredGardenEnabled(name, target.isSelf),
      cadenceMs: Math.max(gardenSchedule(name).intervalFor(opts.pollIntervalMs ?? 60_000), gardenSchedule(name).minIntervalMs),
      scope: name === "host-resource" ? "host" : name === "overseer" ? "fleet" : "repository" })) });
  const offLoopGarden = (name: RegisteredGardenName) => (intervalMs: number) =>
    registeredGardenEnabled(name, target.isSelf)
      ? startGardenOffLoop(name, intervalMs, { spawnPass: gardenPassSpawn, log, observe: (event) => gardenerRuntime.record(event), ...(injectedPassSpawn ? {} : { due: registeredGardenDueProbe(name, gardenContext) }) })
      : { stop() {} };
  if (!target.isSelf && !flagValue(rest, "--plan")) {
    const repoDir = join(reposDir, target.repo);
    if (!existsSync(repoDir)) {
      mkdirSync(dirname(repoDir), { recursive: true });
      ghExec(["repo", "clone", `${target.owner}/${target.repo}`, repoDir], { stdio: "inherit" });
    } else {
      execFileSync("git", ["-C", repoDir, "fetch", "--quiet", "origin"], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "reset", "--hard", "--quiet", "origin/main"], { stdio: "pipe" });
    }
    plan = loadDaemonPlan(target.planPath, log, raiseDuplicate);
  } else if (target.isSelf && !flagValue(rest, "--plan")) {
    // ── GIT SELF-SYNC (W1-T60): self-hosting must not read the daemon's own working tree
    // either — same fail-closed gate as run-task/drain (see syncPlanOrRefuse).
    const synced = await syncPlanOrRefuseAsync(target.planPath, {
      allowStale,
      log,
      say: (msg: string) => writeSyncLine(2, `### rmd daemon — ${msg}`),
      quarantine: reportPlanQuarantine,
      planSnapshot: planReaders.boot,
    });
    if ("error" in synced) return 1;
    plan = synced.plan;
  } else {
    // An explicit --plan overrides the derived path — read it literally, no git sync.
    plan = loadDaemonPlan(target.planPath, log, raiseDuplicate);
  }

  // `lastProj` also backs `isOpenPr` (W1-T80, the in-flight dispatch-dedup
  // guard) — the SAME projection `refreshMerged` just derived, never a second
  // GitHub read path.
  let lastProj: Map<string, StatusProjection> | undefined;
  let tickReadGeneration: ReadGeneration<TickReadFacts> | undefined;
  const boardSnapshotFor = memoiseBoardSnapshotByRepo(config.root, log);
  const targetCheckoutRoot = daemonTargetCheckoutRoot(target, config.root);
  const targetRecordWrite = writeDaemonTargetRecord(join(config.root, "state"),
    { owner: target.owner, repo: target.repo, isSelf: target.isSelf, checkoutRoot: targetCheckoutRoot });
  if (!targetRecordWrite.written) log("daemon.target_record_failed", { reason: targetRecordWrite.reason });
  const targetCommitTrailerIndex = () =>
    buildCommitTrailerIndex({ slug: `${target.owner}/${target.repo}`, cwd: targetCheckoutRoot })();
  const gatewayFor = createDaemonGatewayFactory(config.root, log, {
    snapshotFor: boardSnapshotFor,
    trailerIndexFor: (o: string, r: string) => (o === target.owner && r === target.repo ? targetCommitTrailerIndex : undefined),
  });
  const githubFactory = deps.githubFactory ?? gatewayFor;

  // W1-T2509 — ONE GATEWAY PER owner/repo FOR THE WHOLE DAEMON, handed to every dispatch lane.
  // STILL SEPARATE FROM `githubFactory` ABOVE, but no longer because the projection gateway is
  // short-lived: R-24 hoisted that one too (`projectionGithub`, below), so both now live for the
  // whole lifetime. What remains separate is the RESET — the projection gateway drops its failure
  // verdicts at the top of every tick, the LANE gateway never does, because the lanes of ONE tick
  // are admitted together and should answer from ONE snapshot. Keyed per owner/repo, so a task
  // carrying a different `repo:` is never answered by the target's gateway.
  //
  // KEYED ON owner/repo, NOT ON THE DRAIN TARGET: a task carrying a different `repo:` than the
  // drain's must never be answered by the target's gateway. Staleness is bounded by
  // `buildBatchedGithub`'s own `ttlMs` (15 s default, far under `pollIntervalMs`), so a warm
  // gateway still refetches every poll — warming changes a fetch's SHAPE, never whether one
  // happens (`buildInboxDraftHook`'s doc makes the identical argument, with measurements).
  const laneGithubFor = memoiseGatewayByRepo((o: string, r: string) => (deps.githubFactory ? deps.githubFactory(o, r) : gatewayFor(o, r)));
  const targetRepositoryFor = nativeTargetRepositoryResolver(config.root, laneGithubFor);
  // W1-T9647/W1-T9763: the plans held are counted on `daemon.memory`; one revision is one instance there.
  const daemonPlanCopies = createPlanCopyBook({ refs: () => [plan, activePlanRef.current, tickReadGeneration?.facts.plan] });
  const planSyncCoalescer = createPlanSyncCoalescer(target.planPath, observedPlanSync(planReaders.sync, daemonPlanCopies.observe));
  // R-24 (docs/audits/recon-2026-09-05.md) — ONE PROJECTION GATEWAY FOR THE WHOLE DAEMON
  // LIFETIME, built HERE rather than inside `refreshMerged` below. `target.owner`/`target.repo`
  // are resolved ONCE, before this line (`resolveDaemonTarget`, `const target`), and no path
  // reassigns either for the life of the process — so there is no repo change for a rebuilt
  // instance to track, and `drainCommand`'s `owner`/`repo` are `const` for the same reason.
  //
  // THE DEFECT. `buildBatchedGithub` holds `knownBoardPrs` — the row cache `fetchBoardPrsRest`'s
  // early stop compares against — at GATEWAY scope. Invoking the factory INSIDE `refreshMerged`
  // therefore handed every tick a gateway with an empty cache, so `projectPlan` →
  // `listMergedHeadBranches` → `index` → `mergedRows` → the closed half walked the repo COLD every
  // tick: the code's own 2026-08-26 measurement is 25 requests / 21.8 s at 2,400 PRs, and this
  // repo has passed 4,080. The REST `sort=updated&direction=desc` early stop can only pay off on
  // an instance that outlives one tick. It is the same fix `memoiseGatewayByRepo` (above) already
  // applied to the LANE gateway, applied to the one consumer that reads on every tick.
  //
  // AND WHY THE OLD PER-TICK INSTANCE IS NOT SIMPLY LOST. It bought exactly one property: a
  // gateway closes over mutable failure verdicts, and a hoisted instance would let one tick's
  // outage mark every later tick indeterminate. `resetFailureFlags()` (called at the top of
  // `refreshMerged`, below) buys that property directly and per tick, without discarding the
  // delta cache alongside it — see that method's own doc for why a failed half's EMPTY rows are
  // dropped WITH its verdict rather than left behind under a healthy label.
  const activePlanRef: { current: Plan } = { current: plan };
  const projectionGithub = githubFactory(target.owner, target.repo);
  const boardOpenPrCount = createOpenPrCountObservation();
  const refreshMerged: (planOverride?: Plan) => MergedSet = (planOverride = activePlanRef.current) => {
    if (freshReadGeneration(tickReadGeneration, { consumer: "refresh_merged", log })) {
      const projection = lastProj;
      return (id) => projection?.get(id)?.merged ?? false;
    }
    // R-24: called once per tick, because `refreshMerged` is called once per tick — `runDaemon`'s
    // loop body opens with `deps.refreshMerged()` (lib/daemon.ts) exactly as `runDrain`'s two do.
    projectionGithub.resetFailureFlags?.();
    boardOpenPrCount.reset();
    const proj = projectPlan(
      planOverride,
      { ledgerPath, github: projectionGithub, observeOpenPrCount: boardOpenPrCount.observe, skipUncreditedBuildWarning: true },
      statusPath,
    );
    lastProj = proj;
    return (id: string) => proj.get(id)?.merged ?? false;
  };
  const isOpenPr: OpenPrCheck = (id) => {
    const p = lastProj?.get(id);
    return p?.prState === "OPEN" ? p.prNumber : undefined;
  };
  // W1-T2675: the credit-read-failed probe, off the SAME `lastProj` snapshot `isOpenPr` reads and
  // `refreshMerged` just built — never a second GitHub read path. `merged: false` alone cannot tell
  // "no credit exists" from "the credit read failed"; `indeterminate` is the field that can, and
  // `StatusProjection`'s own doc requires a dispatch gate to treat it as DO NOT ACT.
  const isCreditIndeterminate = (id: string): boolean => lastProj?.get(id)?.indeterminate === true;
  const isIndependentFailureBlocked = (id: string): boolean =>
    lastProj?.get(id)?.independentFailureBlocked === true;
  // W1-T2397: the SAME observation drainCommand builds, on the lane that carries the dispatches —
  // `daemon.boot` 347 and `run.start` 558 against `drain.start` 16, and the motivating instance
  // (W1-T2387 dispatched while #3102 was open, producing #3109) came through HERE. Reads
  // `lastProj`, the same projection `isOpenPr` just above and `openPrCount` just below read, so it
  // adds no fetch of its own.
  const { openSiblingBuildFor, onOpenSiblingBuild } = openSiblingObservation("daemon", () => lastProj, log);
  // W1-T3144: identical to drainCommand — complete board depth from the projection's existing
  // batch read, with the old projection count retained only for gateways that omit that method.
  // W1-T4465 design (i): the SAME batch, split by fleet ownership — never a second GitHub read.
  const openPrOwnership = () => {
    const own = boardOpenPrCount.readOwnership(() => {
      let projected = 0;
      for (const p of lastProj?.values() ?? []) if (p.prState === "OPEN") projected++;
      return projected;
    });
    if (!target.isSelf) return own;
    const jobs = fileTargetJobStore(config.root).readAll();
    let owned = own.owned;
    let foreign = own.foreign;
    for (const managed of loadManagedRepos(effectiveRepoRoot)) {
      if (managed.repo.toLowerCase() === target.repo.toLowerCase()) continue;
      const admission = nativeTargetAdmission(managed.repo, { repoRoot: effectiveRepoRoot });
      if (admission.state === "unreadable") throw new Error("managed target ownership unreadable");
      if (admission.state !== "native") continue;
      // A new board snapshot sees a PR just handed off, even while the lane gateway's cache is warm.
      const github = githubFactory(managed.owner, managed.repo);
      const rows = github.listOpenHeadBranches?.();
      if (!rows) throw new Error(`target WIP unreadable: ${managed.owner}/${managed.repo}`);
      const observation = createOpenPrCountObservation();
      observation.observe(rows);
      const counts = observation.readOwnership(() => 0);
      owned += counts.owned;
      foreign += counts.foreign;
      for (const job of jobs) {
        if (job.status !== "admitted" || job.repo.toLowerCase() !== managed.repo.toLowerCase()) continue;
        if (rows.some((pr: PrRef) => taskIdFromRunBranch(pr.headRefName ?? "") === job.taskId)) continue;
        const execution = readTargetExecution(join(config.root, "state"), { taskId: job.taskId, origin: job.origin, repo: job.repo,
          requestedAt: fixedClock(Date.parse(job.updatedAt) - 60_000).iso(), nowMs: (deps.now ?? Date.now)(), runId: job.runId });
        if (execution.state !== "ended") owned++;
      }
    }
    // Target PR numbers have their own namespace; Core's adaptive flow must retain only Core's numbers.
    return { ...own, owned, foreign };
  };
  const openPrCount = () => openPrOwnership().owned;
  // W1-T11026: the focus gardener judges every new-task consultation and holds it while the stuck stack is deep.
  const queueGate = focusGateFor(queueGovernorGateFor(openPrOwnership, ledgerPath, runId, undefined, deps.now, deps.readQueuePressure),
    { stateDir: dirname(ledgerPath), log, clock: clockFromMillisFn(deps.now) });
  // DRY-RUN: preview the resolved target + planned sequence, spawn NOTHING, take NO lock.
  if (target.dryRun) {
    // W1-T253: drain.max from the SAME loaded policy `opts` above already threaded, never
    // drain.ts's own fs-free literal default.
    const seq = plannedSequence(plan, refreshMerged(), { max: opts.max ?? policy.values.drain.max });
    writeSyncLine(1, `### rmd daemon --dry-run — target ${target.owner}/${target.repo} · plan ${target.planPath}`);
    writeSyncLine(1, seq.length ? seq.map((id, i) => `  ${i + 1}. ${id}`).join("\n") : "  (nothing runnable now)");
    if (target.isSelf) writeSyncLine(2, "  ⚠️ SELF-HOSTING target — the daemon's own source repo.");
    return 0;
  }

  // W1-T414: ONE batched read for this whole `rmd daemon` invocation — see drainCommand's
  // identical wiring/doc just above. Resolved AFTER the `--dry-run` early return above (never
  // before it — a preview must spawn/read nothing beyond `refreshMerged`'s own projection), and
  // once at boot, like `breakerGateFor`'s own cache immediately below, rather than re-fetched
  // per tick.
  // W1-T2318: DEFERRED, NOT REMOVED. `listOpenHeadBranches()` is a full board walk — MEASURED at
  // 26 sequential REST calls and 22.2s, of which the single open page its consumers actually read
  // took 432ms — and computing it HERE put all of it on the boot critical path, synchronously,
  // before anything needed the result. The closed half of that walk is still built, still shared,
  // and still correct for `findMergedByTrailer`/`findMergedByTrailerAll`/`findMergedByHeadBranch`
  // (W1-T377's design, deliberately untouched); it is simply no longer this caller's boot cost.
  //
  // MEMOISED HERE TOO, not just inside `breakerGateFor`, because `isFeedbackOpenPr` below reads the
  // SAME list and must not trigger a second walk.
  let openHeadBranchesMemo: ReadonlyArray<PrRef> | null | undefined;
  let openHeadBranchesRead = false;
  const openHeadBranchesForBreaker = (): ReadonlyArray<PrRef> | null | undefined => {
    if (!openHeadBranchesRead) {
      // R-24: the SAME instance `refreshMerged` reads, never a second gateway — see the identical
      // line in `drainCommand`.
      openHeadBranchesMemo = projectionGithub.listOpenHeadBranches?.();
      openHeadBranchesRead = true;
    }
    return openHeadBranchesMemo;
  };
  // W1-T3758: one bounded archive scan before the daemon starts dispatching. The live ledger is
  // still read at each gate consultation; unread history retains the old live-only behaviour.
  const archivedLifetime = await auditedLifetimeTalliesFromArchives(dirname(ledgerPath), undefined,
    (failure: LifetimeIndexFailure) => log("dispatch.lifetime_history_unavailable", { ...failure, phase: "index" }));
  try {
  if (archivedLifetime.history === undefined) {
    log("dispatch.lifetime_history_unavailable", {
      archive_count: archivedLifetime.archiveCount,
      unread_archives: archivedLifetime.unread,
      reason: archivedLifetime.unavailableReason,
      ...(archivedLifetime.indexError === undefined ? {} : { detail: archivedLifetime.indexError }),
    });
  } else {
    log("dispatch.lifetime_history_loaded", {
      archive_count: archivedLifetime.archiveCount,
      records: archivedLifetime.records,
    });
  }
  // W1-T206: see breakerGateFor's doc — ONE cache for this whole `rmd daemon` invocation.
  const breakerGate = breakerGateFor(ledgerPath, openHeadBranchesForBreaker, archivedLifetime.history);
  // W1-T119: same freshness contract as `isOpenPr` — the SAME projection
  // `refreshMerged` just derived, never a second GitHub read path. W1-T206: ALSO
  // indeterminate when the ledger's dispatch-breaker read for this task cannot be
  // trusted (absent/rotated ledger reading as fewer dispatches than a live process
  // already knows about) — nextRunnable already skips-and-retries on indeterminate
  // rather than escalating, exactly the behavior a torn read needs here too.
  const isIndeterminate = (id: string) =>
    lastProj?.get(id)?.indeterminate === true || breakerGate.isIndeterminate(id);

  if (target.isSelf) {
    writeSyncLine(
      2,
      `### rmd daemon — SELF-HOSTING: draining the daemon's own source repo '${target.repo}' (--allow-self-target).`,
    );
  }

  // SINGLE-INSTANCE GUARD, shared with `rmd drain` (same lock file/docs/archive/DIAGNOSIS.md
  // diag/drain-concurrency): refuse to start a daemon while a drain (or another
  // daemon) already holds it; reclaim a stale (dead-pid) lock.
  const drainLockPath = join(config.root, "state", "drain.lock");
  let drainLock;
  try {
    drainLock = acquireDrainLock(drainLockPath);
  } catch (e) {
    if (e instanceof DrainLockError) {
      writeSyncLine(
        2,
        `### rmd daemon REFUSED — a drain/daemon is already running ` +
          `(pid ${e.holder.pid} on ${e.holder.host}, started ${e.holder.startedAt}).\n` +
          `If that process is dead, remove ${drainLockPath} and retry.`,
      );
      return 1;
    }
    throw e;
  }
  // Register each release only after acquisition; boot and the loop share this finally.
  const cleanup: Array<{ resource: string; close: () => void | Promise<void> }> = [
    { resource: "drain_lock", close: () => drainLock.release() },
    { resource: "stop_marker", close: () => { consumeStop(config.root); } },
  ];
  try {
  const bootClaimLock = fixedClock(clockFromMillisFn(deps.now).now());
  const landedClaimRerunReported = new Set<string>();
  try {
    // W1-T10896: the sweep also judges this host's own pre-restart claims and ends the runs they held.
    bootSweepDispatchClaims(deps.bootClaimReserver ?? dispatchClaimReserverFor(join(config.root, "repos", target.repo)), {
      localHost: hostname(),
      lockHeldSinceMs: bootClaimLock.now(),
      lockHeldSinceIso: bootClaimLock.iso(),
      stateDir: dirname(ledgerPath),
      log,
    });
  } catch (error) {
    log("dispatch.claim_sweep_failed", { surface: "boot-sweep", error: String((error as Error)?.message ?? error).slice(0, 300) });
  }
  // Publish only after this process owns the shared daemon/drain lock. Dry-run returned above,
  // and a refused second daemon returned from the catch, so neither can replace material state.
  // This is telemetry only: disk failure must not change whether the daemon starts.
  const bootProviderRoutingPolicy = resolveProviderRoutingPolicy(config.root, config);
  if (bootProviderRoutingPolicy.fallback) {
    log("daemon.provider_routing_policy_fallback", { reason: bootProviderRoutingPolicy.fallback.reason });
  }
  try {
    (deps.writeProviderRoutingStatus ?? writeProviderRoutingStatus)(config.root, {
      state: "not-probed",
      enabledProviders: bootProviderRoutingPolicy.routableProviders,
      reservePercent: bootProviderRoutingPolicy.reservePercent,
      observedAtMs: Date.now(),
      cacheValidMs: config.workerProviders?.capacityCacheMs ?? 60_000,
      policy: bootProviderRoutingPolicy,
    });
  } catch {
    log("daemon.provider_routing_status_write_failed", { reason: "write-failed" });
  }
  // W1-T2787: ONE observer closure is shared by the ordinary full sweep and the daemon-side
  // settled-check callback below. Its brief cache uses the SAME committed settle window, so an
  // event observation followed immediately by the awakened full sweep spends one GitHub read,
  // not two. Serve still only writes the signed marker and never receives this callback.
  const mainHealthRung = buildMainHealthRung(target.owner, target.repo, {
    fetch: (args) => ghJsonAsync(args),
    issues: ghIssueGatewayAsync(target.owner, target.repo),
    ledgerPath,
    runId,
    log,
    freshMs: policy.values.githubEventWake.checkSettleMs,
    readCiFailures: (rollup) => fetchCiFailuresAsync(target.owner, target.repo, [...(rollup ?? [])]),
    requeueCheck: (failure) => requeueActionsJobAsync(target.owner, target.repo, failure, log),
    // An attempt at a red that ended without a fix asks this judge for another; the dedupe is the red.
    judgeRepairProgress: productionFixProgressJudge({ cwd: effectiveRepoRoot, settingsFile: join(effectiveRepoRoot, "settings", "worker.json") }),
    // W1-T4056: judge only the checks that gate a merge. A scheduled monitor attaches its run to main's
    // head too, and judging it filed 65 of 83 "main is red" issues; a red one is now ledgered as
    // `advisory_failing_checks`. [] on any unreadable contract keeps "judge every check", never green.
    readRequiredChecks: () => readCiGateRequiredChecks(targetCheckoutRoot),
    // W1-T6403: a located red is repaired through a priority fix PR, then a revert PR, never a push.
    repair: mainRepairLaneFor(target.owner, target.repo, config, ledgerPath, runId),
    // A red that is only a ratified ceiling is read from the failing shard's own log, then recorded.
    readCeilingVerdict: (check) => readMainCeilingVerdictAsync(target.owner, target.repo, check),
    // W1-T9665: which failing tests each merge since green reaches, over this checkout's import graph.
    readAffectedInput: (changed) => readAffectedSuitesInputAsync(targetCheckoutRoot, changed),
  });
  // W1-T2568 — THE GITHUB-EVENT WAKE'S ENTIRE DAEMON-SIDE WIRING. `wireSweepWakeToDaemon`
  // (lib/github-event-wake.ts) consumes any boot-pending marker, arms an `fs.watch` on the
  // shared state directory `remudero-serve`'s `POST /v1/hooks/github` route also writes into,
  // and returns a drop-in replacement for `DaemonDeps.sleep` that resolves early on a wake —
  // every idle wait in `runDaemon`'s loop (STOP/PAUSE, "nothing runnable", backoff) already
  // funnels through that ONE dependency, so this is the entire interrupt: zero changes to
  // lib/daemon.ts, which stays fs-free. `.close()` MUST run on every exit path (design v: "the
  // watcher is closed on daemon shutdown and cannot keep the process alive after normal stop")
  // — wired into `onSignal` immediately below AND the ordinary `finally`, mirroring exactly how
  // `drainLock.release()`/`consumeStop` are already wired into both.
  const githubEventWake = (deps.wireSweepWake ?? wireSweepWakeToDaemon)(config.root, log, undefined, {
    checkSettleMs: policy.values.githubEventWake.checkSettleMs,
    // W1-T2787: the callback fires when the daemon-side check/status burst settles, even when an
    // older full sweep is still executing and the resulting wake is refused by its liveness gate.
    onCheckBurstSettled: () => void mainHealthRung(),
  });
  cleanup.push({ resource: "github_event_wake", close: () => githubEventWake.close() });
  const processKill = deps.processKill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const onSignal = (sig: NodeJS.Signals) => {
    archivedLifetime.history?.close?.();
    githubEventWake.close();
    consumeStop(config.root); // one-shot STOP: consumed on the daemon's terminal (see drainCommand)
    drainLock.release();
    processKill(process.pid, sig); // re-raise with the default handler now cleared
  };
  process.once("SIGINT", onSignal);
  cleanup.push({ resource: "sigint_listener", close: () => { process.removeListener("SIGINT", onSignal); } });
  process.once("SIGTERM", onSignal);
  cleanup.push({ resource: "sigterm_listener", close: () => { process.removeListener("SIGTERM", onSignal); } });

  log("daemon.start", {
    max: opts.max ?? null,
    poll_interval_ms: opts.pollIntervalMs,
    lock_pid: drainLock.info.pid,
    repo: target.repo,
    // Ruling fb-1784894405468-a4153e: the resolved governor posture, legible each boot.
    headroom_enabled: opts.headroomEnabled,
  });
  // The contract census precedes adoption and boot sweeps; an unreadable corpus is reported, never counted as empty.
  try {
    log("run_child.boot_census", { ...censusRunDirs(join(config.root, "state")) });
  } catch (censusError) {
    log("run_child.boot_census_failed", { error: String((censusError as Error)?.message ?? censusError).slice(0, 240) });
  }
  // W1-T9087: under `auto` the mode is decided from the ledger's own evidence since the previous boot, fed every run-child
  // row this daemon writes since (`childLog`); it keeps counts. W1-T9816: that window and the settlements are one UNION read,
  // because rotation prunes them from the live file. Read here, before adoption, so the boot's adoption pass is folded once.
  const bootLedgerLines = readLedgerLines(ledgerPath);
  const childPolicy = deps.readRunChildMode ?? (() => loadRunChildMode());
  const bootChildPolicy = readRunChildPolicy(childPolicy);
  // `auto` adopts whatever it decides: a child an earlier `on` started outlives a demotion and must still be adopted.
  const childMode = bootChildPolicy.mode === "on" || bootChildPolicy.mode === "auto";
  const childBoot = childMode
    ? bootRunChildMode({ stateDir: dirname(ledgerPath), auto: bootChildPolicy.mode === "auto", liveRows: bootLedgerLines, log }) : undefined;
  const childModeTracker = childBoot?.tracker ?? createRunChildModeTracker(bootLedgerLines);
  const childLog = (step: string, extra: Record<string, unknown> = {}): void => {
    log(step, extra);
    childModeTracker.observe(step, extra);
  };
  const adoptedRunIds = new Set<string>();
  const adoptedChildren: AdoptedRunChild[] = childBoot ? adoptRunChildren({
    stateRoot: join(config.root, "state"), instance: defaultInstance(config.root).name, log: childLog,
    settledRunIds: childBoot.settledRunIds,
  }) : [];
  for (const child of adoptedChildren) {
    adoptedRunIds.add(child.runId);
    void child.settled.then(() => adoptedRunIds.delete(child.runId), () => adoptedRunIds.delete(child.runId));
  }
  // W1-T9089: a failing contract under `on` no longer demotes; it escalates once per evidence window.
  const childContract: (decision: RunChildModeDecision | undefined) => boolean =
    host.daemonRunChildContract(deps.runChildContractEscalate ?? raiseDuplicate, log);
  // Once per boot, after the adoption pass the decision reads: `auto` ledgers what it decided and why.
  if (bootChildPolicy.mode === "auto") {
    const bootDecision = runChildModeFor("auto", childModeTracker.evidence()).decision;
    childModeTracker.record(bootDecision, log, true);
    childContract(bootDecision);
  }
  // W1-T215 crash-loop input, snapshotted EAGERLY — before daemonBoot writes this boot's own
  // `daemon.boot` line — so the check's `priorBoots` contract (prior boots ONLY) holds even
  // though the closure is invoked after that write. See the crashLoopCheck argument below.
  const priorDaemonBootTs = bootLedgerLines
    .filter((l) => l.step === "daemon.boot")
    .map((l) => String(l.ts ?? ""))
    .filter(Boolean)
    .slice(-200);
  // W1-T117/W1-T356: the orphan sweep, composed from the module's OWN exported defaults
  // (design part i/ii) — ONE shared closure wired into BOTH daemonBoot's boot-time param
  // (below) and DaemonDeps.sweepOrphans (the per-poll half, at the deps literal further
  // down), so both halves run the identical attribution/kill/ledger logic rather than two
  // independently drifting copies. `isRunActive` is `orphanSweepRunActive` (W1-T5998): a lock
  // alone missed this daemon's lockless reviews and its fix workers. Each kill's own
  // `worker_orphan_killed` ledger line carries the ORPHAN's run_id/task_id (never this
  // daemon's own runId), matching `sweepOrphanWorkers`'s `ledger` dep contract.
  const inflightDir = join(config.root, "state", "inflight");
  const orphanWorkerScope = workerInstallationScope(config.root);
  const sweepOrphans = () =>
    sweepOrphanWorkers({
      expectedScope: orphanWorkerScope,
      listCandidates: defaultListCandidates,
      readMarkers: defaultReadMarkers,
      isRunActive: orphanSweepRunActive(runId, inflightDir, undefined, adoptedRunIds),
      kill: (pid) => killProcessGroup(pid),
      ledger: orphanWorkerKillLedger(ledgerPath),
    });
  // W1-T530: the feedback-landing sweep, ONE shared option set wired into BOTH daemonBoot's
  // boot-time param (below) and DaemonDeps.sweepFeedbackLanding (the per-poll half, at the deps
  // literal further down) — mirrors `sweepOrphans` immediately above in shape. `repoRoot` (not
  // `config.root`/`target.repo`'s drained checkout) is the SAME root `captureFeedback`'s CLI
  // entry point already lands from (line ~16396): `plan/feedback/` is this harness's own inbox.
  // Only the self-target daemon owns that inbox. A non-self daemon must not push a branch from
  // this checkout and ask GitHub to create its PR in the unrelated drained repository.
  // W1-T1000002: `ledgerLines` lets this rung's ONE arm-origin (`ensurePrOpen`, feedback-landing.ts)
  // honour a standing operator hold — the SAME `ledgerPath` this daemon boot already reads
  // everywhere else in this function, never a second path construction.
  // W1-T3990: opening/reusing a landing PR is also a durable review handoff. The callback starts
  // the SAME review command the board sweep uses, so the first landing cannot sit green-but-
  // unreviewed waiting for a human. `reviewCommand` owns its pending-post idempotency and exact
  // head checks; a failed promise is logged and the landing remains open for the next pass.
  // W1-T3995: extracted into `makeLandingReviewRequest` (parse/dispatch/log, no daemon-boot
  // state) so the retry/ordering behaviour above is unit-testable without booting the daemon.
  const requestLandingReview: LandingReviewRequest = makeLandingReviewRequest(
    log,
    reviewCommand,
    `${target.owner}/${target.repo}`,
  );
  // W1-T5620: the per-poll rung awaits its plan-PR preflight off the loop; W1-T9695: so does the boot pass.
  const feedbackLandingRungs = target.isSelf
    ? feedbackLandingSweepRungs(repoRoot, {
        log,
        ...(config.contributorAdmission === undefined ? {} : { publication: { mode: "shadow" as const, record: log } }),
        ledgerLines: () => readLedgerLines(ledgerPath),
        requestReview: requestLandingReview,
        // W1-T5460: drain the console decisions `rmd serve` queued under the same state root.
        stateRoot: config.root,
      })
    : undefined;
  const sweepFeedbackLandingRung = feedbackLandingRungs?.perPoll;
  // ANTHROPIC-clean-env boot assertion (W1-T12b): checked once, before the loop
  // starts, over the daemon process's OWN live env — belt-and-suspenders atop
  // the launchd unit's own closed EnvironmentVariables allowlist (lib/launchd.ts).
  // Also runs the W1-T115 boot sweep of stale rmd-owned temp dirs (the
  // 26,711-dir ENOSPC incident's backstop) and logs the count via daemon.tmp_sweep.
  const checkStop = deps.checkStop ?? (() => stopDetail(config.root));
  // `runDaemon` is a test-only loop seam. Its fixtures must not inherit the live shared hold a
  // production daemon is deliberately required to honour; injected `checkPause` still takes precedence.
  const checkPause = deps.checkPause ?? (deps.runDaemon ? () => pauseDetail(config.root) : () => checkSharedPause(config.root, realDeps().sharedPauseGit));
  if (!deps.checkPause && !deps.runDaemon) {
    cleanup.push({ resource: "shared_pause_refresh", close: () => disposeSharedPauseRefresh(realDeps().sharedPauseGit) });
    if (!checkStop()) await prepareSharedPause(config.root, realDeps().sharedPauseGit);
  }
  if (target.isSelf && !deps.runDaemon) unwireOwnCheckoutCredentialHelper(repoRoot, log);
  const invokeDaemonBoot: typeof daemonBoot = (...args) => daemonBoot(...args);
  const bootHold = resolveFleetControlHold({ checkStop, checkPause });
  if (bootHold) {
    log("daemon.boot_held", {
      control: bootHold.control,
      detail: bootHold.detail,
      reason: `fleet ${bootHold.control} hold: ${bootHold.detail}`,
    });
    // W1-T4194: the held loop never sweeps, so a replaced container's dead-holder locks would
    // outlive the hold. Same predicate as daemonBoot's sweep; nothing else runs.
    runInflightLockSweepRung(config, log);
  } else {
    await (deps.daemonBoot ?? invokeDaemonBoot)(
    log,
    process.env,
    () => {
      // STEP 2 backstop: reap SDK worker-scratchpad orphans a crashed orchestrator
      // could not reap at teardown (lib/worker-scratch.ts). Age-ceilinged (24h) so a
      // live session is never collateral; runs in the same clean-env boot as the tmp
      // sweep. Logged separately; returns the tmp summary daemonBoot renders.
      const scratch = sweepStaleWorkerScratch();
      if (scratch.removed.length) {
        log("daemon.scratch_sweep", { removed: scratch.removed.length, sample: scratch.removed.slice(0, 5) });
      }
      // impl-EK boot rung: abandoned REVIEW CLONES (36 measured across the scratch roots on
      // 2026-08-01, 5866 MiB). DRY-RUN UNTIL THE OPERATOR OPTS IN — `scratchReap.enabled` is
      // false by default, so this SURVEYS and ledgers what it would reclaim and deletes
      // nothing. Ownership is decided by CONTENT (a standalone clone of this repo), never a
      // name glob: these roots are shared with another application and other sessions.
      logCloneReapSurvey(config, log);
      // W1-T170 boot sweep: reap per-spawn worker-home dirs (`<root>/worker-home-<id>`)
      // orphaned by a run/spawn that ended without reaching its own reapWorkerHome
      // call (a kill -9, a crashed daemon). Same 24h age ceiling as the scratch/tmp
      // sweeps above — a still-running spawn's home is always recent (materialize
      // touches it on every use) and never collateral.
      const homes = sweepStaleWorkerHomes(workerHomeDir(config), { stateRoot: config.root });
      if (homes.removed.length) {
        log("daemon.worker_home_sweep", { removed: homes.removed.length, sample: homes.removed.slice(0, 5) });
      }
      // W1-T320: the age ceiling is now POLICY DATA (plan/policy.yaml's sweep.tmpMaxAgeMs),
      // read off the SAME repoRoot-scoped `policy` this function already reads
      // pollIntervalMs/the headroom curve from — never a second, independently-resolved read.
      return sweepStaleTempDirs({ maxAgeMs: policy.values.sweep.tmpMaxAgeMs });
    },
    () => sweepInflightLocksWithReceipts(join(config.root, "state", "inflight"), ledgerPath),
    // W1-T235: the boot-time worker-keychain unlock, explicit and ledgered
    // (`daemon.worker_keychain`) — macOS only; elsewhere the rung is absent.
    process.platform === "darwin"
      ? () =>
          ensureWorkerKeychain({
            ...workerKeychainPaths(join(config.root, "state")),
            loginKeychainPath: join(
              process.env.HOME ?? homedir(),
              "Library",
              "Keychains",
              "login.keychain-db",
            ),
            grantApps: [config.claudeBin, "/usr/bin/security"],
          })
      : undefined,
    // W1-T215's boot-rate invariant, WIRED (it shipped 2026-07-22/#590 and sat unasked through
    // the 2026-08-03 ten-boot ENOSPC storm — the exact incident it detects). `priorBoots` is an
    // EAGER pre-boot snapshot, never a lazy read: daemonBoot logs THIS boot's own `daemon.boot`
    // line BEFORE consulting the check, and its contract says priorBoots "must NOT include this
    // boot's own timestamp" (daemonBoot appends it via `now`). Bounded tail per
    // detectDaemonCrashLoop's own doc ("a bounded recent tail, never full history"): 200 boots
    // covers >3h of a one-per-minute storm. `daemon.boot` is DECISION_RELEVANT (W1-T244), so
    // the read survives rotation. Window/now take DEFAULT_CRASHLOOP_WINDOW/wall-clock defaults.
    {
      priorBoots: () => priorDaemonBootTs,
      onBreach: (verdict: CrashLoopVerdict) =>
        escalateCrashLoop(verdict, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
    },
    // W1-T357: wire the SAME resolver/cache spawnWorker uses (worker.ts's
    // resolveClaudeExecutable against its shared, per-process
    // claudeExecutableCache) so daemon.claude_bin logs the exact binary the
    // fleet will actually run at spawn time, never a second, possibly
    // different resolution.
    () => resolveClaudeExecutable(claudeExecutableCache),
    // §9 overflow valve (W1-T258): make the daemon.boot billing_mode canary
    // report `api` iff this daemon deliberately drains on API credits, matching
    // what its workers will actually bill (the key must ALSO be in the env).
    config.overflow === "api_key",
    // W1-T356: the boot-time half of the W1-T117 orphan sweep, wired at last — see the
    // shared `sweepOrphans` closure defined above this call (built from worker-containment.ts's
    // own exported defaults, never a hand-rolled substitute).
    sweepOrphans,
    // THE SHA THIS PROCESS IS ACTUALLY EXECUTING. Resolved from the directory the RUNNING
    // MODULE was loaded from (`import.meta.url`), never from cwd and never re-read later — the
    // deploy supervisor compares this against the checkout's HEAD, and a value read live at
    // comparison time would always match and reproduce the very bug this closes. Best-effort:
    // if git is unavailable the field is omitted and the supervisor fails eager (one extra
    // restart at an idle gap), which is strictly safer than recording a wrong sha.
    daemonLoadedCodeSha,
    // W1-T530: the boot-time half of the feedback-landing sweep, wired at last (appended after
    // `bootHeadSha` per that param's own "no positional caller shifts" discipline) — see the
    // shared `feedbackLandingRungs` defined above this call (its boot form, awaited since W1-T9695).
    feedbackLandingRungs?.atBoot,
    // W1-T991: `undefined` ⇒ daemonBoot's own default (THIS process's real
    // process.execPath/version) — never overridden here, only in tests.
    undefined,
    // W1-T991: the repo's declared node pin (.nvmrc, trimmed), read relative to THIS MODULE —
    // never cwd, same discipline as `defaultBinaryPinDeps` reading deploy/Dockerfile above,
    // since the daemon/CLI/worker all run from different directories and only the module path
    // is stable across them. Best-effort: an unreadable .nvmrc omits the version-pin check
    // rather than throwing (the account/roots check above still runs either way).
    (() => {
      try {
        return readFileSync(fileURLToPath(new URL("../../../.nvmrc", import.meta.url)), "utf8").trim();
      } catch {
        // An unreadable .nvmrc leaves the pinned runtime unknown; the account/roots check above still runs.
        return undefined;
      }
    })(),
    // W1-T2332: the canonical checkout's HISTORY HORIZON, measured HERE — the caller — exactly
    // where `bootHeadSha` above already resolves `git rev-parse HEAD`, over the SAME
    // module-relative directory (never cwd, same reasoning as `bootHeadSha`'s own comment: the
    // daemon/CLI/worker run from different directories and only the module path is stable across
    // them). `readCheckoutDepth` shares its one try/catch with both git reads, so a partial
    // answer omits the fields exactly like a failed one — never a guessed value. A shallow
    // checkout does NOT halt this boot (T197 doctrine, this function's own doctrine for the
    // keychain rung above); `rmd doctor`'s `checkout-depth` arm is where the FAIL verdict lives.
    // Appended LAST, after the node pin, per `daemonBoot`'s own "no positional caller shifts"
    // discipline.
    readCheckoutDepth(daemonModuleRepoDir),
    );
  }

  const runDaemonFn = deps.runDaemon ?? runDaemon;
  const runTaskFn = deps.runTask ?? runTask;
  // W1-T160: the retro cadence hooks (self-target only) — see buildRetroDaemonHooks.
  const retroHooks = target.isSelf ? buildRetroDaemonHooks() : undefined;
  // impl-DM: the auto-triage rung's producer. SELF-TARGET ONLY, for the same reason the retro is —
  // it reads THIS repo's plan/feedback and writes THIS repo's plan, never a drained target's.
  // Without this line `deps.checkAutoTriage` is undefined and the whole rung is dead code, which is
  // exactly how #1066 merged: consumer wired, producer never.
  const autoTriageHooks = target.isSelf ? (deps.buildAutoTriageHooks ?? buildAutoTriageDaemonHooks)({ config, repairSnapshot: () => {
    const generation = freshReadGeneration(tickReadGeneration, { consumer: "auto_triage_repair", log, maxAgeMs: DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS });
    if (!generation || generation.facts.openPrError) {
      log("auto_triage.repair_snapshot_unavailable", {
        reasonCode: tickReadGeneration === undefined ? "unpublished-generation" : !generation ? "stale-generation" : "open-pr-read-error",
        generation: tickReadGeneration?.generation ?? null,
        read_started_at_ms: tickReadGeneration?.publishedAtMs ?? null,
        settled_at_ms: tickReadGeneration?.settledAtMs ?? null,
      });
      return undefined;
    }
    return { owner: target.owner, repo: target.repo, asOfMs: generation.publishedAtMs, prs: generation.facts.openPrViews };
  } }) : undefined;
  // W1-T1040: the GitHub-side posture drift check. SELF-TARGET ONLY, same reason retro/auto-triage
  // are — the baseline (state/github-posture.json) lives under THIS process's `config.root`, never
  // a drained target's, so wiring it for a non-self target would either read the wrong repo's
  // posture into the wrong repo's baseline or silently do nothing useful.
  const githubPostureHooks = target.isSelf ? buildGithubPostureDaemonHooks({ config }) : undefined;
  // W1-T1259: the measurement-cadence rung ("is this system getting better" —
  // rule-efficacy/verdict-calibration/autonomy-rate). SELF-TARGET ONLY, same reason
  // retro/auto-triage/github-posture are — the ledger/state this reads and the git history it
  // joins against both live under THIS process's own config.root/repoRoot, never a drained
  // target's. Without this line `deps.checkMeasurementCadence` is undefined and the whole rung
  // is dead code, exactly how #1066 merged auto-triage's consumer with no producer.
  const measurementCadenceHooks = target.isSelf ? buildMeasurementCadenceDaemonHooks({ config }) : undefined;
  // W1-T5723: the cadence runs in a child that a daemon restart adopts rather than kills.
  const measurementCadenceChild = target.isSelf ? measurementCadenceChildRunner({
    statePath: join(config.root, "state", "measurement-cadence-child.json"),
    spawn: childMeasurementCadenceSpawn({
      entry: fileURLToPath(new URL(`../../measurement-cadence-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url)),
      cwd: repoRoot,
      config,
    }),
  }) : undefined;
  // W1-T2277: the digest's own cadence rung. SELF-TARGET ONLY, same reason as the rungs above —
  // the ledger this reads and the marker/inbox files it writes both live under THIS process's
  // own config.root, never a drained target's. Without this line `deps.checkDigestCadence` is
  // undefined and the whole rung is dead code, exactly how #1066 merged auto-triage's consumer
  // with no producer.
  const digestCadenceHooks = target.isSelf ? buildDigestCadenceDaemonHooks({ config }) : undefined;
  // W1-T3368: the compaction loop is self-target only for the same root-bound reason as every
  // cadence beside it. Its state directory is this daemon's own `config.root/state`; wiring it
  // for a drained repository would compact the fleet ledger while evaluating somebody else's plan.
  const ledgerCompactionHooks = target.isSelf ? buildLedgerCompactionDaemonHooks({ config }) : undefined;
  // Each enrolled daemon owns its local ledger, including site/console target instances.
  const benchmarkCohortHooks = buildBenchmarkCohortDaemonHooks({ config });
  // W1-T2923: one policy-gated cadence over the repository-intake rungs that used to require
  // hand-run verbs. SELF-TARGET ONLY: every runner writes this harness checkout/state.
  const intakeRungHooks = target.isSelf ? buildIntakeRungsDaemonHooks({ config }) : undefined;
  // W1-T2304: the board-review rung. SELF-TARGET ONLY, same reason as the rungs above — the
  // marker, the report artifact and the proposal registry all live under THIS process's own
  // config.root. WITHOUT THIS LINE `deps.checkBoardReview` is undefined and the whole rung is
  // dead code, which is not a hypothetical here: that is precisely what shipped in #2952 and
  // stayed dead for the eight hours between its merge and this fix.
  // W1-T4051: handed THIS tick's projection and plan — the same `lastProj` `isOpenPr` and `openPrCount`
  // read — so the check never derives a second one on a cold gateway (was ~120 s of synchronous `gh`).
  const boardReviewHooks = target.isSelf
    ? boardReviewHooksForTick(config, { projection: () => lastProj, plan: () => activePlanRef.current })
    : undefined;
  boardReviewHooks?.bindCheckItems(() => freshReadGeneration(tickReadGeneration, { consumer: "board_items", log })?.facts.boardItems);
  // W1-T2659: the wipe-test cadence rung. SELF-TARGET ONLY, same reason as measurement-cadence:
  // its marker and ledger live under this harness checkout. The pair itself still targets the
  // sandbox by default through runWipeTestPair/resolveWipeTestTarget.
  const wipeTestCadenceHooks = target.isSelf ? buildWipeTestCadenceDaemonHooks({ config }) : undefined;
  // W1-T2972: the CI-failure learning rung. SELF-TARGET ONLY, same reason as the rungs above — its
  // marker and pull-request window both belong to THIS process's config.root, never a drained
  // target's. WITHOUT THIS LINE the hooks are undefined and the rung is dead code — what W1-T2959
  // shipped, after #1066 and #2952 each shipped it before that.
  const ciLearningHooks = target.isSelf ? buildCiLearningDaemonHooks({ config }) : undefined;
  // W1-T5115: the daemon's ONE git credential socket, started only on an App-configured host and
  // only once the first App mint above has settled. Its path reaches every task worker (`runOne`)
  // and every sweep fix worker (`sweep:`) below; `undefined` leaves both on the ambient helper.
  const gitCredentialSocket = await (deps.startGitCredentialSocket ?? startDaemonGitCredentialSocket)({
    ready: githubAppRefresh.ready,
    stateDir: join(config.root, "state"),
    log,
    mint: deps.gitCredentialMint,
  });
  if (gitCredentialSocket) cleanup.push({ resource: "git_credential_socket", close: () => gitCredentialSocket.close() });
  const readOptions: TickReadOptions = { owner: target.owner, repo: target.repo, config, ledgerPath, checkoutRoot: targetCheckoutRoot };
  let inlineProducer: ReturnType<typeof tickReadProducer> | undefined;
  const readPlane = deps.githubFactory ? undefined : (deps.startReadPlane ?? startReadPlane)({
    // W1-T9722: the worker starts from the narrow tick-read entry (a current bundle when one is vouched for).
    workerUrl: tickReadWorkerUrl(), workerInput: readOptions, log, spawn: () => startTickReadWorker(readOptions),
    inline: (input: TickReadRequest) => (inlineProducer ??= planReaders.inlineTickRead(readOptions, { log }))(input),
  });
  if (readPlane) cleanup.push({ resource: "read_plane", close: () => readPlane.stop() });
  const readTick = readPlane && planReaders.tickRead(readPlane.read);
  const loopTelemetry = (deps.startLoopTelemetry ?? startReadPlaneTelemetry)();
  cleanup.push({ resource: "loop_telemetry", close: () => loopTelemetry.stop() });
  // The daemon's rolling rss+swap samples, kept across rotations and restarts for the memory budget's daemon split.
  const daemonFootprint = createDaemonFootprint(daemonFootprintPath(join(config.root, "state")));
  installDaemonFootprint(daemonFootprint);
  // W1-T8401: before a container-short hold the daemon reclaims its own slack (one tightest-factor collection, paced
  // by its footprint's own variance) and ledgers what it freed and the heap ceiling it would derive, in shadow.
  const daemonMemoryGovernor = createDaemonMemoryGovernor({ policy: memoryPolicyRead.policy });
  const daemonLiveSet = createLiveSetKeeper();
  const slackReclaimer = createDaemonSlackReclaimer({
    policy: memoryPolicyRead.policy,
    inForcePercent: () => daemonMemoryGovernor.inForcePercent?.() ?? memoryPolicyRead.policy.heapGrowingPercent,
    footprintBytes: () => daemonFootprint.samples().map((sample) => sample.bytes),
    log: (record) => log("daemon.slack_reclaim", { ...daemonLiveSet.keep(record) }),
  });
  installDaemonSlackReclaimer(slackReclaimer);
  // W1-T9647: what holds the heap, on its own unref'd timer; `unattributed_live_bytes` is read against the reclaimer's
  // last measured live set above. Cheap counters and sliced walks only: no snapshot, no forced collection.
  const stopMemoryCensus = (deps.startMemoryCensus ?? startDaemonMemoryCensus)({
    holders: daemonHolderSource({
      planCopies: daemonPlanCopies,
      sizedMemos: { terminalUnionScans: terminalUnionScans.size, mergeLogEvidenceByRoot: mergeLogEvidenceByRoot.size,
        dispatchFilingCache: dispatchFilingCache.size, baseReproductionHostCache: baseReproductionHostCache.size },
      boardSnapshots: boardSnapshotFor.built,
      tickRead: () => tickReadGeneration?.facts,
      ledgerMemos: ledgerMemoHolders,
      sourceMapsEnabled: () => process.sourceMapsEnabled,
    }),
    log, liveSet: daemonLiveSet.read, bootHeadSha: daemonLoadedCodeSha,
  });
  cleanup.push({ resource: "memory_census", close: stopMemoryCensus });
  log("daemon.heap_ceiling_shadow", { basis: "boot", ...slackReclaimer.derivedCeiling() });
    try { await gardenerRuntime.flush(); } catch { log("garden.telemetry_failed", { reason: "runtime-inventory-write-failed" }); }
    // W1-T7744: the filing read is awaited here, before the loop, and behind each selection after — never on the loop.
    await dispatchFilingPrefetch.refresh(target.planPath);
    const summary = await runDaemonFn(
      plan,
      {
        refreshMerged,
        refreshMergedAsync: readTick ? buildDaemonReadRefresher({
          read: readTick, plan: () => activePlanRef.current, previous: () => lastProj,
          invalidate: () => { tickReadGeneration = undefined; },
          publish: (snapshot: ReadGeneration<TickReadFacts>) => {
            tickReadGeneration = snapshot;
            lastProj = new Map(snapshot.facts.projection);
            boardOpenPrCount.reset();
            boardOpenPrCount.observe(snapshot.facts.openBranches);
          },
          ledgerPath, statusPath, log,
        }) : undefined,
        readLoopTelemetry: loopTelemetry.sample,
        readMemoryTelemetry: daemonMemoryTelemetryReader(daemonLoadedCodeSha, { generation: runId, footprint: daemonFootprint }),
        memoryGovernor: daemonMemoryGovernor,
        lastStepBeforeBlock: () => lastReadPlaneStep,
        idleStarvedSupervised: process.env.RMD_IDLE_STARVED_SUPERVISED === "1" && !target.isSelf && !flagValue(rest, "--plan"),
        confirmedOpenPrCount: boardOpenPrCount.readConfirmed,
        onPlanReload: (fresh) => {
          activePlanRef.current = fresh;
          daemonPlanCopies.observe(fresh);
        },
        // W1-T3412: daemon selection uses the same complete-union calibration as the bounded
        // drain. A refused calibration returns undefined, preserving historic ordering.
        buildDispatchValueContext: (dispatchPlan, merged) =>
          dispatchValueContextForSelection(dispatchPlan, merged, dirname(ledgerPath), log, target.planPath),
        isOpenPr,
        isCreditIndeterminate,
        // W1-T3216: THE PRODUCER, on the lane that actually dispatches — the same omission
        // W1-T534/W1-T916 hit two lines below, and the one #4715 shipped for this very feature.
        readLedgerLines: () => readReleaseLedgerLines(ledgerPathFor(config)),
        // W1-T10348: the operator releases rotation cannot shed, beside the ledger they were written to.
        readDurableReleases: () => readOperatorReleaseRecords(dirname(ledgerPathFor(config))),
        readRestartHistory: () => {
          return readRestartHistoryLines(dirname(ledgerPathFor(config)));
        },
        // W1-T988: the target this daemon already resolved and already ledgers as `daemon.target`'s
        // `repo:` field — the SAME value, never a second resolution that could drift from it.
        targetRepo: target.repo,
        // W1-T9680: a worker push's token — the credential socket's own scoped mint, else the ambient GH_TOKEN.
        probeFleetPushCredential: receivePackCredentialProbe({ originUrl: `https://github.com/${target.owner}/${target.repo}.git`,
          token: daemonPushTokenSource(`${target.owner}/${target.repo}`, gitCredentialSocket ? (deps.gitCredentialMint ?? realScopedMint(log)) : undefined) }),
        // W1-T2397: the second half of the wiring #3125 could only take for `drainCommand`. Same
        // pair, same factory, same contract — and this is the lane that actually dispatches.
        openSiblingBuildFor,
        onOpenSiblingBuild,
        // W1-T916 — THE ARGUMENT W1-T534 DECLARED AND NOTHING PASSED, SUPPLIED HERE AT LAST.
        // `nextRunnable` consumes `opts.hasPushedRunBranch?.(t.id)`; with no supplier that
        // optional call short-circuited to `undefined` on every pass, so the duplicate-dispatch
        // guard never fired — invisibly, because the omission is legal at type-check and raises
        // nothing at runtime. This module is where the read belongs: `drain.ts` is pure (it has no
        // `child_process` import at all) and `git ls-remote` already runs here.
        //
        // ONE SWEEP PER PASS. Returns the RAW output; `runDrain` parses it once ABOVE its own
        // dispatch loop via `runBranchTaskIds`. Scoped to `run-*` so the refspec filters
        // server-side rather than shipping every head back. `ls-remote` speaks the git protocol and
        // spends neither the REST nor the GraphQL budget — measured at 46 refs in 199 ms with
        // `core` remaining identical before and after.
        //
        // FAIL OPEN, DELIBERATELY: a failed read (network blip, auth) refuses no task. W1-T5805: the
        // daemon awaits it, at each tick and lane refill, and ledgers the failure.
        // W1-T10897: the TARGET repo's origin — the engine checkout's lists only the engine's run branches.
        readPushedRunBranches: () => readPushedRunBranchesOutputAsync(targetCheckoutRoot),
        readOrphanRunBranchEvidence: orphanRunBranchEvidenceReader(
          join(config.root, "state", automaticBranchReapStateFileName(target.repo)),
          () => liveInflightRuns(inflightDir).map((r) => r.taskId),
          systemClock,
        ),
        // W1-T177: a fresh `gh pr view` re-read, consulted only when isOpenPr
        // reports a task in-flight — see NextRunnableOpts.readLiveState's doc.
        readLiveState: (_taskId, prNumber) => ghLiveStateByNumber(target.owner, target.repo, prNumber),
        isIndeterminate,
        releaseLandedClaims: async (isMerged) => {
          await releaseLandedDispatchClaims(deps.tickClaimReserver ?? dispatchClaimReserverAsyncFor(join(config.root, "repos", target.repo)), {
            isMerged,
            isIndeterminate,
            prUrlFor: (id) => lastProj?.get(id)?.prUrl,
            isRerunClaim: (id, anchor) => claimMintedByRerun(dirname(ledgerPath), id, anchor),
            reportedRerun: landedClaimRerunReported,
            localHost: hostname(),
            log,
          });
        },
        isIndependentFailureBlocked,
        independentBlockReleases: () => independentBlockReleasesFrom(lastProj), // W1-T8676: ledgered by the selection pass
        // PER-TASK DISPATCH CIRCUIT BREAKER (P29(ii)): re-derived from the SAME
        // ledger every call — persists across daemon restarts, unlike this
        // loop's own in-memory per-tick block-reasoning flag. W1-T206: routed through
        // breakerGate/evaluateDispatchBreaker so a torn/rotated read reports
        // "indeterminate" (handled above by isIndeterminate) rather than a false
        // "clear" that would silently untrip an already-tripped task.
        beginSelectionPass: breakerGate.beginSelectionPass,
        isCircuitTripped: (taskId) => breakerGate.isTripped(taskId),
        // W1-T314: the row records WHAT THE BREAKER SAW, from the same memoised
        // evaluation the predicate above answered from — never a second call.
        breakerDetail: breakerDetailDep(breakerGate),
        // W1-T4678: reads the evidence before paging — see onCircuitBreakWithVerifier's own doc.
        onCircuitBreak: onCircuitBreakWithVerifier(breakerGate, (id: string) => lastProj?.get(id), {
          owner: target.owner,
          repo: target.repo,
          ledgerPath,
          runId,
          judge: productionDispatchBreakJudge({ cwd: repoRoot, settingsFile: join(repoRoot, "settings", "worker.json") }),
        }),
        // W1-T4025: repeated attributable lifetime pressure is a sensor, not a refusal wall. The
        // daemon flushes one bounded batch after the pass and routes it through the existing judge;
        // a judge/proposal failure is logged and does not hold this or a sibling task.
        isLifetimeCapExceeded: (taskId) => breakerGate.isLifetimeCapExceeded(taskId),
        onLifetimePressure: productionLifetimePressureHook({ plan: () => activePlanRef.current, root: repoRoot, config, ledgerPath, runId }),
        // DAILY COST CEILING (W1-T317 wires checkCostGovernor's own predicate, sweep.ts): a
        // fresh per-consultation re-derivation of today's ledgered spend, mirroring the streak/
        // lifetime breakers' restart-survives freshness contract — see costGovernorGateFor's doc.
        checkCostGovernor: costGovernorGateFor(ledgerPath, runId, deps.now),
        // W1-T331: THE LIVE CEILING costGovernorGateFor's own doc, immediately above, describes —
        // re-reads the SAME repoRoot-scoped plan/policy.yaml the boot-time `policy` (line ~8754,
        // loaded ONCE for pollIntervalMs/the headroom curve) also reads, but THIS one is called
        // AGAIN on every tick (runDaemon's own placement, daemon.ts) rather than reused from that
        // boot-frozen binding — reusing it here would just move the identical frozen-at-import
        // defect from sweep.ts's module scope to this function's closure scope. See
        // dailyCostCeilingReloader's own doc for why production wires it with no `deps.policy`
        // override (only a test does).
        reloadDailyCostCeilingUsd: dailyCostCeilingReloader(),
        // WIP CEILING (W1-T321 wires checkQueueGovernor's own predicate, sweep.ts, the W1-T121
        // 23-open-PR incident): the SAME batch `openPrCount` reads just above, split by ownership
        // (W1-T4465 design (i)) — never a second GitHub read path — see queueGovernorGateFor's doc.
        checkQueueGovernor: queueGate,
        readQueueAdmission: queueGate.readAdmission,
        // HOST MEMORY FLOOR (W1-T5347 wires W1-T1038's memoryGovernorGateFor): a fresh
        // /proc/meminfo reading per consultation, so the per-lane re-check sees each lane's cost.
        // Holds NEW implement dispatch only — never a running worker or a review.
        checkMemoryGovernor: memoryGovernorGateFor(ledgerPath, runId, undefined, deps.readAvailableMemoryMib),
        // W1-T7720: an unreadable probe / reservation store is tiered by how long it lasts.
        memoryReadTracker: memoryReadTrackerFor(ledgerPath, runId, target.owner, target.repo),
        readMemoryStoreFailure: () => memoryStoreReadFailure(readMemoryLedger()),
        checkQuietHours: () =>
          isQuietHours(config.root) ? { deferred: true, detail: "QUIET_HOURS file present" } : undefined,
        // Separate from tick/retro/triage/SRE governors; consulted only at NEW implement start.
        checkHeavyNewBuild: deps.checkHeavyNewBuild ?? captureHeavyNewBuildStartupGate(log, config),
        openPrCount, // W1-T343: laneDispatchBudget's other input on the multi-lane path, mirroring drainCommand.
        // W1-T1062: `owner: target.owner` must reach `runTask`, else a FOREIGN `--repo owner/name` run
        // falls back to this checkout's owner and opens its PR there (test/owner-dispatch-threading).
        // W1-T9924: the same mode read `runInChildWhenOn` makes below; a run it would keep in-process reads false.
        ...(childMode ? {
          adoptRunChildren: () => adoptedChildren,
          refillRunsAsChild: () => runChildModeIsOn(childPolicy, childModeTracker.evidence).on && !flagValue(rest, "--plan"),
        } : {}),
        runOne: async (taskId, runOptions) => {
          const childOptions = { planPath: target.planPath, owner: target.owner, allowStale, skipGitSync: !!flagValue(rest, "--plan"), handOffAtPrOpen: true, pairedTrialHost: "daemon" } as const;
          // W1-T9087: each dispatch asks the mode; under `auto` that is the evidence's current answer, ledgered when it changes.
          const dispatchPolicy = readRunChildPolicy(childPolicy);
          const dispatchMode = dispatchPolicy.mode === undefined ? undefined : runChildModeFor(dispatchPolicy.mode, childModeTracker.evidence());
          childModeTracker.record(dispatchMode?.decision, log);
          childContract(dispatchMode?.decision);
          // W1-T9085: under sweep.runChild.mode on the run executes in a detached child; a child that cannot start runs in-process.
          const inChild = await runInChildWhenOn({
            taskId, config, repoDir: effectiveRepoRoot, allowStale, options: childOptions, log: childLog, planSync: planSyncCoalescer.sync,
            onPending: runOptions?.onChildPending, mayRunInProcess: runOptions?.mayRunInProcess,
          }, { readMode: childPolicy, evidence: childModeTracker.evidence });
          if (inChild) {
            runOptions?.onChild?.(inChild);
            return inChild.settled;
          }
          // W1-T9082: under mode shadow an unawaited, never-rejecting probe child measures a run child's cost beside this run.
          const admittedPlan = createAdmittedPlanSlot();
          void startRunChildProbe({
            taskId, stateRoot: join(config.root, "state"), repoDir: effectiveRepoRoot, root: config.root, plan: admittedPlan.promise, log: childLog,
            options: childOptions,
          }, dispatchMode ? { readMode: () => dispatchMode.mode } : {});
          return runTaskFn(taskId, {
            planPath: target.planPath,
            config,
            allowStale,
            pairedTrialHost: "daemon",
            skipGitSync: !!flagValue(rest, "--plan"),
            owner: target.owner,
            onRunCreated: runOptions?.onRunCreated,
            // W1-T2509: EVERY LANE SHARES ONE GATEWAY PER owner/repo — a per-lane COLD gateway paid a
            // synchronous full-repo walk before its first yield, serialising lane starts (78 s apart).
            // See `laneGithubFor` for why it memoises per owner/repo rather than per drain target.
            githubFor: laneGithubFor,
            // W1-T2513/W1-T9763: the coalescer above, over the daemon's plan store; inert under `skipGitSync`.
            planSnapshot: tapPlanSnapshot(admittedPlan, planSyncCoalescer.sync),
            // W1-T3793: only the daemon offers the cooperative external-CI-wait handoff. The
            // existing adapter is material-and-clean only; unassessed, dirty, and degraded
            // readings remain undefined and therefore cannot manufacture a restart.
            externalWaitFreshness: daemonFreshnessReads(effectiveRepoRoot, process.env, { loadedCodeSha: daemonLoadedCodeSha }).externalWaitFreshness,
            externalWaitRecycle: () => recyclePauseDetail(config.root),
            // W1-T5345: a daemon lane is free once its PR is open — the sweep owns CI wait and review.
            handOffAtPrOpen: true,
            ...(gitCredentialSocket ? { gitCredentialSocketPath: gitCredentialSocket.socketPath } : {}),
          });
        },
        readUsage: () => readUsageSnapshotPreferSdk(config),
        // THE LEDGER IS THE DEDUP (impl-FL): seed the once-per-string bound from what previous
        // processes already announced, so a restart does not re-announce. Read ONCE at daemon
        // construction, never per tick.
        priorUnrecognisedResets: priorUnrecognisedResetStrings(readLedgerLines(ledgerPath)),
        // P34 clause (c), W1-T249: the reserve gate's notification — dispatch is
        // already paused (runDaemon's own in-process idle) by the time this fires.
        onHeadroomBreach: (info) => escalateHeadroomReserve(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        onHeadroomParkCeiling: (info) =>
          escalateHeadroomParkCeiling(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // W1-T372: both gh api rate_limit buckets, read fresh each tick alongside readUsage's
        // own headroom reading immediately above — never a second gh api rate_limit call.
        readGhQuota: () => readGhRateLimitBuckets(),
        // W1-T372: observe-and-surface only — dispatch is NOT paused by this hook (unlike
        // onHeadroomBreach above); see escalateQuotaExhaustion's own doc for why.
        onQuotaExhausted: (info) => escalateQuotaExhaustion(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // W1-T1082: real free space + verdict, read on the SAME `startInFlightTicker` cadence as
        // `daemon.alive` itself — the SAME root `rmd doctor` reads (`readDiskFreeBytes(config.root)`,
        // `doctorCommand`, above) and the SAME `judgeDiskHeadroom` it judges against, one read call
        // and one shared threshold definition, never a second copy.
        readDiskHeadroom: () => {
          const freeBytes = readDiskFreeBytes(config.root);
          return { freeBytes, verdict: judgeDiskHeadroom(freeBytes).verdict };
        },
        // Dispatch is NOT paused by this hook (design (vii) — SURFACE, DO NOT GATE): see
        // escalateDiskHeadroomBreach's own doc for the two-layer dedup (in-process latch +
        // cross-restart ledger episode window) this wiring relies on.
        onDiskHeadroomBreach: (info) =>
          escalateDiskHeadroomBreach(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // W1-T3378: the daemon core owns the tick; this command owns the real filesystem/git
        // effect. Supplying the closure here makes the reviewed `review-PR*` reclaimer reachable
        // on every live daemon rather than leaving an optional DaemonDeps hook dead.
        sweepStrandedReviewWorktrees: () => sweepStrandedReviewWorktrees(config, log),
        // W1-T3528: same reasoning, different unit — this one frees regenerable build output
        // inside checkouts that must be kept, which every whole-tree rung is right to refuse.
        sweepReclaimableArtifacts: () => sweepReclaimableArtifacts(config, log),
        // W1-T7093: maintain the worker-tree ledger on the same recurring heartbeat the reader
        // consumes. This is report-only bookkeeping; a failure never alters dispatch or workers.
        sweepHostMemoryReservations: () => {
          const swept = sweepMemoryReservations({ root: config.root, log: (event) => log(String(event.event ?? "host_memory_ledger.diagnostic"), event) });
          if (swept) {
            log("daemon.host_memory_reservations.swept", {
              state: swept.reading.state,
              scope: swept.reading.scope,
              live: swept.reading.entries.length,
              released: swept.released.length,
              uncertain: swept.reading.counts.uncertain,
              incomplete_walk: swept.reading.counts.incompleteWalk,
              reserved_mib: swept.reading.reservedMib,
            });
          }
        },
        // oper#queue-starvation-2026-08-03: the idle rung's starvation notification — dispatch
        // is already idle (runDaemon's own in-process bound, `starvationEscalated`) by the time
        // this fires.
        onStarvation: (census) => escalateStarvation(census, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        // This task: the cleared half — closes the escalation `escalateStarvation` opened, on
        // the SAME edge `runDaemon` already resets `starvationEscalated` at.
        onStarvationCleared: (info) => escalateStarvationCleared(info, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
        checkStop,
        // W1-T1216: LOCAL FIRST (design (i)), falling through to the shared cross-host hold
        // (`refs/rmd-pause/hold`) only when the local file is silent — see checkSharedPause's
        // own doc for why UNREACHABLE reads as held, never as clear.
        checkPause,
        workerAdmissionHold: () => resolveFleetControlHold({ checkStop, checkPause }),
        // CODE FRESHNESS — THE PRODUCER W1-T126 NEVER GOT. The consumer has read
        // `deps.checkFreshness` since 2026 and this object never supplied it, so the stale
        // self-restart had fired ZERO times in the Azure daemon's 6,838-row ledger. MEASURED
        // consequence on 2026-08-13: that daemon sat on one sha for five hours while origin/main
        // moved seven commits, dispatched W1-T404 from the STALE plan blob (filtered
        // `verify: human` after the flip had merged), and its triage selector re-picked a feedback
        // entry that a merged commit had already settled — one cause, three symptoms.
        //
        // WHY THIS IS A TICK CHECK AND NOT THE BOOT GATE THAT ALREADY EXISTS. `serviceFreshnessGate`
        // (below) runs this SAME predicate at every `rmd daemon` boot and has ledgered
        // `daemon.stale_code` zero times — not because the daemon is never stale, but because
        // `deploy/entrypoint.sh` checks out origin/main IMMEDIATELY BEFORE it, so the boot gate can
        // only ever observe a condition the boot itself just eliminated. Staleness is acquired
        // DURING a process's life; only a per-tick check can see it.
        //
        // NEVER INTERRUPTS A WORKER. `runDaemon` consults this between iterations only, after the
        // current `runOne` has resolved — the same drain-and-hold discipline `checkStop`/`checkPause`
        // rely on, stated in `DaemonDeps.checkFreshness`'s own contract and pinned by
        // test/daemon-freshness-wiring.test.ts's ordering test. So no idle gate has to be added: a
        // dispatch runs to its verdict first, which is also what bounds the restart rate (measured:
        // the daemon is inside a dispatch 18.2% of wall clock, p50 28.3 min).
        // 2026-10-11: a tracked edit in a live checkout deferred every refresh for five hours, silently.
        // The same read drains the host-escalation spool: host-side alerts the host itself could not post.
        checkFreshness: testRunnerOnItsOwnCheckout(repoRoot)
          ? daemonFreshnessReads(repoRoot, process.env, { loadedCodeSha: daemonLoadedCodeSha }).checkFreshness
          : withEscalationSpoolDrain(withLiveEditLadders(daemonFreshnessReads(repoRoot, process.env, { loadedCodeSha: daemonLoadedCodeSha }).checkFreshness, liveEditLadderWiring(config)), escalationSpoolDrainWiring(config)),
        // W1-T10919: read main's tree directly; a config-only fetch need not reset the consumer checkout.
        readTerminalPreDispatchRefusalRevisions: () => terminalPreDispatchRefusalRevisions(join(config.root, "state"), () => runnerConfigDigest(targetCheckoutRoot, "origin/main")),
        categorizedRefusalRejoinFor: (id) => lastProj?.get(id)?.categorizedRefusalRejoin,
        // impl-FZ / W1-T3554 — PLAN FRESHNESS, on BOTH the self-target and dedicated non-self
        // paths, so the reload always reads the SAME source the boot did (origin/main, never the
        // working tree). An explicit `--plan` keeps the frozen-at-boot behaviour for BOTH, because
        // that caller asked for a literal file.
        //
        // Change detection is a TREE SHA, not a timestamp: `origin/main:plan` covers the monolith
        // AND all 45 shards in one ~8ms call, and only when it moves do we pay the ~60ms parse of
        // a ~1MB plan. Unchanged ticks therefore cost 8ms, not 60. The self-target sha is read from
        // the already-fetched origin/main ref rather than fetching here — `checkFreshness` above
        // already fetches this SAME checkout every tick — while the dedicated non-self target
        // fetches for itself (see `dedicatedTargetPlanReloader`'s own doc for why: nothing else
        // keeps ITS checkout's origin/main current between dispatches).
        // Mirrors the BOOT condition at the plan binding above (`target.isSelf && !--plan` /
        // `!target.isSelf && !--plan`) exactly, so the reload source can never diverge from the
        // load source. Selection itself lives in `resolveReloadPlan` (its own doc, above) so this
        // callsite stays a single reachable line regardless of which arm a given caller exercises.
        reloadPlan: flagValue(rest, "--plan") ? undefined : resolveReloadPlan(target, allowStale, log,
          { load: planReaders.reload }),
        // Console UP NEXT write-actions (fb-1784988460437-9daa9b): the daemon
        // consumes markers the write-token API drops, dispatching a kicked task
        // through its normal assertRunnable-gated path and honouring "drain now".
        // W1-T10615: only the kicks addressed to THIS daemon's target, each cleared by its exact marker.
        ...daemonKickPort(config.root, target),
        // W1-T10799: only the CORE daemon owns a bounded native job for a managed target with no daemon of its own.
        ...(target.isSelf ? {
          ...daemonTargetJobPort(config.root, target),
          runTargetJob: createNativeTargetJobRunner({
            root: config.root, repoRoot: effectiveRepoRoot, log, nowMs: deps.now ?? Date.now,
            planPathFor: (owner, repo) => {
              const resolvedJob = resolveDaemonTarget({ selfOwner: self.owner, selfRepo: self.repo, repoRoot: effectiveRepoRoot, reposDir }, ["--repo", `${owner}/${repo}`]);
              return "error" in resolvedJob ? undefined : resolvedJob.target.planPath;
            },
            syncPlan: async (planPath, owner, repo) => {
              const repoDir = join(reposDir, repo);
              if (!existsSync(repoDir)) {
                mkdirSync(dirname(repoDir), { recursive: true });
                await ghTextAsync(["repo", "clone", `${owner}/${repo}`, repoDir], { timeout: 300_000 });
              }
              const synced = await syncPlanOrRefuseAsync(planPath, { allowStale: false, log, say: (msg: string) => writeSyncLine(2, `### rmd daemon — ${msg}`), quarantine: reportPlanQuarantine });
              return "error" in synced ? { error: String(synced.error) } : { plan: synced.plan };
            },
            project: (jobPlan, owner, repo) => targetRepositoryFor(owner, repo).project(jobPlan),
            repositoryDeps: (owner, repo) => targetRepositoryFor(owner, repo).governors,
            runTask: (taskId, job) => runTaskFn(taskId, {
              planPath: job.planPath, config, allowStale: false, pairedTrialHost: "daemon", owner: job.owner, githubFor: laneGithubFor, handOffAtPrOpen: true,
              planSnapshot: async () => ({ plan: job.plan, staleDispatch: false }),
              onRunCreated: job.onRunCreated,
              repositoryState: targetRepositoryFor(job.owner, job.repo),
              ...(gitCredentialSocket ? { gitCredentialSocketPath: gitCredentialSocket.socketPath } : {}),
            }),
            claimHeld: async (taskId, repo) => {
              try {
                return (await hostWorktreeGitAsync(join(reposDir, repo), ["ls-remote", "origin", dispatchClaimRef(taskId)])).trim() !== "";
              } catch (error) {
                // An unreachable remote is an unknown claim, which a job treats as held; it is never "free".
                void error; return undefined;
              }
            },
          }),
        } : {}),
        consumeDrainNow: () => consumeDrainNow(config.root),
        // Selected-repository PR controls (W1-T3989). The HTTP surface only writes a bounded
        // marker; this is the sole point that reaches the established selected-repository CLI
        // commands. Their own disposition, strike, worktree and review-lock gates remain the
        // authority -- an action request is never a bypass.
        pendingPrActions: () => pendingPrActions(config.root),
        ...daemonImprovementActionDeps(join(config.root, "state"), fleetRatify),
        livenessPulse: true,
        ...(target.isSelf
          ? {
              // W1-T4111: the plan queue proposes its own duplicates and dead tasks for operator review.
              gardens: [
                // W1-T5361: the machine-filing judge is one of them, so its git work runs in a child too.
                ...REGISTERED_GARDEN_NAMES.map(offLoopGarden),
                // W1-T4385: the SRE lane, in its OWN lane rather than sharing the core dispatch
                // thread (operator ruling 2026-09-23, sre-lane.ts's own doc). W1-T8232: it runs on
                // the registry's live `primary: true` instance, resolved from this daemon's own
                // state root (`sreLaneEnabled`); `RMD_SRE_LANE=0` turns it off and `=1` still turns
                // it on anywhere. The starter is inert until called, so it is built on every start
                // and dropped when off; either way one `sre_lane.started`/`sre_lane.disabled` row
                // says so. `state/SRE_LANE_OFF` stays the pause switch.
                ...[
                  startDaemonSreLane(
                    (mergedLastDay) => daemonSreLaneInput({
                      stateDir: join(config.root, "state"),
                      root: repoRoot,
                      ledgerPath,
                      owner: self.owner,
                      repo: self.repo,
                      mergedLastDay: () => mergedLastDay,
                      log,
                      // W1-T4386: the allowlisted, reversible runbooks each incident meets first.
                      runbookPass: daemonSreRunbookPass(
                        sreRunbookCatalog(
                          {
                            ...daemonSreRunbookHost({ root: config.root, repoDir: repoRoot, owner: self.owner, repo: self.repo }),
                            // W1-T8241: release-non-worker-breaker reads this ledger and writes through releaseBreaker.
                            breakers: daemonBreakerRunbookHost({
                              ledgerPath,
                              owner: self.owner,
                              repo: self.repo,
                              closeIssue: (repo) => ghIssueGatewayAsync(self.owner, repo).closeWithComment,
                            }),
                          },
                          () => readRunbookReceipts(ledgerPath),
                        ),
                        ledgerPath,
                        self.owner,
                        self.repo,
                        log,
                      ),
                    }),
                    () => mergedInLastDayAsync(repoRoot),
                    log,
                  ),
                ].filter(() => {
                  const sreLane = {
                    instance: resolveSreLaneInstance({
                      stateRoot: config.root,
                      registryPath: process.env.RMD_INSTANCE_REGISTRY?.trim() || daemonInstanceRegistryPath(repoRoot),
                    }),
                    env: { RMD_SRE_LANE: process.env.RMD_SRE_LANE },
                  };
                  const row = sreLaneStartRow(sreLane);
                  log(row.step, row.fields);
                  return sreLaneEnabled(sreLane);
                }),
              ],
            }
          : {}),
        clearPrAction: (action, prNumber) => clearPrAction(config.root, action, prNumber),
        plainBackfill: {
          stateDir: join(config.root, "state"),
          readProposals: () => parseProposalRegistry(readFileIfExists(join(config.root, "state", "inbox-proposals.json"))),
          summarize: plainInboxWriter(config, log),
        },
        recommendationBackfill: {
          stateDir: join(config.root, "state"),
          readProposals: () => parseProposalRegistry(readFileIfExists(join(config.root, "state", "inbox-proposals.json"))),
          evidence: gitRecommendationEvidence((args) => hostWorktreeGitAsync(targetCheckoutRoot, args, { maxBuffer: 1 << 26 }), {
            planDir: relative(targetCheckoutRoot, resolveRepoLayout(targetCheckoutRoot).planDir),
            planMonolith: relative(targetCheckoutRoot, resolveRepoLayout(targetCheckoutRoot).planMonolith),
          }, { repository: `${target.owner}/${target.repo}`, checkoutRoot: targetCheckoutRoot }),
          summarize: inboxRecommendationWriter(config, log),
          readSeed: () => readFileIfExists(join(targetCheckoutRoot, RECOMMENDATION_SEED_PATH)),
        },
        fleetLane: {
          stateDir: join(config.root, "state"),
          ledgerPath,
          mergedLastDay: () => mergedInLastDayAsync(repoRoot),
          approve: (proposalId) => void fleetRatify.approve(proposalId),
          escalateReplayStranded: (stranded) => escalateReplayStranded(stranded, { owner: target.owner, repo: target.repo, ledgerPath, runId }),
          handoffInFlight: (proposalId) => fleetRatify.inFlight(proposalId),
          sameFinding: fleetLaneSamenessJudge(config, log),
          originMainSha: async () => (await hostWorktreeGitAsync(repoRoot, ["rev-parse", "origin/main"])).trim(),
        },
        inboxResponder: createDaemonInboxResponder({ root: config.root, ledgerPath, scope: { repository: `${target.owner}/${target.repo}` },
          ratify: fleetRatify, decide: inboxThreadDecider(config, log), log }),
        runPrAction: async (request) => {
          const args = [String(request.prNumber), "--repo", target.repo];
          const exitCode = request.action === "fix"
            ? await (deps.fixCommand ?? fixCommand)([...args, "--requested"])
            : await (deps.reviewCommand ?? reviewCommand)(String(request.prNumber), ["--repo", target.repo]);
          return exitCode === 0
            ? { outcome: "completed", detail: `${request.action} command accepted PR #${request.prNumber}` }
            : { outcome: "refused", detail: `${request.action} command refused PR #${request.prNumber} (exit ${exitCode})` };
        },
        // W1-T2568: keep the existing sleep clock for nested in-flight tickers, and interrupt
        // ONLY the top-level poll waits that return to the ordinary full-sweep gate. Sharing the
        // interruptible clock with a heartbeat ticker could consume a wake without reconciling.
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        sleepUntilSweepWake: githubEventWake.sleep,
        acknowledgeSweepWake: githubEventWake.acknowledge,
        // The real wall clock backing the TIME-AWARE headroom ceiling (see
        // lib/daemon.ts's HeadroomPolicy) — resolves each window's own
        // hours-to-reset. Explicit here (though `runDaemon` defaults the same
        // way when omitted) so the real wiring is as self-documenting as `sleep`.
        now: () => new Date(),
        // LEVEL-TRIGGERED PR-PIPELINE RECONCILER (W1-T77): the SAME runSweep the
        // LEVEL-TRIGGERED PR-PIPELINE RECONCILER (W1-T77): the SAME runSweep the
        // `rmd sweep` CLI invokes, run once per poll iteration so no open PR
        // strands open-and-orphaned (#111/#113/#123). Best-effort by contract.
        // W1-T320: threads the SAME repoRoot-scoped `policy` (loaded above for
        // pollIntervalMs/the headroom curve) into the per-poll tmp-sweep rung — the
        // regression lock this task's design demands (proof against the sweep
        // configuration the daemon command actually builds, never a hand-built fixture).
        // W1-T468: the ONE real pacer instance for this daemon's life — shared by this hook's own
        // sweep enumeration and its board gateway's PR/issue reads, so the three-call burst that
        // trips GitHub's secondary rate limit at the poll cadence cannot collide. `github` (the
        // param before this one) is left undefined so the hook builds its own board gateway,
        // which is the ONLY construction this pacer can actually reach.
        sweep: buildSweepHook(
          target.owner,
          target.repo,
          config,
          ledgerPath,
          runId,
          plan,
          log,
          policy.values.sweep.tmpMaxAgeMs,
          undefined,
          createGhCallPacer(),
          // W1-T943: the policy-data quiet threshold — see runWorkerStallDetectorRung's own doc
          // and plan/policy.yaml's `workerStall` row for the ~16-minute `--ci-parity` default's
          // headroom rationale.
          policy.values.workerStall,
          mainHealthRung,
          boardSnapshotFor(target.owner, target.repo),
          reviewerCodeRecovery,
          // W1-T3585 — the SAME `lastProj` snapshot `isOpenPr`/`isCreditIndeterminate` above already
          // read, never a second GitHub walk: `refreshMerged()` runs once at the top of THIS tick
          // (runDaemon's loop body, lib/daemon.ts) and this hook's own closure runs later in the
          // same tick, so by the time it calls `buildOpenPrViews`, `lastProj` is already this tick's
          // fresh dispatch projection.
          resequenceMergedResolver(() => lastProj),
          undefined,
          targetCheckoutRoot,
          () => activePlanRef.current,
          // W1-T4471: the one real wiring of the owner-reply reader.
          ghEscalationAnswerGateway(target.owner, target.repo, undefined, config.operatorGithubLogins,
            config.contributorAdmission === undefined ? undefined : { settings: config.contributorAdmission }),
          gitCredentialSocket?.socketPath,
          servedTickRead(onePassPerGeneration(() => tickReadGeneration, readTick,
            () => ({ plan: activePlanRef.current, previousProjection: lastProj ? [...lastProj] : undefined }), { log }),
            () => tickReadGeneration),
          target.isSelf ? { root: repoRoot, inboxRoot: config.root, feedbackLand: {} } : undefined,
        ),
        // W1-T254 (the #707 fix): the restricted light-sweep ticker — ticks ONLY
        // the deterministic post-review re-post while `runOne` is unbounded and in
        // flight, so a green PR whose review went absent re-posts within one poll
        // interval. Dangerous lanes (fix/close/arm/escalate) stay non-concurrent.
        sweepLight: buildSweepLightHook(
          target.owner,
          target.repo,
          config,
          ledgerPath,
          runId,
          plan,
          log,
          reviewerCodeRecovery,
          // W1-T3585 — the SAME accessor `sweep:` above threads, off the SAME `lastProj` tick
          // snapshot: both daemon sweep paths must reconcile the identical current-plan
          // eligibility predicate, never two independently-derived ones.
          resequenceMergedResolver(() => lastProj),
          undefined,
          () => activePlanRef.current,
          // A run in flight starves the full sweep, so the light pass also watches main.
          mainHealthRung,
        ),
        // W1-T7734: the idle sleep runs the light pass while review demand waits, at a cadence the sweep
        // derives from observed review duration and head churn. Reads the sweep's in-process memo only.
        readIdleReviewDemand: () => readIdleLightCadence(systemClock.now()),
        readReviewMedianMs: readObservedReviewMedianMs,
        // W1-T117/W1-T356: the per-poll half of the orphan sweep — the SAME `sweepOrphans`
        // closure daemonBoot already runs once, above, wired here so a stray from a run that
        // ended BETWEEN polls (not only at the last boot) is still found within one cycle.
        sweepOrphans,
        repositoryMaintenance: (context) => runRepositoryMaintenanceRung(config, log, context, policy.values.objectReap),
        // W1-T530: the per-poll half of the feedback-landing sweep — the SAME options daemonBoot's
        // pass runs with, wired here so an entry captured (or a landing attempt that failed)
        // BETWEEN polls is still found within one cycle; awaited off the loop (W1-T5620).
        sweepFeedbackLanding: sweepFeedbackLandingRung,
        // RETRO CADENCE TRIGGER (W1-T160) — SELF-TARGET ONLY: the retro reads/writes
        // THIS repo's own MASTER-PLAN/LEARNINGS.md/plan/tasks.yaml/state, never a
        // drained target's, so the trigger is wired only when the daemon is draining
        // itself. `runRetroTrigger`'s return (an exit code) is discarded — retroCommand
        // already ledgers everything the daemon loop needs (retro_triggered above,
        // retro_aborted_integrity, pr.opened, retro.marker.advanced).
        checkRetroTrigger: retroHooks?.checkRetroTrigger,
        // Wrapped (not `retroHooks?.runRetroTrigger` directly) so the daemon's own per-boot
        // ledger sink (`log`, closed over here) reaches the subprocess adapter without
        // widening `buildRetroDaemonHooks`'s construction-time deps — see its own doc.
        runRetroTrigger: retroHooks ? (decision) => retroHooks.runRetroTrigger(decision, log) : undefined,
        // AUTO-TRIAGE RUNG (impl-DJ's design, wired here by impl-DM). Same shape as the retro
        // hooks above and gated the same way. The rung is DEFAULT OFF in policy data — this line
        // makes the switch REACHABLE, it does not turn anything on.
        checkAutoTriage: autoTriageHooks?.checkAutoTriage,
        runAutoTriage: autoTriageHooks?.runAutoTriage,
        // W1-T1040: THE GITHUB-SIDE POSTURE DRIFT CHECK — reads `security_and_analysis` +
        // `enforce_admins` at most once a day (github-posture.ts's own cadence gate), diffs
        // against the recorded state/github-posture.json baseline, and returns only what
        // changed. Best-effort like sweep/sweepOrphans above — `lib/daemon.ts`'s loop logs each
        // finding and never gates dispatch on it (see that call site's own comment).
        checkGithubPosture: githubPostureHooks ? buildCoverageNightlyDaemonHook({
          ledgerPath, ...self, next: githubPostureHooks.checkGithubPosture,
        }) : undefined,
        // MEASUREMENT CADENCE RUNG (W1-T1259's design, wired here). Same shape as the auto-triage/
        // github-posture hooks above and gated the same way — SAFE ON in policy data (see
        // plan/policy.yaml's `measurementCadence` row for why this rung, unlike auto-triage,
        // defaults to running: it writes nothing unless `escalate` is separately opted in).
        checkMeasurementCadence: measurementCadenceHooks?.checkMeasurementCadence,
        runMeasurementCadence: measurementCadenceHooks?.runMeasurementCadence,
        measurementCadenceChild,
        // DIGEST CADENCE RUNG (W1-T2277's design, wired here). Same shape as the
        // measurement-cadence hooks immediately above and gated the same way — SAFE ON in
        // policy data (plan/policy.yaml's `digestCadence` row): sending a digest spends nothing
        // and writes nothing (Law 5), so it is safe to run unattended from the start.
        checkDigestCadence: digestCadenceHooks?.checkDigestCadence,
        runDigestCadence: digestCadenceHooks?.runDigestCadence,
        // W1-T3368: this is the production edge the original feature omitted. `daemon.ts`
        // deliberately owns its decision rows and invokes one bounded pass; this composition root
        // owns filesystem pressure and the existing compactor. Leaving either undefined turns an
        // over-bound corpus into a silent no-op until a union read OOMs the fleet.
        checkLedgerCompaction: ledgerCompactionHooks?.checkLedgerCompaction,
        runLedgerCompaction: ledgerCompactionHooks?.runLedgerCompaction,
        checkBenchmarkCohort: benchmarkCohortHooks.checkBenchmarkCohort,
        runBenchmarkCohortPass: benchmarkCohortHooks.runBenchmarkCohortPass,
        checkIntakeRungs: intakeRungHooks?.checkIntakeRungs,
        runIntakeRung: intakeRungHooks?.runIntakeRung,
        // BOARD-REVIEW RUNG (W1-T2304's design, wired here). Same shape as the two cadences
        // immediately above and gated the same way — SAFE ON in policy data (plan/policy.yaml's
        // `boardReview` row): the rung writes one report artifact and drafts registry proposals,
        // and nothing it produces files a task itself — the rung's own scope. W1-T2456: this
            // cited "(Rule 15)" for a doctrine that rule does not carry; see §12 rule 27.
        checkBoardReview: boardReviewHooks?.checkBoardReview,
        runBoardReview: boardReviewHooks?.runBoardReview,
        prefetchBoardReview: boardReviewHooks?.prefetchBoardReview,
        checkWipeTestCadence: wipeTestCadenceHooks?.checkWipeTestCadence,
        runWipeTestCadence: wipeTestCadenceHooks?.runWipeTestCadence,
        // CI-LEARNING RUNG (W1-T2972). Same shape as the three cadences above and gated the same
        // way, with one deliberate difference: its `ciLearningCadence` policy row ships DEFAULT
        // OFF, because unlike its read-only siblings this rung drafts records. Wiring it here is
        // what makes that switch mean something; the operator throws it.
        checkCiLearningCadence: ciLearningHooks?.checkCiLearningCadence,
        runCiLearningCadence: ciLearningHooks?.runCiLearningCadence,
        // W1-T1019: W1-T300's OWN in-flight guard (daemon.ts, `deps.isFeedbackOpenPr`/
        // `deps.readFeedbackLiveState`) shipped consulted-but-never-supplied — `?.` with no `??`
        // fallback, so `openPrNumber` read `undefined` on every pass and the guard never once
        // refused a fire (77 `auto_triage.fired` rows against 0 `skipped_inflight`). Wired HERE,
        // the one construction site the sibling `isOpenPr`/`readLiveState` pair above is also
        // bound from, per daemon.ts's own comment: "the SAME shape as the task lane's
        // `isOpenPr`/`readLiveState` pair above, keyed on feedback id instead of task id."
        //
        // isFeedbackOpenPr REUSES `openHeadBranchesForBreaker` — the SAME batched, once-per-boot
        // `listOpenHeadBranches()` cache `isOpenPr` above reads via `lastProj`, never a second
        // GitHub call — and `taskIdFromRunBranch` (status.ts, already imported), the SAME head-
        // branch-ownership reader `corroborateOpenByBranch` uses. A triage run's own branch is
        // `run-TRIAGE-<feedbackId>-<epochMs>` (triageCommandLocked's `taskId = \`TRIAGE-${feedbackId}\``,
        // `branch = \`run-${runId}\``), so matching `taskIdFromRunBranch(head) === \`TRIAGE-${feedbackId}\``
        // against the OPEN slice of that SAME cache is the feedback-keyed twin of `isOpenPr`'s own
        // `lastProj`-backed read — newest PR wins on a multi-hit, mirroring status.ts's own rung.
        isFeedbackOpenPr: (feedbackId) => {
          const wantTaskId = `TRIAGE-${feedbackId}`;
          const hit = (openHeadBranchesForBreaker() ?? [])
            .filter((pr) => pr.state.toUpperCase() === "OPEN" && taskIdFromRunBranch(pr.headRefName) === wantTaskId)
            .sort((a, b) => b.number - a.number)[0];
          return hit?.number;
        },
        // readFeedbackLiveState REUSES `ghLiveStateByNumber` — the IDENTICAL fresh, always-live
        // re-read `readLiveState` above calls, no new GitHub call shape and no new gateway — so a
        // cached OPEN that has since merged/closed stands the guard down instead of parking a
        // feedback entry forever (W1-T177's confirming-read discipline, applied to this lane).
        readFeedbackLiveState: (_feedbackId, prNumber) => ghLiveStateByNumber(target.owner, target.repo, prNumber),
        readFeedbackStatusOnMain: (feedbackId) => feedbackStatusOnMain(repoRoot, feedbackId),
        // W1-T46 block-reasoning: a GENUINE BLOCKER (real downstream work
        // transitively needs the blocked task) opens a `needs-human` issue
        // naming the dependents it protects, via W1-T8's escalation taxonomy
        // — never a bare halt with no actionable trail.
        //
        // W1-T3401: routed through `escalateWithJudge` rather than the bare `escalate` this used
        // to call — BLOCKED was the largest never-judged class (49 of 72 escalated task ids,
        // measured over the ledger union since 2026-09-08) precisely because THIS site never
        // consulted the residual escalation judge at all. Safe to make async: `escalateBlock`
        // is already declared `(info) => void | Promise<void>` (lib/daemon.ts) and its one caller
        // already `await`s it (lib/daemon.ts) — unlike the genuinely-synchronous breaker callbacks
        // elsewhere in this file (e.g. the crash-loop/rate-limit breakers), no interface change is
        // needed to add the `await` here. `realEscalationJudge` is built from `effectiveRepoRoot`
        // (this repo's own checkout, self-target-injectable — never `config.root`, the separate
        // state/workspace root, nor the drained TARGET repo's own checkout), the SAME root
        // `verifyHumanSweepCommand` resolves its own read-only judge mounts/settings against
        // (`mountsPath(root)`/`join(root, "settings", "worker.json")` with `root = deps.root ??
        // repoRoot`). A judge that throws, times out, or returns unparseable output fails OPEN to
        // `deliver` (`judgeEscalation`'s documented polarity) — the halt path never loses an
        // escalation, it only gains a chance to demote a non-issue to a fleet notice.
        escalateBlock: async ({ task, result, dependents }) => {
          await escalateWithJudge(
            {
              class: "BLOCKED",
              taskId: task.id,
              runId,
              summary: `${task.id} blocked (${result.verdict}) — ${dependents.length} task(s) transitively need it`,
              detail:
                `W1-T46 block-reasoning: ${task.id} did not merge (${result.verdict}` +
                `${result.prUrl ? `, ${result.prUrl}` : ""}). Real downstream work transitively depends on it ` +
                `(${dependents.join(", ")}), so the daemon halted rather than continue into the gap.`,
              options: [
                {
                  label: "fix and resume",
                  detail: `Resolve ${task.id}'s block (\`rmd fix\` or a manual patch), then \`rmd daemon\`/\`rmd drain\` to continue.`,
                },
                {
                  label: "unblock the dependents",
                  detail: `If ${task.id} is not a real prerequisite for ${dependents.join(", ")}, edit plan/tasks.yaml's depends_on and resume.`,
                },
              ],
              recommendation: "fix and resume",
            },
            {
              issues: ghIssueGatewayAsync(target.owner, target.repo),
              ledgerPath,
              runId,
              judge:
                deps.escalationJudge ??
                realEscalationJudge({
                  mounts: loadMounts(mountsPath(effectiveRepoRoot)),
                  cwd: effectiveRepoRoot,
                  settingsFile: join(effectiveRepoRoot, "settings", "worker.json"),
                }),
            },
          );
        },
        log,
      },
      opts,
    );
    writeSyncLine(1, "\n" + renderDaemonSummary(summary));
    // The pure stop-reason -> exit-code mapping lives in lib/daemon.ts
    // (`daemonExitCode`), unit-tested there with no process spawn (Rule 18):
    // 0 only on a clean stop (STOP requested / max reached); a block, a
    // pause, or an error is non-zero so a supervising wrapper (or launchd,
    // W1-T12b) notices. Headroom exhaustion never reaches here as a
    // stopReason at all — it is an in-process idle state inside runDaemon,
    // never a process exit.
    // W1-T2546: the SUMMARY-aware code, so an environmental refusal (a rate-limit 403, a 5xx,
    // a transport fault) is not charged to the container crash-restart budget. Every non-`error`
    // reason still resolves through `daemonExitCode` itself, unchanged.
    return daemonExitCodeForSummary(summary);
  } finally {
    for (const { resource, close } of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        try {
          log("daemon.cleanup_failed", { resource, error: String(error) });
          if (resource === "git_credential_socket") log(LEDGER_REQUEST_STEP, {
            host: "github.com", decision: "refuse", status: "error", reason: `git credential socket did not close: ${String(error)}`,
          });
        } catch (logError) {
          // A failed ledger cannot replace the boot/loop error or skip sibling releases.
          console.error("daemon cleanup reporting failed", { resource, error: String(error), reason: String(logError) });
        }
      }
    }
  }
  } finally {
    archivedLifetime.history?.close?.();
  }
}
